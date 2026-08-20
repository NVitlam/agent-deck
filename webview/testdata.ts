/**
 * Test-only session builders for the webview package.
 *
 * These are hand-built `SessionState`s, not fixtures: the webview never reads
 * a transcript, so a captured JSONL file would prove nothing here. The shapes
 * mirror what `src/model/graft.ts` produces — notably that a subagent
 * `AgentNode` sits ADJACENT to the `ToolNode` that spawned it in
 * `children`, with the spawn relationship carried only by `spawnEdges`.
 *
 * `costUsd` is 0 everywhere because the host always sends 0; see
 * `format.ts:formatCost` for what 0 means.
 */

import type { AgentNode, SessionState, SpawnEdge, ToolNode } from '../src/model/events.js';

/** A payload long enough to exercise collapsed/expanded previews. */
export function longPreview(chars = 2000, seed = 'tool-results payload '): string {
  let out = '';
  while (out.length < chars) out += seed;
  return out.slice(0, chars);
}

export function tool(overrides: Partial<ToolNode> & { id: string }): ToolNode {
  return {
    toolName: 'Read',
    status: 'done',
    inputPreview: '{"file_path":"src/model/events.ts"}',
    ...overrides,
  };
}

export function agent(overrides: Partial<AgentNode> & { id: string }): AgentNode {
  return {
    kind: 'subagent',
    label: 'subagent',
    status: 'done',
    spawnDepth: 1,
    children: [],
    tokens: { in: 0, out: 0 },
    startedAt: 1_000,
    ...overrides,
  };
}

/**
 * A session with a depth-2 subagent chain:
 *
 *   root (main)
 *     tool-read      Read, done
 *     tool-agent-1   Agent, done      <- spawn edge -> agent-1
 *     agent-1        subagent d1
 *       tool-agent-2 Agent, running   <- spawn edge -> agent-2
 *       agent-2      subagent d2
 *         tool-bash  Bash, error
 *
 * `agent-1` and `agent-2` are siblings of their spawning tool calls in
 * `children`; only `spawnEdges` says which tool spawned which agent.
 */
export function liveSession(overrides: Partial<SessionState> = {}): SessionState {
  const agent2 = agent({
    id: 'agent-2',
    label: 'code-reviewer: check the diff',
    spawnDepth: 2,
    status: 'running',
    tokens: { in: 900, out: 120 },
    startedAt: 3_000,
    children: [
      tool({
        id: 'tool-bash',
        toolName: 'Bash',
        status: 'error',
        durationMs: 75,
        inputPreview: '{"command":"npm run typecheck"}',
        resultPreview: 'error: exit 2',
      }),
    ],
  });

  const agent1 = agent({
    id: 'agent-1',
    label: 'test-runner: run the module suite',
    spawnDepth: 1,
    status: 'running',
    tokens: { in: 4_500, out: 1_250 },
    startedAt: 2_000,
    children: [
      tool({
        id: 'tool-agent-2',
        toolName: 'Agent',
        status: 'running',
        inputPreview: '{"subagent_type":"code-reviewer"}',
      }),
      agent2,
    ],
  });

  const root: AgentNode = {
    id: 'root',
    kind: 'main',
    label: 'main session',
    status: 'running',
    spawnDepth: 0,
    tokens: { in: 12_345, out: 6_789 },
    startedAt: 1_000,
    children: [
      tool({
        id: 'tool-read',
        toolName: 'Read',
        status: 'done',
        durationMs: 1_500,
        // Stands in for a payload offloaded to `tool-results/<id>.txt`. From
        // the webview's side that is just a long string; provenance is the
        // host's problem and is not visible here.
        resultPreview: longPreview(),
      }),
      tool({
        id: 'tool-agent-1',
        toolName: 'Agent',
        status: 'done',
        durationMs: 61_000,
        inputPreview: '{"subagent_type":"test-runner"}',
      }),
      agent1,
    ],
  };

  const spawnEdges: SpawnEdge[] = [
    {
      toolUseId: 'tool-agent-1',
      agentId: 'agent-1',
      parentNodeId: 'root',
      depth: 1,
      recordedDepth: 1,
    },
    {
      toolUseId: 'tool-agent-2',
      agentId: 'agent-2',
      parentNodeId: 'agent-1',
      depth: 2,
      recordedDepth: 2,
    },
  ];

  return {
    sessionId: 'session-live',
    projectSlug: 'c--Users-dev-projects-agent-deck',
    workspaceMatch: true,
    liveness: 'live',
    schemaOk: true,
    root,
    totals: { inputTokens: 17_745, outputTokens: 8_159, costUsd: 0 },
    spawnEdges,
    ...overrides,
  };
}

/** A session the fingerprint refused. Its tree must never be drawn (G3). */
export function unsupportedSession(overrides: Partial<SessionState> = {}): SessionState {
  const live = liveSession();
  return {
    ...live,
    sessionId: 'session-unsupported',
    liveness: 'unsupported',
    schemaOk: false,
    ...overrides,
  };
}
