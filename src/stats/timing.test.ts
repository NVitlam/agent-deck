/**
 * v0.8.0 Phase 7, DoD 7.2 — F14's six derived figures, over every harvested
 * session of all three engines, through `deriveStats`.
 *
 * ## The inputs are real, and so is the empty-block case
 *
 * Every arm reads a committed corpus session assembled by
 * `corpus.stats.testkit.ts` — the production readers, `SessionModel` for Claude
 * Code, a constant clock. Nothing here hand-builds a `SessionState`.
 *
 * `f14-corpus.test.ts` pins the census of stated instants per TOOL NODE, and
 * every tool node of every engine carries a start. That is not the same
 * statement as "every session states an instant", and the difference is what
 * gives this file its absence arms for free: **two OpenCode sessions in the
 * committed corpus hold no tool part and no usage turn at all**, so they state
 * nothing for F14 to be a function of, and their `timing` is the empty block.
 *
 * The remaining absences — exactly one instant, exactly one tool start — are
 * MANUFACTURED by stripping instants from a deep copy of a real session, each
 * asserted beside its unstripped control. That pairing is what makes an arm
 * evidence rather than a claim: the same bytes must produce the figure and, one
 * field poorer, not produce it. The real case each stands for is named on the
 * test.
 *
 * ## Two mutations this file exists to catch, and how it catches them
 *
 * `wallMs` is not `endedAt - startedAt`: the envelope of a real session is
 * MOVED on a copy and `wallMs` must not move with it. `longestGapMs` is
 * start-to-start: every `endedAtMs` in a real session is REMOVED and
 * `longestGapMs` must not move. Neither arm restates the implementation — each
 * changes an input the wrong implementation reads and the right one does not.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, ToolNode } from '../model/events.js';
import { isAgentNode } from '../model/events.js';

import { CORPUS_READ_BUDGET_MS } from './corpus.testkit.js';
import type { CorpusSession } from './corpus.stats.testkit.js';
import { FIXED_NOW_MS, readCorpusSessions } from './corpus.stats.testkit.js';
import { deriveStats } from './derive.js';
import { parsePricing } from './pricing.js';
import type { StatsEngine, StatsRecord, TimingStats } from './schema.js';
import { buildSyntheticStatsFixtures } from './synthetic.testkit.js';

let sessions: CorpusSession[] = [];
/** One derived record per corpus session, in the same order. */
let records: { entry: CorpusSession; record: StatsRecord }[] = [];

beforeAll(async () => {
  sessions = await readCorpusSessions();
  records = sessions.map((entry) => ({
    entry,
    record: deriveStats(entry.state, { now: FIXED_NOW_MS }),
  }));
}, CORPUS_READ_BUDGET_MS);

// ---------------------------------------------------------------------------
// Reading the instants back out, independently of the deriver
// ---------------------------------------------------------------------------

interface Instants {
  starts: number[];
  ends: number[];
  turns: number[];
}

/**
 * Every F14 instant one session states, gathered by this file's OWN walk.
 *
 * Deliberately not `derive.ts`'s `sessionSequence`: the cross-checks below
 * compare the deriver's answer against a second reading of the same tree, and
 * sharing the walk would make them one reading asserted twice.
 */
function instantsOf(state: SessionState): Instants {
  const out: Instants = { starts: [], ends: [], turns: [] };
  const visit = (node: AgentNode): void => {
    for (const turn of node.usageSeries ?? []) {
      if (turn.atMs !== undefined) out.turns.push(turn.atMs);
    }
    for (const child of node.children) {
      if (isAgentNode(child)) visit(child);
      else {
        if (child.startedAtMs !== undefined) out.starts.push(child.startedAtMs);
        if (child.endedAtMs !== undefined) out.ends.push(child.endedAtMs);
      }
    }
  };
  visit(state.root);
  return out;
}

function allOf(instants: Instants): number[] {
  return [...instants.starts, ...instants.ends, ...instants.turns];
}

// ---------------------------------------------------------------------------
// Manufacturing an absence from a real session
// ---------------------------------------------------------------------------

/** Which of a session's instants a copy keeps. */
interface KeepSpec {
  /** Keep tool starts. A number keeps the first n in walk order. */
  starts: boolean | number;
  ends: boolean;
  turns: boolean;
}

/**
 * A deep copy of a real session with some of its F14 instants removed.
 *
 * The tree is rebuilt node by node rather than spread-copied at the root, so
 * the original is untouched — `readCorpusSessions` memoises one set of states
 * for the whole worker, and a mutation here would reach every other test in
 * this file through a door nobody would look at twice.
 */
function stripInstants(state: SessionState, keep: KeepSpec): SessionState {
  let startsKept = 0;
  const startLimit = typeof keep.starts === 'number' ? keep.starts : keep.starts ? Infinity : 0;
  const copyTool = (tool: ToolNode): ToolNode => {
    const next: ToolNode = { ...tool };
    if (next.startedAtMs !== undefined) {
      if (startsKept < startLimit) startsKept += 1;
      else delete next.startedAtMs;
    }
    if (!keep.ends) delete next.endedAtMs;
    return next;
  };
  const copyAgent = (node: AgentNode): AgentNode => ({
    ...node,
    ...(node.usageSeries === undefined
      ? {}
      : {
          usageSeries: node.usageSeries.map((turn) => {
            const next = { ...turn };
            if (!keep.turns) delete next.atMs;
            return next;
          }),
        }),
    children: node.children.map((child) => (isAgentNode(child) ? copyAgent(child) : copyTool(child))),
  });
  return { ...state, root: copyAgent(state.root) };
}

function timingOf(state: SessionState): TimingStats {
  return deriveStats(state, { now: FIXED_NOW_MS }).timing;
}

/**
 * The first model id in this tree that F9(b) could actually multiply.
 *
 * BOTH halves are required: `costOfSeries` needs a model id AND a non-empty
 * `usageSeries`, so an agent carrying only the id would select a session whose
 * priced cost is 0 — a subject that looks right and measures nothing.
 */
function pricedAgentModel(node: AgentNode): string | undefined {
  if (node.model !== undefined && (node.usageSeries?.length ?? 0) > 0) return node.model;
  for (const child of node.children) {
    if (!isAgentNode(child)) continue;
    const found = pricedAgentModel(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

interface TimingCensus {
  sessions: number;
  /** Of those, `coverage: 'full'`. An excluded record publishes no figure. */
  full: number;
  /** Records naming `F14:<engine>` — the session stated no instant at all. */
  namedF14: number;
  wallMs: number;
  timeToFirstToolMs: number;
  longestGapMs: number;
  tokensPerMin: number;
  callsPerMin: number;
  costPerHourUsd: number;
}

function census(engine: StatsEngine): TimingCensus {
  const mine = records.filter((r) => r.entry.engine === engine);
  const has = (pick: (t: TimingStats) => number | undefined): number =>
    mine.filter((r) => pick(r.record.timing) !== undefined).length;
  return {
    sessions: mine.length,
    full: mine.filter((r) => r.record.coverage === 'full').length,
    namedF14: mine.filter((r) => r.record.unavailable.includes(`F14:${engine}`)).length,
    wallMs: has((t) => t.wallMs),
    timeToFirstToolMs: has((t) => t.timeToFirstToolMs),
    longestGapMs: has((t) => t.longestGapMs),
    tokensPerMin: has((t) => t.tokensPerMin),
    callsPerMin: has((t) => t.callsPerMin),
    costPerHourUsd: has((t) => t.costPerHourUsd),
  };
}

/**
 * How many harvested sessions of each engine carry each figure.
 *
 * Pinned for the reason `f14-corpus.test.ts` states about its own block: F14's
 * content IS how much of the corpus states a time, and a sweep reporting "the
 * ones that have it, have it" is satisfied by a corpus where none does. Every
 * `sessions` entry is a pinned NON-ZERO literal in the same test as the figures
 * it protects.
 *
 * A harvest moves these. Re-derive from the census this file prints on every
 * run; never edit one number to make a run green.
 */
const CENSUS: Readonly<Record<StatsEngine, TimingCensus>> = {
  /*
   * CLAUDE CODE — every session states a span. ONE of the nine states a single
   * instant and no tool start at all, so its `wallMs` is 0 and every figure
   * that needs a start or a non-zero span is absent on it. That is the 9 / 8
   * split below, and it is one session rather than two different ones.
   */
  cc: {
    sessions: 9,
    full: 9,
    namedF14: 0,
    wallMs: 9,
    timeToFirstToolMs: 8,
    longestGapMs: 8,
    tokensPerMin: 8,
    callsPerMin: 8,
    // No harvested session has a cost source: no engine wrote one, no
    // telemetry is joined by this reader, and the corpus half of the goldens
    // is derived with an EMPTY price table. The positive arm is the priced
    // session below, which is the same real session with a table applied.
    costPerHourUsd: 0,
  },
  /*
   * OPENCODE — 9 sessions, and TWO carry no wall time for two DIFFERENT
   * reasons, which is why `namedF14` is 1 rather than 2:
   *
   *   - one STATES NO INSTANT AT ALL — no tool part, no `step-finish` row, so
   *     nothing for the parse boundary to time. It is the corpus's own witness
   *     for the empty-block path, and it names `F14:opencode`;
   *   - one is EXCLUDED. Its tree states instants and G3 publishes none of
   *     them, and an excluded record names no per-fact gap at all.
   *
   * A third states one instant and no tool start, the Claude Code shape above,
   * which is the 7 / 6 split.
   */
  opencode: {
    sessions: 9,
    full: 8,
    namedF14: 1,
    wallMs: 7,
    timeToFirstToolMs: 6,
    longestGapMs: 6,
    tokensPerMin: 6,
    callsPerMin: 6,
    costPerHourUsd: 0,
  },
  /*
   * CODEX — every record carries a mandatory ISO timestamp, so every session
   * states a span and a first tool. ONE of the five makes a single tool call,
   * and one call is one start: no pair, so no gap.
   */
  codex: {
    sessions: 5,
    full: 5,
    namedF14: 0,
    wallMs: 5,
    timeToFirstToolMs: 5,
    longestGapMs: 4,
    tokensPerMin: 5,
    callsPerMin: 5,
    costPerHourUsd: 0,
  },
};

const ENGINES: readonly StatsEngine[] = ['cc', 'opencode', 'codex'];

function report(engine: StatsEngine, measured: TimingCensus): void {
  process.stdout.write(
    `[F14 timing] ${engine}: sessions ${String(measured.sessions)}, ` +
      `full ${String(measured.full)}, namedF14 ${String(measured.namedF14)}, ` +
      `wallMs ${String(measured.wallMs)}, ` +
      `timeToFirstToolMs ${String(measured.timeToFirstToolMs)}, ` +
      `longestGapMs ${String(measured.longestGapMs)}, ` +
      `tokensPerMin ${String(measured.tokensPerMin)}, ` +
      `callsPerMin ${String(measured.callsPerMin)}, ` +
      `costPerHourUsd ${String(measured.costPerHourUsd)}\n`,
  );
}

// ---------------------------------------------------------------------------

describe.each(ENGINES)('F14 over the %s corpus', (engine) => {
  it('carries each figure on the pinned number of sessions', () => {
    const measured = census(engine);
    report(engine, measured);
    const expected = CENSUS[engine];

    // The vacuity control, in the same test: an engine whose reader returned
    // nothing fails here rather than passing every "how many carry it" count
    // at 0 over an empty set.
    expect(measured.sessions).toBe(expected.sessions);
    expect(measured.sessions).toBeGreaterThan(0);

    expect(measured).toEqual(expected);
  });

  it('states a wall time that is the span of its own instants, not its envelope', () => {
    const mine = records.filter((r) => r.entry.engine === engine);
    let timed = 0;
    let timeless = 0;
    let excluded = 0;
    for (const { entry, record } of mine) {
      if (record.coverage !== 'full') {
        // G3 withholds every fact of an excluded session, its times included —
        // so this one carries an empty block however many instants its tree
        // states, and it is counted here rather than skipped.
        expect(record.timing, entry.state.sessionId).toEqual({});
        excluded += 1;
        continue;
      }
      const instants = allOf(instantsOf(entry.state));
      if (instants.length === 0) {
        // A session stating nothing states no span. Counted rather than
        // skipped, so the two populations below add up to the whole engine.
        expect(record.timing.wallMs, entry.state.sessionId).toBeUndefined();
        timeless += 1;
        continue;
      }
      // Re-derived from this file's own walk of the same tree.
      const span = Math.max(...instants) - Math.min(...instants);
      expect(record.timing.wallMs, entry.state.sessionId).toBe(span);
      timed += 1;
    }
    expect(timed).toBe(CENSUS[engine].wallMs);
    expect(timed + timeless + excluded).toBe(CENSUS[engine].sessions);
    expect(excluded).toBe(CENSUS[engine].sessions - CENSUS[engine].full);
  });

  it('never states a negative time to first tool', () => {
    const mine = records.filter((r) => r.entry.engine === engine);
    let checked = 0;
    for (const { entry, record } of mine) {
      const value = record.timing.timeToFirstToolMs;
      if (value === undefined) continue;
      expect(value, entry.state.sessionId).toBeGreaterThanOrEqual(0);
      const instants = instantsOf(entry.state);
      // Independently: the earliest start minus the earliest instant of any
      // kind. Non-negative by construction because a start IS an instant.
      expect(value, entry.state.sessionId).toBe(
        Math.min(...instants.starts) - Math.min(...allOf(instants)),
      );
      checked += 1;
    }
    expect(checked).toBe(CENSUS[engine].timeToFirstToolMs);
    expect(checked).toBeGreaterThan(0);
  });

  it('never states a gap longer than the wall time', () => {
    const mine = records.filter((r) => r.entry.engine === engine);
    let checked = 0;
    for (const { entry, record } of mine) {
      const gap = record.timing.longestGapMs;
      if (gap === undefined) continue;
      const wall = record.timing.wallMs;
      expect(wall, entry.state.sessionId).toBeDefined();
      expect(gap, entry.state.sessionId).toBeLessThanOrEqual(wall ?? 0);
      checked += 1;
    }
    expect(checked).toBe(CENSUS[engine].longestGapMs);
    expect(checked).toBeGreaterThan(0);
  });

  it('states the exact unrounded quotients for both rates', () => {
    const mine = records.filter((r) => r.entry.engine === engine);
    let checked = 0;
    for (const { entry, record } of mine) {
      const { wallMs, tokensPerMin, callsPerMin } = record.timing;
      if (wallMs === undefined || wallMs === 0) {
        // The gate, asserted from the other side: no rate without a span.
        expect(tokensPerMin, entry.state.sessionId).toBeUndefined();
        expect(callsPerMin, entry.state.sessionId).toBeUndefined();
        continue;
      }
      const minutes = wallMs / 60_000;
      expect(tokensPerMin, entry.state.sessionId).toBe(
        (record.totals.prompt + record.totals.output) / minutes,
      );
      // The call count is every row of the sequence — `tools` is per NAME, so
      // its length is not the population, and summing `calls` is.
      const calls = record.tools.reduce((sum, t) => sum + t.calls, 0);
      expect(callsPerMin, entry.state.sessionId).toBe(calls / minutes);
      checked += 1;
    }
    expect(checked).toBe(CENSUS[engine].tokensPerMin);
    expect(checked).toBeGreaterThan(0);
  });

  it('states no cost per hour where no cost source was selected', () => {
    const mine = records.filter((r) => r.entry.engine === engine);
    let withoutCost = 0;
    for (const { entry, record } of mine) {
      if (record.totals.costSource !== undefined) continue;
      expect(record.timing.costPerHourUsd, entry.state.sessionId).toBeUndefined();
      withoutCost += 1;
    }
    // Vacuity: the loop above passes over an empty population. Every harvested
    // session of every engine is in it today.
    expect(withoutCost).toBe(CENSUS[engine].sessions);
  });
});

describe('the figures are not rounded', () => {
  it('at least one rate across the corpus carries a fraction', () => {
    // A record that rounded would have substituted a number the session did
    // not produce. The whole-corpus form is the falsifiable one: any single
    // session could divide evenly by chance.
    const fractional = records.filter(({ record }) => {
      const rate = record.timing.tokensPerMin;
      return rate !== undefined && !Number.isInteger(rate);
    });
    expect(fractional.length).toBeGreaterThan(0);
    expect(records.length).toBeGreaterThan(15);
  });
});

describe('wallMs is not the session envelope', () => {
  it('does not move when the envelope moves, and differs from it on the corpus', () => {
    // ARM 1 — the same bytes, with `root.startedAt`/`endedAt` displaced by an
    // hour in each direction. An `endedAt - startedAt` implementation moves by
    // two hours; this one reads no envelope field at all.
    const subject = records.find(({ record }) => record.timing.wallMs !== undefined);
    expect(subject).toBeDefined();
    if (subject === undefined) return;
    const { entry, record } = subject;
    const moved: SessionState = {
      ...entry.state,
      root: {
        ...entry.state.root,
        startedAt: entry.state.root.startedAt - 3_600_000,
        ...(entry.state.root.endedAt === undefined
          ? {}
          : { endedAt: entry.state.root.endedAt + 3_600_000 }),
      },
    };
    expect(timingOf(moved).wallMs).toBe(record.timing.wallMs);

    // ARM 2 — the two quantities are really different numbers on real data, so
    // arm 1 is not comparing a figure with itself.
    const differing = records.filter(({ record: r }) => {
      if (r.endedAt === undefined || r.timing.wallMs === undefined) return false;
      return r.timing.wallMs !== r.endedAt - r.startedAt;
    });
    expect(differing.length).toBeGreaterThan(0);
  });
});

describe('longestGapMs is start-to-start', () => {
  it('is unchanged when every stated END is removed', () => {
    // An end-to-start implementation loses its second operand entirely here and
    // either vanishes or changes; a start-to-start one cannot notice.
    let checked = 0;
    for (const { entry, record } of records) {
      if (record.timing.longestGapMs === undefined) continue;
      const endless = stripInstants(entry.state, { starts: true, ends: false, turns: true });
      expect(timingOf(endless).longestGapMs, entry.state.sessionId).toBe(
        record.timing.longestGapMs,
      );
      checked += 1;
    }
    // The population, pinned: without it this passes over a corpus in which no
    // session states a gap at all.
    expect(checked).toBe(
      CENSUS.cc.longestGapMs + CENSUS.opencode.longestGapMs + CENSUS.codex.longestGapMs,
    );
    expect(checked).toBeGreaterThan(15);
  });

  it('is absent where only one call states a start, and present on the control', () => {
    const subject = records.find(({ record }) => record.timing.longestGapMs !== undefined);
    expect(subject).toBeDefined();
    if (subject === undefined) return;
    // The real case: a session whose only timestamped call is its first. Every
    // harvested session states more than one, so it is made from one.
    const single = stripInstants(subject.entry.state, { starts: 1, ends: true, turns: true });
    const timing = timingOf(single);
    expect(timing.longestGapMs).toBeUndefined();
    // The control, and the two halves that must survive: one start is still an
    // instant, so a wall time and a time to first tool are still derivable.
    expect(timing.wallMs).toBeDefined();
    expect(timing.timeToFirstToolMs).toBeDefined();
    expect(subject.record.timing.longestGapMs).toBeDefined();
  });
});

describe('a session that states no instant at all', () => {
  it('is a real OpenCode session, not only a manufactured one', () => {
    // ONE of the nine committed OpenCode sessions holds no tool part and no
    // usage turn, so it states nothing F14 is a function of. This is the arm
    // the corpus supplies for free, and it is what stops the manufactured arms
    // below from being the only evidence that the path exists.
    const timeless = records.filter(
      ({ entry }) => allOf(instantsOf(entry.state)).length === 0,
    );
    expect(timeless).toHaveLength(1);
    const subject = timeless[0];
    expect(subject).toBeDefined();
    if (subject === undefined) return;
    expect(subject.entry.engine).toBe('opencode');
    expect(subject.record.coverage).toBe('full');
    expect(subject.record.timing).toEqual({});
    expect(subject.record.unavailable).toContain('F14:opencode');

    // The two ways a record can carry an empty block are kept apart here,
    // because they are different facts and both occur in this corpus: the
    // session above STATES no instant, and the excluded session below states
    // plenty and publishes none. Only the first names `F14`.
    const excluded = records.filter(({ record }) => record.coverage !== 'full');
    expect(excluded).toHaveLength(1);
    const refused = excluded[0];
    expect(refused).toBeDefined();
    if (refused === undefined) return;
    expect(refused.record.timing).toEqual({});
    expect(allOf(instantsOf(refused.entry.state)).length).toBeGreaterThan(0);
    expect(refused.record.unavailable).toEqual([]);
  });

  it('carries an empty block and names F14, beside its unstripped control', () => {
    // The manufactured arm, per engine, because the real one above is OpenCode
    // only. DoD 7.1's contract is "absent where the engine states none", so a
    // Codex thread whose records carry an unreadable timestamp reaches this
    // path on an engine the corpus cannot demonstrate it for. Stripped from a
    // real session rather than hand-built, so both arms are the same bytes.
    let checked = 0;
    for (const engine of ENGINES) {
      // A session that ALREADY states no instant would make the control half
      // vacuous, so the subject is one that states a span.
      const subject = records.find(
        (r) => r.entry.engine === engine && r.record.timing.wallMs !== undefined,
      );
      expect(subject, engine).toBeDefined();
      if (subject === undefined) continue;
      const timeless = stripInstants(subject.entry.state, {
        starts: false,
        ends: false,
        turns: false,
      });
      const stripped = deriveStats(timeless, { now: FIXED_NOW_MS });
      expect(stripped.timing, engine).toEqual({});
      expect(stripped.unavailable, engine).toContain(`F14:${engine}`);

      // The control: the same session, unstripped, states a span and names no
      // gap. Without it the arm above passes for a deriver that emits `{}`
      // always.
      expect(subject.record.timing.wallMs, engine).toBeDefined();
      expect(subject.record.unavailable, engine).not.toContain(`F14:${engine}`);
      checked += 1;
    }
    expect(checked).toBe(ENGINES.length);
  });

  it('states 0 where exactly one instant survives', () => {
    // 0 is a real answer, not an absence: a session with one timestamped call
    // spans no measured time. Kept apart from the empty-block case above on
    // purpose — collapsing them would be the substitution §D forbids.
    const subject = records.find(({ record }) => record.timing.wallMs !== undefined);
    expect(subject).toBeDefined();
    if (subject === undefined) return;
    const one = stripInstants(subject.entry.state, { starts: 1, ends: false, turns: false });
    const timing = timingOf(one);
    expect(timing.wallMs).toBe(0);
    expect(timing.timeToFirstToolMs).toBe(0);
    // No span, so no rate. `Infinity` is a value the validator rejects.
    expect(timing.tokensPerMin).toBeUndefined();
    expect(timing.callsPerMin).toBeUndefined();
    expect(timing.costPerHourUsd).toBeUndefined();
    // And the block is not empty, so F14 is not named.
    expect(deriveStats(one, { now: FIXED_NOW_MS }).unavailable).not.toContain(
      `F14:${subject.entry.engine}`,
    );
  });
});

describe('costPerHourUsd is present only WITH a cost source', () => {
  it('appears when the user prices a real session, and not when they do not', () => {
    // The corpus states no cost of its own, so the positive arm is a real
    // session priced through the real `parsePricing` with a table built from
    // that session's OWN model id — F9(b), the path a user with an
    // `agentDeck.pricing` entry takes.
    // Selected on the INPUT — an agent stating a model id and a non-empty
    // usage series, which is what F9(b) multiplies — rather than on the
    // deriver's own answer, which would be selecting the subject with the
    // thing under test.
    let model: string | undefined;
    const priceable = records.find(({ entry, record }) => {
      if ((record.timing.wallMs ?? 0) <= 0) return false;
      const found = pricedAgentModel(entry.state.root);
      if (found === undefined) return false;
      model = found;
      return true;
    });
    expect(priceable).toBeDefined();
    expect(model).toBeDefined();
    if (priceable === undefined || model === undefined) return;

    const { table } = parsePricing({
      [model]: { prompt: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
    });
    const priced = deriveStats(priceable.entry.state, { now: FIXED_NOW_MS, pricing: table });
    expect(priced.totals.costSource).toBe('user');
    expect(priced.totals.costUsd).toBeGreaterThan(0);
    const wallMs = priced.timing.wallMs;
    expect(wallMs).toBeDefined();
    expect(priced.timing.costPerHourUsd).toBe(
      (priced.totals.costUsd ?? 0) / ((wallMs ?? 1) / 3_600_000),
    );

    // The negative arm, same session, no table — which is how every corpus
    // golden is derived.
    expect(priceable.record.totals.costSource).toBeUndefined();
    expect(priceable.record.timing.costPerHourUsd).toBeUndefined();
  });
});

describe('the R8 fixtures state no instant, and say so', () => {
  it('every one carries an empty block and names F14 for its engine', () => {
    // R8's builders carry no timestamp on any node, so the fourteen fixtures
    // are the whole synthetic population of the "states no time" path — which
    // is the path no harvested session reaches. Asserted over the SET with its
    // size pinned, because a claim about "every fixture" is satisfied by an
    // empty list.
    const fixtures = buildSyntheticStatsFixtures();
    expect(fixtures).toHaveLength(14);
    let full = 0;
    for (const fixture of fixtures) {
      const record = deriveStats(fixture.state, { now: FIXED_NOW_MS });
      expect(record.timing, fixture.id).toEqual({});
      if (record.coverage !== 'full') continue;
      expect(record.unavailable, fixture.id).toContain(`F14:${fixture.state.engine ?? 'cc'}`);
      full += 1;
    }
    // One fixture is `excluded:parked` and names no gap at all.
    expect(full).toBe(13);
  });
});
