// @vitest-environment jsdom
//
// Altitude 1 — the session TREE — and altitude 1.5, the focus view, asserted
// against the REAL esbuild + Svelte bundle. C7.4's filament (the
// `meta.toolUseId` join, drawn) and G3's parked rail are the two elements this
// file exists to pin.
//
// WHAT WAS DELETED FROM THIS FILE, AND WHY. Every assertion here used to be
// written against `sessionLayout` — dot rings on a chronological arc, cell
// radii from `blobPath`/`hashSessionId`, filament endpoints pulled back to a
// membrane, and parked cells on their own orbit. That geometry is GONE: the
// phyllotaxis canvas was deleted with the golden angle, and `treeLayout` is
// what places nodes now. A test asserting the behaviour of deleted code is not
// coverage, it is a compile error waiting to be read as a regression.
//
// The standard applied to each one was: does it assert something the tree
// still owes the user? If yes it is REWRITTEN against the new geometry and it
// must pass — every refusal row, every motion row, every accessibility row,
// the filament's derivation-from-`spawnEdges` negative control, the parked
// graft's never-attached rule, and the theming rules are all still here. If it
// asserted only where a circle sat on a spiral, it is gone.
//
// WHY A BUNDLE. There is no vitest svelte plugin in this repo, so a `.svelte`
// import cannot be transformed in-process. This file bundles
// `SessionCanvas.svelte` directly through the same esbuild + Svelte pipeline
// `npm run build` runs, from an in-memory entry point. Nothing is written to
// disk (G1) — the entry goes to esbuild as `stdin` and the bundle comes back
// on the child's stdout.
//
// AND WHY A SECOND HARNESS. DoD 7.4 requires the pan/zoom transform to survive
// a STORE UPDATE, and a component mounted with a plain props object has no
// store to update. The last describe block therefore mounts the whole app
// through `testkit.ts:loadHarness` and drives `store.handleMessage` with a
// real `diff` message, which is the only way that claim can be tested rather
// than asserted.
//
// EVERY SHARED testid AND CONTRACT CLASS COMES FROM `canvas-contract.ts`.
// Selecting on a literal is how a renamed name becomes a silently skipped
// assertion rather than a failure: `all()` returns an empty array and a
// `.length === 0` check passes for the wrong reason. The names this package
// alone owns (the breadcrumb, the status line, the rail, the overflow glyph)
// are literals on purpose — `canvas-contract.ts` says in its own header that a
// name with one owner is that owner's to keep.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentNode, SessionState, ToolNode } from '../src/model/events.js';
import { isAgentNode } from '../src/model/events.js';
import {
  ANIMATED_CLASSES,
  HOLLOW_LIVE_CLASS,
  PARKED_CLASS,
  REDUCED_MOTION_CLASS,
  TESTID,
} from './canvas-contract.js';
import {
  AUTO_COLLAPSE_NODES,
  COLLAPSE_DEPTH,
  NODE_H,
  NODE_H_TWO_LINE,
  NODE_W_MIN,
  autoCollapseDepth,
  nodeSubText,
  nodeWidth,
  treeLayout,
  visibleNodeCount,
} from './layout.js';
import {
  TREE_FIT_PADDING,
  TREE_ZOOM_LIMITS,
  boundsOf,
  fitTo,
  panBy,
  transformAttr,
  zoomAbout,
} from './viewport.js';
import { EM_DASH } from './format.js';
import { all, loadHarness, one } from './testkit.js';
import type { WebviewHarness } from './testkit.js';
import { agent, liveSession, tool, unsupportedSession } from './testdata.js';

/**
 * Held in a variable rather than imported statically, for the same reason
 * `testkit.ts` does it: `tsconfig.webview.json` sets `types: []`, so a literal
 * node specifier would fail the webview typecheck. Opaque to `tsc`, resolved
 * at runtime by vitest.
 */
const CHILD_PROCESS = 'node:child_process';
const FS = 'node:fs';

interface ChildProcessModule {
  execFileSync(
    file: string,
    args: readonly string[],
    options: { encoding: 'utf8'; maxBuffer: number },
  ): string;
}

interface FsModule {
  readFileSync(path: string, encoding: 'utf8'): string;
}

const GLOBAL_NAME = 'AgentDeckCanvasHarness';

/** The in-memory entry point esbuild bundles. */
const ENTRY = [
  "export { default as SessionCanvas } from './SessionCanvas.svelte';",
  "export { mount, unmount, flushSync } from 'svelte';",
].join('\n');

/**
 * The build script, run as its own `node` process.
 *
 * A separate process is not incidental: esbuild refuses to start under jsdom,
 * because jsdom installs its own `Uint8Array` and esbuild's startup invariant
 * (`new TextEncoder().encode('') instanceof Uint8Array`) is then false. See
 * `webview/build-harness.mjs`, which carries the same note and the same fix.
 */
const BUILD_SCRIPT = `
import { build } from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
const result = await build({
  stdin: {
    contents: ${JSON.stringify(ENTRY)},
    resolveDir: process.cwd() + '/webview',
    sourcefile: 'canvas-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: ${JSON.stringify(GLOBAL_NAME)},
  target: 'es2022',
  conditions: ['svelte', 'browser'],
  mainFields: ['svelte', 'browser', 'module', 'main'],
  plugins: [esbuildSvelte({ compilerOptions: { css: 'injected' } })],
  logLevel: 'silent',
});
const js = result.outputFiles[0];
if (js === undefined) { process.stderr.write('no output\\n'); process.exit(1); }
process.stdout.write(js.text);
`;

interface CanvasHarness {
  SessionCanvas: unknown;
  mount(
    component: unknown,
    options: { target: HTMLElement; props?: Record<string, unknown> },
  ): unknown;
  unmount(app: unknown): void;
  flushSync(fn?: () => void): void;
}

let harness: CanvasHarness;
/** The bundled JavaScript, kept so the injected stylesheet can be asserted on. */
let bundle = '';
/** The four component sources, read once, for the theming and drag checks. */
let componentSources: { path: string; text: string }[] = [];

/** The files this package owns on this surface. Named once; three checks walk it. */
const OWNED_COMPONENTS = [
  'webview/SessionCanvas.svelte',
  'webview/AgentCell.svelte',
  'webview/Filament.svelte',
];

beforeAll(async () => {
  const cp = (await import(/* @vite-ignore */ CHILD_PROCESS)) as unknown as ChildProcessModule;
  bundle = cp.execFileSync('node', ['--input-type=module', '-e', BUILD_SCRIPT], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const factory = new Function(`${bundle}\nreturn ${GLOBAL_NAME};`) as () => CanvasHarness;
  harness = factory();

  const fs = (await import(/* @vite-ignore */ FS)) as unknown as FsModule;
  componentSources = OWNED_COMPONENTS.map((path) => ({
    path,
    text: fs.readFileSync(path, 'utf8'),
  }));
}, 120_000);

interface Mounted {
  container: HTMLElement;
  dispose: () => void;
}

const mounted: Mounted[] = [];

function render(props: Record<string, unknown>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const app = harness.mount(harness.SessionCanvas, { target: container, props });
  harness.flushSync();
  mounted.push({
    container,
    dispose: () => {
      harness.unmount(app);
      container.remove();
    },
  });
  return container;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

/**
 * Click by dispatching the event, not by calling `.click()`.
 *
 * `HTMLElement.prototype.click` does not exist on an `SVGElement` in jsdom,
 * and every node, dot and filament here is SVG. Dispatching is also the more
 * faithful of the two: it is what a pointer produces in the real panel.
 */
function click(element: Element): void {
  harness.flushSync(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function dblclick(element: Element): void {
  harness.flushSync(() => {
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
}

function press(element: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  harness.flushSync(() => element.dispatchEvent(event));
  return event;
}

/**
 * A pointer gesture, dispatched as `MouseEvent`s with pointer type names.
 *
 * jsdom does not implement `PointerEvent`. A `MouseEvent` named `pointerdown`
 * is what the listener actually receives, and it carries the only three fields
 * the handler reads: `button`, `clientX`, `clientY`.
 */
function pointer(element: Element, type: string, x: number, y: number): void {
  harness.flushSync(() => {
    element.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }),
    );
  });
}

function wheel(element: Element, deltaY: number, x: number, y: number): void {
  harness.flushSync(() => {
    element.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, clientX: x, clientY: y }),
    );
  });
}

/** Every element carrying any class listed in `ANIMATED_CLASSES`. */
function animated(root: ParentNode): Element[] {
  return [...root.querySelectorAll('*')].filter((el) =>
    ANIMATED_CLASSES.some((cls) => el.classList.contains(cls)),
  );
}

/**
 * Nodes that stand for an agent IN the tree, IN DOM ORDER.
 *
 * One `querySelectorAll` over both testids rather than two calls concatenated:
 * concatenating returns every `cell` before the `nucleus` whatever the
 * document says, and the pre-order assertions below are about document order.
 * A helper that imposed its own order would make those assertions pass or fail
 * on where the root happened to sit in the tree.
 */
function treeNodes(root: ParentNode): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      `[data-testid="${TESTID.cell}"],[data-testid="${TESTID.nucleus}"]`,
    ),
  ].filter((c) => c.dataset['parked'] !== 'true');
}

function parkedNodes(root: ParentNode): HTMLElement[] {
  return all(root, TESTID.cell).filter((c) => c.dataset['parked'] === 'true');
}


function filaments(root: ParentNode): HTMLElement[] {
  return all(root, TESTID.filament);
}

function nodeFor(root: ParentNode, agentId: string): HTMLElement {
  const found = treeNodes(root).find((c) => c.dataset['agentId'] === agentId);
  if (found === undefined) throw new Error(`no node for ${agentId}`);
  return found;
}

function boxOf(node: HTMLElement): Element {
  const found = node.querySelector('rect.box');
  if (found === null) throw new Error('no box rect in the node');
  return found;
}

function row1(node: HTMLElement): string {
  return node.querySelector('text.lbl')?.textContent ?? '';
}

/** The SECOND label row, when the label wrapped (A9.1). '' when it did not. */
function row2Label(node: HTMLElement): string {
  const rows = node.querySelectorAll('text.lbl');
  return rows.length > 1 ? (rows[1]?.textContent ?? '') : '';
}

function row2(node: HTMLElement): string {
  return node.querySelector('text.sub')?.textContent ?? '';
}

function depthMark(node: HTMLElement): string {
  return node.querySelector('text.mark')?.textContent ?? '';
}

function field(root: ParentNode): SVGSVGElement {
  const svg = root.querySelector('svg.field');
  if (svg === null) throw new Error('no field');
  return svg as SVGSVGElement;
}

function stageTransform(root: ParentNode): string {
  return one(root, TESTID.canvasStage).getAttribute('transform') ?? '';
}

/** Every node of a tree, in tree order — the order the store accounts for them. */
function flatten(node: AgentNode | ToolNode, out: (AgentNode | ToolNode)[] = []): (
  | AgentNode
  | ToolNode
)[] {
  out.push(node);
  if (isAgentNode(node)) for (const child of node.children) flatten(child, out);
  return out;
}

function agentsOf(state: SessionState): AgentNode[] {
  return flatten(state.root).filter(isAgentNode);
}

/** Set every agent and tool in a tree to `done`, keeping errors. */
function settle(node: AgentNode): AgentNode {
  return {
    ...node,
    status: node.status === 'running' ? 'done' : node.status,
    children: node.children.map((child) =>
      isAgentNode(child)
        ? settle(child)
        : { ...child, status: child.status === 'running' ? ('done' as const) : child.status },
    ),
  };
}

/* ------------------------------------------------------------------------ *
 * Session builders. Hand-built states, not fixtures: the webview never reads a
 * transcript, so a captured JSONL would prove nothing at this altitude.
 * ------------------------------------------------------------------------ */

/** A session with a parked graft: an agent that joined to nothing (UNRESOLVED). */
function parkedSession(overrides: Partial<SessionState> = {}): SessionState {
  return liveSession({
    sessionId: 'session-parked',
    parked: [
      {
        agentId: 'agent-orphan',
        code: 'noMatchingToolUse',
        reason: 'meta.toolUseId names no tool_use block in this transcript',
        toolUseId: 'toolu_ABSENT',
      },
    ],
    ...overrides,
  });
}

/** One agent with `count` tool calls and nothing else. */
function busySession(count: number, overrides: Partial<ToolNode> = {}): SessionState {
  const many = Array.from({ length: count }, (_, i) =>
    tool({ id: `t-${String(i)}`, toolName: 'Bash', inputPreview: 'x', ...overrides }),
  );
  return liveSession({
    sessionId: 'session-busy',
    root: agent({ id: 'root', kind: 'main', label: 'main', spawnDepth: 0, children: many }),
    spawnEdges: [],
    parked: [],
  });
}

/**
 * A tree with more than {@link AUTO_COLLAPSE_NODES} agents in it.
 *
 * Branching 7 to depth 3 is 1 + 7 + 49 + 343 = 400 agents, so the rule fires
 * with room to spare, and collapsing to depth 2 draws 57 of them. The numbers
 * are asserted below rather than described here.
 */
function hugeSession(): SessionState {
  let n = 0;
  const build = (depth: number, id: string): AgentNode => {
    n += 1;
    const kids = depth < 3 ? Array.from({ length: 7 }, (_, i) => build(depth + 1, `${id}-${String(i)}`)) : [];
    return agent({
      id,
      kind: depth === 0 ? 'main' : 'subagent',
      label: `a${String(depth)}`,
      spawnDepth: depth,
      children: kids,
    });
  };
  const root = build(0, 'root');
  expect(n).toBe(400);
  return liveSession({ sessionId: 'session-huge', root, spawnEdges: [], parked: [] });
}

/* ------------------------------------------------------------------------ *
 * The tidy tree: every coordinate is `treeLayout`'s
 * ------------------------------------------------------------------------ */

describe('the tree (altitude 1)', () => {
  it('draws one node per agent, in pre-order, at treeLayout’s coordinates', () => {
    const state = liveSession();
    const placed = treeLayout(state, state.root.id).filter((p) => !p.hidden);
    expect(placed.length).toBe(agentsOf(state).length);

    const container = render({ session: state });
    const drawnIds = [...(container.querySelector('g.nodes')?.children ?? [])]
      .filter((el) => (el as HTMLElement).dataset['agentId'] !== undefined)
      .map((el) => (el as HTMLElement).dataset['agentId']);
    expect(drawnIds).toStrictEqual(placed.map((p) => p.id));

    for (const p of placed) {
      const box = boxOf(nodeFor(container, p.id));
      expect({
        id: p.id,
        x: Number(box.getAttribute('x')),
        y: Number(box.getAttribute('y')),
        w: Number(box.getAttribute('width')),
        h: Number(box.getAttribute('height')),
      }).toStrictEqual({ id: p.id, x: p.x, y: p.y, w: p.w, h: p.h });
    }
  });

  it('pins the root’s box to literal numbers, so a layout change is visible here', () => {
    // Written out rather than derived: this is the one assertion in the file
    // that would still fail if `treeLayout` and this renderer moved together.
    const container = render({ session: liveSession() });
    const box = boxOf(nodeFor(container, 'root'));
    expect(box.getAttribute('x')).toBe('14.5');
    expect(box.getAttribute('y')).toBe('0');
    expect(box.getAttribute('width')).toBe('168');
    expect(box.getAttribute('height')).toBe('52');
    expect(box.getAttribute('rx')).toBe('9');
  });

  it('is one of TWO heights, and only the LABEL decides which', () => {
    // WAS "is FIXED HEIGHT: token share is text, never size". A9.2 lets a box
    // grow to 70 when its label wraps to a second row, and the thing the old
    // test was really guarding is untouched: the predecessor sized a cell by
    // its CHILD COUNT, so one new tool call moved shapes already on screen. A
    // label is written once when the agent is grafted and never changes, so it
    // cannot feed back the way a live count did.
    const container = render({ session: liveSession() });
    const heights = new Set(
      treeNodes(container).map((n) => boxOf(n).getAttribute('height')),
    );
    for (const h of heights) {
      expect([String(NODE_H), String(NODE_H_TWO_LINE)]).toContain(h);
    }

    // AND IT IS THE LABEL: every 70-high box reports two label rows, every
    // 52-high box one. Without this the assertion above would pass on a
    // renderer that picked a height at random from the two.
    for (const n of treeNodes(container)) {
      const tall = boxOf(n).getAttribute('height') === String(NODE_H_TWO_LINE);
      expect(n.dataset['labelLines'], n.dataset['agentId']).toBe(tall ? '2' : '1');
    }
  });

  it('never draws a node below the collapse depth, though the layout returns it', () => {
    // `treeLayout` returns hidden placements too, positioned on the collapsed
    // ancestor that swallowed them, so a caller can count them. Drawing one
    // would stack a node on top of its own parent.
    const state = liveSession();
    const placed = treeLayout(state, state.root.id, { collapseDepth: 1 });
    const hidden = placed.filter((p) => p.hidden);
    expect(hidden.length).toBeGreaterThan(0);

    const container = render({ session: state });
    press(nodeFor(container, 'root'), 'k');
    // `K` collapses to depth 2, which hides nothing in a 3-level tree; the
    // point of this assertion is the one below it, on a tree that is deeper.
    expect(one(container, TESTID.canvas).dataset['collapseDepth']).toBe(String(COLLAPSE_DEPTH));
  });

  it('WRAPS row 1 rather than eliding it, and says the depth on the right', () => {
    // A9.1: no ellipsis anywhere. The label ran `test-runner: run t…` here
    // until 2026-08-29 — cut at LABEL_MAX_CHARS with a `…` — and it now takes
    // a second row, breaking on the space.
    const container = render({ session: liveSession() });
    expect(row1(nodeFor(container, 'root'))).toBe('main session');
    expect(row1(nodeFor(container, 'agent-1'))).toBe('test-runner: run');
    expect(row2Label(nodeFor(container, 'agent-1'))).toBe('the module suite');

    // NOT ONE CHARACTER IS LOST: the two rows rejoin to the whole label.
    const agent1 = liveSession().root.children.find((c) => c.id === 'agent-1');
    expect(
      `${row1(nodeFor(container, 'agent-1'))} ${row2Label(nodeFor(container, 'agent-1'))}`,
    ).toBe(agent1 !== undefined && 'label' in agent1 ? agent1.label : '');

    // ...and no rendered row ends in an ellipsis, on any node.
    for (const n of treeNodes(container)) expect(row1(n).endsWith('…')).toBe(false);

    expect(depthMark(nodeFor(container, 'root'))).toBe('root');
    expect(depthMark(nodeFor(container, 'agent-1'))).toBe('d1');
    expect(depthMark(nodeFor(container, 'agent-2'))).toBe('d2');
  });

  it('carries the WHOLE label on hover, always (A9.1)', () => {
    // The escape hatch the amendment promises: two rows may still not hold a
    // long label, and the full string is one hover away rather than marked
    // with a glyph the reader has to interpret.
    const container = render({ session: liveSession() });
    for (const n of treeNodes(container)) {
      const title = n.querySelector('title')?.textContent ?? '';
      expect(title.length, n.dataset['agentId']).toBeGreaterThan(0);
      expect(title.startsWith(row1(n))).toBe(true);
    }
  });

  it('row 2 is burn + call count, BY VALUE, and it is the string the width came from', () => {
    // ASSERTED BY VALUE, not by presence. A `toContain(EM_DASH)` here would
    // pass while every figure on the canvas rendered as a dash, which is
    // exactly the shape that shipped a fully-dashed token row once.
    //
    // testdata's root carries burn 24,690 + 13,578 = 38,268 and contextNow
    // 12,345 / 6,789. Reading `contextNow` by mistake gives '12.3k', so these
    // literals distinguish the two fields.
    const container = render({ session: liveSession() });
    expect(row2(nodeFor(container, 'root'))).toBe('38.3k · 2 calls');
    expect(row2(nodeFor(container, 'agent-1'))).toBe('11.5k · 1 calls · 1 running');
    expect(row2(nodeFor(container, 'agent-2'))).toBe('2.0k · 1 calls');

    // ...and it is `nodeSubText`, imported, so the drawn string and the width
    // reserved for it cannot disagree.
    for (const a of agentsOf(liveSession())) {
      expect(row2(nodeFor(container, a.id))).toBe(nodeSubText(a));
    }
  });

  it('prints an em-dash, never 0, for an engine that reports no burn', () => {
    const noBurn = agent({
      id: 'root',
      kind: 'main',
      label: 'main',
      spawnDepth: 0,
      burn: undefined,
      children: [tool({ id: 't1', inputPreview: 'x' })],
    });
    const container = render({
      session: liveSession({ root: noBurn, spawnEdges: [], parked: [] }),
    });
    expect(row2(nodeFor(container, 'root'))).toBe(`${EM_DASH} · 1 calls`);
    expect(row2(nodeFor(container, 'root'))).not.toContain('0 ·');
  });

  it('marks active, ended, selected and root, each on its own attribute', () => {
    const live = render({ session: liveSession(), selectedNodeId: 'agent-1' });
    expect(nodeFor(live, 'root').dataset['active']).toBe('true');
    expect(nodeFor(live, 'agent-1').dataset['selected']).toBe('true');
    expect(nodeFor(live, 'agent-1').getAttribute('aria-current')).toBe('true');
    expect(nodeFor(live, 'agent-2').dataset['selected']).toBe('false');
    expect(one(live, TESTID.nucleus).classList.contains('is-root')).toBe(true);

    const settled = render({ session: liveSession({ root: settle(liveSession().root) }) });
    for (const node of treeNodes(settled)) expect(node.dataset['active']).toBe('false');
  });

  it('carries a stylesheet rule for each of the four node states', () => {
    // CSS cannot import a TypeScript name, so each of these is spelled a
    // second time in the stylesheet. Checking the bundle is what stops a
    // rename from switching the styling off while every DOM assertion passes.
    for (const rule of [
      "[data-active='true']",
      "[data-active='false']",
      "[data-selected='true']",
      '.is-root',
    ]) {
      expect(bundle).toContain(rule);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * A8.1 — the tool-dot row is GONE
 * ------------------------------------------------------------------------ */

describe('the tool-dot row, which no longer exists (A8.1)', () => {
  /*
   * A `tool dots` describe stood here with eight tests: one dot per call at
   * `spawnDotPos`, the 13-unit pitch, status colours, hover-only titles, the
   * 24-cap and its `+N` glyph. Every one of them passed, and the feature they
   * described put 17 of 18 rows outside their own boxes on the wide-rank
   * corpus, overlapped 14 sibling pairs, and cost 15 of 15 filaments.
   *
   * They are DELETED rather than skipped. A suite of passing tests for a
   * removed feature is how the feature comes back: the next reader sees
   * coverage and assumes intent.
   */
  it('draws no dot and no elision badge, whatever the call count', () => {
    const container = render({ session: busySession(240) });
    expect(all(container, 'canvas-dot')).toHaveLength(0);
    expect(all(container, 'canvas-elided-badge')).toHaveLength(0);
    expect(container.querySelectorAll('circle.bud')).toHaveLength(0);
    // Non-vacuity: the tree IS drawn, so the zeros above are about dots
    // rather than about an empty render.
    expect(treeNodes(container).length).toBeGreaterThan(0);
  });

  it('still says how many calls there were, on the node itself', () => {
    // The count did not go away with the dots — it is row 2, where it always
    // was, and it is exact rather than capped.
    const container = render({ session: busySession(240) });
    expect(row2(nodeFor(container, 'root'))).toContain('240 calls');
  });
});

/* ------------------------------------------------------------------------ *
 * C7.4 — the filament IS the join key
 * ------------------------------------------------------------------------ */

describe('the filament (C7.4)', () => {
  it('draws exactly one per spawn edge, carrying both halves of the key', () => {
    const state = liveSession();
    const edges = state.spawnEdges ?? [];
    expect(edges.length).toBeGreaterThan(0);
    const container = render({ session: state });
    expect(
      filaments(container).map((f) => ({
        toolUseId: f.dataset['toolUseId'],
        agentId: f.dataset['agentId'],
      })),
    ).toStrictEqual(edges.map((e) => ({ toolUseId: e.toolUseId, agentId: e.agentId })));
  });

  it('runs from the PARENT’s bottom edge to the child’s TOP CENTRE, as a cubic', () => {
    // The literal path, written out. Design amendment A8.2: the curve leaves
    // the parent box's bottom centre, not a dot. `root` is x 14.5 w 168 y 0,
    // so it leaves (98.5, 52); `agent-1` is at x 0 w 197 y 164, so it arrives
    // at (98.5, 164) and both control points sit on (52 + 164) / 2 = 108.
    //
    // It read `M 105 67 C 105 113.5 98.5 113.5 98.5 164` until 2026-08-29 —
    // the spawning dot's bottom edge, 4 units below its centre at (105, 63).
    const container = render({ session: liveSession() });
    const first = filaments(container).find((f) => f.dataset['agentId'] === 'agent-1');
    expect(first?.getAttribute('d')).toBe('M 98.5 52 C 98.5 108 98.5 108 98.5 164');

    // `agent-1`'s label wraps (A9.1), so its box is 70 tall and the curve to
    // `agent-2` leaves 18 units lower than it did — the anchor is the parent's
    // OWN height, not a constant.
    const second = filaments(container).find((f) => f.dataset['agentId'] === 'agent-2');
    expect(second?.getAttribute('d')).toBe('M 98.5 234 C 98.5 290 98.5 290 98.5 346');
  });

  it('DERIVATION: the same tree with no spawn edges draws no filament at all', () => {
    // The load-bearing negative. `ToolNode` has no `children`, so the spawn
    // relationship exists ONLY in `spawnEdges`; a renderer that inferred it
    // from adjacency, from tree order or from proximity would still draw lines
    // here. The nodes are identical either way, so this isolates the
    // derivation rather than the drawing.
    const withEdges = liveSession();
    const withoutEdges = liveSession({ spawnEdges: [] });
    const a = render({ session: withEdges });
    const b = render({ session: withoutEdges });
    expect(filaments(a).length).toBe((withEdges.spawnEdges ?? []).length);
    expect(filaments(b)).toHaveLength(0);
    expect(treeNodes(b).length).toBe(treeNodes(a).length);
  });

  it('draws the edge even when its `tool_use` id names no call in the tree', () => {
    // CHANGED BY A8.2, and the reasoning changed with it. The curve used to
    // anchor on the spawning DOT, so an edge whose call was not drawn drew
    // nothing — correct for a claim about a specific call, and catastrophic
    // once the dot cap started eliding nearly every call: measured on the
    // wide-rank corpus, 0 of 15 filaments survived.
    //
    // The join this curve now draws is (parentNodeId, agentId), and BOTH ends
    // resolve here, so the edge is drawn. Nothing is guessed: the `tool_use`
    // id is still carried verbatim on the element for the drawer to correlate,
    // and it is still never invented.
    const state = liveSession({
      spawnEdges: [
        {
          toolUseId: 'toolu_NOT_IN_THIS_TREE',
          agentId: 'agent-1',
          parentNodeId: 'root',
          depth: 1,
          recordedDepth: 1,
        },
      ],
    });
    const container = render({ session: state });
    const drawn = filaments(container);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.dataset['toolUseId']).toBe('toolu_NOT_IN_THIS_TREE');
    expect(drawn[0]?.dataset['agentId']).toBe('agent-1');
    expect(nodeFor(container, 'agent-1')).toBeDefined();
  });

  it('is live while the child is active and dim once it has ended', () => {
    const a = render({ session: liveSession() });
    for (const f of filaments(a)) {
      expect(f.dataset['state']).toBe('live');
      expect(f.dataset['flowing']).toBe('true');
      expect(f.classList.contains(ANIMATED_CLASSES[2])).toBe(true);
    }

    const b = render({ session: liveSession({ root: settle(liveSession().root) }) });
    expect(filaments(b).length).toBeGreaterThan(0);
    for (const f of filaments(b)) {
      expect(f.dataset['state']).toBe('dim');
      expect(f.dataset['flowing']).toBe('false');
      expect(f.classList.contains(ANIMATED_CLASSES[2])).toBe(false);
    }
    expect(bundle).toContain("[data-state='dim']");
  });

  it('paints UNDER the nodes: the filament group precedes the node group', () => {
    const container = render({ session: liveSession() });
    const stage = one(container, TESTID.canvasStage);
    const classes = [...stage.children].map((el) => el.getAttribute('class'));
    expect(classes.indexOf('filaments')).toBeLessThan(classes.indexOf('nodes'));
    expect(classes.indexOf('filaments')).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * G3 — the parked rail
 * ------------------------------------------------------------------------ */

describe('the parked rail (C7.4, G3)', () => {
  it('renders a parked agent that has NO NODE IN THE TREE', () => {
    const state = parkedSession();
    const parked = state.parked ?? [];
    expect(parked.length).toBeGreaterThan(0);
    // The premise: it is genuinely absent from the tree, so a tree walk could
    // never have produced it.
    for (const entry of parked) {
      expect(flatten(state.root).map((n) => n.id)).not.toContain(entry.agentId);
    }
    const container = render({ session: state });
    expect(parkedNodes(container).map((c) => c.dataset['agentId'])).toStrictEqual(
      parked.map((p) => p.agentId),
    );
  });

  it('puts the rail at maxNodeX + 64, with its rule 24 to the left', () => {
    const state = parkedSession();
    const placed = treeLayout(state, state.root.id).filter((p) => !p.hidden);
    const maxNodeX = Math.max(...placed.map((p) => p.x + p.w));
    expect(maxNodeX).toBe(197);

    const container = render({ session: state });
    const rail = one(container, 'parked-rail');
    expect(rail.dataset['x']).toBe(String(maxNodeX + 64));
    expect(one(container, 'parked-rail-rule').getAttribute('d')).toContain(
      `M ${String(maxNodeX + 64 - 24)} `,
    );
    expect(one(container, 'parked-rail-label').textContent).toBe('PARKED · not guessed');
    expect(one(container, 'parked-rail-label').getAttribute('y')).toBe('-4');
  });

  it('stacks items at 8 + i·64 and shows the STABLE CODE on each', () => {
    const state = parkedSession({
      parked: [
        { agentId: 'p0', code: 'noMatchingToolUse', reason: 'r0' },
        { agentId: 'p1', code: 'ambiguousJoinKey', reason: 'r1' },
        { agentId: 'p2', code: 'taskWithoutChild', reason: 'r2' },
      ],
    });
    const container = render({ session: state });
    const items = parkedNodes(container);
    expect(items).toHaveLength(3);
    items.forEach((item, i) => {
      expect(boxOf(item).getAttribute('y')).toBe(String(8 + i * (NODE_H + 12)));
      expect(boxOf(item).getAttribute('width')).toBe(String(NODE_W_MIN));
    });
    expect(items.map((i) => i.dataset['parkCode'])).toStrictEqual([
      'noMatchingToolUse',
      'ambiguousJoinKey',
      'taskWithoutChild',
    ]);
    // The code is on the FACE of the item, not only in an attribute: a refusal
    // the user cannot read is a refusal that looks like a bug.
    expect(row2(items[0] as HTMLElement)).toContain('noMatchingToolUse');
    expect(items[0]?.textContent).toContain('awaiting attribution');
  });

  it('renders it dash-bordered, with the contract class, and NEVER attached', () => {
    const container = render({ session: parkedSession() });
    const item = parkedNodes(container)[0] as HTMLElement;
    expect(item.classList.contains(PARKED_CLASS)).toBe(true);
    expect(boxOf(item).classList.contains(PARKED_CLASS)).toBe(true);
    expect(all(item, TESTID.parkedStub)).toHaveLength(1);
    for (const f of filaments(container)) {
      expect(f.dataset['agentId']).not.toBe(item.dataset['agentId']);
    }
    expect(animated(item)).toHaveLength(0);
  });

  it('SHOWS ONLY AT THE SESSION ROOT — a rail beside a subtree would be a guess', () => {
    const container = render({ session: parkedSession() });
    expect(parkedNodes(container)).toHaveLength(1);
    expect(one(container, TESTID.canvas).dataset['parked']).toBe('1');

    dblclick(nodeFor(container, 'agent-1'));
    expect(one(container, TESTID.canvas).dataset['atSessionRoot']).toBe('false');
    expect(parkedNodes(container)).toHaveLength(0);
    expect(all(container, 'parked-rail')).toHaveLength(0);
    expect(one(container, TESTID.canvas).dataset['parked']).toBe('0');
  });

  it('is reachable by keyboard and is not selectable — there is no node to inspect', () => {
    const picked: string[] = [];
    const container = render({
      session: parkedSession(),
      onselect: (id: string) => picked.push(id),
    });
    const item = parkedNodes(container)[0] as HTMLElement;
    expect(item.getAttribute('tabindex')).toBe('0');
    expect(item.getAttribute('aria-label')).toContain('awaiting attribution');
    item.focus();
    expect(document.activeElement).toBe(item);
    click(item);
    press(item, 'Enter');
    expect(picked).toStrictEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 7.6 — focus and re-root
 * ------------------------------------------------------------------------ */

describe('focus / re-root (DoD 7.6)', () => {
  it('re-roots on double-click at depth 1 and lays the SUBTREE out identically', () => {
    const state = liveSession();
    const container = render({ session: state });
    dblclick(nodeFor(container, 'agent-1'));

    expect(one(container, TESTID.canvas).dataset['rootId']).toBe('agent-1');
    const expected = treeLayout(state, 'agent-1').filter((p) => !p.hidden);
    expect(expected.map((p) => p.id)).toStrictEqual(['agent-1', 'agent-2']);
    for (const p of expected) {
      const box = boxOf(nodeFor(container, p.id));
      expect([Number(box.getAttribute('x')), Number(box.getAttribute('y'))]).toStrictEqual([
        p.x,
        p.y,
      ]);
    }
    // `root` is not drawn: the focus view is the subtree, not a highlight.
    expect(treeNodes(container).map((n) => n.dataset['agentId'])).toStrictEqual([
      'agent-1',
      'agent-2',
    ]);
    // ...and the focus target becomes depth 0, so it wears the root marker.
    expect(depthMark(nodeFor(container, 'agent-1'))).toBe('root');
    expect(depthMark(nodeFor(container, 'agent-2'))).toBe('d1');
  });

  it('re-roots at depth 2 by the SAME algorithm', () => {
    const state = liveSession();
    const container = render({ session: state });
    dblclick(nodeFor(container, 'agent-1'));
    dblclick(nodeFor(container, 'agent-2'));
    expect(one(container, TESTID.canvas).dataset['rootId']).toBe('agent-2');
    expect(treeNodes(container).map((n) => n.dataset['agentId'])).toStrictEqual(['agent-2']);
    const only = treeLayout(state, 'agent-2').filter((p) => !p.hidden);
    expect(only).toHaveLength(1);
    expect(Number(boxOf(nodeFor(container, 'agent-2')).getAttribute('y'))).toBe(only[0]?.y);
  });

  it('SINGLE CLICK SELECTS and does not re-root', () => {
    const picked: string[] = [];
    const container = render({
      session: liveSession(),
      onselect: (id: string) => picked.push(id),
    });
    click(nodeFor(container, 'agent-1'));
    expect(picked).toStrictEqual(['agent-1']);
    expect(one(container, TESTID.canvas).dataset['rootId']).toBe('root');
  });

  it('the breadcrumb equals the parentAgentId chain, ancestor by ancestor', () => {
    // THE DoD ITEM. The component walks `children` to build the path; this
    // rebuilds it from `spawnEdges.parentNodeId` — the host's copy of the
    // sidecar's parent claim — and requires the two to agree. Two independent
    // derivations of one path is the only form of this check that can fail.
    const state = liveSession();
    const parentOf = new Map(
      (state.spawnEdges ?? []).map((e) => [e.agentId, e.parentNodeId]),
    );
    const chainTo = (id: string): string[] => {
      const out = [id];
      let cursor = id;
      for (;;) {
        const parent = parentOf.get(cursor);
        if (parent === undefined) break;
        out.unshift(parent);
        cursor = parent;
      }
      return out;
    };

    const container = render({ session: state });
    dblclick(nodeFor(container, 'agent-1'));
    dblclick(nodeFor(container, 'agent-2'));

    const crumbs = all(container, 'tree-crumb').map((c) => c.dataset['crumbId']);
    expect(crumbs).toStrictEqual(chainTo('agent-2'));
    expect(crumbs).toStrictEqual(['root', 'agent-1', 'agent-2']);
    // The deck crumb leads it, so the path reads `deck / … / …`.
    expect(one(container, 'tree-crumb-deck').textContent).toBe('deck');
    expect(all(container, 'tree-crumb')[2]?.getAttribute('aria-current')).toBe('page');
  });

  it('makes every ancestor crumb clickable, and clicking one re-roots there', () => {
    const container = render({ session: liveSession() });
    dblclick(nodeFor(container, 'agent-1'));
    dblclick(nodeFor(container, 'agent-2'));
    const crumbs = all(container, 'tree-crumb');
    expect(crumbs.map((c) => c.tagName)).toStrictEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    click(crumbs[1] as HTMLElement);
    expect(one(container, TESTID.canvas).dataset['rootId']).toBe('agent-1');
    click(crumbs[0] as HTMLElement);
    expect(one(container, TESTID.canvas).dataset['rootId']).toBe('root');
  });

  it('Escape re-roots on the PARENT, and at the session root leaves altitude 1', () => {
    // WATCHED AT THE WINDOW, not read off the event afterwards. The DOM
    // standard unsets the stop-propagation flag at the end of dispatch, so
    // `event.cancelBubble` is false by the time a test can read it — measured
    // here, and it would have made this assertion vacuous in the direction
    // that matters. A window listener is what `App.svelte` actually has.
    let reachedWindow = 0;
    const watch = (): void => {
      reachedWindow += 1;
    };
    window.addEventListener('keydown', watch);
    try {
      let left = 0;
      const container = render({ session: liveSession(), ondeck: () => (left += 1) });
      dblclick(nodeFor(container, 'agent-1'));
      dblclick(nodeFor(container, 'agent-2'));
      expect(one(container, TESTID.canvas).dataset['rootId']).toBe('agent-2');

      press(nodeFor(container, 'agent-2'), 'Escape');
      expect(one(container, TESTID.canvas).dataset['rootId']).toBe('agent-1');
      // Stopped, so `App.svelte`'s window handler does not ALSO walk the
      // altitude down: one keystroke, one transition.
      expect(reachedWindow).toBe(0);
      expect(left).toBe(0);

      press(nodeFor(container, 'agent-1'), 'Escape');
      expect(one(container, TESTID.canvas).dataset['rootId']).toBe('root');
      expect(reachedWindow).toBe(0);
      expect(left).toBe(0);

      // At the session root there is no parent to climb to, so Escape means
      // "out of the session": `ondeck` fires AND the event is deliberately
      // left to reach the window, which is where the altitude ladder lives.
      press(nodeFor(container, 'root'), 'Escape');
      expect(left).toBe(1);
      expect(reachedWindow).toBe(1);
    } finally {
      window.removeEventListener('keydown', watch);
    }
  });

  it('ENTERING FITS, and re-rooting fits again, and nothing else fits', () => {
    const state = liveSession();
    const container = render({ session: state, size: { width: 960, height: 640 } });

    // THIS ASSERTION USED TO EXPECT THE IDENTITY TRANSFORM, with the comment
    // "Nothing has fitted yet". It was pinning the defect: identity is the
    // stage origin at the field's top-left, and the tidy tree centres the root
    // over its children's span, so a wide tree opened with the root off-screen
    // and only the child row in view. §3.4's "re-rooting calls fit once"
    // covers entry too — entry is the first rooting of the tree.
    const fitOf = (root: string): string => {
      const placed = treeLayout(state, root).filter((p) => !p.hidden);
      return transformAttr(
        fitTo(
          boundsOf(placed.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }))),
          { width: 960, height: 640 },
          TREE_FIT_PADDING,
          TREE_ZOOM_LIMITS,
        ),
      );
    };
    expect(stageTransform(container)).toBe(fitOf(state.root.id));

    dblclick(nodeFor(container, 'agent-1'));
    const placed = treeLayout(state, 'agent-1').filter((p) => !p.hidden);
    const expected = fitTo(
      boundsOf(placed.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }))),
      { width: 960, height: 640 },
      TREE_FIT_PADDING,
      TREE_ZOOM_LIMITS,
    );
    expect(stageTransform(container)).toBe(transformAttr(expected));

    // A plain selection does not fit, so the view a user framed stays framed.
    click(nodeFor(container, 'agent-2'));
    expect(stageTransform(container)).toBe(transformAttr(expected));
  });

  it('RESET returns to the session root and frames the whole tree (A9.3)', () => {
    // The reported defect: "the reset view inside an active session takes the
    // page to its left side". It set the IDENTITY transform — the stage origin
    // at the field's top-left — and the tidy tree centres the root over its
    // children, so on any tree wider than the field reset threw the user at the
    // far left with the root off-screen. On the one control whose whole job is
    // to undo a lost view.
    const state = liveSession();
    const container = render({ session: state, size: { width: 960, height: 640 } });

    // Go somewhere: focus a child, then pan and zoom away from it.
    dblclick(nodeFor(container, 'agent-1'));
    const svg = field(container);
    pointer(svg, 'pointerdown', 400, 300);
    pointer(svg, 'pointermove', 700, 120);
    pointer(svg, 'pointerup', 700, 120);
    wheel(svg, -100, 200, 100);
    expect(one(container, TESTID.canvas).dataset['focus']).toBe('agent-1');

    click(one(container, TESTID.canvasReset));

    // BACK AT THE SESSION ROOT — "always start from the main session".
    expect(one(container, TESTID.canvas).dataset['focus']).toBe(state.root.id);

    // ...and FRAMED, not parked at the origin. The transform is the fit of the
    // whole tree, and it is emphatically not the identity.
    const placed = treeLayout(state, state.root.id).filter((p) => !p.hidden);
    const expected = fitTo(
      boundsOf(placed.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }))),
      { width: 960, height: 640 },
      TREE_FIT_PADDING,
      TREE_ZOOM_LIMITS,
    );
    expect(stageTransform(container)).toBe(transformAttr(expected));
    expect(stageTransform(container)).not.toBe(transformAttr({ x: 0, y: 0, k: 1 }));

    // Every node is on screen — which is the property a user means by "reset".
    for (const p of placed) {
      const left = p.x * expected.k + expected.x;
      const right = (p.x + p.w) * expected.k + expected.x;
      expect(left, `${p.id} off the left`).toBeGreaterThanOrEqual(-1);
      expect(right, `${p.id} off the right`).toBeLessThanOrEqual(961);
    }
  });

  /**
   * THE 16-SUBAGENT SESSION — which is how this was reported: "they all appear
   * as a second row".
   *
   * The tidy tree was right and the viewport was not. MEASURED ON THIS TEST'S
   * OWN TREE — 16 children, each 197 wide by A1.1, `SIB` 24 — so the numbers
   * here describe what this file builds, not the wide-rank corpus, whose
   * figures differ and belong to `wide-rank.test.ts`. An earlier draft of this
   * comment carried three different spans for one shape.
   *
   * One row: 3,512 units, needing k = 0.323 against §3.4's 0.4 floor, so it
   * could not be framed at all. At the identity transform in a 1,200 px panel
   * that is 6 of 16 children and NO ROOT — a row of nodes with nothing above
   * them, which is the whole of the report.
   *
   * The assertion is deliberately not "the transform equals this literal". A
   * literal passes just as well against a fit of the wrong subtree. This
   * checks the property a person actually cares about: after entering, every
   * node the layout drew is inside the field.
   */
  it('frames the root and every child of a tree far wider than the field', () => {
    const width = 1200;
    const height = 640;
    const kids = Array.from({ length: 16 }, (_, i) =>
      agent({
        id: `wide-${String(i)}`,
        kind: 'subagent',
        label: `phase-implementer ${String(i)}`,
        spawnDepth: 1,
        children: [tool({ id: `wide-t-${String(i)}`, toolName: 'Bash', inputPreview: 'x' })],
      }),
    );
    const state = liveSession({
      sessionId: 'session-wide',
      root: agent({ id: 'root', kind: 'main', label: 'main', spawnDepth: 0, children: kids }),
      spawnEdges: [],
      parked: [],
    });

    // The premise, measured rather than assumed: the rank WRAPS (A8.4 wraps
    // above 8 children, and there are 16), and the tree is still wider than the
    // field, so the entry fit is doing real work. Before A8.4 this same tree
    // was one row 3,512 units wide and could not be fitted at all — §3.4 floors
    // the tree at 0.4x and it needed 0.323.
    const placed = treeLayout(state, 'root').filter((p) => !p.hidden);
    const rows = new Set(placed.filter((p) => p.depth === 1).map((p) => p.y));
    expect(rows.size, 'the rank did not wrap').toBe(2);
    const span = boundsOf(placed.map((p) => ({ x: p.x, y: p.y, w: p.w, h: NODE_H })));
    expect(span.w).toBeGreaterThan(width);
    const rootPlacement = placed.find((p) => p.id === 'root');
    expect(rootPlacement).toBeDefined();

    const container = render({ session: state, size: { width, height } });
    const expected = fitTo(span, { width, height }, TREE_FIT_PADDING, TREE_ZOOM_LIMITS);
    expect(stageTransform(container)).toBe(transformAttr(expected));

    // THE ROOT IS ON SCREEN. This is the reported symptom, stated as the one
    // property that was false before: a row of children with nothing above it.
    const on = (p: { x: number; y: number; w: number }): { left: number; right: number; top: number } => ({
      left: p.x * expected.k + expected.x,
      right: (p.x + p.w) * expected.k + expected.x,
      top: p.y * expected.k + expected.y,
    });
    const root = on(rootPlacement as { x: number; y: number; w: number });
    expect(root.left, 'the root is off the left edge').toBeGreaterThanOrEqual(-1);
    expect(root.right, 'the root is off the right edge').toBeLessThanOrEqual(width + 1);
    expect(root.top, 'the root is above the field').toBeGreaterThanOrEqual(-1);

    // AND EVERY CHILD IS ON SCREEN TOO. This assertion was "the overflow is
    // symmetric" until A8.4: in ONE row these sixteen span 3,512 units and need
    // k = 0.323 against §3.4's 0.4 floor, so the best available was a centred,
    // pannable overflow. Wrapped into rows of 8 the same tree spans 1,744 and
    // fits at 0.651, so the honest claim is the strong one.
    for (const p of placed) {
      const at = on(p);
      expect(at.left, `${p.id} is off the left edge`).toBeGreaterThanOrEqual(-1);
      expect(at.right, `${p.id} is off the right edge`).toBeLessThanOrEqual(width + 1);
      expect(at.top, `${p.id} is above the field`).toBeGreaterThanOrEqual(-1);
    }
  });

  /**
   * The boundary, so the assertion above is not read as "wide trees overflow,
   * shrug". TWELVE depth-1 siblings DO fit a 1,200 px panel at the 0.4 floor
   * (they need k = 0.432); thirteen do not. Measured, and it is the control
   * that proves the geometry check in the previous test can be satisfied.
   */
  it('brings every node on screen when the fit does not hit the zoom floor', () => {
    const width = 1200;
    const height = 640;
    const kids = Array.from({ length: 12 }, (_, i) =>
      agent({
        id: `fits-${String(i)}`,
        kind: 'subagent',
        label: `phase-implementer ${String(i)}`,
        spawnDepth: 1,
        children: [tool({ id: `fits-t-${String(i)}`, toolName: 'Bash', inputPreview: 'x' })],
      }),
    );
    const state = liveSession({
      sessionId: 'session-fits',
      root: agent({ id: 'root', kind: 'main', label: 'main', spawnDepth: 0, children: kids }),
      spawnEdges: [],
      parked: [],
    });

    const placed = treeLayout(state, 'root').filter((p) => !p.hidden);
    const span = boundsOf(placed.map((p) => ({ x: p.x, y: p.y, w: p.w, h: NODE_H })));
    const expected = fitTo(span, { width, height }, TREE_FIT_PADDING, TREE_ZOOM_LIMITS);
    // The premise: this one does NOT hit the floor, or it proves nothing.
    expect(expected.k).toBeGreaterThan(TREE_ZOOM_LIMITS.min);

    render({ session: state, size: { width, height } });
    for (const p of placed) {
      const left = p.x * expected.k + expected.x;
      const right = (p.x + p.w) * expected.k + expected.x;
      const top = p.y * expected.k + expected.y;
      const bottom = (p.y + NODE_H) * expected.k + expected.y;
      expect(left, `${p.id} is off the left edge`).toBeGreaterThanOrEqual(-1);
      expect(right, `${p.id} is off the right edge`).toBeLessThanOrEqual(width + 1);
      expect(top, `${p.id} is above the field`).toBeGreaterThanOrEqual(-1);
      expect(bottom, `${p.id} is below the field`).toBeLessThanOrEqual(height + 1);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * Collapse
 * ------------------------------------------------------------------------ */

describe('collapse', () => {
  it('defaults to no collapse depth at all', () => {
    const container = render({ session: liveSession() });
    expect(one(container, TESTID.canvas).dataset['collapseDepth']).toBe('Infinity');
    expect(one(container, TESTID.canvas).dataset['autoCollapsed']).toBe('false');
    expect(all(container, TESTID.elidedBadge)).toHaveLength(0);
  });

  it('K sets depth 2, draws a +N badge, and the badge RE-ROOTS on its node', () => {
    const state = hugeSession();
    const container = render({ session: state, collapseDepth: undefined });
    press(one(container, TESTID.nucleus), 'k');
    expect(one(container, TESTID.canvas).dataset['collapseDepth']).toBe(String(COLLAPSE_DEPTH));

    // Depth-2 nodes have children and are not drawing them: 1 + 7 + 49.
    expect(treeNodes(container)).toHaveLength(57);
    const badges = all(container, TESTID.elidedBadge);
    expect(badges).toHaveLength(49);
    expect(badges[0]?.dataset['count']).toBe('7');
    expect(badges[0]?.textContent).toBe('+7 ▾');

    const owner = badges[0]?.closest(`[data-testid="${TESTID.cell}"]`) as HTMLElement;
    const ownerId = owner.dataset['agentId'];
    click(badges[0] as HTMLElement);
    expect(one(container, TESTID.canvas).dataset['rootId']).toBe(ownerId);
  });

  it('auto-collapses above AUTO_COLLAPSE_NODES and SAYS SO in the status line', () => {
    const state = hugeSession();
    expect(visibleNodeCount(state, 'root')).toBe(400);
    expect(visibleNodeCount(state, 'root')).toBeGreaterThan(AUTO_COLLAPSE_NODES);
    expect(autoCollapseDepth(state, 'root')).toBe(COLLAPSE_DEPTH);

    const container = render({ session: state });
    expect(one(container, TESTID.canvas).dataset['autoCollapsed']).toBe('true');
    expect(treeNodes(container)).toHaveLength(57);
    const status = one(container, 'tree-status').textContent ?? '';
    expect(status).toContain('automatically');
    expect(status).toContain('57 of 400 nodes');
    expect(status).toContain('343 hidden');
  });

  it('does NOT auto-collapse a tree at the limit — the rule is strictly greater', () => {
    const state = liveSession();
    expect(visibleNodeCount(state, 'root')).toBeLessThanOrEqual(AUTO_COLLAPSE_NODES);
    const container = render({ session: state });
    expect(one(container, TESTID.canvas).dataset['autoCollapsed']).toBe('false');
    expect(one(container, 'tree-status').textContent).toBe('3 of 3 nodes');
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 7.5 — the pulse rule, with its negative control
 * ------------------------------------------------------------------------ */

describe('the pulse rule (DoD 7.5, C7.6)', () => {
  /** The ids of the nodes carrying the pulse. */
  function pulsing(root: ParentNode): string[] {
    return all(root, 'tree-pulse')
      .filter((el) => el.classList.contains(ANIMATED_CLASSES[0]))
      .map((el) => (el.closest('[data-agent-id]') as HTMLElement).dataset['agentId'] ?? '')
      .sort();
  }

  it('pulses EXACTLY the nodes with an in-flight tool or a live cursor', () => {
    const container = render({ session: liveSession() });
    expect(pulsing(container)).toStrictEqual(['agent-1', 'agent-2', 'root']);
    for (const node of treeNodes(container)) {
      expect(all(node, 'tree-pulse').length > 0).toBe(node.dataset['active'] === 'true');
    }
  });

  it('pulses an agent whose OWN status is done while a tool is still running', () => {
    // The "in-flight tool" half, isolated: nothing about this agent's own
    // status says anything is happening, and something is.
    const state = liveSession();
    const stalled = agent({
      id: 'root',
      kind: 'main',
      label: 'main',
      status: 'done',
      spawnDepth: 0,
      children: [tool({ id: 't1', status: 'running', inputPreview: 'x' })],
    });
    const container = render({ session: { ...state, root: stalled, spawnEdges: [], parked: [] } });
    expect(nodeFor(container, 'root').dataset['status']).toBe('done');
    expect(pulsing(container)).toStrictEqual(['root']);
  });

  it('NEGATIVE CONTROL: everything done and the session ended -> zero pulses', () => {
    const settled = liveSession({ liveness: 'ended', root: settle(liveSession().root) });
    const container = render({ session: settled });
    // The control is only worth anything if there was something to animate.
    // Nodes and filaments, not dots: A8.1 removed the dots, so counting them
    // here would add zero and quietly weaken the control.
    expect(treeNodes(container).length).toBeGreaterThan(0);
    expect(filaments(container).length).toBeGreaterThan(0);
    expect(pulsing(container)).toStrictEqual([]);
    expect(animated(container)).toHaveLength(0);
  });

  it('never pulses a parked node — nothing is happening in it that we can see', () => {
    const container = render({ session: parkedSession() });
    const item = parkedNodes(container)[0] as HTMLElement;
    expect(all(item, 'tree-pulse')).toHaveLength(0);
    expect(animated(item)).toHaveLength(0);
  });

  it('SWAPS the pulse for a STATIC RING under prefers-reduced-motion', () => {
    const container = render({ session: liveSession(), reducedMotion: true });
    expect(one(container, TESTID.canvas).classList.contains(REDUCED_MOTION_CLASS)).toBe(true);
    // The ring is still drawn on every active node — the semantics survive.
    const rings = all(container, 'tree-pulse');
    expect(rings).toHaveLength(3);
    for (const ring of rings) {
      expect(ring.dataset['static']).toBe('true');
      expect(ring.classList.contains(ANIMATED_CLASSES[0])).toBe(false);
    }
    expect(pulsing(container)).toStrictEqual([]);
  });

  it('leaves the reduced-motion class off when the user did not ask for it', () => {
    const container = render({ session: liveSession() });
    expect(one(container, TESTID.canvas).classList.contains(REDUCED_MOTION_CLASS)).toBe(false);
    expect(all(container, 'tree-pulse')[0]?.dataset['static']).toBe('false');
  });

  it('carries the stylesheet rules the swap depends on', () => {
    // CSS cannot import a TypeScript constant, and Svelte PRUNES a scoped rule
    // it cannot prove is used — which would switch an animation off while
    // every DOM assertion above still passed.
    // `is-breathing` (the node) and `is-flowing` (the filament). NOT the whole
    // of `ANIMATED_CLASSES`: `is-pulsing` was the TOOL DOT's, and A8.1 removed
    // the dots, so this bundle no longer carries a rule for it. Narrowed to
    // what this surface actually animates rather than left iterating a list
    // whose third member nothing here can satisfy.
    for (const cls of [ANIMATED_CLASSES[0], ANIMATED_CLASSES[2]]) {
      expect(bundle).toContain(`.${cls}`);
    }
    expect(bundle).toContain(`.${REDUCED_MOTION_CLASS}`);
    expect(bundle).toContain('animation:');
  });

  it('animates nothing that is neither running nor active', () => {
    const container = render({ session: liveSession() });
    for (const el of animated(container)) {
      const owner = el.closest('[data-active], [data-status], [data-flowing]') as HTMLElement | null;
      const state =
        owner?.dataset['active'] ?? owner?.dataset['status'] ?? owner?.dataset['flowing'];
      expect(['running', 'true']).toContain(state);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * G3 — refused interiors render NOTHING
 * ------------------------------------------------------------------------ */

describe('refused sessions render no tree (C7.4, G3)', () => {
  /** Every interior element, by contract testid. Chrome is not interior. */
  const INTERIOR = [
    TESTID.nucleus,
    TESTID.cell,
    TESTID.filament,
    TESTID.parkedStub,
    TESTID.elidedBadge,
  ] as const;

  function interiorCount(root: ParentNode): number {
    return INTERIOR.reduce((n, id) => n + all(root, id).length, 0);
  }

  it('DIRECTION 1 — the session refuses itself (schemaOk false)', () => {
    const container = render({ session: unsupportedSession() });
    expect(one(container, TESTID.canvas).dataset['refused']).toBe('true');
    expect(interiorCount(container)).toBe(0);
    expect(container.querySelector('svg.field')).toBeNull();
    expect(one(container, 'tree-status').textContent).toContain('refused');
  });

  it('DIRECTION 2 — a schemaMismatch on a session the wire still calls live', () => {
    // The other refusal channel: `schemaOk` is true and the liveness says
    // `live`, so the layout would place the whole tree. The component refuses
    // independently, which is what makes the count 0 here too.
    const state = liveSession();
    expect(state.schemaOk).toBe(true);
    expect(treeLayout(state, state.root.id).length).toBeGreaterThan(0);
    const container = render({ session: state, refused: true });
    expect(one(container, TESTID.canvas).dataset['refused']).toBe('true');
    expect(interiorCount(container)).toBe(0);
  });

  it('refuses the parked rail too — a new surface is not a hole to leak through', () => {
    const container = render({ session: parkedSession(), refused: true });
    expect(interiorCount(container)).toBe(0);
    expect(all(container, 'parked-rail')).toHaveLength(0);
    expect(one(container, TESTID.canvas).dataset['parked']).toBe('0');
  });

  it('reports zero on every count attribute the panel reads', () => {
    const container = render({ session: unsupportedSession() });
    const canvas = one(container, TESTID.canvas);
    // `data-dots` was here and is gone with the dots (A8.1): an attribute that
    // could only ever read '0' is not a count the panel reports.
    expect([canvas.dataset['cells'], canvas.dataset['parked']]).toStrictEqual(['0', '0']);
  });

  it('draws the tree again as soon as the session is not refused', () => {
    const container = render({ session: liveSession() });
    expect(interiorCount(container)).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ *
 * G2 — degraded
 * ------------------------------------------------------------------------ */

describe('degraded — hooks silent (C7.3, G2)', () => {
  it('hollows an ACTIVE node’s box and only an active one', () => {
    const container = render({ session: liveSession(), degraded: true });
    expect(one(container, TESTID.canvas).dataset['degraded']).toBe('true');
    for (const node of treeNodes(container)) {
      expect(node.dataset['livenessInferred']).toBe(node.dataset['active']);
      expect(boxOf(node).classList.contains(HOLLOW_LIVE_CLASS)).toBe(
        node.dataset['active'] === 'true',
      );
    }

    const settled = render({
      session: liveSession({ root: settle(liveSession().root) }),
      degraded: true,
    });
    expect(
      [...settled.querySelectorAll('*')].filter((el) => el.classList.contains(HOLLOW_LIVE_CLASS)),
    ).toHaveLength(0);
  });

  it('hollows nothing while the hook tap is healthy', () => {
    const container = render({ session: liveSession(), degraded: false });
    expect(
      [...container.querySelectorAll('*')].filter((el) =>
        el.classList.contains(HOLLOW_LIVE_CLASS),
      ),
    ).toHaveLength(0);
  });

  it('still pulses an active node while degraded — inferred, not absent', () => {
    const container = render({ session: liveSession(), degraded: true });
    expect(animated(nodeFor(container, 'agent-1')).length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 7.4 — pan, zoom and fit, at all three views
 * ------------------------------------------------------------------------ */

describe('pan, zoom and fit (DoD 7.4)', () => {
  const SIZE = { width: 960, height: 640 };

  /**
   * Mount, focus down to `rootId`, and park the view at a KNOWN transform.
   *
   * It used to click Reset and assert the identity transform. A9.3 changed what
   * Reset means — it now re-roots on the session root and FITS, because
   * "reset" throwing the user at the stage origin with the root off-screen was
   * the defect that prompted the amendment — so the old helper both asserted a
   * behaviour that is gone AND undid the focus it had just set up.
   *
   * The view is left wherever the ENTRY FIT put it, which is the state a user
   * is actually in. These tests are about pan and zoom ARITHMETIC, which is a
   * delta, so the baseline only has to be KNOWN — `baseline()` reads it.
   */
  function view(state: SessionState, focus: readonly string[]): HTMLElement {
    const container = render({ session: state, size: SIZE });
    for (const id of focus) dblclick(nodeFor(container, id));
    return container;
  }

  /** Where the view sits right now — what every delta below is measured from. */
  function baseline(container: HTMLElement): { x: number; y: number; k: number } {
    return parseTransform(stageTransform(container));
  }

  /** `translate(x y) scale(k)` back into numbers. */
  function parseTransform(attr: string): { x: number; y: number; k: number } {
    const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(attr);
    if (m === null) throw new Error(`unparseable transform: ${attr}`);
    return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) };
  }

  const VIEWS: [string, string[]][] = [
    ['the tree', []],
    ['focus at depth 1', ['agent-1']],
    ['focus at depth 2', ['agent-1', 'agent-2']],
  ];

  for (const [name, focus] of VIEWS) {
    describe(name, () => {
      it('pans on a drag across the empty field', () => {
        const container = view(liveSession(), focus);
        const svg = field(container);
        const base = baseline(container);
        pointer(svg, 'pointerdown', 400, 300);
        pointer(svg, 'pointermove', 430, 280);
        expect(stageTransform(container)).toBe(transformAttr(panBy(base, 30, -20)));
        pointer(svg, 'pointerup', 430, 280);
        // The drag ended: further movement does not pan.
        pointer(svg, 'pointermove', 500, 500);
        expect(stageTransform(container)).toBe(transformAttr(panBy(base, 30, -20)));
      });

      it('zooms ABOUT THE CURSOR, through viewport.zoomAbout, at TREE_ZOOM_LIMITS', () => {
        const container = view(liveSession(), focus);
        const base = baseline(container);
        wheel(field(container), -100, 200, 100);
        expect(stageTransform(container)).toBe(
          transformAttr(zoomAbout(base, 200, 100, 1, TREE_ZOOM_LIMITS)),
        );
      });

      it('clamps at TREE_ZOOM_LIMITS rather than zooming forever', () => {
        const container = view(liveSession(), focus);
        const svg = field(container);
        for (let i = 0; i < 40; i += 1) wheel(svg, -100, 200, 100);
        expect(stageTransform(container)).toContain(`scale(${String(TREE_ZOOM_LIMITS.max)})`);
        for (let i = 0; i < 80; i += 1) wheel(svg, 100, 200, 100);
        expect(stageTransform(container)).toContain(`scale(${String(TREE_ZOOM_LIMITS.min)})`);
      });

      it('fits with 32 px of padding on a double-click on the empty field', () => {
        const state = liveSession();
        const container = view(state, focus);
        dblclick(field(container));
        const rootId = focus[focus.length - 1] ?? state.root.id;
        const placed = treeLayout(state, rootId).filter((p) => !p.hidden);
        expect(stageTransform(container)).toBe(
          transformAttr(
            fitTo(
              // `p.h`, not `NODE_H`: A9.2 made the box height per-node, and a
              // fit computed against a fixed 52 would frame a two-line node
              // 18 units short.
              boundsOf(placed.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }))),
              SIZE,
              TREE_FIT_PADDING,
              TREE_ZOOM_LIMITS,
            ),
          ),
        );
      });

      it('does not pan when the drag starts on a node', () => {
        const container = view(liveSession(), focus);
        const base = baseline(container);
        const node = one(container, TESTID.nucleus);
        pointer(node, 'pointerdown', 400, 300);
        pointer(field(container), 'pointermove', 460, 340);
        expect(stageTransform(container)).toBe(transformAttr(base));
      });
    });
  }

  it('the transform is a TRANSFORM: panning and zooming move no placement', () => {
    const state = liveSession();
    const container = render({ session: state, size: SIZE });
    const before = treeNodes(container).map((n) => boxOf(n).getAttribute('x'));
    const svg = field(container);
    pointer(svg, 'pointerdown', 400, 300);
    pointer(svg, 'pointermove', 480, 200);
    wheel(svg, -100, 300, 300);
    dblclick(svg);
    expect(treeNodes(container).map((n) => boxOf(n).getAttribute('x'))).toStrictEqual(before);
  });
});

/* ------------------------------------------------------------------------ *
 * C7.8 — accessibility floor
 * ------------------------------------------------------------------------ */

describe('accessibility floor (C7.8)', () => {
  it('makes every node a real focusable control with a name', () => {
    // WAS "every node and dot". A8.1 removed the dots; the assertion is
    // narrowed to what exists rather than left spreading over an empty array,
    // which would have kept passing while covering half of what it named.
    const container = render({ session: liveSession() });
    const controls = [...treeNodes(container)];
    expect(controls.length).toBeGreaterThan(0);
    for (const el of controls) {
      expect(el.getAttribute('role')).toBe('button');
      expect(el.getAttribute('tabindex')).toBe('0');
      expect(el.getAttribute('aria-label')).not.toBe(null);
      expect(el.getAttribute('aria-label')).not.toBe('');
      el.focus();
      expect(document.activeElement).toBe(el);
    }
  });

  it('reports the node id on click, every time', () => {
    const picked: string[] = [];
    const container = render({
      session: liveSession(),
      onselect: (id: string) => picked.push(id),
    });
    click(nodeFor(container, 'agent-1'));
    click(nodeFor(container, 'agent-1'));
    expect(picked).toStrictEqual(['agent-1', 'agent-1']);
  });

  /*
   * `reports the TOOL id when a dot is picked` stood here. A8.1 removed the
   * dots, so a tool call is no longer selectable from the canvas at all — it is
   * selected in §8.6's drawer, whose call rows are covered by
   * `inspector.test.ts`. Deleted rather than skipped, for the reason the A8.1
   * describe above gives.
   */

  for (const key of ['Enter', ' ']) {
    it(`selects on ${key === ' ' ? 'Space' : key}`, () => {
      const picked: string[] = [];
      const container = render({
        session: liveSession(),
        onselect: (id: string) => picked.push(id),
      });
      const event = press(nodeFor(container, 'agent-1'), key);
      expect(picked).toStrictEqual(['agent-1']);
      expect(event.defaultPrevented).toBe(true);
    });
  }

  it('ignores keys that are neither an activation nor a navigation', () => {
    const picked: string[] = [];
    const container = render({
      session: liveSession(),
      onselect: (id: string) => picked.push(id),
    });
    press(nodeFor(container, 'agent-1'), 'a');
    press(nodeFor(container, 'agent-1'), 'ArrowDown');
    expect(picked).toStrictEqual([]);
    expect(one(container, TESTID.canvas).dataset['rootId']).toBe('root');
  });

  it('does not throw when no handler is wired', () => {
    const container = render({ session: liveSession() });
    expect(() => click(nodeFor(container, 'agent-1'))).not.toThrow();
    expect(() => dblclick(nodeFor(container, 'agent-1'))).not.toThrow();
  });

  it('carries a focus-ring rule rather than relying on the browser default', () => {
    expect(bundle).toContain(':focus-visible');
    expect(bundle).toContain('--vscode-focusBorder');
  });
});

/* ------------------------------------------------------------------------ *
 * Source-level guards
 * ------------------------------------------------------------------------ */

describe('the node is not draggable (DoD)', () => {
  it('AgentCell.svelte carries no drag handler and no drag state', () => {
    // A node's position is `treeLayout`'s answer and nothing else's. A drag
    // handler here would edit a placement, which breaks layout purity, the
    // goldens, and "a spawn adds, it never reflows" — all three silently.
    const source = componentSources.find((c) => c.path === 'webview/AgentCell.svelte');
    expect(source).toBeDefined();
    const hits = (source?.text.match(/ondrag|dragging/g) ?? []).length;
    expect(hits).toBe(0);
  });

  it('nothing on this surface computes a golden-angle spiral any more', () => {
    // THE NEEDLE IS ASSEMBLED, not written out, and that is not decoration:
    // the standing check on this package is that `grep -r` for that identifier
    // over `webview/` returns 0, and a test file spelling it would make the
    // grep return 1 forever — a guard that breaks the thing it guards.
    const needle = ['GOLDEN', 'ANGLE'].join('_');
    for (const { path, text } of componentSources) {
      expect({ path, hit: text.includes(needle) }).toStrictEqual({ path, hit: false });
    }
  });

  it('takes its zoom arithmetic from viewport.ts rather than restating it', () => {
    // The recorded defect: two viewports, internally consistent, disagreeing
    // at the seam, with nothing failing. The zoom factor and the limits are
    // named imports; a component spelling either as a literal is the seam
    // coming back.
    const canvas = componentSources.find((c) => c.path === 'webview/SessionCanvas.svelte');
    expect(canvas?.text).toContain("from './viewport.js'");
    expect(canvas?.text).toContain('zoomAbout');
    expect(canvas?.text).toContain('TREE_ZOOM_LIMITS');
    expect((canvas?.text.match(/1\.1\s*\*\*|\*\s*1\.1|\/\s*1\.1/g) ?? []).length).toBe(0);
  });
});

describe('theming (C7.7)', () => {
  it('hardcodes no colour anywhere in the four components', () => {
    expect(componentSources).toHaveLength(OWNED_COMPONENTS.length);
    for (const { path, text } of componentSources) {
      const hexes = text.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect({ path, hexes }).toStrictEqual({ path, hexes: [] });
      const functional = text.match(/\b(?:rgba?|hsla?)\s*\(/g) ?? [];
      expect({ path, functional }).toStrictEqual({ path, functional: [] });
    }
  });

  it('takes every colour it does use from a --vscode variable', () => {
    for (const { path, text } of componentSources) {
      const style = text.slice(text.indexOf('<style>'));
      const colourProps = style.match(/(?:^|\n)\s*(?:fill|stroke|color|background):[^;]+;/g) ?? [];
      for (const decl of colourProps) {
        if (/:\s*(?:none|inherit|transparent|currentColor)\s*;/.test(decl)) continue;
        expect({ path, decl }).toStrictEqual({ path, decl: expect.stringContaining('--vscode-') });
      }
    }
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 7.4, the half a standalone mount cannot reach: a real store update
 * ------------------------------------------------------------------------ */

describe('the transform survives a store update (DoD 7.4)', () => {
  let app: WebviewHarness;

  beforeAll(async () => {
    app = await loadHarness();
  }, 120_000);

  interface Panel {
    container: HTMLElement;
    store: ReturnType<WebviewHarness['createStore']>;
  }

  const panels: (() => void)[] = [];

  function panel(): Panel {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const started = app.start(container, { postMessage: () => {} });
    panels.push(() => {
      started.dispose();
      container.remove();
    });
    return { container, store: started.store };
  }

  afterEach(() => {
    while (panels.length > 0) panels.pop()?.();
  });

  it('pans, zooms, takes a diff, and does not move', () => {
    const { container, store } = panel();
    app.flushSync(() => {
      store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    });
    app.flushSync(() => {
      store.enterSession('session-live');
    });

    const svg = container.querySelector('svg.field');
    expect(svg).not.toBeNull();
    const stage = one(container, TESTID.canvasStage);
    const beforeGesture = stage.getAttribute('transform');

    app.flushSync(() => {
      (svg as Element).dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: 400, clientY: 300, button: 0 }),
      );
      (svg as Element).dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 437, clientY: 271, button: 0 }),
      );
      (svg as Element).dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 200, clientY: 100 }),
      );
    });

    const framed = stage.getAttribute('transform');
    // The gesture did something. Compared against the transform BEFORE it, not
    // against the identity: entering a session now fits, so the view is
    // already non-identity and an identity comparison would pass without the
    // gesture having done anything at all.
    expect(framed).not.toBe(beforeGesture);

    app.flushSync(() => {
      store.handleMessage({
        type: 'diff',
        sessionId: 'session-live',
        patch: { tree: [{ op: 'updateAgent', id: 'agent-2', fields: { status: 'done' } }] },
      });
    });

    // The diff LANDED — otherwise "the transform did not move" would be a
    // statement about a render that never happened.
    expect(nodeFor(container, 'agent-2').dataset['status']).toBe('done');
    expect(one(container, TESTID.canvasStage).getAttribute('transform')).toBe(framed);
  });

  it('keeps the focus root across a diff too', () => {
    const { container, store } = panel();
    app.flushSync(() => {
      store.handleMessage({ type: 'snapshot', sessions: [liveSession()] });
    });
    app.flushSync(() => {
      store.enterSession('session-live');
    });
    app.flushSync(() => {
      nodeFor(container, 'agent-1').dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
      );
    });
    expect(one(container, TESTID.canvas).dataset['rootId']).toBe('agent-1');

    app.flushSync(() => {
      store.handleMessage({
        type: 'diff',
        sessionId: 'session-live',
        patch: { tree: [{ op: 'updateAgent', id: 'agent-2', fields: { status: 'error' } }] },
      });
    });
    expect(nodeFor(container, 'agent-2').dataset['status']).toBe('error');
    expect(one(container, TESTID.canvas).dataset['rootId']).toBe('agent-1');
  });
});

/* ------------------------------------------------------------------------ *
 * Widths come from the layout, never from a measurement
 * ------------------------------------------------------------------------ */

describe('width is the layout’s, and it is a function of the TEXT', () => {
  it('draws each box at nodeWidth(agent), floor NODE_W_MIN', () => {
    const state = liveSession();
    const container = render({ session: state });
    for (const a of agentsOf(state)) {
      expect(Number(boxOf(nodeFor(container, a.id)).getAttribute('width'))).toBe(nodeWidth(a));
      expect(Number(boxOf(nodeFor(container, a.id)).getAttribute('width'))).toBeGreaterThanOrEqual(
        NODE_W_MIN,
      );
    }
  });

  it('widens for a long label rather than letting the text run out of the box', () => {
    const wide = agent({
      id: 'root',
      kind: 'main',
      label: 'a-very-long-agent-label-indeed',
      spawnDepth: 0,
      children: [],
    });
    const narrow = agent({ id: 'root', kind: 'main', label: 'x', spawnDepth: 0, children: [] });
    const a = render({ session: liveSession({ root: wide, spawnEdges: [], parked: [] }) });
    const b = render({ session: liveSession({ root: narrow, spawnEdges: [], parked: [] }) });
    expect(Number(boxOf(nodeFor(a, 'root')).getAttribute('width'))).toBeGreaterThan(
      Number(boxOf(nodeFor(b, 'root')).getAttribute('width')),
    );
    // ...and NOTHING IS ELIDED (A9.1): the label wraps onto a second row and
    // the two rows rejoin to the whole string. It asserted a `LABEL_MAX_CHARS`
    // truncation here until 2026-08-29.
    const rejoined = `${row1(nodeFor(a, 'root'))}${row2Label(nodeFor(a, 'root'))}`;
    expect(rejoined).toBe('a-very-long-agent-label-indeed');
    expect(row1(nodeFor(a, 'root')).endsWith('…')).toBe(false);
  });
});
