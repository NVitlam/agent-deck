/**
 * THE LAB BOUNDARY: code that CI runs must not need the private repository.
 *
 * `lab/` is a separate, private repository kept inside this checkout and
 * gitignored; `docs/` is a junction into it. A fresh clone and every CI runner
 * have neither. v0.7.0 reached `main` with CI red on exactly this: the OpenCode
 * golden generator read `docs/evidence/phase-0-stats/TOOLCLASS.md` at IMPORT
 * time, its test imports it, and 71 tests failed on a runner that had never
 * seen the census. Its own comment said it "only ever executes on a developer
 * machine" — true of the author's intent and false of the suite. A second test
 * stat'd the private runner ledger with no absence branch.
 *
 * So every string, template and regular-expression literal in the tracked
 * `scripts/` and `src/` code is scanned, through the TypeScript parser, for
 * `lab`, `docs/evidence` (or a lone `evidence` path segment, which is how
 * `join(root, 'docs', 'evidence', …)` spells it) and `TOOLCLASS`. The hits must
 * equal an enumerated allow-list EXACTLY — the set of files and the count per
 * file, rule 19 applied to source — so a new reference anywhere, including a
 * second one in an allowed file, goes red and has to be argued for here.
 *
 * COMMENTS ARE NOT SCANNED, deliberately. A comment cannot read a file, and
 * this repository cites its evidence documents by path in hundreds of doc
 * comments; stripping them would delete provenance and buy no safety. The
 * control below proves both halves: the same text is caught in code and not
 * in a comment.
 *
 * What a static scan cannot prove is that an allowed reference degrades when
 * `lab/` is absent. That is proved by running the suite with `lab/` moved
 * aside, which is part of this fix's gate (`GATE-2026-09-10-ci.md`).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A path segment or path naming the private repository, its evidence tree or the census. */
// `TOOLCLASS\.md`, the census FILE — not `TOOLCLASS_ROWS`, the committed table
// generated from it, which is exactly what code is meant to use instead.
const LAB_REFERENCE = /(^|[\\/])lab([\\/]|$)|docs[\\/]evidence|(^|[\\/])evidence([\\/]|$)|TOOLCLASS\.md/;

/** Every literal in `text` that names the private tree, as `line: text`. */
export function labReferences(fileName: string, text: string): string[] {
  const kind = /\.m?[jc]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const literal =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      node.kind === ts.SyntaxKind.RegularExpressionLiteral;
    if (literal) {
      const value = 'text' in node ? String((node as { text: string }).text) : node.getText(source);
      if (LAB_REFERENCE.test(value)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        found.push(`${line}: ${value.slice(0, 80)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The only tracked code allowed to name the private tree, and how many times.
 * Each entry says why the reference is safe where `lab/` does not exist.
 */
const ALLOWED: Readonly<Record<string, { readonly count: number; readonly why: string }>> = {
  'scripts/gen-toolclass.mjs': {
    count: 1,
    why:
      'THE ONLY READER OF TOOLCLASS.md, and only when run by hand (exits 2 if the census is ' +
      'absent). Nothing imports it.',
  },
  'scripts/privacy-sweep.mjs': {
    count: 1,
    why:
      'lab/identity.local.json: absent, the identity class reports SKIPPED rather than 0 ' +
      '(rule 18, reserved decision 11).',
  },
  'scripts/probe-wal.mjs': {
    count: 1,
    why: 'the default output path of a hand-run probe; never imported by the suite.',
  },
  'scripts/test-run.mjs': {
    count: 1,
    why: 'the runner ledger it writes; a developer gate tool, never run in CI.',
  },
  'src/release/changelog.test.ts': {
    count: 5,
    why: 'planted CHANGELOG text for the evidence-link guard; data, never a path read.',
  },
  'src/release/evidence-roots.test.ts': {
    count: 2,
    why: 'the real-tree leg is describe.skipIf(!existsSync(lab/docs/evidence)).',
  },
  'src/release/privacy.test.ts': {
    count: 1,
    why: 'asserts the sweep NAMES its token file; reads nothing under lab/.',
  },
  'src/release/readme.test.ts': {
    count: 1,
    why: 'planted README text for the evidence-link guard; data, never a path read.',
  },
  'src/release/testrun.test.ts': {
    count: 1,
    why: 'the runner ledger, read only if it exists; the absent arm asserts nothing is created.',
  },
  'src/release/vsix.test.ts': {
    count: 13,
    why: 'the packaging DENY-list and its witnesses (rule 20): it must name lab/ to refuse it.',
  },
  'src/release/workflow.test.ts': {
    count: 1,
    why: 'asserts .gitignore ignores lab; reads nothing under it.',
  },
  'src/stats/toolclass.test.ts': {
    count: 1,
    why:
      'existsSync on the census decides whether to run gen-toolclass.mjs --check, the one ' +
      'explicit invocation; the test never reads the census itself.',
  },
};

/** This file: its literals are the pattern's own controls and the reasons above. */
const SELF = 'src/release/lab-boundary.test.ts';

function trackedCode(): string[] {
  return execFileSync('git', ['ls-files', 'scripts', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(m?[jt]s|cjs)$/.test(f) && f !== SELF);
}

describe('the lab boundary: tracked code names the private tree only where it is allowed to', () => {
  it('every literal naming lab/, docs/evidence or TOOLCLASS is in the allow-list, at its count', () => {
    const files = trackedCode();
    // Vacuity control: the listing is real and reaches both trees.
    expect(files.length).toBeGreaterThan(150);
    expect(files).toContain('scripts/opencode-golden.mjs');
    const actual: Record<string, number> = {};
    const detail: string[] = [];
    for (const file of files) {
      const hits = labReferences(file, readFileSync(join(ROOT, file), 'utf8'));
      if (hits.length === 0) continue;
      actual[file] = hits.length;
      if (ALLOWED[file]?.count !== hits.length) detail.push(`${file}\n    ${hits.join('\n    ')}`);
    }
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([f, a]) => [f, a.count]));
    expect(actual, `unexpected references:\n${detail.join('\n')}`).toStrictEqual(expected);
    expect(Object.keys(actual)).toHaveLength(Object.keys(ALLOWED).length);
  });

  it('TOOLCLASS.md is named in code by the generator and by the test that invokes it — nowhere else', () => {
    const named = trackedCode().filter((file) =>
      labReferences(file, readFileSync(join(ROOT, file), 'utf8')).some((h) => h.includes('TOOLCLASS.md')),
    );
    expect(named.sort()).toStrictEqual(['scripts/gen-toolclass.mjs', 'src/stats/toolclass.test.ts']);
  });

  it('catches a reference in code and ignores the same text in a comment', () => {
    const inCode = "const census = 'docs/evidence/phase-0-stats/TOOLCLASS.md';\n";
    expect(labReferences('planted.mjs', inCode)).toHaveLength(1);
    expect(labReferences('planted.ts', "const p = join(root, 'docs', 'evidence', 'x.md');")).toHaveLength(1);
    expect(labReferences('planted.ts', "const p = join(root, 'lab', 'identity.local.json');")).toHaveLength(1);
    expect(labReferences('planted.ts', 'const r = /lab\\/docs/;')).toHaveLength(1);
    expect(labReferences('planted.mjs', '// reads docs/evidence/phase-0-stats/TOOLCLASS.md\nconst x = 1;')).toStrictEqual([]);
    expect(labReferences('planted.ts', '/* lab/identity.local.json */ const y = 2;')).toStrictEqual([]);
    // ...and does not fire on names that merely contain the letters, nor on the
    // committed table that replaces the census.
    expect(labReferences('planted.ts', "const a = 'label'; const b = 'collaboration';")).toStrictEqual([]);
    expect(labReferences('planted.mjs', "throw new Error('no keys in TOOLCLASS_ROWS');")).toStrictEqual([]);
  });
});
