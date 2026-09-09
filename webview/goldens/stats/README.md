# `webview/goldens/stats`

The Stats view's layout goldens — v0.7.0 Phase 4, DoD 4.2.

| file | what it pins | read by |
|---|---|---|
| `n0.json` … `n12.json` | `statsLayout` over the first N harvested `fixtures/golden/stats/*.json` records, N = 0/1/2/6/12 | `webview/stats/layout.test.ts` |
| `r8-<id>.json` | `statsLayout` over ONE R8 golden (`fixtures/golden/stats/<engine>-synthetic-<id>.json`), each of the thirteen | `webview/stats/layout.test.ts` |

**Written only by `node scripts/gen-webview-goldens.mjs`** (`--check` compares and writes nothing).

## What produced them

Every file is the PRODUCTION path from a record to a layout: the committed
`StatsRecord` goes through the host-side wire gate (`src/stats/wire.ts`,
the same validator `PanelController.publishStats` runs), into a real
`webview/store.ts` as a real `statsSnapshot` message, and out through
`webview/stats/layout.ts:statsLayout`. `layout.test.ts` re-runs that path
in-process and compares parsed JSON, so the script and the test are two
readers of one file and neither can quietly rewrite it.

The input records are the committed goldens under `fixtures/golden/stats/`
— `deriveStats`'s own output, byte-compared by `src/stats/goldens.test.ts` —
so "the layout of the record the fixture manufactures" is literally what each
`r8-*` file holds.

## What they are NOT

A second implementation. Nothing computes these but `statsLayout` itself;
what the golden buys is that the layout's numbers are written down outside
the code that produces them, so a change to `layout.ts` has to move a
committed file. The `lane-subsets.json` note in `../layout/README.md` says
the same about that kind of golden.

## The incremental property

`layout.test.ts` asserts, separately from these files, that adding a record
moves no existing Trends point. It holds by construction — a point's `x` is
its index times `TREND_STEP` and its `y` is the record's own raw value — and
the series maximum, which does move, travels as `max` and becomes an SVG
viewBox in the renderer: a transform, never a coordinate.

## Line endings

Compared as parsed JSON, like `../layout/`, so `.gitattributes` need not mark
this directory and a CRLF checkout cannot affect the comparison.
