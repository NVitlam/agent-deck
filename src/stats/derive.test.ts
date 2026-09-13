/**
 * DoD 2.2 — the deriver is pure, proved by walking its whole import graph.
 *
 * "`derive.ts` imports only `events.ts`, `schema.ts`, `constants.ts`,
 * `toolclass.ts`; a test asserts the import list."
 *
 * ## HOW THAT LINE IS READ HERE, stated rather than assumed
 *
 * Taken as the literal set of files `derive.ts` may name, the DoD contradicts
 * its own Modules list four lines above it, which also names `loops.ts`,
 * `context.ts`, `stalls.ts`, `pricing.ts` and `exclude.ts` — five modules that
 * would be unreachable, and therefore dead, if `derive.ts` could not import
 * them.
 *
 * So the guard asserts the property the sentence is FOR, in the strongest form
 * that does not make five named modules dead: the transitive graph rooted at
 * `derive.ts` is exactly the stats pure layer plus `events.ts`, enumerated, with
 * the count pinned beside the set; the four modules the DoD names are all in it;
 * and NOTHING outside `src/stats/**` and `src/model/events.ts` is reachable at
 * any depth. That forbids every `node:` builtin, every package, `vscode`, and
 * all three engines — which is what "pure" means here and is strictly more than
 * a list of four names would check.
 *
 * **This reading is recorded in the Phase 2 handoff rather than taken
 * silently.** The pattern is `src/bridge/apply.test.ts`, which the DoD names,
 * and the walker below is its walker: TypeScript's own `preProcessFile`, so
 * comments and string literals cannot be mistaken for imports — `apply.ts`'s
 * header contains the text `node:crypto` as a warning, and a grep would have
 * flagged the warning and missed a real import three files away.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONSTANTS } from './constants.js';
import { deriveStats } from './derive.js';
import { buildSyntheticStatsFixtures } from './synthetic.testkit.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DERIVE = fileURLToPath(new URL('./derive.ts', import.meta.url));
/** A module that really does reach a `node:` builtin — the vacuity control. */
const CANONICAL = fileURLToPath(new URL('./canonical.ts', import.meta.url));

/** Everything the deriver is allowed to reach, transitively. */
const STATS_PURE_LAYER = [
  'src/model/events.ts',
  'src/stats/constants.ts',
  'src/stats/context.ts',
  'src/stats/derive.ts',
  'src/stats/exclude.ts',
  'src/stats/loops.ts',
  'src/stats/pricing.ts',
  'src/stats/schema.ts',
  'src/stats/stalls.ts',
  // v0.8.0 Phase 7, DoD 7.2. F14's six figures, and it joins the layer under
  // the same reading as `stalls.ts` and the other four the DoD's Modules list
  // names: it is reachable from `derive.ts`, it imports `events.ts` and
  // `schema.ts` and nothing else, and it holds no clock. Widened here with the
  // reason on it rather than by adding a name.
  'src/stats/timing.ts',
  'src/stats/toolclass.ts',
];

interface Violation {
  file: string;
  specifier: string;
  why: string;
}

interface GraphScan {
  modules: string[];
  /** Edges actually followed. Zero means the walk proved nothing. */
  edges: number;
  violations: Violation[];
  unresolved: string[];
}

function repoRelative(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

function specifiersOf(source: string): string[] {
  const pre = ts.preProcessFile(source, true, true);
  return pre.importedFiles.map((f) => f.fileName).concat(pre.ambientExternalModules ?? []);
}

function classify(specifier: string): string | undefined {
  if (specifier.startsWith('node:')) return 'node: builtin';
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return 'bare package specifier';
  return undefined;
}

async function resolveModule(fromFile: string, specifier: string): Promise<string | undefined> {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base.replace(/\.js$/u, '.ts'), `${base}.ts`, base, join(base, 'index.ts')]) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

async function scanGraph(entry: string): Promise<GraphScan> {
  const seen = new Set<string>();
  const queue = [entry];
  const violations: Violation[] = [];
  const unresolved: string[] = [];
  let edges = 0;

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, 'utf8');
    for (const specifier of specifiersOf(source)) {
      edges += 1;
      const why = classify(specifier);
      if (why !== undefined) {
        violations.push({ file: repoRelative(file), specifier, why });
        continue;
      }
      const resolved = await resolveModule(file, specifier);
      if (resolved === undefined) {
        unresolved.push(`${repoRelative(file)} -> ${specifier}`);
        continue;
      }
      queue.push(resolved);
    }
  }
  return { modules: [...seen].map(repoRelative).sort(), edges, violations, unresolved };
}

describe('DoD 2.2 — deriveStats is pure', () => {
  it('reaches exactly the stats pure layer and nothing else', async () => {
    const scan = await scanGraph(DERIVE);
    expect(scan.modules).toEqual(STATS_PURE_LAYER);
    // The count beside the set, per rule 19's shape: a set comparison written
    // against an accidentally empty listing passes vacuously, and a count is
    // the cheapest thing that goes red when it does.
    expect(scan.modules).toHaveLength(10);
    expect(scan.edges).toBeGreaterThan(0);
    expect(scan.unresolved).toEqual([]);
  });

  it('reaches every module the DoD names', async () => {
    const scan = await scanGraph(DERIVE);
    for (const named of [
      'src/model/events.ts',
      'src/stats/schema.ts',
      'src/stats/constants.ts',
      'src/stats/toolclass.ts',
    ]) {
      expect(scan.modules).toContain(named);
    }
  });

  it('imports no node: builtin and no package, anywhere in that graph', async () => {
    const scan = await scanGraph(DERIVE);
    expect(scan.violations).toEqual([]);
  });

  it('contains no clock, no require(), no dynamic import(), no vscode', async () => {
    const scan = await scanGraph(DERIVE);
    for (const module of scan.modules) {
      const source = await readFile(join(REPO_ROOT, module), 'utf8');
      // SCANNED WITH COMMENTS STRIPPED. `stall.test.ts` records why: its first
      // draft matched `Date.now()` inside `stall.ts`'s own PROSE — a comment
      // explaining that an mtime need not agree with `Date.now()` — and
      // reported a purity violation in a file that calls nothing. Anchor to
      // code. `derive.ts`'s own header discusses clocks in exactly that way.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/^\s*\/\/.*$/gmu, '');
      expect(code).not.toMatch(/\brequire\s*\(/u);
      expect(code).not.toMatch(/\bimport\s*\(/u);
      expect(code).not.toMatch(/\bprocess\./u);
      expect(code).not.toMatch(/Date\.now\(\)/u);
      expect(code).not.toMatch(/Math\.random\(\)/u);
      expect(code).not.toContain('vscode');
    }
  });

  it('the walker itself detects the bug shape', async () => {
    // If the four tests above passed trivially they would prove nothing.
    // `canonical.ts` is in the same directory and really does import
    // `node:crypto`, so a working walker must come back dirty on it.
    const scan = await scanGraph(CANONICAL);
    const builtins = scan.violations.filter((v) => v.why === 'node: builtin');
    expect(builtins.map((v) => v.specifier)).toContain('node:crypto');
  });
});

describe('purity, observed rather than argued', () => {
  it('two derivations of one state produce identical bytes', () => {
    for (const fixture of buildSyntheticStatsFixtures()) {
      const a = JSON.stringify(deriveStats(fixture.state, { now: 5 }));
      const b = JSON.stringify(deriveStats(fixture.state, { now: 5 }));
      expect(b).toBe(a);
    }
  });

  it('deriving one session cannot affect the next', () => {
    // The regression this pins is real and was committed in this file's first
    // draft: the tool-class resolver read a MODULE-LEVEL `currentEngine` that
    // `deriveStats` assigned on entry. Deriving a Codex session and then a CC
    // one would have classified the second under the first's vocabulary if the
    // assignment were ever skipped or interleaved. Derived in both orders, the
    // results must match.
    const fixtures = buildSyntheticStatsFixtures();
    const codex = fixtures.find((f) => f.id === '08-codex-window');
    const cc = fixtures.find((f) => f.id === '01-reread-loop');
    expect(codex).toBeDefined();
    expect(cc).toBeDefined();
    if (codex === undefined || cc === undefined) return;

    const ccAlone = JSON.stringify(deriveStats(cc.state, { now: 5 }));
    deriveStats(codex.state, { now: 5 });
    const ccAfterCodex = JSON.stringify(deriveStats(cc.state, { now: 5 }));
    expect(ccAfterCodex).toBe(ccAlone);
  });

  it('the record states the constants it was derived under', () => {
    const cc = buildSyntheticStatsFixtures().find((f) => f.id === '01-reread-loop');
    if (cc === undefined) throw new Error('fixture missing');
    const record = deriveStats(cc.state, { now: 5 });
    expect(record.params.loopMin).toBe(DEFAULT_CONSTANTS.loopMin);
    expect(record.params.spikeTokens).toBe(DEFAULT_CONSTANTS.spikeTokens.cc);
  });
});
