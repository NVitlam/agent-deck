/**
 * `src/opencode/db.ts` — PLAN.md Phase 4 DoD 4.1.
 *
 * Three things are proved here, and they are different things:
 *
 *   1. The accessor reads the committed corpora through the production path,
 *      in the order the goldens depend on, with every integer narrowed from a
 *      BigInt rather than a float.
 *   2. **Nothing it does writes** (G1). The committed fixtures are never
 *      opened for write by anything in this file; every mutation is built in a
 *      fresh temp directory from a copy, per test, through `synthetic.ts` —
 *      which refuses a path inside `fixtures/` outright.
 *   3. Every failure mode DEGRADES rather than throwing (G3). Each degrade
 *      code is asserted individually: a test that only checked "something went
 *      wrong" would pass while the wrong thing went wrong.
 *
 * The hot-WAL pair is worth reading closely, because the measurement went
 * against the intuition the DoD was written with: a CLEAN hot WAL does not
 * degrade anything — SQLite reads it and hands back the uncheckpointed rows —
 * so the crash copy that degrades is one whose *database file* was torn
 * mid-write. Both are asserted, and the clean one asserts the WAL's contents
 * actually arrived, so it cannot pass by reading the base file.
 *
 * A `-wal` file's SIZE is never asserted anywhere here: it is not a write
 * indicator (4,181,832 bytes across 2 h 30 m of writes, measured).
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, describe, expect, it } from 'vitest';

import {
  OPENCODE_DB_FILENAME,
  opencodeDbPath,
  readDatabase,
  readEventSequences,
  readEvents,
  readMessages,
  readParts,
  readProjects,
  readSchema,
  readSessions,
} from './db.js';
import type { OcRead } from './db.js';
import {
  copyCorpus,
  corpusDbPath,
  listCorpora,
  makeTempDir,
  withWritableDb,
  writeNonDatabase,
  writeSyntheticWal,
} from './synthetic.js';

const CORPORA = listCorpora();

/**
 * The smallest committed corpus, chosen by measuring the files rather than by
 * naming one: the mutation tests do not need the anchor's 24 sessions, and a
 * name written here would decay on the next harvest.
 */
const SMALLEST = [...CORPORA].sort(
  (a, b) => statSync(corpusDbPath(a)).size - statSync(corpusDbPath(b)).size,
)[0] as string;

const tempDirs: string[] = [];

function scratch(): string {
  const dir = makeTempDir('agent-deck-oc-db-');
  tempDirs.push(dir);
  return dir;
}

/** A fresh, writable copy of the smallest corpus. Never the fixture itself. */
function copyOfSmallest(): { dir: string; dbPath: string } {
  const dir = scratch();
  return { dir, dbPath: copyCorpus(SMALLEST, dir) };
}

/**
 * A database TORN mid-file: the fixture's first 40,000 bytes and nothing else.
 *
 * Written directly rather than copied-then-truncated. Copying 5,763,072 bytes
 * to keep 40,000 of them is 99.3% waste, and it is not free: these suites run
 * concurrently with `src/perf/perf.test.ts`, whose `tailPoll` budget is
 * filesystem-bound. Measured during this phase — that budget read 7.1 ms with
 * the perf file run alone and 782.5 ms inside the full suite, against a 150 ms
 * limit, with the new OpenCode suites copying ~150 MB beside it. The budget was
 * not widened; the waste was removed.
 *
 * A prefix of a real database is exactly what a torn file is, so this is also a
 * more direct statement of what the test is about.
 */
function tornCopy(): { dir: string; dbPath: string } {
  const dir = scratch();
  const dbPath = join(dir, OPENCODE_DB_FILENAME);
  const fd = openSync(corpusDbPath(SMALLEST), 'r');
  try {
    const head = Buffer.alloc(40_000);
    const read = readSync(fd, head, 0, head.length, 0);
    writeFileSync(dbPath, head.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return { dir, dbPath };
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function unwrap<T>(read: OcRead<T>, what: string): T {
  if (!read.ok) throw new Error(`${what}: ${read.health.code} — ${read.health.message}`);
  return read.value;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The committed corpora, through the production path
// ---------------------------------------------------------------------------

describe('every committed corpus reads through the accessor', () => {
  it('there is at least one corpus to read (vacuity control)', () => {
    expect(CORPORA.length).toBeGreaterThan(0);
    for (const corpus of CORPORA) expect(existsSync(corpusDbPath(corpus))).toBe(true);
  });

  it.each(CORPORA)('%s: every required table comes back non-empty', (corpus) => {
    const snapshot = unwrap(
      readDatabase(corpusDbPath(corpus), { messages: true, events: true }),
      corpus,
    );
    expect(snapshot.projects.length).toBeGreaterThan(0);
    expect(snapshot.sessions.length).toBeGreaterThan(0);
    expect(snapshot.parts.length).toBeGreaterThan(0);
    expect(snapshot.eventSequences.length).toBeGreaterThan(0);
    expect(snapshot.messages?.length ?? 0).toBeGreaterThan(0);
    expect(snapshot.events?.length ?? 0).toBeGreaterThan(0);
    // Counts are derived from the corpus, never pinned: a hard-coded size
    // breaks on the next harvest and reads as a regression.
  });

  it.each(CORPORA)('%s: sessions and parts arrive ordered by time_created, id', (corpus) => {
    const snapshot = unwrap(readDatabase(corpusDbPath(corpus)), corpus);
    const ordered = <T extends { timeCreated: number; id: string }>(rows: readonly T[]): T[] =>
      [...rows].sort((a, b) => a.timeCreated - b.timeCreated || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(snapshot.sessions.map((s) => s.id)).toEqual(ordered(snapshot.sessions).map((s) => s.id));
    expect(snapshot.parts.map((p) => p.id)).toEqual(ordered(snapshot.parts).map((p) => p.id));
  });

  it.each(CORPORA)('%s: every integer is a safe integer, narrowed from BigInt', (corpus) => {
    const snapshot = unwrap(readDatabase(corpusDbPath(corpus), { events: true }), corpus);
    for (const session of snapshot.sessions) {
      expect(Number.isSafeInteger(session.timeCreated)).toBe(true);
      expect(Number.isSafeInteger(session.timeUpdated)).toBe(true);
      expect(Number.isSafeInteger(session.tokensInput)).toBe(true);
      expect(Number.isSafeInteger(session.tokensOutput)).toBe(true);
      expect(typeof session.cost).toBe('number');
      // A millisecond epoch, not a second one: proves the column was not
      // divided, defaulted, or read from the wrong place.
      expect(session.timeCreated).toBeGreaterThan(1_000_000_000_000);
    }
    for (const row of snapshot.eventSequences) expect(Number.isSafeInteger(row.seq)).toBe(true);
    for (const row of snapshot.events ?? []) expect(Number.isSafeInteger(row.seq)).toBe(true);
  });

  it.each(CORPORA)('%s: timestamps equal the stored BigInt exactly', (corpus) => {
    // The point of `setReadBigInts`: the value the accessor hands out is the
    // integer SQLite holds, not a float that happens to print the same.
    const sessions = unwrap(readSessions(corpusDbPath(corpus)), corpus);
    const db = new DatabaseSync(corpusDbPath(corpus), { readOnly: true });
    try {
      const statement = db.prepare('SELECT id, time_created FROM session ORDER BY id');
      statement.setReadBigInts(true);
      for (const row of statement.all()) {
        const id = row['id'] as string;
        const stored = row['time_created'] as bigint;
        const session = sessions.find((s) => s.id === id);
        expect(session, id).toBeDefined();
        expect(BigInt(session?.timeCreated ?? -1)).toBe(stored);
      }
    } finally {
      db.close();
    }
  });

  it.each(CORPORA)('%s: the schema reader sees the six required tables', (corpus) => {
    const schema = unwrap(readSchema(corpusDbPath(corpus)), corpus);
    for (const table of ['project', 'session', 'message', 'part', 'event', 'event_sequence']) {
      expect(schema.tables.has(table), `${corpus} ${table}`).toBe(true);
      expect((schema.tables.get(table) ?? []).length).toBeGreaterThan(0);
    }
  });

  it('`message` and `event` rows are opt-in, and `event.data` is opt-in again', () => {
    const path = corpusDbPath(SMALLEST);
    const bare = unwrap(readDatabase(path), 'bare');
    expect(bare.messages).toBeUndefined();
    expect(bare.events).toBeUndefined();

    const withTables = unwrap(readDatabase(path, { messages: true, events: true }), 'withTables');
    expect(withTables.messages?.length ?? 0).toBeGreaterThan(0);
    // Contract §6: the engine reads seq and type only from `event`.
    for (const event of withTables.events ?? []) expect(event.data).toBeUndefined();

    const withData = unwrap(
      readDatabase(path, { events: true, eventData: true }),
      'withData',
    );
    for (const event of withData.events ?? []) expect(typeof event.data).toBe('string');
  });

  it('the single-table readers agree with the one-open snapshot', () => {
    const path = corpusDbPath(SMALLEST);
    const snapshot = unwrap(readDatabase(path, { messages: true, events: true }), 'snapshot');
    expect(unwrap(readProjects(path), 'projects')).toEqual(snapshot.projects);
    expect(unwrap(readSessions(path), 'sessions')).toEqual(snapshot.sessions);
    expect(unwrap(readParts(path), 'parts')).toEqual(snapshot.parts);
    expect(unwrap(readMessages(path), 'messages')).toEqual(snapshot.messages);
    expect(unwrap(readEvents(path), 'events')).toEqual(snapshot.events);
    expect(unwrap(readEventSequences(path), 'eventSequences')).toEqual(snapshot.eventSequences);
  });

  it('events are ordered by aggregate_id then seq', () => {
    const events = unwrap(readEvents(corpusDbPath(SMALLEST)), 'events');
    const sorted = [...events].sort(
      (a, b) => (a.aggregateId < b.aggregateId ? -1 : a.aggregateId > b.aggregateId ? 1 : a.seq - b.seq),
    );
    expect(events.map((e) => `${e.aggregateId}#${e.seq}`)).toEqual(
      sorted.map((e) => `${e.aggregateId}#${e.seq}`),
    );
  });

  it('names the one file the engine reads', () => {
    expect(OPENCODE_DB_FILENAME).toBe('opencode.db');
    expect(opencodeDbPath(join('a', 'b'))).toBe(join('a', 'b', 'opencode.db'));
  });
});

// ---------------------------------------------------------------------------
// G1 — the posture, and the absence of a write surface
// ---------------------------------------------------------------------------

describe('the accessor writes nothing', () => {
  it('a write through a read-only handle throws — the posture db.ts opens with', () => {
    const { dbPath } = copyOfSmallest();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(() => db.prepare("INSERT INTO project (id, worktree) VALUES ('x','y')").run()).toThrow(
        /readonly/i,
      );
    } finally {
      db.close();
    }
  });

  it('every exported reader leaves the bytes identical and creates no siblings', () => {
    const { dir, dbPath } = copyOfSmallest();
    const before = sha256(dbPath);
    // Every exported function that touches the filesystem, once each.
    unwrap(readSchema(dbPath), 'schema');
    unwrap(readProjects(dbPath), 'projects');
    unwrap(readSessions(dbPath), 'sessions');
    unwrap(readMessages(dbPath), 'messages');
    unwrap(readParts(dbPath), 'parts');
    unwrap(readEvents(dbPath), 'events');
    unwrap(readEvents(dbPath, { data: true }), 'events+data');
    unwrap(readEventSequences(dbPath), 'eventSequences');
    unwrap(readDatabase(dbPath, { messages: true, events: true, eventData: true }), 'snapshot');
    expect(sha256(dbPath)).toBe(before);
    // No `-wal`, no `-shm`, no journal: the committed corpora are checkpointed
    // (`journal_mode` is not WAL in the file), so a read leaves the directory
    // holding exactly what it held.
    expect(readdirSync(dir)).toEqual([OPENCODE_DB_FILENAME]);
  });

  it('a failed read leaves the file it could not read alone', () => {
    const { dbPath } = tornCopy();
    const before = sha256(dbPath);
    const read = readParts(dbPath);
    expect(read.ok).toBe(false);
    expect(sha256(dbPath)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// G3 — every failure degrades, with its own code
// ---------------------------------------------------------------------------

describe('a store the engine cannot read degrades, and never throws', () => {
  it('an absent file is databaseMissing, not a corruption', () => {
    const dir = scratch();
    const path = join(dir, OPENCODE_DB_FILENAME);
    const read = readDatabase(path);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.health.code).toBe('databaseMissing');
    expect(read.health.path).toBe(path);
    // The message names the path that was opened, never a path from inside
    // the database.
    expect(read.health.message).toContain(path);
  });

  it('an absent parent directory is databaseMissing too', () => {
    const path = join(scratch(), 'no-such-dir', OPENCODE_DB_FILENAME);
    const read = readSessions(path);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.health.code).toBe('databaseMissing');
  });

  it('a directory where the database should be is databaseMissing', () => {
    const dir = scratch();
    const path = join(dir, OPENCODE_DB_FILENAME);
    mkdirSync(path);
    const read = readSchema(path);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.health.code).toBe('databaseMissing');
  });

  it('a present file that is not a database is databaseUnreadable', () => {
    // It OPENS: SQLite fails at the first statement, not at the open, which is
    // why `db.ts` always handshakes before handing anything back.
    const dir = scratch();
    const path = writeNonDatabase(dir);
    const read = readDatabase(path);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.health.code).toBe('databaseUnreadable');
      expect(read.health.message).toMatch(/not a database/i);
    }
  });

  it('a database torn mid-file is databaseCorrupt', () => {
    const { dbPath } = tornCopy();
    const read = readDatabase(dbPath);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.health.code).toBe('databaseCorrupt');
      expect(read.health.message).toMatch(/malformed|corrupt/i);
    }
  });

  it('an integer beyond the safe range is refused, not rounded', () => {
    const { dbPath } = copyOfSmallest();
    withWritableDb(dbPath, (db) => {
      db.exec(
        'UPDATE session SET time_created = 9007199254740993' +
          ' WHERE id = (SELECT id FROM session ORDER BY id LIMIT 1)',
      );
    });
    const read = readSessions(dbPath);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.health.code).toBe('databaseCorrupt');
      expect(read.health.message).toMatch(/safe integer/);
    }
  });

  it('a column holding the wrong SQLite type is refused, not coerced', () => {
    // `session.time_created` is declared `integer`, and INTEGER affinity keeps
    // a non-numeric string AS TEXT rather than converting it — so this really
    // is a column of the wrong type, not a value SQLite quietly fixed up.
    // (The inverse does not work: writing `42` into the `text` column `title`
    // is converted to `'42'` on the way in by TEXT affinity, which is why this
    // test moved to the integer side after measuring it.)
    const { dbPath } = copyOfSmallest();
    withWritableDb(dbPath, (db) => {
      db.exec(
        "UPDATE session SET time_created = 'not-a-timestamp'" +
          ' WHERE id = (SELECT id FROM session ORDER BY id LIMIT 1)',
      );
    });
    const read = readSessions(dbPath);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.health.code).toBe('databaseCorrupt');
      expect(read.health.message).toMatch(/session\.time_created/);
      expect(read.health.message).toMatch(/expected INTEGER/);
    }
  });
});

// ---------------------------------------------------------------------------
// The WAL cases — DoD 4.1's live-writer and crash-copy halves
// ---------------------------------------------------------------------------

/**
 * A crash copy: a database plus an UNCHECKPOINTED WAL, with no `-shm` — the
 * shape a process that died mid-session leaves behind.
 *
 * The copy is taken while the writer still holds the database open, because
 * closing it checkpoints the WAL away. The witness value is written inside the
 * transaction so the test can prove the WAL, and not the base file, is what
 * the accessor read.
 */
function hotWalCrashCopy(witness: string): { dir: string; dbPath: string; walPath: string } {
  const source = copyOfSmallest();
  const dir = scratch();
  const dbPath = join(dir, OPENCODE_DB_FILENAME);
  withWritableDb(source.dbPath, (db) => {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(
      `UPDATE session SET title = '${witness}' WHERE id = (SELECT id FROM session ORDER BY id LIMIT 1)`,
    );
    copyFileSync(source.dbPath, dbPath);
    copyFileSync(`${source.dbPath}-wal`, `${dbPath}-wal`);
  });
  return { dir, dbPath, walPath: `${dbPath}-wal` };
}

describe('a WAL beside the database', () => {
  it('a live-writer copy opens read-only and returns the uncheckpointed rows', () => {
    const witness = 'hot-wal-witness';
    const { walPath, dbPath } = hotWalCrashCopy(witness);
    expect(existsSync(walPath)).toBe(true);
    const sessions = unwrap(readSessions(dbPath), 'hot wal');
    expect(sessions.map((s) => s.title)).toContain(witness);
  });

  it('and the witness really is in the WAL, not in the base file', () => {
    // The control. Without it the test above would pass on a database that had
    // been checkpointed behind our backs, proving nothing about the WAL.
    const witness = 'hot-wal-control';
    const { dbPath } = hotWalCrashCopy(witness);
    const dir = scratch();
    const walless = join(dir, OPENCODE_DB_FILENAME);
    copyFileSync(dbPath, walless);
    const sessions = unwrap(readSessions(walless), 'walless');
    expect(sessions.map((s) => s.title)).not.toContain(witness);
  });

  it('a synthetic WAL SQLite cannot trust is ignored, and the read still succeeds', () => {
    // Measured: SQLite validates the WAL header and falls back to the base
    // file rather than failing. Asserted so the fallback is a known behaviour
    // rather than a surprise the first time a user hits it.
    const { dbPath } = copyOfSmallest();
    writeSyntheticWal(dbPath, Buffer.from('this is not a write-ahead log\n'.repeat(200), 'utf8'));
    const sessions = unwrap(readSessions(dbPath), 'garbage wal');
    expect(sessions.length).toBeGreaterThan(0);
  });

  it('a crash copy whose database was torn mid-write degrades to databaseCorrupt', () => {
    // The DoD's hot-WAL crash case. The WAL alone does not degrade anything —
    // the two tests above measure that — so the torn base file is what makes
    // this a crash rather than a live writer.
    const { dbPath, walPath } = hotWalCrashCopy('torn');
    writeFileSync(dbPath, readFileSync(dbPath).subarray(0, 40_000));
    const before = sha256(dbPath);
    const walBefore = sha256(walPath);
    const read = readDatabase(dbPath);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.health.code).toBe('databaseCorrupt');
    // No crash, no write, no partial tree: the caller got a health failure and
    // both files are byte-identical to what they were.
    expect(sha256(dbPath)).toBe(before);
    expect(sha256(walPath)).toBe(walBefore);
  });
});

describe('immutable=1 — the fixtures-only open mode (user decision 2026-08-27)', () => {
  /*
   * `PLAN.md` Phase 4 records the measurements behind this; the short version
   * is that `immutable=1` writes and locks NOTHING, and pays for it by skipping
   * the WAL. That is free on the committed corpora, which are journal-mode
   * `delete`, and a silent-staleness bug on the live WAL database.
   *
   * These tests exist because "we only ever point it at fixtures" is a habit,
   * and the refusal below is what makes it a property.
   */

  it('every committed corpus is journal-mode delete, which is what makes this safe', () => {
    // Read the header directly rather than asking SQLite: bytes 18 and 19 are
    // the write/read file-format versions, 1 = rollback journal, 2 = WAL. If a
    // future harvest ever commits a WAL-mode corpus this fails HERE, with a
    // clear reason, instead of silently disabling the mode further down.
    for (const corpus of CORPORA) {
      const header = Buffer.alloc(2);
      const fd = openSync(corpusDbPath(corpus), 'r');
      try {
        readSync(fd, header, 0, 2, 18);
      } finally {
        closeSync(fd);
      }
      expect([header[0], header[1]], `${corpus} journal mode`).toStrictEqual([1, 1]);
    }
  });

  it('reads a committed corpus identically with and without immutable=1', () => {
    // Non-vacuous by construction: if immutable=1 were silently skipping data,
    // these two snapshots would differ. On a journal-mode file there is nothing
    // to skip, and this asserts that rather than assuming it.
    for (const corpus of CORPORA) {
      const plain = unwrap(readDatabase(corpusDbPath(corpus)), `${corpus} plain`);
      const immutable = unwrap(
        readDatabase(corpusDbPath(corpus), { immutable: true }),
        `${corpus} immutable`,
      );
      expect(immutable.sessions).toStrictEqual(plain.sessions);
      expect(immutable.parts.length).toBe(plain.parts.length);
      expect(immutable.projects).toStrictEqual(plain.projects);
      expect(immutable.eventSequences).toStrictEqual(plain.eventSequences);
    }
  });

  it('creates no sibling and changes no byte of a committed corpus', () => {
    // The whole point of the mode. An ordinary read-only open of these files
    // already writes nothing (they are journal-mode), so this is belt and
    // braces — asserted because that is what it was chosen to be.
    for (const corpus of CORPORA) {
      const dbPath = corpusDbPath(corpus);
      const before = sha256(dbPath);
      const dir = join(dbPath, '..');
      const siblingsBefore = readdirSync(dir).sort();
      unwrap(readDatabase(dbPath, { immutable: true }), corpus);
      expect(sha256(dbPath)).toBe(before);
      expect(readdirSync(dir).sort()).toStrictEqual(siblingsBefore);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
    }
  });

  it('REFUSES immutable=1 on a WAL-mode database instead of silently going stale', () => {
    /*
     * The test that makes the mode safe to have at all.
     *
     * Measured 2026-08-27: with a writer holding rows the WAL had not yet
     * checkpointed, an ordinary read-only open saw them and the same file
     * opened `immutable=1` raised `no such table`. On a real database, where
     * the schema IS checkpointed and only the rows are not, the same mode
     * returns a confidently STALE tree and no error at all. So pointing this
     * mode at a WAL file must fail loudly, not work-ish.
     */
    const dir = makeTempDir('oc-immutable-wal-');
    const dbPath = join(dir, OPENCODE_DB_FILENAME);
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode=WAL;');
    writer.exec('CREATE TABLE probe(a);INSERT INTO probe VALUES(1);');
    writer.close();

    // Control: the file really is WAL-mode, so the refusal below is about that
    // and not about the file being unreadable for some other reason.
    const header = Buffer.alloc(2);
    const fd = openSync(dbPath, 'r');
    try {
      readSync(fd, header, 0, 2, 18);
    } finally {
      closeSync(fd);
    }
    expect([header[0], header[1]]).toStrictEqual([2, 2]);

    const read = readDatabase(dbPath, { immutable: true });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.health.code).toBe('databaseUnreadable');
      expect(read.health.message).toContain('WAL-mode');
      expect(read.health.message).toContain('immutable=1');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('a read-only open of a WAL database DOES touch its sidecars — the G1 finding', () => {
    /*
     * Not a defect in this module; a property of SQLite, recorded here because
     * the phase amended G1 over it rather than discovering it later.
     *
     * `opencode.db` itself is never modified. What SQLite writes is the `-shm`
     * shared-memory index, and it CREATES `-shm`/`-wal` when they are absent.
     * The user's live database is WAL-mode and already carries both.
     *
     * This is the ordinary (non-immutable) path, i.e. the one production uses.
     */
    const dir = makeTempDir('oc-g1-wal-');
    const dbPath = join(dir, OPENCODE_DB_FILENAME);
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode=WAL;');
    writer.exec('CREATE TABLE probe(a);INSERT INTO probe VALUES(1);');
    writer.close();
    for (const suffix of ['-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });

    const dbBefore = sha256(dbPath);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    // A plain read-only open, which is what the engine does in production.
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    probe.prepare('SELECT count(*) AS c FROM probe').get();
    probe.close();

    // The main database is untouched — that is the half G1 still guarantees.
    expect(sha256(dbPath)).toBe(dbBefore);
    // The sidecars are not — that is the half the amendment records.
    expect(existsSync(`${dbPath}-shm`)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
