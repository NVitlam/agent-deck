# History scrub — Phase 1 DoD evidence

Executed 2026-08-19 with `git filter-repo` 2.47.0 (`pip install git-filter-repo`; not previously
present on this machine). Pre-scrub backup: a `git bundle --all` of every ref plus the ref SHAs,
kept **outside** the repo — it contains the raw content and must never be committed.

## What was removed

Surface re-measured before executing: **13 files**, not the 11 the DoD listed. The original wording
counted "4 data files under `fixtures/` and 7 outside it" and skipped the two documents *inside*
`fixtures/` that reproduced the same strings.

**Removed from history by path (4 data files, plus the orphaned remainder of their session):**

- the Phase 0 orchestrator session's main transcript
- its entire `subagents/` directory — 5 transcripts + 5 sidecars. Two carried foreign content; the
  other three were clean but would have been left parentless, which the auditor reports as
  `UNRESOLVED` and reads as a parser bug rather than a deleted file.
- `fixtures/phase0-evidence/real-hook-events.jsonl` — 181 events, 170 verbatim `tool_input`
  payloads, an embedded email address from captured `git show` output

**Sanitized in place, then `--replace-text` across all history as a backstop (9 documents):**
`fixtures/README.md`, `fixtures/PHASE0-VERDICT.md`, `CLAUDE.md`, `HANDOVER.md`, `PLAN.md`,
`docs/PLAN-v1.md`, and the four `.claude/agent-memory/phase-verifier/*.md` files.

`--replace-message` ran with the same map: 7 of the 10 commit messages named purged projects too.

Two passes were needed. In the first, literal replacements appear to be applied before regex ones
regardless of file order, so a rule anchored as `ReaPBoard,\s+Prompter` never matched — its anchor
had already been rewritten. One name survived in 2 places; a second pass anchored on the redaction
marker removed it. **Lesson for any future scrub: do not anchor a regex on a string that another
rule in the same map replaces.**

## Verification

All refs (`main`, `master`, `phase-0-tap-validation`) rewritten; 10 commits, all re-hashed except
the root.

```
$ git log -p --all | grep -ao 'projects-[A-Za-z0-9_-]*' | sort | uniq -c
     12 projects-
      2 projects-PROJ-REDACTED
     11 projects-agent-deck
```

**Note the `-a`, and do not drop it.** The counts above are from the scrub commit. Re-running this
later without `-a` prints `Binary file (standard input) matches` and almost nothing else: a tracked
test file (`src/parser/parse.test.ts`) deliberately contains a NUL byte as fuzz input, and GNU grep
abandons the whole stream on seeing it. The result looks clean and means nothing. Counts grow as
history grows — what matters is that every token is `agent-deck`, the redaction marker, or the bare
prose glob.

Every project slug appearing anywhere in history is agent-deck, the redaction marker, or the literal
glob `projects-*` in prose.

```
$ git log --all --pretty=format: --name-only | sort -u | grep -E '7dc3481d|real-hook-events'
(no output)
```

A name-based sweep for all 19 purged project names and the 2 foreign session UUIDs returned **0**
across `git log -p --all`. That command is deliberately **not** reproduced here: writing the names
into a tracked file to test for them is the leak itself, and would make the check permanently
non-zero. It was run once from the shell with the names passed on the command line.

Note the DoD's original check `grep -cE '…(?!agent-deck)'` cannot work as written — a negative
lookahead is PCRE, so it needs `-P`, and `grep -P` refuses to run in this Git Bash's unset locale
(`LANG=`). The `grep -o | sort | uniq -c` form above is portable, and it is better evidence anyway:
it shows what *is* present rather than asserting an absence.

## Replay after the scrub

```
$ CLAUDE_PROJECTS_ROOT=fixtures/cc-2.1.234/projects \
    node spike/run.mjs --audit --project "<repo abs path>" --all
sessions scanned: 1  transcripts: 2  jsonl lines: 51  malformed skipped: 0
  RESOLVED    agent-a5e718f3cb731b607  [Explore] "List contents of spike/"  depth meta=1 computed=1
TOTALS
  RESOLVED : 1   AMBIGUOUS : 0   UNRESOLVED : 0
  spawnDepth mismatches: 0   malformed lines skipped: 0
  VERDICT: DETERMINISTIC (100% resolved)
```

Deterministic on what survived, but that set no longer covered depth ≥ 2, multiple concurrent
subagents, or `tool-results/`. **Coverage has since been restored** by the `05c5482d-…` harvest —
see `README.md`; the replay now reports `RESOLVED 5, AMBIGUOUS 0, UNRESOLVED 0`.

## Still true after the scrub

The remote history is only clean once the rewritten refs are force-pushed. Until then
`https://github.com/dev/agent-deck` (private) holds the pre-scrub objects, and GitHub keeps
unreferenced objects reachable for a while after a force-push besides. **Do not make the repo public
on the strength of this document alone** — re-run the audit against the remote first.
