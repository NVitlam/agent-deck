/**
 * Agent Deck — the Codex grafter (`PLAN.md` v0.6.0 Phase 2, DoD 2.4 / 2.3a / 2.6).
 *
 * `CodexThread[]` in, `SessionState[]` out. There is no third data model and no
 * third wire contract: the output is the same `../model/events.js` shapes the
 * Claude Code and OpenCode engines already produce, tagged `engine: 'codex'`
 * (spec C11).
 *
 * ---------------------------------------------------------------------------
 * NO I/O, NO CLOCK, NO WORKSPACE
 * ---------------------------------------------------------------------------
 *
 * {@link graftCodexThreads} is a pure function of plain data. It opens nothing,
 * reads no clock and knows nothing about VS Code. The four facts it cannot
 * derive from a thread are injected as {@link CodexGraftOptions}, each with a
 * stated default, exactly as `src/opencode/graft.ts` injects its three.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS NOT
 * ---------------------------------------------------------------------------
 *
 * `toSessionState` in `src/model/graft.ts` is NOT the model for this file and
 * was not consulted as one. It has no production callers at all and sets
 * neither `spawnEdges` nor `parked`; a worker in this repository already took a
 * whole decision on that wrong premise. The Claude Code production path is
 * `SessionModel.viewFromSnapshot`. The three engines share the output contract
 * and nothing else.
 *
 * ---------------------------------------------------------------------------
 * THE THREE RELATIONS, AND WHY THEY ARE THREE
 * ---------------------------------------------------------------------------
 *
 * A reader who collapses these into one will get a working tree by accident and
 * a broken one on the next corpus. They are separate facts, each with its own
 * key, and the spec ranks them:
 *
 *  1. **Which SESSION a thread belongs to** — `session_meta.payload.session_id`,
 *     which names the ROOT thread and does so for a subagent at any depth.
 *     MEASURED 14 of 14 threads across the five committed runs, including the
 *     depth-2 thread of `dup-names`, whose `session_id` is the root's and not
 *     its own parent's. This is what makes a parked child reachable: it parks
 *     on ITS session's `parked` list rather than falling out of the corpus.
 *
 *  2. **Which thread is a thread's PARENT** — `parent_thread_id`. Spec C4:
 *     "`parent_thread_id` states the same edge as an id and is preferred,
 *     **because a name is not an identity**". It is populated in BOTH dialects
 *     (C4a's table), so tree placement never depends on the dialect.
 *
 *  3. **Which CALL spawned a thread** — the two-key join of C4/C4a, and the
 *     only one of the three that differs between dialects:
 *
 *         v2 (collaboration)   output.task_name  <->  child agent_path
 *         v1 (multi_agent_v1)  output.agent_id   <->  child thread id
 *
 *     This supplies {@link SpawnEdge.toolUseId} and the child's position beside
 *     its spawning `ToolNode`. It is NOT what places the child in the tree — a
 *     thread whose spawning call cannot be identified still has a parent, and
 *     dropping it for want of a call id would throw away a working tree.
 *
 * **The `v1` join exists.** An earlier ruling parked the whole `v1` dialect on
 * the premise that a `v1` child "cannot be grafted — there is no `task_name` to
 * join on". `task_name` is absent; the join is not. "I did not find a join" had
 * been written down as "there is no join", and it nearly cost the product a
 * working feature for an entire class of user. `graft.test.ts` pins the `v1`
 * join against the real `resume-twice-v1` run so it cannot be lost again.
 *
 * ---------------------------------------------------------------------------
 * A REFUSED SPAWN IS NOT A PARK
 * ---------------------------------------------------------------------------
 *
 * DoD 2.4. The engine ENFORCES `agent_path` uniqueness and refuses a second
 * spawn asking for a taken path, with the literal output
 * `agent path ` + backtick + `/root/dup` + backtick + ` already exists`. That
 * is not a join that failed; it is a call the engine declined. It renders as a
 * FAILED CALL — a `ToolNode` with `status: 'error'` carrying the refusal text —
 * and it produces no {@link ParkedGraft} at all. `graft.test.ts` asserts the
 * ABSENCE, because a missing park is what would silently pass.
 */

import type {
  AgentNode,
  ParkedGraft,
  SessionState,
  SpawnEdge,
  ToolNode,
  TokenPair,
  TreeNode,
} from '../model/events.js';
import type {
  CodexCounters,
  CodexParkCode,
  CodexSpawn,
  CodexSpawnResolution,
  CodexThread,
  CodexToolCall,
} from './types.js';

// ---------------------------------------------------------------------------
// Labels (spec C7, DoD 2.3a)
// ---------------------------------------------------------------------------

/**
 * The label of a session's ROOT node.
 *
 * Codex's own name for the primary agent. Every child path in the corpus is
 * rooted at it (`/root/alpha`, `/root/outer/inner`), `list_agents` returns
 * `{"agent_name": "/root", ...}` and an `agent_message` addresses `/root` as a
 * recipient — so the string is the engine's vocabulary, not ours.
 *
 * **It is a CONSTANT and is never scraped out of the transcript.** The literal
 * also occurs in the developer prompt ("You are `/root`, the primary agent...")
 * and this repository has already shipped a checklist row that ticked on the
 * operator's own prompt text. A label read out of prose is a label the operator
 * can write; this one is a rendering decision with a stated source.
 *
 * **What it is not: a source of per-session information.** Claude Code labels
 * its root from the transcript's first user prompt. {@link CodexThread} carries
 * no equivalent — no message text, no title — so every Codex root renders the
 * same string. That is a real limitation of the hand-off line and it is
 * recorded here rather than papered over with `basename(cwd)`, which would name
 * the directory rather than the session.
 */
export const CODEX_ROOT_LABEL = '/root';

/**
 * The label of an agent that carries neither a `task_name` (the leaf of its
 * `agent_path`) nor an `agent_nickname`.
 *
 * C7's rule ends "**and never a raw id**", so the fallback cannot be the thread
 * uuid. It is UNREACHABLE on the committed corpus — a subagent with neither
 * label also carries no `agent_path` join key, and unless a spawn names it by
 * id it parks as {@link CodexParkCode} `dialectV1` before anything asks for its
 * label. `graft.test.ts` reaches it with a constructed thread that is named by
 * `output.agent_id` and carries no nickname, so the branch is proved rather
 * than asserted.
 */
export const CODEX_UNNAMED_LABEL = '(unnamed agent)';

// ---------------------------------------------------------------------------
// Park reasons
// ---------------------------------------------------------------------------

/**
 * The `ParkedGraft.reason` strings, one per {@link CodexParkCode}.
 *
 * Constants rather than inline literals so `graft.test.ts` asserts against the
 * exported name instead of against a copy of the sentence — a test that quotes
 * the string it is checking is two agreeing literals, which this repository
 * already records as "not a contract".
 *
 * No committed golden pins any of these: `fixtures/codex-0.151.0-alpha.7.2/`
 * parks nothing at all. Two of the five are TRIPWIRES that a test asserts fire
 * ZERO times across the corpus, and the other three are proved on constructed
 * threads.
 */
export const CODEX_PARK_REASONS: Readonly<Record<CodexParkCode, string>> = {
  /**
   * TRIPWIRE. Spec C4a: "`dialectV1` therefore parks only a child carrying
   * neither key, which no observed session produces."
   *
   * NOT the routine state of the `v1` dialect. A `v1` child grafts by
   * `output.agent_id` and this code must never fire for one.
   */
  dialectV1:
    'subagent carries neither join key: no agent_path value, and no spawn_agent output ' +
    'names its thread id (spec C4a) - not a refusal of the v1 dialect',
  /**
   * Spec C4: "a child with no `agent_path` is parked (G3)".
   *
   * The KEY being absent, not the key holding `null`. A `v1` child's
   * `agent_path` is present-and-null and is a different fact from a subagent
   * whose spawn record has no such key at all; collapsing the two is how the
   * `v1` dialect was nearly refused. {@link CodexOptional} exists to keep them
   * apart and this code depends on the distinction.
   */
  noAgentPath:
    'subagent spawn record carries no agent_path key at all (spec C4) - distinct from ' +
    'a present-and-null agent_path, which is the v1 dialect and grafts by id',
  /**
   * A spawn's output names a child that no thread in the corpus carries, or a
   * subagent whose own parent thread is not in the corpus. Both directions of
   * one broken spawn/child edge.
   *
   * **A RECORDED STRETCH OF THE NAME.** `PLAN.md` glosses `orphanSpawn` as
   * "path with no child", which is the spawn's side only. The park-code union
   * has no sixth member for the child's side, and the alternatives were worse:
   * `dialectV1` means "neither join key" and would be false of a child that
   * carries one, and hanging such a child off the root would be the guess G3
   * forbids. Named at its own site so a later reader meets the decision instead
   * of inferring it.
   */
  orphanSpawn:
    'the spawn/child edge names something the corpus does not contain: a spawn output ' +
    'naming no thread, or a subagent whose parent_thread_id names no thread',
  /**
   * TRIPWIRE. The engine enforces `agent_path` uniqueness — a second spawn
   * asking for a taken path is REFUSED, which is a failed call and not a park —
   * so two threads holding one path means that enforcement has moved.
   */
  duplicateAgentPath:
    'two subagent threads carry the same agent_path; the engine enforces uniqueness by ' +
    'refusing the second spawn, so this should be unreachable (tripwire)',
  /**
   * Spec C5: `subagent_history_start_ordinal` and `forked_from_id` travel
   * together — a `fork_turns: "none"` spawn carries NEITHER, and both being
   * absent is the normal, silent case. One without the other means the boundary
   * between inherited records and the thread's own work cannot be applied, so
   * the thread's tree would contain its parent's records. Park rather than
   * render someone else's work under this agent's name.
   */
  forkBoundaryMissing:
    'the fork boundary is half-declared: forked_from_id and subagent_history_start_ordinal ' +
    'travel together (spec C5) and exactly one of them is present',
};

// ---------------------------------------------------------------------------
// The four injected seams
// ---------------------------------------------------------------------------

/**
 * One spawning call and the child it resolved to, in the golden's own
 * `child_resolved_by` vocabulary.
 *
 * Exposed so DoD 2.4's two-key join is assertable DIRECTLY rather than being
 * inferred from the shape of the tree. A test that reads the tree and concludes
 * "the join must have worked" is testing the assembly; this states which KEY
 * made the edge, which is the thing C4a distinguishes.
 */
export interface CodexSpawnJoin {
  readonly callId: string;
  readonly childThreadId: string | null;
  readonly resolvedBy: CodexSpawnResolution;
}

/** A recorded `spawn_depth` that disagrees with the depth walked from the root. */
export interface CodexDepthDisagreement {
  readonly threadId: string;
  /** `source.subagent.thread_spawn.depth`, as written. This is what is emitted. */
  readonly recorded: number;
  /** The depth this grafter walked along `parent_thread_id`. */
  readonly walked: number;
}

/** A spawning call whose owning thread is not the child's `parent_thread_id`. */
export interface CodexSpawnParentDisagreement {
  readonly childThreadId: string;
  /** `CodexSpawn.threadId` — the thread the spawning call lives in. */
  readonly spawningThreadId: string;
  /** The child's own `parent_thread_id`. This is what wins (spec C4). */
  readonly parentThreadId: string | null;
}

/**
 * The four facts the grafter cannot derive from a {@link CodexThread}.
 *
 * Every default is stated at its own function, and every default is the value
 * the tests in `graft.test.ts` run with, so calling {@link graftCodexThreads}
 * with no options at all is a defined, tested configuration rather than an
 * accident.
 */
export interface CodexGraftOptions {
  /**
   * Thread -> `SessionState.liveness`.
   *
   * Defaults to {@link defaultCodexLiveness}, the STATIC rule, so nothing here
   * depends on a wall clock. The real tap is spec C6 / D0.1 and it is
   * `src/codex/liveness.ts`'s (DoD 2.5), injected by `index.ts` (DoD 2.7). A
   * committed fixture is a file, so no writer lock can be held and no hook
   * event can arrive while it is read: **no fixture can ever produce `live`**.
   */
  livenessFor?: (thread: CodexThread) => SessionState['liveness'];
  /**
   * Does this session's `cwd` belong to an open workspace folder (spec C1)?
   *
   * An input from the HOST, not a fact in the transcript, so it is a seam and
   * the wiring is DoD 3.x's. Defaults to {@link defaultCodexWorkspaceMatch},
   * which returns `true`: the grafter is handed threads that discovery already
   * chose, and claiming `false` here would report every session as belonging to
   * no open folder.
   */
  workspaceMatch?: (thread: CodexThread) => boolean;
  /**
   * Thread -> `SessionState.projectSlug`.
   *
   * Defaults to {@link defaultCodexProjectSlug}, the empty placeholder, exactly
   * as the OpenCode grafter's `defaultProjectSlug` does and for the same
   * reason: the slug rule is a decision this module does not own, and keeping
   * the seam means these tests do not depend on it. `index.ts` injects the real
   * one.
   */
  projectSlug?: (thread: CodexThread) => string;
  /**
   * Thread -> `AgentNode.startedAt`.
   *
   * **THIS DEFAULT IS THE WEAKEST NUMBER THIS MODULE EMITS, and it is a seam
   * rather than a literal for exactly that reason.** `AgentNode.startedAt` is
   * REQUIRED, and {@link CodexThread} carries no start timestamp at all — its
   * only time is `mtimeMs`, the transcript's last write. For a finished thread
   * that is when it STOPPED, so the default names an end as a start.
   *
   * The transcript does state the real value: `session_meta.payload.timestamp`.
   * It is not on the hand-off line, which this package may not edit, so the
   * choice is recorded here and reported rather than hidden behind a plausible
   * number. Defaults to {@link defaultCodexStartedAt}.
   */
  startedAtFor?: (thread: CodexThread) => number;
}

/**
 * The static liveness rule: `idle`.
 *
 * `unsupported` is what a fingerprint refusal produces and is never reached
 * from here — refusal is `fingerprint.ts`'s (G3, DoD 2.2) and a refused session
 * does not arrive. `ended` is not claimed because {@link CodexThread} carries
 * no end signal; `idle` says "not running, and we are not asserting it is over".
 */
export function defaultCodexLiveness(_thread: CodexThread): SessionState['liveness'] {
  return 'idle';
}

/** The default workspace match: `true`. See {@link CodexGraftOptions.workspaceMatch}. */
export function defaultCodexWorkspaceMatch(_thread: CodexThread): boolean {
  return true;
}

/** The default project slug: the empty placeholder. See {@link CodexGraftOptions.projectSlug}. */
export function defaultCodexProjectSlug(_thread: CodexThread): string {
  return '';
}

/** The default start time: the transcript's mtime. See {@link CodexGraftOptions.startedAtFor}. */
export function defaultCodexStartedAt(thread: CodexThread): number {
  return thread.mtimeMs;
}

// ---------------------------------------------------------------------------
// Input and result
// ---------------------------------------------------------------------------

export interface CodexGraftInput {
  /**
   * Every thread `parse.ts` produced, root and subagent, from every transcript
   * discovery found. Refused threads are filtered out upstream by
   * `fingerprint.ts` and never arrive here.
   */
  threads: readonly CodexThread[];
  options?: CodexGraftOptions;
}

/**
 * What the grafter produces.
 *
 * Deliberately NOT `CodexEngineResult`: that shape carries `discovery` (P1's)
 * and `refused` (the fingerprint's), neither of which this module can produce.
 * `index.ts` composes them (DoD 2.7).
 *
 * Every counter below exists because of working-method rule 18 — a skip, a
 * drop, or a fact we could not resolve is STATED with its count, never passed
 * over in silence. A zero is only evidence when something says what was looked
 * at.
 */
export interface CodexGraftResult {
  /** One per ROOT thread. Tagged `engine: 'codex'` (spec C11). */
  readonly sessions: readonly SessionState[];
  /** Every thread's {@link CodexCounters}, summed. */
  readonly counters: CodexCounters;
  /** Spawns the engine declined. Rendered as failed calls; never parked. */
  readonly spawnsRefused: number;
  /** Spawns whose output resolved to a thread in the corpus. */
  readonly spawnsResolved: number;
  /** Spawns naming a child no thread carries. Each parked `orphanSpawn`. */
  readonly spawnsOrphaned: number;
  /**
   * Spawns that were not refused and whose output carried NEITHER key, so there
   * was nothing to join on and nothing to quote in a park entry. The call still
   * renders. Counted rather than parked: parking needs an identity and this
   * case is the absence of one.
   */
  readonly spawnsWithoutOutputKey: number;
  /**
   * Subagents placed in the tree by `parent_thread_id` for which no spawning
   * call could be identified, so they carry no {@link SpawnEdge}.
   *
   * NOT a park. The agent is in the tree and correct; what is missing is the
   * filament to its spawning call.
   */
  readonly agentsWithoutSpawnEdge: number;
  /**
   * Every spawning call and the key that resolved it (spec C4a).
   *
   * A refused spawn appears here with `resolvedBy: 'unresolved'` and a null
   * child: it named nothing, because the engine declined the call.
   */
  readonly spawnJoins: readonly CodexSpawnJoin[];
  /** Recorded `spawn_depth` against walked depth. The recorded value is emitted. */
  readonly depthDisagreements: readonly CodexDepthDisagreement[];
  /** Spawning call's thread against the child's `parent_thread_id`. The latter wins. */
  readonly spawnParentDisagreements: readonly CodexSpawnParentDisagreement[];
  /**
   * `session_id` values naming a thread the corpus does not contain, so no root
   * node could be built and no `SessionState` was produced for that group.
   *
   * Loud rather than absent: threads reachable from no root are the failure the
   * whole exercise exists to make visible. Unlike the OpenCode grafter this does
   * not throw — a Codex data root is a day-partitioned directory walk, so a
   * parent transcript being outside the walked window is an expected shape of
   * partial discovery rather than a contradiction in the data.
   */
  readonly sessionsWithoutRootThread: readonly string[];
  /**
   * Threads whose `thread_source` and whose `threadId === sessionId` test
   * disagree about whether they are the root.
   *
   * Two independent statements of one fact; a disagreement means an assumption
   * moved. `threadId === sessionId` wins, because `session_id` is measured to
   * name the root thread on 14 of 14 threads including at depth 2, and
   * `thread_source` is typed as an open `string`.
   */
  readonly rootIdentityDisagreements: readonly string[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A `CodexOptional` holding a non-empty string, or `null`. */
function optionalString(value: { readonly value: unknown } | undefined): string | null {
  if (value === undefined) return null;
  return typeof value.value === 'string' && value.value !== '' ? value.value : null;
}

/**
 * The leaf of an `agent_path`: `/root/outer/inner` -> `inner`.
 *
 * Spec C7 makes `task_name` the primary label and states the equivalence
 * itself — "equivalently the leaf of `agent_path`". The leaf is used rather
 * than the spawning call's `requestedTaskName` because it is the CHILD's own
 * property: a child whose spawning call could not be identified still has a
 * label. On the corpus the two agree everywhere they both exist.
 *
 * A consequence worth stating: `/root/dup` and `/root/dup/dup` both leaf to
 * `dup`, so two nodes in one tree can share a label. That is what the spec
 * asks for — the operator asked for two agents called `dup` — and it is the
 * engine's own answer, not an ambiguity this module introduced.
 */
export function agentPathLeaf(path: string): string {
  const parts = path.split('/').filter((part) => part !== '');
  const leaf = parts[parts.length - 1];
  return leaf === undefined ? path : leaf;
}

/**
 * `AgentNode.label` for a Codex thread — spec C7's rule, in order:
 * primary `task_name` (the leaf of `agent_path`), secondary `agent_nickname`,
 * and **never a raw id**.
 *
 * A `v1` node is labelled by its nickname and that is correct rather than a
 * defect: there is no `task_name` under that dialect at all.
 */
export function codexNodeLabel(thread: CodexThread, isRoot: boolean): string {
  if (isRoot) return CODEX_ROOT_LABEL;
  const path = optionalString(thread.agentPath);
  if (path !== null) return agentPathLeaf(path);
  const nickname = optionalString(thread.agentNickname);
  if (nickname !== null) return nickname;
  return CODEX_UNNAMED_LABEL;
}

/** All-zero {@link CodexCounters}, for the sum. */
function emptyCounters(): CodexCounters {
  return {
    malformedLines: 0,
    unknownRecordTypes: 0,
    reasoningDropped: 0,
    inheritedRecordsDropped: 0,
    payloadsTruncated: 0,
  };
}

function addCounters(total: CodexCounters, one: CodexCounters): CodexCounters {
  return {
    malformedLines: total.malformedLines + one.malformedLines,
    unknownRecordTypes: total.unknownRecordTypes + one.unknownRecordTypes,
    reasoningDropped: total.reasoningDropped + one.reasoningDropped,
    inheritedRecordsDropped: total.inheritedRecordsDropped + one.inheritedRecordsDropped,
    payloadsTruncated: total.payloadsTruncated + one.payloadsTruncated,
  };
}

/**
 * The tool call's input line.
 *
 * **SYNTHESISED, and it has to be.** `ToolNode.inputPreview` is required and
 * {@link CodexToolCall} carries no input at all — it has `outputPreview` and no
 * counterpart. So this describes the CALL rather than quoting its arguments: the
 * namespaced tool name, plus a spawn's requested task name.
 *
 * The task name is safe to show and that is a measurement, not an assumption:
 * spec C7 records 17 of 17 spawn-bearing records carrying `task_name` in
 * plaintext against 24 of 24 `message` fields as ciphertext. The two fields
 * travel together and only one of them is opaque. The `message` bytes are not
 * on {@link CodexSpawn} at all — only their count is — so they cannot reach
 * here even by mistake.
 */
export function codexInputPreview(call: CodexToolCall, spawn: CodexSpawn | undefined): string {
  const namespace = optionalString(call.namespace);
  const name = namespace === null ? call.name : `${namespace}.${call.name}`;
  if (spawn === undefined) return name;
  const requested = spawn.requestedTaskName;
  return requested === null || requested === '' ? name : `${name} ${requested}`;
}

/**
 * `CodexToolCall` (+ its spawn, when it is one) -> `ToolNode`.
 *
 * `id` is the `call_id`, which the fingerprint guarantees is present
 * (`callIdMissing` refuses without one) and which is the same kind of thing
 * Claude Code's `tool_use id` is.
 *
 * **`itemId` does NOT survive into the node, and that is a known limitation.**
 * Spec C4's hook join resolves `tool_use_id` against the UNION of `call_id` and
 * `event_msg.payload.item.id`, and a shell command's item id is an unrelated
 * `exec-<uuid>`: 40 of 64 hook records resolve against `call_id` alone, 64
 * against the union. `ToolNode` has no second id field and this package may not
 * add one, so a hook join performed against `ToolNode.id` alone would drop
 * every shell call. `CodexToolCall.itemId` carries the other half and liveness
 * (DoD 2.5) must join through it, not through the tree.
 *
 * STATUS is derived, because {@link CodexToolCall} carries none. The output
 * record is this format's completion record — every completed call in the
 * corpus has a `function_call_output` or `custom_tool_call_output` — so its
 * absence is evidence of an unfinished call rather than a guess. A refused
 * spawn is `error`, which is DoD 2.4's "rendered as a failed call".
 */
export function toCodexToolNode(call: CodexToolCall, spawn: CodexSpawn | undefined): ToolNode {
  const refused = spawn !== undefined && spawn.refused;
  const status: ToolNode['status'] = refused
    ? 'error'
    : call.outputPreview === undefined
      ? 'running'
      : 'done';
  // A refused spawn's `refusalText` IS the engine's output for that call, so it
  // is what the result line shows. `outputPreview` is preferred when both
  // exist; they are the same bytes by construction.
  const result = call.outputPreview ?? (refused ? (spawn?.refusalText ?? undefined) : undefined);
  return {
    id: call.callId,
    toolName: call.name,
    status,
    inputPreview: codexInputPreview(call, spawn),
    ...(result === undefined ? {} : { resultPreview: result }),
    // OUR truncation is not the engine's. `outputTruncated` is Codex's own
    // claim about the payload it wrote, which is exactly what `ToolNode.
    // truncated` means; it crosses verbatim including `false`, because an
    // explicit "I did not truncate this" is a claim and is worth more than an
    // absence.
    ...(call.outputTruncated === undefined ? {} : { truncated: call.outputTruncated }),
  };
}

// ---------------------------------------------------------------------------
// The two-key join (spec C4 / C4a)
// ---------------------------------------------------------------------------

interface SpawnJoin {
  /** Child thread id -> the spawn that named it. */
  readonly childToSpawn: ReadonlyMap<string, CodexSpawn>;
  /** `call_id` -> the spawn made by that call. */
  readonly spawnByCallId: ReadonlyMap<string, CodexSpawn>;
  /** `call_id` -> the child thread id it resolved to. */
  readonly callToChild: ReadonlyMap<string, string>;
  /** Per-spawn resolution, in the golden's `child_resolved_by` vocabulary. */
  readonly joins: readonly CodexSpawnJoin[];
  readonly orphans: readonly { readonly spawn: CodexSpawn; readonly key: string }[];
  readonly refused: number;
  readonly resolved: number;
  readonly withoutOutputKey: number;
}

/**
 * Resolve every spawn to its child, by whichever of the two keys the dialect
 * supplied (C4a).
 *
 * The keys are read from the spawn's OWN output and joined here against the
 * thread set. `CodexSpawn.childThreadId` and `childResolvedBy` are deliberately
 * NOT trusted: `parse.ts` sees one thread at a time and cannot know the other
 * threads' ids, so a value there would be someone else's join, and DoD 2.4
 * makes the join this module's.
 *
 * Order of the two keys is `task_name` first, then `agent_id`. They are never
 * both populated in one output on the corpus — a `v2` output is
 * `{"task_name": ...}` and a `v1` output is `{"agent_id": ..., "nickname": ...}`
 * — so the order decides nothing today and is fixed so it cannot decide
 * something silently tomorrow.
 */
function joinSpawns(
  spawns: readonly CodexSpawn[],
  threadsById: ReadonlyMap<string, CodexThread>,
  threadsByAgentPath: ReadonlyMap<string, CodexThread>,
): SpawnJoin {
  const childToSpawn = new Map<string, CodexSpawn>();
  const spawnByCallId = new Map<string, CodexSpawn>();
  const callToChild = new Map<string, string>();
  const joins: CodexSpawnJoin[] = [];
  const orphans: { spawn: CodexSpawn; key: string }[] = [];
  let refused = 0;
  let resolved = 0;
  let withoutOutputKey = 0;

  for (const spawn of spawns) {
    spawnByCallId.set(spawn.callId, spawn);

    // DoD 2.4. A refusal is a failed CALL, never a park: the engine declined,
    // it did not fail to join. It resolves to no child and it must not be
    // counted as an orphan either - there is no missing child to report.
    if (spawn.refused) {
      refused += 1;
      joins.push({ callId: spawn.callId, childThreadId: null, resolvedBy: 'unresolved' });
      continue;
    }

    const taskName = spawn.outputTaskName;
    if (taskName !== null && taskName !== '') {
      const child = threadsByAgentPath.get(taskName);
      if (child !== undefined) {
        resolved += 1;
        childToSpawn.set(child.threadId, spawn);
        callToChild.set(spawn.callId, child.threadId);
        joins.push({
          callId: spawn.callId,
          childThreadId: child.threadId,
          resolvedBy: 'output_task_name_equals_agent_path',
        });
        continue;
      }
      orphans.push({ spawn, key: taskName });
      joins.push({ callId: spawn.callId, childThreadId: null, resolvedBy: 'unresolved' });
      continue;
    }

    const agentId = spawn.outputAgentId;
    if (agentId !== null && agentId !== '') {
      const child = threadsById.get(agentId);
      if (child !== undefined) {
        resolved += 1;
        childToSpawn.set(child.threadId, spawn);
        callToChild.set(spawn.callId, child.threadId);
        joins.push({
          callId: spawn.callId,
          childThreadId: child.threadId,
          resolvedBy: 'output_agent_id_equals_child_id',
        });
        continue;
      }
      orphans.push({ spawn, key: agentId });
      joins.push({ callId: spawn.callId, childThreadId: null, resolvedBy: 'unresolved' });
      continue;
    }

    withoutOutputKey += 1;
    joins.push({ callId: spawn.callId, childThreadId: null, resolvedBy: 'unresolved' });
  }

  return {
    childToSpawn,
    spawnByCallId,
    callToChild,
    joins,
    orphans,
    refused,
    resolved,
    withoutOutputKey,
  };
}

// ---------------------------------------------------------------------------
// Parking a subagent (G3)
// ---------------------------------------------------------------------------

/**
 * Why this subagent cannot be attached, or `null` when it can.
 *
 * The order is normative and every step is a different fact:
 *
 *  1. `noAgentPath`      - the KEY is absent (not null): a structural oddity.
 *  2. `forkBoundaryMissing` - the C5 pair is half-declared.
 *  3. `dialectV1`        - neither join key. TRIPWIRE, must fire zero times.
 *  4. `duplicateAgentPath` - a path already claimed. TRIPWIRE, engine-enforced.
 *  5. `orphanSpawn`      - no parent thread in the corpus.
 *
 * `dialectV1` is checked BEFORE placement on purpose. A keyless child with a
 * good `parent_thread_id` could be placed, and placing it would make the
 * tripwire unreachable — which is the whole failure mode a tripwire exists to
 * prevent. The check is about the KEY, not about whether we happened to manage.
 */
function parkCodeFor(
  thread: CodexThread,
  namedBySpawn: boolean,
  duplicatePath: boolean,
  threadsById: ReadonlyMap<string, CodexThread>,
): CodexParkCode | null {
  if (!thread.agentPath.present) return 'noAgentPath';

  const forkedFrom = thread.forkedFromId.present;
  const forkStart = thread.subagentHistoryStartOrdinal.present;
  if (forkedFrom !== forkStart) return 'forkBoundaryMissing';

  const path = optionalString(thread.agentPath);
  if (path === null && !namedBySpawn) return 'dialectV1';

  if (duplicatePath) return 'duplicateAgentPath';

  const parentId = optionalString(thread.parentThreadId);
  if (parentId === null || !threadsById.has(parentId)) return 'orphanSpawn';

  return null;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface SessionBuild {
  readonly root: CodexThread;
  readonly childrenOf: ReadonlyMap<string, readonly CodexThread[]>;
  readonly join: SpawnJoin;
  readonly spawnEdges: SpawnEdge[];
  readonly parked: ParkedGraft[];
  readonly startedAtFor: (thread: CodexThread) => number;
  readonly depthDisagreements: CodexDepthDisagreement[];
  readonly agentsWithoutSpawnEdgeRef: { count: number };
  /**
   * Every thread this walk actually placed in the tree.
   *
   * A thread can be attachable and still be unreachable: if its own parent
   * parked, the parent is not in `childrenOf` and the recursion never descends
   * to it. Without this set that thread would be SILENTLY DROPPED - present in
   * neither `root` nor `parked` - which is precisely the failure the park
   * vocabulary exists to make visible. The caller parks the remainder.
   */
  readonly visited: Set<string>;
}

/**
 * The depth this node reports, and it is the RECORDED one.
 *
 * DoD 2.4: "depth-2 fixture yields `depth` from the transcript, not
 * recomputed." So `source.subagent.thread_spawn.depth` is what is emitted, on
 * both {@link SpawnEdge.depth} and {@link AgentNode.spawnDepth}.
 *
 * The walked depth is still computed, and a disagreement is RECORDED rather
 * than silently resolved — {@link CodexGraftResult.depthDisagreements}. The
 * Claude Code `SpawnEdge` already carries this pair for the same reason: a
 * recorded value can contradict a walked one, and the contradiction is
 * information.
 *
 * When no depth was recorded the walked one is used and the pair is not a
 * disagreement — there is nothing to disagree with.
 */
function depthFor(thread: CodexThread, walked: number, build: SessionBuild): number {
  const recorded = thread.spawnDepth.present && typeof thread.spawnDepth.value === 'number'
    ? thread.spawnDepth.value
    : null;
  if (recorded === null) return walked;
  if (recorded !== walked) {
    build.depthDisagreements.push({ threadId: thread.threadId, recorded, walked });
  }
  return recorded;
}

function buildAgent(thread: CodexThread, walkedDepth: number, build: SessionBuild): AgentNode {
  build.visited.add(thread.threadId);
  const isRoot = thread.threadId === build.root.threadId;
  const nodeId = isRoot ? 'root' : thread.threadId;
  const depth = isRoot ? 0 : depthFor(thread, walkedDepth, build);

  // Tool calls in transcript order. `ordinal` is documented as dense and
  // monotonic from 0 per thread, so it is a total order within a thread and no
  // tie-break is needed; the id is compared anyway so the sort is stable across
  // engines that might not honour that.
  const calls = [...thread.toolCalls].sort((a, b) =>
    a.ordinal !== b.ordinal ? a.ordinal - b.ordinal : a.callId < b.callId ? -1 : a.callId > b.callId ? 1 : 0,
  );

  const childThreads = build.childrenOf.get(thread.threadId) ?? [];
  const placed = new Set<string>();
  const children: TreeNode[] = [];

  for (const call of calls) {
    const spawn = build.join.spawnByCallId.get(call.callId);
    children.push(toCodexToolNode(call, spawn));
    if (spawn === undefined) continue;

    const childId = build.join.callToChild.get(call.callId);
    if (childId === undefined) continue;
    const child = childThreads.find((c) => c.threadId === childId);
    if (child === undefined) continue;

    // The node is built FIRST and the edge takes its depth off the node. Calling
    // `depthFor` here as well would record any recorded/walked disagreement
    // twice for one thread - a double count in the very diagnostic whose job is
    // to say how often the two disagree.
    const childNode = buildAgent(child, depth + 1, build);
    placed.add(child.threadId);
    build.spawnEdges.push({
      // Spec C4's hook/transcript id. `call_id` is always present.
      toolUseId: call.callId,
      agentId: child.threadId,
      parentNodeId: nodeId,
      // DoD 2.4: the transcript's depth, not the walked one. `AgentNode.
      // spawnDepth` already holds it, so the two can never disagree.
      depth: childNode.spawnDepth,
      recordedDepth: childNode.spawnDepth,
    });
    // A subagent `AgentNode` sits BESIDE the tool call that spawned it, never
    // inside it: `ToolNode` has no `children` field and that stays true. The
    // real spawn relationship exists only in `spawnEdges`.
    children.push(childNode);
  }

  // Children whose spawning call could not be identified. They are still this
  // thread's children - `parent_thread_id` is a primary key and spec C4 prefers
  // it - so they are placed, after the calls, with NO `SpawnEdge`. Counted, not
  // silent: what is missing is the filament, not the agent.
  for (const child of childThreads) {
    if (placed.has(child.threadId)) continue;
    build.agentsWithoutSpawnEdgeRef.count += 1;
    children.push(buildAgent(child, depth + 1, build));
  }

  const status: AgentNode['status'] = children.some(
    (node) => 'toolName' in node && node.status === 'running',
  )
    ? 'running'
    : 'done';

  const contextNow = thread.contextNow;
  const burn = thread.burn;

  return {
    id: nodeId,
    kind: isRoot ? 'main' : 'subagent',
    label: codexNodeLabel(thread, isRoot),
    status,
    spawnDepth: depth,
    children,
    // Absent stays absent. A zero here would claim an empty context window,
    // which is a wrong number rather than a missing one.
    ...(contextNow === undefined ? {} : { contextNow }),
    ...(burn === undefined ? {} : { burn }),
    startedAt: build.startedAtFor(thread),
    // `mtimeMs` is the last write to the transcript, which for a thread that is
    // not running IS when it stopped changing - the same reasoning the OpenCode
    // grafter applies to `time_updated`. A running agent has no end and the KEY
    // IS OMITTED rather than set to `undefined`.
    ...(status === 'running' ? {} : { endedAt: thread.mtimeMs }),
  };
}

/**
 * Sum two {@link TokenPair}s. Integers, so order cannot move the result.
 */
function addTokens(a: TokenPair, b: TokenPair): TokenPair {
  return { prompt: a.prompt + b.prompt, output: a.output + b.output };
}

/**
 * Build one `SessionState` per ROOT thread, with every descendant grafted in.
 *
 * A subagent is an `AgentNode` INSIDE its root's session, never a deck entry of
 * its own — the same shape both other engines produce.
 *
 * @throws never. G3: a refusal is carried, not thrown, and malformed input is
 * counted and skipped. Every condition that would be an exception elsewhere is
 * a counter or a park entry on {@link CodexGraftResult}.
 */
export function graftCodexThreads(input: CodexGraftInput): CodexGraftResult {
  const { threads } = input;
  const livenessFor = input.options?.livenessFor ?? defaultCodexLiveness;
  const workspaceMatch = input.options?.workspaceMatch ?? defaultCodexWorkspaceMatch;
  const projectSlug = input.options?.projectSlug ?? defaultCodexProjectSlug;
  const startedAtFor = input.options?.startedAtFor ?? defaultCodexStartedAt;

  // ---- indexes -----------------------------------------------------------
  const threadsById = new Map<string, CodexThread>();
  for (const thread of threads) {
    // First declaration wins. A thread id repeated in the input is the fork
    // boundary arriving un-deduplicated (spec C5: a forked child re-serialises
    // a second `session_meta`, so a thread can be DECLARED in more than one
    // file); `owningFile` is the file whose ordinal-0 meta declares it and
    // `parse.ts` is what applies that rule. Taking the first keeps this module
    // from silently preferring a later, inherited copy.
    if (!threadsById.has(thread.threadId)) threadsById.set(thread.threadId, thread);
  }

  const allSpawns: CodexSpawn[] = [];
  for (const thread of threads) for (const spawn of thread.spawns) allSpawns.push(spawn);

  // `agent_path` -> thread, for the v2 key. Built over threads that HOLD a
  // path; a duplicate is the `duplicateAgentPath` tripwire and the first wins.
  const threadsByAgentPath = new Map<string, CodexThread>();
  const claimedPaths = new Set<string>();
  const duplicatePathThreads = new Set<string>();
  for (const thread of threadsById.values()) {
    const path = optionalString(thread.agentPath);
    if (path === null) continue;
    if (claimedPaths.has(path)) {
      duplicatePathThreads.add(thread.threadId);
      continue;
    }
    claimedPaths.add(path);
    threadsByAgentPath.set(path, thread);
  }

  const join = joinSpawns(allSpawns, threadsById, threadsByAgentPath);

  // ---- session grouping (relation 1) --------------------------------------
  const bySession = new Map<string, CodexThread[]>();
  for (const thread of threadsById.values()) {
    const list = bySession.get(thread.sessionId) ?? [];
    list.push(thread);
    bySession.set(thread.sessionId, list);
  }

  const sessions: SessionState[] = [];
  const sessionsWithoutRootThread: string[] = [];
  const rootIdentityDisagreements: string[] = [];
  const depthDisagreements: CodexDepthDisagreement[] = [];
  const spawnParentDisagreements: CodexSpawnParentDisagreement[] = [];
  const agentsWithoutSpawnEdgeRef = { count: 0 };
  let counters = emptyCounters();
  let spawnsOrphaned = 0;

  for (const thread of threadsById.values()) {
    counters = addCounters(counters, thread.counters);
    const looksRootById = thread.threadId === thread.sessionId;
    const looksRootBySource = thread.threadSource === 'user';
    if (looksRootById !== looksRootBySource) rootIdentityDisagreements.push(thread.threadId);
  }

  // Cross-assert the spawning call's thread against the child's own parent.
  for (const [childId, spawn] of join.childToSpawn) {
    const child = threadsById.get(childId);
    if (child === undefined) continue;
    const parentId = optionalString(child.parentThreadId);
    if (parentId === spawn.threadId) continue;
    spawnParentDisagreements.push({
      childThreadId: childId,
      spawningThreadId: spawn.threadId,
      parentThreadId: parentId,
    });
  }

  for (const [sessionId, group] of bySession) {
    const root = group.find((t) => t.threadId === sessionId);
    if (root === undefined) {
      sessionsWithoutRootThread.push(sessionId);
      continue;
    }

    const parked: ParkedGraft[] = [];
    const attachable: CodexThread[] = [];

    for (const thread of group) {
      if (thread.threadId === root.threadId) continue;
      const namedBySpawn = join.childToSpawn.has(thread.threadId);
      const code = parkCodeFor(
        thread,
        namedBySpawn,
        duplicatePathThreads.has(thread.threadId),
        threadsById,
      );
      if (code === null) {
        attachable.push(thread);
        continue;
      }
      const spawn = join.childToSpawn.get(thread.threadId);
      parked.push({
        agentId: thread.threadId,
        code,
        ...(spawn === undefined ? {} : { toolUseId: spawn.callId }),
        reason: CODEX_PARK_REASONS[code],
        ...(optionalString(thread.parentThreadId) === null
          ? {}
          : { parentAgentId: optionalString(thread.parentThreadId) as string }),
      });
    }

    // A spawn naming a child the corpus does not contain. Parked on the session
    // the SPAWNING thread belongs to, keyed on the name the spawn used - there
    // is no thread id to key on, which is the entire content of the case.
    for (const orphan of join.orphans) {
      const owner = threadsById.get(orphan.spawn.threadId);
      if (owner === undefined || owner.sessionId !== sessionId) continue;
      spawnsOrphaned += 1;
      parked.push({
        agentId: orphan.key,
        code: 'orphanSpawn',
        toolUseId: orphan.spawn.callId,
        reason: CODEX_PARK_REASONS.orphanSpawn,
      });
    }

    const childrenOf = new Map<string, CodexThread[]>();
    for (const thread of attachable) {
      const parentId = optionalString(thread.parentThreadId);
      if (parentId === null) continue;
      const list = childrenOf.get(parentId) ?? [];
      list.push(thread);
      childrenOf.set(parentId, list);
    }

    const spawnEdges: SpawnEdge[] = [];
    const build: SessionBuild = {
      root,
      childrenOf,
      join,
      spawnEdges,
      parked,
      startedAtFor,
      depthDisagreements,
      agentsWithoutSpawnEdgeRef,
      visited: new Set<string>(),
    };
    const rootNode = buildAgent(root, 0, build);

    // A thread that passed every park check and is still not in the tree: its
    // own parent parked, so the chain to the root is broken. `orphanSpawn`
    // again, for the same reason the child-side case uses it - the union has no
    // member for "parent not grafted", the Claude Code grafter's word for this,
    // and hanging it off the root would be the guess G3 forbids.
    for (const thread of attachable) {
      if (build.visited.has(thread.threadId)) continue;
      const spawn = join.childToSpawn.get(thread.threadId);
      parked.push({
        agentId: thread.threadId,
        code: 'orphanSpawn',
        ...(spawn === undefined ? {} : { toolUseId: spawn.callId }),
        reason: CODEX_PARK_REASONS.orphanSpawn,
        ...(optionalString(thread.parentThreadId) === null
          ? {}
          : { parentAgentId: optionalString(thread.parentThreadId) as string }),
      });
    }

    // `burn` is the session's spend, summed over every agent in the tree -
    // `SessionState.burn`'s own contract. Parked agents contribute nothing,
    // which falls out of walking `attachable`. A session where NO thread
    // reports one leaves the key ABSENT rather than emitting a zero pair.
    let burn: TokenPair | undefined;
    const walk = (thread: CodexThread): void => {
      if (thread.burn !== undefined) burn = burn === undefined ? thread.burn : addTokens(burn, thread.burn);
      for (const child of childrenOf.get(thread.threadId) ?? []) walk(child);
    };
    walk(root);

    const windowTokens = root.modelContextWindow;

    sessions.push({
      sessionId: root.threadId,
      projectSlug: projectSlug(root),
      // C11: written rather than left to the `'cc'` default, which is what
      // makes G2's cross-engine isolation assertable at all.
      engine: 'codex',
      workspaceMatch: workspaceMatch(root),
      liveness: livenessFor(root),
      // Refusal is `fingerprint.ts`'s (G3, DoD 2.2). A thread that reaches here
      // was accepted, so the grafter has no refusal of its own to express.
      schemaOk: true,
      // There is no cost figure anywhere in a Codex transcript and there is no
      // price table in this repository. `0` here means NOT YET COMPUTED, which
      // is what the field documents; it never means "free".
      totals: { costUsd: 0 },
      // The session's context LEVEL is the main transcript's, not the deepest
      // subagent's: each thread has its own window. Absent stays absent.
      ...(root.contextNow === undefined ? {} : { contextNow: root.contextNow }),
      ...(burn === undefined ? {} : { burn }),
      // DoD 2.6 / spec C8. `model_context_window` from the transcript and from
      // nowhere else - `models_cache.json` states a different figure for what
      // looks like the same concept and is on the G10 never-opened list.
      // ABSENT -> the key is omitted, never `0`.
      ...(windowTokens === undefined ? {} : { windowTokens }),
      spawnEdges,
      parked,
      root: rootNode,
    });
  }

  return {
    sessions,
    counters,
    spawnsRefused: join.refused,
    spawnsResolved: join.resolved,
    spawnsOrphaned,
    spawnsWithoutOutputKey: join.withoutOutputKey,
    spawnJoins: join.joins,
    agentsWithoutSpawnEdge: agentsWithoutSpawnEdgeRef.count,
    depthDisagreements,
    spawnParentDisagreements,
    sessionsWithoutRootThread,
    rootIdentityDisagreements,
  };
}
