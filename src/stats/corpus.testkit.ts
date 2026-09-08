/**
 * Every committed session of every engine, read THROUGH THE PRODUCTION PATH —
 * v0.7.0 Phase 1.
 *
 * Test-only. Named `.testkit.ts` rather than `.test.ts` deliberately: vitest
 * collects `src/**\/*.test.ts`, so this file is a helper and never a suite of
 * its own. `webview/testkit.ts` sets the precedent, and the privacy sweep's
 * `tests-and-testdata` rule recognises the suffix.
 *
 * ## Why the sweep is over DIRECTORIES rather than over a list
 *
 * A hard-coded corpus list goes stale on the next harvest and reads as a
 * regression — the recorded rule against asserting fixture-set sizes. Every
 * reader below discovers its corpora from disk, so a new capture is picked up
 * with no edit here.
 *
 * The cost is that a discovery bug makes every caller iterate nothing and pass.
 * That is this repository's most-recorded defect class, so each reader THROWS
 * when it finds no corpus rather than returning an empty array, and the callers
 * additionally assert a non-empty population.
 *
 * ## Production path, not a shortcut
 *
 * `graftSession`, `readOpenCodeEngine` and `readCodexEngine` are the same
 * entry points the extension host calls. Nothing here re-implements a parse: a
 * field asserted on these states is a field the product really produces, which
 * is the whole difference between DoD 1.4/1.5 and a component test.
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
 * read instead of racing two.
 *
 * ## Why the result is DEEP-FROZEN, and it is not belt-and-braces
 *
 * A shared array is a correctness hazard the moment any test mutates what it
 * gets back: the next test in the file would silently receive the damage, and
 * the failure would surface somewhere else entirely. Freezing makes that
 * impossible rather than unlikely — ESM is strict mode, so an assignment to a
 * frozen property THROWS, naming the file and line.
 *
 * A test that genuinely needs to mutate takes a `structuredClone` first and
 * says why. The audit that accompanied this change found none that did.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SessionState } from '../model/events.js';
import { graftSession } from '../model/graft.js';
import { readCodexEngine } from '../codex/index.js';
import { readOpenCodeEngine } from '../opencode/index.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));

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
 * Run `read` at most once, and hand every caller the same frozen result.
 *
 * The PROMISE is cached rather than the value, so a second caller arriving
 * while the first read is still in flight waits for it instead of starting a
 * second one. Per worker, because vitest gives each worker its own module
 * registry — there is no cross-worker sharing to reason about.
 */
function once(read: () => Promise<SessionState[]>): () => Promise<SessionState[]> {
  let pending: Promise<SessionState[]> | null = null;
  return () => {
    pending ??= read().then((states) => deepFreeze(states));
    return pending;
  };
}

function corpusDirs(prefix: string, marker: (dir: string) => boolean): string[] {
  const named = fs
    .readdirSync(FIXTURES)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(FIXTURES, name))
    .filter((dir) => fs.statSync(dir).isDirectory())
    .sort();
  const dirs = named.filter(marker).sort();
  if (dirs.length === 0) throw new Error(`no ${prefix}* corpus found under ${FIXTURES}`);
  /*
   * THE GLOBAL GUARD WAS THE WRONG STRENGTH, and `phase-verifier` said so: a
   * discovery bug that found 1 of 6 corpora satisfied "more than zero" and
   * every sweep test then passed over a sixth of the data.
   *
   * So the shortfall is reported rather than tolerated. `marker` legitimately
   * excludes directories — a Codex witness corpus carries no golden — so this
   * is not an equality check; it is a floor that goes red if the marker starts
   * rejecting nearly everything, which is what a broken predicate looks like.
   */
  if (dirs.length * 2 < named.length) {
    throw new Error(
      `${prefix}*: only ${String(dirs.length)} of ${String(named.length)} corpora matched the ` +
        'marker — that is a discovery bug, not a corpus without one',
    );
  }
  return dirs;
}

/** Every `.jsonl` directly under a corpus's slug directory — the MAIN transcripts. */
function mainTranscripts(corpusDir: string): string[] {
  const projects = path.join(corpusDir, 'projects');
  if (!fs.existsSync(projects)) return [];
  const out: string[] = [];
  for (const slug of fs.readdirSync(projects)) {
    const slugDir = path.join(projects, slug);
    if (!fs.statSync(slugDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(slugDir)) {
      // Subagent transcripts live one level down, under `<sessionId>/subagents/`,
      // and are grafted in by `graftSession` rather than read as sessions.
      if (entry.endsWith('.jsonl')) out.push(path.join(slugDir, entry));
    }
  }
  return out.sort();
}

/**
 * Every Claude Code session of every `fixtures/cc-*` corpus.
 *
 * A session the fingerprint REFUSES is skipped rather than thrown on: a corpus
 * may legitimately hold a refusal fixture, and this helper's job is to supply
 * the sessions that render, not to re-assert the version window.
 */
async function readCcSessionsFresh(): Promise<SessionState[]> {
  const states: SessionState[] = [];
  for (const dir of corpusDirs('cc-', (d) => fs.existsSync(path.join(d, 'projects')))) {
    for (const transcript of mainTranscripts(dir)) {
      const result = await graftSession(transcript);
      if (!result.ok) continue;
      states.push(result.snapshot as unknown as SessionState);
    }
  }
  if (states.length === 0) throw new Error('no CC session grafted from any cc-* corpus');
  return states;
}

/** Every OpenCode session of every committed store. */
async function readOpenCodeSessionsFresh(): Promise<SessionState[]> {
  const states: SessionState[] = [];
  for (const dir of corpusDirs('opencode-', () => true)) {
    // `opencode-1.18.25` keeps its store a level down, in `moved-project/`. A
    // root-only test silently skipped it once already (Phase 0 records the
    // fail-open), so the store is searched for rather than assumed.
    for (const dbPath of findStores(dir)) {
      const outcome = readOpenCodeEngine({ dbPath, immutable: true });
      if (outcome.kind !== 'ok') continue;
      states.push(...outcome.result.sessions);
    }
  }
  if (states.length === 0) throw new Error('no OpenCode session read from any opencode-* corpus');
  return await Promise.resolve(states);
}

function findStores(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current)) {
      const full = path.join(current, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (entry === 'opencode.db') out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** Every Codex thread of every committed run, as `SessionState`s. */
async function readCodexSessionsFresh(): Promise<SessionState[]> {
  const states: SessionState[] = [];
  // Selected by the presence of a golden, which is what separates an ANCHOR
  // corpus from a witness — never by sort order, which a differently named
  // corpus would break silently.
  for (const dir of corpusDirs('codex-', (d) => fs.existsSync(path.join(d, 'golden.json')))) {
    for (const run of fs.readdirSync(dir)) {
      const root = path.join(dir, run, 'home', '.codex');
      if (!fs.existsSync(root)) continue;
      const outcome = await readCodexEngine({ root });
      if (outcome.kind !== 'ok') continue;
      states.push(...outcome.result.sessions);
    }
  }
  if (states.length === 0) throw new Error('no Codex session read from any codex-* corpus');
  return states;
}

// ---------------------------------------------------------------------------
// The exported readers
// ---------------------------------------------------------------------------
//
// One read per engine per worker, deep-frozen. The `*Fresh` functions above are
// deliberately NOT exported: an unmemoised reader within reach is an invitation
// to reintroduce the cost this wrapper exists to remove, and a caller that got
// an unfrozen copy from one and a frozen one from the other would be debugging
// the difference rather than the product.

/** Every Claude Code session of every `fixtures/cc-*` corpus. Frozen. */
export const readCcSessions = once(readCcSessionsFresh);

/** Every OpenCode session of every committed store. Frozen. */
export const readOpenCodeSessions = once(readOpenCodeSessionsFresh);

/** Every Codex thread of every committed run, as `SessionState`s. Frozen. */
export const readCodexSessions = once(readCodexSessionsFresh);

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
  on: '2026-09-08, main project, 3198 tests, after the TEMP/dist clean-out',
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
 * `Promise.all` because the three engines are independent and the point is to
 * pay the cost once, in one place, where it is visible.
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
