// @vitest-environment jsdom
//
// The Stats view mode, rendered — v0.7.0 Phase 4, DoD 4.3 / 4.4 / 4.5 / 4.6.
//
// Through the REAL app: `harness.start` mounts `App.svelte` from the shipped
// bundle, the records arrive as a `statsSnapshot` message the way the host
// sends one, and the Stats mode is entered through its own control. The
// records are the R8 fixtures' own derived records, so every value asserted
// below is the value the deriver produced for the shape the fixture
// manufactures — never a number this file made up.
//
// ## Where the v0.8.0 records come from, and why not from `src/stats/`'s testkits
//
// `STATS_SCHEMA_VERSION` moved to 2 (DoD 7.1) and the committed goldens are
// regenerated ONCE, at the end of the phase, so every file under
// `fixtures/golden/stats/` still carries a version-1 record with no `timing`
// block and no `resultUnreceived` flag. The v0.7.x tests below keep reading
// them — the webview runs no validator, so they arrive exactly as they did —
// and the v0.8.0 tests derive their own records instead.
//
// `corpus.stats.testkit.ts` and `synthetic.testkit.ts` are the obvious source
// and CANNOT BE IMPORTED HERE. Measured: both resolve `fixtures/` with
// `fileURLToPath(new URL('…', import.meta.url))`, and under vitest's jsdom
// environment `import.meta.url` is not a `file:` URL — the import fails at
// module scope with `TypeError: The URL must be of scheme file` and the whole
// suite reports as `no tests`, which is this repository's recorded
// "fails to COLLECT, reads green" class. So the two things this file needs
// beyond the committed records are built here with `resolve()` against the
// working directory, the way `capture.test.ts` and `fixture-render.test.ts`
// already read fixtures under jsdom:
//
//   - `deriveStats` over the committed R8 SessionStates, which is what makes
//     F15 reachable (`resultUnreceived`, `totals.subagentsUnreceived`);
//   - ONE harvested Claude Code session read through `parseLines` and
//     `SessionModel`, which is the only source in the tree of F14 instants —
//     see {@link harvested}.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionState, ToolNode, WebviewToHostMessage } from '../../src/model/events.js';
import { LivenessEngine } from '../../src/model/liveness.js';
import { SessionModel } from '../../src/model/session.js';
import { parseLines, parseSubagentMeta } from '../../src/parser/parse.js';
import { deriveStats } from '../../src/stats/derive.js';
import type { StatsRecord } from '../../src/stats/schema.js';
import type { Store } from '../store.js';
import type { WebviewHarness } from '../testkit.js';
import { all, loadHarness, one, press } from '../testkit.js';
import { TESTID } from '../canvas-contract.js';
import { EM_DASH } from '../format.js';
import { liveSession } from '../testdata.js';
import { COST_SOURCE_LABELS, VOCABULARY } from './layout.js';

let harness: WebviewHarness;

beforeAll(async () => {
  harness = await loadHarness();
}, 60_000);

const GOLDEN_DIR = resolve('fixtures/golden/stats');

/**
 * The clock every stats golden is derived under (`corpus.stats.testkit.ts`'s
 * `FIXED_NOW_MS`), restated because that module cannot be imported here. It
 * decides F13 alone — no session is live and no tool is stalled under it — so
 * nothing this file asserts moves with it.
 */
const FIXED_NOW_MS = 1_700_000_000_000;

function golden(id: string, engine = 'cc'): StatsRecord {
  return JSON.parse(readFileSync(resolve(GOLDEN_DIR, `${engine}-synthetic-${id}.json`), 'utf8')) as StatsRecord;
}

/** The R8 states, so a session is on the deck beside its record. */
function fixtureState(id: string): SessionState {
  return (JSON.parse(readFileSync(resolve('fixtures/synthetic-stats', `${id}.json`), 'utf8')) as { state: SessionState }).state;
}

/**
 * An R8 fixture's record AS v0.8.0's deriver produces it.
 *
 * The committed state is the input either way; this is one step earlier in the
 * same production path, so the record carries `timing` and F15 while the file
 * on disk still does not.
 */
function derived(id: string): StatsRecord {
  return deriveStats(fixtureState(id), { now: FIXED_NOW_MS });
}

/* ------------------------------------------------------------------------ *
 * One HARVESTED session, for the facts no manufactured fixture states
 * ------------------------------------------------------------------------ */

/**
 * F14 IS ABSENT ON EVERY R8 FIXTURE, and that is a property of the builder
 * rather than an oversight: `synthetic.testkit.ts`'s `tool()` sets `durationMs`
 * and never `startedAtMs`/`endedAtMs`, and its `turn()` sets no `atMs`, so
 * `deriveTiming` returns an empty block for all of them. The test below asserts
 * that over the whole committed set rather than taking it on trust.
 *
 * So the PRESENT arm of DoD 7.3 has to come from a session a real engine
 * timestamped, and the only such thing in the tree is a captured transcript:
 * every Claude Code entry carries an envelope `timestamp`, which DoD 7.1's
 * parse boundary turns into `ToolNode.startedAtMs`/`endedAtMs` and
 * `UsageTurn.atMs`. The committed `fixtures/golden/session/*.json` snapshots
 * predate that field and carry none.
 *
 * WHAT IS DUPLICATED HERE, AND WHY. The twenty lines below are
 * `corpus.stats.testkit.ts`'s Claude Code reader narrowed to one session —
 * `SessionModel`, never the graft snapshot, which is the distinction that
 * file's header exists to state. It is copied rather than imported because
 * that module cannot load under jsdom at all (see the file header). What is
 * NOT re-implemented is anything that decides a value: `parseLines`,
 * `SessionModel` and `deriveStats` are the production units, and the session
 * chosen is the anchor corpus's own, the same one
 * `fixtures/golden/stats/cc-2.1.246-07e6c820-….json` was derived from.
 */
const HARVESTED_SLUG = 'c--Users-dev-projects-agent-deck';

/** The anchor corpus's own session: six tools, every call timestamped. */
const ANCHOR_SESSION_ID = '07e6c820-b285-4ea8-8127-98ea762291d9';

/**
 * The one committed session captured MID-SPAWN — `src/stats/f15.test.ts`
 * pins it as the corpus's own positive arm for F15: its `Agent` block has no
 * `tool_result` in the parent transcript, so exactly one subagent reads
 * `resultUnreceived`. A real capture, not a manufactured shape.
 */
const ABORTED_SPAWN_SESSION_ID = '99f96635-2042-41dc-9000-bbc9f9233bc3';

function readHarvested(corpus: string, sessionId: string): SessionState {
  const slugDir = resolve(`fixtures/${corpus}/projects`, HARVESTED_SLUG);
  const model = new SessionModel({
    workspacePath: HARVESTED_SLUG.replace(/^([a-zA-Z])--/u, '$1:\\').replace(/-/gu, '\\'),
    liveness: new LivenessEngine({ now: () => FIXED_NOW_MS }),
  });
  model.registerSession({ sessionId, projectSlug: HARVESTED_SLUG });

  const mainPath = join(slugDir, `${sessionId}.jsonl`);
  const main = parseLines(readFileSync(mainPath, 'utf8').split('\n').filter((l) => l.length > 0));
  if (!main.ok) throw new Error(`${sessionId} no longer parses: ${JSON.stringify(main.mismatch)}`);
  model.ingestTranscript(sessionId, HARVESTED_SLUG, {
    kind: 'main',
    path: mainPath,
    entries: main.value.entries,
  });

  const subagentDir = join(slugDir, sessionId, 'subagents');
  if (existsSync(subagentDir)) {
    for (const entry of readdirSync(subagentDir).sort()) {
      if (!entry.startsWith('agent-') || !entry.endsWith('.jsonl')) continue;
      const agentId = entry.slice('agent-'.length, -'.jsonl'.length);
      const jsonlPath = join(subagentDir, entry);
      const parsed = parseLines(readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.length > 0));
      if (!parsed.ok) continue;
      model.ingestTranscript(sessionId, HARVESTED_SLUG, {
        kind: 'subagent',
        path: jsonlPath,
        agentId,
        entries: parsed.value.entries,
      });
      const metaPath = join(subagentDir, `agent-${agentId}.meta.json`);
      if (!existsSync(metaPath)) continue;
      const meta = parseSubagentMeta(readFileSync(metaPath, 'utf8'), metaPath);
      model.ingestSidecar(sessionId, HARVESTED_SLUG, {
        agentId,
        metaPath,
        ...(meta.ok ? { meta: meta.value } : { metaFailure: 'unparsed' as const }),
      });
    }
  }

  const state = model.sessionState(sessionId);
  if (state === undefined) throw new Error(`no state assembled for ${sessionId}`);
  return state;
}

/** The anchor session's record: F14 present, both duration columns present. */
let harvested: StatsRecord;

/** The mid-spawn session's record: F15's one harvested positive arm. */
let abortedSpawn: StatsRecord;

beforeAll(() => {
  harvested = deriveStats(readHarvested('cc-2.1.246', ANCHOR_SESSION_ID), { now: FIXED_NOW_MS });
  abortedSpawn = deriveStats(readHarvested('cc-2.1.260', ABORTED_SPAWN_SESSION_ID), {
    now: FIXED_NOW_MS,
  });
}, 60_000);

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

/**
 * The y a Trends marker is drawn at, read off its path (DoD 4.13).
 *
 * A marker is `M <x> <y> h 0` — a zero-length segment drawn by its round cap —
 * so the second number IS the point's position inside its line's box.
 */
function markerY(marker: Element | null): string | undefined {
  const parts = (marker?.getAttribute('d') ?? '').trim().split(/\s+/);
  return parts[0] === 'M' ? parts[2] : undefined;
}

/**
 * Every SVG attribute under `root`'s charts that could not be drawn (DoD 4.13).
 *
 * Two classes: a NaN or an Infinity anywhere in an attribute value, and a
 * viewBox that is not four finite numbers with a POSITIVE width and height —
 * a zero-height viewBox disables rendering outright, which is what an
 * unguarded zero maximum produces rather than a NaN.
 */
function undrawable(root: ParentNode): string[] {
  const out: string[] = [];
  for (const svg of root.querySelectorAll('svg')) {
    for (const el of [svg, ...svg.querySelectorAll('*')]) {
      for (const attr of el.attributes) {
        if (/NaN|Infinity/.test(attr.value)) out.push(`<${el.tagName} ${attr.name}="${attr.value}">`);
      }
    }
    const box = (svg.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number);
    const [, , width, height] = box;
    if (
      box.length !== 4 ||
      box.some((n) => !Number.isFinite(n)) ||
      (width ?? 0) <= 0 ||
      (height ?? 0) <= 0
    ) {
      out.push(`<svg viewBox="${String(svg.getAttribute('viewBox'))}">`);
    }
  }
  return out;
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

  it('has five tabs in the spec\'s order and the empty states say so when nothing is there', () => {
    const panel = render();
    click(one(panel.container, TESTID.statsToggle));
    expect(all(panel.container, TESTID.statsTab).map((t) => t.dataset['view'])).toStrictEqual([
      'files',
      'tools',
      'loops',
      'tokens',
      'trends',
    ]);
    for (const view of ['files', 'tools', 'loops', 'tokens', 'trends']) {
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

  it("each engine's line is scaled by its OWN maximum, in the DOM (DoD 4.12)", () => {
    /*
     * THE MUTATION THIS KILLS, and it is the fourth time this repository has
     * shipped the shape: `phase-verifier` replaced `Trends.svelte`'s
     * `scaleOf(line)` with a single shared constant — the exact user-visible
     * defect 4.12 exists to fix — and 918 tests stayed green. `layout.test.ts`
     * pins the per-engine `max`, and nothing pinned the COMPONENT'S USE of it:
     * no test read an SVG `viewBox` or a circle's `cy` anywhere in `webview/`,
     * and `data-y` is the layout's raw number, which a shared scale does not
     * touch.
     *
     * So this asserts the transform: the box a line is drawn in, and where a
     * point sits inside it. Magnitudes an order apart, so a shared scale cannot
     * coincide with a per-engine one.
     */
    const panel = render();
    const cc = golden('01-reread-loop');
    const codex = golden('08-codex-window', 'codex');
    send({
      type: 'statsStore',
      records: [
        { ...cc, sessionId: 'big-cc', totals: { ...cc.totals, prompt: 100_000_000 } },
        { ...codex, sessionId: 'small-codex', totals: { ...codex.totals, prompt: 20_000 } },
      ],
      enabled: true,
    });
    click(one(panel.container, TESTID.statsToggle));
    tab(panel, 'trends');

    const lines = all(panel.container, TESTID.statsTrendLine).filter(
      (l) => l.dataset['series'] === 'prompt',
    );
    expect(lines.map((l) => l.dataset['engine'])).toStrictEqual(['cc', 'codex']);

    // The viewBox height IS the line's own maximum...
    const heightOf = (el: HTMLElement): string =>
      (el.querySelector('svg')?.getAttribute('viewBox') ?? '').split(' ')[3] ?? '';
    expect(heightOf(lines[0] as HTMLElement)).toBe('100000000');
    expect(heightOf(lines[1] as HTMLElement)).toBe('20000');

    // ...and each point sits at the TOP of its own box, because each is its own
    // maximum. Under one shared scale the Codex point's y would be 99,980,000
    // of a 100,000,000 box — the baseline, which is what the user saw. (A
    // marker is a zero-length path since DoD 4.13, so its y is read from `d`;
    // it was a circle's `cy` until the circles turned out to be the arcs.)
    for (const line of lines) {
      const marker = line.querySelector(`[data-testid="${TESTID.statsTrendPoint}"]`);
      expect(markerY(marker), line.dataset['engine']).toBe('0');
    }
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
    // FOUR from v0.8.0 Phase 7 (DoD 7.3): `tokensPerMin` joined. These three
    // records state no span, so its series carries no line — which is the
    // shape the next assertion but one pins.
    expect(series.map((s) => s.dataset['series'])).toStrictEqual([
      'prompt',
      'loops',
      'cost',
      'tokensPerMin',
    ]);
    expect(all(series[3] as HTMLElement, TESTID.statsTrendLine)).toHaveLength(0);
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

/* ------------------------------------------------------------------------ *
 * DoD 4.13 — a zero maximum, and the markers that drew the arcs
 * ------------------------------------------------------------------------ */

describe('DoD 4.13: a Trends line never draws a picture of its own stand-in scale', () => {
  /** Open Trends over `records`, through the real app. */
  function trendsOver(records: StatsRecord[]): Panel {
    const panel = render();
    send({ type: 'statsStore', records, enabled: true });
    click(one(panel.container, TESTID.statsToggle));
    tab(panel, 'trends');
    return panel;
  }

  function lineOf(panel: Panel, series: string, engine: string): HTMLElement {
    const line = all(panel.container, TESTID.statsTrendLine).find(
      (l) => l.dataset['series'] === series && l.dataset['engine'] === engine,
    );
    if (line === undefined) throw new Error(`no ${series}/${engine} line`);
    return line;
  }

  it('a zero-maximum line is a flat baseline labelled "max 0", with no path and no markers', () => {
    // Two Claude Code sessions with no loop between them — the shape 33 of the
    // 36 committed stats records have, which is why the smoke found it at once.
    const panel = trendsOver([golden('02-churn-chain'), golden('03-silent-subagent')]);
    const loops = lineOf(panel, 'loops', 'cc');

    const baseline = one(loops, TESTID.statsTrendBaseline);
    // THE BASELINE IS ITSELF A MARK IN THE STRETCHED BOX, so it needs the same
    // guard the markers do: without `vector-effect` its stroke is in viewBox
    // units, and in a box one unit tall a stroke of 1 is the whole chart — a
    // band 72 px thick, a picture of the stand-in scale on exactly the line
    // DoD 4.13 exists for. `phase-verifier` round 5 found this unpinned.
    expect(baseline.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    // ...and it is the BASELINE: at the bottom of the box, across all of it.
    const [, , boxWidth, boxHeight] = (loops.querySelector('svg')?.getAttribute('viewBox') ?? '').split(' ');
    expect(baseline.getAttribute('y1'), 'the baseline is not at the bottom').toBe(boxHeight);
    expect(baseline.getAttribute('y2'), 'the baseline is not horizontal').toBe(boxHeight);
    expect(baseline.getAttribute('x1')).toBe('0');
    expect(baseline.getAttribute('x2'), 'the baseline does not span the box').toBe(boxWidth);
    expect(loops.querySelector('path.line'), 'a zero line drew a path').toBeNull();
    expect(all(loops, TESTID.statsTrendPoint), 'a zero line drew markers').toHaveLength(0);
    expect(loops.querySelector('.max')?.textContent).toBe('max 0');

    // The control, over the SAME records: prompt is an ordinary line.
    const prompt = lineOf(panel, 'prompt', 'cc');
    expect(prompt.querySelector('path.line'), 'the control drew no path').not.toBeNull();
    expect(all(prompt, TESTID.statsTrendPoint)).toHaveLength(2);
    expect(prompt.querySelector(`[data-testid="${TESTID.statsTrendBaseline}"]`)).toBeNull();
  });

  it('a marker is the same size at ANY maximum — including 1, which the report never named', () => {
    /*
     * THE MECHANISM, which is not the one reported. The report was a zero
     * maximum; the old guard already mapped 0 to a box one unit tall, so no NaN
     * was involved. What drew the arcs was `<circle r="1">` inside a viewBox
     * stretched by `preserveAspectRatio="none"`: a radius is in viewBox units,
     * so in a box one unit tall every marker was a full-height ellipse, and the
     * ones on the edges were clipped into arcs. A maximum of exactly 1 — one loop
     * in one session — builds that same box, and would have drawn the same arcs
     * after a fix aimed only at zero.
     *
     * The only mark whose on-screen size does not depend on the box is a stroke
     * with no length, drawn in screen pixels by `vector-effect`. So that is what
     * this pins: no circle anywhere, and every marker a zero-length, round-capped,
     * non-scaling stroke.
     */
    const panel = trendsOver([golden('01-reread-loop'), golden('02-churn-chain')]);
    const loops = lineOf(panel, 'loops', 'cc');
    const box = (loops.querySelector('svg')?.getAttribute('viewBox') ?? '').split(' ');
    expect(box[3], 'the case under test is a box ONE unit tall').toBe('1');

    const charts = all(panel.container, TESTID.statsTrendLine);
    expect(charts.length).toBeGreaterThan(0);
    for (const chart of charts) {
      expect(chart.querySelectorAll('circle'), 'a marker is sized in viewBox units').toHaveLength(0);
    }
    // A marker at the top, bottom or either end is a round cap CENTRED ON THE
    // EDGE, and clipped, half of it is an arc — the defect's other half.
    const chart = loops.querySelector('svg') as SVGSVGElement;
    expect(getComputedStyle(chart).overflow, 'edge markers are clipped into arcs').toBe('visible');

    const markers = all(loops, TESTID.statsTrendPoint);
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      expect(marker.tagName.toLowerCase()).toBe('path');
      expect(marker.getAttribute('d'), 'a marker with length').toMatch(/^M -?[\d.]+ -?[\d.]+ h 0$/);
      expect(marker.getAttribute('stroke-linecap')).toBe('round');
      expect(marker.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    }
  });

  it('no NaN, no Infinity and no zero-sized viewBox reaches the DOM, over EVERY committed stats golden', () => {
    /*
     * Every record under fixtures/golden/stats — the 36 RECORD goldens — rendered
     * together and then one engine at a time: the per-engine arrangement is what
     * produces a line per engine with its own maximum, and a lone engine is what
     * makes the most lines flat.
     *
     * THE SCOPE, stated because `phase-verifier` round 5 measured it narrower
     * than the first header claimed: this renders the TRENDS TAB only, so the
     * Tokens strip's own SVG is not scanned; and it renders records, not the
     * layout goldens under webview/goldens/stats, whose `n*` and `r8-*` inputs
     * are subsets of these records but whose `engines-mixed` and `zero-max`
     * inputs are generator-built arrangements that are never mounted here.
     */
    const records = readdirSync(GOLDEN_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => JSON.parse(readFileSync(resolve(GOLDEN_DIR, name), 'utf8')) as StatsRecord);
    expect(records.length, 'no stats golden on disk').toBeGreaterThan(2);

    const arrangements: StatsRecord[][] = [records];
    for (const engine of ['cc', 'codex', 'opencode'] as const) {
      const own = records.filter((r) => r.engine === engine);
      if (own.length >= 2) arrangements.push(own);
    }
    expect(arrangements.length, 'every engine should be arrangeable on its own').toBe(4);

    let lines = 0;
    let flat = 0;
    for (const arrangement of arrangements) {
      const panel = trendsOver(arrangement);
      const charts = all(panel.container, TESTID.statsTrendLine);
      lines += charts.length;
      flat += charts.filter((c) => c.querySelector(`[data-testid="${TESTID.statsTrendBaseline}"]`) !== null).length;
      expect(undrawable(panel.container), `an undrawable attribute over ${String(arrangement.length)} records`).toStrictEqual([]);
      panel.dispose();
      mounted.splice(mounted.indexOf(panel), 1);
    }
    // The scan saw both kinds of line, or it proved half of what it claims.
    expect(lines).toBeGreaterThan(flat);
    expect(flat, 'no flat line in any arrangement').toBeGreaterThan(0);
  });

  it('is not vacuous: the scan does see a NaN, an Infinity and a zero-height box', () => {
    const planted = document.createElement('div');
    planted.innerHTML = [
      '<svg viewBox="0 0 10 NaN"><path d="M 0 NaN" /></svg>',
      '<svg viewBox="0 0 10 0"><line x2="Infinity" /></svg>',
      '<svg viewBox="0 0 10 5"><path d="M 0 1 h 0" /></svg>',
    ].join('');
    expect(undrawable(planted)).toStrictEqual([
      '<svg viewBox="0 0 10 NaN">',
      '<path d="M 0 NaN">',
      '<svg viewBox="0 0 10 NaN">',
      '<line x2="Infinity">',
      '<svg viewBox="0 0 10 0">',
    ]);
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 4.14 — a cleared store empties the view in one message
 * ------------------------------------------------------------------------ */

describe('DoD 4.14: an empty statsStore after a full one empties the view on its own', () => {
  it('shows the empty state from that one message, with no other event', () => {
    /*
     * The webview half of 4.14. The host half — that Clear Stats History sends
     * this message in the same action — is `extension.test.ts`'s; this is the
     * proof that the one message is enough, so the pair together is "clear, and
     * the view is empty", with nothing in between.
     */
    const panel = render();
    send({ type: 'statsStore', records: [golden('01-reread-loop'), golden('02-churn-chain')], enabled: true });
    click(one(panel.container, TESTID.statsToggle));
    tab(panel, 'trends');
    expect(all(panel.container, TESTID.statsTrendSeries).length, 'the history never drew').toBeGreaterThan(0);

    // THE ONE MESSAGE. No click, no tab, no snapshot after it.
    send({ type: 'statsStore', records: [], enabled: true });
    const empty = one(panel.container, TESTID.statsEmpty);
    expect(empty.dataset['view']).toBe('trends');
    expect(empty.dataset['reason']).toBe('fewer-than-two');
    expect(all(panel.container, TESTID.statsTrendSeries)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ *
 * v0.8.0 Phase 7 — the DOM goldens for F2's durations, F14 and F15
 * ------------------------------------------------------------------------ */

/**
 * A committed DOM golden, and how it comes to exist.
 *
 * `webview/goldens/stats-dom/README.md` states what these are. The mechanism
 * belongs here: a missing golden PRINTS the observed value and fails, so the
 * file is created by reading a failure rather than by a script that could
 * quietly rewrite it. There is no write mode — a test that can write its own
 * golden cannot fail against one.
 *
 * `webview/goldens/stats/` is NOT where these live: that directory is owned by
 * `scripts/gen-webview-goldens.mjs`, which deletes anything it did not write.
 */
const DOM_GOLDEN_DIR = resolve('webview/goldens/stats-dom');

function domGolden<T>(name: string, observed: T): T {
  const path = resolve(DOM_GOLDEN_DIR, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `webview/goldens/stats-dom/${name}.json is missing. Observed:\n${JSON.stringify(observed, null, 2)}`,
    );
  }
  return (JSON.parse(readFileSync(path, 'utf8')) as { cases: T }).cases;
}

/** Mount over records that are not R8 fixtures, and enter the Stats mode. */
function recordPanel(records: readonly StatsRecord[], sessions: SessionState[] = []): Panel {
  const panel = render();
  send({ type: 'snapshot', sessions });
  send({ type: 'statsSnapshot', records });
  click(one(panel.container, TESTID.statsToggle));
  return panel;
}

/** The Tools table as a reader sees it: the header, then one array per row. */
function toolsTable(panel: Panel): { columns: string[]; rows: string[][] } {
  const columns = [...panel.container.querySelectorAll('table[aria-label="Tools"] th')].map(
    (th) => th.textContent?.trim() ?? '',
  );
  const rows = all(panel.container, TESTID.statsToolRow).map((row) =>
    [...row.querySelectorAll(`[data-testid="${TESTID.statsToolCell}"]`)].map(
      (cell) => cell.textContent?.trim() ?? '',
    ),
  );
  return { columns, rows };
}

/** Which schema field each cell of a row reports, in order. */
function toolColumns(panel: Panel): string[] {
  const row = all(panel.container, TESTID.statsToolRow)[0];
  if (row === undefined) throw new Error('no tool row');
  return [...row.querySelectorAll(`[data-testid="${TESTID.statsToolCell}"]`)].map(
    (cell) => (cell as HTMLElement).dataset['column'] ?? '',
  );
}

describe('DoD 7.5 — F2 has a surface, and its two duration columns are on it', () => {
  /*
   * THE DoD's FIXTURE CLAUSE IS INVERTED, AND THE MEASUREMENT IS WHY.
   *
   * It reads "fixture 13 (telemetry) shows numbers, every other golden shows
   * —". Counted over all 36 committed stats goldens, `tools[]` rows carrying
   * `durationMsSum`: 57 of 88. Harvested Claude Code 36 of 36, harvested
   * OpenCode 20 of 20, Codex 0 of 18, and fixture 13 itself 0 of 1.
   *
   * The cause is structural rather than accidental. A duration is the ENGINE's
   * — Claude Code from its transcript timestamps, OpenCode from
   * `state.time.start`/`.end` — and telemetry only FILLS where the engine
   * states none (`src/otel/join.ts`). Fixture 13 is a synthetic COST fixture
   * whose builder sets no per-call timestamps at all, and the Codex engine sets
   * no `ToolNode.durationMs` on any call.
   *
   * So the arms below are a harvested Claude Code session for PRESENT, the
   * Codex fixture for ABSENT, and fixture 12 for both IN ONE TABLE. The item's
   * substance — both columns, an em dash where absent, proved on a present row
   * and an absent row — is met; the fixture names are not.
   */

  it('the Tools tab is the second of five, and its columns are F2\'s own fields', () => {
    const panel = recordPanel([harvested]);
    tab(panel, 'tools');
    expect(toolColumns(panel)).toStrictEqual([
      'tool',
      'class',
      'calls',
      'errors',
      'durationMsMax',
      'durationMsSum',
      'sessions',
    ]);
    // The row count, pinned beside the contents: an `{#each}` over an empty
    // array satisfies every "no wrong row is present" assertion there is.
    expect(all(panel.container, TESTID.statsToolRow)).toHaveLength(harvested.tools.length);
    expect(harvested.tools.length).toBeGreaterThan(0);
  });

  it('a harvested session shows a number in both duration columns, on every row (DOM golden)', () => {
    const panel = recordPanel([harvested]);
    tab(panel, 'tools');
    const observed = toolsTable(panel);
    expect(observed).toStrictEqual(domGolden('tools-present', observed));
    // Not one em dash anywhere in the two duration columns — the vacuity
    // control for the golden, stated as the property rather than as bytes.
    for (const row of all(panel.container, TESTID.statsToolRow)) {
      expect(row.dataset['duration'], row.dataset['tool']).toBe('true');
    }
  });

  it('a Codex session shows the em dash in both columns, and in errors (DOM golden)', () => {
    const panel = recordPanel([golden('08-codex-window', 'codex')]);
    tab(panel, 'tools');
    const observed = toolsTable(panel);
    expect(observed).toStrictEqual(domGolden('tools-absent', observed));
    // THE CELL EXISTS AND HOLDS THE DASH. "this cell shows an em dash" passes
    // when the cell is absent, so the count comes first and the text second.
    const cells = all(panel.container, TESTID.statsToolCell).filter((c) =>
      ['durationMsMax', 'durationMsSum'].includes(c.dataset['column'] ?? ''),
    );
    expect(cells).toHaveLength(2);
    for (const cell of cells) expect(cell.textContent).toBe(EM_DASH);
  });

  it('12: one table holds a row WITH both durations and a row with neither (DOM golden)', () => {
    const panel = recordPanel([golden('12-stall')]);
    tab(panel, 'tools');
    const observed = toolsTable(panel);
    expect(observed).toStrictEqual(domGolden('tools-mixed', observed));
    const rows = all(panel.container, TESTID.statsToolRow);
    expect(rows.map((r) => r.dataset['duration'])).toStrictEqual(['true', 'false']);
  });

  it('a column no contributing record states stays absent, per ROW rather than per table', () => {
    /*
     * The aggregation rule `ToolRow` states, driven through the product: the
     * Codex `exec` row and the harvested Claude Code rows in one table. Codex
     * states no `errors` and no duration, so its row keeps three em dashes
     * while the rows beside it keep their numbers.
     */
    const panel = recordPanel([harvested, golden('08-codex-window', 'codex')]);
    tab(panel, 'tools');
    const byTool = new Map(
      all(panel.container, TESTID.statsToolRow).map((r) => [r.dataset['tool'] ?? '', r]),
    );
    expect(byTool.get('exec')?.dataset['duration']).toBe('false');
    expect(byTool.get('Read')?.dataset['duration']).toBe('true');
    expect(byTool.size).toBe(harvested.tools.length + 1);
  });
});

describe('DoD 7.3 — F14 in Tokens', () => {
  /** The six figures as the DOM reports them, with the record's raw value. */
  function figures(
    panel: Panel,
    record: StatsRecord,
  ): { figure: string; stated: boolean; raw: number | null; rendered: string }[] {
    const timing = (record.timing ?? {}) as unknown as Record<string, number | undefined>;
    return all(panel.container, TESTID.statsTiming).map((el) => {
      const figure = el.dataset['figure'] ?? '';
      return {
        figure,
        stated: el.dataset['stated'] === 'true',
        raw: timing[figure] ?? null,
        rendered: el.textContent?.trim() ?? '',
      };
    });
  }

  it('a harvested session states its span, and every figure is rendered (DOM golden)', () => {
    const panel = recordPanel([harvested]);
    tab(panel, 'tokens');
    const observed = figures(panel, harvested);
    expect(observed).toStrictEqual(domGolden('timing-present', observed));
    // The vacuity control the golden cannot give: SIX rows, and the three the
    // DoD names are among them and stated.
    expect(observed).toHaveLength(6);
    const stated = new Map(observed.map((f) => [f.figure, f.stated]));
    expect(stated.get('wallMs')).toBe(true);
    expect(stated.get('timeToFirstToolMs')).toBe(true);
    expect(stated.get('longestGapMs')).toBe(true);
  });

  it('an R8 fixture states no instant, so all six are the em dash (DOM golden)', () => {
    /*
     * MEASURED OVER THE WHOLE COMMITTED SET, not assumed:
     * `synthetic.testkit.ts`'s `tool()` sets `durationMs` and never
     * `startedAtMs`/`endedAtMs`, and its `turn()` sets no `atMs`, so
     * `deriveTiming` returns {} for every R8 state. A fixture that acquires an
     * instant later moves this test rather than passing silently.
     */
    const ids = readdirSync(resolve('fixtures/synthetic-stats'))
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.replace(/\.json$/u, ''));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(Object.keys(derived(id).timing), `${id} states an instant`).toStrictEqual([]);
    }

    const record = derived('01-reread-loop');
    const panel = recordPanel([record]);
    tab(panel, 'tokens');
    const observed = figures(panel, record);
    expect(observed).toStrictEqual(domGolden('timing-absent', observed));
    expect(observed).toHaveLength(6);
    expect(observed.every((f) => f.rendered === EM_DASH && !f.stated)).toBe(true);
  });

  it('ONE figure, three arms: a stated value, a stated 0 and an absent one', () => {
    /*
     * §D's rule on one cell, which is the only shape that catches both
     * mistakes: a renderer mapping an absent figure to `0`, and one mapping a
     * stated 0 to the em dash.
     *
     * THIS TEST USED TO READ A "REAL" 0 OFF THE ANCHOR SESSION, AND THAT 0 WAS A
     * DEFECT. Claude Code usage turns were timed by their LAST streamed line, so
     * the first turn looked later than the first tool and the figure clamped to
     * 0 (phase-7 verifier, D1). Timed by the first line, the anchor states
     * 2,880 ms. The stated-0 arm is now a copy with that one field set to 0, so it
     * differs from its control in the figure alone.
     */
    function timeToFirstTool(record: StatsRecord): HTMLElement | undefined {
      const panel = recordPanel([record]);
      tab(panel, 'tokens');
      return all(panel.container, TESTID.statsTiming).find(
        (el) => el.dataset['figure'] === 'timeToFirstToolMs',
      );
    }

    expect(harvested.timing.timeToFirstToolMs).toBe(2880);
    const stated = timeToFirstTool(harvested);
    expect(stated?.dataset['stated']).toBe('true');
    expect(stated?.textContent?.trim()).toBe('2.9s');

    const zero = timeToFirstTool({ ...harvested, timing: { ...harvested.timing, timeToFirstToolMs: 0 } });
    expect(zero?.dataset['stated']).toBe('true');
    expect(zero?.textContent?.trim()).toBe('0ms');

    const timing = { ...harvested.timing };
    delete timing.timeToFirstToolMs;
    const absent = timeToFirstTool({ ...harvested, timing });
    expect(absent?.dataset['stated']).toBe('false');
    expect(absent?.textContent?.trim()).toBe(EM_DASH);
  });
});

describe('DoD 7.3 — the tokens-per-minute series, per engine', () => {
  /**
   * THE CODEX LINE'S RATE IS THIS TEST'S NUMBER, AND THE CLAUDE CODE ONES ARE
   * NOT. Said plainly because the two are different kinds of evidence.
   *
   * The Claude Code points are two harvested sessions' own derived rates. The
   * Codex record is the committed R8 fixture with a `timing` block attached
   * here: Codex DOES timestamp its calls (`f14-corpus.test.ts` pins 42 of 42
   * starts), but no Codex `SessionState` carrying instants is reachable from a
   * jsdom suite — `src/codex/index.ts` would have to be imported into the
   * webview TypeScript project, which `tsconfig.webview.json`'s `types: []`
   * makes a typecheck hazard rather than a small change.
   *
   * What the arm is FOR is the transform, not the value: two lines whose
   * maxima are orders apart, each drawn in a box scaled to its own. That is the
   * disparity DoD 4.12 measured (a factor of ~5,700 between two engines'
   * medians) reproduced at a magnitude this test states.
   */
  const CODEX_RATE = 12;

  function rated(): StatsRecord[] {
    const codex = golden('08-codex-window', 'codex');
    return [
      harvested,
      abortedSpawn,
      { ...codex, timing: { wallMs: 600_000, tokensPerMin: CODEX_RATE } },
    ];
  }

  function trendsPanel(records: readonly StatsRecord[]): Panel {
    const panel = render();
    send({ type: 'statsStore', records, enabled: true });
    click(one(panel.container, TESTID.statsToggle));
    tab(panel, 'trends');
    return panel;
  }

  /** That engine's own maximum, recomputed FROM THE RECORDS. */
  function maxOf(records: readonly StatsRecord[], engine: string): number {
    const own = records.filter((r) => r.engine === engine).map((r) => r.timing?.tokensPerMin ?? 0);
    return Math.max(...own);
  }

  it('draws one line per engine, each in a viewBox that is its OWN maximum (DOM golden)', () => {
    const records = rated();
    const panel = trendsPanel(records);
    const lines = all(panel.container, TESTID.statsTrendLine).filter(
      (l) => l.dataset['series'] === 'tokensPerMin',
    );
    const observed = lines.map((line) => {
      const engine = line.dataset['engine'] ?? '';
      return {
        engine,
        points: line.dataset['points'] ?? '',
        // Recomputed here from the records rather than read off the layout: a
        // golden that compared the layout's `max` with the component's viewBox
        // would agree with itself whatever the scale was.
        maxFromRecords: maxOf(records, engine),
        viewBoxHeight: (line.querySelector('svg')?.getAttribute('viewBox') ?? '').split(/\s+/)[3] ?? '',
        maxCaption: line.querySelector('.max')?.textContent?.trim() ?? '',
      };
    });
    expect(observed).toStrictEqual(domGolden('trends-tokens-per-min', observed));

    // THE TRANSFORM, NOT ONLY THE NUMBERS THAT FEED IT (DoD 4.12's lesson):
    // each engine's box height IS that engine's own maximum.
    for (const line of observed) {
      expect(Number(line.viewBoxHeight), line.engine).toBe(line.maxFromRecords);
    }
    // Not vacuous: two engines, and their maxima are orders apart. One shared
    // maximum would satisfy every assertion above on a single line.
    expect(observed.map((l) => l.engine)).toStrictEqual(['cc', 'codex']);
    expect(maxOf(records, 'cc') / maxOf(records, 'codex')).toBeGreaterThan(100);
  });

  it('every marker sits at its own line\'s scale, so one shared constant goes red', () => {
    const records = rated();
    const panel = trendsPanel(records);
    let checked = 0;
    for (const line of all(panel.container, TESTID.statsTrendLine)) {
      if (line.dataset['series'] !== 'tokensPerMin') continue;
      const max = maxOf(records, line.dataset['engine'] ?? '');
      for (const marker of line.querySelectorAll(`[data-testid="${TESTID.statsTrendPoint}"]`)) {
        const y = Number(marker.getAttribute('data-y'));
        // `markerOf` flips the raw y inside the box: `max - y`.
        expect(markerY(marker), `${String(line.dataset['engine'])} ${String(y)}`).toBe(String(max - y));
        checked += 1;
      }
    }
    expect(checked).toBe(records.length);
  });

  it('is a FOURTH series, in the layout\'s order, and the other three are unchanged', () => {
    const panel = trendsPanel(rated());
    expect(all(panel.container, TESTID.statsTrendSeries).map((s) => s.dataset['series'])).toStrictEqual([
      'prompt',
      'loops',
      'cost',
      'tokensPerMin',
    ]);
  });

  it('a session that states no rate contributes no point to the series', () => {
    const withoutRate = { ...derived('01-reread-loop'), startedAt: 1 };
    const records = [...rated(), withoutRate];
    const panel = trendsPanel(records);
    const cc = all(panel.container, TESTID.statsTrendLine).find(
      (l) => l.dataset['series'] === 'tokensPerMin' && l.dataset['engine'] === 'cc',
    );
    expect(cc?.dataset['points']).toBe('2');
    // The session is still ON the axis: the x positions are global, and only
    // the y scale is per engine.
    expect(panel.container.querySelectorAll('.axis li')).toHaveLength(records.length);
  });
});

describe('DoD 7.4 — F15 rendered beside silent', () => {
  function subagentFigure(panel: Panel): { text: string; silent: string; unreceived: string } {
    const figure = one(panel.container, TESTID.statsSubagents);
    return {
      text: figure.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
      silent: figure.dataset['silent'] ?? '',
      unreceived: figure.dataset['unreceived'] ?? '',
    };
  }

  it('the harvested mid-spawn session: the count, and the chip on the agent it names (DOM golden)', () => {
    /*
     * F15's positive arm is a real capture, not a manufactured shape — one
     * committed Claude Code session was captured while a subagent was still
     * working, so its `Agent` block has no `tool_result` in the parent
     * transcript. `src/stats/f15.test.ts` pins it as the only one in the
     * corpus; this is the same session rendered.
     */
    const panel = recordPanel([abortedSpawn]);
    tab(panel, 'tokens');
    const observed = {
      ...subagentFigure(panel),
      flags: all(panel.container, TESTID.statsUnreceivedFlag).map((f) => f.dataset['agent'] ?? ''),
      flaggedRows: all(panel.container, TESTID.statsAgentRow)
        .filter((r) => r.dataset['unreceived'] === 'true')
        .map((r) => ({ agent: r.dataset['agent'] ?? '', kind: r.dataset['kind'] ?? '' })),
    };
    expect(observed).toStrictEqual(domGolden('f15-present', observed));

    // The row count beside the row contents, and the chip's own words: it
    // states what the snapshot holds and nothing about what will arrive.
    expect(all(panel.container, TESTID.statsAgentRow)).toHaveLength(abortedSpawn.agents.length);
    expect(all(panel.container, TESTID.statsUnreceivedFlag)).toHaveLength(1);
    expect(one(panel.container, TESTID.statsUnreceivedFlag).textContent).toBe(
      VOCABULARY.unreceivedResult,
    );
    expect(abortedSpawn.totals.subagentsUnreceived).toBe(1);
    expect(observed.flaggedRows[0]?.kind).toBe('subagent');
  });

  it('a session that states no spawn edges shows the em dash, never 0 (DOM golden)', () => {
    /*
     * The other arm, and the one a `?? 0` would swallow. `03-silent-subagent`
     * states no `spawnEdges`, so `totals.subagentsUnreceived` is ABSENT and the
     * record names `F15:cc` in `unavailable` — a different fact from "every
     * spawning call got a result", which is what a 0 would say.
     */
    const record = derived('03-silent-subagent');
    expect(record.totals.subagentsUnreceived).toBeUndefined();
    expect(record.unavailable).toContain('F15:cc');
    const panel = recordPanel([record], [fixtureState('03-silent-subagent')]);
    tab(panel, 'tokens');
    const observed = subagentFigure(panel);
    expect(observed).toStrictEqual(domGolden('f15-absent', observed));
    expect(observed.text).toContain(EM_DASH);
    expect(observed.text).not.toContain('0 with no spawning result');
    expect(all(panel.container, TESTID.statsUnreceivedFlag)).toHaveLength(0);
    // The silent flag is still there, one figure away: the two facts sit beside
    // each other and this fixture moves only one of them.
    expect(observed.silent).toBe('1');
  });

  it('the chip says only what the snapshot holds', () => {
    // G10 and the seam's own constraint (`AgentStats.resultUnreceived`): F15 is
    // transient on a live session, so the rendered phrase is present tense and
    // carries no claim about the future.
    expect(VOCABULARY.unreceivedResult).toBe('spawning call has no result');
    for (const word of ['never', 'abandoned', 'failed', 'lost', 'will']) {
      expect(VOCABULARY.unreceivedResult).not.toContain(word);
    }
  });
});
