/**
 * Agent Deck — domain model, extension/webview message contract, and the
 * parser-facing types.
 *
 * Types only. No I/O, no dependencies, no logic beyond runtime type guards.
 * Everything Agent Deck holds is in-memory and discarded on window close
 * (G7); nothing here describes persisted state.
 */

// ---------------------------------------------------------------------------
// (a) Domain model — session tree held in the extension host
// ---------------------------------------------------------------------------

export interface SessionState {
  sessionId: string; // <sessionId>.jsonl basename
  projectSlug: string;
  workspaceMatch: boolean;
  liveness: 'live' | 'idle' | 'ended' | 'unsupported';
  schemaOk: boolean;
  root: AgentNode;
  totals: { inputTokens: number; outputTokens: number; costUsd: number };
}

export interface AgentNode {
  id: string; // agentId from transcript, or 'root'
  kind: 'main' | 'subagent';
  label: string; // meta.agentType + meta.description
  status: 'running' | 'done' | 'error';
  spawnDepth: number; // from meta.json; 0 for main
  children: (AgentNode | ToolNode)[];
  tokens: { in: number; out: number };
  startedAt: number;
  endedAt?: number;
}

export interface ToolNode {
  id: string; // tool_use id — the graft key
  toolName: string; // 'Agent' nodes are graft points
  status: 'running' | 'done' | 'error';
  inputPreview: string; // post-redaction, truncated
  resultPreview?: string; // post-redaction; sourced from JSONL or tool-results/
  durationMs?: number;
}

/** Anything that can appear in `AgentNode.children`. */
export type TreeNode = AgentNode | ToolNode;

/**
 * Runtime discriminator for `TreeNode`.
 *
 * `ToolNode` has no `kind` field in the spec, so rather than adding one we
 * test for `AgentNode`'s `kind` discriminant. Kept as a guard function so the
 * spec'd interfaces stay untouched.
 */
export function isAgentNode(node: TreeNode): node is AgentNode {
  return (node as Partial<AgentNode>).kind !== undefined;
}

/** Inverse of {@link isAgentNode}; present so callers never negate by hand. */
export function isToolNode(node: TreeNode): node is ToolNode {
  return !isAgentNode(node);
}

// ---------------------------------------------------------------------------
// (b) Extension <-> webview message contract
// ---------------------------------------------------------------------------

/**
 * The `diff` payload shape is deliberately unspecified at Phase 1.
 * Phase 2 defines it. Do not narrow this without amending the spec.
 */
export type SessionPatch = unknown;

export interface SnapshotMessage {
  type: 'snapshot';
  sessions: SessionState[];
}

export interface DiffMessage {
  type: 'diff';
  sessionId: string;
  patch: SessionPatch;
}

export interface SchemaMismatchMessage {
  type: 'schemaMismatch';
  sessionId: string;
}

export type HostToWebviewMessage =
  | SnapshotMessage
  | DiffMessage
  | SchemaMismatchMessage;

export interface ExpandNodeMessage {
  type: 'expandNode';
  sessionId: string;
  nodeId: string;
}

export interface SelectSessionMessage {
  type: 'selectSession';
  sessionId: string;
}

export type WebviewToHostMessage = ExpandNodeMessage | SelectSessionMessage;

// ---------------------------------------------------------------------------
// (c) Parser-facing types
// ---------------------------------------------------------------------------

/**
 * A JSON value as read off disk. Used where the shape is CC's business and
 * not ours; `unknown` at the leaves keeps `any` out of exported signatures.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * One parsed JSONL line from a main or subagent transcript.
 *
 * Only `type` is present on every observed line. Re-measured after the Phase 1
 * re-harvest across all 7 committed CC 2.1.234 transcripts (124 lines):
 * `type` 124/124, and `agentId` appears on all 84 subagent lines but 0 of the
 * 40 main-transcript lines. `queue-operation` carries only
 * `type`/`operation`/`timestamp`/`sessionId`; `attachment` never carries
 * `message`; `file-history-snapshot` carries nothing beyond `type`.
 * Everything except `type` is therefore optional, and the index signature keeps
 * unknown/extra fields rather than forcing callers to strip them.
 *
 * Do not tighten this from memory — re-count against the fixtures. Requiring a
 * field that real data omits refuses valid sessions, which is worse than the
 * drift the requirement would catch.
 */
export interface TranscriptEntry {
  /** e.g. 'user', 'assistant', 'system', 'queue-operation'. Never absent. */
  type: string;
  uuid?: string;
  /** `null` on the first entry of a transcript. */
  parentUuid?: string | null;
  sessionId?: string;
  /** ISO-8601 string as written by CC. */
  timestamp?: string;
  /** CC version that wrote the line; may change mid-file. */
  version?: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  /** Present in subagent transcripts; names the agent that wrote the line. */
  agentId?: string;
  /** Narrowed by parse.ts; the raw message body is CC's schema, not ours. */
  message?: unknown;
  /** CC adds fields between versions; keep them rather than dropping them. */
  [key: string]: unknown;
}

/**
 * The `<sessionId>/subagents/agent-<agentId>.meta.json` sidecar.
 * `toolUseId` names the parent `tool_use` block — the primary key that makes
 * subagent attribution a join rather than an inference.
 */
export interface SubagentMeta {
  agentType: string;
  description: string;
  toolUseId: string;
  spawnDepth: number;
  /** Present at spawnDepth >= 2. */
  parentAgentId?: string;
  worktreePath?: string;
  spawnedWithWorktree?: boolean;
  worktreeBranch?: string;
  [key: string]: unknown;
}

/** Why a file could not be read or was skipped wholesale. */
export interface SkippedFile {
  path: string;
  reason: string;
}

/**
 * Counters the parser accumulates instead of throwing. Malformed input
 * increments a counter and is skipped; parsing never crashes on input (G3).
 */
export interface ParseDiagnostics {
  /** Lines that were not valid JSON or lacked the minimum shape. */
  malformedLines: number;
  /** Lines successfully parsed into a `TranscriptEntry`. */
  parsedLines: number;
  /** Files that could not be read or were deliberately skipped. */
  skippedFiles: SkippedFile[];
}

/** A zeroed `ParseDiagnostics`. Convenience only — no state is shared. */
export function emptyDiagnostics(): ParseDiagnostics {
  return { malformedLines: 0, parsedLines: 0, skippedFiles: [] };
}

/**
 * The refusal result. A fingerprint failure makes the session render
 * `unsupported`; it never yields a partial tree (G3). Carries enough detail
 * to say *what* did not match.
 */
export interface SchemaMismatch {
  kind: 'schemaMismatch';
  /** Human-readable explanation, e.g. "expected subagents/ directory". */
  reason: string;
  /**
   * Where the mismatch was detected: a file path, a dotted field path, or a
   * directory that was expected by the layout fingerprint.
   */
  path?: string;
  /** The field or layout element that failed, when narrower than `path`. */
  field?: string;
  /** What the fingerprint required. */
  expected?: string;
  /** What was found instead. */
  actual?: string;
  /** CC version string observed on the offending entry, when known. */
  observedVersion?: string;
}

/** Narrowing guard for {@link ParseResult} without throwing. */
export function isSchemaMismatch(value: unknown): value is SchemaMismatch {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'schemaMismatch'
  );
}

/**
 * Result type letting a parse call return either data or a `SchemaMismatch`
 * without throwing. `ok: false` is a refusal, not an exception.
 */
export type ParseResult<T> =
  | { ok: true; value: T; diagnostics: ParseDiagnostics }
  | { ok: false; mismatch: SchemaMismatch; diagnostics: ParseDiagnostics };

// ---------------------------------------------------------------------------
// (d) Hook-event contract — the liveness source (spec v2 §C4 and §3)
// ---------------------------------------------------------------------------
//
// Additive to Phase 1. Nothing above this banner changed.
//
// This section is deliberately free of any string literal naming the main
// thread. Main-thread-ness is a boolean derived from key absence, never a
// sentinel id, because CC omits `agent_id` on main-thread events rather than
// sending a placeholder. A correlator matching a placeholder string would
// silently drop every main-thread event.

/**
 * A hook payload exactly as it arrives on the wire: CC's JSON, unmodified.
 *
 * Every field is optional, and deliberately so. The payload shape is NOT
 * uniform across event types — the join keys appear independently:
 *
 *   PreToolUse / PostToolUse   carry `tool_use_id` and `tool_name`
 *   SubagentStop               carries `agent_id`, no `tool_use_id`
 *   Stop                       carries neither join key
 *   SubagentStart              carries `agent_id`, and NO `tool_use_id`
 *                              (confirmed absent, 3/3 measured events)
 *
 * Because `SubagentStart` has no `tool_use_id`, a subagent's parent
 * `tool_use` block cannot be recovered from hook events alone; that join comes
 * from the JSONL sidecar's `meta.toolUseId` (see {@link SubagentMeta}). Never
 * infer a parent from a hook event.
 *
 * The index signature keeps unknown keys rather than stripping them. That is
 * not hypothetical: the measured `SubagentStart` payload carries `prompt_id`,
 * a key absent from every previously documented event.
 *
 * Key names here are CC's snake_case wire names, not Agent Deck's camelCase.
 */
export interface RawHookPayload {
  /** e.g. 'PreToolUse'. See {@link CONFIRMED_HOOK_EVENT_NAMES}. */
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  /**
   * Subagent join key. The key is ABSENT ENTIRELY on main-thread events; CC
   * does not substitute a placeholder. Measured over 181 real events on CC
   * 2.1.234: `Stop` lacks it 6/6, `SubagentStop` carries it 4/4. A later
   * capture added `SubagentStart`, which carries it 3/3.
   */
  agent_id?: string;
  agent_type?: string;
  /**
   * Parent `tool_use` join key. Present on `PreToolUse`/`PostToolUse`.
   * Confirmed ABSENT on `SubagentStart` (3/3). Optional per event type — do
   * not treat it as a required field of the payload.
   */
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  /** Observed on the measured `SubagentStart` payload (3/3), a 36-char uuid. */
  prompt_id?: string;
  /** CC adds fields between versions; keep them rather than dropping them. */
  [key: string]: unknown;
}

/**
 * Hook event names actually received from real CC on the pinned version
 * 2.1.234.
 *
 * The first four were measured over a 181-event capture. `SubagentStart` was
 * added after it was registered in this repo's hook block and a later loopback
 * capture received it 3/3, all well-formed — it is no longer speculative.
 *
 * `SessionStart` is NOT here. It is registered in the hook block but its
 * arrival has not been measured on the pinned version; it lives in
 * {@link KNOWN_HOOK_EVENT_NAMES} only.
 */
export const CONFIRMED_HOOK_EVENT_NAMES = [
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
] as const;

export type ConfirmedHookEventName = (typeof CONFIRMED_HOOK_EVENT_NAMES)[number];

/**
 * Names Agent Deck expects to see: the confirmed five plus `SessionStart`,
 * which is registered but unmeasured. This list is documentation, not a filter
 * — the listener accepts any `hook_event_name` and flags anything outside
 * {@link CONFIRMED_HOOK_EVENT_NAMES} as unconfirmed, so a future capture can
 * prove or disprove it. Nothing is ever rejected for its name.
 */
export const KNOWN_HOOK_EVENT_NAMES = [
  ...CONFIRMED_HOOK_EVENT_NAMES,
  'SessionStart',
] as const;

export type KnownHookEventName = (typeof KNOWN_HOOK_EVENT_NAMES)[number];

/** True only for names measured on the pinned CC version. Never throws. */
export function isConfirmedHookEventName(
  value: unknown,
): value is ConfirmedHookEventName {
  return (
    typeof value === 'string' &&
    (CONFIRMED_HOOK_EVENT_NAMES as readonly string[]).includes(value)
  );
}

/** True for the confirmed five plus the registered-but-unmeasured one. */
export function isKnownHookEventName(
  value: unknown,
): value is KnownHookEventName {
  return (
    typeof value === 'string' &&
    (KNOWN_HOOK_EVENT_NAMES as readonly string[]).includes(value)
  );
}

/**
 * A hook payload after normalization, as consumers (the liveness engine) see
 * it.
 *
 * Two properties carry the whole correlation contract:
 *
 * - {@link isMainThread} is a boolean derived purely from whether the payload
 *   object had an `agent_id` key. It is not a string, not an id, and not
 *   comparable to any id. There is no sentinel value meaning "the thread with
 *   no agent" — ask this boolean.
 * - {@link agentId} is OMITTED from the object when the payload had no
 *   `agent_id` key. It is never defaulted and never filled with a placeholder,
 *   so `'agentId' in event === false` is a valid and meaningful test.
 *
 * The combination `isMainThread === false` with `agentId` omitted means the
 * `agent_id` key was present but unusable (null, empty, or not a string). Real
 * CC has not been observed to send that; it surfaces as an unattributable
 * subagent event rather than being silently promoted, because guessing is
 * worse than refusing (G3).
 */
export interface NormalizedHookEvent {
  /** Monotonic per-listener arrival counter, starting at 1. */
  seq: number;
  /** `Date.now()` at the moment the request body finished arriving. */
  receivedAt: number;
  /** Omitted when the payload carried no usable `hook_event_name`. */
  eventName?: string;
  /**
   * False when {@link eventName} is absent or is not one of
   * {@link CONFIRMED_HOOK_EVENT_NAMES}. An unconfirmed event is still
   * delivered — this flag is the explicit "not a confirmed type" marker, so a
   * consumer can count it without the listener having to reject it.
   */
  eventNameConfirmed: boolean;
  /** Omitted when the payload carried no usable `session_id`. */
  sessionId?: string;
  /**
   * The subagent join key. OMITTED, not defaulted, when `agent_id` was absent
   * or unusable. See the note on {@link isMainThread}.
   */
  agentId?: string;
  /** True exactly when the payload object had no `agent_id` key at all. */
  isMainThread: boolean;
  /**
   * Parent `tool_use` join key, when the event type carries one. Omitted on
   * event types that do not — notably `SubagentStart`, which has no such key
   * at all. Its absence is normal, not an error.
   */
  toolUseId?: string;
  toolName?: string;
  transcriptPath?: string;
  cwd?: string;
  /** The payload as received, unmodified. In-memory only (G7). */
  raw: RawHookPayload;
}
