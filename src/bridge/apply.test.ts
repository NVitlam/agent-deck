/**
 * The bundleability guard for `apply.ts`.
 *
 * `apply.ts` exists so the webview and the extension host run the SAME patch
 * reducer. That only works while the file — and everything it transitively
 * imports — stays free of `node:` builtins, `require`, and any bare package
 * specifier: a CSP-strict browser bundle cannot contain them. The file's header
 * asserts that property in prose; this file measures it.
 *
 * The import graph is resolved for real, from disk, with TypeScript's own
 * preprocessor rather than a grep of the one entry file. `preProcessFile`
 * reports static imports, `export ... from`, type-only imports, dynamic
 * `import()` and `require()`, and it ignores comments and string literals —
 * which matters here, because `apply.ts`'s own header comment contains the
 * text `node:crypto` as a warning. A grep would have flagged the warning and
 * missed a real import three files away.
 *
 * Two negative controls run alongside, because a scanner that finds nothing is
 * indistinguishable from a scanner that looks nowhere:
 *   - `session.ts` is walked with the same code and MUST come back dirty (it
 *     reaches `graft.ts`, which imports `node:crypto`);
 *   - a synthetic module containing the three forbidden shapes MUST have all
 *     three found.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { SessionState } from '../model/events.js';
import { SessionPatchError, applySessionPatch, deepFreeze } from './apply.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APPLY = fileURLToPath(new URL('./apply.ts', import.meta.url));
const SESSION = fileURLToPath(new URL('../model/session.ts', import.meta.url));

/** Everything `apply.ts` is allowed to reach, transitively. */
const PURE_TYPES_LAYER = ['src/bridge/apply.ts', 'src/model/events.ts'];

function repoRelative(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

interface Violation {
  file: string;
  specifier: string;
  why: string;
}

interface GraphScan {
  /** Repo-relative paths of every module reached, sorted. */
  modules: string[];
  /** Edges actually followed. Zero means the walk proved nothing. */
  edges: number;
  violations: Violation[];
  /** Specifiers that looked relative but resolved to no file on disk. */
  unresolved: string[];
}

/** Every module specifier in a source file, comments and strings excluded. */
function specifiersOf(source: string): string[] {
  const pre = ts.preProcessFile(source, true, true);
  // `ambientExternalModules` is folded in because a `declare module 'x'` would
  // otherwise be a hole in the scan. None is expected in this graph.
  return pre.importedFiles
    .map((f) => f.fileName)
    .concat(pre.ambientExternalModules ?? []);
}

function classify(specifier: string): string | undefined {
  if (specifier.startsWith('node:')) return 'node: builtin';
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return 'bare package specifier';
  }
  return undefined;
}

/** Resolve a relative ESM specifier (`./x.js`) to the .ts file on disk. */
async function resolveModule(fromFile: string, specifier: string): Promise<string | undefined> {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    base,
    join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

/** Walk the transitive import graph from `entry`, reporting what it finds. */
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

  return {
    modules: [...seen].map(repoRelative).sort(),
    edges,
    violations,
    unresolved,
  };
}

describe('apply.ts stays bundleable for the webview', () => {
  it('reaches exactly the pure-types layer and nothing else', async () => {
    const scan = await scanGraph(APPLY);
    expect(scan.modules).toEqual(PURE_TYPES_LAYER);
    // The walk must have followed at least one edge; an empty graph would
    // satisfy every assertion below while measuring nothing.
    expect(scan.edges).toBeGreaterThan(0);
    expect(scan.unresolved).toEqual([]);
  });

  it('imports no node: builtin and no package, anywhere in that graph', async () => {
    const scan = await scanGraph(APPLY);
    expect(scan.violations).toEqual([]);
  });

  it('contains no require() and no dynamic import(), in either module', async () => {
    const scan = await scanGraph(APPLY);
    for (const module of scan.modules) {
      const source = await readFile(join(REPO_ROOT, module), 'utf8');
      // preProcessFile already reports require/import() as importedFiles, so a
      // violation would have surfaced above; this pins the raw shape too, for
      // the case where the specifier is a variable and reports nothing.
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(stripped).not.toMatch(/\brequire\s*\(/);
      expect(stripped).not.toMatch(/\bimport\s*\(/);
      expect(stripped).not.toMatch(/\bprocess\./);
      expect(stripped).not.toContain('vscode');
    }
  });
});

// If these two pass trivially, the three tests above prove nothing.
describe('the guard itself detects the bug shape', () => {
  it('flags session.ts, which really does reach node:crypto', async () => {
    const scan = await scanGraph(SESSION);
    const nodeImports = scan.violations.filter((v) => v.why === 'node: builtin');
    expect(nodeImports.length).toBeGreaterThan(0);
    expect(nodeImports.map((v) => v.specifier)).toContain('node:crypto');
    // ...and it got there transitively, not from session.ts itself.
    expect(scan.modules).toContain('src/model/graft.ts');
    expect(scan.modules.length).toBeGreaterThan(PURE_TYPES_LAYER.length);
  });

  it('flags all three forbidden shapes in a synthetic module', () => {
    const synthetic = [
      "import { createHash } from 'node:crypto';",
      "import chokidar from 'chokidar';",
      "const fs = require('node:fs');",
      "const later = await import('node:path');",
      "// import { nothing } from 'node:fs' — a comment, not an import",
    ].join('\n');

    const found = specifiersOf(synthetic);
    expect(found).toContain('node:crypto');
    expect(found).toContain('chokidar');
    expect(found).toContain('node:fs');
    expect(found).toContain('node:path');
    // The commented-out import is not counted: 'node:fs' appears once.
    expect(found.filter((f) => f === 'node:fs')).toHaveLength(1);
    expect(found.map(classify).filter((c) => c !== undefined)).toHaveLength(4);
  });
});

describe('applySessionPatch — the properties the bridge relies on', () => {
  const base: SessionState = deepFreeze({
    sessionId: 's1',
    projectSlug: 'c--Users-dev-repo',
    workspaceMatch: true,
    liveness: 'live',
    schemaOk: true,
    root: {
      id: 'root',
      kind: 'main',
      label: 'root',
      status: 'running',
      spawnDepth: 0,
      children: [],
      tokens: { in: 0, out: 0 },
      startedAt: 1,
    },
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    spawnEdges: [],
  });

  it('throws SessionPatchError on a patch that cannot be applied', () => {
    expect(() =>
      applySessionPatch(base, {
        tree: [{ op: 'updateAgent', id: 'ghost', fields: { status: 'done' } }],
      }),
    ).toThrow(SessionPatchError);
  });

  it('does not mutate the state it was given, even when it throws', () => {
    const before = JSON.stringify(base);
    try {
      applySessionPatch(base, { tree: [{ op: 'removeNode', id: 'root' }] });
    } catch {
      // expected
    }
    expect(JSON.stringify(base)).toBe(before);
  });
});
