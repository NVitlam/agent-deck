// The drawer's follow-the-latest rule — v0.7.0 Phase 4, DoD 4.9b.
//
// NODE ENVIRONMENT: `drawer.ts` is a pure function of numbers. The goldens at
// `webview/goldens/drawer/follow.json` are HAND-WRITTEN from the user's rule,
// not generated — a table outside the code, so a change to the rule has to
// move a committed number (the `lane-subsets.json` precedent, and the README
// there says why that is evidence of a different kind from a second
// implementation). `inspector.phase4.test.ts` drives the component.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FOLLOW_SLACK_PX, atGrowingEnd, followTarget } from './drawer.js';
import type { FollowInput } from './drawer.js';

interface Golden {
  cases: { name: string; input: FollowInput; target: number | null }[];
  atGrowingEnd: {
    order: 'oldest' | 'newest';
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    expected: boolean;
  }[];
}

const GOLDEN = JSON.parse(readFileSync(resolve('webview/goldens/drawer/follow.json'), 'utf8')) as Golden;

describe('followTarget — the goldens', () => {
  it('covers follow, hold-when-pinned and resume-on-close, in both orders', () => {
    const names = GOLDEN.cases.map((c) => c.name);
    expect(names.some((n) => n.includes('oldest, unpinned, following'))).toBe(true);
    expect(names.some((n) => n.includes('newest, unpinned, following'))).toBe(true);
    expect(names.filter((n) => n.includes('PINNED')).length).toBe(2);
    expect(names.some((n) => n.includes('resume on close'))).toBe(true);
    expect(GOLDEN.cases).toHaveLength(10);
  });

  it.each(GOLDEN.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    // `null` in the JSON stands for a non-finite metric the DOM could hand
    // over; the type wants a number, so it is cast at the one place it enters.
    const input = {
      ...c.input,
      scrollHeight: (c.input.scrollHeight as unknown) === null ? Number.NaN : c.input.scrollHeight,
    };
    expect(followTarget(input)).toBe(c.target);
  });

  it('null and 0 are different answers, and the table uses both', () => {
    expect(GOLDEN.cases.some((c) => c.target === null)).toBe(true);
    expect(GOLDEN.cases.some((c) => c.target === 0)).toBe(true);
  });
});

describe('atGrowingEnd — where "the user is at the growing end" starts', () => {
  it.each(GOLDEN.atGrowingEnd.map((c) => [c.order, c.scrollTop, c.expected, c] as const))(
    '%s at scrollTop %i -> %s',
    (_order, _top, expected, c) => {
      expect(atGrowingEnd(c.order, c.scrollTop, c.scrollHeight, c.clientHeight)).toBe(expected);
    },
  );

  it('the slack is four pixels, and the table exercises both sides of it', () => {
    expect(FOLLOW_SLACK_PX).toBe(4);
    const oldest = GOLDEN.atGrowingEnd.filter((c) => c.order === 'oldest');
    expect(oldest.some((c) => c.expected)).toBe(true);
    expect(oldest.some((c) => !c.expected)).toBe(true);
  });
});
