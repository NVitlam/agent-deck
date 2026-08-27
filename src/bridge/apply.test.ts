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

import type { ApplyError, SessionState, ToolNode } from '../model/events.js';
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
      tokens: { in: 0, out: 0 },
      startedAt: 1,
    },
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    spawnEdges: [],
  });

  /**
   * DoD 5.5.1 changed what "cannot be applied" costs. An op addressing an id
   * this tree does not have is DIVERGENCE — reported, skipped, survivable —
   * and only a patch that would leave the session without an agent root is
   * still fatal. This test asserts both halves rather than one, because the
   * whole value of the change is in the difference between them.
   */
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
      tokens: { in: 0, out: 0 },
      startedAt: 1,
    },
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
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

/**
 * `engine` — gate amendment B2.
 *
 * The reducer has to honour a key `diffSessionState` can never emit, because
 * nothing can change a session's engine. That makes this file the ONLY place
 * the behaviour can be exercised at all: every state here is a literal, so a
 * patch carrying `engine` can be handed to the reducer directly. Nothing below
 * claims a production path produces such a patch — none does, by construction,
 * and `src/model/session.test.ts` says so where it tests the diff half.
 */
describe('applySessionPatch — engine', () => {
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

  const stamped: SessionState = deepFreeze({ ...base, engine: 'cc' as const });

  it('a state that never carried engine comes out without it, not with a made-up cc', () => {
    // Absence reads as `'cc'` by documented convention, which is exactly why
    // the reducer must not WRITE `'cc'` here: a state built before the field
    // existed — the webview's own test data among them — has to survive a patch
    // byte-for-byte, or apply(prev, diff) stops deep-equalling next for reasons
    // that have nothing to do with engines.
    const next = applySessionPatch(base, { fields: { liveness: 'idle' } });
    expect('engine' in next).toBe(false);
  });

  it('a patch that does not mention engine keeps it — absence means unchanged', () => {
    const next = applySessionPatch(stamped, { fields: { liveness: 'ended' } });
    expect(next.liveness).toBe('ended');
    expect(next.engine).toBe('cc');
  });

  it('honours an engine key if one ever arrives, in both directions', () => {
    // This is the branch the gate bought and knowingly paid for. It cannot be
    // reached from `diffSessionState`; it is reachable here because the patch
    // is a literal. If the key were dropped from the reducer as dead code, a
    // patch carrying it would be silently ignored instead of failing.
    expect(applySessionPatch(base, { fields: { engine: 'opencode' } }).engine).toBe('opencode');
    expect(applySessionPatch(stamped, { fields: { engine: 'opencode' } }).engine).toBe('opencode');
    expect(applySessionPatch(stamped, { fields: { engine: 'cc' } }).engine).toBe('cc');
  });
});

/**
 * `truncated` — gate amendment B7.
 *
 * The observed engine's OWN truncation claim, which `redact.ts`'s marker is
 * not. The CC engine never sets it, so a CC state simply never has the key;
 * what is being tested here is that the wire can carry it at all, because an
 * optional field the patch cannot express breaks the exactness of the round
 * trip rather than merely under-reporting it.
 */
describe('applySessionPatch — ToolNode.truncated', () => {
  function stateWith(truncated: boolean | undefined): SessionState {
    const tool: ToolNode = {
      id: 't1',
      toolName: 'Bash',
      status: 'done',
      inputPreview: 'ls',
    };
    if (truncated !== undefined) tool.truncated = truncated;
    return deepFreeze<SessionState>({
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
        children: [tool],
        tokens: { in: 0, out: 0 },
        startedAt: 1,
      },
      totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      spawnEdges: [],
    });
  }

  function toolOf(state: SessionState): ToolNode {
    return state.root.children[0] as ToolNode;
  }

  it('carries the flag through a patch that does not mention it', () => {
    // The clone is where this is lost: a `cloneTool` that forgot the key would
    // drop the flag on EVERY patch, including ones about an unrelated node.
    const next = applySessionPatch(stateWith(true), { fields: { liveness: 'idle' } });
    expect(toolOf(next).truncated).toBe(true);
  });

  it('sets, changes and clears it, and a clear removes the key rather than writing false', () => {
    const set = applySessionPatch(stateWith(undefined), {
      tree: [{ op: 'updateTool', id: 't1', fields: { truncated: true } }],
    });
    expect(toolOf(set).truncated).toBe(true);

    const changed = applySessionPatch(stateWith(true), {
      tree: [{ op: 'updateTool', id: 't1', fields: { truncated: false } }],
    });
    // `false` is the engine claiming the payload IS whole, which is a different
    // statement from making no claim. It must survive as `false`.
    expect(toolOf(changed).truncated).toBe(false);
    expect('truncated' in toolOf(changed)).toBe(true);

    const cleared = applySessionPatch(stateWith(true), {
      tree: [{ op: 'updateTool', id: 't1', fields: { truncated: null } }],
    });
    expect('truncated' in toolOf(cleared)).toBe(false);
  });

  it('a tool node that never carried the flag comes out without the key', () => {
    const next = applySessionPatch(stateWith(undefined), {
      tree: [{ op: 'updateTool', id: 't1', fields: { status: 'error' } }],
    });
    expect('truncated' in toolOf(next)).toBe(false);
    expect(toolOf(next)['status']).toBe('error');
  });
});
