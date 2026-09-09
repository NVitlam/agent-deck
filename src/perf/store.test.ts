/**
 * v0.7.0 DoD 3.9 — the local store's append and read budgets.
 *
 * In the `perf` project (`src/perf/**`), so it runs on the forked, single-fork
 * worker with the other wall-clock assertions rather than beside 3,200 tests in
 * a shared process. `vitest.config.ts` records why that matters, and it matters
 * MORE here than for `deriveStats`: both stages below are filesystem-bound, and
 * the stage that first forced the two-project split was itself a filesystem
 * stage measuring 1050.6 ms inside the main project against 12.3 ms as a
 * separate process.
 *
 * See {@link STORE_APPEND_BUDGET} and {@link STORE_READ_BUDGET} for the
 * measurements, the subject, and — stated there rather than implied — what
 * these limits are and are not able to catch.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../stats/retention.js';
import { STORE_DIR_NAME, StatsStore } from '../stats/store.js';
import type { StoredStatsRecord } from '../stats/store.js';

import { STORE_APPEND_BUDGET, STORE_READ_BUDGET } from './budgets.js';

/** The projection VERDICT.md 0.7 confirmed the 90-day default against. */
const DAYS = 90;
const SESSIONS_PER_DAY = 20;
const RECORDS = DAYS * SESSIONS_PER_DAY;

const NOW = Date.parse('2026-09-08T13:00:00.000Z');

/**
 * A record at roughly the corpus median size.
 *
 * Padded with real-shaped table rows rather than a filler string, because
 * `JSON.stringify` on the write side and `validateStatsRecord`'s string walk on
 * the read side both cost what the SHAPE costs. One long string would make the
 * bytes right and the work wrong.
 */
function record(sessionId: string, derivedAt: number): StoredStatsRecord {
  return {
    statsSchemaVersion: 1,
    sessionId,
    engine: 'cc',
    projectSlug: 'c--ws-example',
    startedAt: derivedAt - 600_000,
    endedAt: derivedAt,
    coverage: 'full',
    agents: [
      {
        agentId: 'root',
        prompt: 42_000,
        output: 3_100,
        cacheRead: 38_000,
        cacheRatio: 0.9,
        tools: 36,
        subagents: 0,
      },
    ],
    files: Array.from({ length: 6 }, (_, i) => ({
      filePath: `/repo/src/module-${String(i)}.ts`,
      reads: 3,
      edits: 1,
      writes: 0,
      errors: 0,
      firstTouch: i,
      lastTouch: i + 10,
    })),
    tools: (['Read', 'Edit', 'Bash', 'Grep'] as const).map((toolName) => ({
      toolName,
      calls: 9,
      errors: 1,
      errorRatio: 0.111,
    })),
    loops: [],
    churn: [],
    contextChurn: [],
    compactions: [],
    stalls: [],
    totals: {
      prompt: 42_000,
      output: 3_100,
      cacheRead: 38_000,
      compactions: 0,
      subagents: 0,
      silentSubagents: 0,
      stalls: 0,
    },
    params: { loopMin: 3, spikeTokens: 5_000 },
    unavailable: ['F9:cc'],
    derivedAt,
  } as unknown as StoredStatsRecord;
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

let scratchRoot: string;
let store: StatsStore;

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'agent-deck-store-perf-'));
  store = new StatsStore({
    dir: join(scratchRoot, STORE_DIR_NAME),
    enabled: true,
    // Wide enough that the seeding cannot prune itself away — a subject that
    // deleted its own history while building it would leave both budgets
    // measuring an almost-empty store, which is the "check whose subject never
    // happens" shape this repository keeps recording.
    retentionDays: 3_650,
  });
  for (let day = 0; day < DAYS; day += 1) {
    const at = NOW - day * MS_PER_DAY;
    for (let n = 0; n < SESSIONS_PER_DAY; n += 1) {
      store.appendRecord(record(`s-${String(day)}-${String(n)}`, at));
    }
  }
}, 120_000);

afterAll(() => {
  // DoD 1c.5 — a full run leaves no scratch directory behind.
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe('the local store stays inside its budgets', () => {
  it('THE SUBJECT IS THE FULL RETENTION WINDOW — the control on both budgets', () => {
    // Neither budget below means anything over a store that turned out to be
    // empty or one file deep, and a seeding bug would produce exactly that
    // while both timings passed. So the subject is asserted first, by count.
    expect(store.appended).toBe(RECORDS);
    expect(store.files().length).toBeGreaterThanOrEqual(13);
    expect(store.refused).toBe(0);
    expect(store.stoodDown).toBe(false);
    const read = store.readRecords();
    // Every record is its own session, so the newest-per-session reduction
    // returns all of them: the read budget below is over the whole window and
    // not over a reduction that collapsed it to a handful.
    expect(read).toHaveLength(RECORDS);
    expect(store.malformed).toBe(0);
  });

  it('appends inside its budget', () => {
    const samples: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const started = performance.now();
      store.appendRecord(record(`subject-${String(i)}`, NOW));
      samples.push(performance.now() - started);
    }
    // FIRST FIVE DISCARDED, the same rule as `derive-stats.test.ts`: the first
    // appends of a process pay for module-level JIT and for the OS opening
    // this file for the first time, and a budget set from that is a budget set
    // from a state the extension is never in.
    const value = medianOf(samples.slice(5));
    process.stdout.write(
      `[perf] budget ${STORE_APPEND_BUDGET.id} (${STORE_APPEND_BUDGET.source}, enforced): ` +
        `${value.toFixed(3)} vs ${String(STORE_APPEND_BUDGET.limitMs)} ms -> ` +
        `${value <= STORE_APPEND_BUDGET.limitMs ? 'MET' : 'MISSED'}\n`,
    );
    expect(value).toBeLessThanOrEqual(STORE_APPEND_BUDGET.limitMs);
  });

  it('reads the whole history inside its budget', () => {
    const samples: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const started = performance.now();
      const out = store.readRecords();
      samples.push(performance.now() - started);
      // Inside the loop rather than outside it: a read that started returning
      // nothing would be very fast and would pass a timing assertion.
      expect(out.length).toBeGreaterThanOrEqual(RECORDS);
    }
    const value = medianOf(samples.slice(2));
    process.stdout.write(
      `[perf] budget ${STORE_READ_BUDGET.id} (${STORE_READ_BUDGET.source}, enforced): ` +
        `${value.toFixed(3)} vs ${String(STORE_READ_BUDGET.limitMs)} ms -> ` +
        `${value <= STORE_READ_BUDGET.limitMs ? 'MET' : 'MISSED'}\n`,
    );
    expect(value).toBeLessThanOrEqual(STORE_READ_BUDGET.limitMs);
  });

  it('the recorded margins are the recorded numbers, divided', () => {
    // The self-consistency check every other budget carries: a note claiming a
    // margin the two numbers do not produce is a number written from memory
    // rather than measured.
    for (const budget of [STORE_APPEND_BUDGET, STORE_READ_BUDGET]) {
      expect(budget.measured.valueMs, budget.id).toBeGreaterThan(0);
      expect(budget.limitMs / budget.measured.valueMs, budget.id).toBeCloseTo(
        budget.measured.marginX,
        1,
      );
      expect(budget.enforced, budget.id).toBe(true);
    }
  });
});
