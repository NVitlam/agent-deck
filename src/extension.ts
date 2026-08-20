/**
 * Agent Deck — the extension host entry point (spec v2 §5, C6/C7).
 *
 * This is the file the whole Phase 3 build was failing on: `esbuild.config.mjs`
 * names `src/extension.ts` as its host entry and said so in its own header.
 *
 * It owns four things and implements none of them:
 *
 *   1. ACTIVATION.   Workspace-match, not command-only. If the open workspace
 *                    has no matching CC project slug the data path is never
 *                    constructed — no watcher, no socket, no timer.
 *   2. THE DATA PATH. `ProjectWatcher` -> `graftSession` -> `SessionModel`,
 *                    and `HookListener` -> `SessionModel.onHookEvent`, with the
 *                    JSONL inference source finally wired into the liveness
 *                    engine (see "carry-forward A" below).
 *   3. THE PANEL.    A `WebviewPanel` whose HTML comes from `bridge/html.ts`
 *                    and whose traffic goes through `bridge/messages.ts`.
 *   4. TEARDOWN.     Everything disposable is disposed, on panel close and on
 *                    `deactivate()`.
 *
 * ---------------------------------------------------------------------------
 * Carry-forward A — the JSONL half of the liveness merge
 * ---------------------------------------------------------------------------
 * Phase 2 shipped `LivenessEngine`'s hook/JSONL merge with its JSONL input
 * unconnected: the one production caller, `session.ts`, passes `{}` to
 * `observeJsonl`, which only says "this session exists". Phase 3 wave 1 built
 * the producer (`createJsonlInferenceSource`) but could not connect it, because
 * the engine's construction site is inside `SessionModel` and it did not own
 * that file.
 *
 * {@link AgentDeckDataPath} is the connection, and it is made from the outside:
 * the engine is constructed HERE with an `inferenceSource`, and handed to
 * `SessionModel` through `SessionModelOptions.liveness` — the seam whose own
 * doc comment says it exists "so the extension host can hand the same engine to
 * the hook listener". No file outside this package changes.
 *
 * The consequence, and it is the behaviour the phase is judged on: a session
 * with ZERO hook events now still moves live -> idle purely from its
 * transcript's mtime, because `liveness.ts`'s hookless branch is
 * `hasStopEntry !== true` (always true — `inference.ts` deliberately omits
 * `hasStopEntry`, there being no in-transcript Stop marker in any fixture) and
 * `recent` is then decided by `mtimeMs` alone.
 *
 * ---------------------------------------------------------------------------
 * When emissions happen, and why there are three triggers
 * ---------------------------------------------------------------------------
 * Emission is not "on change", because one of the three things that changes a
 * session's rendered state is not a change to anything we can observe:
 *
 *   a) CONTENT.  A watcher batch -> re-graft -> emit. Coalesced by
 *      {@link EMIT_COALESCE_MS} on top of the watcher's own debounce.
 *   b) LIVENESS FROM HOOKS. Every accepted hook event schedules an emit,
 *      coalesced the same way: CC fires PreToolUse/PostToolUse in pairs and a
 *      burst of six tool calls must not be six postMessage rounds.
 *   c) LIVENESS FROM THE CLOCK. A session that is `live` becomes `idle` when
 *      `now - lastActivityAt` crosses the threshold. Nothing appends, no hook
 *      fires, and no callback exists to hang this off — so there is a periodic
 *      {@link LIVENESS_TICK_MS} tick. Without it a finished session renders
 *      `live` forever, which is the single most visible way this UI could lie.
 *
 * All three funnel into {@link AgentDeckDataPath.pump}, and every timer is
 * created through an injected {@link Scheduler} so the tests drive them
 * deterministically and can assert none survives `dispose()`.
 *
 * ---------------------------------------------------------------------------
 * Grounding constraints
 * ---------------------------------------------------------------------------
 *   G1  Read-only. This file opens nothing for write. It never writes, offers
 *       to write, or edits a settings file — hook installation is a manual
 *       README paste block and stays one. `extension.test.ts` asserts the
 *       watched tree is byte-identical before and after a full run, and scans
 *       this file's own source for fs-write APIs.
 *   G2  Source separation. The content path (watcher -> graft -> model) and the
 *       liveness path (listener -> model.onHookEvent) share no failure path: a
 *       graft that throws is caught per session by `SessionModel`'s guard, and
 *       a listener that cannot bind leaves the watcher running.
 *   G3  Refuse, don't guess. A `graftSession` refusal is handed to
 *       `ingestGraftResult` unmodified, which renders the session
 *       `unsupported` with no tree. A port collision is an explicit error,
 *       never a silent rebind. A malformed webview message is dropped.
 *   G5  Zero egress. The `HookListener` loopback socket is the only socket, and
 *       the webview's CSP (from `html.ts`) forbids the renderer opening one.
 *   G7  Live-only, in memory. No `workspaceState`, no `globalState`, no cache
 *       file. Everything dies with the window.
 */

import * as vscode from 'vscode';

import { SessionBridge, isWebviewToHostMessage } from './bridge/messages.js';
import type { BridgeDegradedState } from './bridge/messages.js';
import { createNonce, webviewHtml } from './bridge/html.js';
import { correlateWorkspace } from './model/correlate.js';
import { graftSession } from './model/graft.js';
import type { GraftSessionOptions, GraftSessionResult } from './model/graft.js';
import { LivenessEngine } from './model/liveness.js';
import { SessionModel } from './model/session.js';
import type { SessionEmission } from './model/session.js';
import type { HostToWebviewMessage, WebviewToHostMessage } from './model/events.js';
import {
  DEFAULT_HOOK_PORT,
  HookListener,
  isHookListenerBindError,
} from './hooks/listener.js';
import { ProjectWatcher } from './watch/watcher.js';
import type { WatchFactory } from './watch/watcher.js';
import { createJsonlInferenceSource } from './watch/inference.js';
import { systemScheduler } from './parser/tailer.js';
import type { Scheduler, TailBatch, TimerHandle } from './parser/tailer.js';

// ---------------------------------------------------------------------------
// (a) Settings
// ---------------------------------------------------------------------------

/** The configuration section every setting lives under. */
export const CONFIG_SECTION = 'agentDeck';

/**
 * Hard-coded default port, shared with the README's paste block.
 *
 * Re-exported from the listener rather than restated: two literals that must
 * agree is the defect `bridge/contract.ts` exists to document.
 */
export const DEFAULT_PORT = DEFAULT_HOOK_PORT;

/**
 * 120 s. Not lower: below ~60 s a single long tool call appends nothing for its
 * duration and a healthy session flaps live -> idle -> live.
 */
export const DEFAULT_LIVENESS_THRESHOLD_MS = 120_000;

/** 8 KB. Forwarded to the grafter, which defaults to 512 on its own. */
export const DEFAULT_PREVIEW_BYTES = 8192;

/**
 * How often liveness is recomputed with no other stimulus. See trigger (c) in
 * the module header. Deliberately NOT a user setting: three settings were
 * decided for this phase and inventing a fourth is scope, not configurability.
 */
export const LIVENESS_TICK_MS = 5_000;

/** Quiet period before an emission. Coalesces hook bursts and batch storms. */
export const EMIT_COALESCE_MS = 100;

export interface AgentDeckSettings {
  port: number;
  livenessThresholdMs: number;
  previewBytes: number;
}

/** The narrow slice of `vscode.WorkspaceConfiguration` settings reading needs. */
export interface SettingsReader {
  get(key: string): unknown;
}

/**
 * Accepted ranges. A value outside them is a user typo, not a request:
 * `port: 0` would mean "bind ephemeral", which the port decision explicitly
 * refuses, and `previewBytes: -1` has no meaning at all.
 */
const PORT_MIN = 1;
const PORT_MAX = 65_535;
const THRESHOLD_MIN_MS = 1_000;
const THRESHOLD_MAX_MS = 24 * 60 * 60 * 1_000;
const PREVIEW_MIN_BYTES = 0;
const PREVIEW_MAX_BYTES = 1_048_576;

function integerInRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number') return fallback;
  if (!Number.isSafeInteger(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

/**
 * Read the three settings, falling back to the documented default on anything
 * unusable.
 *
 * Falling back rather than refusing is the right shape HERE and only here: the
 * defaults are declared in `package.json`, so an out-of-range value is a value
 * the user typed over a working default, and the honest response is to use the
 * default the manifest already promised — not to render nothing. G3's "refuse,
 * don't guess" governs data we were given about a session; it does not require
 * an extension to fail to start because a number was mistyped.
 */
export function readSettings(reader: SettingsReader | undefined): AgentDeckSettings {
  if (reader === undefined) {
    return {
      port: DEFAULT_PORT,
      livenessThresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      previewBytes: DEFAULT_PREVIEW_BYTES,
    };
  }
  return {
    port: integerInRange(reader.get('port'), PORT_MIN, PORT_MAX, DEFAULT_PORT),
    livenessThresholdMs: integerInRange(
      reader.get('livenessThresholdMs'),
      THRESHOLD_MIN_MS,
      THRESHOLD_MAX_MS,
      DEFAULT_LIVENESS_THRESHOLD_MS,
    ),
    previewBytes: integerInRange(
      reader.get('previewBytes'),
      PREVIEW_MIN_BYTES,
      PREVIEW_MAX_BYTES,
      DEFAULT_PREVIEW_BYTES,
    ),
  };
}

// ---------------------------------------------------------------------------
// (b) The data path
// ---------------------------------------------------------------------------

/** What {@link AgentDeckDataPath} hands its consumer on every emission. */
export interface DataPathEmission {
  emission: SessionEmission;
  degraded: BridgeDegradedState;
}

export interface DataPathOptions {
  /** Absolute path of the workspace VS Code has open. */
  workspacePath: string;
  settings: AgentDeckSettings;
  /** Receives every emission. Throwing is caught and counted, never fatal. */
  onEmission: (emission: DataPathEmission) => void;
  /** User-visible failures: a port collision, an unexpected throw. */
  onError?: (error: unknown) => void;
  /** Overrides `resolveProjectsRoot` entirely. Tests and fixture replay. */
  projectsRoot?: string;
  env?: Record<string, string | undefined>;
  homedir?: () => string;
  /** Injected clock for the liveness engine. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected timers. Defaults to {@link systemScheduler}. */
  scheduler?: Scheduler;
  /** Forwarded to {@link ProjectWatcher}. Tests drive fs events synchronously. */
  watchFactory?: WatchFactory;
  /** Watcher debounce override, forwarded verbatim. */
  debounceMs?: number;
  maxWaitMs?: number;
  /** Defaults to {@link EMIT_COALESCE_MS}. */
  coalesceMs?: number;
  /** Defaults to {@link LIVENESS_TICK_MS}. 0 disables the tick. */
  tickMs?: number;
  /**
   * The content path. Defaults to {@link graftSession}.
   *
   * Injected for exactly one reason, and it is not convenience: G2 says a
   * content-side failure must never reach the liveness side, and that property
   * is only assertable if a test can make the content side FAIL. Without this
   * seam the `catch` in `#graft` is unreachable from any test — rethrowing from
   * it instead of refusing left the whole suite green, which is how an
   * architectural bet turns into an untested comment.
   *
   * Production never passes this.
   */
  graft?: (
    mainTranscript: string,
    options: GraftSessionOptions,
  ) => Promise<GraftSessionResult>;
}

export interface DataPathDiagnostics {
  started: boolean;
  disposed: boolean;
  /** True once the listener socket is bound. */
  listening: boolean;
  /** Set when `HookListener.start()` refused. Never followed by a rebind. */
  bindError?: { code: string; port: number; message: string };
  emissions: number;
  /** Sessions re-grafted since start. */
  grafts: number;
  /** Of those, ones that returned `ok: false` (a G3 refusal, not a throw). */
  graftRefusals: number;
  /** `graftSession` threw outright. Should stay 0; counted so it cannot crash. */
  graftErrors: number;
  lastGraftError?: string;
  /** `onEmission` threw. The data path keeps running (G2). */
  consumerErrors: number;
  /** Timers currently armed. Must be 0 after {@link AgentDeckDataPath.dispose}. */
  timersArmed: number;
}

/**
 * Everything between the filesystem/socket and the panel.
 *
 * Deliberately knows nothing about `vscode`: it takes a callback and a few
 * seams, so the tests exercise the REAL `SessionModel`, `ProjectWatcher`,
 * `HookListener` and `LivenessEngine` against fixtures with no editor present.
 */
export class AgentDeckDataPath {
  readonly workspacePath: string;
  readonly settings: AgentDeckSettings;
  readonly liveness: LivenessEngine;
  readonly model: SessionModel;
  readonly listener: HookListener;
  readonly watcher: ProjectWatcher;

  readonly #onEmission: (emission: DataPathEmission) => void;
  readonly #onError: (error: unknown) => void;
  readonly #scheduler: Scheduler;
  readonly #coalesceMs: number;
  readonly #tickMs: number;
  readonly #graftFn: (
    mainTranscript: string,
    options: GraftSessionOptions,
  ) => Promise<GraftSessionResult>;

  /** Session ids whose transcript changed and that need a fresh whole-session graft. */
  readonly #dirty = new Set<string>();
  /**
   * The drain currently in flight, or null.
   *
   * A promise rather than a boolean, and that distinction is load-bearing: the
   * watcher's initial poll calls `#onBatch` synchronously from inside
   * `watcher.start()`, which starts a drain that is still pending when
   * `start()` resumes. A boolean would make `start()`'s own `await #drain()`
   * return immediately, so `start()` would resolve before the first tree had
   * been grafted — a race that would surface as an empty first snapshot.
   */
  #drainPromise: Promise<void> | null = null;

  #emitTimer: TimerHandle | null = null;
  #tickTimer: TimerHandle | null = null;
  #started = false;
  #disposed = false;

  #emissions = 0;
  #grafts = 0;
  #graftRefusals = 0;
  #graftErrors = 0;
  #lastGraftError?: string;
  #consumerErrors = 0;
  #bindError?: { code: string; port: number; message: string };

  constructor(options: DataPathOptions) {
    this.workspacePath = options.workspacePath;
    this.settings = options.settings;
    this.#onEmission = options.onEmission;
    this.#onError = options.onError ?? ((): void => {});
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#coalesceMs = options.coalesceMs ?? EMIT_COALESCE_MS;
    this.#tickMs = options.tickMs ?? LIVENESS_TICK_MS;
    this.#graftFn = options.graft ?? graftSession;

    // ---- carry-forward A: the connection, made from outside session.ts ----
    const inferenceSource = createJsonlInferenceSource({
      workspacePath: options.workspacePath,
      ...(options.projectsRoot !== undefined ? { projectsRoot: options.projectsRoot } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.homedir !== undefined ? { homedir: options.homedir } : {}),
    });
    this.liveness = new LivenessEngine({
      inferenceSource,
      mtimeThresholdMs: options.settings.livenessThresholdMs,
      ...(options.now !== undefined ? { now: options.now } : {}),
      // The socket is not bound yet. Saying otherwise would render a healthy
      // banner for the window between activation and a successful bind.
      hookListenerRunning: false,
    });
    this.model = new SessionModel({
      workspacePath: options.workspacePath,
      liveness: this.liveness,
      previewBytes: options.settings.previewBytes,
    });

    this.listener = new HookListener({ port: options.settings.port });
    this.watcher = new ProjectWatcher({
      workspacePath: options.workspacePath,
      onBatch: (batch: TailBatch) => {
        this.#onBatch(batch);
      },
      ...(options.projectsRoot !== undefined ? { projectsRoot: options.projectsRoot } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.homedir !== undefined ? { homedir: options.homedir } : {}),
      ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
      ...(options.maxWaitMs !== undefined ? { maxWaitMs: options.maxWaitMs } : {}),
      ...(options.watchFactory !== undefined ? { watchFactory: options.watchFactory } : {}),
    });
  }

  get diagnostics(): DataPathDiagnostics {
    return {
      started: this.#started,
      disposed: this.#disposed,
      listening: this.listener.listening,
      emissions: this.#emissions,
      grafts: this.#grafts,
      graftRefusals: this.#graftRefusals,
      graftErrors: this.#graftErrors,
      consumerErrors: this.#consumerErrors,
      timersArmed: (this.#emitTimer === null ? 0 : 1) + (this.#tickTimer === null ? 0 : 1),
      ...(this.#bindError !== undefined ? { bindError: this.#bindError } : {}),
      ...(this.#lastGraftError !== undefined ? { lastGraftError: this.#lastGraftError } : {}),
    };
  }

  /**
   * Bind the socket, arm the watcher, take the first read, arm the tick.
   *
   * Never throws. A bind failure is recorded, surfaced through `onError` and
   * marks the tap degraded (`listenerDown`); the content path starts anyway,
   * which is G2 in one line — the tree still renders with no liveness.
   */
  async start(): Promise<void> {
    if (this.#disposed || this.#started) return;
    this.#started = true;

    this.listener.subscribe(this.model.onHookEvent);
    this.listener.subscribe(() => {
      this.#scheduleEmit();
    });

    try {
      await this.listener.start();
      this.liveness.setHookListenerRunning(true);
    } catch (error) {
      // Explicit, never a silent rebind: the port is a setting and a collision
      // is the user's to resolve.
      if (isHookListenerBindError(error)) {
        this.#bindError = {
          code: error.code,
          port: error.port,
          message: error.message,
        };
      } else {
        this.#bindError = {
          code: 'UNKNOWN',
          port: this.settings.port,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      // Nothing to set on the engine here, and that is deliberate rather than
      // an omission: it was CONSTRUCTED with `hookListenerRunning: false`, and
      // only a successful bind above flips it true. A `setHookListenerRunning(
      // false)` on this line would be unreachable-in-effect code — a mutation
      // check confirmed removing it changes no behaviour — and unreachable
      // safety code is the kind that rots into a false assurance.
      this.#onError(error);
    }

    if (this.#disposed) return;
    await this.watcher.start();
    if (this.#disposed) return;
    await this.#drain();
    this.#armTick();
    this.pump();
  }

  /**
   * Emit now: snapshot + diffs since the last emission, plus the tap's health.
   *
   * A consumer that throws is counted and swallowed. The panel is a renderer;
   * it must not be able to stop the model from advancing.
   */
  pump(): void {
    if (this.#disposed) return;
    this.#cancelEmitTimer();
    let payload: DataPathEmission;
    try {
      payload = {
        emission: this.model.emit(),
        degraded: this.liveness.degradedState(),
      };
    } catch (error) {
      // `emit()` is documented not to throw; counted rather than trusted.
      this.#consumerErrors += 1;
      this.#onError(error);
      return;
    }
    this.#emissions += 1;
    try {
      this.#onEmission(payload);
    } catch {
      this.#consumerErrors += 1;
    }
  }

  /** Runtime setting change. Only the threshold can move without a reload. */
  setLivenessThresholdMs(ms: number): void {
    this.liveness.setMtimeThresholdMs(ms);
    this.#scheduleEmit();
  }

  /**
   * Close the socket, close the watcher, cancel every timer.
   *
   * After this resolves nothing this object created is still alive: a leaked
   * chokidar watcher or a bound socket after `deactivate()` is a defect, and
   * `extension.test.ts` asserts `timersArmed === 0` and `listening === false`.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelEmitTimer();
    this.#cancelTick();
    this.#dirty.clear();
    await this.watcher.dispose();
    await this.listener.stop();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * A watcher batch: register what discovery found, mark what changed dirty,
   * forget what vanished, then re-graft.
   *
   * The tailer's incremental lines are used as a CHANGE SIGNAL, not as content:
   * the authoritative tree comes from `graftSession`, which fingerprints the
   * whole session first. Grafting incrementally from tail lines would mean
   * accepting content before the layout was asserted, which is exactly the
   * partial tree G3 forbids.
   */
  #onBatch(batch: TailBatch): void {
    if (this.#disposed) return;

    if (batch.discoveryFailure !== undefined) {
      // Counted by the watcher; not surfaced as an error dialog. A workspace
      // whose slug directory has not appeared yet is a normal state, not a
      // fault, and nagging about it would be the "no nagging" defect in
      // another costume.
      return;
    }

    const discovery = this.watcher.lastDiscovery;
    if (discovery === null) return;

    const known = new Set<string>();
    for (const session of discovery.sessions) {
      known.add(session.sessionId);
      const before = this.model.hasSession(session.sessionId);
      this.model.registerSession({
        sessionId: session.sessionId,
        projectSlug: discovery.slug,
      });
      // A newly discovered session has never been grafted, so it is dirty even
      // though this batch may carry none of its lines.
      if (!before) this.#dirty.add(session.sessionId);
    }

    for (const line of batch.lines) {
      if (known.has(line.sessionId)) this.#dirty.add(line.sessionId);
    }

    for (const sessionId of this.model.sessionIds()) {
      if (!known.has(sessionId)) {
        this.model.forgetSession(sessionId);
        this.#dirty.delete(sessionId);
      }
    }

    void this.#drain();
  }

  /**
   * Re-graft every dirty session, serially.
   *
   * Serial rather than parallel: `graftSession` reads whole transcripts, and a
   * burst across six sessions concurrently is six times the fd pressure for no
   * latency the user can perceive. Re-entrancy is folded into the running
   * drain the same way `ProjectWatcher` folds overlapping polls.
   */
  #drain(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const inFlight = this.#drainPromise;
    // Joining the running drain is correct rather than merely cheap: the loop
    // below re-reads `#dirty` every round, so a session marked dirty while a
    // drain is running is picked up by that same drain.
    if (inFlight !== null) return inFlight;
    const started = this.#runDrain().finally(() => {
      this.#drainPromise = null;
    });
    this.#drainPromise = started;
    return started;
  }

  async #runDrain(): Promise<void> {
    while (this.#dirty.size > 0 && !this.#disposed) {
      const discovery = this.watcher.lastDiscovery;
      if (discovery === null) break;
      const pending = [...this.#dirty];
      this.#dirty.clear();
      for (const sessionId of pending) {
        if (this.#disposed) return;
        const session = discovery.sessions.find((s) => s.sessionId === sessionId);
        if (session === undefined) continue;
        await this.#graft(sessionId, discovery.slug, session.mainTranscript);
      }
    }
    if (!this.#disposed) this.#scheduleEmit();
  }

  async #graft(sessionId: string, slug: string, mainTranscript: string): Promise<void> {
    this.#grafts += 1;
    try {
      const result = await this.#graftFn(mainTranscript, {
        // `agentDeck.previewBytes`. Since Phase 4 this is the ONE ceiling:
        // `graftSession` gives the parse/redaction layer the same number
        // (floored at 8192) and the grafter's previews use it directly, so a
        // payload is cut once and the marker states its real original size.
        //
        // The grafter's own default is 512, so DROPPING this argument does not
        // fail — it silently shrinks every preview by 16x. `extension.test.ts`
        // asserts the truncation marker's kept-byte count equals this value,
        // at 2048, 4096, 8192 and 16384, because a preview that is merely
        // "long" proves nothing about which number produced it. Verified red
        // by deleting this line: 4 of 42 tests in that file fail.
        previewBytes: this.settings.previewBytes,
      });
      if (this.#disposed) return;
      if (!result.ok) this.#graftRefusals += 1;
      // Handed over unmodified: `ingestGraftResult` turns `ok: false` into a
      // refusal with no tree. Nothing here inspects the mismatch or salvages
      // a partial result.
      this.model.ingestGraftResult(sessionId, slug, result);
    } catch (error) {
      // G2: a content-side throw is confined to this session. `refuseSession`
      // is the model's own vocabulary for it.
      this.#graftErrors += 1;
      this.#lastGraftError = error instanceof Error ? error.message : String(error);
      if (this.#disposed) return;
      this.model.refuseSession(sessionId, slug, {
        kind: 'schemaMismatch',
        reason: `graft failed: ${this.#lastGraftError}`,
      });
    }
  }

  #scheduleEmit(): void {
    if (this.#disposed || this.#emitTimer !== null) return;
    this.#emitTimer = this.#scheduler.setTimer(() => {
      this.#emitTimer = null;
      this.pump();
    }, this.#coalesceMs);
  }

  #cancelEmitTimer(): void {
    if (this.#emitTimer === null) return;
    this.#scheduler.clearTimer(this.#emitTimer);
    this.#emitTimer = null;
  }

  #armTick(): void {
    if (this.#disposed || this.#tickMs <= 0) return;
    this.#tickTimer = this.#scheduler.setTimer(() => {
      this.#tickTimer = null;
      this.pump();
      this.#armTick();
    }, this.#tickMs);
  }

  #cancelTick(): void {
    if (this.#tickTimer === null) return;
    this.#scheduler.clearTimer(this.#tickTimer);
    this.#tickTimer = null;
  }
}

// ---------------------------------------------------------------------------
// (c) The panel
// ---------------------------------------------------------------------------

/** Undo a subscription. Returned rather than a Disposable to keep this vscode-free. */
export type Unsubscribe = () => void;

/**
 * The slice of `vscode.WebviewPanel` the controller uses.
 *
 * Narrow and hand-adapted (see {@link adaptWebviewPanel}) rather than the real
 * type, so the panel logic is exercised by the suite against a plain object
 * instead of against a mock pretending to be the whole editor API.
 */
export interface PanelSurface {
  /** `vscode.Webview.cspSource`. */
  readonly cspSource: string;
  /** Assign `vscode.Webview.html`. Called once, at construction. */
  setHtml(html: string): void;
  /**
   * `webview.asWebviewUri(Uri.joinPath(extensionUri, ...segments))`, stringified.
   * Segments rather than a URI so this port needs no `vscode.Uri`.
   */
  asWebviewUri(...segments: string[]): string;
  postMessage(message: HostToWebviewMessage): void;
  onDidReceiveMessage(handler: (raw: unknown) => void): Unsubscribe;
  /** Fired when the webview becomes visible again — i.e. the bundle re-ran. */
  onDidBecomeVisible(handler: () => void): Unsubscribe;
  onDidDispose(handler: () => void): Unsubscribe;
  reveal(): void;
  dispose(): void;
}

export interface PanelControllerOptions {
  panel: PanelSurface;
  /** Valid, guarded webview -> host messages. Anything else never reaches this. */
  onMessage?: (message: WebviewToHostMessage) => void;
  /** The webview (re)loaded and holds nothing; send it a full snapshot. */
  onNeedsSnapshot?: () => void;
  /** The panel was closed by the user. */
  onDispose?: () => void;
  /** Injected so a test can assert the exact document. Defaults to {@link createNonce}. */
  nonce?: string;
}

export interface PanelCounters {
  /** Messages arriving from the webview, valid or not. */
  messagesReceived: number;
  /** Messages that failed {@link isWebviewToHostMessage} and were dropped. */
  messagesDropped: number;
  /** Times the bridge was reset because the webview reloaded. */
  reloads: number;
}

/** Where the built webview assets live inside the packaged extension. */
export const WEBVIEW_SCRIPT_SEGMENTS = ['dist', 'webview', 'main.js'] as const;
export const WEBVIEW_STYLE_SEGMENTS = ['dist', 'webview', 'main.css'] as const;

/**
 * One panel: its document, its bridge, and its inbound guard.
 *
 * The HTML is NOT written here. `webviewHtml` owns the document and the CSP,
 * and this class supplies only webview-scoped URIs, a fresh nonce and
 * `cspSource`. There is deliberately no second CSP anywhere in this file.
 */
export class PanelController {
  readonly bridge: SessionBridge;

  readonly #panel: PanelSurface;
  readonly #onMessage: (message: WebviewToHostMessage) => void;
  readonly #onNeedsSnapshot: () => void;
  readonly #subscriptions: Unsubscribe[] = [];

  #disposed = false;
  readonly #counts: PanelCounters = {
    messagesReceived: 0,
    messagesDropped: 0,
    reloads: 0,
  };

  constructor(options: PanelControllerOptions) {
    this.#panel = options.panel;
    this.#onMessage = options.onMessage ?? ((): void => {});
    this.#onNeedsSnapshot = options.onNeedsSnapshot ?? ((): void => {});

    this.bridge = new SessionBridge({
      postMessage: (message: HostToWebviewMessage): void => {
        this.#panel.postMessage(message);
      },
    });

    this.#panel.setHtml(
      webviewHtml({
        scriptUri: this.#panel.asWebviewUri(...WEBVIEW_SCRIPT_SEGMENTS),
        styleUri: this.#panel.asWebviewUri(...WEBVIEW_STYLE_SEGMENTS),
        nonce: options.nonce ?? createNonce(),
        cspSource: this.#panel.cspSource,
      }),
    );

    this.#subscriptions.push(
      this.#panel.onDidReceiveMessage((raw: unknown) => {
        this.#receive(raw);
      }),
      // VS Code re-runs the bundle when a hidden panel is restored (the default
      // is `retainContextWhenHidden: false`), so the document on the other end
      // is a NEW one that knows nothing. Resetting the bridge is what stops the
      // next diff being applied to a state that no longer exists.
      this.#panel.onDidBecomeVisible(() => {
        this.#counts.reloads += 1;
        this.bridge.reset();
        this.#onNeedsSnapshot();
      }),
    );
    if (options.onDispose !== undefined) {
      const onDispose = options.onDispose;
      this.#subscriptions.push(this.#panel.onDidDispose(onDispose));
    }
  }

  get counters(): PanelCounters {
    return { ...this.#counts };
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Push one emission to the webview. Degraded is sent on transition only. */
  publish(payload: DataPathEmission): void {
    if (this.#disposed) return;
    this.bridge.publish(payload.emission);
    this.bridge.publishDegraded(payload.degraded);
  }

  reveal(): void {
    if (this.#disposed) return;
    this.#panel.reveal();
  }

  /** Drop every subscription and close the panel. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const unsubscribe of this.#subscriptions.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // A disposed subscription that throws must not block the rest.
      }
    }
    try {
      this.#panel.dispose();
    } catch {
      // Already gone; that is the outcome we wanted.
    }
  }

  /**
   * The untrusted boundary. `isWebviewToHostMessage` is the whole gate and
   * anything it refuses is dropped — not coerced, not logged as an error, not
   * partially acted on.
   */
  #receive(raw: unknown): void {
    this.#counts.messagesReceived += 1;
    if (!isWebviewToHostMessage(raw)) {
      this.#counts.messagesDropped += 1;
      return;
    }
    try {
      this.#onMessage(raw);
    } catch {
      // A handler that throws must not take the extension host down.
      this.#counts.messagesDropped += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// (d) The host — activation-independent, so it is testable without vscode
// ---------------------------------------------------------------------------

export interface AgentDeckHostOptions extends DataPathOptions {
  /**
   * Constructs the panel. Called at most once per open panel; a second `open()`
   * reveals the existing one instead.
   */
  createPanel: () => PanelSurface;
  /** Injected so a test can assert the emitted document byte for byte. */
  nonce?: string;
}

/**
 * The data path plus at most one panel.
 *
 * The data path runs whether or not a panel is open: liveness is a
 * wall-clock-sensitive fact, and a panel opened after five minutes of watching
 * should show the truth immediately rather than start warming up.
 */
export class AgentDeckHost {
  readonly dataPath: AgentDeckDataPath;

  readonly #createPanel: () => PanelSurface;
  readonly #nonce?: string;
  #panel: PanelController | null = null;
  #panelsCreated = 0;
  #disposed = false;

  constructor(options: AgentDeckHostOptions) {
    const { createPanel, nonce, onEmission, ...rest } = options;
    this.#createPanel = createPanel;
    if (nonce !== undefined) this.#nonce = nonce;
    this.dataPath = new AgentDeckDataPath({
      ...rest,
      onEmission: (payload: DataPathEmission) => {
        this.#panel?.publish(payload);
        onEmission(payload);
      },
    });
  }

  get panelsCreated(): number {
    return this.#panelsCreated;
  }

  get panel(): PanelController | null {
    return this.#panel;
  }

  async start(): Promise<void> {
    await this.dataPath.start();
  }

  /** Open the panel, or reveal it if it is already open. */
  open(): PanelController | null {
    if (this.#disposed) return null;
    const existing = this.#panel;
    if (existing !== null) {
      existing.reveal();
      return existing;
    }
    const controller = new PanelController({
      panel: this.#createPanel(),
      ...(this.#nonce !== undefined ? { nonce: this.#nonce } : {}),
      onNeedsSnapshot: () => {
        this.dataPath.pump();
      },
      onDispose: () => {
        this.#panel = null;
      },
      onMessage: () => {
        // `expandNode` and `selectSession` are pure view state and the webview
        // owns them (see `webview/store.ts`). The host validates and drops
        // them here rather than acting: the moment it acted, the webview would
        // stop being a pure renderer.
      },
    });
    this.#panelsCreated += 1;
    this.#panel = controller;
    // A brand-new webview knows nothing, so its first message must be a full
    // snapshot. `SessionBridge` guarantees that; pumping supplies the content.
    this.dataPath.pump();
    return controller;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#panel?.dispose();
    this.#panel = null;
    await this.dataPath.dispose();
  }
}

// ---------------------------------------------------------------------------
// (e) Activation
// ---------------------------------------------------------------------------

/** The command declared in `contributes.commands`. */
export const OPEN_COMMAND = 'agentDeck.open';

/** The panel's view type and title. */
export const PANEL_VIEW_TYPE = 'agentDeck.panel';
export const PANEL_TITLE = 'Agent Deck';

/** Module-level, because `deactivate()` gets no argument. In memory only (G7). */
let activeHost: AgentDeckHost | null = null;

/** Why the data path did not start, for the command to explain rather than fail silently. */
let inactiveReason: string | null = null;

/** Test seam: the live host, or null. Never read by production code. */
export function currentHost(): AgentDeckHost | null {
  return activeHost;
}

function firstWorkspacePath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders === undefined || folders.length === 0) return undefined;
  return folders[0]?.uri.fsPath;
}

/**
 * Adapt a real `vscode.WebviewPanel` to {@link PanelSurface}.
 *
 * The one place where the editor API and this file's own vocabulary meet.
 * Written out rather than relying on structural assignability, so a change in
 * either shape is a compile error here instead of a silent behavioural gap.
 */
export function adaptWebviewPanel(
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
): PanelSurface {
  return {
    get cspSource(): string {
      return panel.webview.cspSource;
    },
    setHtml: (html: string): void => {
      panel.webview.html = html;
    },
    asWebviewUri: (...segments: string[]): string =>
      panel.webview
        .asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments))
        .toString(),
    postMessage: (message: HostToWebviewMessage): void => {
      // The `Thenable<boolean>` is dropped on purpose: `false` means the panel
      // is disposed, which arrives on `onDidDispose` anyway, and awaiting it
      // would serialise the bridge behind the renderer.
      void panel.webview.postMessage(message);
    },
    onDidReceiveMessage: (handler: (raw: unknown) => void): Unsubscribe => {
      const subscription = panel.webview.onDidReceiveMessage((raw: unknown) => {
        handler(raw);
      });
      return () => {
        subscription.dispose();
      };
    },
    onDidBecomeVisible: (handler: () => void): Unsubscribe => {
      const subscription = panel.onDidChangeViewState(() => {
        if (panel.visible) handler();
      });
      return () => {
        subscription.dispose();
      };
    },
    onDidDispose: (handler: () => void): Unsubscribe => {
      const subscription = panel.onDidDispose(() => {
        handler();
      });
      return () => {
        subscription.dispose();
      };
    },
    reveal: (): void => {
      panel.reveal();
    },
    dispose: (): void => {
      panel.dispose();
    },
  };
}

/**
 * Activate.
 *
 * Order matters and is the point of the whole function:
 *
 *   1. Find the open workspace. None -> nothing starts.
 *   2. Correlate it to a CC project slug. No match -> NOTHING starts: no
 *      watcher, no socket, no timer. That is the price of activating on
 *      `onStartupFinished` instead of on the command, and containing it here
 *      is what makes the choice defensible.
 *   3. Only then build the host and start the data path.
 *
 * The command is registered in BOTH cases, and this is a deliberate departure
 * from a literal "do nothing at all": `contributes.commands` puts "Agent Deck:
 * Open" in the palette whether or not this workspace matches, and a registered
 * command that explains why there is nothing to show beats VS Code's
 * "command not found" error. Registering a command allocates no watcher, no
 * socket and no timer, so the containment the decision was actually about is
 * unaffected.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_COMMAND, () => {
      const host = activeHost;
      if (host === null) {
        void vscode.window.showInformationMessage(
          inactiveReason ??
            'Agent Deck: this workspace has no Claude Code project directory yet.',
        );
        return;
      }
      host.open();
    }),
  );

  const workspacePath = firstWorkspacePath();
  if (workspacePath === undefined) {
    inactiveReason = 'Agent Deck: open a folder to see its Claude Code sessions.';
    return;
  }

  const correlation = await correlateWorkspace(workspacePath);
  if (!correlation.ok) {
    inactiveReason = `Agent Deck: no Claude Code sessions for this workspace (${correlation.failure.kind}).`;
    return;
  }
  inactiveReason = null;

  const settings = readSettings(vscode.workspace.getConfiguration(CONFIG_SECTION));
  const extensionUri = context.extensionUri;

  const host = new AgentDeckHost({
    workspacePath,
    settings,
    createPanel: () =>
      adaptWebviewPanel(
        vscode.window.createWebviewPanel(
          PANEL_VIEW_TYPE,
          PANEL_TITLE,
          vscode.ViewColumn.Beside,
          {
            enableScripts: true,
            // The webview may read the built bundle and nothing else. Combined
            // with the CSP in `html.ts`, the renderer's reachable surface is
            // two files.
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
          },
        ),
        extensionUri,
      ),
    onEmission: () => {
      // The panel is fed by AgentDeckHost itself; nothing else consumes
      // emissions today. Kept as a required option so a future consumer is an
      // argument rather than an edit to the host.
    },
    onError: (error: unknown) => {
      if (isHookListenerBindError(error)) {
        void vscode.window.showErrorMessage(
          `Agent Deck: port ${error.port} is unavailable (${error.code}). ` +
            `Liveness is unavailable until it is free, or set "${CONFIG_SECTION}.port" ` +
            'to a different port and reload. Agent Deck will not pick a port for you.',
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Agent Deck: ${message}`);
    },
  });

  activeHost = host;
  context.subscriptions.push({
    dispose: () => {
      void host.dispose();
    },
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) return;
      const next = readSettings(vscode.workspace.getConfiguration(CONFIG_SECTION));
      // Only the threshold can move without a reload: the port owns a bound
      // socket and `previewBytes` is baked into every grafted node. Rebinding
      // or re-grafting silently under the user is worse than requiring a
      // reload for two settings that change once.
      host.dataPath.setLivenessThresholdMs(next.livenessThresholdMs);
    }),
  );

  await host.start();
}

/** Dispose everything. A bound socket or a live watcher after this is a defect. */
export async function deactivate(): Promise<void> {
  const host = activeHost;
  activeHost = null;
  inactiveReason = null;
  if (host === null) return;
  await host.dispose();
}
