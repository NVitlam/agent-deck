/**
 * Agent Deck — the session model (spec v2 §6 and §C5).
 *
 * This is where the two taps meet, and therefore the one file that could
 * quietly undo the architecture. It composes what four other modules built and
 * reimplements none of them:
 *
 *   correlate.ts  which sessions belong to the open workspace
 *   graft.ts      the tree, the token totals, the spawn edges
 *   liveness.ts   what is running right now, from the hook tap
 *   listener.ts   the normalized hook events themselves
 *
 * ---------------------------------------------------------------------------
 * G2 — source separation, enforced here rather than hoped for
 * ---------------------------------------------------------------------------
 * The content side (JSONL -> parser -> grafter) is undocumented and
 * drift-prone. The liveness side (hooks) is a documented contract. Every call
 * into the content side from this module goes through {@link SessionModel}'s
 * private `guard`, which catches EVERYTHING, counts it, and marks that one
 * session refused. There is no code path on which a content failure reaches
 * {@link SessionModel.ingestHookEvent}, {@link LivenessEngine.ingest}, or
 * another session's tree:
 *
 *   - per-session state is a separate {@link TreeGrafter} instance, so two
 *     sessions share no mutable object at all;
 *   - a refused session yields NO tree — not a partial one (G3) — and its
 *     liveness keeps being answered by the hook tap underneath;
 *   - `ingestHookEvent` touches the grafter never, not even to look.
 *
 * ---------------------------------------------------------------------------
 * Snapshots and diffs
 * ---------------------------------------------------------------------------
 * `SessionState` values handed out here are deep-frozen and are never mutated
 * afterwards: later ingestion builds a new object graph rather than editing
 * the old one, so a snapshot a caller is still holding cannot change under it.
 *
 * {@link diffSessionState} and {@link applySessionPatch} are pure and exact:
 * applying a produced patch to the state it was produced against reconstructs
 * the newer state exactly, including removals and nested changes. That is the
 * property `session.test.ts` asserts, not "the diff looks reasonable".
 *
 * ---------------------------------------------------------------------------
 * What this module deliberately does NOT do
 * ---------------------------------------------------------------------------
 *   - decide liveness. It asks {@link LivenessEngine} and copies the answer.
 *   - graft from liveness data. `SubagentStart` carries no `tool_use_id`, so
 *     hooks cannot attribute a subagent to its spawning `tool_use`; that join
 *     is the sidecar's `meta.toolUseId` and it arrives through the grafter.
 *   - compare any id to the literal `'main'`. CC omits `agent_id` on
 *     main-thread events; absence of the key is the signal, and
 *     `NormalizedHookEvent.isMainThread` already carries it.
 *   - compute cost. `totals.costUsd` stays 0 and 0 means NOT YET COMPUTED.
 *   - build the bridge, the panel, or any webview code. Phase 3 owns those.
 *   - write anything, anywhere (G1). It holds no file handle and no socket.
 *   - persist anything (G7). All state dies with the instance.
 */

import type {
  AgentNode,
  AgentNodeFieldPatch,
  NormalizedHookEvent,
  SchemaMismatch,
  SessionFieldPatch,
  SessionPatch,
  SessionState,
  SpawnEdge,
  ToolNode,
  ToolNodeFieldPatch,
  TreeNode,
  TreeOp,
} from './events.js';
import { isAgentNode } from './events.js';
import type { HookEventHandler } from '../hooks/listener.js';
import type {
  GraftEdge,
  GraftOptions,
  GraftSessionResult,
  GraftSnapshot,
  SidecarArrival,
  TranscriptBatch,
} from './graft.js';
import { ROOT_NODE_ID, TreeGrafter, previewFingerprint, walk } from './graft.js';
import type { SessionLivenessSnapshot } from './liveness.js';
import { LivenessEngine } from './liveness.js';
import type { WorkspaceCorrelation } from './correlate.js';
import { isOpenWorkspaceSlug } from './correlate.js';

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The tree a refused session exposes: nothing.
 *
 * G3 says a schema/layout mismatch renders `unsupported` and never a partial
 * tree. "Partial" includes token totals and spawn edges, so those are zeroed
 * and emptied too — a number computed from half a session is a wrong number,
 * not a smaller one. `status` is `'running'`: we do not know that the session
 * ended, and claiming it did would be the guess G3 forbids.
 */
function refusedRoot(): AgentNode {
  return {
    id: ROOT_NODE_ID,
    kind: 'main',
    label: '',
    status: 'running',
    spawnDepth: 0,
    children: [],
    tokens: { in: 0, out: 0 },
    startedAt: 0,
  };
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/** Thrown by {@link applySessionPatch} when a patch cannot be applied. */
export class SessionPatchError extends Error {
  readonly op: string;

  constructor(op: string, message: string) {
    super(message);
    this.name = 'SessionPatchError';
    this.op = op;
  }
}

function sameTotals(a: SessionState['totals'], b: SessionState['totals']): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.costUsd === b.costUsd
  );
}

function sameEdges(a: readonly SpawnEdge[], b: readonly SpawnEdge[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (
      x.toolUseId !== y.toolUseId ||
      x.agentId !== y.agentId ||
      x.parentNodeId !== y.parentNodeId ||
      x.depth !== y.depth ||
      x.recordedDepth !== y.recordedDepth
    ) {
      return false;
    }
  }
  return true;
}

function edgesOf(state: SessionState): readonly SpawnEdge[] {
  return state.spawnEdges ?? [];
}

function sameIdList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function hasDuplicateIds(nodes: readonly TreeNode[]): boolean {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) return true;
    seen.add(node.id);
  }
  return false;
}

function sameTokens(a: AgentNode['tokens'], b: AgentNode['tokens']): boolean {
  return a.in === b.in && a.out === b.out;
}

function agentFieldPatch(prev: AgentNode, next: AgentNode): AgentNodeFieldPatch | undefined {
  const fields: AgentNodeFieldPatch = {};
  let changed = false;
  if (prev.kind !== next.kind) {
    fields.kind = next.kind;
    changed = true;
  }
  if (prev.label !== next.label) {
    fields.label = next.label;
    changed = true;
  }
  if (prev.status !== next.status) {
    fields.status = next.status;
    changed = true;
  }
  if (prev.spawnDepth !== next.spawnDepth) {
    fields.spawnDepth = next.spawnDepth;
    changed = true;
  }
  if (!sameTokens(prev.tokens, next.tokens)) {
    fields.tokens = { in: next.tokens.in, out: next.tokens.out };
    changed = true;
  }
  if (prev.startedAt !== next.startedAt) {
    fields.startedAt = next.startedAt;
    changed = true;
  }
  if (prev.endedAt !== next.endedAt) {
    fields.endedAt = next.endedAt === undefined ? null : next.endedAt;
    changed = true;
  }
  return changed ? fields : undefined;
}

function toolFieldPatch(prev: ToolNode, next: ToolNode): ToolNodeFieldPatch | undefined {
  const fields: ToolNodeFieldPatch = {};
  let changed = false;
  if (prev.toolName !== next.toolName) {
    fields.toolName = next.toolName;
    changed = true;
  }
  if (prev.status !== next.status) {
    fields.status = next.status;
    changed = true;
  }
  if (prev.inputPreview !== next.inputPreview) {
    fields.inputPreview = next.inputPreview;
    changed = true;
  }
  if (prev.resultPreview !== next.resultPreview) {
    fields.resultPreview = next.resultPreview === undefined ? null : next.resultPreview;
    changed = true;
  }
  if (prev.durationMs !== next.durationMs) {
    fields.durationMs = next.durationMs === undefined ? null : next.durationMs;
    changed = true;
  }
  return changed ? fields : undefined;
}

function diffNode(prev: TreeNode, next: TreeNode, ops: TreeOp[]): void {
  // A node that changed kind is not the same node any more. Replacing is the
  // only honest edit; patching fields across kinds would produce a chimera.
  if (!isAgentNode(prev)) {
    if (isAgentNode(next)) {
      ops.push({ op: 'replaceNode', id: prev.id, node: next });
      return;
    }
    const fields = toolFieldPatch(prev, next);
    if (fields !== undefined) ops.push({ op: 'updateTool', id: prev.id, fields });
    return;
  }
  if (!isAgentNode(next)) {
    ops.push({ op: 'replaceNode', id: prev.id, node: next });
    return;
  }

  // Duplicate child ids make id-keyed reconciliation meaningless. The grafter
  // does not produce them; if some future source does, replacing the subtree
  // is correct and a mis-keyed patch is not.
  if (hasDuplicateIds(prev.children) || hasDuplicateIds(next.children)) {
    ops.push({ op: 'replaceNode', id: prev.id, node: next });
    return;
  }

  const fields = agentFieldPatch(prev, next);
  if (fields !== undefined) ops.push({ op: 'updateAgent', id: prev.id, fields });

  const prevById = new Map<string, TreeNode>(prev.children.map((c) => [c.id, c]));
  const nextIds = next.children.map((c) => c.id);
  const nextIdSet = new Set(nextIds);

  for (const child of prev.children) {
    if (!nextIdSet.has(child.id)) ops.push({ op: 'removeNode', id: child.id });
  }

  for (let i = 0; i < next.children.length; i += 1) {
    const child = next.children[i];
    if (child === undefined) continue;
    const before = prevById.get(child.id);
    if (before === undefined) {
      ops.push({ op: 'insertNode', parentId: prev.id, index: i, node: child });
      continue;
    }
    diffNode(before, child, ops);
  }

  // Removals + ascending-index insertions reproduce `nextIds` exactly IF the
  // surviving children kept their relative order. When they did not, one
  // explicit reorder is cheaper and safer than a pile of moves.
  const survivorsPrevOrder = prev.children.filter((c) => nextIdSet.has(c.id)).map((c) => c.id);
  const survivorsNextOrder = nextIds.filter((id) => prevById.has(id));
  if (!sameIdList(survivorsPrevOrder, survivorsNextOrder)) {
    ops.push({ op: 'reorderChildren', parentId: prev.id, order: nextIds });
  }
}

/**
 * The patch turning `prev` into `next`, or `undefined` when they are equal.
 *
 * Pure. Neither argument is read after this returns and neither is mutated.
 */
export function diffSessionState(
  prev: SessionState,
  next: SessionState,
): SessionPatch | undefined {
  const patch: SessionPatch = {};
  let changed = false;

  const fields: SessionFieldPatch = {};
  let fieldsChanged = false;
  if (prev.projectSlug !== next.projectSlug) {
    fields.projectSlug = next.projectSlug;
    fieldsChanged = true;
  }
  if (prev.workspaceMatch !== next.workspaceMatch) {
    fields.workspaceMatch = next.workspaceMatch;
    fieldsChanged = true;
  }
  if (prev.liveness !== next.liveness) {
    fields.liveness = next.liveness;
    fieldsChanged = true;
  }
  if (prev.schemaOk !== next.schemaOk) {
    fields.schemaOk = next.schemaOk;
    fieldsChanged = true;
  }
  if (!sameTotals(prev.totals, next.totals)) {
    fields.totals = { ...next.totals };
    fieldsChanged = true;
  }
  if (fieldsChanged) {
    patch.fields = fields;
    changed = true;
  }

  if (!sameEdges(edgesOf(prev), edgesOf(next))) {
    patch.spawnEdges = edgesOf(next).map((e) => ({ ...e }));
    changed = true;
  }

  const ops: TreeOp[] = [];
  if (prev.root.id !== next.root.id) {
    ops.push({ op: 'replaceRoot', node: next.root });
  } else {
    diffNode(prev.root, next.root, ops);
  }
  if (ops.length > 0) {
    patch.tree = ops;
    changed = true;
  }

  return changed ? patch : undefined;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

function cloneTool(node: ToolNode): ToolNode {
  const out: ToolNode = {
    id: node.id,
    toolName: node.toolName,
    status: node.status,
    inputPreview: node.inputPreview,
  };
  if (node.resultPreview !== undefined) out.resultPreview = node.resultPreview;
  if (node.durationMs !== undefined) out.durationMs = node.durationMs;
  return out;
}

function cloneAgent(node: AgentNode): AgentNode {
  const out: AgentNode = {
    id: node.id,
    kind: node.kind,
    label: node.label,
    status: node.status,
    spawnDepth: node.spawnDepth,
    children: node.children.map(cloneNode),
    tokens: { in: node.tokens.in, out: node.tokens.out },
    startedAt: node.startedAt,
  };
  if (node.endedAt !== undefined) out.endedAt = node.endedAt;
  return out;
}

function cloneNode(node: TreeNode): TreeNode {
  return isAgentNode(node) ? cloneAgent(node) : cloneTool(node);
}

interface Located {
  node: TreeNode;
  parent?: AgentNode;
  index: number;
}

function locate(root: AgentNode, id: string): Located | undefined {
  if (root.id === id) return { node: root, index: -1 };
  const stack: AgentNode[] = [root];
  while (stack.length > 0) {
    const parent = stack.pop();
    if (parent === undefined) break;
    for (let i = 0; i < parent.children.length; i += 1) {
      const child = parent.children[i];
      if (child === undefined) continue;
      if (child.id === id) return { node: child, parent, index: i };
      if (isAgentNode(child)) stack.push(child);
    }
  }
  return undefined;
}

function requireAgent(root: AgentNode, id: string, op: string): AgentNode {
  const found = locate(root, id);
  if (found === undefined) throw new SessionPatchError(op, `no node with id ${id}`);
  if (!isAgentNode(found.node)) {
    throw new SessionPatchError(op, `node ${id} is a tool node and has no children`);
  }
  return found.node;
}

/**
 * Apply a patch produced by {@link diffSessionState}.
 *
 * Pure: `prev` is deep-cloned first and is never mutated. The result is
 * deep-frozen, exactly like a state the model emits, so the round-trip
 * assertion compares like with like.
 *
 * Removals run first, across the whole op list, so a node that moves from one
 * parent to another is detached before it is re-inserted. Everything else is
 * applied in order.
 *
 * A patch that cannot be applied throws {@link SessionPatchError} rather than
 * producing a tree that silently disagrees with its source. This function is
 * pure and side-effect free; a caller that cannot afford a throw (the
 * extension host) can catch it and re-send a full snapshot.
 */
export function applySessionPatch(prev: SessionState, patch: SessionPatch): SessionState {
  let root = cloneAgent(prev.root);
  const ops = patch.tree ?? [];

  for (const op of ops) {
    if (op.op !== 'removeNode') continue;
    const found = locate(root, op.id);
    if (found === undefined) {
      throw new SessionPatchError(op.op, `no node with id ${op.id}`);
    }
    if (found.parent === undefined) {
      throw new SessionPatchError(op.op, 'the root cannot be removed');
    }
    found.parent.children.splice(found.index, 1);
  }

  for (const op of ops) {
    switch (op.op) {
      case 'removeNode':
        break;
      case 'replaceRoot':
        root = cloneAgent(op.node);
        break;
      case 'replaceNode': {
        const found = locate(root, op.id);
        if (found === undefined) {
          throw new SessionPatchError(op.op, `no node with id ${op.id}`);
        }
        const replacement = cloneNode(op.node);
        if (found.parent === undefined) {
          if (!isAgentNode(replacement)) {
            throw new SessionPatchError(op.op, 'the root must be an agent node');
          }
          root = replacement;
        } else {
          found.parent.children[found.index] = replacement;
        }
        break;
      }
      case 'insertNode': {
        const parent = requireAgent(root, op.parentId, op.op);
        const index = Math.max(0, Math.min(op.index, parent.children.length));
        parent.children.splice(index, 0, cloneNode(op.node));
        break;
      }
      case 'reorderChildren': {
        const parent = requireAgent(root, op.parentId, op.op);
        const byId = new Map<string, TreeNode>(parent.children.map((c) => [c.id, c]));
        if (byId.size !== parent.children.length || byId.size !== op.order.length) {
          throw new SessionPatchError(op.op, `order for ${op.parentId} is not its child set`);
        }
        const reordered: TreeNode[] = [];
        for (const id of op.order) {
          const child = byId.get(id);
          if (child === undefined) {
            throw new SessionPatchError(op.op, `${id} is not a child of ${op.parentId}`);
          }
          reordered.push(child);
        }
        parent.children = reordered;
        break;
      }
      case 'updateAgent': {
        const node = requireAgent(root, op.id, op.op);
        const f = op.fields;
        if (f.kind !== undefined) node.kind = f.kind;
        if (f.label !== undefined) node.label = f.label;
        if (f.status !== undefined) node.status = f.status;
        if (f.spawnDepth !== undefined) node.spawnDepth = f.spawnDepth;
        if (f.tokens !== undefined) node.tokens = { in: f.tokens.in, out: f.tokens.out };
        if (f.startedAt !== undefined) node.startedAt = f.startedAt;
        if (f.endedAt === null) delete node.endedAt;
        else if (f.endedAt !== undefined) node.endedAt = f.endedAt;
        break;
      }
      case 'updateTool': {
        const found = locate(root, op.id);
        if (found === undefined) {
          throw new SessionPatchError(op.op, `no node with id ${op.id}`);
        }
        if (isAgentNode(found.node)) {
          throw new SessionPatchError(op.op, `node ${op.id} is an agent node`);
        }
        const node = found.node;
        const f = op.fields;
        if (f.toolName !== undefined) node.toolName = f.toolName;
        if (f.status !== undefined) node.status = f.status;
        if (f.inputPreview !== undefined) node.inputPreview = f.inputPreview;
        if (f.resultPreview === null) delete node.resultPreview;
        else if (f.resultPreview !== undefined) node.resultPreview = f.resultPreview;
        if (f.durationMs === null) delete node.durationMs;
        else if (f.durationMs !== undefined) node.durationMs = f.durationMs;
        break;
      }
    }
  }

  const fields = patch.fields ?? {};
  const totals = fields.totals ?? prev.totals;
  const edges = patch.spawnEdges ?? edgesOf(prev);

  const next: SessionState = {
    sessionId: prev.sessionId,
    projectSlug: fields.projectSlug ?? prev.projectSlug,
    workspaceMatch: fields.workspaceMatch ?? prev.workspaceMatch,
    liveness: fields.liveness ?? prev.liveness,
    schemaOk: fields.schemaOk ?? prev.schemaOk,
    root,
    totals: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costUsd: totals.costUsd,
    },
    spawnEdges: edges.map((e) => ({ ...e })),
  };
  return deepFreeze(next);
}

// ---------------------------------------------------------------------------
// Golden serialization
// ---------------------------------------------------------------------------

/**
 * Canonical, machine-independent rendering of one `SessionState`.
 *
 * Same three rules as `fixtures/golden/graft/`, for the same reason — a golden
 * that only reproduces on the machine that captured the fixtures is worthless:
 *
 *   1. no filesystem paths;
 *   2. no wall-clock values — node times are offsets from `epochAnchor`, the
 *      earliest timestamp in the session, which is fixture content;
 *   3. previews by `sha256:<16 hex>:<byte length>`, never verbatim, because
 *      captured tool inputs embed the capturing machine's absolute paths.
 *
 * Key order is fixed here, so a diff between two goldens is a real difference.
 */
export interface SerializedSessionNode {
  [key: string]: unknown;
}

export interface SerializedSessionState {
  sessionId: string;
  projectSlug: string;
  workspaceMatch: boolean;
  liveness: SessionState['liveness'];
  schemaOk: boolean;
  epochAnchor: string | null;
  totals: SessionState['totals'];
  spawnEdges: SpawnEdge[];
  root: SerializedSessionNode;
}

function serializeSessionNode(
  node: TreeNode,
  anchor: number | undefined,
): SerializedSessionNode {
  if (!isAgentNode(node)) {
    return {
      node: 'tool',
      id: node.id,
      toolName: node.toolName,
      status: node.status,
      inputPreview: previewFingerprint(node.inputPreview),
      resultPreview: previewFingerprint(node.resultPreview),
      durationMs: node.durationMs ?? null,
    };
  }
  return {
    node: 'agent',
    id: node.id,
    kind: node.kind,
    label: node.label,
    status: node.status,
    spawnDepth: node.spawnDepth,
    tokens: { in: node.tokens.in, out: node.tokens.out },
    startedAtOffsetMs:
      anchor === undefined || node.startedAt === 0 ? null : node.startedAt - anchor,
    endedAtOffsetMs:
      anchor === undefined || node.endedAt === undefined ? null : node.endedAt - anchor,
    children: node.children.map((child) => serializeSessionNode(child, anchor)),
  };
}

export function serializeSessionState(state: SessionState): SerializedSessionState {
  let anchor: number | undefined;
  walk(state.root, (node) => {
    if (!isAgentNode(node)) return;
    if (node.startedAt === 0) return;
    if (anchor === undefined || node.startedAt < anchor) anchor = node.startedAt;
  });
  return {
    sessionId: state.sessionId,
    projectSlug: state.projectSlug,
    workspaceMatch: state.workspaceMatch,
    liveness: state.liveness,
    schemaOk: state.schemaOk,
    epochAnchor: anchor === undefined ? null : new Date(anchor).toISOString(),
    totals: { ...state.totals },
    spawnEdges: edgesOf(state).map((e) => ({ ...e })),
    root: serializeSessionNode(state.root, anchor),
  };
}

/** The exact text a golden file holds: canonical JSON, LF endings, trailing newline. */
export function sessionGoldenText(state: SessionState): string {
  return `${JSON.stringify(serializeSessionState(state), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface SessionModelOptions {
  /** Absolute path of the workspace VS Code has open. Slug-encoded, not stored as a path. */
  workspacePath: string;
  /**
   * Injected so the extension host can hand the same engine to the hook
   * listener. One is created if omitted.
   */
  liveness?: LivenessEngine;
  /** Per-node preview ceiling, forwarded to every session's grafter. */
  previewBytes?: number;
}

export interface SessionModelCounters {
  /** Sessions this model knows about, workspace-matching or not. */
  sessionsRegistered: number;
  /** Hook events handed to {@link SessionModel.ingestHookEvent}. */
  hookEventsIngested: number;
  /** Of those, ones naming a session that is not the open workspace's. */
  hookEventsForeignSession: number;
  /** Content arrivals (transcript batches, sidecars, payloads, graft results). */
  contentArrivals: number;
  /**
   * Content arrivals that THREW. The G2 counter: every one of these is a
   * failure the liveness side did not notice.
   */
  contentFailures: number;
  /** Sessions currently refused, whether by mismatch or by a throw. */
  refusedSessions: number;
}

/** Why a session is refused. Either is a G3 refusal and neither yields a tree. */
export interface SessionRefusal {
  /** A layout/schema mismatch the parser returned. */
  mismatch?: SchemaMismatch;
  /** A throw caught at the content boundary. */
  thrown?: string;
}

/** One session's diff, ready for a `{ type: 'diff', sessionId, patch }` message. */
export interface SessionDiff {
  sessionId: string;
  patch: SessionPatch;
}

/**
 * The result of {@link SessionModel.emit}: a full snapshot plus what changed
 * since the previous emission.
 *
 * `added` carries no patch on purpose — a session that did not exist before
 * has nothing to diff against, and the host sends it as part of `sessions`.
 */
export interface SessionEmission {
  /** Workspace-matching sessions only. Deep-frozen. The new diff baseline. */
  sessions: readonly SessionState[];
  /** One entry per session whose state actually changed. */
  diffs: readonly SessionDiff[];
  addedSessionIds: readonly string[];
  removedSessionIds: readonly string[];
  /**
   * Sessions that became `schemaOk: false` since the previous emission — the
   * `{ type: 'schemaMismatch', sessionId }` message's trigger.
   */
  schemaMismatchSessionIds: readonly string[];
}

interface ContentView {
  schemaOk: boolean;
  root: AgentNode;
  totals: SessionState['totals'];
  spawnEdges: readonly SpawnEdge[];
}

interface SessionRecord {
  sessionId: string;
  projectSlug: string;
  workspaceMatch: boolean;
  grafter: TreeGrafter;
  /** Set once refused; sticky until a successful whole-session graft clears it. */
  refusal?: SessionRefusal;
  /** Invalidated by any content arrival; liveness is always read fresh. */
  view?: ContentView;
}

const REFUSED_TOTALS: SessionState['totals'] = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
});

const NO_EDGES: readonly SpawnEdge[] = Object.freeze([]);

export class SessionModel {
  /** The hook tap's engine. Public so the host can wire the listener to it. */
  readonly liveness: LivenessEngine;

  private readonly workspacePath: string;
  private readonly graftOptions: GraftOptions;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly lastEmitted = new Map<string, SessionState>();

  private readonly counts: SessionModelCounters = {
    sessionsRegistered: 0,
    hookEventsIngested: 0,
    hookEventsForeignSession: 0,
    contentArrivals: 0,
    contentFailures: 0,
    refusedSessions: 0,
  };

  private lastFailureMessage?: string;

  constructor(options: SessionModelOptions) {
    this.workspacePath = options.workspacePath;
    this.liveness = options.liveness ?? new LivenessEngine();
    this.graftOptions =
      options.previewBytes === undefined ? {} : { previewBytes: options.previewBytes };
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register one session. Idempotent: registering a known session returns its
   * existing record and does not reset its tree.
   *
   * `workspaceMatch` is computed from the slug, never supplied, so a caller
   * cannot smuggle a foreign session into the rendered set.
   */
  registerSession(init: { sessionId: string; projectSlug: string }): void {
    this.record(init.sessionId, init.projectSlug);
  }

  /** Register every session of a correlated workspace. Idempotent. */
  applyCorrelation(correlation: WorkspaceCorrelation): void {
    for (const session of correlation.sessions) {
      this.record(session.sessionId, correlation.slug);
    }
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()].sort();
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Forget a session entirely (its file vanished). In-memory only (G7). */
  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private record(sessionId: string, projectSlug: string): SessionRecord {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionRecord = {
      sessionId,
      projectSlug,
      workspaceMatch: isOpenWorkspaceSlug(projectSlug, this.workspacePath),
      grafter: new TreeGrafter({ sessionId, projectSlug }, this.graftOptions),
    };
    this.sessions.set(sessionId, created);
    this.counts.sessionsRegistered += 1;
    // Give the liveness engine a record for this session so a later
    // `setSchemaSupported` sticks. `observeJsonl` with no facts asserts
    // nothing about running-ness; it only says "this session exists".
    this.liveness.observeJsonl(sessionId, {});
    return created;
  }

  // -------------------------------------------------------------------------
  // Liveness side — no content code runs on this path, ever
  // -------------------------------------------------------------------------

  /**
   * Feed one normalized hook event.
   *
   * The event goes to the liveness engine whatever this model thinks of the
   * session: an event for a session whose tree refused still updates that
   * session's liveness, which is the entire point of G2. Nothing here reads a
   * grafter, a transcript or a parser.
   *
   * Thread attribution is not re-derived. `event.isMainThread` already
   * encodes "CC omitted `agent_id`", and no id is ever compared to a sentinel.
   */
  ingestHookEvent(event: NormalizedHookEvent): void {
    this.counts.hookEventsIngested += 1;
    const sessionId = event.sessionId;
    if (sessionId !== undefined && !this.sessions.has(sessionId)) {
      this.counts.hookEventsForeignSession += 1;
    }
    this.liveness.ingest(event);
  }

  /** Pre-bound, so wiring is `listener.subscribe(model.onHookEvent)`. */
  readonly onHookEvent: HookEventHandler = (event: NormalizedHookEvent): void => {
    this.ingestHookEvent(event);
  };

  /** The hook tap's own view of a session, for diagnostics and tests. */
  livenessSnapshot(sessionId: string): SessionLivenessSnapshot | undefined {
    return this.liveness.snapshot(sessionId);
  }

  // -------------------------------------------------------------------------
  // Content side — every entry point is wrapped
  // -------------------------------------------------------------------------

  /**
   * The G2 boundary in one place.
   *
   * Anything thrown by the parser, the grafter or a caller's own content code
   * is caught here, counted, and turned into a refusal for THAT session. It
   * never propagates, never touches another session, and never reaches the
   * liveness engine.
   */
  private guard(record: SessionRecord, work: () => void): void {
    this.counts.contentArrivals += 1;
    try {
      work();
      record.view = undefined;
    } catch (err) {
      this.counts.contentFailures += 1;
      this.lastFailureMessage = errorMessage(err);
      this.refuse(record, { thrown: errorMessage(err) });
    }
  }

  ingestTranscript(sessionId: string, projectSlug: string, batch: TranscriptBatch): void {
    const record = this.record(sessionId, projectSlug);
    this.guard(record, () => {
      record.grafter.addTranscript(batch);
    });
  }

  ingestSidecar(sessionId: string, projectSlug: string, arrival: SidecarArrival): void {
    const record = this.record(sessionId, projectSlug);
    this.guard(record, () => {
      record.grafter.addSidecar(arrival);
    });
  }

  ingestToolResultPayload(
    sessionId: string,
    projectSlug: string,
    toolUseId: string,
    text: string,
  ): void {
    const record = this.record(sessionId, projectSlug);
    this.guard(record, () => {
      record.grafter.addToolResultPayload(toolUseId, text);
    });
  }

  /**
   * Apply a whole-session `graftSession` result.
   *
   * `ok: false` refuses the session (G3). `ok: true` is the only thing that
   * clears a refusal, because it is the only evidence that the whole session
   * reads cleanly — a single later batch parsing is not.
   */
  ingestGraftResult(
    sessionId: string,
    projectSlug: string,
    result: GraftSessionResult,
  ): void {
    const record = this.record(sessionId, projectSlug);
    this.counts.contentArrivals += 1;
    if (!result.ok) {
      this.refuse(record, { mismatch: result.mismatch });
      return;
    }
    try {
      this.clearRefusal(record);
      record.view = this.viewFromSnapshot(result.snapshot);
    } catch (err) {
      this.counts.contentFailures += 1;
      this.lastFailureMessage = errorMessage(err);
      this.refuse(record, { thrown: errorMessage(err) });
    }
  }

  /**
   * Refuse a session outright: fingerprint mismatch, layout mismatch, or any
   * other content-side refusal the caller detected. No tree is exposed for it
   * afterwards, and its liveness becomes `unsupported` — asserted from here,
   * never inferred inside the liveness engine.
   */
  refuseSession(sessionId: string, projectSlug: string, mismatch: SchemaMismatch): void {
    const record = this.record(sessionId, projectSlug);
    this.refuse(record, { mismatch });
  }

  /** Why a session is refused, or `undefined` when it is not. */
  refusalOf(sessionId: string): SessionRefusal | undefined {
    return this.sessions.get(sessionId)?.refusal;
  }

  /** Message of the most recent caught content failure, if any. */
  lastFailure(): string | undefined {
    return this.lastFailureMessage;
  }

  private refuse(record: SessionRecord, refusal: SessionRefusal): void {
    if (record.refusal === undefined) this.counts.refusedSessions += 1;
    record.refusal = refusal;
    record.view = undefined;
    this.liveness.setSchemaSupported(record.sessionId, false);
  }

  private clearRefusal(record: SessionRecord): void {
    if (record.refusal === undefined) return;
    record.refusal = undefined;
    this.counts.refusedSessions -= 1;
    this.liveness.setSchemaSupported(record.sessionId, true);
  }

  private viewFromSnapshot(snapshot: GraftSnapshot): ContentView {
    return deepFreeze<ContentView>({
      schemaOk: true,
      root: snapshot.root,
      totals: { ...snapshot.totals },
      spawnEdges: snapshot.edges.map((e: GraftEdge) => ({
        toolUseId: e.toolUseId,
        agentId: e.agentId,
        parentNodeId: e.parentNodeId,
        depth: e.depth,
        recordedDepth: e.recordedDepth,
      })),
    });
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /**
   * The content half of a session's state, cached until the next content
   * arrival. Liveness is deliberately NOT cached — it moves with the clock and
   * with hook events, neither of which invalidates a tree.
   */
  private contentView(record: SessionRecord): ContentView {
    if (record.refusal !== undefined) {
      // Cached like any other view so a refused session's `root` object is
      // stable between snapshots too; `refuse()` clears the cache, so this is
      // rebuilt exactly once per refusal.
      if (record.view !== undefined) return record.view;
      record.view = deepFreeze<ContentView>({
        schemaOk: false,
        root: refusedRoot(),
        totals: REFUSED_TOTALS,
        spawnEdges: NO_EDGES,
      });
      return record.view;
    }
    if (record.view !== undefined) return record.view;
    let view: ContentView;
    try {
      view = this.viewFromSnapshot(record.grafter.snapshot());
    } catch (err) {
      // A grafter that cannot produce a snapshot is a content failure like any
      // other: counted, refused, and invisible to the liveness side.
      this.counts.contentFailures += 1;
      this.lastFailureMessage = errorMessage(err);
      this.refuse(record, { thrown: errorMessage(err) });
      return this.contentView(record);
    }
    record.view = view;
    return view;
  }

  private stateOf(record: SessionRecord): SessionState {
    const view = this.contentView(record);
    const liveness = this.liveness.livenessOf(record.sessionId) ?? 'idle';
    return deepFreeze<SessionState>({
      sessionId: record.sessionId,
      projectSlug: record.projectSlug,
      workspaceMatch: record.workspaceMatch,
      liveness,
      schemaOk: view.schemaOk,
      root: view.root,
      totals: view.totals,
      spawnEdges: view.spawnEdges,
    });
  }

  /**
   * The current state of one session, whether or not it is the workspace's.
   * `undefined` for a session this model has never been told about.
   */
  sessionState(sessionId: string): SessionState | undefined {
    const record = this.sessions.get(sessionId);
    return record === undefined ? undefined : this.stateOf(record);
  }

  /**
   * The snapshot the webview is entitled to: the open workspace's sessions
   * only, sorted by session id.
   *
   * Sessions of other workspaces are excluded here rather than filtered
   * downstream, so there is no code path on which a foreign session reaches a
   * `snapshot` message.
   */
  snapshot(): readonly SessionState[] {
    const out: SessionState[] = [];
    for (const record of this.sessions.values()) {
      if (!record.workspaceMatch) continue;
      out.push(this.stateOf(record));
    }
    out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return Object.freeze(out);
  }

  /** Every session, foreign ones included. Diagnostics; never sent to a webview. */
  allSessions(): readonly SessionState[] {
    const out: SessionState[] = [];
    for (const record of this.sessions.values()) out.push(this.stateOf(record));
    out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return Object.freeze(out);
  }

  /**
   * Snapshot plus the diffs since the previous call, and advance the baseline.
   *
   * The baseline is the states this model last handed out, so a caller that
   * applies every emitted patch in order holds exactly `sessions`.
   */
  emit(): SessionEmission {
    const sessions = this.snapshot();
    const diffs: SessionDiff[] = [];
    const addedSessionIds: string[] = [];
    const schemaMismatchSessionIds: string[] = [];
    const seen = new Set<string>();

    for (const next of sessions) {
      seen.add(next.sessionId);
      const prev = this.lastEmitted.get(next.sessionId);
      if (prev === undefined) {
        addedSessionIds.push(next.sessionId);
        if (!next.schemaOk) schemaMismatchSessionIds.push(next.sessionId);
      } else {
        const patch = diffSessionState(prev, next);
        if (patch !== undefined) diffs.push({ sessionId: next.sessionId, patch });
        if (prev.schemaOk && !next.schemaOk) schemaMismatchSessionIds.push(next.sessionId);
      }
      this.lastEmitted.set(next.sessionId, next);
    }

    const removedSessionIds: string[] = [];
    for (const sessionId of [...this.lastEmitted.keys()]) {
      if (seen.has(sessionId)) continue;
      removedSessionIds.push(sessionId);
      this.lastEmitted.delete(sessionId);
    }
    removedSessionIds.sort();

    return {
      sessions,
      diffs,
      addedSessionIds,
      removedSessionIds,
      schemaMismatchSessionIds,
    };
  }

  counters(): SessionModelCounters {
    return { ...this.counts };
  }
}
