/**
 * The zoom step — v0.9.0 DoD 9.14, spec `Amendment 2026-09-20 — Clean
 * windows`, §Zoom: "The wheel step is reduced to a measured value, and that
 * value is locked here by a golden. Pinch and ctrl-wheel obey the same law."
 *
 * ## What was wrong
 *
 * Every wheel EVENT was one notch of ten per cent. A mouse emits one event
 * per detent, so a mouse was fine; a trackpad emits a burst of small events
 * per flick, so a flick crossed the whole zoom range. The own-eyes pass
 * called the sensitivity far too high.
 *
 * ## What replaced it, and why these two numbers
 *
 * A notch is now {@link WHEEL_NOTCH_DELTA} = 100 px of TRAVEL, which is one
 * detent of a standard mouse wheel in a Chromium `DOM_DELTA_PIXEL` event — so
 * a mouse behaves exactly as it always did, one click one notch, while a
 * trackpad flick is divided by its travel rather than multiplied by its event
 * count. And a notch is {@link ZOOM_FACTOR} = 1.05 rather than 1.1.
 *
 * `goldens/zoom-step.json` is the lock. It holds, for a fixed set of
 * gestures, the notches emitted and the scale they land on — so a change to
 * either constant, or to the accumulator, moves a committed file and is a
 * decision somebody takes rather than a number that drifts.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DECK_ZOOM_LIMITS,
  IDENTITY_VIEWPORT,
  WHEEL_GESTURE_IDLE_MS,
  WHEEL_NOTCH_DELTA,
  ZOOM_FACTOR,
  createWheelNotcher,
  zoomAbout,
} from './viewport.js';

/** One wheel event: `deltaY`, `deltaMode`, and when it arrived. */
interface Tick {
  readonly dy: number;
  readonly mode?: number;
  readonly at?: number;
}

/** One gesture, named. */
interface Gesture {
  readonly name: string;
  readonly ticks: readonly Tick[];
}

/**
 * The gestures the golden locks.
 *
 * Written here rather than in the golden, so the golden holds only OUTPUTS:
 * a golden that carried its own inputs could be regenerated into agreement
 * with itself, which is the shape of a file that pins nothing.
 */
const GESTURES: readonly Gesture[] = [
  { name: 'mouse: one detent down', ticks: [{ dy: 100 }] },
  { name: 'mouse: one detent up', ticks: [{ dy: -100 }] },
  {
    name: 'mouse: three detents up, one gesture',
    ticks: [{ dy: -100, at: 0 }, { dy: -100, at: 40 }, { dy: -100, at: 80 }],
  },
  {
    name: 'trackpad: ten small events summing to one detent',
    ticks: Array.from({ length: 10 }, (_row, i) => ({ dy: -12, at: i * 10 })),
  },
  {
    name: 'trackpad: a long flick, 30 events of -12',
    ticks: Array.from({ length: 30 }, (_row, i) => ({ dy: -12, at: i * 10 })),
  },
  {
    name: 'firefox lines: three lines up is one detent',
    ticks: [{ dy: -3, mode: 1 }],
  },
  {
    name: 'pages: one page is one detent',
    ticks: [{ dy: -1, mode: 2 }],
  },
  {
    name: 'a reversal inside one gesture cancels the carry',
    ticks: [{ dy: -90, at: 0 }, { dy: 90, at: 20 }, { dy: 90, at: 40 }],
  },
  {
    name: 'a pause longer than the idle window drops the carry',
    ticks: [
      { dy: -90, at: 0 },
      { dy: -90, at: WHEEL_GESTURE_IDLE_MS + 50 },
      { dy: -20, at: WHEEL_GESTURE_IDLE_MS + 60 },
    ],
  },
  { name: 'zero and non-finite deltas do nothing', ticks: [{ dy: 0 }, { dy: Number.NaN }] },
];

/** Run one gesture: the notches it emits, and the scale it lands on. */
function run(gesture: Gesture): { notches: number[]; scale: number } {
  const notcher = createWheelNotcher();
  const notches: number[] = [];
  let view = IDENTITY_VIEWPORT;
  for (const [index, tick] of gesture.ticks.entries()) {
    const emitted = notcher.feed(tick.dy, tick.mode ?? 0, tick.at ?? index * 1000);
    notches.push(emitted);
    if (emitted !== 0) view = zoomAbout(view, 400, 300, emitted, DECK_ZOOM_LIMITS);
  }
  // Six places: the arithmetic is exact in binary only by accident, and a
  // golden that pinned every bit would move on a Node version.
  return { notches, scale: Number(view.k.toFixed(6)) };
}

const GOLDEN = JSON.parse(
  readFileSync(new URL('./goldens/zoom-step.json', import.meta.url), 'utf8'),
) as {
  constants: { zoomFactor: number; notchDelta: number; gestureIdleMs: number };
  gestures: Record<string, { notches: number[]; scale: number }>;
};

describe('the measured zoom step, locked by a golden', () => {
  it('the two constants are the ones the spec amendment names', () => {
    expect(ZOOM_FACTOR).toBe(GOLDEN.constants.zoomFactor);
    expect(WHEEL_NOTCH_DELTA).toBe(GOLDEN.constants.notchDelta);
    expect(WHEEL_GESTURE_IDLE_MS).toBe(GOLDEN.constants.gestureIdleMs);
    // Stated as literals too, so a golden regenerated from a changed source
    // cannot quietly agree with itself.
    expect(ZOOM_FACTOR).toBe(1.05);
    expect(WHEEL_NOTCH_DELTA).toBe(100);
  });

  it('every gesture lands where the golden says — notches and scale', () => {
    const actual = Object.fromEntries(GESTURES.map((g) => [g.name, run(g)]));
    expect(actual).toStrictEqual(GOLDEN.gestures);
    // The golden covers every gesture and no others: a name added here
    // without a row there is red, and a stale row is red too.
    expect(Object.keys(GOLDEN.gestures).sort()).toStrictEqual(
      GESTURES.map((g) => g.name).sort(),
    );
  });

  it('ONE NOTCH PER GESTURE, not per event — the whole point of the change', () => {
    /*
     * The trackpad flick is the reported case. Ten events used to be
     * ten notches of 1.1, i.e. 2.59x in one flick; they are ONE notch of
     * 1.05 now. Both numbers are asserted, because "it is smaller" is a
     * claim a halved constant would also satisfy.
     */
    const flick = GESTURES.find((g) => g.name.startsWith('trackpad: ten'));
    const result = run(flick as Gesture);
    expect(result.notches.filter((n) => n !== 0)).toStrictEqual([1]);
    expect(result.scale).toBe(Number(ZOOM_FACTOR.toFixed(6)));
    // What the old rule would have done to the same gesture.
    expect(Number((1.1 ** 10).toFixed(2))).toBe(2.59);
  });

  it('a mouse detent is still exactly one notch, in both directions', () => {
    // The reduction must not cost the mouse its 1:1 feel, which is what
    // makes 100 a measurement rather than a preference.
    expect(run({ name: 'x', ticks: [{ dy: 100 }] }).notches).toStrictEqual([-1]);
    expect(run({ name: 'x', ticks: [{ dy: -100 }] }).notches).toStrictEqual([1]);
  });

  it('pinch and ctrl-wheel take the same path — there is no branch to take', () => {
    /*
     * A browser delivers a trackpad pinch and a ctrl+wheel as ORDINARY wheel
     * events with `ctrlKey` set. The amendment says they obey the same law,
     * and the way this file can assert that is that the accumulator has no
     * `ctrlKey` in it at all: it cannot behave differently for a modifier it
     * never sees.
     *
     * The component half — `preventDefault` unconditional, no `ctrlKey`
     * branch — is pinned by `chrome.test.ts` reading the bundle.
     */
    const source = readFileSync(new URL('./viewport.ts', import.meta.url), 'utf8');
    const notcher = source.slice(source.indexOf('export function createWheelNotcher'));
    expect(notcher).not.toContain('ctrlKey');
    expect(notcher).not.toContain('metaKey');
  });
});
