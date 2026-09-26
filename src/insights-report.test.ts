/**
 * v0.9.0 DoD 9.59 — every evidence value whose `statsKey` ends in `Ms` is
 * printed as `<raw> ms · <duration>`, spec `Amendment 2026-09-26 — Facts for
 * report quality`.
 *
 * The rendering lives in ONE function (`reportOf` → `evidenceValue`), which
 * the preview and all three exports read, so the per-format goldens
 * (`insights-export.test.ts`, the `mixed-evidence` set) and the surface
 * goldens (`insights-facts.test.ts`, `surfaces.test.ts`) carry it. This file
 * holds the formatter's own table and the report's use of it.
 */

import { describe, expect, it } from 'vitest';

import { evidenceValue, formatDuration, formatMs, isMsKey, reportOf } from './insights-report.js';
import { REPORT_SETS } from './insights-report.testkit.js';

describe('formatDuration — at most two units, truncated, deterministic', () => {
  it.each([
    [0, 'under 1 s'],
    [999, 'under 1 s'],
    [1_000, '1 s'],
    [59_999, '59 s'],
    [60_000, '1 m'],
    [90_500, '1 m 30 s'],
    [3_599_999, '59 m 59 s'],
    [3_600_000, '1 h'],
    [28_100_113, '7 h 48 m'],
    [86_399_999, '23 h 59 m'],
    [86_400_000, '1 d'],
    [90_000_000, '1 d 1 h'],
    [-90_500, '-1 m 30 s'],
  ])('%d ms reads %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('formatMs — the raw number whole, then the duration', () => {
  it('reads as the amendment writes it', () => {
    expect(formatMs(28_100_113)).toBe('28,100,113 ms · 7 h 48 m');
  });

  it('drops nothing from the raw number: a fraction stays, ungrouped after the point', () => {
    expect(formatMs(1_234.5)).toBe('1,234.5 ms · 1 s');
    expect(formatMs(0.123456)).toBe('0.123456 ms · under 1 s');
  });
});

describe('evidenceValue — only a number at a key ending in `Ms`', () => {
  it('a `...Ms` number carries its duration', () => {
    expect(evidenceValue('sessions[0].timing.longestGapMs', 28_100_113)).toBe('28,100,113 ms · 7 h 48 m');
    expect(evidenceValue('sessions[1].contextChurn[0].gapBeforeMs', 312_450)).toBe('312,450 ms · 5 m 12 s');
  });

  it('`durationMsSum` does not end in `Ms`, and any other number prints as stated', () => {
    expect(isMsKey('sessions[0].tools[0].durationMsSum')).toBe(false);
    expect(evidenceValue('sessions[0].tools[0].durationMsSum', 90_500)).toBe('90500');
    expect(evidenceValue('sessions[0].totals.prompt', 128_400)).toBe('128400');
  });

  it('a string is printed as the provider stated it', () => {
    expect(evidenceValue('sessions[0].files[0].filePath', 'repo/a.ts')).toBe('repo/a.ts');
  });
});

describe('the report uses it, and provenance is untouched', () => {
  it('the mixed-evidence set: the two `...Ms` rows gain a duration, the source line is the statsKey as stated', () => {
    const [finding] = reportOf(REPORT_SETS['mixed-evidence']).findings;
    const byLabel = new Map(finding?.evidence.map((row) => [row.label, row]));
    expect(byLabel.get('Longest gap')).toStrictEqual({
      label: 'Longest gap',
      value: '28,100,113 ms · 7 h 48 m',
      source: 'sessions[0].timing.longestGapMs · ses_example01',
    });
    expect(byLabel.get('Gap before spike')?.value).toBe('312,450 ms · 5 m 12 s');
    expect(byLabel.get('Duration sum')?.value).toBe('90500');
    expect(byLabel.get('Reads')?.value).toBe('7');
  });
});
