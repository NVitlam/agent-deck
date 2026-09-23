/**
 * Insights report EXPORT — v0.9.0 DoD 9.47, spec `Amendment 2026-09-23 —
 * Paid Insights surface, export, provider v1 growth`.
 *
 * "HTML (self-contained, deck-neutral styling, no external resource),
 * Markdown, Copy (plain text); built only from `FindingSetView` … never a
 * network call." This module is the half of that which can be tested without
 * an editor: a checked set in, a string out. The save dialog, the folder
 * dialog, the clipboard and the write are `activate()`'s, and nothing here
 * imports `vscode`.
 *
 * ## One report, three spellings
 *
 * Every format is built from {@link reportOf} — the same function the
 * preview renders — so what a person saw and what they saved say the same
 * thing in the same order. Nothing here adds a fact the set does not carry:
 * no provider name, no Agent Deck version, no clock.
 *
 * ## Provider text is DATA in every format
 *
 * - **HTML** escapes `& < > " '`, carries ONE inline stylesheet with no
 *   `url()` and no `@import`, no element that loads anything, and a
 *   `Content-Security-Policy` of `default-src 'none'; style-src
 *   'unsafe-inline'`, so a viewer would refuse a load even if one were
 *   written. `src/insights-export.test.ts` parses every golden and looks.
 * - **Markdown** backslash-escapes the characters that make a link, an image,
 *   raw HTML, emphasis, a code span or a table cell (`\ ` * _ [ ] < > ! | #
 *   ~`), so no provider string can become an image, a link or raw HTML in a
 *   Markdown viewer — an image would be a network call made on the reader's
 *   behalf. (A GitHub-flavoured viewer still shows a BARE url as a link;
 *   that fetches nothing unless the reader clicks it.)
 * - **Plain text** is the text.
 *
 * ## G1 — a write never lands inside an observed engine's directory
 *
 * {@link observedRootOf} answers whether a chosen path is inside
 * `~/.claude`, the Claude Code projects root, the Codex root or the OpenCode
 * data directory. The host refuses such a path and writes nothing. A file the
 * user chooses anywhere else is the amendment's own ruling.
 */

import { posix, win32 } from 'node:path';

import type { InsightsExportTarget, FindingSetView } from './model/events.js';
import type { RunReport } from './insights-report.js';
import { formatInstant, reportOf } from './insights-report.js';

/** A file format Export writes. `copy` writes no file; it is plain text. */
export type ExportFormat = 'html' | 'markdown' | 'text';

/** The format each Export target produces. */
export function formatOf(target: InsightsExportTarget): ExportFormat {
  return target === 'copy' ? 'text' : target;
}

/** The extension each file format is saved with. */
export const EXPORT_EXTENSIONS: Readonly<Record<'html' | 'markdown', string>> = Object.freeze({
  html: 'html',
  markdown: 'md',
});

/** The save dialog's filter label per file format. */
export const EXPORT_FILTERS: Readonly<Record<'html' | 'markdown', string>> = Object.freeze({
  html: 'HTML',
  markdown: 'Markdown',
});

/* ------------------------------------------------------------------------ *
 * Plain text
 * ------------------------------------------------------------------------ */

/** Provider free text with its line ends made LF, as every format prints it. */
function lines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Every fact line of a report's head, in order, skipping the absent. */
function factLines(report: RunReport): string[] {
  return [report.facts.agent, report.facts.window, ...(report.facts.usage === null ? [] : [report.facts.usage])];
}

/**
 * The report as plain text — the Copy action. `dropped` is how many of the
 * set's values the check dropped (`Checked.dropped`); the report says so,
 * exactly as the preview does.
 */
export function exportText(set: FindingSetView, dropped = 0): string {
  const report = reportOf(set, dropped);
  const out: string[] = [report.facts.heading, ...factLines(report), ''];
  if (report.dropped !== undefined) out.push(report.dropped, '');
  if (report.refusal !== undefined) {
    out.push(`Refused at step: ${report.refusal.step}`, lines(report.refusal.reason), '');
  }
  if (report.note !== undefined) out.push(report.note, '');
  report.findings.forEach((finding, index) => {
    out.push(`${String(index + 1)}. ${finding.lead}`, `   ${finding.meta}`);
    if (finding.detail !== '') out.push('', 'Detail', lines(finding.detail));
    out.push('', 'Cause', lines(finding.cause), '', 'Evidence');
    for (const item of finding.evidence) out.push(`- ${item.label}: ${item.value} (${item.source})`);
    out.push('');
  });
  if (report.resolved !== undefined) out.push(report.resolved, '');
  if (report.rejected !== undefined) out.push(report.rejected, '');
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/* ------------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------------ */

/**
 * Provider text made inert in Markdown: every character that starts a link,
 * an image, an autolink or raw HTML, emphasis, a code span, a heading, a
 * table cell or a strikethrough is backslash-escaped. CommonMark lets any
 * ASCII punctuation be escaped, so this changes how the text is SPELLED in
 * the file and never how it reads.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>!|#~]/g, '\\$&');
}

/**
 * Multi-line provider text as Markdown paragraphs: each line escaped, lines
 * joined by a hard break (a trailing backslash), blank lines kept as
 * paragraph breaks.
 */
function markdownBlock(text: string): string {
  return lines(text)
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => escapeMarkdown(line))
        .join('\\\n'),
    )
    .join('\n\n');
}

/** The report as Markdown. */
export function exportMarkdown(set: FindingSetView, dropped = 0): string {
  const report = reportOf(set, dropped);
  const out: string[] = [`# ${escapeMarkdown(report.facts.heading)}`, ''];
  for (const line of factLines(report)) out.push(`- ${escapeMarkdown(line)}`);
  out.push('');
  if (report.dropped !== undefined) out.push(`*${escapeMarkdown(report.dropped)}*`, '');
  if (report.refusal !== undefined) {
    out.push(`## Refused at step: ${escapeMarkdown(report.refusal.step)}`, '', markdownBlock(report.refusal.reason), '');
  }
  if (report.note !== undefined) out.push(escapeMarkdown(report.note), '');
  report.findings.forEach((finding, index) => {
    out.push(`## ${String(index + 1)}\\. ${escapeMarkdown(finding.lead)}`, '', `*${escapeMarkdown(finding.meta)}*`, '');
    if (finding.detail !== '') out.push('**Detail**', '', markdownBlock(finding.detail), '');
    out.push('**Cause**', '', markdownBlock(finding.cause), '', '**Evidence**', '');
    // The source is a stats key and a session id, both checked against
    // patterns that admit no backtick, so a code span holds them safely.
    for (const item of finding.evidence) {
      out.push(`- ${escapeMarkdown(item.label)}: **${escapeMarkdown(item.value)}** \`${item.source}\``);
    }
    out.push('');
  });
  if (report.resolved !== undefined) out.push(escapeMarkdown(report.resolved), '');
  if (report.rejected !== undefined) out.push(escapeMarkdown(report.rejected), '');
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/* ------------------------------------------------------------------------ *
 * HTML
 * ------------------------------------------------------------------------ */

/** Text made inert in HTML, attribute or element content alike. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The CSP every exported page carries: nothing may load, inline style may
 * apply. The page has no script, so none is allowed either.
 */
export const EXPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/**
 * The one stylesheet. Deck-neutral: system fonts, the editor's plain
 * light/dark contrast, no colour that belongs to a brand, and — held by a
 * test — no `url(` and no `@import`.
 */
export const EXPORT_STYLE = [
  ':root { color-scheme: light dark; --fg: #1f1f1f; --dim: #5f5f5f; --line: #d0d0d0; --bg: #ffffff; --panel: #f5f5f5; }',
  '@media (prefers-color-scheme: dark) { :root { --fg: #d4d4d4; --dim: #9d9d9d; --line: #3c3c3c; --bg: #1e1e1e; --panel: #252526; } }',
  'body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }',
  'main { max-width: 52em; margin: 0 auto; padding: 32px 24px; }',
  'h1 { font-size: 1.5em; margin: 0 0 8px; }',
  'h2 { font-size: 1.1em; margin: 0 0 4px; }',
  '.facts p, .line { margin: 2px 0; color: var(--dim); }',
  '.finding, .refusal { margin: 16px 0; padding: 10px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }',
  '.meta { color: var(--dim); font-size: 0.9em; margin: 0 0 6px; }',
  '.caption { font-size: 0.85em; color: var(--dim); margin: 8px 0 2px; }',
  '.text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }',
  'ul { margin: 4px 0 0; padding-left: 18px; }',
  'code { font-family: ui-monospace, Consolas, monospace; font-size: 0.9em; color: var(--dim); }',
].join('\n');

/** The report as one self-contained HTML page. */
export function exportHtml(set: FindingSetView, dropped = 0): string {
  const report = reportOf(set, dropped);
  const e = escapeHtml;
  const body: string[] = [
    `<h1>${e(report.facts.heading)}</h1>`,
    '<div class="facts">',
    ...factLines(report).map((line) => `<p>${e(line)}</p>`),
    '</div>',
    ...(report.dropped === undefined ? [] : [`<p class="line">${e(report.dropped)}</p>`]),
  ];
  if (report.refusal !== undefined) {
    body.push(
      '<section class="refusal">',
      `<h2>Refused at step: ${e(report.refusal.step)}</h2>`,
      `<p class="text">${e(lines(report.refusal.reason))}</p>`,
      '</section>',
    );
  }
  if (report.note !== undefined) body.push(`<p class="line">${e(report.note)}</p>`);
  for (const finding of report.findings) {
    body.push(
      '<section class="finding">',
      `<h2>${e(finding.lead)}</h2>`,
      `<p class="meta">${e(finding.meta)}</p>`,
    );
    if (finding.detail !== '') {
      body.push('<p class="caption">Detail</p>', `<p class="text">${e(lines(finding.detail))}</p>`);
    }
    body.push(
      '<p class="caption">Cause</p>',
      `<p class="text">${e(lines(finding.cause))}</p>`,
      '<p class="caption">Evidence</p>',
      '<ul>',
      ...finding.evidence.map(
        (item) => `<li>${e(item.label)}: <strong>${e(item.value)}</strong> <code>${e(item.source)}</code></li>`,
      ),
      '</ul>',
      '</section>',
    );
  }
  if (report.resolved !== undefined) body.push(`<p class="line">${e(report.resolved)}</p>`);
  if (report.rejected !== undefined) body.push(`<p class="line">${e(report.rejected)}</p>`);
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${e(report.facts.heading)}</title>`,
    `<style>\n${EXPORT_STYLE}\n</style>`,
    '</head>',
    '<body>',
    '<main>',
    ...body,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** A report in the given format, with the check's drop count. */
export function exportReport(set: FindingSetView, format: ExportFormat, dropped = 0): string {
  switch (format) {
    case 'html':
      return exportHtml(set, dropped);
    case 'markdown':
      return exportMarkdown(set, dropped);
    case 'text':
      return exportText(set, dropped);
  }
}

/** One run's checked set, as an export takes it: the set and its drop count. */
export interface ExportEntry {
  readonly set: FindingSetView;
  readonly dropped: number;
}

/** Several reports as one clipboard text — batch Copy. */
export function exportTextBatch(entries: readonly ExportEntry[]): string {
  return entries
    .map((entry) => exportText(entry.set, entry.dropped))
    .join('\n----------------------------------------\n\n');
}

/* ------------------------------------------------------------------------ *
 * File names
 * ------------------------------------------------------------------------ */

/**
 * A run's file name: `agent-deck-insights-2026-09-21-1000-run-1.html`.
 *
 * The run id passed `ID_PATTERN` (`[A-Za-z0-9._:-]`), so the only character
 * a file system may refuse is `:` (Windows), which becomes `-`. A leading
 * dot cannot occur: the id follows a fixed prefix.
 */
export function exportFileName(set: FindingSetView, format: 'html' | 'markdown'): string {
  const stamp = formatInstant(set.createdAt).slice(0, 16).replace(' ', '-').replace(':', '');
  return `agent-deck-insights-${stamp}-${set.runId.replace(/:/g, '-')}.${EXPORT_EXTENSIONS[format]}`;
}

/**
 * The first of `name`, `name-2`, `name-3`… that `taken` does not hold — batch
 * export never overwrites. Compared case-insensitively, as Windows and the
 * default macOS file system compare names.
 */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const lower = new Set([...taken].map((entry) => entry.toLowerCase()));
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? name : `${stem}-${String(n)}${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/* ------------------------------------------------------------------------ *
 * G1 — the observed engines' directories
 * ------------------------------------------------------------------------ */

/**
 * The observed root `path` is inside (or is), or `null`.
 *
 * Case-insensitive on Windows, where `C:\Users` and `c:\users` are one
 * directory; exact elsewhere. A root that is empty is skipped rather than
 * read as "everything".
 */
export function observedRootOf(
  path: string,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  // The PLATFORM's path rules, not the host's. `path.win32.relative` already
  // compares case-insensitively and `path.posix.relative` exactly, which is
  // the whole of the case rule — a separate lower-casing step was here and
  // mutation E3 showed it changed nothing, so it went.
  const path_ = platform === 'win32' ? win32 : posix;
  const target = path_.resolve(path);
  for (const root of roots) {
    if (root.trim() === '') continue;
    const inside = path_.relative(path_.resolve(root), target);
    const outside = inside === '..' || inside.startsWith(`..${path_.sep}`) || path_.isAbsolute(inside);
    if (!outside) return root;
  }
  return null;
}
