/**
 * The Insights provider — extension API v2, v0.9.0 DoD 9.30 (spec `Amendment
 * 2026-09-21 — One window, Insights provider, Menu-only entry`).
 *
 * ## What changed, and why the parent stopped asking whether Insights is installed
 *
 * Until this delta the parent looked Insights up by extension id, asked
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
 * It reads `providerVersion` and `about` once, at registration. It calls
 * `getLatest()` and `listRuns()` to build a snapshot, `run()` when the user
 * presses Run, and subscribes to `onDidChange`. **It calls nothing else on
 * it**, and `insights-provider.test.ts` holds that with a provider wrapped in a
 * Proxy that records every property read.
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
 * it — enumerations against their lists, every other string against a strict
 * shape — and build a fresh object from the fields that passed. A value that
 * fails is DROPPED and COUNTED, never repaired (G3), and the count is shown
 * on the surface. **No raw model output crosses**: a finding is its kind, its
 * confidence and its numeric evidence, and the words the surface prints about
 * it are the parent's own.
 *
 * ## No `vscode` import
 *
 * Like `src/api.ts`: the event shape is structural, so this is testable in a
 * plain node process and a provider built against `vscode.Event<void>` fits.
 */

import type {
  FindingEvidenceView,
  FindingSetView,
  FindingView,
  InsightsConfidence,
  InsightsFindingKind,
  InsightsProviderAbout,
  InsightsProviderSnapshot,
  RunSummary,
} from './model/events.js';

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

export const RUN_OUTCOMES: readonly RunSummary['outcome'][] = Object.freeze(['findings', 'refused']);

export const AGENTS: readonly Exclude<FindingSetView['agent'], null>[] = Object.freeze([
  'claude',
  'codex',
]);

/** A run id. Short, and no character that means anything to a renderer. */
export const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * A path into the Layer 1 payload, the shape Insights' own validator accepts
 * — `sessions[0].totals.compactions` — with every segment bounded.
 */
export const STATS_KEY_PATTERN =
  /^sessions(?:\[(?:0|[1-9]\d{0,5})\]|\.[A-Za-z_][A-Za-z0-9_]{0,63}){1,12}$/;

/** A provider's display name. */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** A provider's version: `1.2.3`, optionally `-rc.1`. */
export const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[A-Za-z0-9.]{1,32})?$/;

/** Upper bounds, so a provider cannot make the panel draw without end. */
export const MAX_FINDINGS = 64;
export const MAX_EVIDENCE = 16;
export const MAX_RUNS = 50;

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
 * What another extension registers — spec `Amendment 2026-09-21`, verbatim in
 * shape. Every member is the parent's to READ; none is the parent's to write.
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
  if (!hasExactly(value, ['statsKey', 'value'])) return null;
  const statsKey = own(value, 'statsKey');
  const number = own(value, 'value');
  if (!matches(statsKey, STATS_KEY_PATTERN) || !isFiniteNumber(number)) return null;
  return { statsKey, value: number };
}

function viewOfFinding(value: unknown): FindingView | null {
  if (!hasExactly(value, ['kind', 'confidence', 'evidence'])) return null;
  const kind = own(value, 'kind');
  const confidence = own(value, 'confidence');
  const items = itemsOf(own(value, 'evidence'));
  if (!isOneOf(kind, FINDING_KINDS) || !isOneOf(confidence, CONFIDENCES)) return null;
  if (items === null || items.length === 0 || items.length > MAX_EVIDENCE) return null;
  const evidence: FindingEvidenceView[] = [];
  const keys = new Set<string>();
  for (const item of items) {
    const view = viewOfEvidence(item);
    // One bad piece of evidence drops the FINDING, not the evidence: a
    // finding shown with part of what it rests on is a partial render.
    if (view === null) return null;
    // The same stats key twice is either a repeat or two values for one
    // number, and neither is a finding to show (verifier round 9.33, D1).
    if (keys.has(view.statsKey)) return null;
    keys.add(view.statsKey);
    evidence.push(view);
  }
  return { kind, confidence, evidence };
}

/** A checked finding set, and how many values were dropped on the way. */
export interface Checked<T> {
  value: T;
  dropped: number;
}

/**
 * The latest finding set, checked and copied.
 *
 * The envelope must be whole: a set whose id, instant, agent or window fails
 * is dropped entirely (one drop) and the surface shows no latest set. Findings
 * are checked one by one, and each that fails is dropped and counted while
 * the rest are shown — the set is still the provider's statement about a
 * run, and the drop count beside it says it was not shown whole.
 */
export function viewOfFindingSet(value: unknown): Checked<FindingSetView | null> {
  if (value === null || value === undefined) return { value: null, dropped: 0 };
  const expected = ['runId', 'createdAt', 'agent', 'window', 'findings', 'findingsRejected'];
  if (!hasExactly(value, expected)) return { value: null, dropped: 1 };
  const runId = own(value, 'runId');
  const createdAt = own(value, 'createdAt');
  const agent = own(value, 'agent');
  const window = own(value, 'window');
  const findingsRejected = own(value, 'findingsRejected');
  const items = itemsOf(own(value, 'findings'));
  const sinceMs = own(window, 'sinceMs');
  const sessions = own(window, 'sessions');
  const envelopeOk =
    matches(runId, ID_PATTERN) &&
    isInstant(createdAt) &&
    (agent === null || isOneOf(agent, AGENTS)) &&
    hasExactly(window, ['sinceMs', 'sessions']) &&
    isInstant(sinceMs) &&
    isCount(sessions) &&
    isCount(findingsRejected) &&
    items !== null;
  if (!envelopeOk) return { value: null, dropped: 1 };
  const findings: FindingView[] = [];
  let dropped = 0;
  for (const item of items.slice(0, MAX_FINDINGS)) {
    const view = viewOfFinding(item);
    if (view === null) dropped += 1;
    else findings.push(view);
  }
  // Past the cap is not "invalid", and it is not shown either — so it is
  // counted, because a drop nobody can see is the silent partial render.
  dropped += Math.max(0, items.length - MAX_FINDINGS);
  return {
    value: {
      runId,
      createdAt,
      agent,
      window: { sinceMs, sessions },
      findings,
      findingsRejected,
    },
    dropped,
  };
}

function viewOfRun(value: unknown): RunSummary | null {
  if (!hasExactly(value, ['runId', 'createdAt', 'outcome', 'findings'])) return null;
  const runId = own(value, 'runId');
  const createdAt = own(value, 'createdAt');
  const outcome = own(value, 'outcome');
  const findings = own(value, 'findings');
  if (!matches(runId, ID_PATTERN) || !isInstant(createdAt)) return null;
  if (!isOneOf(outcome, RUN_OUTCOMES) || !isCount(findings)) return null;
  return { runId, createdAt, outcome, findings };
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
  readonly subscription: ProviderDisposable | null;
}

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
    const registration: Registration = { provider: typed, about, subscription };
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
   * What the Insights surface is told, or `null` in the free state.
   *
   * Calls `getLatest()` and `listRuns()` — two of the four members the parent
   * may call — and checks and copies what they return. A method that throws
   * reads as nothing and counts as one drop.
   */
  snapshot(): InsightsProviderSnapshot | null {
    const current = this.#current;
    if (current === null) return null;
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
    return { about: { ...current.about }, latest, runs, running: this.#running, dropped };
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
