/**
 * `src/opencode/fingerprint.ts` — PLAN.md Phase 4 DoD 4.2.
 *
 * Shaped after `src/parser/corpus.test.ts`, for the same reason: the anchor's
 * whole meaning is "the release whose fixture proved the schema", so it is
 * asserted against the corpus on disk rather than against itself. Moving
 * `PINNED_OPENCODE_VERSION` without harvesting fails here.
 *
 * Every mutated schema is built in a temp directory from a committed corpus,
 * per test, through `synthetic.ts` — which refuses to open anything under
 * `fixtures/` for write. Nothing here mutates a fixture and nothing here
 * writes inside the repo.
 *
 * Each refusal code is asserted individually. A test that only checked
 * "something was rejected" would keep passing while a mutation was rejected
 * for the wrong reason, which is the failure mode this file exists to prevent.
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { OPENCODE_DB_FILENAME, readSchema, readSessions } from './db.js';
import {
  OC_VERSION_WINDOW,
  PINNED_OPENCODE_VERSION,
  REQUIRED_COLUMNS,
  REQUIRED_TABLES,
  fingerprintDatabase,
  fingerprintSchema,
  fingerprintSessionVersion,
  isOpencodeVersionAccepted,
  opencodeVersionWindow,
  parseOpencodeVersion,
  partitionSessionsByVersion,
} from './fingerprint.js';
import type { OcSchemaReport } from './fingerprint.js';
import { copyCorpus, corpusDbPath, listCorpora, makeTempDir, withWritableDb } from './synthetic.js';
import type { OcSessionRow } from './types.js';

const CORPORA = listCorpora();

/** The anchor's corpus directory name, derived from the constant. */
const ANCHOR_CORPUS = `opencode-${PINNED_OPENCODE_VERSION}`;

const SMALLEST = [...CORPORA].sort(
  (a, b) => statSync(corpusDbPath(a)).size - statSync(corpusDbPath(b)).size,
)[0] as string;

const tempDirs: string[] = [];

/** A writable copy of the smallest corpus, mutated by `mutate`. */
function mutatedCopy(mutate: (sql: (statement: string) => void) => void): string {
  const dir = makeTempDir('agent-deck-oc-fp-');
  tempDirs.push(dir);
  const dbPath = copyCorpus(SMALLEST, dir);
  withWritableDb(dbPath, (db) => {
    mutate((statement) => db.exec(statement));
  });
  return dbPath;
}

function reportOf(dbPath: string): OcSchemaReport {
  const outcome = fingerprintDatabase(dbPath);
  if (outcome.kind !== 'ok') {
    throw new Error(
      `expected ok, got ${outcome.kind}: ${
        outcome.kind === 'schemaMismatch' ? outcome.mismatch.reason : outcome.health.message
      }`,
    );
  }
  return outcome.report;
}

function sessionsOf(dbPath: string): readonly OcSessionRow[] {
  const read = readSessions(dbPath);
  if (!read.ok) throw new Error(`${read.health.code}: ${read.health.message}`);
  return read.value;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The provenance anchor
// ---------------------------------------------------------------------------

describe('the anchor is a corpus, not a number in a file', () => {
  it('PINNED_OPENCODE_VERSION names a fixture directory that exists and carries opencode.db', () => {
    expect(CORPORA, `no fixtures/${ANCHOR_CORPUS}/ for the anchor`).toContain(ANCHOR_CORPUS);
    expect(existsSync(corpusDbPath(ANCHOR_CORPUS))).toBe(true);
    expect(statSync(corpusDbPath(ANCHOR_CORPUS)).size).toBeGreaterThan(0);
  });

  it('every session row in the anchor corpus carries the anchor version', () => {
    const versions = new Set(sessionsOf(corpusDbPath(ANCHOR_CORPUS)).map((s) => s.version));
    expect([...versions]).toEqual([PINNED_OPENCODE_VERSION]);
  });

  it.each(CORPORA)('%s: the schema passes and every session is in window', (corpus) => {
    const report = reportOf(corpusDbPath(corpus));
    expect(report.tables).toEqual(REQUIRED_TABLES);
    const sessions = sessionsOf(corpusDbPath(corpus));
    expect(sessions.length).toBeGreaterThan(0);
    const { accepted, refused } = partitionSessionsByVersion(sessions);
    expect(refused).toEqual([]);
    expect(accepted).toHaveLength(sessions.length);
  });

  it('the witness corpus is a DIFFERENT version and still renders', () => {
    // The vacuity control on the window: if every corpus carried the anchor's
    // own version, "in window" would be proving nothing but equality.
    const versions = new Set<string>();
    for (const corpus of CORPORA) {
      for (const session of sessionsOf(corpusDbPath(corpus))) versions.add(session.version);
    }
    expect(versions.size).toBeGreaterThan(1);
    for (const version of versions) expect(isOpencodeVersionAccepted(version)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The version window (G9, mirrored)
// ---------------------------------------------------------------------------

describe('the version window is derived from the anchor, and the patch is not compared', () => {
  it('derives both endpoints from the anchor and the allowance', () => {
    const anchor = parseOpencodeVersion(PINNED_OPENCODE_VERSION);
    expect(anchor).toBeDefined();
    const window = opencodeVersionWindow();
    expect(window?.major).toBe(anchor?.major);
    expect(window?.minMinor).toBe((anchor?.minor ?? 0) - OC_VERSION_WINDOW.minor);
    expect(window?.maxMinor).toBe((anchor?.minor ?? 0) + OC_VERSION_WINDOW.minor);
    // The label carries an `x` in the patch position because it is not compared.
    expect(window?.label).toBe(
      `${anchor?.major}.${(anchor?.minor ?? 0) - 1}.x - ${anchor?.major}.${(anchor?.minor ?? 0) + 1}.x`,
    );
  });

  it('clamps the floor at minor 0 rather than going negative', () => {
    expect(opencodeVersionWindow('1.0.0')?.minMinor).toBe(0);
  });

  it('accepts any patch at all, in either direction', () => {
    const anchor = parseOpencodeVersion(PINNED_OPENCODE_VERSION);
    const at = (patch: number): string => `${anchor?.major}.${anchor?.minor}.${patch}`;
    expect(isOpencodeVersionAccepted(at(0))).toBe(true);
    expect(isOpencodeVersionAccepted(at(999_999))).toBe(true);
    expect(isOpencodeVersionAccepted(at((anchor?.patch ?? 0) + 500))).toBe(true);
  });

  it('accepts one minor step either side and refuses two', () => {
    const anchor = parseOpencodeVersion(PINNED_OPENCODE_VERSION);
    const minor = (offset: number): string => `${anchor?.major}.${(anchor?.minor ?? 0) + offset}.0`;
    expect(isOpencodeVersionAccepted(minor(-1))).toBe(true);
    expect(isOpencodeVersionAccepted(minor(0))).toBe(true);
    expect(isOpencodeVersionAccepted(minor(1))).toBe(true);
    expect(isOpencodeVersionAccepted(minor(-2))).toBe(false);
    expect(isOpencodeVersionAccepted(minor(2))).toBe(false);
  });

  it('refuses a different major line outright', () => {
    const anchor = parseOpencodeVersion(PINNED_OPENCODE_VERSION);
    expect(isOpencodeVersionAccepted(`${(anchor?.major ?? 0) + 1}.${anchor?.minor}.${anchor?.patch}`)).toBe(
      false,
    );
    expect(isOpencodeVersionAccepted(`0.${anchor?.minor}.${anchor?.patch}`)).toBe(false);
  });

  it('does not parse anything that is not <major>.<minor>.<patch>', () => {
    for (const value of ['', '1.18', '1.18.22-beta', 'v1.18.22', '01.18.22', '1.18.22.1', 'nightly']) {
      expect(parseOpencodeVersion(value), value).toBeUndefined();
      expect(isOpencodeVersionAccepted(value), value).toBe(false);
    }
  });

  it('an unparseable anchor accepts only itself, verbatim', () => {
    expect(opencodeVersionWindow('nightly')).toBeUndefined();
    expect(isOpencodeVersionAccepted('nightly', 'nightly')).toBe(true);
    expect(isOpencodeVersionAccepted('1.18.22', 'nightly')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-session refusal
// ---------------------------------------------------------------------------

describe('a version refusal is about ONE session', () => {
  it('accepts an in-window session by returning undefined', () => {
    expect(fingerprintSessionVersion({ id: 'ses_a', version: PINNED_OPENCODE_VERSION })).toBeUndefined();
  });

  it('refuses an out-of-window session with unsupportedVersion', () => {
    const anchor = parseOpencodeVersion(PINNED_OPENCODE_VERSION);
    const version = `${anchor?.major}.${(anchor?.minor ?? 0) + 2}.0`;
    const refusal = fingerprintSessionVersion({ id: 'ses_a', version });
    expect(refusal?.kind).toBe('schemaMismatch');
    expect(refusal?.code).toBe('unsupportedVersion');
    expect(refusal?.sessionId).toBe('ses_a');
    expect(refusal?.at).toBe('ses_a');
    expect(refusal?.observedVersion).toBe(version);
    expect(refusal?.expected).toBe(opencodeVersionWindow()?.label);
  });

  it('refuses an unparseable version with a DIFFERENT code', () => {
    const refusal = fingerprintSessionVersion({ id: 'ses_b', version: 'nightly-2026-08-27' });
    expect(refusal?.code).toBe('unparseableVersion');
    expect(refusal?.observedVersion).toBe('nightly-2026-08-27');
    // The two codes are not interchangeable: an unrecognised string is a
    // different story from a recognised one that is too far away.
    expect(refusal?.code).not.toBe('unsupportedVersion');
  });

  it('splits a mixed list into rendered and parked, keeping order', () => {
    const rows = ([
      { id: 'ses_1', version: PINNED_OPENCODE_VERSION },
      { id: 'ses_2', version: '1.20.0' },
      { id: 'ses_3', version: '1.18.21' },
      { id: 'ses_4', version: 'nightly' },
    ] as unknown[]) as OcSessionRow[];
    const { accepted, refused } = partitionSessionsByVersion(rows);
    expect(accepted.map((s) => s.id)).toEqual(['ses_1', 'ses_3']);
    expect(refused.map((r) => r.sessionId)).toEqual(['ses_2', 'ses_4']);
    expect(refused.map((r) => r.code)).toEqual(['unsupportedVersion', 'unparseableVersion']);
    expect(accepted.length + refused.length).toBe(rows.length);
  });
});

// ---------------------------------------------------------------------------
// A mixed-version DATABASE, built from a corpus
// ---------------------------------------------------------------------------

describe('a mixed-version database renders what it can and parks the rest', () => {
  it('parks only the rows whose version was moved out of the window', () => {
    const dbPath = mutatedCopy((sql) => {
      sql("UPDATE session SET version = '1.20.0' WHERE id IN (SELECT id FROM session ORDER BY id LIMIT 2)");
    });
    const sessions = sessionsOf(dbPath);
    const movedIds = sessions.filter((s) => s.version === '1.20.0').map((s) => s.id);
    expect(movedIds.length).toBe(2);

    const { accepted, refused } = partitionSessionsByVersion(sessions);
    expect(refused.map((r) => r.sessionId).sort()).toEqual([...movedIds].sort());
    expect(refused.every((r) => r.code === 'unsupportedVersion')).toBe(true);
    expect(accepted.length).toBe(sessions.length - movedIds.length);
    expect(accepted.length).toBeGreaterThan(0);
    // The schema is untouched, so the DATABASE is fine: the refusal is per row.
    expect(fingerprintDatabase(dbPath).kind).toBe('ok');
  });

  it('parks an unparseable version the same way, with its own code', () => {
    const dbPath = mutatedCopy((sql) => {
      sql("UPDATE session SET version = 'nightly' WHERE id = (SELECT id FROM session ORDER BY id LIMIT 1)");
    });
    const { refused } = partitionSessionsByVersion(sessionsOf(dbPath));
    expect(refused).toHaveLength(1);
    expect(refused[0]?.code).toBe('unparseableVersion');
    expect(refused[0]?.observedVersion).toBe('nightly');
  });
});

// ---------------------------------------------------------------------------
// The structural half — mutated schemas
// ---------------------------------------------------------------------------

describe('a mutated schema refuses the whole database, with a stable code', () => {
  it('the unmutated copy passes — the control', () => {
    const dbPath = mutatedCopy(() => {
      /* no mutation at all */
    });
    expect(fingerprintDatabase(dbPath).kind).toBe('ok');
  });

  it('a renamed required table is missingTable, naming the table', () => {
    const dbPath = mutatedCopy((sql) => {
      sql('ALTER TABLE session RENAME TO session_renamed');
    });
    const outcome = fingerprintDatabase(dbPath);
    expect(outcome.kind).toBe('schemaMismatch');
    if (outcome.kind !== 'schemaMismatch') return;
    expect(outcome.mismatch.code).toBe('missingTable');
    expect(outcome.mismatch.at).toBe('session');
    expect(outcome.mismatch.reason).toContain('session');
  });

  it('a dropped required column is missingColumn, naming table.column', () => {
    const dbPath = mutatedCopy((sql) => {
      sql('ALTER TABLE part DROP COLUMN time_updated');
    });
    const outcome = fingerprintDatabase(dbPath);
    expect(outcome.kind).toBe('schemaMismatch');
    if (outcome.kind !== 'schemaMismatch') return;
    expect(outcome.mismatch.code).toBe('missingColumn');
    expect(outcome.mismatch.at).toBe('part.time_updated');
    expect(outcome.mismatch.expected).toBe('time_updated');
  });

  it('a required column nothing reads yet still refuses when it is dropped', () => {
    // `session.tokens_cache_read` is in the fingerprint target (contract §3)
    // and is deliberately NOT selected by `db.ts` — `OcSessionRow` has no
    // field for it. Asserted, not read: dropping it must still refuse.
    const dbPath = mutatedCopy((sql) => {
      sql('ALTER TABLE session DROP COLUMN tokens_cache_read');
    });
    const outcome = fingerprintDatabase(dbPath);
    expect(outcome.kind).toBe('schemaMismatch');
    if (outcome.kind !== 'schemaMismatch') return;
    expect(outcome.mismatch.code).toBe('missingColumn');
    expect(outcome.mismatch.at).toBe('session.tokens_cache_read');
    // And the rows still read fine, which is what makes this a fingerprint
    // assertion rather than an accessor failure.
    expect(sessionsOf(dbPath).length).toBeGreaterThan(0);
  });

  it('a database-level refusal refuses EVERY session, not one', () => {
    const dbPath = mutatedCopy((sql) => {
      sql('ALTER TABLE event_sequence RENAME TO event_sequence_old');
    });
    const outcome = fingerprintDatabase(dbPath);
    expect(outcome.kind).toBe('schemaMismatch');
    // There is no per-session arm to fall back to: the outcome carries no
    // session id at all, which is how the caller knows to refuse everything.
    if (outcome.kind === 'schemaMismatch') expect(outcome.mismatch.at).toBe('event_sequence');
  });

  it('a database that will not open is DEGRADED, not a schema mismatch', () => {
    const dir = makeTempDir('agent-deck-oc-fp-');
    tempDirs.push(dir);
    const outcome = fingerprintDatabase(join(dir, OPENCODE_DB_FILENAME));
    expect(outcome.kind).toBe('degraded');
    if (outcome.kind === 'degraded') expect(outcome.health.code).toBe('databaseMissing');
  });

  it('the table names are derived from the column table, never restated', () => {
    expect(REQUIRED_TABLES).toEqual([...REQUIRED_COLUMNS.keys()]);
    expect(REQUIRED_TABLES).toHaveLength(6);
  });

  it('is case-insensitive about identifiers, as SQLite is', () => {
    const schema = { tables: new Map<string, readonly string[]>() };
    for (const [table, columns] of REQUIRED_COLUMNS) {
      schema.tables.set(
        table.toUpperCase(),
        columns.map((c) => c.toUpperCase()),
      );
    }
    const result = fingerprintSchema(schema);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown tables and columns: ignored, and counted
// ---------------------------------------------------------------------------

describe('what the engine does not read is ignored and counted', () => {
  it.each(CORPORA)('%s: counts the tables and columns it does not read', (corpus) => {
    const report = reportOf(corpusDbPath(corpus));
    // Both corpora carry tables the engine never reads (`todo`, `workspace`,
    // `migration`, ...) and unread columns on `session` and `project`.
    expect(report.unknownTableCount).toBeGreaterThan(0);
    expect(report.unknownColumnCount).toBeGreaterThan(0);
    expect(report.unknownTables).toHaveLength(report.unknownTableCount);
    expect(report.unknownColumns).toHaveLength(report.unknownColumnCount);
    for (const table of REQUIRED_TABLES) expect(report.unknownTables).not.toContain(table);
    for (const entry of report.unknownColumns) expect(entry).toContain('.');
  });

  it('a table OpenCode adds tomorrow is counted, and changes nothing else', () => {
    const before = reportOf(corpusDbPath(SMALLEST));
    const dbPath = mutatedCopy((sql) => {
      sql('CREATE TABLE zzz_new_in_a_future_release (id text PRIMARY KEY, payload text)');
    });
    const after = reportOf(dbPath);
    expect(after.unknownTableCount).toBe(before.unknownTableCount + 1);
    expect(after.unknownTables).toContain('zzz_new_in_a_future_release');
    expect(after.tables).toEqual(before.tables);
  });

  it('a column OpenCode adds to a table we read is counted, not refused', () => {
    const before = reportOf(corpusDbPath(SMALLEST));
    const dbPath = mutatedCopy((sql) => {
      sql('ALTER TABLE session ADD COLUMN zzz_new_column text');
    });
    const after = reportOf(dbPath);
    expect(after.unknownColumnCount).toBe(before.unknownColumnCount + 1);
    expect(after.unknownColumns).toContain('session.zzz_new_column');
    // And every session still reads and is still accepted.
    const { refused } = partitionSessionsByVersion(sessionsOf(dbPath));
    expect(refused).toEqual([]);
  });

  it('reads the schema through db.ts, and only through db.ts', () => {
    // `fingerprintSchema` is pure — it takes a schema, not a path — so the
    // module has exactly one filesystem reach, and it is the accessor's.
    const read = readSchema(corpusDbPath(SMALLEST));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const direct = fingerprintSchema(read.value);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.value).toEqual(reportOf(corpusDbPath(SMALLEST)));
  });
});
