/**
 * Agent Deck — the diagnostics channel (PLAN.md Phase 5.5, DoD 5.5.3).
 *
 * WHY THIS EXISTS, in one measurement. `AUDIT-2026-08-27` §7.2 went looking
 * for what the shipped `0.1.2` recorded about a defect its own author had
 * reported, on the machine it happened on, within hours. It found **two
 * lines** in the extension-host log, both `_doActivateExtension`, and nothing
 * else anywhere: no output channel, no persisted hook log, no counters. For a
 * product whose entire promise is "see what is happening right now", the field
 * report could only ever be answered from memory.
 *
 * So this module is not instrumentation added for tidiness. It is the surface
 * that makes the next report answerable.
 *
 * WHAT IT IS NOT
 * --------------
 *   - **Not egress (G5).** A channel is a VS Code UI object. Nothing here
 *     opens a socket, resolves a name, or formats a URL.
 *   - **Not persistence (G7).** This module writes no file. VS Code keeps its
 *     own log of an output channel and that is the editor's business, not a
 *     store this extension reads back — nothing here ever reads a line it
 *     wrote.
 *   - **Not a nag.** The channel is created lazily on the first line and is
 *     **never revealed on its own**. `show()` happens only from the
 *     `agentDeck.showDiagnostics` command, i.e. only when a human asks.
 *
 * THE `vscode` SEAM. This file imports nothing. The channel arrives as a
 * factory, for the same reason `HostLogger` is injected in `extension.ts`: the
 * test double in `test/vscode-mock.ts` has no `createOutputChannel`, and a
 * module that reached for one would make everything downstream of it
 * untestable outside the editor.
 */

/**
 * The slice of `vscode.OutputChannel` this module uses.
 *
 * Three methods, named structurally rather than imported, so the real channel
 * satisfies it without this file knowing that `vscode` exists.
 */
export interface DiagnosticsSink {
  appendLine(line: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

/** Created on the first line, never at construction. See {@link DiagnosticsChannel}. */
export type DiagnosticsSinkFactory = () => DiagnosticsSink;

/**
 * The channel's name, in one place.
 *
 * `manifest.test.ts` and `extension.test.ts` both read it rather than spelling
 * it, because two agreeing literals is the defect `src/bridge/contract.ts`
 * exists to prevent and this is the same shape of fact.
 */
export const DIAGNOSTICS_CHANNEL_NAME = 'Agent Deck';

/** The command that reveals the channel. Must equal the manifest's id. */
export const SHOW_DIAGNOSTICS_COMMAND = 'agentDeck.showDiagnostics';

/** How often the counters line is written, in ms. DoD 5.5.3 says 60 s. */
export const COUNTERS_INTERVAL_MS = 60_000;

/**
 * Everything the counters line reports, per engine where the engine has one.
 *
 * A flat record rather than a class: the host owns every one of these numbers
 * already, in `DataPathDiagnostics`, `BridgeCounters`, `PanelCounters` and the
 * parser's own counters. This type is the *shape of the line*, and the host
 * assembles it at write time from whatever is authoritative then. Copying the
 * numbers into this module and updating them incrementally would create a
 * second account of the same facts, which is how two counters that describe
 * one thing start disagreeing.
 */
export interface DiagnosticsCounters {
  /** Whole-session grafts attempted, by the CC engine. */
  grafts: number;
  /** Grafts that returned `ok: false` — a G3 refusal. */
  graftRefusals: number;
  /** Grafts that threw. Should stay 0. */
  graftErrors: number;
  /** Lines the parser counted as malformed and skipped. */
  malformedLines: number;
  /** Unknown fields tolerated by the parser (G9: unknown fields are fine). */
  unknownFields: number;
  /** `diff` messages put on the wire. */
  patchesSent: number;
  /** Patches this host applied to its own copy before sending. */
  patchesApplied: number;
  /** Patches whose host-side apply diverged, forcing a snapshot. */
  patchesFailed: number;
  /** `resyncRequest` messages received from the webview. */
  resyncs: number;
  /** OpenCode sessions currently observed. */
  opencodeSessions: number;
  /** Claude Code sessions currently observed. */
  ccSessions: number;
}

/**
 * The events that each produce exactly one line.
 *
 * A closed union rather than a free-form `log(string)`, because DoD 5.5.3 says
 * "every listed event emits exactly one line" and that is only assertable if
 * the events are enumerable. A test can then walk this union instead of
 * trusting a reviewer to have found every call site.
 */
export type DiagnosticsEvent =
  | { kind: 'sessionDiscovered'; sessionId: string; engine: 'cc' | 'opencode' }
  | { kind: 'sessionRemoved'; sessionId: string; engine: 'cc' | 'opencode' }
  | { kind: 'engineDegraded'; engine: 'cc' | 'opencode'; reason: string }
  | { kind: 'sessionRefused'; sessionId: string; engine: 'cc' | 'opencode'; code: string }
  /**
   * A graft that came back `ok: false` — WITH THE REASON.
   *
   * F2, 2026-08-31. Until this existed, the designed G3 refusal path recorded
   * only `graftRefusals=N` on the counters line. A graft that THREW kept its
   * message in `lastGraftError` and surfaced it; a graft that REFUSED — the
   * common case, and the one the whole fingerprint exists to produce — threw
   * its `mismatch` away. `docs/evidence/release-0.5.0/DRIFT-2.1.251.md` §1 is
   * the incident: `graftRefusals` was read as "the CC adapter is broken on
   * 2.1.251", the real cause was one teleported transcript stamped
   * `version: "1.0"`, and recovering that took bundling the fingerprint
   * out-of-tree and running it by hand. The counter pointed at the wrong
   * engine, the wrong version and the wrong subsystem.
   *
   * **EVERY FIELD IS A NAME, A TYPE, A VERSION OR A LINE NUMBER. NONE IS A
   * VALUE FROM A TRANSCRIPT.** That is the contract, not a convention:
   *
   *   - `code`     a {@link MismatchCode}, a closed set of our own literals.
   *   - `field`    the name of the field that failed. Never its content.
   *   - `expected` / `actual`  a TYPE (`string`, `null`, `array`) or a VERSION
   *     string. `fingerprint.ts` builds `actual` from `describeType()` for a
   *     type failure and from the `version` field for a version failure, and
   *     `version` is CC's own release number, not user content.
   *   - `at`       `<basename>:<line>` — see {@link formatEvent}.
   *
   * `reason` is deliberately NOT carried. It is the one free-text field on a
   * mismatch, and free text is the door content walks through.
   */
  | {
      kind: 'graftRefused';
      sessionId: string;
      engine: 'cc' | 'opencode';
      code: string;
      /** `<basename>:<line>`, already reduced. Absent when the mismatch had no path. */
      at?: string;
      field?: string;
      expected?: string;
      actual?: string;
    }
  | { kind: 'hookListenerError'; detail: string }
  | { kind: 'hookNon2xx'; status: number; detail: string }
  | { kind: 'patchFailure'; sessionId: string; detail: string }
  | { kind: 'resyncRequest'; sessionId: string; reason: string; failedOp?: string };

/** Every `kind` above, as data, so a test can assert the switch is total. */
export const DIAGNOSTICS_EVENT_KINDS: readonly DiagnosticsEvent['kind'][] = [
  'sessionDiscovered',
  'sessionRemoved',
  'engineDegraded',
  'sessionRefused',
  'graftRefused',
  'hookListenerError',
  'hookNon2xx',
  'patchFailure',
  'resyncRequest',
];

/**
 * Ceiling on any single free-text field reaching a line.
 *
 * `reason` and `detail` can originate in the renderer (`resyncRequest`) or in
 * an error message from a dependency, and neither is this module's to trust.
 * `messages.ts` already bounds the renderer's `reason` at its guard; this is
 * the second bound, at the writer, because a log that can be made arbitrarily
 * large by a party on the other side of a boundary is a denial-of-service
 * surface rather than a diagnostic.
 */
export const MAX_DETAIL_CHARS = 200;

function clip(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ');
  return flat.length <= MAX_DETAIL_CHARS ? flat : `${flat.slice(0, MAX_DETAIL_CHARS)}...`;
}

/**
 * The slice of a `FingerprintMismatch` this module reads.
 *
 * Structural, not imported. The module doc's "this file imports nothing" is
 * load-bearing — it is what lets `diagnostics.test.ts` pin the line format with
 * no host, no clock and no parser — and a mismatch is plain data, so naming its
 * shape costs nothing that importing the type would buy.
 */
export interface RefusalMismatch {
  code: string;
  path?: string;
  field?: string;
  expected?: string;
  actual?: string;
}

/**
 * Reduce a mismatch's `path` to `<basename>:<line>`.
 *
 * **THE ABSOLUTE PATH DOES NOT GO IN THE CHANNEL**, and this is the whole
 * reason the function exists. `fingerprint.ts` builds `path` as
 * `<absolute transcript path>:<line>` — on Windows that begins
 * `C:\Users\<user>\`, which is the developer-identifier class
 * `scripts/privacy-sweep.mjs` hard-fails on, in a surface a user is invited to
 * copy into a bug report. The projects-root-relative form is no better: the
 * slug directory is itself an encoding of the whole workspace path.
 *
 * The basename is `<sessionId>.jsonl` or `agent-<agentId>.jsonl`. It is
 * generated by Claude Code, not by a user, and for a subagent transcript it
 * says something the `session=` field does not — which file of the session the
 * refusal is in.
 *
 * A `path` with no `:<line>` suffix (a directory-layout refusal, say) keeps its
 * basename and gains no line. A path that is only a dotted field name — the
 * shape `SchemaMismatch.path` also permits — has no separator, so it survives
 * whole, which is correct: a field path is not a filesystem path.
 */
export function refusalLocation(path: string | undefined): string | undefined {
  if (path === undefined || path === '') return undefined;
  // Split the line suffix off FIRST: a bare `:` is also the Windows drive
  // separator, so a right-hand split on a digit run is the only safe read.
  const lineMatch = /^(.*):(\d+)$/.exec(path);
  const file = lineMatch?.[1] ?? path;
  const line = lineMatch?.[2];
  const lastSep = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  const base = lastSep === -1 ? file : file.slice(lastSep + 1);
  if (base === '') return undefined;
  return line === undefined ? base : `${base}:${line}`;
}

/**
 * Build the {@link DiagnosticsEvent} for a refused graft.
 *
 * One place, so the host cannot assemble a slightly different line and the
 * redaction above cannot be skipped by a second call site.
 */
export function graftRefusedEvent(
  sessionId: string,
  engine: 'cc' | 'opencode',
  mismatch: RefusalMismatch,
): DiagnosticsEvent {
  const at = refusalLocation(mismatch.path);
  return {
    kind: 'graftRefused',
    sessionId,
    engine,
    code: mismatch.code,
    ...(at === undefined ? {} : { at }),
    ...(mismatch.field === undefined ? {} : { field: mismatch.field }),
    ...(mismatch.expected === undefined ? {} : { expected: mismatch.expected }),
    ...(mismatch.actual === undefined ? {} : { actual: mismatch.actual }),
  };
}

/**
 * Render one event as one line.
 *
 * Exported and pure so the format is testable without a channel, a clock or a
 * host. The timestamp is passed in for the same reason `liveness.ts` takes its
 * clock injected: a formatter that reads the wall clock cannot be pinned by a
 * test, and a diagnostics line nobody can pin is a line nobody can assert.
 */
export function formatEvent(event: DiagnosticsEvent, isoTime: string): string {
  switch (event.kind) {
    case 'sessionDiscovered':
      return `${isoTime} session discovered ${event.engine} ${event.sessionId}`;
    case 'sessionRemoved':
      return `${isoTime} session removed ${event.engine} ${event.sessionId}`;
    case 'engineDegraded':
      return `${isoTime} engine degraded ${event.engine} ${clip(event.reason)}`;
    case 'sessionRefused':
      return `${isoTime} session refused ${event.engine} ${event.sessionId} ${clip(event.code)}`;
    case 'graftRefused': {
      // Fixed `key=value` order, and an ABSENT field is omitted rather than
      // written as `field=` or `field=undefined`. An empty value reads as "we
      // looked and found nothing", which is a different claim from "the
      // mismatch did not carry this", and rule 18's class is exactly a run that
      // reports an absence as a result.
      const parts = [
        `engine=${event.engine}`,
        `session=${event.sessionId}`,
        `code=${clip(event.code)}`,
      ];
      if (event.at !== undefined) parts.push(`at=${clip(event.at)}`);
      if (event.field !== undefined) parts.push(`field=${clip(event.field)}`);
      if (event.expected !== undefined) parts.push(`expected=${clip(event.expected)}`);
      if (event.actual !== undefined) parts.push(`actual=${clip(event.actual)}`);
      return `${isoTime} graft refused ${parts.join(' ')}`;
    }
    case 'hookListenerError':
      return `${isoTime} hook listener error ${clip(event.detail)}`;
    case 'hookNon2xx':
      return `${isoTime} hook listener status ${String(event.status)} ${clip(event.detail)}`;
    case 'patchFailure':
      return `${isoTime} patch failure ${event.sessionId} ${clip(event.detail)}`;
    case 'resyncRequest':
      return (
        `${isoTime} resync requested ${event.sessionId} ` +
        `${event.failedOp ?? 'no-op'} ${clip(event.reason)}`
      );
  }
}

/** Render the periodic counters line. Pure, for the same reason. */
export function formatCounters(counters: DiagnosticsCounters, isoTime: string): string {
  return (
    `${isoTime} counters` +
    ` grafts=${String(counters.grafts)}` +
    ` graftRefusals=${String(counters.graftRefusals)}` +
    ` graftErrors=${String(counters.graftErrors)}` +
    ` malformedLines=${String(counters.malformedLines)}` +
    ` unknownFields=${String(counters.unknownFields)}` +
    ` patchesSent=${String(counters.patchesSent)}` +
    ` patchesApplied=${String(counters.patchesApplied)}` +
    ` patchesFailed=${String(counters.patchesFailed)}` +
    ` resyncs=${String(counters.resyncs)}` +
    ` cc=${String(counters.ccSessions)}` +
    ` opencode=${String(counters.opencodeSessions)}`
  );
}

export interface DiagnosticsChannelOptions {
  /** Creates the underlying channel. Called at most once, on the first line. */
  createSink: DiagnosticsSinkFactory;
  /** Injected clock. No `Date.now()` in this module (Amendment A2's rule). */
  now: () => number;
}

/**
 * A lazily-created, never-auto-shown diagnostics channel.
 *
 * "Lazily" is a real property and not an optimisation: creating an output
 * channel at activation puts an "Agent Deck" entry in the user's Output
 * dropdown on every window, for an extension that may have nothing to say.
 * The first line is what earns the entry.
 */
export class DiagnosticsChannel {
  readonly #createSink: DiagnosticsSinkFactory;
  readonly #now: () => number;
  #sink: DiagnosticsSink | undefined;
  #lines = 0;
  #disposed = false;

  constructor(options: DiagnosticsChannelOptions) {
    this.#createSink = options.createSink;
    this.#now = options.now;
  }

  /** Lines written since construction. Read by tests and by nothing else. */
  get lineCount(): number {
    return this.#lines;
  }

  /** True once a sink has been created. False until the first line. */
  get opened(): boolean {
    return this.#sink !== undefined;
  }

  /** One event, one line. */
  record(event: DiagnosticsEvent): void {
    this.#write(formatEvent(event, this.#stamp()));
  }

  /** The periodic counters line. */
  recordCounters(counters: DiagnosticsCounters): void {
    this.#write(formatCounters(counters, this.#stamp()));
  }

  /**
   * Reveal the channel. The ONLY path that shows it, and it is reachable only
   * from the `agentDeck.showDiagnostics` command.
   *
   * Writes a line first when nothing has been written yet, so a user who runs
   * the command on a quiet window gets a channel that exists and says so,
   * rather than a command that appears to do nothing.
   */
  show(): void {
    if (this.#disposed) return;
    if (this.#sink === undefined) {
      this.#write(`${this.#stamp()} diagnostics opened; nothing recorded yet`);
    }
    this.#sink?.show(true);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#sink?.dispose();
    } catch {
      // A channel that throws on dispose must not block the rest of teardown.
    }
    this.#sink = undefined;
  }

  #stamp(): string {
    return new Date(this.#now()).toISOString();
  }

  #write(line: string): void {
    if (this.#disposed) return;
    if (this.#sink === undefined) {
      try {
        this.#sink = this.#createSink();
      } catch {
        // G2: a channel that cannot be created must not take the data path
        // down. The counter still moves, so "diagnostics are not reaching the
        // user" is itself observable from `lineCount` against an empty
        // channel.
        this.#lines += 1;
        return;
      }
    }
    this.#lines += 1;
    try {
      this.#sink.appendLine(line);
    } catch {
      // Same reasoning: writing a diagnostic must never be the thing that
      // breaks the session being diagnosed.
    }
  }
}
