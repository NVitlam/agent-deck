/**
 * ISO-week file naming, and the retention window — v0.7.0 Phase 3, DoD 3.3.
 *
 * Split out of `store.ts` deliberately: everything here is a PURE function of a
 * millisecond and a name. `store.ts` owns the filesystem; this file owns the
 * arithmetic, so the week boundary and the expiry rule can be driven at a
 * hundred instants without a temp directory, and a faked clock is the whole
 * test rather than a fixture.
 *
 * ## Why the ISO week and not the calendar month
 *
 * Spec section F names it: "JSON Lines, one file per ISO week". The size
 * measurement behind that choice is `docs/evidence/phase-0-stats/VERDICT.md`
 * 0.7 — median record 1,087 bytes, mean 2,486, max 18,007 — with a 90-day
 * projection of 1.9 MiB at the median and 30.9 MiB in the pathological case
 * where every session for ninety days is as heavy as the heaviest session in
 * every committed corpus. A week is small enough that a single file stays in
 * the low megabytes and coarse enough that ninety days is thirteen files
 * rather than ninety.
 *
 * ## The expiry rule deletes on the week's END, and that direction is chosen
 *
 * A file named for week N holds records written at any instant inside that
 * week. Judging it by the week's START would delete a file up to six days
 * before its youngest record has aged out; judging it by the END keeps a file
 * up to six days past its oldest record's expiry. Both are wrong by less than
 * a week, and only one of them deletes data the user was promised. The
 * retention setting is a floor on what is kept, not a ceiling.
 *
 * ## ISO 8601, stated rather than assumed
 *
 * Week 1 is the week containing the first Thursday of the year; weeks start on
 * Monday; a year has 52 or 53 weeks; and the week-numbering year is NOT always
 * the calendar year — 2027-01-01 is a Friday and belongs to 2026-W53. The
 * implementation below is the standard Thursday algorithm, in UTC. UTC rather
 * than local time because the file name is a durable artefact on disk: a store
 * written either side of a daylight-saving change, or carried between
 * machines, must not disagree with itself about which file a record belongs in.
 */

/** Milliseconds in a day. Named because three separate expressions used it. */
export const MS_PER_DAY = 86_400_000;

/** The week-numbering year and the week within it. */
export interface IsoWeek {
  /** The ISO week-numbering year, which is not always the calendar year. */
  year: number;
  /** 1 through 53. */
  week: number;
}

/**
 * The ISO week containing an instant, in UTC.
 *
 * The Thursday algorithm: move the date to the Thursday of its own week, and
 * the calendar year of THAT Thursday is the week-numbering year. The week
 * number is then the count of whole weeks since that year's first Thursday.
 */
export function isoWeekOf(ms: number): IsoWeek {
  const date = new Date(ms);
  // `getUTCDay()` is 0 for Sunday; ISO wants Monday=1..Sunday=7.
  const isoDay = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  const thursday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  thursday.setUTCDate(thursday.getUTCDate() + 4 - isoDay);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstIsoDay = firstThursday.getUTCDay() === 0 ? 7 : firstThursday.getUTCDay();
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstIsoDay);
  const week =
    1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
  return { year, week };
}

/**
 * The instant the Monday of an ISO week begins, in UTC.
 *
 * The inverse of {@link isoWeekOf} at week granularity, and it is what makes
 * the expiry rule computable from a FILE NAME alone — which matters because a
 * store directory may hold files this process did not write.
 */
export function isoWeekStartMs(week: IsoWeek): number {
  const firstThursday = new Date(Date.UTC(week.year, 0, 4));
  const firstIsoDay = firstThursday.getUTCDay() === 0 ? 7 : firstThursday.getUTCDay();
  // Monday of ISO week 1.
  const week1Monday = Date.UTC(week.year, 0, 4) - (firstIsoDay - 1) * MS_PER_DAY;
  return week1Monday + (week.week - 1) * 7 * MS_PER_DAY;
}

/** The instant one millisecond after an ISO week ends. */
export function isoWeekEndMs(week: IsoWeek): number {
  return isoWeekStartMs(week) + 7 * MS_PER_DAY;
}

/** The prefix and suffix every store file carries. One declaration each. */
export const STORE_FILE_PREFIX = 'stats-';
export const STORE_FILE_SUFFIX = '.jsonl';

const FILE_NAME_PATTERN = /^stats-(\d{4})-W(\d{2})\.jsonl$/u;

/** The file an instant's records belong in — `stats-2026-W37.jsonl`. */
export function storeFileName(ms: number): string {
  const { year, week } = isoWeekOf(ms);
  const padded = week < 10 ? `0${String(week)}` : String(week);
  return `${STORE_FILE_PREFIX}${String(year)}-W${padded}${STORE_FILE_SUFFIX}`;
}

/**
 * The ISO week a store file name names, or `null` when it names none.
 *
 * `null` rather than a throw, and the caller's treatment of it is the part that
 * matters: an unrecognised file in the store directory is LEFT ALONE. This
 * function decides what may be deleted, so a name it cannot read must never
 * become a deletion — the directory is under `globalStorageUri` and a future
 * version of this extension may keep something else beside these files.
 */
export function parseStoreFileName(name: string): IsoWeek | null {
  const match = FILE_NAME_PATTERN.exec(name);
  if (match === null) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return null;
  return { year, week };
}

/**
 * Which of `names` have aged out, given the clock and the window.
 *
 * Pure, total, and it never returns a name it could not parse. A
 * `retentionDays` of zero or less keeps everything rather than deleting
 * everything: the setting's bounds forbid it, and a store that erases itself
 * because a number was mistyped is the one failure mode with no undo.
 */
export function expiredFileNames(
  names: readonly string[],
  nowMs: number,
  retentionDays: number,
): string[] {
  if (retentionDays <= 0) return [];
  const cutoff = nowMs - retentionDays * MS_PER_DAY;
  const out: string[] = [];
  for (const name of names) {
    const week = parseStoreFileName(name);
    if (week === null) continue;
    if (isoWeekEndMs(week) < cutoff) out.push(name);
  }
  return out.sort();
}
