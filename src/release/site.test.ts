// The project page at `site/`, and the two properties that make it publishable.
//
// WHY `site/` AND NOT `docs/`, which is what PLAN.md DoD 5.9 asks for. `docs/`
// in this working tree is a directory JUNCTION into the maintainer's private
// `lab/` repository: it is gitignored here (`.gitignore` `/docs/`) and denied
// in `.vscodeignore`, so nothing under it is tracked, nothing under it reaches
// GitHub, and a Pages source of `main` / `/docs` would serve a 404. Un-ignoring
// it would make `git add -A` walk the junction into the private tree, which is
// the hazard `.gitignore`'s own comment block exists to prevent.
//
// This repository has already met and recorded the identical ask once:
// `src/release/readme.test.ts` carries a comment explaining why the README's
// images live at `media/` and not at the `docs/media/` that was requested, for
// exactly this reason. Rediscovering it a second time is the thing this header
// exists to prevent.
//
// The consequence is that GitHub Pages is served by `.github/workflows/pages.yml`
// (Pages source "GitHub Actions", which can publish any path) rather than by a
// branch-and-folder setting. Setting that source is a USER step in DoD 5.5.
//
// WHAT THIS FILE MEASURES, and it is deliberately not "the page looks right":
//
//   1. THE PAGE REACHES NOTHING IT SHOULD NOT. G5 is a promise about the
//      shipped extension, not about a web page - but a page that pulls a font,
//      an analytics beacon or a CDN script would make the project's own
//      zero-egress posture read as a slogan. So the page's absolute URLs are
//      allow-listed to two hosts, and its own CSP is asserted, because a
//      review-time allow-list that the document does not also enforce at load
//      time is one careless edit from being decorative.
//
//   2. THE PAGE AND THE REPOSITORY DO NOT DIVERGE. `site/media/` carries its
//      own copies because a Pages artifact has no parent directory to reach
//      into. Identical bytes are ONE blob in git, so the copies cost no
//      repository size - only the risk that someone updates a screenshot in
//      one place. Every copy is compared to its `media/` twin by sha256, and
//      the set is pinned both ways with the count beside it (working-method
//      rule 19), because the failure this guards is a file appearing or
//      disappearing rather than a file changing.
//
// WHAT IT CANNOT MEASURE: that the page renders, that Pages is switched on, or
// that `pages.yml` is YAML GitHub will parse - `src/release/workflow.test.ts`
// reads workflows as text without a parser and has stayed green through a
// workflow GitHub refused to run. A live page is DoD 5.6 and is the user's.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CODEX_VERSION_WINDOW, PINNED_CODEX_VERSION } from '../codex/fingerprint.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Read as text with line endings normalised.
 *
 * `.gitattributes` sets `* text=auto` and `core.autocrlf=true` is set on the
 * machine that wrote this file, so a fresh clone hands the same document out
 * with CRLF. Every assertion here is about content; a byte comparison would be
 * measuring the checkout instead. The IMAGE comparisons below are byte-exact
 * and do not go through this function, which is the distinction that matters -
 * `git ls-files --eol` reports the PNGs as `-text` in both index and worktree,
 * so their bytes really are stable across a clone.
 */
function readText(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

function sha256(relative: string): string {
  return createHash('sha256').update(readFileSync(join(ROOT, relative))).digest('hex');
}

/**
 * Everything git tracks under `site/`, spawned ONCE at module scope.
 *
 * This repository's recorded 'an expensive subprocess called once per test is a
 * test that passes or fails by CPU load' finding - `vsce ls` spawned six times
 * under a 5 s default timeout, green alone and red in the full suite. One spawn,
 * reused.
 */
const TRACKED_SITE: readonly string[] = execFileSync('git', ['ls-files', '--', 'site'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const PAGE = readText('site/index.html');
const MANIFEST = JSON.parse(readText('package.json')) as {
  publisher: string;
  repository: { url: string };
};

/**
 * The four screenshots the page and the README share.
 *
 * Named here rather than derived from `site/media/` so that a file VANISHING is
 * a failure. A list read off the directory it is checking can only ever agree
 * with itself, which is this repository's most-recorded defect class.
 */
const SITE_IMAGES: readonly string[] = [
  'Session_Deck.png',
  'hero_16_agent_session.png',
  'Internal_Session_Tool_popup.png',
  'Internal_Session_Tool_popup2.png',
];

/** The only hosts the page may reach. */
const ALLOWED_HOSTS: readonly string[] = ['github.com', 'marketplace.visualstudio.com'];

/** Every absolute http(s) URL in the page, in document order. */
function pageUrls(): string[] {
  return [...PAGE.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
}

describe('the page exists as a publishable tree', () => {
  it('tracks index.html and .nojekyll', () => {
    // `.nojekyll` is not decoration: without it Pages runs the upload through
    // Jekyll, which SILENTLY DROPS any path beginning with an underscore. This
    // page has none today, so the file is protection against the day one is
    // added and one image stops loading for a reason nobody will guess.
    expect(existsSync(join(ROOT, 'site/index.html'))).toBe(true);
    expect(TRACKED_SITE).toContain('site/index.html');
    expect(TRACKED_SITE).toContain('site/.nojekyll');
  });

  it('tracks exactly the four images, both ways, with the count pinned beside the set', () => {
    // RULE 19, applied to `site/media/` rather than to the VSIX. The failure
    // this catches is a file nobody meant to publish - the recorded case is a
    // stray `media/Action Running.png` that shipped past a deny-by-name rule -
    // so the only assertion shape that can see it is equality over the whole
    // listing. The count is pinned BESIDE the set, not instead of it: a set
    // comparison accidentally written against an empty listing passes
    // vacuously, and a count is the cheapest thing that goes red when it does.
    const tracked = TRACKED_SITE.filter((p) => p.startsWith('site/media/')).sort();
    const expected = SITE_IMAGES.map((n) => `site/media/${n}`).sort();

    expect(tracked).toStrictEqual(expected);
    expect(expected).toStrictEqual(tracked);
    expect(tracked).toHaveLength(4);
  });

  it('every site image is byte-identical to its media/ twin', () => {
    // The whole reason duplicate copies are acceptable. Identical bytes are one
    // blob in git, so this costs no repository size; what it buys is that a
    // screenshot updated in `media/` and forgotten here goes red instead of
    // leaving the page showing last release's UI.
    for (const name of SITE_IMAGES) {
      expect(sha256(`site/media/${name}`), `site/media/${name} has drifted from media/${name}`).toBe(
        sha256(`media/${name}`),
      );
    }
    // Non-vacuity: the loop above proves nothing if SITE_IMAGES is empty, and
    // an empty file would hash equal to an empty file.
    expect(SITE_IMAGES.length).toBeGreaterThan(0);
    for (const name of SITE_IMAGES) {
      expect(readFileSync(join(ROOT, `site/media/${name}`)).byteLength).toBeGreaterThan(1024);
    }
  });

  it('every relative asset the page references exists inside site/', () => {
    // The page is uploaded WHOLE and has no parent to reach into, so a
    // `../media/x.png` would 404 on the live site while resolving perfectly in
    // a local browser opened from the repository root - the failure that only
    // the published page can show you, asserted here instead.
    const refs = [...PAGE.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1] ?? '')
      .filter((ref) => !ref.startsWith('#') && !/^https?:/.test(ref));

    expect(refs.length, 'no relative asset references found - the check would be vacuous').toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('../'), `${ref} escapes the published tree`).toBe(false);
      expect(existsSync(join(ROOT, 'site', ref)), `site/${ref} is referenced and missing`).toBe(true);
    }
  });
});

describe('the page reaches nothing it should not', () => {
  it('every absolute URL is on one of the two allowed hosts', () => {
    // G5's posture applied to the page a reader loads rather than to the
    // extension. A web font, a CDN script or an analytics beacon would each be
    // one line and would each make the project's zero-egress claim read as a
    // slogan. The allow-list is hosts, not URLs, so a new link to a different
    // repository page is fine and a new link to a tracker is not.
    const urls = pageUrls();
    expect(urls.length, 'no absolute URLs found - the allow-list would be vacuous').toBeGreaterThan(0);

    for (const url of urls) {
      const host = new URL(url).host;
      expect(ALLOWED_HOSTS, `${url} reaches a host this page may not reach`).toContain(host);
    }
  });

  it('declares a CSP that forbids everything it does not need', () => {
    // The allow-list above is a REVIEW-time check over source text. This is the
    // LOAD-time one, and the pair is deliberate: a review-time rule that the
    // document does not also enforce is one careless edit from decorative.
    // `default-src 'none'` plus `img-src 'self'` means the page cannot fetch a
    // script, a font or a frame from anywhere, including the two hosts it is
    // allowed to LINK to - a link is navigation, not a fetch.
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(PAGE)?.[1] ?? '';
    expect(csp, 'the page declares no CSP').not.toBe('');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp, 'the CSP admits a script source').not.toMatch(/script-src(?! 'none')/);
  });

  it('names this repository and this publisher, read from the manifest', () => {
    // Bound to the manifest rather than written down twice. The README went
    // stale in precisely this way before it was bound, and a page naming the
    // wrong owner is a 404 the author cannot see from their own machine.
    const repoPath = new URL(MANIFEST.repository.url.replace(/\.git$/, '')).pathname;
    const repoLinks = pageUrls().filter((u) => new URL(u).host === 'github.com');
    expect(repoLinks.length).toBeGreaterThan(0);
    for (const link of repoLinks) {
      expect(new URL(link).pathname.startsWith(repoPath), `${link} is not this repository`).toBe(true);
    }

    const marketLinks = pageUrls().filter(
      (u) => new URL(u).host === 'marketplace.visualstudio.com',
    );
    expect(marketLinks.length).toBeGreaterThan(0);
    for (const link of marketLinks) {
      expect(link).toContain(`${MANIFEST.publisher}.`);
    }
  });
});

describe('the page tells the truth about Codex', () => {
  it('keeps every engine:codex fence, opened and closed', () => {
    // DoD 5.9: 'Every engine:codex fence stays.' They are what makes the Codex
    // material identifiable as a block rather than as prose scattered through
    // the page, which is what lets it be reviewed - or removed - as one thing.
    const open = [...PAGE.matchAll(/<!-- engine:codex -->/g)].length;
    const close = [...PAGE.matchAll(/<!-- \/engine:codex -->/g)].length;

    expect(open, 'the engine:codex fences have been removed').toBeGreaterThan(0);
    expect(close).toBe(open);
    expect(open).toBe(2);
  });

  it('states the Codex anchor and window as the fingerprint defines them', () => {
    // G9 read off the code rather than transcribed. The anchor is a PROVENANCE
    // signal - it names the corpus that proved the structure - and it moves
    // only by harvesting. A page that quoted a number would go stale silently
    // at the next harvest; this one goes red.
    expect(PAGE).toContain(PINNED_CODEX_VERSION);
    expect(CODEX_VERSION_WINDOW.minor).toBe(1);
    // 'Patch and prerelease tags are not compared' is the half that is easy to
    // lose in an edit, and it is the half that stops a reader concluding the
    // extension pins one build.
    expect(PAGE.toLowerCase()).toMatch(/patch and prerelease tags are not compared/);
  });

  it('states the App Server boundary', () => {
    // G5's Codex clause, verbatim in substance: Codex ships an App Server and
    // this product will never connect to it. A page describing an observability
    // tool for an agent runtime, that does NOT say this, reads as an omission
    // to exactly the reader who cares.
    expect(PAGE).toMatch(/No App Server, no socket to Codex/i);
  });
});

describe('the page does not ship inside the extension', () => {
  it('site/ is denied in .vscodeignore', () => {
    // WORKING-METHOD RULE 20: `.gitignore` and `.vscodeignore` are DIFFERENT
    // DOORS, and vsce walks the WORKING TREE without consulting git. `site/`
    // is 1.5 MB of screenshots a user installing the extension has no use for.
    //
    // The strong check is the exact-set assertion in `src/release/vsix.test.ts`
    // over the unzipped artifact - but that suite is gated behind
    // AGENT_DECK_PACKAGE_AUDIT=1 and does not run in an ordinary suite pass.
    // This plain-text guard is what goes red in the run everybody actually
    // does, which is the whole reason it is worth writing twice.
    const ignore = readText('.vscodeignore');
    expect(ignore).toMatch(/^site\/\*\*$/m);
  });
});
