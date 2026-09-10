/**
 * v0.7.0 Phase 1, DoD 1.8b — **NOT MET.** This file is the MEASUREMENT that
 * says why; it is deliberately not a test of a bound that does not exist.
 *
 * ## The cost is real, and it is measured here
 *
 * The H.11 audit (hotfix 0.6.1) found the OpenCode liveness poll running two
 * full `part` scans per pass, neither indexable:
 *
 *     SELECT ... FROM part WHERE json_extract(data,'$.type') = 'tool'
 *     SELECT count(*) FROM part WHERE json_valid(data) = 0
 *
 * Every poll, forever, over every row in the store — the only ingestion cost in
 * the product that grows with the size of the MACHINE rather than with the
 * session being watched.
 *
 * ## Why a bound was written and then REVERTED
 *
 * A per-session watermark over `part_session_idx` (an index OpenCode itself
 * maintains) reached **1.2 ms at 200 k rows against 402.8 ms unbounded**. It was
 * reverted anyway, because it was not correct.
 *
 * `liveness.test.ts`'s A2 mutation table starts a tool by rewriting one part's
 * `data` IN PLACE — no new row, no `event_sequence` move, no `time_updated`
 * bump. Under the bound that tool became invisible and that test went red. It is
 * a pre-existing correctness test naming the exact behaviour, and every way past
 * it was either to weaken it or to buy speed with an unmeasured assumption:
 *
 *   - **session scope alone** depends on OpenCode writing an `event` for every
 *     part write. Never measured here, and a static corpus cannot show it.
 *   - **a `rowid` watermark** catches an INSERT and misses an UPDATE IN PLACE,
 *     which is exactly how `running` becomes `completed`.
 *   - **a `time_updated` watermark** is evidence-backed — OpenCode maintains
 *     that column on **865 of 865** parts in the anchor store and 332 of 334 in
 *     the witness — but it is still a full table scan (no index on it), measured
 *     at **26.5 ms** at 200 k and NOT flat, and it still cannot see a change
 *     that bumps nothing.
 *   - **an index of our own** is a write to the observed engine's database,
 *     which G1 forbids outright.
 *
 * So 1.8b's "indexed predicate or a per-session watermark" cannot be met without
 * weakening a correctness test or accepting a dependency nobody has measured.
 * That is the user's call, and the numbers below are what it should rest on.
 *
 * ## What this file asserts
 *
 * The cost, as a RATIO measured twice in one process. No millisecond budget
 * appears here: this repository has an evidence file about a perf number that
 * moved 100x on process state alone.
 *
 * ## Phase 1c, 2026-09-07 — it MOVED here, and a warm-up poll is discarded
 *
 * This file lived in `src/opencode/` and therefore in the MAIN vitest project,
 * where it failed in 2 of 20 recorded runs. Two changes, and the second is the
 * one that matters:
 *
 *   - **It is in the `perf` project now** (`pool: 'forks'`, `singleFork`).
 *     Wall-clock assertions belong where the host process state is controlled,
 *     which is the same argument `OPENCODE_POLL_BUDGET`'s header makes; that
 *     header's "WHY NOT MEASURED IN `src/opencode/`" section is amended rather
 *     than deleted, because its 48.4 ms figure was taken by this instrument in
 *     the main project and will not re-derive here.
 *   - **The first poll of the process is discarded.** See `beforeAll`. The
 *     failure was never in the large store; it was start-up cost landing on the
 *     small one.
 *
 * ## IF THE RATIO STILL FLAKES, REPLACE IT — user ruling, 2026-09-07
 *
 * The fallback is decided in advance so nobody has to decide it in a red run:
 * **drop the two ratio assertions and put two ABSOLUTE steady-state bounds in
 * their place**, one per store, generous enough to be about the shape and not
 * about the machine. Note what that costs, since the ratio was chosen for a
 * reason recorded above — an absolute bound reintroduces exactly the
 * millisecond number this file's header refuses, and it must therefore live in
 * the `perf` project (it now does) and carry its measured set point, its date
 * and its margin the way `src/perf/budgets.ts` requires of every other number.
 * The tripwire property is preserved either way: both forms go red the day
 * somebody bounds the scan, which is the only thing this file exists to defend.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hrtime } from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OcLivenessEngine } from '../opencode/liveness.js';

/** An order of magnitude apart — the DoD's 20 k / 200 k. */
const SMALL_ROWS = 20_000;
const LARGE_ROWS = 200_000;

let scratch: string;

/**
 * A store with `rows` `part` rows across a handful of sessions.
 *
 * The schema is OpenCode's own, INCLUDING `part_session_idx` — recreated rather
 * than assumed, because any future bound would depend on it and we may not
 * create one ourselves (G1).
 */
function buildStore(name: string, rows: number): string {
  const dbPath = path.join(scratch, `${name}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = delete');
  db.exec(`
    CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, vcs text);
    CREATE TABLE session (
      id text PRIMARY KEY, project_id text NOT NULL, parent_id text,
      slug text, directory text, title text NOT NULL, version text NOT NULL,
      agent text, model text, cost real NOT NULL DEFAULT 0,
      tokens_input integer NOT NULL DEFAULT 0, tokens_output integer NOT NULL DEFAULT 0,
      tokens_cache_read integer NOT NULL DEFAULT 0, tokens_cache_write integer NOT NULL DEFAULT 0,
      time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer
    );
    CREATE TABLE message (
      id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
    );
    CREATE INDEX part_session_idx ON part (session_id);
    CREATE TABLE event (
      id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL,
      type text NOT NULL, data text
    );
    CREATE TABLE event_sequence (
      aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text
    );
  `);

  const SESSIONS = 8;
  db.exec('BEGIN');
  db.prepare('INSERT INTO project VALUES (?,?,?)').run('prj', 'C:\\repo', 'git');
  const session = db.prepare(
    'INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,agent,model,' +
      'cost,tokens_input,tokens_output,tokens_cache_read,tokens_cache_write,' +
      'time_created,time_updated,time_archived) VALUES (?,?,NULL,?,?,?,?,?,?,0,0,0,0,0,?,?,NULL)',
  );
  const message = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)');
  const sequence = db.prepare('INSERT INTO event_sequence VALUES (?,?,?)');

  for (let s = 0; s < SESSIONS; s += 1) {
    const id = `ses_${String(s)}`;
    session.run(id, 'prj', `slug-${String(s)}`, 'C:\\repo', 't', '1.18.22', 'build', 'gpt', 1, 2);
    message.run(`msg_${String(s)}`, id, 1, 2, JSON.stringify({ role: 'assistant' }));
    sequence.run(id, 1, 'owner');
  }
  for (let i = 0; i < rows; i += 1) {
    const s = i % SESSIONS;
    part.run(
      `prt_${String(i)}`,
      `msg_${String(s)}`,
      `ses_${String(s)}`,
      1,
      2,
      // Every row is a completed `tool` part, so the `json_extract` predicate
      // MATCHES all of them — the worst case, and the honest one to measure.
      JSON.stringify({
        type: 'tool',
        callID: `call_${String(i)}`,
        tool: 'bash',
        state: { status: 'completed', input: { command: 'x' }, time: { start: 1, end: 2 } },
      }),
    );
  }
  db.exec('COMMIT');
  db.close();
  return dbPath;
}

function engineOver(dbPath: string): OcLivenessEngine {
  let clock = 1_000;
  return new OcLivenessEngine({ dbPath, now: () => (clock += 1_000) });
}

function timePoll(engine: OcLivenessEngine): number {
  const started = hrtime.bigint();
  engine.poll();
  return Number(hrtime.bigint() - started) / 1e6;
}

/** Median of several polls, so one hiccup cannot decide it. */
function medianPollMs(engine: OcLivenessEngine, samples = 7): number {
  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) times.push(timePoll(engine));
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] ?? 0;
}

interface Measured {
  firstPassMs: number;
  steadyMs: number;
  scannedFirstPass: number;
}

function measure(dbPath: string): Measured {
  const engine = engineOver(dbPath);
  const firstPassMs = timePoll(engine);
  const scannedFirstPass = engine.counters().toolPartsScanned;
  return { firstPassMs, steadyMs: medianPollMs(engine), scannedFirstPass };
}

let small: Measured;
let large: Measured;

/**
 * Rows for the store whose measurement is THROWN AWAY.
 *
 * Small enough to cost nothing, large enough that the poll does real work:
 * loads `node:sqlite`, compiles both statements, warms the JIT on the row
 * decoder and puts SQLite's page cache in a steady state.
 */
const WARMUP_ROWS = 2_000;

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'agent-deck-partscan-'));

  // THE FIRST POLL OF THE PROCESS IS DISCARDED, AND THIS IS THE WHOLE FIX.
  //
  // Without it, `small` was whatever the first measurement in a cold process
  // costs — module load, JIT, cold page cache — and the ratio below compares
  // the two stores as if only the row count differed. Measured across the
  // Phase 1c blocks: the assertion failed as `expected 1174.5 to be greater
  // than 1851.7`, i.e. `large` at 1174 ms against `small × 3` at 1851, so
  // `small` had been measured at 617 ms — MORE than half of a store ten times
  // its size. The large store was never the problem; the small one was
  // carrying the process's start-up cost and nothing said so.
  //
  // Discarded rather than subtracted: a warm-up whose number is kept is a
  // number somebody eventually treats as a measurement.
  measure(buildStore('warmup', WARMUP_ROWS));

  small = measure(buildStore('small', SMALL_ROWS));
  large = measure(buildStore('large', LARGE_ROWS));
}, 300_000);

afterAll(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

describe('DoD 1.8b — the part scan is UNBOUNDED, measured on 20 k and 200 k rows', () => {
  it('reports the measurement, so the decision rests on numbers', () => {
    console.log(
      `part scan (UNBOUNDED): 20k first=${small.firstPassMs.toFixed(1)}ms ` +
        `steady=${small.steadyMs.toFixed(1)}ms | 200k first=${large.firstPassMs.toFixed(1)}ms ` +
        `steady=${large.steadyMs.toFixed(1)}ms`,
    );
    expect(large.firstPassMs).toBeGreaterThan(0);
  });

  it('CONTROL: every row of both stores really is read', () => {
    // Without this, "the cost grows with the store" is satisfied by a store
    // that was never populated — this repository's most-recorded defect.
    expect(small.scannedFirstPass).toBe(SMALL_ROWS);
    expect(large.scannedFirstPass).toBe(LARGE_ROWS);
  });

  it('costs several times more on 10x the rows — the shape of the defect', () => {
    // Loose on purpose: the point is the TREND, and a tight bound on a shared
    // runner is a coin toss.
    expect(large.firstPassMs).toBeGreaterThan(small.firstPassMs * 3);
  });

  it('pays that cost on EVERY poll, not only the first', () => {
    /*
     * The steady state is the first pass repeated, and that is the defect
     * stated as an assertion.
     *
     * IT IS A TRIPWIRE, NOT AN ENDORSEMENT. Whoever bounds this scan should
     * delete this test and put the flatness assertion in its place — it is
     * written to go red the moment the cost stops being paid, so a bound cannot
     * land without someone reading this file's header first.
     */
    expect(large.steadyMs).toBeGreaterThan(small.steadyMs * 3);
  });

  it('re-reads every row even when nothing in the store has changed', () => {
    // The counter, not the clock: two polls read twice the rows.
    const engine = engineOver(path.join(scratch, 'small.db'));
    engine.poll();
    const afterOne = engine.counters().toolPartsScanned;
    engine.poll();
    expect(engine.counters().toolPartsScanned).toBe(afterOne * 2);
  }, 60_000);
});
