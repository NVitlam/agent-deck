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
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentDeckDataPath,
  AgentDeckHost,
  CLEAR_STATS_COMMAND,
  CLEAR_STATS_CONFIRM,
  CODEX_ABSENT_LOG,
  CONFIG_SECTION,
  CodexEnginePath,
  ABSENT_ROOT_REPROBE_MS,
  DEFAULT_CODEX_ENGINE_POLL_INTERVAL_MS,
  DEFAULT_LIVENESS_THRESHOLD_MS,
  DEFAULT_PORT,
  DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES,
  DEFAULT_PREVIEW_BYTES,
  CC_LATE_LOOKUP_INTERVAL_MS,
  CC_LATE_LOOKUP_RETRIES,
  CC_LATE_REPLAY_MAX,
  OPENCODE_ABSENT_LOG,
  OPEN_COMMAND,
  OpenCodeEnginePath,
  PanelController,
  SETTING_BOUNDS,
  SETTING_SHAPES,
  WEBVIEW_SCRIPT_SEGMENTS,
  WEBVIEW_STYLE_SEGMENTS,
  activate,
  codexRootExists,
  currentHost,
  deactivate,
  inactiveReasonFor,
  opencodeStoreExists,
  readSettings,
  OPEN_SETTINGS_COMMAND,
  OPEN_STATS_COMMAND,
  EVEN_EDITOR_WIDTHS,
  SETTINGS_FILTER,
  StatsPipeline,
  WORKBENCH_OPEN_SETTINGS,
  statsSettingDefaults,
  tweaksOf,
  workspacePathsOf,
} from './extension.js';
import type {
  AgentDeckSettings,
  NumericSettingKey,
  DataPathEmission,
  HostLogLevel,
  PanelSurface,
  Unsubscribe,
} from './extension.js';
import type { WebviewToHostMessage } from './model/events.js';
import type { SessionEmission } from './model/session.js';
import type { AgentDeckApi } from './api.js';
import { STATS_SCHEMA_VERSION } from './stats/schema.js';
import type { StatsRecord } from './stats/schema.js';
import { CORPUS_READ_BUDGET_MS, readCcSessions, warmCorpus } from './stats/corpus.testkit.js';
import { OPENCODE_DATA_ROOT_ENV, opencodeDataDir } from './opencode/index.js';
import { PINNED_CODEX_VERSION } from './codex/fingerprint.js';
import { STORE_DIR_NAME, StatsStore, resolveStoreDir } from './stats/store.js';
import { parsePricing } from './stats/pricing.js';
import { COUNTERS_INTERVAL_MS, formatCounters } from './bridge/diagnostics.js';
import type { DiagnosticsCounters } from './bridge/diagnostics.js';
import { HookListener } from './hooks/listener.js';
import { SharedHookListener } from './hooks/shared.js';
import type { DiagnosticsSink } from './bridge/diagnostics.js';
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
import { SIDEBAR_ROOT_ID, WEBVIEW_ROOT_ID } from './bridge/contract.js';
import { SIDEBAR_MENU, SIDEBAR_VIEW_ID } from './sidebar/menu.js';
import { TWEAK_SETTINGS } from './sidebar/tweaks.js';
import type { HostToWebviewMessage, SessionState, SettingsMessage, TreeNode } from './model/events.js';
import { isAgentNode } from './model/events.js';
import { ManualTime, slugifyWorkspace, snapshotTree } from './parser/tailer.js';
import type { DiscoveryFailure, DiscoveryFailureKind, TreeSnapshotEntry } from './parser/tailer.js';
import { correlateWorkspace } from './model/correlate.js';
import {
  ConfigurationTarget,
  Uri,
  ViewColumn,
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

/**
 * A WRITABLE copy of the captured projects root.
 *
 * DoD 4.11c makes a transcript's mtime count as activity only once the file
 * has GROWN, so a test that wants a record has to append bytes — and
 * appending to `fixtures/` would mutate a committed corpus (G1, G6). Every
 * write below lands in this copy.
 */
async function stageCapturedRoot(): Promise<{ root: string; slugDir: string }> {
  const root = join(await makeTempDir(), 'projects');
  await cp(CAPTURED_ROOT, root, { recursive: true });
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(entries.length, 'the staged root has no slug directory').toBeGreaterThan(0);
  return { root, slugDir: join(root, entries[0] as string) };
}

/**
 * TOUCH every session transcript in a staged slug dir: mtime moves, size does not.
 *
 * What a clone, a restore, a sync client, an indexer or a virus scanner does —
 * and what DoD 4.11c refuses to read as activity. The counterpart of
 * {@link growSessions}, and the two together are the item.
 */
async function touchSessions(slugDir: string, mtimeMs: number): Promise<number> {
  let touched = 0;
  const when = new Date(mtimeMs);
  const before: number[] = [];
  for (const sessionId of await sessionIdsIn(slugDir)) {
    const file = join(slugDir, `${sessionId}.jsonl`);
    before.push(statSync(file).size);
    await utimes(file, when, when);
    touched += 1;
  }
  expect(touched, 'no transcript was touched — the staged corpus is empty').toBeGreaterThan(0);
  // The control on the control: a "touch" that changed a size would make the
  // whole test vacuous in the direction that looks like a pass.
  const after = (await sessionIdsIn(slugDir)).map((id) => statSync(join(slugDir, `${id}.jsonl`)).size);
  expect(after, 'the touch changed a size').toStrictEqual(before);
  return touched;
}

/**
 * Append one real entry to every session transcript in a staged slug dir.
 *
 * **This is what a live session does, and under DoD 4.11c it is the only
 * thing that makes an mtime count.** A replayed corpus that nobody appends to
 * is history by definition — which is the whole point of the item — so the
 * harness below grows the sessions after the host has taken its baseline,
 * exactly as a session being worked on would.
 *
 * The appended line is the transcript's own LAST line with a fresh `uuid`, so
 * it parses like every other entry rather than counting as malformed.
 */
async function growSessions(slugDir: string): Promise<number> {
  let grown = 0;
  for (const sessionId of await sessionIdsIn(slugDir)) {
    const file = join(slugDir, `${sessionId}.jsonl`);
    const text = await readFile(file, 'utf8');
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    const last = lines.at(-1);
    if (last === undefined) continue;
    let line = last;
    try {
      const entry = JSON.parse(last) as Record<string, unknown>;
      if (typeof entry['uuid'] === 'string') {
        entry['uuid'] = `4111c000-0000-4000-8000-${String(grown).padStart(12, '0')}`;
        line = JSON.stringify(entry);
      }
    } catch {
      // Not JSON: append it back verbatim. The BYTES are the signal.
    }
    appendFileSync(file, `${line}\n`, 'utf8');
    grown += 1;
  }
  expect(grown, 'no transcript grew — the staged corpus is empty').toBeGreaterThan(0);
  return grown;
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
function extensionContext(globalStoragePath?: string): Parameters<typeof activate>[0] {
  // v0.7.0 Phase 3: a THIRD member is used, `globalStorageUri`, and the double
  // defaults it to a path nothing can create a directory under — see
  // `test/vscode-mock.ts`. A caller that wants a real store passes a real
  // directory, which is what makes "activate() is what supplies it" assertable
  // rather than a claim about a path nobody writes to.
  return (
    globalStoragePath === undefined
      ? createExtensionContext()
      : createExtensionContext('/ext', globalStoragePath)
  ) as unknown as Parameters<typeof activate>[0];
}

/**
 * A free loopback port, taken and released.
 *
 * THIS FUNCTION HAS AN UNCLOSEABLE TOCTOU WINDOW, which is why only
 * {@link onFreePort} calls it directly (the one commented exception went with
 * hotfix 0.8.1, when a refused correlation started binding). It binds
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

/**
 * The status `listener.ts` answers an accepted event with, at module scope.
 *
 * A second declaration of a number the G2 block below also names, and that is
 * the cheaper of two evils here: the alternative is hoisting a helper out of a
 * describe whose tests this phase does not otherwise touch. Both are pinned by
 * the same real socket, so they cannot drift apart silently — a wrong value
 * here fails immediately rather than passing for the wrong reason.
 */
const HOOK_OK = 200;

/** POST one hook payload to a bound listener. Resolves with the status. */
async function postHookEventTo(port: number, payload: unknown): Promise<number> {
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

/** A fixed stamp, so a counters line can be compared without a clock. */
const AT_ISO = '2026-09-06T12:00:00.000Z';

/**
 * Wait for a condition, or fail naming what was waited for.
 *
 * The relay is asynchronous by construction — a frame crosses a real socket —
 * so the alternative is a fixed sleep, and a fixed sleep is a test that passes
 * or fails by CPU load.
 */
async function waitFor(predicate: () => boolean, what: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
  globalStoragePath?: string,
): Promise<number> {
  return onFreePort<number>({
    use: async (port) => {
      resetVscodeMock();
      await configure(port);
      await activate(extensionContext(globalStoragePath));
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
    'codex.maxTranscriptBytes': DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES,
    // v0.7.0 Phase 3. The SHIPPED defaults, from the one declaration, so a
    // host built by this helper is the host a user gets: `readSettings(
    // undefined)` is asserted against the manifest elsewhere in this file, and
    // a helper that quietly differed would make every test here about a
    // configuration nobody runs.
    ...statsSettingDefaults(),
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
 * G6 again, one door over.
 *
 * **It points at a path that does NOT exist, and the difference started
 * mattering on 2026-09-04.** This used to be a fresh EMPTY directory, described
 * here as making the root "absent"; it did not. `locateCodex` reports
 * `rootExists` from `statSync(root).isDirectory()`, so an empty directory is a
 * root that exists and holds no sessions — indistinguishable from absent while
 * the only consumer was content, and a different answer entirely now that the
 * hook socket binds when a Codex root exists. A non-existent path is what the
 * comment always claimed, so tests that assert "nothing here" now assert it.
 */
const savedCodexHome = process.env[CODEX_HOME_VAR];

beforeEach(async () => {
  resetVscodeMock();
  process.env[OPENCODE_DATA_ROOT_ENV] = await makeTempDir();
  process.env[CODEX_HOME_VAR] = join(await makeTempDir(), 'no-codex-root-here');
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
      // 64 MiB. Hotfix 0.6.1's Codex transcript ceiling, written out rather
      // than computed so this test states the number a user would see.
      'codex.maxTranscriptBytes': 67108864,
      // v0.7.0 Phase 3, and written out for the same reason: these are the
      // numbers spec section F states and a user reads in the settings UI.
      // 3600000 is one hour; 90 days is the retention VERDICT.md 0.7
      // confirmed; the store is ON and no price table ships.
      'stats.enabled': true,
      'stats.retentionDays': 90,
      'stats.idleFlushMs': 3600000,
      pricing: {},
      // v0.7.0 Phase 4 (DoD 4.0): spec section G, default on.
      'canvas.autoFit': true,
      // v0.7.1 DoD 6.1: the telemetry route accepts nothing until a user
      // turns it on.
      'telemetry.enabled': false,
      // v0.8.0 DoD 7.6 — the four tweaks. Every default is the behaviour
      // 0.7.1 already shipped, so an installation that never opens the Tweaks
      // tab behaves as it did; `DoD 7.6 — the four tweaks, the host half`
      // below is where that decision is stated in full.
      followNewSessions: false,
      openDrawerOnEnter: false,
      drawerExpandedByDefault: false,
      defaultOrdering: 'live',
    });
  });

  it('honours configured values', () => {
    const read = readSettings({
      get: (key) =>
        ({
          port: 50000,
          livenessThresholdMs: 90000,
          previewBytes: 512,
          // The DOTTED key reaches `get` verbatim, which is the whole reason
          // `readSettings` needs no special case for it.
          'codex.maxTranscriptBytes': 8 * 1024 * 1024,
          // v0.7.0 Phase 3. All four, and each configured AWAY from its
          // default: a value equal to the default would pass whether or not
          // `readSettings` read the key at all.
          'stats.enabled': false,
          'stats.retentionDays': 30,
          'stats.idleFlushMs': 600_000,
          pricing: { 'a-model': { prompt: 1, cacheRead: 1, cacheWrite: 1, output: 1 } },
          'canvas.autoFit': false,
          'telemetry.enabled': true,
          // v0.8.0 DoD 7.6. All four, each configured AWAY from its default,
          // for the reason the comment above gives about the Phase 3 four.
          followNewSessions: true,
          openDrawerOnEnter: true,
          drawerExpandedByDefault: true,
          defaultOrdering: 'engine',
        })[key],
    });
    expect(read).toStrictEqual({
      port: 50000,
      livenessThresholdMs: 90000,
      previewBytes: 512,
      'codex.maxTranscriptBytes': 8 * 1024 * 1024,
      'stats.enabled': false,
      'stats.retentionDays': 30,
      'stats.idleFlushMs': 600_000,
      pricing: { 'a-model': { prompt: 1, cacheRead: 1, cacheWrite: 1, output: 1 } },
      'canvas.autoFit': false,
      'telemetry.enabled': true,
      followNewSessions: true,
      openDrawerOnEnter: true,
      drawerExpandedByDefault: true,
      defaultOrdering: 'engine',
    });
  });

  it('refuses a non-boolean telemetry.enabled, never coerces (DoD 6.1)', () => {
    // The string "true" is the value a user most plausibly types, and a
    // truthiness read would open a route they did not open.
    for (const bad of ['true', 'false', 1, 0, null, [], {}]) {
      const read = readSettings({ get: (key) => (key === 'telemetry.enabled' ? bad : undefined) });
      expect(read['telemetry.enabled'], `telemetry.enabled given ${JSON.stringify(bad)}`).toBe(false);
    }
    // Control: the real boolean IS honoured, so the loop is a refusal rather
    // than a setting nothing reads.
    expect(
      readSettings({ get: (k) => (k === 'telemetry.enabled' ? true : undefined) })['telemetry.enabled'],
    ).toBe(true);
  });

  it('refuses a non-boolean stats.enabled and a non-object pricing, never coerces', () => {
    // The two non-numeric settings have no `integerInRange` to fall back
    // through, so their refusal is written by hand and is worth pinning. A
    // truthiness read would turn the STRING "false" on, which is the shape a
    // user most plausibly types.
    for (const bad of ['false', 'true', 0, 1, null, [], {}]) {
      const read = readSettings({ get: (key) => (key === 'stats.enabled' ? bad : undefined) });
      expect(read['stats.enabled'], `stats.enabled given ${JSON.stringify(bad)}`).toBe(true);
    }
    for (const bad of ['{}', 3, null, [], true]) {
      const read = readSettings({ get: (key) => (key === 'pricing' ? bad : undefined) });
      expect(read.pricing, `pricing given ${JSON.stringify(bad)}`).toStrictEqual({});
    }
    // And the control: a real boolean and a real object ARE honoured, so the
    // loops above are a refusal rather than a setting nothing reads.
    expect(readSettings({ get: (k) => (k === 'stats.enabled' ? false : undefined) })['stats.enabled']).toBe(
      false,
    );
    expect(readSettings({ get: (k) => (k === 'pricing' ? { x: 1 } : undefined) }).pricing).toStrictEqual(
      { x: 1 },
    );
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
    scope?: unknown;
    /** v0.8.0 DoD 7.6 — the accepted set of a `string` setting. */
    enum?: unknown;
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
    // THE UNION OF BOTH TABLES (v0.7.0 Phase 3). `SETTING_BOUNDS` stopped
    // being the whole set the moment a boolean and an object arrived: a
    // comparison against the numeric table alone would report the two new
    // settings as manifest entries the code ignores, i.e. it would go red for
    // exactly the wrong reason and invite someone to delete them.
    const enforced = [...Object.keys(SETTING_BOUNDS), ...Object.keys(SETTING_SHAPES)]
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

  it('declares the type and default of every non-numeric setting', async () => {
    const properties = await manifestProperties();
    // The vacuity control: an empty `SETTING_SHAPES` would make the loop below
    // prove nothing, and this block is the only thing covering the two
    // settings that carry no minimum and no maximum.
    expect(Object.keys(SETTING_SHAPES).length).toBeGreaterThan(0);
    for (const [key, shape] of Object.entries(SETTING_SHAPES)) {
      const property = properties[`${CONFIG_SECTION}.${key}`];
      expect(property, `package.json declares no ${CONFIG_SECTION}.${key}`).toBeTypeOf('object');
      if (property === undefined) continue;
      expect(property.type, `${key}.type`).toBe(shape.type);
      expect(property.default, `${key}.default`).toStrictEqual(shape.defaultOf());
      // A non-numeric setting must NOT advertise numeric bounds: the settings
      // UI would show a range for a value that has none.
      expect(property.minimum, `${key}.minimum`).toBeUndefined();
      expect(property.maximum, `${key}.maximum`).toBeUndefined();
      // v0.7.1 DoD 6.1 — the SCOPE, both ways: a scope declared on one side
      // alone is the manifest/code disagreement this block exists for. An
      // unscoped shape must declare none, so a stray `scope` in the manifest
      // fails too.
      expect(property.scope, `${key}.scope`).toBe(shape.scope);
      /*
       * v0.8.0 DoD 7.6 — the ENUM, both ways, for the same reason and with
       * one extra: the manifest's list is what the settings UI offers, and
       * `readSettings` refuses anything outside `SettingShape.values`. A
       * manifest offering a fourth ordering the reader rejects would put a
       * value in the dropdown that silently reads back as the default.
       */
      if (shape.values === undefined) {
        expect(property.enum, `${key}.enum`).toBeUndefined();
      } else {
        expect(property.enum, `${key}.enum`).toStrictEqual([...shape.values]);
        expect(shape.values.length, `${key}.values is empty`).toBeGreaterThan(0);
        // ...and the declared default is one of them. A default outside the
        // enum is a setting whose shipped value the UI will not offer.
        expect(shape.values, `${key}.default`).toContain(shape.defaultOf() as string);
      }
    }
  });

  it('declares agentDeck.telemetry.enabled default false, scope machine (DoD 6.1)', async () => {
    const properties = await manifestProperties();
    const property = properties[`${CONFIG_SECTION}.telemetry.enabled`];
    expect(property, 'package.json declares no agentDeck.telemetry.enabled').toBeTypeOf('object');
    expect(property?.type).toBe('boolean');
    expect(property?.default).toBe(false);
    expect(property?.scope).toBe('machine');
    // The value an unconfigured extension actually runs with, not only the
    // declaration: off.
    expect(readSettings(undefined)['telemetry.enabled']).toBe(false);
    // VACUITY CONTROL for the per-shape scope loop above: at least one shape
    // carries a scope and at least one does not, so `toBe(shape.scope)` was
    // exercised on both arms rather than compared undefined to undefined.
    const scopes = Object.values(SETTING_SHAPES).map((shape) => shape.scope);
    expect(scopes).toContain('machine');
    // v0.8.0: the four tweaks declare `window` explicitly (DoD 7.6's "scopes").
    expect(scopes.filter((scope) => scope === 'window')).toHaveLength(4);
    expect(scopes).toContain(undefined);
  });

  it('the default object is a fresh object per read, never a shared one', () => {
    // `pricing` defaults to `{}`, and a single frozen-by-convention object
    // handed to every caller is one mutation away from every window in the
    // process agreeing on a price table nobody set. Identity, not equality.
    const first = readSettings(undefined).pricing;
    const second = readSettings(undefined).pricing;
    expect(first).toStrictEqual({});
    expect(second).not.toBe(first);
  });

  it('the manifest default is the value an unconfigured extension actually uses', async () => {
    const properties = await manifestProperties();
    const fromManifest = Object.fromEntries(
      [...Object.keys(SETTING_BOUNDS), ...Object.keys(SETTING_SHAPES)].map((key) => [
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
        readSettings({ get: (k) => (k === key ? value : undefined) })[key as NumericSettingKey];
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
    options: {
      degraded?: boolean;
      codexDegraded?: boolean;
      added?: string[];
      activityAt?: number;
    } = {},
  ): DataPathEmission {
    return {
      emission: {
        sessions,
        diffs: [],
        addedSessionIds: options.added ?? [],
        removedSessionIds: [],
        schemaMismatchSessionIds: [],
        // DoD 4.11b: liveness says every one of these is active NOW, so the
        // panel tests below drive the ordinary case. `activityAt` lets a test
        // say otherwise; the store tests further down do.
        lastActivityAt: new Map(
          sessions.map((s) => [s.sessionId, options.activityAt ?? Date.now()] as const),
        ),
      },
      degraded:
        options.degraded === true
          ? { degraded: true, reason: 'noHookEvents' }
          : { degraded: false },
      // DoD 5.0b. Defaults to healthy and is set INDEPENDENTLY of `degraded`,
      // which is what lets a test drive one tap silent while the other is
      // fine - the shape the item requires to be tested in both directions.
      codexDegraded:
        options.codexDegraded === true
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
    // TWO degraded lines, not one, since DoD 5.0b: a publish announces every
    // hook tap's health and there are two taps. The ORDER is part of the
    // contract - the snapshot first, then the taps - because a webview that
    // heard about a degraded tap before it had any sessions would have
    // nothing to attach it to.
    expect(panel.posted.map((m) => m.type)).toStrictEqual([
      'snapshot',
      'degraded',
      'degraded',
    ]);
    expect(
      panel.posted.filter((m) => m.type === 'degraded').map((m) => m.engine),
      'one line per tap, each naming itself',
    ).toStrictEqual(['cc', 'codex']);

    // Publishing again with nothing changed sends nothing: no snapshot, and no
    // repeated degraded message from EITHER tap.
    controller.publish(emission([state('s1')]));
    expect(panel.posted).toHaveLength(3);

    panel.fireBecameVisible();
    expect(controller.counters.reloads).toBe(1);
    expect(snapshotsRequested).toBe(1);

    controller.publish(emission([state('s1')]));
    // After a reload the bridge has forgotten BOTH taps, so both are
    // re-announced beside the fresh snapshot. `reset()` clears the whole
    // per-tap map for this reason: a webview that was never told is not the
    // same as a tap that has not moved.
    expect(panel.posted.map((m) => m.type)).toStrictEqual([
      'snapshot',
      'degraded',
      'degraded',
      'snapshot',
      'degraded',
      'degraded',
    ]);
    controller.dispose();
  });

  it('degraded is announced once per transition, never per publish', () => {
    const panel = fakePanel();
    const controller = new PanelController({ panel: panel.surface, nonce: 'AAAAAAAA' });
    for (let i = 0; i < 12; i += 1) controller.publish(emission([state('s1')], { degraded: true }));
    const degraded = panel.posted.filter((m) => m.type === 'degraded');
    // Twelve publishes, TWO lines: one per tap, each sent once. The point of
    // the test is unchanged - no nagging - and it is now also a check that
    // the two taps do not share a de-duplication memory, which would have
    // shown up here as a single line.
    expect(degraded).toStrictEqual([
      { type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' },
      { type: 'degraded', engine: 'codex', degraded: false },
    ]);
    // The Claude Code tap recovers. That is ONE new line - the Codex tap has
    // not moved, so it must not be re-announced alongside it, which is the
    // per-tap no-nagging rule seen from the other side.
    controller.publish(emission([state('s1')], { degraded: false }));
    const after = panel.posted.filter((m) => m.type === 'degraded');
    expect(after).toHaveLength(3);
    expect(after.at(-1)).toStrictEqual({ type: 'degraded', engine: 'cc', degraded: false });
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
     * The `schemaOk` half is NOT asserted in this loop at all — it is asserted
     * on the model and on a freshly-opened panel instead, for a measured
     * reason this test used to depend on by accident. A session is
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
     * `schemaOk === false` IS STILL ASSERTED TWICE, and neither depends on
     * ordering: on the model's own state above, and — the one that is the
     * actual user guarantee — on a panel opened AFTER the refusal, at the end
     * of this test, which is where a real webview's refusal screen comes from.
     * (The `schemaMismatch` message asserted above is NOT a third: it is
     * `{ type, sessionId }` and carries no `schemaOk` to check.)
     *
     * WHAT THIS ACCEPTS WITHOUT CHANGING IT, stated so it is not mistaken for
     * something nobody noticed: a session really can be published with
     * `schemaOk: true` and an empty root between registration and its first
     * graft. Whether an ungrafted session should claim `schemaOk: true` at all
     * is a product question (reserved 9 — a product-visible default), and it
     * is carried into the handoff rather than decided here.
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
      // DoD 5.0b. This test is about a Claude Code refusal snapshot, so the
      // Codex tap has nothing to say and says so.
      codexDegraded: { degraded: false },
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
    // Twenty pumps, two lines: one per tap, each announced once. The Codex
    // half is `false` because this workspace has no Codex root - an engine
    // that is not running is not degraded, it is silent, and saying otherwise
    // would be the D2 mistake pointed at the other engine.
    expect(degraded).toStrictEqual([
      { type: 'degraded', engine: 'cc', degraded: true, reason: 'noHookEvents' },
      { type: 'degraded', engine: 'codex', degraded: false },
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

  it('a NON-matching workspace starts no Claude Code half, and still binds for its first hook event', async () => {
    /*
     * Until hotfix 0.8.1 this test was "starts nothing: no watcher, no socket,
     * no timer" — `activate()` returned before building a host. That was every
     * new Claude Code user's first session, and the user ruled (2026-09-15)
     * that a window with a folder open always builds a host and binds, so
     * Claude Code's first hook event has somewhere to land. What the
     * correlation gate still owns is the CC HALF: no watcher, no CC timer,
     * the model not on the tap.
     */
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    const foreign = join(await makeTempDir(), 'not-a-cc-project');
    await activateOnFreePort((port) => {
      mock.setWorkspaceFolder(foreign);
      mock.setConfig(CONFIG_SECTION, { port });
    });

    const host = currentHost();
    expect(host).not.toBeNull();
    const d = host?.dataPath.diagnostics;
    expect(d?.ccEnabled).toBe(false);
    expect(d?.hookBindAttempted).toBe(true);
    expect(d?.listening).toBe(true);
    // The CC half allocated nothing: the watcher never started, and with
    // `tickMs` at its default the only timer a CC half arms is the tick —
    // asserted, not only said (verifier round, hotfix 0.8.1: arming the tick
    // before Claude Code is seen left every test green). `start()` ends in a
    // pump, which cancels the emit timer, and no chain ran, so a CC tick is
    // the only thing that could make this non-zero.
    expect(host?.dataPath.watcher.diagnostics.started).toBe(false);
    expect(d?.timersArmed).toBe(0);
    expect(d?.ccLateLookups).toBe(0);
    expect(mock.errorMessages).toStrictEqual([]);

    // The command opens the panel rather than explaining an absence.
    expect(mock.hasCommand(OPEN_COMMAND)).toBe(true);
    await mock.runCommand(OPEN_COMMAND);
    expect(mock.panels).toHaveLength(1);
    expect(mock.informationMessages).toHaveLength(0);
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

  it('a window that binds the port reports itself as the leader', async () => {
    // The control for the collision test below. Without it, `role=refused`
    // could be the only value this suite ever observes, and a getter wired to
    // a constant would satisfy every assertion about it.
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    mock.setWorkspaceFolder(await capturedWorkspacePath());
    await onFreePort({
      use: async (port) => {
        mock.setConfig(CONFIG_SECTION, { port });
        await activate(extensionContext());
        return currentHost();
      },
      collided: (host) => host?.dataPath.diagnostics.bindError?.code === 'EADDRINUSE',
      discard: async () => {
        await deactivate();
      },
    });
    const host = currentHost();
    expect(host?.dataPath.diagnostics.listening).toBe(true);
    expect(host?.dataPath.relayRole).toBe('leader');
    expect(mock.errorMessages).toHaveLength(0);
    const line = host === null ? '' : formatCounters(host.counters(), '2026-09-06T00:00:00.000Z');
    expect(line).toContain('role=leader');
  });

  /*
   * ---------------------------------------------------------------------
   * v0.7.0 Phase 1b — THE TWO WIRINGS, DRIVEN THE WAY PRODUCTION DRIVES THEM
   * ---------------------------------------------------------------------
   *
   * A `phase-verifier` round on 2026-09-06 found both of these unguarded, and
   * it is this repository's most-recorded shape arriving for the third time.
   * `src/extension.ts` is the ONLY production caller of `SharedHookListener`.
   * Deleting the two lines that pass `workspacePaths` and `tailsSession` left
   * 118 tests green across every file that touches the host — while the
   * constructor's defaults (`[]` and `() => false`) make the ownership filter
   * reject EVERY relayed frame, so a follower window would drop 100 % of its
   * events and show exactly the dead deck this phase exists to fix. Replacing
   * the three relay counters with literal `0` was green too, because the only
   * host-level observation of them was a case where all three are legitimately
   * zero.
   *
   * Every ownership and counter test before these two constructed its input by
   * hand. That measures the component. These measure the product: production
   * builds the context, production binds or attaches, and a real payload
   * crosses a real socket.
   */

  /** A REAL Agent Deck leader holding a port, so `activate()` meets one of us. */
  async function leaderOnFreePort(): Promise<{ leader: HookListener; port: number }> {
    return onFreePort({
      use: async (port) => {
        const leader = new HookListener({ port });
        await leader.start();
        return { leader, port };
      },
    });
  }

  it('Phase 1b: a window whose port is held by another Agent Deck becomes a follower and is fed', async () => {
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    const workspacePath = await capturedWorkspacePath();
    const { leader, port } = await leaderOnFreePort();
    try {
      mock.setWorkspaceFolder(workspacePath);
      mock.setConfig(CONFIG_SECTION, { port });
      await activate(extensionContext());

      const host = currentHost();
      expect(host).not.toBeNull();
      const path = host?.dataPath;

      // It attached rather than failing, and it said so ONCE and quietly.
      expect(path?.relayRole).toBe('follower');
      expect(mock.errorMessages).toHaveLength(0);
      expect(path?.diagnostics.bindError).toBeUndefined();
      // It holds no socket and is nonetheless NOT down — the getter split that
      // keeps a fed follower from announcing its own hooks silent.
      expect(path?.listener.bound).toBe(false);
      expect(path?.diagnostics.listening).toBe(true);

      // ---- arm one: owned by `cwd`, which is `workspacePaths` -------------
      const bySession = 'phase-1b-unknown-session';
      expect(path?.model.hasSession(bySession)).toBe(false);
      expect(
        await postHookEventTo(port, {
          session_id: bySession,
          hook_event_name: 'PreToolUse',
          tool_use_id: 'toolu_1b_cwd',
          tool_name: 'Bash',
          cwd: workspacePath,
        }),
      ).toBe(HOOK_OK);

      // ---- arm two: owned by `tailsSession`, with a FOREIGN cwd ------------
      // The arm that covers a subagent, whose `cwd` is its own worktree. It
      // can only pass if production really handed the listener a live view of
      // this window's model.
      const tailed = path?.model.sessionIds()[0];
      expect(tailed, 'the captured corpus registered no session').toBeDefined();
      expect(
        await postHookEventTo(port, {
          session_id: tailed,
          hook_event_name: 'PostToolUse',
          tool_use_id: 'toolu_1b_tailed',
          tool_name: 'Bash',
          cwd: 'D:\\somewhere\\else\\entirely',
        }),
      ).toBe(HOOK_OK);

      // ---- and one that belongs to nobody here ----------------------------
      expect(
        await postHookEventTo(port, {
          session_id: 'phase-1b-other-window',
          hook_event_name: 'PreToolUse',
          tool_use_id: 'toolu_1b_foreign',
          tool_name: 'Bash',
          cwd: 'D:\\another\\workspace',
        }),
      ).toBe(HOOK_OK);

      await waitFor(
        () => (path?.relayCounters.received ?? 0) >= 3,
        'the three relayed frames to reach the follower',
      );

      // POSITIVE, PER-SUBJECT. A "dropped" counter at 0 is 0 on an empty map,
      // and this repository has already shipped a test that rested on one.
      expect(path?.model.livenessSnapshot(bySession)?.hookEventCount).toBe(1);
      expect(path?.model.livenessSnapshot(tailed ?? '')?.hookEventCount).toBeGreaterThan(0);
      // The third was received and thrown away — a different claim from
      // "never arrived", and the one that proves the FILTER ran.
      expect(path?.model.livenessSnapshot('phase-1b-other-window')).toBeUndefined();
      expect(path?.relayCounters.droppedForeign).toBe(1);

      // DoD 1b.7: the counters line, with numbers that are not all zero.
      const line = formatCounters(host?.counters() as DiagnosticsCounters, AT_ISO);
      expect(line).toContain('role=follower');
      expect(line).toContain('followers=0');
      expect(line).toContain('received=3');
    } finally {
      await deactivate();
      await leader.stop();
    }
  });

  it('Phase 1b: a leader window counts the windows attached to it, and the frames it sends', async () => {
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    const workspacePath = await capturedWorkspacePath();
    mock.setWorkspaceFolder(workspacePath);
    const port = await onFreePort({
      use: async (p) => {
        mock.setConfig(CONFIG_SECTION, { port: p });
        await activate(extensionContext());
        return p;
      },
      collided: () => currentHost()?.dataPath.diagnostics.bindError?.code === 'EADDRINUSE',
      discard: async () => {
        await deactivate();
      },
    });

    const follower = new SharedHookListener({ port, tailsSession: () => true });
    try {
      const host = currentHost();
      expect(host?.dataPath.relayRole).toBe('leader');
      await follower.start();
      expect(follower.role).toBe('follower');

      await waitFor(
        () => (host?.dataPath.relayCounters.followers ?? 0) === 1,
        'the host to register the attached window',
      );
      expect(
        await postHookEventTo(port, {
          session_id: 'phase-1b-leader-side',
          hook_event_name: 'PreToolUse',
          tool_use_id: 'toolu_1b_leader',
          tool_name: 'Bash',
          cwd: workspacePath,
        }),
      ).toBe(HOOK_OK);
      await waitFor(
        () => follower.relayCounters.received >= 1,
        'the frame to reach the attached window',
      );

      // The two numbers that were wired to nothing observable until now.
      const line = formatCounters(host?.counters() as DiagnosticsCounters, AT_ISO);
      expect(line).toContain('role=leader');
      expect(line).toContain('followers=1');
      expect(line).toMatch(/relayed=[1-9]/);
      expect(line).toContain('received=0');
    } finally {
      await follower.stop();
      await deactivate();
    }
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

      /*
       * v0.7.0 DoD 1b.7 — AND IT MUST NAME THE RIGHT CAUSE.
       *
       * `heldPort()` holds this port with a bare `createServer()`, which is a
       * FOREIGN holder, and since Phase 1b that is the only thing that reaches
       * this message at all: a second Agent Deck window probes, recognises the
       * leader and attaches without a word. A message that still said "the
       * port is unavailable" full stop would send a user hunting through their
       * other VS Code windows for a problem that is not there.
       */
      expect(mock.errorMessages[0]).toContain('another program');
      expect(mock.errorMessages[0]).toContain('not by another Agent Deck window');

      const host = currentHost();
      expect(host?.dataPath.diagnostics.listening).toBe(false);
      expect(host?.dataPath.diagnostics.grafts).toBeGreaterThan(0);

      // The role is recorded, and it is 'refused' rather than 'idle': a window
      // that asked and was turned away is a different state from one that
      // never had a reason to bind, and the counters line is where a user
      // reads the difference.
      expect(host?.dataPath.relayRole).toBe('refused');
      const line = host === null ? '' : formatCounters(host.counters(), '2026-09-06T00:00:00.000Z');
      expect(line).toContain('role=refused');
      expect(line).toContain('followers=0');
      expect(line).toContain('relayed=0');
      expect(line).toContain('received=0');
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

    /*
     * Since hotfix 0.8.1 the sentence is no longer the answer to
     * `agentDeck.open`: a window with a folder open always has a host (user
     * ruling 2026-09-15), so the command opens the panel. The sentence is
     * logged once at info when the data path starts with Claude Code not yet
     * seen, through `DataPathOptions.ccCorrelationFailure` — the production
     * logger is `console.info`, so that is what is observed. These are the
     * ABSENCE kinds; `ambiguousSlug` goes to the output channel instead (user
     * ruling 2026-09-15), proved in the hotfix 0.8.1 block, because NTFS cannot
     * hold the two directories that produce it through `activate()`.
     */
    for (const leg of legs) {
      process.env['CLAUDE_PROJECTS_ROOT'] = leg.root;

      const correlation = await correlateWorkspace(leg.workspace);
      expect(correlation.ok, `${leg.name}: expected a refusal`).toBe(false);
      if (correlation.ok) throw new Error('unreachable');
      expect(correlation.failure.kind).toBe(leg.expectKind);

      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        await activateOnFreePort((port) => {
          info.mockClear();
          mock.setWorkspaceFolder(leg.workspace);
          mock.setConfig(CONFIG_SECTION, { port });
        });
        expect(currentHost(), `${leg.name}: a folder is open, so a host`).not.toBeNull();
        const logged = info.mock.calls.map((call) => String(call[0]));
        const expected = inactiveReasonFor(correlation.failure);
        expect(logged.filter((line) => line === expected), `${leg.name}: logged once`).toHaveLength(1);
        expect(claimsAbsence(expected)).toBe(true);
      } finally {
        info.mockRestore();
      }
      await mock.runCommand(OPEN_COMMAND);
      expect(mock.informationMessages).toHaveLength(0);
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
      // `storageUri` is WORKSPACE-scoped storage and stays forbidden. Note it
      // is not a substring of `globalStorageUri`, which carries a capital S —
      // so removing that token below does not quietly remove this one.
      'storageUri',
    ];
    for (const needle of forbidden) {
      expect(source, `forbidden token in src/extension.ts: ${needle}`).not.toContain(
        needle,
      );
    }
  });

  /*
   * `globalStorageUri` LEFT THE LIST ABOVE IN v0.7.0 PHASE 3, AND THIS IS THE
   * COMPENSATING ASSERTION.
   *
   * The list was written when G7 read "no `workspaceState`, no `globalState`,
   * no cache file. Everything dies with the window." G7 is amended (spec
   * section C; PLAN.md's Grounding Contract) and now permits exactly one
   * writable location: an append-only, retention-bounded, user-clearable,
   * setting-disableable history of derived records under
   * `context.globalStorageUri`. A token ban that forbids the one thing the
   * contract now allows is a guard that has stopped describing the product,
   * and this file's sibling test records what to do about that — narrow it to
   * the property, and say so in a paragraph.
   *
   * The property is unchanged and is stronger than the token ever was: **the
   * host entry point still writes nothing itself.** Every write API stays on
   * the list above and every one of them is still absent — `mkdir`,
   * `appendFileSync`, `writeFile` and the rest measure ZERO in this file. The
   * only module in the repository that writes is `src/stats/store.ts`, and
   * `src/stats/readback.test.ts` pins who may reach it.
   *
   * What replaces the ban is a PINNED COUNT of the two CODE forms, so a new
   * reader has to come here and justify itself rather than being waved through
   * by a check that stopped applying. `workspaceState` and `globalState` remain
   * banned outright, because the amendment permits a DIRECTORY and says nothing
   * about VS Code's key-value stores.
   *
   * **THE COUNT IS OVER `context.globalStorageUri` AND `globalStorageUri: {`,
   * NOT OVER THE BARE TOKEN, and `phase-verifier` is why.** The first version
   * pinned the bare token at 3 and its own paragraph said the three were "the
   * guarded resolution and its type annotation". Re-derived, the three were the
   * property read, the object-literal key, and **the word inside the
   * `console.info` message** — no type annotation among them. That guard was
   * wrong in both directions: rewording a log line would break it for no
   * reason, and a fourth genuine reader could be added while deleting the
   * string and the total would still read 3. Counting the two syntactic forms
   * a READ can take is immune to both.
   */
  it('reads globalStorageUri in exactly the places the G7 amendment allows', async () => {
    const source = stripComments(await readFile(EXTENSION_SOURCE, 'utf8'));
    expect(source).toContain('createJsonlInferenceSource'); // the strip left code alone

    // One read off the context, in `statsDirFor`; one re-assembly into the
    // shape `resolveStoreDir` takes. Any third is a new reader.
    expect(
      source.split('context.globalStorageUri').length - 1,
      'a new read of context.globalStorageUri: state why in the block above',
    ).toBe(1);
    expect(
      source.split('globalStorageUri: {').length - 1,
      'a new globalStorageUri literal: state why in the block above',
    ).toBe(1);
    // The control: the matcher can see the token at all, so the two counts
    // above are a measurement rather than a pattern that matches nothing.
    expect(source.split('globalStorageUri').length - 1).toBeGreaterThanOrEqual(2);

    // AND THE HOST STILL WRITES NOTHING ITSELF. Restated here rather than left
    // to the list above, because this is now the load-bearing half: the
    // amendment permits a directory, not a write from this file.
    for (const api of [
      'mkdir',
      'writeFile',
      'writeFileSync',
      'appendFile',
      'appendFileSync',
      'createWriteStream',
      'unlink',
      'rmSync',
      // `rm(` IS NOT ON THIS LIST, and the omission is deliberate rather than
      // a gap. As a substring it matches `#arm(` — the pipeline's idle-timer
      // method — so it reported a write API that is not there, which is the
      // false-positive half of the same defect class a missing needle is.
      // `node:fs/promises`'s `rm` is covered where it can be covered
      // precisely: the sibling test pins this file's ENTIRE `node:fs` binding
      // set to `['existsSync', 'statSync']` and its module list forbids
      // `fs/promises` outright, so there is no import `rm` could arrive on.
    ]) {
      expect(source, `src/extension.ts names a write API: ${api}`).not.toContain(api);
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
     * by the thing itself: exactly one `node:fs` import, naming an EXACT SET of
     * bindings, every one of which is a read. The write-API name ban in the
     * sibling test above is unchanged and still lists every write call by name.
     *
     * **`statSync` joined it on 2026-09-04, and the guard is what forced the
     * decision to be a decision.** `codexRootExists` first used `existsSync`,
     * which answers `true` for a regular FILE at the Codex root path — while
     * `locateCodex` decides `rootExists` with `statSync(root).isDirectory()`.
     * Two probes, one question, disagreeing silently. Aligning them means the
     * host needs the same syscall the engine uses. Both are reads and neither
     * can create, truncate or modify anything.
     *
     * The set stays EXACT rather than becoming a deny-list: this file's own
     * history is a blanket ban that had to be replaced when it stopped being
     * true, and a containment here would let a future `openSync` through
     * silently. Widening it is meant to cost a paragraph.
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
    expect(
      bound,
      'every node:fs binding in the host must be a read, and the set is exact',
    ).toStrictEqual(['existsSync', 'statSync']);
    // The count beside the set (rule 19): a set comparison written against an
    // accidentally-empty match list passes vacuously, and this goes red first.
    expect(bound).toHaveLength(2);

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

    // SCOPED TO REFUSALS (v0.7.0 Phase 1b). The shared listener writes one
    // `listenerRole` line to this same sink when the window binds, which is
    // correct — a role change is a diagnostic — and it means an exact count
    // over EVERY event is no longer a statement about refusals. The equality
    // that matters is kept, against the population it was always about.
    const refusals = events.filter((e) => e.kind === 'graftRefused');
    expect(refusals).toHaveLength(path.diagnostics.graftRefusals);
    expect(refusals.length).toBeGreaterThan(0);
    // ...and the role line is asserted rather than tolerated, so this test
    // still fails if the sink starts carrying something nobody expected.
    expect(events.filter((e) => e.kind === 'listenerRole')).toHaveLength(1);
    expect(events).toHaveLength(refusals.length + 1);
    const [event] = refusals as [DiagnosticsEvent];
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
    // A budget, not vitest's 5 s default: this copies a captured corpus AND
    // activates a host. Measured 2026-09-11: 352 ms alone, and a failure at
    // 5,356 ms — past the 5 s default — in a cold fresh clone's full run
    // (v0.7.1 gate at 7caf42f).
    // The recorded class: a test that passes or fails by CPU load.
  }, 60_000);

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

    await activateOnFreePort((port) => {
      mock.setWorkspaceFolder(lonely);
      mock.setConfig(CONFIG_SECTION, { port });
    });

    const host = currentHost();
    expect(host, 'an OpenCode-only workspace still gets a deck').not.toBeNull();
    const diagnostics = host?.dataPath.diagnostics;
    // The correlation gate's point survives: no CC watcher, no CC tick.
    expect(diagnostics?.ccEnabled).toBe(false);
    expect(host?.dataPath.watcher.diagnostics.started).toBe(false);
    // Hotfix 0.8.1 (user ruling 2026-09-15): the socket binds anyway — this
    // was `false` — so Claude Code's first hook event in this workspace can
    // switch its half on.
    expect(diagnostics?.listening).toBe(true);
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

/**
 * A completion signal for one Codex CONTENT read, built out of `onChange`.
 *
 * `CodexEnginePath` fires a poll as `void this.#refresh()` and calls
 * `onChange()` once that read has been applied, so `onChange` IS the "this
 * read finished" event. Awaiting a fixed number of microtask turns instead
 * would be a test that passes or fails by how long a 16 MiB read took, which
 * this repository has paid for more than once.
 *
 * ---------------------------------------------------------------------------
 * THE WAITER IS REGISTERED AFTER `fire()` RETURNS, AND THAT IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 * `#enable` registers the LIVENESS poll before the content poll, and the
 * liveness engine's `onUpdate` calls `onChange()` SYNCHRONOUSLY. So a waiter
 * armed before `fire()` is resolved by the liveness callback inside `fire()`,
 * while the content read is still in flight — and a loop built on it fires
 * again, which runs two `readCodexEngine` passes concurrently over ONE
 * `CodexTailStore`. Measured: a 20 MiB transcript that reaches its tail in 5
 * passes never completed in 20.
 *
 * `#refresh` is `async` and awaits an `async` read, so its `onChange` cannot
 * run before `fire()` returns. Arming afterwards therefore waits for the
 * content read and for nothing else.
 */
function codexPump(): { onChange: () => void; next: () => Promise<void> } {
  let waiting: (() => void) | undefined;
  return {
    onChange: () => {
      const resolve = waiting;
      waiting = undefined;
      resolve?.();
    },
    next: () =>
      new Promise<void>((done) => {
        waiting = done;
      }),
  };
}

/** One poll, awaited to the end of the content read it started. */
async function pumpCodexOnce(
  poll: { fire: () => void },
  pump: { next: () => Promise<void> },
): Promise<void> {
  poll.fire();
  await pump.next();
}

/**
 * Fire polls until `done()` holds, or give up after `limit` of them.
 *
 * BOUNDED, so a property that never becomes true fails the caller's own
 * assertion rather than hanging the suite — and the caller asserts afterwards,
 * so this is a wait for a real signal and not an assertion in a loop.
 */
async function pumpCodexUntil(
  poll: { fire: () => void },
  pump: { next: () => Promise<void> },
  done: () => boolean,
  limit = 20,
): Promise<void> {
  for (let i = 0; i < limit && !done(); i += 1) await pumpCodexOnce(poll, pump);
}

/**
 * Plant a SPARSE oversize Codex transcript in a staged root (v0.8.0 DoD 7.7).
 *
 * `truncate` extends a file without writing it, so a 20 MiB transcript costs
 * kilobytes on disk and the test is not a measurement of this machine's disk.
 * Its shape is the shape the oversize tail is for: a `session_meta` at ordinal
 * 0 for the fingerprint and the workspace match, a hole nobody reads, and real
 * records at the end — placed so that the 16 MiB landing point falls INSIDE
 * the first of them, which is the fragment case.
 *
 * `cwd` is the corpus's own workspace so the planted session lands on the same
 * deck as the fixture's, which is what lets a test assert that one session
 * carries the mark and the others do not.
 */
async function plantOversizeCodexTranscript(
  root: string,
  cwd: string,
  size: number,
): Promise<{ path: string; file: string; threadId: string; size: number }> {
  const threadId = '01a06400-0000-7000-8000-00000000f00d';
  const file = `rollout-2026-09-13T00-00-00-${threadId}.jsonl`;
  const dayDir = join(root, 'sessions', '2026', '09', '13');
  await mkdir(dayDir, { recursive: true });
  const target = join(dayDir, file);

  const meta = `${JSON.stringify({
    timestamp: '2026-09-13T00:00:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: threadId,
      id: threadId,
      timestamp: '2026-09-13T00:00:00.000Z',
      cwd,
      originator: 'codex_exec',
      cli_version: PINNED_CODEX_VERSION,
      source: 'exec',
      thread_source: 'user',
      model_provider: 'openai',
    },
  })}\n`;

  const padding = 'y'.repeat(64 * 1024);
  const tailLines: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    tailLines.push(
      `${JSON.stringify({
        timestamp: '2026-09-13T00:00:01.000Z',
        ordinal: 500 + i,
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: `fc_${String(500 + i)}`,
          call_id: `call_${String(500 + i)}`,
          name: 'shell',
          arguments: JSON.stringify({ command: padding }),
        },
      })}\n`,
    );
  }
  const firstLineBytes = Buffer.byteLength(tailLines[0] as string, 'utf8');
  const recordsStart = size - 16 * 1024 * 1024 - Math.floor(firstLineBytes / 2);

  const handle = await open(target, 'w');
  try {
    await handle.write(meta);
    await handle.truncate(recordsStart);
    await handle.write(tailLines.join(''), recordsStart);
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
  return { path: target, file, threadId, size };
}

/*
 * ===========================================================================
 * HOTFIX 0.6.1 — THE HOST WIRING, DRIVEN THE WAY PRODUCTION DRIVES IT
 * ===========================================================================
 *
 * A `phase-verifier` deleted BOTH `tails: this.#tails` and
 * `maxTranscriptBytes: this.#maxTranscriptBytes` from the single production
 * `readCodexEngine(...)` call site in `src/extension.ts` and re-ran the suite:
 * `extension.test.ts` **90/90 green**, `isolation.test.ts` and
 * `codex/liveness.test.ts` **60/60 green**. The entire user-facing half of the
 * hotfix was deletable without a red test, because every H.2-H.5 case
 * constructs `new CodexTailStore()` BY HAND.
 *
 * That is the D4 class, which `CLAUDE.md` records twice and which the same
 * repository then shipped a third time — a value with exactly one production
 * assignment site has that site untested until something drives it end to end.
 *
 * These two tests drive `CodexEnginePath` itself. Nothing is passed by hand
 * that production does not pass.
 */
describe('hotfix 0.6.1 — CodexEnginePath owns the store and the limit', () => {
  it('holds tails across polls, so the fix is reachable from production', async () => {
    const root = await stageCodexRoot(false);
    const { cwd } = await codexBaselineRoot(root);
    const poll = manualPollTrigger();

    const path = new CodexEnginePath({
      workspaceFolders: [cwd],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: () => {},
      root,
      log: captureLog().log,
      pollTrigger: poll.trigger,
    });
    await path.start();

    /*
     * A store that survives a pass is the whole hotfix, and `tailsHeld` is
     * the only place it is observable from outside. Deleting `tails:` from
     * the call site in `src/extension.ts` makes this ZERO — verified by
     * mutation, which is the only way this assertion earns its place.
     */
    expect(path.diagnostics.tailsHeld).toBeGreaterThan(0);
    const afterStart = path.diagnostics.tailsHeld;

    poll.fire();
    await Promise.resolve();
    // Still the SAME store, not a fresh one per pass.
    expect(path.diagnostics.tailsHeld).toBe(afterStart);
    path.dispose();
  }, 120_000);

  it('a limit below every transcript still reads them: over the limit is a SHAPE (DoD 7.7)', async () => {
    const root = await stageCodexRoot(false);
    const { cwd } = await codexBaselineRoot(root);
    const poll = manualPollTrigger();
    const events: DiagnosticsEvent[] = [];

    /*
     * A limit BELOW every transcript in the corpus, so what happens is a fact
     * about the setting rather than about a file this test had to plant. The
     * fixture's smallest rollout is ~50 KB.
     *
     * Until v0.8.0 DoD 7.7 this produced `skippedTranscripts > 0` and
     * `sessions === 0`: every transcript was measured and none was opened.
     * Now each is read as a head plus its last 16 MiB — and each is far
     * smaller than that, so the two reads cover the same bytes, nothing is
     * skipped, nothing is partial, and the deck is populated.
     */
    const path = new CodexEnginePath({
      workspaceFolders: [cwd],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: () => {},
      root,
      log: captureLog().log,
      pollTrigger: poll.trigger,
      maxTranscriptBytes: 1024,
      onDiagnostic: (event) => events.push(event),
    });
    await path.start();

    expect(path.diagnostics.skippedTranscripts).toBe(0);
    expect(path.diagnostics.partialTranscripts).toBe(0);
    // THE VACUITY CONTROL for the two zeroes above: sessions really were
    // produced, so "nothing skipped" is a statement about a deck that filled.
    expect(path.diagnostics.sessions).toBeGreaterThan(0);
    expect(events.filter((e) => e.kind === 'transcriptSkipped')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'transcriptPartial')).toHaveLength(0);
    path.dispose();
  }, 120_000);

  it('announces an oversize transcript as PARTIAL, with both figures, ONCE (DoD 7.7)', async () => {
    const root = await stageCodexRoot(false);
    const { cwd } = await codexBaselineRoot(root);
    const planted = await plantOversizeCodexTranscript(root, cwd, 20 * 1024 * 1024);
    const poll = manualPollTrigger();
    const events: DiagnosticsEvent[] = [];
    const pump = codexPump();

    const path = new CodexEnginePath({
      workspaceFolders: [cwd],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: pump.onChange,
      root,
      log: captureLog().log,
      pollTrigger: poll.trigger,
      maxTranscriptBytes: 1024,
      onDiagnostic: (event) => events.push(event),
    });
    await path.start();
    // The oversize one arrives over several passes: the head, then the tail in
    // 4 MiB batches, and it is reported once a whole parse exists.
    await pumpCodexUntil(poll, pump, () => path.diagnostics.partialTranscripts === 1);

    expect(path.diagnostics.partialTranscripts).toBe(1);
    expect(path.diagnostics.skippedTranscripts).toBe(0);

    const partials = events.filter((e) => e.kind === 'transcriptPartial');
    expect(partials).toHaveLength(1);
    const first = partials[0];
    if (first?.kind !== 'transcriptPartial') throw new Error('unreachable');
    expect(first.engine).toBe('codex');
    // A BASENAME, never a path: this channel is a surface a user is invited
    // to paste into a bug report, and an absolute path here begins
    // `C:\\Users\\<user>\\` on Windows.
    expect(first.file).toBe(planted.file);
    expect(first.file).not.toMatch(/[\\/]/);
    // BOTH FIGURES, measured: 256 KiB of head plus the last 16 MiB, of 20 MiB.
    expect(first.totalBytes).toBe(planted.size);
    expect(first.readBytes).toBe(256 * 1024 + 16 * 1024 * 1024);
    expect(first.readBytes).toBeLessThan(first.totalBytes);
    // The fragment at the landing point is reported rather than left silent.
    expect(first.fragments).toBe(1);

    // ONCE, and the key is the PATH: a live oversize session appends on every
    // poll, and a key carrying the byte figures would write a line a second
    // for as long as it runs.
    const afterStart = partials.length;
    for (let i = 0; i < 2; i += 1) await pumpCodexOnce(poll, pump);
    expect(events.filter((e) => e.kind === 'transcriptPartial')).toHaveLength(afterStart);
    path.dispose();
  }, 120_000);

  it('the partial session reaches the deck saying how much of it was read (DoD 7.7)', async () => {
    const root = await stageCodexRoot(false);
    const { cwd } = await codexBaselineRoot(root);
    const planted = await plantOversizeCodexTranscript(root, cwd, 20 * 1024 * 1024);
    const poll = manualPollTrigger();
    const pump = codexPump();

    const path = new CodexEnginePath({
      workspaceFolders: [cwd],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: pump.onChange,
      root,
      log: captureLog().log,
      pollTrigger: poll.trigger,
      maxTranscriptBytes: 1024,
    });
    await path.start();
    await pumpCodexUntil(poll, pump, () => path.diagnostics.partialTranscripts === 1);

    const sessions = path.sessions();
    const partial = sessions.find((session) => session.sessionId === planted.threadId);
    expect(partial?.partial).toStrictEqual({
      readBytes: 256 * 1024 + 16 * 1024 * 1024,
      totalBytes: planted.size,
    });
    // AND THE CONTROL, in the same assertion set: the corpus's own sessions
    // are on the same deck and carry NO mark. Without this, a host that
    // stamped `partial` onto every session would pass the line above.
    const whole = sessions.filter((session) => session.sessionId !== planted.threadId);
    expect(whole.length).toBeGreaterThan(0);
    for (const session of whole) expect(session.partial).toBeUndefined();

    // The figures are LATCHED: the tail follows the file, so a second read of
    // the same session must not report a different pair. `SessionPatch` has no
    // key for `partial`, so a figure that moved would ride a snapshot and
    // never a diff.
    await pumpCodexOnce(poll, pump);
    const again = path.sessions().find((session) => session.sessionId === planted.threadId);
    expect(again?.partial).toStrictEqual(partial?.partial);
    path.dispose();
  }, 120_000);
});

/*
 * ===========================================================================
 * v0.8.0 DoD 7.7 — `oversizePartial` ON THE COUNTERS LINE, END TO END
 * ===========================================================================
 *
 * `AgentDeckHost.counters()` has ONE line that sources this figure —
 * `oversizePartial: d.codex.partialTranscripts` — and a value with exactly one
 * production assignment site has that site untested until something drives it
 * the way production does. This repository has shipped that shape four times;
 * `deleting the two lines that pass workspacePaths and tailsSession left 118
 * tests green` is the comment two hundred lines above this one.
 *
 * So the whole host is built, with a Codex root holding one oversize
 * transcript, and the assertion is on the rendered LINE.
 */
describe('DoD 7.7 — the host counters line carries oversizePartial', () => {
  it('prints the Codex path\u2019s own figure, and zero when nothing is partial', async () => {
    const staged = await stageCodexRoot(false);
    const { cwd } = await codexBaselineRoot(staged);
    await plantOversizeCodexTranscript(staged, cwd, 20 * 1024 * 1024);
    const poll = manualPollTrigger();
    const pump = codexPump();

    const host = await startHostOnFreePort((port) =>
      trackHost(
        new AgentDeckHost({
          workspacePath: cwd,
          settings: settings({ port, 'codex.maxTranscriptBytes': 1024 }),
          tickMs: 0,
          nonce: 'AAAAAAAA',
          createPanel: () => fakePanel().surface,
          onEmission: pump.onChange,
          codex: { root: staged, pollTrigger: poll.trigger },
        }),
      ),
    );

    // BEFORE the tail has been drained there is no complete parse and so no
    // partial session — and the line still carries the field, at 0. That is
    // the control: without it, a `0` from a hard-coded literal and a `0` from
    // an honest census are the same string.
    const atStart = formatCounters(host.counters(), '2026-09-13T00:00:00.000Z');
    expect(atStart).toContain('oversizePartial=0');

    for (let i = 0; i < 20 && host.dataPath.diagnostics.codex.partialTranscripts === 0; i += 1) {
      poll.fire();
      await pump.next();
    }

    expect(host.dataPath.diagnostics.codex.partialTranscripts).toBe(1);
    const line = formatCounters(host.counters(), '2026-09-13T00:00:00.000Z');
    expect(line).toContain('oversizePartial=1');
    // And it was the LAST field, appended after the 7.8 scope note, so every
    // counters line quoted before this release is still a prefix of this one.
    // Hotfix 0.8.1 appended `ccLateEnabled` after it by the same rule; this
    // workspace carries no Claude Code project and no hook event arrived, so 0.
    expect(line.endsWith(' oversizePartial=1 ccLateEnabled=0')).toBe(true);
    host.dispose();
  }, 120_000);
});

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

  /*
   * NARROWED BY HOTFIX 0.6.1, AND THE NARROWING IS THE INTERESTING PART.
   *
   * This test used to assert that NO manifest key contains the word "codex".
   * `agentDeck.codex.maxTranscriptBytes` breaks that sentence and does not
   * break the decision behind it. DoD 3.2's rule is about a SWITCH: the Codex
   * engine is on when its data root exists, and there is no setting a user has
   * to find and flip to make their sessions appear — the failure mode being
   * ruled out is "the extension observes nothing and never says why".
   *
   * A size ceiling is not a switch. It cannot turn the engine off (its floor
   * is 1 MiB, comfortably above any real session's first read), it has a
   * working default, and every value of it leaves the engine reading.
   *
   * So the assertion is re-pointed at the property rather than at the word:
   * no setting enables, disables or gates the Codex engine, and the engine
   * still reads with every setting at its default. Weakening it to "keys may
   * contain codex" and stopping there would have deleted the guard instead of
   * re-aiming it.
   */
  it('declares no Codex ON/OFF setting: the switch is the data root, and only the data root', async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as {
      contributes?: {
        configuration?: { properties?: Record<string, { type?: unknown; default?: unknown }> };
      };
    };
    const properties = manifest.contributes?.configuration?.properties ?? {};
    const keys = Object.keys(properties);
    expect(keys.length).toBeGreaterThan(0);

    /*
     * RE-AIMED IN v0.7.0 PHASE 3, NOT WEAKENED, AND THE DISTINCTION IS THE
     * WHOLE POINT.
     *
     * This block used to assert that NO manifest property is a boolean and NO
     * key contains "enable"/"enabled"/"disable"/"disabled"/"engines"/"mode",
     * on the reasoning stated above it: a switch is what a boolean IS.
     *
     * `agentDeck.stats.enabled` is both of those things and is not an engine
     * switch. It turns off the LOCAL STORE — G7 as amended requires the
     * history to be "setting-disableable" in those words — and a window with
     * it off observes all three engines exactly as before, renders the same
     * deck, and simply writes no file. The two guards would have gone red for
     * a setting the Grounding Contract obliges this release to ship.
     *
     * Deleting them was the tempting move and would have been the wrong one:
     * this file's own comment records that weakening the Codex guard to "keys
     * may contain codex" would have deleted it rather than re-aimed it. So the
     * rule is narrowed to what it was always FOR, and narrowed in a way that
     * cannot drift:
     *
     *   - a boolean setting is allowed only if it is on a PINNED ALLOW-LIST,
     *     compared as a SET so a second boolean fails until somebody justifies
     *     it here in writing;
     *   - the engine-naming words are still forbidden EVERYWHERE, including on
     *     the allow-listed key, so `agentDeck.codex.enabled` remains
     *     impossible however it is spelled;
     *   - the switch words are still forbidden on every key that is not on the
     *     allow-list.
     *
     * And the control at the bottom of this test is untouched, which is what
     * makes the whole thing more than a spelling rule.
     */
    // v0.7.0 Phase 4 adds `agentDeck.canvas.autoFit` (DoD 4.0): a boolean, on
    // the list in writing, and not an engine switch — it governs the canvas's
    // re-fit rule and nothing about what is observed.
    //
    // v0.7.1 DoD 6.1 adds `agentDeck.telemetry.enabled`, named by the locked
    // ruling. Not an engine switch either: with it off, all three engines are
    // observed exactly as before — transcripts, store, hooks — and the listener
    // merely answers `403` on the three `/v1/*` paths. It gates whether an
    // OPTIONAL INPUT Claude Code can be pointed at is accepted, not whether an
    // engine is read. It names no engine, so the engine-word loop below still
    // applies to it and still passes.
    //
    // v0.8.0 DoD 7.6 adds THREE booleans, and each is on this list in writing
    // because the rule is that a boolean must justify itself here:
    //
    //   followNewSessions        what the deck does with a session that
    //                            appears. The session is discovered, tailed,
    //                            grafted and counted at either value; what
    //                            moves is the selection.
    //   openDrawerOnEnter        whether entering a session opens its
    //                            tool-call drawer. The drawer holds the same
    //                            calls either way.
    //   drawerExpandedByDefault  the height the drawer opens at. The drawer's
    //                            own control still expands and collapses it.
    //
    // None of the three can turn an engine, a tap or a listener off, none
    // changes what is read from disk, and the control at the bottom of this
    // test still runs the Codex engine with every setting at its default.
    const BOOLEAN_ALLOW_LIST = [
      'agentDeck.canvas.autoFit',
      'agentDeck.drawerExpandedByDefault',
      'agentDeck.followNewSessions',
      'agentDeck.openDrawerOnEnter',
      'agentDeck.stats.enabled',
      'agentDeck.telemetry.enabled',
    ];
    const booleans = Object.entries(properties)
      .filter(([, property]) => property.type === 'boolean')
      .map(([key]) => key)
      .sort();
    expect(booleans, 'a boolean setting that is not the local store switch').toStrictEqual(
      BOOLEAN_ALLOW_LIST,
    );

    /*
     * NO ALLOW-LISTED BOOLEAN NAMES AN ENGINE.
     *
     * This is the narrow half, and it is narrow on purpose:
     * `agentDeck.codex.maxTranscriptBytes` names an engine and is not a
     * switch — it is a size gate, and DoD 3.2's rule was never "no key may say
     * codex". What the rule forbids is a BOOLEAN that names an engine, which
     * is the only shape an engine on/off toggle can take. Applying the engine
     * words to every key would fail on a setting this repository shipped
     * deliberately in 0.6.1.
     */
    const engineWords = ['codex', 'opencode', 'claude', 'engine'];
    for (const key of booleans) {
      for (const word of engineWords) {
        expect(key.toLowerCase(), `${key} is a boolean naming an engine (${word})`).not.toContain(
          word,
        );
      }
    }

    // And no key outside the allow-list names enabling, disabling or a mode.
    const switchWords = ['enable', 'disable', 'enabled', 'disabled', 'engines', 'mode'];
    for (const key of keys) {
      if (BOOLEAN_ALLOW_LIST.includes(key)) continue;
      for (const word of switchWords) {
        expect(key.toLowerCase(), `${key} looks like a switch (${word})`).not.toContain(word);
      }
    }

    // THE CONTROL, and it is what makes the two loops above more than a
    // spelling rule: with every setting at its manifest default, the engine
    // reads a real corpus and produces sessions. A future setting that turned
    // the engine off by default would pass both loops and fail here.
    const staged = await stageCodexRoot(false);
    const outcome = await readCodexEngine({
      root: staged,
      maxTranscriptBytes: readSettings(undefined)['codex.maxTranscriptBytes'],
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.result.threads.length).toBeGreaterThan(0);
    expect(outcome.result.skipped).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// §6.1 — the hook socket binds for ANY hook-driven engine (user decision,
// 2026-09-04)
// ---------------------------------------------------------------------------

/*
 * WHAT WAS BROKEN, AND WHY NOTHING WENT RED FOR IT.
 *
 * `activate()` sets `ccEnabled` from the Claude Code correlation, so it is
 * false whenever the open workspace has no matching CC project — AN ORDINARY
 * STATE for someone running Codex where Claude Code has never run. On that
 * path `AgentDeckDataPath.start()` returned early ABOVE `listener.start()` and
 * ABOVE `subscribeCodex`: the loopback socket was never bound, and Codex
 * liveness never saw a hook event. Outside that, `activate()` itself returned
 * before constructing anything at all unless CC correlated or an OpenCode
 * store existed — so for a Codex-only user there was no data path to fix.
 *
 * Both gates are closed here, and both are tested, because closing either one
 * alone leaves the user exactly where they were.
 *
 * The rule, as decided: bind when ANY hook-driven engine is observable — a CC
 * project correlates OR a Codex data root exists. Neither, and the socket is
 * deliberately not bound, said once at info. A port collision remains an error
 * and is never a silent re-pick.
 *
 * SUPERSEDED IN ITS "NEITHER" CLAUSE by hotfix 0.8.1 (user ruling 2026-09-15):
 * every started data path binds or follows, because "neither" is every new
 * Claude Code user before their first session, and that session's first hook
 * event is what enables the CC half. The last test in this block says so.
 */
describe('§6.1 — the hook socket binds for any hook-driven engine', () => {
  /** POST one hook payload to the listener, exactly as a real hook does. */
  async function post(port: number, payload: unknown): Promise<number> {
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
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  /**
   * The captured Codex hook payloads for the baseline run — the `.raw` bodies,
   * which are the actual wire form a Codex hook POSTs, not this repository's
   * capture envelope around them.
   */
  async function capturedCodexPayloads(): Promise<Record<string, unknown>[]> {
    const stream = await readFile(
      fileURLToPath(
        new URL(
          '../fixtures/codex-0.151.0-alpha.7.2/baseline/hook-stream.jsonl',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    return stream
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as { raw: Record<string, unknown> }).raw);
  }

  /** A real, empty workspace with no Claude Code project anywhere near it. */
  async function workspaceWithNoClaudeCode(): Promise<string> {
    process.env['CLAUDE_PROJECTS_ROOT'] = await makeTempDir();
    const dir = join(await makeTempDir(), 'codex-only-workspace');
    await mkdir(dir, { recursive: true });
    return dir;
  }

  it('codexRootExists follows $CODEX_HOME, the way the engine resolves it', async () => {
    const absent = join(await makeTempDir(), 'no-such-.codex');
    expect(codexRootExists({ [CODEX_HOME_VAR]: absent })).toBe(false);

    const staged = await stageCodexRoot(false);
    expect(codexRootExists({ [CODEX_HOME_VAR]: staged })).toBe(true);
  });

  it('codexRootExists asks the ENGINE\'S question: a file at the root path is not a root', async () => {
    // `locateCodex` decides `rootExists` with `statSync(root).isDirectory()`.
    // An `existsSync` here would answer `true` for a regular file and start a
    // deck for a machine the engine then reports as having no Codex — two
    // probes for one question, disagreeing silently.
    const file = join(await makeTempDir(), 'codex-is-a-file');
    await writeFile(file, 'not a directory', 'utf8');
    expect(existsSync(file), 'the control: it does exist').toBe(true);
    expect(codexRootExists({ [CODEX_HOME_VAR]: file })).toBe(false);

    // And the engine agrees, which is the property being held rather than the
    // implementation being restated.
    const outcome = await readCodexEngine({ root: file });
    expect(outcome.kind).toBe('rootAbsent');
  });

  it('activate() starts for a Codex-only workspace, which it used to refuse outright', async () => {
    process.env[CODEX_HOME_VAR] = await stageCodexRoot(false);
    const lonely = await workspaceWithNoClaudeCode();

    await activateOnFreePort((port) => {
      mock.setWorkspaceFolder(lonely);
      mock.setConfig(CONFIG_SECTION, { port });
    });

    const host = currentHost();
    expect(host, 'a Codex-only workspace gets a deck').not.toBeNull();
    const diagnostics = host?.dataPath.diagnostics;
    // The CC half is still off — the correlation gate's point is preserved,
    // not deleted.
    expect(diagnostics?.ccEnabled).toBe(false);
    expect(diagnostics?.codex.enabled).toBe(true);
  });

  it('binds the socket with no Claude Code project, and a real Codex hook is attributed', async () => {
    const staged = await stageCodexRoot(false);
    process.env[CODEX_HOME_VAR] = staged;

    /*
     * THE WORKSPACE IS THE CORPUS'S OWN `cwd`, and hotfix 0.6.1 is why.
     *
     * It used to be `workspaceWithNoClaudeCode()` — a temp directory unrelated
     * to the staged transcripts. That worked because the engine parsed EVERY
     * transcript and left the workspace decision to a `workspaceMatch` flag the
     * host filtered on afterwards; the threads were there to attribute hooks to
     * even though none of them would ever reach the deck.
     *
     * The engine now stops reading a foreign transcript after its first 256
     * KiB, so a workspace that matches nothing has no threads at all — and a
     * test asserting hook attribution against zero threads was asserting
     * nothing. Pointing the workspace at the corpus is not a workaround: it is
     * what "a real Codex hook is attributed" was always supposed to mean, and
     * the sessions being attributed are now sessions that would actually
     * render.
     *
     * `ccEnabled: false` still holds, which is the property this test is
     * really about: that path is a Codex scratch directory with no Claude Code
     * project, and it does not exist on this machine at all.
     */
    const { cwd } = await codexBaselineRoot(staged);

    const port = await activateOnFreePort((freePort) => {
      mock.setWorkspaceFolder(cwd);
      mock.setConfig(CONFIG_SECTION, { port: freePort });
    });

    const host = currentHost();
    expect(host).not.toBeNull();
    const before = host?.dataPath.diagnostics;
    expect(before?.ccEnabled).toBe(false);
    // THE DEFECT, in one line: this was `false`.
    expect(before?.hookBindAttempted).toBe(true);
    expect(before?.listening).toBe(true);

    const payloads = await capturedCodexPayloads();
    expect(payloads.length, 'the captured stream must not be empty').toBeGreaterThan(0);
    for (const payload of payloads) expect(await post(port, payload)).toBe(200);

    // Received AND routed: `acceptedCodex` is the discriminator's own count.
    expect(host?.dataPath.listener.counters.acceptedCodex).toBe(payloads.length);
    // Hotfix 0.8.1: routed to the Codex handlers ONLY. These payloads name this
    // very workspace as their `cwd`, so a Codex body misrouted to the Claude
    // Code handler set would have started a slug lookup here.
    expect(host?.dataPath.diagnostics.ccLateLookups).toBe(0);
    expect(host?.dataPath.diagnostics.ccEnabled).toBe(false);

    /*
     * ATTRIBUTED, and this assertion had to be rewritten to say so.
     *
     * The first version asserted `hookStatesWithoutThread === 0`, which reads
     * like attribution and is not: `src/codex/liveness.ts` derives it by
     * walking the STATE MAP, so it is 0 when the map is EMPTY. `eventsSeen` is
     * incremented above the `session_id` usability check, so it moves for an
     * event that is then discarded. A verifier proved the pair vacuous by
     * making every event unusable — both assertions stayed green.
     *
     * `lastHookEventMs` is the per-thread evidence and cannot be faked by an
     * empty map: it is non-null only when a hook state exists FOR THAT THREAD.
     * The staged root is the same run the stream was captured beside, so every
     * thread the payloads name must carry one.
     */
    const report = host?.dataPath.codex.livenessEngine?.poll();
    expect(report, 'the Codex liveness engine must exist for a present root').toBeDefined();
    expect(report?.counters.eventsSeen).toBe(payloads.length);
    // Every payload was USABLE, so each one created or updated a state. Zero
    // here is what makes `eventsSeen` mean what it looks like it means.
    expect(report?.counters.eventsUnusable).toBe(0);

    // Derived from the payloads, never written down: the thread each one names
    // is `agent_id` when present and `session_id` otherwise — the recorded
    // main-thread rule, where ABSENCE of the key is the signal.
    const named = new Set(
      payloads.map((p) => (p['agent_id'] as string | undefined) ?? (p['session_id'] as string)),
    );
    expect(named.size).toBeGreaterThan(0);
    for (const threadId of named) {
      const thread = report?.threads.find((t) => t.threadId === threadId);
      expect(thread, `no thread ${threadId} in the tree the engine read`).toBeDefined();
      expect(
        thread?.lastHookEventMs,
        `thread ${threadId} was named by a payload and carries no hook event`,
      ).not.toBeNull();
    }
  });

  it('does not report a Codex-only window as "hooks silent"', async () => {
    // The panel-wide banner is the CLAUDE CODE tap's health, and with the CC
    // half off its `eventsReceived === 0` is a statement about an engine that
    // is not running. This is the D2 defect one level up from where D2 was
    // fixed, and it only became reachable when the socket started binding
    // here: before, this window never bound and never emitted about hooks.
    process.env[CODEX_HOME_VAR] = await stageCodexRoot(false);
    const lonely = await workspaceWithNoClaudeCode();

    const emissions: DataPathEmission[] = [];
    const path = await startDataPathOnFreePort((port) =>
      trackDataPath(
        new AgentDeckDataPath({
          workspacePath: lonely,
          projectsRoot: process.env['CLAUDE_PROJECTS_ROOT'] as string,
          ccEnabled: false,
          settings: settings({ port }),
          tickMs: 0,
          onEmission: (payload) => {
            emissions.push(payload);
          },
        }),
      ),
    );

    expect(path.diagnostics.listening).toBe(true);
    expect(emissions.length).toBeGreaterThan(0);
    for (const emission of emissions) {
      expect(emission.degraded, 'a bound socket is not a degraded tap').toStrictEqual({
        degraded: false,
      });
    }
  });

  it('a collision on that socket is still an error, and still never a silent re-pick', async () => {
    process.env[CODEX_HOME_VAR] = await stageCodexRoot(false);
    const lonely = await workspaceWithNoClaudeCode();
    const { port, release } = await heldPort();

    try {
      const emissions: DataPathEmission[] = [];
      const path = trackDataPath(
        new AgentDeckDataPath({
          workspacePath: lonely,
          projectsRoot: process.env['CLAUDE_PROJECTS_ROOT'] as string,
          ccEnabled: false,
          settings: settings({ port }),
          tickMs: 0,
          onEmission: (payload) => {
            emissions.push(payload);
          },
          onError: () => {},
        }),
      );
      await path.start();

      expect(path.diagnostics.hookBindAttempted).toBe(true);
      expect(path.diagnostics.listening).toBe(false);
      expect(path.diagnostics.bindError?.code).toBe('EADDRINUSE');
      // The port it was told to use, not one it chose for itself.
      expect(path.diagnostics.bindError?.port).toBe(port);
      expect(path.settings.port).toBe(port);
      // And the user is told: Codex liveness is blind without this socket, so
      // `listenerDown` here is true and actionable rather than the CC tap's
      // meaningless silence.
      expect(emissions.at(-1)?.degraded).toStrictEqual({
        degraded: true,
        reason: 'listenerDown',
      });
    } finally {
      await release();
    }
  });

  it('binds even when neither engine is observable, and says once why Claude Code has not started', async () => {
    /*
     * HOTFIX 0.8.1 REVERSED THIS TEST'S SUBJECT. It was "binds NOTHING when
     * neither engine is hook-driven". Until the user ruling of 2026-09-15 a window with neither
     * engine bound nothing and logged `NO_HOOK_ENGINE_LOG` once. That window
     * is every new Claude Code user before their first session, and Claude
     * Code's first hook event could never reach it. It binds now, and the one
     * info line is the reason the CC half has not started.
     */
    const lonely = await workspaceWithNoClaudeCode();
    const absent = join(await makeTempDir(), 'no-such-.codex');
    expect(existsSync(absent)).toBe(false);
    const sink = captureLog();
    const failure: DiscoveryFailure = {
      kind: 'projectSlugNotFound',
      code: 'ENOENT',
      path: join(lonely, 'no-slug'),
      message: 'synthetic projectSlugNotFound',
    };
    const reason = inactiveReasonFor(failure);

    const emissions: DataPathEmission[] = [];
    const path = await startDataPathOnFreePort((port) => {
      sink.lines.length = 0;
      emissions.length = 0;
      return trackDataPath(
        new AgentDeckDataPath({
          workspacePath: lonely,
          projectsRoot: process.env['CLAUDE_PROJECTS_ROOT'] as string,
          ccEnabled: false,
          ccCorrelationFailure: failure,
          codex: { root: absent },
          settings: settings({ port }),
          tickMs: 0,
          log: sink.log,
          onEmission: (payload) => {
            emissions.push(payload);
          },
        }),
      );
    });
    // `start()` opens with `if (this.#disposed || this.#started) return;`, so
    // these prove the `#started` guard: still one reason line, not three.
    await path.start();
    await path.start();

    expect(path.diagnostics.hookBindAttempted).toBe(true);
    expect(path.diagnostics.listening).toBe(true);
    expect(path.diagnostics.ccEnabled).toBe(false);
    // All three, in the order `start()` reaches them, and pinned as a whole
    // rather than by `toContain`: an extra line here would be a second engine
    // reporting an absence nobody asked about, which is worth a red.
    expect(sink.lines).toStrictEqual([
      { level: 'info', message: OPENCODE_ABSENT_LOG },
      { level: 'info', message: CODEX_ABSENT_LOG },
      { level: 'info', message: reason },
    ]);
    // Not degraded: the socket is up, so there is nothing to be degraded ABOUT.
    // A silent CC tap that has not started is not a silent hook.
    expect(emissions.length).toBeGreaterThan(0);
    for (const emission of emissions) {
      expect(emission.degraded).toStrictEqual({ degraded: false });
    }
    // The deck still renders. A window with no hook engine is not a dead one.
    expect(path.diagnostics.emissions).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Hotfix 0.8.1 — late Claude Code enablement (spec Amendment 2026-09-15)
// ---------------------------------------------------------------------------

/*
 * THE DEFECT. `ccEnabled` was decided once, at activation, from a slug
 * directory lookup. A workspace that has never run Claude Code has no slug
 * directory yet, so the Claude Code watcher never started and hook events never
 * reached the model for the window's lifetime — and on a machine with no
 * OpenCode store and no Codex root, `activate()` returned before a host existed
 * at all. Every new user's first session.
 *
 * H1 drives the product the way the user meets it: `activate()` over a projects
 * root that holds no slug directory, then Claude Code's own first moves — the
 * slug directory and an empty transcript appear, and one REAL `SessionStart`
 * body (the committed capture, `cwd` rewritten to this workspace) arrives on
 * the listener.
 */
describe('hotfix 0.8.1 — Claude Code is enabled late, by its first hook event', () => {
  const previousRoot = process.env['CLAUDE_PROJECTS_ROOT'];

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['CLAUDE_PROJECTS_ROOT'];
    else process.env['CLAUDE_PROJECTS_ROOT'] = previousRoot;
  });

  /** The first captured `SessionStart` body, with `cwd` rewritten to `cwd`. */
  async function sessionStartBody(cwd: string): Promise<Record<string, unknown>> {
    const stream = await readFile(
      fileURLToPath(new URL('../fixtures/hook-events/cc-2.1.234-sessionstart.jsonl', import.meta.url)),
      'utf8',
    );
    const first = stream.split(/\r?\n/).find((line) => line.trim() !== '');
    expect(first, 'the SessionStart capture is empty').toBeDefined();
    const body = JSON.parse(first ?? '{}') as Record<string, unknown>;
    expect(body['hook_event_name']).toBe('SessionStart');
    expect(typeof body['session_id']).toBe('string');
    return { ...body, cwd };
  }

  /**
   * Activate over an existing projects root that holds NO slug directory.
   *
   * `withCodexRoot` is the second arm. With a Codex root present a host and a
   * bound socket existed before the fix too, so that arm isolates the INNER
   * defect (the one-shot `ccEnabled`) from the activation gate above it, and a
   * fix to only one of the two leaves one arm red.
   */
  async function activateBeforeClaudeCode(withCodexRoot = false): Promise<{
    port: number;
    projectsRoot: string;
    workspace: string;
    host: AgentDeckHost;
  }> {
    const projectsRoot = await makeTempDir();
    const workspace = join(await makeTempDir(), 'first-session-ws');
    await mkdir(workspace, { recursive: true });
    process.env['CLAUDE_PROJECTS_ROOT'] = projectsRoot;
    if (withCodexRoot) process.env[CODEX_HOME_VAR] = await stageCodexRoot(false);
    expect(codexRootExists()).toBe(withCodexRoot);
    expect((await correlateWorkspace(workspace)).ok, 'the slug directory must not exist yet').toBe(false);

    const port = await activateOnFreePort((attemptPort) => {
      mock.setWorkspaceFolder(workspace);
      mock.setConfig(CONFIG_SECTION, { port: attemptPort });
    });
    const host = currentHost();
    expect(host, 'a window with a folder open must have a host').not.toBeNull();
    if (host === null) throw new Error('unreachable');
    expect(host.dataPath.diagnostics.ccEnabled).toBe(false);
    expect(host.dataPath.diagnostics.listening).toBe(true);
    return { port, projectsRoot, workspace, host };
  }

  /** The first real `PreToolUse` body of the redacted capture, moved to `sessionId` in `cwd`. */
  async function firstPreToolUseBody(sessionId: string, cwd: string): Promise<Record<string, unknown>> {
    const stream = await readFile(
      fileURLToPath(new URL('../fixtures/hook-events/cc-2.1.234-redacted.jsonl', import.meta.url)),
      'utf8',
    );
    const body = stream
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event['hook_event_name'] === 'PreToolUse');
    expect(body, 'the redacted capture holds no PreToolUse').toBeDefined();
    return { ...body, session_id: sessionId, cwd };
  }

  /** What Claude Code does on disk at a session's onset: the slug dir and its transcript. */
  async function claudeCodeCreates(projectsRoot: string, workspace: string, sessionId: string): Promise<void> {
    const slugDir = join(projectsRoot, slugifyWorkspace(workspace));
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${sessionId}.jsonl`), '');
  }

  for (const withCodexRoot of [false, true]) {
    const arm = withCodexRoot ? 'with a Codex root (the inner gate)' : 'Claude Code only (the activation gate)';
    it(`H1: no slug directory at activation; the first SessionStart registers the session — ${arm}`, async () => {
      const { port, projectsRoot, workspace, host } = await activateBeforeClaudeCode(withCodexRoot);
      const body = await sessionStartBody(workspace);
      const sessionId = body['session_id'] as string;
      await claudeCodeCreates(projectsRoot, workspace, sessionId);

      expect(await postHookEventTo(port, body)).toBe(HOOK_OK);

      await waitFor(() => host.dataPath.model.hasSession(sessionId), 'the session to register');
      expect(host.dataPath.diagnostics.ccEnabled).toBe(true);
      const snapshot = host.dataPath.model.snapshot();
      expect(snapshot.map((s) => s.sessionId)).toStrictEqual([sessionId]);
      // And what LEFT: the host's own count comes from the emission it published,
      // so a model that registered the session and never emitted it stays red.
      await waitFor(() => host.counters().ccSessions === 1, 'the session to be emitted');
      // The ENABLING event reached the model too (`CC_LATE_REPLAY_MAX`): without
      // the replay the tap has received nothing and reads `noHookEvents` over a
      // session whose hooks just proved they arrive.
      expect(host.dataPath.liveness.degradedState()).toStrictEqual({ degraded: false });
      expect(host.dataPath.diagnostics.ccLateEnabled).toBe(1);
      expect(host.dataPath.watcher.diagnostics.started).toBe(true);

      // AFTER enablement the model is ON THE TAP, not only fed the replay
      // (verifier round, hotfix 0.8.1: deleting `#subscribeCc()` from the late
      // path left every test green, because the replayed SessionStart alone
      // satisfied everything above). A later, DIFFERENT real event — the first
      // `PreToolUse` of the redacted capture, for this session and workspace —
      // must reach this session's liveness. Dispatch happens before the 200.
      const seen = host.dataPath.model.livenessSnapshot(sessionId)?.hookEventCount ?? 0;
      expect(seen, 'the replayed SessionStart').toBeGreaterThan(0);
      const later = await firstPreToolUseBody(sessionId, workspace);
      expect(await postHookEventTo(port, later)).toBe(HOOK_OK);
      expect(host.dataPath.model.livenessSnapshot(sessionId)?.hookEventCount).toBe(seen + 1);
    }, 60_000);
  }

  it('a data path disposed mid-chain leaves no late-lookup timer behind', async () => {
    const projectsRoot = await makeTempDir();
    const workspace = join(await makeTempDir(), 'disposed-mid-chain-ws');
    const time = new ManualTime(1_000_000);
    const path = await startDataPathOnFreePort((port) =>
      trackDataPath(
        new AgentDeckDataPath({
          workspacePath: workspace,
          projectsRoot,
          ccEnabled: false,
          codex: { root: join(projectsRoot, 'no-codex-root') },
          settings: settings({ port }),
          scheduler: time,
          tickMs: 0,
          log: () => {},
          onEmission: () => {},
        }),
      ),
    );
    expect(await postHookEventTo(path.settings.port, await sessionStartBody(workspace))).toBe(HOOK_OK);
    await waitFor(
      () => path.diagnostics.ccLateLookups === 1 && path.diagnostics.timersArmed === 1,
      'the first attempt to fail and arm its retry',
    );
    expect(time.pendingTimers, 'the retry is armed on the scheduler itself').toBeGreaterThan(0);
    await path.dispose();
    expect(path.diagnostics.timersArmed).toBe(0);
    // THE SCHEDULER, not the field (verifier round 2): `timersArmed` is computed
    // from the handle, which `dispose()` nulls whether or not it cleared the
    // timer, so a dispose that forgot `clearTimer` read 0 there while a real
    // retry stayed pending.
    expect(time.pendingTimers).toBe(0);
    expect(path.diagnostics.ccLateChainActive).toBe(false);
    time.advance(60_000);
    expect(path.diagnostics.ccLateLookups).toBe(1);
  }, 60_000);

  it('H3: a SessionStart from ANOTHER workspace enables nothing — and this workspace’s own then does', async () => {
    const { port, projectsRoot, workspace, host } = await activateBeforeClaudeCode();
    const body = await sessionStartBody(workspace);
    const sessionId = body['session_id'] as string;
    // The slug directory EXISTS, so a lookup would succeed if one ran: the
    // only thing standing between this event and an enabled half is the guard.
    await claudeCodeCreates(projectsRoot, workspace, sessionId);
    const foreign = join(await makeTempDir(), 'some-other-repo');
    expect(slugifyWorkspace(foreign)).not.toBe(slugifyWorkspace(workspace));

    expect(await postHookEventTo(port, { ...body, cwd: foreign })).toBe(HOOK_OK);
    // Dispatch happens before the 200 (listener.ts), and a lookup is counted
    // before its first await, so "no lookup" is decided by now — no sleep.
    expect(host.dataPath.listener.counters.accepted).toBe(1);
    expect(host.dataPath.diagnostics.ccLateLookups).toBe(0);
    expect(host.dataPath.diagnostics.ccEnabled).toBe(false);

    // THE CONTROL, in the same window: the same body with this workspace's
    // cwd enables it. Without this the zero above could be a path that never
    // runs for anyone.
    expect(await postHookEventTo(port, body)).toBe(HOOK_OK);
    await waitFor(() => host.dataPath.diagnostics.ccEnabled, 'the same-workspace event to enable the half');
    expect(host.dataPath.diagnostics.ccLateLookups).toBe(1);
  }, 60_000);

  it('H2: the retry count and interval are the pinned constants, and the chain uses them', async () => {
    expect(CC_LATE_LOOKUP_RETRIES).toBe(5);
    expect(CC_LATE_LOOKUP_INTERVAL_MS).toBe(200);
    expect(CC_LATE_REPLAY_MAX).toBe(32);

    const projectsRoot = await makeTempDir();
    const workspace = join(await makeTempDir(), 'slow-disk-ws');
    const time = new ManualTime(1_000_000);
    const path = await startDataPathOnFreePort((port) =>
      trackDataPath(
        new AgentDeckDataPath({
          workspacePath: workspace,
          projectsRoot,
          ccEnabled: false,
          codex: { root: join(projectsRoot, 'no-codex-root') },
          settings: settings({ port }),
          scheduler: time,
          tickMs: 0,
          log: () => {},
          onEmission: () => {},
        }),
      ),
    );
    const port = path.settings.port;
    const body = await sessionStartBody(workspace);
    const d = (): AgentDeckDataPath['diagnostics'] => path.diagnostics;

    // The slug directory is NOT there yet: every attempt fails.
    expect(await postHookEventTo(port, body)).toBe(HOOK_OK);
    for (let attempt = 1; attempt <= CC_LATE_LOOKUP_RETRIES; attempt += 1) {
      await waitFor(
        () => d().ccLateLookups === attempt && d().timersArmed === 1,
        `attempt ${String(attempt)} to fail and arm its retry`,
      );
      time.advance(CC_LATE_LOOKUP_INTERVAL_MS - 1);
      expect(d().ccLateLookups, 'a retry fired before the interval').toBe(attempt);
      // A second event DURING the chain starts no second chain.
      if (attempt === 1) {
        expect(await postHookEventTo(port, body)).toBe(HOOK_OK);
        expect(d().ccLateLookups).toBe(1);
      }
      time.advance(1);
      expect(d().ccLateLookups, 'the retry did not fire at the interval').toBe(attempt + 1);
    }
    // One first attempt plus exactly CC_LATE_LOOKUP_RETRIES retries, then stop.
    await waitFor(() => !d().ccLateChainActive, 'the chain to exhaust');
    expect(d().ccLateLookups).toBe(1 + CC_LATE_LOOKUP_RETRIES);
    expect(d().timersArmed).toBe(0);
    time.advance(60_000);
    expect(d().ccLateLookups).toBe(1 + CC_LATE_LOOKUP_RETRIES);
    expect(d().ccEnabled).toBe(false);

    // An exhausted chain is not the end: Claude Code finally writes the
    // directory, and the next same-workspace event starts a fresh chain.
    await claudeCodeCreates(projectsRoot, workspace, body['session_id'] as string);
    expect(await postHookEventTo(port, body)).toBe(HOOK_OK);
    await waitFor(() => d().ccEnabled, 'the next event to enable the half');
    expect(d().ccLateLookups).toBe(2 + CC_LATE_LOOKUP_RETRIES);
    expect(d().ccLateEnabled).toBe(1);
    expect(d().ccLateChainActive).toBe(false);
  }, 60_000);

  /*
   * RULING 2026-09-15 (3): the ambiguous-folder explanation goes to the Agent
   * Deck output channel, no dialog. Driven through a whole host with a sink,
   * because the `vscode` double has no `createOutputChannel` and NTFS cannot
   * hold the two case-variant directories that make `activate()` produce the
   * failure — the same constraint the (8b) block records. Both arms, so a
   * surface that took every kind (or none) goes red.
   */
  for (const kind of ['ambiguousSlug', 'projectSlugNotFound'] as const) {
    it(`ruling (3): ${kind} — ${kind === 'ambiguousSlug' ? 'one line on the output channel, not the log' : 'the log, never the channel'}; no dialog`, async () => {
      const projectsRoot = await makeTempDir();
      const workspace = join(await makeTempDir(), 'refused-ws');
      const sink = collectingSink();
      const logged = captureLog();
      const failure: DiscoveryFailure = {
        kind,
        code: kind === 'ambiguousSlug' ? 'EAMBIGUOUS' : 'ENOENT',
        path: join(projectsRoot, 'some-slug'),
        message: `synthetic ${kind}`,
      };
      const reason = inactiveReasonFor(failure);
      const host = await startHostOnFreePort((port) => {
        sink.lines.length = 0;
        logged.lines.length = 0;
        return trackHost(
          new AgentDeckHost({
            workspacePath: workspace,
            projectsRoot,
            ccEnabled: false,
            ccCorrelationFailure: failure,
            codex: { root: join(projectsRoot, 'no-codex-root') },
            settings: settings({ port }),
            tickMs: 0,
            log: logged.log,
            nonce: 'AAAAAAAA',
            createPanel: () => fakePanel().surface,
            createDiagnosticsSink: sink.factory,
            onEmission: () => {},
          }),
        );
      });
      expect(host.dataPath.diagnostics.listening).toBe(true);

      const onChannel = sink.lines.filter((line) => line.includes(reason));
      const onLog = logged.lines.filter((line) => line.message === reason);
      if (kind === 'ambiguousSlug') {
        expect(onChannel).toStrictEqual([expect.stringMatching(/ cc correlation refused Agent Deck: .*ambiguousSlug/)]);
        // The WHOLE line is the time, the event words and the sentence — so no
        // path can ride along after it (verifier round 2: appending
        // `failure.path` to the reason passed every earlier assertion).
        expect(onChannel[0]?.endsWith(` cc correlation refused ${reason}`)).toBe(true);
        expect(onChannel[0]).not.toContain(failure.path);
        expect(sink.lines.some((line) => line.includes(failure.path))).toBe(false);
        expect(onLog).toStrictEqual([]);
      } else {
        expect(onChannel).toStrictEqual([]);
        expect(onLog).toStrictEqual([{ level: 'info', message: reason }]);
      }
      // No dialog on either arm: nothing reached the `vscode` window double.
      expect(mock.informationMessages).toStrictEqual([]);
      expect(mock.errorMessages).toStrictEqual([]);
    }, 60_000);
  }

  it('H4: one "cc enabled late" line naming the slug, and ccLateEnabled on the channel’s counters line', async () => {
    const projectsRoot = await makeTempDir();
    const workspace = join(await makeTempDir(), 'channel-ws');
    const sink = collectingSink();
    const time = new ManualTime(Date.parse('2026-09-15T00:00:00.000Z'));
    const host = await startHostOnFreePort((port) =>
      trackHost(
        new AgentDeckHost({
          workspacePath: workspace,
          projectsRoot,
          ccEnabled: false,
          codex: { root: join(projectsRoot, 'no-codex-root') },
          settings: settings({ port }),
          scheduler: time,
          now: () => time.now(),
          tickMs: 0,
          log: () => {},
          nonce: 'AAAAAAAA',
          createPanel: () => fakePanel().surface,
          createDiagnosticsSink: sink.factory,
          onEmission: () => {},
        }),
      ),
    );

    // The control: before Claude Code is seen, the counters line says 0.
    time.advance(COUNTERS_INTERVAL_MS);
    const before = sink.lines.filter((line) => line.includes(' counters '));
    expect(before).toHaveLength(1);
    expect(before[0]?.endsWith(' ccLateEnabled=0')).toBe(true);

    const body = await sessionStartBody(workspace);
    await claudeCodeCreates(projectsRoot, workspace, body['session_id'] as string);
    expect(await postHookEventTo(host.dataPath.settings.port, body)).toBe(HOOK_OK);
    await waitFor(() => host.dataPath.diagnostics.ccEnabled, 'the half to enable');
    // More events after enablement write no second line: it is once per window.
    expect(await postHookEventTo(host.dataPath.settings.port, body)).toBe(HOOK_OK);

    const late = sink.lines.filter((line) => line.includes(' cc enabled late '));
    expect(late).toStrictEqual([
      expect.stringMatching(new RegExp(` cc enabled late slug=${slugifyWorkspace(workspace)}$`)),
    ]);

    time.advance(COUNTERS_INTERVAL_MS);
    const after = sink.lines.filter((line) => line.includes(' counters '));
    expect(after).toHaveLength(2);
    expect(after[1]?.endsWith(' ccLateEnabled=1')).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// DoD 5.0a - `sessionRemoved` carries the engine the session actually had
// ---------------------------------------------------------------------------

/**
 * A diagnostics sink that keeps every line.
 *
 * The channel creates its sink on the FIRST line, never at construction, so
 * the factory has to hand back the same object each time or a test reads an
 * empty transcript from a channel that has been writing happily.
 */
function collectingSink(): { lines: string[]; factory: () => DiagnosticsSink } {
  const lines: string[] = [];
  const sink: DiagnosticsSink = {
    appendLine: (line: string) => {
      lines.push(line);
    },
    show: () => {},
    dispose: () => {},
  };
  return { lines, factory: () => sink };
}

/** Every `.jsonl` under a Codex `sessions/` tree, at any YYYY/MM/DD depth. */
async function findTranscripts(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findTranscripts(full)));
    else if (entry.name.endsWith('.jsonl')) found.push(full);
  }
  return found;
}

describe('DoD 5.0a - a removed session is announced under its own engine', () => {
  /**
   * WHY THIS DRIVES A WHOLE HOST OVER A REAL CORPUS instead of calling the
   * bookkeeping directly.
   *
   * The defect it pins was live for a phase WITH a green test beside it.
   * `src/bridge/diagnostics.test.ts` records a `sessionRemoved` sample
   * carrying `engine: 'opencode'` and asserts the line it formats - and it
   * passes, because the sample is written by hand. It proves the CHANNEL
   * honours an engine. Nothing proved the HOST supplies one, and the host was
   * supplying the literal 'cc' for all three.
   *
   * That is the D4 shape exactly: a test that stands in for a wiring which
   * does not exist, by passing in the value the product never passes. The
   * only assertion that cannot be satisfied that way is one where the engine
   * reaches the line the way production sends it - so the session here is a
   * real Codex thread, read by the real engine, announced by the real host.
   */
  it('reads `session removed codex <id>` for a Codex session that goes away', async () => {
    const root = await stageCodexRoot(false);
    const { cwd, sessionId } = await codexBaselineRoot(root);
    const sink = collectingSink();
    const poll = manualPollTrigger();

    const host = await startHostOnFreePort((port) =>
      trackHost(
        new AgentDeckHost({
          workspacePath: cwd,
          projectsRoot: CAPTURED_ROOT,
          settings: settings({ port }),
          tickMs: 0,
          nonce: 'AAAAAAAA',
          createPanel: () => fakePanel().surface,
          onEmission: () => {},
          createDiagnosticsSink: sink.factory,
          codex: { root, pollTrigger: poll.trigger },
        }),
      ),
    );
    host.dataPath.pump();

    // DISCOVERY FIRST, and asserted rather than assumed: a removal line for a
    // session that was never announced would be a different bug wearing the
    // same output, and the assertion below would not tell them apart.
    const discovered = sink.lines.filter((l) => l.includes(`session discovered`));
    expect(
      discovered.some((l) => l.endsWith(`session discovered codex ${sessionId}`)),
      `the Codex session was never announced; lines: ${discovered.join(' | ')}`,
    ).toBe(true);

    // Now take the session away at the source - the ONE transcript the engine
    // reads - and let the engine re-read. This is removal as a user causes it,
    // not a hand-built emission with a session omitted.
    //
    // THE WHOLE `sessions/` TREE IS NOT DELETED, and the first draft of this
    // test did exactly that and saw no removal line at all. Removing the tree
    // makes the root read DEGRADED, and a degraded read deliberately keeps the
    // last good content rather than blanking the deck (G3: refuse, do not
    // guess). That is correct product behaviour and it is not this item's
    // subject - so the fixture is emptied of transcripts while remaining a
    // readable root, which is the state a real deleted session leaves behind.
    // The path under `sessions/` is YYYY/MM/DD of the capture, so it is walked
    // rather than written down: a hard-coded date is a test that breaks on the
    // next harvest for a reason that has nothing to do with what it measures.
    // (The first draft wrote 2026/09/03; the corpus is 2026/09/02.)
    const transcripts = await findTranscripts(join(root, 'sessions'));
    expect(transcripts.length, 'the fixture must have a transcript to remove').toBeGreaterThan(0);
    for (const file of transcripts) await rm(file, { force: true });

    // The content re-read is asynchronous. Poll the engine's own counter
    // rather than sleeping: a fixed wait is a test that passes or fails by CPU
    // load, which this repository has already been bitten by.
    // TWO THINGS HAVE TO HAPPEN, and only waiting for the second one works.
    // The content re-read is asynchronous, and the EMISSION that follows it is
    // scheduled rather than synchronous - `#recordEmission` is driven off the
    // emission, which is the point (a session the deck shows and one the
    // diagnostics announce are then the same set). An earlier draft waited on
    // `contentReads` and asserted straight after: the engine had correctly
    // dropped the session, `codex.sessions()` was already 0, and no line had
    // been written because no emission had been made yet.
    //
    // Polled rather than slept on: a fixed wait is a test that passes or fails
    // by CPU load, which this repository has been bitten by before.
    const reads = host.dataPath.codex.diagnostics.contentReads;
    const emissions = host.dataPath.diagnostics.emissions;
    poll.fire();
    // The loop waits for THE OUTCOME, not for a counter, and the difference
    // bit once already: `#contentReads` increments at the TOP of the read, so
    // it moves while the read is still in flight and an emission from that
    // same tick still carries the old content. Waiting on a removal line is
    // both simpler and not a race - and it is not a way of making the test
    // pass, because a product that never writes the line simply exhausts the
    // loop and fails the assertion below, which is where the evidence is.
    for (let i = 0; i < 400; i += 1) {
      if (sink.lines.some((l) => l.includes('session removed'))) break;
      host.dataPath.pump();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(
      host.dataPath.codex.diagnostics.contentReads,
      'the Codex engine never re-read after the transcript was removed',
    ).toBeGreaterThan(reads);
    expect(
      host.dataPath.codex.sessions(),
      'the Codex engine still holds the session whose transcript is gone',
    ).toStrictEqual([]);
    expect(
      host.dataPath.diagnostics.emissions,
      'no emission followed the removal, so nothing could have been announced',
    ).toBeGreaterThan(emissions);

    const removed = sink.lines.filter((l) => l.includes(`session removed`));
    expect(
      removed,
      'exactly one removal line, for the session that went away',
    ).toHaveLength(1);
    // THE WHOLE POINT: `codex`, not `cc`. Before DoD 5.0a this read
    // `session removed cc <id>` because `#announced` was a Set of ids and the
    // engine had been discarded by the time the removal was detected.
    expect(removed[0]).toMatch(/ session removed codex /);
    expect(removed[0]).toContain(sessionId);
    expect(removed[0], `a Codex removal must not be labelled cc`).not.toMatch(
      / session removed cc /,
    );
  });

  /**
   * The composite key, from the other side.
   *
   * `#announced` is keyed by `(engine, id)` rather than by id, so two engines
   * minting the same id cannot suppress one another. This asserts the key is
   * a pair by asserting the FUNCTION of a pair, which is the only part of it
   * that is observable from outside.
   */
  it('announces the same id under two engines as two separate sessions', async () => {
    const source = readFileSync(
      fileURLToPath(new URL('./extension.ts', import.meta.url)),
      'utf8',
    );
    // The removal path reads the engine off what was ANNOUNCED. A reader who
    // "simplifies" this back to a Set of ids reintroduces the defect, and the
    // test above would still pass for a single-engine deck - so the shape is
    // pinned here too.
    expect(source).toContain(
      'readonly #announced = new Map<string, { id: string; engine: DiagnosticsEngine }>();',
    );
    expect(source, 'the removal line must not hard-code an engine').not.toContain(
      "kind: 'sessionRemoved', sessionId: id, engine: 'cc'",
    );
  });
});

// ---------------------------------------------------------------------------
// DoD 5.0b - each hook tap reports its OWN health
// ---------------------------------------------------------------------------

describe('DoD 5.0b - the Codex tap has a health of its own', () => {
  /**
   * WHY BOTH DIRECTIONS, and why the item insisted on it.
   *
   * A one-directional test - "a silent Codex tap degrades Codex cells" - is
   * satisfied by a banner that is ALWAYS ON. The second direction is what
   * separates a working channel from a stuck one, and the third (a silent
   * CLAUDE CODE tap must not degrade Codex) is the D2 defect itself: a flag
   * about one engine rendered against another.
   *
   * These read the emission rather than the rendered panel because the
   * emission is where the two values are SOURCED, and sourcing is what D2 got
   * wrong. The rendering half is pinned in `webview/deck.test.ts`.
   */
  /** POST one hook payload to the listener, exactly as a real hook does. */
  async function postHook(port: number, payload: unknown): Promise<number> {
    const body = Buffer.from(JSON.stringify(payload), `utf8`);
    return new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: `127.0.0.1`,
          port,
          path: `/event`,
          method: `POST`,
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': body.length,
            connection: `close`,
          },
        },
        (res) => {
          res.resume();
          res.on(`end`, () => resolve(res.statusCode ?? 0));
        },
      );
      req.on(`error`, reject);
      req.end(body);
    });
  }

  /** The real captured Codex hook payloads - the `.raw` wire bodies. */
  async function codexPayloads(): Promise<Record<string, unknown>[]> {
    const stream = await readFile(
      fileURLToPath(
        new URL(
          '../fixtures/codex-0.151.0-alpha.7.2/baseline/hook-stream.jsonl',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    return stream
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as { raw: Record<string, unknown> }).raw);
  }

  /**
   * A host with BOTH hook-driven engines live: a real Claude Code workspace
   * (so `ccEnabled` is true and the CC liveness engine is running) and a
   * staged Codex root beside it.
   *
   * Both taps therefore start silent, which is the only starting point from
   * which "one of them went quiet" is a statement about one of them.
   */
  async function bothEnginesHost(): Promise<{
    host: AgentDeckHost;
    port: number;
    seen: DataPathEmission[];
  }> {
    const workspacePath = await capturedWorkspacePath();
    const root = await stageCodexRoot(false);
    let chosen = 0;
    const seen: DataPathEmission[] = [];
    const host = await startHostOnFreePort((port) => {
      chosen = port;
      seen.length = 0;
      return trackHost(
        new AgentDeckHost({
          workspacePath,
          projectsRoot: CAPTURED_ROOT,
          settings: settings({ port }),
          tickMs: 0,
          nonce: 'AAAAAAAA',
          createPanel: () => fakePanel().surface,
          onEmission: (payload: DataPathEmission) => {
            seen.push(payload);
          },
          codex: { root },
        }),
      );
    });
    return { host, port: chosen, seen };
  }

  /** The two taps, as the emission carries them. */
  function taps(
    host: AgentDeckHost,
    seen: DataPathEmission[],
  ): {
    cc: { degraded: boolean; reason?: string };
    codex: { degraded: boolean; reason?: string };
  } {
    host.dataPath.pump();
    const last = seen.at(-1);
    if (last === undefined) throw new Error(`the data path produced no emission`);
    return { cc: last.degraded, codex: last.codexDegraded };
  }

  it('a silent Codex tap degrades CODEX and leaves Claude Code alone', async () => {
    const { host, port, seen } = await bothEnginesHost();

    // Claude Code hears something; Codex hears nothing. The CC payloads are
    // this repository's own captured hook events.
    const ccStream = await readFile(
      fileURLToPath(
        new URL('../fixtures/hook-events/cc-2.1.234-sessionstart.jsonl', import.meta.url),
      ),
      'utf8',
    );
    const ccLine = ccStream.split(/\r?\n/).filter((l) => l.trim() !== '')[0];
    expect(ccLine, 'the CC hook corpus must carry a payload').toBeDefined();
    const ccEvents = JSON.parse(ccLine ?? '{}') as Record<string, unknown>;
    expect(await postHook(port, ccEvents), 'the listener accepted the CC payload').toBe(200);

    const { cc, codex } = taps(host, seen);
    expect(codex.degraded, `a Codex tap that has heard nothing is degraded`).toBe(true);
    expect(codex.reason).toBe('noHookEvents');
    // THE POINT: the two are independent. A Codex banner must not be the price
    // of a healthy Claude Code one.
    expect(cc.degraded, `Claude Code heard an event and is not degraded`).toBe(false);
  });

  it('a silent Claude Code tap does NOT degrade Codex', async () => {
    const { host, port, seen } = await bothEnginesHost();

    // The mirror image, and the one that is D2 itself. Codex hears a real
    // captured payload; Claude Code hears nothing at all.
    const payloads = await codexPayloads();
    expect(payloads.length, `the corpus must carry a Codex hook payload`).toBeGreaterThan(0);
    expect(await postHook(port, payloads[0]), 'the listener accepted the Codex payload').toBe(200);

    const { cc, codex } = taps(host, seen);
    expect(cc.degraded, `Claude Code has heard nothing and is degraded`).toBe(true);
    expect(cc.reason).toBe('noHookEvents');
    // Before 5.0b there was no second value to be right: the panel had one
    // flag, and it was this one.
    expect(codex.degraded, `Codex heard its own event and is NOT degraded`).toBe(false);
    expect(codex.reason).toBeUndefined();
  });

  it('the Codex tap is quiet about an engine that is not running', async () => {
    // No Codex root at all. `noHookEvents` would be TRUE and MEANINGLESS - the
    // tap has heard nothing because there is no Codex on this machine, which
    // is the exact shape of the mistake `#degradedState` documents for the CC
    // half when `ccEnabled` is false.
    const workspacePath = await capturedWorkspacePath();
    const absentRoot = join(await makeTempDir(), 'no-such-.codex');
    const seen: DataPathEmission[] = [];
    const host = await startHostOnFreePort((port) =>
      trackHost(
        new AgentDeckHost({
          workspacePath,
          projectsRoot: CAPTURED_ROOT,
          settings: settings({ port }),
          tickMs: 0,
          nonce: 'AAAAAAAA',
          createPanel: () => fakePanel().surface,
          onEmission: (payload: DataPathEmission) => {
            seen.push(payload);
          },
          codex: { root: absentRoot },
        }),
      ),
    );

    const { codex } = taps(host, seen);
    expect(host.dataPath.codex.diagnostics.enabled, `the control: Codex is off`).toBe(false);
    expect(codex.degraded, `an engine that is not running is not degraded`).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// v0.7.0 DoD 1b.10 — a data root that appears AFTER activation
// ---------------------------------------------------------------------------
//
// The 1b.8 smoke found this in the Claude Code half, where it is the ORDINARY
// case: Claude Code creates projects/<slug>/ on the first session in a
// workspace, so a window opened before that ran watched a path that did not
// exist and never looked again. The user asked whether the other two engines
// have the same shape. They do, and it was written into the code as a
// deliberate design: "Read once. Present -> start polling. Absent -> off",
// with an early return that armed nothing.
//
// The remedy differs from the Claude Code one on purpose. There the parent is
// projects/, which holds nothing but project directories, so a narrow watch is
// right. Here the parent is the user home directory, and watching a home
// directory to learn whether one folder appeared is not a proportionate thing
// for a read-only observer to do — so these two get a cheap existence probe on
// a slow cadence instead. ABSENT_ROOT_REPROBE_MS carries that reasoning.

describe('1b.10 — an engine root that appears after activation', () => {
  it('OpenCode: an absent store that appears is picked up without a reload', async () => {
    const dir = await makeTempDir();
    const sink = captureLog();
    const poll = manualPollTrigger();
    let changes = 0;

    // The store does NOT exist yet. This is a machine where OpenCode has
    // never run, which is the normal case rather than a fault.
    const dbPath = join(dir, 'opencode', 'opencode.db');
    const path = new OpenCodeEnginePath({
      workspacePaths: ['c:\\ws\\anything'],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: () => {
        changes += 1;
      },
      dbPath,
      log: sink.log,
      now: () => 1_000,
      pollTrigger: poll.trigger,
      walWatchFactory: () => ({ close: () => {} }),
    });

    try {
      path.start();
      expect(path.diagnostics.enabled).toBe(false);
      expect(path.diagnostics.absentLogs).toBe(1);
      expect(path.diagnostics.lateStarts).toBe(0);
      // The probe IS armed, at the slow cadence and not the poll cadence.
      expect(poll.registrations).toStrictEqual([ABSENT_ROOT_REPROBE_MS]);

      // A probe while it is still absent changes nothing and says nothing.
      poll.fire();
      expect(path.diagnostics.enabled).toBe(false);
      expect(path.diagnostics.lateStarts).toBe(0);
      expect(sink.lines).toHaveLength(1);

      // Now OpenCode runs for the first time.
      const real = copyCorpus(smallestCorpus(), dir);
      await mkdir(join(dir, 'opencode'), { recursive: true });
      await copyFile(real, dbPath);

      poll.fire();
      expect(path.diagnostics.enabled).toBe(true);
      expect(path.diagnostics.lateStarts).toBe(1);
      // The deck is told, rather than left stale until something else emits.
      expect(changes).toBeGreaterThan(0);
      // STILL ONE LINE: a window that recovers must not also nag.
      expect(sink.lines).toHaveLength(1);
    } finally {
      path.dispose();
    }
  });

  it('OpenCode: dispose stops the probe, so a machine without it leaks no timer', async () => {
    const dir = await makeTempDir();
    const poll = manualPollTrigger();
    const path = new OpenCodeEnginePath({
      workspacePaths: ['c:\\ws\\anything'],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: () => {},
      dbPath: join(dir, 'nothing', 'opencode.db'),
      log: captureLog().log,
      now: () => 1_000,
      pollTrigger: poll.trigger,
      walWatchFactory: () => ({ close: () => {} }),
    });
    path.start();
    expect(poll.stops()).toBe(0);
    path.dispose();
    // The probe is armed on exactly the machines that have no OpenCode, so
    // leaking it would leave a timer running for the whole session on every
    // window belonging to a user who does not use this engine at all.
    expect(poll.stops()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (9) The host <-> stats seam — v0.7.0 Phase 3, DoD 3.7
// ---------------------------------------------------------------------------

/**
 * THE STATS LAYER, REACHED THE WAY PRODUCTION REACHES IT.
 *
 * ## Why this block exists, and it is not because anything was failing
 *
 * `phase-verifier` audited Phase 3 at `784aeac` and found the whole
 * `AgentDeckHost` <-> `StatsPipeline` seam unguarded: **four separate
 * mutations of the host wiring passed with 131 tests green.** `activate()`
 * could stop passing `statsDir`; the host could stop calling `#observeStats`;
 * the two counters could be hard-coded to zero; and every one of the four
 * settings could be ignored. Each of those is the whole feature, and the suite
 * had nothing to say about any of them.
 *
 * The cause is the recorded D4 shape one layer out: every stats test built a
 * `StatsPipeline` BY HAND, so all of them proved the pipeline honours values
 * the product was never shown to send it. CLAUDE.md's own rule, written after
 * the last time this happened, is *"for any prop that changes user-visible
 * output, one test must reach it the way production does"* — and a store
 * nobody writes to is as user-visible as it gets.
 *
 * ## So this drives the real thing, end to end
 *
 * Real committed corpus -> real `ProjectWatcher` -> real `graftSession` ->
 * real `SessionModel` -> real emission -> real `StatsPipeline` -> real
 * `StatsStore` -> **a real file on disk**, which the assertions read back with
 * `readFileSync`. Nothing in this block constructs a pipeline or a store.
 *
 * ## THE TRIGGER IS THE IDLE FLUSH, AND FINDING OUT WHY IS THE POINT
 *
 * The first draft of this block set the clock ten days ahead, on the reasoning
 * that `liveness.ts`'s table reads `not running + stale -> 'ended'` and the
 * committed transcripts are finished. **Every assertion came back with an empty
 * store**, and the reason is a fact about the product that the phase's plan
 * does not state:
 *
 *   `LivenessEngine.isRunning` (`src/model/liveness.ts:712`) falls back, for a
 *   session with ZERO hook events, to `hasStopEntry !== true` — spec C4's
 *   "absence of a Stop entry means still running, unknown is not an ending".
 *   And `src/watch/inference.ts` deliberately OMITS `hasStopEntry`, because no
 *   committed transcript contains an in-transcript Stop marker.
 *
 * So `hasStopEntry` is permanently `undefined`, `isRunning` is permanently
 * `true`, and **a Claude Code session observed without hook events can only
 * ever be `live` or `idle` — never `ended`.** The existing carry-forward A test
 * in this file shows the same thing from the other side: 121 s after the last
 * append, with no hooks, it asserts `idle` rather than `ended`.
 *
 * That is not a defect and nothing here works around it. It is exactly why the
 * emit trigger is `ended` **OR** an idle flush: for a user who has not pasted
 * the hook block, the flush is the only trigger there will ever be, and without
 * it that user would have no history at all. A session WITH hook events reaches
 * `ended` normally, through the `running` branch above.
 *
 * These tests therefore drive the flush, which is the production path for the
 * corpus they use. `agentDeck.stats.idleFlushMs` is set to 1 ms so the real
 * scheduler fires it immediately — the harness builds `AgentDeckSettings`
 * directly and so is not bound by `readSettings`'s 60 s floor, which is a
 * bound on what a USER may type.
 */
describe('the host writes stats records through the real data path (DoD 3.7)', () => {
  const previousRoot = process.env['CLAUDE_PROJECTS_ROOT'];

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['CLAUDE_PROJECTS_ROOT'];
    else process.env['CLAUDE_PROJECTS_ROOT'] = previousRoot;
  });

  /** Long enough that a flush cannot happen inside a `waitForFlush`. */
  const NEVER_FLUSH_MS = 3_600_000;

  /** Let the real scheduler fire a 1 ms timer, then let its write land. */
  async function waitForFlush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  interface StatsHost {
    host: AgentDeckHost;
    statsDir: string;
    /** The staged, writable projects root these sessions were read from. */
    projectsRoot: string;
    /** Its one slug directory. */
    slugDir: string;
    /** The panel the host will create, so its traffic is readable. */
    panel: FakePanel;
    /** Everything the consumer DOWNSTREAM of the stats layer received. */
    emissions: DataPathEmission[];
  }

  async function startWithStore(
    overrides: Partial<AgentDeckSettings> = {},
    options: { realProcessStart?: boolean; grow?: boolean } = {},
  ): Promise<StatsHost> {
    const workspacePath = await capturedWorkspacePath();
    const { root: projectsRoot, slugDir } = await stageCapturedRoot();
    const statsDir = join(await makeTempDir(), 'globalStorage', STORE_DIR_NAME);
    // A retried bind must not inherit the lost attempt's panel: `onFreePort`
    // can construct the host more than once, and the panel is per attempt.
    let panel = fakePanel();
    const emissions: DataPathEmission[] = [];
    const host = await startHostOnFreePort((port) => {
      panel = fakePanel();
      emissions.length = 0;
      return trackHost(
        new AgentDeckHost({
          workspacePath,
          projectsRoot,
          settings: settings({ port, 'stats.idleFlushMs': 1, ...overrides }),
          statsDir,
          // DoD 4.11's provenance gate, opted out DELIBERATELY: every session
          // in the captured corpus predates any real activation stamp, so under
          // the gate none of them writes anything. These tests are about the
          // settings and the seam, not about the gate — the gate has its own
          // test below, which drives the real stamp in both directions.
          ...(options.realProcessStart === true ? {} : { statsProcessStart: 0 }),
          tickMs: 0,
          createPanel: () => panel.surface,
          onEmission: (payload) => {
            emissions.push(payload);
          },
        }),
      );
    });
    await waitForFlush();

    /*
     * THE SESSIONS GROW, AND WITHOUT THIS EVERY TEST BELOW WOULD SEE AN EMPTY
     * STORE (DoD 4.11c, user ruling 2026-09-10).
     *
     * The gate promotes a session on a transcript's mtime only once the file has
     * gained bytes since this process first stat'd it. The captured corpus is
     * static, so on its own it is history — correctly, and that is what
     * `grow: false` below is for. Everything else in this describe is about the
     * settings, the seam and the counters, so the harness does what a live
     * session does and appends.
     *
     * AFTER the host has started, deliberately: the baseline is the first stat,
     * so growing before it would leave nothing to have grown.
     */
    if (options.grow !== false) {
      await growSessions(slugDir);
      host.dataPath.pump();
      await waitForFlush();
    }
    return { host, statsDir, panel, emissions, projectsRoot, slugDir };
  }

  /** Every line in every store file, parsed. Reads DISK, not the store object. */
  function linesOnDisk(statsDir: string): Record<string, unknown>[] {
    if (!existsSync(statsDir)) return [];
    const out: Record<string, unknown>[] = [];
    for (const name of readdirSync(statsDir).sort()) {
      for (const line of readFileSync(join(statsDir, name), 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        out.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
    return out;
  }

  it('a real emission puts one record per session on disk', async () => {
    const { host, statsDir } = await startWithStore();

    // The subject first: this is a test about the corpus reaching the store,
    // and it means nothing if the corpus never reached the deck.
    const sessionIds = await sessionIdsIn(await capturedSlugDir());
    expect(sessionIds.length).toBeGreaterThan(0);
    expect(host.dataPath.diagnostics.grafts).toBeGreaterThan(0);

    const written = linesOnDisk(statsDir);
    expect(
      written.map((r) => r['sessionId']).sort(),
      'the store does not hold a record for every observed session',
    ).toStrictEqual(sessionIds);

    // And they are RECORDS, not placeholders: full coverage, the right engine,
    // and the stamp the host's own injected clock produced.
    for (const record of written) {
      expect(record['coverage']).toBe('full');
      expect(record['engine']).toBe('cc');
      expect(typeof record['derivedAt']).toBe('number');
      // BOUND to the constant, not written out: this literal read `1` and
      // went stale the moment v0.8.0 bumped the version, which is this
      // repository's most-recorded defect in its cheapest form.
      expect(record['statsSchemaVersion']).toBe(STATS_SCHEMA_VERSION);
    }
    expect(host.stats?.store.appended).toBe(sessionIds.length);
  });

  it('repeated pumps do not re-append: the emission path is idempotent', async () => {
    // The deck pumps on a liveness tick whether or not anything changed, so
    // without this a finished session would gain a record every few seconds
    // for as long as the window stayed open.
    const { host, statsDir } = await startWithStore();
    const first = linesOnDisk(statsDir).length;
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 10; i += 1) host.dataPath.pump();
    expect(linesOnDisk(statsDir)).toHaveLength(first);
  });

  it('activate() is what supplies the directory, and it is under globalStorageUri', async () => {
    // THE MUTATION THIS KILLS: dropping `statsDir` from `activate()`'s host
    // options left 131 tests green. Nothing else in the suite reaches that
    // call, because every other stats test constructs its own store.
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    const workspacePath = await capturedWorkspacePath();
    const globalStorage = await makeTempDir();
    await activateOnFreePort(
      (port) => {
        mock.setWorkspaceFolder(workspacePath);
        mock.setConfig(CONFIG_SECTION, { port });
      },
      globalStorage,
    );

    const host = currentHost();
    expect(host, 'activate() installed no host').not.toBeNull();
    expect(host?.stats, 'activate() built no stats pipeline').toBeDefined();
    expect(host?.stats?.store.dir).toBe(
      resolveStoreDir({ globalStorageUri: { fsPath: globalStorage } }),
    );

    /*
     * AND THE EMISSION REACHED IT, which is the half that makes the path more
     * than a string on an object.
     *
     * Not asserted by reading records: `activate()` reads the REAL settings,
     * so the idle window is the shipped hour and `readSettings` clamps
     * anything under a minute back to it — a floor on what a USER may type,
     * and this test is a user.
     *
     * It used to say "an armed timer is the observable"; DoD 4.11's provenance
     * gate made that wrong and the sentence is replaced rather than left to
     * contradict the assertion below it.
     */
    /*
     * The observable is what the pipeline DERIVED, not what it armed.
     *
     * It used to be `armedTimers > 0`, and DoD 4.11's provenance gate made that
     * the wrong question: this corpus is historical, so a correct host arms
     * nothing for it. `liveRecords()` is populated on every observe regardless
     * of flush policy, so it still says "the production wiring handed this
     * pipeline a session" — which is the claim — and it says it without
     * depending on whether that session is one the store should keep.
     */
    expect(
      host?.stats?.liveRecords().length,
      'activate() wired a store the data path never reaches',
    ).toBeGreaterThan(0);
    expect(host?.dataPath.diagnostics.grafts).toBeGreaterThan(0);
    await deactivate();
  });

  it('Clear Stats History empties the panel in the SAME action — no flush, no pump, no other event (DoD 4.14)', async () => {
    /*
     * Found by the 4.9 smoke: the command deleted the directory and the Stats
     * view kept every record, so the user cleared twice. The cause was the
     * re-read cursor: the host re-reads the store only when `store.appended`
     * has moved, and a clear appends nothing. Measured before the fix: the
     * command posted NO `statsStore` at all.
     *
     * Through `activate()`, so the command is the registered one and the host is
     * the one it reaches — the only production path by which a clear can tell a
     * panel anything. The webview half (one empty `statsStore` is enough to
     * show the empty state) is `webview/stats/stats-view.test.ts`'s.
     */
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    const workspacePath = await capturedWorkspacePath();
    const globalStorage = await makeTempDir();
    const dir = resolveStoreDir({ globalStorageUri: { fsPath: globalStorage } });

    // A real history on disk BEFORE activation, from committed goldens, so the
    // panel's first publish reads it the way it would read a user's.
    const goldens = fileURLToPath(new URL('../fixtures/golden/stats', import.meta.url));
    const seeded = new StatsStore({ dir, enabled: true, retentionDays: 90 });
    const names = readdirSync(goldens).filter((n) => n.includes('-synthetic-0') && n.endsWith('.json')).sort();
    for (const name of names.slice(0, 2)) {
      const record = JSON.parse(readFileSync(join(goldens, name), 'utf8')) as Record<string, unknown>;
      seeded.appendRecord({ ...record, derivedAt: Date.now() } as never);
    }
    expect(seeded.readRecords()).toHaveLength(2);

    await activateOnFreePort(
      (port) => {
        mock.setWorkspaceFolder(workspacePath);
        mock.setConfig(CONFIG_SECTION, { port });
      },
      globalStorage,
    );
    const host = currentHost();
    expect(host, 'activate() installed no host').not.toBeNull();
    host?.open();
    const posted = mock.panels[0]?.webview.posted ?? [];
    type StoreMessage = { type: 'statsStore'; records: unknown[]; enabled: boolean };
    const stores = (messages: readonly unknown[]): StoreMessage[] =>
      messages.filter(
        (m): m is StoreMessage => (m as { type?: unknown }).type === 'statsStore',
      );
    expect(
      stores(posted).at(-1)?.records,
      'the panel never received the seeded history, so the clear proves nothing',
    ).toHaveLength(2);

    // THE ACTION. Nothing between it and the assertion: no pump, no timer, no
    // second command.
    const before = posted.length;
    mock.answerWarningWith(CLEAR_STATS_CONFIRM);
    await mock.runCommand(CLEAR_STATS_COMMAND);
    expect(existsSync(dir), 'the clear did not remove the directory').toBe(false);

    const sent = stores(posted.slice(before));
    expect(sent, 'Clear Stats History told the panel nothing').toStrictEqual([
      { type: 'statsStore', records: [], enabled: true },
    ]);
    await deactivate();
  });

  it('the four settings reach the store, not just readSettings', async () => {
    // THE MUTATION THIS KILLS: replacing all four `options.settings[...]`
    // reads with literals (`enabled: true`, `retentionDays: 1`,
    // `idleFlushMs: 1`, `pricing: new Map()`) left 130 tests green.
    const disabled = await startWithStore({ 'stats.enabled': false });
    expect(disabled.host.stats?.store.enabled).toBe(false);
    // Disabled means NOTHING on disk, reached by a real emission rather than
    // by calling `appendRecord` and watching it decline.
    expect(existsSync(disabled.statsDir)).toBe(false);
    expect(linesOnDisk(disabled.statsDir)).toStrictEqual([]);

    // The control, on the same path: with the setting on, records appear.
    const enabled = await startWithStore({ 'stats.enabled': true });
    expect(enabled.host.stats?.store.enabled).toBe(true);
    expect(linesOnDisk(enabled.statsDir).length).toBeGreaterThan(0);

    /*
     * AND `idleFlushMs` IS READ RATHER THAN ASSUMED.
     *
     * The mutation this half kills replaced the settings reads with literals,
     * one of which was `idleFlushMs: 1` — which every test above would still
     * pass, because they all want a fast flush. So this one asks for the
     * OPPOSITE: an hour, over the same corpus and the same wait, must produce
     * nothing. A pipeline ignoring the setting writes here; one reading it
     * does not.
     */
    const slow = await startWithStore({ 'stats.idleFlushMs': NEVER_FLUSH_MS });
    await waitForFlush();
    expect(
      linesOnDisk(slow.statsDir),
      'a one-hour idle window flushed inside 50 ms',
    ).toStrictEqual([]);
    // The control on that emptiness: the pipeline DID see the sessions and is
    // holding timers for them, so the empty store is a pending flush rather
    // than an emission that never arrived.
    expect(slow.host.stats?.armedTimers).toBeGreaterThan(0);
  });

  it('a window with NO store still answers the Stats view, rather than leaving it loading', async () => {
    /*
     * `phase-verifier` defect 15, 2026-09-09. `statsDirFor` returns undefined for
     * a window with no `globalStorageUri` — it logs "the local stats history is
     * disabled for this window" — so `this.stats` is undefined, and
     * `#publishStats` returned before sending anything. DoD 4.12 then made the
     * webview wait for a `statsStore` message before it would say anything about
     * the history, so that window's Stats view sat on "Reading the stored
     * history…" FOREVER: the exact state the loading flag was added to prevent.
     *
     * An empty, disabled store is the true answer for such a window, and it is
     * now sent.
     */
    const workspacePath = await capturedWorkspacePath();
    let panel = fakePanel();
    const host = await startHostOnFreePort((port) => {
      panel = fakePanel();
      return trackHost(
        new AgentDeckHost({
          workspacePath,
          projectsRoot: CAPTURED_ROOT,
          settings: settings({ port }),
          // No `statsDir`: the window has no globalStorageUri.
          tickMs: 0,
          createPanel: () => panel.surface,
          onEmission: () => {
            // Nothing: this test reads what the PANEL was sent.
          },
        }),
      );
    });
    await waitForFlush();
    host.open();
    await waitForFlush();

    expect(host.stats, 'this test is about a host with no pipeline').toBeUndefined();
    const stored = panel.posted.filter(
      (m) => (m as { type?: unknown }).type === 'statsStore',
    ) as { records: unknown[]; enabled: boolean }[];
    expect(stored.length, 'the Stats view was never told there is no history').toBeGreaterThan(0);
    expect(stored[0]?.enabled).toBe(false);
    expect(stored[0]?.records).toStrictEqual([]);
  });

  it('the provenance stamp is the REAL clock, and history reaches no store (DoD 4.11)', async () => {
    /*
     * THE MUTATION THIS KILLS: replacing `options.statsProcessStart ?? clock()`
     * with `0` — i.e. shipping the flood back. Every other stats test passes
     * `statsProcessStart: 0` on purpose, so without this one the production
     * default has exactly one assignment site and nothing drives it. That is
     * the shape this repository has shipped three times (`enabledEngines`,
     * `degradedByEngine`, the auto-fit attributes), and it is only ever found
     * by mutating the WIRING.
     *
     * The captured corpus is REPLAYED and nobody appends to it, so against a
     * stamp taken now every session in it is history — the same situation as the
     * user's 28 rediscovered sessions, on the real path.
     *
     * `grow: false` is what makes it history under DoD 4.11c, and it is the
     * honest arm: the harness's default appends a real entry to every transcript
     * after start, because a corpus that never grows can never be recorded once
     * an mtime alone stops counting. History is exactly the corpus nobody wrote
     * to, so this arm must be the one that does not write.
     */
    const real = await startWithStore(
      { 'stats.enabled': true },
      { realProcessStart: true, grow: false },
    );
    expect(real.host.stats?.store.enabled).toBe(true);

    // THE VACUITY CONTROL, and it is the assertion that makes the next one mean
    // something: the emission DID reach the pipeline. Without it an empty store
    // passes just as well on a host that never wired the pipeline at all — the
    // counter-polarity lesson this repository has recorded twice.
    expect(
      real.host.stats?.liveRecords().length,
      'the pipeline never saw a session, so the empty store proves nothing',
    ).toBeGreaterThan(0);

    expect(linesOnDisk(real.statsDir), 'a historical session reached the store').toStrictEqual([]);
    expect(real.host.stats?.armedTimers, 'history armed a flush').toBe(0);

    // ...and the same path, same corpus, with a stamp the corpus postdates:
    // records appear. So the empty store above is the GATE and not the wiring.
    const observed = await startWithStore({ 'stats.enabled': true });
    expect(linesOnDisk(observed.statsDir).length).toBeGreaterThan(0);

    // AND THE 4.11c ARM, on the real stamp this time: the same historical corpus
    // that wrote nothing above writes as soon as somebody APPENDS to it. Without
    // this pair, "history reaches no store" is satisfied by a gate that refuses
    // everything, which is the failure mode with no user-visible symptom until
    // the Stats view is permanently empty.
    const resumed = await startWithStore(
      { 'stats.enabled': true },
      { realProcessStart: true, grow: false },
    );
    expect(linesOnDisk(resumed.statsDir), 'history, before the append').toStrictEqual([]);
    await growSessions(resumed.slugDir);
    resumed.host.dataPath.pump();
    await waitForFlush();
    expect(
      linesOnDisk(resumed.statsDir).length,
      'an appended transcript did not reach the store',
    ).toBeGreaterThan(0);
  });

  it('Claude Code: touch writes NOTHING, append writes a record', async () => {
    /*
     * The real path, the real corpus, the REAL activation stamp — the same
     * arrangement as the 4.11 provenance test, driven through the one signal
     * 4.11c is about. `grow: false` because this test does its own writing.
     */
    const { host, statsDir, slugDir } = await startWithStore(
      { 'stats.enabled': true },
      { realProcessStart: true, grow: false },
    );

    // The baseline: history, and the pipeline has seen it (the vacuity control
     // the 4.11 test also carries — an empty store proves nothing about a
     // pipeline that never ran).
    expect(
      host.stats?.liveRecords().length,
      'the pipeline never saw a session, so the empty store proves nothing',
    ).toBeGreaterThan(0);
    expect(linesOnDisk(statsDir)).toStrictEqual([]);

    // A TOUCH: every transcript's mtime moves to now, no byte changes. This is
    // the arm that was writing 21 sessions in a 1.4 s burst.
    await touchSessions(slugDir, Date.now());
    for (let i = 0; i < 5; i += 1) host.dataPath.pump();
    await waitForFlush();
    expect(
      linesOnDisk(statsDir),
      'a touched transcript reached the store — the mtime door is open',
    ).toStrictEqual([]);
    expect(host.stats?.armedTimers, 'a touched transcript armed a flush').toBe(0);

    // AN APPEND: bytes arrive. THAT is activity, and one record per session lands.
    const grown = await growSessions(slugDir);
    host.dataPath.pump();
    await waitForFlush();
    expect(
      linesOnDisk(statsDir).length,
      'an appended transcript reached no store',
    ).toBe(grown);
  });

  it('the counters line reports the store, not two zeroes', async () => {
    // THE MUTATION THIS KILLS: hard-coding `statsErrors: 0, storeMalformed: 0`
    // in `counters()` left 131 tests green.
    const { host, statsDir } = await startWithStore();
    expect(host.counters().storeMalformed).toBe(0);

    // Corrupt one line the way a crash mid-append would, then make the host
    // read its own store. `storeMalformed` is a READ-side count, so nothing
    // moves until something reads.
    const files = readdirSync(statsDir);
    expect(files.length).toBeGreaterThan(0);
    appendFileSync(join(statsDir, files[0] as string), 'not a record\n', 'utf8');
    expect(host.stats?.store.readRecords().length).toBeGreaterThan(0);

    expect(host.stats?.store.malformed).toBe(1);
    expect(
      host.counters().storeMalformed,
      'counters() does not read the store it is reporting on',
    ).toBe(1);
    // And the line the user copies carries it.
    expect(formatCounters(host.counters(), '2026-09-08T12:00:00.000Z')).toContain(
      'storeMalformed=1',
    );
  });

  it('G2: a stats layer that throws does not stop the deck (host level)', async () => {
    /*
     * THE MUTATION THIS KILLS: deleting `#observeStats` from the emission
     * callback left 131 tests green — so nothing distinguished "the stats
     * layer is isolated" from "the stats layer is not connected".
     *
     * Both halves are asserted here, in that order, because either alone is
     * satisfiable by the wrong product: the pipeline IS reached (its store
     * filled from a real emission), and a pipeline that throws leaves the
     * panel still receiving.
     */
    const { host, statsDir, panel, emissions } = await startWithStore();
    // Half one: the layer IS connected. Without this the rest of the test
    // passes just as well on a host that never calls the pipeline at all,
    // which is the distinction the audit found nothing was making.
    expect(linesOnDisk(statsDir).length).toBeGreaterThan(0);

    const pipeline = host.stats;
    expect(pipeline).toBeDefined();
    if (pipeline === undefined) return;

    expect(host.open()).not.toBeNull();
    const postedBefore = panel.posted.length;
    expect(postedBefore).toBeGreaterThan(0);
    const emissionsBefore = emissions.length;

    // Make the layer fail as destructively as it can from where it sits.
    const original = pipeline.observe.bind(pipeline);
    (pipeline as unknown as { observe: () => void }).observe = (): never => {
      throw new Error('stats layer exploded');
    };
    try {
      host.dataPath.pump();
      host.dataPath.pump();
    } finally {
      (pipeline as unknown as { observe: typeof original }).observe = original;
    }

    /*
     * Half two: EVERYTHING DOWNSTREAM STILL RAN.
     *
     * The consumer is asserted rather than the panel's message count, and the
     * difference matters. `#observeStats` runs BEFORE `#panel.publish` and
     * before `onEmission`, so a throw that escaped it would take both out —
     * but a pump over an unchanged session legitimately posts NO message,
     * because the bridge sends a diff only when something differs. Counting
     * panel messages would therefore have made this test assert that the deck
     * keeps talking, which is not true of a quiet deck and not what G2 says.
     * The consumer callback fires on every emission regardless.
     */
    expect(
      emissions.length,
      'the emission never reached the consumer past the throwing stats layer',
    ).toBe(emissionsBefore + 2);
    expect(panel.posted.length, 'the panel lost messages it already had').toBeGreaterThanOrEqual(
      postedBefore,
    );
    // The failure is COUNTED, which is what G2 extended requires of it.
    expect(host.counters().statsErrors).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (13) v0.7.0 Phase 4 — the sidebar, the left column, the stats wire (DoD 4.1, 4.6b, 4.6c)
// ---------------------------------------------------------------------------

describe('v0.7.0 Phase 4 — sidebar, ViewColumn.One, and the stats wire', () => {
  const previousRoot = process.env['CLAUDE_PROJECTS_ROOT'];

  afterEach(async () => {
    await deactivate();
    if (previousRoot === undefined) delete process.env['CLAUDE_PROJECTS_ROOT'];
    else process.env['CLAUDE_PROJECTS_ROOT'] = previousRoot;
  });

  /** The CSP `content` of a document, with the per-document nonce blanked. */
  const policyOf = (html: string): string => {
    const match = /Content-Security-Policy" content="([^"]+)"/.exec(html);
    if (match?.[1] === undefined) throw new Error('no CSP meta in the document');
    return match[1].replace(/'nonce-[^']+'/g, "'nonce-X'");
  };

  it('registers every sidebar menu command and the sidebar view ABOVE the activation gates', async () => {
    // No workspace at all: `activate()` returns before building a host, and
    // the front door must already be there.
    resetVscodeMock();
    await activate(extensionContext());
    expect(currentHost()).toBeNull();
    for (const entry of SIDEBAR_MENU) {
      expect(mock.hasCommand(entry.command), entry.command).toBe(true);
    }
    expect(mock.hasViewProvider(SIDEBAR_VIEW_ID)).toBe(true);
  });

  it('the resolved sidebar carries the sidebar root, the same bundle and the same CSP as the panel', async () => {
    resetVscodeMock();
    await activate(extensionContext());
    const view = mock.resolveView(SIDEBAR_VIEW_ID);
    expect(view.webview.html).toContain(`<div id="${SIDEBAR_ROOT_ID}"></div>`);
    expect(view.webview.html).not.toContain(`id="${WEBVIEW_ROOT_ID}"`);
    expect(view.webview.html).toContain(`/${WEBVIEW_SCRIPT_SEGMENTS.join('/')}`);
    // The panel's document, for the comparison: same policy, byte for byte
    // once the nonce is blanked.
    const panelHtml = webviewHtml({
      scriptUri: 'webview://ext/dist/webview/main.js',
      styleUri: 'webview://ext/dist/webview/main.css',
      nonce: 'AAAAAAAA',
      cspSource: view.webview.cspSource,
    });
    expect(policyOf(view.webview.html)).toBe(policyOf(panelHtml));
    expect(policyOf(view.webview.html)).toContain("default-src 'none'");
    // The webview may read `dist/` and nothing else — the panel's own rule.
    expect(view.webview.options).toMatchObject({ enableScripts: true });
  });

  it('a click in the sidebar runs the registered command; an off-menu id runs nothing', async () => {
    resetVscodeMock();
    await activate(extensionContext());
    const view = mock.resolveView(SIDEBAR_VIEW_ID);
    view.fireMessage({ type: 'runCommand', command: OPEN_COMMAND });
    await new Promise((r) => setTimeout(r, 0));
    expect(mock.executed.map((e) => e.command)).toStrictEqual([OPEN_COMMAND]);
    // ...and the REAL handler ran: with no host it explains itself.
    expect(mock.informationMessages).toHaveLength(1);

    view.fireMessage({ type: 'runCommand', command: 'workbench.action.closeWindow' });
    view.fireMessage({ type: 'selectSession', sessionId: 's1' });
    await new Promise((r) => setTimeout(r, 0));
    expect(mock.executed.map((e) => e.command)).toStrictEqual([OPEN_COMMAND]);
  });

  it('agentDeck.openSettings runs the workbench settings command, filtered to this extension', async () => {
    resetVscodeMock();
    await activate(extensionContext());
    await mock.runCommand(OPEN_SETTINGS_COMMAND);
    expect(mock.executed).toStrictEqual([{ command: WORKBENCH_OPEN_SETTINGS, args: [SETTINGS_FILTER] }]);
    expect(SETTINGS_FILTER).toBe('@ext:nvitlam.agent-deck');
  });

  it('DoD 4.6c: the deck opens in ViewColumn.One; even-widths runs once with two groups and not with one', async () => {
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    const workspacePath = await capturedWorkspacePath();

    // ONE group: the column, and no even-widths call.
    await activateOnFreePort((port) => {
      mock.setWorkspaceFolder(workspacePath);
      mock.setConfig(CONFIG_SECTION, { port });
    });
    mock.setEditorGroups(1);
    await mock.runCommand(OPEN_COMMAND);
    expect(mock.panelColumns).toStrictEqual([ViewColumn.One]);
    expect(mock.executed.filter((e) => e.command === EVEN_EDITOR_WIDTHS)).toHaveLength(0);
    // A second open reveals; it creates no panel and evens nothing.
    await mock.runCommand(OPEN_COMMAND);
    expect(mock.panelColumns).toHaveLength(1);
    await deactivate();

    // TWO groups: evened, exactly once, after the panel was created.
    await activateOnFreePort((port) => {
      mock.setWorkspaceFolder(workspacePath);
      mock.setConfig(CONFIG_SECTION, { port });
    });
    mock.setEditorGroups(2);
    await mock.runCommand(OPEN_COMMAND);
    expect(mock.panelColumns).toStrictEqual([ViewColumn.One]);
    expect(mock.executed.filter((e) => e.command === EVEN_EDITOR_WIDTHS)).toHaveLength(1);
    await mock.runCommand(OPEN_COMMAND);
    expect(mock.executed.filter((e) => e.command === EVEN_EDITOR_WIDTHS)).toHaveLength(1);
  });

  it('DoD 4.0/4.1: the panel hears settings first, then the snapshot, then both stats messages', async () => {
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    const workspacePath = await capturedWorkspacePath();
    const storage = await makeTempDir();
    await activateOnFreePort((port) => {
      mock.setWorkspaceFolder(workspacePath);
      mock.setConfig(CONFIG_SECTION, { port, 'canvas.autoFit': false });
    }, storage);
    await mock.runCommand(OPEN_COMMAND);
    const panel = mock.panels[0];
    const types = (panel?.webview.posted ?? []).map((m) => (m as { type: string }).type);
    // Snapshot FIRST — the bridge's oldest invariant — then the settings.
    expect(types[0]).toBe('snapshot');
    expect(types).toContain('settings');
    // v0.8.0 DoD 7.6: `tweaks` rides on the SAME message, so what the panel
    // hears first is both halves. Compared against `readSettings` rather
    // than against four literals, so a default that moves does not have to
    // be copied here.
    expect(panel?.webview.posted[types.indexOf('settings')]).toStrictEqual({
      type: 'settings',
      canvasAutoFit: false,
      tweaks: tweaksOf(readSettings(undefined)),
    });
    expect(types.indexOf('settings')).toBeGreaterThan(types.indexOf('snapshot'));
    expect(types).toContain('statsSnapshot');
    expect(types).toContain('statsStore');
    // The stats wire follows the session wire: a record about a session the
    // webview has not been sent would have nothing to attach to.
    expect(types.indexOf('statsSnapshot')).toBeGreaterThan(types.indexOf('snapshot'));
    const stats = panel?.webview.posted.find((m) => (m as { type: string }).type === 'statsSnapshot') as
      | { records: { sessionId: string; engine: string }[] }
      | undefined;
    expect(stats?.records.length).toBeGreaterThan(0);
    const snapshot = panel?.webview.posted.find((m) => (m as { type: string }).type === 'snapshot') as
      | { sessions: { sessionId: string }[] }
      | undefined;
    // One live record per session on the wire, same ids.
    expect(stats?.records.map((r) => r.sessionId).sort()).toStrictEqual(
      snapshot?.sessions.map((s) => s.sessionId).sort(),
    );
    const store = panel?.webview.posted.find((m) => (m as { type: string }).type === 'statsStore') as
      | { records: unknown[]; enabled: boolean }
      | undefined;
    expect(store?.enabled).toBe(true);

    // A configuration change reaches the renderer live, as a fresh settings message.
    mock.setConfig(CONFIG_SECTION, { port: currentHost()?.dataPath.settings.port, 'canvas.autoFit': true });
    mock.fireConfigurationChange(CONFIG_SECTION);
    // v0.8.0 DoD 7.6: the four tweaks ride on the same message, so the fresh
    // send carries both halves. The configuration set above names neither
    // tweak, so each re-reads as its declared default.
    expect(panel?.webview.posted.at(-1)).toStrictEqual({
      type: 'settings',
      canvasAutoFit: true,
      tweaks: tweaksOf(readSettings(undefined)),
    });
  });

  it('agentDeck.openStats opens the same panel and asks for the stats view', async () => {
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    const workspacePath = await capturedWorkspacePath();
    await activateOnFreePort((port) => {
      mock.setWorkspaceFolder(workspacePath);
      mock.setConfig(CONFIG_SECTION, { port });
    });
    await mock.runCommand(OPEN_STATS_COMMAND);
    expect(mock.panels).toHaveLength(1);
    const posted = mock.panels[0]?.webview.posted ?? [];
    expect(posted).toContainEqual({ type: 'showView', mode: 'stats' });
    // The same panel: a plain open afterwards reveals rather than creating.
    await mock.runCommand(OPEN_COMMAND);
    expect(mock.panels).toHaveLength(1);
  });

  it('a reload re-sends the settings, after asking for the snapshot', () => {
    const panel = fakePanel();
    let snapshots = 0;
    const controller = new PanelController({
      panel: panel.surface,
      nonce: 'AAAAAAAA',
      onNeedsSnapshot: () => {
        snapshots += 1;
      },
    });
    // v0.8.0 DoD 7.6: `tweaks` rides on the SAME message, so what a reload
    // re-sends is both halves or neither. A non-default value here, so a
    // re-send that quietly rebuilt the message from defaults would fail.
    const sent = { canvasAutoFit: false, tweaks: { followNewSessions: true } };
    controller.setSettings(sent);
    expect(panel.posted).toStrictEqual([{ type: 'settings', ...sent }]);
    panel.fireBecameVisible();
    // The pump (asked for first) supplies the snapshot; the settings follow.
    expect(snapshots).toBe(1);
    expect(panel.posted).toStrictEqual([
      { type: 'settings', ...sent },
      { type: 'settings', ...sent },
    ]);
    controller.dispose();
  });

  it('DoD 4.1: a record with an extra string field is dropped and counted; the rest go out', () => {
    const goldenDir = fileURLToPath(new URL('../fixtures/golden/stats/', import.meta.url));
    const names = readdirSync(goldenDir).filter((n) => n.endsWith('.json')).sort();
    const [a, b] = names.map((n) => JSON.parse(readFileSync(join(goldenDir, n), 'utf8')) as Record<string, unknown>);
    if (a === undefined || b === undefined) throw new Error('need two goldens');
    const poisoned = { ...b, unavailable: [...(b['unavailable'] as string[])], note: 'a stray sentence' };

    const panel = fakePanel();
    const controller = new PanelController({ panel: panel.surface, nonce: 'AAAAAAAA' });
    const verdict = controller.publishStats([a as never, poisoned as never], {
      records: [{ ...a, derivedAt: 1 }, poisoned],
      enabled: true,
    });
    expect(verdict.dropped).toBe(2);
    expect(verdict.reasons.every((r) => r.includes("key 'note'"))).toBe(true);
    const snapshot = panel.posted.find((m) => m.type === 'statsSnapshot') as { records: unknown[] } | undefined;
    const store = panel.posted.find((m) => m.type === 'statsStore') as { records: unknown[] } | undefined;
    expect(snapshot?.records).toStrictEqual([a]);
    expect(store?.records).toStrictEqual([a]);
    expect(controller.counters.statsDropped).toBe(2);
    controller.dispose();
  });

  it('the counters line carries statsDropped, appended', () => {
    const line = formatCounters(
      {
        grafts: 0, graftRefusals: 0, graftErrors: 0, malformedLines: 0, unknownFields: 0,
        patchesSent: 0, patchesApplied: 0, patchesFailed: 0, resyncs: 0,
        ccSessions: 0, opencodeSessions: 0, codexSessions: 0,
        relayRole: 'idle', relayFollowers: 0, relayed: 0, relayReceived: 0,
        statsErrors: 0, storeMalformed: 0, statsDropped: 7,
        telemetry: {
          metrics: { accepted: 0, disabled: 0, unmatched: 0, foreign: 0, rejected: { 400: 0, 405: 0, 413: 0, 415: 0 } },
          logs: { accepted: 0, disabled: 0, unmatched: 0, foreign: 0, rejected: { 400: 0, 405: 0, 413: 0, 415: 0 } },
          traces: { accepted: 0, disabled: 0, unmatched: 0, foreign: 0, rejected: { 400: 0, 405: 0, 413: 0, 415: 0 } },
        },
        oversizePartial: 0,
        ccLateEnabled: 0,
      },
      '2026-09-09T00:00:00.000Z',
    );
    // Appended after the two DoD 3.8 fields. It was the LAST field until
    // v0.7.1 DoD 6.4 appended the telemetry half after it — the same
    // append-only rule, so the line up to here is unchanged.
    expect(line).toContain(' storeMalformed=0 statsDropped=7 otel.metrics=');
  });
});

// ---------------------------------------------------------------------------
// Shared by the 4.11b and 4.11c suites below
// ---------------------------------------------------------------------------

/** Well clear of the fixture's own capture dates, so nothing here is accidental. */
const STAMP = Date.parse('2026-09-10T00:00:00.000Z');

interface SplitTrigger {
  trigger: PollTrigger;
  fire: (index: number) => void;
  count: () => number;
  /** Pass as the path's `onChange`, so `contentRead` can see a read land. */
  onChange: () => void;
  /**
   * Fire the CONTENT re-read (registration 1) and resolve once it has been
   * APPLIED — i.e. on the `onChange` `CodexEnginePath.#refresh` calls after its
   * await.
   *
   * This replaced a fixed 50 ms sleep, and the sleep was a defect: run 1 of the
   * 4.13/4.14 closing block failed `growth from the re-baselined size was not
   * seen` while runs 2 and 3 were green. Under full-suite load the read had not
   * landed within 50 ms, so the liveness poll sampled the OLD sizes. A sleep
   * standing in for "the async work finished" is a test that passes or fails by
   * CPU load — this file's recorded class — and the runner's disagreement check
   * is what caught it.
   */
  contentRead: () => Promise<void>;
}

/**
 * A poll trigger whose registrations can be fired ONE AT A TIME.
 *
 * `manualPollTrigger().fire()` runs every registration, and `CodexEnginePath`
 * registers two — the liveness poll and the content re-read. Firing them
 * together cannot tell "the emission read the report" from "the emission read
 * `#threads`", which is exactly the mutation that got past round 3 (163 tests
 * green with `CodexLivenessEngine.latest` never consulted). Which index is
 * which is NOT assumed: the test fires one and asserts the counter that moved.
 */
function splitPollTrigger(): SplitTrigger {
  const runs: (() => void)[] = [];
  const waiting: (() => void)[] = [];
  const trigger: PollTrigger = (run): PollTriggerHandle => {
    runs.push(run);
    return { stop: () => {} };
  };
  const fire = (index: number): void => {
    const run = runs[index];
    expect(run, `no poll registration at index ${String(index)}`).toBeDefined();
    (run as () => void)();
  };
  return {
    trigger,
    fire,
    count: () => runs.length,
    onChange: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
    contentRead: () => {
      // Armed BEFORE the fire: the only onChange a content fire produces comes
      // after the read's own await, and no other trigger is fired meanwhile.
      const applied = new Promise<void>((resolve) => waiting.push(resolve));
      fire(1);
      return applied;
    },
  };
}

/** Every `.jsonl` under a staged root, basename to full path. */
async function transcriptsUnder(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    out.set(entry.name, join(entry.parentPath, entry.name));
  }
  expect(out.size, 'no transcript under the staged root — the layout moved').toBeGreaterThan(0);
  return out;
}

/**
 * Append one real record to a staged transcript and set its mtime.
 *
 * DoD 4.11c: a Codex transcript's mtime counts as activity only once the file
 * has GAINED BYTES since this process first saw it, so every test below that
 * wants an instant has to append. The appended line is the file's own last
 * line, so it parses like every other record in it; the mtime is then set
 * explicitly, because two files touched in the same millisecond cannot show
 * which is later and this suite compares them.
 */
async function growTranscript(file: string, mtimeMs: number): Promise<void> {
  const text = await readFile(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const last = lines.at(-1);
  expect(last, `${file} is empty`).toBeDefined();
  appendFileSync(file, `${String(last)}\n`, 'utf8');
  const when = new Date(mtimeMs);
  await utimes(file, when, when);
}

/** A staged copy of any run's `.codex`, not only `baseline`'s. */
async function stageCodexRun(run: string): Promise<string> {
  const root = join(await makeTempDir(), '.codex');
  await cp(
    fileURLToPath(new URL(`../fixtures/codex-0.151.0-alpha.7.2/${run}/home/.codex`, import.meta.url)),
    root,
    { recursive: true },
  );
  return root;
}

/**
 * Every transcript in a staged root, moved to one instant.
 *
 * EVERY `.jsonl` under the root, not just the root thread's file:
 * `CodexThread.owningFile` is a NAME rather than a path (it answers "which
 * file declared this thread", C5), and the activity instant is the max across
 * a session's threads — so a subagent transcript left at its checkout mtime
 * would promote the session on its own and the arm below would pass for the
 * wrong reason. A staged root is a fresh copy, so this touches nothing shared.
 */
async function stampTranscripts(root: string, atMs: number): Promise<CodexThread[]> {
  const when = new Date(atMs);
  let stamped = 0;
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    await utimes(join(entry.parentPath, entry.name), when, when);
    stamped += 1;
  }
  expect(stamped, 'no transcript was stamped — the fixture layout moved').toBeGreaterThan(0);

  // Read AFTER the stamp, so `CodexThread.mtimeMs` is the value being driven.
  const outcome = await readCodexEngine({ root });
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') throw new Error('unreachable: asserted above');
  const threads = outcome.result.threads as CodexThread[];
  expect(threads.length, 'the Codex fixture must carry threads').toBeGreaterThan(0);
  for (const thread of threads) {
    expect(thread.mtimeMs, 'a thread kept its checkout mtime').toBe(atMs);
  }
  return threads;
}

/**
 * A real Codex path over a staged root whose every transcript sits at
 * `mtimeMs`, read against an injected clock. No hook events: the mtime is the
 * only signal, which is the case that matters — it is what a session nobody
 * has touched still has.
 */
async function codexPathAt(
  root: string,
  mtimeMs: number,
  clock: number,
): Promise<{ path: CodexEnginePath; rootThread: CodexThread; poll: SplitTrigger }> {
  const threads = await stampTranscripts(root, mtimeMs);
  const rootThread = threads.find((thread) => thread.threadSource === 'user');
  expect(rootThread, 'the Codex fixture must carry a root thread').toBeDefined();
  const poll = splitPollTrigger();
  const path = new CodexEnginePath({
    workspaceFolders: [(rootThread as CodexThread).cwd],
    thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
    onChange: poll.onChange,
    root,
    now: () => clock,
    pollTrigger: poll.trigger,
  });
  await path.start();
  return { path, rootThread: rootThread as CodexThread, poll };
}

/** A real store and a real pipeline over one emission, with a manual clock. */
function storeOver(
  emission: SessionEmission,
  processStart: number,
  clockStart: number,
  dir: string,
): { appended: number; armed: number } {
  const time = new ManualTime(clockStart);
  const store = new StatsStore({ dir, enabled: true, retentionDays: 90 });
  const parsed = parsePricing({});
  const pipeline = new StatsPipeline({
    store,
    pricing: parsed.table,
    pricingInvalid: parsed.invalid,
    processStart,
    idleFlushMs: 60_000,
    now: () => time.now(),
    scheduler: time,
  });
  pipeline.observe(emission);
  const armed = pipeline.armedTimers;
  time.advance(60_000);
  const appended = store.appended;
  pipeline.dispose();
  return { appended, armed };
}


// ---------------------------------------------------------------------------
// DoD 4.11c — an mtime counts only with bytes behind it
// ---------------------------------------------------------------------------

/**
 * The third door into the store flood, closed (user ruling, 2026-09-10).
 *
 * 4.11b made LIVENESS the sole promoter, and two of the three liveness instants
 * are FILE MTIMES. So the flood had one door left open, stated on that item and
 * unguarded: **anything that touches a transcript after activation promotes that
 * whole history** — a clone, a restore from backup, a sync client, an indexer, a
 * virus scanner. This repository already records the mechanism from the other
 * side, because it is what made 4.11's first gate fail three times out of three:
 * *"git gives every fixture a fresh mtime, so a captured 2026-08 session looks
 * live"*.
 *
 * **THE RULE: an mtime-derived instant counts only if the transcript's SIZE GREW
 * since this process first stat'd it.** Hook events are untouched — the tap fires
 * because a tool ran, and no filesystem accident produces one.
 *
 * **THE STATED COST, and it is real.** A session that was being worked on right
 * up to the moment the window opened, and that never appends another byte, is
 * never recorded on its mtime — its baseline IS its current size. In practice a
 * live Claude Code or Codex session appends constantly and fires hooks on every
 * tool call, so this bites the narrow case of a session that stops at exactly the
 * wrong moment. The alternative is recording every session on a filesystem event
 * that says nothing about the session, which is the flood.
 */
describe('DoD 4.11c — a touched transcript is not activity; an appended one is', () => {
  it('Codex: a SHRUNK transcript re-baselines, and the next append counts', async () => {
    /*
     * User ruling, 2026-09-10, and the Codex half of it. A transcript found
     * smaller than its baseline was truncated, rotated, or rewritten in place;
     * measuring growth from the stale high-water mark would leave the session
     * unpromotable until it passed its ORIGINAL size, which is a window of lost
     * records rather than one.
     *
     * Driven by removing the file's last RECORD and putting it back, so the file
     * is a valid transcript at every step and the final size is exactly the
     * original — above the re-baselined mark and NOT above the original one, so a
     * high-water implementation fails this and only this.
     */
    const root = await stageCodexRoot(false);
    const stale = STAMP - 86_400_000;
    const poll = splitPollTrigger();
    const threads = await stampTranscripts(root, stale);
    const rootThread = threads.find((thread) => thread.threadSource === 'user') as CodexThread;
    const files = await transcriptsUnder(root);
    const rootFile = files.get(rootThread.owningFile) as string;
    expect(rootFile, "the root thread's transcript is not under the root").toBeDefined();

    const path = new CodexEnginePath({
      workspaceFolders: [rootThread.cwd],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: poll.onChange,
      root,
      now: () => STAMP + 5_000,
      pollTrigger: poll.trigger,
    });
    await path.start();
    const original = statSync(rootFile).size;
    expect(path.emit().lastActivityAt.size, 'the baseline claimed activity').toBe(0);

    // THE SHRINK: the last record is removed. Still a valid transcript.
    const text = await readFile(rootFile, 'utf8');
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    const last = lines.at(-1) as string;
    expect(lines.length, 'the transcript must hold more than one record').toBeGreaterThan(1);
    writeFileSync(rootFile, `${lines.slice(0, -1).join('\n')}\n`, 'utf8');
    const shrunkTo = statSync(rootFile).size;
    expect(shrunkTo, 'the file did not shrink').toBeLessThan(original);
    const shrinkAt = new Date(STAMP + 1_000);
    await utimes(rootFile, shrinkAt, shrinkAt);
    await poll.contentRead();
    poll.fire(0);
    expect(
      path.emit().lastActivityAt.get(rootThread.sessionId),
      'a shrink was read as activity',
    ).toBeUndefined();

    // THE RE-APPEND: the same record back. The file is exactly its original size
    // — above the NEW baseline and not above the old one.
    appendFileSync(rootFile, `${last}\n`, 'utf8');
    expect(statSync(rootFile).size, 'the re-append did not restore the size').toBe(original);
    const regrownAt = new Date(STAMP + 2_000);
    await utimes(rootFile, regrownAt, regrownAt);
    await poll.contentRead();
    poll.fire(0);

    expect(
      path.emit().lastActivityAt.get(rootThread.sessionId),
      'growth from the re-baselined size was not seen',
    ).toBe(STAMP + 2_000);

    path.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  });

  it('Codex: touch writes NOTHING, append writes a record', async () => {
    const root = await stageCodexRoot(false);
    const stale = STAMP - 86_400_000;
    const poll = splitPollTrigger();
    const threads = await stampTranscripts(root, stale);
    const rootThread = threads.find((thread) => thread.threadSource === 'user') as CodexThread;
    const path = new CodexEnginePath({
      workspaceFolders: [rootThread.cwd],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: poll.onChange,
      root,
      now: () => STAMP + 5_000,
      pollTrigger: poll.trigger,
    });
    await path.start();
    expect(path.emit().lastActivityAt.size, 'the baseline claimed activity').toBe(0);

    // A TOUCH, well after the stamp: every transcript's mtime says "now".
    const files = await transcriptsUnder(root);
    const sizesBefore = [...files.values()].map((file) => statSync(file).size);
    const when = new Date(STAMP + 1_000);
    for (const file of files.values()) await utimes(file, when, when);
    expect(
      [...files.values()].map((file) => statSync(file).size),
      'the touch changed a size',
    ).toStrictEqual(sizesBefore);
    await poll.contentRead();
    poll.fire(0);

    const touched = path.emit();
    expect(
      [...touched.lastActivityAt.keys()],
      'a touched Codex transcript claimed activity',
    ).toStrictEqual([]);
    const afterTouch = storeOver(
      touched,
      STAMP,
      STAMP + 5_000,
      join(await makeTempDir(), STORE_DIR_NAME),
    );
    expect(afterTouch.armed + afterTouch.appended, 'a touched Codex session reached the store').toBe(0);

    // AN APPEND: the same file, bytes added, the same mtime it already had.
    await growTranscript(files.get(rootThread.owningFile) as string, STAMP + 1_000);
    await poll.contentRead();
    poll.fire(0);

    const grown = path.emit();
    expect(
      grown.lastActivityAt.get(rootThread.sessionId),
      'an appended Codex transcript produced no instant',
    ).toBe(STAMP + 1_000);
    const afterAppend = storeOver(
      grown,
      STAMP,
      STAMP + 5_000,
      join(await makeTempDir(), STORE_DIR_NAME),
    );
    expect(
      afterAppend.armed + afterAppend.appended,
      'an appended Codex session reached no store',
    ).toBeGreaterThan(0);

    path.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// DoD 4.11b — every engine supplies its own activity, and the merge keeps it
// ---------------------------------------------------------------------------

/**
 * The other two engines' halves of the 4.11b law, driven through their real paths.
 *
 * **A derived record is evidence of CONTENT, never of ACTIVITY; activity comes
 * from liveness only** (user, 2026-09-10). `src/extension.stats.test.ts` pins
 * what the pipeline does with `SessionEmission.lastActivityAt`; these tests pin
 * that the values in it are the ENGINES' OWN, and that the merge does not lose
 * one engine's map on the way to the pipeline.
 *
 * Claude Code's half is driven from two directions elsewhere: `SessionModel.emit()`
 * reads `SessionLivenessSnapshot.witnessedActivityAt` (`lastActivityAt` until DoD
 * 4.11c narrowed the write side), the host store tests above would write nothing
 * at all if it stopped, and `src/model/liveness.test.ts`'s 4.11c suite pins the
 * instant itself — hook, growth, unknown size and shrink, one decision each.
 */
describe('DoD 4.11b — each engine supplies its own activity, and the merge is a union', () => {
  it('a Codex session whose transcripts predate activation is NOT recorded — the instant is known and it is not activity', async () => {
    const root = await stageCodexRoot(false);
    const stale = STAMP - 86_400_000;
    const { path, rootThread } = await codexPathAt(root, stale, STAMP + 5_000);
    const emission = path.emit();

    // THE DEPENDENCY, VISIBLE — and DoD 4.11c makes it sharper than 4.11b did.
    // Under 4.11b every session carried an instant (its mtime) and the gate
    // compared it to the stamp. Under 4.11c a transcript nobody appended to
    // yields NO INSTANT AT ALL: an mtime is a fact about a file having been
    // written, and a clone, a restore or a scanner writes one with no bytes
    // behind it.
    expect(emission.sessions.length, 'the fixture must render at least one session').toBeGreaterThan(0);
    expect(
      [...emission.lastActivityAt.keys()],
      'a transcript nobody appended to claimed activity',
    ).toStrictEqual([]);
    expect(emission.lastActivityAt.get(rootThread.sessionId)).toBeUndefined();

    // ...so the store declines it. Note what this also says: a Codex session the
    // last liveness report does NOT cover carries no instant either, and the
    // same absence keeps it out — which is the whole reason the Codex half
    // reads `#liveness.latest` rather than stamping `now`.
    const written = storeOver(emission, STAMP, STAMP + 5_000, join(await makeTempDir(), STORE_DIR_NAME));
    expect(written.armed, 'a day-old transcript armed a flush').toBe(0);
    expect(written.appended, 'a Codex session nobody witnessed reached the store').toBe(0);

    path.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  });

  it('a Codex session whose transcript GROWS after activation is recorded', async () => {
    /*
     * THE OTHER ARM, and under DoD 4.11c it is an APPEND rather than a touch.
     * Without this pair "history reaches no store" is satisfied by a gate that
     * refuses everything — a failure with no symptom until the Stats view is
     * permanently empty.
     */
    const root = await stageCodexRoot(false);
    const stale = STAMP - 86_400_000;
    const { path, rootThread, poll } = await codexPathAt(root, stale, STAMP + 5_000);

    // The baseline is this process's first sighting, so nothing has grown yet.
    expect(path.emit().lastActivityAt.get(rootThread.sessionId)).toBeUndefined();

    // Somebody works: bytes are appended to the root transcript.
    const files = await transcriptsUnder(root);
    const rootFile = files.get(rootThread.owningFile);
    expect(rootFile, "the root thread's transcript is not under the root").toBeDefined();
    const grewAt = STAMP + 1_000;
    await growTranscript(rootFile as string, grewAt);
    await poll.contentRead();
    poll.fire(0);

    const emission = path.emit();
    expect(
      emission.lastActivityAt.get(rootThread.sessionId),
      'an appended transcript produced no instant',
    ).toBe(grewAt);

    const written = storeOver(emission, STAMP, STAMP + 5_000, join(await makeTempDir(), STORE_DIR_NAME));
    expect(written.armed + written.appended, 'a witnessed Codex session reached no store').toBeGreaterThan(0);

    path.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  });

  it('the instant is what the last liveness POLL saw, not what the last content read saw', async () => {
    /*
     * ROUND 3'S FIRST REAL DEFECT, PINNED. The verifier replaced this emitter's
     * whole `#liveness.latest` block with a loop over `#threads` reading
     * `thread.mtimeMs` — so the liveness report was never consulted at all — and
     * **163 tests stayed green**, because `CodexLiveness.lastMtimeMs` IS
     * `CodexThread.mtimeMs` and the other test stamps every file to one instant.
     * Two readers of the same number, indistinguishable while they agree.
     *
     * They disagree in one measurable window, and it is a real one: a content
     * re-read discovers a transcript's new mtime immediately, while the report is
     * whatever the last liveness POLL sampled. The emission must carry the
     * report's answer — liveness is the authority for activity, and a session
     * becomes recordable when the tap says so and not a pump earlier.
     */
    const root = await stageCodexRoot(false);
    const stale = STAMP - 86_400_000;
    const poll = splitPollTrigger();
    const threads = await stampTranscripts(root, stale);
    const rootThread = threads.find((thread) => thread.threadSource === 'user') as CodexThread;
    const path = new CodexEnginePath({
      workspaceFolders: [rootThread.cwd],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: poll.onChange,
      root,
      now: () => STAMP + 5_000,
      pollTrigger: poll.trigger,
    });
    await path.start();
    expect(poll.count(), 'the path registers a liveness poll and a content re-read').toBe(2);
    // Nothing has grown yet, so there is no instant to be wrong about.
    expect(path.emit().lastActivityAt.get(rootThread.sessionId)).toBeUndefined();

    // The transcripts are APPENDED TO (DoD 4.11c — a touch would leave nothing
    // to see). Only the CONTENT trigger fires, and which registration that is is
    // established rather than assumed.
    const before = path.diagnostics;
    const grewAt = STAMP + 1_000;
    for (const file of (await transcriptsUnder(root)).values()) await growTranscript(file, grewAt);
    await poll.contentRead();
    const after = path.diagnostics;
    expect(after.contentReads, 'index 1 is not the content re-read').toBe(before.contentReads + 1);
    expect(after.livenessPolls, 'index 1 polled liveness too').toBe(before.livenessPolls);

    // The content read KNOWS the new size AND the new mtime. The size is what
    // this half reads — the file has grown — but the INSTANT is still the
    // report's, and the report predates the write. So the emission says the OLD
    // mtime, which is a day ago, and the store still declines the session.
    expect(
      path.emit().lastActivityAt.get(rootThread.sessionId),
      'the emission took its instant from the content read',
    ).toBe(stale);

    // The tap polls. NOW it moves.
    poll.fire(0);
    expect(path.diagnostics.livenessPolls).toBe(after.livenessPolls + 1);
    expect(path.emit().lastActivityAt.get(rootThread.sessionId)).toBe(grewAt);

    path.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  });

  it('a HOOK EVENT after the stamp is activity even when every transcript is stale', async () => {
    /*
     * The other half of `max(lastHookEventMs, lastMtimeMs)`, and the arm no
     * mtime-only test can reach. `Math.max` → `Math.min` inside a thread is
     * invisible while a thread has ONE instant; give it two that disagree and the
     * wrong one keeps a working session out of the store. This is also the
     * strongest statement of the dependency: a hook event exists only in the
     * liveness report, so nothing reading `#threads` can produce this number.
     *
     * The payloads are the captured baseline hook stream — the same run as these
     * transcripts, so the ids attribute without anything being invented here.
     */
    const root = await stageCodexRoot(false);
    const stale = STAMP - 86_400_000;
    const poll = splitPollTrigger();
    const threads = await stampTranscripts(root, stale);
    const rootThread = threads.find((thread) => thread.threadSource === 'user') as CodexThread;

    const stream = await readFile(
      fileURLToPath(
        new URL('../fixtures/codex-0.151.0-alpha.7.2/baseline/hook-stream.jsonl', import.meta.url),
      ),
      'utf8',
    );
    const payloads = stream
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as { raw: Record<string, unknown> }).raw)
      .filter((raw) => raw['session_id'] === rootThread.sessionId);
    expect(
      payloads.length,
      'no captured hook payload names the staged session — the corpus moved',
    ).toBeGreaterThan(0);

    const path = new CodexEnginePath({
      workspaceFolders: [rootThread.cwd],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: poll.onChange,
      root,
      now: () => STAMP + 5_000,
      pollTrigger: poll.trigger,
    });
    await path.start();
    // No append, so the mtime leg contributes nothing at all (DoD 4.11c) — which
    // makes this the cleanest statement of the hook leg there is: every instant
    // below came from the tap.
    expect(
      path.emit().lastActivityAt.get(rootThread.sessionId),
      'history, before the hook',
    ).toBeUndefined();

    // One real hook event, received AFTER the stamp. The transcripts do not move.
    path.ingestHookEvent({ receivedAtMs: STAMP + 2_000, payload: payloads[0] });
    poll.fire(0);
    expect(
      path.emit().lastActivityAt.get(rootThread.sessionId),
      'the hook event did not reach the instant',
    ).toBe(STAMP + 2_000);

    // ...and that is enough to be recorded, which is the point of the field.
    const written = storeOver(
      path.emit(),
      STAMP,
      STAMP + 5_000,
      join(await makeTempDir(), STORE_DIR_NAME),
    );
    expect(written.armed + written.appended, 'a hooked session reached no store').toBeGreaterThan(0);

    path.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  });

  it("a session's instant is the LATEST of its threads — a subagent writing IS the session working", async () => {
    /*
     * ROUND 3'S SECOND REAL DEFECT, PINNED. `Math.max` → `Math.min` AND
     * max-across-threads → first-thread-only both passed with **211 tests
     * green**: one instant for every file makes every aggregation the same
     * number. So this test gives the threads DIFFERENT instants, which needs a
     * run with more than one thread per session — `spawn-shapes`, whose subagents
     * live in their own transcripts.
     */
    const root = await stageCodexRun('spawn-shapes');
    const stale = STAMP - 86_400_000;
    const threads = await stampTranscripts(root, stale);

    // A session with at least two threads in DIFFERENT files, found rather than
    // named: a corpus is not asserted by size here, and if the shape ever moves
    // this fails saying so.
    const bySession = new Map<string, CodexThread[]>();
    for (const thread of threads) {
      bySession.set(thread.sessionId, [...(bySession.get(thread.sessionId) ?? []), thread]);
    }
    const multi = [...bySession.values()].find(
      (group) => new Set(group.map((thread) => thread.owningFile)).size > 1,
    );
    expect(
      multi,
      'no Codex session in spawn-shapes spans two transcripts — the corpus shape moved',
    ).toBeDefined();
    const group = multi as CodexThread[];
    const rootThread = group.find((thread) => thread.threadId === thread.sessionId) ?? group[0];

    const subagent = group.find((thread) => thread.owningFile !== (rootThread as CodexThread).owningFile);
    expect(subagent, 'the group must hold a thread in another file').toBeDefined();
    const files = await transcriptsUnder(root);
    const rootFile = files.get((rootThread as CodexThread).owningFile);
    const subagentFile = files.get((subagent as CodexThread).owningFile);
    expect(rootFile, "the root's transcript is not under the root").toBeDefined();
    expect(subagentFile, "the subagent's transcript is not under the root").toBeDefined();

    const poll = splitPollTrigger();
    const path = new CodexEnginePath({
      workspaceFolders: [(rootThread as CodexThread).cwd],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: poll.onChange,
      root,
      now: () => STAMP + 5_000,
      pollTrigger: poll.trigger,
    });
    await path.start();
    // THE BASELINE IS TAKEN FIRST, and it has to be: growth is measured against
    // what this process saw when it arrived, so appending before the path starts
    // leaves nothing to have grown (DoD 4.11c).
    expect(path.emit().lastActivityAt.size, 'nothing has grown yet').toBe(0);

    // BOTH threads are then appended to, the subagent LATER than the root. Both
    // therefore carry an instant (a touch would carry none), so "first thread
    // wins" and "min" each return the ROOT's earlier one and this test can tell
    // all three answers apart.
    await growTranscript(rootFile as string, STAMP + 500);
    await growTranscript(subagentFile as string, STAMP + 1_000);
    await poll.contentRead();
    poll.fire(0);

    const at = path.emit().lastActivityAt.get((rootThread as CodexThread).sessionId);
    expect(at, 'the session carries no instant').toBeTypeOf('number');
    expect(at, "the session took the root's earlier instant instead of the latest thread's").toBe(
      STAMP + 1_000,
    );
    expect(at as number).toBeGreaterThan(STAMP + 500);

    path.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  });

  it("an OpenCode session's activity is a fact about the STORE, not about when it was asked", async () => {
    /*
     * The OpenCode assignment site, driven. `OcSessionLiveness.lastActivityAt` is
     * `max(timeUpdated, seqAdvancedAt)` — both of them instants the store moved —
     * so the same emission taken an hour later must carry the same numbers. That
     * is the whole law in one assertion: a mutation stamping `now()` here (the
     * cheapest wrong thing to write, and the flood's own shape) moves them.
     */
    const dir = await makeTempDir();
    const dbPath = copyCorpus(smallestCorpus(), dir);
    const poll = manualPollTrigger();
    let clock = Date.parse('2026-09-10T00:00:00.000Z');

    const path = new OpenCodeEnginePath({
      workspacePaths: [worktreeOf(dbPath)],
      thresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      onChange: () => {},
      dbPath,
      now: () => clock,
      pollTrigger: poll.trigger,
      walWatchFactory: () => ({ close: () => {} }),
    });
    path.start();

    const first = path.emit();
    expect(first.sessions.length, 'the corpus must render sessions').toBeGreaterThan(0);
    expect(
      first.lastActivityAt.size,
      'every emitted OpenCode session must carry an instant',
    ).toBe(first.sessions.length);
    for (const [sessionId, at] of first.lastActivityAt) {
      expect(at, `${sessionId} was stamped with the clock`).not.toBe(clock);
      expect(at, `${sessionId} claims activity in the future`).toBeLessThan(clock);
      expect(at).toBeGreaterThan(0);
    }

    // An hour passes and the store does not move. Neither may the instants.
    clock += 3_600_000;
    poll.fire();
    const second = path.emit();
    expect([...second.lastActivityAt.entries()].sort()).toStrictEqual(
      [...first.lastActivityAt.entries()].sort(),
    );

    path.dispose();
  });

  it('the MERGED emission carries every engine\'s map, not just the first', async () => {
    /*
     * `mergeTwo` short-circuits on `EMPTY_EMISSION`, so in every other test in
     * this file — one engine live, two absent — its body never runs and the union
     * is unmeasured. That is the D4 shape: a single production assignment site
     * nothing drives. This test lights up TWO engines at once, which needs a
     * multi-root workspace (the Codex scratch repo beside the captured Claude
     * Code one), and then asserts that ids from both reach the map the pipeline
     * reads. Replacing the union with either side alone turns it red.
     */
    const root = await stageCodexRoot(false);
    const threads = await stampTranscripts(root, STAMP - 86_400_000);
    const codexCwd = (threads.find((thread) => thread.threadSource === 'user') as CodexThread).cwd;
    const ccWorkspace = await capturedWorkspacePath();
    // Both engines read from STAGED, WRITABLE copies, because under DoD 4.11c an
    // engine whose files nobody appends to reports no activity at all — so a
    // union over two engines needs two engines that have each seen a write.
    const { root: ccRoot, slugDir: ccSlugDir } = await stageCapturedRoot();
    const codexPoll = splitPollTrigger();
    const emissions: DataPathEmission[] = [];

    const path = await startDataPathOnFreePort((port) => {
      emissions.length = 0;
      return trackDataPath(
        new AgentDeckDataPath({
          workspacePath: ccWorkspace,
          // The CC half reads `workspacePath`; the other two read every folder.
          workspacePaths: [ccWorkspace, codexCwd],
          projectsRoot: ccRoot,
          settings: settings({ port }),
          tickMs: 0,
          codex: { root, pollTrigger: codexPoll.trigger },
          onEmission: (payload) => {
            emissions.push(payload);
          },
        }),
      );
    });
    path.pump();

    // Both engines are then WORKED ON after the baseline, or the map is empty
    // for both and the union below passes over two empty maps. Claude Code by an
    // APPEND (its instant is a synchronous stat on the next pump). Codex by a
    // real captured HOOK EVENT — unconditional activity that needs no content
    // read, because this data path owns the Codex half's onChange and a content
    // read here could only be awaited by a sleep, which is the defect the split
    // trigger's `contentRead` exists to remove.
    await growSessions(ccSlugDir);
    const codexRootId = (threads.find((thread) => thread.threadSource === 'user') as CodexThread).sessionId;
    const stream = await readFile(
      fileURLToPath(new URL('../fixtures/codex-0.151.0-alpha.7.2/baseline/hook-stream.jsonl', import.meta.url)),
      'utf8',
    );
    const payload = stream
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as { raw: Record<string, unknown> }).raw)
      .find((raw) => raw['session_id'] === codexRootId);
    expect(payload, 'no captured hook payload names the staged Codex session').toBeDefined();
    path.codex.ingestHookEvent({ receivedAtMs: STAMP + 1_000, payload });
    codexPoll.fire(0);
    path.pump();

    const last = emissions[emissions.length - 1] as DataPathEmission;
    const byEngine = new Map<string, string[]>();
    for (const session of last.emission.sessions) {
      // `engine` is optional on the wire and absent means Claude Code, which is
      // the same reading `webview/store.ts` applies.
      const engine = session.engine ?? 'cc';
      const held = byEngine.get(engine) ?? [];
      held.push(session.sessionId);
      byEngine.set(engine, held);
    }
    // Two engines really are live, or the union below is untested.
    expect([...byEngine.keys()].sort(), 'both engines must render for this to mean anything')
      .toStrictEqual(['cc', 'codex']);

    for (const [engine, ids] of byEngine) {
      const known = ids.filter((id) => last.emission.lastActivityAt.has(id));
      expect(known.length, `the merge dropped ${engine}'s activity map`).toBe(ids.length);
    }

    await rm(dirname(root), { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// v0.7.0 DoD 5.1 / 5.2 — activate() RETURNS the API, and the host feeds it
// ---------------------------------------------------------------------------

/**
 * THE PRODUCTION PATH, and the reason this is not in `api.test.ts`. The API
 * object is only useful if `activate()` returns it and the host's pipeline
 * feeds its event, and both of those are single assignment sites in
 * `activate()` — the recorded D4 shape: a module test that builds the object
 * by hand proves the module and says nothing about whether anything wires it.
 * Deleting the `onStatsUpdate` line from `activate()` turns a test here red,
 * and so does replacing either of its two `return api` statements (no folder,
 * a host) with `undefined` — each has its own test below, and the "nothing to
 * observe" test reaches the second through a host. There were three until
 * hotfix 0.8.1 removed the nothing-to-observe return; until the Phase 5
 * verifier round that one had no test, while this comment said it did.
 */
describe('DoD 5.1/5.2: activate() returns the API, and the host feeds it', () => {
  const previousRoot = process.env['CLAUDE_PROJECTS_ROOT'];

  afterEach(async () => {
    await deactivate();
    if (previousRoot === undefined) delete process.env['CLAUDE_PROJECTS_ROOT'];
    else process.env['CLAUDE_PROJECTS_ROOT'] = previousRoot;
  });

  /** One committed golden record, stamped, seeded into the resolved store. */
  async function seedGolden(globalStorage: string): Promise<StatsRecord> {
    const goldens = fileURLToPath(new URL('../fixtures/golden/stats/', import.meta.url));
    const first = (await readdir(goldens)).filter((n) => n.endsWith('.json')).sort()[0];
    expect(first, 'no committed stats golden to seed').toBeDefined();
    const record = JSON.parse(await readFile(join(goldens, first ?? ''), 'utf8')) as StatsRecord;
    const dir = resolveStoreDir({ globalStorageUri: { fsPath: globalStorage } });
    const store = new StatsStore({ dir, enabled: true, retentionDays: 3_650 });
    store.appendRecord({ ...record, derivedAt: Date.now() });
    expect(store.appended).toBe(1);
    return record;
  }

  it('a window with NO folder still returns the API, and it reads the machine history', async () => {
    resetVscodeMock();
    mock.setWorkspaceFolder(undefined);
    const globalStorage = await makeTempDir();
    const seeded = await seedGolden(globalStorage);

    const api: AgentDeckApi = await activate(extensionContext(globalStorage));
    expect(currentHost(), 'this path is meant to have no host').toBeNull();
    expect(api.apiVersion).toBe(1);
    expect(api.getLiveStats()).toStrictEqual([]);
    const stored = await api.getStoredStats();
    expect(stored.map((r) => r.sessionId)).toStrictEqual([seeded.sessionId]);
  });

  it('a window WITH a folder and nothing to observe still returns the API', async () => {
    // This was the second early return, found unguarded by the Phase 5
    // verifier. Hotfix 0.8.1 removed that return (user ruling 2026-09-15): a
    // window with a folder open always builds a host, so this path now takes
    // the FINAL `return api`, and a host is what proves it did. Each engine is
    // still proved absent through the predicates `activate()` used to ask.
    process.env['CLAUDE_PROJECTS_ROOT'] = join(await makeTempDir(), 'no-such-projects-root');
    const workspacePath = join(await makeTempDir(), 'ws');
    expect((await correlateWorkspace(workspacePath)).ok).toBe(false);
    expect(opencodeStoreExists()).toBe(false);
    expect(codexRootExists()).toBe(false);
    const globalStorage = await makeTempDir();
    const seeded = await seedGolden(globalStorage);

    const api = await onFreePort<AgentDeckApi>({
      use: async (port) => {
        resetVscodeMock();
        mock.setWorkspaceFolder(workspacePath);
        mock.setConfig(CONFIG_SECTION, { port });
        return activate(extensionContext(globalStorage));
      },
      collided: () => currentHost()?.dataPath.diagnostics.bindError?.code === 'EADDRINUSE',
      discard: async () => {
        await deactivate();
      },
    });
    expect(currentHost(), 'a folder is open, so this path has a host').not.toBeNull();
    expect(currentHost()?.dataPath.diagnostics.ccEnabled).toBe(false);
    expect(api?.apiVersion).toBe(1);
    expect(api.getLiveStats()).toStrictEqual([]);
    const stored = await api.getStoredStats();
    expect(stored.map((r) => r.sessionId)).toStrictEqual([seeded.sessionId]);
  });

  it('a disabled store answers [] through the API, as it does in the panel', async () => {
    resetVscodeMock();
    mock.setWorkspaceFolder(undefined);
    mock.setConfig(CONFIG_SECTION, { 'stats.enabled': false });
    const globalStorage = await makeTempDir();
    await seedGolden(globalStorage);
    const api = await activate(extensionContext(globalStorage));
    expect(await api.getStoredStats()).toStrictEqual([]);
  });

  it('a matching workspace: live stats are the host pipeline, and a flush reaches onDidUpdateStats', async () => {
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    const workspacePath = await capturedWorkspacePath();
    const globalStorage = await makeTempDir();
    await warmCorpus();
    const states = await readCcSessions();

    const api = await onFreePort<AgentDeckApi>({
      use: async (port) => {
        resetVscodeMock();
        mock.setWorkspaceFolder(workspacePath);
        mock.setConfig(CONFIG_SECTION, { port });
        return activate(extensionContext(globalStorage));
      },
      collided: () => currentHost()?.dataPath.diagnostics.bindError?.code === 'EADDRINUSE',
      discard: async () => {
        await deactivate();
      },
    });

    const pipeline = currentHost()?.stats;
    expect(pipeline, 'activate() built no stats pipeline').toBeDefined();
    const live = api.getLiveStats();
    expect(live.length, 'the captured workspace derived no records').toBeGreaterThan(0);
    expect(live.map((r) => r.sessionId).sort()).toStrictEqual(
      (pipeline?.liveRecords() ?? []).map((r) => r.sessionId).sort(),
    );

    // The EVENT, through the production wiring: an ended session with liveness
    // activity after this activation's stamp is written, and the write is an
    // event on the object activate() returned.
    const heard: StatsRecord[] = [];
    api.onDidUpdateStats((record) => heard.push(record));
    const state = structuredClone(states[0]) as SessionState;
    (state as unknown as Record<string, unknown>)['liveness'] = 'ended';
    const emission: SessionEmission = {
      sessions: [state],
      diffs: [],
      addedSessionIds: [],
      removedSessionIds: [],
      schemaMismatchSessionIds: [],
      lastActivityAt: new Map([[state.sessionId, Date.now() + 1]]),
    };
    pipeline?.observe(emission);
    expect(heard.map((r) => r.sessionId)).toStrictEqual([state.sessionId]);
    expect(typeof (heard[0] as { derivedAt?: unknown } | undefined)?.derivedAt).toBe('number');
    // ...and the same line is what the stored getter now returns for it.
    const stored = await api.getStoredStats();
    expect(stored.map((r) => r.sessionId)).toContain(state.sessionId);
  }, CORPUS_READ_BUDGET_MS);
});

// ---------------------------------------------------------------------------
// v0.8.0 Phase 7, DoD 7.6 — the Tweaks panel, HOST HALF
// ---------------------------------------------------------------------------

/*
 * WHAT IS REAL HERE. `activate()`, the registered view provider, the real
 * `SidebarController` over the real `adaptWebviewView`, the real
 * `isWebviewToHostMessage` guard, and the mock's `workspace.getConfiguration`
 * whose `update` writes into the same map `get` reads. No test in this block
 * constructs a `settings` message by hand and hands it to a surface — that is
 * the D4 shape this repository has shipped four times, and what it hides is
 * exactly a value production never sends.
 *
 * The EFFECTS of three of the four (the deck moving, the drawer opening, the
 * ordering applied) are drawn in `webview/`, and are that package's to test.
 * What is host-observable, and asserted here, is the whole path a value takes:
 * read from the configuration, sent to the surface on create, re-sent on every
 * change, written back through `update` when the panel asks, and read back
 * with the new value.
 */
describe('DoD 7.6 — the four tweaks, the host half', () => {
  const previousRoot = process.env['CLAUDE_PROJECTS_ROOT'];

  afterEach(async () => {
    await deactivate();
    if (previousRoot === undefined) delete process.env['CLAUDE_PROJECTS_ROOT'];
    else process.env['CLAUDE_PROJECTS_ROOT'] = previousRoot;
  });

  /**
   * The configuration reader the host itself reads through, so a test compares
   * what was SENT with what `workspace.getConfiguration()` answers rather than
   * with a value the test wrote down.
   */
  const mockConfiguration = (): { get(key: string): unknown } =>
    mock.state.configuration.get(CONFIG_SECTION) ?? new Map<string, unknown>();

  /** The `settings` messages a view was posted, in order. */
  const settingsPosted = (view: { webview: { posted: unknown[] } }): SettingsMessage[] =>
    view.webview.posted.filter(
      (m): m is SettingsMessage => (m as { type?: string }).type === 'settings',
    );

  it('declares all four, and an unconfigured window reads the shipped defaults', () => {
    // The four keys are `src/sidebar/tweaks.ts`'s, read from there rather than
    // written out again: a row the panel draws with no setting behind it is a
    // control over nothing.
    const read = readSettings(undefined) as unknown as Record<string, unknown>;
    for (const tweak of TWEAK_SETTINGS) {
      expect(SETTING_SHAPES, tweak.key).toHaveProperty(tweak.key);
      expect(read[tweak.key], tweak.key).toBe(
        SETTING_SHAPES[tweak.key as keyof typeof SETTING_SHAPES].defaultOf(),
      );
    }
    // The shipped values, written out ONCE so a default that moves has to come
    // past a line that names it. Each is 0.7.1's behaviour.
    expect(tweaksOf(readSettings(undefined))).toStrictEqual({
      followNewSessions: false,
      openDrawerOnEnter: false,
      drawerExpandedByDefault: false,
      defaultOrdering: 'live',
    });
  });

  it('reads booleans type-strictly and an ordering by membership, never by truthiness', () => {
    // The string "true" is not a `true`, and `0` is not a `false`: a
    // truthiness read would turn a tweak on because a value has the wrong
    // type. `"LIVE"` and `"sideways"` are not orderings the renderer has a
    // branch for, so they read as the default rather than reaching it.
    const hostile = readSettings({
      get: (key: string) =>
        ({
          followNewSessions: 'true',
          openDrawerOnEnter: 1,
          drawerExpandedByDefault: null,
          defaultOrdering: 'LIVE',
        })[key],
    });
    expect(tweaksOf(hostile)).toStrictEqual({
      followNewSessions: false,
      openDrawerOnEnter: false,
      drawerExpandedByDefault: false,
      defaultOrdering: 'live',
    });

    // CONTROL, in both directions: real values of the right type DO come
    // through, so the block above is a refusal and not a reader stuck on its
    // defaults.
    const real = readSettings({
      get: (key: string) =>
        ({
          followNewSessions: true,
          openDrawerOnEnter: true,
          drawerExpandedByDefault: true,
          defaultOrdering: 'engine',
        })[key],
    });
    expect(tweaksOf(real)).toStrictEqual({
      followNewSessions: true,
      openDrawerOnEnter: true,
      drawerExpandedByDefault: true,
      defaultOrdering: 'engine',
    });
    // ...and every option the panel offers is accepted, not just this one.
    for (const option of TWEAK_SETTINGS.find((x) => x.key === 'defaultOrdering')?.options ?? []) {
      expect(readSettings({ get: () => option }).defaultOrdering, option).toBe(option);
    }
  });

  it('a resolved sidebar is sent the settings as configured, in a window with no host', async () => {
    /*
     * NO WORKSPACE, so `activate()` returns before building a host. The Tweaks
     * tab is exactly the tab a user opens in that window, and the values it
     * draws must still be the user's own: the configuration is the source of
     * truth on both paths, which is why this does not go through the host.
     */
    resetVscodeMock();
    mock.setConfig(CONFIG_SECTION, { followNewSessions: true, defaultOrdering: 'recent' });
    await activate(extensionContext());
    expect(currentHost()).toBeNull();

    const view = mock.resolveView(SIDEBAR_VIEW_ID);
    const messages = settingsPosted(view);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.tweaks).toStrictEqual({
      followNewSessions: true,
      openDrawerOnEnter: false,
      drawerExpandedByDefault: false,
      defaultOrdering: 'recent',
    });
    // The same message carries `canvasAutoFit`: one type, one send site, so a
    // second surface cannot be added with half the settings wired.
    expect(messages[0]?.canvasAutoFit).toBe(true);
  });

  it('a configuration change re-sends to every live sidebar, with the new values', async () => {
    resetVscodeMock();
    mock.setConfig(CONFIG_SECTION, {});
    await activate(extensionContext());
    const view = mock.resolveView(SIDEBAR_VIEW_ID);
    expect(settingsPosted(view).at(-1)?.tweaks.defaultOrdering).toBe('live');

    mock.setConfig(CONFIG_SECTION, { defaultOrdering: 'engine', drawerExpandedByDefault: true });
    mock.fireConfigurationChange(CONFIG_SECTION);
    const latest = settingsPosted(view).at(-1);
    expect(settingsPosted(view)).toHaveLength(2);
    expect(latest?.tweaks.defaultOrdering).toBe('engine');
    expect(latest?.tweaks.drawerExpandedByDefault).toBe(true);

    // A change in some OTHER extension's section re-sends nothing.
    mock.state.configurationEmitter.fire({ affectsConfiguration: () => false });
    expect(settingsPosted(view)).toHaveLength(2);
  });

  it('a re-shown sidebar is told again: the panel holds no state, so the values equal the settings', async () => {
    /*
     * THE DoD'S "reload -> values equal settings", end to end. A hidden
     * `WebviewView` is torn down, so what comes back is a new document that
     * knows nothing; if the host did not re-send, the tab would draw the
     * renderer's own defaults over a configuration that says otherwise.
     *
     * The value is changed BETWEEN the first send and the re-show, so a
     * controller that replayed its first message would show `live` here.
     */
    resetVscodeMock();
    mock.setConfig(CONFIG_SECTION, { defaultOrdering: 'recent' });
    await activate(extensionContext());
    const view = mock.resolveView(SIDEBAR_VIEW_ID);
    expect(settingsPosted(view).at(-1)?.tweaks.defaultOrdering).toBe('recent');

    mock.setConfig(CONFIG_SECTION, { defaultOrdering: 'engine' });
    mock.fireConfigurationChange(CONFIG_SECTION);
    view.setVisible(false);
    view.setVisible(true);

    const latest = settingsPosted(view).at(-1);
    expect(latest?.tweaks).toStrictEqual(
      tweaksOf(readSettings(mockConfiguration())),
    );
    expect(latest?.tweaks.defaultOrdering).toBe('engine');
    // VACUITY: the first message really did say something else.
    expect(settingsPosted(view)[0]?.tweaks.defaultOrdering).toBe('recent');
  });

  it('an updateTweak writes through workspace.getConfiguration().update, to Global', async () => {
    resetVscodeMock();
    mock.setConfig(CONFIG_SECTION, {});
    await activate(extensionContext());
    const view = mock.resolveView(SIDEBAR_VIEW_ID);

    // Every declared tweak, at a value of its own kind, through the real
    // guard and the real controller.
    view.fireMessage({ type: 'updateTweak', key: 'followNewSessions', value: true });
    view.fireMessage({ type: 'updateTweak', key: 'openDrawerOnEnter', value: true });
    view.fireMessage({ type: 'updateTweak', key: 'drawerExpandedByDefault', value: true });
    view.fireMessage({ type: 'updateTweak', key: 'defaultOrdering', value: 'engine' });
    await new Promise((r) => setTimeout(r, 0));

    expect(mock.configurationWrites).toStrictEqual([
      { section: CONFIG_SECTION, key: 'followNewSessions', value: true, target: 1 },
      { section: CONFIG_SECTION, key: 'openDrawerOnEnter', value: true, target: 1 },
      { section: CONFIG_SECTION, key: 'drawerExpandedByDefault', value: true, target: 1 },
      { section: CONFIG_SECTION, key: 'defaultOrdering', value: 'engine', target: 1 },
    ]);
    // `1` is `ConfigurationTarget.Global`, asserted by name as well as by
    // number: the decision is the FILE, the user's own settings rather than
    // the workspace's `.vscode/settings.json`, and a number alone would not
    // say which was meant.
    expect(ConfigurationTarget.Global).toBe(1);

    // AND THE WRITE IS WHAT MOVES THE VALUE: read back through the same
    // configuration the host reads, the four now hold what was clicked.
    expect(tweaksOf(readSettings(mockConfiguration()))).toStrictEqual({
      followNewSessions: true,
      openDrawerOnEnter: true,
      drawerExpandedByDefault: true,
      defaultOrdering: 'engine',
    });
  });

  it('a message the guard refuses writes nothing at all', async () => {
    /*
     * The boundary, from the host's side. Each of these is well-formed JSON
     * naming a real-looking setting, and the next thing the host would do is
     * write into the user's `settings.json` — so the assertion that matters is
     * that NOTHING was written, not that nothing was drawn.
     */
    resetVscodeMock();
    mock.setConfig(CONFIG_SECTION, {});
    await activate(extensionContext());
    const view = mock.resolveView(SIDEBAR_VIEW_ID);
    for (const hostile of [
      { type: 'updateTweak', key: 'telemetry.enabled', value: true },
      { type: 'updateTweak', key: 'port', value: 1 },
      { type: 'updateTweak', key: 'followNewSessions', value: 'yes' },
      { type: 'updateTweak', key: 'defaultOrdering', value: 'sideways' },
      { type: 'updateTweak', key: '__proto__', value: true },
      { type: 'updateTweak', value: true },
    ]) {
      view.fireMessage(hostile);
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(mock.configurationWrites).toStrictEqual([]);

    // VACUITY CONTROL: this view CAN write — the same path, one legal message.
    view.fireMessage({ type: 'updateTweak', key: 'followNewSessions', value: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(mock.configurationWrites).toHaveLength(1);
  });

  it('a host tells its panel the tweaks on open and on every change', async () => {
    /*
     * The PANEL's half of the same message. `canvas.autoFit` has ridden on it
     * since 0.7.0 and the four join it rather than taking a channel of their
     * own, so this asserts they arrive together and that a change re-sends
     * both — a second message type would have been a second send site kept in
     * step by hand.
     */
    process.env['CLAUDE_PROJECTS_ROOT'] = CAPTURED_ROOT;
    resetVscodeMock();
    mock.setWorkspaceFolder(await capturedWorkspacePath());
    mock.setConfig(CONFIG_SECTION, { followNewSessions: true });
    await activate(extensionContext());
    const host = currentHost();
    expect(host).not.toBeNull();
    await mock.runCommand(OPEN_COMMAND);
    const panel = mock.panels[0];
    expect(panel).toBeDefined();

    const first = (panel?.webview.posted ?? []).filter(
      (m): m is SettingsMessage => (m as { type?: string }).type === 'settings',
    );
    expect(first.at(-1)?.tweaks.followNewSessions).toBe(true);
    expect(first.at(-1)?.tweaks.defaultOrdering).toBe('live');

    mock.setConfig(CONFIG_SECTION, { followNewSessions: false, defaultOrdering: 'recent' });
    mock.fireConfigurationChange(CONFIG_SECTION);
    const after = (panel?.webview.posted ?? []).filter(
      (m): m is SettingsMessage => (m as { type?: string }).type === 'settings',
    );
    expect(after.length).toBeGreaterThan(first.length);
    expect(after.at(-1)?.tweaks).toStrictEqual({
      followNewSessions: false,
      openDrawerOnEnter: false,
      drawerExpandedByDefault: false,
      defaultOrdering: 'recent',
    });
    // ...and the host's own copy agrees with what it sent.
    expect(host?.tweaks).toStrictEqual(after.at(-1)?.tweaks);
  });
});
