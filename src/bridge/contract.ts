/**
 * Constants shared by the extension host and the webview.
 *
 * This module exists because of a defect the Phase 3 partition produced and no
 * test on either side could catch. The host owns the webview's HTML and emitted
 * `<div id="app">`; the webview looked for `#agent-deck-root` and fell back to
 * `document.body`. Both packages were internally consistent, both were fully
 * tested, and they disagreed with each other — the fallback meant the panel
 * rendered anyway, into the wrong element, with the emitted div unused. A
 * silent seam, not a crash.
 *
 * The fix is a single definition rather than two agreeing literals, because two
 * agreeing literals is exactly what was already there.
 *
 * Like `apply.ts`, this file must stay importable from a CSP-strict browser
 * bundle, so it has **no imports at all**. It deliberately does NOT live in
 * `html.ts`, which imports `node:crypto` for its nonce and can therefore never
 * be reached from the webview.
 */

/**
 * The element the webview mounts into, and the only element the host's document
 * body contains.
 *
 * Specific rather than generic on purpose: `app` is the kind of id that
 * collides with whatever else ends up in the document.
 */
export const WEBVIEW_ROOT_ID = 'agent-deck-root';
