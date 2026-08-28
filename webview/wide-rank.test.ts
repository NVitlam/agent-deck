// The WIDE-RANK corpus, and the A8 properties it exists to pin.
//
// NODE ENVIRONMENT. Everything here is arithmetic over `layout.ts` and JSON on
// disk; nothing touches a DOM. The rendering half of A8.1 — that no dot element
// is drawn — belongs to `canvas.test.ts`, which mounts the real component.
//
// WHY THIS FILE EXISTS. The first real swarm session put 15 subagents at depth
// 1 under a root with 173 tool calls, and the renderer failed three ways at
// once. No corpus in this repository held that shape: `synthetic-stress` is
// wide in SESSIONS and deep in NODES, and the captured corpora carry three
// children at most. The defect had no fixture, so nothing could go red for it.
// `webview/wire/synthetic-wide-rank.json` is that fixture and this file is its
// guard. `docs/evidence/phase-8/WIDE-RANK.md` in the private repository carries
// the measurements.
//
// THE GOLDEN IS THE WHOLE TREE, not a summary. Rule 19: an assertion about an
// artifact pins the exact set and the exact count. A "no node overlaps another"
// property test would pass on a layout that had quietly become something else,
// and this layout's entire job is to be the same numbers every time.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, TreeNode } from '../src/model/events.js';
import { isAgentNode } from '../src/model/events.js';
import {
  LEVEL_GAP,
  NODE_H,
  ROW_GAP,
  SIBLING_GAP,
  WRAP_AT,
  nodeWidth,
  toolChildren,
  treeLayout,
} from './layout.js';
import type { TreePlacement } from './layout.js';

const CORPUS = 'webview/wire/synthetic-wide-rank.json';
const GOLDEN = 'webview/goldens/layout/wide-rank.json';

/** `scripts/make-wide-rank.mjs`, imported so the generator itself is the test. */
const GENERATOR = '../scripts/make-wide-rank.mjs';
/**
 * Held in a variable for the reason `testkit.ts` does it: `tsconfig.webview.json`
 * sets `types: []`, so a literal specifier for an untyped `.mjs` fails the
 * webview typecheck. Opaque to `tsc`, resolved at runtime by vitest.
 */
const RECORDER = '../scripts/record-wire.mjs';

interface Corpus {
  id: string;
  kind: string;
  final: { sessions: SessionState[] };
  events: { message: unknown }[];
}

let committed: Corpus;
let generated: { serialize: (c: unknown) => string; corpus: unknown };
let session: SessionState;
let placed: TreePlacement[];

beforeAll(async () => {
  committed = JSON.parse(await readFile(resolve(CORPUS), 'utf8')) as Corpus;
  const mod = (await import(/* @vite-ignore */ GENERATOR)) as {
    wideRankCorpus: () => unknown;
  };
  const recorder = (await import(/* @vite-ignore */ RECORDER)) as unknown as {
    serializeCorpus: (c: unknown) => string;
  };
  generated = { serialize: recorder.serializeCorpus, corpus: mod.wideRankCorpus() };
  const first = committed.final.sessions[0];
  if (first === undefined) throw new Error('corpus carries no session');
  session = first;
  placed = treeLayout(session, session.root.id).filter((p) => !p.hidden);
}, 60_000);

/** Newlines normalised, so a CRLF checkout is not a diff. */
const lf = (s: string): string => s.split('\r\n').join('\n');

function agentsOf(state: SessionState): Map<string, AgentNode> {
  const out = new Map<string, AgentNode>();
  const walk = (node: TreeNode): void => {
    if (!isAgentNode(node)) return;
    out.set(node.id, node);
    for (const kid of node.children) walk(kid);
  };
  walk(state.root);
  return out;
}

describe('the corpus is what its generator produces', () => {
  it('regenerates byte-for-byte', async () => {
    // Staleness detection, the `synthetic-stress` pattern. A corpus that had
    // drifted from its generator would still be a valid file and would still
    // satisfy every assertion below — it would just have stopped being the
    // shape the evidence document describes.
    const bytes = await readFile(resolve(CORPUS), 'utf8');
    expect(
      lf(generated.serialize(generated.corpus)),
      `${CORPUS} is stale — re-run \`node scripts/make-wide-rank.mjs\``,
    ).toBe(lf(bytes));
  });

  it('is the shape the evidence describes, counted', () => {
    const agents = agentsOf(session);
    const depth1 = [...agents.values()].filter((a) => a.spawnDepth === 1);
    const depth2 = [...agents.values()].filter((a) => a.spawnDepth === 2);
    expect(depth1).toHaveLength(15);
    expect(depth2).toHaveLength(2);
    expect(toolChildren(session.root)).toHaveLength(180);
    const calls = depth1.map((a) => toolChildren(a).length).sort((a, b) => a - b);
    expect(calls[0]).toBe(30);
    expect(calls[calls.length - 1]).toBe(240);
    // SYNTHETIC, and the id says so — `canvas-contract.ts:SYNTHETIC_CORPUS_PREFIX`.
    // It states nothing about Claude Code's schema, only about what the
    // renderer does with a `SessionState`, which is our own type.
    expect(committed.kind).toBe('synthetic');
    expect(committed.id.startsWith('synthetic-')).toBe(true);
  });
});

describe('A8.4 — the rank wraps, and the layout is the golden', () => {
  it('matches the committed placement table exactly', async () => {
    const golden = JSON.parse(await readFile(resolve(GOLDEN), 'utf8')) as TreePlacement[];
    const actual = placed.map((p) => ({
      id: p.id,
      depth: p.depth,
      x: p.x,
      y: p.y,
      w: p.w,
    }));
    expect(actual).toStrictEqual(golden);
    // The count beside the set (rule 19): a set comparison written against a
    // filtered or empty listing passes vacuously, and this is what goes red.
    expect(actual).toHaveLength(18);
  });

  it('lays 15 children out in rows of 8, in spawn order, left to right', () => {
    const kids = placed.filter((p) => p.depth === 1);
    expect(kids).toHaveLength(15);
    const rows = new Map<number, TreePlacement[]>();
    for (const k of kids) rows.set(k.y, [...(rows.get(k.y) ?? []), k]);
    const ys = [...rows.keys()].sort((a, b) => a - b);
    expect(ys).toHaveLength(2);
    expect(rows.get(ys[0] ?? 0)).toHaveLength(WRAP_AT);
    expect(rows.get(ys[1] ?? 0)).toHaveLength(15 - WRAP_AT);

    // Row gap is LEVEL/2, and the second row sits exactly one node plus that
    // gap below the first.
    expect(ROW_GAP).toBe(LEVEL_GAP / 2);
    expect((ys[1] ?? 0) - (ys[0] ?? 0)).toBe(NODE_H + ROW_GAP);

    // Spawn order fills left to right, then top to bottom. The corpus names its
    // children `wide-0` … `wide-14` in spawn order, so the reading order of the
    // placements must be exactly that sequence.
    const reading = [...kids]
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((p) => p.id);
    expect(reading).toStrictEqual(
      Array.from({ length: 15 }, (_, i) => `wide-${String(i)}`),
    );
  });

  it('pushes every deeper rank down by the extra row', () => {
    // A8.4: "every depth below a wrapped rank shifts down by the extra rows."
    // Depth 2 sits below BOTH rows of depth 1, not below the first one.
    const d2 = placed.filter((p) => p.depth === 2);
    expect(d2.length).toBeGreaterThan(0);
    expect(new Set(d2.map((p) => p.y)).size).toBe(1);

    // Derived from the rule, term by term, rather than written down: depth 1
    // starts one node and one level below the root; depth 2 starts below BOTH
    // of depth 1's rows plus the gap between them, plus a level.
    const rowsAtOne = 2;
    const topOfDepth1 = NODE_H + LEVEL_GAP;
    const heightOfDepth1 = rowsAtOne * NODE_H + (rowsAtOne - 1) * ROW_GAP;
    const topOfDepth2 = topOfDepth1 + heightOfDepth1 + LEVEL_GAP;
    expect(topOfDepth2).toBe(436);
    expect(d2[0]?.y).toBe(topOfDepth2);

    // ...and WITHOUT the wrap it would have been 328, so this assertion is
    // about the shift rather than about the arithmetic being self-consistent.
    expect(topOfDepth1 + NODE_H + LEVEL_GAP).toBe(328);
  });

  it('never overlaps two nodes, in any row', () => {
    // The property the tidy tree exists for, asserted on the shape that broke
    // it. Columns are shared across rows precisely so a row-1 child cannot sit
    // above a row-0 child's descendants.
    const byRow = new Map<string, TreePlacement[]>();
    for (const p of placed) {
      const key = `${String(p.depth)}:${String(p.y)}`;
      byRow.set(key, [...(byRow.get(key) ?? []), p]);
    }
    for (const [key, list] of byRow) {
      const sorted = [...list].sort((a, b) => a.x - b.x);
      for (let i = 0; i + 1 < sorted.length; i += 1) {
        const left = sorted[i];
        const right = sorted[i + 1];
        if (left === undefined || right === undefined) continue;
        expect(
          left.x + left.w,
          `${left.id} overlaps ${right.id} in ${key}`,
        ).toBeLessThanOrEqual(right.x);
        expect(right.x - (left.x + left.w)).toBeGreaterThanOrEqual(SIBLING_GAP - 0.001);
      }
    }
  });
});

describe('A8.3 — a node’s footprint is its own width', () => {
  it('draws every node exactly nodeWidth wide, with nothing hanging outside it', () => {
    const agents = agentsOf(session);
    for (const p of placed) {
      const agent = agents.get(p.id);
      expect(agent, p.id).toBeDefined();
      if (agent === undefined) continue;
      expect(p.w, `${p.id} is not drawn at its own width`).toBe(nodeWidth(agent));
    }
  });
});

describe('determinism', () => {
  it('produces byte-identical placements over 100 replays', () => {
    // DoD 7.3, on the corpus that broke the layout. The tree is re-derived from
    // the same state 100 times; a `Map` iteration order, a sort that is not
    // total, or a cached width would show up here and nowhere else.
    const first = JSON.stringify(treeLayout(session, session.root.id));
    for (let i = 0; i < 100; i += 1) {
      expect(JSON.stringify(treeLayout(session, session.root.id)), `replay ${String(i)}`).toBe(
        first,
      );
    }
  });

  it('is unchanged by the order the AGENT children arrive in', () => {
    // The spawn-order sort is what makes the rows deterministic. Reversing the
    // agent children must change nothing, or the reading order above was an
    // accident of the fixture rather than a property of the layout.
    //
    // The AGENTS only. `orderedChildAgents` sorts on the position of each
    // child's spawning call in the parent's transcript, so reversing the tool
    // calls too would reverse the transcript itself — a different session, not
    // a different arrival order, and the assertion would be false for a reason
    // that has nothing to do with determinism.
    const tools = session.root.children.filter((c) => !isAgentNode(c));
    const agents = session.root.children.filter(isAgentNode);
    const reversed: SessionState = {
      ...session,
      root: { ...session.root, children: [...tools, ...[...agents].reverse()] },
    };
    expect(JSON.stringify(treeLayout(reversed, reversed.root.id))).toBe(
      JSON.stringify(treeLayout(session, session.root.id)),
    );
  });
});
