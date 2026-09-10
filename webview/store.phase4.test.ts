// The store's v0.7.0 Phase 4 additions: the auto-fit trigger table (DoD 4.0),
// the stats messages (DoD 4.1), the third view mode, and the link-back (4.4).
//
// NODE ENVIRONMENT, like `store.test.ts`: the reducer has no DOM, and the fit
// function is INJECTED as a spy so every row of `FIT_TRIGGERS` can be driven
// both ways — a listed trigger must call it, a listed non-trigger must not.

import { describe, expect, it } from 'vitest';

import type { HostToWebviewMessage, ToolNode, WebviewToHostMessage } from '../src/model/events.js';
import type { StatsRecord } from '../src/stats/schema.js';
import { FIT_TRIGGERS, createStore } from './store.js';
import type { CanvasGeometry, Store } from './store.js';
import { VIEW_MODES } from './canvas-contract.js';
import { fit } from './layout/fit.js';
import { liveSession, tool } from './testdata.js';

/** A minimal, valid-shaped record. The store does not validate; the host did. */
function record(overrides: Partial<StatsRecord> = {}): StatsRecord {
  return {
    statsSchemaVersion: 1,
    sessionId: 'session-live',
    engine: 'cc',
    projectSlug: 'c--Users-dev-projects-agent-deck',
    startedAt: 1_000,
    coverage: 'full',
    agents: [],
    files: [],
    tools: [],
    loops: [],
    churn: [],
    contextChurn: [],
    compactions: [],
    stalls: [],
    totals: { prompt: 1, output: 1, compactions: 0, subagents: 0, silentSubagents: 0, stalls: 0 },
    params: { loopMin: 3 },
    unavailable: [],
    ...overrides,
  };
}

const GEOMETRY: CanvasGeometry = {
  bounds: { x: 0, y: 0, w: 800, h: 400 },
  viewport: { width: 960, height: 640 },
  drawer: null,
};

interface Rig {
  store: Store;
  fits: number;
  sent: WebviewToHostMessage[];
}

/** A store with a fit SPY, a session on screen, and geometry reported once. */
function rig(options: { autoFit?: boolean; enter?: boolean } = {}): Rig {
  const sent: WebviewToHostMessage[] = [];
  const out: Rig = { store: createStore((m) => sent.push(m), { fit: spyFit }), fits: 0, sent };
  function spyFit(...args: Parameters<typeof fit>): ReturnType<typeof fit> {
    out.fits += 1;
    return fit(...args);
  }
  const { store } = out;
  store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
  if (options.autoFit === false) store.handleMessage({ type: 'settings', canvasAutoFit: false });
  if (options.enter !== false) store.enterSession('session-live');
  store.reportCanvasGeometry(GEOMETRY);
  // Everything above may have fitted; the assertions start from zero.
  out.fits = 0;
  return out;
}

/**
 * How to fire each row of the trigger table. KEYED ON THE ROW'S `event`, so a
 * row this map does not know fails the table test rather than passing by
 * omission — and a driver for an event the table does not list fails too.
 */
const DRIVERS: Record<string, (r: Rig) => void> = {
  selectNode: (r) => r.store.selectNode('tool-read'),
  setInspectorOpen: (r) => {
    r.store.selectNode('tool-read');
    r.fits = 0;
    r.store.setInspectorOpen(false);
  },
  toggleDrawerExpanded: (r) => {
    r.store.selectNode('tool-read');
    r.fits = 0;
    r.store.toggleDrawerExpanded();
  },
  'escape:inspector': (r) => {
    r.store.selectNode('tool-read');
    r.fits = 0;
    r.store.escape();
  },
  'diff:insertNode': (r) =>
    r.store.handleMessage({
      type: 'diff',
      sessionId: 'session-live',
      patch: {
        tree: [
          {
            op: 'insertNode',
            parentId: 'root',
            afterId: null,
            node: tool({ id: 'tool-new', toolName: 'Grep', status: 'done' }),
          },
        ],
      },
    }),
  'diff:removeNode': (r) =>
    r.store.handleMessage({
      type: 'diff',
      sessionId: 'session-live',
      patch: { tree: [{ op: 'removeNode', id: 'tool-read' }] },
    }),
  'diff:replaceNode': (r) =>
    r.store.handleMessage({
      type: 'diff',
      sessionId: 'session-live',
      patch: {
        tree: [{ op: 'replaceNode', id: 'tool-read', node: tool({ id: 'tool-read', status: 'done' }) }],
      },
    }),
  'diff:replaceRoot': (r) =>
    r.store.handleMessage({
      type: 'diff',
      sessionId: 'session-live',
      patch: { tree: [{ op: 'replaceRoot', node: liveSession().root }] },
    }),
  'diff:reorderChildren': (r) =>
    r.store.handleMessage({
      type: 'diff',
      sessionId: 'session-live',
      patch: {
        tree: [{ op: 'reorderChildren', parentId: 'root', order: ['tool-agent-1', 'tool-read', 'agent-1'] }],
      },
    }),
  'diff:parked': (r) =>
    r.store.handleMessage({
      type: 'diff',
      sessionId: 'session-live',
      patch: { parked: [{ agentId: 'agent-x', code: 'noMatchingToolUse', reason: 'r' }] },
    }),
  'diff:spawnEdges': (r) =>
    r.store.handleMessage({
      type: 'diff',
      sessionId: 'session-live',
      patch: { spawnEdges: [] },
    }),
  snapshot: (r) => r.store.handleMessage({ type: 'snapshot', sessions: [liveSession()] }),
  enterSession: (r) => r.store.enterSession('session-live'),
  selectSession: (r) => r.store.selectSession('session-live'),
  setEngineFilter: (r) => r.store.setEngineFilter('cc'),
  'setViewMode:canvas': (r) => {
    r.store.setViewMode('list');
    r.fits = 0;
    r.store.setViewMode('canvas');
  },
  'reportCanvasGeometry:changed': (r) =>
    r.store.reportCanvasGeometry({ ...GEOMETRY, viewport: { width: 1200, height: 640 } }),
  'diff:updateAgent': (r) =>
    r.store.handleMessage({
      type: 'diff',
      sessionId: 'session-live',
      patch: { tree: [{ op: 'updateAgent', id: 'root', fields: { burn: { prompt: 99, output: 9 } } }] },
    }),
  'diff:updateTool': (r) =>
    r.store.handleMessage({
      type: 'diff',
      sessionId: 'session-live',
      patch: { tree: [{ op: 'updateTool', id: 'tool-read', fields: { status: 'error' } }] },
    }),
  'diff:fields': (r) =>
    r.store.handleMessage({
      type: 'diff',
      sessionId: 'session-live',
      patch: { fields: { liveness: 'idle' } },
    }),
  degraded: (r) =>
    r.store.handleMessage({ type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' }),
  schemaMismatch: (r) => r.store.handleMessage({ type: 'schemaMismatch', sessionId: 'session-other' }),
  statsSnapshot: (r) => r.store.handleMessage({ type: 'statsSnapshot', records: [record()] }),
  statsStore: (r) => r.store.handleMessage({ type: 'statsStore', records: [record()], enabled: true }),
  setLivenessFilter: (r) => r.store.setLivenessFilter('live'),
  'setViewMode:list': (r) => r.store.setViewMode('list'),
  'setViewMode:stats': (r) => r.store.setViewMode('stats'),
  setDetailAction: (r) => {
    r.store.selectNode('root');
    r.fits = 0;
    r.store.setDetailAction('tool-read');
  },
  toggleNode: (r) => r.store.toggleNode('tool-read'),
  dismissDegraded: (r) => r.store.dismissDegraded(),
  panCanvas: (r) => r.store.panCanvas(10, 10),
  zoomCanvas: (r) => r.store.zoomCanvas(1.1, 0, 0),
  'reportCanvasGeometry:unchanged': (r) => r.store.reportCanvasGeometry({ ...GEOMETRY }),
};

describe('DoD 4.0 — the trigger table, driven both ways', () => {
  it('names every driver and every driver names a row (no silent omission either way)', () => {
    const rows = FIT_TRIGGERS.map((t) => t.event).sort();
    expect(Object.keys(DRIVERS).sort()).toStrictEqual(rows);
    // Not vacuous: both halves of the table are populated.
    expect(FIT_TRIGGERS.filter((t) => t.fits).length).toBeGreaterThanOrEqual(10);
    expect(FIT_TRIGGERS.filter((t) => !t.fits).length).toBeGreaterThanOrEqual(10);
  });

  it.each(FIT_TRIGGERS.map((t) => [t.event, t.fits] as const))(
    '%s -> fits: %s',
    (event, fits) => {
      const r = rig();
      const drive = DRIVERS[event];
      expect(drive, `no driver for ${event}`).toBeDefined();
      drive?.(r);
      if (fits) expect(r.fits, `${event} did not call fit`).toBeGreaterThan(0);
      else expect(r.fits, `${event} called fit`).toBe(0);
    },
  );

  it('a fit writes canvasView and bumps the epoch; a non-trigger leaves both alone', () => {
    const r = rig();
    const before = r.store.getView();
    r.store.panCanvas(15, 0);
    const panned = r.store.getView();
    expect(panned.canvasFitEpoch).toBe(before.canvasFitEpoch);
    expect(panned.canvasView.x).toBe(before.canvasView.x + 15);

    r.store.selectNode('tool-read');
    const fitted = r.store.getView();
    expect(fitted.canvasFitEpoch).toBe(before.canvasFitEpoch + 1);
    expect(fitted.canvasView).toStrictEqual(fit(GEOMETRY.bounds, GEOMETRY.viewport, GEOMETRY.drawer));
  });

  it('a trigger fitted against stale geometry fits again when the renderer reports the fresh numbers', () => {
    // The structural diff lands in the store BEFORE the renderer has laid the
    // new node out, so the immediate fit used the old bounds. The next report
    // — even of unchanged numbers — completes it.
    const r = rig();
    DRIVERS['diff:insertNode']?.(r);
    expect(r.fits).toBe(1);
    r.store.reportCanvasGeometry({ ...GEOMETRY });
    expect(r.fits).toBe(2);
    // ...and only once: a second identical report is the unchanged case.
    r.store.reportCanvasGeometry({ ...GEOMETRY });
    expect(r.fits).toBe(2);
  });

  it('a diff on a session that is NOT selected moves nothing on screen', () => {
    const r = rig();
    r.store.handleMessage({ type: 'snapshot', sessions: [liveSession(), liveSession({ sessionId: 'other' })] });
    r.store.enterSession('session-live');
    r.store.reportCanvasGeometry(GEOMETRY);
    r.fits = 0;
    r.store.handleMessage({
      type: 'diff',
      sessionId: 'other',
      patch: { tree: [{ op: 'removeNode', id: 'tool-read' }] },
    });
    expect(r.fits).toBe(0);
  });

  it('the drawer rectangle is part of the geometry: a changed drawer is a changed geometry', () => {
    const r = rig();
    r.store.reportCanvasGeometry({ ...GEOMETRY, drawer: { x: 0, y: 450, w: 960, h: 190 } });
    expect(r.fits).toBe(1);
    expect(r.store.getView().canvasView).toStrictEqual(
      fit(GEOMETRY.bounds, GEOMETRY.viewport, { x: 0, y: 450, w: 960, h: 190 }),
    );
  });
});

describe('DoD 4.0 — agentDeck.canvas.autoFit off: fit is never called after the initial render', () => {
  it('defaults to on, and a settings message turns it off', () => {
    const store = createStore();
    expect(store.getView().canvasAutoFit).toBe(true);
    store.handleMessage({ type: 'settings', canvasAutoFit: false });
    expect(store.getView().canvasAutoFit).toBe(false);
    store.handleMessage({ type: 'settings', canvasAutoFit: true });
    expect(store.getView().canvasAutoFit).toBe(true);
  });

  it.each(FIT_TRIGGERS.filter((t) => t.fits).map((t) => t.event))(
    'with the setting off, %s does not call fit',
    (event) => {
      const r = rig({ autoFit: false });
      DRIVERS[event]?.(r);
      expect(r.fits).toBe(0);
      expect(r.store.getView().canvasFitEpoch).toBe(0);
    },
  );

  it('a user pan survives every trigger while the setting is off', () => {
    const r = rig({ autoFit: false });
    r.store.panCanvas(40, -20);
    const moved = r.store.getView().canvasView;
    for (const row of FIT_TRIGGERS) {
      if (!row.fits) continue;
      if (row.event === 'enterSession' || row.event === 'selectSession') continue; // resets by design
      DRIVERS[row.event]?.(r);
    }
    expect(r.store.getView().canvasView).toStrictEqual(moved);
  });

  it('turning the setting on later does not fit by itself; the next trigger does', () => {
    const r = rig({ autoFit: false });
    r.store.handleMessage({ type: 'settings', canvasAutoFit: true });
    expect(r.fits).toBe(0);
    r.store.selectNode('tool-read');
    expect(r.fits).toBe(1);
  });
});

describe('DoD 4.1 — the stats messages land in the view, replaced whole', () => {
  it('statsSnapshot replaces the live records; statsStore replaces the history and its enabled flag', () => {
    const store = createStore();
    const view0 = store.getView();
    expect(view0.statsLive).toStrictEqual([]);
    expect(view0.statsStored).toStrictEqual([]);
    expect(view0.statsStoreEnabled).toBe(true);

    store.handleMessage({ type: 'statsSnapshot', records: [record(), record({ sessionId: 'b' })] });
    expect(store.getView().statsLive.map((r) => r.sessionId)).toStrictEqual(['session-live', 'b']);
    store.handleMessage({ type: 'statsSnapshot', records: [record({ sessionId: 'c' })] });
    // Replaced, not merged: `session-live` and `b` are gone.
    expect(store.getView().statsLive.map((r) => r.sessionId)).toStrictEqual(['c']);

    store.handleMessage({ type: 'statsStore', records: [record({ sessionId: 'old' })], enabled: false });
    expect(store.getView().statsStored.map((r) => r.sessionId)).toStrictEqual(['old']);
    expect(store.getView().statsStoreEnabled).toBe(false);
  });

  it('a stats message notifies subscribers and touches no session', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    const before = store.getView();
    store.handleMessage({ type: 'statsSnapshot', records: [record()] });
    expect(notified).toBe(1);
    const after = store.getView();
    expect(after.sessions).toStrictEqual(before.sessions);
    expect(after.selected).toBe(before.selected);
  });
});

describe('the third view mode (spec §G)', () => {
  it('VIEW_MODES lists the three, and stats is entered and left by its own control', () => {
    expect(VIEW_MODES).toStrictEqual(['canvas', 'list', 'stats']);
    const store = createStore();
    store.toggleStats();
    expect(store.getView().viewMode).toBe('stats');
    store.toggleStats();
    expect(store.getView().viewMode).toBe('canvas');
    // From the list, Stats goes to stats; leaving stats goes to the canvas.
    store.setViewMode('list');
    store.toggleStats();
    expect(store.getView().viewMode).toBe('stats');
    store.toggleStats();
    expect(store.getView().viewMode).toBe('canvas');
  });

  it('toggleViewMode still swaps canvas and list, and from stats it goes to the canvas', () => {
    const store = createStore();
    store.toggleViewMode();
    expect(store.getView().viewMode).toBe('list');
    store.toggleViewMode();
    expect(store.getView().viewMode).toBe('canvas');
    store.setViewMode('stats');
    store.toggleViewMode();
    expect(store.getView().viewMode).toBe('canvas');
  });

  it('showView from the host sets the mode, once, and posts nothing', () => {
    const sent: WebviewToHostMessage[] = [];
    const store = createStore((m) => sent.push(m));
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.handleMessage({ type: 'showView', mode: 'stats' });
    expect(store.getView().viewMode).toBe('stats');
    expect(notified).toBe(1);
    expect(sent).toStrictEqual([]);
    // An unknown mode is refused rather than stored.
    store.handleMessage({ type: 'showView', mode: 'nope' as unknown as 'stats' });
    expect(store.getView().viewMode).toBe('stats');
  });

  it('the view mode is not remembered: a fresh store starts on the canvas (G7)', () => {
    const a = createStore();
    a.setViewMode('stats');
    expect(createStore().getView().viewMode).toBe('canvas');
  });
});

describe('DoD 4.4 — link-back through the existing select intent', () => {
  function withOrdinals(): ReturnType<typeof liveSession> {
    const state = liveSession();
    const root = state.root;
    const calls = root.children.filter((c): c is ToolNode => !('children' in c));
    calls.forEach((call, i) => {
      (call as ToolNode).ordinal = i;
    });
    return state;
  }

  it('resolves (session, agent, ordinal) to the tool node and selects it the way a click would', () => {
    const sent: WebviewToHostMessage[] = [];
    const store = createStore((m) => sent.push(m));
    store.handleMessage({ type: 'snapshot', sessions: [withOrdinals()] });
    store.setViewMode('stats');
    sent.length = 0;

    expect(store.selectToolByOrdinal('session-live', 'root', 1)).toBe(true);
    const view = store.getView();
    expect(view.selectedSessionId).toBe('session-live');
    expect(view.selectedNodeId).toBe('tool-agent-1');
    expect(view.selectedNode?.id).toBe('tool-agent-1');
    expect(view.altitude).toBe('inspector');
    expect(view.inspectorOpen).toBe(true);
    // The canvas, because that is where the node is.
    expect(view.viewMode).toBe('canvas');
    // The EXISTING intent — the same message a deck click sends — and no other.
    expect(sent).toStrictEqual([{ type: 'selectSession', sessionId: 'session-live' }]);
  });

  it('refuses a session that is gone, an agent that is not one, and an ordinal nothing carries', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [withOrdinals()] });
    expect(store.selectToolByOrdinal('gone', 'root', 0)).toBe(false);
    expect(store.selectToolByOrdinal('session-live', 'tool-read', 0)).toBe(false);
    expect(store.selectToolByOrdinal('session-live', 'root', 99)).toBe(false);
    expect(store.getView().selectedNodeId).toBeUndefined();
  });

  it('refuses a refused session (G3): no interior, nothing to select', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [withOrdinals()] });
    store.handleMessage({ type: 'schemaMismatch', sessionId: 'session-live' });
    expect(store.selectToolByOrdinal('session-live', 'root', 0)).toBe(false);
  });
});

describe('the message guard in main.ts and the contract agree', () => {
  it('every HostToWebviewMessage type the store handles is one the guard admits', async () => {
    const { HOST_MESSAGE_TYPES, isHostMessage } = await import('./messages.js');
    const samples: HostToWebviewMessage[] = [
      { type: 'snapshot', sessions: [] },
      { type: 'diff', sessionId: 's', patch: {} },
      { type: 'schemaMismatch', sessionId: 's' },
      { type: 'degraded', engine: 'cc', degraded: false },
      { type: 'statsSnapshot', records: [] },
      { type: 'statsStore', records: [], enabled: true },
      { type: 'settings', canvasAutoFit: true },
      { type: 'showView', mode: 'stats' },
    ];
    expect([...HOST_MESSAGE_TYPES].sort()).toStrictEqual(samples.map((m) => m.type).sort());
    for (const sample of samples) expect(isHostMessage(sample), sample.type).toBe(true);
    expect(isHostMessage({ type: 'runCommand', command: 'x' })).toBe(false);
  });
});
