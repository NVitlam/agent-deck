/**
 * Agent Deck — liveness engine (spec v2 §C4).
 *
 * Answers "what is running right now" from the hook tap, supplemented — never
 * replaced — by JSONL inference. It consumes {@link NormalizedHookEvent}
 * values produced by `src/hooks/listener.ts` and owns no socket, no file
 * handle and no timer of its own.
 *
 * ---------------------------------------------------------------------------
 * G2: why this file imports nothing from `src/parser/`
 * ---------------------------------------------------------------------------
 * Liveness is the half of the product that must survive schema drift. It
 * therefore has NO structural dependency on the parser: its only imports are
 * type-only, from `events.ts` (pure types) and `../hooks/listener.js`. JSONL
 * inference reaches this module through the {@link JsonlInferenceSource}
 * callback the caller injects, and every call to it is wrapped — a source
 * that throws increments {@link LivenessCounters.inferenceFailures} and the
 * engine keeps answering from hook events alone. Marking a session
 * `unsupported` likewise does not stop hook ingestion: the underlying agent
 * statuses keep updating, so the moment the schema question is resolved the
 * state is already correct.
 *
 * ---------------------------------------------------------------------------
 * Thread attribution
 * ---------------------------------------------------------------------------
 * The main thread is identified by the ABSENCE of the `agent_id` key, never by
 * a sentinel id. CC omits the key on main-thread events; the literal `"main"`
 * has never appeared in any capture. This engine therefore never uses an agent
 * id for the main thread at all: the main agent lives in its own field
 * ({@link SessionLivenessSnapshot.main}) and the subagent map is keyed only by
 * real ids, so no collision and no sentinel is possible. Attribution is read
 * from {@link NormalizedHookEvent.isMainThread}, which the listener derived
 * with `hasOwnProperty` — it is never re-derived from the raw payload here.
 *
 * Measured on the pinned CC 2.1.234 capture in `fixtures/hook-events/`:
 * `Stop` omits `agent_id`, `SubagentStop` carries it, `SubagentStart` carries
 * it but carries NO `tool_use_id`. A subagent's parent `tool_use` block is
 * therefore NOT recoverable from hooks; that join is the JSONL sidecar's
 * `meta.toolUseId`. This engine never attempts to graft.
 *
 * ---------------------------------------------------------------------------
 * State transitions
 * ---------------------------------------------------------------------------
 * Two independent binary signals decide session liveness:
 *
 *   running  — something is believed to be executing (see below)
 *   recent   — last observed activity is within the mtime threshold
 *              (default {@link DEFAULT_MTIME_THRESHOLD_MS} = 120_000 ms)
 *
 *                  | recent   | stale
 *      ------------+----------+---------
 *      running     | 'live'   | 'idle'
 *      not running | 'idle'   | 'ended'
 *
 * Both good => `live`; both bad => `ended`; disagreement => `idle`, because a
 * disagreement is exactly the case where claiming either extreme would be a
 * guess. `unsupported` is never inferred — it is asserted from outside via
 * {@link LivenessEngine.setSchemaSupported} and overrides the table.
 *
 * `running` is decided by the hook tap when this session has ever produced a
 * hook event: true iff the main agent or any subagent is `'running'`. With no
 * hook events for the session it falls back to JSONL inference — "absence of a
 * Stop entry means still running" (spec §C4) — and to `true` when inference
 * cannot say, since "we cannot see" is not evidence of an ending.
 *
 * `recent` uses the LATER of the last hook event and the transcript mtime, so
 * a long tool call that appends nothing still counts as activity if hooks are
 * flowing, and a session with no hooks at all still ages out on mtime.
 *
 * Per agent:
 *   - any event for an agent (main or subagent) marks it `'running'`; this is
 *     also how a new turn after a `Stop` re-opens the main agent.
 *   - `Stop` (no `agent_id`) ends the MAIN agent only.
 *   - `SubagentStop` (with `agent_id`) ends THAT subagent only.
 *   - `SessionStart` is treated as an ordinary touch. It is NEVER required:
 *     any event creates the session with a running main agent, which is why a
 *     stream beginning at `PreToolUse` still becomes `live`.
 *   - `'error'` is never produced here. No hook event carries a failure signal
 *     in the pinned capture; error status belongs to the content side.
 *
 * A terminal event (`Stop` / `SubagentStop`) for a session or agent this
 * engine has never seen does NOT create one — it would invent a thing whose
 * only known property is that it is over. Such events are counted in
 * {@link LivenessCounters.eventsSkippedOrphanTerminal} and dropped.
 *
 * G3: {@link LivenessEngine.ingest} never throws. Malformed, session-less and
 * unknown-name events are counted and skipped. G7: all state is in-memory and
 * dies with the instance.
 */

import type { AgentNode, NormalizedHookEvent, SessionState } from './events.js';
import { KNOWN_HOOK_EVENT_NAMES } from './events.js';
import type { HookEventHandler } from '../hooks/listener.js';

/** The session-level liveness value rendered by the UI (spec v2 §6). */
export type SessionLiveness = SessionState['liveness'];

/** The per-agent status value (spec v2 §6). */
export type AgentStatus = AgentNode['status'];

/**
 * Default mtime recency threshold, in milliseconds.
 *
 * 120 s, configurable via {@link LivenessEngineOptions.mtimeThresholdMs}.
 * Deliberately not lower: a single long tool call appends nothing for its
 * duration, so a ~60 s threshold makes a healthy session flap
 * live -> idle -> live. Phase 4 tunes this against a perf harvest.
 */
export const DEFAULT_MTIME_THRESHOLD_MS = 120_000;

/** Why the engine considers itself degraded. */
export type DegradedReason = 'noHookEvents' | 'listenerDown';

/**
 * What the JSONL side can tell liveness. Deliberately tiny: two facts, both
 * optional, neither able to break the hook path.
 */
export interface JsonlInference {
  /** Transcript mtime in epoch ms. */
  mtimeMs?: number;
  /**
   * Whether a Stop entry has been seen in the transcript. `false` means
   * "looked, none found"; omit it entirely for "cannot say".
   */
  hasStopEntry?: boolean;
}

/**
 * Pull-side inference. Called on read, inside a try/catch — throwing is a
 * supported outcome and degrades to hooks-only (G2).
 */
export type JsonlInferenceSource = (
  sessionId: string,
) => JsonlInference | undefined;

export interface LivenessEngineOptions {
  /** Injected clock. Defaults to `Date.now`. Tests must inject, never sleep. */
  now?: () => number;
  /** Defaults to {@link DEFAULT_MTIME_THRESHOLD_MS}. */
  mtimeThresholdMs?: number;
  /** Optional pull-side JSONL inference. */
  inferenceSource?: JsonlInferenceSource;
  /**
   * Whether a hook listener is believed to be bound. Defaults to `true`; the
   * engine does not probe, it is told. Setting it false forces degraded.
   */
  hookListenerRunning?: boolean;
}

export interface LivenessCounters {
  /** Every event handed to {@link LivenessEngine.ingest}. */
  eventsReceived: number;
  /** Events that reached the state machine. */
  eventsApplied: number;
  /** `hook_event_name` outside {@link KNOWN_HOOK_EVENT_NAMES}, or absent. */
  eventsSkippedUnknownName: number;
  /** No usable `session_id`. */
  eventsSkippedNoSession: number;
  /** `Stop`/`SubagentStop` for a session or agent never seen. */
  eventsSkippedOrphanTerminal: number;
  /**
   * The `agent_id` key was present but unusable (null, empty, not a string).
   * Not main-thread, not attributable to a subagent — promoting it to main
   * would be the guess G3 forbids. Never observed from real CC.
   */
  eventsSkippedUnattributable: number;
  /**
   * Known but not measured on the pinned CC version. ZERO IS THE NORMAL
   * READING: {@link UNCONFIRMED_KNOWN_HOOK_EVENT_NAMES} is empty, so nothing
   * CC currently sends increments this. It exists to surface a name that was
   * registered and never observed — a drift signal. `SessionStart` used to
   * live here and no longer does: it was confirmed by measurement (see the
   * note on {@link CONFIRMED_HOOK_EVENT_NAMES}), and leaving it unconfirmed
   * would have made this counter climb on every normal session, which is how
   * a diagnostic gets ignored.
   */
  unconfirmedNameEvents: number;
  /** A {@link JsonlInferenceSource} call threw. */
  inferenceFailures: number;
  /** An unexpected throw inside ingest. Stays 0; exists so it cannot crash. */
  ingestErrors: number;
}

export interface AgentLivenessSnapshot {
  /**
   * The subagent join key. OMITTED for the main thread — there is no id for
   * it and none is invented. Test {@link isMainThread}, never a string.
   */
  agentId?: string;
  isMainThread: boolean;
  status: AgentStatus;
  /** Epoch ms of the first event attributed to this agent. */
  startedAt: number;
  /** Epoch ms of the terminal event, when one has been seen. */
  endedAt?: number;
  /** Epoch ms of the most recent event attributed to this agent. */
  lastEventAt?: number;
  /** `agent_type` when CC supplied one (SubagentStart/SubagentStop do). */
  agentType?: string;
  /** `agent_transcript_path` from SubagentStop — a direct file pointer. */
  agentTranscriptPath?: string;
  /** `tool_use_id`s seen in PreToolUse with no matching PostToolUse yet. */
  activeToolUseIds: string[];
}

export interface SessionLivenessSnapshot {
  sessionId: string;
  liveness: SessionLiveness;
  /** This session's state rests on inference alone (no hooks reaching it). */
  degraded: boolean;
  degradedReason?: DegradedReason;
  /** False once {@link LivenessEngine.setSchemaSupported} says so. */
  schemaSupported: boolean;
  hookEventCount: number;
  lastHookEventAt?: number;
  /** Later of {@link lastHookEventAt} and the inferred mtime. */
  lastActivityAt?: number;
  mtimeMs?: number;
  hasStopEntry?: boolean;
  /** False when the most recent inference attempt threw. */
  inferenceOk: boolean;
  main: AgentLivenessSnapshot;
  subagents: AgentLivenessSnapshot[];
  runningAgentCount: number;
  transcriptPath?: string;
  cwd?: string;
}

export interface DegradedState {
  degraded: boolean;
  reason?: DegradedReason;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

interface AgentRecord {
  agentId?: string;
  isMainThread: boolean;
  status: AgentStatus;
  startedAt: number;
  endedAt?: number;
  lastEventAt?: number;
  agentType?: string;
  agentTranscriptPath?: string;
  activeToolUseIds: Set<string>;
}

interface SessionRecord {
  sessionId: string;
  main: AgentRecord;
  /** Keyed by real `agent_id` only. The main thread is never in here. */
  subagents: Map<string, AgentRecord>;
  hookEventCount: number;
  lastHookEventAt?: number;
  transcriptPath?: string;
  cwd?: string;
  schemaSupported: boolean;
  /** Last value handed to {@link LivenessEngine.observeJsonl}. */
  pushedInference?: JsonlInference;
  inferenceOk: boolean;
}

const KNOWN_NAMES: ReadonlySet<string> = new Set<string>(KNOWN_HOOK_EVENT_NAMES);

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unstringifiable error';
  }
}

function newAgent(
  isMainThread: boolean,
  at: number,
  agentId?: string,
): AgentRecord {
  return {
    isMainThread,
    status: 'running',
    startedAt: at,
    activeToolUseIds: new Set<string>(),
    ...(agentId !== undefined ? { agentId } : {}),
  };
}

function snapshotAgent(agent: AgentRecord): AgentLivenessSnapshot {
  return {
    isMainThread: agent.isMainThread,
    status: agent.status,
    startedAt: agent.startedAt,
    activeToolUseIds: [...agent.activeToolUseIds],
    ...(agent.agentId !== undefined ? { agentId: agent.agentId } : {}),
    ...(agent.endedAt !== undefined ? { endedAt: agent.endedAt } : {}),
    ...(agent.lastEventAt !== undefined
      ? { lastEventAt: agent.lastEventAt }
      : {}),
    ...(agent.agentType !== undefined ? { agentType: agent.agentType } : {}),
    ...(agent.agentTranscriptPath !== undefined
      ? { agentTranscriptPath: agent.agentTranscriptPath }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

/**
 * Per-session and per-agent liveness, merged from hook events and JSONL
 * inference. One instance per extension host; in-memory only (G7).
 */
export class LivenessEngine {
  private readonly sessions = new Map<string, SessionRecord>();

  private readonly nowFn: () => number;

  private thresholdMs: number;

  private readonly inferenceSource?: JsonlInferenceSource;

  private hookListenerRunning: boolean;

  private lastFailureMessage?: string;

  private readonly counts: LivenessCounters = {
    eventsReceived: 0,
    eventsApplied: 0,
    eventsSkippedUnknownName: 0,
    eventsSkippedNoSession: 0,
    eventsSkippedOrphanTerminal: 0,
    eventsSkippedUnattributable: 0,
    unconfirmedNameEvents: 0,
    inferenceFailures: 0,
    ingestErrors: 0,
  };

  constructor(options: LivenessEngineOptions = {}) {
    this.nowFn = options.now ?? Date.now;
    this.thresholdMs = options.mtimeThresholdMs ?? DEFAULT_MTIME_THRESHOLD_MS;
    if (options.inferenceSource) this.inferenceSource = options.inferenceSource;
    this.hookListenerRunning = options.hookListenerRunning ?? true;
  }

  /**
   * Pre-bound handler, so wiring is `listener.subscribe(engine.onHookEvent)`
   * without the caller having to remember to bind.
   */
  readonly onHookEvent: HookEventHandler = (
    event: NormalizedHookEvent,
  ): void => {
    this.ingest(event);
  };

  /** Never throws (G3). Unusable events are counted and skipped. */
  ingest(event: NormalizedHookEvent): void {
    this.counts.eventsReceived += 1;
    try {
      this.apply(event);
    } catch (err) {
      this.counts.ingestErrors += 1;
      this.lastFailureMessage = errorMessage(err);
    }
  }

  ingestAll(events: Iterable<NormalizedHookEvent>): void {
    for (const event of events) this.ingest(event);
  }

  /**
   * Push-side JSONL inference. Supplement only: it can create a session record
   * (a transcript on disk with no hooks is still a session worth rendering),
   * but it never overrides hook-derived running state.
   */
  observeJsonl(sessionId: string, inference: JsonlInference): void {
    const id = optionalString(sessionId);
    if (id === undefined) return;
    const session = this.sessionRecord(id, this.nowFn());
    session.pushedInference = inference;
  }

  /**
   * Assert whether the session's schema is supported. `false` renders
   * `unsupported` and is NEVER inferred here — G3 refusal is the parser's
   * call. Hook ingestion continues underneath regardless (G2).
   */
  setSchemaSupported(sessionId: string, supported: boolean): void {
    const id = optionalString(sessionId);
    if (id === undefined) return;
    const session = this.sessions.get(id);
    if (session === undefined) return;
    session.schemaSupported = supported;
  }

  /** Tell the engine whether a listener is bound. Forces degraded when false. */
  setHookListenerRunning(running: boolean): void {
    this.hookListenerRunning = running;
  }

  /** Runtime-configurable mtime threshold (VS Code setting changes). */
  setMtimeThresholdMs(ms: number): void {
    const value = finiteNumber(ms);
    if (value === undefined || value < 0) return;
    this.thresholdMs = value;
  }

  get mtimeThresholdMs(): number {
    return this.thresholdMs;
  }

  /**
   * Degraded exactly when no hook events have ever arrived, or the listener is
   * known to be down. Explicit and truthful; the banner is the UI's problem.
   */
  degradedState(): DegradedState {
    if (!this.hookListenerRunning) {
      return { degraded: true, reason: 'listenerDown' };
    }
    if (this.counts.eventsReceived === 0) {
      return { degraded: true, reason: 'noHookEvents' };
    }
    return { degraded: false };
  }

  isDegraded(): boolean {
    return this.degradedState().degraded;
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  counters(): LivenessCounters {
    return { ...this.counts };
  }

  /** Message of the most recent inference or ingest failure, if any. */
  lastFailure(): string | undefined {
    return this.lastFailureMessage;
  }

  snapshot(sessionId: string): SessionLivenessSnapshot | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return undefined;
    return this.snapshotOf(session, this.nowFn());
  }

  snapshotAll(): SessionLivenessSnapshot[] {
    const now = this.nowFn();
    return [...this.sessions.values()].map((s) => this.snapshotOf(s, now));
  }

  /** Convenience for callers that only need the enum. */
  livenessOf(sessionId: string): SessionLiveness | undefined {
    return this.snapshot(sessionId)?.liveness;
  }

  // -------------------------------------------------------------------------

  private apply(event: NormalizedHookEvent): void {
    const name = optionalString(event.eventName);
    if (name === undefined || !KNOWN_NAMES.has(name)) {
      this.counts.eventsSkippedUnknownName += 1;
      return;
    }
    if (!event.eventNameConfirmed) this.counts.unconfirmedNameEvents += 1;

    const sessionId = optionalString(event.sessionId);
    if (sessionId === undefined) {
      this.counts.eventsSkippedNoSession += 1;
      return;
    }

    // Thread attribution comes from the listener's `isMainThread` boolean,
    // never from a string comparison against the raw payload.
    if (!event.isMainThread && optionalString(event.agentId) === undefined) {
      this.counts.eventsSkippedUnattributable += 1;
      return;
    }

    const at = finiteNumber(event.receivedAt) ?? this.nowFn();
    const terminal = name === 'Stop' || name === 'SubagentStop';

    // A terminal event never conjures the thing it is ending.
    let session = this.sessions.get(sessionId);
    if (session === undefined) {
      if (terminal) {
        this.counts.eventsSkippedOrphanTerminal += 1;
        return;
      }
      session = this.sessionRecord(sessionId, at);
    }

    const agent = this.agentFor(session, event, at, terminal);
    if (agent === undefined) {
      this.counts.eventsSkippedOrphanTerminal += 1;
      return;
    }

    this.counts.eventsApplied += 1;
    session.hookEventCount += 1;
    session.lastHookEventAt =
      session.lastHookEventAt === undefined
        ? at
        : Math.max(session.lastHookEventAt, at);

    const transcriptPath = optionalString(event.transcriptPath);
    if (transcriptPath !== undefined) session.transcriptPath = transcriptPath;
    const cwd = optionalString(event.cwd);
    if (cwd !== undefined) session.cwd = cwd;

    agent.lastEventAt =
      agent.lastEventAt === undefined ? at : Math.max(agent.lastEventAt, at);

    const agentType = optionalString(event.raw['agent_type']);
    if (agentType !== undefined) agent.agentType = agentType;

    switch (name) {
      case 'Stop':
      case 'SubagentStop': {
        agent.status = 'done';
        agent.endedAt = at;
        agent.activeToolUseIds.clear();
        const path = optionalString(event.raw['agent_transcript_path']);
        if (path !== undefined) agent.agentTranscriptPath = path;
        break;
      }
      case 'PreToolUse': {
        this.reopen(agent);
        const toolUseId = optionalString(event.toolUseId);
        if (toolUseId !== undefined) agent.activeToolUseIds.add(toolUseId);
        break;
      }
      case 'PostToolUse': {
        this.reopen(agent);
        const toolUseId = optionalString(event.toolUseId);
        if (toolUseId !== undefined) agent.activeToolUseIds.delete(toolUseId);
        break;
      }
      default: {
        // SessionStart, SubagentStart, and any future known name: a touch.
        this.reopen(agent);
        break;
      }
    }
  }

  /** A non-terminal event proves the agent is alive again (a new turn). */
  private reopen(agent: AgentRecord): void {
    agent.status = 'running';
    delete agent.endedAt;
  }

  /**
   * Resolve the agent an event belongs to. Returns undefined only for a
   * terminal event naming a subagent that was never seen — which is dropped
   * rather than invented.
   */
  private agentFor(
    session: SessionRecord,
    event: NormalizedHookEvent,
    at: number,
    terminal: boolean,
  ): AgentRecord | undefined {
    if (event.isMainThread) return session.main;

    // Unusable `agent_id` was already screened out in `apply`.
    const agentId = optionalString(event.agentId);
    if (agentId === undefined) return undefined;

    const existing = session.subagents.get(agentId);
    if (existing !== undefined) return existing;
    if (terminal) return undefined;

    const created = newAgent(false, at, agentId);
    session.subagents.set(agentId, created);
    return created;
  }

  private sessionRecord(sessionId: string, at: number): SessionRecord {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionRecord = {
      sessionId,
      main: newAgent(true, at),
      subagents: new Map<string, AgentRecord>(),
      hookEventCount: 0,
      schemaSupported: true,
      inferenceOk: true,
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  /**
   * G2 boundary. Every path into JSONL inference goes through here, and a
   * throw is a counted, non-fatal outcome.
   */
  private readInference(session: SessionRecord): JsonlInference | undefined {
    if (this.inferenceSource !== undefined) {
      try {
        const result = this.inferenceSource(session.sessionId);
        session.inferenceOk = true;
        if (result !== null && typeof result === 'object') return result;
      } catch (err) {
        session.inferenceOk = false;
        this.counts.inferenceFailures += 1;
        this.lastFailureMessage = errorMessage(err);
      }
    }
    return session.pushedInference;
  }

  private snapshotOf(
    session: SessionRecord,
    now: number,
  ): SessionLivenessSnapshot {
    const inference = this.readInference(session);
    const mtimeMs = finiteNumber(inference?.mtimeMs);
    const hasStopEntry =
      typeof inference?.hasStopEntry === 'boolean'
        ? inference.hasStopEntry
        : undefined;

    const lastActivityAt = this.lastActivityAt(session, mtimeMs);
    const recent =
      lastActivityAt !== undefined && now - lastActivityAt <= this.thresholdMs;
    const running = this.isRunning(session, hasStopEntry);

    const sessionDegraded =
      !this.hookListenerRunning || session.hookEventCount === 0;
    let reason: DegradedReason | undefined;
    if (!this.hookListenerRunning) reason = 'listenerDown';
    else if (session.hookEventCount === 0) reason = 'noHookEvents';

    const subagents = [...session.subagents.values()];
    const runningAgentCount =
      (session.main.status === 'running' ? 1 : 0) +
      subagents.filter((a) => a.status === 'running').length;

    let liveness: SessionLiveness;
    if (!session.schemaSupported) {
      liveness = 'unsupported';
    } else if (running) {
      liveness = recent ? 'live' : 'idle';
    } else {
      liveness = recent ? 'idle' : 'ended';
    }

    return {
      sessionId: session.sessionId,
      liveness,
      degraded: sessionDegraded,
      schemaSupported: session.schemaSupported,
      hookEventCount: session.hookEventCount,
      inferenceOk: session.inferenceOk,
      main: snapshotAgent(session.main),
      subagents: subagents.map(snapshotAgent),
      runningAgentCount,
      ...(reason !== undefined ? { degradedReason: reason } : {}),
      ...(session.lastHookEventAt !== undefined
        ? { lastHookEventAt: session.lastHookEventAt }
        : {}),
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      ...(mtimeMs !== undefined ? { mtimeMs } : {}),
      ...(hasStopEntry !== undefined ? { hasStopEntry } : {}),
      ...(session.transcriptPath !== undefined
        ? { transcriptPath: session.transcriptPath }
        : {}),
      ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
    };
  }

  private lastActivityAt(
    session: SessionRecord,
    mtimeMs: number | undefined,
  ): number | undefined {
    if (session.lastHookEventAt === undefined) return mtimeMs;
    if (mtimeMs === undefined) return session.lastHookEventAt;
    return Math.max(session.lastHookEventAt, mtimeMs);
  }

  private isRunning(
    session: SessionRecord,
    hasStopEntry: boolean | undefined,
  ): boolean {
    if (session.hookEventCount > 0) {
      if (session.main.status === 'running') return true;
      for (const agent of session.subagents.values()) {
        if (agent.status === 'running') return true;
      }
      return false;
    }
    // No hooks for this session: spec §C4's JSONL inference, verbatim —
    // "absence of Stop entry" means still running. Unknown is not an ending.
    return hasStopEntry !== true;
  }
}
