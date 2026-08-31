# `fixtures/opencode-1.18.25/moved-project/` — the workspace that moved

**Captured 2026-08-31** from the live OpenCode store on the development machine, on
OpenCode **1.18.25**. Diagnosis and every measurement quoted here:
`docs/evidence/release-0.5.0/DRIFT-2.1.251.md` §5.2.

## What it is a witness for

A **project whose directory moved**, which the two anchor corpora cannot express.

OpenCode keeps **one `project` row per repository identity** and never rewrites
`project.worktree` when the workspace moves. The `session` row's `directory` column
*is* kept current. So after a move the two disagree, and everything keyed off
`worktree` — `SessionState.projectSlug`, and the workspace match with it — resolves
to a path the workspace has left.

The single `session` row here was **run at the new path** and still landed on the old
project row. That is the defect in one row:

| Column | Value |
|---|---|
| `project.worktree` | `C:/<ROOT-OLD>/agent-deck` |
| `project_directory` (2 rows) | `C:/<ROOT-OLD>/agent-deck`, then `C:/<ROOT-NEW>/agent-deck` |
| `session.directory` | `C:/<ROOT-NEW>/agent-deck` |
| `session.version` | `1.18.25` |
| `session.parent_id` | `NULL` (a root session) |

**Why the anchor corpora could not catch it.** Measured: in
`fixtures/opencode-1.18.21/` `session.directory` equals `project.worktree` on all 5
rows, and in `fixtures/opencode-1.18.22/` on all 24. A corpus in which the two agree
cannot distinguish the two rules — which is exactly why the fix moves **no committed
golden byte**, and why this fixture had to exist before the fix did.

`src/opencode/moved.test.ts` is the test. Its first assertion is the vacuity control:
the two columns must **disagree**, or nothing below it proves anything.

## Redaction

Paths are tokenised, not scrubbed after the fact — the fixture was **built** with the
tokens in place, so no real path was ever written to disk here:

```
C:/Users/<user>/<the chain the workspace LEFT>/agent-deck  ->  C:/<ROOT-OLD>/agent-deck
C:/Users/<user>/<the chain it MOVED TO>/agent-deck         ->  C:/<ROOT-NEW>/agent-deck
```

Both left-hand sides are written as shapes rather than as the real folder chains.
`scripts/privacy-sweep.mjs` flagged three lines of this file when they named those
folders — a README explaining a redaction is as much in scope for the sweep as the bytes
it describes, and the sweep is what said so.

Substitution is **longest-first**, because the new path is a prefix-sibling of the old
one — the move dropped one directory level and kept the rest — and a naive pass would
have rewritten the old path's tail into the new token.

The tokens keep the `C:` drive prefix and the `/` separators deliberately: they make
`slugFromWorktree` do real work, so the Windows drive-letter rule
(`src/opencode/slug.ts`) is exercised rather than bypassed by a token with no path
shape. The resulting keys are `c--<ROOT-OLD>-agent-deck` and `c--<ROOT-NEW>-agent-deck`.

The build asserted, over every string column of every row of the finished file, that
neither the user name, nor either real absolute path, nor any folder in either chain
survived. **0 hits.**

## What is NOT in it

`message`, `part`, `event` and `event_sequence` exist (the fingerprint requires all six
tables) and hold **zero rows**, by decision. The captured session produced two `message`
rows and one `part` row; none was copied. This fixture is about a *key*, not about
content, and a witness that carries no content cannot leak any. The consequence is that
it exercises no parse or graft branch — that is `fixtures/opencode-1.18.22/`'s job.

`project_directory` **is** included, with both rows. We do not read that table —
`session.directory` already answers the question and is a column the fingerprint already
requires — but it is the record that OpenCode itself knows about the move, and
`moved.test.ts` pins it as an *unknown* table so that a future decision to read it has
to be made deliberately.

## Shape

```
opencode.db     61,440 bytes, journal_mode=delete, 15 pages
```

`journal_mode=delete` matches both anchor corpora, which is what lets the tests open it
`immutable: true` (`db.ts` refuses that on a WAL-mode file). There is no `-wal` and no
`-shm` sidecar, and `moved.test.ts` asserts neither appears after a read (G1).

The seven tables' DDL is the **live 1.18.25 DDL**, read from the source database, not
retyped. That is what makes the additive drift real: `project_directory` reports as an
unknown table here for the same reason it does against the live store.
