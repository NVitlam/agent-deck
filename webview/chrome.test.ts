// @vitest-environment jsdom
/**
 * NO CLICKABLE CHROME — v0.9.0 DoD 9.14, spec `Amendment 2026-09-20 — Clean
 * windows: all controls in the view menu`.
 *
 * ## The law, as one walk
 *
 * "Every webview surface is content only: no bar, no buttons, no chips, no
 * segments, no counts, no reset control, no legend … Exactly two clickable
 * exceptions: selecting a content item (a session, a node, a tool call, an
 * expand/collapse of a content entry) and the degraded-status dismiss."
 *
 * So this walks each rendered surface through the SHIPPED BUNDLE and asserts
 * that every clickable element it finds is one of the exceptions, by testid.
 * A component that grew a button back is red here whatever its own test says.
 *
 * ## Why the allow-list is a list of TESTIDS and not of shapes
 *
 * "Is this a control?" cannot be asked of a DOM node — a content row and a
 * filter chip are both `<button>`. What CAN be asked is "is this one of the
 * elements the amendment names", and the only honest form of that is an
 * enumerated list with a reason on every entry. A new clickable element with
 * no line here is a failure, which is the direction that catches the defect:
 * the alternative, a shape rule, would silently admit the next chip.
 *
 * ## And the population is pinned first
 *
 * A walk over an empty surface reports the same clean pass. Every surface
 * below asserts that it rendered SOMETHING clickable, or that it rendered
 * content, before the allow-list assertion runs.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { TESTID } from './canvas-contract.js';
import type { Store } from './store.js';
import type { WebviewHarness } from './testkit.js';
import { all, loadHarness, one, viewControls } from './testkit.js';
import { liveSession } from './testdata.js';
import type { StatsRecord } from '../src/stats/schema.js';
import { STATS_SCHEMA_VERSION } from '../src/stats/schema.js';

let harness: WebviewHarness;
beforeAll(async () => {
  harness = await loadHarness();
}, 120_000);

/* ------------------------------------------------------------------------ *
 * The two exceptions, enumerated
 * ------------------------------------------------------------------------ */

/**
 * Every clickable element a webview surface may still carry, with the clause
 * of the amendment it falls under.
 *
 * Keyed by `data-testid`. An element with no testid is caught by the walk
 * below as `(no testid)` and fails, which is deliberate: an unnamed control
 * is one nobody can exempt on purpose.
 */
const ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  [TESTID.deckBlob]: 'content item: a session card. Selecting it enters the session.',
  'rail-item': 'content item: a session row in the list view. Selecting it selects the session.',
  [TESTID.cell]: 'content item: an agent node. Selecting it selects the node.',
  [TESTID.nucleus]: 'content item: the root agent node.',
  [TESTID.elidedBadge]:
    'content item: the +n badge on a collapsed node — ruling 2 names it an exception.',
  [TESTID.actionRow]: 'content item: one tool call in the drawer. Selecting it opens its detail.',
  toggle: 'expand/collapse of a content entry: the list view’s twisty.',
  'inspector-expand': 'expand/collapse of a content entry: a tool node’s payloads.',
  'preview-marker': 'expand/collapse of a content entry: a truncated payload.',
  'preview-collapse': 'expand/collapse of a content entry: the same payload, shut again.',
  [TESTID.statsChainHead]: 'expand/collapse of a content entry: a loop chain’s ordinals.',
  [TESTID.statsChainOrdinal]: 'content item: a call ordinal. Selecting it opens that call.',
  'degraded-dismiss': 'the degraded-status dismiss — the amendment names it in full.',
});

/** Everything a browser treats as clickable, by selector. */
const CLICKABLE = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="tab"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[onclick]',
].join(',');

/** Every clickable element under `root`, as `testid` (or `(no testid): tag`). */
function clickables(root: ParentNode): string[] {
  return [...root.querySelectorAll(CLICKABLE)].map((element) => {
    const id = element.getAttribute('data-testid');
    return id ?? `(no testid): ${element.tagName.toLowerCase()}`;
  });
}

/** The ones the amendment does NOT allow. */
function chrome(root: ParentNode): string[] {
  return [...new Set(clickables(root).filter((id) => ALLOWED[id] === undefined))].sort();
}

/* ------------------------------------------------------------------------ *
 * Mounting
 * ------------------------------------------------------------------------ */

interface Panel {
  container: HTMLElement;
  store: Store;
  dispose: () => void;
}

const mounted: Panel[] = [];

function render(): Panel {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const started = harness.start(container, { postMessage: () => {} });
  const panel: Panel = {
    container,
    store: started.store,
    dispose: () => {
      started.dispose();
      container.remove();
    },
  };
  mounted.push(panel);
  return panel;
}

function send(message: unknown): void {
  harness.flushSync(() => {
    globalThis.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

function record(sessionId: string): StatsRecord {
  return {
    statsSchemaVersion: STATS_SCHEMA_VERSION,
    sessionId,
    engine: 'cc',
    projectSlug: 'c--ws-example',
    startedAt: 1_000,
    coverage: 'full',
    agents: [],
    files: [
      {
        filePath: 'repo/src/a.ts',
        reads: 2,
        writes: 1,
        edits: 0,
        errors: 0,
        firstTouchSeq: 1,
        lastTouchSeq: 3,
      },
    ],
    tools: [{ toolName: 'Read', class: 'read', calls: 9, errors: 1 }],
    loops: [{ agentId: 'root', toolName: 'Read', class: 'read', count: 3, ordinals: [0, 1, 2] }],
    churn: [],
    contextChurn: [],
    compactions: [],
    stalls: [],
    skills: [],
    timing: {},
    totals: { prompt: 10, output: 5, compactions: 0, subagents: 0, silentSubagents: 0, stalls: 0 },
    params: { loopMin: 3 },
    unavailable: [],
  };
}

/* ------------------------------------------------------------------------ *
 * The walk
 * ------------------------------------------------------------------------ */

describe('the allow-list itself', () => {
  it('every entry carries a reason naming its clause', () => {
    // An exemption with no reason is an exemption nobody justified — the
    // shape `manifest.test.ts` already uses for its own enumerated list.
    expect(Object.keys(ALLOWED).length).toBeGreaterThan(0);
    for (const [id, why] of Object.entries(ALLOWED)) {
      expect(why.length, id).toBeGreaterThan(20);
      expect(
        why.startsWith('content item') ||
          why.startsWith('expand/collapse') ||
          why.startsWith('the degraded-status dismiss'),
        `${id}: ${why}`,
      ).toBe(true);
    }
  });

  it('the dismiss is the ONLY entry that is not a content interaction', () => {
    const notContent = Object.entries(ALLOWED).filter(
      ([, why]) => !why.startsWith('content item') && !why.startsWith('expand/collapse'),
    );
    expect(notContent.map(([id]) => id)).toStrictEqual(['degraded-dismiss']);
  });
});

describe('every surface is content only', () => {
  it('the DECK carries nothing but its cards', () => {
    const panel = render();
    send({
      type: 'snapshot',
      sessions: [
        liveSession(),
        liveSession({ sessionId: 'session-idle', liveness: 'idle' }),
        liveSession({ sessionId: 'session-oc', engine: 'opencode' }),
      ],
    });
    // The population, first: a walk over an empty deck passes vacuously.
    expect(all(panel.container, TESTID.deckBlob).length).toBeGreaterThan(0);
    expect(chrome(panel.container)).toStrictEqual([]);
  });

  it('the LIST view carries nothing but its rows and twisties', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    send(viewControls({ viewMode: 'list' }));
    harness.flushSync(() => {
      panel.store.selectSession('session-live');
    });
    expect(all(panel.container, 'rail-item').length).toBeGreaterThan(0);
    expect(chrome(panel.container)).toStrictEqual([]);
  });

  it('the SESSION TREE carries nothing but its nodes', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    harness.flushSync(() => {
      panel.store.enterSession('session-live');
    });
    expect(all(panel.container, TESTID.cell).length + all(panel.container, TESTID.nucleus).length)
      .toBeGreaterThan(0);
    expect(chrome(panel.container)).toStrictEqual([]);
  });

  it('the DRAWER carries nothing but its call rows, at both heights', () => {
    for (const expand of [false, true]) {
      const panel = render();
      send({ type: 'snapshot', sessions: [liveSession()] });
      harness.flushSync(() => {
        panel.store.enterSession('session-live');
        panel.store.selectNode('root');
        if (expand) panel.store.toggleDrawerExpanded();
      });
      expect(all(panel.container, TESTID.actionRow).length, String(expand)).toBeGreaterThan(0);
      expect(chrome(panel.container), String(expand)).toStrictEqual([]);
      panel.dispose();
      mounted.pop();
    }
  });

  it('an OPEN DETAIL pane carries nothing but its payload markers', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    harness.flushSync(() => {
      panel.store.enterSession('session-live');
      panel.store.selectNode('root');
    });
    const row = all(panel.container, TESTID.actionRow)[0];
    const id = row?.dataset['actionId'];
    expect(id, 'no call row to open').toBeDefined();
    harness.flushSync(() => {
      panel.store.setDetailAction(id);
    });
    expect(all(panel.container, TESTID.drawerDetail).length).toBe(1);
    expect(chrome(panel.container)).toStrictEqual([]);
  });

  it('a TOOL node’s solo pane keeps only its expand/collapse of the payload', () => {
    const panel = render();
    const session = liveSession({
      sessionId: 'session-live',
    });
    send({ type: 'snapshot', sessions: [session] });
    harness.flushSync(() => {
      panel.store.enterSession('session-live');
      panel.store.selectNode('tool-read');
    });
    expect(all(panel.container, TESTID.drawerDetail).length).toBe(1);
    expect(chrome(panel.container)).toStrictEqual([]);
  });

  it('every STATS table carries nothing but its content rows', () => {
    for (const statsTab of ['files', 'tools', 'loops', 'tokens', 'trends'] as const) {
      const panel = render();
      const records = [record('s1'), record('s2')];
      send({ type: 'snapshot', sessions: [liveSession()] });
      send({ type: 'statsSnapshot', records });
      send({ type: 'statsStore', records, enabled: true });
      send(viewControls({ viewMode: 'stats', statsTab }));
      // The surface rendered at all.
      expect(all(panel.container, TESTID.statsView).length, statsTab).toBe(1);
      expect(chrome(panel.container), statsTab).toStrictEqual([]);
      panel.dispose();
      mounted.pop();
    }
  });

  it('the DEGRADED banner keeps its dismiss, and only that', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    send({ type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' });
    // The population: the banner is really there, or the empty list below
    // would be a statement about a surface that never rendered.
    expect(all(panel.container, 'degraded-banner').length).toBe(1);
    expect(clickables(panel.container)).toContain('degraded-dismiss');
    expect(chrome(panel.container)).toStrictEqual([]);
  });

  it('the REFUSAL screen carries nothing clickable at all', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    harness.flushSync(() => {
      panel.store.enterSession('session-live');
    });
    send({ type: 'schemaMismatch', sessionId: 'session-live' });
    expect(all(panel.container, 'refusal-screen').length).toBe(1);
    expect(chrome(panel.container)).toStrictEqual([]);
  });

  it('the EMPTY deck carries nothing clickable at all', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [] });
    expect(all(panel.container, TESTID.deckEmpty).length).toBe(1);
    expect(clickables(panel.container)).toStrictEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * The walk can fail
 * ------------------------------------------------------------------------ */

describe('the walk is not vacuous', () => {
  it('a planted control is found', () => {
    // The control this test class exists for: a chip on the deck. Planted
    // into the rendered surface, so the walk is proved against the same DOM
    // it clears — a scan that could never fail is the defect this repository
    // records most.
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    expect(chrome(panel.container)).toStrictEqual([]);

    const planted = document.createElement('button');
    planted.setAttribute('data-testid', 'filter-chip');
    one(panel.container, TESTID.deck).appendChild(planted);
    expect(chrome(panel.container)).toStrictEqual(['filter-chip']);
  });

  it('an UNNAMED control is found too, and named as such', () => {
    // A control with no testid cannot be exempted by accident: it is
    // reported by its tag, and there is no key for it in the allow-list.
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    const planted = document.createElement('select');
    one(panel.container, TESTID.deck).appendChild(planted);
    expect(chrome(panel.container)).toStrictEqual(['(no testid): select']);
  });

  it('every surface above rendered something: the mounts are real', () => {
    // One assertion that the harness works at all, so a suite-wide failure
    // to mount cannot read as eleven clean passes.
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    expect(clickables(panel.container).length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ *
 * The bundle
 * ------------------------------------------------------------------------ */

describe('the shipped bundle carries no control the DOM walk might miss', () => {
  it('names none of the removed testids', async () => {
    /*
     * A DOM walk only sees what a state renders. This reads the BUNDLE for
     * the ids of the controls the amendment removed, so a chip behind an
     * `{#if}` nothing in this file reaches is still caught.
     */
    const { bundleHarness } = await import('./testkit.js');
    const source = await bundleHarness();
    for (const gone of [
      'deck-bar',
      'deck-engine-chip',
      'deck-layout-option',
      'deck-sort-option',
      'deck-reset',
      'deck-count',
      'filter-chip',
      'count-chip',
      'legend',
      'dock',
      'crumb-deck',
      'tree-crumbs',
      'tree-crumb',
      'tree-status',
      'canvas-reset',
      'inspector-toggle',
      'view-toggle',
      'stats-toggle',
      'insights-toggle',
      'about-link',
      'insights-view',
      'insights-action',
      'stats-tab',
      'stats-engine-chip',
      'stats-model-copy',
      'drawer-filters',
      'drawer-filter-chip',
      'drawer-order-select',
      'drawer-tool-select',
      'drawer-expand',
      'inspector-close',
      'drawer-detail-close',
      'sidebar-tab',
      'sidebar-entry',
      'tweak-control',
    ]) {
      expect(source, `the bundle still carries ${gone}`).not.toContain(`"${gone}"`);
    }
    // VACUITY: the bundle is a real bundle and does carry the ids that stay.
    expect(source).toContain('"deck-blob"');
    expect(source).toContain('"degraded-dismiss"');
  }, 120_000);
});
