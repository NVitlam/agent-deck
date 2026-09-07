/**
 * The privacy sweep's history leg, timed — a RUNAWAY CEILING, not a budget.
 *
 * RECLASSIFIED 2026-09-07 (user ruling, at the Phase 1b re-gate).
 *
 * **The rationale in one sentence: this number's cost grows with GIT HISTORY,
 * not with the product.** Every other timing check in this project measures a
 * stage of the append pipeline — work the extension does, on data a user has,
 * where a regression means the product got slower. This one measures how long
 * it takes to walk every blob reachable from every ref, and that grows every
 * time anybody commits anything. Held as a budget it would go red eventually
 * no matter how good the code was, and the only available responses would be
 * to widen it (forbidden here, three times refused) or to delete history.
 *
 * WHAT REPLACES IT, AND WHY THIS IS NOT A WEAKENING:
 *
 *   - **The leg stays UNGATED.** The property the old assertion existed to
 *     protect — that nobody quietly hides the history leg behind an env gate
 *     while the DoD still says "full-history sweep" — is unchanged and is
 *     still checked, by `src/release/privacy.test.ts`'s completeness
 *     assertions rather than by a stopwatch.
 *   - **Its runtime is RECORDED in every gate file.** A number written down at
 *     every gate is a trend anybody can read; a threshold is one bit, and it
 *     is the bit that goes wrong first.
 *   - **The only assertion is a runaway ceiling**, {@link RUNAWAY_CEILING_MS}.
 *     It is not a performance target and must never be treated as one: it is
 *     the line past which something is broken rather than slow — the shape
 *     that turned this scan quadratic on 2026-09-03, when one unanchored
 *     pattern took a single 554 KB line from 3 s to 169 s.
 *
 * WHAT PROMPTED IT. At the 1b.10 re-gate the leg measured 10,522 and 10,649 ms
 * against a 10,000 ms bound, and 9,822 / 9,808 / 11,587 ms standalone with
 * nothing else running — so it was neither contention nor reliably reproducible
 * either way, and the phase that tripped it had added 35 objects out of 3,651.
 * A bound that a commit can cross is a bound that measures the repository.
 *
 * WHAT DID NOT MOVE: every correctness assertion about the sweep. Those stay
 * in `src/release/privacy.test.ts`, where they belong and where they are not
 * timing-sensitive. This file measures one number and reports it.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SWEEP_SCRIPT = fileURLToPath(new URL('../../scripts/privacy-sweep.mjs', import.meta.url));

/**
 * The runaway ceiling. NOT a performance target.
 *
 * Thirty seconds is three times the old bound and about three times the worst
 * figure ever measured here, which is deliberate: nothing between "fast" and
 * "three times the worst we have seen" should fail, because in that band the
 * honest answer is the recorded number and not a red test. What this catches
 * is the other thing — the 2026-09-03 shape, where one unanchored pattern made
 * a single long line quadratic and the same scan went from 3 s to 169 s. That
 * is not slowness, it is a defect, and it clears 30 s by a factor of five.
 *
 * `src/perf/budgets.ts` is still not the home for it, and now for two reasons:
 * every entry there is a stage of the append pipeline measured by
 * `src/perf/measure.ts`'s harness, and this is no longer a budget at all.
 */
const RUNAWAY_CEILING_MS = 30_000;

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

describe('the privacy sweep history leg runs ungated, and is reported not budgeted', () => {
  it('imports at all', () => {
    expect(importError, 'scripts/privacy-sweep.mjs failed to import').toBeUndefined();
    expect(typeof sweep).toBe('function');
  });

  it('walks every blob reachable from every ref, and reports how long it took', () => {
    const fresh = sweep({ root: REPO_ROOT, history: true, stamp: '1970-01-01T00:00:00.000Z' });
    const historyMs = fresh.timingsMs.historyMs;

    // THE VACUITY CONTROL IS NOW THE LOAD-BEARING HALF. With the ceiling three
    // times the worst figure ever measured, "under the ceiling" is nearly free
    // — so the assertion that actually earns its place is that the number
    // EXISTS. A sweep that stopped reporting `historyMs` would otherwise pass
    // this file forever while the gate records printed nothing.
    expect(historyMs, 'the sweep reported no historyMs at all').toBeTypeOf('number');
    expect(historyMs).toBeGreaterThan(0);

    // Printed so the gate record can carry the number without re-running the
    // sweep: recording the runtime at every gate is what replaced the budget,
    // and a value nobody can read is not a record.
    console.log(`[sweep] historyMs=${String(historyMs)} ceiling=${String(RUNAWAY_CEILING_MS)}`);

    // The runaway ceiling. Read {@link RUNAWAY_CEILING_MS} before touching it:
    // it is not a target, and moving it up is not the same kind of act as
    // widening a budget was.
    expect(historyMs ?? Number.POSITIVE_INFINITY).toBeLessThan(RUNAWAY_CEILING_MS);
  }, 120_000);
});
