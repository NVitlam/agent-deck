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
 * ## The provider state: a report list and the selected run
 *
 * Since DoD 9.46 (spec `Amendment 2026-09-23 — Paid Insights surface`) the
 * provider state is a REPORT LIST — date, findings count, engine, newest
 * first — and a PREVIEW of the selected run, rendered by `reportOf` in
 * `src/insights-report.ts` exactly as the latest report was, and exactly as
 * Export writes it. Every string of it was already allow-listed and
 * length-capped by `src/insights-provider.ts`. The fact tiles of the free
 * state sit below both.
 */

import { AGENT_LABELS, formatCount, formatInstant, outcomeOf, plural, reportOf } from '../../src/insights-report.js';
import type { RunReport } from '../../src/insights-report.js';
import type { InsightsProviderSnapshot, InsightsRunState } from '../../src/model/events.js';
import type { StatsEngine, StatsRecord } from '../../src/stats/schema.js';

/** The window the free state counts over. The amendment's "last 7 days". */
export const INSIGHTS_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * The `agentDeck.livenessThresholdMs` DEFAULT, bound to the manifest by
 * `src/insights-facts.test.ts` rather than written down twice.
 *
 * Since v0.9.0 DoD 9.38 the threshold a long-idle resume is counted against
 * is the user's SETTING, which the host sends on `settings`; this is only the
 * value the store holds before that message arrives. `timing.longestGapMs`
 * is "the largest interval between one call starting and the next STARTING",
 * so a gap in the record is a gap that ENDED — work resumed.
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

/**
 * Milliseconds as seconds, EXACTLY: `120`, `90.5`, `1,800`. The tile states
 * the rule it counted by, and a rounded rule is a different rule (verifier
 * round 9.39, D11: 90,500 ms read "91 s").
 */
function secondsOf(ms: number): string {
  const whole = Math.trunc(ms / 1000);
  const rest = ms - whole * 1000;
  const fraction = rest === 0 ? '' : `.${String(rest).padStart(3, '0').replace(/0+$/, '')}`;
  return `${formatCount(whole)}${fraction}`;
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
  idleThresholdMs: number,
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
    if (gap !== undefined && gap >= idleThresholdMs) idleResumes += 1;
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
    {
      ...count('idleResumes', 'long-idle resumes', idleResumes),
      // The threshold on the tile, because it is the user's setting now
      // (DoD 9.38) and a count without its rule is not a fact anyone can check.
      note: `sessions with a gap of ${secondsOf(idleThresholdMs)} s or more`,
    },
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
 * The provider state — a report list and the selected run (DoD 9.46)
 * ------------------------------------------------------------------------ */

/*
 * The report model lives in `src/insights-report.ts` since DoD 9.46, because
 * the host renders it too (Export). Every name the surface and its tests
 * imported from here is re-exported, so none of them moved.
 */
export {
  AGENT_LABELS,
  ESTIMATED_BY_CLAUDE_CODE,
  FINDING_LABELS,
  NO_LONGER_REPORTED,
  REPORT_HEADING,
  SINCE_LAST_RUN_WORDS,
  formatInstant,
  reportOf,
} from '../../src/insights-report.js';
export type { EvidenceRow, FindingRow, RunFacts, RunReport } from '../../src/insights-report.js';

/**
 * What a refused run says when there is no raw output to offer — verbatim,
 * the ruling of 2026-09-22 (round 5, ruling 4).
 */
export const NO_RAW_OUTPUT = 'No raw output for this run.';

/** The right pane before any row is selected — verbatim, spec `Amendment 2026-09-23`. */
export const SELECT_A_REPORT = 'Select a report to preview / download.';

/** The preview when the provider answered `getRun` with no report. */
export const NO_REPORT = 'The provider has no report for this run.';

/** The list when the provider lists no run. */
export const NO_RUNS = 'No run is recorded yet.';

/** One row of the report list: date, findings count, engine. */
export interface ReportListRow {
  readonly runId: string;
  readonly state: InsightsRunState;
  readonly when: string;
  /** `2 findings`, `no findings`, `refused`. */
  readonly outcome: string;
  /** The engine, by its product name. */
  readonly agent: string;
}

/** The right pane, once a row is selected. */
export interface ReportPreview {
  readonly runId: string;
  /** The report, or `null` when the provider had none for this run. */
  readonly report: (RunReport & {
    /** Offer "Show raw output"? Only on a refused run the provider can answer for. */
    readonly rawOutput: boolean;
    /** {@link NO_RAW_OUTPUT} on a refused run with none to offer. */
    readonly rawOutputNote?: string;
  }) | null;
  /** Present when the provider had no report for this run. */
  readonly missing?: string;
  /** Present when the parent dropped anything this set carried. */
  readonly dropped?: string;
}

/** Everything the provider state renders. */
export interface ProviderInsightsLayout {
  /** `Agent Deck Insights 0.2.0`. */
  readonly title: string;
  /** The provider's `about.status`, under the title, when it states one. */
  readonly status?: string;
  readonly rows: readonly ReportListRow[];
  /** `null` until a row is selected. */
  readonly preview: ReportPreview | null;
  /** Present when the parent dropped anything the run list carried. */
  readonly dropped?: string;
}

function droppedLine(n: number, what: string): string | undefined {
  if (n <= 0) return undefined;
  return `${plural(n, 'value')} ${what} did not pass the check and ${n === 1 ? 'is' : 'are'} not shown`;
}

function previewOf(snapshot: InsightsProviderSnapshot): ReportPreview | null {
  const selected = snapshot.selected;
  if (selected === null) return null;
  const dropped = droppedLine(selected.dropped, 'from this report');
  const base = { runId: selected.runId, ...(dropped === undefined ? {} : { dropped }) };
  if (selected.set === null) return { ...base, report: null, missing: NO_REPORT };
  const refused = selected.set.state === 'refused';
  return {
    ...base,
    report: {
      ...reportOf(selected.set),
      rawOutput: refused && selected.rawOutput,
      ...(refused && !selected.rawOutput ? { rawOutputNote: NO_RAW_OUTPUT } : {}),
    },
  };
}

/** The provider state's rows and preview, from the checked snapshot the host sent. */
export function providerInsightsLayout(snapshot: InsightsProviderSnapshot): ProviderInsightsLayout {
  const dropped = droppedLine(snapshot.dropped, 'from the provider’s run list');
  return {
    title: `${snapshot.about.name} ${snapshot.about.version}`,
    ...(snapshot.about.status === undefined ? {} : { status: snapshot.about.status }),
    rows: snapshot.runs.map((run) => ({
      runId: run.runId,
      state: run.state,
      when: formatInstant(run.createdAt),
      outcome: outcomeOf(run),
      agent: AGENT_LABELS[run.agentKind],
    })),
    preview: previewOf(snapshot),
    ...(dropped === undefined ? {} : { dropped }),
  };
}
