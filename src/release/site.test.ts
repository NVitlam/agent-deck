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
import { ABOUT_TEXT, INSIGHTS_GET_LINK, INSIGHTS_PAGE_URL, aboutConfirmation } from '../about.js';

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
/** v0.9.0 DoD 9.34: the Insights subpage, held to every rule the index is. */
const INSIGHTS = readText('site/insights.html');
/**
 * 2026-09-28: the post-payment page. Polar sends a buyer to
 * `thanks.html?checkout_id=...`; the page reads nothing from that address.
 */
const THANKS = readText('site/thanks.html');
const PAGES: Readonly<Record<string, string>> = {
  'index.html': PAGE,
  'insights.html': INSIGHTS,
  'thanks.html': THANKS,
};
/**
 * The ruling of 2026-09-29 moved the Codex statements and the g10 Stats region
 * off the redesigned index page; the README is where they are asserted now.
 */
const README = readText('README.md');
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
 *
 * v0.7.1 DoD 6.D.1: the Stats view's Tokens part joined (five), then the user's
 * deck, tree and inspector captures replaced the four 0.6.x-era stills (four).
 */
const SITE_IMAGES: readonly string[] = [
  'deck.png',
  'tree.png',
  'inspector.png',
  'stats_tokens.png',
  // v0.8.0 DoD 7.D: the 7.12 smoke captures, each byte-identical to its media/ twin.
  'drawer-time.png',
  'sidebar-tweaks.png',
  'stats-tokens-timing.png',
];

/**
 * The site images with NO byte-identical `media/` twin, pinned by sha256 instead
 * — a changed file is a deliberate edit to this list, and a vanished one is red.
 *
 * `insights-preview.png` is the Insights report view (v0.9.0 DoD 9.34; retaken
 * for the 2026-09-29 redesign at 1600 px wide). The README of THIS extension
 * does not show it. `insights-panel.png` was retired with the redesign, which
 * references it nowhere.
 *
 * `agent-deck-hero.gif` is the redesign's hero. Its `media/` counterpart is
 * still the previous GIF: the root swap ships with the next extension publish
 * (ruling of 2026-09-29), after which it can move to `SITE_IMAGES` as a twin.
 */
const PINNED_IMAGES: Readonly<Record<string, string>> = {
  'insights-preview.png': 'd9c0767151a530cb8e60700a4412dff2d231ea895bad893d48c3b8e2914de034',
  'agent-deck-hero.gif': '422a15583218485a21d6d108e8cac31b605d4d83ea9e4372c44f794536f485c3',
};

/**
 * The only hosts a page may reach.
 *
 * `buy.polar.sh` since v0.9.0 DoD 9.37: the six plan checkouts. A link is
 * NAVIGATION, not a fetch — the CSP below still lets no page load anything
 * from any host — so the allow-list states where a reader can be SENT.
 * `nvitlam.github.io` since the ruling of 2026-09-29: the footer's author link.
 */
const ALLOWED_HOSTS: readonly string[] = [
  'github.com',
  'marketplace.visualstudio.com',
  'buy.polar.sh',
  'nvitlam.github.io',
];

/**
 * The pages that load `site.js`, named rather than derived (rule 19): a page
 * gaining a script tag is a deliberate edit to this list.
 */
const SCRIPTED_PAGES: readonly string[] = ['index.html'];
const SITE_SCRIPT_TAG = '<script src="site.js" defer></script>';

/** Every absolute http(s) URL in a page, in document order. */
function pageUrls(html: string = PAGE): string[] {
  return [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
}

describe('the page exists as a publishable tree', () => {
  it('tracks index.html and .nojekyll', () => {
    // `.nojekyll` is not decoration: without it Pages runs the upload through
    // Jekyll, which SILENTLY DROPS any path beginning with an underscore. This
    // page has none today, so the file is protection against the day one is
    // added and one image stops loading for a reason nobody will guess.
    expect(existsSync(join(ROOT, 'site/index.html'))).toBe(true);
    expect(TRACKED_SITE).toContain('site/index.html');
    expect(TRACKED_SITE).toContain('site/insights.html');
    expect(TRACKED_SITE).toContain('site/thanks.html');
    expect(TRACKED_SITE).toContain('site/.nojekyll');
    // Every tracked page is one PAGES holds to the rules below, both ways.
    expect(TRACKED_SITE.filter((p) => p.endsWith('.html')).sort()).toStrictEqual(
      Object.keys(PAGES).map((n) => `site/${n}`).sort(),
    );
  });

  it('carries the custom domain in site/CNAME, exactly and alone', () => {
    // 2026-09-26: the site moves to its own domain. The workflow uploads
    // `site/` whole, so the file must be inside it. GitHub documents that a
    // custom Actions workflow IGNORES a CNAME file and takes the domain from
    // the repository's Pages setting; the file is kept as the in-tree record
    // of the domain, and the setting is the user's step.
    expect(TRACKED_SITE).toContain('site/CNAME');
    expect(readFileSync(join(ROOT, 'site/CNAME'), 'utf8')).toBe('agent-deck.app');
  });

  it('assumes no /agent-deck/ sub-path: no root-relative link, no <base>', () => {
    // Served from https://agent-deck.app/, a link written for the project
    // sub-path (`/agent-deck/...`) would 404. Every page link stays relative.
    for (const page of TRACKED_SITE.filter((p) => p.endsWith('.html'))) {
      const text = readText(page);
      expect(text, `${page} carries a <base>`).not.toMatch(/<base[\s>]/i);
      expect(text, `${page} carries a root-relative link`).not.toMatch(/(?:href|src)="\/(?!\/)/i);
    }
  });

  it('tracks exactly the nine images, both ways, with the count pinned beside the set', () => {
    // RULE 19, applied to `site/media/` rather than to the VSIX. The failure
    // this catches is a file nobody meant to publish - the recorded case is a
    // stray `media/Action Running.png` that shipped past a deny-by-name rule -
    // so the only assertion shape that can see it is equality over the whole
    // listing. The count is pinned BESIDE the set, not instead of it: a set
    // comparison accidentally written against an empty listing passes
    // vacuously, and a count is the cheapest thing that goes red when it does.
    const tracked = TRACKED_SITE.filter((p) => p.startsWith('site/media/')).sort();
    const expected = [...SITE_IMAGES, ...Object.keys(PINNED_IMAGES)].map((n) => `site/media/${n}`).sort();

    expect(tracked).toStrictEqual(expected);
    expect(expected).toStrictEqual(tracked);
    // SEVEN SINCE v0.8.0 DoD 7.D: the four 0.7.1 stills plus the three 7.12
    // captures; NINE since v0.9.0 DoD 9.34, with the Insights subpage's two;
    // still NINE after the 2026-09-29 redesign: `insights-panel.png` out, the
    // hero GIF in.
    expect(tracked).toHaveLength(9);
  });

  it('the images without a media/ twin are the pinned bytes', () => {
    for (const [name, hash] of Object.entries(PINNED_IMAGES)) {
      expect(sha256(`site/media/${name}`), `site/media/${name} changed`).toBe(hash);
      expect(readFileSync(join(ROOT, `site/media/${name}`)).byteLength).toBeGreaterThan(1024);
    }
    expect(Object.keys(PINNED_IMAGES)).toHaveLength(2);
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
    /*
     * v0.9.0 DoD 9.8 — the four plan placeholders are LITERALS the page
     * ships with, and one of them (`POLAR_URL`) sits in an `href`. It is not
     * a path and never resolves to one.
     *
     * Exempt by NAME rather than by loosening the rule, and the exemption is
     * safe because `surfaces.test.ts` pins all four by exact literal and by
     * count: a placeholder cannot go unnoticed, it can only be shipped on
     * purpose.
     */
    //
    // v0.9.0 DoD 9.35: the placeholders are GONE, so there is no exemption
    // left; `surfaces.test.ts` asserts none of them survives. A fragment on
    // a page (`insights.html#plans`) is the page, and a `mailto:` is not
    // an asset.
    //
    // Ruling of 2026-09-29: `data-img` too. The index's view switcher names
    // three of its four screenshots only there, and `site.js` swaps them in.
    const dataImgs = [...PAGE.matchAll(/\sdata-img="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(dataImgs).toStrictEqual(['media/deck.png', 'media/tree.png', 'media/inspector.png', 'media/stats_tokens.png']);
    for (const [name, html] of Object.entries(PAGES)) {
      const refs = [...html.matchAll(/(?:src|href|data-img)="([^"]+)"/g)]
        .map((m) => m[1] ?? '')
        .filter((ref) => !ref.startsWith('#') && !/^https?:/.test(ref) && !ref.startsWith('mailto:'))
        .map((ref) => ref.replace(/#.*$/, ''));

      expect(refs.length, `${name}: no relative references - the check would be vacuous`).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(ref.startsWith('../'), `${name}: ${ref} escapes the published tree`).toBe(false);
        expect(existsSync(join(ROOT, 'site', ref)), `${name}: site/${ref} is referenced and missing`).toBe(true);
      }
    }
  });
});

describe('the page reaches nothing it should not', () => {
  it('every absolute URL is on one of the allowed hosts', () => {
    // G5's posture applied to the page a reader loads rather than to the
    // extension. A web font, a CDN script or an analytics beacon would each be
    // one line and would each make the project's zero-egress claim read as a
    // slogan. The allow-list is hosts, not URLs, so a new link to a different
    // repository page is fine and a new link to a tracker is not.
    for (const [name, html] of Object.entries(PAGES)) {
      const urls = pageUrls(html);
      expect(urls.length, `${name}: no absolute URLs - the allow-list would be vacuous`).toBeGreaterThan(0);
      for (const url of urls) {
        const host = new URL(url).host;
        expect(ALLOWED_HOSTS, `${name}: ${url} reaches a host this page may not reach`).toContain(host);
      }
    }
  });

  it('declares a CSP that forbids everything it does not need', () => {
    // The allow-list above is a REVIEW-time check over source text. This is the
    // LOAD-time one, and the pair is deliberate: a review-time rule that the
    // document does not also enforce is one careless edit from decorative.
    // `default-src 'none'` plus `img-src 'self'` means the page cannot fetch a
    // script, a font or a frame from anywhere, including the two hosts it is
    // allowed to LINK to - a link is navigation, not a fetch.
    for (const [name, html] of Object.entries(PAGES)) {
      const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
      expect(csp, `${name} declares no CSP`).not.toBe('');
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("img-src 'self'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'none'");
      // Ruling of 2026-09-29: the one script source a page may name is
      // `'self'`, written exactly so. No other host, no `unsafe-inline`, no
      // hash or nonce, and no `script-src-elem` / `-attr` beside it.
      const scriptDirectives = csp
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d.startsWith('script-src'));
      if (SCRIPTED_PAGES.includes(name)) {
        expect(scriptDirectives, `${name}: the CSP must admit exactly 'self'`).toStrictEqual(["script-src 'self'"]);
      } else {
        expect(scriptDirectives.every((d) => d === "script-src 'self'" || d === "script-src 'none'"), name).toBe(true);
        expect(scriptDirectives.length, name).toBeLessThanOrEqual(1);
      }
    }
    // Control: a second source is refused by the exact comparison.
    expect(["script-src 'self' https://cdn.example"]).not.toStrictEqual(["script-src 'self'"]);
  });

  it('names this repository and this publisher, read from the manifest', () => {
    // Bound to the manifest rather than written down twice. The README went
    // stale in precisely this way before it was bound, and a page naming the
    // wrong owner is a 404 the author cannot see from their own machine.
    const repoPath = new URL(MANIFEST.repository.url.replace(/\.git$/, '')).pathname;
    /*
     * v0.9.0 DoD 9.7/9.8 — the Sponsor link is a github.com URL that is
     * deliberately NOT a repository link: `github.com/sponsors/<user>` is a
     * different surface with a different path shape.
     *
     * Named here rather than the host filter being widened, and it is not a
     * free pass: `surfaces.test.ts` holds this exact url against the
     * manifest's `sponsor.url` and against the About entry's own list, so
     * all three have to agree.
     */
    const SPONSORS_PATH = '/sponsors/';
    const repoLinks = [...pageUrls(), ...pageUrls(INSIGHTS), ...pageUrls(THANKS)]
      .filter((u) => new URL(u).host === 'github.com')
      .filter((u) => !new URL(u).pathname.startsWith(SPONSORS_PATH));
    expect(repoLinks.length).toBeGreaterThan(0);
    // The exemption is not vacuous: the page really does carry one.
    expect(
      pageUrls().some((u) => new URL(u).pathname.startsWith(SPONSORS_PATH)),
      'no sponsors link on the page - the exemption above covers nothing',
    ).toBe(true);
    for (const link of repoLinks) {
      expect(new URL(link).pathname.startsWith(repoPath), `${link} is not this repository`).toBe(true);
    }

    const marketLinks = [...pageUrls(), ...pageUrls(THANKS)].filter(
      (u) => new URL(u).host === 'marketplace.visualstudio.com',
    );
    expect(marketLinks.length).toBeGreaterThan(0);
    for (const link of marketLinks) {
      expect(link).toContain(`${MANIFEST.publisher}.`);
    }
  });
});

/*
 * Ruling of 2026-09-29: the redesigned index carries no Codex section, so the
 * truth about Codex is asserted on the README, which carries the same
 * statements (two of them added there word for word from the old page).
 */
describe('the README tells the truth about Codex', () => {
  it('keeps every engine:codex fence, opened and closed', () => {
    // DoD 5.9: 'Every engine:codex fence stays.' They are what makes the Codex
    // material identifiable as a block rather than as prose scattered through
    // the document, which is what lets it be reviewed - or removed - as one thing.
    const open = [...README.matchAll(/<!-- engine:codex -->/g)].length;
    const close = [...README.matchAll(/<!-- \/engine:codex -->/g)].length;

    expect(open, 'the engine:codex fences have been removed').toBeGreaterThan(0);
    expect(close).toBe(open);
    // The compatibility note, "Also observes Codex" and the Codex hook paste.
    expect(open).toBe(3);
  });

  it('states the Codex anchor and window as the fingerprint defines them', () => {
    // G9 read off the code rather than transcribed. The anchor is a PROVENANCE
    // signal - it names the corpus that proved the structure - and it moves
    // only by harvesting. A document that quoted a number would go stale
    // silently at the next harvest; this one goes red.
    expect(README).toContain(PINNED_CODEX_VERSION);
    expect(CODEX_VERSION_WINDOW.minor).toBe(1);
    // 'Patch and prerelease tags are not compared' is the half that is easy to
    // lose in an edit, and it is the half that stops a reader concluding the
    // extension pins one build.
    expect(README.toLowerCase()).toMatch(/patch and prerelease tags are not compared/);
  });

  it('states the App Server boundary', () => {
    // G5's Codex clause, verbatim in substance: Codex ships an App Server and
    // this product will never connect to it. A document describing an
    // observability tool for an agent runtime, that does NOT say this, reads as
    // an omission to exactly the reader who cares.
    expect(README).toMatch(/No App Server, no socket to Codex/i);
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

describe('v0.7.0 DoD 5.5 — the page names the Stats view, and no longer says nothing is kept', () => {
  it('carries ONE g10 region, the Stats section, which the forbidden-word scan reads', () => {
    // v0.7.1 DoD 6.D.1 moved the region from one line in "What it does" to the
    // whole Stats section. The ruling of 2026-09-29 moved it with the Stats
    // section, off the redesigned page and onto the README. Still ONE region:
    // the scanner reads the first pair of markers only.
    const regions = [...README.matchAll(/<!-- g10 -->([\s\S]*?)<!-- \/g10 -->/g)].map((m) => m[1] ?? '');
    expect(regions).toHaveLength(1);
    expect(regions[0]).toContain('Stats view');
    expect(/\n## Stats\n\n<!-- g10 -->\n/.test(README)).toBe(true);
    // The region is the scan's subject: `scripts/forbidden-words.mjs` names this
    // file and these markers, so moving the text out of them unscans it.
    const scanner = readText('scripts/forbidden-words.mjs');
    expect(scanner).toContain("file: join(REPO_ROOT, 'README.md'),\n    start: '<!-- g10 -->'");
    // ...and, since the same ruling, both redesigned pages' whole visible text.
    expect(scanner).toContain("{ kind: 'page', file: join(REPO_ROOT, 'site', 'index.html')");
    expect(scanner).toContain("{ kind: 'page', file: join(REPO_ROOT, 'site', 'insights.html')");
  });

  it('no longer claims the product keeps nothing, which 0.7.0 made false', () => {
    // The stats history persists, derived numbers only. Two sentences that were
    // true of 0.6.x said otherwise, on the page a user reads before installing.
    expect(PAGE).not.toMatch(/disappears when the window closes/i);
    expect(PAGE).not.toMatch(/Persist history/i);
    // Vacuity control: the patterns match the sentences that were shipping.
    expect(/disappears when the window closes/i.test('State stays in memory and disappears when the window closes.')).toBe(true);
    expect(/Persist history/i.test('<li>Persist history or build cost dashboards.</li>')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v0.9.0 DoD 9.34, retargeted to the redesigned pages by the ruling of
// 2026-09-29: one stylesheet per page, no external resource, one same-origin
// script, AA contrast in both colour schemes
// ---------------------------------------------------------------------------

/** A page's one `<style>` block. */
function styleOf(html: string): string {
  const at = html.indexOf('<style>');
  return at < 0 ? '' : html.slice(at, html.indexOf('</style>', at) + '</style>'.length);
}

interface CssBlock {
  /** The innermost at-rule the block sits in, or `null` at the top level. */
  readonly media: string | null;
  readonly selector: string;
  readonly body: string;
}

/** Every rule block of a sheet, with the at-rule it sits in. Comments are dropped. */
function cssBlocks(css: string): CssBlock[] {
  const out: CssBlock[] = [];
  const walk = (text: string, media: string | null): void => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
        j += 1;
      }
      const inner = text.slice(open + 1, j - 1);
      if (head.startsWith('@')) walk(inner, head);
      else out.push({ media, selector: head, body: inner });
      i = j;
    }
  };
  walk(css.replace(/^<style>/, '').replace(/<\/style>$/, '').replace(/\/\*[\s\S]*?\*\//g, ''), null);
  return out;
}

function declarations(body: string): Record<string, string> {
  return Object.fromEntries(
    [...body.matchAll(/--([a-z0-9-]+):([^;]+)/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]),
  );
}

interface Schemes {
  readonly dark: Record<string, string>;
  /** The light scheme as `prefers-color-scheme:light` sets it. */
  readonly light: Record<string, string>;
  /** The light scheme as `data-theme="light"` sets it. */
  readonly lightAttr: Record<string, string>;
  /** What the `prefers-color-scheme:light` blocks alone define. */
  readonly lightOnly: Record<string, string>;
}

/**
 * The custom properties of each scheme, in cascade order. The pages set the
 * dark scheme on `:root`, and the light one twice — under the media query and
 * under `[data-theme="light"]` — and the Insights accent (the violet held in
 * the `--gold*` names) in later `:root:root:root` blocks, which is why every
 * matching block is merged rather than the first one read.
 */
function schemesOf(css: string): Schemes {
  const dark: Record<string, string> = {};
  const lightOnly: Record<string, string> = {};
  const attr: Record<string, string> = {};
  for (const block of cssBlocks(css)) {
    if (block.media === null && /^(?::root)+$/.test(block.selector)) Object.assign(dark, declarations(block.body));
    else if (
      block.media === '@media (prefers-color-scheme:light)' &&
      /^(?::root)+:not\(\[data-theme="dark"\]\)$/.test(block.selector)
    )
      Object.assign(lightOnly, declarations(block.body));
    else if (block.media === null && /^(?::root)+\[data-theme="light"\]$/.test(block.selector))
      Object.assign(attr, declarations(block.body));
  }
  return { dark, light: { ...dark, ...lightOnly }, lightAttr: { ...dark, ...attr }, lightOnly };
}

type Rgba = [number, number, number, number];
function parseColour(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1] ?? '', 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(value.replace(/\s+/g, ''));
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
  throw new Error(`not a colour: ${value}`);
}
/** A token's colour, following `var(--x)` references (`--accent` is `var(--blue)`). */
function colourOf(tokens: Record<string, string>, name: string): Rgba {
  let value = tokens[name] ?? '';
  for (let hops = 0; hops < 5; hops += 1) {
    const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    if (ref === null) break;
    value = tokens[ref[1] ?? ''] ?? '';
  }
  return parseColour(value);
}
function isColour(value: string): boolean {
  return /^(#[0-9a-f]{6}|rgba\()/i.test(value);
}
/** `top` composited over an opaque `under`. */
function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => (top[i] ?? 0) * a + (under[i] ?? 0) * (1 - a)).concat(1) as Rgba;
}
function luminance([r, g, b]: Rgba): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The opaque surfaces text sits on: the page, its two lifts, the raised panels' top, the footer floor. */
function surfacesOf(tokens: Record<string, string>): [string, Rgba][] {
  return (['bg', 'bg-2', 'bg-3', 'panel-top', 'deep'] as const).map((name) => [name, colourOf(tokens, name)]);
}

/**
 * The Insights teaser on the index, at its most violet point: the depth layer
 * paints it `color-mix(in srgb, var(--gold) 16%, var(--bg-2))`, fading to
 * `--bg-2`. That point is where its text has the least contrast.
 */
function teaserOf(tokens: Record<string, string>): Rgba {
  const gold = colourOf(tokens, 'gold');
  return over([gold[0], gold[1], gold[2], 0.16], colourOf(tokens, 'bg-2'));
}

/** The two redesigned pages, each held to the rules below against its own sheet. */
const STYLED: Readonly<Record<string, string>> = { 'index.html': PAGE, 'insights.html': INSIGHTS };

describe('v0.9.0 DoD 9.34 — the site pages’ stylesheets, scripts and contrast', () => {
  it('each page carries exactly one stylesheet, and no inline style', () => {
    // The byte-ties between pages (insights.html and thanks.html carrying the
    // index's sheet) were retired by the ruling of 2026-09-29: the redesigned
    // pages each carry their own. One sheet per page, inline, still holds.
    for (const [name, html] of Object.entries(PAGES)) {
      expect(styleOf(html).length, name).toBeGreaterThan(1000);
      expect(html.split('<style').length - 1, name).toBe(1);
      expect(html, name).not.toMatch(/<link\b[^>]*stylesheet/i);
      expect(html, name).not.toMatch(/\sstyle="/);
    }
  });

  it('loads nothing external: every src is a file under site/, and no sheet imports anything', () => {
    // thanks.html carries no image, so the non-vacuity count is over the
    // pages together.
    let total = 0;
    for (const [name, html] of Object.entries(PAGES)) {
      const srcs = [...html.matchAll(/\ssrc="([^"]+)"/g)].map((m) => m[1] ?? '');
      total += srcs.length;
      for (const src of srcs) expect(src, `${name}: ${src} is not a local file`).not.toMatch(/^(https?:)?\/\//);
      expect(html, name).not.toMatch(/<(link|iframe|object|embed|video|audio|source)\b/i);
      expect(styleOf(html), name).not.toMatch(/@import|url\(/);
    }
    expect(total).toBeGreaterThan(0);
    expect(THANKS).not.toMatch(/\ssrc="/);
  });

  it('runs one same-origin script on the pages that use it, and nothing inline', () => {
    // Ruling of 2026-09-29: `site.js` (the view switcher and the copy button)
    // is the one script, loaded `defer` from the page's own origin. No inline
    // script, no `on…=` handler, no other script source, on any page.
    for (const [name, html] of Object.entries(PAGES)) {
      const tags = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)].map((m) => m[0]);
      expect(html.match(/<script\b/gi)?.length ?? 0, name).toBe(tags.length);
      expect(tags, name).toStrictEqual(SCRIPTED_PAGES.includes(name) ? [SITE_SCRIPT_TAG] : []);
      expect(html, name).not.toMatch(/\son[a-z]+="/i);
    }
    expect(SCRIPTED_PAGES.length).toBeGreaterThan(0);
    // The script is tracked, and reaches nothing: no URL, no request API.
    expect(TRACKED_SITE).toContain('site/site.js');
    const script = readText('site/site.js');
    expect(script.length).toBeGreaterThan(100);
    expect(script).not.toMatch(/https?:|\/\/[a-z]/i);
    expect(script).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|eval|Function|importScripts)\b|\bimport\s*\(/);
    // Control: the request pattern does fire on a fetch.
    expect(/\b(fetch|XMLHttpRequest)\b/.test('fetch("x")')).toBe(true);
  });

  it('renders in both colour schemes: both light paths redefine every colour the dark one sets, identically', () => {
    for (const [name, html] of Object.entries(STYLED)) {
      const { dark, light, lightAttr, lightOnly } = schemesOf(styleOf(html));
      const colours = Object.keys(dark).filter((k) => isColour(dark[k] ?? ''));
      expect(colours.length, name).toBeGreaterThan(15);
      for (const key of colours) {
        expect(lightOnly, `${name}: the light scheme leaves --${key} dark`).toHaveProperty(key);
        // The media query and `data-theme="light"` are two doors to ONE scheme.
        expect(lightAttr[key], `${name}: --${key} differs between the two light paths`).toBe(light[key]);
      }
      // The single `color-scheme:dark light` declaration rule was retired by
      // the ruling of 2026-09-29; each scheme states its own.
      expect(styleOf(html), name).toContain('color-scheme:dark;');
      expect(styleOf(html), name).toContain('color-scheme:light;');
    }
  });

  it('meets AA in both schemes: every text token on every surface, the teaser, and the solid button', () => {
    for (const [name, html] of Object.entries(STYLED)) {
      const css = styleOf(html);
      const { dark, light } = schemesOf(css);
      for (const [scheme, tokens] of [['dark', dark], ['light', light]] as const) {
        // Every token the sheets use for TEXT, on every surface text sits on.
        for (const ink of ['text', 'text-2', 'text-3', 'blue', 'blue-2', 'gold', 'gold-2']) {
          for (const [surface, ground] of surfacesOf(tokens)) {
            const r = ratio(colourOf(tokens, ink), ground);
            expect(r, `${name} ${scheme}: --${ink} on --${surface} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
          }
        }
        // The teaser's own text: its body copy, its heading, and the violet.
        for (const ink of ['text', 'text-2', 'gold', 'gold-2']) {
          const r = ratio(colourOf(tokens, ink), teaserOf(tokens));
          expect(r, `${name} ${scheme}: --${ink} on the teaser is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        }
        // The solid button, READ FROM ITS RULES — at rest and on hover (the
        // depth layer's gradient runs between the two fills).
        for (const selector of ['.btn.solid', '.btn.solid:hover']) {
          const rule = cssBlocks(css).find((b) => b.media === null && b.selector === selector);
          expect(rule, `${name}: ${selector}`).toBeDefined();
          const fill = /background:var\(--([a-z0-9-]+)\)/.exec(rule?.body ?? '')?.[1] ?? '';
          const ink = /(?:^|;)color:var\(--([a-z0-9-]+)\)/.exec(rule?.body ?? '')?.[1] ?? '';
          const r = ratio(colourOf(tokens, ink), colourOf(tokens, fill));
          expect(r, `${name} ${scheme}: ${selector} --${ink} on --${fill} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('the ruling of 2026-09-29’s contrast fixes are the values the pages carry, at the ratios measured', () => {
    // The pinned "stated ratios" of the old design system are replaced by the
    // pairs ruling 1 changed: --text-3 in both schemes and --text-2 in dark,
    // each the smallest OKLCH lightness shift on its own hue reaching 4.5:1.
    for (const [name, html] of Object.entries(STYLED)) {
      const { dark, light } = schemesOf(styleOf(html));
      expect([dark['text-3'], light['text-3'], dark['text-2']], name).toStrictEqual(['#8993a9', '#5c6274', '#99a3b7']);
      const on = (tokens: Record<string, string>, ink: string, ground: string): number =>
        ratio(colourOf(tokens, ink), colourOf(tokens, ground));
      const measured: [number, number][] = [
        [on(dark, 'text-3', 'bg'), 5.45],
        [on(dark, 'text-3', 'bg-2'), 5.08],
        [on(dark, 'text-3', 'bg-3'), 4.63],
        [on(dark, 'text-3', 'panel-top'), 4.51],
        [on(dark, 'text-3', 'deep'), 5.93],
        [on(light, 'text-3', 'bg'), 5.3],
        [on(light, 'text-3', 'bg-2'), 4.93],
        [on(light, 'text-3', 'bg-3'), 4.53],
        [on(light, 'text-3', 'panel-top'), 5.73],
        [on(light, 'text-3', 'deep'), 4.67],
        [ratio(colourOf(dark, 'text-2'), teaserOf(dark)), 4.53],
      ];
      for (const [got, want] of measured) expect(got, name).toBeCloseTo(want, 2);
    }
  });

  it('EVERY rule that sets a text colour meets AA on the ground it sits on, in both schemes', () => {
    /*
     * Verifier round 9.39, D3: a GRID of chosen pairs lets a rule re-coloured to
     * a token outside the grid stay green. This reads the RULES: every
     * `color:var(--x)` in each sheet, on the rule's own `background:var(--y)`
     * when it sets one (composited over every surface it can sit on), and on
     * every surface otherwise.
     */
    let pairs = 0;
    for (const [name, html] of Object.entries(STYLED)) {
      const css = styleOf(html);
      const rules = cssBlocks(css).filter((r) => /(?:^|;)color:var\(--/.test(r.body));
      expect(rules.length, `${name}: no rule sets a colour - the check would be vacuous`).toBeGreaterThan(20);
      const { dark, light } = schemesOf(css);
      for (const [scheme, tokens] of [['dark', dark], ['light', light]] as const) {
        for (const rule of rules) {
          const ink = /(?:^|;)color:var\(--([a-z0-9-]+)\)/.exec(rule.body)?.[1] ?? '';
          const fill = /(?:^|;)background:var\(--([a-z0-9-]+)\)/.exec(rule.body)?.[1];
          const grounds = surfacesOf(tokens).map(([, s]) => (fill === undefined ? s : over(colourOf(tokens, fill), s)));
          for (const ground of grounds) {
            const r = ratio(colourOf(tokens, ink), ground);
            pairs += 1;
            expect(r, `${name} ${scheme}: ${rule.selector} sets --${ink}${fill ? ` on --${fill}` : ''} at ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
    expect(pairs).toBeGreaterThan(200);
  });

  // RETIRED by the ruling of 2026-09-29, for the site pages only: the old
  // design system's shape rules — "no drop shadow, ever" (box-shadow is
  // allowed on the site; the ban in the extension's webview stands), the
  // 4px / 8px / 50% radii, and the mono .74rem figcaption.

  it('underlines a link on hover, so colour is never the only signal', () => {
    // Verifier round 9.39, D5. The `.button:hover .arrow` half was retired by
    // the ruling of 2026-09-29 with the old button markup.
    for (const [name, html] of Object.entries(STYLED)) {
      expect(styleOf(html), name).toMatch(/\n {2}a:hover\{[^}]*text-decoration:underline/);
    }
  });

  it('the Insights subpage’s own words carry no advice word from the G10 list', () => {
    // W5/W6. The one-sentence hero rule, the four "what it does" titles and
    // the two-captioned-figures rule were retired by the ruling of 2026-09-29;
    // the word scan stays (and `scripts/forbidden-words.mjs` now scans both
    // pages' whole visible text as well).
    const words = INSIGHTS.replace(/<style[^]*?<\/style>/, ' ').replace(/<[^>]+>/g, ' ');
    for (const banned of ['should', 'recommend', 'consider', 'try', 'improve', 'better', 'bad', 'good', 'waste']) {
      expect(new RegExp(`\\b${banned}\\b`, 'i').test(words), `insights.html says "${banned}"`).toBe(false);
    }
    // Control: the scan can fail.
    expect(/\bshould\b/i.test('You should try it')).toBe(true);
  });

  // DELETED by the ruling of 2026-09-29: the "never sets TEXT in the decorative
  // grey" check. The redesigned pages define no `--text-muted`, so it could no
  // longer fail. RETIRED by the same ruling: the footer byte-ties (index to
  // insights, index to thanks). The author-credit describe below reads both
  // redesigned footers.
});

describe('ruling of 2026-09-29 — the author credit is in the footer, and nowhere else on a page', () => {
  /*
   * Everywhere else, only `src/about.ts` names the developer. The two
   * redesigned pages carry the author credit in their <footer>, and that is
   * the exemption: the name is read from `ABOUT_TEXT` rather than written here,
   * so this file does not name anybody either.
   */
  const author = /Built by ([^,]+),/.exec(ABOUT_TEXT)?.[1] ?? '';
  const footerOf = (html: string): string => /<footer\b[\s\S]*?<\/footer>/.exec(html)?.[0] ?? '';

  it('reads a two-word name from the About text', () => {
    expect(author.split(' ')).toHaveLength(2);
  });

  it.each(['index.html', 'insights.html'])('%s names the author in its footer only', (name) => {
    const html = PAGES[name] ?? '';
    expect(footerOf(html)).toContain(author);
    const outside = html.replace(footerOf(html), '');
    expect(outside.length).toBeGreaterThan(1000);
    expect(outside.toLowerCase()).not.toContain(author.toLowerCase());
  });

  it('thanks.html and site.js do not name the author at all', () => {
    expect(THANKS.toLowerCase()).not.toContain(author.toLowerCase());
    expect(readText('site/site.js').toLowerCase()).not.toContain(author.toLowerCase());
  });
});

describe('v0.9.0 DoD 9.36 — the extension’s Get tile opens this page', () => {
  it('is the address the site’s CNAME serves, and the file it serves', () => {
    // Bound to the TREE rather than to a second literal: every other test
    // compares against the constant itself, so a wrong host would satisfy all
    // of them. Since 2026-09-26 the site is served at its own domain, and
    // `site/CNAME` is where that domain is written down (the manifest's
    // `homepage` names it too, and is held to the same file below).
    const domain = readFileSync(join(ROOT, 'site/CNAME'), 'utf8');
    expect(domain).toBe('agent-deck.app');
    expect(INSIGHTS_PAGE_URL).toBe(`https://${domain}/insights.html`);
    expect(INSIGHTS_GET_LINK.url).toBe(INSIGHTS_PAGE_URL);
    expect(existsSync(join(ROOT, 'site', new URL(INSIGHTS_PAGE_URL).pathname.split('/').pop() ?? ''))).toBe(true);
    expect((MANIFEST as { homepage?: string }).homepage).toBe(`https://${domain}/`);
    // ...and the confirmation names that host, on both surfaces that use it.
    expect(aboutConfirmation(INSIGHTS_GET_LINK).message).toBe(
      `Agent Deck will open ${domain} in your browser`,
    );
  });
});

describe('2026-09-28 — the post-payment page', () => {
  /** The card's visible text, tags stripped and whitespace collapsed. */
  const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const card = /<article class="card receipt">([\s\S]*?)<\/article>/.exec(THANKS)?.[1] ?? '';

  it('is titled, kept out of search, and is ONE card', () => {
    expect(THANKS).toContain('<title>Payment received — Agent Deck</title>');
    expect(THANKS).toContain('<meta name="robots" content="noindex">');
    const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(THANKS)?.[1] ?? '';
    expect([...main.matchAll(/<article\b/g)]).toHaveLength(1);
    expect(card.length).toBeGreaterThan(200);
  });

  it('says exactly the agreed text, in order', () => {
    const headings = [...card.matchAll(/<(h[12])>([^<]+)<\/h[12]>/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(headings).toStrictEqual(['h1:Payment received', 'h2:Next steps', 'h2:No email after a few minutes?']);
    const paragraphs = [...card.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => text(m[1] ?? ''));
    expect(paragraphs).toStrictEqual([
      'Your Agent Deck Insights license key is on its way to the email address you used at checkout — usually within a minute.',
      'Check your spam folder first. Then write to support@agent-deck.app from the address you used at checkout and we will resend the key.',
      'Back to Agent Deck Insights',
    ]);
    const steps = [...card.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1] ?? ''));
    expect(steps).toStrictEqual([
      'Install Agent Deck and Agent Deck Insights from the VS Code Marketplace.',
      'In VS Code, open the Command Palette and run “Agent Deck Insights: Set License Key”.',
      'Paste the key from the email.',
    ]);
  });

  it('links both Marketplace listings, the support address, and back to insights.html relatively', () => {
    expect(card).toContain('href="https://marketplace.visualstudio.com/items?itemName=nvitlam.agent-deck"');
    expect(card).toContain('href="https://marketplace.visualstudio.com/items?itemName=nvitlam.agent-deck-insights"');
    expect(card).toContain('href="mailto:support@agent-deck.app"');
    expect(card).toContain('<a class="button" href="insights.html">Back to Agent Deck Insights</a>');
    // The page is a receipt, not a checkout: it links to no payment host.
    expect(THANKS).not.toContain('buy.polar.sh');
  });
});
