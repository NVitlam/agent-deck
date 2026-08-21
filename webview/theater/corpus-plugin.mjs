// esbuild plugin: inline the committed wire corpus into the theater bundle.
//
// Resolves the single specifier `virtual:wire-corpus` (declared for tsc in
// `virtual-wire-corpus.d.ts`) to an object keyed by corpus basename. The
// directory is read from `WIRE_CORPUS_DIR` via `contract.mjs`, so the recorder
// and the theater cannot disagree about where the corpus lives.
//
// WHY INLINE. The theater is opened as a plain `file://` page. `fetch` fails
// there, and shipping a dev page that reaches for the network would be a poor
// neighbour to the G5 guard on the real bundle. Inlining also makes the built
// page self-contained: one HTML file and one script, copyable anywhere.
//
// Files are read in sorted order and each is inlined VERBATIM — JSON is a
// valid JavaScript expression, so no re-serialisation happens here and the
// bundle cannot disagree with the committed bytes about a number's precision.
//
// G1: reads only. G5: no network.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { wireCorpusDir } from './contract.mjs';

const SPECIFIER = 'virtual:wire-corpus';
const NAMESPACE = 'wire-corpus';

/** @returns {import('esbuild').Plugin} */
export function wireCorpusPlugin() {
  return {
    name: 'wire-corpus',
    setup(build) {
      build.onResolve({ filter: /^virtual:wire-corpus$/ }, () => ({
        path: SPECIFIER,
        namespace: NAMESPACE,
      }));

      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async () => {
        const dir = await wireCorpusDir();
        let names;
        try {
          names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
        } catch {
          // No corpus recorded yet. An empty object rather than a build
          // failure: `node esbuild.config.mjs --theater` on a fresh clone
          // should tell the user to run the recorder, not crash esbuild.
          names = [];
        }

        const entries = [];
        for (const name of names) {
          const json = await readFile(join(dir, name), 'utf8');
          entries.push(`${JSON.stringify(name.replace(/\.json$/, ''))}: ${json}`);
        }

        return {
          contents: `export default {\n${entries.join(',\n')}\n};\n`,
          loader: 'js',
          resolveDir: dir,
          // So `--watch` picks up a re-record without a restart.
          watchFiles: names.map((n) => join(dir, n)),
        };
      });
    },
  };
}
