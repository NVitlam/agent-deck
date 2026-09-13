/**
 * `deriveStats(SessionState, params) -> StatsRecord` — Component 8, the pure
 * core of Layer 1.
 *
 * v0.7.0 Phase 2, DoD 2.2. Structure only, engine-agnostic, no clock of its
 * own, no filesystem, no `vscode`, no engine module. `derive.test.ts` walks this
 * file's whole transitive import graph and asserts it, the way
 * `bridge/apply.test.ts` does for the webview's reducer.
 *
 * ## Purity is not tidiness here, it is what makes a golden mean anything
 *
 * A committed golden `StatsRecord` is only evidence if the same input yields
 * the same bytes on any machine at any time. Everything that could break that
 * is a PARAMETER: the thresholds, the price table, and `now`. The one clock
 * reading Layer 1 needs — how long a tool has been stalled — is supplied by the
 * caller, which is also what lets the model and the record agree about "now"
 * instead of reading the clock twice and disagreeing.
 *
 * ## The three refusals, in the order they apply
 *
 *   1. **Coverage (G3).** `schemaOk !== true` or a non-empty `parked` yields
 *      `excluded:<code>` with every table empty and every total zero. No
 *      partial stats, ever — see `exclude.ts` for why a filtered table is worse
 *      than an empty one.
 *   2. **Engine capability (spec §D).** A fact the engine cannot supply is
 *      named in `unavailable` and its table stays empty. Never a substitute,
 *      never a zero standing in for an absence.
 *   3. **Field presence.** Within a capable engine, a session that simply has
 *      no compactions gets an empty list and says nothing in `unavailable` —
 *      that is a fact about the session rather than about the engine. Keeping
 *      2 and 3 apart is the whole reason VERDICT.md 0.4 reports `present` and
 *      `fired` as separate columns.
 */

import type { AgentNode, SessionState, ToolNode, UsageTurn } from '../model/events.js';
import { isAgentNode } from '../model/events.js';

import type { DeriveConstants } from './constants.js';
import { DEFAULT_CONSTANTS, ENGINE_FACT_GAPS } from './constants.js';
import { cacheRatioOf, contextFillOf, deriveCompactions, deriveContextChurn } from './context.js';
import { coverageOf } from './exclude.js';
import type { AgentCalls } from './loops.js';
import { deriveChurn, deriveLoops } from './loops.js';
import type { PricingTable } from './pricing.js';
import { costOfSeries } from './pricing.js';
import type {
  AgentStats,
  CostSource,
  FileStats,
  StatsEngine,
  StatsRecord,
  StatsToolClass,
  ToolStats,
} from './schema.js';
import { STATS_SCHEMA_VERSION } from './schema.js';
import { deriveStalls } from './stalls.js';
import { deriveTiming } from './timing.js';
import { classOf } from './toolclass.js';

/** Everything the deriver needs that is not the session itself. */
export interface DeriveParams {
  /** Thresholds. Defaults to the shipped, measured values. */
  constants?: DeriveConstants;
  /** The user's own `agentDeck.pricing`, already parsed. Empty by default. */
  pricing?: PricingTable;
  /** Model ids whose pricing entry was malformed — reported, never repaired. */
  pricingInvalid?: readonly string[];
  /**
   * The instant the caller considers "now", for F13's elapsed stall time.
   *
   * Absent is legitimate and means "do not measure elapsed time": every stall
   * still appears, with `stalledMs: 0`. Reading a clock here instead would make
   * the deriver impure and every golden a moving target.
   */
  now?: number;
}

/** One agent, its own calls, and the subagents hanging off it. */
interface AgentSlice {
  agent: AgentNode;
  /** Tool calls whose direct parent is this agent. */
  tools: ToolNode[];
}

/**
 * Every agent in the tree, depth-first, with the calls that belong to each.
 *
 * A tool belongs to the agent whose DIRECT child it is. Nothing is attributed
 * by proximity or by ordinal range: the grafter has already made the placement
 * a keyed join, and re-deriving it here from anything softer would be inventing
 * an attribution the tree already states.
 */
function sliceTree(root: AgentNode): AgentSlice[] {
  const out: AgentSlice[] = [];
  const visit = (node: AgentNode): void => {
    const tools: ToolNode[] = [];
    const children: AgentNode[] = [];
    for (const child of node.children) {
      if (isAgentNode(child)) children.push(child);
      else tools.push(child);
    }
    out.push({ agent: node, tools });
    for (const child of children) visit(child);
  };
  visit(root);
  return out;
}

/**
 * Every call in the session, in one deterministic order.
 *
 * F1 needs a first and last touch that are comparable ACROSS agents, and
 * `ToolNode.ordinal` is explicitly not — `events.ts` says "per AGENT, not per
 * session, so two agents' ordinals are not comparable and nothing should sort
 * across them". So F1's two columns are positions in THIS sequence: a
 * depth-first walk of the tree, each agent's own calls in ordinal order. It is
 * stable for a given tree and it is the only session-wide ordering the model
 * makes available.
 */
function sessionSequence(slices: readonly AgentSlice[]): ToolNode[] {
  const out: ToolNode[] = [];
  for (const slice of slices) {
    const ordered = [...slice.tools].sort(
      (a, b) =>
        (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    out.push(...ordered);
  }
  return out;
}

/**
 * F15 — which spawned agents were spawned by a call that carries no result.
 *
 * v0.8.0 Phase 7, DoD 7.4; spec `Amendment 2026-09-12`: *"A spawned agent
 * whose spawning `Agent` call has no `tool_result` in the parent transcript.
 * Structural; never inferred from message content."*
 *
 * The join is `SpawnEdge.toolUseId` -> `ToolNode.id`, and the answer is that
 * node's STATUS. The grafter's rule is `resultPreview === undefined ?
 * 'running' : 'done'`, so `done` and `error` both mean a result arrived, and
 * `running` and `stalled` both mean none has — `stalled` is `running` promoted
 * by `src/model/stall.ts` and is the same absence with a clock reading on it.
 * No message, preview or payload is read.
 *
 * **Absent, not empty, where the session states no spawn edges.** `undefined`
 * is what routes the caller to `F15:<engine>` and to an absent
 * `totals.subagentsUnreceived`; an empty map would read as "every subagent got
 * its result", which is a zero standing in for an absence.
 *
 * An edge naming a `tool_use` id that is in no tool node of this tree yields no
 * entry, so its agent reads `false`: the spawning call is not in the tree, so
 * this session states nothing about whether a result arrived, and the fact is
 * "no result is present" rather than "a result is missing".
 */
function resultUnreceivedByAgent(
  state: SessionState,
  sequence: readonly ToolNode[],
): Map<string, boolean> | undefined {
  const edges = state.spawnEdges;
  if (edges === undefined) return undefined;
  const statusById = new Map<string, ToolNode['status']>();
  for (const tool of sequence) statusById.set(tool.id, tool.status);
  const out = new Map<string, boolean>();
  for (const edge of edges) {
    const status = statusById.get(edge.toolUseId);
    if (status === undefined) continue;
    out.set(edge.agentId, status === 'running' || status === 'stalled');
  }
  return out;
}

/** F1 — per-file touch counts. Empty for an engine that names no files. */
function deriveFiles(
  sequence: readonly ToolNode[],
  countErrors: boolean,
  classOfTool: ClassResolver,
): FileStats[] {
  const byPath = new Map<string, FileStats>();
  sequence.forEach((tool, index) => {
    const filePath = tool.filePath;
    if (filePath === undefined) return;
    const klass = classOfTool(tool);
    let row = byPath.get(filePath);
    if (row === undefined) {
      row = {
        filePath,
        reads: 0,
        edits: 0,
        writes: 0,
        errors: 0,
        firstTouchSeq: index,
        lastTouchSeq: index,
      };
      byPath.set(filePath, row);
    }
    if (klass === 'read') row.reads += 1;
    else if (klass === 'edit') row.edits += 1;
    else if (klass === 'write') row.writes += 1;
    if (countErrors && tool.status === 'error') row.errors += 1;
    row.lastTouchSeq = index;
  });
  return [...byPath.values()].sort((a, b) =>
    a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0,
  );
}

/**
 * The class of a tool, resolved against ONE engine's vocabulary.
 *
 * `toolclass.ts` is keyed by (engine, tool) because the vocabularies overlap —
 * CC's `Read` and OpenCode's `read` differ only in case today and nothing makes
 * that permanent. The engine is therefore a PARAMETER at every call site here.
 *
 * It was module-level mutable state in the first draft of this file, which is
 * exactly the shape that makes a pure function impure: two `deriveStats` calls
 * interleaved by an `await` anywhere above them would have classified one
 * session's tools under the other's engine, and every test that derives one
 * session at a time would have stayed green.
 */
type ClassResolver = (tool: ToolNode) => StatsToolClass;

function resolverFor(engine: StatsEngine): ClassResolver {
  return (tool) => classOf(engine, tool.toolName);
}

/** F2 — per-tool call counts. `errors` omitted where the engine states none. */
function deriveTools(
  sequence: readonly ToolNode[],
  countErrors: boolean,
  classOfTool: ClassResolver,
): ToolStats[] {
  const byName = new Map<string, ToolStats & { durations: number[] }>();
  for (const tool of sequence) {
    let row = byName.get(tool.toolName);
    if (row === undefined) {
      row = {
        toolName: tool.toolName,
        class: classOfTool(tool),
        calls: 0,
        ...(countErrors ? { errors: 0 } : {}),
        durations: [],
      };
      byName.set(tool.toolName, row);
    }
    row.calls += 1;
    if (countErrors && tool.status === 'error') row.errors = (row.errors ?? 0) + 1;
    if (typeof tool.durationMs === 'number' && Number.isFinite(tool.durationMs)) {
      row.durations.push(tool.durationMs);
    }
  }
  return [...byName.values()]
    .map(({ durations, ...row }) => ({
      ...row,
      ...(durations.length === 0
        ? {}
        : {
            durationMsSum: durations.reduce((a, b) => a + b, 0),
            durationMsMax: Math.max(...durations),
          }),
    }))
    .sort((a, b) => (a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0));
}

/** An empty record, for an excluded session. Every table empty, every total 0. */
function excludedRecord(
  state: SessionState,
  engine: StatsEngine,
  coverage: StatsRecord['coverage'],
  constants: DeriveConstants,
): StatsRecord {
  return {
    statsSchemaVersion: STATS_SCHEMA_VERSION,
    sessionId: state.sessionId,
    engine,
    projectSlug: state.projectSlug,
    startedAt: state.root.startedAt,
    ...(state.root.endedAt === undefined ? {} : { endedAt: state.root.endedAt }),
    coverage,
    agents: [],
    files: [],
    tools: [],
    loops: [],
    churn: [],
    contextChurn: [],
    compactions: [],
    stalls: [],
    // The block is present and holds nothing, which is what it holds for any
    // session stating no instant. An excluded record names no per-fact gap at
    // all — `coverage` is the single reason, stated once — so `F14:<engine>`
    // is NOT added here: the session's times were not looked at rather than
    // not stated.
    timing: {},
    totals: {
      prompt: 0,
      output: 0,
      compactions: 0,
      subagents: 0,
      silentSubagents: 0,
      stalls: 0,
    },
    params: paramsOf(engine, constants),
    unavailable: [],
  };
}

function paramsOf(engine: StatsEngine, constants: DeriveConstants): StatsRecord['params'] {
  const spike = constants.spikeTokens[engine];
  return { loopMin: constants.loopMin, ...(spike === undefined ? {} : { spikeTokens: spike }) };
}

/**
 * One session's facts.
 *
 * Total by construction: every branch returns a `StatsRecord`, and nothing here
 * throws on a shape it did not expect. G2 makes a deriver failure a counted,
 * skipped event rather than something the deck notices, and the cheapest way to
 * honour that is not to fail.
 */
export function deriveStats(state: SessionState, params: DeriveParams = {}): StatsRecord {
  const constants = params.constants ?? DEFAULT_CONSTANTS;
  const pricing: PricingTable = params.pricing ?? new Map();
  // `SessionState.engine` is optional and absence reads as `'cc'` — the
  // convention `events.ts` states and `session.ts` implements.
  const engine: StatsEngine = state.engine ?? 'cc';

  const verdict = coverageOf(state);
  if (verdict.coverage !== 'full') {
    return excludedRecord(state, engine, verdict.coverage, constants);
  }

  // Seeded with this engine's MEASURED capability gaps, so a fact the engine
  // cannot supply is named before anything looks at this session's data. The
  // same set then gains the gaps that are this SESSION's rather than the
  // engine's. Both kinds are legitimate; keeping them in one list is what lets
  // a reader see every reason a table is empty in one place.
  const unavailable = new Set<string>(ENGINE_FACT_GAPS[engine]);
  const canCountToolErrors = !unavailable.has(`F2.errors:${engine}`);
  const canNameFiles = !unavailable.has(`F1:${engine}`);
  const canChurn = !unavailable.has(`F4:${engine}`);

  const slices = sliceTree(state.root);
  const sequence = sessionSequence(slices);
  const agentCalls: AgentCalls[] = slices.map((s) => ({ agentId: s.agent.id, tools: s.tools }));

  // ---- F1, F2 ------------------------------------------------------------
  const classOfTool = resolverFor(engine);
  const files = canNameFiles ? deriveFiles(sequence, canCountToolErrors, classOfTool) : [];
  const tools = deriveTools(sequence, canCountToolErrors, classOfTool);

  // ---- F3, F4 ------------------------------------------------------------
  const { loops, callsWithoutHash } = deriveLoops(agentCalls, constants.loopMin, (name) =>
    classOf(engine, name),
  );
  if (callsWithoutHash > 0) unavailable.add(`F3:${engine}`);
  const churn = canChurn ? deriveChurn(agentCalls, (name) => classOf(engine, name)) : [];

  // ---- F5, F6, F8, F9(b), F15 per agent ----------------------------------
  // `undefined` where this session states no spawn edges — see the helper. The
  // decision is taken ONCE, above the loop, so every agent of one session
  // answers from the same evidence.
  const unreceivedByAgent = resultUnreceivedByAgent(state, sequence);
  const agents: AgentStats[] = [];
  let anySeries = false;
  let userCost = 0;
  let userCostSeen = false;
  for (const slice of slices) {
    const node = slice.agent;
    const { cacheRead, cacheRatio } = cacheRatioOf(node);
    if (node.usageSeries !== undefined && node.usageSeries.length > 0) anySeries = true;
    const cost = costOfSeries(node.usageSeries, node.model, pricing);
    if (cost !== undefined) {
      userCost += cost;
      userCostSeen = true;
    }
    agents.push({
      agentId: node.id,
      kind: node.kind,
      spawnDepth: node.spawnDepth,
      prompt: node.burn?.prompt ?? 0,
      output: node.burn?.output ?? 0,
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheRatio === undefined ? {} : { cacheRatio }),
      toolCalls: slice.tools.length,
      // F8 — "silent subagent" is zero TOOL CALLS, per spec §D's vocabulary
      // note. A main agent is never silent: it is the session.
      silent: node.kind === 'subagent' && slice.tools.length === 0,
      // F15 — never true of `main`, which has no spawning call, and never true
      // where the session states no spawn edges. It is a different fact from
      // `silent` above: a subagent that worked and whose spawning call has no
      // result yet is `silent: false, resultUnreceived: true`.
      resultUnreceived:
        node.kind === 'subagent' && (unreceivedByAgent?.get(node.id) ?? false),
      ...(node.model === undefined ? {} : { model: node.model }),
    });
  }
  if (!anySeries) unavailable.add(`F6:${engine}`);

  // ---- F7 ----------------------------------------------------------------
  const threshold = constants.spikeTokens[engine];
  const contextChurn = deriveContextChurn(
    slices.map((s) => ({
      agentId: s.agent.id,
      ...(s.agent.usageSeries === undefined
        ? {}
        : { series: s.agent.usageSeries as readonly UsageTurn[] }),
    })),
    threshold,
  );
  if (contextChurn === undefined) unavailable.add(`F7:${engine}`);

  // ---- F10, F12, F13 -----------------------------------------------------
  const contextFill = contextFillOf(state);
  if (contextFill === undefined) unavailable.add(`F10:${engine}`);
  const compactions = deriveCompactions(slices.map((s) => s.agent));
  const stalls = deriveStalls(agentCalls, params.now);
  unavailable.add('F13.completed:snapshot');

  // ---- F9 — one figure, three possible sources, stated precedence --------
  const engineCost = state.totals.costUsd > 0 ? state.totals.costUsd : undefined;
  const telemetryCost =
    typeof state.telemetryCostUsd === 'number' && state.telemetryCostUsd > 0
      ? state.telemetryCostUsd
      : undefined;
  // v0.7.1 DoD 6.3b (user ruling, 2026-09-10): a telemetry cost is a SUM OF
  // INCREMENTS this window received, so it is a candidate only when the window
  // also received the session's `claude_code.session.count` point, which
  // Claude Code emits once at the session's start. Without it the sum starts
  // somewhere later — a reload, a late enable, a window opened mid-session —
  // and is left out of the precedence and named, never shown as the session's
  // cost.
  const telemetryComplete = state.telemetrySessionCountSeen === true;
  if (telemetryCost !== undefined && !telemetryComplete) unavailable.add('F9:telemetry-partial');
  const priced = userCostSeen ? userCost : undefined;
  const present: CostSource[] = [];
  if (engineCost !== undefined) present.push('engine');
  if (telemetryCost !== undefined && telemetryComplete) present.push('telemetry');
  if (priced !== undefined) present.push('user');
  const costSource = present[0];
  const costUsd =
    costSource === 'engine' ? engineCost : costSource === 'telemetry' ? telemetryCost : priced;
  if (costSource === undefined) unavailable.add(`F9:${engine}`);
  // Which sources were available and lost — DoD 2.6. A single figure with no
  // note would leave a reader unable to tell "one source" from "three that
  // disagreed", and the losing sources are exactly what a support question
  // about a surprising number needs.
  for (const source of present.slice(1)) unavailable.add(`F9:${source}-present`);
  // ONE code however many entries were malformed: the record names the
  // CONDITION, and the ids themselves are user-authored strings that have no
  // business on the G4 allow-list. `parsePricing` returns the list for the
  // diagnostics channel, which is where §F says a malformed entry is reported.
  if ((params.pricingInvalid ?? []).length > 0) unavailable.add('F9:user-pricing-invalid');

  const totalPrompt = agents.reduce((sum, a) => sum + a.prompt, 0);
  const totalOutput = agents.reduce((sum, a) => sum + a.output, 0);
  const totalCacheRead = agents.reduce<number | undefined>(
    (sum, a) => (a.cacheRead === undefined ? sum : (sum ?? 0) + a.cacheRead),
    undefined,
  );

  // ---- F14 — six figures, all differences or ratios of stated instants ----
  // Below the totals because two of the rates are functions of them, and below
  // F9 because the third is a function of a cost that exists only if a source
  // was selected. `costUsd` is passed rather than re-derived: the cost on the
  // record and the cost in the rate are the same number by construction.
  const timing = deriveTiming({
    sequence,
    agents: slices.map((s) => s.agent),
    tokens: totalPrompt + totalOutput,
    ...(costUsd === undefined || costSource === undefined ? {} : { costUsd }),
  });
  // The SESSION states no instant, so no figure can be derived. Named with the
  // engine, the way `F6`/`F7`/`F10` are named a few lines above, and for the
  // same reason they are not in `ENGINE_FACT_GAPS`: all three engines state
  // times on every committed session (`f14-corpus.test.ts` pins the census), so
  // this is a fact about the session in front of the deriver, and the day an
  // engine stops stating times it is reported from the data with no edit to
  // that table.
  if (Object.keys(timing).length === 0) unavailable.add(`F14:${engine}`);
  // F15 needs `SessionState.spawnEdges`, which is OPTIONAL. Absent there, the
  // count is absent too — a 0 would be a zero standing in for an absence, which
  // §D forbids by name — and the gap is named instead.
  if (unreceivedByAgent === undefined) unavailable.add(`F15:${engine}`);

  return {
    statsSchemaVersion: STATS_SCHEMA_VERSION,
    sessionId: state.sessionId,
    engine,
    projectSlug: state.projectSlug,
    startedAt: state.root.startedAt,
    ...(state.root.endedAt === undefined ? {} : { endedAt: state.root.endedAt }),
    coverage: 'full',
    agents,
    files,
    tools,
    loops,
    churn,
    contextChurn: contextChurn ?? [],
    compactions,
    stalls,
    timing,
    totals: {
      prompt: totalPrompt,
      output: totalOutput,
      ...(totalCacheRead === undefined ? {} : { cacheRead: totalCacheRead }),
      ...(costUsd === undefined || costSource === undefined ? {} : { costUsd, costSource }),
      compactions: compactions.length,
      ...(contextFill === undefined ? {} : { contextFill }),
      subagents: agents.filter((a) => a.kind === 'subagent').length,
      silentSubagents: agents.filter((a) => a.silent).length,
      // Present IFF the session states spawn edges. Every subagent's flag is
      // already `false` when they are absent, so counting it would produce a
      // confident 0 about a question the session did not answer.
      ...(unreceivedByAgent === undefined
        ? {}
        : { subagentsUnreceived: agents.filter((a) => a.resultUnreceived).length }),
      stalls: stalls.length,
    },
    params: paramsOf(engine, constants),
    unavailable: [...unavailable].sort(),
  };
}

/** Re-exported so a caller needs one import to build and check a record. */
export type { StatsRecord } from './schema.js';
