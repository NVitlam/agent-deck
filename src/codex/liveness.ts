/**
 * Agent Deck — the Codex engine's liveness tap (`PLAN.md` v0.6.0 DoD 2.5,
 * spec C6, Phase 0 decision D0.1).
 *
 * Answers "what is running right now" for Codex threads from three sources, in
 * this order of authority:
 *
 *   1. the loopback hook tap        — PRIMARY
 *   2. `<root>/thread-writer-locks` — fallback, and D0.1's other conjunct
 *   3. the transcript's mtime       — corroboration only
 *
 * ---------------------------------------------------------------------------
 * D0.1 IS AN `AND`, AND EVERY WORD OF IT IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 *
 *   > An agent is dead when its writer lock is gone AND no hook event has
 *   > arrived within `livenessThresholdMs`. `SubagentStop` only clears
 *   > "in flight"; it never marks dead.
 *
 * Two measured facts force that shape, and there is a test for each:
 *
 *  - **`SubagentStop` fires per TURN, not once per agent.**
 *    `docs/codex-contract.md` A2: `resume-twice-v1` shows **1 start against 2
 *    stops for one agent**, on **2 distinct `turn_id`s** — the agent stopped,
 *    was resumed to report on a child, and stopped again. An engine that marks
 *    an agent dead on `SubagentStop` kills a live agent. This is the recorded
 *    Claude Code finding that `stop_reason: "end_turn"` looks like a
 *    terminator and is one per turn, arriving on the other tap.
 *  - **`SubagentStart` may never arrive.** Phase 0 saw a subagent produce a
 *    `SubagentStop` and a full transcript with no start. A2 re-measured that on
 *    a clean tap and it did NOT reproduce (9 of 9 agents that stopped also
 *    started) — which **retires the observation, not the rule**. Nothing here
 *    requires the event, and a test proves a stop-only stream still resolves.
 *
 * `SubagentStop` therefore clears {@link CodexLiveness.inFlight} and touches
 * {@link CodexLiveness.state} not at all. Same for `Stop` and `SessionEnd`.
 *
 * ---------------------------------------------------------------------------
 * THE STATE TABLE, WHICH IS THE WHOLE MODULE
 * ---------------------------------------------------------------------------
 *
 * ```
 * hookRecent   last hook event for this thread within livenessThresholdMs
 * hookSeen     any hook event for this thread, at any age
 * lockKnown    the writer-lock directory was there and was read
 * lockPresent  lockKnown and <threadId>.lock was among its entries
 * mtimeRecent  the owning transcript was written within livenessThresholdMs
 *
 * 1  hookRecent            -> live     degraded: none
 * 2  !lockKnown            -> idle if mtimeRecent else unknown
 *                                      degraded: mtimeOnly | lockDirMissing
 * 3  lockPresent           -> idle     degraded: noHookEvents if !hookSeen
 * 4  otherwise (lock gone) -> DEAD     degraded: noHookEvents if !hookSeen
 * ```
 *
 * Row 4 is D0.1 and it is reached only when **both** conjuncts hold: the lock
 * is gone (row 2 has already taken the case where we could not tell) and no
 * hook event arrived inside the window (row 1 has already taken the other).
 *
 * **`mtimeRecent` is deliberately NOT a third disjunct against death.** Spec
 * C6 says a lock is "evidence of life, not proof — it is corroborated by
 * transcript mtime": corroboration confirms life, it does not create it.
 * Making a recent write veto row 4 would (a) add a term D0.1 does not have,
 * (b) make a hookless, lockless thread with one recent write immortal, and
 * (c) weaken the `AND`-to-`OR` mutation this module's tests exist to catch.
 * mtime decides only where D0.1 cannot be evaluated at all (row 2).
 *
 * ---------------------------------------------------------------------------
 * A DEGRADED STATE THAT DOES NOT SAY IT IS DEGRADED IS THE SILENT-SKIP CLASS
 * ---------------------------------------------------------------------------
 * Working-method rule 18. Every row above that did not decide on the primary
 * tap carries a {@link CodexLivenessDegradation}, and the three codes are
 * assigned in a fixed priority so one value can name the most specific thing
 * that was unavailable:
 *
 *   `mtimeOnly`      no hook events AND no lock information, but an mtime; the
 *                    transcript's mtime was the only evidence there was.
 *   `lockDirMissing` the writer-lock directory was absent or unreadable, so
 *                    D0.1's lock conjunct could not be evaluated.
 *   `noHookEvents`   the primary tap said nothing about this thread; the lock
 *                    scan decided the state.
 *
 * The lock scan reports its own skips the same way
 * ({@link CodexLockScan.skipped}): a name it declined to read as a thread id
 * travels with the reason it declined.
 *
 * ---------------------------------------------------------------------------
 * `.coordination.lock` IS NOT A THREAD
 * ---------------------------------------------------------------------------
 * Spec C1 lists it beside the thread locks and says so outright; the contract
 * measures it present at process exit on 6 of 6 runs while every thread lock
 * was gone. A scan that reads it as a thread id invents a live agent named
 * `.coordination` that never existed — and it would be live forever, because
 * that file outlives every thread.
 *
 * ---------------------------------------------------------------------------
 * ABSENCE OF `agent_id` IS THE SIGNAL (spec C11)
 * ---------------------------------------------------------------------------
 * Every Codex hook event carries the ROOT thread's `session_id`, even for a
 * subagent's own tool calls, and a main-thread event **omits `agent_id`
 * entirely** rather than sending a sentinel. A correlator matching a literal
 * `"main"` drops every root event — the rule this repository already shipped
 * wrong once, on Claude Code. So: `agent_id` present names the thread;
 * `agent_id` absent means the event belongs to the root thread, whose id is
 * `session_id`. Measured over the committed corpus's 110 records: **53 carry
 * `agent_id`, 57 do not**, and the literal string `"main"` occurs zero times.
 * The test re-derives all three from the corpus rather than reading them here.
 *
 * ---------------------------------------------------------------------------
 * THE JOIN IS OVER THE UNION OF TWO ID NAMESPACES (spec C4)
 * ---------------------------------------------------------------------------
 * A hook payload's `tool_use_id` resolves against
 * `response_item.payload.call_id` (always `call_…`) **or**
 * `event_msg.payload.item.id` (`exec-<uuid>` for a shell command), and the tap
 * reports the ITEM id. An engine joining on `call_id` alone silently drops
 * every shell call. {@link joinCodexHookToolIds} indexes both and reports the
 * three counts so a caller can see the gap rather than infer it; the test
 * derives them from the corpus and asserts the relation rather than pinning
 * numbers from a document.
 *
 * `ToolNode.id` cannot carry the second id — it has one id field — so this
 * join is done here, against {@link CodexToolCall}, and never through the tree.
 *
 * ---------------------------------------------------------------------------
 * NO CLOCK AND NO TIMER LIVE IN THIS FILE
 * ---------------------------------------------------------------------------
 * `now` and the poll trigger are injected, exactly as `src/opencode/
 * liveness.ts` injects them and for the same recorded reason: a threshold test
 * that sleeps measures the machine it ran on and fails under load. There is no
 * `Date.now()`, no `setInterval` and no `setTimeout` below this comment.
 * {@link CodexLivenessDeps} in `types.ts` is the injection point for the first
 * two; {@link CodexPollTrigger} is the third, and it is declared here because
 * the hand-off line does not declare it and no work package may edit that file.
 *
 * G1: this module never writes. It reads directory ENTRIES from the lock
 * directory and never opens a lock file — the files are 0 bytes and their name
 * is the whole payload. G5: no sockets; hook events arrive from the loopback
 * listener the host already owns.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type {
  CodexLiveness,
  CodexLivenessDegradation,
  CodexLivenessDeps,
  CodexToolCall,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Suffix of a writer-lock file. The stem is the thread id, exactly (§7). */
export const CODEX_LOCK_SUFFIX = '.lock';

/**
 * The one entry in the writer-lock directory that is NOT a thread.
 *
 * Named as a constant rather than filtered by a leading-dot rule alone,
 * because the two checks fail differently: the constant is what the spec
 * writes down, and the dot rule is what catches a sibling nobody has met yet.
 * Both run, and each records its own skip reason.
 */
export const CODEX_COORDINATION_LOCK_NAME = '.coordination.lock';

/**
 * Matches `src/model/liveness.ts`'s 120 s mtime threshold and
 * {@link DEFAULT_OC_LIVENESS_THRESHOLD_MS}'s value in the OpenCode engine. A
 * default, never a policy: {@link CodexLivenessDeps.livenessThresholdMs} is
 * required, so nothing reaches the rule without a caller having chosen.
 */
export const DEFAULT_CODEX_LIVENESS_THRESHOLD_MS = 120_000;

/** Default cadence for {@link CodexLivenessEngine}, when a trigger is given. */
export const DEFAULT_CODEX_POLL_INTERVAL_MS = 1000;

/**
 * Hook events that clear "in flight" and mark NOTHING dead.
 *
 * All three are per-TURN terminators, not per-agent ones. `SubagentStop` is
 * the measured case (2 stops, 1 agent, 2 turn ids); `Stop` is its main-thread
 * twin and the corpus shows one per run at the end of a turn; `SessionEnd` is
 * registered in `hooks.json` and did not fire in the committed streams, so it
 * is handled by the same rule rather than by a guess about what it means.
 */
export const CODEX_IN_FLIGHT_CLEARING_EVENTS: ReadonlySet<string> = new Set([
  'SubagentStop',
  'Stop',
  'SessionEnd',
]);

// ---------------------------------------------------------------------------
// The hook tap's input
// ---------------------------------------------------------------------------

/**
 * One hook event as this module consumes it: **the engine's own payload, plus
 * the arrival time the listener stamped on it.**
 *
 * The split is deliberate and it is the trap this file was warned about. A
 * captured stream nests two layers — the listener's envelope
 * (`seq`, `receivedAt`, `eventName`, `sessionId`, `agentId`, `isMainThread`,
 * `toolUseId`, `raw`) around the engine's payload (`raw`). Every identity fact
 * belongs to the payload and every derived convenience field on the envelope is
 * the CAPTURE's opinion of it. Reading identity off the envelope gets the right
 * answer on this corpus — the two agree on 110 of 110 records, measured — and
 * gets it by trusting a script instead of the engine.
 *
 * The time is the exception, and it is an exception on the merits: Codex hook
 * payloads carry **no timestamp of any kind** (census over the corpus: 18
 * distinct payload keys, none of them a time), so arrival time is a genuine
 * property of the envelope. "No hook event has ARRIVED within the threshold"
 * is a statement about receipt, which is what the listener stamps.
 */
export interface CodexHookEvent {
  /** When the loopback listener received the POST, epoch ms. */
  readonly receivedAtMs: number;
  /** The engine's hook payload, verbatim. Never trusted to be an object. */
  readonly payload: unknown;
}

/** Why {@link readCodexHookStream} did not turn a line into an event. */
export interface CodexHookSkip {
  readonly line: number;
  readonly reason: 'malformedJson' | 'notAnObject' | 'noPayload' | 'noReceivedAt';
}

export interface CodexHookRead {
  readonly events: readonly CodexHookEvent[];
  /** Lines that did not parse as JSON. Counted and skipped, never thrown (G3). */
  readonly malformedLines: number;
  /**
   * Records whose envelope contradicted its own payload on `session_id`,
   * `agent_id` or `tool_use_id`.
   *
   * Zero on the committed corpus, and the count exists because "they agree"
   * is only worth anything if disagreement is visible. `capture-codex.mjs`
   * treats a disagreement between two signals as a hard error rather than a
   * tiebreak, for the recorded reason: a disagreement means an assumption
   * moved, and picking a winner buries that. A READER may not throw (G3), so
   * it counts, and the payload always wins.
   */
  readonly envelopeDisagreements: number;
  readonly skipped: readonly CodexHookSkip[];
}

/**
 * Read a captured or replayed listener stream into {@link CodexHookEvent}s.
 *
 * One JSON object per line, the listener's envelope form. Never throws: a
 * malformed line is counted and skipped, which is G3 applied to the tap that
 * G2 says must not be able to take content parsing down with it.
 */
export function readCodexHookStream(text: string): CodexHookRead {
  const events: CodexHookEvent[] = [];
  const skipped: CodexHookSkip[] = [];
  let malformedLines = 0;
  let envelopeDisagreements = 0;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const trimmed = raw.replace(/\r$/, '').trim();
    if (trimmed === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformedLines += 1;
      skipped.push({ line: i + 1, reason: 'malformedJson' });
      continue;
    }

    const envelope = asObject(parsed);
    if (envelope === null) {
      skipped.push({ line: i + 1, reason: 'notAnObject' });
      continue;
    }
    const payload = asObject(envelope['raw']);
    if (payload === null) {
      skipped.push({ line: i + 1, reason: 'noPayload' });
      continue;
    }
    const receivedAtMs = envelope['receivedAt'];
    if (typeof receivedAtMs !== 'number' || !Number.isFinite(receivedAtMs)) {
      skipped.push({ line: i + 1, reason: 'noReceivedAt' });
      continue;
    }

    if (
      disagrees(envelope['sessionId'], payload['session_id']) ||
      disagrees(envelope['agentId'], payload['agent_id']) ||
      disagrees(envelope['toolUseId'], payload['tool_use_id'])
    ) {
      envelopeDisagreements += 1;
    }

    events.push({ receivedAtMs, payload });
  }

  return { events, malformedLines, envelopeDisagreements, skipped };
}

/** `undefined` and an absent key are the same claim here; anything else must match. */
function disagrees(envelopeValue: unknown, payloadValue: unknown): boolean {
  const a = envelopeValue === undefined ? null : envelopeValue;
  const b = payloadValue === undefined ? null : payloadValue;
  return a !== b;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

// ---------------------------------------------------------------------------
// The writer-lock scan
// ---------------------------------------------------------------------------

/** A directory entry the scan declined to read as a thread lock, and why. */
export interface CodexLockScanSkip {
  readonly name: string;
  readonly reason: 'coordinationLock' | 'dotFile' | 'notALockFile' | 'notAFile';
}

export interface CodexLockScan {
  readonly dir: string;
  /** The directory was there and was read. `false` degrades, never refuses. */
  readonly exists: boolean;
  /** One id per `<thread-uuid>.lock`, in directory order. */
  readonly threadIds: readonly string[];
  /** Rule 18: every entry NOT counted is named with its reason. */
  readonly skipped: readonly CodexLockScanSkip[];
  /** The readdir failure, if any. Recorded rather than thrown. */
  readonly error: string | null;
}

/**
 * A directory entry, as narrow as this scan needs. Structurally satisfied by
 * `fs.Dirent`, and the same seam shape `locate.ts` uses — injected so a test
 * can assert what was handed to the filesystem, which is an enforcement of
 * "the lock FILES are never opened" rather than a proxy for it.
 */
export interface CodexLockDirent {
  name: string;
  isFile(): boolean;
}

export interface CodexLockFs {
  readdirSync(path: string): CodexLockDirent[];
}

const nodeLockFs: CodexLockFs = {
  readdirSync: (path) => readdirSync(path, { withFileTypes: true }),
};

/**
 * List the live threads according to `<root>/thread-writer-locks`.
 *
 * The contract's §7 measurement is what this rests on: a lock file's name IS a
 * thread id (14 of 14 named for a `session_meta.id`), it appears near thread
 * start and is removed at thread end (14 of 14 gone at process exit), and
 * Codex clears stale locks from previous runs at startup. What it does NOT
 * establish is whether a lock survives a hard kill — hence "evidence of life,
 * not proof", and hence D0.1 needing the hook conjunct as well.
 *
 * Never throws. A missing directory is `exists: false`, which degrades
 * liveness with {@link CodexLivenessDegradation} rather than refusing anything.
 */
export function scanCodexWriterLocks(dir: string, fs: CodexLockFs = nodeLockFs): CodexLockScan {
  let entries: CodexLockDirent[];
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    return {
      dir,
      exists: false,
      threadIds: [],
      skipped: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const threadIds: string[] = [];
  const skipped: CodexLockScanSkip[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name === CODEX_COORDINATION_LOCK_NAME) {
      skipped.push({ name, reason: 'coordinationLock' });
      continue;
    }
    if (name.startsWith('.')) {
      skipped.push({ name, reason: 'dotFile' });
      continue;
    }
    if (!name.endsWith(CODEX_LOCK_SUFFIX) || name.length === CODEX_LOCK_SUFFIX.length) {
      skipped.push({ name, reason: 'notALockFile' });
      continue;
    }
    if (!entry.isFile()) {
      skipped.push({ name, reason: 'notAFile' });
      continue;
    }
    threadIds.push(name.slice(0, name.length - CODEX_LOCK_SUFFIX.length));
  }

  return { dir, exists: true, threadIds, skipped, error: null };
}

/** `<root>/thread-writer-locks` for a discovery's `lockDir`, scanned. */
export function scanCodexWriterLocksIn(root: string, lockDirName: string): CodexLockScan {
  return scanCodexWriterLocks(join(root, lockDirName));
}

/**
 * `statSync().mtimeMs` for a transcript, or `null` if it cannot be read.
 *
 * The mtime is an END — the file's last write — and is corroboration only. It
 * is never a start: `CodexThread.startedAtMs` exists in `types.ts` precisely
 * because the grafter was once about to default a start to this number.
 */
export function readTranscriptMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The hook join (spec C4)
// ---------------------------------------------------------------------------

/**
 * Both id namespaces a hook `tool_use_id` may land in, for one tool call:
 * `callId` always, `itemId` when the call had an `event_msg` item.
 */
export function codexHookJoinKeys(call: CodexToolCall): readonly string[] {
  const keys = [call.callId];
  if (call.itemId !== null && call.itemId !== call.callId) keys.push(call.itemId);
  return keys;
}

/** Index every tool call under BOTH of its ids. The union, never one of them. */
export function buildCodexToolCallIndex(
  calls: readonly CodexToolCall[],
): ReadonlyMap<string, CodexToolCall> {
  const index = new Map<string, CodexToolCall>();
  for (const call of calls) {
    for (const key of codexHookJoinKeys(call)) {
      if (key !== '') index.set(key, call);
    }
  }
  return index;
}

/**
 * How a corpus of hook events resolves against a corpus of tool calls, counted
 * three ways so the gap between them is visible rather than inferred.
 *
 * `resolvedUnion` is what the engine does. `resolvedByCallId` is what an engine
 * that reached for the obvious field would do, and the difference between the
 * two is the shell calls it would have dropped.
 */
export interface CodexHookJoinCounters {
  /** Hook records carrying a `tool_use_id` at all. */
  readonly hookIdsSeen: number;
  readonly resolvedUnion: number;
  readonly resolvedByCallId: number;
  readonly resolvedByItemId: number;
  readonly unresolved: number;
}

export function joinCodexHookToolIds(
  events: readonly CodexHookEvent[],
  calls: readonly CodexToolCall[],
): CodexHookJoinCounters {
  const byCallId = new Set<string>();
  const byItemId = new Set<string>();
  for (const call of calls) {
    if (call.callId !== '') byCallId.add(call.callId);
    if (call.itemId !== null && call.itemId !== '') byItemId.add(call.itemId);
  }

  let hookIdsSeen = 0;
  let resolvedUnion = 0;
  let resolvedByCallId = 0;
  let resolvedByItemId = 0;
  for (const event of events) {
    const payload = asObject(event.payload);
    if (payload === null) continue;
    const id = nonEmptyString(payload['tool_use_id']);
    if (id === null) continue;
    hookIdsSeen += 1;
    const inCall = byCallId.has(id);
    const inItem = byItemId.has(id);
    if (inCall) resolvedByCallId += 1;
    if (inItem) resolvedByItemId += 1;
    if (inCall || inItem) resolvedUnion += 1;
  }

  return {
    hookIdsSeen,
    resolvedUnion,
    resolvedByCallId,
    resolvedByItemId,
    unresolved: hookIdsSeen - resolvedUnion,
  };
}

// ---------------------------------------------------------------------------
// The hook reduction
// ---------------------------------------------------------------------------

/**
 * What the tap knows about one thread, reduced from its events.
 *
 * Held as a reduction rather than as a retained event list so
 * {@link CodexLivenessEngine} can apply one event at a time and keep nothing
 * that grows with session length.
 */
export interface CodexThreadHookState {
  readonly threadId: string;
  /** Whether the thread was named by `agent_id` or inferred as the root (C11). */
  readonly attributedBy: 'agent_id' | 'session_id';
  readonly lastEventMs: number | null;
  readonly openToolUseIds: ReadonlySet<string>;
  readonly subagentStarts: number;
  readonly subagentStops: number;
  readonly events: number;
}

interface MutableHookState {
  threadId: string;
  attributedBy: 'agent_id' | 'session_id';
  lastEventMs: number | null;
  openToolUseIds: Set<string>;
  subagentStarts: number;
  subagentStops: number;
  events: number;
}

export interface CodexHookReduceCounters {
  readonly eventsSeen: number;
  /** Payload was not an object, or carried no `session_id`. Counted, skipped. */
  readonly eventsUnusable: number;
  /** `agent_id` present but not a non-empty string. Attributed to the root. */
  readonly agentIdMalformed: number;
  /** Events with no `agent_id` key at all — the main thread (C11). */
  readonly rootEvents: number;
  readonly agentEvents: number;
  readonly subagentStarts: number;
  readonly subagentStops: number;
}

export interface CodexHookReduction {
  readonly states: ReadonlyMap<string, CodexThreadHookState>;
  readonly counters: CodexHookReduceCounters;
}

interface MutableReduceCounters {
  eventsSeen: number;
  eventsUnusable: number;
  agentIdMalformed: number;
  rootEvents: number;
  agentEvents: number;
  subagentStarts: number;
  subagentStops: number;
}

function emptyReduceCounters(): MutableReduceCounters {
  return {
    eventsSeen: 0,
    eventsUnusable: 0,
    agentIdMalformed: 0,
    rootEvents: 0,
    agentEvents: 0,
    subagentStarts: 0,
    subagentStops: 0,
  };
}

/**
 * Fold one hook event into a thread-keyed state map.
 *
 * Attribution is C11, and absence of `agent_id` is the signal: the key present
 * names the subagent's thread, the key absent means the root, whose id is the
 * payload's `session_id`. Nothing here compares against a literal `"main"`.
 *
 * `SubagentStop` — and `Stop`, and `SessionEnd` — clear the open tool calls and
 * do not touch the state. That is the whole of D0.1's second sentence, and the
 * `resume-twice-v1` test is what holds it in place.
 */
function applyCodexHookEvent(
  states: Map<string, MutableHookState>,
  event: CodexHookEvent,
  counters: MutableReduceCounters,
): void {
  counters.eventsSeen += 1;

  const payload = asObject(event.payload);
  if (payload === null) {
    counters.eventsUnusable += 1;
    return;
  }
  const sessionId = nonEmptyString(payload['session_id']);
  if (sessionId === null) {
    counters.eventsUnusable += 1;
    return;
  }

  const hasAgentKey = 'agent_id' in payload;
  const agentId = nonEmptyString(payload['agent_id']);
  if (hasAgentKey && agentId === null) counters.agentIdMalformed += 1;

  const threadId = agentId ?? sessionId;
  const attributedBy: 'agent_id' | 'session_id' = agentId === null ? 'session_id' : 'agent_id';
  if (agentId === null) counters.rootEvents += 1;
  else counters.agentEvents += 1;

  let state = states.get(threadId);
  if (state === undefined) {
    state = {
      threadId,
      attributedBy,
      lastEventMs: null,
      openToolUseIds: new Set<string>(),
      subagentStarts: 0,
      subagentStops: 0,
      events: 0,
    };
    states.set(threadId, state);
  }

  state.events += 1;
  if (state.lastEventMs === null || event.receivedAtMs > state.lastEventMs) {
    state.lastEventMs = event.receivedAtMs;
  }

  const name = typeof payload['hook_event_name'] === 'string' ? payload['hook_event_name'] : '';
  const toolUseId = nonEmptyString(payload['tool_use_id']);

  if (name === 'PreToolUse' && toolUseId !== null) {
    state.openToolUseIds.add(toolUseId);
  } else if (name === 'PostToolUse' && toolUseId !== null) {
    state.openToolUseIds.delete(toolUseId);
  } else if (CODEX_IN_FLIGHT_CLEARING_EVENTS.has(name)) {
    // D0.1: this CLEARS IN FLIGHT and marks nothing dead. A stop is per turn.
    state.openToolUseIds.clear();
  }

  if (name === 'SubagentStart') {
    state.subagentStarts += 1;
    counters.subagentStarts += 1;
  } else if (name === 'SubagentStop') {
    state.subagentStops += 1;
    counters.subagentStops += 1;
  }
}

/** Fold a whole stream. Order-independent for `lastEventMs`, by construction. */
export function reduceCodexHookEvents(events: readonly CodexHookEvent[]): CodexHookReduction {
  const states = new Map<string, MutableHookState>();
  const counters = emptyReduceCounters();
  for (const event of events) applyCodexHookEvent(states, event, counters);
  return { states: freezeStates(states), counters };
}

function freezeStates(
  states: ReadonlyMap<string, MutableHookState>,
): ReadonlyMap<string, CodexThreadHookState> {
  const out = new Map<string, CodexThreadHookState>();
  for (const [id, s] of states) {
    out.set(id, {
      threadId: s.threadId,
      attributedBy: s.attributedBy,
      lastEventMs: s.lastEventMs,
      openToolUseIds: new Set(s.openToolUseIds),
      subagentStarts: s.subagentStarts,
      subagentStops: s.subagentStops,
      events: s.events,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/**
 * The threads liveness is asked about. A {@link CodexThread} satisfies this
 * structurally, so a caller hands the parser's output straight in.
 */
export interface CodexLivenessThread {
  readonly threadId: string;
  /** The ROOT thread's id. Equal to `threadId` on a root (C11). */
  readonly sessionId: string;
  /** The owning transcript's last write. Corroboration only, never a start. */
  readonly mtimeMs?: number | null;
}

export interface CodexLivenessInput {
  readonly threads: readonly CodexLivenessThread[];
  readonly hookEvents?: readonly CodexHookEvent[];
  /** Omitted = the lock half of D0.1 was never evaluated (`lockDirMissing`). */
  readonly lockScan?: CodexLockScan;
  /** Supplied only to compute {@link CodexLivenessReport.join}. */
  readonly toolCalls?: readonly CodexToolCall[];
}

export interface CodexLivenessCounters extends CodexHookReduceCounters {
  /** Hook states whose thread is not among {@link CodexLivenessInput.threads}. */
  readonly hookStatesWithoutThread: number;
  /** Threads the tap said nothing about; the lock or mtime decided them. */
  readonly threadsWithoutHookEvents: number;
  readonly lockDirMissing: boolean;
  /** Entries the lock scan declined to read as thread ids. */
  readonly locksSkipped: number;
  /** Lock files naming a thread that is not among the supplied threads. */
  readonly locksWithoutThread: number;
  readonly degraded: number;
  readonly dead: number;
}

export interface CodexLivenessReport {
  readonly threads: readonly CodexLiveness[];
  readonly counters: CodexLivenessCounters;
  readonly join: CodexHookJoinCounters;
}

/**
 * Apply D0.1 to every supplied thread against an already-reduced tap.
 *
 * **This is the ONLY place a `CodexLiveness` is built**, and it is exported for
 * that reason rather than for its own sake: {@link computeCodexLiveness} and
 * {@link CodexLivenessEngine} both go through it. A second loop applying the
 * same rule is this repository's recorded module-boundary defect — two
 * internally consistent implementations that disagree, with nothing failing —
 * and a liveness engine is exactly where it would not be noticed.
 *
 * Pure. `now` is a number here, taken once by the caller, so every thread in
 * one report is decided against the same instant.
 */
export function renderCodexLiveness(
  threads: readonly CodexLivenessThread[],
  states: ReadonlyMap<string, CodexThreadHookState>,
  lockScan: CodexLockScan | undefined,
  now: number,
  thresholdMs: number,
): { threads: readonly CodexLiveness[]; counters: Omit<CodexLivenessCounters, keyof CodexHookReduceCounters> } {
  const lockKnown = lockScan !== undefined && lockScan.exists && lockScan.error === null;
  const lockedThreads = new Set(lockKnown ? lockScan.threadIds : []);
  const threadIds = new Set(threads.map((t) => t.threadId));

  let threadsWithoutHookEvents = 0;
  let degraded = 0;
  let dead = 0;

  const out: CodexLiveness[] = [];
  for (const thread of threads) {
    const state = states.get(thread.threadId);
    const lastHookEventMs = state?.lastEventMs ?? null;
    const lastMtimeMs = thread.mtimeMs ?? null;
    const lockPresent = lockedThreads.has(thread.threadId);

    const hookSeen = lastHookEventMs !== null;
    const hookRecent = lastHookEventMs !== null && now - lastHookEventMs <= thresholdMs;
    const mtimeKnown = lastMtimeMs !== null;
    const mtimeRecent = lastMtimeMs !== null && now - lastMtimeMs <= thresholdMs;
    if (!hookSeen) threadsWithoutHookEvents += 1;

    const decided = decide({
      hookSeen,
      hookRecent,
      lockKnown,
      lockPresent,
      mtimeKnown,
      mtimeRecent,
    });
    if (decided.degraded !== undefined) degraded += 1;
    if (decided.state === 'dead') dead += 1;

    out.push({
      threadId: thread.threadId,
      state: decided.state,
      lockPresent,
      lastHookEventMs,
      lastMtimeMs,
      inFlight: (state?.openToolUseIds.size ?? 0) > 0,
      ...(decided.degraded === undefined ? {} : { degraded: decided.degraded }),
    });
  }

  let hookStatesWithoutThread = 0;
  for (const id of states.keys()) if (!threadIds.has(id)) hookStatesWithoutThread += 1;
  let locksWithoutThread = 0;
  for (const id of lockedThreads) if (!threadIds.has(id)) locksWithoutThread += 1;

  return {
    threads: out,
    counters: {
      hookStatesWithoutThread,
      threadsWithoutHookEvents,
      lockDirMissing: !lockKnown,
      locksSkipped: lockScan?.skipped.length ?? 0,
      locksWithoutThread,
      degraded,
      dead,
    },
  };
}

/**
 * The D0.1 rule over a whole stream in one call: reduce the tap, apply the
 * table, count the join.
 *
 * Pure: every input is a value and the only clock is
 * {@link CodexLivenessDeps.now}, called exactly once.
 */
export function computeCodexLiveness(
  input: CodexLivenessInput,
  deps: CodexLivenessDeps,
): CodexLivenessReport {
  const events = input.hookEvents ?? [];
  const reduction = reduceCodexHookEvents(events);
  const rendered = renderCodexLiveness(
    input.threads,
    reduction.states,
    input.lockScan,
    deps.now(),
    deps.livenessThresholdMs,
  );

  return {
    threads: rendered.threads,
    counters: { ...reduction.counters, ...rendered.counters },
    join: joinCodexHookToolIds(events, input.toolCalls ?? []),
  };
}

interface DecisionInput {
  readonly hookSeen: boolean;
  readonly hookRecent: boolean;
  readonly lockKnown: boolean;
  readonly lockPresent: boolean;
  /** An mtime was supplied at all — distinct from it being recent. */
  readonly mtimeKnown: boolean;
  readonly mtimeRecent: boolean;
}

interface Decision {
  readonly state: CodexLiveness['state'];
  readonly degraded: CodexLivenessDegradation | undefined;
}

/**
 * The state table, and the only place a state is chosen.
 *
 * Extracted so the four rows sit within one screen of each other and so a
 * mutation to any one of them is a one-line diff — which is what made the
 * `AND` to `OR` mutation test cheap enough to run.
 */
function decide(input: DecisionInput): Decision {
  // Row 1. The primary tap answered. Nothing is degraded.
  if (input.hookRecent) return { state: 'live', degraded: undefined };

  // Row 2. D0.1's lock conjunct could not be evaluated at all. We do not get
  // to call anything dead on half a rule, so mtime answers or nothing does.
  if (!input.lockKnown) {
    return {
      state: input.mtimeRecent ? 'idle' : 'unknown',
      // `mtimeOnly` means the mtime was the only evidence there was, so it is
      // only honest when there WAS an mtime and there were no hook events.
      // Otherwise the missing lock directory is the thing to name.
      degraded: !input.hookSeen && input.mtimeKnown ? 'mtimeOnly' : 'lockDirMissing',
    };
  }

  const degraded: CodexLivenessDegradation | undefined = input.hookSeen ? undefined : 'noHookEvents';

  // Row 3. The lock is there. Evidence of life, not proof — but D0.1 requires
  // the lock to be GONE, so this thread is not dead whatever the tap says.
  if (input.lockPresent) return { state: 'idle', degraded };

  // Row 4. D0.1, both conjuncts: the lock is gone AND no hook event arrived
  // inside the window. This is the only branch that returns 'dead'.
  return { state: 'dead', degraded };
}

// ---------------------------------------------------------------------------
// The polling seam
// ---------------------------------------------------------------------------

/** A registered poll trigger. `stop` must be idempotent. */
export interface CodexPollTriggerHandle {
  stop(): void;
}

/**
 * Registers `run` to be invoked roughly every `intervalMs`.
 *
 * Injected because no timer may live in this file: a liveness test that waits
 * on a real interval measures the machine it ran on. Tests supply a handle they
 * fire by hand. `CodexLivenessDeps` in `types.ts` declares `now` and the
 * threshold and does not declare this — and no work package may edit that
 * file — so it is declared here and composed into the engine's options.
 */
export type CodexPollTrigger = (run: () => void, intervalMs: number) => CodexPollTriggerHandle;

/** What one poll reads from the world. Everything time-varying comes in here. */
export interface CodexLivenessSample {
  readonly threads: readonly CodexLivenessThread[];
  readonly lockScan?: CodexLockScan;
  readonly toolCalls?: readonly CodexToolCall[];
}

export interface CodexLivenessEngineOptions extends CodexLivenessDeps {
  /** Read at every poll. The lock scan and the thread list both move. */
  readonly sample: () => CodexLivenessSample;
  readonly pollIntervalMs?: number;
  /** Omitted = {@link CodexLivenessEngine.start} registers nothing. */
  readonly pollTrigger?: CodexPollTrigger;
  /** Called after every poll. May throw; the throw is counted, never rethrown. */
  readonly onUpdate?: (report: CodexLivenessReport) => void;
}

/**
 * Holds the hook reduction across polls and applies D0.1 on demand.
 *
 * The hook tap is a PUSH source and the lock directory is a PULL one, so the
 * engine is both: {@link CodexLivenessEngine.ingest} folds an event as it
 * arrives, and {@link CodexLivenessEngine.poll} re-reads the locks and
 * re-applies the rule. Nothing accumulates with session length — the reduction
 * is a fixed-size record per thread plus the open tool-call ids, which a
 * `PostToolUse` removes.
 */
export class CodexLivenessEngine {
  private readonly options: CodexLivenessEngineOptions;
  private readonly states = new Map<string, MutableHookState>();
  private readonly counters = emptyReduceCounters();
  private handle: CodexPollTriggerHandle | undefined;
  private last: CodexLivenessReport | undefined;
  private updateFailures = 0;

  constructor(options: CodexLivenessEngineOptions) {
    this.options = options;
  }

  /** One hook event from the loopback listener. Never throws (G2). */
  ingest(event: CodexHookEvent): void {
    applyCodexHookEvent(this.states, event, this.counters);
  }

  /**
   * Re-read the locks and re-apply D0.1 against the reduction held so far.
   *
   * Goes through {@link renderCodexLiveness} — the same function
   * {@link computeCodexLiveness} calls — so the engine cannot drift from the
   * pure rule. The clock is read ONCE per poll, so every thread in one report
   * is decided against the same instant.
   */
  poll(): CodexLivenessReport {
    const sample = this.options.sample();
    const rendered = renderCodexLiveness(
      sample.threads,
      freezeStates(this.states),
      sample.lockScan,
      this.options.now(),
      this.options.livenessThresholdMs,
    );

    const report: CodexLivenessReport = {
      threads: rendered.threads,
      counters: { ...this.counters, ...rendered.counters },
      // The engine's events were folded by `ingest` and not retained, so a
      // join over them is not available here. It is reported as zeroes rather
      // than omitted, and `hookIdsSeen: 0` says plainly that nothing was
      // counted — a silent absence is the class rule 18 exists for.
      join: joinCodexHookToolIds([], sample.toolCalls ?? []),
    };

    this.last = report;
    if (this.options.onUpdate !== undefined) {
      try {
        this.options.onUpdate(report);
      } catch {
        this.updateFailures += 1;
      }
    }
    return report;
  }

  /** Register the trigger, if one was given, and poll once immediately. */
  start(): void {
    if (this.options.pollTrigger !== undefined && this.handle === undefined) {
      this.handle = this.options.pollTrigger(
        () => {
          this.poll();
        },
        this.options.pollIntervalMs ?? DEFAULT_CODEX_POLL_INTERVAL_MS,
      );
    }
    this.poll();
  }

  stop(): void {
    this.handle?.stop();
    this.handle = undefined;
  }

  get latest(): CodexLivenessReport | undefined {
    return this.last;
  }

  get onUpdateFailures(): number {
    return this.updateFailures;
  }
}
