/**
 * F13 — stalls, read off the tree the model already derived.
 *
 * v0.7.0 Phase 2. This file DOES NOT decide what a stall is: `src/model/stall.ts`
 * does that, at snapshot assembly, and writes `status: 'stalled'` plus
 * `stalledSinceMs` onto the node. Re-deriving the verdict here would be a second
 * implementation of a closed decision and the two would drift the first time the
 * threshold moved.
 *
 * ## A stall is SILENCE, not duration, and that decides what can be counted
 *
 * `agent-deck-spec.md` §L, 2026-09-06, corrects §D's own row: a `ToolNode` is
 * stalled iff it is `running` and the SESSION's `lastActivityAt` is older than
 * `livenessThresholdMs`. The harvested corpus separates the two readings
 * decisively — an `Agent` call that ran **2,846.6 s and completed** beside the
 * reported stall that ran **1,092.6 s and never did**. Under a duration reading
 * the 47-minute call is the bigger stall; under the silence reading it is not a
 * stall at all, because its subagent was emitting hook events throughout.
 *
 * ## Why there is no `completed` column
 *
 * §D's row asks for "completed yes/no". A stall is cleared by any activity, so
 * the instant a stalled tool completes it is `done` and `stalledSinceMs` is
 * gone. A pure function over ONE snapshot therefore cannot observe a completed
 * stall, and a `completed` field here could only ever hold `false` — the
 * unfalsifiable-literal shape this repository has recorded more than once. The
 * column is omitted and every record names the gap in `unavailable` as
 * `F13.completed:snapshot`.
 *
 * Answering it properly needs the store (Phase 3): two records for one session,
 * one with the stall and one without, is what "it completed" looks like from
 * outside a snapshot.
 */

import type { ToolNode } from '../model/events.js';

import type { StallRecord } from './schema.js';

/** One agent's calls, in the order the grafter placed them. */
export interface AgentCallsForStalls {
  agentId: string;
  tools: readonly ToolNode[];
}

/**
 * Every currently-stalled call, with how long it has been silent.
 *
 * `stalledMs` is measured from `stalledSinceMs` — the instant the threshold was
 * CROSSED — to `now`. Not from the call's start, and not from the moment the
 * question was asked: `events.ts` records that choice on the field itself,
 * because anchoring on the question would make the elapsed time jump with the
 * poll cadence and would differ between two derivations of one state.
 *
 * `now` is a PARAMETER. `derive.ts` reads no clock — the deriver is pure, and
 * `derive.test.ts` asserts it contains no `Date.now()` at all — so the caller
 * supplies the same instant the model used.
 */
export function deriveStalls(
  agents: readonly AgentCallsForStalls[],
  now: number | undefined,
): StallRecord[] {
  const out: StallRecord[] = [];
  for (const agent of agents) {
    for (const tool of agent.tools) {
      if (tool.status !== 'stalled') continue;
      const since = tool.stalledSinceMs;
      // A node claiming `stalled` with no crossing instant is a state the model
      // does not produce (the two are written together). It is dropped rather
      // than reported with a made-up 0: a stall of zero milliseconds would read
      // as a tool that stalled and un-stalled in the same instant.
      if (since === undefined || !Number.isFinite(since)) continue;
      const elapsed = now === undefined || !Number.isFinite(now) ? 0 : Math.max(0, now - since);
      out.push({
        agentId: agent.agentId,
        toolName: tool.toolName,
        ordinal: tool.ordinal ?? -1,
        stalledMs: elapsed,
      });
    }
  }
  out.sort(
    (a, b) =>
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0) || a.ordinal - b.ordinal,
  );
  return out;
}
