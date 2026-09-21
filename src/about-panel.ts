/**
 * The About PANEL — v0.9.0 DoD 9.14, redesigned by DoD 9.23 (spec `Amendment
 * 2026-09-21 — About page and Insights entries`).
 *
 * ## Why it was redesigned
 *
 * The user's own-eyes pass on `94c79db`: the page was bare text and four
 * outlined buttons on a blank canvas, and read as a different product from
 * the deck beside it. It now takes the deck's own look — the same VS Code
 * theme variables, fonts and background as `App.svelte`, so a light theme
 * and a dark one both come from the editor with nothing of its own to get
 * wrong — and the four links are TILES drawn like a session card: the same
 * border, radius, fill and hover, plus a state-colour edge.
 *
 * The layout is three blocks: an introduction, a row of tiles, and a footer
 * line naming the version and the licence.
 *
 * ## The index is the join, and it is checked at the boundary
 *
 * The page posts the tile's INDEX. {@link aboutLinkFor} is the one place that
 * turns an index into a link, and it refuses anything that is not an integer
 * inside the array — so a message from a renderer cannot name a URL, it can
 * only name one of ours.
 *
 * ## Confirm, then open
 *
 * A click does not open the browser. The host first shows an information
 * message, "Agent Deck will open <host> in your browser", with an Open
 * button ({@link aboutConfirmation}); only that button reaches
 * `vscode.env.openExternal`. Dismissing it, or letting it time out, opens
 * nothing. `openExternal` hands the URL to the EDITOR: this extension opens
 * no socket for it, which is what lets `SECURITY.md` still say it makes no
 * network call.
 *
 * `about-panel.test.ts` drives the page in jsdom and pins its DOM against a
 * golden; `extension.test.ts` drives the confirm-then-open sequence through
 * the real command.
 */

import type { AboutLink } from './about.js';
import { ABOUT_LICENCE, ABOUT_LINKS, ABOUT_TEXT, hostOf } from './about.js';

/** The `createWebviewPanel` view type. */
export const ABOUT_PANEL_VIEW_TYPE = 'agentDeck.aboutPanel';

/** The panel's tab title. */
export const ABOUT_PANEL_TITLE = 'Agent Deck — About';

/** The button on the confirmation. The only answer that opens anything. */
export const ABOUT_OPEN_BUTTON = 'Open';

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

/** What the host asks before opening `link`. */
export function aboutConfirmation(link: AboutLink): { message: string; button: string } {
  return {
    message: `Agent Deck will open ${hostOf(link.url)} in your browser`,
    button: ABOUT_OPEN_BUTTON,
  };
}

/** The footer line. `version` is `null` when the host could not read one. */
export function aboutFooter(version: string | null): string {
  return version === null
    ? `Agent Deck · ${ABOUT_LICENCE} licence`
    : `Agent Deck ${version} · ${ABOUT_LICENCE} licence`;
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
 * The page's stylesheet.
 *
 * Exported so `about-panel.test.ts` can hold it against the deck's own
 * sources: the body takes `App.svelte`'s theme variables and the tile takes
 * `SessionCell.svelte`'s border, fill and hover variables, and a test reads
 * both files rather than trusting this comment.
 *
 * The tile is the card's footprint (220 × 88, radius 10). Its left edge is
 * the card's state channel: the cool colour at rest, the warm live colour on
 * hover and focus. Hover brightens the border and does nothing else — no
 * scale, no shadow — for the card's own reason: nothing on the row moves.
 */
export const ABOUT_PANEL_CSS = `
      body {
        margin: 0;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        font-family: var(--vscode-font-family, sans-serif);
        font-size: var(--vscode-font-size, 13px);
      }
      main {
        display: flex;
        flex-direction: column;
        gap: 24px;
        padding: 32px 24px;
        max-width: 60em;
      }
      h1 { margin: 0 0 8px; font-size: 1.6em; font-weight: 600; }
      .intro p { margin: 0; max-width: 46em; line-height: 1.6; }
      .tiles { display: flex; flex-wrap: wrap; gap: 16px; }
      .tile {
        box-sizing: border-box;
        width: 220px;
        min-height: 88px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 6px;
        padding: 12px 16px;
        text-align: left;
        font: inherit;
        color: inherit;
        cursor: pointer;
        background: var(--vscode-editorWidget-background, transparent);
        border: 1px solid var(--vscode-panel-border, currentColor);
        border-left: 3px solid var(--vscode-charts-blue, currentColor);
        border-radius: 10px;
      }
      .tile:hover, .tile:focus-visible {
        border-color: var(--vscode-focusBorder, currentColor);
        border-left-color: var(--vscode-charts-yellow, currentColor);
      }
      .tile:focus-visible { outline: 1px solid var(--vscode-focusBorder, currentColor); outline-offset: 2px; }
      .label { font-weight: 600; }
      .host {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 0.88em;
        color: var(--vscode-descriptionForeground, inherit);
      }
      footer {
        font-size: 0.88em;
        color: var(--vscode-descriptionForeground, inherit);
        border-top: 1px solid var(--vscode-panel-border, transparent);
        padding-top: 12px;
      }
`;

/**
 * The document.
 *
 * ONE INLINE NONCED SCRIPT and no bundle: the page is a paragraph, four tiles
 * and a line, and giving it a build step would be a build step maintained for
 * forty lines. The CSP is the same shape `bridge/html.ts` argues for — no
 * `connect-src`, so the page cannot open a socket even if something in it
 * tried — and the tiles are BUTTONS rather than anchors, deliberately: an
 * `<a href>` in a webview is opened by the editor directly, which would skip
 * the confirmation and leave `env.openExternal` uncalled.
 */
export function aboutPanelHtml(nonce: string, cspSource: string, version: string | null): string {
  const tiles = ABOUT_LINKS.map(
    (link, index) =>
      `<button type="button" class="tile" data-testid="about-link" data-index="${String(index)}">` +
      `<span class="label" data-testid="about-link-label">${escapeHtml(link.label)}</span>` +
      `<span class="host" data-testid="about-link-host">${escapeHtml(hostOf(link.url))}</span>` +
      `</button>`,
  ).join('\n        ');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' ${cspSource};"
    />
    <title>${escapeHtml(ABOUT_PANEL_TITLE)}</title>
    <style nonce="${nonce}">${ABOUT_PANEL_CSS}</style>
  </head>
  <body>
    <main data-testid="about">
      <section class="intro" data-testid="about-intro">
        <h1>Agent Deck</h1>
        <p data-testid="about-text">${escapeHtml(ABOUT_TEXT)}</p>
      </section>
      <nav class="tiles" data-testid="about-links" aria-label="Links">
        ${tiles}
      </nav>
      <footer data-testid="about-footer">${escapeHtml(aboutFooter(version))}</footer>
    </main>
    <script nonce="${nonce}">
      // An IIFE, so the page leaks no global of its own. It also makes the
      // script re-runnable in one document, which is what lets a test mount
      // the real page more than once without a redeclaration error.
      (function () {
        var api = acquireVsCodeApi();
        var tiles = document.querySelectorAll('[data-testid="about-link"]');
        for (var i = 0; i < tiles.length; i += 1) {
          (function (tile) {
            tile.addEventListener('click', function () {
              api.postMessage({ type: 'aboutLink', index: Number(tile.dataset.index) });
            });
          })(tiles[i]);
        }
      })();
    </script>
  </body>
</html>
`;
}
