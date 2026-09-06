/**
 * Agent Deck — the shared-listener relay protocol (PLAN.md v0.7.0 Phase 1b).
 *
 * WHY THIS EXISTS, in one defect. `agentDeck.port` is a FIXED port, and it has
 * to be: the hook snippet the user pastes names the number literally and there
 * is no discovery file to tell it otherwise (writing one would violate G1). So
 * the first VS Code window binds it and every later window takes `EADDRINUSE`
 * and loses liveness ENTIRELY — not degraded, not partial, gone — while the
 * user is looking at a deck that says nothing is running. One port, many
 * windows, and the port cannot be per-window.
 *
 * The answer the user locked on 2026-09-06 is leader/follower arbitrated by
 * the OS itself: whoever binds first is the leader and serves the other
 * windows over the SAME socket; a window that cannot bind asks who is there
 * and attaches. There is no election protocol, no lock file and no discovery
 * file — `bind()` is the election, and the kernel runs it.
 *
 * THIS MODULE IS THE PURE HALF. It holds the wire shapes, the redaction the
 * leader applies BEFORE anything crosses the relay, and the ownership filter
 * each follower applies to what it receives. It opens no socket and reads no
 * clock, so every rule below is assertable without a server.
 *
 * Grounding contract obligations that live here:
 *
 *   G4 redaction : {@link redactHookPayload} runs at the LEADER, before a byte
 *                  reaches `/agent-deck/events`. The relay never carries a raw
 *                  body. Telemetry does not travel as a body at all — see
 *                  {@link RelayEnvelope}.
 *   G5 loopback  : nothing here formats a URL or names a host. The one address
 *                  in this design is `HookListener`'s hard-coded literal, and
 *                  the follower reaches for that same constant.
 *   G3 refuse    : every decoder is total. A frame that is not ours is
 *                  `undefined`, never a throw and never a guess.
 */

import type { JsonValue } from '../model/events.js';
import type { OtelSignal, TelemetrySlice } from '../otel/parse.js';
import { redactJson } from '../parser/redact-core.js';

// ---------------------------------------------------------------------------
// Identity — "is the thing on my port one of us?"
// ---------------------------------------------------------------------------

/**
 * The product name a leader answers with.
 *
 * A CONSTANT AND NOT A GUESS is the whole point of the identity route. A
 * window taking `EADDRINUSE` knows only that *something* holds the port. It
 * could be another Agent Deck window; it could equally be a dev server, a
 * debugger, or a process the user would be alarmed to learn we had started
 * streaming hook payloads at. The follower path opens only when the thing on
 * the port says these three fields back; anything else — a timeout, a 404, an
 * HTML page, a JSON object from a different product — keeps the refusal that
 * ships today. A stranger on the port is still a stranger.
 */
export const RELAY_PRODUCT = 'agent-deck';

/**
 * The relay wire version.
 *
 * Bumped when an envelope shape changes in a way an older follower would
 * misread. A follower refuses a version it does not know rather than reading
 * the fields it recognises out of it — the same "refuse, don't guess" rule the
 * schema fingerprint applies to a transcript (G3). Two Agent Deck versions
 * running side by side is an ORDINARY state, not a corner case: the user
 * updates the extension and one window has not been reloaded yet.
 */
export const RELAY_API_VERSION = 1;

/** Where a leader answers {@link identityBody}. */
export const IDENTITY_PATH = '/agent-deck/identity';

/** Where a leader streams {@link RelayEnvelope} frames, as SSE. */
export const EVENTS_PATH = '/agent-deck/events';

/** The identity document, exactly as the locked block writes it. */
export interface RelayIdentity {
  product: typeof RELAY_PRODUCT;
  apiVersion: number;
  role: 'leader';
}

/** The body a leader serves on {@link IDENTITY_PATH}. */
export function identityBody(): RelayIdentity {
  return { product: RELAY_PRODUCT, apiVersion: RELAY_API_VERSION, role: 'leader' };
}

/**
 * True only for the exact reply the locked block names.
 *
 * Deliberately strict on all three fields. `role` is checked even though a
 * leader is the only thing that serves this route today: the field exists so a
 * future non-leader responder cannot be mistaken for one by a follower that
 * only looked at `product`.
 *
 * Never throws, for any input, including one that is not an object at all —
 * this is fed whatever a stranger on the port chose to send.
 */
export function isLeaderIdentity(value: unknown): value is RelayIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    body['product'] === RELAY_PRODUCT &&
    body['apiVersion'] === RELAY_API_VERSION &&
    body['role'] === 'leader'
  );
}

// ---------------------------------------------------------------------------
// The envelopes
// ---------------------------------------------------------------------------

/**
 * One relayed hook payload.
 *
 * `payload` is the REDACTED payload object, not a `NormalizedHookEvent`: the
 * follower runs `normalizeHookEvent` (and the Codex discriminator) itself, so
 * it applies the same downstream pipeline it would have applied to a payload
 * that arrived on its own socket. Relaying the normalized form instead would
 * have carried the leader's `seq` and the leader's `receivedAt` into another
 * window's accounting, where they mean nothing.
 */
export interface RelayHookEnvelope {
  v: number;
  kind: 'hook';
  payload: JsonValue;
}

/**
 * One relayed telemetry slice (Component 12).
 *
 * **A SLICE AND NOT A BODY, AND THAT IS THE STRONGEST FORM AVAILABLE HERE.**
 * The obvious design relays the OTLP body and lets each follower parse it —
 * and it would put every attribute Claude Code exports onto the relay,
 * including the five identity attributes (`user.email`, `user.id`,
 * `user.account_id`, `user.account_uuid`, `organization.id`) that DoD 1.9b
 * drops at the parse boundary, which occur on 850 of 850 records of
 * `fixtures/otel-cc-2.1.260/`. Redacting the body before relaying it would
 * work and would rest on a deny-list staying complete.
 *
 * `parseOtlpBody` already reduces a body to an ALLOW-LIST
 * (`TELEMETRY_KEPT_KEYS`, five names), so relaying its output instead means no
 * OTLP byte crosses the relay at all and nothing outside those five names can,
 * even in principle, even if a future Claude Code adds an attribute nobody has
 * written a rule for. The parse boundary is the redaction, so relaying what is
 * on its far side is what "after its own parse-boundary redaction, never the
 * raw body" means when it is taken literally.
 *
 * The whole slice travels, counts included, so a follower's telemetry
 * accounting describes the bodies that reached this deck rather than only the
 * ones that happened to reach this window's socket.
 */
export interface RelayOtelEnvelope {
  v: number;
  kind: 'otel';
  signal: OtelSignal;
  slice: TelemetrySlice;
}

export type RelayEnvelope = RelayHookEnvelope | RelayOtelEnvelope;

/** Every `kind` above, as data, so a test can assert a decoder is total. */
export const RELAY_ENVELOPE_KINDS: readonly RelayEnvelope['kind'][] = ['hook', 'otel'];

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

/**
 * Encode one envelope as an SSE frame.
 *
 * One `data:` line and a blank line. `JSON.stringify` escapes every newline it
 * emits, so a frame is exactly two lines whatever the payload contains — which
 * is what lets the decoder split on a blank line instead of implementing the
 * multi-line `data:` accumulation the SSE grammar also permits. A payload that
 * could inject a newline could inject a frame boundary, and that is the class
 * of thing this comment exists to keep true.
 */
export function encodeSseFrame(envelope: RelayEnvelope): string {
  return `data: ${JSON.stringify(envelope)}\n\n`;
}

/**
 * Decode one SSE frame's `data:` payload into an envelope.
 *
 * Total: returns `undefined` for anything that is not a frame this version
 * understands — bad JSON, a missing `data:` prefix, an unknown `kind`, a
 * version this build does not speak. It never throws and it never repairs.
 */
export function decodeSseFrame(frame: string): RelayEnvelope | undefined {
  const line = frame.split('\n').find((l) => l.startsWith('data:'));
  if (line === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice('data:'.length).trim()) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const env = parsed as Record<string, unknown>;
  if (env['v'] !== RELAY_API_VERSION) return undefined;
  if (env['kind'] === 'hook') {
    if (!('payload' in env)) return undefined;
    return { v: RELAY_API_VERSION, kind: 'hook', payload: env['payload'] as JsonValue };
  }
  if (env['kind'] === 'otel') {
    const signal = env['signal'];
    if (signal !== 'metrics' && signal !== 'logs' && signal !== 'traces') return undefined;
    const slice = env['slice'];
    if (typeof slice !== 'object' || slice === null || Array.isArray(slice)) return undefined;
    return {
      v: RELAY_API_VERSION,
      kind: 'otel',
      signal,
      slice: slice as unknown as TelemetrySlice,
    };
  }
  return undefined;
}

/**
 * Split a stream buffer into complete frames, returning the unconsumed tail.
 *
 * A relayed frame arrives in whatever chunks the socket produced; a decoder
 * that assumed one chunk was one frame would work on a developer's machine and
 * drop events under load. The tail is returned rather than held in module
 * state so the split is pure and one follower's stream cannot perturb another.
 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf('\n\n');
    if (end === -1) break;
    frames.push(rest.slice(0, end));
    rest = rest.slice(end + 2);
  }
  return { frames, rest };
}

// ---------------------------------------------------------------------------
// Redaction at the leader (G4)
// ---------------------------------------------------------------------------

/**
 * Redact one hook payload for the relay.
 *
 * `redactJson` is the SAME walk the JSONL parse boundary uses, at the same
 * ceiling: every string in the tree cut to `previewBytes`, every thinking
 * block dropped, every `thinking` and `signature` field stripped, depth
 * bounded. It is reused rather than re-derived because a second redactor is a
 * second place for the first one's rules to stop being true.
 *
 * The uniform ceiling matters here more than it does on disk. A hook payload's
 * large field is `tool_input` today, and a whitelist would leak whichever
 * field Claude Code makes large next.
 */
export function redactHookPayload(payload: unknown, previewBytes: number): JsonValue {
  return redactJson(payload, { maxPayloadBytes: previewBytes }).value;
}

// ---------------------------------------------------------------------------
// The ownership filter (the FOLLOWER's, never the leader's)
// ---------------------------------------------------------------------------

/**
 * Normalise a filesystem path for containment comparison.
 *
 * Separators unified and case dropped: the drive letter's case varies on
 * Windows within one machine — this repository's own history carries both
 * `c--Users-...` and `C--Users-...` for one workspace — and a case-sensitive
 * compare silently finds nothing, which here would mean a window dropping its
 * own events.
 */
function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * True when `child` is `parent` or lies beneath it.
 *
 * The separator check is the load-bearing half and the reason this is not a
 * bare `startsWith`: `C:\work\agent-deck-lab` starts with `C:\work\agent-deck`
 * and is a DIFFERENT repository. A filter built on the prefix alone would hand
 * one window another window's sessions and look correct doing it.
 */
export function isPathUnder(child: string, parent: string): boolean {
  if (child === '' || parent === '') return false;
  const c = normalizePathForCompare(child);
  const p = normalizePathForCompare(parent);
  if (c === p) return true;
  return c.startsWith(`${p}/`);
}

/** What a follower needs to know to decide whether an event is its own. */
export interface OwnershipContext {
  /** True when this window is tailing a transcript for that session id. */
  tailsSession: (sessionId: string) => boolean;
  /** This window's workspace folders, absolute. */
  workspacePaths: readonly string[];
}

/**
 * Decide whether a relayed payload belongs to this window.
 *
 * **THE FILTER IS THE FOLLOWER'S AND THE LEADER RELAYS EVERYTHING.** The
 * leader does not know the other windows' workspaces and cannot be told
 * without a registration protocol whose only purpose would be moving a
 * decision to the party with less information. So the leader is a dumb pipe
 * and every window keeps what is its own.
 *
 * Two ways to own an event, and the disjunction is deliberate:
 *
 *   - the session is one this window is TAILING — the strong signal, and the
 *     only one available for a subagent event whose `cwd` is the agent's;
 *   - the `cwd` is under one of this window's workspace folders — which is
 *     what covers a session this window has not discovered yet, the ordinary
 *     state in the first seconds of a new session.
 *
 * A payload carrying neither is dropped. A payload carrying a `cwd` that is
 * not a string, or a `session_id` that is not a string, is not an error and is
 * not a guess — those keys are simply absent for the purpose of the decision
 * (G3), which is the same rule `normalizeHookEvent` applies to them.
 */
export function ownsRelayedPayload(payload: unknown, ctx: OwnershipContext): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const body = payload as Record<string, unknown>;

  const sessionId = body['session_id'];
  if (typeof sessionId === 'string' && sessionId !== '' && ctx.tailsSession(sessionId)) {
    return true;
  }

  const cwd = body['cwd'];
  if (typeof cwd === 'string' && cwd !== '') {
    for (const root of ctx.workspacePaths) {
      if (isPathUnder(cwd, root)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

/** What this window's role is, for diagnostics and for the deck's own health. */
export type RelayRole = 'leader' | 'follower' | 'refused' | 'idle';

/**
 * Relay accounting. In-memory and per-instance (G7).
 *
 * `relayed` and `received` are deliberately two numbers rather than one: on a
 * leader the first moves and the second does not, on a follower the reverse,
 * and a single "events" counter would make the two roles indistinguishable in
 * the one place a user looks to tell them apart.
 */
export interface RelayCounters {
  /** Followers currently subscribed. Leader only. */
  followers: number;
  /** Frames written to followers. Leader only. Counts frames, not sockets. */
  relayed: number;
  /** Frames received from a leader. Follower only. */
  received: number;
  /** Received frames this window dropped as another window's (1b.4). */
  droppedForeign: number;
  /** Frames that did not decode. A version skew or a stranger writing SSE. */
  undecodable: number;
  /** Times this window lost its leader and went back to the bind loop. */
  failovers: number;
  /** Bind attempts made by the failover loop. */
  rebindAttempts: number;
}

export function zeroRelayCounters(): RelayCounters {
  return {
    followers: 0,
    relayed: 0,
    received: 0,
    droppedForeign: 0,
    undecodable: 0,
    failovers: 0,
    rebindAttempts: 0,
  };
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/** Floor of the jittered rebind backoff, in ms. The locked block's number. */
export const REBIND_BACKOFF_MIN_MS = 100;
/** Ceiling of the jittered rebind backoff, in ms. The locked block's number. */
export const REBIND_BACKOFF_MAX_MS = 500;
/** Hard cap on rebind attempts before the window gives up and says so. */
export const REBIND_MAX_ATTEMPTS = 20;

/**
 * One jittered backoff delay.
 *
 * Jitter and not a fixed delay because the losers of a bind race retry
 * together: without it, N windows re-collide on the same tick forever. `random`
 * is injected for the same reason every clock in this repository is — a
 * scheduler nobody can pin is a scheduler no test can assert.
 */
export function backoffDelayMs(random: () => number): number {
  const span = REBIND_BACKOFF_MAX_MS - REBIND_BACKOFF_MIN_MS;
  const r = Math.min(Math.max(random(), 0), 1);
  return REBIND_BACKOFF_MIN_MS + Math.floor(r * span);
}

