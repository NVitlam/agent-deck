# `fixtures/cc-2.1.246/` — the provenance anchor

**This is the corpus `PINNED_CC_VERSION` names.** It is the version whose structure the
fingerprint's required-key assertions are proved against; see the dated section
"Amendment 2026-08-26 — Version posture" in `agent-deck-spec.md` for what the anchor does and does
not claim. Captured raw and unredacted, like every other real capture here (G6).

## Provenance

| | |
|---|---|
| Claude Code version | **2.1.246** — `claude --version` prints `2.1.246 (Claude Code)` |
| Which `claude` | `~/.vscode/extensions/anthropic.claude-code-2.1.246-win32-x64/resources/native-binary/claude.exe`. **Not** the `claude` on `PATH`, which is a stale npm global whose native binary is not even installed on this machine |
| Captured | 2026-08-26, 07:55–07:56 UTC (10:55–10:56 local, UTC+3) |
| Machine | <DEV_MACHINE>, Windows 11 native |
| Repo state | branch `hotfix/0.1.2` at the spec-amendment commit; `gitBranch` in every entry reads `hotfix/0.1.2` |
| Model | `claude-opus-5` (first-party), both threads |
| Recipe | **R1 mirror pair** — agent A tails the live session, agent B performs a scripted burst |
| Session id | `07e6c820-b285-4ea8-8127-98ea762291d9` (fixed with `--session-id`, so the harvest could not pick up the wrong file) |

## The recipe, exactly as run

```console
claude.exe -p \
  --session-id 07e6c820-b285-4ea8-8127-98ea762291d9 \
  --allowedTools "Read" "Grep" "Glob" "Write" "Task" "Agent" "Bash(git log:*)" \
  --add-dir "C:\Users\dev\AppData\Local\Temp" \
  --output-format json  < r1-prompt.txt
```

The prompt instructed the main thread to make **exactly one** subagent call and then stop. Agent B
(`agentType: general-purpose`, `description: r1-mirror-b`) was given six tool calls to perform in
order and nothing else:

1. `Read` — `README.md`, limit 20 lines
2. `Grep` — pattern `PINNED_CC_VERSION`, whole repository
3. `Glob` — `src/parser/*.ts`
4. `Bash` — `git log -1 --oneline`
5. `Write` — `C:\Users\dev\AppData\Local\Temp\agent-deck-r1-capture.txt`
6. `Read` — that same file back

**Agent A's check (the mirror half).** The tail observed the main transcript reach 16 lines and the
`<sessionId>/subagents/` directory appear while the run was in flight, and the harvested bytes were
then read back against B's known script: the subagent transcript carries `tool_use` blocks
`Read, Grep, Glob, Bash, Write, Read` — six calls, in the scripted order, no extras. The main
transcript carries exactly one `tool_use`, named **`Agent`** (not `Task`), which is the same spawning
tool name measured on 2.1.234.

The one scratch file the recipe writes lives outside the repository (`%TEMP%`) and is not part of
this corpus.

## Contents

```
head-5.jsonl                                              first 5 lines of the main transcript
projects/c--Users-dev-projects-agent-deck/
  07e6c820-….jsonl                                        main transcript
  07e6c820-…/subagents/agent-a676c705dca135e9d.jsonl      agent B's transcript
  07e6c820-…/subagents/agent-a676c705dca135e9d.meta.json  the join sidecar
```

| File | Bytes | Lines |
|---|---|---|
| `head-5.jsonl` | 7,943 | 5 |
| `07e6c820-….jsonl` | 30,012 | 16 |
| `…/subagents/agent-a676c705dca135e9d.jsonl` | 31,703 | 17 |
| `…/subagents/agent-a676c705dca135e9d.meta.json` | 119 | whole-file JSON, no trailing newline |

`head-5.jsonl` is the **first five lines of the main transcript only**, kept beside the corpus so
the version-string path can be asserted on a file small enough to read in a diff. It is a copy, not
a separate capture, and it is not inside `projects/` — it is not a session and must never be
discovered as one.

## What it measures

**Entry-type census** — main transcript (16 lines, 0 malformed): `attachment` 6, `assistant` 3,
`user` 2, `queue-operation` 2, `atis-latch` 1, `file-history-snapshot` 1, `last-prompt` 1.
Subagent transcript (17 lines, 0 malformed): `assistant` 8, `user` 7, `attachment` 2.

**`version`** is `2.1.246` on every line that carries one — 11 of 16 in the main transcript, 17 of
17 in the subagent's. No mid-file drift.

**The sidecar, verbatim:**

```json
{"agentType":"general-purpose","description":"r1-mirror-b","toolUseId":"toolu_01UDHVquGaAwLm2mAk3nvoQi","spawnDepth":1}
```

All four `REQUIRED_META_FIELDS` present. `toolUseId` names the `tool_use` block in the main
transcript, so attribution here is the primary-key join, not an inference. `parentAgentId` is
absent, which is the rule for `spawnDepth: 1`.

**`atis-latch` is a real 2.1.246 entry type**, and `atis` is a real 2.1.246 top-level field — both
first seen on 2.1.241 and both still here. The line parser does not know `atis-latch`, so it counts
it as `unknownType` and skips that one line; the fingerprint tolerates it, because an unrecognised
record kind is not a layout change. This is the tolerance the version posture rests on and it is
measured on the anchor itself, not only on the older corpus.

**`requestId` (3 lines) and `message.diagnostics` (3 lines) are present here and absent from
`cc-2.1.241/`.** Neither is required by anything; the pair exists so the two corpora disagree about
a field in both directions and both still parse.

## What it does **not** cover

- **No `tool-results/` offload.** Nothing agent B read was large enough to force it. The offload
  path stays pinned by `cc-2.1.234/…/tool-results/b6uvpgxa4.txt` (63,774 bytes).
- **No `spawnDepth: 2`.** One subagent, no nesting. Depth 2 with `parentAgentId` stays pinned by
  `cc-2.1.234/`.
- **No concurrency.** One spawn, sequential.
- **No hook events.** This corpus is the JSONL tap only; `fixtures/hook-events/` is the other tap.

Those gaps are deliberate. This capture exists to anchor the *structure* at 2.1.246, and the older
corpora keep covering the shapes a two-agent scripted burst cannot manufacture.

## Privacy

Checked before commit, on these exact bytes: the only `projects\<project>` token anywhere in the
corpus is `agent-deck` (32 hits across the four data files), the only distinct `cwd` is
`C:\Users\dev\projects\agent-deck`, `gitBranch` is `hotfix/0.1.2` throughout,
zero NUL bytes, and zero hits for `sk-…`, `ghp_…` or a quoted `api_key` / `access_token` /
`refresh_token` / `client_secret` / `password` value. G8 holds: nothing here was captured from any
project other than this one.

Like the rest of `fixtures/`, this is **raw and unredacted by deliberate choice** — it carries this
repo's own absolute paths, real session and agent ids, and real tool output. `scripts/privacy-sweep.mjs`
enrols it under the allow rule `capture-cc-2.1.246`; the sweep's `-> 0` applies to foreign content
and secrets, never to this developer's own paths inside a capture.

## Replay

```console
CLAUDE_PROJECTS_ROOT=fixtures/cc-2.1.246/projects \
  node spike/run.mjs --audit --project "<this repo's absolute path>" --all
```
