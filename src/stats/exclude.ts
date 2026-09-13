/**
 * F11 — attribution coverage, and the total exclusion G3 requires.
 *
 * v0.7.0 Phase 2, DoD 2.5. G3 extended: *"Stats derive only for sessions with
 * `schemaOk: true` and an empty `parked` list. Any other session is
 * `excluded:<code>` with empty tables and is absent from every aggregate. No
 * partial stats."*
 *
 * ## TOTAL means the tables are empty, not that they are filtered
 *
 * The temptation with a parked session is to report the nodes that DID place —
 * most of them, usually. That is precisely the partial tree G3 forbids, and it
 * is worse in a stats record than on the deck: a file-touch count over a
 * partial tree is a NUMBER, and a number carries no visible sign that it was
 * taken over a subset. An empty table with a reason code cannot be misread.
 *
 * ## Order of the two refusals
 *
 * `unsupported` is checked first. A session the fingerprint refused has no
 * trustworthy tree at all, so `parked` over it would be describing the shape of
 * something already rejected; the stronger refusal is the honest one to name.
 * A session can legitimately be both, and the code says which reason applies
 * rather than inventing a compound.
 */

import type { SessionState } from '../model/events.js';

import type { Coverage, ExclusionCode } from './schema.js';

/** The coverage verdict, and the code when it is not `'full'`. */
export interface CoverageVerdict {
  coverage: Coverage;
  /** Absent iff `coverage` is `'full'`. */
  code?: ExclusionCode;
}

/**
 * F11 for one session.
 *
 * `schemaOk` is read STRICTLY — `!== true`, not `=== false`. A state that
 * carries no `schemaOk` at all has not asserted that its layout was checked,
 * and "it did not say no" is not the same as "it said yes". This matters
 * because it is exactly how a non-`SessionState` object cast into this
 * function would slip through: it would be missing the field rather than
 * carrying `false`.
 */
export function coverageOf(state: SessionState): CoverageVerdict {
  if (state.schemaOk !== true) return { coverage: 'excluded:unsupported', code: 'unsupported' };
  if ((state.parked ?? []).length > 0) return { coverage: 'excluded:parked', code: 'parked' };
  // v0.8.0: a transcript read in part is a subset of the session with no sign
  // of it on any count, so it is excluded as totally as a parked tree is.
  if (state.partial !== undefined) return { coverage: 'excluded:partial', code: 'partial' };
  return { coverage: 'full' };
}
