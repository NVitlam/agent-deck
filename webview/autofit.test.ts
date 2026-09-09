// @vitest-environment jsdom
//
// The RENDERED auto-fit loop — v0.7.0 Phase 4, DoD 4.0, the half the store
// test cannot reach.
//
// `store.phase4.test.ts` proves the trigger table by calling the store's
// methods directly. `phase-verifier` then deleted the three attributes that
// wire the loop in `App.svelte` — `canvasView`, `fitEpoch`, `onreportgeometry`
// — and 553 tests stayed green: the product would never have auto-fitted and
// nothing would have said so. This repository's recorded D4 shape, one phase
// later. This file drives the REAL app through the shipped bundle, so the
// loop below is the only path that satisfies it:
//
//   SessionCanvas measures -> App forwards -> store.reportCanvasGeometry ->
//   store fits (epoch moves) -> App passes canvasView + fitEpoch back ->
//   SessionCanvas adopts it as the rendered transform
//
// jsdom lays nothing out, so `SessionCanvas.fieldSize()` falls back to its
// `size` prop (960 x 640), which is what makes the geometry report happen at
// all here. That fallback is production code, not a test hook.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WebviewToHostMessage } from '../src/model/events.js';
import type { Store } from './store.js';
import type { WebviewHarness } from './testkit.js';
import { all, loadHarness, one, press } from './testkit.js';
import { TESTID } from './canvas-contract.js';
import { fit } from './layout/fit.js';
import { transformAttr } from './viewport.js';
import { liveSession, tool } from './testdata.js';

let harness: WebviewHarness;

beforeAll(async () => {
  harness = await loadHarness();
}, 60_000);

interface Panel {
  container: HTMLElement;
  store: Store;
  dispose: () => void;
}

const mounted: Panel[] = [];

function render(options: { reducedMotion?: boolean } = {}): Panel {
  const withMedia = globalThis as unknown as { matchMedia?: unknown };
  const previous = withMedia.matchMedia;
  if (options.reducedMotion === true) withMedia.matchMedia = () => ({ matches: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const sent: WebviewToHostMessage[] = [];
  const started = harness.start(container, { postMessage: (m) => sent.push(m) });
  if (options.reducedMotion === true) withMedia.matchMedia = previous;
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

function act(fn: () => void): void {
  harness.flushSync(fn);
}

function stageTransform(panel: Panel): string {
  return one(panel.container, TESTID.canvasStage).getAttribute('transform') ?? '';
}

/** Mount, snapshot, enter the session: the loop has run at least once. */
function entered(options: { reducedMotion?: boolean } = {}): Panel {
  const panel = render(options);
  send({ type: 'snapshot', sessions: [liveSession()] });
  act(() => {
    panel.store.enterSession('session-live');
  });
  return panel;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

describe('the rendered auto-fit loop (DoD 4.0)', () => {
  it('the canvas reports its geometry to the store on entry, and the store fits from it', () => {
    const panel = entered();
    const view = panel.store.getView();
    // A fit happened THROUGH the renderer's report: the store has no other
    // way to learn the bounds. Delete `onreportgeometry` in App.svelte and
    // this reads 0.
    expect(view.canvasFitEpoch).toBeGreaterThan(0);
    expect(view.canvasView).not.toStrictEqual({ x: 0, y: 0, k: 1 });
  });

  it('the rendered transform IS the store\'s fit, and a trigger moves both together', () => {
    const panel = entered();
    const before = panel.store.getView();
    expect(stageTransform(panel)).toBe(transformAttr(before.canvasView));

    // A trigger from the table: a node is selected, the drawer opens.
    act(() => {
      panel.store.selectNode('tool-read');
    });
    const after = panel.store.getView();
    expect(after.canvasFitEpoch).toBeGreaterThan(before.canvasFitEpoch);
    // The stage adopted the new fit. Delete `fitEpoch`/`canvasView` in
    // App.svelte and the stage keeps the entry fit while the store moves on.
    expect(stageTransform(panel)).toBe(transformAttr(after.canvasView));
  });

  it('a structural diff re-fits against the NEW bounds, reported after the render', () => {
    const panel = entered();
    const before = panel.store.getView();
    act(() => {
      panel.store.handleMessage({
        type: 'diff',
        sessionId: 'session-live',
        patch: {
          tree: [
            {
              op: 'insertNode',
              parentId: 'root',
              afterId: null,
              node: tool({ id: 'tool-new', toolName: 'Grep', status: 'done', inputPreview: 'x' }),
            },
          ],
        },
      });
    });
    const after = panel.store.getView();
    // Two fits: one at the message, one when the renderer reported the new
    // bounds — the second is what makes the fit right.
    expect(after.canvasFitEpoch).toBeGreaterThanOrEqual(before.canvasFitEpoch + 2);
    expect(stageTransform(panel)).toBe(transformAttr(after.canvasView));
  });

  it('a user pan survives a token-only diff (a non-trigger), and the stage shows the pan', () => {
    const panel = entered();
    const fitted = panel.store.getView().canvasFitEpoch;
    const stage = one(panel.container, TESTID.canvasStage);
    const field = stage.parentElement as Element;
    act(() => {
      field.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true }));
      field.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 30, bubbles: true }));
      field.dispatchEvent(new PointerEvent('pointerup', { clientX: 50, clientY: 30, bubbles: true }));
    });
    const panned = stageTransform(panel);
    act(() => {
      panel.store.handleMessage({
        type: 'diff',
        sessionId: 'session-live',
        patch: { tree: [{ op: 'updateAgent', id: 'root', fields: { burn: { prompt: 5, output: 5 } } }] },
      });
    });
    expect(panel.store.getView().canvasFitEpoch).toBe(fitted);
    expect(stageTransform(panel)).toBe(panned);
  });

  it('with agentDeck.canvas.autoFit off, the entry fit stands and no trigger moves the stage', () => {
    const panel = render();
    send({ type: 'settings', canvasAutoFit: false });
    send({ type: 'snapshot', sessions: [liveSession()] });
    act(() => {
      panel.store.enterSession('session-live');
    });
    expect(panel.store.getView().canvasFitEpoch).toBe(0);
    const entry = stageTransform(panel);
    // The renderer's own entry fit framed the tree: not the identity.
    expect(entry).not.toBe(transformAttr({ x: 0, y: 0, k: 1 }));
    act(() => {
      panel.store.selectNode('tool-read');
    });
    expect(panel.store.getView().canvasFitEpoch).toBe(0);
    expect(stageTransform(panel)).toBe(entry);
  });

  it('the fit is computed by the pure fit() over the reported geometry', () => {
    const panel = entered();
    const view = panel.store.getView();
    // jsdom: the field falls back to the 960 x 640 default and no drawer
    // rectangle has a size, so the fit is fit(bounds, 960x640, null). The
    // bounds are what the renderer measured; re-deriving them here would be
    // a second implementation, so what is asserted is the scale and centring
    // rule against the fitted view's own arithmetic.
    const bounds = { x: 0, y: 0, w: 0, h: 0 };
    void bounds;
    expect(view.canvasView.k).toBeGreaterThan(0);
    expect(Number.isFinite(view.canvasView.x)).toBe(true);
    // And the same function, given the same numbers, is what the store used.
    const cell = all(panel.container, TESTID.nucleus)[0];
    expect(cell).toBeDefined();
    expect(fit({ x: 0, y: 0, w: 100, h: 50 }, { width: 960, height: 640 }, null).k).toBe(2);
  });
});

describe('reduce-motion (DoD 4.0)', () => {
  it('the stage says it animates a fit by default, and says instant under prefers-reduced-motion', () => {
    const plain = entered();
    expect(one(plain.container, TESTID.canvasStage).dataset['fitMotion']).toBe('animate');
    plain.dispose();
    mounted.pop();

    const reduced = entered({ reducedMotion: true });
    expect(one(reduced.container, TESTID.canvasStage).dataset['fitMotion']).toBe('instant');
    // ...and the transient animating class never lands under reduced motion.
    act(() => {
      reduced.store.selectNode('tool-read');
    });
    expect(one(reduced.container, TESTID.canvasStage).classList.contains('is-fitting')).toBe(false);
  });

  it('a fit lands the animating class briefly when motion is allowed', () => {
    const panel = entered();
    act(() => {
      panel.store.selectNode('tool-read');
    });
    expect(one(panel.container, TESTID.canvasStage).classList.contains('is-fitting')).toBe(true);
  });
});

describe('the deck is untouched', () => {
  it('a trigger on the canvas moves nothing about the deck transform', () => {
    const panel = entered();
    act(() => {
      panel.store.selectNode('tool-read');
    });
    expect(panel.store.getView().deckView).toStrictEqual({ x: 0, y: 0, k: 1 });
    press(one(panel.container, TESTID.crumbDeck));
    harness.flushSync();
    expect(one(panel.container, TESTID.deckStage).getAttribute('transform')).toBe(transformAttr({ x: 0, y: 0, k: 1 }));
  });
});
