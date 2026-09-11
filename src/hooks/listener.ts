/**
 * Agent Deck — loopback hook-event listener (spec v2 §C4).
 *
 * This is the liveness source: CC's user-installed hook snippet POSTs each hook
 * payload to this server, which normalizes it and hands it to consumers. It is
 * deliberately independent of the JSONL parser — a parse failure must never
 * take liveness down, and vice versa (G2).
 *
 * Grounding contract obligations enforced here:
 *
 *   G1 read-only  : this module imports no filesystem API and writes no file,
 *                   ever. Nothing under ~/.claude is opened at all. The spike
 *                   listener wrote a capture file; that was spike-only and is
 *                   deliberately not reproduced. A source-level test asserts
 *                   this file imports no fs module.
 *   G3 refuse     : malformed, oversize, non-JSON, non-object and wrongly-typed
 *                   bodies are counted and answered 4xx. Nothing about a
 *                   request body can stop the server serving the next request.
 *                   A consumer callback that throws is caught and counted.
 *   G5 zero egress: exactly one socket, bound to the literal 127.0.0.1. Never
 *                   the IPv4 wildcard, never a hostname that could resolve
 *                   off-loopback (a source-level test asserts the wildcard
 *                   address does not appear in this file at all).
 *                   The remote address is validated as loopback on EVERY
 *                   request; anything else is answered 403 and counted. Proxy
 *                   headers (X-Forwarded-For and friends) are never read.
 *   G7 in-memory  : counters and the sequence number live in the instance and
 *                   die with it. No persistence.
 *
 * Port policy: a fixed default ({@link DEFAULT_HOOK_PORT}), overridable by an
 * explicit option. Ephemeral binding (port 0) is refused, because the hook
 * snippet the user pastes names a fixed port and there is no discovery file to
 * tell it otherwise — writing one would violate G1. A port collision surfaces
 * as {@link HookListenerBindError}; the listener never silently rebinds.
 * The one exception is the TEST-ONLY {@link HookListenerOptions.allowEphemeralPort}
 * escape hatch, which no production module sets and a source-level test says so.
 */

import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  isConfirmedHookEventName,
  type NormalizedHookEvent,
  type RawHookPayload,
} from '../model/events.js';
import type { CodexHookEvent } from '../codex/liveness.js';
import { parseOtlpBody, type OtelSignal, type TelemetrySlice } from '../otel/parse.js';
import {
  EVENTS_PATH,
  IDENTITY_PATH,
  encodeSseFrame,
  identityBody,
  redactHookPayload,
  type RelayEnvelope,
} from './relay.js';

/**
 * The bind address. Hard-coded and deliberately not configurable (G5).
 * Changing this to anything else is a review failure, not a preference.
 */
export const HOOK_LISTENER_HOST = '127.0.0.1';

/** Fixed default port. The pasted hook snippet names this number literally. */
export const DEFAULT_HOOK_PORT = 47821;

/** Default request-body cap. Bodies above it are counted and answered 413. */
export const DEFAULT_MAX_BODY_BYTES = 512 * 1024;

/** Default path the hook snippet POSTs to. */
export const DEFAULT_EVENT_PATH = '/event';

/**
 * The Component 12 telemetry paths (v0.7.1 DoD 6.2), one per OTLP signal.
 *
 * Mounted on THIS socket and no other (locked ruling, 2026-09-10): the port is
 * `agentDeck.port`, the one the hook snippet already names, and a second
 * socket would reintroduce the discovery problem the fixed port exists to
 * avoid. The paths exist whether `agentDeck.telemetry.enabled` is on or off —
 * off, they answer `403` — so a user who pointed Claude Code here and forgot
 * the setting gets an answer that names the setting rather than a `404` that
 * reads like a wrong address.
 */
export const TELEMETRY_PATHS: Readonly<Record<OtelSignal, string>> = {
  metrics: '/v1/metrics',
  logs: '/v1/logs',
  traces: '/v1/traces',
};

/** The body of the `403` the telemetry paths answer while the setting is off. */
export const TELEMETRY_DISABLED_BODY = '{"error":"agentDeck.telemetry.enabled is false"}';

/**
 * The statuses a telemetry path refuses with, other than `403` (counted apart
 * as `disabled`). Every one is non-retryable ON PURPOSE (locked ruling): an
 * OTLP exporter retries a `429`/`503` with backoff, and a receiver that
 * answered one would turn a refusal into a standing stream of retries from
 * every Claude Code session on the machine. `503` is never returned.
 */
export type TelemetryRejectStatus = 400 | 405 | 413 | 415;

/** One telemetry path's accounting (v0.7.1 DoD 6.4). */
export interface TelemetryRouteCounts {
  /** Bodies parsed and published. The `200` answer. */
  accepted: number;
  /** Requests answered `403` because `agentDeck.telemetry.enabled` is off. */
  disabled: number;
  /** Requests refused, by status. */
  rejected: Record<TelemetryRejectStatus, number>;
}

/** Per signal. A snapshot when read through {@link HookListener.telemetryCounters}. */
export type TelemetryRouteCounters = Record<OtelSignal, TelemetryRouteCounts>;

function zeroTelemetryCounts(): TelemetryRouteCounts {
  return { accepted: 0, disabled: 0, rejected: { 400: 0, 405: 0, 413: 0, 415: 0 } };
}

function zeroTelemetryCounters(): TelemetryRouteCounters {
  return { metrics: zeroTelemetryCounts(), logs: zeroTelemetryCounts(), traces: zeroTelemetryCounts() };
}

/** Which signal a request path names, or undefined. A switch, not a lookup: no prototype key can match. */
function telemetrySignalOf(url: string): OtelSignal | undefined {
  switch (url) {
    case TELEMETRY_PATHS.metrics:
      return 'metrics';
    case TELEMETRY_PATHS.logs:
      return 'logs';
    case TELEMETRY_PATHS.traces:
      return 'traces';
    default:
      return undefined;
  }
}

/** A telemetry consumer. Registered via {@link HookListener.subscribeOtel}. */
export type OtelHandler = (signal: OtelSignal, slice: TelemetrySlice) => void;

/**
 * Multiple of the body cap at which a still-streaming request is destroyed
 * outright. Below it, an oversize body is drained and discarded so the 413
 * reaches the client cleanly; above it the socket is not worth holding open.
 */
const HARD_ABORT_MULTIPLE = 16;

/** Counters accumulated instead of throwing. Read via {@link HookListener.counters}. */
export interface HookListenerCounters {
  /** Payloads accepted, normalized and dispatched. */
  accepted: number;
  /**
   * Payloads routed to the CODEX handlers instead of the CC ones (DoD 3.1).
   *
   * A separate counter rather than folding into {@link accepted}: that one's
   * existing meaning, and every already-passing test that reads it, must not
   * change. A Codex payload never touches `accepted`, `normalizeHookEvent`,
   * `unconfirmedEventName` or `#seq` — those are CC's own accounting and a
   * second engine's traffic must not perturb them.
   */
  acceptedCodex: number;
  /** Accepted payloads whose `hook_event_name` is not a confirmed type. */
  unconfirmedEventName: number;
  /** Requests whose remote address was not loopback (G5). */
  droppedNonLoopback: number;
  /** Bodies that were not valid JSON. */
  malformedJson: number;
  /** Bodies that parsed but were not a JSON object (array, null, scalar). */
  notAnObject: number;
  /** Zero-length bodies. */
  emptyBody: number;
  /** Bodies exceeding the configured cap. */
  oversize: number;
  /** Requests carrying a Content-Type that is present and not JSON. */
  badContentType: number;
  /** Requests to a path other than the event path. */
  badRoute: number;
  /** Non-POST requests to the event path. */
  badMethod: number;
  /** Request/socket-level errors. */
  socketErrors: number;
  /** Benign: the hook process exits before its socket closes. */
  clientDisconnects: number;
  /** Consumer callbacks that threw. The listener keeps serving regardless. */
  handlerErrors: number;
  /**
   * Followers currently attached to {@link EVENTS_PATH} (Phase 1b).
   *
   * A GAUGE and not a total: it goes down when a window closes. Every other
   * number here only ever rises, so the difference is called out rather than
   * left for a reader to infer from a name.
   */
  relayFollowers: number;
  /** SSE frames written to followers. Frames, not sockets, not bytes. */
  relayFramesSent: number;
  /** Requests answered on {@link IDENTITY_PATH}. Each is one window asking who we are. */
  identityProbes: number;
}

function zeroCounters(): HookListenerCounters {
  return {
    accepted: 0,
    acceptedCodex: 0,
    unconfirmedEventName: 0,
    droppedNonLoopback: 0,
    malformedJson: 0,
    notAnObject: 0,
    emptyBody: 0,
    oversize: 0,
    badContentType: 0,
    badRoute: 0,
    badMethod: 0,
    socketErrors: 0,
    clientDisconnects: 0,
    handlerErrors: 0,
    relayFollowers: 0,
    relayFramesSent: 0,
    identityProbes: 0,
  };
}

/**
 * Why a listener could not bind. Explicit and typed: a port collision is a
 * condition the caller must surface to the user, never something the listener
 * papers over by picking a different port.
 */
export class HookListenerBindError extends Error {
  /** e.g. 'EADDRINUSE', 'EACCES', or 'EPORTINVALID' for a refused port. */
  readonly code: string;
  readonly port: number;
  readonly host: string;

  constructor(message: string, code: string, host: string, port: number) {
    super(message);
    this.name = 'HookListenerBindError';
    this.code = code;
    this.host = host;
    this.port = port;
  }
}

/** Narrowing guard so callers can branch without `instanceof` on a bundle boundary. */
export function isHookListenerBindError(
  value: unknown,
): value is HookListenerBindError {
  return value instanceof HookListenerBindError;
}

export type HookEventHandler = (event: NormalizedHookEvent) => void;

/**
 * A Codex hook-event consumer (DoD 3.1). Registered via {@link HookListener.subscribeCodex}.
 */
export type CodexHookEventHandler = (event: CodexHookEvent) => void;

/**
 * The wire key whose PRESENCE discriminates a Codex hook payload from a CC
 * one (spec/`docs/codex-contract.md` §A5): measured 160/160 Codex against
 * 0/305 CC, with a vacuity control against `cwd`/`hook_event_name`. Presence
 * is tested with `hasOwnProperty`, the same style {@link AGENT_ID_KEY} already
 * uses here — never by comparing the value, which is CC's own recorded
 * "main-thread" trap in a second costume.
 */
const CODEX_DISCRIMINATOR_KEY = 'model';

export interface HookListenerOptions {
  /** Defaults to {@link DEFAULT_HOOK_PORT}. Port 0 is refused, not honoured. */
  port?: number;
  /** Defaults to {@link DEFAULT_MAX_BODY_BYTES}. */
  maxBodyBytes?: number;
  /** Defaults to {@link DEFAULT_EVENT_PATH}. */
  eventPath?: string;
  /** Convenience: registered as if passed to {@link HookListener.subscribe}. */
  onEvent?: HookEventHandler;
  /**
   * TEST-ONLY affordance. Forces the perceived remote address of every
   * request, so the non-loopback rejection path can be exercised end-to-end
   * WITHOUT ever binding a non-loopback socket. Production callers must not
   * set this; it can only ever make the guard stricter or a test fail, it can
   * never widen what the socket accepts.
   */
  spoofRemoteAddress?: string;
  /**
   * TEST-ONLY affordance. Permits `port: 0` — an OS-assigned ephemeral port —
   * which the port policy above otherwise refuses. Read
   * {@link HookListener.address} afterwards to learn what was assigned.
   *
   * It exists because the alternative is worse. A test that probes for a free
   * port by binding port 0, reading the number and closing the probe hands out
   * a number that anything on the machine may take before the listener binds
   * it. That gap is a real race, and it made this repo's suite intermittently
   * red with `EADDRINUSE`. Binding port 0 on the listener itself closes the
   * gap outright rather than making it narrower.
   *
   * It cannot widen the trust boundary: the bind host is still the hard-coded
   * {@link HOOK_LISTENER_HOST} literal, every request still goes through the
   * loopback origin check, and any port other than 0 outside 1..65535 is still
   * refused. A source-level test asserts that no production module under
   * `src/` names this option.
   */
  allowEphemeralPort?: boolean;
  /**
   * Byte ceiling applied to every string of a payload BEFORE it is relayed to
   * a follower (Phase 1b, DoD 1b.3). Defaults to
   * {@link DEFAULT_RELAY_PREVIEW_BYTES}; production passes
   * `agentDeck.previewBytes`, which is the one ceiling.
   */
  relayPreviewBytes?: number;
  /**
   * Serve {@link EVENTS_PATH} at all. Defaults to `true`.
   *
   * It exists so a test can prove the ROUTE is what carries the events rather
   * than something else in the process, and so the relay can be taken out of a
   * measurement without taking the listener out with it. Production never sets
   * it: a leader that refuses to relay is a leader that silently blinds every
   * other window, which is the defect this phase exists to fix.
   */
  enableRelay?: boolean;
  /**
   * `agentDeck.telemetry.enabled`, read at REQUEST time (v0.7.1 DoD 6.2).
   *
   * A thunk rather than a boolean so a setting change applies to the next
   * request without rebinding the socket. Defaults to "off": a listener built
   * without it accepts no telemetry, which is the shipped default and the safe
   * direction. A thunk that throws reads as off, never as on (G3).
   */
  telemetryEnabled?: () => boolean;
}

/**
 * Relay redaction ceiling when the caller names none.
 *
 * The parse boundary's own default. A relay that defaulted to "no ceiling"
 * would be a G4 hole opened by an omission rather than by a decision.
 */
export const DEFAULT_RELAY_PREVIEW_BYTES = 8 * 1024;

/**
 * True for 127.0.0.0/8, ::1 and IPv4-mapped loopback. False for everything
 * else, including non-strings and empty strings.
 *
 * Exported so the guard can be exercised as a unit, independent of any socket.
 */
export function isLoopbackAddress(addr: unknown): boolean {
  if (typeof addr !== 'string' || addr.length === 0) return false;
  let a = addr.trim().toLowerCase();
  const pct = a.indexOf('%'); // strip IPv6 zone id (fe80::1%eth0)
  if (pct !== -1) a = a.slice(0, pct);
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  if (a.startsWith('::ffff:')) a = a.slice(7);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map((s) => Number(s));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return octets[0] === 127;
}

/** A trimmed non-empty string, or undefined. Never throws. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > 0 ? value : undefined;
}

/** The wire key whose ABSENCE is the main-thread signal. */
const AGENT_ID_KEY = 'agent_id';

/**
 * Turn a raw payload into a {@link NormalizedHookEvent}.
 *
 * The one rule that matters: thread attribution is decided by whether the
 * payload object HAS the `agent_id` key, using `hasOwnProperty` — not by
 * comparing its value against anything. CC omits the key on main-thread
 * events; it has never been observed to send a placeholder id, and a
 * value-comparison would drop every main-thread event the day it did.
 *
 * `agentId` is omitted from the result rather than set to undefined, so
 * `'agentId' in event` distinguishes "CC told us nothing" from a default.
 *
 * Never throws: any payload shape is tolerated, unknown keys are preserved in
 * `raw`, and an unrecognized `hook_event_name` yields
 * `eventNameConfirmed: false` rather than a rejection.
 */
export function normalizeHookEvent(
  payload: RawHookPayload,
  meta: { seq?: number; receivedAt?: number } = {},
): NormalizedHookEvent {
  const agentIdKeyPresent = Object.prototype.hasOwnProperty.call(
    payload,
    AGENT_ID_KEY,
  );
  const agentId = agentIdKeyPresent
    ? optionalString(payload[AGENT_ID_KEY])
    : undefined;

  const eventName = optionalString(payload.hook_event_name);
  const sessionId = optionalString(payload.session_id);
  const toolUseId = optionalString(payload.tool_use_id);
  const toolName = optionalString(payload.tool_name);
  const transcriptPath = optionalString(payload.transcript_path);
  const cwd = optionalString(payload.cwd);

  return {
    seq: meta.seq ?? 0,
    receivedAt: meta.receivedAt ?? Date.now(),
    isMainThread: !agentIdKeyPresent,
    eventNameConfirmed: isConfirmedHookEventName(eventName),
    raw: payload,
    ...(eventName !== undefined ? { eventName } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

/** Content-Type is accepted when absent, or when its media type is JSON. */
function contentTypeAcceptable(header: string | undefined): boolean {
  if (header === undefined) return true;
  const media = header.split(';')[0]?.trim().toLowerCase() ?? '';
  if (media.length === 0) return true;
  return media === 'application/json' || media.endsWith('+json');
}

/**
 * The telemetry paths' content-type rule (v0.7.1 DoD 6.2): the media type must
 * be PRESENT and JSON.
 *
 * Stricter than {@link contentTypeAcceptable} on one point, deliberately. The
 * event path accepts an ABSENT header because a pasted `node -e` hook snippet
 * is not obliged to send one. An OTLP exporter always states its encoding, and
 * the only other encoding it has is protobuf — which this receiver does not
 * decode (OTLP over http/json only, locked ruling). A body that does not say
 * it is JSON is answered `415` rather than guessed at.
 */
function isJsonMediaType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const media = header.split(';')[0]?.trim().toLowerCase() ?? '';
  return media === 'application/json' || media.endsWith('+json');
}

function endWithStatus(res: ServerResponse, status: number): void {
  try {
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'text/plain', 'content-length': 0 });
    }
    res.end();
  } catch {
    /* the client is gone; there is nothing useful to do and nothing to crash for */
  }
}

/** Answer with a small JSON body. Same failure posture as {@link endWithStatus}. */
function endWithJson(res: ServerResponse, status: number, json: string): void {
  try {
    if (!res.headersSent) {
      const body = Buffer.from(json, 'utf8');
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
      res.end(body);
      return;
    }
    res.end();
  } catch {
    /* the client is gone */
  }
}

/**
 * The loopback hook-event listener. One instance owns exactly one socket.
 *
 * Lifecycle: construct, `await start()`, `subscribe(...)`, `await stop()`.
 * Restarting a stopped instance is allowed; starting a running one throws.
 */
export class HookListener {
  readonly host = HOOK_LISTENER_HOST;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly eventPath: string;

  #server: Server | null = null;
  #counters: HookListenerCounters = zeroCounters();
  #handlers = new Set<HookEventHandler>();
  #codexHandlers = new Set<CodexHookEventHandler>();
  #seq = 0;
  #spoofRemoteAddress: string | undefined;
  #allowEphemeralPort: boolean;
  /**
   * The attached followers' response streams (Phase 1b).
   *
   * A `Set` of live `ServerResponse` objects and no other state: a follower IS
   * its open socket, so there is nothing to keep in sync and nothing to leak
   * when a window closes. Removal happens on the response's own `close`.
   */
  readonly #followers = new Set<ServerResponse>();
  readonly #relayPreviewBytes: number;
  readonly #enableRelay: boolean;
  /** Telemetry consumers (v0.7.1 DoD 6.2). A separate set, like the Codex one. */
  readonly #otelHandlers = new Set<OtelHandler>();
  readonly #telemetryEnabled: () => boolean;
  /**
   * Per-signal route accounting (DoD 6.4). Deliberately NOT in
   * {@link HookListenerCounters}: that record is flat numbers, and the fuzz
   * replay in `listener.test.ts` asserts exact deltas over every key of it —
   * the event path's contract, which the telemetry route must not perturb.
   */
  readonly #telemetry: TelemetryRouteCounters = zeroTelemetryCounters();

  constructor(options: HookListenerOptions = {}) {
    this.port = options.port ?? DEFAULT_HOOK_PORT;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.eventPath = options.eventPath ?? DEFAULT_EVENT_PATH;
    this.#spoofRemoteAddress = options.spoofRemoteAddress;
    this.#allowEphemeralPort = options.allowEphemeralPort === true;
    this.#relayPreviewBytes = options.relayPreviewBytes ?? DEFAULT_RELAY_PREVIEW_BYTES;
    this.#enableRelay = options.enableRelay !== false;
    this.#telemetryEnabled = options.telemetryEnabled ?? ((): boolean => false);
    if (options.onEvent) this.#handlers.add(options.onEvent);
  }

  /**
   * The telemetry paths' accounting, per signal (v0.7.1 DoD 6.4). A DEEP copy:
   * mutating the result affects nothing, which a spread of a nested record
   * would not guarantee.
   */
  get telemetryCounters(): TelemetryRouteCounters {
    const copy = (c: TelemetryRouteCounts): TelemetryRouteCounts => ({
      accepted: c.accepted,
      disabled: c.disabled,
      rejected: { ...c.rejected },
    });
    return {
      metrics: copy(this.#telemetry.metrics),
      logs: copy(this.#telemetry.logs),
      traces: copy(this.#telemetry.traces),
    };
  }

  /**
   * Register a telemetry consumer (v0.7.1 DoD 6.2). Each ACCEPTED body is
   * parsed once and its slice handed to every consumer; nothing else is.
   */
  subscribeOtel(handler: OtelHandler): () => void {
    this.#otelHandlers.add(handler);
    return () => {
      this.#otelHandlers.delete(handler);
    };
  }

  /** Followers attached right now. Zero on a window nobody has joined. */
  get followerCount(): number {
    return this.#followers.size;
  }

  /**
   * Relay one telemetry slice to every follower (DoD 1b.5).
   *
   * The OTLP body never appears here — see {@link RelayOtelEnvelope}. The
   * telemetry paths on this listener (v0.7.1 DoD 6.2) produce the slices; the
   * shared listener publishes each one here AND to its own window, through
   * `SharedHookListener.publishTelemetry`, so the relay half cannot be
   * forgotten by a caller.
   */
  relayTelemetry(signal: OtelSignal, slice: TelemetrySlice): void {
    this.#broadcast({ v: 1, kind: 'otel', signal, slice });
  }

  /**
   * Write one envelope to every follower.
   *
   * A follower whose socket has gone away is dropped rather than retried:
   * there is no queue, no replay and no persistence (G7), because a window
   * that has closed has no use for the event and a window that reconnects gets
   * events from the moment it reconnects. The locked block says so — a leader
   * closing loses at most one backoff window — and a buffer here would be a
   * promise this design deliberately does not make.
   */
  #broadcast(envelope: RelayEnvelope): void {
    if (!this.#enableRelay || this.#followers.size === 0) return;
    const frame = encodeSseFrame(envelope);
    for (const res of this.#followers) {
      try {
        res.write(frame);
        this.#counters.relayFramesSent += 1;
      } catch {
        // A dead follower must not be able to stop the next one being served,
        // and must not be able to stop the listener serving hooks at all (G2).
        this.#followers.delete(res);
        this.#counters.socketErrors += 1;
      }
    }
    this.#counters.relayFollowers = this.#followers.size;
  }

  /** Attach one follower's response stream as an SSE subscriber. */
  #attachFollower(res: ServerResponse): void {
    try {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // Flush the head immediately: a follower treats the arrival of the
      // response as the moment it is subscribed, and a head sitting in a write
      // buffer would make that moment a lie.
      res.write(': agent-deck relay\n\n');
    } catch {
      this.#counters.socketErrors += 1;
      return;
    }
    this.#followers.add(res);
    this.#counters.relayFollowers = this.#followers.size;
    const drop = (): void => {
      this.#followers.delete(res);
      this.#counters.relayFollowers = this.#followers.size;
    };
    res.on('close', drop);
    res.on('error', drop);
  }

  /** Snapshot of the counters. Mutating the result does not affect the listener. */
  get counters(): Readonly<HookListenerCounters> {
    return { ...this.#counters };
  }

  /** True between a resolved {@link start} and a {@link stop}. */
  get listening(): boolean {
    return this.#server !== null && this.#server.listening;
  }

  /**
   * The socket's actual bound address, or null when not listening. Callers
   * should assert `address()?.address === '127.0.0.1'` rather than trusting
   * the configuration (G5).
   */
  address(): AddressInfo | null {
    const addr = this.#server?.address() ?? null;
    if (addr === null || typeof addr === 'string') return null;
    return addr;
  }

  /** Register a consumer. Returns an unsubscribe function. */
  subscribe(handler: HookEventHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  /**
   * Register a CODEX consumer (DoD 3.1). Same shape as {@link subscribe},
   * a separate set: a Codex-shaped payload is never handed to a
   * {@link subscribe} handler and a CC-shaped one is never handed to one of
   * these.
   */
  subscribeCodex(handler: CodexHookEventHandler): () => void {
    this.#codexHandlers.add(handler);
    return () => {
      this.#codexHandlers.delete(handler);
    };
  }

  /**
   * Bind the socket. Resolves once listening.
   *
   * Rejects with {@link HookListenerBindError} when the port is already in use
   * or otherwise unbindable, and when the configured port is not a usable
   * fixed port (0 or out of range). It never falls back to another port.
   */
  async start(): Promise<void> {
    if (this.#server !== null) {
      throw new Error('HookListener.start() called while already started');
    }
    // TEST-ONLY: port 0 is bindable only when the caller opted in explicitly.
    const ephemeral = this.#allowEphemeralPort && this.port === 0;
    if (
      !ephemeral &&
      (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535)
    ) {
      // Port 0 lands here on purpose: an ephemeral port cannot be named by the
      // hook snippet the user pasted, and there is no discovery file (G1).
      throw new HookListenerBindError(
        `refusing to bind port ${String(this.port)}: a fixed port in 1..65535 is required`,
        'EPORTINVALID',
        this.host,
        this.port,
      );
    }

    const server = createServer((req, res) => {
      this.#handleRequest(req, res);
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 2_000;

    server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
      // A hook process that exits right after reading the response resets its
      // idle keep-alive socket. Normal, not an error.
      if (err.code === 'ECONNRESET' || err.code === 'ECONNABORTED') {
        this.#counters.clientDisconnects += 1;
      } else {
        this.#counters.socketErrors += 1;
      }
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        try {
          server.close();
        } catch {
          /* it never bound; nothing to release */
        }
        reject(
          new HookListenerBindError(
            `failed to bind ${this.host}:${String(this.port)}: ${err.message}`,
            err.code ?? 'EUNKNOWN',
            this.host,
            this.port,
          ),
        );
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        server.on('error', () => {
          // Post-bind server errors must not take the extension host down.
          this.#counters.socketErrors += 1;
        });
        this.#server = server;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // Host is the literal loopback address, never a hostname (G5).
      server.listen(this.port, this.host);
    });
  }

  /** Close the socket. Safe to call when not started. */
  async stop(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    this.#server = null;

    /*
     * END EVERY FOLLOWER STREAM FIRST, AND EXPLICITLY.
     *
     * `closeAllConnections()` below would drop these sockets too, but this
     * loop is what makes the failover BOUNDED rather than merely likely: a
     * follower starts its rebind backoff when its stream ends, so a leader
     * that closes its sockets before it stops listening hands the port over in
     * one backoff window. Left to `close()` alone the follower would wait on a
     * TCP timeout, and "at most one backoff window of events lost" (DoD 1b.6)
     * would be a hope rather than a measurement.
     */
    for (const follower of this.#followers) {
      try {
        follower.end();
      } catch {
        /* the window is already gone; there is nothing to release */
      }
    }
    this.#followers.clear();
    this.#counters.relayFollowers = 0;

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      // Drop keep-alive sockets so close() does not wait on idle hook clients.
      server.closeAllConnections();
    });
  }

  #dispatch(event: NormalizedHookEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch {
        // G3: a consumer that throws must not affect the listener or any
        // other consumer.
        this.#counters.handlerErrors += 1;
      }
    }
  }

  /** Same discipline as {@link #dispatch}, over the Codex handler set. */
  #dispatchCodex(event: CodexHookEvent): void {
    for (const handler of this.#codexHandlers) {
      try {
        handler(event);
      } catch {
        this.#counters.handlerErrors += 1;
      }
    }
  }

  #handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // G3: an unhandled 'error' on either stream is an uncaught exception, and
    // in the extension host that means the host dies because a hook process
    // went away mid-exchange. Count and carry on.
    //
    // Honest note on this specific listener: the RESPONSE branch below is
    // defensive, not load-bearing. Measured on Node v24 — every reply this
    // server writes is a header block with a zero-length body, handed to the
    // socket in one write, so a peer reset is reported through 'clientError'
    // and the REQUEST stream, never through `res`. A test that resets the
    // connection mid-exchange therefore moves `socketErrors` via the request
    // handler and passes with these three lines deleted; see the reset test in
    // listener.test.ts, which says so too. It is kept because the cost of
    // being wrong is asymmetric: three uncovered lines against an uncaught
    // exception in the extension host. Do not read it as tested behaviour.
    res.on('error', () => {
      this.#counters.socketErrors += 1;
    });

    // G5: socket-level origin check. Request headers are never consulted for
    // this decision — X-Forwarded-For, X-Real-IP and Forwarded are attacker-
    // controlled strings and grant nothing.
    const remote = this.#spoofRemoteAddress ?? req.socket.remoteAddress ?? '';
    if (!isLoopbackAddress(remote)) {
      this.#counters.droppedNonLoopback += 1;
      req.resume(); // drain first so the reply is not truncated
      endWithStatus(res, 403);
      return;
    }

    const url = (req.url ?? '').split('?')[0] ?? '';

    /*
     * PHASE 1b — THE TWO RELAY ROUTES, ON THIS SOCKET AND NO OTHER.
     *
     * They are served here rather than by a second server because the whole
     * design rests on there being ONE port: the hook snippet names it, the OS
     * arbitrates it, and a second socket would reintroduce exactly the
     * discovery problem the fixed port exists to avoid.
     *
     * Placed BELOW the loopback origin check on purpose. A follower is a
     * process on this machine and nothing else may ask who we are or read the
     * stream — the identity route in particular is a fingerprinting surface,
     * and answering it off-loopback would tell a stranger what is running here.
     *
     * `404` on any other METHOD of these two paths (DoD 1b.1), not the `405`
     * the event path answers. That is deliberate and not an inconsistency: a
     * `405` names a route that exists, which for a probe route is one more
     * thing said to a caller who has not identified itself.
     */
    if (url === IDENTITY_PATH) {
      if (req.method !== 'GET') {
        this.#counters.badRoute += 1;
        req.resume();
        endWithStatus(res, 404);
        return;
      }
      this.#counters.identityProbes += 1;
      req.resume();
      const body = Buffer.from(JSON.stringify(identityBody()), 'utf8');
      try {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': body.length,
        });
        res.end(body);
      } catch {
        this.#counters.socketErrors += 1;
      }
      return;
    }

    if (url === EVENTS_PATH) {
      if (req.method !== 'GET' || !this.#enableRelay) {
        this.#counters.badRoute += 1;
        req.resume();
        endWithStatus(res, 404);
        return;
      }
      req.resume();
      this.#attachFollower(res);
      return;
    }

    /*
     * v0.7.1 DoD 6.2 — THE TELEMETRY PATHS, BELOW THE LOOPBACK CHECK.
     *
     * A non-loopback request never reaches this branch: it was answered `403`
     * and counted as `droppedNonLoopback` above, before any path was read. That
     * drop is untouched by the route and is the same one every other path gets.
     */
    const signal = telemetrySignalOf(url);
    if (signal !== undefined) {
      this.#handleTelemetry(req, res, signal);
      return;
    }

    if (url !== this.eventPath) {
      this.#counters.badRoute += 1;
      req.resume(); // drain first so the reply is not truncated
      endWithStatus(res, 404);
      return;
    }
    if (req.method !== 'POST') {
      this.#counters.badMethod += 1;
      req.resume(); // drain first so the reply is not truncated
      endWithStatus(res, 405);
      return;
    }
    if (!contentTypeAcceptable(req.headers['content-type'])) {
      this.#counters.badContentType += 1;
      req.resume(); // drain first so the reply is not truncated
      endWithStatus(res, 415);
      return;
    }

    this.#collectBody(
      req,
      res,
      () => {
        this.#counters.oversize += 1;
      },
      (raw) => {
        this.#onEventBody(raw, res);
      },
    );
  }

  /**
   * Read one request body under the cap, then hand it on — or answer `413`.
   *
   * The event path's body reader, factored out UNCHANGED in behaviour in v0.7.1
   * so the telemetry paths get the same cap by the same code rather than a
   * second copy that could drift from the first (DoD 6.2: the cap is the hooks
   * `DEFAULT_MAX_BODY_BYTES`, 512 KiB, no new setting). `onOversize` is called
   * exactly once per oversize request, which is what each path's own counter
   * needs.
   */
  #collectBody(
    req: IncomingMessage,
    res: ServerResponse,
    onOversize: () => void,
    onComplete: (raw: Buffer) => void,
  ): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    let finished = false;

    const hardLimit = this.maxBodyBytes * HARD_ABORT_MULTIPLE;

    // Declared-size pre-check. Purely an allocation guard: it changes no
    // status code and no counter that the streaming check below would not
    // reach anyway, it just declines to buffer the first `maxBodyBytes` of a
    // body the sender has already announced is too large. Entering the
    // overflow state here rather than answering immediately is deliberate —
    // replying before the body has been drained truncates the reply on a peer
    // that is still writing, and the drain path already has a correct 413.
    //
    // A missing, non-numeric or chunked Content-Length simply falls through:
    // the streaming check is the real limit, this is only ever an early exit.
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxBodyBytes) {
      overflowed = true;
      onOversize();
    }

    req.on('error', () => {
      this.#counters.socketErrors += 1;
    });

    req.on('data', (chunk: Buffer) => {
      if (overflowed) {
        // Drain and discard: memory stays bounded while the 413 gets a clean
        // path back to the client.
        size += chunk.length;
        if (size > hardLimit && !finished) {
          finished = true;
          endWithStatus(res, 413);
          req.destroy();
        }
        return;
      }
      size += chunk.length;
      if (size > this.maxBodyBytes) {
        overflowed = true;
        onOversize();
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (finished) return;
      finished = true;

      if (overflowed) {
        endWithStatus(res, 413);
        return;
      }
      onComplete(Buffer.concat(chunks));
    });
  }

  /**
   * One telemetry request (v0.7.1 DoD 6.2). The answer table, in the order the
   * locked ruling gives it:
   *
   *   non-POST                        -> 405
   *   POST, content type not JSON     -> 415
   *   POST, setting off               -> 403 {"error":"agentDeck.telemetry.enabled is false"}
   *   body over the cap               -> 413
   *   empty, not JSON, not OTLP       -> 400
   *   accepted                        -> 200 {}
   *
   * Nothing here is retryable and nothing here throws (G3). The setting is read
   * BEFORE the body, so a disabled path parses no body at all — it is drained and
   * discarded, never parsed. An accepted body is parsed ONCE, by
   * `parseOtlpBody`, at this boundary: the identity attributes and the content
   * fields are dropped there, so what the consumers and the relay receive is the
   * slice and never the OTLP bytes.
   */
  #handleTelemetry(req: IncomingMessage, res: ServerResponse, signal: OtelSignal): void {
    const counts = this.#telemetry[signal];
    if (req.method !== 'POST') {
      counts.rejected[405] += 1;
      this.#drainThen(req, () => {
        endWithStatus(res, 405);
      });
      return;
    }
    if (!isJsonMediaType(req.headers['content-type'])) {
      counts.rejected[415] += 1;
      this.#drainThen(req, () => {
        endWithStatus(res, 415);
      });
      return;
    }
    let enabled = false;
    try {
      enabled = this.#telemetryEnabled() === true;
    } catch {
      // A setting that cannot be read is not a setting that says yes.
      enabled = false;
    }
    if (!enabled) {
      counts.disabled += 1;
      this.#drainThen(req, () => {
        endWithJson(res, 403, TELEMETRY_DISABLED_BODY);
      });
      return;
    }

    this.#collectBody(
      req,
      res,
      () => {
        counts.rejected[413] += 1;
      },
      (raw) => {
        if (raw.length === 0) {
          counts.rejected[400] += 1;
          endWithStatus(res, 400);
          return;
        }
        const slice = parseOtlpBody(raw.toString('utf8'), signal);
        // Not JSON, not an object, or not OTLP-shaped for this signal: the
        // parse boundary's own verdict, not a second opinion formed here.
        if (slice.counts.bodiesUnparseable > 0) {
          counts.rejected[400] += 1;
          endWithStatus(res, 400);
          return;
        }
        counts.accepted += 1;
        // Before the reply, like hook dispatch: a consumer has seen the slice
        // by the time the exporter observes its 200.
        this.#dispatchOtel(signal, slice);
        endWithJson(res, 200, '{}');
      },
    );
  }

  /**
   * Discard a refused request's body, THEN answer (v0.7.1, found by the gate).
   *
   * The telemetry refusals first answered straight after `req.resume()`, the
   * way the event path's 405/415 always have. The 20-run gate block caught the
   * cost in 2 of 20 runs: a `403` sent while the client was still writing a
   * 512 KiB body closed the exchange under it, and the client read a
   * connection reset instead of the `403` — the case this file already names
   * ("replying before the body has been drained truncates the reply on a peer
   * that is still writing"). An exporter that reads a reset retries; the
   * ruling is that no answer here is retryable.
   *
   * So the body is DRAINED — every chunk dropped as it arrives, nothing kept,
   * nothing parsed — and the answer goes on `end`. A body that keeps coming
   * past the hard multiple of the cap is answered and its socket destroyed, the
   * same bound {@link #collectBody} applies, so a refusal cannot be made to
   * hold a socket open indefinitely.
   */
  #drainThen(req: IncomingMessage, respond: () => void): void {
    const hardLimit = this.maxBodyBytes * HARD_ABORT_MULTIPLE;
    let size = 0;
    let done = false;
    req.on('error', () => {
      this.#counters.socketErrors += 1;
    });
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > hardLimit && !done) {
        done = true;
        respond();
        req.destroy();
      }
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      respond();
    });
  }

  /** Same discipline as {@link #dispatch}, over the telemetry consumers. */
  #dispatchOtel(signal: OtelSignal, slice: TelemetrySlice): void {
    for (const handler of this.#otelHandlers) {
      try {
        handler(signal, slice);
      } catch {
        this.#counters.handlerErrors += 1;
      }
    }
  }

  /** The event path's completed body: JSON, an object, then CC or Codex. */
  #onEventBody(raw: Buffer, res: ServerResponse): void {
    if (raw.length === 0) {
      this.#counters.emptyBody += 1;
      endWithStatus(res, 400);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      this.#counters.malformedJson += 1;
      endWithStatus(res, 400);
      return;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.#counters.notAnObject += 1;
      endWithStatus(res, 400);
      return;
    }

    /*
     * DoD 3.1 — LISTENER DISCRIMINATION.
     *
     * A Codex hook payload reuses `session_id` / `agent_id` / `tool_use_id`,
     * the same join keys the CC layout uses, so every accepted JSON object
     * used to be handed to `normalizeHookEvent` and the CC handler set
     * unconditionally — a real Codex payload was silently misrouted into the
     * CC pipeline. `model` as a KEY (never its value) is the discriminator,
     * measured 160/160 Codex against 0/305 CC. The split is total given what
     * has been measured: A5 found no payload carrying neither shape, so
     * there is no third "unknown engine" bucket here — a future ambiguous
     * shape would still need counting and dropping (G3) rather than a guess,
     * but nothing observed requires that branch today.
     */
    if (Object.prototype.hasOwnProperty.call(parsed, CODEX_DISCRIMINATOR_KEY)) {
      this.#counters.acceptedCodex += 1;
      this.#dispatchCodex({ receivedAtMs: Date.now(), payload: parsed });
      // Relayed as the RAW-SHAPED payload, redacted: the follower re-runs
      // this same discriminator, so a Codex payload reaches a follower's
      // Codex handlers and never its CC ones, by the identical decision made
      // on identical bytes rather than by a routing tag we invented here.
      this.#relayHook(parsed);
      endWithStatus(res, 200);
      return;
    }

    const receivedAt = Date.now();
    this.#seq += 1;
    this.#counters.accepted += 1;

    let event: NormalizedHookEvent;
    try {
      event = normalizeHookEvent(parsed as RawHookPayload, {
        seq: this.#seq,
        receivedAt,
      });
    } catch {
      // Normalization is total by construction; this branch exists so that a
      // future change cannot turn a surprising payload into a crash (G3).
      this.#counters.accepted -= 1;
      this.#counters.malformedJson += 1;
      endWithStatus(res, 400);
      return;
    }

    if (!event.eventNameConfirmed) this.#counters.unconfirmedEventName += 1;

    // Dispatch is in-memory and cheap, so it happens before the response is
    // ended: consumers are guaranteed to have seen the event by the time the
    // client observes a 200. Handler exceptions are swallowed and counted, so
    // this cannot delay or break the reply.
    this.#dispatch(event);
    this.#relayHook(parsed);
    endWithStatus(res, 200);
  }

  /**
   * Redact one accepted payload and put it on the relay (DoD 1b.3).
   *
   * **REDACTION HAPPENS HERE, AT THE LEADER, BEFORE THE FRAME EXISTS** — not
   * at the follower, and not as a pass over something already written. The
   * order is the guarantee: there is no code path on which an unredacted byte
   * is handed to `write`, so "no thinking or oversized payload bytes cross
   * `/agent-deck/events`" is a property of the shape of this method rather
   * than of a filter somebody has to remember to keep complete.
   *
   * Called AFTER local dispatch and wrapped, so a relay failure can never
   * become a liveness failure in the window that received the event (G2).
   */
  #relayHook(payload: unknown): void {
    if (!this.#enableRelay || this.#followers.size === 0) return;
    try {
      this.#broadcast({
        v: 1,
        kind: 'hook',
        payload: redactHookPayload(payload, this.#relayPreviewBytes),
      });
    } catch {
      this.#counters.handlerErrors += 1;
    }
  }
}
