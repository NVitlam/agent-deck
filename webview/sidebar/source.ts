/**
 * The sidebar's one channel — v0.9.0 DoD 9.17.
 *
 * A holder for the last `sidebarState` message, plus a sink for `runCommand`.
 * No Svelte, no DOM, no timers, for the same reason `store.ts` has none of
 * those: it can be driven from a node test, and the reactive layer above it
 * stays thin enough to read.
 *
 * ## WHY A HOLDER EXISTS AT ALL
 *
 * `mount()` takes props ONCE. The sidebar has to answer a message that
 * arrives at any time — a control command, a configuration change, a drawer
 * opening — so something between the message listener and the component has
 * to be subscribable. It is the same shape `App.svelte` already uses against
 * `store.ts`, one size down, and it is the shape `createTweaksSource` had
 * before v0.9.0 removed the surface it served.
 *
 * ## `run` DOES NOT WRITE `get`
 *
 * That is the amendment's "the host owns every control value" made
 * mechanical: a click reaches {@link SidebarSource.run}, which posts and
 * returns, and what the sidebar DRAWS moves only when the host's next
 * `sidebarState` message reaches {@link SidebarSource.accept}. A source that
 * recorded the click optimistically would draw a tick the host disagreed
 * with the moment anything else moved the value — and "anything else"
 * includes a keybinding, a submenu, the palette and this sidebar's own
 * Settings entry.
 *
 * G7: nothing here survives a reload. There is no storage of any kind — the
 * state starts at the shipped defaults and the host re-sends on create.
 */

import type {
  InsightsProviderAbout,
  InsightsProviderAction,
  RunCommandMessage,
} from '../../src/model/events.js';
import { DEFAULT_VIEW_CONTROLS } from '../../src/view/controls.js';
import type { SidebarState } from './model.js';

/**
 * What the sidebar shows before the host has said anything.
 *
 * The host's own defaults, plus "no tweaks set", "no Insights provider
 * registered" and "no drawer open" — so a document that has just loaded draws
 * the same three pages it will draw a millisecond later, with nothing ticked
 * that is not really ticked. `DEFAULT_VIEW_CONTROLS` is imported rather than
 * copied: a second defaults object here would be the stale one.
 */
export const EMPTY_SIDEBAR_STATE: SidebarState = Object.freeze({
  controls: DEFAULT_VIEW_CONTROLS,
  tweaks: {},
  provider: null,
  insightsActions: [],
  drawerOpen: false,
});

/**
 * The provider's about from an unchecked message port, or `null`.
 *
 * The HOST checked it against the allow-list at registration; this only
 * refuses a shape that is not two strings, so a malformed message reads as
 * "none registered" rather than as a throw (G3) or as `undefined undefined`.
 * A `status` that is not a string is left out (DoD 9.45).
 */
function providerOf(value: unknown): InsightsProviderAbout | null {
  if (typeof value !== 'object' || value === null) return null;
  const { name, version, status } = value as { name?: unknown; version?: unknown; status?: unknown };
  if (typeof name !== 'string' || typeof version !== 'string') return null;
  return typeof status === 'string' ? { name, version, status } : { name, version };
}

/** The three action names, and nothing else, from an unchecked port (DoD 9.45). */
const ACTIONS: readonly InsightsProviderAction[] = ['pickAgent', 'showPayload', 'clearHistory'];

function actionsOf(value: unknown): InsightsProviderAction[] {
  if (!Array.isArray(value)) return [];
  return ACTIONS.filter((action) => (value as unknown[]).includes(action));
}

export interface SidebarSource {
  /** The last state the host sent, or the defaults until one arrives. */
  get(): SidebarState;
  /** Register a change listener. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * A `sidebarState` message landed. Replaces the state WHOLE, never merges.
   *
   * A merge would need both sides to agree about what "unchanged" means, and
   * the message carries the whole state by design. Takes a partial shape
   * because the message port is not the contract — the webview's inbound
   * guard checks the `type` field and nothing else — so a malformed message
   * reads as the DEFAULTS for whatever it omits rather than as a throw (G3).
   */
  accept(next: Partial<SidebarState> | undefined): void;
  /** A row was operated: post `runCommand`. Writes nothing here. */
  run(command: string): void;
}

export function createSidebarSource(
  post: (message: RunCommandMessage) => void = () => {},
): SidebarSource {
  let state: SidebarState = EMPTY_SIDEBAR_STATE;
  const listeners = new Set<() => void>();

  return {
    get: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    accept(next: Partial<SidebarState> | undefined): void {
      state = {
        controls: next?.controls ?? EMPTY_SIDEBAR_STATE.controls,
        tweaks: next?.tweaks ?? EMPTY_SIDEBAR_STATE.tweaks,
        provider: providerOf(next?.provider),
        // No actions without a provider, whatever the message says: the rows
        // exist only while one is registered.
        insightsActions: providerOf(next?.provider) === null ? [] : actionsOf(next?.insightsActions),
        drawerOpen: next?.drawerOpen === true,
      };
      for (const listener of [...listeners]) listener();
    },
    run(command: string): void {
      post({ type: 'runCommand', command });
    },
  };
}
