/**
 * DoD 3.0 — the corpus testkit yields a REAL `SessionState`, and the Claude
 * Code corpus derives THROUGH IT rather than being silently excluded.
 *
 * ## The finding this exists for
 *
 * `corpus.testkit.ts` used to push `graftSession(...).snapshot` cast
 * `as unknown as SessionState`. A graft snapshot carries `edges` where a state
 * carries `spawnEdges`, and carries no `engine`, no `liveness`, no
 * `workspaceMatch` and no **`schemaOk`**. `coverageOf` reads
 * `state.schemaOk !== true` — strictly, so an ABSENT field is a refusal — which
 * means a deriver fed those snapshots would have returned
 * `coverage: 'excluded:unsupported'` with empty tables for every Claude Code
 * session in the repository.
 *
 * Nothing failed, because nothing asked. Phase 1's assertions are tree-level
 * facts about `ToolNode` and `AgentNode`, where the graft output IS the
 * production output, so the cast was invisible to every test that used it.
 *
 * ## Why this file asserts the OUTCOME and not the fields
 *
 * A test that asserted `state.schemaOk === true` on each session would go green
 * on a testkit that set the field and nothing else — the recorded "a join test
 * can pass while the joined node is discarded" shape, in a different costume.
 * So the assertion is the thing the DoD names: **derive over every session the
 * testkit returns, and require the Claude Code ones to come back `full` with
 * non-empty tables.** A record with a coverage code and empty tables cannot
 * satisfy that, and neither can an empty sweep — the population is counted
 * first.
 *
 * The mutation that pins it: restore the cast in `corpus.testkit.ts` (return
 * graft snapshots) and every Claude Code assertion below goes red on
 * `excluded:unsupported`, while `fields.test.ts` and `series.test.ts` stay
 * green — which is exactly the gap this file closes.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { CORPUS_READ_BUDGET_MS, readCcSessions, readCodexSessions, readOpenCodeSessions, warmCorpus } from './corpus.testkit.js';
import { deriveStats } from './derive.js';

beforeAll(warmCorpus, CORPUS_READ_BUDGET_MS);

describe('DoD 3.0: the testkit hands out states a deriver can actually use', () => {
  it('every Claude Code session carries schemaOk and is INCLUDED, with tables', async () => {
    const states = await readCcSessions();
    // The non-vacuity control, first and by count: an empty sweep passes every
    // loop below it. Stated as a floor rather than an equality because the
    // number moves with the next harvest.
    expect(states.length, 'no Claude Code session came back from the testkit').toBeGreaterThan(0);

    let withTables = 0;
    for (const state of states) {
      // The field the cast was missing, asserted directly as well as through
      // the outcome: when this goes red the reason is legible in one line
      // instead of arriving as thirty coverage failures.
      expect(state.schemaOk, `${state.sessionId}: no schemaOk on the state`).toBe(true);
      expect(state.engine ?? 'cc', `${state.sessionId}: engine`).toBe('cc');

      const record = deriveStats(state);
      expect(record.coverage, `${state.sessionId}: coverage`).toBe('full');
      expect(record.sessionId).toBe(state.sessionId);
      // Every session has a root agent, so this table is never empty for an
      // included session, whatever the session did.
      expect(record.agents.length, `${state.sessionId}: agents`).toBeGreaterThan(0);
      if (record.tools.length > 0 && record.files.length > 0) withTables += 1;
    }

    /*
     * AND THE TABLES ARE REALLY POPULATED SOMEWHERE.
     *
     * Not asserted per session, deliberately: a real corpus legitimately holds
     * sessions that called no tool — the smallest committed Claude Code
     * session derives to 534 bytes with zero tools and zero files, and
     * requiring every session to have both would be a rule that fails on
     * honest data. What the DoD is asking for is that the CORPUS derives to
     * something rather than to thirty empty shells, so the floor is on the
     * population.
     */
    expect(withTables, 'no Claude Code session derived a non-empty tool AND file table')
      .toBeGreaterThan(0);
  });

  it('the other two engines derive through the same view, and coverage follows G3', async () => {
    /*
     * The unification made all three engines one reader, so a regression in
     * the shared path would show here first. Codex and OpenCode never had the
     * cast — they were always real states — which is what makes them the
     * control on the change rather than its subject.
     *
     * COVERAGE IS ASSERTED AS THE RULE, NOT AS `full`. The first version of
     * this test required every session to derive `full` and went red on
     * `ses_fc8d8bb41ffeTH4iLV8HiV1kQJ`, an OpenCode session in the committed
     * corpus that legitimately has a parked graft. That was the TEST being
     * wrong, not the product: G3 extended says a session with a non-empty
     * `parked` is `excluded:parked` with empty tables, so a corpus that
     * contains one is a corpus exercising the rule. Asserting the rule is also
     * strictly stronger than asserting `full` — it pins the exclusion arm as
     * well, against real data rather than a manufactured state.
     */
    let full = 0;
    let parked = 0;
    let total = 0;
    for (const [engine, read] of [
      ['opencode', readOpenCodeSessions],
      ['codex', readCodexSessions],
    ] as const) {
      const states = await read();
      expect(states.length, `no ${engine} session came back`).toBeGreaterThan(0);
      for (const state of states) {
        total += 1;
        expect(state.schemaOk, `${engine} ${state.sessionId}: schemaOk`).toBe(true);
        const record = deriveStats(state);
        if ((state.parked ?? []).length > 0) {
          expect(record.coverage, `${engine} ${state.sessionId}`).toBe('excluded:parked');
          // Total exclusion, not a filtered tree — the half of G3 that makes
          // the code mean something.
          expect(record.tools, `${engine} ${state.sessionId}`).toStrictEqual([]);
          expect(record.files, `${engine} ${state.sessionId}`).toStrictEqual([]);
          parked += 1;
          continue;
        }
        expect(record.coverage, `${engine} ${state.sessionId}`).toBe('full');
        full += 1;
      }
    }
    // The population floor: a reader that returned only parked sessions would
    // satisfy every assertion above.
    expect(full, 'no OpenCode or Codex session derived full coverage').toBeGreaterThan(0);

    /*
     * AND EVERY SESSION WENT DOWN ONE ARM OR THE OTHER.
     *
     * This replaced `expect(parked).toBeGreaterThanOrEqual(0)`, which
     * `phase-verifier` correctly called vacuous: the counter starts at 0, so
     * the assertion could not fail, while the comment above it claimed it
     * showed the exclusion arm had been exercised. It showed nothing.
     *
     * A floor of `parked > 0` was the other option and is rejected: whether
     * the committed corpora contain a parked session is a property of the next
     * HARVEST, and a test that goes red because a corpus was recaptured is the
     * "do not assert fixture-set sizes" rule in a different costume. What is
     * invariant is the PARTITION — coverage is `full` or an exclusion, never
     * something else and never nothing — and that is what is asserted.
     */
    expect(full + parked, 'a session went down neither arm').toBe(total);
  });

  it('a state with schemaOk removed IS excluded — the check is not vacuous', async () => {
    // The control for the two tests above: if `coverageOf` had stopped reading
    // `schemaOk` at all, they would pass over any state whatsoever. The
    // testkit's arrays are frozen, so this takes its own copy and says so.
    const [first] = await readCcSessions();
    expect(first).toBeDefined();
    if (first === undefined) return;
    const withoutFlag = structuredClone(first) as unknown as Record<string, unknown>;
    delete withoutFlag['schemaOk'];
    const record = deriveStats(withoutFlag as unknown as typeof first);
    expect(record.coverage).toBe('excluded:unsupported');
    expect(record.tools).toStrictEqual([]);
    expect(record.files).toStrictEqual([]);
  });
});
