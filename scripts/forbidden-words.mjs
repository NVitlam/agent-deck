// G10 — facts only. No interpretive language in the stats layer.
//
//     node scripts/forbidden-words.mjs [--json] [--scope <dir>]
//
// Wired into `npm run lint`, so it gates every phase from now on.
//
// v0.7.0 Phase 2 built the MINIMAL version: the word list from
// `agent-deck-spec.md` §G, applied to `src/stats/**`. Phase 4 (DoD 4.7) extends
// the SCOPE — `webview/stats/**`, the sidebar under `webview/sidebar/**`, and
// the `0.7.0` CHANGELOG block — and teaches the scanner `.svelte`, because the
// stats UI is Svelte and a gate that only read `.ts` would have read none of
// what the product says on that surface. The list does not change; `SCOPES`
// and the file kinds are the two places that grow.
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
// A `.svelte` FILE IS TWO THINGS, and both are what the product says. Its
// `<script>` block is TypeScript and goes through the same parser as a `.ts`
// file. Its MARKUP is the product's prose directly — text nodes, attribute
// values such as `title="..."`, and `{'...'}` expressions — so the markup is
// scanned as text, with `<!-- -->` comments and the `<style>` block removed
// first: a comment is this repository's reasoning, and a stylesheet names
// colours. Each markup match is reported with its line, like a literal.
//
// THE CHANGELOG BLOCK is the `## 0.7.0` section of `CHANGELOG.md`, from its
// heading to the next `## ` heading, scanned as text. Earlier versions'
// entries are history and are not G10's subject.
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

/**
 * Where G10 applies. Three directories and one document block (DoD 4.7).
 *
 * A directory scope is scanned recursively for `.ts` and `.svelte`; a `block`
 * scope is one section of one file, scanned as text.
 */
const DEFAULT_SCOPES = [
  { kind: 'dir', dir: join(REPO_ROOT, 'src', 'stats'), label: 'src/stats' },
  { kind: 'dir', dir: join(REPO_ROOT, 'webview', 'stats'), label: 'webview/stats' },
  { kind: 'dir', dir: join(REPO_ROOT, 'webview', 'sidebar'), label: 'webview/sidebar' },
  {
    kind: 'block',
    file: join(REPO_ROOT, 'CHANGELOG.md'),
    heading: '## 0.7.0',
    label: 'CHANGELOG.md (0.7.0 block)',
  },
];

/**
 * `--scope <dir>` replaces the built-in scopes, and it exists for ONE caller.
 *
 * `src/stats/g10.test.ts` plants a violation in a temp directory and runs THIS
 * script against it, so the control exercises the real extraction pipeline —
 * TypeScript's parser, the literal walk, the patterns, the exit code — rather
 * than re-implementing the regex and testing the copy. `phase-verifier` found
 * the first version doing exactly that: it grepped this file's own source for
 * the word list and then tested an inline `RegExp`, so nothing ever proved the
 * script could FAIL.
 *
 * A test hook in a production script is a cost, and it is the smaller one. The
 * alternative was writing a violating `.ts` file into `src/stats/` and deleting
 * it, which litters the tree the scratch guard watches and leaves a forbidden
 * word in the working copy if the test dies mid-run.
 */
function scopesFromArgv() {
  const at = process.argv.indexOf('--scope');
  if (at === -1) return DEFAULT_SCOPES;
  const dir = process.argv[at + 1];
  if (dir === undefined) throw new Error('--scope needs a directory');
  return [{ kind: 'dir', dir, label: dir }];
}

const SCOPES = scopesFromArgv();

const SKIP_SUFFIXES = ['.test.ts', '.testkit.ts'];

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.svelte')) out.push(full);
  }
  return out.sort();
}

/** Every string literal in TypeScript source, with its line (1-based, offset by `lineBase`). */
function literalsOfSource(file, text, lineBase = 0) {
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
        out.push({ text: node.text, line: line + 1 + lineBase });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Every string literal in a `.ts` file. */
function literalsOfTs(file) {
  return literalsOfSource(file, readFileSync(file, 'utf8'));
}

/**
 * A `.svelte` file: its `<script>` block's literals, plus every non-empty line
 * of its markup as one "literal" each — comments and the style block removed.
 *
 * Line-per-unit rather than text-node-per-unit because a Svelte template is
 * not HTML enough for a DOM parser and not TypeScript enough for `ts`; a line
 * is the unit a person locates a violation by, and a violation is reported
 * with the word matched, so the coarser unit costs nothing in precision.
 */
function literalsOfSvelte(file) {
  const text = readFileSync(file, 'utf8');
  const out = [];
  const lineOf = (offset) => text.slice(0, offset).split('\n').length - 1;

  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/giu;
  let markup = text;
  for (const match of text.matchAll(scriptRe)) {
    const body = match[1] ?? '';
    const start = match.index ?? 0;
    const bodyOffset = start + match[0].indexOf(body);
    out.push(...literalsOfSource(file, body, lineOf(bodyOffset)));
    // Blank the script out of the markup copy, keeping line numbers intact.
    markup = markup.slice(0, start) + match[0].replace(/[^\n]/gu, ' ') + markup.slice(start + match[0].length);
  }
  markup = markup.replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, (m) => m.replace(/[^\n]/gu, ' '));
  markup = markup.replace(/<!--[\s\S]*?-->/gu, (m) => m.replace(/[^\n]/gu, ' '));

  markup.split('\n').forEach((line, index) => {
    // A line that is only tags and braces says nothing; keep the ones with
    // a letter in them, which is where prose can be.
    if (!/[A-Za-z]/u.test(line)) return;
    out.push({ text: line, line: index + 1 });
  });
  return out;
}

function literalsOf(file) {
  return file.endsWith('.svelte') ? literalsOfSvelte(file) : literalsOfTs(file);
}

/** The lines of one `## ` section of a markdown file, from its heading to the next. */
function blockLines(file, heading) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start === -1) return null;
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (i > start && line.startsWith('## ')) break;
    if (/[A-Za-z]/u.test(line)) out.push({ text: line, line: i + 1 });
  }
  return out;
}

function main() {
  const json = process.argv.includes('--json');
  const violations = [];
  let scanned = 0;
  let skipped = 0;
  let literals = 0;

  const scanUnits = (file, units) => {
    for (const literal of units) {
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
  };

  for (const scope of SCOPES) {
    if (scope.kind === 'block') {
      const units = blockLines(scope.file, scope.heading);
      if (units === null) {
        // The block is a real scope; a changelog without it is a gate that
        // scans nothing for that scope, which is the fail-open shape.
        console.error(`forbidden-words: scope ${scope.label} does not exist`);
        process.exitCode = 1;
        return;
      }
      scanned += 1;
      scanUnits(scope.file, units);
      continue;
    }
    let files;
    try {
      files = statSync(scope.dir).isDirectory() ? sourceFiles(scope.dir) : [];
    } catch {
      // A scope that does not exist yet is not a pass. Phase 4 added
      // `webview/stats`, and until then this would silently scan nothing.
      console.error(`forbidden-words: scope ${scope.label} does not exist`);
      process.exitCode = 1;
      return;
    }
    if (files.length === 0) {
      console.error(`forbidden-words: scope ${scope.label} contains no .ts or .svelte file`);
      process.exitCode = 1;
      return;
    }
    for (const file of files) {
      if (SKIP_SUFFIXES.some((suffix) => file.endsWith(suffix))) {
        skipped += 1;
        continue;
      }
      scanned += 1;
      scanUnits(file, literalsOf(file));
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
