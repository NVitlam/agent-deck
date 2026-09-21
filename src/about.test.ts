/**
 * v0.9.0 DoD 9.7 — About.
 *
 * The paragraph is VERBATIM from spec `Amendment 2026-09-20`, and this file is
 * what makes "verbatim" a check rather than an intention: it reads the
 * amendment off the spec and compares it to {@link ABOUT_TEXT} character for
 * character.
 *
 * The spec is a symlink into the private `lab/` tree, so on a checkout without
 * it that leg SKIPS — and says so, rather than passing quietly. Everything else
 * here runs everywhere.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ABOUT_COMMAND, ABOUT_LICENCE, ABOUT_LINKS, ABOUT_TEXT, SPONSOR_URL } from './about.js';
import { INSIGHTS_PAGE_URL } from './extension.js';
import { contentSecurityPolicy } from './bridge/html.js';

const SPEC_PATH = fileURLToPath(new URL('../agent-deck-spec.md', import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const SECURITY_PATH = fileURLToPath(new URL('../SECURITY.md', import.meta.url));

const SPEC: string | null = existsSync(SPEC_PATH) ? readFileSync(SPEC_PATH, 'utf8') : null;

/** The amendment that carries the About page since DoD 9.23. */
const AMENDMENT_HEADING = '## Amendment 2026-09-21 — About page and Insights entries';

/** That amendment alone: its heading up to the next `## ` heading. */
function amendmentOf(spec: string): string {
  const at = spec.indexOf(AMENDMENT_HEADING);
  if (at === -1) return '';
  const next = spec.indexOf('\n## ', at + 1);
  return spec.slice(at, next === -1 ? undefined : next);
}

describe('the About text', () => {
  it('is one paragraph of facts: what it does, how, and who built it', () => {
    expect(ABOUT_TEXT).toContain('Claude Code, Codex and OpenCode');
    expect(ABOUT_TEXT).toContain('read-only');
    expect(ABOUT_TEXT).toContain('makes no network calls');
    expect(ABOUT_TEXT).toContain('Nadav Vitlam');
    expect(ABOUT_TEXT).toContain('AI Specialist and Solution Architect');
    expect(ABOUT_TEXT).toContain('Israel');
    // One paragraph: no line break to reflow and nothing to wrap wrong.
    expect(ABOUT_TEXT).not.toContain('\n');
  });

  it('gives no advice — the deck’s voice states facts', () => {
    /*
     * DoD 9.23: "facts, no advice, no 'you should'". The 2026-09-20 text
     * ended "If it saves you time, you can support the project", which is a
     * sentence telling the reader what to do; the Sponsor tile carries that
     * without one. Second person at all is the tell, so "you" is refused
     * whole rather than phrase by phrase.
     */
    expect(ABOUT_TEXT).not.toMatch(/\byou\b|\byour\b|\bshould\b|\bplease\b/i);
  });

  it('the footer’s licence is the manifest’s licence', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { license?: string };
    expect(manifest.license).toBe(ABOUT_LICENCE);
  });

  // The spec lives behind a symlink into `lab/`. `skipIf` rather than a silent
  // pass: a check that skips an input says so (working-method rule 18).
  describe.skipIf(SPEC === null)('against the spec', () => {
    it('is the amendment’s text, character for character', () => {
      if (SPEC === null) return;
      const amendment = amendmentOf(SPEC);
      expect(amendment.length, 'the 0.9.0 amendment is not in the spec').toBeGreaterThan(100);
      /*
       * THE ABOUT SECTION, not the whole amendment.
       *
       * This took every `> ` line in the amendment until the 2026-09-20
       * ruling added a second blockquote (the dated note recording the
       * `ordinal` -> `seq` rename), and then concatenated the two. "The
       * blockquote" was never a well-defined thing in a document that may
       * carry several.
       */
      const aboutAt = amendment.indexOf('### About');
      expect(aboutAt, 'the amendment has no About section').toBeGreaterThan(-1);
      const nextSection = amendment.indexOf('\n### ', aboutAt + 1);
      const about = amendment.slice(aboutAt, nextSection === -1 ? undefined : nextSection);

      const quoted = about
        .split(/\r?\n/)
        .filter((line) => line.trimStart().startsWith('> '))
        .map((line) => line.trimStart().slice(2).trim())
        .join(' ');
      expect(quoted.length, 'the About section carries no blockquote').toBeGreaterThan(100);
      // EXACTLY ONE blockquote in that section, so a second one is red rather
      // than joined onto the first.
      const blocks = about.split(/\r?\n/).reduce<number>((n, line, i, all) => {
        const isQuote = line.trimStart().startsWith('> ');
        const prevQuote = i > 0 && (all[i - 1] ?? '').trimStart().startsWith('> ');
        return isQuote && !prevQuote ? n + 1 : n;
      }, 0);
      expect(blocks, 'the About section carries more than one blockquote').toBe(1);
      expect(quoted).toBe(ABOUT_TEXT);
    });

    it('the Get tile opens the Insights subpage the site amendment names', () => {
      // DoD 9.24 said the link would move to a dedicated subpage once the
      // site built one; `Amendment 2026-09-21 — Site: Insights subpage and
      // plans` is that move (DoD 9.36). Both are held: the promise, and the
      // amendment that keeps it.
      if (SPEC === null) return;
      // Whitespace collapsed: the spec wraps prose, and CRLF on disk.
      expect(amendmentOf(SPEC).replace(/\s+/g, ' ')).toContain(
        'It will point to a dedicated Insights subpage of the site once that page is built',
      );
      const heading = '## Amendment 2026-09-21 — Site: Insights subpage and plans';
      const at = SPEC.indexOf(heading);
      expect(at, 'the site amendment is not in the spec').toBeGreaterThan(-1);
      const site = SPEC.slice(at, SPEC.indexOf('\n## ', at + 1));
      expect(site).toContain(`\`${INSIGHTS_PAGE_URL}\``);
    });

    it('the four tiles are the four the amendment names, labels and urls, in order', () => {
      if (SPEC === null) return;
      const amendment = amendmentOf(SPEC);
      expect(amendment.length, 'the 2026-09-21 amendment is not in the spec').toBeGreaterThan(100);
      for (const link of ABOUT_LINKS) {
        expect(amendment, `the spec does not name ${link.url}`).toContain(link.url);
        expect(amendment, `the spec does not name the ${link.label} tile`).toContain(
          `**${link.label}**`,
        );
      }
      // Order, not just membership: the amendment lists them in one order and
      // the page shows them in one order.
      const positions = ABOUT_LINKS.map((link) => amendment.indexOf(link.url));
      expect([...positions].sort((a, b) => a - b)).toStrictEqual(positions);
    });
  });
});

describe('the links', () => {
  it('are exactly four, labelled and https, with no duplicates', () => {
    expect(ABOUT_LINKS).toHaveLength(4);
    expect(ABOUT_LINKS.map((l) => l.label)).toStrictEqual([
      'Portfolio',
      'Repository',
      'LinkedIn',
      'Sponsor',
    ]);
    for (const link of ABOUT_LINKS) {
      expect(link.url.startsWith('https://'), `${link.url} is not https`).toBe(true);
    }
    expect(new Set(ABOUT_LINKS.map((l) => l.url)).size).toBe(4);
  });

  it('the Sponsor link and the manifest sponsor are ONE url', () => {
    // Two places carry it, so something has to compare them.
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      sponsor?: { url?: string };
    };
    expect(manifest.sponsor?.url).toBe(SPONSOR_URL);
    expect(ABOUT_LINKS.find((l) => l.label === 'Sponsor')?.url).toBe(SPONSOR_URL);
  });

  it('the Repository tile is the manifest’s repository, and not the site', () => {
    // A tile called Repository that opened the project SITE would name one
    // thing and open another, which is what it did as "Project".
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      repository?: { url?: string };
    };
    const repository = ABOUT_LINKS.find((l) => l.label === 'Repository')?.url;
    expect(repository).toBe(manifest.repository?.url?.replace(/\.git$/, ''));
    expect(repository).not.toContain('github.io');
  });

  it('every link opens through the editor and nothing else', () => {
    /*
     * The claim SECURITY.md makes, checked against the source that makes it:
     * a tile reaches `vscode.env.openExternal` through `confirmThenOpen`,
     * and nothing on the way reaches fetch, http, https or XMLHttpRequest.
     *
     * A TEXT SCAN, and it stays one because the claim is about what the code
     * CANNOT reach, which no behavioural test states. The behaviour itself is
     * driven through `activate()` in `src/extension.test.ts` (a tile press
     * asks, and only Open opens) and through the mounted panel in
     * `webview/surfaces.test.ts` (a tile posts its index).
     *
     * Three halves since DoD 9.32 moved About into the one panel: the host's
     * confirm-then-open, the SURFACE, and the panel's CSP.
     */
    const read = (path: string): string =>
      readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    const source = read('./extension.ts');
    const at = source.indexOf('async function confirmThenOpen');
    expect(at, 'extension.ts has no confirmThenOpen').toBeGreaterThan(-1);
    const body = source.slice(at, at + source.slice(at).indexOf('\n}'));
    expect(body).toContain('showInformationMessage');
    expect(body).toContain('vscode.env.openExternal');
    const surface = read('../webview/AboutSurface.svelte');
    for (const banned of ['fetch(', 'XMLHttpRequest', "require('http", 'node:http', 'axios']) {
      expect(body.includes(banned), `confirmThenOpen reaches ${banned}`).toBe(false);
      expect(surface.includes(banned), `the About surface reaches ${banned}`).toBe(false);
    }
    // The surface holds no link and no anchor: a tile posts an INDEX, and an
    // `<a href>` in a webview is opened by the editor without asking.
    expect(surface).not.toMatch(/https?:\/\//);
    // Markup only: the file's own header explains the rule in prose.
    expect(surface.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/<a[\s>]/);
    // And the panel it renders in denies a socket even if something tried:
    // `default-src 'none'` with no `connect-src` of its own.
    const policy = contentSecurityPolicy({ nonce: 'a'.repeat(32), cspSource: 'vscode-resource:' });
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('connect-src');
  });

  it('SECURITY.md states the extension makes no network call, and names its proof', () => {
    const security = readFileSync(SECURITY_PATH, 'utf8');
    expect(security).toContain('The extension itself makes no network call.');
    expect(security).toContain('vscode.env.openExternal');
    // 6.D.3's rule: a named proof must exist. This file is the one named.
    expect(security).toContain('src/about.test.ts');
    expect(security).toContain('every link opens through the editor and nothing else');
  });
});

describe('the command', () => {
  it('is contributed, with the title the palette shows', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      contributes?: { commands?: { command: string; title: string; category?: string }[] };
    };
    const entry = manifest.contributes?.commands?.find((c) => c.command === ABOUT_COMMAND);
    expect(entry, `package.json contributes no ${ABOUT_COMMAND}`).toBeDefined();
    // VS Code composes "Agent Deck: About" from the two halves, and either
    // alone leaves the palette entry wrong.
    expect(entry?.category).toBe('Agent Deck');
    expect(entry?.title).toBe('About');
  });
});
