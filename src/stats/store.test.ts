/**
 * The local store — v0.7.0 Phase 3, DoD 3.1, 3.2, 3.3, 3.4 and the store half
 * of 3.5.
 *
 * Every test here uses a real directory under the OS temp and removes it, and
 * every clock is faked. Nothing in `store.ts` reads a clock — `derivedAt` is
 * the caller's stamp — so "faked clock" here means the tests choose the
 * instants, which is what makes the retention and supersede cases writable at
 * all.
 *
 * ## The subject of DoD 3.1 is a PATH, so the test is about paths
 *
 * `resolveStoreDir` is a two-line function and the temptation is to assert its
 * output equals a `join` of its input, which is the function restated. What
 * the DoD asks for is different and stronger: the resolved directory is under
 * `globalStorageUri` and under NONE of the places G1 forbids writing. That is
 * a claim about the relationship between one path and six others, and it is
 * the claim a reviewer of a read-only extension actually wants.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveCodexRoot } from '../codex/index.js';
import { opencodeDataDir } from '../opencode/index.js';
import { resolveProjectsRoot } from '../parser/tailer.js';

import { CORPUS_READ_BUDGET_MS, readCcSessions, warmCorpus } from './corpus.testkit.js';
import { deriveStats } from './derive.js';
import { MS_PER_DAY, storeFileName } from './retention.js';
import type { StatsRecord } from './schema.js';
import { STATS_SCHEMA_VERSION, validateStatsRecord } from './schema.js';
import {
  STORE_DIR_NAME,
  StatsStore,
  WRITE_FAILURE_LIMIT,
  resolveStoreDir,
} from './store.js';
import type { StoredStatsRecord } from './store.js';

// ---------------------------------------------------------------------------
// Scratch directories, created and removed
// ---------------------------------------------------------------------------

const scratch: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-deck-store-'));
  scratch.push(dir);
  return dir;
}

afterAll(() => {
  // DoD 1c.5 — a full run leaves no scratch directory behind. The global
  // teardown counts them by SHAPE, so a leak here fails the whole run rather
  // than accumulating quietly, which is exactly what it is for.
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A store over a fresh directory. `dir` is returned so tests can inspect it. */
function storeIn(
  overrides: { enabled?: boolean; retentionDays?: number } = {},
): { store: StatsStore; dir: string; errors: unknown[] } {
  const dir = join(tempDir(), STORE_DIR_NAME);
  const errors: unknown[] = [];
  const store = new StatsStore({
    dir,
    enabled: overrides.enabled ?? true,
    retentionDays: overrides.retentionDays ?? 90,
    onError: (error) => errors.push(error),
  });
  return { store, dir, errors };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

const AT = Date.parse('2026-09-08T13:00:00.000Z');

/**
 * A minimal record that VALIDATES.
 *
 * Hand-built for the volume cases, and asserted against `validateStatsRecord`
 * in its own test below rather than assumed: a fixture that quietly stopped
 * validating would turn every append test into a test of the refusal path,
 * which is the shape where a suite goes green while measuring the opposite of
 * what it claims.
 */
function record(sessionId: string, derivedAt: number): StoredStatsRecord {
  return {
    statsSchemaVersion: STATS_SCHEMA_VERSION,
    sessionId,
    engine: 'cc',
    projectSlug: 'c--ws-example',
    startedAt: AT - 1_000,
    endedAt: AT,
    coverage: 'full',
    agents: [],
    files: [],
    tools: [],
    loops: [],
    churn: [],
    contextChurn: [],
    compactions: [],
    stalls: [],
    totals: {
      prompt: 10,
      output: 5,
      compactions: 0,
      subagents: 0,
      silentSubagents: 0,
      stalls: 0,
    },
    params: { loopMin: 3 },
    unavailable: [],
    derivedAt,
  };
}

/** One REAL record, derived from the committed Claude Code corpus. */
let realRecord: StatsRecord;

beforeAll(async () => {
  await warmCorpus();
  const states = await readCcSessions();
  // The richest session available, so the verbatim-write test below is over a
  // record with populated tables rather than over an empty shell.
  const richest = [...states].sort(
    (a, b) => JSON.stringify(b).length - JSON.stringify(a).length,
  )[0];
  expect(richest, 'no Claude Code session to derive a real record from').toBeDefined();
  realRecord = deriveStats(richest as (typeof states)[number]);
}, CORPUS_READ_BUDGET_MS);

// ---------------------------------------------------------------------------
// DoD 3.1 — the path law
// ---------------------------------------------------------------------------

describe('DoD 3.1: the store directory is under globalStorage and nowhere else', () => {
  /**
   * `a` contains `b`, comparing whole path SEGMENTS.
   *
   * A raw `startsWith` is wrong in both directions here: it would report
   * `/home/user/.claudex` as being under `/home/user/.claude`, and on Windows
   * it is case-sensitive against a filesystem that is not. Both would produce a
   * confident wrong answer on the one test whose whole job is to be right about
   * containment.
   */
  function contains(parent: string, child: string): boolean {
    const norm = (p: string): string[] =>
      resolve(p)
        .toLowerCase()
        .split(sep)
        .filter((s) => s !== '');
    const a = norm(parent);
    const b = norm(child);
    if (b.length < a.length) return false;
    return a.every((segment, i) => b[i] === segment);
  }

  it('the containment helper is right about the cases that would fool startsWith', () => {
    // The control on the control. Everything below rests on `contains`, so a
    // helper that answered `true` for everything would make the whole block
    // vacuous — the recorded "a check whose subject never happens" shape.
    const home = resolve('/home/user');
    expect(contains(home, join(home, 'a', 'b'))).toBe(true);
    expect(contains(home, home)).toBe(true);
    expect(contains(home, resolve('/home/userx'))).toBe(false);
    expect(contains(resolve('/home/user/.claude'), resolve('/home/user/.claudex'))).toBe(false);
    expect(contains(join(home, 'a'), home)).toBe(false);
  });

  it('resolves under the context globalStorageUri, in a named subdirectory', () => {
    const base = tempDir();
    const dir = resolveStoreDir({ globalStorageUri: { fsPath: base } });
    expect(contains(base, dir)).toBe(true);
    expect(dir).toBe(join(base, STORE_DIR_NAME));
    // A subdirectory rather than the root itself, so a later artefact of a
    // different kind is a sibling instead of something the retention sweep has
    // to be taught to leave alone.
    expect(dir).not.toBe(base);
  });

  it('is under none of the observed engines directories, nor any workspace folder', () => {
    // The REAL resolved locations on this machine, read through the engines'
    // own resolvers rather than spelled out — a hard-coded `~/.claude` would
    // pass on a machine where the engine reads somewhere else, which is the
    // fail-open direction.
    const workspace = resolve(process.cwd());
    const forbidden: { name: string; path: string }[] = [
      { name: 'Claude Code projects root', path: resolveProjectsRoot().root },
      { name: 'Claude Code home', path: join(homedir(), '.claude') },
      { name: 'Codex root', path: resolveCodexRoot().root },
      { name: 'Codex home', path: join(homedir(), '.codex') },
      { name: 'OpenCode data', path: opencodeDataDir() },
      // Not exported by the engine because nothing reads it — the engine only
      // ever opens the DATA directory. G1 covers it anyway (spec OC1 amendment
      // B), so the path law states it, spelled the way the spec spells it.
      { name: 'OpenCode config', path: join(homedir(), '.config', 'opencode') },
      { name: 'the workspace folder', path: workspace },
    ];

    // Two bases: the real per-user shape VS Code uses, and a temp one.
    const bases = [
      join(homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'nvitlam.agent-deck'),
      tempDir(),
    ];
    let checked = 0;
    for (const base of bases) {
      const dir = resolveStoreDir({ globalStorageUri: { fsPath: base } });
      for (const entry of forbidden) {
        expect(contains(entry.path, dir), `store dir is under ${entry.name}: ${dir}`).toBe(false);
        checked += 1;
      }
    }
    // Vacuity: an empty `forbidden` list would pass the loop above silently.
    expect(checked).toBe(bases.length * forbidden.length);
  });

  it('CODEX_HOME relocates the Codex root, and the store is outside that too', () => {
    // `CODEX_HOME` relocates the ENTIRE Codex surface, so a path law that only
    // knew about `~/.codex` would be checking a directory the user is not
    // using. Driven through the engine's own resolver with the variable set.
    const relocated = tempDir();
    const codexRoot = resolveCodexRoot({ env: { CODEX_HOME: relocated } }).root;
    expect(codexRoot).toBe(relocated);
    const dir = resolveStoreDir({ globalStorageUri: { fsPath: tempDir() } });
    expect(contains(codexRoot, dir)).toBe(false);
    // The control: a store resolved INSIDE that root would be caught. This is
    // what proves the assertion above can fail.
    const bad = resolveStoreDir({ globalStorageUri: { fsPath: join(relocated, 'nope') } });
    expect(contains(codexRoot, bad)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DoD 3.2 — append-only JSONL
// ---------------------------------------------------------------------------

describe('DoD 3.2: append-only JSONL, one file per ISO week', () => {
  it('the hand-built fixture record validates — this file is not testing refusals', () => {
    const validation = validateStatsRecord(record('s1', AT));
    expect(validation.errors).toStrictEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('writes one line per record, into the file named for its ISO week', () => {
    const { store, dir } = storeIn();
    store.appendRecord(record('s1', AT));
    store.appendRecord(record('s2', AT));
    expect(store.appended).toBe(2);
    expect(store.files()).toStrictEqual([storeFileName(AT)]);
    const text = readFileSync(join(dir, storeFileName(AT)), 'utf8');
    expect(text.split('\n').filter((l) => l !== '')).toHaveLength(2);
    // The file ends with a newline, so the next append starts a whole line
    // rather than joining the previous one. A store whose last line has no
    // terminator corrupts the record after it.
    expect(text.endsWith('\n')).toBe(true);
  });

  it('records derived in different weeks land in different files', () => {
    const { store } = storeIn({ retentionDays: 3_650 });
    store.appendRecord(record('s1', AT));
    store.appendRecord(record('s2', AT - 21 * MS_PER_DAY));
    expect(store.files()).toStrictEqual(
      [storeFileName(AT), storeFileName(AT - 21 * MS_PER_DAY)].sort(),
    );
  });

  it('THE ON-DISK LINE EQUALS THE RECORD IT WAS GIVEN — the store adds no field', () => {
    /*
     * The redaction note for this phase, stated as a test: "records leaving
     * the deriver are already allow-listed; the store writes them verbatim and
     * never adds a field."
     *
     * G4's provenance proof (`redaction.test.ts`) is a proof about what
     * `deriveStats` produces. It is worth nothing if the layer that puts those
     * records on disk decorates them, so the equality below is what carries
     * that proof across the boundary — and it is taken over a REAL record from
     * the committed corpus, with populated tables and real identifiers, not
     * over the minimal fixture.
     */
    const { store, dir } = storeIn();
    const stored: StoredStatsRecord = { ...realRecord, derivedAt: AT };
    store.appendRecord(stored);

    const line = readFileSync(join(dir, storeFileName(AT)), 'utf8').trimEnd();
    const parsed = JSON.parse(line) as unknown;
    expect(parsed).toStrictEqual(stored);
    // And the line is the validated record, not merely an equal one: what was
    // written passes the same validator the reader applies.
    expect(validateStatsRecord(parsed).ok).toBe(true);
    // No key the caller did not supply.
    expect(Object.keys(parsed as object).sort()).toStrictEqual(Object.keys(stored).sort());
    // Exactly one line: a record is one line, whatever it contains.
    expect(readFileSync(join(dir, storeFileName(AT)), 'utf8').split('\n')).toHaveLength(2);
  });

  it('reads the newest record per session, newest first', () => {
    const { store } = storeIn({ retentionDays: 3_650 });
    store.appendRecord(record('a', AT - 2_000));
    store.appendRecord(record('b', AT - 1_000));
    store.appendRecord(record('a', AT)); // supersedes the first `a`
    const read = store.readRecords();
    expect(read.map((r) => r.sessionId)).toStrictEqual(['a', 'b']);
    expect(read[0]?.derivedAt).toBe(AT);
    // Nothing was rewritten: the superseded line is still on disk.
    expect(store.appended).toBe(3);
  });

  it('honours sinceMs and limit', () => {
    const { store } = storeIn({ retentionDays: 3_650 });
    store.appendRecord(record('a', AT - 3_000));
    store.appendRecord(record('b', AT - 2_000));
    store.appendRecord(record('c', AT - 1_000));
    expect(store.readRecords({ sinceMs: AT - 2_000 }).map((r) => r.sessionId)).toStrictEqual([
      'c',
      'b',
    ]);
    expect(store.readRecords({ limit: 1 }).map((r) => r.sessionId)).toStrictEqual(['c']);
    expect(store.readRecords({ limit: 0 })).toStrictEqual([]);
  });

  it('a truncated line is counted and skipped, and the rest still read', () => {
    const { store, dir } = storeIn();
    store.appendRecord(record('good1', AT));
    // A crash mid-append: half a record, no newline of its own. Written
    // BETWEEN two good lines so the test proves reading continues past it
    // rather than merely surviving it at the end of the file.
    const whole = JSON.stringify(record('truncated', AT));
    writeFileSync(join(dir, storeFileName(AT)), `${whole.slice(0, whole.length - 40)}\n`, {
      flag: 'a',
    });
    store.appendRecord(record('good2', AT));

    const read = store.readRecords();
    expect(read.map((r) => r.sessionId).sort()).toStrictEqual(['good1', 'good2']);
    expect(store.malformed).toBe(1);
    expect(store.lastMalformedReason).toContain('not JSON');
  });

  it('a non-JSON line is counted and skipped', () => {
    const { store, dir } = storeIn();
    store.appendRecord(record('good', AT));
    writeFileSync(join(dir, storeFileName(AT)), 'this is not json at all\n', { flag: 'a' });
    expect(store.readRecords().map((r) => r.sessionId)).toStrictEqual(['good']);
    expect(store.malformed).toBe(1);
  });

  it('a line that parses but is not a record is counted and skipped', () => {
    // The half that matters as much as the truncation case: a line written by
    // a future schema version parses perfectly and is still not something this
    // build may hand to a reader.
    const { store, dir } = storeIn();
    store.appendRecord(record('good', AT));
    const future = { ...record('future', AT), statsSchemaVersion: 99 };
    const noStamp = { ...record('nostamp', AT) } as Record<string, unknown>;
    delete noStamp['derivedAt'];
    writeFileSync(
      join(dir, storeFileName(AT)),
      `${JSON.stringify(future)}\n${JSON.stringify(noStamp)}\n[]\n`,
      { flag: 'a' },
    );
    expect(store.readRecords().map((r) => r.sessionId)).toStrictEqual(['good']);
    expect(store.malformed).toBe(3);
  });

  it('refuses to WRITE a record that does not validate, and says so', () => {
    const { store, dir, errors } = storeIn();
    const bad = { ...record('bad', AT), engine: 'nope' } as unknown as StoredStatsRecord;
    store.appendRecord(bad);
    expect(store.appended).toBe(0);
    expect(store.refused).toBe(1);
    expect(errors).toHaveLength(1);
    // Nothing was created: a refused record must not leave an empty file
    // behind that looks like a week with no sessions.
    expect(store.files()).toStrictEqual([]);
    expect(() => statSync(dir)).toThrow();
  });

  it('refuses a record whose derivedAt is not a finite number', () => {
    const { store } = storeIn();
    for (const stamp of [Number.NaN, Number.POSITIVE_INFINITY]) {
      store.appendRecord({ ...record('s', AT), derivedAt: stamp });
    }
    const missing = { ...record('s', AT) } as Record<string, unknown>;
    delete missing['derivedAt'];
    store.appendRecord(missing as unknown as StoredStatsRecord);
    expect(store.appended).toBe(0);
    expect(store.refused).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// DoD 3.3 — retention through real files
// ---------------------------------------------------------------------------

describe('DoD 3.3: retention prunes on write, on a faked clock', () => {
  it('deletes the aged-out weekly files and keeps the rest', () => {
    const { store, dir } = storeIn({ retentionDays: 90 });
    // Seed three weeks by hand at the file level, so the seeding cannot itself
    // be pruned by the appends that follow.
    mkdirSync(dir, { recursive: true });
    for (const offset of [400, 100, 30]) {
      const at = AT - offset * MS_PER_DAY;
      writeFileSync(join(dir, storeFileName(at)), `${JSON.stringify(record(`s${String(offset)}`, at))}\n`);
    }
    expect(store.files()).toHaveLength(3);

    // One append at `AT` is what triggers the sweep.
    store.appendRecord(record('now', AT));
    expect(store.files().sort()).toStrictEqual(
      [storeFileName(AT), storeFileName(AT - 30 * MS_PER_DAY)].sort(),
    );
    // And the surviving history really is readable, not just present.
    expect(store.readRecords().map((r) => r.sessionId).sort()).toStrictEqual(['now', 's30']);
  });

  it('a wide window prunes nothing — the deletion above is a decision', () => {
    const { store, dir } = storeIn({ retentionDays: 3_650 });
    mkdirSync(dir, { recursive: true });
    const old = AT - 400 * MS_PER_DAY;
    writeFileSync(join(dir, storeFileName(old)), `${JSON.stringify(record('old', old))}\n`);
    store.appendRecord(record('now', AT));
    expect(store.files()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// DoD 3.4 — disabled
// ---------------------------------------------------------------------------

describe('DoD 3.4: disabled means no file, no directory, no read', () => {
  it('appends nothing, reads nothing, and creates no directory', () => {
    const { store, dir } = storeIn({ enabled: false });
    store.appendRecord(record('s1', AT));
    store.appendRecord({ ...realRecord, derivedAt: AT });
    expect(store.appended).toBe(0);
    expect(store.refused).toBe(0);
    expect(store.readRecords()).toStrictEqual([]);
    expect(store.files()).toStrictEqual([]);
    // ZERO FILES means the directory was never made. `existsSync` would be the
    // weaker check; this is the one that fails if `mkdirSync` ran at all.
    expect(() => statSync(dir), 'the disabled store created its directory').toThrow();
  });

  it('does not read a history another window wrote', () => {
    // The half a "writes nothing" test misses: a disabled store must also stop
    // FEEDING anything, or the Trends view would render from a history the
    // user has switched off.
    const dir = join(tempDir(), STORE_DIR_NAME);
    const writer = new StatsStore({ dir, enabled: true, retentionDays: 90 });
    writer.appendRecord(record('s1', AT));
    expect(writer.readRecords()).toHaveLength(1);

    const reader = new StatsStore({ dir, enabled: false, retentionDays: 90 });
    expect(reader.readRecords()).toStrictEqual([]);
    expect(reader.files()).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DoD 3.5 — clear, at the store level. The modal is `extension.stats.test.ts`.
// ---------------------------------------------------------------------------

describe('DoD 3.5: clear removes the directory', () => {
  it('removes everything and leaves a store that still works', () => {
    const { store, dir } = storeIn();
    store.appendRecord(record('s1', AT));
    expect(store.readRecords()).toHaveLength(1);

    store.clear();
    expect(() => statSync(dir)).toThrow();
    expect(store.readRecords()).toStrictEqual([]);
    expect(store.files()).toStrictEqual([]);

    // Clearing is not disabling: the next record recreates the directory.
    store.appendRecord(record('s2', AT));
    expect(store.readRecords().map((r) => r.sessionId)).toStrictEqual(['s2']);
  });

  it('clearing a store that never wrote anything is a success, not an error', () => {
    const { store, errors } = storeIn();
    store.clear();
    expect(errors).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The failure path
// ---------------------------------------------------------------------------

describe('a store that cannot write stands down instead of retrying forever', () => {
  it('reports each failure, then stops, and says that it stopped', () => {
    // A path UNDER A FILE: `mkdir` is `ENOTDIR` on every platform, so this is
    // a guaranteed write failure that creates nothing anywhere.
    const base = tempDir();
    const file = join(base, 'not-a-directory');
    writeFileSync(file, 'x');
    const errors: unknown[] = [];
    const store = new StatsStore({
      dir: join(file, STORE_DIR_NAME),
      enabled: true,
      retentionDays: 90,
      onError: (error) => errors.push(error),
    });

    for (let i = 0; i < WRITE_FAILURE_LIMIT + 5; i += 1) {
      store.appendRecord(record(`s${String(i)}`, AT));
    }
    expect(store.appended).toBe(0);
    expect(store.stoodDown).toBe(true);
    // WRITE_FAILURE_LIMIT failures plus the one line announcing the stand-down,
    // and nothing after it: the attempts stop, so the reports do too.
    expect(errors).toHaveLength(WRITE_FAILURE_LIMIT + 1);
    expect(String(errors[errors.length - 1])).toContain('stood down');
  });
});
