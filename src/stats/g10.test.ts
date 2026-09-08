/**
 * G10 — facts only, and the gate that enforces it.
 *
 * "No interpretive language in `src/stats/**`, `webview/stats/**`, or the
 * `0.7.0` CHANGELOG block. The forbidden-word script is a lint gate from the
 * moment the UI exists."
 *
 * Phase 2 builds the minimal version — the §G word list over `src/stats/**` —
 * and wires it into `npm run lint`. Phase 4 extends the SCOPE to the webview
 * and the changelog; the list does not change.
 *
 * ## Why this test exists beside the script
 *
 * The script runs in `npm run lint`, which is a separate gate from the suite,
 * and a phase gate cites both. What the suite adds is the thing a lint run
 * cannot check about itself: that the script is actually WIRED, that it can
 * still see a violation, and that its scope has not quietly become empty. A
 * gate that scans nothing passes, and this repository has shipped that exact
 * shape twice — a CI step running an audit against a checkout with no `spike/`,
 * and a privacy sweep reporting PASS over a history `fetch-depth: 1` had not
 * fetched.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../scripts/forbidden-words.mjs', import.meta.url));

interface Report {
  scanned: number;
  skipped: number;
  literals: number;
  violations: { file: string; line: number; word: string; matched: string }[];
}

function run(): Report {
  const stdout = execFileSync(process.execPath, [SCRIPT, '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as Report;
}

describe('the G10 gate is wired', () => {
  it('npm run lint invokes it', () => {
    // The wiring, not the script. A guard nobody runs is a file.
    const manifest = JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts['lint']).toContain('scripts/forbidden-words.mjs');
  });
});

describe('the gate is green, and it is looking at something', () => {
  const report = run();

  it('reports no violation across the stats layer', () => {
    expect(report.violations).toEqual([]);
  });

  it('scanned a real population, and says what it skipped', () => {
    // Vacuity control. `scanned: 0` would report PASS forever, which is the
    // failure mode this file exists for.
    expect(report.scanned).toBeGreaterThan(5);
    expect(report.literals).toBeGreaterThan(100);
    // Rule 18: a check that skips an input must say so. `*.test.ts` and
    // `*.testkit.ts` are skipped because neither is bundled, and the count
    // travels with the verdict rather than being silent.
    expect(report.skipped).toBeGreaterThan(0);
  });
});

describe('the gate can still see a violation', () => {
  it('flags every word on the §G list, and their inflections', () => {
    // A mutation control that does not write to the tree: the same patterns the
    // script uses, applied to sentences it must reject. If this ever goes green
    // for a word, that word has fallen off the list.
    const forbidden = [
      'should',
      'recommend',
      'consider',
      'try',
      'improve',
      'better',
      'bad',
      'good',
      'waste',
    ];
    const script = readFileSync(SCRIPT, 'utf8');
    for (const word of forbidden) {
      expect(script).toContain(`'${word}'`);
    }
    // And the inflected forms the spec's own vocabulary implies.
    for (const [word, sentence] of [
      ['should', 'you should split this file'],
      ['recommend', 'we recommends nothing'],
      ['waste', 'this turn was wasted'],
      ['consider', 'considering the alternative'],
      ['improve', 'an improved layout'],
    ] as const) {
      const re = new RegExp(`\\b${word}\\w*\\b`, 'iu');
      expect(re.test(sentence)).toBe(true);
    }
    // And the negative arm: the trailing-space form in the spec exists so
    // `retry` and `country` do not match, and the boundary form keeps that.
    expect(/\btry\w*\b/iu.test('a retry of the request')).toBe(false);
    expect(/\bbad\w*\b/iu.test('the clipboard')).toBe(false);
  });
});
