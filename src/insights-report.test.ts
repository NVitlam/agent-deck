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

import { evidenceText, evidenceValue, formatDuration, formatMs, isMsKey, reportOf } from './insights-report.js';
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

describe('evidenceValue — every key whose last segment carries `Ms` as a word (round 9b)', () => {
  it('a `...Ms` number carries its duration', () => {
    expect(evidenceValue('sessions[0].timing.longestGapMs', 28_100_113)).toBe('28,100,113 ms · 7 h 48 m');
    expect(evidenceValue('sessions[1].contextChurn[0].gapBeforeMs', 312_450)).toBe('312,450 ms · 5 m 12 s');
  });

  it('`durationMsSum` and `durationMsMax` render as `longestGapMs` does (the v3 smoke found them raw)', () => {
    expect(isMsKey('sessions[0].tools[0].durationMsSum')).toBe(true);
    expect(isMsKey('sessions[0].tools[0].durationMsMax')).toBe(true);
    expect(evidenceValue('sessions[0].tools[0].durationMsSum', 90_500)).toBe('90,500 ms · 1 m 30 s');
    expect(evidenceValue('sessions[0].tools[0].durationMsMax', 61_250)).toBe('61,250 ms · 1 m 1 s');
  });

  it('`Ms` must be a WORD of the last segment: not a prefix of a lower-case run, not an earlier segment', () => {
    for (const key of ['sessions[0].totals.prompt', 'sessions[0].items.Msgs', 'sessions[0].timingMs.count']) {
      expect(isMsKey(key), key).toBe(false);
    }
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
    expect(byLabel.get('Duration sum')?.value).toBe('90,500 ms · 1 m 30 s');
    expect(byLabel.get('Reads')?.value).toBe('7');
  });
});

describe('round 9b — floats rounded, the exact value kept beside', () => {
  it.each([
    ['sessions[0].totals.costUsd', 0.238149, '0.24', '0.238149'],
    ['sessions[0].timing.costPerHourUsd', 0.37125, '0.37', '0.37125'],
    ['sessions[0].agents[0].cacheRatio', 0.8234567, '0.82', '0.8234567'],
    ['sessions[0].totals.contextFill', 1.4567, '1.46', '1.4567'],
    ['sessions[0].timing.tokensPerMin', 1_234.5678, '1,235', '1234.5678'],
    ['sessions[0].timing.callsPerMin', 2.49, '2', '2.49'],
  ])('%s = %d prints %s, exact %s', (key, value, shown, exact) => {
    expect(evidenceText(key, value)).toStrictEqual({ value: shown, exact });
  });

  it('a value the rounding leaves unchanged carries no exact', () => {
    expect(evidenceText('sessions[0].timing.callsPerMin', 3)).toStrictEqual({ value: '3' });
    expect(evidenceText('sessions[0].totals.contextFill', 0.25)).toStrictEqual({ value: '0.25' });
  });

  it('an integer count and a string are untouched, and carry no exact', () => {
    expect(evidenceText('sessions[0].loops[0].count', 7)).toStrictEqual({ value: '7' });
    expect(evidenceText('sessions[0].files[0].filePath', 'repo/a.ts')).toStrictEqual({ value: 'repo/a.ts' });
  });

  it('the report carries the exact beside the rounded value, on the mixed-evidence set', () => {
    const [finding] = reportOf(REPORT_SETS['mixed-evidence']).findings;
    const byLabel = new Map(finding?.evidence.map((row) => [row.label, row]));
    expect(byLabel.get('Cost')).toStrictEqual({
      label: 'Cost',
      value: '0.24',
      exact: '0.238149',
      source: 'sessions[0].totals.costUsd · ses_example01',
    });
    expect(byLabel.get('Tokens per minute')).toMatchObject({ value: '1,235', exact: '1234.5678' });
    expect(byLabel.get('Context fill')).toStrictEqual({
      label: 'Context fill',
      value: '0.40',
      exact: '0.4',
      source: 'sessions[0].totals.contextFill · ses_example01',
    });
    expect(byLabel.get('Duration max')?.value).toBe('61,250 ms · 1 m 1 s');
    expect(byLabel.get('Reads')).not.toHaveProperty('exact');
  });
});
