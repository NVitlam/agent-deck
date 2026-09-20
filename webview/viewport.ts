/**
 * Agent Deck canvas — the viewport. ONE module, three consumers.
 *
 * The deck, the session tree and the focus view all pan and zoom, and the
 * design names one viewport for all three. That is not tidiness: this
 * repository's most expensive recorded defect class is two packages that each
 * invented their own version of a shared rule, agreed internally, and
 * disagreed at the boundary — both fully tested, nothing failing. So the rule
 * lives here once and the renderers import it.
 *
 * THE TRANSFORM IS A TRANSFORM, NEVER A COORDINATE. Everything below produces
 * a `{ x, y, k }` triple that the renderer writes onto ONE wrapper `<g>` as
 * `transform`. It never edits a placement. Three things depend on that and all
 * three break silently if it is violated:
 *
 *  - `layout.ts` stays a pure function of state,
 *  - its goldens stay valid as NUMBERS rather than as numbers-at-a-zoom,
 *  - "a spawn adds, it never reflows" survives a user dragging the view.
 *
 * The transform is STORE STATE and survives every re-render. A new event does
 * not reset it, switching deck layout/sort/filter does not fit, and only
 * re-rooting and an explicit double-click call {@link fitTo}.
 *
 * PURE. No DOM, no clock, no randomness — every function takes the numbers it
 * needs as arguments, which is what lets the whole module be tested in the
 * node environment with no jsdom at all.
 */

/**
 * Pan and zoom, as an SVG transform.
 *
 * Applied in the order SVG applies it: `translate(x, y) scale(k)`. So a stage
 * point `p` lands at client `p * k + (x, y)`, and {@link toStage} is the exact
 * inverse.
 */
export interface Viewport {
  /** Translation, in CLIENT pixels. */
  x: number;
  /** Translation, in CLIENT pixels. */
  y: number;
  /** Scale. Stage units to client pixels. */
  k: number;
}

/** Inclusive zoom bounds. */
export interface ZoomLimits {
  min: number;
  max: number;
}

/** A rectangle in stage units. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Client-pixel size of the element the stage is drawn into. */
export interface ViewportSize {
  width: number;
  height: number;
}

/** Untransformed: origin at the top left, scale 1. */
export const IDENTITY_VIEWPORT: Viewport = { x: 0, y: 0, k: 1 };

/** Deck zoom range. */
export const DECK_ZOOM_LIMITS: ZoomLimits = { min: 0.5, max: 2 };

/** Tree zoom range. Further out than the deck, because a tree gets wider. */
export const TREE_ZOOM_LIMITS: ZoomLimits = { min: 0.4, max: 2 };

/**
 * Scale multiplier per wheel notch — v0.9.0 DoD 9.14.
 *
 * **1.05, reduced from 1.1**, and the reduction is half of the fix. The other
 * half is {@link WHEEL_NOTCH_DELTA}: until this release every wheel EVENT was
 * one notch, so a trackpad — which emits a burst of small events per flick —
 * applied ten per cent per event and crossed the whole zoom range in one
 * gesture. The own-eyes pass called the sensitivity far too high; this is
 * the measured step the spec's `Amendment 2026-09-20` locks, and
 * `webview/goldens/zoom-step.json` is what locks it.
 */
export const ZOOM_FACTOR = 1.05;

/**
 * How much wheel travel makes one notch, in CSS pixels.
 *
 * 100 is not a preference: it is one detent of a standard mouse wheel in a
 * Chromium `DOM_DELTA_PIXEL` event, so a mouse behaves exactly as it always
 * did — one click, one notch — while a trackpad flick is divided by its
 * TRAVEL rather than multiplied by its event count.
 */
export const WHEEL_NOTCH_DELTA = 100;

/**
 * Silence that ends a gesture, in milliseconds.
 *
 * The accumulator is reset after it, so a part-notch left over from one flick
 * never adds itself to the next one — which is what "one notch per gesture,
 * not per event" means in a stream that has no gesture-end event of its own.
 */
export const WHEEL_GESTURE_IDLE_MS = 120;

/**
 * `WheelEvent.deltaMode` in CSS pixels.
 *
 * A LINE is 100/3 px so that Firefox's three-lines-per-detent and Chromium's
 * 100-px-per-detent come to the same one notch. A PAGE is treated as one
 * detent: it is rare, and a large multiplier there is the direction that
 * surprises a user who has never seen it before.
 */
const DELTA_MODE_PX: Readonly<Record<number, number>> = Object.freeze({
  0: 1,
  1: WHEEL_NOTCH_DELTA / 3,
  2: WHEEL_NOTCH_DELTA,
});

/** One wheel stream's accumulator. Pure; the caller supplies the clock. */
export interface WheelNotcher {
  /**
   * Feed one wheel event. Returns the SIGNED notches it completed — usually
   * 0, because most events are a fraction of a detent.
   */
  feed(deltaY: number, deltaMode: number, atMs: number): number;
}

/**
 * Turn a wheel stream into notches.
 *
 * ONE ACCUMULATOR PER SURFACE, and it is a closure rather than component
 * state so the rule is written once and both canvases obey the same one —
 * including ctrl+wheel and trackpad pinch, which arrive as ordinary wheel
 * events and are deliberately not special-cased (the amendment: "pinch and
 * ctrl-wheel obey the same law").
 *
 * A direction change resets the accumulator too. Without that, 90 px in and
 * then 90 px out would leave 0 and emit nothing, which reads as a dead
 * control rather than as a cancelled gesture.
 */
export function createWheelNotcher(): WheelNotcher {
  let carried = 0;
  let lastAtMs = Number.NEGATIVE_INFINITY;
  return {
    feed(deltaY: number, deltaMode: number, atMs: number): number {
      if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
      const scale = DELTA_MODE_PX[deltaMode] ?? 1;
      const travel = deltaY * scale;
      const idle = atMs - lastAtMs > WHEEL_GESTURE_IDLE_MS;
      const reversed = carried !== 0 && Math.sign(travel) !== Math.sign(carried);
      carried = idle || reversed ? travel : carried + travel;
      lastAtMs = atMs;
      const whole = Math.trunc(carried / WHEEL_NOTCH_DELTA);
      if (whole === 0) return 0;
      carried -= whole * WHEEL_NOTCH_DELTA;
      // Wheel DOWN is positive `deltaY` and means zoom OUT, so the sign is
      // inverted here — once, in the one place that reads a wheel event.
      return -whole;
    },
  };
}

/** Clear space {@link fitTo} leaves around the deck's content, in pixels. */
export const DECK_FIT_PADDING = 24;

/** Clear space {@link fitTo} leaves around a tree, in pixels. */
export const TREE_FIT_PADDING = 32;

/** Clamp a scale into its range, and never return a non-finite one. */
export function clampScale(k: number, limits: ZoomLimits): number {
  if (!Number.isFinite(k)) return limits.min;
  return Math.min(limits.max, Math.max(limits.min, k));
}

/**
 * Drag on empty field.
 *
 * `dx`/`dy` are CLIENT pixel deltas and are added to the translation
 * untouched: at scale `k` the content must follow the cursor exactly, and
 * dividing by `k` here would make it lag at every zoom but 1.
 */
export function panBy(view: Viewport, dx: number, dy: number): Viewport {
  return { x: view.x + dx, y: view.y + dy, k: view.k };
}

/** Client point to stage point. The inverse of the rendered transform. */
export function toStage(
  view: Viewport,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  return { x: (clientX - view.x) / view.k, y: (clientY - view.y) / view.k };
}

/** Stage point to client point. */
export function toClient(
  view: Viewport,
  stageX: number,
  stageY: number,
): { x: number; y: number } {
  return { x: stageX * view.k + view.x, y: stageY * view.k + view.y };
}

/**
 * Wheel zoom ABOUT THE CURSOR.
 *
 * The stage point under the cursor is the fixed point: it is where it was
 * before the notch and where it is after, which is what makes zooming feel
 * like moving a lens rather than like the content jumping. `notches` is signed
 * — positive zooms in — and fractional values are allowed so a trackpad's
 * continuous delta needs no special case.
 *
 * When the scale is already at a limit the translation is left ALONE rather
 * than recomputed, so holding the wheel at full zoom does not drift the view.
 */
export function zoomAbout(
  view: Viewport,
  clientX: number,
  clientY: number,
  notches: number,
  limits: ZoomLimits,
): Viewport {
  const next = clampScale(view.k * ZOOM_FACTOR ** notches, limits);
  if (next === view.k) return view;
  const anchor = toStage(view, clientX, clientY);
  return {
    x: clientX - anchor.x * next,
    y: clientY - anchor.y * next,
    k: next,
  };
}

/**
 * Double-click on empty field: fit the content, with padding.
 *
 * Content is centred rather than pinned to a corner, because a fit that put
 * everything top-left would read as a pan the user did not ask for. An empty
 * or degenerate content rectangle fits at scale 1 centred on itself — a zero
 * width would otherwise divide to `Infinity` and clamp to the maximum, which
 * is the most disorientating possible answer to "there is nothing here".
 */
export function fitTo(
  content: Rect,
  size: ViewportSize,
  padding: number,
  limits: ZoomLimits,
): Viewport {
  const availableW = size.width - padding * 2;
  const availableH = size.height - padding * 2;
  const usable =
    content.w > 0 && content.h > 0 && availableW > 0 && availableH > 0;
  const k = usable
    ? clampScale(Math.min(availableW / content.w, availableH / content.h), limits)
    : clampScale(1, limits);
  const cx = content.x + content.w / 2;
  const cy = content.y + content.h / 2;
  return { x: size.width / 2 - cx * k, y: size.height / 2 - cy * k, k };
}

/** Anything with a position and, optionally, a drawn size. */
export interface Extent {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

/**
 * The bounding rectangle of placed content, in stage units.
 *
 * The shared half of {@link fitTo}'s input, here rather than in each renderer
 * for the same reason the rest of this module is shared. An empty list gives a
 * zero rectangle at the origin, which {@link fitTo} handles explicitly.
 */
export function boundsOf(items: readonly Extent[]): Rect {
  if (items.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const w = item.w ?? 0;
    const h = item.h ?? 0;
    if (item.x < minX) minX = item.x;
    if (item.y < minY) minY = item.y;
    if (item.x + w > maxX) maxX = item.x + w;
    if (item.y + h > maxY) maxY = item.y + h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Viewport width in STAGE UNITS — pixels divided by the scale.
 *
 * `layout.ts:deckLayout` takes stage units, and this is the only supported
 * conversion. Handing it raw pixels while zoomed would re-column the grid on
 * every wheel notch, which is a reflow of every card: the exact thing the
 * transform-not-coordinate rule exists to prevent, arriving through the one
 * argument that is allowed to be a measurement.
 */
export function viewportWidthInStageUnits(
  pixelWidth: number,
  k: number,
): number {
  return k > 0 ? pixelWidth / k : pixelWidth;
}

/** The `transform` attribute for the wrapper group. */
export function transformAttr(view: Viewport): string {
  return `translate(${view.x} ${view.y}) scale(${view.k})`;
}

/** Two viewports are the same view. */
export function sameViewport(a: Viewport, b: Viewport): boolean {
  return a.x === b.x && a.y === b.y && a.k === b.k;
}
