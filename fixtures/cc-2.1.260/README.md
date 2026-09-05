# `cc-2.1.260` — the COMPACTION corpus

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
