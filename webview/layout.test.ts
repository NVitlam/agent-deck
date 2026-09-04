// The layout engine's whole test story: the frozen design's golden tables,
// reproduced through PRODUCTION code, plus the purity and incrementality
// properties that constrain how that code is allowed to be written.
//
// NODE ENVIRONMENT, deliberately. `layout.ts` never touches a DOM, so running
// it under jsdom would prove nothing and would hand the code under test a
// global it is asserted never to reach.
//
// Node builtins are imported by their real specifiers. `tsconfig.webview.json`
// sets `types: []`, which removes node's GLOBALS from this project, so
// anything from `process` is imported from `node:process` rather than read off
// a global. Nothing in this file is reachable from `webview/main.ts`.
//
// WHERE THE EXPECTED NUMBERS COME FROM, and why this is evidence rather than a
// tautology. `webview/goldens/layout/design-tables.json` is the VERBATIM stdout
// of `node webview/layout.reference.mjs`, the frozen design's own independent
// implementation of the same arithmetic. This file re-emits those tables from
// `layout.ts` and compares line for line. The two implementations share no
// code: `layout.ts` must never import the reference, and the first test below
// reads `layout.ts`'s own source text to prove it does not. If production
// imported the reference the comparison would be the reference against itself
// - passing forever, and exactly as green as a real pass.

import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, SpawnEdge, ToolNode } from '../src/model/events.js';
import {
  AUTO_COLLAPSE_NODES,
  COLLAPSE_DEPTH,
  DECK_CARD_H,
  DECK_CARD_W,
  DECK_GAP_X,
  DECK_GAP_Y,
  DECK_GRID_MARGIN,
  DECK_LANE_GAP,
  DECK_LANE_HEADER_Y,
  DEFAULT_DECK_LAYOUT,
  DEFAULT_DECK_SORT,
  LABEL_ADVANCE,
  LABEL_MAX_CHARS,
  LEVEL_GAP,
  NODE_H,
  NODE_H_TWO_LINE,
  NODE_W_MIN,
  SIBLING_GAP,
  SUB_ADVANCE,
  autoCollapseDepth,
  countNodes,
  deckColumns,
  deckEngine,
  deckLaneEngines,
  deckLaneX,
  deckLanesDegrade,
  deckLayout,
  formatCompactTokens,
  nodeLabelText,
  nodeSubText,
  nodeWidth,
  roundCoord,
  sortDeckSessions,
  toDeckSession,
  toolChildren,
  treeLayout,
  visibleNodeCount,
} from './layout.js';
import type {
  DeckEngine,
  DeckLayoutMode,
  DeckPlacement,
  DeckSession,
  DeckSortMode,
  TreePlacement,
} from './layout.js';
import { DEFAULT_ENGINE_FILTER } from './canvas-contract.js';

const REPO_ROOT = resolve('.');
const WEBVIEW_DIR = join(REPO_ROOT, 'webview');
const GOLDEN_FILE = join(WEBVIEW_DIR, 'goldens', 'layout', 'design-tables.json');
/** DoD 5.0c's golden: lane coordinates for all seven engine subsets. */
const LANE_SUBSET_GOLDEN_FILE = join(
  WEBVIEW_DIR,
  'goldens',
  'layout',
  'lane-subsets.json',
);
/**
 * The frozen reference, as a path this file can hand to `node`.
 *
 * Repo-relative on purpose: it is passed as an argv with `cwd: REPO_ROOT`, so
 * a failure names `webview/layout.reference.mjs` rather than a machine path.
 */
const REFERENCE_FILE = 'webview/layout.reference.mjs';

/* ------------------------------------------------------------------------ *
 * Mock data — the same subjects the reference uses, in production shapes
 * ------------------------------------------------------------------------ */

// The deck rows are `layout.reference.mjs`'s SESSIONS, field for field.
// `last` is an offset from an unnamed "now" in milliseconds and ONLY ITS
// ORDERING MATTERS, which is what lets this be deterministic with no clock.
const DECK_SESSIONS: readonly DeckSession[] = [
  { id: '6082be25', engine: 'cc', status: 'live', last: -4000 },
  { id: 'ses_a91f', engine: 'oc', status: 'live', last: -11000 },
  { id: '4299490e', engine: 'cc', status: 'idle', last: -140000 },
  { id: 'ses_77c0', engine: 'oc', status: 'idle', last: -260000 },
  { id: 'b3d1c0a2', engine: 'cc', status: 'unsupported', last: -5400000 },
  { id: 'ses_20de', engine: 'oc', status: 'degraded', last: -90000 },
  { id: '9f0e11aa', engine: 'cc', status: 'ended', last: -9000000 },
];

interface MockTool {
  id: string;
  status: ToolNode['status'];
}

interface MockAgent {
  id: string;
  label: string;
  tokens: number;
  parent: string | null;
  spawnedBy?: string;
  tools: MockTool[];
}

const done = (id: string): MockTool => ({ id, status: 'done' });
const running = (id: string): MockTool => ({ id, status: 'running' });
const failed = (id: string): MockTool => ({ id, status: 'error' });

// `layout.reference.mjs`'s S.agents, in its declaration order — the order the
// node-widths table is emitted in.
const MOCK_AGENTS: readonly MockAgent[] = [
  {
    id: 'main',
    label: 'main',
    tokens: 184300,
    parent: null,
    tools: [
      done('t1'),
      done('t2'),
      done('t3'),
      running('t4'),
      done('t5'),
      running('t6'),
      failed('t7'),
    ],
  },
  {
    id: 'a1',
    label: 'harvest-r1-pair',
    tokens: 41200,
    parent: 'main',
    spawnedBy: 't3',
    tools: [done('a1t1'), done('a1t2'), done('a1t3')],
  },
  {
    id: 'a2',
    label: 'privacy-sweep-audit',
    tokens: 22800,
    parent: 'main',
    spawnedBy: 't4',
    tools: [done('a2t1'), running('a2t2')],
  },
  {
    id: 'a3',
    label: 'readme-guard-rederive',
    tokens: 9100,
    parent: 'main',
    spawnedBy: 't6',
    tools: [done('a3t1'), running('a3t2'), done('a3t3'), running('a3t4')],
  },
  {
    id: 'a1a',
    label: 'verify-meta-json',
    tokens: 3200,
    parent: 'a1',
    spawnedBy: 'a1t3',
    tools: [done('a1at1')],
  },
  {
    id: 'a3a',
    label: 'diff-readme-lines',
    tokens: 1500,
    parent: 'a3',
    spawnedBy: 'a3t2',
    tools: [running('a3at1'), running('a3at2')],
  },
  {
    id: 'a3b',
    label: 'run-vitest-subset',
    tokens: 6100,
    parent: 'a3',
    spawnedBy: 'a3t3',
    tools: [done('a3bt1'), failed('a3bt2')],
  },
  {
    id: 'a3aa',
    label: 'count-anchors',
    tokens: 400,
    parent: 'a3a',
    spawnedBy: 'a3at2',
    tools: [running('a3aat1')],
  },
];

function toolNode(tool: MockTool): ToolNode {
  return {
    id: tool.id,
    toolName: tool.id.startsWith('t') ? 'Agent' : 'Read',
    status: tool.status,
    inputPreview: '',
  };
}

/**
 * Build the production `SessionState` for the mock tree.
 *
 * AGENT CHILDREN ARE APPENDED IN REVERSE SPAWN ORDER, on purpose. If the
 * layout drew them in array order the golden would fail; passing it is
 * therefore evidence that the spawn-order sort actually ran, rather than
 * evidence that the fixture happened to be pre-sorted.
 */
function buildMockState(): { state: SessionState; edges: SpawnEdge[] } {
  const nodes = new Map<string, AgentNode>();
  for (const mock of MOCK_AGENTS) {
    nodes.set(mock.id, {
      id: mock.id,
      kind: mock.parent === null ? 'main' : 'subagent',
      label: mock.label,
      status: 'running',
      spawnDepth: 0,
      children: mock.tools.map(toolNode),
      // A6: the node row shows BURN. Split across the pair so the row can only
      // be right if it sums them.
      burn: { prompt: mock.tokens - 100, output: 100 },
      startedAt: 0,
    });
  }
  const edges: SpawnEdge[] = [];
  for (const mock of [...MOCK_AGENTS].reverse()) {
    if (mock.parent === null) continue;
    const parent = nodes.get(mock.parent);
    const self = nodes.get(mock.id);
    if (parent === undefined || self === undefined) continue;
    parent.children.push(self);
    if (mock.spawnedBy !== undefined) {
      edges.push({
        toolUseId: mock.spawnedBy,
        agentId: mock.id,
        parentNodeId: mock.parent,
        depth: 1,
        recordedDepth: 1,
      });
    }
  }
  const root = nodes.get('main');
  if (root === undefined) throw new Error('mock tree has no root');
  const state: SessionState = {
    sessionId: 'mock',
    projectSlug: 'mock',
    workspaceMatch: true,
    liveness: 'live',
    schemaOk: true,
    root,
    totals: { costUsd: 0 },
    spawnEdges: edges,
  };
  return { state, edges };
}

/* ------------------------------------------------------------------------ *
 * Re-emitting the design tables from production code
 * ------------------------------------------------------------------------ */

/**
 * Emit the design tables, byte for byte in the reference's own format.
 *
 * The FORMAT is copied from the reference deliberately — it is the thing being
 * compared against. Every NUMBER and every ORDER in it comes from `layout.ts`.
 */
function emitTables(): string[] {
  const { state } = buildMockState();
  const out: string[] = [];
  const log = (line: string): void => {
    out.push(line);
  };

  log('## Deck goldens (viewportW = 800)\n');
  const layouts: DeckLayoutMode[] = ['list', 'grid', 'lanes'];
  const sorts: DeckSortMode[] = ['live', 'recent', 'engine'];
  for (const layout of layouts) {
    for (const sort of sorts) {
      log(`### ${layout} · ${sort}\n\n| # | id | x | y |\n|---|---|---|---|`);
      deckLayout(DECK_SESSIONS, layout, sort, 800).forEach((p, i) => {
        log(`| ${i} | ${p.id} | ${p.x} | ${p.y} |`);
      });
      log('');
    }
  }

  log('### Tree · node widths (A1.1)\n\n| id | sub text | label | w |\n|---|---|---|---|');
  for (const mock of MOCK_AGENTS) {
    const agent = findMockAgent(state, mock.id);
    log(
      `| ${mock.id} | \`${nodeSubText(agent)}\` | ${nodeLabelText(agent)} | ${nodeWidth(agent)} |`,
    );
  }
  log('');

  const runs: [string, number, string][] = [
    ['main', Number.POSITIVE_INFINITY, 'root=main, no collapse'],
    ['main', COLLAPSE_DEPTH, 'root=main, collapseDepth=2'],
    ['a3', Number.POSITIVE_INFINITY, 'root=a3 (focus)'],
  ];
  for (const [rootId, collapseDepth, label] of runs) {
    log(
      `### Tree · ${label}\n\n| id | depth | x | y | w | spawn-dot x | spawn-dot y |\n|---|---|---|---|---|---|---|`,
    );
    const placed = treeLayout(state, rootId, { collapseDepth }).filter((p) => !p.hidden);
    const by = new Map(placed.map((p) => [p.id, p]));
    for (const p of placed) {
      const mock = MOCK_AGENTS.find((m) => m.id === p.id);
      let dx: string | number = '—';
      let dy: string | number = '—';
      const parentId = mock?.parent ?? null;
      const parentPlacement = parentId === null ? undefined : by.get(parentId);
      if (mock !== undefined && parentPlacement !== undefined) {
        const parentAgent = findMockAgent(state, parentPlacement.id);
        const tools = toolChildren(parentAgent);
        const index = tools.findIndex((t) => t.id === mock.spawnedBy);
        // THE DOT ARITHMETIC IS HISTORY, AND IT LIVES HERE NOW — A8.5.
        // `layout.ts` exported `spawnDotPos` until 2026-08-29; A8.1 removed the
        // dots and A8.5 keeps the frozen §7 tables byte-identical as a
        // regression guard on the layout. Those tables carry `spawn-dot`
        // columns, so something must still produce them. It is NOT production
        // code and must never become production code again — the `no dot API`
        // test below is what says so.
        const span = (tools.length - 1) * 13;
        dx = roundCoord(parentPlacement.x + parentPlacement.w / 2 - span / 2 + index * 13);
        dy = roundCoord(parentPlacement.y + NODE_H + 11);
      }
      log(`| ${p.id} | ${p.depth} | ${p.x} | ${p.y} | ${p.w} | ${dx} | ${dy} |`);
    }
    log('');
  }

  return out.join('\n').split('\n');
}

function findMockAgent(state: SessionState, id: string): AgentNode {
  const walk = (node: AgentNode): AgentNode | undefined => {
    if (node.id === id) return node;
    for (const child of node.children) {
      if (!('kind' in child)) continue;
      const found = walk(child as AgentNode);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const found = walk(state.root);
  if (found === undefined) throw new Error(`no mock agent ${id}`);
  return found;
}

/* ------------------------------------------------------------------------ *
 * DoD 7.1 — the layout is pure, and the superseded canvas is gone
 * ------------------------------------------------------------------------ */

/**
 * The needle, assembled from two halves.
 *
 * DoD 7.1 is stated as a grep over the whole of `webview/` returning zero, and
 * this file lives in `webview/`. Spelling the constant out here would make the
 * grep report one hit forever — the test that proves the deletion becoming the
 * only reason the deletion cannot be proved.
 */
const PHYLLOTAXIS_NEEDLE = `GOLDEN${'_ANGLE'}`;

/**
 * Source with comments removed.
 *
 * The purity scans below look for CODE that reads a clock or a DOM, and this
 * module's own header discusses both at length. Scanning raw text would fail on
 * the prose that explains why the code does not do it, which trains the next
 * reader to delete the explanation rather than to keep the property.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('DoD 7.1 — purity, and the deleted phyllotaxis canvas', () => {
  let layoutSource = '';
  let layoutCode = '';
  let webviewFiles: string[] = [];

  beforeAll(async () => {
    layoutSource = await readFile(join(WEBVIEW_DIR, 'layout.ts'), 'utf8');
    layoutCode = stripComments(layoutSource);
    const entries = await readdir(WEBVIEW_DIR, { withFileTypes: true });
    webviewFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
  }, 30_000);

  it('the comment stripper removes comments and keeps code', () => {
    // Control for every scan that runs over `layoutCode`: a stripper that
    // returned the empty string would make all of them pass vacuously.
    expect(stripComments('/* Date.now */ const a = 1; // Math.random\n')).toBe(
      '  const a = 1; \n',
    );
    expect(layoutCode.length).toBeGreaterThan(2000);
    expect(layoutCode).toContain('export function deckLayout');
    expect(layoutCode).toContain('export function treeLayout');
  });

  it('scans a non-trivial set of webview files', () => {
    // The converse of every "zero findings" claim in this repo: a scan that
    // looked at nothing reports zero too.
    expect(webviewFiles.length).toBeGreaterThan(20);
    expect(webviewFiles).toContain('layout.ts');
    expect(webviewFiles).toContain('layout.reference.mjs');
  });

  it('layout.ts does not import the frozen reference', () => {
    // The load-bearing assertion of this whole file. Two independent
    // implementations agreeing is the evidence; production importing the
    // reference would compare the reference against itself. Checked against
    // CODE, not against the header - the header names the reference on purpose,
    // to say that it must not be imported.
    expect(layoutCode).not.toContain('layout.reference');
    expect(layoutCode).not.toContain('goldens.mjs');
  });

  it('no file under webview/ mentions the golden angle', async () => {
    // Including `layout.reference.mjs`, which is frozen and is asserted to be
    // clean rather than exempted - an allow-list is the fail-open shape this
    // repository has been bitten by, and a skip that is not reported reads
    // exactly like a pass.
    const hits: string[] = [];
    let scanned = 0;
    let bytes = 0;
    for (const name of webviewFiles) {
      if (!/\.(ts|mjs|js|svelte)$/.test(name)) continue;
      const text = await readFile(join(WEBVIEW_DIR, name), 'utf8');
      scanned += 1;
      bytes += text.length;
      if (text.includes(PHYLLOTAXIS_NEEDLE)) hits.push(name);
    }
    // The converse control: a scan that read nothing also reports zero hits.
    expect(scanned).toBeGreaterThan(20);
    expect(bytes).toBeGreaterThan(100_000);
    expect(hits).toEqual([]);
    // And the predicate itself still fires on what it is looking for.
    expect(`export const ${PHYLLOTAXIS_NEEDLE}_RAD = 1;`).toContain(PHYLLOTAXIS_NEEDLE);
  }, 30_000);

  it('layout.ts reads no clock, no DOM and no entropy', () => {
    for (const forbidden of [
      'Math.random',
      'Date.now',
      'new Date',
      'performance.now',
      'document.',
      'window.',
      'globalThis',
      'measureText',
    ]) {
      expect(layoutCode).not.toContain(forbidden);
    }
  });

  it('imports only pure sibling modules', () => {
    const specifiers = [...layoutCode.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(new Set(specifiers)).toEqual(
      new Set(['../src/model/events.js', './format.js', './tree.js']),
    );
  });

  it('deckLayout and treeLayout return identical output for identical input', () => {
    const { state } = buildMockState();
    const deckA = deckLayout(DECK_SESSIONS, 'grid', 'live', 800);
    const deckB = deckLayout(DECK_SESSIONS, 'grid', 'live', 800);
    expect(deckA).toEqual(deckB);
    expect(treeLayout(state, 'main')).toEqual(treeLayout(state, 'main'));
  });

  it('deckLayout does not mutate the list it was given', () => {
    const input = [...DECK_SESSIONS];
    const before = input.map((s) => s.id);
    deckLayout(input, 'grid', 'recent', 800);
    expect(input.map((s) => s.id)).toEqual(before);
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 7.2 — the golden tables
 * ------------------------------------------------------------------------ */

describe('DoD 7.2 — the frozen design tables, through production layout.ts', () => {
  let golden: string[] = [];
  /** `layout.reference.mjs`'s own text, for the independence assertion. */
  let referenceSource = '';

  beforeAll(async () => {
    const parsed = JSON.parse(await readFile(GOLDEN_FILE, 'utf8')) as {
      generatedBy: string;
      lines: string[];
    };
    expect(parsed.generatedBy).toBe(REFERENCE_FILE);
    golden = parsed.lines;
    referenceSource = await readFile(join(REPO_ROOT, REFERENCE_FILE), 'utf8');
  }, 30_000);

  it('the golden is the reference output, and it is not empty', () => {
    expect(golden.length).toBe(157);
    expect(golden[0]).toBe('## Deck goldens (viewportW = 800)');
  });

  it('production reproduces every line of every table', () => {
    const produced = emitTables();
    // Compared line by line first, so a failure names the row rather than
    // printing 157 lines of diff.
    for (let i = 0; i < Math.max(produced.length, golden.length); i += 1) {
      expect(`${i}: ${produced[i] ?? '<missing>'}`).toBe(`${i}: ${golden[i] ?? '<missing>'}`);
    }
    expect(produced).toEqual(golden);
  });

  it('a single wrong coordinate fails the comparison', () => {
    // Mutation control for the assertion above.
    const produced = emitTables();
    const mutated = [...produced];
    mutated[6] = '| 0 | 6082be25 | 1 | 0 |';
    expect(mutated).not.toEqual(golden);
  });

  it('the reference ACTUALLY RUNS, and its stdout is the committed golden', () => {
    // WHY THIS TEST EXISTS. DoD 7.2's whole evidentiary basis is that two
    // independent implementations agree. Until this test, nothing in the suite
    // ever executed `layout.reference.mjs`: the file above checked only that
    // the JSON's `generatedBy` string named it and that there were 157 lines.
    // So the independence rested on a human having pasted the right bytes once,
    // and a future edit of `design-tables.json` to match a broken `layout.ts`
    // would have passed forever — the golden and production agreeing with each
    // other, with the third party absent.
    //
    // Running the reference closes that: the golden is now checked against the
    // process that is supposed to have produced it, on every run.
    const out = execFileSync('node', [REFERENCE_FILE], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    // The reference writes `lines.join('\n') + '\n'`. Dropping exactly one
    // trailing newline — not trimming — so a table that genuinely ended in a
    // blank line still compares.
    const produced = out.replace(/\n$/, '').split('\n');
    expect(produced).toHaveLength(golden.length);
    for (let i = 0; i < Math.max(produced.length, golden.length); i += 1) {
      expect(`${i}: ${produced[i] ?? '<missing>'}`).toBe(`${i}: ${golden[i] ?? '<missing>'}`);
    }
    expect(produced).toEqual(golden);
    // No CR anywhere: the reference is a CRLF source file in this checkout and
    // writes LF regardless, which is what makes the byte comparison portable.
    expect(out.includes('\r')).toBe(false);
    // ...and it is genuinely the third party. If `layout.reference.mjs` ever
    // imported production, this whole file would be comparing `layout.ts`
    // against itself twice. Asserted on CODE, not on text: the reference's
    // header discusses `webview/layout.ts` at length, so a substring search
    // would fail on the prose that explains the arrangement — the same trap
    // `stripComments` exists for above.
    const referenceCode = stripComments(referenceSource);
    expect(referenceCode.match(/\bimport\b|\brequire\s*\(/g) ?? []).toStrictEqual([]);
  }, 120_000);
});

/* ------------------------------------------------------------------------ *
 * The deck
 * ------------------------------------------------------------------------ */

describe('the deck', () => {
  it('carries the design constants', () => {
    expect([DECK_CARD_W, DECK_CARD_H, DECK_GAP_X, DECK_GAP_Y]).toEqual([220, 88, 16, 12]);
    expect(DECK_GRID_MARGIN).toBe(24);
    expect(DECK_LANE_GAP).toBe(40);
    expect(DECK_LANE_HEADER_Y).toBe(-28);
    // Lane slots, against the FULL visible set. DoD 5.0c made `deckLaneX` a
    // function of the visible set rather than of the absolute rank, and at
    // {cc, oc, cx} compaction is the identity, so these three numbers are the
    // same as they were — which is the point: the fix moves the two-of-three
    // shapes and nothing else. The subsets are pinned as a golden below.
    const all: DeckEngine[] = ['cc', 'oc', 'cx'];
    expect(deckLaneX('cc', all)).toBe(0);
    expect(deckLaneX('oc', all)).toBe(DECK_CARD_W + 40);
    expect(deckLaneX('cx', all)).toBe(2 * (DECK_CARD_W + 40));
  });

  it('defaults to grid · live first · all', () => {
    expect(DEFAULT_DECK_LAYOUT).toBe('grid');
    expect(DEFAULT_DECK_SORT).toBe('live');
    // The engine filter's default is `canvas-contract.ts`'s now, not this
    // module's: it is store state, and this module never sees a filter.
    expect(DEFAULT_ENGINE_FILTER).toBe('all');
  });

  it('an arriving session RE-PLACES the deck: placement is by array index', () => {
    // The deck half of the same correction. `deckLayout` sorts and then hands
    // out slots by index, so a session that sorts ahead of the others pushes
    // every one of them down a row. Pinned by exact coordinates, because the
    // module header now states this and a stated property with no test is what
    // let the false claim survive a phase.
    const three: DeckSession[] = [
      { id: '6082be25', engine: 'cc', status: 'live', last: -4000 },
      { id: 'ses_a91f', engine: 'oc', status: 'live', last: -11000 },
      { id: '4299490e', engine: 'cc', status: 'idle', last: -140000 },
    ];
    expect(deckLayout(three, 'list', 'live', 800)).toStrictEqual([
      { id: '6082be25', x: 0, y: 0 },
      { id: 'ses_a91f', x: 0, y: 100 },
      { id: '4299490e', x: 0, y: 200 },
    ]);

    // One more session, more recent than all three, so it sorts first.
    const four: DeckSession[] = [
      ...three,
      { id: '0000newest', engine: 'cc', status: 'live', last: -1000 },
    ];
    expect(deckLayout(four, 'list', 'live', 800)).toStrictEqual([
      { id: '0000newest', x: 0, y: 0 },
      { id: '6082be25', x: 0, y: 100 },
      { id: 'ses_a91f', x: 0, y: 200 },
      { id: '4299490e', x: 0, y: 300 },
    ]);
    // Every pre-existing card moved by exactly one row pitch. Asserted as a
    // count as well, so "nothing moved" and "everything moved" are both red.
    const wasAt = new Map(deckLayout(three, 'list', 'live', 800).map((p) => [p.id, p.y]));
    const nowAt = new Map(deckLayout(four, 'list', 'live', 800).map((p) => [p.id, p.y]));
    const shifted = [...wasAt.keys()].filter((id) => nowAt.get(id) !== wasAt.get(id));
    expect(shifted.sort()).toStrictEqual(['4299490e', '6082be25', 'ses_a91f']);
    for (const id of shifted) {
      expect({ id, delta: (nowAt.get(id) ?? 0) - (wasAt.get(id) ?? 0) }).toStrictEqual({
        id,
        delta: DECK_CARD_H + DECK_GAP_Y,
      });
    }
  });

  it('columns come from the stage-unit width', () => {
    expect(deckColumns(800)).toBe(3);
    expect(deckColumns(0)).toBe(1);
    expect(deckColumns(-1000)).toBe(1);
    expect(deckColumns(260)).toBe(1);
    // One unit short of the first whole column still yields a column: a deck
    // with zero columns would place every card at x = NaN.
    expect(deckColumns(259)).toBe(1);
    expect(deckColumns(496)).toBe(2);
  });

  it('every sort ends on the session id', () => {
    // Two rows identical in every key the sort reads except the id. Fed in
    // both orders; both must come out id-ascending.
    const tie: DeckSession[] = [
      { id: 'zzz', engine: 'cc', status: 'live', last: -1 },
      { id: 'aaa', engine: 'cc', status: 'live', last: -1 },
    ];
    for (const sort of ['live', 'recent', 'engine'] as DeckSortMode[]) {
      expect(sortDeckSessions(tie, sort).map((s) => s.id)).toEqual(['aaa', 'zzz']);
      expect(sortDeckSessions([...tie].reverse(), sort).map((s) => s.id)).toEqual([
        'aaa',
        'zzz',
      ]);
    }
  });

  it('ranks engine cc < oc < cx under the engine sort', () => {
    const rows: DeckSession[] = [
      { id: 'cx-1', engine: 'cx', status: 'live', last: -1 },
      { id: 'oc-1', engine: 'oc', status: 'live', last: -1 },
      { id: 'cc-1', engine: 'cc', status: 'live', last: -1 },
    ];
    expect(sortDeckSessions(rows, 'engine').map((s) => s.engine)).toEqual([
      'cc',
      'oc',
      'cx',
    ]);
  });

  it('ranks status live < idle < degraded < unsupported < ended', () => {
    const rows: DeckSession[] = (
      ['ended', 'unsupported', 'degraded', 'idle', 'live'] as const
    ).map((status, i) => ({ id: `s${i}`, engine: 'cc', status, last: 0 }));
    expect(sortDeckSessions(rows, 'live').map((s) => s.status)).toEqual([
      'live',
      'idle',
      'degraded',
      'unsupported',
      'ended',
    ]);
  });

  it('lanes render as list when one engine is visible, and no empty lane appears', () => {
    const ccOnly = DECK_SESSIONS.filter((s) => s.engine === 'cc');
    expect(deckLanesDegrade(ccOnly)).toBe(true);
    expect(deckLayout(ccOnly, 'lanes', 'live', 800)).toEqual(
      deckLayout(ccOnly, 'list', 'live', 800),
    );
    expect(deckLanesDegrade(DECK_SESSIONS)).toBe(false);
    expect(deckLayout([], 'lanes', 'live', 800)).toEqual([]);
  });

  it('places a third (Codex) lane at slot 2, and all three lanes together do not degrade', () => {
    const three: DeckSession[] = [
      { id: 'cc-1', engine: 'cc', status: 'live', last: -1 },
      { id: 'oc-1', engine: 'oc', status: 'live', last: -1 },
      { id: 'cx-1', engine: 'cx', status: 'live', last: -1 },
    ];
    expect(deckLanesDegrade(three)).toBe(false);
    const placed = deckLayout(three, 'lanes', 'live', 800);
    // Literal coordinates, not `deckLaneX(...)` on both sides. Comparing the
    // placement to the same function that produced it passes for any
    // definition of that function, including one that returns a constant.
    expect(placed.find((p) => p.id === 'cc-1')?.x).toBe(0);
    expect(placed.find((p) => p.id === 'oc-1')?.x).toBe(260);
    expect(placed.find((p) => p.id === 'cx-1')?.x).toBe(520);
  });

  it('maps SessionState.engine onto the deck vocabulary, absence reading as cc', () => {
    expect(deckEngine('opencode')).toBe('oc');
    expect(deckEngine('codex')).toBe('cx');
    expect(deckEngine('cc')).toBe('cc');
    expect(deckEngine(undefined)).toBe('cc');
  });

  it('toDeckSession takes the last-event time from its caller', () => {
    const { state } = buildMockState();
    expect(toDeckSession({ ...state, engine: 'opencode' }, -42)).toEqual({
      id: 'mock',
      engine: 'oc',
      status: 'live',
      last: -42,
    });
    // The third leg, minimal per the same helper.
    expect(toDeckSession({ ...state, engine: 'codex' }, -7)).toEqual({
      id: 'mock',
      engine: 'cx',
      status: 'live',
      last: -7,
    });
  });

  it('counts every node in a tree, agents and tools alike', () => {
    const { state } = buildMockState();
    const tools = MOCK_AGENTS.reduce((n, m) => n + m.tools.length, 0);
    expect(countNodes(state)).toBe(MOCK_AGENTS.length + tools);
  });

  it('rounds to three decimals and never emits negative zero', () => {
    expect(roundCoord(1 / 3)).toBe(0.333);
    expect(Object.is(roundCoord(-0.0001), 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 5.0c — deck lanes compact to the visible engine set
 * ------------------------------------------------------------------------ */

/** The shape of `webview/goldens/layout/lane-subsets.json`. */
interface LaneSubsetRow {
  engines: DeckEngine[];
  mode: 'list' | 'lanes';
  laneX: Partial<Record<DeckEngine, number>>;
  placements: DeckPlacement[];
}
interface LaneSubsetGolden {
  geometry: {
    cardW: number;
    cardH: number;
    laneGap: number;
    gapY: number;
    lanePitch: number;
    rowPitch: number;
  };
  laneOrder: DeckEngine[];
  sessions: { sort: DeckSortMode; viewportW: number };
  subsets: LaneSubsetRow[];
}

/** Every engine the deck knows, in rank order. Not read from the golden. */
const ALL_DECK_ENGINES: readonly DeckEngine[] = ['cc', 'oc', 'cx'];

/**
 * Two cards per present engine, ids `<engine>-1` and `<engine>-2`.
 *
 * Two rather than one so a lane pins its row stacking as well as its x — a
 * one-card lane cannot tell a correct `y` from a constant `0`. All live and
 * all on the same last-event time, so every sort resolves on the id and the
 * expected order is readable from the ids alone.
 */
function subsetSessions(engines: readonly DeckEngine[]): DeckSession[] {
  return engines.flatMap((engine): DeckSession[] => [
    { id: `${engine}-1`, engine, status: 'live', last: -1 },
    { id: `${engine}-2`, engine, status: 'live', last: -1 },
  ]);
}

describe('DoD 5.0c — lanes compact to the visible engine set', () => {
  let laneGolden: LaneSubsetGolden;

  beforeAll(async () => {
    laneGolden = JSON.parse(
      await readFile(LANE_SUBSET_GOLDEN_FILE, 'utf8'),
    ) as LaneSubsetGolden;
  }, 30_000);

  it('the golden covers all seven non-empty subsets, exactly once each', () => {
    // Coverage is a claim in its own right and nothing below can make it.
    // Every per-row assertion in this describe passes over a golden holding
    // only the four rows that were already correct — which is exactly the
    // golden a fix restating itself would produce.
    expect(laneGolden.subsets).toHaveLength(7);
    const keys = laneGolden.subsets.map((s) => s.engines.join('+'));
    expect([...keys].sort()).toStrictEqual([
      'cc',
      'cc+cx',
      'cc+oc',
      'cc+oc+cx',
      'cx',
      'oc',
      'oc+cx',
    ]);
    // Each row is a genuine subset, listed in rank order, with no repeats.
    for (const row of laneGolden.subsets) {
      expect({ key: row.engines.join('+'), distinct: new Set(row.engines).size }).toStrictEqual(
        { key: row.engines.join('+'), distinct: row.engines.length },
      );
      expect(row.engines).toStrictEqual(
        ALL_DECK_ENGINES.filter((e) => row.engines.includes(e)),
      );
      // `laneX` answers for every engine in the row and for no other.
      expect(Object.keys(row.laneX).sort()).toStrictEqual([...row.engines].sort());
      // Two cards per present engine.
      expect(row.placements).toHaveLength(row.engines.length * 2);
    }
    // Three rows degrade to a list, four draw lanes.
    expect(
      laneGolden.subsets.filter((s) => s.mode === 'list').map((s) => s.engines.join('+')),
    ).toStrictEqual(['cc', 'oc', 'cx']);
    expect(laneGolden.subsets.filter((s) => s.mode === 'lanes')).toHaveLength(4);
  });

  it('the golden geometry is production geometry, not a second set of numbers', () => {
    expect(laneGolden.geometry).toStrictEqual({
      cardW: DECK_CARD_W,
      cardH: DECK_CARD_H,
      laneGap: DECK_LANE_GAP,
      gapY: DECK_GAP_Y,
      lanePitch: DECK_CARD_W + DECK_LANE_GAP,
      rowPitch: DECK_CARD_H + DECK_GAP_Y,
    });
    expect(laneGolden.laneOrder).toStrictEqual([...ALL_DECK_ENGINES]);
    // Lane ORDER is still the rank, which DoD 5.0c did not change. Derived
    // from `deckLaneEngines`, so a rank table edited the wrong way is red here
    // as well as in the sort test.
    expect(deckLaneEngines(subsetSessions(['cx', 'cc', 'oc']))).toStrictEqual([
      ...ALL_DECK_ENGINES,
    ]);
  });

  it('production reproduces every coordinate of all seven subsets', () => {
    let rowsChecked = 0;
    let coordsChecked = 0;
    for (const row of laneGolden.subsets) {
      const key = row.engines.join('+');
      const sessions = subsetSessions(row.engines);

      // The MODE is part of the coordinate answer: for a one-engine set,
      // "where do the lanes go" is answered by "there are no lanes".
      expect({ key, mode: deckLanesDegrade(sessions) ? 'list' : 'lanes' }).toStrictEqual({
        key,
        mode: row.mode,
      });
      expect({ key, present: deckLaneEngines(sessions) }).toStrictEqual({
        key,
        present: row.engines,
      });

      // `deckLaneX` directly...
      for (const engine of row.engines) {
        expect({ key, engine, x: deckLaneX(engine, row.engines) }).toStrictEqual({
          key,
          engine,
          x: row.laneX[engine],
        });
        coordsChecked += 1;
      }

      // ...and END TO END through `deckLayout`, which is the leg a lane that
      // was computed and then discarded could not satisfy: these are the
      // coordinates the renderer receives, ids and all.
      const placed = deckLayout(
        sessions,
        'lanes',
        laneGolden.sessions.sort,
        laneGolden.sessions.viewportW,
      );
      expect({ key, placed }).toStrictEqual({ key, placed: row.placements });
      coordsChecked += placed.length;
      rowsChecked += 1;
    }
    // The converse control: a loop over an empty golden also reports no
    // failures. Pinned exactly — 7 rows, 12 `deckLaneX` answers and 24
    // placements.
    expect({ rowsChecked, coordsChecked }).toStrictEqual({ rowsChecked: 7, coordsChecked: 36 });
  });

  it('lanes drawn are 0..n-1 with no hole, for every multi-engine subset', () => {
    // The defect as a PROPERTY rather than as coordinates, so it survives a
    // change to DECK_CARD_W: the distinct columns a lanes layout draws are the
    // first n slots, contiguous, with nothing skipped. Under the old
    // absolute-rank form `{cc,cx}` drew [0, 520] and `{oc,cx}` drew [260, 520].
    const multi: DeckEngine[][] = [
      ['cc', 'oc'],
      ['cc', 'cx'],
      ['oc', 'cx'],
      ['cc', 'oc', 'cx'],
    ];
    for (const engines of multi) {
      const placed = deckLayout(subsetSessions(engines), 'lanes', 'engine', 800);
      const columns = [...new Set(placed.map((p) => p.x))].sort((a, b) => a - b);
      expect({ engines, columns }).toStrictEqual({
        engines,
        columns: engines.map((_, i) => i * (DECK_CARD_W + DECK_LANE_GAP)),
      });
    }
  });

  it('deckLaneX reads the DISTINCT visible set, and is total and pure', () => {
    // Duplicates are counted once. A `filter(...).length` over the raw
    // iterable would put oc at 780 here, and every assertion above would still
    // pass because `deckLaneEngines` hands `deckLayout` a deduped list.
    expect(deckLaneX('oc', ['cc', 'cc', 'cc'])).toBe(DECK_CARD_W + DECK_LANE_GAP);
    // Order of the visible set is irrelevant.
    expect(deckLaneX('cx', ['cx', 'cc', 'oc'])).toBe(deckLaneX('cx', ['cc', 'oc', 'cx']));
    // Total: an empty set, and an engine the set does not contain (which gets
    // the slot it WOULD occupy). Neither is a production call; a lane function
    // that can throw or return NaN is one that can place a card at x = NaN.
    expect(deckLaneX('cx', [])).toBe(0);
    expect(deckLaneX('cc', ['oc', 'cx'])).toBe(0);
    expect(deckLaneX('oc', ['cc', 'cx'])).toBe(DECK_CARD_W + DECK_LANE_GAP);
    // Pure: the argument is not mutated and the answer does not drift.
    const visible: DeckEngine[] = ['cc', 'cx'];
    const first = deckLaneX('cx', visible);
    expect(deckLaneX('cx', visible)).toBe(first);
    expect(visible).toStrictEqual(['cc', 'cx']);
    // A Set is as good as an array — `deckLayout` passes an array today, and
    // a renderer holding the visible set as a Set must not have to convert.
    expect(deckLaneX('cx', new Set<DeckEngine>(['cc', 'cx']))).toBe(first);
  });
});

/* ------------------------------------------------------------------------ *
 * The tree — widths, and the defect class the old canvas had
 * ------------------------------------------------------------------------ */

describe('node width (A1.1)', () => {
  it('carries the design constants', () => {
    expect([NODE_W_MIN, NODE_H, LEVEL_GAP, SIBLING_GAP]).toEqual([168, 52, 112, 24]);
    expect([SUB_ADVANCE, LABEL_ADVANCE]).toEqual([6.3, 7.0]);
    expect(LABEL_MAX_CHARS).toBe(19);
  });

  it('truncates a label at 19 characters with an ellipsis', () => {
    const agent = findMockAgent(buildMockState().state, 'a3');
    expect(agent.label).toBe('readme-guard-rederive');
    expect(nodeLabelText(agent)).toBe('readme-guard-reder…');
    expect(nodeLabelText(agent).length).toBe(19);
    const short = { ...agent, label: 'exactly-19-chars-ab' };
    expect(short.label.length).toBe(19);
    expect(nodeLabelText(short)).toBe('exactly-19-chars-ab');
  });

  it('formats the token figure compactly, and absence as an em-dash', () => {
    expect(formatCompactTokens(400)).toBe('400');
    expect(formatCompactTokens(184300)).toBe('184.3k');
    expect(formatCompactTokens(1_200_000)).toBe('1.2M');
    expect(formatCompactTokens(undefined)).toBe('—');
    expect(formatCompactTokens(0)).toBe('0');
  });

  it('shows an em-dash, never a zero, when burn is absent', () => {
    // The OpenCode engine leaves `burn` unset. `0` would claim the session
    // spent nothing, which is a wrong number rather than a missing one.
    const agent = findMockAgent(buildMockState().state, 'a1');
    const withoutBurn: AgentNode = { ...agent, burn: undefined };
    expect(nodeSubText(withoutBurn)).toBe('— · 3 calls');
    expect(nodeSubText(withoutBurn)).not.toContain('0 ·');
  });

  it('reads BURN, summing both halves of the pair (A6)', () => {
    const agent = findMockAgent(buildMockState().state, 'main');
    expect(agent.burn).toEqual({ prompt: 184200, output: 100 });
    expect(nodeSubText(agent)).toBe('184.3k · 7 calls · 2 running');
    // contextNow is a LEVEL and must not reach this row.
    const withContext: AgentNode = { ...agent, contextNow: { prompt: 9, output: 9 } };
    expect(nodeSubText(withContext)).toBe(nodeSubText(agent));
  });

  it('is a function of TEXT, not of the number of children', () => {
    // The defect the predecessor canvas had: a drawn size that grew with child
    // count, so one new subagent moved cells already on screen. A subagent is
    // not a tool call, so it must not touch the row-2 string at all.
    const { state } = buildMockState();
    const a1 = findMockAgent(state, 'a1');
    const a1a = findMockAgent(state, 'a1a');
    const before = nodeWidth(a1);
    const fatter: AgentNode = {
      ...a1,
      children: [...a1.children, { ...a1a, id: 'extra-1' }, { ...a1a, id: 'extra-2' }],
    };
    expect(nodeWidth(fatter)).toBe(before);
    expect(nodeSubText(fatter)).toBe(nodeSubText(a1));
  });

  it('never falls below the minimum', () => {
    const { state } = buildMockState();
    const tiny: AgentNode = {
      ...findMockAgent(state, 'a3aa'),
      label: 'a',
      children: [],
      burn: { prompt: 1, output: 0 },
    };
    expect(nodeSubText(tiny)).toBe('1 · 0 calls');
    expect(nodeWidth(tiny)).toBe(NODE_W_MIN);
  });
});

describe('the tidy tree', () => {
  it('centres each parent over the span of its children', () => {
    const { state } = buildMockState();
    const placed = treeLayout(state, 'main').filter((p) => !p.hidden);
    const by = new Map(placed.map((p) => [p.id, p]));
    const parent = by.get('a3');
    const first = by.get('a3a');
    const last = by.get('a3b');
    expect(parent && first && last).toBeTruthy();
    if (parent === undefined || first === undefined || last === undefined) return;
    const span = last.x + last.w - first.x;
    expect(roundCoord(parent.x + parent.w / 2)).toBe(roundCoord(first.x + span / 2));
  });

  it('separates sibling subtrees by exactly SIBLING_GAP and never overlaps', () => {
    const { state } = buildMockState();
    const placed = treeLayout(state, 'main').filter((p) => !p.hidden);
    const byDepth = new Map<number, TreePlacement[]>();
    for (const p of placed) {
      const row = byDepth.get(p.depth) ?? [];
      row.push(p);
      byDepth.set(p.depth, row);
    }
    for (const row of byDepth.values()) {
      const sorted = [...row].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i += 1) {
        const left = sorted[i - 1];
        const right = sorted[i];
        if (left === undefined || right === undefined) continue;
        expect(right.x).toBeGreaterThanOrEqual(left.x + left.w);
      }
    }
  });

  it('puts one rank a LEVEL_GAP below the tallest box of the rank above', () => {
    // WAS `p.depth * (NODE_H + LEVEL_GAP)`, which assumed every box was 52
    // tall. A9.2 lets a box grow to 70 for a wrapped label, so a rank is as
    // tall as its tallest member and everything below it shifts — the mock
    // tree's `readme-guard-rederive` is 21 characters, wraps at depth 1, and
    // moves depths 2 and 3 down by 18.
    const { state } = buildMockState();
    const placed = treeLayout(state, 'main').filter((x) => !x.hidden);
    const tallestAt = new Map<number, number>();
    for (const p of placed) {
      tallestAt.set(p.depth, Math.max(tallestAt.get(p.depth) ?? NODE_H, p.h));
    }
    const topOf = (depth: number): number =>
      depth === 0 ? 0 : topOf(depth - 1) + (tallestAt.get(depth - 1) ?? NODE_H) + LEVEL_GAP;
    for (const p of placed) expect(p.y, p.id).toBe(topOf(p.depth));

    // NON-VACUITY: this tree really does have both heights in it, or the rule
    // above would be indistinguishable from the fixed-height one it replaced.
    expect([...new Set(placed.map((p) => p.h))].sort()).toStrictEqual([NODE_H, NODE_H_TWO_LINE]);
  });

  it('roots at (x, 0) and re-roots on any agent', () => {
    const { state } = buildMockState();
    const focus = treeLayout(state, 'a3').filter((p) => !p.hidden);
    expect(focus[0]?.id).toBe('a3');
    expect(focus[0]?.y).toBe(0);
    expect(focus.map((p) => p.id)).toEqual(['a3', 'a3a', 'a3aa', 'a3b']);
  });

  it('returns nothing for a root that is not in the tree', () => {
    const { state } = buildMockState();
    expect(treeLayout(state, 'no-such-agent')).toEqual([]);
    expect(visibleNodeCount(state, 'no-such-agent')).toBe(0);
  });

  it('takes a width override so the store can hold width monotonic', () => {
    // The layout stays memoryless: monotonicity is the STORE's job and it
    // arrives here as data. Widening one node must move only what is downstream
    // of that node's own subtree span.
    const { state } = buildMockState();
    const base = treeLayout(state, 'main').filter((p) => !p.hidden);
    const widths = new Map<string, number>([['a3b', 400]]);
    const wider = treeLayout(state, 'main', { widths }).filter((p) => !p.hidden);
    expect(wider.find((p) => p.id === 'a3b')?.w).toBe(400);
    expect(base.find((p) => p.id === 'a3b')?.w).toBe(183);
    // a1's subtree sits to the LEFT of a3's, so it cannot have moved.
    expect(wider.find((p) => p.id === 'a1a')?.x).toBe(
      base.find((p) => p.id === 'a1a')?.x,
    );
  });

  /**
   * The newborn every spawn test below adds, so they all measure one event.
   *
   * Its width is the FLOOR, `NODE_W_MIN` — "1 · 0 calls" and `new-arrival` are
   * both short enough — which is what makes the deltas below round numbers:
   * the subtree gains `168 + SIBLING_GAP` = 192 of extent, and a centred parent
   * therefore moves by half of it, 96.
   */
  function newborn(): AgentNode {
    return {
      id: 'a3c',
      kind: 'subagent',
      label: 'new-arrival',
      status: 'running',
      spawnDepth: 2,
      children: [],
      burn: { prompt: 1, output: 0 },
      startedAt: 0,
    };
  }

  it('a spawn MOVES every ancestor: the tidy tree is NOT coordinate-stable', () => {
    // THIS FILE USED TO ASSERT THE OPPOSITE, and `layout.ts`'s header used to
    // claim it: "A spawn ADDS; it never reflows anything already placed."
    // False for this algorithm, and it went unnoticed for a phase because the
    // two tests that would have caught it were deleted and replaced by one
    // about WIDTHS — a different, weaker property that is also true.
    //
    // A property nobody tests is one that drifts silently, so the real
    // behaviour is pinned here by EXACT COORDINATES rather than described. If
    // these numbers move, the layout changed and the header is stale again.
    /** Read a coordinate, or fail naming the id — never silently `undefined`. */
    const at = (map: Map<string, number>, id: string): number => {
      const x = map.get(id);
      if (x === undefined) throw new Error(`no placement for ${id}`);
      return x;
    };

    const { state } = buildMockState();
    const xs = (): Map<string, number> =>
      new Map(
        treeLayout(state, 'main')
          .filter((p) => !p.hidden)
          .map((p) => [p.id, p.x]),
      );

    const before = xs();
    findMockAgent(state, 'a3').children.push(newborn());
    const after = xs();

    expect(after.get('a3c')).toBe(842);

    // The ancestry of the growing subtree: a3 is the parent, main is the root.
    // Both re-centre, by exactly half the extent the newborn claims.
    expect({ main: at(before, 'main'), a3: at(before, 'a3') }).toStrictEqual({
      main: 307.5,
      a3: 521,
    });
    expect({ main: at(after, 'main'), a3: at(after, 'a3') }).toStrictEqual({
      main: 403.5,
      a3: 617,
    });
    const half = (NODE_W_MIN + SIBLING_GAP) / 2;
    expect(at(after, 'main') - at(before, 'main')).toBe(half);
    expect(at(after, 'a3') - at(before, 'a3')).toBe(half);

    // And everything OUTSIDE that ancestry is byte-identical. That is the half
    // of the old claim which survived, and it is what keeps a spawn in one
    // branch from redrawing the whole picture.
    for (const id of ['a1', 'a1a', 'a2', 'a3a', 'a3aa', 'a3b']) {
      expect({ id, x: after.get(id) }).toStrictEqual({ id, x: before.get(id) });
    }

    // Stated as a count too, so a change that froze EVERY coordinate — which
    // would make the loop above pass while contradicting the two assertions
    // before it — cannot read as green.
    const moved = [...before.keys()].filter((id) => after.get(id) !== before.get(id)).sort();
    expect(moved).toStrictEqual(['a3', 'main']);
  });

  it('a spawn adds without changing any width already drawn', () => {
    // The property that IS stable, and the reason the instability above is
    // acceptable: no node's WIDTH moves, so nothing reflows because of a DRAWN
    // SIZE feeding back into position. That feedback is what the predecessor
    // canvas did — it separated on a radius that grew with child count — and it
    // is the thing `layout.ts` still forbids.
    const { state } = buildMockState();
    const before = new Map(
      treeLayout(state, 'main')
        .filter((p) => !p.hidden)
        .map((p) => [p.id, p.w]),
    );
    findMockAgent(state, 'a3').children.push(newborn());
    const grown = treeLayout(state, 'main').filter((p) => !p.hidden);
    expect(grown.some((p) => p.id === 'a3c')).toBe(true);
    for (const p of grown) {
      if (p.id === 'a3c') continue;
      expect(p.w).toBe(before.get(p.id));
    }
  });

  it('exports no dot API at all, so the row cannot come back by accident', async () => {
    // A8.1 removed the tool dots. `places the spawn dots centred on the node`
    // stood here until 2026-08-29 and is gone rather than skipped: a test for
    // a deleted feature that still passes is how a deleted feature returns.
    //
    // What replaces it is a NEGATIVE guard on the module's surface. The row was
    // not a cosmetic mistake — measured on the wide-rank corpus it put 17 of 18
    // rows outside their own boxes, overlapped 14 sibling pairs, and cost 15 of
    // 15 filaments — so reintroducing a position function for one is a decision
    // that must be made deliberately, in the design, not by an import landing
    // back in a file.
    const mod = (await import('./layout.js')) as unknown as Record<string, unknown>;
    for (const name of ['spawnDotPos', 'SPAWN_DOT_GAP', 'SPAWN_DOT_Y', 'DOT_LIMIT', 'maxDots']) {
      expect(mod[name], `layout.ts exports ${name}: the dot row is back`).toBeUndefined();
    }
    // ...and the surface it DOES export is intact, so this is not passing
    // because the import failed.
    expect(typeof mod['treeLayout']).toBe('function');
    expect(typeof mod['nodeWidth']).toBe('function');
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 7.8 (layout half) — collapse, and the 300-node boundary
 * ------------------------------------------------------------------------ */

/** A root with `n - 1` children, each of which has one child of its own. */
function chainOfWidth(total: number): SessionState {
  const root: AgentNode = {
    id: 'root',
    kind: 'main',
    label: 'root',
    status: 'running',
    spawnDepth: 0,
    children: [],
    burn: { prompt: 1, output: 0 },
    startedAt: 0,
  };
  const edges: SpawnEdge[] = [];
  let made = 1;
  let i = 0;
  while (made < total) {
    const branch: AgentNode = {
      id: `b${String(i).padStart(4, '0')}`,
      kind: 'subagent',
      label: `b${i}`,
      status: 'running',
      spawnDepth: 1,
      children: [],
      burn: { prompt: 1, output: 0 },
      startedAt: 0,
    };
    root.children.push(branch);
    made += 1;
    i += 1;
    if (made < total) {
      const leaf: AgentNode = {
        id: `${branch.id}-leaf`,
        kind: 'subagent',
        label: 'leaf',
        status: 'running',
        spawnDepth: 2,
        children: [],
        burn: { prompt: 1, output: 0 },
        startedAt: 0,
      };
      branch.children.push(leaf);
      made += 1;
    }
  }
  return {
    sessionId: 'chain',
    projectSlug: 'chain',
    workspaceMatch: true,
    liveness: 'live',
    schemaOk: true,
    root,
    totals: { costUsd: 0 },
    spawnEdges: edges,
  };
}

describe('DoD 7.8 (layout half) — collapse', () => {
  it('the threshold is 300 and the collapsed depth is 2', () => {
    expect(AUTO_COLLAPSE_NODES).toBe(300);
    expect(COLLAPSE_DEPTH).toBe(2);
  });

  it('299, 300 and 301 nodes: strictly greater collapses', () => {
    // Tested on both sides AND on the boundary itself, because an off-by-one
    // here is invisible in production - the tree just quietly renders a
    // different shape.
    for (const [n, expected] of [
      [299, Number.POSITIVE_INFINITY],
      [300, Number.POSITIVE_INFINITY],
      [301, COLLAPSE_DEPTH],
    ] as const) {
      const state = chainOfWidth(n);
      expect(visibleNodeCount(state, 'root')).toBe(n);
      expect(autoCollapseDepth(state, 'root')).toBe(expected);
    }
  });

  it('a collapsed node keeps its descendants, marked hidden, and counts them', () => {
    const { state } = buildMockState();
    const placed = treeLayout(state, 'main', { collapseDepth: COLLAPSE_DEPTH });
    const drawn = placed.filter((p) => !p.hidden).map((p) => p.id);
    const hidden = placed.filter((p) => p.hidden).map((p) => p.id);
    expect(drawn).toEqual(['main', 'a1', 'a1a', 'a2', 'a3', 'a3a', 'a3b']);
    expect(hidden).toEqual(['a3aa']);

    const collapsed = placed.filter((p) => p.collapsed).map((p) => p.id);
    expect(collapsed).toEqual(['a3a']);
    expect(placed.find((p) => p.id === 'a3a')?.hiddenDescendants).toBe(1);
    // A leaf at the same depth is NOT collapsed - it has nothing to hide.
    expect(placed.find((p) => p.id === 'a1a')?.collapsed).toBe(false);
  });

  it('a hidden node sits on the collapsed ancestor that swallowed it', () => {
    const { state } = buildMockState();
    const placed = treeLayout(state, 'main', { collapseDepth: COLLAPSE_DEPTH });
    const parent = placed.find((p) => p.id === 'a3a');
    const child = placed.find((p) => p.id === 'a3aa');
    expect(child?.x).toBe(parent?.x);
    expect(child?.y).toBe(parent?.y);
  });

  it('collapseDepth 0 draws only the root', () => {
    const { state } = buildMockState();
    const placed = treeLayout(state, 'main', { collapseDepth: 0 });
    expect(placed.filter((p) => !p.hidden).map((p) => p.id)).toEqual(['main']);
    expect(placed.find((p) => p.id === 'main')?.hiddenDescendants).toBe(
      MOCK_AGENTS.length - 1,
    );
    expect(visibleNodeCount(state, 'main', 0)).toBe(1);
  });

  it('visibleNodeCount agrees with what treeLayout actually draws', () => {
    const { state } = buildMockState();
    for (const depth of [0, 1, 2, 3, Number.POSITIVE_INFINITY]) {
      expect(visibleNodeCount(state, 'main', depth)).toBe(
        treeLayout(state, 'main', { collapseDepth: depth }).filter((p) => !p.hidden)
          .length,
      );
    }
  });
});
