import { describe, expect, it } from 'vitest';
import type { AgentNode, SessionState, SpawnEdge } from '../src/model/events.js';
import type { RenderAgent, RenderNode } from './tree.js';
import { buildRenderTree, findAgent, orderedChildAgents, renderedNodeIds } from './tree.js';
import { treeLayout } from './layout.js';
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

/* ------------------------------------------------------------------------ *
 * DoD 7.3 - child order is SPAWN order, and it is deterministic
 * ------------------------------------------------------------------------ */

/**
 * A parent with `spawnScript.length` tool calls and one subagent spawned by
 * each, where the subagents are APPENDED IN A SCRIPTED ORDER that is
 * deliberately neither the spawn order nor id order.
 *
 * `spawnScript[i]` is the index of the tool call that spawned the i-th agent
 * appended. Array order, id order and spawn order are therefore three
 * different orders, and only one of them is correct.
 */
function scriptedCorpus(spawnScript: readonly number[]): SessionState {
  const root: AgentNode = {
    id: 'root',
    kind: 'main',
    label: 'root',
    status: 'running',
    spawnDepth: 0,
    children: [],
    startedAt: 0,
  };
  for (let i = 0; i < spawnScript.length; i += 1) {
    root.children.push({
      id: `tool-${String(i).padStart(2, '0')}`,
      toolName: 'Agent',
      status: 'done',
      inputPreview: '',
    });
  }
  const edges: SpawnEdge[] = [];
  spawnScript.forEach((toolIndex, appended) => {
    const id = `agent-${String(appended).padStart(2, '0')}`;
    root.children.push({
      id,
      kind: 'subagent',
      label: id,
      status: 'running',
      spawnDepth: 1,
      children: [],
      startedAt: 0,
    });
    edges.push({
      toolUseId: `tool-${String(toolIndex).padStart(2, '0')}`,
      agentId: id,
      parentNodeId: 'root',
      depth: 1,
      recordedDepth: 1,
    });
  });
  return {
    sessionId: 'scripted',
    projectSlug: 'scripted',
    workspaceMatch: true,
    liveness: 'live',
    schemaOk: true,
    root,
    totals: { costUsd: 0 },
    spawnEdges: edges,
  };
}

/** What the script says the order must be, derived independently of the code. */
function expectedOrder(script: readonly number[]): string[] {
  return script
    .map((toolIndex, appended) => ({ toolIndex, appended }))
    .sort((a, b) => a.toolIndex - b.toolIndex)
    .map(({ appended }) => `agent-${String(appended).padStart(2, '0')}`);
}

const INTERLEAVED = [7, 0, 19, 3, 11, 1, 15, 2, 8, 4, 18, 5, 12, 6, 16, 9, 13, 10, 17, 14];

describe('DoD 7.3 - spawn order', () => {
  it('orders 20 siblings by the position of the spawning tool call', () => {
    // Twenty siblings spawned in the exact reverse of the order they were
    // appended in. Asserted BY VALUE, position by position - a set comparison
    // would pass on any permutation at all.
    const script = Array.from({ length: 20 }, (_, i) => 19 - i);
    const state = scriptedCorpus(script);
    const expected = expectedOrder(script);
    expect(expected).toHaveLength(20);
    expect(orderedChildAgents(state, 'root').map((a) => a.id)).toEqual(expected);
    // The expectation is neither the append order nor id order, so passing it
    // means the sort ran rather than that the fixture was pre-sorted.
    const appended = state.root.children
      .filter((c): c is AgentNode => 'kind' in c)
      .map((c) => c.id);
    expect(expected).not.toEqual(appended);
    expect(expected).not.toEqual([...appended].sort());
  });

  it('orders 20 siblings by an interleaved script, not by name or arrival', () => {
    const state = scriptedCorpus(INTERLEAVED);
    expect(orderedChildAgents(state, 'root').map((a) => a.id)).toEqual(
      expectedOrder(INTERLEAVED),
    );
  });

  it('the same fixture replayed 100 times yields identical child order', () => {
    const first = orderedChildAgents(scriptedCorpus(INTERLEAVED), 'root').map((a) => a.id);
    const firstLayout = treeLayout(scriptedCorpus(INTERLEAVED), 'root').map((p) => p.id);
    for (let run = 0; run < 100; run += 1) {
      const state = scriptedCorpus(INTERLEAVED);
      expect(orderedChildAgents(state, 'root').map((a) => a.id)).toEqual(first);
      expect(treeLayout(state, 'root').map((p) => p.id)).toEqual(firstLayout);
    }
    expect(first).toEqual(expectedOrder(INTERLEAVED));
  });

  it('sorts an agent with no usable spawn edge last, and ties on the agent id', () => {
    const state = scriptedCorpus([1, 0]);
    const orphanA: AgentNode = {
      id: 'zz-orphan',
      kind: 'subagent',
      label: 'zz',
      status: 'running',
      spawnDepth: 1,
      children: [],
      startedAt: 0,
    };
    const orphanB: AgentNode = { ...orphanA, id: 'aa-orphan' };
    state.root.children.push(orphanA, orphanB);
    expect(orderedChildAgents(state, 'root').map((a) => a.id)).toEqual([
      'agent-01',
      'agent-00',
      'aa-orphan',
      'zz-orphan',
    ]);
  });

  it('an edge naming a tool that is not in the parent sorts the agent last', () => {
    const state = scriptedCorpus([0, 1]);
    const edges = [...(state.spawnEdges ?? [])];
    const head = edges[0];
    if (head === undefined) throw new Error('no edges');
    edges[0] = { ...head, toolUseId: 'tool-does-not-exist' };
    const stale: SessionState = { ...state, spawnEdges: edges };
    expect(orderedChildAgents(stale, 'root').map((a) => a.id)).toEqual([
      'agent-01',
      'agent-00',
    ]);
  });

  it('a duplicate edge cannot reorder anything', () => {
    const state = scriptedCorpus([1, 0]);
    const edges = [...(state.spawnEdges ?? [])];
    const head = edges[0];
    if (head === undefined) throw new Error('no edges');
    const duplicated: SessionState = {
      ...state,
      spawnEdges: [...edges, { ...head, toolUseId: 'tool-01' }],
    };
    expect(orderedChildAgents(duplicated, 'root').map((a) => a.id)).toEqual(
      orderedChildAgents(state, 'root').map((a) => a.id),
    );
  });

  it('returns nothing for an agent that is not in the tree', () => {
    expect(orderedChildAgents(scriptedCorpus([0]), 'nobody')).toEqual([]);
    expect(findAgent(scriptedCorpus([0]).root, 'nobody')).toBeUndefined();
  });

  it('finds an agent at any depth', () => {
    const session = liveSession();
    expect(findAgent(session.root, 'agent-2')?.id).toBe('agent-2');
    expect(findAgent(session.root, 'root')?.id).toBe('root');
  });
});
