/**
 * Agent Deck — the OpenCode engine's liveness tap (`PLAN.md` DoD 4.5, spec OC4).
 *
 * Answers "what is running right now" for OpenCode sessions from the persisted
 * `event_sequence` cursor, the `session` row's own timestamps, and a narrow
 * scan of `part` rows for in-flight tool calls. It is the structural twin of
 * `src/model/liveness.ts` and shares **no code with it** — see G2 below.
 *
 * ---------------------------------------------------------------------------
 * ZERO SOCKETS (G5, in its strongest form)
 * ---------------------------------------------------------------------------
 * No listener, no client, no server, no SSE. OC4: the measuring session's own
 * events accumulated past `seq` 192 while it ran as a plain TUI/CLI session,
 * so a database cursor is a working liveness tap for every OpenCode mode
 * without one. The only imports here are `node:` builtins and `chokidar`.
 * `liveness.test.ts` asserts that at the source level, and
 * `src/hooks/egress.test.ts` asserts it against the import graph (DoD 4.7).
 *
 * ---------------------------------------------------------------------------
 * G2 — TWICE, and they are different separations
 * ---------------------------------------------------------------------------
 * 1. **Across engines.** This module imports nothing from `src/model/` beyond
 *    the pure `SessionState` / `AgentNode` types and nothing from
 *    `src/parser/`. A Claude Code parse failure cannot reach it and it cannot
 *    reach a Claude Code parse failure. `src/model/liveness.ts` is the
 *    reference for *how the CC engine spells the same idea*; it is deliberately
 *    not imported, because sharing the implementation would re-join the two
 *    failure paths the architecture exists to keep apart.
 *
 * 2. **Inside this engine.** OC4: "Events are read for `seq` and `type` only.
 *    The four event `data` payloads carry full `info`/`part` objects that
 *    duplicate the content tables, and the engine does not read them." Liveness
 *    reads `session` and `event_sequence` — its own data — and those two
 *    failing is what degrades the engine. The `event` type scan and the `part`
 *    tool scan are **separately wrapped**: either one throwing is counted
 *    ({@link OcLivenessCounters.eventScanFailures},
 *    {@link OcLivenessCounters.partScanFailures}) and liveness keeps answering
 *    from the cursor. A content-parse failure cannot take down liveness for the
 *    same session.
 *
 * ---------------------------------------------------------------------------
 * THE CURSOR IS PER SESSION, AND THAT IS NOT STYLISTIC
 * ---------------------------------------------------------------------------
 * `event_sequence.aggregate_id` is a session id and `seq` is monotonic **per
 * aggregate** from 0. Across 2 h 08 m of real sessions the GLOBAL `max(seq)`
 * sat frozen at **1,589** while the event count rose by **73**, because one
 * long session dominated it (OC4, kill gate §2.7). A global cursor reads as
 * frozen for two hours while events land everywhere else. The test
 * "tracks the cursor per session, so one busy session cannot make a quiet one
 * live" pins it.
 *
 * ---------------------------------------------------------------------------
 * A SEQ THAT GOES BACKWARDS IS A RE-READ, NEVER A REFUSAL
 * ---------------------------------------------------------------------------
 * OC4's recorded assumption is that the `event` table is never trimmed, and it
 * survived its first real test — three readings across 2 h 08 m, monotonic,
 * +73 rows, no decrease. That is **an absence over two hours, not a
 * guarantee**. So an observed `seq` below the last-seen value triggers a full
 * re-read of that session's events plus
 * {@link OcLivenessCounters.seqRegressions}, and the session is never refused.
 * Re-reading is the safe direction; refusing is not.
 *
 * ---------------------------------------------------------------------------
 * EVENT TYPES ARE ASSERTED BY FORM, NOT BY SET
 * ---------------------------------------------------------------------------
 * The measured types are `session.created.1`, `session.updated.1`,
 * `message.updated.1` and `message.part.updated.1`. The `.1` suffix is a
 * versioned event-type form. {@link EVENT_TYPE_FORM} asserts **name plus dotted
 * version and nothing more**; a well-formed type outside
 * {@link MEASURED_EVENT_TYPES} increments
 * {@link OcLivenessCounters.eventTypesUnknown} and a string that is not of the
 * form increments {@link OcLivenessCounters.eventTypesMalformed}. Neither
 * refuses anything. Unknown types are expected in future releases — the CC
 * rule, applied to a second source.
 *
 * ---------------------------------------------------------------------------
 * NO CLOCK AND NO TIMER LIVE HERE (`PLAN.md` Phase 4 Amendment A2)
 * ---------------------------------------------------------------------------
 * "A liveness test that reads a live DB measures the machine it ran on." So
 * `now` and the poll trigger are both injected, there is no `Date.now()` and no
 * `setInterval`/`setTimeout` anywhere in this file, and every A2 case is proven
 * against a `synthetic-` copy built in a temp directory from a committed
 * fixture.
 *
 * The production wiring is `src/opencode/index.ts`'s, not this file's. What it
 * has to supply is exactly:
 *
 * ```ts
 * const engine = new OcLivenessEngine({
 *   dbPath,
 *   now: Date.now,
 *   thresholdMs: config.get('agentDeck.livenessThresholdMs'),
 *   pollTrigger: (run, intervalMs) => {
 *     const handle = setInterval(run, intervalMs);
 *     return { stop: () => clearInterval(handle) };
 *   },
 *   walWatchFactory: createWalWatchFactory(),
 * });
 * engine.start();
 * ```
 *
 * {@link createWalWatchFactory} is production code and lives here because it is
 * the module's own dependency on `chokidar`, exactly as
 * `createChokidarWatchFactory` lives in `src/watch/watcher.ts`. It carries no
 * timer of its own.
 *
 * ---------------------------------------------------------------------------
 * THE WAL FILE'S SIZE IS NOT A WRITE INDICATOR
 * ---------------------------------------------------------------------------
 * `opencode.db-wal` measured at **exactly 4,181,832 bytes across 2 h 30 m and
 * four separate probes** while `opencode.db` grew 425 KB and the event table
 * gained 116 rows: SQLite reuses WAL frames in place and the file rests at its
 * high-water mark. This module watches its **mtime** as a wake signal and
 * reads its size never. Nothing here — and no control in the tests — may be
 * keyed on that size.
 *
 * ---------------------------------------------------------------------------
 * G1 / G3 / G7
 * ---------------------------------------------------------------------------
 * G1: every open is `DatabaseSync(path, { readOnly: true })` and the only other
 * filesystem call is `existsSync`. Nothing is written, anywhere, ever.
 * G3: {@link OcLivenessEngine.poll} never throws. A missing, unopenable or
 * unreadable database degrades the ENGINE ({@link OcEngineHealth}); it never
 * produces a partial answer and it never marks a session `unsupported` —
 * `'unsupported'` is the fingerprint's output, and {@link OcLiveness} excludes
 * it at the type level so this module cannot produce it by accident.
 * G7: all state is in-memory and dies with the instance.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { watch as chokidarWatch } from 'chokidar';
import type { FSWatcher } from 'chokidar';

import type { AgentNode, SessionState } from '../model/events.js';
import type { OcDegradeCode, OcEngineHealth, OcEventSequenceRow } from './types.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * How often the injected trigger is asked to poll, in milliseconds.
 *
 * DoD 4.5: "Poll interval a named constant (default 1,000 ms), `chokidar` on
 * `opencode.db-wal` mtime as the wake signal so the poll is not a busy loop."
 * The constant is the FLOOR on responsiveness when no filesystem event arrives;
 * the wake is what makes a real change visible sooner than a second.
 */
export const DEFAULT_OC_POLL_INTERVAL_MS = 1000;

/**
 * The liveness recency threshold, in milliseconds.
 *
 * **Reused from the Claude Code engine, not re-decided.** It is the default of
 * the `agentDeck.livenessThresholdMs` setting in `package.json`'s
 * `contributes.configuration`, and `src/model/liveness.ts` states the same
 * number as `DEFAULT_MTIME_THRESHOLD_MS`. A literal here would be a third
 * place for the number to drift, so the test
 * "reuses the agentDeck.livenessThresholdMs default from package.json rather
 * than re-deciding it" reads `package.json` off disk and asserts this constant
 * equals it. The literal is duplicated deliberately and pinned by that test:
 * the shipped bundle must not read `package.json` at runtime.
 */
export const DEFAULT_OC_LIVENESS_THRESHOLD_MS = 120_000;

/** The `-wal` sibling of a database path. Watched for mtime, never for size. */
export function walPathFor(dbPath: string): string {
  return `${dbPath}-wal`;
}

// ---------------------------------------------------------------------------
// Event-type form (OC4)
// ---------------------------------------------------------------------------

/**
 * Name plus dotted version, and nothing more.
 *
 * One or more dot-separated name segments followed by a final integer version
 * segment: `session.created.1`, `message.part.updated.1`. Anything else is
 * counted as malformed — it is still never a refusal.
 */
export const EVENT_TYPE_FORM = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*\.\d+$/i;

/**
 * The four types measured on the captured corpora.
 *
 * A diagnostic set, NOT a gate: a type outside it is counted and ignored. The
 * set is small on purpose and is expected to grow underneath us.
 */
export const MEASURED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'session.created.1',
  'session.updated.1',
  'message.updated.1',
  'message.part.updated.1',
]);

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * The session-level liveness values this module can produce.
 *
 * `'unsupported'` is excluded **at the type level**: it is the fingerprint's
 * output (`src/opencode/fingerprint.ts`, DoD 4.2), never liveness's. Making it
 * unrepresentable here is cheaper than a test that hopes nobody writes it.
 */
export type OcLiveness = Exclude<SessionState['liveness'], 'unsupported'>;

/**
 * Whether this session has a tool call in flight.
 *
 * `AgentNode['status']`-valued, and deliberately a SEPARATE FIELD from
 * {@link OcSessionLiveness.liveness}: DoD 4.5's `running` is an
 * `AgentNode['status']`, not a `SessionState.liveness` value, and smuggling it
 * into the liveness enum would put a fifth value into a four-value contract.
 *
 * `'error'` is never produced here — the same rule `src/model/liveness.ts`
 * states for the CC engine. A failed tool call is the content side's story.
 */
export type OcToolStatus = Extract<AgentNode['status'], 'running' | 'done'>;

/** One in-flight tool call, as liveness sees it. */
export interface OcRunningTool {
  /** `part.data.callID` — the join key OpenCode itself uses (OC3). */
  readonly callId: string;
  /** The `prt_*` row id, which is the only identity a part always has. */
  readonly partId: string;
}

/** Everything this module knows about one session. */
export interface OcSessionLiveness {
  readonly sessionId: string;
  /** `session.parent_id`. NULL on a root session. Carried, never interpreted. */
  readonly parentId: string | null;
  /** `session.version` — carried for the fingerprint's use, not checked here. */
  readonly version: string;
  readonly liveness: OcLiveness;
  readonly toolStatus: OcToolStatus;
  readonly runningToolCount: number;
  /** Sorted by `callId` so a snapshot is stable across polls. */
  readonly runningTools: readonly OcRunningTool[];
  /** Last observed `event_sequence.seq`. Absent when the session has no row. */
  readonly seq?: number;
  /**
   * Injected-clock value at which this engine last SAW the seq advance.
   * Absent while the cursor has only been seeded.
   */
  readonly seqAdvancedAt?: number;
  /** True until an advance has been observed — the cursor is a baseline only. */
  readonly cursorSeeded: boolean;
  readonly timeUpdated: number;
  readonly timeArchived: number | null;
  /** `max(timeUpdated, seqAdvancedAt)`. The recency input. */
  readonly lastActivityAt: number;
  /** `now - lastActivityAt` at snapshot time. */
  readonly ageMs: number;
  readonly recent: boolean;
}

/**
 * Everything the engine would otherwise have thrown, plus the diagnostics DoD
 * 4.5 requires by name. Read by tests instead of prose.
 */
export interface OcLivenessCounters {
  /** Poll attempts, degraded ones included. */
  polls: number;
  /** Polls that ended with the engine degraded. */
  degradedPolls: number;
  /** A poll re-entered while one was running. Should stay 0; counted anyway. */
  reentrantPollsSkipped: number;
  /** An unexpected throw inside `poll`. Stays 0; exists so it cannot crash. */
  pollErrors: number;
  /** `onUpdate` threw. The engine keeps polling (G2). */
  callbackErrors: number;
  /** WAL mtime events accepted as a wake signal. */
  wakes: number;
  /** Watcher-level failures, including a factory that threw on construction. */
  watchErrors: number;

  /** `session` rows read on the last successful poll. */
  sessionRows: number;
  /** `event_sequence` rows read on the last successful poll. */
  cursorRows: number;
  /** Sessions whose cursor was established without claiming an advance. */
  sessionsSeeded: number;
  /** Sessions with no `event_sequence` row at all. Rendered from row times. */
  sessionsWithoutCursor: number;
  /** `event_sequence` rows naming no `session` row. Counted, never refused. */
  cursorRowsWithoutSession: number;

  /** Times a session's seq was observed strictly greater than the cursor. */
  seqAdvances: number;
  /** DoD 4.5: seq observed BELOW last-seen. Never a refusal. */
  seqRegressions: number;
  /** Full `event` re-reads performed because of a regression. */
  fullRereads: number;
  /** `event` rows read for `seq` and `type` only. */
  eventsRead: number;
  /** Well-formed types outside {@link MEASURED_EVENT_TYPES}. */
  eventTypesUnknown: number;
  /** Type strings that are not name-plus-dotted-version. */
  eventTypesMalformed: number;
  /** The `event` scan threw. Liveness keeps answering from the cursor (G2). */
  eventScanFailures: number;

  /** `tool` part rows examined. Cumulative across polls. */
  toolPartsScanned: number;
  /** Of those, the ones counted as in flight. Cumulative across polls. */
  toolPartsRunning: number;
  /** `state.status === 'running'` WITH a `state.time.end`. Not run. */
  toolPartsRunningWithEnd: number;
  /** A `state.status` outside `running|completed|error`. Not run. */
  toolPartsUnknownStatus: number;
  /**
   * `part.data` that is not valid JSON, on the last successful part scan.
   * A GAUGE, not a running total. Skipped, never thrown (G3).
   */
  partRowsUnparseable: number;
  /** The `part` scan threw. Liveness keeps answering from the cursor (G2). */
  partScanFailures: number;
}

// ---------------------------------------------------------------------------
// Injection seams
// ---------------------------------------------------------------------------

/** A registered poll trigger. `stop` must be idempotent. */
export interface PollTriggerHandle {
  stop(): void;
}

/**
 * Registers `run` to be invoked roughly every `intervalMs`.
 *
 * Injected because A2 forbids a timer in this module: a liveness test that
 * waits on a real interval measures the machine it ran on. Production supplies
 * a `setInterval` wrapper from `src/opencode/index.ts`; tests supply a handle
 * they fire by hand.
 */
export type PollTrigger = (run: () => void, intervalMs: number) => PollTriggerHandle;

/** Callbacks a WAL watch delivers. Neither may throw into the watcher. */
export interface WalWatchCallbacks {
  /** The WAL's mtime changed — or it appeared, or it went away. */
  onWake: () => void;
  /** A watcher-level failure. Counted, never rethrown. */
  onError: (error: unknown) => void;
}

export interface WalWatchHandle {
  close(): void;
}

/**
 * Constructs a watch on one `opencode.db-wal` path. Injected so a test can
 * deliver a wake synchronously; one test drives the real `chokidar` factory
 * over a real temp directory, because a suite that only ever exercises the
 * fake proves nothing about the library we ship.
 */
export type WalWatchFactory = (walPath: string, callbacks: WalWatchCallbacks) => WalWatchHandle;

/**
 * Resolve a path so it is safe to hand to a filesystem watch.
 *
 * **libuv ABORTS the process when a watched path has an 8.3 short component** —
 * `Assertion failed: !_wcsnicmp(filename, dir, dirlen), src\win\fs-event.c:72`
 * — with no failing assertion to read and no summary line. GitHub's Windows
 * runners hand back `C:\Users\RUNNER~1\AppData\Local\Temp` from `os.tmpdir()`,
 * which is exactly that shape.
 *
 * The WAL file itself may not exist yet (a checkpointed database has none), so
 * the real path is taken of its DIRECTORY and the basename rejoined.
 */
export function resolveWatchPath(walPath: string): string {
  const absolute = resolvePath(walPath);
  const dir = dirname(absolute);
  try {
    return join(realpathSync.native(dir), basename(absolute));
  } catch {
    // The directory is gone. Nothing to watch; hand back what we were given so
    // the caller degrades on the missing database rather than throwing here.
    return absolute;
  }
}

/**
 * The production WAL watch.
 *
 * `depth: 0` and a single file path: this watches one file's mtime and nothing
 * else. `ignoreInitial: true` because {@link OcLivenessEngine.start} polls once
 * itself; replaying the file as an `add` would only debounce into the same
 * poll. There is no `awaitWriteFinish` — SQLite writes the WAL continuously and
 * waiting for it to settle would be waiting for the session to end.
 */
export function createWalWatchFactory(): WalWatchFactory {
  return (walPath, callbacks) => {
    const watcher: FSWatcher = chokidarWatch(resolveWatchPath(walPath), {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      depth: 0,
      alwaysStat: false,
      awaitWriteFinish: false,
      atomic: false,
      ignorePermissionErrors: true,
    });
    watcher.on('all', () => {
      callbacks.onWake();
    });
    watcher.on('error', (error: unknown) => {
      callbacks.onError(error);
    });
    return {
      close: () => {
        void watcher.close();
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OcLivenessEngineOptions {
  /** Absolute path of the `opencode.db` to observe. Opened READ-ONLY, always. */
  dbPath: string;
  /** Injected clock (A2). There is no default: a default would be `Date.now`. */
  now: () => number;
  /** Defaults to {@link DEFAULT_OC_LIVENESS_THRESHOLD_MS}. */
  thresholdMs?: number;
  /** Defaults to {@link DEFAULT_OC_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Omitted = {@link OcLivenessEngine.start} registers nothing and the caller polls. */
  pollTrigger?: PollTrigger;
  /** Omitted = no wake signal; the trigger's interval is the only cadence. */
  walWatchFactory?: WalWatchFactory;
  /** Called after every poll attempt. May throw; the throw is counted (G2). */
  onUpdate?: (snapshots: readonly OcSessionLiveness[], health: OcEngineHealth) => void;
}

// ---------------------------------------------------------------------------
// SQL — every statement here is a READ
// ---------------------------------------------------------------------------

/**
 * `json_extract` raises an SQLite error on malformed JSON, which would abort
 * the whole statement and take a content problem into liveness's own path. The
 * `CASE` makes every extraction total: an unparseable `data` reads as `{}`,
 * its `type` is NULL, and it simply does not match. `partRowsUnparseable`
 * counts them separately.
 */
const SAFE_JSON = "CASE WHEN json_valid(data) THEN data ELSE '{}' END";

const SQL_SESSIONS =
  'SELECT id, parent_id, version, time_updated, time_archived FROM session';

const SQL_CURSORS = 'SELECT aggregate_id, seq, owner_id FROM event_sequence';

/** OC4: `seq` and `type` ONLY. The `data` column is never selected. */
const SQL_EVENTS_SINCE =
  'SELECT seq, type FROM event WHERE aggregate_id = ? AND seq > ? ORDER BY seq';

const SQL_EVENTS_ALL =
  'SELECT seq, type FROM event WHERE aggregate_id = ? ORDER BY seq';

const SQL_TOOL_PARTS = [
  'SELECT id AS part_id, session_id AS sid,',
  ` json_extract(${SAFE_JSON}, '$.callID') AS call_id,`,
  ` json_extract(${SAFE_JSON}, '$.state.status') AS status,`,
  ` json_extract(${SAFE_JSON}, '$.state.time.end') AS time_end`,
  ' FROM part',
  ` WHERE json_extract(${SAFE_JSON}, '$.type') = 'tool'`,
].join('');

const SQL_UNPARSEABLE_PARTS = 'SELECT count(*) AS n FROM part WHERE json_valid(data) = 0';

/** Cheap proof the handle can actually read the file's header. */
const SQL_OPEN_PROBE = 'SELECT count(*) AS n FROM sqlite_master';

// ---------------------------------------------------------------------------
// Narrowing helpers — `all()` returns `Record<string, SQLOutputValue>`
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return 'unstringifiable error';
  }
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface SessionCursor {
  sessionId: string;
  lastSeq: number;
  /** Injected-clock value at the last observed advance. */
  seqAdvancedAt?: number;
  /** True until an advance has been seen. A baseline is not activity. */
  seeded: boolean;
}

interface SessionFacts {
  sessionId: string;
  parentId: string | null;
  version: string;
  timeUpdated: number;
  timeArchived: number | null;
  runningTools: OcRunningTool[];
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Per-session OpenCode liveness by event cursor. One instance per observed
 * database; in-memory only (G7).
 *
 * The engine holds no database handle between polls. It opens read-only, reads,
 * and closes inside {@link poll}. That is deliberate on two counts: a handle
 * held open pins the file on Windows (and the "delete the database mid-poll"
 * case has to be observable), and a read-only open against a live WAL database
 * was measured at 20/20 successes, 0 `SQLITE_BUSY`, slowest open 2 ms
 * (contract §D2), so there is nothing to amortise.
 */
export class OcLivenessEngine {
  readonly dbPath: string;

  readonly walPath: string;

  readonly pollIntervalMs: number;

  private readonly nowFn: () => number;

  private thresholdValue: number;

  private readonly pollTrigger?: PollTrigger;

  private readonly walWatchFactory?: WalWatchFactory;

  private readonly onUpdate?: (
    snapshots: readonly OcSessionLiveness[],
    health: OcEngineHealth,
  ) => void;

  private readonly cursors = new Map<string, SessionCursor>();

  private readonly facts = new Map<string, SessionFacts>();

  private healthState: OcEngineHealth = { ok: true };

  private triggerHandle?: PollTriggerHandle;

  private watchHandle?: WalWatchHandle;

  private started = false;

  private disposed = false;

  private polling = false;

  private lastErrorMessage?: string;

  private readonly counts: OcLivenessCounters = {
    polls: 0,
    degradedPolls: 0,
    reentrantPollsSkipped: 0,
    pollErrors: 0,
    callbackErrors: 0,
    wakes: 0,
    watchErrors: 0,
    sessionRows: 0,
    cursorRows: 0,
    sessionsSeeded: 0,
    sessionsWithoutCursor: 0,
    cursorRowsWithoutSession: 0,
    seqAdvances: 0,
    seqRegressions: 0,
    fullRereads: 0,
    eventsRead: 0,
    eventTypesUnknown: 0,
    eventTypesMalformed: 0,
    eventScanFailures: 0,
    toolPartsScanned: 0,
    toolPartsRunning: 0,
    toolPartsRunningWithEnd: 0,
    toolPartsUnknownStatus: 0,
    partRowsUnparseable: 0,
    partScanFailures: 0,
  };

  constructor(options: OcLivenessEngineOptions) {
    this.dbPath = options.dbPath;
    this.walPath = walPathFor(options.dbPath);
    this.nowFn = options.now;
    this.thresholdValue = options.thresholdMs ?? DEFAULT_OC_LIVENESS_THRESHOLD_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_OC_POLL_INTERVAL_MS;
    if (options.pollTrigger) this.pollTrigger = options.pollTrigger;
    if (options.walWatchFactory) this.walWatchFactory = options.walWatchFactory;
    if (options.onUpdate) this.onUpdate = options.onUpdate;
  }

  /**
   * Poll once, then register the wake signal and the interval trigger.
   *
   * Never throws: a watch factory that throws on construction is counted in
   * {@link OcLivenessCounters.watchErrors} and the engine runs on the trigger
   * alone.
   */
  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    this.poll();
    if (this.walWatchFactory !== undefined) {
      try {
        this.watchHandle = this.walWatchFactory(this.walPath, {
          onWake: () => {
            if (this.disposed) return;
            this.counts.wakes += 1;
            this.poll();
          },
          onError: (error: unknown) => {
            this.counts.watchErrors += 1;
            this.lastErrorMessage = errorMessage(error);
          },
        });
      } catch (error) {
        this.counts.watchErrors += 1;
        this.lastErrorMessage = errorMessage(error);
      }
    }
    if (this.pollTrigger !== undefined) {
      try {
        this.triggerHandle = this.pollTrigger(() => {
          this.poll();
        }, this.pollIntervalMs);
      } catch (error) {
        this.counts.pollErrors += 1;
        this.lastErrorMessage = errorMessage(error);
      }
    }
  }

  /** Idempotent. After this the engine polls nothing and holds nothing. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.watchHandle?.close();
    } catch (error) {
      this.counts.watchErrors += 1;
      this.lastErrorMessage = errorMessage(error);
    }
    try {
      this.triggerHandle?.stop();
    } catch (error) {
      this.counts.pollErrors += 1;
      this.lastErrorMessage = errorMessage(error);
    }
    delete this.watchHandle;
    delete this.triggerHandle;
  }

  /**
   * One read pass. **Never throws** (G3).
   *
   * A missing/unopenable/unreadable database degrades the ENGINE and leaves the
   * per-session facts from the last good poll in place — they age out through
   * the injected clock on their own, which is the honest behaviour: the engine
   * has stopped seeing, it has not learned that anything ended.
   */
  poll(): void {
    if (this.disposed) return;
    if (this.polling) {
      this.counts.reentrantPollsSkipped += 1;
      return;
    }
    this.polling = true;
    try {
      this.runPoll();
    } catch (error) {
      this.counts.pollErrors += 1;
      this.lastErrorMessage = errorMessage(error);
    } finally {
      this.polling = false;
    }
    this.emit();
  }

  health(): OcEngineHealth {
    return this.healthState;
  }

  /** DoD 4.5's `engineDegraded`, as a boolean for callers that want one. */
  isDegraded(): boolean {
    return !this.healthState.ok;
  }

  counters(): OcLivenessCounters {
    return { ...this.counts };
  }

  /** Message of the most recent failure of any kind, if there has been one. */
  lastFailure(): string | undefined {
    return this.lastErrorMessage;
  }

  get thresholdMs(): number {
    return this.thresholdValue;
  }

  /** Runtime-configurable, for a `agentDeck.livenessThresholdMs` change. */
  setThresholdMs(ms: number): void {
    const value = asNumber(ms);
    if (value === undefined || value < 0) return;
    this.thresholdValue = value;
  }

  sessionIds(): string[] {
    return [...this.facts.keys()];
  }

  snapshot(sessionId: string): OcSessionLiveness | undefined {
    const fact = this.facts.get(sessionId);
    if (fact === undefined) return undefined;
    return this.snapshotOf(fact, this.nowFn());
  }

  snapshotAll(): readonly OcSessionLiveness[] {
    const now = this.nowFn();
    return [...this.facts.values()].map((fact) => this.snapshotOf(fact, now));
  }

  /** Convenience for callers that only need the enum. */
  livenessOf(sessionId: string): OcLiveness | undefined {
    return this.snapshot(sessionId)?.liveness;
  }

  /** The cursor as this engine last saw it. Exposed so a test can pin OC4. */
  cursorOf(sessionId: string): number | undefined {
    return this.cursors.get(sessionId)?.lastSeq;
  }

  // -------------------------------------------------------------------------
  // Poll internals
  // -------------------------------------------------------------------------

  private runPoll(): void {
    this.counts.polls += 1;
    const now = this.nowFn();

    if (!existsSync(this.dbPath)) {
      this.degrade('databaseMissing', 'the opencode.db file is not there');
      return;
    }

    const db = this.openReadOnly();
    if (db === undefined) return;

    try {
      this.readLivenessTables(db, now);
      this.healthState = { ok: true };
    } catch (error) {
      // `session` and `event_sequence` ARE liveness's data. Losing them is a
      // degraded engine, not a per-session refusal.
      this.degrade('databaseCorrupt', errorMessage(error));
      return;
    } finally {
      try {
        db.close();
      } catch (error) {
        this.lastErrorMessage = errorMessage(error);
      }
    }
  }

  /**
   * Read-only open plus a header probe, as one step.
   *
   * The probe is what separates {@link OcDegradeCode} `databaseUnreadable` from
   * `databaseCorrupt`: `DatabaseSync` defers reading the file header, so a
   * present-but-not-a-database file OPENS happily and only fails on the first
   * statement. Probing here keeps that case on the "would not open" side, which
   * is where `synthetic.ts`'s `writeNonDatabase` documents it belongs, and
   * leaves `databaseCorrupt` for a file SQLite agreed was a database and then
   * could not walk.
   *
   * Returns `undefined` after recording the degradation. Never throws.
   */
  private openReadOnly(): DatabaseSync | undefined {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      db.prepare(SQL_OPEN_PROBE).get();
      return db;
    } catch (error) {
      if (db !== undefined) {
        try {
          db.close();
        } catch {
          // Already unusable; the degradation below is the report.
        }
      }
      this.degrade('databaseUnreadable', errorMessage(error));
      return undefined;
    }
  }

  /** Throws only for `session` / `event_sequence`. Everything else is wrapped. */
  private readLivenessTables(db: DatabaseSync, now: number): void {
    const sessionRows: Row[] = db.prepare(SQL_SESSIONS).all();
    const cursorRows: OcEventSequenceRow[] = (db.prepare(SQL_CURSORS).all() as Row[])
      .map((row) => ({
        aggregateId: asString(row['aggregate_id']) ?? '',
        seq: asNumber(row['seq']) ?? 0,
        ownerId: asString(row['owner_id']) ?? null,
      }))
      .filter((row) => row.aggregateId.length > 0);

    this.counts.sessionRows = sessionRows.length;
    this.counts.cursorRows = cursorRows.length;

    const seqBySession = new Map<string, number>();
    for (const row of cursorRows) seqBySession.set(row.aggregateId, row.seq);

    const runningBySession = this.scanRunningTools(db);

    const seen = new Set<string>();
    for (const row of sessionRows) {
      const sessionId = asString(row['id']);
      if (sessionId === undefined || sessionId.length === 0) continue;
      seen.add(sessionId);

      this.facts.set(sessionId, {
        sessionId,
        parentId: asString(row['parent_id']) ?? null,
        version: asString(row['version']) ?? '',
        timeUpdated: asNumber(row['time_updated']) ?? 0,
        timeArchived: asNumber(row['time_archived']) ?? null,
        runningTools: runningBySession.get(sessionId) ?? [],
      });

      const observed = seqBySession.get(sessionId);
      if (observed === undefined) {
        this.counts.sessionsWithoutCursor += 1;
        continue;
      }
      this.advanceCursor(db, sessionId, observed, now);
    }

    for (const row of cursorRows) {
      if (!seen.has(row.aggregateId)) this.counts.cursorRowsWithoutSession += 1;
    }

    // A session that vanished from the table is dropped rather than frozen.
    for (const sessionId of [...this.facts.keys()]) {
      if (!seen.has(sessionId)) {
        this.facts.delete(sessionId);
        this.cursors.delete(sessionId);
      }
    }
  }

  /**
   * The cursor rule, in one place (OC4).
   *
   * Three arms, and the third is the one the spec argues for at length:
   * seed (no advance claimed) · advance (activity, at the injected clock) ·
   * regression (full re-read plus a counter, NEVER a refusal).
   */
  private advanceCursor(
    db: DatabaseSync,
    sessionId: string,
    observed: number,
    now: number,
  ): void {
    const cursor = this.cursors.get(sessionId);

    if (cursor === undefined) {
      this.counts.sessionsSeeded += 1;
      this.cursors.set(sessionId, { sessionId, lastSeq: observed, seeded: true });
      return;
    }

    if (observed > cursor.lastSeq) {
      this.counts.seqAdvances += 1;
      this.scanEventTypes(db, SQL_EVENTS_SINCE, [sessionId, cursor.lastSeq]);
      cursor.lastSeq = observed;
      cursor.seqAdvancedAt = now;
      cursor.seeded = false;
      return;
    }

    if (observed < cursor.lastSeq) {
      // OC4: the table is ASSUMED never trimmed, and that assumption has an
      // absence over two hours behind it, not a guarantee. Re-read; do not
      // refuse. The cursor takes the observed value so the next poll compares
      // against reality rather than against a value that no longer exists.
      this.counts.seqRegressions += 1;
      this.counts.fullRereads += 1;
      this.scanEventTypes(db, SQL_EVENTS_ALL, [sessionId]);
      cursor.lastSeq = observed;
      // A re-read is not activity. `seqAdvancedAt` is deliberately untouched.
      return;
    }
    // observed === cursor.lastSeq: nothing happened. Not an error, not activity.
  }

  /**
   * Read `seq` and `type` for a range of events and classify the types BY FORM.
   *
   * G2 inside the engine: this is diagnostics, not liveness. A throw here is
   * counted and swallowed — the cursor has already told us what we needed.
   */
  private scanEventTypes(
    db: DatabaseSync,
    sql: string,
    params: readonly (string | number)[],
  ): void {
    try {
      const rows: Row[] = db.prepare(sql).all(...params);
      for (const row of rows) {
        this.counts.eventsRead += 1;
        const type = asString(row['type']);
        if (type === undefined || !EVENT_TYPE_FORM.test(type)) {
          this.counts.eventTypesMalformed += 1;
          continue;
        }
        if (!MEASURED_EVENT_TYPES.has(type)) this.counts.eventTypesUnknown += 1;
      }
    } catch (error) {
      this.counts.eventScanFailures += 1;
      this.lastErrorMessage = errorMessage(error);
    }
  }

  /**
   * In-flight tool calls, per session.
   *
   * The rule is the contract's, verbatim: a `tool` part whose `state.status` is
   * `running` **with no `state.time.end`**. It is a conjunction, and the two
   * disagreement cases are counted rather than guessed at —
   * `running` with an `end` is `toolPartsRunningWithEnd`, and a status outside
   * `running|completed|error` is `toolPartsUnknownStatus`. Neither is treated
   * as in flight, because a tool call we cannot classify is not evidence that
   * something is executing.
   *
   * G2 inside the engine: a throw here leaves the map empty and liveness
   * unaffected.
   */
  private scanRunningTools(db: DatabaseSync): Map<string, OcRunningTool[]> {
    const byS = new Map<string, OcRunningTool[]>();
    try {
      const unparseable = db.prepare(SQL_UNPARSEABLE_PARTS).get() as Row | undefined;
      this.counts.partRowsUnparseable = asNumber(unparseable?.['n']) ?? 0;

      const rows: Row[] = db.prepare(SQL_TOOL_PARTS).all();
      for (const row of rows) {
        this.counts.toolPartsScanned += 1;
        const sessionId = asString(row['sid']);
        if (sessionId === undefined) continue;
        const status = asString(row['status']);
        if (status === undefined) {
          this.counts.toolPartsUnknownStatus += 1;
          continue;
        }
        if (status !== 'running') {
          if (status !== 'completed' && status !== 'error') {
            this.counts.toolPartsUnknownStatus += 1;
          }
          continue;
        }
        if (asNumber(row['time_end']) !== undefined) {
          this.counts.toolPartsRunningWithEnd += 1;
          continue;
        }
        const partId = asString(row['part_id']) ?? '';
        const callId = asString(row['call_id']) ?? partId;
        const list = byS.get(sessionId);
        const entry: OcRunningTool = { callId, partId };
        if (list === undefined) byS.set(sessionId, [entry]);
        else list.push(entry);
        this.counts.toolPartsRunning += 1;
      }
      for (const list of byS.values()) {
        list.sort((a, b) => (a.callId < b.callId ? -1 : a.callId > b.callId ? 1 : 0));
      }
    } catch (error) {
      this.counts.partScanFailures += 1;
      this.lastErrorMessage = errorMessage(error);
      byS.clear();
    }
    return byS;
  }

  private degrade(code: OcDegradeCode, message: string): void {
    this.counts.degradedPolls += 1;
    this.lastErrorMessage = message;
    this.healthState = { ok: false, code, message, path: this.dbPath };
  }

  private emit(): void {
    if (this.onUpdate === undefined) return;
    try {
      this.onUpdate(this.snapshotAll(), this.healthState);
    } catch (error) {
      this.counts.callbackErrors += 1;
      this.lastErrorMessage = errorMessage(error);
    }
  }

  /**
   * DoD 4.5's decision table, and nothing else lives in it:
   *
   *   `time_archived` set          -> `ended`
   *   new seq / row touched inside the threshold -> `live`
   *   otherwise                    -> `idle`
   *
   * `time_archived` wins outright. An archived session with a recent row touch
   * is over — the touch is the archiving.
   *
   * `session.time_updated` participates alongside the observed seq advance for
   * the same reason CC's engine uses the transcript mtime: on the FIRST poll a
   * cursor is only a baseline, and without the row's own timestamp every
   * session in the database would read `idle` for up to a threshold after the
   * extension starts, including one that is visibly running.
   */
  private snapshotOf(fact: SessionFacts, now: number): OcSessionLiveness {
    const cursor = this.cursors.get(fact.sessionId);
    const advancedAt = cursor?.seqAdvancedAt;
    const lastActivityAt =
      advancedAt === undefined ? fact.timeUpdated : Math.max(fact.timeUpdated, advancedAt);
    const ageMs = now - lastActivityAt;
    const recent = ageMs <= this.thresholdValue;

    const liveness: OcLiveness =
      fact.timeArchived !== null ? 'ended' : recent ? 'live' : 'idle';

    return {
      sessionId: fact.sessionId,
      parentId: fact.parentId,
      version: fact.version,
      liveness,
      toolStatus: fact.runningTools.length > 0 ? 'running' : 'done',
      runningToolCount: fact.runningTools.length,
      runningTools: fact.runningTools,
      cursorSeeded: cursor?.seeded ?? false,
      timeUpdated: fact.timeUpdated,
      timeArchived: fact.timeArchived,
      lastActivityAt,
      ageMs,
      recent,
      ...(cursor !== undefined ? { seq: cursor.lastSeq } : {}),
      ...(advancedAt !== undefined ? { seqAdvancedAt: advancedAt } : {}),
    };
  }
}
