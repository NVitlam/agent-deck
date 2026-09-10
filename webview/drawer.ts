/**
 * The drawer's follow-the-latest rule, as a pure scroll target — v0.7.0
 * Phase 4, DoD 4.9b.
 *
 * The user's rule (2026-09-05): the tool-call drawer tracks the newest call —
 * it auto-scrolls toward the latest entry, in whichever direction the list
 * grows. Expanding an entry to see its full command PINS the drawer — no
 * auto-scroll, no re-render of the pinned entry — until the expanded view is
 * closed, and then following resumes.
 *
 * WHY A PURE FUNCTION. `Inspector.svelte` used to decide this inside an
 * `$effect` that read `scrollHeight` and wrote `scrollTop` in one breath, and
 * the only test that could reach it asserted a `data-following` attribute —
 * jsdom lays nothing out, so the scroll itself was never measured. Splitting
 * the DECISION from the DOM write makes the decision a table a golden can pin
 * (`webview/goldens/drawer/follow.json`) and leaves the component with one
 * line: if the target is a number, assign it.
 *
 * "In whichever direction the list grows": in `oldest` order the newest call is
 * the LAST row, so the target is the bottom; in `newest` order it is the FIRST
 * row, so the target is the top. A9.5 said `newest` had "nothing to follow";
 * that was true when the list re-rendered from the top on every arrival, and
 * it is not true once a user has scrolled down a `newest` list to read older
 * calls — a new arrival then lands out of view above them.
 */

/** Everything the rule needs to know, measured by the caller. */
export interface FollowInput {
  /** Which end the newest call is drawn at. */
  order: 'oldest' | 'newest';
  /**
   * An entry is expanded — its detail pane is open. The user is reading it,
   * and the list must not move under them.
   */
  pinned: boolean;
  /**
   * The user has not scrolled away from the growing end. `false` after a
   * manual scroll away; `true` again once they return to that end.
   */
  following: boolean;
  /** `el.scrollHeight`, the list's whole content height. */
  scrollHeight: number;
  /** `el.clientHeight`, the visible height. */
  clientHeight: number;
}

/**
 * The `scrollTop` to assign, or `null` when the list must not move.
 *
 * `null` and `0` are different answers and the distinction is the point: `0`
 * is "scroll to the top, where the newest call is", `null` is "leave it".
 */
export function followTarget(input: FollowInput): number | null {
  if (input.pinned) return null;
  if (!input.following) return null;
  if (!Number.isFinite(input.scrollHeight) || !Number.isFinite(input.clientHeight)) return null;
  if (input.order === 'newest') return 0;
  return Math.max(0, input.scrollHeight - input.clientHeight);
}

/**
 * Whether a manual scroll position counts as "at the growing end".
 *
 * Four pixels of slack, for the reason `Inspector.svelte` always gave: a list
 * scrolled to an end does not always land on an exact equality after a
 * re-render.
 */
export const FOLLOW_SLACK_PX = 4;

export function atGrowingEnd(
  order: 'oldest' | 'newest',
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  if (order === 'newest') return scrollTop <= FOLLOW_SLACK_PX;
  return scrollHeight - scrollTop - clientHeight <= FOLLOW_SLACK_PX;
}
