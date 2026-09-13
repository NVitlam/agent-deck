/**
 * Agent Deck webview — entry point.
 *
 * Wires three things and nothing else:
 *   host message  -> store
 *   store         -> App.svelte
 *   UI intent     -> host
 *
 * G5, zero egress: there is no `fetch`, no `XMLHttpRequest`, no `WebSocket`,
 * no `EventSource` and no dynamic remote import anywhere in this bundle. The
 * only channel out of the webview is `vscode.postMessage`, which is a
 * structured-clone hop to the extension host, not a socket.
 * `webview/bundle.test.ts` asserts that against the built artifact rather than
 * against this comment.
 *
 * G7, live only: no `localStorage`, no `sessionStorage`, no history. A reload
 * starts blank and waits for the host's snapshot.
 *
 * TWO SURFACES, ONE BUNDLE (v0.7.0 Phase 4, DoD 4.6b). The activity-bar
 * sidebar loads this same script. Which surface mounts is decided by which
 * root the host's document carries: `SIDEBAR_ROOT_ID` mounts the sidebar's two
 * tabs and `WEBVIEW_ROOT_ID` mounts the app. One bundle means one CSP, one egress
 * guard and one stylesheet cover both, which is what spec §G2's "same bundle
 * rules" asks for.
 */

import type { WebviewToHostMessage } from '../src/model/events.js';
import App from './App.svelte';
import Sidebar from './sidebar/Sidebar.svelte';
import { createTweaksSource } from './sidebar/tweaks-source.js';
import { createStore } from './store.js';
import type { Store } from './store.js';
import { mount, unmount } from 'svelte';
import { SIDEBAR_ROOT_ID, WEBVIEW_ROOT_ID } from '../src/bridge/contract.js';
import { SIDEBAR_MENU } from '../src/sidebar/menu.js';

/** The slice of the VS Code webview API this renderer uses. */
interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
}

declare global {
  // Injected by VS Code into the webview document; absent everywhere else.
  // `var` is required: `declare global` only accepts var for a global
  // binding, and `let`/`const` would not be visible on `globalThis`.
  var acquireVsCodeApi: (() => VsCodeApi) | undefined;
}

/**
 * Acquire the host bridge, or fall back to a sink.
 *
 * The guard is what makes this module importable in a test — and in a plain
 * browser — without VS Code. It is not error handling: `acquireVsCodeApi` may
 * be called exactly once per webview, so a wrapper is the only safe shape.
 */
export function acquireApi(): VsCodeApi {
  const acquire = globalThis.acquireVsCodeApi;
  if (typeof acquire === 'function') return acquire();
  return { postMessage: () => {} };
}

// The guard lives in `messages.ts` (no Svelte import) so a node test can
// compare it to the contract; re-exported here for every existing caller.
import { isHostMessage } from './messages.js';
export { HOST_MESSAGE_TYPES, isHostMessage } from './messages.js';

/**
 * Start the renderer against a container.
 *
 * Exported and parameterised so the same path a real webview takes can be
 * exercised in a test, rather than a second wiring existing only for tests.
 */
export function start(target: HTMLElement, api: VsCodeApi = acquireApi()): {
  store: Store;
  dispose: () => void;
} {
  const store = createStore((message: WebviewToHostMessage) => api.postMessage(message));

  const onMessage = (event: MessageEvent<unknown>): void => {
    // Unrecognised shapes are dropped, not thrown on: the webview must survive
    // anything that reaches its message port (G3).
    if (isHostMessage(event.data)) store.handleMessage(event.data);
  };
  globalThis.addEventListener('message', onMessage);

  const app = mount(App, { target, props: { store } });

  return {
    store,
    dispose: () => {
      globalThis.removeEventListener('message', onMessage);
      void unmount(app, { outro: false });
    },
  };
}

/**
 * Start the SIDEBAR against a container (DoD 4.6b; two tabs as of DoD 7.6).
 *
 * NO STORE, and it now takes ONE inbound message. Until v0.8.0 this function's
 * doc said "no store and no inbound messages", which was true of a surface
 * that was a list of buttons. The Tweaks tab renders four settings and the
 * amendment makes settings the source of truth, so the panel has to be told
 * what they are: the host's `settings` message — the same one the panel reads
 * for `canvasAutoFit`, not a second type — reaches
 * the sidebar's `TweaksSource`, and a control's position is whatever the last
 * one said. Session data still never reaches this surface, and no store is
 * constructed here.
 *
 * Exported for the same reason {@link start} is — the harness drives exactly
 * what VS Code drives.
 */
export function startSidebar(target: HTMLElement, api: VsCodeApi = acquireApi()): {
  dispose: () => void;
} {
  const source = createTweaksSource((message) => api.postMessage(message));

  const onMessage = (event: MessageEvent<unknown>): void => {
    // Same guard as the panel's, and for the same reason (G3): the sidebar
    // must survive anything that reaches its message port. Everything but
    // `settings` is dropped — there is no session data on this surface.
    if (!isHostMessage(event.data)) return;
    if (event.data.type !== 'settings') return;
    source.accept(event.data.tweaks);
  };
  globalThis.addEventListener('message', onMessage);

  const sidebar = mount(Sidebar, {
    target,
    props: {
      entries: SIDEBAR_MENU,
      onrun: (command: string) => {
        api.postMessage({ type: 'runCommand', command });
      },
      source,
    },
  });
  return {
    dispose: () => {
      globalThis.removeEventListener('message', onMessage);
      void unmount(sidebar, { outro: false });
    },
  };
}

// Auto-start, but only inside a real VS Code webview.
//
// The container is `#${SIDEBAR_ROOT_ID}` for the sidebar, `#${WEBVIEW_ROOT_ID}`
// for the panel, and `document.body` otherwise. That fallback removes a silent
// cross-package dependency: the extension host owns the webview HTML, and if
// this file required an element id the host did not happen to use, the panel
// would come up blank with no error anywhere. The sidebar has no fallback:
// mounting a command menu into a stray body is the wrong surface, not a
// degraded one.
//
// Gating on `acquireVsCodeApi` is what keeps this out of the tests: outside a
// webview the global is absent, so importing this module mounts nothing and
// `start()` stays explicit.
if (typeof globalThis.acquireVsCodeApi === 'function' && globalThis.document !== undefined) {
  const sidebar = globalThis.document.getElementById(SIDEBAR_ROOT_ID);
  if (sidebar !== null) {
    startSidebar(sidebar);
  } else {
    const container =
      globalThis.document.getElementById(WEBVIEW_ROOT_ID) ?? globalThis.document.body;
    start(container);
  }
}
