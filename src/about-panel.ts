/**
 * The About PANEL — v0.9.0 DoD 9.14, spec `Amendment 2026-09-20 — Clean
 * windows` (ruling: "About is a command that opens a panel").
 *
 * ## Why a panel and not the modal that shipped
 *
 * v0.9.0 shipped About as `showInformationMessage({ modal: true })` with the
 * four links as BUTTONS, and the button that opened it was dead — a panel
 * `runCommand` was validated against the sidebar's five-entry list, so
 * `agentDeck.about` never reached the handler that allowed it. The command
 * itself worked from the palette; nothing else could reach it.
 *
 * A modal is also the wrong surface for four links: it stacks them as buttons,
 * it cannot show a paragraph and a link list as one thing, and its return
 * value is a LABEL, so the lookup that turns a press into a URL is a string
 * comparison against text the editor handed back. A verifier round has already
 * broken exactly that lookup — replacing it with `ABOUT_LINKS[0]`, so every
 * link opened the Website URL, left 307 tests green, because nothing drove it.
 *
 * ## The index is the join, and it is checked at the boundary
 *
 * The panel posts the link's INDEX. {@link aboutLinkFor} is the one place that
 * turns an index into a link, and it refuses anything that is not an integer
 * inside the array — so a message from a renderer cannot name a URL, it can
 * only name one of ours. The URL is then handed to `vscode.env.openExternal`,
 * i.e. to the EDITOR: this extension opens no socket for it, which is what
 * lets `SECURITY.md` still say it makes no network call.
 *
 * `about-panel.test.ts` drives the WHOLE path: it renders this document into
 * jsdom, clicks each of the four links, reads what the page posted, feeds that
 * to {@link aboutLinkFor}, and asserts four DISTINCT urls — so the constant
 * mutation that survived last time dies at the first link that is not the
 * Website.
 */

import type { AboutLink } from './about.js';
import { ABOUT_LINKS, ABOUT_TEXT } from './about.js';

/** The `createWebviewPanel` view type. */
export const ABOUT_PANEL_VIEW_TYPE = 'agentDeck.aboutPanel';

/** The panel's tab title. */
export const ABOUT_PANEL_TITLE = 'Agent Deck — About';

/** The message the panel posts. One type, one field. */
export interface AboutLinkMessage {
  type: 'aboutLink';
  index: number;
}

/**
 * The link an inbound message names, or `undefined`.
 *
 * THE UNTRUSTED BOUNDARY. The next thing a caller does with the answer is
 * hand it to the editor to open, so this refuses everything that is not an
 * integer index into our own array: no negative, no fractional, no
 * out-of-range, no string that looks like a number, and nothing carrying a
 * url of its own.
 */
export function aboutLinkFor(raw: unknown): AboutLink | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value['type'] !== 'aboutLink') return undefined;
  const index = value['index'];
  if (typeof index !== 'number' || !Number.isInteger(index)) return undefined;
  if (index < 0 || index >= ABOUT_LINKS.length) return undefined;
  return ABOUT_LINKS[index];
}

/** Minimal HTML-text escaping. Our own literals, escaped anyway. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The document.
 *
 * ONE INLINE NONCED SCRIPT and no bundle: the page is a paragraph and four
 * links, and giving it a build step would be a build step maintained for
 * forty lines. The CSP is the same shape `bridge/html.ts` argues for — no
 * `connect-src`, so the page cannot open a socket even if something in it
 * tried — and the links are BUTTONS rather than anchors, deliberately: an
 * `<a href>` in a webview is opened by the editor directly, which would leave
 * `env.openExternal` uncalled and the test asserting it vacuous.
 */
export function aboutPanelHtml(nonce: string, cspSource: string): string {
  const links = ABOUT_LINKS.map(
    (link, index) =>
      `<button type="button" class="link" data-testid="about-link" data-index="${String(index)}" data-url="${escapeHtml(link.url)}">${escapeHtml(link.label)}</button>`,
  ).join('\n      ');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' ${cspSource};"
    />
    <title>${escapeHtml(ABOUT_PANEL_TITLE)}</title>
    <style nonce="${nonce}">
      body {
        font-family: var(--vscode-font-family, sans-serif);
        color: var(--vscode-foreground, #ccc);
        margin: 0;
        padding: 24px;
        max-width: 46em;
        line-height: 1.6;
      }
      p { margin: 0 0 20px; }
      .links { display: flex; flex-wrap: wrap; gap: 10px; }
      .link {
        font: inherit;
        color: var(--vscode-textLink-foreground, #4daafc);
        background: none;
        border: 1px solid currentColor;
        border-radius: 4px;
        padding: 4px 12px;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <p data-testid="about-text">${escapeHtml(ABOUT_TEXT)}</p>
    <div class="links" data-testid="about-links">
      ${links}
    </div>
    <script nonce="${nonce}">
      // An IIFE, so the page leaks no global of its own. It also makes the
      // script re-runnable in one document, which is what lets a test mount
      // the real page more than once without a redeclaration error.
      (function () {
        var api = acquireVsCodeApi();
        var buttons = document.querySelectorAll('[data-testid="about-link"]');
        for (var i = 0; i < buttons.length; i += 1) {
          (function (button) {
            button.addEventListener('click', function () {
              api.postMessage({ type: 'aboutLink', index: Number(button.dataset.index) });
            });
          })(buttons[i]);
        }
      })();
    </script>
  </body>
</html>
`;
}
