/**
 * The privacy sweep's history leg, timed — moved here from
 * `src/release/privacy.test.ts`, unchanged except for where it runs.
 *
 * WHY IT MOVED, AND WHY THAT IS NOT A WEAKENING. The assertion is
 * `historyMs < 10_000`, and it exists so that nobody quietly hides the history
 * leg behind an env gate while the DoD still says "full-history sweep". That
 * is a real thing to check. But it is a WALL-CLOCK budget, and a wall-clock
 * budget running beside forty other files on a shared machine measures the
 * machine.
 *
 * It went red doing exactly that: a `phase-verifier` auditing this release's
 * predecessor got `expected 12344 to be less than 10000` in a full run, on a
 * tree whose code was green forty minutes earlier — alongside four timeouts,
 * and inside two attempts. That is `CLAUDE.md` rule 14's property failing, and
 * the cause was contention rather than the sweep.
 *
 * So it joins the other budgets in the `perf` project, which vitest runs in a
 * SINGLE FORK after every other file has finished (`vitest.config.ts`). **The
 * limit is unchanged at 10,000 ms** — widening a budget to survive load is the
 * version-window mistake in timing form, and this repository has refused it
 * three times already.
 *
 * WHAT DID NOT MOVE: every correctness assertion about the sweep. Those stay
 * in `src/release/privacy.test.ts`, where they belong and where they are not
 * timing-sensitive. This file measures one number.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SWEEP_SCRIPT = fileURLToPath(new URL('../../scripts/privacy-sweep.mjs', import.meta.url));

/**
 * The budget, stated once. `src/perf/budgets.ts` is not the home for it: every
 * entry there is a stage of the append pipeline measured by
 * `src/perf/measure.ts`'s harness, and this is a subprocess-free module call
 * against git. Same project, same isolation, different instrument.
 */
const HISTORY_LIMIT_MS = 10_000;

interface SweepReport {
  timingsMs: { workingTreeMs: number; historyMs?: number };
  verdict: { pass: boolean };
}

type Sweep = (options: { root: string; history: boolean; stamp: string }) => SweepReport;

let sweep: Sweep;
let importError: string | undefined;

beforeAll(async () => {
  // Caught, never thrown. An import failure inside a `beforeAll` reports as
  // SKIPPED, and a skip reads green in the summary line — the recorded way
  // `privacy.test.ts` once ran 0 of 24 assertions while looking healthy. The
  // test below asserts on `importError` instead, so a broken import FAILS.
  try {
    const module = (await import(/* @vite-ignore */ pathToFileURL(SWEEP_SCRIPT).href)) as {
      sweep: Sweep;
    };
    sweep = module.sweep;
  } catch (error) {
    importError = error instanceof Error ? error.message : String(error);
  }
}, 120_000);

describe('the privacy sweep history leg is cheap enough not to need an env gate', () => {
  it('imports at all', () => {
    expect(importError, 'scripts/privacy-sweep.mjs failed to import').toBeUndefined();
    expect(typeof sweep).toBe('function');
  });

  it('walks every blob reachable from every ref inside the budget', () => {
    // Stated as a number rather than an adjective. If this fails, gate the
    // history leg and say so in `privacy.test.ts`'s header — do NOT raise the
    // bound quietly, and do not move the file again.
    const fresh = sweep({ root: REPO_ROOT, history: true, stamp: '1970-01-01T00:00:00.000Z' });
    const historyMs = fresh.timingsMs.historyMs;

    // Vacuity control. `?? Infinity` in the original made an ABSENT timing
    // fail, which is right; asserting the key is present says so out loud, so
    // a future sweep that stops reporting the number cannot pass by omission.
    expect(historyMs, 'the sweep reported no historyMs at all').toBeTypeOf('number');
    expect(historyMs ?? Number.POSITIVE_INFINITY).toBeLessThan(HISTORY_LIMIT_MS);
  }, 120_000);
});
