// Auto-fit — the pure half (v0.7.0 Phase 4, DoD 4.0).
//
// NODE ENVIRONMENT: `fit.ts` never touches a DOM. The goldens at
// `webview/goldens/layout/fit.json` were written by
// `scripts/gen-webview-goldens.mjs` through the PRODUCTION `treeLayout`,
// `boundsOf` and `fit`; this file recomputes every case in-process from the
// same generator's inputs and compares. Two readers of one file, neither of
// which is the script — a golden that only the script can reproduce is a
// golden the script can quietly rewrite.
//
// Node builtins are imported by their real specifiers (`tsconfig.webview.json`
// sets `types: []`, which removes the GLOBALS, not the module graph) — the
// same arrangement `layout.test.ts` and `wire.test.ts` use.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { treeLayout } from '../layout.js';
import { TREE_FIT_PADDING, TREE_ZOOM_LIMITS, boundsOf, fitTo } from '../viewport.js';
import type { Rect, ViewportSize } from '../viewport.js';
import { drawerCoverage, fit, usableViewport } from './fit.js';

/** The generator's own inputs, imported so a change there is a change here. */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- a plain .mjs script with no declarations; the test asserts the shape it uses.
import { FIT_DRAWER_HEIGHT, FIT_NODE_COUNTS, FIT_VIEWPORTS, sessionOf } from '../../scripts/gen-webview-goldens.mjs';

interface FitCase {
  nodes: number;
  agents: number;
  viewport: ViewportSize;
  drawer: Rect | null;
  bounds: Rect;
  usable: ViewportSize;
  transform: { x: number; y: number; k: number };
}

const GOLDEN = JSON.parse(readFileSync(resolve('webview/goldens/layout/fit.json'), 'utf8')) as {
  drawerHeight: number;
  cases: FitCase[];
};

describe('the fit goldens — three viewports x drawer open/closed x 1/6/40 nodes', () => {
  it('is the full matrix, counted beside the set', () => {
    // 3 x 2 x 3 = 18. Written out rather than derived, so a generator that
    // silently dropped a viewport reads as a wrong count rather than a smaller
    // set that still matches itself.
    expect(GOLDEN.cases).toHaveLength(18);
    expect(FIT_VIEWPORTS).toHaveLength(3);
    expect(FIT_NODE_COUNTS).toStrictEqual([1, 6, 40]);
    expect(GOLDEN.drawerHeight).toBe(FIT_DRAWER_HEIGHT);
    const drawers = new Set(GOLDEN.cases.map((c) => (c.drawer === null ? 'closed' : 'open')));
    expect([...drawers].sort()).toStrictEqual(['closed', 'open']);
  });

  it('reproduces every case through production treeLayout, boundsOf and fit', () => {
    for (const nodes of FIT_NODE_COUNTS as number[]) {
      const state = sessionOf(nodes);
      const placements = treeLayout(state, 'root', { collapseDepth: Number.POSITIVE_INFINITY }).filter(
        (p) => !p.hidden,
      );
      const bounds = boundsOf(placements.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })));
      for (const viewport of FIT_VIEWPORTS as ViewportSize[]) {
        for (const open of [false, true]) {
          const drawer = open
            ? { x: 0, y: viewport.height - FIT_DRAWER_HEIGHT, w: viewport.width, h: FIT_DRAWER_HEIGHT }
            : null;
          const golden = GOLDEN.cases.find(
            (c) =>
              c.nodes === nodes &&
              c.viewport.width === viewport.width &&
              c.viewport.height === viewport.height &&
              (c.drawer === null) === !open,
          );
          expect(golden, `no golden for ${String(nodes)} nodes at ${String(viewport.width)}x${String(viewport.height)} drawer ${open ? 'open' : 'closed'}`).toBeDefined();
          if (golden === undefined) continue;
          expect(golden.agents).toBe(placements.length);
          expect(golden.bounds).toStrictEqual(bounds);
          expect(golden.usable).toStrictEqual(usableViewport(viewport, drawer));
          expect(golden.transform).toStrictEqual(fit(bounds, viewport, drawer));
        }
      }
    }
  });

  it('the 40-node subject really wraps: its bounds are wider than one row of eight', () => {
    // Vacuity control on the subject. A "40-node" tree that laid out as one
    // row would make the wide cases a rescaling of the narrow ones.
    const wide = GOLDEN.cases.find((c) => c.nodes === 40);
    const one = GOLDEN.cases.find((c) => c.nodes === 1);
    expect(wide?.bounds.w ?? 0).toBeGreaterThan(8 * 168);
    expect(wide?.bounds.h ?? 0).toBeGreaterThan(one?.bounds.h ?? 0);
  });
});

describe('fit() — the rule, stated as properties', () => {
  const bounds: Rect = { x: 100, y: 50, w: 800, h: 300 };
  const viewport: ViewportSize = { width: 960, height: 640 };

  it('with the drawer closed it is viewport.ts:fitTo with the tree padding and limits', () => {
    expect(fit(bounds, viewport, null)).toStrictEqual(
      fitTo(bounds, viewport, TREE_FIT_PADDING, TREE_ZOOM_LIMITS),
    );
  });

  it('an open drawer takes its band off the bottom of the usable field', () => {
    const drawer = { x: 0, y: 450, w: 960, h: 190 };
    expect(drawerCoverage(viewport, drawer)).toBe(190);
    expect(usableViewport(viewport, drawer)).toStrictEqual({ width: 960, height: 450 });
    expect(fit(bounds, viewport, drawer)).toStrictEqual(
      fitTo(bounds, { width: 960, height: 450 }, TREE_FIT_PADDING, TREE_ZOOM_LIMITS),
    );
    // And it is a DIFFERENT answer from the closed case — the drawer is not
    // decoration on the argument list.
    expect(fit(bounds, viewport, drawer)).not.toStrictEqual(fit(bounds, viewport, null));
  });

  it('a drawer that starts inside the field covers everything beneath its top edge, however tall', () => {
    // Docked to the bottom: what lies below the top edge is hidden whether
    // the drawer is 190 px or 4 000 px tall.
    expect(drawerCoverage(viewport, { x: 0, y: 500, w: 960, h: 190 })).toBe(140);
    expect(drawerCoverage(viewport, { x: 0, y: 500, w: 960, h: 4000 })).toBe(140);
  });

  it('a drawer below the field, beside it, or of no size covers nothing', () => {
    expect(drawerCoverage(viewport, { x: 0, y: 640, w: 960, h: 190 })).toBe(0);
    expect(drawerCoverage(viewport, { x: 0, y: 900, w: 960, h: 190 })).toBe(0);
    expect(drawerCoverage(viewport, { x: 960, y: 450, w: 300, h: 190 })).toBe(0);
    expect(drawerCoverage(viewport, { x: -300, y: 450, w: 300, h: 190 })).toBe(0);
    expect(drawerCoverage(viewport, { x: 0, y: 450, w: 0, h: 190 })).toBe(0);
    expect(drawerCoverage(viewport, { x: 0, y: 450, w: 960, h: 0 })).toBe(0);
    expect(drawerCoverage(viewport, null)).toBe(0);
  });

  it('a drawer that covers the whole field leaves a zero-height usable area, never a negative one', () => {
    expect(usableViewport(viewport, { x: 0, y: -10, w: 960, h: 700 })).toStrictEqual({
      width: 960,
      height: 0,
    });
  });

  it('frames the content inside the usable area when the zoom limits do not bind', () => {
    // For every golden case where the scale is strictly inside the limits,
    // the fitted content sits inside the usable area with the padding intact.
    let checked = 0;
    for (const c of GOLDEN.cases) {
      const { k, x, y } = c.transform;
      if (k <= TREE_ZOOM_LIMITS.min || k >= TREE_ZOOM_LIMITS.max) continue;
      checked += 1;
      const left = c.bounds.x * k + x;
      const top = c.bounds.y * k + y;
      const right = (c.bounds.x + c.bounds.w) * k + x;
      const bottom = (c.bounds.y + c.bounds.h) * k + y;
      expect(left).toBeGreaterThanOrEqual(TREE_FIT_PADDING - 1e-6);
      expect(top).toBeGreaterThanOrEqual(TREE_FIT_PADDING - 1e-6);
      expect(right).toBeLessThanOrEqual(c.usable.width - TREE_FIT_PADDING + 1e-6);
      expect(bottom).toBeLessThanOrEqual(c.usable.height - TREE_FIT_PADDING + 1e-6);
    }
    // Not vacuous: at least the 40-node cases land between the limits.
    expect(checked).toBeGreaterThan(0);
  });

  it('answers non-finite input with the identity rather than NaN', () => {
    expect(fit({ x: 0, y: 0, w: Number.NaN, h: 10 }, viewport, null)).toStrictEqual({ x: 0, y: 0, k: 1 });
    expect(fit(bounds, { width: Number.POSITIVE_INFINITY, height: 10 }, null)).toStrictEqual({
      x: 0,
      y: 0,
      k: 1,
    });
  });

  it('is pure: the same arguments give the same answer, and nothing is mutated', () => {
    const b = { ...bounds };
    const v = { ...viewport };
    const d = { x: 0, y: 450, w: 960, h: 190 };
    const first = fit(b, v, d);
    const second = fit(b, v, d);
    expect(second).toStrictEqual(first);
    expect(b).toStrictEqual(bounds);
    expect(v).toStrictEqual(viewport);
    expect(d).toStrictEqual({ x: 0, y: 450, w: 960, h: 190 });
  });
});
