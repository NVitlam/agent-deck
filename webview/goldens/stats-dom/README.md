# `webview/goldens/stats-dom`

The Stats surface's DOM goldens — v0.8.0 Phase 7, DoD 7.3 / 7.4 / 7.5.

| file | what it pins | read by |
|---|---|---|
| `tools-present.json` | the Tools table over one harvested Claude Code session (`cc-2.1.246-07e6c820-…`): the seven column headers and every cell of every row, with a number in both duration columns | `webview/stats/stats-view.test.ts` |
| `tools-absent.json` | the same table over `codex-synthetic-08-codex-window`: one row, an em dash in `errors`, `durationMsMax` and `durationMsSum` | the same |
| `tools-mixed.json` | the same table over `cc-synthetic-12-stall`, which states a duration for one tool and none for the other — both arms in ONE table | the same |
| `timing-present.json` | F14's six figures over the harvested session: the schema member, whether the record states it, its raw value, and the string rendered | the same |
| `timing-absent.json` | the same six over `cc-synthetic-01-reread-loop`, which states no instant at all | the same |
| `trends-tokens-per-min.json` | the tokens-per-minute series: per engine, the point count, that engine's own maximum computed from the records, the SVG `viewBox` height and the `max` caption | the same |
| `f15-present.json` | fixture 14's subagent figure and every agent row's F15 state, plus which agent carries the chip | the same |
| `f15-absent.json` | the same figure on `cc-synthetic-03-silent-subagent`, which states no spawn edges, so the count is the em dash and not `0` | the same |

## What they are, and what they are not

**Not a second implementation.** Nothing computes these but the shipped
components. What the golden buys is the same thing
`../stats/README.md` claims for the layout goldens: the rendered answers are
written down outside the code that produces them, so a change to a component
has to move a committed file. `../drawer/README.md` says the same about its
own tables.

**Not written by a script.** There is no writer and no `--write` flag: a test
that can write its own golden cannot fail against one. A missing file makes
`stats-view.test.ts` PRINT the observed value and fail, and the file is created
by reading that failure. `webview/goldens/stats/` could not hold them — that
directory is owned by `scripts/gen-webview-goldens.mjs`, which deletes anything
it did not write.

**One of them was derived by hand first, and agreed.** `tools-present.json`'s
six rows were computed before the test was run, from
`fixtures/golden/stats/cc-2.1.246-07e6c820-….json`'s own `tools[]` values
(`Read` sum 627 / max 316, `Agent` 16468, `Bash` 1839, `Glob` 755, `Grep` 647,
`Write` 343) through `format.ts:formatDuration`'s stated rule. The rendered
table matched every cell. That is a cross-check on two things at once — the
record this suite derives in-process is the record the committed golden holds,
and the component applies the formatter the way a reader would.

**Each golden is paired with a property in the test.** A table of strings is
satisfied by a component that renders the right strings for the wrong reason,
so every case is asserted twice: once against these bytes, and once against the
property the DoD names (a row count beside the row contents, `data-stated` on
each figure, an em-dash cell that must EXIST before it is read, a viewBox height
that must equal the maximum recomputed from the records).

## What is normalised, and what is not

**Nothing here is normalised, and that is a measurement rather than an
oversight.** `../ui-states/README.md` normalises time because the liveness
engine reads a clock. Every figure in this directory is a DIFFERENCE of instants
the ENGINE stated, held on one record:

- F14's `wallMs`, `timeToFirstToolMs` and `longestGapMs` are differences of
  `ToolNode.startedAtMs`/`endedAtMs` and `UsageTurn.atMs`. `src/stats/derive.ts`
  has no clock — `derive.test.ts` asserts the file contains no `Date.now()` —
  and `params.now` reaches F13 alone.
- F14's three rates are quotients of those differences. Float division is
  deterministic, so the same bytes yield the same digits on every machine.
- F2's `durationMsSum`/`durationMsMax` are `ToolNode.durationMs`, the engine's
  own figure.
- F15 is structural: a `SpawnEdge` and a `ToolNode.status`.

What IS clock-derived on this surface is `StallRecord.stalledMs`, and no golden
here holds a stall row. The records are derived with the corpora's own fixed
clock (`FIXED_NOW_MS`) in any case, which is what keeps `src/stats/goldens.test.ts`
byte-stable for the same reason.

## Line endings

Compared as parsed JSON, like `../stats/`, so a CRLF checkout cannot affect the
comparison.
