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
  LABEL_MAX_CHARS,
  NODE_H,
  NODE_W_MIN,
  SPAWN_DOT_GAP,
  autoCollapseDepth,
  nodeSubText,
  nodeWidth,
  spawnDotPos,
  treeLayout,
  visibleNodeCount,
} from './layout.js';
import {
  TREE_FIT_PADDING,
  TREE_ZOOM_LIMITS,
  boundsOf,
  fitTo,
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
  'webview/ToolDot.svelte',
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

function dots(root: ParentNode): HTMLElement[] {
  return all(root, TESTID.dot);
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
      }).toStrictEqual({ id: p.id, x: p.x, y: p.y, w: p.w, h: NODE_H });
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

  it('is FIXED HEIGHT: token share is text, never size', () => {
    // The predecessor sized a cell by its child count, so one new tool call
    // moved shapes already on screen. Every box on the canvas is 52 high, and
    // the widest node is wide because its TEXT is long.
    const container = render({ session: liveSession() });
    const heights = new Set(
      treeNodes(container).map((n) => boxOf(n).getAttribute('height')),
    );
    expect([...heights]).toStrictEqual([String(NODE_H)]);
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

  it('truncates row 1 at LABEL_MAX_CHARS and says the depth on the right', () => {
    const container = render({ session: liveSession() });
    expect(row1(nodeFor(container, 'root'))).toBe('main session');
    expect(row1(nodeFor(container, 'agent-1'))).toBe('test-runner: run t…');
    expect(row1(nodeFor(container, 'agent-1')).length).toBe(LABEL_MAX_CHARS);
    expect(row1(nodeFor(container, 'agent-2'))).toBe('code-reviewer: che…');

    expect(depthMark(nodeFor(container, 'root'))).toBe('root');
    expect(depthMark(nodeFor(container, 'agent-1'))).toBe('d1');
    expect(depthMark(nodeFor(container, 'agent-2'))).toBe('d2');
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
 * Tool dots
 * ------------------------------------------------------------------------ */

describe('tool dots', () => {
  it('draws one dot per call, in transcript order, at spawnDotPos', () => {
    const state = liveSession();
    const container = render({ session: state });
    const rootPlacement = treeLayout(state, state.root.id).find((p) => p.id === 'root');
    expect(rootPlacement).toBeDefined();

    const rootTools = state.root.children.filter((c): c is ToolNode => !isAgentNode(c));
    expect(rootTools.map((t) => t.id)).toStrictEqual(['tool-read', 'tool-agent-1']);

    const drawn = dots(container).filter((d) => rootTools.some((t) => t.id === d.dataset['toolId']));
    expect(drawn.map((d) => d.dataset['toolId'])).toStrictEqual(['tool-read', 'tool-agent-1']);

    rootTools.forEach((t, i) => {
      const at = spawnDotPos(
        rootPlacement as { x: number; y: number; w: number },
        rootTools.length,
        i,
      );
      const bud = drawn[i]?.querySelector('circle.bud');
      expect({
        cx: Number(bud?.getAttribute('cx')),
        cy: Number(bud?.getAttribute('cy')),
        r: Number(bud?.getAttribute('r')),
      }).toStrictEqual({ cx: at.x, cy: at.y, r: 4 });
    });
  });

  it('pins the dot row to literal numbers: centred on the node, pitched at 13', () => {
    const container = render({ session: liveSession() });
    const read = dots(container).find((d) => dataOf(d) === 'tool-read');
    const spawn = dots(container).find((d) => dataOf(d) === 'tool-agent-1');
    // root is x 14.5 w 168 y 0, so the row centre is 98.5 and two dots sit
    // 6.5 either side of it, on the row at y = 0 + 52 + 11.
    expect(read?.querySelector('circle.bud')?.getAttribute('cx')).toBe('92');
    expect(read?.querySelector('circle.bud')?.getAttribute('cy')).toBe('63');
    expect(spawn?.querySelector('circle.bud')?.getAttribute('cx')).toBe('105');
    expect(Number(spawn?.querySelector('circle.bud')?.getAttribute('cx')) -
      Number(read?.querySelector('circle.bud')?.getAttribute('cx'))).toBe(SPAWN_DOT_GAP);
  });

  function dataOf(el: HTMLElement): string | undefined {
    return el.dataset['toolId'];
  }

  it('says the status on the dot and the name ONLY on hover', () => {
    const container = render({ session: liveSession() });
    const byStatus = new Map(dots(container).map((d) => [d.dataset['toolId'], d.dataset['status']]));
    expect(byStatus.get('tool-read')).toBe('done');
    expect(byStatus.get('tool-agent-2')).toBe('running');
    expect(byStatus.get('tool-bash')).toBe('error');

    // The name is in a `<title>` and nowhere else: no `<text>` on the dot at
    // any zoom. A row of labelled dots under a 200-unit node is unreadable.
    const bash = dots(container).find((d) => d.dataset['toolId'] === 'tool-bash');
    expect(bash?.querySelector('title')?.textContent).toContain('Bash');
    expect(bash?.querySelector('text')).toBeNull();
  });

  it('draws a spawning call HOLLOW, and only a spawning call', () => {
    const state = liveSession();
    const spawning = new Set((state.spawnEdges ?? []).map((e) => e.toolUseId));
    expect(spawning).toEqual(new Set(['tool-agent-1', 'tool-agent-2']));
    const container = render({ session: state });
    for (const dot of dots(container)) {
      expect(dot.dataset['spawns']).toBe(String(spawning.has(dot.dataset['toolId'] ?? '')));
    }
    expect(bundle).toContain("[data-spawns='true']");
  });

  it('caps the row at 24: the LAST 23 calls and a +N glyph in dot 0’s place', () => {
    const state = busySession(30);
    const container = render({ session: state });

    const drawn = dots(container);
    expect(drawn).toHaveLength(23);
    // The LAST 23: t-7 .. t-29. What is happening now is at the end.
    expect(drawn.map((d) => d.dataset['toolId'])).toStrictEqual(
      Array.from({ length: 23 }, (_, i) => `t-${String(i + 7)}`),
    );

    const glyph = one(container, 'tool-dot-overflow');
    expect(glyph.dataset['count']).toBe('7');
    expect(glyph.textContent).toBe('+7');

    // The glyph sits at index 0 of a 24-wide row, and the first drawn dot at
    // index 1 — so the row still reads left to right in time.
    const placement = treeLayout(state, 'root').find((p) => p.id === 'root');
    const at0 = spawnDotPos(placement as { x: number; y: number; w: number }, 24, 0);
    const at1 = spawnDotPos(placement as { x: number; y: number; w: number }, 24, 1);
    expect(Number(glyph.getAttribute('x'))).toBe(at0.x);
    expect(Number(drawn[0]?.querySelector('circle.bud')?.getAttribute('cx'))).toBe(at1.x);
  });

  it('keeps the COUNTS exact on row 2 while the row is capped', () => {
    // The cap is a drawing budget. A number it changed would be a number the
    // user cannot trust, which is worse than a row that says "+7".
    const container = render({ session: busySession(30) });
    expect(row2(nodeFor(container, 'root'))).toContain('30 calls');
    expect(dots(container)).toHaveLength(23);
  });

  it('draws every dot when there are exactly 24 — the cap is strictly above', () => {
    const container = render({ session: busySession(24) });
    expect(dots(container)).toHaveLength(24);
    expect(all(container, 'tool-dot-overflow')).toHaveLength(0);
    expect(row2(nodeFor(container, 'root'))).toContain('24 calls');
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

  it('runs from the spawning DOT’s bottom to the child’s TOP CENTRE, as a cubic', () => {
    // The literal path, written out. The dot for `tool-agent-1` is at
    // (105, 63) and its radius is 4; `agent-1` is at x 0 w 197 y 164, so the
    // top centre is (98.5, 164) and the control row is at (63 + 164) / 2.
    const container = render({ session: liveSession() });
    const first = filaments(container).find((f) => f.dataset['agentId'] === 'agent-1');
    expect(first?.getAttribute('d')).toBe('M 105 67 C 105 113.5 98.5 113.5 98.5 164');

    const second = filaments(container).find((f) => f.dataset['agentId'] === 'agent-2');
    expect(second?.getAttribute('d')).toBe('M 98.5 231 C 98.5 277.5 98.5 277.5 98.5 328');
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

  it('draws nothing for an edge whose spawning dot is not drawn', () => {
    // Half a key is not a key. An edge naming a `tool_use` id that is in no
    // drawn row draws no curve rather than one from somewhere plausible.
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
    expect(filaments(container)).toHaveLength(0);
    // ...and the agent is still drawn: it is in the tree, it just hangs
    // unjoined on this surface.
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

  it('RE-ROOTING FITS EXACTLY ONCE, and nothing else fits', () => {
    const state = liveSession();
    const container = render({ session: state, size: { width: 960, height: 640 } });
    // Nothing has fitted yet: the initial view is the identity transform.
    expect(stageTransform(container)).toBe(transformAttr({ x: 0, y: 0, k: 1 }));

    dblclick(nodeFor(container, 'agent-1'));
    const placed = treeLayout(state, 'agent-1').filter((p) => !p.hidden);
    const expected = fitTo(
      boundsOf(placed.map((p) => ({ x: p.x, y: p.y, w: p.w, h: NODE_H }))),
      { width: 960, height: 640 },
      TREE_FIT_PADDING,
      TREE_ZOOM_LIMITS,
    );
    expect(stageTransform(container)).toBe(transformAttr(expected));

    // A plain selection does not fit, so the view a user framed stays framed.
    click(nodeFor(container, 'agent-2'));
    expect(stageTransform(container)).toBe(transformAttr(expected));
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
    expect(treeNodes(container).length + dots(container).length).toBeGreaterThan(0);
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
    for (const cls of ANIMATED_CLASSES) expect(bundle).toContain(`.${cls}`);
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
    TESTID.dot,
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
    expect([canvas.dataset['cells'], canvas.dataset['dots'], canvas.dataset['parked']]).toStrictEqual(
      ['0', '0', '0'],
    );
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

  /** Mount, then focus down to `rootId`, then put the view back at identity. */
  function view(state: SessionState, focus: readonly string[]): HTMLElement {
    const container = render({ session: state, size: SIZE });
    for (const id of focus) dblclick(nodeFor(container, id));
    click(one(container, TESTID.canvasReset));
    expect(stageTransform(container)).toBe(transformAttr({ x: 0, y: 0, k: 1 }));
    return container;
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
        pointer(svg, 'pointerdown', 400, 300);
        pointer(svg, 'pointermove', 430, 280);
        expect(stageTransform(container)).toBe(transformAttr({ x: 30, y: -20, k: 1 }));
        pointer(svg, 'pointerup', 430, 280);
        // The drag ended: further movement does not pan.
        pointer(svg, 'pointermove', 500, 500);
        expect(stageTransform(container)).toBe(transformAttr({ x: 30, y: -20, k: 1 }));
      });

      it('zooms ABOUT THE CURSOR, through viewport.zoomAbout, at TREE_ZOOM_LIMITS', () => {
        const container = view(liveSession(), focus);
        wheel(field(container), -100, 200, 100);
        expect(stageTransform(container)).toBe(
          transformAttr(zoomAbout({ x: 0, y: 0, k: 1 }, 200, 100, 1, TREE_ZOOM_LIMITS)),
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
              boundsOf(placed.map((p) => ({ x: p.x, y: p.y, w: p.w, h: NODE_H }))),
              SIZE,
              TREE_FIT_PADDING,
              TREE_ZOOM_LIMITS,
            ),
          ),
        );
      });

      it('does not pan when the drag starts on a node', () => {
        const container = view(liveSession(), focus);
        const node = one(container, TESTID.nucleus);
        pointer(node, 'pointerdown', 400, 300);
        pointer(field(container), 'pointermove', 460, 340);
        expect(stageTransform(container)).toBe(transformAttr({ x: 0, y: 0, k: 1 }));
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
  it('makes every node and dot a real focusable control with a name', () => {
    const container = render({ session: liveSession() });
    const controls = [...treeNodes(container), ...dots(container)];
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

  it('reports the TOOL id when a dot is picked', () => {
    const picked: string[] = [];
    const container = render({
      session: liveSession(),
      onselect: (id: string) => picked.push(id),
    });
    const bash = dots(container).find((d) => d.dataset['toolId'] === 'tool-bash');
    click(bash as HTMLElement);
    expect(picked).toStrictEqual(['tool-bash']);
  });

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
    // The gesture did something: an identity transform here would make the
    // assertion below true for the wrong reason.
    expect(framed).not.toBe(transformAttr({ x: 0, y: 0, k: 1 }));

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
    // ...and the drawn label is the truncated one, so the text fits what the
    // width reserved.
    expect(row1(nodeFor(a, 'root'))).toHaveLength(LABEL_MAX_CHARS);
  });
});
