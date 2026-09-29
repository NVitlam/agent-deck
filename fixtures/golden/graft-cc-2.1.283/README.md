# `fixtures/golden/graft-cc-2.1.283/` — tree goldens for the 0.9.2 corpus

One file per session in `fixtures/cc-2.1.283/projects/<slug>/`, named `<sessionId>.json`: the
canonical serialization (`goldenText()` in `src/model/graft.ts`) of the tree `graftSession` builds
from that session. Same rules as `fixtures/golden/graft/`, whose README explains them: derived
artefacts, no filesystem paths, previews by digest, fixed key order.

They are kept apart from `fixtures/golden/graft/` because that directory is bound to
`fixtures/cc-2.1.234/` and its test asserts exactly one golden per session there.

## Regenerating

```
AGENT_DECK_UPDATE_GOLDENS=1 npx vitest run src/model/corpus-283.test.ts
git diff fixtures/golden/graft-cc-2.1.283/   # read the diff before you trust it
npx vitest run src/model/corpus-283.test.ts  # must pass with the flag unset
```

`src/model/corpus-283.test.ts` also asserts the tree itself — 12 subagents per session, 4 at depth
1 and 8 at depth 2, none parked — so a golden regenerated from a broken graft fails there too.
