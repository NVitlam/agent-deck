// Read `webview/canvas-contract.ts`'s constants from the module that owns
// them, so a `.mjs` build script never re-types a shared string.
//
// WHY THIS EXISTS. Three `.mjs` files need `WIRE_CORPUS_DIR` and
// `SYNTHETIC_CORPUS_PREFIX`: the recorder that writes the corpus, the esbuild
// plugin that embeds it in the theater bundle, and the import-graph tool. Node
// cannot import a `.ts` module, so the obvious move is to paste the strings —
// which is exactly the "two agreeing literals with no contract" seam
// `canvas-contract.ts`'s own header exists to prevent. A rename there would
// leave the recorder writing to one directory and the theater reading another,
// with nothing failing.
//
// `transform` rather than `build`: the contract module has NO IMPORTS AT ALL,
// deliberately and by its own header, so type-stripping the one file is
// sufficient and no bundling is needed. If that ever stops being true, the
// eval throws instead of silently producing a partial object.
//
// G1: reads only. G5: no network.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { transform } from 'esbuild';

/** Repo root, from this file's own location — never the process cwd. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CONTRACT_PATH = join(REPO_ROOT, 'webview', 'canvas-contract.ts');

/** The names this loader guarantees to its callers. */
const REQUIRED = ['WIRE_CORPUS_DIR', 'SYNTHETIC_CORPUS_PREFIX'];

let cached;

/**
 * The canvas contract's exports, as a plain object.
 *
 * Cached per process: the recorder asks once, the esbuild plugin asks on every
 * rebuild in watch mode.
 */
export async function loadCanvasContract() {
  if (cached !== undefined) return cached;
  const source = await readFile(CONTRACT_PATH, 'utf8');
  const { code } = await transform(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'node20',
  });
  const evaluated = { exports: {} };
  const factory = new Function('module', 'exports', code);
  factory(evaluated, evaluated.exports);
  const exported = evaluated.exports;
  for (const name of REQUIRED) {
    if (typeof exported[name] !== 'string' || exported[name] === '') {
      throw new Error(`webview/canvas-contract.ts no longer exports a non-empty string ${name}`);
    }
  }
  cached = exported;
  return cached;
}

/** Absolute path of the committed wire corpus directory. */
export async function wireCorpusDir() {
  const { WIRE_CORPUS_DIR } = await loadCanvasContract();
  return join(REPO_ROOT, WIRE_CORPUS_DIR);
}
