// The inspector header's field geometry — v0.8.0 Phase 7, DoD 7.9.
//
// NODE ENVIRONMENT, and that is a statement about what this file can prove.
// `inspector-header.ts` is a pure function of numbers fed by a parse of
// `Inspector.svelte`'s own stylesheet; nothing here mounts anything, and
// nothing here measures a rendered pixel. jsdom computes no layout — no flex,
// no font, no box — so there is no DOM in this repository that could answer
// "does the session id paint over spawn depth". A test that claimed to measure
// it would pass forever while measuring nothing.
//
// WHAT IS PROVED HERE: that the arithmetic of the flex rules the component
// declares puts no field's text inside another field's box, and that the
// numbers it produces are the ones committed under `webview/goldens/drawer`.
// Because the model's input IS the stylesheet, reverting the fix moves the
// computed table and the 1200px golden goes red.
//
// WHAT IS NOT PROVED HERE: that a browser agrees. The model cannot see a font
// metric, cannot see a rule it does not parse, and takes the width of the rest
// of the header as one estimated constant. The confirmation on a screen is the
// user's smoke, DoD 7.12.
//
// `inspector.test.ts` drives the component: it mounts the real bundle and
// asserts the seven fields, their labels, their values and their mono flags
// are the ones these goldens are written over.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  HEADER_MIN_WIDTH_RULES,
  HEADER_RESERVED_PX,
  MONO_ADVANCE_RATIO,
  contentWidthPx,
  layoutHeader,
  parseHeaderCss,
} from './inspector-header.js';
import type { HeaderCss, HeaderFieldText, HeaderLayout } from './inspector-header.js';

interface HeaderGolden {
  what: string;
  panelPx: number;
  reservedPx: number;
  fields: HeaderFieldText[];
  layout: HeaderLayout;
}

const SOURCE = readFileSync(resolve('webview/Inspector.svelte'), 'utf8');

const golden = (name: string): HeaderGolden =>
  JSON.parse(readFileSync(resolve(`webview/goldens/drawer/${name}`), 'utf8')) as HeaderGolden;

const WIDE = golden('header-2400.json');
/**
 * The MID width. It was called NARROW until v0.9.0, when a genuinely narrow
 * table joined it; the name is kept so every existing reference below still
 * reads, and `MID` is its alias for the new ones.
 */
const NARROW = golden('header-1200.json');
const MID = NARROW;
/**
 * The NARROW width — v0.9.0 DoD 9.9.
 *
 * 700px against a reserved 520 leaves 180, which is less than the widest
 * single field, so every field takes a row of its own AND `sessionId` is
 * still clipped. That is the honest extreme, and it is the table that
 * proves the stylesheet's own claim: wrapping removes the need to cut at the
 * narrow end, it does not make a cut impossible.
 */
const TIGHT = golden('header-700.json');

/** The seven fields `Inspector.svelte` renders for an agent node. */
const FIELD_NAMES = [
  'status',
  'id',
  'sessionId',
  'spawnDepth',
  'context',
  'burn',
  'duration',
] as const;

/**
 * The parse, taken once and called from inside a test rather than from a
 * describe body.
 *
 * A throw while a describe body runs is a FAILED SUITE and a `no tests`
 * line: the run is red and the tests line a reader scans is not. This
 * repository has met that reporting shape through a broken import, a hook
 * timeout and a slow fixture. Called from inside an `it`, the same throw is
 * one red test carrying the parser’s own message — which is what the
 * mutation that points the parser at a stylesheet it cannot read depends on.
 */
let parsed: HeaderCss | undefined;
const headerCss = (): HeaderCss => {
  parsed ??= parseHeaderCss(SOURCE);
  return parsed;
};

describe('parseHeaderCss — the stylesheet is the input', () => {
  it('reads exactly seven field min-width rules, and they are the seven fields', () => {
    // THE VACUITY CONTROL FOR EVERY ASSERTION BELOW. A regex that matched
    // nothing would return an empty table, every field would fall back to a
    // zero minimum, and "no field overlaps another" would pass trivially over
    // a header nobody parsed. The count is pinned as a literal beside the set,
    // which is rule 19's shape applied to a stylesheet: a set comparison
    // written against an accidentally empty listing passes, and a count is the
    // cheapest thing that goes red when it does.
    expect(Object.keys(headerCss().minWidthPx)).toHaveLength(HEADER_MIN_WIDTH_RULES);
    expect(HEADER_MIN_WIDTH_RULES).toBe(7);
    expect(Object.keys(headerCss().minWidthPx).sort()).toEqual([...FIELD_NAMES].sort());
  });

  it('reads each min-width as the number §8.6 and A6 fixed', () => {
    expect(headerCss().minWidthPx).toEqual({
      status: 58,
      id: 128,
      sessionId: 128,
      spawnDepth: 74,
      context: 104,
      burn: 158,
      duration: 64,
    });
  });

  it('reads the group gap and the two font sizes the widths are measured in', () => {
    expect(headerCss().gapPx).toBe(14);
    expect(headerCss().valueFontPx).toBe(11);
    expect(headerCss().labelFontPx).toBe(9);
    expect(headerCss().labelLetterSpacingEm).toBe(0.08);
  });

  it('reads a field shrink factor of 0 — the DoD 7.9 fix, in the stylesheet', () => {
    // THE MUTATION THE DoD NAMES. Deleting `flex-shrink: 0` from `.field`
    // returns this to the CSS initial value of 1, which is what shipped, and
    // the 1200px golden below goes red. An explicit `min-width` replaces a
    // flex item's automatic content-based minimum, so at 1 a field shrinks
    // below its own text and — `.field` declaring no `overflow` — paints
    // outside its box.
    expect(headerCss().shrink).toBe(0);
  });

  it('falls back to the CSS initial shrink of 1 when the rule declares none', () => {
    // The shipped state, parsed. The fallback is not an error: the model has
    // to be able to place the header as it was, or the mutation above could
    // not be run at all.
    const stripped = SOURCE.split('\n')
      .filter((line) => !line.includes('flex-shrink: 0;'))
      .join('\n');
    expect(parseHeaderCss(stripped).shrink).toBe(1);
  });
});

describe('parseHeaderCss — a parse that finds nothing refuses', () => {
  it('refuses a file with no style block', () => {
    expect(() => parseHeaderCss('<script></script>')).toThrow(/no style block/);
  });

  it('refuses a stylesheet with no rules at all', () => {
    expect(() => parseHeaderCss('<style></style>')).toThrow(/no \.fields rule/);
  });

  it('refuses a stylesheet whose field min-width rules have been removed', () => {
    const stripped = SOURCE.split('\n')
      .filter((line) => !line.includes("[data-field='"))
      .join('\n');
    expect(() => parseHeaderCss(stripped)).toThrow(/no field min-width rules/);
  });

  it('refuses a stylesheet whose gap declaration has been removed', () => {
    const stripped = SOURCE.split('\n')
      .filter((line) => !line.includes('gap: 14px;'))
      .join('\n');
    expect(() => parseHeaderCss(stripped)).toThrow(/\.fields declares no gap/);
  });
});

describe('contentWidthPx — the character-advance model, stated as an estimate', () => {
  it('measures a 36-character session id at 36 mono advances of the value size', () => {
    const sessionId = WIDE.fields.find((f) => f.field === 'sessionId');
    expect(sessionId?.value).toHaveLength(36);
    expect(contentWidthPx(sessionId as HeaderFieldText, headerCss())).toBeCloseTo(
      36 * 11 * MONO_ADVANCE_RATIO,
      6,
    );
    // 237.6 against the 128px min-width the same stylesheet declares. That
    // ratio is the whole defect: at shrink 1 the box is 128 and the ink is
    // 237.6, and 109.6px of session id lands on its neighbours.
    expect(contentWidthPx(sessionId as HeaderFieldText, headerCss())).toBeCloseTo(237.6, 6);
    expect(headerCss().minWidthPx['sessionId']).toBe(128);
  });

  it('takes the label when the label is the wider of the two', () => {
    const spawnDepth = WIDE.fields.find((f) => f.field === 'spawnDepth');
    // "spawn depth" is eleven micro-caps characters; the value is one digit.
    expect(contentWidthPx(spawnDepth as HeaderFieldText, headerCss())).toBeCloseTo(11 * 6.12, 6);
  });
});

describe('the wrap declarations — v0.9.0 DoD 9.9', () => {
  /** The shipped stylesheet with one declaration rewritten. */
  const withStyle = (replace: (css: string) => string): string =>
    SOURCE.replace(/<style>[\s\S]*<\/style>/, (block) => replace(block));

  it('reads flex-wrap and row-gap off .fields', () => {
    const css = parseHeaderCss(SOURCE);
    expect(css.wrap).toBe(true);
    expect(css.rowGapPx).toBe(6);
    // Declared SEPARATELY from the gap shorthand, so the two really differ
    // and a parser that read one for the other would be visible here.
    expect(css.gapPx).toBe(14);
    expect(css.rowGapPx).not.toBe(css.gapPx);
  });

  it('row-gap falls back to the gap shorthand when the rule declares none', () => {
    /*
     * THE BRANCH A MUTATION SURVIVED ON.
     *
     * The shipped stylesheet declares `row-gap`, so this fallback is never
     * taken by the real parse: replacing it with `0` left the whole suite
     * green. It is not decoration — `gap: 14px` alone sets BOTH axes, which
     * is what the shorthand means, and a parser that read the row gap as 0
     * there would stack wrapped rows on top of each other.
     */
    const noRowGap = withStyle((block) => block.replace(/\n\s*row-gap:\s*6px;/, ''));
    // The DECLARATION, not the word: the rule's own comment names `row-gap`
    // in prose, so asserting the bare string would fail on the comment.
    expect(noRowGap).not.toContain('row-gap:');
    const css = parseHeaderCss(noRowGap);
    expect(css.rowGapPx).toBe(css.gapPx);
    expect(css.rowGapPx).toBe(14);
    // The control: the shipped sheet does NOT take this branch, which is why
    // the mutation could survive in the first place.
    expect(parseHeaderCss(SOURCE).rowGapPx).toBe(6);
  });

  it('a stylesheet with no flex-wrap parses as nowrap, and places one row', () => {
    // The pre-0.9.0 state, read off a real stylesheet rather than a literal.
    const noWrap = withStyle((block) => block.replace(/\n\s*flex-wrap:\s*wrap;/, ''));
    const css = parseHeaderCss(noWrap);
    expect(css.wrap).toBe(false);
    const layout = layoutHeader({
      panelPx: TIGHT.panelPx,
      reservedPx: TIGHT.reservedPx,
      fields: TIGHT.fields,
      css,
    });
    expect(layout.rows).toBe(1);
    // And that is the state the DoD exists to leave behind: one row at 700px
    // means fields nobody can read.
    expect(layout.outside.length).toBeGreaterThan(0);
  });
});

describe('the goldens — 2400px, 1200px and 700px', () => {
  it.each([
    ['2400px', WIDE],
    ['1200px', MID],
    ['700px', TIGHT],
  ])('%s reproduces its committed placement', (_name, g) => {
    expect(g.reservedPx).toBe(HEADER_RESERVED_PX);
    expect(layoutHeader({ panelPx: g.panelPx, reservedPx: g.reservedPx, fields: g.fields, css: headerCss() })).toEqual(
      g.layout,
    );
  });

  it.each([
    ['2400px', WIDE],
    ['1200px', MID],
    ['700px', TIGHT],
  ])('%s places no field’s text inside another field’s box', (_name, g) => {
    // RECOMPUTED, not read back out of the golden. The first draft asserted
    // over `g.layout.overlaps` — the committed answer — which is a mirror of
    // this code's own output and cannot go red for a stylesheet change at all.
    // Measured: under mutation 1 (the fix removed) the placement table above
    // went red and this test stayed green.
    const layout = layoutHeader({
      panelPx: g.panelPx,
      reservedPx: g.reservedPx,
      fields: g.fields,
      css: headerCss(),
    });
    expect(layout.overlaps).toEqual([]);
    expect(layout.fields.filter((f) => f.overflows)).toEqual([]);
    // And the committed table carries the same answer, so a reader of the file
    // does not have to run it to see which one is pinned.
    expect(g.layout.overlaps).toEqual([]);
  });

  it('the three goldens differ in HOW MANY ROWS, and every field is drawn at 1200', () => {
    // Three widths that agreed about everything would be one golden written
    // three times. What moves between them is the row count.
    expect(WIDE.layout.rows).toBe(1);
    expect(MID.layout.rows).toBe(2);
    expect(TIGHT.layout.rows).toBe(7);

    expect(WIDE.layout.availablePx).toBe(1880);
    expect(MID.layout.availablePx).toBe(680);
    expect(TIGHT.layout.availablePx).toBe(180);

    /*
     * v0.9.0 DoD 9.9 REMOVES DoD 7.9's STATED COST, and this is the
     * assertion that records it.
     *
     * Until 0.9.0 this test read: "At 1200 the row is wider than the space it
     * is given: `burn` is cut at the right-hand edge and `duration` is not
     * drawn at all. That is the stated cost of the fix — a whole field leaves
     * the row instead of two values sharing one patch of screen."
     *
     * The row breaks now, so nothing is cut and nothing leaves. Both halves
     * are asserted, because "no overlap" was already true at 1200 and it is
     * the DRAWN-ness that changed.
     */
    expect(WIDE.layout.clipped).toEqual([]);
    expect(WIDE.layout.outside).toEqual([]);
    expect(MID.layout.clipped).toEqual([]);
    expect(MID.layout.outside).toEqual([]);

    /*
     * AND THE LIMIT, which the stylesheet's own comment claims: wrapping
     * removes the need to cut at the narrow end, it does not make a cut
     * impossible. At 700px the group is offered 180, which is narrower than
     * `sessionId` alone, so that one field is still cut — on a row of its
     * own, with nothing beside it to paint over.
     */
    expect(TIGHT.layout.clipped).toEqual(['sessionId']);
    expect(TIGHT.layout.outside).toEqual([]);
    expect(new Set(TIGHT.layout.fields.map((f) => f.row)).size).toBe(7);
  });
});

describe('the defect the fix removes, driven through the same model', () => {
  /**
 * The state the user's v0.7.1 smoke recorded, reproduced from the current
   * stylesheet.
   *
   * TWO declarations are taken back out, not one. `shrink: 1` is DoD 7.9’s
   * fix; `wrap: false` is DoD 9.9’s. With the wrap left on, the seven fields
   * break across rows and the session id has nothing to paint over — so the
   * control below would report no overlap and would be proving nothing,
   * which is exactly the shape it exists to rule out.
   */
  const shipped = (): HeaderCss => ({
    ...parseHeaderCss(SOURCE),
    shrink: 1,
    wrap: false,
  });

  it('at 1200px the shipped shrink factor paints the session id over two fields', () => {
    // THE CONTROL THAT MAKES "no overlaps" MEAN SOMETHING. Every no-overlap
    // assertion above is satisfied by a model that can never report one. This
    // is the same model, the same stylesheet and the same strings, with the
    // single declaration the fix adds taken back out.
    const layout = layoutHeader({
      panelPx: NARROW.panelPx,
      reservedPx: NARROW.reservedPx,
      fields: NARROW.fields,
      css: shipped(),
    });

    expect(layout.overlaps).toEqual([
      { over: 'sessionId', under: 'spawnDepth', byPx: 95.6 },
      { over: 'sessionId', under: 'context', byPx: 7.6 },
    ]);
    // Exactly one field overflows its own box, and it is the one the user
    // named. Every other value is shorter than the min-width beneath it.
    expect(layout.fields.filter((f) => f.overflows).map((f) => f.field)).toEqual(['sessionId']);
    expect(layout.fields.find((f) => f.field === 'sessionId')?.width).toBe(128);
  });

  it('every field falls back to its min-width, which is what the capture shows', () => {
    const layout = layoutHeader({
      panelPx: NARROW.panelPx,
      reservedPx: NARROW.reservedPx,
      fields: NARROW.fields,
      css: shipped(),
    });
    // `media/inspector.png`: the seven fields sit at their declared minima and
    // `duration` is off the end of the row. The deltas between the labels in
    // that capture are those minima plus the 14px gap, at the capture's scale.
    expect(layout.fields.map((f) => f.width)).toEqual([58, 128, 128, 74, 104, 158, 64]);
    expect(layout.outside).toEqual(['duration']);
  });

  it('at 2400px the shipped factor changes nothing, so that golden is not the mutation’s witness', () => {
    // Stated rather than left to be discovered: a panel wide enough that the
    // group is never compressed has no shrinking to do, so removing
    // `flex-shrink: 0` leaves the 2400px table identical. The 1200px golden is
    // the one that goes red. What the 2400px golden pins is the other half —
    // the gap, the seven min-widths, the font sizes and the field set, every
    // one of which moves its x positions.
    const withShipped = layoutHeader({
      panelPx: WIDE.panelPx,
      reservedPx: WIDE.reservedPx,
      fields: WIDE.fields,
      css: shipped(),
    });
    expect(withShipped).toEqual(WIDE.layout);
  });

  it('a wider gap moves every box, at both widths', () => {
    // The 2400px golden is not inert. One declaration, seven x positions.
    const wider = { ...parseHeaderCss(SOURCE), gapPx: 16 };
    const layout = layoutHeader({
      panelPx: WIDE.panelPx,
      reservedPx: WIDE.reservedPx,
      fields: WIDE.fields,
      css: wider,
    });
    expect(layout).not.toEqual(WIDE.layout);
    expect(layout.fields.map((f) => f.x)).not.toEqual(WIDE.layout.fields.map((f) => f.x));
  });
});

describe('the flex resolution itself', () => {
  it('distributes no free space: a wide panel leaves every box at its base', () => {
    const layout = layoutHeader({
      panelPx: 4000,
      reservedPx: HEADER_RESERVED_PX,
      fields: WIDE.fields,
      css: headerCss(),
    });
    // `flex-grow` is 0, so 3,480px of room adds nothing to any field.
    expect(layout.fields.map((f) => f.width)).toEqual(WIDE.layout.fields.map((f) => f.width));
    expect(layout.usedPx).toBe(907.6);
  });

  it('freezes an item at its min-width and re-distributes to the rest', () => {
    // Hand-computed, two fields, shrink 1. Bases 100 and 300, minima 90 and
    // 100, gap 10, offered 390. First pass: 400 of content against 380 of
    // room, so 20 of deficit split in proportion to base — 5 and 15 — which
    // takes the first to 95 and the second to 285. Neither violates its
    // minimum, so one pass settles it.
    const twoFields: HeaderFieldText[] = [
      { field: 'a', label: '', value: 'x'.repeat(100), mono: true },
      { field: 'b', label: '', value: 'x'.repeat(300), mono: true },
    ];
    const oneToOne: HeaderCss = {
      gapPx: 10,
      shrink: 1,
      minWidthPx: { a: 90, b: 100 },
      valueFontPx: 1 / MONO_ADVANCE_RATIO,
      labelFontPx: 1 / MONO_ADVANCE_RATIO,
      labelLetterSpacingEm: 0,
      // v0.9.0 DoD 9.9. NOWRAP here on purpose: this test is about the
      // shrink pass, and wrapping would give the two fields a row each and
      // remove the deficit the arithmetic above exists to check.
      wrap: false,
      rowGapPx: 10,
    };
    const layout = layoutHeader({
      panelPx: 390,
      reservedPx: 0,
      fields: twoFields,
      css: oneToOne,
    });
    expect(layout.fields.map((f) => f.width)).toEqual([95, 285]);

    // Offered 150 instead, the first field hits 90 and freezes, and the
    // remainder falls entirely on the second: 150 - 10 - 90 = 50.
    const tighter = layoutHeader({
      panelPx: 150,
      reservedPx: 0,
      fields: twoFields,
      css: oneToOne,
    });
    expect(tighter.fields.map((f) => f.width)).toEqual([90, 100]);
    expect(tighter.fields.map((f) => f.overflows)).toEqual([true, true]);
  });

  it('a panel narrower than the reserved header offers the group nothing', () => {
    const layout = layoutHeader({
      panelPx: 100,
      reservedPx: HEADER_RESERVED_PX,
      fields: WIDE.fields,
      css: headerCss(),
    });
    expect(layout.availablePx).toBe(0);
    expect(layout.visiblePx).toBe(0);
    expect(layout.outside).toEqual([...FIELD_NAMES]);
    expect(layout.overlaps).toEqual([]);
  });
});
