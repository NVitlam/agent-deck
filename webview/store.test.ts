import { beforeAll, describe, expect, it } from 'vitest';
import type {
  SessionPatch,
  SessionState,
  WebviewToHostMessage,
} from '../src/model/events.js';
import { createStore } from './store.js';
import { DEFAULT_VIEW_MODE } from './canvas-contract.js';
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

// ---------------------------------------------------------------------------
// Canvas UI state (spec C7.1, C7.2, C7.7, C7.8)
// ---------------------------------------------------------------------------
//
// Altitude, node selection and the renderer toggle are webview-local. The
// whole reason the canvas costs no host diff is that none of them is on the
// wire, so "no new message" is asserted here as often as the behaviour is.

describe('altitude and node selection', () => {
  it('starts at the deck with nothing inspected, before any message arrives', () => {
    const view = createStore().getView();
    expect(view.altitude).toBe('deck');
    expect(view.selectedNodeId).toBeUndefined();
    expect(view.selectedNode).toBeUndefined();
  });

  it('stays at the deck when a snapshot arrives and auto-selects a session', () => {
    // Auto-selection is a rail concern; it must not zoom the canvas for the
    // user. A reload therefore lands on the deck, which C7.7 calls correct.
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    const view = store.getView();
    expect(view.selectedSessionId).toBe('session-live');
    expect(view.altitude).toBe('deck');
  });

  it('enterSession zooms to the interior and posts only the existing intent', () => {
    const { sink, sent } = collect();
    const store = createStore(sink);
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.enterSession('session-live');
    expect(store.getView().altitude).toBe('session');
    expect(sent).toEqual([{ type: 'selectSession', sessionId: 'session-live' }]);
  });

  it('selectSession alone does not move the altitude', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });
    store.selectSession('session-unsupported');
    expect(store.getView().altitude).toBe('deck');
  });

  it('selectNode opens the inspector and sends the host NOTHING', () => {
    const { sink, sent } = collect();
    const store = createStore(sink);
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.enterSession('session-live');
    sent.length = 0;
    store.selectNode('tool-bash');
    const view = store.getView();
    expect(view.altitude).toBe('inspector');
    expect(view.selectedNodeId).toBe('tool-bash');
    expect(view.selectedNode?.id).toBe('tool-bash');
    expect(sent).toEqual([]);
  });

  it('finds a node at any depth, agent or tool', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.enterSession('session-live');
    // `agent-2` is a depth-2 subagent, two levels below the root.
    store.selectNode('agent-2');
    expect(store.getView().selectedNode?.id).toBe('agent-2');
    expect((store.getView().selectedNode as { label: string }).label).toBe(
      'code-reviewer: check the diff',
    );
    store.selectNode('root');
    expect(store.getView().selectedNode?.id).toBe('root');
  });

  it('ignores a node id that is not in the tree', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.enterSession('session-live');
    store.selectNode('no-such-node');
    expect(store.getView().altitude).toBe('session');
    expect(store.getView().selectedNodeId).toBeUndefined();
  });

  it('refuses to inspect a node of a refused session (G3, C7.4)', () => {
    // Entering an unsupported session shows the refusal card and an interior
    // of zero elements. There is nothing to select, so selecting is a no-op
    // rather than an inspector opened onto a tree we declined to draw.
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [unsupportedSession()] });
    store.enterSession('session-unsupported');
    expect(store.getView().refused).toBe(true);
    store.selectNode('tool-read');
    expect(store.getView().altitude).toBe('session');
    expect(store.getView().selectedNodeId).toBeUndefined();
  });

  it('notifies subscribers on selectNode', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    let calls = 0;
    const off = store.subscribe(() => (calls += 1));
    store.selectNode('tool-read');
    expect(calls).toBe(1);
    off();
  });
});

describe('Escape walks the altitudes up (C7.8)', () => {
  function atInspector(): ReturnType<typeof createStore> {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.enterSession('session-live');
    store.selectNode('tool-read');
    return store;
  }

  it('goes inspector -> session interior -> deck, dropping the node on the way', () => {
    const store = atInspector();
    expect(store.getView().altitude).toBe('inspector');

    store.escape();
    expect(store.getView().altitude).toBe('session');
    expect(store.getView().selectedNodeId).toBeUndefined();

    store.escape();
    expect(store.getView().altitude).toBe('deck');
    // The session stays selected: Escape changes altitude, not selection, so
    // the list view (the same store, a different projection) is unaffected.
    expect(store.getView().selectedSessionId).toBe('session-live');
  });

  it('is a silent no-op at the deck', () => {
    const store = atInspector();
    store.escape();
    store.escape();
    let calls = 0;
    const off = store.subscribe(() => (calls += 1));
    store.escape();
    expect(store.getView().altitude).toBe('deck');
    // A keystroke that changed nothing must not look like a change.
    expect(calls).toBe(0);
    off();
  });
});

describe('the in-panel view toggle (C7.2)', () => {
  it('starts on the canvas, with no setting and nothing remembered', () => {
    expect(createStore().getView().viewMode).toBe('canvas');
    expect(createStore().getView().viewMode).toBe(DEFAULT_VIEW_MODE);
  });

  it('toggles canvas -> list -> canvas', () => {
    const store = createStore();
    store.toggleViewMode();
    expect(store.getView().viewMode).toBe('list');
    store.toggleViewMode();
    expect(store.getView().viewMode).toBe('canvas');
  });

  it('does not touch altitude or selection', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.enterSession('session-live');
    store.selectNode('tool-read');
    store.toggleViewMode();
    const view = store.getView();
    expect(view.viewMode).toBe('list');
    expect(view.altitude).toBe('inspector');
    expect(view.selectedNodeId).toBe('tool-read');
  });

  it('sends the host nothing, in either direction', () => {
    const { sink, sent } = collect();
    const store = createStore(sink);
    store.setViewMode('list');
    store.toggleViewMode();
    expect(sent).toEqual([]);
  });

  it('does not notify when the mode is set to the one already showing', () => {
    const store = createStore();
    let calls = 0;
    const off = store.subscribe(() => (calls += 1));
    store.setViewMode('canvas');
    expect(calls).toBe(0);
    store.setViewMode('list');
    expect(calls).toBe(1);
    off();
  });

  it('starts a fresh store back on the canvas — nothing survives a reload (G7)', () => {
    // A reload is a new store. Nothing is read back from anywhere, because
    // there is nowhere to read it back from: no storage, no history, nothing
    // on the wire. The shipped-bundle guard in `bundle.test.ts` pins the
    // absence of the storage APIs themselves.
    const before = createStore();
    before.setViewMode('list');
    expect(before.getView().viewMode).toBe('list');
    expect(createStore().getView().viewMode).toBe('canvas');
  });
});

describe('canvas state accumulates nothing either', () => {
  it('drops the inspected node when it leaves the tree, and falls back one altitude', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.enterSession('session-live');
    store.selectNode('tool-bash');
    expect(store.getView().altitude).toBe('inspector');

    // Same session, a tree that no longer contains that node.
    store.handleMessage({
      type: 'snapshot',
      sessions: [liveSession({ root: { ...liveSession().root, children: [] } })],
    });
    const view = store.getView();
    expect(view.selectedNodeId).toBeUndefined();
    expect(view.selectedNode).toBeUndefined();
    expect(view.altitude).toBe('session');
  });

  it('drops to the deck when the session being inspected leaves the snapshot', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });
    store.enterSession('session-live');
    store.selectNode('tool-read');

    store.handleMessage({ type: 'snapshot', sessions: [unsupportedSession()] });
    const view = store.getView();
    expect(view.selectedSessionId).toBe('session-unsupported');
    // Re-pointing the same interior frame at a different session would show
    // the user something else without saying so.
    expect(view.altitude).toBe('deck');
    expect(view.selectedNodeId).toBeUndefined();
  });

  it('drops to the deck when the host reports no sessions at all', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.enterSession('session-live');
    store.selectNode('tool-read');
    store.handleMessage({ type: 'snapshot', sessions: [] });
    const view = store.getView();
    expect(view.selectedSessionId).toBeUndefined();
    expect(view.altitude).toBe('deck');
    expect(view.selectedNodeId).toBeUndefined();
  });

  it('closes the inspector when the session is refused mid-flight', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.enterSession('session-live');
    store.selectNode('tool-read');
    store.handleMessage({ type: 'schemaMismatch', sessionId: 'session-live' });
    const view = store.getView();
    expect(view.refused).toBe(true);
    expect(view.altitude).toBe('session');
    expect(view.selectedNodeId).toBeUndefined();
    expect(view.selectedNode).toBeUndefined();
  });

  it('forgets the inspected node when the user switches session', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });
    store.enterSession('session-live');
    store.selectNode('tool-read');
    store.selectSession('session-unsupported');
    expect(store.getView().selectedNodeId).toBeUndefined();
    store.selectSession('session-live');
    // Not remembered on the way back either: one slot, not a per-session map.
    expect(store.getView().selectedNodeId).toBeUndefined();
  });

  it('holds altitude and selection steady across 50 identical snapshots', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.enterSession('session-live');
    store.selectNode('tool-read');
    const first = store.getView();
    for (let i = 0; i < 50; i += 1) {
      store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    }
    expect(store.getView()).toEqual(first);
  });
});
