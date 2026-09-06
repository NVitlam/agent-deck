/**
 * Agent Deck — stall derivation (v0.7.0 Phase 0c, DoD 0c.3).
 *
 * ---------------------------------------------------------------------------
 * WHAT A STALL IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * A tool is `stalled` when it is `running` and the SESSION has observed no
 * activity for longer than the liveness threshold. It is a statement about
 * silence, not about duration.
 *
 * That distinction is the whole design, and the harvested corpus
 * (`fixtures/cc-2.1.260/…/99f96635-…`) is what settles it rather than an
 * argument. Four calls in that one session exceed the threshold and then
 * complete — including an `Agent` that ran **47 minutes** — while the call the
 * user actually reported ran **18 minutes** and never returned. The stall is
 * the SHORTER of the two. Any rule keyed on how long a tool has been running
 * gets this exactly backwards; what separates them is that the 47-minute call's
 * subagent was emitting hook events the whole time, and the stalled one's went
 * silent. See `docs/evidence/phase-0c/ROOTCAUSE.md` §5.
 *
 * ---------------------------------------------------------------------------
 * DERIVED, NEVER STORED (locked, 2026-09-05)
 * ---------------------------------------------------------------------------
 * Nothing here is persisted and the parser never writes a stall. The value is
 * computed at snapshot time from `running` plus the clock, so:
 *
 *   - **it clears on activity by construction.** Any hook event or transcript
 *     write moves `lastActivityAt`, and the next derivation returns
 *     `stalled: false` with no reset path that could be forgotten or raced;
 *   - **it cannot go stale**, because it is never written down;
 *   - **it cannot corrupt content.** G2 holds: this module is downstream of
 *     everything and feeds nothing back.
 *
 * ---------------------------------------------------------------------------
 * NO NEW CONSTANT
 * ---------------------------------------------------------------------------
 * `thresholdMs` is the caller's existing `agentDeck.livenessThresholdMs`
 * (default 120 000). This module deliberately declares no default of its own:
 * a second default would be a second thing to keep in step, and the liveness
 * engine already owns that number.
 *
 * ---------------------------------------------------------------------------
 * WHY THE IMPORT LIST IS EMPTY OF VALUES
 * ---------------------------------------------------------------------------
 * `events.ts` is the ONLY module this file imports from, and `events.ts` itself
 * imports nothing. `src/model/stall.test.ts` asserts that by reading this file's
 * source — a pure function that reaches
 * for a clock, a file or a store is no longer pure, and the guard is cheaper
 * than the review that would otherwise have to catch it.
 */

import type { AgentNode, ToolNode, TreeNode } from './events.js';
import { isAgentNode } from './events.js';

/**
 * The result of asking whether one running tool has gone quiet.
 *
 * `stalledSinceMs` is present **iff** `stalled` is true. It is the instant the
 * threshold was crossed — `lastActivityAt + thresholdMs` — and NOT the instant
 * the question happened to be asked. That matters for rendering: the elapsed
 * time shown to the user must not jump around with the poll cadence, and it
 * must be identical for two derivations of the same underlying state.
 */
export interface StallVerdict {
  readonly stalled: boolean;
  readonly stalledSinceMs?: number;
}

/** The one negative result, shared so every refusal path is the same object shape. */
const NOT_STALLED: StallVerdict = { stalled: false };

/**
 * Anything that carries a tool's status. Widened from {@link ToolNode} on
 * purpose: the derivation needs one field, so demanding a whole node would
 * force callers and tests to build irrelevant structure.
 */
export interface StallSubject {
  readonly status: ToolNode['status'];
}

/**
 * Is this tool stalled?
 *
 * @param tool           the node under test; only `status` is read
 * @param lastActivityAt epoch ms of the SESSION's last observed activity — the
 *                       later of the last hook event and the transcript mtime,
 *                       exactly as the liveness engine's `recent` rule computes
 *                       it. `null`/`undefined` means "never observed any", which
 *                       is not evidence of silence and returns `false`.
 * @param thresholdMs    `agentDeck.livenessThresholdMs`
 * @param now            the caller's clock, injected — this module reads none
 *
 * **The comparison is strictly greater than.** At exactly `thresholdMs` a tool
 * is NOT stalled, which keeps this boundary identical to the liveness engine's
 * own `recent` test rather than off by one from it.
 *
 * **Every unusable input returns `false`, never a stall.** G3 refuse-don't-guess,
 * resolved in the safe direction: inventing a stall paints an amber warning on
 * a healthy tool and teaches the user to distrust the signal, whereas missing
 * one leaves the product exactly where this phase found it. A wrong alarm costs
 * more than a missing one here.
 */
export function stallOf(
  tool: StallSubject,
  lastActivityAt: number | null | undefined,
  thresholdMs: number,
  now: number,
): StallVerdict {
  // Only a running tool can stall. A `done` or `error` tool has an outcome,
  // and silence after an outcome is just the session being over.
  if (tool.status !== 'running') return NOT_STALLED;

  if (lastActivityAt === null || lastActivityAt === undefined) return NOT_STALLED;

  // Non-finite guards. `Number.isFinite` rejects NaN and both infinities, and
  // NaN is the one that matters: every comparison against it is false, so an
  // unguarded NaN would silently mean "never stalled" and look like the rule
  // simply not firing.
  if (!Number.isFinite(lastActivityAt)) return NOT_STALLED;
  if (!Number.isFinite(thresholdMs)) return NOT_STALLED;
  if (!Number.isFinite(now)) return NOT_STALLED;

  // A non-positive threshold would make every running tool stalled the instant
  // it started. That is a misconfiguration, not an intention.
  if (thresholdMs <= 0) return NOT_STALLED;

  // A clock behind the last activity is a clock problem, not a stall. This
  // happens in practice: `lastActivityAt` can come from a filesystem mtime,
  // which is not guaranteed to agree with `Date.now()`.
  if (now < lastActivityAt) return NOT_STALLED;

  if (now - lastActivityAt <= thresholdMs) return NOT_STALLED;

  return { stalled: true, stalledSinceMs: lastActivityAt + thresholdMs };
}

/**
 * How long a stall has been visible, in ms, or `null` when it is not stalled.
 *
 * Separate from {@link stallOf} because the renderer needs a number and the
 * model needs a verdict, and deriving the elapsed time twice in two places is
 * how the two drift apart.
 */
export function stalledForMs(verdict: StallVerdict, now: number): number | null {
  if (!verdict.stalled) return null;
  const since = verdict.stalledSinceMs;
  if (since === undefined || !Number.isFinite(now)) return null;
  return Math.max(0, now - since);
}
/**
 * Promote every stalled `running` tool in a tree to `'stalled'`.
 *
 * **Returns the SAME node reference when nothing changed**, at every level.
 * Unchanged subtrees are shared rather than copied, so a tree with no stalls
 * allocates nothing and a tree with one stall reallocates only the spine down
 * to it. Rebuilding unconditionally would hand the differ a wholly new object
 * graph on every poll — the "a spawn adds, it never reflows" rule broken by
 * the assembly layer instead of by the layout.
 *
 * ---------------------------------------------------------------------------
 * THE NESTING FALLS OUT; IT IS NOT SPECIAL-CASED
 * ---------------------------------------------------------------------------
 * `lastActivityAt` is a property of the SESSION, not of a node. So when a
 * subagent goes silent, its own hung tool and the parent `Agent` spawn waiting
 * on it are both `running` against the same silence, and both promote in the
 * same pass. The corpus proves the pair: `toolu_018fuffcyA46w1xfU6Wpcj5z` (the
 * inner `Bash`) and `toolu_01NTu6y7z1wxWDtCDxMCQge4` (the outer `Agent`
 * spawn). A derivation that flagged only the child would leave a `running`
 * agent on the deck for ever — the reported defect, one level up.
 *
 * An `AgentNode`'s own status is deliberately NOT touched. The agent surface
 * is a BADGE COUNT of stalled descendants ({@link stalledCount}); adding a
 * fourth agent status would invent a value no producer writes.
 */
export function applyStalls(
  node: TreeNode,
  lastActivityAt: number | null | undefined,
  thresholdMs: number,
  now: number,
): TreeNode {
  let nextChildren: TreeNode[] | undefined;
  if (isAgentNode(node)) {
    const children = node.children;
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i] as TreeNode;
      const mapped = applyStalls(child, lastActivityAt, thresholdMs, now);
      if (mapped !== child && nextChildren === undefined) {
        nextChildren = children.slice(0, i) as TreeNode[];
      }
      if (nextChildren !== undefined) nextChildren.push(mapped);
    }
    if (nextChildren === undefined) return node;
    return { ...node, children: nextChildren as AgentNode['children'] };
  }

  const verdict = stallOf(node, lastActivityAt, thresholdMs, now);
  if (!verdict.stalled) return node;
  return { ...node, status: 'stalled', stalledSinceMs: verdict.stalledSinceMs };
}

/**
 * How many `'stalled'` tools sit at or beneath a node — the agent badge count.
 *
 * Derived on demand rather than stored on the node, for the same reason the
 * status is: a count written into the tree is a second copy of a fact that
 * moves with the clock.
 */
export function stalledCount(node: TreeNode): number {
  if (!isAgentNode(node)) return node.status === 'stalled' ? 1 : 0;
  let n = 0;
  for (const child of node.children) n += stalledCount(child as TreeNode);
  return n;
}

/**
 * {@link applyStalls} for a session root.
 *
 * The cast is safe and is confined here on purpose: the agent branch of
 * `applyStalls` only ever spreads its input, so an `AgentNode` in yields an
 * `AgentNode` out. Expressing that in the type system would need an overload
 * pair whose bodies are identical, which buys nothing a one-line comment does
 * not.
 */
export function applyStallsToRoot(
  root: AgentNode,
  lastActivityAt: number | null | undefined,
  thresholdMs: number,
  now: number,
): AgentNode {
  return applyStalls(root, lastActivityAt, thresholdMs, now) as AgentNode;
}
