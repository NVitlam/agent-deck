/**
 * Agent Deck — the host <-> webview transport (spec v2 section 6).
 *
 * Two halves, and they are asymmetric on purpose:
 *
 *   OUTBOUND  {@link SessionBridge} turns a `SessionEmission` from the session
 *             model into the exact wire messages of the contract. It owns one
 *             piece of state and only one: what the webview currently
 *             believes. Everything else it derives.
 *
 *   INBOUND   {@link isWebviewToHostMessage} is an untrusted-input boundary,
 *             treated as hostilely as `listener.ts` treats a POST body. The
 *             webview is our own bundle today; the guard does not assume that,
 *             because the cost of assuming it is a crash in the extension host
 *             and the cost of not assuming it is thirty lines.
 *
 * This module deliberately does NOT import `vscode`. The output port is a
 * one-method interface ({@link HostToWebviewPort}) so the whole class is unit
 * testable in a node suite; `src/extension.ts` adapts `webview.postMessage`.
 *
 * G1: nothing here writes anything. G5: nothing here opens a socket — the only
 * "transport" is a function call into a port supplied by the caller.
 * G7: all state is instance state and dies with the panel.
 */

import type {
  DegradedMessage,
  HostToWebviewMessage,
  SessionState,
  WebviewToHostMessage,
} from '../model/events.js';
import type { SessionEmission } from '../model/session.js';
import { applySessionPatch } from './apply.js';

// ---------------------------------------------------------------------------
// (a) Inbound — the untrusted boundary
// ---------------------------------------------------------------------------

/**
 * Keys rejected outright when present as OWN properties of an inbound message.
 *
 * None of them appears in the message contract, so nothing legitimate loses
 * anything. The reason to reject rather than ignore is that a message shaped
 * `{"type":"expandNode","__proto__":{...}}` is not a message — it is an
 * attempt, and the honest response to an attempt is a rejection a counter can
 * see, not a silent partial accept.
 *
 * Ignoring them would in fact also be safe here: every field read below goes
 * through `getOwnPropertyDescriptor`, so no inherited value is ever read and
 * no assignment is ever made from inbound data. Rejection is the second layer,
 * not the only one.
 */
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

/**
 * The three message types the webview may send. Anything else is rejected.
 *
 * This list is an allow-list, so it covers new OUTBOUND state without being
 * touched. `SessionState.parked` is a case worth naming: it travels host ->
 * webview inside `snapshot` and `diff` only, and the webview has no message
 * that carries it back. Teaching this guard to parse a parked graft would add
 * an inbound grammar for a message that does not exist — surface, not safety —
 * so what is asserted in `messages.test.ts` instead is that a parked payload
 * arriving from the webview side is still rejected on the type, and that an
 * otherwise valid message carrying a stray `parked` key is accepted exactly as
 * any other unread extra key already is.
 */
export const WEBVIEW_TO_HOST_TYPES = [
  'expandNode',
  'selectSession',
  // DoD 5.5.2, and the ONE addition v0.5.0 permits. `reason` is free text
  // bounded by RESYNC_REASON_MAX_CHARS below; `failedOp` must be one of the
  // op names `TreeOp` defines, so an unbounded string cannot reach a log line
  // through it; `sessionId` is optional because a diff for an unknown session
  // has no session state to name.
  'resyncRequest',
] as const;

/**
 * The `TreeOp['op']` values a `resyncRequest` may name.
 *
 * A literal list rather than a derived one, because `TreeOp` is a type and
 * types are erased: a runtime guard over untrusted input cannot ask a type
 * what its members are. `messages.test.ts` asserts this list equals the ops
 * `diffSessionState` can actually emit, so the duplication is checked rather
 * than trusted — the same treatment `canvas-contract.test.ts` gives the
 * host<->webview names.
 */
export const RESYNC_FAILED_OPS = [
  'replaceRoot',
  'replaceNode',
  'insertNode',
  'removeNode',
  'reorderChildren',
  'updateAgent',
  'updateTool',
] as const;

/**
 * Ceiling on a `resyncRequest`'s `reason`.
 *
 * The renderer composes this string and the host writes it to a diagnostics
 * channel. An unbounded string from the untrusted side reaching a log is how a
 * log becomes a denial-of-service surface, so it is bounded at the guard
 * rather than at the writer — one place, before anything reads it.
 */
export const RESYNC_REASON_MAX_CHARS = 200;

/**
 * Read an own data property without ever invoking a getter.
 *
 * Descriptor-based rather than `obj[key]` for one reason: an accessor property
 * whose getter throws would otherwise take the guard — and therefore the
 * message handler — down. An accessor is not a JSON shape, so it is treated as
 * absent, which makes the enclosing message invalid.
 */
function ownDataProperty(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) return undefined;
  return descriptor.value;
}

/** A non-empty own string property, or undefined. Never throws. */
function ownNonEmptyString(source: object, key: string): string | undefined {
  const value = ownDataProperty(source, key);
  if (typeof value !== 'string') return undefined;
  return value.length > 0 ? value : undefined;
}

/**
 * True only for a well-formed `expandNode` or `selectSession` message.
 *
 * Never throws, for any input at all: arrays, `null`, primitives, functions,
 * objects with throwing getters, objects with a poisoned prototype, and
 * Proxies with throwing traps are all `false` rather than an exception. Nothing
 * is coerced — a numeric `sessionId` is a rejection, not a `String(...)` call —
 * and nothing is mutated, on the argument or anywhere else.
 *
 * An empty-string id is rejected: it can address no session and no node, so
 * accepting it would push the failure into a lookup somewhere quieter.
 */
export function isWebviewToHostMessage(
  value: unknown,
): value is WebviewToHostMessage {
  try {
    if (typeof value !== 'object' || value === null) return false;
    if (Array.isArray(value)) return false;

    for (const key of FORBIDDEN_KEYS) {
      if (Object.prototype.hasOwnProperty.call(value, key)) return false;
    }

    const type = ownNonEmptyString(value, 'type');
    if (type === undefined) return false;

    switch (type) {
      case 'expandNode':
        return (
          ownNonEmptyString(value, 'sessionId') !== undefined &&
          ownNonEmptyString(value, 'nodeId') !== undefined
        );
      case 'selectSession':
        return ownNonEmptyString(value, 'sessionId') !== undefined;
      case 'resyncRequest': {
        const reason = ownNonEmptyString(value, 'reason');
        if (reason === undefined || reason.length > RESYNC_REASON_MAX_CHARS) return false;
        const failedOp = ownDataProperty(value, 'failedOp');
        if (failedOp !== undefined) {
          if (typeof failedOp !== 'string') return false;
          if (!(RESYNC_FAILED_OPS as readonly string[]).includes(failedOp)) return false;
        }
        const sessionId = ownDataProperty(value, 'sessionId');
        if (sessionId !== undefined) {
          if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
        }
        return true;
      }
      default:
        return false;
    }
  } catch {
    // Only reachable through a Proxy with a throwing trap. Reaching it means
    // the input was hostile, which is exactly the answer `false` gives.
    return false;
  }
}

// ---------------------------------------------------------------------------
// (b) Outbound — SessionBridge
// ---------------------------------------------------------------------------

/**
 * The narrow slice of a VS Code webview this module needs.
 *
 * `vscode.Webview.postMessage` returns a `Thenable<boolean>`; the return value
 * is ignored here because a `false` from it means the panel is disposed, which
 * the host learns from `onDidDispose` rather than from a send.
 */
export interface HostToWebviewPort {
  postMessage(message: HostToWebviewMessage): void;
}

/** The hook tap's health, structurally identical to `liveness.DegradedState`. */
export interface BridgeDegradedState {
  degraded: boolean;
  reason?: DegradedMessage['reason'];
}

/** Diagnostics. Counters, never thrown exceptions — the G3 habit. */
export interface SessionBridgeCounters {
  snapshotsSent: number;
  diffsSent: number;
  schemaMismatchesSent: number;
  degradedSent: number;
  /**
   * Snapshots sent where a diff round was available but abandoned. A healthy
   * session climbs `diffsSent` and leaves this alone; a number that tracks
   * `diffsSent` means the diff path is not working.
   */
  snapshotsForced: number;
  /** Diffs abandoned because {@link applySessionPatch} threw. */
  patchFailures: number;
  /** Diffs naming a session the webview has never been sent. Always a bug. */
  unknownSessionDiffs: number;
  /** Sends the port threw on. The next publish re-snapshots. */
  postFailures: number;
}

function zeroCounters(): SessionBridgeCounters {
  return {
    snapshotsSent: 0,
    diffsSent: 0,
    schemaMismatchesSent: 0,
    degradedSent: 0,
    snapshotsForced: 0,
    patchFailures: 0,
    unknownSessionDiffs: 0,
    postFailures: 0,
  };
}

/**
 * Turns session-model emissions into wire messages for one webview.
 *
 * The invariants, in the order they matter:
 *
 * 1. The first message a fresh webview receives is a full `snapshot`. The
 *    webview is a pure renderer with no persistence, so it starts knowing
 *    nothing and cannot be patched from there.
 * 2. A `diff` is only ever sent for a session the webview has already been
 *    sent. A diff for an unknown session is a bug, not a bandwidth saving, so
 *    an added or removed session forces a fresh snapshot instead.
 * 3. Before a diff goes out it is APPLIED, here, against the state this bridge
 *    last sent. `applySessionPatch` is the same reducer the webview runs, so
 *    what this class holds is the webview's belief computed the webview's way,
 *    not the model's next state assumed to be equal to it. If applying throws
 *    — `applySessionPatch`'s own doc names the extension host as the caller
 *    that must catch it — the whole diff round is abandoned and a snapshot is
 *    sent, so a patch-producer bug costs bandwidth instead of correctness.
 * 4. `degraded` is sent on transition only (spec C4: no nagging).
 *
 * Consequence of (3) worth stating: a session the model changed but produced
 * no diff for leaves this bridge's copy stale, and the NEXT patch against it
 * very likely fails to apply — surfacing as a forced snapshot and a counter,
 * rather than as a webview quietly rendering the wrong tree.
 */
export class SessionBridge {
  private readonly port: HostToWebviewPort;

  /** What the webview believes, keyed by session id. Empty = knows nothing. */
  private readonly sent = new Map<string, SessionState>();

  /** False until a snapshot has actually left the port. */
  private snapshotSent = false;

  /**
   * Last degraded state acknowledged by a send. Undefined means "the webview
   * has never been told", which is the state after construction and after
   * {@link reset}.
   */
  private lastDegraded?: BridgeDegradedState;

  private readonly counts: SessionBridgeCounters = zeroCounters();

  constructor(port: HostToWebviewPort) {
    this.port = port;
  }

  /** A copy of the counters. Callers cannot mutate the bridge through it. */
  get counters(): SessionBridgeCounters {
    return { ...this.counts };
  }

  /** Session ids the webview currently holds. Diagnostic surface. */
  get knownSessionIds(): readonly string[] {
    return [...this.sent.keys()];
  }

  /**
   * Forget everything the webview was told.
   *
   * Call this when the webview is (re)loaded: VS Code re-runs the bundle on
   * visibility restore and the new document holds nothing. After a reset the
   * next {@link publish} sends a snapshot and the next {@link publishDegraded}
   * sends its message even if the value is unchanged, because "unchanged" is a
   * statement about a webview that no longer exists.
   */
  reset(): void {
    this.sent.clear();
    this.snapshotSent = false;
    this.lastDegraded = undefined;
  }

  /**
   * Publish one emission: a `snapshot` or a run of `diff`s, then one
   * `schemaMismatch` per newly refused session.
   *
   * Mismatches are sent last so the webview always knows the session before it
   * is told the session is unsupported.
   */
  publish(emission: SessionEmission): void {
    const structureChanged =
      emission.addedSessionIds.length > 0 ||
      emission.removedSessionIds.length > 0;

    let unknownSessionDiff = false;
    for (const diff of emission.diffs) {
      if (!this.sent.has(diff.sessionId)) {
        unknownSessionDiff = true;
        this.counts.unknownSessionDiffs += 1;
      }
    }

    if (!this.snapshotSent || structureChanged || unknownSessionDiff) {
      this.sendSnapshot(emission, this.snapshotSent);
      this.sendMismatches(emission);
      return;
    }

    // Dry run first: every patch is applied before any of them is sent, so a
    // failure on the third diff cannot leave the webview holding the first two.
    const applied = new Map<string, SessionState>();
    for (const diff of emission.diffs) {
      const previous = this.sent.get(diff.sessionId);
      if (previous === undefined) {
        // Unreachable: the loop above already forced a snapshot for this case.
        // Handled rather than asserted, because a silent `!` here would be the
        // bug this whole class exists to avoid.
        this.counts.unknownSessionDiffs += 1;
        this.sendSnapshot(emission, true);
        this.sendMismatches(emission);
        return;
      }
      let next: SessionState;
      try {
        // Divergence is a REPORT rather than a throw now, for the webview's
        // sake. The host's contract is the opposite and is unchanged: this
        // copy must never diverge from the model, so a single reported error
        // is treated exactly as the throw was - abandon the diff round and
        // re-snapshot. Passing no `onError` would silently accept a partial
        // apply here and leave this bridge's copy wrong, which is the one
        // thing it exists to prevent.
        let diverged = false;
        next = applySessionPatch(previous, diff.patch, {
          onError: () => {
            diverged = true;
          },
        });
        if (diverged) throw new Error('host-side apply diverged');
      } catch {
        this.counts.patchFailures += 1;
        this.sendSnapshot(emission, true);
        this.sendMismatches(emission);
        return;
      }
      applied.set(diff.sessionId, next);
    }

    for (const diff of emission.diffs) {
      const next = applied.get(diff.sessionId);
      if (next === undefined) continue;
      const ok = this.post({
        type: 'diff',
        sessionId: diff.sessionId,
        patch: diff.patch,
      });
      if (!ok) return;
      this.counts.diffsSent += 1;
      this.sent.set(diff.sessionId, next);
    }

    this.sendMismatches(emission);
  }

  /**
   * Tell the webview whether the hook tap is healthy. Sends only on change.
   *
   * G2 in message form: this says nothing about any session's content, and a
   * content failure never reaches it.
   */
  publishDegraded(state: BridgeDegradedState): void {
    const previous = this.lastDegraded;
    if (
      previous !== undefined &&
      previous.degraded === state.degraded &&
      previous.reason === state.reason
    ) {
      return;
    }

    const message: DegradedMessage = {
      type: 'degraded',
      degraded: state.degraded,
    };
    // `reason` is documented as absent when not degraded; carrying a stale one
    // would let the webview render "degraded: no" next to a reason for it.
    if (state.degraded && state.reason !== undefined) {
      message.reason = state.reason;
    }

    if (!this.post(message)) return;
    this.counts.degradedSent += 1;
    this.lastDegraded =
      message.reason === undefined
        ? { degraded: message.degraded }
        : { degraded: message.degraded, reason: message.reason };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * Send the whole session set and adopt it as the baseline.
   *
   * `forced` distinguishes the unavoidable first snapshot from one sent because
   * the diff path could not be used.
   */
  private sendSnapshot(emission: SessionEmission, forced: boolean): void {
    const sessions = [...emission.sessions];
    if (!this.post({ type: 'snapshot', sessions })) return;

    this.counts.snapshotsSent += 1;
    if (forced) this.counts.snapshotsForced += 1;
    this.snapshotSent = true;
    this.sent.clear();
    for (const session of sessions) this.sent.set(session.sessionId, session);
  }

  private sendMismatches(emission: SessionEmission): void {
    for (const sessionId of emission.schemaMismatchSessionIds) {
      if (!this.post({ type: 'schemaMismatch', sessionId })) return;
      this.counts.schemaMismatchesSent += 1;
    }
  }

  /**
   * Hand one message to the port.
   *
   * Returns false when the port threw. A throw means the webview did NOT
   * receive the message, so the baseline must not advance and the bridge has to
   * assume the webview's state is unknown — the next publish sends a snapshot.
   * Swallowing the throw is deliberate: a disposed panel must not take the
   * extension host down.
   */
  private post(message: HostToWebviewMessage): boolean {
    try {
      this.port.postMessage(message);
      return true;
    } catch {
      this.counts.postFailures += 1;
      this.snapshotSent = false;
      this.sent.clear();
      this.lastDegraded = undefined;
      return false;
    }
  }
}
