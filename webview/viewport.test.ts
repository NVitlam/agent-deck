// The viewport, tested with no DOM at all.
//
// NODE ENVIRONMENT, deliberately. Every function in `viewport.ts` takes the
// numbers it needs as arguments - the pointer position, the element size, the
// content bounds - precisely so that pan, zoom and fit are checkable without a
// browser. A jsdom test here would prove less and cost more.
//
// WHY THIS MODULE IS TESTED THIS HARD. It is a SEAM: the deck, the session
// tree and the focus view all consume it, and two of those three are written
// by later packages. This repository's most expensive recorded defect class is
// two packages that each invented their own version of one shared rule, agreed
// internally, and disagreed at the boundary with nothing failing. The
// assertions below are what the later packages inherit instead of a guess.

import { describe, expect, it } from 'vitest';

import {
  DECK_FIT_PADDING,
  DECK_ZOOM_LIMITS,
  IDENTITY_VIEWPORT,
  TREE_FIT_PADDING,
  TREE_ZOOM_LIMITS,
  ZOOM_FACTOR,
  boundsOf,
  clampScale,
  fitTo,
  panBy,
  sameViewport,
  toClient,
  toStage,
  transformAttr,
  viewportWidthInStageUnits,
  zoomAbout,
} from './viewport.js';
import type { Viewport } from './viewport.js';

const round = (v: number): number => Math.round(v * 1e6) / 1e6;

describe('the design constants', () => {
  it('carries the two zoom ranges and the notch factor', () => {
    expect(DECK_ZOOM_LIMITS).toEqual({ min: 0.5, max: 2 });
    expect(TREE_ZOOM_LIMITS).toEqual({ min: 0.4, max: 2 });
    expect(ZOOM_FACTOR).toBe(1.1);
  });

  it('carries the two fit paddings', () => {
    expect(DECK_FIT_PADDING).toBe(24);
    expect(TREE_FIT_PADDING).toBe(32);
  });

  it('starts untransformed', () => {
    expect(IDENTITY_VIEWPORT).toEqual({ x: 0, y: 0, k: 1 });
  });
});

describe('panning', () => {
  it('adds client deltas to the translation and leaves the scale alone', () => {
    const view: Viewport = { x: 10, y: -5, k: 1.5 };
    expect(panBy(view, 7, 3)).toEqual({ x: 17, y: -2, k: 1.5 });
  });

  it('moves content by exactly the cursor delta at any scale', () => {
    // The failure this prevents: dividing the delta by the scale, which makes
    // the content lag the cursor at every zoom except 1.
    for (const k of [0.4, 1, 2]) {
      const view: Viewport = { x: 0, y: 0, k };
      const before = toClient(view, 100, 100);
      const after = toClient(panBy(view, 40, -25), 100, 100);
      expect(round(after.x - before.x)).toBe(40);
      expect(round(after.y - before.y)).toBe(-25);
    }
  });

  it('never returns the object it was given', () => {
    const view: Viewport = { x: 0, y: 0, k: 1 };
    expect(panBy(view, 1, 1)).not.toBe(view);
    expect(view).toEqual({ x: 0, y: 0, k: 1 });
  });
});

describe('stage and client coordinates', () => {
  it('round-trips through the transform', () => {
    const view: Viewport = { x: 37, y: -12, k: 1.75 };
    const stage = toStage(view, 400, 250);
    const back = toClient(view, stage.x, stage.y);
    expect(round(back.x)).toBe(400);
    expect(round(back.y)).toBe(250);
  });

  it('writes the transform SVG applies, in the order it applies it', () => {
    expect(transformAttr({ x: 3, y: 4, k: 2 })).toBe('translate(3 4) scale(2)');
  });
});

describe('zooming about the cursor', () => {
  it('keeps the stage point under the cursor fixed', () => {
    // The whole contract of a cursor zoom, stated as an invariant rather than
    // as an expected number: whatever was under the pointer is still under it.
    let view: Viewport = { x: 0, y: 0, k: 1 };
    const cursor = { x: 512, y: 300 };
    const anchor = toStage(view, cursor.x, cursor.y);
    for (const notches of [1, 1, -1, 2, -3, 1]) {
      view = zoomAbout(view, cursor.x, cursor.y, notches, DECK_ZOOM_LIMITS);
      const now = toClient(view, anchor.x, anchor.y);
      expect(round(now.x)).toBe(cursor.x);
      expect(round(now.y)).toBe(cursor.y);
    }
  });

  it('scales by the factor per notch', () => {
    const view = zoomAbout({ x: 0, y: 0, k: 1 }, 0, 0, 1, DECK_ZOOM_LIMITS);
    expect(round(view.k)).toBe(round(1.1));
    const twice = zoomAbout(view, 0, 0, 1, DECK_ZOOM_LIMITS);
    expect(round(twice.k)).toBe(round(1.1 * 1.1));
  });

  it('clamps to the deck range 0.5 to 2', () => {
    let view: Viewport = { x: 0, y: 0, k: 1 };
    for (let i = 0; i < 100; i += 1) view = zoomAbout(view, 400, 400, 1, DECK_ZOOM_LIMITS);
    expect(view.k).toBe(2);
    for (let i = 0; i < 200; i += 1) view = zoomAbout(view, 400, 400, -1, DECK_ZOOM_LIMITS);
    expect(view.k).toBe(0.5);
  });

  it('clamps to the tree range 0.4 to 2', () => {
    let view: Viewport = { x: 0, y: 0, k: 1 };
    for (let i = 0; i < 200; i += 1) view = zoomAbout(view, 0, 0, -1, TREE_ZOOM_LIMITS);
    expect(view.k).toBe(0.4);
  });

  it('does not drift the translation once the scale is pinned at a limit', () => {
    // Recomputing the translation on a no-op zoom is a slow pan the user never
    // asked for, and it only shows up after the tenth wheel notch.
    let view: Viewport = { x: 0, y: 0, k: 1 };
    for (let i = 0; i < 50; i += 1) view = zoomAbout(view, 640, 360, 1, DECK_ZOOM_LIMITS);
    const pinned = view;
    for (let i = 0; i < 20; i += 1) view = zoomAbout(view, 123, 456, 1, DECK_ZOOM_LIMITS);
    expect(sameViewport(view, pinned)).toBe(true);
    expect(view).toBe(pinned);
  });

  it('accepts a fractional notch, for a trackpad', () => {
    const view = zoomAbout({ x: 0, y: 0, k: 1 }, 0, 0, 0.5, DECK_ZOOM_LIMITS);
    expect(round(view.k)).toBe(round(Math.sqrt(1.1)));
  });
});

describe('clampScale', () => {
  it('bounds on both sides and rejects a non-finite scale', () => {
    expect(clampScale(10, DECK_ZOOM_LIMITS)).toBe(2);
    expect(clampScale(0.1, DECK_ZOOM_LIMITS)).toBe(0.5);
    expect(clampScale(1, DECK_ZOOM_LIMITS)).toBe(1);
    expect(clampScale(Number.NaN, DECK_ZOOM_LIMITS)).toBe(0.5);
    expect(clampScale(Number.POSITIVE_INFINITY, DECK_ZOOM_LIMITS)).toBe(0.5);
  });
});

describe('bounds of placed content', () => {
  it('takes drawn size into account when it is given', () => {
    expect(boundsOf([{ x: 0, y: 0, w: 220, h: 88 }, { x: 236, y: 100, w: 220, h: 88 }])).toEqual({
      x: 0,
      y: 0,
      w: 456,
      h: 188,
    });
  });

  it('treats a bare point as zero-sized', () => {
    expect(boundsOf([{ x: -10, y: 5 }, { x: 10, y: 25 }])).toEqual({
      x: -10,
      y: 5,
      w: 20,
      h: 20,
    });
  });

  it('gives an empty list a zero rectangle rather than an infinite one', () => {
    expect(boundsOf([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('fitting', () => {
  it('centres the content and leaves the padding clear', () => {
    const content = { x: 0, y: 0, w: 400, h: 200 };
    const view = fitTo(content, { width: 848, height: 464 }, DECK_FIT_PADDING, DECK_ZOOM_LIMITS);
    // (848 - 48) / 400 = 2 and (464 - 48) / 200 = 2.08, so width binds.
    expect(view.k).toBe(2);
    const topLeft = toClient(view, content.x, content.y);
    const bottomRight = toClient(view, content.x + content.w, content.y + content.h);
    expect(round(topLeft.x)).toBe(DECK_FIT_PADDING);
    expect(round(848 - bottomRight.x)).toBe(DECK_FIT_PADDING);
    // The other axis is centred, so it has MORE than the padding.
    expect(topLeft.y).toBeGreaterThan(DECK_FIT_PADDING);
    expect(round(topLeft.y + (464 - bottomRight.y))).toBe(round(464 - 400));
  });

  it('fits content that does not start at the origin', () => {
    const content = { x: 500, y: -300, w: 200, h: 100 };
    const view = fitTo(content, { width: 1000, height: 600 }, TREE_FIT_PADDING, TREE_ZOOM_LIMITS);
    const centre = toClient(view, content.x + content.w / 2, content.y + content.h / 2);
    expect(round(centre.x)).toBe(500);
    expect(round(centre.y)).toBe(300);
  });

  it('respects the zoom limits rather than filling the frame', () => {
    // A tiny tree in a big window would otherwise fit at 20x.
    const view = fitTo({ x: 0, y: 0, w: 10, h: 10 }, { width: 1000, height: 1000 }, 32, TREE_ZOOM_LIMITS);
    expect(view.k).toBe(TREE_ZOOM_LIMITS.max);
    const huge = fitTo({ x: 0, y: 0, w: 100_000, h: 100_000 }, { width: 800, height: 600 }, 24, TREE_ZOOM_LIMITS);
    expect(huge.k).toBe(TREE_ZOOM_LIMITS.min);
  });

  it('fits empty content at scale 1 instead of dividing by zero', () => {
    const view = fitTo({ x: 0, y: 0, w: 0, h: 0 }, { width: 800, height: 600 }, 24, DECK_ZOOM_LIMITS);
    expect(view.k).toBe(1);
    expect(view).toEqual({ x: 400, y: 300, k: 1 });
  });

  it('fits without dividing by a negative frame when the panel is smaller than its padding', () => {
    const view = fitTo({ x: 0, y: 0, w: 100, h: 100 }, { width: 20, height: 20 }, 24, DECK_ZOOM_LIMITS);
    expect(view.k).toBe(1);
    expect(Number.isFinite(view.x)).toBe(true);
    expect(Number.isFinite(view.y)).toBe(true);
  });
});

describe('the deck width conversion', () => {
  it('divides pixels by the scale, so the grid does not re-column on a wheel notch', () => {
    // `deckLayout` takes STAGE units. Handing it raw pixels while zoomed is a
    // reflow of every card, arriving through the one argument that is allowed
    // to be a measurement.
    expect(viewportWidthInStageUnits(800, 1)).toBe(800);
    expect(viewportWidthInStageUnits(800, 2)).toBe(400);
    expect(viewportWidthInStageUnits(800, 0.5)).toBe(1600);
  });

  it('does not divide by a zero or negative scale', () => {
    expect(viewportWidthInStageUnits(800, 0)).toBe(800);
    expect(viewportWidthInStageUnits(800, -1)).toBe(800);
  });
});

describe('the transform survives', () => {
  it('is plain data, so a store can hold it across every re-render', () => {
    const view: Viewport = { x: 12, y: 34, k: 1.25 };
    const roundTripped = JSON.parse(JSON.stringify(view)) as Viewport;
    expect(sameViewport(roundTripped, view)).toBe(true);
    expect(Object.keys(view).sort()).toEqual(['k', 'x', 'y']);
  });

  it('compares by value', () => {
    expect(sameViewport({ x: 1, y: 2, k: 3 }, { x: 1, y: 2, k: 3 })).toBe(true);
    expect(sameViewport({ x: 1, y: 2, k: 3 }, { x: 1, y: 2, k: 3.5 })).toBe(false);
  });
});
