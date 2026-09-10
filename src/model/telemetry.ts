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
 * the stats records. So no golden and no wire file can move, and no webview
 * file reads `telemetryCostUsd` (DoD 1.9f, still asserted).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS KEPT, AND WHAT IS COUNTED AS UNMATCHED
 * ---------------------------------------------------------------------------
 *
 * A row is kept only if its `session.id` names a session this window holds at
 * the moment it arrives. Everything else is a row about something else —
 * another window's session, a session this window has not read — and is
 * dropped and counted, never an error (the exporter is machine-wide).
 *
 *   - cost points of a held session are SUMMED (DELTA temporality) and the sum
 *     is applied on every emission;
 *   - spans of a held session are kept by `tool_use_id` (a re-sent span
 *     replaces, never adds) and re-joined on every emission, so a span whose
 *     tool the graft had not reached when it arrived fills in once it does.
 *
 * `unmatched` counts, per signal, the rows the join matched to NOTHING at the
 * moment they arrived — its own `spansUnmatched` and `costPointsUnmatched`,
 * not a second opinion formed here. `logs` bodies carry no row the join reads,
 * so their `unmatched` is 0 by construction.
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

export class TelemetryJoiner {
  /** The states the join targets: the last emission's, as the engines made them. */
  #live: readonly SessionState[] = [];
  /** Kept spans, per held session, by `tool_use_id`. */
  readonly #spans = new Map<string, Map<string, OtelToolSpan>>();
  /** Summed cost, per held session, in USD. */
  readonly #cost = new Map<string, number>();
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
   * kept for {@link apply}.
   */
  ingest(signal: OtelSignal, slice: TelemetrySlice): void {
    this.#slicesIngested += 1;
    const { report } = joinTelemetry(this.#live, slice);
    if (signal === 'traces') this.#unmatched.traces += report.spansUnmatched;
    else if (signal === 'metrics') this.#unmatched.metrics += report.costPointsUnmatched;
    // `logs`: the parse boundary reads no row from a logs body, so there is
    // nothing to place and nothing to count.

    const held = new Set(this.#live.map((state) => state.sessionId));
    for (const span of slice.toolSpans) {
      if (!held.has(span.sessionId)) continue;
      const perSession = this.#spans.get(span.sessionId) ?? new Map<string, OtelToolSpan>();
      perSession.set(span.toolUseId, span);
      this.#spans.set(span.sessionId, perSession);
    }
    for (const point of slice.costPoints) {
      if (!held.has(point.sessionId)) continue;
      this.#cost.set(point.sessionId, (this.#cost.get(point.sessionId) ?? 0) + point.usd);
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
    if (this.#spans.size === 0 && this.#cost.size === 0) return emission;
    const toolSpans: OtelToolSpan[] = [];
    for (const perSession of this.#spans.values()) toolSpans.push(...perSession.values());
    const costPoints: OtelCostPoint[] = [...this.#cost].map(([sessionId, usd]) => ({ sessionId, usd }));
    const slice: TelemetrySlice = { toolSpans, costPoints, counts: emptyTelemetryCounts() };

    const { states, report } = joinTelemetry(emission.sessions, slice);
    this.#lastReport = report;
    const changed = states.some((state, index) => state !== emission.sessions[index]);
    if (!changed) return emission;
    return { ...emission, sessions: states };
  }
}
