/**
 * A full run leaves no scratch directory behind — v0.7.0 DoD 1c.5.
 *
 * ## Why this exists
 *
 * Measured 2026-09-08, after roughly fifty suite runs: **765 scratch
 * directories in `%TEMP%` totalling 1,296 MB**, and **96 in `dist/`**. Every
 * one was created by a test in this repository and never removed. The oldest
 * was nineteen days old.
 *
 * Two consequences, and the second is the serious one:
 *
 *   - `dist/**` is shipped WHOLESALE in the VSIX with three `!` re-admissions.
 *     `CLAUDE.md` records `vsce ls` enumerating `dist/wire-test-<random>/**` as
 *     packaged content during a real run. A leaked scratch directory is a
 *     packaging defect, not untidiness.
 *   - A `%TEMP%` that grows without bound is a plausible contributor to the
 *     wall-clock step this suite showed mid-block, and nothing could say either
 *     way because nothing was counting.
 *
 * ## Why a global teardown rather than a test
 *
 * The property is about the WHOLE RUN — "gained zero directories" cannot be
 * asserted from inside one file, because the file that leaks is usually not the
 * file that notices. `globalSetup` snapshots before any worker starts and the
 * teardown compares after the last one exits, which is the only place both
 * halves are visible. A throw here fails the run.
 *
 * ## What it counts, and why not by prefix
 *
 * Matching this repository's known prefixes would be the FAIL-OPEN shape rule
 * 18 exists for: the next test to invent a prefix escapes silently, which is
 * exactly how the 765 accumulated. So the rule is SHAPE, not name —
 * `mkdtemp` appends six random characters to whatever it is given, so any new
 * directory ending in six alphanumerics after a separator is a `mkdtemp`
 * directory whoever made it.
 *
 * Anything else new is REPORTED and does not fail: `%TEMP%` is shared with the
 * whole machine and this run does not own it. Reporting rather than ignoring is
 * rule 18's requirement — a check that skips an input says so.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** `mkdtemp`'s own signature: six random alphanumerics at the end. */
const MKDTEMP_SHAPE = /[-_][0-9A-Za-z]{6}$/;

/** Build output that legitimately lives in `dist/` and is not scratch. */
const DIST_KEEP = new Set(['agent-deck', 'webview', 'theater']);

interface Snapshot {
  temp: Set<string>;
  dist: Set<string>;
}

let before: Snapshot | null = null;

function dirsIn(root: string): Set<string> {
  if (!existsSync(root)) return new Set();
  const out = new Set<string>();
  for (const name of readdirSync(root)) {
    try {
      if (statSync(join(root, name)).isDirectory()) out.add(name);
    } catch {
      // A directory that vanished between readdir and stat is not this run's
      // business — `%TEMP%` is shared and things disappear from under you.
    }
  }
  return out;
}

function snapshot(): Snapshot {
  return { temp: dirsIn(tmpdir()), dist: dirsIn(resolve('dist')) };
}

function added(from: Set<string>, to: Set<string>): string[] {
  return [...to].filter((name) => !from.has(name)).sort();
}

export function setup(): void {
  before = snapshot();
}

export function teardown(): void {
  if (before === null) throw new Error('scratch-guard: teardown ran without setup');
  const after = snapshot();

  const newTemp = added(before.temp, after.temp);
  const newDist = added(before.dist, after.dist);

  // `dist/` is entirely ours, so ANY new directory there is a leak — the shape
  // rule is not needed and would only weaken it.
  const leakedDist = newDist.filter((name) => !DIST_KEEP.has(name));
  const leakedTemp = newTemp.filter((name) => MKDTEMP_SHAPE.test(name));
  const foreignTemp = newTemp.filter((name) => !MKDTEMP_SHAPE.test(name));

  if (foreignTemp.length > 0) {
    // Rule 18: a check that does not gate on an input says so, with the count.
    process.stdout.write(
      `[scratch-guard] ${String(foreignTemp.length)} new %TEMP% director${
        foreignTemp.length === 1 ? 'y' : 'ies'
      } did not match mkdtemp's shape and are NOT gated (the machine shares this ` +
        `directory): ${foreignTemp.slice(0, 10).join(', ')}\n`,
    );
  }

  if (leakedDist.length === 0 && leakedTemp.length === 0) {
    process.stdout.write('[scratch-guard] clean: no scratch directory survived the run\n');
    return;
  }

  const lines: string[] = [
    'DoD 1c.5: the run leaked scratch directories. Every test that creates one',
    'removes it in `afterAll` — see `test/scratch-guard.ts` for why a leaked',
    '`dist/` directory is a packaging defect and not untidiness.',
    '',
  ];
  if (leakedDist.length > 0) {
    lines.push(`dist/ (${String(leakedDist.length)}), and dist/** SHIPS:`);
    for (const name of leakedDist) lines.push(`  dist/${name}`);
  }
  if (leakedTemp.length > 0) {
    lines.push(`%TEMP% (${String(leakedTemp.length)}):`);
    for (const name of leakedTemp) lines.push(`  ${name}`);
  }
  throw new Error(lines.join('\n'));
}
