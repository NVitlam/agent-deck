// @vitest-environment jsdom
//
// Phase 3 carry-forward C: "the renderer is never fed fixture-derived state".
//
// Every other webview test builds a `SessionState` by hand. That proves the
// renderer against the typed contract and nothing about the states the host
// actually produces. This file closes the composition end to end, with no
// hand-made state anywhere in the path:
//
//   fixtures/cc-2.1.234/**  (real captured transcripts, sidecars, tool-results)
//     -> graftSession()          real fingerprint + parse + redaction + graft
//     -> SessionModel            real refusal boundary and liveness join
//     -> LivenessEngine          real live/idle/ended state machine
//     -> SessionBridge           real snapshot/diff/schemaMismatch/degraded wire
//     -> JSON round trip         stands in for VS Code's structured-clone hop
//     -> window 'message'        the same event the real webview listens to
//     -> the mounted Svelte bundle, asserted in the DOM
//
// WHAT IS DELIBERATELY NOT ASSERTED: preview byte counts, truncation marker
// text, and preview digests. Those are moving in this same phase (the
// two-stage truncation defect recorded in PLAN.md), and a renderer test that
// pins them would fail on that change and read as a renderer regression.
// Everything below asserts STRUCTURE and STATE: which nodes appear, which
// state a session renders in, and that a cut payload is MARKED as cut.
//
// Node builtins are imported by their real specifiers rather than through the
// opaque-string dodge `testkit.ts` uses. `tsconfig.webview.json` sets
// `types: []`, which removes node's GLOBALS (`process`, `Buffer`) from this
// project but does not stop an explicit `node:*` module import from
// resolving — measured, not assumed. Nothing here is reachable from
// `webview/main.ts`, so the shipped bundle is unaffected; `bundle.test.ts`
// asserts that against the built artifact.

import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  HostToWebviewMessage,
  NormalizedHookEvent,
  SessionState,
  TreeNode,
  WebviewToHostMessage,
} from '../src/model/events.js';
import { isAgentNode } from '../src/model/events.js';
import { graftSession } from '../src/model/graft.js';
import { LivenessEngine } from '../src/model/liveness.js';
import { SessionModel } from '../src/model/session.js';
import { SessionBridge } from '../src/bridge/messages.js';
import type { Store } from './store.js';
import type { WebviewHarness } from './testkit.js';
import { all, loadHarness, one, press } from './testkit.js';
import { TESTID } from './canvas-contract.js';
import type { ViewMode } from './canvas-contract.js';
import { COLLAPSED_PREVIEW_CHARS, EM_DASH } from './format.js';

// Resolved against the process working directory, which vitest sets to the
// repo root — the same anchor `bundle.test.ts` uses for `dist/webview/main.js`.
// NOT `import.meta.url`: under the jsdom environment that is an `http:` URL
// and `fileURLToPath` throws on it. Measured; the host suites can use
// `import.meta.url` because they are node suites.
const CAPTURED_ROOT = resolve('fixtures/cc-2.1.234/projects');
const LAYOUT_ROOT = resolve('fixtures/synthetic-layout');

/**
 * A fixed instant. Liveness moves with the clock, so a test reading the real
 * one would pin its result to the second it ran.
 */
const NOW = 1_700_000_060_000;
/** Comfortably inside the engine's recency threshold. */
const RECENT = NOW - 1_000;
/** Comfortably outside it. */
const STALE = NOW - 600_000;

// ---------------------------------------------------------------------------
// Fixture discovery — read off the directory, never named
// ---------------------------------------------------------------------------

interface Captured {
  slugDir: string;
  slug: string;
  sessionIds: string[];
  workspacePath: string;
}

let captured: Captured | undefined;

async function fixtures(): Promise<Captured> {
  if (captured !== undefined) return captured;
  const entries = await readdir(CAPTURED_ROOT, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const first = dirs[0];
  if (first === undefined) throw new Error('no slug directory under the captured root');
  const slugDir = join(CAPTURED_ROOT, first);

  const names = await readdir(slugDir, { withFileTypes: true });
  const sessionIds = names
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => e.name.replace(/\.jsonl$/, ''))
    .sort();
  if (sessionIds.length === 0) throw new Error('no transcripts in the captured slug directory');

  // The workspace the capture was taken in, read from the transcripts' own
  // `cwd`. Deriving it means a re-harvest on another machine needs no edit.
  let workspacePath = '';
  for (const sessionId of sessionIds) {
    const text = await readFile(join(slugDir, `${sessionId}.jsonl`), 'utf8');
    const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text);
    if (match === null) continue;
    const raw = match[1];
    if (raw === undefined) continue;
    const decoded = JSON.parse(`"${raw}"`) as string;
    if (decoded !== '') {
      workspacePath = decoded;
      break;
    }
  }
  if (workspacePath === '') throw new Error('no cwd found in the captured transcripts');

  captured = { slugDir, slug: first, sessionIds, workspacePath };
  return captured;
}

/** The first synthetic-layout case `graftSession` actually refuses. */
async function refusedLayout(): Promise<{ path: string; sessionId: string; caseName: string }> {
  const cases = (await readdir(LAYOUT_ROOT, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const caseName of cases) {
    const caseDir = join(LAYOUT_ROOT, caseName);
    const slugs = (await readdir(caseDir, { withFileTypes: true })).filter((e) => e.isDirectory());
    for (const slugEntry of slugs) {
      const slugDir = join(caseDir, slugEntry.name);
      const transcripts = (await readdir(slugDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => e.name)
        .sort();
      for (const name of transcripts) {
        const path = join(slugDir, name);
        const result = await graftSession(path);
        if (!result.ok) {
          return { path, sessionId: name.replace(/\.jsonl$/, ''), caseName };
        }
      }
    }
  }
  throw new Error('no synthetic-layout case produced a refusal');
}

// ---------------------------------------------------------------------------
// The host half, assembled from the real classes
// ---------------------------------------------------------------------------

/** A main-thread hook event: `agent_id` ABSENT, never a placeholder string. */
function mainEvent(
  sessionId: string,
  eventName: string,
  receivedAt: number,
  seq: number,
): NormalizedHookEvent {
  return {
    seq,
    receivedAt,
    eventName,
    eventNameConfirmed: true,
    sessionId,
    isMainThread: true,
    raw: { hook_event_name: eventName, session_id: sessionId },
  };
}

interface HostRun {
  model: SessionModel;
  engine: LivenessEngine;
  slug: string;
  slugDir: string;
  sessionIds: string[];
  /** What the model produced, keyed by session id. The renderer's input. */
  states: Map<string, SessionState>;
  /** Every message the bridge actually put on the wire, in order. */
  wire: HostToWebviewMessage[];
}

/**
 * Build the host side from the fixtures and publish it into `target` through
 * a real `SessionBridge`.
 *
 * `configure` runs after every session is grafted and before the emission, so
 * a test can drive liveness with hook events the way the listener does.
 */
async function hostRun(
  target: { dispatch: (message: unknown) => void },
  configure?: (run: Omit<HostRun, 'states' | 'wire'>) => void | Promise<void>,
): Promise<HostRun> {
  const { slugDir, slug, sessionIds, workspacePath } = await fixtures();
  const engine = new LivenessEngine({ now: () => NOW });
  const model = new SessionModel({ workspacePath, liveness: engine });

  for (const sessionId of sessionIds) {
    const result = await graftSession(join(slugDir, `${sessionId}.jsonl`));
    model.ingestGraftResult(sessionId, slug, result);
  }

  await configure?.({ model, engine, slug, slugDir, sessionIds });

  const wire: HostToWebviewMessage[] = [];
  const bridge = new SessionBridge({
    postMessage: (message: HostToWebviewMessage): void => {
      wire.push(message);
      // VS Code's postMessage is a structured-clone hop, so the webview never
      // receives the host's own object. A JSON round trip is the closest
      // faithful stand-in and it also proves nothing unserialisable escapes.
      target.dispatch(JSON.parse(JSON.stringify(message)) as unknown);
    },
  });

  const emission = model.emit();
  bridge.publish(emission);
  bridge.publishDegraded(engine.degradedState());

  const states = new Map<string, SessionState>();
  for (const state of emission.sessions) states.set(state.sessionId, state);
  return { model, engine, slug, slugDir, sessionIds, states, wire };
}

// ---------------------------------------------------------------------------
// Small tree helpers over a SessionState (the renderer's input, not its output)
// ---------------------------------------------------------------------------

function walkState(state: SessionState): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (node: TreeNode): void => {
    out.push(node);
    if (isAgentNode(node)) for (const child of node.children) visit(child);
  };
  visit(state.root);
  return out;
}

function previewsOf(state: SessionState): { id: string; label: string; text: string }[] {
  const out: { id: string; label: string; text: string }[] = [];
  for (const node of walkState(state)) {
    if (isAgentNode(node)) continue;
    out.push({ id: node.id, label: 'input', text: node.inputPreview });
    if (node.resultPreview !== undefined) {
      out.push({ id: node.id, label: 'result', text: node.resultPreview });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

let harness: WebviewHarness;

beforeAll(async () => {
  harness = await loadHarness();
}, 60_000);

interface Mounted {
  container: HTMLElement;
  store: Store;
  sent: WebviewToHostMessage[];
  dispatch: (message: unknown) => void;
  dispose: () => void;
}

const mounted: Mounted[] = [];

/**
 * Mount the panel.
 *
 * `mode` defaults to the LIST surface, because everything this file established
 * in Phase 3 is stated in terms of tree nodes and rail rows, and those
 * assertions are unchanged by the canvas — "kept, not deleted" (C7.2) means
 * they must still hold. The canvas section at the end of the file passes
 * `'canvas'` and drives the same fixture-derived states through the other
 * surface, so the composition is closed for both.
 */
function render(mode: ViewMode = 'list'): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const sent: WebviewToHostMessage[] = [];
  const started = harness.start(container, { postMessage: (m) => sent.push(m) });
  harness.flushSync(() => {
    started.store.setViewMode(mode);
  });
  let disposed = false;
  const record: Mounted = {
    container,
    store: started.store,
    sent,
    dispatch: (message: unknown) => {
      harness.flushSync(() => {
        globalThis.dispatchEvent(new MessageEvent('message', { data: message }));
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const at = mounted.indexOf(record);
      if (at >= 0) mounted.splice(at, 1);
      started.dispose();
      container.remove();
    },
  };
  mounted.push(record);
  return record;
}

function click(element: HTMLElement): void {
  harness.flushSync(() => {
    element.click();
  });
}

function nodeEl(container: HTMLElement, nodeId: string): HTMLElement {
  const found = all(container, 'tree-node').filter((n) => n.dataset['nodeId'] === nodeId);
  const first = found[0];
  if (found.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one rendered node ${nodeId}, found ${found.length}`);
  }
  return first;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------

describe('a real captured session, grafted by the host and rendered', () => {
  it('draws every node the host produced, exactly once, and nothing else', async () => {
    const panel = render();
    const run = await hostRun(panel);

    // Every workspace session the model emitted is in the rail.
    const railIds = all(panel.container, 'rail-item').map((i) => i.dataset['sessionId']);
    expect(new Set(railIds)).toStrictEqual(new Set(run.states.keys()));
    expect(railIds.length).toBe(run.states.size);

    const selected = one(panel.container, 'header-session-id').textContent?.trim() ?? '';
    const state = run.states.get(selected);
    expect(state).toBeDefined();
    if (state === undefined) return;

    const expected = walkState(state).map((n) => n.id).sort();
    const drawn = all(panel.container, 'tree-node')
      .map((n) => n.dataset['nodeId'] ?? '')
      .sort();
    expect(drawn).toStrictEqual(expected);
    // The capture is not an empty tree, so this assertion is not vacuous.
    expect(expected.length).toBeGreaterThan(1);
  });

  it('nests each subagent under the tool_use block its sidecar named', async () => {
    const panel = render();
    const run = await hostRun(panel);
    const selected = one(panel.container, 'header-session-id').textContent?.trim() ?? '';
    const state = run.states.get(selected);
    if (state === undefined) throw new Error('no state for the selected session');

    const edges = state.spawnEdges ?? [];
    // The primary-key join is the whole product bet; a capture without one
    // would make this file prove nothing about grafting.
    expect(edges.length).toBeGreaterThan(0);

    for (const edge of edges) {
      const agentEl = nodeEl(panel.container, edge.agentId);
      const toolEl = nodeEl(panel.container, edge.toolUseId);
      expect(agentEl.dataset['kind']).toBe('agent');
      expect(agentEl.dataset['spawnedBy']).toBe(edge.toolUseId);
      expect(toolEl.contains(agentEl)).toBe(true);
    }

    // The deepest subagent on screen is the deepest one the host produced —
    // derived from the state, never a literal, so a re-harvest cannot turn a
    // deeper capture into a false regression.
    const deepestInState = Math.max(
      ...walkState(state).map((n) => (isAgentNode(n) ? n.spawnDepth : 0)),
    );
    const deepestOnScreen = Math.max(
      ...all(panel.container, 'tree-node')
        .map((n) => Number(n.dataset['spawnDepth'] ?? '0'))
        .filter((d) => Number.isFinite(d)),
    );
    expect(deepestOnScreen).toBe(deepestInState);
  });

  it('renders the offloaded tool-results payloads that the host hydrated', async () => {
    const panel = render();
    const run = await hostRun(panel);

    // The `tool-results/*.txt` BASENAME IS NOT THE TOOL_USE ID — it is an
    // opaque name CC chose (`b6uvpgxa4.txt` in this capture), and the join back
    // to a `tool_use` block is the `<persisted-output>` stub that
    // `hydratePersistedOutputs` reads. So the node is found by content: the
    // hydrated preview starts with the file's first bytes. Only the HEAD is
    // matched, because the tail is where truncation lives and truncation is
    // moving in this same phase.
    let checked = 0;
    for (const sessionId of run.sessionIds) {
      let files: string[];
      const dir = join(run.slugDir, sessionId, 'tool-results');
      try {
        files = (await readdir(dir)).filter((n) => n.endsWith('.txt'));
      } catch {
        continue; // no tool-results directory for this session
      }
      const state = run.states.get(sessionId);
      if (state === undefined) continue;

      const railItem = all(panel.container, 'rail-item').find(
        (i) => i.dataset['sessionId'] === sessionId,
      );
      if (railItem === undefined) continue;
      click(railItem);

      for (const name of files) {
        const contents = await readFile(join(dir, name), 'utf8');
        const head = contents.slice(0, 120);
        expect(head.length).toBeGreaterThan(0);

        const holder = walkState(state).find(
          (n) => !isAgentNode(n) && (n.resultPreview ?? '').startsWith(head),
        );
        // The offloaded payload reached a node rather than being dropped —
        // this is the path where "previews silently miss content" lives.
        expect(holder, `no node holds ${basename(name)}`).toBeDefined();
        if (holder === undefined || isAgentNode(holder)) continue;
        checked += 1;

        // The renderer shows exactly what the host put in the state. Compared
        // against the state, not against a byte count, so the truncation work
        // happening elsewhere in this phase cannot break it.
        click(all(nodeEl(panel.container, holder.id), 'toggle')[0] as HTMLElement);
        const preview = all(nodeEl(panel.container, holder.id), 'payload-preview').find(
          (p) => p.dataset['label'] === 'result',
        );
        if (preview === undefined) throw new Error(`no result preview on ${holder.id}`);
        expect(one(preview, 'preview-body').textContent).toBe(holder.resultPreview);
      }
    }
    // The capture must contain at least one offloaded payload, or this test
    // asserts nothing. Loud failure beats a silent pass.
    expect(checked).toBeGreaterThan(0);
  });
});

describe('the payload previews the host produced', () => {
  it('marks a cut preview as cut and shows the whole thing when expanded', async () => {
    const panel = render();
    const run = await hostRun(panel);
    const selected = one(panel.container, 'header-session-id').textContent?.trim() ?? '';
    const state = run.states.get(selected);
    if (state === undefined) throw new Error('no state for the selected session');

    const long = previewsOf(state).filter((p) => p.text.length > COLLAPSED_PREVIEW_CHARS);
    // Not a size pin: the capture must exercise the collapsed path at all, or
    // this test proves nothing. A harvest without a long payload fails loudly
    // instead of silently passing.
    expect(long.length).toBeGreaterThan(0);

    for (const preview of long) {
      const node = nodeEl(panel.container, preview.id);
      expect(node.dataset['expanded']).toBe('false');
      const collapsed = all(node, 'payload-preview').find(
        (p) => p.dataset['label'] === preview.label,
      );
      if (collapsed === undefined) throw new Error(`no ${preview.label} preview on ${preview.id}`);
      expect(one(collapsed, 'preview-body').dataset['truncated']).toBe('true');
      expect(all(collapsed, 'preview-marker')).toHaveLength(1);
    }

    // Expand one and the renderer shows the host's string in full — asserted
    // by equality with the state, never by a length.
    const first = long[0];
    if (first === undefined) throw new Error('unreachable');
    click(all(nodeEl(panel.container, first.id), 'toggle')[0] as HTMLElement);
    const expanded = all(nodeEl(panel.container, first.id), 'payload-preview').find(
      (p) => p.dataset['label'] === first.label,
    );
    if (expanded === undefined) throw new Error('preview vanished on expand');
    expect(one(expanded, 'preview-body').textContent).toBe(first.text);
    expect(all(expanded, 'preview-marker')).toHaveLength(0);
  });

  it('G4: no thinking signature bytes reach the DOM, even fully expanded', async () => {
    const panel = render();
    const run = await hostRun(panel);

    // Expand everything, so the assertion is about what CAN be shown rather
    // than about what happens to be collapsed.
    for (const node of all(panel.container, 'tree-node')) {
      if (node.dataset['kind'] !== 'tool') continue;
      const toggle = all(node, 'toggle')[0];
      if (toggle !== undefined) click(toggle);
    }
    const shown = panel.container.textContent ?? '';
    expect(shown.length).toBeGreaterThan(0);

    // CC's thinking blocks are EMPTY on disk and the `signature` field carries
    // the bytes, so asserting that thinking text does not leak is vacuous. The
    // signatures are read out of the fixtures at test time — pinning a literal
    // here would rot on the next harvest.
    const signatures: string[] = [];
    for (const sessionId of run.sessionIds) {
      const text = await readFile(join(run.slugDir, `${sessionId}.jsonl`), 'utf8');
      for (const match of text.matchAll(/"signature":"([^"\\]{40,})"/g)) {
        const value = match[1];
        if (value !== undefined) signatures.push(value);
      }
    }
    expect(signatures.length).toBeGreaterThan(0);
    for (const signature of signatures) {
      expect(shown).not.toContain(signature.slice(0, 64));
    }
    expect(shown).not.toContain('signature');
    expect(shown).not.toContain('"thinking"');
  });

  it('renders cost as an em-dash: the host sends 0 and 0 means not computed', async () => {
    const panel = render();
    await hostRun(panel);
    const header = one(panel.container, 'session-header');
    expect(one(header, 'header-cost').textContent?.trim()).toBe(EM_DASH);
    expect(header.textContent).not.toContain('$');
  });
});

// ---------------------------------------------------------------------------
// The five states, driven out of the real liveness engine
// ---------------------------------------------------------------------------

describe('the five UI states, computed by the host rather than set by hand', () => {
  it('live: a hook event and a recent transcript mtime', async () => {
    const panel = render();
    const run = await hostRun(panel, ({ model, sessionIds }) => {
      for (const sessionId of sessionIds) {
        model.liveness.observeJsonl(sessionId, { mtimeMs: RECENT });
        model.ingestHookEvent(mainEvent(sessionId, 'PreToolUse', RECENT, 1));
      }
    });

    for (const state of run.states.values()) expect(state.liveness).toBe('live');
    expect(one(panel.container, 'app').dataset['liveness']).toBe('live');
    expect(one(panel.container, 'header-liveness').textContent?.trim()).toBe('live');
    expect(all(panel.container, 'tree-node').length).toBeGreaterThan(0);
  });

  it('idle: still running, but nothing recent', async () => {
    const panel = render();
    const run = await hostRun(panel, ({ model, sessionIds }) => {
      for (const sessionId of sessionIds) {
        model.liveness.observeJsonl(sessionId, { mtimeMs: STALE });
        model.ingestHookEvent(mainEvent(sessionId, 'PreToolUse', STALE, 1));
      }
    });

    for (const state of run.states.values()) expect(state.liveness).toBe('idle');
    expect(one(panel.container, 'app').dataset['liveness']).toBe('idle');
    expect(one(panel.container, 'header-liveness').textContent?.trim()).toBe('idle');
    expect(all(panel.container, 'tree-node').length).toBeGreaterThan(0);
  });

  it('ended: a Stop hook event and nothing recent', async () => {
    const panel = render();
    const run = await hostRun(panel, ({ model, sessionIds }) => {
      for (const sessionId of sessionIds) {
        model.liveness.observeJsonl(sessionId, { mtimeMs: STALE });
        model.ingestHookEvent(mainEvent(sessionId, 'PreToolUse', STALE, 1));
        // `Stop` is a HOOK event. There is no `stop` entry type in any of the
        // committed transcripts, and `stop_reason: "end_turn"` is one per
        // assistant turn rather than a terminator — the model never treats it
        // as an ending, and neither does this test.
        model.ingestHookEvent(mainEvent(sessionId, 'Stop', STALE, 2));
      }
    });

    for (const state of run.states.values()) expect(state.liveness).toBe('ended');
    expect(one(panel.container, 'app').dataset['liveness']).toBe('ended');
    expect(one(panel.container, 'header-liveness').textContent?.trim()).toBe('ended');
    expect(all(panel.container, 'tree-node').length).toBeGreaterThan(0);
  });

  it('unsupported: a layout the real fingerprint refuses yields no tree', async () => {
    const layout = await refusedLayout();
    const panel = render();
    const run = await hostRun(panel, async ({ model, slug }) => {
      // Registered under the captured workspace's slug so the model treats it
      // as this workspace's session; the refusal itself comes from
      // `graftSession` reading the hand-mutated layout on disk.
      model.ingestGraftResult(layout.sessionId, slug, await graftSession(layout.path));
    });

    const refused = run.states.get(layout.sessionId);
    expect(refused?.schemaOk).toBe(false);
    expect(refused?.liveness).toBe('unsupported');
    expect(refused?.root.children).toStrictEqual([]);

    // The bridge announced it as a mismatch, and the rail shows it as such.
    expect(run.wire.some((m) => m.type === 'schemaMismatch')).toBe(true);
    const rail = all(panel.container, 'rail-item').find(
      (i) => i.dataset['sessionId'] === layout.sessionId,
    );
    expect(rail?.dataset['liveness']).toBe('unsupported');
    expect(rail?.dataset['refused']).toBe('true');

    click(rail as HTMLElement);
    expect(all(panel.container, 'refusal-screen')).toHaveLength(1);
    expect(all(panel.container, 'tree-node')).toHaveLength(0);
    expect(all(panel.container, 'session-header')).toHaveLength(0);
    expect(one(panel.container, 'app').dataset['liveness']).toBe('unsupported');
  });

  it('degraded: no hook events at all, and the tree renders anyway (G2)', async () => {
    const panel = render();
    const run = await hostRun(panel, ({ model, sessionIds }) => {
      // Content only. The hook tap never speaks, which is exactly the state a
      // user who has not pasted the hook block is in.
      for (const sessionId of sessionIds) {
        model.liveness.observeJsonl(sessionId, { mtimeMs: RECENT });
      }
    });

    expect(run.engine.degradedState()).toStrictEqual({
      degraded: true,
      reason: 'noHookEvents',
    });
    expect(one(panel.container, 'app').dataset['degraded']).toBe('true');
    expect(one(panel.container, 'degraded-banner').dataset['reason']).toBe('noHookEvents');
    // The content tap is untouched by the hook tap's silence.
    expect(all(panel.container, 'tree-node').length).toBeGreaterThan(0);
    // ...and the liveness value on screen is marked for what it is.
    expect(all(panel.container, 'header-liveness-inferred')).toHaveLength(1);
  });

  it('not degraded once a hook event has arrived', async () => {
    const panel = render();
    await hostRun(panel, ({ model, sessionIds }) => {
      const first = sessionIds[0];
      if (first === undefined) throw new Error('no captured sessions');
      model.ingestHookEvent(mainEvent(first, 'PreToolUse', RECENT, 1));
    });

    expect(all(panel.container, 'degraded-banner')).toHaveLength(0);
    expect(one(panel.container, 'app').dataset['degraded']).toBe('false');
    expect(all(panel.container, 'header-liveness-inferred')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The same host-produced states, through the CANVAS surface
// ---------------------------------------------------------------------------
//
// Everything above drives the list view, because that is what these fixtures
// established in Phase 3. This section closes the same composition through the
// other surface: no hand-made `SessionState` anywhere, the real graft, the
// real liveness engine, the real bridge — rendered as blobs, cells and dots.
//
// The numbers are DERIVED from the host's own output every time, never written
// down. A re-harvest that changes the fixture set must not read as a
// regression here.

describe('the canvas surface, fed the same host-produced states', () => {
  /** The blob for one session on the deck. */
  function blob(container: HTMLElement, sessionId: string): HTMLElement {
    const found = all(container, TESTID.deckBlob).filter(
      (b) => b.dataset['sessionId'] === sessionId,
    );
    const first = found[0];
    if (found.length !== 1 || first === undefined) {
      throw new Error(`expected one blob for ${sessionId}, found ${found.length}`);
    }
    return first;
  }

  /** MouseEvent, never `click()`: every element on this surface is SVG. */
  function activate(element: Element): void {
    harness.flushSync(() => {
      press(element);
    });
  }

  it('puts one blob on the deck per session the host emitted, in the host order', async () => {
    const panel = render('canvas');
    const run = await hostRun(panel);

    const drawn = all(panel.container, TESTID.deckBlob).map((b) => b.dataset['sessionId']);
    expect(drawn).toStrictEqual([...run.states.keys()]);
    // C7.8: screen-reader order follows the store, not the geometry — and the
    // store's order is the order the host's snapshot arrived in.
    expect(drawn.length).toBeGreaterThan(0);

    // Blob size is derived from the node count the store counted, which is the
    // node count the host produced. Compared against the model, not a literal.
    for (const [sessionId, state] of run.states) {
      const expected = walkState(state).length;
      expect(Number(blob(panel.container, sessionId).dataset['nodes'])).toBe(expected);
    }
  });

  it('draws every agent as a cell, and no tool dots at all', async () => {
    const panel = render('canvas');
    const run = await hostRun(panel);

    const sessionId = [...run.states.keys()][0];
    if (sessionId === undefined) throw new Error('no captured sessions');
    const state = run.states.get(sessionId);
    if (state === undefined) throw new Error('unreachable');

    activate(blob(panel.container, sessionId));
    expect(one(panel.container, TESTID.canvas).dataset['sessionId']).toBe(sessionId);

    // Every agent the host produced has a cell — the nucleus is the main one.
    const agentIds = walkState(state).filter(isAgentNode).map((n) => n.id).sort();
    const cellIds = [
      ...all(panel.container, TESTID.nucleus),
      ...all(panel.container, TESTID.cell),
    ]
      .map((c) => c.dataset['agentId'] ?? '')
      .sort();
    expect(cellIds).toStrictEqual(agentIds);
    expect(agentIds.length).toBeGreaterThan(1);

    // NO tool dots, on real host-produced state as well as on fixtures. The
    // tree still HAS the tool nodes - they reach the inspector, by
    // description - they are simply not drawn on the canvas any more.
    const toolIds = new Set(walkState(state).filter((n) => !isAgentNode(n)).map((n) => n.id));
    expect(toolIds.size).toBeGreaterThan(0);
    expect(all(panel.container, TESTID.dot)).toHaveLength(0);
  });

  it('draws the filament for every spawn edge whose two ends are both placed', async () => {
    // C7.4: the join, drawn. The edges come from the host's copy of the
    // sidecar's `meta.toolUseId` primary-key join — the whole product bet.
    const panel = render('canvas');
    const run = await hostRun(panel);

    let checked = 0;
    for (const [sessionId, state] of run.states) {
      const edges = state.spawnEdges ?? [];
      if (edges.length === 0) continue;
      activate(blob(panel.container, sessionId));

      const cells = new Set(
        [...all(panel.container, TESTID.nucleus), ...all(panel.container, TESTID.cell)].map(
          (c) => c.dataset['agentId'],
        ),
      );
      // Both ends are CELLS now: the filament runs parent agent to child
      // agent since the dots stopped being drawn. The join it comes from is
      // unchanged and still carries both halves of the key.
      const placed = edges.filter((e) => cells.has(e.agentId) && cells.has(e.parentNodeId));

      const drawn = all(panel.container, TESTID.filament).map((f) => [
        f.dataset['toolUseId'],
        f.dataset['agentId'],
      ]);
      expect(drawn).toHaveLength(placed.length);
      for (const edge of placed) expect(drawn).toContainEqual([edge.toolUseId, edge.agentId]);
      checked += placed.length;

      harness.flushSync(() => {
        panel.store.escape();
      });
    }
    // The capture must carry at least one resolved join, or this test asserts
    // nothing. Loud failure beats a silent pass.
    expect(checked).toBeGreaterThan(0);
  });

  it('unsupported: a layout the real fingerprint refuses draws ZERO interior elements', async () => {
    // The same refusal the list half asserts, on the canvas: G3's "no tree at
    // all" restated as an element count of 0 (C7.4).
    const layout = await refusedLayout();
    const panel = render('canvas');
    const run = await hostRun(panel, async ({ model, slug }) => {
      model.ingestGraftResult(layout.sessionId, slug, await graftSession(layout.path));
    });

    const refused = run.states.get(layout.sessionId);
    expect(refused?.schemaOk).toBe(false);
    expect(run.wire.some((m) => m.type === 'schemaMismatch')).toBe(true);

    const cracked = blob(panel.container, layout.sessionId);
    expect(cracked.dataset['refused']).toBe('true');
    expect(cracked.dataset['liveness']).toBe('unsupported');
    expect(cracked.dataset['nodes']).toBe('0');

    activate(cracked);
    expect(one(panel.container, TESTID.canvas).dataset['refused']).toBe('true');
    for (const testId of [
      TESTID.nucleus,
      TESTID.cell,
      TESTID.dot,
      TESTID.filament,
      TESTID.parkedStub,
      TESTID.elidedBadge,
    ]) {
      expect(all(panel.container, testId), testId).toHaveLength(0);
    }
  });

  it('G4: no thinking signature bytes reach the canvas, inspector included', async () => {
    const panel = render('canvas');
    const run = await hostRun(panel);

    // Open every dot and cell of every session in turn, so the assertion is
    // about what CAN be shown rather than about what happens to be collapsed.
    for (const sessionId of run.states.keys()) {
      activate(blob(panel.container, sessionId));
      const pickable = [
        ...all(panel.container, TESTID.nucleus),
        ...all(panel.container, TESTID.cell),
        ...all(panel.container, TESTID.dot),
      ];
      for (const element of pickable) {
        activate(element);
        const expand = all(panel.container, 'inspector-expand')[0];
        if (expand !== undefined) activate(expand);
      }
      harness.flushSync(() => {
        panel.store.escape();
        panel.store.escape();
      });
    }
    const shown = panel.container.textContent ?? '';
    expect(shown.length).toBeGreaterThan(0);

    const signatures: string[] = [];
    for (const sessionId of run.sessionIds) {
      const text = await readFile(join(run.slugDir, `${sessionId}.jsonl`), 'utf8');
      for (const match of text.matchAll(/"signature":"([^"\\]{40,})"/g)) {
        const value = match[1];
        if (value !== undefined) signatures.push(value);
      }
    }
    expect(signatures.length).toBeGreaterThan(0);
    for (const signature of signatures) {
      expect(shown).not.toContain(signature.slice(0, 64));
    }
    expect(shown).not.toContain('signature');
    expect(shown).not.toContain('"thinking"');
  });
});
