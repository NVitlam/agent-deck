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
 * ONE SURFACE AGAIN (v0.9.0 DoD 9.14). The activity-bar sidebar loaded this
 * same bundle from v0.7.0 until v0.9.0; spec `Amendment 2026-09-20 — Clean
 * windows` replaces it with a native `TreeView`, which the editor draws
 * itself. What is left here is the panel, and `WEBVIEW_ROOT_ID` is the only
 * root this module looks for.
 */

import type { WebviewToHostMessage } from '../src/model/events.js';
import App from './App.svelte';
import { createStore } from './store.js';
import type { Store } from './store.js';
import { mount, unmount } from 'svelte';
import { WEBVIEW_ROOT_ID } from '../src/bridge/contract.js';

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

/*
 * `startSidebar` was here until v0.9.0 DoD 9.14.
 *
 * The sidebar was a webview with two tabs of controls, and spec
 * `Amendment 2026-09-20 — Clean windows` moves every control into the
 * editor's own menus. A webview whose whole content was controls has nothing
 * left to draw, so the surface is deleted and `src/sidebar/tree.ts` — a
 * native `TreeView` — stands in the same slot.
 *
 * This bundle therefore has ONE surface again, which is why the mount below
 * no longer looks for a sidebar root.
 */

// Auto-start, but only inside a real VS Code webview.
//
// The container is `#${WEBVIEW_ROOT_ID}`, and `document.body` otherwise. That
// fallback removes a silent cross-package dependency: the extension host owns
// the webview HTML, and if this file required an element id the host did not
// happen to use, the panel would come up blank with no error anywhere.
//
// Gating on `acquireVsCodeApi` is what keeps this out of the tests: outside a
// webview the global is absent, so importing this module mounts nothing and
// `start()` stays explicit.
if (typeof globalThis.acquireVsCodeApi === 'function' && globalThis.document !== undefined) {
  const container =
    globalThis.document.getElementById(WEBVIEW_ROOT_ID) ?? globalThis.document.body;
  start(container);
}
