# `fixtures/golden/session/` — committed `SessionState` snapshots

One file per session transcript in `fixtures/cc-2.1.234/projects/<slug>/`, named
`<sessionId>.json`. Each is the canonical serialization of the **`SessionState`** that
`src/model/session.ts` produces for that session, written by `sessionGoldenText()`.

These are **derived** artefacts, not captured data — evidence about *our* session model, not
about Claude Code. The captured data they are derived from lives in `fixtures/cc-2.1.234/`
and in `fixtures/hook-events/`, and that is the only ground truth here (G6).

## How these differ from `fixtures/golden/graft/`

The graft goldens pin the tree the grafter builds from one session's files, in isolation.
These pin what the session model hands the webview after **both** captured sessions were
replayed **interleaved** through one model, with the hook stream interleaved between them
(the R4 test in `src/model/session.test.ts`). So they additionally carry:

- `workspaceMatch` and `liveness` — the hook tap's answer, which the grafter never has;
- `spawnEdges` — the `tool_use` → subagent join. `ToolNode` has no `children` field, so a
  subagent node sits *beside* the tool call that spawned it and this list is the only
  record of the real relationship. A renderer that wants to draw the subagent under its
  spawning tool call reads these.

A difference between a session's graft golden and its session golden that is **not** one of
those three things is a composition bug, and `session.test.ts` asserts the trees are
`toStrictEqual` to prevent exactly that.

## What a golden pins

Same three rules as `../graft/README.md`, for the same reason — a golden that only
reproduces on the machine that captured the fixtures is worth nothing:

1. **No filesystem paths.** `projectSlug` is the slug directory *name*, which is fixture
   content. A test asserts no golden here contains a drive letter, `/Users/`, `.claude`, or
   a Windows path separator.
2. **No wall-clock values.** The only absolute time is `epochAnchor`, the earliest timestamp
   in the session, taken from a fixture line; every node time is a millisecond offset from
   it. A test asserts each file holds exactly one ISO-8601 string. `liveness` is likewise
   not wall-clock-dependent: the test injects a fixed clock (`CLOCK_BASE`) and fixed hook
   `receivedAt` values, so `live`/`idle`/`ended` is a function of the fixtures alone.
3. **Previews by digest.** `inputPreview` / `resultPreview` are
   `sha256:<first 16 hex>:<utf8 byte length>`, never verbatim, because captured tool inputs
   embed the capturing machine's absolute paths. The digest still fails on a one-byte change.

Key order is fixed by the serializer, so a diff between two goldens is a real difference and
never a reordering.

## What `liveness` in these files depends on

`liveness` is produced by replaying `fixtures/hook-events/cc-2.1.234-redacted.jsonl` against
these sessions. That capture is one real session's events; the replay rewrites **only**
`session_id`, partitioning events between the two sessions by `agent_id` so their subagent id
sets are disjoint. Key presence and absence is otherwise untouched — main-thread events carry
no `agent_id` key at all, and a replay that normalised that away would test nothing.

Consequence: **re-harvesting the hook capture can legitimately change `liveness` in these
goldens** even when no transcript changed. That is a real difference and should be read as
one, not suppressed.

## Regenerating after a re-harvest

```
AGENT_DECK_UPDATE_GOLDENS=1 npx vitest run src/model/session.test.ts
```

That rewrites every `<sessionId>.json` here from the current fixtures and skips the
comparison assertions for that run. Then:

```
git diff fixtures/golden/session/           # read the diff before you trust it
npx vitest run src/model/session.test.ts    # must now pass with the flag UNSET
```

Without `AGENT_DECK_UPDATE_GOLDENS=1` the test writes nothing and only compares.

**Read the diff.** A golden that nobody read is worth exactly nothing. Regeneration is also
the *only* supported way to update these files — hand-editing JSON here pins whatever the
editor believed rather than whatever the code does.

Deleting a session from `fixtures/cc-2.1.234/` requires deleting its golden by hand:
`session.test.ts` asserts this directory holds exactly one golden per captured session, so a
stale file fails the suite rather than lingering.
