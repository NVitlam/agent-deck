// @vitest-environment jsdom
//
// The C7.3 visual-grammar state matrix — CROSS-CUTTING, through the real app,
// against BOTH surfaces.
//
// WHAT THIS FILE IS FOR, AND WHAT IT IS NOT FOR
// ---------------------------------------------
// `deck.test.ts`, `canvas.test.ts` and `inspector.test.ts` each assert the
// matrix rows that belong to THEIR component, mounting that component alone.
// This file asserts nothing about a component in isolation. It drives
// `store.handleMessage(...)` with host messages through the mounted `App` and
// asserts what the PANEL shows — which is the only place a row can be dropped
// by the router rather than by a component, and the only place the two
// surfaces can be compared at all.
//
// BOTH SURFACES, EVERY ROW. The list view is kept for one release behind an
// in-panel toggle (C7.2), and the user's decision is that the matrix runs
// against both while both exist — that is the point of keeping it. Every row
// below is therefore stated twice, once per `ViewMode`, through the SAME store
// and the same messages: `store.toggleViewMode()` is the only thing that
// changes between the two halves.
//
// Where a row genuinely exists in one surface only — a deck-level error badge
// has no list counterpart, and the list's per-node status chips have no canvas
// counterpart — the test SAYS SO rather than inventing an equivalent. A faked
// counterpart is worse than an admitted gap: it makes the matrix report a
// coverage it does not have.
//
// Rows this file cannot assert at all, because nothing in the shipped renderer
// emits them, are collected in the last describe block and are marked failing
// there rather than quietly omitted. See its header.
//
// TWO NEGATIVE CONTROLS, called out in C7.3 as the rows most easily satisfied
// by accident:
//   - `unsupported` requires an interior element count of exactly 0 (C7.4);
//   - animation-bearing classes appear on nothing that is neither running nor
//     live (C7.6), proved by setting everything done/ended and counting 0.
//
// Mounts the REAL bundle through `testkit.ts` — the same esbuild + Svelte
// pipeline `npm run build` runs. See `render.test.ts` for why.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionState, WebviewToHostMessage } from '../src/model/events.js';
import type { Store } from './store.js';
import type { WebviewHarness } from './testkit.js';
import { all, animated, hasAnimatedAncestor, loadHarness, one, press } from './testkit.js';
import {
  ANIMATED_CLASSES,
  CRACKED_CLASS,
  FOREIGN_CLASS,
  HOLLOW_LIVE_CLASS,
  PARKED_CLASS,
  REDUCED_MOTION_CLASS,
  TESTID,
} from './canvas-contract.js';
import type { ViewMode } from './canvas-contract.js';
import { EM_DASH, LIVENESS_INFERRED_LABEL, LIVENESS_VALUES, livenessTitle } from './format.js';
import {
  foreignSession,
  liveSession,
  parkedSession,
  settledSession,
  unsupportedSession,
  walkSession,
} from './testdata.js';

let harness: WebviewHarness;

beforeAll(async () => {
  harness = await loadHarness();
}, 60_000);

/* ------------------------------------------------------------------------ *
 * Mounting
 * ------------------------------------------------------------------------ */

interface Panel {
  container: HTMLElement;
  store: Store;
  sent: WebviewToHostMessage[];
  dispose: () => void;
}

const mounted: Panel[] = [];

/**
 * Mount the app.
 *
 * `reducedMotion` is stubbed onto `matchMedia` BEFORE the mount, because
 * `App.svelte` reads the query once at component initialisation and hands the
 * result down as a plain boolean. Stubbing after the mount would change
 * nothing and the assertion would pass or fail for the wrong reason.
 */
function render(options: { reducedMotion?: boolean } = {}): Panel {
  const withMedia = globalThis as unknown as { matchMedia?: unknown };
  const previous = withMedia.matchMedia;
  if (options.reducedMotion === true) {
    withMedia.matchMedia = () => ({ matches: true });
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const sent: WebviewToHostMessage[] = [];
  const started = harness.start(container, { postMessage: (m) => sent.push(m) });

  if (options.reducedMotion === true) {
    if (previous === undefined) delete withMedia.matchMedia;
    else withMedia.matchMedia = previous;
  }

  // Idempotent, and it removes itself from `mounted`: a renderer left mounted
  // would keep receiving every later `send()`, and both apps would then be
  // answering the same assertions.
  let disposed = false;
  const record: Panel = {
    container,
    store: started.store,
    sent,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const at = mounted.indexOf(record);
      if (at >= 0) mounted.splice(at, 1);
      started.dispose();
      container.remove();
    },
  };
  mounted.push(record);
  return record;
}

/** Feed a host message the way VS Code does — through `window.postMessage`. */
function send(message: unknown): void {
  harness.flushSync(() => {
    globalThis.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

/** Run a store call and flush Svelte, so the DOM can be asserted immediately. */
function act(fn: () => void): void {
  harness.flushSync(fn);
}

/** Press an element. `MouseEvent`, never `click()` — the canvas is all SVG. */
function click(element: Element): void {
  harness.flushSync(() => {
    press(element);
  });
}

/** A real Escape keystroke on the window `App.svelte` listens to. */
function escape(): void {
  harness.flushSync(() => {
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

/* ------------------------------------------------------------------------ *
 * Surface-independent helpers
 * ------------------------------------------------------------------------ */

/**
 * Put the panel into `mode`.
 *
 * Goes through the STORE rather than through the toggle button, and only the
 * `both views` blocks below click the button — that separation is deliberate.
 * A test that reached the list view by clicking would fail for two reasons at
 * once if the toggle broke, and the toggle has its own row.
 */
function useView(panel: Panel, mode: ViewMode): void {
  act(() => panel.store.setViewMode(mode));
  expect(one(panel.container, 'app').dataset['viewMode']).toBe(mode);
}

/**
 * Every element the session interior draws, by contract testid.
 *
 * Derived from `TESTID` rather than written out, because "interior element
 * count 0" is C7.4's normative assertion and a hand-written list would stop
 * covering a surface the moment a new one was added — the count would still
 * read 0 and the control would still pass.
 */
const INTERIOR_TESTIDS = [
  TESTID.nucleus,
  TESTID.cell,
  TESTID.filament,
  TESTID.parkedStub,
  TESTID.elidedBadge,
] as const;

function interiorCount(root: ParentNode): number {
  return INTERIOR_TESTIDS.reduce((total, testId) => total + all(root, testId).length, 0);
}

/** The blob for one session on the deck. */
function blobFor(panel: Panel, sessionId: string): HTMLElement {
  const found = all(panel.container, TESTID.deckBlob).filter(
    (b) => b.dataset['sessionId'] === sessionId,
  );
  const first = found[0];
  if (found.length !== 1 || first === undefined) {
    throw new Error(`expected one blob for ${sessionId}, found ${found.length}`);
  }
  return first;
}

/**
 * Row 2 of every drawn tree node, keyed by agent id.
 *
 * `layout.ts:nodeSubText` is the frozen string — `{burn} · {n} calls` plus
 * ` · {n} running` when there is one — and the node WIDTHS were measured from
 * its length, so it is asserted whole rather than by fragment.
 *
 * The two queries are unioned into a MAP, never concatenated into a list: a
 * concatenation would impose testid order over document order, which is how an
 * order assertion comes to mean nothing. Nothing here asserts an order.
 */
function subTextByAgent(panel: Panel): Map<string, string> {
  const cells = [...all(panel.container, TESTID.nucleus), ...all(panel.container, TESTID.cell)];
  return new Map(
    cells.map((c) => [c.dataset['agentId'] ?? '', c.querySelector('.sub')?.textContent ?? '']),
  );
}

/** The rail row for one session in the list view. */
function railFor(panel: Panel, sessionId: string): HTMLElement {
  const found = all(panel.container, 'rail-item').filter(
    (i) => i.dataset['sessionId'] === sessionId,
  );
  const first = found[0];
  if (found.length !== 1 || first === undefined) {
    throw new Error(`expected one rail item for ${sessionId}, found ${found.length}`);
  }
  return first;
}

/**
 * Zoom into a session, whichever surface is showing.
 *
 * Canvas: click the blob (deck -> interior). List: click the rail row, which
 * selects without an altitude because the list has none. One helper so a row
 * below reads the same in both halves and the difference stays here.
 */
function enter(panel: Panel, mode: ViewMode, sessionId: string): void {
  if (mode === 'canvas') click(blobFor(panel, sessionId));
  else click(railFor(panel, sessionId));
}

/* ------------------------------------------------------------------------ *
 * Rows that hold in BOTH surfaces
 * ------------------------------------------------------------------------ */

const VIEWS: readonly ViewMode[] = ['canvas', 'list'];

describe.each(VIEWS)('the state matrix in the %s view', (mode) => {
  /** Mount, switch to this half's surface, and feed a snapshot. */
  function panelWith(sessions: readonly SessionState[]): Panel {
    const panel = render();
    useView(panel, mode);
    send({ type: 'snapshot', sessions });
    return panel;
  }

  // --- liveness live / idle / ended ---------------------------------------

  describe('liveness', () => {
    for (const liveness of ['live', 'idle', 'ended'] as const) {
      it(`renders ${liveness} distinguishably, and says so in the panel`, () => {
        const panel = panelWith([liveSession({ liveness })]);
        const app = one(panel.container, 'app');

        // One place answers "which state is this?" for the whole panel, in
        // both surfaces — the router sets it, not either renderer.
        expect(app.dataset['liveness']).toBe(liveness);
        expect(app.dataset['refused']).toBe('false');
        expect(app.dataset['degraded']).toBe('false');

        if (mode === 'canvas') {
          const blob = blobFor(panel, 'session-live');
          expect(blob.dataset['liveness']).toBe(liveness);
          expect(blob.dataset['refused']).toBe('false');
          // C7.3: only `live` breathes and pulses; amber and gray are STILL.
          expect(animated(blob).length > 0).toBe(liveness === 'live');
          expect(blob.querySelector(`.${CRACKED_CLASS}`)).toBeNull();
          expect(blob.querySelector(`.${HOLLOW_LIVE_CLASS}`)).toBeNull();
        } else {
          const rail = railFor(panel, 'session-live');
          expect(rail.dataset['liveness']).toBe(liveness);
          expect(rail.dataset['refused']).toBe('false');
          const header = one(panel.container, 'header-liveness');
          expect(header.dataset['liveness']).toBe(liveness);
          expect(header.textContent?.trim()).toBe(liveness);
          expect(header.getAttribute('title')).toBe(livenessTitle(liveness));
          expect(all(panel.container, 'tree-node').length).toBeGreaterThan(0);
        }
      });
    }

    it('gives each of the four liveness values a different rendering', () => {
      // The requirement is that the states are TOLD APART on screen. Four
      // states rendering four identical panels would satisfy every per-state
      // assertion above and fail the actual requirement.
      const signatures = LIVENESS_VALUES.map((liveness) => {
        const session =
          liveness === 'unsupported'
            ? unsupportedSession({ sessionId: 'session-x' })
            : liveSession({ liveness, sessionId: 'session-x' });
        const panel = panelWith([session]);
        const app = one(panel.container, 'app');
        const surface =
          mode === 'canvas'
            ? [
                blobFor(panel, 'session-x').dataset['liveness'],
                String(animated(panel.container).length),
                String(all(panel.container, TESTID.deckBlob)[0]?.dataset['refused']),
              ]
            : [
                one(panel.container, 'rail-liveness').textContent?.trim(),
                String(all(panel.container, 'refusal-screen').length),
                String(all(panel.container, 'tree-node').length),
              ];
        const signature = [app.dataset['liveness'], app.dataset['refused'], ...surface].join('|');
        panel.dispose();
        return signature;
      });

      expect(new Set(signatures).size).toBe(LIVENESS_VALUES.length);
      // Every liveness value must also produce a DIFFERENT explanation.
      expect(new Set(LIVENESS_VALUES.map(livenessTitle)).size).toBe(LIVENESS_VALUES.length);
    });

    it('names no number of seconds beside a liveness value', () => {
      // The recency threshold is configurable in `liveness.ts` and the webview
      // is never told its value, so any duration printed beside a liveness
      // state would be a number the renderer cannot stand behind. Asserted at
      // the altitude that CARRIES the value — the deck blob's label and the
      // list's header — not over the whole panel, because tool durations are
      // real measurements the host sent and are allowed to print.
      for (const liveness of ['live', 'idle', 'ended'] as const) {
        const panel = panelWith([liveSession({ liveness })]);
        const carrier =
          mode === 'canvas'
            ? blobFor(panel, 'session-live')
            : one(panel.container, 'session-header');
        expect(carrier.textContent ?? '').not.toMatch(
          /\b\d+\s*(s|sec|secs|seconds|m|min|minutes)\b/,
        );
        if (mode === 'canvas') {
          // The blob's accessible name carries the error COUNT, which is a
          // real number the store derived — so this is the duration pattern,
          // not "no digits".
          expect(carrier.getAttribute('aria-label') ?? '').not.toMatch(
            /\b\d+\s*(s|sec|secs|seconds|m|min|minutes)\b/,
          );
        } else {
          expect(one(panel.container, 'header-liveness').getAttribute('title')).not.toMatch(/\d/);
        }
        panel.dispose();
      }
    });
  });

  // --- unsupported / refused (G3) -----------------------------------------

  describe('unsupported — the first negative control (G3, C7.4)', () => {
    it('marks the session refused before it is entered', () => {
      const panel = panelWith([unsupportedSession()]);
      expect(one(panel.container, 'app').dataset['refused']).toBe('true');
      expect(one(panel.container, 'app').dataset['liveness']).toBe('unsupported');

      if (mode === 'canvas') {
        // C7.3: red dashed membrane + crack, at deck level, before entry.
        const blob = blobFor(panel, 'session-unsupported');
        expect(blob.dataset['refused']).toBe('true');
        expect(blob.dataset['liveness']).toBe('unsupported');
        expect(blob.classList.contains(CRACKED_CLASS)).toBe(true);
        expect(blob.querySelectorAll(`.${CRACKED_CLASS}`).length).toBeGreaterThan(0);
        // THE REFUSAL SIGNAL IS THE CARD'S, and the two lines that used to
        // stand here are gone rather than adjusted. They read
        // `blob.dataset['constellation']` and counted
        // the `deck-constellation` testid — the faint one-dot-per-node
        // interior of `SessionBlob.svelte`, deleted with the phyllotaxis
        // canvas. Neither is emitted by anything now, so the first read
        // `undefined` and the second an empty array: one failed, and the
        // other would have PASSED while asserting nothing at all.
        //
        // What replaces them is the signal `SessionCell.svelte` actually
        // draws: the cracked class on the border rect (dashed in the
        // stylesheet), the state row on the group, and the tooltip that says
        // why. Asserted by VALUE against `livenessTitle`, not by presence.
        expect(one(blob, 'deck-cell-border').classList.contains(CRACKED_CLASS)).toBe(true);
        expect(blob.dataset['state']).toBe('unsupported');
        // A9.1 leads the card's tooltip with the LABEL; the status follows.
        expect(blob.querySelector('title')?.textContent).toContain(
          livenessTitle('unsupported'),
        );
        // G3 in the NUMBERS channel too: no figure is read off a refused
        // tree, so every count the card carries is 0 and no badge is drawn.
        expect(blob.dataset['nodes']).toBe('0');
        expect(blob.dataset['agents']).toBe('0');
        expect(blob.dataset['inflight']).toBe('0');
        expect(all(panel.container, TESTID.deckErrorBadge)).toHaveLength(0);
      } else {
        const rail = railFor(panel, 'session-unsupported');
        expect(rail.dataset['refused']).toBe('true');
        expect(rail.dataset['liveness']).toBe('unsupported');
        expect(one(panel.container, 'rail-liveness').textContent?.trim()).toBe('unsupported');
      }
    });

    it('draws ZERO interior elements on entry, with a tree in the model', () => {
      // The discriminating case. A refused session whose model tree is EMPTY
      // would satisfy "0 elements" by having nothing to draw; this one carries
      // the whole `liveSession()` tree and must still draw none of it.
      const session = unsupportedSession();
      expect(walkSession(session).length).toBeGreaterThan(1);

      const panel = panelWith([session]);
      enter(panel, mode, 'session-unsupported');

      expect(interiorCount(panel.container)).toBe(0);
      expect(all(panel.container, 'tree-node')).toHaveLength(0);
      expect(all(panel.container, 'status-chip')).toHaveLength(0);
      expect(all(panel.container, 'payload-preview')).toHaveLength(0);
      // Not "a tree with a warning" — no header either.
      expect(all(panel.container, 'session-header')).toHaveLength(0);

      if (mode === 'canvas') {
        expect(one(panel.container, TESTID.canvas).dataset['refused']).toBe('true');
        expect(one(panel.container, TESTID.canvas).dataset['cells']).toBe('0');
        // `data-dots` is gone with the dots (A8.1). Removed rather than left
        // asserting '0' forever, which is a check that can no longer fail.
        expect(one(panel.container, TESTID.canvas).dataset['parked']).toBe('0');
      } else {
        const refusal = one(panel.container, 'refusal-screen');
        expect(refusal.dataset['liveness']).toBe('unsupported');
        expect(one(refusal, 'refusal-session-id').textContent).toContain('session-unsupported');
        expect(one(refusal, 'refusal-cause').textContent).toContain('on-disk format');
      }
    });

    it('refuses a session that arrives good and is refused afterwards', () => {
      // The seam: `schemaMismatch` refuses a session WITHOUT changing the
      // `liveness` the last snapshot delivered, so both surfaces have to read
      // the store's union rather than the wire field.
      const panel = panelWith([liveSession()]);
      enter(panel, mode, 'session-live');
      expect(interiorCount(panel.container) + all(panel.container, 'tree-node').length)
        .toBeGreaterThan(0);

      send({ type: 'schemaMismatch', sessionId: 'session-live' });

      expect(one(panel.container, 'app').dataset['liveness']).toBe('unsupported');
      expect(one(panel.container, 'app').dataset['refused']).toBe('true');
      expect(interiorCount(panel.container)).toBe(0);
      expect(all(panel.container, 'tree-node')).toHaveLength(0);
    });

    it('leaves the other sessions alone', () => {
      const panel = panelWith([unsupportedSession(), liveSession({ sessionId: 'session-ok' })]);
      if (mode === 'canvas') {
        expect(blobFor(panel, 'session-unsupported').dataset['refused']).toBe('true');
        expect(blobFor(panel, 'session-ok').dataset['refused']).toBe('false');
        expect(Number(blobFor(panel, 'session-ok').dataset['nodes'])).toBeGreaterThan(0);
      } else {
        expect(railFor(panel, 'session-unsupported').dataset['refused']).toBe('true');
        expect(railFor(panel, 'session-ok').dataset['refused']).toBe('false');
      }
    });
  });

  // --- degraded (G2) -------------------------------------------------------

  describe('degraded — the hook tap is silent (G2)', () => {
    it('keeps the content and marks the liveness as inferred', () => {
      const panel = panelWith([liveSession()]);
      send({ type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' });

      expect(one(panel.container, 'app').dataset['degraded']).toBe('true');

      // Banner semantics are UNCHANGED from Phase 3, in both surfaces: it is
      // chrome above the body, not part of either renderer.
      const banner = one(panel.container, 'degraded-banner');
      expect(banner.dataset['reason']).toBe('noHookEvents');
      expect(banner.textContent).toContain('no hook events received');

      enter(panel, mode, 'session-live');
      if (mode === 'canvas') {
        // C7.3: every live membrane goes dash-hollow. The blob's does, and so
        // does a running agent's cell inside the interior.
        escape();
        const blob = blobFor(panel, 'session-live');
        expect(blob.dataset['livenessInferred']).toBe('true');
        expect(blob.querySelectorAll(`.${HOLLOW_LIVE_CLASS}`).length).toBe(1);

        enter(panel, mode, 'session-live');
        const running = all(panel.container, TESTID.cell)
          .concat(all(panel.container, TESTID.nucleus))
          .filter((c) => c.dataset['status'] === 'running');
        expect(running.length).toBeGreaterThan(0);
        for (const cell of running) {
          expect(cell.dataset['livenessInferred']).toBe('true');
          expect(cell.querySelectorAll(`.${HOLLOW_LIVE_CLASS}`).length).toBe(1);
        }
      } else {
        const marker = one(panel.container, 'header-liveness-inferred');
        expect(marker.textContent).toContain(LIVENESS_INFERRED_LABEL);
        expect(one(panel.container, 'session-header').dataset['livenessInferred']).toBe('true');
      }

      // G2: losing the hook tap costs liveness, not content. Asserted on the
      // surface that is showing, whichever it is.
      const drawn =
        mode === 'canvas' ? interiorCount(panel.container) : all(panel.container, 'tree-node').length;
      expect(drawn).toBeGreaterThan(0);
    });

    it('carries both reasons into the DOM', () => {
      const panel = panelWith([liveSession({ liveness: 'idle' })]);
      send({ type: 'degraded', engine: 'cc', degraded: true, reason: 'listenerDown' });
      expect(one(panel.container, 'degraded-banner').dataset['reason']).toBe('listenerDown');
      expect(one(panel.container, 'degraded-banner').textContent).toContain(
        'the hook listener is not running',
      );
    });

    it('stays dismissed while the same episode repeats, and keeps the marker', () => {
      // Dismissing silences one episode; it does not improve the source of the
      // number. Phase 3 semantics, unchanged (spec C4: informative, not
      // nagging) — restated here because the router now owns the banner.
      const panel = panelWith([liveSession()]);
      send({ type: 'degraded', engine: 'cc', degraded: true, reason: 'listenerDown' });
      click(one(panel.container, 'degraded-dismiss'));
      for (let i = 0; i < 10; i += 1) {
        send({ type: 'degraded', engine: 'cc', degraded: true, reason: 'listenerDown' });
      }

      expect(all(panel.container, 'degraded-banner')).toHaveLength(0);
      expect(one(panel.container, 'app').dataset['degraded']).toBe('true');
      if (mode === 'canvas') {
        expect(blobFor(panel, 'session-live').dataset['livenessInferred']).toBe('true');
      } else {
        expect(all(panel.container, 'header-liveness-inferred')).toHaveLength(1);
      }
    });

    it('drops the banner and the hollowing when the tap recovers', () => {
      const panel = panelWith([liveSession()]);
      send({ type: 'degraded', engine: 'cc', degraded: true, reason: 'listenerDown' });
      send({ type: 'degraded', engine: 'cc', degraded: false });

      expect(all(panel.container, 'degraded-banner')).toHaveLength(0);
      expect(one(panel.container, 'app').dataset['degraded']).toBe('false');
      if (mode === 'canvas') {
        const blob = blobFor(panel, 'session-live');
        expect(blob.dataset['livenessInferred']).toBe('false');
        expect(blob.querySelectorAll(`.${HOLLOW_LIVE_CLASS}`)).toHaveLength(0);
      } else {
        expect(all(panel.container, 'header-liveness-inferred')).toHaveLength(0);
      }
    });

    it('composes with a refusal: two independent taps, both allowed to fail', () => {
      const panel = panelWith([unsupportedSession()]);
      send({ type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' });
      enter(panel, mode, 'session-unsupported');

      expect(all(panel.container, 'degraded-banner')).toHaveLength(1);
      expect(interiorCount(panel.container)).toBe(0);
      expect(all(panel.container, 'tree-node')).toHaveLength(0);
      // A refused session never claims inferred liveness — it claims nothing.
      expect(all(panel.container, 'header-liveness-inferred')).toHaveLength(0);
    });
  });

  // --- tool and agent status ----------------------------------------------

  describe('tool and agent status', () => {
    it('renders running, done and error, and the error persists', () => {
      const panel = panelWith([liveSession()]);
      enter(panel, mode, 'session-live');

      if (mode === 'canvas') {
        // THE DOTS ARE GONE — design amendment A8.1. What stood here read a
        // per-call status map, a hollow-spawn shape and a transcript order off
        // the dot row. The row was a flat cap of 24 whatever it sat under, so
        // on the wide-rank corpus 17 of 18 rows fell outside their own boxes,
        // 14 sibling pairs overlapped, and 15 of 15 filaments were dropped
        // because their spawning dot had been elided.
        //
        // Per-call status now reads in §8.6's drawer, which `inspector.test.ts`
        // covers by value. What this SURFACE still claims is asserted here, and
        // the absence is asserted with it — so the row cannot go vacuous the
        // way its predecessor did when `.stats` stopped being emitted.
        expect(all(panel.container, 'canvas-dot')).toHaveLength(0);

        // Row 2 of a node is the frozen string, asserted whole.
        expect(subTextByAgent(panel).get('agent-2')).toBe('2.0k · 1 calls');

        // AND THE ERROR PERSISTS — the half of this row's name that matters.
        // On the canvas that claim now lives on the NODE: something is running
        // before the tree settles and nothing is running after.
        const activeNodes = (): HTMLElement[] =>
          all(panel.container, TESTID.cell)
            .concat(all(panel.container, TESTID.nucleus))
            .filter((n) => n.dataset['active'] === 'true');
        expect(activeNodes().length).toBeGreaterThan(0);
        send({
          type: 'snapshot',
          sessions: [settledSession({ sessionId: 'session-live' })],
        });
        expect(activeNodes()).toHaveLength(0);
      } else {
        const chips = all(panel.container, 'status-chip').map((c) => c.textContent?.trim());
        expect(chips).toContain('running');
        expect(chips).toContain('error');

        // The same persistence claim, on the surface that is showing.
        send({
          type: 'snapshot',
          sessions: [settledSession({ sessionId: 'session-live' })],
        });
        const after = all(panel.container, 'status-chip').map((c) => c.textContent?.trim());
        expect(after).toContain('error');
        expect(after).not.toContain('running');
      }
    });

    it('aggregates tool errors to a deck badge — CANVAS ONLY, and that is the row', () => {
      // The badge is a deck-level thing and the list view has no deck, so this
      // row genuinely exists in one surface only. Stated rather than faked.
      if (mode !== 'canvas') {
        const panel = panelWith([liveSession()]);
        enter(panel, mode, 'session-live');
        expect(all(panel.container, TESTID.deckErrorBadge)).toHaveLength(0);
        return;
      }
      const panel = panelWith([liveSession()]);
      const badge = all(panel.container, TESTID.deckErrorBadge);
      expect(badge.length).toBeGreaterThan(0);
    });
  });

  // --- the join, drawn (C7.4) ---------------------------------------------

  describe('the spawn edge', () => {
    it('draws the join from the spawning dot to the child cell', () => {
      const session = liveSession();
      const edges = session.spawnEdges ?? [];
      expect(edges.length).toBeGreaterThan(0);

      const panel = panelWith([session]);
      enter(panel, mode, 'session-live');

      if (mode === 'canvas') {
        // C7.4: the filament IS the primary-key join made visible. Both ends
        // are the edge's own two ids, so the assertion is on the pairs.
        const drawn = all(panel.container, TESTID.filament).map((f) => [
          f.dataset['toolUseId'],
          f.dataset['agentId'],
        ]);
        for (const edge of edges) {
          expect(drawn).toContainEqual([edge.toolUseId, edge.agentId]);
        }
        // The dash flows while the CHILD is running and is static otherwise —
        // the join itself never animates.
        for (const filament of all(panel.container, TESTID.filament)) {
          const child = walkSession(session).find((n) => n.id === filament.dataset['agentId']);
          expect(filament.dataset['flowing']).toBe(String(child?.status === 'running'));
          expect(filament.classList.contains(ANIMATED_CLASSES[2])).toBe(
            child?.status === 'running',
          );
        }
      } else {
        // The list view expresses the same join by NESTING: the subagent is
        // drawn inside the tool node its sidecar named.
        for (const edge of edges) {
          const agentEl = all(panel.container, 'tree-node').find(
            (n) => n.dataset['nodeId'] === edge.agentId,
          );
          const toolEl = all(panel.container, 'tree-node').find(
            (n) => n.dataset['nodeId'] === edge.toolUseId,
          );
          expect(agentEl?.dataset['spawnedBy']).toBe(edge.toolUseId);
          expect(toolEl?.contains(agentEl as Node)).toBe(true);
        }
      }
    });

    it('parks an unjoined graft unattached, with a stub — CANVAS ONLY', () => {
      // C7.4, and the list view has no representation of it at all: a parked
      // agent has NO NODE IN THE TREE, and the list view renders the tree.
      // `SessionState.parked` is the only record it exists, which is exactly
      // why the canvas needed a shape for it.
      const session = parkedSession();
      const parked = session.parked ?? [];
      expect(parked.length).toBeGreaterThan(0);
      for (const entry of parked) {
        expect(walkSession(session).some((n) => n.id === entry.agentId)).toBe(false);
      }

      const panel = panelWith([session]);
      enter(panel, mode, 'session-parked');

      if (mode === 'canvas') {
        const cells = all(panel.container, TESTID.cell).filter(
          (c) => c.dataset['parked'] === 'true',
        );
        expect(cells).toHaveLength(parked.length);
        for (const cell of cells) {
          expect(cell.classList.contains(PARKED_CLASS)).toBe(true);
          expect(cell.querySelectorAll(`.${PARKED_CLASS}`).length).toBeGreaterThan(0);
          expect(all(cell, TESTID.parkedStub)).toHaveLength(1);
          expect(cell.getAttribute('aria-label')).toContain('awaiting attribution');
          // Unattached: no filament names it, because no edge resolved.
          expect(
            all(panel.container, TESTID.filament).some(
              (f) => f.dataset['agentId'] === cell.dataset['agentId'],
            ),
          ).toBe(false);
          // Nothing is happening in it that we can see.
          expect(animated(cell)).toHaveLength(0);
        }
        expect(one(panel.container, TESTID.canvas).dataset['parked']).toBe(
          String(parked.length),
        );
      } else {
        for (const entry of parked) {
          expect(
            all(panel.container, 'tree-node').some((n) => n.dataset['nodeId'] === entry.agentId),
          ).toBe(false);
        }
      }
    });
  });

  // --- workspaceMatch: false ----------------------------------------------

  it('ghosts a session from another workspace and tags it', () => {
    const panel = panelWith([foreignSession()]);
    if (mode === 'canvas') {
      const blob = blobFor(panel, 'session-foreign');
      expect(blob.dataset['foreign']).toBe('true');
      expect(blob.classList.contains(FOREIGN_CLASS)).toBe(true);
      expect(blob.textContent).toContain('other workspace');
      expect(blob.getAttribute('aria-label')).toContain('other workspace');
    } else {
      const rail = railFor(panel, 'session-foreign');
      expect(all(rail, 'rail-foreign')).toHaveLength(1);
      expect(one(rail, 'rail-foreign').textContent?.trim()).toBe('other workspace');
    }
  });

  // --- tokens and cost -----------------------------------------------------

  it('never prints a currency figure, and says why cost is an em-dash', () => {
    // `costUsd` is 0 and 0 means NOT COMPUTED, never "free". "$0.00" would be
    // a fabricated claim; there is no price table in this repo. The rule is
    // unchanged by the canvas — C7.1 calls the inspector a new HOME for the
    // text, not new behaviour for it.
    const panel = panelWith([liveSession()]);
    enter(panel, mode, 'session-live');
    expect(panel.container.textContent).not.toContain('$');

    if (mode === 'list') {
      const header = one(panel.container, 'session-header');
      expect(one(header, 'header-context').textContent?.trim()).toBe('17,745');
      expect(one(header, 'header-burn').textContent?.trim()).toBe('35,490');
      const cost = one(header, 'header-cost');
      expect(cost.textContent?.trim()).toBe(EM_DASH);
      expect(cost.getAttribute('title')).toContain('no price table');
    } else {
      // The canvas surfaces per-node tokens in the inspector, and the two
      // fields say two different things. CONTEXT IS A LEVEL and carries one
      // number — the last assistant message's whole prompt — so the row
      // prints `contextNow.prompt` alone. BURN IS A TOTAL and carries both
      // halves. The line that used to demand `6,789` (the root's
      // `contextNow.output`) inside `inspector-tokens` was reading the old
      // `tokens.in / tokens.out` pair off a field that has stopped being one.
      //
      // Exact equality, not `toContain`: `formatTokens(undefined)` is an
      // em-dash and a containment check on a concatenated row passes when
      // every figure in it is a dash — the shape that shipped a fully-dashed
      // token line once already.
      click(one(panel.container, TESTID.nucleus));
      expect(one(panel.container, 'inspector-tokens').textContent?.trim()).toBe('12,345');
      expect(one(panel.container, 'inspector-burn').textContent?.trim()).toBe(
        '24,690 in / 13,578 out',
      );

      // AGENTCELL'S ROW 2, ASSERTED BY VALUE. It is the fifth `.svelte` token
      // call site and the only one no other test reads: `AgentCell` is
      // canvas-only, so `render.test.ts`'s `node-tokens` covers `TreeNodeView`
      // and not this. `.svelte` is outside `tsc` and outside eslint, so a
      // wrong field or a dropped `?.` here would reach a user unchallenged.
      //
      // Row 2 is now `layout.ts:nodeSubText` — BURN, compact, then the call
      // count and the running count. The previous version asserted the
      // superseded `4,500 in ctx / 1,250 out` subline and guarded against
      // reading `burn` by mistake; the fields have swapped roles, so the
      // MUTATION swaps with them. testdata's depth-1 agent carries burn
      // 9,000/2,500 (`11.5k`) and contextNow 4,500/1,250 (`5.8k`), so a cell
      // that read `contextNow` here fails on both lines below.
      const subs = subTextByAgent(panel);
      expect(subs.get('agent-1')).toBe('11.5k · 1 calls · 1 running');
      expect(subs.get('root')).toBe('38.3k · 2 calls');
      expect([...subs.values()].some((t) => t.includes('5.8k'))).toBe(false);
    }
  });

  // --- the third engine (v0.6.0 Phase 3: Codex) -----------------------------

  /*
   * D2 (2026-09-03) — THE "HOOKS SILENT" CHIP IS THE CLAUDE CODE TAP'S.
   *
   * `degraded` on the wire is produced by `LivenessEngine.degradedState()`,
   * which reads `eventsReceived === 0` on the CLAUDE CODE engine and nothing
   * else. It is panel-wide, and `App.svelte` used to hand it to whichever
   * session was selected — so selecting a Codex session while the CC tap was
   * quiet said "liveness inferred — hooks silent" about a Codex session whose
   * hooks were arriving and being attributed. Reported by own eyes against the
   * shipped `release/0.6.0` build.
   *
   * `webview/deck.test.ts` guards the deck CARD. This guards the SELECTED
   * SESSION surfaces, which is `App.svelte`'s `degradedHere` derivation — and
   * it exists because a `phase-verifier` mutation showed the App.svelte half of
   * that fix was completely unguarded: reverting all three of its call sites
   * left this whole project green.
   */
  it('does not say "hooks silent" about a non-Claude-Code session', () => {
    const panel = render();
    useView(panel, mode);
    send({ type: 'snapshot', sessions: [liveSession({ engine: 'codex' })] });
    send({ type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' });
    enter(panel, mode, 'session-live');

    if (mode === 'canvas') {
      // The HUD is still there; the CHIP on it is not.
      expect(all(panel.container, TESTID.hud)).toHaveLength(1);
      expect(all(panel.container, TESTID.hudDegradedChip)).toHaveLength(0);
    } else {
      expect(one(panel.container, 'session-header').dataset['livenessInferred']).toBe('false');
    }
  });

  /*
   * DoD 5.0b - THE RENDER WIRE, AND IT IS HERE BECAUSE A VERIFIER PROVED IT
   * WAS MISSING.
   *
   * `App.svelte` is the only place production hands `degradedByEngine` to
   * `<Deck>`. Deleting that one attribute left the ENTIRE webview project
   * green - 18 files, 703 tests - while a Codex card could never again show a
   * degraded chip. The three `deck.test.ts` tests that cover the behaviour all
   * mount `Deck` directly and pass the prop BY HAND, so they prove the
   * component honours a value nothing was shown to send it.
   *
   * That is defect D4 verbatim - "a component test standing in for a wiring
   * that does not exist" - committed in the same phase whose own store tests
   * cite D4 by name, one layer further out than the place it was fixed. The
   * rule it breaks is this repository's own: for any prop that changes
   * user-visible output, ONE test must reach it the way production does.
   *
   * So these send a wire message into the real store and read the real deck.
   * Nothing is passed by hand.
   */
  it('a Codex degraded message reaches a Codex deck card, through the real App', () => {
    // NO `useView` here, and that is not an omission: the deck sits ABOVE the
    // session-interior view mode, and one of the two modes this block runs
    // under enters a session during setup - which leaves no deck to read.
    const panel = render();
    send({
      type: 'snapshot',
      sessions: [liveSession({ engine: 'codex' }), liveSession({ engine: 'cc', sessionId: 'session-cc' })],
    });
    send({ type: 'degraded', engine: 'codex', degraded: true, reason: 'noHookEvents' });

    const cards = all(panel.container, TESTID.deckBlob);
    const codex = cards.find((c) => c.dataset['engine'] === 'codex');
    const cc = cards.find((c) => c.dataset['engine'] === 'cc');
    expect(codex, 'the Codex card must be on the deck').toBeDefined();
    expect(cc, 'the Claude Code card must be on the deck').toBeDefined();

    expect(codex?.dataset['livenessInferred']).toBe('true');
    expect(codex?.dataset['state']).toBe('degraded');
    // BOTH DIRECTIONS IN ONE MOUNT: a Codex message must not touch the Claude
    // Code card, which is D2 running backwards.
    expect(cc?.dataset['livenessInferred']).toBe('false');
    expect(cc?.dataset['state']).not.toBe('degraded');
  });

  it('control: a Claude Code degraded message leaves the Codex card alone', () => {
    // Without this the test above passes for a deck that degrades every card
    // on any message - which is the D2 defect it is meant to prevent.
    const panel = render();
    send({
      type: 'snapshot',
      sessions: [liveSession({ engine: 'codex' }), liveSession({ engine: 'cc', sessionId: 'session-cc' })],
    });
    send({ type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' });

    const cards = all(panel.container, TESTID.deckBlob);
    const codex = cards.find((c) => c.dataset['engine'] === 'codex');
    const cc = cards.find((c) => c.dataset['engine'] === 'cc');

    expect(cc?.dataset['livenessInferred']).toBe('true');
    expect(codex?.dataset['livenessInferred']).toBe('false');
  });

  it('a Codex degraded message reaches the SELECTED-SESSION surfaces too', () => {
    // The other half of App.svelte's derivation: `degradedHere` used to be
    // `view.degraded && selectedIsCc`, so a Codex session could never show it
    // however silent its own tap was. Same message, different surface.
    const panel = render();
    useView(panel, mode);
    send({ type: 'snapshot', sessions: [liveSession({ engine: 'codex' })] });
    send({ type: 'degraded', engine: 'codex', degraded: true, reason: 'noHookEvents' });
    enter(panel, mode, 'session-live');

    if (mode === 'canvas') {
      expect(one(panel.container, TESTID.hudDegradedChip).textContent).toContain('inferred');
    } else {
      expect(one(panel.container, 'session-header').dataset['livenessInferred']).toBe('true');
    }
  });
  it('control: it DOES say it about a Claude Code session, on the same panel state', () => {
    // Without this the assertion above passes if the degraded message never
    // arrived, or if the chip were deleted outright.
    const panel = render();
    useView(panel, mode);
    send({ type: 'snapshot', sessions: [liveSession({ engine: 'cc' })] });
    send({ type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' });
    enter(panel, mode, 'session-live');

    if (mode === 'canvas') {
      expect(one(panel.container, TESTID.hudDegradedChip).textContent).toContain('inferred');
    } else {
      expect(one(panel.container, 'session-header').dataset['livenessInferred']).toBe('true');
    }
  });

  it('reaches this surface tagged codex, with a Window figure beside context and burn', () => {
    // The state-matrix row this phase adds: `engine: 'codex'` all the way
    // through the router to whichever surface is showing, PLUS the third
    // token figure (D0.2, spec C8) that only a Codex session ever carries.
    const panel = panelWith([liveSession({ engine: 'codex', windowTokens: 200_000 })]);

    if (mode === 'canvas') {
      const blob = blobFor(panel, 'session-live');
      expect(blob.dataset['engine']).toBe('codex');
      enter(panel, mode, 'session-live');
      const totals = one(panel.container, 'hud-totals');
      // The two other figures on the row are unchanged; the window figure is
      // the addition, grouped-thousands, on the same row.
      expect(totals.textContent).toContain('17,745');
      expect(totals.textContent).toContain('35,490');
      expect(totals.textContent).toContain('200,000');
    } else {
      // The list view's session header has no engine glyph of its own (only
      // the canvas card and the drawer do), so this half asserts the OTHER
      // new fact: the Window figure on the same totals row as context/burn.
      const header = one(panel.container, 'session-header');
      expect(one(header, 'header-context').textContent?.trim()).toBe('17,745');
      expect(one(header, 'header-burn').textContent?.trim()).toBe('35,490');
      expect(one(header, 'header-window').textContent?.trim()).toBe('200,000');
    }
  });

  it('renders EM_DASH for the Window figure on a CC session, in both surfaces', () => {
    // CC (and OpenCode) sessions never set `windowTokens`; a renderer that
    // wrote `0` instead of the absence rule would claim a zero-token window.
    const panel = panelWith([liveSession()]);
    expect(liveSession().windowTokens).toBeUndefined();

    if (mode === 'canvas') {
      enter(panel, mode, 'session-live');
      // `toContain(EM_DASH)` alone would be vacuous here — the row's COST
      // figure is ALWAYS an em-dash (no price table exists), so it passes
      // whether or not the window figure rendered correctly. Count instead:
      // context and burn are real numbers on `liveSession()`, so exactly TWO
      // dashes (window, cost) is the property that actually distinguishes
      // "window rendered EM_DASH" from "window rendered something else and
      // cost's dash was the only one counted".
      const text = one(panel.container, 'hud-totals').textContent ?? '';
      const dashCount = text.split(EM_DASH).length - 1;
      expect(dashCount).toBe(2);
      expect(text).toContain('17,745');
      expect(text).toContain('35,490');
    } else {
      const header = one(panel.container, 'session-header');
      expect(one(header, 'header-window').textContent?.trim()).toBe(EM_DASH);
    }
  });

  // --- patch failure -------------------------------------------------------

  it('shows the thin patch-failure notice and clears it on the next snapshot', () => {
    const panel = panelWith([liveSession()]);
    send({
      type: 'diff',
      sessionId: 'session-live',
      patch: { tree: [{ op: 'removeNode', id: 'not-here' }] },
    });

    expect(all(panel.container, 'patch-failure')).toHaveLength(1);
    expect(one(panel.container, 'patch-failure').getAttribute('role')).toBe('status');
    // The last good state stays on screen underneath it.
    enter(panel, mode, 'session-live');
    const drawn =
      mode === 'canvas' ? interiorCount(panel.container) : all(panel.container, 'tree-node').length;
    expect(drawn).toBeGreaterThan(0);

    send({ type: 'snapshot', sessions: [liveSession()] });
    expect(all(panel.container, 'patch-failure')).toHaveLength(0);
  });

  // --- no sessions ---------------------------------------------------------

  it('says one quiet line when there are no sessions', () => {
    const panel = panelWith([]);
    expect(one(panel.container, 'app').dataset['liveness']).toBe('none');
    if (mode === 'canvas') {
      // ONE LINE, NAMING NO ENGINE (D4, 2026-09-04). This row has pinned three
      // different things now: 'No sessions in this workspace.', then one line
      // per enabled engine, and now this. The middle one is why the rule is
      // worth stating rather than just satisfying — it was correct in design
      // and defective in the product, because nothing ever passed
      // `enabledEngines`, so the panel named Claude Code to every user of
      // every engine.
      //
      // Asserted through the WHOLE PANEL rather than the component, which is
      // what this file is for: the component test can be handed a prop the
      // product never passes, and this one cannot.
      const waiting = all(panel.container, 'deck-waiting');
      expect(waiting.map((p) => p.textContent?.trim())).toStrictEqual([
        'Waiting for a session to start.',
      ]);
      expect(one(panel.container, TESTID.deckEmpty).textContent?.trim()).toBe(
        'Waiting for a session to start.',
      );
      for (const name of ['Claude', 'OpenCode', 'Codex']) {
        expect(one(panel.container, TESTID.deckEmpty).textContent).not.toContain(name);
      }
      expect(all(panel.container, 'deck-empty-filtered')).toHaveLength(0);
      expect(all(panel.container, TESTID.deckBlob)).toHaveLength(0);
      expect(one(panel.container, TESTID.deck).dataset['sessions']).toBe('0');
    } else {
      expect(all(panel.container, 'rail-empty')).toHaveLength(1);
      expect(all(panel.container, 'no-selection')).toHaveLength(1);
    }
    // Not an error and not a spinner, in either surface.
    expect(panel.container.querySelector('[role="alert"]')).toBeNull();
  });

  // --- motion: the second negative control (C7.6) --------------------------

  describe('motion is a reserved semantic channel', () => {
    it('animates only what is running or live', () => {
      const panel = panelWith([liveSession()]);

      /**
       * Why an animated element is allowed to animate, or `undefined`.
       *
       * KNOWN DIVERGENCE, RECORDED RATHER THAN PAPERED OVER. The cell branch
       * below justifies on `data-status === 'running'`. `AgentCell.svelte`
       * decides what to animate with `data-active`, which is
       * `status === 'running' || hasRunningTool` — a STRICTLY WIDER condition.
       *
       * The two agree on every fixture this file uses, so the walk is sound
       * today. They diverge for one shape: an agent whose own status is `done`
       * or `error` while a tool under it is still `running`. That shape is not
       * hypothetical — `canvas.test.ts`'s "pulses an agent whose OWN status is
       * done while a tool is still running" renders it and asserts the pulse.
       *
       * WHAT WILL TURN THIS RED. A fixture reaching this walk that contains a
       * settled agent holding a running tool: the cell animates, `data-status`
       * reads `done`, `justify` returns `undefined`, and the loop below fails
       * with "animates unjustified" — pointing at a correct animation.
       *
       * The assertion is DELIBERATELY NOT WIDENED to `data-active`. Reading the
       * component's own output attribute back as the justification for the
       * component's own animation would make this control circular: it would
       * accept anything the component chose to mark active, which is precisely
       * the thing under test. A narrow rule that fails loudly on a case it does
       * not cover is worth more here than a wide one that cannot fail. When it
       * does fail, add the case to the rule — do not swap the attribute.
       */
      const justify = (element: Element): string | undefined => {
        let node: Element | null = element;
        while (node !== null) {
          const testId = node.getAttribute('data-testid');
          const status = node.getAttribute('data-status');
          if (testId === TESTID.deckBlob) {
            return node.getAttribute('data-liveness') === 'live' ? 'live session' : undefined;
          }
          if (testId === TESTID.filament) {
            return node.getAttribute('data-flowing') === 'true' ? 'running child' : undefined;
          }
          if (testId === TESTID.cell || testId === TESTID.nucleus) {
            return status === 'running' ? 'running node' : undefined;
          }
          node = node.parentElement;
        }
        return undefined;
      };

      // Deck first, then the interior: both altitudes, one rule.
      for (const step of ['deck', 'interior'] as const) {
        if (step === 'interior') enter(panel, mode, 'session-live');
        const moving = animated(panel.container);
        if (mode === 'list') {
          // The list view carries no animation at all, in any state — its
          // whole grammar is text. Nothing to justify, and nothing hidden.
          expect(moving).toHaveLength(0);
          continue;
        }
        expect(moving.length).toBeGreaterThan(0);
        for (const element of moving) {
          expect(justify(element), `${element.getAttribute('class')} animates unjustified`)
            .toBeDefined();
        }
      }
    });

    it('NEGATIVE CONTROL: everything done and ended animates nothing at all', () => {
      // The row C7.3 calls out as most easily satisfied by accident. Same
      // tree, same node count, one axis changed.
      const settled = settledSession();
      expect(walkSession(settled).some((n) => n.status === 'running')).toBe(false);

      const panel = panelWith([settled]);
      expect(animated(panel.container)).toHaveLength(0);
      enter(panel, mode, 'session-settled');
      expect(animated(panel.container)).toHaveLength(0);

      // ...and the control is not vacuous: the same panel fed the live tree
      // does animate, in the canvas. This is the mutation, run every time.
      if (mode === 'canvas') {
        expect(interiorCount(panel.container)).toBeGreaterThan(0);
        send({ type: 'snapshot', sessions: [liveSession()] });
        enter(panel, mode, 'session-live');
        expect(animated(panel.container).length).toBeGreaterThan(0);
      } else {
        expect(all(panel.container, 'tree-node').length).toBeGreaterThan(0);
      }
    });

    it('nothing static rides an animated ancestor', () => {
      // The class count alone cannot see a still element inheriting a moving
      // ancestor's transform: it moves on screen while carrying no animated
      // class, and the negative control above reads 0 while something is
      // visibly moving.
      //
      // THE WITNESS THIS ROW NAMED IS DELETED. It counted deck constellation
      // dots — one faint dot per node, inside a breathing membrane, which was
      // the hazard in its purest form — and `SessionBlob.svelte` went with the
      // phyllotaxis canvas. Nothing emitted `deck-constellation`, so the
      // canvas half failed on `length > 0` and the list half PASSED by
      // asserting an empty array was empty.
      //
      // The replacement is structural rather than a sweep of one component:
      // every animation-bearing class now sits on a CHILDLESS LEAF that
      // carries no coordinate anything else depends on — the card's border
      // and its standoff ring, a node's ring, a dot's halo, the filament path.
      // That is asserted over the whole panel at both altitudes, so it also
      // fails for a future component that wraps content in an animated group,
      // which the old one-component version could not have seen.
      const panel = panelWith([liveSession()]);
      if (mode !== 'canvas') {
        // The list view's grammar is text and it animates nothing at all, so
        // the property holds by there being nothing to ride. Stated, rather
        // than expressed as an empty loop that would read as coverage.
        expect(animated(panel.container)).toHaveLength(0);
        return;
      }

      const noneRides = (where: string): void => {
        const moving = animated(panel.container);
        // Positive control: the property is about a NON-EMPTY set. Without
        // this the two loops below are vacuous at every altitude.
        expect(
          moving.length,
          `${where}: nothing animates here, so this proves nothing`,
        ).toBeGreaterThan(0);
        for (const element of moving) {
          expect(
            element.childElementCount,
            `${where}: ${element.getAttribute('class') ?? ''} has children riding it`,
          ).toBe(0);
        }
        for (const element of [...panel.container.querySelectorAll('*')]) {
          expect(
            hasAnimatedAncestor(element),
            `${where}: ${element.getAttribute('class') ?? ''} rides an animated ancestor`,
          ).toBe(false);
        }
      };

      noneRides('deck');
      enter(panel, mode, 'session-live');
      noneRides('interior');

      // WAS WRITTEN ON THE TOOL DOTS, which A8.1 removed. The claim is the
      // same and its subject is now the NODE: only a node that is running
      // animates, a settled one carries no animated class of its own, and no
      // node sits inside an animated ancestor — which is what keeps the pulse a
      // property of the thing that is happening rather than of the group it
      // happens to be drawn in.
      const cells = all(panel.container, TESTID.cell).concat(
        all(panel.container, TESTID.nucleus),
      );
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.some((c) => c.dataset['active'] === 'true')).toBe(true);
      for (const cell of cells) {
        expect(hasAnimatedAncestor(cell)).toBe(false);
        if (cell.dataset['active'] === 'true') continue;
        expect(animated(cell)).toHaveLength(0);
      }
    });
  });
});

/* ------------------------------------------------------------------------ *
 * The two surfaces, compared — rows that are ABOUT there being two
 * ------------------------------------------------------------------------ */

describe('both surfaces are projections of the same store (C7.2)', () => {
  it('starts on the canvas with no setting and no host message', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    expect(one(panel.container, 'app').dataset['viewMode']).toBe('canvas');
    expect(one(panel.container, 'app').dataset['altitude']).toBe('deck');
    expect(all(panel.container, TESTID.deck)).toHaveLength(1);
    // The switch is an in-panel control, so nothing about it reaches the host.
    expect(panel.sent).toStrictEqual([]);
  });

  it('the in-panel toggle swaps the surface and nothing else', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    const toggle = one(panel.container, TESTID.viewToggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    click(toggle);
    expect(one(panel.container, 'app').dataset['viewMode']).toBe('list');
    expect(all(panel.container, TESTID.deck)).toHaveLength(0);
    expect(all(panel.container, 'session-rail')).toHaveLength(1);
    expect(one(panel.container, TESTID.viewToggle).getAttribute('aria-pressed')).toBe('false');

    click(one(panel.container, TESTID.viewToggle));
    expect(one(panel.container, 'app').dataset['viewMode']).toBe('canvas');
    expect(all(panel.container, TESTID.deck)).toHaveLength(1);

    // Still no message: the surface is webview-local UI state (C7.7).
    expect(panel.sent).toStrictEqual([]);
  });

  it('the same session data reaches both surfaces, and both agree what it is', () => {
    const panel = render();
    const sessions = [liveSession(), unsupportedSession(), foreignSession()];
    send({ type: 'snapshot', sessions });

    /** What one surface says each session IS, keyed by id. */
    const verdicts = (
      rows: HTMLElement[],
      foreign: (row: HTMLElement) => string,
    ): Map<string, string> =>
      new Map(
        rows.map((row) => [
          row.dataset['sessionId'] ?? '',
          [row.dataset['liveness'], row.dataset['refused'], foreign(row)].join('|'),
        ]),
      );

    const deckRows = all(panel.container, TESTID.deckBlob);
    const canvas = verdicts(deckRows, (r) => String(r.dataset['foreign']));
    const deckOrder = deckRows.map((r) => r.dataset['sessionId']);

    useView(panel, 'list');
    const railRows = all(panel.container, 'rail-item');
    const list = verdicts(railRows, (r) => String(all(r, 'rail-foreign').length > 0));
    const railOrder = railRows.map((r) => r.dataset['sessionId']);

    // C7.2 IS ABOUT AGREEMENT, AND THIS IS THE WHOLE OF IT: the same sessions
    // reach both surfaces and both say the same thing about each one. The key
    // set is asserted first, so a row silently dropped from either surface
    // fails here — the defect this row exists for, and the reason the
    // comparison is keyed rather than deep-equal on two arrays.
    expect([...canvas.keys()].sort()).toStrictEqual(sessions.map((s) => s.sessionId).sort());
    expect(canvas).toStrictEqual(list);

    // ORDER IS NO LONGER A THING THE TWO SURFACES SHARE, and the version of
    // this row that compared ordered arrays was asserting that they did. The
    // deck orders by its own declared sort — `Live first`, the design
    // default, a control the user drives — while the rail renders the store's
    // list order. Two deliberate answers to two different questions, and the
    // agreement above is unaffected by either.
    //
    // What C7.8 actually forbids is the GEOMETRY, or the order of arrival,
    // deciding the deck. That still holds and is asserted here: re-send the
    // same three sessions in the opposite order. The rail follows the store.
    // The deck must not move at all.
    const reversed = [...sessions].reverse();
    expect(railOrder).toStrictEqual(sessions.map((s) => s.sessionId));
    send({ type: 'snapshot', sessions: reversed });
    expect(all(panel.container, 'rail-item').map((r) => r.dataset['sessionId'])).toStrictEqual(
      reversed.map((s) => s.sessionId),
    );
    useView(panel, 'canvas');
    expect(all(panel.container, TESTID.deckBlob).map((r) => r.dataset['sessionId'])).toStrictEqual(
      deckOrder,
    );
  });

  it('a selection made in one surface is the selection in the other', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession(), liveSession({ sessionId: 'other' })] });
    click(blobFor(panel, 'other'));
    expect(one(panel.container, 'app').dataset['altitude']).toBe('session');
    expect(one(panel.container, TESTID.canvas).dataset['sessionId']).toBe('other');

    useView(panel, 'list');
    expect(railFor(panel, 'other').dataset['selected']).toBe('true');
    expect(one(panel.container, 'header-session-id').textContent?.trim()).toBe('other');
  });
});

/* ------------------------------------------------------------------------ *
 * Accessibility floor (C7.8)
 * ------------------------------------------------------------------------ */

describe('the accessibility floor', () => {
  it('makes cells and dots real focusable controls', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [parkedSession()] });
    click(blobFor(panel, 'session-parked'));

    const focusables = [
      ...all(panel.container, TESTID.nucleus),
      ...all(panel.container, TESTID.cell),
    ];
    expect(focusables.length).toBeGreaterThan(0);
    for (const element of focusables) {
      expect(element.getAttribute('tabindex')).toBe('0');
      expect(element.getAttribute('aria-label')).toBeTruthy();
      // Decorative SVG has no role. These are controls, except the parked
      // cell, which is reachable but has nothing to activate.
      const role = element.getAttribute('role');
      expect(role === 'button' || role === 'img').toBe(true);
    }

    // Focus actually lands, and the element that has it is the one asked.
    const first = focusables[0];
    if (first === undefined) throw new Error('unreachable');
    (first as unknown as { focus: () => void }).focus();
    expect(document.activeElement).toBe(first);
  });

  it('gives the deck blobs the same treatment, in store order', () => {
    const panel = render();
    const ids = ['a', 'b', 'c'];
    send({ type: 'snapshot', sessions: ids.map((id) => liveSession({ sessionId: id })) });
    const blobs = all(panel.container, TESTID.deckBlob);
    expect(blobs.map((b) => b.dataset['sessionId'])).toStrictEqual(ids);
    for (const blob of blobs) {
      expect(blob.getAttribute('tabindex')).toBe('0');
      expect(blob.getAttribute('role')).toBe('button');
      expect(blob.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('answers Enter and Space on a blob, not just a mouse', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    for (const key of ['Enter', ' ']) {
      act(() => panel.store.escape());
      act(() => panel.store.escape());
      expect(one(panel.container, 'app').dataset['altitude']).toBe('deck');
      harness.flushSync(() => {
        blobFor(panel, 'session-live').dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
      });
      expect(one(panel.container, 'app').dataset['altitude']).toBe('session');
    }
  });

  it('Escape walks the altitudes up: inspector -> session -> deck', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    const app = (): HTMLElement => one(panel.container, 'app');
    expect(app().dataset['altitude']).toBe('deck');

    click(blobFor(panel, 'session-live'));
    expect(app().dataset['altitude']).toBe('session');
    expect(all(panel.container, TESTID.inspector)).toHaveLength(0);

    click(one(panel.container, TESTID.nucleus));
    expect(app().dataset['altitude']).toBe('inspector');
    expect(all(panel.container, TESTID.inspector)).toHaveLength(1);
    // The drawer opens BELOW the interior, never instead of it.
    expect(all(panel.container, TESTID.canvas)).toHaveLength(1);

    escape();
    expect(app().dataset['altitude']).toBe('session');
    expect(all(panel.container, TESTID.inspector)).toHaveLength(0);
    expect(all(panel.container, TESTID.canvas)).toHaveLength(1);

    escape();
    expect(app().dataset['altitude']).toBe('deck');
    expect(all(panel.container, TESTID.deck)).toHaveLength(1);

    // A keystroke that changes nothing must not look like a change.
    escape();
    expect(app().dataset['altitude']).toBe('deck');
  });

  /**
   * WHERE THE DRAWER SITS, asserted in the assembled app.
   *
   * There was no assertion of this kind anywhere before 2026-08-28, and its
   * absence is the whole reason there was something to fix: `design.md` §8.6
   * and amendment A3 have specified a BOTTOM DRAWER since the design froze,
   * and the shipped inspector was a 22 em `<aside>` with a `border-left` —
   * the `0.1.x` side panel, carried unchanged through the entire Phase 7
   * rebuild. No Phase 7 DoD line named the drawer, so no work package owned
   * it, and nothing went red for a design that was never built.
   *
   * The structural half is here because only the assembled app can see it: a
   * component test renders the drawer alone and cannot tell a bottom row from
   * a side column. `inspector.test.ts` owns the geometry half.
   */
  it('opens the inspector as a bottom row of the app, not as a column beside the tree', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    click(blobFor(panel, 'session-live'));
    click(one(panel.container, TESTID.nucleus));

    const drawer = one(panel.container, TESTID.inspector);
    const body = one(panel.container, 'main').parentElement;
    expect(body, 'the interior has no body wrapper').not.toBeNull();

    // NOT inside the body. That is the difference between a drawer and a side
    // panel, and it is what makes "hiding it must not re-flow other rows"
    // true: the body owns the field's row and the drawer owns its own.
    expect(body?.contains(drawer)).toBe(false);
    // Siblings, drawer last: it is the bottom band of the column.
    expect(drawer.parentElement).toBe(body?.parentElement);
    expect(body?.nextElementSibling).toBe(drawer);
    expect(drawer.nextElementSibling).toBeNull();

    // ...and closing it gives the row back rather than leaving a gap.
    escape();
    expect(all(panel.container, TESTID.inspector)).toHaveLength(0);
    expect(all(panel.container, TESTID.canvas)).toHaveLength(1);
  });

  it('leaves Escape alone in the list view, which has no altitudes', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    click(blobFor(panel, 'session-live'));
    useView(panel, 'list');
    escape();
    // The store's altitude is untouched, so switching back lands where it was.
    useView(panel, 'canvas');
    expect(one(panel.container, 'app').dataset['altitude']).toBe('session');
  });

  it('swaps motion by CLASS when the user prefers reduced motion', () => {
    // C7.6: the swap is by class rather than by media query alone, and that is
    // what makes the rule assertable in jsdom, where the query does not
    // evaluate. The animation-bearing classes are still PRESENT — the
    // stylesheet turns them into static variants; the class is not removed.
    const panel = render({ reducedMotion: true });
    send({ type: 'snapshot', sessions: [liveSession()] });
    expect(one(panel.container, TESTID.deck).classList.contains(REDUCED_MOTION_CLASS)).toBe(true);
    click(blobFor(panel, 'session-live'));
    expect(one(panel.container, TESTID.canvas).classList.contains(REDUCED_MOTION_CLASS)).toBe(
      true,
    );

    // Positive control: without the preference the class is absent, so the
    // assertion above is about the preference and not about the markup.
    const plain = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    expect(one(plain.container, TESTID.deck).classList.contains(REDUCED_MOTION_CLASS)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * Rows of C7.3 that NO surface renders
 * ------------------------------------------------------------------------ */

describe('C7.3 rows that were unimplemented and now are not', () => {
  // This block did its job and was then rewritten by the job it did.
  //
  // It shipped asserting that `TESTID.hud`, `TESTID.hudDegradedChip` and the
  // canvas refusal card were reserved in the contract and emitted by NOTHING —
  // three C7.3/C7.4 rows with no implementation. Written as live assertions
  // rather than skips precisely so the day someone implemented them it would
  // turn red and demand conversion. `App.svelte` implemented them, it turned
  // red, and these are the real rows.

  it('shows the HUD, and its degraded chip when the hook tap is silent', () => {
    const panel = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    send({ type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' });
    click(blobFor(panel, 'session-live'));

    // C7.3: degraded ⇒ a HUD chip saying liveness is being INFERRED, because
    // the hook tap is silent (G2). The chip is what stops an inferred `live`
    // from reading like one a hook event actually witnessed.
    expect(all(panel.container, TESTID.hud)).toHaveLength(1);
    expect(one(panel.container, TESTID.hudDegradedChip).textContent).toContain('inferred');

    // ...and the totals, with cost as an em-dash. The host sends 0 meaning NOT
    // COMPUTED, and a 0 rendered as a number reads as "free" — a fabricated
    // figure, which is the class of defect this project refuses on principle.
    const totals = one(panel.container, 'hud-totals');
    // ASSERT THE VALUES, NOT THE PRESENCE OF A DASH. `toContain('—')` alone is
    // vacuous here: cost is always an em-dash, so it passes even when every
    // token figure is also a dash - which is exactly the defect a verifier
    // caught on `hotfix/0.1.3`, where this line read `totals.inputTokens`
    // after that field had been removed and the whole row rendered as dashes
    // in the shipped artifact. `.svelte` is outside `tsc`, so this assertion
    // is the only thing standing between that bug and a release.
    expect(totals.textContent).toContain('17,745');
    expect(totals.textContent).toContain('35,490');
    expect(totals.textContent).toContain('—');
    expect(totals.textContent).not.toMatch(/\$\s*0/);
  });

  it('shows the refusal card on entry, beside a genuinely empty interior', () => {
    // C7.4 in full: "entering it shows the refusal card with ZERO interior
    // elements". Both halves, together, because either alone is satisfiable
    // in a way that misses the point - an empty interior with no card is a
    // blank panel that explains nothing, and a card over a drawn tree is the
    // partial render G3 exists to forbid.
    const panel = render();
    send({ type: 'snapshot', sessions: [unsupportedSession()] });
    click(blobFor(panel, 'session-unsupported'));

    expect(interiorCount(panel.container)).toBe(0);
    expect(all(panel.container, 'refusal-screen')).toHaveLength(1);

    // The interior stays MOUNTED and reports its own refusal. That is the
    // second, independent guard: SessionCanvas decides emptiness from its own
    // layout, so the zero above is not merely a component being swapped out.
    expect(one(panel.container, TESTID.canvas).dataset['refused']).toBe('true');
  });
});
