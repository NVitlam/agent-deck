import { describe, expect, it } from 'vitest';

import {
  WEBVIEW_ROOT_ID,
  WebviewHtmlError,
  contentSecurityPolicy,
  createNonce,
  webviewHtml,
} from './html.js';

/** Shaped like VS Code's real `webview.cspSource` on the desktop host. */
const CSP_SOURCE = 'vscode-webview://0f7c2b1a-4d3e-4a55-9c0b-8a1d2e3f4a5b';
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
   * `cspSource` is VS Code's, not ours, and on the desktop host it is an
   * `https://…vscode-cdn.net` origin serving local extension files. Absence
   * assertions are therefore made against the policy with that one value
   * replaced by a placeholder: what is being asserted is that WE add no
   * origin, scheme or wildcard of our own. Both observed shapes of the value
   * are exercised so neither can smuggle something in.
   */
  const CSP_SOURCE_SHAPES = [
    CSP_SOURCE,
    'https://file+.vscode-resource.vscode-cdn.net',
  ];

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

  it('the document contains no remote origin anywhere outside the resource URIs', () => {
    const document = html().split(SCRIPT_URI).join('').split(STYLE_URI).join('');
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

  it('rejects a cspSource that could append a directive', () => {
    for (const bad of ["x; script-src 'unsafe-inline'", "'self'", 'a b', '']) {
      expect(() =>
        contentSecurityPolicy({ nonce: createNonce(), cspSource: bad }),
      ).toThrow(WebviewHtmlError);
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
