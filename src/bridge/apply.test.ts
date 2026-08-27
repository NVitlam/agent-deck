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

import type { ApplyError, SessionState } from '../model/events.js';
import { SessionPatchError, applySessionPatch, deepFreeze, parkedOf } from './apply.js';

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
      contextNow: { prompt: 0, output: 0 },
      burn: { prompt: 0, output: 0 },
      startedAt: 1,
    },
    totals: { costUsd: 0 },
    contextNow: { prompt: 0, output: 0 },
    burn: { prompt: 0, output: 0 },
    spawnEdges: [],
  });

  /**
   * `0.1.3` changed what "cannot be applied" COSTS. An op addressing an id this
   * tree does not have is DIVERGENCE — reported, skipped, survivable — and only
   * a patch that would leave the session without an agent root is still fatal.
   * Both halves are asserted, because the whole value of the change is in the
   * difference between them.
   */
  /**
   * AN UNKNOWN `afterId` APPENDS. It does not drop, and until now nothing in
   * this file said so.
   *
   * Found by a `phase-verifier` mutation: replacing the append with a `break`
   * — making a divergent insert silently discard its node, which is exactly
   * the `0.1.2` behaviour this release exists to remove — left
   * `apply.test.ts`, `resync.test.ts` and `webview/store.test.ts` **92/92
   * green**. Only one assertion in `src/model/session.test.ts`, three modules
   * away, went red. The reducer's own suite could not tell the fix from the
   * defect.
   *
   * So it is asserted here, at the reducer, on both halves: the node is
   * PRESENT (membership, which nothing recovers) and it is LAST (order, which
   * the next `reorderChildren` or a resync corrects). The report is asserted
   * too — appending silently would be a different defect, one where the
   * webview never learns it has diverged and never asks for a snapshot.
   */
  it('appends a node whose afterId anchor is missing, and says that it did', () => {
    const withChild = applySessionPatch(base, {
      tree: [
        {
          op: 'insertNode',
          parentId: 'root',
          afterId: null,
          node: {
            id: 'tool-1',
            toolName: 'Read',
            status: 'done',
            inputPreview: '{}',
          },
        },
      ],
    });
    expect(withChild.root.children.map((c) => c.id)).toStrictEqual(['tool-1']);

    const errors: { op: string; id?: string }[] = [];
    const diverged = applySessionPatch(withChild, {
      tree: [
        {
          op: 'insertNode',
          parentId: 'root',
          // A sibling this tree has never seen — precisely what a dropped
          // message produces.
          afterId: 'tool-never-arrived',
          node: {
            id: 'tool-2',
            toolName: 'Bash',
            status: 'running',
            inputPreview: '{}',
          },
        },
      ],
    }, { onError: (e) => errors.push({ op: e.op, id: e.id }) });

    // MEMBERSHIP: the node is in the tree. This is the half that matters, and
    // the half the mutation destroyed.
    expect(diverged.root.children.map((c) => c.id)).toContain('tool-2');
    // ORDER: appended, i.e. last. Wrong-but-recoverable, stated explicitly so
    // a future change to "insert at 0" is a decision rather than a drift.
    expect(diverged.root.children.map((c) => c.id)).toStrictEqual(['tool-1', 'tool-2']);
    // AND IT REPORTED. Appending in silence would leave the webview believing
    // its tree is correct, which is how `0.1.2` lost 246 nodes without a word.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.op).toBe('insertNode');
    expect(errors[0]?.id).toBe('tool-never-arrived');
  });

  it('reports a divergent op and throws only on a broken root invariant', () => {
    const errors: ApplyError[] = [];
    const next = applySessionPatch(
      base,
      { tree: [{ op: 'updateAgent', id: 'ghost', fields: { status: 'done' } }] },
      { onError: (e) => errors.push(e) },
    );
    expect(errors).toEqual([
      { op: 'updateAgent', id: 'ghost', reason: 'no node with id ghost' },
    ]);
    // Skipped, not half-applied: the tree is what it was.
    expect(next.root.status).toBe('running');
    // And with no reporter it is silent rather than fatal — the property that
    // lets a renderer call this without somewhere to put an exception.
    expect(() =>
      applySessionPatch(base, {
        tree: [{ op: 'updateAgent', id: 'ghost', fields: { status: 'done' } }],
      }),
    ).not.toThrow();

    expect(() =>
      applySessionPatch(base, { tree: [{ op: 'removeNode', id: base.root.id }] }),
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

/**
 * `parked` is optional on the wire and absent from every state built before it
 * existed, so the reducer has to answer three questions and each of them has a
 * wrong answer that is silent rather than loud.
 *
 * The proof that a REAL fixture's parked list survives a real snapshot and a
 * real diff is in `src/model/session.test.ts` and `src/bridge/messages.test.ts`,
 * driven by `graftSession`; this file owns the reducer's own contract, which is
 * why the states here are literals.
 */
describe('applySessionPatch — parked', () => {
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
      contextNow: { prompt: 0, output: 0 },
      burn: { prompt: 0, output: 0 },
      startedAt: 1,
    },
    totals: { costUsd: 0 },
    contextNow: { prompt: 0, output: 0 },
    burn: { prompt: 0, output: 0 },
    spawnEdges: [],
  });

  const withParked: SessionState = deepFreeze({
    ...base,
    parked: [
      {
        agentId: 'a-parked',
        code: 'noMatchingToolUse' as const,
        reason: 'no tool_use block carries toolu_missing',
        toolUseId: 'toolu_missing',
      },
    ],
  });

  it('normalizes an absent list to an empty one, so no caller repeats the ?? []', () => {
    expect(parkedOf(base)).toStrictEqual([]);
    expect(parkedOf(withParked)).toHaveLength(1);
  });

  it('a patch that does not mention parked keeps it — absence means unchanged', () => {
    const next = applySessionPatch(withParked, { fields: { liveness: 'idle' } });
    expect(next.liveness).toBe('idle');
    expect(next.parked).toStrictEqual(withParked.parked);
  });

  it('a patch that mentions parked replaces the whole list, including with empty', () => {
    const cleared = applySessionPatch(withParked, { parked: [] });
    expect(cleared.parked).toStrictEqual([]);
    const replaced = applySessionPatch(withParked, {
      parked: [{ agentId: 'a-other', code: 'sidecarMissing', reason: 'sidecar has not arrived' }],
    });
    expect(replaced.parked).toStrictEqual([
      { agentId: 'a-other', code: 'sidecarMissing', reason: 'sidecar has not arrived' },
    ]);
  });

  it('a state that never carried parked comes out without it, not with an empty one', () => {
    // The field is optional, and states built before it existed — the webview's
    // own test data among them — must survive a patch unchanged. Writing
    // `parked: []` onto them would make `apply(prev, diff)` stop deep-equalling
    // `next` for every such state, which is someone else's test failing for a
    // reason that has nothing to do with parking.
    const next = applySessionPatch(base, { fields: { liveness: 'ended' } });
    expect('parked' in next).toBe(false);
    expect(parkedOf(next)).toStrictEqual([]);
  });

  it('copies the entries rather than aliasing the patch, and freezes them', () => {
    const patchEntries = [
      { agentId: 'a-parked', code: 'ambiguousJoinKey' as const, reason: 'two candidates' },
    ];
    const next = applySessionPatch(base, { parked: patchEntries });
    expect(next.parked?.[0]).not.toBe(patchEntries[0]);
    expect(Object.isFrozen(next.parked?.[0])).toBe(true);
    // Mutating the patch afterwards must not reach into the produced state.
    patchEntries[0] = { agentId: 'mutated', code: 'ambiguousJoinKey', reason: 'mutated' };
    expect(next.parked?.[0]?.agentId).toBe('a-parked');
  });

  it('an optional key absent on the way in stays absent on the way out', () => {
    // `toStrictEqual` distinguishes a missing key from one holding `undefined`,
    // and so does the round-trip contract the bridge relies on. A reducer that
    // wrote `toolUseId: undefined` would make apply(prev, diff) stop deep-
    // equalling next for every parked graft that never had a join key.
    const next = applySessionPatch(base, {
      parked: [{ agentId: 'a-parked', code: 'missingJoinKey', reason: 'no toolUseId' }],
    });
    expect('toolUseId' in (next.parked?.[0] as object)).toBe(false);
    expect('parentAgentId' in (next.parked?.[0] as object)).toBe(false);
  });
});
