/**
 * Agent Deck — the patch reducer, shared by the extension host and the webview.
 *
 * Extracted verbatim from `src/model/session.ts` in Phase 3 for one reason:
 * the webview must apply the same patches the host produces, and it cannot
 * import `session.ts` — that module reaches `graft.ts`, which imports
 * `node:crypto`, `node:path` and the parser's filesystem code. Bundling any
 * of that into a CSP-strict browser context is impossible, and writing a
 * SECOND reducer against the same `SessionPatch` shape would guarantee the
 * two drift apart.
 *
 * So this file is the single implementation and it has **no imports but
 * `events.ts`**, which itself imports nothing at all. That property is what
 * makes it bundleable for the webview, and it is load-bearing: adding a
 * `node:` import here breaks the webview build, not a test.
 *
 * `session.ts` re-exports `applySessionPatch` and `SessionPatchError` from
 * here, so every Phase 2 import path keeps working unchanged.
 *
 * Pure throughout: no I/O, no clock, no state. Nothing here writes anything
 * (G1) or opens a socket (G5).
 */

import type {
  AgentNode,
  ApplyError,
  ParkedGraft,
  SessionPatch,
  SessionState,
  SpawnEdge,
  ToolNode,
  TreeNode,
} from '../model/events.js';
import { isAgentNode } from '../model/events.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Freeze a value and everything reachable from it.
 *
 * Exported because `session.ts` freezes the states it hands out with the same
 * function; two implementations would let one path hand out a mutable state.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** A session's spawn edges, with the optional field normalized to a list. */
export function edgesOf(state: SessionState): readonly SpawnEdge[] {
  return state.spawnEdges ?? [];
}

/**
 * A session's parked grafts, with the optional field normalized to a list.
 *
 * Same shape as {@link edgesOf} and for the same reason: `parked` is optional
 * on the wire, so every reader would otherwise repeat the `?? []` and one of
 * them would eventually forget.
 */
export function parkedOf(state: SessionState): readonly ParkedGraft[] {
  return state.parked ?? [];
}

/** Thrown by {@link applySessionPatch} when a patch cannot be applied. */
export class SessionPatchError extends Error {
  readonly op: string;

  constructor(op: string, message: string) {
    super(message);
    this.name = 'SessionPatchError';
    this.op = op;
  }
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
    contextNow: { ...node.contextNow },
    burn: { ...node.burn },
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

/**
 * How a patch is applied when the receiver's tree does not match the sender's.
 *
 * DoD 5.5.1. Before Phase 5.5 every mismatch threw, and the webview's catch
 * kept its last good tree and set a `patchFailure` nothing ever read. This
 * seam is what lets the same reducer be strict on the host (which must never
 * diverge, so an error there forces a snapshot) and forgiving in the webview
 * (which must not lose a node while it waits for one).
 */
export interface ApplyOptions {
  /**
   * Called once per op that could not be applied. The op is SKIPPED and the
   * rest of the patch is still applied — losing one op is a divergence, and
   * abandoning the other forty-nine is a bigger one.
   */
  onError?: (error: ApplyError) => void;
}

/**
 * Apply-time context: the reporter plus the "did anything fail" flag.
 *
 * A local type rather than a closure variable because two of the op handlers
 * need to report and continue, and passing a mutable record makes that
 * explicit at every call site.
 */
interface ApplyCtx {
  report: (op: ApplyError['op'], id: string | undefined, reason: string) => void;
}

/**
 * The agent under `id`, or `undefined` after reporting why not.
 *
 * Both failure arms are DIVERGENCE, not producer bugs: an id the receiver has
 * never seen, and an id whose node is the wrong kind. Either is repaired by a
 * snapshot and neither is repaired by crashing.
 */
function findAgent(
  root: AgentNode,
  id: string,
  op: ApplyError['op'],
  ctx: ApplyCtx,
): AgentNode | undefined {
  const found = locate(root, id);
  if (found === undefined) {
    ctx.report(op, id, `no node with id ${id}`);
    return undefined;
  }
  if (!isAgentNode(found.node)) {
    ctx.report(op, id, `node ${id} is a tool node and has no children`);
    return undefined;
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
 * **TWO FAILURE CLASSES, AND THEY ARE NOT THE SAME (DoD 5.5.1).**
 *
 *   - **Divergence** — an op addressing an id this tree does not have, or has
 *     with the wrong kind, or a `reorderChildren` whose order is not this
 *     tree's child set. The receiver's tree is behind or ahead of the
 *     sender's. Reported through {@link ApplyOptions.onError}, the op is
 *     skipped, and every other op in the patch is still applied. **Not a
 *     throw**, because the repair is a snapshot and because the alternative —
 *     what `0.1.2` shipped — is to abandon the whole patch, keep a stale tree,
 *     and apply the next patch to that same stale base, compounding forever.
 *   - **A producer bug** — a patch that would break the invariant that a
 *     session's root is an agent node. Removing the root, or replacing it with
 *     a tool node. Still throws {@link SessionPatchError}: divergence cannot
 *     produce these, so softening them would hide a defect in code that runs
 *     on both sides of the wire.
 *
 * A caller that wants the old all-or-nothing behaviour passes an `onError`
 * that records, and discards the result when anything was recorded — which is
 * exactly what `SessionBridge` does, because the host must never diverge.
 */
export function applySessionPatch(
  prev: SessionState,
  patch: SessionPatch,
  options: ApplyOptions = {},
): SessionState {
  let root = cloneAgent(prev.root);
  const ops = patch.tree ?? [];
  const onError = options.onError;
  const ctx: ApplyCtx = {
    report: (op, id, reason) => {
      if (onError === undefined) return;
      const error: ApplyError = { op, reason };
      if (id !== undefined) error.id = id;
      onError(error);
    },
  };

  for (const op of ops) {
    if (op.op !== 'removeNode') continue;
    const found = locate(root, op.id);
    if (found === undefined) {
      // Divergence: the node is already gone here. Nothing to detach, and the
      // desired end state — "not in the tree" — already holds.
      ctx.report(op.op, op.id, `no node with id ${op.id}`);
      continue;
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
          ctx.report(op.op, op.id, `no node with id ${op.id}`);
          break;
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
        const parent = findAgent(root, op.parentId, op.op, ctx);
        if (parent === undefined) break;
        // The sibling anchor, not an index. `null` means "first child".
        // An anchor this tree does not have is reported and then APPENDED:
        // wrong order is recoverable from the next `reorderChildren` or from a
        // resync, and a dropped node is recoverable from neither. See the
        // `insertNode` doc comment in `events.ts` for why the field changed.
        let index: number;
        if (op.afterId === null) {
          index = 0;
        } else {
          const at = parent.children.findIndex((c) => c.id === op.afterId);
          if (at === -1) {
            ctx.report(op.op, op.afterId, `anchor ${op.afterId} is not a child of ${op.parentId}`);
            index = parent.children.length;
          } else {
            index = at + 1;
          }
        }
        parent.children.splice(index, 0, cloneNode(op.node));
        break;
      }
      case 'reorderChildren': {
        const parent = findAgent(root, op.parentId, op.op, ctx);
        if (parent === undefined) break;
        const byId = new Map<string, TreeNode>(parent.children.map((c) => [c.id, c]));
        if (byId.size !== parent.children.length || byId.size !== op.order.length) {
          ctx.report(op.op, op.parentId, `order for ${op.parentId} is not its child set`);
          break;
        }
        // Divergence-tolerant: reorder the children this tree HAS into the
        // order the sender asked for, and leave anything it does not have to
        // the resync. A partial reorder is a cosmetic disagreement; dropping
        // the children is not.
        const reordered: TreeNode[] = [];
        let missing = false;
        for (const id of op.order) {
          const child = byId.get(id);
          if (child === undefined) {
            ctx.report(op.op, id, `${id} is not a child of ${op.parentId}`);
            missing = true;
            continue;
          }
          reordered.push(child);
        }
        if (!missing) parent.children = reordered;
        break;
      }
      case 'updateAgent': {
        const node = findAgent(root, op.id, op.op, ctx);
        if (node === undefined) break;
        const f = op.fields;
        if (f.kind !== undefined) node.kind = f.kind;
        if (f.label !== undefined) node.label = f.label;
        if (f.status !== undefined) node.status = f.status;
        if (f.spawnDepth !== undefined) node.spawnDepth = f.spawnDepth;
        if (f.contextNow !== undefined) node.contextNow = { ...f.contextNow };
        if (f.burn !== undefined) node.burn = { ...f.burn };
        if (f.startedAt !== undefined) node.startedAt = f.startedAt;
        if (f.endedAt === null) delete node.endedAt;
        else if (f.endedAt !== undefined) node.endedAt = f.endedAt;
        break;
      }
      case 'updateTool': {
        const found = locate(root, op.id);
        if (found === undefined) {
          ctx.report(op.op, op.id, `no node with id ${op.id}`);
          break;
        }
        if (isAgentNode(found.node)) {
          ctx.report(op.op, op.id, `node ${op.id} is an agent node`);
          break;
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
  // Absent means unchanged, so a parked graft carried by an earlier snapshot
  // survives every diff that does not mention it. Getting this wrong is silent:
  // the parked list would appear once and then vanish on the next patch.
  //
  // `parkedOf` is deliberately NOT used here. A state that never carried the
  // field must come out without it, exactly as it went in — the host always
  // sets it, so this only affects states built before it existed, and writing
  // `parked: []` onto those would change what an unrelated round trip compares.
  const parked = patch.parked ?? prev.parked;

  const next: SessionState = {
    sessionId: prev.sessionId,
    projectSlug: fields.projectSlug ?? prev.projectSlug,
    workspaceMatch: fields.workspaceMatch ?? prev.workspaceMatch,
    liveness: fields.liveness ?? prev.liveness,
    schemaOk: fields.schemaOk ?? prev.schemaOk,
    root,
    totals: { costUsd: totals.costUsd },
    contextNow: { ...(fields.contextNow ?? prev.contextNow) },
    burn: { ...(fields.burn ?? prev.burn) },
    spawnEdges: edges.map((e) => ({ ...e })),
  };
  if (parked !== undefined) next.parked = parked.map((p) => ({ ...p }));
  return deepFreeze(next);
}
