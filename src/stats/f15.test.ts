/**
 * v0.8.0 Phase 7, DoD 7.4 — F15, the derivation half.
 *
 * Spec `Amendment 2026-09-12`: *"A spawned agent whose spawning `Agent` call
 * has no `tool_result` in the parent transcript. Structural; never inferred
 * from message content."*
 *
 * The DoD's own words: *"`subagentsUnreceived` in `AgentStats` totals; corpus
 * pins the count per golden; a synthetic fixture with one aborted spawn yields
 * 1, all others 0."*
 *
 * ## Two counts, and a zero that means two different things
 *
 * `AgentStats.resultUnreceived` is REQUIRED and `totals.subagentsUnreceived` is
 * OPTIONAL, and the asymmetry is the fact this file spends most of its length
 * on. F8's `silent` comes from the tree, which every session has; F15 needs
 * `SessionState.spawnEdges`, which is OPTIONAL. Where they are absent the
 * count is absent too and `unavailable` says `F15:<engine>` — because a 0 there
 * would be a zero standing in for an absence, which §D forbids by name.
 *
 * So a `subagentsUnreceived` of 0 means "this session states its spawn edges
 * and every spawning call has a result", and an ABSENT one means "this session
 * states no spawn edges". Every assertion below that reads a 0 is paired with
 * the population that makes it falsifiable, because a count named for what is
 * MISSING reads 0 over an empty set — this repository's most-recorded defect
 * shape, and the one F15 is most exposed to.
 *
 * ## The corpus carries one of these, and that was not expected
 *
 * A spawning call with no result is a statement about a SNAPSHOT — a subagent
 * working right now — so a finished capture looked like the wrong place to
 * find one, and R8's fixture 14 exists because the DoD asks for a manufactured
 * arm. The corpus supplies one anyway: exactly one committed Claude Code
 * session was captured mid-spawn, and it is asserted on its own below. It is
 * the stronger arm of the two, being real bytes through the production
 * readers, and the fixture keeps the negative case one status away from it.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { AgentNode, SessionState } from '../model/events.js';
import { isAgentNode } from '../model/events.js';

import { CORPUS_READ_BUDGET_MS } from './corpus.testkit.js';
import type { CorpusSession } from './corpus.stats.testkit.js';
import { FIXED_NOW_MS, readCorpusSessions } from './corpus.stats.testkit.js';
import { deriveStats } from './derive.js';
import type { StatsEngine, StatsRecord } from './schema.js';
import { SYNTHETIC_NOW_MS, buildSyntheticStatsFixtures } from './synthetic.testkit.js';

let records: { entry: CorpusSession; record: StatsRecord }[] = [];

beforeAll(async () => {
  records = (await readCorpusSessions()).map((entry) => ({
    entry,
    record: deriveStats(entry.state, { now: FIXED_NOW_MS }),
  }));
}, CORPUS_READ_BUDGET_MS);

const FIXTURES = new Map(
  buildSyntheticStatsFixtures().map((fixture) => [
    fixture.id,
    { fixture, record: deriveStats(fixture.state, { now: SYNTHETIC_NOW_MS }) },
  ]),
);

function fixtureRecord(id: string): StatsRecord {
  const found = FIXTURES.get(id);
  if (found === undefined) throw new Error(`no fixture ${id}`);
  return found.record;
}

// ---------------------------------------------------------------------------
// The corpus census
// ---------------------------------------------------------------------------

interface F15Census {
  sessions: number;
  /** Of those, `coverage: 'full'`. An excluded record carries no agent row. */
  full: number;
  /** Sessions whose state carries `spawnEdges` at all. */
  withEdges: number;
  /** Spawn edges across those sessions. */
  edges: number;
  /**
   * Edges that could flag an agent ROW: on a FULL record, naming an agent that
   * is in that session's tree.
   *
   * It differs from `edges` by twenty on OpenCode, and the reason is G3 rather
   * than anything about F15 — see the block below.
   */
  edgesJoinable: number;
  /** Subagents in the derived records. */
  subagents: number;
  /** Records carrying `totals.subagentsUnreceived`. */
  counted: number;
  /** The sum of those counts. */
  unreceived: number;
  /** Records naming `F15:<engine>`. */
  named: number;
}

/** Every agent id in one tree, by this file's own walk. */
function agentIdsOf(state: SessionState): Set<string> {
  return new Set(agentsOf(state.root).map((node) => node.id));
}

function census(engine: StatsEngine): F15Census {
  const mine = records.filter((r) => r.entry.engine === engine);
  return {
    sessions: mine.length,
    full: mine.filter((r) => r.record.coverage === 'full').length,
    withEdges: mine.filter((r) => r.entry.state.spawnEdges !== undefined).length,
    edges: mine.reduce((n, r) => n + (r.entry.state.spawnEdges?.length ?? 0), 0),
    edgesJoinable: mine.reduce((n, r) => {
      if (r.record.coverage !== 'full') return n;
      const ids = agentIdsOf(r.entry.state);
      return n + (r.entry.state.spawnEdges ?? []).filter((e) => ids.has(e.agentId)).length;
    }, 0),
    subagents: mine.reduce((n, r) => n + r.record.totals.subagents, 0),
    counted: mine.filter((r) => r.record.totals.subagentsUnreceived !== undefined).length,
    unreceived: mine.reduce((n, r) => n + (r.record.totals.subagentsUnreceived ?? 0), 0),
    named: mine.filter((r) => r.record.unavailable.includes(`F15:${engine}`)).length,
  };
}

/**
 * What F15 measures over every committed corpus today.
 *
 * Pinned, against this repository's usual rule about fixture-set sizes, for the
 * reason DoD 7.4 asks for it: *"corpus pins the count per golden"*. F15's whole
 * content is how many spawning calls have no result, and a sweep that reports
 * "the ones with edges, have edges" is satisfied by a corpus with none.
 *
 * A harvest moves these. Re-derive from the census this file prints on every
 * run.
 */
const CENSUS: Readonly<Record<StatsEngine, F15Census>> = {
  /*
   * CLAUDE CODE — 13 spawn edges, 13 subagents, and ONE of them was spawned by
   * a call with no result. That one is a real harvested session, not a
   * manufactured one: a capture taken while a subagent was still working, so
   * its `Agent` block has no `tool_result` in the parent transcript. It is the
   * corpus's own positive arm for F15, and it is why the `unreceived` figure
   * here is 1 rather than 0.
   */
  cc: {
    sessions: 9,
    full: 9,
    withEdges: 9,
    edges: 13,
    edgesJoinable: 13,
    subagents: 13,
    counted: 9,
    unreceived: 1,
    named: 0,
  },
  /*
   * OPENCODE — 21 spawn edges and ONE joinable, and the twenty in between are
   * G3 rather than anything about F15: a single EXCLUDED session holds them,
   * and an excluded record carries no agent row, no per-fact total and no gap
   * code. Every one of the 21 names an agent that IS in its own tree —
   * measured, after a first draft of this block guessed at child sessions and
   * the count refused it.
   *
   * That exclusion is also why `counted` is 8 against `withEdges` 9.
   */
  opencode: {
    sessions: 9,
    full: 8,
    withEdges: 9,
    edges: 21,
    edgesJoinable: 1,
    subagents: 1,
    counted: 8,
    unreceived: 0,
    named: 0,
  },
  /*
   * CODEX — 9 edges, 9 subagents, every spawning call carrying its result.
   */
  codex: {
    sessions: 5,
    full: 5,
    withEdges: 5,
    edges: 9,
    edgesJoinable: 9,
    subagents: 9,
    counted: 5,
    unreceived: 0,
    named: 0,
  },
};

const ENGINES: readonly StatsEngine[] = ['cc', 'opencode', 'codex'];

function report(engine: StatsEngine, measured: F15Census): void {
  const flagged = records
    .filter((r) => r.entry.engine === engine && (r.record.totals.subagentsUnreceived ?? 0) > 0)
    .map((r) => r.record.sessionId);
  process.stdout.write(
    `[F15] ${engine}: sessions ${String(measured.sessions)}, full ${String(measured.full)}, ` +
      `withEdges ${String(measured.withEdges)}, edges ${String(measured.edges)}, ` +
      `edgesJoinable ${String(measured.edgesJoinable)}, ` +
      `subagents ${String(measured.subagents)}, counted ${String(measured.counted)}, ` +
      `unreceived ${String(measured.unreceived)}, named ${String(measured.named)}` +
      `${flagged.length === 0 ? '' : `, flagged ${flagged.join(' ')}`}\n`,
  );
}

/** Every agent node in one tree, root first. */
function agentsOf(node: AgentNode): AgentNode[] {
  const out: AgentNode[] = [node];
  for (const child of node.children) if (isAgentNode(child)) out.push(...agentsOf(child));
  return out;
}

/** The status of the `tool_use` node one spawn edge names, by this file's walk. */
function statusOfSpawningCall(state: SessionState, toolUseId: string): string | undefined {
  let found: string | undefined;
  const visit = (node: AgentNode): void => {
    for (const child of node.children) {
      if (isAgentNode(child)) visit(child);
      else if (child.id === toolUseId) found = child.status;
    }
  };
  visit(state.root);
  return found;
}

// ---------------------------------------------------------------------------

describe.each(ENGINES)('F15 over the %s corpus', (engine) => {
  it('counts spawn edges and unreceived results against the pinned census', () => {
    const measured = census(engine);
    report(engine, measured);

    // The vacuity control first, and it is the whole reason this test can say
    // anything: `unreceived: 0` over an empty session list is not a fact about
    // F15. `sessions` and `withEdges` are pinned non-zero literals.
    expect(measured.sessions).toBe(CENSUS[engine].sessions);
    expect(measured.sessions).toBeGreaterThan(0);
    expect(measured.withEdges).toBeGreaterThan(0);

    expect(measured).toEqual(CENSUS[engine]);
    // The biconditional the schema states, over the records that publish facts
    // at all: the count is present exactly where the edges are. An EXCLUDED
    // record is outside it in both directions — it carries no total and names
    // no gap, because `coverage` is its single stated reason.
    const full = records.filter(
      (r) => r.entry.engine === engine && r.record.coverage === 'full',
    );
    expect(full).toHaveLength(measured.full);
    expect(full.filter((r) => r.entry.state.spawnEdges !== undefined)).toHaveLength(
      measured.counted,
    );
    expect(measured.named).toBe(measured.full - measured.counted);
  });

  it('agrees with a second reading of the same spawn edges', () => {
    // Recomputed here from `spawnEdges` and the tree, without the deriver's
    // own helper, so the two are independent readings rather than one asserted
    // twice.
    let checked = 0;
    for (const { entry, record } of records) {
      if (entry.engine !== engine) continue;
      const edges = entry.state.spawnEdges;
      if (edges === undefined || record.coverage !== 'full') continue;
      // An edge naming an agent that is not a node of THIS tree has no agent
      // row to flag — the OpenCode child-session case in the census block.
      // Intersecting with the tree's own ids models that from the INPUT side;
      // it does not read the deriver's answer.
      const inTree = agentIdsOf(entry.state);
      const expected = new Set<string>();
      for (const edge of edges) {
        if (!inTree.has(edge.agentId)) continue;
        const status = statusOfSpawningCall(entry.state, edge.toolUseId);
        if (status === 'running' || status === 'stalled') expected.add(edge.agentId);
      }
      const flagged = new Set(
        record.agents.filter((a) => a.resultUnreceived).map((a) => a.agentId),
      );
      expect([...flagged].sort(), entry.state.sessionId).toEqual([...expected].sort());
      checked += 1;
    }
    expect(checked).toBe(CENSUS[engine].counted);
    expect(checked).toBeGreaterThan(0);
  });

  it('never flags a main agent', () => {
    let mains = 0;
    for (const { entry, record } of records) {
      if (entry.engine !== engine) continue;
      for (const stats of record.agents) {
        if (stats.kind !== 'main') continue;
        // `main` has no spawning call, so it cannot have one without a result.
        expect(stats.resultUnreceived, `${entry.state.sessionId}/${stats.agentId}`).toBe(false);
        mains += 1;
      }
    }
    // The population, pinned: one main per FULL record — an excluded one
    // carries no agent at all — so a reader that walked no agent fails here
    // instead of passing the loop above vacuously.
    expect(mains).toBe(CENSUS[engine].full);
    expect(mains).toBeGreaterThan(0);
  });

  it('states the flag on every agent of every record', () => {
    // REQUIRED on `AgentStats`, so its absence is a type error rather than a
    // runtime one — which makes a runtime check of the same thing worth
    // exactly one line, and worth having: the record is serialised to a golden
    // and read back by the store as untyped JSON.
    let agents = 0;
    for (const { entry, record } of records) {
      if (entry.engine !== engine) continue;
      for (const stats of record.agents) {
        expect(typeof stats.resultUnreceived, entry.state.sessionId).toBe('boolean');
        agents += 1;
      }
    }
    // One main per full record, plus this engine's subagents — pinned exactly
    // rather than as a floor, so a walk that lost a whole tree is visible.
    expect(agents).toBe(CENSUS[engine].full + CENSUS[engine].subagents);
    expect(agents).toBeGreaterThan(0);
  });
});

describe('the corpus carries an aborted spawn of its own', () => {
  it('exactly one harvested session, on Claude Code, flags exactly one subagent', () => {
    // F15's positive arm does not depend on the manufactured fixture: one
    // committed Claude Code session was captured while a subagent was still
    // working, so its `Agent` block has no `tool_result` in the parent
    // transcript. This is the strongest evidence in the phase for F15 — a real
    // capture, read through the production path.
    const flagged = records.filter(
      ({ record }) => (record.totals.subagentsUnreceived ?? 0) > 0,
    );
    expect(flagged).toHaveLength(1);
    const subject = flagged[0];
    expect(subject).toBeDefined();
    if (subject === undefined) return;
    expect(subject.entry.engine).toBe('cc');
    expect(subject.record.totals.subagentsUnreceived).toBe(1);

    const rows = subject.record.agents.filter((a) => a.resultUnreceived);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.kind).toBe('subagent');

    // And the reason, read off the input: the spawning call is `running`,
    // which is the grafter's `resultPreview === undefined` case. Not
    // `stalled` — this reader ingests no hook event, so no session has a
    // `lastActivityAt` and nothing can be promoted.
    const edge = (subject.entry.state.spawnEdges ?? []).find((e) => e.agentId === row.agentId);
    expect(edge).toBeDefined();
    expect(statusOfSpawningCall(subject.entry.state, edge?.toolUseId ?? '')).toBe('running');

    // The population that makes the `1` falsifiable: this session has more
    // than one subagent, and the others are not flagged.
    expect(subject.record.totals.subagents).toBeGreaterThan(1);
  });
});

describe('the corpus states its spawn edges on every engine', () => {
  it('so F15 is a session fact and not an engine capability gap', () => {
    // This is the measurement behind leaving F14 and F15 out of
    // `ENGINE_FACT_GAPS`: no engine is incapable of stating spawn edges, so a
    // session without them is a fact about that session. The day one stops,
    // this goes red and the gap is reported from the data with no edit to that
    // table.
    const measured = ENGINES.map((engine) => census(engine));
    for (const [index, engine] of ENGINES.entries()) {
      const row = measured[index];
      expect(row, engine).toBeDefined();
      expect(row?.withEdges, engine).toBe(row?.sessions);
      expect(row?.sessions, engine).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// R8 fixture 14 — the aborted spawn
// ---------------------------------------------------------------------------

describe('DoD 7.4 — the synthetic aborted spawn', () => {
  it('POSITIVE: the agent whose spawning call has no result reads true', () => {
    const record = fixtureRecord('14-aborted-spawn');
    const unreceived = record.agents.find((a) => a.agentId === 'unreceived');
    expect(unreceived).toBeDefined();
    expect(unreceived?.resultUnreceived).toBe(true);
    expect(record.totals.subagentsUnreceived).toBe(1);
  });

  it('NEGATIVE: one status away — the same call shape WITH a result reads false', () => {
    const record = fixtureRecord('14-aborted-spawn');
    const received = record.agents.find((a) => a.agentId === 'received');
    expect(received).toBeDefined();
    expect(received?.resultUnreceived).toBe(false);
    // The root, which has no spawning call at all.
    expect(record.agents.find((a) => a.agentId === 'root')?.resultUnreceived).toBe(false);
    // The population that makes the `1` above falsifiable: two subagents, of
    // which exactly one is flagged.
    expect(record.totals.subagents).toBe(2);
    expect(record.agents).toHaveLength(3);
  });

  it('is a different fact from F8 — neither subagent is silent', () => {
    // Both spawned agents make a tool call, so `silent` is false for both while
    // `resultUnreceived` differs. Without this the fixture would move the two
    // flags together and nothing could tell which one a row reported.
    const record = fixtureRecord('14-aborted-spawn');
    for (const agent of record.agents) expect(agent.silent, agent.agentId).toBe(false);
    expect(record.totals.silentSubagents).toBe(0);
    expect(record.totals.subagentsUnreceived).toBe(1);
  });

  it('names no F15 gap, because the session states its edges', () => {
    const record = fixtureRecord('14-aborted-spawn');
    expect(record.unavailable).not.toContain('F15:cc');
    expect(record.totals.subagentsUnreceived).toBeDefined();
  });
});

describe('DoD 7.4 — all others 0', () => {
  it('exactly one R8 fixture yields a non-zero count, over the whole set', () => {
    // "All others" is the rest of the R8 SET. It is NOT a claim about the
    // corpus: one harvested Claude Code session flags one subagent for a real
    // reason, asserted in its own block above. Conflating the two would make
    // this test demand that a real capture be wrong.
    //
    // Asserted over the set with its size pinned, because a claim about every
    // member of an empty list is free.
    expect(FIXTURES.size).toBe(14);
    const nonZero = [...FIXTURES.entries()]
      .filter(([, { record }]) => (record.totals.subagentsUnreceived ?? 0) > 0)
      .map(([id]) => id);
    expect(nonZero).toEqual(['14-aborted-spawn']);

    // And every agent of every other fixture reads false — the per-agent flag,
    // not only the total, since a total can be right while a flag is wrong.
    let agents = 0;
    for (const [id, { record }] of FIXTURES) {
      if (id === '14-aborted-spawn') continue;
      for (const agent of record.agents) {
        expect(agent.resultUnreceived, `${id}/${agent.agentId}`).toBe(false);
        agents += 1;
      }
    }
    expect(agents).toBeGreaterThan(13);
  });

  it('the other thirteen state no spawn edges, so their count is ABSENT', () => {
    // The distinction the schema exists to keep: absent means "this session
    // says nothing about how its agents were spawned", and 0 means "it does,
    // and every spawning call has a result". Fixture 14 is the only R8 session
    // that states edges, so it is the only one carrying a count.
    let absent = 0;
    let named = 0;
    for (const [id, { fixture, record }] of FIXTURES) {
      if (id === '14-aborted-spawn') {
        expect(fixture.state.spawnEdges).toBeDefined();
        continue;
      }
      expect(fixture.state.spawnEdges, id).toBeUndefined();
      expect(record.totals.subagentsUnreceived, id).toBeUndefined();
      absent += 1;
      // An EXCLUDED record names no per-fact gap at all — `coverage` is its one
      // reason — so only the full ones say `F15:<engine>`.
      if (record.coverage !== 'full') continue;
      expect(record.unavailable, id).toContain(`F15:${fixture.state.engine ?? 'cc'}`);
      named += 1;
    }
    expect(absent).toBe(13);
    expect(named).toBe(12);
  });
});

describe('the spawning call decides, and only its status', () => {
  it('a spawn edge naming no node in the tree leaves its agent false', () => {
    // Manufactured from fixture 14 by repointing one edge at an id no node
    // carries. The spawning call is not in this tree, so the session states
    // nothing about whether a result arrived — and "no result is present" is
    // not the same claim as "the call is missing".
    const fixture = buildSyntheticStatsFixtures().find((f) => f.id === '14-aborted-spawn');
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const edges = fixture.state.spawnEdges ?? [];
    expect(edges).toHaveLength(2);
    const repointed: SessionState = {
      ...fixture.state,
      spawnEdges: edges.map((edge) =>
        edge.agentId === 'unreceived' ? { ...edge, toolUseId: 'no-such-call' } : edge,
      ),
    };
    const record = deriveStats(repointed, { now: SYNTHETIC_NOW_MS });
    expect(record.agents.find((a) => a.agentId === 'unreceived')?.resultUnreceived).toBe(false);
    // Still counted, because the session DID state its edges.
    expect(record.totals.subagentsUnreceived).toBe(0);
    // The control: unrepointed, the same agent reads true.
    expect(fixtureRecord('14-aborted-spawn').totals.subagentsUnreceived).toBe(1);
  });

  it('every agent reads false and the count is ABSENT when the edges are removed', () => {
    // The other arm of the schema's asymmetry, over the same bytes.
    const fixture = buildSyntheticStatsFixtures().find((f) => f.id === '14-aborted-spawn');
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const edgeless: SessionState = { ...fixture.state };
    delete (edgeless as { spawnEdges?: unknown }).spawnEdges;
    const record = deriveStats(edgeless, { now: SYNTHETIC_NOW_MS });
    expect(record.totals.subagentsUnreceived).toBeUndefined();
    expect(record.unavailable).toContain('F15:cc');
    for (const agent of record.agents) expect(agent.resultUnreceived, agent.agentId).toBe(false);
    // The population, so the loop above is not empty, and the control.
    expect(record.agents).toHaveLength(3);
    expect(fixtureRecord('14-aborted-spawn').unavailable).not.toContain('F15:cc');
  });

  it('reads the status and no preview — an errored spawn has its result', () => {
    // `error` is a result that arrived. Manufactured by flipping ONE status on
    // a copy of fixture 14's tree, so the arm differs from its control in that
    // field alone.
    const fixture = buildSyntheticStatsFixtures().find((f) => f.id === '14-aborted-spawn');
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const errored: SessionState = {
      ...fixture.state,
      root: {
        ...fixture.state.root,
        children: fixture.state.root.children.map((child) =>
          !isAgentNode(child) && child.id === 'g0' ? { ...child, status: 'error' as const } : child,
        ),
      },
    };
    const record = deriveStats(errored, { now: SYNTHETIC_NOW_MS });
    expect(record.agents.find((a) => a.agentId === 'unreceived')?.resultUnreceived).toBe(false);
    expect(record.totals.subagentsUnreceived).toBe(0);
    // The control, and the agent count so the `find` above is not undefined.
    expect(agentsOf(errored.root)).toHaveLength(3);
    expect(fixtureRecord('14-aborted-spawn').totals.subagentsUnreceived).toBe(1);
  });

  it('a STALLED spawning call has no result either — both running and stalled count', () => {
    // phase-7 verifier D3: dropping `stalled` from the rule left 445 tests green,
    // because fixture 14's spawn is `running` and nothing else is stalled. A stalled
    // call is a running call the session has been silent over; it has no result.
    const fixture = buildSyntheticStatsFixtures().find((f) => f.id === '14-aborted-spawn');
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const stalled: SessionState = {
      ...fixture.state,
      root: {
        ...fixture.state.root,
        children: fixture.state.root.children.map((child) =>
          !isAgentNode(child) && child.id === 'g0'
            ? { ...child, status: 'stalled' as const, stalledSinceMs: SYNTHETIC_NOW_MS - 1 }
            : child,
        ),
      },
    };
    const record = deriveStats(stalled, { now: SYNTHETIC_NOW_MS });
    expect(agentsOf(stalled.root)).toHaveLength(3);
    expect(record.agents.find((a) => a.agentId === 'unreceived')?.resultUnreceived).toBe(true);
    expect(record.agents.find((a) => a.agentId === 'received')?.resultUnreceived).toBe(false);
    expect(record.totals.subagentsUnreceived).toBe(1);
  });
});
