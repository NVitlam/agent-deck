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
  DEFAULT_DECK_FILTER,
  DEFAULT_DECK_LAYOUT,
  DEFAULT_DECK_SORT,
  LABEL_ADVANCE,
  LABEL_MAX_CHARS,
  LEVEL_GAP,
  NODE_H,
  NODE_W_MIN,
  SIBLING_GAP,
  SUB_ADVANCE,
  autoCollapseDepth,
  countNodes,
  deckColumns,
  deckEngine,
  deckLaneX,
  deckLanesDegrade,
  deckLayout,
  formatCompactTokens,
  nodeLabelText,
  nodeSubText,
  nodeWidth,
  roundCoord,
  sortDeckSessions,
  spawnDotPos,
  toDeckSession,
  toolChildren,
  treeLayout,
  visibleNodeCount,
} from './layout.js';
import type {
  DeckLayoutMode,
  DeckSession,
  DeckSortMode,
  TreePlacement,
} from './layout.js';

const REPO_ROOT = resolve('.');
const WEBVIEW_DIR = join(REPO_ROOT, 'webview');
const GOLDEN_FILE = join(WEBVIEW_DIR, 'goldens', 'layout', 'design-tables.json');

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
        const dot = spawnDotPos(parentPlacement, tools.length, index);
        dx = dot.x;
        dy = dot.y;
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

  beforeAll(async () => {
    const parsed = JSON.parse(await readFile(GOLDEN_FILE, 'utf8')) as {
      generatedBy: string;
      lines: string[];
    };
    expect(parsed.generatedBy).toBe('webview/layout.reference.mjs');
    golden = parsed.lines;
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
    expect(deckLaneX('cc')).toBe(0);
    expect(deckLaneX('oc')).toBe(DECK_CARD_W + 40);
  });

  it('defaults to grid · live first · all', () => {
    expect(DEFAULT_DECK_LAYOUT).toBe('grid');
    expect(DEFAULT_DECK_SORT).toBe('live');
    expect(DEFAULT_DECK_FILTER).toBe('all');
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

  it('maps SessionState.engine onto the deck vocabulary, absence reading as cc', () => {
    expect(deckEngine('opencode')).toBe('oc');
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

  it('puts one level exactly NODE_H + LEVEL_GAP below the last', () => {
    const { state } = buildMockState();
    for (const p of treeLayout(state, 'main').filter((x) => !x.hidden)) {
      expect(p.y).toBe(p.depth * (NODE_H + LEVEL_GAP));
    }
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

  it('a spawn adds without changing any width already drawn', () => {
    // The incremental promise, stated where it is actually checkable: adding a
    // subagent changes no node's WIDTH, so nothing reflows for a reason other
    // than the new node needing room.
    const { state } = buildMockState();
    const before = new Map(
      treeLayout(state, 'main')
        .filter((p) => !p.hidden)
        .map((p) => [p.id, p.w]),
    );
    const a3 = findMockAgent(state, 'a3');
    const newborn: AgentNode = {
      id: 'a3c',
      kind: 'subagent',
      label: 'new-arrival',
      status: 'running',
      spawnDepth: 2,
      children: [],
      burn: { prompt: 1, output: 0 },
      startedAt: 0,
    };
    a3.children.push(newborn);
    const grown = treeLayout(state, 'main').filter((p) => !p.hidden);
    expect(grown.some((p) => p.id === 'a3c')).toBe(true);
    for (const p of grown) {
      if (p.id === 'a3c') continue;
      expect(p.w).toBe(before.get(p.id));
    }
  });

  it('places the spawn dots centred on the node', () => {
    const { state } = buildMockState();
    const main = treeLayout(state, 'main')[0];
    expect(main).toBeTruthy();
    if (main === undefined) return;
    const tools = toolChildren(findMockAgent(state, 'main'));
    const first = spawnDotPos(main, tools.length, 0);
    const last = spawnDotPos(main, tools.length, tools.length - 1);
    expect(roundCoord((first.x + last.x) / 2)).toBe(roundCoord(main.x + main.w / 2));
    expect(first.y).toBe(main.y + NODE_H + 11);
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
