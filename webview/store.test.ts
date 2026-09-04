import { beforeAll, describe, expect, it } from 'vitest';
import type {
  SessionPatch,
  SessionState,
  WebviewToHostMessage,
} from '../src/model/events.js';
import { createStore } from './store.js';
import { DEFAULT_VIEW_MODE } from './canvas-contract.js';
import { DECK_FIT_PADDING, DECK_ZOOM_LIMITS, fitTo, zoomAbout } from './viewport.js';
import {
  DEFAULT_DECK_LAYOUT,
  DEFAULT_DECK_SORT,
  countNodes,
  deckEngine,
  deckLayout,
} from './layout.js';
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
      totals: { costUsd: 0 }, contextNow: { prompt: 20_000, output: 9_000 }, burn: { prompt: 20_000, output: 9_000 },
      root: {
        ...prev.root,
        status: 'done',
        endedAt: 99_000,
        contextNow: { prompt: 20_000, output: 9_000 }, burn: { prompt: 20_000, output: 9_000 },
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
            contextNow: { prompt: 10, output: 2 }, burn: { prompt: 10, output: 2 },
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
    store.handleMessage({ type: 'degraded', engine: 'cc', degraded: true, reason: 'listenerDown' });
    expect(store.getView().degraded).toBe(true);
    expect(store.getView().degradedReason).toBe('listenerDown');
  });

  /*
   * DoD 5.0b - THE STORE ROUTES BY ENGINE, AND THIS TEST EXISTS BECAUSE A
   * MUTATION PROVED NOTHING WAS CHECKING IT.
   *
   * The rendering half is pinned in `webview/deck.test.ts` and the sourcing
   * half in `src/extension.test.ts`. Between them sits this reducer, and
   * replacing its engine check with `if (false)` - routing every message into
   * the Claude Code slot - left BOTH of those suites green: the component
   * tests mount with `degradedByEngine` supplied BY HAND, so they prove the
   * component honours a value the store might never produce.
   *
   * That is the D4 shape exactly, and it is the reason this file has to drive
   * the reducer with a real wire message instead.
   */
  it('routes a Codex message to the Codex tap and leaves Claude Code alone', () => {
    const store = createStore();
    store.handleMessage({ type: 'degraded', engine: 'codex', degraded: true, reason: 'noHookEvents' });

    const view = store.getView();
    expect(view.degradedByEngine.codex).toStrictEqual({
      degraded: true,
      reason: 'noHookEvents',
    });
    // The Claude Code half is untouched - both in the by-engine record and in
    // the scalar the panel banner reads. A Codex message moving the banner is
    // D2 running backwards.
    expect(view.degradedByEngine.cc).toStrictEqual({ degraded: false });
    expect(view.degraded).toBe(false);
    expect(view.degradedReason).toBeUndefined();
  });

  it('routes a Claude Code message to the Claude Code tap and leaves Codex alone', () => {
    const store = createStore();
    store.handleMessage({ type: 'degraded', engine: 'cc', degraded: true, reason: 'listenerDown' });

    const view = store.getView();
    expect(view.degradedByEngine.cc).toStrictEqual({
      degraded: true,
      reason: 'listenerDown',
    });
    expect(view.degradedByEngine.codex).toStrictEqual({ degraded: false });
  });

  it('keeps two taps in different states at the same time', () => {
    // The state a single flag cannot hold, which is the whole point of the
    // item. Different reasons as well as different booleans, so a shared value
    // cannot satisfy both.
    const store = createStore();
    store.handleMessage({ type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' });
    store.handleMessage({ type: 'degraded', engine: 'codex', degraded: true, reason: 'listenerDown' });
    store.handleMessage({ type: 'degraded', engine: 'cc', degraded: false });

    const view = store.getView();
    expect(view.degradedByEngine.cc).toStrictEqual({ degraded: false });
    expect(view.degradedByEngine.codex).toStrictEqual({
      degraded: true,
      reason: 'listenerDown',
    });
  });

  it('a Codex message never touches the banner dismissal', () => {
    // The dismissal silences ONE episode of the Claude Code banner. A Codex
    // message arriving in between must not re-open it, which is the "no
    // nagging" rule surviving the second tap.
    const store = createStore();
    store.handleMessage({ type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' });
    store.dismissDegraded();
    expect(store.getView().degradedDismissed).toBe(true);

    store.handleMessage({ type: 'degraded', engine: 'codex', degraded: true, reason: 'noHookEvents' });
    store.handleMessage({ type: 'degraded', engine: 'codex', degraded: false });

    expect(store.getView().degradedDismissed).toBe(true);
  });
  it('clears the reason when the tap recovers', () => {
    const store = createStore();
    store.handleMessage({ type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' });
    store.handleMessage({ type: 'degraded', engine: 'cc', degraded: false });
    expect(store.getView().degraded).toBe(false);
    expect(store.getView().degradedReason).toBeUndefined();
  });

  it('stays dismissed across repeats of the same degraded message (no nagging)', () => {
    const store = createStore();
    store.handleMessage({ type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' });
    store.dismissDegraded();
    for (let i = 0; i < 5; i += 1) {
      store.handleMessage({ type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' });
    }
    expect(store.getView().degradedDismissed).toBe(true);
  });

  it('shows the banner again for a NEW degraded episode', () => {
    const store = createStore();
    store.handleMessage({ type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' });
    store.dismissDegraded();
    store.handleMessage({ type: 'degraded', engine: 'cc', degraded: false });
    store.handleMessage({ type: 'degraded', engine: 'cc', degraded: true, reason: 'listenerDown' });
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

// ---------------------------------------------------------------------------
// Deck-facing derived numbers (spec C7.1 radius, C7.3 error badge)
// ---------------------------------------------------------------------------
//
// Both live on `SessionSummary` rather than in a component, for the same
// reason `refused` and `label` do: per-session derivation is the store's job,
// and `layout.ts:DeckSession` is exactly `{ sessionId, nodeCount }`, so a
// summary carrying the count feeds the layout engine with no session state in
// between.

describe('SessionSummary.nodeCount', () => {
  it('counts every node in the tree, agents and tools alike, root included', () => {
    // `liveSession()` is root + tool-read + tool-agent-1 + agent-1 +
    // tool-agent-2 + agent-2 + tool-bash.
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    expect(store.getView().sessions[0]?.nodeCount).toBe(7);
  });

  it('agrees with layout.ts:countNodes rather than with a second walk', () => {
    // The store imports `countNodes`; this pins that the summary carries the
    // SAME number the layout goldens are cut against, so a blob's radius can
    // never disagree with the count the deck was handed.
    const store = createStore();
    const session = liveSession();
    store.handleMessage({ type: 'snapshot', sessions: [session] });
    expect(store.getView().sessions[0]?.nodeCount).toBe(countNodes(session));
  });

  it('counts a bare root as 1', () => {
    const store = createStore();
    store.handleMessage({
      type: 'snapshot',
      sessions: [liveSession({ root: { ...liveSession().root, children: [] } })],
    });
    expect(store.getView().sessions[0]?.nodeCount).toBe(1);
  });

  it('tracks a diff that adds a node', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.handleMessage({
      type: 'diff',
      sessionId: 'session-live',
      patch: {
        tree: [
          {
            op: 'insertNode',
            parentId: 'root',
            // DoD 5.5.1: a sibling anchor, not an index. `null` is "first
            // child"; this appends after the last one the fixture builds.
            afterId: 'tool-agent-1',
            node: { id: 'tool-new', toolName: 'Glob', status: 'running', inputPreview: '{}' },
          },
        ],
      },
    });
    expect(store.getView().patchFailure).toBeUndefined();
    expect(store.getView().sessions[0]?.nodeCount).toBe(8);
  });
});

describe('SessionSummary.errorCount', () => {
  it('counts tool calls that ended in error', () => {
    // `tool-bash` is the one `status: 'error'` tool in `liveSession()`.
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    expect(store.getView().sessions[0]?.errorCount).toBe(1);
  });

  it('does NOT count an agent whose own status is error', () => {
    // An agent is `error` because a tool under it failed, so counting both
    // halves would report one failure twice on the deck badge. Here the agent
    // is `error` with no failing tool anywhere: the badge must read 0.
    const store = createStore();
    const base = liveSession();
    store.handleMessage({
      type: 'snapshot',
      sessions: [
        liveSession({
          root: {
            ...base.root,
            status: 'error',
            children: [
              {
                id: 'agent-x',
                kind: 'subagent',
                label: 'failed subagent',
                status: 'error',
                spawnDepth: 1,
                children: [
                  { id: 'tool-ok', toolName: 'Read', status: 'done', inputPreview: '{}' },
                ],
                contextNow: { prompt: 1, output: 1 }, burn: { prompt: 1, output: 1 },
                startedAt: 1_000,
              },
            ],
          },
        }),
      ],
    });
    expect(store.getView().sessions[0]?.errorCount).toBe(0);
    // The agent is still counted as a NODE; only the error tally excludes it.
    expect(store.getView().sessions[0]?.nodeCount).toBe(3);
  });

  it('counts errors at every depth, and more than one of them', () => {
    const base = liveSession();
    const store = createStore();
    store.handleMessage({
      type: 'snapshot',
      sessions: [
        liveSession({
          root: {
            ...base.root,
            children: [
              { id: 'tool-a', toolName: 'Bash', status: 'error', inputPreview: '{}' },
              ...base.root.children,
            ],
          },
        }),
      ],
    });
    // `tool-a` at depth 1 plus `tool-bash`, which sits three levels down.
    expect(store.getView().sessions[0]?.errorCount).toBe(2);
  });

  it('reports 0 for a tree with no failures', () => {
    const store = createStore();
    store.handleMessage({
      type: 'snapshot',
      sessions: [liveSession({ root: { ...liveSession().root, children: [] } })],
    });
    expect(store.getView().sessions[0]?.errorCount).toBe(0);
  });
});

describe('a refused session reports nothing about its tree (G3)', () => {
  it('emits 0 for both numbers when the session refused itself', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [unsupportedSession()] });
    const summary = store.getView().sessions[0];
    expect(summary?.refused).toBe(true);
    // `unsupportedSession()` carries the SAME 7-node tree as `liveSession()`.
    // Reporting 7 would size its blob from a layout we declined to trust, and
    // reporting 1 error would draw a badge off it. Both are 0.
    expect(summary?.nodeCount).toBe(0);
    expect(summary?.errorCount).toBe(0);
  });

  it('drops both to 0 when a schemaMismatch arrives for a healthy session', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    expect(store.getView().sessions[0]?.nodeCount).toBe(7);
    expect(store.getView().sessions[0]?.errorCount).toBe(1);
    store.handleMessage({ type: 'schemaMismatch', sessionId: 'session-live' });
    expect(store.getView().sessions[0]?.nodeCount).toBe(0);
    expect(store.getView().sessions[0]?.errorCount).toBe(0);
  });

  it('restores both when the session stops being refused', () => {
    // The mismatch set is dropped for a session that leaves the snapshot, so
    // the numbers come back rather than latching at 0 for the window's life.
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });
    store.handleMessage({ type: 'schemaMismatch', sessionId: 'session-live' });
    expect(store.getView().sessions[0]?.nodeCount).toBe(0);
    store.handleMessage({ type: 'snapshot', sessions: [unsupportedSession()] });
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });
    expect(store.getView().sessions[0]?.nodeCount).toBe(7);
    expect(store.getView().sessions[0]?.errorCount).toBe(1);
  });
});

describe('the derived numbers accumulate nothing', () => {
  it('is deep-equal across 50 identical snapshots, summaries included', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    const first = store.getView().sessions;
    for (let i = 0; i < 50; i += 1) {
      store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    }
    expect(store.getView().sessions).toEqual(first);
    expect(store.getView().sessions[0]?.nodeCount).toBe(7);
    expect(store.getView().sessions[0]?.errorCount).toBe(1);
  });
});

describe('SessionSummary — the deck card\u2019s own figures', () => {
  it('counts agents and in-flight TOOLS separately, and neither twice', () => {
    // `liveSession()` is root + agent-1 + agent-2, with exactly one running
    // tool call (`tool-agent-2`). Two of the three agents are `running` too,
    // and they are deliberately NOT counted as in flight: an agent is running
    // BECAUSE a tool under it is, so counting both would report one in-flight
    // call three times on this tree.
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    const row = store.getView().sessions[0];
    expect(row?.agents).toBe(3);
    expect(row?.inflight).toBe(1);
  });

  it('carries burn and contextNow by reference, and absent stays absent', () => {
    const state = liveSession();
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [state] });
    expect(store.getView().sessions[0]?.burn).toStrictEqual(state.burn);
    expect(store.getView().sessions[0]?.contextNow).toStrictEqual(state.contextNow);

    const bare = liveSession({ sessionId: 'session-bare' });
    delete (bare as { burn?: unknown }).burn;
    delete (bare as { contextNow?: unknown }).contextNow;
    const second = createStore();
    second.handleMessage({ type: 'snapshot', sessions: [bare] });
    const row = second.getView().sessions[0];
    // ABSENT, never 0. An engine that reports no figure leaves the field
    // unset, and a renderer shows an em-dash; writing 0 here would claim the
    // session spent nothing.
    expect(row?.burn).toBeUndefined();
    expect(row?.contextNow).toBeUndefined();
    expect('burn' in (row ?? {})).toBe(false);
  });

  it('carries windowTokens by value, same absence rule, same reason (v0.6.0 Phase 3)', () => {
    // The Codex engine's context-window ceiling. CC and OpenCode sessions
    // never set it, so the CC-shaped `liveSession()` fixture leaves it unset
    // by construction — that IS the case this test pins, not an oversight.
    const cc = createStore();
    cc.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    const ccRow = cc.getView().sessions[0];
    expect(ccRow?.windowTokens).toBeUndefined();
    expect('windowTokens' in (ccRow ?? {})).toBe(false);

    const codex = createStore();
    codex.handleMessage({
      type: 'snapshot',
      sessions: [liveSession({ sessionId: 'session-codex', engine: 'codex', windowTokens: 200_000 })],
    });
    expect(codex.getView().sessions[0]?.windowTokens).toBe(200_000);
  });

  it('takes lastEventAt from the greatest agent timestamp in the tree', () => {
    // `liveSession()`: root at 1,000, agent-1 at 2,000, agent-2 at 3,000.
    // Tools carry no timestamp at all, so they contribute nothing.
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    expect(store.getView().sessions[0]?.lastEventAt).toBe(3_000);
  });

  it('prefers endedAt to startedAt: a finished agent was last heard from then', () => {
    const store = createStore();
    const state = liveSession();
    store.handleMessage({
      type: 'snapshot',
      sessions: [liveSession({ root: { ...state.root, endedAt: 9_999 } })],
    });
    expect(store.getView().sessions[0]?.lastEventAt).toBe(9_999);
  });

  it('carries costUsd unchanged, 0 included, because 0 means NOT COMPUTED', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    expect(store.getView().sessions[0]?.costUsd).toBe(0);
    const paid = createStore();
    paid.handleMessage({
      type: 'snapshot',
      sessions: [liveSession({ totals: { costUsd: 1.25 } })],
    });
    expect(paid.getView().sessions[0]?.costUsd).toBe(1.25);
  });

  it('reads NO number off a refused session — G3, on every one of the new fields', () => {
    const store = createStore();
    store.handleMessage({
      type: 'snapshot',
      sessions: [unsupportedSession({ engine: 'codex', windowTokens: 200_000 })],
    });
    const row = store.getView().sessions[0];
    expect(row?.refused).toBe(true);
    expect(row?.agents).toBe(0);
    expect(row?.inflight).toBe(0);
    expect(row?.costUsd).toBe(0);
    expect(row?.lastEventAt).toBe(0);
    expect(row?.burn).toBeUndefined();
    expect(row?.contextNow).toBeUndefined();
    // Even a Codex session that DID report a window ceiling reads none of it
    // once refused — the same G3 treatment `burn`/`contextNow` already get.
    expect(row?.windowTokens).toBeUndefined();
  });
});

describe('Phase 4.6 — deck filter, inspector toggle, pan/zoom', () => {
  it('filters by liveness without touching the host\u2019s account of what exists', () => {
    const store = createStore();
    store.handleMessage({
      type: 'snapshot',
      sessions: [
        liveSession(),
        liveSession({ sessionId: 'session-idle', liveness: 'idle' }),
        liveSession({ sessionId: 'session-ended', liveness: 'ended' }),
      ],
    });

    const all = store.getView();
    expect(all.livenessFilter).toBe('all');
    expect(all.filteredSessions).toHaveLength(3);

    store.setLivenessFilter('live');
    const live = store.getView();
    expect(live.filteredSessions.map((r) => r.liveness)).toEqual(['live']);

    // The point of the assertion: `sessions` is UNFILTERED. A component that
    // wanted to say "1 of 3" must be able to, and nothing downstream may
    // mistake a filtered list for everything the host reported.
    expect(live.sessions).toHaveLength(3);
  });

  it('holds the ENGINE filter too, and holds it across a session round trip', () => {
    // THE DEFECT THIS PINS. `engineFilter` was `$state` inside `Deck.svelte`,
    // and `App.svelte` mounts `<Deck>` only while the altitude is `deck` — so
    // entering a session destroyed the component and returning rebuilt it at
    // `all`. The user's chosen engine silently reset on every session visit,
    // beside a liveness filter that persisted, with nothing saying why.
    //
    // Asserted at the STORE, because that is where the fix is; `deck.test.ts`
    // drives the same round trip through the mounted panel's DOM.
    const store = createStore();
    store.handleMessage({
      type: 'snapshot',
      sessions: [
        liveSession(),
        liveSession({ sessionId: 'session-oc', engine: 'opencode' }),
      ],
    });
    expect(store.getView().engineFilter).toBe('all');

    store.setEngineFilter('oc');
    expect(store.getView().engineFilter).toBe('oc');

    store.enterSession('session-live');
    expect(store.getView().altitude).toBe('session');
    store.escape();
    expect(store.getView().altitude).toBe('deck');

    // The whole test. Before the fix this read 'all'.
    expect(store.getView().engineFilter).toBe('oc');

    // The two axes are independent: setting one never moves the other.
    store.setLivenessFilter('live');
    expect(store.getView().engineFilter).toBe('oc');
    store.setEngineFilter('cc');
    expect(store.getView().livenessFilter).toBe('live');
  });

  it('refuses an engine value that is not one of the four, and notifies nobody', () => {
    // "Four" as of v0.6.0 Phase 3: `all` / `cc` / `oc` / `cx`. This test's
    // title said "three" before Codex widened `ENGINE_FILTERS`.
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    // Cast because the point is a caller that invented a value; `tsc` stops
    // this at compile time for every caller in the repo, and the guard is for
    // the ones it cannot see.
    store.setEngineFilter('everything' as never);
    expect(store.getView().engineFilter).toBe('all');
    expect(notifications).toBe(0);

    // Vacuity control: a real value DOES notify, so the 0 above is the guard
    // working rather than the subscription never firing.
    store.setEngineFilter('oc');
    expect(notifications).toBe(1);
    // And setting the value it already holds is not a change.
    store.setEngineFilter('oc');
    expect(notifications).toBe(1);

    // The fourth value is a real one too, not merely tolerated by the guard
    // above failing to reject it.
    store.setEngineFilter('cx');
    expect(store.getView().engineFilter).toBe('cx');
    expect(notifications).toBe(2);
  });

  it('sends the host NOTHING for either filter — both are view state (G7)', () => {
    const sent: unknown[] = [];
    const store = createStore((message) => sent.push(message));
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.setEngineFilter('cc');
    store.setLivenessFilter('idle');
    store.setEngineFilter('all');
    expect(sent).toStrictEqual([]);
  });

  it('reopens the inspector on the current selection, without re-picking a node', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.enterSession('session-live');
    store.selectNode('tool-read');
    expect(store.getView().inspectorOpen).toBe(true);
    expect(store.getView().altitude).toBe('inspector');

    store.setInspectorOpen(false);
    const shut = store.getView();
    expect(shut.inspectorOpen).toBe(false);
    expect(shut.altitude).toBe('session');
    // The selection SURVIVES the close. That is the whole reason this is a
    // separate flag rather than a synonym for the altitude: without it there
    // is nothing to reopen onto.
    expect(shut.selectedNodeId).toBe('tool-read');

    store.setInspectorOpen(true);
    expect(store.getView().altitude).toBe('inspector');
    expect(store.getView().selectedNodeId).toBe('tool-read');
  });

  it('pans and zooms as a TRANSFORM, changing no layout coordinate', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession(), liveSession({ sessionId: 'session-idle', liveness: 'idle' })] });

    // The geometry, before anyone touches the view.
    const before = deckLayout(
      store.getView().sessions.map((r) => ({
        id: r.sessionId,
        engine: deckEngine(r.engine),
        status: r.liveness,
        last: 0,
      })),
      DEFAULT_DECK_LAYOUT,
      DEFAULT_DECK_SORT,
      800,
    );

    store.panDeck(37, -18);
    store.zoomDeck(1, 200, 120);

    const view = store.getView();
    expect(view.deckView.x).not.toBe(0);
    expect(view.deckView.k).toBeGreaterThan(1);

    // THE ASSERTION THIS SUITE EXISTS FOR. Pan and zoom are a transform on a
    // stage wrapper; if either ever edits placements instead, layout stops
    // being a pure function of state, every golden goes stale, and "a spawn
    // adds, it never reflows" quietly stops being true. Byte-identical, not
    // approximately equal — a tolerance here would let a slow drift through.
    const after = deckLayout(
      store.getView().sessions.map((r) => ({
        id: r.sessionId,
        engine: deckEngine(r.engine),
        status: r.liveness,
        last: 0,
      })),
      DEFAULT_DECK_LAYOUT,
      DEFAULT_DECK_SORT,
      800,
    );
    expect(after).toStrictEqual(before);
  });

  it('clamps zoom and returns to the identity transform on reset', () => {
    // NOTCHES, signed: positive zooms in and negative zooms out. The argument
    // used to be a multiplicative factor, so a zoom-out was `1 / 1.5` — a
    // POSITIVE number, which under the new signature zooms IN. That is why
    // this test moved with the signature rather than being left to pass by
    // accident on the clamp it was meant to be probing from the other side.
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });

    for (let i = 0; i < 40; i += 1) store.zoomDeck(1, 0, 0);
    expect(store.getView().deckView.k).toBeLessThanOrEqual(DECK_ZOOM_LIMITS.max);
    expect(store.getView().deckView.k).toBe(DECK_ZOOM_LIMITS.max);
    for (let i = 0; i < 80; i += 1) store.zoomDeck(-1, 0, 0);
    expect(store.getView().deckView.k).toBeGreaterThanOrEqual(DECK_ZOOM_LIMITS.min);
    expect(store.getView().deckView.k).toBe(DECK_ZOOM_LIMITS.min);

    store.resetDeckView();
    expect(store.getView().deckView).toEqual({ x: 0, y: 0, k: 1 });
  });

  it('lands exactly where viewport.zoomAbout puts it, and nowhere else', () => {
    // The whole reason the signature changed: `viewport.ts` is the single
    // definition of pan/zoom for all three altitudes, and a store that
    // re-implemented `ZOOM_FACTOR ** notches` beside it would be a second
    // implementation of one rule — the class that already put two viewports
    // with different clamps into this codebase.
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    const before = store.getView().deckView;
    store.zoomDeck(1, 300, 200);
    expect(store.getView().deckView).toStrictEqual(
      zoomAbout(before, 300, 200, 1, DECK_ZOOM_LIMITS),
    );
    const after = store.getView().deckView;
    store.zoomDeck(-1, 300, 200);
    expect(store.getView().deckView).toStrictEqual(
      zoomAbout(after, 300, 200, -1, DECK_ZOOM_LIMITS),
    );
  });

  it('fits content into a viewport exactly where viewport.fitTo puts it', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    const content = { x: 0, y: 0, w: 900, h: 400 };
    const size = { width: 960, height: 600 };
    store.fitDeck(content, size);
    expect(store.getView().deckView).toStrictEqual(
      fitTo(content, size, DECK_FIT_PADDING, DECK_ZOOM_LIMITS),
    );
    // The design's padding, pinned here so a change to the constant shows up
    // as a failing gate rather than as a slightly tighter fit nobody noticed.
    expect(DECK_FIT_PADDING).toBe(24);
  });

  it('survives a snapshot and a diff: a new event never resets the viewport', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.panDeck(45, -20);
    store.zoomDeck(1, 300, 200);
    const moved = store.getView().deckView;
    expect(moved).not.toEqual({ x: 0, y: 0, k: 1 });

    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    expect(store.getView().deckView).toStrictEqual(moved);

    store.handleMessage({
      type: 'diff',
      sessionId: 'session-live',
      patch: { fields: { liveness: 'idle' } },
    });
    expect(store.getView().deckView).toStrictEqual(moved);
  });

  it('keeps the point under the cursor under the cursor while zooming', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });

    // Stage coordinate of a screen point, before and after. If these diverge
    // the deck slides away from whatever you aimed at, which reads as the
    // zoom being broken rather than centred.
    const screenX = 250;
    const stageBefore = (screenX - store.getView().deckView.x) / store.getView().deckView.k;
    store.zoomDeck(1.4, screenX, 0);
    const stageAfter = (screenX - store.getView().deckView.x) / store.getView().deckView.k;
    expect(stageAfter).toBeCloseTo(stageBefore, 10);
  });

  it('ignores non-finite and no-op transforms rather than corrupting the view', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.panDeck(Number.NaN, 5);
    store.panDeck(0, 0);
    store.zoomDeck(Number.POSITIVE_INFINITY, 0, 0);
    // Zero notches is a no-op by arithmetic, not by a guard: `ZOOM_FACTOR ** 0`
    // is 1. It is listed here so the no-op stays a no-op if the guard moves.
    store.zoomDeck(0, 0, 0);
    store.zoomDeck(1, Number.NaN, 0);
    store.fitDeck({ x: 0, y: 0, w: Number.NaN, h: 10 }, { width: 100, height: 100 });
    store.fitDeck({ x: 0, y: 0, w: 10, h: 10 }, { width: Number.NaN, height: 100 });
    expect(store.getView().deckView).toEqual({ x: 0, y: 0, k: 1 });
  });
});
