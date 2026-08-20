/**
 * Agent Deck — the webview document (spec v2 section 5, C7).
 *
 * One job: emit a CSP-strict HTML shell that loads a single local bundle and
 * can reach nothing else. The webview is a pure renderer; this file is where
 * "no fs, no network" stops being an intention and becomes a policy the
 * browser enforces.
 *
 * The policy, and why each directive is the way it is:
 *
 *   default-src 'none'    Everything is denied unless a later directive allows
 *                         it. This is the G5 enforcement point: `connect-src`
 *                         falls back to `default-src`, so with no `connect-src`
 *                         of our own, `fetch`, `XMLHttpRequest`, `WebSocket`
 *                         and `EventSource` are all blocked. There is
 *                         deliberately NO `connect-src` directive below —
 *                         adding one, even a narrow one, would be the moment
 *                         this extension gained an egress channel.
 *   base-uri 'none'       Not covered by default-src. A `<base>` element would
 *                         re-point every relative URL in the document.
 *   form-action 'none'    Not covered by default-src either, and a form POST is
 *                         a real exfiltration channel that survives every other
 *                         directive here.
 *   script-src 'nonce-N'  One nonce, fresh per load. No 'unsafe-inline', no
 *                         'unsafe-eval', no host source at all — not even
 *                         cspSource, so an unnonced script from our own origin
 *                         is refused too. That last property is load-bearing
 *                         and got MORE load-bearing once cspSource was
 *                         measured: VS Code's real value contains `'self'`, so
 *                         putting cspSource in script-src would permit any
 *                         same-origin script with no nonce at all. cspSource
 *                         stays out of script-src; a test pins that.
 *   style-src 'nonce-N' <cspSource>
 *                         The stylesheet ships as a file under the extension's
 *                         own resource root. The nonce is there so a bundled
 *                         `<style nonce>` also works without ever reaching for
 *                         'unsafe-inline'. This is the only directive
 *                         cspSource appears in, and a test pins that too.
 *
 * There is no `img-src` and no `font-src`. Both therefore fall back to
 * `default-src 'none'`, i.e. the webview cannot load an image or a font at all.
 * That is refusing rather than guessing: a renderer that turns out to need a
 * local icon should come back and widen this to `cspSource` explicitly, which
 * is a reviewable one-line change, rather than inherit a permission nobody
 * asked for.
 *
 * G1: nothing here writes a file. G5: nothing here opens a socket, and the
 * string it returns forbids the webview from opening one.
 */

import { randomBytes } from 'node:crypto';

/**
 * The element the webview bundle mounts into.
 *
 * Exported rather than left as a magic string in two repositories of
 * knowledge: the renderer needs the same id this document emits, and a
 * mismatch is a blank panel with no error anywhere.
 */
import { WEBVIEW_ROOT_ID } from './contract.js';

// Re-exported so the host keeps importing the mount id from the module that
// also emits the document. Defined in `contract.js`, which the webview can
// import and this file can not be.
export { WEBVIEW_ROOT_ID };

/** Bytes of entropy per nonce. 16 bytes = 128 bits, base64 to 24 chars. */
const NONCE_BYTES = 16;

/**
 * A fresh CSP nonce.
 *
 * `randomBytes`, not `Math.random`: a predictable nonce is the same as no
 * nonce. Call once per panel load — reusing one across loads would let a
 * cached script from a previous document satisfy the new policy.
 */
export function createNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64');
}

/** Base64 (standard alphabet, with padding). The nonce charset, and nothing else. */
const NONCE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * `cspSource` validation.
 *
 * MEASURED, not remembered. `vscode.Webview.cspSource` is a CSP **source
 * list**: a space-separated sequence of source expressions, not a single
 * origin. The getter, read out of the installed
 * `resources/app/out/vs/workbench/api/node/extensionHostProcess.js` at VS Code
 * 1.134.0 (commit 110a328ea54b42367b803ec53ee0bf52ef26b419), is:
 *
 *     const CDN = "vscode-cdn.net";
 *     const BASE = `'self' https://*.${CDN}`;
 *     get cspSource() {
 *       const loc = this.extensionLocation;
 *       if (loc.scheme === https || loc.scheme === http) {
 *         let e = loc.toString();
 *         if (!e.endsWith("/")) e += "/";
 *         return e + " " + BASE;
 *       }
 *       return BASE;
 *     }
 *
 * So the value we actually receive on the desktop host is exactly
 * `'self' https://*.vscode-cdn.net`, and on a remote/web host it is
 * `<extensionLocation>/ 'self' https://*.vscode-cdn.net`. An earlier version of
 * this file validated the whole string against a single-origin charset that
 * admitted neither a space nor an apostrophe, and therefore refused VS Code's
 * real value — the panel could not open, with this file's own error in the
 * modal. That charset, and the claim above it about "both shapes VS Code is
 * known to supply", were written from assumption. Re-measure with the getter
 * above before changing anything here.
 *
 * The guard is not relaxed to accommodate this; it is moved down a level.
 * Validating the whole string against a charset that included `'` and ` `
 * would accept `'self'; script-src 'unsafe-inline'` and make this function
 * decoration. Instead each token is validated on its own, and a token is
 * legitimate in exactly one of two ways:
 *
 *   - a quoted CSP keyword, from a closed allowlist (below), or
 *   - a host source, matching the origin charset (below).
 *
 * `;` is the directive separator and appears in neither, so no accepted value
 * can terminate `style-src` or open a directive of its own. Whitespace other
 * than a plain space — newline, tab, CR, form feed — is outside the host
 * charset and is not a keyword, so it is refused rather than silently treated
 * as a separator. An empty token, from a leading, trailing or doubled space,
 * is refused by both branches.
 *
 * Throwing is right here: unlike a webview message, this value comes from the
 * host, and a malformed one means the extension is wired wrong, not that
 * someone is probing us.
 */
const CSP_SOURCE_KEYWORDS: ReadonlySet<string> = new Set([
  // The one VS Code actually sends.
  "'self'",
  // Harmless by construction: it permits nothing.
  "'none'",
]);
// Deliberately NOT in that set, and this is the whole point of it being an
// allowlist rather than a quoted-string pattern: `'unsafe-inline'`,
// `'unsafe-eval'`, `'unsafe-hashes'`, `'strict-dynamic'`. Accepting any of
// them would let the host value dismantle the policy this file exists to
// enforce — the nonce would become decorative. Nonce and hash expressions are
// excluded for the same reason: we mint our own nonce, so a host-supplied one
// could only widen what is permitted.

/**
 * Characters allowed in a single host-source token.
 *
 * Unchanged from the charset this file has always carried, and it admits every
 * host token measured above: `https://*.vscode-cdn.net` needs only `:/.*-`
 * beyond alphanumerics. The `+` is for
 * `https://file+.vscode-resource.vscode-cdn.net`, the origin `asWebviewUri`
 * returns on the desktop host.
 */
const CSP_HOST_SOURCE_PATTERN = /^[A-Za-z0-9:/._+*-]+$/;

/** One source expression: a keyword from the allowlist, or a host source. */
function isCspSourceToken(token: string): boolean {
  // Any apostrophe at all routes to the allowlist, so an unbalanced or
  // misplaced quote (`'self`, `self'`, `a'b`) can never reach the charset
  // branch. It would not have matched there either, but the ordering makes
  // that a property rather than a coincidence.
  if (token.includes("'")) return CSP_SOURCE_KEYWORDS.has(token);
  return CSP_HOST_SOURCE_PATTERN.test(token);
}

export interface WebviewHtmlOptions {
  /** Webview-scoped URI of the script bundle. Must be same-origin (`asWebviewUri`). */
  scriptUri: string;
  /** Webview-scoped URI of the stylesheet. Omit to emit no `<link>` at all. */
  styleUri?: string;
  /** From {@link createNonce}. Fresh per panel load. */
  nonce: string;
  /** `vscode.Webview.cspSource`. */
  cspSource: string;
  /** Document title. Never rendered inside VS Code's panel, but not nothing. */
  title?: string;
}

/** Thrown when an interpolated value could break out of the policy or an attribute. */
export class WebviewHtmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebviewHtmlError';
  }
}

function requireNonce(nonce: string): string {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new WebviewHtmlError(
      'nonce must be non-empty base64; use createNonce()',
    );
  }
  return nonce;
}

function requireCspSource(cspSource: string): string {
  // Split on the plain space only. Every other whitespace character is then an
  // invalid character *inside* a token rather than a separator, so a newline
  // cannot smuggle a second directive past this check.
  if (!cspSource.split(' ').every(isCspSourceToken)) {
    throw new WebviewHtmlError(
      'cspSource contains characters that could inject a CSP directive',
    );
  }
  return cspSource;
}

/**
 * Escape for an HTML attribute value.
 *
 * URIs are escaped rather than validated: a real `asWebviewUri` result carries
 * a query string, and rejecting `&` would reject VS Code's own output.
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape for HTML text content. */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The exact Content-Security-Policy the document carries.
 *
 * Exported separately from {@link webviewHtml} so it can be asserted on
 * directly — including by absence, which is the assertion that matters. A test
 * that only checks the good directives are present passes just as happily on a
 * policy that also permits everything.
 */
export function contentSecurityPolicy(options: {
  nonce: string;
  cspSource: string;
}): string {
  const nonce = requireNonce(options.nonce);
  const cspSource = requireCspSource(options.cspSource);
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}' ${cspSource}`,
  ].join('; ');
}

/**
 * The full webview document.
 *
 * The script tag is a classic script, not `type="module"`: the bundle is a
 * single self-contained file with no imports to resolve, and a module script
 * would only add a fetch mode for something that is never fetched.
 */
export function webviewHtml(options: WebviewHtmlOptions): string {
  const nonce = requireNonce(options.nonce);
  const csp = contentSecurityPolicy({
    nonce,
    cspSource: options.cspSource,
  });
  // The policy is interpolated into the attribute UNESCAPED, and may be: both
  // interpolated values are validated above, and every other character of it
  // is a literal in this file, so it provably contains no `"` to close the
  // attribute with. The apostrophes in `'none'` and in cspSource's `'self'`
  // are not a problem: the attribute is delimited by double quotes. Escaping
  // would work too — entities are decoded before the policy is parsed — but it
  // renders `'none'` as `&#39;none&#39;`, which makes the one string a
  // reviewer must read by eye unreadable.
  const title = escapeText(options.title ?? 'Agent Deck');
  const script = escapeAttribute(options.scriptUri);
  const styleLink =
    options.styleUri === undefined
      ? ''
      : `\n    <link rel="stylesheet" nonce="${nonce}" href="${escapeAttribute(
          options.styleUri,
        )}">`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>${styleLink}
  </head>
  <body>
    <div id="${WEBVIEW_ROOT_ID}"></div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>
`;
}
