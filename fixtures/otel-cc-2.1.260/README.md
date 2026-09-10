# `otel-cc-2.1.260` — the TELEMETRY corpus

Captured 2026-09-05 for v0.7.0 Phase 0b, DoD 0b.6. Real Claude Code OpenTelemetry exhaust, received
on a loopback OTLP/HTTP-JSON endpoint, captured raw and then redacted. G6 applies to it exactly as it
applies to every other corpus here.

**Why it exists.** Phase 0 measured fact **F9 — cost** as `UNAVAILABLE` on all three engines: no
captured OpenCode session carries a non-zero `session.cost`, and neither Claude Code nor Codex states
a cost in its transcript at all. Claude Code's telemetry exporter states one. This corpus is the
evidence for whether that number is real, reaches a loopback endpoint over a transport we can decode
without a dependency, and joins to the session model we already build.

**It is not a transcript corpus and it does not replace one.** It carries no message text, no tool
input and no tool output. It is the *other* tap on the same sessions.

## Provenance

| | |
|---|---|
| captured | 2026-09-05, this machine, Windows 11 native |
| receiver | `lab/spike/otel/listener.mjs`, `127.0.0.1:4318`, OTLP over **`http/json`** |
| enabled by | a user paste into `~/.claude/settings.json` — the extension never writes it (G1) |
| window | `2026-09-05T16:54:15.518Z` .. `2026-09-05T17:51:19.231Z` |
| records | **850** — metrics 316, logs 359, traces 175 |
| envelopes | metrics 77, logs 74, traces 43 |

Two sessions, and **they ran different Claude Code versions**:

| | session | started from | CC version | records | tool_use in transcript |
|---|---|---|---|---|---|
| **A** | `8c1910bb-9e45-40a3-ad0d-982df98ed71b` | terminal | **`2.1.251`** | 608 | 32 |
| **B** | `f7f0eef9-8100-4891-963b-79f25326014c` | VS Code panel | **`2.1.260`** | 242 | 9, across 3 files |

**The directory is named for the higher version, and that is a naming decision rather than a
measurement.** `service.version` and the instrumentation scope version are per session, not per
capture; a single number for this corpus would be whichever record happened to be read first.
`fixtures/cc-2.1.260/` already sets the precedent — it spans `2.1.258` → `2.1.260` inside one file and
is named for the higher. Read the version off the record, never off this directory's name.

**Session A did not run the scripted prompt.** The plan's script was one prompt spawning two
subagents plus an `Edit` and a `Bash`. Session B did exactly that — `Agent` ×2, `Bash` ×3, two
subagent sidecars. Session A is a real terminal session that ran `Bash` ×25, `Write` ×4 and `Edit` ×3
and spawned **no subagents at all**. So subagent attribution through telemetry — `agent.name`,
`query_source: "subagent"`, the `agent_id` span attribute — is witnessed by **one** session here, not
two. Everything else is witnessed by both.

## The upstream panel-mode report did not reproduce

An open upstream issue reports that Claude Code started from the VS Code panel exports nothing.
On **CC 2.1.260, Windows native**, it exported **all three signals** — 242 records, including the cost
metric, tool spans and both subagent joins. Recorded as a measurement on this version and this
platform, not as a refutation of the report in general.

## What was redacted

Claude Code attaches **five** identity attributes to every metric point, log record and span. All
five are replaced, in every record, by a placeholder of the **same shape** — so the corpus still
witnesses what Claude Code sends, while carrying none of the account behind it.

| attribute | occurrences replaced | placeholder |
|---|---|---|
| `user.email` | 850 | `redacted@example.invalid` |
| `user.id` | 850 | 64 × `0` |
| `user.account_id` | 850 | `user_` + 26 × `0` |
| `user.account_uuid` | 850 | `00000000-0000-0000-0000-000000000000` |
| `organization.id` | 850 | `00000000-0000-0000-0000-000000000001` |

850 of each, against 850 records: exactly one per record, and the three numbers are measured
independently — by `census.mjs` walking the structure, by `redact.mjs` counting substitutions, and by
the privacy sweep's own rules counting hits on the raw capture.

**The plan's locked list named four of these.** `user.account_id` is a fifth, in a different format
from `user.account_uuid`, so a rule for the uuid does not cover it. Corrected against the raw capture
before anything was committed.

**The email was the only free text.** Measured across the raw capture: the email local part
appeared exactly 850 times — once per record — and nothing else identifying appeared at all: no path,
no home directory, no machine name, no project slug. The other four attributes are opaque ids.

(The first draft of this paragraph quoted the local part verbatim while explaining that it had been
redacted, and the privacy sweep failed the gate on this very line. Recorded rather than tidied away:
prose about a redaction is inside the swept corpus, exactly like the data.)

`scripts/privacy-sweep.mjs` carries one rule per attribute (`otel-user-email`, `otel-user-id`,
`otel-user-account-id`, `otel-user-account-uuid`, `otel-organization-id`). Each allows exactly its
placeholder and fails the gate on anything else. Proved in both directions: 850 hits per rule on the
raw capture, 0 on this corpus, and a single non-placeholder value planted into `metrics.jsonl` takes
the sweep to `VERDICT FAIL telemetry=1`, exit 1.

## What was NOT redacted, and why

`prompt`, `response` and `user_prompt` arrive from Claude Code already carrying the **literal string
`"<REDACTED>"`** — one distinct value each across the whole capture. They are kept exactly as
received. Redacting a redaction would destroy the evidence that the exporter redacts by default,
which is the property that makes this tap safe to receive at all. `OTEL_LOG_USER_PROMPTS`,
`OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS` and `OTEL_LOG_RAW_API_BODIES` were all unset,
and must stay unset — each one puts real text on the wire.

## The raw capture is gone

`lab/spike/otel/capture/` was deleted after this corpus was written, per DoD 0b.6. It was gitignored
and never committed to either repository. Each line here carries `sha256Captured`, the digest of the
body **as received**, so this corpus is provably derived from those bytes without retaining them.

## File format

One JSON object per line, one line per HTTP request the exporter made:

```
{"receivedAt":"<ISO>","signal":"metrics|logs|traces","redacted":true,
 "sha256Captured":"<digest of the body as received>","sha256":"<digest after redaction>",
 "bodyBytes":<n>,"raw":"<the OTLP JSON body, as a string>"}
```

`raw` is a **string**, not a nested object, deliberately: it is exactly the body an HTTP receiver is
handed, so a future receiver test replays the real thing rather than a re-serialisation of it.

That shape has one consequence worth stating, because it already caused a defect: inside the file the
body's quotes are backslash-escaped, so a scanner written against unescaped OTLP JSON matches
**nothing here, silently**. The sweep's five rules tolerate both forms. The negative control is what
caught it — all five rules read as silent on raw data carrying the real account identity while the
sweep reported a clean pass.

## What is in it

**Metrics** (7 distinct, all `aggregationTemporality: 1`, all sums):

| metric | points | unit |
|---|---|---|
| `claude_code.token.usage` | 184 | `tokens` |
| `claude_code.active_time.total` | 65 | `s` |
| `claude_code.cost.usage` | 46 | **`USD`** |
| `claude_code.lines_of_code.count` | 12 | |
| `claude_code.code_edit_tool.decision` | 6 | |
| `claude_code.session.count` | 2 | |
| `claude_code.commit.count` | 1 | |

**Events** (11 distinct): `hook_execution_complete` 92, `hook_execution_start` 92, `api_request` 50,
`tool_decision` 40, `tool_result` 40, `assistant_response` 19, `hook_registered` 12,
`mcp_server_connection` 5, `user_prompt` 5, `retention_sweep` 2, `subagent_completed` 2 — each
prefixed `claude_code.`.

**Spans** (5 distinct): `llm_request` 50, `tool` 40, `tool.blocked_on_user` 40, `tool.execution` 40,
`interaction` 5.

## The joins it witnesses

- `session.id` is present on **every one of the 850 records** and equals the transcript's JSONL
  basename for both sessions.
- `tool_use_id` on `claude_code.tool_result` events and `claude_code.tool` spans is the **same
  primary key** the transcript's `tool_use` blocks carry. Session B: **9 of 9**, including **4 inside
  subagent sidecars**. Session A: **31 of 32**.
- `agent_id` on `claude_code.tool` spans equals the **subagent sidecar basenames** exactly
  (`a1a5974ab0c190c1d`, `aa713c91118df7bea`).
- Every one of the 50 `api_request` events carries `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `cost_usd_micros` and `duration_ms`.
- All 40 `claude_code.tool` spans carry `duration_ms`, a start and an end, and a `tool_use_id`.

**The one unmatched tool in session A is explained and is not a defect.** `toolu_01AbDNECE12Dz5RCYmmyxWMZ`
is ordinal 14 of 32, a `Bash` that was **rejected by input validation before it executed**
(`InputValidationError: command contains control characters`). The transcript records the attempt and
its error; telemetry records tools that *ran*. Any consumer of this tap must treat an unmatched
`ToolNode` as ordinary, not as an error.

`docs/evidence/phase-0b-otel/VERDICT.md` in the private repository carries the full census and the
decision. `census.json` beside it is the machine-readable form.
