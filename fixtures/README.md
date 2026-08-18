# Fixtures

**These are real Claude Code session transcripts, captured raw.** Parser and stitcher behavior is
pinned to them (grounding contract G6): a new CC version means capturing new fixtures *before*
changing code.

## Contents

```
cc-2.1.234/projects/c--Users-dev-projects-agent-deck/
  7dc3481d-….jsonl                     main transcript (Phase 0 orchestrator session)
  7dc3481d-…/subagents/agent-*.jsonl   5 subagent transcripts, incl. one spawnDepth:2
  7dc3481d-…/subagents/agent-*.meta.json
  4299490e-….jsonl                     main transcript (second concurrent session)
  4299490e-…/subagents/agent-*.jsonl   1 subagent transcript
phase0-evidence/
  latency-*.log                        measured append→render latency samples
  synthetic-hook-events.jsonl          7 synthetic hook payloads (P0-2 evidence)
  real-hook-events.jsonl               181 real CC hook payloads, verbatim — see privacy note
  hook-mechanism-timing.txt            node -e vs curl.exe cost with the listener down
PHASE0-VERDICT.md                      the Phase 0 gate decision, with evidence
```

Captured 2026-08-19 from CC **2.1.234**, Windows 11 native. Both sessions were live when captured, so
they are snapshots of a file still being appended — which is exactly the condition the tailer must
handle.

## Replay

The fixture tree is self-contained. `CLAUDE_PROJECTS_ROOT` overrides the live `~/.claude/projects`:

```
CLAUDE_PROJECTS_ROOT=fixtures/cc-2.1.234/projects \
  node spike/run.mjs --audit --project "<this repo's absolute path>" --all
```

## Privacy — read before making this repo public

These transcripts are **raw and unredacted**. They contain real file paths, real file contents pulled
into tool results, thinking blocks, and whatever else the sessions touched. They were deliberately
committed raw so that parser behavior is pinned to real bytes rather than to sanitized approximations
that would drift from reality.

The capture was scoped to this repo's *own* sessions (agent-deck building itself) to keep exposure
low. **That scoping is not absolute**, and Phase 5 sanitization must not assume it is:

- No PROJ-REDACTED or PROJ-REDACTED *session files* are committed, but their **content is**, in **four** committed
  data files (`git grep -l -E 'PROJ-REDACTED|PROJ-REDACTED' -- fixtures`):
  - `7dc3481d-….jsonl` — the main transcript, which embeds a full listing of every project slug
    under `~/.claude` plus absolute session paths
  - `agent-a56d2cc00c4b5908d.jsonl` — audit output naming PROJ-REDACTED/PROJ-REDACTED agents ("P1 database runner")
    and their tool_use ids
  - `agent-a68c75d33e3d38b01.jsonl` — PROJ-REDACTED audit commands and console output
  - `phase0-evidence/real-hook-events.jsonl`
- `phase0-evidence/real-hook-events.jsonl` is the highest-exposure file: **170 verbatim `tool_input`
  payloads** (largest ~9.6 KB) including full file contents from `Write` calls — among them earlier
  verbatim drafts of `PHASE0-VERDICT.md` itself.

**Not present, and needed:** no committed fixture contains a `tool-results/` directory, a malformed
line, a corrupt `.meta.json`, an `UNRESOLVED` case, or a mid-file CC version change. Phase 1's DoD
requires tests for several of those, so it must capture or synthesize them before it can pin
behavior under G6.

**PLAN.md Phase 5 carries a blocking open question:** before the repo goes public, these fixtures must
be sanitized in place *and* scrubbed from git history (`git filter-repo`), or replaced with sanitized
equivalents and the parser suite re-pinned. Committing them raw is safe only while the repo has no
remote — which is the case today (`git remote -v` is empty).
