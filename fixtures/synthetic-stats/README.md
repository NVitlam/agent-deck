# `fixtures/synthetic-stats/` — the R8 manufactured sessions

v0.7.0 Phase 2. Thirteen committed `SessionState` documents, one per shape the harvested
corpora cannot supply, named for what each manufactures. `PLAN.md`'s Swarm Self-Test
Protocol R8 names the first twelve; the thirteenth is below.

**Written only by `node scripts/gen-stats-goldens.mjs`**, from
`src/stats/synthetic.testkit.ts`. Never by hand — `goldens.test.ts` rebuilds each one and
compares byte for byte, so an edit here that the builder does not produce goes red.

Each file carries `id`, `manufactures` (the one shape it exists for, in a sentence) and
`state` (the input). The `StatsRecord` each produces is committed beside it as
`fixtures/golden/stats/<engine>-synthetic-<id>.json`.

| id | manufactures |
|---|---|
| `01-reread-loop` | three identical calls in one agent, beside a pair one short of `LOOP_MIN` |
| `02-churn-chain` | write → error → write, beside a write pair with a SUCCESS between them |
| `03-silent-subagent` | a spawned agent with zero tool calls, beside one that made a call |
| `04-context-spike` | a delta clearing `SPIKE_TOKENS.cc`, and one short by a single token |
| `05-excluded-parked` | a parked graft over a tree that would otherwise yield a loop and a file row |
| `06-no-cache-fields` | an agent with no `usageSeries`, so F6 has no numerator |
| `07-oversize-input` | identical truncated previews with DIFFERENT hashes |
| `08-codex-window` | a Codex session stating `windowTokens`, so F10 has both halves |
| `09-opencode-cost` | a non-zero `session.cost` — no captured store has one |
| `10-compaction` | one structural compaction entry with trigger and both token figures |
| `11-user-priced` | a model id matching a test `agentDeck.pricing` entry |
| `12-stall` | a tool past the stall threshold, beside one that ran 47 minutes and completed |
| `13-telemetry-cost` | Claude Code's own OTel cost estimate, joined by `session.id` |

## Why these are hand-built, and what it costs

The deriver's contract is `SessionState -> StatsRecord`, so a `SessionState` is its honest
input. The 23 harvested sessions are what prove the PRODUCTION path; these prove the deriver
over shapes no real session here contains.

The cost, stated rather than left to be found: a hand-built state could describe a session no
engine can produce, and its golden would then pin behaviour over an impossible input. Two
things bound that. `goldens.test.ts` validates every record these produce, and every VALUE
that could have been invented is instead taken from something measured — the compaction key
set from `cc-2.1.260`, the Codex window from the anchor corpus's own `258400`, and fixture
13's cost and session id read out of the committed OTel capture through the real
`joinTelemetry`.

## Three of them exist because the corpora provably cannot supply the shape

- **`09-opencode-cost`** — `VERDICT.md` 0.4: `session.cost` is **0 across all three
  committed stores and 30 sessions**, and `costUsd: 0` means *not computed*. F9(a) is real
  and unwitnessed here.
- **`11-user-priced`** — `agentDeck.pricing` is `{}` by default and this repository ships no
  price table, which is a non-goal rather than a gap. It was always going to be manufactured.
- **`13-telemetry-cost`** — an addition to R8, not one of its twelve, because F9(c) postdates
  that list: spec §L adds Claude Code telemetry as a third cost source after Phase 0b
  returned IN. Its session id is the OTel capture's own rather than a `synthetic-` one,
  because the join is BY `session.id` — renaming it would make `joinTelemetry` match nothing
  and the fixture would manufacture no cost at all.

## Naming

Every id and slug carries `synthetic-`, which R8 requires and the privacy sweep depends on: a
fixture whose slug looked like a real project would be indistinguishable from a capture in
every inventory this repository keeps. Fixture 13's session id is the one exception, for the
reason above.
