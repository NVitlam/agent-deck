/**
 * Agent Deck — extension host tests.
 *
 * What is real here and what is doubled, because that ratio is the point:
 *
 *   REAL   `SessionModel`, `LivenessEngine`, `TreeGrafter` (via `graftSession`),
 *          `ProjectWatcher`, `SessionTailer`, `HookListener` (a genuinely bound
 *          loopback socket), `SessionBridge`, `webviewHtml`, and the committed
 *          fixtures under `fixtures/`.
 *   DOUBLE `vscode` only — it does not exist outside the extension host. The
 *          double is `test/vscode-mock.ts`, reached through the one
 *          `resolve.alias` this package added to `vitest.config.ts`.
 *
 * The panel is exercised through {@link PanelSurface}, a plain object, so the
 * bridge/guard/reload behaviour is tested without pretending to reimplement the
 * editor.
 *
 * Fixture roots and workspace paths are DERIVED, never named: the workspace the
 * capture was taken in is read out of the transcripts' own `cwd`, so a
 * re-harvest on another machine needs no edit here. No test asserts the size of
 * the fixture set.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentDeckDataPath,
  AgentDeckHost,
  CONFIG_SECTION,
  DEFAULT_LIVENESS_THRESHOLD_MS,
  DEFAULT_PORT,
  DEFAULT_PREVIEW_BYTES,
  OPEN_COMMAND,
  PanelController,
  WEBVIEW_SCRIPT_SEGMENTS,
  WEBVIEW_STYLE_SEGMENTS,
  activate,
  currentHost,
  deactivate,
  readSettings,
} from './extension.js';
import type {
  AgentDeckSettings,
  DataPathEmission,
  PanelSurface,
  Unsubscribe,
} from './extension.js';
import { webviewHtml } from './bridge/html.js';
import { WEBVIEW_ROOT_ID } from './bridge/contract.js';
import type { HostToWebviewMessage, SessionState, TreeNode } from './model/events.js';
import { isAgentNode } from './model/events.js';
import { slugifyWorkspace, snapshotTree } from './parser/tailer.js';
import type { TreeSnapshotEntry } from './parser/tailer.js';
import {
  createExtensionContext,
  mock,
  resetVscodeMock,
} from '../test/vscode-mock.js';

// ---------------------------------------------------------------------------
// Fixture roots — derived, never assumed
// ---------------------------------------------------------------------------

const CAPTURED_ROOT = fileURLToPath(
  new URL('../fixtures/cc-2.1.234/projects', import.meta.url),
);
const LAYOUT_ROOT = fileURLToPath(new URL('../fixtures/synthetic-layout', import.meta.url));
const SYNTHETIC_SLUG = 'SYNTHETIC-hand-mutated-not-captured';
const EXTENSION_SOURCE = fileURLToPath(new URL('./extension.ts', import.meta.url));

/** The one slug directory in the captured root, read rather than named. */
async function capturedSlugDir(): Promise<string> {
  const entries = await readdir(CAPTURED_ROOT, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  expect(dirs.length).toBeGreaterThan(0);
  return join(CAPTURED_ROOT, dirs[0] as string);
}

/** `<sessionId>.jsonl` files in a slug directory. */
async function sessionIdsIn(slugDir: string): Promise<string[]> {
  const entries = await readdir(slugDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => e.name.replace(/\.jsonl$/, ''))
    .sort();
}

/**
 * The workspace path the capture was taken in, read from a transcript's own
 * `cwd`. Same string CC itself slug-encoded, so `slugifyWorkspace` of it
 * round-trips to the directory on disk.
 */
async function capturedWorkspacePath(): Promise<string> {
  const slugDir = await capturedSlugDir();
  for (const sessionId of await sessionIdsIn(slugDir)) {
    const text = await readFile(join(slugDir, `${sessionId}.jsonl`), 'utf8');
    const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text);
    if (match?.[1] === undefined) continue;
    const decoded = JSON.parse(`"${match[1]}"`) as string;
    if (decoded !== '') return decoded;
  }
  throw new Error('no cwd found in the captured transcripts');
}

// ---------------------------------------------------------------------------
// Temp scaffolding — the only place anything is ever written (OS temp, not the repo)
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-deck-ext-'));
  tempRoots.push(dir);
  return dir;
}

interface StagedFixture {
  projectsRoot: string;
  workspacePath: string;
  slug: string;
  slugDir: string;
  sessionIds: string[];
}

/**
 * Copy a committed slug directory into a temp projects root, renamed to the
 * slug of a temp workspace path.
 *
 * The mutation itself stays in `fixtures/` (G6); only its LOCATION changes, so
 * a workspace-matching correlation is possible for a directory whose committed
 * name (`SYNTHETIC-hand-mutated-not-captured`) encodes no workspace at all.
 */
async function stageFixtureSlug(sourceSlugDir: string): Promise<StagedFixture> {
  const projectsRoot = await makeTempDir();
  const workspacePath = join(await makeTempDir(), 'ws');
  const slug = slugifyWorkspace(workspacePath);
  const slugDir = join(projectsRoot, slug);
  await cp(sourceSlugDir, slugDir, { recursive: true });
  return {
    projectsRoot,
    workspacePath,
    slug,
    slugDir,
    sessionIds: await sessionIdsIn(slugDir),
  };
}

/**
 * `vscode.ExtensionContext` carries fifteen members `activate` never touches —
 * including `workspaceState` and `globalState`, which G7 forbids using at all.
 * The double supplies the two that are used; this is where that is admitted,
 * once, instead of at five call sites.
 */
function extensionContext(): Parameters<typeof activate>[0] {
  return createExtensionContext() as unknown as Parameters<typeof activate>[0];
}

/** A free loopback port, taken and released. */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** Hold a port so the next bind on it collides. */
async function holdPort(port: number): Promise<() => Promise<void>> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
}

function settings(overrides: Partial<AgentDeckSettings> = {}): AgentDeckSettings {
  return {
    port: DEFAULT_PORT,
    livenessThresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
    previewBytes: DEFAULT_PREVIEW_BYTES,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A fake panel surface
// ---------------------------------------------------------------------------

interface FakePanel {
  surface: PanelSurface;
  posted: HostToWebviewMessage[];
  html: string | null;
  disposeCount: number;
  revealCount: number;
  /** Live subscriptions. Must fall to 0 when the controller is disposed. */
  liveSubscriptions: number;
  fireMessage(raw: unknown): void;
  fireBecameVisible(): void;
  fireDisposed(): void;
}

function fakePanel(options: { throwOnPost?: boolean } = {}): FakePanel {
  const messageHandlers = new Set<(raw: unknown) => void>();
  const visibleHandlers = new Set<() => void>();
  const disposeHandlers = new Set<() => void>();

  const subscribe = <T>(set: Set<T>, handler: T): Unsubscribe => {
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  };

  const fake: FakePanel = {
    posted: [],
    html: null,
    disposeCount: 0,
    revealCount: 0,
    get liveSubscriptions(): number {
      return messageHandlers.size + visibleHandlers.size + disposeHandlers.size;
    },
    fireMessage: (raw: unknown) => {
      for (const handler of [...messageHandlers]) handler(raw);
    },
    fireBecameVisible: () => {
      for (const handler of [...visibleHandlers]) handler();
    },
    fireDisposed: () => {
      for (const handler of [...disposeHandlers]) handler();
    },
    surface: {
      cspSource: 'vscode-resource://agent-deck-test',
      setHtml: (html: string) => {
        fake.html = html;
      },
      asWebviewUri: (...segments: string[]) => `webview://ext/${segments.join('/')}`,
      postMessage: (message: HostToWebviewMessage) => {
        if (options.throwOnPost === true) throw new Error('panel disposed');
        fake.posted.push(message);
      },
      onDidReceiveMessage: (handler) => subscribe(messageHandlers, handler),
      onDidBecomeVisible: (handler) => subscribe(visibleHandlers, handler),
      onDidDispose: (handler) => subscribe(disposeHandlers, handler),
      reveal: () => {
        fake.revealCount += 1;
      },
      dispose: () => {
        fake.disposeCount += 1;
      },
    },
  };
  return fake;
}

// ---------------------------------------------------------------------------
// Teardown — a leaked watcher, socket or timer hangs vitest, which IS the failure
// ---------------------------------------------------------------------------

const liveDataPaths: AgentDeckDataPath[] = [];
const liveHosts: AgentDeckHost[] = [];

function trackDataPath(path: AgentDeckDataPath): AgentDeckDataPath {
  liveDataPaths.push(path);
  return path;
}

function trackHost(host: AgentDeckHost): AgentDeckHost {
  liveHosts.push(host);
  return host;
}

beforeEach(() => {
  resetVscodeMock();
});

afterEach(async () => {
  await deactivate();
  for (const host of liveHosts.splice(0)) await host.dispose();
  for (const path of liveDataPaths.splice(0)) await path.dispose();
  for (const dir of tempRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (1) Settings
// ---------------------------------------------------------------------------

describe('readSettings', () => {
  it('uses the decided defaults when nothing is configured', () => {
    expect(readSettings(undefined)).toStrictEqual({
      port: 47821,
      livenessThresholdMs: 120000,
      previewBytes: 8192,
    });
  });

  it('honours configured values', () => {
    const read = readSettings({
      get: (key) =>
        ({ port: 50000, livenessThresholdMs: 90000, previewBytes: 512 })[key],
    });
    expect(read).toStrictEqual({
      port: 50000,
      livenessThresholdMs: 90000,
      previewBytes: 512,
    });
  });

  it('falls back to the manifest default on an unusable value, never to a guess', () => {
    // Port 0 is the one value that must NOT be honoured: it means "bind
    // ephemeral", and the port decision refuses ephemeral binding outright.
    const cases: Record<string, unknown>[] = [
      { port: 0 },
      { port: -1 },
      { port: 70000 },
      { port: '47821' },
      { port: 47821.5 },
      { livenessThresholdMs: 0 },
      { livenessThresholdMs: null },
      { previewBytes: -1 },
      { previewBytes: Number.NaN },
    ];
    for (const values of cases) {
      const read = readSettings({ get: (key) => values[key] });
      expect(read).toStrictEqual(settings());
    }
  });
});

// ---------------------------------------------------------------------------
// (2) The panel
// ---------------------------------------------------------------------------

describe('PanelController', () => {
  /**
   * `added` defaults to EMPTY, not to "every session".
   *
   * `SessionBridge` forces a fresh snapshot whenever the session set changed,
   * so a helper that reported every session as added on every call would make
   * every publish a snapshot — and the "publishing an unchanged state sends
   * nothing" assertion below would pass for the wrong reason.
   */
  function emission(
    sessions: SessionState[],
    options: { degraded?: boolean; added?: string[] } = {},
  ): DataPathEmission {
    return {
      emission: {
        sessions,
        diffs: [],
        addedSessionIds: options.added ?? [],
        removedSessionIds: [],
        schemaMismatchSessionIds: [],
      },
      degraded:
        options.degraded === true
          ? { degraded: true, reason: 'noHookEvents' }
          : { degraded: false },
    };
  }

  function state(sessionId: string): SessionState {
    return {
      sessionId,
      projectSlug: 'slug',
      workspaceMatch: true,
      liveness: 'live',
      schemaOk: true,
      root: {
        id: 'root',
        kind: 'main',
        label: sessionId,
        status: 'running',
        spawnDepth: 0,
        children: [],
        tokens: { in: 0, out: 0 },
        startedAt: 0,
      },
      totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      spawnEdges: [],
    };
  }

  it('emits exactly the document webviewHtml produces — no second CSP anywhere', () => {
    const panel = fakePanel();
    const controller = new PanelController({ panel: panel.surface, nonce: 'AAAAAAAA' });
    const expected = webviewHtml({
      scriptUri: `webview://ext/${WEBVIEW_SCRIPT_SEGMENTS.join('/')}`,
      styleUri: `webview://ext/${WEBVIEW_STYLE_SEGMENTS.join('/')}`,
      nonce: 'AAAAAAAA',
      cspSource: 'vscode-resource://agent-deck-test',
    });
    expect(panel.html).toBe(expected);
    // The three properties the bridge package flagged as silent breakers.
    expect(panel.html).toContain(`<div id="${WEBVIEW_ROOT_ID}"></div>`);
    expect(panel.html).not.toContain('type="module"');
    expect(panel.html).not.toContain('img-src');
    controller.dispose();
  });

  it('drops webview messages that fail the guard, and forwards the ones that pass', () => {
    const panel = fakePanel();
    const seen: unknown[] = [];
    const controller = new PanelController({
      panel: panel.surface,
      nonce: 'AAAAAAAA',
      onMessage: (message) => {
        seen.push(message);
      },
    });

    for (const hostile of [
      null,
      42,
      'expandNode',
      [],
      { type: 'expandNode' },
      { type: 'expandNode', sessionId: '', nodeId: 'n' },
      { type: 'selectSession', sessionId: 7 },
      { type: 'evalNode', sessionId: 's', nodeId: 'n' },
      // `{ __proto__: ... }` in an object literal SETS the prototype and is not
      // an own property, so it is a well-formed message with an odd prototype
      // and the guard is right to accept it. `JSON.parse` is the shape that
      // actually arrives over `postMessage`: there `__proto__` IS an own
      // property, and that is what must be refused.
      JSON.parse('{"type":"selectSession","sessionId":"s","__proto__":{"x":1}}'),
      JSON.parse('{"type":"expandNode","sessionId":"s","nodeId":"n","constructor":1}'),
    ]) {
      panel.fireMessage(hostile);
    }
    expect(seen).toStrictEqual([]);
    expect(controller.counters.messagesDropped).toBe(10);

    panel.fireMessage({ type: 'selectSession', sessionId: 's1' });
    panel.fireMessage({ type: 'expandNode', sessionId: 's1', nodeId: 'n1' });
    expect(seen).toStrictEqual([
      { type: 'selectSession', sessionId: 's1' },
      { type: 'expandNode', sessionId: 's1', nodeId: 'n1' },
    ]);
    expect(controller.counters.messagesReceived).toBe(12);
    controller.dispose();
  });

  it('a webview reload resets the bridge, so the next publish is a full snapshot', () => {
    const panel = fakePanel();
    let snapshotsRequested = 0;
    const controller = new PanelController({
      panel: panel.surface,
      nonce: 'AAAAAAAA',
      onNeedsSnapshot: () => {
        snapshotsRequested += 1;
      },
    });

    controller.publish(emission([state('s1')], { added: ['s1'] }));
    expect(panel.posted.map((m) => m.type)).toStrictEqual(['snapshot', 'degraded']);

    // Publishing again with nothing changed sends nothing: no snapshot, and no
    // repeated degraded message.
    controller.publish(emission([state('s1')]));
    expect(panel.posted).toHaveLength(2);

    panel.fireBecameVisible();
    expect(controller.counters.reloads).toBe(1);
    expect(snapshotsRequested).toBe(1);

    controller.publish(emission([state('s1')]));
    expect(panel.posted.map((m) => m.type)).toStrictEqual([
      'snapshot',
      'degraded',
      'snapshot',
      'degraded',
    ]);
    controller.dispose();
  });

  it('degraded is announced once per transition, never per publish', () => {
    const panel = fakePanel();
    const controller = new PanelController({ panel: panel.surface, nonce: 'AAAAAAAA' });
    for (let i = 0; i < 12; i += 1) controller.publish(emission([state('s1')], { degraded: true }));
    const degraded = panel.posted.filter((m) => m.type === 'degraded');
    expect(degraded).toStrictEqual([
      { type: 'degraded', degraded: true, reason: 'noHookEvents' },
    ]);
    controller.publish(emission([state('s1')], { degraded: false }));
    expect(panel.posted.filter((m) => m.type === 'degraded')).toHaveLength(2);
    controller.dispose();
  });

  it('dispose drops every subscription and closes the panel exactly once', () => {
    const panel = fakePanel();
    const controller = new PanelController({
      panel: panel.surface,
      nonce: 'AAAAAAAA',
      onDispose: () => {},
    });
    expect(panel.liveSubscriptions).toBe(3);

    controller.dispose();
    expect(panel.liveSubscriptions).toBe(0);
    expect(panel.disposeCount).toBe(1);

    controller.dispose();
    expect(panel.disposeCount).toBe(1);

    // Nothing reaches a disposed controller.
    panel.fireMessage({ type: 'selectSession', sessionId: 's1' });
    controller.publish(emission([state('s1')]));
    expect(panel.posted).toStrictEqual([]);
  });

  it('a panel that throws on postMessage does not take the host down', () => {
    const panel = fakePanel({ throwOnPost: true });
    const controller = new PanelController({ panel: panel.surface, nonce: 'AAAAAAAA' });
    expect(() => {
      controller.publish(emission([state('s1')]));
    }).not.toThrow();
    expect(controller.bridge.counters.postFailures).toBeGreaterThan(0);
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// (3) The data path over real fixtures
// ---------------------------------------------------------------------------

describe('AgentDeckDataPath', () => {
  async function startOverCaptured(
    overrides: Partial<AgentDeckSettings> = {},
  ): Promise<{ path: AgentDeckDataPath; emissions: DataPathEmission[] }> {
    const workspacePath = await capturedWorkspacePath();
    const emissions: DataPathEmission[] = [];
    const path = trackDataPath(
      new AgentDeckDataPath({
        workspacePath,
        projectsRoot: CAPTURED_ROOT,
        settings: settings({ port: await freePort(), ...overrides }),
        tickMs: 0,
        onEmission: (payload) => {
          emissions.push(payload);
        },
      }),
    );
    await path.start();
    return { path, emissions };
  }

  it('renders the captured workspace: sessions, a tree, tokens, depth >= 2', async () => {
    const { path, emissions } = await startOverCaptured();

    expect(path.diagnostics.listening).toBe(true);
    expect(path.diagnostics.graftErrors).toBe(0);
    expect(emissions.length).toBeGreaterThan(0);

    const last = emissions[emissions.length - 1] as DataPathEmission;
    const sessions = last.emission.sessions;
    // Derived from the directory, never a pinned count.
    const slugDir = await capturedSlugDir();
    expect(sessions.map((s) => s.sessionId).sort()).toStrictEqual(
      await sessionIdsIn(slugDir),
    );

    for (const session of sessions) {
      expect(session.workspaceMatch).toBe(true);
      expect(session.schemaOk).toBe(true);
      // Cost is 0 = NOT YET COMPUTED, and nothing here computes it.
      expect(session.totals.costUsd).toBe(0);
    }

    const tokenBearing = sessions.filter(
      (s) => s.totals.inputTokens > 0 || s.totals.outputTokens > 0,
    );
    expect(tokenBearing.length).toBeGreaterThan(0);

    const deepest = Math.max(
      ...sessions.map((s) => maxSpawnDepth(s.root)),
    );
    expect(deepest).toBeGreaterThanOrEqual(2);
  });

  it('writes nothing: the watched tree is byte-identical before and after (G1)', async () => {
    const before = await snapshotTree(CAPTURED_ROOT);
    const { path } = await startOverCaptured();
    path.pump();
    await path.dispose();
    const after = await snapshotTree(CAPTURED_ROOT);
    expect(after).toStrictEqual(before);
    expect(sameBytes(before, after)).toBe(true);
  });

  it('a port collision is an explicit error and never a silent rebind', async () => {
    const port = await freePort();
    const release = await holdPort(port);
    try {
      const workspacePath = await capturedWorkspacePath();
      const errors: unknown[] = [];
      const path = trackDataPath(
        new AgentDeckDataPath({
          workspacePath,
          projectsRoot: CAPTURED_ROOT,
          settings: settings({ port }),
          tickMs: 0,
          onEmission: () => {},
          onError: (error) => {
            errors.push(error);
          },
        }),
      );
      await path.start();

      expect(errors).toHaveLength(1);
      expect(path.diagnostics.bindError?.code).toBe('EADDRINUSE');
      expect(path.diagnostics.bindError?.port).toBe(port);
      expect(path.diagnostics.listening).toBe(false);
      // No rebind: the configured port is still the configured port, and no
      // other socket was opened.
      expect(path.listener.port).toBe(port);
      expect(path.listener.address()).toBeNull();
      // G2: the content path started anyway.
      expect(path.diagnostics.grafts).toBeGreaterThan(0);
      expect(path.liveness.degradedState()).toStrictEqual({
        degraded: true,
        reason: 'listenerDown',
      });
    } finally {
      await release();
    }
  });

  it('dispose leaves no watcher, no socket and no timer', async () => {
    const workspacePath = await capturedWorkspacePath();
    const path = trackDataPath(
      new AgentDeckDataPath({
        workspacePath,
        projectsRoot: CAPTURED_ROOT,
        settings: settings({ port: await freePort() }),
        // The real tick interval, so a leaked tick would be a real leaked timer.
        onEmission: () => {},
      }),
    );
    await path.start();
    expect(path.diagnostics.timersArmed).toBe(1);
    expect(path.diagnostics.listening).toBe(true);

    await path.dispose();
    expect(path.diagnostics.timersArmed).toBe(0);
    expect(path.diagnostics.listening).toBe(false);
    expect(path.watcher.diagnostics.disposed).toBe(true);
    expect(path.listener.address()).toBeNull();

    // Post-dispose calls are no-ops rather than throws.
    path.pump();
    await path.dispose();
    expect(path.diagnostics.timersArmed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (4) Carry-forward A — the JSONL half of the liveness merge, end to end
// ---------------------------------------------------------------------------

describe('carry-forward A: liveness from a transcript mtime with zero hook events', () => {
  it('moves live -> idle purely from the transcript mtime', async () => {
    const staged = await stageFixtureSlug(join(LAYOUT_ROOT, '00-valid-control', SYNTHETIC_SLUG));
    const [sessionId] = staged.sessionIds as [string];
    const transcript = join(staged.slugDir, `${sessionId}.jsonl`);

    // A known mtime, set explicitly: reading the clock would make the
    // assertion depend on how long the copy took.
    const MTIME_MS = 1_700_000_000_000;
    await utimes(transcript, new Date(MTIME_MS), new Date(MTIME_MS));

    let now = MTIME_MS + 1_000;
    const path = trackDataPath(
      new AgentDeckDataPath({
        workspacePath: staged.workspacePath,
        projectsRoot: staged.projectsRoot,
        settings: settings({ port: await freePort(), livenessThresholdMs: 120_000 }),
        now: () => now,
        tickMs: 0,
        onEmission: () => {},
      }),
    );
    await path.start();

    // Preconditions, so a pass cannot come from the hook tap by accident.
    expect(path.liveness.counters().eventsReceived).toBe(0);
    const snapshot = path.model.livenessSnapshot(sessionId);
    expect(snapshot?.hookEventCount).toBe(0);
    // The pull source answered, and it answered with the mtime we set. This is
    // the fact Phase 2 could not produce: nothing pushed it, nothing guessed it.
    expect(snapshot?.mtimeMs).toBe(MTIME_MS);
    expect(snapshot?.inferenceOk).toBe(true);
    // `hasStopEntry` is omitted by design — there is no in-transcript Stop
    // marker in any fixture, so recency alone decides.
    expect(snapshot?.hasStopEntry).toBeUndefined();
    expect(path.model.sessionState(sessionId)?.schemaOk).toBe(true);

    // 1 s after the last append, inside the 120 s threshold.
    expect(path.model.sessionState(sessionId)?.liveness).toBe('live');

    // 121 s after the last append: nothing appended, no hook fired, only the
    // clock moved. The rendered state must move with it.
    now = MTIME_MS + 121_000;
    expect(path.model.sessionState(sessionId)?.liveness).toBe('idle');

    // Still zero hook events at the end: the whole transition came from JSONL.
    expect(path.liveness.counters().eventsReceived).toBe(0);
    expect(path.model.counters().hookEventsIngested).toBe(0);
  });

  it('a fresh append moves it back to live, and the emission carries the change', async () => {
    const staged = await stageFixtureSlug(join(LAYOUT_ROOT, '00-valid-control', SYNTHETIC_SLUG));
    const [sessionId] = staged.sessionIds as [string];
    const transcript = join(staged.slugDir, `${sessionId}.jsonl`);

    const BASE = 1_700_000_000_000;
    await utimes(transcript, new Date(BASE), new Date(BASE));

    // Fixed, and it stays fixed: this test moves the FILE, not the clock, so
    // the transition it proves cannot be an artefact of time passing.
    const now = BASE + 500_000; // far past the threshold
    const emissions: DataPathEmission[] = [];
    const path = trackDataPath(
      new AgentDeckDataPath({
        workspacePath: staged.workspacePath,
        projectsRoot: staged.projectsRoot,
        settings: settings({ port: await freePort() }),
        now: () => now,
        tickMs: 0,
        onEmission: (payload) => {
          emissions.push(payload);
        },
      }),
    );
    await path.start();
    expect(path.model.sessionState(sessionId)?.liveness).toBe('idle');

    // The transcript is touched — the same thing an append does to mtime — and
    // the clock stays put. Nothing else changes.
    await utimes(transcript, new Date(now), new Date(now));
    path.pump();

    expect(path.model.sessionState(sessionId)?.liveness).toBe('live');
    const last = emissions[emissions.length - 1] as DataPathEmission;
    const changed = last.emission.diffs.find((d) => d.sessionId === sessionId);
    expect(changed?.patch.fields?.liveness).toBe('live');
    expect(path.liveness.counters().eventsReceived).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (5) G3 — an R5 mutated fixture renders unsupported, with no tree
// ---------------------------------------------------------------------------

describe('a mutated layout renders unsupported and exposes no tree (G3)', () => {
  it('refuses end to end: graft -> model -> schemaMismatch on the wire', async () => {
    // `05-subagents-dir-renamed` is the committed hand-mutation: `subagents/`
    // renamed to `agents/`, i.e. exactly the undocumented-layout drift the
    // fingerprint exists to catch.
    const staged = await stageFixtureSlug(
      join(LAYOUT_ROOT, '05-subagents-dir-renamed', SYNTHETIC_SLUG),
    );
    const [sessionId] = staged.sessionIds as [string];

    const panel = fakePanel();
    const host = trackHost(
      new AgentDeckHost({
        workspacePath: staged.workspacePath,
        projectsRoot: staged.projectsRoot,
        settings: settings({ port: await freePort() }),
        tickMs: 0,
        nonce: 'AAAAAAAA',
        createPanel: () => panel.surface,
        onEmission: () => {},
      }),
    );
    host.open();
    await host.start();

    const path = host.dataPath;
    expect(path.diagnostics.graftRefusals).toBe(1);
    // A refusal is a typed answer, not a throw.
    expect(path.diagnostics.graftErrors).toBe(0);
    expect(path.model.counters().contentFailures).toBe(0);
    expect(path.model.refusalOf(sessionId)?.mismatch).toBeDefined();

    const state = path.model.sessionState(sessionId);
    expect(state?.schemaOk).toBe(false);
    expect(state?.liveness).toBe('unsupported');
    // No tree. Not a smaller tree — none.
    expect(state?.root.children).toStrictEqual([]);
    expect(state?.spawnEdges).toStrictEqual([]);
    expect(state?.totals).toStrictEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });

    const mismatches = panel.posted.filter((m) => m.type === 'schemaMismatch');
    expect(mismatches).toStrictEqual([{ type: 'schemaMismatch', sessionId }]);

    // And nothing that DID reach the webview carries a tree for this session.
    for (const message of panel.posted) {
      if (message.type !== 'snapshot') continue;
      for (const session of message.sessions) {
        if (session.sessionId !== sessionId) continue;
        expect(session.schemaOk).toBe(false);
        expect(countNodes(session.root)).toBe(1);
      }
    }

    // The mismatch is announced once, not on every emission (no nagging).
    for (let i = 0; i < 5; i += 1) path.pump();
    expect(panel.posted.filter((m) => m.type === 'schemaMismatch')).toHaveLength(1);

    // A panel opened AFTER the refusal never sees the transition message, so
    // its refusal screen has to come from the snapshot. `webview/store.ts`
    // treats `!schemaOk || liveness === 'unsupported'` as refused, which is why
    // that works — assert the snapshot carries both, or the refusal is
    // invisible to a panel opened one second too late.
    host.panel?.dispose();
    const later = fakePanel();
    const controller = new PanelController({ panel: later.surface, nonce: 'AAAAAAAA' });
    controller.publish({
      emission: path.model.emit(),
      degraded: path.liveness.degradedState(),
    });
    const snapshot = later.posted.find((m) => m.type === 'snapshot');
    expect(snapshot?.type).toBe('snapshot');
    const carried = snapshot?.type === 'snapshot' ? snapshot.sessions : [];
    expect(carried).toHaveLength(1);
    expect(carried[0]?.schemaOk).toBe(false);
    expect(carried[0]?.liveness).toBe('unsupported');
    expect(later.posted.filter((m) => m.type === 'schemaMismatch')).toStrictEqual([]);
    controller.dispose();
  });

  it('the valid control of the same fixture family renders a tree', async () => {
    // The negative control for the test above: if `00-valid-control` also
    // refused, the assertion up there would prove nothing about the mutation.
    const staged = await stageFixtureSlug(
      join(LAYOUT_ROOT, '00-valid-control', SYNTHETIC_SLUG),
    );
    const [sessionId] = staged.sessionIds as [string];
    const path = trackDataPath(
      new AgentDeckDataPath({
        workspacePath: staged.workspacePath,
        projectsRoot: staged.projectsRoot,
        settings: settings({ port: await freePort() }),
        tickMs: 0,
        onEmission: () => {},
      }),
    );
    await path.start();

    expect(path.diagnostics.graftRefusals).toBe(0);
    const state = path.model.sessionState(sessionId);
    expect(state?.schemaOk).toBe(true);
    expect(countNodes(state?.root)).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// (6) Degraded, without nagging
// ---------------------------------------------------------------------------

describe('degraded mode', () => {
  it('announces "no hook events" once, however many times the model emits', async () => {
    const workspacePath = await capturedWorkspacePath();
    const panel = fakePanel();
    const host = trackHost(
      new AgentDeckHost({
        workspacePath,
        projectsRoot: CAPTURED_ROOT,
        settings: settings({ port: await freePort() }),
        tickMs: 0,
        nonce: 'AAAAAAAA',
        createPanel: () => panel.surface,
        onEmission: () => {},
      }),
    );
    // Production order: `activate()` starts the data path and the command opens
    // the panel later. Opening BEFORE the bind would publish a real, honest
    // `listenerDown` first (the socket genuinely is not bound yet) and this
    // test would then be measuring its own setup rather than the no-nagging
    // rule.
    await host.start();
    host.open();

    for (let i = 0; i < 20; i += 1) host.dataPath.pump();

    const degraded = panel.posted.filter((m) => m.type === 'degraded');
    expect(degraded).toStrictEqual([
      { type: 'degraded', degraded: true, reason: 'noHookEvents' },
    ]);
    // The socket is bound and healthy; the reason is the absence of events,
    // which is the honest one.
    expect(host.dataPath.diagnostics.listening).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (7) The host: one panel, revealed rather than duplicated
// ---------------------------------------------------------------------------

describe('AgentDeckHost', () => {
  async function makeHost(): Promise<{ host: AgentDeckHost; panels: FakePanel[] }> {
    const workspacePath = await capturedWorkspacePath();
    const panels: FakePanel[] = [];
    const host = trackHost(
      new AgentDeckHost({
        workspacePath,
        projectsRoot: CAPTURED_ROOT,
        settings: settings({ port: await freePort() }),
        tickMs: 0,
        nonce: 'AAAAAAAA',
        createPanel: () => {
          const panel = fakePanel();
          panels.push(panel);
          return panel.surface;
        },
        onEmission: () => {},
      }),
    );
    return { host, panels };
  }

  it('opens one panel and reveals it on every later open', async () => {
    const { host, panels } = await makeHost();
    await host.start();

    const first = host.open();
    expect(host.panelsCreated).toBe(1);
    expect(panels).toHaveLength(1);

    expect(host.open()).toBe(first);
    expect(host.open()).toBe(first);
    expect(host.panelsCreated).toBe(1);
    expect(panels).toHaveLength(1);
    expect(panels[0]?.revealCount).toBe(2);
  });

  it('a brand-new panel is sent a full snapshot before anything else', async () => {
    const { host, panels } = await makeHost();
    await host.start();
    host.open();
    const first = panels[0]?.posted[0];
    expect(first?.type).toBe('snapshot');
  });

  it('closing the panel frees it, and the next open builds a new one', async () => {
    const { host, panels } = await makeHost();
    await host.start();
    host.open();
    panels[0]?.fireDisposed();
    expect(host.panel).toBeNull();

    host.open();
    expect(host.panelsCreated).toBe(2);
    expect(panels).toHaveLength(2);
    // The new webview knows nothing, so it too starts from a snapshot.
    expect(panels[1]?.posted[0]?.type).toBe('snapshot');
  });

  it('dispose closes the panel and the data path together', async () => {
    const { host, panels } = await makeHost();
    await host.start();
    host.open();
    await host.dispose();

    expect(panels[0]?.disposeCount).toBe(1);
    expect(panels[0]?.liveSubscriptions).toBe(0);
    expect(host.dataPath.diagnostics.listening).toBe(false);
    expect(host.dataPath.diagnostics.timersArmed).toBe(0);
    expect(host.open()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (8) activate / deactivate, through the vscode double
// ---------------------------------------------------------------------------

describe('activate', () => {
  const previousRoot = process.env['CLAUDE_PROJECTS_ROOT'];

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['CLAUDE_PROJECTS_ROOT'];
    else process.env['CLAUDE_PROJECTS_ROOT'] = previousRoot;
  });

  it('a matching workspace starts the data path and the command opens the panel', async () => {
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    const port = await freePort();
    mock.setWorkspaceFolder(await capturedWorkspacePath());
    mock.setConfig(CONFIG_SECTION, { port, previewBytes: 4096 });

    const context = extensionContext();
    await activate(context);

    const host = currentHost();
    expect(host).not.toBeNull();
    expect(host?.dataPath.settings).toStrictEqual(
      settings({ port, previewBytes: 4096 }),
    );
    expect(host?.dataPath.diagnostics.listening).toBe(true);
    expect(host?.dataPath.diagnostics.grafts).toBeGreaterThan(0);
    expect(mock.errorMessages).toStrictEqual([]);

    expect(mock.hasCommand(OPEN_COMMAND)).toBe(true);
    expect(mock.panels).toHaveLength(0);

    await mock.runCommand(OPEN_COMMAND);
    expect(mock.panels).toHaveLength(1);
    const panel = mock.panels[0];
    expect(panel?.webview.html).toContain(`<div id="${WEBVIEW_ROOT_ID}"></div>`);
    expect(panel?.webview.html).toContain("default-src 'none'");
    expect(panel?.webview.posted[0]).toMatchObject({ type: 'snapshot' });

    // Twice reveals rather than duplicates.
    await mock.runCommand(OPEN_COMMAND);
    expect(mock.panels).toHaveLength(1);
    expect(panel?.revealCount).toBe(1);

    // The real adapter is exercised here, not the fake surface: a message
    // arriving on the real webview event must still go through the guard.
    panel?.fireMessage({ nope: true });
    expect(host?.panel?.counters.messagesDropped).toBe(1);

    await deactivate();
    expect(host?.dataPath.diagnostics.listening).toBe(false);
    expect(host?.dataPath.diagnostics.timersArmed).toBe(0);
    expect(panel?.disposed).toBe(true);
    expect(currentHost()).toBeNull();
  });

  it('a NON-matching workspace starts nothing: no watcher, no socket, no timer', async () => {
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    const port = await freePort();
    const foreign = join(await makeTempDir(), 'not-a-cc-project');
    mock.setWorkspaceFolder(foreign);
    mock.setConfig(CONFIG_SECTION, { port });

    const context = extensionContext();
    await activate(context);

    // No host means no `AgentDeckDataPath`, which is the only thing that
    // constructs a watcher, a listener or a timer.
    expect(currentHost()).toBeNull();
    expect(mock.panels).toHaveLength(0);

    // Proved positively rather than by absence of a host: the configured port
    // is still free, so nothing bound it.
    const release = await holdPort(port);
    await release();

    // The command still exists and explains itself instead of erroring.
    expect(mock.hasCommand(OPEN_COMMAND)).toBe(true);
    await mock.runCommand(OPEN_COMMAND);
    expect(mock.panels).toHaveLength(0);
    expect(mock.informationMessages).toHaveLength(1);
    expect(mock.informationMessages[0]).toContain('Agent Deck');
  });

  it('no workspace folder at all starts nothing', async () => {
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    mock.setWorkspaceFolder(undefined);
    await activate(extensionContext());
    expect(currentHost()).toBeNull();
    await mock.runCommand(OPEN_COMMAND);
    expect(mock.panels).toHaveLength(0);
    expect(mock.informationMessages).toHaveLength(1);
  });

  it('a port collision surfaces an error message and still renders content', async () => {
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    const port = await freePort();
    const release = await holdPort(port);
    try {
      mock.setWorkspaceFolder(await capturedWorkspacePath());
      mock.setConfig(CONFIG_SECTION, { port });
      await activate(extensionContext());

      expect(mock.errorMessages).toHaveLength(1);
      expect(mock.errorMessages[0]).toContain(String(port));
      expect(mock.errorMessages[0]).toContain('EADDRINUSE');
      // The message must not promise a rebind.
      expect(mock.errorMessages[0]).toContain('will not pick a port for you');

      const host = currentHost();
      expect(host?.dataPath.diagnostics.listening).toBe(false);
      expect(host?.dataPath.diagnostics.grafts).toBeGreaterThan(0);
    } finally {
      await release();
    }
  });

  it('a threshold change takes effect without a reload', async () => {
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    mock.setWorkspaceFolder(await capturedWorkspacePath());
    mock.setConfig(CONFIG_SECTION, { port: await freePort() });
    await activate(extensionContext());

    expect(currentHost()?.dataPath.liveness.mtimeThresholdMs).toBe(120000);
    mock.setConfig(CONFIG_SECTION, { livenessThresholdMs: 300000 });
    mock.fireConfigurationChange(CONFIG_SECTION);
    expect(currentHost()?.dataPath.liveness.mtimeThresholdMs).toBe(300000);
  });

  it('deactivate with nothing activated is a no-op', async () => {
    await expect(deactivate()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (9) G1 — this file writes nothing, and offers to write nothing
// ---------------------------------------------------------------------------

describe('G1: the extension host writes nothing', () => {
  /**
   * Comments are stripped before scanning, because the source deliberately
   * NAMES the things it must not do ("no `workspaceState`, no `globalState`,
   * no cache file"). A scan of the raw text would match its own promise not to
   * do the thing and fail, which is how a guard gets deleted.
   *
   * Safe here specifically: `src/extension.ts` contains no regex literals and
   * no string literal containing `//`, so the naive strip cannot eat code.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  }

  it('names no filesystem-write API and no settings file', async () => {
    const source = stripComments(await readFile(EXTENSION_SOURCE, 'utf8'));
    expect(source).toContain('createJsonlInferenceSource'); // the strip left code alone

    const forbidden = [
      'writeFile',
      'writeFileSync',
      'appendFile',
      'appendFileSync',
      'createWriteStream',
      'mkdir',
      'rmdir',
      'unlink',
      'rename',
      'copyFile',
      'chmod',
      'openSync',
      'settings.json',
      'settings.local.json',
      '.claude',
      'globalState',
      'workspaceState',
      'globalStorageUri',
      'storageUri',
    ];
    for (const needle of forbidden) {
      expect(source, `forbidden token in src/extension.ts: ${needle}`).not.toContain(
        needle,
      );
    }
  });

  it('imports no write-capable module', async () => {
    const source = stripComments(await readFile(EXTENSION_SOURCE, 'utf8'));
    // The host entry composes; it does not touch the filesystem itself. The
    // only modules that do are the parser and the watcher, which are read-only
    // and have their own G1 proofs.
    expect(source).not.toMatch(/from '(node:)?fs/);
    expect(source).not.toMatch(/require\(\s*['"](node:)?fs/);
  });

  it('opens no socket other than the loopback hook listener', async () => {
    const source = stripComments(await readFile(EXTENSION_SOURCE, 'utf8'));
    for (const needle of ['node:http', 'node:https', 'node:net', 'fetch(', 'WebSocket']) {
      expect(source, `forbidden network token: ${needle}`).not.toContain(needle);
    }
    // The one socket arrives as a dependency, from the module that hard-codes
    // 127.0.0.1.
    expect(source).toContain("from './hooks/listener.js'");
  });
});

// ---------------------------------------------------------------------------
// (10) The built artifact
// ---------------------------------------------------------------------------

describe('the host bundle', () => {
  it('is CommonJS that exports activate and deactivate', async () => {
    const bundlePath = fileURLToPath(new URL('../dist/extension.js', import.meta.url));
    let exists = true;
    try {
      await stat(bundlePath);
    } catch {
      exists = false;
    }
    // The suite must not depend on a build having been run; when it has, this
    // asserts the shape VS Code requires.
    if (!exists) return;

    const text = await readFile(bundlePath, 'utf8');
    // esbuild's CJS output, with `vscode` left external as the host injects it.
    expect(text).toContain('require("vscode")');
    expect(text).toContain('activate');
    expect(text).toContain('deactivate');
    // G5 at the artifact level: the host bundle reaches the network through
    // exactly one module, and never through a browser API.
    expect(text).not.toContain('new WebSocket(');
    expect(text).not.toContain('XMLHttpRequest');
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function maxSpawnDepth(node: TreeNode | undefined): number {
  if (node === undefined) return -1;
  if (!isAgentNode(node)) return 0;
  let deepest = node.spawnDepth;
  for (const child of node.children) {
    deepest = Math.max(deepest, maxSpawnDepth(child));
  }
  return deepest;
}

function countNodes(node: TreeNode | undefined): number {
  if (node === undefined) return 0;
  if (!isAgentNode(node)) return 1;
  let total = 1;
  for (const child of node.children) total += countNodes(child);
  return total;
}

/** Byte-level equality of two tree snapshots, path by path. */
function sameBytes(a: TreeSnapshotEntry[], b: TreeSnapshotEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (basename(x.path) !== basename(y.path)) return false;
    if (x.size !== y.size || x.mtimeMs !== y.mtimeMs) return false;
  }
  return true;
}
