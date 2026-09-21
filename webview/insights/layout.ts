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
 * ## The provider state: the provider's text, in the amendment's order
 *
 * Since DoD 9.40/9.41 (spec `Amendment 2026-09-22 — Provider contract v1
 * widened`) a finding carries the provider's text, every string of it
 * already allow-listed and length-capped by `src/insights-provider.ts`. The
 * order is the amendment's: the action's LEAD first, the detail behind an
 * expand, the cause, then the evidence with its labels. Kind, confidence and
 * "since last run" sit beside the lead as WORDS — no score. The run's own
 * facts head the set, and a Claude Code run's usage says it is
 * {@link ESTIMATED_BY_CLAUDE_CODE}. A refused set shows its step and reason.
 */

import type {
  FindingSetView,
  FindingSinceLastRun,
  FindingView,
  InsightsAgentKind,
  InsightsFindingKind,
  InsightsProviderSnapshot,
  InsightsRunState,
  RunSummary,
} from '../../src/model/events.js';
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
 * The provider state
 * ------------------------------------------------------------------------ */

/** The parent's own name for each finding kind, shown beside the provider's lead. */
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

/** The agent CLI a run used, by the name the rest of the product gives it. */
export const AGENT_LABELS: Readonly<Record<InsightsAgentKind, string>> = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
});

/**
 * The words on a Claude Code run's usage, verbatim from the amendment: Claude
 * Code's own usage and cost are its estimate, and the README already says so
 * about the cost figures on the Statistics surface. A Codex run's line carries
 * no such words.
 */
export const ESTIMATED_BY_CLAUDE_CODE = 'estimated by Claude Code';

/**
 * What a refused set says when there is no raw output to offer — verbatim,
 * the ruling of 2026-09-22 (round 5, ruling 4).
 */
export const NO_RAW_OUTPUT = 'No raw output for this run.';

/** "Since last run", as a word. No score, no arrow, no colour of its own. */
export const SINCE_LAST_RUN_WORDS: Readonly<Record<FindingSinceLastRun, string>> = Object.freeze({
  new: 'new',
  still: 'still',
  resolved: 'resolved',
});

/** An instant as the surface prints it: `2026-09-21 14:05 UTC`. */
export function formatInstant(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * A cost as the surface prints it. Two places, or four under a cent: a run
 * that cost 0.004 USD printed as `0.00 USD` is a confident zero standing
 * where a number is.
 */
function formatUsd(usd: number): string {
  return `${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)} USD`;
}

function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** One labelled piece of evidence. */
export interface EvidenceRow {
  readonly label: string;
  /** The value as the provider stated it, a number or a string. */
  readonly value: string;
  /** Where it is from: `statsKey · sessionId`. */
  readonly source: string;
}

/**
 * One finding, in the amendment's order: the action's LEAD first, then what
 * kind it is, the detail behind an expand, the cause, and the evidence.
 */
export interface FindingRow {
  readonly lead: string;
  /** `Re-read loop · high confidence · since last run: new`. */
  readonly meta: string;
  readonly detail: string;
  readonly cause: string;
  readonly evidence: readonly EvidenceRow[];
}

/** The latest run's facts, above its findings. */
export interface RunFacts {
  readonly heading: string;
  /** `Claude Code 2.1.246`. */
  readonly agent: string;
  readonly window: string;
  /** The run's own usage, or `null` when the provider stated none. */
  readonly usage: string | null;
}

/** One history row, as the surface prints it. */
export interface HistoryRow {
  readonly runId: string;
  readonly when: string;
  readonly outcome: string;
  readonly agent: string;
}

/** Everything the provider state renders. */
export interface ProviderInsightsLayout {
  readonly title: string;
  /** `null` when the provider has no latest finding set yet. */
  readonly latest: {
    readonly state: InsightsRunState;
    readonly facts: RunFacts;
    readonly findings: readonly FindingRow[];
    /** A line when there is no finding to show, saying which of two reasons. */
    readonly note?: string;
    /** A refused run's step and reason. */
    readonly refusal?: { readonly step: string; readonly reason: string };
    /** Offer "Show raw output"? Only on a refused set the host could place. */
    readonly rawOutput: boolean;
    /**
     * On a refused set with no raw output to offer, {@link NO_RAW_OUTPUT} —
     * the ruling of 2026-09-22 (round 5, ruling 4). Absent otherwise.
     */
    readonly rawOutputNote?: string;
    /** Present when the provider's own validator rejected any. */
    readonly rejected?: string;
  } | null;
  readonly history: readonly HistoryRow[];
  readonly running: boolean;
  /** Present when the parent dropped anything the provider returned. */
  readonly dropped?: string;
}

function factsOf(set: FindingSetView): RunFacts {
  const excluded = set.window.excluded > 0 ? `; ${formatCount(set.window.excluded)} excluded` : '';
  let usage: string | null = null;
  if (set.usage !== null) {
    const parts = [
      plural(set.usage.prompt, 'prompt token'),
      plural(set.usage.output, 'output token'),
      ...(set.usage.costUsd === undefined ? [] : [formatUsd(set.usage.costUsd)]),
    ];
    const estimated = set.agent.kind === 'claude' ? ` (${ESTIMATED_BY_CLAUDE_CODE})` : '';
    usage = `Run usage: ${parts.join(' · ')}${estimated}`;
  }
  return {
    heading: `Latest run · ${formatInstant(set.createdAt)}`,
    agent: `${AGENT_LABELS[set.agent.kind]} ${set.agent.version}`,
    window: `${plural(set.window.sessions, 'session')} since ${formatInstant(set.window.sinceMs)}${excluded}`,
    usage,
  };
}

function findingOf(finding: FindingView): FindingRow {
  const since =
    finding.sinceLastRun === null ? '' : ` · since last run: ${SINCE_LAST_RUN_WORDS[finding.sinceLastRun]}`;
  return {
    lead: finding.action.lead,
    meta: `${FINDING_LABELS[finding.kind]} · ${finding.confidence} confidence${since}`,
    detail: finding.action.detail,
    cause: finding.cause,
    evidence: finding.evidence.map((item) => ({
      label: item.label,
      value: typeof item.value === 'number' ? String(item.value) : item.value,
      source: `${item.statsKey} · ${item.sessionId}`,
    })),
  };
}

function latestOf(
  set: FindingSetView,
  rawOutput: boolean,
): NonNullable<ProviderInsightsLayout['latest']> {
  const findings = set.findings.map(findingOf);
  let note: string | undefined;
  if (set.state === 'empty') note = 'The run read the window and recorded no findings.';
  // `ok` promises at least one finding; none left here means the parent
  // dropped every one, and the drop line above says how many.
  else if (set.state === 'ok' && findings.length === 0) note = 'No finding from this run passed the check.';
  return {
    state: set.state,
    facts: factsOf(set),
    findings,
    ...(note === undefined ? {} : { note }),
    ...(set.refusal === undefined ? {} : { refusal: { step: set.refusal.step, reason: set.refusal.reason } }),
    rawOutput: set.state === 'refused' && rawOutput,
    ...(set.state === 'refused' && !rawOutput ? { rawOutputNote: NO_RAW_OUTPUT } : {}),
    ...(set.rejected > 0
      ? { rejected: `${plural(set.rejected, 'finding')} rejected by the provider` }
      : {}),
  };
}

function historyOf(run: RunSummary): HistoryRow {
  return {
    runId: run.runId,
    when: formatInstant(run.createdAt),
    outcome:
      run.state === 'refused' ? 'refused' : run.state === 'empty' ? 'no findings' : plural(run.findings, 'finding'),
    agent: AGENT_LABELS[run.agentKind],
  };
}

/** The provider state's rows, from the checked snapshot the host sent. */
export function providerInsightsLayout(snapshot: InsightsProviderSnapshot): ProviderInsightsLayout {
  return {
    title: `${snapshot.about.name} ${snapshot.about.version}`,
    latest: snapshot.latest === null ? null : latestOf(snapshot.latest, snapshot.rawOutput),
    history: snapshot.runs.map(historyOf),
    running: snapshot.running,
    ...(snapshot.dropped > 0
      ? { dropped: `${plural(snapshot.dropped, 'value')} from the provider did not pass the check and ${snapshot.dropped === 1 ? 'is' : 'are'} not shown` }
      : {}),
  };
}
