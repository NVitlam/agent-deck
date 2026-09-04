/**
 * Agent Deck — the Codex engine's HAND-OFF LINE (PLAN.md v0.6.0 Phase 2).
 *
 * Types only. No logic, no imports beyond the shared session model, nothing
 * that can be executed. This file exists so that six work packages built in
 * six isolated worktrees agree about the values they pass each other.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS WRITTEN BEFORE ANY OF THE MODULES IT DESCRIBES
 * ---------------------------------------------------------------------------
 *
 * `CLAUDE.md` records the defect this is built against, from Phase 3:
 *
 *   > A module-boundary partition produces silent seams, not crashes. The host
 *   > emitted `<div id="app">` while the webview looked for `#agent-deck-root`.
 *   > Both packages were internally consistent, both fully tested, and they
 *   > disagreed. Two agreeing literals is not a contract.
 *
 * So the contract is declared once, here, by the orchestrator, before the
 * fleet is dispatched — and the modules are written against it rather than
 * against each other. **No work package may edit this file.** A package that
 * believes a type here is wrong reports BLOCKED with the reason; it does not
 * widen a field to make its own tests pass, because the next package down the
 * chain is compiling against the version it was given.
 *
 * ---------------------------------------------------------------------------
 * THE SIX PACKAGES AND WHERE THEY MEET
 * ---------------------------------------------------------------------------
 *
 *   locate.ts      env + fs walk        -> CodexDiscovery      (P1, DoD 2.1)
 *   never-open.ts  the G10 list         -> CODEX_NEVER_OPEN    (P1, DoD 2.1)
 *   tail.ts        byte offsets         -> CodexTailState      (P1)
 *   fingerprint.ts CodexRecord[]        -> CodexFingerprint    (P2, DoD 2.2)
 *   parse.ts       CodexRecord[]        -> CodexThread         (P3, DoD 2.3)
 *   graft.ts       CodexThread[]        -> SessionState[]      (P5, DoD 2.4/2.6)
 *   liveness.ts    hooks + locks + mtime-> CodexLiveness       (P4, DoD 2.5)
 *   index.ts       chains the above     -> CodexEngineOutcome  (P6, DoD 2.7)
 *
 * ---------------------------------------------------------------------------
 * ABSENCE IS A VALUE HERE, AND IT IS NOT `null`
 * ---------------------------------------------------------------------------
 *
 * The spec (C5, and `docs/codex-contract.md` A3) measures that Codex signals
 * "not applicable" by OMITTING a key, never by writing `null`:
 *
 *   > An engine testing `=== null` reads `undefined`, takes the wrong branch,
 *   > and throws nothing.
 *
 * But `null` also occurs as a real, present value, and a `v1` subagent shows
 * BOTH shapes at once under one field name. Re-derived from spec C3a as
 * amended 2026-09-05 — the row it used to quote said `agent_path` is `null`
 * WITHOUT SAYING WHICH `agent_path`, and there are two:
 *
 *   payload.agent_path                              v1: THE KEY IS ABSENT
 *   payload.source.subagent.thread_spawn.agent_path v1: PRESENT, and null
 *
 * Under `v2` both are present and carry the same string. Measured over the
 * committed corpus: 10 v2 subagent `session_meta` records against 1 v1; over
 * the whole evidence tree, 16 against 2. The shape is what this rests on, not
 * the counts — those move with the corpus.
 *
 * THIS COMMENT IS WHY THE FIELD IS TYPED THE WAY IT IS, and the history is
 * worth the four lines. The old wording was copied here from the unqualified
 * spec row; `graft.ts` then read "no `agent_path`" as "unjoinable" and parked
 * EVERY v1 subagent, so an entire dialect of live sessions rendered with no
 * children. Nine tests guarded that join and all nine passed, because they
 * exercised the join and not the outcome: a child resolved correctly and then
 * discarded satisfies every one of them.
 *
 * The two must stay distinguishable all the way to the golden, whose every
 * optional field is `{present, value}` for exactly this reason.
 *
 * {@link CodexOptional} is that pair. Use it wherever the corpus distinguishes
 * absent from null. Use a plain `?:` only where absence and null mean the same
 * thing to every reader downstream.
 */

import type { SessionState, TokenPair } from '../model/events.js';

/**
 * An optional field of the rollout, carrying the distinction the golden
 * carries: was the key THERE, and if so what was in it.
 *
 * `{present: false, value: null}` — the key was absent.
 * `{present: true,  value: null}` — the key was there and held `null`.
 *
 * Those are different sessions, not two spellings of one. Collapsing them is
 * how the `v1` dialect was nearly refused: its NESTED `agent_path` is
 * present-and-null — while its TOP-LEVEL one is genuinely absent — and the
 * nested one was read as absent.
 *
 * `asObject(null)` answers `null` for both shapes, which is the exact collapse
 * that produced the defect. Read the pair at each name; never infer one field
 * from the other.
 */
export interface CodexOptional<T> {
  readonly present: boolean;
  readonly value: T | null;
}

// ===========================================================================
// C2 — the rollout record
// ===========================================================================

/**
 * The six record types observed in the corpus (spec C2). This union is NOT
 * exhaustive over what Codex may write, and must never be treated as such:
 * an unrecognised `type` is COUNTED and IGNORED, never refused
 * ({@link CodexCounters.unknownRecordTypes}, DoD 2.3's tripwire).
 */
export type CodexRecordType =
  | 'session_meta'
  | 'event_msg'
  | 'response_item'
  | 'turn_context'
  | 'world_state'
  | 'inter_agent_communication_metadata';

/**
 * One line of a rollout transcript. Spec C2: every record carries exactly
 * these four top-level keys and no others, and `ordinal` is a per-thread
 * counter, dense and monotonic from 0.
 *
 * `type` is a plain `string`, deliberately, NOT {@link CodexRecordType} — the
 * parser must be able to hold a type it does not know in order to count it.
 * Narrowing happens after the count, never before.
 */
export interface CodexRecord {
  readonly timestamp: string;
  readonly ordinal: number;
  readonly type: string;
  readonly payload: unknown;
}

// ===========================================================================
// P1 — locate.ts, never-open.ts, tail.ts  (DoD 2.1)
// ===========================================================================

/**
 * One transcript file found by the discovery walk.
 *
 * **There is nothing in the path that says whether this is a root thread or a
 * subagent's** (spec C1): a subagent's transcript is a SIBLING of its parent's
 * in the same day directory. That fact lives only inside the file, so this
 * type carries no `isSubagent` field and no package may add one — classifying
 * by path is the thing the spec says cannot work.
 */
export interface CodexTranscriptRef {
  /** Absolute path to the rollout file. */
  readonly path: string;
  /** Basename, `rollout-<ISO-ts>-<uuid>.jsonl`. The golden keys on this. */
  readonly file: string;
  /** `YYYY/MM/DD` as walked. The day the THREAD STARTED, not the day it ran. */
  readonly day: string;
  /** `statSync().size` at discovery, for the tailer's byte offsets. */
  readonly bytes: number;
  /** `statSync().mtimeMs`. Liveness corroboration only (spec C6). */
  readonly mtimeMs: number;
}

/**
 * What `locate.ts` returns. An absent root is NOT an error: the engine is
 * silently off and logs once at info (DoD 2.1). `rootExists: false` with an
 * empty `transcripts` is the normal state on a machine with no Codex.
 */
export interface CodexDiscovery {
  /** `$CODEX_HOME` when set, else `~/.codex` — resolved at READ time (C1). */
  readonly root: string;
  /**
   * Which source supplied the root. Logged, and asserted in tests.
   *
   * `'explicit'` is {@link CodexEngineOptions.root} — a caller naming the
   * root outright, which is how every test points at a fixture instead of
   * at a live `~/.codex` (G6). It is a THIRD value rather than a
   * translation into `{CODEX_HOME: path}`, because this field's only job is
   * to say where the root came from, and answering `'CODEX_HOME'` when no
   * environment variable was involved is a wrong answer in the one field
   * that exists to give the right one.
   */
  readonly rootSource: 'CODEX_HOME' | 'homedir' | 'explicit';
  readonly rootExists: boolean;
  readonly transcripts: readonly CodexTranscriptRef[];
  /** `<root>/thread-writer-locks`. May not exist. */
  readonly lockDir: string;
}

/**
 * Byte-offset tail state for one transcript, reusing `src/watch`'s semantics
 * (partial trailing line held back until its newline arrives).
 *
 * Codex stores tool output whole and inline — the corpus's defining record is
 * 554,126 bytes on ONE line — so a partial-line buffer here is not a corner
 * case, it is the normal state mid-append.
 */
export interface CodexTailState {
  readonly path: string;
  /** Bytes consumed and parsed. Never rewound except on a truncation reset. */
  readonly offset: number;
  /** Bytes read but not yet terminated by a newline. */
  readonly pending: string;
}

// ===========================================================================
// P2 — fingerprint.ts  (DoD 2.2)
// ===========================================================================

/**
 * Why a session was refused. G3: a mismatch renders the session `unsupported`
 * with NO TREE, never a partial one.
 *
 * **`agent_path` is deliberately absent from this list** (spec C3, user
 * decision 2026-09-03). An earlier draft required it, which would have refused
 * an entire dialect of live sessions.
 */
export type CodexMismatchCode =
  /** No `session_meta` at ordinal 0. */
  | 'sessionMetaMissing'
  /** `session_meta.payload.cli_version` absent. */
  | 'cliVersionMissing'
  /** A record without exactly the four top-level keys of C2. */
  | 'recordShapeMismatch'
  /** `session_meta.payload` missing one of `id` / `cwd` / `thread_source`. */
  | 'sessionMetaFieldMissing'
  /** `thread_source: "subagent"` without `source.subagent.thread_spawn`. */
  | 'subagentSpawnMissing'
  /** A `function_call` / `custom_tool_call` with no `call_id`. */
  | 'callIdMissing'
  /** Outside the G9 window: major exact, minor ±1, patch/prerelease ignored. */
  | 'versionOutOfWindow'
  /** Two dialect sources disagreed. C3a: "an error, not a tiebreak". */
  | 'dialectContradiction';

export interface CodexMismatch {
  readonly code: CodexMismatchCode;
  /** `<basename>:<ordinal>` where the mismatch was seen. Never a full path. */
  readonly at?: string;
  readonly field?: string;
}

/** Spec C3a. Read from the SESSION, never from a model list (C8/C10). */
export type CodexDialect = 'v1' | 'v2';

/**
 * Which source supplied the dialect, in the normative resolution order of
 * C3a. Recorded rather than inferred, because the golden pins it and because
 * `session_meta` ALONE CANNOT TYPE A SESSION WITH NO SUBAGENTS — the corpus
 * contains exactly that case (`long-output`).
 */
export type CodexDialectSource =
  | 'turn_context.multi_agent_version'
  | 'session_meta.multi_agent_version'
  | 'spawn_namespace';

export type CodexFingerprint =
  | {
      readonly ok: true;
      readonly cliVersion: string;
      readonly dialect: CodexDialect | null;
      readonly dialectSource: CodexDialectSource | null;
    }
  | { readonly ok: false; readonly mismatch: CodexMismatch };

// ===========================================================================
// P3 — parse.ts  (DoD 2.3, 2.3a)
// ===========================================================================

/**
 * Counters that make an ignore HONEST (spec C2, user note 2026-09-03):
 *
 *   > ignoring one SILENTLY is the fail-open class this project has shipped
 *   > through three separate doors. The counter is what makes the ignore
 *   > honest, so it is normative, not advisory.
 *
 * Every one of these is per THREAD and is summed per session by the grafter.
 */
export interface CodexCounters {
  /** Lines that did not parse as JSON. Counted and skipped, never thrown. */
  readonly malformedLines: number;
  /** Records whose `type` is not one of C2's six. DoD 2.3's tripwire. */
  readonly unknownRecordTypes: number;
  /** Reasoning-bearing records dropped at the boundary (G4, C7). */
  readonly reasoningDropped: number;
  /** Records below `subagent_history_start_ordinal`, dropped (C5). */
  readonly inheritedRecordsDropped: number;
  /** Payloads cut by the existing truncation marker. */
  readonly payloadsTruncated: number;
  /**
   * `response_item` payload types the parser recognised as records but had
   * no handler for — counted, skipped, and NAMED.
   *
   * This exists because of working-method rule 18: **a sweep or a reader
   * that skips an input reports the skip in its verdict, and a silent skip
   * is the fail-open class this repository has shipped through three
   * separate doors.** Without a field here the census had nowhere to go but
   * a module-local type, and the skip would have stopped existing at the
   * engine boundary — which is precisely a count of zero that nobody can
   * tell apart from "nothing was skipped".
   *
   * Sorted, de-duplicated, so it is comparable across runs. Distinct from
   * {@link CodexCounters.unknownRecordTypes}, which counts unknown TOP-LEVEL
   * record types (C2's six); this one is a level deeper, inside
   * `response_item`.
   */
  readonly skippedResponseItemTypes: readonly string[];
}

/**
 * The two id namespaces of spec C4, and the relation between them for one
 * call. **This is the trap the spec says must be written down.**
 *
 * A shell command carries an `exec-<uuid>` on `event_msg.payload.item.id` and
 * a completely unrelated `call_<…>` on its `response_item`. The hook tap
 * reports the ITEM id. Measured over 64 hook records: 40 resolve against
 * `call_id` alone, 64 against the union.
 *
 *   > An engine joining on `call_id` alone silently drops every shell call.
 */
export type CodexIdRelation =
  | 'item_id_equals_call_id'
  | 'item_id_distinct_from_call_id'
  | 'no_item';

/** One tool call, as the golden's `tool_calls[]` entries describe it. */
export interface CodexToolCall {
  readonly threadId: string;
  readonly file: string;
  readonly ordinal: number;
  /**
   * **Three members, not two.** An earlier version of this file listed only
   * `function_call` and `custom_tool_call`. The corpus holds a third,
   * `tool_search_call` — one record, in `resume-twice-v1` — and
   * `golden.json` COUNTS IT AS A TOOL CALL: its total of 42 is 31 + 10 + 1.
   *
   * A parser that cannot express it emits 41, and DoD 2.7's byte-exact
   * reproduction fails on a number nobody would immediately connect to a
   * union in a types file. It was found because P3 refused to mislabel the
   * record as one of the two it had, counted it as skipped, and reported the
   * arithmetic — which is the behaviour the hand-off line asks for.
   *
   * n=1 in this corpus, so nothing about `tool_search_call`'s shape beyond
   * its presence is claimed here.
   */
  readonly kind: 'function_call' | 'custom_tool_call' | 'tool_search_call';
  readonly name: string;
  readonly namespace: CodexOptional<string>;
  /** `response_item.payload.call_id`. Always `call_<…>`. */
  readonly callId: string;
  /** `event_msg.payload.item.id`. `exec-<uuid>` for a shell command. */
  readonly itemId: string | null;
  readonly itemType: string | null;
  readonly idRelation: CodexIdRelation;
  /** Redacted and truncated already. Never raw. */
  readonly outputPreview?: string;
  readonly outputTruncated?: boolean;
}

/**
 * One `spawn_agent` call and everything known about the child it names.
 *
 * `childResolvedBy` records WHICH key made the join, because the two dialects
 * join differently (C4a) and the golden pins the distinction:
 *
 *   v2  `output.task_name` ↔ child `agent_path`
 *   v1  `output.agent_id`  ↔ child `session_meta.payload.id`
 */
/**
 * **These four strings are compared BYTE-FOR-BYTE against `golden.json`**
 * (DoD 2.7), so they are not free naming choices — they are quoted values.
 * The golden's own distribution over the corpus is 8 / 1 / 1 / 0.
 *
 * The middle one read `output_agent_id_equals_child_id` when this file was
 * first written, against the golden's `..._thread_id`. Nothing would have
 * caught it before the golden test ran: the parser never resolves a child
 * (it sees one file), and the grafter would have been written against
 * whatever this file said. It was found by re-deriving the golden's actual
 * value set rather than by reading either document.
 *
 * `refused` is a resolution, not a park: the engine ENFORCES agent-path
 * uniqueness and declines the second spawn outright. DoD 2.4 renders it as
 * a failed call.
 */
export type CodexSpawnResolution =
  | 'output_task_name_equals_agent_path'
  | 'output_agent_id_equals_thread_id'
  | 'refused'
  | 'unresolved';

export interface CodexSpawn {
  readonly threadId: string;
  readonly file: string;
  readonly ordinal: number;
  readonly callId: string;
  readonly itemId: string | null;
  readonly namespace: CodexOptional<string>;
  /** The name as REQUESTED in the arguments (`p1`), not the path (`/root/p1`). */
  readonly requestedTaskName: string | null;
  /** v2's join key: the child's full `agent_path`. */
  readonly outputTaskName: string | null;
  /** v1's join key: the child's thread id. */
  readonly outputAgentId: string | null;
  readonly outputNickname: string | null;
  readonly childThreadId: string | null;
  readonly childResolvedBy: CodexSpawnResolution;
  /**
   * What the `SubAgentActivity` item on this call states about the child.
   * A THIRD witness to the same edge, beside the output's two join keys, and
   * carried for the same reason as {@link CodexThread.threadSpawn}: it is
   * topology, and the golden may not exclude topology.
   */
  readonly activityAgentPath: CodexOptional<string>;
  readonly activityAgentThreadId: string | null;
  /**
   * The engine ENFORCES `agent_path` uniqueness: a second spawn asking for a
   * taken path is refused with `agent path /root/dup already exists`.
   *
   * DoD 2.4: a refused spawn renders as a FAILED CALL, not as a parked node.
   * It is not a join that failed; it is a call the engine declined.
   */
  readonly refused: boolean;
  readonly refusalText: string | null;
  /**
   * G4/C7: `arguments.message` is CIPHERTEXT — the full instruction sent to
   * the child. Its BYTE COUNT is recorded; its bytes are never stored, never
   * decoded, never displayed, and never reach any label or `SessionState`
   * field (DoD 2.3a asserts this against the literal captured bytes).
   */
  readonly messagePresent: boolean;
  readonly messageEncrypted: boolean;
  readonly messageBytes: number;
}

/**
 * One thread — one rollout transcript's own work, after the fork boundary has
 * been applied and reasoning has been dropped.
 *
 * A forked child re-serialises its parent's history AND a second
 * `session_meta`, so a file can declare more than one thread and a thread can
 * be declared in more than one file (C5). `owningFile` is the file whose
 * ordinal-0 `session_meta` declares it; that is the one whose records count.
 */
export interface CodexThread {
  readonly threadId: string;
  readonly sessionId: string;
  readonly owningFile: string;
  readonly cwd: string;
  readonly cliVersion: string;
  readonly threadSource: 'user' | 'subagent' | string;
  readonly originator: string | null;

  /** C3a. `null` when no source stated one. */
  readonly dialect: CodexDialect | null;
  readonly dialectSource: CodexDialectSource | null;
  readonly multiAgentVersion: CodexOptional<string>;

  /**
   * The TOP-LEVEL `session_meta.payload.agent_path`, and the word top-level
   * is the whole comment.
   *
   * **This comment used to read "present-and-null under `v1`", and that was
   * FALSE — measured on `resume-twice-v1`:**
   *
   * | field | v1 subagent |
   * |---|---|
   * | `payload.agent_path` (this one) | **key ABSENT** |
   * | `payload.source.subagent.thread_spawn.agent_path` | present, `null` |
   *
   * The spec's C3a table says a `v1` thread's `agent_path` is `null` without
   * saying WHICH of the two, and the claim is true of the nested one and false
   * of this one. That imprecision propagated into this file and then into the
   * grafter, where `!agentPath.present` was read as "unjoinable" and parked
   * every `v1` subagent as `noAgentPath` — reintroducing, through a third
   * door, the exact ruling the user reversed on corrected evidence.
   *
   * **So: absence here is NOT a reason to park.** It is the normal state of a
   * `v1` subagent and of every root thread. It is the `v2` join key, and
   * `v2` alone; a `v1` child joins by id (C4a), and whether a thread is
   * joinable is answered by asking the SPAWNS, never by this field's absence.
   * `noAgentPath` is for a thread no spawn names either way.
   *
   * The nested `thread_spawn.agent_path` is a DIFFERENT field with a
   * different meaning and is deliberately not carried here under the same
   * name. Conflating the two is what this comment exists to stop.
   */
  readonly agentPath: CodexOptional<string>;
  /** Populated in BOTH dialects, and the only label `v1` has (C7). */
  readonly agentNickname: CodexOptional<string>;
  readonly parentThreadId: CodexOptional<string>;
  readonly spawnDepth: CodexOptional<number>;

  /** C5. ABSENT, not null, when `fork_turns: "none"`. */
  readonly subagentHistoryStartOrdinal: CodexOptional<number>;
  readonly forkedFromId: CodexOptional<string>;
  readonly inheritedRecordsBeforeForkStart: number;

  /** C8. `undefined` when the transcript does not state one — never `0`. */
  readonly modelContextWindow?: number;
  /** C8: `last_token_usage` is the level. */
  readonly contextNow?: TokenPair;
  /** C8: `total_token_usage` is the running total. */
  readonly burn?: TokenPair;

  readonly toolCalls: readonly CodexToolCall[];
  readonly spawns: readonly CodexSpawn[];
  /**
   * The NESTED `source.subagent.thread_spawn` record, verbatim as optionals.
   *
   * **This is NOT {@link CodexThread.agentPath}'s field and must never be
   * conflated with it** — that is the top-level key, this is the spawn
   * record's own, and on a v1 subagent they disagree exactly (absent against
   * present-and-null). Carrying both, under names that cannot be mistaken
   * for one another, is what stops the confusion recurring.
   *
   * Carried because the golden reproduces it: an exclusion may not hide a key
   * that carries TOPOLOGY (Amendment 2026-09-03), and `parent_thread_id`
   * inside this record plainly does.
   *
   * `present: false` on every root thread — a root was not spawned.
   */
  readonly threadSpawn: {
    readonly present: boolean;
    readonly agentPath: CodexOptional<string>;
    readonly agentNickname: CodexOptional<string>;
    readonly agentRole: CodexOptional<string>;
    readonly parentThreadId: CodexOptional<string>;
    readonly depth: CodexOptional<number>;
  };
  readonly counters: CodexCounters;
  readonly records: number;
  /**
   * When the thread STARTED, from the `session_meta` record's own
   * `timestamp` at ordinal 0.
   *
   * **Added because `mtimeMs` is an END and was about to be used as a
   * START.** `AgentNode.startedAt` is required, `CodexThread` carried no
   * start, and the only time available was the file's last-write — so the
   * grafter defaulted to it, said so at the seam, and reported the gap
   * rather than letting a plausible wrong number through. On the corpus's
   * baseline root those two differ by 40 seconds (20:43:54 against
   * 20:44:34), and on a long session they differ by its whole duration.
   *
   * Required, not optional: the fingerprint already refuses a thread with
   * no `session_meta` at ordinal 0, so this value always exists — and a
   * required field breaks every producer at compile time rather than
   * letting one quietly omit it and fall back to the end time again.
   */
  readonly startedAtMs: number;
  /** Last write to the owning file. An END. Liveness corroboration only. */
  readonly mtimeMs: number;
}

// ===========================================================================
// P4 — liveness.ts  (DoD 2.5)
// ===========================================================================

/**
 * D0.1, and every word of it is load-bearing:
 *
 *   > An agent is dead when its writer lock is GONE **and** no hook event has
 *   > arrived within `livenessThresholdMs`. `SubagentStop` only clears
 *   > "in flight"; it NEVER marks dead.
 *
 * Two measured facts force that shape, and a test exists for each:
 *
 *  - `SubagentStop` fires per TURN. One agent produced two, on two
 *    `turn_id`s — it stopped, was resumed to report on a child, and stopped
 *    again. Marking dead on `SubagentStop` KILLS A LIVE AGENT.
 *  - `SubagentStart` may never arrive. Liveness must never REQUIRE it.
 *    (`docs/codex-contract.md` A2 re-measured this and the Phase 0 absence did
 *    not reproduce — which retires the observation, not the rule.)
 */
export type CodexAgentLiveness = 'live' | 'idle' | 'dead' | 'unknown';

/** Why liveness fell back off the hook tap. Surfaced, never swallowed. */
export type CodexLivenessDegradation =
  | 'noHookEvents'
  | 'lockDirMissing'
  | 'mtimeOnly';

export interface CodexLiveness {
  readonly threadId: string;
  readonly state: CodexAgentLiveness;
  /** A lock is EVIDENCE OF LIFE, NOT PROOF (C6) — corroborated by mtime. */
  readonly lockPresent: boolean;
  readonly lastHookEventMs: number | null;
  readonly lastMtimeMs: number | null;
  readonly inFlight: boolean;
  readonly degraded?: CodexLivenessDegradation;
}

/**
 * The clock is INJECTED, exactly as `src/opencode/liveness.ts` injects its
 * own. A module that reads `Date.now()` internally cannot have the D0.1
 * threshold tested without sleeping, and a test that sleeps is a test that
 * fails under load.
 *
 * **The POLL TRIGGER is deliberately not here, and this comment used to say
 * it was.** P5 reported the mismatch rather than editing the hand-off line to
 * match its own implementation, which is what a worker is asked to do.
 *
 * The reason it stays out: these two fields are what the PURE RENDER PATH
 * needs — given a clock and a threshold, a set of hook records and locks
 * reduces to a `CodexLiveness` with no other input. A trigger belongs to the
 * POLLING ENGINE that wraps that path, so `liveness.ts` declares it and
 * composes it on top. Putting it here would oblige every caller of the pure
 * function to supply something it never uses.
 */
export interface CodexLivenessDeps {
  readonly now: () => number;
  readonly livenessThresholdMs: number;
}

// ===========================================================================
// P5 — graft.ts  (DoD 2.4, 2.6)
// ===========================================================================

/**
 * G3 park codes. A parked child is ABSENT FROM THE TREE ON PURPOSE and
 * reaches the webview through `SessionState.parked`.
 *
 * **`dialectV1` is a TRIPWIRE, not a routine state** (spec C3a, PLAN
 * Amendment 2026-09-03 corrected the same day). It parks a child carrying
 * NEITHER join key. On the measured corpus it fires ZERO TIMES, and a test
 * asserts that zero — a tripwire that fires routinely is not a tripwire.
 *
 * The history here is the reason the comment is this long: an earlier ruling
 * parked the whole `v1` dialect with no filament, on the premise that a `v1`
 * child "cannot be grafted — there is no `task_name` to join on". The premise
 * was false. `task_name` is absent; THE JOIN IS NOT. "I did not find a join"
 * had been written down as "there is no join", and it nearly cost the product
 * a working feature for an entire class of user. **Phase 2 should distrust
 * anything asserted from an absence.**
 */
export type CodexParkCode =
  | 'dialectV1'
  | 'noAgentPath'
  | 'orphanSpawn'
  | 'duplicateAgentPath'
  | 'forkBoundaryMissing'
  /**
   * A subagent whose `parent_thread_id` names a thread that is not there,
   * and a subagent whose parent itself parked.
   *
   * **These two were not in `PLAN.md`'s answered list**, which named five
   * codes, all describing the SPAWN side. P4 found two child-side cases the
   * five have no word for, mapped both onto `orphanSpawn`, documented the
   * stretch and asked for it to be reviewed — which is the right way to
   * surface a vocabulary gap.
   *
   * The review's answer is that no new vocabulary is needed: **the wire
   * union already carries both words.** `parentAgentMissing` and
   * `parentNotGrafted` are existing Claude Code codes meaning precisely
   * these two situations, already rendered by the webview. Reusing them
   * adds nothing a user must learn and stops two distinct stories being
   * told under one name — the same distinction `taskWithoutChild` and
   * `joinKeyContradiction` already draw for OpenCode, and for the reason
   * recorded there: a user reading the wrong code goes looking for the
   * wrong problem.
   */
  | 'parentAgentMissing'
  | 'parentNotGrafted';

// ===========================================================================
// P6 — index.ts, `readCodexEngine()`  (DoD 2.7)
// ===========================================================================

export interface CodexEngineOptions {
  /** Overrides `$CODEX_HOME` / `~/.codex`. Tests NEVER read a live root (G6). */
  readonly root?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Matched against `session_meta.payload.cwd` (C1), as `correlate.ts` does. */
  readonly workspaceFolders?: readonly string[];
  readonly maxPayloadBytes?: number;
}

/**
 * Per-session refusal, carried rather than thrown. The OpenCode engine's
 * doc says it best: "Never thrown, always returned."
 */
export interface CodexRefusal {
  readonly sessionId: string;
  readonly file: string;
  readonly mismatch: CodexMismatch;
}

export interface CodexEngineResult {
  /** One per ROOT thread whose `cwd` matched. Tagged `engine: 'codex'` (C11). */
  readonly sessions: readonly SessionState[];
  /** Every thread parsed, root and subagent, for the golden and diagnostics. */
  readonly threads: readonly CodexThread[];
  readonly refused: readonly CodexRefusal[];
  /**
   * Every spawn-to-child join the grafter resolved, or failed to.
   *
   * `graft.ts` has always computed these; the engine did not pass them on,
   * so the golden had to EXCLUDE the join — the single most important thing
   * DoD 2.4 is about. Amendment 2026-09-03 forbids that, and this field is
   * what makes reproducing it possible.
   */
  readonly spawnJoins: readonly { readonly callId: string; readonly childThreadId: string | null; readonly resolvedBy: CodexSpawnResolution }[];
  readonly counters: CodexCounters;
  readonly discovery: CodexDiscovery;
}

/**
 * `rootAbsent` is NOT a failure. DoD 2.1: an absent root means the engine is
 * silently off, logged once at info. A machine with no Codex installed must
 * not produce a diagnostic every poll.
 */
export type CodexEngineOutcome =
  | { readonly kind: 'ok'; readonly result: CodexEngineResult }
  | { readonly kind: 'rootAbsent'; readonly root: string }
  | { readonly kind: 'unreadable'; readonly root: string; readonly reason: string };
