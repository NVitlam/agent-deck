/**
 * v0.7.0 Phase 1, DoD 1.4 and 1.4b — `usageSeries`, `model` and `compactions`,
 * over every committed corpus of all three engines.
 *
 * ## The identity this file exists to hold
 *
 *     burn.prompt === Σ (input + cacheCreation + cacheRead)
 *     burn.output === Σ output
 *
 * `burn` and the series are computed by SEPARATE code on every engine — CC sums
 * a per-message `prompt`/`output` pair, OpenCode reads session-row totals, Codex
 * reads a running `total_token_usage` — so this is a real cross-check and not a
 * restatement. If it ever fails, `burn` is wrong or the series is, and the two
 * being computed apart is what makes the failure visible instead of silent.
 *
 * ## Absent is not empty, and both are asserted
 *
 * `usageSeries` absent means "this engine states no series for this agent". An
 * empty array would mean "measured, and there were no turns". Every assertion
 * below distinguishes them, because the Phase 2 deriver's `unavailable` branch
 * turns on exactly that difference.
 *
 * ## Why this is a corpus sweep rather than a fixed list
 *
 * Corpus counts move with every harvest, and this repository's most-recorded
 * defect is a number written down that a later commit invalidates. So nothing
 * here asserts how MANY sessions or turns there are. What is asserted is that
 * the sweep saw a non-empty population — otherwise every `for` loop below would
 * pass by iterating nothing, which is this repository's other most-recorded
 * defect.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { isAgentNode, type AgentNode, type SessionState } from '../model/events.js';
import { agentNodes } from '../model/graft.js';

import {
  CORPUS_READ_BUDGET_MS,
  readCcSessions,
  readCodexSessions,
  readOpenCodeSessions,
  warmCorpus,
} from './corpus.testkit.js';

// The ONE cold read of all three corpora, paid here where it has a budget
// rather than inside whichever test happens to call first. See the hook's
// header in corpus.testkit.ts: the tests keep vitest's 5 s default and now do
// only their own work.
beforeAll(warmCorpus, CORPUS_READ_BUDGET_MS);

/** Sum a series the way `burn` is defined. */
function sumSeries(agent: AgentNode): { prompt: number; output: number } {
  let prompt = 0;
  let output = 0;
  for (const turn of agent.usageSeries ?? []) {
    prompt += turn.input + turn.cacheCreation + turn.cacheRead;
    output += turn.output;
  }
  return { prompt, output };
}

function allAgents(states: readonly SessionState[]): AgentNode[] {
  return states.flatMap((state) => agentNodes(state.root));
}

const ENGINES = [
  { name: 'cc', read: readCcSessions },
  { name: 'opencode', read: readOpenCodeSessions },
  { name: 'codex', read: readCodexSessions },
] as const;

/**
 * The engines that state a per-turn series at all.
 *
 * Codex is absent BY MEASUREMENT, not by omission: its `last_token_usage` sums
 * to more than its own final `total_token_usage` on 1 of 14 committed threads,
 * so it cannot be said to state a series that reproduces its burn. The block
 * comment in `src/codex/parse.ts`'s `readUsage` carries the numbers, and the
 * absence is asserted below rather than left untested.
 */
const SERIES_ENGINES = ENGINES.filter((e) => e.name !== 'codex');

describe.each(SERIES_ENGINES)('DoD 1.4 — usageSeries reproduces burn ($name)', ({ name, read }) => {
  it('sums to burn exactly, on every agent that has a series', async () => {
    const agents = allAgents(await read());
    expect(agents.length, `${name}: the sweep found no agents at all`).toBeGreaterThan(0);

    const withSeries = agents.filter((a) => a.usageSeries !== undefined);
    // NON-VACUITY. Without this the loop below passes on an engine whose series
    // never got wired, which is precisely the regression it is here to catch.
    expect(withSeries.length, `${name}: no agent carries a usageSeries`).toBeGreaterThan(0);

    for (const agent of withSeries) {
      const summed = sumSeries(agent);
      expect(agent.burn, `${name}/${agent.id}: has a series but no burn`).toBeDefined();
      expect(summed.prompt, `${name}/${agent.id} prompt`).toBe(agent.burn?.prompt);
      expect(summed.output, `${name}/${agent.id} output`).toBe(agent.burn?.output);
    }
  });

  it('never emits an EMPTY series — absent and empty are different claims', async () => {
    for (const agent of allAgents(await read())) {
      if (agent.usageSeries === undefined) continue;
      expect(agent.usageSeries.length, `${name}/${agent.id}`).toBeGreaterThan(0);
    }
  });

  it('numbers its turns densely from 0, in engine order', async () => {
    for (const agent of allAgents(await read())) {
      const series = agent.usageSeries;
      if (series === undefined) continue;
      expect(series.map((t) => t.ordinal), `${name}/${agent.id}`).toStrictEqual(
        series.map((_, i) => i),
      );
    }
  });

  it('states every component as a non-negative finite number', async () => {
    for (const agent of allAgents(await read())) {
      for (const turn of agent.usageSeries ?? []) {
        for (const key of ['input', 'cacheCreation', 'cacheRead', 'output'] as const) {
          expect(Number.isFinite(turn[key]), `${name}/${agent.id}.${key}`).toBe(true);
          expect(turn[key], `${name}/${agent.id}.${key}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe('DoD 1.4 — the components are kept apart, which is what F6 and F7 need', () => {
  it('carries a non-zero cacheRead somewhere on CC, so the split is real', async () => {
    // A series whose components were pre-summed into `prompt` would satisfy
    // every identity above and make F6 (cache ratio) underivable. This is the
    // assertion that the split survived.
    const turns = allAgents(await readCcSessions()).flatMap((a) => [...(a.usageSeries ?? [])]);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.some((t) => t.cacheRead > 0)).toBe(true);
  });

  it('carries a non-zero cacheCreation somewhere on CC — the quantity F7 spikes on', async () => {
    const turns = allAgents(await readCcSessions()).flatMap((a) => [...(a.usageSeries ?? [])]);
    expect(turns.some((t) => t.cacheCreation > 0)).toBe(true);
  });

  it('has NO positive cacheCreation on OpenCode, which is measured not missing', async () => {
    /*
     * Phase 0, DoD 0.6: OpenCode's `tokens.cache.write` is 0 in all 210
     * `step-finish` rows across all three stores, and Codex never writes a
     * positive `cache_write_input_tokens` either. That is why F7 cannot fire on
     * either engine at any threshold, and why `SPIKE_TOKENS` is keyed to CC
     * alone.
     *
     * Pinned here so the day an engine starts reporting it, this goes red and
     * somebody re-reads the constant rather than discovering it in a chart.
     */
    const turns = allAgents(await readOpenCodeSessions()).flatMap((a) => [
      ...(a.usageSeries ?? []),
    ]);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((t) => t.cacheCreation === 0)).toBe(true);
  });
});

describe('DoD 1.4/1.5 — Codex states NO usage series, and the absence is the assertion', () => {
  it('leaves usageSeries absent on every Codex agent', async () => {
    /*
     * NOT an oversight and NOT "not implemented yet". Measured over every
     * `token_count` record of every committed Codex thread: the sum of
     * `last_token_usage` equals the final `total_token_usage` on 13 of 14
     * threads and EXCEEDS it on `01a0641e-f36c-7503…` (102,882 against 86,011,
     * an excess equal to that thread's own first turn, whose `token_count`
     * record is emitted TWICE, byte-identical).
     *
     * The count read "11 of 12" until `phase-verifier` re-derived it: a glob
     * that stopped at `2026/09/03` missed the two `baseline` threads dated
     * `2026/09/02`. The three load-bearing figures were right and the
     * DENOMINATOR was not — this repository's most-recorded defect wearing a
     * scope instead of a stale value.
     *
     * DoD 1.4's identity is what `usageSeries` MEANS, so an engine that cannot
     * satisfy it does not have one. The locked answer's `unavailable` branch is
     * exactly this case, and its "never approximated from totals" clause rules
     * out the two available workarounds — special-casing that thread, or
     * differencing `total_token_usage` into deltas.
     *
     * Absent rather than empty: empty would claim we measured turns and found
     * none.
     */
    const agents = allAgents(await readCodexSessions());
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent.usageSeries, agent.id).toBeUndefined();
    }
  });

  it('still states burn and contextNow, which need no series', async () => {
    // The absence above must not have taken the token figures with it.
    const agents = allAgents(await readCodexSessions());
    expect(agents.some((a) => a.burn !== undefined)).toBe(true);
    expect(agents.some((a) => a.contextNow !== undefined)).toBe(true);
  });
});

describe('DoD 1.4b — model', () => {
  it('is stated verbatim on every engine that writes one', async () => {
    for (const { name, read } of ENGINES) {
      const agents = allAgents(await read());
      const withModel = agents.filter((a) => a.model !== undefined);
      expect(withModel.length, `${name}: no agent carries a model`).toBeGreaterThan(0);
      for (const agent of withModel) {
        expect(typeof agent.model, `${name}/${agent.id}`).toBe('string');
        expect(agent.model, `${name}/${agent.id}`).not.toBe('');
        // Verbatim: never normalised, never mapped to a family. A value that
        // had been tidied would have lost its provider prefix or its suffix.
        expect(agent.model?.trim(), `${name}/${agent.id}`).toBe(agent.model);
      }
    }
  });
});

describe('DoD 1.4b — compactions', () => {
  it('records the CC compaction fixture with its trigger and token figures', async () => {
    const agents = allAgents(await readCcSessions());
    const compactions = agents.flatMap((a) => [...(a.compactions ?? [])]);

    // Phase 0 DoD 0.3b measured these across the committed CC corpora: one
    // `manual` in cc-2.1.241, one `auto` and one `manual` in cc-2.1.260. The
    // TRIGGERS are asserted rather than the count, because a count moves with
    // the corpus and the trigger set is the fact 0.3b established — that auto
    // and manual share one shape and one reader serves both.
    expect(compactions.length).toBeGreaterThan(0);
    expect(new Set(compactions.map((c) => c.trigger))).toStrictEqual(new Set(['auto', 'manual']));

    for (const record of compactions) {
      expect(record.ordinal).toBeGreaterThanOrEqual(0);
      // CC states both token halves and a duration on every observed entry.
      expect(typeof record.preTokens).toBe('number');
      expect(typeof record.postTokens).toBe('number');
      expect(typeof record.durationMs).toBe('number');
    }
  });

  it('records OpenCode compactions as `engine`, with NO token figures', async () => {
    const compactions = allAgents(await readOpenCodeSessions()).flatMap((a) => [
      ...(a.compactions ?? []),
    ]);
    expect(compactions.length).toBeGreaterThan(0);
    for (const record of compactions) {
      expect(record.trigger).toBe('engine');
      // OpenCode states that a compaction happened and nothing about its cost.
      // Absent, never 0 — 0 would be a claim.
      expect(record.preTokens).toBeUndefined();
      expect(record.postTokens).toBeUndefined();
    }
  });

  it('records NO compaction on Codex — F12 is UNAVAILABLE there', async () => {
    // Measured in Phase 0: no Codex payload type carries a compaction entry at
    // all. Absent rather than an empty array, so "we looked and found none" is
    // never claimed.
    for (const agent of allAgents(await readCodexSessions())) {
      expect(agent.compactions, agent.id).toBeUndefined();
    }
  });

  it('never emits an EMPTY compactions array on any engine', async () => {
    for (const { name, read } of ENGINES) {
      for (const agent of allAgents(await read())) {
        if (agent.compactions === undefined) continue;
        expect(agent.compactions.length, `${name}/${agent.id}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('DoD 1.4 — the tree the fields hang on is still the tree', () => {
  it('leaves every agent node an agent node', async () => {
    // Cheap guard against a spread that accidentally widened a node's shape.
    for (const { read } of ENGINES) {
      for (const state of await read()) {
        expect(isAgentNode(state.root)).toBe(true);
      }
    }
  });
});
