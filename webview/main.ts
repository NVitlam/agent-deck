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
 * TWO SURFACES, ONE BUNDLE. The activity-bar sidebar loads this same script.
 * Which surface mounts is decided by which root the host's document carries:
 * `SIDEBAR_ROOT_ID` mounts the sidebar's four pages and `WEBVIEW_ROOT_ID`
 * mounts the app. One bundle means one CSP, one egress guard and one
 * stylesheet cover both, which is what spec §G2's "same bundle rules" asks
 * for.
 *
 * (v0.9.0 DoD 9.14 made this one surface for half a day, when the sidebar was
 * a native `TreeView`. `Amendment 2026-09-20 — Sidebar shape` supersedes that
 * ruling and the second surface is back.)
 */

import type { SidebarStateMessage, WebviewToHostMessage } from '../src/model/events.js';
import App from './App.svelte';
import Sidebar from './sidebar/Sidebar.svelte';
import { createSidebarSource } from './sidebar/source.js';
import { createStore } from './store.js';
import type { Store } from './store.js';
import { mount, unmount } from 'svelte';
import { SIDEBAR_ROOT_ID, WEBVIEW_ROOT_ID } from '../src/bridge/contract.js';

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
 * Start the SIDEBAR against a container — v0.9.0 DoD 9.17.
 *
 * NO STORE. Session data never reaches this surface: it takes exactly one
 * message type, `sidebarState`, and drops everything else that arrives on its
 * port. The one thing it sends is `runCommand`, whose id the host validates
 * against the same table this surface rendered it from (DoD 9.18).
 *
 * Exported for the same reason {@link start} is — the harness drives exactly
 * what VS Code drives, so the boundary test can click a real row and watch a
 * real host act on it.
 */
export function startSidebar(target: HTMLElement, api: VsCodeApi = acquireApi()): {
  dispose: () => void;
} {
  const source = createSidebarSource((message) => api.postMessage(message));
  const sidebar = mount(Sidebar, { target, props: { source } });

  const onMessage = (event: MessageEvent<unknown>): void => {
    // Same guard as the panel's, and for the same reason (G3): the sidebar
    // must survive anything that reaches its message port. Everything but
    // `sidebarState` is dropped — there is no session data on this surface.
    if (!isHostMessage(event.data)) return;
    if (event.data.type !== 'sidebarState') return;
    const message: SidebarStateMessage = event.data;
    source.accept({
      controls: message.controls,
      tweaks: message.tweaks,
      provider: message.provider,
      // DoD 9.45. This forward was MISSING on the first build of round 6 and
      // the rows under Open Insights never drew — the forwarding-site class,
      // caught by `sidebar.test.ts` driving the shipped bundle.
      insightsActions: message.insightsActions,
      drawerOpen: message.drawerOpen,
    });
  };
  globalThis.addEventListener('message', onMessage);

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
// mounting a control surface into a stray body is the wrong surface, not a
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
