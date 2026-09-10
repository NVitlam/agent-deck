// Test-only: bundle `webview/harness.ts` and print the JavaScript to stdout.
//
// This runs as its own `node` process, and that is not incidental. The
// component tests need a DOM, so they run under vitest's jsdom environment —
// and esbuild refuses to start there: jsdom installs its own `Uint8Array`, so
// `new TextEncoder().encode("") instanceof Uint8Array` is false and esbuild's
// startup invariant fails. Measured, both with jsdom's TextEncoder and with
// `node:util`'s: both false, so patching the encoder alone does not fix it.
// A separate process has a clean realm and sidesteps the whole question.
//
// Writes nothing to disk (G1) — the bundle goes to stdout and the caller
// evaluates it in memory.

import { build } from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';

const GLOBAL_NAME = 'AgentDeckHarness';

const result = await build({
  entryPoints: ['webview/harness.ts'],
  // Named but never written: `write: false` keeps the bundle in memory, and
  // the name only gives the in-memory output file a .js path to match on.
  outfile: 'dist/webview/harness.js',
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: GLOBAL_NAME,
  target: 'es2022',
  // Same resolution conditions as the shipped webview build, so the tests
  // exercise Svelte's client runtime and not its SSR build.
  conditions: ['svelte', 'browser'],
  mainFields: ['svelte', 'browser', 'module', 'main'],
  // `injected` rather than `external`: the shipped build emits a stylesheet the
  // host links, but a test that evaluates the bundle standalone has nowhere to
  // link one. Styles are not asserted on; structure and text are.
  plugins: [esbuildSvelte({ compilerOptions: { css: 'injected' } })],
  // 'error' RATHER THAN 'silent', and it was bought (v0.7.0, the 4.11b gate).
  //
  // One gate run of three failed here with `Command failed: node
  // webview/build-harness.mjs` and NOTHING ELSE — one webview suite reported as
  // a failed suite, its two tests reported as SKIPPED, and no reason anywhere.
  // Under 'silent' esbuild writes no diagnostic, so a child that exits non-zero
  // exits with an empty stderr and `execFileSync` has nothing to quote. This is
  // the recorded environment-sensitive-subprocess class (see `vsce ls`) with the
  // recorded silent-skip class on top of it, and the answer to both is the same:
  // a check that fails must say why. Nothing is written to disk either way
  // (`write: false`), so this changes no output and no G1 property.
  logLevel: 'error',
});

const js = result.outputFiles.find((f) => f.path.endsWith('.js'));
if (js === undefined) {
  process.stderr.write('harness bundle produced no javascript\n');
  process.exit(1);
}
process.stdout.write(js.text);
