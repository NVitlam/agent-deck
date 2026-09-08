// G10 — facts only. No interpretive language in the stats layer.
//
//     node scripts/forbidden-words.mjs [--json]
//
// Wired into `npm run lint`, so it gates every phase from now on.
//
// v0.7.0 Phase 2 builds the MINIMAL version: the word list from
// `agent-deck-spec.md` §G, applied to `src/stats/**`. Phase 4 extends the SCOPE
// to `webview/stats/**` and the `0.7.0` CHANGELOG block when those exist — the
// list does not change, only what it is pointed at. `SCOPES` below is the one
// place that grows.
//
// WHY STRING LITERALS AND NOT THE WHOLE FILE
// ------------------------------------------
// G10's subject is what the PRODUCT says. Spec §G is explicit: "string literals
// in `webview/stats/**`, `src/stats/**`, and the `0.7.0` CHANGELOG block are
// scanned". A file-wide grep would flag this repository's own reasoning — the
// comment three lines below contains the word "good" — and a check that reports
// its own documentation as a violation gets suppressed rather than fixed. That
// is not hypothetical here: `stall.test.ts` records a purity guard whose first
// draft matched `Date.now()` inside a comment EXPLAINING `Date.now()`.
//
// Literals are extracted with TypeScript's own parser rather than by regex, for
// the same reason `bridge/apply.test.ts` uses `preProcessFile` for imports: a
// regex cannot tell a string from a comment that contains a quotation mark, and
// this repository has already been bitten by a scanner reading prose as code.
//
// WHAT IS DELIBERATELY NOT SCANNED
// --------------------------------
// `*.test.ts` and `*.testkit.ts`. Neither is bundled — esbuild builds from
// `src/extension.ts` — so neither can reach a user, and a test's NAME is a
// sentence about the test rather than a string the product says. Scanning them
// would make the honest name of a negative case ("...is not better...") a lint
// failure, which teaches people to rename tests rather than to write facts.
// The exclusion is stated in the verdict line on every run, per working-method
// rule 18: a check that skips an input says so.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(REPO_ROOT, 'package.json'));
/** @type {import('typescript')} */
const ts = require('typescript');

/**
 * Verbatim from `agent-deck-spec.md` §G:
 *
 *   should, recommend, consider, try , improve, better, bad, good, waste, wasted
 *
 * `try ` is written there with a trailing space so it does not match `retry` or
 * `country`. A word boundary is the same intent stated precisely, and it also
 * catches a sentence-final "try." that the trailing space would miss — so every
 * term is matched on boundaries, and `wasted` is covered by `waste\w*`.
 */
const FORBIDDEN = [
  'should',
  'recommend',
  'consider',
  'try',
  'improve',
  'better',
  'bad',
  'good',
  'waste',
];

const PATTERNS = FORBIDDEN.map((word) => ({
  word,
  // `\w*` so `recommends`, `improved`, `wasted` and `considering` are caught:
  // the vocabulary is the judgment, not the inflection.
  re: new RegExp(`\\b${word}\\w*\\b`, 'iu'),
}));

/** Where G10 applies today. Phase 4 adds `webview/stats` and the changelog. */
const SCOPES = [{ dir: join(REPO_ROOT, 'src', 'stats'), label: 'src/stats' }];

const SKIP_SUFFIXES = ['.test.ts', '.testkit.ts'];

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

/** Every string literal in a source file, with its line. */
function literalsOf(file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      // An import specifier is a path, not a sentence.
      const parent = node.parent;
      const isSpecifier =
        parent !== undefined &&
        (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent));
      if (!isSpecifier && typeof node.text === 'string' && node.text.length > 0) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        out.push({ text: node.text, line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function main() {
  const json = process.argv.includes('--json');
  const violations = [];
  let scanned = 0;
  let skipped = 0;
  let literals = 0;

  for (const scope of SCOPES) {
    let files;
    try {
      files = statSync(scope.dir).isDirectory() ? sourceFiles(scope.dir) : [];
    } catch {
      // A scope that does not exist yet is not a pass. Phase 4 adds
      // `webview/stats`, and until then this would silently scan nothing.
      console.error(`forbidden-words: scope ${scope.label} does not exist`);
      process.exitCode = 1;
      return;
    }
    if (files.length === 0) {
      console.error(`forbidden-words: scope ${scope.label} contains no .ts file`);
      process.exitCode = 1;
      return;
    }
    for (const file of files) {
      if (SKIP_SUFFIXES.some((suffix) => file.endsWith(suffix))) {
        skipped += 1;
        continue;
      }
      scanned += 1;
      for (const literal of literalsOf(file)) {
        literals += 1;
        for (const { word, re } of PATTERNS) {
          const match = re.exec(literal.text);
          if (match === null) continue;
          violations.push({
            file: relative(REPO_ROOT, file).split(sep).join('/'),
            line: literal.line,
            word,
            matched: match[0],
            literal: literal.text.length > 120 ? `${literal.text.slice(0, 117)}...` : literal.text,
          });
        }
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ scanned, skipped, literals, violations }, null, 2));
  } else {
    // The skip count travels beside the result, per working-method rule 18: a
    // count of zero is only evidence when something says what was looked at.
    const verdict = violations.length === 0 ? 'PASS' : 'FAIL';
    console.log(
      `forbidden-words: ${verdict} — ${String(scanned)} files scanned, ` +
        `${String(literals)} string literals, ${String(skipped)} skipped ` +
        `(*.test.ts, *.testkit.ts — not bundled), ${String(violations.length)} violation(s)`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${String(v.line)} — "${v.matched}" (${v.word}) in ${JSON.stringify(v.literal)}`);
    }
  }
  if (violations.length > 0) process.exitCode = 1;
}

main();
