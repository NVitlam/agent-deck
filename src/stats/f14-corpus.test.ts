/**
 * v0.8.0 Phase 7, DoD 7.1 — F14's availability over every harvested corpus,
 * per engine, counted through the PRODUCTION path and pinned.
 *
 * The DoD's own words: *"every harvested golden's tool nodes carry a start or
 * are counted as `F14:absent` per engine, with the counts pinned."* Spec
 * `Amendment 2026-09-12`, F14: `startedAtMs`/`endedAtMs` on every `ToolNode`
 * and `atMs` on every `usageSeries` turn, *"gathered at the parse boundary,
 * from the engine's own timestamps only; absent where the engine states none"*.
 *
 * ## Counts are pinned here, against this repository's usual rule
 *
 * `CLAUDE.md` says not to assert fixture-set sizes, because a count pinned to
 * today's capture reads as a regression on the next harvest. DoD 7.1 asks for
 * the opposite and it is the right call for THIS property: F14's whole content
 * is *how much of the corpus states a time*, and a sweep that reports "all the
 * ones that have it, have it" is satisfied by a corpus where nothing does.
 *
 * The cost is stated rather than hidden: **a harvest moves every literal in
 * {@link CENSUS}.** When one of these fails after a capture, the fix is to
 * re-derive the block from the run's own printed census — which this file
 * prints on every run, passing or failing — and to check that the ABSENT
 * figures moved for a reason the new corpus explains. A `present` that fell is
 * a defect; a `total` that rose alone is a harvest.
 *
 * ## The vacuity control is the point of the block, not decoration
 *
 * A zero-valued "absent" count is evidence only if something independently
 * pins the population as non-empty — this repository has shipped the other
 * shape more than once (a counter named for what is MISSING cannot prove that
 * something is PRESENT; `toBeGreaterThan(legacy.tools + 10)` passing at 244 and
 * at 20). So every engine's `sessions`, `toolNodes` and `present` are pinned as
 * exact non-zero literals in the same test as its `absent`, and an engine whose
 * reader returned nothing fails on `sessions` before `absent` is ever read.
 *
 * ## Nothing here builds a `SessionState`
 *
 * `corpus.testkit.ts` reads every committed corpus of all three engines through
 * the real readers and hands back real `SessionState`s. A hand-built tree would
 * measure this file's idea of a tool node; the whole question is what the
 * parse boundary actually emits.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { isAgentNode, type SessionState, type ToolNode } from '../model/events.js';
import { agentNodes, walk } from '../model/graft.js';

import {
  CORPUS_READ_BUDGET_MS,
  readCcSessions,
  readCodexSessions,
  readOpenCodeSessions,
  warmCorpus,
} from './corpus.testkit.js';
import type { StatsEngine } from './schema.js';

// The ONE cold read of all three corpora, paid here where it has a budget
// rather than inside whichever test happens to call first.
beforeAll(warmCorpus, CORPUS_READ_BUDGET_MS);

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

interface ToolCensus {
  /** Sessions the reader handed back for this engine. */
  sessions: number;
  /** `ToolNode`s walked across those sessions. */
  toolNodes: number;
  /** Of those, carrying `startedAtMs`. */
  startPresent: number;
  /** Of those, NOT carrying `startedAtMs` — the DoD's `F14:absent`. */
  startAbsent: number;
  endPresent: number;
  endAbsent: number;
  /**
   * Tool nodes whose `status` is `running`. PRINTED, NOT PINNED.
   *
   * It is what makes an `endAbsent` figure interpretable — a call with no end
   * is a call the capture caught before its result — but the two are not equal
   * by construction on every engine (a refused Codex spawn is `error` and
   * carries a result, and a `tool_result` whose entry has an unreadable
   * timestamp would be `done` with no end), so pinning an equality here would
   * be claiming more than the code guarantees.
   */
  running: number;
}

interface TurnCensus {
  /** Agents carrying a `usageSeries` at all (absent is not empty). */
  agentsWithSeries: number;
  /** `UsageTurn`s walked across those series. */
  turns: number;
  atPresent: number;
  atAbsent: number;
}

function countTools(states: readonly SessionState[]): ToolCensus {
  const census: ToolCensus = {
    sessions: states.length,
    toolNodes: 0,
    startPresent: 0,
    startAbsent: 0,
    endPresent: 0,
    endAbsent: 0,
    running: 0,
  };
  for (const state of states) {
    walk(state.root, (node) => {
      if (isAgentNode(node)) return;
      const tool: ToolNode = node;
      census.toolNodes++;
      if (tool.startedAtMs === undefined) census.startAbsent++;
      else census.startPresent++;
      if (tool.endedAtMs === undefined) census.endAbsent++;
      else census.endPresent++;
      if (tool.status === 'running') census.running++;
    });
  }
  return census;
}

function countTurns(states: readonly SessionState[]): TurnCensus {
  const census: TurnCensus = { agentsWithSeries: 0, turns: 0, atPresent: 0, atAbsent: 0 };
  for (const state of states) {
    for (const agent of agentNodes(state.root)) {
      const series = agent.usageSeries;
      if (series === undefined) continue;
      census.agentsWithSeries++;
      for (const turn of series) {
        census.turns++;
        if (turn.atMs === undefined) census.atAbsent++;
        else census.atPresent++;
      }
    }
  }
  return census;
}

/**
 * What each engine's committed corpora measure today, and WHY each absence is
 * the engine rather than a gap in the parse boundary.
 *
 * Re-derive from the printed census after any harvest; never edit one number to
 * make a run green.
 *
 * **Measured on the run that pinned this block: every absent END is a RUNNING
 * call, on all three engines** — cc 2 and 2, opencode 0 and 0, codex 1 and 1.
 * That is printed rather than asserted (see {@link ToolCensus.running}): the
 * equality holds over today's corpora and is not guaranteed by the code, so
 * pinning it would claim more than the parse boundary promises. It is recorded
 * because it is what makes an `endAbsent` figure mean something — these are
 * calls the capture caught before their result, not calls whose time was lost.
 */
const CENSUS: Readonly<
  Record<
    StatsEngine,
    { readonly tools: Omit<ToolCensus, 'running'>; readonly turns: TurnCensus }
  >
> = {
  /*
   * CLAUDE CODE — every entry in a transcript carries an envelope `timestamp`,
   * and a tool node is built from a `tool_use` block inside one, so a start is
   * stated for every call. An end is stated only where a `tool_result` block
   * arrived, so the absent ends are exactly the calls the capture caught still
   * running (and the ones whose result was written into a later file than the
   * one captured).
   */
  cc: {
    tools: {
      sessions: 9,
      toolNodes: 948,
      startPresent: 948,
      startAbsent: 0,
      // TWO CALLS IN THE WHOLE CORPUS HAVE NO END, and that is the F14:absent
      // population for this engine: a `tool_use` block whose `tool_result`
      // never arrived in a captured file. Nothing else here can produce one,
      // which is why `startAbsent` is 0 and this is not.
      endPresent: 946,
      endAbsent: 2,
    },
    // 899 turns cross-checks against `src/model/graft.ts`'s own independently
    // measured "899 message ids across the 22 transcripts under `fixtures/cc-*`
    // + `/projects/`" — a figure that block derived for a different question.
    turns: { agentsWithSeries: 22, turns: 899, atPresent: 899, atAbsent: 0 },
  },
  /*
   * OPENCODE — `part.data.state.time.start`/`.end`, both present on all 345
   * committed tool parts (anchor 246, witness 99; every one `completed` or
   * `error`, so the running arm is exercised by no fixture). Turn times are the
   * `step-finish` PART ROW's `time_created`: the payload carries no `time` key
   * on any of the 210 committed step-finish parts, so there is no payload field
   * to prefer — `src/opencode/parse.ts` records that census on the call site.
   */
  opencode: {
    tools: {
      sessions: 9,
      // 345 = 246 anchor + 99 witness, which is the tool-part count read
      // straight off the two stores. The production path drops none of them.
      toolNodes: 345,
      startPresent: 345,
      startAbsent: 0,
      endPresent: 345,
      endAbsent: 0,
    },
    // 210 = 147 anchor + 63 witness step-finish parts. Every one carries a
    // row `time_created`, which `db.ts`'s `intOf` guarantees is a finite
    // number or throws — so `atAbsent` is 0 by construction here, not by luck.
    turns: { agentsWithSeries: 29, turns: 210, atPresent: 210, atAbsent: 0 },
  },
  /*
   * CODEX — every record carries a MANDATORY ISO `timestamp` (C2; the parse
   * gate refuses a record without one), so every call has a start. An end is
   * the timestamp of the record carrying that call's output, joined on
   * `call_id`; absent ends are the calls with no output record.
   *
   * `turns` IS ZERO ON EVERY FIELD, AND THAT IS A DIFFERENT FACT FROM A TURN
   * WHOSE TIME IS UNKNOWN. Codex states no `usageSeries` at all — it writes a
   * running `total_token_usage` from which no per-turn figure can be recovered
   * — so there is no turn for `atMs` to hang on. `series.test.ts` asserts
   * `usageSeries === undefined` on every Codex agent, and `agentsWithSeries`
   * here is the same fact counted from this side.
   */
  codex: {
    tools: {
      sessions: 5,
      // 42 cross-checks against the corpus golden's own tool-call total, which
      // `src/codex/types.ts` records as 31 + 10 + 1 across the three call kinds.
      toolNodes: 42,
      startPresent: 42,
      startAbsent: 0,
      // ONE CALL HAS NO OUTPUT RECORD. The join is on `call_id` against
      // `function_call_output` / `custom_tool_call_output`; a call with no such
      // record is the running case and states no end.
      endPresent: 41,
      endAbsent: 1,
    },
    turns: { agentsWithSeries: 0, turns: 0, atPresent: 0, atAbsent: 0 },
  },
};

/** Engine -> its reader. Named so a mistyped tag cannot silently read nothing. */
const READERS: Readonly<Record<StatsEngine, () => Promise<SessionState[]>>> = {
  cc: readCcSessions,
  opencode: readOpenCodeSessions,
  codex: readCodexSessions,
};

const ENGINES: readonly StatsEngine[] = ['cc', 'opencode', 'codex'];

/**
 * Print the measured census, on every run, passing or failing.
 *
 * The block above is a set of literals a later harvest invalidates; printing is
 * what lets the next reader re-derive them from the run that disagreed instead
 * of guessing at a delta. Same reasoning as `warmCorpus`'s printed read time.
 */
function report(engine: StatsEngine, tools: ToolCensus, turns: TurnCensus): void {
  process.stdout.write(
    `[F14] ${engine}: sessions ${String(tools.sessions)}, ` +
      `toolNodes ${String(tools.toolNodes)} ` +
      `(start present ${String(tools.startPresent)} / F14:absent ${String(tools.startAbsent)}; ` +
      `end present ${String(tools.endPresent)} / F14:absent ${String(tools.endAbsent)}; ` +
      `running ${String(tools.running)}), ` +
      `agentsWithSeries ${String(turns.agentsWithSeries)}, turns ${String(turns.turns)} ` +
      `(atMs present ${String(turns.atPresent)} / F14:absent ${String(turns.atAbsent)})\n`,
  );
}

// ---------------------------------------------------------------------------

describe.each(ENGINES)('F14 over the %s corpus', (engine) => {
  const expected = CENSUS[engine];

  it('counts tool-node starts and ends against the pinned census', async () => {
    const states = await READERS[engine]();
    const tools = countTools(states);
    report(engine, tools, countTurns(states));

    // THE VACUITY CONTROL, in the same test as the counts it protects. Each of
    // these is a pinned NON-ZERO literal, so a reader that returned nothing, a
    // walk that visited no tool, or a parse boundary that emitted no start at
    // all fails here rather than passing on an `absent` of 0 over an empty set.
    expect(tools.sessions).toBe(expected.tools.sessions);
    expect(tools.sessions).toBeGreaterThan(0);
    expect(tools.toolNodes).toBe(expected.tools.toolNodes);
    expect(tools.toolNodes).toBeGreaterThan(0);
    expect(tools.startPresent).toBe(expected.tools.startPresent);
    expect(tools.startPresent).toBeGreaterThan(0);

    expect(tools.startAbsent).toBe(expected.tools.startAbsent);
    expect(tools.endPresent).toBe(expected.tools.endPresent);
    expect(tools.endAbsent).toBe(expected.tools.endAbsent);

    // The partition is total in both directions: a node is counted exactly once
    // per field. Without this an off-by-one in the walk could move a node from
    // `present` to `absent` and leave both literals satisfiable by a re-pin.
    expect(tools.startPresent + tools.startAbsent).toBe(tools.toolNodes);
    expect(tools.endPresent + tools.endAbsent).toBe(tools.toolNodes);
  });

  it('counts usage-turn times against the pinned census', async () => {
    const states = await READERS[engine]();
    const turns = countTurns(states);

    // The population gate is the SESSION count, which is non-zero on every
    // engine, rather than the turn count, which is legitimately 0 on Codex.
    // Gating on `turns` would make the Codex arm vacuous in exactly the way
    // this file's header refuses.
    //
    // The Codex arm's four expectations are all 0 and so cannot fail on their
    // own; what stops `countTurns` being satisfied by a helper that counts
    // nothing is that the SAME helper is pinned at 899 and 210 on the other two
    // engines in this same file. The Codex 0 is then a statement about Codex.
    expect(states.length).toBe(expected.tools.sessions);
    expect(states.length).toBeGreaterThan(0);

    expect(turns.agentsWithSeries).toBe(expected.turns.agentsWithSeries);
    expect(turns.turns).toBe(expected.turns.turns);
    expect(turns.atPresent).toBe(expected.turns.atPresent);
    expect(turns.atAbsent).toBe(expected.turns.atAbsent);
    expect(turns.atPresent + turns.atAbsent).toBe(turns.turns);
  });

  it('states every time as a finite epoch millisecond value', async () => {
    const states = await READERS[engine]();
    let checked = 0;
    for (const state of states) {
      walk(state.root, (node) => {
        if (isAgentNode(node)) return;
        for (const value of [node.startedAtMs, node.endedAtMs]) {
          // `continue`, NOT `return`: a `return` here leaves the visitor
          // callback, so a node with an absent start would never have its end
          // checked — and the absent-start case is the commoner one.
          if (value === undefined) continue;
          checked++;
          // Epoch MILLISECONDS, not seconds and not an ISO string. A seconds
          // value would render as 1970 and a string would not compare; both are
          // ruled out by the range rather than by the type alone.
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThan(1_000_000_000_000);
        }
      });
      for (const agent of agentNodes(state.root)) {
        for (const turn of agent.usageSeries ?? []) {
          if (turn.atMs === undefined) continue;
          checked++;
          expect(Number.isFinite(turn.atMs)).toBe(true);
          expect(turn.atMs).toBeGreaterThan(1_000_000_000_000);
        }
      }
    }
    // The loop above returns early on every absent value, so without this the
    // whole test passes over a corpus that states no time anywhere.
    expect(checked).toBeGreaterThan(0);
  });
});
