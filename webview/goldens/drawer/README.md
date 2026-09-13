# `webview/goldens/drawer`

| file | what produced it | what it pins | read by |
|---|---|---|---|
| `follow.json` | hand-written from the user's rule (2026-09-05, v0.7.0 DoD 4.9b) | `webview/drawer.ts:followTarget` and `atGrowingEnd` — the drawer's follow-the-latest scroll target | `webview/drawer.test.ts` |
| `header-2400.json` | hand-written from the flex arithmetic (v0.8.0 DoD 7.9) | `webview/inspector-header.ts:layoutHeader` at a 2400px panel — the header's seven field boxes, placed from `Inspector.svelte`'s own stylesheet | `webview/inspector-header.test.ts`, `webview/inspector.test.ts` |
| `header-1200.json` | the same, at a 1200px panel | the same boxes, and which of them `.fields`' `overflow: hidden` cuts | the same two |

**This golden is NOT a second implementation.** Nothing computed it but a
person reading the rule: follow the latest call in whichever direction the
list grows; an expanded entry pins; closing it resumes. What it buys is the
same thing `../layout/lane-subsets.json` buys — the answers are written down
outside the code that produces them, so a change to the rule has to move a
committed number. Do not describe it as two implementations agreeing.

`webview/inspector.phase4.test.ts` drives the component the function serves.

## `header-2400.json` and `header-1200.json` — what they are

DoD 7.9. The user's v0.7.1 smoke recorded that at wide panel widths the
inspector header's SESSION value paints over SPAWN DEPTH. These two tables
say where the seven field boxes sit and whether any field's ink reaches into
another field's box, at two panel widths.

**They are computed from the stylesheet, which is what makes them pin it.**
`webview/inspector-header.ts:parseHeaderCss` reads `Inspector.svelte`'s own
`<style>` block — the `.fields` gap, `.field`'s shrink factor, all seven
`min-width` rules and the two font sizes — and `layoutHeader` places the boxes
from what it read. Take `flex-shrink: 0` back out of `.field` and the 1200px
table moves and goes red.

**They are NOT browser measurements, and no test in this repository can be.**
jsdom computes no layout: no flex, no font, no box. Three limits, stated
again here because a reader meeting the numbers first would take them for
observations: the model measures text as a character count times a fixed
advance ratio, it cannot see a rule it does not parse, and it takes the width
of everything else in the header as one estimated constant
(`HEADER_RESERVED_PX`, read off `media/inspector.png`). The confirmation on a
screen is the user's own smoke, DoD 7.12.

**What the two widths differ in.** With `.field` at shrink 0 the group's
content does not reflow with the panel, so the boxes are identical in both
tables. What a narrower panel changes is how much of the group is drawn:
at 2400px all seven fields are whole, at 1200px `burn` is cut at the
right-hand edge and `duration` is not drawn at all. Two tables agreeing about
everything would be one golden written twice.

**Which one is the DoD's mutation witness.** The 1200px one. A panel wide
enough that the group is never compressed has no shrinking to do, so removing
the fix leaves the 2400px table identical — `inspector-header.test.ts` asserts
that rather than leaving it to be discovered. What the 2400px table pins is
the other half: the gap, the seven minima, the font sizes and the field set,
each of which moves its x positions.
