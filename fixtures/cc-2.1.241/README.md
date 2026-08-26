# `fixtures/cc-2.1.241/` — a Claude Code session on a local model

**Found, not manufactured.** This is a real session this repository's author ran against a local
GGUF model through an OpenAI-compatible endpoint, three days before it became a fixture. It is here
for one reason: it is the corpus that proves the parser refuses on the *version string* and on
nothing else — a session whose `model` is not an Anthropic model id at all reads exactly like every
other session once the version is in range.

## Provenance

| | |
|---|---|
| Claude Code version | **2.1.241** — `version` on all 86 versioned lines |
| Captured | 2026-08-25 06:53 local (the session's own mtime); copied into `fixtures/` 2026-08-26 |
| Machine | <DEV_MACHINE>, Windows 11 native |
| Repo state | `gitBranch` is `main` throughout; every `cwd` is this repository |
| Session id | `6082be25-cfea-49b9-9821-2de9c23cac65` |
| Model | `C:\AI <LOCAL_MODEL>` — an **absolute local filesystem path**, not a provider model id |
| Recipe | none. This is an ordinary working session, kept because of what it happens to contain |

**The endpoint is not recoverable from the capture, and that is a property of the fixture.** No
`ANTHROPIC_BASE_URL`, no `OPENAI_*` key and no `http://127.0.0.1:<port>` endpoint appears anywhere in
the transcript, in `~/.claude/settings.json`, in `~/.claude/settings.local.json`, in `~/.claude.json`
or in this repo's `.claude/settings.local.json`. The OpenAI-compatible endpoint was supplied through
process environment at launch. A reader of these bytes can tell *which* model answered and cannot
tell *how* it was reached — do not add a claim about the configuration to this file later; it was
looked for and it is not there.

## Contents

```
projects/c--Users-dev-projects-agent-deck/
  6082be25-….jsonl                                 main transcript
  6082be25-…/auto-mode-classifier-error.txt        an unrecognised file inside the session directory
```

| File | Bytes | Lines |
|---|---|---|
| `6082be25-….jsonl` | 429,467 | 121 |
| `6082be25-…/auto-mode-classifier-error.txt` | 120,453 | 322 |

There is **no `subagents/` directory and no `tool-results/` directory.** The session spawned nothing:
`"isSidechain":true` occurs 0 times and `"name":"Agent"` occurs 0 times. The tools it used were
`Read` ×11, `Bash` ×6, `Glob` ×2, `Grep` ×2.

## What it measures

**It parses, in full.** 121 lines, **0 malformed**, layout accepted, and the session directory's one
unrecognised file lands in `ignored` rather than in a mismatch. Nothing about a non-Anthropic `model`
value is consulted by the fingerprint, and nothing about it could be: `model` is a free-form string
in every corpus here.

**Entry-type census** (121 lines): `assistant` 37, `user` 28, `attachment` 19, `ai-title` 9,
`atis-latch` 9, `last-prompt` 9, `queue-operation` 6, `file-history-snapshot` 2, `system` 2.

**Two entry types the line parser does not know**, and both are tolerated the same way — counted as
`unknownType` and skipped, one line each, never a session-level refusal:

| Unknown `type` | Lines |
|---|---|
| `atis-latch` | 9 |
| `system` | 2 |

**Field drift in both directions against `cc-2.1.234/` and `cc-2.1.246/`:**

| Key | Here (`2.1.241`) | `cc-2.1.246/` |
|---|---|---|
| `atis` (top-level string) | **present**, 9 lines | present, 1 line |
| `requestId` (top-level string) | **absent**, 0 lines | present, 3 lines |
| `message.diagnostics` | **absent**, 0 lines | present, 3 lines |

None of the three is required by anything, so the pair of corpora disagree about a field in both
directions and both still parse. That is the whole point of keeping this one.

**Both Windows drive-letter casings occur inside this single file** — the `cwd` values are the same
path written 61 times with an upper-case `C:` and 25 times with a lower-case `c:`. The recorded
case-insensitive-slug trap, on real data rather than on a synthetic row.

## What it does **not** cover

It cannot exercise the subagent join at all — no subagents, no sidecars, no `parentAgentId`, no
`spawnDepth`. It pins the **flat** case only. Everything about attribution stays pinned by
`cc-2.1.234/` and `cc-2.1.246/`.

## Privacy

Checked before commit, on these exact bytes: the only `projects\<project>` token in either file is
`agent-deck` (135 hits), the only distinct `cwd` values are this repository in its two drive-letter
casings, `gitBranch` is `main` throughout, zero NUL bytes, and zero hits for `sk-…`, `ghp_…` or a
quoted `api_key` / `access_token` / `refresh_token` / `client_secret` / `password` value. G8 holds.

The `model` value is an absolute path on this machine (`C:\AI Models\…`) and is kept verbatim — it is
the value under test, and a normalised one would pin nothing. Same class as every other absolute path
in `fixtures/`. `scripts/privacy-sweep.mjs` enrols this corpus under the allow rule
`capture-cc-2.1.241`.

An earlier attempt to commit this session (2026-08-26, recorded in `docs/evidence/opencode/RECON.md`
§B5) was removed rather than kept, because the sweep failed it: the corpus had no allow rule, so its
539 own-path hits were `UNEXPECTED` by construction while `secrets=0` and `foreign=0`. The rule added
alongside this commit is the fix, and the first sweep run in that attempt is worth remembering for a
different reason — it printed a clean `PASS` over files that were merely copied in and never `git
add`ed, because the sweep reads `git ls-files`. **Stage a capture before sweeping it, or the run says
nothing.**

## Replay

```console
CLAUDE_PROJECTS_ROOT=fixtures/cc-2.1.241/projects \
  node spike/run.mjs --audit --project "<this repo's absolute path>" --all
```
