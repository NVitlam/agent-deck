/**
 * F14 — the six derived timing figures, read off the F14 instants the parse
 * boundary gathered.
 *
 * v0.8.0 Phase 7, DoD 7.2. This file DECIDES NOTHING ABOUT TIME: DoD 7.1 put
 * `ToolNode.startedAtMs`, `ToolNode.endedAtMs` and `UsageTurn.atMs` on the
 * model, from the engine's own timestamps only, absent where the engine states
 * none. Everything here is a difference or a ratio of those.
 *
 * ## Every absence is one fact, and it is never a zero
 *
 * {@link TimingStats}'s header states it: an absent member means *the instants
 * this figure is a function of were not stated by the engine*. Each figure
 * below therefore has exactly one absence condition, named on it, and none of
 * them is "the value came out 0". A `timeToFirstToolMs` of 0 is a session whose
 * first tool call IS its first stated instant, which is what a session with no
 * usage turn before its first call looks like.
 *
 * ## No clock, and no rounding
 *
 * `derive.ts` has no clock (its header says so, and `derive.test.ts` asserts
 * the file contains no `Date.now()`), and `params.now` exists for F13 alone. A
 * span measured against `now` would move every time a golden was regenerated,
 * so a session still running reports the span it has EVIDENCE of rather than
 * the span since it started.
 *
 * The three rates are the EXACT IEEE-754 quotients, unrounded. Float division
 * is deterministic, so a golden holding `0.8333333333333334` is stable on every
 * machine; rounding is presentation and belongs to the renderer. A record that
 * rounded would publish a number the session did not produce.
 */

import type { AgentNode, ToolNode } from '../model/events.js';

import type { TimingStats } from './schema.js';

/** Named so the two rates cannot pick each other's divisor. */
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/** What the six figures are functions of. */
export interface TimingInput {
  /**
   * Every call in the session, in the SESSION-WIDE call order.
   *
   * The same sequence F1's `firstTouchSeq` counts positions in —
   * `derive.ts`'s `sessionSequence`, a depth-first walk with each agent's own
   * calls in ordinal order. `longestGapMs` is defined on THIS order, which is
   * structural rather than chronological; see below for what that costs.
   */
  sequence: readonly ToolNode[];
  /** Every agent in the tree, for the usage-turn times. */
  agents: readonly AgentNode[];
  /** `totals.prompt + totals.output`, the numerator of `tokensPerMin`. */
  tokens: number;
  /** `totals.costUsd`, or absent where no cost source was selected. */
  costUsd?: number;
}

/** A stated instant, or nothing. A non-finite value is not an instant. */
function instantOf(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** What one pass over the session's instants yields. */
interface InstantScan {
  /** How many instants the session states, over all three fields. */
  count: number;
  /** The earliest and latest of them. Both absent iff `count` is 0. */
  first?: number;
  last?: number;
  /** The earliest STATED TOOL START, absent where no call states one. */
  firstStart?: number;
  /**
   * Consecutive start-to-start differences, in SEQUENCE order.
   *
   * One entry per adjacent pair of started calls, so a session with n started
   * calls yields n - 1 and a session with fewer than two yields none — which
   * is exactly `longestGapMs`'s absence condition, carried as a length rather
   * than re-derived from a second count.
   */
  gaps: number[];
}

/**
 * One pass over every F14 instant the session states.
 *
 * The extrema are accumulated here rather than by `Math.min(...array)`: an
 * instant count is unbounded (948 tool nodes and 899 usage turns across one
 * engine's committed corpus today), and a spread of an unbounded array is a
 * call-stack overflow that arrives as a function of session SIZE — a failure
 * this repository would meet in a user's window rather than in a test.
 */
function scanInstants(input: TimingInput): InstantScan {
  const scan: InstantScan = { count: 0, gaps: [] };
  const see = (value: number): void => {
    scan.count += 1;
    if (scan.first === undefined || value < scan.first) scan.first = value;
    if (scan.last === undefined || value > scan.last) scan.last = value;
  };
  let previousStart: number | undefined;
  for (const tool of input.sequence) {
    const start = instantOf(tool.startedAtMs);
    if (start !== undefined) {
      see(start);
      if (scan.firstStart === undefined || start < scan.firstStart) scan.firstStart = start;
      if (previousStart !== undefined) scan.gaps.push(start - previousStart);
      previousStart = start;
    }
    const end = instantOf(tool.endedAtMs);
    if (end !== undefined) see(end);
  }
  for (const agent of input.agents) {
    for (const turn of agent.usageSeries ?? []) {
      const at = instantOf(turn.atMs);
      if (at !== undefined) see(at);
    }
  }
  return scan;
}

/**
 * The six figures for one session.
 *
 * Returns an EMPTY object where the session states no instant at all — the
 * caller names that as `F14:<engine>`. `timing` is present on every record
 * whatever this returns, so "this session states no time" is an empty block
 * rather than a missing key, which could equally have meant "written by an
 * older deriver".
 */
export function deriveTiming(input: TimingInput): TimingStats {
  const scan = scanInstants(input);
  const { first, last } = scan;
  if (first === undefined || last === undefined) return {};

  // The LAST stated instant minus the FIRST, over tool starts, tool ends and
  // usage-turn times alike — never `endedAt - startedAt`. The schema states the
  // reason: those two are the session's ENVELOPE, and on Codex they come from
  // the thread's first and last records rather than from work the engine
  // timestamped. ONE stated instant yields 0, which is a real answer: a session
  // with a single timestamped call spans no measured time.
  const wallMs = last - first;
  const timing: TimingStats = { wallMs };

  if (scan.firstStart !== undefined) {
    // The EARLIEST stated start, not the sequence's first element. The sequence
    // is structural, so its first element is the root agent's ordinal 0 and a
    // subagent's call can precede it in time; taking the minimum is what makes
    // this figure non-negative BY CONSTRUCTION, since every start is itself one
    // of the instants `first` is the minimum of.
    timing.timeToFirstToolMs = scan.firstStart - first;
  }

  if (scan.gaps.length > 0) {
    // START-TO-START, in the session-wide call order. The schema states the
    // reason for refusing end-to-start: an end is absent on every running call,
    // so a gap measured from a mixture of the two would be a different quantity
    // from row to row.
    //
    // The order is STRUCTURAL, and two consequences follow that a reader would
    // otherwise have to discover. A subagent's calls are not interleaved with
    // its parent's here — they follow the whole parent — so a parent's gap
    // across a long `Agent` call counts as a gap even though a subagent was
    // working throughout. And the pair crossing from one agent to the next can
    // run BACKWARDS in time; that pair contributes a negative difference, which
    // the maximum ignores unless every pair is negative.
    let longest = scan.gaps[0] ?? 0;
    for (const gap of scan.gaps) if (gap > longest) longest = gap;
    timing.longestGapMs = longest;
  }

  if (wallMs > 0) {
    // `wallMs > 0` is the whole gate on the three rates: a zero span makes each
    // a division by zero, and `Infinity` is a value `validateStatsRecord`
    // rejects outright — correctly, because a rate over no elapsed time is not
    // a rate.
    timing.tokensPerMin = input.tokens / (wallMs / MS_PER_MINUTE);
    // Every call in the sequence, including those that state no start: the
    // numerator is how many calls the session made, and `wallMs` is the span
    // the engine timestamped. Counting only started calls would divide two
    // populations that are not the same one.
    timing.callsPerMin = input.sequence.length / (wallMs / MS_PER_MINUTE);
    // ONLY with a cost source. `costUsd` reaches this function only when
    // `derive.ts` selected one, so this member is present iff `totals.costUsd`
    // is and the span is non-zero — never a 0 standing in for "no price known".
    if (input.costUsd !== undefined) {
      timing.costPerHourUsd = input.costUsd / (wallMs / MS_PER_HOUR);
    }
  }

  return timing;
}
