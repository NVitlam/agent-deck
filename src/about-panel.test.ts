// @vitest-environment jsdom
/// <reference lib="dom" />
/*
 * THE HOST PROJECT HAS NO DOM LIB, deliberately: `tsconfig.json` covers
 * `src/` and nothing there may touch a browser global. This file is the one
 * exception and it is a TEST — it renders the About page in jsdom, which is
 * the only way to drive the page's own click handlers — so the lib is pulled
 * in HERE, for this file, rather than widened for the whole project.
 */
/**
 * About — v0.9.0 DoD 9.14, the amendment's "About is a command that opens a
 * panel … a test drives the command through a real panel and asserts the
 * links call `env.openExternal`".
 *
 * ## Why this file exists at all
 *
 * v0.9.0 shipped About twice over and neither worked end to end. The BUTTON
 * was dead: the panel posted `runCommand`, and `isWebviewToHostMessage`
 * validated it against the SIDEBAR's five-entry menu list, which never held
 * `agentDeck.about` — so the message was dropped at the boundary and the
 * handler that allowed it was unreachable. And the COMMAND had no
 * behavioural test at all: `TESTID.aboutLink` appeared twice in the whole
 * tree, in the component and in the contract, and nothing clicked it. A
 * verifier round replaced the label→link lookup with `ABOUT_LINKS[0]`, so
 * every link opened the Website url, and 307 tests stayed green.
 *
 * ## So both layers are driven, and the join is an INDEX
 *
 * The page posts the link's index; {@link aboutLinkFor} is the one place that
 * turns an index into a url. This file renders the real document into jsdom,
 * clicks each of the four links, reads what the page posted, feeds that
 * through the real boundary, and asserts FOUR DISTINCT urls — so a constant
 * dies at the first link that is not the Website. Then it runs the real
 * command through the real handler and asserts the same four reach
 * `vscode.env.openExternal`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ABOUT_LICENCE, ABOUT_LINKS, ABOUT_TEXT, hostOf } from './about.js';
import {
  ABOUT_OPEN_BUTTON,
  ABOUT_PANEL_CSS,
  ABOUT_PANEL_TITLE,
  ABOUT_PANEL_VIEW_TYPE,
  aboutConfirmation,
  aboutFooter,
  aboutLinkFor,
  aboutPanelHtml,
} from './about-panel.js';

/**
 * The version the golden is rendered with. A FIXED string, not the
 * manifest's: a golden that moved with every version bump would be a golden
 * nobody reads. The real version reaching the real footer is asserted in
 * `extension.test.ts`, through `activate()`.
 */
const GOLDEN_VERSION = '9.9.9';

const GOLDEN_FILE = resolve('webview/goldens/about/panel.dom.txt');
const UPDATING = process.env['AGENT_DECK_UPDATE_ABOUT_GOLDEN'] === '1';

/** One line per element: indent, tag, classes, testid/role/aria, own text. */
function outline(el: Element, depth: number, lines: string[]): string[] {
  const parts = [`${'  '.repeat(depth)}${el.tagName.toLowerCase()}`];
  for (const cls of Array.from(el.classList)) parts.push(`.${cls}`);
  const kept = ['aria-label', 'data-index', 'data-testid', 'role', 'type'];
  const attrs = Array.from(el.attributes)
    .filter((a) => kept.includes(a.name))
    .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
    .sort();
  parts.push(...attrs);
  let own = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) own += node.textContent ?? '';
  }
  own = own.replace(/\s+/g, ' ').trim();
  if (own !== '') parts.push(JSON.stringify(own));
  lines.push(parts.join(' '));
  for (const child of Array.from(el.children)) outline(child, depth + 1, lines);
  return lines;
}

/* ------------------------------------------------------------------------ *
 * The document, in a browser
 * ------------------------------------------------------------------------ */

interface Posted {
  type?: unknown;
  index?: unknown;
}

/** Render the real document and return what its links post when clicked. */
function clickEveryLink(): { labels: string[]; posted: Posted[] } {

  const html = aboutPanelHtml('TESTNONCE', 'vscode-webview://cspSource', GOLDEN_VERSION);
  /*
   * The page's own head, body and SCRIPT, into the live document.
   *
   * `document.write` would be closer to a real load and jsdom resets the
   * global scope for it, so `acquireVsCodeApi` disappears before the inline
   * script can call it. Re-creating the script element runs the page's own
   * source against the page's own markup, which is the property that matters:
   * a test that hand-wired the click handlers would be asserting its own
   * wiring rather than the page's.
   */
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;

  /*
   * The editor's `acquireVsCodeApi`, installed by a SCRIPT rather than by
   * assignment.
   *
   * An inline script runs in the jsdom window's own scope, and a property
   * set from the test's `globalThis` — or from its `window` — does not reach
   * it: the first two drafts of this file got `acquireVsCodeApi is not
   * defined` from a page that is perfectly correct. A prelude script shares
   * the page's scope by construction.
   */
  const prelude = document.createElement('script');
  prelude.textContent =
    'window.__aboutPosted = []; ' +
    'window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__aboutPosted.push(m) });';
  document.body.appendChild(prelude);

  const source = parsed.querySelector('script')?.textContent ?? '';
  if (source.trim() === '') throw new Error('the page has no inline script');
  const script = document.createElement('script');
  script.textContent = source;
  document.body.appendChild(script);

  // `Array.from`, not a spread: the host project's lib set has no DOM
  // iterator on `NodeListOf`, and this file pulls the lib in for itself.
  const buttons = Array.from(document.querySelectorAll('[data-testid="about-link"]'));
  const labels = buttons.map(
    (button) => button.querySelector('[data-testid="about-link-label"]')?.textContent ?? '',
  );
  for (const button of buttons) button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  /*
   * READ BACK THROUGH THE DOM, not through `window`.
   *
   * The page's script and this test do not share a global object — vitest's
   * `window` is not the one jsdom runs inline scripts in — so what the page
   * pushed onto its own global is invisible here. The DOCUMENT is shared, so
   * a second script serialises the array onto an attribute and this reads it
   * from the element. Roundabout, and it is the only handle both sides have.
   */
  const readback = document.createElement('script');
  readback.textContent =
    "document.body.setAttribute('data-posted', JSON.stringify(window.__aboutPosted || []));";
  document.body.appendChild(readback);
  const posted = JSON.parse(document.body.getAttribute('data-posted') ?? '[]') as Posted[];
  return { labels, posted };
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

afterEach(() => {
  delete (window as unknown as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
  delete (window as unknown as { __aboutPosted?: unknown }).__aboutPosted;
});

describe('the page', () => {
  it('carries the About introduction verbatim and the four labels, in order', () => {
    const { labels } = clickEveryLink();
    expect(document.querySelector('[data-testid="about-text"]')?.textContent).toBe(ABOUT_TEXT);
    expect(labels).toStrictEqual(ABOUT_LINKS.map((link) => link.label));
  });

  it('posts ONE index per link, and they are the four distinct indices', () => {
    const { posted } = clickEveryLink();
    expect(posted).toStrictEqual(
      ABOUT_LINKS.map((_link, index) => ({ type: 'aboutLink', index })),
    );
  });

  it('a click resolves to that link’s OWN url — four distinct, through the real boundary', () => {
    /*
     * THE MUTATION THIS KILLS: `ABOUT_LINKS[0]` for every link. It survived
     * a whole release, because the only thing that had ever been asserted
     * was that a lookup existed.
     */
    const { posted } = clickEveryLink();
    const urls = posted.map((message) => aboutLinkFor(message)?.url);
    expect(urls).toStrictEqual(ABOUT_LINKS.map((link) => link.url));
    expect(new Set(urls).size).toBe(ABOUT_LINKS.length);
  });

  it('loads no script and no style from anywhere, and opens no socket', () => {
    const { posted } = clickEveryLink();
    expect(posted.length).toBeGreaterThan(0);
    // G5: the page is self-contained. No `src`, no `href`, and the CSP has
    // no `connect-src`, so `default-src 'none'` denies fetch and WebSocket.
    expect(document.querySelectorAll('script[src]')).toHaveLength(0);
    expect(document.querySelectorAll('link[href]')).toHaveLength(0);
    expect(document.querySelectorAll('img')).toHaveLength(0);
    const csp = document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content');
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('connect-src');
    expect(csp).toContain("script-src 'nonce-TESTNONCE'");
  });

  it('uses BUTTONS, not anchors — or `openExternal` would never be called', () => {
    // An `<a href>` in a webview is opened by the editor directly, which
    // would leave the assertion below vacuous: it would pass while the
    // extension did nothing at all.
    clickEveryLink();
    expect(document.querySelectorAll('a[href]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-testid="about-link"]')).toHaveLength(
      ABOUT_LINKS.length,
    );
  });
});

/* ------------------------------------------------------------------------ *
 * The deck-themed layout — DoD 9.23
 * ------------------------------------------------------------------------ */

describe('the layout: intro, tiles, footer — DoD 9.23', () => {
  it('matches the committed DOM golden', () => {
    clickEveryLink();
    const root = document.querySelector('[data-testid="about"]');
    expect(root, 'the page has no [data-testid="about"] root').not.toBeNull();
    /*
     * The introduction is replaced by a TOKEN in the golden. It names the
     * author, and a golden under `webview/` is not a path the privacy sweep
     * exempts: the first commit of this file carried the name and the sweep's
     * history leg refused it. The text is held verbatim three other ways —
     * against the spec amendment (`about.test.ts`), in the rendered page
     * (above), and through `activate()` (`extension.test.ts`) — so the golden
     * pins the STRUCTURE and loses nothing. The replacement is asserted to
     * have happened exactly once, so a changed text cannot slip past as a
     * token that no longer matches anything.
     */
    const raw = `${outline(root as Element, 0, []).join('\n')}\n`;
    const quoted = JSON.stringify(ABOUT_TEXT);
    expect(raw.split(quoted).length - 1, 'the introduction is not in the page exactly once').toBe(1);
    const actual = raw.split(quoted).join('"<ABOUT_TEXT>"');
    if (UPDATING) {
      mkdirSync(resolve('webview/goldens/about'), { recursive: true });
      writeFileSync(GOLDEN_FILE, actual, 'utf8');
    }
    expect(existsSync(GOLDEN_FILE), 'webview/goldens/about/panel.dom.txt is missing').toBe(true);
    // Line endings normalised on BOTH sides: the recorded CRLF-checkout trap.
    expect(
      actual.replace(/\r\n/g, '\n'),
      'webview/goldens/about/panel.dom.txt is stale — re-run with ' +
        'AGENT_DECK_UPDATE_ABOUT_GOLDEN=1 if the change is intended',
    ).toBe(readFileSync(GOLDEN_FILE, 'utf8').replace(/\r\n/g, '\n'));
  });

  it('the golden is not being written by this run', () => {
    expect(UPDATING, 'AGENT_DECK_UPDATE_ABOUT_GOLDEN is set: the golden was REWRITTEN').toBe(false);
  });

  it('the three blocks come in order: intro, then tiles, then footer', () => {
    clickEveryLink();
    const root = document.querySelector('[data-testid="about"]');
    const order = Array.from(root?.children ?? []).map((el) => el.getAttribute('data-testid'));
    expect(order).toStrictEqual(['about-intro', 'about-links', 'about-footer']);
  });

  it('each tile names its label AND the host it opens', () => {
    clickEveryLink();
    const tiles = Array.from(document.querySelectorAll('[data-testid="about-link"]'));
    expect(
      tiles.map((tile) => [
        tile.querySelector('[data-testid="about-link-label"]')?.textContent,
        tile.querySelector('[data-testid="about-link-host"]')?.textContent,
      ]),
    ).toStrictEqual(ABOUT_LINKS.map((link) => [link.label, hostOf(link.url)]));
  });

  it('the footer names the version and the MIT licence', () => {
    clickEveryLink();
    expect(document.querySelector('[data-testid="about-footer"]')?.textContent).toBe(
      `Agent Deck ${GOLDEN_VERSION} · MIT licence`,
    );
    expect(ABOUT_LICENCE).toBe('MIT');
    // An unread version is left out, never guessed.
    expect(aboutFooter(null)).toBe('Agent Deck · MIT licence');
  });

  it('the body takes the DECK’s theme variables, read from App.svelte', () => {
    /*
     * "Same CSS variables, fonts and dark/light handling as the deck". The
     * deck has no palette of its own — every colour is a VS Code theme
     * variable, so the editor's light and dark themes both arrive through
     * them — and this reads the deck's `.app` rule rather than a list typed
     * here, so a later change to the deck that the page does not follow is
     * red.
     */
    const app = readFileSync(resolve('webview/App.svelte'), 'utf8');
    for (const declaration of [
      'color: var(--vscode-foreground)',
      'background: var(--vscode-editor-background)',
      'font-family: var(--vscode-font-family, sans-serif)',
      'font-size: var(--vscode-font-size, 13px)',
    ]) {
      expect(app, `the deck no longer declares ${declaration}`).toContain(declaration);
      expect(ABOUT_PANEL_CSS, `the About body lacks ${declaration}`).toContain(declaration);
    }
  });

  it('a tile takes the SESSION CARD’s border, fill, radius, hover and state colours', () => {
    const card = readFileSync(resolve('webview/SessionCell.svelte'), 'utf8');
    // Border and fill: `.border`. Hover: `.cell:hover .border`. The state
    // edge: the live (warm) and ended (cool) strokes.
    for (const variable of [
      '--vscode-editorWidget-background',
      '--vscode-panel-border',
      '--vscode-focusBorder',
      '--vscode-charts-yellow',
      '--vscode-charts-blue',
    ]) {
      expect(card, `the session card no longer uses ${variable}`).toContain(`var(${variable}`);
      expect(ABOUT_PANEL_CSS, `the tile does not use ${variable}`).toContain(`var(${variable}`);
    }
    // The card's corner radius and footprint, stated as constants there.
    expect(card).toMatch(/const RADIUS = 10;/);
    expect(ABOUT_PANEL_CSS).toContain('border-radius: 10px;');
    expect(card).toMatch(/220 x 88/);
    expect(ABOUT_PANEL_CSS).toContain('width: 220px;');
    expect(ABOUT_PANEL_CSS).toContain('min-height: 88px;');
    // Hover brightens the border and nothing else, as the card's does. Read
    // from the RULES, not the whole sheet: `--vscode-focusBorder` also sits
    // in the focus outline, so a sheet-wide containment passed with the
    // hover rule's border colour deleted (mutation A4, 2026-09-21).
    expect(card).toMatch(
      /\.cell:hover \.border \{[^}]*stroke: var\(--vscode-focusBorder, currentColor\);/,
    );
    const hover = /\.tile:hover, \.tile:focus-visible \{([^}]*)\}/.exec(ABOUT_PANEL_CSS)?.[1] ?? '';
    expect(hover, 'the tile has no hover rule').not.toBe('');
    expect(hover).toContain('border-color: var(--vscode-focusBorder, currentColor);');
    expect(hover).toContain('border-left-color: var(--vscode-charts-yellow, currentColor);');
    // The resting edge is the COOL state colour; hover turns it WARM.
    const tile = /\n {6}\.tile \{([^}]*)\}/.exec(ABOUT_PANEL_CSS)?.[1] ?? '';
    expect(tile).toContain('border-left: 3px solid var(--vscode-charts-blue, currentColor);');
    expect(ABOUT_PANEL_CSS).not.toMatch(/transform|box-shadow/);
  });
});

describe('the confirmation — DoD 9.23', () => {
  it('names the host the link opens, with one Open button', () => {
    expect(ABOUT_LINKS.map((link) => aboutConfirmation(link))).toStrictEqual(
      ABOUT_LINKS.map((link) => ({
        message: `Agent Deck will open ${new URL(link.url).host} in your browser`,
        button: 'Open',
      })),
    );
    expect(ABOUT_OPEN_BUTTON).toBe('Open');
    // A literal for one of them, so the check above is not only the
    // implementation's own `new URL(...).host` read back to itself.
    expect(aboutConfirmation(ABOUT_LINKS[1] as (typeof ABOUT_LINKS)[number]).message).toBe(
      'Agent Deck will open github.com in your browser',
    );
  });
});

/* ------------------------------------------------------------------------ *
 * The boundary
 * ------------------------------------------------------------------------ */

describe('`aboutLinkFor` refuses everything that is not one of our indices', () => {
  it('answers each real index', () => {
    for (const [index, link] of ABOUT_LINKS.entries()) {
      expect(aboutLinkFor({ type: 'aboutLink', index })?.url, String(index)).toBe(link.url);
    }
  });

  it('answers nothing for a hostile or malformed message', () => {
    // The caller's next act is to hand the answer to the editor to OPEN, so
    // a message must not be able to name a url of its own.
    for (const hostile of [
      { type: 'aboutLink', index: -1 },
      { type: 'aboutLink', index: ABOUT_LINKS.length },
      { type: 'aboutLink', index: 1.5 },
      { type: 'aboutLink', index: '0' },
      { type: 'aboutLink', index: Number.NaN },
      { type: 'aboutLink' },
      { type: 'aboutLink', index: 0, url: 'https://example.invalid/' },
      { type: 'runCommand', index: 0 },
      'aboutLink',
      null,
      undefined,
      [{ type: 'aboutLink', index: 0 }],
    ]) {
      const answer = aboutLinkFor(hostile);
      if (
        typeof hostile === 'object' &&
        hostile !== null &&
        !Array.isArray(hostile) &&
        (hostile as { url?: string }).url !== undefined
      ) {
        // A message carrying a url of its own is still answered from OUR
        // array, by its index — the url it brought is ignored, never used.
        expect(answer?.url).toBe(ABOUT_LINKS[0]?.url);
        continue;
      }
      expect(answer, JSON.stringify(hostile)).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------------ */

describe('the panel’s identity', () => {
  it('has a view type of its own, distinct from the deck panel’s', () => {
    expect(ABOUT_PANEL_VIEW_TYPE).toBe('agentDeck.aboutPanel');
    expect(ABOUT_PANEL_VIEW_TYPE).not.toBe('agentDeck.panel');
    expect(ABOUT_PANEL_TITLE).toContain('Agent Deck');
  });
});
