/**
 * The Insights surface's pure layout — v0.9.0 DoD 9.29 and 9.30.
 *
 * Spec `Amendment 2026-09-21 — One window, Insights provider, Menu-only
 * entry`. Insights is a SURFACE of the one panel, and it has two states: FREE
 * (no provider registered) and PROVIDER. This module is the half of both that
 * can be tested without a DOM: records and a clock in, tiles out; a provider
 * snapshot in, rows out. The component beside it renders these and decides
 * nothing.
 *
 * ## The free state: every static Layer 1 fact, last 7 days, from the store
 *
 * "Every static Layer 1 fact for the last 7 days the store already holds" —
 * the STORED history, not this window's live sessions, because the amendment
 * says the store. A record counts when its last instant (`endedAt`, else
 * `startedAt`) is inside the window. Every fact is a sum or a filter over a
 * field `StatsRecord` already carries, and {@link INSIGHT_SOURCES} names the
 * field beside every tile so a reader can go and check it: facts, and where
 * they came from (G10).
 *
 * **EXCLUDED RECORDS ARE SKIPPED**, and the tile row says how many. A session
 * Agent Deck could not read in full carries no facts, and counting its empty
 * tables as zeroes would put a confident 0 where there is an absence.
 *
 * **The cost tile sums `costSource: 'engine'` only.** "Engine-reported" is
 * the amendment's word, and the README already distinguishes an engine's own
 * figure from Claude Code's telemetry estimate and from the user's prices. A
 * sum that mixed them would be one number standing for three kinds of claim.
 *
 * ## The examples are the 9.6 teaser's, restored
 *
 * Three static illustrations, labelled {@link EXAMPLE_LABEL}, with synthetic
 * ids only. They rotate one step each time the surface is LEFT, so the first
 * open shows the first and every later open shows the next.
 *
 * ## The provider state: the parent's own words for the provider's facts
 *
 * A finding arrives as its kind, its confidence and numeric evidence — never
 * the model's prose (`src/insights-provider.ts` refuses it at the boundary).
 * {@link FINDING_LABELS} is the parent's name for each kind, and nothing else
 * about a finding is text.
 */

import type {
  FindingSetView,
  InsightsFindingKind,
  InsightsProviderSnapshot,
  RunSummary,
} from '../../src/model/events.js';
import type { StatsEngine, StatsRecord } from '../../src/stats/schema.js';

/** The window the free state counts over. The amendment's "last 7 days". */
export const INSIGHTS_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * The silence a gap must exceed to count as an idle resume.
 *
 * The `agentDeck.livenessThresholdMs` DEFAULT, bound to the manifest by
 * `src/insights-facts.test.ts` rather than written down twice. `timing.longestGapMs` is
 * "the largest interval between one call starting and the next STARTING", so
 * a gap in the record is a gap that ENDED — work resumed.
 */
export const IDLE_RESUME_MS = 120_000;

/** The facts the free state shows, in the order it shows them. */
export type InsightFactId =
  | 'sessions'
  | 'compactions'
  | 'idleResumes'
  | 'rereadLoops'
  | 'failedCalls'
  | 'stalls'
  | 'silentSubagents'
  | 'promptTokens'
  | 'outputTokens'
  | 'engineCost';

/** One tile: its label, its value as the surface prints it, and its source. */
export interface InsightTile {
  readonly id: InsightFactId;
  readonly label: string;
  /** The number, for a test to read without parsing the text. */
  readonly count: number;
  /** What the tile prints. */
  readonly value: string;
  /** A second line of fact under the value, when the tile has one. */
  readonly note?: string;
}

/**
 * The record field each fact is taken from, printed beside it so the surface
 * names its own sources.
 */
export const INSIGHT_SOURCES: Readonly<Record<InsightFactId, string>> = Object.freeze({
  sessions: 'engine',
  compactions: 'totals.compactions',
  idleResumes: 'timing.longestGapMs',
  rereadLoops: 'loops[].class',
  failedCalls: 'tools[].errors',
  stalls: 'totals.stalls',
  silentSubagents: 'totals.silentSubagents',
  promptTokens: 'totals.prompt',
  outputTokens: 'totals.output',
  engineCost: 'totals.costUsd',
});

/** The engines, in the order the sessions tile breaks them down. */
const ENGINES: readonly { id: StatsEngine; label: string }[] = [
  { id: 'cc', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
];

/** Everything the free state renders. */
export interface FreeInsightsLayout {
  /** The window's start, epoch ms. */
  readonly sinceMs: number;
  /** Records inside the window and read in full: what every tile counts over. */
  readonly counted: number;
  /** Records inside the window that were excluded, and so not counted. */
  readonly excluded: number;
  /** Sessions by engine, over the counted records. */
  readonly byEngine: Readonly<Record<StatsEngine, number>>;
  readonly tiles: readonly InsightTile[];
}

/** A count as the surface prints it: `12,345`. */
function formatCount(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Count every fact over the stored records whose last instant is within the
 * last {@link INSIGHTS_WINDOW_DAYS} days of `nowMs`.
 *
 * A pure function of its two arguments: no clock of its own, so a golden over
 * it means something.
 */
export function freeInsightsLayout(
  records: readonly StatsRecord[],
  nowMs: number,
): FreeInsightsLayout {
  const sinceMs = nowMs - INSIGHTS_WINDOW_DAYS * DAY_MS;
  const inWindow = records.filter((record) => (record.endedAt ?? record.startedAt) >= sinceMs);
  const full = inWindow.filter((record) => record.coverage === 'full');

  const byEngine: Record<StatsEngine, number> = { cc: 0, codex: 0, opencode: 0 };
  let compactions = 0;
  let idleResumes = 0;
  let rereadLoops = 0;
  let failedCalls = 0;
  let stalls = 0;
  let silentSubagents = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let engineCostUsd = 0;
  let engineCostSessions = 0;

  for (const record of full) {
    byEngine[record.engine] += 1;
    compactions += record.totals.compactions;
    const gap = record.timing.longestGapMs;
    if (gap !== undefined && gap >= IDLE_RESUME_MS) idleResumes += 1;
    for (const loop of record.loops) {
      if (loop.class === 'read') rereadLoops += 1;
    }
    for (const tool of record.tools) {
      // OPTIONAL, and absent means "this engine states no tool status" — a
      // Codex row, where a 0 would be an artefact rather than a fact.
      if (tool.errors !== undefined) failedCalls += tool.errors;
    }
    stalls += record.totals.stalls;
    silentSubagents += record.totals.silentSubagents;
    promptTokens += record.totals.prompt;
    outputTokens += record.totals.output;
    if (record.totals.costSource === 'engine' && record.totals.costUsd !== undefined) {
      engineCostUsd += record.totals.costUsd;
      engineCostSessions += 1;
    }
  }

  const count = (id: InsightFactId, label: string, n: number): InsightTile => ({
    id,
    label,
    count: n,
    value: formatCount(n),
  });

  const engineNote = ENGINES.filter((engine) => byEngine[engine.id] > 0)
    .map((engine) => `${engine.label} ${formatCount(byEngine[engine.id])}`)
    .join(' · ');

  const tiles: InsightTile[] = [
    {
      ...count('sessions', 'sessions recorded', full.length),
      ...(engineNote === '' ? {} : { note: engineNote }),
    },
    count('compactions', 'compactions', compactions),
    count('idleResumes', 'long-idle resumes', idleResumes),
    count('rereadLoops', 're-read loops', rereadLoops),
    count('failedCalls', 'failed tool calls', failedCalls),
    count('stalls', 'stalls', stalls),
    count('silentSubagents', 'silent subagents', silentSubagents),
    count('promptTokens', 'prompt tokens', promptTokens),
    count('outputTokens', 'output tokens', outputTokens),
    engineCostSessions === 0
      ? {
          id: 'engineCost',
          label: 'engine-reported cost',
          count: 0,
          // An em dash, never `0.00`: no engine reported a cost, which is an
          // absence rather than a free week.
          value: '—',
          note: 'no session in the window carries an engine-reported cost',
        }
      : {
          id: 'engineCost',
          label: 'engine-reported cost',
          count: engineCostUsd,
          value: `${engineCostUsd.toFixed(2)} USD`,
          note: `over ${formatCount(engineCostSessions)} session${engineCostSessions === 1 ? '' : 's'}`,
        },
  ];

  return {
    sinceMs,
    counted: full.length,
    excluded: inWindow.length - full.length,
    byEngine,
    tiles,
  };
}

/* ------------------------------------------------------------------------ *
 * The examples
 * ------------------------------------------------------------------------ */

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
 * The three examples, in rotation order — the 9.6 teaser's, restored.
 *
 * **Every path and every id is SYNTHETIC** — `ses_example*`, `a_example*` and
 * paths under a `repo/` that exists nowhere. `src/insights-facts.test.ts` checks that two
 * ways: by SHAPE (no absolute path, no `toolu_` id, no uuid) and by searching
 * every committed corpus for each example string. The privacy sweep reads
 * these strings HERE, at their tracked source.
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
 * The example to show for a rotation count — 1 → 2 → 3 → 1.
 *
 * The counter is WEBVIEW-LOCAL, starts at 0 and advances when the surface is
 * LEFT, so the first open shows the first example. A counter that cannot
 * arise answers with the first: an illustration is not worth a crash.
 */
export function exampleAt(openCount: number): InsightExample {
  if (!Number.isInteger(openCount) || openCount < 0) return EXAMPLES[0] as InsightExample;
  return EXAMPLES[openCount % EXAMPLES.length] as InsightExample;
}

/* ------------------------------------------------------------------------ *
 * The provider state
 * ------------------------------------------------------------------------ */

/** The parent's own name for each finding kind. The ONLY words about a finding. */
export const FINDING_LABELS: Readonly<Record<InsightsFindingKind, string>> = Object.freeze({
  're-read-loop': 'Re-read loop',
  'churn-chain': 'Churn chain',
  'context-churn': 'Context churn',
  stall: 'Stall',
  'silent-subagent': 'Silent subagent',
  compaction: 'Compaction',
  'cache-miss': 'Cache miss',
  other: 'Other pattern',
});

/** An instant as the surface prints it: `2026-09-21 14:05 UTC`. */
export function formatInstant(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** One finding, as the surface prints it. */
export interface FindingRow {
  readonly label: string;
  readonly confidence: string;
  /** `statsKey = value`, one per piece of evidence. */
  readonly evidence: readonly string[];
}

/** One history row, as the surface prints it. */
export interface HistoryRow {
  readonly runId: string;
  readonly when: string;
  readonly outcome: string;
}

/** Everything the provider state renders. */
export interface ProviderInsightsLayout {
  readonly title: string;
  /** `null` when the provider has no latest finding set yet. */
  readonly latest: {
    readonly heading: string;
    readonly window: string;
    readonly findings: readonly FindingRow[];
    /** Present when the provider's own validator rejected any. */
    readonly rejected?: string;
  } | null;
  readonly history: readonly HistoryRow[];
  readonly running: boolean;
  /** Present when the parent dropped anything the provider returned. */
  readonly dropped?: string;
}

function latestOf(set: FindingSetView): NonNullable<ProviderInsightsLayout['latest']> {
  const agent = set.agent === null ? '' : ` · ${set.agent === 'claude' ? 'Claude Code' : 'Codex'}`;
  return {
    heading: `Latest run · ${formatInstant(set.createdAt)}${agent}`,
    window: `${formatCount(set.window.sessions)} session${set.window.sessions === 1 ? '' : 's'} since ${formatInstant(set.window.sinceMs)}`,
    findings: set.findings.map((finding) => ({
      label: FINDING_LABELS[finding.kind],
      confidence: `${finding.confidence} confidence`,
      evidence: finding.evidence.map((item) => `${item.statsKey} = ${String(item.value)}`),
    })),
    ...(set.findingsRejected > 0
      ? { rejected: `${formatCount(set.findingsRejected)} finding${set.findingsRejected === 1 ? '' : 's'} rejected by the provider` }
      : {}),
  };
}

function historyOf(run: RunSummary): HistoryRow {
  return {
    runId: run.runId,
    when: formatInstant(run.createdAt),
    outcome:
      run.outcome === 'refused'
        ? 'refused'
        : `${formatCount(run.findings)} finding${run.findings === 1 ? '' : 's'}`,
  };
}

/** The provider state's rows, from the checked snapshot the host sent. */
export function providerInsightsLayout(snapshot: InsightsProviderSnapshot): ProviderInsightsLayout {
  return {
    title: `${snapshot.about.name} ${snapshot.about.version}`,
    latest: snapshot.latest === null ? null : latestOf(snapshot.latest),
    history: snapshot.runs.map(historyOf),
    running: snapshot.running,
    ...(snapshot.dropped > 0
      ? { dropped: `${formatCount(snapshot.dropped)} value${snapshot.dropped === 1 ? '' : 's'} from the provider did not pass the check and are not shown` }
      : {}),
  };
}
