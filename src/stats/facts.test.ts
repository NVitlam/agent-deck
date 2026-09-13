/**
 * DoD 2.4 — every surviving F-fact has a POSITIVE and a NEGATIVE case.
 *
 * The table this file asserts is reproduced in the Phase 2 handoff. Its shape
 * is deliberate: a fact with only a positive case is a fact whose threshold or
 * predicate is untested, and this repository's most-recorded defect is an
 * assertion that would pass whatever the code did. Where the negative arm can
 * be made to sit ONE UNIT away from the positive one, it does — a spike of
 * 4,999 against a threshold of 5,000, a repeat of 2 against a `LOOP_MIN` of 3 —
 * because a negative case chosen far from the boundary tests the boundary not
 * at all.
 */

import { describe, expect, it } from 'vitest';

import type { StatsRecord } from './schema.js';
import { deriveStats } from './derive.js';
import { parsePricing } from './pricing.js';
import { SYNTHETIC_NOW_MS, SYNTHETIC_PRICING, buildSyntheticStatsFixtures } from './synthetic.testkit.js';

const { table: PRICING } = parsePricing(SYNTHETIC_PRICING);

const RECORDS = new Map<string, StatsRecord>(
  buildSyntheticStatsFixtures().map((fixture) => [
    fixture.id,
    deriveStats(fixture.state, { pricing: PRICING, now: SYNTHETIC_NOW_MS }),
  ]),
);

function record(id: string): StatsRecord {
  const found = RECORDS.get(id);
  if (found === undefined) throw new Error(`no fixture ${id}`);
  return found;
}

describe('the fixture set itself', () => {
  it('is the fourteen R8 shapes, each derived once', () => {
    // Vacuity control for every test below: they all read this map.
    expect(RECORDS.size).toBe(14);
    expect([...RECORDS.keys()].sort()[0]).toBe('01-reread-loop');
  });
});

describe('F1 — per-file counts and touch ordinals', () => {
  it('POSITIVE: a file touched three times reports three reads and its span', () => {
    const files = record('01-reread-loop').files;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      filePath: '/synthetic/a.ts',
      reads: 3,
      edits: 0,
      writes: 0,
      errors: 0,
      // SESSION-WIDE sequence positions, not `ToolNode.ordinal`. The suffix on
      // the field names is what keeps the three scales in this record apart —
      // see the header on `FileStats`.
      firstTouchSeq: 0,
      lastTouchSeq: 2,
    });
  });

  it('NEGATIVE: an engine that names no file produces no rows at all', () => {
    // Codex, and it is a CAPABILITY gap rather than an empty session: the
    // session has a tool call, and the record says why the table is empty.
    const codex = record('08-codex-window');
    expect(codex.tools.length).toBeGreaterThan(0);
    expect(codex.files).toEqual([]);
    expect(codex.unavailable).toContain('F1:codex');
  });
});

describe('F2 — per-tool counts, errors and durations', () => {
  it('POSITIVE: calls and errors are counted per tool name', () => {
    const tools = record('02-churn-chain').tools;
    const bash = tools.find((t) => t.toolName === 'Bash');
    const edit = tools.find((t) => t.toolName === 'Edit');
    expect(bash).toMatchObject({ calls: 2, errors: 1, class: 'shell' });
    expect(edit).toMatchObject({ calls: 4, errors: 0, class: 'edit' });
  });

  it('NEGATIVE: the error COLUMN is absent on Codex, and the fact is not', () => {
    const codex = record('08-codex-window');
    expect(codex.tools).toHaveLength(1);
    expect(codex.tools[0]?.calls).toBe(1);
    // Present would be a zero manufactured by this repository's own grafter
    // rule, which knows nothing about success.
    expect(codex.tools[0]).not.toHaveProperty('errors');
    expect(codex.unavailable).toContain('F2.errors:codex');
  });

  it('NEGATIVE: no duration stated means no duration keys', () => {
    const tools = record('01-reread-loop').tools;
    expect(tools[0]).not.toHaveProperty('durationMsSum');
    const stalled = record('12-stall').tools.find((t) => t.toolName === 'Agent');
    expect(stalled).toMatchObject({ durationMsSum: 2_846_600, durationMsMax: 2_846_600 });
  });
});

describe('F3 — identical-call loops', () => {
  it('POSITIVE: three identical calls in one agent are a loop', () => {
    const loops = record('01-reread-loop').loops;
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({
      agentId: 'root',
      toolName: 'Read',
      class: 'read',
      count: 3,
      ordinals: [0, 1, 2],
    });
  });

  it('NEGATIVE: TWO identical calls, one short of LOOP_MIN, are not', () => {
    // The boundary, one unit away. The same fixture carries a `Grep` pair with
    // an identical hash; if it appeared, the threshold would be off by one.
    const loops = record('01-reread-loop').loops;
    expect(loops.map((l) => l.toolName)).not.toContain('Grep');
  });

  it('NEGATIVE: identical PREVIEWS with different hashes are not a loop', () => {
    // The reason `inputHash` is taken before truncation. Three `Write` calls
    // whose previews are byte-identical and whose inputs differ past the cut.
    const oversize = record('07-oversize-input');
    expect(oversize.tools.find((t) => t.toolName === 'Write')?.calls).toBe(3);
    expect(oversize.loops).toEqual([]);
  });
});

describe('F4 — churn chains', () => {
  it('POSITIVE: write, error, write is one chain naming every ordinal between', () => {
    const churn = record('02-churn-chain').churn;
    expect(churn).toHaveLength(1);
    expect(churn[0]).toEqual({
      agentId: 'root',
      filePath: '/synthetic/a.ts',
      fromOrdinal: 0,
      toOrdinal: 2,
      ordinals: [1],
      errors: 1,
    });
  });

  it('NEGATIVE: write, SUCCESS, write is not a chain', () => {
    const churn = record('02-churn-chain').churn;
    expect(churn.map((c) => c.filePath)).not.toContain('/synthetic/b.ts');
  });

  it('NEGATIVE: Codex cannot state an error, so it states no chains', () => {
    const codex = record('08-codex-window');
    expect(codex.churn).toEqual([]);
    expect(codex.unavailable).toContain('F4:codex');
  });
});

describe('F5 — burn per agent and per tree', () => {
  it('POSITIVE: the tree total is the sum of its agents', () => {
    const silent = record('03-silent-subagent');
    expect(silent.agents).toHaveLength(3);
    expect(silent.totals.prompt).toBe(silent.agents.reduce((n, a) => n + a.prompt, 0));
    expect(silent.totals.prompt).toBe(1000 + 10 + 20);
    expect(silent.totals.output).toBe(100 + 1 + 2);
  });

  it('NEGATIVE: an agent stating no burn contributes zero rather than undefined', () => {
    const none = record('06-no-cache-fields');
    expect(none.agents[0]?.prompt).toBe(1000);
    expect(Number.isFinite(none.totals.prompt)).toBe(true);
  });
});

describe('F6 — cache ratio', () => {
  it('POSITIVE: cacheRead over prompt, from the usage series', () => {
    const loop = record('01-reread-loop');
    // One turn, cacheRead 100, against burn.prompt 1000.
    expect(loop.agents[0]?.cacheRead).toBe(100);
    expect(loop.agents[0]?.cacheRatio).toBeCloseTo(0.1, 10);
    expect(loop.totals.cacheRead).toBe(100);
  });

  it('NEGATIVE: no series means no ratio, no cacheRead key, and a named gap', () => {
    const none = record('06-no-cache-fields');
    expect(none.agents[0]).not.toHaveProperty('cacheRead');
    expect(none.agents[0]).not.toHaveProperty('cacheRatio');
    expect(none.totals).not.toHaveProperty('cacheRead');
    expect(none.unavailable).toContain('F6:cc');
  });
});

describe('F7 — context churn', () => {
  it('POSITIVE: a delta at or above SPIKE_TOKENS.cc is reported', () => {
    const spike = record('04-context-spike');
    expect(spike.contextChurn).toHaveLength(1);
    expect(spike.contextChurn[0]).toEqual({ agentId: 'root', ordinal: 1, delta: 6_000 });
  });

  it('NEGATIVE: a delta of 4,999 — one short — is not', () => {
    // The boundary, one token away. The same fixture's third turn rises by
    // 4,999 against a threshold of 5,000.
    const spike = record('04-context-spike');
    expect(spike.contextChurn.map((c) => c.ordinal)).not.toContain(2);
  });

  it('NEGATIVE: an engine with no measured threshold reports the gap, not zero', () => {
    // OpenCode and Codex write no positive cache-creation figure in any
    // committed corpus, so `SPIKE_TOKENS` gives them no key at all. An empty
    // list with no note would read as "measured, and no spikes found".
    for (const [id, engine] of [
      ['09-opencode-cost', 'opencode'],
      ['08-codex-window', 'codex'],
    ] as const) {
      const r = record(id);
      expect(r.contextChurn).toEqual([]);
      expect(r.unavailable).toContain(`F7:${engine}`);
      expect(r.params).not.toHaveProperty('spikeTokens');
    }
  });
});

describe('F8 — subagents and silent subagents', () => {
  it('POSITIVE: a spawned agent with zero tool calls is silent', () => {
    const silent = record('03-silent-subagent');
    expect(silent.totals.subagents).toBe(2);
    expect(silent.totals.silentSubagents).toBe(1);
    expect(silent.agents.find((a) => a.agentId === 'quiet')?.silent).toBe(true);
  });

  it('NEGATIVE: a subagent that called ONE tool is not silent, nor is the main agent', () => {
    const silent = record('03-silent-subagent');
    expect(silent.agents.find((a) => a.agentId === 'busy')?.silent).toBe(false);
    // The main agent of a session with no tools would otherwise be "silent",
    // which is a category error: it is the session.
    const empty = record('04-context-spike');
    expect(empty.agents[0]?.toolCalls).toBe(0);
    expect(empty.agents[0]?.silent).toBe(false);
    expect(empty.totals.silentSubagents).toBe(0);
  });
});

describe('F10 — context fill', () => {
  it('POSITIVE: prompt over the stated window', () => {
    const codex = record('08-codex-window');
    expect(codex.totals.contextFill).toBeCloseTo(64_600 / 258_400, 10);
    expect(codex.totals.contextFill).toBeCloseTo(0.25, 10);
  });

  it('NEGATIVE: an engine that states no window has no key and a named gap', () => {
    const cc = record('01-reread-loop');
    expect(cc.totals).not.toHaveProperty('contextFill');
    expect(cc.unavailable).toContain('F10:cc');
  });
});

describe('F12 — compactions', () => {
  it('POSITIVE: one entry, with the trigger and both token figures', () => {
    const compaction = record('10-compaction');
    expect(compaction.compactions).toEqual([
      {
        agentId: 'root',
        ordinal: 1,
        trigger: 'auto',
        preTokens: 150_000,
        postTokens: 40_000,
        durationMs: 8_200,
      },
    ]);
    expect(compaction.totals.compactions).toBe(1);
  });

  it('NEGATIVE: a session with none, and an engine that writes none', () => {
    expect(record('01-reread-loop').compactions).toEqual([]);
    expect(record('01-reread-loop').totals.compactions).toBe(0);
    // A session that simply has no compaction says nothing in `unavailable` —
    // that is a fact about the session. Codex says so, because it is a fact
    // about the engine. Keeping the two apart is the whole point of the list.
    expect(record('01-reread-loop').unavailable).not.toContain('F12:cc');
    expect(record('08-codex-window').unavailable).toContain('F12:codex');
  });
});

describe('F13 — stalls', () => {
  it('POSITIVE: a tool past the threshold, with time measured from the crossing', () => {
    const stall = record('12-stall');
    expect(stall.stalls).toEqual([
      { agentId: 'root', toolName: 'Bash', ordinal: 0, stalledMs: 600_000 },
    ]);
    expect(stall.totals.stalls).toBe(1);
  });

  it('NEGATIVE: a call that ran 47 minutes and COMPLETED is not a stall', () => {
    // The pair spec §L uses to separate silence from duration. Under a duration
    // reading this call — 2,846.6 s — would be the bigger of the two stalls;
    // under Component 13 it is not a stall at all.
    const stall = record('12-stall');
    expect(stall.stalls.map((s) => s.toolName)).not.toContain('Agent');
    expect(stall.tools.find((t) => t.toolName === 'Agent')?.durationMsMax).toBe(2_846_600);
  });

  it('every record names the completed column as unavailable from a snapshot', () => {
    for (const r of RECORDS.values()) {
      if (r.coverage !== 'full') continue;
      expect(r.unavailable).toContain('F13.completed:snapshot');
    }
  });
});
