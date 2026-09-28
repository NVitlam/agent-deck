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
  return panel.posted.filter((m) =>
    [
      'aboutLink',
      'insightsGet',
      'insightsRawOutput',
      'insightsSelect',
      'insightsExport',
      'insightsExportBatch',
      'insightsInvestigate',
    ].includes(m.type),
  );
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

const LATEST_AT = Date.UTC(2026, 8, 21, 10, 0);

/** A finding as the host sends it after the check (DoD 9.40). */
function viewFinding(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: 're-read-loop',
    confidence: 'high',
    action: { lead: `Lead of ${id}`, detail: `Detail of ${id}.\nSecond line.` },
    cause: `Cause of ${id}.`,
    evidence: [{ label: 'Reads', sessionId: 'ses_example01', statsKey: 'sessions[1].loops[0].count', value: 7 }],
    sinceLastRun: 'new',
    ...over,
  };
}

/** The four latest sets DoD 9.41 names. */
const LATEST: Readonly<Record<'ok' | 'empty' | 'refused' | 'mixed-evidence', Record<string, unknown>>> = {
  ok: {
    runId: 'run-1',
    createdAt: LATEST_AT,
    agent: { kind: 'claude', version: '2.1.246' },
    window: { sessions: 3, excluded: 1, sinceMs: Date.UTC(2026, 8, 14, 10, 0) },
    usage: { prompt: 12_345, output: 2_345, costUsd: 0.42 },
    findings: [
      viewFinding('f-1', { kind: 'stall', confidence: 'medium', sinceLastRun: 'still' }),
      viewFinding('f-2', { sinceLastRun: null }),
    ],
    resolvedKinds: [],
    rejected: 1,
    state: 'ok',
  },
  empty: {
    runId: 'run-empty',
    createdAt: LATEST_AT,
    agent: { kind: 'codex', version: '0.151.0' },
    window: { sessions: 2, excluded: 0, sinceMs: Date.UTC(2026, 8, 14, 10, 0) },
    usage: { prompt: 900, output: 40 },
    findings: [],
    resolvedKinds: [],
    rejected: 0,
    state: 'empty',
  },
  refused: {
    runId: 'run-refused',
    createdAt: LATEST_AT,
    agent: { kind: 'claude', version: '2.1.246' },
    window: { sessions: 3, excluded: 0, sinceMs: Date.UTC(2026, 8, 14, 10, 0) },
    usage: null,
    findings: [],
    resolvedKinds: [],
    rejected: 0,
    state: 'refused',
    refusal: { step: 'validate', reason: 'The response held no JSON object.' },
  },
  'mixed-evidence': {
    runId: 'run-mixed',
    createdAt: LATEST_AT,
    agent: { kind: 'claude', version: '2.1.246' },
    window: { sessions: 3, excluded: 0, sinceMs: Date.UTC(2026, 8, 14, 10, 0) },
    usage: null,
    findings: [
      viewFinding('f-1', {
        action: { lead: 'Lead of f-1', detail: '' },
        evidence: [
          { label: 'Reads', sessionId: 'ses_example01', statsKey: 'sessions[0].loops[0].count', value: 7 },
          { label: 'File', sessionId: 'ses_example01', statsKey: 'sessions[0].files[2].filePath', value: 'repo/docs/schema.md' },
          // DoD 9.59 and round 9b — every `Ms` key renders with its duration.
          { label: 'Longest gap', sessionId: 'ses_example01', statsKey: 'sessions[0].timing.longestGapMs', value: 28_100_113 },
          { label: 'Duration sum', sessionId: 'ses_example01', statsKey: 'sessions[0].tools[0].durationMsSum', value: 90_500 },
          { label: 'Duration max', sessionId: 'ses_example01', statsKey: 'sessions[0].tools[0].durationMsMax', value: 61_250 },
          // Round 9b — a rounded float, its exact value in the tooltip.
          { label: 'Cost', sessionId: 'ses_example01', statsKey: 'sessions[0].totals.costUsd', value: 0.238149 },
        ],
      }),
    ],
    resolvedKinds: ['stall', 'compaction'],
    rejected: 0,
    state: 'ok',
  },
};

/**
 * A registered provider's checked snapshot, as the host sends it — the
 * REPORT LIST and the host's SELECTION since DoD 9.46. `latest` names which
 * of the four sets is selected; `selected: false` is the list with nothing
 * selected yet.
 */
function providerState(
  over: {
    latest?: keyof typeof LATEST;
    rawOutput?: boolean;
    investigate?: boolean;
    selected?: boolean;
    status?: string;
    runs?: unknown[];
  } = {},
): unknown {
  const latest = over.latest ?? 'ok';
  const set = LATEST[latest];
  return {
    type: 'providerState',
    page: PAGE,
    provider: {
      about: {
        name: 'Agent Deck Insights',
        version: '0.2.0',
        ...(over.status === undefined ? {} : { status: over.status }),
      },
      runs: over.runs ?? [
        { runId: 'run-1', createdAt: LATEST_AT, state: 'ok', findings: 2, agentKind: 'claude' },
        { runId: 'run-0', createdAt: Date.UTC(2026, 8, 20, 9, 30), state: 'refused', findings: 0, agentKind: 'codex' },
      ],
      dropped: 0,
      selected:
        over.selected === false
          ? null
          : {
              runId: set['runId'],
              set,
              dropped: 0,
              rawOutput: over.rawOutput ?? latest === 'refused',
              investigate: over.investigate ?? false,
            },
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

  it('a focus that did not MOVE selects nothing — the user’s own choice stands', () => {
    /*
     * Verifier round 9.33, D2. The host re-sends the whole control state on
     * every command; a focus still riding on it re-selected its session and
     * cleared the drawer's node on each one. The host now drops the focus
     * when the link ends, and the store selects only when the focus changes.
     */
    const panel = render();
    const a = liveSession({ sessionId: 'session-a' });
    const b = liveSession({ sessionId: 'session-b' });
    send({ type: 'snapshot', sessions: [a, b] });
    send(viewControls({ surface: 'stats', focusSessionId: 'session-b' }));
    expect(panel.store.getView().selectedSessionId).toBe('session-b');
    harness.flushSync(() => {
      panel.store.selectSession('session-a');
      panel.store.selectNode('tool-bash');
    });
    expect(panel.store.getView().selectedNodeId).toBe('tool-bash');
    // The same focus again, on a later command's state.
    send(viewControls({ surface: 'sessions', focusSessionId: 'session-b' }));
    expect(panel.store.getView().selectedSessionId).toBe('session-a');
    expect(panel.store.getView().selectedNodeId).toBe('tool-bash');
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
    // DoD 9.60 — the one fact line, verbatim, after the tiles.
    const line = one(panel.container, 'insights-failure-kinds');
    expect(line.textContent).toBe(
      'Deliberate failures (test-driven breakage) and accidental ones are indistinguishable in this data.',
    );
    const tiles = all(panel.container, TESTID.insightsFact);
    expect((tiles.at(-1) as Element).compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('counts long-idle resumes against the SETTING the host sent, not a fixed 120 s (DoD 9.38)', () => {
    const panel = render();
    send(NO_PROVIDER);
    // A three-minute gap: a resume at the 120 s default, not at a 300 s setting.
    send({
      type: 'statsStore',
      records: [record('gap', 1, { timing: { longestGapMs: 180_000 } })],
      enabled: true,
    });
    send(viewControls({ surface: 'insights' }));
    const idle = (): string =>
      panel.container.querySelector('[data-fact="idleResumes"] [data-testid="insights-fact-value"]')
        ?.textContent ?? '';
    expect(idle()).toBe('1');
    send({ type: 'settings', canvasAutoFit: true, tweaks: {}, livenessThresholdMs: 300_000 });
    expect(idle()).toBe('0');
    // A LATER change moves it too (verifier round 9.39, V11: a store that
    // kept the first value it heard stayed green on one send).
    send({ type: 'settings', canvasAutoFit: true, tweaks: {}, livenessThresholdMs: 150_000 });
    expect(idle()).toBe('1');
    send({ type: 'settings', canvasAutoFit: true, tweaks: {}, livenessThresholdMs: 300_000 });
    expect(idle()).toBe('0');
    expect(
      panel.container.querySelector('[data-fact="idleResumes"] [data-testid="insights-fact-note"]')
        ?.textContent,
    ).toBe('sessions with a gap of 300,000 ms · 5 m or more');
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

  it('the Get tile posts insightsGet — and there is no report list while no provider', () => {
    const panel = render();
    send(NO_PROVIDER);
    send(viewControls({ surface: 'insights' }));
    expect(all(panel.container, TESTID.insightsReportList)).toStrictEqual([]);
    expect(all(panel.container, TESTID.insightsExport)).toStrictEqual([]);
    click(one(panel.container, TESTID.insightsGetTile));
    expect(intents(panel)).toStrictEqual([{ type: 'insightsGet' }]);
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 9.30 — the provider state, mounted
 * ------------------------------------------------------------------------ */

describe('the Insights surface, PROVIDER — DoD 9.30, reshaped by DoD 9.46', () => {
  it('renders the report list, the selected report and the fact tiles below both — and no Run', () => {
    const panel = render();
    send({ type: 'statsStore', records: [record('s1', 1)], enabled: true });
    send(providerState());
    send(viewControls({ surface: 'insights' }));
    const surface = one(panel.container, TESTID.insightsSurface);
    expect(surface.getAttribute('data-state')).toBe('provider');
    expect(all(panel.container, TESTID.insightsReportRow)).toHaveLength(2);
    expect(all(panel.container, TESTID.insightsFinding)).toHaveLength(2);
    // "Fact tiles below both" (spec `Amendment 2026-09-23`): the free state's
    // tiles, after the two panes, and neither the example nor the Get tile.
    const facts = all(panel.container, TESTID.insightsFact);
    expect(facts.length).toBeGreaterThan(0);
    const preview = one(panel.container, TESTID.insightsPreview);
    expect(preview.compareDocumentPosition(facts[0] as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(all(panel.container, TESTID.insightsExample)).toStrictEqual([]);
    expect(all(panel.container, TESTID.insightsGetTile)).toStrictEqual([]);
    expect(panel.container.querySelector('[data-testid="insights-run"]')).toBeNull();
    expect([...panel.container.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain('Run');
    // DoD 9.60, the ruling of 2026-09-26 (round 9): the fact line shows in BOTH
    // states — here, once, after the last fact tile below the report list.
    const lines = all(panel.container, 'insights-failure-kinds');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toBe(
      'Deliberate failures (test-driven breakage) and accidental ones are indistinguishable in this data.',
    );
    expect((facts.at(-1) as Element).compareDocumentPosition(lines[0] as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('NOTHING SELECTED: the preview says so, verbatim, and holds no report and no Export', () => {
    const panel = render();
    send(providerState({ selected: false }));
    send(viewControls({ surface: 'insights' }));
    expect(one(panel.container, 'insights-preview-empty').textContent).toBe('Select a report to preview / download.');
    expect(all(panel.container, TESTID.insightsLatest)).toStrictEqual([]);
    expect(all(panel.container, TESTID.insightsExport)).toStrictEqual([]);
    expect(one(panel.container, TESTID.insightsPreview).getAttribute('data-run')).toBe('');
    for (const row of all(panel.container, TESTID.insightsReportRow)) {
      expect(row.getAttribute('data-selected')).toBe('false');
    }
  });

  it('a row click posts insightsSelect for THAT run; the selection shown is the HOST’s', () => {
    const panel = render();
    send(providerState({ selected: false }));
    send(viewControls({ surface: 'insights' }));
    const selects = all(panel.container, TESTID.insightsReportSelect);
    click(selects[1] as Element);
    expect(intents(panel)).toStrictEqual([{ type: 'insightsSelect', runId: 'run-0' }]);
    // Nothing moves until the host answers: the selection is the host's.
    expect(one(panel.container, TESTID.insightsPreview).getAttribute('data-run')).toBe('');
    send(providerState({ latest: 'ok' }));
    const rows = all(panel.container, TESTID.insightsReportRow);
    expect(rows.map((row) => row.getAttribute('data-selected'))).toStrictEqual(['true', 'false']);
    // The store refuses a run the list does not hold.
    panel.store.selectInsightsRun('run-404');
    expect(intents(panel)).toHaveLength(1);
  });

  it('ticks are view state: they post nothing, count on the button, and batch in LIST order', () => {
    const panel = render();
    send(providerState({ selected: false }));
    send(viewControls({ surface: 'insights' }));
    const button = one(panel.container, TESTID.insightsExportTicked);
    expect(button.textContent?.trim()).toBe('Export ticked (0)');
    expect(button.hasAttribute('disabled')).toBe(true);
    panel.store.exportTickedInsights();
    expect(intents(panel)).toStrictEqual([]);
    const ticks = all(panel.container, TESTID.insightsReportTick);
    // Ticked in REVERSE: the batch still reads newest first, like the list.
    click(ticks[1] as Element);
    click(ticks[0] as Element);
    expect(intents(panel)).toStrictEqual([]);
    expect(all(panel.container, TESTID.insightsReportRow).map((r) => r.getAttribute('data-ticked'))).toStrictEqual([
      'true',
      'true',
    ]);
    expect(one(panel.container, TESTID.insightsExportTicked).textContent?.trim()).toBe('Export ticked (2)');
    click(one(panel.container, TESTID.insightsExportTicked));
    expect(intents(panel)).toStrictEqual([{ type: 'insightsExportBatch', runIds: ['run-1', 'run-0'] }]);
    // Untick one.
    click(all(panel.container, TESTID.insightsReportTick)[0] as Element);
    expect(one(panel.container, TESTID.insightsExportTicked).textContent?.trim()).toBe('Export ticked (1)');
  });

  it('a tick names a run the list holds, or it goes: a shorter list prunes it; the free state clears all', () => {
    const panel = render();
    send(providerState({ selected: false }));
    send(viewControls({ surface: 'insights' }));
    for (const tick of all(panel.container, TESTID.insightsReportTick)) click(tick);
    expect(panel.store.getView().insightsTicks).toStrictEqual(['run-1', 'run-0']);
    send(
      providerState({
        selected: false,
        runs: [{ runId: 'run-0', createdAt: Date.UTC(2026, 8, 20, 9, 30), state: 'refused', findings: 0, agentKind: 'codex' }],
      }),
    );
    expect(panel.store.getView().insightsTicks).toStrictEqual(['run-0']);
    send(NO_PROVIDER);
    expect(panel.store.getView().insightsTicks).toStrictEqual([]);
    // A tick for a run the list never held is refused.
    send(providerState({ selected: false }));
    panel.store.toggleInsightsTick('run-404');
    expect(panel.store.getView().insightsTicks).toStrictEqual([]);
  });

  it('the preview header’s Export actions post their target, in the amendment’s order', () => {
    const panel = render();
    send(providerState());
    send(viewControls({ surface: 'insights' }));
    const exports = all(panel.container, TESTID.insightsExport);
    expect(exports.map((el) => [el.getAttribute('data-target'), el.textContent?.trim()])).toStrictEqual([
      ['html', 'HTML'],
      ['markdown', 'Markdown'],
      ['copy', 'Copy'],
    ]);
    // In the preview's HEADER, beside the report's heading.
    for (const el of exports) expect(el.closest(`[data-testid="${TESTID.insightsRunFacts}"]`)).not.toBeNull();
    for (const el of exports) click(el);
    expect(intents(panel)).toStrictEqual([
      { type: 'insightsExport', target: 'html' },
      { type: 'insightsExport', target: 'markdown' },
      { type: 'insightsExport', target: 'copy' },
    ]);
  });

  it('a selected run with NO report says so, and offers no Export', () => {
    const panel = render();
    const state = providerState() as { provider: Record<string, unknown> };
    send({
      ...state,
      provider: { ...state.provider, selected: { runId: 'run-0', set: null, dropped: 1, rawOutput: false, investigate: true } },
    });
    send(viewControls({ surface: 'insights' }));
    expect(one(panel.container, 'insights-preview-missing').textContent).toBe('The provider has no report for this run.');
    expect(one(panel.container, 'insights-preview-dropped').textContent).toBe(
      '1 value from this report did not pass the check and is not shown',
    );
    expect(all(panel.container, TESTID.insightsExport)).toStrictEqual([]);
    // DoD 9.54: the provider offers investigate, and a run with no report
    // still offers nothing to investigate.
    expect(all(panel.container, TESTID.insightsInvestigate)).toStrictEqual([]);
    panel.store.exportInsights('html');
    panel.store.investigateInsights();
    expect(intents(panel)).toStrictEqual([]);
  });

  it('9.54: "Investigate Report" sits beside Export while the provider has investigate, and posts no run id', () => {
    const panel = render();
    send(providerState({ investigate: true }));
    send(viewControls({ surface: 'insights' }));
    const button = one(panel.container, TESTID.insightsInvestigate);
    expect(button.textContent?.trim()).toBe('Investigate Report');
    // Beside Export: the same header group, after the three of them.
    const group = button.parentElement;
    expect(group?.classList.contains('exports')).toBe(true);
    expect([...(group?.children ?? [])].map((el) => el.getAttribute('data-testid'))).toStrictEqual([
      TESTID.insightsExport,
      TESTID.insightsExport,
      TESTID.insightsExport,
      TESTID.insightsInvestigate,
    ]);
    click(button);
    // No payload: the run is the host's selection.
    expect(intents(panel)).toStrictEqual([{ type: 'insightsInvestigate' }]);
    // Absent: no button, and the store posts nothing even if asked.
    send(providerState({ investigate: false }));
    expect(all(panel.container, TESTID.insightsInvestigate)).toStrictEqual([]);
    panel.store.investigateInsights();
    expect(intents(panel)).toStrictEqual([{ type: 'insightsInvestigate' }]);
  });

  it('9.48 D3: a report the check dropped part of says so, INSIDE the report the export is built from', () => {
    // Fold mutation F5 survived without this: the layout carried the line,
    // and nothing mounted the component with a drop to see it drawn.
    const panel = render();
    const state = providerState() as { provider: Record<string, unknown> };
    send({
      ...state,
      provider: { ...state.provider, selected: { ...(state.provider['selected'] as object), dropped: 2 } },
    });
    send(viewControls({ surface: 'insights' }));
    const line = one(panel.container, 'insights-preview-dropped');
    expect(line.textContent).toBe('2 values from this report did not pass the check and are not shown');
    expect(line.closest(`[data-testid="${TESTID.insightsLatest}"]`)).not.toBeNull();
  });

  it('DoD 9.44: the provider’s status is one line under its name', () => {
    const panel = render();
    send(providerState({ status: 'licensed until 2027-09-23' }));
    send(viewControls({ surface: 'insights' }));
    const status = one(panel.container, 'insights-status');
    expect(status.textContent).toBe('licensed until 2027-09-23');
    expect(status.previousElementSibling?.tagName).toBe('H1');
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

  it('repeated ids on the wire still render — the surface keys its lists by position', () => {
    // Verifier round 9.33, D1. The host's check now drops a repeated run id
    // or evidence key, and this is the second layer: keyed on the ids, Svelte
    // threw `each_key_duplicate` and the whole surface rendered nothing.
    const panel = render();
    const state = providerState() as { provider: Record<string, unknown> };
    const run = { runId: 'run-1', createdAt: LATEST_AT, state: 'ok', findings: 1, agentKind: 'claude' };
    const evidence = { label: 'Stalls', sessionId: 'ses_example01', statsKey: 'sessions[0].totals.stalls', value: 2 };
    const selected = state.provider['selected'] as Record<string, unknown>;
    send({
      ...state,
      provider: {
        ...state.provider,
        selected: {
          ...selected,
          set: {
            ...(selected['set'] as Record<string, unknown>),
            findings: [viewFinding('f-1', { evidence: [evidence, evidence] }), viewFinding('f-1')],
          },
        },
        runs: [run, run],
      },
    });
    send(viewControls({ surface: 'insights' }));
    expect(all(panel.container, TESTID.insightsReportRow)).toHaveLength(2);
    expect(all(panel.container, TESTID.insightsFinding)).toHaveLength(2);
    expect(all(panel.container, TESTID.insightsEvidence)).toHaveLength(3);
  });

  it('the store refuses a Get intent while a provider is registered', () => {
    const panel = render();
    send(providerState());
    panel.store.getInsights();
    expect(intents(panel)).toStrictEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 9.41 — the widened finding, mounted
 * ------------------------------------------------------------------------ */

/** The testids and text of a finding's children, in DOCUMENT order. */
function findingOrder(finding: Element): string[] {
  return [...finding.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid') ?? '');
}

describe('the provider’s text, rendered — DoD 9.41', () => {
  it('a finding reads LEAD first, then its words, the detail behind an expand, the cause, the evidence', () => {
    const panel = render();
    send(providerState());
    send(viewControls({ surface: 'insights' }));
    const [first] = all(panel.container, TESTID.insightsFinding);
    expect(findingOrder(first as Element)).toStrictEqual([
      'insights-finding-lead',
      'insights-finding-meta',
      TESTID.insightsDetail,
      'insights-finding-detail',
      'insights-finding-cause',
      TESTID.insightsEvidence,
    ]);
    expect(one(first as Element, 'insights-finding-lead').textContent).toBe('Lead of f-1');
    expect(one(first as Element, 'insights-finding-meta').textContent).toBe(
      'Stall · medium confidence · since last run: still',
    );
    // The detail is BEHIND the expand: inside a closed <details>, under its <summary>.
    const detail = one(first as Element, 'insights-finding-detail');
    const details = detail.closest('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('summary')?.getAttribute('data-testid')).toBe(TESTID.insightsDetail);
    // The provider's own line break survives as text.
    expect(detail.textContent).toBe('Detail of f-1.\nSecond line.');
    // A finding with no since-last-run says nothing about it.
    const second = all(panel.container, TESTID.insightsFinding)[1] as Element;
    expect(one(second, 'insights-finding-meta').textContent).toBe('Re-read loop · high confidence');
  });

  it('provider text is TEXT: markup in it renders as characters, never as elements', () => {
    const panel = render();
    const state = providerState() as { provider: Record<string, unknown> };
    const selected = state.provider['selected'] as Record<string, unknown>;
    send({
      ...state,
      provider: {
        ...state.provider,
        selected: {
          ...selected,
          set: {
            ...(selected['set'] as Record<string, unknown>),
            findings: [viewFinding('f-x', { cause: 'wrote <img src=x onerror=alert(1)> into a.ts' })],
          },
        },
      },
    });
    send(viewControls({ surface: 'insights' }));
    const cause = one(panel.container, 'insights-finding-cause');
    expect(cause.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(cause.querySelector('img')).toBeNull();
  });

  it('run facts head the set: "estimated by Claude Code" on a Claude run’s usage, and not on a Codex run’s', () => {
    const claude = render();
    send(providerState());
    send(viewControls({ surface: 'insights' }));
    expect(one(claude.container, 'insights-run-usage').textContent).toBe(
      'Run usage: 12,345 prompt tokens · 2,345 output tokens · 0.42 USD (estimated by Claude Code)',
    );
    expect(one(claude.container, TESTID.insightsRunFacts).textContent).toContain('Claude Code 2.1.246');
    claude.dispose();
    mounted.pop();

    const codex = render();
    send(providerState({ latest: 'empty' }));
    send(viewControls({ surface: 'insights' }));
    expect(one(codex.container, 'insights-run-usage').textContent).toBe('Run usage: 900 prompt tokens · 40 output tokens');
    expect(one(codex.container, TESTID.insightsRunFacts).textContent).not.toContain('estimated');
    expect(one(codex.container, 'insights-latest-note').textContent).toBe(
      'The run read the window and recorded no findings.',
    );
  });

  it('a REFUSED set shows its step and reason, and "Show raw output" posts the intent', () => {
    const panel = render();
    send(providerState({ latest: 'refused' }));
    send(viewControls({ surface: 'insights' }));
    const refusal = one(panel.container, TESTID.insightsRefusal);
    expect(refusal.textContent).toContain('Refused at step: validate');
    expect(refusal.textContent).toContain('The response held no JSON object.');
    expect(all(panel.container, TESTID.insightsFinding)).toStrictEqual([]);
    // Offered: the action, and not the sentence.
    expect(all(panel.container, 'insights-raw-output-note')).toStrictEqual([]);
    click(one(panel.container, TESTID.insightsRawOutput));
    expect(intents(panel)).toStrictEqual([{ type: 'insightsRawOutput' }]);
  });

  it('no raw-output action where the host did not offer one — and the store posts nothing if asked', () => {
    const panel = render();
    send(providerState({ latest: 'refused', rawOutput: false }));
    send(viewControls({ surface: 'insights' }));
    expect(all(panel.container, TESTID.insightsRefusal)).toHaveLength(1);
    expect(all(panel.container, TESTID.insightsRawOutput)).toStrictEqual([]);
    // Ruling 2026-09-22 (4): the refusal says so, in the refusal block.
    const note = one(panel.container, 'insights-raw-output-note');
    expect(note.textContent).toBe('No raw output for this run.');
    expect(note.closest(`[data-testid="${TESTID.insightsRefusal}"]`)).not.toBeNull();
    panel.store.showInsightsRawOutput();
    expect(intents(panel)).toStrictEqual([]);
    // Nor on a set that was not refused, whatever the flag says.
    send(providerState({ latest: 'ok', rawOutput: true }));
    expect(all(panel.container, TESTID.insightsRawOutput)).toStrictEqual([]);
  });

  it('a string and a number of evidence each render under their label', () => {
    const panel = render();
    send(providerState({ latest: 'mixed-evidence' }));
    send(viewControls({ surface: 'insights' }));
    expect(
      all(panel.container, TESTID.insightsEvidence).map((el) => el.textContent?.replace(/\s+/g, ' ').trim()),
    ).toStrictEqual([
      'Reads 7 sessions[0].loops[0].count · ses_example01',
      'File repo/docs/schema.md sessions[0].files[2].filePath · ses_example01',
      // DoD 9.59 — the raw number, its duration, and the key as stated.
      'Longest gap 28,100,113 ms · 7 h 48 m sessions[0].timing.longestGapMs · ses_example01',
      // Round 9b — the sum and the max render as the gap does; a cost is rounded.
      'Duration sum 90,500 ms · 1 m 30 s sessions[0].tools[0].durationMsSum · ses_example01',
      'Duration max 61,250 ms · 1 m 1 s sessions[0].tools[0].durationMsMax · ses_example01',
      'Cost 0.24 sessions[0].totals.costUsd · ses_example01',
    ]);
    // ...and the exact value is the rounded one's tooltip, and only its.
    const titles = all(panel.container, TESTID.insightsEvidence).map(
      (el) => el.querySelector('.strong')?.getAttribute('title') ?? null,
    );
    expect(titles).toStrictEqual([null, null, null, null, null, '0.238149']);
  });

  it('round 5b: an EMPTY detail shows no expand; a detail shows one', () => {
    const panel = render();
    send(providerState({ latest: 'mixed-evidence' }));
    send(viewControls({ surface: 'insights' }));
    const [only] = all(panel.container, TESTID.insightsFinding);
    expect(one(only as Element, 'insights-finding-lead').textContent).toBe('Lead of f-1');
    expect(all(only as Element, TESTID.insightsDetail)).toStrictEqual([]);
    expect((only as Element).querySelector('details')).toBeNull();
    // The control: the ok set's findings carry a detail, and show the expand.
    send(providerState({ latest: 'ok' }));
    expect(all(panel.container, TESTID.insightsDetail)).toHaveLength(2);
  });

  it('round 5b: "No longer reported" is ONE line, shown only when kinds are named', () => {
    const panel = render();
    send(providerState({ latest: 'mixed-evidence' }));
    send(viewControls({ surface: 'insights' }));
    expect(all(panel.container, 'insights-resolved-kinds').map((el) => el.textContent)).toStrictEqual([
      'No longer reported: Stall, Compaction',
    ]);
    send(providerState({ latest: 'ok' }));
    expect(all(panel.container, 'insights-resolved-kinds')).toStrictEqual([]);
  });

  it('the report list names each run’s date, findings count and engine, and a refused run’s state', () => {
    const panel = render();
    send(providerState());
    send(viewControls({ surface: 'insights' }));
    expect(
      all(panel.container, TESTID.insightsReportRow).map((el) => el.textContent?.replace(/\s+/g, ' ').trim()),
    ).toStrictEqual([
      '2026-09-21 10:00 UTC 2 findings · Claude Code',
      '2026-09-20 09:30 UTC refused · Codex',
    ]);
    expect(all(panel.container, TESTID.insightsReportRow).map((el) => el.getAttribute('data-state'))).toStrictEqual([
      'ok',
      'refused',
    ]);
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
    // DoD 9.44: no status stated, no status line.
    expect(all(panel.container, 'about-provider-status')).toStrictEqual([]);
  });

  it('DoD 9.44: the provider’s status is one line under its name on About, when it states one', () => {
    const panel = render();
    send(providerState({ status: 'licensed until 2027-09-23' }));
    send(viewControls({ surface: 'about' }));
    const status = one(panel.container, 'about-provider-status');
    expect(status.textContent).toBe('licensed until 2027-09-23');
    expect(status.previousElementSibling?.getAttribute('data-testid')).toBe(TESTID.aboutProvider);
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
    // The provider state's goldens are the four below (DoD 9.41); the one
    // that stood here until 9.40 was the `ok` state and is `-ok` now.
  });

  it('Insights with a provider, each of DoD 9.41’s four sets SELECTED (DoD 9.46)', () => {
    for (const latest of ['ok', 'empty', 'refused', 'mixed-evidence'] as const) {
      const panel = render();
      send(providerState({ latest }));
      send(viewControls({ surface: 'insights' }));
      golden(`insights-provider-${latest}`, one(panel.container, TESTID.insightsSurface));
      panel.dispose();
      mounted.pop();
    }
  });

  it('the ruling of 2026-09-26 (round 9): with a provider AND a read history, the tiles and the fact line below the list', () => {
    // The four goldens above render before the store is read, so they show
    // no tile; this one is the provider state with the history loaded.
    const panel = render();
    send({
      type: 'statsStore',
      records: [record('a', 1, { tools: [{ toolName: 'Bash', class: 'shell', calls: 3, errors: 1 }] })],
      enabled: true,
    });
    send(providerState({ latest: 'ok' }));
    send(viewControls({ surface: 'insights' }));
    golden('insights-provider-facts', one(panel.container, TESTID.insightsSurface));
  });

  it('9.55: Investigate Report PRESENT is one golden; ABSENT is the `ok` golden, byte for byte', () => {
    const present = render();
    send(providerState({ latest: 'ok', investigate: true }));
    send(viewControls({ surface: 'insights' }));
    golden('insights-provider-investigate', one(present.container, TESTID.insightsSurface));
    present.dispose();
    mounted.pop();

    // The harness's default is investigate: false, so every other provider
    // golden is the ABSENT case; this one says so for the `ok` set.
    const absent = render();
    send(providerState({ latest: 'ok', investigate: false }));
    send(viewControls({ surface: 'insights' }));
    expect(all(absent.container, TESTID.insightsInvestigate)).toStrictEqual([]);
    golden('insights-provider-ok', one(absent.container, TESTID.insightsSurface));
  });

  it('Insights with a provider, NOTHING selected, and with TICKS (DoD 9.46)', () => {
    const none = render();
    send(providerState({ selected: false, status: 'licensed until 2027-09-23' }));
    send(viewControls({ surface: 'insights' }));
    golden('insights-provider-none-selected', one(none.container, TESTID.insightsSurface));
    none.dispose();
    mounted.pop();

    const ticked = render();
    send(providerState({ latest: 'refused' }));
    send(viewControls({ surface: 'insights' }));
    for (const tick of all(ticked.container, TESTID.insightsReportTick)) click(tick);
    golden('insights-provider-ticks', one(ticked.container, TESTID.insightsSurface));
  });

  it('9.52: the SELECTED row clicked again posts its own id, and the host’s deselection renders the prompt', () => {
    /*
     * The toggle is the HOST's (it holds the selection); what the renderer
     * owes is to post the same run again rather than swallow a click on the
     * row it shows pressed, and to render "nothing selected" exactly as the
     * first-open state does. The golden is byte-compared to that one.
     */
    const status = 'licensed until 2027-09-23';
    const panel = render();
    send(providerState({ latest: 'ok', status }));
    send(viewControls({ surface: 'insights' }));
    const pressed = all(panel.container, TESTID.insightsReportSelect).filter(
      (b) => b.getAttribute('aria-pressed') === 'true',
    );
    expect(pressed).toHaveLength(1);
    const selectedRun = one(panel.container, TESTID.insightsPreview).getAttribute('data-run');
    expect(selectedRun).not.toBe('');
    click(pressed[0] as Element);
    expect(intents(panel)).toStrictEqual([{ type: 'insightsSelect', runId: selectedRun }]);
    send(providerState({ selected: false, status }));
    expect(one(panel.container, 'insights-preview-empty').textContent).toBe('Select a report to preview / download.');
    golden('insights-provider-deselected', one(panel.container, TESTID.insightsSurface));
    if (!UPDATING) {
      expect(readFileSync(resolve(GOLDEN_DIR, 'insights-provider-deselected.dom.txt'), 'utf8')).toBe(
        readFileSync(resolve(GOLDEN_DIR, 'insights-provider-none-selected.dom.txt'), 'utf8'),
      );
    }
  });

  it('the goldens are not being written by this run', () => {
    expect(UPDATING, 'AGENT_DECK_UPDATE_SURFACE_GOLDENS is set: the goldens were REWRITTEN').toBe(false);
  });
});
