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
// WHAT IS ASSERTED AND WHY IT IS WRITTEN THIS WAY. Every testid and every
// contract class is taken from `canvas-contract.ts`, never spelled as a
// literal. Selecting on a literal is how a renamed name becomes a silently
// skipped assertion instead of a failure: `all()` returns an empty array and a
// `.length === 0` check passes for the wrong reason. The same rule is why the
// CSS block's own literals are checked back against the constants below — CSS
// cannot import a TypeScript name, so the stylesheet is the one place a class
// is spelled twice, and that seam is closed by assertion rather than by care.

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
import { blobPath, deckLayout, hashSessionId, toDeckSession } from './layout.js';
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
 * Session builders. Hand-built states, not fixtures: the webview never reads
 * a transcript, so a captured JSONL would prove nothing at this altitude.
 * ------------------------------------------------------------------------ */

function session(id: string, overrides: Partial<SessionState> = {}): SessionState {
  return liveSession({ sessionId: id, ...overrides });
}

/** A session with no tool errors anywhere, so the badge row can be negative. */
function cleanSession(id: string, overrides: Partial<SessionState> = {}): SessionState {
  return liveSession({
    sessionId: id,
    root: agent({
      id: 'root',
      kind: 'main',
      label: `main ${id}`,
      spawnDepth: 0,
      children: [tool({ id: 't1', status: 'done' }), tool({ id: 't2', status: 'running' })],
    }),
    spawnEdges: [],
    ...overrides,
  });
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
    const container = render({ sessions: [cleanSession('s-1')] });
    expect(all(container, TESTID.deckEmpty)).toHaveLength(0);
    expect(blobs(container)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------ *
 * Ordering and geometry
 * ------------------------------------------------------------------------ */

describe('ordering and geometry', () => {
  const ids = ['s-a', 's-b', 's-c', 's-d'];
  const sessions = ids.map((id) => cleanSession(id));

  it('renders the sessions in exactly the order it was handed them', () => {
    const container = render({ sessions });
    expect(blobs(container).map((b) => b.dataset['sessionId'])).toStrictEqual(ids);
  });

  it('keeps DOM order when the same list is re-rendered — nothing re-sorts', () => {
    // Store order is host-snapshot order and this component adds no sort of
    // its own; a component that ordered by liveness would reshuffle here,
    // because these four differ in liveness.
    const mixed = [
      cleanSession('s-a', { liveness: 'ended' }),
      cleanSession('s-b', { liveness: 'live' }),
      cleanSession('s-c', { liveness: 'idle' }),
      cleanSession('s-d', { liveness: 'ended' }),
    ];
    const container = render({ sessions: mixed });
    expect(blobs(container).map((b) => b.dataset['sessionId'])).toStrictEqual(ids);
  });

  it('takes every coordinate from layout.ts and computes none of its own', () => {
    const container = render({ sessions });
    const placed = deckLayout(sessions.map(toDeckSession));
    for (const placement of placed) {
      const blob = blobFor(container, placement.sessionId);
      expect(membraneOf(blob).getAttribute('d')).toBe(
        blobPath(placement.x, placement.y, placement.R, hashSessionId(placement.sessionId)),
      );
    }
  });

  it('gives a session the same silhouette across renders — shape is the id', () => {
    const first = render({ sessions: [cleanSession('s-shape')] });
    const second = render({ sessions: [cleanSession('s-shape')] });
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
 * C7.3 — the state matrix, deck rows
 * ------------------------------------------------------------------------ */

describe('membrane by liveness (C7.3 rows 1-3)', () => {
  for (const liveness of ['live', 'idle', 'ended'] as const) {
    it(`renders a ${liveness} session's membrane as ${liveness}`, () => {
      const container = render({ sessions: [cleanSession('s-1', { liveness })] });
      const blob = blobFor(container, 's-1');
      expect(blob.dataset['liveness']).toBe(liveness);
      expect(blob.dataset['refused']).toBe('false');
      expect(blob.classList.contains(CRACKED_CLASS)).toBe(false);
    });
  }

  it('animates the live one and leaves idle and ended still', () => {
    const container = render({
      sessions: [
        cleanSession('s-live', { liveness: 'live' }),
        cleanSession('s-idle', { liveness: 'idle' }),
        cleanSession('s-ended', { liveness: 'ended' }),
      ],
    });
    expect(animated(blobFor(container, 's-live')).length).toBeGreaterThan(0);
    expect(animated(blobFor(container, 's-idle'))).toHaveLength(0);
    expect(animated(blobFor(container, 's-ended'))).toHaveLength(0);
  });
});

describe('unsupported / refused (C7.3, G3)', () => {
  it('cracks the membrane of a session whose own schemaOk is false', () => {
    const container = render({ sessions: [unsupportedSession()] });
    const blob = blobFor(container, 'session-unsupported');
    expect(blob.dataset['liveness']).toBe('unsupported');
    expect(blob.dataset['refused']).toBe('true');
    expect(blob.classList.contains(CRACKED_CLASS)).toBe(true);
    expect(membraneOf(blob).classList.contains(CRACKED_CLASS)).toBe(true);
    expect(blob.querySelectorAll('path.crack')).toHaveLength(1);
  });

  it('cracks a session refused by a schemaMismatch message that still says live', () => {
    // The wire still carries `live` — `schemaMismatch` refuses without
    // changing the liveness the last snapshot delivered. Two surfaces
    // disagreeing about one session is exactly the seam this row closes.
    const state = cleanSession('s-mismatch', { liveness: 'live' });
    const container = render({ sessions: [state], refusedIds: ['s-mismatch'] });
    const blob = blobFor(container, 's-mismatch');
    expect(state.liveness).toBe('live');
    expect(blob.dataset['liveness']).toBe('unsupported');
    expect(blob.classList.contains(CRACKED_CLASS)).toBe(true);
  });

  it('never animates a refused session, whatever its wire liveness says', () => {
    const container = render({
      sessions: [cleanSession('s-mismatch', { liveness: 'live' })],
      refusedIds: ['s-mismatch'],
    });
    expect(animated(container)).toHaveLength(0);
  });

  it('draws no crack on a session that was not refused', () => {
    const container = render({ sessions: [cleanSession('s-ok')] });
    expect(container.querySelectorAll('path.crack')).toHaveLength(0);
  });
});

describe('degraded — hooks silent (C7.3, G2)', () => {
  const sessions = [
    cleanSession('s-live', { liveness: 'live' }),
    cleanSession('s-idle', { liveness: 'idle' }),
    cleanSession('s-ended', { liveness: 'ended' }),
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
  it('counts every errored tool call in the tree, at any depth', () => {
    // `liveSession()` carries exactly one errored tool (`tool-bash`, at
    // depth 2). Derived from the state rather than hard-coded, so a change to
    // the shared builder cannot make this assertion quietly wrong.
    const state = session('s-err');
    const expected = countErrors(state);
    expect(expected).toBeGreaterThan(0);
    const container = render({ sessions: [state] });
    const badge = one(container, TESTID.deckErrorBadge);
    expect(badge.textContent).toBe(String(expected));
    expect(badge.dataset['count']).toBe(String(expected));
    expect(blobFor(container, 's-err').dataset['errors']).toBe(String(expected));
  });

  it('renders no badge at all when nothing errored', () => {
    const container = render({ sessions: [cleanSession('s-clean')] });
    expect(all(container, TESTID.deckErrorBadge)).toHaveLength(0);
    expect(blobFor(container, 's-clean').dataset['errors']).toBe('0');
  });

  it('takes no count from a refused session — its tree is not interpreted (G3)', () => {
    const state = unsupportedSession();
    expect(countErrors(state)).toBeGreaterThan(0);
    const container = render({ sessions: [state] });
    expect(all(container, TESTID.deckErrorBadge)).toHaveLength(0);
  });

  it('carries one badge per session, on the session that owns the errors', () => {
    const container = render({
      sessions: [cleanSession('s-clean'), session('s-err')],
    });
    expect(all(container, TESTID.deckErrorBadge)).toHaveLength(1);
    expect(blobFor(container, 's-err').querySelectorAll(`[data-testid="${TESTID.deckErrorBadge}"]`))
      .toHaveLength(1);
  });
});

describe('workspaceMatch: false (C7.3)', () => {
  it('ghosts the blob and tags it "other workspace"', () => {
    const container = render({
      sessions: [cleanSession('s-mine'), cleanSession('s-theirs', { workspaceMatch: false })],
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
        cleanSession(id, { liveness: 'ended' }),
      ),
    });
    expect(blobs(container)).toHaveLength(5);
    expect(animated(container)).toHaveLength(0);
  });

  it('animates exactly the live blobs and nothing else', () => {
    const sessions = [
      cleanSession('s-live-1', { liveness: 'live' }),
      cleanSession('s-idle', { liveness: 'idle' }),
      cleanSession('s-live-2', { liveness: 'live' }),
      cleanSession('s-ended', { liveness: 'ended' }),
    ];
    const container = render({ sessions });
    // Two live sessions, each carrying a breathing wrap and a pulse ring.
    expect(animated(container)).toHaveLength(4);
    for (const el of animated(container)) {
      const blob = el.closest(`[data-testid="${TESTID.deckBlob}"]`) as HTMLElement | null;
      expect(blob?.dataset['liveness']).toBe('live');
    }
  });

  it('uses only classes the contract lists, and both of them', () => {
    const container = render({ sessions: [cleanSession('s-live', { liveness: 'live' })] });
    const classes = new Set<string>();
    for (const el of animated(container)) for (const c of el.classList) classes.add(c);
    const carried = ANIMATED_CLASSES.filter((c) => classes.has(c));
    // `is-flowing` is the filament's, in the session interior; this altitude
    // carries the other two.
    expect(carried).toStrictEqual([ANIMATED_CLASSES[0], ANIMATED_CLASSES[1]]);
  });

  it('puts the animation-bearing classes on elements the stylesheet animates', () => {
    // CSS cannot import a TypeScript constant, so the stylesheet spells these
    // names a second time. Checking the bundled CSS against the constants is
    // what stops a rename from silently switching an animation off while the
    // negative control still passes.
    for (const cls of [ANIMATED_CLASSES[0], ANIMATED_CLASSES[1]]) {
      expect(bundle).toContain(`.${cls}`);
    }
    expect(bundle).toContain('animation:');
  });
});

describe('reduced motion (C7.6, C7.8)', () => {
  it('puts the reduced-motion class on the deck root when asked', () => {
    const container = render({ sessions: [cleanSession('s-1')], reducedMotion: true });
    expect(one(container, TESTID.deck).classList.contains(REDUCED_MOTION_CLASS)).toBe(true);
  });

  it('leaves the class off when the user did not ask for it', () => {
    const container = render({ sessions: [cleanSession('s-1')] });
    expect(one(container, TESTID.deck).classList.contains(REDUCED_MOTION_CLASS)).toBe(false);
  });

  it('SWAPS the animation rather than removing the semantics', () => {
    // The live blob still says it is live and still carries the semantic
    // classes; only the motion is swapped for a static variant. Dropping the
    // classes instead would make the reduced-motion path indistinguishable
    // from an ended session.
    const container = render({
      sessions: [cleanSession('s-live', { liveness: 'live' })],
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
      sessions: [cleanSession('s-1'), cleanSession('s-2', { liveness: 'idle' })],
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
      sessions: [session('s-err', { workspaceMatch: false, liveness: 'live' })],
    });
    const name = blobFor(container, 's-err').getAttribute('aria-label') ?? '';
    expect(name).toContain('main session');
    expect(name).toContain('live');
    expect(name).toContain('other workspace');
    expect(name).toContain(`${countErrors(session('s-err'))} tool error`);
  });

  it('marks the store’s selected session current, the same way the rail does', () => {
    const container = render({
      sessions: [cleanSession('s-1'), cleanSession('s-2')],
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
    const sessions = ids.map((id) => cleanSession(id));
    const container = render({ sessions });
    const placed = deckLayout(sessions.map(toDeckSession));
    expect(placed.map((p) => p.sessionId)).toStrictEqual(ids);
    expect(blobs(container).map((b) => b.dataset['sessionId'])).toStrictEqual(ids);
  });
});

describe('entering a session (C7.7, C7.8)', () => {
  it('reports the session id on click, and posts no message of its own', () => {
    const entered: string[] = [];
    const container = render({
      sessions: [cleanSession('s-1'), cleanSession('s-2')],
      onenter: (id: string) => entered.push(id),
    });
    click(blobFor(container, 's-2'));
    expect(entered).toStrictEqual(['s-2']);
  });

  for (const key of ['Enter', ' ']) {
    it(`enters the session on ${key === ' ' ? 'Space' : key}`, () => {
      const entered: string[] = [];
      const container = render({
        sessions: [cleanSession('s-1')],
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
      sessions: [cleanSession('s-1')],
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
    const container = render({ sessions: [cleanSession('s-1')] });
    expect(() => click(blobFor(container, 's-1'))).not.toThrow();
  });
});

/* ------------------------------------------------------------------------ *
 * Theming (C7.7)
 * ------------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------------ *
 * Helpers used by the assertions above
 * ------------------------------------------------------------------------ */

/**
 * Errored tool calls in a state, derived rather than hard-coded.
 *
 * A count written as a literal against a shared builder is a count that goes
 * wrong the next time the builder changes, and reads as a renderer regression.
 */
function countErrors(state: SessionState): number {
  const visit = (node: SessionState['root'] | { status: string }): number => {
    if (!('children' in node)) return node.status === 'error' ? 1 : 0;
    let total = 0;
    for (const child of node.children) total += visit(child);
    return total;
  };
  return visit(state.root);
}
