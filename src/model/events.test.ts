import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, it, expect } from 'vitest';
import {
  CONFIRMED_HOOK_EVENT_NAMES,
  emptyDiagnostics,
  isAgentNode,
  isConfirmedHookEventName,
  isKnownHookEventName,
  isSchemaMismatch,
  isToolNode,
  KNOWN_HOOK_EVENT_NAMES,
  UNCONFIRMED_KNOWN_HOOK_EVENT_NAMES,
  type AgentNode,
  type NormalizedHookEvent,
  type RawHookPayload,
  type HostToWebviewMessage,
  type ParseResult,
  type SchemaMismatch,
  type SessionState,
  type SubagentMeta,
  type ToolNode,
  type TranscriptEntry,
  type TreeNode,
  type WebviewToHostMessage,
} from './events.js';

/** A hand-built tree shaped like the measured CC layout: main -> Agent tool -> subagent. */
function buildSession(): SessionState {
  const subagent: AgentNode = {
    id: 'a5e718f3cb731b607',
    kind: 'subagent',
    label: 'Explore — List contents of spike/',
    status: 'done',
    spawnDepth: 1,
    children: [],
    tokens: { in: 120, out: 45 },
    startedAt: 1_000,
    endedAt: 2_000,
  };

  const agentTool: ToolNode = {
    id: 'toolu_018fbDjBX1ah7FTXs727doeC',
    toolName: 'Agent',
    status: 'done',
    inputPreview: '{"description":"List contents of spike/"}',
    resultPreview: 'spike/ contains 5 files',
    durationMs: 1_000,
  };

  const readTool: ToolNode = {
    id: 'toolu_readfile',
    toolName: 'Read',
    status: 'running',
    inputPreview: '{"file_path":"spike/run.mjs"}',
  };

  const root: AgentNode = {
    id: 'root',
    kind: 'main',
    label: 'main',
    status: 'running',
    spawnDepth: 0,
    children: [readTool, agentTool, subagent],
    tokens: { in: 900, out: 300 },
    startedAt: 500,
  };

  return {
    sessionId: '4299490e-4a09-46a0-a544-7ffb0429e7e7',
    projectSlug: 'c--Users-dev-projects-agent-deck',
    workspaceMatch: true,
    liveness: 'live',
    schemaOk: true,
    root,
    totals: { inputTokens: 1020, outputTokens: 345, costUsd: 0.0123 },
  };
}

describe('domain model', () => {
  it('constructs a SessionState tree by hand', () => {
    const session = buildSession();
    expect(session.root.kind).toBe('main');
    expect(session.root.spawnDepth).toBe(0);
    expect(session.root.children).toHaveLength(3);
    expect(session.totals.inputTokens).toBe(1020);
  });

  it('isAgentNode discriminates agents from tools', () => {
    const session = buildSession();
    const [readTool, agentTool, subagent] = session.root.children as [
      TreeNode,
      TreeNode,
      TreeNode,
    ];

    expect(isAgentNode(readTool)).toBe(false);
    expect(isAgentNode(agentTool)).toBe(false);
    expect(isAgentNode(subagent)).toBe(true);

    expect(isToolNode(readTool)).toBe(true);
    expect(isToolNode(subagent)).toBe(false);
  });

  it('narrows to the right member type after the guard', () => {
    const session = buildSession();
    const agents: string[] = [];
    const tools: string[] = [];

    for (const child of session.root.children) {
      if (isAgentNode(child)) {
        // Only AgentNode has spawnDepth; this must typecheck.
        agents.push(`${child.id}@${child.spawnDepth}`);
      } else {
        // Only ToolNode has toolName; this must typecheck.
        tools.push(child.toolName);
      }
    }

    expect(agents).toEqual(['a5e718f3cb731b607@1']);
    expect(tools).toEqual(['Read', 'Agent']);
  });

  it('supports nesting a subagent under a subagent (spawnDepth 2)', () => {
    const deep: AgentNode = {
      id: 'child',
      kind: 'subagent',
      label: 'Explore — nested',
      status: 'running',
      spawnDepth: 2,
      children: [],
      tokens: { in: 1, out: 1 },
      startedAt: 10,
    };
    const parent: AgentNode = {
      id: 'parent',
      kind: 'subagent',
      label: 'Plan — outer',
      status: 'running',
      spawnDepth: 1,
      children: [deep],
      tokens: { in: 2, out: 2 },
      startedAt: 5,
    };

    const only = parent.children[0];
    expect(only).toBeDefined();
    expect(only && isAgentNode(only) && only.spawnDepth).toBe(2);
  });
});

describe('message contract', () => {
  it('host -> webview messages are a union keyed on type', () => {
    const messages: HostToWebviewMessage[] = [
      { type: 'snapshot', sessions: [buildSession()] },
      // `patch` was an arbitrary placeholder while `SessionPatch` was
      // `unknown`. Phase 2 gave it a real shape, so this is now a real patch.
      { type: 'diff', sessionId: 's1', patch: { fields: { liveness: 'idle' } } },
      { type: 'schemaMismatch', sessionId: 's1' },
    ];

    const seen = messages.map((m) => {
      switch (m.type) {
        case 'snapshot':
          return `snapshot:${m.sessions.length}`;
        case 'diff':
          return `diff:${m.sessionId}`;
        case 'schemaMismatch':
          return `mismatch:${m.sessionId}`;
      }
    });

    expect(seen).toEqual(['snapshot:1', 'diff:s1', 'mismatch:s1']);
  });

  it('webview -> host messages carry only UI intents', () => {
    const messages: WebviewToHostMessage[] = [
      { type: 'expandNode', sessionId: 's1', nodeId: 'n1' },
      { type: 'selectSession', sessionId: 's2' },
    ];

    const seen = messages.map((m) =>
      m.type === 'expandNode' ? `${m.type}:${m.nodeId}` : `${m.type}:${m.sessionId}`,
    );

    expect(seen).toEqual(['expandNode:n1', 'selectSession:s2']);
  });
});

describe('parser-facing types', () => {
  it('TranscriptEntry tolerates unknown extra fields', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      uuid: '6497cbe3-cecc-4c18-8320-8b58ce4af17a',
      parentUuid: null,
      sessionId: '4299490e-4a09-46a0-a544-7ffb0429e7e7',
      timestamp: '2026-08-18T21:56:31.099Z',
      version: '2.1.234',
      cwd: 'c:\\Users\\dev\\projects\\agent-deck',
      gitBranch: 'phase-0-tap-validation',
      isSidechain: true,
      agentId: 'a5e718f3cb731b607',
      message: { role: 'assistant', content: [] },
      // Fields CC emits that Phase 1 does not model:
      requestId: 'req_123',
      attributionAgent: 'a5e718f3cb731b607',
    };

    expect(entry.type).toBe('assistant');
    expect(entry['requestId']).toBe('req_123');
    // A queue-operation line carries almost nothing but `type`.
    const sparse: TranscriptEntry = { type: 'queue-operation', operation: 'enqueue' };
    expect(sparse.uuid).toBeUndefined();
  });

  it('SubagentMeta models the sidecar including optional worktree fields', () => {
    const meta: SubagentMeta = {
      agentType: 'Explore',
      description: 'List contents of spike/',
      toolUseId: 'toolu_018fbDjBX1ah7FTXs727doeC',
      spawnDepth: 1,
    };
    const nested: SubagentMeta = {
      ...meta,
      spawnDepth: 2,
      parentAgentId: 'a5e718f3cb731b607',
      worktreePath: 'C:\\wt\\agent-1',
      spawnedWithWorktree: true,
      worktreeBranch: 'agent-1',
    };

    expect(meta.parentAgentId).toBeUndefined();
    expect(nested.parentAgentId).toBe('a5e718f3cb731b607');
    expect(nested.worktreeBranch).toBe('agent-1');
  });

  it('ParseDiagnostics starts zeroed and records skips', () => {
    const diagnostics = emptyDiagnostics();
    expect(diagnostics).toEqual({
      malformedLines: 0,
      parsedLines: 0,
      skippedFiles: [],
    });

    diagnostics.malformedLines += 1;
    diagnostics.skippedFiles.push({ path: 'a.jsonl', reason: 'EACCES' });
    expect(diagnostics.malformedLines).toBe(1);
    expect(diagnostics.skippedFiles[0]?.reason).toBe('EACCES');

    // Fresh calls must not share state.
    expect(emptyDiagnostics().malformedLines).toBe(0);
  });

  it('a SchemaMismatch result is representable and narrowable', () => {
    const mismatch: SchemaMismatch = {
      kind: 'schemaMismatch',
      reason: 'expected subagents/ directory beside the main transcript',
      path: 'projects/slug/4299490e/subagents',
      field: 'layout',
      expected: 'directory',
      actual: 'missing',
      observedVersion: '2.1.999',
    };

    const refused: ParseResult<SessionState> = {
      ok: false,
      mismatch,
      diagnostics: emptyDiagnostics(),
    };

    // Refuse, don't guess: no partial tree is reachable on the failure branch.
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.mismatch.reason).toContain('subagents/');
      expect(refused.mismatch.actual).toBe('missing');
    }

    expect(isSchemaMismatch(mismatch)).toBe(true);
    expect(isSchemaMismatch({ kind: 'other' })).toBe(false);
    expect(isSchemaMismatch(null)).toBe(false);
    expect(isSchemaMismatch('schemaMismatch')).toBe(false);
  });

  it('a successful ParseResult carries data plus diagnostics', () => {
    const ok: ParseResult<SessionState> = {
      ok: true,
      value: buildSession(),
      diagnostics: { malformedLines: 2, parsedLines: 49, skippedFiles: [] },
    };

    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.sessionId).toBe('4299490e-4a09-46a0-a544-7ffb0429e7e7');
      expect(ok.diagnostics.malformedLines).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// (d) Hook-event contract
// ---------------------------------------------------------------------------
//
// Behaviour of the listener that produces these values is tested in
// src/hooks/listener.test.ts. What is pinned here is the contract itself: the
// event-name lists, their guards, and the fact that a main-thread event is
// representable with the agent id genuinely absent rather than defaulted.

const SESSIONSTART_FIXTURE_PATH = fileURLToPath(
  new URL(
    '../../fixtures/hook-events/cc-2.1.234-sessionstart.jsonl',
    import.meta.url,
  ),
);
const REDACTED_FIXTURE_PATH = fileURLToPath(
  new URL('../../fixtures/hook-events/cc-2.1.234-redacted.jsonl', import.meta.url),
);

async function readPayloads(path: string): Promise<RawHookPayload[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawHookPayload);
}

describe('hook event name lists', () => {
  it('confirms exactly the names measured on the pinned CC version', () => {
    expect([...CONFIRMED_HOOK_EVENT_NAMES]).toEqual([
      'SessionStart',
      'PreToolUse',
      'PostToolUse',
      'SubagentStart',
      'SubagentStop',
      'Stop',
    ]);
    for (const name of CONFIRMED_HOOK_EVENT_NAMES) {
      expect(isConfirmedHookEventName(name), name).toBe(true);
      expect(isKnownHookEventName(name), name).toBe(true);
    }
  });

  it('lists SessionStart as CONFIRMED, not merely known', () => {
    // Superseded answer: "registered but unmeasured". It was unmeasured only
    // because every earlier capture bound a listener partway through a
    // running session, and SessionStart fires at session onset. Binding the
    // listener first and opening a fresh CC window produced
    // fixtures/hook-events/cc-2.1.234-sessionstart.jsonl.
    expect(isConfirmedHookEventName('SessionStart')).toBe(true);
    expect(isKnownHookEventName('SessionStart')).toBe(true);
    expect([...CONFIRMED_HOOK_EVENT_NAMES]).toContain('SessionStart');
  });

  it('keeps the known-but-unconfirmed mechanism, correct while empty', () => {
    // Empty today. The list is not deleted: a future CC release will add
    // names, and this is where one waits between registration and first
    // observation. Empty must therefore behave, not just exist.
    expect([...UNCONFIRMED_KNOWN_HOOK_EVENT_NAMES]).toEqual([]);
    expect(KNOWN_HOOK_EVENT_NAMES).toHaveLength(
      CONFIRMED_HOOK_EVENT_NAMES.length + UNCONFIRMED_KNOWN_HOOK_EVENT_NAMES.length,
    );
    expect([...KNOWN_HOOK_EVENT_NAMES]).toEqual([...CONFIRMED_HOOK_EVENT_NAMES]);
    // With no unconfirmed members the two guards must agree on every input,
    // including junk ones.
    for (const value of [
      ...CONFIRMED_HOOK_EVENT_NAMES,
      'SomeFutureHook',
      'Notification',
      '',
      undefined,
      null,
      42,
    ]) {
      expect(isKnownHookEventName(value), String(value)).toBe(
        isConfirmedHookEventName(value),
      );
    }
  });

  it('both guards reject non-strings and unknown names without throwing', () => {
    for (const value of [undefined, null, 0, {}, [], true, '', 'preTooluse']) {
      expect(isConfirmedHookEventName(value)).toBe(false);
      expect(isKnownHookEventName(value)).toBe(false);
    }
  });
});

describe('the captured SessionStart payload (G6: pinned to fixture bytes)', () => {
  let sessionStarts: RawHookPayload[] = [];
  let others: RawHookPayload[] = [];

  beforeAll(async () => {
    sessionStarts = await readPayloads(SESSIONSTART_FIXTURE_PATH);
    others = await readPayloads(REDACTED_FIXTURE_PATH);
    // Counts derived from the files, never hard-coded: a re-harvest changes
    // the data and the expectation together.
    expect(sessionStarts.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
  });

  it('carries exactly the measured key set on every captured event', () => {
    const measuredKeySet = [
      'session_id',
      'transcript_path',
      'cwd',
      'hook_event_name',
      'source',
    ].sort();

    for (const payload of sessionStarts) {
      expect(payload.hook_event_name).toBe('SessionStart');
      expect(Object.keys(payload).sort()).toEqual(measuredKeySet);
      expect(payload['source']).toBe('startup');
      expect(isConfirmedHookEventName(payload.hook_event_name)).toBe(true);
    }
  });

  it('has no agent_id key at all — absence IS the main-thread signal', () => {
    for (const payload of sessionStarts) {
      expect(Object.prototype.hasOwnProperty.call(payload, 'agent_id')).toBe(
        false,
      );
      // Not a placeholder either: the value-comparison a broken correlator
      // would make finds nothing.
      expect(payload['agent_id']).toBeUndefined();
    }
  });

  it('is the only observed type without prompt_id, and carries no tool_use_id', () => {
    for (const payload of sessionStarts) {
      expect(Object.prototype.hasOwnProperty.call(payload, 'prompt_id')).toBe(
        false,
      );
      expect(Object.prototype.hasOwnProperty.call(payload, 'tool_use_id')).toBe(
        false,
      );
    }
    // The contrast that gives the assertion above its meaning: every event of
    // every other observed type does carry prompt_id.
    const withPromptId = others.filter((p) =>
      Object.prototype.hasOwnProperty.call(p, 'prompt_id'),
    );
    expect(withPromptId).toHaveLength(others.length);
    expect(others.some((p) => p.hook_event_name === 'SessionStart')).toBe(false);
  });
});

describe('NormalizedHookEvent shape', () => {
  it('represents a main-thread event with the agent id absent, not defaulted', () => {
    const mainThread: NormalizedHookEvent = {
      seq: 1,
      receivedAt: 1_700_000_000_000,
      eventName: 'Stop',
      eventNameConfirmed: true,
      sessionId: '9f1c2ad4-77b1-4e0e-9f3a-0b5c1d2e3f40',
      isMainThread: true,
      raw: { hook_event_name: 'Stop' },
    };

    // Main-thread-ness is a boolean, not a magic id: nothing here is a string
    // a correlator could match against an agent id.
    expect(typeof mainThread.isMainThread).toBe('boolean');
    expect('agentId' in mainThread).toBe(false);
  });

  it('represents a subagent event carrying the join keys', () => {
    const subagent: NormalizedHookEvent = {
      seq: 2,
      receivedAt: 1_700_000_000_001,
      eventName: 'PostToolUse',
      eventNameConfirmed: true,
      sessionId: '9f1c2ad4-77b1-4e0e-9f3a-0b5c1d2e3f40',
      agentId: 'a1a53f42c5eca8824',
      isMainThread: false,
      toolUseId: 'toolu_018fbDjBX1ah7FTXs727doeC',
      toolName: 'Bash',
      raw: { hook_event_name: 'PostToolUse' },
    };

    expect(subagent.isMainThread).toBe(false);
    expect(subagent.agentId).toBe('a1a53f42c5eca8824');
    expect(subagent.toolUseId).toBe('toolu_018fbDjBX1ah7FTXs727doeC');
  });

  it('allows a SubagentStart-shaped event with no tool_use_id at all', () => {
    // Measured 3/3: SubagentStart carries agent_id but no tool_use_id, so the
    // parent tool_use join must come from the JSONL sidecar, not from hooks.
    const start: NormalizedHookEvent = {
      seq: 3,
      receivedAt: 1_700_000_000_002,
      eventName: 'SubagentStart',
      eventNameConfirmed: true,
      sessionId: '9f1c2ad4-77b1-4e0e-9f3a-0b5c1d2e3f40',
      agentId: 'a1a53f42c5eca8824',
      isMainThread: false,
      raw: {
        hook_event_name: 'SubagentStart',
        prompt_id: '5b2e0d31-6c44-4f0a-9f11-77d0c9a5e112',
      },
    };

    expect('toolUseId' in start).toBe(false);
    expect(start.raw.prompt_id).toBe('5b2e0d31-6c44-4f0a-9f11-77d0c9a5e112');
  });

  it('keeps unknown payload keys on RawHookPayload', () => {
    const raw: RawHookPayload = {
      hook_event_name: 'PreToolUse',
      a_key_no_cc_version_has_sent_yet: { nested: [1, 2, 3] },
    };
    expect(raw['a_key_no_cc_version_has_sent_yet']).toEqual({
      nested: [1, 2, 3],
    });
  });
});
