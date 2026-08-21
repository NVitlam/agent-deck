# `fixtures/synthetic-perf/` — calibration scaffolding, **not** the DoD's harvest

Read this before quoting any number that came out of `src/perf/`.

## What this is not

PLAN's Phase 4 answers *"where does the perf DoD's ≥10k-line session come from?"* with **"a live
extended R2 run, harvested"**, and refuses the alternative in the same sentence: *"Not synthesised: a
programmatically amplified transcript is not a harvest, and this DoD is the one that measures
behaviour against real offloading, real depth and real concurrency."*

This directory is not that harvest and cannot become it. `build-corpus.mjs` emits a tree shaped like
CC 2.1.234's layout, from a seeded generator, with invented content. Every number measured on it is
**calibration**: it proves the harness runs, that its thresholds are wired, and that the assertions
fire — it proves nothing about how the product behaves against a real session.

The corpus names itself in the one place a reader cannot miss. Its workspace slug on disk is
literally:

```
C--SYNTHETIC-PERF-not-a-harvest
```

so a stray path, log line or error message carrying that string is self-labelling.

## Why it exists anyway

The harvest is a human action — the orchestrator cannot open Claude Code sessions — and PLAN gates
the perf package on it. Building the harness *after* the harvest would have serialised two things
that had no reason to be serialised. So the harness was built first, against this corpus, under one
rule: **pointing it at the real harvest must be a configuration change, never a code change.**

That rule is what `src/perf/corpus.ts` implements:

| environment | origin | what it measures |
|---|---|---|
| `AGENT_DECK_PERF_ROOT=<projects root>` | `supplied` | that root's largest session |
| `CLAUDE_PROJECTS_ROOT=<projects root>` | `supplied` | same, as a fallback |
| neither set | `synthetic` | this generator's output, in an OS temp dir |

`AGENT_DECK_PERF_ROOT` deliberately wins over `CLAUDE_PROJECTS_ROOT`. The latter is set repo-wide for
fixture replay and points at `fixtures/cc-2.1.234/projects`, whose largest session is 22 lines — a
harness that read it first would measure a 22-line session and report a number that looks wonderful
and means nothing. Either way the ≥10k-line precondition is **asserted, not assumed**: too small a
corpus fails loudly.

When the harvest lands, drop it under `fixtures/cc-<version>/` per PLAN's harvest rule and run:

```
AGENT_DECK_PERF_ROOT=fixtures/cc-<version>/projects npx vitest run src/perf
```

The reported `origin` flips to `supplied`, and `isDodHarvest` in the emitted report becomes true.
Only numbers carrying `origin=supplied` may be cited against DoD item 2.

## Running the generator directly

```
node fixtures/synthetic-perf/build-corpus.mjs --out <dir> [--lines N] [--subagents K] [--seed S]
```

`--out` is required and nothing is ever written into the repo tree; the harness always points it at a
temp directory, and `src/perf/perf.test.ts` asserts that the staged corpus is outside the repo.

**Determinism is load-bearing.** `Date.now()` and `Math.random()` appear nowhere in the generator;
every varying value comes from a seeded LCG and every timestamp from a fixed epoch. Two runs with the
same arguments produce byte-identical trees, and `src/perf/perf.test.ts` proves it by generating
twice and comparing SHA-256 digests — rather than by pinning a digest literal, which would rot the
first time the generator changes.

The corpus is generated, never committed: at the default size it is ~17 MB, and a committed blob that
large would have to be re-reviewed on every regeneration for a file nothing reads by hand.

## What the harness found — and why one budget is recorded rather than enforced

The DoD asks for a post-append tree update **under 100 ms**. On this corpus it is not met, and the
harness says so in `src/perf/budgets.ts` instead of hiding it behind a skipped test. The cause is
architectural, and the stage breakdown names it: the incremental stages (tail poll, patch apply) run
in single-digit milliseconds, while `graftSession` — a whole-session re-graft performed on *every*
append by `src/extension.ts` — accounts for roughly 95% of the total.

That is a finding about the product, not about this corpus, and it is the kind of thing a perf DoD
exists to surface. It is left unfixed here deliberately: `src/extension.ts` and `src/model/graft.ts`
are owned elsewhere, and rewriting the update path is not a change to make inside a measurement
package. `AGENT_DECK_PERF_ASSERT=1` enforces the 100 ms budget on demand, so the day the
architecture can pass it, flipping `enforced` to `true` is a one-line change.

**The absolute milliseconds in `budgets.ts` are machine- and load-dependent and are recorded with the
conditions they were taken under.** Do not treat them as properties of the code. The ratio between
stages — incremental work in single digits, re-graft dominating — is the durable observation; the
wall-clock totals are not.
