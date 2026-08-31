# `fixtures/opencode-*/golden.json` — the OpenCode goldens, and how they were derived

**PLAN v0.5.0 DoD 3.4.** The expected `SessionState` tree for each harvested OpenCode corpus,
generated **this once** through a documented procedure, because no parser exists yet.
`src/opencode/` is Phase 4's work and must reproduce these files **through the production path**.

Two files, one generator:

| File | Corpus | Bytes |
|---|---|---|
| `fixtures/opencode-1.18.22/golden.json` | the **anchor**, 24 session rows | 103,515 |
| `fixtures/opencode-1.18.21/golden.json` | the **witness**, 5 session rows | 35,882 |

```console
node scripts/opencode-golden.mjs            # regenerate both
node scripts/opencode-golden.mjs --check    # compare only; exit 1 if stale
```

---

## Which half is verified by hand, and which is not

**This is the first thing to read, because getting it backwards turns the golden into a second
implementation of the parser rather than an independent check.**

| Half | What it covers | How it is checked |
|---|---|---|
| **The full tree** | 8 `SessionState` trees over 29 session rows, 345 tool parts, 21 spawn edges, 9 parked entries | **machine-generated** by `scripts/opencode-golden.mjs`, byte-compared by `src/release/opencode-golden.test.ts`. **No human read all of it.** |
| **The core** | the 5 cases below | **hand-verified**: the SQL is written out, the transformation is written out, and the resulting fragment is quoted, so a reader can follow the derivation without running anything |

A 24-session / 865-part golden **cannot be eyeballed**, and a document that implied otherwise would
be claiming a review that did not happen. What the machine-generated half buys is a byte-exact
reproduction target; what the hand-verified half buys is the assurance that the mapping rules the
machine applied are the rules the contract and the spec actually state.

**The generator is independent of the engine it will check.** It imports nothing from `src/` — not
the parser, not the redactor, not the grafter — and every mapping decision cites
`docs/opencode-contract.md` (§1–§10 and the appended `Amendment 2026-08-26 — Phase 2 kill gate`,
cited as "amendment §X") or `agent-deck-spec.md`'s
`Amendment 2026-08-27 — Second observation source: OpenCode` (cited as OC1–OC9) at the line where
the decision is made. `src/release/opencode-golden.test.ts` suite 1 asserts the import graph, that
the database is opened `{ readOnly: true }`, and that no SQL `LIKE` appears anywhere. If Phase 4's
engine and this generator ever agreed only because they shared code, the golden would prove nothing.

---

## The mapping, decision by decision

### One `SessionState` per ROOT session

Contract §9 maps CC's `subagents/agent-<id>.jsonl` + `.meta.json` onto `session.parent_id` rows plus
the `task` part join. A child session is therefore a **subagent inside its parent's session**, not a
deck entry of its own — exactly as a CC subagent transcript is. The anchor's 24 session rows become
**4** `SessionState` objects (4 roots) carrying **20** subagent `AgentNode`s; the witness's 5 rows
become **4** carrying **1**.

`src/release/opencode-golden.test.ts` suite 6 asserts that every `session` row is reachable as a
root, a subagent node, or a parked entry — a row reachable through none of those would be a session
silently dropped.

### Field by field

| `SessionState` field | Source | Authority |
|---|---|---|
| `sessionId` | root `session.id` | contract §3 |
| `projectSlug` | **`""` — a placeholder, see below** | OC7 open item |
| `engine` | `"opencode"` | OC7 |
| `workspaceMatch` | `true` (the corpus's own `project.worktree` is the workspace) | OC8 |
| `liveness` | `"ended"` if `time_archived` is set, else `"idle"` | OC4 |
| `schemaOk` | `true` | OC2 |
| `epochAnchor` | root `session.time_created`, ISO-8601 | house convention |
| ~~`totals.inputTokens` / `outputTokens`~~ | **AMENDED 2026-08-28 — the mapping is GONE. See the note below this table.** | — |
| `totals.costUsd` | sum of the `cost` column | contract §9 |
| `spawnEdges` | one per agreeing `task` pair | OC3, contract §5 |
| `parked` | one per `task` part with no child, plus the contradiction codes | OC3, amendment §G |

| `AgentNode` field | Source | Authority |
|---|---|---|
| `id` | `"root"` at depth 0, else the child `session.id` | `src/model/events.ts` |
| `kind` | `"main"` at depth 0, else `"subagent"` | `src/model/events.ts` |
| `label` | `` `${session.agent}: ${session.title}` `` | OC3 ("`session.agent` + `session.title` fill `AgentNode.label`") |
| `status` | `running` if any tool part is `running`; else, for a subagent, its spawning `task` part's status; else `done` | OC4 |
| `spawnDepth` | walked from `parent_id`, never assumed | OC3 ("Depth comes from the data, not from a cap") |
| ~~`tokens`~~ | **AMENDED 2026-08-28 — the field was removed from `AgentNode` and the mapping with it. See the note below this table.** | — |
| `startedAt` | `session.time_created` | contract §3 |
| `endedAt` | `time_archived` when set, else `time_updated`; omitted when `running` | OC4 + contract §3 |

| `ToolNode` field | Source | Authority |
|---|---|---|
| `id` | `part.data.callID` | amendment §D (`callID` is a join key OpenCode itself uses) |
| `toolName` | `part.data.tool` | contract §4 |
| `status` | `completed` → `done`, `error` → `error`, `running` → `running` | contract §4 + `src/model/events.ts` |
| `inputPreview` | canonical JSON of `state.input`, cut once at 8,192 bytes, then digested | OC6 |
| `resultPreview` | `state.output` if a string, else `state.error` if a string, else omitted | contract §4 + a generator decision, below |
| `durationMs` | `state.time.end - state.time.start` | contract §4 |

### Tokens: the two struck rows above. AMENDED 2026-08-28

**This file is this corpus's mapping authority, so a stale row here is worse than a stale code
comment: it is the document a reader consults to find out what the golden means.** Two rows in the
tables above described a mapping that no longer exists, and the regenerated `golden.json` beside
them had already stopped carrying it. Struck in place rather than rewritten, which is the treatment
DEVIATION 5 records for a closed-phase finding.

**What the goldens carry now**, measured over both committed corpora on 2026-08-28:

| | claimed by the struck rows | actually in `golden.json` |
|---|---|---|
| session `totals` | `{inputTokens, outputTokens, costUsd}` | `{"costUsd": 0}` — one key |
| session `contextNow` / `burn` | not mentioned | present, `null` in 8 of 8 root sessions (4 here, 4 in the 1.18.21 witness) |
| agent `tokens` | `{in, out}` | the key does not exist |
| agent `contextNow` / `burn` | not mentioned | present, `null` in 29 of 29 agent nodes (24 here, 5 in the witness) |

**Why the numbers are absent rather than zero, and why absent is the honest answer.**
`AgentNode.tokens` was REMOVED from `src/model/events.ts` — not renamed — and replaced by
`contextNow` (a LEVEL: the last assistant message) and `burn` (a TOTAL: the whole session), because
reading `input_tokens` alone reported ~2 on every real Claude Code assistant message while the
prompt lived in the cache fields.

`session.tokens_input` IS a genuine session-cumulative total for OpenCode — all 24 anchor sessions
equal the sum of their own `step-finish` rows, and `src/opencode/graft.test.ts` pins that. It is
still the WRONG number for the prompt half, because it counts only UNCACHED input: across this
corpus `tokens.cache.read` sums to 8,875,276 against `tokens.input`'s 1,227,047 (the figures are
`src/opencode/graft.ts`'s, quoted rather than re-derived here), so a session whose
prompt is mostly cache would report roughly a seventh of what it sent — the same defect the pair was
introduced to remove, arriving through a second engine.

So `src/opencode/graft.ts` and `scripts/opencode-golden.mjs` both OMIT the keys, independently, and
the serialised form is `null`. Absent renders as an em-dash, "we do not have this number"; `0` would
be a claim that the session spent nothing. The correct figure is reachable —
`input + cache.read + cache.write` per `step-finish` row — and building that reader was deferred by
user decision at the Phase 7 gate rather than guessed at here.

**`totals.costUsd` is unchanged and still live.** It is the third row of the old triple and the only
one that survived: `sum of the cost column`, contract §9.

### Previews are digests, and the byte count is the visible half

`sha256:<first 16 hex>:<utf8 byte length>` — the house rule from
`fixtures/golden/session/README.md` rule 3, applied unchanged. OpenCode tool inputs embed the
capturing machine's absolute paths (`{"filePath":"C:\\Users\\…"}` is the shape), so a verbatim
golden would only reproduce on this machine.

The **byte-length component is what makes truncation visible**: an 88,478-byte payload appears as
`:8248`, not `:88478`. Suite 5 of the test file reads that number back and asserts the excess over
the ceiling is exactly a marker's length.

### Truncation: cut ONCE

`redact.ts` is one module serving both engines (OC6: tool payloads "go through the existing
`redact.ts` ceiling"), so the ceiling and the marker are copied character for character rather than
re-decided: `DEFAULT_MAX_PAYLOAD_BYTES` = 8,192 and
`\n...[agent-deck: truncated, showing ${kept} of ${original} bytes]`. Suite 2 of the test file
asserts both still equal their source in `src/parser/redact.ts`.

**The cut is applied exactly once, to the raw stored payload.** The recorded defect is that a
payload cut twice — once by the parser, again by a preview — produces a marker stating the
*intermediate* length as the original, under-reporting the largest committed CC payload by 7.73×.
The generator has one cut and no second pass, so every marker states the true original byte count:
`8192 of 88478`, not `8192 of 8248`.

### Reasoning parts are dropped at the parse boundary (G4 / OC6)

Every part is read, and a `reasoning` part is thrown away before it can become anything —
`DROPPED_PART_TYPES` in the generator, with a counter (`counts.reasoningPartsDropped` = 167 in the
anchor, 65 in the witness, equal to the row counts). `signature`, `thinking` and `redacted_thinking`
are stripped wherever they appear, **by field policy rather than by observation**: the measured
provider (`qwen-local`) writes no `signature`, and a rule that only covers what one provider
happened to emit is not a rule.

**Why this is not vacuous, and where it is weaker than it looks.** In Claude Code the thinking text
is empty on disk and the bytes sit in `signature`, so a test asserting only that thinking text does
not leak passes forever while proving nothing. In OpenCode the bytes are plainly present in
`part.data.text` — the anchor's longest reasoning part is `prt_037930668001yK35JsK5IRwyME` at 36,716
characters. The test reads the first 64 bytes of all 167 and searches the golden for them: 0 hits.

The honest caveat: because **only `tool` parts produce nodes**, a `reasoning` part could not have
reached the tree even without the drop, and because previews are digests **no payload text of any
kind** appears in these files. So the G4 assertion here is a tripwire against a future change, not a
demonstration that active scrubbing removed something that would otherwise have shipped. Phase 4's
G4 test runs against the production path, where the inspector does surface payload text, and that is
where the assertion carries its full weight.

### Parts that produce no node are IGNORED, not refused

Contract §4 measures seven part types. Only `tool` maps to anything in `src/model/events.ts`;
`text`, `step-start`, `step-finish`, `patch` and `compaction` have no counterpart and are counted
(`counts.partsIgnoredNoNode`) and skipped. That is the CC unknown-field rule applied to part types
(OC2). A malformed `data` column increments `counts.partsMalformed` and is skipped rather than
throwing (G3); it is **0** in both corpora.

---

## The hand-verified core

Five cases, chosen because each carries something the other four do not. Every number below was read
out of `fixtures/opencode-1.18.22/opencode.db` with the query shown.

### 1 — A depth-1 `task` pair whose join keys agree

There are **20** such pairs in the anchor. The one named here is `prt_037cbbf51001IdVigLXtgFOsBX`,
the first by `time_created`.

```sql
SELECT p.id, p.session_id,
       json_extract(p.data, '$.callID')                        AS call_id,
       json_extract(p.data, '$.state.status')                  AS status,
       json_extract(p.data, '$.state.metadata.sessionId')       AS child_id,
       json_extract(p.data, '$.state.metadata.parentSessionId') AS parent_claim,
       json_extract(p.data, '$.state.time.start')               AS t_start,
       json_extract(p.data, '$.state.time.end')                 AS t_end
  FROM part p
 WHERE p.id = 'prt_037cbbf51001IdVigLXtgFOsBX';

SELECT id, parent_id, agent, title, tokens_input, tokens_output, time_created, time_updated
  FROM session WHERE id = 'ses_fc83161a8ffeRtUMsYpBB5HClg';
```

Read back:

```
part      prt_037cbbf51001IdVigLXtgFOsBX   session ses_fc8d8bb41ffeTH4iLV8HiV1kQJ
  callID  EGulB7lO1x8TBK1enJsdyADXiQaiXgbY
  status  error          time.start 1787642682975   time.end 1787663692599
  state.metadata.sessionId        ses_fc83161a8ffeRtUMsYpBB5HClg
  state.metadata.parentSessionId  ses_fc8d8bb41ffeTH4iLV8HiV1kQJ
child     ses_fc83161a8ffeRtUMsYpBB5HClg
  parent_id     ses_fc8d8bb41ffeTH4iLV8HiV1kQJ
  agent/title   general / "P0: sweep depth closure (@general subagent)"
  tokens        in 54647   out 757
  time_created  1787642682967    time_updated 1787643469704
```

**The three keys agree** (contract §5, OC3): the part's `sessionId` names the child, the part's
`parentSessionId` equals the part's own `session_id`, and the child's `parent_id` equals it too.
That is a primary key in both directions, so this is a join and not an inference.

Transformation:

- `ToolNode.id` ← `callID`; `status` `error` → `"error"`; `durationMs` = 1787663692599 −
  1787642682975 = **21,009,624**.
- `inputPreview`: `state.input` canonicalised (keys sorted) is 5,762 bytes — **under** the 8,192
  ceiling, so no cut — then digested: `sha256:eb23d008c4350c9d:5762`.
- `resultPreview`: this part has **no** `state.output` (it errored); `state.error` is the 22-byte
  string `Tool execution aborted`, digested to `sha256:18cc068fbdbecb19:22`.
- The child becomes a subagent `AgentNode` placed **immediately after** the tool node, never inside
  it — `ToolNode` has no `children` field and that stays true, so the spawn relationship exists only
  in `spawnEdges`.
- `spawnDepth` 1, walked from `parent_id`. `startedAtOffsetMs` = 1787642682967 − 1787631715519 =
  **10,967,448** against the root session's `time_created`. `endedAtOffsetMs` = 1787643469704 −
  1787631715519 = **11,754,185**.
- `AgentNode.status` = `"error"`, taken from the spawning task part's status.

Resulting fragment (`fixtures/opencode-1.18.22/golden.json`):

```json
{
  "node": "tool",
  "id": "EGulB7lO1x8TBK1enJsdyADXiQaiXgbY",
  "toolName": "task",
  "status": "error",
  "inputPreview": "sha256:eb23d008c4350c9d:5762",
  "resultPreview": "sha256:18cc068fbdbecb19:22",
  "durationMs": 21009624
},
{
  "node": "agent",
  "id": "ses_fc83161a8ffeRtUMsYpBB5HClg",
  "kind": "subagent",
  "label": "general: P0: sweep depth closure (@general subagent)",
  "status": "error",
  "spawnDepth": 1,
  "tokens": { "in": 54647, "out": 757 },
  "startedAtOffsetMs": 10967448,
  "endedAtOffsetMs": 11754185,
  "children": [ … ]
}
```

and the edge:

```json
{
  "toolUseId": "EGulB7lO1x8TBK1enJsdyADXiQaiXgbY",
  "agentId": "ses_fc83161a8ffeRtUMsYpBB5HClg",
  "parentNodeId": "root",
  "depth": 1,
  "recordedDepth": 1
}
```

### 2 — A `task` part carrying no `state.metadata.sessionId`: the parked case

**9 of 29** `task` parts in the anchor carry no child session id (amendment §G). The one named here
is `prt_037de19c1001RbxdXZO7S58mso`.

```sql
SELECT id, session_id,
       json_extract(data, '$.callID')                    AS call_id,
       json_extract(data, '$.state.status')              AS status,
       json_extract(data, '$.state.metadata.sessionId')  AS child_id,
       json_extract(data, '$.state.time.start')          AS t_start,
       json_extract(data, '$.state.time.end')            AS t_end
  FROM part
 WHERE json_extract(data, '$.tool') = 'task'
   AND json_extract(data, '$.state.metadata.sessionId') IS NULL;
```

Read back, for the named row:

```
part      prt_037de19c1001RbxdXZO7S58mso   session ses_fc8d8bb41ffeTH4iLV8HiV1kQJ
  callID  HA1N02dFWp9RUsJyVNzzZzO3fkkhJSZ3
  status  error   metadata keys ["interrupted"]   sessionId  (absent)
  time.start 1787663692603   time.end 1787663692603
  state.input  {}       state.error  "Tool execution aborted"
```

Transformation — **three normative rules, all from OC3**:

1. It **parks** with a stable code. `taskWithoutChild`.
2. It **must not guess from timing**. There are 20 child sessions in this corpus and a
   nearest-in-time match would find one; the generator does not look. Absence of the key is the
   whole signal, exactly as absence of `agent_id` is the main-thread signal for CC hooks.
3. It is **not a disagreement**. A missing key and a contradicted key get different codes
   (`taskWithoutChild` vs `joinKeyContradiction`), for the same reason `unsupportedVersion` and
   `versionChangedMidFile` are distinct for CC.

The `task` part still becomes a `ToolNode` — the call happened and the user saw it — and no
`AgentNode` and no `spawnEdge` are produced. Resulting fragment:

```json
{
  "agentId": "prt_037de19c1001RbxdXZO7S58mso",
  "code": "taskWithoutChild",
  "toolUseId": "HA1N02dFWp9RUsJyVNzzZzO3fkkhJSZ3",
  "reason": "task part carries no state.metadata.sessionId; no child session to attach (contract amendment §G) - not inferred from timing (OC3)"
}
```

**`agentId` here is a `prt_*` row id, and that is a spec misfit, not a typo.** `ParkedGraft.agentId`
is documented in `src/model/events.ts` as "the agent that did not graft" — and the entire content of
this case is that **no agent id exists**. OpenCode parks a *part*, not an agent. The `prt_*` id is
the only stable identity the data offers for the thing that was parked, and every one of the 9 is
distinct. See DEVIATIONS below: Phase 4 owns whether `ParkedGraft` should carry a part id instead.

`src/release/opencode-golden.test.ts` asserts that no parked `agentId` appears anywhere in the tree
— a refusal that is invisible to the renderer is not a refusal.

### 3 — A session containing an `error`-status tool part

```sql
SELECT json_extract(data, '$.state.status') AS status, count(*)
  FROM part WHERE json_extract(data, '$.type') = 'tool' GROUP BY 1;
-- completed 219, error 27, running 0

SELECT json_extract(data, '$.tool') AS tool, count(*)
  FROM part WHERE json_extract(data, '$.type') = 'tool'
   AND json_extract(data, '$.state.status') = 'error' GROUP BY 1;
-- task 27
```

**Measured and worth stating plainly: all 27 error tool parts in the anchor are `task` parts**, so
an error example is necessarily a task part on this corpus. (The witness has the opposite shape: 1
error part, and its single `task` part is `completed`.) The one named here is
`prt_037cea2d3001qhdguK6QSnxFvn`, in root session `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ`, spawning
`ses_fc821eb79ffel5tbIxRSwHcWkx`.

```
callID        sgAxbmoHL05gRLouB7LW1JBnUAmFKXpe
status        error
state.output  (absent)
state.error   "Tool execution aborted"   (22 bytes)
time.start 1787643696268   time.end 1787663692601   ->  durationMs 19,996,333
input canonical 5,855 bytes, under the ceiling -> sha256:a196064d7521bc84:5855
```

Transformation: `state.status` `error` maps to `ToolNode.status` `"error"` (contract §4 measures
exactly three statuses; `src/model/events.ts` spells `completed` as `done`). **`resultPreview` is
taken from `state.error`** because an errored part carries no `output` at all — this is a
**generator decision**, not a contract citation: contract §4 names `error` as a status but does not
say which field the preview should read. It is the direct analogue of a CC error `tool_result`, and
the alternative — omitting the preview — would render an error with no explanation.

```json
{
  "node": "tool",
  "id": "sgAxbmoHL05gRLouB7LW1JBnUAmFKXpe",
  "toolName": "task",
  "status": "error",
  "inputPreview": "sha256:a196064d7521bc84:5855",
  "resultPreview": "sha256:18cc068fbdbecb19:22",
  "durationMs": 19996333
}
```

The identical `resultPreview` digest on cases 1 and 3 is correct and is a small proof that the digest
is over content: both errors are the same 22 bytes.

### 4 — The `compaction` part with `tail_start_id`

```sql
SELECT id, session_id, data FROM part WHERE json_extract(data, '$.type') = 'compaction';
```

Anchor, one row:

```
prt_03a7a7e700013sN9DCtTu76YAh   ses_fc8d8bb41ffeTH4iLV8HiV1kQJ
{"type":"compaction","auto":true,"overflow":false,"tail_start_id":"msg_03a51462f001DwrGE19VXZO2ij"}
```

Witness, two rows, **without** `tail_start_id` — which is the whole reason there are two corpora:

```
{"type":"compaction","auto":true,"overflow":false}
```

**Transformation: none. The resulting golden fragment is nothing at all.** `compaction` has no
counterpart in `AgentNode` or `ToolNode`, so it is counted in `counts.partsIgnoredNoNode` and
skipped. This case is in the hand-verified set precisely because its correct output is an absence:
the two things that must be true are that its presence **does not change the tree** and that it
**does not refuse the session** (`schemaOk` stays `true`). Amendment §E closed the shape; OC2 makes
an unknown part type ignorable rather than refusable. A Phase 4 engine that refused on `compaction`,
or that started emitting a node for it, would diverge from these bytes.

### 5 — The 88,292-character inline tool output

```sql
SELECT id, session_id,
       json_extract(data, '$.tool')                        AS tool,
       json_extract(data, '$.callID')                      AS call_id,
       length(json_extract(data, '$.state.output'))        AS out_chars,
       json_extract(data, '$.state.metadata.truncated')    AS oc_truncated
  FROM part
 WHERE json_extract(data, '$.type') = 'tool'
 ORDER BY out_chars DESC LIMIT 1;
```

```
prt_037d0d8120013bfEEXnjJ2kHpX   ses_fc83161a8ffeRtUMsYpBB5HClg
tool read   callID i595d7Vhshai6OZZo2D5pZKgSviOsbs0
state.output  88,292 characters = 88,478 UTF-8 bytes   (stored INLINE, amendment §F)
state.metadata.truncated  false      <- OpenCode did not truncate it; we do
time.start 1787642847028  time.end 1787642847191  ->  durationMs 163
```

Transformation, **one cut**:

- 88,478 bytes > 8,192, so cut at byte 8,192, walking back off any UTF-8 continuation byte so a code
  point is never split (it lands on a boundary here: `keptBytes` = 8,192 exactly).
- Append `\n...[agent-deck: truncated, showing 8192 of 88478 bytes]` — 56 bytes. Total 8,248.
- Digest the 8,248-byte string: `sha256:ebe8bc88e89aab44:8248`.

The tail of the cut string, verbatim, is:

```
1:     prefixe
...[agent-deck: truncated, showing 8192 of 88478 bytes]
```

`88478`, **not** `8248`. That is the whole point of cutting once.

```json
{
  "node": "tool",
  "id": "i595d7Vhshai6OZZo2D5pZKgSviOsbs0",
  "toolName": "read",
  "status": "done",
  "inputPreview": "sha256:d531899777f2a4f3:131",
  "resultPreview": "sha256:ebe8bc88e89aab44:8248",
  "durationMs": 163,
  "truncated": false
}
```

The 131-byte `inputPreview` is `{"filePath":"C:\\Users\\…privacy-sweep.mjs"}` — an absolute path,
which is exactly why previews are digests and not text.

---

## Measured gaps: branches this corpus does not exercise

Recorded rather than papered over. Each is a mapping rule the generator implements that **no row in
either corpus reaches**, so Phase 4 will reproduce these files without ever proving the branch.

| Rule | Why unexercised |
|---|---|
| `liveness` = `"ended"` | `time_archived` is NULL on all 24 anchor and all 5 witness sessions |
| `liveness` = `"live"` | impossible from a static file: OC4's cursor cannot advance while a committed fixture is read. No golden can ever carry it |
| `liveness` = `"unsupported"` | nothing in either corpus refuses; the version window is Phase 4's (below) |
| `ToolNode.status` = `"running"` | 0 running tool parts (219 completed + 27 error in the anchor); 0 parts missing `state.time.end` |
| `AgentNode.status` = `"running"` | follows from the row above |
| park code `joinKeyContradiction` | 20 agreements, 0 disagreements in the anchor; 1 and 0 in the witness |
| park code `ambiguousJoinKey` | 20 task parts naming 20 distinct children |
| park code `noSpawningTaskPart` | every child session is joined by a task part in its own parent |
| `spawnDepth` ≥ 2 | this installation denies subagents the `task` permission, so real depth is 1 (contract §5) |
| `counts.partsMalformed` > 0 | every `data` column in both corpora parses |

## What was NOT decided here

### `projectSlug` — SUPERSEDED 2026-08-27, closed in Phase 4

> **Read this before the subsection below it, which is a Phase 3 record and is now out of date.**
>
> `PLAN.md` Phase 4 `Amendment 2026-08-27 — projectSlug, liveness proof, coverage law`, item A1,
> closed this open item **in Phase 4**, not Phase 5. `projectSlug` means "the project key" for both
> engines, and the OpenCode value is the slug derived from `project.worktree` by the rule Claude
> Code uses to name its `~/.claude/projects/<slug>` directory.
>
> **Both `golden.json` files were regenerated once, on 2026-08-27, with `projectSlug` filled** —
> one field per session, nothing else changed. Each corpus `README.md` carries the regeneration
> line. `src/release/opencode-golden.test.ts` no longer asserts the placeholder; it asserts the
> value equals the slug directory name under `fixtures/cc-2.1.246/projects/` **and** the
> `projectSlug` the CC goldens in `fixtures/golden/session/` carry, both read off disk.
>
> One consequence worth naming, because it changed a test rather than only a value: this file's
> reproducibility rule forbade the bare words `Users` and `projects` in a golden, and the slug
> contains both. That check is now the CC goldens' four — drive letter, `/Users/`, `.claude`,
> Windows separator — which is what `fixtures/golden/session/README.md` rule 1 actually states and
> what `src/model/session.test.ts` has always enforced on the CC goldens carrying this same string.
> Rule 1 forbids a filesystem *path*, and a slug has had `:`, `\` and `/` collapsed out of it.
>
> The subsection below is **left as written**, as the Phase 3 record of what was true when the
> goldens were first generated. It is not the current state.

### `projectSlug` — an open question, left open

OC7 states it plainly: "`SessionState.projectSlug` is named for CC's slug directory and OpenCode has
no slug (OC8). What that field carries for an OpenCode session — `project.id`, the `worktree` path,
or a new optional field beside it — is not decided by this amendment, and is not guessed by it. Open
item, for **Phase 5** to decide and record there."

**These goldens carry `""`.** It is a placeholder and nothing else. It was chosen because it is the
least-committal value available: it names none of the three candidates, it carries no filesystem path
(which `fixtures/golden/session/README.md` rule 1 forbids in a golden), and it is
machine-independent. `src/release/opencode-golden.test.ts` asserts the placeholder explicitly, with
the OC7 citation in the test, so the day Phase 5 decides, the assertion, the generator and both
`golden.json` files change together and the diff is one field per session.

### The version window — Phase 4's, not this generator's

OC2's fingerprint refuses a **missing** required table or read column. Both corpora were built from
the source database's own DDL by `scripts/capture-opencode.mjs`, so all six required tables and every
read column are present verbatim and `schemaOk` is `true` throughout.

The **version** half is deliberately not applied. OC5: "The concrete window belongs to Phase 4 and to
that capture; writing a number here before the harvest would be writing a number nobody measured."
This generator therefore does not decide whether `1.18.21` falls inside a window anchored on
`1.18.22`. It asserts only what OC5's harvest rule requires: that every `session.version` in a corpus
equals the version in the directory name, and it aborts if not.

**Consequence for Phase 4:** if the window it chooses excludes `1.18.21`, then
`fixtures/opencode-1.18.21/golden.json` becomes a golden of `unsupported` sessions and must be
regenerated. That is a real difference and should be read as one.

---

## DEVIATIONS — where the contract, the spec and `src/model/events.ts` do not line up

None of these was resolved by this package, and they are not all the same kind of problem — the
split matters more than the count, so it is written by item rather than by number (an earlier
version of this line said "all three" over a list that had grown to six, which is the defect this
repo records most often):

- **Items 1-4 are type and spec disagreements that Phase 4 owns.** The golden had to represent
  something `src/model/events.ts` cannot currently express, and the fix is to widen the type.
- **Items 5 and 6 are limits of what the captured corpora can exercise.** No amount of Phase 4 work
  removes them; they need a different capture, and until then the behaviour they describe is
  unpinned by any fixture.

1. **`SessionState.engine` does not exist in `src/model/events.ts`.** OC7 specifies
   `engine?: 'cc' | 'opencode'`, additive and optional, absence reading as `'cc'`. The field is in
   both goldens because the spec says so; the interface has not been widened yet, so
   `src/release/opencode-golden.test.ts` validates against a local mirror of the shape rather than
   importing the interface. Phase 4 adds the field.

2. **`ParkCode` has no `taskWithoutChild`.** OC3 names it normatively ("the grafter parks the part
   with a stable code (`taskWithoutChild`, `PLAN.md` DoD 4.4)"); the union in `src/model/events.ts`
   carries the eight CC codes and not this one. The goldens use it. Phase 4 widens the union — and
   should decide at the same time whether `joinKeyContradiction` is a new code or should reuse the
   existing `parentAgentContradiction`.

3. **`ParkedGraft.agentId` is the wrong field for this case.** OpenCode parks a **part**, not an
   agent, and the case is defined by the child session id being absent. The goldens put the `prt_*`
   row id there because it is the only stable identity available. Either `ParkedGraft` gains an
   optional part id, or the field is documented as "the identity of the thing that did not graft",
   which is a wider claim than it makes today.

4. **`SpawnEdge.recordedDepth` says nothing for this engine.** It is documented as "`spawnDepth` as
   written in the sidecar, kept even when it disagrees" — the point being that a recorded value can
   contradict a walked one. OpenCode records **no** depth anywhere; depth is walked from `parent_id`
   (OC3). It therefore equals `depth` by construction in every edge in both goldens, and it can
   never disagree. It is not wrong, it is vacuous.

5. **`ToolNode` could not carry `state.metadata.truncated`. CLOSED 2026-08-27.** Contract
   §8.4 calls it "the flag to trust" for OpenCode's own truncation, and 14 anchor tool parts set
   it. `ToolNode` had no field for it, so the golden did not represent it — a payload OpenCode
   already truncated and one it did not were indistinguishable in these files.

   `PLAN.md`'s Phase 5 gate amendment B7 gave it one. `ToolNode.truncated` exists in
   `src/model/events.ts`, `src/opencode/parse.ts` maps it and `scripts/opencode-golden.mjs`
   maps it independently; both goldens were regenerated and each tool node gained exactly one
   key. **All three states are represented**, because they are three different facts: `true`
   and `false` are claims OpenCode made and `null` is no claim, which is not the same as "known
   to be whole". Measured after regenerating — anchor 14 / 205 / 27 over 246 tool nodes,
   witness 5 / 93 / 1 over 99.

   **It is not merged with our own truncation and must not be.** The `redact.ts` marker inside a
   preview says Agent Deck cut the payload and raising `agentDeck.previewBytes` recovers it;
   this flag says OpenCode cut it upstream and nothing here can. The corpora make the two
   independent: the 88,478-byte `read` output in the hand-verified case above carries
   `truncated: false` from OpenCode and is cut by us.

6. **No non-`task` error tool part exists in the anchor.** All 27 error parts are `task` parts. The
   `resultPreview`-from-`state.error` rule is therefore only exercised on task calls in the anchor;
   the witness's single error part is a non-task tool and covers it there.

---

## Regenerating, and reading the diff

```console
node scripts/opencode-golden.mjs                              # rewrite both goldens
git diff fixtures/opencode-*/golden.json                      # READ IT
node node_modules/vitest/vitest.mjs run src/release/opencode-golden.test.ts
```

**Read the diff. A golden that nobody read is worth exactly nothing.** Regeneration is the only
supported way to update these files — hand-editing the JSON pins whatever the editor believed rather
than whatever the procedure does, and `src/release/opencode-golden.test.ts` compares the committed
bytes against a fresh generation on every run, so a hand edit fails the suite.

A new corpus under `fixtures/opencode-<version>/` is picked up automatically: the generator lists
corpus directories from disk and the test file resolves them at **collection time** (a list populated
in `beforeAll` generates zero tests and reads green). Its `golden.json` is written by the same run.
