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

import type {
  AgentNode,
  ParkedGraft,
  SessionState,
  SpawnEdge,
  ToolNode,
} from '../src/model/events.js';
import { isAgentNode } from '../src/model/events.js';
import type { GraftSnapshot } from '../src/model/graft.js';
import { graftSession, toSessionState } from '../src/model/graft.js';
import { DOT_CAP } from './canvas-contract.js';
import type { DeckPlacement, SessionLayout } from './canvas-contract.js';
import {
  BLOB_AMPLITUDE,
  CELL_RADIUS_MAX,
  CONSTELLATION_CAP,
  CONSTELLATION_INSET,
  DOTS_PER_RING,
  DOT_RINGS,
  DOT_RING_BASE,
  DOT_SLOT_PERIOD,
  PARKED_ORBIT,
  PARKED_ORBIT_SPREAD,
  blobPath,
  constellationPoints,
  countNodes,
  deckLayout,
  hashSessionId,
  sessionLayout,
  toDeckSession,
  CELL_FOOTPRINT,
  roundCoord,
  LABEL_PAD,
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

/** `SessionLayout` as JSON: Maps become entry arrays, in insertion order. */
function serializeLayout(layout: SessionLayout): unknown {
  return {
    cells: [...layout.cells.entries()],
    dots: [...layout.dots.entries()],
    elided: [...layout.elided.entries()],
    parked: [...layout.parked.entries()],
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
 * edges AND the parked list, exactly as `SessionModel.viewFromSnapshot`
 * assembles them — see `toWireParked` in `src/model/session.ts`, which this
 * mirrors field for field, absent optionals left absent.
 */
function modelState(snapshot: GraftSnapshot): SessionState {
  const edges: SpawnEdge[] = snapshot.edges.map((e) => ({
    toolUseId: e.toolUseId,
    agentId: e.agentId,
    parentNodeId: e.parentNodeId,
    depth: e.depth,
    recordedDepth: e.recordedDepth,
  }));
  const parked: ParkedGraft[] = snapshot.parked.map((p) => {
    const out: ParkedGraft = { agentId: p.agentId, code: p.code, reason: p.reason };
    if (p.toolUseId !== undefined) out.toolUseId = p.toolUseId;
    if (p.parentAgentId !== undefined) out.parentAgentId = p.parentAgentId;
    return out;
  });
  return {
    ...toSessionState(snapshot, { liveness: 'live', workspaceMatch: true }),
    spawnEdges: edges,
    parked,
  };
}

/** Every committed graft fixture whose graft parks at least one agent. */
function parkedSubjects(): Subject[] {
  const out = [...synthetic, ...captured].filter((s) => s.snapshot.parked.length > 0);
  if (out.length === 0) throw new Error('no committed fixture parks an agent');
  return out;
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
// 3b. The deck constellation (C7.1)
// ---------------------------------------------------------------------------

/**
 * The minimum distance from `(cx, cy)` to the silhouette `blobPath` emitted.
 *
 * The containment claim is measured against the REAL curve, not against the
 * arithmetic that produced it: the path text is parsed back and every cubic
 * segment is sampled. Asserting `reach < R * (1 - BLOB_AMPLITUDE)` would only
 * restate `constellationPoints`'s own formula, and the silhouette dips inside
 * that bound between vertices — which is exactly the gap an eyeball misses.
 */
function minSilhouetteRadius(d: string, cx: number, cy: number, samples: number): number {
  const tokens = d.split(' ').filter((t) => t !== '');
  const numbers: number[] = [];
  const commands: string[] = [];
  for (const token of tokens) {
    if (token === 'M' || token === 'C' || token === 'Z') commands.push(token);
    else numbers.push(Number(token));
  }
  expect(commands[0]).toBe('M');
  expect(commands[commands.length - 1]).toBe('Z');

  let at = 0;
  const next = (): number => {
    const value = numbers[at];
    at += 1;
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`bad path number at ${at - 1}`);
    }
    return value;
  };

  let x0 = next();
  let y0 = next();
  let min = Number.POSITIVE_INFINITY;
  const consider = (px: number, py: number): void => {
    min = Math.min(min, Math.hypot(px - cx, py - cy));
  };
  consider(x0, y0);

  while (at < numbers.length) {
    const c1x = next();
    const c1y = next();
    const c2x = next();
    const c2y = next();
    const x1 = next();
    const y1 = next();
    for (let s = 1; s <= samples; s += 1) {
      const t = s / samples;
      const u = 1 - t;
      const bx = u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x1;
      const by = u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y1;
      consider(bx, by);
    }
    x0 = x1;
    y0 = y1;
  }
  return min;
}

describe('the deck constellation: one dot per node, density without a number', () => {
  it('is pinned as coordinate numbers at 0, a small count, and above the cap', async () => {
    const seeds = captured.map((s) => ({
      sessionId: s.snapshot.sessionId,
      seed: hashSessionId(s.snapshot.sessionId),
    }));
    expect(seeds.length).toBeGreaterThan(0);

    const counts = [0, 7, CONSTELLATION_CAP + 25];
    const entries: unknown[] = [];
    for (const { sessionId, seed } of seeds) {
      for (const count of counts) {
        entries.push({
          sessionId,
          seed,
          count,
          points: constellationPoints(0, 0, 60, count, seed),
        });
      }
    }
    await golden('deck-constellation', {
      source: repoPath(CAPTURED_ROOT),
      cap: CONSTELLATION_CAP,
      inset: CONSTELLATION_INSET,
      radius: 60,
      entries,
    });
  });

  it('count 0 is a real case and yields no points', () => {
    expect(constellationPoints(10, -4, 50, 0, 1)).toStrictEqual([]);
    // Nonsense counts refuse to draw rather than throwing: this is renderer
    // input, and refusing is the safe direction.
    expect(constellationPoints(10, -4, 50, -3, 1)).toStrictEqual([]);
    expect(constellationPoints(10, -4, 50, Number.NaN, 1)).toStrictEqual([]);
    expect(constellationPoints(10, -4, 50, Number.POSITIVE_INFINITY, 1)).toStrictEqual([]);
  });

  it('is deterministic: same arguments, identical numbers', () => {
    const one = constellationPoints(3, 9, 44, 30, hashSessionId('a'));
    const two = constellationPoints(3, 9, 44, 30, hashSessionId('a'));
    expect(one).toStrictEqual(two);
    // The seed rotates the pattern, so two sessions are distinguishable.
    expect(constellationPoints(3, 9, 44, 30, hashSessionId('b'))).not.toStrictEqual(one);
  });

  it('is incremental by index: a node arriving never shuffles the constellation', () => {
    const seed = hashSessionId('c--Users-dev-projects-agent-deck');
    // Walk the whole range including the boundary, so the cap itself is
    // covered rather than assumed to behave like the interior.
    for (let count = 0; count < CONSTELLATION_CAP + 4; count += 1) {
      const before = constellationPoints(12, -7, 55, count, seed);
      const after = constellationPoints(12, -7, 55, count + 1, seed);
      expect(after.length).toBeGreaterThanOrEqual(before.length);
      for (let i = 0; i < before.length; i += 1) {
        const a = before[i];
        const b = after[i];
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        if (a === undefined || b === undefined) continue;
        // Byte-identical, not approximately equal — a tolerance here is how a
        // slow drift gets through.
        expect(Object.is(b.x, a.x), `point ${i} x moved at count ${count}`).toBe(true);
        expect(Object.is(b.y, a.y), `point ${i} y moved at count ${count}`).toBe(true);
      }
    }
  });

  it(`saturates at CONSTELLATION_CAP = ${CONSTELLATION_CAP} and never grows again`, () => {
    const seed = hashSessionId('cap');
    expect(constellationPoints(0, 0, 50, CONSTELLATION_CAP - 1, seed)).toHaveLength(
      CONSTELLATION_CAP - 1,
    );
    const atCap = constellationPoints(0, 0, 50, CONSTELLATION_CAP, seed);
    expect(atCap).toHaveLength(CONSTELLATION_CAP);
    // An R2-scale session. The blob does not thin out, re-space or change at
    // all: identical output, so the element count per blob is bounded by the cap.
    for (const huge of [CONSTELLATION_CAP + 1, 1_000, 250_000]) {
      expect(constellationPoints(0, 0, 50, huge, seed)).toStrictEqual(atCap);
    }
  });

  it('every point lies inside the silhouette blobPath draws for the same seed', () => {
    // A broad seed sample, because the wobble is per-seed: a containment claim
    // checked on one silhouette says nothing about the next one.
    const SEED_SAMPLE = 400;
    const R = 60;
    let worstMargin = Number.POSITIVE_INFINITY;
    for (let n = 0; n < SEED_SAMPLE; n += 1) {
      const seed = hashSessionId(`containment-${n}`);
      const centre = { x: n % 7, y: -(n % 5) };
      const d = blobPath(centre.x, centre.y, R, seed);
      const inner = minSilhouetteRadius(d, centre.x, centre.y, 40);
      let furthest = 0;
      for (const p of constellationPoints(centre.x, centre.y, R, CONSTELLATION_CAP, seed)) {
        furthest = Math.max(furthest, Math.hypot(p.x - centre.x, p.y - centre.y));
      }
      expect(furthest).toBeGreaterThan(0);
      expect(
        furthest,
        `seed ${seed}: a dot at ${furthest} is outside a membrane that dips to ${inner}`,
      ).toBeLessThan(inner);
      worstMargin = Math.min(worstMargin, inner - furthest);
    }
    // The margin is BANDED rather than pinned. Measured over this sample:
    // 17.43 on R = 60 — the tightest silhouette dip still clears the outermost
    // dot by 29% of R. A band catches the two failures that matter (the margin
    // shrinking toward zero, or the constellation collapsing to the centre and
    // making the containment assertion above trivially true) without breaking
    // on a last-ulp difference somewhere else.
    expect(worstMargin).toBeGreaterThan(R * 0.2);
    expect(worstMargin).toBeLessThan(R * 0.45);
  });

  it('the reach is derived from BLOB_AMPLITUDE, not chosen independently of it', () => {
    // Raising the wobble in blobPath without revisiting the inset would push
    // dots outside a membrane that moved; this ties the two together.
    const R = 100;
    const points = constellationPoints(0, 0, R, CONSTELLATION_CAP, hashSessionId('reach'));
    let furthest = 0;
    for (const p of points) furthest = Math.max(furthest, Math.hypot(p.x, p.y));
    const reach = R * (1 - BLOB_AMPLITUDE) * CONSTELLATION_INSET;
    expect(furthest).toBeLessThanOrEqual(reach);
    // ...and it reaches most of the way out, so the containment test above is
    // not trivially satisfied by a constellation clustered at the centre.
    expect(furthest).toBeGreaterThan(reach * 0.98);
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

    // PARKED AND CELLS ARE DISJOINT, from both directions. The parked agent is
    // not in `root` — the grafter deliberately leaves it off — so it gets no
    // cell; and it IS placed, on its own orbit, from `session.parked`. Before
    // that field existed this assertion held for the empty reason: there was no
    // channel and nothing was ever placed. It now holds for the real one, which
    // is why the second half is asserted rather than assumed.
    for (const entry of subject.snapshot.parked) {
      expect(layout.cells.has(entry.agentId)).toBe(false);
      expect(layout.parked.has(entry.agentId)).toBe(true);
    }
    for (const agentId of layout.parked.keys()) expect(layout.cells.has(agentId)).toBe(false);
    for (const agentId of layout.cells.keys()) expect(layout.parked.has(agentId)).toBe(false);
    expect(layout.parked.size).toBe(subject.snapshot.parked.length);

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

  it('G3: a refused session lays out to nothing at all, parked included', () => {
    const subject = parkedSubject();
    // A subject that DOES park, and whose parked list is carried into the
    // refused state on purpose. Refusing a session that parks nothing would
    // pass this test while proving nothing about the field that was added
    // after the refusal path was written — which is exactly where a refusal
    // quietly stops applying.
    const base = modelState(subject.snapshot);
    expect(base.parked?.length ?? 0).toBeGreaterThan(0);
    expect(sessionLayout(base).parked.size).toBeGreaterThan(0);

    for (const refused of [
      { ...base, schemaOk: false, liveness: 'unsupported' as const },
      // Each half of the OR on its own, because the model sets them together
      // and a test that only ever sends both cannot tell which one is doing
      // the work.
      { ...base, schemaOk: false },
      { ...base, liveness: 'unsupported' as const },
    ]) {
      const layout = sessionLayout(refused);
      expect(layout.cells.size).toBe(0);
      expect(layout.dots.size).toBe(0);
      expect(layout.elided.size).toBe(0);
      expect(layout.parked.size).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4b. Parked grafts: the agents that are not in the tree at all
// ---------------------------------------------------------------------------

describe('parked grafts, placed from session.parked and never from the tree', () => {
  it('covers every park code the committed fixtures actually produce', async () => {
    const subjects = parkedSubjects();
    const entries = subjects.map((subject) => {
      const state = modelState(subject.snapshot);
      const layout = sessionLayout(state);
      return {
        source: repoPath(subject.path),
        parked: (state.parked ?? []).map((entry) => ({
          agentId: entry.agentId,
          code: entry.code,
          // Recorded because one fixture carries it and the others do not;
          // `null` rather than an absent key so the golden shows the difference.
          parentAgentId: entry.parentAgentId ?? null,
          toolUseId: entry.toolUseId ?? null,
        })),
        placements: [...layout.parked.entries()],
      };
    });

    // Derived from the fixtures, never listed here: a re-harvest that adds a
    // park code widens this golden instead of silently leaving it uncovered.
    const codes = [
      ...new Set(subjects.flatMap((s) => s.snapshot.parked.map((p) => p.code))),
    ].sort();
    // More than one distinct refusal reason is on record, so this is a suite
    // rather than one case wearing a plural name.
    expect(codes.length).toBeGreaterThan(1);
    // At least one fixture states a parent it could not find, which is the
    // shape that carries `parentAgentId`.
    expect(
      subjects.some((s) => s.snapshot.parked.some((p) => p.parentAgentId !== undefined)),
    ).toBe(true);

    await golden('session-parked-codes', { codes, entries });
  });

  it('places every parked agent, and never one that is in the tree', () => {
    for (const subject of parkedSubjects()) {
      const state = modelState(subject.snapshot);
      const layout = sessionLayout(state);
      expect(layout.parked.size).toBe(subject.snapshot.parked.length);
      for (const entry of subject.snapshot.parked) {
        expect(layout.parked.has(entry.agentId), `${entry.agentId} not placed`).toBe(true);
        expect(layout.cells.has(entry.agentId), `${entry.agentId} in both maps`).toBe(false);
      }
    }
  });

  it('drops a contradictory entry rather than drawing one agent twice', () => {
    // A host that named a grafted agent as parked is contradicting itself. The
    // tree is the half with a node, a parent and children behind it, so the
    // parked claim is the one dropped. Hand-built, because no fixture produces
    // a contradiction and no fixture should.
    const subject = deepestCapture();
    const state = modelState(subject.snapshot);
    const inTree = agentIds(state).find((id) => id !== state.root.id);
    expect(inTree).toBeDefined();
    if (inTree === undefined) return;

    const contradictory: SessionState = {
      ...state,
      parked: [{ agentId: inTree, code: 'noMatchingToolUse', reason: 'contradiction' }],
    };
    const layout = sessionLayout(contradictory);
    expect(layout.cells.has(inTree)).toBe(true);
    expect(layout.parked.has(inTree)).toBe(false);
    expect(layout.parked.size).toBe(0);
  });

  it('is placed from the agentId, so the host\'s list order cannot move anything', () => {
    const subject = parkedSubject();
    const state = modelState(subject.snapshot);
    const list = [...(state.parked ?? [])];
    expect(list.length).toBeGreaterThan(0);

    // The grafter sorts `parked` by agentId — verified here rather than taken
    // on trust, because the placement rule below exists precisely BECAUSE that
    // sort means a new entry lands in the middle of the list.
    const sorted = [...list].sort((a, b) => a.agentId.localeCompare(b.agentId));
    expect(list.map((p) => p.agentId)).toStrictEqual(sorted.map((p) => p.agentId));

    // Reversed, and every placement is identical: order is not an input.
    const reversed = sessionLayout({ ...state, parked: [...list].reverse() });
    const forward = sessionLayout(state);
    for (const [id, placement] of forward.parked) {
      const other = reversed.parked.get(id);
      expect(other).toBeDefined();
      if (other === undefined) continue;
      expect(Object.is(other.x, placement.x)).toBe(true);
      expect(Object.is(other.y, placement.y)).toBe(true);
      expect(Object.is(other.R, placement.R)).toBe(true);
    }
    expect(reversed.parked.size).toBe(forward.parked.size);
  });

  it('a parked graft arriving never moves one already placed', () => {
    const subject = deepestCapture();
    const base = modelState(subject.snapshot);
    // Ids chosen to sort BEFORE and BETWEEN the ones already there, because an
    // append-only test would pass under a positional rule and prove nothing.
    const growing: ParkedGraft[] = [];
    let previous = sessionLayout({ ...base, parked: [] });
    for (const agentId of ['zzz-late', 'aaa-early', 'mmm-middle', 'aaa-earlier']) {
      growing.push({ agentId, code: 'noMatchingToolUse', reason: 'synthetic' });
      // Sorted the way the host sends it, so each arrival really does shift
      // every later entry's position in the list.
      const parked = [...growing].sort((a, b) => a.agentId.localeCompare(b.agentId));
      const next = sessionLayout({ ...base, parked });
      expect(next.parked.size).toBe(growing.length);
      for (const [id, placement] of previous.parked) {
        const after = next.parked.get(id);
        expect(after, `${id} vanished`).toBeDefined();
        if (after === undefined) continue;
        expect(Object.is(after.x, placement.x), `${id} x moved`).toBe(true);
        expect(Object.is(after.y, placement.y), `${id} y moved`).toBe(true);
        expect(Object.is(after.R, placement.R), `${id} R changed`).toBe(true);
      }
      previous = next;
    }
  });

  it('a parked graft that later resolves leaves parked and appears in cells', () => {
    // The state transition the product cares about: attribution arrives, the
    // agent stops being a refusal and becomes a node. Driven through the same
    // helpers rather than by hand-editing a layout.
    const subject = deepestCapture();
    const state = modelState(subject.snapshot);
    const resolved = agentIds(state).find((id) => id !== state.root.id);
    expect(resolved).toBeDefined();
    if (resolved === undefined) return;

    // Before: the tree without that agent, and the agent named as parked.
    const stripped: SessionState = {
      ...state,
      root: {
        ...state.root,
        children: state.root.children.filter((c) => !isAgentNode(c) || c.id !== resolved),
      },
      parked: [{ agentId: resolved, code: 'noMatchingToolUse', reason: 'awaiting attribution' }],
    };
    const before = sessionLayout(stripped);
    expect(before.parked.has(resolved)).toBe(true);
    expect(before.cells.has(resolved)).toBe(false);

    // After: the real state, where the join resolved and `parked` no longer
    // names it.
    const after = sessionLayout(state);
    expect(after.parked.has(resolved)).toBe(false);
    expect(after.cells.has(resolved)).toBe(true);
  });

  it('sits outside every cell and dot on the real fixtures', () => {
    // A measurement on the committed data, not a universal claim: nesting is
    // depth-scaled but unbounded, so no fixed orbit can be outside every
    // conceivable tree. What is load-bearing is the separate map and the
    // absent filament; this is the visual separation, measured where it counts.
    let checked = 0;
    for (const subject of parkedSubjects()) {
      const state = modelState(subject.snapshot);
      const layout = sessionLayout(state);
      let furthestContent = 0;
      for (const c of layout.cells.values()) {
        furthestContent = Math.max(furthestContent, Math.hypot(c.x, c.y) + c.R);
      }
      for (const d of layout.dots.values()) {
        furthestContent = Math.max(furthestContent, Math.hypot(d.x, d.y));
      }
      for (const [id, placement] of layout.parked) {
        const inner = Math.hypot(placement.x, placement.y) - placement.R;
        expect(inner, `${id} overlaps the interior`).toBeGreaterThan(furthestContent);
        expect(Math.hypot(placement.x, placement.y)).toBeGreaterThanOrEqual(PARKED_ORBIT);
        expect(Math.hypot(placement.x, placement.y)).toBeLessThanOrEqual(
          PARKED_ORBIT + PARKED_ORBIT_SPREAD,
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('an absent parked field is the same as an empty one', () => {
    const subject = deepestCapture();
    const state = modelState(subject.snapshot);
    const { parked: _dropped, ...without } = state;
    expect(sessionLayout(without as SessionState).parked.size).toBe(0);
    expect(sessionLayout({ ...state, parked: [] }).parked.size).toBe(0);
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
      contextNow: { prompt: 0, output: 0 },
      burn: { prompt: 0, output: 0 },
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
      contextNow: { prompt: 0, output: 0 },
      burn: { prompt: 0, output: 0 },
      startedAt: 0,
    },
    totals: { costUsd: 0 },
    contextNow: { prompt: 0, output: 0 },
    burn: { prompt: 0, output: 0 },
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

describe('nothing overlaps: separation is why the picture is readable', () => {
  /** Every pair, so one missed collision cannot hide behind an average. */
  function overlaps(
    circles: readonly { x: number; y: number; R: number }[],
  ): Array<[number, number, number]> {
    const bad: Array<[number, number, number]> = [];
    for (let i = 0; i < circles.length; i += 1) {
      for (let j = i + 1; j < circles.length; j += 1) {
        const p = circles[i];
        const q = circles[j];
        if (p === undefined || q === undefined) continue;
        const gap = Math.hypot(p.x - q.x, p.y - q.y) - p.R - q.R;
        if (gap < 0) bad.push([i, j, gap]);
      }
    }
    return bad;
  }

  /** Sizes deliberately varied: even centres, uneven radii, is the bug. */
  function deckOf(n: number): DeckSession[] {
    return Array.from({ length: n }, (_, i) => ({
      sessionId: `s-${String(i)}`,
      nodeCount: 1 + ((i * 37) % 400),
    }));
  }

  it('places no two deck blobs on top of each other, at any count', () => {
    // The spiral spaces CENTRES evenly and knows nothing about radii, so a
    // busy session beside a quiet one is exactly the case that overlapped.
    for (const n of [2, 6, 12, 30]) {
      const bad = overlaps(deckLayout(deckOf(n)));
      expect(bad, `${String(bad.length)} overlapping pairs at n=${String(n)}`).toEqual([]);
    }
  });

  it('places no two cells on top of each other, on every committed fixture', () => {
    const subjects = [...captured, ...synthetic];
    expect(subjects.length).toBeGreaterThan(0);
    let checked = 0;
    for (const subject of subjects) {
      const layout = sessionLayout(modelState(subject.snapshot));
      const circles = [...layout.cells.values(), ...layout.parked.values()];
      if (circles.length < 2) continue;
      checked += 1;
      const bad = overlaps(circles);
      expect(bad, `${String(bad.length)} overlapping cells in ${subject.path}`).toEqual([]);
    }
    // Loud rather than vacuous: a corpus of one-cell sessions would pass
    // this test while proving nothing about separation.
    expect(checked).toBeGreaterThan(0);
  });

  it('STILL INCREMENTAL: separating a newcomer never moves anyone already placed', () => {
    // The property separation could plausibly have broken, and the reason it
    // does not: only the candidate moves, and placement order is fixed.
    for (let n = 1; n < 14; n += 1) {
      const before = deckLayout(deckOf(n));
      const after = deckLayout(deckOf(n + 1));
      for (let i = 0; i < before.length; i += 1) {
        expect(Object.is(after[i]?.x, before[i]?.x), `blob ${String(i)} moved in x at n=${String(n)}`).toBe(
          true,
        );
        expect(Object.is(after[i]?.y, before[i]?.y), `blob ${String(i)} moved in y at n=${String(n)}`).toBe(
          true,
        );
      }
    }
  });

  it('STILL DETERMINISTIC: the same input separates to the same coordinates', () => {
    expect(deckLayout(deckOf(12))).toStrictEqual(deckLayout(deckOf(12)));
    const state = modelState(deepestCapture().snapshot);
    expect(sessionLayout(state).cells).toStrictEqual(sessionLayout(state).cells);
  });

  it('terminates on a pathological pile rather than looping forever', () => {
    // SEPARATION_ATTEMPTS is a bound, not a target. A layout that cannot be
    // fully separated must still RETURN: overlapping is a visual defect,
    // hanging is a broken panel.
    const many = Array.from({ length: 200 }, (_, i) => ({
      sessionId: `s-${String(i)}`,
      nodeCount: 5000,
    }));
    const placed = deckLayout(many);
    expect(placed).toHaveLength(200);
    for (const p of placed) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe('CELL_FOOTPRINT agrees with the constants it was derived from', () => {
  it('equals LABEL_PAD + CELL_RADIUS_MAX', () => {
    // CELL_FOOTPRINT spells CELL_RADIUS_MAX as a literal, because that
    // constant is declared further down layout.ts than the footprint is used.
    // This is the guard that keeps the literal honest: change the max cell
    // radius and this fails rather than the layout quietly under-separating.
    expect(CELL_FOOTPRINT).toBe(roundCoord(LABEL_PAD + CELL_RADIUS_MAX));
  });

  it('reserves more room for the label than for the membrane', () => {
    // The point of the whole change: the text is the wide thing, not the
    // circle. If this ever inverts, separating on the membrane would be
    // enough again and the pad would be dead weight.
    expect(LABEL_PAD).toBeGreaterThan(CELL_RADIUS_MAX / 2);
  });
});
