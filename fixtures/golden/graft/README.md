# `fixtures/golden/graft/` — committed tree snapshots

One file per session transcript in `fixtures/cc-2.1.234/projects/<slug>/`, named
`<sessionId>.json`. Each is the canonical serialization of the tree that
`src/model/graft.ts` builds from that session, produced by `goldenText()`.

These are **derived** artefacts, not captured data. They are evidence about *our* grafter,
not about Claude Code. The captured data they are derived from lives in
`fixtures/cc-2.1.234/` and is the only ground truth here (G6).

## What a golden pins

`serializeSnapshot()` produces the exact object in these files. Three rules, all of them
about reproducing on a machine that is not the one that captured the fixtures:

1. **No filesystem paths.** Nothing in a golden comes from where the fixtures happen to
   live. `projectSlug` is the slug directory *name*, which is fixture content.
2. **No wall-clock values.** The only absolute time in the file is `epochAnchor` — the
   earliest timestamp in the session, taken from a fixture line. Every node time is a
   millisecond offset from it, so a re-harvest moves one anchor instead of every node.
   `graft.test.ts` asserts there is exactly one ISO-8601 string in the whole file.
3. **Previews by digest.** `inputPreview` / `resultPreview` are stored as
   `sha256:<first 16 hex>:<utf8 byte length>`, never verbatim. The captured sessions' tool
   inputs embed the *capturing* machine's absolute paths (`c:\Users\…`), and a golden
   containing those would only reproduce on that machine. The digest still fails loudly on
   a one-byte change.

Key order is fixed by the serializer, so a diff between two goldens is a real difference
and never a reordering.

## Regenerating after a re-harvest

New CC version, or new sessions captured into `fixtures/cc-2.1.234/`:

```
AGENT_DECK_UPDATE_GOLDENS=1 npx vitest run src/model/graft.test.ts
```

That rewrites every `<sessionId>.json` in this directory from the current fixtures and
skips the comparison assertions for that run. Then:

```
git diff fixtures/golden/graft/          # read the diff before you trust it
npx vitest run src/model/graft.test.ts   # must now pass with the flag UNSET
```

Without `AGENT_DECK_UPDATE_GOLDENS=1` the test writes nothing and only compares.

**Read the diff.** The whole point of a golden is that a change in tree shape shows up as a
reviewable diff rather than as silence. A regenerated golden that nobody read is worth
exactly nothing. Regeneration is also the *only* supported way to update these files —
hand-editing JSON here produces a golden that pins whatever the editor believed rather than
whatever the code does.

Deleting a session from `fixtures/cc-2.1.234/` requires deleting its golden by hand:
`graft.test.ts` asserts this directory holds exactly one golden per captured session, so a
stale file fails the suite rather than lingering.
