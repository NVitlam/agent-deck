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
  /**
   * Phase 2 additive, and optional so every Phase 1 construction of this
   * interface stays valid. The spec'd fields above are untouched.
   *
   * `ToolNode` has no `children` field and that stays true, so a subagent
   * `AgentNode` does NOT nest inside the `ToolNode` that spawned it: the
   * grafter places it adjacent in the parent agent's `children`. The real
   * spawn relationship therefore exists only here. A renderer that wants to
   * draw a subagent under its spawning tool call reads these edges; without
   * them that relationship is not recoverable from `root` alone.
   */
  spawnEdges?: readonly SpawnEdge[];
  /**
   * Agents the grafter knows exist and deliberately did NOT attach to the
   * tree, each with the machine-readable code saying why.
   *
   * Phase 4.5 additive, and optional for the same reason `spawnEdges` is:
   * every earlier construction of this interface stays valid, and no field
   * above changes meaning.
   *
   * A parked agent is absent from `root` on purpose — G3 refuses rather than
   * guessing a parent — so without this field a parked agent reaches the
   * webview through no channel at all, and "refuse, don't guess" is a decision
   * the renderer cannot see. `root` cannot recover it: there is nothing in the
   * tree to recover it from.
   *
   * An empty list is the honest value for a session that parks nothing, and it
   * is also what a refused (`schemaOk: false`) session carries: a refusal
   * renders nothing, and a new field is not a hole to smuggle content through.
   */
  parked?: readonly ParkedGraft[];
}

/**
 * One `tool_use` block -> one subagent. The primary-key join, taken from the
 * sidecar's `meta.toolUseId`; never inferred, and never derived from a hook
 * event (`SubagentStart` carries no `tool_use_id` at all).
 */
export interface SpawnEdge {
  /** The `tool_use` block that spawned the agent — the join key. */
  toolUseId: string;
  /** The spawned agent's id; matches an `AgentNode.id` in the tree. */
  agentId: string;
  /** `AgentNode.id` the agent was attached under: `'root'`, or a parent agent. */
  parentNodeId: string;
  /** Depth walked from the root. 1 = child of root. */
  depth: number;
  /** `spawnDepth` as written in the sidecar, kept even when it disagrees. */
  recordedDepth: number;
}

/**
 * Why an agent is known to exist and is deliberately not in the tree.
 *
 * The same vocabulary `graft.ts` produces, where every member is documented
 * with the join outcome behind it. It is restated here rather than imported
 * because this module imports nothing at all, and that is load-bearing:
 * `bridge/apply.ts` is bundled into a CSP-strict browser context and reaches
 * only this file — a property `bridge/apply.test.ts` re-derives from disk by
 * walking the real import graph. Importing `graft.ts` here would drag
 * `node:crypto` and the parser's filesystem code into the webview bundle.
 *
 * The two definitions are held together by assignment, not by agreement:
 * `session.ts` maps a `GraftSnapshot`'s `parked` entries field by field into
 * this shape, so a code or a property added on the grafter's side and not here
 * is a compile error at that mapping rather than a value that silently never
 * arrives.
 */
export type ParkCode =
  | 'sidecarMissing'
  | 'sidecarUnusable'
  | 'missingJoinKey'
  | 'noMatchingToolUse'
  | 'ambiguousJoinKey'
  | 'parentAgentMissing'
  | 'parentAgentContradiction'
  | 'parentNotGrafted';

/** One agent that is known to exist and is deliberately not in the tree. */
export interface ParkedGraft {
  /** The agent that did not graft. It matches no `AgentNode.id` under `root`. */
  agentId: string;
  /** Machine-readable refusal reason. */
  code: ParkCode;
  /** The join key as read, when there was one worth quoting. */
  toolUseId?: string;
  /** Human-readable explanation, carried through from the join where possible. */
  reason: string;
  /** `parentAgentId` from the sidecar, when the sidecar supplied one. */
  parentAgentId?: string;
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
 * How one `SessionState` becomes the next.
 *
 * Phase 1 left this as `unknown` and said "Phase 2 defines it". This is that
 * definition. Do not narrow it further without amending the spec.
 *
 * The contract is exact, not advisory: for any two states the session model
 * produces, `applySessionPatch(prev, diffSessionState(prev, next))`
 * deep-equals `next`. `src/model/session.test.ts` asserts that round trip over
 * captured-fixture replays, so a patch shape that cannot express some change
 * fails a test rather than silently rendering a wrong tree.
 *
 * Absence means "unchanged", everywhere. An empty patch is never produced:
 * `diffSessionState` returns `undefined` when nothing changed, so a `diff`
 * message always carries a real difference.
 */
export interface SessionPatch {
  /** Session-level scalars. Only the keys that changed are present. */
  fields?: SessionFieldPatch;
  /**
   * Tree edits. Order matters, with one exception: every `removeNode` is
   * applied before any other op, so a node moving between parents cannot
   * transiently exist twice. See `applySessionPatch` in `session.ts`.
   */
  tree?: readonly TreeOp[];
  /** Whole-list replacement; present only when the edge set changed. */
  spawnEdges?: readonly SpawnEdge[];
  /**
   * Whole-list replacement; present only when the parked set changed.
   *
   * Absence means unchanged, like every other key here — so a session that
   * parked an agent on one snapshot keeps it across every later diff that does
   * not mention it.
   */
  parked?: readonly ParkedGraft[];
}

/** Session-level scalar changes. Absent key = unchanged. */
export interface SessionFieldPatch {
  projectSlug?: string;
  workspaceMatch?: boolean;
  liveness?: SessionState['liveness'];
  schemaOk?: boolean;
  /** Replaced whole; the three numbers are never patched independently. */
  totals?: SessionState['totals'];
}

/**
 * A change to an `AgentNode`'s own scalars. `children` is never patched here
 * — child membership is expressed by `insertNode` / `removeNode` /
 * `reorderChildren`, so a node keeps its identity when its parent changes.
 *
 * `null` on an optional field means CLEARED (the field became absent);
 * an absent key means unchanged. The two are different, and the diff producer
 * distinguishes them.
 */
export interface AgentNodeFieldPatch {
  kind?: AgentNode['kind'];
  label?: string;
  status?: AgentNode['status'];
  spawnDepth?: number;
  tokens?: { in: number; out: number };
  startedAt?: number;
  endedAt?: number | null;
}

/** A change to a `ToolNode`'s scalars. `null` = cleared; see {@link AgentNodeFieldPatch}. */
export interface ToolNodeFieldPatch {
  toolName?: string;
  status?: ToolNode['status'];
  inputPreview?: string;
  resultPreview?: string | null;
  durationMs?: number | null;
}

/**
 * One tree edit.
 *
 * `replaceRoot` exists because the root's id can change, and `replaceNode`
 * cannot address a node whose id is absent from the previous tree.
 */
export type TreeOp =
  /** The whole tree, when the root's identity changed. */
  | { op: 'replaceRoot'; node: AgentNode }
  /** Replace the node with this id, and its whole subtree, in place. */
  | { op: 'replaceNode'; id: string; node: TreeNode }
  /**
   * Insert `node` under `parentId`, immediately after the sibling named by
   * `afterId`; `afterId: null` means "first child".
   *
   * **A SIBLING ANCHOR, NEVER AN INDEX. This field used to be `index: number`,
   * and that is the defect `AUDIT-2026-08-27` section 7.3 identified as the
   * strongest candidate for the loss the shipped `0.1.2` was reported to
   * produce.** An index is a statement about the receiver's array, so the
   * moment the receiver's child list is one node short — because one earlier
   * op could not be applied — every later insert lands in the wrong place and
   * every later `updateTool` addresses a node that is not there. The error
   * does not stay one node wide; it compounds for the life of the session,
   * which is exactly the "the loss grew as the session went on" the user
   * reported.
   *
   * An anchor degrades instead: an unknown `afterId` appends, which is wrong
   * in ORDER and right in MEMBERSHIP, and order is recoverable from the very
   * next `reorderChildren` or from a resync. Membership is not recoverable at
   * all once a node has been dropped.
   */
  | { op: 'insertNode'; parentId: string; afterId: string | null; node: TreeNode }
  /** Detach the node with this id, and its subtree, from wherever it is. */
  | { op: 'removeNode'; id: string }
  /** Set `parentId`'s child order; `order` must be the resulting id set. */
  | { op: 'reorderChildren'; parentId: string; order: readonly string[] }
  | { op: 'updateAgent'; id: string; fields: AgentNodeFieldPatch }
  | { op: 'updateTool'; id: string; fields: ToolNodeFieldPatch };

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

/**
 * The hook tap's health, which is NOT a property of any session and therefore
 * cannot travel on `SessionState`.
 *
 * G2 in message form. When no hook events are arriving — the user has not
 * installed the hook block, or the listener failed to bind — the content tap
 * still renders a full tree, but nothing can say what is running *right now*.
 * The webview shows a banner and, per spec C4, does not nag.
 *
 * Global rather than per-session on purpose: the listener is one socket for
 * the whole window, so a per-session degraded flag would repeat one fact N
 * times and invite the two copies to disagree.
 *
 * Phase 3 addition. The spec listed three host -> webview messages and
 * simultaneously required a degraded banner; those two statements were not
 * satisfiable together, because no message carried the flag. This is the
 * smaller change: a fourth message, rather than a field on every session.
 */
export interface DegradedMessage {
  type: 'degraded';
  degraded: boolean;
  /** Absent when `degraded` is false. Mirrors `DegradedReason` in liveness.ts. */
  reason?: 'noHookEvents' | 'listenerDown';
}

export type HostToWebviewMessage =
  | SnapshotMessage
  | DiffMessage
  | SchemaMismatchMessage
  | DegradedMessage;

export interface ExpandNodeMessage {
  type: 'expandNode';
  sessionId: string;
  nodeId: string;
}

export interface SelectSessionMessage {
  type: 'selectSession';
  sessionId: string;
}

/**
 * The webview telling the host that it could not apply a patch and needs a
 * fresh snapshot.
 *
 * **The ONE new host<->webview message type permitted in v0.5.0**, and it
 * amends DoD 5.1's "no new host<->webview message types" — recorded at
 * `PLAN.md` Phase 5.5 DoD 5.5.2 rather than assumed here.
 *
 * Why it has to exist. Before it, `webview/store.ts` recorded a `patchFailure`
 * and its own comment said "the host owes us a snapshot" — while nothing told
 * the host anything. The host applies every patch to its own copy first and
 * re-snapshots when *its* apply fails, so a divergence that exists only on the
 * webview side was invisible to the only party that could repair it. The
 * webview then applied every later diff to a base the host did not have.
 *
 * `failedOp` is the op NAME, never the payload: this message travels from an
 * untrusted renderer to the host, and a name from a closed set is a thing the
 * host can validate. Absent when the failure was not attributable to one op.
 */
export interface ResyncRequestMessage {
  type: 'resyncRequest';
  /** Free text for the diagnostics channel. Never parsed, never branched on. */
  reason: string;
  /** The `TreeOp['op']` that could not be applied, when there was exactly one. */
  failedOp?: TreeOp['op'];
  /** The session whose patch failed, when the failure named one. */
  sessionId?: string;
}

export type WebviewToHostMessage =
  | ExpandNodeMessage
  | SelectSessionMessage
  | ResyncRequestMessage;

/**
 * One tree op that could not be applied, reported instead of thrown.
 *
 * DoD 5.5.1: "a patch whose target id is absent is an explicit `applyError`
 * with the op and id, not a throw". The distinction is deliberate and narrow —
 * a MISSING TARGET is a divergence, which is recoverable by resync, while a
 * structurally impossible patch (a tool node offered as the root) is a bug in
 * the producer and still throws. Turning the second into a soft error would
 * hide a defect in code that runs on both sides of the wire.
 */
export interface ApplyError {
  /** The op that could not be applied. */
  op: TreeOp['op'];
  /** The id the op addressed, when it addressed one. */
  id?: string;
  /** Human-readable, for the diagnostics channel. Never parsed. */
  reason: string;
}

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
 * `SessionStart` was the last to be confirmed, and *why* it stayed unmeasured
 * for two phases is the reusable part: it fires once, at session onset. Every
 * earlier capture was taken by a listener that bound partway through an
 * already-running session, so the one moment it could have been observed had
 * already passed. Its absence measured nothing about CC — it measured when the
 * listener started. Settled by binding the listener FIRST and then opening a
 * fresh CC window: `fixtures/hook-events/cc-2.1.234-sessionstart.jsonl` is
 * that capture. Before recording any future name as unobserved, check that the
 * observer could have been running at the moment it would have fired.
 *
 * The measured `SessionStart` key set is exactly `session_id`,
 * `transcript_path`, `cwd`, `hook_event_name`, `source` (`source` =
 * `startup`), identical on both captured events. No `agent_id` — consistent
 * with the rule that absence of that key IS the main-thread signal — no
 * `tool_use_id`, and no `prompt_id`, which makes it the only observed type
 * lacking one (285/285 events in
 * `fixtures/hook-events/cc-2.1.234-redacted.jsonl` carry `prompt_id`).
 */
export const CONFIRMED_HOOK_EVENT_NAMES = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
] as const;

export type ConfirmedHookEventName = (typeof CONFIRMED_HOOK_EVENT_NAMES)[number];

/**
 * Registered in the hook block but never yet received on the pinned version.
 *
 * EMPTY TODAY — every registered name has now been measured at least once. The
 * mechanism is kept rather than deleted: this is where a name waits between
 * being registered and being observed, and a future CC release is expected to
 * add names. While the list is empty {@link KNOWN_HOOK_EVENT_NAMES} equals
 * {@link CONFIRMED_HOOK_EVENT_NAMES} and {@link isKnownHookEventName} agrees
 * with {@link isConfirmedHookEventName} on every input; adding one literal
 * here widens {@link KnownHookEventName} and both lists automatically.
 */
export const UNCONFIRMED_KNOWN_HOOK_EVENT_NAMES = [] as const;

/** `never` while {@link UNCONFIRMED_KNOWN_HOOK_EVENT_NAMES} is empty. */
export type UnconfirmedKnownHookEventName =
  (typeof UNCONFIRMED_KNOWN_HOOK_EVENT_NAMES)[number];

export type KnownHookEventName =
  | ConfirmedHookEventName
  | UnconfirmedKnownHookEventName;

/**
 * Names Agent Deck expects to see: the confirmed set plus anything registered
 * but not yet measured. This list is documentation, not a filter — the
 * listener accepts any `hook_event_name` and flags anything outside
 * {@link CONFIRMED_HOOK_EVENT_NAMES} as unconfirmed, so a future capture can
 * prove or disprove it. Nothing is ever rejected for its name.
 */
export const KNOWN_HOOK_EVENT_NAMES: readonly KnownHookEventName[] = [
  ...CONFIRMED_HOOK_EVENT_NAMES,
  ...UNCONFIRMED_KNOWN_HOOK_EVENT_NAMES,
];

/** True only for names measured on the pinned CC version. Never throws. */
export function isConfirmedHookEventName(
  value: unknown,
): value is ConfirmedHookEventName {
  return (
    typeof value === 'string' &&
    (CONFIRMED_HOOK_EVENT_NAMES as readonly string[]).includes(value)
  );
}

/** True for the confirmed set plus any registered-but-unmeasured name. */
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
