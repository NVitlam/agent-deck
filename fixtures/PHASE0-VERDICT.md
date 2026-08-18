# Phase 0 — Tap Validation Spike: VERDICT

**VERDICT: GO.**

Sidechain/subagent entries are attributable to their parent agent **deterministically**, not
probabilistically. The kill condition ("sidechain entries cannot be deterministically attributed to
parent agents") is not met. 27 of 27 subagent transcripts across four real sessions resolved to
exactly one parent, with zero ambiguous and zero unresolved.

- Date: 2026-08-19
- CC version pinned: **2.1.234** (VS Code extension). The `claude` on PATH is a stale npm global at
  2.1.178 and is not the reference. The layout was cross-checked against 2.1.231/232 sessions and is
  identical in shape.
- Platform: Windows 11 native, `C:\Users\dev\.claude`. Node v24.15.0.

---

## 1. The spec's premise was wrong, and the truth is easier

`agent-deck-spec.md` Component 5 assumed subagent activity arrives as **interleaved
`"isSidechain":true` entries inside the main session JSONL**, and called reconstructing the tree from
that interleaving "the core engineering problem".

On CC 2.1.234 that is not what happens. Measured:

- `"isSidechain":true` occurrences in main transcripts: **0** (PROJ-REDACTED, PROJ-REDACTED, agent-deck — all main files)
- `"name":"Task"` tool calls across 127 session files: **0**. The spawning tool is named **`Agent`**.

Subagents are written to **separate files**:

```
projects/<slug>/<sessionId>.jsonl                                main transcript
projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl      subagent transcript (isSidechain:true, agentId)
projects/<slug>/<sessionId>/subagents/agent-<agentId>.meta.json  {agentType, description, toolUseId, spawnDepth, ...}
projects/<slug>/<sessionId>/tool-results/<id>.txt                offloaded large tool payloads
```

`meta.toolUseId` names the exact `tool_use` block that spawned the transcript. Attribution is
therefore a **join on a primary key**, not an inference over interleaving. The hard problem the spec
was built to survive does not exist on this version.

Corollary: Component 5 shrinks to multi-file tailing plus a keyed graft. The risk moves from
*algorithmic ambiguity* to *file discovery* — noticing a `subagents/` file that appears mid-session —
which is exercised and passing (§3).

## 2. Attribution audit (the gate)

`node spike/run.mjs --audit --project <path> --session <uuid>` resolves every `agent-*.meta.json`
`toolUseId` against every `tool_use` id across all transcripts of the session, and classifies
RESOLVED / AMBIGUOUS / UNRESOLVED. It also recomputes depth from the graft chain and compares it to
`meta.spawnDepth`.

| Session | CC ver | Agent transcripts | RESOLVED | AMBIGUOUS | UNRESOLVED | Depth mismatch |
|---|---|---|---|---|---|---|
| PROJ-REDACTED `REDACTED-UUID` | 2.1.231/232 | 12 | 12 | 0 | 0 | 0 |
| PROJ-REDACTED `REDACTED-UUID` | 2.1.231/232 | 9 | 9 | 0 | 0 | 0 |
| agent-deck `7dc3481d` (live) | 2.1.234 | 5 | 5 | 0 | 0 | 0 |
| agent-deck `4299490e` (live, 2nd window) | 2.1.234 | 1 | 1 | 0 | 0 | 0 |
| **total** | | **27** | **27** | **0** | **0** | **0** |

Duplicate `tool_use` ids across transcripts of one session — the only condition that could make the
join ambiguous — were explicitly checked for: **0 occurrences**.

Two additional synthetic proofs were run by the implementer and are not counted above: an in-memory
replay where a `meta.json` arrives *before* its parent `tool_use` (out-of-order grafting, depth 3,
reported 7/7 checks passed), and an on-disk fake-HOME run with a concurrent writer (depth 2, mid-run
file discovery, split-line reassembly). **Neither run was retained as an artifact**; both are recorded
here as implementer claims, not verified evidence, and neither contributes to the gate count above.
Phase 1 should re-establish both as real tests once a harness exists — out-of-order arrival and
mid-write line splitting are exactly the conditions the production tailer must survive.

### Depth >= 2 was unproven, so it was generated

Every `meta.json` on disk at the start of this phase was `spawnDepth:1`, so nested attribution had no
real evidence. A workload was run to create one: an agent that spawns an agent.

```
RESOLVED  agent-abcffc490b49132ec  [Explore] "List spike directory files"
          parent=a68c75d33e3d38b01  tool=Agent  id=toolu_01QsiBJTGxkVQX8woqSbQsC2
          depth meta=2 computed=2
```

The parent is **another agent transcript, not the main session** — the grandchild case the spec cares
about. Its meta also carries `parentAgentId`, a second independent attribution signal that the audit
deliberately does not rely on.

## 3. Live tailing, concurrency, latency

150-second live run against the workspace with three sessions open, two actively appending. The
`LATENCY SUMMARY` block below is verbatim from the committed
`fixtures/phase0-evidence/latency-2026-08-18_21-57-28.log`; the `TOTALS:` line above it was console
output of the same run and is **not** in that log. An earlier single-session run is retained as
`latency-2026-08-18_21-34-24.log` (median 165 ms / max 197 ms over 55 samples):

```
TOTALS: sessions=3 transcripts=9 (agents=6, grafted=6) tool nodes=239 jsonl lines=816 malformed skipped=0
LATENCY SUMMARY (renders=18, live entries=35, initial entries=781)
  entry.timestamp -> render: count=13 min=103ms median=171ms p95=184ms max=186ms
  fs-detect       -> render: count=15 min=33ms  median=55ms  p95=61ms  max=69ms
```

- **<1s requirement: met with ~5x margin.** Worst observed end-to-end 186 ms, measured from the JSONL
  entry's own timestamp (so it includes CC's own write latency) to the rendered frame.
- **Concurrent sessions: tracked separately.** Three trees rendered independently, no
  cross-contamination; each session's agents grafted only under their own tool nodes.
- **Mid-session file discovery works.** Subagent transcripts created *while* the tailer ran were
  picked up and grafted (6/6 grafted).
- **0 malformed lines** over 816 lines live, and 3,628 lines across the PROJ-REDACTED and PROJ-REDACTED scans
  (1,708 + 1,920 as re-measured at close; those two sessions are live user projects that keep
  growing, so the line count drifts while the 0-malformed result reproduces).

## 4. Hook liveness tap

Loopback listener (`spike/listen.mjs`, bound to a hard-coded `127.0.0.1`), with the hook block
installed by hand into the project's `.claude/settings.local.json` — **not** by Agent Deck, and not
into `~/.claude` at all. `~/.claude/settings.json` md5 was verified unchanged (`d7c2cbe8…`, mtime
2026-06-16) after the whole phase (G1).

Real CC traffic captured over the phase — 181 events, all five configured types
(`fixtures/phase0-evidence/real-hook-events.jsonl`):

| Event | Count | Source |
|---|---|---|
| PreToolUse | 86 | real CC 2.1.234 |
| PostToolUse | 84 | real CC 2.1.234 |
| Stop | 6 | real CC 2.1.234 |
| SubagentStop | 4 | real CC 2.1.234 |
| SessionStart | 1 | real CC **2.1.178** — see caveat |

Multiple live sessions appear in the stream and are correlated by `session_id`; subagents are
distinguished by `agent_id` (4 distinct values observed). All five types were additionally exercised
end-to-end with synthetic payloads driven through the exact paste-block command string.

**Trap for the Phase 2 correlator — main-thread events have NO `agent_id` at all.** CC does not emit
`agent_id: "main"`; it omits the field entirely for the main thread. Measured over the committed
capture: 46 events absent / 135 present, split by type as PreToolUse 20/66, PostToolUse 19/65,
SubagentStop 0/4, Stop 6/0, SessionStart 1/0. Occurrences of the literal value `"main"`: **0**.
`'main'` is an internal convention of the spike stitcher (`ev.agentId || 'main'`), not part of the
hook contract. A correlator that matches the string `"main"` will silently drop every main-thread
event; absence of the key is the signal.

**Caveat on `SessionStart`:** every 2.1.234 session in this workspace was already running before the
listener came up, so none of them fired it. The one real `SessionStart` on record
(`source: "startup"`) came from a headless session started deliberately to exercise the path, and the
only CC on PATH is the stale **2.1.178** npm global. So the listener demonstrably receives
`SessionStart` from real CC, but **not yet from the pinned 2.1.234**. Confirm on the pinned version in
Phase 2.

**Key finding for Phase 2:** hook payloads on tool events carry **`agent_id` and `tool_use_id`** — the
same join keys the JSONL layout uses. Liveness can attach directly to stitched tree nodes with no
inference or heuristic matching. The payload field set was read out of the shipped 2.1.234 binary
rather than guessed:

- base: `{session_id, transcript_path, cwd, prompt_id, permission_mode, agent_id, agent_type, effort}`
- `PreToolUse` adds `tool_name`, `tool_input`, `tool_use_id`
- `SubagentStop` adds `stop_hook_active`, `agent_id`, `agent_transcript_path`, `agent_type`, `last_assistant_message`
- 2.1.234 also emits **`SubagentStart`**, which PLAN.md did not list

**Hook mechanism matters.** Measured against a closed loopback port, 5 runs each
(`fixtures/phase0-evidence/hook-mechanism-timing.txt`):

| Mechanism, listener DOWN | Exit | Wall clock |
|---|---|---|
| `node -e` (what the paste block uses) | 0 | 178-193 ms |
| `curl.exe -m 2 --connect-timeout 1` | 28 | 1139-1154 ms |

`curl` cannot distinguish a closed loopback port quickly and burns its full connect timeout; `node`
gets ECONNREFUSED immediately. So a stopped Agent Deck costs a real session ~0.19 s per tool call
instead of ~1.15 s, and never a non-zero exit. (The implementer measured the same effect with finer
instrumentation at ~87 ms vs ~1089 ms; the table above is the independently re-run, retained
artifact, and includes this harness's own process-spawn overhead.)

Security evidence, **independently reproduced by the phase verifier** (not merely reported by the
implementer): bound socket observed as `TCP 127.0.0.1:<port> LISTENING`, never `0.0.0.0`; a spoofed
non-loopback remote rejected **403 on every route** (`/event`, `/status`, `/shutdown`) with the
evidence file left at 0 bytes; proxy headers not trusted, `req.socket.remoteAddress` the sole source;
malformed input survived (100 broken-JSON lines + 50 binary-garbage lines + a corrupted `.meta.json`
gave `malformed skipped: 150`, no throw, and the corrupted agent reported `UNRESOLVED reason=missing
meta.toolUseId` rather than a guess).

The implementer additionally reported a LAN-address probe refused (curl exit 7), a 24/24
loopback-guard unit table, and a 1 MB body rejected with 413. **Those runs were not retained as
artifacts** and are recorded here as implementer claims, not as verified evidence. Phase 2 should
re-establish them as real tests once a harness exists.

## 5. Consequences for the plan

1. **Component 5 must be rewritten** in `agent-deck-spec.md`: from "reconstruct interleaved
   sidechains" to "tail N files per session and graft on `meta.toolUseId`". The `SessionState` /
   `AgentNode` / `ToolNode` shapes survive unchanged.
2. **Phase 2 gets easier and the correlator gets stronger** — hooks carry `tool_use_id`, so
   liveness-to-node attachment is a join, not a heuristic.
3. **New risk, replacing the old one:** everything now depends on the `subagents/` directory
   convention and the `meta.json` sidecar, which are undocumented and can change without notice. The
   Phase 1 fingerprint must assert the **layout**, not just field names.
4. **Add `SubagentStart`** to the Phase 2 listener's accepted event set.
5. **`tool-results/*.txt` offloading exists** and is not yet consumed — large tool payloads live
   outside the JSONL entirely. Phase 1 redaction and truncation must cover that path, or previews
   will silently miss content.
6. **Session files can span CC versions.** PROJ-REDACTED `REDACTED-UUID` contains both 2.1.231 and 2.1.232 `version`
   values, so the fingerprint must tolerate the value changing mid-file rather than treating it as a
   mismatch.

## 6. Reproducing this verdict

The fixture set is self-contained and does not read `~/.claude`:

```
CLAUDE_PROJECTS_ROOT=fixtures/cc-2.1.234/projects \
  node spike/run.mjs --audit --project "<this repo's absolute path>" --all
```

Expected: `agent transcripts: 6, RESOLVED 6, AMBIGUOUS 0, UNRESOLVED 0, VERDICT: DETERMINISTIC`,
exit 0.
