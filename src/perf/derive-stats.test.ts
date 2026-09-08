/**
 * v0.7.0 DoD 2.8 — the `deriveStats` budget.
 *
 * In the `perf` project (`src/perf/**`), so it runs on the forked, single-fork
 * worker with the other wall-clock assertions rather than beside 3,200 tests in
 * a shared process. `vitest.config.ts` records why that matters: a stage
 * measured 1050.6 ms inside the main project and 12.3 ms as a separate process,
 * with zero overlap either way, so the number belongs to the state of the host
 * process rather than to anything running concurrently.
 *
 * See {@link DERIVE_STATS_BUDGET} for the measurement, the subject and what the
 * limit is and is not for.
 */

import { describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, ToolNode, UsageTurn } from '../model/events.js';
import { deriveStats } from '../stats/derive.js';

import { DERIVE_STATS_BUDGET } from './budgets.js';

/** The unit the budget is quoted in. */
const NODES = 1_000;
const AGENTS = 8;

/** A 40-turn series, with a rising cache-creation so F7 has real work. */
function series(): UsageTurn[] {
  return Array.from({ length: 40 }, (_, ordinal) => ({
    ordinal,
    input: 5,
    cacheCreation: ordinal * 6_000,
    cacheRead: 50,
    output: 3,
  }));
}

function hash(n: number): string {
  return (String(n) + 'f'.repeat(64)).slice(0, 64);
}

/**
 * A 1,000-node session that exercises every fact that costs anything.
 *
 * Eight agents so the per-agent grouping is real; three tool classes across 40
 * distinct files so F1 and F4 both have work; 50 distinct hashes so F3 produces
 * genuine loops; an error every seventeenth call so churn chains actually form.
 * A subject with one agent and no repeats would measure the tree walk and none
 * of the derivation.
 */
function buildSubject(): SessionState {
  const perAgent = Math.floor(NODES / AGENTS);
  const subagents: AgentNode[] = [];
  for (let a = 0; a < AGENTS - 1; a += 1) {
    const tools: ToolNode[] = [];
    for (let i = 0; i < perAgent; i += 1) {
      const name = i % 3 === 0 ? 'Edit' : i % 3 === 1 ? 'Read' : 'Bash';
      tools.push({
        id: `a${String(a)}-t${String(i)}`,
        toolName: name,
        status: i % 17 === 0 ? 'error' : 'done',
        inputPreview: '',
        ordinal: i,
        ...(name === 'Bash' ? {} : { filePath: `/repo/file-${String(i % 40)}.ts` }),
        inputHash: hash(i % 50),
        durationMs: 10 + i,
      });
    }
    subagents.push({
      id: `agent-${String(a)}`,
      kind: 'subagent',
      label: 'perf',
      status: 'done',
      spawnDepth: 1,
      children: tools,
      startedAt: 1,
      burn: { prompt: 1000, output: 10 },
      usageSeries: series(),
      model: 'perf-model',
    });
  }
  const rootTools: ToolNode[] = [];
  for (let i = 0; i < NODES - perAgent * (AGENTS - 1); i += 1) {
    rootTools.push({
      id: `r-t${String(i)}`,
      toolName: 'Read',
      status: 'done',
      inputPreview: '',
      ordinal: i,
      filePath: `/repo/root-${String(i % 20)}.ts`,
      inputHash: hash(i % 30),
    });
  }
  return {
    sessionId: 'perf-derive',
    projectSlug: 'synthetic-perf',
    workspaceMatch: true,
    liveness: 'ended',
    schemaOk: true,
    engine: 'cc',
    totals: { costUsd: 0 },
    root: {
      id: 'root',
      kind: 'main',
      label: 'perf',
      status: 'done',
      spawnDepth: 0,
      children: [...rootTools, ...subagents],
      startedAt: 1,
      burn: { prompt: 1000, output: 10 },
      usageSeries: series(),
    },
  };
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

describe('DoD 2.8 — deriveStats per 1,000 nodes', () => {
  const subject = buildSubject();

  it('the subject really is 1,000 nodes, and the derivation really does work', () => {
    // Vacuity control, first, and it is not decoration: a budget measured over
    // a session the deriver walks past in a few microseconds is a fast zero,
    // and a fast zero passes every limit anybody will ever write here.
    const record = deriveStats(subject, { now: 2 });
    let tools = 0;
    let agents = 1;
    const count = (node: AgentNode): void => {
      for (const child of node.children) {
        if ('children' in child) {
          agents += 1;
          count(child);
        } else {
          tools += 1;
        }
      }
    };
    count(subject.root);
    // The budget's unit is 1,000 TOOL nodes. The eight agents that carry them
    // are what make the per-agent grouping real, and they are counted
    // separately rather than folded in: a subject of 1,000 nodes that were
    // mostly agents would exercise the tree walk and almost none of the
    // derivation, which is the opposite of what this is for.
    expect(tools).toBe(NODES);
    expect(agents).toBe(AGENTS);
    expect(record.agents).toHaveLength(AGENTS);
    // Every expensive fact produced rows. If any of these went to zero the
    // budget would still pass and would have stopped measuring that fact.
    expect(record.files.length).toBeGreaterThan(20);
    expect(record.loops.length).toBeGreaterThan(10);
    expect(record.churn.length).toBeGreaterThan(0);
    expect(record.contextChurn.length).toBeGreaterThan(0);
  });

  it('derives inside its budget', () => {
    const samples: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const started = performance.now();
      deriveStats(subject, { now: 2 });
      samples.push(performance.now() - started);
    }
    // FIRST FIVE DISCARDED, and the numbers in `budgets.ts` say why: they ran
    // 1.634, 1.248, 0.853, 0.932, 0.524 ms against a warm median of 0.540. That
    // is JIT warm-up, not the cost of the function, and including it would set
    // the budget from a state the extension is never in — it derives on every
    // session patch, thousands of times per session.
    const warm = samples.slice(5);
    const value = medianOf(warm);
    process.stdout.write(
      `[perf] budget ${DERIVE_STATS_BUDGET.id} (${DERIVE_STATS_BUDGET.source}, enforced): ` +
        `${value.toFixed(3)} vs ${String(DERIVE_STATS_BUDGET.limitMs)} ms -> ` +
        `${value <= DERIVE_STATS_BUDGET.limitMs ? 'MET' : 'MISSED'}\n`,
    );
    expect(value).toBeLessThanOrEqual(DERIVE_STATS_BUDGET.limitMs);
  });

  it('the recorded margin is the recorded numbers, divided', () => {
    // The self-consistency check every other budget in this file carries: a
    // note claiming a margin the two numbers do not produce is a number written
    // from memory rather than measured.
    expect(DERIVE_STATS_BUDGET.measured.valueMs).toBeGreaterThan(0);
    expect(DERIVE_STATS_BUDGET.limitMs / DERIVE_STATS_BUDGET.measured.valueMs).toBeCloseTo(
      DERIVE_STATS_BUDGET.measured.marginX,
      1,
    );
  });
});
