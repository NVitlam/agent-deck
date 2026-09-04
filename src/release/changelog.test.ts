// `CHANGELOG.md` is a SHIPPED artifact, and every path it names has to resolve
// for a stranger.
//
// WHY THIS FILE EXISTS. The 0.5.0 entry closed a Compatibility item with
// "Diagnosis: `docs/evidence/release-0.5.0/DRIFT-2.1.251.md`". That file is real
// and it is unreachable: `docs/` in this working tree is a directory JUNCTION
// into the maintainer's private `lab/` repository, gitignored here
// (`.gitignore` `/docs/`) and denied in `.vscodeignore`, so nothing under it is
// tracked, nothing under it reaches GitHub, and nothing under it goes into the
// VSIX. `CHANGELOG.md` ships as `extension/changelog.md` AND as a tab on the
// Marketplace listing, so the citation was a dead pointer on two public
// surfaces at once.
//
// `README.md` HAS HAD A GUARD FOR THIS SINCE THE 2026-08-28 SPLIT — the
// 'links to no document that left this repository' assertion in
// `readme.test.ts`. The changelog is the same document class, shipping through
// the same door, with nothing watching it. Found by reading the page as a user
// rather than as its author.
//
// WHAT IS ASSERTED, and the shape is deliberately not "no `docs/` string": a
// changelog is append-only history and may legitimately need to name a path one
// day. The rule is that a path it names must be a path a reader can open, which
// is exactly `git ls-files`.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Read with line endings normalised.
 *
 * `.gitattributes` sets `* text=auto` and this machine has `core.autocrlf=true`,
 * so a fresh clone hands the same document out with CRLF. Every assertion here
 * is about content, and a raw read would make the pattern below depend on the
 * checkout rather than on the text.
 */
function readText(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

const CHANGELOG = readText('CHANGELOG.md');

/**
 * Everything git tracks, spawned ONCE at module scope.
 *
 * This repository's recorded 'an expensive subprocess called once per test is a
 * test that passes or fails by CPU load' finding: `vsce ls` spawned six times
 * under a 5 s default timeout was green alone and red in the full suite. One
 * spawn, reused, and a `Set` so the lookup below is not quadratic.
 */
const TRACKED: ReadonlySet<string> = new Set(
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0),
);

/**
 * Every `docs/…` path a document names, from prose or from a markdown link.
 *
 * Bounded to the characters a path can contain and required to carry an
 * extension, so a sentence ABOUT the directory ("the `docs/` junction") is not
 * read as a citation of a file. Trailing punctuation is stripped because a
 * citation usually ends a sentence.
 */
function docsPathsIn(text: string): string[] {
  return [...text.matchAll(/docs\/[A-Za-z0-9._/-]*\.[A-Za-z0-9]+/g)]
    .map((m) => m[0].replace(/[.,;:]+$/, ''))
    .filter((path) => path.length > 'docs/'.length);
}

describe('CHANGELOG.md cites nothing a reader cannot open', () => {
  it('every docs/ path it names is tracked by git', () => {
    // The whole assertion. A path that is not in `git ls-files` is not on
    // GitHub and is not in the VSIX, so for every reader of either surface it
    // is a 404 - regardless of whether it exists on the author's disk, which is
    // precisely why the author could not see it.
    const cited = docsPathsIn(CHANGELOG);
    const missing = cited.filter((path) => !TRACKED.has(path));

    expect(missing, `CHANGELOG.md cites untracked path(s): ${missing.join(', ')}`).toStrictEqual([]);
  });

  it('vacuity control: the extractor really does find a citation', () => {
    // WITHOUT THIS THE TEST ABOVE IS `[] === []` FOREVER. The changelog carries
    // no `docs/` path today - that is the fixed state - so the assertion is
    // vacuous by construction and the only thing that can make it mean anything
    // is proving the extractor sees the sentence that was really shipping.
    //
    // Verbatim from `CHANGELOG.md` as it stood at `c76b13e`, in the 0.5.0
    // Compatibility entry.
    const shipped = 'it. Diagnosis: `docs/evidence/release-0.5.0/DRIFT-2.1.251.md`.';
    expect(docsPathsIn(shipped)).toStrictEqual(['docs/evidence/release-0.5.0/DRIFT-2.1.251.md']);

    // ...and that path is the one the guard would reject, which is the other
    // half: an extractor that finds a path proves nothing if the membership
    // test would have passed it anyway.
    expect(TRACKED.has('docs/evidence/release-0.5.0/DRIFT-2.1.251.md')).toBe(false);

    // A markdown link form too, since a future entry is as likely to use one.
    expect(docsPathsIn('see [the drift note](docs/evidence/x/NOTE.md) for detail')).toStrictEqual([
      'docs/evidence/x/NOTE.md',
    ]);
  });

  it('does not fire on prose about the directory, or on a tracked path', () => {
    // The other direction. A guard that flags correct prose gets deleted rather
    // than fixed, so the two shapes it must NOT flag are pinned: the bare
    // directory name, and a path that really is tracked.
    expect(docsPathsIn('the `docs/` junction is gitignored here')).toStrictEqual([]);
    expect(docsPathsIn('nothing under docs/ is tracked')).toStrictEqual([]);

    const tracked = [...TRACKED].find((path) => path.endsWith('.md'));
    expect(tracked, 'no tracked markdown file - the control below would be vacuous').toBeDefined();
    expect(docsPathsIn(`see \`${String(tracked)}\``).filter((p) => !TRACKED.has(p))).toStrictEqual(
      [],
    );
  });

  it('the tracked listing is real, so the membership test is not vacuous', () => {
    // `git ls-files` returning nothing would make every path "untracked" and
    // the first test would still pass on a changelog citing none. Both ends of
    // the listing are checked: it is populated, and it contains the documents
    // this file is about.
    //
    // NOT `src/release/changelog.test.ts`, which was the first thing written
    // here and which fails before its own `git add` — an assertion that is red
    // for every author who has not staged yet, and green forever after, is a
    // trap rather than a control. Two files that are tracked in every checkout
    // this can run in are the honest version.
    expect(TRACKED.size).toBeGreaterThan(100);
    expect(TRACKED.has('CHANGELOG.md')).toBe(true);
    expect(TRACKED.has('package.json')).toBe(true);
  });
});

describe('the current entry is dated', () => {
  it('the version the manifest ships is not still marked unreleased', () => {
    // It read "## 0.6.0 - unreleased" while `package.json` carried 0.6.0. On
    // publish, a user who has just installed 0.6.0 opens the Changelog tab and
    // is told 0.6.0 is unreleased - the manifest and a shipped document
    // disagreeing about the release in front of the reader.
    //
    // The manifest is READ, never repeated, the same rule the README's floor
    // assertions follow.
    const manifest = JSON.parse(readText('package.json')) as { version: string };
    const heading = CHANGELOG.split('\n').find((line) =>
      line.startsWith(`## ${manifest.version} `),
    );

    expect(heading, `CHANGELOG.md has no entry for ${manifest.version}`).toBeDefined();
    expect(heading ?? '', 'the shipped version is still marked unreleased').not.toMatch(
      /\bunreleased\b/i,
    );
    // Dated, and with a real date rather than any word in the slot: the entry
    // is `## <version> - <YYYY-MM-DD> - <title>`.
    expect(heading ?? '').toMatch(/^## \d+\.\d+\.\d+ - \d{4}-\d{2}-\d{2} - /);
  });

  it('vacuity control: the check can see an undated heading', () => {
    // The regexes above are asserted against the string that was really
    // shipping, so a rewrite that made them match nothing goes red here.
    expect(/\bunreleased\b/i.test('## 0.6.0 - unreleased - a third engine, Codex')).toBe(true);
    expect(/^## \d+\.\d+\.\d+ - \d{4}-\d{2}-\d{2} - /.test('## 0.6.0 - unreleased - x')).toBe(false);
    expect(/^## \d+\.\d+\.\d+ - \d{4}-\d{2}-\d{2} - /.test('## 0.6.0 - 2026-09-04 - x')).toBe(true);
  });
});
