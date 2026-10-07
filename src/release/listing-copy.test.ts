// 0.9.3.D — the approved listing copy, held word for word.
//
// The ruling of 2026-10-07 approved a messaging rewrite as FINAL: the README's
// top section, the Marketplace listing fields and the site pages. Nothing here
// may be restyled or rephrased, so the guards are exact, never "contains the
// gist". The texts are written out in this file rather than read from the
// approval package, because that package lives in the private repository and
// nothing public may read it (`lab-boundary.test.ts`).
//
// Four properties:
//
//   (1) README.md OPENS with the approved block, byte for byte after line
//       endings are normalised, and the three compatibility callouts follow it
//       directly as the first technical content (ruling 2 of 2026-10-07).
//   (2) site/insights.html lists exactly the approved findings, in order —
//       six rows: `long session` removed (ruling 12), `compaction` after
//       `context churn` in the wording of ruling 7 of the second set, and no
//       `cache miss` (the same ruling: the product has no such finding).
//   (3) No public surface says HOW the Insights licence is checked (HANDOFF
//       A1: "Do not add one back, anywhere public").
//   (4) The diagram is handled exactly like the hero GIF: admitted by
//       `.gitignore`, never re-admitted by `.vscodeignore`.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const README = read('README.md');
const INSIGHTS_PAGE = read('site/insights.html');

/** HANDOFF Part A2, verbatim. */
const APPROVED_README_TOP = [
  '# Agent Deck',
  '',
  '**See what your AI coding agents are doing. Right now.**',
  '',
  'Agent Deck is a free VS Code extension that draws a live tree of every agent and every tool call, as they work.',
  '',
  '![Agent Deck drawing a live tree as one session spawns 4 lead agents and 8 workers](media/agent-deck-hero.gif)',
  '',
  '## What is it?',
  '- **Live observability for AI coding agents.** In plain words: a live tree of your agents and their tool calls.',
  '- **Works with Claude Code, Codex and OpenCode.** You run them as usual. Agent Deck only watches.',
  '- **Reads the files your agents already write** to your disk. Optional hooks make it instant.',
  '- **Read-only.** It never starts, steers or changes your agents or their settings.',
  '- **Nothing leaves your machine.** No telemetry, no cloud, no account. Free and open source (MIT).',
  '',
  '## Why I built it',
  "Give Claude Code or Codex a big task and it splits the work across several agents running in parallel. In the terminal you can barely see who's doing what, who's stuck, or why it's taking 10 minutes. I built Agent Deck because I couldn't understand what was running on my own machine.",
  '',
  '## Where it sits',
  '![Agent Deck reads session files and optional hooks; it is never in the API path and sends nothing out](media/architecture.png)',
  '',
  "## Who it's for",
  "Developers who hand Claude Code, Codex or OpenCode long tasks with subagents. Seeing what's happening comes first. Tokens and cost are shown too.",
  '',
  '## Install',
  '1. Install Agent Deck from the Marketplace.',
  '2. Click the Agent Deck icon in the sidebar.',
  '3. Optional: paste the hook block below for second-by-second updates.',
  '',
  'More at **[agent-deck.app](https://agent-deck.app)**. Everything technical is below.',
].join('\n');

/** The rows of site/insights.html's ~/what-it-finds list: key, then text. */
const APPROVED_FINDINGS: ReadonlyArray<readonly [string, string]> = [
  ['re-read loop', 'The same file read again and again, with nothing changed in between.'],
  ['churn chain', 'Edit, fail, edit again on the same file, and the failed calls in between.'],
  ['context churn', 'A huge tool result or a cold cache that suddenly makes every turn expensive.'],
  ['compaction', 'The conversation was summarised to free up context, so earlier detail was summarised away.'],
  ['silent subagent', 'Subagents that did nothing, or whose results were never used.'],
  ['stall', 'Commands that block your agent for minutes, and waits nobody noticed.'],
];

/** The rows of the list that follows the `~/what-it-finds` label, in order. */
function findingsOf(html: string): Array<[string, string]> {
  const at = html.indexOf('<b>~/what-it-finds</b>');
  if (at < 0) return [];
  const list = /<ul\b[\s\S]*?<\/ul>/.exec(html.slice(at))?.[0] ?? '';
  return [...list.matchAll(/<li><span class="k">([^<]*)<\/span><span class="v">([^<]*)<\/span><\/li>/g)].map(
    (m) => [m[1] ?? '', m[2] ?? ''],
  );
}

/**
 * A sentence that says how a licence is checked. Words that sit near
 * "licence"/"license" and describe a check, plus the two phrasings the 0.9.2
 * page used. Setup wording ("your licence key arrives by email", the
 * "Set License Key" command) names no check and is not matched.
 */
function licenceCheckClaims(text: string): string[] {
  const patterns = [
    /licen[cs]e\w*\W+(?:\w+\W+){0,6}?(?:check|verif|validat|offline|activat)\w*/gi,
    /(?:check|verif|validat)\w*\W+(?:\w+\W+){0,6}?licen[cs]e\w*/gi,
    /activation server/gi,
    /signed (?:licen[cs]e|key)/gi,
  ];
  return patterns.flatMap((p) => [...text.matchAll(p)].map((m) => m[0]));
}

const PUBLIC_SURFACES = [
  'README.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'package.json',
  ...readdirSync(join(ROOT, 'site'))
    .filter((name) => name.endsWith('.html'))
    .sort()
    .map((name) => `site/${name}`),
];

describe('0.9.3.D (1) — the README opens with the approved block', () => {
  it('starts with HANDOFF A2 word for word, then a blank line', () => {
    expect(README.startsWith(`${APPROVED_README_TOP}\n\n`)).toBe(true);
  });

  it('the three compatibility callouts follow the block directly, unchanged in order', () => {
    const after = README.slice(APPROVED_README_TOP.length + 2);
    expect(after.startsWith('> **Claude Code compatibility** — anchor `')).toBe(true);
    const cc = after.indexOf('> **Claude Code compatibility**');
    const oc = after.indexOf('> **OpenCode compatibility**');
    const cx = after.indexOf('> **Codex compatibility**');
    const firstSection = after.indexOf('\n## ');
    expect(cc).toBe(0);
    expect(oc).toBeGreaterThan(cc);
    expect(cx).toBeGreaterThan(oc);
    expect(firstSection).toBeGreaterThan(cx);
  });

  it('vacuity control: one changed character in the block is refused', () => {
    const mutated = README.replace('Right now.', 'Right now!');
    expect(mutated).not.toBe(README);
    expect(mutated.startsWith(`${APPROVED_README_TOP}\n\n`)).toBe(false);
  });
});

describe('0.9.3.D (2) — the Insights page lists exactly the approved findings', () => {
  it('the ~/what-it-finds rows are the approved six, in order', () => {
    const rows = findingsOf(INSIGHTS_PAGE);
    expect(rows).toStrictEqual(APPROVED_FINDINGS.map(([k, v]) => [k, v]));
    expect(rows).toHaveLength(6);
  });

  it('carries no "long session" and no "cache miss" finding anywhere on the page', () => {
    expect(INSIGHTS_PAGE.toLowerCase()).not.toContain('long session');
    expect(INSIGHTS_PAGE.toLowerCase()).not.toContain('cache miss');
  });

  it('vacuity control: the reader finds rows, and sees a reordered list as different', () => {
    const html =
      '<b>~/what-it-finds</b><ul>' +
      '<li><span class="k">b</span><span class="v">two</span></li>' +
      '<li><span class="k">a</span><span class="v">one</span></li></ul>';
    expect(findingsOf(html)).toStrictEqual([
      ['b', 'two'],
      ['a', 'one'],
    ]);
    expect(findingsOf('<p>no list</p>')).toStrictEqual([]);
  });
});

describe('0.9.3.D (3) — no public surface says how the Insights licence is checked', () => {
  it.each(PUBLIC_SURFACES)('%s states no licence check', (rel) => {
    expect(licenceCheckClaims(read(rel)), rel).toStrictEqual([]);
  });

  it('vacuity control: every phrasing the 0.9.2 surfaces used is caught, setup wording is not', () => {
    for (const claim of [
      'Licence checked offline.',
      'licence checked offline',
      'Your licence is checked on your machine.',
      'Checks your licence offline',
      'No account, no activation server.',
      'Insights registers only once it has checked its own licence',
    ]) {
      expect(licenceCheckClaims(claim), claim).not.toStrictEqual([]);
    }
    for (const setup of [
      'Your licence key arrives by email within minutes.',
      'run “Agent Deck Insights: Set License Key”.',
      '"license": "MIT",',
    ]) {
      expect(licenceCheckClaims(setup), setup).toStrictEqual([]);
    }
  });
});

describe('0.9.3.D (4) — the diagram is handled exactly like the hero GIF', () => {
  const lines = (rel: string): string[] => read(rel).split('\n').map((l) => l.trim());

  it('.gitignore admits both, .vscodeignore re-admits neither', () => {
    for (const asset of ['media/agent-deck-hero.gif', 'media/architecture.png']) {
      expect(lines('.gitignore'), `.gitignore does not admit ${asset}`).toContain(`!${asset}`);
      expect(lines('.vscodeignore'), `.vscodeignore re-admits ${asset}`).not.toContain(`!${asset}`);
    }
    expect(lines('.vscodeignore')).toContain('media/**');
  });
});
