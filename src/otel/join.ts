/**
 * Agent Deck — joining Claude Code telemetry onto the session model.
 *
 * v0.7.0 Phase 1, DoD 1.9d/1.9e/1.9f. Two primary keys, no fuzzy matching, no
 * fallback:
 *
 *     session.id   ===  SessionState.sessionId   (the JSONL basename)
 *     tool_use_id  ===  ToolNode.id              (the tool_use block's id)
 *
 * Exact or the row is discarded and counted. A telemetry row that names a
 * session or a call this host has not read is not an error and not a warning —
 * it is a row about something else.
 *
 * ---------------------------------------------------------------------------
 * AN UNMATCHED `ToolNode` IS ORDINARY, AND THE CORPUS PROVES IT
 * ---------------------------------------------------------------------------
 *
 * Session A of `fixtures/otel-cc-2.1.260/` has 32 `tool_use` blocks and 31
 * matching spans. The one without is `toolu_01AbDNECE12Dz5RCYmmyxWMZ`, ordinal
 * 14 — a `Bash` REJECTED BY INPUT VALIDATION before it executed
 * (`InputValidationError: command contains control characters`).
 *
 * The transcript records attempts; telemetry records tools that RAN. So the
 * two populations differ by construction, and a consumer that treated an
 * unmatched node as a defect would report one on a session where nothing is
 * wrong. `join.test.ts` pins that case by name.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * **It does not set `AgentNode.agentName`, and that is measured rather than
 * unfinished.** DoD 1.9e asks for it from the `agent.name` attribute. Over the
 * whole committed corpus:
 *
 *   - `agent.name` (`general-purpose`) appears on 6 `claude_code.api_request`
 *     log records and 30 metric data points. NONE carries `agent_id`.
 *   - `agent_id` appears on 4 of 40 `claude_code.tool` spans, equal to the
 *     subagent sidecar basenames. NONE carries `agent.name`.
 *   - The two NEVER co-occur on any record.
 *
 * So the corpus states a name and states which agent made a call, and offers no
 * key between them. Attaching the one observed name to a session's subagents
 * would be a guess, and demonstrably a wrong one: session `f7f0eef9…` carries
 * TWO distinct `agent_id`s against ONE distinct `agent.name`, so even "this
 * session had a single subagent" is false. Exactly what "exact or discarded"
 * and G3 forbid.
 *
 * **CLOSED UNAVAILABLE by the user on 2026-09-06.** `agentName` is REMOVED from
 * `AgentNode` and from Component 12 — a field nothing can ever set is a promise
 * the type keeps making. `agent-deck-spec.md` §L carries the dated line, and
 * `join.test.ts` now asserts the CO-OCCURRENCE MEASUREMENT rather than the
 * field's absence: an assertion that a removed field is `undefined` cannot
 * fail, while the measurement goes red the day a capture states both attributes
 * on one record — which is the signal to reopen this.
 *
 * **It does not overwrite an engine-derived duration.** See {@link joinTelemetry}.
 *
 * **It does not render.** `telemetryCostUsd` is stored and read by nothing in
 * this phase: F9(c) is Phase 2 and the cost-source label is Phase 4.
 *
 * **It does not decide whether a cost is complete.** It records, per session,
 * whether the slice carried that session's `claude_code.session.count` point
 * (`telemetrySessionCountSeen`, v0.7.1 DoD 6.3b); `deriveStats` is what reads
 * it.
 */

import type { SessionState, ToolNode, TreeNode } from '../model/events.js';
import { isAgentNode } from '../model/events.js';

import type { TelemetrySlice } from './parse.js';

export interface TelemetryJoinReport {
  /** Spans whose `(session.id, tool_use_id)` matched a `ToolNode`. */
  spansMatched: number;
  /**
   * Spans that matched no node, counted and dropped.
   *
   * NORMAL, not an alarm: a host reads the sessions of one workspace and the
   * exporter is machine-wide, so rows about other sessions arrive routinely.
   */
  spansUnmatched: number;
  /** Nodes that already carried an engine-stated duration, so were left alone. */
  durationsKept: number;
  /** Nodes that gained a duration they did not have. */
  durationsFilled: number;
  /** Cost points summed onto a session. */
  costPointsApplied: number;
  /** Cost points naming a session this host has not read. */
  costPointsUnmatched: number;
  /** `claude_code.session.count` points recorded onto a session (DoD 6.3b). */
  sessionCountsApplied: number;
  /** `claude_code.session.count` points naming a session this host has not read. */
  sessionCountsUnmatched: number;
}

export function emptyJoinReport(): TelemetryJoinReport {
  return {
    spansMatched: 0,
    spansUnmatched: 0,
    durationsKept: 0,
    durationsFilled: 0,
    costPointsApplied: 0,
    costPointsUnmatched: 0,
    sessionCountsApplied: 0,
    sessionCountsUnmatched: 0,
  };
}

function toolNodesOf(state: SessionState): Map<string, ToolNode> {
  const out = new Map<string, ToolNode>();
  const walk = (node: TreeNode): void => {
    if (!isAgentNode(node)) {
      // First sighting wins, matching the grafter's own rule for a repeated id.
      if (!out.has(node.id)) out.set(node.id, node);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(state.root);
  return out;
}

/**
 * Apply a telemetry slice to the sessions this host holds.
 *
 * Returns NEW states; the inputs are not mutated. That matters because the
 * caller's previous snapshot is what a diff is computed against, and mutating
 * it in place would make the diff empty.
 *
 * ## The duration precedence, decided rather than incidental
 *
 * `ToolNode.durationMs` already has two producers: the Claude Code grafter
 * computes it from the transcript's own timestamps, and OpenCode reads
 * `state.time`. Telemetry is a THIRD source for a field that is usually already
 * set, not a new field — the DoD's wording notwithstanding.
 *
 * **The engine wins; telemetry fills only where the engine states none.**
 *
 * That is not a preference. The engine-derived value is what every committed
 * golden carries, so letting telemetry overwrite it would move goldens whenever
 * telemetry happened to be enabled — making a user's `settings.json` a factor
 * in whether this repository's own fixtures reproduce. `join.test.ts` asserts
 * both directions.
 */
export function joinTelemetry(
  states: readonly SessionState[],
  slice: TelemetrySlice,
  report: TelemetryJoinReport = emptyJoinReport(),
): { states: SessionState[]; report: TelemetryJoinReport } {
  const bySession = new Map<string, SessionState>();
  for (const state of states) bySession.set(state.sessionId, state);

  // ---- durations, from `claude_code.tool` spans -------------------------
  const fills = new Map<string, Map<string, number>>();
  for (const span of slice.toolSpans) {
    const state = bySession.get(span.sessionId);
    if (state === undefined) {
      report.spansUnmatched += 1;
      continue;
    }
    const nodes = toolNodesOf(state);
    const node = nodes.get(span.toolUseId);
    if (node === undefined) {
      // Exact or discarded. No prefix match, no nearest-ordinal, nothing.
      report.spansUnmatched += 1;
      continue;
    }
    report.spansMatched += 1;
    if (node.durationMs !== undefined) {
      report.durationsKept += 1;
      continue;
    }
    const perSession = fills.get(span.sessionId) ?? new Map<string, number>();
    perSession.set(span.toolUseId, span.durationMs);
    fills.set(span.sessionId, perSession);
    report.durationsFilled += 1;
  }

  // ---- cost, summed ------------------------------------------------------
  const costs = new Map<string, number>();
  for (const point of slice.costPoints) {
    if (!bySession.has(point.sessionId)) {
      report.costPointsUnmatched += 1;
      continue;
    }
    // DELTA temporality (`aggregationTemporality: 1` on all seven metrics), so
    // points ADD. Treating them as cumulative would report the last point as
    // the total and under-report every session with more than one.
    costs.set(point.sessionId, (costs.get(point.sessionId) ?? 0) + point.usd);
    report.costPointsApplied += 1;
  }

  // ---- the session's start, as the exporter counts it (DoD 6.3b) ----------
  // Recorded as a flag and nothing else: whether THIS slice carried the
  // session's `claude_code.session.count` point. The deriver reads it to decide
  // whether a summed cost covers the session from its start.
  const counted = new Set<string>();
  for (const sessionId of slice.sessionCounts) {
    if (!bySession.has(sessionId)) {
      report.sessionCountsUnmatched += 1;
      continue;
    }
    counted.add(sessionId);
    report.sessionCountsApplied += 1;
  }

  const out = states.map((state) => {
    const perSession = fills.get(state.sessionId);
    const cost = costs.get(state.sessionId);
    const seen = counted.has(state.sessionId);
    if (perSession === undefined && cost === undefined && !seen) return state;

    const next: SessionState = {
      ...state,
      ...(perSession === undefined ? {} : { root: fillDurations(state.root, perSession) }),
      ...(cost === undefined ? {} : { telemetryCostUsd: cost }),
      ...(seen ? { telemetrySessionCountSeen: true as const } : {}),
    };
    return next;
  });

  return { states: out, report };
}

function fillDurations<T extends TreeNode>(node: T, fills: ReadonlyMap<string, number>): T {
  if (!isAgentNode(node)) {
    const duration = fills.get(node.id);
    // Only where the engine stated none — the precedence above, enforced at the
    // write rather than trusted from the caller.
    if (duration === undefined || node.durationMs !== undefined) return node;
    return { ...node, durationMs: duration };
  }
  return { ...node, children: node.children.map((child) => fillDurations(child, fills)) };
}
