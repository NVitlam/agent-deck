/**
 * Agent Deck — project file watcher (spec §5, component C1).
 *
 * `src/parser/tailer.ts` deliberately contains no watcher: it says so in its
 * own header, and leaves the caller to decide how change is detected. This
 * module is that caller. It owns exactly three things:
 *
 *   1. chokidar on `<projectsRoot>/<slug>/`, recursive enough to reach
 *      `subagents/`, `*.meta.json` sidecars and `tool-results/`;
 *   2. the burst debounce, driven through the tailer's own {@link Debouncer}
 *      so a storm of appends collapses into one {@link SessionTailer.poll};
 *   3. teardown — every watcher closed and every timer cancelled on dispose.
 *
 * Nothing here parses, and nothing here re-implements byte-offset tailing.
 *
 * Grounding constraints this module is held to:
 *
 *   G1  Read-only. chokidar is configured to observe only; this module never
 *       creates, writes, renames or deletes anything. There is no cache file,
 *       no lock file and no marker file — `watcher.test.ts` proves it with a
 *       before/after `snapshotTree` byte comparison rather than in prose.
 *   G2  Source separation. A chokidar error, a discovery refusal, a poll
 *       failure or a throwing `onBatch` callback are all counted and
 *       swallowed. None of them can take down the caller, and none of them
 *       can reach the hook/liveness path.
 *   G3  Refuse, don't guess. `start()` never throws, the fs-event handler
 *       never throws, and a missing slug directory surfaces as
 *       `TailBatch.discoveryFailure` plus a counter — never as an empty
 *       success that reads like "no sessions".
 *   G5  Zero egress. chokidar and node built-ins only; no sockets.
 *   G7  In-memory only. Offsets live in the tailer and die with the process.
 *
 * Testability follows `tailer.ts`: the clock, the scheduler and the watcher
 * factory are all injected, so the unit tests neither sleep nor depend on
 * platform fs-event timing. One test does drive real chokidar over a real
 * temp directory, because a suite that only ever exercises the fake proves
 * nothing about the library we actually ship.
 */

import { join, resolve as resolvePath } from 'node:path';

import { watch as chokidarWatch } from 'chokidar';
import type { FSWatcher } from 'chokidar';

import {
  Debouncer,
  SessionTailer,
  resolveProjectsRoot,
  slugifyWorkspace,
  systemClock,
  systemScheduler,
} from '../parser/tailer.js';
import type {
  Clock,
  DiscoveryFailure,
  DiscoverySuccess,
  Scheduler,
  TailBatch,
  TailDiagnostics,
} from '../parser/tailer.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Quiet period before a poll. CC appends a transcript line per streamed
 * block, so a single assistant turn produces a rapid run of `change` events;
 * without coalescing the tailer would poll dozens of times for one turn.
 */
export const DEFAULT_DEBOUNCE_MS = 120;

/**
 * Ceiling on how long a continuous append burst may postpone a poll. A
 * session that appends faster than the debounce delay would otherwise starve
 * the UI indefinitely.
 */
export const DEFAULT_MAX_WAIT_MS = 750;

/**
 * How many directory levels below the slug directory chokidar traverses.
 *
 * The layout needs exactly two:
 *
 *   depth 0  <slug>/<sessionId>.jsonl                      main transcript
 *   depth 1  <slug>/<sessionId>/                           (session dir itself)
 *   depth 2  <slug>/<sessionId>/subagents/agent-*.jsonl    subagent + .meta.json
 *            <slug>/<sessionId>/tool-results/*.txt         offloaded payloads
 *
 * It is not larger "for headroom": a live slug directory also contains a
 * sibling `memory/` tree, and bounding the depth bounds how much of it we
 * traverse. If CC ever nests deeper, discovery — not the watcher — is the
 * thing that has to learn about it.
 */
export const WATCH_DEPTH = 2;

// ---------------------------------------------------------------------------
// Watcher injection seam
// ---------------------------------------------------------------------------

export interface WatchCallbacks {
  /** An fs event. `kind` is chokidar's event name; neither is interpreted. */
  onChange: (kind: string, path: string) => void;
  /** A watcher-level failure. Counted, never rethrown. */
  onError: (error: unknown) => void;
  /** Initial scan finished. Informational only; polling does not wait on it. */
  onReady: () => void;
}

export interface WatchHandle {
  close(): Promise<void>;
}

/**
 * Constructs a watcher for one directory. Injected so tests can drive fs
 * events synchronously and can raise a watcher-level error on demand — both
 * of which are untestable against the real library without sleeping.
 */
export type WatchFactory = (dir: string, callbacks: WatchCallbacks) => WatchHandle;

export interface ChokidarFactoryOptions {
  /** Forces chokidar's polling backend. Only useful in tests. */
  usePolling?: boolean;
  /** Polling interval when `usePolling` is set. */
  pollIntervalMs?: number;
}

/**
 * The production factory.
 *
 * `ignoreInitial: true` because {@link ProjectWatcher.start} does the initial
 * read itself through `poll()`; letting chokidar replay the tree as `add`
 * events would just debounce into the same poll a beat later.
 *
 * `awaitWriteFinish: false` because that feature is for whole-file writers and
 * adds latency we do not want: transcripts are append-only and the tailer's
 * partial-line buffering already handles a read that lands mid-line.
 */
export function createChokidarWatchFactory(
  options: ChokidarFactoryOptions = {},
): WatchFactory {
  return (dir, callbacks) => {
    const watcher: FSWatcher = chokidarWatch(dir, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      depth: WATCH_DEPTH,
      alwaysStat: false,
      awaitWriteFinish: false,
      atomic: false,
      ignorePermissionErrors: true,
      ...(options.usePolling !== undefined ? { usePolling: options.usePolling } : {}),
      ...(options.pollIntervalMs !== undefined ? { interval: options.pollIntervalMs } : {}),
    });
    watcher.on('all', (kind: string, path: string) => {
      callbacks.onChange(kind, path);
    });
    watcher.on('error', (error: unknown) => {
      callbacks.onError(error);
    });
    watcher.on('ready', () => {
      callbacks.onReady();
    });
    return {
      close: () => watcher.close(),
    };
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Everything the watcher would otherwise have thrown. Read by the extension
 * host for its status surface; asserted by the tests instead of prose.
 */
export interface WatcherDiagnostics {
  started: boolean;
  disposed: boolean;
  /** Set once the injected watcher reported its initial scan complete. */
  ready: boolean;
  projectsRoot: string;
  rootSource: 'env' | 'home';
  slug: string;
  watchDir: string;
  /** fs events accepted (post-dispose events are not counted). */
  fsEvents: number;
  /** Polls actually executed. Lower than `fsEvents` whenever debouncing works. */
  polls: number;
  /** Batches handed to `onBatch` without the callback throwing. */
  batches: number;
  /** Polls whose discovery sweep refused. */
  discoveryFailures: number;
  lastDiscoveryFailure?: DiscoveryFailure;
  /** Watcher-level errors, including a factory that threw on construction. */
  watchErrors: number;
  lastWatchError?: string;
  /** `SessionTailer.poll()` is documented never to throw. Counted anyway. */
  pollErrors: number;
  lastPollError?: string;
  /** `onBatch` threw. The watcher keeps running (G2). */
  callbackErrors: number;
  lastCallbackError?: string;
  /** The tailer's own cumulative counters, as of the last poll. */
  tail: TailDiagnostics;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// ProjectWatcher
// ---------------------------------------------------------------------------

export interface ProjectWatcherOptions {
  /** Absolute path of the workspace whose sessions we watch. */
  workspacePath: string;
  /** Receives every batch. May throw; the throw is counted, not propagated. */
  onBatch: (batch: TailBatch) => void;
  /** Overrides `resolveProjectsRoot` entirely. Mostly for tests. */
  projectsRoot?: string;
  /** Defaults to `process.env`. `CLAUDE_PROJECTS_ROOT` is read from here. */
  env?: Record<string, string | undefined>;
  /** Defaults to `os.homedir`. */
  homedir?: () => string;
  /** Restrict to these session ids. Omitted = every session in the slug dir. */
  sessionIds?: readonly string[];
  maxPartialBytes?: number;
  /** Quiet period. Defaults to {@link DEFAULT_DEBOUNCE_MS}. */
  debounceMs?: number;
  /** Burst ceiling. Defaults to {@link DEFAULT_MAX_WAIT_MS}. */
  maxWaitMs?: number;
  clock?: Clock;
  scheduler?: Scheduler;
  /** Defaults to {@link createChokidarWatchFactory}. */
  watchFactory?: WatchFactory;
}

/**
 * Turns filesystem change under one workspace's slug directory into debounced
 * {@link TailBatch} callbacks.
 *
 * Poll serialisation is explicit rather than incidental: `poll()` is async, fs
 * events keep arriving while it runs, and two overlapping polls would read the
 * same byte range twice or interleave lines from one append. A poll in flight
 * therefore sets a "run once more when you're done" flag instead of starting a
 * second one.
 */
export class ProjectWatcher {
  readonly workspacePath: string;
  readonly projectsRoot: string;
  readonly rootSource: 'env' | 'home';
  /** The slug we search for. The directory on disk may differ in case. */
  readonly slug: string;
  /** The directory handed to chokidar. */
  readonly watchDir: string;

  readonly #onBatch: (batch: TailBatch) => void;
  readonly #watchFactory: WatchFactory;
  readonly #tailer: SessionTailer;
  readonly #debouncer: Debouncer;

  #handle: WatchHandle | null = null;
  #started = false;
  #disposed = false;
  #ready = false;
  #polling = false;
  #pollQueued = false;

  #fsEvents = 0;
  #polls = 0;
  #batches = 0;
  #discoveryFailures = 0;
  #lastDiscoveryFailure?: DiscoveryFailure;
  #watchErrors = 0;
  #lastWatchError?: string;
  #pollErrors = 0;
  #lastPollError?: string;
  #callbackErrors = 0;
  #lastCallbackError?: string;

  constructor(options: ProjectWatcherOptions) {
    this.workspacePath = options.workspacePath;
    this.#onBatch = options.onBatch;
    this.#watchFactory = options.watchFactory ?? createChokidarWatchFactory();

    // The override contract lives in `resolveProjectsRoot` and is not
    // duplicated here: an explicit `projectsRoot` wins, otherwise
    // CLAUDE_PROJECTS_ROOT, otherwise `~/.claude/projects`.
    if (options.projectsRoot !== undefined) {
      this.projectsRoot = resolvePath(options.projectsRoot);
      this.rootSource = 'env';
    } else {
      const rootOptions: { env?: Record<string, string | undefined>; homedir?: () => string } = {};
      if (options.env !== undefined) rootOptions.env = options.env;
      if (options.homedir !== undefined) rootOptions.homedir = options.homedir;
      const resolved = resolveProjectsRoot(rootOptions);
      this.projectsRoot = resolved.root;
      this.rootSource = resolved.source;
    }

    this.slug = slugifyWorkspace(options.workspacePath);
    this.watchDir = join(this.projectsRoot, this.slug);

    this.#tailer = new SessionTailer({
      workspacePath: options.workspacePath,
      projectsRoot: this.projectsRoot,
      ...(options.sessionIds !== undefined ? { sessionIds: options.sessionIds } : {}),
      ...(options.maxPartialBytes !== undefined
        ? { maxPartialBytes: options.maxPartialBytes }
        : {}),
    });

    this.#debouncer = new Debouncer({
      delayMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      clock: options.clock ?? systemClock,
      scheduler: options.scheduler ?? systemScheduler,
      onFlush: () => {
        void this.#runPoll();
      },
    });
  }

  /** The most recent successful discovery, or `null`. Delegated to the tailer. */
  get lastDiscovery(): DiscoverySuccess | null {
    return this.#tailer.lastDiscovery;
  }

  /** Paths currently tracked by the underlying tailer, in registration order. */
  trackedFiles(): string[] {
    return this.#tailer.trackedFiles();
  }

  /** A copy. Callers cannot mutate watcher state through it. */
  get diagnostics(): WatcherDiagnostics {
    return {
      started: this.#started,
      disposed: this.#disposed,
      ready: this.#ready,
      projectsRoot: this.projectsRoot,
      rootSource: this.rootSource,
      slug: this.slug,
      watchDir: this.watchDir,
      fsEvents: this.#fsEvents,
      polls: this.#polls,
      batches: this.#batches,
      discoveryFailures: this.#discoveryFailures,
      watchErrors: this.#watchErrors,
      pollErrors: this.#pollErrors,
      callbackErrors: this.#callbackErrors,
      ...(this.#lastDiscoveryFailure !== undefined
        ? { lastDiscoveryFailure: this.#lastDiscoveryFailure }
        : {}),
      ...(this.#lastWatchError !== undefined ? { lastWatchError: this.#lastWatchError } : {}),
      ...(this.#lastPollError !== undefined ? { lastPollError: this.#lastPollError } : {}),
      ...(this.#lastCallbackError !== undefined
        ? { lastCallbackError: this.#lastCallbackError }
        : {}),
      tail: this.#tailer.diagnostics,
    };
  }

  /** Signals coalesced but not yet polled. */
  get pendingSignals(): number {
    return this.#debouncer.pendingSignals;
  }

  /**
   * Arm the watcher and take the first read.
   *
   * Never throws (G3). A factory that throws — an unreadable directory, a
   * platform limit — is recorded as a watch error and the initial poll still
   * runs, so a workspace whose slug directory cannot be watched still renders
   * whatever is already on disk.
   *
   * If the slug directory does not exist, chokidar is still armed on it and
   * the initial batch carries `discoveryFailure`. Whether chokidar picks up a
   * later creation of that directory was not measured here; a caller that
   * needs certainty should call {@link refresh}.
   */
  async start(): Promise<void> {
    if (this.#disposed || this.#started) return;
    this.#started = true;

    try {
      this.#handle = this.#watchFactory(this.watchDir, {
        onChange: (kind, path) => {
          this.#onFsEvent(kind, path);
        },
        onError: (error) => {
          this.#recordWatchError(error);
        },
        onReady: () => {
          this.#ready = true;
        },
      });
    } catch (error) {
      this.#recordWatchError(error);
    }

    await this.#runPoll();
  }

  /**
   * Force any pending signals to poll now. Synchronous by design: it drives
   * the debouncer, which starts the poll without waiting for it.
   */
  flush(): void {
    if (this.#disposed) return;
    this.#debouncer.flush();
  }

  /**
   * Manual refresh — poll now regardless of pending signals, and await it.
   * Pending signals are dropped because the poll that follows reads every
   * tracked file to its current end anyway.
   */
  async refresh(): Promise<void> {
    if (this.#disposed) return;
    this.#debouncer.cancel();
    await this.#runPoll();
  }

  /**
   * Close every watcher and cancel every timer.
   *
   * Returns a promise so tests can await the close, and satisfies
   * `vscode.Disposable` — whose `dispose(): any` ignores the return value —
   * at the same time. After this resolves, and in fact from the moment it is
   * called, `onBatch` is never invoked again: a poll already in flight checks
   * the disposed flag before delivering.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#debouncer.cancel();
    const handle = this.#handle;
    this.#handle = null;
    if (handle === null) return;
    try {
      await handle.close();
    } catch (error) {
      this.#recordWatchError(error);
    }
  }

  #onFsEvent(_kind: string, _path: string): void {
    if (this.#disposed) return;
    this.#fsEvents += 1;
    this.#debouncer.signal();
  }

  #recordWatchError(error: unknown): void {
    this.#watchErrors += 1;
    this.#lastWatchError = errorMessage(error);
  }

  async #runPoll(): Promise<void> {
    if (this.#disposed) return;
    if (this.#polling) {
      // Coalesce into the poll already running rather than racing it.
      this.#pollQueued = true;
      return;
    }
    this.#polling = true;
    try {
      do {
        this.#pollQueued = false;
        let batch: TailBatch;
        try {
          batch = await this.#tailer.poll();
        } catch (error) {
          // Unreachable by the tailer's contract; counted rather than trusted.
          this.#pollErrors += 1;
          this.#lastPollError = errorMessage(error);
          return;
        }
        this.#polls += 1;
        if (batch.discoveryFailure !== undefined) {
          this.#discoveryFailures += 1;
          this.#lastDiscoveryFailure = batch.discoveryFailure;
        }
        if (this.#disposed) return;
        this.#deliver(batch);
      } while (this.#pollQueued && !this.#disposed);
    } finally {
      this.#polling = false;
    }
  }

  #deliver(batch: TailBatch): void {
    try {
      this.#onBatch(batch);
      this.#batches += 1;
    } catch (error) {
      this.#callbackErrors += 1;
      this.#lastCallbackError = errorMessage(error);
    }
  }
}
