// R5 / Phase 7 DoD 7.8 — the synthetic stress corpus: does the tree hold at
// scale, does the auto-collapse rule fire where it says it does, and what does
// one diff actually cost?
//
// WHAT IS SYNTHETIC HERE, AND WHY THAT IS ALLOWED
// -----------------------------------------------
// G6 pins the PARSER to fixtures harvested from real Claude Code sessions,
// because the JSONL layout is undocumented and drift-prone and a guessed shape
// is a guessed product. The renderer is a different case: it consumes
// `SessionState`, which is OUR type, defined in `src/model/events.ts` and
// produced only by our own grafter. Feeding it invented states is fuzzing our
// own contract, not guessing Claude Code's.
//
// The distinction has to survive on disk, which is what
// `SYNTHETIC_CORPUS_PREFIX` is for: `corpusFileName` REFUSES an id whose
// `synthetic-` prefix disagrees with its `kind`, in either direction, so an
// invented corpus can never be mistaken for evidence about CC. This file
// writes through that check rather than around it.
//
// THE CORPUS IS GENERATED HERE AND COMMITTED
// -------------------------------------------
// The generator is in this file because `scripts/` is not this package's to
// add to. It is deterministic — no clock, no randomness, coordinates and
// statuses derived from indices — and the committed file is compared against a
// fresh generation on every run, exactly the way `wire.test.ts` compares the
// recorded corpus. That comparison is a staleness detector, not a renderer
// regression: when it fails, regenerate with
//
//     AGENT_DECK_WRITE_SYNTHETIC_CORPUS=1 npx vitest run webview/stress
//
// and commit the result.
//
// It goes on the wire through the REAL `SessionBridge`, wrapped by
// `createRecorder` from `scripts/record-wire.mjs`. Nothing about the message
// framing is reimplemented here: a corpus that framed its own messages would
// prove the renderer survives a shape the host does not produce.
//
// WHAT PHASE 7 ADDED, AND WHY THE CORPUS GREW
// --------------------------------------------
// DoD 7.8 names a boundary: above `AUTO_COLLAPSE_NODES` VISIBLE nodes the tree
// collapses to `COLLAPSE_DEPTH` on its own and the status line says so. A rule
// with a boundary is only tested at the boundary, so the corpus now carries
// three sessions sized `AUTO_COLLAPSE_NODES - 1`, `AUTO_COLLAPSE_NODES` and
// `AUTO_COLLAPSE_NODES + 1` — 299, 300 and 301 today, and derived from the
// constant rather than written down, so moving the constant moves the corpus
// instead of silently making the boundary test measure the interior.
//
// VISIBLE nodes are AGENTS. `layout.ts:visibleNodeCount` walks
// `orderedChildAgents`, and `treeLayout` places agents; tool calls ride on
// their owning agent as dots. A boundary session is therefore an agent tree of
// exactly N agents, and it is built four levels deep on purpose: collapsing to
// depth 2 hides nothing at all in a flat tree, so a flat boundary session
// would have produced a green test that proved the rule never fires.
//
// TIMING IS A MEASUREMENT AND ALSO, NOW, A BUDGET
// ------------------------------------------------
// Through Phase 5 this file printed medians and asserted no threshold, on the
// argument that a wall-clock sample is a property of the machine rather than
// of the code — this repo has measured 6.49 s and 35.91 s for the same suite
// on the same machine. That argument is still true and the medians are still
// printed with their n.
//
// DoD 7.8 asks for one number anyway: a >= 300-node corpus must replay "within
// the perf budget". So `SCALE_BUDGETS` below is a table in the shape
// `src/perf/budgets.ts` uses, and every limit carries the measurement it was
// set from and the margin that leaves. The margins are large — one to two
// orders of magnitude — deliberately: what these budgets exist to catch is an
// algorithm that went quadratic in the node count, not a machine that was busy.
// A limit tight enough to go red on load would be re-tuned rather than
// believed, which is how a budget stops meaning anything.
//
// A NODE SUITE, NOT A JSDOM ONE. `scripts/record-wire.mjs` imports esbuild at
// module scope, and esbuild refuses to start in a jsdom realm (jsdom installs
// its own `Uint8Array`, so esbuild's startup invariant fails — see
// `webview/build-harness.mjs`). The DOM half below is therefore a hand-built
// JSDOM, the same arrangement `wire.test.ts` uses for the theater page.
//
// Node builtins are imported by their real specifiers: `tsconfig.webview.json`
// sets `types: []`, which removes node's GLOBALS from this project but does not
// stop an explicit `node:*` import resolving.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type {
  AgentNode,
  HostToWebviewMessage,
  SessionPatch,
  SessionState,
  SpawnEdge,
  ToolNode,
  TreeNode,
  TreeOp,
} from '../src/model/events.js';
import { isAgentNode } from '../src/model/events.js';
import { applySessionPatch } from '../src/bridge/apply.js';
import { SYNTHETIC_CORPUS_PREFIX, TESTID, WIRE_CORPUS_DIR } from './canvas-contract.js';
import {
  AUTO_COLLAPSE_NODES,
  COLLAPSE_DEPTH,
  autoCollapseDepth,
  countNodes,
  deckEngine,
  deckLayout,
  treeLayout,
  visibleNodeCount,
} from './layout.js';
import type { DeckSession, DeckStatus } from './layout.js';
import { createStore } from './store.js';
import type { SessionSummary } from './store.js';
import type { WireCorpus, WireEvent } from './theater/corpus-types.js';
import { bundleHarness } from './testkit.js';

/**
 * Opaque specifiers. The dodge `testkit.ts` documents: a literal would make
 * `tsc` demand declarations for a `.mjs` build script and for jsdom, neither of
 * which either tsconfig project includes. Resolved at runtime by vitest.
 */
const RECORDER_MODULE = '../scripts/record-wire.mjs';
const JSDOM_MODULE = 'jsdom';

interface RecorderModule {
  WIRE_FORMAT_VERSION: number;
  loadHostModules(): Promise<unknown>;
  createRecorder(host: unknown): {
    bridge: {
      publish(emission: {
        sessions: readonly SessionState[];
        diffs: readonly { sessionId: string; patch: SessionPatch }[];
        addedSessionIds: readonly string[];
        removedSessionIds: readonly string[];
        schemaMismatchSessionIds: readonly string[];
      }): void;
      publishDegraded(state: { degraded: boolean; reason?: 'noHookEvents' | 'listenerDown' }): void;
    };
    events: WireEvent[];
    steps: { atMs: number; label: string; what: string }[];
    step(atMs: number, label: string, what: string): void;
  };
  corpusFileName(corpus: { id: string; kind: string }): Promise<string>;
  writeCorpus(outDir: string, corpus: unknown): Promise<string>;
}

/* ------------------------------------------------------------------------ *
 * The shape of the stress case
 * ------------------------------------------------------------------------ */

const CORPUS_ID = `${SYNTHETIC_CORPUS_PREFIX}stress`;
const COMMITTED_PATH = resolve(WIRE_CORPUS_DIR, `${CORPUS_ID}.json`);

/**
 * Healthy sessions. The DoD floor is 12; this is exactly 12 rather than
 * comfortably more, because a stress corpus that is bigger than it needs to be
 * costs every future run of this suite and every future reader's diff.
 */
const HEALTHY_SESSIONS = 12;

/**
 * Tool calls on each agent's own arc, indexed by spawn depth, and subagents
 * spawned by each, likewise. Two arrays rather than a recursion depth so the
 * shape is one reviewable table and the arithmetic below can be checked by
 * hand: 1 + 5 + 2*(1 + 4) + 2*(1 + 3) + 2*(1 + 2) = 30 nodes per session.
 *
 * The deepest entry with a non-zero child count fixes the maximum spawn depth
 * at 3. It is asserted from the generated tree, never from this comment.
 */
const TOOLS_AT_DEPTH = [5, 4, 3, 2] as const;
const CHILDREN_AT_DEPTH = [2, 1, 1, 0] as const;

/**
 * The three sizes that surround the auto-collapse boundary.
 *
 * DERIVED from `AUTO_COLLAPSE_NODES`, never typed as 299/300/301. The rule is
 * strictly-greater — `layout.ts:autoCollapseDepth` — so the middle one is the
 * largest tree that still renders whole and the last is the smallest that does
 * not. A literal here would keep passing while the constant moved, testing the
 * middle of the range and calling it the edge.
 */
const BOUNDARY_TARGETS = [
  AUTO_COLLAPSE_NODES - 1,
  AUTO_COLLAPSE_NODES,
  AUTO_COLLAPSE_NODES + 1,
] as const;

/**
 * Branching of a boundary session, and its deepest agent depth.
 *
 * FANOUT ** (DEPTH + 1) must exceed the largest target or the generator cannot
 * reach the size it was asked for; 8 and 3 give a capacity of 1 + 8 + 64 + 512
 * = 585 against a largest target of `AUTO_COLLAPSE_NODES + 1`. Depth 3 is the
 * shallowest tree in which collapsing to `COLLAPSE_DEPTH` (2) hides anything
 * at all, which is the whole reason the boundary sessions are not flat.
 */
const BOUNDARY_FANOUT = 8;
const BOUNDARY_DEPTH = 3;

/** Diff ticks after the cold start. Each one patches every healthy session. */
const TICKS = 8;

/** Simulated milliseconds between ticks. Fixed; there is no clock in here. */
const TICK_MS = 5_000;

/* ------------------------------------------------------------------------ *
 * The generator — pure, deterministic, no clock and no randomness
 * ------------------------------------------------------------------------ */

/** A tool's status at generation time, cycled by index rather than drawn. */
function initialToolStatus(index: number): ToolNode['status'] {
  if (index % 7 === 3) return 'error';
  if (index % 3 === 0) return 'running';
  return 'done';
}

function buildAgent(
  sessionId: string,
  path: string,
  depth: number,
  edges: SpawnEdge[],
  counter: { n: number },
): AgentNode {
  const id = depth === 0 ? 'root' : `${sessionId}-agent-${path}`;
  const toolCount = TOOLS_AT_DEPTH[depth] ?? 0;
  const childCount = CHILDREN_AT_DEPTH[depth] ?? 0;
  const children: TreeNode[] = [];

  for (let i = 0; i < toolCount; i += 1) {
    counter.n += 1;
    const spawning = i < childCount;
    const tool: ToolNode = {
      id: `${sessionId}-tool-${path}-${i}`,
      toolName: spawning ? 'Agent' : ['Read', 'Bash', 'Grep', 'Edit'][i % 4] ?? 'Read',
      status: spawning ? 'running' : initialToolStatus(counter.n),
      inputPreview: `{"n":${counter.n}}`,
    };
    if (tool.status !== 'running') tool.durationMs = 100 + (counter.n % 900);
    children.push(tool);

    if (!spawning) continue;
    const child = buildAgent(sessionId, `${path}${i}`, depth + 1, edges, counter);
    edges.push({
      toolUseId: tool.id,
      agentId: child.id,
      parentNodeId: id,
      depth: depth + 1,
      recordedDepth: depth + 1,
    });
    children.push(child);
  }

  return {
    id,
    kind: depth === 0 ? 'main' : 'subagent',
    label: depth === 0 ? `main ${sessionId}` : `worker ${path}`,
    status: 'running',
    spawnDepth: depth,
    children,
    contextNow: { prompt: 100 * (depth + 1), output: 10 * (depth + 1) },
    burn: { prompt: 200 * (depth + 1), output: 20 * (depth + 1) },
    startedAt: 1_000 * (depth + 1),
  };
}

/** One healthy synthetic session. */
function syntheticSession(index: number): SessionState {
  const sessionId = `syn-${String(index).padStart(2, '0')}`;
  const edges: SpawnEdge[] = [];
  const root = buildAgent(sessionId, '', 0, edges, { n: index * 1_000 });
  const state: SessionState = {
    sessionId,
    projectSlug: 'synthetic-stress-slug',
    workspaceMatch: index % 6 !== 5,
    liveness: (['live', 'idle', 'ended'] as const)[index % 3] ?? 'live',
    schemaOk: true,
    root,
    totals: { costUsd: 0 },
    contextNow: { prompt: 1_000 * (index + 1), output: 100 * (index + 1) },
    burn: { prompt: 2_000 * (index + 1), output: 200 * (index + 1) },
    spawnEdges: edges,
  };
  // One session carries a parked graft — the state that has no node in the
  // tree at all, and the one a tree walk can never reach.
  if (index === 1) {
    return {
      ...state,
      parked: [
        {
          agentId: `${sessionId}-agent-unjoined`,
          code: 'noMatchingToolUse',
          reason: 'synthetic: the sidecar named a tool_use id in no transcript',
        },
      ],
    };
  }
  return state;
}

/**
 * A session whose tree holds EXACTLY `target` agent nodes, root included.
 *
 * Breadth first at a fixed fanout, capped at `BOUNDARY_DEPTH`, so the shape is
 * a function of one number and nothing else. The exactness is the point: this
 * is the input to a strictly-greater comparison, and a generator that
 * overshot by one would move the boundary rather than probe it. Asserted from
 * the generated tree by `visibleNodeCount`, never trusted from here.
 *
 * NO TOKENS ON THESE AGENTS, deliberately. `contextNow` and `burn` are
 * optional and the OpenCode engine reports neither, so leaving them unset puts
 * the em-dash path — the one a wrong default would render as `0` — under the
 * same replay that measures the scale. The twelve healthy sessions carry real
 * figures, so the corpus asserts both halves rather than only the absent one.
 */
function boundaryAgentTree(sessionId: string, target: number): AgentNode {
  const root: AgentNode = {
    id: 'root',
    kind: 'main',
    label: `main ${sessionId}`,
    status: 'running',
    spawnDepth: 0,
    children: [],
    startedAt: 1_000,
  };
  let made = 1;
  // The frontier is the agents that may still take children, in creation
  // order, which is what makes the fill breadth first and therefore a pure
  // function of `target`.
  let frontier: AgentNode[] = [root];
  for (let depth = 1; depth <= BOUNDARY_DEPTH && made < target; depth += 1) {
    const next: AgentNode[] = [];
    for (const parent of frontier) {
      for (let i = 0; i < BOUNDARY_FANOUT && made < target; i += 1) {
        const child: AgentNode = {
          id: `${sessionId}-a${String(made).padStart(3, '0')}`,
          kind: 'subagent',
          label: `w${String(depth)}.${String(i)}`,
          status: made % 5 === 0 ? 'running' : 'done',
          spawnDepth: depth,
          children: [],
          startedAt: 1_000 * (depth + 1),
        };
        parent.children.push(child);
        next.push(child);
        made += 1;
      }
    }
    frontier = next;
  }
  if (made !== target) {
    throw new Error(
      `boundary tree for ${sessionId} holds ${String(made)} agents, not ${String(target)}: ` +
        `raise BOUNDARY_FANOUT or BOUNDARY_DEPTH`,
    );
  }
  return root;
}

/** The id a boundary session of this size carries. Sorts inside the deck. */
function boundaryId(target: number): string {
  return `syn-b${String(target)}`;
}

function boundarySession(target: number): SessionState {
  const sessionId = boundaryId(target);
  return {
    sessionId,
    projectSlug: 'synthetic-stress-slug',
    workspaceMatch: true,
    liveness: 'live',
    schemaOk: true,
    root: boundaryAgentTree(sessionId, target),
    totals: { costUsd: 0 },
    // No session-level tokens either, for the reason `boundaryAgentTree`
    // gives: this is the shape the second engine produces.
    spawnEdges: [],
  };
}

/** True for the three sessions that sit on the auto-collapse boundary. */
function isBoundary(state: SessionState): boolean {
  return BOUNDARY_TARGETS.some((t) => boundaryId(t) === state.sessionId);
}

/** The refused session: a real product state, and it must survive the storm. */
function refusedSession(): SessionState {
  return {
    sessionId: 'syn-refused',
    projectSlug: 'synthetic-stress-slug',
    workspaceMatch: true,
    liveness: 'unsupported',
    schemaOk: false,
    root: {
      id: 'root',
      kind: 'main',
      label: 'main syn-refused',
      status: 'done',
      spawnDepth: 0,
      children: [],
      contextNow: { prompt: 0, output: 0 }, burn: { prompt: 0, output: 0 },
      startedAt: 1_000,
    },
    totals: { costUsd: 0 }, contextNow: { prompt: 0, output: 0 }, burn: { prompt: 0, output: 0 },
    spawnEdges: [],
  };
}

/** Every tool node of a state, in tree order. */
function toolsOf(state: SessionState): ToolNode[] {
  const out: ToolNode[] = [];
  const visit = (node: TreeNode): void => {
    if (!isAgentNode(node)) {
      out.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(state.root);
  return out;
}

/**
 * The patch a BOUNDARY session takes on one tick.
 *
 * Scalars only — never `insertNode`, never `removeNode`. The whole value of
 * these three sessions is that their agent count is exactly 299, 300 and 301
 * at every point in the arc, so a membership op would move the boundary
 * mid-replay and the collapse assertion would be about whatever the tree
 * happened to be by then. They still carry diffs, because a boundary that only
 * holds in the opening snapshot is a boundary the replay never tested.
 */
function boundaryTickPatch(tick: number): SessionPatch | undefined {
  if (tick % 2 !== 0) return undefined;
  return {
    tree: [
      {
        op: 'updateAgent',
        id: 'root',
        fields: { status: tick % 4 === 0 ? 'running' : 'done' },
      },
    ],
  };
}

/**
 * The patch for one session on one tick.
 *
 * Real ops only — `updateTool`, `updateAgent`, `insertNode` and a `fields`
 * replacement — and every one of them is applied through the REAL
 * `applySessionPatch` below, so a patch this generator cannot express fails
 * here rather than producing a corpus the store silently stalls on.
 */
function tickPatch(state: SessionState, tick: number): SessionPatch | undefined {
  if (isBoundary(state)) return boundaryTickPatch(tick);

  const tree: TreeOp[] = [];

  // Settle one running tool per tick, deterministically chosen.
  const running = toolsOf(state).filter((t) => t.status === 'running');
  const settling = running[tick % Math.max(running.length, 1)];
  if (settling !== undefined) {
    tree.push({
      op: 'updateTool',
      id: settling.id,
      fields: { status: 'done', durationMs: 250 + tick * 17, resultPreview: `ok ${tick}` },
    });
  }

  // Grow the tree on one tick, so the corpus exercises the incremental path
  // the layout's whole promise is stated in terms of.
  if (tick === 3) {
    tree.push({
      op: 'insertNode',
      parentId: 'root',
      // DoD 5.5.1: anchor on the current last child rather than naming a
      // position in the receiver's array.
      afterId: state.root.children[state.root.children.length - 1]?.id ?? null,
      node: {
        id: `${state.sessionId}-tool-late`,
        toolName: 'Bash',
        status: 'running',
        inputPreview: '{"late":true}',
      },
    });
  }
  if (tick === 5) {
    tree.push({
      op: 'updateAgent',
      id: 'root',
      fields: { contextNow: { prompt: 100 + tick * 10, output: 10 + tick } },
    });
  }

  if (tree.length === 0) return undefined;
  return {
    fields: {
      contextNow: {
        prompt: (state.contextNow?.prompt ?? 0) + tick,
        output: (state.contextNow?.output ?? 0) + tick,
      },
    },
    tree,
  };
}

interface Generated {
  corpus: WireCorpus;
  /** The states the arc converges on, tracked by applying every patch. */
  final: SessionState[];
}

async function generate(recorder: RecorderModule): Promise<Generated> {
  const host = await recorder.loadHostModules();
  const rec = recorder.createRecorder(host);

  let current: SessionState[] = [
    ...Array.from({ length: HEALTHY_SESSIONS }, (_, i) => syntheticSession(i)),
    ...BOUNDARY_TARGETS.map((target) => boundarySession(target)),
    refusedSession(),
  ].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  const ids = current.map((s) => s.sessionId);

  rec.step(0, 'cold-start', `${ids.length} sessions arrive at once, one of them refused`);
  rec.bridge.publish({
    sessions: current,
    diffs: [],
    addedSessionIds: ids,
    removedSessionIds: [],
    schemaMismatchSessionIds: current.filter((s) => !s.schemaOk).map((s) => s.sessionId),
  });
  rec.bridge.publishDegraded({ degraded: true, reason: 'noHookEvents' });

  for (let tick = 0; tick < TICKS; tick += 1) {
    rec.step(
      (tick + 1) * TICK_MS,
      `tick-${tick}`,
      'one patch per healthy session: a tool settles, and on two ticks the tree grows',
    );
    const diffs: { sessionId: string; patch: SessionPatch }[] = [];
    const next: SessionState[] = [];
    for (const state of current) {
      const patch = state.schemaOk ? tickPatch(state, tick) : undefined;
      if (patch === undefined) {
        next.push(state);
        continue;
      }
      diffs.push({ sessionId: state.sessionId, patch });
      next.push(applySessionPatch(state, patch));
    }
    current = next;
    rec.bridge.publish({
      sessions: current,
      diffs,
      addedSessionIds: [],
      removedSessionIds: [],
      schemaMismatchSessionIds: [],
    });
    if (tick === TICKS - 1) rec.bridge.publishDegraded({ degraded: false });
  }

  const lastEvent = rec.events[rec.events.length - 1];
  const corpus: WireCorpus = {
    formatVersion: recorder.WIRE_FORMAT_VERSION,
    id: CORPUS_ID,
    kind: 'synthetic',
    title: 'synthetic stress — many sessions, deep trees, a storm of diffs',
    description: [
      'INVENTED, not recorded. Every SessionState here was constructed by',
      'webview/stress.test.ts, put on the wire through a real SessionBridge, and',
      'carries no bytes from any Claude Code transcript. The `synthetic-` prefix is',
      'what keeps it distinguishable from evidence about CC on disk (G6). Three of the',
      'sessions sit on the auto-collapse boundary and are sized from AUTO_COLLAPSE_NODES.',
    ].join(' '),
    producedBy: 'webview/stress.test.ts',
    durationMs: lastEvent === undefined ? 0 : lastEvent.atMs,
    steps: rec.steps,
    events: rec.events,
    final: {
      sessions: JSON.parse(JSON.stringify(current)) as SessionState[],
      degraded: { degraded: false },
      schemaMismatchSessionIds: current.filter((s) => !s.schemaOk).map((s) => s.sessionId).sort(),
    },
  };

  return { corpus, final: current };
}

/* ------------------------------------------------------------------------ *
 * Statistics — a median with its n, never a point value
 * ------------------------------------------------------------------------ */

interface Stats {
  n: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
}

function stats(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { n: 0, medianMs: 0, minMs: 0, maxMs: 0 };
  const mid = Math.floor(n / 2);
  const median =
    n % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return { n, medianMs: median, minMs: sorted[0] ?? 0, maxMs: sorted[n - 1] ?? 0 };
}

function ms(value: number): string {
  return value.toFixed(4);
}

/* ------------------------------------------------------------------------ *
 * The budgets (DoD 7.8)
 * ------------------------------------------------------------------------ */

/**
 * One wall-clock limit, with the measurement it was set from.
 *
 * The shape `src/perf/budgets.ts` uses, restated here rather than imported,
 * and the reason is the DoD's: `src/perf/perf.test.ts` is the suite's critical
 * path at ~31-42 s and this package was told not to touch it. What this table
 * measures is also a different thing — the WEBVIEW's reducer and layout, with
 * no filesystem anywhere in it — so it would not have belonged in that file
 * even if it had been ours to edit.
 */
interface ScaleBudget {
  id: string;
  what: string;
  limitMs: number;
  measured: { valueMs: number; on: string; marginX: number; note: string };
}

/**
 * MEASURED on the Windows 11 development machine on 2026-08-28, running this
 * file through
 *
 *     node node_modules/vitest/vitest.mjs run webview/stress.test.ts \
 *       webview/wire.test.ts webview/timed-replay.test.ts
 *
 * Every `valueMs` is the MEDIAN this file printed on the run each limit was set
 * from, and the count of runs behind each is ONE. That is stated rather than
 * dressed up: a single run is enough to size a tripwire two orders of magnitude
 * above it and is not enough to claim a distribution, and the medians are
 * re-printed on every run so the next reader compares against a number rather
 * than against this comment.
 *
 * THE MARGINS ARE ENORMOUS ON PURPOSE, and the reason is recorded in this
 * repository rather than guessed. A wall-clock stage here measured 12.3 ms as
 * its own process and 1050.6 ms inside a fifty-file vitest run — a factor of
 * 85 that no ordering inside the run could reach, and that was diagnosed twice
 * before it was understood. A budget set close to a solo measurement therefore
 * goes red on the full-suite run and gets widened, which is how a budget stops
 * meaning anything. These are sized so that only a CHANGE IN COMPLEXITY can
 * trip them: `treeLayout` is a subtree-width pass that must stay linear in the
 * drawn node count, and one that went quadratic on a 301-node tree would blow
 * a 40x margin without anybody having to guess the right tight number.
 */
const SCALE_BUDGETS: readonly ScaleBudget[] = [
  {
    id: 'replay.perDiff',
    what: 'one diff: store.handleMessage + getView + deckLayout(all) + treeLayout(selected)',
    limitMs: 25,
    measured: {
      valueMs: 0.234,
      on: 'the committed synthetic-stress corpus, 16 sessions / 1,273 nodes, n=108 diffs',
      marginX: 106.8,
      note:
        'The stage this budget guards is per-diff work that must not grow with the ' +
        'number of sessions the store holds; the identity-based test below asserts ' +
        'that property without a clock, and this one prices it. The median splits ' +
        'roughly 0.17 getView / 0.04 treeLayout / 0.015 handleMessage / 0.005 deck.',
    },
  },
  {
    id: 'replay.cold',
    what: 'every corpus event into a fresh store, then a deck layout and a tree layout each',
    limitMs: 2_000,
    measured: {
      valueMs: 19.564,
      on: 'the committed synthetic-stress corpus, 16 sessions / 1,273 nodes, n=5 replays',
      marginX: 102.2,
      note:
        "DoD 7.8's own sentence, priced: a >= 300-node corpus replayed and laid out " +
        'end to end. Includes the three boundary sessions at their auto-collapse ' +
        'depth, and drew 756 nodes on the run this was set from.',
    },
  },
  {
    id: 'layout.boundaryTree',
    what: 'treeLayout of the largest boundary session, uncollapsed',
    limitMs: 200,
    measured: {
      valueMs: 4.541,
      on: 'AUTO_COLLAPSE_NODES + 1 agents, four levels deep, n=20 layouts',
      marginX: 44.0,
      note:
        'The whole tree, collapseDepth Infinity, which is the work the auto-collapse ' +
        'rule exists to avoid asking a renderer to draw. Measured anyway: the rule is ' +
        'about what a HUMAN can read, and a layout that could not compute it would ' +
        'make the rule load-bearing for correctness rather than for legibility.',
    },
  },
];

function budget(id: string): ScaleBudget {
  const found = SCALE_BUDGETS.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no scale budget named ${id}`);
  return found;
}

/* ------------------------------------------------------------------------ *
 * Fixtures for the suite
 * ------------------------------------------------------------------------ */

let recorder: RecorderModule;
let generated: Generated;
let committed: WireCorpus;
/** Derived from the generated corpus. Printed; never written down as a literal. */
let facts: {
  sessions: number;
  nodes: number;
  maxDepth: number;
  diffs: number;
  /** The largest VISIBLE (agent) count of any one session in the corpus. */
  largestTree: number;
};

/** The final state of one session, by id. Throws rather than returning undefined. */
function finalOf(sessionId: string): SessionState {
  const found = generated.final.find((s) => s.sessionId === sessionId);
  if (found === undefined) throw new Error(`the corpus holds no session ${sessionId}`);
  return found;
}

/**
 * `SessionSummary` to `layout.ts:DeckSession`, for the COST measurement below.
 *
 * `Deck.svelte` owns the product mapping and this is not a second copy of it
 * being asserted against: nothing here checks a placement, only how long
 * `deckLayout` takes over the visible set, which is a function of the array
 * length and the sort. The one part that IS a shared rule — engine absence
 * reads as `cc` — goes through `layout.ts:deckEngine` rather than being
 * restated.
 */
function toDeck(row: SessionSummary): DeckSession {
  const status: DeckStatus = row.refused ? 'unsupported' : row.liveness;
  return { id: row.sessionId, engine: deckEngine(row.engine), status, last: row.lastEventAt };
}

beforeAll(async () => {
  recorder = (await import(/* @vite-ignore */ RECORDER_MODULE)) as unknown as RecorderModule;
  generated = await generate(recorder);

  // The only write this package makes, and only when explicitly asked. G1 is
  // about `~/.claude` and CC's files; this writes one committed artifact
  // inside the repo, the same way the layout goldens are regenerated.
  const write = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.['AGENT_DECK_WRITE_SYNTHETIC_CORPUS'];
  if (write === '1') {
    await recorder.writeCorpus(resolve(WIRE_CORPUS_DIR), generated.corpus);
  }

  committed = JSON.parse(await readFile(COMMITTED_PATH, 'utf8')) as WireCorpus;

  let nodes = 0;
  let maxDepth = 0;
  let largestTree = 0;
  for (const state of generated.final) {
    nodes += countNodes(state);
    largestTree = Math.max(largestTree, visibleNodeCount(state, state.root.id));
    const visit = (node: TreeNode): void => {
      if (!isAgentNode(node)) return;
      if (node.spawnDepth > maxDepth) maxDepth = node.spawnDepth;
      for (const child of node.children) visit(child);
    };
    visit(state.root);
  }
  facts = {
    sessions: generated.final.length,
    nodes,
    maxDepth,
    largestTree,
    diffs: generated.corpus.events.filter((e) => e.message.type === 'diff').length,
  };
}, 180_000);

/* ------------------------------------------------------------------------ *
 * 1. The corpus is what it claims to be
 * ------------------------------------------------------------------------ */

describe('the synthetic stress corpus', () => {
  it('meets the scale the DoD names, measured off the corpus itself', () => {
    console.log(
      `[stress] ${CORPUS_ID}: sessions=${facts.sessions} nodes=${facts.nodes} ` +
        `maxSpawnDepth=${facts.maxDepth} largestTree=${facts.largestTree} ` +
        `diffEvents=${facts.diffs}`,
    );
    expect(facts.sessions).toBeGreaterThanOrEqual(12);
    // DoD 7.8's floor, and the corpus clears it in one SESSION as well as in
    // aggregate — a 300-node total spread over twelve trees would say nothing
    // about a tree the renderer has to draw at once.
    expect(facts.nodes).toBeGreaterThanOrEqual(300);
    expect(facts.largestTree).toBeGreaterThan(AUTO_COLLAPSE_NODES);
    expect(facts.maxDepth).toBe(3);
    expect(facts.diffs).toBeGreaterThan(0);
  });

  it('carries a session on each side of the auto-collapse boundary, exactly sized', () => {
    // The sizes are asserted from the TREE, not from the generator's argument:
    // a generator that overshot by one would move the boundary and every
    // collapse assertion below would be about the interior of the range.
    for (const target of BOUNDARY_TARGETS) {
      const state = finalOf(boundaryId(target));
      expect(visibleNodeCount(state, state.root.id), boundaryId(target)).toBe(target);
    }
    expect([...BOUNDARY_TARGETS]).toStrictEqual([
      AUTO_COLLAPSE_NODES - 1,
      AUTO_COLLAPSE_NODES,
      AUTO_COLLAPSE_NODES + 1,
    ]);
  });

  it('names itself synthetic, with the prefix that makes that permanent', async () => {
    expect(generated.corpus.kind).toBe('synthetic');
    expect(generated.corpus.id.startsWith(SYNTHETIC_CORPUS_PREFIX)).toBe(true);
    expect(generated.corpus.recordedFrom).toBeUndefined();
    // Through the recorder's own check, not a re-implementation of it.
    await expect(recorder.corpusFileName(generated.corpus)).resolves.toBe(`${CORPUS_ID}.json`);
    await expect(
      recorder.corpusFileName({ id: 'stress', kind: 'synthetic' }),
    ).rejects.toThrow(/prefix/);
  });

  it('matches what is committed under the corpus directory', () => {
    // Staleness detection, the same shape `wire.test.ts` uses for the recorded
    // corpus. If this fails, regenerate with
    // `AGENT_DECK_WRITE_SYNTHETIC_CORPUS=1 npx vitest run webview/stress`.
    // It is NOT a renderer regression on its own.
    expect(committed.id).toBe(generated.corpus.id);
    expect(committed.events.length).toBe(generated.corpus.events.length);
    expect(JSON.stringify(committed)).toBe(JSON.stringify(generated.corpus));
  });

  it('is deterministic: generating it twice yields identical bytes', async () => {
    const again = await generate(recorder);
    expect(JSON.stringify(again.corpus)).toBe(JSON.stringify(generated.corpus));
  });

  it('carries both wire paths and no wall clock', () => {
    const types = generated.corpus.events.map((e) => e.message.type);
    expect(types.filter((t) => t === 'snapshot').length).toBeGreaterThanOrEqual(1);
    expect(types.filter((t) => t === 'diff').length).toBeGreaterThan(0);
    expect(types).toContain('schemaMismatch');
    expect(types).toContain('degraded');

    expect(generated.corpus.events[0]?.atMs).toBe(0);
    let previous = -1;
    for (const event of generated.corpus.events) {
      expect(Number.isInteger(event.atMs)).toBe(true);
      expect(event.atMs).toBeGreaterThanOrEqual(previous);
      previous = event.atMs;
    }
    expect(generated.corpus.durationMs).toBe(previous);
    expect(JSON.stringify(generated.corpus)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });

  it('carries no host path and no captured content', () => {
    // Not a privacy claim about fixtures — there are none in here — but the
    // property that makes that true and keeps it true.
    const body = JSON.stringify(generated.corpus);
    expect(body).not.toMatch(/[A-Za-z]:\\\\/);
    expect(body).not.toMatch(/\/(?:home|Users)\//);
    expect(body).not.toContain('"thinking"');
    expect(body).not.toContain('"signature"');
  });
});

/* ------------------------------------------------------------------------ *
 * 2. The store converges, and what one diff costs
 * ------------------------------------------------------------------------ */

describe('the store under the storm', () => {
  it('converges on the generator’s own final states', () => {
    // The independence that makes the measurement below meaningful: if the
    // replay stalled, every per-diff timing would be the cost of doing nothing.
    const store = createStore();
    for (const event of generated.corpus.events) {
      store.handleMessage(event.message as HostToWebviewMessage);
    }
    const view = store.getView();
    expect(view.patchFailure).toBeUndefined();
    expect(view.sessions.map((s) => s.sessionId)).toStrictEqual(
      generated.final.map((s) => s.sessionId),
    );
    for (const state of generated.final) {
      const summary = view.sessions.find((s) => s.sessionId === state.sessionId);
      expect(summary?.refused).toBe(!state.schemaOk);
      // A refused session reports 0 nodes (G3): no number is read off a layout
      // we declined to trust.
      expect(summary?.nodeCount).toBe(state.schemaOk ? countNodes(state) : 0);
    }
  });

  it('records store and layout time per diff as a number, inside a budget', () => {
    const store = createStore();
    const handleSamples: number[] = [];
    const viewSamples: number[] = [];
    const layoutSamples: number[] = [];
    const deckSamples: number[] = [];

    for (const event of generated.corpus.events) {
      const message = event.message as HostToWebviewMessage;
      if (message.type !== 'diff') {
        store.handleMessage(message);
        continue;
      }
      // Untimed: point the store at the session this diff is about, so the
      // layout below is the layout of the tree that just changed.
      store.selectSession(message.sessionId);

      const t0 = performance.now();
      store.handleMessage(message);
      const t1 = performance.now();
      const view = store.getView();
      const t2 = performance.now();
      deckLayout(view.sessions.map(toDeck), 'grid', 'live', 1_200);
      const t3 = performance.now();
      const selected = view.selected;
      if (selected !== undefined) {
        treeLayout(selected, selected.root.id, {
          collapseDepth: autoCollapseDepth(selected, selected.root.id),
        });
      }
      const t4 = performance.now();

      handleSamples.push(t1 - t0);
      viewSamples.push(t2 - t1);
      deckSamples.push(t3 - t2);
      layoutSamples.push(t4 - t3);
    }

    const handle = stats(handleSamples);
    const view = stats(viewSamples);
    const deck = stats(deckSamples);
    const layout = stats(layoutSamples);
    const total = stats(
      handleSamples.map(
        (h, i) => h + (viewSamples[i] ?? 0) + (deckSamples[i] ?? 0) + (layoutSamples[i] ?? 0),
      ),
    );

    console.log(
      `[stress] per diff, over ${facts.sessions} sessions / ${facts.nodes} nodes ` +
        `(n=${total.n}, medians in ms):`,
    );
    console.log(`[stress]   store.handleMessage  median ${ms(handle.medianMs)}  ` +
      `min ${ms(handle.minMs)}  max ${ms(handle.maxMs)}`);
    console.log(`[stress]   store.getView        median ${ms(view.medianMs)}  ` +
      `min ${ms(view.minMs)}  max ${ms(view.maxMs)}`);
    console.log(`[stress]   deckLayout(all)      median ${ms(deck.medianMs)}  ` +
      `min ${ms(deck.minMs)}  max ${ms(deck.maxMs)}`);
    console.log(`[stress]   treeLayout(selected) median ${ms(layout.medianMs)}  ` +
      `min ${ms(layout.minMs)}  max ${ms(layout.maxMs)}`);
    console.log(`[stress]   store + layout TOTAL median ${ms(total.medianMs)}  ` +
      `min ${ms(total.minMs)}  max ${ms(total.maxMs)}`);

    // The numbers are real numbers over a real sample. This is the assertion
    // that keeps the series from being an adjective.
    expect(total.n).toBe(facts.diffs);
    expect(total.n).toBeGreaterThan(30);
    expect(Number.isFinite(total.medianMs)).toBe(true);
    expect(total.medianMs).toBeGreaterThanOrEqual(0);

    // And DoD 7.8's budget, on the MEDIAN rather than on any single sample.
    const b = budget('replay.perDiff');
    console.log(`[stress]   budget ${b.id}: ${ms(total.medianMs)} against ${String(b.limitMs)} ms`);
    expect(total.medianMs).toBeLessThan(b.limitMs);
  });

  it('per-diff work does not grow with the number of sessions held', () => {
    // The property behind the number, and the one that IS machine-independent:
    // a diff names one session, and applying it must touch that session alone.
    // Measured by counting object identities that survive the patch rather
    // than by timing, so it cannot flap.
    const store = createStore();
    const snapshot = generated.corpus.events.find((e) => e.message.type === 'snapshot');
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) return;
    store.handleMessage(snapshot.message as HostToWebviewMessage);

    const before = new Map<string, unknown>();
    for (const id of generated.final.map((s) => s.sessionId)) {
      store.selectSession(id);
      before.set(id, store.getView().selected);
    }

    const firstDiff = generated.corpus.events.find((e) => e.message.type === 'diff');
    expect(firstDiff).toBeDefined();
    if (firstDiff === undefined) return;
    const target = (firstDiff.message as { sessionId: string }).sessionId;
    store.handleMessage(firstDiff.message as HostToWebviewMessage);

    let changed = 0;
    for (const [id, previous] of before) {
      store.selectSession(id);
      if (store.getView().selected !== previous) changed += 1;
    }
    expect(changed).toBe(1);
    store.selectSession(target);
    expect(store.getView().selected).not.toBe(before.get(target));
  });
});

/* ------------------------------------------------------------------------ *
 * 3. Scale: the whole replay, and the collapse boundary (DoD 7.8)
 * ------------------------------------------------------------------------ */

/** Replay every event into a fresh store and lay out everything it holds. */
function replayAndLayOut(): { sessions: number; drawn: number } {
  const store = createStore();
  for (const event of generated.corpus.events) {
    store.handleMessage(event.message as HostToWebviewMessage);
  }
  const view = store.getView();
  deckLayout(view.sessions.map(toDeck), 'grid', 'live', 1_200);

  let drawn = 0;
  for (const state of generated.final) {
    if (!state.schemaOk) continue;
    const rootId = state.root.id;
    const placements = treeLayout(state, rootId, {
      collapseDepth: autoCollapseDepth(state, rootId),
    });
    drawn += placements.filter((p) => !p.hidden).length;
  }
  return { sessions: view.sessions.length, drawn };
}

describe('scale (DoD 7.8)', () => {
  it('replays and lays out the whole corpus inside the cold-replay budget', () => {
    const samples: number[] = [];
    let last = { sessions: 0, drawn: 0 };
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      last = replayAndLayOut();
      samples.push(performance.now() - t0);
    }
    const cold = stats(samples);
    const b = budget('replay.cold');
    console.log(
      `[stress] cold replay + layout of ${facts.nodes} nodes over ${facts.sessions} sessions: ` +
        `median ${ms(cold.medianMs)} min ${ms(cold.minMs)} max ${ms(cold.maxMs)} (n=${cold.n}), ` +
        `budget ${b.id} ${String(b.limitMs)} ms; drew ${String(last.drawn)} nodes`,
    );
    // Not vacuous: the replay really did land a deck and really did draw
    // trees. A run that produced nothing would otherwise be the fastest one.
    expect(last.sessions).toBe(facts.sessions);
    expect(last.drawn).toBeGreaterThan(AUTO_COLLAPSE_NODES);
    expect(cold.medianMs).toBeLessThan(b.limitMs);
  });

  it('lays out the largest tree UNCOLLAPSED inside its own budget', () => {
    const state = finalOf(boundaryId(AUTO_COLLAPSE_NODES + 1));
    const samples: number[] = [];
    let drawn = 0;
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      const placements = treeLayout(state, state.root.id, {
        collapseDepth: Number.POSITIVE_INFINITY,
      });
      samples.push(performance.now() - t0);
      drawn = placements.filter((p) => !p.hidden).length;
    }
    const whole = stats(samples);
    const b = budget('layout.boundaryTree');
    console.log(
      `[stress] treeLayout of ${String(drawn)} agents, uncollapsed: median ` +
        `${ms(whole.medianMs)} min ${ms(whole.minMs)} max ${ms(whole.maxMs)} (n=${whole.n}), ` +
        `budget ${b.id} ${String(b.limitMs)} ms`,
    );
    expect(drawn).toBe(AUTO_COLLAPSE_NODES + 1);
    expect(whole.medianMs).toBeLessThan(b.limitMs);
  });

  it('every budget states the measurement it was set from', () => {
    // A limit with no measurement behind it is a round number somebody typed.
    for (const b of SCALE_BUDGETS) {
      expect(b.measured.valueMs, b.id).toBeGreaterThan(0);
      expect(b.limitMs, b.id).toBeGreaterThan(b.measured.valueMs);
      // The margin is arithmetic, not a claim: it must agree with the two
      // numbers beside it to within 1%, or one of the three has been edited
      // alone. A tolerance rather than an equality because the stated margin is
      // rounded for a reader; a `toBeCloseTo(_, 5)` here would force whoever
      // re-measures to type twelve digits and would be edited out on the first
      // attempt, which is worse than a check that survives being used.
      const derived = b.limitMs / b.measured.valueMs;
      expect(Math.abs(derived - b.measured.marginX) / b.measured.marginX, b.id).toBeLessThan(0.01);
      // And the margin is genuinely large. These are complexity tripwires, not
      // measurements of this machine — see the table's own header.
      expect(derived, b.id).toBeGreaterThan(20);
      expect(b.measured.note.length, b.id).toBeGreaterThan(40);
    }
  });

  it('the auto-collapse rule fires above the boundary and nowhere below it', () => {
    // Through the REPLAYED store, not off the generator's objects: the states
    // this asserts on are the ones a webview would be holding after the whole
    // corpus arrived, patches and all.
    const store = createStore();
    for (const event of generated.corpus.events) {
      store.handleMessage(event.message as HostToWebviewMessage);
    }

    const seen: string[] = [];
    for (const target of BOUNDARY_TARGETS) {
      const id = boundaryId(target);
      store.selectSession(id);
      const state = store.getView().selected;
      expect(state, id).toBeDefined();
      if (state === undefined) continue;
      const rootId = state.root.id;

      const visible = visibleNodeCount(state, rootId);
      const depth = autoCollapseDepth(state, rootId);
      const collapsed = depth !== Number.POSITIVE_INFINITY;
      const drawn = treeLayout(state, rootId, { collapseDepth: depth }).filter((p) => !p.hidden);
      seen.push(`${id}: visible=${String(visible)} depth=${String(depth)} drawn=${String(drawn.length)}`);

      expect(visible, id).toBe(target);
      // STRICTLY GREATER. 300 renders whole, 301 collapses.
      expect(collapsed, id).toBe(target > AUTO_COLLAPSE_NODES);
      if (collapsed) {
        expect(depth, id).toBe(COLLAPSE_DEPTH);
        // A collapse that hid nothing would satisfy every assertion above.
        expect(drawn.length, id).toBeLessThan(visible);
        expect(drawn.every((p) => p.depth <= COLLAPSE_DEPTH), id).toBe(true);
        const badges = drawn.filter((p) => p.collapsed);
        expect(badges.length, id).toBeGreaterThan(0);
        expect(
          badges.reduce((n, p) => n + p.hiddenDescendants, 0) + drawn.length,
          id,
        ).toBe(visible);
      } else {
        expect(drawn.length, id).toBe(visible);
        expect(drawn.some((p) => p.collapsed), id).toBe(false);
      }
    }
    console.log(`[stress] collapse boundary (AUTO_COLLAPSE_NODES=${String(AUTO_COLLAPSE_NODES)}):`);
    for (const line of seen) console.log(`[stress]   ${line}`);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. It renders
 * ------------------------------------------------------------------------ */

/**
 * The harness bundle opens with `"use strict"`, and a STRICT indirect eval gets
 * its own variable environment — so the bundle's `var AgentDeckHarness` does
 * NOT become a property of the jsdom window, the way a sloppy-mode one would.
 * Measured: the same eval of `var FOO = 42` without the directive does reach
 * the window, which is why this looks like it should work and does not.
 *
 * `testkit.ts:loadHarness` sidesteps it by wrapping the bundle in
 * `new Function(...)` and returning the name; that cannot be reused here,
 * because the code has to be evaluated inside the jsdom realm rather than this
 * one. So the assignment is appended to the same eval, where the binding is
 * still in scope.
 */
const EXPORT_HARNESS = '\n;globalThis.__agentDeckHarness = AgentDeckHarness;';

interface StressWindow {
  document: Document;
  MessageEvent: typeof MessageEvent;
  __agentDeckHarness?: {
    start(
      target: Element,
      api: { postMessage(message: unknown): void },
    ): { store: { enterSession(id: string): void }; dispose(): void };
    flushSync(fn?: () => void): void;
  };
  dispatchEvent(event: Event): boolean;
  eval(code: string): unknown;
  close(): void;
}

interface JsdomModule {
  JSDOM: new (
    html: string,
    options: { runScripts: 'outside-only'; pretendToBeVisual: boolean },
  ) => { window: StressWindow };
}

describe('the canvas renders the stress corpus', () => {
  it('draws every session on the deck and every interior it is asked for', async () => {
    const { JSDOM } = (await import(/* @vite-ignore */ JSDOM_MODULE)) as unknown as JsdomModule;
    const code = await bundleHarness();
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    try {
      window.eval(code + EXPORT_HARNESS);
      const harness = window.__agentDeckHarness;
      expect(harness).toBeDefined();
      if (harness === undefined) return;

      const container = window.document.createElement('div');
      window.document.body.appendChild(container);
      const started = harness.start(container, { postMessage: () => {} });

      // The whole arc, message by message, the way VS Code delivers it.
      for (const event of generated.corpus.events) {
        harness.flushSync(() => {
          window.dispatchEvent(
            new window.MessageEvent('message', { data: event.message }),
          );
        });
      }

      const count = (testId: string): number =>
        container.querySelectorAll(`[data-testid="${testId}"]`).length;
      const text = (selector: string): string =>
        container.querySelector(selector)?.textContent ?? '';

      // Altitude 0: one CARD per session. The predecessor deck drew a blob
      // with a constellation of faint interior dots and this asserted that
      // there were more than zero of them; the constellation is deleted, and
      // the card says the same thing in a figure a test can read BY VALUE.
      expect(count(TESTID.deckBlob)).toBe(facts.sessions);
      for (const target of BOUNDARY_TARGETS) {
        const id = boundaryId(target);
        const cell = `[data-testid="${TESTID.deckBlob}"][data-session-id="${id}"] `;
        expect(text(`${cell}[data-testid="deck-cell-agents"]`), id).toBe(`${String(target)} ag`);
        // And the em-dash path, asserted as a VALUE rather than with a
        // `toContain('—')` that would pass if every figure on the row were a
        // dash: these sessions report no tokens, and the neighbouring figure
        // on the same row is a real number.
        expect(text(`${cell}[data-testid="deck-cell-tokens"]`), id).toBe('—');
        expect(text(`${cell}[data-testid="deck-cell-inflight"]`), id).toBe('0 in flight');
      }
      // The control for that dash: a healthy session on the same deck prints
      // a figure, so "no tokens" is a property of those three sessions rather
      // than of the card.
      const healthy = `[data-testid="${TESTID.deckBlob}"][data-session-id="syn-00"] `;
      expect(text(`${healthy}[data-testid="deck-cell-tokens"]`)).not.toBe('—');

      // Altitude 1, for every session in turn, including the refused one.
      let interiors = 0;
      for (const state of generated.final) {
        harness.flushSync(() => {
          started.store.enterSession(state.sessionId);
        });
        const drawn =
          count(TESTID.nucleus) +
          count(TESTID.cell) +
          count(TESTID.dot) +
          count(TESTID.filament) +
          count(TESTID.parkedStub);
        if (state.schemaOk) {
          expect(drawn, state.sessionId).toBeGreaterThan(0);
          expect(count(TESTID.nucleus), state.sessionId).toBe(1);
          interiors += 1;
        } else {
          // G3 at scale: the refused session draws nothing, in a panel that is
          // drawing plenty for its neighbours.
          expect(drawn, state.sessionId).toBe(0);
        }
      }
      expect(interiors).toBe(facts.sessions - 1);

      started.dispose();
    } finally {
      window.close();
    }
  }, 120_000);

  it('says so in the status line when it collapses a tree on its own', async () => {
    // DoD 7.8 through the RENDERER, at the boundary. A tree that silently
    // stopped drawing two thirds of itself is a tree the user reads as
    // complete, so the assertion is on the sentence as well as on the count.
    const { JSDOM } = (await import(/* @vite-ignore */ JSDOM_MODULE)) as unknown as JsdomModule;
    const code = await bundleHarness();
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    try {
      window.eval(code + EXPORT_HARNESS);
      const harness = window.__agentDeckHarness;
      expect(harness).toBeDefined();
      if (harness === undefined) return;

      const container = window.document.createElement('div');
      window.document.body.appendChild(container);
      const started = harness.start(container, { postMessage: () => {} });
      for (const event of generated.corpus.events) {
        harness.flushSync(() => {
          window.dispatchEvent(new window.MessageEvent('message', { data: event.message }));
        });
      }

      const observed: string[] = [];
      for (const target of BOUNDARY_TARGETS) {
        const id = boundaryId(target);
        harness.flushSync(() => {
          started.store.enterSession(id);
        });
        const canvas = container.querySelector(`[data-testid="${TESTID.canvas}"]`);
        expect(canvas, id).not.toBeNull();
        const status = container.querySelector('[data-testid="tree-status"]');
        expect(status, id).not.toBeNull();
        const statusText = status?.textContent ?? '';
        const drawnCells = container.querySelectorAll(
          `[data-testid="${TESTID.cell}"],[data-testid="${TESTID.nucleus}"]`,
        ).length;
        observed.push(
          `${id}: autoCollapsed=${String(canvas?.getAttribute('data-auto-collapsed'))} ` +
            `depth=${String(canvas?.getAttribute('data-collapse-depth'))} ` +
            `drawn=${String(drawnCells)} status=${JSON.stringify(statusText)}`,
        );

        const above = target > AUTO_COLLAPSE_NODES;
        expect(canvas?.getAttribute('data-auto-collapsed'), id).toBe(String(above));
        expect(canvas?.getAttribute('data-collapse-depth'), id).toBe(
          above ? String(COLLAPSE_DEPTH) : 'Infinity',
        );
        // The status line's own numbers, BY VALUE. `of <target> nodes` is the
        // total in both arms; what changes is the count before it and whether
        // the sentence admits the collapse.
        expect(statusText, id).toContain(`of ${String(target)} nodes`);
        if (above) {
          expect(statusText, id).toContain(
            `collapsed to depth ${String(COLLAPSE_DEPTH)} automatically above ` +
              `${String(AUTO_COLLAPSE_NODES)} nodes`,
          );
          expect(drawnCells, id).toBeLessThan(target);
          expect(statusText, id).toContain(`${String(drawnCells)} of`);
        } else {
          expect(statusText, id).not.toContain('automatically');
          expect(drawnCells, id).toBe(target);
          expect(statusText, id).toBe(`${String(target)} of ${String(target)} nodes`);
        }
      }
      console.log('[stress] status line at the boundary:');
      for (const line of observed) console.log(`[stress]   ${line}`);

      started.dispose();
    } finally {
      window.close();
    }
  }, 120_000);
});
