import { describe, expect, it } from 'vitest';
import type { RenderAgent, RenderNode } from './tree.js';
import { buildRenderTree, renderedNodeIds } from './tree.js';
import { liveSession } from './testdata.js';

function child(node: RenderNode, id: string): RenderNode {
  const found = node.children.find((c) => c.node.id === id);
  if (found === undefined) {
    throw new Error(`${id} is not a child of ${node.node.id}: [${node.children.map((c) => c.node.id).join(', ')}]`);
  }
  return found;
}

describe('buildRenderTree', () => {
  it('draws a subagent under the tool call that spawned it', () => {
    const root = buildRenderTree(liveSession());
    const spawningTool = child(root, 'tool-agent-1');
    expect(spawningTool.kind).toBe('tool');
    expect(spawningTool.children.map((c) => c.node.id)).toEqual(['agent-1']);
  });

  it('does not also draw the grafted agent at its adjacent position', () => {
    const root = buildRenderTree(liveSession());
    expect(root.children.map((c) => c.node.id)).toEqual(['tool-read', 'tool-agent-1']);
    expect(renderedNodeIds(root).filter((id) => id === 'agent-1')).toHaveLength(1);
  });

  it('nests to depth 2 through a second spawn edge', () => {
    const root = buildRenderTree(liveSession());
    const agent1 = child(child(root, 'tool-agent-1'), 'agent-1') as RenderAgent;
    const tool2 = child(agent1, 'tool-agent-2');
    const agent2 = child(tool2, 'agent-2');
    expect(agent2.node.id).toBe('agent-2');
    expect((agent2 as RenderAgent).node.spawnDepth).toBe(2);
    // Rendered depth counts the tool hops too: root(0) tool(1) agent(2) tool(3) agent(4).
    expect(agent2.depth).toBe(4);
  });

  it('records which tool use id grafted each agent', () => {
    const root = buildRenderTree(liveSession());
    const agent1 = child(child(root, 'tool-agent-1'), 'agent-1') as RenderAgent;
    expect(agent1.spawnedByToolUseId).toBe('tool-agent-1');
  });

  it('leaves the agent adjacent when the spawn edge is removed', () => {
    // This is the whole reason `spawnEdges` exists: `ToolNode` has no
    // `children`, so without the edge the parent/child relationship is simply
    // not recoverable from `root`.
    const session = liveSession();
    const withoutEdge = {
      ...session,
      spawnEdges: (session.spawnEdges ?? []).filter((e) => e.agentId !== 'agent-1'),
    };
    const root = buildRenderTree(withoutEdge);
    expect(child(root, 'tool-agent-1').children).toHaveLength(0);
    expect(root.children.map((c) => c.node.id)).toEqual([
      'tool-read',
      'tool-agent-1',
      'agent-1',
    ]);
  });

  it('renders a flat tree when spawnEdges is absent entirely', () => {
    const session = liveSession();
    const bare = { ...session };
    delete (bare as { spawnEdges?: unknown }).spawnEdges;
    const root = buildRenderTree(bare);
    expect(root.children.map((c) => c.node.id)).toEqual([
      'tool-read',
      'tool-agent-1',
      'agent-1',
    ]);
  });

  it('ignores an edge whose tool is not a sibling of the agent', () => {
    // A stale or cross-parent edge must not teleport a node into a subtree it
    // does not belong to.
    const session = liveSession();
    const crossed = {
      ...session,
      spawnEdges: (session.spawnEdges ?? []).map((e) =>
        e.agentId === 'agent-1' ? { ...e, toolUseId: 'tool-bash' } : e,
      ),
    };
    const root = buildRenderTree(crossed);
    expect(root.children.map((c) => c.node.id)).toContain('agent-1');
  });

  it('ignores an edge whose parentNodeId disagrees with the actual parent', () => {
    const session = liveSession();
    const wrongParent = {
      ...session,
      spawnEdges: (session.spawnEdges ?? []).map((e) =>
        e.agentId === 'agent-1' ? { ...e, parentNodeId: 'agent-1' } : e,
      ),
    };
    const root = buildRenderTree(wrongParent);
    expect(child(root, 'tool-agent-1').children).toHaveLength(0);
    expect(root.children.map((c) => c.node.id)).toContain('agent-1');
  });

  it('renders every node exactly once', () => {
    const ids = renderedNodeIds(buildRenderTree(liveSession()));
    expect(ids).toHaveLength(new Set(ids).size);
    expect(ids.sort()).toEqual(
      ['agent-1', 'agent-2', 'root', 'tool-agent-1', 'tool-agent-2', 'tool-bash', 'tool-read'].sort(),
    );
  });
});
