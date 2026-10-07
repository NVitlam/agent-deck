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
import { MENU_COMMANDS as SIDEBAR_MENU } from '../view/controls.js';
import { COST_SOURCE_LABELS } from '../../webview/stats/layout.js';
import { ABOUT_LINKS, INSIGHTS_PAGE_URL, SPONSOR_URL } from '../about.js';

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
/** v0.9.0 DoD 9.34: the Insights subpage. */
const INSIGHTS_PAGE = readText('site/insights.html');
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
/**
 * The README as a reader sees it: bold markers dropped, whitespace collapsed.
 * Since the ruling of 2026-09-29 the README carries the statements the
 * redesigned index no longer makes.
 */
const README_TEXT = flat(README.replace(/\*\*/g, ''));

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

describe('6.D.2 (a) — package.json, the CHANGELOG and the README state one version', () => {
  it('the CHANGELOG top heading is the manifest version', () => {
    const top = /^## (\S+) /m.exec(CHANGELOG)?.[1];
    expect(top).toBe(MANIFEST.version);
  });

  it('the README states no version, the same rule as the page', () => {
    // Ruling of 2026-10-07 (0.9.3.D), superseding 2026-09-29: the approved
    // README top section carries no version line, so neither the README nor
    // the page states a version, and neither can go stale. The CHANGELOG
    // heading above is the one public statement beside the listing.
    expect(README).not.toMatch(/^VS Code extension · Open source · /m);
    // As a whole version: `0.7.1` inside `0.7.10` or `10.7.1` is not a
    // statement of it.
    const whole = new RegExp(`(?<![\\d.])${escapeRegExp(MANIFEST.version)}(?![\\d.])`, 'g');
    expect(README.match(whole) ?? []).toHaveLength(0);
    expect(PAGE.match(whole) ?? []).toHaveLength(0);
    expect(INSIGHTS_PAGE.match(whole) ?? []).toHaveLength(0);
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
  /** A phrase a reader of the README would search for. */
  readonly keyword: string;
  /** Present in README.md. Every row is `true` at commit; a row that cannot be is reported, not deleted. */
  readonly readme: boolean;
  // The `site` column (present in site/index.html's text) moved to the README
  // with the ruling of 2026-09-29: the redesigned index lists no features.
}

/**
 * THE TABLE IS THE ASSERTION, reviewed by hand once (DoD 6.D.2 (b)). One row per
 * `### Added` bullet of the two entries, in CHANGELOG order.
 */
const KEYWORD_TABLE: readonly KeywordRow[] = [
  { version: '0.7.0', bullet: 'A Stats view, and a local history behind it.', keyword: 'Stats view', readme: true },
  { version: '0.7.0', bullet: 'Tools that stop making progress are shown as stalled.', keyword: 'stalled', readme: true },
  { version: '0.7.0', bullet: 'The Stats view', keyword: 'Loops & churn', readme: true },
  { version: '0.7.0', bullet: 'The history stays on your machine.', keyword: 'Clear Stats History', readme: true },
  { version: '0.7.0', bullet: 'Your own prices, for a cost the engine does not report.', keyword: 'agentDeck.pricing', readme: true },
  { version: '0.7.0', bullet: 'An extension API.', keyword: 'extension API', readme: true },
  { version: '0.7.0', bullet: 'An activity-bar entry.', keyword: 'activity bar', readme: true },
  { version: '0.7.0', bullet: 'The canvas re-fits itself.', keyword: 're-fit', readme: true },
  {
    version: '0.7.0',
    bullet: 'Stalled `AskUserQuestion` and `ExitPlanMode` calls read "waiting on you".',
    keyword: 'waiting on you',
    readme: true,
  },
  { version: '0.7.0', bullet: 'The tool-call drawer follows the latest call', keyword: 'follows new calls', readme: true },
  {
    version: '0.7.1',
    bullet: "Claude Code's OpenTelemetry export, received — optional, off by default.",
    keyword: 'OpenTelemetry',
    readme: true,
  },
  {
    version: '0.7.1',
    bullet: 'A cost for Claude Code sessions, estimated by Claude Code.',
    keyword: 'estimated by Claude Code',
    readme: true,
  },
  { version: '0.7.1', bullet: 'Tool durations where the session states none', keyword: 'tool duration', readme: true },
  { version: '0.7.1', bullet: '`agentDeck.telemetry.enabled`', keyword: 'agentDeck.telemetry.enabled', readme: true },
  {
    version: '0.7.1',
    bullet: "Telemetry figures on the Agent Deck output channel's counters line",
    keyword: 'unmatched',
    readme: true,
  },
  // v0.8.0 Phase 7, DoD 7.D — reviewed by hand against the entry, one row per bullet.
  { version: '0.8.0', bullet: 'A Tools part in the Stats view.', keyword: 'longest call', readme: true },
  {
    version: '0.8.0',
    bullet: "A session's own timings in the Tokens part.",
    keyword: 'time to the first tool call',
    readme: true,
  },
  { version: '0.8.0', bullet: 'Tokens a minute in Trends', keyword: 'tokens a minute', readme: true },
  {
    version: '0.8.0',
    bullet: 'A time and a gap on every row of the tool-call drawer.',
    keyword: 'gap between calls',
    readme: true,
  },
  {
    version: '0.8.0',
    bullet: 'Subagents whose spawning call has no result',
    keyword: 'spawning call has no result',
    readme: true,
  },
  { version: '0.8.0', bullet: 'A Tweaks tab in the sidebar', keyword: 'Tweaks', readme: true },
  { version: '0.8.0', bullet: 'Oversize Codex transcripts are read in part.', keyword: 'read in part', readme: true },
  { version: '0.8.0', bullet: '`foreign` on the counters line.', keyword: 'foreign', readme: true },
];

describe('6.D.2 (b) — every Added bullet of 0.7.0, 0.7.1 and 0.8.0 is on the README', () => {
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
    '$keyword — measured presence equals the table, and the table says present',
    (row) => {
      expect(hasKeyword(README, row.keyword)).toBe(row.readme);
      expect(row.readme, `unsatisfied row: ${row.bullet}`).toBe(true);
    },
  );

  it('the keyword match is a word start, so it cannot be satisfied inside another word', () => {
    expect(hasKeyword('Install the hook', 'stall')).toBe(false);
    expect(hasKeyword('The canvas re-fits', 're-fit')).toBe(true);
    expect(hasKeyword('<b>Loops &amp; churn</b>', 'Loops & churn')).toBe(false);
    expect(hasKeyword(pageText('<b>Loops &amp; churn</b>'), 'Loops & churn')).toBe(true);
  });
});

/** The `- ` items of the list that follows a `**heading**` line in the README. */
function readmeListAfter(heading: string): string[] {
  const at = README.indexOf(`\n**${heading}**\n\n`);
  if (at === -1) return [];
  const lines = README.slice(at).split('\n').slice(3);
  const items: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('- ')) break;
    items.push(line.slice(2));
  }
  return items;
}

/*
 * Ruling of 2026-09-29: the redesigned index no longer describes the feature
 * set, so these statements are asserted on the README, which carries them
 * (the menu sentence, the socket sentence and the never-list added there word
 * for word from the old page).
 */
describe('6.D.1 — the README describes 0.7.0 and 0.7.1 as shipped', () => {
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
      expect(README_TEXT, phrase).toContain(phrase);
    }
  });

  it('lists the sidebar menu as src/view/controls.ts declares it', () => {
    for (const entry of SIDEBAR_MENU) expect(README_TEXT, entry.label).toContain(entry.label);
    expect(SIDEBAR_MENU.length).toBeGreaterThan(0);
    // IN ORDER, not only present (verifier round 9.33, C4: the list reversed
    // on the page left this green). The README lists them once, in brackets
    // after "Menu".
    const list = /Menu \(([^)]*)\)/.exec(README_TEXT)?.[1] ?? '';
    expect(list.split(',').map((label) => label.trim())).toStrictEqual(
      SIDEBAR_MENU.map((entry) => entry.label),
    );
  });

  it('"What it never does" is the four sentences it was, and nothing was added to it', () => {
    const items = readmeListAfter('What it never does');
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
    expect(README_TEXT).not.toMatch(/outbound requests/i);
    expect(README_TEXT).toContain('Every socket it opens is on 127.0.0.1.');
  });
});

// ---------------------------------------------------------------------------
// (c) images
// ---------------------------------------------------------------------------

/**
 * A PNG's pixel size from its IHDR chunk, or a GIF's from its logical screen
 * descriptor (ruling of 2026-09-29: the hero is a GIF); `null` for anything else.
 */
function imageSize(file: string): { width: number; height: number } | null {
  const bytes = readFileSync(file);
  const gif = bytes.toString('latin1', 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  const signature = '89504e470d0a1a0a';
  if (bytes.subarray(0, 8).toString('hex') !== signature) return null;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('6.D.2 (c) — every image either page references exists, is non-empty, and is the size the page says', () => {
  const readmeImages = [...README.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
    .map((m) => m[1] ?? '')
    .filter((link) => !/^https?:/.test(link));
  // Both pages since v0.9.0 DoD 9.34.
  const pageImages = [...(PAGE + INSIGHTS_PAGE).matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);

  it('README: every local image is a non-empty file', () => {
    expect(readmeImages.length).toBeGreaterThan(0);
    for (const link of readmeImages) {
      const path = join(ROOT, link);
      expect(existsSync(path), `${link} is missing`).toBe(true);
      expect(statSync(path).size, `${link} is empty`).toBeGreaterThan(0);
    }
  });

  it('page: every <img> names a non-empty PNG or GIF under site/, with width and height equal to its pixels', () => {
    expect(pageImages.length).toBeGreaterThan(0);
    for (const tag of pageImages) {
      const src = /\bsrc="([^"]+)"/.exec(tag)?.[1] ?? '';
      const width = Number(/\bwidth="(\d+)"/.exec(tag)?.[1]);
      const height = Number(/\bheight="(\d+)"/.exec(tag)?.[1]);
      const path = join(ROOT, 'site', src);
      expect(existsSync(path), `site/${src} is missing`).toBe(true);
      expect(statSync(path).size, `site/${src} is empty`).toBeGreaterThan(0);
      expect(imageSize(path), `site/${src}: the width/height attributes are not the file's`).toStrictEqual({
        width,
        height,
      });
    }
  });

  it('reads a PNG and a GIF size, and reads nothing from a file that is neither', () => {
    // Vacuity control for the comparison above: a wrong reader returning the
    // attributes back would pass it.
    expect(imageSize(join(ROOT, 'media', 'icon.png'))?.width).toBeGreaterThan(0);
    expect(imageSize(join(ROOT, 'site', 'media', 'agent-deck-hero.gif'))).toStrictEqual({ width: 1100, height: 742 });
    // 0.9.3.D: the README's hero is the same GIF, and its diagram is 2000 x 1158.
    expect(imageSize(join(ROOT, 'media', 'agent-deck-hero.gif'))).toStrictEqual({ width: 1100, height: 742 });
    expect(imageSize(join(ROOT, 'media', 'architecture.png'))).toStrictEqual({ width: 2000, height: 1158 });
    expect(imageSize(join(ROOT, 'media', 'activity-icon.svg'))).toBeNull();
    // Both pages' images are counted, not only the index's.
    expect(pageImages.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// (d) listing fields
// ---------------------------------------------------------------------------

/**
 * The keywords the user locked. 6.D locked five; the 0.9.3.D listing copy
 * replaced the list with eight, and it is the whole approved list that is
 * locked now. `manifest.test.ts` pins the same list and its length.
 */
const LOCKED_KEYWORDS = [
  'observability',
  'agents',
  'subagents',
  'ai agents',
  'claude code',
  'codex',
  'opencode',
  'monitor',
] as const;

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

/* ------------------------------------------------------------------------ *
 * v0.9.0 DoD 9.8 — the plans section, and the sponsor url across surfaces
 * ------------------------------------------------------------------------ */

describe('9.35 / 9.37 — the plans, on the index and on the Insights subpage', () => {
  /**
   * The six checkouts, as spec `Amendment 2026-09-21 — Site: Insights subpage
   * and plans` lists them, each with its plan and its amount.
   *
   * WRITTEN OUT, not read off the page: a list derived from the page it checks
   * can only ever agree with itself. A price or a checkout changes when this
   * table is edited in the same commit, deliberately.
   */
  const CHECKOUTS = [
    ['Pay once', '1 month', '$10', 'https://buy.polar.sh/polar_cl_CSq61gqBDh6m23MVgywHa5ToM4fqELxhN2Ihz3N0Pik'],
    ['Pay once', '6 months', '$50', 'https://buy.polar.sh/polar_cl_GCvmaLUxGjyRTAzCEFHEwWr7E3dPXGuHGF7x13OWJtR'],
    ['Pay once', '1 year', '$100', 'https://buy.polar.sh/polar_cl_kt7PQf2lHFd4MKLuIk0rQTQnTBydOB073e1Vz1UryGH'],
    ['Subscribe', 'Monthly', '$10', 'https://buy.polar.sh/polar_cl_jrxo7iIweohunHx0Tveoqfk7yWQ4YSmrHAWB22B04IC'],
    ['Subscribe', 'Every 6 months', '$50', 'https://buy.polar.sh/polar_cl_rrZE2uiaJHdSWORJ0zqPQxAIACs09t50dXwwO05Zwhb'],
    ['Subscribe', 'Yearly', '$100', 'https://buy.polar.sh/polar_cl_otLLhZiBYwb24LZmJNCd3U5VYp8hC3gFcs0Kk4WaZ7J'],
  ] as const;

  const count = (text: string, needle: string): number => text.split(needle).length - 1;

  it('every checkout link is on the subpage exactly once, and on the index not at all', () => {
    expect(new Set(CHECKOUTS.map((c) => c[3])).size).toBe(6);
    for (const [, , , url] of CHECKOUTS) {
      expect(count(INSIGHTS_PAGE, url), url).toBe(1);
      expect(count(PAGE, url), url).toBe(0);
    }
    // ...and there is no seventh checkout the table does not name.
    expect(INSIGHTS_PAGE.match(/https:\/\/buy\.polar\.sh\/[^"]+/g)).toHaveLength(6);
  });

  // The plan-card markup check was retired by the ruling of 2026-09-29; the
  // redesigned subpage is a price table, held to its checkouts below.

  it('each price row states the amount of both its checkouts, and the rows cover all six', () => {
    const amountOf = new Map<string, string>(CHECKOUTS.map((c) => [c[3], c[2]]));
    const rows = [...INSIGHTS_PAGE.matchAll(/<div class="row" role="row">([\s\S]*?)<\/div>/g)].map((m) => m[1] ?? '');
    expect(rows).toHaveLength(3);
    const seen: string[] = [];
    for (const row of rows) {
      const price = /<span class="price" role="cell">(\$\d+)<\/span>/.exec(row)?.[1];
      const urls = [...row.matchAll(/href="(https:\/\/buy\.polar\.sh\/[^"]+)"/g)].map((m) => m[1] ?? '');
      expect(urls, row).toHaveLength(2);
      for (const url of urls) expect(amountOf.get(url), `${url} sits under ${String(price)}`).toBe(price);
      seen.push(...urls);
    }
    expect(seen.sort()).toStrictEqual(CHECKOUTS.map((c) => c[3]).sort());
  });

  it('the amounts shown on the site are exactly the six checkout products’ amounts, and nothing else', () => {
    // Ruling of 2026-09-29: across the site, not per page — the redesigned
    // index shows no price at all.
    const shown = new Set((PAGE + INSIGHTS_PAGE).match(/\$\d+/g) ?? []);
    expect([...shown].sort()).toStrictEqual([...new Set(CHECKOUTS.map((c) => c[2]))].sort());
    expect(PAGE.match(/\$\d+/g) ?? []).toStrictEqual([]);
  });

  it('the README states the three amounts as the only prices, and the one line under the plans, verbatim', () => {
    // Moved to the README by the ruling of 2026-09-29, word for word as the
    // old pages had them. Whole-dollar amounts only: the pricing section's
    // worked example (`$0.0739` for a token count) is a per-token cost, not a
    // product price.
    expect([...new Set(README.match(/\$\d+(?![\d.])/g) ?? [])].sort()).toStrictEqual(['$10', '$100', '$50']);
    expect(README).toContain('$0.0739');
    expect(README).toContain(
      'Every plan is the same product; a subscription renews your key automatically, a one-time purchase does not.',
    );
  });

  it('no placeholder and no lifetime plan survives, on either page', () => {
    for (const html of [PAGE, INSIGHTS_PAGE]) {
      for (const gone of ['POLAR_URL', 'PRICE_MONTHLY', 'PRICE_YEARLY', 'PRICE_LIFETIME']) {
        expect(html, gone).not.toContain(gone);
      }
      expect(html).not.toMatch(/lifetime/i);
    }
    // Control: the pattern finds what was shipping before this delta.
    expect(/lifetime/i.test('<b>Lifetime, early bird</b>')).toBe(true);
  });

  it('the README links the Insights page from its Insights section', () => {
    // The index's nav and card links moved to the README with the ruling of
    // 2026-09-29; the index still links the subpage, from its teaser.
    const section = mdSection(README, '## Insights');
    expect(section).toContain(`<${INSIGHTS_PAGE_URL}>`);
    expect(PAGE).toMatch(/<a class="btn" href="insights\.html">/);
  });

  it('links Sponsors at the same url the About entry and the manifest use, on both pages', () => {
    for (const html of [PAGE, INSIGHTS_PAGE]) expect(html).toContain(SPONSOR_URL);
    const sponsor = (JSON.parse(readText('package.json')) as { sponsor?: { url?: string } })
      .sponsor?.url;
    expect(sponsor).toBe(SPONSOR_URL);
    expect(ABOUT_LINKS.find((link) => link.label === 'Sponsor')?.url).toBe(SPONSOR_URL);
  });

  it('the subpage links the support address in its footer, and the README carries the never-list verbatim', () => {
    const footer = /<footer\b[\s\S]*?<\/footer>/.exec(INSIGHTS_PAGE)?.[0] ?? '';
    expect(footer).toContain('<a href="mailto:support@agent-deck.app">support@agent-deck.app</a>');
    // agent-deck-insights-spec.md §A: "What is never done: reading
    // transcripts, reading files, network calls from the extension, writing
    // under any engine's data directory." Four items, in its order — on the
    // README since the ruling of 2026-09-29.
    expect(readmeListAfter('Never')).toStrictEqual([
      'reading transcripts',
      'reading files',
      'network calls from the extension',
      "writing under any engine's data directory",
    ]);
  });

  it('says Agent Deck itself is unaffected: on the README in full, and on both pages in their own words', () => {
    expect(README).toContain(
      'Agent Deck itself is unaffected: no feature moves behind a plan, and nothing it already does depends on Insights being installed.',
    );
    expect(INSIGHTS_PAGE).toContain('nothing in it moves behind a plan');
    // 0.9.3.D: the approved index says it in these words.
    expect(PAGE).toContain('Agent Deck stays free.');
  });
});

