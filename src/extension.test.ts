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

import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
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
import { DEFAULT_PREVIEW_BYTES as GRAFTER_DEFAULT_PREVIEW_BYTES } from './model/graft.js';
import type { GraftSessionResult } from './model/graft.js';
import { TRUNCATION_MARKER_RE } from './parser/redact.js';
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
   * Comments are stripped before the forbidden-token scans below, because the
   * source deliberately NAMES the things it must not do ("no `workspaceState`,
   * no `globalState`, no cache file"). A scan of the raw text would match the
   * file's own promise not to do the thing and fail, which is how a guard gets
   * deleted rather than fixed.
   *
   * The strip is naive — a real tokenizer is not worth it here — so it could
   * eat CODE that looks like a comment, and the scans would then report clean
   * for the wrong reason, which is worse than no scan at all. The next test
   * ASSERTS the strip only ever removed comments instead of this comment
   * claiming it.
   *
   * Which hazards are real, measured by mutating `src/extension.ts` and
   * re-running this file rather than reasoned about:
   *
   *   REAL      a string or regex literal containing `/*` (or `*` `/`). It opens
   *             a block comment, and everything to the next closer vanishes —
   *             a `writeFileSync` planted in between was hidden. CAUGHT.
   *   REAL      a template literal spanning lines. The per-line rule below
   *             cannot see inside it. CAUGHT.
   *   NOT REAL  a mid-line `//` inside a string, e.g. a URL. The line-comment
   *             regex is anchored with `^(\s*)`, so it only ever removes a line
   *             whose FIRST non-whitespace is `//`. That mutant SURVIVED, and
   *             survived correctly: the strip cannot reach it. An earlier
   *             version of this comment named it as the hazard and was wrong.
   *
   * Line count is preserved (block-comment bodies become spaces, not nothing)
   * precisely so that check can compare the two texts line by line.
   */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
      .replace(/^(\s*)\/\/.*$/gm, '$1');
  }

  it('the strip removed only comments (precondition of the scans below)', async () => {
    const raw = await readFile(EXTENSION_SOURCE, 'utf8');
    const stripped = stripComments(raw);
    const rawLines = raw.split('\n');
    const strippedLines = stripped.split('\n');

    // Line-preserving, so index i means the same line in both.
    expect(strippedLines).toHaveLength(rawLines.length);

    let changedLines = 0;
    for (let i = 0; i < rawLines.length; i += 1) {
      const before = rawLines[i] as string;
      const after = strippedLines[i] as string;
      if (before === after) continue;
      changedLines += 1;

      // Case 1: the whole line was comment. Nothing of substance was removed.
      if (after.trim() === '') continue;

      // Case 2: a trailing `//` comment after real code. Safe only if no quote
      // or backtick opens before the `//` on that line — a `//` preceded only
      // by non-quote characters cannot be inside a string literal.
      const marker = before.indexOf('//');
      expect(
        marker,
        `line ${i + 1} changed but has no // marker: ${before}`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        /['"`]/.test(before.slice(0, marker)),
        `line ${i + 1}: the strip may have eaten a string, not a comment: ${before}`,
      ).toBe(false);
    }

    // The residual hole in Case 2 is a template literal spanning lines, whose
    // interior the per-line rule cannot see. Close it: every backtick in the
    // stripped source must open and close on its own line.
    for (let i = 0; i < strippedLines.length; i += 1) {
      const backticks = (strippedLines[i] as string).split('`').length - 1;
      expect(
        backticks % 2,
        `line ${i + 1} opens a multi-line template literal; the per-line rule above cannot see inside it`,
      ).toBe(0);
    }

    // Positive controls. Without these, every assertion above passes vacuously
    // on a strip that removed nothing, or on an empty read.
    expect(changedLines).toBeGreaterThan(50);
    expect(raw).toContain('Carry-forward A');
    expect(stripped).not.toContain('Carry-forward A');
    expect(stripped).toContain('export async function activate');
    expect(stripped).toContain('createJsonlInferenceSource');
    expect(stripped).toContain('new LivenessEngine({');
  });

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

describe('the host bundle: the manifest and the build must agree', () => {
  /**
   * The path VS Code will actually load, read out of `package.json`'s `main`.
   *
   * Driven from the manifest rather than from a literal, on purpose. The defect
   * this block exists for was never "the bundle is wrong" — the bundle was
   * always correct CommonJS. It was that the MANIFEST and the BUILD disagreed
   * about what the file IS, and neither side could see the other. A literal
   * path here would rebuild exactly that blind spot.
   */
  async function readManifest(): Promise<{ main: string; type?: string }> {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { main?: string; type?: string };
    expect(typeof manifest.main, 'package.json must declare a "main"').toBe('string');
    return manifest as { main: string; type?: string };
  }

  function absoluteMain(main: string): string {
    return fileURLToPath(new URL(`../${main.replace(/^\.\//, '')}`, import.meta.url));
  }

  /**
   * Build the host bundle if it is not already on disk.
   *
   * The earlier version of this block early-returned when `dist/` was absent,
   * which meant that on a fresh clone two of these four tests SKIPPED silently
   * and the block reported `4 passed | 32 skipped` while asserting nothing
   * about an artifact that did not exist. "Replay from a clean checkout" is a
   * standing criterion here, and a test that quietly opts out is worse than an
   * absent one because it reports as coverage.
   *
   * Shelling out to a child `node` follows `webview/bundle.test.ts`, which does
   * the same for the same reason. The host build is measured at ~50-90 ms, so
   * the cost of never skipping is negligible; `--host` exists precisely so this
   * does not drag in the webview build too.
   */
  async function ensureBuilt(path: string): Promise<string> {
    try {
      await stat(path);
    } catch {
      execFileSync('node', ['esbuild.config.mjs', '--host'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        encoding: 'utf8',
        stdio: 'pipe',
      });
    }
    // Deliberately NOT in a try: if the build ran and the file still is not
    // there, that is the manifest/build divergence this block exists to catch,
    // and it must fail rather than skip.
    return readFile(path, 'utf8');
  }

  it('esbuild writes exactly the file the manifest names, in the format it needs', async () => {
    const { main } = await readManifest();
    const config = await readFile(
      fileURLToPath(new URL('../esbuild.config.mjs', import.meta.url)),
      'utf8',
    );
    // `main` is './dist/x'; the build config says 'dist/x'. Same form, compared.
    expect(config).toContain(`outfile: '${main.replace(/^\.\//, '')}'`);
    expect(config).toContain("format: 'cjs'");
  });

  it('a CommonJS bundle under "type": "module" must be named .cjs', async () => {
    const { main, type } = await readManifest();
    // Node decides a `.js` file's format from the nearest `package.json`. Under
    // `"type": "module"` a CommonJS `.js` bundle is parsed as ESM and produces
    // an INERT module — no throw, no diagnostic, just `activate: undefined`,
    // which is why this went unseen from Phase 1 until an entry point existed.
    // `.cjs` is unambiguously CommonJS whatever `"type"` says.
    if (type === 'module') {
      expect(main.endsWith('.cjs'), `"type":"module" + ${main} yields an inert module`).toBe(
        true,
      );
    }
  });

  it('requires as CommonJS and exports activate and deactivate', async () => {
    const manifest = await readManifest();
    const bundle = absoluteMain(manifest.main);
    await ensureBuilt(bundle);

    // Reproduce the load EXACTLY as VS Code performs it: a plain `require` of
    // `main`, with the manifest's own `"type"` field governing the file, and
    // `vscode` resolvable because the host injects it. Staged in a temp tree
    // rather than in the repo so the probe writes nothing here (G1) and cannot
    // leave a stub `vscode` behind for another suite to trip over.
    const stage = await makeTempDir();
    const relative = manifest.main.replace(/^\.\//, '');
    const staged = join(stage, relative);
    await mkdir(dirname(staged), { recursive: true });
    await copyFile(bundle, staged);
    await writeFile(
      join(stage, 'package.json'),
      `${JSON.stringify({ name: 'agent-deck-load-probe', main: manifest.main, ...(manifest.type === undefined ? {} : { type: manifest.type }) })}\n`,
    );
    const stub = join(stage, 'node_modules', 'vscode');
    await mkdir(stub, { recursive: true });
    await writeFile(join(stub, 'package.json'), '{"name":"vscode","main":"index.js"}\n');
    await writeFile(join(stub, 'index.js'), 'module.exports = {};\n');

    const requireFromStage = createRequire(join(stage, 'probe.cjs'));
    // Proves the stub is what resolution finds, so a failure below is about the
    // bundle and not about a missing dependency.
    expect(requireFromStage.resolve('vscode')).toBe(join(stub, 'index.js'));

    const loaded = requireFromStage(staged) as Record<string, unknown>;
    expect(typeof loaded['activate'], `${manifest.main} must export activate()`).toBe(
      'function',
    );
    expect(typeof loaded['deactivate'], `${manifest.main} must export deactivate()`).toBe(
      'function',
    );
  });

  it('reaches the network through one module and no browser API (G5)', async () => {
    const { main } = await readManifest();
    const text = await ensureBuilt(absoluteMain(main));
    // `vscode` stays external because the host injects it.
    expect(text).toContain('require("vscode")');
    expect(text).not.toContain('new WebSocket(');
    expect(text).not.toContain('XMLHttpRequest');
  });
});

// ---------------------------------------------------------------------------
// (11) agentDeck.previewBytes actually reaches the grafter
// ---------------------------------------------------------------------------

describe('the agentDeck.previewBytes setting reaches the grafter', () => {
  /**
   * Why this block exists, in one sentence: deleting
   * `previewBytes: this.settings.previewBytes` from the `graftSession(...)`
   * call left the entire suite green while every preview silently shrank to the
   * grafter's own 512-byte default — a decided behaviour, correctly
   * implemented, with no guard at all.
   *
   * Two things make the assertions here non-vacuous:
   *
   *   1. They read the TRUNCATION MARKER, not a string length. The marker
   *      states `showing <kept> of <original> bytes`, so the test can assert
   *      the exact byte ceiling that produced the preview. A length assertion
   *      would pass on any number that happened to be big.
   *   2. The values exercised are 4096 and 2048 — neither is the grafter's
   *      default (512), the redactor's default (8192), nor the extension's own
   *      default. A number that is a default somewhere cannot distinguish
   *      "forwarded" from "fell back".
   *
   * The payload is tied to `tool-results/` by CONTENT, not by size: the test
   * finds the offloaded `.txt` on disk and requires its opening bytes to appear
   * verbatim in a preview. That is the G4 "offloading exists, redaction must
   * cover it" path, proved to reach the emission rather than assumed to.
   */

  /** The offloaded payload committed under the captured session, found on disk. */
  async function offloadedPayload(): Promise<{ text: string; bytes: number }> {
    const slugDir = await capturedSlugDir();
    const dirs = (await readdir(slugDir, { withFileTypes: true })).filter((e) =>
      e.isDirectory(),
    );
    for (const dir of dirs) {
      const toolResults = join(slugDir, dir.name, 'tool-results');
      let names: string[];
      try {
        names = await readdir(toolResults);
      } catch {
        continue;
      }
      const first = names.find((n) => n.endsWith('.txt'));
      if (first === undefined) continue;
      const path = join(toolResults, first);
      return { text: await readFile(path, 'utf8'), bytes: (await stat(path)).size };
    }
    throw new Error('no tool-results payload in the captured fixtures');
  }

  /** Every non-empty tool-result preview the emission carries, at one setting. */
  async function previewsAt(previewBytes: number): Promise<string[]> {
    const workspacePath = await capturedWorkspacePath();
    const emissions: DataPathEmission[] = [];
    const path = trackDataPath(
      new AgentDeckDataPath({
        workspacePath,
        projectsRoot: CAPTURED_ROOT,
        settings: settings({ port: await freePort(), previewBytes }),
        tickMs: 0,
        onEmission: (payload) => {
          emissions.push(payload);
        },
      }),
    );
    await path.start();
    const last = emissions[emissions.length - 1] as DataPathEmission;
    const out: string[] = [];
    for (const session of last.emission.sessions) {
      for (const node of flatten(session.root)) {
        if (isAgentNode(node)) continue;
        const preview = node.resultPreview;
        if (preview !== undefined && preview.length > 0) out.push(preview);
      }
    }
    await path.dispose();
    return out;
  }

  function keptBytes(preview: string): number | null {
    const match = TRUNCATION_MARKER_RE.exec(preview);
    return match === null ? null : Number(match[1]);
  }

  function originalBytes(preview: string): number | null {
    const match = TRUNCATION_MARKER_RE.exec(preview);
    return match === null ? null : Number(match[2]);
  }

  it('truncates the offloaded tool-results payload at exactly the configured byte count', async () => {
    const payload = await offloadedPayload();
    // Derived, not pinned: whatever the capture holds, it must be big enough
    // for the two settings below to be distinguishable from each other and from
    // the grafter's default.
    expect(payload.bytes).toBeGreaterThan(GRAFTER_DEFAULT_PREVIEW_BYTES * 8);
    const needle = payload.text.slice(0, 160);

    const observed: number[] = [];
    for (const previewBytes of [4096, 2048]) {
      expect(previewBytes).not.toBe(GRAFTER_DEFAULT_PREVIEW_BYTES);
      const previews = await previewsAt(previewBytes);
      expect(previews.length).toBeGreaterThan(0);

      // The offloaded bytes reached the emission. Content, not size.
      const fromOffload = previews.filter((p) => p.includes(needle));
      expect(
        fromOffload,
        'no preview carries the opening bytes of the tool-results payload',
      ).toHaveLength(1);
      const preview = fromOffload[0] as string;

      // ...and it was cut at exactly the configured ceiling, not at a default.
      expect(keptBytes(preview), `preview must be cut at ${previewBytes} bytes`).toBe(
        previewBytes,
      );
      expect(originalBytes(preview) ?? 0).toBeGreaterThan(previewBytes);
      expect(Buffer.byteLength(preview, 'utf8')).toBeGreaterThan(
        GRAFTER_DEFAULT_PREVIEW_BYTES * 2,
      );
      observed.push(preview.length);

      // Every OTHER truncated preview obeys the same ceiling, so this is the
      // setting governing the grafter and not one lucky node.
      for (const other of previews) {
        const kept = keptBytes(other);
        if (kept === null) continue;
        expect(kept).toBe(previewBytes);
      }
    }

    // The two runs differ, which is what "the number moves with the setting"
    // means. Equal lengths would mean some other ceiling was in charge.
    expect(observed[0]).toBeGreaterThan(observed[1] as number);
  });

  it('the decided default of 8192 is the value the emission actually uses', async () => {
    // Taken from `readSettings` rather than written as a literal, so the
    // decision and the assertion cannot drift apart.
    const previewBytes = readSettings(undefined).previewBytes;
    expect(previewBytes).toBe(8192);

    const payload = await offloadedPayload();
    const previews = await previewsAt(previewBytes);
    const fromOffload = previews.filter((p) => p.includes(payload.text.slice(0, 160)));
    expect(fromOffload).toHaveLength(1);
    expect(keptBytes(fromOffload[0] as string)).toBe(previewBytes);
    // 16x the grafter's default. This is the number the DoD is written in.
    expect(keptBytes(fromOffload[0] as string)).toBe(GRAFTER_DEFAULT_PREVIEW_BYTES * 16);
  });
});

// ---------------------------------------------------------------------------
// (12) G2 at the extension level: a content failure cannot reach liveness
// ---------------------------------------------------------------------------

describe('G2: a throwing content path refuses one session and leaves the hook tap running', () => {
  /**
   * G2 is proved one layer down in `session.test.ts`, against `SessionModel`'s
   * own guard. It was NOT proved here, and the host is where the two taps
   * actually meet: rethrowing from `#graft`'s catch instead of calling
   * `refuseSession` left all of this file's tests green, because nothing could
   * make the content side fail. `DataPathOptions.graft` is the seam that closes
   * that, and it exists for this test and no other reason.
   *
   * The liveness half is driven through a REAL loopback POST to the REAL
   * listener, not by calling `model.onHookEvent` directly. Calling the handler
   * would prove the model still works; posting proves the tap the user actually
   * installs still works while the content path is on fire.
   */

  /**
   * The status `listener.ts` answers an accepted event with. 200, measured, not
   * 204 — an earlier draft of this test guessed 204 and failed, which is the
   * cheap version of the lesson this repo keeps paying for.
   */
  const HOOK_ACCEPTED_STATUS = 200;

  /** POST one hook payload to the bound listener. Resolves with the status. */
  async function postHookEvent(port: number, payload: unknown): Promise<number> {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    return new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/event',
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': body.length,
            connection: 'close',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            resolve(res.statusCode ?? 0);
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  it('refuses the session, keeps no tree, and still ingests hook events for it', async () => {
    const workspacePath = await capturedWorkspacePath();
    const port = await freePort();
    let graftCalls = 0;
    const path = trackDataPath(
      new AgentDeckDataPath({
        workspacePath,
        projectsRoot: CAPTURED_ROOT,
        settings: settings({ port }),
        tickMs: 0,
        onEmission: () => {},
        graft: () => {
          graftCalls += 1;
          // Not a refusal — a THROW, from inside the content path.
          return Promise.reject(new Error('grafter exploded'));
        },
      }),
    );

    // start() must not propagate it.
    await expect(path.start()).resolves.toBeUndefined();

    expect(graftCalls).toBeGreaterThan(0);
    expect(path.diagnostics.graftErrors).toBe(graftCalls);
    expect(path.diagnostics.lastGraftError).toContain('grafter exploded');

    // The liveness tap is up despite the content path being dead. That is the
    // whole of G2 in one assertion.
    expect(path.diagnostics.listening).toBe(true);

    const sessionIds = path.model.sessionIds();
    expect(sessionIds.length).toBeGreaterThan(0);
    const [victim] = sessionIds as [string];

    // Every session refused, and none of them exposes a tree (G3).
    for (const sessionId of sessionIds) {
      const state = path.model.sessionState(sessionId);
      expect(state?.schemaOk).toBe(false);
      expect(state?.liveness).toBe('unsupported');
      expect(state?.root.children).toStrictEqual([]);
      expect(state?.spawnEdges).toStrictEqual([]);
      expect(path.model.refusalOf(sessionId)?.thrown).toBeUndefined();
      expect(path.model.refusalOf(sessionId)?.mismatch).toBeDefined();
    }

    // Now the other tap, over the wire.
    const before = path.model.livenessSnapshot(victim)?.hookEventCount ?? -1;
    expect(before).toBe(0);

    expect(
      await postHookEvent(port, {
        session_id: victim,
        hook_event_name: 'PreToolUse',
        tool_use_id: 'toolu_g2_probe',
        tool_name: 'Bash',
        cwd: workspacePath,
      }),
    ).toBe(HOOK_ACCEPTED_STATUS);
    expect(
      await postHookEvent(port, {
        session_id: victim,
        hook_event_name: 'PostToolUse',
        tool_use_id: 'toolu_g2_probe',
        tool_name: 'Bash',
        cwd: workspacePath,
      }),
    ).toBe(HOOK_ACCEPTED_STATUS);

    const after = path.model.livenessSnapshot(victim);
    expect(after?.hookEventCount).toBe(2);
    // Main thread: CC omits `agent_id` entirely, and the snapshot must reflect
    // that rather than inventing an id.
    expect(after?.main.isMainThread).toBe(true);
    expect(after?.main.agentId).toBeUndefined();
    expect(path.model.counters().hookEventsIngested).toBe(2);
    expect(path.liveness.counters().eventsApplied).toBe(2);
    // No longer degraded: events are arriving.
    expect(path.liveness.degradedState()).toStrictEqual({ degraded: false });

    // The session is still refused — liveness flowing did not resurrect a tree.
    expect(path.model.sessionState(victim)?.liveness).toBe('unsupported');
    expect(path.model.sessionState(victim)?.root.children).toStrictEqual([]);
  });

  it('a content path that refuses cleanly is counted as a refusal, not a throw', async () => {
    // The control for the test above: `ok: false` is a typed answer and must
    // NOT increment the throw counter. Without this, `graftErrors` could count
    // both and the assertion up there would prove less than it looks.
    const workspacePath = await capturedWorkspacePath();
    const refusal: GraftSessionResult = {
      ok: false,
      mismatch: { kind: 'schemaMismatch', code: 'subagentsDirectoryMisnamed', reason: 'injected refusal' },
      diagnostics: { malformedLines: 0, parsedLines: 0, skippedFiles: [] },
    };
    const path = trackDataPath(
      new AgentDeckDataPath({
        workspacePath,
        projectsRoot: CAPTURED_ROOT,
        settings: settings({ port: await freePort() }),
        tickMs: 0,
        onEmission: () => {},
        graft: () => Promise.resolve(refusal),
      }),
    );
    await path.start();

    expect(path.diagnostics.graftErrors).toBe(0);
    expect(path.diagnostics.graftRefusals).toBe(path.diagnostics.grafts);
    expect(path.model.counters().contentFailures).toBe(0);
    const [victim] = path.model.sessionIds() as [string];
    expect(path.model.refusalOf(victim)?.mismatch?.reason).toBe('injected refusal');
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

/** Every node in a tree, root first. `ToolNode` has no children by design. */
function flatten(node: TreeNode | undefined): TreeNode[] {
  if (node === undefined) return [];
  const out: TreeNode[] = [node];
  if (isAgentNode(node)) {
    for (const child of node.children) out.push(...flatten(child));
  }
  return out;
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
