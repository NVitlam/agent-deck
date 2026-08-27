# `fixtures/opencode-1.18.22/` — the OpenCode provenance **anchor**

**This is the anchor corpus for the OpenCode engine.** It is the version whose structure the
Phase 4 fingerprint's required-table and required-column assertions are proved against. Captured
raw and unredacted, like every other real capture here (G6).

The version in the directory name is the **data's** `session.version`, never the binary's.
OpenCode self-updated `1.18.22` → `1.18.23` underneath a Phase 2 measurement, and the same
database held two data versions while it happened; a binary's own version number is not a
property of the bytes it wrote.

## Provenance

| | |
|---|---|
| OpenCode data version | **1.18.22** — every `session.version` in this corpus, 24 of 24 |
| Role | **anchor** |
| Captured | 2026-08-26T22:28:27Z |
| Source | `%USERPROFILE%\.local\share\opencode\opencode.db`, opened **read-only** (`DatabaseSync { readOnly: true }`) |
| Machine | Windows 11 native |
| Project | `499645fc653f159a8aa17b06d0d86fb034643969` → `C:/Users/dev/projects/agent-deck` |
| Sessions | 24 (4 root, 20 child) |
| Fixture size | 19,374,080 bytes |

Other data versions present in the live database for this project at capture time: `1.18.21` (5 session(s)).
Those sessions are **not** in this corpus; they are captured separately as `fixtures/opencode-1.18.21/`.

## The procedure, exactly as run

```console
node scripts/capture-opencode.mjs --version 1.18.22
```

It is deterministic and re-runnable: the output directory and the target version are parameters,
nothing about this corpus is hard-coded in the script, and re-running against the same source rows
produces the same database.

**The live database is never written.** It is opened `{ readOnly: true }` and every statement
against it is a `SELECT` or a `PRAGMA` read. The fixture is **not** a file copy and **not** a
`VACUUM INTO`: it is built from scratch out of the source's own DDL, read from `sqlite_master`, so
the fixture's schema is the real schema byte-for-byte and the Phase 4 fingerprint is pinned to real
bytes rather than to a hand-written approximation. 17 indexes are recreated from the same source.

## What is in it

| Table | Rows |
|---|---|
| `project` | 1 |
| `workspace` | 0 |
| `session` | 24 |
| `message` | 197 |
| `part` | 865 |
| `event_sequence` | 24 |
| `event` | 3,179 |
| `permission` | 0 |
| `project_directory` | 1 |
| `session_context_epoch` | 0 |
| `session_input` | 0 |
| `session_message` | 0 |
| `todo` | 0 |
| `migration` | 38 |
| `data_migration` | 0 |

`data`-column bytes, as stored: `part` 5,926,095 · `message` 316,474 · `event` 10,947,108.

**Part types:** `tool` 246 · `step-start` 176 · `reasoning` 167 · `step-finish` 147 · `text` 113 · `patch` 15 · `compaction` 1.

**Tools:** `bash` 95 · `read` 73 · `task` 29 · `edit` 17 · `grep` 17 · `webfetch` 7 · `glob` 4 · `skill` 2 · `question` 1 · `write` 1.

**Tool states:** `completed` 219 · `error` 27.

**Event types:** `message.part.updated.1` 2246 · `message.updated.1` 686 · `session.updated.1` 223 · `session.created.1` 24. Max `seq` across the corpus: **1,589**.

## Session ids taken

| Session | Parent | Agent | Created (ms) |
|---|---|---|---|
| `ses_fc0bab772ffeMg5GAMA0263aZa` | — (root) | `build` | 1787767900301 |
| `ses_fc0d15641ffevlXKef1jHVzUuN` | — (root) | `build` | 1787766417854 |
| `ses_fc27a62acffeD1MlHk264PvOmI` | — (root) | `build` | 1787738561875 |
| `ses_fc55aafb9ffe34CG12YOZZZcEE` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787690307654 |
| `ses_fc624f729ffem1pc6oaV3z5zY0` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787677051094 |
| `ses_fc665c213ffeqwcuzya94r07Qe` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787672804844 |
| `ses_fc67221e5ffeSu51aTzG1ygMPX` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787671993882 |
| `ses_fc69b9f86ffeUeTEWVBibqlaEA` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787669274745 |
| `ses_fc6a63542ffe7QirDckKWEFwxl` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787668581053 |
| `ses_fc6b4d567ffeoBwumCF1wOq9uQ` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787667622552 |
| `ses_fc6be2e50ffeaDWc2m8gPVlgyt` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787667009967 |
| `ses_fc6f66557ffep7WLZDf02D3Pt5` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787663325864 |
| `ses_fc703346affeGBMdATEnSTYAmt` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787662486421 |
| `ses_fc72b406fffe7bHKDyrOFJqjSV` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787659861904 |
| `ses_fc73aa59fffeB4bLRCtAEDG5OM` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787658852960 |
| `ses_fc7665276ffe8kOj37dk4cr1A1` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787655990665 |
| `ses_fc773cccdffeLn1c5Zmn2CC8wR` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787655107378 |
| `ses_fc7a836d9ffe5dv9WYhk1Yhi7E` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787651672358 |
| `ses_fc7b28587ffesGr2xNAm1QBT9V` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787650996856 |
| `ses_fc7e59c19ffeW14rehTJ8UC2kQ` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787647648742 |
| `ses_fc7f324faffehNBPTIwy8oPjEs` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787646761733 |
| `ses_fc821eb79ffel5tbIxRSwHcWkx` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787643696262 |
| `ses_fc83161a8ffeRtUMsYpBB5HClg` | `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | `general` | 1787642682967 |
| `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` | — (root) | `build` | 1787631715519 |

## DoD 3.3 checklist

Every row is measured over the rows this corpus actually contains, by the capture that wrote it.

**DoD 3.3 is a requirement on the ANCHOR corpus** — "in one `fixtures/opencode-<version>/`" —
so on this corpus a ❌ is a real failure and the harvest is not done.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | completed and error tool parts | ✅ | `completed` 219, `error` 27 |
| 2 | a reasoning part with non-trivial text | ✅ | 167 reasoning parts, longest 36,716 chars (`prt_037930668001yK35JsK5IRwyME`) — **verbatim, the G4 target** |
| 3 | the depth-1 task pair with agreeing join keys | ✅ | 20 pair(s) where the `task` part's `state.metadata.sessionId` = child `session.id`, `state.metadata.parentSessionId` = the part's own `session_id`, and the child's `parent_id` agrees. First: part `prt_037cbbf51001IdVigLXtgFOsBX` → `ses_fc83161a8ffeRtUMsYpBB5HClg` |
| 4 | **one `task` part with no `sessionId`** | ✅ | 9 of 29 `task` parts have `state.metadata.sessionId` NULL (e.g. `prt_037de19c1001RbxdXZO7S58mso`) — the parked case, contract §G |
| 5 | step-finish with non-zero tokens | ✅ | 147 `step-finish` parts with `tokens.total > 0` |
| 6 | per-session event-cursor snapshots | ✅ | `event_sequence` has 24 rows for 24 sessions; max `seq` 1,589 |
| 7 | the compaction rows | ✅ | 1 row(s); see "The compaction split" |
| 8 | an inline tool output ≥ 50,000 chars | ✅ | 23 tool part(s) at or above 50,000 chars; largest `state.output` in the corpus is 88,292 chars (`prt_037d0d8120013bfEEXnjJ2kHpX`), stored **inline and untruncated** |
| 9 | concurrent-session rows **if present** | ➖ | **not present — 0 rows**. The query and its result are below; DoD 3.3 says "if present", so this is recorded absent rather than manufactured |

## Concurrent sessions: absent, with the query

"Concurrent" means two captured sessions whose `[time_created, time_updated]` intervals overlap and
which are not each other's parent — a parent always contains its child in time, so a parent/child
overlap is nesting, not concurrency.

```sql
SELECT a.id AS a, b.id AS b FROM session a JOIN session b ON a.id < b.id
  WHERE a.id IN (<the captured sessions>) AND b.id IN (<the captured sessions>)
    AND a.parent_id IS NOT b.id AND b.parent_id IS NOT a.id
    AND a.time_created < b.time_updated AND b.time_created < a.time_updated
```

Result over this corpus: **0 rows**. Nothing was fabricated to fill the box. If a later harvest catches two sessions running at once, that harvest is the fixture for it.

## Max spawn depth is 1

Sessions whose parent itself has a parent: **0**. Every child in this corpus is a direct child of a
root session.

`docs/opencode-contract.md` §5 records why, and it is not a sampling artefact: the measured
`session.permission` on a subagent session is `[{"permission":"task","pattern":"*","action":"deny"}]`
— **the child cannot spawn**, because this installation denies subagents the `task` permission.
Depth 2 is therefore not capturable here without changing that setting, in the same way CC's
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "2"` caps the CC corpora. The grafter must still walk the
`parent_id` chain and assert what the data says rather than assuming a cap.

## The compaction split — why there are two corpora

The two known `compaction` part shapes are **split across versions**, and that is the reason this
fixture set has an anchor and a witness rather than one corpus:

```json
1.18.22   {"type":"compaction","auto":true,"overflow":false,"tail_start_id":"msg_03a51462f001DwrGE19VXZO2ij"}
1.18.21   {"type":"compaction","auto":true,"overflow":false}
```

**`tail_start_id` is OPTIONAL**, and the `1.18.21` corpus is the fixture that proves it. A
fingerprint written against the anchor alone would make it required and would refuse every
`1.18.21` session; a parser written against the witness alone would never look for it. Neither
corpus can establish that on its own — this is exactly the CC pattern, where `cc-2.1.246` is the
anchor and `cc-2.1.237` / `cc-2.1.241` are the witnesses that keep a field from being mistaken for
a requirement.

This corpus's own compaction rows, verbatim:

```json
{"type":"compaction","auto":true,"overflow":false,"tail_start_id":"msg_03a51462f001DwrGE19VXZO2ij"}
```

(`prt_03a7a7e700013sN9DCtTu76YAh`)

## G8 — what was excluded, and why the check is in the code

The live database contains projects other than this one. DoD 3.2 as written says the capture
"aborts on any `project` row whose `worktree` is not this repo", which stopped being satisfiable
the moment a second project appeared: taken literally it means "never capture again". The rule the
script implements has two halves, and **both are in the code**:

- **FILTER** — only rows reachable from this repository's `project` row are selected. Foreign rows
  are never read into the fixture.
- **ASSERT** — every row *selected for capture* is re-checked against this repository's identity,
  and any disagreement aborts the run with a non-zero exit. The assertion runs **twice**: once over
  the source selection before anything is written, and once over the finished fixture.

Excluded at this capture:

| Project id | Worktree | Sessions | Why |
|---|---|---|---|
| `9af6ede17fcbc7f9948511cd124c6e73f732eefe` | `C:/[6 path segments redacted]` | 1 | not this repository |
| `global` | `/` | 1 | not this repository |

**The foreign worktrees are redacted in this file, and that is not tidiness.** A path naming
another project is exactly the FOREIGN content the privacy sweep drives to zero, and writing it
into a committed document in a public repository would leak the thing the G8 filter exists to
keep out — a G8 log that is itself a G8 violation. The `project.id` is OpenCode's own opaque
digest and the session count is a number, so both are recorded verbatim; only the location is
reduced to its segment count. The full values are printed to the console by the capture run,
where they are ephemeral and can be checked by whoever runs it. `2` foreign session(s) were
excluded with them; their ids are console output for the same reason.

Own sessions excluded because they are a different data version (captured in their own corpus): 5 at `1.18.21`.

The kept `project` row's `worktree` is **not rewritten**. This developer's own absolute paths are
deliberate inside an enumerated fixture corpus — the privacy sweep's `→ 0` applies to FOREIGN
content and to secrets, never to this repository's own paths inside a capture.

## Dropped by schema

These tables are **never created** in the fixture. There is no column named `access_token`,
`refresh_token`, `value` or `secret` anywhere in the artifact, so there is nothing to leak even if
a future OpenCode release starts populating them:

| Table | Rows in the live DB at capture | Why |
|---|---|---|
| `account` | 0 | `access_token` / `refresh_token` columns |
| `account_state` | 0 | points at `account`; dropped as part of a deliberate superset |
| `control_account` | 0 | `access_token` / `refresh_token` columns |
| `credential` | 0 | a `value` column holding credentials |
| `session_share` | 0 | a share `secret` column |

**The DoD names four; five are dropped.** `account_state` comes from the Phase 2 handoff and holds
no secret itself — it only points at `account` — but a superset is the safe direction for a drop
list, and a dangling foreign key into a table that does not exist is not a fixture anyone should
have to reason about. That is a deliberate widening, recorded here rather than left to be
rediscovered.

All five measured **0 rows** at capture time. That is precisely why the rule is *by schema* rather
than *by row*: the schema is the risk, the row count is a coincidence of this moment, and a capture
procedure that deletes rows would start shipping secrets the first day one of those tables is used.

## Kept, deliberately: the out-of-scope tables

`data_migration`, `migration`, `permission`, `project_directory`, `session_context_epoch`,
`session_input`, `session_message`, `todo` and `workspace` are **not** read by the engine and are
kept anyway — filtered to this project where they have a project or session dimension, whole where
they do not.

They exist so Phase 4 has a **real** fixture for contract §3's rule that unknown tables are
*ignored, not refused* (the CC unknown-field rule applied to schema). A fixture containing only the
six required tables cannot test that rule at all: it would pass a fingerprint that refuses every
real database on the planet.

## No truncation — the explicit decision

DoD 3.2 permits truncating long payloads "to shape, with the decision recorded". **The user chose
not to truncate anything.** `part.data`, `message.data` and `event.data` are stored exactly as read:
no truncation, no normalisation, no reformatting, no re-serialisation, no pretty-printing.

What that buys: the largest inline tool output in this corpus is 88,292 characters and it is
all here, so the truncation and preview code has a real payload to be measured against instead of a
pre-shortened one. The reasoning parts are the G4 target and their bytes are the thing the G4 test
asserts against — a redacted or shortened fixture would make that test vacuous, which is the exact
failure mode CC's empty-`thinking`/populated-`signature` trap already produced once in this repo.

What it costs: 19,374,080 bytes on disk. `fixtures/**` is denied in `.vscodeignore`, so none of it ships
in the VSIX.

Verification is not a claim: the capture re-opens the finished fixture and compares, per table, a
SHA-256 over every column of every row **and** a SHA-256 over SQLite's own
`length(CAST(data AS BLOB))` per row. The second is computed by the engine on the stored bytes, so
it catches a byte-level round-trip failure that a JavaScript string comparison cannot see. Integers
are read as `BigInt`, so no millisecond timestamp passes through a float. Any mismatch aborts the
capture.

Preserved verbatim by that check: every `id`, `callID`, `parent_id`, `project_id`, `session_id`,
`message_id`, `aggregate_id`, `seq`, `state.metadata.sessionId`, `state.metadata.parentSessionId`,
every `time_*` value, and every reasoning byte.

## Privacy

Checked on the captured rows, **case-sensitively with SQLite `GLOB`** — never `LIKE`, which is
case-insensitive. A three-letter project name searched with `LIKE` matches every word that
contains those letters in any case — `LIKE '%ART%'` matches "st" + "art" + "ed" — and that has
already produced one wrong count in this repo:

| Needle | `part` | `message` | `event` |
|---|---|---|---|
| `ghp_` | 0 | 0 | 0 |
| `github_pat_` | 0 | 0 | 0 |
| `sk-ant-` | 0 | 0 | 0 |
| `AKIA` | 0 | 0 | 0 |
| `xox?-` | 0 | 0 | 0 |
| `-----BEGIN` | 0 | 0 | 0 |

`projects/<project>` tokens appearing anywhere in the captured `data` columns: `agent-deck` 4,178 · `agent-deck.` 6.
No other project is named. Rows containing a NUL byte: 0.

Like the rest of `fixtures/`, this corpus is **raw and unredacted by deliberate choice**: it carries
this repository's own absolute paths, real session ids and real tool output. G8 holds — nothing
here was captured from any project other than this one.

## Replay, and the negative control

The fixture is a plain SQLite file; open it read-only and read it:

```console
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('fixtures/opencode-1.18.22/opencode.db',{readOnly:true});console.log(d.prepare('SELECT count(*) n FROM session').get())"
```

**The negative control fakes `USERPROFILE`, not `HOME`.** `os.homedir()` reads `USERPROFILE` on
Windows, so a control that fakes only `HOME` runs happily against the real OpenCode data directory
and reports a confident green pass on the one check whose entire purpose is proving we never touch
it. `src/release/opencode-capture.test.ts` runs the capture with `USERPROFILE` pointed at an empty
directory and asserts it exits non-zero naming the missing root, rather than falling back.


## Golden regenerated 2026-08-27

**golden regenerated 2026-08-27: projectSlug per Amendment 1.**

`PLAN.md` Phase 4 `Amendment 2026-08-27 — projectSlug, liveness proof, coverage law`, item A1,
closed the `projectSlug` open item in Phase 4 rather than in Phase 5. This corpus's `golden.json`
was regenerated once, with `node scripts/opencode-golden.mjs`, and **that regeneration is the only
permitted golden edit in Phase 4.**

The diff is one field per session and nothing else:

```diff
-      "projectSlug": "",
+      "projectSlug": "c--Users-dev-projects-agent-deck",
```

That value is the CC project slug for this corpus's `project.worktree`
(`C:/Users/dev/projects/agent-deck`), derived by the rule Claude Code uses to
name its `~/.claude/projects/<slug>` directory. It is byte-identical to the one directory name under
`fixtures/cc-2.1.246/projects/` and to the `projectSlug` the CC goldens in
`fixtures/golden/session/` already carry — one workspace observed by two engines, one project key.
`src/release/opencode-golden.test.ts` asserts both of those equalities with both sides read off disk.

What used to stand here, and is superseded: the goldens carried `""` as an explicit placeholder,
because spec OC7 and `GOLDEN.md` § *What was NOT decided here* both parked the question for Phase 5.
