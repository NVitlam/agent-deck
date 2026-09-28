// No badge service, and no image from a host this project does not own, on any
// page a reader opens: README.md (the Marketplace listing), CHANGELOG.md,
// SECURITY.md and the site's HTML pages.
//
// WHY, 0.9.1: the 0.9.0 listing rendered "retired badge" beside the name.
// README.md embedded an img.shields.io/visual-studio-marketplace badge, and
// shields.io retired that family: the URL still answers 200, with an image of
// the words "retired badge". Nothing here could see it, because the only rule
// about README images EXEMPTED that host (readme.test.ts, until 0.9.1). A
// third-party image is a render this repository does not control, so the
// rule is an allow-list of hosts that are the project's own, never a
// deny-list of the hosts that have already failed.
//
// Allowed image sources: `media/` relative to the page (the repository's own
// media for the documents, `site/media/` for the pages), or
// https://agent-deck.app, or github.com and raw.githubusercontent.com under
// the repository's owner. Anything else fails, and so does the string
// img.shields.io anywhere in these files, image or not.
//
// The owner is READ from package.json's repository.url, never written here:
// the privacy sweep allows the GitHub handle in a short list of files and
// this is not one of them.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const DOCUMENTS = ['README.md', 'CHANGELOG.md', 'SECURITY.md'] as const;
const PAGES = readdirSync(join(ROOT, 'site'))
  .filter((name) => name.endsWith('.html'))
  .sort()
  .map((name) => `site/${name}`);
const FILES = [...DOCUMENTS, ...PAGES];

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  repository: { url: string };
};
const OWNER = /^https:\/\/github\.com\/([^/]+)\//.exec(manifest.repository.url)?.[1] ?? '';

const OWN_HOSTS: readonly RegExp[] = [
  /^https:\/\/agent-deck\.app(\/|$)/i,
  new RegExp(`^https://github\\.com/${OWNER}/`, 'i'),
  new RegExp(`^https://raw\\.githubusercontent\\.com/${OWNER}/`, 'i'),
];

/** Every image source a Markdown or HTML text embeds, in order of appearance. */
function imageSources(text: string): string[] {
  const out: string[] = [];
  // Markdown inline image: ![alt](src "title") or ![alt](<src>)
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) out.push(m[1] ?? '');
  // Markdown reference image: ![alt][ref] or ![alt][] or ![ref], resolved
  // through the [ref]: src definitions.
  const defs = new Map<string, string>();
  for (const m of text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s|$)/gm)) {
    defs.set((m[1] ?? '').toLowerCase(), m[2] ?? '');
  }
  for (const m of text.matchAll(/!\[([^\]]*)\](?:\[([^\]]*)\])?(?!\()/g)) {
    const key = (m[2] !== undefined && m[2] !== '' ? m[2] : (m[1] ?? '')).toLowerCase();
    const src = defs.get(key);
    if (src !== undefined) out.push(src);
  }
  // HTML: <img src>, <img srcset>, <source src|srcset>, <image href> (SVG).
  for (const tag of text.matchAll(/<(img|source|image)\b[^>]*>/gi)) {
    const body = tag[0];
    for (const attr of body.matchAll(/\s(src|srcset|href|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
      const name = (attr[1] ?? '').toLowerCase();
      if (name === 'srcset') {
        for (const part of value.split(',')) {
          const url = part.trim().split(/\s+/)[0];
          if (url) out.push(url);
        }
      } else {
        out.push(value);
      }
    }
  }
  return out;
}

/** Null when the source is allowed; otherwise the reason it is not. */
function refusal(src: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) {
    return OWN_HOSTS.some((re) => re.test(src)) ? null : 'a host this project does not own';
  }
  const path = src.replace(/^\.\//, '');
  return path.startsWith('media/') && !path.split('/').includes('..')
    ? null
    : 'a local path outside media/';
}

describe('no page a reader opens embeds a badge service or a foreign image', () => {
  it('covers the three documents and at least the three site pages', () => {
    expect(PAGES).toEqual(expect.arrayContaining(['site/index.html', 'site/insights.html', 'site/thanks.html']));
    expect(FILES.length).toBe(DOCUMENTS.length + PAGES.length);
  });

  for (const file of FILES) {
    it(`${file} names img.shields.io nowhere`, () => {
      expect(readFileSync(join(ROOT, file), 'utf8')).not.toContain('img.shields.io');
    });

    it(`${file} embeds images only from media/ or the project's own hosts`, () => {
      const bad = imageSources(readFileSync(join(ROOT, file), 'utf8'))
        .map((src) => ({ src, why: refusal(src) }))
        .filter((r) => r.why !== null);
      expect(bad).toEqual([]);
    });
  }

  it('the extractor is not vacuous: README and the index page do carry images', () => {
    expect(imageSources(readFileSync(join(ROOT, 'README.md'), 'utf8')).length).toBeGreaterThan(0);
    expect(imageSources(readFileSync(join(ROOT, 'site/index.html'), 'utf8')).length).toBeGreaterThan(0);
  });

  it('vacuity control: the 0.9.0 badge, and every other shape, is refused', () => {
    const badge =
      '[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/nvitlam.agent-deck)](https://marketplace.visualstudio.com/items?itemName=nvitlam.agent-deck)';
    expect(imageSources(badge)).toEqual(['https://img.shields.io/visual-studio-marketplace/v/nvitlam.agent-deck']);
    const planted = [
      badge,
      '![x][b]\n\n[b]: https://badgen.net/vs-marketplace/v/x',
      '<img alt="x" src="https://example.com/a.png">',
      "<img src='//cdn.example.com/a.png'>",
      '<picture><source srcset="media/a.png 1x, https://example.com/b.png 2x"></picture>',
      '![x](https://github.com/someoneelse/repo/raw/main/a.png)',
      '![x](../private/a.png)',
      '![x](media/../../a.png)',
      '![x](data:image/png;base64,AAAA)',
    ];
    for (const text of planted) {
      expect(imageSources(text).some((src) => refusal(src) !== null), text).toBe(true);
    }
  });

  it('control: the allowed shapes pass', () => {
    const allowed = [
      '![x](media/deck.png)',
      '![x](./media/deck.png "title")',
      '<img src="media/tree.png" width="10">',
      '![x](https://agent-deck.app/media/tree.png)',
      `![x](https://github.com/${OWNER}/agent-deck/raw/main/media/deck.png)`,
      `![x](https://raw.githubusercontent.com/${OWNER}/agent-deck/main/media/deck.png)`,
    ];
    // The owner was read, so the two GitHub rows test a real owner.
    expect(OWNER).toMatch(/^[A-Za-z0-9-]+$/);
    for (const text of allowed) {
      const srcs = imageSources(text);
      expect(srcs.length, text).toBe(1);
      expect(refusal(srcs[0] ?? ''), text).toBeNull();
    }
  });
});
