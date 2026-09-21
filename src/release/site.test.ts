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
import { INSIGHTS_GET_LINK, INSIGHTS_PAGE_URL, aboutConfirmation } from '../about.js';

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
const PAGES: Readonly<Record<string, string>> = { 'index.html': PAGE, 'insights.html': INSIGHTS };
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
 * The two screenshots of the Insights subpage (v0.9.0 DoD 9.34).
 *
 * They have NO `media/` twin: they are the Insights extension's own captures
 * (its `lab/docs/evidence/phase-3/`, sanitized there), and the README of
 * THIS extension does not show them. So they cannot be compared to a twin, and
 * are pinned by sha256 instead — a changed screenshot is a deliberate edit to
 * this list, and a vanished one is red.
 */
const INSIGHTS_IMAGES: Readonly<Record<string, string>> = {
  'insights-preview.png': '84d28765698176a7e5163984d589455df355b1ad22d57f2b3d046ad6a3e0f659',
  'insights-panel.png': '4ecb58c3db4d2b1ca81e760f1bcd4a627ab97403e8059432ed239b65845b8d21',
};

/**
 * The only hosts a page may reach.
 *
 * `buy.polar.sh` since v0.9.0 DoD 9.37: the six plan checkouts. A link is
 * NAVIGATION, not a fetch — the CSP below still lets no page load anything
 * from any host — so the allow-list states where a reader can be SENT.
 */
const ALLOWED_HOSTS: readonly string[] = ['github.com', 'marketplace.visualstudio.com', 'buy.polar.sh'];

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
    expect(TRACKED_SITE).toContain('site/.nojekyll');
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
    const expected = [...SITE_IMAGES, ...Object.keys(INSIGHTS_IMAGES)].map((n) => `site/media/${n}`).sort();

    expect(tracked).toStrictEqual(expected);
    expect(expected).toStrictEqual(tracked);
    // SEVEN SINCE v0.8.0 DoD 7.D: the four 0.7.1 stills plus the three 7.12
    // captures; NINE since v0.9.0 DoD 9.34, with the Insights subpage's two.
    expect(tracked).toHaveLength(9);
  });

  it('the Insights subpage screenshots are the pinned bytes', () => {
    for (const [name, hash] of Object.entries(INSIGHTS_IMAGES)) {
      expect(sha256(`site/media/${name}`), `site/media/${name} changed`).toBe(hash);
      expect(readFileSync(join(ROOT, `site/media/${name}`)).byteLength).toBeGreaterThan(1024);
    }
    expect(Object.keys(INSIGHTS_IMAGES)).toHaveLength(2);
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
    for (const [name, html] of Object.entries(PAGES)) {
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
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
  it('every absolute URL is on one of the two allowed hosts', () => {
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
      expect(csp, `${name}: the CSP admits a script source`).not.toMatch(/script-src(?! 'none')/);
    }
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
    const repoLinks = [...pageUrls(), ...pageUrls(INSIGHTS)]
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

describe('v0.7.0 DoD 5.5 — the page names the Stats view, and no longer says nothing is kept', () => {
  it('carries ONE g10 region, the Stats section, which the forbidden-word scan reads', () => {
    // v0.7.1 DoD 6.D.1 moved the region from one line in "What it does" to the
    // whole Stats section, which is what 0.7.0 and 0.7.1 add to the page. Still
    // ONE region: the scanner reads the first pair of markers only.
    const regions = [...PAGE.matchAll(/<!-- g10 -->([\s\S]*?)<!-- \/g10 -->/g)].map((m) => m[1] ?? '');
    expect(regions).toHaveLength(1);
    expect(regions[0]).toContain('Stats view');
    expect(/<section class="wrap" id="stats"><!-- g10 -->/.test(PAGE)).toBe(true);
    // The region is the scan's subject: `scripts/forbidden-words.mjs` names this
    // file and these markers, so moving the line out of them unscans it.
    const scanner = readText('scripts/forbidden-words.mjs');
    expect(scanner).toContain("join(REPO_ROOT, 'site', 'index.html')");
    expect(scanner).toContain("start: '<!-- g10 -->'");
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
// v0.9.0 DoD 9.34 — the Insights subpage: one stylesheet, no external
// resource, no script, AA contrast in both colour schemes
// ---------------------------------------------------------------------------

/** A page's one `<style>` block. */
function styleOf(html: string): string {
  const at = html.indexOf('<style>');
  return at < 0 ? '' : html.slice(at, html.indexOf('</style>', at) + '</style>'.length);
}

/** `--name:value` pairs of the first rule block after `marker`. */
function tokensAfter(css: string, marker: string): Record<string, string> {
  const at = css.indexOf(marker);
  if (at < 0) return {};
  const open = css.indexOf('{', css.indexOf(':root', at));
  const body = css.slice(open + 1, css.indexOf('}', open));
  return Object.fromEntries([...body.matchAll(/--([a-z-]+):([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]));
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

describe('v0.9.0 DoD 9.34 — the Insights subpage', () => {
  const css = styleOf(PAGE);
  const dark = tokensAfter(css, ':root{');
  const light = { ...dark, ...tokensAfter(css, '@media (prefers-color-scheme:light)') };

  it('carries the index page’s stylesheet byte for byte — one stylesheet, two pages', () => {
    expect(css.length).toBeGreaterThan(1000);
    expect(styleOf(INSIGHTS)).toBe(css);
    // And no page has a second one, inline or linked.
    for (const [name, html] of Object.entries(PAGES)) {
      expect(html.split('<style').length - 1, name).toBe(1);
      expect(html, name).not.toMatch(/<link\b[^>]*stylesheet/i);
      expect(html, name).not.toMatch(/\sstyle="/);
    }
  });

  it('loads nothing external: every src is a file under site/, and the sheet imports nothing', () => {
    for (const [name, html] of Object.entries(PAGES)) {
      const srcs = [...html.matchAll(/\ssrc="([^"]+)"/g)].map((m) => m[1] ?? '');
      expect(srcs.length, name).toBeGreaterThan(0);
      for (const src of srcs) expect(src, `${name}: ${src} is not a local file`).not.toMatch(/^(https?:)?\/\//);
      expect(html, name).not.toMatch(/<(link|iframe|object|embed|video|audio|source)\b/i);
    }
    expect(css).not.toMatch(/@import|url\(/);
  });

  it('runs no script at all — the CSP admits none and the pages carry none', () => {
    for (const [name, html] of Object.entries(PAGES)) {
      expect(html, name).not.toMatch(/<script\b/i);
      expect(html, name).not.toMatch(/\son[a-z]+="/i);
    }
  });

  it('renders in both colour schemes: a light token set redefines every colour the dark one sets', () => {
    const colours = Object.keys(dark).filter((k) => /^(#|rgba)/.test(dark[k] ?? ''));
    expect(colours.length).toBeGreaterThan(15);
    const lightOnly = tokensAfter(css, '@media (prefers-color-scheme:light)');
    for (const key of colours) expect(lightOnly, `light scheme leaves --${key} dark`).toHaveProperty(key);
    expect(css).toContain('color-scheme:dark light');
  });

  it('meets AA in both schemes, at the ratios the design system states', () => {
    for (const [scheme, tokens] of [['dark', dark], ['light', light]] as const) {
      const page = parseColour(tokens['bg-primary'] ?? '');
      const panel = over(parseColour(tokens['bg-secondary'] ?? ''), page);
      const card = over(parseColour(tokens['bg-card'] ?? ''), page);
      const cardHover = over(parseColour(tokens['bg-card-hover'] ?? ''), page);
      // Every token the sheet uses for TEXT, on every surface text sits on.
      for (const ink of ['text-primary', 'text-secondary', 'blue-light', 'blue-bright', 'orange-light', 'green']) {
        for (const [surface, ground] of [['page', page], ['panel', panel], ['card', card], ['card hover', cardHover]] as const) {
          const r = ratio(parseColour(tokens[ink] ?? ''), ground);
          expect(r, `${scheme}: --${ink} on ${surface} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        }
      }
      // The primary button, READ FROM ITS RULES — at rest and on hover — so
      // the check is about the tokens the button really uses, not a pair
      // chosen here (mutation S10: the reference site's mid blue with light
      // ink, 3.4:1, went red only through the identity test before).
      for (const selector of ['.button.primary{', '.button.primary:hover{']) {
        const at = css.indexOf(`  ${selector}`);
        expect(at, selector).toBeGreaterThan(-1);
        const rule = css.slice(at, css.indexOf('}', at));
        const fill = /background:var\(--([a-z-]+)\)/.exec(rule)?.[1] ?? '';
        const ink = /;color:var\(--([a-z-]+)\)/.exec(rule)?.[1] ?? '';
        const r = ratio(parseColour(tokens[ink] ?? ''), parseColour(tokens[fill] ?? ''));
        expect(r, `${scheme}: ${selector} --${ink} on --${fill} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // The system's own stated ratios, re-derived, so the tokens are its values.
    const stated = (tokens: Record<string, string>, ink: string, fill: string): number =>
      Math.round(ratio(parseColour(tokens[ink] ?? ''), parseColour(tokens[fill] ?? '')) * 10) / 10;
    expect(stated(dark, 'text-primary', 'bg-primary')).toBeCloseTo(14.8, 0);
    expect(stated(dark, 'text-secondary', 'bg-primary')).toBeCloseTo(5.3, 0);
    expect(stated(dark, 'text-inverse', 'blue-light')).toBeCloseTo(6.8, 0);
    expect(stated(light, 'text-primary', 'bg-primary')).toBeCloseTo(13.7, 0);
    expect(stated(light, 'text-secondary', 'bg-primary')).toBeCloseTo(6.6, 0);
    expect(stated(light, 'blue-light', 'bg-primary')).toBeCloseTo(7.0, 0);
  });

  it('never sets TEXT in the decorative grey, which the system rules is not a text colour', () => {
    // #3E4758 is 2.1:1 on the dark page; the reference site used it for
    // captions, labels and comments, and the system demoted it.
    expect(css).not.toMatch(/(^|[;{])\s*color:var\(--text-muted\)/m);
    // Control: the scan finds the shape it is looking for.
    expect(/(^|[;{])\s*color:var\(--text-muted\)/m.test('.x{color:var(--text-muted)}')).toBe(true);
  });

  it('the footer is the index page’s, byte for byte', () => {
    const footer = (html: string): string => /<footer class="footer">[\s\S]*?<\/footer>/.exec(html)?.[0] ?? '';
    expect(footer(PAGE).length).toBeGreaterThan(100);
    expect(footer(INSIGHTS)).toBe(footer(PAGE));
  });

  it('every screenshot on the subpage carries a one-sentence caption', () => {
    const figures = [...INSIGHTS.matchAll(/<figure>([\s\S]*?)<\/figure>/g)].map((m) => m[1] ?? '');
    expect(figures).toHaveLength(2);
    for (const figure of figures) {
      const caption = /<figcaption>([^<]+)<\/figcaption>/.exec(figure)?.[1] ?? '';
      expect(caption.length, 'a screenshot without its caption').toBeGreaterThan(20);
      expect(caption.split(/[.!?](\s|$)/).filter((s) => s.trim().length > 0), caption).toHaveLength(1);
    }
  });
});

describe('v0.9.0 DoD 9.36 — the extension’s Get tile opens this page', () => {
  it('is the Pages address the manifest’s repository implies, and the file it serves', () => {
    // Bound to the MANIFEST and to the TREE rather than to a second literal:
    // every other test compares against the constant itself, so a wrong host
    // would satisfy all of them. GitHub Pages serves a project repository
    // `github.com/<owner>/<repo>` at `<owner>.github.io/<repo>/`.
    const [, owner, repo] = new URL(MANIFEST.repository.url.replace(/\.git$/, '')).pathname.split('/');
    expect(owner && repo, 'the manifest names no owner/repository').toBeTruthy();
    const expected = `https://${(owner ?? '').toLowerCase()}.github.io/${repo ?? ''}/insights.html`;
    expect(INSIGHTS_PAGE_URL).toBe(expected);
    expect(INSIGHTS_GET_LINK.url).toBe(INSIGHTS_PAGE_URL);
    expect(existsSync(join(ROOT, 'site', new URL(INSIGHTS_PAGE_URL).pathname.split('/').pop() ?? ''))).toBe(true);
    // ...and the confirmation names that host, on both surfaces that use it.
    expect(aboutConfirmation(INSIGHTS_GET_LINK).message).toBe(
      `Agent Deck will open ${(owner ?? '').toLowerCase()}.github.io in your browser`,
    );
  });
});
