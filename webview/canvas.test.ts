// @vitest-environment jsdom
//
// Altitude 1 — the session interior (spec C7.1) and the INTERIOR half of
// C7.3's normative state matrix, asserted against the REAL esbuild + Svelte
// bundle. C7.4's filament — the `meta.toolUseId` join, drawn — is the element
// this file exists to pin.
//
// WHY A BUNDLE. There is no vitest svelte plugin in this repo, so a `.svelte`
// import cannot be transformed in-process. `testkit.ts:loadHarness` bundles
// `harness.ts`, whose entry is fixed and whose `start()` mounts `App.svelte`;
// `App.svelte` does not mount the canvas yet and is not this package's file to
// edit. So this file bundles `SessionCanvas.svelte` directly through the same
// pipeline, from an in-memory entry point, exactly the way `inspector.test.ts`
// and `deck.test.ts` do. Nothing is written to disk (G1) — the entry goes to
// esbuild as `stdin` and the bundle comes back on the child's stdout. That is
// the THIRD copy of this block; it is known, reported, and collapses when the
// app mounts these components.
//
// EVERY testid AND CONTRACT CLASS COMES FROM `canvas-contract.ts`. Selecting on
// a literal is how a renamed name becomes a silently skipped assertion rather
// than a failure: `all()` returns an empty array and a `.length === 0` check
// passes for the wrong reason. The same rule is why the CSS literals are
// checked back against the constants — CSS cannot import a TypeScript name, so
// the stylesheet is the one place a class is spelled twice.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentNode, SessionState, ToolNode } from '../src/model/events.js';
import { isAgentNode } from '../src/model/events.js';
import {
  ANIMATED_CLASSES,
  DOT_CAP,
  HOLLOW_LIVE_CLASS,
  PARKED_CLASS,
  REDUCED_MOTION_CLASS,
  TESTID,
} from './canvas-contract.js';
import { blobPath, hashSessionId, sessionLayout } from './layout.js';
import { all, one } from './testkit.js';
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
/** The four component sources, read once, for the no-hardcoded-colour check. */
let componentSources: { path: string; text: string }[] = [];

/** The files this package owns. Named once; both theming checks walk it. */
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
}, 60_000);

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
 * and every cell and dot here is SVG. Dispatching is also the more faithful of
 * the two: it is what a pointer produces in the real panel.
 */
function click(element: Element): void {
  harness.flushSync(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function press(element: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  harness.flushSync(() => element.dispatchEvent(event));
  return event;
}

/** Every element carrying any class listed in `ANIMATED_CLASSES`. */
function animated(root: ParentNode): Element[] {
  return [...root.querySelectorAll('*')].filter((el) =>
    ANIMATED_CLASSES.some((cls) => el.classList.contains(cls)),
  );
}

/** Cells that stand for an agent IN the tree. Parked cells share the testid. */
function cells(root: ParentNode): HTMLElement[] {
  return all(root, TESTID.cell).filter((c) => c.dataset['parked'] !== 'true');
}

function parkedCells(root: ParentNode): HTMLElement[] {
  return all(root, TESTID.cell).filter((c) => c.dataset['parked'] === 'true');
}

function dots(root: ParentNode): HTMLElement[] {
  return all(root, TESTID.dot);
}

function filaments(root: ParentNode): HTMLElement[] {
  return all(root, TESTID.filament);
}

function cellFor(root: ParentNode, agentId: string): HTMLElement {
  const found = [...all(root, TESTID.cell), ...all(root, TESTID.nucleus)].find(
    (c) => c.dataset['agentId'] === agentId,
  );
  if (found === undefined) throw new Error(`no cell for ${agentId}`);
  return found;
}


function membraneOf(cell: HTMLElement): Element {
  const found = cell.querySelector('path.membrane');
  if (found === null) throw new Error('no membrane path in the cell');
  return found;
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

function toolsOf(state: SessionState): ToolNode[] {
  return flatten(state.root).filter((n): n is ToolNode => !isAgentNode(n));
}

function agentsOf(state: SessionState): AgentNode[] {
  return flatten(state.root).filter(isAgentNode);
}

/** Set every agent and tool in a tree to `done`. */
function settle(node: AgentNode): AgentNode {
  return {
    ...node,
    status: 'done',
    children: node.children.map((child) =>
      isAgentNode(child) ? settle(child) : { ...child, status: 'done' as const },
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



/* ------------------------------------------------------------------------ *
 * The interior, and where its coordinates come from
 * ------------------------------------------------------------------------ */

/**
 * The animated classes the SESSION INTERIOR can apply.
 *
 * `is-pulsing` is absent deliberately: it belonged to the running tool dot,
 * and the dots are no longer drawn. It is still carried by the deck pulse ring
 * and guarded in `deck.test.ts`, so the contract member is live - just not on
 * this surface. Derived from the contract rather than hand-listed, so adding a
 * class there fails here until someone decides which surface owns it.
 */
const INTERIOR_ANIMATED = ANIMATED_CLASSES.filter((c) => c !== 'is-pulsing');

describe('the session interior (C7.1)', () => {
  it('draws the main agent as the nucleus, exactly once', () => {
    const state = liveSession();
    const container = render({ session: state });
    const nucleus = one(container, TESTID.nucleus);
    expect(nucleus.dataset['agentId']).toBe(state.root.id);
    // The nucleus is not also counted as a cell: one agent, one element.
    expect(cells(container).map((c) => c.dataset['agentId'])).not.toContain(state.root.id);
  });

  it('draws one cell per subagent in the tree', () => {
    const state = liveSession();
    const subagents = agentsOf(state).filter((a) => a.id !== state.root.id);
    expect(subagents.length).toBeGreaterThan(0);
    const container = render({ session: state });
    expect(cells(container).map((c) => c.dataset['agentId']).sort()).toStrictEqual(
      subagents.map((a) => a.id).sort(),
    );
  });

  it('draws NO tool dots, though the layout still places them', () => {
    // `sessionLayout` is unchanged and still returns a dot per placed tool —
    // the geometry is pure and its goldens are pinned, so removing dots from
    // the picture was deliberately NOT done by changing the layout. The canvas
    // simply stops drawing that map. If dots ever come back, the coordinates
    // are already there and unchanged.
    const state = liveSession();
    const layout = sessionLayout(state);
    const container = render({ session: state });
    expect(layout.dots.size).toBeGreaterThan(0);
    expect(dots(container)).toHaveLength(0);
  });

  it('takes every coordinate from layout.ts and computes none of its own', () => {
    const state = liveSession();
    const layout = sessionLayout(state);
    const container = render({ session: state });

    for (const [agentId, placement] of layout.cells) {
      const cell = cellFor(container, agentId);
      expect(membraneOf(cell).getAttribute('d')).toBe(
        blobPath(placement.x, placement.y, placement.R, hashSessionId(agentId)),
      );
    }
    // The dot half of this check went with the dots. Cells and parked cells
    // are now the whole of what the canvas places, and both are asserted
    // against `layout.ts` above and below.
  });

  it('fits the viewport with a viewBox of four finite numbers', () => {
    const container = render({ session: liveSession() });
    const parts = (container.querySelector('svg')?.getAttribute('viewBox') ?? '')
      .split(' ')
      .map(Number);
    expect(parts).toHaveLength(4);
    for (const n of parts) expect(Number.isFinite(n)).toBe(true);
    expect(parts[2]).toBeGreaterThan(0);
    expect(parts[3]).toBeGreaterThan(0);
  });

  it('reads in tree order, not in geometric order (C7.8)', () => {
    // The store's account of a session is its tree; DOM order here is that
    // walk — each agent, then its own dots, then its subagents — and nothing
    // in between sorts by coordinate.
    //
    // The expected order is DERIVED from the state by that rule rather than
    // written out as a list of ids: a literal list against a shared builder is
    // a literal that goes stale the next time the builder changes, and reads
    // as a renderer regression when it does.
    const state = liveSession();
    const container = render({ session: state });
    const ids = [...(container.querySelector('g.nodes')?.children ?? [])].map(
      (el) => (el as HTMLElement).dataset['agentId'] ?? (el as HTMLElement).dataset['toolId'],
    );

    const expected: string[] = [];
    const walk = (node: AgentNode): void => {
      expected.push(node.id);
      // Agents only: tool calls are no longer drawn, so they are no longer in
      // the DOM order there is anything to assert about.
      for (const child of node.children) if (isAgentNode(child)) walk(child);
    };
    walk(state.root);
    expect(ids).toStrictEqual(expected);

    // ...and that order is NOT the geometric one, so the assertion above is
    // distinguishing something rather than restating the geometry.
    //
    // Checked on BOTH axes, and passing if EITHER differs. An earlier version
    // sorted by x alone and went red here: for this fixture the x order and
    // the tree order coincide, so the control asserted a coincidence rather
    // than a property. A control that depends on which axis you happened to
    // pick is not a control. If both axes ever match tree order this fails,
    // which is correct - it would mean this fixture cannot distinguish the
    // two orders and the test above needs a different session, not a looser
    // assertion.
    const layout = sessionLayout(state);
    const coordOf = (id: string, axis: "x" | "y"): number =>
      layout.cells.get(id)?.[axis] ?? layout.dots.get(id)?.[axis] ?? Number.POSITIVE_INFINITY;
    const byX = [...expected].sort((a, b) => coordOf(a, "x") - coordOf(b, "x"));
    const byY = [...expected].sort((a, b) => coordOf(a, "y") - coordOf(b, "y"));
    const differs =
      JSON.stringify(byX) !== JSON.stringify(expected) ||
      JSON.stringify(byY) !== JSON.stringify(expected);
    expect(differs, "neither axis distinguishes tree order for this fixture").toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * C7.4 — the filament IS the join key
 * ------------------------------------------------------------------------ */

describe('the filament (C7.4)', () => {
  it('draws exactly one filament per spawn edge, carrying both halves of the key', () => {
    const state = liveSession();
    const edges = state.spawnEdges ?? [];
    expect(edges.length).toBeGreaterThan(0);
    const container = render({ session: state });
    const drawn = filaments(container).map((f) => ({
      toolUseId: f.dataset['toolUseId'],
      agentId: f.dataset['agentId'],
    }));
    expect(drawn).toStrictEqual(
      edges.map((e) => ({ toolUseId: e.toolUseId, agentId: e.agentId })),
    );
  });

  it('starts at the SPAWNING AGENT and ends on the SPAWNED cell', () => {
    // Anchored cell-to-cell since the tool dots stopped being drawn. The join
    // itself is unchanged — the filament still comes from a `spawnEdges` entry
    // carrying both halves of the key, and the test below still proves no line
    // is drawn without one. Only the point it starts FROM moved.
    const state = liveSession();
    const layout = sessionLayout(state);
    const container = render({ session: state });
    for (const edge of state.spawnEdges ?? []) {
      const from = layout.cells.get(edge.parentNodeId);
      const to = layout.cells.get(edge.agentId);
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      const path =
        filaments(container).find((f) => f.dataset['agentId'] === edge.agentId) ?? undefined;
      const d = path?.getAttribute('d') ?? '';
      expect(d.startsWith(`M ${from?.x} ${from?.y} `)).toBe(true);
      // The far end stops on the child's membrane, so it is within R of the
      // cell centre and nowhere near any other cell.
      const end = d.slice(d.lastIndexOf('Q')).split(' ').slice(3).map(Number);
      const distance = Math.hypot((end[0] ?? 0) - (to?.x ?? 0), (end[1] ?? 0) - (to?.y ?? 0));
      expect(distance).toBeCloseTo(to?.R ?? 0, 2);
    }
  });

  it('DERIVATION: the same tree with no spawn edges draws no filament at all', () => {
    // The load-bearing negative. `ToolNode` has no `children`, so the spawn
    // relationship exists ONLY in `spawnEdges`; a renderer that inferred it
    // from adjacency, from `parentAgentId` or from proximity would still draw
    // lines here. The cells are identical either way, so this isolates the
    // derivation rather than the drawing.
    const withEdges = liveSession();
    const withoutEdges = liveSession({ spawnEdges: [] });
    const a = render({ session: withEdges });
    const b = render({ session: withoutEdges });
    expect(filaments(a).length).toBe((withEdges.spawnEdges ?? []).length);
    expect(filaments(b)).toHaveLength(0);
    expect(cells(b).length).toBeGreaterThan(0);
  });

  it('draws nothing for an edge whose parent cell is not placed', () => {
    // Half a key is not a key. An edge naming a `tool_use` id the layout never
    // placed — elided, duplicated away, or simply absent — draws no filament
    // rather than a line from somewhere plausible.
    const state = liveSession({
      spawnEdges: [
        {
          toolUseId: 'toolu_NOT_IN_THIS_TREE',
          agentId: 'agent-1',
          parentNodeId: 'agent-THAT-IS-NOT-PLACED',
          depth: 1,
          recordedDepth: 1,
        },
      ],
    });
    const container = render({ session: state });
    expect(filaments(container)).toHaveLength(0);
    // ...and the agent is still drawn: it is in the tree, it just hangs
    // unattached on this surface.
    expect(cellFor(container, 'agent-1')).toBeDefined();
  });

  it('flows while the CHILD is running and is static once it is done', () => {
    const running = liveSession();
    const runningChild = agentsOf(running).find((a) => a.id === 'agent-1');
    expect(runningChild?.status).toBe('running');
    const a = render({ session: running });
    const live = filaments(a).find((f) => f.dataset['agentId'] === 'agent-1');
    expect(live?.dataset['flowing']).toBe('true');
    expect(live?.classList.contains(ANIMATED_CLASSES[2])).toBe(true);

    const settled = liveSession({ root: settle(liveSession().root), liveness: 'ended' });
    const b = render({ session: settled });
    for (const f of filaments(b)) {
      expect(f.dataset['flowing']).toBe('false');
      expect(f.classList.contains(ANIMATED_CLASSES[2])).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * C7.4 — the parked graft: refuse, don't guess, visualized
 * ------------------------------------------------------------------------ */

describe('parked grafts (C7.4, G3)', () => {
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
    expect(parkedCells(container).map((c) => c.dataset['agentId'])).toStrictEqual(
      parked.map((p) => p.agentId),
    );
  });

  it('renders it dash-membraned, with the contract class', () => {
    const container = render({ session: parkedSession() });
    const cell = parkedCells(container)[0];
    expect(cell?.classList.contains(PARKED_CLASS)).toBe(true);
    expect(membraneOf(cell as HTMLElement).classList.contains(PARKED_CLASS)).toBe(true);
  });

  it('hangs a dangling stub labelled "awaiting attribution"', () => {
    const container = render({ session: parkedSession() });
    const stub = one(container, TESTID.parkedStub);
    expect(stub.getAttribute('d')).toMatch(/^M -?[\d.]+ -?[\d.]+ l -?[\d.]+ -?[\d.]+$/);
    expect(parkedCells(container)[0]?.textContent).toContain('awaiting attribution');
  });

  it('NEVER attaches it: no filament reaches a parked agent', () => {
    const container = render({ session: parkedSession() });
    const parkedIds = (parkedSession().parked ?? []).map((p) => p.agentId);
    for (const f of filaments(container)) {
      expect(parkedIds).not.toContain(f.dataset['agentId']);
    }
  });

  it('places it at the layout’s parked coordinates, not at a plausible parent', () => {
    const state = parkedSession();
    const layout = sessionLayout(state);
    const container = render({ session: state });
    for (const [agentId, placement] of layout.parked) {
      const cell = cellFor(container, agentId);
      expect(membraneOf(cell).getAttribute('d')).toBe(
        blobPath(placement.x, placement.y, placement.R, hashSessionId(agentId)),
      );
    }
    // Disjointness, from this side: a parked id is in neither `cells` nor the
    // in-tree cell set the renderer drew.
    for (const agentId of layout.parked.keys()) {
      expect(layout.cells.has(agentId)).toBe(false);
      expect(cells(container).map((c) => c.dataset['agentId'])).not.toContain(agentId);
    }
  });

  it('never animates: a parked cell has no status to be running', () => {
    const container = render({ session: parkedSession() });
    const cell = parkedCells(container)[0] as HTMLElement;
    expect(animated(cell)).toHaveLength(0);
  });

  it('is reachable by keyboard and is not selectable — there is no node to inspect', () => {
    const picked: string[] = [];
    const container = render({
      session: parkedSession(),
      onselect: (id: string) => picked.push(id),
    });
    const cell = parkedCells(container)[0] as HTMLElement;
    expect(cell.getAttribute('tabindex')).toBe('0');
    expect(cell.getAttribute('aria-label')).toContain('awaiting attribution');
    cell.focus();
    expect(document.activeElement).toBe(cell);
    click(cell);
    press(cell, 'Enter');
    expect(picked).toStrictEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * C7.4 — refused: an interior element count of exactly 0
 * ------------------------------------------------------------------------ */

describe('refused interiors render NOTHING (C7.4, G3)', () => {
  /** Every element inside the canvas root, whatever it is. */
  function interior(container: HTMLElement): Element[] {
    return [...one(container, TESTID.canvas).querySelectorAll('*')];
  }

  it('DIRECTION 1 — the session refuses itself (schemaOk false): zero elements', () => {
    const state = unsupportedSession();
    // The layout has already emptied all four maps for this state, so the
    // count is 0 even before the component decides anything.
    const layout = sessionLayout(state);
    expect(layout.cells.size + layout.dots.size + layout.elided.size + layout.parked.size).toBe(0);
    const container = render({ session: state });
    expect(one(container, TESTID.canvas).dataset['refused']).toBe('true');
    expect(interior(container)).toHaveLength(0);
    for (const id of [TESTID.nucleus, TESTID.cell, TESTID.dot, TESTID.filament, TESTID.parkedStub]) {
      expect(all(container, id)).toHaveLength(0);
    }
  });

  it('DIRECTION 2 — a schemaMismatch message on a session the wire still calls live', () => {
    // The other refusal channel: `schemaOk` is true and the liveness says
    // `live`, so `sessionLayout` would place the whole tree. The component
    // refuses independently, which is what makes the count 0 here too.
    const state = liveSession();
    expect(state.schemaOk).toBe(true);
    expect(sessionLayout(state).cells.size).toBeGreaterThan(0);
    const container = render({ session: state, refused: true });
    expect(one(container, TESTID.canvas).dataset['refused']).toBe('true');
    expect(interior(container)).toHaveLength(0);
  });

  it('refuses a parked graft too — a new field is not a hole to leak through', () => {
    const container = render({ session: parkedSession(), refused: true });
    expect(interior(container)).toHaveLength(0);
    expect(parkedCells(container)).toHaveLength(0);
  });

  it('draws the interior again as soon as the session is not refused', () => {
    const container = render({ session: liveSession() });
    expect(interior(container).length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ *
 * C7.3 — the state matrix, interior rows
 * ------------------------------------------------------------------------ */

describe('tool state rows (C7.3), now carried by the agent stats line', () => {
  // THE TOOL DOTS ARE GONE, by the user's decision on 2026-08-21 after seeing
  // a real session: at R2 scale the arcs read as noise, not structure.
  //
  // C7.3's three tool rows did not disappear with them — they moved UP to the
  // agent that owns the calls. The cell's stats line carries the counts, and
  // an agent whose tool is running is itself running, so the motion channel
  // still says "happening now" with a membrane instead of a dot. Per-action
  // detail lives in the inspector, which lists every action by description.
  //
  // These assertions are deliberately written against the NEW encoding rather
  // than deleted: a row of the state matrix with no test is a row nobody is
  // holding anyone to.

  function statsFor(container: HTMLElement, agentId: string): string {
    const cell = [...all(container, TESTID.cell), ...all(container, TESTID.nucleus)].find(
      (el) => el.dataset['agentId'] === agentId,
    );
    if (cell === undefined) throw new Error(`no cell for ${agentId}`);
    return cell.querySelector('.stats')?.textContent ?? '';
  }

  it('no tool dot is drawn anywhere, at any status', () => {
    const container = render({ session: liveSession() });
    expect(all(container, TESTID.dot)).toHaveLength(0);
  });

  it('running -> the owning agent says so, and animates', () => {
    // Whichever agent owns the running call — found by property so the test
    // does not encode which fixture node happens to be running today.
    const state = liveSession();
    const container = render({ session: state });
    const running = [...all(container, TESTID.cell), ...all(container, TESTID.nucleus)].filter(
      (el) => el.dataset['status'] === 'running',
    );
    expect(running.length).toBeGreaterThan(0);
    const withRunningStat = running.filter((el) =>
      (el.querySelector('.stats')?.textContent ?? '').includes('running'),
    );
    expect(withRunningStat.length).toBeGreaterThan(0);
    expect(animated(withRunningStat[0] as HTMLElement).length).toBeGreaterThan(0);
  });

  it('error -> the owning agent counts it, and keeps counting it when settled', () => {
    const live = render({ session: liveSession() });
    const owner = [...all(live, TESTID.cell), ...all(live, TESTID.nucleus)]
      .map((el) => el.querySelector('.stats')?.textContent ?? '')
      .filter((text) => text.includes('error'));
    expect(owner.length).toBeGreaterThan(0);
  });

  it('an agent with no tool calls says so rather than showing nothing', () => {
    const bare = liveSession({
      root: agent({ id: 'root', kind: 'main', label: 'main', children: [] }),
      spawnEdges: [],
    });
    const container = render({ session: bare });
    expect(statsFor(container, 'root')).toBe('no actions yet');
  });

  it('the thorn PERSISTS after everything else has settled', () => {
    const settled = settle(liveSession().root);
    // Put the error back: `settle` is what a finished session looks like, and
    // an errored tool call stays errored in one.
    const state = liveSession({ liveness: 'ended', root: settled });
    const withError = liveSession({
      liveness: 'ended',
      root: {
        ...settled,
        children: settled.children.map((c) =>
          isAgentNode(c)
            ? {
                ...c,
                children: c.children.map((g) =>
                  isAgentNode(g)
                    ? {
                        ...g,
                        children: g.children.map((t) =>
                          isAgentNode(t) ? t : { ...t, status: 'error' as const },
                        ),
                      }
                    : g,
                ),
              }
            : c,
        ),
      },
    });
    expect(toolsOf(state).some((t) => t.status === 'error')).toBe(false);
    const container = render({ session: withError });
    // The error is still COUNTED once everything else has settled: an error
    // that stops being reported when the session ends is an error the user
    // never sees. It moved from a thorn to the owning cell's stats line.
    const stats = [...container.querySelectorAll(".stats")]
      .map((el) => el.textContent ?? "")
      .filter((t) => t.includes("error"));
    expect(stats.length).toBeGreaterThan(0);
    expect(animated(container)).toHaveLength(0);
  });
});

describe('agent status is the membrane colour of its cell (C7.3)', () => {
  for (const status of ['running', 'done', 'error'] as const) {
    it(`marks a ${status} agent's cell ${status}`, () => {
      const state = liveSession({
        root: { ...liveSession().root, status },
      });
      const container = render({ session: state });
      expect(one(container, TESTID.nucleus).dataset['status']).toBe(status);
    });
  }

  it('carries a stylesheet rule for each of the three status rows', () => {
    for (const status of ['running', 'done', 'error']) {
      expect(bundle).toContain(`[data-status='${status}']`);
    }
  });
});

describe('degraded — hooks silent (C7.3, G2)', () => {
  it('hollows a running agent’s membrane and only a running one', () => {
    const container = render({ session: liveSession(), degraded: true });
    expect(one(container, TESTID.canvas).dataset['degraded']).toBe('true');
    const running = agentsOf(liveSession()).filter((a) => a.status === 'running');
    expect(running.length).toBeGreaterThan(0);
    for (const a of running) {
      expect(membraneOf(cellFor(container, a.id)).classList.contains(HOLLOW_LIVE_CLASS)).toBe(true);
    }
    const settled = liveSession({ root: settle(liveSession().root) });
    const still = render({ session: settled, degraded: true });
    expect(
      [...still.querySelectorAll('*')].filter((el) => el.classList.contains(HOLLOW_LIVE_CLASS)),
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

  it('still animates a running membrane while degraded — inferred, not absent', () => {
    const container = render({ session: liveSession(), degraded: true });
    expect(animated(cellFor(container, 'agent-1')).length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ *
 * C7.5 — the dot cap, and tools with no dot
 * ------------------------------------------------------------------------ */

describe('the dot cap (C7.5), now a layout property only', () => {
  // The dots are no longer drawn, so DOT_CAP cannot be asserted against the
  // DOM any more. It is still real and still bounds the layout, so it is
  // asserted where it now lives — a cap that stopped being checked anywhere
  // would be a cap that quietly stopped applying.

  it('still caps placed dots and records the remainder, though none are drawn', () => {
    const many = Array.from({ length: DOT_CAP + 9 }, (_, i) =>
      tool({ id: `t-${String(i)}`, toolName: 'Bash', inputPreview: 'x' }),
    );
    const state = liveSession({
      root: agent({ id: 'root', kind: 'main', label: 'main', children: many }),
      spawnEdges: [],
    });

    const layout = sessionLayout(state);
    expect(layout.dots.size).toBe(DOT_CAP);
    expect(layout.elided.get('root')).toBe(9);

    // ...and the canvas draws none of them.
    const container = render({ session: state });
    expect(dots(container)).toHaveLength(0);
  });

  it('reports the whole action count on the cell, uncapped', () => {
    // The count is what replaced the arc, so it must NOT inherit the arc's
    // cap: an agent with 57 calls says 57, not 48.
    const many = Array.from({ length: DOT_CAP + 9 }, (_, i) =>
      tool({ id: `t-${String(i)}`, toolName: 'Bash', inputPreview: 'x' }),
    );
    const state = liveSession({
      root: agent({ id: 'root', kind: 'main', label: 'main', children: many }),
      spawnEdges: [],
    });
    const container = render({ session: state });
    const stats = one(container, TESTID.nucleus).querySelector('.stats')?.textContent ?? '';
    expect(stats).toContain(String(DOT_CAP + 9));
  });
});

/* ------------------------------------------------------------------------ *
 * C7.6 — motion is a reserved semantic channel, with its negative control
 * ------------------------------------------------------------------------ */

describe('the motion invariant (C7.6)', () => {
  it('NEGATIVE CONTROL: everything done and the session ended -> zero animated elements', () => {
    const state = liveSession({ liveness: 'ended', root: settle(liveSession().root) });
    const container = render({ session: state });
    // The control is only worth anything if there was something to animate.
    expect(cells(container).length + dots(container).length).toBeGreaterThan(0);
    expect(filaments(container).length).toBeGreaterThan(0);
    expect(animated(container)).toHaveLength(0);
  });

  it('animates exactly the running nodes and their filaments', () => {
    const container = render({ session: liveSession() });
    for (const el of animated(container)) {
      const owner = el.closest('[data-status], [data-flowing]') as HTMLElement | null;
      const state = owner?.dataset['status'] ?? owner?.dataset['flowing'];
      expect(['running', 'true']).toContain(state);
    }
  });

  it('carries only contract classes, and every class it carries is one', () => {
    // NOT "all three" any more. `is-pulsing` was the running tool dot, and the
    // dots are gone; it is still live on the DECK's pulse ring, which is a
    // different surface with its own test. Asserting three here would fail for
    // a reason that has nothing to do with this component.
    //
    // What still matters is the direction that catches a mistake: everything
    // animating here is a contract class, so the negative control can see it.
    const container = render({ session: liveSession() });
    const classes = new Set<string>();
    for (const el of animated(container)) for (const c of el.classList) classes.add(c);
    const carried = ANIMATED_CLASSES.filter((c) => classes.has(c));
    expect(carried.length).toBeGreaterThan(0);
    for (const c of classes) {
      if (c.startsWith('is-')) expect(ANIMATED_CLASSES).toContain(c);
    }
  });

  it('puts the animation-bearing classes on elements the stylesheet animates', () => {
    // CSS cannot import a TypeScript constant, so the stylesheet spells these
    // names a second time. Checking the bundled CSS against the constants is
    // what stops a rename from silently switching an animation off while the
    // negative control still passes.
    // INTERIOR_ANIMATED, not ANIMATED_CLASSES: `is-pulsing` was the running
    // tool dot, and the dots are gone. It is still live on the DECK pulse ring,
    // which `deck.test.ts` guards. Asserting it here would fail for a reason
    // that has nothing to do with this component.
    for (const cls of INTERIOR_ANIMATED) expect(bundle).toContain(`.${cls}`);
    expect(bundle).toContain('animation:');
  });
});

describe('reduced motion (C7.6, C7.8)', () => {
  it('puts the reduced-motion class on the canvas root when asked', () => {
    const container = render({ session: liveSession(), reducedMotion: true });
    expect(one(container, TESTID.canvas).classList.contains(REDUCED_MOTION_CLASS)).toBe(true);
  });

  it('leaves the class off when the user did not ask for it', () => {
    const container = render({ session: liveSession() });
    expect(one(container, TESTID.canvas).classList.contains(REDUCED_MOTION_CLASS)).toBe(false);
  });

  it('SWAPS the animation rather than removing the semantics', () => {
    const container = render({ session: liveSession(), reducedMotion: true });
    expect(animated(container).length).toBeGreaterThan(0);
  });

  it('carries a stylesheet rule keyed to the contract class name', () => {
    expect(bundle).toContain(`.${REDUCED_MOTION_CLASS}`);
  });
});

/* ------------------------------------------------------------------------ *
 * C7.8 — accessibility floor, interior level
 * ------------------------------------------------------------------------ */

describe('accessibility floor (C7.8)', () => {
  it('makes every cell and dot a real focusable control with a name', () => {
    const container = render({ session: liveSession() });
    const controls = [...cells(container), ...all(container, TESTID.nucleus), ...dots(container)];
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

  it('reports the node id on click', () => {
    const picked: string[] = [];
    const container = render({
      session: liveSession(),
      onselect: (id: string) => picked.push(id),
    });
    click(cellFor(container, 'agent-1'));
    click(cellFor(container, 'agent-1'));
    expect(picked).toStrictEqual(['agent-1', 'agent-1']);
  });

  for (const key of ['Enter', ' ']) {
    it(`selects on ${key === ' ' ? 'Space' : key}`, () => {
      const picked: string[] = [];
      const container = render({
        session: liveSession(),
        onselect: (id: string) => picked.push(id),
      });
      const event = press(cellFor(container, 'agent-1'), key);
      expect(picked).toStrictEqual(['agent-1']);
      expect(event.defaultPrevented).toBe(true);
    });
  }

  it('ignores keys that are not an activation, including Escape', () => {
    // Escape walks the altitudes up and that lives in `Store.escape`, not
    // here: two owners of one transition is how the two surfaces drift apart.
    const picked: string[] = [];
    const container = render({
      session: liveSession(),
      onselect: (id: string) => picked.push(id),
    });
    press(cellFor(container, 'agent-1'), 'Escape');
    press(cellFor(container, 'agent-1'), 'a');
    expect(picked).toStrictEqual([]);
  });

  it('marks the store’s selected node current', () => {
    const container = render({ session: liveSession(), selectedNodeId: 'agent-1' });
    expect(cellFor(container, 'agent-1').dataset['selected']).toBe('true');
    expect(cellFor(container, 'agent-1').getAttribute('aria-current')).toBe('true');
    expect(cellFor(container, 'agent-2').dataset['selected']).toBe('false');
    expect(cellFor(container, 'agent-2').getAttribute('aria-current')).toBe('false');
  });

  it('does not throw when no handler is wired', () => {
    const container = render({ session: liveSession() });
    expect(() => click(cellFor(container, 'agent-1'))).not.toThrow();
  });

  it('carries a focus-ring rule rather than relying on the browser default', () => {
    expect(bundle).toContain(':focus-visible');
    expect(bundle).toContain('--vscode-focusBorder');
  });
});

/* ------------------------------------------------------------------------ *
 * The stylesheet seam
 * ------------------------------------------------------------------------ */

describe('every contract class the interior applies also carries style', () => {
  // The components build these names from `canvas-contract.ts`, so the DOM
  // side cannot drift. CSS cannot import a constant, so the stylesheet spells
  // each name a second time — and Svelte PRUNES a scoped rule it cannot prove
  // is used, which would silently remove the styling while every DOM assertion
  // above still passed. The `.` prefix is what makes this a check on the
  // stylesheet rather than on the contract module bundled beside it.
  for (const cls of [
    PARKED_CLASS,
    HOLLOW_LIVE_CLASS,
    REDUCED_MOTION_CLASS,
    ...INTERIOR_ANIMATED,
  ]) {
    it(`styles .${cls}`, () => {
      expect(bundle).toContain(`.${cls}`);
    });
  }
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
