# `webview/goldens/layout`

Three goldens live here:

| file | what produced it | what it pins | read by |
|---|---|---|---|
| `design-tables.json` | `node webview/layout.reference.mjs` | the frozen design's deck and tree tables | `webview/layout.test.ts` |
| `wide-rank.json` | `node scripts/make-wide-rank.mjs` | A8's wide-rank tree placements | `webview/wide-rank.test.ts` |
| `lane-subsets.json` | hand-written from the design's lane arithmetic | deck lane coordinates for all seven non-empty engine subsets (DoD 5.0c) | `webview/layout.test.ts` |

(This file said "one golden lives here" while there were two; `wide-rank.json`
landed with A8 and the sentence was not updated. Recorded rather than quietly
tidied — a directory README that undercounts its own contents is how a reader
concludes a golden is unused.)

They are not all the same KIND of golden, and the difference decides what each
one is evidence for — see `lane-subsets.json` below, which has no second
implementation behind it and says so rather than borrowing the paragraph above
it.

## `design-tables.json` — what it is

The **verbatim stdout** of `node webview/layout.reference.mjs`, captured as an
array of lines. `layout.reference.mjs` is the frozen canvas design's own
implementation of the layout arithmetic — deck placement for three layouts by
three sorts, the A1.1 node widths, and three tidy-tree runs — and its output
reproduces the frozen design document's tables.

Regenerate with:

```
node webview/layout.reference.mjs
```

and paste the lines back in. Nothing regenerates it automatically, and that is
deliberate: a golden that rewrites itself is a rubber stamp.

## `design-tables.json` — what it is for

`webview/layout.test.ts` re-emits the same tables from **production**
`webview/layout.ts` and compares them line for line.

The evidence is that **two independent implementations agree**. Three rules
keep it evidence rather than decoration, and breaking any one of them makes the
test pass forever while proving nothing:

1. **`layout.ts` must never import `layout.reference.mjs`.** The first test in
   `layout.test.ts` reads `layout.ts`'s own source text and asserts it does not.
   A production module that imported the reference would compare the reference
   against itself.
2. **`layout.reference.mjs` is frozen and is never edited to make a test pass.**
   Its own header says so. If production disagrees with it, one of the two is
   wrong and the answer is in the design.
3. **A change to any number in this file is a design amendment**, not a test
   edit.

## `lane-subsets.json` — what it is, and what it is NOT

Deck lane coordinates for **all seven non-empty subsets** of `{cc, oc, cx}`:
for each subset, the layout mode the deck resolves to, `deckLaneX`'s answer for
every engine in the subset, and the full `deckLayout(…, 'lanes', 'engine', 800)`
placement list for two cards per present engine.

It exists because `deckLaneX` used to place a lane at its engine's ABSOLUTE
rank, so a visible set of `{cc, cx}` drew cards at slots 0 and 2 and left an
empty column where `oc` would have sat. Compacting to the present set fixes
that, and it leaves `{cc, oc}` and `{cc, oc, cx}` untouched — which is exactly
why all seven rows are here rather than the one that was wrong. Four rows
would have been the fix restating itself.

**This golden is NOT a second implementation.** `design-tables.json` is evidence
because `layout.reference.mjs` computed it independently; nothing computed
`lane-subsets.json` but a person reading the design's lane arithmetic, and the
frozen reference knows only two engines, so it cannot rule on any subset
containing `cx`. What this golden buys is that the seven answers are **written
down outside the code that produces them**, so a change to `deckLaneX` that
moves a coordinate has to move a committed number too. Do not describe it as
two implementations agreeing.

`webview/layout.test.ts` reads it, drives production `deckLayout` and
`deckLaneX` for each subset, and compares. The mutation control is in the same
file: reverting `deckLaneX` to the absolute-rank form must turn the `{cc, cx}`
and `{oc, cx}` rows red.

## Why lines in JSON rather than a `.md`

`.gitattributes` deliberately does not mark `webview/goldens/**` as `-text`,
because these goldens are compared as **parsed JSON** and line endings
therefore cannot affect them. A markdown golden would be compared as bytes, and
this repository's working tree is CRLF while the generator writes LF — the
comparison would pass only on the machine that produced it. Storing the lines
inside JSON keeps that hazard out entirely.

## What used to be here

Eleven goldens for the superseded phyllotaxis canvas — `deck-n00` through
`deck-n12`, `deck-constellation`, `blob-paths` and four `session-*` files. They
pinned blob radii, golden-angle spiral placement, constellation dots and the
dot-ring session interior. All of that geometry was deleted from `layout.ts`, so
the goldens went with it rather than being left behind to pin code that no
longer exists.
