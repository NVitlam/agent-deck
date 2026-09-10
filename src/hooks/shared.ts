/**
 * Agent Deck — the shared hook listener (PLAN.md v0.7.0 Phase 1b).
 *
 * ONE PORT, MANY WINDOWS. `HookListener` owns a socket; this owns the QUESTION
 * of whether this window gets to own it, and what to do when it does not.
 *
 *   leader    this window bound `agentDeck.port`. It serves the hook route as
 *             it always has, and it serves `/agent-deck/events` to the other
 *             windows.
 *   follower  the port was taken, the thing holding it identified itself as an
 *             Agent Deck leader, and this window is reading that leader's
 *             stream instead of a socket of its own.
 *   refused   the port was taken by something that is NOT us. Today's error
 *             message, unchanged in substance: a stranger on the port is still
 *             a stranger, and Agent Deck still will not pick a port.
 *   idle      never started, or deliberately not started (no hook-driven
 *             engine is observable in this window).
 *
 * WHAT THIS MODULE ADDS TO THE TRUST BOUNDARY, STATED PLAINLY. Until Phase 1b
 * this extension contained a server and no client, and `egress.test.ts`
 * asserted exactly that against the built bundle. It now contains one client,
 * and it is here: {@link SharedHookListener.#loopbackRequest}, the ONLY place
 * in `src/` that calls `http.request`. Its host is the hard-coded
 * {@link HOOK_LISTENER_HOST} literal — not a setting, not a hostname, nothing
 * that could resolve off-loopback — and its port is the one the user
 * configured. G5's promise ("no network except the loopback hook listener") is
 * unchanged in substance: the one thing this extension now talks to is another
 * copy of that same loopback listener. The G5 test moved from "no client
 * exists" to "the only client's destination is the loopback literal", because
 * the first sentence has stopped being true and pretending otherwise would be
 * the fail-open reading rule 18 exists for.
 *
 * WHAT THE OWNERSHIP FILTER DOES AND DOES NOT COVER — and this is the limit a
 * reader is most likely to get wrong. It is applied to RELAYED events only,
 * which is what DoD 1b.4 asks for. A leader's own socket still ingests every
 * payload that reaches it, including payloads from another window's sessions
 * — and that is not a regression this phase introduces: with one fixed port,
 * every window's hooks have always POSTed to whichever window bound it. The
 * filter is new protection for followers, not a new panel-wide rule, and
 * saying so here is cheaper than a later reader inferring a guarantee that
 * does not exist.
 */

import { Buffer } from 'node:buffer';
import { request as httpRequest } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { CodexHookEvent } from '../codex/liveness.js';
import type { NormalizedHookEvent } from '../model/events.js';
import type { OtelSignal, TelemetrySlice } from '../otel/parse.js';
import { systemScheduler, type Scheduler, type TimerHandle } from '../parser/tailer.js';
import {
  DEFAULT_HOOK_PORT,
  HOOK_LISTENER_HOST,
  HookListener,
  isHookListenerBindError,
  normalizeHookEvent,
  type CodexHookEventHandler,
  type HookEventHandler,
  type HookListenerCounters,
  type TelemetryRouteCounters,
} from './listener.js';
import {
  EVENTS_PATH,
  IDENTITY_PATH,
  REBIND_MAX_ATTEMPTS,
  backoffDelayMs,
  decodeSseFrame,
  isLeaderIdentity,
  ownsRelayedPayload,
  splitFrames,
  zeroRelayCounters,
  type RelayCounters,
  type RelayRole,
} from './relay.js';

/**
 * How long an identity probe waits before deciding the port holder is not us.
 *
 * THE NUMBER IS SET BY THE STRANGER CASE, NOT BY THE LEADER CASE. A real Agent
 * Deck leader is a process on this machine answering a 60-byte JSON document
 * off a socket it has already accepted; it replies in single-digit milliseconds
 * and no plausible load makes it slow. What actually consumes this budget is a
 * stranger that accepts the connection and never answers — the shape of a bare
 * `http.createServer()` with no request listener, which is exactly what this
 * repository's own tests hold the port with — and there the whole budget is
 * spent before the user sees the refusal they were always going to see.
 *
 * So it is sized as generous-for-a-leader rather than patient-with-a-stranger:
 * roughly eighty times a loopback round trip, and short enough that four
 * port-holding tests do not add six seconds to the suite. A probe that times
 * out falls back to today's refusal message, which is a degradation and never
 * a wrong answer.
 */
export const IDENTITY_PROBE_TIMEOUT_MS = 400;

/** Cap on an identity reply's size. A leader's is ~60 bytes. */
export const IDENTITY_MAX_BYTES = 4 * 1024;

/**
 * The Codex discriminator, restated.
 *
 * A follower must route a relayed payload the way the leader's socket would
 * have routed it, and the leader's rule is the PRESENCE of the `model` key
 * (never its value). Spelled here rather than exported from `listener.ts`
 * because that module's constant is private to it; the duplication is one
 * literal against one, and `shared.test.ts` pins the two agreeing by driving
 * a real captured Codex payload through both paths rather than by comparing
 * the strings.
 */
const CODEX_DISCRIMINATOR_KEY = 'model';

export interface SharedHookListenerOptions {
  /** The configured port. Never 0, never re-picked. */
  port?: number;
  /** Redaction ceiling for relayed payloads. `agentDeck.previewBytes`. */
  previewBytes?: number;
  /** This window's workspace folders, absolute. Used by the ownership filter. */
  workspacePaths?: readonly string[];
  /** True when this window is tailing a transcript for that session id. */
  tailsSession?: (sessionId: string) => boolean;
  /** Injected timers, so failover is assertable without wall-clock waiting. */
  scheduler?: Scheduler;
  /** Injected jitter source. Defaults to `Math.random`. */
  random?: () => number;
  /** Called whenever the role changes. One line per change, never per event. */
  onRoleChange?: (role: RelayRole) => void;
  /** Forwarded to the inner {@link HookListener}. */
  eventPath?: string;
  /**
   * `agentDeck.telemetry.enabled`, read at request time by the inner
   * {@link HookListener} (v0.7.1 DoD 6.2). Only the LEADER's value is ever
   * read, because only the leader has a socket: a follower's telemetry arrives
   * already parsed, by relay. The setting is machine-scoped so the two cannot
   * differ by declaration.
   */
  telemetryEnabled?: () => boolean;
}

/*
 * WHY THE EPHEMERAL-PORT ESCAPE HATCH IS NOT FORWARDED HERE, AND WHY THE
 * TESTS ARE FINE WITHOUT IT. (The option is deliberately not NAMED in this
 * file: the guard below is a substring scan over production sources, so a
 * comment mentioning it would trip the very check this paragraph respects.)
 *
 * `listener.test.ts` asserts that no production module outside `listener.ts`
 * names either TEST-ONLY option, and forwarding one through this constructor
 * would defeat that guard rather than satisfy it — a forwarded escape hatch is
 * still an escape hatch, one indirection further from the file that declares
 * it. Nothing is lost: every leader-side behaviour this phase adds (the two
 * routes, the redaction, the broadcast) lives in `HookListener`, so a test
 * that needs an unraced leader binds a plain `HookListener` on an ephemeral
 * port and points a `SharedHookListener` follower at the number it got. The
 * one path that needs a `SharedHookListener` to BE a leader — failover — gets
 * there by binding the fixed port the previous leader released, which is what
 * the product does too.
 */

/**
 * A hook listener that shares one port across windows.
 *
 * The surface `extension.ts` uses is deliberately the one `HookListener`
 * already offered — `subscribe`, `subscribeCodex`, `start`, `stop`,
 * `listening`, `counters` — so the host wires a leader and a follower
 * identically and nothing downstream learns which it got.
 */
export class SharedHookListener {
  readonly port: number;
  readonly #listener: HookListener;
  readonly #handlers = new Set<HookEventHandler>();
  readonly #codexHandlers = new Set<CodexHookEventHandler>();
  readonly #otelHandlers = new Set<(signal: OtelSignal, slice: TelemetrySlice) => void>();
  readonly #scheduler: Scheduler;
  readonly #random: () => number;
  readonly #onRoleChange: (role: RelayRole) => void;
  readonly #workspacePaths: readonly string[];
  readonly #tailsSession: (sessionId: string) => boolean;

  #role: RelayRole = 'idle';
  #relay: RelayCounters = zeroRelayCounters();
  #stream: ClientRequest | null = null;
  #streamAttached = false;
  #timer: TimerHandle | null = null;
  #stopped = false;
  #seq = 0;

  constructor(options: SharedHookListenerOptions = {}) {
    this.port = options.port ?? DEFAULT_HOOK_PORT;
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#random = options.random ?? Math.random;
    this.#onRoleChange = options.onRoleChange ?? ((): void => {});
    this.#workspacePaths = options.workspacePaths ?? [];
    this.#tailsSession = options.tailsSession ?? ((): boolean => false);
    this.#listener = new HookListener({
      port: this.port,
      ...(options.previewBytes !== undefined ? { relayPreviewBytes: options.previewBytes } : {}),
      ...(options.eventPath !== undefined ? { eventPath: options.eventPath } : {}),
      ...(options.telemetryEnabled !== undefined ? { telemetryEnabled: options.telemetryEnabled } : {}),
    });
    // Local events reach the SAME handler sets a relayed event reaches, and
    // they reach them WITHOUT the ownership filter — see the module header.
    this.#listener.subscribe((event) => {
      this.#dispatch(event);
    });
    this.#listener.subscribeCodex((event) => {
      this.#dispatchCodex(event);
    });
    // v0.7.1 DoD 6.2 — the route's one exit. Every accepted body's slice goes
    // through `publishTelemetry`, so this window's consumers AND every
    // follower receive it; there is no second path a later caller could take.
    this.#listener.subscribeOtel((signal, slice) => {
      this.publishTelemetry(signal, slice);
    });
  }

  /** The telemetry paths' accounting (DoD 6.4). Zero on a follower, which holds no socket. */
  get telemetryCounters(): TelemetryRouteCounters {
    return this.#listener.telemetryCounters;
  }

  /** The role this window currently holds. */
  get role(): RelayRole {
    return this.#role;
  }

  /**
   * Relay accounting. A snapshot; mutating it affects nothing.
   *
   * `followers` and `relayed` are read off the listener rather than mirrored:
   * it owns both numbers, and a copy kept in step by hand is how two accounts
   * of one fact start to disagree. The rest are this object's own.
   */
  get relayCounters(): Readonly<RelayCounters> {
    return {
      ...this.#relay,
      followers: this.#listener.followerCount,
      relayed: this.#listener.counters.relayFramesSent,
    };
  }

  /** The inner listener's counters, unchanged. */
  get counters(): Readonly<HookListenerCounters> {
    return this.#listener.counters;
  }

  /**
   * The socket's bound address, or null when this window holds none.
   *
   * Null on a FOLLOWER, and that is the honest answer rather than a gap: a
   * follower has no address because it has no socket. Callers asserting
   * `address()?.address === '127.0.0.1'` (G5) are asking about a bind, and a
   * follower has not made one.
   */
  address(): AddressInfo | null {
    return this.#listener.address();
  }

  /** True when this window HOLDS the socket. Not the same question as {@link listening}. */
  get bound(): boolean {
    return this.#listener.listening;
  }

  /**
   * True when this window is RECEIVING hook events — bound as leader, or
   * attached to a leader as a follower.
   *
   * **THIS IS THE D2 TRAP, AND IT IS WHY THE TWO GETTERS ARE SEPARATE.**
   * `extension.ts` reads `listening` to decide whether the tap is down and
   * paints a "no hook events" banner when it is false. A follower holds no
   * socket, so a `listening` that meant "I bound something" would make every
   * follower window announce that its hooks are silent while its deck is
   * being fed perfectly well — the exact shape of the defect the user found by
   * eye on 2026-09-03, arriving through a new door. The socket question still
   * has an answer and it is {@link bound}; nothing outside this module and its
   * tests asks it.
   */
  get listening(): boolean {
    return this.#listener.listening || this.#streamAttached;
  }

  subscribe(handler: HookEventHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  subscribeCodex(handler: CodexHookEventHandler): () => void {
    this.#codexHandlers.add(handler);
    return () => {
      this.#codexHandlers.delete(handler);
    };
  }

  /** Telemetry consumers (Component 12). Fed locally or by relay, identically. */
  subscribeOtel(handler: (signal: OtelSignal, slice: TelemetrySlice) => void): () => void {
    this.#otelHandlers.add(handler);
    return () => {
      this.#otelHandlers.delete(handler);
    };
  }

  /**
   * Publish one telemetry slice: to this window's consumers AND to followers.
   *
   * The single entry point the telemetry route calls (v0.7.1 DoD 6.2, wired in
   * the constructor), so the route cannot forget the relay half.
   */
  publishTelemetry(signal: OtelSignal, slice: TelemetrySlice): void {
    this.#dispatchOtel(signal, slice);
    this.#listener.relayTelemetry(signal, slice);
  }

  /**
   * Bind, or attach to whoever already did.
   *
   * Rejects with the original {@link HookListenerBindError} when the port is
   * held by something that is not an Agent Deck leader, so the host's existing
   * error path — and the message the user reads — stays exactly where it was.
   */
  async start(): Promise<void> {
    this.#stopped = false;
    try {
      await this.#listener.start();
      this.#setRole('leader');
      return;
    } catch (error) {
      if (!isHookListenerBindError(error) || error.code !== 'EADDRINUSE') {
        this.#setRole('refused');
        throw error;
      }
      const attached = await this.#tryFollow();
      if (attached) return;
      // A stranger holds the port. Today's refusal, unchanged.
      this.#setRole('refused');
      throw error;
    }
  }

  /** Release everything: the socket, the follower stream, and any pending timer. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      this.#scheduler.clearTimer(this.#timer);
      this.#timer = null;
    }
    this.#detachStream();
    await this.#listener.stop();
    this.#setRole('idle');
  }

  // -------------------------------------------------------------------------
  // Follower path
  // -------------------------------------------------------------------------

  /**
   * Probe the port holder and, if it is one of us, attach to its stream.
   *
   * Returns false — never throws — when the holder is a stranger, when it
   * times out, or when it answers something this build does not recognise. A
   * caller that has to distinguish "not us" from "we exploded" would be
   * choosing between two refusals, and only one of them is real.
   */
  async #tryFollow(): Promise<boolean> {
    const identity = await this.#probeIdentity();
    if (!isLeaderIdentity(identity)) return false;
    // AWAITED, and the await is the contract rather than tidiness — see
    // {@link SharedHookListener.#attachStream}.
    if (!(await this.#attachStream())) return false;
    this.#setRole('follower');
    return true;
  }

  /** GET {@link IDENTITY_PATH} and parse the reply. Total: never throws. */
  async #probeIdentity(): Promise<unknown> {
    return new Promise<unknown>((resolve) => {
      let settled = false;
      const done = (value: unknown): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let req: ClientRequest;
      try {
        req = this.#loopbackRequest(IDENTITY_PATH);
      } catch {
        done(undefined);
        return;
      }
      req.setTimeout(IDENTITY_PROBE_TIMEOUT_MS, () => {
        req.destroy();
        done(undefined);
      });
      req.on('error', () => {
        done(undefined);
      });
      req.on('response', (res: IncomingMessage) => {
        if (res.statusCode !== 200) {
          res.resume();
          done(undefined);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > IDENTITY_MAX_BYTES) {
            // A "leader" whose identity document runs to kilobytes is not one.
            res.destroy();
            done(undefined);
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', () => {
          done(undefined);
        });
        res.on('end', () => {
          try {
            done(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
          } catch {
            done(undefined);
          }
        });
      });
      req.end();
    });
  }

  /**
   * Open the SSE stream and wire its frames into this window's handlers.
   *
   * **RESOLVES WHEN THE STREAM IS ACTUALLY ATTACHED, NOT WHEN IT HAS BEEN
   * ASKED FOR, AND THAT IS A CORRECTNESS PROPERTY RATHER THAN A NICETY.**
   * The first draft returned as soon as the request was written and let
   * `#streamAttached` flip inside the 'response' callback. It was caught by a
   * test asserting the obvious thing — a window whose `start()` has resolved
   * as a follower is receiving events — and it failed, because for one turn of
   * the event loop the window was a follower that reported {@link listening}
   * false.
   *
   * That gap is not cosmetic: `extension.ts` reads `listening` to decide
   * whether the hook tap is down, and it reads it right after `start()`. A
   * follower would have painted "no hook events received" over a perfectly
   * healthy deck for exactly as long as it took the leader to answer — which
   * is the D2 defect the user found by eye, arriving through the door this
   * phase opened. Resolving on the response closes it at the source rather
   * than teaching every caller to wait.
   *
   * Returns false when the leader answers anything but 200, or when the
   * request cannot be made at all. The caller treats that as "not followed",
   * which is the same state a stranger produces.
   */
  async #attachStream(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      let req: ClientRequest;
      try {
        req = this.#loopbackRequest(EVENTS_PATH);
      } catch {
        settle(false);
        return;
      }
      this.#stream = req;
      req.on('error', () => {
        // Before the response this is a failed attach; after it, a lost
        // leader. `#onStreamLost` is a no-op in the first case because
        // `#streamAttached` is false and the stream reference is cleared, so
        // one handler serves both without inventing a second state.
        if (!settled) {
          this.#stream = null;
          settle(false);
          return;
        }
        this.#onStreamLost();
      });
      req.on('response', (res: IncomingMessage) => {
        if (res.statusCode !== 200) {
          res.resume();
          this.#stream = null;
          settle(false);
          return;
        }
        this.#streamAttached = true;
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const split = splitFrames(buffer);
          buffer = split.rest;
          for (const frame of split.frames) this.#onFrame(frame);
        });
        res.on('error', () => {
          this.#onStreamLost();
        });
        res.on('end', () => {
          this.#onStreamLost();
        });
        res.on('close', () => {
          this.#onStreamLost();
        });
        settle(true);
      });
      req.end();
    });
  }

  /**
   * One SSE frame from the leader.
   *
   * A frame that does not decode is COUNTED and dropped, never repaired and
   * never partially read (G3). The likeliest producer of one is not an
   * attacker but an ordinary version skew — one window updated, the other not
   * yet reloaded — and reading the fields we recognise out of an envelope we
   * do not understand is precisely the guess the fingerprint refuses on a
   * transcript.
   */
  #onFrame(frame: string): void {
    // The leader's opening `: agent-deck relay` comment carries no `data:`.
    if (frame.trim() === '' || frame.startsWith(':')) return;
    const envelope = decodeSseFrame(frame);
    if (envelope === undefined) {
      this.#relay.undecodable += 1;
      return;
    }
    this.#relay.received += 1;

    if (envelope.kind === 'otel') {
      this.#dispatchOtel(envelope.signal, envelope.slice);
      return;
    }

    // DoD 1b.4 — THE OWNERSHIP FILTER, and it is the FOLLOWER'S.
    if (
      !ownsRelayedPayload(envelope.payload, {
        tailsSession: this.#tailsSession,
        workspacePaths: this.#workspacePaths,
      })
    ) {
      this.#relay.droppedForeign += 1;
      return;
    }

    const payload = envelope.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
    if (Object.prototype.hasOwnProperty.call(payload, CODEX_DISCRIMINATOR_KEY)) {
      this.#dispatchCodex({ receivedAtMs: Date.now(), payload });
      return;
    }
    this.#seq += 1;
    this.#dispatch(normalizeHookEvent(payload, { seq: this.#seq, receivedAt: Date.now() }));
  }

  /**
   * The leader went away.
   *
   * Idempotent, because a broken stream reports itself through more than one
   * event ('end', 'close' and 'error' can all arrive for one socket) and a
   * failover counted three times would make the diagnostics line say the
   * leader died three times.
   */
  #onStreamLost(): void {
    if (this.#stopped) return;
    if (!this.#streamAttached && this.#stream === null) return;
    this.#detachStream();
    this.#relay.failovers += 1;
    this.#scheduleRebind(0);
  }

  #detachStream(): void {
    this.#streamAttached = false;
    const req = this.#stream;
    this.#stream = null;
    if (req === null) return;
    try {
      req.destroy();
    } catch {
      /* already gone */
    }
  }

  // -------------------------------------------------------------------------
  // Failover
  // -------------------------------------------------------------------------

  /**
   * Try to become the leader, backing off with jitter between attempts.
   *
   * No election protocol, by the user's ruling: `bind()` IS the election and
   * the kernel is the arbiter. Every window that lost its leader races for the
   * port; exactly one wins because exactly one bind succeeds; the losers find
   * the winner through the identity route they would have used at startup.
   * Jitter is what stops N losers re-colliding on the same tick forever.
   */
  #scheduleRebind(attempt: number): void {
    if (this.#stopped) return;
    if (attempt >= REBIND_MAX_ATTEMPTS) {
      this.#setRole('refused');
      return;
    }
    const delay = attempt === 0 ? 0 : backoffDelayMs(this.#random);
    this.#timer = this.#scheduler.setTimer(() => {
      this.#timer = null;
      void this.#attemptRebind(attempt);
    }, delay);
  }

  async #attemptRebind(attempt: number): Promise<void> {
    if (this.#stopped) return;
    this.#relay.rebindAttempts += 1;
    try {
      await this.#listener.start();
      this.#setRole('leader');
      return;
    } catch (error) {
      if (!isHookListenerBindError(error) || error.code !== 'EADDRINUSE') {
        this.#setRole('refused');
        return;
      }
    }
    // Somebody else won the race. If it is one of us, follow it; if it is a
    // stranger — or one of us that would not serve the stream — keep trying.
    // A stranger may be transient, and a window that gave up on the first
    // foreign bind would never recover from a one-second overlap with an
    // unrelated process.
    if (await this.#tryFollow()) return;
    this.#scheduleRebind(attempt + 1);
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  /**
   * THE ONLY OUTBOUND REQUEST IN `src/`.
   *
   * `hostname` is the hard-coded loopback literal — the same constant the
   * server binds — and never a setting, never a hostname, never anything a
   * resolver could send off this machine. `egress.test.ts` asserts the built
   * bundle contains exactly one outbound call site and that its host is this
   * literal.
   */
  #loopbackRequest(path: string): ClientRequest {
    return httpRequest({
      host: HOOK_LISTENER_HOST,
      port: this.port,
      path,
      method: 'GET',
      headers: { accept: 'text/event-stream, application/json' },
    });
  }

  #setRole(role: RelayRole): void {
    if (this.#role === role) return;
    this.#role = role;
    try {
      this.#onRoleChange(role);
    } catch {
      /* a diagnostics sink that throws must not take the data path down (G2) */
    }
  }

  #dispatch(event: NormalizedHookEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch {
        /* G3: one consumer's failure is not another's, and never the tap's */
      }
    }
  }

  #dispatchCodex(event: CodexHookEvent): void {
    for (const handler of this.#codexHandlers) {
      try {
        handler(event);
      } catch {
        /* as above */
      }
    }
  }

  #dispatchOtel(signal: OtelSignal, slice: TelemetrySlice): void {
    for (const handler of this.#otelHandlers) {
      try {
        handler(signal, slice);
      } catch {
        /* as above */
      }
    }
  }
}
