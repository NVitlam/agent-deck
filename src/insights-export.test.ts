// @vitest-environment jsdom
/**
 * Insights report EXPORT — v0.9.0 DoD 9.47, spec `Amendment 2026-09-23 —
 * Paid Insights surface, export, provider v1 growth`.
 *
 * What is held here:
 *
 *  1. GOLDENS PER FORMAT FROM EVERY FIXTURE SET: each set of
 *     `src/insights-report.testkit.ts` — the four the surface goldens render,
 *     and a hostile one — written as HTML, Markdown and plain text, against
 *     `webview/goldens/export/`. Regenerate with
 *     `AGENT_DECK_UPDATE_EXPORT_GOLDENS=1`.
 *  2. NO EXTERNAL RESOURCE: every HTML golden PARSED (jsdom) and searched for
 *     an element that loads anything, an attribute that names anything, and
 *     a stylesheet that imports or points anywhere — the hostile set's
 *     `<img>`, `<script>`, `<iframe>` and `<link>` included, which must reach
 *     the page as TEXT. The CSP meta is present and forbids every load.
 *  3. MARKDOWN cannot be made to fetch: provider text is escaped, so no
 *     image, link, autolink or raw HTML survives into the file as syntax.
 *  4. The three formats say what the PREVIEW says, in its order — each is
 *     built from `reportOf`, the preview's own function.
 *  5. File names, never-overwrite naming, and the G1 path check.
 *  6. No network: the module imports nothing that could make a call.
 *
 * The dialogs, the clipboard and the write are driven end to end through the
 * `vscode` double in `extension.test.ts`; this file is the pure half.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FindingSetView } from './model/events.js';
import {
  EXPORT_CSP,
  EXPORT_STYLE,
  escapeHtml,
  escapeMarkdown,
  exportFileName,
  exportHtml,
  exportMarkdown,
  exportReport,
  exportText,
  exportTextBatch,
  formatOf,
  freeName,
  observedRootOf,
} from './insights-export.js';
import { reportOf } from './insights-report.js';
import { viewOfFindingSet } from './insights-provider.js';
import { HOSTILE_REFUSED_SET, HOSTILE_SET, REPORT_SETS } from './insights-report.testkit.js';

const GOLDEN_DIR = resolve('webview/goldens/export');
const UPDATING = process.env['AGENT_DECK_UPDATE_EXPORT_GOLDENS'] === '1';

/** Every fixture set, by the name its goldens carry. */
const ALL_SETS: readonly [string, FindingSetView][] = [
  ...Object.entries(REPORT_SETS),
  ['hostile', HOSTILE_SET],
  ['hostile-refused', HOSTILE_REFUSED_SET],
];

/**
 * Every golden: each set as the check passed it whole, and one set with a
 * DROP COUNT (verifier round 9.48, D3) — the report states the drop in every
 * format, as the preview does.
 */
const ALL_EXPORTS: readonly [string, FindingSetView, number][] = [
  ...ALL_SETS.map(([name, set]): [string, FindingSetView, number] => [name, set, 0]),
  ['ok-dropped', REPORT_SETS.ok, 2],
];

const FORMATS = [
  ['html', 'html'],
  ['markdown', 'md'],
  ['text', 'txt'],
] as const;

function golden(name: string, actual: string): void {
  const file = resolve(GOLDEN_DIR, name);
  if (UPDATING) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, actual);
  }
  expect(existsSync(file), `webview/goldens/export/${name} is missing`).toBe(true);
  // Line endings normalised, for a CRLF checkout (the goldens-check lesson).
  expect(actual, `webview/goldens/export/${name} is stale`).toBe(
    readFileSync(file, 'utf8').replace(/\r\n/g, '\n'),
  );
}

/* ------------------------------------------------------------------------ *
 * 1. Goldens
 * ------------------------------------------------------------------------ */

describe('export goldens — every fixture set, every format', () => {
  it('the hostile set is one the CHECK admits: markup is text, not a refusal', () => {
    const checked = viewOfFindingSet(HOSTILE_SET);
    expect(checked.dropped).toBe(0);
    expect(checked.value).toStrictEqual(HOSTILE_SET);
  });

  for (const [name, set, dropped] of ALL_EXPORTS) {
    for (const [format, ext] of FORMATS) {
      it(`${name} as ${format} matches webview/goldens/export/${name}.${ext}`, () => {
        golden(`${name}.${ext}`, exportReport(set, format, dropped));
      });
    }
  }

  it('D3: a DROP is stated in every format, in the words the preview uses — and only when there is one', () => {
    const line = '2 values from this report did not pass the check and are not shown';
    expect(reportOf(REPORT_SETS.ok, 2).dropped).toBe(line);
    expect(exportText(REPORT_SETS.ok, 2)).toContain(line);
    expect(exportMarkdown(REPORT_SETS.ok, 2)).toContain(line);
    expect(parse(exportHtml(REPORT_SETS.ok, 2)).body.textContent).toContain(line);
    for (const text of [exportText(REPORT_SETS.ok), exportMarkdown(REPORT_SETS.ok), exportHtml(REPORT_SETS.ok)]) {
      expect(text).not.toContain('did not pass the check');
    }
  });

  it('the goldens are not being written by this run', () => {
    expect(UPDATING, 'AGENT_DECK_UPDATE_EXPORT_GOLDENS is set: the goldens were REWRITTEN').toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. No external resource
 * ------------------------------------------------------------------------ */

/** Elements that load, embed or submit something. */
const LOADING_ELEMENTS = [
  'script', 'img', 'iframe', 'frame', 'link', 'object', 'embed', 'video', 'audio',
  'source', 'track', 'picture', 'base', 'form', 'input', 'svg', 'image', 'use', 'portal',
];

/** Attributes that name a resource, anywhere on any element. */
const RESOURCE_ATTRIBUTES = [
  'src', 'href', 'srcset', 'poster', 'data', 'action', 'background', 'formaction',
  'xlink:href', 'ping', 'manifest', 'cite', 'longdesc', 'codebase', 'archive',
];

/*
 * The host project carries no DOM lib (it must not: the host bundle runs
 * without one), so the few members this test reads are typed here, and the
 * parser is jsdom's, from the environment the docblock above selects.
 */
interface ParsedElement {
  readonly tagName: string;
  readonly textContent: string | null;
  getAttributeNames(): string[];
  getAttribute(name: string): string | null;
}
interface ParsedDocument {
  readonly body: { readonly textContent: string | null };
  querySelectorAll(selector: string): Iterable<ParsedElement> & { readonly length: number };
  querySelector(selector: string): ParsedElement | null;
}
const HtmlParser = (globalThis as unknown as {
  DOMParser: new () => { parseFromString(html: string, type: 'text/html'): ParsedDocument };
}).DOMParser;

/** The page, parsed by the environment's own HTML parser. Never run: no script, no load. */
function parse(html: string): ParsedDocument {
  return new HtmlParser().parseFromString(html, 'text/html');
}

/** Every way a page could reach something, or `[]`. */
function externalResources(html: string): string[] {
  const document = parse(html);
  const found: string[] = [];
  for (const tag of LOADING_ELEMENTS) {
    for (const element of document.querySelectorAll(tag)) found.push(`<${element.tagName.toLowerCase()}>`);
  }
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of element.getAttributeNames()) {
      if (RESOURCE_ATTRIBUTES.includes(attribute.toLowerCase())) found.push(`${element.tagName}[${attribute}]`);
      if (attribute.toLowerCase().startsWith('on')) found.push(`${element.tagName}[${attribute}]`);
      if (attribute.toLowerCase() === 'style' && /url\(|@import/iu.test(element.getAttribute(attribute) ?? '')) {
        found.push(`${element.tagName}[style url]`);
      }
    }
  }
  for (const style of document.querySelectorAll('style')) {
    if (/url\(|@import|image-set\(/iu.test(style.textContent ?? '')) found.push('<style> url/@import');
  }
  const refresh = document.querySelector('meta[http-equiv="refresh" i]');
  if (refresh !== null) found.push('meta refresh');
  return found;
}

describe('the HTML export loads nothing — parsed, not grepped', () => {
  for (const [name, set] of ALL_SETS) {
    it(`${name}: no loading element, no resource attribute, no url in its style; the CSP forbids every load`, () => {
      const html = exportHtml(set);
      expect(externalResources(html)).toStrictEqual([]);
      const document = parse(html);
      const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      expect(csp?.getAttribute('content')).toBe(EXPORT_CSP);
      expect(EXPORT_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'");
      expect(document.querySelectorAll('style')).toHaveLength(1);
      expect(document.querySelectorAll('script')).toHaveLength(0);
    });
  }

  it('the scan can fail: a page that DOES load something is caught, each way', () => {
    const planted = [
      '<img src="https://example.invalid/x.png">',
      '<a href="https://example.invalid/">x</a>',
      '<div style="background:url(https://example.invalid/b.png)"></div>',
      '<style>@import "https://example.invalid/c.css";</style>',
      '<p onclick="x()">x</p>',
      '<meta http-equiv="refresh" content="0;url=https://example.invalid/">',
    ];
    for (const html of planted) expect(externalResources(`<!DOCTYPE html>${html}`), html).not.toStrictEqual([]);
  });

  it('W1: the hostile REFUSED set’s step and reason reach the page as TEXT, and Markdown escapes them', () => {
    const document = parse(exportHtml(HOSTILE_REFUSED_SET));
    const text = document.body.textContent ?? '';
    const refusal = HOSTILE_REFUSED_SET.refusal;
    expect(refusal).toBeDefined();
    expect(text).toContain(refusal?.step ?? '');
    expect(text).toContain(refusal?.reason.split('\n')[0] ?? '');
    const md = exportMarkdown(HOSTILE_REFUSED_SET);
    expect(md).toContain('## Refused at step: \\<img src=x onerror=y\\> \\!\\[s\\](https://example.invalid/s.png)');
    expect(md).toContain('\\<script src="https://example.invalid/r.js"\\>\\</script\\>');
  });

  it('the hostile set’s markup reaches the page as TEXT, whole', () => {
    const document = parse(exportHtml(HOSTILE_SET));
    const text = document.body.textContent ?? '';
    const finding = HOSTILE_SET.findings[0];
    expect(finding).toBeDefined();
    for (const piece of [
      finding?.action.lead ?? '',
      finding?.cause ?? '',
      '<b>label</b>',
      'repo/<img src=x onerror=y>.md',
    ]) {
      expect(text, piece).toContain(piece);
    }
  });

  it('the stylesheet is deck-neutral and self-contained', () => {
    expect(EXPORT_STYLE).not.toMatch(/url\(|@import|@font-face|https?:/iu);
    expect(EXPORT_STYLE).toContain('prefers-color-scheme: dark');
  });

  it('escapeHtml makes every markup character inert, in content and in attributes', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});

/* ------------------------------------------------------------------------ *
 * 3. Markdown cannot be made to fetch
 * ------------------------------------------------------------------------ */

describe('the Markdown export escapes provider text', () => {
  it('no image, link, autolink or raw HTML survives from the hostile set as syntax', () => {
    const md = exportMarkdown(HOSTILE_SET);
    // Every one of these is the provider's; none may appear unescaped.
    // UNESCAPED, i.e. not preceded by a backslash: the escaped form `<img`
    // contains `<img`, and is exactly what must be there instead.
    for (const raw of ['![x](', '[link](', '<img', '<script', '<iframe', '<link', '<https://', '<b>']) {
      // A match at the start, or after anything but a backslash.
      const unescaped = (text: string): boolean => {
        for (let at = text.indexOf(raw); at >= 0; at = text.indexOf(raw, at + 1)) {
          if (at === 0 || text[at - 1] !== String.fromCharCode(92)) return true;
        }
        return false;
      };
      expect(unescaped(md), raw).toBe(false);
    }
    // ...and the control: the same search finds each one in the raw text.
    const rawText = `${HOSTILE_SET.findings[0]?.action.lead ?? ''} ${HOSTILE_SET.findings[0]?.action.detail ?? ''}`;
    expect(rawText.includes('![x](') && rawText.includes('[link](') && rawText.includes('<img')).toBe(true);
    expect(md).toContain('\\!\\[x\\](https://example.invalid/i.png)');
    expect(md).toContain('\\<img src="https://example.invalid/t.png"\\>');
    expect(md).toContain('\\| cell \\|');
  });

  it('escapeMarkdown escapes exactly the syntax characters, and leaves the words alone', () => {
    expect(escapeMarkdown('![a](b) <c> *d* _e_ `f` | # ~ \\')).toBe(
      '\\!\\[a\\](b) \\<c\\> \\*d\\* \\_e\\_ \\`f\\` \\| \\# \\~ \\\\',
    );
    expect(escapeMarkdown('Split work at phase boundaries.')).toBe('Split work at phase boundaries.');
  });
});

/* ------------------------------------------------------------------------ *
 * 4. The formats say what the preview says
 * ------------------------------------------------------------------------ */

describe('every format is the preview’s report, in its order', () => {
  it('each format carries the heading, the facts, every lead in order, and the resolved and rejected lines', () => {
    for (const [name, set] of ALL_SETS) {
      const report = reportOf(set);
      const pieces = [
        report.facts.heading,
        report.facts.agent,
        ...report.findings.map((finding) => finding.meta),
        ...(report.resolved === undefined ? [] : [report.resolved]),
        ...(report.rejected === undefined ? [] : [report.rejected]),
        ...(report.note === undefined ? [] : [report.note]),
      ];
      for (const [format, text] of [
        ['text', exportText(set)],
        ['html', parse(exportHtml(set)).body.textContent ?? ''],
      ] as const) {
        let at = -1;
        for (const piece of pieces) {
          const next = text.indexOf(piece, at + 1);
          expect(next, `${name}/${format}: ${piece}`).toBeGreaterThan(at);
          at = next;
        }
      }
    }
  });

  it('Copy is plain text, and a batch Copy is every run, in order, separated', () => {
    expect(formatOf('copy')).toBe('text');
    expect(formatOf('html')).toBe('html');
    expect(formatOf('markdown')).toBe('markdown');
    const batch = exportTextBatch([
      { set: REPORT_SETS.ok, dropped: 0 },
      { set: REPORT_SETS.refused, dropped: 0 },
    ]);
    const ok = exportText(REPORT_SETS.ok);
    const refused = exportText(REPORT_SETS.refused);
    expect(batch.startsWith(ok)).toBe(true);
    expect(batch.endsWith(refused)).toBe(true);
    expect(batch.indexOf(refused)).toBeGreaterThan(batch.indexOf(ok));
  });

  it('nothing is added that the set does not carry: no provider name, no version of ours, no clock', () => {
    for (const [, set] of ALL_SETS) {
      for (const text of [exportHtml(set), exportMarkdown(set), exportText(set)]) {
        expect(text).not.toContain('Agent Deck Insights');
        expect(text).not.toContain('0.9.0');
      }
      // Pure: the same set gives the same bytes.
      expect(exportHtml(set)).toBe(exportHtml(structuredClone(set)));
    }
  });
});

/* ------------------------------------------------------------------------ *
 * 5. File names and G1
 * ------------------------------------------------------------------------ */

describe('file names, and the observed roots', () => {
  it('a run’s name carries its instant and id; a colon becomes a dash', () => {
    expect(exportFileName(REPORT_SETS.ok, 'html')).toBe('agent-deck-insights-2026-09-21-1200-run-3.html');
    expect(exportFileName(HOSTILE_SET, 'markdown')).toBe('agent-deck-insights-2026-09-21-1200-run-hostile-1.md');
  });

  it('freeName never returns a taken name, compared case-insensitively', () => {
    expect(freeName('a.md', new Set())).toBe('a.md');
    expect(freeName('a.md', new Set(['a.md']))).toBe('a-2.md');
    expect(freeName('a.md', new Set(['A.MD', 'a-2.md']))).toBe('a-3.md');
  });

  it('observedRootOf: inside or equal is refused; a sibling with the root as a PREFIX is not', () => {
    const roots = ['C:\\Users\\dev\\.claude', 'C:\\Users\\dev\\.codex', ''];
    expect(observedRootOf('C:\\Users\\dev\\.claude\\projects\\r.html', roots, 'win32')).toBe(roots[0]);
    expect(observedRootOf('C:\\Users\\dev\\.claude', roots, 'win32')).toBe(roots[0]);
    expect(observedRootOf('c:\\users\\DEV\\.Claude\\r.html', roots, 'win32')).toBe(roots[0]);
    expect(observedRootOf('C:\\Users\\dev\\.claude-exports\\r.html', roots, 'win32')).toBeNull();
    expect(observedRootOf('C:\\Users\\dev\\exports\\r.html', roots, 'win32')).toBeNull();
    // An empty root is skipped, never read as "everything".
    expect(observedRootOf('C:\\anything.html', [''], 'win32')).toBeNull();
    // Case matters where the file system says it does.
    expect(observedRootOf('/home/dev/.claude/r.md', ['/home/dev/.claude'], 'linux')).toBe('/home/dev/.claude');
    expect(observedRootOf('/home/dev/.Claude/r.md', ['/home/dev/.claude'], 'linux')).toBeNull();
  });
});

/* ------------------------------------------------------------------------ *
 * 6. No network
 * ------------------------------------------------------------------------ */

describe('the export makes no call', () => {
  it('imports only a path library and this repository’s own pure modules', () => {
    const source = readFileSync(resolve('src/insights-export.ts'), 'utf8');
    const imports = [...source.matchAll(/^import[^;]*?from '([^']+)';/gmu)].map((m) => m[1]).sort();
    expect(imports).toStrictEqual(['./insights-report.js', './insights-report.js', './model/events.js', 'node:path'].sort());
    for (const call of ['fetch(', 'http:', 'https:', 'XMLHttpRequest', 'WebSocket', 'node:net', 'node:http', 'require(']) {
      const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
      expect(code.includes(call), call).toBe(false);
    }
  });
});
