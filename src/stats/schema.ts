/**
 * `StatsRecord` — the Layer 1 fact record, and the runtime validator that keeps
 * its string surface an allow-list.
 *
 * v0.7.0 Phase 2, DoD 2.1. Spec `agent-deck-spec.md` §F states the shape; the
 * deviations from it are enumerated under "Where this differs from §F" below,
 * every one of them dated evidence rather than preference.
 *
 * ## THE ALLOW-LIST IS THE G4 MECHANISM, AND IT IS A LIST OF KEYS
 *
 * G4, extended for Layer 1: *"`StatsRecord` string fields are an allow-list
 * (`sessionId`, `agentId`, `toolName`, `filePath`, `engine`, enum codes, schema
 * version)."* The enforcement here is deliberately KEY-based and RECURSIVE:
 * {@link validateStatsRecord} walks the whole object graph and rejects any
 * string-valued property whose key is not in {@link STATS_STRING_FIELDS} —
 * anywhere, at any depth, on a key nobody declared.
 *
 * That shape is chosen over "check the fields we know about" because the defect
 * it exists to stop is a field somebody ADDS. A validator that checks declared
 * fields passes an undeclared one forever; a validator that rejects undeclared
 * string keys goes red the moment a preview, a label, or a message fragment is
 * spliced into the record, which is the only way this guarantee can fail.
 *
 * It is the cheap half. The expensive half is `redaction.test.ts` (DoD 2.7),
 * which asserts against LITERAL CAPTURED BYTES from all three corpora that no
 * >= 12-byte run of thinking, reasoning, payload or message text appears in any
 * golden. The allow-list stops a new field; the byte test stops an old field
 * quietly acquiring new content.
 *
 * ## What is NOT carried, and why each was considered
 *
 *   - **`AgentNode.label`.** It is `meta.agentType + meta.description`, and the
 *     description half is prose written by whoever spawned the agent. It is the
 *     single most content-shaped string on the tree and it is excluded outright.
 *   - **`inputPreview` / `resultPreview`.** Tool payloads. The Layer 1
 *     non-goals forbid content, and these are content by definition.
 *   - **`inputHash`.** G4-safe by construction (§E: "A hash is not content and
 *     survives G4") and still omitted: a loop is identified by its agent, its
 *     tool and its ordinals, so 64 hex characters per loop would be record
 *     weight buying nothing a reader or the API can use. If Layer 2 ever needs
 *     to correlate loops ACROSS sessions, that is the change that earns it.
 *
 * ## Where this differs from spec §F, with the reason
 *
 *   - **`stalls: StallRecord[]` is added.** §F's interface predates F13, which
 *     §L adds to §D on 2026-09-06 ("**F13 — stalls** joins §D"). Without it the
 *     record cannot carry a fact the spec now names.
 *   - **`params.spikeTokens` is OPTIONAL.** §F types it `number`; §L then keyed
 *     `SPIKE_TOKENS` by engine and gave only CC a value. A required number
 *     would have forced a substitute onto OpenCode and Codex, which §D forbids
 *     in as many words ("never a substitute"). Absent means "this engine has no
 *     measured threshold", and `unavailable` says so by name.
 *   - **`AgentStats.model` is carried, and G4's parenthetical does not list
 *     it.** F9(b) is defined as `usageSeries x the user's own price for the
 *     transcript's `model` id`, and §D requires the surface to show "the ids
 *     seen so the user can copy them" — the feature is unusable without it. A
 *     model id is an engine-written identifier of exactly the same class as
 *     `toolName`, which G4's list does include. **This is recorded as a
 *     proposed addition to G4's parenthetical rather than taken as settled:
 *     amending a G-letter is reserved to the user (CLAUDE.md reserved item 4),
 *     and the Phase 2 handoff carries it as an open item.** What is not left to
 *     argument is the guarantee itself: `redaction.test.ts` covers `model` like
 *     every other string in the record.
 *   - **`ToolStats.errors` is optional.** VERDICT.md 0.4 records Codex F2 as
 *     "DERIVABLE (errors unavailable)": Codex states no structured tool status,
 *     and this repository's grafter derives `done` from the mere PRESENCE of a
 *     result. Emitting `errors: 0` there would publish a zero that is an
 *     artefact of the grafter's rule rather than a fact about the session.
 */

// The ONLY import, and the guard in `derive.test.ts` asserts it: `events.ts` is
// the pure-types layer, reachable from a CSP-strict bundle and from a node
// host alike. Nothing here may reach a `node:` builtin, `vscode`, or an engine.
import type { CompactionRecord } from '../model/events.js';

/**
 * The record format. Bumped when a reader must notice a change.
 *
 * **2 as of v0.8.0 Phase 7 (DoD 7.1), and the bump COSTS A USER THEIR
 * HISTORY.** {@link validateStatsRecord} requires this exact value, and the
 * store's reader counts a line it cannot validate on `storeMalformed` and
 * skips it — the behaviour `store.ts`'s header already states for "a record
 * from a future schema version", reached here from the other side. So every
 * record 0.7.x wrote is skipped by 0.8.0: Trends starts again, nothing on
 * disk is rewritten, and no read fails. Stated on the constant because the
 * consequence is a user-visible one that the number itself does not show, and
 * it is named in the 0.8.0 CHANGELOG and README for the same reason.
 */
export const STATS_SCHEMA_VERSION = 2;

/** The three observation engines, as `SessionState.engine` names them. */
export type StatsEngine = 'cc' | 'opencode' | 'codex';

/**
 * Why a session carries no facts.
 *
 *   - `parked` — the grafter could not place every node (G3: no partial tree).
 *   - `unsupported` — the fingerprint refused the session.
 *   - `partial` — the engine read only part of the transcript (v0.8.0 DoD 7.7:
 *     an oversize Codex file, read as its head and its last 16 MiB). Every
 *     count over it would be a count over a subset carrying no sign of it —
 *     the reason `parked` is total, applied to bytes instead of nodes. Added
 *     after the phase-7 verifier found such sessions stored as `full`, which
 *     made the README's "a session Agent Deck could not read in full … appears
 *     in no table" false.
 *   - `deriver-error` — {@link StatsRecord} construction threw. Set by the
 *     HOST, never here: G2 says a deriver failure increments `statsErrors` and
 *     is skipped, and this code is the thing that failed.
 */
export type ExclusionCode = 'parked' | 'unsupported' | 'partial' | 'deriver-error';

/** `'full'`, or why the session has none. */
export type Coverage = 'full' | `excluded:${ExclusionCode}`;

/**
 * Where a cost figure came from. Present iff `costUsd` is.
 *
 * Precedence, highest first, and the record says which others were available:
 * `engine` (the engine wrote it) > `telemetry` (Claude Code's own OTel
 * estimate) > `user` (the user's `agentDeck.pricing` x the usage series).
 * There is no fourth source and there is no shipped price table.
 */
export type CostSource = 'engine' | 'telemetry' | 'user';

/** What a tool DOES, mirrored from the generated census in `toolclass.ts`. */
export type StatsToolClass = 'read' | 'write' | 'edit' | 'search' | 'shell' | 'spawn' | 'other';

/**
 * F1 — one file, and every touch of it in this session.
 *
 * ## `...Seq`, NOT `...Ordinal`, and the suffix is load-bearing
 *
 * This record carries THREE different numbering systems, and naming them all
 * "ordinal" is how a later reader resolves the wrong node:
 *
 *   - `LoopRecord.ordinals`, `ChurnRecord.fromOrdinal/toOrdinal/ordinals` and
 *     `StallRecord.ordinal` are `ToolNode.ordinal` — **per AGENT**, and
 *     `events.ts` says in as many words that two agents' ordinals "are not
 *     comparable and nothing should sort across them";
 *   - `ContextChurnRecord.ordinal` is a position in that agent's `usageSeries`,
 *     which counts TURNS rather than calls;
 *   - the two fields below are positions in the SESSION-WIDE call sequence, the
 *     only ordering that is comparable across agents and the only one F1 can
 *     use, because a file may be touched by several agents.
 *
 * DoD 4.4 makes a churn chain's ordinals clickable. A reader who generalises
 * from `ChurnRecord` to `FileStats` and looks up `firstTouch` as a per-agent
 * ordinal gets a real node, the wrong one, with nothing going red. The suffix
 * is what stops that being a comment somebody has to have read.
 */
export interface FileStats {
  filePath: string;
  reads: number;
  edits: number;
  writes: number;
  /** Calls naming this file whose status is `error`. */
  errors: number;
  /** Position of the first call naming this file in the SESSION-WIDE sequence. */
  firstTouchSeq: number;
  /** Position of the last. Equal to `firstTouchSeq` when touched once. */
  lastTouchSeq: number;
}

/** F2 — one tool name, and how this session used it. */
export interface ToolStats {
  toolName: string;
  class: StatsToolClass;
  calls: number;
  /** Absent where the engine states no tool status — see the header. */
  errors?: number;
  /** Absent where no call carried a duration. */
  durationMsSum?: number;
  durationMsMax?: number;
}

/** F3 — `LOOP_MIN` or more calls of one tool with one input, inside one agent. */
export interface LoopRecord {
  agentId: string;
  toolName: string;
  class: StatsToolClass;
  /** How many calls share the signature. Always >= the record's `loopMin`. */
  count: number;
  /** Every repeat's ordinal, ascending. `count` is its length. */
  ordinals: number[];
  /**
   * The file every repeat named, when the looping tool named one — v0.7.0
   * Phase 4, DoD 4.2. Spec §G asks the Files view to flag a row "when in a
   * loop or churn chain", and a churn chain already carries its path; a loop
   * did not, so the flag had nothing to join on. Present iff every call in the
   * loop carries the same `ToolNode.filePath` (an identical `inputHash` means
   * an identical input, so a differing path would be a defect, not a case);
   * absent for a loop of a tool that names no file. G4: the value is the same
   * engine-written, structurally extracted `filePath` `FileStats` already
   * carries, on an allow-listed key.
   */
  filePath?: string;
}

/**
 * F4 — `Edit/Write(X)` -> an errored call -> `Edit/Write(X)`, one agent.
 *
 * The window is the locked one (`PLAN.md` Phase 2, user, 2026-09-05): "any
 * `status: error` tool between an `Edit/Write(X)` and the next `Edit/Write(X)`
 * in the same agent; the chain records every ordinal between".
 */
export interface ChurnRecord {
  agentId: string;
  filePath: string;
  /** The first write's ordinal. */
  fromOrdinal: number;
  /** The next write of the same file. */
  toOrdinal: number;
  /** Every tool ordinal STRICTLY between the two writes, ascending. */
  ordinals: number[];
  /** How many of `ordinals` errored. >= 1, or this is not a churn chain. */
  errors: number;
}

/** F7 — one turn whose cache-creation rose by at least `spikeTokens`. */
export interface ContextChurnRecord {
  agentId: string;
  /** The turn's ordinal within its agent's `usageSeries`. */
  ordinal: number;
  /** `cacheCreation(this turn) - cacheCreation(previous turn)`. */
  delta: number;
}

/**
 * F12 — one structural compaction entry.
 *
 * `events.ts`'s {@link CompactionRecord} plus the agent it belongs to. It is
 * named differently on purpose: two types sharing one name in one repository is
 * how the wrong one gets imported.
 */
export interface CompactionStat extends CompactionRecord {
  agentId: string;
}

/**
 * F13 — a tool that has crossed `livenessThresholdMs` of session silence.
 *
 * **There is no `completed` field, and its absence is the honest reading of
 * Component 13.** §D's row asks for "completed yes/no", but §L's correction of
 * 2026-09-06 makes a stall a statement about SILENCE, cleared by any activity:
 * the moment a stalled tool completes, its status is `done` and
 * `stalledSinceMs` is gone. A pure function over ONE snapshot can therefore
 * never observe a completed stall, so a `completed` field could only ever hold
 * `false` — and a field that cannot take its other value is this repository's
 * most-recorded defect shape. Every record says so by name in `unavailable`.
 */
export interface StallRecord {
  agentId: string;
  toolName: string;
  ordinal: number;
  /** Milliseconds since the threshold was crossed, at derivation time. */
  stalledMs: number;
}

/**
 * F14 — what this session's own timestamps say about it, all derived.
 *
 * v0.8.0 Phase 7, DoD 7.2. Every member is optional and every absence is the
 * same fact: **the instants this figure is a function of were not stated by
 * the engine.** Never a zero, never a substitute — §D's rule, applied to time.
 *
 * ## The block is always present, its members need not be
 *
 * A reader always finds the block, so "this session states no time" is an
 * empty object rather than a missing key — which could equally have meant
 * "written by an older deriver". The schema version above already answers
 * that second question, and this shape keeps the two questions apart.
 *
 * ## No clock is read here, and that is what makes a golden mean anything
 *
 * Every figure below is a difference or a ratio of instants ON THIS RECORD's
 * own inputs. `deriveStats` has no clock of its own (see `derive.ts`'s
 * header), and a span measured against `now` would move every time a golden
 * was regenerated. A session still running therefore reports the span it has
 * EVIDENCE of, never the span since it started.
 */
export interface TimingStats {
  /**
   * Last stated instant minus first stated instant, over every F14 instant in
   * the session — tool starts, tool ends and usage-turn times alike.
   *
   * NOT `endedAt - startedAt`. Those two are the session's own envelope, and
   * on Codex `endedAt` is a FILE MTIME (`graft.ts` says so in as many words),
   * so a wall time built on them would be partly a statement about the
   * filesystem. This one is a statement about work the engine timestamped.
   */
  wallMs?: number;
  /** First tool start minus the first stated instant. 0 is a real answer. */
  timeToFirstToolMs?: number;
  /**
   * The largest interval between one call starting and the next starting, in
   * the SESSION-WIDE call order.
   *
   * Start-to-start rather than end-to-start, because an end is absent on every
   * running call and on any engine that states none, so a gap measured from a
   * mixture of the two would be a different quantity from row to row. Absent
   * unless at least two calls state a start.
   */
  longestGapMs?: number;
  /** `(totals.prompt + totals.output) / (wallMs / 60000)`. Needs `wallMs > 0`. */
  tokensPerMin?: number;
  /** Calls in the session-wide sequence over the same minutes. */
  callsPerMin?: number;
  /** `totals.costUsd` over the same hours. Present only WITH a cost source. */
  costPerHourUsd?: number;
}

/** Per-agent totals. F5, F6, F8's silent flag, F9(b)'s model id. */
export interface AgentStats {
  agentId: string;
  kind: 'main' | 'subagent';
  spawnDepth: number;
  /** F5. */
  prompt: number;
  output: number;
  /** F6 numerator. Absent where the engine states no cache split. */
  cacheRead?: number;
  /** F6. `cacheRead / prompt`, absent with `cacheRead`, or when `prompt` is 0. */
  cacheRatio?: number;
  /** Calls this agent made, at any status. */
  toolCalls: number;
  /** F8 — a spawned agent that made no tool call at all. Never true of `main`. */
  silent: boolean;
  /**
   * F15 — this agent was spawned and its spawning call never got a result.
   *
   * v0.8.0 Phase 7, DoD 7.4; spec `Amendment 2026-09-12`: *"A spawned agent
   * whose spawning `Agent` call has no `tool_result` in the parent transcript.
   * Structural; never inferred from message content."*
   *
   * Read STRUCTURALLY, off two things the model already carries: the
   * `SpawnEdge` naming the `tool_use` block that spawned this agent, and that
   * node's `status`. The grafter's rule is `resultPreview === undefined ?
   * 'running' : 'done'`, so a status of `done` or `error` IS "a result
   * arrived" and `running`/`stalled` IS "none has". No message is read.
   *
   * **It is a statement about this SNAPSHOT, and on a live session it is
   * transient**: a subagent working right now has no result yet and reads
   * true, then reads false when it finishes. That is the amendment's sentence
   * implemented as written — the fact is "no result is present", not "no
   * result will ever come", which a pure function over one snapshot cannot
   * know. The rendered word says only the first (`webview/stats/layout.ts`).
   *
   * Never true of `main` — it has no spawning call — and never true where the
   * session states no spawn edges, which `unavailable` names instead.
   */
  resultUnreceived: boolean;
  /** F9(b) — the model id as the engine wrote it. See the header on G4. */
  model?: string;
}

/** One session's Layer 1 facts. */
export interface StatsRecord {
  statsSchemaVersion: typeof STATS_SCHEMA_VERSION;
  sessionId: string;
  engine: StatsEngine;
  projectSlug: string;
  startedAt: number;
  endedAt?: number;
  coverage: Coverage;
  agents: AgentStats[];
  files: FileStats[];
  tools: ToolStats[];
  loops: LoopRecord[];
  churn: ChurnRecord[];
  contextChurn: ContextChurnRecord[];
  compactions: CompactionStat[];
  stalls: StallRecord[];
  /** F14 — see {@link TimingStats}. Always present; may hold no member. */
  timing: TimingStats;
  totals: {
    prompt: number;
    output: number;
    cacheRead?: number;
    costUsd?: number;
    costSource?: CostSource;
    compactions: number;
    contextFill?: number;
    subagents: number;
    silentSubagents: number;
    /**
     * F15 — how many subagents read `resultUnreceived`.
     *
     * OPTIONAL, unlike `silentSubagents`, and the asymmetry is the point: F8
     * is derived from the tree, which every session has, while F15 needs
     * `SessionState.spawnEdges`, which is optional and absent on a path that
     * does not report it. A 0 there would be a zero standing in for an
     * absence, which §D forbids by name; absent, with `F15:<engine>` in
     * `unavailable`, says the honest thing.
     */
    subagentsUnreceived?: number;
    stalls: number;
  };
  params: { loopMin: number; spikeTokens?: number };
  /**
   * Fact ids this engine, this session, could not supply — `'F7:opencode'`.
   *
   * The grammar is `<factId>[.<part>]:<reason>`, where the reason is an engine
   * name when the gap is the engine's, and a word when it is not
   * (`F13.completed:snapshot`). A sub-part is named when a fact is derivable
   * and one COLUMN of it is not, which is the Codex F2 case.
   *
   * Also carries `F9:<source>-present` for every cost source that WAS available
   * but lost precedence, so a reader can tell "no cost anywhere" from "three
   * sources agreed to disagree" (DoD 2.6), and `F9:telemetry-partial` when a
   * telemetry cost is held but the session's `claude_code.session.count` point
   * was not received, so the cost is not selected (v0.7.1 DoD 6.3b).
   */
  unavailable: string[];
}

/**
 * Every key in a {@link StatsRecord} whose value may be a string.
 *
 * The list is short on purpose and every entry is either an identifier written
 * by an engine, an identifier written by a user's own filesystem, or a closed
 * enum defined in this file. Nothing here is prose, and nothing here is
 * derived from a message, a payload, or a model's output.
 */
export const STATS_STRING_FIELDS: ReadonlySet<string> = new Set([
  // Identity
  'sessionId',
  'engine',
  'projectSlug',
  // Closed enums declared above
  'coverage',
  'costSource',
  'kind',
  'class',
  'trigger',
  // Engine-written identifiers
  'agentId',
  'toolName',
  'model',
  // The user's own path, structurally extracted from ONE named argument key
  'filePath',
  // Fact ids: `F7:opencode`. Elements of an array, keyed by the array's name.
  'unavailable',
]);

/** A validator's answer. `errors` is empty iff `ok`. */
export interface StatsValidation {
  ok: boolean;
  errors: string[];
}

const NUMBER_KEYS_MUST_BE_FINITE = true;

/**
 * Walk a value and report every string-valued key that is not allow-listed.
 *
 * Arrays are walked with their OWN key, so `unavailable: ['F7:opencode']` is
 * judged as `unavailable` rather than as `0`. A key is judged wherever it
 * appears, at any depth, which is what makes the check total.
 */
function walkStrings(value: unknown, key: string, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkStrings(item, key, `${path}[${String(index)}]`, errors);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      walkStrings(child, childKey, path === '' ? childKey : `${path}.${childKey}`, errors);
    }
    return;
  }
  if (typeof value === 'string') {
    if (!STATS_STRING_FIELDS.has(key)) {
      errors.push(`string field off the allow-list: ${path} (key '${key}')`);
    }
    return;
  }
  if (NUMBER_KEYS_MUST_BE_FINITE && typeof value === 'number' && !Number.isFinite(value)) {
    errors.push(`non-finite number: ${path}`);
  }
}

function requireNumber(record: Record<string, unknown>, key: string, errors: string[]): void {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${key} must be a finite number`);
  }
}

function requireArray(record: Record<string, unknown>, key: string, errors: string[]): void {
  if (!Array.isArray(record[key])) errors.push(`${key} must be an array`);
}

const COVERAGE_VALUES: ReadonlySet<string> = new Set([
  'full',
  'excluded:parked',
  'excluded:unsupported',
  'excluded:partial',
  'excluded:deriver-error',
]);

const ENGINE_VALUES: ReadonlySet<string> = new Set(['cc', 'opencode', 'codex']);

/**
 * Runtime validation of one record.
 *
 * Two jobs, in this order, because they fail for different reasons: the
 * STRUCTURE must be a `StatsRecord` (a Phase 3 store line is `JSON.parse`
 * output and carries no types), and the STRING SURFACE must be the allow-list
 * (the G4 mechanism described in the header).
 */
export function validateStatsRecord(value: unknown): StatsValidation {
  const errors: string[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['not an object'] };
  }
  const record = value as Record<string, unknown>;

  if (record['statsSchemaVersion'] !== STATS_SCHEMA_VERSION) {
    errors.push(
      `statsSchemaVersion must be ${String(STATS_SCHEMA_VERSION)}, got ` +
        `${JSON.stringify(record['statsSchemaVersion'])}`,
    );
  }
  for (const key of ['sessionId', 'projectSlug']) {
    if (typeof record[key] !== 'string' || record[key] === '') {
      errors.push(`${key} must be a non-empty string`);
    }
  }
  if (typeof record['engine'] !== 'string' || !ENGINE_VALUES.has(record['engine'])) {
    errors.push(`engine must be one of cc|opencode|codex, got ${JSON.stringify(record['engine'])}`);
  }
  if (typeof record['coverage'] !== 'string' || !COVERAGE_VALUES.has(record['coverage'])) {
    errors.push(`coverage must be a declared value, got ${JSON.stringify(record['coverage'])}`);
  }
  requireNumber(record, 'startedAt', errors);
  if (record['endedAt'] !== undefined) requireNumber(record, 'endedAt', errors);
  for (const key of [
    'agents',
    'files',
    'tools',
    'loops',
    'churn',
    'contextChurn',
    'compactions',
    'stalls',
    'unavailable',
  ]) {
    requireArray(record, key, errors);
  }

  const totals = record['totals'];
  if (totals === null || typeof totals !== 'object' || Array.isArray(totals)) {
    errors.push('totals must be an object');
  } else {
    const t = totals as Record<string, unknown>;
    for (const key of ['prompt', 'output', 'compactions', 'subagents', 'silentSubagents', 'stalls']) {
      requireNumber(t, key, errors);
    }
    // `costSource` is present IFF `costUsd` is — the spec states it as a
    // biconditional, so both directions are checked. A source with no figure is
    // as wrong as a figure with no source.
    const hasCost = t['costUsd'] !== undefined;
    const hasSource = t['costSource'] !== undefined;
    if (hasCost !== hasSource) {
      errors.push('totals.costUsd and totals.costSource must be present together');
    }
    if (hasSource && (typeof t['costSource'] !== 'string' ||
      !['engine', 'telemetry', 'user'].includes(t['costSource']))) {
      errors.push(`totals.costSource must be engine|telemetry|user, got ${JSON.stringify(t['costSource'])}`);
    }
  }

  const params = record['params'];
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    errors.push('params must be an object');
  } else {
    requireNumber(params as Record<string, unknown>, 'loopMin', errors);
  }

  // The allow-list, last, so a structural failure is reported first and a
  // reader is not sent looking for a leak that is really a malformed record.
  walkStrings(record, '', '', errors);

  return { ok: errors.length === 0, errors };
}
