# `fixtures/golden/stats/` — committed `StatsRecord` goldens

v0.7.0 Phase 2, DoD 2.3. One file per committed session of every engine, plus one per R8
fixture, named `<engine>-<version>-<session>.json`. Each is the canonical serialization of
the **`StatsRecord`** that `deriveStats()` produces for that session.

**Regenerated only by `node scripts/gen-stats-goldens.mjs`.** Never by hand.
`--check` compares and writes nothing, exiting 1 on any difference.

These are **derived** artefacts, not captured data — evidence about *our* stats engine, not
about any agent. The captured data they rest on lives in `fixtures/cc-*`, `fixtures/codex-*`,
`fixtures/opencode-*` and `fixtures/otel-cc-*`, and that is the only ground truth here (G6).

## Two populations, and the difference matters

- **`<engine>-<version>-<session>.json`** — a real harvested session, read through the
  PRODUCTION path: `SessionModel` for Claude Code, `readOpenCodeEngine`, `readCodexEngine`.
  These are what say the deriver works on real data.
- **`<engine>-synthetic-<id>.json`** — an R8 fixture from
  `src/stats/synthetic.testkit.ts`, manufacturing a shape no captured session in this
  repository contains: a non-zero engine cost, a user price table, a currently-stalled tool.
  `fixtures/synthetic-stats/` holds the `SessionState` each was derived from, so the input
  is reviewable on its own.

## Determinism — what had to be pinned, and why

A golden that changes when nothing changed is noise, and every later diff against it is a
false positive. Three things could have moved and are held still:

- **The clock.** `deriveStats` reads none; `now` is a parameter, fixed at
  `FIXED_NOW_MS` for the corpus half and `SYNTHETIC_NOW_MS` for R8. With no hook event
  ingested, no corpus session has a stalled tool, so F13 is empty for all of them by
  construction rather than by luck.
- **Codex mtimes.** `AgentNode.endedAt` for a finished Codex thread is `thread.mtimeMs`, and
  **git does not preserve mtimes across a checkout** — measured this phase: every Codex
  session reported `endedAt` = the mtime of its own rollout file in the working tree that
  produced it. The corpus is therefore staged into a temp copy with every file's mtime
  pinned before `readCodexEngine` sees it, the same fix `scripts/record-wire.mjs` already
  applies. The engine's own choice of source is untouched.
- **Prices.** The corpus half is derived with an EMPTY price table, which is the shipped
  default (`agentDeck.pricing` is `{}`). So these records are what a user with no
  configuration gets.

## What a golden pins, and what it does not

It pins the whole record byte for byte: every table, every total, every `unavailable` code.
It does **not** pin the corpus — a re-harvest that adds a session adds a golden, and
`goldens.test.ts` asserts the directory holds the exact set with the count beside it, so a
stale golden for a session that no longer exists fails rather than passing quietly forever.

An empty table is not the same as a missing fact. `coverage` says why a session has none,
and `unavailable` names each fact the engine could not supply — `F7:opencode`,
`F2.errors:codex`. A session that simply had no compaction says nothing there, because that
is a fact about the session rather than about the engine.
