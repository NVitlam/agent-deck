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
 * **A THIRD EXCEPTION, RULED IN BY `Amendment 2026-09-20 — Sidebar shape`:**
 * the Statistics window keeps its five tabs inside the window. It is written
 * into {@link ALLOWED} as one entry with its own clause rather than left to
 * be inferred, and {@link EXCEPTIONS} below pins the whole set of
 * not-a-content-interaction exemptions at exactly two — the dismiss and the
 * tabs — so a fourth cannot arrive without this file saying so.
 *
 * **THE SIDEBAR IS NOT WALKED, and that is the same amendment's doing.** It
 * is the one webview that carries controls; walking it would assert the
 * opposite of what it is for. `webview/sidebar/sidebar.test.ts` is where it
 * is held to its own shape, and the surfaces below are the four the
 * content-only law is about: deck, session interior, drawer, Statistics.
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
  'stats-tab':
    'the Statistics window’s own tab strip — `Amendment 2026-09-20 — Sidebar shape` rules it ' +
    'back into the window as a third exception. It runs a host COMMAND, so the value still has ' +
    'one owner and Menu ▸ Open Statistics still lands on Files.',
  /*
   * v0.9.0 DoD 9.29–9.32. `Amendment 2026-09-21 — One window` makes About and
   * Insights SURFACES of this panel and names what each carries: the About
   * page's tiles (round 3, now in-window), a lit Get tile, and the Insights
   * surface's Get tile and Run action. Each is an INTENT the host checks
   * again — a tile asks before it opens anything, and Run calls the
   * registered provider and nothing else.
   */
  [TESTID.aboutLink]:
    'the About surface’s link tiles — `Amendment 2026-09-21 — One window` brings the round-3 ' +
    'page into this panel. Each asks before it opens anything.',
  [TESTID.aboutGetTile]:
    'the About surface’s lit Get tile — `Amendment 2026-09-21 — One window`, shown only while ' +
    'no Insights provider is registered. It asks before it opens anything.',
  [TESTID.insightsGetTile]:
    'the Insights surface’s Get tile — `Amendment 2026-09-21 — One window`, in the free state ' +
    'only. It asks before it opens anything.',
  [TESTID.insightsRun]:
    'the Insights surface’s Run action — `Amendment 2026-09-21 — One window`, in the provider ' +
    'state only. It calls the registered provider and nothing else.',
  /*
   * v0.9.0 DoD 9.41. `Amendment 2026-09-22 — Provider contract v1 widened`
   * names both: a finding's detail "behind expand", and "show raw output" on
   * a refused set. The first reveals content already on the page and posts
   * nothing; the second is an intent the host checks again.
   */
  [TESTID.insightsDetail]:
    'expand/collapse of a content entry: a finding’s detail, which `Amendment 2026-09-22 — ' +
    'Provider contract v1 widened` puts behind an expand. A native <details>; it posts nothing.',
  [TESTID.insightsRawOutput]:
    'the Insights surface’s "Show raw output" on a refused set — `Amendment 2026-09-22 — Provider ' +
    'contract v1 widened`. It asks the host, which resolves the run and asks the provider.',
});

/**
 * Every exemption that is NOT a content interaction, pinned as a set.
 *
 * Seven, and the amendments name every one: the dismiss, the Stats tabs,
 * the four the one-window amendment gives the About and Insights surfaces,
 * and a refused set's "Show raw output" (the 2026-09-22 widening). A
 * finding's detail toggle is expand/collapse of content, not listed here.
 * This is what stops the allow-list growing an entry quietly: adding one
 * means editing this array, which is a line a reviewer reads.
 */
const EXCEPTIONS = [
  'degraded-dismiss',
  'stats-tab',
  TESTID.aboutLink,
  TESTID.aboutGetTile,
  TESTID.insightsGetTile,
  TESTID.insightsRun,
  TESTID.insightsRawOutput,
];

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

/**
 * The ones the amendment does NOT allow.
 *
 * `Object.hasOwn`, never a truthiness read of `ALLOWED[id]`: a frozen object
 * literal still inherits `toString`, `constructor`, `valueOf` and
 * `hasOwnProperty`, so an element with one of those as its testid would have
 * been SILENTLY EXEMPTED — contradicting this file's own promise that an
 * unnamed control is one nobody can exempt on purpose. A verifier round found
 * it; no such testid exists, which is exactly why it would have stayed found
 * only by reading.
 */
function chrome(root: ParentNode): string[] {
  return [...new Set(clickables(root).filter((id) => !Object.hasOwn(ALLOWED, id)))].sort();
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
          why.startsWith('the degraded-status dismiss') ||
          why.startsWith('the Statistics window’s own tab strip') ||
          why.startsWith('the About surface’s') ||
          why.startsWith('the Insights surface’s'),
        `${id}: ${why}`,
      ).toBe(true);
    }
  });

  it('the dismiss, the Stats tabs and the five surface intents are the ONLY non-content entries', () => {
    const notContent = Object.entries(ALLOWED).filter(
      ([, why]) => !why.startsWith('content item') && !why.startsWith('expand/collapse'),
    );
    expect(notContent.map(([id]) => id).sort()).toStrictEqual([...EXCEPTIONS].sort());
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
    send(viewControls({ renderer: 'list' }));
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
      send(viewControls({ surface: 'stats', statsTab }));
      // The surface rendered at all.
      expect(all(panel.container, TESTID.statsView).length, statsTab).toBe(1);
      // The five tabs are really there — the exemption above is about a
      // strip that exists, not a name nobody emits.
      expect(all(panel.container, 'stats-tab').length, statsTab).toBe(5);
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

  /** A registered provider's checked snapshot, as the host sends it. */
  const PROVIDER_STATE = {
    type: 'providerState',
    page: { text: 'Agent Deck draws the sessions.', links: [{ label: 'Portfolio', host: 'nvitlam.github.io' }, { label: 'Repository', host: 'github.com' }, { label: 'LinkedIn', host: 'www.linkedin.com' }, { label: 'Sponsor', host: 'github.com' }], get: { label: 'Get Agent Deck Insights', host: 'nvitlam.github.io' }, footer: 'Agent Deck 0.9.0 · MIT licence' },
    provider: {
      about: { name: 'Agent Deck Insights', version: '0.2.0' },
      latest: {
        runId: 'run-1',
        createdAt: 1_790_000_000_000,
        agent: { kind: 'claude', version: '2.1.246' },
        window: { sessions: 3, excluded: 0, sinceMs: 1_789_400_000_000 },
        usage: null,
        resolvedKinds: [],
        findings: [
          {
            id: 'f-1',
            kind: 'stall',
            confidence: 'medium',
            action: { lead: 'Lead of f-1', detail: 'Detail of f-1.' },
            cause: 'Cause of f-1.',
            evidence: [{ label: 'Stalls', sessionId: 'ses_example01', statsKey: 'sessions[0].totals.stalls', value: 2 }],
            sinceLastRun: null,
          },
        ],
        rejected: 0,
        state: 'ok',
      },
      runs: [{ runId: 'run-1', createdAt: 1_790_000_000_000, state: 'ok', findings: 1, agentKind: 'claude' }],
      running: false,
      dropped: 0,
      rawOutput: false,
    },
  };

  /** The same provider, its latest set REFUSED and its raw output offered (DoD 9.41). */
  const REFUSED_STATE = {
    ...PROVIDER_STATE,
    provider: {
      ...PROVIDER_STATE.provider,
      latest: {
        ...PROVIDER_STATE.provider.latest,
        findings: [],
        state: 'refused',
        refusal: { step: 'validate', reason: 'No JSON object.' },
      },
      runs: [{ runId: 'run-1', createdAt: 1_790_000_000_000, state: 'refused', findings: 0, agentKind: 'claude' }],
      rawOutput: true,
    },
  };

  it('the INSIGHTS surface carries its Get tile (free) or Run (provider), and nothing else', () => {
    // FREE: facts are content, not controls; the Get tile is the one intent.
    const free = render();
    const records = [record('s1'), record('s2')];
    send({ type: 'statsStore', records, enabled: true });
    send(viewControls({ surface: 'insights' }));
    expect(all(free.container, TESTID.insightsSurface).length).toBe(1);
    expect(all(free.container, TESTID.insightsFact).length).toBeGreaterThan(0);
    expect(clickables(free.container)).toStrictEqual([TESTID.insightsGetTile]);
    expect(chrome(free.container)).toStrictEqual([]);
    free.dispose();
    mounted.pop();

    // PROVIDER: the finding, the history, Run — and each finding's detail
    // toggle (DoD 9.41), which reveals content and posts nothing.
    const paid = render();
    send(PROVIDER_STATE);
    send(viewControls({ surface: 'insights' }));
    expect(all(paid.container, TESTID.insightsFinding).length).toBe(1);
    expect(clickables(paid.container)).toStrictEqual([TESTID.insightsRun, TESTID.insightsDetail]);
    expect(chrome(paid.container)).toStrictEqual([]);
    paid.dispose();
    mounted.pop();

    // REFUSED: Run and "Show raw output", and no finding to expand.
    const refused = render();
    send(REFUSED_STATE);
    send(viewControls({ surface: 'insights' }));
    expect(clickables(refused.container)).toStrictEqual([TESTID.insightsRun, TESTID.insightsRawOutput]);
    expect(chrome(refused.container)).toStrictEqual([]);
  });

  it('the ABOUT surface carries its tiles — and the lit Get tile only while no provider', () => {
    const free = render();
    send({ ...PROVIDER_STATE, provider: null });
    send(viewControls({ surface: 'about' }));
    expect(all(free.container, TESTID.aboutSurface).length).toBe(1);
    expect(clickables(free.container)).toStrictEqual([
      TESTID.aboutLink,
      TESTID.aboutLink,
      TESTID.aboutLink,
      TESTID.aboutLink,
      TESTID.aboutGetTile,
    ]);
    expect(chrome(free.container)).toStrictEqual([]);
    free.dispose();
    mounted.pop();

    const paid = render();
    send(PROVIDER_STATE);
    send(viewControls({ surface: 'about' }));
    expect(clickables(paid.container)).toStrictEqual([
      TESTID.aboutLink,
      TESTID.aboutLink,
      TESTID.aboutLink,
      TESTID.aboutLink,
    ]);
    expect(chrome(paid.container)).toStrictEqual([]);
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

  it('a control named after an INHERITED property is found too', () => {
    // The prototype hole a verifier round found: `ALLOWED['toString']` is a
    // function on a frozen object literal, so a truthiness read would have
    // exempted every one of these.
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    for (const inherited of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      const planted = document.createElement('button');
      planted.setAttribute('data-testid', inherited);
      one(panel.container, TESTID.deck).appendChild(planted);
      expect(chrome(panel.container), inherited).toContain(inherited);
      planted.remove();
    }
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
      // `about-link` was the chrome bar's About BUTTON until DoD 9.14. The
      // id is back since DoD 9.32 as the About SURFACE's tiles — a ruled
      // exception above — so it is no longer a removed id.
      'insights-view',
      'insights-action',
      'stats-engine-chip',
      'stats-model-copy',
      'drawer-filters',
      'drawer-filter-chip',
      'drawer-order-select',
      'drawer-tool-select',
      'drawer-expand',
      'inspector-close',
      'drawer-detail-close',
      'sidebar-entry',
      'tweak-control',
    ]) {
      expect(source, `the bundle still carries ${gone}`).not.toContain(`"${gone}"`);
    }
    /*
     * `stats-tab` and `sidebar-tab` came OFF this list in DoD 9.17/9.20, and
     * their removal is asserted rather than silent: both are ids the
     * amendment rules back in, and a list that still forbade them would be a
     * test asserting the previous release.
     */
    expect(source).toContain('"stats-tab"');
    expect(source).toContain('"sidebar-tab"');
    // VACUITY: the bundle is a real bundle and does carry the ids that stay.
    expect(source).toContain('"deck-blob"');
    expect(source).toContain('"degraded-dismiss"');
  }, 120_000);
});
