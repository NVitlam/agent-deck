// v0.7.1 Phase 6.D — the four public surfaces agree with each other, with the
// CHANGELOG, and with the code.
//
// The surfaces are README.md (the Marketplace listing page), SECURITY.md (ships
// in the VSIX), site/index.html (GitHub Pages) and the listing fields in
// package.json, plus the GitHub Release body the tag workflow publishes. The
// standing rule (PLAN delta 2026-09-11) gives every release a `<phase>.D`
// sub-phase for them, because each has gone stale at least once while every
// code gate was green: the site described 0.6.x through the whole of 0.7.0, its
// image dimensions described files that were replaced, SECURITY.md said the
// event path was the only route a release after the second one arrived, and the
// Release bodies were a single generated compare link.
//
// `readme.test.ts` owns the README's claims about code (the hook block, the
// version windows, the settings table's names, the Stats vocabulary) and
// `site.test.ts` owns the page's reachability and its media twins. This file
// owns what crosses surfaces:
//
//   (a) ONE VERSION. package.json, the CHANGELOG's top heading and the page's
//       version string are one number, and the page states it once.
//   (b) EVERY ADDED FEATURE IS ON BOTH PAGES. One row per `### Added` bullet of
//       the 0.7.0 and 0.7.1 entries, bullet | keyword | README | site. The
//       bullet column is read back off the CHANGELOG, so a bullet added without
//       a row is red; the keyword column was chosen by hand, once.
//   (c) EVERY IMAGE EXISTS, is non-empty, and the page's width/height say what
//       the file says. The page carried 1600x900 for 3730x2094 files.
//   (d) THE LISTING IS NOT NAMED AFTER AN ENGINE, and keeps the locked keywords.
//   (e) "ESTIMATED" IS A LABEL. Every occurrence of the word on a surface is
//       one of the two labels the Tokens view prints, read from the webview's
//       own table rather than written down a second time.
//   6.D.3 SECURITY.md NAMES ITS PROOFS, and each named test exists.
//   6.D.4 the README's telemetry section shows the Tokens view.
//   6.D.5 THE RELEASE BODY IS THE CHANGELOG SECTION, extracted by a script this
//       file runs on the committed CHANGELOG.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_BODY_BYTES, TELEMETRY_PATHS } from '../hooks/listener.js';
import { SIDEBAR_MENU } from '../sidebar/menu.js';
import { COST_SOURCE_LABELS } from '../../webview/stats/layout.js';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- a plain .mjs script with no declarations; the same import `golden-check.test.ts` makes.
import { changelogSection as untypedChangelogSection } from '../../scripts/release-notes.mjs';

/** Typed at the one place it enters TypeScript, so every call below is checked. */
const changelogSection = untypedChangelogSection as (
  text: string,
  version: string,
) => { ok: true; section: string } | { ok: false; reason: string };

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Text with line endings normalised: every assertion here is about content. */
function readText(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

const README = readText('README.md');
const SECURITY = readText('SECURITY.md');
const CHANGELOG = readText('CHANGELOG.md');
const PAGE = readText('site/index.html');
const RELEASE_YML = readText('.github/workflows/release.yml');

interface ConfigProperty {
  default?: unknown;
  scope?: string;
  description?: string;
}
const MANIFEST = JSON.parse(readText('package.json')) as {
  version: string;
  displayName: string;
  description: string;
  categories: string[];
  keywords: string[];
  contributes: { configuration: { properties: Record<string, ConfigProperty> } };
};

/** The engines this extension observes, as a reader would name them. */
const ENGINE_NAMES = ['Claude', 'Claude Code', 'OpenCode', 'Codex'] as const;

/** Collapse runs of whitespace, so a phrase wrapped across lines still matches. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * What the page SAYS: the style block and every tag removed, the few entities
 * the page uses decoded, whitespace collapsed. A keyword split by a tag
 * (`<b>Loops &amp; churn</b>`) is still the phrase a reader sees.
 */
function pageText(html: string): string {
  return flat(
    html
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}
const PAGE_TEXT = pageText(PAGE);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The keyword occurs as a word START, case-insensitively: `stall` would find
 * `install` without the leading boundary, and `re-fit` must still find
 * `re-fits`, so there is no trailing one.
 */
function hasKeyword(text: string, keyword: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(keyword)}`, 'i').test(flat(text));
}

/** One `## <heading>` section of a markdown document, heading line included. */
function mdSection(text: string, headingPrefix: string): string {
  const start = text.indexOf(`\n${headingPrefix}`);
  if (start === -1) return '';
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start + 1, next === -1 ? undefined : next);
}

/** Every `- **lead**` bullet under `### Added` in the `## <version>` entry, by its bold lead. */
function addedBullets(version: string): string[] {
  const entry = mdSection(CHANGELOG, `## ${version} `);
  const from = entry.indexOf('\n### Added\n');
  if (from === -1) return [];
  const rest = entry.slice(from + '\n### Added\n'.length);
  const to = rest.search(/\n### /);
  const block = to === -1 ? rest : rest.slice(0, to);
  // A bullet runs until the next line that starts a bullet; its continuation
  // lines are indented, and a bold lead can wrap onto one of them.
  const bullets: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('- ')) bullets.push(line);
    else if (bullets.length > 0) bullets[bullets.length - 1] = `${bullets[bullets.length - 1] ?? ''}\n${line}`;
  }
  return bullets.map((b) => /^- \*\*(.+?)\*\*/.exec(flat(b))?.[1] ?? `(no bold lead) ${b}`);
}

// ---------------------------------------------------------------------------
// (a) one version
// ---------------------------------------------------------------------------

describe('6.D.2 (a) — package.json, the CHANGELOG and the page state one version', () => {
  it('the CHANGELOG top heading is the manifest version', () => {
    const top = /^## (\S+) /m.exec(CHANGELOG)?.[1];
    expect(top).toBe(MANIFEST.version);
  });

  it('the page states the manifest version once, in its version element', () => {
    const element = [...PAGE.matchAll(/<span id="version">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(element).toStrictEqual([MANIFEST.version]);
    // Once on the whole page, as a whole version: `0.7.1` inside `0.7.10` or
    // `10.7.1` is not a second statement of it.
    const whole = new RegExp(`(?<![\\d.])${escapeRegExp(MANIFEST.version)}(?![\\d.])`, 'g');
    expect(PAGE.match(whole) ?? []).toHaveLength(1);
    // Vacuity control: the pattern does find a version and does skip a longer one.
    expect('v 0.7.1 and 0.7.10'.match(/(?<![\d.])0\.7\.1(?![\d.])/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (b) the keyword table
// ---------------------------------------------------------------------------

interface KeywordRow {
  readonly version: '0.7.0' | '0.7.1' | '0.8.0';
  /** The bullet's bold lead, exactly as the CHANGELOG writes it. */
  readonly bullet: string;
  /** A phrase a reader of either page would search for. */
  readonly keyword: string;
  /** Present in README.md. Every row is `true` at commit; a row that cannot be is reported, not deleted. */
  readonly readme: boolean;
  /** Present in site/index.html's text. */
  readonly site: boolean;
}

/**
 * THE TABLE IS THE ASSERTION, reviewed by hand once (DoD 6.D.2 (b)). One row per
 * `### Added` bullet of the two entries, in CHANGELOG order.
 */
const KEYWORD_TABLE: readonly KeywordRow[] = [
  { version: '0.7.0', bullet: 'A Stats view, and a local history behind it.', keyword: 'Stats view', readme: true, site: true },
  { version: '0.7.0', bullet: 'Tools that stop making progress are shown as stalled.', keyword: 'stalled', readme: true, site: true },
  { version: '0.7.0', bullet: 'The Stats view', keyword: 'Loops & churn', readme: true, site: true },
  { version: '0.7.0', bullet: 'The history stays on your machine.', keyword: 'Clear Stats History', readme: true, site: true },
  { version: '0.7.0', bullet: 'Your own prices, for a cost the engine does not report.', keyword: 'agentDeck.pricing', readme: true, site: true },
  { version: '0.7.0', bullet: 'An extension API.', keyword: 'extension API', readme: true, site: true },
  { version: '0.7.0', bullet: 'An activity-bar entry.', keyword: 'activity bar', readme: true, site: true },
  { version: '0.7.0', bullet: 'The canvas re-fits itself.', keyword: 're-fit', readme: true, site: true },
  {
    version: '0.7.0',
    bullet: 'Stalled `AskUserQuestion` and `ExitPlanMode` calls read "waiting on you".',
    keyword: 'waiting on you',
    readme: true,
    site: true,
  },
  { version: '0.7.0', bullet: 'The tool-call drawer follows the latest call', keyword: 'follows new calls', readme: true, site: true },
  {
    version: '0.7.1',
    bullet: "Claude Code's OpenTelemetry export, received — optional, off by default.",
    keyword: 'OpenTelemetry',
    readme: true,
    site: true,
  },
  {
    version: '0.7.1',
    bullet: 'A cost for Claude Code sessions, estimated by Claude Code.',
    keyword: 'estimated by Claude Code',
    readme: true,
    site: true,
  },
  { version: '0.7.1', bullet: 'Tool durations where the session states none', keyword: 'tool duration', readme: true, site: true },
  { version: '0.7.1', bullet: '`agentDeck.telemetry.enabled`', keyword: 'agentDeck.telemetry.enabled', readme: true, site: true },
  {
    version: '0.7.1',
    bullet: "Telemetry figures on the Agent Deck output channel's counters line",
    keyword: 'unmatched',
    readme: true,
    site: true,
  },
  // v0.8.0 Phase 7, DoD 7.D — reviewed by hand against the entry, one row per bullet.
  { version: '0.8.0', bullet: 'A Tools part in the Stats view.', keyword: 'longest call', readme: true, site: true },
  {
    version: '0.8.0',
    bullet: "A session's own timings in the Tokens part.",
    keyword: 'time to the first tool call',
    readme: true,
    site: true,
  },
  { version: '0.8.0', bullet: 'Tokens a minute in Trends', keyword: 'tokens a minute', readme: true, site: true },
  {
    version: '0.8.0',
    bullet: 'A time and a gap on every row of the tool-call drawer.',
    keyword: 'gap between calls',
    readme: true,
    site: true,
  },
  {
    version: '0.8.0',
    bullet: 'Subagents whose spawning call has no result',
    keyword: 'spawning call has no result',
    readme: true,
    site: true,
  },
  { version: '0.8.0', bullet: 'A Tweaks tab in the sidebar', keyword: 'Tweaks', readme: true, site: true },
  { version: '0.8.0', bullet: 'Oversize Codex transcripts are read in part.', keyword: 'read in part', readme: true, site: true },
  { version: '0.8.0', bullet: '`foreign` on the counters line.', keyword: 'foreign', readme: true, site: true },
];

describe('6.D.2 (b) — every Added bullet of 0.7.0, 0.7.1 and 0.8.0 is on the README and the page', () => {
  it('the table has one row per Added bullet, in order, both ways, with the count beside it', () => {
    for (const version of ['0.7.0', '0.7.1', '0.8.0'] as const) {
      const bullets = addedBullets(version);
      const rows = KEYWORD_TABLE.filter((row) => row.version === version).map((row) => row.bullet);
      expect(rows, `${version}: the table and the CHANGELOG's Added bullets differ`).toStrictEqual(bullets);
    }
    expect(KEYWORD_TABLE).toHaveLength(23);
    // Vacuity control: the extractor reads a bullet whose bold lead wraps.
    expect(addedBullets('0.7.0')).toContain(
      'Stalled `AskUserQuestion` and `ExitPlanMode` calls read "waiting on you".',
    );
  });

  it.each(KEYWORD_TABLE)(
    '$keyword — measured presence equals the table, and the table says both',
    (row) => {
      expect({ readme: hasKeyword(README, row.keyword), site: hasKeyword(PAGE_TEXT, row.keyword) }).toStrictEqual({
        readme: row.readme,
        site: row.site,
      });
      expect({ readme: row.readme, site: row.site }, `unsatisfied row: ${row.bullet}`).toStrictEqual({
        readme: true,
        site: true,
      });
    },
  );

  it('the keyword match is a word start, so it cannot be satisfied inside another word', () => {
    expect(hasKeyword('Install the hook', 'stall')).toBe(false);
    expect(hasKeyword('The canvas re-fits', 're-fit')).toBe(true);
    expect(hasKeyword('<b>Loops &amp; churn</b>', 'Loops & churn')).toBe(false);
    expect(hasKeyword(pageText('<b>Loops &amp; churn</b>'), 'Loops & churn')).toBe(true);
  });
});

describe('6.D.1 — the page describes 0.7.0 and 0.7.1 as shipped', () => {
  it('names the four parts of the Stats view, the retention setting and the several-windows arrangement', () => {
    for (const phrase of [
      'Files',
      'Loops & churn',
      'Tokens',
      'Trends',
      'agentDeck.stats.retentionDays',
      'Several windows, one port',
      'estimated by Claude Code',
    ]) {
      expect(PAGE_TEXT, phrase).toContain(phrase);
    }
  });

  it('lists the sidebar menu as src/sidebar/menu.ts declares it', () => {
    for (const entry of SIDEBAR_MENU) expect(PAGE_TEXT, entry.label).toContain(entry.label);
    expect(SIDEBAR_MENU.length).toBeGreaterThan(0);
  });

  it('"What it never does" is the four sentences it was, and nothing was added to it', () => {
    const list = /<article class="no"><h3>What it never does<\/h3><ul>([\s\S]*?)<\/ul>/.exec(PAGE)?.[1] ?? '';
    const items = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    expect(items).toStrictEqual([
      'Write to agent settings, transcripts, or databases.',
      'Launch, proxy, steer, or configure an agent.',
      'Keep session content, or ship a price table.',
      'Send data to a network service.',
    ]);
  });

  it('no longer says it makes no outbound request, which 0.7.0 made false', () => {
    // Since 0.7.0 a second window reaches the first on 127.0.0.1: one loopback
    // client (`egress.test.ts` pins it). The trust strip said otherwise.
    expect(PAGE_TEXT).not.toMatch(/outbound requests/i);
    expect(PAGE_TEXT).toContain('Every socket it opens is on 127.0.0.1.');
  });
});

// ---------------------------------------------------------------------------
// (c) images
// ---------------------------------------------------------------------------

/** A PNG's pixel size, from its IHDR chunk; `null` for anything else. */
function pngSize(file: string): { width: number; height: number } | null {
  const bytes = readFileSync(file);
  const signature = '89504e470d0a1a0a';
  if (bytes.subarray(0, 8).toString('hex') !== signature) return null;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('6.D.2 (c) — every image either page references exists, is non-empty, and is the size the page says', () => {
  const readmeImages = [...README.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
    .map((m) => m[1] ?? '')
    .filter((link) => !/^https?:/.test(link));
  const pageImages = [...PAGE.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);

  it('README: every local image is a non-empty file', () => {
    expect(readmeImages.length).toBeGreaterThan(0);
    for (const link of readmeImages) {
      const path = join(ROOT, link);
      expect(existsSync(path), `${link} is missing`).toBe(true);
      expect(statSync(path).size, `${link} is empty`).toBeGreaterThan(0);
    }
  });

  it('page: every <img> names a non-empty PNG under site/, with width and height equal to its pixels', () => {
    expect(pageImages.length).toBeGreaterThan(0);
    for (const tag of pageImages) {
      const src = /\bsrc="([^"]+)"/.exec(tag)?.[1] ?? '';
      const width = Number(/\bwidth="(\d+)"/.exec(tag)?.[1]);
      const height = Number(/\bheight="(\d+)"/.exec(tag)?.[1]);
      const path = join(ROOT, 'site', src);
      expect(existsSync(path), `site/${src} is missing`).toBe(true);
      expect(statSync(path).size, `site/${src} is empty`).toBeGreaterThan(0);
      expect(pngSize(path), `site/${src}: the width/height attributes are not the file's`).toStrictEqual({
        width,
        height,
      });
    }
  });

  it('reads a PNG size, and reads nothing from a file that is not one', () => {
    // Vacuity control for the comparison above: a wrong reader returning the
    // attributes back would pass it.
    expect(pngSize(join(ROOT, 'media', 'icon.png'))?.width).toBeGreaterThan(0);
    expect(pngSize(join(ROOT, 'media', 'activity-icon.svg'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (d) listing fields
// ---------------------------------------------------------------------------

/** The five keywords the user locked (6.D brief). `manifest.test.ts` pins the whole list and its order. */
const LOCKED_KEYWORDS = ['claude code', 'observability', 'agents', 'monitor', 'subagents'] as const;

describe('6.D.2 (d) — the listing is named after the product, not after an engine', () => {
  const leadsWithEngine = (text: string): boolean =>
    ENGINE_NAMES.some((engine) => text.trimStart().toLowerCase().startsWith(engine.toLowerCase()));

  it('the description leads with no engine name, and the display name carries none', () => {
    expect(leadsWithEngine(MANIFEST.description), MANIFEST.description).toBe(false);
    for (const engine of ENGINE_NAMES) expect(MANIFEST.displayName).not.toContain(engine);
    // Control: the predicate does fire on engine-first naming.
    expect(leadsWithEngine('Claude Code session monitor')).toBe(true);
    expect(leadsWithEngine('Codex deck')).toBe(true);
  });

  it('no category names an engine', () => {
    expect(MANIFEST.categories.length).toBeGreaterThan(0);
    for (const category of MANIFEST.categories) {
      for (const engine of ENGINE_NAMES) expect(category.toLowerCase()).not.toContain(engine.toLowerCase());
    }
  });

  it('the locked keywords lead the keyword list, in order', () => {
    expect(MANIFEST.keywords.slice(0, LOCKED_KEYWORDS.length)).toStrictEqual([...LOCKED_KEYWORDS]);
  });

  it('the page title, its first heading and the README title lead with the product', () => {
    const title = /<title>([^<]*)<\/title>/.exec(PAGE)?.[1] ?? '';
    expect(title.startsWith('Agent Deck')).toBe(true);
    expect(README.startsWith('# Agent Deck\n')).toBe(true);
    const h1 = pageText(/<h1>([\s\S]*?)<\/h1>/.exec(PAGE)?.[1] ?? '').trim();
    expect(h1.length).toBeGreaterThan(0);
    expect(leadsWithEngine(h1), h1).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (e) the estimated-cost label
// ---------------------------------------------------------------------------

/** The labels the Tokens view prints that start with "estimated", read from the webview's own table. */
const ESTIMATED_LABELS = Object.values(COST_SOURCE_LABELS).filter((label) => /^estimated\b/i.test(label));

/** Every occurrence of the word "estimated" in `text` that does not begin one of the labels. */
function unlabelledEstimates(text: string): string[] {
  const body = flat(text);
  const out: string[] = [];
  for (const match of body.matchAll(/\bestimated\b/gi)) {
    const at = match.index ?? 0;
    const rest = body.slice(at).toLowerCase();
    if (!ESTIMATED_LABELS.some((label) => rest.startsWith(label.toLowerCase()))) {
      out.push(body.slice(Math.max(0, at - 40), at + 40));
    }
  }
  return out;
}

/*
 * THE SCOPE IS THE WORD "estimated", as the DoD quotes it: the adjective a
 * reader takes for a label. Four sentences say the verb instead ("Claude Code's
 * telemetry estimates one") without the label — README's pricing paragraph and
 * its "What it does not do" list, SECURITY.md's source table and the
 * telemetry setting's description. They describe where a cost comes from and
 * print no figure; one of them sits in the list DoD 6.D.4 keeps unchanged.
 * Widening the pattern to `estimat\w*` would turn all four red. Found by the
 * 6.D verifier round; recorded here rather than widened silently.
 */
describe('6.D.2 (e) — no surface says "estimated" about a cost without the exact label', () => {
  const surfaces: Readonly<Record<string, string>> = {
    'README.md': README,
    'SECURITY.md': SECURITY,
    'site/index.html': PAGE_TEXT,
    // `pageText` drops attributes, and an image's alt text is what a screen
    // reader says in place of the picture.
    'site/index.html alt text': [...PAGE.matchAll(/\balt="([^"]*)"/g)].map((m) => m[1] ?? '').join('\n'),
    [`CHANGELOG.md ${MANIFEST.version}`]: mdSection(CHANGELOG, `## ${MANIFEST.version} `),
    'package.json description': MANIFEST.description,
    'package.json settings': Object.values(MANIFEST.contributes.configuration.properties)
      .map((p) => p.description ?? '')
      .join('\n'),
  };

  it('the two labels are the ones the Tokens view prints', () => {
    expect([...ESTIMATED_LABELS].sort()).toStrictEqual(['estimated by Claude Code', 'estimated from your prices']);
  });

  it.each(Object.keys(surfaces))('%s', (name) => {
    expect(unlabelledEstimates(surfaces[name] ?? '')).toStrictEqual([]);
  });

  it('the scan is not vacuous: the surfaces use the word, and a bare use is caught', () => {
    const uses = Object.values(surfaces).reduce((n, text) => n + (flat(text).match(/\bestimated\b/gi)?.length ?? 0), 0);
    expect(uses).toBeGreaterThan(5);
    expect(unlabelledEstimates('The cost is estimated per session.')).toHaveLength(1);
    expect(unlabelledEstimates('A cost, estimated by Claude Code, and one estimated from your prices.')).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6.D.3 SECURITY.md names its proofs
// ---------------------------------------------------------------------------

interface Citation {
  readonly file: string;
  readonly title: string;
}

/** Every `` `src/….test.ts` › "title" `` citation in `text`, in order. */
function citations(text: string): Citation[] {
  return [...text.matchAll(/`(src\/[\w./-]+\.test\.ts)`\s*›\s*"([^"]+)"/g)].map((m) => ({
    file: m[1] ?? '',
    title: m[2] ?? '',
  }));
}

/**
 * True when `source` declares an `it(…)` or `describe(…)` whose title is exactly
 * `title` — on a line of code, not in a comment that quotes one.
 */
function declaresTest(source: string, title: string): boolean {
  for (const quote of ["'", '"', '`']) {
    const needle = `${quote}${title}${quote}`;
    let at = source.indexOf(needle);
    while (at !== -1) {
      const from = Math.max(0, at - 60);
      const call = /\b(?:it|describe)\b[^\n]*\(\s*$/.exec(source.slice(from, at));
      if (call !== null) {
        const callAt = from + call.index;
        const lineStart = source.lastIndexOf('\n', callAt - 1) + 1;
        const lead = source.slice(lineStart, callAt).trimStart();
        if (!lead.startsWith('//') && !lead.startsWith('*')) return true;
      }
      at = source.indexOf(needle, at + 1);
    }
  }
  return false;
}

const SECTION_3 = mdSection(SECURITY, '## 3. ');
const SECTION_4 = mdSection(SECURITY, '## 4. ');

/** The top-level `- ` bullets of a markdown block, each with its continuation lines. */
function bulletsOf(block: string): string[] {
  const out: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('- ')) out.push(line);
    else if (out.length > 0 && line.startsWith('  ')) out[out.length - 1] = `${out[out.length - 1] ?? ''}\n${line}`;
    else if (out.length > 0 && line.trim() !== '') out.push('');
  }
  return out.filter((b) => b.length > 0);
}

describe('6.D.3 — SECURITY.md §3 and §4 name the test that proves each property', () => {
  const all = [...citations(SECTION_3), ...citations(SECTION_4)];

  it('every citation names a test file that exists and a test in it with exactly that title', () => {
    expect(all.length, 'no citations found — the check would be vacuous').toBeGreaterThan(20);
    const sources = new Map<string, string>();
    for (const { file, title } of all) {
      const path = join(ROOT, file);
      expect(existsSync(path), `${file} does not exist`).toBe(true);
      if (!sources.has(file)) sources.set(file, readText(file));
      expect(declaresTest(sources.get(file) ?? '', title), `${file} has no test titled "${title}"`).toBe(true);
    }
    // At least the listener's, the route's and the egress census's files.
    expect(new Set(all.map((c) => c.file)).size).toBeGreaterThanOrEqual(5);
  });

  it('the title finder can fail: a title that is only in a comment, or not there at all, is not a test', () => {
    const source = "// it('binds only loopback')\nit('binds the literal address', () => {});\n";
    expect(declaresTest(source, 'binds the literal address')).toBe(true);
    expect(declaresTest(source, 'binds only loopback')).toBe(false);
    expect(declaresTest(source, 'binds nothing')).toBe(false);
  });

  it("every property bullet of the listener's trust boundary carries a proof", () => {
    const block = SECTION_3.slice(0, SECTION_3.indexOf('**Hostile-input testing.**'));
    const bullets = bulletsOf(block);
    expect(bullets).toHaveLength(7);
    for (const bullet of bullets) expect(citations(bullet).length, bullet.slice(0, 80)).toBeGreaterThan(0);
  });

  it('every asserted property of the bundle in §4a carries a proof', () => {
    const from = SECTION_4.indexOf('**What is asserted');
    const to = SECTION_4.indexOf('**Limits, honestly.**', from);
    const bullets = bulletsOf(SECTION_4.slice(from, to));
    expect(bullets).toHaveLength(5);
    for (const bullet of bullets) expect(citations(bullet).length, bullet.slice(0, 80)).toBeGreaterThan(0);
  });

  it('§3 lists the three telemetry routes and a table of every answer, each row with its proof', () => {
    for (const path of Object.values(TELEMETRY_PATHS)) expect(SECTION_3).toContain(`\`${path}\``);
    const rows = [...SECTION_3.matchAll(/^\| `(\d{3})` \|([^\n]*)$/gm)];
    const statuses = rows.map((m) => m[1]);
    expect([...statuses].sort()).toStrictEqual(['200', '400', '403', '405', '413', '415']);
    expect(statuses).toHaveLength(6);
    for (const row of rows) {
      const cited = citations(row[2] ?? '');
      expect(cited, `the ${String(row[1])} row names no proof`).toHaveLength(1);
      // The proof is the route test's describe for THIS answer.
      expect(cited[0]?.file).toBe('src/hooks/telemetry-route.test.ts');
      expect(cited[0]?.title).toContain(` ${String(row[1])}: `);
    }
    // The 413 row states the cap the listener enforces, by name and in KiB.
    const row413 = rows.find((m) => m[1] === '413')?.[2] ?? '';
    expect(row413).toContain('`DEFAULT_MAX_BODY_BYTES`');
    expect(row413).toContain(`${String(DEFAULT_MAX_BODY_BYTES / 1024)} KiB`);
  });

  it('no answer in the table is a status OTLP retries on', () => {
    // SECURITY.md §3 says no answer asks the exporter to retry. OTLP over HTTP
    // retries on 429, 502, 503 and 504; the table is every status the route
    // gives (pinned above, and each row's proof is the route test for it).
    const OTLP_RETRYABLE = ['429', '502', '503', '504'];
    const statuses = [...SECTION_3.matchAll(/^\| `(\d{3})` \|/gm)].map((m) => m[1] ?? '');
    expect(statuses.length).toBe(6);
    expect(statuses.filter((status) => OTLP_RETRYABLE.includes(status))).toStrictEqual([]);
    expect(SECTION_3).toContain('No answer asks the exporter to retry');
  });
});

// ---------------------------------------------------------------------------
// 6.D.4 the README
// ---------------------------------------------------------------------------

describe('6.D.4 — the README shows the Tokens view and states the telemetry setting whole', () => {
  it('the telemetry section carries the Tokens screenshot, with the label in its alt text', () => {
    const section = mdSection(README, '## Claude Code telemetry (optional)');
    const image = /!\[([^\]]*)\]\(media\/stats_tokens\.png\)/.exec(section);
    expect(image, 'the telemetry section does not show media/stats_tokens.png').not.toBeNull();
    expect(image?.[1]).toContain('estimated by Claude Code');
  });

  it('the settings table row states the manifest default and scope', () => {
    const setting = MANIFEST.contributes.configuration.properties['agentDeck.telemetry.enabled'];
    expect(setting?.default).toBe(false);
    expect(setting?.scope).toBe('machine');
    const row = README.split('\n').find((line) => line.startsWith('| `agentDeck.telemetry.enabled` |')) ?? '';
    expect(row).toContain(`Default \`${String(setting?.default)}\``);
    expect(row).toContain('Machine-scoped');
  });

  it('"What it does not do" keeps its seven statements', () => {
    const section = mdSection(README, '## What it does not do');
    const leads = [...section.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1]);
    expect(leads).toStrictEqual([
      'No writes to anything it observes.',
      'No launching, wrapping or proxying any of the three engines.',
      'No session replay.',
      'It sends no telemetry, no analytics, and nothing off the machine.',
      'No price table and no cost analytics.',
      'No control surface.',
      'No settings for the OpenCode or Codex sides.',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6.D.5 release notes
// ---------------------------------------------------------------------------

const SCRIPT = join(ROOT, 'scripts', 'release-notes.mjs');

/** The script as the workflow runs it, once per argument set. */
function runNotes(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const TAGGED = runNotes(`v${MANIFEST.version}`);
const UNKNOWN = runNotes('v0.0.1');

describe('6.D.5 — the GitHub Release body is the tag’s CHANGELOG section', () => {
  it('run on the committed CHANGELOG, it returns the current section whole', () => {
    expect(TAGGED.status, TAGGED.stderr).toBe(0);
    // Computed a second way, by string search rather than by lines.
    const start = CHANGELOG.indexOf(`\n## ${MANIFEST.version} `) + 1;
    const end = CHANGELOG.indexOf('\n## ', start);
    expect(start).toBeGreaterThan(0);
    const expected = `${CHANGELOG.slice(start, end).trimEnd()}\n`;
    expect(TAGGED.stdout).toBe(expected);
    // Whole: from its heading, through every sub-heading, to its last line, and
    // no line of the entry below it.
    expect(TAGGED.stdout.startsWith(`## ${MANIFEST.version} - `)).toBe(true);
    // The sub-headings are READ from the committed section rather than listed: a
    // literal list named 0.7.1's three, so the check could only ever describe that
    // one release. Pinned non-empty beside it, so an empty read is not a pass.
    const section = CHANGELOG.replace(/\r\n/g, '\n').split(`\n## ${MANIFEST.version} `)[1]?.split('\n## ')[0] ?? '';
    const subs = section.match(/^### .+$/gm) ?? [];
    expect(subs.length).toBeGreaterThan(0);
    for (const sub of subs) expect(TAGGED.stdout).toContain(`\n${sub}\n`);
    expect(TAGGED.stdout).not.toMatch(/^## (?!\S+ - )/m);
    expect(TAGGED.stdout.match(/^## /gm)).toHaveLength(1);
    expect(TAGGED.stdout.includes('\r')).toBe(false);
  });

  it('refuses a version with no section: exit 1, nothing on stdout, the reason on stderr', () => {
    expect(UNKNOWN.status).toBe(1);
    expect(UNKNOWN.stdout).toBe('');
    expect(UNKNOWN.stderr).toContain('no "## 0.0.1" section');
  });

  it('takes a version or a tag, reads CRLF, and does not read 0.7.10 as 0.7.1', () => {
    const text = '# Changelog\r\n\r\n## 0.7.10 - later\r\n\r\n- ten\r\n\r\n## 0.7.1 - date - title\r\n\r\n### Added\r\n\r\n- one\r\n\r\n## 0.7.0 - earlier\r\n';
    const want = { ok: true, section: '## 0.7.1 - date - title\n\n### Added\n\n- one\n' };
    expect(changelogSection(text, '0.7.1')).toStrictEqual(want);
    expect(changelogSection(text, 'v0.7.1')).toStrictEqual(want);
    expect(changelogSection(text, '0.7.10')).toStrictEqual({ ok: true, section: '## 0.7.10 - later\n\n- ten\n' });
    expect(changelogSection(text, '0.7.2').ok).toBe(false);
    expect(changelogSection(`${text}## 0.7.1 - again\n`, '0.7.1').ok).toBe(false);
    expect(changelogSection(text, 'latest').ok).toBe(false);
  });

  it('release.yml writes the notes with the script and hands them to gh; nothing generates them', () => {
    const code = RELEASE_YML.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    const notes = code.indexOf('node scripts/release-notes.mjs "$GITHUB_REF_NAME" > "$RUNNER_TEMP/release-notes.md"');
    const create = code.indexOf('gh release create');
    expect(notes).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(notes);
    expect(code.slice(create)).toContain('--notes-file "$RUNNER_TEMP/release-notes.md"');
    expect(code).not.toContain('--generate-notes');
    expect(code).not.toContain('--notes ');
  });
});
