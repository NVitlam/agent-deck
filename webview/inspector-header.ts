/**
 * The inspector header's field geometry — v0.8.0 Phase 7, DoD 7.9.
 *
 * WHAT THIS FILE IS. A model of the flex rules `Inspector.svelte`'s `.head`
 * declares, as a pure function of numbers, so that "the SESSION column runs
 * into SPAWN DEPTH" is a fact a committed table can carry. The CSS itself is
 * the input: {@link parseHeaderCss} reads the component's own stylesheet and
 * {@link layoutHeader} places the fields from what it read. Change a
 * declaration and the computed placements move, which is what makes the
 * goldens under `webview/goldens/drawer` pin the CSS rather than restate it.
 *
 * WHAT IT IS NOT, STATED FIRST BECAUSE IT BOUNDS EVERY NUMBER BELOW. It is not
 * a browser and it is not a measurement. jsdom lays nothing out — there is no
 * flex, no font, no `getBoundingClientRect` that returns anything but zero —
 * so a test claiming to measure this overlap in this suite would pass forever
 * while measuring nothing. Three limits, each load-bearing:
 *
 *   1. IT CANNOT SEE A FONT METRIC. Text width here is character count times a
 *      per-character advance derived from the declared `font-size` and a fixed
 *      ratio ({@link MONO_ADVANCE_RATIO}, {@link PROPORTIONAL_ADVANCE_RATIO}).
 *      A real face is kerned and hinted and its advance is not exactly 0.6em.
 *   2. IT CANNOT SEE A RULE IT DOES NOT PARSE. {@link parseHeaderCss} reads
 *      seven kinds of declaration. A `padding` added to `.field`, a
 *      `text-overflow`, a media query — all invisible, all capable of moving a
 *      real header.
 *   3. IT DOES NOT KNOW THE WIDTH OF THE REST OF THE HEADER. The engine glyph,
 *      the kind, the wrapped label, the path and the two buttons are one input
 *      number, {@link HEADER_RESERVED_PX}, estimated from `media/inspector.png`.
 *
 * The confirmation that the header is right on a screen is the user's smoke
 * (DoD 7.12). What this file buys is that the arithmetic of the flex rules is
 * written down outside the stylesheet, so reverting the fix moves a number
 * somebody committed.
 *
 * WHY THE COMPONENT DOES NOT IMPORT IT. The component decides nothing here —
 * the browser resolves the flex sizes. `drawer.ts:followTarget` is the
 * precedent for the shape and not for the wiring: there, the component had a
 * decision to hand off; here there is none to take away.
 *
 * THE DEFECT THIS MODEL REPRODUCES (user, `smoke.md`, v0.7.1): at the panel
 * width in `media/inspector.png` the session id paints over SPAWN DEPTH.
 * `.field` carried an explicit `min-width` and the flex default
 * `flex-shrink: 1`. An explicit `min-width` REPLACES a flex item's automatic
 * content-based minimum, so the field shrank below its own text; `.field`
 * declares no `overflow`, so the text painted outside its box and onto the
 * next field. Fed the real stylesheet and the real rendered strings, this
 * model names exactly one overflowing field — `sessionId` — which is the one
 * pair the capture shows.
 */

/**
 * Per-character advance of the mono face, as a fraction of `font-size`.
 *
 * A monospaced face has one advance for every character and the common ones
 * sit at 0.6em (Cascadia Mono and DejaVu Sans Mono are 0.600 and 0.602;
 * Consolas is 0.55). 0.6 is used. `--mono` resolves to whatever the host VS
 * Code theme supplies, so this is a stated estimate and not a measurement.
 */
export const MONO_ADVANCE_RATIO = 0.6;

/**
 * Per-character advance of the proportional face, as a fraction of
 * `font-size`. A mean over mixed-case Latin text, which is a cruder estimate
 * than the mono one.
 *
 * It is load-bearing for exactly one field — `status`, the only `.f-value`
 * without `.mono` — whose three possible words are `running`, `completed` and
 * `failed`. The longest of those is 9 characters and the field's `min-width`
 * is 58px, so at this ratio and at any ratio up to 0.58 the value fits inside
 * the declared minimum and the estimate changes no placement.
 */
export const PROPORTIONAL_ADVANCE_RATIO = 0.52;

/**
 * The width of everything in `.head` that is not the field group: the engine
 * glyph, the kind, the wrapped label, the flex spacer at its zero base, the
 * path, the expand button, the close button, and the row's own gaps and
 * padding.
 *
 * ESTIMATED, from `media/inspector.png` — the capture the user's `smoke.md`
 * names. In that capture the seven fields sit at their `min-width`s and
 * `duration` is absent from the row entirely, which places the group's visible
 * width between `burn`'s right edge (720px) and `duration`'s left edge (734px)
 * in the group's own coordinates. Against a panel of about 1,248 CSS px that
 * leaves about 515px for the rest of the header. 520 is used.
 *
 * A single number standing for six items is the crudest part of this model.
 * What it decides is which trailing fields fall off the right-hand end; it
 * does not decide whether any field paints over another, because that is a
 * property of the field boxes alone.
 */
export const HEADER_RESERVED_PX = 520;

/** The declarations {@link parseHeaderCss} reads out of `Inspector.svelte`. */
export interface HeaderCss {
  /** `.fields { gap }`, in px. Between every adjacent pair of fields. */
  gapPx: number;
  /**
   * `.field`'s flex shrink factor. `1` when the rule declares none, which is
   * the CSS initial value and is the state the DoD 7.9 defect ships in.
   */
  shrink: number;
  /** `.field[data-field='…'] { min-width }`, in px, keyed by the field name. */
  minWidthPx: Record<string, number>;
  /** `.f-value { font-size }`, in px. */
  valueFontPx: number;
  /** `.f-label { font-size }`, in px. */
  labelFontPx: number;
  /** `.f-label { letter-spacing }`, in em. */
  labelLetterSpacingEm: number;
}

/** One field of the header group, as the component renders it. */
export interface HeaderFieldText {
  /** The `data-field` attribute. */
  field: string;
  /** The micro-caps label above the value. */
  label: string;
  /** The value, as the formatters produced it. */
  value: string;
  /** The value carries `.mono`. */
  mono: boolean;
}

/** Everything the placement needs. */
export interface HeaderInput {
  /** The panel's width, in CSS px. */
  panelPx: number;
  /** {@link HEADER_RESERVED_PX}, passed rather than assumed. */
  reservedPx: number;
  /** The fields, in the order the component renders them. */
  fields: readonly HeaderFieldText[];
  /** The parsed stylesheet. */
  css: HeaderCss;
}

/** One placed field. All coordinates are relative to `.fields`' left edge. */
export interface PlacedField {
  field: string;
  /** The left edge of the field's box. */
  x: number;
  /** The used width of the box, after flex resolution. */
  width: number;
  /** The width the field's own text needs. */
  contentPx: number;
  /**
   * `contentPx > width`: the value paints outside its own box. `.field`
   * declares no `overflow`, so this is visible ink, not a clipped remainder.
   */
  overflows: boolean;
  /** The box's right edge is past the group's visible width. */
  clipped: boolean;
  /** The box begins at or past the group's visible width. */
  outside: boolean;
}

/** A field whose painted text reaches into a later field's box. */
export interface HeaderOverlap {
  /** The field doing the painting. */
  over: string;
  /** The field painted into. */
  under: string;
  /** How far the painted text reaches past the other field's left edge. */
  byPx: number;
}

/** The placement. */
export interface HeaderLayout {
  /** The width `.fields` is offered: panel minus reserved, floored at 0. */
  availablePx: number;
  /** The width the fields need at their content sizes, gaps included. */
  naturalPx: number;
  /** The width they occupy after flex resolution, gaps included. */
  usedPx: number;
  /** What a reader sees: `.fields` declares `overflow: hidden`. */
  visiblePx: number;
  fields: PlacedField[];
  /** Every pair, in render order. Empty is the fixed state. */
  overlaps: HeaderOverlap[];
  /** Fields whose right edge is past {@link HeaderLayout.visiblePx}. */
  clipped: string[];
  /** Fields that begin past it, so no part of them is drawn. */
  outside: string[];
}

/** Two decimal places, so a golden carries no float tail. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The slack every edge comparison carries.
 *
 * The group's visible width and a field's right edge are the same sum taken in
 * two different orders — one folds the gaps in at the end, the other walks
 * them — and floating-point addition is not associative, so the last field of
 * a row that exactly fills its group can land one unit in the last place over
 * its own container. Without this, `clipped` would report a field nothing cuts.
 */
const EDGE_EPSILON_PX = 1e-6;

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One rule's body. Throws when the selector is absent — a parser that returns
 * an empty table on a file it could not read makes every assertion over that
 * table pass trivially, which is this repository's most-recorded defect.
 */
function ruleBody(css: string, selector: string): string {
  const pattern = new RegExp(`(?:^|\\n)\\s*${escapeForRegExp(selector)}\\s*\\{([^}]*)\\}`);
  const found = pattern.exec(css);
  if (found === null) throw new Error(`Inspector.svelte: no ${selector} rule`);
  return found[1] ?? '';
}

function pxValue(body: string, property: string, selector: string): number {
  const pattern = new RegExp(`(?:^|[\\s;])${escapeForRegExp(property)}:\\s*(-?[0-9.]+)px`);
  const found = pattern.exec(body);
  if (found === null) throw new Error(`Inspector.svelte: ${selector} declares no ${property}`);
  return Number(found[1]);
}

/** How many `.field[data-field='…'] { min-width }` rules the header declares. */
export const HEADER_MIN_WIDTH_RULES = 7;

/**
 * Read the header's geometry out of `Inspector.svelte`'s own `<style>` block.
 *
 * @param source the whole component file.
 * @throws when any rule this model reads is absent.
 */
export function parseHeaderCss(source: string): HeaderCss {
  const style = /<style>([\s\S]*)<\/style>/.exec(source);
  if (style === null) throw new Error('Inspector.svelte has no style block');
  const css = style[1] ?? '';

  const fieldsBody = ruleBody(css, '.fields');
  const fieldBody = ruleBody(css, '.field');
  const valueBody = ruleBody(css, '.f-value');
  const labelBody = ruleBody(css, '.f-label');

  const minWidthPx: Record<string, number> = {};
  const minWidthRule = /\.field\[data-field='([A-Za-z]+)'\]\s*\{\s*min-width:\s*([0-9.]+)px;?\s*\}/g;
  for (const rule of css.matchAll(minWidthRule)) {
    const name = rule[1];
    const width = rule[2];
    if (name === undefined || width === undefined) continue;
    minWidthPx[name] = Number(width);
  }
  if (Object.keys(minWidthPx).length === 0) {
    throw new Error('Inspector.svelte declares no field min-width rules');
  }

  const letterSpacing = /(?:^|[\s;])letter-spacing:\s*(-?[0-9.]+)em/.exec(labelBody);
  if (letterSpacing === null) {
    throw new Error('Inspector.svelte: .f-label declares no letter-spacing');
  }

  return {
    gapPx: pxValue(fieldsBody, 'gap', '.fields'),
    shrink: shrinkFactor(fieldBody),
    minWidthPx,
    valueFontPx: pxValue(valueBody, 'font-size', '.f-value'),
    labelFontPx: pxValue(labelBody, 'font-size', '.f-label'),
    labelLetterSpacingEm: Number(letterSpacing[1]),
  };
}

/**
 * `.field`'s shrink factor: `flex-shrink`, else the second component of the
 * `flex` shorthand, else the CSS initial value `1`.
 *
 * The fallback is the defect's own state and is deliberately not an error: a
 * `.field` rule with no shrink declaration is exactly what shipped, and the
 * model has to be able to place it.
 */
function shrinkFactor(fieldBody: string): number {
  const explicit = /(?:^|[\s;])flex-shrink:\s*([0-9.]+)/.exec(fieldBody);
  if (explicit !== null) return Number(explicit[1]);
  const shorthand = /(?:^|[\s;])flex:\s*([0-9.]+)\s+([0-9.]+)/.exec(fieldBody);
  if (shorthand !== null) return Number(shorthand[2]);
  return 1;
}

/**
 * The width one field's own text needs: the wider of its label and its value.
 *
 * `letter-spacing` is counted after every character including the last, which
 * is what CSS does.
 */
export function contentWidthPx(text: HeaderFieldText, css: HeaderCss): number {
  const labelAdvance = css.labelFontPx * (MONO_ADVANCE_RATIO + css.labelLetterSpacingEm);
  const valueAdvance =
    css.valueFontPx * (text.mono ? MONO_ADVANCE_RATIO : PROPORTIONAL_ADVANCE_RATIO);
  return Math.max(text.label.length * labelAdvance, text.value.length * valueAdvance);
}

/**
 * Resolve the flex main sizes of the field boxes.
 *
 * The CSS flexible box algorithm, restricted to what `.field` declares:
 * `flex-grow: 0` (so free space is never distributed), `flex-basis: auto` (so
 * the base size is the content size, floored by `min-width`), and a shrink
 * factor read from the stylesheet. Items are frozen as they hit their
 * `min-width`, and the pass repeats, which is what the specification calls
 * resolving the flexible lengths with min violations.
 */
function resolveWidths(
  bases: number[],
  mins: number[],
  gapTotal: number,
  available: number,
  shrink: number,
): number[] {
  const widths = bases.slice();
  const total = bases.reduce((sum, b) => sum + b, 0) + gapTotal;
  if (shrink <= 0 || total <= available) return widths;

  const frozen = bases.map(() => false);
  for (let pass = 0; pass <= bases.length; pass += 1) {
    let frozenWidth = 0;
    let unfrozenBase = 0;
    let scaled = 0;
    for (let i = 0; i < bases.length; i += 1) {
      const base = bases[i] ?? 0;
      if (frozen[i] === true) frozenWidth += widths[i] ?? 0;
      else {
        unfrozenBase += base;
        scaled += shrink * base;
      }
    }
    if (scaled <= 0) break;
    const remaining = available - gapTotal - frozenWidth;
    const deficit = unfrozenBase - remaining;
    let violated = false;
    for (let i = 0; i < bases.length; i += 1) {
      if (frozen[i] === true) continue;
      const base = bases[i] ?? 0;
      const wanted = deficit <= 0 ? base : base - (deficit * shrink * base) / scaled;
      const min = mins[i] ?? 0;
      if (wanted < min) {
        widths[i] = min;
        frozen[i] = true;
        violated = true;
      } else widths[i] = wanted;
    }
    if (deficit <= 0 || !violated) break;
  }
  return widths;
}

/**
 * Place the header's fields.
 *
 * Overlap is reported for every ordered pair, not only for neighbours: a value
 * long enough to cross a narrow field reaches the one after it too, and the
 * capture in `media/inspector.png` is one character short of exactly that.
 */
export function layoutHeader(input: HeaderInput): HeaderLayout {
  const { css } = input;
  const gapTotal = css.gapPx * Math.max(0, input.fields.length - 1);
  const contents = input.fields.map((text) => contentWidthPx(text, css));
  const mins = input.fields.map((text) => css.minWidthPx[text.field] ?? 0);
  const bases = contents.map((content, i) => Math.max(content, mins[i] ?? 0));

  const available = Math.max(0, input.panelPx - input.reservedPx);
  const widths = resolveWidths(bases, mins, gapTotal, available, css.shrink);
  const used = widths.reduce((sum, w) => sum + w, 0) + gapTotal;
  const visible = Math.min(used, available);

  const xs: number[] = [];
  let cursor = 0;
  for (let i = 0; i < widths.length; i += 1) {
    xs.push(cursor);
    cursor += (widths[i] ?? 0) + css.gapPx;
  }

  const fields: PlacedField[] = input.fields.map((text, i) => {
    const x = xs[i] ?? 0;
    const width = widths[i] ?? 0;
    const content = contents[i] ?? 0;
    return {
      field: text.field,
      x: round2(x),
      width: round2(width),
      contentPx: round2(content),
      overflows: content > width + EDGE_EPSILON_PX,
      clipped: x < visible - EDGE_EPSILON_PX && x + width > visible + EDGE_EPSILON_PX,
      outside: x >= visible - EDGE_EPSILON_PX,
    };
  });

  const overlaps: HeaderOverlap[] = [];
  for (let i = 0; i < input.fields.length; i += 1) {
    const paintedRight = (xs[i] ?? 0) + (contents[i] ?? 0);
    for (let j = i + 1; j < input.fields.length; j += 1) {
      const left = xs[j] ?? 0;
      if (paintedRight > left + EDGE_EPSILON_PX) {
        overlaps.push({
          over: input.fields[i]?.field ?? '',
          under: input.fields[j]?.field ?? '',
          byPx: round2(paintedRight - left),
        });
      }
    }
  }

  return {
    availablePx: round2(available),
    naturalPx: round2(bases.reduce((sum, b) => sum + b, 0) + gapTotal),
    usedPx: round2(used),
    visiblePx: round2(visible),
    fields,
    overlaps,
    clipped: fields.filter((f) => f.clipped).map((f) => f.field),
    outside: fields.filter((f) => f.outside).map((f) => f.field),
  };
}
