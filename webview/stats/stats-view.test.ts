// @vitest-environment jsdom
//
// The Stats view mode, rendered — v0.7.0 Phase 4, DoD 4.3 / 4.4 / 4.5 / 4.6.
//
// Through the REAL app: `harness.start` mounts `App.svelte` from the shipped
// bundle, the records arrive as a `statsSnapshot` message the way the host
// sends one, and the Stats mode is entered through its own control. The
// records are the committed R8 goldens (`fixtures/golden/stats/*-synthetic-*`),
// so every value asserted below is the value the deriver produced for the
// shape the fixture manufactures — never a number this file made up.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionState, ToolNode, WebviewToHostMessage } from '../../src/model/events.js';
import type { StatsRecord } from '../../src/stats/schema.js';
import type { Store } from '../store.js';
import type { WebviewHarness } from '../testkit.js';
import { all, loadHarness, one, press } from '../testkit.js';
import { TESTID } from '../canvas-contract.js';
import { EM_DASH } from '../format.js';
import { liveSession } from '../testdata.js';
import { COST_SOURCE_LABELS } from './layout.js';

let harness: WebviewHarness;

beforeAll(async () => {
  harness = await loadHarness();
}, 60_000);

const GOLDEN_DIR = resolve('fixtures/golden/stats');

function golden(id: string, engine = 'cc'): StatsRecord {
  return JSON.parse(readFileSync(resolve(GOLDEN_DIR, `${engine}-synthetic-${id}.json`), 'utf8')) as StatsRecord;
}

/** The R8 states, so a session is on the deck beside its record. */
function fixtureState(id: string): SessionState {
  return (JSON.parse(readFileSync(resolve('fixtures/synthetic-stats', `${id}.json`), 'utf8')) as { state: SessionState }).state;
}

interface Panel {
  container: HTMLElement;
  store: Store;
  sent: WebviewToHostMessage[];
  dispose: () => void;
}

const mounted: Panel[] = [];

function render(): Panel {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const sent: WebviewToHostMessage[] = [];
  const started = harness.start(container, { postMessage: (m) => sent.push(m) });
  const panel: Panel = {
    container,
    store: started.store,
    sent,
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
  harness.flushSync(() => {
    press(element);
  });
}

function tab(panel: Panel, view: string): void {
  const button = all(panel.container, TESTID.statsTab).find((t) => t.dataset['view'] === view);
  if (button === undefined) throw new Error(`no ${view} tab`);
  click(button);
}

/** Mount, feed the states and records, enter the Stats mode. */
function statsPanel(ids: string[], options: { engineOf?: (id: string) => string } = {}): Panel {
  const panel = render();
  const engineOf = options.engineOf ?? ((): string => 'cc');
  send({ type: 'snapshot', sessions: ids.map((id) => fixtureState(id)) });
  send({ type: 'statsSnapshot', records: ids.map((id) => golden(id, engineOf(id))) });
  click(one(panel.container, TESTID.statsToggle));
  return panel;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

/* ------------------------------------------------------------------------ *
 * The mode itself
 * ------------------------------------------------------------------------ */

describe('the third view mode', () => {
  it('its own control enters and leaves it; the canvas/list toggle is not shown inside it', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    expect(one(panel.container, 'app').dataset['viewMode']).toBe('canvas');
    click(one(panel.container, TESTID.statsToggle));
    expect(one(panel.container, 'app').dataset['viewMode']).toBe('stats');
    one(panel.container, TESTID.statsView);
    expect(all(panel.container, TESTID.deck)).toHaveLength(0);
    expect(all(panel.container, TESTID.viewToggle)).toHaveLength(0);
    expect(one(panel.container, TESTID.statsToggle).getAttribute('aria-pressed')).toBe('true');
    click(one(panel.container, TESTID.statsToggle));
    expect(one(panel.container, 'app').dataset['viewMode']).toBe('canvas');
    expect(all(panel.container, TESTID.statsView)).toHaveLength(0);
    // Webview-local: nothing about the mode reached the host.
    expect(panel.sent).toStrictEqual([]);
  });

  it('a showView message from the host lands in the mode', () => {
    const panel = render();
    send({ type: 'showView', mode: 'stats' });
    expect(one(panel.container, 'app').dataset['viewMode']).toBe('stats');
    one(panel.container, TESTID.statsView);
  });

  it('Escape does nothing in the Stats mode', () => {
    const panel = statsPanel(['01-reread-loop']);
    harness.flushSync(() => {
      globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(one(panel.container, 'app').dataset['viewMode']).toBe('stats');
  });

  it('has four tabs in the spec\'s order and the empty states say so when nothing is there', () => {
    const panel = render();
    click(one(panel.container, TESTID.statsToggle));
    expect(all(panel.container, TESTID.statsTab).map((t) => t.dataset['view'])).toStrictEqual([
      'files',
      'loops',
      'tokens',
      'trends',
    ]);
    for (const view of ['files', 'loops', 'tokens', 'trends']) {
      tab(panel, view);
      expect(one(panel.container, TESTID.statsEmpty).dataset['view']).toBe(view);
    }
    expect(one(panel.container, TESTID.statsFooter).textContent).toContain('no session excluded');
    expect(one(panel.container, TESTID.statsParams).textContent).toContain('no record yet');
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 4.3 — the views, from the goldens
 * ------------------------------------------------------------------------ */

describe('DoD 4.3 — Files (01)', () => {
  it('a row per file with the four counts, basename primary and the path on hover, flagged for the loop', () => {
    const panel = statsPanel(['01-reread-loop']);
    tab(panel, 'files');
    const rows = all(panel.container, TESTID.statsFileRow);
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    expect(row.dataset['path']).toBe('/synthetic/a.ts');
    expect(row.dataset['loop']).toBe('true');
    expect(row.dataset['churn']).toBe('false');
    const name = one(row, TESTID.statsFileName);
    expect(name.textContent).toBe('a.ts');
    expect(name.title).toBe('/synthetic/a.ts');
    const cells = [...row.querySelectorAll('td.num')].map((c) => c.textContent);
    expect(cells).toStrictEqual(['3', '0', '0', '0', '1']);
    expect(row.textContent).toContain('re-read loop');
  });
});

describe('DoD 4.3 — Loops & churn (01, 02)', () => {
  it('lists the loop with its term and count; expanding shows every ordinal as a button', () => {
    const panel = statsPanel(['01-reread-loop']);
    tab(panel, 'loops');
    const rows = all(panel.container, TESTID.statsChainRow);
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    expect(row.dataset['kind']).toBe('loop');
    expect(row.textContent).toContain('re-read loop');
    expect(row.textContent).toContain('3 identical calls');
    expect(all(row, TESTID.statsChainOrdinal)).toHaveLength(0);
    click(row.querySelector('button.head') as Element);
    expect(row.dataset['expanded']).toBe('true');
    expect(all(row, TESTID.statsChainOrdinal).map((o) => o.dataset['ordinal'])).toStrictEqual(['0', '1', '2']);
  });

  it('a churn chain carries its file and every ordinal between the two writes', () => {
    const panel = statsPanel(['02-churn-chain']);
    tab(panel, 'loops');
    const churn = all(panel.container, TESTID.statsChainRow).find((r) => r.dataset['kind'] === 'churn');
    expect(churn).toBeDefined();
    expect(churn?.textContent).toContain('churn chain');
    click(churn?.querySelector('button.head') as Element);
    const ordinals = all(churn as HTMLElement, TESTID.statsChainOrdinal).map((o) => Number(o.dataset['ordinal']));
    expect(ordinals.length).toBeGreaterThanOrEqual(3);
    expect(ordinals).toStrictEqual([...ordinals].sort((a, b) => a - b));
  });
});

describe('DoD 4.3 — Tokens (03, 08, 09, 10, 11, 12, 13)', () => {
  it('03: the silent subagent is flagged, and no agent row carries its id as primary text', () => {
    const panel = statsPanel(['03-silent-subagent']);
    tab(panel, 'tokens');
    const rows = all(panel.container, TESTID.statsAgentRow);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.dataset['silent'] === 'true')).toHaveLength(1);
    for (const row of rows) {
      const primary = one(row, TESTID.statsAgentPrimary).textContent ?? '';
      expect(primary).not.toBe(row.dataset['agent']);
      expect(['main', 'subagent d1']).toContain(primary);
    }
    expect(rows.find((r) => r.dataset['silent'] === 'true')?.textContent).toContain('silent subagent');
  });

  it('08: the context fill is shown where the engine stated the window; 01 shows an em dash', () => {
    const codex = statsPanel(['08-codex-window'], { engineOf: () => 'codex' });
    tab(codex, 'tokens');
    expect(one(codex.container, TESTID.statsContextFill).textContent).toBe('25.0%');
    codex.dispose();
    mounted.pop();

    const cc = statsPanel(['01-reread-loop']);
    tab(cc, 'tokens');
    expect(one(cc.container, TESTID.statsContextFill).textContent).toBe(EM_DASH);
    // ...and its cost too: nothing computed one.
    expect(one(cc.container, TESTID.statsCost).textContent).toBe(EM_DASH);
    expect(one(cc.container, TESTID.statsCostSource).textContent).toBe('not computed');
  });

  it('09: the engine\'s own cost, with the engine label', () => {
    const panel = statsPanel(['09-opencode-cost'], { engineOf: () => 'opencode' });
    tab(panel, 'tokens');
    expect(one(panel.container, TESTID.statsCost).textContent).toBe('0.4237 USD');
    expect(one(panel.container, TESTID.statsCost).dataset['source']).toBe('engine');
    expect(one(panel.container, TESTID.statsCostSource).textContent).toBe(COST_SOURCE_LABELS.engine);
  });

  it('10: one compaction marker on the per-turn strip, naming the trigger', () => {
    const panel = statsPanel(['10-compaction']);
    tab(panel, 'tokens');
    const strip = one(panel.container, TESTID.statsTurnStrip);
    expect(strip.dataset['markers']).toBe('1');
    const markers = all(panel.container, TESTID.statsTurnMarker);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.dataset['kind']).toBe('compaction');
    expect(markers[0]?.querySelector('title')?.textContent).toContain('compaction');
  });

  it('11: the user-priced cost with its label, and the model id listed and copyable', () => {
    const panel = statsPanel(['11-user-priced']);
    tab(panel, 'tokens');
    expect(one(panel.container, TESTID.statsCost).textContent).toBe('22.0500 USD');
    expect(one(panel.container, TESTID.statsCostSource).textContent).toBe('estimated from your prices');
    expect(one(panel.container, TESTID.statsModelId).textContent).toBe('synthetic-model-a');

    const written: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } },
    });
    const copy = one(panel.container, TESTID.statsModelCopy);
    expect(copy.dataset['model']).toBe('synthetic-model-a');
    click(copy);
    expect(written).toStrictEqual(['synthetic-model-a']);
    expect(one(panel.container, TESTID.statsModelCopy).dataset['copied']).toBe('true');
  });

  it('12: the stall is listed with its tool, its ordinal and the silence measured', () => {
    const panel = statsPanel(['12-stall']);
    tab(panel, 'tokens');
    const rows = all(panel.container, TESTID.statsStallRow);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('stall');
    expect(rows[0]?.textContent).toContain('of silence');
  });

  it('13: Component 12\'s one rendering — a telemetry cost labelled "estimated by Claude Code"', () => {
    const panel = statsPanel(['13-telemetry-cost']);
    tab(panel, 'tokens');
    expect(one(panel.container, TESTID.statsCost).dataset['source']).toBe('telemetry');
    expect(one(panel.container, TESTID.statsCostSource).textContent).toBe('estimated by Claude Code');
  });

  it('shows the measurement parameters as parameters', () => {
    const panel = statsPanel(['01-reread-loop']);
    const params = one(panel.container, TESTID.statsParams).textContent ?? '';
    expect(params).toContain('LOOP_MIN = 3');
    expect(params).toContain('SPIKE_TOKENS = 5000');
  });
});

describe('DoD 4.3 — Trends', () => {
  it('says LOADING until the store has been read — it does not claim an empty history (DoD 4.12)', () => {
    /*
     * THIS TEST USED TO ASSERT `fewer-than-two` HERE, AND THAT WAS THE DEFECT.
     * `statsPanel` sends a `statsSnapshot` and no `statsStore`, which is exactly
     * the state the panel is in while the host reads the file — and over the
     * 4.9 smoke's 102 MB store that lasted long enough to see. The view
     * answered "fewer than two sessions are recorded", which is a statement
     * about a history it had not looked at yet.
     */
    const panel = statsPanel(['01-reread-loop']);
    tab(panel, 'trends');
    const empty = one(panel.container, TESTID.statsEmpty);
    expect(empty.dataset['reason']).toBe('loading');
    expect(empty.textContent).toContain('Reading the stored history');
  });

  it('is empty below two stored records once the read HAS resolved, and says why', () => {
    const panel = render();
    send({ type: 'statsStore', records: [golden('01-reread-loop')], enabled: true });
    click(one(panel.container, TESTID.statsToggle));
    tab(panel, 'trends');
    expect(one(panel.container, TESTID.statsEmpty).dataset['reason']).toBe('fewer-than-two');
  });

  it('a slow store resolves into a history, and never renders a partial one (DoD 4.12)', () => {
    // The "slow store stub" is the host's own message arriving late, which is
    // the only way the webview can experience a slow read: one message, whole.
    const panel = render();
    send({ type: 'snapshot', sessions: [] });
    send({ type: 'statsSnapshot', records: [golden('01-reread-loop')] });
    click(one(panel.container, TESTID.statsToggle));
    tab(panel, 'trends');
    expect(one(panel.container, TESTID.statsEmpty).dataset['reason']).toBe('loading');
    // ...then the read lands, with all three engines in it.
    send({
      type: 'statsStore',
      records: [
        golden('01-reread-loop'),
        golden('09-opencode-cost', 'opencode'),
        golden('08-codex-window', 'codex'),
      ],
      enabled: true,
    });
    harness.flushSync();
    expect(all(panel.container, TESTID.statsEmpty)).toHaveLength(0);
    const lines = all(panel.container, TESTID.statsTrendLine).filter(
      (l) => l.dataset['series'] === 'prompt',
    );
    expect(lines.map((l) => l.dataset['engine'])).toStrictEqual(['cc', 'codex', 'opencode']);
  });

  it('is empty when the store is off, and says that instead', () => {
    const panel = render();
    send({ type: 'statsStore', records: [golden('01-reread-loop'), golden('02-churn-chain')], enabled: false });
    click(one(panel.container, TESTID.statsToggle));
    tab(panel, 'trends');
    expect(one(panel.container, TESTID.statsEmpty).dataset['reason']).toBe('disabled');
    expect(one(panel.container, TESTID.statsEmpty).textContent).toContain('agentDeck.stats.enabled');
  });

  it('draws one point per stored session, in order, on each series; cost only where the engine reported it', () => {
    const panel = render();
    send({
      type: 'statsStore',
      records: [golden('01-reread-loop'), golden('09-opencode-cost', 'opencode'), golden('02-churn-chain')],
      enabled: true,
    });
    click(one(panel.container, TESTID.statsToggle));
    tab(panel, 'trends');
    const series = all(panel.container, TESTID.statsTrendSeries);
    expect(series.map((s) => s.dataset['series'])).toStrictEqual(['prompt', 'loops', 'cost']);
    // ONE LINE PER ENGINE (DoD 4.12), so the points group by engine and keep
    // their GLOBAL session index — the two Claude Code sessions are 0 and 2 and
    // the OpenCode one between them is 1. Before the ruling all three shared a
    // line and a maximum, and the largest silenced the rest.
    const promptLines = all(series[0] as HTMLElement, TESTID.statsTrendLine);
    expect(promptLines.map((l) => l.dataset['engine'])).toStrictEqual(['cc', 'opencode']);
    const ccPoints = all(promptLines[0] as HTMLElement, TESTID.statsTrendPoint);
    expect(ccPoints.map((p) => p.dataset['index'])).toStrictEqual(['0', '2']);
    expect(ccPoints.map((p) => p.dataset['session'])).toStrictEqual([
      'synthetic-01-reread-loop',
      'synthetic-02-churn-chain',
    ]);
    const ocPoints = all(promptLines[1] as HTMLElement, TESTID.statsTrendPoint);
    expect(ocPoints.map((p) => p.dataset['index'])).toStrictEqual(['1']);
    expect(ocPoints.map((p) => p.dataset['session'])).toStrictEqual(['synthetic-09-opencode-cost']);

    // Cost is reported by ONE engine here, so it draws one line and no other.
    const costLines = all(series[2] as HTMLElement, TESTID.statsTrendLine);
    expect(costLines.map((l) => l.dataset['engine'])).toStrictEqual(['opencode']);
    const cost = all(costLines[0] as HTMLElement, TESTID.statsTrendPoint);
    expect(cost.map((p) => p.dataset['session'])).toStrictEqual(['synthetic-09-opencode-cost']);
    expect(cost[0]?.dataset['y']).toBe('0.4237');
  });
});

/* ------------------------------------------------------------------------ *
 * The footer: excluded sessions, and only there
 * ------------------------------------------------------------------------ */

describe('excluded sessions (05)', () => {
  it('appear in the footer with the reason code, and in no table', () => {
    const panel = statsPanel(['05-excluded-parked', '01-reread-loop']);
    const footer = one(panel.container, TESTID.statsFooter);
    expect(footer.dataset['excluded']).toBe('1');
    expect(footer.textContent).toContain('1 session excluded: parked 1');
    for (const view of ['files', 'loops', 'tokens']) {
      tab(panel, view);
      expect(panel.container.textContent).not.toContain('synthetic-05-excluded-parked');
    }
    tab(panel, 'tokens');
    expect(all(panel.container, TESTID.statsSession)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 4.4 — link-back
 * ------------------------------------------------------------------------ */

describe('DoD 4.4 — clicking a chain ordinal selects the tool node through the existing intent', () => {
  it('opens the inspector on the tool the ordinal names, and posts selectSession', () => {
    const state = liveSession();
    const tools = state.root.children.filter((c): c is ToolNode => !('children' in c));
    tools.forEach((t, i) => {
      t.ordinal = i;
    });
    const record: StatsRecord = {
      ...golden('01-reread-loop'),
      sessionId: state.sessionId,
      loops: [{ agentId: 'root', toolName: 'Read', class: 'read', count: 3, ordinals: [0, 1] }],
      files: [],
    };
    const panel = render();
    send({ type: 'snapshot', sessions: [state] });
    send({ type: 'statsSnapshot', records: [record] });
    click(one(panel.container, TESTID.statsToggle));
    tab(panel, 'loops');
    click(one(panel.container, TESTID.statsChainRow).querySelector('button.head') as Element);
    const ordinal = all(panel.container, TESTID.statsChainOrdinal).find((o) => o.dataset['ordinal'] === '1');
    expect(ordinal).toBeDefined();
    panel.sent.length = 0;
    click(ordinal as Element);

    const view = panel.store.getView();
    expect(view.viewMode).toBe('canvas');
    expect(view.selectedNodeId).toBe('tool-agent-1');
    expect(view.altitude).toBe('inspector');
    expect(one(panel.container, TESTID.inspector).dataset['nodeId']).toBe('tool-agent-1');
    expect(panel.sent).toStrictEqual([{ type: 'selectSession', sessionId: 'session-live' }]);
  });

  it('a stored record whose session is gone says so rather than pretending', () => {
    const panel = statsPanel(['01-reread-loop']);
    // The session leaves the deck; the record is still on screen.
    send({ type: 'snapshot', sessions: [] });
    tab(panel, 'loops');
    const row = one(panel.container, TESTID.statsChainRow);
    click(row.querySelector('button.head') as Element);
    click(all(row, TESTID.statsChainOrdinal)[0] as Element);
    expect(one(panel.container, TESTID.statsChainRow).dataset['unresolved']).toBe('true');
    expect(one(panel.container, 'app').dataset['viewMode']).toBe('stats');
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 4.5 — labels law
 * ------------------------------------------------------------------------ */

describe('DoD 4.5 — labels law', () => {
  const ids = ['01-reread-loop', '03-silent-subagent', '11-user-priced'];

  it('no session id, agent id or hash is ever primary text; basename primary, path on hover', () => {
    const panel = statsPanel(ids);
    const idish = /^[0-9a-f]{8,}$|^synthetic-\d\d-|^root$|^agent-/u;
    tab(panel, 'tokens');
    for (const primary of all(panel.container, TESTID.statsSessionPrimary)) {
      expect(primary.textContent ?? '').not.toMatch(idish);
      expect(primary.textContent?.trim()).not.toBe('');
    }
    for (const primary of all(panel.container, TESTID.statsAgentPrimary)) {
      expect(primary.textContent ?? '').not.toMatch(idish);
    }
    tab(panel, 'files');
    for (const name of all(panel.container, TESTID.statsFileName)) {
      expect(name.textContent).not.toContain('/');
      expect(name.title).toContain('/');
    }
  });

  it('a live session\'s label is the primary text, not its engine and time', () => {
    const state = liveSession();
    const record = { ...golden('01-reread-loop'), sessionId: state.sessionId };
    const panel = render();
    send({ type: 'snapshot', sessions: [state] });
    send({ type: 'statsSnapshot', records: [record] });
    click(one(panel.container, TESTID.statsToggle));
    tab(panel, 'tokens');
    expect(one(panel.container, TESTID.statsSessionPrimary).textContent).toBe('main session');
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 4.6 — engine chips
 * ------------------------------------------------------------------------ */

describe('DoD 4.6 — the engine chips narrow every stats view', () => {
  const ids = ['01-reread-loop', '08-codex-window', '09-opencode-cost'];
  const engineOf = (id: string): string =>
    id.startsWith('08') ? 'codex' : id.startsWith('09') ? 'opencode' : 'cc';

  it('shows the four chips with counts, and the same filter state the deck holds', () => {
    const panel = statsPanel(ids, { engineOf });
    const chips = all(panel.container, TESTID.statsEngineChip);
    expect(chips.map((c) => c.dataset['engine'])).toStrictEqual(['all', 'cc', 'oc', 'cx']);
    expect(chips.map((c) => c.dataset['count'])).toStrictEqual(['3', '1', '1', '1']);
    expect(one(panel.container, TESTID.statsView).dataset['engineFilter']).toBe('all');
  });

  it('a chip narrows Files, Loops, Tokens and Trends to that engine — and the deck agrees', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: ids.map((id) => fixtureState(id)) });
    const records = ids.map((id) => golden(id, engineOf(id)));
    send({ type: 'statsSnapshot', records });
    send({ type: 'statsStore', records, enabled: true });
    click(one(panel.container, TESTID.statsToggle));

    tab(panel, 'tokens');
    expect(all(panel.container, TESTID.statsSession)).toHaveLength(3);
    const oc = all(panel.container, TESTID.statsEngineChip).find((c) => c.dataset['engine'] === 'oc');
    click(oc as Element);
    expect(one(panel.container, TESTID.statsView).dataset['engineFilter']).toBe('oc');
    expect(all(panel.container, TESTID.statsSession).map((s) => s.dataset['engine'])).toStrictEqual(['opencode']);
    tab(panel, 'files');
    // Only 09 has a file row among the three.
    expect(all(panel.container, TESTID.statsFileRow)).toHaveLength(1);
    tab(panel, 'trends');
    expect(one(panel.container, TESTID.statsEmpty).dataset['reason']).toBe('fewer-than-two');
    // The SAME store state the deck reads: leave the mode and the deck's chip is pressed.
    expect(panel.store.getView().engineFilter).toBe('oc');
    click(one(panel.container, TESTID.statsToggle));
    const deckChip = all(panel.container, 'deck-engine-chip').find((c) => c.dataset['engine'] === 'oc');
    expect(deckChip?.dataset['active']).toBe('true');
  });
});
