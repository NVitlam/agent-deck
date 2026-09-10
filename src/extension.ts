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
 * Phase 5 — the SECOND engine (PLAN.md DoD 5.2 / 5.3)
 * ---------------------------------------------------------------------------
 * There are now two observation engines behind one `SessionState` stream.
 * {@link OpenCodeEnginePath} is the OpenCode half: it discovers projects by
 * matching `project.worktree` against the open workspace folders, reads content
 * through `readOpenCodeEngine`, and chains `OcLivenessEngine` with a clock and
 * a poll trigger supplied FROM HERE (Phase 4 Amendment A2 keeps both out of
 * that module; gate amendment B5 puts the chaining in 5.2).
 *
 * The two halves share no clock, no scheduler, no watcher, no socket and no
 * `try` block. {@link AgentDeckDataPath.pump} assembles each independently and
 * abandons a round only when BOTH failed, which is DoD 5.3's isolation stated
 * as code rather than as a comment; `src/model/isolation.test.ts` drives both
 * directions plus the hook-listener-down case.
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
 *   G7  Live-only, in memory — AMENDED for v0.7.0 (spec section C; PLAN.md's
 *       Grounding Contract). The amended text, verbatim:
 *
 *         "No persistence under any engine's directory; no session replay. The
 *         extension MAY keep an append-only, retention-bounded, user-clearable,
 *         setting-disableable history of derived StatsRecords under
 *         context.globalStorageUri. The store is never read back into
 *         SessionState; it feeds the Trends view and the API only."
 *
 *       So the sentence this line carried for four phases — "no
 *       `workspaceState`, no `globalState`, no cache file, everything dies with
 *       the window" — is no longer true of the extension, and the parts of it
 *       that remain true are worth stating separately rather than deleting:
 *       there is still no `workspaceState` and no `globalState`, still no
 *       cache, and every `SessionState` still dies with the window. What is new
 *       is exactly one directory, `<globalStorageUri>/stats/`, holding derived
 *       records and nothing else. {@link StatsPipeline} is the only writer,
 *       `src/stats/store.ts` the only module that touches it, and
 *       `src/stats/readback.test.ts` asserts no engine module imports it.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { SessionBridge, isWebviewToHostMessage } from './bridge/messages.js';
import type { BridgeDegradedState } from './bridge/messages.js';
import { createNonce, webviewHtml } from './bridge/html.js';
import { WEBVIEW_SCRIPT_SEGMENTS, WEBVIEW_STYLE_SEGMENTS } from './bridge/panel-assets.js';
import { deepFreeze } from './bridge/apply.js';
import { StatsUpdateEmitter, createAgentDeckApi } from './api.js';
import type { AgentDeckApi } from './api.js';
import { SIDEBAR_VIEW_ID } from './sidebar/menu.js';
import { SidebarController } from './sidebar/provider.js';
import type { SidebarSurface } from './sidebar/provider.js';
import { inSessionOrder, statsWireRecords } from './stats/wire.js';
import type { StatsRecord } from './stats/schema.js';
import {
  COUNTERS_INTERVAL_MS,
  DIAGNOSTICS_CHANNEL_NAME,
  DiagnosticsChannel,
  SHOW_DIAGNOSTICS_COMMAND,
  graftRefusedEvent,
} from './bridge/diagnostics.js';
import type {
  DiagnosticsCounters,
  DiagnosticsEngine,
  DiagnosticsEvent,
  DiagnosticsSinkFactory,
} from './bridge/diagnostics.js';
import { correlateWorkspace } from './model/correlate.js';
import { graftSession } from './model/graft.js';
import type { GraftSessionOptions, GraftSessionResult } from './model/graft.js';
import { isFingerprintMismatch } from './parser/fingerprint.js';
import { LivenessEngine } from './model/liveness.js';
import { SessionModel, diffSessionState } from './model/session.js';
import type { SessionDiff, SessionEmission } from './model/session.js';
import type {
  HostToWebviewMessage,
  SessionState,
  SettingsMessage,
  ShowViewMessage,
  SkippedFile,
  WebviewToHostMessage,
} from './model/events.js';
import { opencodeDataDir, opencodeDbPath, readOpenCodeEngine } from './opencode/index.js';
import type { OcEngineOptions, OcEngineOutcome } from './opencode/index.js';
import {
  DEFAULT_OC_POLL_INTERVAL_MS,
  OcLivenessEngine,
  createWalWatchFactory,
} from './opencode/liveness.js';
import type {
  OcSessionLiveness,
  PollTrigger,
  PollTriggerHandle,
  WalWatchFactory,
} from './opencode/liveness.js';
import {
  DEFAULT_HOOK_PORT,
  isHookListenerBindError,
} from './hooks/listener.js';
import { SharedHookListener } from './hooks/shared.js';
import type { RelayCounters, RelayRole } from './hooks/relay.js';
import { readCodexEngine, resolveCodexRoot } from './codex/index.js';
import {
  CodexTailStore,
  DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES as CODEX_MAX_TRANSCRIPT_BYTES,
} from './codex/store.js';
import type { CodexEngineOptions, CodexEngineOutcome, CodexThread } from './codex/index.js';
import { CODEX_LOCK_DIR_NAME } from './codex/locate.js';
import { CodexLivenessEngine, scanCodexWriterLocks } from './codex/liveness.js';
import type {
  CodexHookEvent,
  CodexLivenessReport,
  CodexLivenessSample,
} from './codex/liveness.js';
import type { CodexAgentLiveness, CodexToolCall } from './codex/types.js';
import { deriveStats } from './stats/derive.js';
import { parsePricing } from './stats/pricing.js';
import type { PricingTable } from './stats/pricing.js';
import { StatsStore, resolveStoreDir } from './stats/store.js';
import type { StoredStatsRecord } from './stats/store.js';
import { ProjectWatcher } from './watch/watcher.js';
import type { WatchFactory } from './watch/watcher.js';
import { createJsonlInferenceSource } from './watch/inference.js';
import { systemScheduler } from './parser/tailer.js';
import type { DiscoveryFailure, Scheduler, TailBatch, TimerHandle } from './parser/tailer.js';

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
 * 64 MiB. The Codex engine will not OPEN a transcript larger than this
 * (hotfix 0.6.1).
 *
 * Re-exported from the engine rather than restated: two literals that must
 * agree is the defect `bridge/contract.ts` exists to document, and this one
 * would be three (here, the engine, and `package.json`). The manifest's copy
 * is the one VS Code's settings UI reads, and `extension.test.ts` asserts the
 * two are equal.
 */
export const DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES = CODEX_MAX_TRANSCRIPT_BYTES;

/**
 * How often liveness is recomputed with no other stimulus. See trigger (c) in
 * the module header. Deliberately NOT a user setting: three settings were
 * decided for this phase and inventing a fourth is scope, not configurability.
 */
export const LIVENESS_TICK_MS = 5_000;

/** Quiet period before an emission. Coalesces hook bursts and batch storms. */
export const EMIT_COALESCE_MS = 100;

/**
 * 90 days. CONFIRMED rather than chosen, by measurement.
 *
 * `docs/evidence/phase-0-stats/VERDICT.md` 0.7 serialised a record per
 * committed session in the shipped shape: median 1,087 bytes, mean 2,486, max
 * 18,007. At twenty sessions a day for ninety days that is 1.9 MiB at the
 * median and 30.9 MiB in the pathological case where EVERY session is as heavy
 * as the heaviest one in every committed corpus. Nothing in that argues for a
 * shorter window, so the spec's default stands and the measurement is recorded
 * beside it rather than the number being restated as a preference.
 */
export const DEFAULT_STATS_RETENTION_DAYS = 90;

/**
 * One hour. The silence after which a session's record is flushed anyway.
 *
 * The locked open question (PLAN.md Phase 3, user, 2026-09-05): a record is
 * appended when the session reaches `ended`, OR when no patch has arrived for
 * this long. The timer is a STATS-LAYER timer and never touches liveness (G2)
 * — a session that has been silent for an hour is not thereby declared dead,
 * it simply has a record written for what it did.
 */
export const DEFAULT_STATS_IDLE_FLUSH_MS = 3_600_000;

export interface AgentDeckSettings {
  port: number;
  livenessThresholdMs: number;
  previewBytes: number;
  /**
   * `agentDeck.codex.maxTranscriptBytes` — a DOTTED key, and the first one.
   *
   * The three settings above are flat under `agentDeck.`; this one is
   * namespaced by engine because it is the first setting that means nothing
   * to the other two. `vscode.WorkspaceConfiguration.get` takes the dotted
   * remainder verbatim, so `readSettings` needs no special case, and the
   * manifest declares `agentDeck.codex.maxTranscriptBytes` the same way it
   * declares the others: `${CONFIG_SECTION}.${key}`.
   */
  'codex.maxTranscriptBytes': number;
  /**
   * v0.7.0 Phase 3 — the four LOCAL STORE settings.
   *
   * `stats.enabled` and `pricing` are the first settings here that are not
   * integers, which is why {@link SETTING_BOUNDS} stopped being the whole
   * table: a boolean has no minimum and an object has no maximum.
   * {@link SETTING_SHAPES} carries those two, and the manifest cross-check in
   * `extension.test.ts` reads the union of the two tables so neither can gain
   * a setting the other and the manifest never hear about.
   *
   * `agentDeck.canvas.autoFit` is deliberately NOT here. Spec section G gives
   * it a default of `true` and Phase 4's DoD 4.0 owns it, together with the
   * `fit()` function and the goldens it is asserted against. A setting
   * declared before anything reads it is the dead knob the manifest
   * cross-check exists to forbid, so it lands with its behaviour.
   */
  'stats.enabled': boolean;
  'stats.retentionDays': number;
  'stats.idleFlushMs': number;
  /**
   * `agentDeck.canvas.autoFit` — v0.7.0 Phase 4, DoD 4.0. The FIFTH setting the
   * Phase 3 module list named, landing with its behaviour: the canvas re-fits
   * on every geometry-changing event (the trigger table in `webview/store.ts`)
   * while this is `true`, and never after the initial render while it is
   * `false`. The renderer hears it through a `settings` message; a change
   * takes effect without a reload.
   */
  'canvas.autoFit': boolean;
  /**
   * `agentDeck.pricing` — model id to prices, in USD per million tokens.
   *
   * Read as an opaque object here and parsed by `stats/pricing.ts`, which is
   * total by construction: any shape at all may arrive from a user's
   * `settings.json`, and a malformed entry is dropped and reported on the
   * diagnostics channel rather than guessed at (F9's whole point is that no
   * price table ships).
   */
  pricing: Record<string, unknown>;
}

/** The settings {@link SETTING_BOUNDS} governs — the integer ones. */
export type NumericSettingKey =
  | 'port'
  | 'livenessThresholdMs'
  | 'previewBytes'
  | 'codex.maxTranscriptBytes'
  | 'stats.retentionDays'
  | 'stats.idleFlushMs';

/** The narrow slice of `vscode.WorkspaceConfiguration` settings reading needs. */
export interface SettingsReader {
  get(key: string): unknown;
}

/**
 * Accepted ranges and defaults — ONE table, and the table `package.json` is
 * checked against.
 *
 * Every number here is declared a second time in the manifest's
 * `contributes.configuration`, because that is the only place VS Code's
 * settings UI reads: the manifest supplies the default a user sees and the
 * min/max the editor validates against, while this table supplies the default
 * and range `readSettings` enforces at runtime. Six numbers, two files, and
 * until Phase 4 nothing kept them equal — the manifest's `previewBytes`
 * default could be changed from 8192 to 999 and its maximum from 1048576 to
 * 4096 with the whole suite still green.
 *
 * That is the defect class CLAUDE.md names and says will recur, "the manifest
 * and the build disagree", from the `"type": "module"` incident that shipped a
 * silently inert extension. `extension.test.ts` now reads `package.json` at
 * test time and asserts per setting that `default`/`minimum`/`maximum` equal
 * the entries below, and that the two key sets match — so a setting added to
 * one side alone fails as loudly as a number changed on one side alone.
 *
 * A value outside a range is a user typo, not a request: `port: 0` would mean
 * "bind ephemeral", which the port decision explicitly refuses, and
 * `previewBytes: -1` has no meaning at all.
 */
export interface SettingBounds {
  /** Used when the setting is unset or unusable. Equals the manifest's `default`. */
  readonly default: number;
  /** Inclusive lower bound. Equals the manifest's `minimum`. */
  readonly minimum: number;
  /** Inclusive upper bound. Equals the manifest's `maximum`. */
  readonly maximum: number;
}

export const SETTING_BOUNDS: Readonly<Record<NumericSettingKey, SettingBounds>> = {
  port: { default: DEFAULT_PORT, minimum: 1, maximum: 65_535 },
  livenessThresholdMs: {
    default: DEFAULT_LIVENESS_THRESHOLD_MS,
    minimum: 1_000,
    maximum: 24 * 60 * 60 * 1_000,
  },
  previewBytes: { default: DEFAULT_PREVIEW_BYTES, minimum: 0, maximum: 1_048_576 },
  /*
   * The floor is 1 MiB and the ceiling 1 GiB, and neither is arbitrary.
   *
   * Below the floor the setting stops being a size gate and becomes an
   * engine switch: `CODEX_HEAD_BYTES` is 256 KiB, so a limit near it would
   * refuse ordinary sessions. The ceiling is where the gate stops protecting
   * anything — the user who reported this defect has 3.11 GB of transcripts,
   * and a 1 GiB single file read into an extension host is the crash this
   * hotfix exists to prevent.
   *
   * An out-of-range value falls back to the default, as every setting here
   * does: it is a number the user typed over a working one.
   */
  'codex.maxTranscriptBytes': {
    default: DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES,
    minimum: 1_048_576,
    maximum: 1_073_741_824,
  },
  /*
   * One day to ten years.
   *
   * The floor is a day rather than zero because zero is not "keep nothing", it
   * is "delete on the first append", and a store that erases itself because a
   * number was mistyped is the one failure here with no undo. A user who wants
   * nothing kept sets `stats.enabled` to `false`, which is the switch that
   * actually means it. The ceiling is where retention stops bounding anything:
   * at the measured pathological rate (VERDICT.md 0.7) ten years is roughly
   * 1.25 GiB, which is the point at which a bound has stopped being one.
   */
  'stats.retentionDays': {
    default: DEFAULT_STATS_RETENTION_DAYS,
    minimum: 1,
    maximum: 3_650,
  },
  /*
   * One minute to seven days.
   *
   * Below a minute the flush stops being an idle rule and becomes a write per
   * emission: the deck pumps on a 5 s liveness tick, so a threshold near it
   * would append a superseding record every few seconds for every open
   * session. Seven days is past the point where a session that has been silent
   * that long is going to produce another patch — the flush is what guarantees
   * a record EXISTS for a session that never reaches `ended`, and a bound
   * beyond a week defeats that guarantee without offering anything.
   */
  'stats.idleFlushMs': {
    default: DEFAULT_STATS_IDLE_FLUSH_MS,
    minimum: 60_000,
    maximum: 7 * 24 * 60 * 60 * 1_000,
  },
};

/**
 * The settings that are NOT integers, with the type and default the manifest
 * must declare for each.
 *
 * A second table rather than a widened {@link SETTING_BOUNDS}, because the
 * thing `SettingBounds` exists to state — a minimum and a maximum — is
 * meaningless for both entries, and a table with two fields permanently unset
 * is a shape that invites someone to fill them in. What the manifest
 * cross-check needs from a non-numeric setting is its `type` and its `default`,
 * and that is exactly what this carries.
 *
 * `defaultOf` is a FACTORY for `pricing`, not a shared object: the default is a
 * fresh empty object per read, so a caller that mutates what `readSettings`
 * handed it cannot change what the next caller gets.
 */
export interface SettingShape {
  /** The `type` string `package.json` must declare. */
  readonly type: 'boolean' | 'object';
  /** Produces the default. A factory so no default object is shared. */
  readonly defaultOf: () => boolean | Record<string, unknown>;
}

export const SETTING_SHAPES: Readonly<
  Record<'stats.enabled' | 'pricing' | 'canvas.autoFit', SettingShape>
> = {
  'stats.enabled': { type: 'boolean', defaultOf: (): boolean => true },
  pricing: { type: 'object', defaultOf: (): Record<string, unknown> => ({}) },
  // Spec section G: default `true`. Phase 4, with the behaviour it governs.
  'canvas.autoFit': { type: 'boolean', defaultOf: (): boolean => true },
};

/**
 * The four Phase 3 settings at their shipped defaults, as a fresh object.
 *
 * Exported for the test harnesses that build a whole `AgentDeckSettings` by
 * hand — `extension.test.ts`'s `settings()` and `isolation.test.ts`'s two data
 * paths. Those harnesses have to name every key or the type rejects them, and
 * four literals repeated at three sites is the "two agreeing literals is not a
 * contract" defect waiting for the next default to move.
 *
 * A FUNCTION rather than a constant, for the reason {@link SettingShape} gives:
 * `pricing` is an object, and one shared instance handed to three harnesses is
 * one mutation away from tests interfering with each other.
 */
export function statsSettingDefaults(): Pick<
  AgentDeckSettings,
  'stats.enabled' | 'stats.retentionDays' | 'stats.idleFlushMs' | 'pricing' | 'canvas.autoFit'
> {
  return {
    // Phase 4's `canvas.autoFit` rides along: the harnesses that spread this
    // into a whole `AgentDeckSettings` would otherwise each need a sixth
    // literal, which is the same defect the function exists to remove.
    'canvas.autoFit': SETTING_SHAPES['canvas.autoFit'].defaultOf() as boolean,
    'stats.enabled': SETTING_SHAPES['stats.enabled'].defaultOf() as boolean,
    'stats.retentionDays': SETTING_BOUNDS['stats.retentionDays'].default,
    'stats.idleFlushMs': SETTING_BOUNDS['stats.idleFlushMs'].default,
    pricing: SETTING_SHAPES.pricing.defaultOf() as Record<string, unknown>,
  };
}

function integerInRange(value: unknown, key: NumericSettingKey): number {
  const bounds = SETTING_BOUNDS[key];
  if (typeof value !== 'number') return bounds.default;
  if (!Number.isSafeInteger(value)) return bounds.default;
  if (value < bounds.minimum || value > bounds.maximum) return bounds.default;
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
  // An absent reader is not a special case: every key reads as `undefined`,
  // which `integerInRange` already answers with the same default. Written this
  // way so there is exactly one place a default is produced.
  const get = (key: keyof AgentDeckSettings): unknown =>
    reader === undefined ? undefined : reader.get(key);
  return {
    port: integerInRange(get('port'), 'port'),
    livenessThresholdMs: integerInRange(get('livenessThresholdMs'), 'livenessThresholdMs'),
    previewBytes: integerInRange(get('previewBytes'), 'previewBytes'),
    'codex.maxTranscriptBytes': integerInRange(
      get('codex.maxTranscriptBytes'),
      'codex.maxTranscriptBytes',
    ),
    'stats.retentionDays': integerInRange(get('stats.retentionDays'), 'stats.retentionDays'),
    'stats.idleFlushMs': integerInRange(get('stats.idleFlushMs'), 'stats.idleFlushMs'),
    // Anything that is not a boolean is the default, which for this setting is
    // `true`: the store is on unless a user has said otherwise IN THE TYPE THE
    // SETTING DECLARES. A truthiness read would turn the string "false" on.
    'stats.enabled': typeof get('stats.enabled') === 'boolean'
      ? (get('stats.enabled') as boolean)
      : (SETTING_SHAPES['stats.enabled'].defaultOf() as boolean),
    // Same rule, same reason: a boolean or the default, never a truthiness read.
    'canvas.autoFit': typeof get('canvas.autoFit') === 'boolean'
      ? (get('canvas.autoFit') as boolean)
      : (SETTING_SHAPES['canvas.autoFit'].defaultOf() as boolean),
    // Passed through unparsed. `parsePricing` is total and reports what it
    // refused; validating here would be a second, quieter account of the same
    // judgment. An array is an object to `typeof`, so it is excluded here as
    // well as there — one of the two has to be first and this is the cheaper.
    pricing:
      typeof get('pricing') === 'object' && get('pricing') !== null && !Array.isArray(get('pricing'))
        ? (get('pricing') as Record<string, unknown>)
        : (SETTING_SHAPES.pricing.defaultOf() as Record<string, unknown>),
  };
}

// ---------------------------------------------------------------------------
// (a2) Logging
// ---------------------------------------------------------------------------

/**
 * Levels this host logs at. Two, because two is what the DoD names.
 *
 * `console` rather than an output channel, and that is a decision rather than
 * laziness: an output channel is a `vscode` object, so taking one would make
 * the OpenCode discovery decision untestable outside the editor — the double
 * in `test/vscode-mock.ts` has no `createOutputChannel` and this package does
 * not own that file. `console.info` from the extension host lands in the
 * "Extension Host" log, which is where a user is told to look anyway.
 */
export type HostLogLevel = 'info' | 'error';

export type HostLogger = (level: HostLogLevel, message: string) => void;

/** The production logger. Injected everywhere, so a test never writes to it. */
export const consoleLogger: HostLogger = (level, message) => {
  if (level === 'error') console.error(message);
  else console.info(message);
};

// ---------------------------------------------------------------------------
// (b0) The OpenCode engine path (PLAN.md DoD 5.2, gate amendments B5 and B6)
// ---------------------------------------------------------------------------

/**
 * The message logged, ONCE, when there is no OpenCode store to observe.
 *
 * A constant rather than a template, because "logged once at info level" is an
 * assertable property only if the string is the same string every time.
 */
export const OPENCODE_ABSENT_LOG =
  'Agent Deck: no OpenCode data directory found; the OpenCode engine is off.';

/**
 * The production poll trigger: `setInterval`, wrapped.
 *
 * It lives HERE and not in `src/opencode/liveness.ts` because `PLAN.md`
 * Phase 4 Amendment A2 forbids a timer in that module — `now` and the trigger
 * are injected with no default, and a default would be `Date.now`/`setInterval`
 * arriving by the back door. The host owns wall-clock time; the engine owns the
 * cursor. Gate amendment B5 is explicit that this is the split.
 */
export function systemPollTrigger(run: () => void, intervalMs: number): PollTriggerHandle {
  const handle = setInterval(run, intervalMs);
  // `unref` keeps a poll loop from holding a node process open in a test that
  // forgot to dispose. It does not exist on the DOM `setInterval` type, hence
  // the guard rather than a cast.
  if (typeof handle === 'object' && typeof handle.unref === 'function') handle.unref();
  return {
    stop: () => {
      clearInterval(handle);
    },
  };
}

export interface OpenCodePathOptions {
  /**
   * EVERY open workspace folder (gate amendment B6), not just the first.
   *
   * `OcEngineOptions.workspacePaths` is a `readonly string[]` and the CC half
   * of this host is singular throughout — `firstWorkspacePath()` and
   * {@link AgentDeckDataPath.workspacePath}. The asymmetry is deliberate and is
   * argued at the call site in `activate()`; it is not created here.
   */
  workspacePaths: readonly string[];
  /** `agentDeck.livenessThresholdMs`. The same setting both engines read. */
  thresholdMs: number;
  /** Something changed; schedule an emission. Coalesced by the caller. */
  onChange: () => void;
  /** Absolute path of `opencode.db`. Overrides {@link OpenCodePathOptions.dataDir}. */
  dbPath?: string;
  /**
   * The OpenCode data directory. Tests and fixture replay only.
   *
   * The `projectsRoot` precedent one section down, for the same reason: the
   * engine's own environment override (`AGENT_DECK_OPENCODE_ROOT`) is a
   * process-wide switch, and a test that needs two roots in one process cannot
   * use it.
   */
  dataDir?: string;
  env?: Record<string, string | undefined>;
  /** Injected clock. Defaults to `Date.now`. A2 keeps it out of the engine. */
  now?: () => number;
  pollIntervalMs?: number;
  /** Defaults to {@link systemPollTrigger}. */
  pollTrigger?: PollTrigger;
  /** Defaults to {@link createWalWatchFactory}. */
  walWatchFactory?: WalWatchFactory;
  log?: HostLogger;
  /**
   * The content read. Defaults to {@link readOpenCodeEngine}.
   *
   * Injected for the reason {@link DataPathOptions.graft} is, pointed the other
   * way: DoD 5.3 requires that an OpenCode-side failure leave CC sessions
   * untouched, and `readOpenCodeEngine` is documented never to throw — so
   * without this seam the `catch` below is unreachable from any test and the
   * isolation claim rests on a comment. Production never passes this.
   */
  read?: (options: OcEngineOptions) => OcEngineOutcome;
}

export interface OpenCodeDiagnostics {
  /** False when the store was absent at {@link OpenCodeEnginePath.start}. */
  enabled: boolean;
  started: boolean;
  disposed: boolean;
  /** The path that was probed, whether or not it existed. */
  dbPath: string;
  /** Times {@link OPENCODE_ABSENT_LOG} was emitted. DoD 5.2's "once" is 1. */
  absentLogs: number;
  /** Content reads attempted. */
  contentReads: number;
  /** Content reads that THREW. Should stay 0; counted so it cannot crash. */
  contentFailures: number;
  /** Reads returning `schemaMismatch` — every session renders `unsupported`. */
  schemaMismatches: number;
  /** Reads returning `degraded` — the last good content is kept. */
  degradedReads: number;
  /** Liveness polls the engine reports having attempted. */
  /**
   * Times an absent Codex root appeared AFTER activation and the engine came
   * up without a reload (v0.7.0 DoD 1b.10). Normally 0.
   */
  lateStarts: number;
  livenessPolls: number;
  livenessDegraded: boolean;
  /** Emissions produced by {@link OpenCodeEnginePath.emit}. */
  emissions: number;
  /** Workspace-matching sessions currently held. */
  sessions: number;
  lastError?: string;
}

/**
 * The activity map for an emission with nothing in it (DoD 4.11b).
 *
 * `ReadonlyMap` is the whole guard and it is a COMPILE-TIME one:
 * `Object.freeze` seals a Map's own properties and does nothing to its
 * contents, so a frozen empty Map is still `.set()`-able at runtime. Nothing
 * mutates an emission's map today; the type is what keeps it that way.
 */
const EMPTY_ACTIVITY: ReadonlyMap<string, number> = new Map();

/** An emission with nothing in it. Frozen; never handed out mutable. */
const EMPTY_EMISSION: SessionEmission = Object.freeze({
  sessions: Object.freeze([]) as readonly SessionState[],
  diffs: Object.freeze([]) as readonly SessionDiff[],
  addedSessionIds: Object.freeze([]) as readonly string[],
  removedSessionIds: Object.freeze([]) as readonly string[],
  schemaMismatchSessionIds: Object.freeze([]) as readonly string[],
  lastActivityAt: EMPTY_ACTIVITY,
});

/**
 * The OpenCode half of the host: discovery, content, and the live cursor.
 *
 * ---------------------------------------------------------------------------
 * WHAT DoD 5.2 ASKED FOR AND WHAT IS HERE
 * ---------------------------------------------------------------------------
 *   - **Discovery.** `project.worktree` against the open workspace folders,
 *     case-insensitively. The comparison is NOT written here: it is
 *     `OcEngineOptions.workspacePaths`, which `src/opencode/index.ts` turns
 *     into a matcher over `slugFromWorktree`, which is `slugifyWorkspace` plus
 *     a lower-cased drive letter. Restating it here would be the two-agreeing-
 *     literals defect `src/bridge/contract.ts` exists to document.
 *   - **On by default when the data directory exists. No setting.** There is no
 *     `agentDeck.opencode.*` key and this class reads none: the probe below is
 *     the whole switch. That is the v2 Phase 7 gate decision, restated by
 *     DoD 5.2 as unchanged.
 *   - **Absent → silently off, logged ONCE at info level.** `#absentLogs` is
 *     the counter a test reads. The probe happens exactly once, at
 *     {@link start}, so there is no tick that could log a second time.
 *   - **Liveness is chained** (gate amendment B5), because DoD 5.3's third
 *     isolation test has nothing to assert against a static read.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CONTENT READ IS DRIVEN BY THE CURSOR
 * ---------------------------------------------------------------------------
 * `readOpenCodeEngine` reads every `part` row in the store — tens of megabytes
 * on a real one. Doing that on every poll would be a busy loop with a database
 * attached. `event_sequence.seq` is precisely the number that says whether
 * anything happened, so a content re-read is taken only when the session set or
 * some session's cursor moved. A clock-only transition (`live` -> `idle`) still
 * schedules an EMISSION, because the overlay changed — it just does not
 * re-read the store, which has not.
 *
 * ---------------------------------------------------------------------------
 * G1 / G2
 * ---------------------------------------------------------------------------
 * G1 as amended 2026-08-27: every open below is read-only, `opencode.db` is
 * never modified, and the four secret-bearing tables are never read. What
 * SQLite touches on a WAL database is its own `-shm` index, which every reader
 * of one touches. `agent-deck-spec.md` OC1 carries the measurements.
 *
 * G2 across engines: nothing in here can throw into the Claude Code path.
 * Every entry point catches, counts and continues, and {@link emit} is called
 * from a `try` of its own in {@link AgentDeckDataPath.pump}.
 */
export class OpenCodeEnginePath {
  readonly dbPath: string;

  readonly workspacePaths: readonly string[];

  readonly #onChange: () => void;
  readonly #log: HostLogger;
  readonly #read: (options: OcEngineOptions) => OcEngineOutcome;
  readonly #env?: Record<string, string | undefined>;
  readonly #now: () => number;
  readonly #thresholdMs: number;
  readonly #pollIntervalMs: number;
  readonly #pollTrigger: PollTrigger;
  readonly #walWatchFactory: WalWatchFactory;

  #liveness: OcLivenessEngine | null = null;
  #content: readonly SessionState[] = [];
  #previous = new Map<string, SessionState>();
  /** `sessionId:seq` for every session the last content read covered. */
  #cursorStamp = '';
  /**
   * Has a poll established the cursor baseline for the read {@link start} took?
   *
   * `start()` reads content BEFORE the first poll, so that first poll's stamp
   * describes a store the content already reflects. Without this flag the stamp
   * would read as "changed" (it moves off `''`) and the store would be read
   * TWICE at activation — two full passes over tens of megabytes, for no new
   * information. Measured as `contentReads === 2` before this existed.
   */
  #stampSeeded = false;

  #enabled = false;
  #started = false;
  #disposed = false;

  #absentLogs = 0;
  /** The slow re-probe held only while the store is absent (DoD 1b.10). */
  #absentProbe: PollTriggerHandle | null = null;
  /** Times an absent store appeared later and this engine came up (DoD 1b.10). */
  #lateStarts = 0;
  #contentReads = 0;
  #contentFailures = 0;
  #schemaMismatches = 0;
  #degradedReads = 0;
  #emissions = 0;
  #lastError?: string;

  constructor(options: OpenCodePathOptions) {
    this.workspacePaths = [...options.workspacePaths];
    this.dbPath =
      options.dbPath ??
      opencodeDbPath(
        options.dataDir ?? opencodeDataDir(options.env ?? process.env),
      );
    this.#onChange = options.onChange;
    this.#log = options.log ?? consoleLogger;
    this.#read = options.read ?? readOpenCodeEngine;
    if (options.env !== undefined) this.#env = options.env;
    this.#now = options.now ?? Date.now;
    this.#thresholdMs = options.thresholdMs;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_OC_POLL_INTERVAL_MS;
    this.#pollTrigger = options.pollTrigger ?? systemPollTrigger;
    this.#walWatchFactory = options.walWatchFactory ?? createWalWatchFactory();
  }

  get diagnostics(): OpenCodeDiagnostics {
    return {
      enabled: this.#enabled,
      started: this.#started,
      disposed: this.#disposed,
      dbPath: this.dbPath,
      absentLogs: this.#absentLogs,
      lateStarts: this.#lateStarts,
      contentReads: this.#contentReads,
      contentFailures: this.#contentFailures,
      schemaMismatches: this.#schemaMismatches,
      degradedReads: this.#degradedReads,
      livenessPolls: this.#liveness?.counters().polls ?? 0,
      livenessDegraded: this.#liveness?.isDegraded() ?? false,
      emissions: this.#emissions,
      sessions: this.#content.length,
      ...(this.#lastError !== undefined ? { lastError: this.#lastError } : {}),
    };
  }

  /** The live engine, or null when the store was absent. Diagnostics only. */
  get livenessEngine(): OcLivenessEngine | null {
    return this.#liveness;
  }

  /**
   * Probe the store. Present -> read it and start polling. Absent -> off.
   *
   * Never throws, and never surfaces a dialog: a machine without OpenCode
   * installed is the normal case, not a fault, and nagging about it would be
   * the "no nagging" defect in another costume.
   */
  start(): void {
    if (this.#disposed || this.#started) return;
    this.#started = true;

    if (!existsSync(this.dbPath)) {
      // ONCE, still: the re-probe below logs nothing, so a machine without
      // OpenCode says this one line for the life of the window and no more.
      this.#absentLogs += 1;
      this.#log('info', OPENCODE_ABSENT_LOG);
      this.#armAbsentReprobe();
      return;
    }
    this.#enable();
  }

  /**
   * Look again for a store that was absent at activation (v0.7.0 DoD 1b.10).
   *
   * The Claude Code half of this defect is what the 1b.8 smoke found; this is
   * the same shape in the engine that shares the least code with it. `start()`
   * returned before arming anything, so a user who first ran OpenCode with VS
   * Code already open saw an empty deck until they reloaded, with nothing to
   * tell them that a reload was the remedy.
   *
   * See {@link ABSENT_ROOT_REPROBE_MS} for why this is a slow probe rather
   * than the directory watch the Claude Code half uses.
   */
  #armAbsentReprobe(): void {
    if (this.#disposed || this.#absentProbe !== null) return;
    this.#absentProbe = this.#pollTrigger(() => {
      this.#reprobeAbsentStore();
    }, ABSENT_ROOT_REPROBE_MS);
  }

  #reprobeAbsentStore(): void {
    if (this.#disposed || this.#enabled) return;
    if (!existsSync(this.dbPath)) return;
    this.#cancelAbsentReprobe();
    this.#lateStarts += 1;
    this.#enable();
    // The deck is stale by up to one probe interval, so say so now.
    this.#onChange();
  }

  /** Everything `start()` does once the store is known to be there. */
  #enable(): void {
    this.#enabled = true;

    this.#liveness = new OcLivenessEngine({
      dbPath: this.dbPath,
      now: this.#now,
      thresholdMs: this.#thresholdMs,
      pollIntervalMs: this.#pollIntervalMs,
      pollTrigger: this.#pollTrigger,
      walWatchFactory: this.#walWatchFactory,
      onUpdate: (snapshots: readonly OcSessionLiveness[]) => {
        this.#onPoll(snapshots);
      },
    });
    // The first content read happens before the first poll so that a snapshot
    // taken between the two is a tree with stale liveness rather than liveness
    // with no tree.
    this.#refreshContent();
    this.#liveness.start();
    this.#onChange();
  }

  /** Idempotent. After this nothing here polls, watches or holds a handle. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#liveness?.dispose();
    this.#liveness = null;
    // The absent-store re-probe (DoD 1b.10). Stopped here because it is armed
    // on exactly the machines that have no OpenCode — so leaking it would
    // leave a timer running for the whole session on every window belonging to
    // a user who does not use this engine at all, which is the population the
    // probe is cheapest for and the one that would notice least.
    this.#cancelAbsentReprobe();
    this.#content = [];
    this.#previous.clear();
  }

  #cancelAbsentReprobe(): void {
    const handle = this.#absentProbe;
    this.#absentProbe = null;
    handle?.stop();
  }

  /** The workspace-matching OpenCode sessions, with liveness overlaid. */
  sessions(): readonly SessionState[] {
    if (this.#disposed) return [];
    const engine = this.#liveness;
    return this.#content.map((session) => {
      // A refused session has no liveness to overlay: `'unsupported'` is the
      // fingerprint's answer and `OcLiveness` excludes it at the type level, so
      // overwriting it here would be inventing a value the engine cannot
      // produce.
      if (!session.schemaOk) return session;
      const live = engine?.livenessOf(session.sessionId);
      if (live === undefined || live === session.liveness) return session;
      return { ...session, liveness: live };
    });
  }

  /**
   * A `SessionEmission` for the OpenCode half, diffed against the last one.
   *
   * The same shape `SessionModel.emit()` produces, built with the same pure
   * `diffSessionState` — not a second diff implementation. `AgentDeckDataPath`
   * concatenates the two.
   */
  emit(): SessionEmission {
    if (this.#disposed) return EMPTY_EMISSION;
    const next = new Map<string, SessionState>();
    for (const session of this.sessions()) {
      next.set(session.sessionId, deepFreeze({ ...session }));
    }

    const diffs: SessionDiff[] = [];
    const addedSessionIds: string[] = [];
    const removedSessionIds: string[] = [];
    const schemaMismatchSessionIds: string[] = [];

    for (const [sessionId, state] of next) {
      const prev = this.#previous.get(sessionId);
      if (prev === undefined) {
        addedSessionIds.push(sessionId);
        if (!state.schemaOk) schemaMismatchSessionIds.push(sessionId);
        continue;
      }
      const patch = diffSessionState(prev, state);
      if (patch !== undefined) diffs.push({ sessionId, patch });
      if (!state.schemaOk && prev.schemaOk) schemaMismatchSessionIds.push(sessionId);
    }
    for (const sessionId of this.#previous.keys()) {
      if (!next.has(sessionId)) removedSessionIds.push(sessionId);
    }

    // Activity, per session, from the OpenCode liveness engine (DoD 4.11b).
    // `OcSessionLiveness.lastActivityAt` is `max(timeUpdated, seqAdvancedAt)` —
    // the store's own write instants, which is what makes it activity rather
    // than content. A session the engine has no fact for contributes nothing:
    // "no activity known" is not "now" (G3).
    const lastActivityAt = new Map<string, number>();
    for (const sessionId of next.keys()) {
      const at = this.#liveness?.snapshot(sessionId)?.lastActivityAt;
      if (at !== undefined) lastActivityAt.set(sessionId, at);
    }

    this.#previous = next;
    this.#emissions += 1;
    return {
      sessions: [...next.values()],
      diffs,
      addedSessionIds,
      removedSessionIds,
      schemaMismatchSessionIds,
      lastActivityAt,
    };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * One liveness poll landed.
   *
   * The cursor decides whether the STORE is re-read; the emission is scheduled
   * either way, because a `live` -> `idle` transition changes what the user
   * sees without changing a single row.
   */
  #onPoll(snapshots: readonly OcSessionLiveness[]): void {
    if (this.#disposed) return;
    const stamp = snapshots
      .map((s) => `${s.sessionId}:${String(s.seq ?? -1)}`)
      .sort()
      .join('|');
    const changed = stamp !== this.#cursorStamp;
    this.#cursorStamp = stamp;
    if (!this.#stampSeeded) {
      // The FIRST poll only records where the cursor was when `start()` read
      // the store. Re-reading here would be reading the same rows twice.
      //
      // The cost of this, stated rather than hidden: if the store changed
      // between that read and this poll, the change is invisible until the
      // next poll — one `pollIntervalMs`, or sooner if the WAL wakes us.
      this.#stampSeeded = true;
    } else if (changed) {
      this.#refreshContent();
    }
    this.#onChange();
  }

  #refreshContent(): void {
    if (this.#disposed) return;
    this.#contentReads += 1;
    let outcome: OcEngineOutcome;
    try {
      outcome = this.#read({
        dbPath: this.dbPath,
        workspacePaths: this.workspacePaths,
        ...(this.#env !== undefined ? { env: this.#env } : {}),
      });
    } catch (error) {
      // Documented never to happen — the engine returns outcomes rather than
      // throwing — and caught anyway, because the whole point of DoD 5.3 is
      // that the Claude Code path survives whatever this one does.
      this.#contentFailures += 1;
      this.#lastError = error instanceof Error ? error.message : String(error);
      return;
    }

    switch (outcome.kind) {
      case 'ok':
        this.#content = outcome.result.sessions.filter(belongsOnDeck);
        return;
      case 'schemaMismatch':
        // G3: the store's shape is not OpenCode's, so every session this host
        // is already showing becomes a refusal rather than vanishing. A
        // refusal that is invisible to the renderer is not a refusal.
        this.#schemaMismatches += 1;
        this.#lastError = `opencode schema mismatch: ${outcome.mismatch.code}`;
        this.#content = this.#content.map(unsupportedCopy);
        return;
      default:
        // Degraded: the store is unusable right now. The last good content is
        // KEPT, which is what `OcLivenessEngine.poll` does with its own facts
        // and is the honest reading — the engine has stopped seeing, it has
        // not learned that anything ended.
        this.#degradedReads += 1;
        this.#lastError = `opencode store degraded: ${outcome.health.code}`;
        return;
    }
  }
}

/**
 * Does this OpenCode session belong on THIS window’s deck?
 *
 * ---------------------------------------------------------------------------
 * THE FILTER HIDES OTHER WORKSPACES. IT DOES NOT HIDE REFUSALS.
 * ---------------------------------------------------------------------------
 * A session whose fingerprint refused (`schemaOk: false`) is ALWAYS kept,
 * whatever `workspaceMatch` says. `src/opencode/index.ts` carries the sentence
 * this implements — "a refusal that is invisible to the renderer is not a
 * refusal" — and dropping one here would mean a user whose OpenCode version
 * drifted out of the window sees NOTHING on the deck rather than an
 * `unsupported` card. That is the G3 hole, and it is a hole neither this file
 * nor the engine opened on its own: two locally-correct decisions composed
 * into it.
 *
 * **THE ENGINE SIDE IS BEING FIXED TOO, AND THE REDUNDANCY IS DELIBERATE.**
 * `src/opencode/index.ts` gives a refused session a real `workspaceMatch`
 * instead of a hard-coded `false`, which would make this carve-out
 * unnecessary for the case that motivated it. Both halves exist by user
 * decision so that neither file can silently reintroduce the hole alone. Do
 * not delete one as redundant: redundant is the point.
 *
 * **A healthy session in another workspace is still hidden**, and that is what
 * keeps this from being "remove the filter". `src/extension.test.ts` asserts
 * both arms in one test, because the carve-out and the control are only
 * meaningful against each other.
 */
function belongsOnDeck(session: SessionState): boolean {
  return session.workspaceMatch || !session.schemaOk;
}

/**
 * The same session, refused: no tree, no totals, no liveness claim.
 *
 * The shape `src/opencode/index.ts` produces for a session its fingerprint
 * refused, applied here to sessions that were fine until the SCHEMA moved
 * underneath them.
 */
function unsupportedCopy(session: SessionState): SessionState {
  return {
    ...session,
    schemaOk: false,
    liveness: 'unsupported',
    totals: { costUsd: 0 },
    // A refused session reports zero, not the numbers it had: G3's "never a
    // partial tree" covers numbers. Zero rather than absent because this IS a
    // CC session and the CC engine does report these - absent would say "this
    // engine has no such figure", which is a different and false claim.
    contextNow: { prompt: 0, output: 0 },
    burn: { prompt: 0, output: 0 },
    spawnEdges: [],
    parked: [],
    root: {
      ...session.root,
      children: [],
      contextNow: { prompt: 0, output: 0 },
      burn: { prompt: 0, output: 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// (b1) The Codex engine path (PLAN.md v0.6.0 DoD 3.2)
// ---------------------------------------------------------------------------

/**
 * What a window with no folder open is told (hotfix 0.6.1).
 *
 * **It names no engine, and that is the fix.** It read "open a folder to see
 * its Claude Code sessions" — in a release that observes three engines, shown
 * to a user who may have no Claude Code installed at all. The gate it explains
 * has nothing to do with Claude Code: `firstWorkspacePath()` is undefined, so
 * there is no workspace for ANY engine to correlate against.
 *
 * Same defect as `DegradedMessage` before DoD 5.0b — a panel-wide condition
 * described in one engine's words — and the same fix: say the panel-wide
 * thing. A constant rather than an inline literal so a test can assert it
 * names no engine without asserting the whole sentence.
 */
export const NO_WORKSPACE_MESSAGE = 'Agent Deck: open a folder to see its sessions.';

/** The message logged, ONCE, when there is no Codex data root to observe. */
export const CODEX_ABSENT_LOG =
  'Agent Deck: no Codex data root found; the Codex engine is off.';

/**
 * How often BOTH the Codex content re-read and the Codex liveness poll fire,
 * absent an override.
 *
 * One knob rather than two, and that is a deliberate simplification stated
 * rather than hidden: `readCodexEngine()` is a one-shot full read with no
 * cursor to advance between calls (`src/codex/index.ts`'s own doc comment —
 * "a fresh `CodexFileTail` is constructed per call"), so unlike the OpenCode
 * engine's `event_sequence.seq`-gated re-read there is nothing cheap to poll
 * that would tell this class whether a re-read is worth taking. Incremental,
 * cursor-based re-reading is explicitly OUT OF SCOPE here — `HANDOVER.md`
 * records "no perf budget covers the Codex engine" as a known, deliberately
 * unscheduled Phase 4 gap, not a Phase 3 one. `DEFAULT_OC_POLL_INTERVAL_MS`
 * is the naming precedent this constant follows.
 */
export const DEFAULT_CODEX_ENGINE_POLL_INTERVAL_MS = 1000;

/**
 * How often an engine whose data root was ABSENT at activation looks again
 * (v0.7.0 DoD 1b.10).
 *
 * **WHY THIS IS NOT THE CC FIX'S SHAPE, which is the part worth reading.** The
 * Claude Code half of 1b.10 watches `projects/` for the slug directory
 * appearing, and that is cheap and precise because `projects/` contains
 * nothing but project directories. The equivalent for these two engines would
 * be a watch on the PARENT of `~/.codex` or of OpenCode's data directory —
 * which is the user's home directory. Watching a home directory to learn
 * whether one folder appeared is not a proportionate thing for a read-only
 * observer to do, so the same defect gets a different remedy: a cheap
 * existence probe on a slow cadence.
 *
 * Thirty seconds because the trigger is installing or first running a tool
 * while VS Code is already open — a human-scale event, not a per-keystroke
 * one. The probe is a single `statSync`/`existsSync` on a path, so a machine
 * that will never have either engine pays two of those a minute and nothing
 * else; the alternative, which is what shipped until now, is that such a user
 * must reload the window and has no way to know that.
 */
export const ABSENT_ROOT_REPROBE_MS = 30_000;

export interface CodexPathOptions {
  /**
   * Matched against `session_meta.payload.cwd` (spec C1), the same way
   * `OpenCodePathOptions.workspacePaths` is matched against
   * `project.worktree` — EVERY open workspace folder, not just the first.
   */
  workspaceFolders: readonly string[];
  /** `agentDeck.livenessThresholdMs`. The same setting every engine reads. */
  thresholdMs: number;
  /** Something changed; schedule an emission. Coalesced by the caller. */
  onChange: () => void;
  /**
   * Overrides `$CODEX_HOME` / `~/.codex`. Tests and fixture replay only (G6) —
   * the same role {@link OpenCodePathOptions.dataDir} plays for OpenCode.
   */
  root?: string;
  env?: Record<string, string | undefined>;
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
  pollIntervalMs?: number;
  /**
   * Defaults to {@link systemPollTrigger}. Reused rather than re-declared:
   * `PollTrigger`/`PollTriggerHandle` from `src/opencode/liveness.ts` are
   * structurally identical to `CodexPollTrigger`/`CodexPollTriggerHandle`
   * from `src/codex/liveness.ts` — both are exactly
   * `(run: () => void, intervalMs: number) => { stop(): void }` — so one
   * production implementation serves both engines rather than two agreeing
   * ones drifting apart.
   */
  pollTrigger?: PollTrigger;
  log?: HostLogger;
  /**
   * The content read. Defaults to {@link readCodexEngine}.
   *
   * Injected for the reason {@link DataPathOptions.graft} and
   * {@link OpenCodePathOptions.read} are, pointed a third way: DoD 5.3's
   * isolation property now has a THIRD direction (a Codex-side failure must
   * leave CC and OpenCode sessions unaffected), and `readCodexEngine` is
   * documented never to throw — so without this seam the corresponding catch
   * below is unreachable from any test. Production never passes this.
   */
  read?: (options: CodexEngineOptions) => Promise<CodexEngineOutcome>;
  /**
   * `agentDeck.codex.maxTranscriptBytes`. Defaults to the engine's own 64 MiB.
   *
   * Forwarded to every read, so a user who raises it does not have to reload
   * the window for the NEXT poll to honour it — the value is read at
   * construction, which is the same lifetime every other setting here has.
   */
  maxTranscriptBytes?: number;
  /**
   * Where a skipped transcript is reported (hotfix 0.6.1).
   *
   * A CALLBACK, for the reason `DataPathOptions.onDiagnostic` is one: this
   * class must stay constructible with no channel, no `vscode` and no output
   * sink. Absent, a skip is still counted in
   * {@link CodexEngineDiagnostics.skippedTranscripts}; it simply produces no
   * line.
   */
  onDiagnostic?: (event: DiagnosticsEvent) => void;
}

export interface CodexEngineDiagnostics {
  /** False when the Codex root was absent at {@link CodexEnginePath.start}. */
  enabled: boolean;
  started: boolean;
  disposed: boolean;
  /** The resolved root, whether or not it exists. */
  root: string;
  /** Times {@link CODEX_ABSENT_LOG} was emitted. */
  absentLogs: number;
  /** Content reads attempted (the initial one plus every periodic re-read). */
  contentReads: number;
  /** Content reads whose injected `read` THREW. Should stay 0; counted so it cannot crash. */
  contentFailures: number;
  /** Reads returning `unreadable` — the last good content is kept (G3/G2). */
  unreadableReads: number;
  /** Liveness polls the engine reports having attempted. */
  /**
   * Times an absent root appeared AFTER activation and the engine came up
   * without a reload (v0.7.0 DoD 1b.10). Normally 0.
   */
  lateStarts: number;
  livenessPolls: number;
  /** Emissions produced by {@link CodexEnginePath.emit}. */
  emissions: number;
  /** Workspace-matching sessions currently held. */
  sessions: number;
  /**
   * Hook events handed to this path since it was constructed (DoD 5.0b).
   *
   * The Codex tap's evidence of life, and the only thing that separates "the
   * socket is up and Codex is quiet" from "the socket is up and the paste
   * block was never trusted". Zero while listening is what makes
   * `noHookEvents` true FOR CODEX rather than borrowed from Claude Code.
   */
  hookEventsIngested: number;
  /**
   * Transcripts currently being skipped, and the tails currently held
   * (hotfix 0.6.1).
   *
   * `skippedTranscripts` is a LEVEL, not a running total: it is what the last
   * read reported, so a file that comes back under the limit lowers it.
   * `tailsHeld` is the store's size and is the number that would grow without
   * bound if `CodexTailStore.retain` stopped working.
   */
  skippedTranscripts: number;
  tailsHeld: number;
  lastError?: string;
}

/**
 * The Codex half of the host: one-shot content reads on a timer, plus the
 * live cursor chained on top (DoD 3.2; `src/codex/index.ts`'s own doc comment
 * names this exact wiring as its own follow-up).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A COPY OF `OpenCodeEnginePath`
 * ---------------------------------------------------------------------------
 * `readCodexEngine()` is ASYNC — it awaits file reads — while
 * `OpenCodeEnginePath`'s content read is synchronous end-to-end
 * (`node:sqlite` reads synchronously). So {@link start} is `async` and takes
 * one initial `await readCodexEngine(...)` before anything else can begin,
 * and every subsequent content re-read goes through a plain interval rather
 * than the cursor-gated re-read OpenCode's WAL `seq` makes possible — see
 * {@link DEFAULT_CODEX_ENGINE_POLL_INTERVAL_MS}'s comment for why a cursor is
 * not available here at all.
 *
 * ---------------------------------------------------------------------------
 * THE OVERLAY PATTERN, MIRRORED FROM `OpenCodeEnginePath.sessions()`
 * ---------------------------------------------------------------------------
 * Liveness is SESSION-LEVEL only, exactly as it is for the other two engines:
 * `AgentNode` carries no liveness field anywhere in this codebase, and
 * `SessionState.liveness` is the one place a verdict is rendered. The engine
 * therefore overlays {@link CodexLivenessEngine}'s latest report onto the
 * ROOT session only, keyed on `threadId === sessionId` (spec C11 — a root
 * thread's id equals its session id), the same "join, don't invent a second
 * representation" rule {@link OpenCodeEnginePath.sessions} already follows.
 *
 * `CodexAgentLiveness` ('live' | 'idle' | 'dead' | 'unknown') is a FOUR-value
 * union and `SessionState.liveness` is a different four-value union
 * ('live' | 'idle' | 'ended' | 'unsupported'). Neither `'dead'` nor
 * `'unknown'` names a member the other side has, so {@link mapCodexLiveness}
 * is a real decision, not a rename, and it is made once, in one place:
 * `'dead'` (the lock is gone AND no hook event arrived — D0.1, both
 * conjuncts) reads as `'ended'`, the closest existing claim about a session
 * that is no longer running. `'unknown'` (D0.1 could not be evaluated at
 * all — no lock directory to read and no hook event either) reads as
 * `'idle'` rather than as any stronger claim, matching `graft.ts`'s own
 * static default before any liveness is chained at all — the least
 * presumptuous of the three renderable values for a state that is genuinely
 * unread. This mapping is a Phase 3 decision, not a spec quotation; a
 * reviewer wanting a different one should treat it as the seam to change.
 *
 * ---------------------------------------------------------------------------
 * G1 / G2
 * ---------------------------------------------------------------------------
 * G1: every open below is read-only (`readCodexEngine` and
 * `scanCodexWriterLocks` between them use only `statSync` / `readdirSync` /
 * file reads; the G10 never-open list is applied inside `locate.ts`, not
 * here). G2: nothing in here can throw into the Claude Code or OpenCode
 * paths — every entry point catches, counts and continues, and {@link emit}
 * is called from a `try` of its own in {@link AgentDeckDataPath.pump}.
 */
export class CodexEnginePath {
  readonly root: string;
  readonly workspaceFolders: readonly string[];

  readonly #onChange: () => void;
  readonly #log: HostLogger;
  readonly #read: (options: CodexEngineOptions) => Promise<CodexEngineOutcome>;
  readonly #rootOverride?: string;
  readonly #env?: Record<string, string | undefined>;
  readonly #now: () => number;
  readonly #thresholdMs: number;
  readonly #pollIntervalMs: number;
  readonly #pollTrigger: PollTrigger;

  /**
   * Byte offsets and per-transcript state, held for the life of this path
   * (hotfix 0.6.1).
   *
   * Constructed HERE and nowhere else. It is what turns `readCodexEngine`
   * from "read every Codex transcript on the machine, once a second" into
   * "stat them, and read what changed" — see `src/codex/store.ts`.
   */
  readonly #tails = new CodexTailStore();
  readonly #maxTranscriptBytes: number;
  readonly #onDiagnostic?: (event: DiagnosticsEvent) => void;
  /**
   * Skips already announced, as `<path>|<reason>`.
   *
   * The channel says a thing ONCE. A 3 GB transcript that is skipped every
   * poll would otherwise write a line a second for as long as the window is
   * open, which is a log nobody can read and a diagnostic that hides the
   * others. The reason is part of the key so a file that changes size — and
   * therefore changes its `oversize:<bytes>` — is announced again.
   *
   * It is pruned against the current skip set on every read, so a file that
   * comes back under the limit and later goes over it is announced again
   * rather than silently suppressed for ever.
   */
  #announcedSkips = new Set<string>();

  #liveness: CodexLivenessEngine | null = null;
  #contentPollHandle: PollTriggerHandle | undefined;
  #content: readonly SessionState[] = [];
  #threads: readonly CodexThread[] = [];
  /**
   * Per thread, its transcript's size the FIRST time this process saw it
   * (v0.7.0 DoD 4.11c, user ruling 2026-09-10).
   *
   * The baseline the growth test compares against, latched once per thread and
   * never moved — re-latching on a later read would make every read its own
   * baseline and nothing could ever have grown. Keyed by `threadId` rather than
   * by file, because a file can declare more than one thread (C5) and it is the
   * THREAD whose activity is in question.
   *
   * Released on `dispose` with everything else. Nothing depends on that clear —
   * a disposed path never starts again (`#disposed` is terminal), so it is
   * housekeeping rather than a guard, and it is written down that way because a
   * `phase-verifier` correctly found no test could distinguish it.
   */
  #firstBytes = new Map<string, number>();
  /** Hook events this path has been handed. DoD 5.0b. */
  #hookEventsIngested = 0;
  /** The last read's skip list. A LEVEL — see `CodexEngineDiagnostics`. */
  #skipped: readonly SkippedFile[] = [];
  /**
   * `<root>/thread-writer-locks`, computed at construction — a deterministic
   * function of `root`, so it is correct even before any content read has
   * succeeded. Overwritten (to the identical value) once a real discovery
   * reports it, so this is the single source of truth rather than a second
   * one that happens to agree.
   */
  #lockDir: string;
  #previous = new Map<string, SessionState>();

  #enabled = false;
  #started = false;
  #disposed = false;

  #absentLogs = 0;
  /** The slow re-probe held only while the root is absent (DoD 1b.10). */
  #absentProbe: PollTriggerHandle | null = null;
  /** Times an absent root appeared later and this engine came up (DoD 1b.10). */
  #lateStarts = 0;
  #contentReads = 0;
  #contentFailures = 0;
  #unreadableReads = 0;
  #livenessPolls = 0;
  #emissions = 0;
  #lastError?: string;

  constructor(options: CodexPathOptions) {
    this.workspaceFolders = [...options.workspaceFolders];
    const resolved = resolveCodexRoot({
      ...(options.root === undefined ? {} : { root: options.root }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    this.root = resolved.root;
    this.#lockDir = join(this.root, CODEX_LOCK_DIR_NAME);
    if (options.root !== undefined) this.#rootOverride = options.root;
    this.#onChange = options.onChange;
    this.#log = options.log ?? consoleLogger;
    this.#read = options.read ?? readCodexEngine;
    if (options.env !== undefined) this.#env = options.env;
    this.#now = options.now ?? Date.now;
    this.#thresholdMs = options.thresholdMs;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_CODEX_ENGINE_POLL_INTERVAL_MS;
    this.#pollTrigger = options.pollTrigger ?? systemPollTrigger;
    this.#maxTranscriptBytes =
      options.maxTranscriptBytes ?? SETTING_BOUNDS['codex.maxTranscriptBytes'].default;
    if (options.onDiagnostic !== undefined) this.#onDiagnostic = options.onDiagnostic;
  }

  get diagnostics(): CodexEngineDiagnostics {
    return {
      enabled: this.#enabled,
      started: this.#started,
      disposed: this.#disposed,
      root: this.root,
      absentLogs: this.#absentLogs,
      contentReads: this.#contentReads,
      contentFailures: this.#contentFailures,
      unreadableReads: this.#unreadableReads,
      // On the surface rather than private: it is the one number that says
      // a deck filled LATE, and a counter nothing reads can be wrong
      // forever — which this repository shipped once in `relayed`.
      lateStarts: this.#lateStarts,
      livenessPolls: this.#livenessPolls,
      emissions: this.#emissions,
      sessions: this.#content.length,
      hookEventsIngested: this.#hookEventsIngested,
      skippedTranscripts: this.#skipped.length,
      tailsHeld: this.#tails.size,
      ...(this.#lastError !== undefined ? { lastError: this.#lastError } : {}),
    };
  }

  /** The live engine, or null when the root was absent at start. Diagnostics only. */
  get livenessEngine(): CodexLivenessEngine | null {
    return this.#liveness;
  }

  /**
   * Read once. Present -> start polling both content and liveness. Absent ->
   * off, logged once at info (DoD 2.1's rule, applied at the host boundary).
   *
   * Never throws, and never surfaces a dialog: a machine without Codex
   * installed is the normal case, not a fault.
   */
  async start(): Promise<void> {
    if (this.#disposed || this.#started) return;
    this.#started = true;

    const outcome = await this.#readAndApply();
    if (this.#disposed) return;

    if (outcome.kind === 'rootAbsent') {
      // ONCE, still: the re-probe below logs nothing, so a machine without
      // Codex says this one line for the life of the window and no more.
      this.#absentLogs += 1;
      this.#log('info', CODEX_ABSENT_LOG);
      this.#armAbsentReprobe();
      return;
    }
    this.#enable();
  }

  /**
   * Look again for a root that was absent at activation (v0.7.0 DoD 1b.10).
   *
   * Found by the 1b.8 smoke on the Claude Code half: an engine whose data
   * directory did not exist when the window opened stayed off for the life of
   * that window, because `start()` returned before arming anything. For Claude
   * Code that is the ORDINARY case — the slug directory is created by the
   * first session in a workspace — and for these two it is the narrower one of
   * installing or first running the tool with VS Code already open. Same
   * shape, same silence, and the same answer: look again.
   */
  #armAbsentReprobe(): void {
    if (this.#disposed || this.#absentProbe !== null) return;
    this.#absentProbe = this.#pollTrigger(() => {
      void this.#reprobeAbsentRoot();
    }, ABSENT_ROOT_REPROBE_MS);
  }

  async #reprobeAbsentRoot(): Promise<void> {
    if (this.#disposed || this.#enabled) return;
    const outcome = await this.#readAndApply();
    if (this.#disposed || outcome.kind === 'rootAbsent') return;
    this.#cancelAbsentReprobe();
    this.#lateStarts += 1;
    this.#enable();
    // The deck is stale by up to one probe interval, so say so now rather
    // than waiting for whatever would have emitted next.
    this.#onChange();
  }

  #cancelAbsentReprobe(): void {
    const handle = this.#absentProbe;
    this.#absentProbe = null;
    handle?.stop();
  }

  /** Everything `start()` does once the root is known to be there. */
  #enable(): void {
    this.#enabled = true;

    this.#liveness = new CodexLivenessEngine({
      now: this.#now,
      livenessThresholdMs: this.#thresholdMs,
      sample: () => this.#sample(),
      pollIntervalMs: this.#pollIntervalMs,
      pollTrigger: this.#pollTrigger,
      // The report itself is not consumed here: `sessions()` reads
      // `this.#liveness.latest` lazily, the same relationship
      // `OpenCodeEnginePath.sessions()` has with its own liveness engine.
      onUpdate: (_report: CodexLivenessReport) => {
        this.#livenessPolls += 1;
        this.#onChange();
      },
    });
    // The first content read (above) happens before the first liveness poll,
    // same reasoning `OpenCodeEnginePath.start` states: a snapshot taken
    // between the two is a tree with stale liveness rather than liveness
    // with no tree.
    this.#liveness.start();

    this.#contentPollHandle = this.#pollTrigger(() => {
      void this.#refresh();
    }, this.#pollIntervalMs);

    this.#onChange();
  }

  /** Idempotent. After this nothing here polls or holds a handle. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#liveness?.stop();
    this.#liveness = null;
    this.#contentPollHandle?.stop();
    this.#contentPollHandle = undefined;
    // The absent-root re-probe (DoD 1b.10), for the reason its OpenCode twin
    // gives: it is armed precisely on the windows that have no Codex.
    this.#cancelAbsentReprobe();
    this.#content = [];
    this.#threads = [];
    this.#firstBytes.clear();
    this.#previous.clear();
  }

  /** One hook event from the loopback listener (DoD 3.1's other half). Never throws. */
  ingestHookEvent(event: CodexHookEvent): void {
    // Counted BEFORE the null-check on the liveness engine, deliberately.
    // The question this counter answers is "has the Codex tap ever heard
    // anything", which is about the SOCKET and the user's paste block, not
    // about whether this path happens to have started its engine yet.
    this.#hookEventsIngested += 1;
    this.#liveness?.ingest(event);
  }

  /** The workspace-matching Codex sessions, with liveness overlaid onto the root. */
  sessions(): readonly SessionState[] {
    if (this.#disposed) return [];
    const report = this.#liveness?.latest;
    if (report === undefined) return this.#content;
    const byThread = new Map(report.threads.map((t) => [t.threadId, t] as const));
    return this.#content.map((session) => {
      const live = byThread.get(session.sessionId);
      if (live === undefined) return session;
      const mapped = mapCodexLiveness(live.state);
      if (mapped === session.liveness) return session;
      return { ...session, liveness: mapped };
    });
  }

  /**
   * A `SessionEmission` for the Codex half, diffed against the last one.
   *
   * The same shape `SessionModel.emit()` and `OpenCodeEnginePath.emit()`
   * produce, built with the same pure `diffSessionState` — not a third diff
   * implementation.
   */
  emit(): SessionEmission {
    if (this.#disposed) return EMPTY_EMISSION;
    const next = new Map<string, SessionState>();
    for (const session of this.sessions()) {
      next.set(session.sessionId, deepFreeze({ ...session }));
    }

    const diffs: SessionDiff[] = [];
    const addedSessionIds: string[] = [];
    const removedSessionIds: string[] = [];
    const schemaMismatchSessionIds: string[] = [];

    for (const [sessionId, state] of next) {
      const prev = this.#previous.get(sessionId);
      if (prev === undefined) {
        addedSessionIds.push(sessionId);
        if (!state.schemaOk) schemaMismatchSessionIds.push(sessionId);
        continue;
      }
      const patch = diffSessionState(prev, state);
      if (patch !== undefined) diffs.push({ sessionId, patch });
      if (!state.schemaOk && prev.schemaOk) schemaMismatchSessionIds.push(sessionId);
    }
    for (const sessionId of this.#previous.keys()) {
      if (!next.has(sessionId)) removedSessionIds.push(sessionId);
    }

    // Activity, per session, from the Codex liveness report (DoD 4.11b).
    //
    // A Codex session is a ROOT THREAD and its subagents, so the instant is the
    // latest of `lastHookEventMs` and `lastMtimeMs` across every thread of the
    // session: a subagent writing IS the session working. `CodexLiveness` is
    // keyed by `threadId` and carries no `sessionId`, so the mapping comes from
    // `#threads`, which is the same list `#sample()` hands the engine.
    //
    // **A session the liveness says nothing about is not recorded at all**, and
    // that is the dependency rather than a detail: no report (the engine has not
    // polled), no thread entry, or a thread with neither a hook event nor a
    // known mtime, all mean no activity is claimed. G3 — the alternative is
    // stamping "now" onto a session nobody witnessed, which is the flood.
    const lastActivityAt = new Map<string, number>();
    const activityReport = this.#liveness?.latest;
    if (activityReport !== undefined) {
      const sessionOfThread = new Map(
        this.#threads.map((thread) => [thread.threadId, thread.sessionId] as const),
      );
      /*
       * WHICH THREADS HAVE GAINED BYTES SINCE THIS PROCESS FIRST SAW THEM
       * (DoD 4.11c, user ruling 2026-09-10).
       *
       * The INSTANT still comes from the liveness report and only from there —
       * that is DoD 4.11b and `phase-verifier` round 3 turned it into two tests.
       * What comes from the content read is the SIZE, because the report carries
       * none, and the growth baseline is a per-process latch which a pure render
       * function has nowhere to keep.
       *
       * Mixing the two is safe in one direction and stated rather than assumed:
       * the report can be up to one poll older than the sizes, so a file that
       * grew a moment ago may be credited with a slightly earlier instant. That
       * makes promotion LATER, never earlier — the safe direction for a gate whose
       * failure mode is writing history.
       */
      const grownThreads = new Set<string>();
      for (const thread of this.#threads) {
        const first = this.#firstBytes.get(thread.threadId);
        // A SHRINK RE-BASELINES (user ruling, 2026-09-10), the same rule the
        // Claude Code leg applies: a transcript smaller than its baseline was
        // truncated or rewritten under this process's feet, and measuring growth
        // from a stale high-water mark would leave it unpromotable until it
        // passed its ORIGINAL size — a window of lost records rather than one.
        if (first === undefined || thread.sizeBytes < first) {
          this.#firstBytes.set(thread.threadId, thread.sizeBytes);
          continue;
        }
        if (thread.sizeBytes > first) grownThreads.add(thread.threadId);
      }
      for (const thread of activityReport.threads) {
        const sessionId = sessionOfThread.get(thread.threadId);
        if (sessionId === undefined || !next.has(sessionId)) continue;
        const instants: number[] = [];
        // A HOOK EVENT IS ALWAYS ACTIVITY. The tap fires because a tool ran.
        if (thread.lastHookEventMs !== null) instants.push(thread.lastHookEventMs);
        // AN MTIME IS ACTIVITY ONLY WITH BYTES BEHIND IT (DoD 4.11c).
        if (thread.lastMtimeMs !== null && grownThreads.has(thread.threadId)) {
          instants.push(thread.lastMtimeMs);
        }
        if (instants.length === 0) continue;
        const at = Math.max(...instants);
        const seen = lastActivityAt.get(sessionId);
        if (seen === undefined || at > seen) lastActivityAt.set(sessionId, at);
      }
    }

    this.#previous = next;
    this.#emissions += 1;
    return {
      sessions: [...next.values()],
      diffs,
      addedSessionIds,
      removedSessionIds,
      schemaMismatchSessionIds,
      lastActivityAt,
    };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** What one liveness poll samples: the cached threads, plus a fresh lock scan. */
  #sample(): CodexLivenessSample {
    const lockScan = scanCodexWriterLocks(this.#lockDir);
    const toolCalls: CodexToolCall[] = this.#threads.flatMap((t) => [...t.toolCalls]);
    return { threads: this.#threads, lockScan, toolCalls };
  }

  /** A periodic content re-read. Never throws; failures are counted (G2). */
  async #refresh(): Promise<void> {
    if (this.#disposed) return;
    await this.#readAndApply();
    if (this.#disposed) return;
    this.#onChange();
  }

  /**
   * Read the Codex engine once and apply the outcome. Returns the outcome so
   * {@link start} can decide whether the root was absent on the FIRST call
   * without a second read.
   */
  async #readAndApply(): Promise<CodexEngineOutcome> {
    this.#contentReads += 1;
    let outcome: CodexEngineOutcome;
    try {
      outcome = await this.#read({
        ...(this.#rootOverride === undefined ? {} : { root: this.#rootOverride }),
        ...(this.#env === undefined ? {} : { env: this.#env }),
        workspaceFolders: this.workspaceFolders,
        // The two halves of hotfix 0.6.1 that the HOST owns: a store whose
        // lifetime is this path's, and the user's size limit.
        tails: this.#tails,
        maxTranscriptBytes: this.#maxTranscriptBytes,
      });
    } catch (error) {
      // Documented never to happen — the engine returns outcomes rather than
      // throwing — and caught anyway, for the same reason
      // `OpenCodeEnginePath.#refreshContent` catches: DoD 5.3's isolation
      // property must hold whatever this engine does.
      this.#contentFailures += 1;
      this.#lastError = error instanceof Error ? error.message : String(error);
      return { kind: 'unreadable', root: this.root, reason: this.#lastError };
    }

    switch (outcome.kind) {
      case 'ok':
        this.#threads = outcome.result.threads;
        this.#lockDir = outcome.result.discovery.lockDir;
        this.#content = outcome.result.sessions.filter(belongsOnDeck);
        this.#reportSkips(outcome.result.skipped);
        return outcome;
      case 'unreadable':
        // G3/G2: the engine is unusable right now. The last good content and
        // threads are KEPT — the engine has stopped seeing, it has not
        // learned that anything ended — matching
        // `OpenCodeEnginePath.#refreshContent`'s degraded-read reasoning.
        this.#unreadableReads += 1;
        this.#lastError = `codex engine unreadable: ${outcome.reason}`;
        return outcome;
      case 'rootAbsent':
        // Only reachable here on a poll AFTER the root existed at `start()`
        // (a `start()`-time absence returns before any poll is registered).
        // Last good content is kept for the same reason as `unreadable`; the
        // ONCE-logged line belongs to `start()` alone, so nothing is logged
        // again here.
        this.#lastError = `codex root absent: ${outcome.root}`;
        return outcome;
    }
  }

  /**
   * Announce each skipped transcript ONCE, on the diagnostics channel.
   *
   * The engine reports the whole skip set every pass — that is rule 18, and a
   * verdict that stopped restating a skip would be a count of zero nobody
   * could tell from "nothing was skipped". The CHANNEL is the other side of
   * that: a line per poll per file is a log nobody reads.
   *
   * The basename, never the path: an absolute transcript path begins
   * `C:\Users\<user>\` on Windows and this channel is a surface a user is
   * invited to paste into a bug report. `bridge/diagnostics.ts` makes the same
   * decision for refusals, for the same reason.
   */
  #reportSkips(skipped: readonly SkippedFile[]): void {
    this.#skipped = skipped;
    const current = new Set(skipped.map((skip) => `${skip.path}|${skip.reason}`));
    for (const key of [...this.#announcedSkips]) {
      if (!current.has(key)) this.#announcedSkips.delete(key);
    }
    for (const skip of skipped) {
      const key = `${skip.path}|${skip.reason}`;
      if (this.#announcedSkips.has(key)) continue;
      this.#announcedSkips.add(key);
      this.#log('info', `Agent Deck: skipping Codex transcript (${skip.reason})`);
      // A diagnostics sink must never be able to break a read.
      try {
        this.#onDiagnostic?.({
          kind: 'transcriptSkipped',
          engine: 'codex',
          file: basenameOfPath(skip.path),
          reason: skip.reason,
        });
      } catch {
        // Counted nowhere on purpose: this class has no consumer-error
        // counter, and inventing one to record a throwing logger would be
        // scope. The skip itself is still in `diagnostics.skippedTranscripts`.
      }
    }
  }
}

/** Last path segment, on either separator. `bridge/diagnostics.ts` has its own. */
function basenameOfPath(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at === -1 ? path : path.slice(at + 1);
}

/** `CodexAgentLiveness` -> `SessionState.liveness`. See the class doc above. */
function mapCodexLiveness(state: CodexAgentLiveness): SessionState['liveness'] {
  switch (state) {
    case 'live':
      return 'live';
    case 'idle':
      return 'idle';
    case 'dead':
      return 'ended';
    case 'unknown':
      return 'idle';
  }
}

// ---------------------------------------------------------------------------
// (b) The data path
// ---------------------------------------------------------------------------

/** What {@link AgentDeckDataPath} hands its consumer on every emission. */
export interface DataPathEmission {
  emission: SessionEmission;
  /**
   * The CLAUDE CODE tap's health. Kept under its old name because that is
   * what it always was - the name simply did not say so.
   */
  degraded: BridgeDegradedState;
  /**
   * The CODEX tap's health (DoD 5.0b), sourced from the Codex path and
   * never from `liveness.degradedState()`.
   *
   * A separate field rather than a merged worst-of, because merging is how
   * D2 happened: one value cannot be true of two taps, and a panel that
   * renders the worse of the two tells a working engine it is broken.
   */
  codexDegraded: BridgeDegradedState;
}

export interface DataPathOptions {
  /** Absolute path of the workspace VS Code has open. */
  workspacePath: string;
  settings: AgentDeckSettings;
  /** Receives every emission. Throwing is caught and counted, never fatal. */
  onEmission: (emission: DataPathEmission) => void;
  /** User-visible failures: a port collision, an unexpected throw. */
  onError?: (error: unknown) => void;
  /**
   * Receives one {@link DiagnosticsEvent} per refused graft (F2, 2026-08-31).
   *
   * A CALLBACK rather than a `DiagnosticsChannel` handle, for the same reason
   * `onEmission` is one: this class must stay constructible with no channel, no
   * `vscode`, and no output sink, and `extension.test.ts` drives it that way.
   * The host passes `channel.record`; absent, refusals are still counted and
   * still kept in {@link DataPathDiagnostics.lastGraftRefusal}, they simply do
   * not produce a line.
   *
   * Throwing from it is the caller's problem and is caught at the call site —
   * a diagnostics sink must never be able to break a graft.
   */
  onDiagnostic?: (event: DiagnosticsEvent) => void;
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

  /**
   * Whether the Claude Code half runs at all. Defaults to `true`.
   *
   * `false` means: no watcher, no hook socket, no CC timer — the CC engine is
   * not merely empty, it is off. `activate()` sets it from the correlation
   * result, so a workspace with OpenCode sessions and no Claude Code project
   * directory still gets a deck.
   *
   * This is G2 in the activation dimension. Gating the OpenCode engine behind
   * a Claude Code correlation would be a shared failure path between two
   * sources whose entire architectural point is not having one, and DoD 5.2's
   * "on by default when the data directory exists" says nothing about Claude
   * Code.
   */
  ccEnabled?: boolean;

  /**
   * The OpenCode half's options, minus the ones this data path supplies.
   *
   * Absent is NOT "off": the path is still constructed and still probes for a
   * store, because DoD 5.2's switch is the store's existence and nothing else.
   * What is absent here is only the injection.
   */
  opencode?: Omit<
    OpenCodePathOptions,
    'workspacePaths' | 'thresholdMs' | 'onChange' | 'env'
  >;

  /**
   * The Codex half's options, minus the ones this data path supplies.
   *
   * Same "absent is NOT off" rule as {@link DataPathOptions.opencode}: the
   * path is still constructed and still probes for a data root, because the
   * switch is the root's existence and nothing else (DoD 3.2, mirroring DoD
   * 5.2's "on by default").
   */
  codex?: Omit<CodexPathOptions, 'workspaceFolders' | 'thresholdMs' | 'onChange' | 'env'>;

  /**
   * EVERY open workspace folder (gate amendment B6). Defaults to
   * `[workspacePath]`.
   *
   * The CC half reads {@link DataPathOptions.workspacePath} and only that, so
   * in a multi-root workspace the two engines observe different sets. That
   * asymmetry is pre-existing, deliberate, and recorded at the `activate()`
   * call site rather than hidden by narrowing OpenCode to match.
   */
  workspacePaths?: readonly string[];

  /** Defaults to {@link consoleLogger}. Forwarded to the OpenCode path. */
  log?: HostLogger;
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
  /**
   * The most recent REFUSAL, kept exactly the way {@link lastGraftError} keeps
   * the most recent throw (F2, 2026-08-31).
   *
   * The asymmetry this closes: a graft that threw was explained and a graft
   * that refused was a bare number, and refusal is the designed path. Every
   * field here is a name, a type, a version or a line number — never a value
   * out of a transcript; `graftRefusedEvent` in `bridge/diagnostics.ts` owns
   * that contract and the path reduction that goes with it.
   */
  lastGraftRefusal?: {
    sessionId: string;
    code: string;
    at?: string;
    field?: string;
    expected?: string;
    actual?: string;
  };
  /**
   * Malformed transcript lines across every session currently observed
   * (DoD 5.5.3).
   *
   * A LEVEL, not a running total, and the distinction is load-bearing. Every
   * graft is a whole-session re-read, so adding each graft's count to a
   * cumulative sum would multiply one bad line by the number of times the
   * session was re-grafted — on a live session, hundreds. This is the sum of
   * the most recent count per session, which is the number of malformed lines
   * on disk right now.
   */
  malformedLines: number;
  /**
   * Lines skipped for a recognised-but-unmodelled `type` (DoD 5.5.6), by the
   * same per-session-level rule as {@link malformedLines}.
   *
   * **The name in the diagnostics line is `unknownFields`, and this counter is
   * not one.** DoD 5.5.3 names a field-level counter; no such counter exists
   * anywhere in this repository and inventing one would mean enumerating every
   * field CC writes, which G9 deliberately refuses to do (unknown FIELDS are
   * tolerated without enumeration — that is the compatibility story). What can
   * be counted honestly is unmodelled entry TYPES, which is what a user
   * actually needs to see when CC drifts. Recorded here rather than smoothed
   * over, because a line labelled `unknownFields` that counts something else
   * is exactly the class of quiet mislabelling this repo keeps paying for.
   */
  ignoredLines: number;
  /** `onEmission` threw. The data path keeps running (G2). */
  consumerErrors: number;
  /** Timers currently armed. Must be 0 after {@link AgentDeckDataPath.dispose}. */
  timersArmed: number;
  /** False when the Claude Code half was switched off at construction. */
  ccEnabled: boolean;
  /**
   * Whether {@link AgentDeckDataPath.start} tried to bind the hook socket.
   *
   * `false` is a DECISION, not a failure: no Claude Code project correlated
   * and no Codex data root exists, so nothing in this window is hook-driven
   * and binding a port would be allocating a socket for no observer. Read it
   * beside `listening` — `attempted && !listening` is a real bind failure and
   * `!attempted && !listening` is a quiet window.
   */
  hookBindAttempted: boolean;
  /** Times {@link NO_HOOK_ENGINE_LOG} was emitted. Exactly 0 or 1. */
  noHookEngineLogs: number;
  /**
   * `SessionModel.emit()` threw and the emission was assembled without its
   * half. DoD 5.3's CC -> OpenCode direction, counted.
   */
  ccEmitErrors: number;
  /**
   * {@link OpenCodeEnginePath.emit} threw and the emission was assembled
   * without its half. DoD 5.3's OpenCode -> CC direction, counted.
   */
  opencodeEmitErrors: number;
  /**
   * {@link CodexEnginePath.emit} threw and the emission was assembled
   * without its half. DoD 5.3's Codex -> {CC, OpenCode} direction, counted.
   */
  codexEmitErrors: number;
  /** The OpenCode half's own counters. */
  opencode: OpenCodeDiagnostics;
  /** The Codex half's own counters. */
  codex: CodexEngineDiagnostics;
}

/**
 * Everything between the filesystem/socket and the panel.
 *
 * Deliberately knows nothing about `vscode`: it takes a callback and a few
 * seams, so the tests exercise the REAL `SessionModel`, `ProjectWatcher`,
 * `HookListener` and `LivenessEngine` against fixtures with no editor present.
 */
/**
 * The message logged, ONCE, when nothing in this window is hook-driven so the
 * loopback socket is deliberately not bound.
 *
 * A named constant for the reason {@link OPENCODE_ABSENT_LOG} is one: "logged
 * exactly once" is an assertable property only while the string is the same
 * string every time.
 */
export const NO_HOOK_ENGINE_LOG =
  'Agent Deck: no Claude Code project and no Codex data root; the hook listener is not bound.';

export class AgentDeckDataPath {
  readonly workspacePath: string;
  /** Every open workspace folder. See {@link DataPathOptions.workspacePaths}. */
  readonly workspacePaths: readonly string[];
  readonly settings: AgentDeckSettings;
  readonly liveness: LivenessEngine;
  readonly model: SessionModel;
  readonly listener: SharedHookListener;
  readonly watcher: ProjectWatcher;
  /** The second engine. Always constructed; enabled by its store's existence. */
  readonly opencode: OpenCodeEnginePath;
  /** The third engine. Always constructed; enabled by its data root's existence. */
  readonly codex: CodexEnginePath;

  readonly #ccEnabled: boolean;
  readonly #log: HostLogger;
  readonly #onEmission: (emission: DataPathEmission) => void;
  readonly #onError: (error: unknown) => void;
  readonly #onDiagnostic?: (event: DiagnosticsEvent) => void;
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
  /** Latest per-session parse levels. Keyed by session id. */
  readonly #parseLevels = new Map<string, { malformed: number; ignored: number }>();
  #graftErrors = 0;
  #lastGraftError?: string;
  #lastGraftRefusal?: DataPathDiagnostics['lastGraftRefusal'];
  #consumerErrors = 0;
  #ccEmitErrors = 0;
  #opencodeEmitErrors = 0;
  #codexEmitErrors = 0;
  /** Times {@link NO_HOOK_ENGINE_LOG} was emitted. The rule's "once" is 1. */
  #noHookEngineLogs = 0;
  /**
   * Whether {@link start} intended to bind the socket at all.
   *
   * Not the same question as `listening`: this one is "was anything in this
   * window hook-driven", and it is what makes an unbound socket a fact rather
   * than a fault. See {@link AgentDeckDataPath.#degradedState}.
   */
  #hookBindAttempted = false;
  #bindError?: { code: string; port: number; message: string };
  /** The shared listener's role, mirrored for the counters line (DoD 1b.7). */
  #relayRole: RelayRole = 'idle';

  constructor(options: DataPathOptions) {
    this.workspacePath = options.workspacePath;
    this.workspacePaths = options.workspacePaths ?? [options.workspacePath];
    this.#ccEnabled = options.ccEnabled ?? true;
    this.#log = options.log ?? consoleLogger;
    this.settings = options.settings;
    this.#onEmission = options.onEmission;
    this.#onError = options.onError ?? ((): void => {});
    this.#onDiagnostic = options.onDiagnostic;
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

    /*
     * PHASE 1b — A SHARED LISTENER, NOT A PRIVATE ONE.
     *
     * The port is fixed because the pasted hook snippet names it literally, so
     * a second window could never bind it and lost liveness entirely. This
     * object binds when it can and attaches to whichever window did when it
     * cannot; nothing below this line learns which of the two it got.
     *
     * `tailsSession` is a THUNK over the live model rather than a snapshot of
     * its session ids. A follower attaches at activation, when the model has
     * discovered nothing yet, and a set captured here would be empty forever —
     * the ownership filter would then rest entirely on `cwd`, and every
     * subagent event (whose `cwd` is the agent's, not the workspace's) would be
     * dropped as foreign.
     */
    this.listener = new SharedHookListener({
      port: options.settings.port,
      previewBytes: options.settings.previewBytes,
      workspacePaths: this.workspacePaths,
      tailsSession: (sessionId) => this.model.hasSession(sessionId),
      ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
      onRoleChange: (role) => {
        this.#relayRole = role;
        this.#onDiagnostic?.({ kind: 'listenerRole', role, port: options.settings.port });
      },
    });
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

    // ---- the second engine (DoD 5.2) -------------------------------------
    //
    // Constructed unconditionally and started in `start()`. It shares NOTHING
    // with the four objects above: no clock, no scheduler, no watcher, no
    // socket, and no failure path. That is what DoD 5.3 asserts, and it is a
    // property of this wiring rather than of a comment.
    this.opencode = new OpenCodeEnginePath({
      workspacePaths: this.workspacePaths,
      thresholdMs: options.settings.livenessThresholdMs,
      onChange: () => {
        this.#scheduleEmit();
      },
      ...(options.log !== undefined ? { log: options.log } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...options.opencode,
    });

    // ---- the third engine (DoD 3.2) --------------------------------------
    //
    // Same discipline as the OpenCode construction immediately above: shares
    // nothing with the CC objects or with `this.opencode` — no clock, no
    // scheduler, no watcher, no socket, and no failure path.
    this.codex = new CodexEnginePath({
      workspaceFolders: this.workspacePaths,
      thresholdMs: options.settings.livenessThresholdMs,
      maxTranscriptBytes: options.settings['codex.maxTranscriptBytes'],
      onChange: () => {
        this.#scheduleEmit();
      },
      // The same sink the CC half writes refusals to, so a skipped Codex
      // transcript and a refused CC session land in one place.
      ...(options.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {}),
      ...(options.log !== undefined ? { log: options.log } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...options.codex,
    });
  }

  /** Sum one per-session parse level across the sessions still known. */
  #parseLevel(key: 'malformed' | 'ignored'): number {
    let total = 0;
    for (const level of this.#parseLevels.values()) total += level[key];
    return total;
  }

  /** This window's shared-listener role (Phase 1b). */
  get relayRole(): RelayRole {
    return this.#relayRole;
  }

  /** The shared listener's relay accounting (Phase 1b). */
  get relayCounters(): Readonly<RelayCounters> {
    return this.listener.relayCounters;
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
      ccEnabled: this.#ccEnabled,
      hookBindAttempted: this.#hookBindAttempted,
      noHookEngineLogs: this.#noHookEngineLogs,
      ccEmitErrors: this.#ccEmitErrors,
      opencodeEmitErrors: this.#opencodeEmitErrors,
      codexEmitErrors: this.#codexEmitErrors,
      malformedLines: this.#parseLevel('malformed'),
      ignoredLines: this.#parseLevel('ignored'),
      opencode: this.opencode.diagnostics,
      codex: this.codex.diagnostics,
      ...(this.#bindError !== undefined ? { bindError: this.#bindError } : {}),
      ...(this.#lastGraftError !== undefined ? { lastGraftError: this.#lastGraftError } : {}),
      ...(this.#lastGraftRefusal !== undefined
        ? { lastGraftRefusal: this.#lastGraftRefusal }
        : {}),
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

    // FIRST, and outside every `try` below. The OpenCode engine must not be
    // reachable from any Claude Code failure — including the two early returns
    // in this method, which is exactly how a "both engines start" claim would
    // become false without a single test going red.
    this.opencode.start();

    // Same placement, same reasoning, for the third engine. Awaited because
    // `CodexEnginePath.start()` performs one initial async `readCodexEngine()`
    // call before it can begin polling; this method is already `async`, so
    // awaiting here costs nothing that was not already being paid, and it
    // must happen before the `!this.#ccEnabled` early return below for the
    // same reason `this.opencode.start()` does: no Claude Code failure or
    // disablement may be reachable from whether Codex started.
    await this.codex.start();

    /*
     * -----------------------------------------------------------------------
     * THE SOCKET BINDS FOR *ANY* HOOK-DRIVEN ENGINE (user decision 2026-09-04)
     * -----------------------------------------------------------------------
     *
     * Until this ruling the bind sat behind `ccEnabled`, and the consequence
     * was a live product gap rather than a tidiness question: `activate()`
     * sets `ccEnabled` from the Claude Code correlation, so it is false
     * whenever the open workspace has no matching CC project — AN ORDINARY
     * STATE for someone running Codex where Claude Code has never run. The old
     * early return came out of this method above `listener.start()` and above
     * `subscribeCodex`, so the socket was never bound and Codex liveness never
     * saw a hook event. Nothing failed; the tap was simply silent, which is
     * the failure shape this repository keeps paying for.
     *
     * The rule now: bind when ANY engine that is fed by hooks is observable —
     * a CC project correlates, OR there is a Codex data root. Neither, and the
     * socket is deliberately not bound, said once at info. A port collision
     * remains an error surfaced to the user and is NEVER a silent re-pick: the
     * port is a setting, and a listener that quietly moves is a capture that
     * silently records nothing.
     *
     * `codex.diagnostics.enabled` is the probe, and it is deliberately the
     * engine's OWN answer rather than a second `existsSync` here: `start()`
     * above has already resolved the root (honouring `$CODEX_HOME` and any
     * injected fixture root) and read it. A separate check could disagree with
     * the engine it is deciding for, and would do it silently.
     */
    const codexObservable = this.codex.diagnostics.enabled;

    /*
     * SUBSCRIBED UNCONDITIONALLY, AND BEFORE THE CC GATE BELOW.
     *
     * G2 in the wiring dimension, and the same placement reasoning as
     * `opencode.start()` above: no Claude Code disablement may be reachable
     * from whether a Codex hook event finds its handler. It is a subscription
     * on an object that exists either way, so it costs nothing when the socket
     * never binds.
     */
    this.listener.subscribeCodex((event) => {
      this.codex.ingestHookEvent(event);
    });

    if (this.#ccEnabled) {
      this.listener.subscribe(this.model.onHookEvent);
      this.listener.subscribe(() => {
        this.#scheduleEmit();
      });
    }

    if (!this.#ccEnabled && !codexObservable) {
      // ONCE, and at info: a window with neither engine is a normal window,
      // not a fault. The counter exists so a test can prove the "once" rather
      // than assume it — the same shape as CODEX_ABSENT_LOG.
      this.#noHookEngineLogs += 1;
      this.#log('info', NO_HOOK_ENGINE_LOG);
      this.pump();
      return;
    }

    this.#hookBindAttempted = true;
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

    if (!this.#ccEnabled) {
      // The socket is bound — for Codex — and everything below this line is
      // the Claude Code half: its watcher, its first drain, its tick. The
      // correlation gate's original point (a non-matching workspace allocates
      // no watcher and no CC timer) is preserved exactly; what it no longer
      // takes down with it is the shared tap.
      this.pump();
      return;
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

    /*
     * THREE HALVES, THREE `try`s, AND THAT IS THE WHOLE OF DoD 5.3 IN CODE.
     *
     * A single `try` around all three would be a shared failure path: a throw
     * out of any one engine's `emit()` would drop the OTHER engines' sessions
     * from the round, which is precisely the cross-contamination the phase
     * exists to forbid. Each half is assembled independently, each failure is
     * counted, and a round is abandoned only when ALL THREE failed — which is
     * also what preserves the pre-Phase-5 behaviour exactly when there is no
     * OpenCode store and no Codex root (`#emitOpenCode`/`#emitCodex` return
     * null and a CC throw aborts the round, as it always did).
     */
    const cc = this.#emitCc();
    const oc = this.#emitOpenCode();
    const codex = this.#emitCodex();
    if (cc === null && oc === null && codex === null) return;

    const payload: DataPathEmission = {
      emission: mergeEmissions(cc ?? EMPTY_EMISSION, oc ?? EMPTY_EMISSION, codex ?? EMPTY_EMISSION),
      // The hook tap's health, and only that. Neither the OpenCode nor the
      // Codex engine's health is folded in here: `DegradedMessage.reason` is
      // a two-value union naming hook-tap states (`noHookEvents`,
      // `listenerDown`), so reporting either engine's degrade through it
      // would tell the webview the hook listener was down when it is not. A
      // second or third engine's health needs its own channel; that is a
      // later phase's contract change, and its absence is recorded in
      // `diagnostics.opencode` / `diagnostics.codex` meanwhile.
      degraded: this.#degradedState(),
      codexDegraded: this.#codexDegradedState(),
    };
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
    // First, and unconditionally: the OpenCode poll trigger and WAL watch, and
    // the Codex poll triggers, must not outlive the host even if a Claude Code
    // teardown below rejects.
    this.opencode.dispose();
    this.codex.dispose();
    await this.watcher.dispose();
    await this.listener.stop();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** The Claude Code half, or null when it threw. Never rethrows. */
  #emitCc(): SessionEmission | null {
    try {
      return this.model.emit();
    } catch (error) {
      // `emit()` is documented not to throw; counted rather than trusted.
      this.#ccEmitErrors += 1;
      this.#consumerErrors += 1;
      this.#onError(error);
      return null;
    }
  }

  /**
   * The OpenCode half, or null when it threw OR when there is no store.
   *
   * `null` for "no store" is load-bearing: it is what makes a Claude-Code-only
   * host behave byte-identically to the pre-Phase-5 one, `pump()`'s
   * `cc === null && oc === null` guard included.
   */
  #emitOpenCode(): SessionEmission | null {
    if (!this.opencode.diagnostics.enabled) return null;
    try {
      return this.opencode.emit();
    } catch (error) {
      this.#opencodeEmitErrors += 1;
      this.#onError(error);
      return null;
    }
  }

  /**
   * The Codex half, or null when it threw OR when there is no data root.
   *
   * Same `null`-for-"absent" contract as {@link #emitOpenCode}, and for the
   * same reason: a host with no Codex root behaves byte-identically to one
   * with only CC and OpenCode, `pump()`'s three-way null guard included.
   */
  #emitCodex(): SessionEmission | null {
    if (!this.codex.diagnostics.enabled) return null;
    try {
      return this.codex.emit();
    } catch (error) {
      this.#codexEmitErrors += 1;
      this.#onError(error);
      return null;
    }
  }

  /**
   * The hook tap's health, defended against a liveness engine that throws.
   *
   * -------------------------------------------------------------------------
   * THIS IS THE CLAUDE CODE TAP'S HEALTH, AND ONLY WHILE THAT TAP IS RUNNING
   * -------------------------------------------------------------------------
   *
   * `LivenessEngine.degradedState()` answers with `noHookEvents` as soon as
   * `eventsReceived === 0`, which is a true statement about the CC engine and
   * a MEANINGLESS one when the CC engine is switched off — it has received no
   * events because nothing feeds it, not because the user's hooks are silent.
   * Reporting it anyway is the D2 defect one level up from where D2 was fixed:
   * the webview stopped labelling every CARD with a CC-only flag on
   * 2026-09-03, and this is the panel-wide banner saying the same wrong thing.
   *
   * It became reachable on 2026-09-04, when the socket started binding for
   * Codex alone. Before that a `ccEnabled: false` window never bound and never
   * emitted anything about hooks; now it binds, works, and would have claimed
   * its own hooks were silent forever.
   *
   * So when the CC half is off, the only question left with an answer is
   * whether the socket Codex needs is up:
   *
   *   - bind attempted and listening  -> not degraded.
   *   - bind attempted and not up     -> `listenerDown`, which is true and
   *                                      actionable: Codex liveness is blind.
   *   - never attempted               -> not degraded. Nothing here is
   *                                      hook-driven, so there is nothing to
   *                                      be degraded about.
   */
  /**
   * THE CODEX TAP'S HEALTH (DoD 5.0b), and it asks the Codex path, never the
   * Claude Code liveness engine.
   *
   * The same three questions {@link #degradedState} asks about Claude Code,
   * asked about the other tap - which is the point of the item. D2 stopped
   * the panel LYING about Codex by narrowing what it rendered; it did not
   * give Codex anything true to say, so a Codex user whose paste block was
   * missing or whose port was taken saw a deck that simply never went live,
   * with no banner and nothing to act on.
   *
   *   - engine off (no Codex data root) -> not degraded. There is nothing
   *     here to be degraded about, and a banner would be about an engine
   *     the user does not run.
   *   - bind never attempted            -> not degraded, same reason.
   *   - bind attempted, socket down     -> `listenerDown`. True and
   *     actionable: Codex liveness is blind.
   *   - listening, nothing ever heard   -> `noHookEvents`. The paste block
   *     is missing, or the six commands were never trusted.
   *
   * The last case is what `livenessThresholdMs` means for this tap: a
   * session whose hooks never arrive falls back to transcript-mtime
   * inference, which is the same degraded footing Claude Code lands on.
   */
  #codexDegradedState(): BridgeDegradedState {
    if (!this.codex.diagnostics.enabled) return { degraded: false };
    if (!this.#hookBindAttempted) return { degraded: false };
    if (!this.listener.listening) return { degraded: true, reason: 'listenerDown' };
    return this.codex.diagnostics.hookEventsIngested === 0
      ? { degraded: true, reason: 'noHookEvents' }
      : { degraded: false };
  }

  #degradedState(): BridgeDegradedState {
    if (!this.#ccEnabled) {
      if (!this.#hookBindAttempted) return { degraded: false };
      return this.listener.listening ? { degraded: false } : { degraded: true, reason: 'listenerDown' };
    }
    try {
      return this.liveness.degradedState();
    } catch {
      this.#ccEmitErrors += 1;
      return { degraded: true, reason: 'listenerDown' };
    }
  }

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
        // The level goes with the session. Leaving it behind would keep
        // counting malformed lines in a transcript nobody is watching.
        this.#parseLevels.delete(sessionId);
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
      if (!result.ok) {
        this.#graftRefusals += 1;
        /*
         * F2 — THE REASON, NOT JUST THE COUNT.
         *
         * `result.mismatch` used to be handed to `ingestGraftResult` and
         * forgotten. `graftRefusals=N` then said a refusal happened and nothing
         * about which session, which file, which line, or what disagreed —
         * while the rarer THROW path kept its message and printed it. On
         * 2026-08-31 that gap made one teleported transcript
         * (`version: "1.0"`) read as "the CC adapter is broken on 2.1.251".
         *
         * Built through `graftRefusedEvent` rather than inline, so the level
         * below and the line cannot describe the refusal differently and the
         * path reduction cannot be skipped by one of the two.
         */
        const event = graftRefusedEvent(sessionId, 'cc', {
          code: isFingerprintMismatch(result.mismatch) ? result.mismatch.code : 'schemaMismatch',
          ...(result.mismatch.path === undefined ? {} : { path: result.mismatch.path }),
          ...(result.mismatch.field === undefined ? {} : { field: result.mismatch.field }),
          ...(result.mismatch.expected === undefined
            ? {}
            : { expected: result.mismatch.expected }),
          ...(result.mismatch.actual === undefined ? {} : { actual: result.mismatch.actual }),
        });
        if (event.kind === 'graftRefused') {
          const { kind: _kind, engine: _engine, ...level } = event;
          this.#lastGraftRefusal = level;
        }
        // A diagnostics sink must never be able to break a graft. Counted as a
        // consumer error, the same as a throwing `onEmission`.
        try {
          this.#onDiagnostic?.(event);
        } catch {
          this.#consumerErrors += 1;
        }
      }
      // Per-session LEVELS, replaced rather than accumulated. See
      // `DataPathDiagnostics.malformedLines` for why a running total would be
      // wrong by a factor of "how live is this session".
      this.#parseLevels.set(sessionId, {
        malformed: result.diagnostics.malformedLines,
        ignored: result.diagnostics.ignoredLines,
      });
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

/**
 * Three engines' emissions, concatenated into the one the bridge publishes.
 *
 * Concatenation and nothing else: no dedup, no re-sort, no merge of two
 * sessions that happen to share an id. Session ids come from different
 * namespaces (a CC UUID, an OpenCode `ses_*`, a Codex thread uuid), so a
 * collision would be a defect to surface rather than a case to smooth over —
 * and smoothing it over is how one engine would start silently overwriting
 * another's tree.
 *
 * Claude Code first, then OpenCode, then Codex, so the deck's order is stable
 * as either of the other two sets changes.
 */
function mergeEmissions(
  cc: SessionEmission,
  oc: SessionEmission,
  codex: SessionEmission,
): SessionEmission {
  return mergeTwo(mergeTwo(cc, oc), codex);
}

/** The pairwise merge {@link mergeEmissions} folds three engines through. */
function mergeTwo(a: SessionEmission, b: SessionEmission): SessionEmission {
  if (b === EMPTY_EMISSION) return a;
  if (a === EMPTY_EMISSION) return b;
  return {
    sessions: [...a.sessions, ...b.sessions],
    diffs: [...a.diffs, ...b.diffs],
    addedSessionIds: [...a.addedSessionIds, ...b.addedSessionIds],
    removedSessionIds: [...a.removedSessionIds, ...b.removedSessionIds],
    schemaMismatchSessionIds: [
      ...a.schemaMismatchSessionIds,
      ...b.schemaMismatchSessionIds,
    ],
    // The UNION, and it is load-bearing: the pipeline only ever sees the merged
    // emission, so an engine whose map were dropped here would have every one
    // of its sessions read as history and none of them recorded. Ids come from
    // three namespaces (a CC uuid, an OpenCode `ses_*`, a Codex thread uuid), so
    // a collision would be the defect this function's header describes rather
    // than a case to smooth over.
    lastActivityAt: new Map([...a.lastActivityAt, ...b.lastActivityAt]),
  };
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
  /**
   * `resyncRequest` messages accepted from the webview (DoD 5.5.2).
   *
   * Separate from `reloads` although both end in the same repair, because
   * they mean opposite things about the health of the wire: a reload is the
   * editor tearing the document down, which is normal, and a resync is the
   * renderer reporting that a patch did not apply, which is not.
   */
  resyncs: number;
  /**
   * Stats records this panel refused to put on the wire (v0.7.0 DoD 4.1):
   * failed the Phase 2 validator on the host, dropped, counted. The rest of
   * the message still went out.
   */
  statsDropped: number;
}

// Where the built webview assets live inside the packaged extension. Declared
// in `bridge/panel-assets.ts` since v0.7.0 Phase 4 so the sidebar names the
// SAME two files; re-exported here so every caller keeps its import.
export { WEBVIEW_SCRIPT_SEGMENTS, WEBVIEW_STYLE_SEGMENTS };

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
    resyncs: 0,
    statsDropped: 0,
  };
  /**
   * The last `settings` message sent, re-sent on every reload (DoD 4.0).
   *
   * A reload is a NEW document that knows nothing — the same reason the
   * bridge re-snapshots — so the renderer's `canvasAutoFit` would otherwise
   * silently fall back to its default after every hide/restore.
   */
  #settings: SettingsMessage | null = null;

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
        // Settings AFTER the snapshot the pump supplied: the bridge's first
        // message to a fresh document is a snapshot, and that invariant is
        // older than this message. The renderer's default is the manifest
        // default, so nothing is decided wrongly in the gap.
        if (this.#settings !== null) this.#panel.postMessage(this.#settings);
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
    // BOTH TAPS, every publish (DoD 5.0b). The bridge remembers each one
    // separately, so this is still send-on-transition and still no-nagging -
    // it is two independent no-nagging rules rather than one shared one.
    this.bridge.publishDegraded('cc', payload.degraded);
    this.bridge.publishDegraded('codex', payload.codexDegraded);
  }

  /**
   * Tell the renderer the host settings it reads (DoD 4.0). Sent now, and
   * again on every reload; a change is a fresh send, unconditionally — this
   * is one boolean, and a no-nagging rule for it would cost more than it
   * saves.
   */
  setSettings(settings: Omit<SettingsMessage, 'type'>): void {
    if (this.#disposed) return;
    this.#settings = { type: 'settings', ...settings };
    this.#panel.postMessage(this.#settings);
  }

  /** Ask the renderer to show a view mode (DoD 4.6b: `agentDeck.openStats`). */
  showView(mode: ShowViewMessage['mode']): void {
    if (this.#disposed) return;
    this.#panel.postMessage({ type: 'showView', mode });
  }

  /**
   * Put the Layer 1 facts on the wire (DoD 4.1): the live records, and — when
   * the caller has re-read it — the stored history.
   *
   * THE VALIDATOR RUNS HERE, on the host, on every record, and a record that
   * fails is dropped and counted rather than sent (`statsWireRecords`). What
   * is returned is what was refused, so the host can name it on the
   * diagnostics channel; the counter on this controller is the running total
   * the counters line reports.
   */
  publishStats(
    live: readonly StatsRecord[],
    stored: { records: readonly unknown[]; enabled: boolean } | null,
  ): { dropped: number; reasons: string[] } {
    if (this.#disposed) return { dropped: 0, reasons: [] };
    const liveWire = statsWireRecords(live);
    const reasons = [...liveWire.reasons];
    this.#panel.postMessage({ type: 'statsSnapshot', records: liveWire.records });
    if (stored !== null) {
      const storedWire = statsWireRecords(stored.records);
      reasons.push(...storedWire.reasons);
      this.#panel.postMessage({
        type: 'statsStore',
        records: inSessionOrder(storedWire.records),
        enabled: stored.enabled,
      });
    }
    this.#counts.statsDropped += reasons.length;
    return { dropped: reasons.length, reasons };
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
    // DoD 5.5.2. The repair is the panel's own business, so it happens here
    // rather than in the host's `onMessage`: the bridge whose copy is wrong is
    // THIS panel's bridge, and resetting it is exactly what `onDidBecomeVisible`
    // already does for a reload. The message is still handed to `onMessage`
    // afterwards, so a host that wants to log it can.
    if (raw.type === 'resyncRequest') {
      this.#counts.resyncs += 1;
      this.bridge.reset();
      try {
        this.#onNeedsSnapshot();
      } catch {
        // Same rule as below: a handler that throws must not take the host
        // down, and the reset above has already happened, so the next
        // emission re-snapshots even if this call did not.
      }
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

// ---------------------------------------------------------------------------
// (d2) The stats pipeline — v0.7.0 Phase 3, DoD 3.2b and 3.7
// ---------------------------------------------------------------------------

/**
 * Derive on every patch; append on `ended` or after a long silence.
 *
 * ## The two triggers, and why there are two
 *
 * PLAN.md Phase 3's open questions are locked (user, 2026-09-05): a record is
 * appended when a session reaches `ended`, **or** when no patch has arrived for
 * `agentDeck.stats.idleFlushMs`. The second trigger exists because `ended` is
 * not guaranteed to arrive — a window closed mid-session, a machine suspended,
 * an engine whose liveness never resolves — and a history that silently omits
 * every session that was interrupted would be a history of the sessions that
 * finished tidily.
 *
 * The idle timer is a STATS-LAYER timer. It calls nothing on the liveness
 * engine and reads nothing from it beyond `state.liveness`, which G2 requires:
 * a deriver failure, a full disk, or a store that refuses must be invisible to
 * the deck.
 *
 * ## Supersede, and what counts as a patch
 *
 * "Reopen = supersede": a session that produces more work after a flush is
 * recomputed IN FULL and appended as a SECOND line with the same `sessionId`
 * and a later `derivedAt`. Nothing on disk is rewritten and
 * `StatsStore.readRecords` keeps the newest per session.
 *
 * Which means this class has to answer "did a patch arrive?", and the emission
 * cannot answer it directly. `SessionEmission.diffs` reports state changes,
 * but the host also pumps on a 5 s liveness tick with nothing changed, and a
 * timer rearmed on every tick would never fire. So the test is the DERIVED
 * RECORD: a session is treated as patched when its record differs from the last
 * one derived for it, ignoring the stamp. That is the honest question — the
 * store's subject is the record, so a change that does not reach the record is
 * not a change this layer has anything to say about — and it makes the append
 * idempotent for free: twenty pumps over a finished session produce one line.
 *
 * ## Failure is counted, never propagated
 *
 * `deriveStats` throwing, and the store refusing or failing to write, both land
 * on {@link StatsPipeline.errors} and are reported to `onError`. Neither
 * reaches the emission path: {@link AgentDeckHost} calls `observe` inside its
 * own guard as well, so a defect here cannot stop the panel being published.
 */
export interface StatsPipelineOptions {
  store: StatsStore;
  /** `agentDeck.pricing`, already parsed. */
  pricing: PricingTable;
  /** Model ids whose pricing entry was malformed. Reported once, never fixed. */
  pricingInvalid: readonly string[];
  /** `agentDeck.stats.idleFlushMs`. */
  idleFlushMs: number;
  /**
   * This process's activation instant — the PROVENANCE GATE (v0.7.0 DoD 4.11,
   * user ruling 2026-09-09). Taken ONCE at activation.
   *
   * A session whose last activity (`endedAt ?? startedAt`) is before this
   * instant is HISTORY: this process read it off disk and observed no work in
   * it, so it never flushes, on idle or on ended. A historical session that
   * produces a patch after the stamp becomes OBSERVED and flushes normally,
   * through the supersede path.
   *
   * REQUIRED, not optional-with-a-default. A default of "no gate" is the
   * silent-default shape this repository has already shipped twice (the
   * `enabledEngines` prop, `DegradedMessage.engine`): a later construction site
   * that forgets it would re-open the store flood with nothing going red.
   * Passing `0` opts out, and the one caller that does says why.
   */
  processStart: number;
  /** Injected clock. `derivedAt` comes from here and from nowhere else. */
  now: () => number;
  /** Injected timers, so a test can fire the idle flush without waiting. */
  scheduler: Scheduler;
  /** Receives a deriver throw, a refused record, and any fs failure. */
  onError?: (error: unknown) => void;
  /**
   * The extension API's feed (v0.7.0 DoD 5.2): `'flush'` for every record the
   * store accepted — on `ended` and on the idle flush — and `'live'` when an
   * OBSERVED session's record changes. `src/api.ts` throttles the live half; the
   * pipeline reports every change and decides only WHICH sessions have any.
   *
   * Only observed sessions, and that is the store's own provenance rule (DoD
   * 4.11b) applied to the event: a window reload re-derives a whole history, and
   * every one of those records changes while its transcript is being read. An
   * event per such change would be the store flood re-created on the API.
   *
   * Called inside the pipeline's own guard; a throw here is counted like a
   * deriver throw and never reaches the deck (G2).
   */
  onUpdate?: (record: StatsRecord, cause: 'live' | 'flush') => void;
}

/** What the pipeline remembers about one session, between emissions. */
interface TrackedSession {
  /** The most recent record, without its stamp. The flush's payload. */
  record: StatsRecordForStore | null;
  /**
   * {@link TrackedSession.record} with every clock-derived field flattened —
   * the CHANGE test, i.e. "does this pump re-arm the idle countdown?". Never
   * written, and since DoD 4.11b never a promoter either; see `withoutClock`.
   */
  patchBody: string | null;
  /** `JSON.stringify` of {@link TrackedSession.record}. The FLUSH comparison. */
  body: string | null;
  /** The body of the last record actually written. */
  appendedBody: string | null;
  /**
   * {@link TrackedSession.patchBody} as of the last API event for this session
   * (DoD 5.2). A live event goes out when the two differ — the same
   * clock-flattened comparison the countdown uses, so a stalled call's ticking
   * `stalledMs` is not a stream of events either.
   */
  liveBody: string | null;
  /** The pending idle flush, or null. */
  timer: TimerHandle | null;
  /**
   * Has this process observed WORK in this session? (DoD 4.11 / 4.11b.)
   *
   * True once LIVENESS reports activity at or after `processStart` — and by
   * nothing else. A resumed historical session promotes correctly because
   * resuming moves its liveness instant, which is what the withdrawn
   * record-changed clause was reaching for and could never measure. False means
   * history, and history never flushes.
   */
  observed: boolean;
}

/** A derived record before the store's stamp is put on it. */
type StatsRecordForStore = Omit<StoredStatsRecord, 'derivedAt'>;

/**
 * The record with every clock-derived field flattened, for the CHANGE test.
 *
 * One field qualifies today — `StallRecord.stalledMs`, which `stalls.ts` derives
 * as `now - stalledSinceMs`. It is zeroed rather than dropped so the SHAPE of
 * the comparison is unchanged: a stall appearing, disappearing, or moving to a
 * different tool is still a patch, and only its elapsed time is not. Anything
 * added later that reads the clock belongs here too.
 *
 * ## Why this survived DoD 4.11b, which said to retire it — MEASURED, twice
 *
 * The 4.11b ruling (user, 2026-09-10) retires it along with the body-change
 * PROMOTER, and the promoter is indeed gone: nothing in this file lets any field
 * of the record decide whether a session is `observed`. What this function still
 * decides is narrower and is not about provenance at all — whether a pump
 * RE-ARMS the idle countdown — and both ways of retiring it were driven and both
 * turned a test red:
 *
 *   - **Delete it outright.** `stalledMs` grows on every 5 s pump, `#arm`
 *     restarts the countdown on every patch, so a session holding a stalled tool
 *     call never flushes: `a stalled session never flushed: expected +0 to be 1`.
 *     That is verifier defect 2's starvation half, reopened.
 *   - **Re-arm on new ACTIVITY instead of on a record change**, which would put
 *     the whole silence question on liveness and need no flattening. It
 *     contradicts a LOCKED Phase 3 contract: DoD 3.2b's control asserts that a
 *     session changing on every pump is pushed forward forever
 *     (`idleFlushes === 0`), and under that design it flushes.
 *
 * So the flattening stays exactly where the verifier put it and nowhere else.
 * **This is a recorded deviation from the 4.11b ruling's third clause** — the
 * substance of the ruling (liveness is the sole promoter) is unaffected, and the
 * gate record says so with these two measurements beside it.
 */
function withoutClock(record: StatsRecordForStore): StatsRecordForStore {
  if (record.stalls.length === 0) return record;
  return { ...record, stalls: record.stalls.map((stall) => ({ ...stall, stalledMs: 0 })) };
}

export class StatsPipeline {
  readonly store: StatsStore;

  readonly #pricing: PricingTable;
  readonly #pricingInvalid: readonly string[];
  readonly #idleFlushMs: number;
  readonly #processStart: number;
  readonly #now: () => number;
  readonly #scheduler: Scheduler;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onUpdate: ((record: StatsRecord, cause: 'live' | 'flush') => void) | undefined;
  readonly #tracked = new Map<string, TrackedSession>();
  #errors = 0;
  #flushes = 0;
  #disposed = false;

  constructor(options: StatsPipelineOptions) {
    this.store = options.store;
    this.#pricing = options.pricing;
    this.#pricingInvalid = options.pricingInvalid;
    this.#idleFlushMs = options.idleFlushMs;
    this.#processStart = options.processStart;
    this.#now = options.now;
    this.#scheduler = options.scheduler;
    this.#onError = options.onError;
    this.#onUpdate = options.onUpdate;
  }

  /** Deriver throws plus store refusals. Surfaced as `statsErrors`. */
  get errors(): number {
    return this.#errors;
  }

  /** Records appended by the IDLE trigger. Read by tests. */
  get idleFlushes(): number {
    return this.#flushes;
  }

  /**
   * The newest derived record per tracked session, in first-seen order —
   * the `statsSnapshot` message's payload (v0.7.0 DoD 4.1).
   *
   * What the pipeline last derived, not what it last WROTE: the Stats view is
   * live and updates on every patch, while the store hears only from the two
   * flush triggers. A session with no record yet (its first derivation threw)
   * is simply absent, which is the same absence G2 gives the deck.
   */
  liveRecords(): StatsRecord[] {
    const out: StatsRecord[] = [];
    for (const entry of this.#tracked.values()) {
      if (entry.record !== null) out.push(entry.record);
    }
    return out;
  }

  /** Sessions with a pending idle flush. Must be 0 after `dispose()`. */
  get armedTimers(): number {
    let armed = 0;
    for (const entry of this.#tracked.values()) if (entry.timer !== null) armed += 1;
    return armed;
  }

  /**
   * One emission: derive every session, append the ones that ended, arm the
   * rest.
   *
   * A session that LEFT the emission keeps whatever timer it had. That is
   * deliberate: a session disappears from the deck when its transcript stops
   * matching the workspace, which is not the same as it having ended, and
   * cancelling the flush there would lose the record the flush exists to
   * guarantee. The timer fires on the record already held.
   */
  observe(emission: SessionEmission): void {
    if (this.#disposed) return;
    for (const state of emission.sessions) {
      let record: StatsRecordForStore;
      try {
        record = deriveStats(state, {
          pricing: this.#pricing,
          pricingInvalid: this.#pricingInvalid,
          now: this.#now(),
        });
      } catch (error) {
        // G2: the deriver is a third consumer and its failure is skipped.
        this.#errors += 1;
        this.#report(error);
        continue;
      }
      const entry = this.#entryFor(state.sessionId);
      const body = JSON.stringify(record);
      // A CLOCK TICK IS NOT A PATCH (verifier defect 6, 2026-09-09).
      //
      // `StallRecord.stalledMs` is `now - stalledSinceMs`, the one field in the
      // record derived from the clock rather than from the session, so a session
      // holding a stalled tool call produces a DIFFERENT record on every 5 s
      // pump while nothing about it has changed — and `#arm` restarts the
      // countdown on every patch, so the flush would be pushed forward forever.
      //
      // The question this layer asks is "did a patch arrive?", and the honest
      // answer cannot depend on when it was asked. `body` above stays the FULL
      // record, because that is what is written and what `appendedBody` compares.
      const patchBody = JSON.stringify(withoutClock(record));

      // ---- The provenance gate (DoD 4.11 / 4.11b) -------------------------
      //
      // THE LAW, and it was bought with the same defect twice: **a derived
      // record is evidence of CONTENT, never of ACTIVITY; activity comes from
      // liveness only.**
      //
      // 4.11 read the record's own `endedAt ?? startedAt` and promoted a
      // session whose record CHANGED during this lifetime, on the reasoning
      // that a change is work. It is not. A historical session's record changes
      // while the tailer is still READING it, so the 4.9 re-run found 21
      // sessions that did nothing written in a 1.4 s burst the moment their
      // initial read completed — every one with a `startedAt` days old and no
      // `endedAt` at all. Reproduced at 19 of 21: pump one sees a partial tree,
      // pump two sees the whole one.
      //
      // So the only promoter is the instant each engine's LIVENESS reports:
      // the last hook event or transcript write for Claude Code, OpenCode's
      // `max(timeUpdated, seqAdvancedAt)`, the transcript mtime for Codex.
      // Nothing about the record can promote anything.
      //
      // `withoutClock` SURVIVES, and only below this gate. An earlier draft of
      // this comment said it was "retired rather than extended" while the call
      // 20 lines down was still there — a reader of the gate was told the
      // opposite of the code, which is the disagreeing-comment defect this
      // repository already records in `graft.ts`. What it decides now is whether
      // a pump RE-ARMS the countdown, which is not provenance; the ruling that
      // asked for its retirement, both measurements against retiring it, and the
      // recorded deviation are on its own header.
      //
      // A session liveness says nothing about is NOT promoted (G3: refuse,
      // don't guess). It keeps deriving and rendering; it is only the STORE
      // that declines to claim work nobody witnessed.
      const activityAt = emission.lastActivityAt.get(state.sessionId);
      const wasObserved = entry.observed;
      if (activityAt !== undefined && activityAt >= this.#processStart) entry.observed = true;
      const promotedThisPump = !wasObserved && entry.observed;

      if (state.liveness === 'ended') {
        entry.record = record;
        entry.body = body;
        entry.patchBody = patchBody;
        this.#clearTimer(entry);
        // History never flushes on ended either. That half matters: a history is
        // usually discovered ALREADY ended, and this path appends with no timer,
        // so gating only the idle path would leave the flood intact for exactly
        // the sessions that caused it (measured: 28 appends, 0 idle flushes).
        if (entry.observed && body !== entry.appendedBody) this.#append(entry);
        this.#announceLive(entry);
        continue;
      }
      // The change test is over `patchBody`: a tick that only moved
      // `stalledMs` leaves the countdown alone, so the flush arrives.
      if (patchBody === entry.patchBody) {
        /*
         * ...EXCEPT FOR THE PUMP THAT PROMOTES A SESSION, which owes a record
         * nothing else will arm (v0.7.0 DoD 4.11c).
         *
         * Promotion and the record's last change need not land on the same
         * pump, and under 4.11c they usually do not: an mtime counts only once
         * the transcript has GROWN, and the bytes that make it grow need not
         * move any number the record carries. Without this the session waits for
         * its NEXT change — which for a session that appends once and goes quiet
         * never comes, so the idle flush that exists precisely for a session
         * that never reaches `ended` would never fire for it.
         *
         * It cannot re-open the flood: history is never observed, so it never
         * reaches here, and a session already written is held by
         * `appendedBody`. Once per promotion, by construction —
         * `promotedThisPump` is a false-to-true transition and `observed` never
         * goes back.
         */
        if (promotedThisPump && body !== entry.appendedBody) {
          this.#arm(state.sessionId, entry);
        }
        // A promotion with an unchanged record still owes the API one event:
        // `liveBody` is null until the first, so this is where a resumed
        // historical session is first announced.
        this.#announceLive(entry);
        continue;
      }
      entry.record = record;
      entry.body = body;
      entry.patchBody = patchBody;
      // History arms nothing, so it cannot flush when the silence elapses.
      if (!entry.observed) continue;
      this.#arm(state.sessionId, entry);
      this.#announceLive(entry);
    }
  }

  /**
   * Tell the API an observed session's record changed (DoD 5.2).
   *
   * The comparison is `patchBody` against what was last announced, so a clock
   * tick inside a stalled call is not an event, and a record the store has just
   * written is not announced twice — `#append` marks it announced as it fires
   * the flush event. History is never announced: `observed` is the gate, as it
   * is for the store.
   */
  #announceLive(entry: TrackedSession): void {
    if (this.#onUpdate === undefined) return;
    if (!entry.observed || entry.record === null) return;
    if (entry.patchBody === entry.liveBody) return;
    entry.liveBody = entry.patchBody;
    this.#fireUpdate(entry.record, 'live');
  }

  /** One API event, behind the pipeline's guard. A consumer never reaches the deck. */
  #fireUpdate(record: StatsRecord, cause: 'live' | 'flush'): void {
    try {
      this.#onUpdate?.(record, cause);
    } catch (error) {
      this.#errors += 1;
      this.#report(error);
    }
  }

  /**
   * Drop every timer. Called from `AgentDeckHost.dispose`, i.e. on panel close
   * and on `deactivate()`.
   *
   * Nothing is flushed here. A window closing is not evidence that a session
   * ended, and writing a record on teardown would append a line every time a
   * user closed a window mid-session — the reopened window would then derive
   * the same session again and supersede it. The idle rule already covers the
   * case this would be reaching for, and it covers it without guessing.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const entry of this.#tracked.values()) this.#clearTimer(entry);
    this.#tracked.clear();
  }

  #entryFor(sessionId: string): TrackedSession {
    const held = this.#tracked.get(sessionId);
    if (held !== undefined) return held;
    const fresh: TrackedSession = {
      record: null,
      body: null,
      patchBody: null,
      appendedBody: null,
      liveBody: null,
      timer: null,
      observed: false,
    };
    this.#tracked.set(sessionId, fresh);
    return fresh;
  }

  /** (Re)start the idle countdown. Every patch restarts it; that is the rule. */
  #arm(sessionId: string, entry: TrackedSession): void {
    this.#clearTimer(entry);
    entry.timer = this.#scheduler.setTimer(() => {
      entry.timer = null;
      if (this.#disposed) return;
      if (entry.body === entry.appendedBody) return;
      this.#flushes += 1;
      this.#append(entry);
    }, this.#idleFlushMs);
  }

  #clearTimer(entry: TrackedSession): void {
    if (entry.timer === null) return;
    this.#scheduler.clearTimer(entry.timer);
    entry.timer = null;
  }

  /**
   * Stamp and write.
   *
   * The stamp is applied HERE and the store applies none — see
   * `src/stats/store.ts`'s header on why the store adds no field. The spread
   * builds a new object rather than mutating the held record, so the body this
   * class compares against stays the body it derived.
   */
  #append(entry: TrackedSession): void {
    const record = entry.record;
    if (record === null) return;
    const before = this.store.appended;
    const stamped = { ...record, derivedAt: this.#now() } as StoredStatsRecord;
    this.store.appendRecord(stamped);
    if (this.store.appended === before) {
      // The store refused or the write failed; it has already reported why.
      // Counted here so `statsErrors` covers both halves of this layer.
      this.#errors += 1;
      return;
    }
    entry.appendedBody = entry.body;
    // DoD 5.2 — every flush is an API event, and it is the record AS WRITTEN,
    // `derivedAt` included, so a consumer holds the same line `getStoredStats`
    // would return. Only a write that happened is announced: a refused record
    // or a failed disk is not a flush. Marked announced, so the live check that
    // follows on the same pump does not repeat it.
    entry.liveBody = entry.patchBody;
    this.#fireUpdate(stamped, 'flush');
  }

  #report(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // A reporting sink that throws must not break the pipeline reporting on.
    }
  }
}

export interface AgentDeckHostOptions extends DataPathOptions {
  /**
   * Constructs the panel. Called at most once per open panel; a second `open()`
   * reveals the existing one instead.
   */
  createPanel: () => PanelSurface;
  /** Injected so a test can assert the emitted document byte for byte. */
  nonce?: string;
  /**
   * Overrides the stats provenance stamp (DoD 4.11). Defaults to `now()`.
   *
   * EXISTS FOR ONE REASON, and it is a property of the fixtures rather than a
   * convenience: **a replayed corpus is history, and correctly so.** The gate
   * compares the instant the engine's LIVENESS reports against this stamp, and a
   * committed corpus produces none that can pass it — nobody appends to it, so
   * under DoD 4.11c its mtimes buy nothing, and it fires no hooks. A host test
   * that is about the settings or the seam would therefore assert against a gate
   * doing its job.
   *
   * **THIS COMMENT USED TO SAY THE GATE COMPARED A RECORD'S `endedAt ?? startedAt`
   * — transcript CONTENT — against activation, while liveness compared file
   * mtime.** That was 4.11's design; 4.11b removed the content read and 4.11c
   * narrowed the mtime, and the sentence stood here through both. It is kept as a
   * correction rather than deleted because the option it describes is the one the
   * 4.11c tests drive.
   *
   * So a test that is about something else passes `0` and says so. The
   * production default is untouched, and `extension.test.ts` carries a test
   * that drives the REAL stamp in both directions — without it this option
   * would be the untested single assignment site this repository keeps
   * shipping.
   */
  statsProcessStart?: number;
  /**
   * Creates the diagnostics output channel (DoD 5.5.3). Omitted by every test
   * that does not assert on diagnostics, and by anything running outside a
   * real editor — `test/vscode-mock.ts` has no `createOutputChannel`, which is
   * the same reason `HostLogger` is injected rather than imported.
   */
  createDiagnosticsSink?: DiagnosticsSinkFactory;
  /** Injected clock for the diagnostics timestamps. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * `<globalStorageUri>/stats/` — the local store's directory (DoD 3.7).
   *
   * OPTIONAL, and a host given none builds no {@link StatsPipeline} at all: it
   * derives nothing, writes nothing, and creates no directory. Every host test
   * that predates Phase 3 therefore keeps behaving exactly as it did, which is
   * the property that makes "the deck renders identically with the deriver
   * present, absent, or throwing" (G2) something a test can drive rather than
   * a sentence.
   *
   * Only `activate()` supplies it, from `context.globalStorageUri`. The
   * resolution itself is `resolveStoreDir`'s and is asserted by the path law
   * (DoD 3.1) rather than restated here.
   */
  statsDir?: string;
  /**
   * The extension API's feed — see {@link StatsPipelineOptions.onUpdate}.
   * Only `activate()` supplies it, from the API it returns (DoD 5.1/5.2); a
   * host with no pipeline never calls it.
   */
  onStatsUpdate?: (record: StatsRecord, cause: 'live' | 'flush') => void;
}

/**
 * The data path plus at most one panel.
 *
 * The data path runs whether or not a panel is open: liveness is a
 * wall-clock-sensitive fact, and a panel opened after five minutes of watching
 * should show the truth immediately rather than start warming up.
 */
/**
 * The key `AgentDeckHost` announces a session under: `(engine, id)`.
 *
 * A single string rather than a nested map because a `Map` keyed on it is
 * the whole point of DoD 5.0a: the engine has to still be there when the
 * session is NOT, which is the moment a removal is detected.
 *
 * `JSON.stringify` of the pair rather than a separator character, and the
 * reason is worth the line. A session id is engine-chosen and this code does
 * not get to assume its alphabet, so the separator has to be one no id can
 * contain - which points at a control character, and this repository has a
 * standing rule against writing one into source (a real NUL in a test file
 * once made it BINARY TO GIT, with no reviewable diff ever again). Writing
 * it as the escape `\u0000` is safe in the file and was NOT safe to author:
 * the first attempt at this function reached disk with four real NUL bytes,
 * because a quoted heredoc delivered one backslash where the script said
 * two. That is the third recorded instance of that trap here.
 *
 * A JSON array is injective over the pair, needs no escape to author, and
 * every byte of it is printable. `["cc","a"]` cannot collide with
 * `["cc","a"]` built from different halves, which a `+` join on a colon or a
 * dash could.
 */
function announceKey(engine: DiagnosticsEngine, sessionId: string): string {
  return JSON.stringify([engine, sessionId]);
}

export class AgentDeckHost {
  readonly dataPath: AgentDeckDataPath;

  /**
   * The diagnostics surface (DoD 5.5.3), or `undefined` when the caller
   * supplied no sink factory.
   *
   * Optional rather than required because `AgentDeckHost` is constructed by
   * every host test and by `activate()`, and only `activate()` has a `vscode`
   * to make a channel from. A host with no channel records nothing and behaves
   * identically otherwise — which is also what makes "every listed event
   * emits exactly one line" assertable with a spy sink.
   */
  readonly diagnostics: DiagnosticsChannel | undefined;

  /**
   * The local store's pipeline (DoD 3.7), or `undefined` when the caller
   * supplied no `statsDir`.
   *
   * Optional for the reason {@link AgentDeckHost.diagnostics} is: only
   * `activate()` has a `globalStorageUri`, and a host without one must behave
   * identically in every other respect.
   */
  readonly stats: StatsPipeline | undefined;

  readonly #createPanel: () => PanelSurface;
  readonly #nonce?: string;
  readonly #scheduler: Scheduler;
  #countersTimer: TimerHandle | null = null;
  /**
   * Sessions the diagnostics channel has already announced, keyed by
   * `(engine, id)` — NOT by id alone (DoD 5.0a).
   *
   * It was a `Set<string>` of ids, and the engine was therefore GONE by the
   * time a removal was detected, so `sessionRemoved` was emitted with a
   * hard-coded `engine: 'cc'` for all three engines. A user watching the
   * Agent Deck output channel read `session removed cc <id>` when a Codex or
   * OpenCode session went away. `DiagnosticsEvent` types that field as all
   * three engines and the diagnostics tests even sample it as `opencode`, so
   * this was a defect and never a design.
   *
   * SAME FAMILY AS THE D2 MISLABELLING, moved into the diagnostics log: a
   * value that describes one engine, printed against another. The fix is the
   * data structure rather than the literal, which is why it was a DoD line.
   *
   * The key is COMPOSITE rather than a `Map<id, engine>` because the three
   * engines mint ids in unrelated id spaces and nothing guarantees they never
   * collide. Keying on the id alone would let one engine's session suppress
   * the other's discovery line and then emit its removal under the wrong
   * name — the same class of bug one layer down.
   */
  readonly #announced = new Map<string, { id: string; engine: DiagnosticsEngine }>();
  /**
   * Model ids whose `agentDeck.pricing` entry was malformed (DoD 3.3b).
   *
   * Held rather than logged at construction because the diagnostics channel is
   * created lazily on its first line, and a line written from inside the
   * constructor would open the channel — putting an "Agent Deck" entry in every
   * user's Output dropdown for a setting most of them never touch. It is
   * written on the first emission instead, once, and then cleared.
   */
  #pricingInvalid: string[] | null = null;
  /** Stats derivations skipped for a reason outside the pipeline's own count. */
  #statsErrors = 0;
  /**
   * Sessions per engine, as of the last emission.
   *
   * Taken from the emission rather than from the data path's internals for the
   * same reason `#recordEmission` is: the emission is what the renderer was
   * given, so a counters line and the deck describe the same moment.
   */
  #engineCounts: { cc: number; opencode: number; codex: number } = {
    cc: 0,
    opencode: 0,
    codex: 0,
  };
  #panel: PanelController | null = null;
  #panelsCreated = 0;
  #disposed = false;
  /** `agentDeck.canvas.autoFit`, as last read. Sent to every panel (DoD 4.0). */
  #canvasAutoFit: boolean;
  /**
   * How many flushes the pipeline had performed when the store was last read
   * for the wire, or -1 when it has never been read (or a reload made the
   * last read moot). The store is re-read only when this lags the pipeline:
   * a read costs a directory walk and the host pumps every 5 s, so reading on
   * every pump would spend the `stats.store.read.dod` budget on nothing.
   */
  #storeReadAtFlush = -1;
  /** Stats records refused at the wire by panels since activation. */
  #statsDropped = 0;

  constructor(options: AgentDeckHostOptions) {
    const {
      createPanel,
      nonce,
      onEmission,
      createDiagnosticsSink,
      statsDir,
      onStatsUpdate,
      ...rest
    } = options;
    this.#createPanel = createPanel;
    this.#canvasAutoFit = options.settings['canvas.autoFit'];
    if (nonce !== undefined) this.#nonce = nonce;
    this.#scheduler = options.scheduler ?? systemScheduler;
    const clock = options.now ?? ((): number => Date.now());
    if (createDiagnosticsSink !== undefined) {
      this.diagnostics = new DiagnosticsChannel({
        createSink: createDiagnosticsSink,
        now: clock,
      });
    }
    if (statsDir !== undefined) {
      const parsed = parsePricing(options.settings.pricing);
      /*
       * STORE AND PIPELINE FAILURES GO TO THE DIAGNOSTICS CHANNEL, NEVER TO
       * `onError`, AND THAT IS THE G2 SHAPE RATHER THAN A PREFERENCE.
       *
       * `onError` is the USER-VISIBLE path: `activate()` turns it into
       * `showErrorMessage`, a modal-adjacent notification, and it is reserved
       * for the two things a user must act on — a port held by another program
       * and an unexpected throw out of the data path. A history that could not
       * be written is neither. The deck is unaffected by definition (G2), the
       * counter says how often it happened, and a line on the channel says
       * why. Popping a notification for it would train users to dismiss the
       * notifications that matter.
       */
      const toChannel = (error: unknown): void => {
        this.diagnostics?.record({
          kind: 'engineDegraded',
          engine: 'cc',
          reason: `stats store: ${error instanceof Error ? error.message : String(error)}`,
        });
      };
      this.stats = new StatsPipeline({
        store: new StatsStore({
          dir: statsDir,
          enabled: options.settings['stats.enabled'],
          retentionDays: options.settings['stats.retentionDays'],
          onError: toChannel,
        }),
        pricing: parsed.table,
        pricingInvalid: parsed.invalid,
        idleFlushMs: options.settings['stats.idleFlushMs'],
        // The provenance stamp, taken ONCE here (DoD 4.11). Everything already
        // on disk when this window activated is history and is never written
        // again; see `StatsPipelineOptions.processStart`.
        processStart: options.statsProcessStart ?? clock(),
        now: clock,
        scheduler: this.#scheduler,
        onError: toChannel,
        ...(onStatsUpdate === undefined ? {} : { onUpdate: onStatsUpdate }),
      });
      // DoD 3.3b — reported ONCE, at construction, and never per emission. A
      // malformed price entry is a fact about the settings file, so repeating
      // it on every patch would be a nag rather than a diagnostic. `pricing`
      // does not change without a reload for the same reason `port` does not.
      if (parsed.invalid.length > 0) {
        this.#pricingInvalid = [...parsed.invalid];
      }
    }
    this.dataPath = new AgentDeckDataPath({
      ...rest,
      onEmission: (payload: DataPathEmission) => {
        this.#recordEmission(payload);
        // BEFORE the panel and before the consumer, and inside its own guard:
        // G2 says the deck renders identically with the deriver present,
        // absent, or throwing, and the only arrangement that proves it is one
        // where the stats layer runs first and cannot reach what follows.
        this.#observeStats(payload.emission);
        this.#panel?.publish(payload);
        // AFTER the session publish and inside its own guard too: the Stats
        // view is downstream of the deck, and a stats wire failure must not
        // reach the consumer any more than a deriver throw may (G2).
        this.#publishStats();
        onEmission(payload);
      },
      // F2. Read through `this.diagnostics` at CALL time rather than captured,
      // so the arrow is valid whether or not a sink factory was supplied — a
      // host with no channel records nothing and behaves identically, which is
      // the property every host test relies on.
      onDiagnostic: (event: DiagnosticsEvent) => this.diagnostics?.record(event),
    });
  }

  /**
   * One line per session that appeared or left, and one per refusal.
   *
   * Driven off the emission rather than off the data path's internals because
   * the emission IS what the user is looking at: a session the deck shows and
   * a line the channel wrote then describe the same moment. Reading the
   * watcher's discovery instead would log sessions the renderer never saw.
   */
  #recordEmission(payload: DataPathEmission): void {
    let cc = 0;
    let opencode = 0;
    let codex = 0;
    for (const session of payload.emission.sessions) {
      const engine = session.engine ?? 'cc';
      if (engine === 'opencode') opencode += 1;
      else if (engine === 'codex') codex += 1;
      else cc += 1;
    }
    // Updated even with no channel: `counters()` is public and a test may read
    // it without ever asking for diagnostics.
    this.#engineCounts = { cc, opencode, codex };

    const channel = this.diagnostics;
    if (channel === undefined) return;
    const present = new Set<string>();
    for (const session of payload.emission.sessions) {
      const engine = session.engine ?? 'cc';
      const key = announceKey(engine, session.sessionId);
      present.add(key);
      if (!this.#announced.has(key)) {
        this.#announced.set(key, { id: session.sessionId, engine });
        channel.record({ kind: 'sessionDiscovered', sessionId: session.sessionId, engine });
        // A session that arrives already refused is announced AND explained,
        // in that order, because "it appeared" and "it is unusable" are two
        // facts and collapsing them loses the first one.
        if (!session.schemaOk) {
          channel.record({
            kind: 'sessionRefused',
            sessionId: session.sessionId,
            engine,
            code: 'schemaMismatch',
          });
        }
      }
    }
    for (const [key, announced] of [...this.#announced]) {
      if (present.has(key)) continue;
      this.#announced.delete(key);
      // The engine comes from what was ANNOUNCED, which is the only place it
      // still exists: the session is gone from the emission by definition.
      channel.record({
        kind: 'sessionRemoved',
        sessionId: announced.id,
        engine: announced.engine,
      });
    }
  }

  /**
   * Feed one emission to the stats pipeline, behind a guard (G2).
   *
   * The pipeline already catches a deriver throw per session. This second
   * guard covers everything else it might do — a store whose directory has
   * become unwritable, a `JSON.stringify` on a state carrying a cycle — for the
   * property the Grounding Contract states in the strongest form available:
   * *"the deck renders identically with the deriver present, absent, or
   * throwing"*. A throw here would take out `#panel.publish`, which is the
   * whole product.
   */
  #observeStats(emission: SessionEmission): void {
    const pipeline = this.stats;
    if (pipeline === undefined) return;
    const invalid = this.#pricingInvalid;
    if (invalid !== null) {
      this.#pricingInvalid = null;
      this.diagnostics?.record({
        kind: 'engineDegraded',
        engine: 'cc',
        reason: `agentDeck.pricing: ${String(invalid.length)} malformed entries ignored: ${invalid.join(', ')}`,
      });
    }
    try {
      pipeline.observe(emission);
    } catch (error) {
      this.#statsErrors += 1;
      this.diagnostics?.record({
        kind: 'engineDegraded',
        engine: 'cc',
        reason: `stats pipeline: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Clear Stats History ran — v0.7.0 DoD 4.14. The panel forgets the history in
   * the SAME action.
   *
   * Found by the 4.9 smoke: the command deleted the directory and the Stats view
   * went on showing every record, so the user cleared twice. The cause is the
   * re-read cursor, not the webview: `#publishStats` re-reads the store only
   * when `store.appended` has moved since the last read, and a clear APPENDS
   * nothing — so the host had no reason to look again until the next flush
   * happened to arrive. The webview replaces its stored records on every
   * `statsStore` message, so one message is the whole fix.
   *
   * RE-READ, not an empty array written by hand: after a successful clear the
   * store is empty and the read says so, and after a FAILED one the read sends
   * what is actually still on disk rather than a view claiming a deletion that
   * did not happen.
   *
   * Only this window is told. Another window's panel over the same per-machine
   * store learns on its own next flush, which is the cost of there being no
   * channel between windows (G7: in-memory only).
   */
  statsHistoryCleared(): void {
    this.#storeReadAtFlush = -1;
    this.#publishStats();
  }

  /**
   * Put the Layer 1 facts on the panel's wire (DoD 4.1), behind a guard.
   *
   * The live records go on every publish — they are already derived, so the
   * only cost is the validator walk. The STORED records are re-read only when
   * the pipeline has flushed since the last read, or when a reload made the
   * webview forget them; see `#storeReadAtFlush`.
   */
  #publishStats(): void {
    const panel = this.#panel;
    if (panel === null) return;
    const pipeline = this.stats;
    // NO PIPELINE MEANS NO HISTORY, AND THE VIEW HAS TO BE TOLD (verifier
    // defect 15). `statsDirFor` returns undefined for a window with no
    // `globalStorageUri`, so `this.stats` is undefined and nothing here used to
    // send anything at all — leaving the Stats view on "Reading the stored
    // history…" forever, which is the very state DoD 4.12 added it to avoid.
    // An empty, disabled store is the true answer for that window.
    if (pipeline === undefined) {
      panel.publishStats([], { records: [], enabled: false });
      return;
    }
    try {
      let stored: { records: readonly unknown[]; enabled: boolean } | null = null;
      const appendedAtRead = pipeline.store.appended;
      if (this.#storeReadAtFlush !== appendedAtRead) {
        stored = { records: pipeline.store.readRecords({}), enabled: pipeline.store.enabled };
      }
      const { dropped, reasons } = panel.publishStats(pipeline.liveRecords(), stored);
      // The cursor advances only once the message is AWAY. It used to be
      // assigned beside the read, so a single throw out of the send advanced it
      // and the stored records were never sent again for that panel — a
      // permanent loading state from one transient failure (verifier defect 15).
      if (stored !== null) this.#storeReadAtFlush = appendedAtRead;
      if (dropped > 0) {
        this.#statsDropped += dropped;
        this.diagnostics?.record({
          kind: 'engineDegraded',
          engine: 'cc',
          reason: `stats wire: ${String(dropped)} record(s) refused by the validator: ${reasons.join('; ')}`,
        });
      }
    } catch (error) {
      this.#statsErrors += 1;
      this.diagnostics?.record({
        kind: 'engineDegraded',
        engine: 'cc',
        reason: `stats wire: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * `agentDeck.canvas.autoFit` changed (DoD 4.0). Live, no reload: the value
   * is one boolean the renderer reads on its next fit decision.
   */
  setCanvasAutoFit(value: boolean): void {
    this.#canvasAutoFit = value;
    this.#panel?.setSettings({ canvasAutoFit: value });
  }

  /** `agentDeck.openStats`: the panel, showing the Stats view mode (DoD 4.6b). */
  openStats(): PanelController | null {
    const controller = this.open();
    controller?.showView('stats');
    return controller;
  }

  /**
   * Assemble the counters line from whatever is authoritative right now.
   *
   * Nothing is accumulated in the channel: `DiagnosticsCounters` documents why
   * — the host already owns every one of these numbers, and a second copy
   * updated incrementally is how two counters describing one fact begin to
   * disagree.
   */
  counters(): DiagnosticsCounters {
    const d = this.dataPath.diagnostics;
    const bridge = this.#panel?.bridge.counters;
    const panel = this.#panel?.counters;
    return {
      grafts: d.grafts,
      graftRefusals: d.graftRefusals,
      graftErrors: d.graftErrors,
      malformedLines: d.malformedLines,
      // See `DataPathDiagnostics.ignoredLines`: the DoD names this
      // `unknownFields` and no field-level counter exists in this repository.
      // What is counted is unmodelled entry TYPES, and the field's own doc
      // comment says so rather than letting the label imply otherwise.
      unknownFields: d.ignoredLines,
      patchesSent: bridge?.diffsSent ?? 0,
      patchesApplied: bridge?.diffsSent ?? 0,
      patchesFailed: bridge?.patchFailures ?? 0,
      resyncs: panel?.resyncs ?? 0,
      ccSessions: this.#engineCounts.cc,
      opencodeSessions: this.#engineCounts.opencode,
      codexSessions: this.#engineCounts.codex,
      // Read off the shared listener at write time, for the reason this
      // method's own doc comment gives: the listener owns these numbers, and a
      // second copy kept in step by hand is how two accounts of one fact begin
      // to disagree.
      relayRole: this.dataPath.relayRole,
      relayFollowers: this.dataPath.relayCounters.followers,
      relayed: this.dataPath.relayCounters.relayed,
      relayReceived: this.dataPath.relayCounters.received,
      // DoD 3.8. Read off the pipeline and the store at WRITE time, the same
      // rule as the relay figures above and for the same reason: they own the
      // numbers, and a second copy kept in step by hand is how two accounts of
      // one fact begin to disagree. A host with no store reports two zeroes,
      // which is the truth about a window that is not keeping a history.
      statsErrors: this.#statsErrors + (this.stats?.errors ?? 0),
      storeMalformed: this.stats?.store.malformed ?? 0,
      // Accumulated on the HOST rather than read off the panel: a panel that
      // was closed and reopened would otherwise reset the count to zero, and
      // the counters line is a running total for the window.
      statsDropped: this.#statsDropped,
    };
  }

  /** Arm the 60 s counters line. Idempotent; a no-op with no channel. */
  #armCounters(): void {
    if (this.#disposed || this.diagnostics === undefined) return;
    if (this.#countersTimer !== null) return;
    this.#countersTimer = this.#scheduler.setTimer(() => {
      this.#countersTimer = null;
      if (this.#disposed) return;
      this.diagnostics?.recordCounters(this.counters());
      this.#armCounters();
    }, COUNTERS_INTERVAL_MS);
  }

  get panelsCreated(): number {
    return this.#panelsCreated;
  }

  get panel(): PanelController | null {
    return this.#panel;
  }

  async start(): Promise<void> {
    await this.dataPath.start();
    this.#armCounters();
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
        // The new document holds no history either: force the next publish
        // to re-read the store (DoD 4.1), then pump so it happens now.
        this.#storeReadAtFlush = -1;
        this.dataPath.pump();
      },
      onDispose: () => {
        this.#panel = null;
      },
      onMessage: (message: WebviewToHostMessage) => {
        // `expandNode` and `selectSession` are pure view state and the webview
        // owns them (see `webview/store.ts`). The host validates and drops
        // them here rather than acting: the moment it acted, the webview would
        // stop being a pure renderer.
        //
        // `resyncRequest` is different in kind: it is the renderer reporting
        // that it could not apply what we sent. `PanelController` has already
        // done the repair by the time this runs; what is left is to say so
        // where a human can read it (DoD 5.5.3).
        if (message.type !== 'resyncRequest') return;
        this.diagnostics?.record({
          kind: 'resyncRequest',
          sessionId: message.sessionId ?? '(none)',
          reason: message.reason,
          ...(message.failedOp !== undefined ? { failedOp: message.failedOp } : {}),
        });
      },
    });
    this.#panelsCreated += 1;
    this.#panel = controller;
    // A brand-new webview knows nothing, so its first message must be a full
    // snapshot. `SessionBridge` guarantees that; pumping supplies the content.
    // The store is re-read for it too (DoD 4.1).
    this.#storeReadAtFlush = -1;
    this.dataPath.pump();
    // Then the settings (DoD 4.0). After, not before: the snapshot-first
    // invariant is the older contract, and the renderer's default while it
    // waits is the manifest default.
    controller.setSettings({ canvasAutoFit: this.#canvasAutoFit });
    return controller;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#countersTimer !== null) {
      this.#scheduler.clearTimer(this.#countersTimer);
      this.#countersTimer = null;
    }
    this.#panel?.dispose();
    this.#panel = null;
    // DoD 3.2b — "the idle timer is disposed on `ended` and on deactivate".
    // `deactivate()` reaches here through `AgentDeckHost.dispose`, and a
    // surviving timer would be the same defect class as a surviving watcher.
    this.stats?.dispose();
    this.diagnostics?.dispose();
    await this.dataPath.dispose();
  }
}

// ---------------------------------------------------------------------------
// (e) Activation
// ---------------------------------------------------------------------------

/** The commands declared in `contributes.commands`. */
export const OPEN_COMMAND = 'agentDeck.open';
export const SHOW_DIAGNOSTICS = SHOW_DIAGNOSTICS_COMMAND;

/**
 * `agentDeck.openStats` — the panel, in its Stats view mode (v0.7.0 Phase 4,
 * DoD 4.6b). The sidebar's second entry. Opens the same panel `agentDeck.open`
 * opens and then asks it to show `stats`; there is no second panel (spec §G).
 */
export const OPEN_STATS_COMMAND = 'agentDeck.openStats';

/**
 * `agentDeck.openSettings` — VS Code's own settings UI, filtered to this
 * extension. A workbench command, no setting written, G1 untouched; it exists
 * so the sidebar has a "Settings" entry that lands where the knobs are.
 */
export const OPEN_SETTINGS_COMMAND = 'agentDeck.openSettings';

/** The workbench command `agentDeck.openSettings` runs, and its argument. */
export const WORKBENCH_OPEN_SETTINGS = 'workbench.action.openSettings';
export const SETTINGS_FILTER = '@ext:nvitlam.agent-deck';

/**
 * Run after the panel is created when MORE THAN ONE editor group exists
 * (locked open question, 2026-09-05): the deck takes `ViewColumn.One`, and
 * with a second group beside it the widths are evened so neither is a sliver.
 * A workbench command; nothing is written.
 */
export const EVEN_EDITOR_WIDTHS = 'workbench.action.evenEditorWidths';

/**
 * `agentDeck.stats.clearHistory` — DoD 3.5.
 *
 * Reachable from the command palette and (in Phase 4) the sidebar menu, and
 * from nowhere else. The locked open question says so in as many words:
 * **never a visible button on the deck or the Stats view.** A destructive,
 * irreversible action one stray click away from a surface a user pans and
 * zooms around all day is a different product from one behind a palette entry
 * and a modal.
 */
export const CLEAR_STATS_COMMAND = 'agentDeck.stats.clearHistory';

/**
 * The modal's destructive button, and its prompt.
 *
 * Exported so `extension.test.ts` drives the real strings rather than a copy —
 * two agreeing literals is the defect `bridge/contract.ts` exists to prevent,
 * and a confirmation dialog is exactly the place where a test that asserts its
 * own copy of the text proves nothing about what a user is shown.
 *
 * The prompt states the two facts a person needs before answering: what is
 * removed, and that nothing else is. It names no count — reading the store to
 * put a number in the dialog would mean parsing every line to answer a question
 * the user did not ask, and a number that is wrong because a second window
 * wrote in the meantime is worse than no number.
 */
export const CLEAR_STATS_CONFIRM = 'Delete history';
export const CLEAR_STATS_PROMPT =
  'Delete the local stats history? This removes every derived record Agent Deck ' +
  'has stored on this machine. Your sessions, transcripts and settings are not touched.';

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

/**
 * The message the command shows when correlation refused, one arm per meaning.
 *
 * `ambiguousSlug` is the one failure kind that is NOT an absence. The
 * filesystem call succeeded and returned two project directories whose names
 * differ only by case; the tailer refuses to guess which one is this workspace
 * rather than picking one (G3). Sessions almost certainly exist, so the generic
 * "no sessions" wording states something false — the same class of defect as a
 * fabricated number, arriving as prose.
 *
 * Extracted from `activate()` rather than left inline so the branch can be
 * driven directly. `ambiguousSlug` requires two sibling directories differing
 * only by case, which NTFS cannot hold, so that arm is unreachable through the
 * real filesystem on a Windows dev box — `pathmatrix.test.ts` records the same
 * constraint for P4-B's probe ("case-insensitive filesystem", probe does not
 * run). `extension.test.ts` covers every kind through this function, and
 * separately ties `activate()`'s emitted message to this function's output on a
 * kind that IS reachable, so the two cannot drift apart.
 *
 * A new `DiscoveryFailureKind` lands in the absence arm by default. That is a
 * decision to make deliberately, not one to inherit.
 */
export function inactiveReasonFor(failure: DiscoveryFailure): string {
  return failure.kind === 'ambiguousSlug'
    ? `Agent Deck: this workspace matches more than one Claude Code project directory, differing only by case. Refusing to guess which one (${failure.kind}).`
    : `Agent Deck: no Claude Code sessions for this workspace (${failure.kind}).`;
}

/**
 * The folder shapes {@link workspacePathsOf} accepts.
 *
 * Structural rather than `vscode.WorkspaceFolder`, so the function can be
 * called from a test without the editor API. It reads one field.
 */
export interface WorkspaceFolderLike {
  readonly uri: { readonly fsPath: string };
}

/**
 * EVERY open workspace folder's path, in the order VS Code reports them.
 *
 * Gate amendment B6. Separated from `firstWorkspacePath()` and exported so the
 * multi-root behaviour is assertable: `test/vscode-mock.ts` exposes a
 * single-folder setter, and this package does not own that file.
 *
 * Empty (rather than `undefined`) when nothing is open, because an empty match
 * set is a meaningful instruction to the OpenCode engine — match nothing —
 * whereas `undefined` means "do not filter" there.
 */
export function workspacePathsOf(
  folders: readonly WorkspaceFolderLike[] | undefined,
): string[] {
  if (folders === undefined) return [];
  return folders.map((folder) => folder.uri.fsPath).filter((path) => path !== '');
}

function workspacePaths(): string[] {
  return workspacePathsOf(vscode.workspace.workspaceFolders);
}

function firstWorkspacePath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders === undefined || folders.length === 0) return undefined;
  return folders[0]?.uri.fsPath;
}

/**
 * Is there an OpenCode store to observe? DoD 5.2's whole switch.
 *
 * `existsSync` and nothing more — the file is not opened here. Opening it would
 * duplicate the probe {@link OpenCodeEnginePath.start} already does and, on a
 * WAL-mode database, would touch the `-shm` sidecar a second time for no
 * information.
 */
export function opencodeStoreExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(opencodeDbPath(opencodeDataDir(env)));
}

/**
 * Does this machine have a Codex data root at all?
 *
 * The third engine's answer to "is there anything here?", and the twin of
 * {@link opencodeStoreExists}. Resolved through {@link resolveCodexRoot}, so
 * `$CODEX_HOME` is honoured — a user who relocated their Codex surface has the
 * whole surface there, sessions and `hooks.json` alike, and probing `~/.codex`
 * for them observes nothing while reporting a confident absence.
 *
 * **The ROOT, not `<root>/sessions`.** The narrower probe would answer "has
 * Codex ever written a transcript", and this question is "is Codex here" — an
 * installed-but-never-run Codex still fires hook events the moment it runs,
 * and the listener has to be bound BEFORE that happens or the first session of
 * the day is the one with no liveness.
 *
 * **`isDirectory()`, not `existsSync`, and that is the engine's predicate
 * rather than a near-enough one.** `locateCodex` decides `rootExists` with
 * `statSync(root).isDirectory()`. An `existsSync` here would answer `true` for
 * a regular FILE at that path, so activation would start a deck for a machine
 * the engine then reports as having no Codex — two probes for one question,
 * disagreeing silently, which is the class this file already carries a comment
 * about at the `start()` gate. Cheap to get right, and there is no second
 * answer to reconcile.
 */
export function codexRootExists(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return statSync(resolveCodexRoot({ env }).root).isDirectory();
  } catch {
    // Absent, unreadable, or a broken link: not a root. G3 — an absent root is
    // a value, never an error, and never a throw on the activation path.
    return false;
  }
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
 * Adapt a real `vscode.WebviewView` to {@link SidebarSurface} (DoD 4.6b).
 *
 * Same shape as {@link adaptWebviewPanel} and for the same reason: the one
 * place the editor API and the sidebar controller's vocabulary meet, written
 * out so a change in either is a compile error here.
 */
export function adaptWebviewView(
  view: vscode.WebviewView,
  extensionUri: vscode.Uri,
): SidebarSurface {
  view.webview.options = {
    enableScripts: true,
    // The same two files the panel may read, and nothing else.
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
  };
  return {
    get cspSource(): string {
      return view.webview.cspSource;
    },
    setHtml: (html: string): void => {
      view.webview.html = html;
    },
    asWebviewUri: (...segments: string[]): string =>
      view.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments)).toString(),
    onDidReceiveMessage: (handler: (raw: unknown) => void): Unsubscribe => {
      const subscription = view.webview.onDidReceiveMessage((raw: unknown) => {
        handler(raw);
      });
      return () => {
        subscription.dispose();
      };
    },
    onDidDispose: (handler: () => void): Unsubscribe => {
      const subscription = view.onDidDispose(() => {
        handler();
      });
      return () => {
        subscription.dispose();
      };
    },
  };
}

/**
 * How many editor groups the window has. `tabGroups` has been on `window`
 * since VS Code 1.67, below this extension's floor; read defensively anyway,
 * because a throw here would be a throw out of a command handler.
 */
function editorGroupCount(): number {
  try {
    return vscode.window.tabGroups.all.length;
  } catch {
    return 1;
  }
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
/**
 * The store directory for a context, or `undefined` when the context has none.
 *
 * ## Why this is not just `resolveStoreDir(context)`
 *
 * `globalStorageUri` has been on `ExtensionContext` since VS Code 1.31 and
 * this extension's floor is `^1.134.0`, so in the editor it is always there.
 * That is an argument for expecting it, not for CRASHING without it — and the
 * first version of this call did crash: `resolveStoreDir` reads
 * `context.globalStorageUri.fsPath`, which throws `TypeError: Cannot read
 * properties of undefined` on any context that lacks the field. A throw here
 * is thrown out of `activate()`, and an extension whose `activate` throws is
 * INERT — no watcher, no listener, no panel — which is the "manifest and build
 * disagree" outcome this repository has already shipped once, reached from a
 * different direction.
 *
 * So the history is the one thing that may be missing, and G2 decides what
 * happens: the stats layer is a third consumer and its absence must be
 * invisible to the deck. A context with no `globalStorageUri` gets no store,
 * and everything else runs exactly as before.
 *
 * **The skip is REPORTED, never silent** (working-method rule 18). It goes to
 * the host log rather than to the diagnostics channel because the channel does
 * not exist yet at this point in activation, and because a window that cannot
 * keep a history should say so once at startup rather than only when somebody
 * opens the channel.
 *
 * It was found by the suite rather than by review: fifteen tests across
 * `egress.test.ts` build a context literal with the two fields `activate` used
 * to need, and every one of them went red at once.
 */
function statsDirFor(context: vscode.ExtensionContext): string | undefined {
  const uri = context.globalStorageUri as { fsPath?: unknown } | undefined;
  if (uri === undefined || uri === null || typeof uri.fsPath !== 'string' || uri.fsPath === '') {
    console.info(
      '[agent-deck] no globalStorageUri on the extension context; ' +
        'the local stats history is disabled for this window.',
    );
    return undefined;
  }
  return resolveStoreDir({ globalStorageUri: { fsPath: uri.fsPath } });
}

export async function activate(context: vscode.ExtensionContext): Promise<AgentDeckApi> {
  /*
   * v0.7.0 DoD 5.1 — THE API, BUILT FIRST AND RETURNED FROM EVERY PATH.
   *
   * `activate()`'s return value is what VS Code hands another extension as
   * `getExtension('nvitlam.agent-deck').exports`, and it has three early
   * returns below (no folder, nothing to observe) before a host exists. The API
   * is built above all of them so each one returns it: a window observing
   * nothing still has a stored history (the store is per MACHINE), and a
   * consumer that got `undefined` from half of all windows would have to guess
   * why.
   *
   * Both getters read through `activeHost` at CALL time rather than capturing
   * it, so the object is valid before the host exists and after it is gone. In
   * a window with no host, live stats are empty and the stored history is read
   * from the context's own directory, honouring `agentDeck.stats.enabled` —
   * a disabled store answers `[]` here exactly as it does in the panel.
   */
  const updates = new StatsUpdateEmitter({
    now: () => Date.now(),
    scheduler: systemScheduler,
    onError: (error: unknown) => {
      activeHost?.diagnostics?.record({
        kind: 'engineDegraded',
        engine: 'cc',
        reason: `stats api: ${error instanceof Error ? error.message : String(error)}`,
      });
    },
  });
  context.subscriptions.push({ dispose: () => updates.dispose() });
  const api = createAgentDeckApi(
    {
      liveRecords: () => activeHost?.stats?.liveRecords() ?? [],
      readStored: (query) => {
        const pipeline = activeHost?.stats;
        if (pipeline !== undefined) return pipeline.store.readRecords(query);
        const dir = statsDirFor(context);
        if (dir === undefined) return [];
        const current = readSettings(vscode.workspace.getConfiguration(CONFIG_SECTION));
        return new StatsStore({
          dir,
          enabled: current['stats.enabled'],
          retentionDays: current['stats.retentionDays'],
        }).readRecords(query);
      },
    },
    updates,
    (reason) => {
      activeHost?.diagnostics?.record({ kind: 'engineDegraded', engine: 'cc', reason });
    },
  );

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
    /*
     * v0.7.0 DoD 4.6b. The same panel, asked to show the Stats view mode.
     * Same inactive message as `agentDeck.open`, because it is the same panel.
     */
    vscode.commands.registerCommand(OPEN_STATS_COMMAND, () => {
      const host = activeHost;
      if (host === null) {
        void vscode.window.showInformationMessage(
          inactiveReason ??
            'Agent Deck: this workspace has no Claude Code project directory yet.',
        );
        return;
      }
      host.openStats();
    }),
    /*
     * v0.7.0 DoD 4.6b. VS Code's settings UI, filtered to this extension —
     * a workbench command with an argument, and nothing written.
     */
    vscode.commands.registerCommand(OPEN_SETTINGS_COMMAND, () => {
      void vscode.commands.executeCommand(WORKBENCH_OPEN_SETTINGS, SETTINGS_FILTER);
    }),
    /*
     * v0.7.0 DoD 4.6b — THE SIDEBAR, registered UNCONDITIONALLY and above the
     * activation gates, like the clear command and for the same reason: it is
     * the product's front door, and a front door that only exists in windows
     * the data path started in is missing from exactly the window someone
     * opens to find out why nothing is showing. Every entry runs a command
     * registered in this same function, so each explains itself when there is
     * nothing to show.
     */
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, {
      resolveWebviewView: (view: vscode.WebviewView): void => {
        new SidebarController({
          surface: adaptWebviewView(view, context.extensionUri),
          executeCommand: (command: string) => vscode.commands.executeCommand(command),
          onError: (error: unknown) => {
            void vscode.window.showErrorMessage(
              `Agent Deck: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        });
      },
    }),
    /*
     * DoD 5.5.3. Registered beside `agentDeck.open` and for the same reason
     * the comment above gives: a palette entry that explains itself beats
     * "command not found". It is the ONLY path that reveals the channel —
     * nothing else calls `show()`, so the extension never puts a panel in
     * front of a user who did not ask for one.
     */
    vscode.commands.registerCommand(SHOW_DIAGNOSTICS_COMMAND, () => {
      const host = activeHost;
      if (host === null || host.diagnostics === undefined) {
        void vscode.window.showInformationMessage(
          inactiveReason ?? 'Agent Deck: diagnostics are unavailable in this window.',
        );
        return;
      }
      host.diagnostics.show();
    }),
    /*
     * DoD 3.5. Registered UNCONDITIONALLY, beside the other two and above the
     * activation gates, and that placement is the decision.
     *
     * A user whose window has no matching project still has a history on disk
     * from every window that did — the store is per MACHINE, under
     * `globalStorageUri`, not per workspace. A clear command that existed only
     * in windows the data path started in would be missing from exactly the
     * window someone opens to tidy up. So it resolves the directory from the
     * context rather than from `activeHost`, and works whether or not anything
     * is being observed.
     */
    vscode.commands.registerCommand(CLEAR_STATS_COMMAND, async () => {
      // Resolved INSIDE the handler, and through the same guarded helper the
      // host uses: this command is registered above the activation gates, so
      // there is no computed `statsDir` in scope yet, and a context with no
      // `globalStorageUri` must produce an explanation rather than a throw.
      const dir = statsDirFor(context);
      if (dir === undefined) {
        void vscode.window.showInformationMessage(
          'Agent Deck: this window has no storage directory, so there is no stats history to clear.',
        );
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        CLEAR_STATS_PROMPT,
        { modal: true },
        CLEAR_STATS_CONFIRM,
      );
      // ANY answer other than the destructive button leaves everything: the
      // dismissal of a modal is `undefined`, and treating "not a yes" as a yes
      // is the one mistake this dialog exists to prevent.
      if (answer !== CLEAR_STATS_CONFIRM) return;
      const settings = readSettings(vscode.workspace.getConfiguration(CONFIG_SECTION));
      new StatsStore({
        dir,
        // The CLEAR path ignores `stats.enabled`, deliberately. A user who has
        // just turned the store off is precisely the user who then wants what
        // it already wrote removed, and a disabled store that refuses to clear
        // itself would strand that history with no way to reach it.
        enabled: true,
        retentionDays: settings['stats.retentionDays'],
        onError: (error: unknown) => {
          void vscode.window.showErrorMessage(
            `Agent Deck: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      }).clear();
      // DoD 4.14: in the same action, not on the next flush. A no-op in a window
      // with no host — the no-workspace window this command also exists for —
      // because that window has no panel holding any records.
      activeHost?.statsHistoryCleared();
    }),
  );

  const workspacePath = firstWorkspacePath();
  if (workspacePath === undefined) {
    inactiveReason = NO_WORKSPACE_MESSAGE;
    return api;
  }

  /*
   * THREE ENGINES, THREE INDEPENDENT ANSWERS TO "IS THERE ANYTHING HERE?"
   *
   * Claude Code answers with a project-slug correlation; OpenCode answers with
   * the existence of its store (DoD 5.2 — "on by default when the data
   * directory exists", no setting); Codex answers with the existence of its
   * data root, resolved the way the engine resolves it. Any one is enough to
   * start; only all three failing means there is nothing to show.
   *
   * **The Codex arm was missing until 2026-09-04**, and it is the outer half
   * of the same gap the socket-binding rule closes inside
   * {@link AgentDeckDataPath.start}: a window with Codex sessions, no Claude
   * Code project and no OpenCode store returned here, so there was no data
   * path to bind a socket at all. Fixing the inner gate alone would have
   * fixed nothing for exactly the user this is for.
   *
   * The correlation gate's original point — a non-matching workspace allocates
   * no watcher, no CC timer — is preserved by `ccEnabled` rather than by
   * returning: a workspace with no CC project directory still starts nothing
   * on the CC side.
   */
  const correlation = await correlateWorkspace(workspacePath);
  const opencodeAvailable = opencodeStoreExists();
  const codexAvailable = codexRootExists();
  if (!correlation.ok && !opencodeAvailable && !codexAvailable) {
    inactiveReason = inactiveReasonFor(correlation.failure);
    return api;
  }
  inactiveReason = null;

  const settings = readSettings(vscode.workspace.getConfiguration(CONFIG_SECTION));
  const extensionUri = context.extensionUri;
  const statsDir = statsDirFor(context);

  const host = new AgentDeckHost({
    workspacePath,
    /*
     * B6: EVERY open folder goes to the OpenCode engine, while the Claude Code
     * half above takes the first one only.
     *
     * THE TWO ENGINES ARE THEREFORE ASYMMETRIC IN A MULTI-ROOT WORKSPACE, ON
     * PURPOSE: OpenCode observes every root, Claude Code observes the first.
     * That is a pre-existing limitation of the CC path — `firstWorkspacePath()`
     * and `AgentDeckDataPath.workspacePath` are singular throughout, and have
     * been since Phase 3 — and it is not created here. Narrowing OpenCode to
     * `[workspacePath]` would make the asymmetry invisible without making it
     * untrue.
     *
     * OPEN ITEM for a later phase: make the Claude Code half multi-root, which
     * means a correlation and a watcher per folder rather than one of each.
     */
    workspacePaths: workspacePaths(),
    ccEnabled: correlation.ok,
    /*
     * DoD 5.5.3. A FACTORY, not a channel: `DiagnosticsChannel` calls this on
     * its first line and never at construction, so a window where nothing
     * happens gets no "Agent Deck" entry in the Output dropdown. The `vscode`
     * call lives here and nowhere deeper for the reason `HostLogger` does —
     * `test/vscode-mock.ts` has no `createOutputChannel`, and a module that
     * reached for one would take the whole data path out of reach of the
     * tests.
     */
    createDiagnosticsSink: () => vscode.window.createOutputChannel(DIAGNOSTICS_CHANNEL_NAME),
    /*
     * DoD 3.1 and 3.7 — the ONE production call that names the store's
     * location, and it names it by asking `resolveStoreDir`.
     *
     * `context.globalStorageUri` is VS Code's own per-extension directory: it
     * is outside every workspace folder and outside every observed engine's
     * directory by construction, which is what makes G1 hold here for free
     * rather than by inspection. The path law test asserts all of that against
     * a real context anyway, because "by construction" is a claim.
     */
    ...(statsDir === undefined ? {} : { statsDir }),
    /*
     * DoD 5.2 — THE ONE PRODUCTION ASSIGNMENT OF THE API'S FEED. Every flush and
     * every live change of an observed session reaches `onDidUpdateStats`
     * through this line and no other, which is why `extension.test.ts` drives it
     * through `activate()` rather than by constructing a host by hand.
     */
    onStatsUpdate: (record, cause) => {
      if (cause === 'flush') updates.flushed(record);
      else updates.live(record);
    },
    settings,
    createPanel: () => {
      /*
       * v0.7.0 DoD 4.6c — THE DECK OPENS LEFT (locked open question,
       * 2026-09-05). `ViewColumn.One`, not `Beside`: the panel is the room and
       * it takes the first group. Then, when more than one editor group
       * exists, the widths are evened so the group it joined and the one
       * beside it share the window. Both are workbench commands; no setting
       * is written and G1 is untouched. With ONE group there is nothing to
       * even and the command is not run.
       */
      const panel = vscode.window.createWebviewPanel(
        PANEL_VIEW_TYPE,
        PANEL_TITLE,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          // The webview may read the built bundle and nothing else. Combined
          // with the CSP in `html.ts`, the renderer's reachable surface is
          // two files.
          localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
        },
      );
      if (editorGroupCount() > 1) {
        void vscode.commands.executeCommand(EVEN_EDITOR_WIDTHS);
      }
      return adaptWebviewPanel(panel, extensionUri);
    },
    onEmission: () => {
      // The panel is fed by AgentDeckHost itself; nothing else consumes
      // emissions today. Kept as a required option so a future consumer is an
      // argument rather than an edit to the host.
    },
    onError: (error: unknown) => {
      if (isHookListenerBindError(error)) {
        /*
         * DoD 1b.7 — THE MESSAGE NOW SAYS WHAT IT MEANS, WHICH IS NARROWER
         * THAN WHAT IT USED TO MEAN.
         *
         * Before Phase 1b this fired for every busy port, including the common
         * and entirely benign case of a SECOND AGENT DECK WINDOW — which the
         * user then read as a defect, because as far as the product was
         * concerned it was one. That case no longer reaches here at all: the
         * shared listener probes the port holder, recognises another Agent
         * Deck leader and attaches to it silently. So an error on this line
         * now means something specific — the port is held by a process that is
         * NOT Agent Deck — and the text says so, because a message that names
         * the wrong cause sends a user hunting for the wrong window.
         *
         * The last sentence is unchanged, deliberately. Agent Deck still will
         * not pick a port: the pasted hook snippet names this number literally
         * and a listener that quietly moved would be a capture that silently
         * recorded nothing.
         */
        void vscode.window.showErrorMessage(
          `Agent Deck: port ${error.port} is held by another program (${error.code}), ` +
            'not by another Agent Deck window — a second window would have joined the ' +
            `first one automatically. Liveness is unavailable until the port is free, or ` +
            `set "${CONFIG_SECTION}.port" to a different port and reload. ` +
            'Agent Deck will not pick a port for you.',
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
      // ...and `canvas.autoFit` (DoD 4.0): one boolean the renderer reads on
      // its next fit decision, so it moves live too.
      host.setCanvasAutoFit(next['canvas.autoFit']);
    }),
  );

  await host.start();
  return api;
}

/** Dispose everything. A bound socket or a live watcher after this is a defect. */
export async function deactivate(): Promise<void> {
  const host = activeHost;
  activeHost = null;
  inactiveReason = null;
  if (host === null) return;
  await host.dispose();
}
