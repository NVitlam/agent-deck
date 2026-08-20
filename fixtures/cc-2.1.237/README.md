# CC 2.1.237 — a content-destroyed capture, plus a layout audit

Captured **2026-08-20** from Claude Code **2.1.237**, Windows 11 native, from this repo's own
sessions only (G8). Added for Phase 4 package P4-F, which replaced the single version pin with an
acceptance window.

**Read this before using anything here.** Two different kinds of evidence live in this directory and
they are not interchangeable:

| | what it is | what it can prove |
|---|---|---|
| `projects/…/b6a49a92-….jsonl` | a real 2.1.237 transcript, **content destroyed** | entry shapes, record types, required fields, the version string |
| this file's "Layout audit" section | **measurements**, not files | that the subagent sidecar layout still holds on 2.1.237 |

Nothing here is hand-made, so nothing here is named `synthetic-`. But the transcript is **not raw**,
unlike `fixtures/cc-2.1.234/`, and the layout audit is **not a fixture** — no subagent transcript,
sidecar, or `tool-results/` file from a 2.1.237 session is committed anywhere in this repo.

## What was captured

```
projects/c--Users-dev-projects-agent-deck/
  b6a49a92-ac05-4383-ae9c-68d433845c5f.jsonl    one complete main transcript, redacted
redact-transcript.mjs                           the derivation, re-runnable
```

Source: `~/.claude/projects/c--Users-dev-projects-agent-deck/b6a49a92-ac05-4383-ae9c-68d433845c5f.jsonl`,
a short 2.1.237 session in this workspace with no subagents. Reproduce with:

```
node fixtures/cc-2.1.237/redact-transcript.mjs \
  --in  "<live projects root>/c--Users-…-agent-deck/b6a49a92-ac05-4383-ae9c-68d433845c5f.jsonl" \
  --out fixtures/cc-2.1.237/projects/c--Users-…-agent-deck/b6a49a92-ac05-4383-ae9c-68d433845c5f.jsonl
```

Every entry of the source survived; none was dropped or reordered, and none was invented.

### What was destroyed

The redaction is a **whitelist** (see the script's header for the exact sets). Every top-level *key*
survives, so "which fields does 2.1.237 emit" stays pinned; a value whose key is not on the
whitelist is replaced by a type marker — `"<redacted>"`, `0`, `false`, `["<redacted>"]`,
`{"redacted":"object"}` — **without recursing**, because a value the whitelist does not name may
carry file content, and file content can contribute object *keys* as well as values.

Destroyed: all message text, all `thinking` blocks **and their `signature`s**, all tool inputs, all
tool results, `attachment`, `toolUseResult`, `snapshot`, `lastPrompt`, `atis`, `origin`,
`stop_details`, `diagnostics`, and every non-numeric field of `usage`.

### What was deliberately kept verbatim

`sessionId`, `uuid`, `parentUuid`, `requestId`, `messageId`, `leafUuid`, `promptId`,
`sourceToolAssistantUUID`, tool-use ids (`toolu_…`), `cwd`, `gitBranch`, `timestamp`, `version`,
`type`, `isSidechain`, `userType`, `entrypoint`, `permissionMode`, `promptSource`, `operation`,
`effort`, `message.role`, `message.model`, `message.id`, `message.stop_reason`, content-block `type`
and tool `name`, and the numeric fields of `usage`.

This is the same trade `fixtures/hook-events/` makes and the **same exposure class**: this repo's own
absolute paths and ids. It adds no new category. Like that directory, **"redacted" here means
content-free, not anonymous** — the `cwd` values are `C:\Users\dev\…`, backslash-separated, so a
privacy sweep greping a forward-slash form finds nothing. A Phase 5 sweep must cover this directory
explicitly.

Verified after redaction: the longest surviving string in the file is the 55-character `cwd`, and
every string under a non-whitelisted key is a marker.

## Layout audit — measured, NOT committed

The undocumented sidecar convention still holds on 2.1.237. This was verified by listing the live
session directories, **not** by committing them: the two 2.1.237 sessions that have subagents are
long working sessions and copying even a redacted form of them would add roughly a megabyte to pin a
directory-naming rule.

Measured 2026-08-20 against the live projects root, sessions `610605a2-…` and `60b4b911-…`:

| | `610605a2-…` | `60b4b911-…` |
|---|---|---|
| session-dir entries | `subagents`, `tool-results` | `subagents`, `tool-results` |
| `subagents/agent-<id>.jsonl` | 18 | 10 |
| `subagents/agent-<id>.meta.json` | 18 | 10 |
| unpaired ids | 0 | 0 |
| filenames not matching the convention | 0 | 0 |
| `tool-results/` files | 10 | 7 |
| `spawnDepth` histogram | 1×15, 2×3 | 1×10 |
| `toolUseId` values matching `toolu_…` | 18/18 | 10/10 |

All four required sidecar join keys (`agentType`, `description`, `toolUseId`, `spawnDepth`) are
present on all 28 sidecars, and every depth-2 sidecar carries `parentAgentId`. Two **new optional**
sidecar keys appear on 2.1.237 that the 2.1.234 capture does not have: `model` (10/10 on
`60b4b911-…`, 0/18 on `610605a2-…`) and the worktree trio `worktreePath` / `spawnedWithWorktree` /
`worktreeBranch` (present on some sidecars in both sessions). Unknown sidecar keys are preserved and
never rejected, so these change nothing — but do not let a future capture treat `model` as required.

`610605a2-…` was **live and being appended while it was measured** — it is the session that did this
work. Its counts are a snapshot, not a constant.

## Schema delta 2.1.234 -> 2.1.237

Measured over whole sessions (main transcripts plus every subagent transcript), 2.1.234 session
`84bc9872-…` against the four 2.1.237 sessions:

- **47 top-level keys shared.** Only in 2.1.234: `toolDenialKind`. Only in 2.1.237: `apiErrorStatus`,
  `atis`, `error`, `isApiErrorMessage`, `mode`, `quotaLimits`, `turnCompanion`.
- **Two new record types**: `atis-latch` and `mode`. Both are unknown to the fingerprint's per-type
  requirement table, which requires only `type` of an unrecognised record kind — so they are
  tolerated rather than refused. That tolerance was already there; 2.1.237 is the first thing to
  exercise it on real data.
- **No required field went missing.** 6,615 2.1.237 entries were read; 6,488 of them are of the six
  record types the requirement table knows (`user` 2,277, `assistant` 3,709, `attachment` 309,
  `queue-operation` 88, `last-prompt` 91, `file-history-snapshot` 14). Every field the fingerprint
  requires was present on 100% of the lines of its type — zero missing, of any field, on any line.
  The remaining 127 (`atis-latch` 90, `system` 20, `mode` 14, `file-history-delta` 3) are
  unrecognised record kinds and only need `type`.

## What this capture does NOT cover

- **Subagent attribution on 2.1.237.** No sidecar or subagent transcript is committed here. The join
  is pinned by `fixtures/cc-2.1.234/` and by the audit above, not by a 2.1.237 fixture.
- **Parser content behaviour.** Redaction destroyed the content, so nothing here can pin truncation,
  preview text, or tool-result hydration. Use `fixtures/cc-2.1.234/`, which is committed raw for
  exactly that reason.
- **Byte offsets.** The committed file is a re-serialisation, not the captured bytes. Tailer
  offset tests must keep using the raw 2.1.234 capture.
