/**
 * DoD 2.1 — Codex data-root resolution and transcript discovery.
 *
 * G6: nothing here reads a live Codex data root. Every case points at a
 * directory this file created, or at the committed corpus, and the one case
 * that lets `os.homedir()` decide fakes the home first and asserts the negative
 * control fails.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  CODEX_DAY_DEPTH,
  CODEX_HOME_VAR,
  CODEX_LOCK_DIR_NAME,
  CODEX_ROLLOUT_FILE_RE,
  CodexLocator,
  locateCodex,
  resolveCodexRoot,
} from './locate.js';
import type { CodexLocateDirent, CodexLocateFs, CodexLocateLogRecord, CodexLocateStats } from './locate.js';
import {
  CODEX_NEVER_OPEN_DIR_NAMES,
  CODEX_NEVER_OPEN_NAMES,
  CODEX_NEVER_OPEN_SUFFIXES,
  isNeverOpen,
} from './never-open.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CORPUS = join(REPO_ROOT, 'fixtures', 'codex-0.151.0-alpha.7.2');

/** The platform variable `os.homedir()` actually reads. THIS is the one to fake. */
const HOME_VAR = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
/** The one that does NOT decide the answer on this platform — the decoy. */
const DECOY_VAR = process.platform === 'win32' ? 'HOME' : 'USERPROFILE';

const tempDirs: string[] = [];

function tmp(prefix: string): string {
  // realpath: CI runners hand back 8.3 short components (`RUNNER~1`), which
  // break the path comparisons this suite makes.
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Independent enumeration of a tree's rollout files, by a different route from
 * the one under test: one flat recursive `readdirSync` and a string test,
 * against `locateCodex`'s depth-first walk and its regex.
 */
function expectedRollouts(root: string): string[] {
  const sessions = join(root, 'sessions');
  const entries = readdirSync(sessions, { recursive: true, encoding: 'utf8' });
  return entries
    .filter((rel) => {
      const name = rel.split(/[\\/]/).pop() ?? '';
      return name.startsWith('rollout-') && name.endsWith('.jsonl');
    })
    .map((rel) => join(sessions, rel))
    .sort();
}

/** An fs seam that records every path handed to the filesystem. */
function recordingFs(): { fs: CodexLocateFs; touched: string[] } {
  const touched: string[] = [];
  const fs: CodexLocateFs = {
    statSync: (path): CodexLocateStats => {
      touched.push(path);
      return statSync(path);
    },
    readdirSync: (path): CodexLocateDirent[] => {
      touched.push(path);
      return readdirSync(path, { withFileTypes: true });
    },
  };
  return { fs, touched };
}

/** Run `fn` with `process.env` patched, and restore it whatever happens. */
function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A `<home>/.codex/sessions/<day>/rollout-*.jsonl` tree. */
function plantRoot(options: { day?: string; files?: string[] } = {}): {
  home: string;
  root: string;
  day: string;
  planted: string[];
} {
  const home = tmp('cx-locate-home-');
  const root = join(home, '.codex');
  // A day that is emphatically not today: DoD 2.1's walk must not compose a
  // date from a clock, and a fixture dated today could not tell the difference.
  const day = options.day ?? join('2019', '01', '02');
  const dayDir = join(root, 'sessions', day);
  mkdirSync(dayDir, { recursive: true });
  const files = options.files ?? ['rollout-2019-01-02T00-00-00-aaaaaaaa-0000-4000-8000-000000000001.jsonl'];
  const planted: string[] = [];
  for (const file of files) {
    const full = join(dayDir, file);
    writeFileSync(full, '{"timestamp":"2019-01-02T00:00:00Z","ordinal":0,"type":"session_meta","payload":{}}\n');
    planted.push(full);
  }
  return { home, root, day, planted };
}

// ===========================================================================
// Root resolution (C1)
// ===========================================================================

describe('resolveCodexRoot — CODEX_HOME else ~/.codex, at read time', () => {
  it('honours CODEX_HOME and records it as the source', () => {
    const env = { [CODEX_HOME_VAR]: join('D:', 'elsewhere', 'codexdata') };
    expect(resolveCodexRoot({ env })).toEqual({
      root: join('D:', 'elsewhere', 'codexdata'),
      rootSource: 'CODEX_HOME',
    });
  });

  it('falls back to <home>/.codex and records the source as homedir', () => {
    const env = { [HOME_VAR]: join('C:', 'Users', 'someone') };
    const resolved = resolveCodexRoot({ env });
    expect(resolved.rootSource).toBe('homedir');
    expect(resolved.root).toBe(join('C:', 'Users', 'someone', '.codex'));
  });

  it('treats an empty or whitespace CODEX_HOME as unset, not as the process cwd', () => {
    // A variable set to the empty string is how a shell spells "I cleared
    // this". Honouring it literally would resolve `sessions` relative to the
    // process cwd, which reads as a Codex with no sessions.
    for (const value of ['', '   ', '\t']) {
      const env = { [CODEX_HOME_VAR]: value, [HOME_VAR]: join('C:', 'Users', 'someone') };
      const resolved = resolveCodexRoot({ env });
      expect(resolved.rootSource).toBe('homedir');
      expect(resolved.root).toBe(join('C:', 'Users', 'someone', '.codex'));
    }
  });

  it('resolves at READ time: the same options object gives a new answer when the env moves', () => {
    // Property 1 of the module header. A module-scope `const ROOT` would be
    // resolved once per extension-host process, and a user who set the
    // variable after the host started would be observed against a stale root —
    // silently.
    const env: NodeJS.ProcessEnv = { [HOME_VAR]: join('C:', 'Users', 'someone') };
    const options = { env };
    expect(resolveCodexRoot(options).rootSource).toBe('homedir');
    env[CODEX_HOME_VAR] = join('E:', 'moved');
    expect(resolveCodexRoot(options)).toEqual({ root: join('E:', 'moved'), rootSource: 'CODEX_HOME' });
    delete env[CODEX_HOME_VAR];
    expect(resolveCodexRoot(options).rootSource).toBe('homedir');
  });
});

describe('resolveCodexRoot — both env vars faked, with a live negative control', () => {
  it('reads the platform home variable and finds the planted root', () => {
    const { root } = plantRoot();
    const home = dirname(root);
    withEnv({ [CODEX_HOME_VAR]: undefined, [HOME_VAR]: home, [DECOY_VAR]: home }, () => {
      // No `env` option at all: this is the production path reading process.env.
      expect(resolveCodexRoot().root).toBe(root);
      expect(locateCodex().rootExists).toBe(true);
      expect(locateCodex().transcripts).toHaveLength(1);
    });
  });

  it('the DECOY variable alone does NOT move the root, even with the primary UNSET', () => {
    // The recorded trap: `os.homedir()` reads USERPROFILE on Windows and HOME
    // on POSIX, so faking only the other one runs happily against the REAL home
    // and reports a green, confident, completely false pass.
    //
    // **The primary variable is DELETED here, and that is the whole test.** An
    // earlier version left it in place, so a resolver that consulted BOTH
    // variables never reached the second one and the mutation survived — the
    // control was measuring nothing, which is the exact failure it exists to
    // catch. Found by mutation testing; do not "simplify" it back.
    const { root } = plantRoot();
    const home = dirname(root);
    withEnv({ [CODEX_HOME_VAR]: undefined, [HOME_VAR]: undefined, [DECOY_VAR]: home }, () => {
      expect(resolveCodexRoot().root).not.toBe(root);
      expect(resolveCodexRoot().root.startsWith(home)).toBe(false);
      // Deliberately no `locateCodex()` here. With the primary home variable
      // unset, `os.homedir()` returns the developer's REAL home — and a call
      // would walk the live `~/.codex`, which G6 forbids outright. The first
      // draft of this case did exactly that and the assertion went red on a
      // machine that has Codex installed, which is the cheap way to find out.
    });
  });

  it('the decoy is ignored by the injected-env path too', () => {
    const decoyOnly: NodeJS.ProcessEnv = { [DECOY_VAR]: join('Z:', 'decoy') };
    expect(resolveCodexRoot({ env: decoyOnly }).root.startsWith(join('Z:', 'decoy'))).toBe(false);
    const primary: NodeJS.ProcessEnv = { [HOME_VAR]: join('Z:', 'real') };
    expect(resolveCodexRoot({ env: primary }).root).toBe(join('Z:', 'real', '.codex'));
  });

  it('CODEX_HOME beats a faked home, because it relocates the entire surface', () => {
    const { root: planted } = plantRoot();
    const other = tmp('cx-locate-other-');
    withEnv({ [HOME_VAR]: dirname(planted), [DECOY_VAR]: dirname(planted), [CODEX_HOME_VAR]: other }, () => {
      const resolved = resolveCodexRoot();
      expect(resolved.rootSource).toBe('CODEX_HOME');
      expect(resolved.root).toBe(other);
      // And discovery follows it, rather than the home it could also have seen.
      expect(locateCodex().transcripts).toHaveLength(0);
    });
  });
});

// ===========================================================================
// An absent root is a value, not an error (DoD 2.1)
// ===========================================================================

describe('an absent root: silently off, no throw, logged once', () => {
  const absentEnv = (): NodeJS.ProcessEnv => ({
    [CODEX_HOME_VAR]: join(tmp('cx-absent-'), 'no-such-codex'),
  });

  it('returns rootExists false with no transcripts and does not throw', () => {
    const env = absentEnv();
    const discovery = locateCodex({ env });
    expect(discovery.rootExists).toBe(false);
    expect(discovery.transcripts).toEqual([]);
    expect(discovery.rootSource).toBe('CODEX_HOME');
    expect(discovery.lockDir).toBe(join(discovery.root, CODEX_LOCK_DIR_NAME));
  });

  it('logs EXACTLY ONCE across many polls', () => {
    const records: CodexLocateLogRecord[] = [];
    const locator = new CodexLocator({ env: absentEnv(), log: (r) => records.push(r) });
    for (let i = 0; i < 5; i += 1) expect(locator.locate().rootExists).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('info');
    expect(records[0]?.event).toBe('rootAbsent');
    expect(records[0]?.rootSource).toBe('CODEX_HOME');
    expect(records[0]?.message).toContain('the Codex engine is off');
  });

  it('logs nothing at all when the root is there', () => {
    const { root } = plantRoot();
    const records: CodexLocateLogRecord[] = [];
    const locator = new CodexLocator({ env: { [CODEX_HOME_VAR]: root }, log: (r) => records.push(r) });
    for (let i = 0; i < 3; i += 1) locator.locate();
    expect(records).toEqual([]);
    expect(locator.hasLoggedAbsentRoot).toBe(false);
  });

  it('logs again for a SECOND disappearance, because that is new information', () => {
    const { root } = plantRoot();
    const records: CodexLocateLogRecord[] = [];
    const env: NodeJS.ProcessEnv = { [CODEX_HOME_VAR]: join(root, 'gone') };
    const locator = new CodexLocator({ env, log: (r) => records.push(r) });

    locator.locate();
    locator.locate();
    expect(records).toHaveLength(1);

    env[CODEX_HOME_VAR] = root; // Codex appears
    expect(locator.locate().rootExists).toBe(true);
    expect(locator.hasLoggedAbsentRoot).toBe(false);

    env[CODEX_HOME_VAR] = join(root, 'gone'); // and goes away again
    locator.locate();
    locator.locate();
    expect(records).toHaveLength(2);
  });

  it('does not throw when no logger is supplied at all', () => {
    const locator = new CodexLocator({ env: absentEnv() });
    expect(() => {
      locator.locate();
      locator.locate();
    }).not.toThrow();
  });

  it('distinguishes a root with no sessions directory from an absent root', () => {
    const root = tmp('cx-empty-root-');
    const discovery = locateCodex({ env: { [CODEX_HOME_VAR]: root } });
    expect(discovery.rootExists).toBe(true);
    expect(discovery.transcripts).toEqual([]);
  });

  it('does not throw when the root is a FILE rather than a directory', () => {
    const dir = tmp('cx-file-root-');
    const file = join(dir, 'codex');
    writeFileSync(file, 'not a directory');
    expect(() => locateCodex({ env: { [CODEX_HOME_VAR]: file } })).not.toThrow();
    expect(locateCodex({ env: { [CODEX_HOME_VAR]: file } }).rootExists).toBe(false);
  });
});

// ===========================================================================
// The walk (C1)
// ===========================================================================

describe('discovery over the committed corpus', () => {
  // Read-only, in place: the corpus already carries the production layout
  // `<run>/home/.codex/sessions/YYYY/MM/DD/`. Nothing here restructures it.
  const runs = readdirSync(CORPUS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(CORPUS, name, 'home', '.codex')));

  it('the corpus offers more than one run to walk (the enumeration is not empty)', () => {
    expect(runs.length).toBeGreaterThan(1);
  });

  it.each(runs)('%s — finds exactly the rollout files an independent walk finds', (run) => {
    const root = join(CORPUS, run, 'home', '.codex');
    const discovery = locateCodex({ env: { [CODEX_HOME_VAR]: root } });

    expect(discovery.rootExists).toBe(true);
    // Set equality, not a count pinned against the capture: a harvest that adds
    // a run must not read as a regression.
    expect(discovery.transcripts.map((t) => t.path).sort()).toEqual(expectedRollouts(root));
    expect(discovery.transcripts.length).toBe(expectedRollouts(root).length);
  });

  it.each(runs)('%s — every ref carries the day it was walked under, and real stats', (run) => {
    const root = join(CORPUS, run, 'home', '.codex');
    for (const ref of locateCodex({ env: { [CODEX_HOME_VAR]: root } }).transcripts) {
      expect(ref.file).toMatch(CODEX_ROLLOUT_FILE_RE);
      expect(ref.day.split('/')).toHaveLength(CODEX_DAY_DEPTH);
      expect(ref.path.endsWith(ref.day.split('/').join(sep) + sep + ref.file)).toBe(true);
      const stats = statSync(ref.path);
      expect(ref.bytes).toBe(stats.size);
      expect(ref.bytes).toBeGreaterThan(0);
      expect(ref.mtimeMs).toBe(stats.mtimeMs);
    }
  });

  it('carries no classification of root vs subagent, because the path cannot say', () => {
    // Spec C1: a subagent's transcript is a SIBLING of its parent's, with
    // nothing in the path marking it. A discovery pass that classified by path
    // cannot work, so there must be no field here inviting one to try.
    const root = join(CORPUS, 'spawn-shapes', 'home', '.codex');
    const ref = locateCodex({ env: { [CODEX_HOME_VAR]: root } }).transcripts[0];
    expect(ref).toBeDefined();
    expect(Object.keys(ref ?? {}).sort()).toEqual(['bytes', 'day', 'file', 'mtimeMs', 'path']);
  });
});

describe('the walk never composes a date and never reads one day directory', () => {
  it('finds a transcript under a day that is not today', () => {
    const { root, planted } = plantRoot({ day: join('2019', '01', '02') });
    const discovery = locateCodex({ env: { [CODEX_HOME_VAR]: root } });
    expect(discovery.transcripts.map((t) => t.path)).toEqual(planted);
    expect(discovery.transcripts[0]?.day).toBe('2019/01/02');
  });

  it('finds transcripts spread across several days, including a parent/child split', () => {
    // C1: the date directories are keyed on the day a thread STARTED, so a
    // session running past midnight puts a child under a different day from
    // its parent. Both must come back from one pass.
    const { root } = plantRoot({ day: join('2026', '09', '02'), files: ['rollout-a-1.jsonl'] });
    const other = join(root, 'sessions', '2026', '09', '03');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'rollout-b-2.jsonl'), '{}\n');

    const days = locateCodex({ env: { [CODEX_HOME_VAR]: root } }).transcripts.map((t) => t.day);
    expect(days.sort()).toEqual(['2026/09/02', '2026/09/03']);
  });

  it('ignores files that are not rollouts, and directories that are not days', () => {
    const { root, planted } = plantRoot();
    const dayDir = dirname(planted[0] ?? '');
    writeFileSync(join(dayDir, 'notes.txt'), 'x');
    writeFileSync(join(dayDir, 'rollout-no-extension'), 'x');
    writeFileSync(join(root, 'sessions', 'stray.jsonl'), 'x');
    mkdirSync(join(root, CODEX_LOCK_DIR_NAME), { recursive: true });
    writeFileSync(join(root, CODEX_LOCK_DIR_NAME, '.coordination.lock'), '');

    const discovery = locateCodex({ env: { [CODEX_HOME_VAR]: root } });
    expect(discovery.transcripts.map((t) => t.path)).toEqual(planted);
    expect(discovery.lockDir).toBe(join(root, CODEX_LOCK_DIR_NAME));
  });

  it('returns transcripts in a stable order across polls', () => {
    const { root } = plantRoot({
      files: ['rollout-c-3.jsonl', 'rollout-a-1.jsonl', 'rollout-b-2.jsonl'],
    });
    const once = locateCodex({ env: { [CODEX_HOME_VAR]: root } }).transcripts.map((t) => t.file);
    const twice = locateCodex({ env: { [CODEX_HOME_VAR]: root } }).transcripts.map((t) => t.file);
    expect(once).toEqual(twice);
    expect(once).toEqual([...once].sort());
  });

  it('absorbs an unreadable directory rather than throwing (G3)', () => {
    const { root, planted } = plantRoot();
    const failing: CodexLocateFs = {
      statSync: (path) => statSync(path),
      readdirSync: (path) => {
        if (path.endsWith('01' + sep + '02')) throw new Error('EACCES: permission denied');
        return readdirSync(path, { withFileTypes: true });
      },
    };
    let discovery = { transcripts: [] as readonly { path: string }[] };
    expect(() => {
      discovery = locateCodex({ env: { [CODEX_HOME_VAR]: root }, fs: failing });
    }).not.toThrow();
    expect(discovery.transcripts).toEqual([]);
    // Control: the same tree with the real fs does find it, so the case above
    // is measuring the refusal and not an empty tree.
    expect(locateCodex({ env: { [CODEX_HOME_VAR]: root } }).transcripts.map((t) => t.path)).toEqual(
      planted,
    );
  });
});

// ===========================================================================
// G10 — the walk never touches an excluded path
// ===========================================================================

describe('G10 — never opened, enforced rather than asserted', () => {
  function plantForbidden(): { root: string; legit: string[] } {
    const { root, planted } = plantRoot();
    const dayDir = dirname(planted[0] ?? '');

    for (const name of CODEX_NEVER_OPEN_NAMES) {
      writeFileSync(join(root, name), 'SECRET');
      writeFileSync(join(dayDir, name), 'SECRET');
    }
    for (const suffix of CODEX_NEVER_OPEN_SUFFIXES) {
      writeFileSync(join(root, `threads${suffix}`), 'SECRET');
      writeFileSync(join(dayDir, `threads${suffix}`), 'SECRET');
    }
    for (const dir of CODEX_NEVER_OPEN_DIR_NAMES) {
      const secretDir = join(dayDir, dir);
      mkdirSync(secretDir, { recursive: true });
      // A file that WOULD be discovered on name alone. If the walk descends,
      // this shows up in `transcripts` and the assertion below goes red.
      writeFileSync(join(secretDir, 'rollout-secret-9.jsonl'), '{}\n');
      writeFileSync(join(secretDir, 'key.pem'), 'SECRET');
    }
    return { root, legit: planted };
  }

  it('discovers the legitimate transcript and nothing from an excluded path', () => {
    const { root, legit } = plantForbidden();
    const discovery = locateCodex({ env: { [CODEX_HOME_VAR]: root } });
    expect(discovery.transcripts.map((t) => t.path)).toEqual(legit);
    for (const ref of discovery.transcripts) {
      expect(isNeverOpen(root, ref.path)).toBe(false);
    }
  });

  it('hands NO excluded path to the filesystem, at any depth', () => {
    // The strong form: not "the results are clean" but "the call was never
    // made". A recording seam is the only way to tell those apart.
    const { root } = plantForbidden();
    const { fs, touched } = recordingFs();
    locateCodex({ env: { [CODEX_HOME_VAR]: root }, fs });

    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((path) => isNeverOpen(root, path))).toEqual([]);
  });

  it('the recording seam would see a violation if one happened (vacuity control)', () => {
    // Without this, a seam that recorded nothing, or an `isNeverOpen` that
    // answered `false` for everything, would make the assertion above pass
    // while proving nothing.
    const { root } = plantForbidden();
    const { fs, touched } = recordingFs();
    const name = CODEX_NEVER_OPEN_NAMES[0] ?? '';
    fs.statSync(join(root, name));
    expect(touched.filter((path) => isNeverOpen(root, path))).toHaveLength(1);
  });
});

// ===========================================================================
// G6 — the corpus is not modified by being read
// ===========================================================================

describe('G1/G6 — discovery writes nothing', () => {
  it('leaves a copied corpus byte-identical', () => {
    const dir = tmp('cx-readonly-');
    const root = join(dir, '.codex');
    cpSync(join(CORPUS, 'baseline', 'home', '.codex'), root, { recursive: true });

    const before = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((rel) => {
        const stats = statSync(join(root, rel));
        return `${rel}|${stats.isDirectory() ? 'd' : stats.size}`;
      })
      .sort();

    locateCodex({ env: { [CODEX_HOME_VAR]: root } });

    const after = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((rel) => {
        const stats = statSync(join(root, rel));
        return `${rel}|${stats.isDirectory() ? 'd' : stats.size}`;
      })
      .sort();

    expect(after).toEqual(before);
  });
});
