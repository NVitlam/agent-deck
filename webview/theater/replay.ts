/**
 * The replay transport: turn a corpus's `atMs` offsets back into a timed
 * sequence, at whatever speed a human asks for.
 *
 * NO REDUCER LIVES HERE. This module decides WHEN a message is delivered and
 * nothing about what it means; `webview/store.ts` is the only reducer in the
 * webview and the theater drives the real one. A second reducer written "just
 * for the theater" would make the theater's picture unfalsifiable, which is
 * the opposite of the point.
 *
 * Dev-only. Nothing here is reachable from `webview/main.ts` — asserted on the
 * real import graph in `webview/wire.test.ts`, not claimed in this comment.
 */

import type { HostToWebviewMessage } from '../../src/model/events.js';
import type { WireCorpus, WireEvent } from './corpus-types.js';

/**
 * The structured-clone hop VS Code performs on `postMessage`.
 *
 * A JSON round trip is the closest faithful stand-in — the same one
 * `fixture-render.test.ts` and `scripts/capture-states.mjs` use — and it also
 * means a replayed message is never the corpus object itself, so the store
 * cannot mutate the corpus into a different second run.
 */
export function cloneMessage(message: HostToWebviewMessage): HostToWebviewMessage {
  return JSON.parse(JSON.stringify(message)) as HostToWebviewMessage;
}

/** Deliver `events[from..to)` in order, cloned. */
export function deliverRange(
  corpus: WireCorpus,
  from: number,
  to: number,
  deliver: (message: HostToWebviewMessage, event: WireEvent) => void,
): void {
  for (let i = from; i < to; i += 1) {
    const event = corpus.events[i];
    if (event === undefined) continue;
    deliver(cloneMessage(event.message), event);
  }
}

/** Deliver every event in the corpus, in order. */
export function replayAll(
  corpus: WireCorpus,
  deliver: (message: HostToWebviewMessage, event: WireEvent) => void,
): void {
  deliverRange(corpus, 0, corpus.events.length, deliver);
}

/**
 * What the controller drives.
 *
 * `restart` exists because seeking BACKWARDS in a stream of diffs is not a
 * thing you can do by subtracting: a patch is not invertible. The honest
 * implementation throws the store away and replays from zero, which is fast
 * enough at corpus sizes and cannot drift from a forward play.
 */
export interface ReplayTarget {
  /** Tear the store down and start a fresh, empty one. */
  restart(): void;
  deliver(message: HostToWebviewMessage, event: WireEvent): void;
  /** Called after every position change, for the transport UI. */
  onPosition?(index: number, atMs: number): void;
}

export interface ReplayClock {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface ReplayController {
  /** Number of events delivered so far, 0..events.length. */
  index(): number;
  /** Simulated offset of the last delivered event. */
  atMs(): number;
  playing(): boolean;
  play(): void;
  pause(): void;
  /** Jump to having delivered exactly `index` events. */
  seek(index: number): void;
  /** 1 = real time. Higher is faster. */
  setSpeed(multiplier: number): void;
  speed(): number;
  dispose(): void;
}

/** The largest wall-clock gap the transport will actually wait, in ms. */
const MAX_GAP_MS = 5_000;

export function createReplay(
  corpus: WireCorpus,
  target: ReplayTarget,
  clock: ReplayClock = globalThis,
): ReplayController {
  let index = 0;
  let speed = 10;
  let playing = false;
  let handle: number | undefined;

  const total = corpus.events.length;

  const positionMs = (): number => {
    if (index === 0) return 0;
    return corpus.events[index - 1]?.atMs ?? 0;
  };

  const announce = (): void => {
    target.onPosition?.(index, positionMs());
  };

  const cancel = (): void => {
    if (handle !== undefined) clock.clearTimeout(handle);
    handle = undefined;
  };

  const step = (): void => {
    const event = corpus.events[index];
    if (event === undefined) {
      playing = false;
      cancel();
      announce();
      return;
    }
    target.deliver(cloneMessage(event.message), event);
    index += 1;
    announce();
    schedule();
  };

  function schedule(): void {
    cancel();
    if (!playing) return;
    const next = corpus.events[index];
    if (next === undefined) {
      playing = false;
      announce();
      return;
    }
    const gap = next.atMs - positionMs();
    // Clamped, not because the number is wrong but because a 3-minute quiet
    // stretch at 1x is not a review — it is a wait. The clamp is on the WAIT,
    // never on `atMs`, so the scrubber still reads true simulated time.
    const wait = Math.min(Math.max(gap, 0) / speed, MAX_GAP_MS);
    handle = clock.setTimeout(step, wait);
  }

  const seek = (to: number): void => {
    const clamped = Math.max(0, Math.min(total, Math.trunc(to)));
    if (clamped < index) {
      target.restart();
      index = 0;
    }
    deliverRange(corpus, index, clamped, (message, event) => {
      target.deliver(message, event);
    });
    index = clamped;
    announce();
    schedule();
  };

  return {
    index: () => index,
    atMs: positionMs,
    playing: () => playing,
    speed: () => speed,
    seek,
    setSpeed(multiplier: number): void {
      if (!Number.isFinite(multiplier) || multiplier <= 0) return;
      speed = multiplier;
      if (playing) schedule();
    },
    play(): void {
      // Replaying from the end would sit there doing nothing, which reads as
      // a broken button. Rewinding first is what a human means by "play".
      if (index >= total) seek(0);
      playing = true;
      schedule();
    },
    pause(): void {
      playing = false;
      cancel();
    },
    dispose(): void {
      playing = false;
      cancel();
    },
  };
}
