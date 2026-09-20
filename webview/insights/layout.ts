/**
 * The Insights tab's pure layout — v0.9.0 DoD 9.6.
 *
 * Spec `Amendment 2026-09-20`. Four counts over THIS USER'S OWN Layer 1
 * records, one product sentence, three static examples, and one button. A pure
 * function of `StatsRecord[]` plus a rotation counter: no clock, no store, no
 * DOM, so a golden over it means something.
 *
 * ## Every count is structural, and each says which field it is
 *
 * G10 applies to this surface like every other: it states counts and what the
 * other extension does, and never advises. The four are not new facts — each is
 * a sum or a filter over fields `StatsRecord` already carries, and
 * {@link INSIGHT_SOURCES} names the field beside every one so a reader can go
 * and check.
 *
 * ## `idleResumes` needs a bound, and the bound is shown as a PARAMETER
 *
 * `timing.longestGapMs` is "the largest interval between one call starting and
 * the next STARTING", so a gap that is in the record is a gap that ENDED — work
 * resumed. "Long" needs a number, and an unstated number would be a judgment.
 * {@link IDLE_RESUME_MS} is the shipped `agentDeck.livenessThresholdMs`
 * default, the same silence this product already calls a stall, and the surface
 * prints it the way `StatsView` prints `LOOP_MIN` and `SPIKE_TOKENS` — as a
 * parameter, not a judgment. `insights.test.ts` binds it to the manifest so the
 * two cannot drift.
 */

import type { StatsRecord } from '../../src/stats/schema.js';

/**
 * The silence a gap must exceed to count as an idle resume.
 *
 * The `agentDeck.livenessThresholdMs` DEFAULT, bound to the manifest by
 * `insights.test.ts` rather than written down twice. It is a default, never a
 * policy — the same sentence `src/codex/liveness.ts` already carries about it.
 */
export const IDLE_RESUME_MS = 120_000;

/** One counted thing, its number, and the field it was counted from. */
export interface InsightCount {
  id: 'compactions' | 'idleResumes' | 'rereadLoops' | 'failedCalls';
  /** What the surface prints. Plural-agnostic: the number sits beside it. */
  label: string;
  count: number;
}

/**
 * The record field each count is taken from, printed beside the counts so the
 * surface names its own sources (G10: facts, and where they came from).
 */
export const INSIGHT_SOURCES: Readonly<Record<InsightCount['id'], string>> = Object.freeze({
  compactions: 'totals.compactions',
  idleResumes: 'timing.longestGapMs',
  rereadLoops: 'loops[].class',
  failedCalls: 'tools[].errors',
});

/** The product sentence. ONE, and it describes what the other tool does. */
export const PRODUCT_SENTENCE =
  'Agent Deck Insights reads the same local records and groups them into patterns across sessions.';

/** What the surface says when every count is zero. A fact, not a prompt. */
export const ALL_ZERO_LINE =
  'No compaction, long-idle resume, re-read loop or failed tool call is recorded yet.';

/** The label every example carries. Verbatim, and pinned by the test. */
export const EXAMPLE_LABEL = 'Example, based on a real run';

/** One static example. Nothing here is derived; nothing here is this user's. */
export interface InsightExample {
  id: 'compaction' | 'cache-miss' | 'reread-loop';
  title: string;
  /** Two or three lines of fact-shaped text. No advice, no second person. */
  lines: readonly string[];
}

/**
 * The three examples, in rotation order.
 *
 * **Every path and every id is SYNTHETIC** — `acme-widgets`, `ses_example*`,
 * paths under a `repo/` that exists nowhere. `insights.test.ts` holds them
 * against this repository's own identity set and against the committed corpora,
 * and `scripts/privacy-sweep.mjs` walks the built bundle they ship in.
 *
 * They are static because they are ILLUSTRATIONS. Deriving them from the user's
 * own sessions would make the tab a second stats view, and deriving them from a
 * real capture would put somebody's real path in the bundle.
 */
export const EXAMPLES: readonly InsightExample[] = Object.freeze([
  Object.freeze({
    id: 'compaction',
    title: 'Compaction',
    lines: Object.freeze([
      'Session ses_example01 recorded 3 compactions in 41 minutes.',
      'Each one was preceded by a turn whose cache-creation rose by more than 4,000 tokens.',
      'Prompt tokens after the third compaction: 128,400.',
    ]),
  }),
  Object.freeze({
    id: 'cache-miss',
    title: 'Cache miss',
    lines: Object.freeze([
      'Session ses_example02 read 11,000 cached tokens against 96,000 prompt tokens.',
      'Cache ratio 0.11, against 0.82 on the four sessions before it.',
      'The turn before the drop rewrote repo/src/config.ts.',
    ]),
  }),
  Object.freeze({
    id: 'reread-loop',
    title: 'Re-read loop',
    lines: Object.freeze([
      'Agent a_example03 read repo/docs/schema.md 7 times with an identical input.',
      'The 7 calls sit at ordinals 12, 15, 19, 22, 26, 29 and 33.',
      'Two Edit calls of the same file sit between them, each followed by an error.',
    ]),
  }),
]);

/**
 * The example to show for a given open count — DoD 9.6, 1 -> 2 -> 3 -> 1.
 *
 * The counter is WEBVIEW-LOCAL and starts at 0, so the first open shows the
 * first example. Modulo rather than a stored index, so a counter that has run
 * for a long time still lands somewhere valid and nothing has to be reset.
 */
export function exampleAt(openCount: number): InsightExample {
  const length = EXAMPLES.length;
  // A negative or non-integer counter cannot arise from the store, and
  // answering with the first example is a defined answer rather than a throw:
  // an illustration is not worth a crashed panel.
  if (!Number.isInteger(openCount) || openCount < 0) return EXAMPLES[0] as InsightExample;
  return EXAMPLES[openCount % length] as InsightExample;
}

/** Everything the tab renders, from the records it was given. */
export interface InsightsLayout {
  /** Every count, including the zero ones — the COMPONENT hides those. */
  all: readonly InsightCount[];
  /** Only the non-zero ones, in the declared order. What the line shows. */
  shown: readonly InsightCount[];
  /** True when nothing was counted at all. The plain fact line's condition. */
  allZero: boolean;
  /** How many records the counts are over. Printed, so a 0 is legible. */
  sessions: number;
}

/**
 * Count the four, over the records this window holds.
 *
 * EXCLUDED RECORDS ARE SKIPPED. A session Agent Deck could not read in full
 * carries no facts (`coverage` says so), and counting its empty tables as
 * zeroes would put a confident 0 where there is an absence — the rule §D states
 * and this repository has paid for more than once.
 */
export function insightsLayout(records: readonly StatsRecord[]): InsightsLayout {
  const full = records.filter((record) => record.coverage === 'full');

  let compactions = 0;
  let idleResumes = 0;
  let rereadLoops = 0;
  let failedCalls = 0;

  for (const record of full) {
    compactions += record.totals.compactions;

    const gap = record.timing.longestGapMs;
    if (gap !== undefined && gap >= IDLE_RESUME_MS) idleResumes += 1;

    for (const loop of record.loops) {
      if (loop.class === 'read') rereadLoops += 1;
    }

    for (const tool of record.tools) {
      // OPTIONAL, and absent means "this engine states no tool status" — a
      // Codex row, where a 0 would be an artefact of the grafter's rule rather
      // than a fact about the session.
      if (tool.errors !== undefined) failedCalls += tool.errors;
    }
  }

  const all: InsightCount[] = [
    { id: 'compactions', label: 'compactions', count: compactions },
    { id: 'idleResumes', label: 'long-idle resumes', count: idleResumes },
    { id: 'rereadLoops', label: 're-read loops', count: rereadLoops },
    { id: 'failedCalls', label: 'failed tool calls', count: failedCalls },
  ];
  const shown = all.filter((entry) => entry.count > 0);

  return {
    all,
    shown,
    allZero: shown.length === 0,
    sessions: full.length,
  };
}
