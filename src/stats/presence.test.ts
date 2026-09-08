/**
 * DoD 2.6 — F9, F10 and F12 are present ONLY when the data states them.
 *
 * The three cost sources, their precedence, and the rule that a golden without
 * the input carries no key at all — not a zero, and not a null. The existing
 * contract already says `costUsd: 0` means *not computed*, so a zero here would
 * be indistinguishable from a session nobody priced.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { CORPUS_READ_BUDGET_MS } from './corpus.testkit.js';
import { allGoldenEntries } from './corpus.stats.testkit.js';
import type { GoldenEntry } from './corpus.stats.testkit.js';
import { deriveStats } from './derive.js';
import { costOfSeries, parsePricing } from './pricing.js';
import type { StatsRecord } from './schema.js';
import { SYNTHETIC_NOW_MS, SYNTHETIC_PRICING, buildSyntheticStatsFixtures } from './synthetic.testkit.js';

const { table: PRICING } = parsePricing(SYNTHETIC_PRICING);

function fixture(id: string) {
  const found = buildSyntheticStatsFixtures().find((f) => f.id === id);
  if (found === undefined) throw new Error(`no fixture ${id}`);
  return found;
}

function derived(id: string): StatsRecord {
  return deriveStats(fixture(id).state, { pricing: PRICING, now: SYNTHETIC_NOW_MS });
}

describe('F9(a) — engine-reported cost', () => {
  it('a non-zero session cost is reported with costSource engine', () => {
    const record = derived('09-opencode-cost');
    expect(record.totals.costUsd).toBe(0.4237);
    expect(record.totals.costSource).toBe('engine');
  });

  it('a cost of ZERO is not a cost — the corpora prove the case is real', () => {
    // VERDICT.md 0.4: OpenCode's `session.cost` is 0 across all three committed
    // stores and 30 sessions, and `costUsd: 0` means *not computed* under the
    // existing contract. Reading that zero as a figure would put a confident
    // $0.00 on every OpenCode session in the product.
    const zeroed = { ...fixture('09-opencode-cost').state, totals: { costUsd: 0 } };
    const record = deriveStats(zeroed, { now: 1 });
    expect(record.totals).not.toHaveProperty('costUsd');
    expect(record.totals).not.toHaveProperty('costSource');
    expect(record.unavailable).toContain('F9:opencode');
  });
});

describe('F9(b) — the user’s own prices', () => {
  it('equals the hand-computed sum over the usage series', () => {
    // Hand-computed, and the arithmetic is written out so a reader can check it
    // without running anything. Prices are USD per MILLION tokens.
    //
    //   turn 0: input 1,000,000 x $3.00  = $3.00
    //   turn 1: cacheCreation 1,000,000 x $3.75 = $3.75
    //           cacheRead     1,000,000 x $0.30 = $0.30
    //           output        1,000,000 x $15.00 = $15.00
    //                                     total = $22.05
    const record = derived('11-user-priced');
    expect(record.totals.costUsd).toBeCloseTo(22.05, 10);
    expect(record.totals.costSource).toBe('user');
    expect(record.agents[0]?.model).toBe('synthetic-model-a');
  });

  it('the model id must match EXACTLY — a near miss prices nothing', () => {
    const { table } = parsePricing({ 'synthetic-model-A': SYNTHETIC_PRICING['synthetic-model-a'] });
    const record = deriveStats(fixture('11-user-priced').state, { pricing: table, now: 1 });
    expect(record.totals).not.toHaveProperty('costUsd');
    expect(record.unavailable).toContain('F9:cc');
  });

  it('the default empty table prices nothing at all', () => {
    // `agentDeck.pricing` is `{}` by default, and this repository ships no
    // prices. Every corpus golden is derived this way.
    const record = deriveStats(fixture('11-user-priced').state, { now: 1 });
    expect(record.totals).not.toHaveProperty('costUsd');
  });

  it('a malformed entry is ignored, and the record says so', () => {
    const { table, invalid } = parsePricing({
      'synthetic-model-a': { prompt: '3', cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
      'another-model': { prompt: 1, cacheRead: 1, cacheWrite: 1, output: -1 },
    });
    expect(invalid).toEqual(['another-model', 'synthetic-model-a']);
    expect(table.size).toBe(0);
    const record = deriveStats(fixture('11-user-priced').state, {
      pricing: table,
      pricingInvalid: invalid,
      now: 1,
    });
    expect(record.unavailable).toContain('F9:user-pricing-invalid');
    expect(record.totals).not.toHaveProperty('costUsd');
    // ONE code however many entries were malformed: the ids are user-authored
    // strings and have no business on the G4 allow-list.
    expect(record.unavailable.filter((u) => u === 'F9:user-pricing-invalid')).toHaveLength(1);
  });

  it('parsePricing refuses every malformed shape without throwing', () => {
    for (const value of [null, 42, 'prices', [], { m: null }, { m: {} }, { m: { prompt: 1 } }]) {
      expect(() => parsePricing(value)).not.toThrow();
      expect(parsePricing(value).table.size).toBe(0);
    }
    expect(costOfSeries(undefined, 'm', PRICING)).toBeUndefined();
    expect(costOfSeries([], undefined, PRICING)).toBeUndefined();
  });
});

describe('F9(c) — Claude Code’s own telemetry estimate', () => {
  it('a joined telemetry cost is reported with costSource telemetry', () => {
    const record = derived('13-telemetry-cost');
    expect(record.totals.costSource).toBe('telemetry');
    expect(record.totals.costUsd).toBeGreaterThan(0);
    // The figure comes from the committed OTel capture through the real
    // `joinTelemetry`, not from a number written here — which is why this
    // asserts the source and a floor rather than a literal that would have to
    // be re-copied on every re-harvest.
    expect(record.totals.costUsd).toBe(fixture('13-telemetry-cost').state.telemetryCostUsd);
  });
});

describe('F9 precedence — engine > telemetry > user', () => {
  const base = fixture('11-user-priced').state;

  it('engine wins over both, and the losers are recorded', () => {
    const record = deriveStats(
      { ...base, totals: { costUsd: 9 }, telemetryCostUsd: 5 },
      { pricing: PRICING, now: 1 },
    );
    expect(record.totals.costUsd).toBe(9);
    expect(record.totals.costSource).toBe('engine');
    expect(record.unavailable).toContain('F9:telemetry-present');
    expect(record.unavailable).toContain('F9:user-present');
  });

  it('telemetry wins over user', () => {
    const record = deriveStats(
      { ...base, telemetryCostUsd: 5 },
      { pricing: PRICING, now: 1 },
    );
    expect(record.totals.costUsd).toBe(5);
    expect(record.totals.costSource).toBe('telemetry');
    expect(record.unavailable).toContain('F9:user-present');
    expect(record.unavailable).not.toContain('F9:telemetry-present');
  });

  it('with one source only, nothing is recorded as losing', () => {
    const record = deriveStats(base, { pricing: PRICING, now: 1 });
    expect(record.totals.costSource).toBe('user');
    expect(record.unavailable.filter((u) => u.endsWith('-present'))).toEqual([]);
  });
});

describe('DoD 2.6 — across every committed golden', () => {
  let entries: GoldenEntry[] = [];

  beforeAll(async () => {
    entries = await allGoldenEntries();
  }, CORPUS_READ_BUDGET_MS);

  it('only the three cost fixtures carry a costUsd key', () => {
    const withCost = entries.filter((e) => e.record.totals.costUsd !== undefined);
    expect(withCost.map((e) => e.stem).sort()).toEqual([
      'cc-synthetic-11-user-priced',
      'cc-synthetic-13-telemetry-cost',
      'opencode-synthetic-09-opencode-cost',
    ]);
    // And every one of them names its source, which the validator also pins as
    // a biconditional.
    for (const entry of withCost) expect(entry.record.totals.costSource).toBeDefined();
  });

  it('only sessions stating a window carry contextFill', () => {
    const withFill = entries.filter((e) => e.record.totals.contextFill !== undefined);
    expect(withFill.length).toBeGreaterThan(0);
    for (const entry of withFill) expect(entry.record.engine).toBe('codex');
    for (const entry of entries) {
      if (entry.record.engine === 'codex') continue;
      if (entry.record.coverage !== 'full') continue;
      expect(entry.record.totals).not.toHaveProperty('contextFill');
      expect(entry.record.unavailable).toContain(`F10:${entry.record.engine}`);
    }
  });

  it('compaction lists are empty except where an engine wrote an entry', () => {
    const withCompaction = entries.filter((e) => e.record.compactions.length > 0);
    // Real ones from the corpora plus the manufactured one. A floor rather than
    // an equality: the count moves with the next harvest.
    expect(withCompaction.length).toBeGreaterThan(2);
    for (const entry of withCompaction) {
      expect(entry.record.totals.compactions).toBe(entry.record.compactions.length);
      // No Codex payload type carries a compaction entry.
      expect(entry.record.engine).not.toBe('codex');
    }
    for (const entry of entries) {
      if (entry.record.compactions.length > 0) continue;
      expect(entry.record.totals.compactions).toBe(0);
    }
  });

  it('every full record names its engine’s gaps, and no excluded record names any', () => {
    for (const entry of entries) {
      if (entry.record.coverage === 'full') {
        expect(entry.record.unavailable.length).toBeGreaterThan(0);
        if (entry.record.engine === 'codex') {
          expect(entry.record.unavailable).toEqual(
            expect.arrayContaining(['F1:codex', 'F2.errors:codex', 'F4:codex', 'F12:codex']),
          );
        }
      } else {
        // An excluded record has no facts at all, so it has no per-fact gaps to
        // report: `coverage` is the single reason, stated once.
        expect(entry.record.unavailable).toEqual([]);
      }
    }
  });
});
