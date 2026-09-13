// What F14's instants say about a run of calls — v0.8.0 Phase 7, DoD 7.3.
//
// NODE ENVIRONMENT. `call-time.ts` is a pure function of numbers, and the
// table it is checked against is HAND-WRITTEN from the rule rather than
// captured from a run — the `follow.json` precedent beside it, and the reason
// is the same: a golden a person wrote is an answer stated outside the code
// that produces it, so a change to the rule has to move a committed number.
//
// NOTHING HERE IS A PLACEHOLDER, and that is the point of the form rather than
// an omission. The DoD asks for clock values normalised; every value in this
// table is a DIFFERENCE of two instants on one record, so it carries no
// timezone, no locale and no epoch and is the same number on every machine
// that reads the same bytes. The committed inputs are deliberately absolute
// epoch milliseconds in the 1.7e12 range, so a model that forgot to subtract
// the base could not produce the committed outputs.
//
// `inspector.test.ts` drives the component that prints these numbers, and
// `inspector.phase4.test.ts` drives the live case: a running call gaining its
// end through the real patch reducer.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { callTimeline, formatOffset } from './call-time.js';
import type { CallInstants, CallTime } from './call-time.js';
import { EM_DASH } from './format.js';

interface RenderedRow {
  at: string;
  gap: string;
  end: string;
}

interface Case {
  name: string;
  calls: CallInstants[];
  rows: CallTime[];
  rendered: RenderedRow[];
}

interface Golden {
  what: string;
  cases: Case[];
  formatOffset: { ms: number | null; text: string }[];
}

const GOLDEN = JSON.parse(
  readFileSync(resolve('webview/goldens/drawer/call-time.json'), 'utf8'),
) as Golden;

describe('the golden covers the cases the rule names', () => {
  // THE VACUITY CONTROLS. Every assertion below is of the form "the model
  // agrees with the table", and a table of seven all-absent rows would be
  // agreed with by a model that returned absent for everything. These pin that
  // the table exercises each branch, by count and by content.
  it('holds seven cases, and every branch of the rule is one of them', () => {
    expect(GOLDEN.cases).toHaveLength(7);
    const names = GOLDEN.cases.map((c) => c.name);
    expect(names.some((n) => n.includes('all stated'))).toBe(true);
    expect(names.some((n) => n.includes('running'))).toBe(true);
    expect(names.some((n) => n.includes('no start'))).toBe(true);
    expect(names.some((n) => n.includes('no calls'))).toBe(true);
    expect(names.some((n) => n.includes('disagree with the run order'))).toBe(true);
  });

  it('states real numbers in every column, not only absences', () => {
    const rows = GOLDEN.cases.flatMap((c) => c.rows);
    expect(rows.filter((r) => r.atMs !== undefined).length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.endAtMs !== undefined).length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.gapMs !== undefined).length).toBeGreaterThan(0);
    // And real absences in every column, which is the half §D cares about.
    expect(rows.filter((r) => r.atMs === undefined).length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.endAtMs === undefined).length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.gapMs === undefined).length).toBeGreaterThan(0);
    // One negative gap, so the formatter's refusal is exercised by the table
    // rather than only by the unit test below.
    expect(rows.filter((r) => (r.gapMs ?? 0) < 0)).toHaveLength(1);
  });

  it('feeds the model absolute epoch instants, so subtracting the base is visible', () => {
    // A model that returned `startedAtMs` unchanged would have to produce
    // 1,700,000,001,000 where the table says 0.
    const first = GOLDEN.cases[0];
    expect(first?.calls[0]?.startedAtMs).toBeGreaterThan(1_600_000_000_000);
    expect(first?.rows[0]?.atMs).toBe(0);
  });

  it('renders at least one real figure in each of the three columns', () => {
    const rendered = GOLDEN.cases.flatMap((c) => c.rendered);
    expect(rendered.filter((r) => r.at !== EM_DASH).length).toBeGreaterThan(0);
    expect(rendered.filter((r) => r.gap !== EM_DASH).length).toBeGreaterThan(0);
    expect(rendered.filter((r) => r.end !== EM_DASH).length).toBeGreaterThan(0);
  });
});

describe('callTimeline — the goldens', () => {
  it.each(GOLDEN.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const rows = callTimeline(c.calls);
    expect(rows).toEqual(c.rows);
    // `toEqual` treats an absent key and an explicit `undefined` as the same
    // answer, which is right — but it would also let the model grow a key
    // nobody wrote down. The key SET is pinned beside the values.
    expect(rows.map((r) => Object.keys(r).sort())).toEqual(
      c.rows.map((r) => Object.keys(r).sort()),
    );
  });

  it.each(GOLDEN.cases.map((c) => [c.name, c] as const))('%s, rendered', (_name, c) => {
    const rows = callTimeline(c.calls);
    expect(
      rows.map((r) => ({
        at: formatOffset(r.atMs),
        gap: formatOffset(r.gapMs),
        end: formatOffset(r.endAtMs),
      })),
    ).toEqual(c.rendered);
  });
});

describe('the rules the table is written from', () => {
  it('the first call has no predecessor, so it has no gap — an absence, not a zero', () => {
    const rows = callTimeline([
      { id: 'a', startedAtMs: 10_000 },
      { id: 'b', startedAtMs: 10_500 },
    ]);
    expect(rows[0]?.gapMs).toBeUndefined();
    expect('gapMs' in (rows[0] as object)).toBe(false);
    expect(rows[1]?.gapMs).toBe(500);
  });

  it('the base is the EARLIEST stated start, not the first call’s', () => {
    // Run order and instants can disagree; the base is a fact about the
    // instants, so it is the minimum rather than `calls[0]`.
    const rows = callTimeline([
      { id: 'a', startedAtMs: 9_000 },
      { id: 'b', startedAtMs: 1_000 },
    ]);
    expect(rows[0]?.atMs).toBe(8_000);
    expect(rows[1]?.atMs).toBe(0);
  });

  it('a gap needs both instants, so an unstated start costs two rows their gap', () => {
    const rows = callTimeline([
      { id: 'a', startedAtMs: 1_000 },
      { id: 'b' },
      { id: 'c', startedAtMs: 3_000 },
    ]);
    expect(rows[1]?.gapMs).toBeUndefined();
    expect(rows[2]?.gapMs).toBeUndefined();
    // It does NOT reach further back for a predecessor. A gap is a function of
    // exactly two instants, and skipping a call would silently report the
    // interval across a call that happened.
    expect(rows[2]?.atMs).toBe(2_000);
  });

  it('an end with no start anywhere has no offset, because there is no base', () => {
    expect(callTimeline([{ id: 'a', endedAtMs: 5_000 }])).toEqual([{ id: 'a' }]);
  });

  it('a running call keeps its start and states no end', () => {
    const rows = callTimeline([{ id: 'a', startedAtMs: 1_000 }]);
    expect(rows[0]?.atMs).toBe(0);
    expect(rows[0]?.endAtMs).toBeUndefined();
  });
});

describe('formatOffset', () => {
  it.each(GOLDEN.formatOffset.map((c) => [c.ms, c.text] as const))('%s -> %s', (ms, text) => {
    expect(formatOffset(ms === null ? undefined : ms)).toBe(text);
  });

  it('covers the seven readings the table names, absent and negative among them', () => {
    expect(GOLDEN.formatOffset).toHaveLength(7);
    expect(GOLDEN.formatOffset.some((c) => c.ms === null)).toBe(true);
    expect(GOLDEN.formatOffset.some((c) => (c.ms ?? 0) < 0)).toBe(true);
    expect(GOLDEN.formatOffset.filter((c) => c.text === EM_DASH)).toHaveLength(2);
  });

  it('attaches the + only to a number the formatter named', () => {
    // `formatDuration` answers an em dash for a negative span. Writing `+` in
    // front of whatever came back would print `+—`, which is this surface
    // inventing a reading of a record that contradicts itself.
    expect(formatOffset(-1)).toBe(EM_DASH);
    expect(formatOffset(undefined)).toBe(EM_DASH);
    expect(formatOffset(0)).toBe('+0ms');
    expect(formatOffset(0).startsWith('+')).toBe(true);
  });
});
