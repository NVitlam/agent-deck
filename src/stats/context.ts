/**
 * F6 (cache ratio), F7 (context churn), F10 (context fill) and F12
 * (compactions) — everything derived from the token series and the window.
 *
 * v0.7.0 Phase 2.
 *
 * ## Every one of these is PRESENCE-GATED, and that is the whole design
 *
 * Spec §D: *"A field an engine does not supply yields `unavailable:<engine>`
 * for the facts that need it — never a substitute."* So each function here
 * returns `undefined` rather than `0` when its input is absent, and `derive.ts`
 * turns each `undefined` into a named row in `unavailable`. The distinction is
 * not pedantry: this project has already measured a field that is PRESENT and
 * identically zero (OpenCode's `session.cost`, 0 across 30 sessions) and the
 * existing contract says `costUsd: 0` means *not computed*. A ratio of 0 and an
 * absent ratio are different facts and the record states which.
 */

import type { AgentNode, SessionState, UsageTurn } from '../model/events.js';

import type { CompactionStat, ContextChurnRecord } from './schema.js';

/**
 * F6 — `cacheRead / prompt` for one agent.
 *
 * The numerator comes from the agent's own `usageSeries`, summed over turns.
 * The denominator is `burn.prompt`, which is what the existing token contract
 * calls the whole prompt cost of the agent — `input + cacheCreation +
 * cacheRead` on Claude Code — so the ratio answers "how much of what this agent
 * paid for its prompt was a cache hit".
 *
 * `undefined` when the engine states no series (Codex today) or when `prompt`
 * is 0, because a ratio over an empty denominator is not 0, it is nothing.
 *
 * ## A §D branch with no implementation, stated rather than left to be found
 *
 * Spec §D allows F6 from "per-turn series (§E) **or engine totals where the
 * split is stated**". Only the series branch exists here. That is not a gap
 * today: no engine's `SessionState` carries a prompt/cache split at the totals
 * level — `TokenPair` is `{ prompt, output }` and nothing else — so the second
 * branch has no field to read and writing it would be code against a shape
 * nobody has captured, which is G6. Raised by `phase-verifier` at the Phase 2
 * gate; recorded here so the day a totals split appears, this is the line that
 * says what to do with it rather than the branch being re-derived from scratch.
 */
export function cacheRatioOf(agent: AgentNode): { cacheRead?: number; cacheRatio?: number } {
  const series = agent.usageSeries;
  if (series === undefined || series.length === 0) return {};
  const cacheRead = series.reduce((sum, turn) => sum + turn.cacheRead, 0);
  const prompt = agent.burn?.prompt ?? 0;
  if (prompt <= 0) return { cacheRead };
  return { cacheRead, cacheRatio: cacheRead / prompt };
}

/**
 * F7 — turns whose cache-creation rose by at least `spikeTokens` over the
 * previous turn.
 *
 * A DELTA, not a level, and spec §D names the delta explicitly. VERDICT.md 0.6
 * tabulates both quantities side by side precisely because a reader who assumed
 * the level would derive a different constant (8,768 -> 9,000 rather than
 * 4,543 -> 5,000).
 *
 * `threshold === undefined` means this engine has no measured threshold, and
 * the answer is `undefined` — never an empty list, which would read as "this
 * engine was measured and found no spikes".
 */
export function deriveContextChurn(
  agents: readonly { agentId: string; series?: readonly UsageTurn[] }[],
  threshold: number | undefined,
): ContextChurnRecord[] | undefined {
  if (threshold === undefined) return undefined;
  const out: ContextChurnRecord[] = [];
  for (const agent of agents) {
    const series = agent.series;
    if (series === undefined || series.length < 2) continue;
    const ordered = [...series].sort((a, b) => a.ordinal - b.ordinal);
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const turn = ordered[i];
      if (previous === undefined || turn === undefined) continue;
      const delta = turn.cacheCreation - previous.cacheCreation;
      if (delta < threshold) continue;
      out.push({ agentId: agent.agentId, ordinal: turn.ordinal, delta });
    }
  }
  out.sort(
    (a, b) =>
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0) || a.ordinal - b.ordinal,
  );
  return out;
}

/**
 * F10 — `contextNow.prompt / windowTokens`, where the engine states both.
 *
 * Only Codex states a window (`model_context_window`), which VERDICT.md 0.4
 * records as `UNAVAILABLE:cc` and `UNAVAILABLE:opencode` — measured, and
 * exactly what spec §D predicted. There is deliberately NO model-to-window
 * lookup table: §B rules one out, and G6 would make one memory rather than
 * fixture.
 *
 * A window of 0 yields `undefined` rather than a division by zero, and a fill
 * above 1 is NOT clamped: a prompt larger than the stated window is a fact
 * about the session, and rounding it down to 1.0 would hide it.
 */
export function contextFillOf(state: SessionState): number | undefined {
  const window = state.windowTokens;
  const prompt = state.contextNow?.prompt;
  if (window === undefined || window <= 0) return undefined;
  if (prompt === undefined) return undefined;
  return prompt / window;
}

/**
 * F12 — every structural compaction entry the engines wrote, flattened with the
 * agent it belongs to.
 *
 * The entries are the engine's own: CC writes `type: "system"` with
 * `compactMetadata` (`trigger`, `preTokens`, `postTokens`, `durationMs`), and
 * OpenCode writes a `compaction` part with **no before/after token figures at
 * all** — so F12's token half is CC-only, and the optional fields on
 * `CompactionRecord` are what carry that. Codex writes no compaction entry of
 * any type (VERDICT.md 0.4: `UNAVAILABLE:codex`).
 */
export function deriveCompactions(
  agents: readonly AgentNode[],
): CompactionStat[] {
  const out: CompactionStat[] = [];
  for (const agent of agents) {
    for (const entry of agent.compactions ?? []) {
      out.push({ agentId: agent.id, ...entry });
    }
  }
  out.sort(
    (a, b) =>
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0) || a.ordinal - b.ordinal,
  );
  return out;
}
