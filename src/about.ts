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

/** One link the About entry offers. */
export interface AboutLink {
  /** What the user sees. */
  label: string;
  /** Where it goes. A literal, never composed from input. */
  url: string;
}

/**
 * The paragraph, VERBATIM from spec `Amendment 2026-09-20`.
 *
 * Do not reflow it and do not "fix" its punctuation: `about.test.ts` compares
 * it to the amendment, so a change here without a change there is red, and a
 * change to both is a spec amendment, which is reserved to the user
 * (CLAUDE.md reserved decision 4).
 */
export const ABOUT_TEXT =
  'Agent Deck is built by Nadav Vitlam, AI Specialist and Solution Architect, Israel. ' +
  'It is free, open source (MIT), read-only by design, and makes no network calls. ' +
  'If it saves you time, you can support the project.';

/** The four links, in the order the amendment names them. */
export const ABOUT_LINKS: readonly AboutLink[] = Object.freeze([
  Object.freeze({ label: 'Website', url: 'https://nvitlam.github.io/' }),
  Object.freeze({ label: 'Project', url: 'https://nvitlam.github.io/agent-deck/' }),
  Object.freeze({ label: 'LinkedIn', url: 'https://www.linkedin.com/in/nadav-vitlam' }),
  Object.freeze({ label: 'Sponsor', url: 'https://github.com/sponsors/NVitlam' }),
]);

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
