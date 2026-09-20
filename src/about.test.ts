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

import { ABOUT_COMMAND, ABOUT_LINKS, ABOUT_TEXT, SPONSOR_URL } from './about.js';

const SPEC_PATH = fileURLToPath(new URL('../agent-deck-spec.md', import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const SECURITY_PATH = fileURLToPath(new URL('../SECURITY.md', import.meta.url));

const SPEC: string | null = existsSync(SPEC_PATH) ? readFileSync(SPEC_PATH, 'utf8') : null;

describe('the About text', () => {
  it('is one paragraph, and names the person and the licence', () => {
    expect(ABOUT_TEXT).toContain('Nadav Vitlam');
    expect(ABOUT_TEXT).toContain('AI Specialist and Solution Architect');
    expect(ABOUT_TEXT).toContain('Israel');
    expect(ABOUT_TEXT).toContain('open source (MIT)');
    expect(ABOUT_TEXT).toContain('read-only by design');
    expect(ABOUT_TEXT).toContain('makes no network calls');
    expect(ABOUT_TEXT).toContain('you can support the project');
    // One paragraph: no line break to reflow and nothing to wrap wrong.
    expect(ABOUT_TEXT).not.toContain('\n');
  });

  // The spec lives behind a symlink into `lab/`. `skipIf` rather than a silent
  // pass: a check that skips an input says so (working-method rule 18).
  describe.skipIf(SPEC === null)('against the spec', () => {
    it('is the amendment’s text, character for character', () => {
      if (SPEC === null) return;
      const amendment = SPEC.slice(SPEC.indexOf('## Amendment 2026-09-20'));
      expect(amendment.length, 'the 0.9.0 amendment is not in the spec').toBeGreaterThan(100);
      // The amendment quotes the paragraph as a blockquote, one sentence per
      // line. Rebuilt into one line the way the constant holds it.
      const quoted = amendment
        .split(/\r?\n/)
        .filter((line) => line.trimStart().startsWith('> '))
        .map((line) => line.trimStart().slice(2).trim())
        .join(' ');
      expect(quoted.length, 'the amendment carries no blockquote').toBeGreaterThan(100);
      expect(quoted).toBe(ABOUT_TEXT);
    });

    it('the four links are the four the amendment names, in order', () => {
      if (SPEC === null) return;
      const amendment = SPEC.slice(SPEC.indexOf('## Amendment 2026-09-20'));
      for (const link of ABOUT_LINKS) {
        expect(amendment, `the spec does not name ${link.url}`).toContain(link.url);
      }
      // Order, not just membership: the amendment lists them in one order and
      // the modal shows them in one order.
      const positions = ABOUT_LINKS.map((link) => amendment.indexOf(link.url));
      expect([...positions].sort((a, b) => a - b)).toStrictEqual(positions);
    });
  });
});

describe('the links', () => {
  it('are exactly four, labelled and https, with no duplicates', () => {
    expect(ABOUT_LINKS).toHaveLength(4);
    expect(ABOUT_LINKS.map((l) => l.label)).toStrictEqual([
      'Website',
      'Project',
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

  it('every link opens through the editor and nothing else', () => {
    // The claim SECURITY.md makes, checked against the source that makes it:
    // `showAbout` reaches `vscode.env.openExternal` and no fetch, no http, no
    // https module, no XMLHttpRequest.
    const source = readFileSync(fileURLToPath(new URL('./extension.ts', import.meta.url)), 'utf8');
    const about = source.slice(source.indexOf('export async function showAbout'));
    const body = about.slice(0, about.indexOf('\n}'));
    expect(body).toContain('vscode.env.openExternal');
    for (const banned of ['fetch(', 'XMLHttpRequest', "require('http", 'node:http', 'axios']) {
      expect(body.includes(banned), `showAbout reaches ${banned}`).toBe(false);
    }
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
