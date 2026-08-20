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
 *                         is refused too.
 *   style-src 'nonce-N' <cspSource>
 *                         The stylesheet ships as a file under the extension's
 *                         own resource root. The nonce is there so a bundled
 *                         `<style nonce>` also works without ever reaching for
 *                         'unsafe-inline'.
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
export const WEBVIEW_ROOT_ID = 'app';

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
 * Characters allowed in a CSP source expression.
 *
 * A `'`, `;` or space in `cspSource` would let the caller append directives to
 * the policy — CSP injection, from a value we interpolate. Throwing is right
 * here: unlike a webview message, this value comes from the host, and a
 * malformed one means the extension is wired wrong, not that someone is
 * probing us.
 *
 * The charset admits both shapes VS Code is known to supply — the
 * `vscode-webview://<uuid>` origin and the desktop host's
 * `https://file+.vscode-resource.vscode-cdn.net`, whose `+` is why that
 * character is here — and nothing that could close a directive.
 */
const CSP_SOURCE_PATTERN = /^[A-Za-z0-9:/._+*-]+$/;

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
  if (!CSP_SOURCE_PATTERN.test(cspSource)) {
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
  // interpolated values are charset-validated above, and every other character
  // of it is a literal in this file, so it provably contains no `"` to close
  // the attribute with. Escaping it would work too — entities are decoded
  // before the policy is parsed — but it renders `'none'` as `&#39;none&#39;`,
  // which makes the one string a reviewer must read by eye unreadable.
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
