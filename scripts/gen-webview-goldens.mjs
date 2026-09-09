// Generate the Phase 4 webview goldens: auto-fit and the Stats layout.
//
//     node scripts/gen-webview-goldens.mjs            write
//     node scripts/gen-webview-goldens.mjs --check    compare, write nothing, exit 1 on any difference
//
// v0.7.0 Phase 4, DoD 4.0 and 4.2:
//
//   webview/goldens/layout/fit.json    `fit(bounds, viewport, drawerRect)` at three
//                                      viewports x drawer open/closed x 1/6/40 nodes
//   webview/goldens/stats/n<N>.json    `statsLayout` over the first N committed
//                                      corpus goldens, N = 0/1/2/6/12
//   webview/goldens/stats/r8-<id>.json `statsLayout` over ONE R8 golden, each of them,
//                                      after the host-side wire gate and the real store
//
// WHAT THIS SCRIPT DOES NOT DO
// ----------------------------
// It derives nothing of its own. The fit cases go through the production
// `webview/layout.ts` (for the bounds of a real tidy-tree layout) and the
// production `webview/layout/fit.ts`; the stats cases go through the production
// `src/stats/wire.ts` gate, `webview/store.ts` (a real `statsSnapshot` message)
// and `webview/stats/layout.ts`. The same modules the tests import, bundled the
// way `gen-stats-goldens.mjs` bundles `src/`, so what is written is what the
// product computes — and a golden that rewrites itself on a code change is
// caught by `--check`, which `webview/layout/fit.test.ts` and
// `webview/stats/layout.test.ts` ALSO enforce by recomputing in-process and
// comparing to the committed bytes. Two readers of one file, neither of which
// is this script.
//
// THE STATS INPUTS ARE THE COMMITTED `fixtures/golden/stats/*.json` RECORDS,
// not a fresh derivation: those are `deriveStats`'s output, byte-compared by
// `goldens.test.ts`, and reading them is what makes "the layout of the record
// the fixture manufactures" literally true.

import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIT_GOLDEN = join(REPO_ROOT, 'webview', 'goldens', 'layout', 'fit.json');
const STATS_GOLDEN_DIR = join(REPO_ROOT, 'webview', 'goldens', 'stats');
const STATS_RECORDS_DIR = join(REPO_ROOT, 'fixtures', 'golden', 'stats');

/** The record counts DoD 4.2 names. */
export const STATS_N = [0, 1, 2, 6, 12];

/** The three viewports DoD 4.0 names, and the drawer heights §8.6 gives. */
export const FIT_VIEWPORTS = [
  { width: 480, height: 320 },
  { width: 960, height: 640 },
  { width: 1600, height: 900 },
];
export const FIT_NODE_COUNTS = [1, 6, 40];
/** §8.6: collapsed max 190 px; open drawers here are docked at that height. */
export const FIT_DRAWER_HEIGHT = 190;

async function loadModules() {
  const require = createRequire(join(REPO_ROOT, 'package.json'));
  const { build } = await import(pathToFileURL(require.resolve('esbuild')).href);
  const entry = [
    "export { fit, usableViewport } from './webview/layout/fit.js';",
    "export { treeLayout } from './webview/layout.js';",
    "export { boundsOf } from './webview/viewport.js';",
    "export { statsLayout } from './webview/stats/layout.js';",
    "export { createStore } from './webview/store.js';",
    "export { statsWireRecords } from './src/stats/wire.js';",
  ].join('\n');
  const result = await build({
    stdin: { contents: entry, resolveDir: REPO_ROOT, sourcefile: 'gen-webview-goldens-entry.ts', loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    packages: 'external',
    logLevel: 'silent',
  });
  const js = result.outputFiles[0];
  if (js === undefined) throw new Error('the webview bundle produced no javascript');
  const mod = { exports: {} };
  const factory = new Function('require', 'module', 'exports', js.text);
  factory(require, mod, mod.exports);
  return mod.exports;
}

/** A session with `count` agents: a root and `count - 1` depth-1 children, one call each. */
export function sessionOf(count) {
  const children = [];
  for (let i = 1; i < count; i += 1) {
    const id = `agent-${String(i)}`;
    children.push({
      id: `tool-${String(i)}`,
      toolName: 'Agent',
      status: 'done',
      inputPreview: '{"subagent_type":"worker"}',
    });
    children.push({
      id,
      kind: 'subagent',
      label: `worker-${String(i)}`,
      status: 'done',
      spawnDepth: 1,
      children: [{ id: `call-${String(i)}`, toolName: 'Read', status: 'done', inputPreview: '{}' }],
      contextNow: { prompt: 1000, output: 100 },
      burn: { prompt: 2000, output: 200 },
      startedAt: 1000 + i,
    });
  }
  const spawnEdges = [];
  for (let i = 1; i < count; i += 1) {
    spawnEdges.push({
      toolUseId: `tool-${String(i)}`,
      agentId: `agent-${String(i)}`,
      parentNodeId: 'root',
      depth: 1,
      recordedDepth: 1,
    });
  }
  return {
    sessionId: `fit-${String(count)}`,
    projectSlug: 'synthetic-fit',
    workspaceMatch: true,
    liveness: 'ended',
    schemaOk: true,
    root: {
      id: 'root',
      kind: 'main',
      label: 'fit subject',
      status: 'done',
      spawnDepth: 0,
      children,
      contextNow: { prompt: 5000, output: 500 },
      burn: { prompt: 9000, output: 900 },
      startedAt: 1000,
    },
    totals: { costUsd: 0 },
    spawnEdges,
  };
}

function fitCases(m) {
  const cases = [];
  for (const nodes of FIT_NODE_COUNTS) {
    const placements = m.treeLayout(sessionOf(nodes), 'root', { collapseDepth: Number.POSITIVE_INFINITY }).filter((p) => !p.hidden);
    const bounds = m.boundsOf(placements.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })));
    for (const viewport of FIT_VIEWPORTS) {
      for (const drawerOpen of [false, true]) {
        const drawer = drawerOpen
          ? { x: 0, y: viewport.height - FIT_DRAWER_HEIGHT, w: viewport.width, h: FIT_DRAWER_HEIGHT }
          : null;
        cases.push({
          nodes,
          agents: placements.length,
          viewport,
          drawer,
          bounds,
          usable: m.usableViewport(viewport, drawer),
          transform: m.fit(bounds, viewport, drawer),
        });
      }
    }
  }
  return cases;
}

async function statsRecords() {
  const names = (await readdir(STATS_RECORDS_DIR)).filter((n) => n.endsWith('.json')).sort();
  const out = [];
  for (const name of names) {
    out.push({ stem: name.replace(/\.json$/u, ''), record: JSON.parse(await readFile(join(STATS_RECORDS_DIR, name), 'utf8')) });
  }
  return out;
}

/** The production path from records to layout: wire gate -> store -> layout. */
function layoutThrough(m, records) {
  const wire = m.statsWireRecords(records);
  if (wire.dropped !== 0) throw new Error(`the wire gate refused a committed golden: ${wire.reasons.join('; ')}`);
  const store = m.createStore();
  store.handleMessage({ type: 'statsSnapshot', records: wire.records });
  store.handleMessage({ type: 'statsStore', records: wire.records, enabled: true });
  const view = store.getView();
  return m.statsLayout(view.statsLive, view.statsStoreEnabled);
}

function text(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function planFiles(m) {
  const files = new Map();
  files.set(FIT_GOLDEN, text({ generator: 'scripts/gen-webview-goldens.mjs', drawerHeight: FIT_DRAWER_HEIGHT, cases: fitCases(m) }));

  const all = await statsRecords();
  // The corpus goldens, in stem order, for the N-record cases: the first N of
  // the harvested records — synthetic ones excluded, so the twelve R8 cases
  // and the N cases read different populations.
  const corpus = all.filter((e) => !e.stem.includes('-synthetic-'));
  for (const n of STATS_N) {
    const records = corpus.slice(0, n).map((e) => e.record);
    if (records.length !== n) throw new Error(`fewer than ${String(n)} corpus goldens on disk`);
    files.set(
      join(STATS_GOLDEN_DIR, `n${String(n)}.json`),
      text({ generator: 'scripts/gen-webview-goldens.mjs', records: corpus.slice(0, n).map((e) => e.stem), layout: layoutThrough(m, records) }),
    );
  }
  for (const entry of all.filter((e) => e.stem.includes('-synthetic-'))) {
    const id = entry.stem.replace(/^[a-z]+-synthetic-/u, '');
    files.set(
      join(STATS_GOLDEN_DIR, `r8-${id}.json`),
      text({ generator: 'scripts/gen-webview-goldens.mjs', records: [entry.stem], layout: layoutThrough(m, [entry.record]) }),
    );
  }
  return files;
}

async function main() {
  const check = process.argv.includes('--check');
  const m = await loadModules();
  const files = await planFiles(m);
  await mkdir(STATS_GOLDEN_DIR, { recursive: true });

  const differences = [];
  for (const [path, body] of files) {
    const current = existsSync(path) ? await readFile(path, 'utf8') : null;
    if (current === body) continue;
    differences.push(`${current === null ? 'missing' : 'changed'}: ${path.slice(REPO_ROOT.length)}`);
    if (!check) await writeFile(path, body, 'utf8');
  }
  // A stale stats golden describes a record that no longer exists; the
  // directory is OWNED by this script, so anything unaccounted for is stale.
  for (const name of await readdir(STATS_GOLDEN_DIR)) {
    if (name === 'README.md') continue;
    const path = join(STATS_GOLDEN_DIR, name);
    if (files.has(path)) continue;
    differences.push(`stale: ${path.slice(REPO_ROOT.length)}`);
    if (!check) await rm(path);
  }

  const noun = `${String(files.size)} file${files.size === 1 ? '' : 's'}`;
  if (check) {
    if (differences.length === 0) {
      console.log(`gen-webview-goldens --check: ${noun}, all current`);
      return;
    }
    console.error(`gen-webview-goldens --check: ${String(differences.length)} difference(s)`);
    for (const line of differences) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log(`gen-webview-goldens: ${noun} written`);
  if (differences.length === 0) console.log('  no change');
  else for (const line of differences) console.log(`  ${line}`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
