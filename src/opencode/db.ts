/**
 * Agent Deck — the OpenCode store accessor (PLAN.md Phase 4, DoD 4.1).
 *
 * The ONE module in `src/opencode/` that opens the OpenCode database, and it
 * opens it `{ readOnly: true }`, reads, and closes. Everything downstream
 * consumes the typed rows of `./types.js` and never sees a handle.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO WRITE SURFACE, AND WHY THAT IS A SHAPE RATHER THAN A HABIT
 * ---------------------------------------------------------------------------
 *
 * G1 is "read-only, always": no writes to the observed engine's files, ever.
 * DoD 4.7 audits *every exported function here* with a mutation test, so the
 * property has to be structural rather than a convention this file happens to
 * follow today:
 *
 *   - No exported function accepts caller-supplied SQL. Every statement in this
 *     module is a module-scope constant, and the only values that ever reach
 *     SQLite are the ones bound by this file (currently none: every statement
 *     is a parameterless `SELECT`).
 *   - No exported function returns, yields, or stores the `DatabaseSync`
 *     handle. {@link withReadOnlyDb} is module-private, and the callbacks it
 *     runs are module-private too.
 *   - The connection is opened `{ readOnly: true }`, which SQLite enforces:
 *     an `INSERT` on such a handle throws `attempt to write a readonly
 *     database` (errcode 8, measured on the committed corpora).
 *
 * `synthetic.ts` is the one module here that opens a database for write; it is
 * a test fixture builder, `src/hooks/egress.test.ts` asserts the import graph
 * rooted at `index.ts` never reaches it, and nothing in this file imports it.
 *
 * ---------------------------------------------------------------------------
 * MEASURED, ON THIS REPO'S COMMITTED CORPORA (2026-08-27, Node 24.15.0)
 * ---------------------------------------------------------------------------
 *
 * These are the behaviours the degrade codes are mapped from. Each one was run
 * against `fixtures/opencode-1.18.21/opencode.db` before this file was written,
 * and each is re-asserted by `db.test.ts` rather than trusted from this note:
 *
 *   read-only handle + INSERT       throws, `attempt to write a readonly database`
 *   file absent                     throws at open, `unable to open database file`
 *   present but not a database      opens, then throws `file is not a database`
 *                                   at the FIRST statement — so opening proves
 *                                   nothing and this module always handshakes
 *   database truncated mid-file     throws `database disk image is malformed`
 *   hot (uncheckpointed) WAL        **succeeds**, and the WAL's contents are
 *                                   read. Contract `Amendment 2026-08-26 §D2`.
 *   `-wal` sibling full of garbage  succeeds; SQLite validates the WAL header
 *                                   and ignores a WAL it cannot trust
 *
 * The last two are why the DoD's "hot-WAL crash copy degrades" case is built as
 * a copy whose *database file* was torn mid-write **and** which carries a hot
 * WAL: a clean hot WAL on its own does not degrade anything, and a test that
 * asserted it did would be asserting the opposite of what SQLite does.
 *
 * A `-wal` file's SIZE is never read here or anywhere downstream. It is not a
 * write indicator: `opencode.db-wal` measured at exactly 4,181,832 bytes across
 * 2 h 30 m and four probes while the main database grew 425 KB.
 *
 * ---------------------------------------------------------------------------
 * INTEGERS
 * ---------------------------------------------------------------------------
 *
 * Every statement sets `setReadBigInts(true)` and every integer column is
 * narrowed to `number` at the row boundary by {@link intOf}, which refuses
 * anything outside `Number.MAX_SAFE_INTEGER` rather than rounding it. No
 * millisecond timestamp passes through a float. `scripts/opencode-golden.mjs`
 * does the same thing with no shared code — that non-sharing is what makes the
 * goldens evidence, so nothing here imports it.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';

import type {
  OcDegradeCode,
  OcEngineHealth,
  OcEventSequenceRow,
  OcPartRow,
  OcProjectRow,
  OcSessionRow,
} from './types.js';

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/** The only file the engine reads (contract §2). */
export const OPENCODE_DB_FILENAME = 'opencode.db';

/** `<dataDir>/opencode.db`. Resolving `dataDir` itself is the caller's job. */
export function opencodeDbPath(dataDir: string): string {
  return join(dataDir, OPENCODE_DB_FILENAME);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** The failing arm of {@link OcEngineHealth}, named so callers can hold one. */
export type OcHealthFailure = Extract<OcEngineHealth, { readonly ok: false }>;

/**
 * Every read returns one of these. **Nothing in this module throws** on a bad
 * store (G3): a missing file, a torn file, a file that is not a database and a
 * row whose column has the wrong SQLite type all come back as `ok: false` with
 * a degrade code.
 */
export type OcRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly health: OcHealthFailure };

/**
 * `sqlite_master` as this module reports it: table name -> column names, in
 * declaration order, for **every** table in the file.
 *
 * Unknown tables are present here and the fingerprint ignores and counts them
 * (the CC unknown-field rule applied to a schema). Names are as SQLite spells
 * them; SQLite identifiers are case-insensitive, so comparisons downstream
 * lower-case both sides.
 */
export interface OcSchema {
  readonly tables: ReadonlyMap<string, readonly string[]>;
}

/**
 * A `message` row.
 *
 * NOT in `types.ts`, deliberately: `types.ts` is the *package boundary*, and
 * no package downstream of this one consumes message rows today — `parse.ts`
 * works from `part` rows and `liveness.ts` from `event_sequence`. The row type
 * lives here because `message` is one of contract §3's six required tables and
 * the fingerprint asserts its columns, so something has to actually read them.
 */
export interface OcMessageRow {
  id: string;
  sessionId: string;
  timeCreated: number;
  timeUpdated: number;
  /** The raw JSON text, as stored. Never pre-parsed here. */
  data: string;
}

/**
 * An `event` row. Local to this module for the same reason as
 * {@link OcMessageRow}.
 *
 * `data` is OPTIONAL and omitted unless {@link OcReadOptions.eventData} asks
 * for it: contract §6 says the engine reads "seq and type only" from `event`
 * and takes content from the content tables, and the anchor corpus holds 3,179
 * event rows whose `data` payloads duplicate the `session`/`message`/`part`
 * rows in full.
 */
export interface OcEventRow {
  id: string;
  aggregateId: string;
  seq: number;
  type: string;
  data?: string;
}

/** What {@link readDatabase} materialises. */
export interface OcDatabaseSnapshot {
  readonly schema: OcSchema;
  readonly projects: readonly OcProjectRow[];
  readonly sessions: readonly OcSessionRow[];
  readonly parts: readonly OcPartRow[];
  readonly eventSequences: readonly OcEventSequenceRow[];
  /** Present only when {@link OcReadOptions.messages} was set. */
  readonly messages?: readonly OcMessageRow[];
  /** Present only when {@link OcReadOptions.events} was set. */
  readonly events?: readonly OcEventRow[];
}

/**
 * How the connection is opened. Separate from {@link OcReadOptions}'s
 * which-tables question because it is a G1 question, not a content one.
 */
export interface OcOpenOptions {
  /**
   * Open through a `file:…?immutable=1` URI, which writes and locks NOTHING.
   *
   * **For the committed corpora under `fixtures/` only.** User decision of
   * 2026-08-27, taken with the measurements below in hand.
   *
   * WHY IT IS NOT THE DEFAULT, MEASURED. `immutable=1` tells SQLite the file
   * cannot change, so SQLite skips the WAL entirely and reads only the main
   * database file. Against a live WAL database that is a **silent staleness
   * bug**: the Phase 2 kill gate measured reads served through uncheckpointed
   * frames the main file did not hold (`event` 4,440 → 4,443 while
   * `opencode.db` stayed at exactly 24,715,264 bytes). A probe on 2026-08-27
   * made it concrete — with a writer holding two rows and the schema still in
   * the WAL, an ordinary read-only open returned `{c: 2}` and the same file
   * opened `immutable=1` raised `no such table`. It errored there only because
   * the *schema* was also uncheckpointed; on a real database the schema is
   * checkpointed and the rows are not, so it would return a confidently stale
   * tree instead of an error. That is the worse failure.
   *
   * WHY IT IS SAFE FOR THE CORPORA. Both committed databases are journal-mode
   * **`delete`**, not WAL — header bytes 18,19 are `1,1`, measured — so they
   * have no WAL to skip and nothing can be missed. What it buys is that a test
   * physically cannot write, lock, or create a sibling beside a fixture.
   *
   * Requesting it on a WAL-mode file is REFUSED rather than honoured; see
   * {@link withReadOnlyDb}. A silent-staleness mode that can be pointed at the
   * wrong file is a trap, and this repo's rule is to make the trap fail loudly.
   */
  readonly immutable?: boolean;
}

/** Which of the optional tables {@link readDatabase} should materialise. */
export interface OcReadOptions extends OcOpenOptions {
  /** Read `message` rows. Default `false` — nothing downstream reads them. */
  readonly messages?: boolean;
  /** Read `event` rows. Default `false` — liveness runs off `event_sequence`. */
  readonly events?: boolean;
  /** Include `event.data`. Default `false` (contract §6: seq and type only). */
  readonly eventData?: boolean;
}

// ---------------------------------------------------------------------------
// Statements — every one of them a module-scope constant
// ---------------------------------------------------------------------------

/*
 * SQLite `LIKE` is CASE-INSENSITIVE for ASCII and will hand back a confident
 * wrong answer; `GLOB` or `instr()` is the rule for any needle. Nothing here
 * does a string match in SQL at all, which is the stronger version of the same
 * defence.
 *
 * The ORDER BY clauses are load-bearing, not cosmetic: `session` and `part`
 * rows are ordered `time_created, id` because the committed goldens and every
 * downstream package depend on that order (GOLDEN.md), and ties break on the
 * id so the order is total.
 */

const SCHEMA_SQL =
  "SELECT m.name AS tbl, p.name AS col FROM sqlite_master m" +
  " JOIN pragma_table_info(m.name) p WHERE m.type = 'table'" +
  ' ORDER BY m.name, p.cid';

/** The handshake. Proves the file is a database before any caller work. */
const HANDSHAKE_SQL = 'SELECT count(*) AS n FROM sqlite_master';

const PROJECT_SQL = 'SELECT id, worktree, vcs FROM project ORDER BY id';

const SESSION_SQL =
  'SELECT id, project_id, parent_id, slug, directory, title, version, agent, model, cost,' +
  ' tokens_input, tokens_output, time_created, time_updated, time_archived' +
  ' FROM session ORDER BY time_created, id';

const MESSAGE_SQL =
  'SELECT id, session_id, time_created, time_updated, data FROM message' +
  ' ORDER BY time_created, id';

const PART_SQL =
  'SELECT id, message_id, session_id, time_created, time_updated, data FROM part' +
  ' ORDER BY time_created, id';

const EVENT_SQL =
  'SELECT id, aggregate_id, seq, type FROM event ORDER BY aggregate_id, seq';

const EVENT_WITH_DATA_SQL =
  'SELECT id, aggregate_id, seq, type, data FROM event ORDER BY aggregate_id, seq';

const EVENT_SEQUENCE_SQL =
  'SELECT aggregate_id, seq, owner_id FROM event_sequence ORDER BY aggregate_id';

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

type Row = Record<string, SQLOutputValue>;

/** Thrown by the narrowers below; never escapes this module. */
class OcRowShapeError extends Error {}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Map a failure to a degrade code.
 *
 * The two string tests are on SQLite's own wording, measured: `file is not a
 * database` (errcode 26) for a file that is present and is something else, and
 * `unable to open database file` (errcode 14) for a path SQLite will not open.
 * Everything else — `database disk image is malformed` (11) and any row-shape
 * refusal from the narrowers — is `databaseCorrupt`: opened, but a read failed.
 */
function degradeCodeFor(error: unknown): OcDegradeCode {
  const message = errorMessage(error);
  if (/not a database|file is encrypted/i.test(message)) return 'databaseUnreadable';
  if (/unable to open database file/i.test(message)) return 'databaseUnreadable';
  return 'databaseCorrupt';
}

function failure<T>(code: OcDegradeCode, message: string, path: string): OcRead<T> {
  return { ok: false, health: { ok: false, code, message, path } };
}

/**
 * A SQLite file's journal mode, read from the header rather than from a
 * `PRAGMA` — asking SQLite would mean opening the file, which is the thing the
 * caller has not decided how to do yet.
 *
 * Bytes 18 and 19 of the 100-byte header are the file-format write/read
 * versions: `1` = rollback journal, `2` = WAL. Measured on this repo's own
 * files: both committed corpora are `1,1`; the live
 * `%USERPROFILE%\.local\share\opencode\opencode.db` is `2,2`.
 */
function journalModeOf(dbPath: string): 'wal' | 'journal' | 'unreadable' {
  let fd: number | undefined;
  try {
    fd = openSync(dbPath, 'r');
    const header = Buffer.alloc(2);
    const bytes = readSync(fd, header, 0, 2, 18);
    if (bytes < 2) return 'unreadable';
    return header[0] === 2 || header[1] === 2 ? 'wal' : 'journal';
  } catch {
    return 'unreadable';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing read is invalidated by a failed close.
      }
    }
  }
}

/**
 * `C:\ws\a.db` -> `file:C:/ws/a.db?immutable=1`.
 *
 * `%`, `#` and `?` are percent-encoded because SQLite parses the URI: an
 * unescaped `?` in a directory name would truncate the path and turn the rest
 * into query parameters. Backslashes become forward slashes; SQLite's URI
 * parser does not accept the Windows separator.
 */
function immutableUri(dbPath: string): string {
  const forward = dbPath.split('\\').join('/');
  const escaped = forward.replace(/[%#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `file:${escaped}?immutable=1`;
}

/**
 * Open `dbPath` read-only, run `read`, close, and never throw.
 *
 * Module-private: this is the function that holds a handle, and the whole
 * no-write-surface argument at the top of this file rests on it never being
 * exported and never handing the handle to anything outside this module.
 */
function withReadOnlyDb<T>(
  dbPath: string,
  read: (db: DatabaseSync) => T,
  open: OcOpenOptions = {},
): OcRead<T> {
  // Existence first, so "there is no OpenCode data here" is `databaseMissing`
  // rather than a SQLITE_CANTOPEN that reads like a corruption.
  try {
    if (!statSync(dbPath).isFile()) {
      return failure('databaseMissing', `${dbPath} is not a file`, dbPath);
    }
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return failure('databaseMissing', `${dbPath} does not exist`, dbPath);
    }
    return failure('databaseUnreadable', `cannot stat ${dbPath}: ${errorMessage(error)}`, dbPath);
  }

  let target = dbPath;
  if (open.immutable === true) {
    // REFUSE rather than honour it on a WAL-mode file. See OcOpenOptions: on a
    // WAL database this mode silently returns whatever was last checkpointed,
    // and a wrong tree that looks right is the failure G3 exists to prevent.
    const mode = journalModeOf(dbPath);
    if (mode === 'unreadable') {
      return failure('databaseUnreadable', `cannot read the header of ${dbPath}`, dbPath);
    }
    if (mode === 'wal') {
      return failure(
        'databaseUnreadable',
        `refusing to open ${dbPath} with immutable=1: it is a WAL-mode database, ` +
          'and immutable=1 skips the WAL, so the read would silently return ' +
          'whatever was last checkpointed. immutable=1 is for the committed ' +
          'journal-mode corpora under fixtures/ only.',
        dbPath,
      );
    }
    target = immutableUri(dbPath);
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(target, { readOnly: true });
  } catch (error) {
    return failure(degradeCodeFor(error), `cannot open ${dbPath}: ${errorMessage(error)}`, dbPath);
  }

  try {
    // A non-database file OPENS happily and fails at the first statement, so
    // the open alone is not evidence. Measured, not assumed.
    db.prepare(HANDSHAKE_SQL).get();
    return { ok: true, value: read(db) };
  } catch (error) {
    return failure(degradeCodeFor(error), `cannot read ${dbPath}: ${errorMessage(error)}`, dbPath);
  } finally {
    try {
      db.close();
    } catch {
      // A close that fails cannot invalidate rows already read, and throwing
      // here would turn a successful read into an exception (G3).
    }
  }
}

// ---------------------------------------------------------------------------
// Narrowing — BigInt in, `number` out, refusal rather than rounding
// ---------------------------------------------------------------------------

function describe(value: SQLOutputValue | undefined): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'NULL';
  return typeof value;
}

function textOf(row: Row, column: string, table: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new OcRowShapeError(`${table}.${column} is ${describe(value)}, expected TEXT`);
  }
  return value;
}

function textOrNullOf(row: Row, column: string, table: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new OcRowShapeError(`${table}.${column} is ${describe(value)}, expected TEXT or NULL`);
  }
  return value;
}

/**
 * An integer column, read as BigInt, narrowed to `number`.
 *
 * A value outside `Number.MAX_SAFE_INTEGER` is a REFUSAL, not a rounding: a
 * timestamp silently losing its last digits is exactly the class of wrong
 * answer `setReadBigInts` exists to prevent, and the caller's degrade path is
 * the safe direction.
 */
function intOf(row: Row, column: string, table: string): number {
  const value = row[column];
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new OcRowShapeError(
        `${table}.${column} is ${value.toString()}, outside the safe integer range`,
      );
    }
    return Number(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new OcRowShapeError(`${table}.${column} is ${describe(value)}, expected INTEGER`);
}

function intOrNullOf(row: Row, column: string, table: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return intOf(row, column, table);
}

/** A `real` column. Stored as REAL, but an integral value arrives as BigInt. */
function realOf(row: Row, column: string, table: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return intOf(row, column, table);
  throw new OcRowShapeError(`${table}.${column} is ${describe(value)}, expected REAL`);
}

/** Every statement reads integers as BigInt; there is no second policy. */
function rowsOf(db: DatabaseSync, sql: string): Row[] {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all();
}

// ---------------------------------------------------------------------------
// Selects — module-private, one per table
// ---------------------------------------------------------------------------

function selectSchema(db: DatabaseSync): OcSchema {
  const tables = new Map<string, string[]>();
  for (const row of rowsOf(db, SCHEMA_SQL)) {
    const table = textOf(row, 'tbl', 'sqlite_master');
    const column = textOf(row, 'col', 'sqlite_master');
    const columns = tables.get(table);
    if (columns === undefined) tables.set(table, [column]);
    else columns.push(column);
  }
  return { tables };
}

function selectProjects(db: DatabaseSync): OcProjectRow[] {
  return rowsOf(db, PROJECT_SQL).map((row) => ({
    id: textOf(row, 'id', 'project'),
    worktree: textOf(row, 'worktree', 'project'),
    vcs: textOrNullOf(row, 'vcs', 'project'),
  }));
}

function selectSessions(db: DatabaseSync): OcSessionRow[] {
  return rowsOf(db, SESSION_SQL).map((row) => ({
    id: textOf(row, 'id', 'session'),
    projectId: textOf(row, 'project_id', 'session'),
    parentId: textOrNullOf(row, 'parent_id', 'session'),
    slug: textOrNullOf(row, 'slug', 'session'),
    directory: textOrNullOf(row, 'directory', 'session'),
    title: textOf(row, 'title', 'session'),
    version: textOf(row, 'version', 'session'),
    agent: textOrNullOf(row, 'agent', 'session'),
    model: textOrNullOf(row, 'model', 'session'),
    cost: realOf(row, 'cost', 'session'),
    tokensInput: intOf(row, 'tokens_input', 'session'),
    tokensOutput: intOf(row, 'tokens_output', 'session'),
    timeCreated: intOf(row, 'time_created', 'session'),
    timeUpdated: intOf(row, 'time_updated', 'session'),
    timeArchived: intOrNullOf(row, 'time_archived', 'session'),
  }));
}

function selectMessages(db: DatabaseSync): OcMessageRow[] {
  return rowsOf(db, MESSAGE_SQL).map((row) => ({
    id: textOf(row, 'id', 'message'),
    sessionId: textOf(row, 'session_id', 'message'),
    timeCreated: intOf(row, 'time_created', 'message'),
    timeUpdated: intOf(row, 'time_updated', 'message'),
    data: textOf(row, 'data', 'message'),
  }));
}

function selectParts(db: DatabaseSync): OcPartRow[] {
  return rowsOf(db, PART_SQL).map((row) => ({
    id: textOf(row, 'id', 'part'),
    messageId: textOf(row, 'message_id', 'part'),
    sessionId: textOf(row, 'session_id', 'part'),
    timeCreated: intOf(row, 'time_created', 'part'),
    timeUpdated: intOf(row, 'time_updated', 'part'),
    data: textOf(row, 'data', 'part'),
  }));
}

function selectEvents(db: DatabaseSync, withData: boolean): OcEventRow[] {
  return rowsOf(db, withData ? EVENT_WITH_DATA_SQL : EVENT_SQL).map((row) => {
    const event: OcEventRow = {
      id: textOf(row, 'id', 'event'),
      aggregateId: textOf(row, 'aggregate_id', 'event'),
      seq: intOf(row, 'seq', 'event'),
      type: textOf(row, 'type', 'event'),
    };
    return withData ? { ...event, data: textOf(row, 'data', 'event') } : event;
  });
}

function selectEventSequences(db: DatabaseSync): OcEventSequenceRow[] {
  return rowsOf(db, EVENT_SEQUENCE_SQL).map((row) => ({
    aggregateId: textOf(row, 'aggregate_id', 'event_sequence'),
    seq: intOf(row, 'seq', 'event_sequence'),
    ownerId: textOrNullOf(row, 'owner_id', 'event_sequence'),
  }));
}

// ---------------------------------------------------------------------------
// The exported surface — paths in, typed rows out, no handle, no SQL
// ---------------------------------------------------------------------------

/** Every table and column in the file. The fingerprint's input. */
export function readSchema(
  dbPath: string,
  open: OcOpenOptions = {},
): OcRead<OcSchema> {
  return withReadOnlyDb(dbPath, selectSchema, open);
}

/** `project` rows, ordered by id. */
export function readProjects(
  dbPath: string,
  open: OcOpenOptions = {},
): OcRead<readonly OcProjectRow[]> {
  return withReadOnlyDb(dbPath, selectProjects, open);
}

/** `session` rows, ordered `time_created, id`. */
export function readSessions(
  dbPath: string,
  open: OcOpenOptions = {},
): OcRead<readonly OcSessionRow[]> {
  return withReadOnlyDb(dbPath, selectSessions, open);
}

/** `message` rows, ordered `time_created, id`. */
export function readMessages(
  dbPath: string,
  open: OcOpenOptions = {},
): OcRead<readonly OcMessageRow[]> {
  return withReadOnlyDb(dbPath, selectMessages, open);
}

/** `part` rows, ordered `time_created, id`. */
export function readParts(
  dbPath: string,
  open: OcOpenOptions = {},
): OcRead<readonly OcPartRow[]> {
  return withReadOnlyDb(dbPath, selectParts, open);
}

/** `event` rows, ordered `aggregate_id, seq`. `data` only if asked for. */
export function readEvents(
  dbPath: string,
  options: OcOpenOptions & { readonly data?: boolean } = {},
): OcRead<readonly OcEventRow[]> {
  return withReadOnlyDb(dbPath, (db) => selectEvents(db, options.data === true), options);
}

/** `event_sequence` rows — the liveness cursor's input — by aggregate. */
export function readEventSequences(
  dbPath: string,
  open: OcOpenOptions = {},
): OcRead<readonly OcEventSequenceRow[]> {
  return withReadOnlyDb(dbPath, selectEventSequences, open);
}

/**
 * The production entry point: open once, read everything the engine needs,
 * close.
 *
 * One open rather than seven. The single-table readers above exist for the
 * poll path (liveness re-reads `event_sequence` alone) and for tests; a full
 * engine pass uses this.
 */
export function readDatabase(
  dbPath: string,
  options: OcReadOptions = {},
): OcRead<OcDatabaseSnapshot> {
  return withReadOnlyDb(
    dbPath,
    (db) => {
      const snapshot: OcDatabaseSnapshot = {
        schema: selectSchema(db),
        projects: selectProjects(db),
        sessions: selectSessions(db),
        parts: selectParts(db),
        eventSequences: selectEventSequences(db),
        ...(options.messages === true ? { messages: selectMessages(db) } : {}),
        ...(options.events === true
          ? { events: selectEvents(db, options.eventData === true) }
          : {}),
      };
      return snapshot;
    },
    options,
  );
}
