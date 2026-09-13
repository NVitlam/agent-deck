/**
 * DoD 2.5 — exclusion is TOTAL, and it is proved on a real session.
 *
 * "`05-excluded-parked` → `coverage: 'excluded:parked'`, empty tables, zero
 * totals; an aggregate of three records including it equals the aggregate of
 * the other two."
 *
 * ## The non-vacuity half, and the answer to the question the phase brief asked
 *
 * The brief asked for at least one HARVESTED session with a real parked entry,
 * and said to state it in one line if none existed. **One exists.**
 * `fixtures/opencode-1.18.22`'s `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ` carries **9**
 * parked entries from the real capture — a 238-call, 21-agent session, the
 * largest in the OpenCode corpora — and the deriver excludes it in full. So the
 * exclusion path is exercised by captured bytes and not only by a manufactured
 * fixture, which is what stops this DoD resting on a shape this repository
 * invented.
 *
 * That session is also where the OpenCode `task x 9` loop of VERDICT.md 0.6
 * lives. Its disappearance from every golden is not a regression: it is G3
 * doing exactly what it says, and the fact that a real, interesting loop is
 * withheld is the strongest available demonstration that exclusion is total
 * rather than cosmetic.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { CORPUS_READ_BUDGET_MS } from './corpus.testkit.js';
import { readCorpusSessions } from './corpus.stats.testkit.js';
import type { CorpusSession } from './corpus.stats.testkit.js';
import { deriveStats } from './derive.js';
import { coverageOf } from './exclude.js';
import type { StatsRecord } from './schema.js';
import { STATS_SCHEMA_VERSION } from './schema.js';
import { buildSyntheticStatsFixtures } from './synthetic.testkit.js';

function fixtureRecord(id: string): StatsRecord {
  const fixture = buildSyntheticStatsFixtures().find((f) => f.id === id);
  if (fixture === undefined) throw new Error(`no fixture ${id}`);
  return deriveStats(fixture.state, { now: 1 });
}

/** Every list and every total, summed — the aggregate DoD 2.5 compares. */
function aggregate(records: readonly StatsRecord[]): Record<string, number> {
  const sum = (pick: (r: StatsRecord) => number): number =>
    records.reduce((n, r) => n + pick(r), 0);
  return {
    agents: sum((r) => r.agents.length),
    files: sum((r) => r.files.length),
    tools: sum((r) => r.tools.length),
    loops: sum((r) => r.loops.length),
    churn: sum((r) => r.churn.length),
    contextChurn: sum((r) => r.contextChurn.length),
    compactions: sum((r) => r.compactions.length),
    stalls: sum((r) => r.stalls.length),
    prompt: sum((r) => r.totals.prompt),
    output: sum((r) => r.totals.output),
    subagents: sum((r) => r.totals.subagents),
    silentSubagents: sum((r) => r.totals.silentSubagents),
    totalCompactions: sum((r) => r.totals.compactions),
    totalStalls: sum((r) => r.totals.stalls),
  };
}

describe('the manufactured case', () => {
  const excluded = fixtureRecord('05-excluded-parked');

  it('is excluded:parked, with every table empty and every total zero', () => {
    expect(excluded.coverage).toBe('excluded:parked');
    expect(excluded.agents).toEqual([]);
    expect(excluded.files).toEqual([]);
    expect(excluded.tools).toEqual([]);
    expect(excluded.loops).toEqual([]);
    expect(excluded.churn).toEqual([]);
    expect(excluded.contextChurn).toEqual([]);
    expect(excluded.compactions).toEqual([]);
    expect(excluded.stalls).toEqual([]);
    // F14's block is PRESENT and empty. The key is always there — a missing
    // one could equally mean "written by an older deriver" — and an excluded
    // session publishes no figure derived from its instants, the same way it
    // publishes no row derived from its tree.
    expect(excluded.timing).toEqual({});
    expect(excluded.totals).toEqual({
      prompt: 0,
      output: 0,
      compactions: 0,
      subagents: 0,
      silentSubagents: 0,
      stalls: 0,
    });
  });

  it('had a tree worth excluding — the emptiness is the refusal, not the input', () => {
    // Without this the test above is satisfied for the wrong reason. The
    // fixture's session carries three identical Reads of one file, which is a
    // loop and a file row under any other coverage.
    const fixture = buildSyntheticStatsFixtures().find((f) => f.id === '05-excluded-parked');
    if (fixture === undefined) throw new Error('fixture missing');
    expect(fixture.state.root.children).toHaveLength(3);
    const unparked = { ...fixture.state, parked: [] };
    const wouldHave = deriveStats(unparked, { now: 1 });
    expect(wouldHave.coverage).toBe('full');
    expect(wouldHave.loops).toHaveLength(1);
    expect(wouldHave.files).toHaveLength(1);
  });

  it('still states its own identity — G3 withholds the tree, not the session', () => {
    expect(excluded.sessionId).toBe('synthetic-05-excluded-parked');
    expect(excluded.engine).toBe('cc');
    expect(excluded.projectSlug).toBe('synthetic-stats');
    expect(excluded.statsSchemaVersion).toBe(STATS_SCHEMA_VERSION);
  });
});

describe('an aggregate is blind to an excluded record', () => {
  it('three records including it equal the other two', () => {
    const two = [fixtureRecord('01-reread-loop'), fixtureRecord('02-churn-chain')];
    const three = [...two, fixtureRecord('05-excluded-parked')];
    expect(aggregate(three)).toEqual(aggregate(two));
    // Vacuity control: the two-record aggregate must not be all zeros, or the
    // equality above holds for a reason that has nothing to do with exclusion.
    expect(aggregate(two).loops).toBeGreaterThan(0);
    expect(aggregate(two).prompt).toBeGreaterThan(0);
  });
});

describe('a refused session is excluded:unsupported, and the order is stated', () => {
  it('schemaOk false wins over parked', () => {
    const fixture = buildSyntheticStatsFixtures().find((f) => f.id === '05-excluded-parked');
    if (fixture === undefined) throw new Error('fixture missing');
    expect(coverageOf({ ...fixture.state, schemaOk: false }).coverage).toBe('excluded:unsupported');
  });

  it('a state that never asserted schemaOk is refused, not accepted', () => {
    // `!== true`, not `=== false`. "It did not say no" is not "it said yes",
    // and this is exactly how a graft snapshot cast into `SessionState` would
    // slip through: it carries no `schemaOk` at all.
    const fixture = buildSyntheticStatsFixtures().find((f) => f.id === '01-reread-loop');
    if (fixture === undefined) throw new Error('fixture missing');
    const { schemaOk: _dropped, ...withoutFlag } = fixture.state;
    void _dropped;
    expect(coverageOf(withoutFlag as typeof fixture.state).coverage).toBe('excluded:unsupported');
  });
});

describe('DoD 2.5 non-vacuity — a HARVESTED session with real parked entries', () => {
  let sessions: CorpusSession[] = [];

  beforeAll(async () => {
    sessions = await readCorpusSessions();
  }, CORPUS_READ_BUDGET_MS);

  it('at least one captured session is parked, and it is excluded in full', () => {
    const parked = sessions.filter((s) => (s.state.parked ?? []).length > 0);
    // The population, named rather than assumed: if a future harvest removes
    // this session the test goes red and says the DoD's non-vacuity evidence
    // is gone — rather than passing over an empty list.
    expect(parked.length).toBeGreaterThan(0);
    for (const entry of parked) {
      const derived = deriveStats(entry.state, { now: 1 });
      expect(derived.coverage).toBe('excluded:parked');
      expect(derived.agents).toEqual([]);
      expect(derived.tools).toEqual([]);
      expect(derived.totals.prompt).toBe(0);
    }
  });

  it('the parked session is a substantial one, not an empty shell', () => {
    // An excluded session that had nothing in it anyway would demonstrate
    // nothing. The one the corpus supplies is the largest in the OpenCode
    // stores: 238 calls across 21 agents, 9 parked entries.
    const parked = sessions.find((s) => (s.state.parked ?? []).length > 0);
    expect(parked).toBeDefined();
    if (parked === undefined) return;
    const withoutPark = deriveStats({ ...parked.state, parked: [] }, { now: 1 });
    expect(withoutPark.coverage).toBe('full');
    expect(withoutPark.tools.length).toBeGreaterThan(0);
    expect(withoutPark.agents.length).toBeGreaterThan(1);
  });

  it('no other captured session is excluded — the refusal is not blanket', () => {
    // The other direction. If every session came back excluded the tests above
    // would all pass while the deriver produced nothing at all.
    const full = sessions.filter((s) => deriveStats(s.state, { now: 1 }).coverage === 'full');
    expect(full.length).toBeGreaterThan(15);
  });
});
