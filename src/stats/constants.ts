/**
 * The stats engine's measurement parameters.
 *
 * v0.7.0 Phase 2, DoD 2.1. Two constants, both MEASURED, and this file's job is
 * to carry the measurement beside the number so nobody has to trust either.
 *
 * ## G10 — these are measurement parameters, not judgments
 *
 * `LOOP_MIN` is the repeat count at which a run of identical calls is REPORTED,
 * not the count at which repeating becomes a mistake. `SPIKE_TOKENS` is the
 * cache-creation delta at which a turn is reported, not the delta at which a
 * turn is wasteful. The Stats view displays both as the parameters they are.
 * Nothing in this file may acquire a name or a comment that says otherwise.
 *
 * ## Neither number is user-configurable in v0.7.0
 *
 * Deliberate, and it is what makes a committed golden mean anything: a record
 * derived under a threshold the reader can change is not comparable with the
 * one on disk. `DeriveParams` lets a TEST override them — which is how the
 * negative arm of every threshold is proven — and the record states the values
 * it was derived under in `params`, so a future reader can tell what produced
 * it.
 */

import type { StatsEngine } from './schema.js';

/**
 * Repeats of one `toolName` + `inputHash`, within ONE agent, at which F3
 * reports a loop.
 *
 * The spec default, CONFIRMED by measurement rather than moved.
 * `docs/evidence/phase-0-stats/VERDICT.md` DoD 0.6 counted repeat lengths of
 * every distinct call signature in every committed corpus:
 *
 *     scope      signatures   >=2   >=3   >=4   >=5   >=6   >=8   >=10
 *     anchors           281     4     2     2     1     1     1      0
 *     captured          889     5     3     3     2     1     1      0
 *
 * At 3 it selects **3 signatures in 889**; at 2 it selects 5. The distribution
 * is long-tailed and sparse, so nothing measured separates 3 from 4, and 3 is
 * kept because the spec names it. The three it selects are real and one per
 * engine: `Bash x 5` (cc-2.1.237), `task x 9` (opencode-1.18.22),
 * `wait_agent x 4` (codex).
 *
 * WITHIN ONE AGENT, and that is a locked open question rather than an
 * implementation convenience (`PLAN.md` Phase 2, user, 2026-09-05): a
 * cross-agent repeat is not a fact in v0.7.0, because two agents calling the
 * same tool with the same input is ordinary parallel work rather than a
 * repeat of anything.
 */
export const LOOP_MIN = 3;

/**
 * The turn-over-turn cache-creation delta at which F7 reports context churn —
 * **keyed by engine, and only Claude Code has one.**
 *
 * ## The absence of the other two keys is the finding, not an omission
 *
 * `agent-deck-spec.md` §L, dated 2026-09-05, supersedes VERDICT.md 0.6's single
 * cross-engine `4000`:
 *
 *   > `SPIKE_TOKENS` is keyed by engine: **`SPIKE_TOKENS.cc = 5000`**, the
 *   > smallest whole thousand at which <= 5 % of real CC turns qualify. No
 *   > other engine inherits it — only CC can produce F7.
 *
 * The measurement behind that, over the 709 captured turn-over-turn deltas:
 *
 *     engine   n    non-zero   p95     at >= 4,000   share
 *     cc       484       228   4,543            29   6.0 %
 *     opencode 181         0       0             0     0 %
 *     codex     44         0       0             0     0 %
 *
 * OpenCode's `tokens.cache.write` is **0 in all 210 `step-finish` rows across
 * all three stores**, and Codex never writes a positive
 * `cache_write_input_tokens` either. So 225 of the 709 denominator entries
 * **cannot qualify at any threshold**, and they are exactly what pulled the
 * mixed-engine figure under the 5 % ceiling. On CC alone the smallest whole
 * thousand satisfying <= 5 % is **5,000** (22 of 484 = 4.5 %).
 *
 * A cross-engine constant would therefore have been a number measured mostly
 * on rows structurally incapable of contributing to it. Giving the other two
 * engines no key at all is the honest encoding: the deriver reports
 * `F7:<engine>` in `unavailable` rather than applying a threshold nothing
 * measured, which is §D's "never a substitute" applied to a constant.
 *
 * ## Why a table and not `SPIKE_TOKENS_CC`
 *
 * So that adding an engine is adding a ROW with its own measurement, and so
 * that the deriver's lookup is total: `SPIKE_TOKENS[engine]` is `undefined` for
 * an engine nobody has measured, and `undefined` is what routes it to
 * `unavailable`. A bare constant would have had to be applied or skipped by a
 * conditional somebody could forget to write.
 */
export const SPIKE_TOKENS: Readonly<Partial<Record<StatsEngine, number>>> = Object.freeze({
  cc: 5000,
});

/**
 * The values a record is derived under, overridable only by a test.
 *
 * `spikeTokens` is a per-engine TABLE rather than a number for the reason
 * above: a single number cannot express "this engine has no measured
 * threshold", and expressing it is the whole point.
 */
export interface DeriveConstants {
  readonly loopMin: number;
  readonly spikeTokens: Readonly<Partial<Record<StatsEngine, number>>>;
}

/** The shipped values. Every production call uses exactly this object. */
export const DEFAULT_CONSTANTS: DeriveConstants = Object.freeze({
  loopMin: LOOP_MIN,
  spikeTokens: SPIKE_TOKENS,
});

/**
 * Facts an engine CANNOT supply, measured — not facts a session happens to lack.
 *
 * `docs/evidence/phase-0-stats/VERDICT.md` DoD 0.4 is the source, and the
 * distinction it draws is the reason this table exists at all. That verdict
 * reports two columns per fact, `present` and `fired`, precisely because "the
 * structure this fact needs exists in that session" and "it produced at least
 * one row" answer different questions. A session with no compaction and an
 * engine that writes no compaction entry both yield an empty list, and only one
 * of them is a gap. Everything in this table is the second kind; everything
 * else the deriver discovers from the session in front of it.
 *
 * ## Why every row is Codex, and every row has one cause
 *
 * **Codex states no structured tool status.** A tool result is an array of free
 * text with no error field, and the call item's own `status` is present on 10
 * of 41 calls and always reads `completed`. "Did this call fail" is answerable
 * for CC (`is_error`) and for OpenCode (`state.status`: 317 completed / 28
 * error) and is not answerable for Codex without reading the text, which the
 * Layer 1 non-goals forbid outright.
 *
 *   - `F2.errors:codex` — the error COLUMN of an otherwise derivable fact.
 *     VERDICT.md records Codex F2 as "DERIVABLE (errors unavailable)", so the
 *     sub-part is named rather than the whole fact. Emitting `errors: 0` would
 *     publish a zero manufactured by this repository's own grafter rule
 *     (`resultPreview === undefined ? 'running' : 'done'`), which has no
 *     knowledge of success at all.
 *   - `F4:codex` — a churn chain is DEFINED on an errored call between two
 *     writes, so it goes with the error column.
 *   - `F1:codex` — two independent causes, either sufficient. The error column
 *     above, and: **no file-argument key exists on any Codex tool.** `exec` is
 *     a `custom_tool_call` whose input is a STRING of JavaScript and can carry
 *     no key at all; `exec_command` carries `cmd` and `workdir` only. Codex
 *     touches files through shell commands and the names live inside command
 *     text.
 *   - `F12:codex` — no Codex payload type carries a compaction entry.
 *
 * ## What is deliberately NOT here
 *
 * `F7` and `F10` are absent because they are derivable from the session itself:
 * F7's threshold is missing from {@link SPIKE_TOKENS} for two engines, and F10
 * needs a `windowTokens` the state either carries or does not. Restating either
 * here would be two sources for one fact, and the day they disagreed the table
 * would win silently.
 *
 * `F6` is absent for the same reason and one more worth stating: VERDICT.md
 * records Codex F6 as DERIVABLE 5/5, measured over the RAW corpus, while this
 * deriver reads a `SessionState` — and Phase 1 carried no `usageSeries` for
 * Codex. So F6 is unavailable for every Codex session today, and it is reported
 * from the absent series rather than from a table, so that the day Codex gains
 * a series the fact appears with no edit here.
 */
export const ENGINE_FACT_GAPS: Readonly<Record<StatsEngine, readonly string[]>> = Object.freeze({
  cc: Object.freeze([]) as readonly string[],
  opencode: Object.freeze([]) as readonly string[],
  codex: Object.freeze(['F1:codex', 'F2.errors:codex', 'F4:codex', 'F12:codex']) as readonly string[],
});
