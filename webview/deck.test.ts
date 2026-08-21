// @vitest-environment jsdom
//
// Altitude 0 — the deck (spec C7.1), and the DECK-LEVEL half of C7.3's
// normative state matrix, asserted against the REAL esbuild + Svelte bundle.
//
// WHY A BUNDLE. There is no vitest svelte plugin in this repo, so a `.svelte`
// import cannot be transformed in-process. `testkit.ts:loadHarness` bundles
// `harness.ts`, whose entry is fixed and whose `start()` mounts `App.svelte`;
// `App.svelte` does not mount the deck yet and is not this package's file to
// edit. So this file bundles `Deck.svelte` directly through the same pipeline,
// from an in-memory entry point, exactly the way `inspector.test.ts` does.
// Nothing is written to disk (G1) — the entry goes to esbuild as `stdin` and
// the bundle comes back on the child's stdout. That duplication is known and
// reported; it collapses when the app mounts the deck.
//
// WHAT FEEDS THE COMPONENT. `SessionSummary`, the store's own view row. Most
// tests build one as a literal so a single field can be varied in isolation;
// the last section drives the components from a REAL store instead, because
// the fields the deck now depends on — `refused`, `nodeCount`, `errorCount` —
// are the store's derivations, and a literal cannot prove the store actually
// produces what the deck reads. That section is the seam check; the literals
// are the state matrix.
//
// WHY THE NAMES ARE IMPORTED. Every testid and every contract class comes from
// `canvas-contract.ts`, never spelled as a literal. Selecting on a literal is
// how a renamed name becomes a silently skipped assertion instead of a
// failure: `all()` returns an empty array and a `.length === 0` check passes
// for the wrong reason. The same rule is why the CSS block's own literals are
// checked back against the constants below — CSS cannot import a TypeScript
// name, so the stylesheet is the one place a class is spelled twice, and that
// seam is closed by assertion rather than by care.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionState } from '../src/model/events.js';
import {
  ANIMATED_CLASSES,
  CRACKED_CLASS,
  FOREIGN_CLASS,
  HOLLOW_LIVE_CLASS,
  REDUCED_MOTION_CLASS,
  TESTID,
} from './canvas-contract.js';
import {
  CONSTELLATION_CAP,
  DECK_RADIUS_MIN,
  blobPath,
  constellationPoints,
  deckLayout,
  hashSessionId,
} from './layout.js';
import type { SessionSummary } from './store.js';
import { createStore } from './store.js';
import { all, one } from './testkit.js';
import { agent, liveSession, tool, unsupportedSession } from './testdata.js';

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
/** The bundled JavaScript, kept so the injected stylesheet can be asserted on. */
let bundle = '';
/** The two component sources, read once, for the no-hardcoded-colour check. */
let componentSources: { path: string; text: string }[] = [];

beforeAll(async () => {
  const cp = (await import(/* @vite-ignore */ CHILD_PROCESS)) as unknown as ChildProcessModule;
  bundle = cp.execFileSync('node', ['--input-type=module', '-e', BUILD_SCRIPT], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const factory = new Function(`${bundle}\nreturn ${GLOBAL_NAME};`) as () => DeckHarness;
  harness = factory();

  const fs = (await import(/* @vite-ignore */ FS)) as unknown as FsModule;
  componentSources = ['webview/Deck.svelte', 'webview/SessionBlob.svelte'].map((path) => ({
    path,
    text: fs.readFileSync(path, 'utf8'),
  }));
}, 60_000);

interface Mounted {
  container: HTMLElement;
  dispose: () => void;
}

const mounted: Mounted[] = [];

function render(props: Record<string, unknown>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const app = harness.mount(harness.Deck, { target: container, props });
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
 * Summary builders. Literals, so one field can be varied at a time; the
 * store-driven section below is what proves the store emits these shapes.
 * ------------------------------------------------------------------------ */

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
    ...overrides,
  };
}

/** A summary shaped the way the store shapes a refused one: both counts 0. */
function refusedSummary(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return summary(sessionId, {
    refused: true,
    liveness: 'unsupported',
    nodeCount: 0,
    errorCount: 0,
    ...overrides,
  });
}

/** Feed a store one snapshot and hand back the view it produces. */
function viewOf(states: readonly SessionState[], mismatchIds: readonly string[] = []) {
  const store = createStore();
  store.handleMessage({ type: 'snapshot', sessions: [...states] });
  for (const sessionId of mismatchIds) store.handleMessage({ type: 'schemaMismatch', sessionId });
  return store.getView();
}

/** Every element carrying any class listed in `ANIMATED_CLASSES`. */
function animated(root: ParentNode): Element[] {
  return [...root.querySelectorAll('*')].filter((el) =>
    ANIMATED_CLASSES.some((cls) => el.classList.contains(cls)),
  );
}

function blobs(root: ParentNode): HTMLElement[] {
  return all(root, TESTID.deckBlob);
}

function blobFor(root: ParentNode, sessionId: string): HTMLElement {
  const found = blobs(root).find((b) => b.dataset['sessionId'] === sessionId);
  if (found === undefined) throw new Error(`no blob for ${sessionId}`);
  return found;
}

/**
 * Click an element by dispatching the event, not by calling `.click()`.
 *
 * `HTMLElement.prototype.click` does not exist on an `SVGElement` in jsdom, and
 * every blob here is an SVG `<g>`. Dispatching is also the more faithful of the
 * two: it is what a pointer produces in the real panel.
 */
function click(element: Element): void {
  harness.flushSync(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function membraneOf(blob: HTMLElement): Element {
  const found = blob.querySelector('path.membrane');
  if (found === null) throw new Error('no membrane path in the blob');
  return found;
}

function constellationOf(root: ParentNode): HTMLElement[] {
  return all(root, TESTID.deckConstellation);
}

/* ------------------------------------------------------------------------ *
 * The empty deck — C7.3's last row
 * ------------------------------------------------------------------------ */

describe('the empty deck', () => {
  it('renders one quiet line and not a single blob', () => {
    const container = render({ sessions: [] });
    const deck = one(container, TESTID.deck);
    expect(deck.dataset['sessions']).toBe('0');
    expect(one(container, TESTID.deckEmpty).textContent).toBe('No sessions in this workspace.');
    expect(blobs(container)).toHaveLength(0);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders no empty line as soon as there is a session', () => {
    const container = render({ sessions: [summary('s-1')] });
    expect(all(container, TESTID.deckEmpty)).toHaveLength(0);
    expect(blobs(container)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------ *
 * Ordering and geometry
 * ------------------------------------------------------------------------ */

describe('ordering and geometry', () => {
  const ids = ['s-a', 's-b', 's-c', 's-d'];
  const sessions = ids.map((id) => summary(id));

  it('renders the sessions in exactly the order it was handed them', () => {
    const container = render({ sessions });
    expect(blobs(container).map((b) => b.dataset['sessionId'])).toStrictEqual(ids);
  });

  it('keeps DOM order when the same list is re-rendered — nothing re-sorts', () => {
    // Store order is host-snapshot order and this component adds no sort of
    // its own; a component that ordered by liveness would reshuffle here,
    // because these four differ in liveness.
    const mixed = [
      summary('s-a', { liveness: 'ended' }),
      summary('s-b', { liveness: 'live' }),
      summary('s-c', { liveness: 'idle' }),
      summary('s-d', { liveness: 'ended' }),
    ];
    const container = render({ sessions: mixed });
    expect(blobs(container).map((b) => b.dataset['sessionId'])).toStrictEqual(ids);
  });

  it('feeds the summaries to deckLayout unconverted and draws what it returns', () => {
    // A `SessionSummary` is a `DeckSession`: `{ sessionId, nodeCount }` and
    // more. No conversion step means no conversion step to skip.
    const container = render({ sessions });
    const placed = deckLayout(sessions);
    for (const placement of placed) {
      const blob = blobFor(container, placement.sessionId);
      expect(membraneOf(blob).getAttribute('d')).toBe(
        blobPath(placement.x, placement.y, placement.R, hashSessionId(placement.sessionId)),
      );
    }
  });

  it('sizes a blob from nodeCount, and a bigger session draws bigger', () => {
    const small = summary('s-small', { nodeCount: 2 });
    const large = summary('s-large', { nodeCount: 400 });
    const placed = deckLayout([small, large]);
    expect(placed[1]?.R).toBeGreaterThan(placed[0]?.R ?? 0);
    const container = render({ sessions: [small, large] });
    expect(membraneOf(blobFor(container, 's-large')).getAttribute('d')).toBe(
      blobPath(
        placed[1]?.x ?? 0,
        placed[1]?.y ?? 0,
        placed[1]?.R ?? 0,
        hashSessionId('s-large'),
      ),
    );
  });

  it('gives a session the same silhouette across renders — shape is the id', () => {
    const first = render({ sessions: [summary('s-shape')] });
    const second = render({ sessions: [summary('s-shape')] });
    expect(membraneOf(blobFor(first, 's-shape')).getAttribute('d')).toBe(
      membraneOf(blobFor(second, 's-shape')).getAttribute('d'),
    );
  });

  it('fits the viewport with a viewBox of four finite numbers', () => {
    const container = render({ sessions });
    const svg = container.querySelector('svg');
    const parts = (svg?.getAttribute('viewBox') ?? '').split(' ').map(Number);
    expect(parts).toHaveLength(4);
    for (const n of parts) expect(Number.isFinite(n)).toBe(true);
    expect(parts[2]).toBeGreaterThan(0);
    expect(parts[3]).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ *
 * C7.1 — the constellation
 * ------------------------------------------------------------------------ */

describe('the interior constellation (C7.1)', () => {
  it('draws one dot per node, at the coordinates layout.ts returns', () => {
    const state = summary('s-con', { nodeCount: 7 });
    const container = render({ sessions: [state] });
    const placement = deckLayout([state])[0];
    if (placement === undefined) throw new Error('unplaced');
    const expected = constellationPoints(
      placement.x,
      placement.y,
      placement.R,
      7,
      hashSessionId('s-con'),
    );
    expect(expected).toHaveLength(7);
    const drawn = constellationOf(container).map((c) => ({
      x: Number(c.getAttribute('cx')),
      y: Number(c.getAttribute('cy')),
    }));
    expect(drawn).toStrictEqual(expected.map((p) => ({ x: p.x, y: p.y })));
  });

  it('seeds the constellation exactly as it seeds the silhouette', () => {
    // Same size, different id: the dots must move, because the seed is the id.
    const a = summary('s-one', { nodeCount: 9 });
    const b = summary('s-two', { nodeCount: 9 });
    const container = render({ sessions: [a, b] });
    const first = constellationOf(blobFor(container, 's-one')).map((c) => c.getAttribute('cx'));
    const second = constellationOf(blobFor(container, 's-two')).map((c) => c.getAttribute('cx'));
    expect(first).toHaveLength(9);
    expect(second).toHaveLength(9);
    // Placements differ too, so compare the offsets from each blob's centre.
    const placed = deckLayout([a, b]);
    const offsets = (values: (string | null)[], cx: number): number[] =>
      values.map((v) => Number(v) - cx);
    expect(offsets(first, placed[0]?.x ?? 0)).not.toStrictEqual(
      offsets(second, placed[1]?.x ?? 0),
    );
  });

  it('saturates at the cap: 1,000 nodes draw exactly CONSTELLATION_CAP dots', () => {
    const container = render({ sessions: [summary('s-big', { nodeCount: 1_000 })] });
    expect(constellationOf(container)).toHaveLength(CONSTELLATION_CAP);
    expect(blobFor(container, 's-big').dataset['constellation']).toBe(String(CONSTELLATION_CAP));
  });

  it('draws no dots at all for a refused session — no number is read off it', () => {
    const container = render({ sessions: [refusedSummary('s-refused')] });
    expect(constellationOf(container)).toHaveLength(0);
  });

  it('hides the dots from assistive technology; the blob carries the name', () => {
    const container = render({ sessions: [summary('s-con', { nodeCount: 4 })] });
    const group = blobFor(container, 's-con').querySelector('g.constellation');
    expect(group?.getAttribute('aria-hidden')).toBe('true');
  });
});

/* ------------------------------------------------------------------------ *
 * C7.3 — the state matrix, deck rows
 * ------------------------------------------------------------------------ */

describe('membrane by liveness (C7.3 rows 1-3)', () => {
  for (const liveness of ['live', 'idle', 'ended'] as const) {
    it(`renders a ${liveness} session's membrane as ${liveness}`, () => {
      const container = render({ sessions: [summary('s-1', { liveness })] });
      const blob = blobFor(container, 's-1');
      expect(blob.dataset['liveness']).toBe(liveness);
      expect(blob.dataset['refused']).toBe('false');
      expect(blob.classList.contains(CRACKED_CLASS)).toBe(false);
    });
  }

  it('animates the live one and leaves idle and ended still', () => {
    const container = render({
      sessions: [
        summary('s-live', { liveness: 'live' }),
        summary('s-idle', { liveness: 'idle' }),
        summary('s-ended', { liveness: 'ended' }),
      ],
    });
    expect(animated(blobFor(container, 's-live')).length).toBeGreaterThan(0);
    expect(animated(blobFor(container, 's-idle'))).toHaveLength(0);
    expect(animated(blobFor(container, 's-ended'))).toHaveLength(0);
  });
});

describe('unsupported / refused (C7.3, G3)', () => {
  it('cracks the membrane and draws the crack', () => {
    const container = render({ sessions: [refusedSummary('s-refused')] });
    const blob = blobFor(container, 's-refused');
    expect(blob.dataset['liveness']).toBe('unsupported');
    expect(blob.dataset['refused']).toBe('true');
    expect(blob.classList.contains(CRACKED_CLASS)).toBe(true);
    expect(membraneOf(blob).classList.contains(CRACKED_CLASS)).toBe(true);
    expect(blob.querySelectorAll('path.crack')).toHaveLength(1);
  });

  it('cracks a session refused while its own liveness still says live', () => {
    // `schemaMismatch` refuses without changing the liveness the last snapshot
    // delivered. The summary carries both, and `displayLiveness` reconciles
    // them in one place — this component holds no second opinion.
    const state = summary('s-mismatch', { liveness: 'live', refused: true });
    const container = render({ sessions: [state] });
    const blob = blobFor(container, 's-mismatch');
    expect(state.liveness).toBe('live');
    expect(blob.dataset['liveness']).toBe('unsupported');
    expect(blob.classList.contains(CRACKED_CLASS)).toBe(true);
  });

  it('never animates a refused session, whatever its wire liveness says', () => {
    const container = render({
      sessions: [summary('s-mismatch', { liveness: 'live', refused: true })],
    });
    expect(animated(container)).toHaveLength(0);
  });

  it('draws a refused blob at DECK_RADIUS_MIN, saying nothing about content', () => {
    // The store reports `nodeCount: 0` for a refused session (G3: a tree we
    // declined to trust yields no number), so the blob is the floor size. A
    // large cracked blob would be asserting "there is a lot in here" from a
    // layout the fingerprint refused.
    const refusedRow = refusedSummary('s-refused');
    const placed = deckLayout([refusedRow])[0];
    expect(placed?.R).toBe(DECK_RADIUS_MIN);
    const container = render({ sessions: [refusedRow] });
    expect(membraneOf(blobFor(container, 's-refused')).getAttribute('d')).toBe(
      blobPath(placed?.x ?? 0, placed?.y ?? 0, DECK_RADIUS_MIN, hashSessionId('s-refused')),
    );
  });

  it('draws no crack on a session that was not refused', () => {
    const container = render({ sessions: [summary('s-ok')] });
    expect(container.querySelectorAll('path.crack')).toHaveLength(0);
  });
});

describe('degraded — hooks silent (C7.3, G2)', () => {
  const sessions = [
    summary('s-live', { liveness: 'live' }),
    summary('s-idle', { liveness: 'idle' }),
    summary('s-ended', { liveness: 'ended' }),
  ];

  it('hollows every live membrane and only the live ones', () => {
    const container = render({ sessions, degraded: true });
    expect(one(container, TESTID.deck).dataset['degraded']).toBe('true');
    expect(membraneOf(blobFor(container, 's-live')).classList.contains(HOLLOW_LIVE_CLASS)).toBe(
      true,
    );
    for (const id of ['s-idle', 's-ended']) {
      expect(membraneOf(blobFor(container, id)).classList.contains(HOLLOW_LIVE_CLASS)).toBe(false);
    }
  });

  it('hollows nothing while the hook tap is healthy', () => {
    const container = render({ sessions, degraded: false });
    expect(
      [...container.querySelectorAll('*')].filter((el) =>
        el.classList.contains(HOLLOW_LIVE_CLASS),
      ),
    ).toHaveLength(0);
  });

  it('marks the live blob as inferred rather than hook-confirmed', () => {
    const container = render({ sessions, degraded: true });
    expect(blobFor(container, 's-live').dataset['livenessInferred']).toBe('true');
  });

  it('still animates a live membrane while degraded — the value is inferred, not absent', () => {
    const container = render({ sessions, degraded: true });
    expect(animated(blobFor(container, 's-live')).length).toBeGreaterThan(0);
  });
});

describe('tool errors aggregate to a deck-level badge (C7.3)', () => {
  it('renders the count the store derived, and nothing it derived itself', () => {
    const container = render({ sessions: [summary('s-err', { errorCount: 3 })] });
    const badge = one(container, TESTID.deckErrorBadge);
    expect(badge.textContent).toBe('3');
    expect(badge.dataset['count']).toBe('3');
    expect(blobFor(container, 's-err').dataset['errors']).toBe('3');
  });

  it('renders no badge at all when nothing errored', () => {
    const container = render({ sessions: [summary('s-clean')] });
    expect(all(container, TESTID.deckErrorBadge)).toHaveLength(0);
    expect(blobFor(container, 's-clean').dataset['errors']).toBe('0');
  });

  it('carries one badge per session, on the session that owns the errors', () => {
    const container = render({
      sessions: [summary('s-clean'), summary('s-err', { errorCount: 2 })],
    });
    expect(all(container, TESTID.deckErrorBadge)).toHaveLength(1);
    expect(
      blobFor(container, 's-err').querySelectorAll(`[data-testid="${TESTID.deckErrorBadge}"]`),
    ).toHaveLength(1);
  });
});

describe('workspaceMatch: false (C7.3)', () => {
  it('ghosts the blob and tags it "other workspace"', () => {
    const container = render({
      sessions: [summary('s-mine'), summary('s-theirs', { workspaceMatch: false })],
    });
    const foreign = blobFor(container, 's-theirs');
    expect(foreign.classList.contains(FOREIGN_CLASS)).toBe(true);
    expect(foreign.dataset['foreign']).toBe('true');
    expect(foreign.textContent).toContain('other workspace');

    const mine = blobFor(container, 's-mine');
    expect(mine.classList.contains(FOREIGN_CLASS)).toBe(false);
    expect(mine.textContent).not.toContain('other workspace');
  });
});

/* ------------------------------------------------------------------------ *
 * C7.6 — motion is a reserved semantic channel, with its negative control
 * ------------------------------------------------------------------------ */

describe('the motion invariant (C7.6)', () => {
  it('NEGATIVE CONTROL: every session ended -> exactly zero animated elements', () => {
    const container = render({
      sessions: ['s-1', 's-2', 's-3', 's-4', 's-5'].map((id) =>
        summary(id, { liveness: 'ended', nodeCount: 40 }),
      ),
    });
    expect(blobs(container)).toHaveLength(5);
    // Constellation dots are in the DOM in quantity here, which is the point:
    // 200 of them and still zero animated elements.
    expect(constellationOf(container).length).toBeGreaterThan(0);
    expect(animated(container)).toHaveLength(0);
  });

  it('animates exactly the live blobs and nothing else', () => {
    const sessions = [
      summary('s-live-1', { liveness: 'live' }),
      summary('s-idle', { liveness: 'idle' }),
      summary('s-live-2', { liveness: 'live' }),
      summary('s-ended', { liveness: 'ended' }),
    ];
    const container = render({ sessions });
    // Two live sessions, each carrying a breathing wrap and a pulse ring.
    expect(animated(container)).toHaveLength(4);
    for (const el of animated(container)) {
      const blob = el.closest(`[data-testid="${TESTID.deckBlob}"]`) as HTMLElement | null;
      expect(blob?.dataset['liveness']).toBe('live');
    }
  });

  it('gives a constellation dot no animated class AND no animated ancestor', () => {
    // The ancestor half is the one that matters. A dot nested inside the
    // breathing wrap would inherit its transform — animated in fact — while a
    // class-counting control still read zero, which is the one failure
    // direction counting classes cannot see.
    const container = render({
      sessions: [summary('s-live', { liveness: 'live', nodeCount: 30 })],
    });
    const dots = constellationOf(container);
    expect(dots).toHaveLength(30);
    for (const dot of dots) {
      for (const cls of ANIMATED_CLASSES) {
        expect(dot.classList.contains(cls)).toBe(false);
        expect(dot.closest(`.${cls}`)).toBeNull();
      }
    }
  });

  it('uses only classes the contract lists, and both of them', () => {
    const container = render({ sessions: [summary('s-live', { liveness: 'live' })] });
    const classes = new Set<string>();
    for (const el of animated(container)) for (const c of el.classList) classes.add(c);
    const carried = ANIMATED_CLASSES.filter((c) => classes.has(c));
    // `is-flowing` is the filament's, in the session interior; this altitude
    // carries the other two.
    expect(carried).toStrictEqual([ANIMATED_CLASSES[0], ANIMATED_CLASSES[1]]);
  });

  it('puts the animation-bearing classes on elements the stylesheet animates', () => {
    for (const cls of [ANIMATED_CLASSES[0], ANIMATED_CLASSES[1]]) {
      expect(bundle).toContain(`.${cls}`);
    }
    expect(bundle).toContain('animation:');
  });
});

describe('reduced motion (C7.6, C7.8)', () => {
  it('puts the reduced-motion class on the deck root when asked', () => {
    const container = render({ sessions: [summary('s-1')], reducedMotion: true });
    expect(one(container, TESTID.deck).classList.contains(REDUCED_MOTION_CLASS)).toBe(true);
  });

  it('leaves the class off when the user did not ask for it', () => {
    const container = render({ sessions: [summary('s-1')] });
    expect(one(container, TESTID.deck).classList.contains(REDUCED_MOTION_CLASS)).toBe(false);
  });

  it('SWAPS the animation rather than removing the semantics', () => {
    // The live blob still says it is live and still carries the semantic
    // classes; only the motion is swapped for a static variant. Dropping the
    // classes instead would make the reduced-motion path indistinguishable
    // from an ended session.
    const container = render({
      sessions: [summary('s-live', { liveness: 'live' })],
      reducedMotion: true,
    });
    expect(animated(blobFor(container, 's-live')).length).toBeGreaterThan(0);
  });

  it('carries a stylesheet rule keyed to the contract class name', () => {
    expect(bundle).toContain(`.${REDUCED_MOTION_CLASS}`);
  });
});

/* ------------------------------------------------------------------------ *
 * C7.8 — accessibility floor, deck level
 * ------------------------------------------------------------------------ */

describe('accessibility floor (C7.8)', () => {
  it('makes every blob a real focusable control with an accessible name', () => {
    const container = render({
      sessions: [summary('s-1'), summary('s-2', { liveness: 'idle' })],
    });
    for (const blob of blobs(container)) {
      expect(blob.getAttribute('role')).toBe('button');
      expect(blob.getAttribute('tabindex')).toBe('0');
      expect(blob.getAttribute('aria-label')).not.toBe(null);
      expect(blob.getAttribute('aria-label')).not.toBe('');
      blob.focus();
      expect(document.activeElement).toBe(blob);
    }
  });

  it('names the session, its liveness, its workspace and its errors', () => {
    const container = render({
      sessions: [
        summary('s-err', { workspaceMatch: false, liveness: 'live', errorCount: 2 }),
      ],
    });
    const name = blobFor(container, 's-err').getAttribute('aria-label') ?? '';
    expect(name).toContain('main s-err');
    expect(name).toContain('live');
    expect(name).toContain('other workspace');
    expect(name).toContain('2 tool errors');
  });

  it('says "error" singular when there is one', () => {
    const container = render({ sessions: [summary('s-one', { errorCount: 1 })] });
    expect(blobFor(container, 's-one').getAttribute('aria-label')).toContain('1 tool error');
  });

  it('marks the store’s selected session current, the same way the rail does', () => {
    const container = render({
      sessions: [summary('s-1'), summary('s-2')],
      selectedSessionId: 's-2',
    });
    expect(blobFor(container, 's-1').dataset['selected']).toBe('false');
    expect(blobFor(container, 's-1').getAttribute('aria-current')).toBe('false');
    expect(blobFor(container, 's-2').dataset['selected']).toBe('true');
    expect(blobFor(container, 's-2').getAttribute('aria-current')).toBe('true');
  });

  it('carries a focus-ring rule rather than relying on the browser default', () => {
    expect(bundle).toContain(':focus-visible');
    expect(bundle).toContain('--vscode-focusBorder');
  });

  it('follows store order in the DOM, which is what a screen reader walks', () => {
    // C7.8: "screen-reader order follows the store, not the geometry". The
    // spiral places blob 2 above and left of blob 1; DOM order is unmoved.
    const ids = ['s-1', 's-2', 's-3'];
    const sessions = ids.map((id) => summary(id));
    const container = render({ sessions });
    const placed = deckLayout(sessions);
    expect(placed.map((p) => p.sessionId)).toStrictEqual(ids);
    expect(blobs(container).map((b) => b.dataset['sessionId'])).toStrictEqual(ids);
  });
});

describe('entering a session (C7.7, C7.8)', () => {
  it('reports the session id on click, and posts no message of its own', () => {
    const entered: string[] = [];
    const container = render({
      sessions: [summary('s-1'), summary('s-2')],
      onenter: (id: string) => entered.push(id),
    });
    click(blobFor(container, 's-2'));
    expect(entered).toStrictEqual(['s-2']);
  });

  for (const key of ['Enter', ' ']) {
    it(`enters the session on ${key === ' ' ? 'Space' : key}`, () => {
      const entered: string[] = [];
      const container = render({
        sessions: [summary('s-1')],
        onenter: (id: string) => entered.push(id),
      });
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      harness.flushSync(() => blobFor(container, 's-1').dispatchEvent(event));
      expect(entered).toStrictEqual(['s-1']);
      expect(event.defaultPrevented).toBe(true);
    });
  }

  it('ignores keys that are not an activation', () => {
    const entered: string[] = [];
    const container = render({
      sessions: [summary('s-1')],
      onenter: (id: string) => entered.push(id),
    });
    harness.flushSync(() =>
      blobFor(container, 's-1').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }),
      ),
    );
    expect(entered).toStrictEqual([]);
  });

  it('does not throw when no handler is wired', () => {
    const container = render({ sessions: [summary('s-1')] });
    expect(() => click(blobFor(container, 's-1'))).not.toThrow();
  });
});

/* ------------------------------------------------------------------------ *
 * The store seam — the deck driven by the real reducer, not by literals
 * ------------------------------------------------------------------------ */

describe('driven by a real store', () => {
  it('takes its whole input from view.sessions, with no SessionState anywhere', () => {
    const view = viewOf([liveSession({ sessionId: 's-real' })]);
    const container = render({
      sessions: view.sessions,
      selectedSessionId: view.selectedSessionId,
      degraded: view.degraded,
    });
    const blob = blobFor(container, 's-real');
    const row = view.sessions[0];
    if (row === undefined) throw new Error('no summary');
    expect(blob.dataset['liveness']).toBe(row.liveness);
    expect(blob.dataset['nodes']).toBe(String(row.nodeCount));
    expect(blob.dataset['errors']).toBe(String(row.errorCount));
    expect(blob.textContent).toContain(row.label);
  });

  it('shows the badge count the store derived, and that count is not zero', () => {
    // Derived from the store rather than written out: a literal against a
    // shared builder is a number that goes wrong the next time the builder
    // changes, and reads as a renderer regression.
    const view = viewOf([liveSession({ sessionId: 's-real' })]);
    const row = view.sessions[0];
    if (row === undefined) throw new Error('no summary');
    expect(row.errorCount).toBeGreaterThan(0);
    const container = render({ sessions: view.sessions });
    expect(one(container, TESTID.deckErrorBadge).textContent).toBe(String(row.errorCount));
  });

  it('draws a constellation dot per node the store counted', () => {
    const view = viewOf([liveSession({ sessionId: 's-real' })]);
    const row = view.sessions[0];
    if (row === undefined) throw new Error('no summary');
    expect(row.nodeCount).toBeGreaterThan(0);
    expect(row.nodeCount).toBeLessThan(CONSTELLATION_CAP);
    const container = render({ sessions: view.sessions });
    expect(constellationOf(container)).toHaveLength(row.nodeCount);
  });

  it('a session the store refused draws cracked, at the floor, with no numbers', () => {
    const view = viewOf([unsupportedSession({ sessionId: 's-refused' })]);
    const row = view.sessions[0];
    if (row === undefined) throw new Error('no summary');
    // The store zeroes both counts for a refused session; this component holds
    // no branch of its own for that, so these three assertions are the proof
    // that the deletion was safe.
    expect(row.refused).toBe(true);
    expect(row.nodeCount).toBe(0);
    expect(row.errorCount).toBe(0);
    const container = render({ sessions: view.sessions });
    const blob = blobFor(container, 's-refused');
    expect(blob.classList.contains(CRACKED_CLASS)).toBe(true);
    expect(all(container, TESTID.deckErrorBadge)).toHaveLength(0);
    expect(constellationOf(container)).toHaveLength(0);
    expect(deckLayout(view.sessions)[0]?.R).toBe(DECK_RADIUS_MIN);
  });

  it('cracks a session refused by a schemaMismatch message mid-flight', () => {
    // The state on the wire still says `live`; only the store knows better.
    const state = liveSession({ sessionId: 's-mismatch' });
    const view = viewOf([state], ['s-mismatch']);
    expect(state.liveness).toBe('live');
    const container = render({ sessions: view.sessions });
    const blob = blobFor(container, 's-mismatch');
    expect(blob.dataset['liveness']).toBe('unsupported');
    expect(blob.classList.contains(CRACKED_CLASS)).toBe(true);
    expect(animated(container)).toHaveLength(0);
  });

  it('renders one blob per session in the store’s own order', () => {
    const ids = ['s-x', 's-y', 's-z'];
    const view = viewOf(
      ids.map((id) =>
        liveSession({
          sessionId: id,
          root: agent({
            id: 'root',
            kind: 'main',
            label: `main ${id}`,
            spawnDepth: 0,
            children: [tool({ id: 't1' })],
          }),
          spawnEdges: [],
        }),
      ),
    );
    const container = render({ sessions: view.sessions });
    expect(view.sessions.map((s) => s.sessionId)).toStrictEqual(ids);
    expect(blobs(container).map((b) => b.dataset['sessionId'])).toStrictEqual(ids);
  });
});

/* ------------------------------------------------------------------------ *
 * The stylesheet seam
 * ------------------------------------------------------------------------ */

describe('every contract class the deck applies also carries style', () => {
  // The components build these class names from `canvas-contract.ts`, so the
  // DOM side cannot drift. CSS cannot import a constant, so the stylesheet
  // spells each name a second time — and Svelte PRUNES a scoped rule it cannot
  // prove is used, which would silently remove the styling while every DOM
  // assertion above still passed. The `.` prefix is what makes this a check on
  // the stylesheet rather than on the contract module bundled beside it.
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

/* ------------------------------------------------------------------------ *
 * Theming (C7.7)
 * ------------------------------------------------------------------------ */

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
