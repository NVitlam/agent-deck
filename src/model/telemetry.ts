/**
 * Agent Deck — Component 12's host module (v0.7.1 Phase 6, DoD 6.3).
 *
 * The one production caller of the telemetry join. It subscribes to the shared
 * listener's telemetry slices (the route's output on the leader, the relay's on
 * a follower — identical by construction) and applies them to the LIVE session
 * states this window already emits.
 *
 * ---------------------------------------------------------------------------
 * TELEMETRY IS CONTENT, NEVER ACTIVITY (locked ruling, 2026-09-10)
 * ---------------------------------------------------------------------------
 *
 * Nothing here reaches the liveness engine, the stall derivation or the store's
 * provenance gate, and that is a property of the shape rather than of care:
 *
 *   - this module holds no clock, no scheduler and no reference to liveness.
 *     It never schedules a pump; the facts it holds land on the next emission
 *     the engines were going to make anyway.
 *   - {@link TelemetryJoiner.apply} returns the emission it was given with ONLY
 *     `sessions` replaced. `lastActivityAt` — the provenance gate's one input —
 *     is carried through by reference, so a session nobody touched in this
 *     lifetime stays history however much telemetry names it.
 *   - the join rebuilds a state with `telemetryCostUsd` and fills `durationMs`
 *     on a tool node that has none. `liveness`, a tool's `status` and
 *     `stalledSinceMs` are never written: a stalled call stays stalled.
 *   - a session id that exists only in telemetry creates nothing. The join
 *     maps over the states it is handed and over nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE JOINED STATES GO, AND WHERE THEY DO NOT
 * ---------------------------------------------------------------------------
 *
 * To the STATS observation only. The deck's snapshot and diffs are published
 * from the engines' own emission, untouched: the bridge applies each engine's
 * model-computed patches to its copy of what it last sent, so a state carrying
 * a field no patch knows about would put that copy out of step with the model
 * it must never diverge from. The spec renders telemetry in one place — the
 * Tokens view's cost, labelled "estimated by Claude Code" — and that view reads
 * the stats records. So nothing here moves a golden or a wire recording of the
 * deck (the one wire file that carries telemetry, R8 fixture 13's, is a
 * recording of a committed fixture state, not of this path), and no webview
 * file reads `telemetryCostUsd` (DoD 1.9f, still asserted).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS KEPT, AND WHAT IS COUNTED AS UNMATCHED
 * ---------------------------------------------------------------------------
 *
 * The exporter is machine-wide, so rows about other sessions — another
 * window's, one this window has not read — arrive routinely and are never an
 * error.
 *
 *   - cost points of a held session are SUMMED (DELTA temporality) and the sum
 *     is applied on every emission;
 *   - a held session's `claude_code.session.count` point is remembered as a
 *     flag, applied on every emission (DoD 6.3b);
 *   - spans of a held session are kept by `tool_use_id` (a re-sent span
 *     replaces, never adds) and re-joined on every emission, so a span whose
 *     tool the graft had not reached when it arrived fills in once it does.
 *
 * **A session not yet held: its count point and its cost are kept; its spans
 * wait one pump.** From the committed OTel corpus's own timestamps: in both sessions
 * the count point arrives BEFORE the first prompt (17.4 s and 0.9 s). And the
 * two sessions' real transcripts were CREATED at that prompt (file creation
 * times, measured read-only by phase-verifier round 2; the committed
 * transcript fixtures cannot show it, their first lines carry no timestamp).
 * So at the moment the point arrives there is no transcript for any window to
 * hold. A joiner that
 * kept rows only for sessions held at arrival would drop the point on every
 * session that starts while the window is open, and 6.3b's rule would then
 * leave every such cost unselected. So both are held in {@link PENDING_SESSIONS_MAX}
 * slots, keyed by session id, and moved onto the session the first time an
 * emission holds it. A slot evicted to make room loses its count point, which
 * leaves that session's cost unselected — the direction that shows no figure
 * rather than a short one. Spans only fill a duration the engine did not
 * state, so they are not held open-ended: a span is kept if its session is
 * shown when it arrives or at the next pump (ruling 2026-09-11), and dropped
 * otherwise.
 *
 * `unmatched` counts, per signal, the rows STILL unmatched after the join has
 * retried (user ruling, 2026-09-11). An early arrival that matches later is
 * never counted — the first live smoke showed why: a span that landed before
 * its tool call reached the window's tree read as `unmatched:1` although it
 * joined a moment later.
 *
 * ---------------------------------------------------------------------------
 * `unmatched` IS THIS WINDOW'S; `foreign` IS EVERYTHING ELSE (v0.8.0 DoD 7.8)
 * ---------------------------------------------------------------------------
 *
 * **`unmatched` counts only rows for sessions this window HOLDS. Every other
 * row increments {@link TelemetryJoiner.foreign}.** The exporter is
 * machine-wide: on a machine running several windows, most of what arrives is
 * about somebody else's sessions, and until 0.8.0 all of it landed in one
 * figure. A user reading `unmatched:40` could not tell "forty rows of mine did
 * not join" — a defect in this window — from "forty rows named sessions this
 * window has never shown", which is the ordinary state of a shared exporter
 * and says nothing at all. Two counters answer the two questions; the
 * counters line carries both, and carries `(this window)` beside them.
 *
 *   - traces: every span waits for the FIRST `apply()` after it arrived — the
 *     next pump — and is judged there, against that pump's states. A span
 *     whose session that pump shows is kept for the join, whether or not the
 *     session was shown when the span arrived (a window reloaded during a live
 *     session receives spans before its first emission), and is judged by the
 *     join's own key ({@link unmatchedSpans}): matching, it is not counted;
 *     matching nothing, it counts **unmatched** — this window holds the
 *     session and could not place the row. A span whose session that pump does
 *     NOT show counts **foreign**: a span waits one pump for its session, no
 *     longer. A span re-sent before its verdict replaces the earlier copy and
 *     is judged once.
 *   - metrics: a count point or cost point for a held session joins; one held
 *     pending is retried on every pump while its slot lives, and is counted
 *     only when its slot is EVICTED — the point at which it can no longer join
 *     — with every row the slot held. **Every evicted row is `foreign`, and
 *     that is provable rather than chosen**: {@link TelemetryJoiner.apply}
 *     runs {@link TelemetryJoiner.#promotePending} over `#live` before
 *     anything else, and {@link TelemetryJoiner.ingest} opens a slot only for
 *     a session `#live` does not name, so no pending slot can ever be for a
 *     session this window holds. The judging moment is therefore EVICTION,
 *     against the live set as it stood at the last pump — which is the same
 *     set, since `#live` moves only in `apply`.
 *   - So `unmatched.metrics` has NO increment site, and that is stated here
 *     rather than left to be discovered from a counter that is always 0: a
 *     held session's cost and count points are keyed on the session id alone,
 *     and the session is in the states the join is run over, so they place by
 *     construction. A metrics row of this window's that could not be placed
 *     does not exist to count.
 *   - logs bodies carry no row the join reads, so both of their figures are 0.
 *
 * **A `foreign` span produces no diagnostics line.** `onUnmatchedSpan` fires
 * for `unmatched` spans only. A line names WHICH row did not join so a reader
 * can go and look at that call; for a foreign span the answer is the same for
 * every one of them — this window does not show that session — so a line per
 * span would be a log of other windows' traffic with no per-span fact in it.
 * The counter is what says how many.
 *
 * G7: every map here lives in this instance and dies with the window.
 */

import { joinTelemetry, unmatchedSpans, type TelemetryJoinReport } from '../otel/join.js';
import {
  emptyTelemetryCounts,
  type OtelCostPoint,
  type OtelSignal,
  type OtelToolSpan,
  type TelemetrySlice,
} from '../otel/parse.js';
import type { SessionState } from './events.js';
import type { SessionEmission } from './session.js';

/**
 * Per-signal accounting of what the join could not place, FOR SESSIONS THIS
 * WINDOW HOLDS. DoD 6.4, narrowed by v0.8.0 DoD 7.8.
 */
export type TelemetryUnmatched = Record<OtelSignal, number>;

/**
 * Per-signal accounting of rows about sessions this window does NOT hold
 * (v0.8.0 DoD 7.8).
 *
 * A separate NAME for the same shape, so a call site says which of the two
 * figures it is carrying. The header states when each is incremented and why
 * a foreign row gets no diagnostics line.
 */
export type TelemetryForeign = Record<OtelSignal, number>;

/**
 * Sessions whose count point and cost are held before any emission holds the
 * session (DoD 6.3b). Two numbers per slot; the oldest slot is evicted first.
 */
export const PENDING_SESSIONS_MAX = 256;

/** What is held for a session this window does not show yet. */
interface PendingSession {
  cost: number;
  counted: boolean;
  /** Rows held in this slot — cost points plus count points — counted unmatched if it is evicted. */
  rows: number;
}

export interface TelemetryJoinerOptions {
  /**
   * Called once per span still unmatched after the next pump. The host writes
   * one diagnostics line from it, through `DiagnosticsChannel`, which catches
   * both a sink that cannot be created and a write that throws — so the one
   * production callback cannot throw, and this module does not wrap it.
   */
  onUnmatchedSpan?: (span: OtelToolSpan) => void;
}

/** The key a span is kept and judged by: the join's own pair, structurally (no separator byte). */
function spanKey(span: OtelToolSpan): string {
  return JSON.stringify([span.sessionId, span.toolUseId]);
}

export class TelemetryJoiner {
  readonly #onUnmatchedSpan: ((span: OtelToolSpan) => void) | undefined;
  /** Spans that arrived since the last pump, awaiting its verdict; a re-sent span replaces. */
  #awaiting = new Map<string, OtelToolSpan>();
  /** The states the join targets: the last emission's, as the engines made them. */
  #live: readonly SessionState[] = [];
  /** Kept spans, per held session, by `tool_use_id`. */
  readonly #spans = new Map<string, Map<string, OtelToolSpan>>();
  /** Summed cost, per held session, in USD. */
  readonly #cost = new Map<string, number>();
  /** Held sessions whose `claude_code.session.count` point was received. */
  readonly #counted = new Set<string>();
  /** Count points and cost for sessions not yet held, oldest first. */
  readonly #pending = new Map<string, PendingSession>();
  readonly #unmatched: TelemetryUnmatched = { metrics: 0, logs: 0, traces: 0 };
  readonly #foreign: TelemetryForeign = { metrics: 0, logs: 0, traces: 0 };
  #slicesIngested = 0;
  #lastReport: TelemetryJoinReport | null = null;

  constructor(options: TelemetryJoinerOptions = {}) {
    this.#onUnmatchedSpan = options.onUnmatchedSpan;
  }

  /**
   * Rows still unmatched after the join retried, per signal, FOR SESSIONS THIS
   * WINDOW HOLDS (see the header). A copy.
   */
  get unmatched(): TelemetryUnmatched {
    return { ...this.#unmatched };
  }

  /**
   * Rows about sessions this window does not hold, per signal (v0.8.0 DoD 7.8).
   * A copy.
   */
  get foreign(): TelemetryForeign {
    return { ...this.#foreign };
  }

  /** Slices handed to {@link ingest}. */
  get slicesIngested(): number {
    return this.#slicesIngested;
  }

  /** Sessions held pending, not yet shown by any emission. At most {@link PENDING_SESSIONS_MAX}. */
  get pendingSessions(): number {
    return this.#pending.size;
  }

  /**
   * The report of the join {@link apply} last ran, or null before any ran.
   *
   * There is deliberately NO accessor for the states `apply` returned: a
   * mirror kept here can disagree with the value that left, and a test that
   * read one did (M8 in the phase's mutation record). What the stats layer was
   * handed is `AgentDeckHost.statsObserved`.
   */
  get lastReport(): TelemetryJoinReport | null {
    return this.#lastReport === null ? null : { ...this.#lastReport };
  }

  /**
   * One slice from the listener (route on a leader, relay on a follower).
   *
   * No span is counted here: every span waits for the next pump's verdict (see
   * {@link apply}), and a span whose session is already held is kept for the
   * join at once. A count point or cost point whose session is held joins; one
   * whose session is not held yet is kept pending — and the one thing counted
   * here is the rows of a pending slot this arrival pushes out.
   */
  ingest(_signal: OtelSignal, slice: TelemetrySlice): void {
    this.#slicesIngested += 1;
    const held = new Set(this.#live.map((state) => state.sessionId));
    for (const span of slice.toolSpans) {
      this.#awaiting.set(spanKey(span), span);
      if (held.has(span.sessionId)) this.#keep(span);
    }
    for (const sessionId of slice.sessionCounts) {
      if (held.has(sessionId)) {
        this.#counted.add(sessionId);
      } else {
        const slot = this.#pendingFor(sessionId);
        slot.counted = true;
        slot.rows += 1;
      }
    }
    for (const point of slice.costPoints) {
      if (held.has(point.sessionId)) {
        this.#cost.set(point.sessionId, (this.#cost.get(point.sessionId) ?? 0) + point.usd);
      } else {
        const slot = this.#pendingFor(point.sessionId);
        slot.cost += point.usd;
        slot.rows += 1;
      }
    }
  }

  /**
   * The pending slot for a session, made (and the oldest evicted) if absent.
   * An evicted slot's rows can never join, so that is where they are counted.
   *
   * They count `foreign`, never `unmatched` (v0.8.0 DoD 7.8): a pending slot
   * is by construction for a session `#live` does not name — `#promotePending`
   * empties every slot the live states hold, and `ingest` opens one only for a
   * session `held` excludes — so at the judging moment, eviction, this window
   * does not hold it. The header carries the whole argument.
   */
  #pendingFor(sessionId: string): PendingSession {
    const existing = this.#pending.get(sessionId);
    if (existing !== undefined) return existing;
    if (this.#pending.size >= PENDING_SESSIONS_MAX) {
      const oldest = this.#pending.entries().next();
      if (oldest.done !== true) {
        this.#pending.delete(oldest.value[0]);
        this.#foreign.metrics += oldest.value[1].rows;
      }
    }
    const fresh: PendingSession = { cost: 0, counted: false, rows: 0 };
    this.#pending.set(sessionId, fresh);
    return fresh;
  }

  /** Keep a span for the join, by `tool_use_id` within its session (a re-sent span replaces). */
  #keep(span: OtelToolSpan): void {
    const perSession = this.#spans.get(span.sessionId) ?? new Map<string, OtelToolSpan>();
    perSession.set(span.toolUseId, span);
    this.#spans.set(span.sessionId, perSession);
  }

  /**
   * The verdict on every span that arrived since the last pump, against this
   * pump's states — the join's one retry (ruling 2026-09-11). A span whose
   * session this pump shows is kept and judged by the join's key; one whose
   * session it does not show is dropped.
   *
   * The two outcomes go to DIFFERENT counters (v0.8.0 DoD 7.8). A `candidate`
   * is a span of a session this window holds, so failing the join is a fact
   * about this window's tree and counts `unmatched`, with one diagnostics line
   * naming it. A `dropped` span names a session this window does not hold, so
   * it counts `foreign` and gets no line — see the header.
   */
  #judgeAwaiting(states: readonly SessionState[]): void {
    if (this.#awaiting.size === 0) return;
    const awaiting = [...this.#awaiting.values()];
    this.#awaiting = new Map();
    const shown = new Set(states.map((state) => state.sessionId));
    const candidates: OtelToolSpan[] = [];
    let dropped = 0;
    for (const span of awaiting) {
      if (shown.has(span.sessionId)) {
        this.#keep(span);
        candidates.push(span);
      } else {
        dropped += 1;
      }
    }
    this.#foreign.traces += dropped;
    for (const span of unmatchedSpans(states, candidates)) {
      this.#unmatched.traces += 1;
      this.#onUnmatchedSpan?.(span);
    }
  }

  /** Move every pending slot whose session the live states now hold onto it. */
  #promotePending(): void {
    if (this.#pending.size === 0) return;
    for (const state of this.#live) {
      const slot = this.#pending.get(state.sessionId);
      if (slot === undefined) continue;
      this.#pending.delete(state.sessionId);
      if (slot.counted) this.#counted.add(state.sessionId);
      if (slot.cost !== 0) {
        this.#cost.set(state.sessionId, (this.#cost.get(state.sessionId) ?? 0) + slot.cost);
      }
    }
  }

  /**
   * The emission the stats layer observes: the engines' own, with the kept
   * telemetry joined onto its sessions.
   *
   * Returns THE SAME OBJECT when there is nothing to apply or nothing changed,
   * so a window that never receives telemetry hands the stats layer exactly
   * what it handed it before v0.7.1. Only `sessions` is ever replaced.
   */
  apply(emission: SessionEmission): SessionEmission {
    this.#live = emission.sessions;
    this.#promotePending();
    this.#judgeAwaiting(emission.sessions);
    if (this.#spans.size === 0 && this.#cost.size === 0 && this.#counted.size === 0) return emission;
    const toolSpans: OtelToolSpan[] = [];
    for (const perSession of this.#spans.values()) toolSpans.push(...perSession.values());
    const costPoints: OtelCostPoint[] = [...this.#cost].map(([sessionId, usd]) => ({ sessionId, usd }));
    const slice: TelemetrySlice = {
      toolSpans,
      costPoints,
      sessionCounts: [...this.#counted],
      counts: emptyTelemetryCounts(),
    };

    const { states, report } = joinTelemetry(emission.sessions, slice);
    this.#lastReport = report;
    const changed = states.some((state, index) => state !== emission.sessions[index]);
    if (!changed) return emission;
    return { ...emission, sessions: states };
  }
}
