/**
 * The Stats view mode's layout — v0.7.0 Phase 4, DoD 4.2 (spec §G).
 *
 * PURE. `statsLayout(records)` is a function of a `StatsRecord[]` and nothing
 * else: no DOM, no clock, no store, no randomness. That is what lets
 * `webview/goldens/stats/*.json` pin every view at N = 0/1/2/6/12 records and
 * for each R8 fixture, and what lets `src/perf/webview-layout.test.ts` give it
 * a budget. The four Svelte components under `webview/stats/` draw what this
 * returns and derive nothing of their own.
 *
 * WHAT IT NEVER SEES. A session tree. Every number here comes off a
 * `StatsRecord`, which is the allow-listed, host-validated Layer 1 record —
 * so nothing rendered by the Stats view can carry a preview, a label, or a
 * message fragment, because none of those is on the input. Where a view wants
 * a session's LABEL (a human-written string the record deliberately omits),
 * the component looks it up in the live session list; this module hands it an
 * id to look up by and nothing more.
 *
 * G10 applies to this file: every string literal below is a name, a unit or a
 * vocabulary term from spec §D. `scripts/forbidden-words.mjs` scans it.
 *
 * THE INCREMENTAL PROPERTY (DoD 4.2). Adding a record to the input moves no
 * existing Trends point. It holds by construction: a point's `x` is its
 * INDEX in the input times a constant, its `y` is the record's own raw value,
 * and neither depends on any other record. What DOES move with the set — the
 * series maximum — travels separately as `max`, and the renderer turns it into
 * a viewBox, which is a transform and not a coordinate (the rule `viewport.ts`
 * states for the canvas). `stats/layout.test.ts` asserts the property by
 * appending a record and comparing every earlier point.
 */

import type {
  AgentStats,
  CostSource,
  ChurnRecord,
  ExclusionCode,
  LoopRecord,
  StallRecord,
  StatsRecord,
} from '../../src/stats/schema.js';

/* ------------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------------ */

/** Horizontal distance between two consecutive Trends points, in stage units. */
export const TREND_STEP = 24;

/** Horizontal distance between two consecutive turns on the per-turn strip. */
export const TURN_PITCH = 6;

/** Height of the per-turn strip, in stage units. Markers span it. */
export const STRIP_HEIGHT = 18;

/** Records below this count leave the Trends view in its empty state. */
export const TRENDS_MIN_RECORDS = 2;

/**
 * The vocabulary — spec §D's named phenomena, and the ONLY named phenomena.
 * `re-read loop` when the looping tool is read-class; a loop of any other
 * class is an identical-call loop, which is F3's own definition.
 */
export const VOCABULARY = {
  rereadLoop: 're-read loop',
  loop: 'identical-call loop',
  churn: 'churn chain',
  contextChurn: 'context churn',
  silentSubagent: 'silent subagent',
  compaction: 'compaction',
  stall: 'stall',
} as const;

/** The cost source, as the user reads it (spec §D F9 and §L F9(c)). */
export const COST_SOURCE_LABELS: Readonly<Record<CostSource, string>> = {
  engine: 'reported by the engine',
  telemetry: 'estimated by Claude Code',
  user: 'estimated from your prices',
};

/* ------------------------------------------------------------------------ *
 * Shared shapes
 * ------------------------------------------------------------------------ */

/**
 * Which session a row belongs to, by ID ONLY. The component resolves the
 * label; see the header. `engine` travels so a row can carry its engine
 * glyph without a second lookup.
 */
export interface SessionRef {
  sessionId: string;
  engine: StatsRecord['engine'];
  projectSlug: string;
  startedAt: number;
}

function refOf(record: StatsRecord): SessionRef {
  return {
    sessionId: record.sessionId,
    engine: record.engine,
    projectSlug: record.projectSlug,
    startedAt: record.startedAt,
  };
}

/** The last path segment, whichever separator the engine wrote. */
export function basenameOf(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/u, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = at === -1 ? trimmed : trimmed.slice(at + 1);
  return base === '' ? filePath : base;
}

/** Records with facts. An excluded record has empty tables and is absent from every aggregate. */
export function coveredRecords(records: readonly StatsRecord[]): StatsRecord[] {
  return records.filter((r) => r.coverage === 'full');
}

/* ------------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------------ */

export interface FileRow {
  filePath: string;
  /** Primary text (labels law): the basename; the path is on hover. */
  basename: string;
  reads: number;
  edits: number;
  writes: number;
  errors: number;
  /** `reads + edits + writes`. The sort key. */
  touches: number;
  /** How many records name this file. */
  sessions: number;
  /** A loop in some record names this file (F3, `LoopRecord.filePath`). */
  loop: boolean;
  /** A churn chain in some record names this file (F4). */
  churn: boolean;
}

export interface FilesLayout {
  rows: FileRow[];
  /** Records that contributed. 0 is the empty state. */
  records: number;
}

export function filesLayout(records: readonly StatsRecord[]): FilesLayout {
  const covered = coveredRecords(records);
  const rows = new Map<string, FileRow>();
  const loopFiles = new Set<string>();
  const churnFiles = new Set<string>();
  for (const record of covered) {
    for (const loop of record.loops) if (loop.filePath !== undefined) loopFiles.add(loop.filePath);
    for (const chain of record.churn) churnFiles.add(chain.filePath);
    for (const file of record.files) {
      const existing = rows.get(file.filePath);
      const touches = file.reads + file.edits + file.writes;
      if (existing === undefined) {
        rows.set(file.filePath, {
          filePath: file.filePath,
          basename: basenameOf(file.filePath),
          reads: file.reads,
          edits: file.edits,
          writes: file.writes,
          errors: file.errors,
          touches,
          sessions: 1,
          loop: false,
          churn: false,
        });
        continue;
      }
      existing.reads += file.reads;
      existing.edits += file.edits;
      existing.writes += file.writes;
      existing.errors += file.errors;
      existing.touches += touches;
      existing.sessions += 1;
    }
  }
  const out = [...rows.values()];
  for (const row of out) {
    row.loop = loopFiles.has(row.filePath);
    row.churn = churnFiles.has(row.filePath);
  }
  // Total touches descending, then path ascending: deterministic, and a file
  // touched once sorts below one touched fifty times whatever its name.
  out.sort((a, b) => b.touches - a.touches || (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
  return { rows: out, records: covered.length };
}

/* ------------------------------------------------------------------------ *
 * Loops & churn
 * ------------------------------------------------------------------------ */

export interface ChainRow {
  kind: 'loop' | 'churn';
  /** Unique within the layout: session, agent, kind and first ordinal. */
  key: string;
  session: SessionRef;
  agentId: string;
  /** Spec §D's term for this row. */
  term: string;
  /** Loop: the tool. Churn: absent. */
  toolName?: string;
  /** Loop: when the tool named a file. Churn: always. */
  filePath?: string;
  basename?: string;
  /** Loop: repeats. Churn: errored calls inside the chain. */
  count: number;
  /**
   * The ordinals a click can select (DoD 4.4): a loop's repeats, or a churn
   * chain's two writes and everything between them, ascending. Per-agent
   * ordinals — `ToolNode.ordinal` — which is what the link-back resolves.
   */
  ordinals: number[];
}

export interface LoopsLayout {
  rows: ChainRow[];
  loops: number;
  churn: number;
  records: number;
}

function loopRow(session: SessionRef, loop: LoopRecord): ChainRow {
  const first = loop.ordinals[0] ?? 0;
  const row: ChainRow = {
    kind: 'loop',
    key: `${session.sessionId}:${loop.agentId}:loop:${String(first)}`,
    session,
    agentId: loop.agentId,
    term: loop.class === 'read' ? VOCABULARY.rereadLoop : VOCABULARY.loop,
    toolName: loop.toolName,
    count: loop.count,
    ordinals: [...loop.ordinals],
  };
  if (loop.filePath !== undefined) {
    row.filePath = loop.filePath;
    row.basename = basenameOf(loop.filePath);
  }
  return row;
}

function churnRow(session: SessionRef, chain: ChurnRecord): ChainRow {
  return {
    kind: 'churn',
    key: `${session.sessionId}:${chain.agentId}:churn:${String(chain.fromOrdinal)}`,
    session,
    agentId: chain.agentId,
    term: VOCABULARY.churn,
    filePath: chain.filePath,
    basename: basenameOf(chain.filePath),
    count: chain.errors,
    ordinals: [chain.fromOrdinal, ...chain.ordinals, chain.toOrdinal],
  };
}

export function loopsLayout(records: readonly StatsRecord[]): LoopsLayout {
  const covered = coveredRecords(records);
  const rows: ChainRow[] = [];
  let loops = 0;
  let churn = 0;
  for (const record of covered) {
    const session = refOf(record);
    // Input order preserved between records; inside one record the deriver's
    // own order (agent, tool, first ordinal) is kept as it came.
    for (const loop of record.loops) {
      rows.push(loopRow(session, loop));
      loops += 1;
    }
    for (const chain of record.churn) {
      rows.push(churnRow(session, chain));
      churn += 1;
    }
  }
  return { rows, loops, churn, records: covered.length };
}

/* ------------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------------ */

export interface AgentRow {
  agentId: string;
  kind: AgentStats['kind'];
  spawnDepth: number;
  /** Primary text (labels law): the role, never the id. */
  primary: string;
  prompt: number;
  output: number;
  /** F6. Absent renders as an em dash. */
  cacheRatio?: number;
  toolCalls: number;
  silent: boolean;
  model?: string;
}

export interface TurnMarker {
  kind: 'spike' | 'compaction';
  agentId: string;
  /** F7: the usage-series ordinal. F12: the tool-call ordinal. Stated per kind. */
  ordinal: number;
  x: number;
  /** F7 only. */
  delta?: number;
  /** F12 only. */
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
}

export interface TurnStrip {
  width: number;
  height: number;
  pitch: number;
  markers: TurnMarker[];
}

export interface CostView {
  usd?: number;
  source?: CostSource;
  /** The words beside the figure. Absent cost: the not-computed label. */
  label: string;
}

export interface StallRow extends StallRecord {
  key: string;
}

export interface TokensSession {
  session: SessionRef;
  agents: AgentRow[];
  totals: { prompt: number; output: number; cacheRead?: number };
  cost: CostView;
  /** F10. Absent renders as an em dash; never a percentage of a guessed window. */
  contextFill?: number;
  /** F9(b): the ids seen, sorted, deduplicated, for `agentDeck.pricing`. */
  models: string[];
  strip: TurnStrip;
  stalls: StallRow[];
  compactions: number;
  subagents: number;
  silentSubagents: number;
}

export interface TokensLayout {
  sessions: TokensSession[];
  records: number;
}

/** What F9 wrote. `label` is what a person reads beside the number. */
export const COST_NOT_COMPUTED_LABEL = 'not computed';

function costOf(record: StatsRecord): CostView {
  const { costUsd, costSource } = record.totals;
  if (costUsd === undefined || costSource === undefined) return { label: COST_NOT_COMPUTED_LABEL };
  return { usd: costUsd, source: costSource, label: COST_SOURCE_LABELS[costSource] };
}

function agentPrimary(agent: AgentStats): string {
  return agent.kind === 'main' ? 'main' : `subagent d${String(agent.spawnDepth)}`;
}

function stripOf(record: StatsRecord): TurnStrip {
  const markers: TurnMarker[] = [];
  let maxOrdinal = -1;
  for (const spike of record.contextChurn) {
    markers.push({
      kind: 'spike',
      agentId: spike.agentId,
      ordinal: spike.ordinal,
      x: spike.ordinal * TURN_PITCH,
      delta: spike.delta,
    });
    maxOrdinal = Math.max(maxOrdinal, spike.ordinal);
  }
  for (const compaction of record.compactions) {
    const marker: TurnMarker = {
      kind: 'compaction',
      agentId: compaction.agentId,
      ordinal: compaction.ordinal,
      x: compaction.ordinal * TURN_PITCH,
      trigger: compaction.trigger,
    };
    if (compaction.preTokens !== undefined) marker.preTokens = compaction.preTokens;
    if (compaction.postTokens !== undefined) marker.postTokens = compaction.postTokens;
    markers.push(marker);
    maxOrdinal = Math.max(maxOrdinal, compaction.ordinal);
  }
  // Stable: kind, then agent, then ordinal. Two lists concatenated would
  // order by which fact the deriver wrote first, which is not an order
  // anybody declared.
  markers.sort(
    (a, b) =>
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0) ||
      a.ordinal - b.ordinal,
  );
  return {
    width: maxOrdinal < 0 ? 0 : (maxOrdinal + 1) * TURN_PITCH,
    height: STRIP_HEIGHT,
    pitch: TURN_PITCH,
    markers,
  };
}

export function tokensLayout(records: readonly StatsRecord[]): TokensLayout {
  const covered = coveredRecords(records);
  const sessions = covered.map((record): TokensSession => {
    const models = [...new Set(record.agents.map((a) => a.model).filter((m): m is string => m !== undefined))].sort();
    const agents = record.agents.map((agent): AgentRow => {
      const row: AgentRow = {
        agentId: agent.agentId,
        kind: agent.kind,
        spawnDepth: agent.spawnDepth,
        primary: agentPrimary(agent),
        prompt: agent.prompt,
        output: agent.output,
        toolCalls: agent.toolCalls,
        silent: agent.silent,
      };
      if (agent.cacheRatio !== undefined) row.cacheRatio = agent.cacheRatio;
      if (agent.model !== undefined) row.model = agent.model;
      return row;
    });
    const session: TokensSession = {
      session: refOf(record),
      agents,
      totals: {
        prompt: record.totals.prompt,
        output: record.totals.output,
        ...(record.totals.cacheRead === undefined ? {} : { cacheRead: record.totals.cacheRead }),
      },
      cost: costOf(record),
      models,
      strip: stripOf(record),
      stalls: record.stalls.map((stall) => ({
        ...stall,
        key: `${record.sessionId}:${stall.agentId}:${String(stall.ordinal)}`,
      })),
      compactions: record.totals.compactions,
      subagents: record.totals.subagents,
      silentSubagents: record.totals.silentSubagents,
    };
    if (record.totals.contextFill !== undefined) session.contextFill = record.totals.contextFill;
    return session;
  });
  return { sessions, records: covered.length };
}

/* ------------------------------------------------------------------------ *
 * Trends
 * ------------------------------------------------------------------------ */

export type TrendSeriesId = 'prompt' | 'loops' | 'cost';

export interface TrendPoint {
  sessionId: string;
  /** Position in the input, among COVERED records. */
  index: number;
  x: number;
  /** The raw value. Never scaled here — scaling is the renderer's transform. */
  y: number;
}

/**
 * ONE ENGINE'S line within a series — v0.7.0 DoD 4.12, user ruling 2026-09-09.
 *
 * **Trends never shares an axis across engines**, and the measurement that
 * forced the rule is worth keeping: over a real 102 MB store, the median
 * `totals.prompt` was 106,531,677 for Claude Code against 18,584 for Codex —
 * a factor of ~5,700. A single shared `max` put every Codex and OpenCode point
 * on the baseline, present in the DOM and invisible on screen, and the first
 * report of it read as "Trends shows Codex only".
 *
 * The disparity is not a defect to be fixed here: `totals.prompt` is spec §F's
 * figure and it stays as defined, a SUM over assistant messages that legitimately
 * includes cache reads — so it grows with session length on Claude Code and does
 * not on an engine that reports differently. Two engines' prompt totals are not
 * comparable quantities, so this layout stops pretending they are and normalises
 * each engine against its own maximum.
 *
 * `label` is deliberately ABSENT. The engine is the fact and belongs in the
 * golden; the words a person reads are `text.ts`'s `ENGINE_NAMES`, applied by
 * the component. That also keeps this module free of a value import from
 * `text.ts`, which imports `SessionRef` back from here.
 */
export interface TrendLine {
  engine: SessionRef['engine'];
  points: TrendPoint[];
  /** The largest `y` IN THIS LINE. Per-engine, which is the whole point. */
  max: number;
  /**
   * Every point is zero, so there is nothing to scale — v0.7.0 DoD 4.13.
   *
   * The renderer draws a flat baseline and the label `max 0`, and no path and no
   * markers: a line normalised to its own maximum has no shape when that maximum
   * is zero, and anything drawn in a box scaled to a stand-in height is a picture
   * of the stand-in. Decided HERE rather than in `Trends.svelte` because that
   * component's header says it derives nothing, and a decision a golden can see
   * is one a change has to move.
   *
   * Emitted for every line, true or false, so the goldens pin the NEGATIVE too:
   * a layout that dropped the field would read as "not flat" by accident.
   */
  flat: boolean;
}

export interface TrendSeries {
  id: TrendSeriesId;
  label: string;
  /** One line per engine PRESENT in the records, in `TREND_ENGINE_ORDER`. */
  lines: TrendLine[];
}

export interface TrendsLayout {
  series: TrendSeries[];
  /** One entry per covered record, in input order — the x axis. */
  sessions: (SessionRef & { index: number; x: number })[];
  width: number;
  empty: boolean;
  /**
   * Why the view is empty, when it is.
   *
   * `loading` is DoD 4.12's second half: the stored history has not been read
   * yet, which is not the same fact as "there is no history". Reading a 102 MB
   * store takes visible time and the view used to render the pre-message state —
   * an empty store — as though it were the answer.
   */
  reason?: 'disabled' | 'fewer-than-two' | 'loading';
}

/**
 * The order lines appear in, for every series. Fixed rather than first-seen, so
 * a golden does not move when a corpus is reordered.
 *
 * DERIVED FROM A `Record` KEYED ON THE ENGINE UNION, so a fourth engine is a
 * COMPILE ERROR here rather than a session that appears on the axis and is drawn
 * on no line (`phase-verifier` risk, 2026-09-09). A hand-written array of the
 * same three names type-checks forever and says nothing.
 */
const TREND_ENGINE_RANK: Readonly<Record<SessionRef['engine'], number>> = {
  cc: 0,
  codex: 1,
  opencode: 2,
};

export const TREND_ENGINE_ORDER: readonly SessionRef['engine'][] = (
  Object.keys(TREND_ENGINE_RANK) as SessionRef['engine'][]
).sort((a, b) => TREND_ENGINE_RANK[a] - TREND_ENGINE_RANK[b]);

export const TREND_LABELS: Readonly<Record<TrendSeriesId, string>> = {
  prompt: 'prompt tokens',
  loops: 'loops',
  cost: 'engine-reported cost (USD)',
};

export function trendsLayout(
  records: readonly StatsRecord[],
  storeEnabled = true,
  storeLoaded = true,
): TrendsLayout {
  const covered = coveredRecords(records);
  const sessions = covered.map((record, index) => ({
    ...refOf(record),
    index,
    x: index * TREND_STEP,
  }));
  const series: TrendSeries[] = [];
  const build = (id: TrendSeriesId, valueOf: (r: StatsRecord) => number | undefined): void => {
    const lines: TrendLine[] = [];
    for (const engine of TREND_ENGINE_ORDER) {
      const points: TrendPoint[] = [];
      let max = 0;
      // The x positions stay GLOBAL — a point sits above its own session on the
      // shared axis — while the y scale is this engine's alone. So the axis still
      // reads as "sessions, in order" and a line still connects that engine's
      // sessions in that order.
      covered.forEach((record, index) => {
        if (record.engine !== engine) return;
        const value = valueOf(record);
        if (value === undefined) return;
        points.push({ sessionId: record.sessionId, index, x: index * TREND_STEP, y: value });
        if (value > max) max = value;
      });
      // An engine with nothing to say gets no line, rather than an empty one:
      // a flat line at zero is a claim about that engine, and absence is not.
      if (points.length === 0) continue;
      lines.push({ engine, points, max, flat: max === 0 });
    }
    series.push({ id, label: TREND_LABELS[id], lines });
  };
  build('prompt', (r) => r.totals.prompt);
  build('loops', (r) => r.loops.length);
  // "engine-reported cost per session where present": a user-priced or
  // telemetry figure is NOT an engine report and does not become one here.
  build('cost', (r) => (r.totals.costSource === 'engine' ? r.totals.costUsd : undefined));
  const width = sessions.length === 0 ? 0 : (sessions.length - 1) * TREND_STEP;
  const layout: TrendsLayout = { series, sessions, width, empty: false };
  // `loading` outranks everything, including `disabled`: before the store has
  // been read, "off" and "empty" are both guesses. Never render a partial store
  // as history (DoD 4.12).
  if (!storeLoaded) {
    layout.empty = true;
    layout.reason = 'loading';
  } else if (!storeEnabled) {
    layout.empty = true;
    layout.reason = 'disabled';
  } else if (covered.length < TRENDS_MIN_RECORDS) {
    layout.empty = true;
    layout.reason = 'fewer-than-two';
  }
  return layout;
}

/* ------------------------------------------------------------------------ *
 * Excluded sessions — the footer, and only the footer
 * ------------------------------------------------------------------------ */

export interface ExcludedSummary {
  count: number;
  /** Reason code -> how many. Codes are `ExclusionCode`, nothing invented. */
  byCode: Partial<Record<ExclusionCode, number>>;
}

export function excludedSummary(records: readonly StatsRecord[]): ExcludedSummary {
  const byCode: Partial<Record<ExclusionCode, number>> = {};
  let count = 0;
  for (const record of records) {
    if (record.coverage === 'full') continue;
    const code = record.coverage.slice('excluded:'.length) as ExclusionCode;
    byCode[code] = (byCode[code] ?? 0) + 1;
    count += 1;
  }
  return { count, byCode };
}

/* ------------------------------------------------------------------------ *
 * The whole thing
 * ------------------------------------------------------------------------ */

export interface StatsLayout {
  files: FilesLayout;
  loops: LoopsLayout;
  tokens: TokensLayout;
  trends: TrendsLayout;
  excluded: ExcludedSummary;
  /**
   * The measurement parameters the records were derived under, shown as
   * such (G10: named parameters, not judgments). Taken from the first record;
   * every record of one build carries the same pair.
   */
  params: { loopMin?: number; spikeTokens?: number };
}

export function statsLayout(
  records: readonly StatsRecord[],
  storeEnabled = true,
  storeLoaded = true,
): StatsLayout {
  const first = records[0];
  const params: StatsLayout['params'] = {};
  if (first !== undefined) {
    params.loopMin = first.params.loopMin;
    if (first.params.spikeTokens !== undefined) params.spikeTokens = first.params.spikeTokens;
  }
  return {
    files: filesLayout(records),
    loops: loopsLayout(records),
    tokens: tokensLayout(records),
    // The VIEW does not read this one: `StatsView.svelte` calls `trendsLayout`
    // itself over the STORED records, while everything else here is over the
    // live ones. It is kept because the goldens and the Phase 5 API read the
    // whole layout through one call, and `storeLoaded` is threaded so that
    // caller cannot render an unread store as a history either.
    trends: trendsLayout(records, storeEnabled, storeLoaded),
    excluded: excludedSummary(records),
    params,
  };
}
