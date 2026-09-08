/**
 * F9(b) — the user's own price table, parsed and validated.
 *
 * v0.7.0 Phase 2, DoD 2.6.
 *
 * ## THIS REPOSITORY SHIPS NO PRICES, AND THAT IS A NON-GOAL RATHER THAN A GAP
 *
 * Spec §B: *"No shipped price table. `costUsd: 0` still means not computed; the
 * repo holds no prices and a model-to-price map would be memory, which G6
 * forbids."* Every number this module multiplies by comes from the user's own
 * `agentDeck.pricing` setting, which is `{}` by default. There is no fallback
 * table, no provider menu, and no "typical" price anywhere in this file — a
 * subscription plan is flat-rate and yields no per-token number at all.
 *
 * ## Units, stated because getting them wrong is invisible
 *
 * The setting is **USD per MILLION tokens**, per §F. A table written in USD per
 * token would produce a cost a million times too large and nothing would catch
 * it but a human reading the number, so the divisor is named
 * ({@link TOKENS_PER_PRICE_UNIT}) rather than written as a literal at the one
 * site that uses it.
 *
 * ## A malformed entry is IGNORED and REPORTED, never repaired
 *
 * §F: *"a malformed entry is ignored and reported on the diagnostics channel,
 * never guessed."* Coercing `"3.00"` to `3` would be the guess; dropping the
 * entry and naming it is the refusal. The record then carries
 * `F9:user-pricing-invalid` in `unavailable`, so a user whose cost is missing
 * can tell a typo from an engine that states nothing — which is rule 18's
 * "a check that skips an input must say so", applied to a setting.
 */

import type { UsageTurn } from '../model/events.js';

/** The divisor: prices are quoted per million tokens. */
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** One model's four prices, in USD per million tokens. */
export interface ModelPrices {
  prompt: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** The parsed setting: model id -> prices. Ids are matched EXACTLY. */
export type PricingTable = ReadonlyMap<string, ModelPrices>;

/** What {@link parsePricing} found, including what it refused. */
export interface PricingParse {
  table: PricingTable;
  /** Model ids whose entry was malformed and therefore dropped. */
  invalid: string[];
}

const PRICE_KEYS = ['prompt', 'cacheRead', 'cacheWrite', 'output'] as const;

/**
 * A price must be a finite, non-negative number.
 *
 * Negative is rejected as well as non-numeric, and it is not a theoretical
 * case: a table written by hand is as likely to carry a typo'd minus as a
 * string, and a negative price yields a negative cost, which is not a value
 * this record has any way to mean.
 */
function isPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Parse the `agentDeck.pricing` setting.
 *
 * Total by construction: any shape at all may arrive here, because the value
 * comes from a user's `settings.json` and VS Code validates nothing beyond the
 * declared JSON type. A non-object yields an empty table rather than throwing,
 * which is G3 applied to configuration — refuse, do not crash, and say what was
 * refused.
 */
export function parsePricing(value: unknown): PricingParse {
  const table = new Map<string, ModelPrices>();
  const invalid: string[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { table, invalid };
  }
  for (const [modelId, entry] of Object.entries(value)) {
    if (modelId === '' || entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      invalid.push(modelId);
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (!PRICE_KEYS.every((key) => isPrice(record[key]))) {
      invalid.push(modelId);
      continue;
    }
    table.set(modelId, {
      prompt: record['prompt'] as number,
      cacheRead: record['cacheRead'] as number,
      cacheWrite: record['cacheWrite'] as number,
      output: record['output'] as number,
    });
  }
  invalid.sort();
  return { table, invalid };
}

/**
 * F9(b) — the cost of one agent's usage series under one model's prices.
 *
 * The mapping from the series to the four prices, stated because it is the
 * whole arithmetic:
 *
 *     input          -> prompt      (fresh prompt tokens)
 *     cacheCreation  -> cacheWrite  (tokens written INTO the cache)
 *     cacheRead      -> cacheRead   (tokens served FROM it)
 *     output         -> output
 *
 * `undefined` when the agent states no model, or when the user has no entry
 * for that model. Both are ordinary — the default table is empty — and neither
 * is an error.
 */
export function costOfSeries(
  series: readonly UsageTurn[] | undefined,
  model: string | undefined,
  prices: PricingTable,
): number | undefined {
  if (series === undefined || model === undefined) return undefined;
  const entry = prices.get(model);
  if (entry === undefined) return undefined;
  let micro = 0;
  for (const turn of series) {
    micro += turn.input * entry.prompt;
    micro += turn.cacheCreation * entry.cacheWrite;
    micro += turn.cacheRead * entry.cacheRead;
    micro += turn.output * entry.output;
  }
  return micro / TOKENS_PER_PRICE_UNIT;
}
