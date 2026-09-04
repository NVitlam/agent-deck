// @vitest-environment jsdom
//
// Altitude 0 — the deck, asserted against the REAL esbuild + Svelte bundle.
//
// WHAT THIS FILE REPLACED. Thirty of its predecessor's tests asserted geometry
// that no longer exists: `blobPath` silhouettes, `constellationPoints` dots,
// `DECK_RADIUS_MIN`, `hashSessionId` seeds and the four-field
// `DeckPlacement { sessionId, x, y, R }`. `layout.ts` deleted all of it rather
// than deprecating it, so those tests were pinning deleted code. They are gone
// and the behaviours the deck still owes a user are re-covered below — cards,
// order, values, states, motion, filtering, pan/zoom/fit and the empty state.
// The deletions and the replacements are itemised in this package's report.
//
// WHY A BUNDLE. There is no vitest svelte plugin in this repo, so a `.svelte`
// import cannot be transformed in-process. This file bundles `Deck.svelte`
// directly through the same pipeline `npm run build` runs, from an in-memory
// entry point, exactly the way `inspector.test.ts` does. Nothing is written to
// disk (G1) — the entry goes to esbuild as `stdin` and the bundle comes back
// on the child's stdout.
//
// AND WHY A SECOND ONE. The last section drives the WHOLE PANEL through
// `testkit.ts:loadHarness`, because two of this package's claims are about
// wiring rather than about a component: that a snapshot or a diff does not
// reset the viewport, and that a wheel notch reaching the store lands exactly
// where `viewport.zoomAbout` puts it. Neither can be shown by a component
// mounted with static props.
//
// ASSERT BY VALUE, NEVER BY PRESENCE. Nothing type-checks a `.svelte` file,
// eslint does not lint one, and `esbuild-svelte` does not propagate the Svelte
// compiler's warnings — measured both ways in this repo — so a clean build
// says close to nothing about these components and these tests are the only
// real check on them. `toContain('—')` on a concatenated row passes when EVERY
// figure is a dash, which is exactly how a fully-dashed token line shipped in
// a release whose changelog was about wrong token numbers. Every figure below
// is selected on its own testid and compared to a computed expectation.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionState } from '../src/model/events.js';
import {
  ANIMATED_CLASSES,
  CRACKED_CLASS,
  DEFAULT_ENGINE_FILTER,
  FOREIGN_CLASS,
  HOLLOW_LIVE_CLASS,
  REDUCED_MOTION_CLASS,
  TESTID,
} from './canvas-contract.js';
import {
  DECK_CARD_H,
  DECK_CARD_W,
  DEFAULT_DECK_LAYOUT,
  DEFAULT_DECK_SORT,
  deckEngine,
  deckLayout,
  formatCompactTokens,
} from './layout.js';
import type { DeckLayoutMode, DeckSession, DeckSortMode } from './layout.js';
import {
  DECK_FIT_PADDING,
  DECK_ZOOM_LIMITS,
  boundsOf,
  fitTo,
  transformAttr,
  zoomAbout,
} from './viewport.js';
import { EM_DASH, displayLiveness, formatCost, livenessTitle } from './format.js';
import type { SessionSummary, Store } from './store.js';
import { createStore } from './store.js';
import { all, loadHarness, one } from './testkit.js';
import type { WebviewHarness } from './testkit.js';
import { agent, liveSession, settledSession, tool, unsupportedSession } from './testdata.js';

/**
 * Held in a variable rather than imported statically, for the same reason
 * `testkit.ts` does it: `tsconfig.webview.json` sets `types: []`, so a literal
 * node specifier would fail the webview typecheck. Opaque to `tsc`, resolved
 * at runtime by vitest.
 */
const CHILD_PROCESS = 'node:child_process';
const FS = 'node:fs';

interface ChildProcessModule {
  execFileSync(
    file: string,
    args: readonly string[],
    options: { encoding: 'utf8'; maxBuffer: number },
  ): string;
}

interface FsModule {
  readFileSync(path: string, encoding: 'utf8'): string;
}

const GLOBAL_NAME = 'AgentDeckDeckHarness';

/** The in-memory entry point esbuild bundles. */
const ENTRY = [
  "export { default as Deck } from './Deck.svelte';",
  "export { mount, unmount, flushSync } from 'svelte';",
].join('\n');

/**
 * The build script, run as its own `node` process.
 *
 * A separate process is not incidental: esbuild refuses to start under jsdom,
 * because jsdom installs its own `Uint8Array` and esbuild's startup invariant
 * (`new TextEncoder().encode('') instanceof Uint8Array`) is then false. See
 * `webview/build-harness.mjs`, which carries the same note and the same fix.
 */
const BUILD_SCRIPT = `
import { build } from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
const result = await build({
  stdin: {
    contents: ${JSON.stringify(ENTRY)},
    resolveDir: process.cwd() + '/webview',
    sourcefile: 'deck-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: ${JSON.stringify(GLOBAL_NAME)},
  target: 'es2022',
  conditions: ['svelte', 'browser'],
  mainFields: ['svelte', 'browser', 'module', 'main'],
  plugins: [esbuildSvelte({ compilerOptions: { css: 'injected' } })],
  logLevel: 'silent',
});
const js = result.outputFiles[0];
if (js === undefined) { process.stderr.write('no output\\n'); process.exit(1); }
process.stdout.write(js.text);
`;

interface DeckHarness {
  Deck: unknown;
  mount(
    component: unknown,
    options: { target: HTMLElement; props?: Record<string, unknown> },
  ): unknown;
  unmount(app: unknown): void;
  flushSync(fn?: () => void): void;
}

let harness: DeckHarness;
/** The whole-panel harness, for the two wiring claims. */
let panelHarness: WebviewHarness;
/** The bundled JavaScript, kept so the injected stylesheet can be asserted on. */
let bundle = '';
/** The two component sources, read once, for the source-level checks. */
let componentSources: { path: string; text: string }[] = [];

beforeAll(async () => {
  const cp = (await import(/* @vite-ignore */ CHILD_PROCESS)) as unknown as ChildProcessModule;
  bundle = cp.execFileSync('node', ['--input-type=module', '-e', BUILD_SCRIPT], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const factory = new Function(`${bundle}\nreturn ${GLOBAL_NAME};`) as () => DeckHarness;
  harness = factory();

  panelHarness = await loadHarness();

  const fs = (await import(/* @vite-ignore */ FS)) as unknown as FsModule;
  componentSources = ['webview/Deck.svelte', 'webview/SessionCell.svelte'].map((path) => ({
    path,
    text: fs.readFileSync(path, 'utf8'),
  }));
}, 120_000);

interface Mounted {
  container: HTMLElement;
  dispose: () => void;
}

const mounted: Mounted[] = [];

/**
 * Mount the deck with a field size supplied.
 *
 * jsdom reports every box as zero, so without this the grid would fall to its
 * one-column floor and every placement assertion would be about a layout the
 * component only produces in a test.
 */
const FIELD_W = 960;
const FIELD_H = 600;

function render(props: Record<string, unknown>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const app = harness.mount(harness.Deck, {
    target: container,
    props: { viewportWidth: FIELD_W, viewportHeight: FIELD_H, ...props },
  });
  harness.flushSync();
  mounted.push({
    container,
    dispose: () => {
      harness.unmount(app);
      container.remove();
    },
  });
  return container;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

/* ------------------------------------------------------------------------ *
 * Builders. Literals, so one field can be varied at a time; the store-driven
 * section below is what proves the store emits these shapes.
 * ------------------------------------------------------------------------ */

/** A fixed instant, so every age string in this file is exact. */
const NOW = 1_700_000_000_000;

function summary(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    projectSlug: 'c--Users-dev-projects-agent-deck',
    workspaceMatch: true,
    liveness: 'live',
    refused: false,
    label: `main ${sessionId}`,
    nodeCount: 3,
    errorCount: 0,
    engine: 'cc',
    agents: 2,
    inflight: 0,
    costUsd: 0,
    lastEventAt: NOW - 4_000,
    burn: { prompt: 12_000, output: 400 },
    contextNow: { prompt: 8_000, output: 200 },
    ...overrides,
  };
}

/** A summary shaped the way the store shapes a refused one: every count 0. */
function refusedSummary(
  sessionId: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  const row = summary(sessionId, {
    refused: true,
    liveness: 'unsupported',
    nodeCount: 0,
    errorCount: 0,
    agents: 0,
    inflight: 0,
    costUsd: 0,
    lastEventAt: 0,
    ...overrides,
  });
  delete row.burn;
  delete row.contextNow;
  return row;
}

/** Feed a store one snapshot and hand back the view it produces. */
function viewOf(states: readonly SessionState[], mismatchIds: readonly string[] = []) {
  const store = createStore();
  store.handleMessage({ type: 'snapshot', sessions: [...states] });
  for (const sessionId of mismatchIds) store.handleMessage({ type: 'schemaMismatch', sessionId });
  return store.getView();
}

/** `SessionSummary` to the `DeckSession` the layout engine takes. */
function toDeck(row: SessionSummary): DeckSession {
  return {
    id: row.sessionId,
    engine: deckEngine(row.engine),
    status: displayLiveness(row.liveness, row.refused),
    last: row.lastEventAt,
  };
}

/** What `deckLayout` returns for these rows, at this layout and sort. */
function expectPlacements(
  rows: readonly SessionSummary[],
  layout: DeckLayoutMode = DEFAULT_DECK_LAYOUT,
  sort: DeckSortMode = DEFAULT_DECK_SORT,
) {
  return deckLayout(rows.map(toDeck), layout, sort, FIELD_W);
}

/** Every element carrying any class listed in `ANIMATED_CLASSES`. */
function animated(root: ParentNode): Element[] {
  return [...root.querySelectorAll('*')].filter((el) =>
    ANIMATED_CLASSES.some((cls) => el.classList.contains(cls)),
  );
}

function cells(root: ParentNode): HTMLElement[] {
  return all(root, TESTID.deckBlob);
}

function cellFor(root: ParentNode, sessionId: string): HTMLElement {
  const found = cells(root).find((c) => c.dataset['sessionId'] === sessionId);
  if (found === undefined) throw new Error(`no cell for ${sessionId}`);
  return found;
}

/** The exact text of one figure on a card, selected by its own testid. */
function figure(cell: ParentNode, testId: string): string {
  return one(cell, testId).textContent ?? '';
}

/**
 * Click by dispatching the event, not by calling `.click()`.
 *
 * `HTMLElement.prototype.click` does not exist on an `SVGElement` in jsdom and
 * every card is an SVG `<g>`. Dispatching is also the more faithful of the
 * two: it is what a pointer produces in the real panel.
 */
function click(element: Element): void {
  harness.flushSync(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** A pointer event jsdom will actually construct. */
function pointer(type: string, x: number, y: number): Event {
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  const event = new Ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: 1, configurable: true });
  Object.defineProperty(event, 'button', { value: 0, configurable: true });
  return event;
}

function wheel(target: Element, deltaY: number, x: number, y: number): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY,
    clientX: x,
    clientY: y,
  });
  harness.flushSync(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function key(name: string): void {
  harness.flushSync(() => {
    globalThis.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    );
  });
}

/* ------------------------------------------------------------------------ *
 * The empty deck (2.6)
 * ------------------------------------------------------------------------ */

describe('the empty deck', () => {
  it('says ONE line, and it names no engine (D4)', () => {
    const container = render({ sessions: [] });
    const deck = one(container, TESTID.deck);
    expect(deck.dataset['sessions']).toBe('0');
    const lines = all(container, 'deck-waiting').map((p) => p.textContent);
    expect(lines).toStrictEqual(['Waiting for a session to start.']);
    expect(cells(container)).toHaveLength(0);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('D4: no generic empty state names an engine, in either branch', () => {
    /*
     * WHAT THIS REPLACED, because the deleted tests were not wrong — they were
     * pinning a mechanism that never ran.
     *
     * `Deck.svelte` used to take `enabledEngines` and print one waiting line
     * per engine this installation observes, precisely so a machine with no
     * OpenCode was never shown a panel waiting for one. **Nothing ever passed
     * the prop.** `App.svelte` did not, so the `['cc']` default applied on
     * every install and an empty deck told a Codex-only user that Agent Deck
     * was "Waiting for a Claude Code session…". Three tests asserted that
     * behaviour and all three passed, because they supplied the prop the
     * product never supplied. The user found it by own eyes at DoD 3.5.
     *
     * The rule now: a state that is ABOUT THE WHOLE PANEL names no engine.
     */
    const engineNames = ['Claude Code', 'Claude', 'OpenCode', 'Codex'];

    // Branch 1: nothing has started.
    const emptyDeck = one(render({ sessions: [] }), TESTID.deckEmpty).textContent ?? '';
    expect(emptyDeck.trim()).toBe('Waiting for a session to start.');
    for (const name of engineNames) expect(emptyDeck).not.toContain(name);

    // Branch 2: something exists and the filter hides it. Already engine-free,
    // asserted here so both branches are covered by one rule rather than one.
    const filtered = one(
      render({ sessions: [summary('s-1')], engineFilter: 'oc' }),
      TESTID.deckEmpty,
    ).textContent ?? '';
    expect(filtered.trim()).toBe('No sessions match this filter.');
    for (const name of engineNames) expect(filtered).not.toContain(name);
  });

  it('D4 boundary: copy that IS about one engine still names it', () => {
    /*
     * The other half, and it is what keeps the rule above from being read as
     * "never write an engine name in the webview". A filter chip and a card's
     * tag are statements about one engine, so naming it is the whole point;
     * a rule that stripped them would make the deck unreadable in the name of
     * making one line correct.
     *
     * This also fails if someone "fixes" D4 by deleting the chips.
     */
    const container = render({ sessions: [summary('s-1')] });
    const chips = all(container, 'deck-engine-chip')
      .map((el) => el.textContent ?? '')
      .join(' ');
    for (const name of ['Claude Code', 'OpenCode', 'Codex']) {
      expect(chips, `the ${name} filter chip must still be named`).toContain(name);
    }
  });

  it('distinguishes "nothing yet" from "nothing matches the filter"', () => {
    // The filter is a PROP now, not this component's state, so the case is set
    // up by mounting at the filtered value rather than by pressing `o` and
    // waiting for the component to move itself. Same DOM, same claim: a deck
    // holding a session the filter excludes says so, and does not fall back to
    // the "waiting for a session" copy, which would tell the user nothing has
    // started when something has.
    const container = render({ sessions: [summary('s-1')], engineFilter: 'oc' });
    expect(all(container, 'deck-waiting')).toHaveLength(0);
    expect(one(container, 'deck-empty-filtered').textContent).toBe(
      'No sessions match this filter.',
    );
    // The discriminating half: with the filter at `all` the same session list
    // is not empty at all, so the message above is about the filter and not
    // about an empty deck.
    expect(all(render({ sessions: [summary('s-1')] }), 'deck-empty-filtered')).toHaveLength(0);
  });

  it('renders no empty state at all as soon as there is a session', () => {
    const container = render({ sessions: [summary('s-1')] });
    expect(all(container, TESTID.deckEmpty)).toHaveLength(0);
    expect(cells(container)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------ *
 * Placement — deckLayout in its FOUR-ARGUMENT form
 * ------------------------------------------------------------------------ */

describe('placement comes from deckLayout(sessions, layout, sort, viewportW)', () => {
  const rows = [
    summary('s-a', { liveness: 'idle', lastEventAt: NOW - 10_000 }),
    summary('s-b', { liveness: 'live', lastEventAt: NOW - 60_000 }),
    summary('s-c', { liveness: 'ended', lastEventAt: NOW - 1_000 }),
    summary('s-d', { liveness: 'live', engine: 'opencode', lastEventAt: NOW - 5_000 }),
  ];

  it('draws each card at the coordinates the layout engine returned', () => {
    const container = render({ sessions: rows });
    for (const placement of expectPlacements(rows)) {
      expect(cellFor(container, placement.id).getAttribute('transform')).toBe(
        `translate(${placement.x} ${placement.y})`,
      );
    }
  });

  it('emits the cards in the layout engine’s order, which is the sort order', () => {
    const container = render({ sessions: rows });
    expect(cells(container).map((c) => c.dataset['sessionId'])).toStrictEqual(
      expectPlacements(rows).map((p) => p.id),
    );
  });

  for (const layout of ['list', 'grid', 'lanes'] as const) {
    it(`renders the ${layout} layout at the ${layout} coordinates`, () => {
      const container = render({ sessions: rows });
      const index = { list: '1', grid: '2', lanes: '3' }[layout];
      key(index);
      expect(one(container, TESTID.deck).dataset['layout']).toBe(layout);
      const expected = expectPlacements(rows, layout);
      for (const placement of expected) {
        expect(cellFor(container, placement.id).getAttribute('transform')).toBe(
          `translate(${placement.x} ${placement.y})`,
        );
      }
    });
  }

  for (const sort of ['live', 'recent', 'engine'] as const) {
    it(`renders the ${sort} sort in the ${sort} order`, () => {
      const container = render({ sessions: rows });
      key({ live: 'l', recent: 'r', engine: 'e' }[sort]);
      expect(one(container, TESTID.deck).dataset['sort']).toBe(sort);
      expect(cells(container).map((c) => c.dataset['sessionId'])).toStrictEqual(
        expectPlacements(rows, DEFAULT_DECK_LAYOUT, sort).map((p) => p.id),
      );
    });
  }

  it('NEGATIVE CONTROL: the three layouts do not all produce one arrangement', () => {
    // Without this, a component that ignored `layoutMode` and always called
    // `deckLayout` with the default would satisfy every test above.
    const list = expectPlacements(rows, 'list').map((p) => `${p.x},${p.y}`);
    const grid = expectPlacements(rows, 'grid').map((p) => `${p.x},${p.y}`);
    const lanes = expectPlacements(rows, 'lanes').map((p) => `${p.x},${p.y}`);
    expect(grid).not.toStrictEqual(list);
    expect(lanes).not.toStrictEqual(list);
  });

  it('NEGATIVE CONTROL: the three sorts do not all produce one order', () => {
    const live = expectPlacements(rows, 'grid', 'live').map((p) => p.id);
    const recent = expectPlacements(rows, 'grid', 'recent').map((p) => p.id);
    const engine = expectPlacements(rows, 'grid', 'engine').map((p) => p.id);
    expect(recent).not.toStrictEqual(live);
    expect(engine).not.toStrictEqual(recent);
  });

  it('draws ONE shape in every layout: 220 x 88, whichever layout is showing', () => {
    const container = render({ sessions: rows });
    for (const layout of ['1', '2', '3']) {
      key(layout);
      for (const cell of cells(container)) {
        const border = one(cell, 'deck-cell-border');
        expect(border.getAttribute('width')).toBe(String(DECK_CARD_W));
        expect(border.getAttribute('height')).toBe(String(DECK_CARD_H));
        expect(border.getAttribute('rx')).toBe('10');
      }
    }
  });
});

/* ------------------------------------------------------------------------ *
 * The card's three rows (2.2) — every figure asserted BY VALUE
 * ------------------------------------------------------------------------ */

describe('row 1 — engine glyph and label', () => {
  it('draws CC for Claude Code, OC for OpenCode, and CX for Codex', () => {
    const container = render({
      sessions: [
        summary('s-cc'),
        summary('s-oc', { engine: 'opencode' }),
        summary('s-cx', { engine: 'codex' }),
      ],
    });
    expect(figure(cellFor(container, 's-cc'), 'deck-cell-engine')).toBe('CC');
    expect(figure(cellFor(container, 's-oc'), 'deck-cell-engine')).toBe('OC');
    expect(figure(cellFor(container, 's-cx'), 'deck-cell-engine')).toBe('CX');
  });

  it('NEGATIVE CONTROL: a card never shows another engine’s glyph', () => {
    const container = render({
      sessions: [
        summary('s-cc'),
        summary('s-oc', { engine: 'opencode' }),
        summary('s-cx', { engine: 'codex' }),
      ],
    });
    expect(figure(cellFor(container, 's-cc'), 'deck-cell-engine')).not.toBe('OC');
    expect(figure(cellFor(container, 's-cc'), 'deck-cell-engine')).not.toBe('CX');
    expect(figure(cellFor(container, 's-oc'), 'deck-cell-engine')).not.toBe('CC');
    expect(figure(cellFor(container, 's-oc'), 'deck-cell-engine')).not.toBe('CX');
    // The case this control exists for: `'codex'` is neither `'opencode'` nor
    // `'cc'`, so a ternary that folds anything-not-opencode into `'CC'` would
    // draw the wrong glyph here and every assertion above would still pass.
    expect(figure(cellFor(container, 's-cx'), 'deck-cell-engine')).not.toBe('CC');
    expect(figure(cellFor(container, 's-cx'), 'deck-cell-engine')).not.toBe('OC');
    expect(cellFor(container, 's-cc').dataset['engine']).toBe('cc');
    expect(cellFor(container, 's-oc').dataset['engine']).toBe('opencode');
    expect(cellFor(container, 's-cx').dataset['engine']).toBe('codex');
  });

  it('tags a refused session too: G3 withholds the tree, not who was reading', () => {
    const container = render({ sessions: [refusedSummary('s-refused')] });
    const cell = cellFor(container, 's-refused');
    expect(cell.classList.contains(CRACKED_CLASS)).toBe(true);
    expect(figure(cell, 'deck-cell-engine')).toBe('CC');
  });

  it('draws the label, and WRAPS one too long to fit the card (A9.1)', () => {
    // It cut at 24 characters with a `…` until 2026-08-29. A9.1 removed every
    // ellipsis from every surface: the card has room for two rows and the whole
    // string is on its `<title>` for hover.
    const container = render({
      sessions: [
        summary('s-short', { label: 'main' }),
        summary('s-long', { label: 'a-very-long-session-label-that-does-not-fit' }),
      ],
    });
    expect(figure(cellFor(container, 's-short'), 'deck-cell-label')).toBe('main');
    // One row for the short one — the second row is absent, not empty.
    expect(all(cellFor(container, 's-short'), 'deck-cell-label-2')).toHaveLength(0);

    const long = cellFor(container, 's-long');
    const row1 = figure(long, 'deck-cell-label');
    const row2 = figure(long, 'deck-cell-label-2');
    expect(row1.endsWith('…')).toBe(false);
    expect(row2.length).toBeGreaterThan(0);
    // ...and hover carries the whole thing, whatever the two rows held.
    expect(long.querySelector('title')?.textContent).toContain(
      'a-very-long-session-label-that-does-not-fit',
    );
  });
});

describe('row 2 — the mono figures', () => {
  it('prints the agent count the store derived, not a count of its own', () => {
    const container = render({ sessions: [summary('s-1', { agents: 5 })] });
    expect(figure(cellFor(container, 's-1'), 'deck-cell-agents')).toBe('5 ag');
  });

  it('prints the in-flight count, and marks it busy only when it is non-zero', () => {
    const container = render({
      sessions: [summary('s-quiet', { inflight: 0 }), summary('s-busy', { inflight: 3 })],
    });
    const quiet = one(cellFor(container, 's-quiet'), 'deck-cell-inflight');
    const busy = one(cellFor(container, 's-busy'), 'deck-cell-inflight');
    expect(quiet.textContent).toBe('0 in flight');
    expect(busy.textContent).toBe('3 in flight');
    expect(quiet.dataset['busy']).toBe('false');
    expect(busy.dataset['busy']).toBe('true');
    expect(quiet.classList.contains('busy')).toBe(false);
    expect(busy.classList.contains('busy')).toBe(true);
  });

  it('prints BURN — prompt PLUS output — compacted, and not contextNow', () => {
    // The two are different questions. `burn` is the total the card is about;
    // `contextNow` is a level, and summing levels means nothing. A component
    // reading the wrong one would still print a plausible number, so the
    // expectation is computed from both halves of `burn` explicitly.
    const row = summary('s-1', {
      burn: { prompt: 51_000, output: 808 },
      contextNow: { prompt: 9_000, output: 100 },
    });
    const container = render({ sessions: [row] });
    expect(figure(cellFor(container, 's-1'), 'deck-cell-tokens')).toBe('51.8k');
    expect(formatCompactTokens(51_000 + 808)).toBe('51.8k');
    expect(figure(cellFor(container, 's-1'), 'deck-cell-tokens')).not.toBe(
      formatCompactTokens(9_100),
    );
  });

  it('prints an em-dash for an ABSENT burn, and never a zero', () => {
    // The OpenCode engine reports no burn at all. Printing 0 would claim the
    // session spent nothing, which is a wrong number rather than a missing
    // one — the defect `TokenPair` exists to remove.
    const row = summary('s-oc', { engine: 'opencode' });
    delete row.burn;
    const container = render({ sessions: [row] });
    const drawn = figure(cellFor(container, 's-oc'), 'deck-cell-tokens');
    expect(drawn).toBe(EM_DASH);
    expect(drawn).not.toBe('0');
  });

  it('prints a MILLION-scale burn as M, so the compaction is not one branch', () => {
    const container = render({
      sessions: [summary('s-big', { burn: { prompt: 1_100_000, output: 100_000 } })],
    });
    expect(figure(cellFor(container, 's-big'), 'deck-cell-tokens')).toBe('1.2M');
  });

  it('renders cost only when it is non-zero: 0 is NOT COMPUTED, never free', () => {
    const container = render({
      sessions: [summary('s-zero', { costUsd: 0 }), summary('s-paid', { costUsd: 1.25 })],
    });
    expect(figure(cellFor(container, 's-zero'), 'deck-cell-cost')).toBe(EM_DASH);
    expect(figure(cellFor(container, 's-paid'), 'deck-cell-cost')).toBe(formatCost(1.25));
    expect(figure(cellFor(container, 's-paid'), 'deck-cell-cost')).toBe('1.25 USD');
    expect(cellFor(container, 's-zero').dataset['cost']).toBe('0');
  });

  it('NEGATIVE CONTROL: the four figures are not all em-dashes on a real row', () => {
    // The shape this repo has already shipped once: a token line where every
    // figure was a dash, under a test asserting only that a dash was present.
    const container = render({ sessions: [summary('s-1', { agents: 4, inflight: 2 })] });
    const cell = cellFor(container, 's-1');
    const drawn = [
      figure(cell, 'deck-cell-agents'),
      figure(cell, 'deck-cell-inflight'),
      figure(cell, 'deck-cell-tokens'),
    ];
    expect(drawn).toStrictEqual(['4 ag', '2 in flight', '12.4k']);
    expect(drawn.filter((s) => s === EM_DASH)).toHaveLength(0);
  });
});

describe('row 3 — status chip and relative age', () => {
  for (const liveness of ['live', 'idle', 'ended', 'unsupported'] as const) {
    it(`names ${liveness} in words beside a dot of its own`, () => {
      const rows =
        liveness === 'unsupported'
          ? [refusedSummary('s-1')]
          : [summary('s-1', { liveness })];
      const container = render({ sessions: rows });
      const chip = one(cellFor(container, 's-1'), 'deck-cell-status');
      expect(chip.dataset['liveness']).toBe(liveness);
      expect(chip.textContent?.trim()).toBe(liveness);
      expect(chip.querySelectorAll('circle')).toHaveLength(1);
    });
  }

  it('prints seconds, minutes and hours from lastEventAt against the clock', () => {
    const container = render({
      sessions: [
        summary('s-s', { lastEventAt: NOW - 4_000 }),
        summary('s-m', { lastEventAt: NOW - 2 * 60_000 }),
        summary('s-h', { lastEventAt: NOW - 3 * 3_600_000 }),
      ],
      now: NOW,
    });
    expect(figure(cellFor(container, 's-s'), 'deck-cell-age')).toBe('4s');
    expect(figure(cellFor(container, 's-m'), 'deck-cell-age')).toBe('2m');
    expect(figure(cellFor(container, 's-h'), 'deck-cell-age')).toBe('3h');
  });

  it('prints an em-dash rather than an age for a session with no timestamp', () => {
    const container = render({ sessions: [refusedSummary('s-refused')], now: NOW });
    expect(figure(cellFor(container, 's-refused'), 'deck-cell-age')).toBe(EM_DASH);
  });
});

/* ------------------------------------------------------------------------ *
 * The state table (2.3)
 * ------------------------------------------------------------------------ */

describe('the six card states', () => {
  it('gives live, idle, ended, degraded and unsupported five different data-states', () => {
    const live = render({ sessions: [summary('s', { liveness: 'live' })] });
    const idle = render({ sessions: [summary('s', { liveness: 'idle' })] });
    const ended = render({ sessions: [summary('s', { liveness: 'ended' })] });
    const degraded = render({ sessions: [summary('s', { liveness: 'live' })], degraded: true });
    const refused = render({ sessions: [refusedSummary('s')] });
    const states = [live, idle, ended, degraded, refused].map(
      (c) => cellFor(c, 's').dataset['state'],
    );
    expect(states).toStrictEqual(['live', 'idle', 'ended', 'degraded', 'unsupported']);
    expect(new Set(states).size).toBe(5);
  });

  it('keeps data-liveness on the WIRE value while data-state carries degraded', () => {
    // The two axes are independent and must not be collapsed: a degraded
    // session is still live, it is just less well observed.
    const container = render({
      sessions: [summary('s', { liveness: 'live' })],
      degraded: true,
    });
    const cell = cellFor(container, 's');
    expect(cell.dataset['liveness']).toBe('live');
    expect(cell.dataset['state']).toBe('degraded');
    expect(cell.dataset['livenessInferred']).toBe('true');
    expect(cell.querySelectorAll(`.${HOLLOW_LIVE_CLASS}`)).toHaveLength(1);
  });

  it('hollows nothing while the hook tap is healthy', () => {
    const container = render({ sessions: [summary('s', { liveness: 'live' })] });
    expect(container.querySelectorAll(`.${HOLLOW_LIVE_CLASS}`)).toHaveLength(0);
    expect(cellFor(container, 's').dataset['livenessInferred']).toBe('false');
  });

  it('dashes a refused card and says so on the card and on its border', () => {
    const container = render({ sessions: [refusedSummary('s')] });
    const cell = cellFor(container, 's');
    expect(cell.dataset['refused']).toBe('true');
    expect(cell.classList.contains(CRACKED_CLASS)).toBe(true);
    expect(one(cell, 'deck-cell-border').classList.contains(CRACKED_CLASS)).toBe(true);
  });

  it('carries the refusal in a tooltip, in words the format module owns', () => {
    // The `schemaMismatch` message on the wire carries NO reason code, so a
    // card printing one would be inventing it.
    // A9.1 put the LABEL first in the tooltip — it is the thing a card can
    // fail to show in full — with the status after it.
    const container = render({ sessions: [refusedSummary('s')] });
    expect(cellFor(container, 's').querySelector('title')?.textContent).toContain(
      livenessTitle('unsupported'),
    );
  });

  it('names the ENGINE and the reason in a degraded card’s tooltip', () => {
    const container = render({
      sessions: [summary('s', { engine: 'cc' })],
      degraded: true,
      degradedReason: 'listenerDown',
    });
    const tooltip = cellFor(container, 's').querySelector('title')?.textContent ?? '';
    // A9.1 leads the tooltip with the LABEL; the status follows it.
    expect(tooltip).toContain('Claude Code: the hook listener is not running');
  });

  /*
   * D2 (2026-09-03) — THE DEGRADED CHIP IS THE CLAUDE CODE TAP'S, AND ONLY ITS.
   *
   * The test above used to pass `engine: 'opencode'` and assert the card said
   * "OpenCode: the hook listener is not running". That assertion pinned the
   * defect: `degraded` is produced by `LivenessEngine.degradedState()`, which
   * reads `eventsReceived === 0` on the CLAUDE CODE engine alone. OpenCode's
   * liveness comes from its own SQLite cursor and Codex's from its own hook
   * reduction, so neither is described by that flag at all.
   *
   * Reported by own eyes against the shipped `release/0.6.0` build: Codex cells
   * reading "hooks silent" while Codex hooks were arriving and being attributed
   * (`src/hooks/listener.test.ts`'s D2 block proves the host half). It was
   * invisible before Phase 3's discriminator because every Codex payload was
   * also dispatched into the CC handler, which kept `eventsReceived` moving.
   *
   * The same mislabelling has been shipping for OpenCode since v0.5.0.
   */
  it('shows the degraded chip on a Claude Code card and on no other engine', () => {
    const container = render({
      sessions: [
        summary('s-cc', { engine: 'cc' }),
        summary('s-oc', { engine: 'opencode' }),
        summary('s-cx', { engine: 'codex' }),
      ],
      degraded: true,
      degradedReason: 'noHookEvents',
    });

    const cc = cellFor(container, 's-cc');
    const oc = cellFor(container, 's-oc');
    const cx = cellFor(container, 's-cx');

    // The Claude Code card wears it — the control, so the assertions below
    // cannot pass because the panel simply is not degraded.
    expect(cc.dataset['state']).toBe('degraded');
    expect(cc.querySelector('title')?.textContent).toContain(
      'Claude Code: no hook events received',
    );

    // The other two do not, and they still report their own liveness rather
    // than nothing at all.
    for (const cell of [oc, cx]) {
      expect(cell.dataset['state']).not.toBe('degraded');
      expect(cell.dataset['state']).toBe('live');
      expect(cell.querySelector('title')?.textContent ?? '').not.toContain('hook');
    }
  });

  /*
   * DoD 5.0b - AND NOW CODEX HAS ONE OF ITS OWN.
   *
   * D2's fix, pinned by the test above, stopped the panel LYING about Codex by
   * giving Codex cards nothing. That was right and it was not the end: a Codex
   * user whose paste block was missing, or whose six hook commands were never
   * trusted, saw a deck that simply never went live, with no banner and
   * nothing to act on. The tap now reports its own health and the card wears
   * it.
   *
   * BOTH DIRECTIONS, because a one-directional test is satisfied by a chip
   * that is always on - which is exactly what the D2 defect was.
   */
  it('shows the degraded chip on a CODEX card when the CODEX tap is silent', () => {
    const container = render({
      sessions: [
        summary('s-cc', { engine: 'cc' }),
        summary('s-oc', { engine: 'opencode' }),
        summary('s-cx', { engine: 'codex' }),
      ],
      degradedByEngine: {
        cc: { degraded: false },
        codex: { degraded: true, reason: 'noHookEvents' },
      },
    });

    const cx = cellFor(container, 's-cx');
    expect(cx.dataset['state']).toBe('degraded');
    expect(cx.querySelector('title')?.textContent).toContain(
      'Codex: no hook events received',
    );

    // THE OTHER DIRECTION, in the same mount: the Claude Code card is NOT
    // degraded, because its own tap is fine. Without this the test would pass
    // for a renderer that painted the Codex flag onto everything - which is
    // D2 with the engines swapped.
    const cc = cellFor(container, 's-cc');
    expect(cc.dataset['state']).not.toBe('degraded');
    expect(cc.querySelector('title')?.textContent ?? '').not.toContain('hook');

    // OPENCODE IS EXEMPT BY DESIGN, and this states it rather than leaving it
    // to be inferred from an absence. OpenCode has NO HOOK TAP at all - its
    // liveness is a cursor on `event_sequence.seq` - so "hooks silent" is not
    // false about it, it is meaningless. `WebviewView.degradedByEngine` has no
    // `oc` member for exactly this reason, which makes an OpenCode card asking
    // the question a type error rather than a rule someone has to remember.
    const oc = cellFor(container, 's-oc');
    expect(oc.dataset['state']).not.toBe('degraded');
    expect(oc.querySelector('title')?.textContent ?? '').not.toContain('hook');
  });

  it('shows it on the CLAUDE CODE card when the Claude Code tap is the silent one', () => {
    // The mirror image of the test above, and together they are what stops a
    // stuck channel reading as a working one.
    const container = render({
      sessions: [
        summary('s-cc', { engine: 'cc' }),
        summary('s-cx', { engine: 'codex' }),
      ],
      degradedByEngine: {
        cc: { degraded: true, reason: 'listenerDown' },
        codex: { degraded: false },
      },
    });

    const cc = cellFor(container, 's-cc');
    expect(cc.dataset['state']).toBe('degraded');
    expect(cc.querySelector('title')?.textContent).toContain('Claude Code:');

    const cx = cellFor(container, 's-cx');
    expect(cx.dataset['state']).not.toBe('degraded');
    expect(cx.querySelector('title')?.textContent ?? '').not.toContain('hook');
  });

  it('reads the reason from the card’s OWN tap, not from the other one', () => {
    // Both degraded, for DIFFERENT reasons. A renderer that took the engine
    // from the card and the reason from a single shared value would pass every
    // assertion above and fail this one - which is the seam D2 lived in.
    const container = render({
      sessions: [
        summary('s-cc', { engine: 'cc' }),
        summary('s-cx', { engine: 'codex' }),
      ],
      degradedByEngine: {
        cc: { degraded: true, reason: 'noHookEvents' },
        codex: { degraded: true, reason: 'listenerDown' },
      },
    });

    const ccTitle = cellFor(container, 's-cc').querySelector('title')?.textContent ?? '';
    const cxTitle = cellFor(container, 's-cx').querySelector('title')?.textContent ?? '';

    expect(ccTitle).toContain('Claude Code: no hook events received');
    expect(cxTitle).toContain('Codex:');
    // The two reasons are different strings, so a shared value cannot satisfy
    // both. Asserted as an inequality as well, so the check does not rest on
    // the exact wording of either message.
    expect(ccTitle).not.toBe(cxTitle);
  });
  it('ghosts a foreign session and tags it, in text and in the accessible name', () => {
    const container = render({
      sessions: [summary('s-mine'), summary('s-theirs', { workspaceMatch: false })],
    });
    const foreign = cellFor(container, 's-theirs');
    expect(foreign.classList.contains(FOREIGN_CLASS)).toBe(true);
    expect(foreign.dataset['foreign']).toBe('true');
    expect(figure(foreign, 'deck-cell-foreign')).toBe('other workspace');
    expect(foreign.getAttribute('aria-label')).toContain('other workspace');

    const mine = cellFor(container, 's-mine');
    expect(mine.classList.contains(FOREIGN_CLASS)).toBe(false);
    expect(all(mine, 'deck-cell-foreign')).toHaveLength(0);
  });

  it('rings the selected card and rings nothing else', () => {
    const container = render({
      sessions: [summary('s-1'), summary('s-2')],
      selectedSessionId: 's-2',
    });
    expect(all(cellFor(container, 's-1'), 'deck-cell-selection')).toHaveLength(0);
    expect(all(cellFor(container, 's-2'), 'deck-cell-selection')).toHaveLength(1);
    expect(cellFor(container, 's-1').dataset['selected']).toBe('false');
    expect(cellFor(container, 's-2').dataset['selected']).toBe('true');
    expect(cellFor(container, 's-2').getAttribute('aria-current')).toBe('true');
  });

  it('brightens the border on hover and does NOT scale or shadow', () => {
    // The stylesheet is the only place this can be asserted; what matters is
    // that the hover rule touches the stroke and nothing else, because a card
    // that grew on hover would move its neighbours' apparent spacing.
    const cell = componentSources.find((s) => s.path.endsWith('SessionCell.svelte'));
    const style = (cell?.text ?? '').slice((cell?.text ?? '').indexOf('<style>'));
    const hover = style.slice(style.indexOf(':hover'));
    // COMMENTS STRIPPED FIRST. The block explains itself in prose that names
    // the two things it must not do, so a raw substring check read the
    // explanation and failed on the words rather than on the declarations.
    const block = hover.slice(0, hover.indexOf('}')).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(block).toContain('stroke:');
    expect(block).not.toContain('transform');
    expect(block).not.toContain('scale');
    expect(block).not.toContain('shadow');
  });

  it('carries a stylesheet rule for each of the five states', () => {
    for (const state of ['live', 'idle', 'ended', 'degraded', 'unsupported']) {
      expect(bundle).toContain(`data-state='${state}'`);
    }
  });
});

describe('the tool-error badge', () => {
  it('renders the count the store derived, and nothing it derived itself', () => {
    const container = render({ sessions: [summary('s-err', { errorCount: 3 })] });
    const badge = one(container, TESTID.deckErrorBadge);
    expect(badge.dataset['count']).toBe('3');
    expect(badge.textContent?.trim()).toBe('3');
    expect(cellFor(container, 's-err').dataset['errors']).toBe('3');
  });

  it('renders no badge at all when nothing errored, and none on a refusal', () => {
    const container = render({
      sessions: [summary('s-clean'), refusedSummary('s-refused')],
    });
    expect(all(container, TESTID.deckErrorBadge)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 7.5 — the pulse rule, deck half
 * ------------------------------------------------------------------------ */

describe('the pulse rule (DoD 7.5)', () => {
  it('pulses exactly the sessions with a live cursor or a tool in flight', () => {
    const container = render({
      sessions: [
        summary('s-live', { liveness: 'live', inflight: 0 }),
        summary('s-idle', { liveness: 'idle', inflight: 0 }),
        summary('s-ended', { liveness: 'ended', inflight: 0 }),
        refusedSummary('s-refused'),
      ],
    });
    const pulsing = cells(container)
      .filter((c) => all(c, 'deck-cell-pulse').length > 0)
      .map((c) => c.dataset['sessionId']);
    expect(pulsing).toStrictEqual(['s-live']);
  });

  it('NEGATIVE CONTROL: idle, ended, refused NEVER pulse, even with a running tool', () => {
    // A stale `running` tool under an idle session is a real state, and the
    // design says an idle card is still. Written as a guard in the component
    // rather than left to follow from the liveness value.
    const container = render({
      sessions: [
        summary('s-idle', { liveness: 'idle', inflight: 4 }),
        summary('s-ended', { liveness: 'ended', inflight: 4 }),
        refusedSummary('s-refused', { inflight: 4 }),
      ],
    });
    expect(all(container, 'deck-cell-pulse')).toHaveLength(0);
    expect(animated(container)).toHaveLength(0);
  });

  it('suppresses the pulse while the card is selected, and keeps the ring', () => {
    const container = render({
      sessions: [summary('s-1', { liveness: 'live' }), summary('s-2', { liveness: 'live' })],
      selectedSessionId: 's-1',
    });
    expect(all(cellFor(container, 's-1'), 'deck-cell-pulse')).toHaveLength(0);
    expect(all(cellFor(container, 's-1'), 'deck-cell-selection')).toHaveLength(1);
    expect(all(cellFor(container, 's-2'), 'deck-cell-pulse')).toHaveLength(1);
    expect(cellFor(container, 's-1').dataset['pulsing']).toBe('false');
    expect(cellFor(container, 's-2').dataset['pulsing']).toBe('true');
  });

  it('SWAPS the pulse for a static ring under reduced motion, keeping the class', () => {
    // Dropping the class instead would make the reduced-motion path
    // indistinguishable from an ended session (C7.6).
    const container = render({
      sessions: [summary('s-live', { liveness: 'live' })],
      reducedMotion: true,
    });
    const ring = one(container, 'deck-cell-pulse');
    expect(ring.dataset['static']).toBe('true');
    expect(ring.classList.contains(ANIMATED_CLASSES[1])).toBe(true);
    expect(ring.classList.contains('is-static')).toBe(true);
    expect(animated(container).length).toBeGreaterThan(0);
    expect(one(container, TESTID.deck).classList.contains(REDUCED_MOTION_CLASS)).toBe(true);
  });

  it('leaves the static class off when the user asked for no such thing', () => {
    const container = render({ sessions: [summary('s-live', { liveness: 'live' })] });
    expect(one(container, 'deck-cell-pulse').dataset['static']).toBe('false');
    expect(one(container, TESTID.deck).classList.contains(REDUCED_MOTION_CLASS)).toBe(false);
  });

  it('NEGATIVE CONTROL: every session ended -> exactly zero animated elements', () => {
    const container = render({
      sessions: ['s-1', 's-2', 's-3', 's-4', 's-5'].map((id) =>
        summary(id, { liveness: 'ended', inflight: 0 }),
      ),
    });
    expect(cells(container)).toHaveLength(5);
    expect(animated(container)).toHaveLength(0);
  });

  it('uses only classes the contract lists, and the two this altitude owns', () => {
    const container = render({ sessions: [summary('s-live', { liveness: 'live' })] });
    const classes = new Set<string>();
    for (const el of animated(container)) for (const c of el.classList) classes.add(c);
    const carried = ANIMATED_CLASSES.filter((c) => classes.has(c));
    // `is-flowing` is the filament's, in the session interior.
    expect(carried).toStrictEqual([ANIMATED_CLASSES[0], ANIMATED_CLASSES[1]]);
  });

  it('puts the animation-bearing classes on elements the stylesheet animates', () => {
    for (const cls of [ANIMATED_CLASSES[0], ANIMATED_CLASSES[1]]) {
      expect(bundle).toContain(`.${cls}`);
    }
    expect(bundle).toContain('animation:');
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 7.7 — the engine filter chip
 * ------------------------------------------------------------------------ */

describe('the engine filter (DoD 7.7)', () => {
  // THE FILTER IS CONTROLLED NOW, and these tests changed shape with it. The
  // value is `store.ts`'s (see `WebviewView.engineFilter`); the component takes
  // it as a prop and reports a chip or a key through `onenginefilter`. So a
  // click here does NOT move the DOM on its own, and asserting that it did
  // would be asserting that the component kept a second copy — the defect the
  // move was made to remove. Each half is tested for what it now owns: the
  // component reports intent and renders the value it was given, and the store
  // round trip is driven through the mounted panel at the end of this file.
  const rows = [
    summary('s-cc-1'),
    summary('s-cc-2'),
    summary('s-oc-1', { engine: 'opencode' }),
    summary('s-cx-1', { engine: 'codex' }),
  ];

  function chips(root: ParentNode): HTMLElement[] {
    return all(root, 'deck-engine-chip');
  }

  it('offers exactly four chips, in the design’s order, with All active', () => {
    // Three as of Phase 7, four from v0.6.0 Phase 3's Codex chip — the
    // widening this describe block records.
    const container = render({ sessions: rows });
    expect(chips(container).map((c) => c.dataset['engine'])).toStrictEqual([
      'all',
      'cc',
      'oc',
      'cx',
    ]);
    expect(chips(container).map((c) => c.dataset['active'])).toStrictEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    expect(DEFAULT_ENGINE_FILTER).toBe('all');
  });

  it('badges each chip with the number of sessions that engine has', () => {
    const container = render({ sessions: rows });
    expect(chips(container).map((c) => c.dataset['count'])).toStrictEqual(['4', '2', '1', '1']);
    expect(chips(container).map((c) => c.textContent)).toStrictEqual([
      'All4',
      'Claude Code2',
      'OpenCode1',
      'Codex1',
    ]);
  });

  it('reports a chip click, and NEVER changes the value on its own', () => {
    const asked: string[] = [];
    const container = render({
      sessions: rows,
      onenginefilter: (filter: string) => asked.push(filter),
    });
    const cc = chips(container).find((c) => c.dataset['engine'] === 'cc');
    if (cc === undefined) throw new Error('no cc chip');
    click(cc);
    expect(asked).toStrictEqual(['cc']);
    // Nothing moved: the store has not answered, so the deck still shows what
    // it was given. A component holding its own copy would read 'cc' here and
    // would then be a second source of truth for the same value.
    expect(one(container, TESTID.deck).dataset['engineFilter']).toBe('all');
    expect(cells(container)).toHaveLength(4);
  });

  it('is SINGLE-SELECT: the value it is given activates exactly one chip', () => {
    const container = render({ sessions: rows, engineFilter: 'cc' });
    expect(chips(container).map((c) => c.dataset['active'])).toStrictEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
    expect(chips(container).filter((c) => c.dataset['active'] === 'true')).toHaveLength(1);
    expect(chips(container).map((c) => c.getAttribute('aria-pressed'))).toStrictEqual([
      'false',
      'true',
      'false',
      'false',
    ]);

    // The fourth chip activates exactly as the first three do.
    const cx = render({ sessions: rows, engineFilter: 'cx' });
    expect(chips(cx).map((c) => c.dataset['active'])).toStrictEqual([
      'false',
      'false',
      'false',
      'true',
    ]);
  });

  it('shows only that engine’s cards, and still says how many there are', () => {
    const cc = render({ sessions: rows, engineFilter: 'cc' });
    expect(cells(cc).map((c) => c.dataset['sessionId'])).toStrictEqual(['s-cc-1', 's-cc-2']);
    const count = one(cc, 'deck-count');
    expect(count.dataset['shown']).toBe('2');
    expect(count.dataset['total']).toBe('4');
    expect(count.textContent).toBe('2 of 4');

    const oc = render({ sessions: rows, engineFilter: 'oc' });
    expect(cells(oc).map((c) => c.dataset['sessionId'])).toStrictEqual(['s-oc-1']);
    expect(one(oc, 'deck-count').textContent).toBe('1 of 4');

    const cx = render({ sessions: rows, engineFilter: 'cx' });
    expect(cells(cx).map((c) => c.dataset['sessionId'])).toStrictEqual(['s-cx-1']);
    expect(one(cx, 'deck-count').textContent).toBe('1 of 4');

    const all_ = render({ sessions: rows, engineFilter: 'all' });
    expect(cells(all_)).toHaveLength(4);
    expect(one(all_, 'deck-count').textContent).toBe('4');
    // The badges are counted off the FULL list, so every chip still says what
    // it would show even while another chip is the active one.
    expect(chips(cc).map((c) => c.dataset['count'])).toStrictEqual(['4', '2', '1', '1']);
  });

  it('answers A C O X by reporting, and steals nothing else', () => {
    const asked: string[] = [];
    render({ sessions: rows, onenginefilter: (filter: string) => asked.push(filter) });
    key('c');
    key('o');
    key('x');
    key('a');
    expect(asked).toStrictEqual(['cc', 'oc', 'cx', 'all']);
  });

  it('sends the host NOTHING and asks for no fit: it is view state only', () => {
    // Filtering does not call fit; only re-rooting does. And a filter is a
    // webview-local decision — no message exists for it in either direction.
    // `onenginefilter` reaches the STORE, never the host: `store.test.ts`'s
    // "sends the host NOTHING for either filter" is the other half.
    const fits: unknown[] = [];
    const zooms: unknown[] = [];
    const entered: string[] = [];
    const container = render({
      sessions: rows,
      onfit: (...args: unknown[]) => fits.push(args),
      onzoom: (...args: unknown[]) => zooms.push(args),
      onenter: (id: string) => entered.push(id),
    });
    key('c');
    key('o');
    key('x');
    key('a');
    expect(fits).toStrictEqual([]);
    expect(zooms).toStrictEqual([]);
    expect(entered).toStrictEqual([]);
    expect(one(container, TESTID.deck).dataset['engineFilter']).toBe('all');
  });
});

/* ------------------------------------------------------------------------ *
 * The rest of the control bar (2.1)
 * ------------------------------------------------------------------------ */

describe('the control bar', () => {
  const rows = [summary('s-1'), summary('s-2', { engine: 'opencode' })];

  it('is a fixed 40px row that is not inside the transformed stage', () => {
    const container = render({ sessions: rows });
    const bar = one(container, 'deck-bar');
    expect(bar.getAttribute('style')?.replace(/\s+/g, '')).toContain('height:40px');
    expect(bar.closest(`[data-testid="${TESTID.deckStage}"]`)).toBeNull();
    expect(bar.closest('svg')).toBeNull();
  });

  it('defaults to Grid, Live first and All', () => {
    const container = render({ sessions: rows });
    const deck = one(container, TESTID.deck);
    expect([deck.dataset['layout'], deck.dataset['sort'], deck.dataset['engineFilter']]).toStrictEqual(
      [DEFAULT_DECK_LAYOUT, DEFAULT_DECK_SORT, DEFAULT_ENGINE_FILTER],
    );
    expect([deck.dataset['layout'], deck.dataset['sort'], deck.dataset['engineFilter']]).toStrictEqual(
      ['grid', 'live', 'all'],
    );
  });

  it('offers the three layouts and the three sorts, single-select each', () => {
    const container = render({ sessions: rows });
    expect(all(container, 'deck-layout-option').map((b) => b.dataset['layout'])).toStrictEqual([
      'list',
      'grid',
      'lanes',
    ]);
    expect(all(container, 'deck-sort-option').map((b) => b.dataset['sort'])).toStrictEqual([
      'live',
      'recent',
      'engine',
    ]);
    const lanes = all(container, 'deck-layout-option')[2];
    if (lanes === undefined) throw new Error('no lanes option');
    click(lanes);
    expect(
      all(container, 'deck-layout-option').filter((b) => b.dataset['active'] === 'true'),
    ).toHaveLength(1);
    expect(one(container, TESTID.deck).dataset['layout']).toBe('lanes');
  });

  // The engine keys are NOT in this table any more: they report through
  // `onenginefilter` rather than moving an attribute, and
  // "answers A C O by reporting" above is their test. Putting them here with
  // an attribute that no longer moves would have made this loop assert
  // `'all', 'all', 'all'` — three passes, nothing measured.
  for (const [name, keys, attribute, expected] of [
    ['layout', ['1', '2', '3'], 'layout', ['list', 'grid', 'lanes']],
    ['sort', ['l', 'r', 'e'], 'sort', ['live', 'recent', 'engine']],
  ] as const) {
    it(`answers the ${name} keys ${keys.join(' ').toUpperCase()}`, () => {
      const container = render({ sessions: rows });
      const deck = one(container, TESTID.deck);
      const seen: string[] = [];
      for (const k of keys) {
        key(k);
        seen.push(deck.dataset[attribute] ?? '');
      }
      expect(seen).toStrictEqual([...expected]);
    });
  }

  it('never steals a keystroke from a field the user is typing into', () => {
    const container = render({ sessions: rows });
    const input = document.createElement('input');
    document.body.appendChild(input);
    harness.flushSync(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }),
      );
    });
    expect(one(container, TESTID.deck).dataset['layout']).toBe('grid');
    input.remove();
  });

  it('persists NOTHING: a fresh mount is back at the defaults (G7)', () => {
    // LAYOUT AND SORT ONLY. They are this component's `$state` and a fresh
    // mount is genuinely back at the design defaults — no storage, nothing
    // carried between mounts.
    //
    // The engine filter is deliberately not asserted here any more, and the
    // difference is the whole of DoD 7.7's fix. It is store state now, so it
    // SURVIVES a remount, which is exactly what "persists nothing" must not be
    // read to forbid: surviving an unmount inside one panel session is not
    // persistence. Persistence would be a setting, `workspaceState` or
    // `localStorage`, and the next test asserts the bundle contains none of
    // the three.
    const first = render({ sessions: rows });
    key('3');
    key('r');
    expect(one(first, TESTID.deck).dataset['layout']).toBe('lanes');
    expect(one(first, TESTID.deck).dataset['sort']).toBe('recent');
    const second = render({ sessions: rows });
    const deck = one(second, TESTID.deck);
    expect([deck.dataset['layout'], deck.dataset['sort']]).toStrictEqual(['grid', 'live']);
  });

  it('writes to no storage at all — the bundle contains no persistence API', () => {
    for (const forbidden of ['localStorage', 'sessionStorage', 'workspaceState']) {
      expect(bundle).not.toContain(forbidden);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 7.4 — pan, zoom, fit
 * ------------------------------------------------------------------------ */

describe('pan, zoom and fit (DoD 7.4)', () => {
  const rows = [summary('s-1'), summary('s-2'), summary('s-3')];

  function fieldOf(root: ParentNode): SVGSVGElement {
    const svg = root.querySelector('svg');
    if (svg === null) throw new Error('no field');
    return svg;
  }

  it('renders the view as ONE transform on ONE stage group', () => {
    const view = { x: 31, y: -7, k: 1.25 };
    const container = render({ sessions: rows, deckView: view });
    expect(one(container, TESTID.deckStage).getAttribute('transform')).toBe(transformAttr(view));
    expect(one(container, TESTID.deckStage).getAttribute('transform')).toBe(
      'translate(31 -7) scale(1.25)',
    );
  });

  it('leaves every PLACEMENT untouched while the transform moves', () => {
    // The assertion this whole surface exists for. If pan or zoom ever edited
    // coordinates instead, layout would stop being a pure function of state,
    // every golden would go stale, and "a spawn adds, it never reflows" would
    // quietly stop being true.
    const still = render({ sessions: rows });
    const moved = render({ sessions: rows, deckView: { x: 120, y: 60, k: 1 } });
    const at = (root: ParentNode): (string | null)[] =>
      cells(root).map((c) => c.getAttribute('transform'));
    expect(at(moved)).toStrictEqual(at(still));
  });

  it('reports a drag on the EMPTY FIELD as client-pixel deltas', () => {
    const pans: [number, number][] = [];
    const container = render({
      sessions: rows,
      onpan: (dx: number, dy: number) => pans.push([dx, dy]),
    });
    const field = fieldOf(container);
    field.dispatchEvent(pointer('pointerdown', 100, 100));
    field.dispatchEvent(pointer('pointermove', 140, 130));
    field.dispatchEvent(pointer('pointermove', 150, 130));
    field.dispatchEvent(pointer('pointerup', 150, 130));
    expect(pans).toStrictEqual([
      [40, 30],
      [10, 0],
    ]);
  });

  it('does NOT pan when the drag starts on a card', () => {
    const pans: unknown[] = [];
    const container = render({
      sessions: rows,
      onpan: (...args: unknown[]) => pans.push(args),
    });
    const cell = cellFor(container, 's-1');
    cell.dispatchEvent(pointer('pointerdown', 100, 100));
    cell.dispatchEvent(pointer('pointermove', 180, 160));
    cell.dispatchEvent(pointer('pointerup', 180, 160));
    expect(pans).toStrictEqual([]);
  });

  it('reports a wheel as SIGNED NOTCHES about the cursor, and swallows the event', () => {
    const zooms: [number, number, number][] = [];
    const container = render({
      sessions: rows,
      onzoom: (n: number, x: number, y: number) => zooms.push([n, x, y]),
    });
    const field = fieldOf(container);
    const inward = wheel(field, -120, 300, 200);
    const outward = wheel(field, 120, 300, 200);
    expect(zooms).toStrictEqual([
      [1, 300, 200],
      [-1, 300, 200],
    ]);
    expect(inward.defaultPrevented).toBe(true);
    expect(outward.defaultPrevented).toBe(true);
  });

  it('asks for a FIT on a double-click on the empty field, with the content bounds', () => {
    const fits: [unknown, unknown][] = [];
    const container = render({
      sessions: rows,
      onfit: (content: unknown, size: unknown) => fits.push([content, size]),
    });
    harness.flushSync(() => {
      fieldOf(container).dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
      );
    });
    const expectedContent = boundsOf(
      expectPlacements(rows).map((p) => ({ x: p.x, y: p.y, w: DECK_CARD_W, h: DECK_CARD_H })),
    );
    expect(fits).toHaveLength(1);
    expect(fits[0]?.[0]).toStrictEqual(expectedContent);
    expect(fits[0]?.[1]).toStrictEqual({ width: FIELD_W, height: FIELD_H });
  });

  it('does NOT fit on a double-click on a card', () => {
    const fits: unknown[] = [];
    const container = render({
      sessions: rows,
      onfit: (...args: unknown[]) => fits.push(args),
    });
    harness.flushSync(() => {
      cellFor(container, 's-1').dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
      );
    });
    expect(fits).toStrictEqual([]);
  });
});

describe('the store applies the deck viewport through viewport.ts and nowhere else', () => {
  it('zooms exactly where zoomAbout puts it, at DECK_ZOOM_LIMITS', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    const before = store.getView().deckView;
    store.zoomDeck(1, 300, 200);
    expect(store.getView().deckView).toStrictEqual(
      zoomAbout(before, 300, 200, 1, DECK_ZOOM_LIMITS),
    );
  });

  it('clamps to the deck’s own range in both directions', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    for (let i = 0; i < 40; i += 1) store.zoomDeck(1, 0, 0);
    expect(store.getView().deckView.k).toBe(DECK_ZOOM_LIMITS.max);
    for (let i = 0; i < 80; i += 1) store.zoomDeck(-1, 0, 0);
    expect(store.getView().deckView.k).toBe(DECK_ZOOM_LIMITS.min);
    store.resetDeckView();
    expect(store.getView().deckView).toStrictEqual({ x: 0, y: 0, k: 1 });
  });

  it('fits exactly where fitTo puts it, with 24px of padding', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    const content = { x: 0, y: 0, w: 900, h: 400 };
    const size = { width: FIELD_W, height: FIELD_H };
    store.fitDeck(content, size);
    expect(DECK_FIT_PADDING).toBe(24);
    expect(store.getView().deckView).toStrictEqual(
      fitTo(content, size, DECK_FIT_PADDING, DECK_ZOOM_LIMITS),
    );
  });

  it('ignores a non-finite gesture rather than corrupting the view', () => {
    const store = createStore();
    store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    store.panDeck(Number.NaN, 5);
    store.zoomDeck(Number.POSITIVE_INFINITY, 0, 0);
    store.zoomDeck(0, 0, 0);
    store.zoomDeck(1, Number.NaN, 0);
    store.fitDeck({ x: 0, y: 0, w: Number.NaN, h: 10 }, { width: 100, height: 100 });
    expect(store.getView().deckView).toStrictEqual({ x: 0, y: 0, k: 1 });
  });
});

/* ------------------------------------------------------------------------ *
 * Entering a session, and the accessibility floor
 * ------------------------------------------------------------------------ */

describe('entering a session', () => {
  it('reports the session id on click, and posts no message of its own', () => {
    const entered: string[] = [];
    const container = render({
      sessions: [summary('s-1'), summary('s-2')],
      onenter: (id: string) => entered.push(id),
    });
    click(cellFor(container, 's-2'));
    expect(entered).toStrictEqual(['s-2']);
  });

  for (const name of ['Enter', ' ']) {
    it(`enters the session on ${name === ' ' ? 'Space' : name}`, () => {
      const entered: string[] = [];
      const container = render({
        sessions: [summary('s-1')],
        onenter: (id: string) => entered.push(id),
      });
      const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
      harness.flushSync(() => cellFor(container, 's-1').dispatchEvent(event));
      expect(entered).toStrictEqual(['s-1']);
      expect(event.defaultPrevented).toBe(true);
    });
  }

  it('ignores a key that is not an activation', () => {
    const entered: string[] = [];
    const container = render({
      sessions: [summary('s-1')],
      onenter: (id: string) => entered.push(id),
    });
    harness.flushSync(() =>
      cellFor(container, 's-1').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true }),
      ),
    );
    expect(entered).toStrictEqual([]);
  });

  it('enters a REFUSED session too — that is where the refusal card lives', () => {
    const entered: string[] = [];
    const container = render({
      sessions: [refusedSummary('s-refused')],
      onenter: (id: string) => entered.push(id),
    });
    click(cellFor(container, 's-refused'));
    expect(entered).toStrictEqual(['s-refused']);
  });

  it('does not throw when no handler is wired', () => {
    const container = render({ sessions: [summary('s-1')] });
    expect(() => click(cellFor(container, 's-1'))).not.toThrow();
  });
});

describe('accessibility floor (C7.8)', () => {
  it('makes every card a real focusable control with an accessible name', () => {
    const container = render({
      sessions: [summary('s-1'), summary('s-2', { liveness: 'idle' })],
    });
    for (const cell of cells(container)) {
      expect(cell.getAttribute('role')).toBe('button');
      expect(cell.getAttribute('tabindex')).toBe('0');
      expect(cell.getAttribute('aria-label')).not.toBe(null);
      expect(cell.getAttribute('aria-label')).not.toBe('');
      cell.focus();
      expect(document.activeElement).toBe(cell);
    }
  });

  it('names the session, its liveness, its engine, its workspace and its errors', () => {
    const container = render({
      sessions: [
        summary('s-err', { workspaceMatch: false, liveness: 'live', errorCount: 2 }),
      ],
    });
    const name = cellFor(container, 's-err').getAttribute('aria-label') ?? '';
    expect(name).toContain('main s-err');
    expect(name).toContain('live');
    expect(name).toContain('cc');
    expect(name).toContain('other workspace');
    expect(name).toContain('2 tool errors');
  });

  it('says "error" singular when there is one', () => {
    const container = render({ sessions: [summary('s-one', { errorCount: 1 })] });
    expect(cellFor(container, 's-one').getAttribute('aria-label')).toContain('1 tool error');
  });

  it('carries a focus-ring rule rather than relying on the browser default', () => {
    expect(bundle).toContain(':focus-visible');
    expect(bundle).toContain('--vscode-focusBorder');
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 2 — the drag handlers are GONE
 * ------------------------------------------------------------------------ */

describe('nothing on a card is draggable (DoD 2)', () => {
  it('the card source carries no drag handler and no drag state', () => {
    const cell = componentSources.find((s) => s.path.endsWith('SessionCell.svelte'));
    expect(cell).toBeDefined();
    const matches = (cell?.text ?? '').match(/ondrag|dragging/g) ?? [];
    expect(matches).toStrictEqual([]);
  });

  it('a pointer drag across a card enters the session rather than moving it', () => {
    // The old threshold logic existed to tell a pull-aside from a click. With
    // no pull-aside there is no threshold, and a click that happens to move
    // must still enter — the failure the threshold used to cause was a card
    // that could not be clicked at all.
    const entered: string[] = [];
    const container = render({
      sessions: [summary('s-1')],
      onenter: (id: string) => entered.push(id),
    });
    const cell = cellFor(container, 's-1');
    cell.dispatchEvent(pointer('pointerdown', 100, 100));
    cell.dispatchEvent(pointer('pointermove', 140, 130));
    cell.dispatchEvent(pointer('pointerup', 140, 130));
    click(cell);
    expect(entered).toStrictEqual(['s-1']);
    expect(cell.getAttribute('transform')).toBe('translate(0 0)');
  });
});

/* ------------------------------------------------------------------------ *
 * The store seam — the deck driven by the real reducer
 * ------------------------------------------------------------------------ */

describe('driven by a real store', () => {
  it('takes its whole input from view.sessions, with no SessionState anywhere', () => {
    const view = viewOf([liveSession({ sessionId: 's-real' })]);
    const row = view.sessions[0];
    if (row === undefined) throw new Error('no summary');
    const container = render({
      sessions: view.sessions,
      selectedSessionId: view.selectedSessionId,
      degraded: view.degraded,
      now: NOW,
    });
    const cell = cellFor(container, 's-real');
    expect(cell.dataset['liveness']).toBe(row.liveness);
    expect(cell.dataset['nodes']).toBe(String(row.nodeCount));
    expect(cell.dataset['errors']).toBe(String(row.errorCount));
    expect(figure(cell, 'deck-cell-label')).toBe(row.label);
  });

  it('draws the agent and in-flight counts the STORE derived from a real tree', () => {
    // `liveSession()` is root + agent-1 + agent-2 (three agents) with exactly
    // one running tool call, `tool-agent-2`. Derived from the store rather
    // than written out, so the numbers cannot drift from the builder.
    const view = viewOf([liveSession({ sessionId: 's-real' })]);
    const row = view.sessions[0];
    if (row === undefined) throw new Error('no summary');
    expect(row.agents).toBe(3);
    expect(row.inflight).toBe(1);
    const container = render({ sessions: view.sessions, now: NOW });
    const cell = cellFor(container, 's-real');
    expect(figure(cell, 'deck-cell-agents')).toBe(`${row.agents} ag`);
    expect(figure(cell, 'deck-cell-inflight')).toBe(`${row.inflight} in flight`);
  });

  it('draws the burn the store carried, summed across the pair', () => {
    const state = liveSession({ sessionId: 's-real' });
    const view = viewOf([state]);
    const row = view.sessions[0];
    if (row === undefined || row.burn === undefined) throw new Error('no burn');
    expect(row.burn).toStrictEqual(state.burn);
    const container = render({ sessions: view.sessions, now: NOW });
    expect(figure(cellFor(container, 's-real'), 'deck-cell-tokens')).toBe(
      formatCompactTokens(row.burn.prompt + row.burn.output),
    );
    expect(figure(cellFor(container, 's-real'), 'deck-cell-tokens')).toBe('51.8k');
  });

  it('draws an em-dash when the STORE carried no burn at all', () => {
    const state = liveSession({ sessionId: 's-oc' });
    delete (state as { burn?: unknown }).burn;
    const view = viewOf([state]);
    expect(view.sessions[0]?.burn).toBeUndefined();
    const container = render({ sessions: view.sessions, now: NOW });
    expect(figure(cellFor(container, 's-oc'), 'deck-cell-tokens')).toBe(EM_DASH);
  });

  it('takes the glyph from the store, which reads an ABSENT engine as cc', () => {
    const state = liveSession({ sessionId: 's-untagged' });
    expect(state.engine).toBeUndefined();
    const view = viewOf([state]);
    expect(view.sessions[0]?.engine).toBe('cc');
    const container = render({ sessions: view.sessions, now: NOW });
    expect(figure(cellFor(container, 's-untagged'), 'deck-cell-engine')).toBe('CC');
  });

  it('renders an opencode-stamped state as OC, store to canvas', () => {
    const view = viewOf([liveSession({ sessionId: 's-oc-real', engine: 'opencode' })]);
    expect(view.sessions[0]?.engine).toBe('opencode');
    const container = render({ sessions: view.sessions, now: NOW });
    expect(figure(cellFor(container, 's-oc-real'), 'deck-cell-engine')).toBe('OC');
  });

  it('renders a codex-stamped state as CX, store to canvas (v0.6.0 Phase 3)', () => {
    const view = viewOf([liveSession({ sessionId: 's-cx-real', engine: 'codex' })]);
    expect(view.sessions[0]?.engine).toBe('codex');
    const container = render({ sessions: view.sessions, now: NOW });
    expect(figure(cellFor(container, 's-cx-real'), 'deck-cell-engine')).toBe('CX');
  });

  it('shows the badge count the store derived, and that count is not zero', () => {
    const view = viewOf([liveSession({ sessionId: 's-real' })]);
    const row = view.sessions[0];
    if (row === undefined) throw new Error('no summary');
    expect(row.errorCount).toBeGreaterThan(0);
    const container = render({ sessions: view.sessions, now: NOW });
    expect(one(container, TESTID.deckErrorBadge).dataset['count']).toBe(String(row.errorCount));
  });

  it('a session the store refused draws dashed, with no numbers read off it', () => {
    const view = viewOf([unsupportedSession({ sessionId: 's-refused' })]);
    const row = view.sessions[0];
    if (row === undefined) throw new Error('no summary');
    expect(row.refused).toBe(true);
    expect(row.nodeCount).toBe(0);
    expect(row.errorCount).toBe(0);
    expect(row.agents).toBe(0);
    expect(row.inflight).toBe(0);
    expect(row.burn).toBeUndefined();
    const container = render({ sessions: view.sessions, now: NOW });
    const cell = cellFor(container, 's-refused');
    expect(cell.classList.contains(CRACKED_CLASS)).toBe(true);
    expect(all(container, TESTID.deckErrorBadge)).toHaveLength(0);
    expect(figure(cell, 'deck-cell-tokens')).toBe(EM_DASH);
    expect(figure(cell, 'deck-cell-age')).toBe(EM_DASH);
  });

  it('dashes a session refused by a schemaMismatch message mid-flight', () => {
    const state = liveSession({ sessionId: 's-mismatch' });
    const view = viewOf([state], ['s-mismatch']);
    expect(state.liveness).toBe('live');
    const container = render({ sessions: view.sessions, now: NOW });
    const cell = cellFor(container, 's-mismatch');
    expect(cell.dataset['liveness']).toBe('unsupported');
    expect(cell.classList.contains(CRACKED_CLASS)).toBe(true);
    expect(animated(container)).toHaveLength(0);
  });

  it('orders a real store’s rows by the sort, not by snapshot order', () => {
    const ids = ['s-x', 's-y', 's-z'];
    const view = viewOf(
      ids.map((id, index) =>
        liveSession({
          sessionId: id,
          liveness: index === 2 ? 'live' : 'ended',
          root: agent({
            id: 'root',
            kind: 'main',
            label: `main ${id}`,
            spawnDepth: 0,
            startedAt: 1_000 + index,
            children: [tool({ id: 't1' })],
          }),
          spawnEdges: [],
        }),
      ),
    );
    const container = render({ sessions: view.sessions, now: NOW });
    // Live first: `s-z` is the only live one, so it leads whatever order the
    // host sent. That is the sort doing its job rather than the array's.
    expect(view.sessions.map((s) => s.sessionId)).toStrictEqual(ids);
    expect(cells(container).map((c) => c.dataset['sessionId'])[0]).toBe('s-z');
  });

  it('animates nothing for a settled session out of the real store', () => {
    const view = viewOf([settledSession({ sessionId: 's-settled' })]);
    const container = render({ sessions: view.sessions, now: NOW });
    expect(cells(container)).toHaveLength(1);
    expect(animated(container)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ *
 * The whole panel — the two claims that are about WIRING, not a component
 * ------------------------------------------------------------------------ */

describe('through the mounted panel (DoD 7.4, the survival half)', () => {
  interface Panel {
    container: HTMLElement;
    store: Store;
    dispose: () => void;
  }

  const panels: Panel[] = [];

  function panel(): Panel {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const started = panelHarness.start(container, { postMessage: () => {} });
    panelHarness.flushSync();
    const made: Panel = {
      container,
      store: started.store,
      dispose: () => {
        started.dispose();
        container.remove();
      },
    };
    panels.push(made);
    return made;
  }

  afterEach(() => {
    while (panels.length > 0) panels.pop()?.dispose();
  });

  function stageTransform(p: Panel): string {
    return one(p.container, TESTID.deckStage).getAttribute('transform') ?? '';
  }

  it('keeps the transform across a snapshot AND a diff — a new event never resets it', () => {
    const p = panel();
    panelHarness.flushSync(() => {
      p.store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    });
    panelHarness.flushSync(() => {
      p.store.panDeck(45, -20);
      p.store.zoomDeck(1, 300, 200);
    });
    const moved = p.store.getView().deckView;
    expect(moved).not.toStrictEqual({ x: 0, y: 0, k: 1 });
    const drawn = stageTransform(p);
    expect(drawn).toBe(transformAttr(moved));

    // A fresh snapshot: the host's authoritative re-statement.
    panelHarness.flushSync(() => {
      p.store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    });
    expect(p.store.getView().deckView).toStrictEqual(moved);
    expect(stageTransform(p)).toBe(drawn);

    // And a diff: one more tool call arriving mid-session.
    panelHarness.flushSync(() => {
      p.store.handleMessage({
        type: 'diff',
        sessionId: 'session-live',
        patch: {
          tree: [
            {
              op: 'insertNode',
              parentId: 'root',
              afterId: null,
              node: tool({ id: 'tool-new', toolName: 'Grep', status: 'running' }),
            },
          ],
        },
      });
    });
    expect(p.store.getView().deckView).toStrictEqual(moved);
    expect(stageTransform(p)).toBe(drawn);
  });

  it('DoD 7.7: the engine filter SURVIVES entering and leaving a session', () => {
    // THE BUG, END TO END. `App.svelte` mounts `<Deck>` only at
    // `altitude === 'deck'`, so a session visit destroys the component. While
    // `engineFilter` was `$state` inside it, that reset the user's chosen
    // engine to `all` on every return — beside a liveness filter that
    // persisted, with nothing on screen explaining the difference.
    //
    // Driven through the mounted panel rather than the component, because the
    // defect is in the WIRING: a component test cannot unmount and remount the
    // component the way an altitude change does, and the store test cannot see
    // that the chip came back active.
    const p = panel();
    panelHarness.flushSync(() => {
      p.store.handleMessage({
        type: 'snapshot',
        sessions: [
          liveSession(),
          liveSession({ sessionId: 'session-oc', engine: 'opencode' }),
        ],
      });
    });

    const chipFor = (engine: string): HTMLElement => {
      const found = all(p.container, 'deck-engine-chip').find(
        (c) => c.dataset['engine'] === engine,
      );
      if (found === undefined) throw new Error(`no ${engine} chip`);
      return found;
    };
    const shown = (): string[] =>
      all(p.container, TESTID.deckBlob).map((c) => c.dataset['sessionId'] ?? '');

    expect(shown().sort()).toStrictEqual(['session-live', 'session-oc']);

    // Pick OpenCode, through the real chip.
    panelHarness.flushSync(() => {
      chipFor('oc').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(p.store.getView().engineFilter).toBe('oc');
    expect(one(p.container, TESTID.deck).dataset['engineFilter']).toBe('oc');
    expect(shown()).toStrictEqual(['session-oc']);

    // Into a session — the deck unmounts entirely — and back out.
    panelHarness.flushSync(() => {
      p.store.enterSession('session-live');
    });
    expect(all(p.container, TESTID.deck)).toHaveLength(0);
    panelHarness.flushSync(() => {
      p.store.escape();
    });

    // Back at the deck. Before the fix this read 'all' and showed both cards.
    expect(one(p.container, TESTID.deck).dataset['engineFilter']).toBe('oc');
    expect(chipFor('oc').dataset['active']).toBe('true');
    expect(chipFor('all').dataset['active']).toBe('false');
    expect(shown()).toStrictEqual(['session-oc']);
    // The count chip still tells the truth about what exists.
    expect(one(p.container, 'deck-count').textContent).toBe('1 of 2');
  });

  it('DoD 7.7: the two filters are independent, and both survive the trip', () => {
    // The liveness filter is `App.svelte`'s own chip row, outside `<Deck>`;
    // the engine filter is inside it. Both are store state now, so this asserts
    // that moving one never moves the other and that neither is reset by the
    // altitude change that used to reset one of them.
    const p = panel();
    panelHarness.flushSync(() => {
      p.store.handleMessage({
        type: 'snapshot',
        sessions: [
          liveSession(),
          liveSession({ sessionId: 'session-oc', engine: 'opencode' }),
          liveSession({ sessionId: 'session-oc-idle', engine: 'opencode', liveness: 'idle' }),
        ],
      });
    });
    panelHarness.flushSync(() => {
      p.store.setEngineFilter('oc');
      p.store.setLivenessFilter('idle');
    });
    expect(all(p.container, TESTID.deckBlob).map((c) => c.dataset['sessionId'])).toStrictEqual([
      'session-oc-idle',
    ]);

    panelHarness.flushSync(() => {
      p.store.enterSession('session-oc');
    });
    panelHarness.flushSync(() => {
      p.store.escape();
    });

    const view = p.store.getView();
    expect({ engine: view.engineFilter, liveness: view.livenessFilter }).toStrictEqual({
      engine: 'oc',
      liveness: 'idle',
    });
    expect(all(p.container, TESTID.deckBlob).map((c) => c.dataset['sessionId'])).toStrictEqual([
      'session-oc-idle',
    ]);
    // And the liveness chip row, which App owns, agrees with the store.
    const activeLiveness = all(p.container, TESTID.filterChip)
      .filter((c) => c.dataset['active'] === 'true')
      .map((c) => c.dataset['filter']);
    expect(activeLiveness).toStrictEqual(['idle']);
  });

  it('routes a real wheel gesture through zoomAbout at the deck limits', () => {
    // The wiring claim: the component reports NOTCHES and the store applies
    // `viewport.zoomAbout`. A component still reporting a multiplicative
    // factor would land somewhere else entirely, and nothing type-checks the
    // `.svelte` file that passes it along.
    const p = panel();
    panelHarness.flushSync(() => {
      p.store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    });
    const before = p.store.getView().deckView;
    const field = p.container.querySelector('svg');
    if (field === null) throw new Error('no field');
    panelHarness.flushSync(() => {
      field.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: -120,
          clientX: 300,
          clientY: 200,
        }),
      );
    });
    expect(p.store.getView().deckView).toStrictEqual(
      zoomAbout(before, 300, 200, 1, DECK_ZOOM_LIMITS),
    );
    expect(p.store.getView().deckView.k).toBeGreaterThan(before.k);
  });
});

/* ------------------------------------------------------------------------ *
 * The stylesheet seam and theming
 * ------------------------------------------------------------------------ */

describe('every contract class the deck applies also carries style', () => {
  // The components build these class names from `canvas-contract.ts`, so the
  // DOM side cannot drift. CSS cannot import a constant, so the stylesheet
  // spells each name a second time — and Svelte PRUNES a scoped rule it cannot
  // prove is used, which would silently remove the styling while every DOM
  // assertion above still passed.
  for (const cls of [
    CRACKED_CLASS,
    HOLLOW_LIVE_CLASS,
    FOREIGN_CLASS,
    REDUCED_MOTION_CLASS,
    ANIMATED_CLASSES[0],
    ANIMATED_CLASSES[1],
  ]) {
    it(`styles .${cls}`, () => {
      expect(bundle).toContain(`.${cls}`);
    });
  }
});

describe('the testids this package spells twice', () => {
  // `canvas-contract.ts` holds every name that crosses a package boundary and
  // is not this package's file to edit. These names have ONE owner — the deck
  // — so they live in the component, which means this file spells them a
  // second time. That seam is closed by assertion rather than by care.
  for (const testId of [
    'deck-bar',
    'deck-engine-chip',
    'deck-layout-option',
    'deck-sort-option',
    'deck-count',
    'deck-waiting',
    'deck-cell-engine',
    'deck-cell-label',
    'deck-cell-agents',
    'deck-cell-inflight',
    'deck-cell-tokens',
    'deck-cell-cost',
    'deck-cell-status',
    'deck-cell-age',
    'deck-cell-border',
    'deck-cell-pulse',
    'deck-cell-selection',
    'deck-cell-foreign',
  ]) {
    it(`emits "${testId}" from a component and not only from this file`, () => {
      const written = componentSources.some((s) =>
        s.text.includes(`data-testid="${testId}"`),
      );
      expect({ testId, written }).toStrictEqual({ testId, written: true });
    });
  }
});

describe('theming', () => {
  it('hardcodes no colour anywhere in either component', () => {
    // The frozen mockup carries a dark palette because it lives outside VS
    // Code. The shipped renderer takes every colour from the theme, so a hex
    // literal in these two files is a bug rather than a style preference.
    expect(componentSources).toHaveLength(2);
    for (const { path, text } of componentSources) {
      const hexes = text.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect({ path, hexes }).toStrictEqual({ path, hexes: [] });
      const functional = text.match(/\b(?:rgba?|hsla?)\s*\(/g) ?? [];
      expect({ path, functional }).toStrictEqual({ path, functional: [] });
    }
  });

  it('takes every colour it does use from a --vscode variable', () => {
    for (const { path, text } of componentSources) {
      const style = text.slice(text.indexOf('<style>'));
      const colourProps = style.match(/(?:^|\n)\s*(?:fill|stroke|color|background):[^;]+;/g) ?? [];
      for (const decl of colourProps) {
        if (/:\s*(?:none|inherit|transparent|currentColor)\s*;/.test(decl)) continue;
        expect({ path, decl }).toStrictEqual({ path, decl: expect.stringContaining('--vscode-') });
      }
    }
  });
});
