/**
 * The extension API — v0.7.0 Phase 5, DoD 5.1 and 5.2 (spec §H, Component 10).
 *
 * The door for Layer 2. `activate()` returns an {@link AgentDeckApi}, so another
 * extension reaches it as
 *
 *     vscode.extensions.getExtension('nvitlam.agent-deck')?.exports
 *
 * and gets exactly three things: the live records, the stored records, and an
 * event. It gets `StatsRecord`s and nothing else.
 *
 * ## What crosses this door, and what never does
 *
 * Spec §H: *"Exposes `StatsRecord` only — never `SessionState`, never previews,
 * never a non-allow-listed string."* Two checks enforce it at RUNTIME, on every
 * record, in production, before a consumer sees it — not in a test only:
 *
 *   1. {@link validateStatsRecord}, the G4 allow-list. It rejects any
 *      string-valued key off the list, at any depth.
 *   2. {@link MODEL_ONLY_KEYS}, a walk for any key that exists on
 *      `SessionState`, `AgentNode` or `ToolNode` and not on a record.
 *
 * The second is not redundant with the first, and the reason is the whole of
 * why it exists: the validator judges STRINGS. A record that had acquired
 * `usageSeries` — an `AgentNode` field whose every value is a number — would
 * sail through it. So would `spawnEdges`' depths, `children: []`, and a
 * `contextNow` pair. A key walk catches a model field by its NAME whatever its
 * value is.
 *
 * `api.test.ts` ties that list to the types: a type-level guard fails to
 * compile if `events.ts` gains a key the list does not name, or if a
 * `StatsRecord` ever carries a key that is on it.
 *
 * A record failing either check is DROPPED and counted on {@link ApiCounters}
 * — never repaired, never partially handed out (G3). The deriver and the store
 * both already refuse such records upstream, so a drop here is a defect report
 * about one of them, and the diagnostics channel says so.
 *
 * ## Copies, never the held objects
 *
 * Every record handed out is a fresh deep copy, per call and per listener. The
 * pipeline holds its records and compares their serialised bodies to decide
 * what to write; a consumer that mutated a record it was given would otherwise
 * be editing the next line the store appends. Records are JSON by construction
 * (they are stringified to be compared and to be stored), so a JSON round trip
 * is an exact copy.
 *
 * ## The event (DoD 5.2 — locked open question, user, 2026-09-05)
 *
 * *"`onDidUpdateStats` fires on every `ended` and idle flush, plus a throttled
 * live event at most once per 2 s per session."* {@link StatsUpdateEmitter} is
 * that sentence: `flushed()` delivers at once, `live()` delivers at most once per
 * {@link LIVE_EVENT_MIN_INTERVAL_MS} per session, leading edge plus one
 * trailing delivery carrying the newest record, so the last change in a burst
 * is never lost to the throttle. A flush cancels a pending trailing delivery
 * for its session — the flushed record is at least as new — and restarts that
 * session's window.
 *
 * Which sessions produce live events is the pipeline's decision, not this
 * module's, and it is the same decision the store makes: only sessions whose
 * LIVENESS has reported work in this process (DoD 4.11b). A window reload reads
 * a whole history off disk and every one of those records changes while it is
 * being read; an event per change would be the store flood re-created on the
 * API. `getLiveStats()` still returns those records — it is a snapshot of what
 * is derived, not a claim that anything happened.
 *
 * ## No `vscode` import
 *
 * The event type is structural and identical in shape to `vscode.Event<T>`, so
 * a consumer can use it exactly as it would use one, and this module stays
 * testable in a plain node process with an injected clock.
 */

import type { Scheduler, TimerHandle } from './parser/tailer.js';
import type { StatsRecord } from './stats/schema.js';
import { validateStatsRecord } from './stats/schema.js';
import type { StoredStatsRecord } from './stats/store.js';

/** The API's version. Bumped on a breaking change; additive fields do not bump it. */
export const API_VERSION = 1;

/**
 * The live event's per-session floor, in milliseconds. The locked number
 * (user, 2026-09-05). Flush events are not throttled.
 */
export const LIVE_EVENT_MIN_INTERVAL_MS = 2_000;

/** `vscode.Disposable`'s shape. */
export interface ApiDisposable {
  dispose(): unknown;
}

/** `vscode.Event<T>`'s shape: subscribe, get a disposable back. */
export type ApiEvent<T> = (
  listener: (event: T) => unknown,
  thisArgs?: unknown,
  disposables?: ApiDisposable[],
) => ApiDisposable;

/** What {@link AgentDeckApi.getStoredStats} can be asked for. Both optional. */
export interface StoredStatsQuery {
  /** Drop records the store stamped before this instant (epoch ms). */
  sinceMs?: number;
  /** At most this many, newest first, after the newest-per-session reduction. */
  limit?: number;
}

/**
 * What `activate()` returns. Spec §H, with two things stated that the spec
 * leaves implicit:
 *
 *   - `getStoredStats` returns records as the store holds them, which is a
 *     `StatsRecord` plus the store's `derivedAt` stamp — the instant a record
 *     was written, and the field `sinceMs` filters on. A subtype, so a caller
 *     written against the spec's `StatsRecord[]` is unaffected.
 *   - Its argument is optional. `getStoredStats({})` and `getStoredStats()`
 *     are the same call.
 */
export interface AgentDeckApi {
  readonly apiVersion: typeof API_VERSION;
  /** The newest derived record per session this window is observing. */
  getLiveStats(): StatsRecord[];
  /** The stored history: newest per session, newest first. `[]` when disabled. */
  getStoredStats(query?: StoredStatsQuery): Promise<StoredStatsRecord[]>;
  /** Every flush, plus a live event at most once per 2 s per session. */
  readonly onDidUpdateStats: ApiEvent<StatsRecord>;
}

/**
 * Keys that exist on `SessionState`, `AgentNode` or `ToolNode` and on no
 * `StatsRecord`. A record carrying one, at any depth, is refused.
 *
 * Written out rather than derived because types do not exist at runtime; the
 * type-level guard in `api.test.ts` is what keeps this list complete.
 */
export const MODEL_ONLY_KEYS = [
  // SessionState
  'workspaceMatch',
  'liveness',
  'schemaOk',
  'root',
  'telemetryCostUsd',
  'telemetrySessionCountSeen',
  'contextNow',
  'burn',
  'spawnEdges',
  'parked',
  'windowTokens',
  // AgentNode
  'id',
  'label',
  'status',
  'children',
  'usageSeries',
  // ToolNode
  'stalledSinceMs',
  'inputPreview',
  'inputHash',
  'resultPreview',
  'truncated',
] as const;

/**
 * Keys a model type and a record BOTH carry, with different meanings or the
 * same one. Exported for `api.test.ts`'s type-level guard, which proves that
 * this list plus {@link MODEL_ONLY_KEYS} covers every model key — so a key
 * added to `events.ts` has to be put on one list or the other, deliberately.
 */
export const MODEL_SHARED_KEYS = [
  'sessionId',
  'projectSlug',
  'totals',
  'engine',
  'kind',
  'spawnDepth',
  'model',
  'compactions',
  'startedAt',
  'endedAt',
  'toolName',
  'filePath',
  'ordinal',
  'durationMs',
] as const;

const MODEL_ONLY: ReadonlySet<string> = new Set(MODEL_ONLY_KEYS);

/** The first model-only key found anywhere in a value, as a path, or null. */
export function modelKeyIn(value: unknown, path = ''): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = modelKeyIn(value[i], `${path}[${String(i)}]`);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const at = path === '' ? key : `${path}.${key}`;
      if (MODEL_ONLY.has(key)) return at;
      const hit = modelKeyIn(child, at);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/** Why a record was refused at the door, or null when it may pass. */
export function refusalOf(record: unknown): string | null {
  const validation = validateStatsRecord(record);
  if (!validation.ok) return validation.errors[0] ?? 'invalid record';
  const leaked = modelKeyIn(record);
  if (leaked !== null) return `model-only key at ${leaked}`;
  return null;
}

/** A deep copy. Records are JSON by construction; see the module header. */
function copyOf<T>(record: T): T {
  return JSON.parse(JSON.stringify(record)) as T;
}

/** What the API reads from. Injected, so a test can drive every branch. */
export interface ApiSources {
  /** The pipeline's live records, or `[]` in a window with no pipeline. */
  liveRecords(): readonly StatsRecord[];
  /** The store's reduced history, or `[]` when the store is off or absent. */
  readStored(query: StoredStatsQuery): readonly StoredStatsRecord[];
}

/** Records refused at the door, and listener throws. In-memory, per window. */
export interface ApiCounters {
  refused: number;
  listenerErrors: number;
}

export interface StatsUpdateEmitterOptions {
  now: () => number;
  scheduler: Scheduler;
  /** Overrides {@link LIVE_EVENT_MIN_INTERVAL_MS}. Tests only; production uses the constant. */
  minIntervalMs?: number;
  /** A record refused at the door, or a listener that threw. Never rethrown. */
  onError?: (error: unknown) => void;
}

/** One session's throttle state. */
interface Throttle {
  /** When a LIVE event (or a flush) was last delivered for this session. */
  lastAt: number;
  /** The newest record held back by the throttle, or null. */
  pending: StatsRecord | null;
  timer: TimerHandle | null;
}

/**
 * The `onDidUpdateStats` source. The pipeline calls {@link live} and
 * {@link flushed}; consumers subscribe through {@link event}.
 */
export class StatsUpdateEmitter {
  readonly counters: ApiCounters = { refused: 0, listenerErrors: 0 };

  readonly #now: () => number;
  readonly #scheduler: Scheduler;
  readonly #minIntervalMs: number;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #listeners = new Set<(event: StatsRecord) => unknown>();
  readonly #throttles = new Map<string, Throttle>();
  #disposed = false;

  constructor(options: StatsUpdateEmitterOptions) {
    this.#now = options.now;
    this.#scheduler = options.scheduler;
    this.#minIntervalMs = options.minIntervalMs ?? LIVE_EVENT_MIN_INTERVAL_MS;
    this.#onError = options.onError;
  }

  /** Subscribe. The shape of `vscode.Event<StatsRecord>`. */
  readonly event: ApiEvent<StatsRecord> = (listener, thisArgs, disposables) => {
    const bound = thisArgs === undefined ? listener : listener.bind(thisArgs);
    this.#listeners.add(bound);
    const disposable: ApiDisposable = {
      dispose: () => {
        this.#listeners.delete(bound);
      },
    };
    disposables?.push(disposable);
    return disposable;
  };

  /** Subscribers right now. Read by tests. */
  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** Trailing deliveries waiting on the throttle. Must be 0 after {@link dispose}. */
  get pendingLive(): number {
    let pending = 0;
    for (const throttle of this.#throttles.values()) if (throttle.timer !== null) pending += 1;
    return pending;
  }

  /**
   * A session's record changed. Delivered now if this session has had no event
   * for {@link LIVE_EVENT_MIN_INTERVAL_MS}, otherwise held and delivered once
   * the window closes — the newest record, once.
   */
  live(record: StatsRecord): void {
    if (this.#disposed) return;
    const now = this.#now();
    const held = this.#throttles.get(record.sessionId);
    if (held === undefined || now - held.lastAt >= this.#minIntervalMs) {
      if (held !== undefined && held.timer !== null) this.#scheduler.clearTimer(held.timer);
      this.#throttles.set(record.sessionId, { lastAt: now, pending: null, timer: null });
      this.#deliver(record);
      return;
    }
    held.pending = record;
    if (held.timer !== null) return;
    held.timer = this.#scheduler.setTimer(() => {
      held.timer = null;
      const next = held.pending;
      held.pending = null;
      if (this.#disposed || next === null) return;
      held.lastAt = this.#now();
      this.#deliver(next);
    }, held.lastAt + this.#minIntervalMs - now);
  }

  /**
   * A record was written — on `ended` or on the idle flush. Delivered at once,
   * never throttled. A trailing live delivery waiting for this session is
   * dropped: the flushed record is at least as new, and delivering the older
   * one after it would put a stale record last.
   */
  flushed(record: StatsRecord): void {
    if (this.#disposed) return;
    const held = this.#throttles.get(record.sessionId);
    if (held !== undefined && held.timer !== null) this.#scheduler.clearTimer(held.timer);
    this.#throttles.set(record.sessionId, { lastAt: this.#now(), pending: null, timer: null });
    this.#deliver(record);
  }

  /** Drop every listener and every pending delivery. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const throttle of this.#throttles.values()) {
      if (throttle.timer !== null) this.#scheduler.clearTimer(throttle.timer);
    }
    this.#throttles.clear();
    this.#listeners.clear();
  }

  /** Check once, then hand every listener its own copy. */
  #deliver(record: StatsRecord): void {
    if (this.#listeners.size === 0) return;
    const refusal = refusalOf(record);
    if (refusal !== null) {
      this.counters.refused += 1;
      this.#report(new Error(`api: refused a record for ${record.sessionId}: ${refusal}`));
      return;
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(copyOf(record));
      } catch (error) {
        // Another extension's listener throwing must not reach the pipeline,
        // the store or the deck (G2) — nor stop the next listener hearing.
        this.counters.listenerErrors += 1;
        this.#report(error);
      }
    }
  }

  #report(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // A reporting sink that throws must not break what it reports on.
    }
  }
}

/** Throws on a query this API would otherwise have to guess about. */
function checkQuery(query: StoredStatsQuery): void {
  if (typeof query !== 'object' || query === null) {
    throw new TypeError('getStoredStats: the query must be an object');
  }
  const { sinceMs, limit } = query;
  if (sinceMs !== undefined && (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs))) {
    throw new TypeError('getStoredStats: sinceMs must be a finite number');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new TypeError('getStoredStats: limit must be a non-negative integer');
  }
}

/**
 * Build the object `activate()` returns. Frozen: a consumer cannot replace a
 * method on it for every other consumer.
 */
export function createAgentDeckApi(
  sources: ApiSources,
  updates: StatsUpdateEmitter,
  onRefused?: (reason: string) => void,
): AgentDeckApi {
  const passing = <T extends StatsRecord>(records: readonly T[]): T[] => {
    const out: T[] = [];
    for (const record of records) {
      const refusal = refusalOf(record);
      if (refusal !== null) {
        updates.counters.refused += 1;
        onRefused?.(`api: refused a record for ${record.sessionId}: ${refusal}`);
        continue;
      }
      out.push(copyOf(record));
    }
    return out;
  };
  return Object.freeze({
    apiVersion: API_VERSION,
    getLiveStats: (): StatsRecord[] => passing(sources.liveRecords()),
    getStoredStats: async (query: StoredStatsQuery = {}): Promise<StoredStatsRecord[]> => {
      checkQuery(query);
      const bounded: StoredStatsQuery = {};
      if (query.sinceMs !== undefined) bounded.sinceMs = query.sinceMs;
      if (query.limit !== undefined) bounded.limit = query.limit;
      // One turn of the loop first, so the read never runs inside the caller's
      // own stack: a full retention window is tens of milliseconds of reading.
      await Promise.resolve();
      return passing(sources.readStored(bounded));
    },
    onDidUpdateStats: updates.event,
  });
}
