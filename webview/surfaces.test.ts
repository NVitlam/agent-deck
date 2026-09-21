// @vitest-environment jsdom
/**
 * One window, four surfaces — v0.9.0 DoD 9.27, 9.29, 9.30 and 9.32.
 *
 * Spec `Amendment 2026-09-21 — One window, Insights provider, Menu-only
 * entry`: Deck, Statistics, Insights and About are SURFACES of the single
 * panel, and Menu switches between them in place.
 *
 * Every test here mounts the SHIPPED bundle's `App` and moves it the way the
 * host does — `viewControls` and `providerState` messages — because the
 * forwarding from `App.svelte` to each surface is exactly the wiring this
 * repository has shipped dead six times. A surface mounted by hand with its
 * props supplied would prove the component and nothing about the panel.
 *
 * Covered: every surface to every other; the example rotating on LEAVE; the
 * `openStats(sessionId)` deep link selecting its session; each intent posted
 * only in the state that allows it; About's lit Get tile, provider line and
 * footer version; the About tile's session-card styling; and DOM goldens of
 * both surfaces in both states (`webview/goldens/surfaces/`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ABOUT_LINKS, ABOUT_TEXT, aboutPage } from '../src/about.js';
import type { WebviewToHostMessage } from '../src/model/events.js';
import type { StatsRecord } from '../src/stats/schema.js';
import { STATS_SCHEMA_VERSION } from '../src/stats/schema.js';
import { TESTID } from './canvas-contract.js';
import type { ViewMode } from './canvas-contract.js';
import type { Store } from './store.js';
import type { WebviewHarness } from './testkit.js';
import { all, controlsForMode, loadHarness, one, press, viewControls } from './testkit.js';
import { liveSession } from './testdata.js';

let harness: WebviewHarness;
beforeAll(async () => {
  harness = await loadHarness();
}, 120_000);

const GOLDEN_DIR = resolve('webview/goldens/surfaces');
const UPDATING = process.env['AGENT_DECK_UPDATE_SURFACE_GOLDENS'] === '1';

/* ------------------------------------------------------------------------ *
 * Mounting
 * ------------------------------------------------------------------------ */

interface Panel {
  container: HTMLElement;
  store: Store;
  posted: WebviewToHostMessage[];
  dispose: () => void;
}

const mounted: Panel[] = [];

function render(): Panel {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const posted: WebviewToHostMessage[] = [];
  const started = harness.start(container, { postMessage: (m) => posted.push(m) });
  const panel: Panel = {
    container,
    store: started.store,
    posted,
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

function click(element: Element): void {
  harness.flushSync(() => press(element));
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

/** Intents the panel posted, without the ready/handshake traffic. */
function intents(panel: Panel): WebviewToHostMessage[] {
  return panel.posted.filter((m) => ['aboutLink', 'insightsGet', 'insightsRun'].includes(m.type));
}

const HOUR = 3_600_000;

/** A record ending `hoursAgo` before the real clock the surface reads. */
function record(sessionId: string, hoursAgo: number, over: Partial<StatsRecord> = {}): StatsRecord {
  const end = Date.now() - hoursAgo * HOUR;
  return {
    statsSchemaVersion: STATS_SCHEMA_VERSION,
    sessionId,
    engine: 'cc',
    projectSlug: 'c--ws-example',
    startedAt: end - HOUR,
    endedAt: end,
    coverage: 'full',
    agents: [],
    files: [],
    tools: [],
    loops: [],
    churn: [],
    contextChurn: [],
    compactions: [],
    stalls: [],
    skills: [],
    timing: {},
    totals: { prompt: 1000, output: 100, compactions: 1, subagents: 0, silentSubagents: 0, stalls: 0 },
    params: { loopMin: 3 },
    unavailable: [],
    ...over,
  };
}

/** The About page as the host builds it — the production builder, not a copy. */
const PAGE = aboutPage('0.9.0');

/** A registered provider's checked snapshot, as the host sends it. */
function providerState(over: { running?: boolean } = {}): unknown {
  return {
    type: 'providerState',
    page: PAGE,
    provider: {
      about: { name: 'Agent Deck Insights', version: '0.2.0' },
      latest: {
        runId: 'run-1',
        createdAt: Date.UTC(2026, 8, 21, 10, 0),
        agent: 'claude',
        window: { sinceMs: Date.UTC(2026, 8, 14, 10, 0), sessions: 3 },
        findings: [
          {
            kind: 'stall',
            confidence: 'medium',
            evidence: [{ statsKey: 'sessions[0].totals.stalls', value: 2 }],
          },
          {
            kind: 're-read-loop',
            confidence: 'high',
            evidence: [
              { statsKey: 'sessions[1].loops[0].count', value: 7 },
              { statsKey: 'sessions[1].loops.length', value: 1 },
            ],
          },
        ],
        findingsRejected: 1,
      },
      runs: [
        { runId: 'run-1', createdAt: Date.UTC(2026, 8, 21, 10, 0), outcome: 'findings', findings: 2 },
        { runId: 'run-0', createdAt: Date.UTC(2026, 8, 20, 9, 30), outcome: 'refused', findings: 0 },
      ],
      running: over.running ?? false,
      dropped: 0,
    },
  };
}

const NO_PROVIDER = { type: 'providerState', page: PAGE, provider: null };

/* ------------------------------------------------------------------------ *
 * DoD 9.27 — every surface to every other
 * ------------------------------------------------------------------------ */

/** The root testid of each mode, and nothing else on screen. */
const ROOT: Readonly<Record<ViewMode, string>> = {
  canvas: TESTID.deck,
  // The list renderer's root; it has no TESTID entry of its own.
  list: 'session-rail',
  stats: TESTID.statsView,
  insights: TESTID.insightsSurface,
  about: TESTID.aboutSurface,
};
const MODES = Object.keys(ROOT) as ViewMode[];

function showing(panel: Panel): string[] {
  return [TESTID.deck, 'session-rail', TESTID.statsView, TESTID.insightsSurface, TESTID.aboutSurface].filter(
    (id) => all(panel.container, id).length > 0,
  );
}

describe('one panel, switched in place — DoD 9.27', () => {
  it('every surface reaches every other, and exactly one shows', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    send({ type: 'statsStore', records: [record('s1', 2)], enabled: true });
    let transitions = 0;
    for (const from of MODES) {
      for (const to of MODES) {
        if (from === to) continue;
        send(viewControls(controlsForMode(from)));
        expect(showing(panel), `at ${from}`).toStrictEqual([ROOT[from]]);
        send(viewControls(controlsForMode(to)));
        expect(showing(panel), `${from} -> ${to}`).toStrictEqual([ROOT[to]]);
        transitions += 1;
      }
    }
    expect(transitions).toBe(20);
  });

  it('the deck’s renderer SURVIVES a trip through Insights and About', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    send(viewControls({ renderer: 'list', surface: 'sessions' }));
    expect(panel.store.getView().viewMode).toBe('list');
    send(viewControls({ renderer: 'list', surface: 'insights' }));
    send(viewControls({ renderer: 'list', surface: 'about' }));
    send(viewControls({ renderer: 'list', surface: 'sessions' }));
    expect(panel.store.getView().viewMode).toBe('list');
  });

  it('openStats(sessionId): the Statistics surface opens WITH that session selected', () => {
    const panel = render();
    const a = liveSession({ sessionId: 'session-a' });
    const b = liveSession({ sessionId: 'session-b' });
    send({ type: 'snapshot', sessions: [a, b] });
    send(viewControls({ surface: 'about' }));
    send(viewControls({ surface: 'stats', focusSessionId: 'session-b' }));
    expect(showing(panel)).toStrictEqual([TESTID.statsView]);
    expect(panel.store.getView().selectedSessionId).toBe('session-b');
    send(viewControls({ surface: 'insights' }));
    send(viewControls({ surface: 'stats', focusSessionId: 'session-a' }));
    expect(panel.store.getView().selectedSessionId).toBe('session-a');
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 9.29 — the free Insights surface, mounted
 * ------------------------------------------------------------------------ */

describe('the Insights surface, FREE — DoD 9.29', () => {
  it('counts the stored records the host sent, and only those in the window', () => {
    const panel = render();
    send(NO_PROVIDER);
    send({
      type: 'statsStore',
      records: [record('in-1', 1), record('in-2', 30), record('old', 24 * 8)],
      enabled: true,
    });
    send(viewControls({ surface: 'insights' }));
    const surface = one(panel.container, TESTID.insightsSurface);
    expect(surface.getAttribute('data-state')).toBe('free');
    const value = (fact: string): string =>
      surface.querySelector(`[data-fact="${fact}"] [data-testid="insights-fact-value"]`)?.textContent ?? '';
    expect(value('sessions')).toBe('2');
    expect(value('compactions')).toBe('2');
    expect(value('promptTokens')).toBe('2,000');
    expect(value('engineCost')).toBe('—');
  });

  it('says it has not read the store rather than counting nothing', () => {
    const panel = render();
    send(viewControls({ surface: 'insights' }));
    expect(one(panel.container, 'insights-facts-state').getAttribute('data-reason')).toBe('loading');
    expect(all(panel.container, TESTID.insightsFact)).toStrictEqual([]);
    send({ type: 'statsStore', records: [], enabled: false });
    expect(one(panel.container, 'insights-facts-state').getAttribute('data-reason')).toBe('disabled');
  });

  it('the example rotates on LEAVING the surface: 1, 2, 3, 1', () => {
    const panel = render();
    send({ type: 'statsStore', records: [], enabled: true });
    const seen: string[] = [];
    for (let open = 0; open < 4; open += 1) {
      send(viewControls({ surface: 'insights' }));
      // Re-stating the same surface is not a visit.
      send(viewControls({ surface: 'insights' }));
      seen.push(one(panel.container, TESTID.insightsExample).getAttribute('data-example') ?? '');
      send(viewControls({ surface: 'about' }));
    }
    expect(seen).toStrictEqual(['compaction', 'cache-miss', 'reread-loop', 'compaction']);
    expect(one(panel.container, TESTID.aboutSurface)).toBeTruthy();
  });

  it('the Get tile posts insightsGet — and there is no Run while no provider', () => {
    const panel = render();
    send(NO_PROVIDER);
    send(viewControls({ surface: 'insights' }));
    expect(all(panel.container, TESTID.insightsRun)).toStrictEqual([]);
    click(one(panel.container, TESTID.insightsGetTile));
    expect(intents(panel)).toStrictEqual([{ type: 'insightsGet' }]);
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 9.30 — the provider state, mounted
 * ------------------------------------------------------------------------ */

describe('the Insights surface, PROVIDER — DoD 9.30', () => {
  it('renders the latest set, the history and Run from the snapshot, and no free facts', () => {
    const panel = render();
    send({ type: 'statsStore', records: [record('s1', 1)], enabled: true });
    send(providerState());
    send(viewControls({ surface: 'insights' }));
    const surface = one(panel.container, TESTID.insightsSurface);
    expect(surface.getAttribute('data-state')).toBe('provider');
    expect(all(panel.container, TESTID.insightsFinding)).toHaveLength(2);
    expect(all(panel.container, TESTID.insightsHistoryRow)).toHaveLength(2);
    expect(all(panel.container, TESTID.insightsFact)).toStrictEqual([]);
    expect(all(panel.container, TESTID.insightsGetTile)).toStrictEqual([]);
    click(one(panel.container, TESTID.insightsRun));
    expect(intents(panel)).toStrictEqual([{ type: 'insightsRun' }]);
  });

  it('a RUNNING provider shows Running and posts nothing', () => {
    const panel = render();
    send(providerState({ running: true }));
    send(viewControls({ surface: 'insights' }));
    const run = one(panel.container, TESTID.insightsRun);
    expect(run.textContent?.trim()).toBe('Running');
    expect(run.hasAttribute('disabled')).toBe(true);
    panel.store.runInsights();
    expect(intents(panel)).toStrictEqual([]);
  });

  it('a provider registering, changing and disposing re-renders the OPEN surface', () => {
    const panel = render();
    send({ type: 'statsStore', records: [], enabled: true });
    send(viewControls({ surface: 'insights' }));
    expect(one(panel.container, TESTID.insightsSurface).getAttribute('data-state')).toBe('free');
    send(providerState());
    expect(one(panel.container, TESTID.insightsSurface).getAttribute('data-state')).toBe('provider');
    send(NO_PROVIDER);
    expect(one(panel.container, TESTID.insightsSurface).getAttribute('data-state')).toBe('free');
    // Disposal is the free state, not a blank: the facts and the Get tile return.
    expect(all(panel.container, TESTID.insightsGetTile)).toHaveLength(1);
  });

  it('the store refuses a Get intent while a provider is registered', () => {
    const panel = render();
    send(providerState());
    panel.store.getInsights();
    expect(intents(panel)).toStrictEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 9.32 — About, in the same window
 * ------------------------------------------------------------------------ */

describe('the About surface — DoD 9.32', () => {
  it('no provider: four link tiles and the LIT Get tile, each posting its intent', () => {
    const panel = render();
    send(NO_PROVIDER);
    send(viewControls({ surface: 'about' }));
    const links = all(panel.container, TESTID.aboutLink);
    expect(links).toHaveLength(ABOUT_LINKS.length);
    for (const link of links) click(link);
    click(one(panel.container, TESTID.aboutGetTile));
    expect(one(panel.container, TESTID.aboutGetTile).getAttribute('data-lit')).toBe('true');
    expect(all(panel.container, TESTID.aboutProvider)).toStrictEqual([]);
    expect(intents(panel)).toStrictEqual([
      ...ABOUT_LINKS.map((_, index) => ({ type: 'aboutLink', index })),
      { type: 'insightsGet' },
    ]);
  });

  it('a provider registered: no Get tile, and a line naming it and its version', () => {
    const panel = render();
    send(providerState());
    send(viewControls({ surface: 'about' }));
    expect(all(panel.container, TESTID.aboutGetTile)).toStrictEqual([]);
    expect(one(panel.container, TESTID.aboutProvider).textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Insights provider: Agent Deck Insights 0.2.0',
    );
  });

  it('renders the PAGE the host sent — text, tiles and footer — and nothing before it', () => {
    const panel = render();
    send(viewControls({ surface: 'about' }));
    // Before the host has stated the page: the heading, and no tile to press.
    expect(all(panel.container, TESTID.aboutLink)).toStrictEqual([]);
    expect(all(panel.container, TESTID.aboutGetTile)).toStrictEqual([]);
    expect(all(panel.container, TESTID.aboutFooter)).toStrictEqual([]);
    send(NO_PROVIDER);
    expect(one(panel.container, 'about-text').textContent).toBe(PAGE.text);
    expect(one(panel.container, TESTID.aboutFooter).textContent?.trim()).toBe(PAGE.footer);
    expect(PAGE.footer).toContain('0.9.0');
    expect(PAGE.footer).toContain('MIT');
    expect(
      all(panel.container, 'about-link-host').map((el) => el.textContent),
    ).toStrictEqual([...PAGE.links.map((l) => l.host), PAGE.get.host]);
    // A page the store cannot read is no page: every tile index would be a guess.
    send({ ...NO_PROVIDER, page: { ...PAGE, links: [{ label: 'x' }] } });
    expect(all(panel.container, TESTID.aboutLink)).toStrictEqual([]);
  });

  it('an out-of-range index is never posted by the panel', () => {
    const panel = render();
    send(NO_PROVIDER);
    panel.store.openAboutLink(ABOUT_LINKS.length);
    panel.store.openAboutLink(-1);
    panel.store.openAboutLink(0.5);
    expect(intents(panel)).toStrictEqual([]);
    // The control: an index in range IS posted, so the refusals above are real.
    panel.store.openAboutLink(ABOUT_LINKS.length - 1);
    expect(intents(panel)).toStrictEqual([{ type: 'aboutLink', index: ABOUT_LINKS.length - 1 }]);
  });

  it('a tile takes the SESSION CARD’s border, fill, radius, hover and state colours', () => {
    const card = readFileSync(resolve('webview/SessionCell.svelte'), 'utf8');
    const source = readFileSync(resolve('webview/AboutSurface.svelte'), 'utf8');
    const css = source.slice(source.indexOf('<style>'));
    for (const variable of [
      '--vscode-editorWidget-background',
      '--vscode-panel-border',
      '--vscode-focusBorder',
      '--vscode-charts-yellow',
      '--vscode-charts-blue',
    ]) {
      expect(card, `the session card no longer uses ${variable}`).toContain(`var(${variable}`);
      expect(css, `the tile does not use ${variable}`).toContain(`var(${variable}`);
    }
    expect(card).toMatch(/const RADIUS = 10;/);
    expect(card).toMatch(/220 x 88/);
    const tile = /\n {2}\.tile \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(tile, 'the tile has no rule').not.toBe('');
    expect(tile).toContain('border-radius: 10px;');
    expect(tile).toContain('width: 220px;');
    expect(tile).toContain('min-height: 88px;');
    expect(tile).toContain('border-left: 3px solid var(--vscode-charts-blue, currentColor);');
    // Read from the RULES, not the whole sheet (mutation A4, round 3).
    expect(card).toMatch(/\.cell:hover \.border \{[^}]*stroke: var\(--vscode-focusBorder, currentColor\);/);
    const hover = /\.tile:hover, \.tile:focus-visible \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(hover, 'the tile has no hover rule').not.toBe('');
    expect(hover).toContain('border-color: var(--vscode-focusBorder, currentColor);');
    expect(hover).toContain('border-left-color: var(--vscode-charts-yellow, currentColor);');
    const lit = /\.tile\.lit \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(lit).toContain('border-left: 5px solid var(--vscode-charts-yellow, currentColor);');
    expect(css).not.toMatch(/transform|box-shadow/);
  });
});

/* ------------------------------------------------------------------------ *
 * DOM goldens
 * ------------------------------------------------------------------------ */

const KEEP_ATTRS = new Set([
  'data-testid',
  'data-state',
  'data-fact',
  'data-example',
  'data-reason',
  'data-index',
  'data-lit',
  'data-running',
  'disabled',
  'role',
  'aria-label',
]);

/**
 * Text as the golden records it. Two tokens: the About introduction (it names
 * the author, and the privacy sweep gates on history — round 3 paid for that
 * once) and any instant, because the free window is counted from the real
 * clock.
 */
function tokenise(text: string): string {
  return text
    .replace(ABOUT_TEXT, '<about-intro>')
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, '<instant>');
}

function ownText(el: Element): string {
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) out += node.textContent ?? '';
  }
  return tokenise(out.replace(/\s+/g, ' ').trim());
}

function outline(el: Element, depth: number, lines: string[]): string[] {
  const parts = [`${'  '.repeat(depth)}${el.tagName.toLowerCase()}`];
  for (const cls of [...el.classList]) {
    if (!cls.startsWith('svelte-')) parts.push(`.${cls}`);
  }
  parts.push(
    ...[...el.attributes]
      .filter((a) => KEEP_ATTRS.has(a.name))
      .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
      .sort(),
  );
  const text = ownText(el);
  if (text !== '') parts.push(JSON.stringify(text));
  lines.push(parts.join(' '));
  for (const child of el.children) outline(child, depth + 1, lines);
  return lines;
}

function golden(name: string, root: Element): void {
  const actual = `${outline(root, 0, []).join('\n')}\n`;
  const file = resolve(GOLDEN_DIR, `${name}.dom.txt`);
  if (UPDATING) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, actual, 'utf8');
    return;
  }
  expect(existsSync(file), `webview/goldens/surfaces/${name}.dom.txt is missing`).toBe(true);
  expect(
    actual,
    `webview/goldens/surfaces/${name}.dom.txt is stale — re-run with ` +
      'AGENT_DECK_UPDATE_SURFACE_GOLDENS=1 if the change is intended',
  ).toBe(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
}

describe('DOM goldens of both surfaces in both states', () => {
  it('About, free and with a provider', () => {
    const free = render();
    send(NO_PROVIDER);
    send(viewControls({ surface: 'about' }));
    const freeRoot = one(free.container, TESTID.aboutSurface);
    // The intro really is there before the golden replaces it with a token.
    expect(freeRoot.textContent).toContain(ABOUT_TEXT);
    golden('about-free', freeRoot);
    free.dispose();
    mounted.pop();

    const paid = render();
    send(providerState());
    send(viewControls({ surface: 'about' }));
    golden('about-provider', one(paid.container, TESTID.aboutSurface));
  });

  it('Insights, free and with a provider', () => {
    const free = render();
    send(NO_PROVIDER);
    send({
      type: 'statsStore',
      records: [
        record('a', 1, { engine: 'codex', tools: [{ toolName: 'shell', class: 'shell', calls: 3, errors: 1 }] }),
        record('b', 5, { timing: { longestGapMs: 300_000 } }),
        record('c', 6, { coverage: 'excluded:partial' }),
      ],
      enabled: true,
    });
    send(viewControls({ surface: 'insights' }));
    golden('insights-free', one(free.container, TESTID.insightsSurface));
    free.dispose();
    mounted.pop();

    const paid = render();
    send(providerState());
    send(viewControls({ surface: 'insights' }));
    golden('insights-provider', one(paid.container, TESTID.insightsSurface));
  });

  it('the goldens are not being written by this run', () => {
    expect(UPDATING, 'AGENT_DECK_UPDATE_SURFACE_GOLDENS is set: the goldens were REWRITTEN').toBe(false);
  });
});
