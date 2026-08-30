# `fixtures/cc-2.1.251/` — a witness, not a new anchor

**Captured 2026-08-31** on Claude Code **2.1.251**, five patch releases past the provenance
anchor. Diagnosis and every measurement quoted here:
`docs/evidence/release-0.5.0/DRIFT-2.1.251.md` §3.

## Why it exists

2.1.251 was reported as refusing every new Claude Code session. It does not. The version window
(`2.0.x` – `2.2.x`, patch not compared) accepts it, and the **structure has not moved**:

| Compared against `fixtures/cc-2.1.246/` | Result |
|---|---|
| Main transcript, per-type field sets | identical — nothing added, renamed or removed |
| Subagent transcript | identical, plus two optional fields on one line |
| Sidecar (`agent-*.meta.json`) join keys | **identical** — `agentType`, `description`, `spawnDepth`, `toolUseId` |

Two record kinds appear that the anchor capture does not contain — `ai-title` and
`bridge-session`. Neither refuses: `ai-title` is already in `REQUIRED_ENTRY_FIELDS`, and an
unlisted `type` requires only `type` itself. `bridge-session` is new since the anchor and carries
account and organization UUIDs, which is worth knowing before any future capture is redacted.

**`PINNED_CC_VERSION` does not move, and this corpus is not an argument that it should.** The
anchor names the release whose structure was proved against real bytes; moving it cannot make a
version work, because the patch component is not compared at all. What this corpus buys is that
"2.1.251 is structurally the anchor's shape" is a test over committed bytes
(`src/parser/corpus.test.ts`) rather than a sentence in an evidence file.

## What is in it

```
projects/c--Users-dev-projects-agent-deck/
  0bee1577-….jsonl                              a flat session, no subagents
  d16538d5-….jsonl                              the R1 mirror pair, main transcript
  d16538d5-…/subagents/agent-ab761d54060e2e548.jsonl
  d16538d5-…/subagents/agent-ab761d54060e2e548.meta.json
```

The R1 pair is the one that matters: one subagent, its sidecar, and a `toolUseId` that is a real
`tool_use` block in the main transcript. `corpus.test.ts` asserts the join as a **count**, not as
an example — every sidecar in the capture joins, which is the "100%" claim the anchor's own test
makes.

## What is NOT in it, and why

A **third session was captured the same day and did not cross the gate**: the `--teleport` import
that actually refused. Its 465 imported message bodies carry developer identifiers that the path
redactor does not touch — it rewrites path shapes, and these are prose — so promoting it would
have shipped 127 identity hits into the public tree. It stays in the maintainer's private
`lab/fixtures-raw/cc-2.1.251/`.

The refusal it witnesses is not lost: `src/bridge/refusal.test.ts` builds a transcript with the
same shape (a `version` string the window cannot parse) in a temp directory, and `README.md`
carries the user-facing caveat. What is lost is a *captured* witness for it, which is why the
README says "not supported" rather than describing what `--teleport` does — one observation is not
a description of somebody else's product.

## Redaction

`scripts/redact-paths.mjs` ran over the raw capture first: 4 of 5 files changed, hits
`home-win-json 643 · home-win-fwd 15 · home-msys 93 · user 51`. Thinking blocks were already
dropped at parse.

**One further substitution was applied at promotion, and it is not cosmetic.** The redactor leaves
the project slug alone deliberately — it is a join key, and its `-` separators match no path
pattern — so the raw capture's slug directory still spelled the capturing machine's home path. It
could not simply be tokenised either: the redactor's `<HOME>` token contains `<` and `>`, which
Windows forbids in a directory name.

So the capture's workspace path was rewritten to the one the other four corpora already use:

```
<HOME>\<the capture machine's folder chain>\agent-deck   ->   C:\Users\dev\projects\agent-deck
```

The left-hand side is written as a shape rather than as the chain itself, and that is not
squeamishness: `scripts/privacy-sweep.mjs` flagged this very line when it named the real folders.
A README explaining a redaction is as much in scope for the sweep as the bytes it describes.

54 occurrences across the four files, plus the slug directory's own name. Nothing else changed:
every `uuid`, `parentUuid`, `sessionId`, `agentId`, `toolUseId`, `spawnDepth`, timestamp and
`tool_use` ordinal is the captured value. The result is that this corpus shares `SLUG` with the
other four and needs no special case in `corpus.test.ts`.

Verified after promotion: **0** residual `<HOME>` tokens, **0** case-insensitive hits for the
capturing user or their cloud-sync folder, in all four files.
