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
