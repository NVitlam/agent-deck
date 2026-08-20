// Egress guard (G5) and CSP-shape guard, asserted against the BUILT artifact.
//
// Node environment: this test shells out to `node esbuild.config.mjs
// --webview`, the same command `npm run build` runs, and then reads
// `dist/webview/main.js`. Asserting against source would prove nothing —
// what ships is the bundle, and the bundle contains Svelte's runtime, which
// this package did not write.
//
// KNOWN SCOPE, measured rather than assumed. Two mutations were injected into
// `format.ts` and the build re-run:
//
//   1. `fetch(...)` + `localStorage.getItem(...)` inside an exported but
//      UNCALLED function      -> 22/22 still passed. esbuild tree-shakes it,
//                                so it never reaches the shipped bytes.
//   2. the same two calls inside `formatCost`, which the header renders
//                             -> 4 tests failed (no localStorage, no fetch
//                                call, only justified URLs, no storage API).
//
// So this is a guard on what SHIPS, not a source-level audit: dead code is not
// caught, and does not need to be. Anything reachable is.

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Node builtins reached through variable specifiers.
 *
 * `tsconfig.webview.json` sets `types: []` so the browser project cannot see
 * node's module graph — the compile-time half of "the webview has no fs and no
 * network". A static `import ... from 'node:fs'` in a file under `webview/`
 * would put node into that project and fail `npm run typecheck`. The
 * specifiers are opaque to `tsc` and resolved at runtime by vitest.
 */
const CHILD_PROCESS = 'node:child_process';
const FS = 'node:fs';

interface ChildProcessModule {
  execFileSync(
    file: string,
    args: readonly string[],
    options: { encoding: 'utf8'; stdio: 'pipe' },
  ): string;
}

interface FsModule {
  readFileSync(path: string, encoding: 'utf8'): string;
  existsSync(path: string): boolean;
}

const BUNDLE = 'dist/webview/main.js';
const STYLESHEET = 'dist/webview/main.css';

let js = '';
let css = '';

/**
 * URL literals allowed to survive in the bundle, each with the reason.
 *
 * Nothing here is fetched. The check below proves that structurally as well
 * as by inspection: every API that could load a URL — `fetch`,
 * `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`,
 * `navigator.sendBeacon`, `Worker`, dynamic `import()` — is asserted absent
 * from the same bytes, so there is nothing left in the bundle that could
 * dereference these strings.
 *
 *  - `https://svelte.dev/e/<code>` and `https://github.com/sveltejs/svelte`
 *    are the documentation links Svelte 5 embeds in the text of the errors and
 *    warnings it throws. They are message content; the user follows them by
 *    clicking a console link, if ever.
 *  - `http://www.w3.org/1999/xhtml` is the XHTML XML namespace constant, which
 *    Svelte passes to `document.createElementNS`. It is an identifier, not an
 *    address — nothing resolves it over the network.
 *
 * An allowance that cannot be justified in one line is a finding, not a
 * workaround. Do not extend this list to make a build pass.
 */
const ALLOWED_URL_PREFIXES = [
  'https://svelte.dev/e/',
  'https://github.com/sveltejs/svelte',
  'http://www.w3.org/1999/xhtml',
];

/** Identifiers that must not appear anywhere in the shipped bytes. */
const FORBIDDEN = [
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
  'sendBeacon',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'new Worker',
  'navigator.serviceWorker',
];

beforeAll(async () => {
  const cp = (await import(/* @vite-ignore */ CHILD_PROCESS)) as unknown as ChildProcessModule;
  const fs = (await import(/* @vite-ignore */ FS)) as unknown as FsModule;
  // The webview build is selectable on its own precisely so this test does not
  // depend on `src/extension.ts`, which another package owns and which does not
  // exist yet.
  cp.execFileSync('node', ['esbuild.config.mjs', '--webview', '--production'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  js = fs.readFileSync(BUNDLE, 'utf8');
  css = fs.readFileSync(STYLESHEET, 'utf8');
}, 120_000);

describe('the webview build', () => {
  it('produces a single script and a single stylesheet', () => {
    expect(js.length).toBeGreaterThan(1000);
    expect(css.length).toBeGreaterThan(100);
  });

  it('emits component styles externally, not injected from JavaScript', () => {
    // CSP-strict: the host serves one script and one stylesheet. Svelte's
    // default is to inject a <style> from JS, which a `style-src` without
    // 'unsafe-inline' would block.
    expect(css).toContain('--vscode-editor-background');
    expect(js).not.toContain('--vscode-editor-background');
  });

  it('bundles everything — no bare import survives', () => {
    expect(js).not.toMatch(/^\s*import\s+.*\bfrom\b/m);
    expect(js).not.toContain('require(');
  });
});

describe('G5 — zero egress from the shipped bundle', () => {
  it.each(FORBIDDEN)('contains no %s', (identifier) => {
    expect(js).not.toContain(identifier);
  });

  it('contains no fetch call', () => {
    // Bare `fetch` as an identifier; the word does not appear at all today.
    expect(js).not.toMatch(/\bfetch\s*\(/);
    expect(js).not.toContain('fetch');
  });

  it('contains no dynamic import', () => {
    expect(js).not.toMatch(/\bimport\s*\(/);
  });

  it('contains no eval', () => {
    expect(js).not.toMatch(/\beval\s*\(/);
    expect(js).not.toContain('new Function');
  });

  it('contains only justified URL literals', () => {
    const urls = [...js.matchAll(/https?:\/\/[^\s"'`)\\]*/g)].map((m) => m[0]);
    const unjustified = [...new Set(urls)].filter(
      (url) => !ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix)),
    );
    expect(unjustified).toEqual([]);
  });

  it('has no scheme-relative or protocol-less remote reference', () => {
    expect(js).not.toMatch(/["'`]\/\/[a-z0-9.-]+\.[a-z]{2,}\//i);
  });

  it('keeps the stylesheet local too', () => {
    expect(css).not.toContain('@import');
    expect(css).not.toContain('url(');
    expect(css).not.toContain('http');
  });
});

describe('G7 — nothing persists', () => {
  it('has no storage API of any kind', () => {
    for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'openDatabase']) {
      expect(js).not.toContain(api);
    }
  });

  it('does not use the webview state API, which would survive a reload', () => {
    // `acquireVsCodeApi()` also exposes `getState`/`setState`, which VS Code
    // persists across panel reloads. The webview is live-only: it re-renders
    // from the host's snapshot, and caching state would let a stale tree
    // outlive the data that produced it.
    expect(js).not.toContain('setState');
    expect(js).not.toContain('getState');
  });
});

describe('the built artifact still carries the cost decision', () => {
  it('renders cost as an em-dash with an explanation, and ships no price table', () => {
    expect(js).toContain('cost not computed');
    // No currency formatting and no rate constant anywhere in the bundle.
    expect(js).not.toContain('$0.00');
    expect(js).not.toContain('toLocaleString');
    expect(js).not.toContain('Intl.NumberFormat');
  });
});
