# `cc-2.1.283` — the SIDECAR-RACE corpus

Captured 2026-09-29 for 0.9.2. Two real Claude Code sessions from this machine's live
`~/.claude/projects/`, captured raw and then redacted; G6 applies to them exactly as to every other
corpus here.

**Why it exists.** On 2026-09-28 a 4x2 nested run (four agents, each spawning two) rendered its
sessions `unsupported` mid-run and kept the refusal screen after the run had finished. The cause was
the subagent pair race: Claude Code writes `agent-<id>.jsonl` and `agent-<id>.meta.json` as two
files, and a graft that looked between the two refused the whole session
(`subagentMetaMissing` / `subagentTranscriptMissing`). The ruling of 2026-09-29 made such a pair
*pending* for 2,000 ms after the mtime of the file that exists; this corpus is the run that showed
the defect, and the replay tests stage it with one file withheld.

## Provenance

| | `853296cc-eb78-4a6c-b747-cd5417473cc5` | `d860ab28-db10-40dc-8775-ae00eeb21f23` |
|---|---|---|
| version on every line | `2.1.283` | `2.1.283` |
| subagents | 12 (4 at depth 1, 8 at depth 2) | 12 (4 at depth 1, 8 at depth 2) |
| sidecars | 12 | 12 |
| `tool-results/` | none | none |

50 files in all: 2 main transcripts, 24 subagent transcripts, 24 sidecars.

## The pair order, measured before the copy

Birth times (NTFS) of each pair's two files in the live tree, sidecar minus transcript. **Git does
not keep birth times, so this table is the only record of them**; the copies in this directory all
carry the harvest's time.

| session | transcript first | sidecar first | same instant | widest gap |
|---|---:|---:|---:|---|
| `853296cc` | 8 | 4 | 0 | sidecar 229.2 ms after its transcript |
| `d860ab28` | 9 | 2 | 1 | sidecar **372.4 ms** after its transcript (`a704ec1707a92b778`) |
| **both** | **17** | **6** | **1** | sidecar-first at most 76.5 ms |

**The order reversed since 2.1.234**, where the sidecar came first by 80-120 ms in 5 of 5 spawns
(`CLAUDE.md`, PLAN F1). Both orders occur within one 2.1.283 run, which is why the pending rule
covers both.

## What is new on 2.1.283, pinned as observed

`src/model/corpus-283.test.ts` pins each of these; none is required by the fingerprint or read by
the model.

- **A new record type, `cost-state`**: 3 lines, all in main transcripts, keys `type, sessionId,
  totalCostUSD, totalAPIDuration, totalAPIDurationWithoutRetries, totalToolDuration,
  totalLinesAdded, totalLinesRemoved, totalDuration, startTime, modelUsage, hasUnknownModelCost`.
  Now in `IGNORED_ENTRY_TYPES`; before 0.9.2 each was counted as a malformed line.
- **New keys on existing types**: `user` — `turnOrigin` ×2, `serverClassifierContext` ×74;
  `attachment` — `rendered` ×399, `renderedInHumanTurn` ×2; `assistant` — `serverClassifierRequest`,
  `advisorModel`, `perTurnEffort` ×153 each (every assistant line), `wireToolInputs` ×114,
  `wireIngestContext` ×3. None occurs on the same type in any earlier corpus.
- **New sidecar keys**: `requestShape` (`foreground` ×22, `background` ×2) and
  `requestNonInteractive` (`true` ×24). The fingerprint preserves unknown sidecar fields, so both
  are accepted as they stand.

## What was done to the bytes

The route every CC corpus since `cc-2.1.260` took; no new tool.

1. **Copy and rewrite.** Both sessions copied whole; the repository path and the project slug
   rewritten to the scrubbed form every committed CC corpus carries — slug
   `c--Users-dev-projects-agent-deck`, `cwd` `C:\Users\dev\projects\agent-deck` — in every spelling
   the harvest reached (JSON-escaped 1,303, MSYS 217, slug 69, forward-slash 60: 1,649
   replacements), by slice rather than `String.replace`.
2. **`lab/tools/redact-paths.mjs`** (identity, 45 tokens) — `files=50 changed=26 renamed=0
   exempt=0 skipped=0`; 948 replacements across four token classes (other home-directory paths 121,
   the developer email 52, surname and handle 385, given name 390).
3. **`scripts/redact-paths.mjs`** (path shapes) — `files=50 skipped=0 changed=0`, `hits={}`.

**One distinct `cwd`** across all 838 lines that carry one — the check the `cc-2.1.260` harvest
taught, run after the last step.

**`node scripts/privacy-sweep.mjs --untracked` → `VERDICT PASS identity=0 secrets=0 telemetry=0
foreign=0`, identity RUN (45 tokens), before anything was committed.** Its scope was proven, not
assumed: a planted untracked file in this directory carrying the real username turned the same
command into `FAIL identity=1`, and it passed again once the file was removed.

**What the corpus carries that is not session content:** Claude Code injects this repository's
`CLAUDE.md` into every context, so its text appears once per transcript, as it does in `cc-2.1.260`.
The words `password`, `api_key` and `github_pat` in this corpus are all that text's own prose about
the privacy sweep. The injected user email reads `dev@example.invalid` after step 2.
