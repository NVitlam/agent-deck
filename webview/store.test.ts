import { beforeAll, describe, expect, it } from 'vitest';
import type {
  SessionPatch,
  SessionState,
  WebviewToHostMessage,
} from '../src/model/events.js';
import { createStore } from './store.js';
import { liveSession, unsupportedSession } from './testdata.js';

/**
 * `src/model/session.ts` is node-only code — it reaches `graft.ts`, which
 * imports `node:crypto` and `node:path`. A static import would pull it into
 * `tsconfig.webview.json`'s program, where `types: []` means those modules do
 * not resolve, and `npm run typecheck` would fail on 28 errors in files this
 * package does not own. A specifier held in a variable is opaque to `tsc` and
 * resolved at runtime by vitest, which keeps the round-trip test real without
 * dragging node types into the browser project.
 */
const SESSION_MODULE = '../src/model/session.js';

let diffSessionState: (prev: SessionState, next: SessionState) => SessionPatch | undefined;

beforeAll(async () => {
  const mod = (await import(/* @vite-ignore */ SESSION_MODULE)) as {
    diffSessionState: typeof diffSessionState;
  };
  diffSessionState = mod.diffSessionState;
});

function collect(): { sink: (m: WebviewToHostMessage) => void; sent: WebviewToHostMessage[] } {
  const sent: WebviewToHostMessage[] = [];
  return { sink: (m) => sent.push(m), sent };
}

describe('snapshot', () => {
  it('loads sessions in the order the host sent them and selects the first', () => {
    const store = createStore();
    store.handleMessage({
      type: 'snapshot',
      sessions: [liveSession(), unsupportedSession()],
    });
    const view = store.getView();
    expect(view.sessions.map((s) => s.sessionId)).toEqual([
      'session-live',
      'session-unsupported',
    ]);
    expect(view.selectedSessionId).toBe('session-live');
    expect(view.selected?.sessionId).toBe('session-live');
  });

  it('keeps the selection when the session is still present', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });
    store.selectSession('session-unsupported');
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });
    expect(store.getView().selectedSessionId).toBe('session-unsupported');
  });

  it('re-selects when the selected session disappears', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });
    store.selectSession('session-unsupported');
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    expect(store.getView().selectedSessionId).toBe('session-live');
  });

  it('notifies subscribers', () => {
    const store = createStore();
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    expect(calls).toBe(1);
    off();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    expect(calls).toBe(1);
  });
});

describe('the snapshot/diff contract', () => {
  it('round trips: applying diffSessionState(prev, next) yields next', () => {
    // This is the contract the host guarantees. If the webview's reducer and
    // the host's differ ever disagree, the panel renders a tree that never
    // existed — so pin it here as well as in the host suite.
    const prev = liveSession();
    const next: SessionState = {
      ...prev,
      liveness: 'idle',
      totals: { inputTokens: 20_000, outputTokens: 9_000, costUsd: 0 },
      root: {
        ...prev.root,
        status: 'done',
        endedAt: 99_000,
        tokens: { in: 20_000, out: 9_000 },
        children: prev.root.children,
      },
    };

    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [prev] });
    const patch = diffSessionState(prev, next);
    expect(patch).toBeDefined();
    store.handleMessage({ type: 'diff', sessionId: prev.sessionId, patch: patch as SessionPatch });

    expect(store.getView().selected).toEqual(next);
    expect(store.getView().patchFailure).toBeUndefined();
  });

  it('round trips a tree edit that adds a subagent and its spawn edge', () => {
    const prev = liveSession();
    const next = liveSession({
      root: {
        ...prev.root,
        children: [
          ...prev.root.children,
          {
            id: 'agent-3',
            kind: 'subagent',
            label: 'doc-writer: update the handoff',
            status: 'running',
            spawnDepth: 1,
            children: [],
            tokens: { in: 10, out: 2 },
            startedAt: 5_000,
          },
        ],
      },
      spawnEdges: [
        ...(prev.spawnEdges ?? []),
        {
          toolUseId: 'tool-read',
          agentId: 'agent-3',
          parentNodeId: 'root',
          depth: 1,
          recordedDepth: 1,
        },
      ],
    });

    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [prev] });
    const patch = diffSessionState(prev, next);
    expect(patch).toBeDefined();
    store.handleMessage({ type: 'diff', sessionId: prev.sessionId, patch: patch as SessionPatch });
    expect(store.getView().selected).toEqual(next);
  });
});

describe('a diff that cannot be applied', () => {
  it('keeps the last good state and surfaces the failure instead of crashing', () => {
    const store = createStore();
    const session = liveSession();
    store.handleMessage({ type: 'snapshot', sessions: [session] });

    store.handleMessage({
      type: 'diff',
      sessionId: session.sessionId,
      patch: { tree: [{ op: 'removeNode', id: 'no-such-node' }] },
    });

    const view = store.getView();
    expect(view.patchFailure?.sessionId).toBe('session-live');
    expect(view.patchFailure?.message).toContain('no-such-node');
    // The previous tree is untouched — not half-applied, not blank.
    expect(view.selected).toEqual(session);
  });

  it('does not throw on a diff for a session it has never seen', () => {
    const store = createStore();
    expect(() =>
      store.handleMessage({ type: 'diff', sessionId: 'ghost', patch: { fields: {} } }),
    ).not.toThrow();
    expect(store.getView().patchFailure?.sessionId).toBe('ghost');
  });

  it('clears the failure when the host re-snapshots', () => {
    const store = createStore();
    const session = liveSession();
    store.handleMessage({ type: 'snapshot', sessions: [session] });
    store.handleMessage({
      type: 'diff',
      sessionId: session.sessionId,
      patch: { tree: [{ op: 'removeNode', id: 'nope' }] },
    });
    expect(store.getView().patchFailure).toBeDefined();
    store.handleMessage({ type: 'snapshot', sessions: [session] });
    expect(store.getView().patchFailure).toBeUndefined();
  });
});

describe('refusal', () => {
  it('refuses a session whose schemaOk is false', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [unsupportedSession()] });
    expect(store.getView().refused).toBe(true);
  });

  it('refuses a session whose liveness is unsupported even if schemaOk is true', () => {
    const store = createStore();
    store.handleMessage({
      type: 'snapshot',
      sessions: [unsupportedSession({ schemaOk: true })],
    });
    expect(store.getView().refused).toBe(true);
  });

  it('refuses after a schemaMismatch message for an otherwise healthy session', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    expect(store.getView().refused).toBe(false);
    store.handleMessage({ type: 'schemaMismatch', sessionId: 'session-live' });
    expect(store.getView().refused).toBe(true);
    expect(store.getView().sessions[0]?.refused).toBe(true);
  });

  it('forgets a mismatch for a session that leaves the snapshot', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });
    store.handleMessage({ type: 'schemaMismatch', sessionId: 'session-live' });
    store.handleMessage({ type: 'snapshot', sessions: [unsupportedSession()] });
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });
    expect(store.getView().sessions[0]?.refused).toBe(false);
  });
});

describe('degraded', () => {
  it('records the flag and reason', () => {
    const store = createStore();
    store.handleMessage({ type: 'degraded', degraded: true, reason: 'listenerDown' });
    expect(store.getView().degraded).toBe(true);
    expect(store.getView().degradedReason).toBe('listenerDown');
  });

  it('clears the reason when the tap recovers', () => {
    const store = createStore();
    store.handleMessage({ type: 'degraded', degraded: true, reason: 'noHookEvents' });
    store.handleMessage({ type: 'degraded', degraded: false });
    expect(store.getView().degraded).toBe(false);
    expect(store.getView().degradedReason).toBeUndefined();
  });

  it('stays dismissed across repeats of the same degraded message (no nagging)', () => {
    const store = createStore();
    store.handleMessage({ type: 'degraded', degraded: true, reason: 'noHookEvents' });
    store.dismissDegraded();
    for (let i = 0; i < 5; i += 1) {
      store.handleMessage({ type: 'degraded', degraded: true, reason: 'noHookEvents' });
    }
    expect(store.getView().degradedDismissed).toBe(true);
  });

  it('shows the banner again for a NEW degraded episode', () => {
    const store = createStore();
    store.handleMessage({ type: 'degraded', degraded: true, reason: 'noHookEvents' });
    store.dismissDegraded();
    store.handleMessage({ type: 'degraded', degraded: false });
    store.handleMessage({ type: 'degraded', degraded: true, reason: 'listenerDown' });
    expect(store.getView().degradedDismissed).toBe(false);
  });
});

describe('UI intents', () => {
  it('posts selectSession and nothing else', () => {
    const { sink, sent } = collect();
    const store = createStore(sink);
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });
    store.selectSession('session-unsupported');
    expect(sent).toEqual([{ type: 'selectSession', sessionId: 'session-unsupported' }]);
  });

  it('ignores a selection of a session it does not have', () => {
    const { sink, sent } = collect();
    const store = createStore(sink);
    store.selectSession('ghost');
    expect(sent).toEqual([]);
  });

  it('posts expandNode on every toggle, in both directions', () => {
    const { sink, sent } = collect();
    const store = createStore(sink);
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.toggleNode('tool-read');
    expect(store.isToggled('tool-read')).toBe(true);
    store.toggleNode('tool-read');
    expect(store.isToggled('tool-read')).toBe(false);
    expect(sent).toEqual([
      { type: 'expandNode', sessionId: 'session-live', nodeId: 'tool-read' },
      { type: 'expandNode', sessionId: 'session-live', nodeId: 'tool-read' },
    ]);
  });

  it('keeps toggles separate per session', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });
    store.toggleNode('tool-read');
    store.selectSession('session-unsupported');
    expect(store.isToggled('tool-read')).toBe(false);
    store.selectSession('session-live');
    expect(store.isToggled('tool-read')).toBe(true);
  });
});

describe('statelessness', () => {
  it('yields an identical view for the same snapshot fed twice', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    const first = store.getView();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    const second = store.getView();
    expect(second).toEqual(first);
  });

  it('accumulates nothing over 50 identical snapshots', () => {
    const store = createStore();
    for (let i = 0; i < 50; i += 1) {
      store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    }
    const view = store.getView();
    expect(view.sessions).toHaveLength(1);
    expect(view.toggledNodeIds).toEqual([]);
    expect(view.selected).toEqual(liveSession());
  });

  it('drops toggles belonging to a session the host stopped reporting', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });
    store.toggleNode('tool-read');
    expect(store.getView().toggledNodeIds).toEqual(['tool-read']);
    store.handleMessage({ type: 'snapshot', sessions: [unsupportedSession()] });
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });
    expect(store.getView().toggledNodeIds).toEqual([]);
  });

  it('holds no reference to a preview beyond the state the host sent', () => {
    // The webview never caches payloads: replacing the session replaces them.
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    const before = store.getView().selected?.root.children[0];
    store.handleMessage({
      type: 'snapshot',
      sessions: [
        liveSession({
          root: {
            ...liveSession().root,
            children: [
              { id: 'tool-read', toolName: 'Read', status: 'done', inputPreview: 'x' },
            ],
          },
        }),
      ],
    });
    const after = store.getView().selected?.root.children[0];
    expect(before).not.toEqual(after);
    expect(after).toEqual({
      id: 'tool-read',
      toolName: 'Read',
      status: 'done',
      inputPreview: 'x',
    });
  });
});
