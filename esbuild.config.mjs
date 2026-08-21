// Bundles Agent Deck's two SHIPPED artifacts — the extension host entry and
// the webview — and, on request only, one dev-only page.
//
// The builds are separately selectable:
//
//   node esbuild.config.mjs             the two shipped artifacts
//   node esbuild.config.mjs --webview   webview only
//   node esbuild.config.mjs --host      host only
//   node esbuild.config.mjs --theater   the dev-only replay theater ONLY
//
// (This note used to say `src/extension.ts` does not exist and the host build
// fails by design. True from Phase 1 until Phase 3 landed the entry point;
// false since. Corrected from outside the commit that made it false, which is
// the only vantage point from which a "current state" line can be written
// accurately.)
//
// `--theater` is OPT-IN and is deliberately NOT part of the bare invocation,
// which is what `npm run build` and therefore `npm run package` run. The
// theater is a development surface (R6, `docs/ui/ui-canvas-redesign.md` §7
// Tier 3); building it by default would put a replay page and a whole wire
// corpus inside the VSIX. It emits into `dist/theater/` and touches neither
// `dist/extension.cjs` nor `dist/webview/`.
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

import { wireCorpusPlugin } from './webview/theater/corpus-plugin.mjs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const onlyWebview = process.argv.includes('--webview');
const onlyHost = process.argv.includes('--host');
const onlyTheater = process.argv.includes('--theater');
// A bare invocation builds the two shipped artifacts and nothing else; any
// selector narrows it to exactly what was asked for. Same result as the two
// boolean expressions that stood here for `--host` / `--webview`, written so a
// third target does not turn into a truth table.
const anySelector = onlyHost || onlyWebview || onlyTheater;
const wantHost = onlyHost || !anySelector;
const wantWebview = onlyWebview || !anySelector;
const wantTheater = onlyTheater;

/** @type {import('esbuild').BuildOptions} */
const hostOptions = {
  entryPoints: ['src/extension.ts'],
  // `.cjs`, NOT `.js`. This file emits CommonJS (`format: 'cjs'` below) and
  // `package.json` carries `"type": "module"`, so Node decides a `.js` file's
  // format from the nearest package.json and parses the bundle as ESM. It does
  // not throw: it silently yields an inert module, and VS Code then reports
  // that the extension has no `activate`. Measured on Node v24.15.0 against an
  // unzipped VSIX: `require` gave `activate: undefined`, and the byte-identical
  // file loaded outside a `"type": "module"` package gave `activate: function`.
  //
  // A `.cjs` extension is unambiguously CommonJS whatever any `"type"` field
  // says, so the fix is local and self-describing. `package.json`'s `main` must
  // stay in step; `src/extension.test.ts` drives its assertion FROM `main`
  // rather than from a literal, so a future divergence fails a test instead of
  // shipping an extension that installs and does nothing.
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
};

/**
 * Everything the browser bundles agree on.
 *
 * Shared rather than repeated: `webview/build-harness.mjs` already
 * re-specifies these values in a third place, which HANDOVER carry-forward K
 * records as "two agreeing literals with no contract". Adding a fourth copy
 * for the theater would widen exactly the seam that produced the
 * `#agent-deck-root` bug. The theater must resolve Svelte the way the shipped
 * webview does or it would be reviewing a different renderer.
 *
 * @type {import('esbuild').BuildOptions}
 */
const browserOptions = {
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
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  ...browserOptions,
  entryPoints: ['webview/main.ts'],
  outfile: 'dist/webview/main.js',
  plugins: [
    esbuildSvelte({
      compilerOptions: { css: 'external' },
    }),
  ],
};

/**
 * The dev-only replay theater (R6). Emits `dist/theater/{main.js,index.html}`.
 *
 * `css: 'injected'` rather than `external`, the same choice
 * `webview/build-harness.mjs` makes and for the same reason: a standalone page
 * has no host to link a stylesheet, so the one script has to carry the styles.
 * That is the ONE way this bundle differs from the shipped one, and it is why
 * the theater is a structure-and-motion review rather than a colour reference.
 *
 * The HTML entry point rides through the `copy` loader so the page and its
 * script land in the same directory with one build and no copy step.
 *
 * @type {import('esbuild').BuildOptions}
 */
const theaterOptions = {
  ...browserOptions,
  entryPoints: ['webview/theater/main.ts', 'webview/theater/index.html'],
  outdir: 'dist/theater',
  loader: { '.html': 'copy' },
  plugins: [
    esbuildSvelte({
      compilerOptions: { css: 'injected' },
    }),
    // Inlines every committed corpus under `WIRE_CORPUS_DIR`. Nothing in the
    // shipped webview's graph reaches this plugin's specifier.
    wireCorpusPlugin(),
  ],
};

const selected = [
  ...(wantHost ? [hostOptions] : []),
  ...(wantWebview ? [webviewOptions] : []),
  ...(wantTheater ? [theaterOptions] : []),
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
