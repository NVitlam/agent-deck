/**
 * Agent Deck — the OpenCode grafter (`PLAN.md` Phase 4, DoD 4.4).
 *
 * Turns raw `session` / `project` rows plus `parse.ts`'s tool records into the
 * existing `SessionState` contract from `../model/events.js`. There is no
 * second data model and no second wire contract (`agent-deck-spec.md`, the
 * OpenCode amendment's preamble).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS MEASURED AGAINST
 * ---------------------------------------------------------------------------
 *
 * `fixtures/opencode-1.18.22/golden.json` (the anchor, 24 session rows) and
 * `fixtures/opencode-1.18.21/golden.json` (the witness, 5 rows) are committed
 * reproduction targets. `scripts/opencode-golden.mjs` produced them and is the
 * reference implementation of every mapping decision below.
 *
 * **That script is deliberately NOT imported here, and must never be.** It
 * imports only `node:` builtins on purpose: DoD 3.4 says Phase 4 must
 * reproduce the goldens "through the production path", and an engine that
 * shared code with the generator would make both files prove nothing. The
 * duplication is the proof. `fixtures/opencode-1.18.22/GOLDEN.md` carries the
 * mapping decisions, the five hand-verified cases and the ten branches no
 * fixture exercises; read it before changing anything here.
 *
 * ---------------------------------------------------------------------------
 * NO I/O, NO CLOCK, NO WORKSPACE
 * ---------------------------------------------------------------------------
 *
 * `graftCorpus` is a pure function of plain data. It opens nothing, reads no
 * clock and knows nothing about VS Code. The three things it cannot know are
 * injected as {@link OcGraftOptions}, each defaulting to the value the goldens
 * were generated with, so the reproduction test does not depend on a clock,
 * on an open workspace folder, or on a decision Phase 5 has not taken yet.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS NOT
 * ---------------------------------------------------------------------------
 *
 * `toSessionState` in `src/model/graft.ts` — the Claude Code grafter — is NOT
 * the model for this file and was not consulted as one. It has no production
 * callers at all and sets neither `spawnEdges` nor `parked`; a worker in this
 * repo already took a whole decision on that wrong premise. The CC production
 * path is `SessionModel.viewFromSnapshot`. The two engines share the output
 * contract (`../model/events.js`) and nothing else.
 */

import type {
  AgentNode,
  ParkedGraft,
  SessionState,
  SpawnEdge,
  ToolNode,
  TreeNode,
} from '../model/events.js';
import type {
  OcCounts,
  OcEngineResult,
  OcParseResult,
  OcProjectRow,
  OcSessionRow,
  OcToolRecord,
} from './types.js';

// ---------------------------------------------------------------------------
// The park reasons — four of them byte-exact and pinned by the goldens
// ---------------------------------------------------------------------------

/**
 * The `ParkedGraft.reason` strings, character for character.
 *
 * The first four are in both committed `golden.json` files verbatim, so a
 * one-byte difference — a straight `-` for the ` - `, an ASCII `S` for the
 * `§`, a lost apostrophe — fails the DoD 4.6 byte comparison. They are
 * constants rather than inline literals so `graft.test.ts` can assert them
 * against the committed files directly instead of against a copy of
 * themselves. The fifth, `childSessionUnsupported`, has no golden behind it
 * and says so at its own entry.
 *
 * The `§` characters are real U+00A7. Never write a raw control character into
 * source; these are printable and are stored as UTF-8 like the rest of the
 * file.
 */
export const OC_PARK_REASONS = {
  /** OC3 rule 2 + contract amendment §G. Absence of the key is the signal. */
  taskWithoutChild:
    'task part carries no state.metadata.sessionId; no child session to attach ' +
    '(contract amendment §G) - not inferred from timing (OC3)',
  /** Contract §5's three-way cross-assertion failed. */
  joinKeyContradiction:
    'task state.metadata.sessionId, state.metadata.parentSessionId and the child ' +
    "session's parent_id do not agree (contract §5)",
  /** Two `task` parts naming one child. G3: park, never pick a winner. */
  ambiguousJoinKey: 'more than one task part names this child session (contract §5)',
  /** A child row names a parent that has no `task` part joining to it. */
  noSpawningTaskPart:
    'child session names a parent_id but no task part in that parent joins to it ' +
    '(contract §5)',
  /**
   * The named child session was refused by the per-session version window
   * (OC5) while this parent was accepted. Added at `PLAN.md`'s Phase 5 gate
   * (B7) to close `docs/evidence/phase-4/COVERAGE.md` item 29.
   *
   * NOT in either committed golden — no session in either corpus refuses — so
   * unlike its four siblings this string is not pinned by a byte comparison.
   * `graft.test.ts` asserts it against a refused child instead.
   */
  childSessionUnsupported:
    'child session was refused by the version window; the join was never attempted (OC5)',
} as const;

// ---------------------------------------------------------------------------
// The three injected seams
// ---------------------------------------------------------------------------

/**
 * The three facts the grafter cannot derive from the database.
 *
 * Every default is the value `scripts/opencode-golden.mjs` used, so calling
 * `graftCorpus` with no options at all reproduces the committed goldens.
 */
export interface OcGraftOptions {
  /**
   * Session id -> liveness.
   *
   * Defaults to {@link defaultSessionLiveness}, the STATIC rule, so the golden
   * reproduction never depends on a wall clock. OC4's real tap is the `event`
   * table polled by cursor and it is `src/opencode/liveness.ts`'s (DoD 4.5);
   * `index.ts` injects it there. A committed fixture is a file, so no `seq`
   * can advance while it is read and **no golden can ever carry `live`**.
   */
  livenessFor?: (session: OcSessionRow) => SessionState['liveness'];
  /**
   * Does this session belong to an open workspace folder?
   *
   * Defaults to {@link defaultWorkspaceMatch} — `project !== undefined` — which
   * is what the goldens carry, because every session in both corpora belongs
   * to the one `project` row whose `worktree` is this repository. The real
   * match compares the host's open workspace folders against the session's own
   * key (OC8, as amended 2026-08-31); that is an input from the host, not a
   * fact in the database, and it is `PLAN.md` DoD 5.2's work.
   */
  workspaceMatch?: (
    session: OcSessionRow | undefined,
    project: OcProjectRow | undefined,
  ) => boolean;
  /**
   * The session's project key -> `SessionState.projectSlug`.
   *
   * `src/opencode/index.ts` injects `slugFromWorktree` from
   * `src/opencode/slug.ts`, per `PLAN.md` Phase 4 `Amendment 2026-08-27` A1 —
   * and **that is what both goldens now carry**. The production path never
   * uses the default.
   *
   * It is deliberately NOT imported here. This module owns neither the
   * decision nor that file, and keeping the seam means `graft.test.ts` can
   * exercise the assembly without depending on the slug rule.
   *
   * **BOTH ROWS ARE PASSED, and the order matters (amended 2026-08-31).**
   * Through 0.5.0 this took the `project` row alone and `index.ts` keyed off
   * `project.worktree`. OpenCode keeps ONE `project` row per repository
   * identity and never rewrites `worktree` when the directory moves, so every
   * session of a moved workspace — including sessions RUN AT THE NEW PATH —
   * keyed to the old one and matched no open folder. Measured on the live
   * store 2026-08-31 and pinned by `fixtures/opencode-1.18.25/moved-project/`;
   * `docs/evidence/release-0.5.0/DRIFT-2.1.251.md` §5.2 is the diagnosis. The
   * session row carries `directory`, which OpenCode DOES keep current.
   *
   * Neither committed corpus could have caught it: in both,
   * `session.directory` and `project.worktree` are the same string, so the
   * goldens do not move by one byte across this change. That is why it was
   * invisible, and it is why the witness fixture had to be captured.
   *
   * The default {@link defaultProjectSlug} returns `''`, which is what the
   * goldens carried before A1 closed OC7's open item. It survives as the seam's
   * neutral value, and `''` is also the production answer when neither row can
   * supply a key — see {@link OcEngineResult.opencodeUnkeyed}.
   */
  projectSlug?: (
    session: OcSessionRow | undefined,
    project: OcProjectRow | undefined,
  ) => string;
  /**
   * The session ids the fingerprint REFUSED, so a `task` part naming one can
   * say why the child is missing (`docs/evidence/phase-4/COVERAGE.md` item 29,
   * closed by `PLAN.md`'s Phase 5 gate B7).
   *
   * The grafter is handed only ACCEPTED rows, which is unchanged and is why
   * refusal stays `fingerprint.ts`'s job. What this adds is the one fact the
   * grafter cannot derive from the rows it holds: whether a session id it
   * cannot find was refused, or was never there. Without it the two are the
   * same absence and both reported as `joinKeyContradiction`, which claims a
   * key disagreed when the check was never run.
   *
   * Defaults to empty, which reproduces Phase 4's behaviour exactly and is
   * what both goldens carry — neither corpus refuses anything, so no committed
   * byte depends on this. `index.ts` injects the real set.
   */
  refusedSessionIds?: ReadonlySet<string>;
}

/** Everything `graftCorpus` needs. Plain data — no handles, no I/O. */
export interface OcGraftInput {
  /** Every in-window `session` row. Refused rows are filtered out upstream. */
  sessions: readonly OcSessionRow[];
  /** Every `project` row, for the `worktree` join (OC8). */
  projects: readonly OcProjectRow[];
  /** `parse.ts`'s output: tool records per session, plus its counters. */
  parse: OcParseResult;
  options?: OcGraftOptions;
}

/**
 * `SessionState.liveness` for a STATIC corpus (OC4).
 *
 * `time_archived` set -> `ended`; otherwise `idle`. `unsupported` is what a
 * fingerprint refusal produces and is never reached from here — refusal is
 * `fingerprint.ts`'s, and a refused session does not arrive in `sessions`.
 *
 * MEASURED GAP: `time_archived` is NULL on all 24 anchor and all 5 witness
 * rows, so the `ended` branch is unexercised by either corpus and is proven
 * only by a hand-built row in `graft.test.ts`.
 */
export function defaultSessionLiveness(session: OcSessionRow): SessionState['liveness'] {
  return session.timeArchived === null ? 'idle' : 'ended';
}

/** The goldens' `workspaceMatch`: the project row exists. See {@link OcGraftOptions}. */
export function defaultWorkspaceMatch(
  _session: OcSessionRow | undefined,
  project: OcProjectRow | undefined,
): boolean {
  return project !== undefined;
}

/** The goldens' `projectSlug`: the empty placeholder. See {@link OcGraftOptions}. */
export function defaultProjectSlug(
  _session: OcSessionRow | undefined,
  _project: OcProjectRow | undefined,
): string {
  return '';
}

/**
 * The default {@link OcGraftOptions.refusedSessionIds}: nothing was refused.
 *
 * Module-scoped rather than built per call so a caller that passes no options
 * allocates nothing, and so the "empty means Phase 4's behaviour" claim is one
 * value rather than one per invocation.
 */
const EMPTY_REFUSED: ReadonlySet<string> = new Set<string>();

// ---------------------------------------------------------------------------
// Ordering, labels and node construction
// ---------------------------------------------------------------------------

/**
 * `OcToolRecord.order` is `[time_created, part id]`; ties break on the id.
 *
 * This reproduces SQLite's `ORDER BY time_created, id` with the default BINARY
 * collation. Both are ASCII `prt_*` ids, where JavaScript's UTF-16 code-unit
 * comparison and SQLite's byte comparison agree. **Do not use `localeCompare`**
 * — it is locale-sensitive and would order the same rows differently on a
 * different machine, which is the golden-reproduction failure that looks like
 * a parser bug. Same family as the recorded SQLite `LIKE` trap: a
 * case/collation rule that hands you a confident wrong answer.
 */
export function compareToolRecords(a: OcToolRecord, b: OcToolRecord): number {
  if (a.order[0] !== b.order[0]) return a.order[0] - b.order[0];
  if (a.order[1] === b.order[1]) return 0;
  return a.order[1] < b.order[1] ? -1 : 1;
}

/**
 * `AgentNode.label` — OC3: `session.agent` + `session.title` replace CC's
 * `meta.agentType` + `meta.description`.
 *
 * The separator is `': '`, matching the CC goldens' `"Explore: List contents
 * of spike/"`. `agent` is nullable in the schema, and an absent or empty one
 * yields the title alone rather than a `": "` prefix on nothing.
 */
export function agentLabel(session: OcSessionRow): string {
  const agent = typeof session.agent === 'string' && session.agent !== '' ? session.agent : undefined;
  return agent === undefined ? session.title : `${agent}: ${session.title}`;
}

/**
 * `OcToolRecord` -> `ToolNode`: the first six fields, verbatim.
 *
 * `partId`, `sessionId`, `order`, `taskChildSessionId`, `taskParentSessionId`,
 * `inputTruncated` and `resultTruncated` are join/ordering carriers and are
 * dropped here. The optional fields are omitted rather than set to
 * `undefined`, so a `JSON.stringify` of the node has no key for them.
 *
 * `truncated` is NOT one of the carriers — it is OpenCode's own truncation
 * claim and it is a `ToolNode` field as of `PLAN.md`'s Phase 5 gate (B7,
 * closing `docs/evidence/phase-4/COVERAGE.md` item 22). It crosses verbatim,
 * including `false`: an explicit "I did not truncate this" is a claim and is
 * worth more than an absence, which means only that no claim was made. The
 * engine's flag is never merged with `inputTruncated`/`resultTruncated`, which
 * are OURS and are recoverable by raising `agentDeck.previewBytes`.
 *
 * The fields are listed explicitly rather than taken by rest-destructuring:
 * a field added to `OcToolRecord` must be decided about here, not silently
 * copied into the wire contract.
 */
export function toToolNode(record: OcToolRecord): ToolNode {
  return {
    id: record.id,
    toolName: record.toolName,
    status: record.status,
    inputPreview: record.inputPreview,
    ...(record.resultPreview === undefined ? {} : { resultPreview: record.resultPreview }),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
    ...(record.truncated === undefined ? {} : { truncated: record.truncated }),
  };
}

// ---------------------------------------------------------------------------
// The join (OC3, contract §5)
// ---------------------------------------------------------------------------

interface JoinResult {
  /** Child session id -> the `task` record that spawned it. */
  readonly spawningTask: ReadonlyMap<string, OcToolRecord>;
  /** Parked entries keyed by the session the `task` part lives in. */
  readonly parkedBySession: ReadonlyMap<string, readonly ParkedGraft[]>;
  readonly taskPartsJoined: number;
  readonly taskPartsParked: number;
}

/**
 * Cross-assert every `task` part's three join keys and park what disagrees.
 *
 * The walk order is the GLOBAL `[time_created, part id]` order, reproducing
 * the reference's `SELECT ... FROM part ORDER BY time_created, id`. It matters
 * for exactly one thing: which of two `task` parts naming the same child wins
 * and which parks as `ambiguousJoinKey`.
 */
function joinTasks(
  taskRecords: readonly OcToolRecord[],
  sessionsById: ReadonlyMap<string, OcSessionRow>,
  refusedSessionIds: ReadonlySet<string>,
): JoinResult {
  const spawningTask = new Map<string, OcToolRecord>();
  const parkedBySession = new Map<string, ParkedGraft[]>();
  let taskPartsJoined = 0;
  let taskPartsParked = 0;

  const park = (sessionId: string, entry: ParkedGraft): void => {
    const list = parkedBySession.get(sessionId) ?? [];
    list.push(entry);
    parkedBySession.set(sessionId, list);
  };

  for (const task of taskRecords) {
    const childId = task.taskChildSessionId;

    // (1) No `state.metadata.sessionId` at all. 9 of 29 in the anchor, so this
    // is a NORMAL state — most likely a call observed before the child row
    // exists, the direct analogue of CC writing a subagent sidecar 0.080-0.120 s
    // before its transcript.
    //
    // Three normative rules, all OC3:
    //   - it parks with a stable code;
    //   - it is NOT guessed from timing (there are 20 child sessions in the
    //     anchor and a nearest-in-time match would find one — we do not look);
    //   - it is NOT a disagreement, so it gets a different code from one.
    //
    // The `task` part still becomes a `ToolNode`: the call happened and the
    // user saw it. No `AgentNode` and no `SpawnEdge` are produced.
    if (childId === undefined) {
      taskPartsParked++;
      park(task.sessionId, {
        // `ParkedGraft.agentId` is documented as "the identity of the thing
        // that did not graft", widened by Phase 4 for exactly this case
        // (GOLDEN.md DEVIATIONS item 3): the entire content of the case is
        // that NO agent id exists, so the `prt_*` row id is the only stable
        // identity the data offers. `code` says which kind of id it is.
        agentId: task.partId,
        code: 'taskWithoutChild',
        toolUseId: task.id,
        reason: OC_PARK_REASONS.taskWithoutChild,
      });
      continue;
    }

    /*
     * (2) The child was REFUSED by the version window, so the join was never
     * attempted. Item 29, and the reason it needed its own code.
     *
     * This is checked BEFORE the three-way cross-assertion below, and the
     * order is the whole content of the fix. A refused child is not among the
     * accepted rows, so `child.parent_id` — one of the three keys — cannot be
     * read at all. Falling through would report a cross-assertion FAILURE for
     * a check that was never RUN, sending a user looking for corrupt data
     * where there is none: what happened is that one session is out of window.
     *
     * The `task` part still becomes a `ToolNode` and the parent still renders
     * the rest of its tree. Only the child is missing, and now it says why.
     *
     * The refused child does NOT also get an `unsupported` SessionState of its
     * own — that treatment is for refused ROOT sessions (`index.ts`), because
     * a child is a subagent inside its parent's session and not a deck entry.
     */
    if (refusedSessionIds.has(childId)) {
      park(task.sessionId, {
        agentId: childId,
        code: 'childSessionUnsupported',
        toolUseId: task.id,
        reason: OC_PARK_REASONS.childSessionUnsupported,
      });
      continue;
    }

    // (3) The three keys must agree: the part names a child that exists, the
    // child's `parent_id` is the part's own session, and the part's
    // `parentSessionId` is the part's own session too. A primary key in both
    // directions — a join, not an inference.
    const child = sessionsById.get(childId);
    const agrees =
      child !== undefined &&
      child.parentId === task.sessionId &&
      task.taskParentSessionId === task.sessionId;
    if (!agrees) {
      park(task.sessionId, {
        agentId: childId,
        code: 'joinKeyContradiction',
        toolUseId: task.id,
        reason: OC_PARK_REASONS.joinKeyContradiction,
      });
      continue;
    }

    // (4) Two task parts naming one child. G3: a contradicted key parks, it
    // does not pick a winner — the first by `[time_created, part id]` keeps
    // the child and the later one parks.
    if (spawningTask.has(childId)) {
      park(task.sessionId, {
        agentId: childId,
        code: 'ambiguousJoinKey',
        toolUseId: task.id,
        reason: OC_PARK_REASONS.ambiguousJoinKey,
      });
      continue;
    }

    taskPartsJoined++;
    spawningTask.set(childId, task);
  }

  return { spawningTask, parkedBySession, taskPartsJoined, taskPartsParked };
}

/*
 * COUNTER PLACEMENT, RECORDED RATHER THAN ASSUMED.
 *
 * `taskPartsParked` above is incremented ONLY on the `taskWithoutChild`
 * branch, which is what `scripts/opencode-golden.mjs` does and what the
 * committed `counts` blocks were generated with. `OcCounts` in `types.ts`
 * describes the field as "`task` parts parked — `taskWithoutChild`, or a
 * contradiction", which reads as all three branches.
 *
 * The two readings cannot be told apart by either committed corpus: the anchor
 * has 20 agreements and 0 disagreements, the witness 1 and 0, so
 * `joinKeyContradiction`, `ambiguousJoinKey` and `childSessionUnsupported`
 * fire zero times and both readings emit `taskPartsParked: 9` and `0`.
 * `childSessionUnsupported` joined the list at `PLAN.md`'s Phase 5 gate and
 * does not increment either, for the same reason: the generator has no
 * version window and therefore no such branch to agree with. This module
 * follows the
 * generator, because that is the artefact DoD 4.6 compares against; the
 * divergence is pinned by an explicit test in `graft.test.ts` so that changing
 * it is a deliberate act with a failing assertion, not a silent drift.
 */

// ---------------------------------------------------------------------------
// Assembly — one `SessionState` per ROOT session
// ---------------------------------------------------------------------------

interface BuildContext {
  readonly childrenOf: ReadonlyMap<string, readonly OcSessionRow[]>;
  readonly toolsBySession: ReadonlyMap<string, readonly OcToolRecord[]>;
  readonly spawningTask: ReadonlyMap<string, OcToolRecord>;
  readonly parkedBySession: ReadonlyMap<string, readonly ParkedGraft[]>;
  readonly seenSessionRows: Set<string>;
  readonly spawnEdges: SpawnEdge[];
  readonly parked: ParkedGraft[];
  readonly totals: { costUsd: number };
}

/**
 * Build the `AgentNode` for `session` at `depth`, recursively.
 *
 * `depth` is WALKED from the `parent_id` chain — it is the recursion's own
 * depth, and the recursion follows `childrenOf`, which is built from
 * `parent_id`. It is never read from the data (OpenCode records no depth
 * anywhere) and it is never capped: OC3, "Depth comes from the data, not from
 * a cap". The measured machine's `permission` config denies `task` inside
 * subagents, so every real chain in both corpora stops at depth 1; that is one
 * installation's setting, not a property of OpenCode.
 */
function buildAgent(session: OcSessionRow, depth: number, ctx: BuildContext): AgentNode {
  ctx.seenSessionRows.add(session.id);

  // Totals accumulate in pre-order, parent before children, children in tool
  // order. The ORDER is load-bearing and not cosmetic: `costUsd` is a float
  // sum, and adding the same values in a different order can differ in the
  // last bits, which a byte-for-byte golden comparison sees.
  ctx.totals.costUsd += session.cost;

  const nodeId = depth === 0 ? 'root' : session.id;
  const tools = [...(ctx.toolsBySession.get(session.id) ?? [])].sort(compareToolRecords);

  for (const entry of ctx.parkedBySession.get(session.id) ?? []) ctx.parked.push(entry);

  const childSessions = ctx.childrenOf.get(session.id) ?? [];
  const children: TreeNode[] = [];

  for (const tool of tools) {
    children.push(toToolNode(tool));

    // A subagent `AgentNode` sits BESIDE the tool call that spawned it, never
    // inside it: `ToolNode` has no `children` field and that stays true
    // (`../model/events.js`). Placing it immediately after its spawning tool
    // node is what the CC grafter does and what `fixtures/golden/session/*.json`
    // shows. The real spawn relationship therefore exists only in `spawnEdges`.
    const child = childSessions.find((c) => ctx.spawningTask.get(c.id) === tool);
    if (child === undefined) continue;

    ctx.spawnEdges.push({
      // OC3: the join is `task` part -> child session, by primary key. The
      // `toolUseId` slot carries OpenCode's `callID`, which is the same thing
      // `tool_use_id` is for CC (contract amendment §D).
      toolUseId: tool.id,
      agentId: child.id,
      parentNodeId: nodeId,
      depth: depth + 1,
      // `recordedDepth` is documented as "`spawnDepth` as written in the
      // sidecar, kept even when it disagrees" — the point being that a
      // recorded value can contradict a walked one. OpenCode records NO depth
      // anywhere, so this equals `depth` BY CONSTRUCTION and can never
      // disagree. It is not wrong, it is vacuous for this engine; flagged as
      // GOLDEN.md DEVIATIONS item 4.
      recordedDepth: depth + 1,
    });
    children.push(buildAgent(child, depth + 1, ctx));
  }

  // Any child row of this session that the tool walk did not reach. Two cases,
  // and neither may drop the row: a child nothing joined parks with a stable
  // code, and a child whose spawning task part is somehow outside this session
  // is a contradiction in the join itself and throws rather than vanishing.
  for (const child of childSessions) {
    if (ctx.seenSessionRows.has(child.id)) continue;
    const task = ctx.spawningTask.get(child.id);
    if (task === undefined) {
      ctx.parked.push({
        agentId: child.id,
        code: 'noSpawningTaskPart',
        // No `toolUseId` key at all: there is no join key to quote. An empty
        // string would claim a key was read and found blank.
        reason: OC_PARK_REASONS.noSpawningTaskPart,
      });
      ctx.seenSessionRows.add(child.id);
      continue;
    }
    throw new Error(`child ${child.id} joined a task part outside its parent session`);
  }

  // OC4: "a `tool` part whose `state.status` is `running` with no
  // `state.time.end` -> running". Otherwise, for a subagent, the spawning
  // `task` part's own status is the honest answer — it is the parent's record
  // of how the child ended — and for a root with nothing running there is
  // nothing left to say but `done`.
  //
  // MEASURED GAP: the anchor has 0 running tool parts (219 completed, 27
  // error), so the `running` branch is unexercised by either corpus and is
  // proven only by a hand-built record in `graft.test.ts`.
  const spawningTask = depth === 0 ? undefined : ctx.spawningTask.get(session.id);
  const status: AgentNode['status'] = tools.some((t) => t.status === 'running')
    ? 'running'
    : spawningTask !== undefined
      ? spawningTask.status === 'error'
        ? 'error'
        : 'done'
      : 'done';

  return {
    id: nodeId,
    kind: depth === 0 ? 'main' : 'subagent',
    label: agentLabel(session),
    status,
    spawnDepth: depth,
    children,
    /*
     * `contextNow` and `burn` are OMITTED, deliberately, and this is the whole
     * of the OpenCode token story for now.
     *
     * `session.tokens_input` IS a genuine session-cumulative total — measured
     * on the anchor corpus, all 24 sessions equal the sum of their own
     * `step-finish` part rows, and `src/opencode/graft.test.ts` pins that. It
     * is still the WRONG number for `TokenPair.prompt`, because it counts only
     * UNCACHED input: across the same corpus `tokens.cache.read` sums to
     * 8,875,276 against `tokens.input`'s 1,227,047, so a session whose prompt
     * is mostly cache would report roughly a seventh of what it sent. That is
     * exactly the defect `TokenPair` was introduced to remove, arriving
     * through a second engine, so it is NOT mapped.
     *
     * The correct figure is reachable — `input + cache.read + cache.write` per
     * `step-finish` row — but nothing reads those rows yet, and building that
     * reader is deferred by user decision at the Phase 7 gate rather than
     * guessed at here. Until then the keys are ABSENT, never 0: absent renders
     * as `EM_DASH` ("we do not have this number") and 0 would be a claim.
     */
    startedAt: session.timeCreated,
    /*
     * `endedAt`: OC4 makes `time_archived` the session-end signal. It is NULL
     * throughout both corpora, so the fallback carries every row there:
     * `time_updated` is the last write to the session, which for a session
     * that is not running IS when it stopped changing. A running agent has no
     * end, and the KEY IS OMITTED rather than set to `undefined` — a wire
     * field present with a null is a claim that the value was looked up and
     * was empty.
     */
    ...(status === 'running'
      ? {}
      : { endedAt: session.timeArchived ?? session.timeUpdated }),
  };
}

/**
 * Build one `SessionState` per ROOT session (a `session` row with a NULL
 * `parent_id`), with every descendant session grafted in as an `AgentNode`.
 *
 * Contract §9 maps CC's `subagents/agent-<id>.jsonl` + `.meta.json` onto
 * `session.parent_id` rows plus the `task` part join, so a child session is a
 * subagent INSIDE its parent's session — not a deck entry of its own. Anchor:
 * 24 rows -> 4 `SessionState`s carrying 20 subagents. Witness: 5 -> 4 and 1.
 *
 * `refused` is always empty here. Per-session refusal is the fingerprint's
 * (OC2, DoD 4.2) and a refused row never reaches this function; `index.ts`
 * composes the two.
 *
 * @throws if any `session` row is reachable as neither a root, nor an
 * `AgentNode` under one, nor a parked entry. A row reachable through none of
 * those is a session SILENTLY DROPPED, which is the failure this whole
 * exercise exists to make visible — so it is loud rather than absent.
 *
 * **A KNOWN REACHABLE CASE OF THAT THROW. CONTAINED, NOT FIXED.** An ACCEPTED
 * session whose parent was REFUSED is reachable from no root, because the
 * refused parent is not in `sessions` and the accepted child is not a root
 * either. It lands in the orphan check and throws. The condition predates the
 * `refusedSessionIds` seam above and is unchanged by it — the seam only fixes
 * the code on the PARK of a refused direct child, which is
 * `docs/evidence/phase-4/COVERAGE.md` item 29 and all that Phase 5's gate
 * scoped.
 *
 * **Where it is contained:** `src/opencode/index.ts` wraps this call in the
 * engine's one try/catch and returns a `graftFailed` degrade, so the throw no
 * longer escapes `readOpenCodeEngine`, whose contract is "never thrown, always
 * returned" and which the extension host calls from `activate`. This function
 * still throws and must keep throwing — a silently dropped session is the
 * failure the check exists to expose.
 *
 * **What containment costs, and why this is not the word "fixed":** a degrade
 * is engine-wide, so one unplaceable row darkens every OpenCode session, when
 * the condition itself is a single explainable row. Parking it instead —
 * distinguishing "unreachable because an ancestor was refused" from
 * "unreachable for no reason we can name" — is the better fix and needs a
 * decision about which `SessionState` an orphaned grandchild belongs to. That
 * decision has still not been taken. Neither committed corpus contains such a
 * row; `golden.test.ts` reproduces it by refusing a real parent's version on a
 * temp copy.
 */
export function graftCorpus(input: OcGraftInput): OcEngineResult {
  const { sessions, projects, parse } = input;
  const livenessFor = input.options?.livenessFor ?? defaultSessionLiveness;
  const workspaceMatch = input.options?.workspaceMatch ?? defaultWorkspaceMatch;
  const projectSlug = input.options?.projectSlug ?? defaultProjectSlug;
  const refusedSessionIds = input.options?.refusedSessionIds ?? EMPTY_REFUSED;

  const sessionsById = new Map(sessions.map((s) => [s.id, s]));
  const childrenOf = new Map<string, OcSessionRow[]>();
  for (const session of sessions) {
    const parentId = session.parentId;
    // Falsy rather than `=== null`: the reference treats `''` as "no parent"
    // too, and a row with an empty-string parent is a root, not a child of a
    // session whose id is the empty string.
    if (!parentId) continue;
    const list = childrenOf.get(parentId) ?? [];
    list.push(session);
    childrenOf.set(parentId, list);
  }

  // Every `task` record across every session, in the global part order.
  const taskRecords: OcToolRecord[] = [];
  for (const records of parse.toolsBySession.values()) {
    for (const record of records) {
      if (record.toolName === 'task') taskRecords.push(record);
    }
  }
  taskRecords.sort(compareToolRecords);

  const join = joinTasks(taskRecords, sessionsById, refusedSessionIds);

  const roots = sessions.filter((s) => !s.parentId);
  const seenSessionRows = new Set<string>();
  const states: SessionState[] = [];
  let opencodeUnkeyed = 0;

  for (const root of roots) {
    const spawnEdges: SpawnEdge[] = [];
    const parked: ParkedGraft[] = [];
    const totals = { costUsd: 0 };
    const rootNode = buildAgent(root, 0, {
      childrenOf,
      toolsBySession: parse.toolsBySession,
      spawningTask: join.spawningTask,
      parkedBySession: join.parkedBySession,
      seenSessionRows,
      spawnEdges,
      parked,
      totals,
    });
    const project = projects.find((p) => p.id === root.projectId);
    // Resolved ONCE, so the counter below and the field cannot disagree about
    // what happened. `''` is the seam's "no key available" answer and it is
    // counted rather than passed over in silence (G3, rule 18's class).
    const slug = projectSlug(root, project);
    if (slug === '') opencodeUnkeyed += 1;
    states.push({
      sessionId: root.id,
      projectSlug: slug,
      // OC7: additive and optional; absence reads as `'cc'`, so it is written
      // rather than left to a default. It is what makes G2's cross-engine half
      // assertable at all.
      engine: 'opencode',
      workspaceMatch: workspaceMatch(root, project),
      liveness: livenessFor(root),
      // Refusal is `fingerprint.ts`'s, not the grafter's (G3, OC2). A session
      // that reaches here was accepted, so this is `true` unconditionally —
      // the grafter has no refusal of its own to express.
      schemaOk: true,
      totals,
      spawnEdges,
      parked,
      root: rootNode,
    });
  }

  const orphans = sessions.filter((s) => !seenSessionRows.has(s.id)).map((s) => s.id);
  if (orphans.length > 0) {
    throw new Error(`session rows reachable from no root: ${orphans.join(', ')}`);
  }

  /*
   * `dataVersion` is present only when every rendered session agrees. A mixed
   * database leaves it undefined rather than picking one — OC5's anchor is the
   * data's per-session `session.version`, never the binary's, and a corpus
   * that spans two versions has no single one to report.
   */
  const versions = new Set(sessions.map((s) => s.version));
  const [onlyVersion] = versions;
  const dataVersion = versions.size === 1 && onlyVersion !== undefined ? onlyVersion : undefined;

  /*
   * The counter block, in the goldens' own key order:
   * sessionRows, rootSessions, childSessions, then `OcParseCounts` verbatim
   * with `taskPartsJoined` / `taskPartsParked` in the middle of it. Key order
   * is load-bearing because DoD 4.6 compares serialized bytes.
   *
   * The parse counters are listed field by field rather than spread, so a
   * counter added to `OcParseCounts` is a COMPILE ERROR here and has to be
   * placed deliberately, instead of arriving in an arbitrary position and
   * moving the golden's bytes.
   */
  const counts: OcCounts = {
    sessionRows: sessions.length,
    rootSessions: roots.length,
    childSessions: sessions.length - roots.length,
    partRows: parse.counts.partRows,
    partsMalformed: parse.counts.partsMalformed,
    reasoningPartsDropped: parse.counts.reasoningPartsDropped,
    partsIgnoredNoNode: parse.counts.partsIgnoredNoNode,
    toolParts: parse.counts.toolParts,
    taskParts: parse.counts.taskParts,
    taskPartsJoined: join.taskPartsJoined,
    taskPartsParked: join.taskPartsParked,
    previewsTruncated: parse.counts.previewsTruncated,
  };

  return {
    ...(dataVersion === undefined ? {} : { dataVersion }),
    counts,
    // DELIBERATELY OUTSIDE `counts`. `counts` is a byte-exact contract (DoD
    // 4.6) generated by `scripts/opencode-golden.mjs`, an independent
    // reimplementation; putting a keying counter there would mean restating the
    // keying rule in a second place, which is this repository's own
    // "two agreeing literals is not a contract" class. It is a runtime
    // diagnostic about resolution, not a statistic about the corpus.
    opencodeUnkeyed,
    sessions: states,
    refused: [],
  };
}
