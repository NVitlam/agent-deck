/**
 * Agent Deck — the OpenCode engine's internal hand-off line.
 *
 * Types only. No I/O, no logic, no dependencies beyond `../model/events.js`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * `src/opencode/` was built by four packages working in parallel worktrees,
 * one module each: `db.ts` + `fingerprint.ts` + `slug.ts`, `parse.ts`,
 * `graft.ts`, `liveness.ts`. This repo's recorded lesson about that shape is
 * that **a module-boundary partition produces silent seams, not crashes** —
 * Phase 3's host emitted `<div id="app">` while the webview looked for
 * `#agent-deck-root`, both halves internally consistent, both fully tested,
 * and the panel rendered into the wrong element with nothing failing. Two
 * agreeing literals is not a contract.
 *
 * So the shapes that cross a package boundary are defined once, here, and the
 * packages import them rather than restating them. `src/bridge/contract.ts` is
 * the same move for the host/webview line.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE
 * ---------------------------------------------------------------------------
 *
 * `SessionState`, `AgentNode`, `ToolNode`, `SpawnEdge`, `ParkedGraft` and
 * `ParkCode` are NOT redefined. They live in `../model/events.js` and that
 * file is the authority for them, for this engine exactly as for the Claude
 * Code one. `agent-deck-spec.md` OC-preamble: "The engine is one module tree,
 * `src/opencode/` (Phase 4), feeding the **existing** `SessionState` contract
 * in §6. There is no second data model and no second wire contract."
 */

import type { SessionState } from '../model/events.js';

// ---------------------------------------------------------------------------
// (a) Raw rows — `db.ts` produces, everything downstream consumes
// ---------------------------------------------------------------------------

/*
 * Column sets are `agent-deck-spec.md` OC2's table, which is
 * `docs/opencode-contract.md` §3 in full. Integers are read as BigInt from
 * SQLite (`setReadBigInts`) so no millisecond timestamp passes through a
 * float, then narrowed to `number` at this boundary — the same thing
 * `scripts/capture-opencode.mjs` and `scripts/opencode-golden.mjs` do.
 *
 * Nullable columns are typed `| null`, never `| undefined`: SQLite hands back
 * `null` and converting it to an absence would lose the distinction between
 * "the column is NULL" and "the engine did not read the column".
 */

/** A `project` row. `worktree` is the workspace join key (OC8). */
export interface OcProjectRow {
  id: string;
  /** An ABSOLUTE path, so there is no slug decoding at all (OC8). */
  worktree: string;
  vcs: string | null;
}

/** A `session` row — one per session, root or subagent. */
export interface OcSessionRow {
  id: string;
  projectId: string;
  /** Names the parent session. NULL on a root session; the subagent chain. */
  parentId: string | null;
  slug: string | null;
  /** The session's cwd. NOT the join key — `project.worktree` is (OC8). */
  directory: string | null;
  title: string;
  /**
   * The version that WROTE this row. The fingerprint's anchor, per session.
   * Never the binary's version: OpenCode self-updated `1.18.22` -> `1.18.23`
   * mid-phase while the database held rows from `1.18.21` and `1.18.22` (OC5).
   */
  version: string;
  agent: string | null;
  model: string | null;
  cost: number;
  tokensInput: number;
  tokensOutput: number;
  timeCreated: number;
  timeUpdated: number;
  /** Set -> the session ended (OC4). NULL throughout both committed corpora. */
  timeArchived: number | null;
}

/** A `part` row. `data` is JSON as stored; parsing it is `parse.ts`'s job. */
export interface OcPartRow {
  id: string;
  messageId: string;
  sessionId: string;
  timeCreated: number;
  timeUpdated: number;
  /** The raw JSON text. Never pre-parsed here — a malformed one must COUNT. */
  data: string;
}

/**
 * An `event_sequence` row: the current max `seq` per aggregate.
 *
 * `aggregate_id` is a session id and `seq` is monotonic **per aggregate** from
 * 0. Per-session is not stylistic: across 2 h 08 m of real sessions the GLOBAL
 * `max(seq)` sat frozen at 1,589 while the event count rose by 73, because one
 * long session dominated it (OC4, kill gate §2.7).
 */
export interface OcEventSequenceRow {
  aggregateId: string;
  seq: number;
  ownerId: string | null;
}

// ---------------------------------------------------------------------------
// (b) Refusals and degradation — two different things, kept apart
// ---------------------------------------------------------------------------

/**
 * The ENGINE is unusable: there is no data to render at all.
 *
 * Distinct from a per-session refusal below, and the distinction is the whole
 * of G2's cross-engine half: a degraded OpenCode engine must leave the Claude
 * Code sessions rendering unchanged (`PLAN.md` DoD 5.3). Degradation is a
 * property of the database handle; a refusal is a property of one session.
 */
export type OcDegradeCode =
  /** The data directory or the `opencode.db` file is not there. */
  | 'databaseMissing'
  /** Present but `DatabaseSync` would not open it read-only. */
  | 'databaseUnreadable'
  /**
   * Opened, but a read failed — a truncated file, a hot WAL left by a process
   * that died mid-write, a schema SQLite will not walk.
   *
   * **Specified, not measured.** OpenCode *dying* with a hot WAL was never
   * reproduced, because reproducing it means killing a live session mid-write
   * (OC9). The ordinary hot-WAL case is measured and is a NON-event for a
   * read-only opener: 20 opens 1.5 s apart with OpenCode writing, 20/20
   * succeeded, 0 `SQLITE_BUSY`, slowest open 2 ms.
   */
  | 'databaseCorrupt';

/** Engine health. `ok: false` means render nothing and flag the engine (G3). */
export type OcEngineHealth =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: OcDegradeCode;
      /** Human-readable, carrying the underlying errno/message where there is one. */
      readonly message: string;
      /** The path that was opened. Never a path from inside the database. */
      readonly path: string;
    };

/**
 * Why ONE session refuses. The session renders `unsupported`, never a partial
 * tree (G3).
 *
 * Every code is asserted individually by a `synthetic-` fixture; a test that
 * only checked "something was rejected" would still pass while a mutation was
 * being rejected for the wrong reason. That is the rule
 * `src/parser/fingerprint.ts`'s `MismatchCode` already carries and it is
 * restated rather than inherited, because the two engines refuse for different
 * reasons and a shared union would invite one to borrow the other's codes.
 */
export type OcMismatchCode =
  /** A required table from OC2's six is absent from `sqlite_master`. */
  | 'missingTable'
  /** A required table is present but a column the engine reads is not. */
  | 'missingColumn'
  /**
   * `session.version` is outside the window around the anchor.
   *
   * Evaluated PER SESSION, so a mixed-version database renders its in-window
   * sessions and parks the rest (OC5, DoD 4.2). The mixed database is the
   * NORMAL case, not a hypothetical: the measured one held five `1.18.21` rows
   * beside twenty-three `1.18.22` rows.
   */
  | 'unsupportedVersion'
  /**
   * `session.version` is not `<major>.<minor>.<patch>` at all.
   *
   * Not folded into `unsupportedVersion`: an unparseable string is a different
   * story from a parseable one that is too far away, and guessing at an
   * unrecognised version string is the exact failure the fingerprint exists to
   * prevent.
   */
  | 'unparseableVersion';

/** One session's refusal. Mirrors `SchemaMismatch`'s shape for the CC engine. */
export interface OcMismatch {
  readonly kind: 'schemaMismatch';
  readonly code: OcMismatchCode;
  readonly reason: string;
  /** The table, `table.column`, or session id the refusal is about. */
  readonly at?: string;
  readonly expected?: string;
  readonly actual?: string;
  /** The `session.version` observed, when the refusal is about a version. */
  readonly observedVersion?: string;
}

// ---------------------------------------------------------------------------
// (c) `parse.ts` -> `graft.ts`
// ---------------------------------------------------------------------------

/**
 * One `tool` part, parsed and redacted, ready to become a `ToolNode`.
 *
 * The fields above the divider are exactly `ToolNode`'s; the ones below carry
 * the join and the ordering and are dropped when the node is built. Keeping
 * them on one record rather than in a side table is deliberate: a parallel
 * map keyed by part id is another pair of things that can disagree.
 */
export interface OcToolRecord {
  // -- `ToolNode`, verbatim ------------------------------------------------
  /**
   * `part.data.callID`, NOT the `prt_*` row id.
   *
   * `ToolNode.id` is documented as "the graft key", and `callID` is a join key
   * OpenCode itself uses — `tool.execute.before`/`after` in its plugin API
   * carry `sessionID` and `callID` (contract amendment §D).
   */
  readonly id: string;
  readonly toolName: string;
  readonly status: 'running' | 'done' | 'error';
  /** Canonical JSON of `state.input`, cut ONCE at the `redact.ts` ceiling. */
  readonly inputPreview: string;
  /** `state.output`, else `state.error`, else absent. Cut ONCE. */
  readonly resultPreview?: string;
  readonly durationMs?: number;
  /**
   * `state.metadata.truncated` — OPENCODE'S OWN claim, carried verbatim.
   *
   * Three states, and they are three different facts (`ToolNode.truncated` in
   * `../model/events.js` carries the same three):
   *
   *   - `true`  — OpenCode says it truncated this payload upstream. Nothing
   *     here can recover the bytes, unlike our own `redact.ts` marker.
   *   - `false` — OpenCode says it did not. A claim, not an absence.
   *   - absent  — no claim was made, which is NOT "known to be whole".
   *
   * The engine's boolean is never merged with `inputTruncated` /
   * `resultTruncated` below: those two record whether OUR ceiling fired, and
   * conflating them tells a user a payload is retrievable when it is not.
   *
   * Measured over the committed corpora: anchor 14 `true` / 205 `false` / 27
   * absent of 246 tool parts, witness 5 / 93 / 1 of 99. Zero non-boolean
   * values in either, so the "not a boolean is no claim" arm in `parse.ts` is
   * unexercised by a fixture.
   */
  readonly truncated?: boolean;

  // -- join / ordering, dropped at node construction ------------------------
  /** The `prt_*` row id. The only identity a parked *part* has (OC3). */
  readonly partId: string;
  /** The session this part belongs to. */
  readonly sessionId: string;
  /** `[time_created, part id]` — the sort key. Ties break on the id. */
  readonly order: readonly [number, string];
  /** `state.metadata.sessionId` on a `task` part. Absent PARKS (OC3). */
  readonly taskChildSessionId?: string;
  /** `state.metadata.parentSessionId` on a `task` part. Cross-asserted. */
  readonly taskParentSessionId?: string;
  /** Whether the cut fired. Counted from the CUT, never sniffed from the text. */
  readonly inputTruncated: boolean;
  readonly resultTruncated: boolean;
}

/**
 * Counters the parser accumulates instead of throwing (G3).
 *
 * Every one of these appears in each corpus's `golden.json`'s `counts`
 * block, so the reproduction test (DoD 4.6) compares them byte-for-byte. A
 * counter that silently stopped incrementing would fail there.
 */
export interface OcParseCounts {
  /** Every `part` row read, before any classification. */
  partRows: number;
  /** `data` did not parse as JSON. Skipped, never thrown (G3). */
  partsMalformed: number;
  /** `reasoning` parts thrown away at the parse boundary (G4 / OC6). */
  reasoningPartsDropped: number;
  /** `text`, `step-start`, `step-finish`, `patch`, `compaction` — no node (OC2). */
  partsIgnoredNoNode: number;
  /** `tool` parts that produced a record. */
  toolParts: number;
  /** Of those, the ones whose `tool` is `task`. */
  taskParts: number;
  /**
   * Previews the ceiling actually cut, counted at PARSE time — once per tool
   * record produced, whether or not that record later reaches a tree.
   *
   * `scripts/opencode-golden.mjs` counts at SERIALIZATION time instead, so it
   * counts only tool nodes that reach the tree. The two agree on both committed
   * corpora because every session in them is reachable, and they would diverge
   * on a corpus holding a session parked with `noSpawningTaskPart` — its tool
   * parts are parsed and never serialized. **Unexercised, and listed as such in
   * `docs/evidence/phase-4/COVERAGE.md`** rather than left as a silent
   * difference between the engine and its reproduction target.
   */
  previewsTruncated: number;
}

/** Everything `parse.ts` hands `graft.ts`. */
export interface OcParseResult {
  /** Session id -> its tool records, unsorted. `graft.ts` orders them. */
  readonly toolsBySession: ReadonlyMap<string, readonly OcToolRecord[]>;
  readonly counts: OcParseCounts;
}

// ---------------------------------------------------------------------------
// (d) `graft.ts` -> `index.ts`
// ---------------------------------------------------------------------------

/** The parse counters plus the ones only the grafter can produce. */
export interface OcCounts extends OcParseCounts {
  sessionRows: number;
  rootSessions: number;
  childSessions: number;
  /** `task` parts whose three join keys agreed and produced a spawn edge. */
  taskPartsJoined: number;
  /**
   * `task` parts parked with `taskWithoutChild` — **that branch only**.
   *
   * An earlier draft of this line said "`taskWithoutChild`, or a contradiction",
   * which reads as all three park branches and is wrong.
   * `scripts/opencode-golden.mjs` has exactly ONE `counts.taskPartsParked++`
   * site and it is on the missing-`sessionId` branch; `joinKeyContradiction`
   * and `ambiguousJoinKey` park without incrementing it. The committed
   * `counts` blocks were generated that way, and DoD 4.6 compares them
   * byte-for-byte, so the narrow reading is the contract.
   *
   * Neither corpus can tell the two readings apart — both hold 0
   * contradictions, so both emit `9` and `0` either way. The narrow reading is
   * therefore pinned by a named test rather than left to the data, because the
   * data cannot settle it. `taskParts - taskPartsJoined` is the count of ALL
   * parked task parts if a caller wants it.
   */
  taskPartsParked: number;
}

/**
 * The engine's output for one database.
 *
 * `sessions` are `SessionState`s, one per ROOT session, each already carrying
 * `engine: 'opencode'` and its subagent sessions grafted in as `AgentNode`s.
 * A child session is a subagent INSIDE its parent's session, exactly as a CC
 * subagent transcript is — not a deck entry of its own (contract §9).
 */
export interface OcEngineResult {
  /**
   * The `session.version` shared by the corpus's in-window sessions.
   *
   * Present only when every rendered session agrees, which the committed
   * corpora do by construction (the capture partitions by version). A mixed
   * database leaves it `undefined` rather than picking one.
   */
  readonly dataVersion?: string;
  readonly counts: OcCounts;
  readonly sessions: readonly SessionState[];
  /**
   * Sessions the fingerprint refused, in the order they were read.
   *
   * A refused session is NOT absent: it renders `unsupported`. This list is
   * what says why, and it is how a mixed-version database reports the rows it
   * parked (DoD 4.2).
   */
  readonly refused: readonly (OcMismatch & { readonly sessionId: string })[];
}
