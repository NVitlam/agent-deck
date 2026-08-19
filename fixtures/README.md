# Fixtures

**These are real Claude Code session transcripts, captured raw.** Parser and stitcher behavior is
pinned to them (grounding contract G6): a new CC version means capturing new fixtures *before*
changing code.

## Contents

```
cc-2.1.234/projects/c--Users-dev-projects-agent-deck/
  05c5482d-….jsonl                     main transcript (Phase 1 harvest)
  05c5482d-…/subagents/agent-*.jsonl   4 subagent transcripts, one at spawnDepth 2
  05c5482d-…/subagents/agent-*.meta.json
  05c5482d-…/tool-results/b6uvpgxa4.txt  63,774-byte offloaded tool payload
  4299490e-….jsonl                     main transcript
  4299490e-…/subagents/agent-*.jsonl   1 subagent transcript
  4299490e-…/subagents/agent-*.meta.json
phase0-evidence/
  latency-*.log                        measured append→render latency samples
  synthetic-hook-events.jsonl          7 synthetic hook payloads (P0-2 evidence)
  hook-mechanism-timing.txt            node -e vs curl.exe cost with the listener down
PHASE0-VERDICT.md                      the Phase 0 gate decision, with evidence
SCRUB-EVIDENCE.md                      the Phase 1 history scrub, with verification output
```

The Phase 1 history scrub (see `SCRUB-EVIDENCE.md`) removed the Phase 0 orchestrator session and
`real-hook-events.jsonl` for carrying foreign-project content. The `05c5482d-…` session replaces
that coverage and was **manufactured, not found**: a fresh CC window in this workspace ran a scripted
burst that spawned three subagents in parallel, one of which spawned a child of its own, and one of
which produced an output large enough to force CC to offload it. That is why the set now has a
`spawnDepth: 2` agent carrying `parentAgentId`, and a `tool-results/` directory.

Privacy-checked before commit: zero hits for any foreign project name, the only `projects-*` token
present is `agent-deck`, and every `cwd` in every entry is this repo (G8).

**What it still does not cover:** a malformed line, a corrupt `.meta.json`, a missing join key, a
mutated layout, or a mid-file CC version change. The first four are supplied by the `synthetic-*`
corpus (G6 requires those be clearly labelled and never confused with captured data). The fifth is
**not covered by design** — G9 pins one CC version, so mid-file drift is a `SchemaMismatch`, not a
tolerated case.

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

**Scope of exposure — established by audit, after being understated twice.** It was never confined to the two
project names an earlier draft grepped for; that grep found the right files by luck, not by
construction:

- **Every project name under `~/.claude` was committed** — 16 sibling project slugs, a shared agents
  directory, and three temp benchmark directories, carried in by captured directory listings. The
  names are not reproduced here; removing them is the point of the scrub.
- **Four committed data files** under `fixtures/`: the main transcript `7dc3481d-….jsonl`,
  `agent-a56d2cc00c4b5908d.jsonl`, `agent-a68c75d33e3d38b01.jsonl`, and
  `phase0-evidence/real-hook-events.jsonl`. The full slug listing appears in **three** of them, not
  one — redacting file-by-file from a per-file description will under-redact.
- **Seven committed files OUTSIDE `fixtures/`** also carry project names, full session UUIDs, and (in
  the agent-memory files) the `~/.claude/settings.json` md5: `CLAUDE.md`, `PLAN.md`, `HANDOVER.md`,
  and `.claude/agent-memory/phase-verifier/*` (4 files). **The documents describing the leak
  reproduce it** — so any sanitization grep scoped to `-- fixtures` is wrong.
- `real-hook-events.jsonl` additionally embeds captured `git show` output containing the author's
  name and email address, and verbatim earlier drafts of `PHASE0-VERDICT.md`.
- **Clean on secrets:** a scan of all committed files for `sk-…`, `ghp_…`, `api_key`, `password` and
  `authorization` returned zero hits.

**Not present, and needed:** no committed fixture contains a `tool-results/` directory, a malformed
line, a corrupt `.meta.json`, an `UNRESOLVED` case, a mid-file CC version change, or a `<slug>/memory/`
directory. Phase 1's DoD requires tests for several of those, so it must capture or synthesize them
before it can pin behavior under G6.

Two notes for whoever does that capture:

- **A `tool-results/` fixture is now free.** agent-deck's own session grew one
  (`7dc3481d-…/tool-results/`) during the Phase 0 audit, so it can be captured without pulling in
  another project's data.
- **`<slug>/memory/` is a discovery trap.** It sits as a sibling of every `<sessionId>/` directory in
  the live tree and is absent here, so no fixture-backed test will catch a discovery routine that
  enumerates subdirectories of the slug dir and mistakes it for a session. The spike is immune
  because `spike/tail.mjs` finds sessions from `<sessionId>.jsonl` *files* and only then looks for the
  matching directory — keep that ordering in the production port.

**PLAN.md Phase 5 carries a blocking open question:** before the repo goes public, these fixtures must
be sanitized in place *and* scrubbed from git history (`git filter-repo`), or replaced with sanitized
equivalents and the parser suite re-pinned.

**As of 2026-08-19 this content is on a remote.** `origin` =
`https://github.com/dev/agent-deck`, **private**. Privacy now rests on that repo staying private
rather than on there being no remote at all, and the Phase 5 scrub must therefore also **force-push**
the rewritten history — the raw content exists in remote history from this point on. Do not flip the
repo public before that scrub.
