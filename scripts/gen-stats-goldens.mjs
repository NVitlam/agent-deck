// Generate the Phase 2 stats fixtures and goldens.
//
//     node scripts/gen-stats-goldens.mjs            write
//     node scripts/gen-stats-goldens.mjs --check    compare, write nothing, exit 1 on any difference
//
// v0.7.0 Phase 2, DoD 2.3: "`fixtures/golden/stats/<engine>-<version>-<session>.json`
// for every corpus session and every R8 fixture; byte equality asserted;
// regenerated only by `scripts/gen-stats-goldens.mjs`."
//
// WHAT THIS SCRIPT DOES NOT DO
// ----------------------------
// It does not derive anything. Every byte it writes comes from
// `allGoldenEntries()` in `src/stats/corpus.stats.testkit.ts` — the SAME
// function `goldens.test.ts` calls to assert byte equality. That is not
// tidiness: a generator with its own copy of the serialisation would drift from
// the test, and the failure mode is the worst kind — the script rewrites the
// goldens into a shape the suite then rejects, or worse, agrees with itself and
// nobody notices the two definitions parted. One definition, two callers.
//
// The reference scripts for the OpenCode and Codex goldens take the opposite
// approach on purpose (they import only `node:` builtins, so reproducing a
// golden through the production path proves something). That is not available
// here and would be wrong if it were: a stats golden's whole content is what
// `deriveStats` produces, so a second implementation would be pinning a
// different function's output.
//
// HOW `src/` IS LOADED
// --------------------
// esbuild bundles an in-memory entry that RE-EXPORTS the real modules, and the
// bundle is evaluated in this process — the `scripts/record-wire.mjs` pattern,
// for the same reason: nothing here reimplements a parse, so what is written is
// what the product produces.
//
// `__filename` is set to a path INSIDE `src/stats/`, and that is load-bearing
// rather than cosmetic. The bundled testkit resolves the fixtures root with
// `new URL('../../fixtures/', import.meta.url)`, which esbuild rewrites onto
// `__filename` in a CJS bundle. Pointing it at the repository root instead
// would resolve two levels above the repository and every corpus read would
// fail with ENOENT in a script whose whole job is reading corpora.

import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'golden', 'stats');
const FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'synthetic-stats');

/** Load `src/`'s real modules, bundled for node and evaluated here. */
async function loadStatsModules() {
  const require = createRequire(join(REPO_ROOT, 'package.json'));
  const { build } = await import(pathToFileURL(require.resolve('esbuild')).href);

  const entry = [
    "export { allGoldenEntries } from './src/stats/corpus.stats.testkit.js';",
    "export { buildSyntheticStatsFixtures } from './src/stats/synthetic.testkit.js';",
  ].join('\n');

  const result = await build({
    stdin: {
      contents: entry,
      resolveDir: REPO_ROOT,
      sourcefile: 'gen-stats-goldens-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    packages: 'external',
    // `vscode` has no package on disk; the extension host injects it. The same
    // stand-in `vitest.config.ts` and `esbuild.config.mjs` already use. Nothing
    // on this path touches a `vscode` API — it is reached only because
    // `session.ts`'s import graph passes near it.
    alias: { vscode: join(REPO_ROOT, 'test', 'vscode-mock.ts') },
    // `import.meta.url` has no meaning in a CJS bundle, and esbuild leaves it
    // as an expression that evaluates to nothing usable — measured: the first
    // run of this script died with `Invalid URL: '../../fixtures/otel-cc-2.1.260/'`,
    // a relative specifier that had lost its base.
    //
    // Every module in THIS graph that reads it lives in `src/stats/`
    // (`corpus.stats.testkit.ts` and `synthetic.ts`; `src/opencode/synthetic.ts`
    // also reads it and is provably unreachable from `opencode/index.ts`, which
    // `src/hooks/egress.test.ts` asserts). So one definition serves them all,
    // and it names the same directory `__filename` below does — the two must
    // agree or a fixture path resolves to two different places depending on
    // which mechanism computed it.
    define: {
      'import.meta.url': JSON.stringify(
        pathToFileURL(join(REPO_ROOT, 'src', 'stats', 'gen-stats-goldens-host.cjs')).href,
      ),
    },
    logLevel: 'silent',
  });

  const js = result.outputFiles[0];
  if (js === undefined) throw new Error('the stats bundle produced no javascript');

  const mod = { exports: {} };
  const factory = new Function('require', 'module', 'exports', '__filename', '__dirname', js.text);
  factory(
    require,
    mod,
    mod.exports,
    join(REPO_ROOT, 'src', 'stats', 'gen-stats-goldens-host.cjs'),
    join(REPO_ROOT, 'src', 'stats'),
  );
  return mod.exports;
}

/** Every file this script owns: name -> bytes. */
async function planFiles(modules) {
  const files = new Map();

  // The R8 session fixtures. Committed so the input to each synthetic golden
  // is reviewable on its own, rather than existing only inside a builder.
  for (const fixture of modules.buildSyntheticStatsFixtures()) {
    files.set(join(FIXTURE_DIR, `${fixture.id}.json`), `${JSON.stringify(
      { id: fixture.id, manufactures: fixture.manufactures, state: fixture.state },
      null,
      2,
    )}\n`);
  }

  for (const entry of await modules.allGoldenEntries()) {
    files.set(join(GOLDEN_DIR, `${entry.stem}.json`), entry.text);
  }
  return files;
}

async function main() {
  const check = process.argv.includes('--check');
  const modules = await loadStatsModules();
  const files = await planFiles(modules);

  await mkdir(GOLDEN_DIR, { recursive: true });
  await mkdir(FIXTURE_DIR, { recursive: true });

  const differences = [];
  for (const [path, text] of files) {
    const current = existsSync(path) ? await readFile(path, 'utf8') : null;
    if (current === text) continue;
    differences.push(`${current === null ? 'missing' : 'changed'}: ${path.slice(REPO_ROOT.length)}`);
    if (!check) await writeFile(path, text, 'utf8');
  }

  // A golden for a session that no longer exists is worse than a missing one:
  // it keeps passing its own byte comparison forever while describing nothing.
  // Both directories are OWNED by this script, so anything unaccounted for is
  // stale by definition.
  for (const dir of [GOLDEN_DIR, FIXTURE_DIR]) {
    for (const name of await readdir(dir)) {
      if (name === 'README.md') continue;
      const path = join(dir, name);
      if (files.has(path)) continue;
      differences.push(`stale: ${path.slice(REPO_ROOT.length)}`);
      if (!check) await rm(path);
    }
  }

  const noun = `${String(files.size)} file${files.size === 1 ? '' : 's'}`;
  if (check) {
    if (differences.length === 0) {
      console.log(`gen-stats-goldens --check: ${noun}, all current`);
      return;
    }
    console.error(`gen-stats-goldens --check: ${String(differences.length)} difference(s)`);
    for (const line of differences) console.error(`  ${line}`);
    console.error('\nRun `node scripts/gen-stats-goldens.mjs` and review the diff.');
    process.exitCode = 1;
    return;
  }

  console.log(`gen-stats-goldens: ${noun} written`);
  if (differences.length === 0) console.log('  no change');
  else for (const line of differences) console.log(`  ${line}`);
}

await main();
