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
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../scripts/forbidden-words.mjs', import.meta.url));

interface Report {
  scanned: number;
  skipped: number;
  literals: number;
  violations: { file: string; line: number; word: string; matched: string }[];
}

function run(args: string[] = []): { report: Report; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--json', ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return { report: JSON.parse(stdout) as Report, status: 0 };
  } catch (error) {
    // A violation makes the script exit 1, which `execFileSync` throws on. The
    // JSON is still on stdout and the exit code is part of what is asserted:
    // a check that reports a violation and exits 0 gates nothing.
    const failure = error as { status?: number; stdout?: string };
    // A refusal (an empty or missing scope) exits before printing anything, so
    // stdout is the EMPTY STRING rather than undefined — `?? '{}'` does not
    // catch that, and the test failed with "Unexpected end of JSON input"
    // instead of the assertion it was making.
    const stdout = failure.stdout ?? '';
    return {
      report: (stdout.trim() === '' ? {} : JSON.parse(stdout)) as Report,
      status: failure.status ?? -1,
    };
  }
}

/** Temp directories this file made, removed even if a test throws. */
const scratch: string[] = [];

afterAll(() => {
  // `test/scratch-guard.ts` fails the whole run over one leaked directory, and
  // it is right to: 765 of them accumulated in %TEMP% before it existed.
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A scope directory holding one `.ts` file with the given source. */
function plant(source: string): string {
  // `realpathSync.native` for the recorded libuv reason — a runner's
  // `RUNNER~1` short path is the shape that aborts a process with no failing
  // assertion. Nothing watches this directory, but the habit is cheap.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-deck-g10-')));
  scratch.push(dir);
  writeFileSync(join(dir, 'planted.ts'), source, 'utf8');
  return dir;
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
  // Spawned once at describe scope and shared by both tests below, rather than
  // once per test: the same subprocess-cost rule, applied before it bites.
  const { report } = run();

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

describe('the gate can still see a violation — the REAL script, on a planted one', () => {
  /*
   * `phase-verifier` found the first version of this block grepping the
   * script's own source for `'should'` and then re-implementing its regex
   * inline. That proves the word is spelled in the file and that a regex
   * written in this file works; it proves nothing about the script's
   * extraction pipeline, and the pipeline is the part that could break.
   * PLAN's DoD 4.7 names the real control — "plants 'should' in a temp copy
   * and asserts failure" — and this is it, delivered early with the gate it
   * belongs to.
   */
  it('flags a planted violation in a string literal, and exits non-zero', () => {
    const dir = plant("export const NOTE = 'you should split this file';\n");
    const { report, status } = run(['--scope', dir]);
    expect(status).toBe(1);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({ word: 'should', matched: 'should' });
    expect(report.scanned).toBe(1);
  }, 30_000);

  it('flags every word on the §G list, through the script, in ONE pass', () => {
    /*
     * ONE spawn, not nine, and the reason is a defect this test committed.
     * The first version planted a file per word and ran the script nine times
     * inside a single `it`; alone that takes ~2 s, and in the full suite it
     * blew vitest's 5 s default with `Test timed out in 5000ms`. That is this
     * repository's recorded class — "an expensive subprocess called once per
     * test is a test that passes or fails by CPU load" — and the rule it
     * records is that a failure which disappears on a second run is a defect
     * report about the test, not noise. It did disappear on the second run.
     *
     * One file, nine literals, one pass is also the STRONGER assertion: every
     * word must be found in a single scan, so a pattern that only matches when
     * it is the sole candidate cannot hide.
     */
    const sentences: [string, string][] = [
      ['should', 'you should split this'],
      ['recommend', 'we recommend nothing'],
      ['consider', 'considering the alternative'],
      ['try', 'try the other branch'],
      ['improve', 'an improved layout'],
      ['better', 'a better result'],
      ['bad', 'a bad outcome'],
      ['good', 'a good outcome'],
      ['waste', 'this turn was wasted'],
    ];
    const source = sentences
      .map(([word, sentence], i) => `export const N${String(i)} = '${sentence}'; // ${word}`)
      .join('\n');
    const dir = plant(`${source}\n`);
    const { report, status } = run(['--scope', dir]);
    expect(status).toBe(1);
    const found = new Set(report.violations.map((v) => v.word));
    expect([...found].sort()).toEqual(sentences.map(([w]) => w).sort());
  }, 30_000);

  it('does NOT flag the same words in a comment, or a near miss in a literal', () => {
    // The other direction, and it is what keeps the gate usable. G10's subject
    // is what the PRODUCT says; a file-wide grep would flag this repository's
    // own reasoning and get suppressed rather than fixed.
    const dir = plant(
      '// you should consider whether this is better — prose, not a product string\n' +
        "export const N = 'a retry in this country';\n",
    );
    const { report, status } = run(['--scope', dir]);
    expect(status).toBe(0);
    expect(report.violations).toEqual([]);
    // ...and it really did look: one file, at least one literal.
    expect(report.scanned).toBe(1);
    expect(report.literals).toBeGreaterThan(0);
  }, 30_000);

  it('refuses a scope that holds no TypeScript rather than passing it', () => {
    // The fail-open shape rule 18 exists for: a gate pointed somewhere empty
    // reports PASS. Phase 4 adds `webview/stats` to SCOPES, and this is what
    // stops the day it is added-but-not-yet-created reading as green.
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-deck-g10-')));
    scratch.push(dir);
    const { status } = run(['--scope', dir]);
    expect(status).toBe(1);
  }, 30_000);
});
