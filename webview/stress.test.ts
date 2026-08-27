// R5 — the synthetic stress corpus: does the canvas hold at R2 scale, and what
// does one diff actually cost?
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
// TIMING IS A MEASUREMENT, NOT A GATE
// ------------------------------------
// The per-diff numbers below are PRINTED as a median with its n, and nothing
// asserts a threshold on them. Wall-clock samples are not properties of the
// code — this repo measured 6.49 s and 35.91 s for the same suite on the same
// machine — so a threshold here would go red on machine state and be
// "fixed" by raising it. What IS asserted is that the work per diff does not
// grow with the number of sessions the store is holding, which is a property
// of the algorithm rather than of the machine.
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
import { countNodes, deckLayout, sessionLayout } from './layout.js';
import { createStore } from './store.js';
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
    burn: { prompt: 100 * (depth + 1), output: 10 * (depth + 1) },
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
    burn: { prompt: 1_000 * (index + 1), output: 100 * (index + 1) },
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
      contextNow: { prompt: 0, output: 0 },
      burn: { prompt: 0, output: 0 },
      startedAt: 1_000,
    },
    totals: { costUsd: 0 },
    contextNow: { prompt: 0, output: 0 },
    burn: { prompt: 0, output: 0 },
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
 * The patch for one session on one tick.
 *
 * Real ops only — `updateTool`, `updateAgent`, `insertNode` and a `fields`
 * replacement — and every one of them is applied through the REAL
 * `applySessionPatch` below, so a patch this generator cannot express fails
 * here rather than producing a corpus the store silently stalls on.
 */
function tickPatch(state: SessionState, tick: number): SessionPatch | undefined {
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
      // Anchor on the current last child rather than naming a position in the
      // receiver's array.
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
      totals: { costUsd: 0 },
      // The session-level level moves with the root's, which is what a real
      // append does: one more assistant message, a bigger prompt.
      contextNow: { prompt: state.contextNow.prompt + tick, output: state.contextNow.output + tick },
      burn: { prompt: state.burn.prompt + tick, output: state.burn.output + tick },
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
    refusedSession(),
  ];
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
      'what keeps it distinguishable from evidence about CC on disk (G6).',
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
 * Fixtures for the suite
 * ------------------------------------------------------------------------ */

let recorder: RecorderModule;
let generated: Generated;
let committed: WireCorpus;
/** Derived from the generated corpus. Printed; never written down as a literal. */
let facts: { sessions: number; nodes: number; maxDepth: number; diffs: number };

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
  for (const state of generated.final) {
    nodes += countNodes(state);
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
        `maxSpawnDepth=${facts.maxDepth} diffEvents=${facts.diffs}`,
    );
    expect(facts.sessions).toBeGreaterThanOrEqual(12);
    expect(facts.nodes).toBeGreaterThanOrEqual(300);
    expect(facts.maxDepth).toBe(3);
    expect(facts.diffs).toBeGreaterThan(0);
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

  it('records store and layout time per diff as a number', () => {
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
      deckLayout(view.sessions);
      const t3 = performance.now();
      if (view.selected !== undefined) sessionLayout(view.selected);
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
    console.log(`[stress]   sessionLayout(one)   median ${ms(layout.medianMs)}  ` +
      `min ${ms(layout.minMs)}  max ${ms(layout.maxMs)}`);
    console.log(`[stress]   store + layout TOTAL median ${ms(total.medianMs)}  ` +
      `min ${ms(total.minMs)}  max ${ms(total.maxMs)}`);

    // Nothing here asserts a threshold: a wall-clock sample is a property of
    // the machine, not of the code. What is asserted is that the numbers are
    // real numbers over a real sample.
    expect(total.n).toBe(facts.diffs);
    expect(total.n).toBeGreaterThan(30);
    expect(Number.isFinite(total.medianMs)).toBe(true);
    expect(total.medianMs).toBeGreaterThanOrEqual(0);
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
 * 3. It renders
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

      // Altitude 0: one blob per session, and a constellation that saturates
      // rather than thinning — the cap is the layout's, not asserted here.
      expect(count(TESTID.deckBlob)).toBe(facts.sessions);
      expect(count(TESTID.deckConstellation)).toBeGreaterThan(0);

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
});
