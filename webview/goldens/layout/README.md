# Layout goldens

Pinned coordinate **numbers** for `webview/layout.ts`, written and compared by
`webview/layout.test.ts`. C7.5 of `agent-deck-spec.md` requires numbers rather
than screenshots, and these are them.

## What is in here

| File | Subject |
|---|---|
| `deck-n00 / n01 / n02 / n06 / n12.json` | `deckLayout` at the five sizes PLAN names. Each file holds both the `input` list and the `output` placements, so a re-harvest that changes the input reads as a legible diff instead of an unexplained coordinate move. |
| `blob-paths.json` | `blobPath` output for the captured session ids plus three fixed strings, with the `hashSessionId` seed alongside each. |
| `session-deepest-capture.json` | `sessionLayout` of the captured session with the deepest spawn chain, laid out with its resolved spawn edges. `maxSpawnDepth` is recorded in the file. |
| `session-parked-graft.json` | `sessionLayout` of a committed graft fixture whose graft **parks** an agent. The parked agents and their `ParkCode` are recorded in the file; they get no cell, because a parked agent is not in `root` and `SessionState` carries no parked list. |
| `session-unanchored-cells.json` | The same captured tree with **no** spawn edges, which is what `toSessionState` in `src/model/graft.ts` returns. Every subagent cell is then unanchored — the geometry the parked visual grammar needs. |

Every file also records `source`: the repo-relative path the subject was read
from. Subjects are selected **by property** ("the deepest capture", "the first
fixture that parks an agent"), never by naming a session id, so a re-harvest
moves the subject and the `source` line says so.

## Regenerating

```
AGENT_DECK_UPDATE_GOLDENS=1 npx vitest run webview/layout.test.ts
```

**That run is designed to fail.** `HANDOVER.md` carry-forward G records the
existing convention as a live hazard — a golden suite that rewrites itself is a
rubber stamp. So with the variable set this file set is rewritten *and* the last
test in `layout.test.ts` fails on purpose, naming what happened. The only route
to green is to read the diff and commit it. A plain `npx vitest run` writes
nothing at all.

## Line endings

These are compared as **parsed JSON**, not as bytes. `core.autocrlf=true` is set
on the dev machine and this directory is not covered by the `fixtures/** -text`
rule in `.gitattributes`, so a fresh clone may check them out with CRLF. A byte
comparison would then pass only on the machine that wrote them; parsed numbers
are indifferent to the line ending they were stored behind, and numbers are what
C7.5 says to pin.
