/**
 * The Insights provider — extension API v2, v0.9.0 DoD 9.30, widened by DoD
 * 9.40 (spec `Amendment 2026-09-22 — Provider contract v1 widened
 * (pre-publish; API_VERSION stays 2)`).
 *
 * ## What changed, and why the parent stopped asking whether Insights is installed
 *
 * Until DoD 9.30 the parent looked Insights up by extension id, asked
 * whether it was INSTALLED, and ran its commands by name. Two own-eyes passes
 * found that wrong: a command id the parent invented and Insights never
 * contributed, and a sidebar that described the wrong state while the panel
 * was closed. The amendment replaces the whole arrangement with one
 * relationship: **Insights REGISTERS a provider through this extension's API,
 * and the parent renders what the provider returns.** "Installed" is never
 * consulted by the UI; the only state is "provider registered or not".
 *
 * ## What the parent may do with a provider — and nothing else
 *
 * It reads `providerVersion`, `about` and whether `getRawOutput` exists once,
 * at registration. It calls `getLatest()` and `listRuns()` to build a
 * snapshot, `run()` when the user presses Run, `getRawOutput(runId)` when
 * the user asks for a refused run's raw output, and subscribes to
 * `onDidChange`. **It calls nothing else on it**, and
 * `insights-provider.test.ts` holds that with a provider wrapped in a Proxy
 * that records every property read.
 *
 * Insights registers only after it has verified a licence signature, so the
 * parent never has licence knowledge: a provider being registered is the
 * whole of what it knows.
 *
 * ## Every value a provider returns is checked, copied, and never trusted
 *
 * `FindingSetView` and `RunSummary` are the PARENT's types
 * (`src/model/events.ts`), and a provider is another extension's code. So
 * nothing it returns is passed on: {@link viewOfFindingSet} and
 * {@link viewOfRuns} read each field through own-data-property access, check
 * it, and build a fresh object from the fields that passed.
 *
 * **Since DoD 9.40 a finding carries the provider's TEXT** — an action lead
 * and detail, a cause, evidence labels, a refusal's step and reason. Every
 * one is checked against a TEXT CLASS, the same caps the stats store keeps:
 * a NAME is at most {@link NAME_MAX_CHARS} characters, a PATH at most
 * {@link PATH_MAX_CHARS}, FREE TEXT at most {@link FREE_TEXT_MAX_CHARS}. The
 * store states the first two (`src/stats/schema.ts`); it has no free-text
 * class, because nothing in a stats record is prose, so the third is new
 * here and is the amendment's number. No text may carry a control or FORMAT
 * character (Unicode Cc, Cf — zero-width and bidirectional characters among
 * them; free text may carry a tab and LF or CRLF line ends), a line or
 * paragraph separator, or a lone surrogate.
 *
 * A value that fails is DROPPED and COUNTED — never truncated, never
 * repaired (G3) — and the count is shown on the surface. A truncated string
 * is still text the provider did not send.
 *
 * ## No `vscode` import
 *
 * Like `src/api.ts`: the event shape is structural, so this is testable in a
 * plain node process and a provider built against `vscode.Event<void>` fits.
 */

import type {
  FindingActionView,
  FindingEvidenceView,
  FindingSetRefusalView,
  FindingSetView,
  FindingSinceLastRun,
  FindingView,
  InsightsAgentKind,
  InsightsConfidence,
  InsightsFindingKind,
  InsightsProviderAbout,
  InsightsProviderSnapshot,
  InsightsRunState,
  RunSummary,
} from './model/events.js';
import {
  NAME_MAX_CHARS,
  PATH_MAX_CHARS,
  STATS_SCOPED_STRING_FIELDS,
  STATS_STRING_FIELDS,
} from './stats/schema.js';

/** The provider contract's version. A provider states it; any other is refused. */
export const PROVIDER_VERSION = 1;

/** The eight finding kinds, in Insights' own order. */
export const FINDING_KINDS: readonly InsightsFindingKind[] = Object.freeze([
  're-read-loop',
  'churn-chain',
  'context-churn',
  'stall',
  'silent-subagent',
  'compaction',
  'cache-miss',
  'other',
]);

export const CONFIDENCES: readonly InsightsConfidence[] = Object.freeze(['low', 'medium', 'high']);

export const RUN_STATES: readonly InsightsRunState[] = Object.freeze(['ok', 'empty', 'refused']);

export const SINCE_LAST_RUN: readonly FindingSinceLastRun[] = Object.freeze([
  'new',
  'still',
  'resolved',
]);

export const AGENTS: readonly InsightsAgentKind[] = Object.freeze(['claude', 'codex']);

/** An id — a run's, a finding's, a session's. No character that means anything to a renderer. */
export const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * A path into the Layer 1 payload, the shape Insights' own validator accepts
 * — `sessions[0].totals.compactions` — with every segment bounded.
 */
export const STATS_KEY_PATTERN =
  /^sessions(?:\[(?:0|[1-9]\d{0,5})\]|\.[A-Za-z_][A-Za-z0-9_]{0,63}){1,12}$/;

/** A provider's display name. */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** A version: `1.2.3`, optionally `-rc.1` or `-alpha.7.2`. */
export const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[A-Za-z0-9.]{1,32})?$/;

/**
 * The free-text cap — the amendment's number. The store caps names and paths
 * ({@link NAME_MAX_CHARS}, {@link PATH_MAX_CHARS}) and has no prose to cap.
 */
export const FREE_TEXT_MAX_CHARS = 2000;

/** An action's lead: at most this many words. */
export const LEAD_MAX_WORDS = 15;

/** The text classes and their caps, in CHARACTERS as the store counts them. */
export type TextClass = 'name' | 'path' | 'free';
export const TEXT_CAPS: Readonly<Record<TextClass, number>> = Object.freeze({
  name: NAME_MAX_CHARS,
  path: PATH_MAX_CHARS,
  free: FREE_TEXT_MAX_CHARS,
});

/** Upper bounds, so a provider cannot make the panel draw without end. */
export const MAX_FINDINGS = 64;
export const MAX_EVIDENCE = 16;
export const MAX_RUNS = 50;

/**
 * The most raw output the host will open, in characters. More is REFUSED,
 * never cut: a cut transcript of what a model said is a different transcript.
 */
export const RAW_OUTPUT_MAX_CHARS = 1_048_576;

/** `vscode.Disposable`'s shape. */
export interface ProviderDisposable {
  dispose(): unknown;
}

/** `vscode.Event<T>`'s shape. */
export type ProviderEvent<T> = (
  listener: (event: T) => unknown,
  thisArgs?: unknown,
  disposables?: ProviderDisposable[],
) => ProviderDisposable;

/**
 * What another extension registers — spec `Amendment 2026-09-21`, widened by
 * `Amendment 2026-09-22`. Every member is the parent's to READ; none is the
 * parent's to write.
 */
export interface InsightsProvider {
  readonly providerVersion: typeof PROVIDER_VERSION;
  readonly about: InsightsProviderAbout;
  /** The latest finding set, or `null` when there is none yet. */
  getLatest(): FindingSetView | null;
  /** The run history, newest first. */
  listRuns(): RunSummary[];
  /** Run once. The parent awaits it and shows `running` until it settles. */
  run(): Promise<void>;
  /**
   * OPTIONAL — a run's raw output, or `null` when the provider has none.
   * Asked only for a REFUSED run, when the user presses "Show raw output".
   */
  getRawOutput?(runId: string): string | null;
  /** Fires when anything `getLatest` or `listRuns` would return has moved. */
  readonly onDidChange: ProviderEvent<void>;
}

/* ------------------------------------------------------------------------ *
 * Reading untrusted values
 * ------------------------------------------------------------------------ */

/**
 * An OWN DATA property, or `undefined`.
 *
 * Never a getter and never an inherited name: a provider's object is another
 * extension's, and a getter would run its code in the middle of a check. A
 * Proxy whose traps throw is answered with `undefined` too.
 */
function own(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    return descriptor.value as unknown;
  } catch {
    return undefined;
  }
}

/** The own enumerable keys, or `null` when they cannot be read. */
function keysOf(value: unknown): readonly string[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  try {
    return Object.keys(value);
  } catch {
    return null;
  }
}

/** True iff `value`'s own keys are exactly `expected`, in any order. */
function hasExactly(value: unknown, expected: readonly string[]): boolean {
  const keys = keysOf(value);
  if (keys === null || keys.length !== expected.length) return false;
  return expected.every((key) => keys.includes(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1e9;
}

/** A token count: any non-negative safe integer (a window can exceed a billion). */
function isTokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isInstant(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 8.64e15;
}

function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

/** An array's items, or `null`. Only a real array. */
function itemsOf(value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  try {
    return Array.from(value as unknown[]);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------------ */

/**
 * Characters no provider text may carry, in any class, by UNICODE CATEGORY
 * rather than by a list of code points: every control (Cc) other than tab and
 * line feed, every FORMAT character (Cf — zero-width spaces and joiners, the
 * bidirectional marks, embeddings, overrides and isolates of the Trojan Source
 * class, the soft hyphen, the byte-order mark, the tag characters), every lone
 * surrogate (Cs, which a `u` pattern sees as its own code point), and the
 * line and paragraph separators (Zl, Zp).
 *
 * By category since verifier round 9.43 (D3): the first rule listed code
 * points and admitted U+200B and its kin, so a label made of zero-width
 * spaces passed the blank check and rendered as nothing. A category cannot
 * miss a member the way a list can.
 */
const FORBIDDEN_CHARS = /(?![\t\n])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/**
 * True iff `value` is text of `cls`: a string, not blank, within the class's
 * cap, free of {@link FORBIDDEN_CHARS} — and, unless `multiline`, with no line
 * feed or tab. Text that may span lines may end its lines with CRLF: a CR is
 * admitted only directly before a line feed (a provider on Windows writes
 * them), and the text is kept as sent, never rewritten.
 */
export function isText(value: unknown, cls: TextClass, multiline = false): value is string {
  if (typeof value !== 'string' || value.length > TEXT_CAPS[cls]) return false;
  if (value.trim() === '') return false;
  if (!multiline && /[\n\t]/.test(value)) return false;
  const lines = multiline ? value.replace(/\r\n/g, '\n') : value;
  return !FORBIDDEN_CHARS.test(lines);
}

/**
 * What the Output channel may say about an error a PROVIDER threw — verifier
 * round 9.43, D2.
 *
 * A provider's thrown value is its text, and the channel is a surface. So its
 * message is read as an OWN DATA property (never a getter, never `toString`),
 * and printed only when it is free text by {@link isText}; otherwise the line
 * says the message was withheld and how long it was. Never cut.
 */
export function providerErrorText(error: unknown): string {
  const message = typeof error === 'string' ? error : own(error, 'message');
  if (isText(message, 'free', true)) return message;
  if (typeof message === 'string') {
    return `(a message of ${String(message.length)} characters that did not pass the check, not shown)`;
  }
  return '(an error with no message)';
}

/** An action's lead: one line of free text, at most {@link LEAD_MAX_WORDS} words. */
export function isLead(value: unknown): value is string {
  return isText(value, 'free') && value.trim().split(/\s+/).length <= LEAD_MAX_WORDS;
}

/** A session record's path inside a stats key: `sessions[3].<this>`. */
const RECORD_PATH = /^sessions\[(?:0|[1-9]\d{0,5})\]\.(.+)$/;

/**
 * The text class a STRING evidence value may take at `statsKey`, or `null`
 * when a string is not admitted there.
 *
 * The store's own allow-list decides, judged the way its validator judges a
 * stored record: the key the path ends in (an array element is judged by the
 * array's name, so `unavailable[2]` is `unavailable`) against
 * `STATS_STRING_FIELDS`, or the path with every index as `[]` against
 * `STATS_SCOPED_STRING_FIELDS` (`skills[].name`). A key the store does not
 * allow as a string cannot carry one here either — which is what keeps this
 * from being a second, unchecked route for a string into the panel.
 *
 * The cap is the store's where it has one (`filePath` 1,024, `agentType` and
 * a skill's `name` 64); `projectSlug` is a path's encoding and takes the path
 * cap; every other admitted key is an identifier or an enum and takes the
 * name cap.
 */
export function stringEvidenceClass(statsKey: string): TextClass | null {
  if (!STATS_KEY_PATTERN.test(statsKey)) return null;
  const path = RECORD_PATH.exec(statsKey)?.[1];
  if (path === undefined) return null;
  const key = /([A-Za-z_][A-Za-z0-9_]*)(?:\[\d+\])*$/.exec(path)?.[1];
  if (key === undefined) return null;
  const scoped = path.replace(/\[\d+\]/g, '[]');
  if (!STATS_STRING_FIELDS.has(key) && !STATS_SCOPED_STRING_FIELDS.has(scoped)) return null;
  return key === 'filePath' || key === 'projectSlug' ? 'path' : 'name';
}

/* ------------------------------------------------------------------------ *
 * The views
 * ------------------------------------------------------------------------ */

/** A provider's about, checked, as a fresh object — or `null`. */
export function viewOfAbout(value: unknown): InsightsProviderAbout | null {
  if (!hasExactly(value, ['name', 'version'])) return null;
  const name = own(value, 'name');
  const version = own(value, 'version');
  if (!matches(name, NAME_PATTERN) || !matches(version, VERSION_PATTERN)) return null;
  return { name, version };
}

function viewOfEvidence(value: unknown): FindingEvidenceView | null {
  if (!hasExactly(value, ['label', 'sessionId', 'statsKey', 'value'])) return null;
  const label = own(value, 'label');
  const sessionId = own(value, 'sessionId');
  const statsKey = own(value, 'statsKey');
  const item = own(value, 'value');
  if (!isText(label, 'name') || !matches(sessionId, ID_PATTERN)) return null;
  if (!matches(statsKey, STATS_KEY_PATTERN)) return null;
  if (isFiniteNumber(item)) return { label, sessionId, statsKey, value: item };
  if (typeof item !== 'string') return null;
  const cls = stringEvidenceClass(statsKey);
  if (cls === null || !isText(item, cls)) return null;
  return { label, sessionId, statsKey, value: item };
}

function viewOfAction(value: unknown): FindingActionView | null {
  if (!hasExactly(value, ['lead', 'detail'])) return null;
  const lead = own(value, 'lead');
  const detail = own(value, 'detail');
  if (!isLead(lead) || !isText(detail, 'free', true)) return null;
  return { lead, detail };
}

const FINDING_KEYS = ['id', 'kind', 'confidence', 'action', 'cause', 'evidence', 'sinceLastRun'];

function viewOfFinding(value: unknown): FindingView | null {
  if (!hasExactly(value, FINDING_KEYS)) return null;
  const id = own(value, 'id');
  const kind = own(value, 'kind');
  const confidence = own(value, 'confidence');
  const action = viewOfAction(own(value, 'action'));
  const cause = own(value, 'cause');
  const sinceLastRun = own(value, 'sinceLastRun');
  const items = itemsOf(own(value, 'evidence'));
  if (!matches(id, ID_PATTERN)) return null;
  if (!isOneOf(kind, FINDING_KINDS) || !isOneOf(confidence, CONFIDENCES)) return null;
  if (action === null || !isText(cause, 'free', true)) return null;
  if (sinceLastRun !== null && !isOneOf(sinceLastRun, SINCE_LAST_RUN)) return null;
  if (items === null || items.length === 0 || items.length > MAX_EVIDENCE) return null;
  const evidence: FindingEvidenceView[] = [];
  const keys = new Set<string>();
  for (const item of items) {
    const view = viewOfEvidence(item);
    // One bad piece of evidence drops the FINDING, not the evidence: a
    // finding shown with part of what it rests on is a partial render.
    if (view === null) return null;
    // The same key of the same session twice is either a repeat or two
    // values for one number, and neither is a finding to show (verifier
    // round 9.33, D1).
    const key = JSON.stringify([view.sessionId, view.statsKey]);
    if (keys.has(key)) return null;
    keys.add(key);
    evidence.push(view);
  }
  return { id, kind, confidence, action, cause, evidence, sinceLastRun };
}

function viewOfUsage(value: unknown): FindingSetView['usage'] | undefined {
  if (value === null) return null;
  const withCost = hasExactly(value, ['prompt', 'output', 'costUsd']);
  if (!withCost && !hasExactly(value, ['prompt', 'output'])) return undefined;
  const prompt = own(value, 'prompt');
  const output = own(value, 'output');
  if (!isTokens(prompt) || !isTokens(output)) return undefined;
  if (!withCost) return { prompt, output };
  const costUsd = own(value, 'costUsd');
  if (!isFiniteNumber(costUsd) || costUsd < 0) return undefined;
  return { prompt, output, costUsd };
}

function viewOfRefusal(value: unknown): FindingSetRefusalView | null {
  if (!hasExactly(value, ['step', 'reason'])) return null;
  const step = own(value, 'step');
  const reason = own(value, 'reason');
  if (!isText(step, 'name') || !isText(reason, 'free', true)) return null;
  return { step, reason };
}

/** A checked value, and how many values were dropped on the way. */
export interface Checked<T> {
  value: T;
  dropped: number;
}

const SET_KEYS = ['runId', 'createdAt', 'agent', 'window', 'usage', 'findings', 'rejected', 'state'];

/**
 * The latest finding set, checked and copied.
 *
 * The ENVELOPE must be whole: a set whose instant, agent, window, usage,
 * state or refusal fails is dropped entirely (one drop) and the surface shows
 * no latest set. So is a set whose state and findings disagree — `ok` with no
 * finding, `empty` or `refused` with one — or whose `refusal` is present
 * without `refused` or absent with it: a set that contradicts itself is not a
 * statement about a run.
 *
 * Findings are checked one by one, and each that fails is dropped and counted
 * while the rest are shown — the set is still the provider's statement about
 * a run, and the drop count beside it says it was not shown whole. A finding
 * id seen before in the same set is dropped and counted the same way.
 */
export function viewOfFindingSet(value: unknown): Checked<FindingSetView | null> {
  if (value === null || value === undefined) return { value: null, dropped: 0 };
  const dropSet = { value: null, dropped: 1 };
  const state = own(value, 'state');
  if (!isOneOf(state, RUN_STATES)) return dropSet;
  if (!hasExactly(value, state === 'refused' ? [...SET_KEYS, 'refusal'] : SET_KEYS)) return dropSet;
  const runId = own(value, 'runId');
  const createdAt = own(value, 'createdAt');
  const agent = own(value, 'agent');
  const window = own(value, 'window');
  const rejected = own(value, 'rejected');
  const usage = viewOfUsage(own(value, 'usage'));
  const items = itemsOf(own(value, 'findings'));
  const kind = own(agent, 'kind');
  const version = own(agent, 'version');
  const sessions = own(window, 'sessions');
  const excluded = own(window, 'excluded');
  const sinceMs = own(window, 'sinceMs');
  const envelopeOk =
    matches(runId, ID_PATTERN) &&
    isInstant(createdAt) &&
    hasExactly(agent, ['kind', 'version']) &&
    isOneOf(kind, AGENTS) &&
    matches(version, VERSION_PATTERN) &&
    hasExactly(window, ['sessions', 'excluded', 'sinceMs']) &&
    isCount(sessions) &&
    isCount(excluded) &&
    isInstant(sinceMs) &&
    usage !== undefined &&
    isCount(rejected) &&
    items !== null &&
    (state === 'ok' ? items.length > 0 : items.length === 0);
  if (!envelopeOk) return dropSet;
  let refusal: FindingSetRefusalView | null = null;
  if (state === 'refused') {
    refusal = viewOfRefusal(own(value, 'refusal'));
    if (refusal === null) return dropSet;
  }
  const findings: FindingView[] = [];
  const ids = new Set<string>();
  let dropped = 0;
  for (const item of items.slice(0, MAX_FINDINGS)) {
    const view = viewOfFinding(item);
    if (view === null || ids.has(view.id)) dropped += 1;
    else {
      ids.add(view.id);
      findings.push(view);
    }
  }
  // Past the cap is not "invalid", and it is not shown either — so it is
  // counted, because a drop nobody can see is the silent partial render.
  dropped += Math.max(0, items.length - MAX_FINDINGS);
  return {
    value: {
      runId,
      createdAt,
      agent: { kind, version },
      window: { sessions, excluded, sinceMs },
      usage,
      findings,
      rejected,
      state,
      ...(refusal === null ? {} : { refusal }),
    },
    dropped,
  };
}

function viewOfRun(value: unknown): RunSummary | null {
  if (!hasExactly(value, ['runId', 'createdAt', 'state', 'findings', 'agentKind'])) return null;
  const runId = own(value, 'runId');
  const createdAt = own(value, 'createdAt');
  const state = own(value, 'state');
  const findings = own(value, 'findings');
  const agentKind = own(value, 'agentKind');
  if (!matches(runId, ID_PATTERN) || !isInstant(createdAt)) return null;
  if (!isOneOf(state, RUN_STATES) || !isCount(findings) || !isOneOf(agentKind, AGENTS)) return null;
  // The same agreement the set keeps: an `ok` run found something, the
  // others found nothing.
  if (state === 'ok' ? findings === 0 : findings !== 0) return null;
  return { runId, createdAt, state, findings, agentKind };
}

/** The run history, checked and copied, capped at {@link MAX_RUNS}. */
export function viewOfRuns(value: unknown): Checked<RunSummary[]> {
  const items = itemsOf(value);
  if (items === null) return { value: [], dropped: value === undefined ? 0 : 1 };
  const runs: RunSummary[] = [];
  let dropped = 0;
  const ids = new Set<string>();
  for (const item of items.slice(0, MAX_RUNS)) {
    const view = viewOfRun(item);
    // A run id seen before is dropped and counted: the history names runs by
    // id, and two rows with one id are one claim made twice (verifier round
    // 9.33, D1 — the surface keyed its rows on it and Svelte threw).
    if (view === null || ids.has(view.runId)) dropped += 1;
    else {
      ids.add(view.runId);
      runs.push(view);
    }
  }
  dropped += Math.max(0, items.length - MAX_RUNS);
  return { value: runs, dropped };
}

/**
 * The run a refused latest set belongs to, or `null` when the set is not
 * refused.
 *
 * The set's OWN `runId` — the ruling of 2026-09-22 (round 5, ruling 1).
 * Until then the set carried no run id and the host joined it to the history
 * on `createdAt`; that join is gone, and the history plays no part in which
 * run's raw output is asked for.
 */
export function refusedRunIdOf(latest: FindingSetView | null): string | null {
  return latest !== null && latest.state === 'refused' ? latest.runId : null;
}

/* ------------------------------------------------------------------------ *
 * The registry — one provider at a time
 * ------------------------------------------------------------------------ */

export interface InsightsProviderRegistryOptions {
  /** Anything a surface shows moved: registered, changed, running, gone. */
  onChange: () => void;
  /** A provider method threw, or its `run()` rejected. Never rethrown. */
  onError?: (error: unknown) => void;
}

/** One registration, held with the facts checked when it was made. */
interface Registration {
  readonly provider: InsightsProvider;
  readonly about: InsightsProviderAbout;
  /** Whether the provider had `getRawOutput` when it registered. */
  readonly rawOutput: boolean;
  readonly subscription: ProviderDisposable | null;
}

/**
 * What asking for a refused run's raw output came to.
 *
 * `ok` carries the text, whole. Every other answer names why nothing is
 * shown; `too-large` carries the length, because "over the cap" without the
 * number is not something a reader can check.
 */
export type RawOutputResult =
  | { ok: true; runId: string; text: string }
  | { ok: false; reason: 'no-provider' | 'unsupported' | 'no-run' }
  | { ok: false; reason: 'none' | 'invalid' | 'threw'; runId: string }
  | { ok: false; reason: 'too-large'; runId: string; length: number };

/**
 * Holds the ONE registered provider.
 *
 * **A second registration is refused BY NAME**: the error names the provider
 * already registered and the one refused, so whoever reads it knows which two
 * extensions collided. Registering again after the first disposes is allowed.
 */
export class InsightsProviderRegistry {
  readonly #onChange: () => void;
  readonly #onError: ((error: unknown) => void) | undefined;
  #current: Registration | null = null;
  #running = false;
  #disposed = false;

  constructor(options: InsightsProviderRegistryOptions) {
    this.#onChange = options.onChange;
    this.#onError = options.onError;
  }

  /**
   * Register `provider`, or throw.
   *
   * Throws a `TypeError` for anything that is not a provider of this
   * contract's version, and an `Error` naming both parties when one is
   * already registered. A registration that throws changes nothing.
   *
   * `getRawOutput` is OPTIONAL: absent, the surface never offers raw output;
   * present, it must be a function. Given as a getter it reads as absent,
   * because a getter would run the provider's code in the middle of a check.
   */
  register(provider: unknown): ProviderDisposable {
    if (this.#disposed) throw new Error('Agent Deck: the extension is shutting down; no provider can register.');
    const version = readMember(provider, 'providerVersion');
    if (version !== PROVIDER_VERSION) {
      throw new TypeError(
        `Agent Deck: an Insights provider must state providerVersion ${String(PROVIDER_VERSION)}.`,
      );
    }
    const about = viewOfAbout(readMember(provider, 'about'));
    if (about === null) {
      throw new TypeError(
        'Agent Deck: an Insights provider must state about { name, version } in the allowed shape.',
      );
    }
    for (const member of ['getLatest', 'listRuns', 'run', 'onDidChange'] as const) {
      if (typeof readMember(provider, member) !== 'function') {
        throw new TypeError(`Agent Deck: an Insights provider must have ${member}.`);
      }
    }
    const rawOutput = readMember(provider, 'getRawOutput');
    if (rawOutput !== undefined && typeof rawOutput !== 'function') {
      throw new TypeError('Agent Deck: an Insights provider’s getRawOutput, when present, must be a function.');
    }
    const current = this.#current;
    if (current !== null) {
      throw new Error(
        `Agent Deck: an Insights provider is already registered (${current.about.name} ` +
          `${current.about.version}); ${about.name} ${about.version} was refused.`,
      );
    }
    const typed = provider as InsightsProvider;
    let subscription: ProviderDisposable | null = null;
    try {
      subscription = typed.onDidChange(() => {
        if (this.#current?.provider === typed) this.#onChange();
      });
    } catch (error) {
      this.#report(error);
    }
    const registration: Registration = {
      provider: typed,
      about,
      rawOutput: rawOutput !== undefined,
      subscription,
    };
    this.#current = registration;
    this.#onChange();
    let released = false;
    return {
      dispose: () => {
        if (released) return;
        released = true;
        // Only THIS registration's disposable can clear it: a stale handle
        // from an earlier provider must not unregister the one after it.
        if (this.#current !== registration) return;
        this.#current = null;
        this.#running = false;
        try {
          registration.subscription?.dispose();
        } catch (error) {
          this.#report(error);
        }
        this.#onChange();
      },
    };
  }

  /** True while a provider is registered. */
  get registered(): boolean {
    return this.#current !== null;
  }

  /** The registered provider's about, as checked at registration, or `null`. */
  about(): InsightsProviderAbout | null {
    const current = this.#current;
    return current === null ? null : { ...current.about };
  }

  /**
   * `getLatest()` and `listRuns()`, checked and copied. A method that throws
   * reads as nothing and counts as one drop.
   */
  #read(current: Registration): { latest: FindingSetView | null; runs: RunSummary[]; dropped: number } {
    let dropped = 0;
    let latest: FindingSetView | null = null;
    try {
      const checked = viewOfFindingSet(current.provider.getLatest());
      latest = checked.value;
      dropped += checked.dropped;
    } catch (error) {
      dropped += 1;
      this.#report(error);
    }
    let runs: RunSummary[] = [];
    try {
      const checked = viewOfRuns(current.provider.listRuns());
      runs = checked.value;
      dropped += checked.dropped;
    } catch (error) {
      dropped += 1;
      this.#report(error);
    }
    return { latest, runs, dropped };
  }

  /**
   * What the Insights surface is told, or `null` in the free state.
   *
   * Calls `getLatest()` and `listRuns()` — two of the five members the parent
   * may call — and checks and copies what they return.
   */
  snapshot(): InsightsProviderSnapshot | null {
    const current = this.#current;
    if (current === null) return null;
    const { latest, runs, dropped } = this.#read(current);
    return {
      about: { ...current.about },
      latest,
      runs,
      running: this.#running,
      dropped,
      rawOutput: current.rawOutput && refusedRunIdOf(latest) !== null,
    };
  }

  /**
   * The latest refused run's raw output — DoD 9.40.
   *
   * Reads the latest set NOW, not from a snapshot a surface may still be
   * showing, and asks `getRawOutput` for that set's own `runId` alone. A
   * string over {@link RAW_OUTPUT_MAX_CHARS} is refused whole, never cut.
   */
  rawOutput(): RawOutputResult {
    const current = this.#current;
    if (current === null) return { ok: false, reason: 'no-provider' };
    if (!current.rawOutput) return { ok: false, reason: 'unsupported' };
    const { latest } = this.#read(current);
    const runId = refusedRunIdOf(latest);
    if (runId === null) return { ok: false, reason: 'no-run' };
    let text: unknown;
    try {
      text = (current.provider.getRawOutput as (id: string) => unknown).call(current.provider, runId);
    } catch (error) {
      this.#report(error);
      return { ok: false, reason: 'threw', runId };
    }
    if (text === null) return { ok: false, reason: 'none', runId };
    if (typeof text !== 'string') return { ok: false, reason: 'invalid', runId };
    if (text.length > RAW_OUTPUT_MAX_CHARS) {
      return { ok: false, reason: 'too-large', runId, length: text.length };
    }
    return { ok: true, runId, text };
  }

  /**
   * Run the provider once. A no-op with no provider, and while a run is
   * already in flight — one Run at a time, the same rule Insights keeps.
   */
  async run(): Promise<void> {
    const current = this.#current;
    if (current === null || this.#running) return;
    this.#running = true;
    this.#onChange();
    try {
      await current.provider.run();
    } catch (error) {
      this.#report(error);
    } finally {
      // Only if the SAME registration is still here: a provider that went
      // away mid-run already reset the flag and announced the free state.
      if (this.#current === current) {
        this.#running = false;
        this.#onChange();
      }
    }
  }

  /** Drop the registration, for deactivation. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const current = this.#current;
    this.#current = null;
    this.#running = false;
    try {
      current?.subscription?.dispose();
    } catch {
      // Shutting down; a throwing disposable must not block the rest.
    }
  }

  #report(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // A reporting sink that throws must not break what it reports on.
    }
  }
}

/**
 * Read a contract member of a provider: an own data property, or a method
 * the object has by class or prototype.
 *
 * `own` alone would refuse a provider written as a class instance, whose
 * methods live on its prototype — the natural way to write one. What this
 * refuses is a GETTER: an accessor would run the provider's code in the
 * middle of the check, so a member that is an accessor reads as absent.
 */
function readMember(provider: unknown, key: string): unknown {
  if (typeof provider !== 'object' || provider === null) return undefined;
  try {
    let target: object | null = provider;
    while (target !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor !== undefined) {
        return 'value' in descriptor ? (descriptor.value as unknown) : undefined;
      }
      target = Object.getPrototypeOf(target) as object | null;
      if (target === Object.prototype) return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
