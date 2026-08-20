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

hook-events/
  cc-2.1.234-redacted.jsonl            285 real hook payloads, content destroyed, key
                                       presence/absence preserved exactly (Phase 2)
  cc-2.1.234-sessionstart.jsonl        2 SessionStart events — the R3 onset proof, captured
                                       with the listener bound BEFORE a fresh session opened
  redact-capture.mjs                   derives both from a gitignored raw capture (--only filters)
golden/graft/                          2 grafted-tree goldens + regeneration README
golden/session/                        2 SessionState goldens + regeneration README

synthetic-layout/                      22 hand-mutated trees the fingerprint must refuse,
                                       incl. two carrying a <slug>/memory/ directory
synthetic-lines/                       8 malformed / drift line cases for the parser
synthetic-graft/                       7 join cases: unresolved, ambiguous, depth mismatch
```

Everything under `synthetic-*` is **hand-made, not captured**. Each tree says so in its slug
directory name (`SYNTHETIC-hand-mutated-not-captured`) and each corpus has its own README with a
per-case expectation table. Never treat them as evidence about CC's real behavior (G6).

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

**Read the list above as history, not inventory.** It describes the exposure the Phase 1 scrub
*removed*; those four data files are gone from every ref. `phase0-evidence/real-hook-events.jsonl` in
particular is **not** committed — do not go looking for it, and do not cite it as present.

### Phase 2 addition: `hook-events/` (read this before the public flip)

Two committed captures live here: `cc-2.1.234-redacted.jsonl` (285 events, the main liveness fixture)
and `cc-2.1.234-sessionstart.jsonl` (2 events, the R3 onset proof). **Both** carry the retention
described below; the second is small but is not more anonymous for it — each of its 2 lines holds a
real `session_id` and a real absolute `transcript_path` and `cwd`.

`hook-events/cc-2.1.234-redacted.jsonl` is new in Phase 2 and is **deliberately not fully anonymous.**
Content values are destroyed, but these are kept verbatim, because a fixture without them cannot test
what it exists to test:

- `cwd` and `transcript_path` — absolute paths containing `C:\Users\dev\…`, including worktree paths
  (backslash-separated; a sweep that greps a forward-slash or backslash-stripped form finds nothing).
- `session_id`, `agent_id`, `prompt_id` — real ids from this repo's own sessions.

This is the same exposure class the committed transcripts under `cc-2.1.234/` already carry (their
slug directory is literally `c--Users-dev-projects-agent-deck`), so it adds no
*new* category — but Phase 5's privacy sweep must cover `hook-events/` explicitly rather than
assuming "redacted" in the filename means anonymous. It does not. It means content-free.

**Coverage, re-stated after Phase 1.** The gaps this section used to list are closed. A
`tool-results/` directory, malformed lines, a corrupt `.meta.json`, and an `UNRESOLVED` join case all
exist now — the first from the capture, the rest from the clearly-labelled `synthetic-*` corpora
above. `<slug>/memory/` **is now fixtured too**, as a side effect of the layout corpus:
`synthetic-layout/00-valid-control/…/memory/` and `synthetic-layout/15-no-session-transcripts/…/memory/`.
The second is the strong form — a slug directory holding `memory/` and no session transcript at all.
Phase 2's DoD asks for exactly this fixture; it already exists, so do not go capturing one.

The trap itself still matters: a discovery routine that enumerates subdirectories of the slug dir
mistakes `memory/` for a session. Both `spike/tail.mjs` and `src/parser/tailer.ts` are immune because
they find sessions from `<sessionId>.jsonl` **files** and only then look for the matching directory.
Keep that ordering; "improving" it to a directory scan is the regression.

A mid-file CC version change is also absent, and stays absent **by design** — G9 pins one CC version,
so drift is a `SchemaMismatch`, not a case to cover. Do not add a drift fixture.

## Privacy — status after the Phase 1 scrub

The history scrub described in `SCRUB-EVIDENCE.md` **has been executed and force-pushed**: the
contaminated data files are gone from every ref, the documents that reproduced the purged strings were
sanitized, and no foreign project slug survives anywhere in `git log -p --all`. Every `cwd` in every
committed fixture is this repo (G8).

`origin` = `https://github.com/dev/agent-deck`, **private**. Two things remain true and gate any
public flip:

- GitHub keeps unreferenced objects reachable for a while after a force-push, so the remote is not
  provably clean the instant the rewrite lands. Re-audit against the remote before flipping, rather
  than trusting this file.
- `fixtures/phase0-evidence/latency-*.log` still contain the session and agent ids of the purged
  session. That content is agent-deck's own and carries no foreign data, so it was left in place —
  but it means "the contaminated files are gone" is true of *paths*, not of every string that ever
  appeared in them.

The fixtures are still committed **raw and unredacted by deliberate choice** (G6 pins parser behavior
to real bytes). They contain this repo's own file paths, tool output, and transcript content.
