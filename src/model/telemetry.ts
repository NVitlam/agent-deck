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
 * **A session not yet held: its count point and its cost are kept, its spans
 * are not.** From the committed OTel corpus's own timestamps: in both sessions
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
 * state; they are kept for held sessions only, as before.
 *
 * `unmatched` counts, per signal, the rows the join matched to NOTHING at the
 * moment they arrived — its own `spansUnmatched`, `costPointsUnmatched` and
 * `sessionCountsUnmatched`, not a second opinion formed here — including a
 * count point or a cost point that is then
 * kept pending and applied once its session appears. `logs` bodies carry no
 * row the join reads, so their `unmatched` is 0 by construction.
 *
 * G7: every map here lives in this instance and dies with the window.
 */

import { joinTelemetry, type TelemetryJoinReport } from '../otel/join.js';
import {
  emptyTelemetryCounts,
  type OtelCostPoint,
  type OtelSignal,
  type OtelToolSpan,
  type TelemetrySlice,
} from '../otel/parse.js';
import type { SessionState } from './events.js';
import type { SessionEmission } from './session.js';

/** Per-signal accounting of what the join could not place. DoD 6.4. */
export type TelemetryUnmatched = Record<OtelSignal, number>;

/**
 * Sessions whose count point and cost are held before any emission holds the
 * session (DoD 6.3b). Two numbers per slot; the oldest slot is evicted first.
 */
export const PENDING_SESSIONS_MAX = 256;

/** What is held for a session this window does not show yet. */
interface PendingSession {
  cost: number;
  counted: boolean;
}

export class TelemetryJoiner {
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
  #slicesIngested = 0;
  #lastReport: TelemetryJoinReport | null = null;

  /** Rows the join placed nowhere at arrival, per signal. A copy. */
  get unmatched(): TelemetryUnmatched {
    return { ...this.#unmatched };
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
   * Joined against the live states FIRST, so `unmatched` is the join's own
   * verdict at the moment of arrival; then every row whose session is held is
   * kept for {@link apply}, and a count point or cost point whose session is
   * not held yet is kept pending.
   */
  ingest(signal: OtelSignal, slice: TelemetrySlice): void {
    this.#slicesIngested += 1;
    const { report } = joinTelemetry(this.#live, slice);
    if (signal === 'traces') this.#unmatched.traces += report.spansUnmatched;
    else if (signal === 'metrics') {
      this.#unmatched.metrics += report.costPointsUnmatched + report.sessionCountsUnmatched;
    }
    // `logs`: the parse boundary reads no row from a logs body, so there is
    // nothing to place and nothing to count.

    const held = new Set(this.#live.map((state) => state.sessionId));
    for (const span of slice.toolSpans) {
      if (!held.has(span.sessionId)) continue;
      const perSession = this.#spans.get(span.sessionId) ?? new Map<string, OtelToolSpan>();
      perSession.set(span.toolUseId, span);
      this.#spans.set(span.sessionId, perSession);
    }
    for (const sessionId of slice.sessionCounts) {
      if (held.has(sessionId)) this.#counted.add(sessionId);
      else this.#pendingFor(sessionId).counted = true;
    }
    for (const point of slice.costPoints) {
      if (held.has(point.sessionId)) {
        this.#cost.set(point.sessionId, (this.#cost.get(point.sessionId) ?? 0) + point.usd);
      } else {
        this.#pendingFor(point.sessionId).cost += point.usd;
      }
    }
  }

  /** The pending slot for a session, made (and the oldest evicted) if absent. */
  #pendingFor(sessionId: string): PendingSession {
    const existing = this.#pending.get(sessionId);
    if (existing !== undefined) return existing;
    if (this.#pending.size >= PENDING_SESSIONS_MAX) {
      const oldest = this.#pending.keys().next();
      if (oldest.done !== true) this.#pending.delete(oldest.value);
    }
    const fresh: PendingSession = { cost: 0, counted: false };
    this.#pending.set(sessionId, fresh);
    return fresh;
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
