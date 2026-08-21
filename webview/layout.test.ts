// The layout engine's whole test story, in the order C7.5 states it:
// deterministic, incremental, animation-free — plus the structural purity
// assertion PLAN requires and the golden coordinate suites it names.
//
// NODE ENVIRONMENT, deliberately. `layout.ts` never touches a DOM, so running
// it under jsdom would prove nothing and would hand the code under test a
// global it is asserted never to reach.
//
// Node builtins are imported by their real specifiers. `tsconfig.webview.json`
// sets `types: []`, which removes node's GLOBALS from this project — so
// `process.env` is unavailable here and the env var is read through
// `node:process` instead. The same reason `fixture-render.test.ts` gives.
// Nothing in this file is reachable from `webview/main.ts`.
//
// WHERE THE FIXTURE SUBJECTS COME FROM. Session ids, agent ids and `tool_use`
// ids are capture artefacts that change on every harvest, so every subject
// below is selected BY PROPERTY — "the captured session with the deepest spawn
// chain", "the first synthetic-graft case whose graft parks an agent" — and
// the path it resolved to is written INTO the golden. A re-harvest that moves
// the subject therefore shows up as a legible golden diff rather than as a
// mysterious coordinate change.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { env } from 'node:process';

import { beforeAll, describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, SpawnEdge, ToolNode } from '../src/model/events.js';
import { isAgentNode } from '../src/model/events.js';
import type { GraftSnapshot } from '../src/model/graft.js';
import { graftSession, toSessionState } from '../src/model/graft.js';
import { DOT_CAP } from './canvas-contract.js';
import type { DeckPlacement, SessionLayout } from './canvas-contract.js';
import {
  CELL_RADIUS_MAX,
  DOTS_PER_RING,
  DOT_RINGS,
  DOT_RING_BASE,
  DOT_SLOT_PERIOD,
  blobPath,
  countNodes,
  deckLayout,
  hashSessionId,
  sessionLayout,
  toDeckSession,
} from './layout.js';
import type { DeckSession } from './layout.js';

const REPO_ROOT = resolve('.');
const CAPTURED_ROOT = resolve('fixtures/cc-2.1.234/projects');
const GRAFT_ROOT = resolve('fixtures/synthetic-graft');
const GOLDEN_DIR = resolve('webview/goldens/layout');

/**
 * Regeneration is env-gated, the convention `fixtures/golden/*` already uses.
 *
 * It is gated HARDER here, because HANDOVER carry-forward G names the existing
 * convention as a live hazard: a golden that rewrites itself is a rubber stamp.
 * With the var set this file WRITES and then FAILS (see the last test in this
 * file), so a regeneration run is never green and the new numbers have to be
 * read and committed by a human. Without it, nothing is written at all.
 */
const UPDATE_GOLDENS = env['AGENT_DECK_UPDATE_GOLDENS'] === '1';

/** Repo-relative, forward-slashed — so a golden reads the same on any machine. */
function repoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split('\\').join('/');
}

/**
 * Compare `actual` against the committed golden, or write it when the env var
 * is set.
 *
 * Comparison is on PARSED JSON, not on bytes. That is the answer to the
 * `.gitattributes` / `core.autocrlf` hazard: these files are not listed as
 * non-text anywhere, so a fresh clone on this machine may check them out with
 * CRLF endings. A byte comparison would then fail everywhere except where it
 * was written, and would look like a layout bug. Parsed numbers are immune to
 * the line ending they were stored behind, and numbers are what C7.5 says to
 * pin.
 */
async function golden(name: string, actual: unknown): Promise<void> {
  const path = join(GOLDEN_DIR, `${name}.json`);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (UPDATE_GOLDENS) {
    await mkdir(GOLDEN_DIR, { recursive: true });
    await writeFile(path, text, 'utf8');
    return;
  }
  let stored: string;
  try {
    stored = await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `missing golden ${repoPath(path)} — regenerate with AGENT_DECK_UPDATE_GOLDENS=1 and commit it`,
    );
  }
  expect(JSON.parse(stored)).toStrictEqual(JSON.parse(text));
}

/** `SessionLayout` as JSON: Maps become sorted entry arrays. */
function serializeLayout(layout: SessionLayout): unknown {
  return {
    cells: [...layout.cells.entries()],
    dots: [...layout.dots.entries()],
    elided: [...layout.elided.entries()],
  };
}

// ---------------------------------------------------------------------------
// Fixture subjects, selected by property
// ---------------------------------------------------------------------------

interface Subject {
  path: string;
  snapshot: GraftSnapshot;
  /** Deepest spawn edge in the graft. 0 when nothing was grafted. */
  maxDepth: number;
}

async function transcriptsUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
      else if (entry.isDirectory()) await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}

/** Grafts every main transcript directly under a slug directory of `root`. */
async function subjectsUnder(root: string): Promise<Subject[]> {
  const out: Subject[] = [];
  for (const path of await transcriptsUnder(root)) {
    // Subagent transcripts live in `<sessionId>/subagents/`; grafting one as a
    // main transcript is not a case this file is about.
    if (path.includes('subagents')) continue;
    const result = await graftSession(path);
    if (!result.ok) continue;
    const depths = result.snapshot.edges.map((e) => e.depth);
    out.push({
      path,
      snapshot: result.snapshot,
      maxDepth: depths.length > 0 ? Math.max(...depths) : 0,
    });
  }
  return out;
}

let captured: Subject[] = [];
let synthetic: Subject[] = [];

beforeAll(async () => {
  captured = await subjectsUnder(CAPTURED_ROOT);
  synthetic = await subjectsUnder(GRAFT_ROOT);
}, 120_000);

/** The captured session with the deepest spawn chain. */
function deepestCapture(): Subject {
  let best: Subject | undefined;
  for (const s of captured) if (best === undefined || s.maxDepth > best.maxDepth) best = s;
  if (best === undefined) throw new Error('no captured session grafted');
  return best;
}

/**
 * A committed graft fixture whose graft PARKS an agent (an unresolved join).
 *
 * Preference, not a name: a case that parks one agent AND grafts another is
 * worth more than one that parks its only agent, because it puts both outcomes
 * in the same golden. Falls back to any parking case, so a re-harvest that
 * removes the richer fixture degrades instead of failing.
 */
function parkedSubject(): Subject {
  for (const s of synthetic) {
    if (s.snapshot.parked.length > 0 && s.snapshot.edges.length > 0) return s;
  }
  for (const s of synthetic) if (s.snapshot.parked.length > 0) return s;
  throw new Error('no committed graft fixture parks an agent');
}

/**
 * The state the model publishes: `toSessionState` plus the resolved spawn
 * edges, exactly as `SessionModel.viewFromSnapshot` assembles them.
 */
function modelState(snapshot: GraftSnapshot): SessionState {
  const edges: SpawnEdge[] = snapshot.edges.map((e) => ({
    toolUseId: e.toolUseId,
    agentId: e.agentId,
    parentNodeId: e.parentNodeId,
    depth: e.depth,
    recordedDepth: e.recordedDepth,
  }));
  return {
    ...toSessionState(snapshot, { liveness: 'live', workspaceMatch: true }),
    spawnEdges: edges,
  };
}

// ---------------------------------------------------------------------------
// Small tree surgery, for the incremental tests
// ---------------------------------------------------------------------------

function agentIds(state: SessionState): string[] {
  const out: string[] = [];
  const visit = (node: AgentNode | ToolNode): void => {
    if (!isAgentNode(node)) return;
    out.push(node.id);
    for (const child of node.children) visit(child);
  };
  visit(state.root);
  return out;
}

/** Every tool id in the tree, WITH duplicates — see the duplicate-id test. */
function toolIds(state: SessionState): string[] {
  const out: string[] = [];
  const visit = (node: AgentNode | ToolNode): void => {
    if (!isAgentNode(node)) {
      out.push(node.id);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(state.root);
  return out;
}

function newTool(id: string): ToolNode {
  return { id, toolName: 'Read', status: 'done', inputPreview: '{}' };
}

/**
 * Append a child to one agent, rebuilding only the path down to it.
 *
 * Grafter snapshots are deep-frozen, so this copies rather than mutates. It is
 * also the honest shape of the event being modelled: a spawn ADDS a child to
 * one agent and leaves the rest of the tree alone.
 */
function withChild(state: SessionState, agentId: string, child: AgentNode | ToolNode): SessionState {
  const rebuild = (node: AgentNode): AgentNode => {
    if (node.id === agentId) return { ...node, children: [...node.children, child] };
    return { ...node, children: node.children.map((c) => (isAgentNode(c) ? rebuild(c) : c)) };
  };
  return { ...state, root: rebuild(state.root) };
}

// ---------------------------------------------------------------------------
// 1. Purity, enforced structurally
// ---------------------------------------------------------------------------

/**
 * The CLOSED allowed-import set for `layout.ts`, and why it is exactly these
 * two:
 *
 *  - `./canvas-contract.js` — the shared names two packages must agree on. Its
 *    own header states it has NO IMPORTS AT ALL, for this reason among others.
 *  - `../src/model/events.js` — the domain types plus `isAgentNode`. Types only
 *    and runtime guards; it imports nothing either.
 *
 * Because both have an empty import list, the set is CLOSED: there is no
 * transitive edge out of it, so nothing `layout.ts` can reach touches a DOM, a
 * timer, a socket or the filesystem. The closure is asserted below rather than
 * asserted about, so adding an import to either file fails this test.
 */
const ALLOWED_IMPORTS = ['./canvas-contract.js', '../src/model/events.js'];

/**
 * Identifiers that must not appear in `layout.ts` AT ALL — comments included.
 *
 * Scanning the source rather than observing calls is the point: a test that
 * calls three functions and sees no side effect proves nothing about the
 * fourth, or about a branch it did not take. Scanning comments too is a small
 * extra cost (prose has to say "span" instead of one of these words) in
 * exchange for a check with no parser and no exceptions to argue about.
 */
const FORBIDDEN_IDENTIFIERS = [
  'document',
  'window',
  'globalThis',
  'localStorage',
  'sessionStorage',
  'navigator',
  'performance',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'requestAnimationFrame',
  'queueMicrotask',
  'process',
  'require',
  'crypto',
  'Date',
  'random',
];

function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^import\b[^;]*?from\s*'([^']+)'\s*;/gm)) {
    const spec = m[1];
    if (spec !== undefined) out.push(spec);
  }
  for (const m of source.matchAll(/^import\s*'([^']+)'\s*;/gm)) {
    const spec = m[1];
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

describe('purity is a property of the source, not of the calls this file made', () => {
  it('imports nothing outside the closed allowed set', async () => {
    const source = await readFile(resolve('webview/layout.ts'), 'utf8');
    const specs = [...new Set(importSpecifiers(source))].sort();
    expect(specs).toStrictEqual([...ALLOWED_IMPORTS].sort());
  });

  it('the allowed set is closed: both permitted modules import nothing', async () => {
    for (const spec of ALLOWED_IMPORTS) {
      const path = resolve('webview', spec).replace(/\.js$/, '.ts');
      const source = await readFile(path, 'utf8');
      expect(importSpecifiers(source), `${repoPath(path)} must import nothing`).toStrictEqual([]);
    }
  });

  it('reaches no DOM, no timer, no clock and no entropy', async () => {
    const source = await readFile(resolve('webview/layout.ts'), 'utf8');
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      const found = new RegExp(`\\b${identifier}\\b`).test(source);
      expect(found, `layout.ts must not mention \`${identifier}\``).toBe(false);
    }
    // Dynamic import and CommonJS require would both open the closed set.
    expect(/\bimport\s*\(/.test(source)).toBe(false);
  });

  it('holds no mutable module state', async () => {
    const source = await readFile(resolve('webview/layout.ts'), 'utf8');
    // Top-level `let`/`var` only; the `let` inside a function body is indented.
    expect(/^(export\s+)?(let|var)\s/m.test(source)).toBe(false);
  });

  it('the ring geometry cannot stack two simultaneously visible dots', () => {
    // The period is what makes the sliding cap safe. Derived from DOT_CAP, so
    // raising the cap in canvas-contract.ts without revisiting DOT_RINGS fails
    // here rather than silently drawing two dots on top of each other.
    expect(DOT_SLOT_PERIOD).toBe(DOTS_PER_RING * DOT_RINGS);
    expect(DOT_SLOT_PERIOD).toBeGreaterThanOrEqual(DOT_CAP);
    // A membrane can never swallow its own dot ring, however much arrives.
    expect(CELL_RADIUS_MAX).toBeLessThan(DOT_RING_BASE);
  });
});

// ---------------------------------------------------------------------------
// 2. Deck goldens at N = 0 / 1 / 2 / 6 / 12
// ---------------------------------------------------------------------------

/**
 * The deck's input list: every captured session first (sorted, so the list is
 * stable), then deterministic filler.
 *
 * Filler is legitimate here in a way it would not be for a parser test: the
 * deck consumes `{ sessionId, nodeCount }`, which is Agent Deck's own shape and
 * carries no Claude Code schema at all — there is nothing about CC for a
 * fixture to pin. The captured entries are still first so the real ids are the
 * ones exercised at N = 1 and N = 2, and the whole input list is written into
 * the golden so a re-harvest reads as a diff rather than a riddle.
 */
function deckInput(n: number): DeckSession[] {
  const real = captured
    .map((s) => modelState(s.snapshot))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    .map(toDeckSession);
  const out: DeckSession[] = real.slice(0, n);
  for (let i = out.length; i < n; i += 1) {
    // Node counts cycle deterministically so the golden exercises several
    // points on the log radius curve, including the floor and the ceiling.
    const counts = [0, 1, 3, 12, 47, 300, 5000];
    out.push({ sessionId: `synthetic-deck-${String(i).padStart(2, '0')}`, nodeCount: counts[i % counts.length] ?? 0 });
  }
  return out;
}

describe('deck goldens', () => {
  for (const n of [0, 1, 2, 6, 12]) {
    it(`places ${n} session(s) at the pinned coordinates`, async () => {
      const input = deckInput(n);
      expect(input).toHaveLength(n);
      const output = deckLayout(input);
      expect(output).toHaveLength(n);
      await golden(`deck-n${String(n).padStart(2, '0')}`, {
        source: repoPath(CAPTURED_ROOT),
        input,
        output,
      });
    });
  }

  it('N = 0 is the empty deck, and that is a real state', () => {
    expect(deckLayout([])).toStrictEqual([]);
  });

  it('is deterministic: two calls on the same input are identical', () => {
    const input = deckInput(12);
    expect(deckLayout(input)).toStrictEqual(deckLayout(input));
  });

  it('is incremental: appending a session moves none of the others', () => {
    const twelve = deckLayout(deckInput(12));
    for (const n of [0, 1, 2, 6]) {
      const shorter = deckLayout(deckInput(n));
      for (let i = 0; i < shorter.length; i += 1) {
        const before = shorter[i];
        const after = twelve[i];
        expect(before).toBeDefined();
        expect(after).toBeDefined();
        if (before === undefined || after === undefined) continue;
        expect(after.sessionId).toBe(before.sessionId);
        // Byte-identical, not approximately equal: a tolerance here is exactly
        // how a slow drift gets through.
        expect(Object.is(after.x, before.x)).toBe(true);
        expect(Object.is(after.y, before.y)).toBe(true);
      }
    }
  });

  it('radius grows with node count and is bounded at both ends', () => {
    const placements = deckLayout([
      { sessionId: 'a', nodeCount: 0 },
      { sessionId: 'b', nodeCount: 10 },
      { sessionId: 'c', nodeCount: 100_000 },
    ]) as [DeckPlacement, DeckPlacement, DeckPlacement];
    expect(placements[0].R).toBeLessThan(placements[1].R);
    expect(placements[1].R).toBeLessThan(placements[2].R);
    expect(placements[2].R).toBeLessThanOrEqual(68);
  });
});

// ---------------------------------------------------------------------------
// 3. Blob silhouettes
// ---------------------------------------------------------------------------

describe('blobPath', () => {
  it('is a pure function of the id hash, pinned as path data', async () => {
    const ids = [
      ...captured.map((s) => s.snapshot.sessionId).sort(),
      '',
      'a',
      'c--Users-dev-projects-agent-deck',
    ];
    const entries = ids.map((sessionId) => {
      const seed = hashSessionId(sessionId);
      return { sessionId, seed, d: blobPath(0, 0, 40, seed) };
    });
    await golden('blob-paths', { source: repoPath(CAPTURED_ROOT), entries });
  });

  it('gives different ids different silhouettes and the same id the same one', () => {
    const one = blobPath(0, 0, 40, hashSessionId('session-a'));
    const two = blobPath(0, 0, 40, hashSessionId('session-b'));
    expect(one).not.toBe(two);
    expect(blobPath(0, 0, 40, hashSessionId('session-a'))).toBe(one);
  });

  it('closes the path and emits only finite numbers', () => {
    const d = blobPath(12.5, -8, 33, hashSessionId('x'));
    expect(d.startsWith('M ')).toBe(true);
    expect(d.endsWith(' Z')).toBe(true);
    for (const token of d.split(' ')) {
      if (token === 'M' || token === 'C' || token === 'Z' || token === '') continue;
      expect(Number.isFinite(Number(token)), `not a number: ${token}`).toBe(true);
    }
    expect(d).not.toContain('NaN');
    expect(d).not.toContain('-0 ');
  });

  it('hashSessionId is a pure 32-bit function of the string', () => {
    expect(hashSessionId('abc')).toBe(hashSessionId('abc'));
    expect(hashSessionId('abc')).not.toBe(hashSessionId('abd'));
    for (const s of ['', 'a', 'abc', 'a'.repeat(500)]) {
      const h = hashSessionId(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffff_ffff);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Session-layout goldens, from committed fixture trees
// ---------------------------------------------------------------------------

describe('session layout goldens, derived from committed fixture trees', () => {
  it('a captured session with a depth >= 2 spawn chain', async () => {
    const subject = deepestCapture();
    // Measured from the graft, not assumed: the DoD asks for depth >= 2 and
    // this is where that claim is checked rather than asserted in prose.
    expect(subject.maxDepth).toBeGreaterThanOrEqual(2);
    const state = modelState(subject.snapshot);
    const layout = sessionLayout(state);

    // Every agent gets a cell and every tool gets a dot (nothing is capped at
    // this size), so the golden below is not pinning an accidentally empty map.
    expect(layout.cells.size).toBe(agentIds(state).length);
    expect(layout.cells.size).toBeGreaterThan(1);
    expect(layout.dots.size).toBe(new Set(toolIds(state)).size);
    // In THIS capture the ids happen to be distinct, so the dot count is also
    // the tool-node count. Stated as a measurement of the capture, not as a
    // property of layout — the duplicate-id case is pinned separately below.
    expect(new Set(toolIds(state)).size).toBe(subject.snapshot.counts.toolNodes);
    expect(layout.elided.size).toBe(0);

    await golden('session-deepest-capture', {
      source: repoPath(subject.path),
      maxSpawnDepth: subject.maxDepth,
      ...(serializeLayout(layout) as object),
    });
  });

  it('a committed fixture whose graft parks an agent (an unresolved join)', async () => {
    const subject = parkedSubject();
    // Measured: this fixture really does produce a parked graft, and the code
    // that says why is pinned in the golden.
    expect(subject.snapshot.parked.length).toBeGreaterThan(0);
    const state = modelState(subject.snapshot);
    const layout = sessionLayout(state);

    // The parked agent is NOT in `root` — the grafter deliberately leaves it
    // off the tree — and `SessionState` carries no parked list, so it gets no
    // cell. Asserted rather than left implicit, so that if a later phase adds
    // a channel for parked grafts this test fails and says where to look.
    for (const p of subject.snapshot.parked) {
      expect(layout.cells.has(p.agentId)).toBe(false);
    }

    await golden('session-parked-graft', {
      source: repoPath(subject.path),
      parked: subject.snapshot.parked.map((p) => ({ agentId: p.agentId, code: p.code })),
      ...(serializeLayout(layout) as object),
    });
  });

  it('a tool_use id is not unique across a tree, and the first writer keeps the dot', () => {
    const subject = parkedSubject();
    const state = modelState(subject.snapshot);
    const ids = toolIds(state);
    const distinct = new Set(ids);
    // Measured on the committed fixture, not assumed: the same `tool_use` id
    // appears in the main transcript AND in a subagent's, which is exactly the
    // shape that makes the join ambiguous. `SessionLayout.dots` is keyed by
    // tool id (C7.5 writes it that way), so two tool nodes collapse to one dot.
    expect(ids.length).toBeGreaterThan(distinct.size);
    const layout = sessionLayout(state);
    expect(layout.dots.size).toBe(distinct.size);

    // First writer wins, so a later subtree never moves a dot already placed.
    // Proved by placing the same tree twice with the duplicate-bearing subtree
    // removed: the surviving dot keeps the coordinates it had.
    const rootOnly: SessionState = {
      ...state,
      root: { ...state.root, children: state.root.children.filter((c) => !isAgentNode(c)) },
      spawnEdges: [],
    };
    const trimmed = sessionLayout(rootOnly);
    for (const [id, dot] of trimmed.dots) {
      const full = layout.dots.get(id);
      expect(full, `dot ${id} missing from the full layout`).toBeDefined();
      if (full === undefined) continue;
      expect(Object.is(full.x, dot.x), `dot ${id} x moved`).toBe(true);
      expect(Object.is(full.y, dot.y), `dot ${id} y moved`).toBe(true);
    }
  });

  it('the same tree with no spawn edges: every cell unanchored', async () => {
    // `toSessionState` in `src/model/graft.ts` sets no `spawnEdges` at all —
    // production code, called here unmodified. Every subagent is then a cell
    // with no dot to hang a filament from, which is the geometry the parked
    // grammar needs (`PARKED_CLASS`: unattached, dashed, stubbed).
    const subject = deepestCapture();
    const state = toSessionState(subject.snapshot, { liveness: 'live', workspaceMatch: true });
    expect(state.spawnEdges).toBeUndefined();
    const layout = sessionLayout(state);

    // Same node set as the anchored layout, different coordinates: proof the
    // parked ring is a distinct placement rule and not a silent fallback to
    // the same spot.
    const anchored = sessionLayout(modelState(subject.snapshot));
    expect([...layout.cells.keys()].sort()).toStrictEqual([...anchored.cells.keys()].sort());
    let moved = 0;
    for (const [id, cell] of layout.cells) {
      const other = anchored.cells.get(id);
      if (other === undefined) continue;
      if (cell.x !== other.x || cell.y !== other.y) moved += 1;
    }
    expect(moved).toBeGreaterThan(0);

    await golden('session-unanchored-cells', {
      source: repoPath(subject.path),
      ...(serializeLayout(layout) as object),
    });
  });

  it('G3: a refused session lays out to nothing at all', () => {
    const subject = deepestCapture();
    const refused: SessionState = {
      ...modelState(subject.snapshot),
      schemaOk: false,
      liveness: 'unsupported',
    };
    const layout = sessionLayout(refused);
    expect(layout.cells.size).toBe(0);
    expect(layout.dots.size).toBe(0);
    expect(layout.elided.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Incremental stability — the DoD's named test
// ---------------------------------------------------------------------------

describe('incremental: a spawn adds, it never reflows', () => {
  it('adding a tool call leaves every pre-existing coordinate byte-identical', () => {
    const subject = deepestCapture();
    const before = modelState(subject.snapshot);
    const targets = agentIds(before);
    expect(targets.length).toBeGreaterThan(1);

    for (const target of targets) {
      const after = withChild(before, target, newTool(`added-tool-${target}`));
      const one = sessionLayout(before);
      const two = sessionLayout(after);

      for (const [id, cell] of one.cells) {
        const next = two.cells.get(id);
        expect(next, `cell ${id} vanished`).toBeDefined();
        if (next === undefined) continue;
        expect(Object.is(next.x, cell.x), `cell ${id} x moved`).toBe(true);
        expect(Object.is(next.y, cell.y), `cell ${id} y moved`).toBe(true);
        // R is content-derived by design (C7.1), and the blast radius is one
        // node: only the agent that gained a child may change size.
        if (id === target) continue;
        expect(Object.is(next.R, cell.R), `cell ${id} R changed`).toBe(true);
      }
      for (const [id, dot] of one.dots) {
        const next = two.dots.get(id);
        expect(next, `dot ${id} vanished`).toBeDefined();
        if (next === undefined) continue;
        expect(Object.is(next.x, dot.x), `dot ${id} x moved`).toBe(true);
        expect(Object.is(next.y, dot.y), `dot ${id} y moved`).toBe(true);
      }
      // The new dot really did appear, or this test would pass vacuously.
      expect(two.dots.has(`added-tool-${target}`)).toBe(true);
    }
  });

  it('adding a subagent and its edge leaves every pre-existing coordinate byte-identical', () => {
    const subject = deepestCapture();
    const before = modelState(subject.snapshot);
    // Hang the new agent off an existing tool call in the root, the way the
    // grafter does: the agent is a SIBLING of its spawning tool and the edge
    // is the only record of the relationship.
    const rootTool = before.root.children.find((c) => !isAgentNode(c));
    expect(rootTool).toBeDefined();
    if (rootTool === undefined) return;

    const spawned: AgentNode = {
      id: 'added-agent',
      kind: 'subagent',
      label: 'added',
      status: 'running',
      spawnDepth: 1,
      children: [],
      tokens: { in: 0, out: 0 },
      startedAt: 0,
    };
    const withAgent = withChild(before, before.root.id, spawned);
    const after: SessionState = {
      ...withAgent,
      spawnEdges: [
        ...(before.spawnEdges ?? []),
        {
          toolUseId: rootTool.id,
          agentId: 'added-agent',
          parentNodeId: before.root.id,
          depth: 1,
          recordedDepth: 1,
        },
      ],
    };

    const one = sessionLayout(before);
    const two = sessionLayout(after);
    expect(two.cells.has('added-agent')).toBe(true);
    for (const [id, cell] of one.cells) {
      const next = two.cells.get(id);
      expect(next).toBeDefined();
      if (next === undefined) continue;
      expect(Object.is(next.x, cell.x), `cell ${id} x moved`).toBe(true);
      expect(Object.is(next.y, cell.y), `cell ${id} y moved`).toBe(true);
      if (id === before.root.id) continue;
      expect(Object.is(next.R, cell.R), `cell ${id} R changed`).toBe(true);
    }
    for (const [id, dot] of one.dots) {
      const next = two.dots.get(id);
      expect(next).toBeDefined();
      if (next === undefined) continue;
      expect(Object.is(next.x, dot.x), `dot ${id} x moved`).toBe(true);
      expect(Object.is(next.y, dot.y), `dot ${id} y moved`).toBe(true);
    }
  });

  it('is deterministic: two calls on the same state are identical', () => {
    const state = modelState(deepestCapture().snapshot);
    expect(serializeLayout(sessionLayout(state))).toStrictEqual(
      serializeLayout(sessionLayout(state)),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. The dot cap
// ---------------------------------------------------------------------------

/** A single agent carrying `n` tool calls. Not a fixture, and not pretending to be. */
function agentWithTools(n: number): SessionState {
  const children: ToolNode[] = [];
  for (let i = 0; i < n; i += 1) children.push(newTool(`t${String(i).padStart(4, '0')}`));
  return {
    sessionId: 'cap',
    projectSlug: 'cap',
    workspaceMatch: true,
    liveness: 'live',
    schemaOk: true,
    root: {
      id: 'root',
      kind: 'main',
      label: 'main',
      status: 'running',
      spawnDepth: 0,
      children,
      tokens: { in: 0, out: 0 },
      startedAt: 0,
    },
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

describe(`the per-agent dot cap (DOT_CAP = ${DOT_CAP}, taken from canvas-contract)`, () => {
  it('keeps the LAST DOT_CAP dots, because what is happening now is at the end', () => {
    const state = agentWithTools(DOT_CAP + 7);
    const layout = sessionLayout(state);
    expect(layout.dots.size).toBe(DOT_CAP);
    expect(layout.dots.has('t0000')).toBe(false);
    expect(layout.dots.has(`t${String(DOT_CAP + 6).padStart(4, '0')}`)).toBe(true);
  });

  it('never records an elided count of 0, so a +n badge cannot read "+0"', () => {
    for (const n of [0, 1, DOT_CAP - 1, DOT_CAP]) {
      const layout = sessionLayout(agentWithTools(n));
      expect(layout.elided.size).toBe(0);
      expect(layout.dots.size).toBe(n);
    }
    const over = sessionLayout(agentWithTools(DOT_CAP + 5));
    expect(over.elided.get('root')).toBe(5);
    for (const value of over.elided.values()) expect(value).toBeGreaterThan(0);
  });

  it('the sliding cap moves nothing: surviving dots keep their coordinates', () => {
    const before = sessionLayout(agentWithTools(DOT_CAP + 3));
    const after = sessionLayout(agentWithTools(DOT_CAP + 4));
    let survivors = 0;
    for (const [id, dot] of before.dots) {
      const next = after.dots.get(id);
      if (next === undefined) continue; // dropped out of the visible span
      survivors += 1;
      expect(Object.is(next.x, dot.x), `dot ${id} x moved`).toBe(true);
      expect(Object.is(next.y, dot.y), `dot ${id} y moved`).toBe(true);
    }
    expect(survivors).toBe(DOT_CAP - 1);
  });

  it('no two simultaneously visible dots share a position', () => {
    const layout = sessionLayout(agentWithTools(DOT_CAP * 3 + 1));
    const seen = new Set<string>();
    for (const dot of layout.dots.values()) seen.add(`${dot.x},${dot.y}`);
    expect(seen.size).toBe(layout.dots.size);
    expect(layout.dots.size).toBe(DOT_CAP);
  });
});

// ---------------------------------------------------------------------------
// 7. The golden set must be compared, never rewritten, by a plain run
// ---------------------------------------------------------------------------

describe('golden hygiene', () => {
  it('countNodes counts agents and tools alike, root included', () => {
    const state = modelState(deepestCapture().snapshot);
    expect(countNodes(state)).toBe(agentIds(state).length + deepestCapture().snapshot.counts.toolNodes);
    expect(toDeckSession(state)).toStrictEqual({
      sessionId: state.sessionId,
      nodeCount: countNodes(state),
    });
  });

  it('a regeneration run is never green', () => {
    // HANDOVER carry-forward G: `AGENT_DECK_UPDATE_GOLDENS=1` turns golden
    // suites into a rubber stamp. It cannot here — with the var set this file
    // writes the new numbers and then FAILS, so the only way to a green run is
    // to read the diff and commit it. A plain `npx vitest run` writes nothing.
    expect(
      UPDATE_GOLDENS,
      'goldens were REGENERATED, not compared — review the diff and commit it, then re-run without AGENT_DECK_UPDATE_GOLDENS',
    ).toBe(false);
  });
});
