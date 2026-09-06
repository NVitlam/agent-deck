# `cc-2.1.260` — the COMPACTION corpus and the STALL corpus

**This directory holds TWO sessions of the same Claude Code version**, harvested for two different
phases: `75ef0bbf-…` (compaction, v0.7.0 Phase 0 DoD 0.3b) documented first, and `99f96635-…`
(the stall, Phase 0c DoD 0c.1) documented in its own part at the end. Each section states which
session it is about; neither harvest altered the other's bytes.

## The first session: `75ef0bbf-…` — the COMPACTION session

Captured 2026-09-05 for v0.7.0 Phase 0, DoD 0.3b. Real Claude Code session, captured raw and then
redacted; G6 applies to it exactly as it applies to every other corpus here.

**Why it exists.** No committed corpus held a structural compaction entry, so fact **F12**
(compaction events: count, ordinal, turns since session start, prompt tokens either side) rested on
nothing. This session holds **two** compactions of **different triggers**, which is what makes it
able to answer the question rather than merely exhibit one.

**It also closes two gaps nobody harvested it for**, and both are worth more than they cost:

- **The only real `Edit` calls in any committed corpus.** Before this, `Edit` appeared **only** in
  `fixtures/synthetic-dropped-actions/` (32 calls, hand-made). Fact **F4** — the churn chain — is
  defined on `Edit/Write`, so its entire evidence base was synthetic. This corpus carries **18 real
  `Edit` calls** beside 32 `Write` and 39 `Read`.
- **A real mid-file CC version change.** The session's lines carry **two** versions (below). Every
  earlier mid-file-drift case in this repository is synthetic. This one is real and it is
  *in-window*, so it is a positive control for the version posture: it must be **accepted**.

## Provenance

| | |
|---|---|
| session | `75ef0bbf-2493-4c77-8af7-3a56fb2ce36e` |
| captured | 2026-09-05, from this machine's live `~/.claude/projects/` |
| lines | 2,028 parsed, **0 malformed** |
| versions on the lines | `2.1.258` ×1,225 and `2.1.260` ×201 |
| subagents | 3, each with its `.meta.json` sidecar |
| `tool-results/` | 1 offloaded payload |
| tool calls | `Bash` 218 · `Read` 39 · `Write` 32 · `Edit` 18 · `Skill` 3 · `Agent` 3 · `ToolSearch` 2 · `TaskStop` 1 |

**The directory is named `cc-2.1.260`, and the majority of its lines say `2.1.258`.** That is
deliberate and it is the honest name: **both compaction entries are written by `2.1.260`**, and the
compaction entries are the reason the corpus exists. Naming it for the majority version would name
it for the half that proves nothing. The version is read from the transcript's own `version` field,
never from the binary on `PATH` — the recorded rule, and this session is its own illustration, since
one binary wrote lines under two version strings.

## The two compaction entries

The structural entry is `type: "system"` carrying a `compactMetadata` object. Each is immediately
followed by a `type: "user"` entry with `isCompactSummary: true` — the summary CC injects in place
of what it dropped.

| line | type | `trigger` | `preTokens` | `postTokens` | `cumulativeDroppedTokens` |
|---:|---|---|---:|---:|---:|
| **1933** | `system` | **`auto`** | 967,149 | 20,346 | 946,803 |
| 1934 | `user` | — (`isCompactSummary: true`) | | | |
| **2006** | `system` | **`manual`** (a `/compact`) | 276,178 | 24,938 | 1,198,043 |
| 2007 | `user` | — (`isCompactSummary: true`) | | | |

**Do their shapes match? YES — the key sets are identical**, measured rather than eyeballed. Both
`compactMetadata` objects carry exactly:

`cumulativeDroppedTokens`, `durationMs`, `postTokens`, `preCompactDiscoveredTools`, `preTokens`,
`preservedMessages`, `preservedSegment`, `trigger`

They differ only in **key order** within the object, which JSON does not carry meaning in, and in
their values. So per the locked Phase 0 answer: **a manual `/compact` is a valid F12 fixture
source** — one reader handles both, and `trigger` is what separates them, so F12 can record
`source: 'auto' | 'manual'` from the entry itself with nothing inferred.

**`preTokens` and `postTokens` are stated by the entry.** F12 wanted "prompt tokens on the turn
before and after **where the entries state them**"; here they are stated outright, so that half of
F12 needs no turn-walking at all.

## What was done to the bytes

Two redactors, in this order. Both are the existing route; neither is new for this corpus.

1. **`lab/tools/redact-paths.mjs`** (identity-token driven, 45 tokens, the private set) —
   `files=8 changed=4 renamed=0 exempt=0 **skipped=0**`, 905 replacements across ten token classes.
2. **`scripts/redact-paths.mjs`** (path shapes → `<HOME>`/`<USER>`/`<HOST>`) — `files=8 skipped=0
   changed=4`, 1,175 hits.

Before either, the repository path and the project slug were rewritten to the same scrubbed form
every other committed CC corpus already carries — slug `c--Users-dev-projects-agent-deck`, `cwd`
`C:\Users\dev\projects\agent-deck` — in the four spellings the harvest reached (JSON-escaped, Windows,
forward-slash, MSYS). 2,671 replacements.

**A FIFTH SPELLING SURVIVED THE FIRST PASS AND WAS REPAIRED.** The composition of three correct
steps produced one incorrect result: occurrences the repo-path rewrite did not reach (a different
escaping depth) were caught piecemeal by the two redactors instead — the identity redactor mapped
the home-folder name, and the path redactor replaced the drive-and-user prefix — leaving
**371 occurrences of `<HOME>\Documents\projects\agent-deck`, 123 of them as `cwd` values**. Same
directory, spelled a fourth way, in a corpus whose slug says otherwise.

It was **privacy-safe** — over-redaction, never under — and it was still wrong: `projectSlug` is
derived from the slug directory and correlated against `cwd`, so 123 lines would have correlated
against nothing, and a future test joining the two would have reported a defect that was really a
fixture artefact. Every other captured CC corpus carries exactly **one** distinct `cwd`.

Repaired by rewriting that spelling to the first. The corpus now carries **three** `cwd` values,
all consistent: the root (1,015), `root\lab` (789) and `root\lab\docs` (3). The 358 remaining
`<HOME>` placeholders are OTHER directories and are correctly redacted — `<HOME>` in a `cwd` is an
established form here (`synthetic-dropped-actions` uses it); what was not established is one corpus
using two spellings of one root. Found by `phase-verifier`, 2026-09-05.

**The slug needs its own step because the redactor deliberately will not touch it**: the slug uses
`-` as its separator so no absolute-path pattern matches it, and it is a **join key**
(`projectSlug`; `src/opencode/slug.ts` pins the two engines' agreement on it). It is also identity
token #1, and the identity class has **no allow rule** — a hit fails the gate outright. Leaving it
alone was therefore not an option, and rewriting it by hand was.

**`node scripts/privacy-sweep.mjs --untracked` → `VERDICT PASS identity=0 secrets=0 foreign=0`.**
It read `FAIL identity=527` before the identity redactor ran, on the untracked working tree, which
is the order that matters: nothing was committed until it read zero.

**What redaction did NOT move**, verified after the fact: line count, parse result (2,028 / 0
malformed), both version strings and their counts, every tool-call name and count, all three
sidecars, the offloaded payload, and both `compactMetadata` objects including every token figure in
the table above.

## What this corpus does not prove

- **Nothing about compaction on any other engine.** OpenCode has its own `compaction` part shape
  (see the OpenCode pair's READMEs) and Codex's is unmeasured. F12 per engine is a Phase 0 question
  answered in `docs/evidence/phase-0-stats/VERDICT.md`, not here.
- **Nothing about a compaction that CC writes differently.** Two entries from one session on one
  version pair is a witness, not a census; a third trigger value, or a `compactMetadata` without
  `preTokens`, would be new information.
- **It is not the provenance anchor.** `src/parser/fingerprint.ts`'s `PINNED_CC_VERSION` is
  unchanged and still names `cc-2.1.246`. This corpus moves no anchor and no version window.

---

# The second session: `99f96635-…` — the STALL session

Captured 2026-09-06 for v0.7.0 Phase 0c, DoD 0c.1, by the same route and into the same corpus
directory, because it is the same Claude Code version. **This corpus now holds two sessions**; the
compaction session above is unchanged and nothing in this harvest touched it.

**Why it exists.** Observed live by the user on 2026-09-05: a tool ran for a quarter of an hour
without completing, the session card read `idle` (correct, per the liveness matrix) and the agent
view read `running` (wrong — a `ToolNode` that started and never completed stays `running`
indefinitely, with no evidence of progress). A user nudge resumed it. This session is that event,
and it is the corpus Phase 0c's reproduction is built from.

## The stall, at both levels

**The plan's "Why" says a shell tool hung. That is right about the CHILD and it is not the whole
event** — the never-completing call exists at *two* levels, and stall detection has to flag both or
the outer card stays wrong:

| | outer | inner |
|---|---|---|
| where | main transcript | `subagents/agent-a7d51ba7a0fe16c4b.jsonl` |
| tool | `Agent` (spawns a `phase-verifier`) | `Bash` |
| `tool_use_id` | `toolu_01NTu6y7z1wxWDtCDxMCQge4` | `toolu_018fuffcyA46w1xfU6Wpcj5z` |
| **ordinal** | **161 of 191** (`Agent` #2 of 3) | **38 of 38** (shell #37 of 37) |
| **started** | **`2026-09-05T09:36:28.071Z`** | **`2026-09-05T09:40:27.418Z`** |
| `tool_result` | **never** | **never** |

The inner call is the **last entry in its transcript** — the subagent wrote nothing after issuing it.
The join is the sidecar's own `meta.toolUseId`, which names the outer call exactly:
`agent-a7d51ba7a0fe16c4b.meta.json` carries `"toolUseId": "toolu_01NTu6y7z1wxWDtCDxMCQge4"`.

**The nesting is the rule this corpus pins: a stalled child implies a stalled parent spawn.** The
parent is not merely *also* stalled by coincidence of timing — it cannot complete until its child
does, so any derivation that flags the child and not the parent leaves the deck showing a
`running` agent forever, which is the reported defect.

## The three facts, and where each comes from

**The times are measured from the transcript, not from recollection.** The user supplied the
identification (which call, and that the nudge is the "did you get stuck?" message) and confirmed
the measured values; the numbers below are read off the bytes in this corpus.

| fact | value |
|---|---|
| hung tool (inner) | `Bash`, ordinal **38 of 38**, shell **#37 of 37**, in `agent-a7d51ba7a0fe16c4b` |
| hung tool (outer) | `Agent`, ordinal **161 of 191**, in the main transcript |
| start (inner) | `2026-09-05T09:40:27.418Z` |
| start (outer) | `2026-09-05T09:36:28.071Z` |
| **nudge / resume** | **`2026-09-05T09:54:40.711Z`** — the user message `did you get stuck?` |
| stalled span (outer) | **18 m 12.6 s** (1,092,640 ms) — exceeds the 120 s threshold by 16 m 12.6 s |
| stalled span (inner) | **14 m 13.3 s** (853,293 ms) — exceeds the 120 s threshold by 12 m 13.3 s |

After the nudge the orchestrator re-dispatched a fresh verifier at `09:55:22.635Z`, which completed
normally at `10:19:02.286Z`. **The stalled calls never completed at all** — no `tool_result` for
either is present anywhere in the corpus.

## What the hung command was, and what this corpus does NOT establish about it

The inner command is a `node -e` privacy audit that reads three fixture transcripts with
`readFileSync(f, 'latin1')` and scans them with `indexOf` for identity-shaped needles.

**Whether the command hung or the subagent process died is NOT distinguishable from these bytes**,
and this README does not claim either. The transcript simply stops. That ambiguity costs the phase
nothing, because the two are indistinguishable *to the product* as well: in both cases a `ToolNode`
is `running`, nothing is arriving, and the deck has no way to tell the user so. That is the defect
being fixed, and it is why the fix is keyed on observed activity rather than on a cause.

## Four calls cross the threshold AND complete — the corpus holds both arms

This was not harvested for, and it is worth more than the stall alone: the same session contains
four calls that exceed 120 s and then finish, so "crossed the threshold" and "never completed" are
separable in real captured data rather than only in synthetic fixtures.

| ordinal | tool | duration | completes? |
|---:|---|---:|---|
| 24 | `AskUserQuestion` | 167.1 s | yes |
| 160 | `Agent` | 2,846.6 s (47 m) | yes |
| **161** | **`Agent`** | **—** | **NEVER — the stall** |
| 162 | `Agent` | 1,419.7 s (23.7 m) | yes |
| 181 | `Bash` (#141), a 3× `vitest` loop | 189.2 s | yes |

**Ordinal 160 is the control that makes the design defensible.** It ran 47 minutes and must NOT be
flagged, because its subagent was firing hooks the whole time and `lastActivityAt` is the LATER of
the last hook event and the transcript mtime. Ordinal 161 differs precisely in that its subagent
went silent at `09:40:27` and nothing arrived afterwards. **The two are 2,846 s and 1,092 s apart in
duration and the shorter one is the defect** — which is the evidence that duration is the wrong
signal and observed activity is the right one.

**Ordinal 24 is a recorded FALSE POSITIVE and it is not designed around.** `AskUserQuestion` waits
on a human: it is `running`, it emits no hooks and appends nothing, so under the locked Phase 0c
definition it *will* be flagged after 120 s. The definition is locked (Phase 0c open questions,
2026-09-05), so this corpus records the consequence rather than quietly widening the rule. Whether
a human-waiting tool should be exempt is a product question, and it is the user's.

## Provenance

| | |
|---|---|
| session | `99f96635-2042-41dc-9000-bbc9f9233bc3` |
| captured | 2026-09-06, from this machine's live `~/.claude/projects/` |
| lines | **1,133 parsed, 0 malformed** |
| version on the lines | `2.1.260` ×831 — a single version, unlike the compaction session |
| subagents | 3, each with its `.meta.json` sidecar, all `agentType: phase-verifier` |
| `tool-results/` | none for this session |
| tool calls | `Bash` 148 · `Write` 21 · `Edit` 16 · `Agent` 3 · `Skill` 2 · `AskUserQuestion` 1 = **191** |
| unresolved tool calls | **2** — one per level, listed above |
| distinct `cwd` | **3** |

## What was done to the bytes

The same route as the compaction session, and one deliberate difference.

1. **The repo path and slug were rewritten first, in ALL six spellings at once** — `2,325`
   replacements: JSON-escaped Windows (upper 1,162 / lower 669), forward-slash (13 / 1), MSYS (221)
   and the slug (259). Target: slug `c--Users-dev-projects-agent-deck`, root
   `C:\Users\dev\projects\agent-deck`.
2. **`lab/tools/redact-paths.mjs`** (identity, 45 tokens) — `files=15 changed=4 renamed=0 exempt=0
   **skipped=0**`, 457 replacements across ten token classes.
3. **`scripts/redact-paths.mjs`** (path shapes) — `files=15 **skipped=0** changed=0`, **`hits={}`**.

**Step 3 finding nothing is the point, and it is the fix for a recorded defect.** The compaction
session's harvest left 371 occurrences of a FIFTH spelling because the hand rewrite missed an
escaping depth and the two redactors then caught the remainder piecemeal, at different depths,
producing one corpus that spelled its own root two ways. Here every spelling was **censused before
anything was rewritten** and all six were rewritten in one pass, so nothing was left for the later
steps to catch inconsistently. A residual census confirms **0** occurrences of all six.

**`node scripts/privacy-sweep.mjs --untracked` read `VERDICT FAIL identity=176` before the identity
redactor and `VERDICT PASS identity=0 secrets=0 telemetry=0 foreign=0` (exit 0) after.** That
FAIL→PASS transition is also the proof the new files were actually SCANNED rather than skipped —
a PASS alone would not distinguish the two (rule 18).

**`cwd` distinct count is 3 before redaction and 3 after**, which is the check the compaction
session's defect taught. The three are the drive-letter case pair — `C:\Users\dev\projects\agent-deck`
(795) and `c:\Users\dev\projects\agent-deck` (26) — plus `…\agent-deck\lab` (10). **The case
variation is preserved deliberately**: `CLAUDE.md` records that project-slug drive-letter case
varies on Windows and must be matched case-insensitively, and collapsing the pair would have
destroyed the only real captured witness to it in this repository.

**What redaction did NOT move**, compared field by field before and after: line counts (1,133 /
421 / 126 / 330), 0 malformed, the version string and its count, every tool name and count, all
three `.meta.json` files including their exact contents, and — the ones this corpus exists for —
**both unresolved `tool_use` ids, at both levels**.

**Two identity-shaped words survive on purpose and neither is a leak.** `nvitlam` ×36 is the
lowercase **Marketplace publisher id**, already public in `package.json`'s `publisher` field; the
identity redactor preserves it by design (its own hit label says "case-sensitive, so the lowercase
Marketplace publisher id survives"). `gmail` ×5 appears only inside the subagent's own audit script
and that script's output — `needles=['dev','dev','dev','nvitlam','vitlam','gmail',…]` — as a
**needle in a scanner**, never as an address. Every email-shaped string in the corpus is
`noreply@anthropic.com`, `dev@users.noreply.github.com` or `dev@example.invalid`.

**One consequence worth stating plainly: the redactors rewrote the embedded audit script's own
needle list.** Its first three needles now read `'dev','dev','dev'` where the original named real
identity tokens. The script text in this corpus therefore does **not** read as it was written. That
is content, not structure, and no test reads it — but a reader who finds a scanner searching for
`'dev'` three times should know why rather than file it as a defect. It is also this repository's
recorded "the corpus contains the instructions that produced it" trap arriving one layer further
in: a substring search over these records can match the *audit* rather than the *behaviour*.

## What this corpus does not prove

- **Nothing about stalls on any other engine.** OpenCode and Codex tool-completion shapes are their
  own question; F13 per engine is settled in Phase 2's fact table, not here.
- **Nothing about the CAUSE of a stall.** See above — hang and process death are indistinguishable
  in these bytes, by construction.
- **It is not the provenance anchor.** `PINNED_CC_VERSION` still names `cc-2.1.246`. This session
  moves no anchor and no version window, exactly as the compaction session moved none.
- **One session is a witness, not a census.** Two never-completing calls at two levels is enough to
  pin the shape and the nesting; it says nothing about how often stalls occur, or about a stall
  whose parent is a session root rather than an `Agent` spawn.
