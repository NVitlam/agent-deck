import { describe, expect, it } from 'vitest';

import {
  WEBVIEW_ROOT_ID,
  WebviewHtmlError,
  contentSecurityPolicy,
  createNonce,
  webviewHtml,
} from './html.js';

/**
 * VS Code's ACTUAL `webview.cspSource` on the desktop host, byte for byte.
 *
 * Provenance, so the next person re-measures instead of re-inventing: read out
 * of the installed VS Code 1.134.0 (commit
 * 110a328ea54b42367b803ec53ee0bf52ef26b419), file
 * `resources/app/out/vs/workbench/api/node/extensionHostProcess.js`. The getter
 * there is `get cspSource(){let t=this.#r.extensionLocation;if(t.scheme===B.https
 * ||t.scheme===B.http){let e=t.toString();return e.endsWith("/")||(e+="/"),e+" "
 * +aI}return aI}` with `aI=\`'self' https://*.${Tz}\`` and `Tz="vscode-cdn.net"`.
 *
 * What stood here before was `vscode-webview://<uuid>`, under a comment
 * claiming it was "shaped like VS Code's real cspSource". It was invented. The
 * whole suite was green while the extension could not open its panel: a human
 * side-loaded the VSIX into VS Code 1.134.0 and got a modal reading
 * "cspSource contains characters that could inject a CSP directive" — this
 * file's own guard, refusing the real value over its space and its apostrophes.
 */
const CSP_SOURCE = "'self' https://*.vscode-cdn.net";

/**
 * The other branch of the same getter: an http/https `extensionLocation` is
 * prefixed, slash-terminated, to the desktop value. We ship desktop only today,
 * but the validator handles a source list of any length rather than
 * special-casing two tokens, and this pins that.
 */
const CSP_SOURCE_REMOTE =
  "https://main.vscode-cdn.net/stable/110a328ea54b42367b803ec53ee0bf52ef26b419/ 'self' https://*.vscode-cdn.net";
const SCRIPT_URI =
  'https://file+.vscode-resource.vscode-cdn.net/c%3A/ext/dist/webview.js';
const STYLE_URI =
  'https://file+.vscode-resource.vscode-cdn.net/c%3A/ext/dist/webview.css';

function html(nonce = createNonce()): string {
  return webviewHtml({
    scriptUri: SCRIPT_URI,
    styleUri: STYLE_URI,
    nonce,
    cspSource: CSP_SOURCE,
  });
}

/** The `content="..."` of the CSP meta tag, as a browser would read it. */
function policyFromDocument(document: string): string {
  const match =
    /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(document);
  expect(match, 'document carries exactly one CSP meta tag').not.toBeNull();
  return match?.[1] ?? '';
}

describe('contentSecurityPolicy — what it permits', () => {
  const csp = contentSecurityPolicy({ nonce: 'AAAABBBBCCCCDDDD', cspSource: CSP_SOURCE });

  it('denies everything by default', () => {
    expect(csp).toContain("default-src 'none'");
  });

  it('allows scripts only by nonce', () => {
    expect(csp).toContain("script-src 'nonce-AAAABBBBCCCCDDDD'");
  });

  it('allows styles only from the webview origin, or by nonce', () => {
    expect(csp).toContain(`style-src 'nonce-AAAABBBBCCCCDDDD' ${CSP_SOURCE}`);
  });

  it('locks the two directives default-src does not cover', () => {
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });
});

// The assertions that actually catch a bad policy. A policy can contain every
// directive above AND permit everything; only absence proves it does not.
describe('contentSecurityPolicy — what it must NOT contain', () => {
  /**
   * `cspSource` is VS Code's, not ours, and it carries `'self'` and an
   * `https://*.vscode-cdn.net` wildcard that we would never write ourselves.
   * Absence assertions are therefore made against the policy with that one
   * value replaced by a placeholder: what is being asserted is that WE add no
   * origin, scheme, wildcard or keyword of our own. Both branches of VS Code's
   * getter are exercised so neither can smuggle something in.
   */
  const CSP_SOURCE_SHAPES = [CSP_SOURCE, CSP_SOURCE_REMOTE];

  function authored(cspSource: string): string {
    return contentSecurityPolicy({ nonce: createNonce(), cspSource })
      .split(cspSource)
      .join('<CSP_SOURCE>');
  }

  const forbidden: readonly [string, string][] = [
    ["'unsafe-inline'", 'inline script/style would make the nonce decorative'],
    ["'unsafe-eval'", 'eval reopens the whole injection surface'],
    ['unsafe-hashes', 'inline event handlers by hash are still inline'],
    ['http://', 'a remote origin is egress (G5)'],
    ['https://', 'a remote origin is egress (G5), CDN included'],
    ['ws:', 'a websocket is egress (G5)'],
    ['wss:', 'a websocket is egress (G5)'],
    ['data:', 'a data: source is not needed and widens script/style surface'],
    ['blob:', 'a blob: source is not needed'],
    ['connect-src', 'ANY connect-src re-enables fetch/XHR/WebSocket (G5)'],
    ['*', 'a wildcard source permits an origin we did not name'],
  ];

  for (const [needle, why] of forbidden) {
    it(`does not contain ${needle} — ${why}`, () => {
      for (const shape of CSP_SOURCE_SHAPES) {
        expect(authored(shape)).not.toContain(needle);
      }
    });
  }

  it('names no scheme of its own', () => {
    // Every `x:` token in the policy must come from cspSource itself.
    for (const shape of CSP_SOURCE_SHAPES) {
      expect(authored(shape).match(/[a-z][a-z0-9+.-]*:/g)).toBeNull();
    }
  });

  it('names cspSource in exactly one directive, and it is style-src', () => {
    for (const shape of CSP_SOURCE_SHAPES) {
      const directives = authored(shape)
        .split('; ')
        .filter((d) => d.includes('<CSP_SOURCE>'));
      expect(directives).toHaveLength(1);
      expect(directives[0]).toMatch(/^style-src 'nonce-[^']+' <CSP_SOURCE>$/);
    }
  });

  it('the document carries the same policy, unescaped and readable', () => {
    const document = html('AAAABBBBCCCCDDDD');
    expect(policyFromDocument(document)).toBe(
      contentSecurityPolicy({ nonce: 'AAAABBBBCCCCDDDD', cspSource: CSP_SOURCE }),
    );
  });

  it('the document contains no remote origin of OUR authorship', () => {
    // Three strings in the document come from VS Code, not from us: the two
    // resource URIs and cspSource. All three now legitimately contain
    // `https://…vscode-cdn.net`, because that is the origin VS Code serves
    // local extension files from. Strip them and nothing remote may remain —
    // that is the G5 assertion, and it is about what this file authors.
    const document = html()
      .split(SCRIPT_URI)
      .join('')
      .split(STYLE_URI)
      .join('')
      .split(CSP_SOURCE)
      .join('');
    expect(document).not.toContain('http://');
    expect(document).not.toContain('https://');
    expect(document.toLowerCase()).not.toContain('cdn');
  });
});

describe('nonce', () => {
  it('is fresh on every call', () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 200; i += 1) nonces.add(createNonce());
    expect(nonces.size).toBe(200);
  });

  it('carries at least 128 bits of entropy', () => {
    // 16 random bytes, base64 -> 24 chars with one '=' of padding.
    expect(createNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it('is the one on the script tag, and on nothing that is not nonced', () => {
    const nonce = createNonce();
    const document = webviewHtml({
      scriptUri: SCRIPT_URI,
      nonce,
      cspSource: CSP_SOURCE,
    });
    expect(document).toContain(`<script nonce="${nonce}" src=`);
    expect(policyFromDocument(document)).toContain(`'nonce-${nonce}'`);
    // Exactly one script element, and it is nonced.
    expect(document.match(/<script/g)).toHaveLength(1);
    expect(document.match(/<script(?![^>]*\bnonce=)/g)).toBeNull();
  });

  it('rejects a nonce that could break out of the policy', () => {
    for (const bad of ["a' 'unsafe-inline", 'a; script-src *', 'a b', '', 'nonce"x']) {
      expect(() =>
        contentSecurityPolicy({ nonce: bad, cspSource: CSP_SOURCE }),
      ).toThrow(WebviewHtmlError);
    }
  });

});

/**
 * The regression suite for the defect that shipped: a validator written from
 * memory refused VS Code's real value, and the panel could not open.
 *
 * `cspSource` is a CSP *source list* - space-separated source expressions - so
 * validation is per token. Every case below names what it protects.
 */
describe('cspSource - the source list VS Code actually supplies', () => {
  function accepts(cspSource: string): boolean {
    try {
      contentSecurityPolicy({ nonce: 'AAAABBBBCCCCDDDD', cspSource });
      return true;
    } catch (error) {
      if (error instanceof WebviewHtmlError) return false;
      throw error;
    }
  }

  const accepted: readonly [string, string][] = [
    [CSP_SOURCE, 'VS Code 1.134.0 desktop, verbatim - THE case that was broken'],
    [CSP_SOURCE_REMOTE, 'VS Code remote/web: extensionLocation prefixed to the desktop value'],
    ['https://file+.vscode-resource.vscode-cdn.net', 'a bare host source, the pre-existing shape'],
    ['vscode-webview://0f7c2b1a-4d3e-4a55-9c0b-8a1d2e3f4a5b', 'a bare host source with a custom scheme'],
    ["'none'", 'a keyword that permits nothing'],
    ["'self'", 'the keyword on its own'],
    ["'self' 'none' https://a.example https://b.example", 'a longer list; not special-cased at two tokens'],
  ];

  for (const [value, why] of accepted) {
    it(`accepts ${JSON.stringify(value)} - ${why}`, () => {
      expect(accepts(value)).toBe(true);
    });
  }

  const rejected: readonly [string, string][] = [
    ["'self'; script-src 'unsafe-inline'", 'a `;` terminates style-src and opens a new directive'],
    ["x; script-src 'unsafe-inline'", 'the same injection on a bare host token'],
    ['https://a.example;', 'a trailing `;` alone is enough to end the directive'],
    ["'unsafe-inline'", 'would make the nonce decorative'],
    ["'unsafe-eval'", 'reopens the whole injection surface'],
    ["'unsafe-hashes'", 'inline event handlers by hash are still inline'],
    ["'strict-dynamic'", 'lets a nonced script load further scripts unchecked'],
    ["'self' 'unsafe-inline'", 'one good token must not launder a bad one'],
    ["'nonce-AAAABBBBCCCCDDDD'", 'we mint our own nonce; a host-supplied one can only widen'],
    ["'sha256-abc='", 'a hash expression is not on the allowlist either'],
    ["'self", 'an unbalanced opening quote'],
    ["self'", 'an unbalanced closing quote'],
    ["a'b", 'a quote in the middle of a host source'],
    ["''", 'an empty quoted token'],
    ['', 'the empty string is not a source list'],
    [' ', 'a lone space is two empty tokens'],
    ["'self'  https://a.example", 'a doubled space leaves an empty token'],
    [" 'self'", 'a leading space leaves an empty token'],
    ["'self' ", 'a trailing space leaves an empty token'],
    ["'self'\nscript-src *", 'a newline must not be treated as a separator'],
    ["'self'\tscript-src *", 'nor a tab'],
    ["'self'\rscript-src *", 'nor a carriage return'],
    ['https://a.example\u000cscript-src *', 'nor a form feed'],
    ['"self"', 'double quotes are not CSP quoting, and would close the meta attribute'],
    ["'SELF'", 'the allowlist is exact-match; refuse rather than guess at case folding'],
  ];

  for (const [value, why] of rejected) {
    it(`rejects ${JSON.stringify(value)} - ${why}`, () => {
      expect(accepts(value)).toBe(false);
      expect(() =>
        contentSecurityPolicy({ nonce: 'AAAABBBBCCCCDDDD', cspSource: value }),
      ).toThrow(WebviewHtmlError);
    });
  }

  it('the real desktop value lands in style-src and nowhere else', () => {
    const csp = contentSecurityPolicy({
      nonce: 'AAAABBBBCCCCDDDD',
      cspSource: CSP_SOURCE,
    });
    expect(csp).toContain(`style-src 'nonce-AAAABBBBCCCCDDDD' ${CSP_SOURCE}`);
    expect(csp.split('; ').filter((d) => d.includes(CSP_SOURCE))).toHaveLength(1);
  });

  it("script-src carries no 'self', so an unnonced same-origin script is still refused", () => {
    // Why cspSource must never be added to script-src: VS Code's real value
    // contains 'self', which would permit ANY same-origin script with no nonce
    // at all. The invented value did not contain it, so this property used to
    // hold by accident rather than by policy.
    const csp = contentSecurityPolicy({
      nonce: 'AAAABBBBCCCCDDDD',
      cspSource: CSP_SOURCE,
    });
    expect(csp.split('; ').find((d) => d.startsWith('script-src '))).toBe(
      "script-src 'nonce-AAAABBBBCCCCDDDD'",
    );
  });

  it('a rejected cspSource never reaches the document either', () => {
    expect(() =>
      webviewHtml({
        scriptUri: SCRIPT_URI,
        nonce: createNonce(),
        cspSource: "'self'; script-src 'unsafe-inline'",
      }),
    ).toThrow(WebviewHtmlError);
  });

  it('an accepted cspSource cannot put a double quote in the meta attribute', () => {
    // The policy is interpolated unescaped. Both accepted branches - the
    // keyword allowlist and the host charset - exclude the double quote by
    // construction, so the attribute cannot be closed early.
    for (const shape of [CSP_SOURCE, CSP_SOURCE_REMOTE]) {
      const document = webviewHtml({
        scriptUri: SCRIPT_URI,
        nonce: 'AAAABBBBCCCCDDDD',
        cspSource: shape,
      });
      expect(policyFromDocument(document)).toContain(shape);
    }
  });
});

describe('webviewHtml — the document', () => {
  it('is a single local bundle with no inline script and no inline style', () => {
    const document = html();
    // No inline script body: every <script> is src-loaded and self-closing-ish.
    expect(document).not.toMatch(/<script[^>]*>[^<]/);
    expect(document).not.toContain('<style');
    // No inline event handlers, which 'unsafe-inline' would be needed for.
    expect(document).not.toMatch(/\son[a-z]+=/);
    expect(document).not.toContain('javascript:');
  });

  it('mounts the renderer on the exported root id', () => {
    expect(html()).toContain(`<div id="${WEBVIEW_ROOT_ID}"></div>`);
  });

  it('emits no stylesheet link when no styleUri is given', () => {
    const document = webviewHtml({
      scriptUri: SCRIPT_URI,
      nonce: createNonce(),
      cspSource: CSP_SOURCE,
    });
    expect(document).not.toContain('<link');
  });

  it('nonces the stylesheet link when one is given', () => {
    const nonce = createNonce();
    expect(html(nonce)).toContain(
      `<link rel="stylesheet" nonce="${nonce}" href=`,
    );
  });

  it('escapes attribute-breaking characters in a URI rather than emitting them', () => {
    const document = webviewHtml({
      scriptUri: 'x.js" onload="steal()',
      nonce: createNonce(),
      cspSource: CSP_SOURCE,
      title: '<script>alert(1)</script>',
    });
    expect(document).not.toContain('onload="steal()"');
    expect(document).toContain('&quot; onload=&quot;steal()');
    expect(document).not.toContain('<script>alert(1)</script>');
    expect(document).toContain('&lt;script&gt;alert(1)');
  });

  it('imports no filesystem or network API into the document', () => {
    const document = html();
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'require(']) {
      expect(document).not.toContain(forbidden);
    }
  });
});
