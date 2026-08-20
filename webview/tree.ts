/**
 * Agent Deck webview — turns a `SessionState` into the shape the tree
 * component draws.
 *
 * Why this file exists at all: `ToolNode` has **no `children` field**, and a
 * subagent `AgentNode` does not nest inside the `ToolNode` that spawned it.
 * The grafter places the subagent *adjacent* in the parent agent's `children`,
 * and the spawn relationship lives only in `SessionState.spawnEdges` (see the
 * comment on that field in `src/model/events.ts`). So "draw the subagent under
 * the tool call that spawned it" is a join this renderer performs; it is not
 * recoverable from `root` alone, and it is not fixed by adding a field to
 * `ToolNode` — those interfaces are the spec's, not ours.
 *
 * Pure. No DOM, no I/O; tested in the node environment.
 */

import type { AgentNode, SessionState, ToolNode, TreeNode } from '../src/model/events.js';
import { isAgentNode } from '../src/model/events.js';

export interface RenderAgent {
  kind: 'agent';
  node: AgentNode;
  /** Depth in the *rendered* tree, root = 0. Not `spawnDepth`. */
  depth: number;
  children: RenderNode[];
  /**
   * The `tool_use` id this agent was grafted under, when a spawn edge joined
   * it to a sibling tool call. Absent when the agent is drawn at its natural
   * position in `children`.
   */
  spawnedByToolUseId?: string;
}

export interface RenderTool {
  kind: 'tool';
  node: ToolNode;
  depth: number;
  /** Subagents joined to this tool call by a spawn edge. Usually empty. */
  children: RenderAgent[];
}

export type RenderNode = RenderAgent | RenderTool;

/**
 * Build the render tree.
 *
 * Rules, in order:
 *  - An agent child is drawn under a sibling tool call when a spawn edge names
 *    both (`edge.agentId` = the agent, `edge.toolUseId` = the tool) AND that
 *    tool is a child of the same parent. Requiring the sibling relationship
 *    keeps a stale or cross-parent edge from teleporting a node.
 *  - `edge.parentNodeId` is checked when it is populated, so an edge that
 *    disagrees with where the grafter actually attached the agent is ignored
 *    rather than obeyed.
 *  - An agent claimed by an edge is drawn once, under the tool, and NOT again
 *    at its natural position.
 *  - Everything else keeps `children` order exactly.
 */
export function buildRenderTree(state: SessionState): RenderAgent {
  const edges = state.spawnEdges ?? [];
  return buildAgent(state.root, 0, edges);
}

function buildAgent(
  agent: AgentNode,
  depth: number,
  edges: readonly { toolUseId: string; agentId: string; parentNodeId: string }[],
): RenderAgent {
  const children = agent.children;

  const toolIds = new Set<string>();
  const agentsById = new Map<string, AgentNode>();
  for (const child of children) {
    if (isAgentNode(child)) agentsById.set(child.id, child);
    else toolIds.add(child.id);
  }

  // toolUseId -> agent children of THIS agent that the edges graft under it.
  const graftedByTool = new Map<string, { agent: AgentNode; toolUseId: string }[]>();
  const claimed = new Set<string>();
  for (const edge of edges) {
    if (!toolIds.has(edge.toolUseId)) continue;
    const child = agentsById.get(edge.agentId);
    if (child === undefined) continue;
    if (edge.parentNodeId !== '' && edge.parentNodeId !== agent.id) continue;
    if (claimed.has(child.id)) continue;
    claimed.add(child.id);
    const list = graftedByTool.get(edge.toolUseId) ?? [];
    list.push({ agent: child, toolUseId: edge.toolUseId });
    graftedByTool.set(edge.toolUseId, list);
  }

  const rendered: RenderNode[] = [];
  for (const child of children) {
    if (isAgentNode(child)) {
      if (claimed.has(child.id)) continue;
      rendered.push(buildAgent(child, depth + 1, edges));
      continue;
    }
    const grafted = graftedByTool.get(child.id) ?? [];
    rendered.push({
      kind: 'tool',
      node: child,
      depth: depth + 1,
      children: grafted.map((g) => {
        const built = buildAgent(g.agent, depth + 2, edges);
        return { ...built, spawnedByToolUseId: g.toolUseId };
      }),
    });
  }

  return { kind: 'agent', node: agent, depth, children: rendered };
}

/** Every node id in the rendered tree, in draw order. */
export function renderedNodeIds(root: RenderNode): string[] {
  const out: string[] = [];
  const walk = (n: RenderNode): void => {
    out.push(n.node.id);
    for (const child of n.children) walk(child);
  };
  walk(root);
  return out;
}

/** True when a node carries a payload worth expanding. */
export function hasPayload(node: TreeNode): boolean {
  if (isAgentNode(node)) return node.children.length > 0;
  return node.inputPreview.length > 0 || (node.resultPreview ?? '').length > 0;
}
