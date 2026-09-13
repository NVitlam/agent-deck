/**
 * The Tweaks panel's one channel — v0.8.0 Phase 7, DoD 7.6.
 *
 * A holder for the last `settings` message's `tweaks` record, plus a sink for
 * `updateTweak`. Forty lines, no Svelte, no DOM, no timers, for the same
 * reason `store.ts` has none of those: it can be driven from a node test, and
 * the reactive layer above it stays thin enough to read.
 *
 * ## WHY A HOLDER EXISTS AT ALL
 *
 * `mount()` takes props once. The sidebar has to answer a `settings` message
 * that arrives at any time, so something between the message listener and the
 * component has to be subscribable — the same shape `App.svelte` already uses
 * against `store.ts`, one size down.
 *
 * ## `update` DOES NOT WRITE `get`
 *
 * That is the whole of the amendment's *"settings are the source of truth"*
 * made mechanical: a click reaches {@link TweaksSource.update}, which posts and
 * returns, and the value the panel draws moves only when the host's next
 * `settings` message reaches {@link TweaksSource.accept}. A source that
 * recorded the click optimistically would draw a position `settings.json`
 * disagreed with the moment anything else wrote it, and "anything else"
 * includes the Settings UI this sidebar's own `Settings` entry opens.
 *
 * G7: nothing here survives a reload. There is no storage of any kind — the
 * record starts empty and the host re-sends on create.
 */

import type { UpdateTweakMessage } from '../../src/model/events.js';
import type { TweakValue } from '../../src/sidebar/tweaks.js';

/** The four settings as the host last read them, keyed without the prefix. */
export type TweakRecord = Readonly<Record<string, boolean | string>>;

export interface TweaksSource {
  /**
   * The last `tweaks` record the host sent. EMPTY until one arrives, and empty
   * is not a set of defaults — it is the absence of an answer, which the panel
   * renders as such rather than guessing.
   */
  get(): TweakRecord;
  /** Register a change listener. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * A `settings` message landed. Replaces the record whole, never merges.
   *
   * Takes `undefined` because the message port is not the contract: the
   * webview's inbound guard checks the `type` field and nothing else, so a
   * `settings` message can arrive here without its record. That is the same
   * G3 reading `store.ts` applies to the same field, and it reads as UNKNOWN
   * rather than as a throw.
   */
  accept(tweaks: TweakRecord | undefined): void;
  /** A control was operated: post `updateTweak`. Writes nothing here. */
  update(key: string, value: TweakValue): void;
}

export function createTweaksSource(
  post: (message: UpdateTweakMessage) => void = () => {},
): TweaksSource {
  let tweaks: TweakRecord = {};
  const listeners = new Set<() => void>();

  return {
    get: () => tweaks,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    accept(next: TweakRecord | undefined): void {
      // Replaced whole. A merge would keep a key the host has stopped
      // sending, which is a value no configuration holds.
      tweaks = next ?? {};
      for (const listener of [...listeners]) listener();
    },
    update(key: string, value: TweakValue): void {
      post({ type: 'updateTweak', key, value });
    },
  };
}
