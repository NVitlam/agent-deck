# `webview/goldens/layout`

One golden lives here now: `design-tables.json`.

## What it is

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

## What it is for

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
