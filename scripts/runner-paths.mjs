// Where `scripts/test-run.mjs` writes a run's record — v0.7.0 Phase 4, DoD 4.0a
// (carried from the Phase 3 handoff).
//
// THE DEFECT THIS CLOSES. The runner named every record `<label>-<index>.json`,
// and every ad-hoc run is `adhoc` at index 1. So the four ad-hoc runs that
// followed two mid-run deaths OVERWROTE both deaths' `adhoc-001.json`, and the
// stderr tail and last reporter line — what "captured" MEANS in the
// 2026-09-06 death-ledger amendment — were gone. The LEDGER rows survived, so
// the class stood at "1 captured plus 2 recorded-without-detail", one short of
// the bounded-diagnosis threshold, because the runner had erased its own
// evidence.
//
// THE RULE: a record is NEVER overwritten. If the name is taken, the next free
// `-r2`, `-r3`, ... suffix is used, whatever the earlier record's verdict was.
// Refusing to overwrite only DEATH records was considered and rejected: a
// passed run overwritten by a later death would then hide the pass, and the
// block's denominator is as much evidence as its numerator.
//
// Pure, and the filesystem is INJECTED: `exists` is a function the caller
// supplies, so `src/release/testrun.test.ts` can drive the rule against a
// fake directory and the runner drives it against the real one.

/** `label-001.json`, then `label-001-r2.json`, `label-001-r3.json`, ... */
export function recordFileName(label, index, attempt) {
  const base = `${label}-${String(index).padStart(3, '0')}`;
  return attempt <= 1 ? `${base}.json` : `${base}-r${String(attempt)}.json`;
}

/**
 * The first name under `dir` that does not exist yet.
 *
 * `exists(name)` answers for the bare filename; the caller joins it onto the
 * directory. Bounded so a directory that answers "exists" for everything
 * cannot spin forever — after that many collisions something other than a
 * busy directory is wrong.
 */
export const MAX_ATTEMPTS = 10_000;

export function uniqueRecordName(label, index, exists) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const name = recordFileName(label, index, attempt);
    if (!exists(name)) return name;
  }
  throw new Error(`no free record name for ${label}-${String(index)} after ${String(MAX_ATTEMPTS)} attempts`);
}
