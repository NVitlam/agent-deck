/**
 * F3 (identical-call loops) and F4 (churn chains).
 *
 * v0.7.0 Phase 2. Both facts are defined WITHIN ONE AGENT, which is a locked
 * open question rather than an implementation convenience (`PLAN.md` Phase 2,
 * user, 2026-09-05):
 *
 *   - F3 scope: "within one agent only. Cross-agent repeats are not a fact in
 *     v0.7.0."
 *   - F4 window: "any `status: error` tool between an `Edit/Write(X)` and the
 *     next `Edit/Write(X)` in the same agent; the chain records every ordinal
 *     between."
 *
 * ## Ordinals are per AGENT, and nothing here sorts across agents
 *
 * `ToolNode.ordinal` is documented as "per AGENT, not per session, so two
 * agents' ordinals are not comparable and nothing should sort across them".
 * Every function here groups first and orders second, so the comparison never
 * crosses that boundary. F1's `firstTouch`/`lastTouch` in `derive.ts` are the
 * one place a session-wide ordering is needed, and it is built there from a
 * session-wide sequence rather than from these.
 */

import type { ToolNode } from '../model/events.js';

import type { ChurnRecord, LoopRecord, StatsToolClass } from './schema.js';

/** One agent's calls, already collected in the order the grafter placed them. */
export interface AgentCalls {
  agentId: string;
  tools: readonly ToolNode[];
}

/** How a caller resolves a tool's class, injected so this file imports no census. */
export type ClassOf = (toolName: string) => StatsToolClass;

/**
 * Ascending by ordinal, with a stable tie-break on id.
 *
 * A tie is not hypothetical: `ordinal` is OPTIONAL on `ToolNode` (the B3 wire
 * precedent), so a hand-built wire node can carry none. Those sort to the end
 * under `Number.MAX_SAFE_INTEGER` rather than to 0, because sorting an unknown
 * position to the FRONT would make it look like the first call of the agent.
 */
function byOrdinal(a: ToolNode, b: ToolNode): number {
  const ao = a.ordinal ?? Number.MAX_SAFE_INTEGER;
  const bo = b.ordinal ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * F3 — every `toolName` + `inputHash` signature repeated `loopMin` times or
 * more, inside one agent.
 *
 * A call with no `inputHash` is SKIPPED rather than grouped under a stand-in.
 * Grouping them (by `undefined`, or by the preview) would report a loop
 * assembled from calls nobody compared, which is the opposite of what the hash
 * is for. `derive.ts` counts the skipped calls and emits `F3:<engine>` when any
 * exist, so the gap is reported rather than silently narrowing the population.
 */
export function deriveLoops(
  agents: readonly AgentCalls[],
  loopMin: number,
  classOf: ClassOf,
): { loops: LoopRecord[]; callsWithoutHash: number } {
  const loops: LoopRecord[] = [];
  let callsWithoutHash = 0;

  for (const agent of agents) {
    // Keyed structurally rather than with a separator: this repository has
    // already committed a real NUL byte into source reaching for a character
    // neither half could contain, and a tool name may contain anything.
    const groups = new Map<string, ToolNode[]>();
    for (const tool of agent.tools) {
      if (tool.inputHash === undefined) {
        callsWithoutHash += 1;
        continue;
      }
      const key = JSON.stringify([tool.toolName, tool.inputHash]);
      const bucket = groups.get(key);
      if (bucket === undefined) groups.set(key, [tool]);
      else bucket.push(tool);
    }
    for (const bucket of groups.values()) {
      if (bucket.length < loopMin) continue;
      const ordered = [...bucket].sort(byOrdinal);
      const first = ordered[0];
      if (first === undefined) continue;
      const loop: LoopRecord = {
        agentId: agent.agentId,
        toolName: first.toolName,
        class: classOf(first.toolName),
        count: ordered.length,
        ordinals: ordered.map((t) => t.ordinal ?? -1),
      };
      // DoD 4.2: the file the loop names, iff every repeat names the same one.
      // Identical hashes mean identical inputs, so the condition is a guard
      // against a defect rather than a case the corpus produces; a loop over a
      // tool that names no file simply carries none.
      const filePath = first.filePath;
      if (filePath !== undefined && ordered.every((t) => t.filePath === filePath)) {
        loop.filePath = filePath;
      }
      loops.push(loop);
    }
  }

  // Deterministic order for a byte-stable golden: agent, then tool, then where
  // the run starts. Map iteration order is insertion order, which is stable for
  // one input but is not an ORDER anybody declared.
  loops.sort(
    (a, b) =>
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0) ||
      (a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0) ||
      (a.ordinals[0] ?? 0) - (b.ordinals[0] ?? 0),
  );
  return { loops, callsWithoutHash };
}

/** Classes whose call names a file it CHANGES. A read is not a write. */
const WRITE_CLASSES: ReadonlySet<StatsToolClass> = new Set(['write', 'edit']);

/**
 * F4 — a write of X, an error, then another write of X, inside one agent.
 *
 * The pairing is CONSECUTIVE writes of the same file: for each write of X, the
 * partner is the NEXT write of X by ordinal, and the window is what lies
 * between them. Pairing a write with every later write instead would report one
 * error as N overlapping chains and make the count grow quadratically with a
 * file that is edited often — which is the file most likely to be looked at.
 */
export function deriveChurn(
  agents: readonly AgentCalls[],
  classOf: ClassOf,
): ChurnRecord[] {
  const out: ChurnRecord[] = [];

  for (const agent of agents) {
    const ordered = [...agent.tools].sort(byOrdinal);
    // Where each file's writes sit in `ordered`, in order.
    const writesByFile = new Map<string, number[]>();
    ordered.forEach((tool, index) => {
      if (tool.filePath === undefined) return;
      if (!WRITE_CLASSES.has(classOf(tool.toolName))) return;
      const list = writesByFile.get(tool.filePath);
      if (list === undefined) writesByFile.set(tool.filePath, [index]);
      else list.push(index);
    });

    for (const [filePath, indices] of writesByFile) {
      for (let i = 0; i + 1 < indices.length; i += 1) {
        const from = indices[i];
        const to = indices[i + 1];
        if (from === undefined || to === undefined) continue;
        const between = ordered.slice(from + 1, to);
        const errors = between.filter((t) => t.status === 'error').length;
        if (errors === 0) continue;
        const fromTool = ordered[from];
        const toTool = ordered[to];
        if (fromTool === undefined || toTool === undefined) continue;
        out.push({
          agentId: agent.agentId,
          filePath,
          fromOrdinal: fromTool.ordinal ?? -1,
          toOrdinal: toTool.ordinal ?? -1,
          ordinals: between.map((t) => t.ordinal ?? -1),
          errors,
        });
      }
    }
  }

  out.sort(
    (a, b) =>
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0) ||
      a.fromOrdinal - b.fromOrdinal ||
      (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0),
  );
  return out;
}
