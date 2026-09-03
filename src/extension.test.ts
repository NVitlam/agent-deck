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
import { existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentDeckDataPath,
  AgentDeckHost,
  CODEX_ABSENT_LOG,
  CONFIG_SECTION,
  CodexEnginePath,
  DEFAULT_CODEX_ENGINE_POLL_INTERVAL_MS,
  DEFAULT_LIVENESS_THRESHOLD_MS,
  DEFAULT_PORT,
  DEFAULT_PREVIEW_BYTES,
  OPENCODE_ABSENT_LOG,
  OPEN_COMMAND,
  OpenCodeEnginePath,
  PanelController,
  SETTING_BOUNDS,
  WEBVIEW_SCRIPT_SEGMENTS,
  WEBVIEW_STYLE_SEGMENTS,
  activate,
  currentHost,
  deactivate,
  inactiveReasonFor,
  opencodeStoreExists,
  readSettings,
  workspacePathsOf,
} from './extension.js';
import type {
  AgentDeckSettings,
  DataPathEmission,
  HostLogLevel,
  PanelSurface,
  Unsubscribe,
} from './extension.js';
import type { WebviewToHostMessage } from './model/events.js';
import { OPENCODE_DATA_ROOT_ENV, opencodeDataDir } from './opencode/index.js';
import { CODEX_HOME_VAR, readCodexEngine } from './codex/index.js';
import type { CodexThread } from './codex/index.js';
import {
  copyCorpus,
  corpusDbPath,
  listCorpora,
  withWritableDb,
} from './opencode/synthetic.js';
import { DEFAULT_OC_POLL_INTERVAL_MS } from './opencode/liveness.js';
import type { PollTrigger, PollTriggerHandle } from './opencode/liveness.js';
import { webviewHtml } from './bridge/html.js';
import { DEFAULT_PREVIEW_BYTES as GRAFTER_DEFAULT_PREVIEW_BYTES } from './model/graft.js';
import type { GraftSessionResult } from './model/graft.js';
import type { DiagnosticsEvent } from './bridge/diagnostics.js';
import { TRUNCATION_MARKER_RE, truncationMarker } from './parser/redact.js';
import { WEBVIEW_ROOT_ID } from './bridge/contract.js';
import type { HostToWebviewMessage, SessionState, TreeNode } from './model/events.js';
import { isAgentNode } from './model/events.js';
import { slugifyWorkspace, snapshotTree } from './parser/tailer.js';
import type { DiscoveryFailure, DiscoveryFailureKind, TreeSnapshotEntry } from './parser/tailer.js';
import { correlateWorkspace } from './model/correlate.js';
import {
  Uri,
  createExtensionContext,
  mock,
  resetVscodeMock,
  window as vscodeWindowDouble,
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

/**
 * A free loopback port, taken and released.
 *
 * THIS FUNCTION HAS AN UNCLOSEABLE TOCTOU WINDOW, which is why only
 * {@link onFreePort} and one commented exception call it directly. It binds
 * port 0, reads what the OS assigned, closes the socket, and hands the number
 * out; between that close and the real bind inside `AgentDeckDataPath.start()`
 * or `activate()`, anything on the machine can take the port. Historical red
 * rate ~15%.
 *
 * The window cannot be removed here, because the production listener binds
 * exactly the port it is configured with and refuses to pick another when that
 * port is taken -- two tests in this file assert that refusal ("a port
 * collision is an explicit error and never a silent rebind" and "a port
 * collision surfaces an error message and still renders content"), and it is
 * the behaviour a user relies on. So the window is TOLERATED and lost races are
 * RETRIED, at the call sites, by {@link onFreePort}. No production code changes
 * for a test-harness flake; in particular `allowEphemeralPort` stays a
 * `listener.ts`-only concept, which `src/hooks/listener.test.ts` asserts.
 */
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

/**
 * How many free ports one call site will try before giving up.
 *
 * Six. Each attempt asks the OS for a fresh ephemeral port out of a range
 * thousands wide, and the window it can be stolen in is sub-millisecond, so six
 * consecutive losses is not a flake to design around -- it is a machine with no
 * usable loopback ports, and {@link portsExhausted} says exactly that rather
 * than letting the run die as a generic timeout or a confusing assertion.
 */
const PORT_ATTEMPTS = 6;

function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  );
}

/** The loud failure. Names EADDRINUSE and every port tried, never a timeout. */
function portsExhausted(tried: readonly number[]): Error {
  return new Error(
    `EADDRINUSE on all ${String(tried.length)} loopback ports this test tried ` +
      `(${tried.join(', ')}): every port freePort() handed out was taken between the ` +
      `probe and the bind. That is not the usual race -- suspect no free ephemeral ` +
      `ports on this machine.`,
  );
}

/**
 * Run something that binds a loopback port, on a port that was free, retrying
 * on `EADDRINUSE`.
 *
 * TWO WAYS A LOST RACE SHOWS UP, and both are handled, because handling only
 * the first would close the window for `holdPort` and leave it wide open for
 * every `activate()`:
 *
 *   - as a THROW, when the caller binds the socket itself (`holdPort`);
 *   - as a RETURNED VALUE, when the production path swallows the error into
 *     `diagnostics.bindError` and reports it through `onError` -- which is what
 *     `AgentDeckDataPath.start()` deliberately does, and is the only reason
 *     `collided` exists.
 *
 * `discard` undoes a collided attempt before the next one, so a retried test
 * does not leave a half-built data path holding a watcher and a timer.
 */
interface PortAttempt<T> {
  use: (port: number) => Promise<T>;
  /** `true` when what `use` returned reported EADDRINUSE instead of throwing. */
  collided?: (made: T) => boolean;
  discard?: (made: T) => Promise<void>;
}

async function onFreePort<T>(attempt: PortAttempt<T>): Promise<T> {
  const tried: number[] = [];
  for (;;) {
    const port = await freePort();
    tried.push(port);
    let made: T;
    try {
      made = await attempt.use(port);
    } catch (error) {
      if (!isAddrInUse(error)) throw error;
      if (tried.length >= PORT_ATTEMPTS) throw portsExhausted(tried);
      continue;
    }
    if (attempt.collided?.(made) !== true) return made;
    await attempt.discard?.(made);
    if (tried.length >= PORT_ATTEMPTS) throw portsExhausted(tried);
  }
}

/**
 * The dominant shape: build a data path on a free port, start it, and retry the
 * whole thing if the port was stolen in between.
 *
 * `make` builds but must not start -- `start()` is where the bind happens, so
 * it has to be inside the retried region.
 */
async function startDataPathOnFreePort(
  make: (port: number) => AgentDeckDataPath,
): Promise<AgentDeckDataPath> {
  return onFreePort<AgentDeckDataPath>({
    use: async (port) => {
      const path = make(port);
      await path.start();
      return path;
    },
    collided: (path) => path.diagnostics.bindError?.code === 'EADDRINUSE',
    discard: (path) => path.dispose(),
  });
}

/** The same, for an `AgentDeckHost`, whose bind is its data path's. */
async function startHostOnFreePort(
  make: (port: number) => AgentDeckHost,
  beforeStart?: (host: AgentDeckHost) => void,
): Promise<AgentDeckHost> {
  return onFreePort<AgentDeckHost>({
    use: async (port) => {
      const host = make(port);
      beforeStart?.(host);
      await host.start();
      return host;
    },
    collided: (host) => host.dataPath.diagnostics.bindError?.code === 'EADDRINUSE',
    discard: (host) => host.dispose(),
  });
}

/**
 * `activate()` on a free port, retried if the port was stolen in between.
 *
 * `activate` binds through the module-level singleton, so a discarded attempt
 * has to be `deactivate`d before the next one or the second `activate` would
 * find a host already installed. `configure` is where the test puts the port
 * into the `vscode` double, because `activate` reads it from there.
 */
async function activateOnFreePort(
  configure: (port: number) => void | Promise<void>,
): Promise<number> {
  return onFreePort<number>({
    use: async (port) => {
      resetVscodeMock();
      await configure(port);
      await activate(extensionContext());
      return port;
    },
    collided: () => currentHost()?.dataPath.diagnostics.bindError?.code === 'EADDRINUSE',
    discard: async () => {
      await deactivate();
    },
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

/**
 * A port that is free and then deliberately taken, for the tests that assert
 * what a collision does.
 *
 * `holdPort` binds for real, so it loses the same race every other call site
 * can lose -- and it loses it by THROWING rather than by reporting a
 * `bindError`, which is {@link onFreePort}'s other branch.
 */
async function heldPort(): Promise<{ port: number; release: () => Promise<void> }> {
  return onFreePort({
    use: async (port) => ({ port, release: await holdPort(port) }),
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

/**
 * VS Code's ACTUAL desktop `webview.cspSource`, byte for byte.
 *
 * MEASURED, not invented. Read from the installed VS Code 1.134.0 (commit
 * 110a328ea54b42367b803ec53ee0bf52ef26b419),
 * `resources/app/out/vs/workbench/api/node/extensionHostProcess.js`:
 *
 *     const BASE = `'self' https://*.vscode-cdn.net`;
 *     get cspSource() { ...http/https extensionLocation prefix...; return BASE }
 *
 * The value that stood here before — `'vscode-resource://agent-deck-test'` —
 * was made up, and every test using it passed while the shipped extension
 * could not open its panel at all: `bridge/html.ts` refused the real string
 * and the human side-loading the VSIX got our own guard's message in a modal.
 * This repo applies "only measurements count" to Claude Code's format and had
 * never applied it to VS Code's API.
 *
 * `test/vscode-mock.ts` carries the same value from the same measurement. If
 * this ever needs changing, re-read the getter above; do not re-invent it.
 */
const MEASURED_CSP_SOURCE = "'self' https://*.vscode-cdn.net";

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
      cspSource: MEASURED_CSP_SOURCE,
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

/**
 * THE OPENCODE STORE IS POINTED SOMEWHERE EMPTY FOR EVERY TEST IN THIS FILE.
 *
 * `activate()` resolves the OpenCode data directory from `process.env` — that
 * is the production path and it has no injection seam, deliberately — so on a
 * developer machine that actually runs OpenCode, every `activate()` test in
 * this file would open the user's real 24 MB `opencode.db`. `PLAN.md` Phase 4
 * Amendment A2 is explicit that a test must never read a live database: it
 * measures the machine it ran on, and here it would also make the whole file's
 * results depend on whether the person running it uses OpenCode.
 *
 * `AGENT_DECK_OPENCODE_ROOT` is the engine's own documented override (spec
 * OC1, on the `CLAUDE_PROJECTS_ROOT` precedent). Pointing it at a fresh empty
 * directory makes the store ABSENT for every test here, which is also the state
 * the discovery tests below assert about.
 */
const savedOpencodeRoot = process.env[OPENCODE_DATA_ROOT_ENV];
/**
 * Same discipline, same reason, for the third engine (DoD 3.2). Every
 * `AgentDeckDataPath`/`CodexEnginePath` constructed in this file without an
 * explicit `codex.root` resolves `$CODEX_HOME` from `process.env` by
 * default, and this machine's real `~/.codex` is not this suite's to read —
 * G6 again, one door over. Pointing it at a fresh empty directory makes the
 * Codex root ABSENT for every test here unless a test stages one explicitly.
 */
const savedCodexHome = process.env[CODEX_HOME_VAR];

beforeEach(async () => {
  resetVscodeMock();
  process.env[OPENCODE_DATA_ROOT_ENV] = await makeTempDir();
  process.env[CODEX_HOME_VAR] = await makeTempDir();
});

afterEach(async () => {
  if (savedOpencodeRoot === undefined) delete process.env[OPENCODE_DATA_ROOT_ENV];
  else process.env[OPENCODE_DATA_ROOT_ENV] = savedOpencodeRoot;
  if (savedCodexHome === undefined) delete process.env[CODEX_HOME_VAR];
  else process.env[CODEX_HOME_VAR] = savedCodexHome;
  await deactivate();
  for (const host of liveHosts.splice(0)) await host.dispose();
  for (const path of liveDataPaths.splice(0)) await path.dispose();
  for (const dir of tempRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (0) The harness's own port race — demonstrated closed, not asserted absent
// ---------------------------------------------------------------------------

/**
 * `freePort` closes the socket before the real bind happens, so every call site
 * in this file has a window in which the machine can take the port. Historical
 * red rate ~15%.
 *
 * A GREEN SUITE IS NOT EVIDENCE THAT THE WINDOW IS CLOSED -- it is evidence the
 * race did not fire on that run, which is what a 15% flake looks like 85% of
 * the time. So these tests FIRE IT ON PURPOSE, with `holdPort`, and check that
 * the retry recovers: both the way the production path reports a lost race (a
 * returned `bindError`, never a throw) and the way `holdPort` reports one (a
 * throw). The exhaustion message is exercised too, because a retry that gave up
 * as a generic timeout would trade a visible flake for an invisible one.
 */
describe('onFreePort closes the freePort/bind race', () => {
  it('recovers a REAL AgentDeckDataPath bind when the port is stolen first', async () => {
    const workspacePath = await capturedWorkspacePath();
    const releases: (() => Promise<void>)[] = [];
    const stolen: number[] = [];
    let attempts = 0;
    try {
      const path = await onFreePort<AgentDeckDataPath>({
        use: async (port) => {
          attempts += 1;
          if (attempts === 1) {
            // The race, fired deliberately: the port freePort() just handed
            // out is taken by something else before start() can bind it.
            stolen.push(port);
            releases.push(await holdPort(port));
          }
          const built = trackDataPath(
            new AgentDeckDataPath({
              workspacePath,
              projectsRoot: CAPTURED_ROOT,
              settings: settings({ port }),
              tickMs: 0,
              onEmission: () => {},
            }),
          );
          await built.start();
          return built;
        },
        collided: (built) => built.diagnostics.bindError?.code === 'EADDRINUSE',
        discard: (built) => built.dispose(),
      });

      // Two attempts, and the second one is genuinely listening: the recovery
      // is asserted on the production socket, not on the helper's bookkeeping.
      expect(attempts).toBe(2);
      expect(stolen).toHaveLength(1);
      expect(path.settings.port).not.toBe(stolen[0]);
      expect(path.diagnostics.listening).toBe(true);
      expect(path.diagnostics.bindError).toBeUndefined();
      // And the first attempt really did collide, rather than being skipped:
      // the port it was given is still held by this test.
      await expect(holdPort(stolen[0] as number)).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
    } finally {
      for (const release of releases) await release();
    }
  });

  it('recovers the throwing branch: a bind that raises EADDRINUSE outright', async () => {
    const releases: (() => Promise<void>)[] = [];
    const stolen: number[] = [];
    let attempts = 0;
    let held: { port: number; release: () => Promise<void> } | undefined;
    try {
      held = await onFreePort<{ port: number; release: () => Promise<void> }>({
        use: async (port) => {
          attempts += 1;
          if (attempts === 1) {
            stolen.push(port);
            releases.push(await holdPort(port));
          }
          // On attempt 1 this throws EADDRINUSE, which is the branch `heldPort`
          // and the two collision tests depend on.
          return { port, release: await holdPort(port) };
        },
      });
      expect(attempts).toBe(2);
      expect(held.port).not.toBe(stolen[0]);
    } finally {
      if (held !== undefined) await held.release();
      for (const release of releases) await release();
    }
  });

  it('gives up loudly after PORT_ATTEMPTS, naming EADDRINUSE and every port', async () => {
    const releases: (() => Promise<void>)[] = [];
    const tried: number[] = [];
    let error: unknown;
    try {
      error = await onFreePort<number>({
        use: async (port) => {
          tried.push(port);
          // Steal every port, so no attempt can ever win.
          releases.push(await holdPort(port));
          await holdPort(port);
          return port;
        },
      }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    } finally {
      for (const release of releases) await release();
    }

    expect(tried).toHaveLength(PORT_ATTEMPTS);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // The failure has to name the cause and the ports. A generic timeout here
    // is the outcome this whole section exists to prevent.
    expect(message).toContain('EADDRINUSE');
    for (const port of tried) expect(message).toContain(String(port));
    expect(message.toLowerCase()).not.toContain('timeout');
  });

  it('does not retry a failure that is not EADDRINUSE', async () => {
    // Without this, a real bug inside a call site would be run six times and
    // reported as the wrong thing.
    let attempts = 0;
    await expect(
      onFreePort<number>({
        use: () => {
          attempts += 1;
          return Promise.reject(new Error('nothing to do with ports'));
        },
      }),
    ).rejects.toThrow('nothing to do with ports');
    expect(attempts).toBe(1);
  });
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
// (1a) The settings manifest and the settings code must agree
// ---------------------------------------------------------------------------

/**
 * Six numbers live twice: `package.json`'s `contributes.configuration` is what
 * VS Code's settings UI shows and validates against, `SETTING_BOUNDS` is what
 * `readSettings` enforces at runtime, and nothing connected them. Measured
 * before this block existed: setting `agentDeck.previewBytes`'s manifest
 * `default` to 999 and its `maximum` to 4096 left the full suite green.
 *
 * The manifest is READ here, never restated. Hard-coding its numbers would
 * make this block a third copy of the same six values and it would agree with
 * whichever copy was edited last.
 *
 * Same defect class as the block at the bottom of this file (`main` vs. the
 * built bundle), which is why the wording matches: the manifest and the code
 * disagree, both sides are internally consistent, and nothing fails.
 */
describe('the settings manifest and SETTING_BOUNDS must agree', () => {
  interface ManifestProperty {
    type?: unknown;
    default?: unknown;
    minimum?: unknown;
    maximum?: unknown;
    description?: unknown;
  }

  async function manifestProperties(): Promise<Record<string, ManifestProperty>> {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as {
      contributes?: { configuration?: { properties?: Record<string, ManifestProperty> } };
    };
    const properties = manifest.contributes?.configuration?.properties;
    expect(
      properties,
      'package.json must declare contributes.configuration.properties',
    ).toBeTypeOf('object');
    return properties as Record<string, ManifestProperty>;
  }

  it('declares exactly the settings the code reads — no more, no fewer', async () => {
    const properties = await manifestProperties();
    const declared = Object.keys(properties).sort();
    const enforced = Object.keys(SETTING_BOUNDS)
      .map((key) => `${CONFIG_SECTION}.${key}`)
      .sort();
    // Both directions: a setting the manifest offers that the code ignores is
    // a dead knob, and one the code reads that the manifest never declares is
    // invisible in the settings UI.
    expect(declared).toStrictEqual(enforced);
  });

  it('declares the same default, minimum and maximum the code enforces', async () => {
    const properties = await manifestProperties();
    for (const [key, bounds] of Object.entries(SETTING_BOUNDS)) {
      const property = properties[`${CONFIG_SECTION}.${key}`];
      expect(property, `package.json declares no ${CONFIG_SECTION}.${key}`).toBeTypeOf('object');
      if (property === undefined) continue;
      // `integerInRange` refuses a non-integer, so the manifest must not
      // advertise the setting as anything else.
      expect(property.type, `${key}.type`).toBe('integer');
      expect(property.default, `${key}.default`).toBe(bounds.default);
      expect(property.minimum, `${key}.minimum`).toBe(bounds.minimum);
      expect(property.maximum, `${key}.maximum`).toBe(bounds.maximum);
    }
  });

  it('the manifest default is the value an unconfigured extension actually uses', async () => {
    const properties = await manifestProperties();
    const fromManifest = Object.fromEntries(
      Object.keys(SETTING_BOUNDS).map((key) => [
        key,
        (properties[`${CONFIG_SECTION}.${key}`] as ManifestProperty).default,
      ]),
    );
    // Ties the manifest to behaviour, not just to a constant: whatever
    // `package.json` promises is what `readSettings` hands the data path.
    expect(readSettings(undefined)).toStrictEqual(fromManifest);
  });

  it('the manifest bounds are the bounds enforced: at the edge honoured, one past it refused', async () => {
    const properties = await manifestProperties();
    for (const key of Object.keys(SETTING_BOUNDS)) {
      const property = properties[`${CONFIG_SECTION}.${key}`] as ManifestProperty;
      const minimum = property.minimum as number;
      const maximum = property.maximum as number;
      const fallback = property.default as number;
      const read = (value: unknown): number =>
        readSettings({ get: (k) => (k === key ? value : undefined) })[
          key as keyof AgentDeckSettings
        ];
      expect(read(minimum), `${key} at the manifest minimum`).toBe(minimum);
      expect(read(maximum), `${key} at the manifest maximum`).toBe(maximum);
      expect(read(minimum - 1), `${key} one below the manifest minimum`).toBe(fallback);
      expect(read(maximum + 1), `${key} one above the manifest maximum`).toBe(fallback);
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
        contextNow: { prompt: 0, output: 0 },
        burn: { prompt: 0, output: 0 },
        startedAt: 0,
      },
      totals: { costUsd: 0 },
      contextNow: { prompt: 0, output: 0 },
      burn: { prompt: 0, output: 0 },
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
      // Read off the panel rather than restated: this now checks that the
      // controller forwards the surface's OWN cspSource, which a second copy
      // of the literal could not distinguish from a hard-coded one.
      cspSource: panel.surface.cspSource,
    });
    expect(panel.surface.cspSource, 'the fake panel must supply the measured value').toBe(
      MEASURED_CSP_SOURCE,
    );
    expect(panel.html).toBe(expected);
    // The measured value survives into the document rather than being dropped
    // or rewritten: `'self'` is what VS Code sends and what style-src needs.
    expect(panel.html).toContain(`style-src 'nonce-AAAAAAAA' ${MEASURED_CSP_SOURCE}`);
    // The three properties the bridge package flagged as silent breakers.
    expect(panel.html).toContain(`<div id="${WEBVIEW_ROOT_ID}"></div>`);
    expect(panel.html).not.toContain('type="module"');
    expect(panel.html).not.toContain('img-src');
    controller.dispose();
  });

  it('the fake panel supplies the same cspSource the vscode double does', () => {
    // Two doubles of one VS Code value, in two files, is the shape that
    // produced the shipped defect: `test/vscode-mock.ts` was corrected to the
    // measured string while the literals in THIS file stayed invented, and
    // nothing compared them. The panel VS Code really builds is the mock's, so
    // the mock is the reference and this file must not drift from it.
    const panel = vscodeWindowDouble.createWebviewPanel('agentDeck.probe', 'probe', 1, {});
    expect(MEASURED_CSP_SOURCE).toBe(panel.webview.cspSource);
    panel.dispose();
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

  // -------------------------------------------------------------------------
  // DoD 5.5.2 — the host half of the resync contract
  // -------------------------------------------------------------------------

  /**
   * The repair the renderer could not ask for before Phase 5.5.
   *
   * `onDidBecomeVisible` already did exactly this for a panel RELOAD, and the
   * two are the same repair for opposite reasons: a reload is the editor
   * tearing the document down, which is normal, and a resync is the renderer
   * reporting that a patch did not apply, which is not. Counted separately so
   * one cannot hide inside the other.
   */
  it('a resyncRequest resets the bridge, re-snapshots, and is counted', () => {
    const panel = fakePanel();
    let snapshotsAsked = 0;
    const controller = new PanelController({
      panel: panel.surface,
      nonce: 'AAAAAAAA',
      onNeedsSnapshot: () => {
        snapshotsAsked += 1;
      },
    });

    // The webview has been sent its one snapshot; the bridge now believes it
    // knows what the renderer holds, and a second publish of the same state
    // therefore sends nothing.
    controller.publish(emission([state('s1')]));
    controller.publish(emission([state('s1')]));
    expect(controller.bridge.counters.snapshotsSent).toBe(1);
    expect(controller.counters.resyncs).toBe(0);

    panel.fireMessage({
      type: 'resyncRequest',
      reason: 'updateTool: no node with id ghost',
      failedOp: 'updateTool',
      sessionId: 's1',
    });

    expect(controller.counters.resyncs).toBe(1);
    expect(snapshotsAsked).toBe(1);
    // The bridge forgot what it thought the renderer had, so the NEXT emission
    // is a full snapshot rather than a diff against a state that no longer
    // exists on the other side. Without the reset this publish would send
    // nothing at all, exactly as the second one above did.
    controller.publish(emission([state('s1')]));
    expect(controller.bridge.counters.snapshotsSent).toBe(2);
    const last = panel.posted[panel.posted.length - 1];
    expect(last?.type).toBe('degraded');
    expect(panel.posted.filter((m) => m.type === 'snapshot')).toHaveLength(2);

    controller.dispose();
  });

  it('an invalid resyncRequest is dropped and repairs nothing', () => {
    const panel = fakePanel();
    let snapshotsAsked = 0;
    const controller = new PanelController({
      panel: panel.surface,
      nonce: 'AAAAAAAA',
      onNeedsSnapshot: () => {
        snapshotsAsked += 1;
      },
    });
    controller.publish(emission([state('s1')]));

    // `failedOp` outside the closed set; `reason` missing; both refused by the
    // guard before `#receive` ever branches on the type.
    panel.fireMessage({ type: 'resyncRequest', reason: 'x', failedOp: 'dropTables' });
    panel.fireMessage({ type: 'resyncRequest' });

    expect(controller.counters.resyncs).toBe(0);
    expect(snapshotsAsked).toBe(0);
    expect(controller.counters.messagesDropped).toBe(2);
    controller.dispose();
  });

  it('a resyncRequest still reaches onMessage, so the host can log it', () => {
    const panel = fakePanel();
    const seen: WebviewToHostMessage[] = [];
    const controller = new PanelController({
      panel: panel.surface,
      nonce: 'AAAAAAAA',
      onMessage: (m) => seen.push(m),
    });
    panel.fireMessage({ type: 'resyncRequest', reason: 'insertNode failed', sessionId: 's1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('resyncRequest');
    controller.dispose();
  });

  it('an onMessage that throws does not stop the repair, which already happened', () => {
    const panel = fakePanel();
    let snapshotsAsked = 0;
    const controller = new PanelController({
      panel: panel.surface,
      nonce: 'AAAAAAAA',
      onNeedsSnapshot: () => {
        snapshotsAsked += 1;
      },
      onMessage: () => {
        throw new Error('a logger blew up');
      },
    });
    controller.publish(emission([state('s1')]));
    expect(() => {
      panel.fireMessage({ type: 'resyncRequest', reason: 'x', sessionId: 's1' });
    }).not.toThrow();
    // Order is the assertion: the reset and the snapshot request run BEFORE
    // the host's handler, so a broken logger cannot cost the user a repair.
    expect(controller.counters.resyncs).toBe(1);
    expect(snapshotsAsked).toBe(1);
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
    const path = await startDataPathOnFreePort((port) => {
      // A retried attempt must not inherit the lost one's emissions.
      emissions.length = 0;
      return trackDataPath(
        new AgentDeckDataPath({
          workspacePath,
          projectsRoot: CAPTURED_ROOT,
          settings: settings({ port, ...overrides }),
          tickMs: 0,
          onEmission: (payload) => {
            emissions.push(payload);
          },
        }),
      );
    });
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

    // `burn` is the session's spend. Reading the LEVEL here would work too but
    // says less: a session that has spent nothing is the thing being excluded.
    const tokenBearing = sessions.filter(
      (s) => (s.burn?.prompt ?? 0) > 0 || (s.burn?.output ?? 0) > 0,
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
    const { port, release } = await heldPort();
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
    const path = await startDataPathOnFreePort((port) =>
      trackDataPath(
        new AgentDeckDataPath({
          workspacePath,
          projectsRoot: CAPTURED_ROOT,
          settings: settings({ port }),
          // The real tick interval, so a leaked tick would be a real leaked timer.
          onEmission: () => {},
        }),
      ),
    );
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
    const path = await startDataPathOnFreePort((port) =>
      trackDataPath(
        new AgentDeckDataPath({
          workspacePath: staged.workspacePath,
          projectsRoot: staged.projectsRoot,
          settings: settings({ port, livenessThresholdMs: 120_000 }),
          now: () => now,
          tickMs: 0,
          onEmission: () => {},
        }),
      ),
    );

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
    const path = await startDataPathOnFreePort((port) => {
      emissions.length = 0;
      return trackDataPath(
        new AgentDeckDataPath({
          workspacePath: staged.workspacePath,
          projectsRoot: staged.projectsRoot,
          settings: settings({ port }),
          now: () => now,
          tickMs: 0,
          onEmission: (payload) => {
            emissions.push(payload);
          },
        }),
      );
    });
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

    // Rebuilt per attempt: a retried bind must not inherit the lost attempt's
    // posted messages, which the `schemaMismatch` counts below would double.
    let panel = fakePanel();
    const host = await startHostOnFreePort(
      (port) => {
        panel = fakePanel();
        return trackHost(
          new AgentDeckHost({
            workspacePath: staged.workspacePath,
            projectsRoot: staged.projectsRoot,
            settings: settings({ port }),
            tickMs: 0,
            nonce: 'AAAAAAAA',
            createPanel: () => panel.surface,
            onEmission: () => {},
          }),
        );
      },
      (built) => {
        built.open();
      },
    );

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
    expect(state?.totals).toStrictEqual({ costUsd: 0 });
    expect(state?.contextNow).toStrictEqual({ prompt: 0, output: 0 });
    expect(state?.burn).toStrictEqual({ prompt: 0, output: 0 });

    const mismatches = panel.posted.filter((m) => m.type === 'schemaMismatch');
    expect(mismatches).toStrictEqual([{ type: 'schemaMismatch', sessionId }]);

    /*
     * AND NOTHING THAT DID REACH THE WEBVIEW CARRIES A TREE FOR THIS SESSION.
     *
     * The no-tree half is G3 itself and is asserted on EVERY snapshot,
     * unconditionally: a refused session must never be rendered as a smaller
     * tree, and "never" includes the snapshots posted before the first graft
     * finished.
     *
     * The `schemaOk` half is asserted from the schemaMismatch onward rather
     * than on every snapshot, and the reason is a measured property of the
     * host that this test used to depend on by accident. A session is
     * REGISTERED at discovery and GRAFTED asynchronously, so between those two
     * moments it is publishable with its default `schemaOk: true` and an empty
     * root. Observed sequence when the machine is quiet — the session's first
     * appearance is already refused, which is why this was invisible:
     *
     *   0:snapshot(mine=0)  1:degraded
     *   2:snapshot(mine=1 schemaOk=false nodes=1)  3:schemaMismatch  4:degraded
     *
     * Under a loaded suite a pump lands inside that window and a
     * `schemaOk=true, nodes=1` snapshot appears at index 1 — measured
     * 2026-09-03, one failure in three full runs, and `tickMs: 0` here (a test
     * setting; production is a real tick) is what makes the window wide enough
     * to hit at all. That is a pre-paint state, not a partial tree, so G3 is
     * intact — but a test that passes or fails by CPU load is a defect report
     * about the test, and the fix is to assert the property meant rather than
     * the ordering that happened to hold.
     *
     * The pre-graft publishability of a session is recorded in the handoff as
     * a product question (should an ungrafted session claim `schemaOk: true`
     * at all?); it is deliberately NOT changed here.
     *
     * `schemaOk === false` IS STILL ASSERTED, THREE TIMES, and none of the
     * three depends on ordering: on the model's own state above, on the
     * `schemaMismatch` message above, and — the one that is the actual user
     * guarantee — on a panel opened AFTER the refusal, at the end of this
     * test, which is where a real webview's refusal screen comes from.
     */
    let carriedOnTheWire = 0;
    for (const message of panel.posted) {
      if (message.type !== 'snapshot') continue;
      for (const session of message.sessions) {
        if (session.sessionId !== sessionId) continue;
        expect(countNodes(session.root)).toBe(1);
        carriedOnTheWire += 1;
      }
    }
    // Not vacuous: the loop above proves nothing if no snapshot ever carried
    // this session, which is exactly what a broken stage would produce.
    expect(carriedOnTheWire).toBeGreaterThan(0);

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
    const path = await startDataPathOnFreePort((port) =>
      trackDataPath(
        new AgentDeckDataPath({
          workspacePath: staged.workspacePath,
          projectsRoot: staged.projectsRoot,
          settings: settings({ port }),
          tickMs: 0,
          onEmission: () => {},
        }),
      ),
    );

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
    // Rebuilt per attempt: the `degraded` messages counted below are
    // per-panel, so a retried bind must not inherit an earlier panel.
    let panel = fakePanel();
    const host = await startHostOnFreePort((port) => {
      panel = fakePanel();
      return trackHost(
        new AgentDeckHost({
          workspacePath,
          projectsRoot: CAPTURED_ROOT,
          settings: settings({ port }),
          tickMs: 0,
          nonce: 'AAAAAAAA',
          createPanel: () => panel.surface,
          onEmission: () => {},
        }),
      );
    });
    // Production order: `activate()` starts the data path and the command opens
    // the panel later. Opening BEFORE the bind would publish a real, honest
    // `listenerDown` first (the socket genuinely is not bound yet) and this
    // test would then be measuring its own setup rather than the no-nagging
    // rule. `startHostOnFreePort` has already started it.
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
  /**
   * A STARTED host. `start()` is where the port is bound, so it has to be
   * inside the retried region -- which is why this helper starts the host
   * rather than handing back an unstarted one for each test to start.
   */
  async function makeHost(): Promise<{ host: AgentDeckHost; panels: FakePanel[] }> {
    const workspacePath = await capturedWorkspacePath();
    const panels: FakePanel[] = [];
    const host = await startHostOnFreePort((port) => {
      // A retried attempt starts from no panels, so `panelsCreated` and
      // `panels.length` still agree.
      panels.length = 0;
      return trackHost(
        new AgentDeckHost({
          workspacePath,
          projectsRoot: CAPTURED_ROOT,
          settings: settings({ port }),
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
    });
    return { host, panels };
  }

  it('opens one panel and reveals it on every later open', async () => {
    const { host, panels } = await makeHost();

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
    host.open();
    const first = panels[0]?.posted[0];
    expect(first?.type).toBe('snapshot');
  });

  it('closing the panel frees it, and the next open builds a new one', async () => {
    const { host, panels } = await makeHost();
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
    const workspacePath = await capturedWorkspacePath();
    const port = await activateOnFreePort((attemptPort) => {
      mock.setWorkspaceFolder(workspacePath);
      mock.setConfig(CONFIG_SECTION, { port: attemptPort, previewBytes: 4096 });
    });

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
    const foreign = join(await makeTempDir(), 'not-a-cc-project');

    // The positive proof below binds the configured port itself, so the whole
    // activate-then-probe sequence is the retried region: a port stolen by the
    // rest of the machine would otherwise read as "the extension bound it".
    // The two causes stay distinguishable because `currentHost()` is asserted
    // null BEFORE the probe -- with no host there is nothing of ours that
    // could be holding the port, so an EADDRINUSE here can only be foreign.
    await onFreePort<number>({
      use: async (port) => {
        resetVscodeMock();
        mock.setWorkspaceFolder(foreign);
        mock.setConfig(CONFIG_SECTION, { port });
        await activate(extensionContext());

        // No host means no `AgentDeckDataPath`, which is the only thing that
        // constructs a watcher, a listener or a timer.
        expect(currentHost()).toBeNull();
        expect(mock.panels).toHaveLength(0);

        // Proved positively rather than by absence of a host: the configured
        // port is still free, so nothing bound it.
        const release = await holdPort(port);
        await release();
        return port;
      },
      discard: async () => {
        await deactivate();
      },
    });

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
    const { port, release } = await heldPort();
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
    const workspacePath = await capturedWorkspacePath();
    await activateOnFreePort((port) => {
      mock.setWorkspaceFolder(workspacePath);
      mock.setConfig(CONFIG_SECTION, { port });
    });

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
// (8b) The correlation-failure message: an ambiguity is not an absence
// ---------------------------------------------------------------------------

describe('the inactive message distinguishes a refusal from an absence', () => {
  /**
   * P4-B added a fourth `DiscoveryFailureKind`, `ambiguousSlug`: the projects
   * root holds two directories whose names differ only by case and neither is
   * an exact match, so the tailer refuses to pick one rather than guessing —
   * G3 applied to a directory choice instead of to a parse. It carries the
   * non-errno code `EAMBIGUOUS` precisely because the filesystem call
   * SUCCEEDED.
   *
   * The message previously interpolated the kind into "no Claude Code sessions
   * for this workspace (<kind>)". For this one kind that sentence is false:
   * two candidate directories exist and sessions are almost certainly among
   * them. Telling a user there are none is a fabricated claim arriving as
   * prose rather than as a number.
   *
   * These assertions are on the MEANING, not the sentence: `claimsAbsence` and
   * `claimsRefusal` classify a message, so a copy edit is free and a collapsed
   * branch is not.
   *
   * Why the branch is driven through {@link inactiveReasonFor} rather than
   * through `activate()`: `ambiguousSlug` needs two sibling directories
   * differing only by case, and NTFS cannot hold them — the same constraint
   * `pathmatrix.test.ts` records for P4-B's probe, which does not run on a
   * case-insensitive filesystem. No test here fakes a filesystem to get around
   * that. The last test in this block ties `activate()`'s emitted message to
   * this function on the kinds that ARE reachable, so the arm that cannot be
   * reached is still the arm the host would use.
   */

  // `CLAUDE_PROJECTS_ROOT` is process-wide: the last test in this block sets
  // it, so it is restored here rather than left for the next describe to
  // inherit. Same guard the `activate` block uses, for the same reason.
  const previousRoot = process.env['CLAUDE_PROJECTS_ROOT'];

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['CLAUDE_PROJECTS_ROOT'];
    else process.env['CLAUDE_PROJECTS_ROOT'] = previousRoot;
  });

  /** Says, in whatever words, that this workspace has no sessions. */
  function claimsAbsence(message: string): boolean {
    return /\bno\b[^.]*\bsessions\b/i.test(message);
  }

  /** Says, in whatever words, that we declined to choose. */
  function claimsRefusal(message: string): boolean {
    return /refus/i.test(message);
  }

  function failure(kind: DiscoveryFailureKind): DiscoveryFailure {
    return {
      kind,
      code: kind === 'ambiguousSlug' ? 'EAMBIGUOUS' : 'ENOENT',
      path: join('projects', 'some-slug'),
      message: `synthetic ${kind}`,
    };
  }

  /**
   * The three kinds that ARE absences. Listed rather than derived because
   * `DiscoveryFailureKind` is a type and has no runtime members; a fourth
   * absence kind added later must be added here deliberately, which is the
   * point.
   */
  const ABSENCE_KINDS: DiscoveryFailureKind[] = [
    'projectsRootNotFound',
    'projectsRootUnreadable',
    'projectSlugNotFound',
  ];

  it('ambiguousSlug does NOT claim the workspace has no sessions', () => {
    const message = inactiveReasonFor(failure('ambiguousSlug'));
    expect(claimsAbsence(message), `must not claim absence: ${message}`).toBe(false);
    expect(claimsRefusal(message), `must say it refused: ${message}`).toBe(true);
    // Still diagnosable: the kind is in the string either way.
    expect(message).toContain('ambiguousSlug');
    expect(message.startsWith('Agent Deck:')).toBe(true);
  });

  it('the other three kinds still get the absence wording', () => {
    for (const kind of ABSENCE_KINDS) {
      const message = inactiveReasonFor(failure(kind));
      expect(claimsAbsence(message), `${kind} must claim absence: ${message}`).toBe(true);
      expect(claimsRefusal(message), `${kind} must not claim a refusal: ${message}`).toBe(false);
      expect(message).toContain(kind);
      expect(message.startsWith('Agent Deck:')).toBe(true);
    }
  });

  it('the two arms are different messages, not one message with two labels', () => {
    // Guards the collapse in both directions: if the ternary is replaced by
    // either arm alone, some pair here becomes equal after the kind name is
    // removed from both.
    const ambiguous = inactiveReasonFor(failure('ambiguousSlug')).replace('ambiguousSlug', '');
    for (const kind of ABSENCE_KINDS) {
      const absent = inactiveReasonFor(failure(kind)).replace(kind, '');
      expect(absent, `${kind} must not read like the ambiguity refusal`).not.toBe(ambiguous);
    }
  });

  it("activate() emits exactly inactiveReasonFor(failure) for the reachable kinds", async () => {
    // The end-to-end tie. Both legs use the REAL `correlateWorkspace` over a
    // real temp filesystem: the expectation is computed from the failure the
    // production code path actually produces, so this fails if `activate()`
    // stops calling the function, inlines a different string, or interpolates
    // a different kind.
    const legs: { name: string; root: string; workspace: string; expectKind: DiscoveryFailureKind }[] = [
      {
        name: 'projectSlugNotFound',
        root: CAPTURED_ROOT,
        workspace: join(await makeTempDir(), 'not-a-cc-project'),
        expectKind: 'projectSlugNotFound',
      },
      {
        name: 'projectsRootNotFound',
        root: join(await makeTempDir(), 'no-such-projects-root'),
        workspace: join(await makeTempDir(), 'ws'),
        expectKind: 'projectsRootNotFound',
      },
    ];

    for (const leg of legs) {
      resetVscodeMock();
      process.env['CLAUDE_PROJECTS_ROOT'] = leg.root;
      mock.setWorkspaceFolder(leg.workspace);
      // The ONE call site that is deliberately not retried, because it cannot
      // lose the race: both legs are correlation refusals, `activate` builds no
      // host, and nothing here ever binds the port. It is configured only so
      // the settings are complete. `expect(currentHost()).toBeNull()` below is
      // what makes that claim checkable rather than assumed.
      mock.setConfig(CONFIG_SECTION, { port: await freePort() });

      const correlation = await correlateWorkspace(leg.workspace);
      expect(correlation.ok, `${leg.name}: expected a refusal`).toBe(false);
      if (correlation.ok) throw new Error('unreachable');
      expect(correlation.failure.kind).toBe(leg.expectKind);

      await activate(extensionContext());
      expect(currentHost()).toBeNull();
      await mock.runCommand(OPEN_COMMAND);

      expect(mock.informationMessages).toHaveLength(1);
      expect(mock.informationMessages[0]).toBe(inactiveReasonFor(correlation.failure));
      expect(claimsAbsence(mock.informationMessages[0] as string)).toBe(true);
      await deactivate();
    }
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

    /*
     * THIS ASSERTION WAS NARROWED IN PHASE 5, AND THE NARROWING IS RECORDED
     * RATHER THAN QUIETLY MADE.
     *
     * It used to be `not.toMatch(/from '(node:)?fs/)` — no filesystem module at
     * all — on the stated grounds that "the host entry composes; it does not
     * touch the filesystem itself". DoD 5.2 made that false: the OpenCode
     * engine is "on by default when the data directory exists", so the host has
     * to ask whether a file exists.
     *
     * The property this test stands for is G1 — the host writes nothing — and a
     * blanket ban on the module name was a PROXY for it. The proxy is replaced
     * by the thing itself: exactly one `node:fs` import, naming exactly one
     * binding, and that binding is `existsSync`, which cannot write. The
     * write-API name ban in the sibling test above is unchanged and still lists
     * every write call by name.
     *
     * The alternative was to answer "does this file exist" by opening the
     * database and reading its degrade code, which would have constructed and
     * torn down a SQLite handle and a filesystem watch to avoid one syscall —
     * worse code, chosen to satisfy a proxy rather than the property.
     */
    const fsImports = [
      ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(?:node:)?fs'/g),
    ];
    expect(fsImports, 'src/extension.ts must import node:fs at most once').toHaveLength(1);
    const bound = (fsImports[0]?.[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
    expect(bound, 'the only node:fs binding may be the read-only existsSync').toStrictEqual([
      'existsSync',
    ]);

    // Everything else stays banned outright: the promises API, the default
    // namespace form, and any `require`.
    expect(source).not.toMatch(/from '(node:)?fs\/promises'/);
    expect(source).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s+'(node:)?fs'/);
    expect(source).not.toMatch(/require\(\s*['"](node:)?fs/);

    // Vacuity control: the matcher above does find a real import, so a rename
    // of the import form cannot silently turn this test into a no-op.
    expect(source).toContain("from 'node:fs'");
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
   *
   * ---------------------------------------------------------------------------
   * THE CEILING, AS FIXED IN PHASE 4 (carry-forward A)
   * ---------------------------------------------------------------------------
   * Until Phase 4, EVERY payload over 8 KB was truncated TWICE and only the
   * second cut saw the setting: the redaction path cut first at
   * `redact.DEFAULT_MAX_PAYLOAD_BYTES` (8192) because `graftSession` was not
   * given a `parse.maxPayloadBytes`, and the grafter's `preview()` then cut
   * what survived. Measured then, against the captured 63,774-byte
   * `tool-results/*.txt` — which is merely the largest of the 8 affected
   * payloads, 7 of which are inline and never touch `tool-results/`:
   *
   *   previewBytes=8192   marker read "8192 of 8248"    <- shipped default
   *   previewBytes=16384  marker read "8192 of 63774"
   *   previewBytes=65536  marker read "8192 of 63774"
   *
   * `graftSession` now derives the parse ceiling from `previewBytes` (floored
   * at 8192, because the `<persisted-output>` stub is ~2.2 KB and cutting it
   * shorter destroys the pointer to the offloaded file), and `preview()` uses
   * `truncatePreservingMarker`, which refuses to re-mark an already-marked
   * string against the length it was handed. Measured after, same fixtures:
   *
   *   previewBytes=8192   8 markers, "8192 of <real size>" for all 8
   *   previewBytes=16384  4 markers, "16384 of <real size>"; the other 4 fit
   *   previewBytes=65536  0 markers — the 63,774-byte payload is kept whole
   *
   * The two tests below therefore assert both halves: the kept-byte count
   * follows the setting BELOW and ABOVE 8192, and the second number in the
   * marker is the payload's size on disk rather than 8,248.
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
    const path = await startDataPathOnFreePort((port) => {
      emissions.length = 0;
      return trackDataPath(
        new AgentDeckDataPath({
          workspacePath,
          projectsRoot: CAPTURED_ROOT,
          settings: settings({ port, previewBytes }),
          tickMs: 0,
          onEmission: (payload) => {
            emissions.push(payload);
          },
        }),
      );
    });
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

  it('a previewBytes ABOVE 8192 increases the kept payload (carry-forward A, defect (a))', async () => {
    const payload = await offloadedPayload();
    // The subject must be big enough for 16384 to be a real cut and for
    // `payload.bytes + slack` to be a real non-cut. Derived from the file.
    expect(payload.bytes).toBeGreaterThan(16384);
    const needle = payload.text.slice(0, 160);

    const at16k = await previewsAt(16384);
    const offload16k = at16k.filter((p) => p.includes(needle));
    expect(offload16k).toHaveLength(1);
    // 8192 before the fix, at every setting above it.
    expect(keptBytes(offload16k[0] as string)).toBe(16384);
    expect(originalBytes(offload16k[0] as string)).toBe(payload.bytes);
    // Bytes, not characters: the marker counts UTF-8 bytes, and the two differ
    // on this fixture.
    expect(
      Buffer.byteLength((offload16k[0] as string).replace(TRUNCATION_MARKER_RE, ''), 'utf8'),
    ).toBe(16384);

    // A ceiling above the payload keeps it whole: no marker at all, and the
    // preview carries the payload's own byte count.
    const ceiling = payload.bytes + 4096;
    const whole = (await previewsAt(ceiling)).filter((p) => p.includes(needle));
    expect(whole).toHaveLength(1);
    expect(keptBytes(whole[0] as string)).toBeNull();
    expect(Buffer.byteLength(whole[0] as string, 'utf8')).toBe(payload.bytes);
  });

  it('the marker states the ORIGINAL payload size, not 8248 (carry-forward A, defect (b))', async () => {
    const payload = await offloadedPayload();
    const previews = await previewsAt(8192);
    const fromOffload = previews.filter((p) => p.includes(payload.text.slice(0, 160)));
    expect(fromOffload).toHaveLength(1);
    const marker = fromOffload[0] as string;
    expect(keptBytes(marker)).toBe(8192);
    // The number the fixture's own bytes say, read from disk in this test.
    expect(originalBytes(marker)).toBe(payload.bytes);
    // The old, fabricated number: 8192 plus the marker's own length.
    expect(originalBytes(marker)).not.toBe(8192 + truncationMarker(8192, payload.bytes).length);
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
    let graftCalls = 0;
    let port = 0;
    const path = await onFreePort<AgentDeckDataPath>({
      use: async (attemptPort) => {
        port = attemptPort;
        graftCalls = 0;
        const built = trackDataPath(
          new AgentDeckDataPath({
            workspacePath,
            projectsRoot: CAPTURED_ROOT,
            settings: settings({ port: attemptPort }),
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
        await expect(built.start()).resolves.toBeUndefined();
        return built;
      },
      collided: (built) => built.diagnostics.bindError?.code === 'EADDRINUSE',
      discard: (built) => built.dispose(),
    });

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
      diagnostics: { malformedLines: 0, parsedLines: 0, ignoredLines: 0, skippedFiles: [] },
    };
    const path = await startDataPathOnFreePort((port) =>
      trackDataPath(
        new AgentDeckDataPath({
          workspacePath,
          projectsRoot: CAPTURED_ROOT,
          settings: settings({ port }),
          tickMs: 0,
          onEmission: () => {},
          graft: () => Promise.resolve(refusal),
        }),
      ),
    );

    expect(path.diagnostics.graftErrors).toBe(0);
    expect(path.diagnostics.graftRefusals).toBe(path.diagnostics.grafts);
    expect(path.model.counters().contentFailures).toBe(0);
    const [victim] = path.model.sessionIds() as [string];
    expect(path.model.refusalOf(victim)?.mismatch?.reason).toBe('injected refusal');
  });

  it('F2: a refusal produces one diagnostics event carrying the REASON', async () => {
    /*
     * The test above is exactly the state F2 was found in: it asserts
     * `graftRefusals === grafts` and nothing at all about WHY. That equality is
     * what was read, on 2026-08-31, as "the CC adapter is broken on 2.1.251"
     * when the cause was one teleported transcript. A count that cannot be
     * told apart from a total outage is the defect, and this is the assertion
     * that says the reason travelled with it.
     */
    const workspacePath = await capturedWorkspacePath();
    const refusal: GraftSessionResult = {
      ok: false,
      mismatch: {
        kind: 'schemaMismatch',
        code: 'unsupportedVersion',
        reason: 'transcript was written by an unpinned CC version',
        path: 'C:\\Users\\somebody\\.claude\\projects\\c--invented-agent-deck\\s.jsonl:1',
        field: 'version',
        expected: '2.1.246',
        actual: '1.0',
      },
      diagnostics: { malformedLines: 0, parsedLines: 0, ignoredLines: 0, skippedFiles: [] },
    };
    const events: DiagnosticsEvent[] = [];
    const path = await startDataPathOnFreePort((port) =>
      trackDataPath(
        new AgentDeckDataPath({
          workspacePath,
          projectsRoot: CAPTURED_ROOT,
          settings: settings({ port }),
          tickMs: 0,
          onEmission: () => {},
          graft: () => Promise.resolve(refusal),
          onDiagnostic: (event) => events.push(event),
        }),
      ),
    );

    expect(events).toHaveLength(path.diagnostics.graftRefusals);
    expect(events.length).toBeGreaterThan(0);
    const [event] = events as [DiagnosticsEvent];
    if (event.kind !== 'graftRefused') throw new Error(`unexpected event ${event.kind}`);
    expect(event.code).toBe('unsupportedVersion');
    expect(event.field).toBe('version');
    expect(event.expected).toBe('2.1.246');
    expect(event.actual).toBe('1.0');
    // Reduced, not passed through: the absolute path never reaches the channel.
    expect(event.at).toBe('s.jsonl:1');

    // And kept as a level, the way a THROW has always been kept — which is the
    // asymmetry F2 closes.
    const level = path.diagnostics.lastGraftRefusal;
    expect(level).toBeDefined();
    expect(level?.code).toBe('unsupportedVersion');
    expect(level?.at).toBe('s.jsonl:1');
    expect(path.diagnostics.lastGraftError).toBeUndefined();
  });

  it('F2: a throwing diagnostics sink cannot break a graft', async () => {
    // A diagnostics surface that can take the data path down with it is worse
    // than no diagnostics surface. Counted as a consumer error, like a
    // throwing `onEmission`, and the refusal itself still lands in the model.
    const workspacePath = await capturedWorkspacePath();
    const refusal: GraftSessionResult = {
      ok: false,
      mismatch: { kind: 'schemaMismatch', code: 'metaFieldMissing', reason: 'injected refusal' },
      diagnostics: { malformedLines: 0, parsedLines: 0, ignoredLines: 0, skippedFiles: [] },
    };
    const path = await startDataPathOnFreePort((port) =>
      trackDataPath(
        new AgentDeckDataPath({
          workspacePath,
          projectsRoot: CAPTURED_ROOT,
          settings: settings({ port }),
          tickMs: 0,
          onEmission: () => {},
          graft: () => Promise.resolve(refusal),
          onDiagnostic: () => {
            throw new Error('the channel exploded');
          },
        }),
      ),
    );

    expect(path.diagnostics.graftErrors).toBe(0);
    expect(path.diagnostics.graftRefusals).toBe(path.diagnostics.grafts);
    expect(path.diagnostics.consumerErrors).toBeGreaterThan(0);
    const [victim] = path.model.sessionIds() as [string];
    expect(path.model.refusalOf(victim)?.mismatch?.reason).toBe('injected refusal');
  });
});

// ---------------------------------------------------------------------------
// DoD 5.2 — OpenCode discovery, the switch, and the chained liveness engine
// ---------------------------------------------------------------------------

/** A log sink. Every level recorded, so "at info level" is assertable. */
function captureLog(): {
  log: (level: HostLogLevel, message: string) => void;
  lines: { level: HostLogLevel; message: string }[];
} {
  const lines: { level: HostLogLevel; message: string }[] = [];
  return {
    lines,
    log: (level, message) => {
      lines.push({ level, message });
    },
  };
}

/** A poll trigger the test fires by hand. No timer, no wall clock (A2). */
function manualPollTrigger(): {
  trigger: PollTrigger;
  fire: () => void;
  registrations: number[];
  stops: () => number;
} {
  const runs: (() => void)[] = [];
  const registrations: number[] = [];
  let stops = 0;
  const trigger: PollTrigger = (run, intervalMs): PollTriggerHandle => {
    runs.push(run);
    registrations.push(intervalMs);
    return {
      stop: () => {
        stops += 1;
      },
    };
  };
  return {
    trigger,
    registrations,
    fire: () => {
      for (const run of runs) run();
    },
    stops: () => stops,
  };
}

/**
 * The smallest committed OpenCode corpus, chosen BY SIZE rather than by name.
 *
 * Nothing in this file depends on which corpus it is, and the recorded rule is
 * not to assert fixture-set sizes or hard-code a capture's name.
 */
function smallestCorpus(): string {
  const names = listCorpora();
  expect(names.length).toBeGreaterThan(0);
  let best = '';
  let bestSize = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const size = statSync(corpusDbPath(name)).size;
    if (size < bestSize) {
      bestSize = size;
      best = name;
    }
  }
  return best;
}

/** The one `project.worktree` in a corpus, READ OFF THE DATABASE. */
function worktreeOf(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT worktree FROM project ORDER BY id').all() as Record<
      string,
      unknown
    >[];
    const first = rows[0]?.['worktree'];
    expect(typeof first, 'the corpus must carry a project row').toBe('string');
    return first as string;
  } finally {
    db.close();
  }
}

/**
 * Every ROOT session id in a corpus, read off the database and sorted.
 *
 * Root, because `readOpenCodeEngine` emits one `SessionState` per root and a
 * refused CHILD is a different, still-open item (`COVERAGE.md` item 29).
 */
function rootSessionIdsOf(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      db.prepare('SELECT id FROM session WHERE parent_id IS NULL ORDER BY id').all() as Record<
        string,
        unknown
      >[]
    ).map((row) => String(row['id']));
  } finally {
    db.close();
  }
}

/**
 * Root sessions that have NO child session.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT "ANY ROOT", AND THE DEFECT THAT MADE IT NECESSARY
 * ---------------------------------------------------------------------------
 * MEASURED while writing the test below. Pushing a root session out of the
 * version window when that root HAS AN ACCEPTED CHILD makes
 * `readOpenCodeEngine` THROW:
 *
 *   session rows reachable from no root: ses_...
 *
 * — which its own doc comment says cannot happen ("Never thrown, always
 * returned"). The child stays in the accepted partition while its parent is
 * parked, so the grafter finds a row it cannot reach from any root. The whole
 * OpenCode deck then reads EMPTY for that user, which is the same G3 hole this
 * block is about, arriving through a different door.
 *
 * That is `src/opencode/**` and is NOT this package’s to fix; it is reported
 * rather than pinned, because asserting the current behaviour would freeze a
 * defect. It is closely related to `COVERAGE.md` item 29 (a refused CHILD gets
 * the wrong park code) — this is the same join seen from the parent side.
 *
 * The one thing this file DOES do about it is the `contentFailures: 0`
 * assertion at each call site: the tests below would otherwise have passed
 * their "healthy sessions stay hidden" control on an empty read.
 */
function childlessRootIdsOf(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        'SELECT id FROM session WHERE parent_id IS NULL AND id NOT IN (SELECT parent_id FROM session WHERE parent_id IS NOT NULL) ORDER BY id',
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => String(row['id']));
  } finally {
    db.close();
  }
}

/** A started OpenCode path over one database, with no timer and no watcher. */
function openOcPath(dbPath: string, paths: readonly string[]): OpenCodeEnginePath {
  const path = new OpenCodeEnginePath({
    workspacePaths: paths,
    thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
    onChange: () => {},
    dbPath,
    now: () => 1_000,
    pollTrigger: () => ({ stop: () => {} }),
    walWatchFactory: () => ({ close: () => {} }),
    log: () => {},
  });
  path.start();
  return path;
}

/** The same path with its Windows drive letter case-flipped, or null. */
function flipDriveLetter(path: string): string | null {
  const match = /^([A-Za-z]):/.exec(path);
  if (match === null) return null;
  const letter = match[1] as string;
  const flipped = letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase();
  return flipped + path.slice(1);
}

describe('DoD 5.2 — the OpenCode engine is on when its store exists, and off when it does not', () => {
  const previousProjectsRoot = process.env['CLAUDE_PROJECTS_ROOT'];

  afterEach(() => {
    if (previousProjectsRoot === undefined) delete process.env['CLAUDE_PROJECTS_ROOT'];
    else process.env['CLAUDE_PROJECTS_ROOT'] = previousProjectsRoot;
  });

  it('is silently OFF with an absent store, and says so exactly ONCE at info level', () => {
    const missing = join(process.env[OPENCODE_DATA_ROOT_ENV] as string, 'opencode.db');
    expect(existsSync(missing)).toBe(false);
    const sink = captureLog();

    const path = new OpenCodeEnginePath({
      workspacePaths: ['/anywhere'],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: () => {},
      dbPath: missing,
      log: sink.log,
    });
    path.start();
    // "Once" is a claim about repetition, so it is driven by repeating.
    path.start();
    path.start();

    expect(sink.lines).toStrictEqual([{ level: 'info', message: OPENCODE_ABSENT_LOG }]);
    const diagnostics = path.diagnostics;
    expect(diagnostics.enabled).toBe(false);
    expect(diagnostics.absentLogs).toBe(1);
    // Silently off means OFF: no store was read and nothing is polling, so
    // there is no tick that could produce a second line later.
    expect(diagnostics.contentReads).toBe(0);
    expect(diagnostics.livenessPolls).toBe(0);
    expect(path.livenessEngine).toBeNull();
    expect(path.sessions()).toStrictEqual([]);
    path.dispose();
  });

  it('is ON when the store exists, with no setting anywhere in the manifest', async () => {
    const dir = await makeTempDir();
    const dbPath = copyCorpus(smallestCorpus(), dir);
    const sink = captureLog();
    const poll = manualPollTrigger();
    let clock = 1_000;

    const path = new OpenCodeEnginePath({
      workspacePaths: [worktreeOf(dbPath)],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: () => {},
      dbPath,
      log: sink.log,
      now: () => clock,
      pollTrigger: poll.trigger,
      // No WAL watch: this test drives the cadence itself, and chokidar's
      // absence is what keeps it from measuring the filesystem.
      walWatchFactory: () => ({ close: () => {} }),
    });
    path.start();

    expect(sink.lines).toStrictEqual([]);
    expect(path.diagnostics.enabled).toBe(true);
    expect(path.diagnostics.contentReads).toBe(1);
    expect(path.sessions().length).toBeGreaterThan(0);
    for (const session of path.sessions()) {
      expect(session.engine).toBe('opencode');
      expect(session.workspaceMatch).toBe(true);
    }

    // B5: the liveness engine is CHAINED, not merely constructible. The
    // trigger it registered is the host's, the interval is the engine's
    // constant, and firing it advances the poll counter.
    expect(poll.registrations).toStrictEqual([DEFAULT_OC_POLL_INTERVAL_MS]);
    const before = path.diagnostics.livenessPolls;
    expect(before).toBeGreaterThan(0);
    clock += 1;
    poll.fire();
    expect(path.diagnostics.livenessPolls).toBe(before + 1);

    path.dispose();
    expect(poll.stops()).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  it('declares no OpenCode setting: the switch is the store, and only the store', async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { contributes?: { configuration?: { properties?: Record<string, unknown> } } };
    const keys = Object.keys(manifest.contributes?.configuration?.properties ?? {});
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.toLowerCase(), `${key} is an OpenCode setting; DoD 5.2 says there is none`)
        .not.toContain('opencode');
    }
  });

  it('matches project.worktree case-insensitively, drive letter included', async () => {
    const dir = await makeTempDir();
    const dbPath = copyCorpus(smallestCorpus(), dir);
    const worktree = worktreeOf(dbPath);
    const flipped = flipDriveLetter(worktree);
    expect(flipped, 'the corpus worktree carries no drive letter to flip').not.toBeNull();
    expect(flipped).not.toBe(worktree);

    const openWith = (paths: readonly string[]): OpenCodeEnginePath => {
      const path = new OpenCodeEnginePath({
        workspacePaths: paths,
        thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
        onChange: () => {},
        dbPath,
        now: () => 1_000,
        pollTrigger: () => ({ stop: () => {} }),
        walWatchFactory: () => ({ close: () => {} }),
      });
      path.start();
      return path;
    };

    const asWritten = openWith([worktree]);
    const asFlipped = openWith([flipped as string]);
    // Also flip the case of a non-drive component, which must NOT be the thing
    // doing the work: the comparison is case-insensitive throughout.
    const asShouted = openWith([worktree.toUpperCase()]);
    const asForeign = openWith([join(dir, 'not-the-project')]);

    const ids = (path: OpenCodeEnginePath): string[] =>
      path.sessions().map((s) => s.sessionId).sort();

    expect(ids(asWritten).length).toBeGreaterThan(0);
    expect(ids(asFlipped)).toStrictEqual(ids(asWritten));
    expect(ids(asShouted)).toStrictEqual(ids(asWritten));
    // The vacuity control: the matcher does refuse something.
    expect(ids(asForeign)).toStrictEqual([]);

    for (const path of [asWritten, asFlipped, asShouted, asForeign]) path.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('B6: every open workspace folder reaches the engine, not just the first', async () => {
    const staged = await stageFixtureSlug(await capturedSlugDir());
    process.env['CLAUDE_PROJECTS_ROOT'] = staged.projectsRoot;
    const second = join(await makeTempDir(), 'second-root');
    await mkdir(second, { recursive: true });

    await activateOnFreePort((port) => {
      // The mock's setter is single-folder and this package does not own that
      // file, so the folder list is installed directly. `activateOnFreePort`
      // resets the mock first, so this must happen inside it.
      mock.state.workspaceFolders = [
        { uri: Uri.file(staged.workspacePath), name: 'a', index: 0 },
        { uri: Uri.file(second), name: 'b', index: 1 },
      ];
      expect(workspacePathsOf(mock.state.workspaceFolders)).toStrictEqual([
        staged.workspacePath,
        second,
      ]);
      mock.setConfig(CONFIG_SECTION, { port });
    });

    const host = currentHost();
    expect(host).not.toBeNull();
    // The asymmetry, asserted rather than described: OpenCode gets both roots,
    // Claude Code gets the first. Recorded as an open item at the call site.
    expect(host?.dataPath.workspacePaths).toStrictEqual([staged.workspacePath, second]);
    expect(host?.dataPath.workspacePath).toBe(staged.workspacePath);
    expect(host?.dataPath.opencode.workspacePaths).toStrictEqual([
      staged.workspacePath,
      second,
    ]);
  });

  it('workspacePathsOf answers [] for no folders, so the engine matches nothing', () => {
    expect(workspacePathsOf(undefined)).toStrictEqual([]);
    expect(workspacePathsOf([])).toStrictEqual([]);
  });

  it("opencodeStoreExists follows the engine's own environment override", async () => {
    const empty = await makeTempDir();
    expect(opencodeStoreExists({ [OPENCODE_DATA_ROOT_ENV]: empty })).toBe(false);
    expect(opencodeDataDir({ [OPENCODE_DATA_ROOT_ENV]: empty })).toBe(empty);

    const stocked = await makeTempDir();
    copyCorpus(smallestCorpus(), stocked);
    expect(opencodeStoreExists({ [OPENCODE_DATA_ROOT_ENV]: stocked })).toBe(true);
    await rm(stocked, { recursive: true, force: true });
  });

  it('activate() with no Claude Code project but a live store starts the OpenCode half only', async () => {
    const stocked = await makeTempDir();
    copyCorpus(smallestCorpus(), stocked);
    process.env[OPENCODE_DATA_ROOT_ENV] = stocked;

    // A workspace with no Claude Code project directory at all, in a projects
    // root that is real and empty — so the refusal is a measured absence and
    // not a missing-root error.
    process.env['CLAUDE_PROJECTS_ROOT'] = await makeTempDir();
    const lonely = join(await makeTempDir(), 'no-cc-here');
    await mkdir(lonely, { recursive: true });

    resetVscodeMock();
    mock.setWorkspaceFolder(lonely);
    mock.setConfig(CONFIG_SECTION, { port: DEFAULT_PORT });
    await activate(extensionContext());

    const host = currentHost();
    expect(host, 'an OpenCode-only workspace still gets a deck').not.toBeNull();
    const diagnostics = host?.dataPath.diagnostics;
    // The correlation gate's point survives: no watcher, no socket, no CC tick.
    expect(diagnostics?.ccEnabled).toBe(false);
    expect(diagnostics?.listening).toBe(false);
    expect(diagnostics?.opencode.enabled).toBe(true);

    await deactivate();
    await rm(stocked, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// DoD 5.2 / G3 — the deck filter hides other workspaces, and never refusals
// ---------------------------------------------------------------------------

/*
 * WHY THIS BLOCK EXISTS, SO IT IS NOT READ AS A DUPLICATE OF THE ONE ABOVE.
 *
 * The deck filter and the engine were each locally correct and composed into a
 * G3 hole: `src/opencode/index.ts` hard-coded `workspaceMatch: false` on a
 * session its fingerprint refused, and this host filtered on `workspaceMatch`,
 * so a user whose OpenCode version drifted out of the window saw NOTHING on
 * the deck instead of an `unsupported` card. `index.ts` carries the sentence
 * it violated: "a refusal that is invisible to the renderer is not a refusal."
 *
 * BOTH SIDES ARE FIXED, by user decision, so neither file can reintroduce the
 * hole alone. These tests are written to hold WHETHER OR NOT the engine half
 * has landed: nothing here asserts what `workspaceMatch` reads on a refused
 * session, only that the refusal reaches the deck.
 */
describe('DoD 5.2 / G3 — a refused OpenCode session is never filtered off the deck', () => {
  it('keeps the refusal while a healthy session in another workspace stays hidden', async () => {
    const dir = await makeTempDir();
    const dbPath = copyCorpus(smallestCorpus(), dir);

    const roots = rootSessionIdsOf(dbPath);
    const childless = childlessRootIdsOf(dbPath);
    expect(roots.length, 'the corpus must carry more than one root').toBeGreaterThan(1);
    expect(childless.length, 'the corpus must carry a childless root').toBeGreaterThan(0);
    // See `childlessRootIdsOf`: refusing a root that HAS a child makes the
    // engine throw, which is a separate, reported defect and not this test.
    const victim = childless[0] as string;
    const survivors = roots.filter((id) => id !== victim);

    // Push ONE root out of the version window. Major 9 is out on the MAJOR
    // component, so no move of the anchor inside 1.x can re-admit it — the rule
    // the CC refusal fixtures were twice re-versioned under, applied here so
    // this test cannot quietly stop refusing anything.
    withWritableDb(dbPath, (db) => {
      db.prepare('UPDATE session SET version = ? WHERE id = ?').run('9.9.9', victim);
    });

    // A workspace the corpus was NOT captured in, so nothing matches.
    const foreign = join(dir, 'a-workspace-this-corpus-was-not-captured-in');
    const path = openOcPath(dbPath, [foreign]);
    try {
      // THE READ ACTUALLY SUCCEEDED. Without this, "the refusal is on the
      // deck" could pass for the wrong reason on a read that returned nothing
      // at all — and it very nearly did: see the note on `childlessRootIdsOf`.
      expect(path.diagnostics, JSON.stringify(path.diagnostics)).toMatchObject({
        contentReads: 1,
        contentFailures: 0,
        schemaMismatches: 0,
        degradedReads: 0,
      });
      const onDeck = path.sessions();
      const ids = onDeck.map((s) => s.sessionId);

      // The carve-out: the refusal is on the deck even though it matches no
      // open workspace. Nothing is asserted about its `workspaceMatch` — the
      // engine half may or may not have landed when this runs.
      expect(
        ids,
        'a refused session must never be filtered off the deck',
      ).toContain(victim);
      const refused = onDeck.find((s) => s.sessionId === victim);
      expect(refused?.schemaOk).toBe(false);
      expect(refused?.liveness).toBe('unsupported');
      // A refusal renders NOTHING. It is not a hole to smuggle content through.
      expect(refused?.root.children).toStrictEqual([]);
      expect(refused?.totals).toStrictEqual({ costUsd: 0 });
      // ABSENT rather than zero, and the difference is the engine's: this is an
      // OPENCODE refusal, and that engine reports no token figures at all yet.
      // The CC refusal path (`unsupportedCopy` in `extension.ts`) zeroes them
      // instead, because CC does report them and 0 is the honest reading there.
      expect(refused?.contextNow).toBeUndefined();
      expect(refused?.burn).toBeUndefined();

      // THE CONTROL. Without it this test cannot tell the carve-out apart from
      // deleting the filter: healthy sessions in a non-matching workspace must
      // still be hidden.
      expect(survivors.length).toBeGreaterThan(0);
      for (const id of survivors) {
        expect(
          ids,
          `healthy session ${id} in another workspace must stay hidden`,
        ).not.toContain(id);
      }
      expect(onDeck).toHaveLength(1);
    } finally {
      path.dispose();
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('and with a MATCHING workspace, the refusal renders beside the healthy ones', async () => {
    const dir = await makeTempDir();
    const dbPath = copyCorpus(smallestCorpus(), dir);
    const roots = rootSessionIdsOf(dbPath);
    const victim = childlessRootIdsOf(dbPath)[0] as string;

    withWritableDb(dbPath, (db) => {
      db.prepare('UPDATE session SET version = ? WHERE id = ?').run('9.9.9', victim);
    });

    const path = openOcPath(dbPath, [worktreeOf(dbPath)]);
    try {
      // THE READ ACTUALLY SUCCEEDED. Without this, "the refusal is on the
      // deck" could pass for the wrong reason on a read that returned nothing
      // at all — and it very nearly did: see the note on `childlessRootIdsOf`.
      expect(path.diagnostics, JSON.stringify(path.diagnostics)).toMatchObject({
        contentReads: 1,
        contentFailures: 0,
        schemaMismatches: 0,
        degradedReads: 0,
      });
      const ids = path
        .sessions()
        .map((s) => s.sessionId)
        .sort();
      // Every root, refused and healthy alike, and each EXACTLY ONCE: the
      // carve-out must not double-count a session that also matches.
      expect(ids).toStrictEqual([...roots].sort());
      for (const session of path.sessions()) {
        expect(
          session.schemaOk,
          `${session.sessionId} schemaOk`,
        ).toBe(session.sessionId !== victim);
      }
    } finally {
      path.dispose();
    }
    await rm(dir, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// DoD 3.2 — the Codex engine path
// ---------------------------------------------------------------------------

/** The committed real Codex corpus's `.codex` root, containing `sessions/`. */
const CODEX_FIXTURE_ROOT = fileURLToPath(
  new URL(
    '../fixtures/codex-0.151.0-alpha.7.2/baseline/home/.codex',
    import.meta.url,
  ),
);

/**
 * A private copy of the fixture root, so a test may add a real (possibly
 * empty) `thread-writer-locks/` directory beside it without mutating the
 * committed fixture (G6).
 */
async function stageCodexRoot(withEmptyLockDir: boolean): Promise<string> {
  const dir = await makeTempDir();
  const root = join(dir, '.codex');
  await cp(CODEX_FIXTURE_ROOT, root, { recursive: true });
  if (withEmptyLockDir) {
    await mkdir(join(root, 'thread-writer-locks'), { recursive: true });
  }
  return root;
}

/** The fixture's ROOT thread — `cwd` and `sessionId` — read through the production engine. */
async function codexBaselineRoot(root: string): Promise<{ cwd: string; sessionId: string }> {
  const outcome = await readCodexEngine({ root });
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') throw new Error('unreachable: asserted above');
  const rootThread = outcome.result.threads.find(
    (t: CodexThread) => t.threadSource === 'user',
  );
  expect(rootThread, 'the Codex fixture must carry a root thread').toBeDefined();
  return { cwd: (rootThread as CodexThread).cwd, sessionId: (rootThread as CodexThread).sessionId };
}

describe('DoD 3.2 — the Codex engine is on when its data root exists, and off when it does not', () => {
  it('is silently OFF with an absent root, and says so exactly ONCE at info level', async () => {
    const dir = await makeTempDir();
    const missing = join(dir, 'no-such-.codex');
    expect(existsSync(missing)).toBe(false);
    const sink = captureLog();

    const path = new CodexEnginePath({
      workspaceFolders: ['/anywhere'],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: () => {},
      root: missing,
      log: sink.log,
    });
    await path.start();
    // "Once" is a claim about repetition, so it is driven by repeating.
    await path.start();
    await path.start();

    expect(sink.lines).toStrictEqual([{ level: 'info', message: CODEX_ABSENT_LOG }]);
    const diagnostics = path.diagnostics;
    expect(diagnostics.enabled).toBe(false);
    expect(diagnostics.absentLogs).toBe(1);
    expect(diagnostics.contentReads).toBe(1);
    expect(diagnostics.livenessPolls).toBe(0);
    expect(path.livenessEngine).toBeNull();
    expect(path.sessions()).toStrictEqual([]);
    path.dispose();
  });

  it('is ON when the data root exists, with no setting anywhere in the manifest', async () => {
    const root = await stageCodexRoot(false);
    const { cwd, sessionId } = await codexBaselineRoot(root);
    const sink = captureLog();
    const poll = manualPollTrigger();
    let clock = 1_000;

    const path = new CodexEnginePath({
      workspaceFolders: [cwd],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: () => {},
      root,
      log: sink.log,
      now: () => clock,
      pollTrigger: poll.trigger,
    });
    await path.start();

    expect(sink.lines).toStrictEqual([]);
    expect(path.diagnostics.enabled).toBe(true);
    expect(path.diagnostics.contentReads).toBe(1);
    const session = path.sessions().find((s) => s.sessionId === sessionId);
    expect(session, 'the root session must render').toBeDefined();
    expect(session?.engine).toBe('codex');
    expect(session?.workspaceMatch).toBe(true);

    // The liveness engine is CHAINED, not merely constructible: it registers
    // its own poll AND this class registers a second one for the periodic
    // content re-read — two triggers, the same interval, because there is no
    // cheap cursor to gate the content half on (see
    // `DEFAULT_CODEX_ENGINE_POLL_INTERVAL_MS`'s doc comment).
    expect(poll.registrations).toStrictEqual([
      DEFAULT_CODEX_ENGINE_POLL_INTERVAL_MS,
      DEFAULT_CODEX_ENGINE_POLL_INTERVAL_MS,
    ]);
    const beforePolls = path.diagnostics.livenessPolls;
    expect(beforePolls).toBeGreaterThan(0);
    clock += 1;
    poll.fire();
    expect(path.diagnostics.livenessPolls).toBe(beforePolls + 1);
    // The content-refresh trigger fired too — its increment is synchronous
    // (before the read's own `await`), so it is observable immediately.
    expect(path.diagnostics.contentReads).toBe(2);

    path.dispose();
    expect(poll.stops()).toBe(2);
    await rm(dirname(root), { recursive: true, force: true });
  });

  it('declares no Codex setting: the switch is the data root, and only the data root', async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { contributes?: { configuration?: { properties?: Record<string, unknown> } } };
    const keys = Object.keys(manifest.contributes?.configuration?.properties ?? {});
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.toLowerCase(), `${key} is a Codex setting; DoD 3.2 says there is none`)
        .not.toContain('codex');
    }
  });

  it('a Codex hook event moves the root session from idle to live', async () => {
    const root = await stageCodexRoot(false);
    const { cwd, sessionId } = await codexBaselineRoot(root);
    const clock = 10_000;
    const path = new CodexEnginePath({
      workspaceFolders: [cwd],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: () => {},
      root,
      now: () => clock,
      pollTrigger: () => ({ stop: () => {} }),
    });
    await path.start();
    const before = path.sessions().find((s) => s.sessionId === sessionId);
    expect(before, 'the root session must render').toBeDefined();

    // DoD 3.1's other half: the seam `AgentDeckDataPath` wires
    // `listener.subscribeCodex` to.
    path.ingestHookEvent({
      receivedAtMs: clock,
      payload: {
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        model: 'gpt-5.6-terra',
        tool_use_id: 'call_x',
      },
    });
    // Re-render against the ingested event, the same thing a periodic poll
    // would do.
    path.livenessEngine?.poll();

    const after = path.sessions().find((s) => s.sessionId === sessionId);
    expect(after?.liveness).toBe('live');

    path.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  });

  it("D0.1 'dead' maps to 'ended': an empty lock directory and no hook events", async () => {
    const root = await stageCodexRoot(true);
    const { cwd, sessionId } = await codexBaselineRoot(root);
    const path = new CodexEnginePath({
      workspaceFolders: [cwd],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: () => {},
      root,
      now: () => 10_000,
      pollTrigger: () => ({ stop: () => {} }),
    });
    await path.start();
    const session = path.sessions().find((s) => s.sessionId === sessionId);
    expect(session, 'the root session must render').toBeDefined();
    expect(session?.liveness).toBe('ended');

    path.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  });

  it('disposing stops both the content-refresh trigger and the liveness poll trigger', async () => {
    const root = await stageCodexRoot(false);
    const { cwd } = await codexBaselineRoot(root);
    let stops = 0;
    const path = new CodexEnginePath({
      workspaceFolders: [cwd],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: () => {},
      root,
      now: () => 1_000,
      pollTrigger: () => ({
        stop: () => {
          stops += 1;
        },
      }),
    });
    await path.start();
    expect(stops).toBe(0);
    path.dispose();
    expect(stops).toBe(2);
    expect(path.sessions()).toStrictEqual([]);
    await rm(dirname(root), { recursive: true, force: true });
  });

  it("AgentDeckDataPath mounts the Codex engine with the same crash isolation as OpenCode: it shares no CC or OpenCode object", async () => {
    const source = await readFile(
      fileURLToPath(new URL('./extension.ts', import.meta.url)),
      'utf8',
    );
    const construction = /this\.codex = new CodexEnginePath\(\{[\s\S]*?\n {4}\}\);/.exec(source);
    expect(construction, 'the Codex path construction site must be findable').not.toBeNull();
    const text = construction?.[0] ?? '';
    for (const forbidden of [
      'this.liveness',
      'this.model',
      'this.listener',
      'this.watcher',
      'this.opencode',
    ]) {
      expect(text, `the Codex path was handed ${forbidden}`).not.toContain(forbidden);
    }
  });
});
