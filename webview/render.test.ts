// @vitest-environment jsdom
//
// THE LIST SURFACE — Phase 3's session rail and indented tree, kept for one
// release behind the in-panel toggle (C7.2) and asserted for as long as it
// ships.
//
// WHY EVERY MOUNT HERE SWITCHES THE VIEW MODE. The canvas is the default
// immediately and there is no setting, so a freshly mounted panel shows the
// deck. This file is about the OTHER surface, so `render()` calls
// `store.setViewMode('list')` once, at mount, before any message is fed. That
// call is the only difference from Phase 3's version of this file: the
// assertions below are unchanged, which is the point — "kept, not deleted"
// means the list view's behaviour did not move.
//
// The cross-cutting matrix that runs the same rows against BOTH surfaces is
// `states.test.ts`. This file is the list surface's own depth: expand and
// collapse, per-node tokens and durations, payload previews, diff handling.
//
// The host suites are node suites and stay that way; only the component tests
// opt into a DOM, per file.
//
// These tests mount the REAL bundle: `testkit.ts` runs the same esbuild +
// Svelte pipeline `npm run build` runs and evaluates the output here. There is
// no vitest svelte plugin in this repo, and adding one means editing
// `vitest.config.ts`, which this package does not own.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WebviewToHostMessage } from '../src/model/events.js';
import type { Store } from './store.js';
import type { WebviewHarness } from './testkit.js';
import { all, loadHarness, one } from './testkit.js';
import { TESTID } from './canvas-contract.js';
import { COLLAPSED_PREVIEW_CHARS, EM_DASH } from './format.js';
import { liveSession, longPreview, unsupportedSession } from './testdata.js';

let harness: WebviewHarness;

beforeAll(async () => {
  harness = await loadHarness();
}, 60_000);

interface Mounted {
  container: HTMLElement;
  store: Store;
  sent: WebviewToHostMessage[];
  dispose: () => void;
}

const mounted: Mounted[] = [];

function render(): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const sent: WebviewToHostMessage[] = [];
  const started = harness.start(container, { postMessage: (m) => sent.push(m) });
  // The list surface, chosen before any message arrives. Through the store
  // rather than the toggle button: the button has its own row in
  // `states.test.ts`, and a mount that depended on it would fail twice over if
  // it broke.
  harness.flushSync(() => {
    started.store.setViewMode('list');
  });
  const record: Mounted = {
    container,
    store: started.store,
    sent,
    dispose: () => {
      started.dispose();
      container.remove();
    },
  };
  mounted.push(record);
  return record;
}

/** Feed a host message the way VS Code does — through `window.postMessage`. */
function send(message: unknown): void {
  harness.flushSync(() => {
    globalThis.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

function click(element: HTMLElement): void {
  harness.flushSync(() => {
    element.click();
  });
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

describe('live session render', () => {
  it('draws the trunk, its leaves, chips, tokens and durations', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });

    const nodes = all(container, 'tree-node');
    expect(nodes.map((n) => n.dataset['nodeId'])).toEqual([
      'root',
      'tool-read',
      'tool-agent-1',
      'agent-1',
      'tool-agent-2',
      'agent-2',
      'tool-bash',
    ]);

    const root = nodes[0];
    expect(root?.dataset['kind']).toBe('agent');
    // `one()` would not do here: a node element CONTAINS its descendants'
    // labels, so the first match is the node's own.
    expect(all(root as HTMLElement, 'node-label')[0]?.textContent).toContain('main session');

    // Status chips, one per node, carrying the three spec'd states.
    const chips = all(container, 'status-chip').map((c) => c.dataset['status']);
    expect(chips).toContain('running');
    expect(chips).toContain('done');
    expect(chips).toContain('error');

    // Per-node tokens and durations.
    const rootTokens = all(root as HTMLElement, 'node-tokens')[0];
    // `contextNow`, the LEVEL, is what a node shows - not `burn`. testdata's
    // root is contextNow 12,345/6,789 and burn 24,690/13,578, so asserting the
    // first proves the node reads the level rather than the total.
    expect(rootTokens?.textContent).toContain('12,345 in ctx');
    expect(rootTokens?.textContent).toContain('6,789 out');
    expect(rootTokens?.textContent).not.toContain('24,690');

    const readNode = nodes.find((n) => n.dataset['nodeId'] === 'tool-read');
    expect(all(readNode as HTMLElement, 'node-duration')[0]?.textContent?.trim()).toBe('1.5s');

    const bashNode = nodes.find((n) => n.dataset['nodeId'] === 'tool-bash');
    expect(all(bashNode as HTMLElement, 'node-duration')[0]?.textContent?.trim()).toBe('75ms');
  });

  it('lists the workspace sessions in the rail and posts selectSession on click', () => {
    const { container, sent } = render();
    send({ type: 'snapshot', sessions: [liveSession(), unsupportedSession()] });

    const items = all(container, 'rail-item');
    expect(items.map((i) => i.dataset['sessionId'])).toEqual([
      'session-live',
      'session-unsupported',
    ]);
    expect(items[0]?.dataset['selected']).toBe('true');

    click(items[1] as HTMLElement);
    expect(sent).toEqual([{ type: 'selectSession', sessionId: 'session-unsupported' }]);
    expect(all(container, 'rail-item')[1]?.dataset['selected']).toBe('true');
  });

  it('renders the header with context and burn, and no currency figure', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });

    const header = one(container, 'session-header');
    // Two DIFFERENT numbers, which is the whole point of the split: context is
    // the root's level, burn is the tree's total.
    expect(one(header, 'header-context').textContent?.trim()).toBe('17,745');
    expect(one(header, 'header-burn').textContent?.trim()).toBe('35,490');

    // `costUsd` is 0 and 0 means NOT COMPUTED, never "free". "$0.00" would be
    // a fabricated claim; there is no price table in this repo.
    const cost = one(header, 'header-cost');
    expect(cost.textContent?.trim()).toBe(EM_DASH);
    expect(cost.getAttribute('title')).toContain('no price table');
    expect(header.textContent).not.toContain('$');
  });
});

describe('spawnEdges drive the nesting', () => {
  it('draws a subagent under the tool call that spawned it, at depth 2', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });

    const spawningTool = all(container, 'tree-node').find(
      (n) => n.dataset['nodeId'] === 'tool-agent-1',
    );
    const nestedAgent = all(spawningTool as HTMLElement, 'tree-node').find(
      (n) => n.dataset['nodeId'] === 'agent-1',
    );
    expect(nestedAgent).toBeDefined();
    expect(nestedAgent?.dataset['spawnedBy']).toBe('tool-agent-1');

    // ...and the depth-2 subagent, under ITS spawning tool call, inside that.
    const depth2 = all(nestedAgent as HTMLElement, 'tree-node').find(
      (n) => n.dataset['nodeId'] === 'agent-2',
    );
    expect(depth2).toBeDefined();
    expect(depth2?.dataset['spawnDepth']).toBe('2');
    expect(depth2?.dataset['spawnedBy']).toBe('tool-agent-2');
    const tool2 = all(nestedAgent as HTMLElement, 'tree-node').find(
      (n) => n.dataset['nodeId'] === 'tool-agent-2',
    );
    expect(tool2?.contains(depth2 as Node)).toBe(true);
  });

  it('does NOT nest the subagent when the spawn edge is removed', () => {
    // `ToolNode` has no `children` field, so without the edge the subagent is
    // simply a sibling. This is the assertion that proves the render reads
    // `spawnEdges` rather than the tree shape.
    const session = liveSession();
    const { container } = render();
    send({
      type: 'snapshot',
      sessions: [
        {
          ...session,
          spawnEdges: (session.spawnEdges ?? []).filter((e) => e.agentId !== 'agent-1'),
        },
      ],
    });

    const spawningTool = all(container, 'tree-node').find(
      (n) => n.dataset['nodeId'] === 'tool-agent-1',
    );
    expect(
      all(spawningTool as HTMLElement, 'tree-node').filter(
        (n) => n.dataset['nodeId'] === 'agent-1',
      ),
    ).toHaveLength(0);
    // Still rendered, just adjacent rather than nested.
    expect(
      all(container, 'tree-node').filter((n) => n.dataset['nodeId'] === 'agent-1'),
    ).toHaveLength(1);
  });
});

describe('refusal (G3)', () => {
  it('renders the refusal screen and NO tree node at all', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [unsupportedSession()] });

    const refusal = one(container, 'refusal-screen');
    expect(one(refusal, 'refusal-session-id').textContent).toContain('session-unsupported');

    // Not "a tree with a warning" — no tree.
    expect(all(container, 'tree-node')).toHaveLength(0);
    expect(all(container, 'tree')).toHaveLength(0);
    expect(all(container, 'session-header')).toHaveLength(0);
    expect(all(container, 'status-chip')).toHaveLength(0);
  });

  it('refuses on a schemaMismatch message arriving after a good snapshot', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    expect(all(container, 'tree-node').length).toBeGreaterThan(0);

    send({ type: 'schemaMismatch', sessionId: 'session-live' });
    expect(all(container, 'refusal-screen')).toHaveLength(1);
    expect(all(container, 'tree-node')).toHaveLength(0);
  });

  it('leaves other sessions rendering normally', () => {
    const { container, sent } = render();
    send({ type: 'snapshot', sessions: [unsupportedSession(), liveSession()] });
    expect(all(container, 'refusal-screen')).toHaveLength(1);

    const liveItem = all(container, 'rail-item').find(
      (i) => i.dataset['sessionId'] === 'session-live',
    );
    click(liveItem as HTMLElement);
    expect(sent).toContainEqual({ type: 'selectSession', sessionId: 'session-live' });
    expect(all(container, 'refusal-screen')).toHaveLength(0);
    expect(all(container, 'tree-node').length).toBeGreaterThan(0);
  });
});

describe('degraded banner (spec C4: informative, not nagging)', () => {
  it('renders the banner and keeps the tree underneath', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    send({ type: 'degraded', degraded: true, reason: 'noHookEvents' });

    const banner = one(container, 'degraded-banner');
    expect(banner.textContent).toContain('no hook events received');
    // G2: losing the hook tap costs liveness, not content.
    expect(all(container, 'tree-node').length).toBeGreaterThan(0);
  });

  it('stays dismissed while the same degraded message repeats', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    send({ type: 'degraded', degraded: true, reason: 'listenerDown' });
    click(one(container, 'degraded-dismiss'));
    expect(all(container, 'degraded-banner')).toHaveLength(0);

    for (let i = 0; i < 10; i += 1) {
      send({ type: 'degraded', degraded: true, reason: 'listenerDown' });
    }
    expect(all(container, 'degraded-banner')).toHaveLength(0);
  });

  it('disappears when the tap recovers', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    send({ type: 'degraded', degraded: true, reason: 'listenerDown' });
    expect(all(container, 'degraded-banner')).toHaveLength(1);
    send({ type: 'degraded', degraded: false });
    expect(all(container, 'degraded-banner')).toHaveLength(0);
  });
});

describe('expand and collapse', () => {
  function previewOf(container: HTMLElement, nodeId: string, label: string): HTMLElement {
    const node = all(container, 'tree-node').find((n) => n.dataset['nodeId'] === nodeId);
    const preview = all(node as HTMLElement, 'payload-preview').find(
      (p) => p.dataset['label'] === label,
    );
    if (preview === undefined) throw new Error(`no ${label} preview on ${nodeId}`);
    return preview;
  }

  it('shows ~512 characters plus a marker while collapsed, and the whole string when expanded', () => {
    const full = longPreview();
    const { container, sent } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });

    // `tool-read.resultPreview` stands in for a payload the host sourced from
    // `tool-results/<id>.txt`. From here it is just a long string.
    const collapsed = previewOf(container, 'tool-read', 'result');
    const body = one(collapsed, 'preview-body');
    expect(body.textContent).toHaveLength(COLLAPSED_PREVIEW_CHARS);
    expect(body.textContent).toBe(full.slice(0, COLLAPSED_PREVIEW_CHARS));
    expect(one(collapsed, 'preview-marker').textContent).toContain(
      String(full.length - COLLAPSED_PREVIEW_CHARS),
    );

    const node = all(container, 'tree-node').find((n) => n.dataset['nodeId'] === 'tool-read');
    click(all(node as HTMLElement, 'toggle')[0] as HTMLElement);

    const expanded = previewOf(container, 'tool-read', 'result');
    expect(one(expanded, 'preview-body').textContent).toBe(full);
    expect(one(expanded, 'preview-body').textContent).toHaveLength(2000);
    expect(all(expanded, 'preview-marker')).toHaveLength(0);

    // Expanding is a pure UI intent: one message out, nothing requested back.
    expect(sent).toEqual([
      { type: 'expandNode', sessionId: 'session-live', nodeId: 'tool-read' },
    ]);
  });

  it('collapses again on a second click', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    const node = (): HTMLElement =>
      all(container, 'tree-node').find((n) => n.dataset['nodeId'] === 'tool-read') as HTMLElement;

    click(all(node(), 'toggle')[0] as HTMLElement);
    expect(node().dataset['expanded']).toBe('true');
    click(all(node(), 'toggle')[0] as HTMLElement);
    expect(node().dataset['expanded']).toBe('false');
    expect(one(previewOf(container, 'tool-read', 'result'), 'preview-body').textContent)
      .toHaveLength(COLLAPSED_PREVIEW_CHARS);
  });

  it('does not mark a short preview as truncated', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    const preview = previewOf(container, 'tool-bash', 'result');
    expect(one(preview, 'preview-body').textContent).toBe('error: exit 2');
    expect(all(preview, 'preview-marker')).toHaveLength(0);
  });

  it('collapses a branch, hiding its subtree, and re-expands it', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });

    const agent1 = (): HTMLElement =>
      all(container, 'tree-node').find((n) => n.dataset['nodeId'] === 'agent-1') as HTMLElement;
    expect(all(agent1(), 'tree-node').length).toBeGreaterThan(0);

    click(all(agent1(), 'toggle')[0] as HTMLElement);
    expect(agent1().dataset['expanded']).toBe('false');
    expect(all(agent1(), 'tree-node')).toHaveLength(0);

    click(all(agent1(), 'toggle')[0] as HTMLElement);
    expect(all(agent1(), 'tree-node').length).toBeGreaterThan(0);
  });
});

describe('diff handling in the mounted renderer', () => {
  it('applies a diff to the rendered tree', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    send({
      type: 'diff',
      sessionId: 'session-live',
      patch: {
        fields: {
          contextNow: { prompt: 30_000, output: 11_000 },
          burn: { prompt: 61_000, output: 22_000 },
        },
        tree: [{ op: 'updateTool', id: 'tool-agent-2', fields: { status: 'done' } }],
      },
    });

    expect(one(container, 'header-context').textContent?.trim()).toBe('30,000');
    expect(one(container, 'header-burn').textContent?.trim()).toBe('61,000');
    const tool2 = all(container, 'tree-node').find(
      (n) => n.dataset['nodeId'] === 'tool-agent-2',
    );
    expect(all(tool2 as HTMLElement, 'status-chip')[0]?.dataset['status']).toBe('done');
  });

  it('survives an inapplicable diff and keeps the last good tree on screen', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    send({
      type: 'diff',
      sessionId: 'session-live',
      patch: { tree: [{ op: 'removeNode', id: 'not-here' }] },
    });

    expect(all(container, 'patch-failure')).toHaveLength(1);
    expect(all(container, 'tree-node')).toHaveLength(7);

    send({ type: 'snapshot', sessions: [liveSession()] });
    expect(all(container, 'patch-failure')).toHaveLength(0);
  });

  it('ignores a message shape it does not recognise', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    send({ type: 'somethingElse', payload: 1 });
    send(null);
    send('a string');
    expect(all(container, 'tree-node')).toHaveLength(7);
  });
});

describe('statelessness of the mounted renderer', () => {
  it('renders identical markup for the same snapshot fed twice', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [liveSession()] });
    const first = container.innerHTML;
    send({ type: 'snapshot', sessions: [liveSession()] });
    expect(container.innerHTML).toBe(first);
  });

  it('accumulates no nodes over 25 identical snapshots', () => {
    const { container } = render();
    for (let i = 0; i < 25; i += 1) {
      send({ type: 'snapshot', sessions: [liveSession()] });
    }
    expect(all(container, 'tree-node')).toHaveLength(7);
    expect(all(container, 'rail-item')).toHaveLength(1);
  });
});

describe('auto-start', () => {
  it('mounts nothing when acquireVsCodeApi is absent', async () => {
    // Evaluating the bundle outside a VS Code webview must be inert; otherwise
    // every test file that loads the harness would silently mount an app into
    // document.body, and every assertion above would be measuring two
    // renderers at once.
    document.body.innerHTML = '';
    await loadHarness();
    expect(all(document.body, 'app')).toHaveLength(0);
  });

  it('mounts into document.body inside a webview with no #agent-deck-root', async () => {
    // The extension host owns the webview HTML. Requiring a specific element id
    // would make "blank panel, no error" the failure mode if the host happened
    // to use a different one, so the id is a preference, not a requirement.
    document.body.innerHTML = '';
    const withApi = globalThis as unknown as { acquireVsCodeApi?: unknown };
    withApi.acquireVsCodeApi = () => ({ postMessage: () => {} });
    try {
      await loadHarness();
      expect(all(document.body, 'app')).toHaveLength(1);
      // The DECK, not the rail: an auto-started panel has had no `setViewMode`
      // call, so what it comes up in is the shipped default (C7.2). This is
      // the assertion that would notice the default silently changing.
      expect(all(document.body, TESTID.deck)).toHaveLength(1);
      expect(all(document.body, 'session-rail')).toHaveLength(0);
    } finally {
      delete withApi.acquireVsCodeApi;
      document.body.innerHTML = '';
    }
  });

  it('prefers #agent-deck-root when the host provides it', async () => {
    document.body.innerHTML = '<div id="agent-deck-root"></div>';
    const root = document.getElementById('agent-deck-root');
    const withApi = globalThis as unknown as { acquireVsCodeApi?: unknown };
    withApi.acquireVsCodeApi = () => ({ postMessage: () => {} });
    try {
      await loadHarness();
      expect(all(root as HTMLElement, 'app')).toHaveLength(1);
    } finally {
      delete withApi.acquireVsCodeApi;
      document.body.innerHTML = '';
    }
  });
});
