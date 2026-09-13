# Stats records as an earlier release wrote them

v0.8.0 DoD 7.14 (user ruling R3, 2026-09-13): records an older `statsSchemaVersion`
wrote are READ, never skipped and never rewritten.

Each file here is a record BYTE-IDENTICAL to a committed golden at the tag it names,
taken with `git show <tag>:<path>` and never edited. It is the input a store written
by that release really holds, so a test planting it tests history rather than a
record this repository re-typed.

| file | taken from |
| --- | --- |
| `v0.7.1-cc-2.1.260-75ef0bbf-2493-4c77-8af7-3a56fb2ce36e.json` | `v0.7.1:fixtures/golden/stats/cc-2.1.260-75ef0bbf-2493-4c77-8af7-3a56fb2ce36e.json` — schema 1, 81 files, 7 churn chains, 8 tools |

`scripts/gen-stats-goldens.mjs` does not write here and does not delete from here: it owns
`fixtures/golden/stats/` only.
