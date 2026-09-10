/**
 * DoD 3.6 — the store is NEVER read back into `SessionState`.
 *
 * G7 as amended ends with the clause that makes the whole amendment safe:
 * *"The store is never read back into `SessionState`; it feeds the Trends view
 * and the API only."* Without it, "append-only history under globalStorage"
 * would be one import away from session replay — a hard exclusion of this
 * product since v1, and the reason G7 existed in the first place.
 *
 * A comment cannot hold that line. This file does, statically: **nothing under
 * `src/model/`, `src/parser/`, `src/opencode/` or `src/codex/` may reach
 * `src/stats/store.ts`, at any depth.**
 *
 * ## Transitively, not one hop
 *
 * The obvious version greps each engine directory for `stats/store`, and it is
 * the wrong strength: `src/model/session.ts` importing `src/stats/derive.ts`
 * which imports the store would pass it while being exactly the thing forbidden.
 * So the graph is WALKED, with TypeScript's own preprocessor, from every file
 * in the four directories — the technique `src/bridge/apply.test.ts` uses for
 * the webview bundle's `node:` purity, and for the same reason it gives: a grep
 * reads comments and string literals as code, and this file's own subject
 * appears in prose in several of the modules it scans.
 *
 * ## The controls
 *
 * A scanner that finds nothing is indistinguishable from a scanner that looks
 * nowhere, so three things are asserted beside the rule: the walk visits a
 * non-trivial number of files; it CAN see the store when pointed at something
 * that really imports it (`src/extension.ts`, the one legitimate consumer); and
 * a synthetic module that imports the store transitively is caught.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const STORE = resolve(REPO_ROOT, 'src', 'stats', 'store.ts');

/** The four directories G7's last clause names, verbatim. */
const ENGINE_DIRS = ['src/model', 'src/parser', 'src/opencode', 'src/codex'];

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

/** Every `.ts` file under a directory that is not a test or a testkit. */
function productionFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      // Tests and testkits are excluded and the exclusion is STATED (rule 18).
      // Neither is bundled — esbuild builds from `src/extension.ts` — so
      // neither can reach a user, and a test legitimately reads the store to
      // assert what it wrote. `store.test.ts` is the obvious example and lives
      // in `src/stats/`, but the same applies in the engine directories.
      if (entry.endsWith('.test.ts') || entry.endsWith('.testkit.ts')) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** Every module specifier in a source file, comments and strings excluded. */
function specifiersOf(source: string): string[] {
  const pre = ts.preProcessFile(source, true, true);
  return pre.importedFiles.map((f) => f.fileName).concat(pre.ambientExternalModules ?? []);
}

/** Resolve a relative ESM specifier (`./x.js`) to the `.ts` file on disk. */
function resolveModule(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base.replace(/\.js$/u, '.ts'), `${base}.ts`, base]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this candidate. A specifier that resolves to nothing is reported
      // by the caller rather than swallowed here.
    }
  }
  return undefined;
}

interface Walk {
  /** Every file reached, including the roots. */
  visited: Set<string>;
  /** The first path from a root to the store, or null. */
  pathToStore: string[] | null;
  /** Specifiers that resolved to nothing. Reported, never ignored. */
  unresolved: string[];
}

/** Walk the import graph from `roots`, looking for `target`. */
async function walkFrom(roots: readonly string[], target: string): Promise<Walk> {
  const visited = new Set<string>();
  const unresolved: string[] = [];
  const queue: { file: string; trail: string[] }[] = roots.map((file) => ({
    file,
    trail: [file],
  }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const { file, trail } = next;
    if (resolve(file) === target) {
      return { visited, pathToStore: trail.map((f) => relative(REPO_ROOT, f)), unresolved };
    }
    if (visited.has(file)) continue;
    visited.add(file);
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const specifier of specifiersOf(source)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
      const resolved = resolveModule(file, specifier);
      if (resolved === undefined) {
        unresolved.push(`${relative(REPO_ROOT, file)} -> ${specifier}`);
        continue;
      }
      if (!visited.has(resolved)) queue.push({ file: resolved, trail: [...trail, resolved] });
    }
  }
  return { visited, pathToStore: null, unresolved };
}

describe('DoD 3.6: no engine module reaches the local store', () => {
  it('the walk visits a non-trivial number of files, and resolves every specifier', async () => {
    const roots = ENGINE_DIRS.flatMap((dir) => productionFiles(resolve(REPO_ROOT, dir)));
    // The control that makes the rule below mean something: 30-odd production
    // modules across four engines. A floor, not an equality, because the count
    // moves with the next module.
    expect(roots.length, 'the engine directories yielded almost no files').toBeGreaterThan(20);
    const walk = await walkFrom(roots, STORE);
    expect(walk.visited.size).toBeGreaterThanOrEqual(roots.length);
    // Rule 18: a specifier the walk could not follow is a hole in the scan,
    // and a hole is exactly how a forbidden import would hide.
    expect(walk.unresolved).toStrictEqual([]);
  });

  it('nothing under model, parser, opencode or codex imports src/stats/store.ts', async () => {
    for (const dir of ENGINE_DIRS) {
      const roots = productionFiles(resolve(REPO_ROOT, dir));
      expect(roots.length, `${dir} yielded no production files`).toBeGreaterThan(0);
      const walk = await walkFrom(roots, STORE);
      expect(
        walk.pathToStore,
        `${dir} reaches the store: ${walk.pathToStore?.join(' -> ') ?? ''}`,
      ).toBeNull();
    }
  });

  it('THE SCANNER CAN SEE THE STORE — extension.ts reaches it, and is meant to', async () => {
    // Without this the test above is "a walk that finds nothing", which is
    // indistinguishable from a walk that looks nowhere. `src/extension.ts` is
    // the one production consumer G7 allows, so it is both the control and the
    // statement of who is permitted.
    const walk = await walkFrom([resolve(REPO_ROOT, 'src', 'extension.ts')], STORE);
    expect(walk.pathToStore).not.toBeNull();
    expect(walk.pathToStore?.[0]).toBe(join('src', 'extension.ts'));
    expect(walk.pathToStore?.at(-1)).toBe(join('src', 'stats', 'store.ts'));
  });

  it('a TRANSITIVE import is caught, not just a direct one', async () => {
    // The strength control. A one-hop grep would pass this arrangement, which
    // is the whole reason the graph is walked: a model file importing a helper
    // that imports the store is exactly the shape G7 forbids and exactly the
    // shape a shallow check misses.
    const dir = await mkdtemp(join(tmpdir(), 'agent-deck-readback-'));
    scratch.push(dir);
    const helper = join(dir, 'helper.ts');
    const offender = join(dir, 'offender.ts');
    /*
     * A RELATIVE specifier, and the first draft used an absolute one and
     * failed — usefully.
     *
     * `resolveModule` only follows specifiers beginning `.` or `/`, which is
     * every real import in this repository and is deliberate: a bare specifier
     * is a package, not a file in this tree. A Windows absolute path begins
     * `C:/`, so the synthetic offender's import was skipped and the control
     * reported that a transitive import had NOT been caught.
     *
     * That is the control working: it went red because the SCANNER could not
     * see the arrangement, which is exactly what it exists to detect. The fix
     * is to write the specifier the way production writes one.
     */
    const toStore = relative(dir, STORE).replace(/\\/gu, '/').replace(/\.ts$/u, '.js');
    await writeFile(
      helper,
      `import { StatsStore } from '${toStore.startsWith('.') ? toStore : `./${toStore}`}';\nexport const x = StatsStore;\n`,
      'utf8',
    );
    await writeFile(offender, `import { x } from './helper.js';\nexport const y = x;\n`, 'utf8');
    const walk = await walkFrom([offender], STORE);
    expect(walk.pathToStore).not.toBeNull();
    expect(walk.pathToStore).toHaveLength(3);
  });
});
