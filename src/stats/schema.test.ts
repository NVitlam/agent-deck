/**
 * DoD 2.1 — the schema is frozen and the string surface is an allow-list.
 *
 * "`schema.ts` exports the type, a runtime validator, `STATS_SCHEMA_VERSION = 1`.
 * The validator rejects any string field off the allow-list (test with an extra
 * string field)."
 */

import { describe, expect, it } from 'vitest';

import { deriveStats } from './derive.js';
import { STATS_SCHEMA_VERSION, STATS_STRING_FIELDS, validateStatsRecord } from './schema.js';
import type { StatsRecord } from './schema.js';
import { buildSyntheticStatsFixtures } from './synthetic.testkit.js';

/** A real record, derived by the real deriver, as every case's starting point. */
function aRecord(): StatsRecord {
  const fixture = buildSyntheticStatsFixtures().find((f) => f.id === '02-churn-chain');
  if (fixture === undefined) throw new Error('fixture 02-churn-chain is missing');
  return deriveStats(fixture.state, { now: 1 });
}

describe('the version is pinned', () => {
  it('is 2, and a record carrying anything else is rejected', () => {
    // The literal is the pin, and it is deliberately a second place the number
    // is written: the constant's own header records that bumping it COSTS A
    // USER THEIR HISTORY, so the bump has to be made twice on purpose rather
    // than once by an edit that reads as housekeeping.
    expect(STATS_SCHEMA_VERSION).toBe(2);
    const record = aRecord();
    expect(validateStatsRecord(record).ok).toBe(true);
    // BOTH directions. A future version is the case `store.ts` describes; an
    // OLDER one is every record 0.7.x wrote, and the seam's claim that those
    // are skipped rests on this refusal rather than on the reader alone.
    for (const version of [1, 3]) {
      const verdict = validateStatsRecord({ ...record, statsSchemaVersion: version });
      expect(verdict.ok).toBe(false);
      expect(verdict.errors.join(' ')).toContain('statsSchemaVersion');
    }
  });
});

describe('the allow-list rejects a string field nobody declared', () => {
  it('accepts every record the deriver produces', () => {
    const records = buildSyntheticStatsFixtures().map((f) => deriveStats(f.state, { now: 1 }));
    // Vacuity control: an empty population satisfies "every record is valid".
    expect(records.length).toBeGreaterThan(10);
    for (const record of records) {
      expect(validateStatsRecord(record)).toEqual({ ok: true, errors: [] });
    }
  });

  it('rejects an extra string field at the TOP level', () => {
    const verdict = validateStatsRecord({ ...aRecord(), summary: 'the agent re-read one file' });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(' ')).toContain("key 'summary'");
  });

  it('rejects an extra string field NESTED inside an agent', () => {
    // The nested case is the one that matters. A validator checking only
    // declared top-level fields would pass this forever, and the realistic
    // leak is exactly here: somebody adds `label` to `AgentStats` because the
    // Stats view wants a caption, and `AgentNode.label` is
    // `meta.agentType + meta.description` — prose written by whoever spawned it.
    const record = aRecord();
    const agents = record.agents.map((a) => ({ ...a, label: 'fix the failing test in parse.ts' }));
    const verdict = validateStatsRecord({ ...record, agents });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(' ')).toContain("key 'label'");
    expect(verdict.errors.join(' ')).toContain('agents[0].label');
  });

  it('rejects an extra string field nested TWO deep, inside a list element', () => {
    const record = aRecord();
    expect(record.churn.length).toBeGreaterThan(0);
    const churn = record.churn.map((c) => ({ ...c, why: 'the edit was reverted' }));
    const verdict = validateStatsRecord({ ...record, churn });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(' ')).toContain("key 'why'");
  });

  it('judges an array element by the ARRAY’s key, not by its index', () => {
    // `unavailable` is a list of bare strings. A walker that keyed on the INDEX
    // would look for an allow-listed field named `0` and reject every valid
    // record.
    //
    // Both directions, and the second is the one that makes this a test rather
    // than a restatement — `phase-verifier` found the first draft asserting
    // only that a valid record passes, under a comment claiming it "must still
    // reject a bad element", which the code could not do. A string under an
    // allow-listed key passes BY DESIGN; what must be rejected is a list of
    // strings under a key nobody declared.
    const record = aRecord();
    expect(record.unavailable.length).toBeGreaterThan(0);
    expect(validateStatsRecord(record).ok).toBe(true);
    expect(STATS_STRING_FIELDS.has('unavailable')).toBe(true);

    // The rejection: same shape, undeclared key. This is the realistic leak —
    // somebody adds a list of notes beside `unavailable`.
    const verdict = validateStatsRecord({ ...record, notes: ['the agent re-read one file'] });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(' ')).toContain("key 'notes'");
    expect(verdict.errors.join(' ')).toContain('notes[0]');
  });

  it('rejects a non-finite number wherever it appears', () => {
    const record = aRecord();
    const broken = { ...record, totals: { ...record.totals, prompt: Number.NaN } };
    expect(validateStatsRecord(broken).ok).toBe(false);
  });

  it('rejects a cost with no source, and a source with no cost', () => {
    // A biconditional, checked in BOTH directions. The spec states `costSource`
    // is present iff `costUsd` is; checking one direction would let a record
    // ship a figure with no provenance, which is the whole thing F9 exists to
    // prevent.
    const record = aRecord();
    expect(validateStatsRecord({ ...record, totals: { ...record.totals, costUsd: 1 } }).ok).toBe(
      false,
    );
    expect(
      validateStatsRecord({ ...record, totals: { ...record.totals, costSource: 'engine' } }).ok,
    ).toBe(false);
    expect(
      validateStatsRecord({
        ...record,
        totals: { ...record.totals, costUsd: 1, costSource: 'engine' },
      }).ok,
    ).toBe(true);
  });

  it('rejects an undeclared coverage value and an undeclared engine', () => {
    const record = aRecord();
    expect(validateStatsRecord({ ...record, coverage: 'excluded:whatever' }).ok).toBe(false);
    expect(validateStatsRecord({ ...record, engine: 'gemini' }).ok).toBe(false);
  });

  it('rejects a non-object outright rather than throwing', () => {
    // G3: never crash on input. A Phase 3 store line is `JSON.parse` output and
    // may be anything at all.
    for (const value of [null, 42, 'a record', [], undefined]) {
      expect(() => validateStatsRecord(value)).not.toThrow();
      expect(validateStatsRecord(value).ok).toBe(false);
    }
  });
});

describe('the allow-list itself', () => {
  it('contains no field that could carry prose', () => {
    // A guard on the guard. These four are the names most likely to be added by
    // somebody making the Stats view friendlier, and each of them is a payload,
    // a caption or a message on the model side.
    for (const forbidden of ['label', 'inputPreview', 'resultPreview', 'reason', 'description']) {
      expect(STATS_STRING_FIELDS.has(forbidden)).toBe(false);
    }
  });
});
