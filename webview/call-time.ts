/**
 * What F14's instants say about a run of calls — v0.8.0 Phase 7, DoD 7.3.
 *
 * `ToolNode.startedAtMs` and `ToolNode.endedAtMs` are epoch milliseconds from
 * the engine's own timestamps, absent where the engine states none. This
 * module turns a run of calls into the three numbers the drawer draws, and it
 * is a pure function of those instants: no clock, no DOM, no store. The
 * component looks up a row and prints it.
 *
 * ## Offsets, not clock readings, and the reason is a recorded defect class
 *
 * An absolute wall-clock reading is a function of the reader's TIMEZONE as
 * well as of the record, so the same session renders differently on two
 * machines and a committed golden of it is a statement about the machine that
 * captured it. This repository has already paid for that shape once, with
 * `AgentNode.endedAt` — a filesystem mtime that git does not preserve across a
 * checkout, which made a byte-stable wire corpus impossible until the recorder
 * pinned it.
 *
 * Every number here is instead a DIFFERENCE OF TWO INSTANTS ON THE SAME
 * RECORD. A difference has no timezone, no locale and no epoch, so it is the
 * same number on every machine that reads the same bytes — which is what makes
 * a golden of it evidence rather than a snapshot of a laptop.
 *
 * THE STATED COST: an offset cannot be lined up against an external log. A
 * reader who wants to know at what o'clock a call ran cannot get it from this
 * column. The engine's instants are on the record and a later item can render
 * them; what this column answers is "when, within this run".
 *
 * ## The gap is START-TO-START, and that is not a local choice
 *
 * `src/stats/schema.ts:TimingStats.longestGapMs` is "the largest interval
 * between one call starting and the next starting", start-to-start, because an
 * end is absent on every running call and on any engine that states none, so a
 * gap measured from a mixture of the two is a different quantity from row to
 * row. The drawer subtracts the same two instants, so the word "gap" means one
 * thing on both surfaces.
 *
 * ONE DIVERGENCE, AND IT IS SCOPE RATHER THAN DEFINITION. `longestGapMs` runs
 * over the SESSION-WIDE call order; the drawer is handed one agent's calls and
 * can see no others, so the predecessor here is the previous call OF THIS
 * AGENT. The subtraction is identical; the population is what the component
 * was given.
 *
 * ## Every absence is an absence
 *
 * The first call has no predecessor, so it has no gap — an absence, not a
 * zero. A call stating no start has no offset and no gap, and neither has the
 * call after it, because a gap is a function of exactly two instants and one
 * of them is missing. §D's rule applied to time: never a zero, never a
 * substitute.
 */

import { EM_DASH, formatDuration } from './format.js';

/** The two F14 fields, and the id they belong to. `ToolNode` satisfies this. */
export interface CallInstants {
  id: string;
  /** Epoch ms, or absent where the engine states none. */
  startedAtMs?: number | undefined;
  /** Epoch ms, or absent — which is every call still running. */
  endedAtMs?: number | undefined;
}

/** One row's three numbers. Every member absent when its inputs are. */
export interface CallTime {
  id: string;
  /** This call's start, as an offset from the run's first stated start. */
  atMs?: number;
  /** This call's end, as an offset from the same instant. */
  endAtMs?: number;
  /** This call's start minus the previous call's start, in run order. */
  gapMs?: number;
}

/**
 * Place a run of calls on its own timeline.
 *
 * @param calls the calls IN RUN ORDER — the order the transcript wrote them,
 *   which is the order the drawer's sequence numbers count. Not the order the
 *   list happens to be drawn in: reversing the list or filtering it must not
 *   change what a row says about the session, so the caller passes the run and
 *   looks a row up by id.
 */
export function callTimeline(calls: readonly CallInstants[]): CallTime[] {
  let base: number | undefined;
  for (const call of calls) {
    const start = call.startedAtMs;
    if (start === undefined) continue;
    if (base === undefined || start < base) base = start;
  }

  return calls.map((call, i) => {
    const row: CallTime = { id: call.id };
    const start = call.startedAtMs;
    const end = call.endedAtMs;
    if (base !== undefined && start !== undefined) row.atMs = start - base;
    if (base !== undefined && end !== undefined) row.endAtMs = end - base;
    // The `i === 0` arm is REDUNDANT and is kept for the reader: `calls[-1]`
    // is already `undefined`, so removing it changes nothing — measured, as an
    // equivalent mutant that the whole suite survived. What carries the
    // first-row rule is therefore array indexing, and the assertions that pin
    // it are about the OUTPUT (`'gapMs' in row` is false) rather than about
    // this line.
    const previous = i === 0 ? undefined : calls[i - 1]?.startedAtMs;
    if (start !== undefined && previous !== undefined) row.gapMs = start - previous;
    return row;
  });
}

/**
 * An offset, for a reader.
 *
 * `formatDuration` is the shipped vocabulary for a span and is reused rather
 * than restated — a second formatter would be a second place for the em-dash
 * rule to drift. The `+` marks the number as an offset from something rather
 * than a duration of something.
 *
 * IT DECLINES A NEGATIVE, and that is deliberate rather than inherited.
 * `formatDuration` already answers `EM_DASH` for `ms < 0`; a negative gap
 * means the run order and the instants on the record disagree, and `+-4.0s`
 * would be this surface inventing a reading of that. The em dash says what is
 * true: there is no interval here to name. The `+` is therefore attached only
 * once a number has survived the formatter, never before.
 */
export function formatOffset(ms: number | undefined): string {
  if (ms === undefined) return EM_DASH;
  const span = formatDuration(ms);
  if (span === EM_DASH) return EM_DASH;
  return `+${span}`;
}
