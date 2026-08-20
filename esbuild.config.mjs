// Bundles Agent Deck's two artifacts: the extension host entry and the webview.
//
// NOTE: `src/extension.ts` does not exist yet — Phase 3 owns the activation
// entry point. Until it lands, the host build fails with a missing-entry
// error. That is expected; `npm test`, `npm run lint` and `npm run typecheck`
// do not depend on this file.
//
// Because of that, the two builds are separately selectable:
//
//   node esbuild.config.mjs             both (fails today on the host entry)
//   node esbuild.config.mjs --webview   webview only
//   node esbuild.config.mjs --host      host only
//
// The webview build must stand alone: its egress-guard test (webview/bundle.test.ts)
// reads the emitted `dist/webview/main.js` and would otherwise be blocked by an
// unrelated missing file in another package's scope.
//
// VS Code loads extensions as CommonJS in a Node host, and `vscode` is
// injected by the host at runtime, so it must stay external.
//
// The webview is the opposite: `platform: 'browser'`, iife, and NOTHING
// external. A CSP-strict webview can load exactly one script and one
// stylesheet, so an unbundled import would simply fail to resolve at runtime.
// `css: 'external'` makes Svelte emit component styles as a real stylesheet
// (dist/webview/main.css) instead of injecting them from JS, which is what
// lets the host serve them under a `style-src` that forbids inline styles.

import { build, context } from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const onlyWebview = process.argv.includes('--webview');
const onlyHost = process.argv.includes('--host');
const wantHost = !onlyWebview || onlyHost;
const wantWebview = !onlyHost || onlyWebview;

/** @type {import('esbuild').BuildOptions} */
const hostOptions = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ['webview/main.ts'],
  outfile: 'dist/webview/main.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  external: [],
  // `conditions` picks Svelte's browser client runtime rather than its SSR
  // build; without it esbuild can resolve the server entry and emit code that
  // renders nothing in the panel.
  conditions: ['svelte', 'browser'],
  mainFields: ['svelte', 'browser', 'module', 'main'],
  plugins: [
    esbuildSvelte({
      compilerOptions: { css: 'external' },
    }),
  ],
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
};

const selected = [
  ...(wantHost ? [hostOptions] : []),
  ...(wantWebview ? [webviewOptions] : []),
];

if (watch) {
  for (const options of selected) {
    const ctx = await context(options);
    await ctx.watch();
  }
} else {
  for (const options of selected) {
    await build(options);
  }
}
