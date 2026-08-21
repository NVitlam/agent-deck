// Print the real import graph of an entry point, as JSON on stdout.
//
// WHY A TOOL AND NOT A COMMENT. `harness.ts`, `testkit.ts` and now
// `webview/theater/` all carry a line saying "nothing here is reachable from
// `webview/main.ts`". A line saying that is not a check. This walks the graph
// the BUNDLER walks — esbuild's own resolution, the same plugins, the same
// `conditions` — and reports every module that actually went in. A rename, a
// stray `import` added for a convenience helper, or a type-only import that
// stops being type-only all show up here as a new input.
//
// `metafile.inputs` is the measurement: esbuild lists one key per file it
// read, repo-relative with forward slashes. `webview/wire.test.ts` asserts on
// that set in both directions — the theater is absent from `main.ts`'s graph,
// AND present in the theater's own, so a tool that had stopped seeing theater
// modules would fail rather than pass vacuously.
//
// Usage:  node webview/theater/import-graph.mjs webview/main.ts
//
// G1: `write: false`, nothing reaches disk. G5: no network.

import { build } from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';

import { REPO_ROOT } from './contract.mjs';
import { wireCorpusPlugin } from './corpus-plugin.mjs';

const entry = process.argv[2];
if (entry === undefined || entry === '') {
  process.stderr.write('usage: node webview/theater/import-graph.mjs <entry>\n');
  process.exit(2);
}

const result = await build({
  entryPoints: [entry],
  absWorkingDir: REPO_ROOT,
  bundle: true,
  write: false,
  metafile: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  // The same resolution the shipped webview build uses, so this graph is the
  // graph that ships rather than a differently-resolved approximation.
  conditions: ['svelte', 'browser'],
  mainFields: ['svelte', 'browser', 'module', 'main'],
  plugins: [
    esbuildSvelte({ compilerOptions: { css: 'injected' } }),
    // Present so a theater entry point resolves; a `webview/main.ts` entry
    // never reaches it, which is the whole assertion.
    wireCorpusPlugin(),
  ],
  logLevel: 'silent',
});

const inputs = Object.keys(result.metafile.inputs)
  .map((p) => p.split('\\').join('/'))
  .sort();

process.stdout.write(`${JSON.stringify({ entry, inputs }, null, 2)}\n`);
