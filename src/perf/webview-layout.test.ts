/**
 * v0.7.0 DoD 4.10 — named budgets for the two pure webview computations Phase 4
 * added: `fit()` and `statsLayout()`.
 *
 * In the `perf` project (forked, single-fork worker), like every wall-clock
 * assertion here. Both subjects are pure functions of their inputs, so the
 * measurement is the function and nothing else; see {@link WEBVIEW_FIT_BUDGET}
 * and {@link STATS_LAYOUT_BUDGET} for the numbers each was set from.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { StatsRecord } from '../stats/schema.js';
import { treeLayout } from '../../webview/layout.js';
import { fit } from '../../webview/layout/fit.js';
import { statsLayout } from '../../webview/stats/layout.js';
import { boundsOf } from '../../webview/viewport.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- a plain .mjs script with no declarations.
import { sessionOf } from '../../scripts/gen-webview-goldens.mjs';

import { STATS_LAYOUT_BUDGET, WEBVIEW_FIT_BUDGET } from './budgets.js';

const GOLDEN_DIR = fileURLToPath(new URL('../../fixtures/golden/stats/', import.meta.url));

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function measure(label: { id: string; source: string; limitMs: number }, fn: () => void, samples = 45): number {
  const timings: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    fn();
    timings.push(performance.now() - started);
  }
  // First five discarded as JIT warm-up, the `derive-stats.test.ts` rule.
  const value = medianOf(timings.slice(5));
  process.stdout.write(
    `[perf] budget ${label.id} (${label.source}, enforced): ` +
      `${value.toFixed(3)} vs ${String(label.limitMs)} ms -> ${value <= label.limitMs ? 'MET' : 'MISSED'}\n`,
  );
  return value;
}

describe('DoD 4.10 — fit() over the 40-node subject', () => {
  const placements = treeLayout(sessionOf(40) as never, 'root', { collapseDepth: Number.POSITIVE_INFINITY }).filter(
    (p) => !p.hidden,
  );
  const bounds = boundsOf(placements.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })));
  const viewport = { width: 1600, height: 900 };
  const drawer = { x: 0, y: 710, w: 1600, h: 190 };

  it('the subject is the wrapped 40-node tree (vacuity control)', () => {
    expect(placements).toHaveLength(40);
    expect(bounds.w).toBeGreaterThan(8 * 168);
  });

  it('fits inside its budget', () => {
    const value = measure(WEBVIEW_FIT_BUDGET, () => {
      // The whole per-trigger cost: the bounds walk AND the fit, because a
      // trigger pays both.
      fit(boundsOf(placements.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }))), viewport, drawer);
    });
    expect(value).toBeLessThanOrEqual(WEBVIEW_FIT_BUDGET.limitMs);
  });

  it('the recorded margin is the recorded numbers, divided', () => {
    expect(WEBVIEW_FIT_BUDGET.measured.valueMs).toBeGreaterThan(0);
    expect(WEBVIEW_FIT_BUDGET.limitMs / WEBVIEW_FIT_BUDGET.measured.valueMs).toBeCloseTo(
      WEBVIEW_FIT_BUDGET.measured.marginX,
      0,
    );
  });
});

describe('DoD 4.10 — statsLayout() over the committed corpus records', () => {
  const records = readdirSync(GOLDEN_DIR)
    .filter((n) => n.endsWith('.json') && !n.includes('-synthetic-'))
    .sort()
    .map((n) => JSON.parse(readFileSync(`${GOLDEN_DIR}${n}`, 'utf8')) as StatsRecord);

  it('the subject is every harvested record, and the layout is not empty (vacuity control)', () => {
    expect(records.length).toBeGreaterThanOrEqual(12);
    const layout = statsLayout(records);
    expect(layout.files.rows.length).toBeGreaterThan(50);
    // One covered session per COVERED record: a parked corpus session is
    // excluded by G3 and appears in the footer count, not in the tables.
    expect(layout.tokens.sessions.length).toBe(records.filter((r) => r.coverage === 'full').length);
    expect(layout.excluded.count).toBeGreaterThan(0);
  });

  it('lays out inside its budget', () => {
    const value = measure(STATS_LAYOUT_BUDGET, () => {
      statsLayout(records);
    });
    expect(value).toBeLessThanOrEqual(STATS_LAYOUT_BUDGET.limitMs);
  });

  it('the recorded margin is the recorded numbers, divided', () => {
    expect(STATS_LAYOUT_BUDGET.measured.valueMs).toBeGreaterThan(0);
    expect(STATS_LAYOUT_BUDGET.limitMs / STATS_LAYOUT_BUDGET.measured.valueMs).toBeCloseTo(
      STATS_LAYOUT_BUDGET.measured.marginX,
      0,
    );
  });
});
