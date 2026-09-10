/**
 * DoD 3.3 — retention, and the ISO-week naming it rests on. Faked clock only.
 *
 * Everything in `retention.ts` is a pure function of a millisecond or a name,
 * so every test here is a faked clock by construction: there is no filesystem,
 * no store and no `Date.now()` anywhere in the module. `store.test.ts` drives
 * the same rule through real files; this file drives the ARITHMETIC, which is
 * where the interesting cases are and where a temp directory would only make
 * them slower to write.
 *
 * ## The cases that are actually hard
 *
 * ISO 8601's week-numbering year is not the calendar year, and the boundary
 * cases are the ones a hand-rolled implementation gets wrong:
 *
 *   - 2027-01-01 is a Friday and belongs to **2026-W53**;
 *   - 2026-01-01 is a Thursday and belongs to **2026-W01**;
 *   - 2021-01-01 is a Friday and belongs to **2020-W53**;
 *   - 2023-01-01 is a Sunday and belongs to **2022-W52**.
 *
 * Each is asserted below against the value the standard states, not against
 * what this implementation happens to produce.
 */

import { describe, expect, it } from 'vitest';

import {
  MS_PER_DAY,
  expiredFileNames,
  isoWeekEndMs,
  isoWeekOf,
  isoWeekStartMs,
  parseStoreFileName,
  storeFileName,
} from './retention.js';

const at = (iso: string): number => Date.parse(iso);

describe('ISO week numbering', () => {
  it('puts the new-year boundary dates in the week the standard says', () => {
    // Written as a table so the expectation is the STANDARD's answer rather
    // than a transcription of the implementation.
    const cases: { date: string; year: number; week: number }[] = [
      { date: '2026-01-01T00:00:00.000Z', year: 2026, week: 1 },
      { date: '2027-01-01T00:00:00.000Z', year: 2026, week: 53 },
      { date: '2021-01-01T00:00:00.000Z', year: 2020, week: 53 },
      { date: '2023-01-01T00:00:00.000Z', year: 2022, week: 52 },
      { date: '2026-09-08T13:00:00.000Z', year: 2026, week: 37 },
      { date: '2024-12-30T00:00:00.000Z', year: 2025, week: 1 },
    ];
    for (const c of cases) {
      expect(isoWeekOf(at(c.date)), c.date).toStrictEqual({ year: c.year, week: c.week });
    }
  });

  it('a week starts on Monday and lasts exactly seven days', () => {
    const week = isoWeekOf(at('2026-09-08T13:00:00.000Z'));
    const start = isoWeekStartMs(week);
    expect(new Date(start).getUTCDay(), 'week start is not a Monday').toBe(1);
    expect(isoWeekEndMs(week) - start).toBe(7 * MS_PER_DAY);
    // And the instant we asked about is inside its own week, which is the
    // round trip the expiry rule depends on.
    const asked = at('2026-09-08T13:00:00.000Z');
    expect(asked).toBeGreaterThanOrEqual(start);
    expect(asked).toBeLessThan(isoWeekEndMs(week));
  });

  it('every instant across four years lands in a week that contains it', () => {
    // The property, swept rather than sampled: 1,460 days at noon. A
    // hand-rolled Thursday algorithm that is off by one only at a year
    // boundary passes any three hand-picked dates.
    let checked = 0;
    for (let day = 0; day < 1_460; day += 1) {
      const ms = at('2023-01-01T12:00:00.000Z') + day * MS_PER_DAY;
      const week = isoWeekOf(ms);
      expect(ms, `day ${String(day)}`).toBeGreaterThanOrEqual(isoWeekStartMs(week));
      expect(ms, `day ${String(day)}`).toBeLessThan(isoWeekEndMs(week));
      expect(week.week).toBeGreaterThanOrEqual(1);
      expect(week.week).toBeLessThanOrEqual(53);
      checked += 1;
    }
    expect(checked).toBe(1_460);
  });
});

describe('store file names', () => {
  it('names a file for the ISO week of the instant, zero-padded', () => {
    expect(storeFileName(at('2026-09-08T13:00:00.000Z'))).toBe('stats-2026-W37.jsonl');
    expect(storeFileName(at('2026-01-01T00:00:00.000Z'))).toBe('stats-2026-W01.jsonl');
    expect(storeFileName(at('2027-01-01T00:00:00.000Z'))).toBe('stats-2026-W53.jsonl');
  });

  it('sorts lexically in chronological order — the property `files()` relies on', () => {
    // `StatsStore.files()` sorts by NAME and treats that as chronological. It
    // is only allowed to do that because of the padding, so the padding is
    // asserted as an ORDERING rather than as a string shape.
    const names = [
      at('2025-12-29T00:00:00.000Z'),
      at('2026-01-05T00:00:00.000Z'),
      at('2026-03-02T00:00:00.000Z'),
      at('2026-09-08T00:00:00.000Z'),
      at('2026-12-28T00:00:00.000Z'),
    ].map(storeFileName);
    expect([...names].sort()).toStrictEqual(names);
  });

  it('round-trips through the parser, and refuses everything else', () => {
    const name = storeFileName(at('2026-09-08T13:00:00.000Z'));
    expect(parseStoreFileName(name)).toStrictEqual({ year: 2026, week: 37 });
    for (const other of [
      'stats.jsonl',
      'stats-2026-W00.jsonl',
      'stats-2026-W54.jsonl',
      'stats-26-W37.jsonl',
      'stats-2026-W7.jsonl',
      'stats-2026-W37.json',
      'notes.txt',
      '',
    ]) {
      expect(parseStoreFileName(other), other).toBeNull();
    }
  });
});

describe('DoD 3.3: expiry, on a faked clock', () => {
  const NOW = at('2026-09-08T13:00:00.000Z');

  it('deletes a week that ended more than retentionDays ago and keeps the rest', () => {
    const names = [
      storeFileName(NOW),
      storeFileName(NOW - 30 * MS_PER_DAY),
      storeFileName(NOW - 100 * MS_PER_DAY),
      storeFileName(NOW - 400 * MS_PER_DAY),
    ];
    expect(expiredFileNames(names, NOW, 90)).toStrictEqual(
      [storeFileName(NOW - 100 * MS_PER_DAY), storeFileName(NOW - 400 * MS_PER_DAY)].sort(),
    );
    // The vacuity control on the same corpus: a window wide enough keeps
    // everything, so the list above is a decision rather than a constant.
    expect(expiredFileNames(names, NOW, 3_650)).toStrictEqual([]);
  });

  it('judges a file by the END of its week, which is the safe direction', () => {
    // A file whose week ENDED exactly at the cutoff is kept; one whose week
    // ended a millisecond earlier goes. Stated on the boundary because that is
    // the only place the start-versus-end choice is observable, and choosing
    // the start would delete a file up to six days before its youngest record
    // had aged out.
    const week = isoWeekOf(at('2026-01-05T00:00:00.000Z'));
    const name = storeFileName(isoWeekStartMs(week));
    const endedAt = isoWeekEndMs(week);
    const days = 90;

    const keepNow = endedAt + days * MS_PER_DAY;
    expect(expiredFileNames([name], keepNow, days), 'at the cutoff it is kept').toStrictEqual([]);
    expect(expiredFileNames([name], keepNow + 1, days), 'one ms past it goes').toStrictEqual([
      name,
    ]);
  });

  it('never returns a name it could not parse — an unknown file is left alone', () => {
    // The store deletes exactly what this returns, so a name this cannot read
    // must never become a deletion: `globalStorage` is the extension's own
    // directory and a later version may keep something else beside these files.
    const foreign = ['README.md', 'index.db', 'stats-backup.jsonl', 'stats-2026-W99.jsonl'];
    expect(expiredFileNames(foreign, NOW + 400 * MS_PER_DAY, 1)).toStrictEqual([]);
    // And the control: a real name in the same call IS returned, so the empty
    // result above is about the names and not about the call.
    const real = storeFileName(NOW - 400 * MS_PER_DAY);
    expect(expiredFileNames([...foreign, real], NOW, 90)).toStrictEqual([real]);
  });

  it('a retention window of zero or less keeps everything, it does not erase everything', () => {
    // The settings bounds forbid it, so this is the second gate. A store that
    // erased itself because a number was mistyped is the one failure here with
    // no undo, and `readSettings` falling back to the default is a promise
    // about ONE caller — this function is called by the store directly.
    const names = [storeFileName(NOW - 4_000 * MS_PER_DAY), storeFileName(NOW)];
    expect(expiredFileNames(names, NOW, 0)).toStrictEqual([]);
    expect(expiredFileNames(names, NOW, -1)).toStrictEqual([]);
  });
});
