/**
 * Every committed session of every engine, read THROUGH THE PRODUCTION PATH —
 * v0.7.0 Phase 1, rebuilt on Phase 2's reader in Phase 3 (DoD 3.0).
 *
 * Test-only. Named `.testkit.ts` rather than `.test.ts` deliberately: vitest
 * collects `src/**\/*.test.ts`, so this file is a helper and never a suite of
 * its own. `webview/testkit.ts` sets the precedent, and the privacy sweep's
 * `tests-and-testdata` rule recognises the suffix.
 *
 * ## DoD 3.0 — THE CAST WAS NOT TRUE, AND THE TWO READERS ARE NOW ONE
 *
 * Until Phase 3 this file's Claude Code reader returned
 * `graftSession(...).snapshot`, cast `as unknown as SessionState`. The two
 * shapes, measured rather than suspected:
 *
 *     graft snapshot   burn contextNow counts depthMismatches edges parked
 *                      projectSlug root sessionId totals
 *     SessionState     burn contextNow engine liveness parked projectSlug root
 *                      schemaOk sessionId spawnEdges totals workspaceMatch
 *
 * It carries `edges` where a state carries `spawnEdges`, and it carries no
 * `engine`, no `liveness`, no `workspaceMatch` and — the one that decides it —
 * **no `schemaOk`**. `exclude.ts` reads `schemaOk !== true`, so a deriver fed
 * those states would have marked every Claude Code session in this repository
 * `excluded:unsupported`.
 *
 * That was harmless for Phase 1, whose assertions are all tree-level facts
 * about `ToolNode` and `AgentNode` where the graft output IS the production
 * output. It was a live trap for the next consumer, and Phase 2 walked around
 * it by writing a SECOND reader (`corpus.stats.testkit.ts`) that assembles
 * Claude Code through `SessionModel`, the engine's only real assembly point.
 *
 * Two readers over one corpus is the defect this repository records as "two
 * agreeing literals is not a contract", one level up: they would agree until
 * somebody fixed a discovery bug in one of them. **DoD 3.0's ruling is that
 * they become one.** This file is now a VIEW over that reader — engine-filtered,
 * cloned, and frozen — and no session assembly happens here at all.
 *
 * `corpus.testkit.test.ts` keeps its own contract tests, and
 * `coverage.test.ts` adds the one DoD 3.0 asks for by name: derive over every
 * session this file returns and require the Claude Code ones to come back
 * `coverage: 'full'` with non-empty tables, with the population counted so an
 * empty sweep cannot pass.
 *
 * ## READ ONCE PER ENGINE PER WORKER, AND FROZEN — Phase 1c, 2026-09-07
 *
 * These readers used to re-read and re-graft the ENTIRE corpus on every call.
 * `series.test.ts` alone calls them up to 45 times (15 tests over a
 * `describe.each` of 3 engines) and `fields.test.ts` 39 more, so the committed
 * corpora were being parsed through the production path dozens of times per
 * file to answer questions about bytes that had not changed.
 *
 * That was not merely wasteful, it was RED: on a loaded machine a single call
 * exceeded vitest's 5 s default `testTimeout`, and a test that carries no
 * explicit budget reports that as a timeout with no failing assertion —
 * this repository's recorded "reads green in the summary line" class. It cost
 * two of the thirty runs in the Phase 1c blocks, in two different files.
 *
 * **No timeout was raised.** The work was removed instead. Memoising the
 * PROMISE rather than the value also means two callers that overlap share one
 * read instead of racing two. The underlying reader memoises as well, so the
 * unification below costs one corpus read for both files rather than two.
 *
 * ## Why the result is CLONED and then DEEP-FROZEN
 *
 * A shared array is a correctness hazard the moment any test mutates what it
 * gets back: the next test in the file would silently receive the damage, and
 * the failure would surface somewhere else entirely. Freezing makes that
 * impossible rather than unlikely — ESM is strict mode, so an assignment to a
 * frozen property THROWS, naming the file and line.
 *
 * The CLONE is what the unification added, and it is not belt-and-braces.
 * `corpus.stats.testkit.ts` deliberately does not freeze, and its header says
 * why: the OpenCode and Codex engines hand back states that module does not
 * own, and freezing them would reach into objects other suites read. Freezing
 * the shared objects here would impose this file's contract on that one. So
 * this view takes its own copy first, and the two contracts stay separate —
 * one frozen view, one unfrozen one, over one read.
 *
 * A test that genuinely needs to mutate takes a `structuredClone` first and
 * says why. The audit that accompanied the Phase 1c change found none that did.
 */

import type { SessionState } from '../model/events.js';

import { readCorpusSessions } from './corpus.stats.testkit.js';
import type { StatsEngine } from './schema.js';

/**
 * Freeze a whole object graph.
 *
 * `seen` is not defensive decoration: a `SessionState` tree is walked by key
 * and nothing here guarantees it is acyclic, so a back-reference would
 * otherwise recurse forever and present as a stack overflow inside a helper
 * rather than as anything readable.
 */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object') return value;
  const obj: object = value;
  if (seen.has(obj)) return value;
  seen.add(obj);
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze((obj as Record<string, unknown>)[key], seen);
  }
  return value;
}

/**
 * Every session of one engine, as this file's own frozen copy.
 *
 * THROWS on an empty result rather than returning one. That is the rule the
 * previous implementation stated and it survives the unification unchanged: a
 * discovery bug that finds nothing would otherwise make every caller iterate
 * nothing and pass, which is this repository's most-recorded defect class.
 * The underlying reader throws per engine as well, so this is a second gate
 * over a different question — "did the FILTER find anything" rather than "did
 * the READ find anything" — and a mis-typed engine tag is exactly what it
 * catches.
 */
function viewOf(engine: StatsEngine): () => Promise<SessionState[]> {
  let pending: Promise<SessionState[]> | null = null;
  return () => {
    pending ??= readCorpusSessions().then((all) => {
      const states = all.filter((entry) => entry.engine === engine).map((entry) => entry.state);
      if (states.length === 0) {
        throw new Error(`no ${engine} session in the corpus reader's output`);
      }
      // Copy BEFORE freezing — see the header. `structuredClone` is
      // structural and drops nothing a `SessionState` carries: every value in
      // one is a string, a number, a boolean, an array or a plain object.
      return deepFreeze(structuredClone(states));
    });
    return pending;
  };
}

// ---------------------------------------------------------------------------
// The exported readers
// ---------------------------------------------------------------------------
//
// One view per engine per worker, cloned and deep-frozen, over ONE underlying
// corpus read shared with `corpus.stats.testkit.ts`.

/** Every Claude Code session of every `fixtures/cc-*` corpus. Frozen. */
export const readCcSessions = viewOf('cc');

/** Every OpenCode session of every committed store. Frozen. */
export const readOpenCodeSessions = viewOf('opencode');

/** Every Codex thread of every committed run, as `SessionState`s. Frozen. */
export const readCodexSessions = viewOf('codex');

// ---------------------------------------------------------------------------
// The cold read, hoisted into a hook with a budget of its own
// ---------------------------------------------------------------------------
//
// MEMOISING CONCENTRATED THE COST, IT DID NOT REMOVE IT, and the 20-run block
// of 2026-09-07 is what showed the difference. Reading once per worker took the
// three engines from 22.1 s of repeated grafting to 1.13 s — and left ONE cold
// read, paid by whichever test happens to call first. In the second half of
// that block the machine ran at roughly half speed and that single read
// exceeded vitest's 5 s default `testTimeout`, so the run went red at a
// different test each time: `series.test.ts`'s first assertion twice, and once
// `corpus.testkit.test.ts`'s "hands back the SAME array object" — a test whose
// whole body is awaiting an already-memoised promise. A test named for one
// property failing because of another test's start-up cost is not a signal
// anybody can read.
//
// So the read is hoisted into a `beforeAll` that carries an EXPLICIT budget.
// That is not a test-timeout bump: the tests keep the 5 s default and now do
// only their own work, while the hook that does the I/O declares what it needs
// — which is what `CLAUDE.md` says every hook that shells out or reads a corpus
// must do, and what `src/hooks/egress.test.ts` already does with `}, 120_000)`.

/**
 * How long the one cold read of all three corpora may take.
 *
 * SET FROM THE SLOW HALF, NOT FROM AN IDLE MACHINE — a budget set from the
 * faster of two observations is a budget that fails on a normal day, the rule
 * `src/perf/budgets.ts` applies to every other number here. See
 * `PHASE_1C_READ_MEASUREMENTS` for the derivation, which is recorded rather
 * than asserted because the slow half is known by a LOWER BOUND only.
 */
export const CORPUS_READ_BUDGET_MS = 30_000;

/**
 * The measurements this budget rests on, kept beside it.
 *
 * `idleMs` is re-derived on every run by {@link warmCorpus}, which prints it.
 * `slowHalfAtLeastMs` is what the 20-run block established and is deliberately
 * not a point measurement: four runs went red at the 5 s default, so the read
 * exceeded 5,000 ms, and nothing recorded how far it went past. The set point
 * is 3x the conservative reading of that bound, and the printed number is what
 * lets a later reader replace the estimate with data instead of re-guessing.
 */
export const PHASE_1C_READ_MEASUREMENTS = Object.freeze({
  on: '2026-09-08, main project, after the TEMP/dist clean-out',
  /** 362, 358, 381 ms across the three consumer files on a quiet machine. */
  idleMs: 362,
  /**
   * A LOWER BOUND, not a point measurement, and the honest way to say so.
   *
   * Four runs of the 2026-09-07 block went red at vitest's 5 s default while
   * the machine ran at half speed, so the read exceeded 5,000 ms. Nothing
   * recorded how far past — the timeout fires and the measurement is lost,
   * which is the whole reason `warmCorpus` prints.
   */
  slowHalfAtLeastMs: 5_000,
  slowHalfAssumedMs: 10_000,
  budgetMultiple: 3,
  /**
   * THE PART WORTH KEEPING. Idle 362 ms against a slow half above 5,000 ms is
   * a factor of MORE THAN 13, while the suite's wall-clock over the same runs
   * only doubled (22-26 s to 49-52 s). This read is filesystem-bound and it
   * degrades far worse than the work around it, so a budget derived by scaling
   * the idle number by the suite's own slowdown would have been about 800 ms
   * and would have been wrong by an order of magnitude.
   */
  observedDegradationAtLeastX: 13,
});

/**
 * Read all three corpora once, print how long it took, and let the caller's
 * hook budget enforce the ceiling.
 *
 * `Promise.all` because the three views are independent and the point is to
 * pay the cost once, in one place, where it is visible. Since DoD 3.0 they all
 * resolve from ONE underlying read, so this is a single corpus pass plus three
 * clones rather than three passes.
 */
export async function warmCorpus(): Promise<void> {
  const started = performance.now();
  const [cc, oc, codex] = await Promise.all([
    readCcSessions(),
    readOpenCodeSessions(),
    readCodexSessions(),
  ]);
  const ms = performance.now() - started;
  // Printed, not merely measured: a gate record that carries this number can
  // tell a slow machine from a regression, which is exactly the distinction
  // the 20-run block could not make.
  process.stdout.write(
    `[corpus] cold read ${ms.toFixed(0)} ms ` +
      `(cc ${String(cc.length)}, opencode ${String(oc.length)}, codex ${String(codex.length)} sessions; ` +
      `budget ${String(CORPUS_READ_BUDGET_MS)} ms)\n`,
  );
}
