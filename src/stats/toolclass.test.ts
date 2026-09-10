/**
 * v0.7.0 Phase 1, DoD 1.3 — the generated tool-class table.
 *
 * ## Two legs, and why it is not one
 *
 * DoD 1.3 asks that `toolclass.ts` agree with `TOOLCLASS.md` per engine. That
 * census is tracked ONLY in the private `lab/` repository and reaches this
 * checkout through a directory junction that `.gitignore` denies — so a single
 * test reading it would pass on a developer machine and be silently absent from
 * every fresh clone and every CI run. This repository has shipped that exact
 * defect once already, when CI ran a spike audit against a checkout with no
 * `spike/` and could only ever exit 1.
 *
 * So:
 *
 *   - **The everywhere leg** checks the committed rows against the lookups
 *     derived from them, per engine, and recomputes `TOOLCLASS_DIGEST`. A hand
 *     edit of the table without regenerating goes red on any machine.
 *   - **The dev-only leg** runs `gen-toolclass.mjs --check`, which is the real
 *     agreement with the census. It states its skip (rule 18) rather than
 *     vanishing.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  classOf,
  FILE_CLASSES,
  fileKeyOf,
  filePathOf,
  inputShapeOf,
  TOOLCLASS_DIGEST,
  TOOLCLASS_ROWS,
  type ToolEngine,
} from './toolclass.js';

const CENSUS = 'docs/evidence/phase-0-stats/TOOLCLASS.md';
const ENGINES: readonly ToolEngine[] = ['cc', 'opencode', 'codex'];

describe('toolclass — the committed table is internally consistent', () => {
  it('recomputes TOOLCLASS_DIGEST from the rows', () => {
    // Same canon as `scripts/gen-toolclass.mjs:digestOf` — structural, so no
    // separator character has to be chosen and no two rows can collide. If
    // someone edits a row by hand without regenerating, this is what goes red.
    const canon = TOOLCLASS_ROWS.map((r) =>
      JSON.stringify([r.engine, r.tool, r.class, r.input, r.fileKey ?? null]),
    ).join('\n');
    expect(createHash('sha256').update(canon, 'utf8').digest('hex')).toBe(TOOLCLASS_DIGEST);
  });

  it('carries rows for all three engines and nothing else', () => {
    expect(new Set(TOOLCLASS_ROWS.map((r) => r.engine))).toEqual(new Set(ENGINES));
  });

  it('names each (engine, tool) pair exactly once', () => {
    const keys = TOOLCLASS_ROWS.map((r) => JSON.stringify([r.engine, r.tool]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('states a file key only on a class that can touch a file', () => {
    for (const row of TOOLCLASS_ROWS) {
      if (row.fileKey !== undefined) {
        expect(FILE_CLASSES.has(row.class), `${row.engine}:${row.tool}`).toBe(true);
      }
    }
  });
});

describe('toolclass — the lookups agree with the rows, per engine', () => {
  for (const engine of ENGINES) {
    it(`agrees for ${engine}`, () => {
      const rows = TOOLCLASS_ROWS.filter((r) => r.engine === engine);
      // Non-vacuity: every engine really has rows, so a filter typo cannot
      // make this pass by iterating nothing.
      expect(rows.length).toBeGreaterThan(0);

      for (const row of rows) {
        expect(classOf(engine, row.tool), `${row.tool} class`).toBe(row.class);
        expect(inputShapeOf(engine, row.tool), `${row.tool} input`).toBe(row.input);
        expect(fileKeyOf(engine, row.tool), `${row.tool} fileKey`).toBe(row.fileKey);
      }
    });
  }

  it('keys by ENGINE as well as name — the vocabularies overlap', () => {
    // `read` is OpenCode's; CC has `Read`. Asking the wrong engine must not
    // answer from the other's table.
    expect(classOf('opencode', 'read')).toBe('read');
    expect(classOf('cc', 'read')).toBe('other');
    expect(classOf('cc', 'Read')).toBe('read');
  });
});

describe('toolclass — unknown tools have a defined answer, not a guess', () => {
  it('classifies an unlisted tool as other, with no file key', () => {
    expect(classOf('cc', 'NoSuchToolEver')).toBe('other');
    expect(fileKeyOf('cc', 'NoSuchToolEver')).toBeUndefined();
    expect(inputShapeOf('cc', 'NoSuchToolEver')).toBe('none');
  });

  it('does NOT carry the spike’s three unobserved guesses', () => {
    // `derive-facts.mjs` classified these; no committed corpus contains one, so
    // the census has no row and neither does this table (G6 — a class for an
    // uncaptured tool is memory). If a harvest ever captures one, the census
    // gains a row, the generator carries it, and this test is what says so.
    expect(classOf('cc', 'NotebookEdit')).toBe('other');
    expect(classOf('opencode', 'patch')).toBe('other');
    expect(classOf('codex', 'local_shell_call')).toBe('other');
  });
});

describe('filePathOf — structure only, never a scan for path-shaped text', () => {
  it('reads the named key on a file class', () => {
    expect(filePathOf('cc', 'Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(filePathOf('opencode', 'edit', { filePath: '/x/y.ts' })).toBe('/x/y.ts');
  });

  it('gives a SEARCH scope no file path, though the key holds a real path', () => {
    // The recorded case: `Grep`/`glob` take a `path` that is where to LOOK, not
    // a file touched. The census gives them no key, so no amount of path-shaped
    // content in the value can produce one.
    expect(filePathOf('cc', 'Grep', { path: '/a/b', pattern: 'x' })).toBeUndefined();
    expect(filePathOf('opencode', 'glob', { path: '/a/b', pattern: 'x' })).toBeUndefined();
  });

  it('gives a shell call none, even when its input mentions a path', () => {
    expect(filePathOf('cc', 'Bash', { command: 'cat /etc/hosts' })).toBeUndefined();
    // Codex `exec`'s input is a STRING and can carry no key at all.
    expect(filePathOf('codex', 'exec', 'require("fs").readFileSync("/a")')).toBeUndefined();
  });

  it('refuses a non-string, empty, or absent value', () => {
    expect(filePathOf('cc', 'Read', {})).toBeUndefined();
    expect(filePathOf('cc', 'Read', { file_path: '' })).toBeUndefined();
    expect(filePathOf('cc', 'Read', { file_path: 42 })).toBeUndefined();
    expect(filePathOf('cc', 'Read', { file_path: null })).toBeUndefined();
  });

  it('refuses a non-object input without throwing (G3)', () => {
    for (const input of [null, undefined, 42, 'str', [1, 2], true]) {
      expect(() => filePathOf('cc', 'Read', input)).not.toThrow();
      expect(filePathOf('cc', 'Read', input)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The dev-only leg. Rule 18: a skip states itself.
// ---------------------------------------------------------------------------

const CENSUS_PRESENT = existsSync(CENSUS);

describe.skipIf(!CENSUS_PRESENT)(
  `toolclass — regenerates identically from ${CENSUS} (skipped when lab/ is absent)`,
  () => {
    it('gen-toolclass.mjs --check passes against the committed file', () => {
      // Exits 1 on any difference and writes nothing.
      const out = execFileSync('node', ['scripts/gen-toolclass.mjs', '--check'], {
        encoding: 'utf8',
      });
      expect(out).toContain('OK');
      expect(out).toContain(TOOLCLASS_DIGEST.slice(0, 12));
    }, 30_000);
  },
);
