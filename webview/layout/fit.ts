/**
 * Auto-fit — the pure half (v0.7.0 Phase 4, DoD 4.0).
 *
 * `fit(bounds, viewport, drawerRect)` answers ONE question: given what is
 * drawn, the field it is drawn into, and the drawer that may cover part of
 * that field, what transform frames the content? It is a function of its
 * three arguments and nothing else — no DOM, no clock, no store — which is
 * what lets `webview/goldens/layout/fit.json` pin it at three viewports x
 * drawer open/closed x 1/6/40 nodes, and what lets `store.ts` call it without
 * knowing how any of the three numbers was measured.
 *
 * WHEN it is called is not decided here. That is `store.ts`'s trigger table
 * (`FIT_TRIGGERS`): every event that moves geometry fits, every event that
 * moves only a number does not, and `agentDeck.canvas.autoFit = false` means
 * the store never calls this after the renderer's own entry fit.
 *
 * THE TRANSFORM IS A TRANSFORM, never a coordinate — the rule `viewport.ts`
 * states for every other pan/zoom operation, restated here because auto-fit is
 * the operation most tempted to edit a placement. `layout.ts` stays pure and
 * its goldens stay valid as numbers; this function only decides where the
 * wrapper `<g>` sits.
 *
 * THE DRAWER. `App.svelte` gives the drawer a grid row of its own, so on the
 * shipped layout the field SHRINKS when the drawer opens and `drawerRect` is
 * usually outside the field entirely. The argument still exists, and is still
 * honoured, because the design (§8.6) does not promise the field will always be
 * a separate row: a drawer that overlaps the field's bottom band must not be
 * allowed to hide the bottom of a tree that was just "fitted". The usable area
 * is the field minus whatever the drawer covers along its bottom edge.
 */

import type { Rect, Viewport, ViewportSize } from '../viewport.js';
import { TREE_FIT_PADDING, TREE_ZOOM_LIMITS, fitTo } from '../viewport.js';

/**
 * The rectangle the drawer occupies, in the FIELD's client coordinates —
 * the same space `viewport` is measured in. `null` when the drawer is closed.
 */
export type DrawerRect = Rect | null;

/**
 * How much of the field's height the drawer covers from the bottom.
 *
 * A drawer that starts below the field, or overlaps it horizontally not at
 * all, covers nothing. One that starts inside the field covers everything
 * from its top edge down — the drawer is docked to the bottom (§8.6), so what
 * lies beneath its top edge is not visible however tall it is.
 */
export function drawerCoverage(viewport: ViewportSize, drawer: DrawerRect): number {
  if (drawer === null) return 0;
  if (!Number.isFinite(drawer.y) || !Number.isFinite(drawer.h)) return 0;
  if (drawer.w <= 0 || drawer.h <= 0) return 0;
  if (drawer.x >= viewport.width || drawer.x + drawer.w <= 0) return 0;
  const top = Math.max(0, drawer.y);
  if (top >= viewport.height) return 0;
  return viewport.height - top;
}

/**
 * The usable field: the viewport less the band the drawer covers.
 *
 * Exported so the goldens can state the intermediate value beside the answer,
 * which is what makes a golden readable when it goes red.
 */
export function usableViewport(viewport: ViewportSize, drawer: DrawerRect): ViewportSize {
  const covered = drawerCoverage(viewport, drawer);
  return { width: viewport.width, height: Math.max(0, viewport.height - covered) };
}

/**
 * Frame `bounds` inside the usable part of `viewport`.
 *
 * The padding and the zoom limits are the tree's (`TREE_FIT_PADDING`,
 * `TREE_ZOOM_LIMITS`) because the session interior is the only surface that
 * auto-fits — the locked open question names "the canvas", and the deck keeps
 * its double-click fit. Non-finite input is answered with the identity rather
 * than with `NaN` in a transform attribute, which would blank the field.
 */
export function fit(bounds: Rect, viewport: ViewportSize, drawer: DrawerRect): Viewport {
  const finite = [bounds.x, bounds.y, bounds.w, bounds.h, viewport.width, viewport.height];
  if (finite.some((n) => !Number.isFinite(n))) return { x: 0, y: 0, k: 1 };
  const usable = usableViewport(viewport, drawer);
  return fitTo(bounds, usable, TREE_FIT_PADDING, TREE_ZOOM_LIMITS);
}
