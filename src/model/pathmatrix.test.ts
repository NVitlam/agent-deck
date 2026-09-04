/**
 * Phase 4 — the path-resolution matrix.
 *
 * DoD item: "`~/.claude` resolution verified: Windows native + (WSL or
 * documented gap); slug encoding differences tested". The gap escape was taken
 * off the table at the phase gate, so this file runs two legs:
 *
 *   1. **Native.** The probe, bundled and executed as a child process of the
 *      host platform, plus fixture-driven slug cases and the pure
 *      slug-selection rules. Every test in this leg runs on every machine —
 *      nothing here can skip. A child process, not an in-process call,
 *      because the negative control has to fake `HOME`/`USERPROFILE` and a
 *      vitest worker thread only owns a *copy* of `process.env` while
 *      `os.homedir()` reads the real one. Measured: faking them in-process
 *      left resolution pointing at the machine's real projects root, where it
 *      failed with `projectSlugNotFound` — a green control that had proved
 *      nothing.
 *   2. **WSL.** The *same* probe, bundled by esbuild and executed by a real
 *      Linux Node inside the WSL distro, so `$HOME/.claude` resolution, posix
 *      path joining and a case-sensitive filesystem are measured rather than
 *      simulated.
 *
 * The WSL leg needs a Linux Node, which is not part of any checkout, so it
 * skips when one is absent — loudly, with the reason and the command that
 * fixes it, and `AGENT_DECK_REQUIRE_WSL=1` turns absence into a failure for
 * anyone verifying the DoD. What the leg would otherwise prove is not lost
 * when it skips: the recorded measurement in
 * `fixtures/synthetic-path-matrix/wsl-environment.measured.json` is asserted
 * against this repo's live encoding by tests that always run, and the live leg
 * re-measures the same facts and refuses to disagree with the record.
 *
 * Nothing here writes inside the repo, inside `fixtures/`, or inside any real
 * `~/.claude` — on either platform. The negative control proves the last one
 * with BOTH `HOME` and `USERPROFILE` faked, because `os.homedir()` reads
 * `USERPROFILE` on Windows and faking only `HOME` has already produced one
 * green, false pass in this repo's history.
 *
 * ---------------------------------------------------------------------------
 * v0.6.0 PHASE 4, DoD 4.1 — THE THIRD ENGINE'S ROOT
 * ---------------------------------------------------------------------------
 *
 * "Windows native + `CODEX_HOME` + WSL leg (or documented gap) for the Codex
 * root; slug/cwd matching cases from the corpus." **The WSL leg is a working
 * leg, not a gap**: measured 2026-09-04, `wsl.exe` is usable on this machine
 * and `$HOME/.local/opt/node-v24.19.0-linux-x64/bin/node` reports
 * `process.platform === 'linux'`, so the same probe binary runs both halves.
 * On a machine without that Node the Codex WSL test skips through the SAME
 * `skipIf(!WSL.usable)` gate as the Claude Code one, with `WSL.reason` printed
 * once on stderr — and the pure and corpus legs below, which carry the
 * precedence rule and every slug/cwd case, run on every machine regardless.
 *
 * Four Codex legs, in file order:
 *
 *   1f. **Pure.** `resolveCodexRoot`'s precedence (explicit > `CODEX_HOME` >
 *       home), the blank-is-unset rule, read-time resolution, and the DECOY
 *       home variable that must not move the root.
 *   1g. **Corpus roots.** The committed corpus is laid out as
 *       `<run>/home/.codex/...`, which is what lets all three sources point at
 *       the SAME real captured tree and be required to agree, file for file,
 *       against an enumeration that never touches the engine.
 *   1h. **Slug / cwd.** The project key derived from the corpus's own declared
 *       `cwd` through `readCodexEngine`, cross-checked against the recorded
 *       wire corpus, plus the four spellings of that one directory.
 *   Native and WSL. The probe's `codex` section, asserted by one shared
 *       function so the two platforms cannot drift apart.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readCodexEngine } from '../codex/index.js';
import { locateCodex, resolveCodexRoot } from '../codex/locate.js';
import type { CodexEngineResult } from '../codex/types.js';
import {
  discoverSessions,
  resolveProjectsRoot,
  selectSlugDirectory,
  slugifyWorkspace,
} from '../parser/tailer.js';
import { normalizeSlug, sameWorkspace, workspaceSlug } from './correlate.js';
import { flipNthLetterCase, nativeProbeWorkspace } from './pathmatrix.probe.js';
import type { ProbeReport, SlugCase } from './pathmatrix.probe.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MATRIX_DIR = join(REPO_ROOT, 'fixtures', 'synthetic-path-matrix');
const CAPTURE_ROOT = join(REPO_ROOT, 'fixtures', 'cc-2.1.234', 'projects');

const SLUG_CASES = JSON.parse(
  await readFile(join(MATRIX_DIR, 'slug-cases.json'), 'utf8'),
) as SlugCase[];

interface MeasuredWslEnvironment {
  provenance: string;
  measuredAt: string;
  wsl: {
    distro: string;
    defaultVersion: number;
    kernel: string;
    home: string;
    homeShape: string;
    homeSha256: string;
    claudeDirectoryPresent: boolean;
    linuxNodeOnPath: boolean;
    wslpath: {
      windowsWorkspace: string;
      wslMountForm: string;
      linuxHome: string;
      windowsFormOfLinuxHome: string;
      windowsFormOfLinuxHomeSha256: string;
      neutralLinuxPath: string;
      windowsFormOfNeutralLinuxPath: string;
    };
  };
  redaction: {
    appliedAt: string;
    destroyed: string;
    kept: string;
    whyNotTheWindowsSide: string;
    notASecret: string;
  };
  slugs: { windows: string; wslMount: string; identical: boolean };
  probeLinux: {
    platform: string;
    pathSeparator: string;
    homedir: string;
    homedirSha256: string;
    rootFromHome: { root: string; source: string };
    tempFilesystemCaseSensitive: boolean;
    discoveryWorkspace: string;
    discoverySlug: string;
    negativeControlKind: string;
    negativeControlCode: string;
    caseInsensitiveOutcome: string;
    ambiguousOutcome: string;
    ambiguousCode: string;
    exactBeatsCaseVariantOutcome: string;
  };
}

const MEASURED = JSON.parse(
  await readFile(join(MATRIX_DIR, 'wsl-environment.measured.json'), 'utf8'),
) as MeasuredWslEnvironment;

/**
 * The token the WSL-side account name is stored as. `wsl-environment.measured.json`
 * carries digests instead of the literal home path; see that file's `redaction`
 * block and README.md's privacy section for why the WSL side is redacted while
 * the Windows side is not.
 */
const REDACTED_WSL_HOME = '/home/<redacted-user>';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Rewrite a live Linux path into the spelling the fixture stores. */
const redactWslHome = (value: string, liveHome: string): string =>
  value.replace(liveHome, REDACTED_WSL_HOME);

function caseById(id: string): SlugCase {
  const found = SLUG_CASES.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no slug case '${id}' in slug-cases.json`);
  return found;
}

// ---------------------------------------------------------------------------
// Leg 1a — slug encoding, every case in the fixture
// ---------------------------------------------------------------------------

describe('slug encoding matrix (fixture-driven, runs on every platform)', () => {
  for (const slugCase of SLUG_CASES) {
    it(`${slugCase.id} (${slugCase.form}): ${slugCase.workspacePath}`, () => {
      expect(slugifyWorkspace(slugCase.workspacePath)).toBe(slugCase.expectedSlug);
      // The correlator must not have a second encoding.
      expect(workspaceSlug(slugCase.workspacePath)).toBe(slugCase.expectedSlug);
    });
  }

  it('the one CC-witnessed case equals the slug directory the committed capture actually has', async () => {
    const witnessed = SLUG_CASES.filter((c) => c.witness === 'cc-capture');
    expect(witnessed.length).toBeGreaterThan(0);
    const onDisk = (await readdir(CAPTURE_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const c of witnessed) {
      expect(onDisk).toContain(c.expectedSlug);
      expect(slugifyWorkspace(c.workspacePath)).toBe(c.expectedSlug);
    }
  });

  it('slug encoding is platform-independent: it is string substitution, not path joining', () => {
    // The same input must slug identically no matter which OS runs this file;
    // the WSL leg asserts the same table under Linux Node.
    for (const slugCase of SLUG_CASES) {
      expect(slugifyWorkspace(slugCase.workspacePath)).toBe(slugCase.expectedSlug);
    }
  });
});

// ---------------------------------------------------------------------------
// Leg 1b — the WSL/Windows divergence, which is the finding
// ---------------------------------------------------------------------------

describe('one workspace, two spellings: Windows vs WSL', () => {
  const windows = caseById('windows-drive-lower');
  const wslMount = caseById('wsl-mount-of-windows-workspace');

  it('produces two DIFFERENT slugs for the same physical directory', () => {
    const winSlug = slugifyWorkspace(windows.workspacePath);
    const wslSlug = slugifyWorkspace(wslMount.workspacePath);
    expect(winSlug).toBe('c--Users-dev-projects-agent-deck');
    expect(wslSlug).toBe('-mnt-c-Users-dev-projects-agent-deck');
    expect(winSlug).not.toBe(wslSlug);
  });

  it('and they are NOT case variants: no normalisation makes them equal', () => {
    expect(normalizeSlug(slugifyWorkspace(windows.workspacePath))).not.toBe(
      normalizeSlug(slugifyWorkspace(wslMount.workspacePath)),
    );
    expect(sameWorkspace(windows.workspacePath, wslMount.workspacePath)).toBe(false);
  });

  it('the drive-letter variants ARE case variants, and still correlate', () => {
    const lower = caseById('windows-drive-lower').workspacePath;
    const upper = caseById('windows-drive-upper').workspacePath;
    expect(slugifyWorkspace(lower)).not.toBe(slugifyWorkspace(upper));
    expect(sameWorkspace(lower, upper)).toBe(true);
  });

  it('the two WSL mount spellings differ only by case', () => {
    const a = '/mnt/c/Users/dev/ws';
    const b = caseById('wsl-mount-uppercase-drive').workspacePath;
    expect(slugifyWorkspace(a)).not.toBe(slugifyWorkspace(b));
    expect(sameWorkspace(a, b)).toBe(true);
  });

  it('the UNC spelling of a Linux-side workspace is a third, distinct slug', () => {
    const unc = caseById('unc-wsl-localhost').workspacePath;
    const posix = caseById('wsl-linux-home').workspacePath;
    expect(slugifyWorkspace(unc)).not.toBe(slugifyWorkspace(posix));
    expect(sameWorkspace(unc, posix)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Leg 1c — projects root resolution
// ---------------------------------------------------------------------------

describe('projects root resolution', () => {
  it('CLAUDE_PROJECTS_ROOT replaces the home location entirely, on any platform', () => {
    const resolved = resolveProjectsRoot({
      env: { CLAUDE_PROJECTS_ROOT: join(tmpdir(), 'fixture-root') },
      homedir: () => join(tmpdir(), 'home'),
    });
    expect(resolved.source).toBe('env');
    expect(resolved.root).toBe(join(tmpdir(), 'fixture-root'));
  });

  it('joins the home location with the HOST platform separator, which is why the Linux root is measured and not simulated', () => {
    const resolved = resolveProjectsRoot({ env: {}, homedir: () => join(tmpdir(), 'home') });
    expect(resolved.source).toBe('home');
    expect(resolved.root).toBe(join(tmpdir(), 'home', '.claude', 'projects'));
    if (process.platform === 'win32') {
      expect(resolveProjectsRoot({ env: {}, homedir: () => 'C:\\Users\\dev' }).root).toBe(
        'C:\\Users\\dev\\.claude\\projects',
      );
    } else {
      expect(resolveProjectsRoot({ env: {}, homedir: () => '/home/probe' }).root).toBe(
        '/home/probe/.claude/projects',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Leg 1d — slug selection, including the branch this filesystem cannot produce
// ---------------------------------------------------------------------------

describe('selectSlugDirectory (pure: every branch runs on every platform)', () => {
  const want = 'c--Users-dev-ws';

  it('picks the exact spelling', () => {
    expect(selectSlugDirectory(['other', want], want)).toEqual({ kind: 'exact', name: want });
  });

  it('picks a lone case variant and reports that the spelling differed', () => {
    const variant = 'C--Users-dev-ws';
    expect(selectSlugDirectory(['other', variant], want)).toEqual({
      kind: 'caseInsensitive',
      name: variant,
    });
  });

  it('prefers the exact spelling over a case variant, so two variants are never a coin toss', () => {
    expect(selectSlugDirectory(['C--Users-dev-ws', want], want)).toEqual({
      kind: 'exact',
      name: want,
    });
  });

  it('REFUSES when two case variants exist and neither is exact', () => {
    const selection = selectSlugDirectory(['C--Users-dev-WS', 'C--Users-dev-ws'], want);
    expect(selection).toEqual({
      kind: 'ambiguous',
      candidates: ['C--Users-dev-WS', 'C--Users-dev-ws'],
    });
  });

  it('reports none when nothing matches', () => {
    expect(selectSlugDirectory(['-home-probe-ws'], want)).toEqual({ kind: 'none' });
  });

  it('flipNthLetterCase makes variants that differ by case alone', () => {
    expect(flipNthLetterCase('-mnt-c-Users-ws', 0)).toBe('-Mnt-c-Users-ws');
    expect(flipNthLetterCase('-mnt-c-Users-ws', 1)).toBe('-mNt-c-Users-ws');
    expect(flipNthLetterCase('-mnt-c-Users-ws', 0)?.toLowerCase()).toBe('-mnt-c-users-ws');
    expect(flipNthLetterCase('----', 0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Leg 1e — negative control through the injected seam, plus the reason the
// env-faked form of it has to run in a child process
// ---------------------------------------------------------------------------

describe('negative control: no CLAUDE_PROJECTS_ROOT and no ~/.claude', () => {
  it('fails ENOENT at the injected home and never falls back to the real one', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agent-deck-negctl-'));
    const fakedHome = join(temp, 'home');
    await mkdir(fakedHome, { recursive: true });
    try {
      const result = await discoverSessions(nativeProbeWorkspace(process.platform), {
        env: {},
        homedir: () => fakedHome,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.kind).toBe('projectsRootNotFound');
      expect(result.failure.code).toBe('ENOENT');
      expect(result.failure.path).toBe(join(fakedHome, '.claude', 'projects'));
      expect(result.failure.path).not.toBe(join(homedir(), '.claude', 'projects'));
      // G1: the refusal created nothing under the faked home.
      expect(await readdir(fakedHome)).toEqual([]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('PINS WHY THE ENV-FAKED CONTROL RUNS IN A CHILD PROCESS: env writes here do not move os.homedir()', () => {
    // Measured, not assumed. Under the pinned `threads` pool each worker gets a
    // COPY of process.env, while os.homedir() goes through libuv to the real
    // process environment. A negative control that fakes HOME/USERPROFILE in
    // this process therefore proves nothing — worse, resolution then reads the
    // machine's real projects root and can fail for an unrelated reason that
    // still looks like a pass. Measured on 2026-08-20: it returned
    // `projectSlugNotFound` from the REAL ~/.claude/projects, not
    // `projectsRootNotFound` from the fake.
    //
    // If this test ever fails, the pool changed and env-faked controls became
    // live again — which is information, not noise.
    const fakedHome = join(tmpdir(), 'agent-deck-not-the-home');
    const savedHome = process.env['HOME'];
    const savedUserProfile = process.env['USERPROFILE'];
    try {
      process.env['HOME'] = fakedHome;
      process.env['USERPROFILE'] = fakedHome;
      expect(homedir()).not.toBe(fakedHome);
    } finally {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      if (savedUserProfile === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = savedUserProfile;
    }
  });
});

// ---------------------------------------------------------------------------
// Leg 1f — the CODEX data root (v0.6.0 Phase 4, DoD 4.1)
// ---------------------------------------------------------------------------

/**
 * The one home variable `os.homedir()` reads on this platform, and the one it
 * does not.
 *
 * `resolveCodexRoot` consults exactly the first. Reading both would hide the
 * recorded trap — a control that fakes only the decoy runs happily against the
 * machine's REAL home and reports a green, confident, completely false pass —
 * so the decoy test below is the assertion that goes red if this is ever
 * "helpfully" widened.
 */
const CODEX_HOME_FALLBACK_VAR = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
const CODEX_DECOY_VAR = process.platform === 'win32' ? 'HOME' : 'USERPROFILE';

describe('Codex root resolution (pure: explicit > CODEX_HOME > home, on every platform)', () => {
  const home = join(tmpdir(), 'agent-deck-codex-home');
  const codexHome = join(tmpdir(), 'agent-deck-codex-var');
  const explicit = join(tmpdir(), 'agent-deck-codex-explicit');

  it('an explicit root outranks both, and calls itself explicit rather than CODEX_HOME', () => {
    expect(
      resolveCodexRoot({
        root: explicit,
        env: { [CODEX_HOME_FALLBACK_VAR]: home, CODEX_HOME: codexHome },
      }),
    ).toEqual({ root: explicit, rootSource: 'explicit' });
  });

  it('CODEX_HOME outranks the home fallback', () => {
    expect(
      resolveCodexRoot({ env: { [CODEX_HOME_FALLBACK_VAR]: home, CODEX_HOME: codexHome } }),
    ).toEqual({ root: codexHome, rootSource: 'CODEX_HOME' });
  });

  it('the home fallback is <home>/.codex, joined with the HOST separator', () => {
    expect(resolveCodexRoot({ env: { [CODEX_HOME_FALLBACK_VAR]: home } })).toEqual({
      root: join(home, '.codex'),
      rootSource: 'homedir',
    });
    if (process.platform === 'win32') {
      expect(resolveCodexRoot({ env: { USERPROFILE: 'C:\\Users\\Probe' } }).root).toBe(
        'C:\\Users\\Probe\\.codex',
      );
    } else {
      expect(resolveCodexRoot({ env: { HOME: '/home/probe' } }).root).toBe('/home/probe/.codex');
    }
  });

  it('the DECOY home variable does NOT move the root', () => {
    const decoy = join(tmpdir(), 'agent-deck-codex-not-the-home');
    const resolved = resolveCodexRoot({ env: { [CODEX_DECOY_VAR]: decoy } });
    expect(resolved).toEqual({ root: join(homedir(), '.codex'), rootSource: 'homedir' });
    expect(resolved.root).not.toBe(join(decoy, '.codex'));
  });

  it('a blank or whitespace-only value is "unset" for BOTH the option and the variable', () => {
    expect(
      resolveCodexRoot({
        root: '   ',
        env: { [CODEX_HOME_FALLBACK_VAR]: home, CODEX_HOME: codexHome },
      }),
    ).toEqual({ root: codexHome, rootSource: 'CODEX_HOME' });
    expect(
      resolveCodexRoot({ root: '', env: { [CODEX_HOME_FALLBACK_VAR]: home, CODEX_HOME: ' \t ' } }),
    ).toEqual({ root: join(home, '.codex'), rootSource: 'homedir' });
  });

  it('resolves at READ time: one options object gives a new answer after the env moves', () => {
    const env: NodeJS.ProcessEnv = { [CODEX_HOME_FALLBACK_VAR]: home };
    const options = { env };
    expect(resolveCodexRoot(options)).toEqual({
      root: join(home, '.codex'),
      rootSource: 'homedir',
    });
    env['CODEX_HOME'] = codexHome;
    expect(resolveCodexRoot(options)).toEqual({ root: codexHome, rootSource: 'CODEX_HOME' });
  });
});

// ---------------------------------------------------------------------------
// Leg 1g — the same three sources, against the committed Codex corpus
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');

/** Every file under `dir`, as `/`-joined paths relative to it, sorted. */
async function listFilesUnder(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFilesUnder(join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * The Codex ANCHOR corpus, chosen the way this repository's rule says to choose
 * one: an anchor carries `golden.json` and a witness does not. Choosing by name
 * — or by taking `[0]` after a sort, which happened to work only because
 * `codex-0…` sorts before `codex-vscode-…` — is what breaks the day another
 * corpus lands beside it.
 */
const CODEX_ANCHOR_CORPORA: string[] = [];
for (const entry of await readdir(FIXTURES_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('codex-')) continue;
  if ((await readdir(join(FIXTURES_DIR, entry.name))).includes('golden.json')) {
    CODEX_ANCHOR_CORPORA.push(entry.name);
  }
}
CODEX_ANCHOR_CORPORA.sort();
const CODEX_CORPUS_NAME = CODEX_ANCHOR_CORPORA[0] ?? '';
const CODEX_CORPUS = join(FIXTURES_DIR, CODEX_CORPUS_NAME);

/** Each harvest run in the corpus: a directory holding `home/.codex`. */
const CODEX_RUNS: string[] = [];
for (const entry of await readdir(CODEX_CORPUS, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const home = join(CODEX_CORPUS, entry.name, 'home');
  const inHome = await readdir(home).catch(() => [] as string[]);
  if (inHome.includes('.codex')) CODEX_RUNS.push(entry.name);
}
CODEX_RUNS.sort();

const codexRunHome = (run: string): string => join(CODEX_CORPUS, run, 'home');
const codexRunRoot = (run: string): string => join(codexRunHome(run), '.codex');

/** The rollout paths under a run's root, enumerated WITHOUT the engine. */
async function rolloutPathsOf(run: string): Promise<string[]> {
  const root = codexRunRoot(run);
  return (await listFilesUnder(root))
    .filter((rel) => /(^|\/)rollout-[^/]*\.jsonl$/.test(rel))
    .map((rel) => join(root, ...rel.split('/')))
    .sort();
}

/** The `cwd` a run's first transcript declares, read as bytes, not via the engine. */
async function corpusCwdOf(run: string): Promise<string> {
  const paths = await rolloutPathsOf(run);
  const first = paths[0];
  if (first === undefined) throw new Error(`run '${run}' holds no rollout transcript`);
  const line = (await readFile(first, 'utf8')).split('\n')[0] ?? '';
  const meta = JSON.parse(line) as { payload?: { cwd?: string } };
  const cwd = meta.payload?.cwd;
  if (typeof cwd !== 'string' || cwd === '') throw new Error(`no cwd in ${first}`);
  return cwd;
}

async function codexEngineOk(options: {
  root: string;
  workspaceFolders?: readonly string[];
}): Promise<CodexEngineResult> {
  const outcome = await readCodexEngine(options);
  if (outcome.kind !== 'ok') throw new Error(`codex engine returned '${outcome.kind}'`);
  return outcome.result;
}

describe('Codex root: the committed corpus, through all three sources', () => {
  it('the corpus is selected by its golden, and it has runs', () => {
    expect(
      CODEX_ANCHOR_CORPORA,
      'exactly one fixtures/codex-* directory may carry golden.json',
    ).toHaveLength(1);
    expect(CODEX_CORPUS_NAME).toMatch(/^codex-\d/);
    expect(CODEX_RUNS.length).toBeGreaterThan(0);
  });

  it('every run resolves to the same transcripts whether named explicitly, via CODEX_HOME, or via the home fallback', async () => {
    for (const run of CODEX_RUNS) {
      const root = codexRunRoot(run);
      const expectedPaths = await rolloutPathsOf(run);
      expect(expectedPaths.length, run).toBeGreaterThan(0);

      const explicit = locateCodex({ root, env: {} });
      const viaVar = locateCodex({ env: { CODEX_HOME: root } });
      const viaHome = locateCodex({ env: { [CODEX_HOME_FALLBACK_VAR]: codexRunHome(run) } });

      expect(explicit.rootSource, run).toBe('explicit');
      expect(viaVar.rootSource, run).toBe('CODEX_HOME');
      expect(viaHome.rootSource, run).toBe('homedir');

      for (const discovery of [explicit, viaVar, viaHome]) {
        expect(discovery.root, run).toBe(root);
        expect(discovery.rootExists, run).toBe(true);
        expect(discovery.lockDir, run).toBe(join(root, 'thread-writer-locks'));
        expect(discovery.transcripts.map((t) => t.path).sort(), run).toEqual(expectedPaths);
      }
    }
  }, 30_000);

  it('discovery is scoped to <root>/sessions: the run\u2019s own hook-stream.jsonl is never a transcript', async () => {
    for (const run of CODEX_RUNS) {
      // The negative is real captured data, not a planted decoy: every run
      // carries a sibling `.jsonl` that is not a transcript.
      expect(await readdir(join(CODEX_CORPUS, run)), run).toContain('hook-stream.jsonl');
      // Point CODEX_HOME one level up, at the directory that holds it.
      const above = locateCodex({ env: { CODEX_HOME: join(CODEX_CORPUS, run) } });
      expect(above.rootExists, run).toBe(true);
      expect(above.transcripts, run).toEqual([]);

      const discovery = locateCodex({ root: codexRunRoot(run), env: {} });
      const sessions = join(codexRunRoot(run), 'sessions');
      for (const transcript of discovery.transcripts) {
        expect(transcript.path.startsWith(sessions), transcript.path).toBe(true);
        expect(transcript.file).not.toBe('hook-stream.jsonl');
      }
    }
  }, 30_000);

  it('reports the day directory the tree spelled rather than one composed from a clock', async () => {
    const today = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const todayDay = `${today.getFullYear()}/${pad(today.getMonth() + 1)}/${pad(today.getDate())}`;
    const days = new Set<string>();

    for (const run of CODEX_RUNS) {
      const root = codexRunRoot(run);
      for (const transcript of locateCodex({ root, env: {} }).transcripts) {
        expect(transcript.day).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
        // The day is the segments walked: rebuilding the path from it must
        // land back on the file the walk reported.
        expect(join(root, 'sessions', ...transcript.day.split('/'), transcript.file)).toBe(
          transcript.path,
        );
        days.add(transcript.day);
      }
    }
    expect(days.size).toBeGreaterThan(0);
    expect([...days]).not.toContain(todayDay);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Leg 1h — slug / cwd matching, from the corpus
// ---------------------------------------------------------------------------

describe('Codex slug and cwd matching (corpus-driven)', () => {
  it('the project key is the corpus cwd through the production path, and equals the recorded wire corpus', async () => {
    // The wire corpus is an INDEPENDENT witness: `scripts/record-wire.mjs`
    // recorded it from this corpus through the shipped host, so comparing to
    // it pins the key by value without this file writing the slug down.
    const wire = JSON.parse(
      await readFile(join(REPO_ROOT, 'webview', 'wire', `${CODEX_CORPUS_NAME}-session-arc.json`), 'utf8'),
    ) as { recordedFrom: string; final: { sessions: { projectSlug: string }[] } };

    const run = CODEX_RUNS.find((name) => wire.recordedFrom.includes(`/${name}/`));
    expect(run, `no run of ${CODEX_CORPUS_NAME} matches recordedFrom '${wire.recordedFrom}'`,
    ).toBeTypeOf('string');

    const cwd = await corpusCwdOf(run as string);
    const result = await codexEngineOk({ root: codexRunRoot(run as string) });

    // Every thread in the run declares that one cwd, so the key is a fact
    // about the run rather than about whichever thread happened to be first.
    expect([...new Set(result.threads.map((t) => t.cwd))]).toEqual([cwd]);

    const slug = slugifyWorkspace(cwd);
    expect(result.sessions.length).toBeGreaterThan(0);
    expect([...new Set(result.sessions.map((s) => s.projectSlug))]).toEqual([slug]);
    expect([...new Set(wire.final.sessions.map((s) => s.projectSlug))]).toEqual([slug]);
  }, 60_000);

  it('one workspace, four spellings: case and separator match, the WSL mount form does not', async () => {
    const run = CODEX_RUNS[0] as string;
    const root = codexRunRoot(run);
    const cwd = await corpusCwdOf(run);

    // Every spelling is DERIVED from the captured cwd, so none of them is a
    // second copy of it that could drift.
    const driveLower = cwd.charAt(0).toLowerCase() + cwd.slice(1);
    const forwardSlashes = cwd.replace(/\\/g, '/');
    const wslMount = `/mnt/${cwd.charAt(0).toLowerCase()}${cwd.slice(2).replace(/\\/g, '/')}`;
    const foreign = join(tmpdir(), 'agent-deck-not-the-codex-workspace');

    expect(driveLower).not.toBe(cwd);
    expect(forwardSlashes).not.toBe(cwd);
    expect(wslMount.startsWith('/mnt/')).toBe(true);

    const unfiltered = await codexEngineOk({ root });
    expect(unfiltered.sessions.length).toBeGreaterThan(0);

    const flagsFor = async (folder: string): Promise<boolean[]> => {
      const result = await codexEngineOk({ root, workspaceFolders: [folder] });
      // A non-matching session is FLAGGED, never dropped: the count must not
      // move, or this test would be reading a filter as a mismatch.
      expect(result.sessions.length, folder).toBe(unfiltered.sessions.length);
      return result.sessions.map((s) => s.workspaceMatch);
    };

    const all = (flags: boolean[]): boolean => flags.length > 0 && flags.every((f) => f);
    const none = (flags: boolean[]): boolean => flags.length > 0 && flags.every((f) => !f);

    expect(all(await flagsFor(cwd))).toBe(true);
    expect(all(await flagsFor(driveLower))).toBe(true);
    expect(all(await flagsFor(forwardSlashes))).toBe(true);
    expect(none(await flagsFor(wslMount))).toBe(true);
    expect(none(await flagsFor(foreign))).toBe(true);

    // And the boundary itself, stated as the rule rather than as an outcome:
    // the two spellings of one physical directory are not case variants.
    expect(sameWorkspace(cwd, driveLower)).toBe(true);
    expect(sameWorkspace(cwd, forwardSlashes)).toBe(true);
    expect(sameWorkspace(cwd, wslMount)).toBe(false);
    expect(normalizeSlug(slugifyWorkspace(cwd))).not.toBe(
      normalizeSlug(slugifyWorkspace(wslMount)),
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The probe, bundled once and executed as a child process on each platform
// ---------------------------------------------------------------------------

let BUNDLE_DIR: string;
let BUNDLE: string;
const CASES_PATH = join(MATRIX_DIR, 'slug-cases.json');

/** Bundle the probe so a Node process — either platform's — can execute it. */
async function bundleProbe(outDir: string): Promise<string> {
  const outfile = join(outDir, 'pathmatrix.probe.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./pathmatrix.probe.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return outfile;
}

beforeAll(async () => {
  BUNDLE_DIR = await mkdtemp(join(tmpdir(), 'agent-deck-pathmatrix-bundle-'));
  BUNDLE = await bundleProbe(BUNDLE_DIR);
}, 120_000);

afterAll(async () => {
  await rm(BUNDLE_DIR, { recursive: true, force: true });
});

/** Run the probe in a native child process, optionally with a faked home. */
function runNativeProbe(envOverrides: Record<string, string> = {}): ProbeReport {
  const stdout = execFileSync(
    process.execPath,
    [BUNDLE, '--agent-deck-path-probe', CASES_PATH],
    {
      encoding: 'utf8',
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as ProbeReport;
}

/**
 * The Codex half of a probe report, asserted the same way on both platforms.
 *
 * Every expected path is BUILT from the report's own separator and the roots
 * the report named, so this runs unchanged under Windows and under Linux and a
 * difference between the legs is a real difference rather than two assertion
 * lists drifting apart.
 *
 * The three precedence rows are distinguished by the FILENAME each tree holds.
 * A precedence test whose trees hold interchangeable content cannot fail: it
 * would pass with the precedence reversed, because both answers are non-empty.
 */
function assertCodexProbeSection(report: ProbeReport): void {
  const codex = report.codex;
  const sep = report.pathSeparator;
  const j = (...parts: string[]): string => parts.join(sep);
  const dayParts = codex.plantedDay.split('/');
  const planted = [codex.planted.home, codex.planted.codexHome, codex.planted.explicit];

  expect(codex.homeVariable).toBe(report.platform === 'win32' ? 'USERPROFILE' : 'HOME');
  expect(codex.decoyVariable).toBe(report.platform === 'win32' ? 'HOME' : 'USERPROFILE');
  expect(codex.homeVariable).not.toBe(codex.decoyVariable);
  expect(new Set(planted).size, 'the three trees must be distinguishable by filename').toBe(3);
  // Never today's: a walk that composed YYYY/MM/DD from a clock finds nothing.
  expect(codex.plantedDay).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);

  const populated = [
    codex.fromHome,
    codex.fromCodexHome,
    codex.explicitBeatsBoth,
    codex.blankCodexHomeFallsBackToHome,
  ];
  for (const row of populated) {
    expect(row.rootExists).toBe(true);
    expect(row.root.endsWith(`${sep}.codex`)).toBe(true);
    expect(row.lockDir).toBe(j(row.root, 'thread-writer-locks'));
    expect(row.days).toEqual([codex.plantedDay]);
    expect(row.files).toHaveLength(1);
    // Right extension, wrong prefix: the walk reports transcripts, not files.
    expect(row.files).not.toContain('notes.jsonl');
    expect(row.paths).toEqual([j(row.root, 'sessions', ...dayParts, row.files[0] as string)]);
  }

  expect(codex.fromHome.rootSource).toBe('homedir');
  expect(codex.fromHome.files).toEqual([codex.planted.home]);

  expect(codex.fromCodexHome.rootSource).toBe('CODEX_HOME');
  expect(codex.fromCodexHome.files).toEqual([codex.planted.codexHome]);
  expect(codex.fromCodexHome.root).not.toBe(codex.fromHome.root);

  expect(codex.explicitBeatsBoth.rootSource).toBe('explicit');
  expect(codex.explicitBeatsBoth.files).toEqual([codex.planted.explicit]);
  expect(codex.explicitBeatsBoth.root).not.toBe(codex.fromHome.root);
  expect(codex.explicitBeatsBoth.root).not.toBe(codex.fromCodexHome.root);

  // Whitespace is how a shell spells "I cleared this".
  expect(codex.blankCodexHomeFallsBackToHome.rootSource).toBe('homedir');
  expect(codex.blankCodexHomeFallsBackToHome.root).toBe(codex.fromHome.root);
  expect(codex.blankCodexHomeFallsBackToHome.files).toEqual([codex.planted.home]);

  // The decoy row is resolution-ONLY, and its shape says so: no `rootExists`
  // means no walk happened, which is how it can name the machine's real home
  // without enumerating a live session tree.
  expect('rootExists' in codex.decoyAlone).toBe(false);
  expect(codex.decoyAlone.rootSource).toBe('homedir');
  expect(codex.decoyAlone.root).toBe(j(report.homedir, '.codex'));
  expect(codex.decoyAlone.root).not.toBe(j(codex.decoyAlone.decoyValue, '.codex'));

  // Absent, empty and file-at-the-path are THREE different answers.
  expect(codex.absentRoot.rootExists).toBe(false);
  expect(codex.absentRoot.files).toEqual([]);
  expect(codex.absentRoot.root.endsWith(`${sep}.codex`)).toBe(true);
  expect(codex.absentRoot.lockDir).toBe(j(codex.absentRoot.root, 'thread-writer-locks'));

  expect(codex.emptyRoot.rootExists).toBe(true);
  expect(codex.emptyRoot.files).toEqual([]);
  expect(codex.emptyRoot.days).toEqual([]);

  expect(codex.fileAtRootPath.rootExists).toBe(false);
  expect(codex.fileAtRootPath.files).toEqual([]);

  // All three planted roots are distinct directories, so no row above was
  // reading another row's tree.
  const roots = new Set([
    codex.fromHome.root,
    codex.fromCodexHome.root,
    codex.explicitBeatsBoth.root,
    codex.absentRoot.root,
    codex.emptyRoot.root,
    codex.fileAtRootPath.root,
  ]);
  expect(roots.size).toBe(6);
}

describe('native leg: the same probe the WSL leg runs, in a child process', () => {
  it('resolves, discovers, matches case variants and refuses without a root', () => {
    const report = runNativeProbe();

    expect(report.platform).toBe(process.platform);
    expect(report.homedir).toBe(homedir());
    expect(report.rootFromHome).toEqual({
      root: join(homedir(), '.claude', 'projects'),
      source: 'home',
    });
    expect(report.rootFromOverride.source).toBe('env');
    expect(report.pathSeparator).toBe(process.platform === 'win32' ? '\\' : '/');

    for (const slugCase of SLUG_CASES) {
      const row = report.slugs.find((s) => s.id === slugCase.id);
      expect(row?.slug, slugCase.id).toBe(slugCase.expectedSlug);
    }

    expect(report.discovery.workspacePath).toBe(nativeProbeWorkspace(process.platform));
    expect(report.discovery.slugMatch).toBe('exact');
    expect(report.discovery.rootSource).toBe('env');
    expect(report.discovery.sessionIds).toEqual(['4299490e-4a09-46a0-a544-7ffb0429e7e7']);
    expect(report.discovery.subagentIds).toEqual(['a1a53f42c5eca8824']);

    expect(report.caseInsensitiveMatch.ran).toBe(true);
    expect(report.caseInsensitiveMatch.outcome).toBe('matched');
    expect(report.caseInsensitiveMatch.slugOnDisk).toBe(report.caseInsensitiveMatch.onDisk?.[0]);
    expect(report.caseInsensitiveMatch.slugOnDisk).not.toBe(report.discovery.requestedSlug);

    // The child process has a real environment, so the probe's own negative
    // control (it fakes BOTH home variables internally) is live here.
    expect(report.negativeControl.ok).toBe(false);
    expect(report.negativeControl.kind).toBe('projectsRootNotFound');
    expect(report.negativeControl.code).toBe('ENOENT');
    expect(report.negativeControl.path).toBe(report.negativeControl.expectedPath);
    expect(report.negativeControl.path).not.toBe(join(homedir(), '.claude', 'projects'));

    if (process.platform === 'win32') {
      // NTFS cannot hold two directories differing only by case, so the
      // ambiguity refusal has no end-to-end leg here. Its logic is covered on
      // every platform by the selectSlugDirectory tests above, and end-to-end
      // by the WSL leg below.
      expect(report.tempFilesystemCaseSensitive).toBe(false);
      expect(report.ambiguousSlug.ran).toBe(false);
      expect(report.ambiguousSlug.reason).toContain('case-insensitive filesystem');
    } else {
      expect(report.tempFilesystemCaseSensitive).toBe(true);
      expect(report.ambiguousSlug.outcome).toBe('ambiguousSlug');
      expect(report.ambiguousSlug.code).toBe('EAMBIGUOUS');
      expect(report.exactBeatsCaseVariant.outcome).toBe('exact');
    }
  });

  it('with BOTH HOME and USERPROFILE faked, the projects root moves to the fake and resolution fails ENOENT there', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agent-deck-negctl-child-'));
    try {
      const report = runNativeProbe({ HOME: temp, USERPROFILE: temp });

      expect(report.homedir).toBe(temp);
      expect(report.rootFromHome).toEqual({
        root: join(temp, '.claude', 'projects'),
        source: 'home',
      });
      expect(report.negativeControl.kind).toBe('projectsRootNotFound');
      expect(report.negativeControl.code).toBe('ENOENT');
      // G1: nothing was created under the faked home, and the real one was
      // never the path that got looked at.
      expect(report.rootFromHome.root).not.toBe(join(homedir(), '.claude', 'projects'));
      expect(await readdir(temp)).toEqual([]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('resolves the CODEX data root through all three sources, and tells absent from empty', () => {
    const report = runNativeProbe();

    expect(report.platform).toBe(process.platform);
    assertCodexProbeSection(report);

    // The decoy row, restated against this process's own homedir rather than
    // against the report's, so the two have to agree.
    expect(report.codex.decoyAlone.root).toBe(join(homedir(), '.codex'));
    expect(report.codex.homeVariable).toBe(CODEX_HOME_FALLBACK_VAR);
    expect(report.codex.decoyVariable).toBe(CODEX_DECOY_VAR);
  });

  it('with ONLY HOME faked, Windows does NOT move — the trap that produced a false pass in this repo', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agent-deck-homeonly-'));
    try {
      const report = runNativeProbe({ HOME: temp });
      if (process.platform === 'win32') {
        // os.homedir() reads USERPROFILE here: the fake is ignored and the
        // control would have run against the machine's real ~/.claude.
        expect(report.homedir).toBe(homedir());
        expect(report.homedir).not.toBe(temp);
      } else {
        expect(report.homedir).toBe(temp);
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Leg 2 — WSL
// ---------------------------------------------------------------------------

interface WslAvailability {
  usable: boolean;
  reason: string;
  linuxNode?: string;
}

const LINUX_NODE_CANDIDATES = [
  // A distro-installed Node, if the machine ever grows one.
  'node',
  // The unpacked tarball this leg was measured against. Ubuntu 24.04 ships no
  // Node, and nothing in a checkout provides one, which is why this leg
  // announces its skip instead of quietly reporting coverage.
  '$HOME/.local/opt/node-v24.19.0-linux-x64/bin/node',
];

/**
 * Run a command inside the default distro.
 *
 * `--exec`, not `--`: with `--` wsl.exe hands the joined command line to bash,
 * which re-splits it, so an argument containing a space or a parenthesis
 * arrives as several words and the call fails in a way that reads like "WSL is
 * broken". `--exec` passes the argv through. Measured both ways.
 */
function wsl(args: readonly string[]): string {
  return execFileSync('wsl.exe', ['--exec', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

/**
 * Windows paths reach `wslpath` with their backslashes stripped — measured:
 * `wslpath -u C:\Users\dev\projects` receives `C:Usersdevprojects`. Forward
 * slashes survive and `wslpath` accepts them, so the argument is converted and
 * the assertion stays on the fixture's literal backslash spelling.
 */
function forWslpath(windowsPath: string): string {
  return windowsPath.replace(/\\/g, '/');
}

function detectWsl(): WslAvailability {
  if (process.platform !== 'win32') {
    return { usable: false, reason: `host platform is ${process.platform}, not win32` };
  }
  try {
    wsl(['true']);
  } catch (error) {
    return { usable: false, reason: `wsl.exe is not usable: ${String(error).split('\n')[0]}` };
  }
  const override = process.env['AGENT_DECK_WSL_NODE'];
  for (const candidate of override === undefined ? LINUX_NODE_CANDIDATES : [override]) {
    try {
      // `command -v` resolves PATH entries and expands $HOME; the result is an
      // absolute path we can exec without a shell.
      const resolved = wsl(['sh', '-c', `command -v "${candidate}"`]);
      if (resolved === '') continue;
      // WSL's PATH includes the Windows one, so a candidate can resolve to a
      // Windows binary through interop. Only a Linux Node counts as the leg.
      const platform = wsl([resolved, '-e', 'process.stdout.write(process.platform)']);
      if (platform === 'linux') return { usable: true, reason: '', linuxNode: resolved };
    } catch {
      // try the next candidate
    }
  }
  return {
    usable: false,
    reason:
      'WSL is present but has no Linux Node. Restore it with:\n' +
      "  wsl.exe -- bash -lc 'mkdir -p ~/.local/opt && cd ~/.local/opt && " +
      'curl -sSLO https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz && ' +
      "tar xf node-v24.19.0-linux-x64.tar.xz'\n" +
      '  or point AGENT_DECK_WSL_NODE at any Linux node binary.',
  };
}

const WSL = detectWsl();

if (!WSL.usable) {
  // Loud, once, with the reason. A silent skip reports as coverage.
  process.stderr.write(
    `\n[pathmatrix] WSL LEG SKIPPED — ${WSL.reason}\n` +
      '[pathmatrix] Set AGENT_DECK_REQUIRE_WSL=1 to make this a failure instead.\n\n',
  );
}

describe('WSL availability', () => {
  it('is either usable, or explicitly not required', () => {
    if (process.env['AGENT_DECK_REQUIRE_WSL'] === '1') {
      expect(WSL.usable, `AGENT_DECK_REQUIRE_WSL=1 but: ${WSL.reason}`).toBe(true);
    } else if (WSL.usable) {
      expect(WSL.linuxNode).toMatch(/node/);
    } else {
      // A skip with no stated reason is the failure mode this guards against.
      expect(WSL.reason.length).toBeGreaterThan(20);
    }
  });
});

describe.skipIf(!WSL.usable)('WSL leg: this repo\u2019s resolution code under real Linux Node', () => {
  it(
    'resolves $HOME/.claude/projects, encodes the same slugs, and refuses an ambiguous slug on a case-sensitive filesystem',
    () => {
      const linuxNode = WSL.linuxNode as string;
      const claudeBefore = wsl([
        'sh',
        '-c',
        'test -d "$HOME/.claude" && echo present || echo absent',
      ]);

      {
        const bundleLinux = wsl(['wslpath', '-u', forWslpath(BUNDLE)]);
        const casesLinux = wsl(['wslpath', '-u', forWslpath(CASES_PATH)]);

        const raw = wsl([linuxNode, bundleLinux, '--agent-deck-path-probe', casesLinux]);
        const report = JSON.parse(raw) as ProbeReport;

        // --- environment ------------------------------------------------
        expect(report.platform).toBe('linux');
        expect(report.pathSeparator).toBe('/');
        expect(report.env.WSL_DISTRO_NAME).toBe(MEASURED.wsl.distro);
        // The recorded home is REDACTED (README.md -> Privacy), so the identity
        // check runs on the digest, not the literal: same strength as the
        // string equality it replaces, without the account name in the file.
        expect(report.homedir).toMatch(new RegExp(MEASURED.wsl.homeShape));
        expect(sha256(report.homedir)).toBe(MEASURED.wsl.homeSha256);
        expect(report.rootFromHome).toEqual({
          root: `${report.homedir}/.claude/projects`,
          source: 'home',
        });
        // ... and the redacted spelling of the live root is the recorded one,
        // so the fixture is still checked against the machine end to end.
        expect(redactWslHome(report.rootFromHome.root, report.homedir)).toBe(
          MEASURED.probeLinux.rootFromHome.root,
        );
        expect(report.rootFromOverride.source).toBe('env');

        // --- slug encoding is identical to the Windows leg ---------------
        for (const slugCase of SLUG_CASES) {
          const row = report.slugs.find((s) => s.id === slugCase.id);
          expect(row?.slug, slugCase.id).toBe(slugCase.expectedSlug);
        }

        // --- discovery under posix paths ---------------------------------
        expect(report.discovery.workspacePath).toBe('/mnt/c/Users/Probe/ws');
        expect(report.discovery.requestedSlug).toBe('-mnt-c-Users-Probe-ws');
        expect(report.discovery.slugMatch).toBe('exact');
        expect(report.discovery.sessionIds).toEqual(['4299490e-4a09-46a0-a544-7ffb0429e7e7']);
        expect(report.discovery.subagentIds).toEqual(['a1a53f42c5eca8824']);

        // --- case-sensitive filesystem behaviour -------------------------
        expect(report.tempFilesystemCaseSensitive).toBe(true);
        expect(report.caseInsensitiveMatch.outcome).toBe('matched');
        expect(report.ambiguousSlug.ran).toBe(true);
        expect(report.ambiguousSlug.outcome).toBe('ambiguousSlug');
        expect(report.ambiguousSlug.code).toBe('EAMBIGUOUS');
        expect(report.ambiguousSlug.onDisk?.length).toBe(2);
        expect(report.exactBeatsCaseVariant.outcome).toBe('exact');

        // --- negative control, inside WSL --------------------------------
        expect(report.negativeControl.ok).toBe(false);
        expect(report.negativeControl.kind).toBe('projectsRootNotFound');
        expect(report.negativeControl.code).toBe('ENOENT');
        expect(report.negativeControl.path).toBe(report.negativeControl.expectedPath);
        expect(report.negativeControl.path.startsWith('/tmp/')).toBe(true);

        // --- the recorded measurement still holds ------------------------
        expect(report.platform).toBe(MEASURED.probeLinux.platform);
        expect(sha256(report.homedir)).toBe(MEASURED.probeLinux.homedirSha256);
        expect(report.ambiguousSlug.outcome).toBe(MEASURED.probeLinux.ambiguousOutcome);

        // --- G1: WSL's own ~/.claude is exactly as we found it -----------
        const claudeAfter = wsl([
          'sh',
          '-c',
          'test -d "$HOME/.claude" && echo present || echo absent',
        ]);
        expect(claudeAfter).toBe(claudeBefore);
        expect(claudeAfter).toBe(MEASURED.wsl.claudeDirectoryPresent ? 'present' : 'absent');
      }
    },
    180_000,
  );

  it(
    'the CODEX data root under real Linux Node: $HOME/.codex, CODEX_HOME, and the USERPROFILE decoy that must not move it',
    () => {
      const linuxNode = WSL.linuxNode as string;
      const bundleLinux = wsl(['wslpath', '-u', forWslpath(BUNDLE)]);
      const casesLinux = wsl(['wslpath', '-u', forWslpath(CASES_PATH)]);
      const report = JSON.parse(
        wsl([linuxNode, bundleLinux, '--agent-deck-path-probe', casesLinux]),
      ) as ProbeReport;

      expect(report.platform).toBe('linux');
      expect(report.pathSeparator).toBe('/');
      assertCodexProbeSection(report);

      // The half that is genuinely different from the Windows leg: on POSIX
      // the home variable is HOME and USERPROFILE is the decoy — the exact
      // reverse of the native leg, from the same probe source.
      expect(report.codex.homeVariable).toBe('HOME');
      expect(report.codex.decoyVariable).toBe('USERPROFILE');
      expect(report.codex.decoyAlone.root).toBe(`${report.homedir}/.codex`);
      expect(report.codex.decoyAlone.root.includes('\\')).toBe(false);

      // Every planted root is a posix path under the distro's temp dir, so
      // nothing here read the distro's own ~/.codex.
      for (const root of [
        report.codex.fromHome.root,
        report.codex.fromCodexHome.root,
        report.codex.explicitBeatsBoth.root,
      ]) {
        expect(root.startsWith('/tmp/')).toBe(true);
        expect(root.startsWith(`${report.homedir}/`)).toBe(false);
      }
    },
    180_000,
  );

  it('wslpath still reports the mount translation the fixture recorded', () => {
    const { windowsWorkspace, wslMountForm, neutralLinuxPath, windowsFormOfNeutralLinuxPath } =
      MEASURED.wsl.wslpath;
    expect(wsl(['wslpath', '-u', forWslpath(windowsWorkspace)])).toBe(wslMountForm);
    // The Linux -> UNC direction is pinned on a path that carries no account
    // name. `wslpath -w` is pure string translation and never stats, so an
    // absent /home/probe measures the same rule the real home did.
    expect(wsl(['wslpath', '-w', neutralLinuxPath])).toBe(windowsFormOfNeutralLinuxPath);
    expect(wsl(['sh', '-c', 'test -e /home/probe && echo present || echo absent'])).toBe('absent');
  });

  it('the UNC spelling of the REAL home matches the digest and the recorded shape, without naming the account', () => {
    const home = wsl(['sh', '-c', 'echo "$HOME"']);
    const unc = wsl(['wslpath', '-w', home]);
    // Identity of the machine: digests, not literals.
    expect(sha256(home)).toBe(MEASURED.wsl.homeSha256);
    expect(sha256(unc)).toBe(MEASURED.wsl.wslpath.windowsFormOfLinuxHomeSha256);
    // The rule itself, derived from the live values rather than compared to a
    // stored literal: \\wsl.localhost\<distro>\<the same path, backslashed>.
    expect(unc).toBe(`\\\\wsl.localhost\\${MEASURED.wsl.distro}${home.replace(/\//g, '\\')}`);
    // And the redacted spelling of both is exactly what the fixture stores.
    expect(redactWslHome(home, home)).toBe(MEASURED.wsl.wslpath.linuxHome);
    expect(unc.replace(home.replace(/\//g, '\\'), '\\home\\<redacted-user>')).toBe(
      MEASURED.wsl.wslpath.windowsFormOfLinuxHome,
    );
  });
});

// ---------------------------------------------------------------------------
// The recorded measurement — asserted whether or not WSL is reachable
// ---------------------------------------------------------------------------

describe('recorded WSL measurement (runs with or without WSL)', () => {
  it('records what it is: measured, not synthetic', () => {
    expect(MEASURED.provenance).toMatch(/MEASURED/);
    expect(MEASURED.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('agrees with this repo\u2019s live encoding for both spellings of the workspace', () => {
    expect(slugifyWorkspace(MEASURED.wsl.wslpath.windowsWorkspace)).toBe(MEASURED.slugs.windows);
    expect(slugifyWorkspace(MEASURED.wsl.wslpath.wslMountForm)).toBe(MEASURED.slugs.wslMount);
    expect(MEASURED.slugs.windows === MEASURED.slugs.wslMount).toBe(MEASURED.slugs.identical);
    expect(MEASURED.slugs.identical).toBe(false);
  });

  it('records the Linux projects root as $HOME/.claude/projects', () => {
    expect(MEASURED.probeLinux.rootFromHome).toEqual({
      root: `${MEASURED.wsl.home}/.claude/projects`,
      source: 'home',
    });
    expect(MEASURED.probeLinux.platform).toBe('linux');
    expect(MEASURED.probeLinux.pathSeparator).toBe('/');
    expect(MEASURED.probeLinux.tempFilesystemCaseSensitive).toBe(true);
    expect(MEASURED.probeLinux.ambiguousOutcome).toBe('ambiguousSlug');
    expect(MEASURED.probeLinux.ambiguousCode).toBe('EAMBIGUOUS');
    expect(MEASURED.probeLinux.exactBeatsCaseVariantOutcome).toBe('exact');
    expect(MEASURED.probeLinux.negativeControlKind).toBe('projectsRootNotFound');
    expect(MEASURED.probeLinux.negativeControlCode).toBe('ENOENT');
  });

  it('records that no Claude Code has ever run inside this WSL, so the Linux slug is OUR encoding and not a CC witness', () => {
    // The honest boundary of the WSL leg: CC never wrote a projects tree in
    // the distro, so nothing here claims CC-on-Linux was observed.
    expect(MEASURED.wsl.claudeDirectoryPresent).toBe(false);
    const posixCases = SLUG_CASES.filter((c) => c.form === 'posix' || c.form === 'wslMount');
    expect(posixCases.length).toBeGreaterThan(0);
    for (const c of posixCases) {
      expect(c.witness).toBe('encoding-rule');
    }
  });
});

// ---------------------------------------------------------------------------
// Privacy — the sweep, executable
// ---------------------------------------------------------------------------

/**
 * This directory introduced two path SHAPES the repo had not carried before: a
 * POSIX home (`/home/<user>`) and a WSL UNC (`\\wsl.localhost\<distro>\home\<user>`).
 * A privacy sweep grepping `C:\Users\dev` or `projects` matches neither, so
 * it would return clean while both sat in the tree — the same failure
 * `fixtures/hook-events/` already has from the other direction, where the paths
 * are backslash-separated and a forward-slash grep finds nothing.
 *
 * The patterns below are the ones README.md's privacy section publishes for
 * Phase 5, in executable form, because prose nobody runs is how a sweep
 * silently returns clean. Each carries a positive control (it must match a
 * known-bad sample) and a presence control (it must still match something real
 * in the fixtures), so a pattern that rots into matching nothing fails loudly
 * instead of reporting coverage.
 */
describe('privacy sweep over fixtures/synthetic-path-matrix', () => {
  /** Runs of backslashes collapse so one pattern covers both raw and JSON-escaped text. */
  const flatten = (text: string): string => text.replace(/\\+/g, '\\');

  /**
   * The account segment of a real path: the separator is `/` or `\`, so a dash
   * is part of the name (`<redacted-user>` has one).
   */
  const ACCOUNT = '[A-Za-z0-9._<>-]+';
  /**
   * The account segment of a SLUG: the dash is the separator there, so
   * including it would swallow the rest of the slug and the allow-list check
   * would compare the wrong string.
   */
  const SLUG_ACCOUNT = '[A-Za-z0-9._<>]+';

  interface Category {
    readonly id: string;
    readonly pattern: RegExp;
    /** Index of the capture group holding the account name. */
    readonly account: number;
    readonly allowed: readonly string[];
    /** A string this pattern MUST match, or the sweep proves nothing. */
    readonly positiveControl: string;
    readonly mustAppearIn: readonly string[];
    readonly why: string;
  }

  const CATEGORIES: readonly Category[] = [
    {
      id: 'posix-home',
      pattern: new RegExp(`/home/(${ACCOUNT})`, 'g'),
      account: 1,
      // `<user>` is the placeholder README.md uses when it names the shape;
      // the other two are the redaction token and the neutral fixture account.
      allowed: ['<redacted-user>', 'probe', '<user>'],
      positiveControl: '/home/exampleuser/agent-deck',
      mustAppearIn: ['slug-cases.json', 'wsl-environment.measured.json', 'README.md'],
      why: 'new category: a POSIX home path, invisible to any Windows-path sweep',
    },
    {
      id: 'slug-posix-home',
      pattern: new RegExp(`-home-(${SLUG_ACCOUNT})`, 'g'),
      account: 1,
      allowed: ['probe'],
      positiveControl: '-home-exampleuser-agent-deck',
      mustAppearIn: ['slug-cases.json'],
      why: 'the same path after slug encoding, where the separators are gone',
    },
    {
      id: 'unc-wsl',
      pattern: new RegExp(`\\\\wsl\\.localhost\\\\([^\\\\]+)\\\\home\\\\(${ACCOUNT})`, 'g'),
      account: 2,
      allowed: ['<redacted-user>', 'probe', '<user>'],
      positiveControl: '\\\\wsl.localhost\\Ubuntu\\home\\exampleuser',
      mustAppearIn: ['slug-cases.json', 'wsl-environment.measured.json'],
      why: 'new category: the UNC spelling Windows uses for a WSL-side path',
    },
    {
      id: 'slug-unc-wsl',
      pattern: new RegExp(`--wsl\\.localhost-([A-Za-z0-9._]+)-home-(${SLUG_ACCOUNT})`, 'g'),
      account: 2,
      allowed: ['probe'],
      positiveControl: '--wsl.localhost-Ubuntu-home-exampleuser-agent-deck',
      mustAppearIn: ['slug-cases.json'],
      why: 'the UNC form after slug encoding',
    },
    {
      id: 'windows-user',
      pattern: new RegExp(`[A-Za-z]:[\\\\/]+Users[\\\\/]+(${ACCOUNT})`, 'g'),
      account: 1,
      allowed: ['dev', 'Probe'],
      positiveControl: 'C:\\Users\\exampleuser\\ws',
      mustAppearIn: ['slug-cases.json', 'wsl-environment.measured.json', 'README.md'],
      why: 'the pre-existing category, RETAINED deliberately: CC wrote this name into the captured slug directory',
    },
    {
      id: 'wsl-mount-user',
      pattern: new RegExp(`/mnt/[A-Za-z]/Users/(${ACCOUNT})`, 'g'),
      account: 1,
      allowed: ['dev', 'Probe'],
      positiveControl: '/mnt/c/Users/exampleuser/ws',
      mustAppearIn: ['slug-cases.json', 'wsl-environment.measured.json', 'README.md'],
      why: 'the Windows account name reached through the WSL mount - a forward-slash spelling a backslash sweep misses',
    },
    {
      id: 'slug-wsl-mount-user',
      pattern: new RegExp(`-mnt-[A-Za-z]-Users-(${SLUG_ACCOUNT})`, 'g'),
      account: 1,
      allowed: ['dev', 'Probe'],
      positiveControl: '-mnt-c-Users-exampleuser-ws',
      mustAppearIn: ['slug-cases.json', 'wsl-environment.measured.json'],
      why: 'the mount form after slug encoding',
    },
  ];

  let files: { name: string; text: string }[] = [];

  beforeAll(async () => {
    const names = (await readdir(MATRIX_DIR, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name);
    files = await Promise.all(
      names.map(async (name) => ({
        name,
        text: flatten(await readFile(join(MATRIX_DIR, name), 'utf8')),
      })),
    );
  });

  for (const category of CATEGORIES) {
    it(`${category.id}: matches its control, and every hit in the directory is on the allow-list`, () => {
      // Positive control: a pattern that has stopped matching finds nothing and
      // looks like a pass.
      const control = new RegExp(category.pattern.source, 'g').exec(
        flatten(category.positiveControl),
      );
      expect(control, `${category.id} pattern no longer matches its own control`).not.toBeNull();

      const seen = new Map<string, string[]>();
      for (const file of files) {
        const re = new RegExp(category.pattern.source, 'g');
        let match: RegExpExecArray | null;
        while ((match = re.exec(file.text)) !== null) {
          const account = match[category.account] ?? '';
          const where = seen.get(account) ?? [];
          if (!where.includes(file.name)) where.push(file.name);
          seen.set(account, where);
        }
      }

      for (const [account, where] of seen) {
        expect(
          category.allowed,
          `${category.id}: account "${account}" in ${where.join(', ')} — ${category.why}`,
        ).toContain(account);
      }

      // Presence control: the pattern must still be finding the real thing.
      for (const name of category.mustAppearIn) {
        const re = new RegExp(category.pattern.source, 'g');
        const file = files.find((f) => f.name === name);
        expect(file, `${name} is missing from ${MATRIX_DIR}`).toBeDefined();
        expect(
          re.test(file?.text ?? ''),
          `${category.id} found nothing in ${name}: the pattern has rotted, or the fixture changed shape`,
        ).toBe(true);
      }
    });
  }

  it('every file in the directory is covered by the sweep, so a new file cannot arrive unswept', () => {
    const known = ['README.md', 'slug-cases.json', 'wsl-environment.measured.json'];
    const names = files.map((f) => f.name).sort();
    expect(
      names,
      'a new file landed in fixtures/synthetic-path-matrix: extend the privacy section of its README and the mustAppearIn lists above before committing it',
    ).toEqual(known.sort());
  });

  it.skipIf(!WSL.usable)(
    'the neutral account names are not the machine\u2019s real one',
    () => {
      const home = wsl(['sh', '-c', 'echo "$HOME"']);
      const account = home.slice(home.lastIndexOf('/') + 1);
      expect(account.length).toBeGreaterThan(0);
      // If the distro's account were literally "probe", the allow-list above
      // would be permitting the real name.
      expect(account).not.toBe('probe');
      expect(account).not.toBe('<redacted-user>');
      for (const file of files) {
        expect(
          file.text.includes(`/home/${account}`),
          `${file.name} contains the live WSL account name in POSIX form`,
        ).toBe(false);
        expect(
          file.text.includes(`\\home\\${account}`),
          `${file.name} contains the live WSL account name in UNC form`,
        ).toBe(false);
        expect(
          file.text.includes(`-home-${account}`),
          `${file.name} contains the live WSL account name in slug form`,
        ).toBe(false);
      }
    },
    60_000,
  );

  it('the measured fixture says what it destroyed, what it kept, and why the Windows side differs', () => {
    expect(MEASURED.redaction.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(MEASURED.redaction.destroyed).toMatch(/account name/i);
    expect(MEASURED.redaction.kept).toMatch(/sha256/i);
    expect(MEASURED.redaction.whyNotTheWindowsSide).toMatch(/cc-capture|witness/i);
    // The digest is a stability pin, not protection, and the file must not
    // claim otherwise.
    expect(MEASURED.redaction.notASecret).toMatch(/not protection|low-entropy/i);
    expect(MEASURED.wsl.home).toBe(REDACTED_WSL_HOME);
    expect(MEASURED.probeLinux.homedir).toBe(REDACTED_WSL_HOME);
    expect(MEASURED.wsl.homeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(MEASURED.wsl.wslpath.windowsFormOfLinuxHomeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(MEASURED.wsl.homeSha256).not.toBe(MEASURED.wsl.wslpath.windowsFormOfLinuxHomeSha256);
  });

  it('the README publishes the patterns rather than describing them', async () => {
    const readme = await readFile(join(MATRIX_DIR, 'README.md'), 'utf8');
    expect(readme).toMatch(/## Privacy/);
    // Each category id is named in the README, so a reader can map a hit here
    // back to the prose and vice versa.
    for (const category of CATEGORIES) {
      expect(readme, `README.md does not mention the ${category.id} pattern`).toContain(
        category.id,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The probe is a harness, not production
// ---------------------------------------------------------------------------

describe('pathmatrix.probe.ts', () => {
  it('is imported by this test and by nothing that ships', async () => {
    const importers: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (entry.name === 'pathmatrix.probe.ts' || entry.name === 'pathmatrix.test.ts') continue;
        const text = await readFile(full, 'utf8');
        if (text.includes('pathmatrix.probe')) importers.push(full);
      }
    };
    await walk(join(REPO_ROOT, 'src'));
    await walk(join(REPO_ROOT, 'webview'));
    expect(importers).toEqual([]);
  });
});
