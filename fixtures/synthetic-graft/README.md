# `fixtures/synthetic-graft/` — HAND-MADE, NOT CAPTURED DATA

Everything under this directory is **synthetic**. None of it came out of a real Claude Code
session. It was written by hand to make `src/parser/attribution.ts` prove that it refuses to guess
a parent when the primary key is absent, ambiguous, or contradicted.

G6 says fixtures are law. That law only works if captured data and invented data are never
confused, so:

- **Captured data lives in `fixtures/cc-2.1.234/`** and is ground truth for what CC 2.1.234
  actually writes. Never edit it. If the resolver disagrees with it, the resolver is wrong.
- **This directory is invented.** Never cite it as evidence of CC's behaviour. It is evidence of
  *our* behaviour: what Agent Deck does when the join key is broken.

Markers that keep the two apart, matching `fixtures/synthetic-layout/`:

- the project-slug directory in every case is literally named
  `SYNTHETIC-hand-mutated-not-captured`;
- the session id is `deadbeef-0000-4000-8000-0000000000a1` (distinct from `synthetic-layout`'s
  `…-000000000001`, so the two invented trees cannot be mixed up either) and the agent ids are
  `agraft0000000001` / `agraft0000000002`;
- message text is `SYNTHETIC FIXTURE` / `SYNTHETIC REPLY` / `SYNTHETIC SUBAGENT PROMPT`; tool ids
  are `toolu_GRAFT…`.

Each case is a complete miniature projects tree — `<case>/<slug>/…` — of two or three lines per
file, so the mutation is readable at a glance. Six of the seven are *layout-valid* sessions:
`fingerprintSession` accepts them, because the point is what happens **after** the schema
fingerprint passes. Layout refusals are `fixtures/synthetic-layout/`'s job, not this directory's —
with one deliberate overlap, `02-tool-use-id-whitespace`, noted below. Since Phase 2 the layout
fingerprint refuses a blank `toolUseId`, so that case is now refused twice: once at the layout
boundary and once at the join.
All files use LF endings (`.gitattributes` marks `fixtures/** -text`).

## Cases

Each case is asserted individually by its own expected outcome in
`src/parser/attribution.test.ts`. A test asserting only "none of these resolved" would pass while
every case failed for the wrong reason.

| case | agent | expected outcome |
| --- | --- | --- |
| `00-valid-control` | `agraft0000000001` | `resolved`, parent = main transcript, depth 1 |
| | `agraft0000000002` | `resolved`, parent = agent `…0001`'s transcript, depth 2, no depth mismatch |
| `01-tool-use-id-matches-nothing` | `agraft0000000001` | `unresolved` / `noMatchingToolUse` |
| `02-tool-use-id-whitespace` | `agraft0000000001` | `unresolved` / `missingJoinKey` |
| `03-tool-use-id-duplicated` | `agraft0000000001` | `resolved` (its own key is unique) |
| | `agraft0000000002` | `ambiguous`, 2 candidates |
| `04-parent-agent-missing` | `agraft0000000002` | `unresolved` / `parentAgentMissing` |
| `05-spawn-depth-contradicts-chain` | `agraft0000000002` | `resolved`, with a depth mismatch (recorded 1, computed 2) |
| `06-one-resolves-one-does-not` | `agraft0000000001` | `resolved` |
| | `agraft0000000002` | `unresolved` / `noMatchingToolUse` |

## The three cases worth re-reading before changing anything

- **`02-tool-use-id-whitespace`** is the "only one candidate left" trap. The session contains
  exactly one `Agent` `tool_use` block and exactly one subagent, so a resolver that falls back to
  the sole remaining candidate produces a confident, plausible, wrong answer. The key is a
  whitespace-only string. `fingerprint.ts` used to accept it — it type-checked the field, and
  `"   "` is a string — which made the resolver the only thing standing between this sidecar and a
  wrong parent. Phase 2 moved that refusal to the layout boundary as well
  (`metaFieldMissing` / `actual: 'blank'`, pinned by
  `fixtures/synthetic-layout/21-meta-tooluseid-whitespace`), so `attribution.test.ts` now feeds
  this case to `attributeSubagents` **directly**, without the fingerprint in front. That is defence
  in depth, not redundancy: `attributeSubagents` is a pure function other callers can reach, and a
  key can be well-formed at the layout boundary and still unjoinable at the join.
- **`04-parent-agent-missing`** is the "reattach to main" trap. The orphan's `toolUseId` really
  does match a `tool_use` block in the main transcript, so the tempting wrong answer is available
  and looks correct. `parentAgentId` names an agent that has no transcript and no sidecar, so the
  session cannot support that edge and the answer is `unresolved`.
- **`05-spawn-depth-contradicts-chain`** is the one case that stays *resolved*. The sidecar's
  `spawnDepth` disagrees with the depth walked from the resolved parent chain; the disagreement is
  reported and neither number is rewritten. Silently trusting either one would erase the evidence
  that the two sources disagree.

## What is deliberately NOT here

The 1,000+ corrupted lines of `src/parser/fuzz.test.ts` are generated in the test from a fixed
seed, not committed. A generated corpus in a fixture directory would be neither captured data nor
hand-readable, which is the worst of both.
