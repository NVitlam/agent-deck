/**
 * The About entry — v0.9.0 DoD 9.7, spec `Amendment 2026-09-20`.
 *
 * ## The text is VERBATIM and it is here ONCE
 *
 * The amendment quotes the paragraph in full. It is a single exported constant
 * so that the spec and the product cannot drift: `about.test.ts` reads the
 * amendment out of `agent-deck-spec.md` and compares it to
 * {@link ABOUT_TEXT} character for character. Writing it a second time in a
 * component or a README would be two agreeing copies of a sentence, which is
 * the shape this repository records as "two agreeing literals is not a
 * contract".
 *
 * ## Every link opens through the EDITOR
 *
 * `vscode.env.openExternal` hands a URI to VS Code, which opens the user's
 * browser. **The extension opens no socket for any of these**, which is why
 * `SECURITY.md` can still say the extension makes no network call: handing a
 * URL to the editor is not making one, and `egress.test.ts`'s census of the
 * shipped bundle is unchanged by this file.
 *
 * Nothing here is fetched, nothing is checked for reachability, and no link is
 * built from a value that came off the wire.
 */

import type { AboutPageView } from './model/events.js';

/** One link the About entry offers. */
export interface AboutLink {
  /** What the user sees. */
  label: string;
  /** Where it goes. A literal, never composed from input. */
  url: string;
}

/**
 * The introduction, VERBATIM from spec `Amendment 2026-09-21 — About page
 * and Insights entries`, which supersedes the 2026-09-20 paragraph.
 *
 * In the deck's voice: facts about what the extension is and does, and no
 * advice. The 2026-09-20 text ended "you can support the project"; the
 * Sponsor tile says that without a sentence telling anybody what to do.
 *
 * Do not reflow it and do not "fix" its punctuation: `about.test.ts` compares
 * it to the amendment, so a change here without a change there is red, and a
 * change to both is a spec amendment, which is reserved to the user
 * (CLAUDE.md reserved decision 4).
 */
export const ABOUT_TEXT =
  'Agent Deck draws the sessions of Claude Code, Codex and OpenCode as a live deck, ' +
  'from what those agents already write to disk. ' +
  'It is read-only: it never launches, wraps or configures an agent, and it makes no network calls. ' +
  'Built by Nadav Vitlam, AI Specialist and Solution Architect, Israel.';

/**
 * The licence the footer names. `about.test.ts` holds it against
 * `package.json`'s `license`, so the page cannot name a licence the package
 * does not carry.
 */
export const ABOUT_LICENCE = 'MIT';

/**
 * The four links, in the order the amendment names them.
 *
 * 2026-09-21: "Website" is "Portfolio" and "Project" is "Repository". The
 * Repository tile goes to the source repository — `package.json`'s
 * `repository.url`, which `about.test.ts` holds it against — because a tile
 * called Repository that opened the project SITE would name one thing and
 * open another. The site stays reachable through the sidebar's "Get Agent
 * Deck Insights" entry and from the repository's own page.
 */
export const ABOUT_LINKS: readonly AboutLink[] = Object.freeze([
  Object.freeze({ label: 'Portfolio', url: 'https://nvitlam.github.io/' }),
  Object.freeze({ label: 'Repository', url: 'https://github.com/NVitlam/agent-deck' }),
  Object.freeze({ label: 'LinkedIn', url: 'https://www.linkedin.com/in/nadav-vitlam' }),
  Object.freeze({ label: 'Sponsor', url: 'https://github.com/sponsors/NVitlam' }),
]);

/**
 * Where "Get Agent Deck Insights" goes — spec `Amendment 2026-09-20 - Sidebar
 * shape` names this url, and `Amendment 2026-09-21 — One window` keeps it
 * ("subpage later"): it will point to a dedicated Insights subpage once the
 * site has one, and `about.test.ts` holds it against the amendment that says
 * so.
 *
 * HERE rather than in `extension.ts` since DoD 9.32: the About and Insights
 * surfaces both draw a Get tile that names this host, and the webview bundle
 * may not import the host. One literal, read by both.
 */
export const INSIGHTS_PAGE_URL = 'https://nvitlam.github.io/agent-deck/';

/** The Get tile, as a link the confirmation can name. */
export const INSIGHTS_GET_LINK: AboutLink = Object.freeze({
  label: 'Get Agent Deck Insights',
  url: INSIGHTS_PAGE_URL,
});

/** The host a link opens, as the confirmation names it. */
export function hostOf(url: string): string {
  return new URL(url).host;
}

/** The button on the confirmation. The only answer that opens anything. */
export const ABOUT_OPEN_BUTTON = 'Open';

/**
 * What the host asks before opening `link` — DoD 9.23.
 *
 * Here rather than in the host since DoD 9.32 moved About into the one panel:
 * the Insights surface's Get tile asks the same question, and one sentence
 * written once is one sentence to keep right.
 */
export function aboutConfirmation(link: AboutLink): { message: string; button: string } {
  return {
    message: `Agent Deck will open ${hostOf(link.url)} in your browser`,
    button: ABOUT_OPEN_BUTTON,
  };
}

/**
 * The About page as the host sends it — DoD 9.32.
 *
 * Labels and HOSTS, never urls: the webview renders this and posts an index
 * back, and only the host, which holds {@link ABOUT_LINKS}, opens anything.
 */
export function aboutPage(version: string | null): AboutPageView {
  return {
    text: ABOUT_TEXT,
    links: ABOUT_LINKS.map((link) => ({ label: link.label, host: hostOf(link.url) })),
    get: { label: INSIGHTS_GET_LINK.label, host: hostOf(INSIGHTS_GET_LINK.url) },
    footer: aboutFooter(version),
  };
}

/** The footer line. `version` is `null` when the host could not read one. */
export function aboutFooter(version: string | null): string {
  return version === null
    ? `Agent Deck · ${ABOUT_LICENCE} licence`
    : `Agent Deck ${version} · ${ABOUT_LICENCE} licence`;
}

/**
 * `package.json`'s `sponsor.url`, which VS Code renders as a Sponsor button on
 * the Marketplace listing.
 *
 * The same URL as the Sponsor link above, and `manifest.test.ts` asserts they
 * are equal rather than both being correct by coincidence.
 */
export const SPONSOR_URL = 'https://github.com/sponsors/NVitlam';

/** `agentDeck.about`. */
export const ABOUT_COMMAND = 'agentDeck.about';
