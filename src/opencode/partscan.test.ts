/**
 * v0.7.0 Phase 1, DoD 1.8b — the OpenCode `part` scan is BOUNDED.
 *
 * ## What was wrong
 *
 * The H.11 audit (hotfix 0.6.1) found the liveness poll running two full `part`
 * scans per pass, neither of them indexable:
 *
 *     SELECT ... FROM part WHERE json_extract(data,'$.type') = 'tool'
 *     SELECT count(*) FROM part WHERE json_valid(data) = 0
 *
 * Every poll, forever, over every row in the store. It was **the only
 * ingestion cost in the product that grew with the size of the MACHINE rather
 * than with the session being watched** — a developer with two years of
 * OpenCode history paid for all of it every five seconds to learn nothing.
 *
 * ## The red arm is inside this file, and it is the real code
 *
 * A test that reverts a fix to prove it works measures a build nobody ships.
 * It is not needed here: the FIRST pass has no cache and deliberately scans
 * everything, so **the unbounded query is still exercised, by the production
 * code, in the same process, on the same store**. The first pass is the red arm
 * and the steady state is the green one, and the assertion is the ratio between
 * them on the SAME database.
 *
 * That also makes the control impossible to fake. If the bound were removed,
 * the steady-state passes would cost what the first one does and the ratio
 * would collapse to 1.
 *
 * ## Why the numbers are ratios rather than milliseconds
 *
 * A wall-clock budget on a shared runner is a coin toss — this repository has
 * a whole evidence file about a perf number that moved 100x on process state
 * alone. Every assertion below compares two measurements taken in the same
 * process, seconds apart, so a slow machine slows both.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hrtime } from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OcLivenessEngine } from './liveness.js';

/** Small and large, an order of magnitude apart — the DoD's 20 k / 200 k. */
const SMALL_ROWS = 20_000;
const LARGE_ROWS = 200_000;

let scratch: string;

/**
 * A store with `rows` `part` rows across a handful of sessions.
 *
 * The schema is OpenCode's own, INCLUDING `part_session_idx` — the index the
 * bound relies on. Recreating it here rather than assuming it is what makes
 * this test a check on the query plan rather than on our own cache: without
 * that index the `IN (...)` would still be a full scan and the ratio would
 * narrow.
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
      // Every row is a completed `tool` part, so the json_extract predicate
      // MATCHES on all of them — the worst case for the unbounded scan, and
      // the honest one to measure.
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
  return new OcLivenessEngine({
    dbPath,
    // Injected and monotonic; no wall clock reaches this test.
    now: () => (clock += 1_000),
  });
}

/** Milliseconds for one `poll()`. */
function timePoll(engine: OcLivenessEngine): number {
  const started = hrtime.bigint();
  engine.poll();
  return Number(hrtime.bigint() - started) / 1e6;
}

/** The median of several steady-state polls, so one hiccup cannot decide it. */
function steadyStateMs(engine: OcLivenessEngine, samples = 7): number {
  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) times.push(timePoll(engine));
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] ?? 0;
}

interface Measured {
  firstPassMs: number;
  steadyMs: number;
  skipped: number;
  scannedFirstPass: number;
}

function measure(dbPath: string): Measured {
  const engine = engineOver(dbPath);
  const firstPassMs = timePoll(engine);
  const scannedFirstPass = engine.counters().toolPartsScanned;
  const steadyMs = steadyStateMs(engine);
  return {
    firstPassMs,
    steadyMs,
    skipped: engine.counters().partScansSkipped,
    scannedFirstPass,
  };
}

let small: Measured;
let large: Measured;

/*
 * FILE-LEVEL, not inside the first `describe`. They were there first, and the
 * `afterAll` deleted the scratch directory before the correctness suite below
 * ever ran — every one of its stores failed to open with `SQLITE_CANTOPEN`.
 * A teardown scoped more narrowly than the fixture it owns.
 */
beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'agent-deck-partscan-'));
  small = measure(buildStore('small', SMALL_ROWS));
  large = measure(buildStore('large', LARGE_ROWS));
}, 300_000);

afterAll(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

describe('DoD 1.8b — the part scan is bounded, measured on 20 k and 200 k rows', () => {
  it('reports the measurement, so the handoff quotes numbers rather than a verdict', () => {
    console.log(
      `part-scan bound: 20k first=${small.firstPassMs.toFixed(1)}ms steady=${small.steadyMs.toFixed(3)}ms | ` +
        `200k first=${large.firstPassMs.toFixed(1)}ms steady=${large.steadyMs.toFixed(3)}ms | ` +
        `skipped 20k=${String(small.skipped)} 200k=${String(large.skipped)}`,
    );
    expect(large.firstPassMs).toBeGreaterThan(0);
  });

  it('CONTROL: the first pass really does read every row of both stores', () => {
    // Without this the "flat" claim below is satisfied by a store that was
    // never populated, which is this repository's most-recorded defect.
    expect(small.scannedFirstPass).toBe(SMALL_ROWS);
    expect(large.scannedFirstPass).toBe(LARGE_ROWS);
  });

  it('RED ARM: the unbounded first pass costs ~10x more on 10x the rows', () => {
    /*
     * This is the behaviour that used to happen on EVERY poll. Ten times the
     * rows for ten times the cost is the shape of the defect, and it is
     * measured here rather than asserted from the code.
     *
     * The bound is deliberately loose — 3x on a 10x input — because the point
     * is the trend, and a tight bound on a shared runner is a coin toss.
     */
    expect(large.firstPassMs).toBeGreaterThan(small.firstPassMs * 3);
  });

  it('GREEN ARM: the steady state does NOT grow with the store', () => {
    /*
     * The same engine, seconds later, over the same 200 k rows. Nothing
     * changed in any session and nothing is running, so no part row is read at
     * all.
     *
     * Asserted as a RATIO against the small store's steady state rather than
     * as a millisecond budget: both are measured in this process, so a slow
     * machine slows both. 3x leaves room for scheduler noise on figures this
     * small while still failing outright if the scan came back — which would
     * be a 10x difference, not a 3x one.
     */
    expect(large.steadyMs).toBeLessThan(Math.max(small.steadyMs, 0.5) * 3);
  });

  it('GREEN ARM: the steady state is far cheaper than the first pass', () => {
    // The direct statement of the fix on ONE store, so the comparison does not
    // depend on the two stores having been built alike.
    expect(large.steadyMs).toBeLessThan(large.firstPassMs / 3);
  });

  it('reads NO part row at all once nothing is changing', () => {
    // The counter, not the clock. A timing assertion can pass on a fast
    // machine for the wrong reason; this cannot.
    expect(large.skipped).toBeGreaterThan(0);
    expect(small.skipped).toBeGreaterThan(0);
  });
});

describe('the bound does not cost correctness', () => {
  it('still finds a running tool, and still clears it when it completes', () => {
    const dbPath = path.join(scratch, 'correctness.db');
    buildStoreAt(dbPath);

    const engine = engineOver(dbPath);
    engine.poll();
    expect(runningIds(engine)).toStrictEqual(['call_live']);

    // Complete it WITHOUT touching `event_sequence`, which is the case the
    // cache could plausibly get wrong: a session holding a running tool is
    // re-read every pass precisely so a completion is never missed, even if
    // OpenCode wrote no event for it.
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE part SET data = ? WHERE id = ?').run(
      JSON.stringify({
        type: 'tool',
        callID: 'call_live',
        tool: 'bash',
        state: { status: 'completed', time: { start: 1, end: 9 } },
      }),
      'prt_live',
    );
    db.close();

    engine.poll();
    expect(runningIds(engine), 'a completion must clear the cache').toStrictEqual([]);
  }, 60_000);

  it('picks up a NEW running tool in a session that gained an event', () => {
    const dbPath = path.join(scratch, 'newtool.db');
    buildStoreAt(dbPath, { running: false });

    const engine = engineOver(dbPath);
    engine.poll();
    expect(runningIds(engine)).toStrictEqual([]);

    const db = new DatabaseSync(dbPath);
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(
      'prt_new',
      'msg_0',
      'ses_0',
      3,
      3,
      JSON.stringify({
        type: 'tool',
        callID: 'call_new',
        tool: 'bash',
        state: { status: 'running', input: {} },
      }),
    );
    // The session's sequence advances, which is what marks it dirty.
    db.prepare('UPDATE event_sequence SET seq = seq + 1 WHERE aggregate_id = ?').run('ses_0');
    db.close();

    engine.poll();
    expect(runningIds(engine)).toStrictEqual(['call_new']);
  }, 60_000);
});

function runningIds(engine: OcLivenessEngine): string[] {
  // One session in these two stores, named so the assertion cannot pass by
  // looking at the wrong one.
  const snapshot = engine.snapshot('ses_0');
  return [...(snapshot?.runningTools ?? [])].map((tool) => tool.callId).sort();
}

/** A tiny store with one optionally-running tool. */
function buildStoreAt(dbPath: string, options: { running?: boolean } = {}): void {
  const running = options.running ?? true;
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
  db.prepare('INSERT INTO project VALUES (?,?,?)').run('prj', 'C:\\repo', 'git');
  db.prepare(
    'INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,agent,model,' +
      'cost,tokens_input,tokens_output,tokens_cache_read,tokens_cache_write,' +
      'time_created,time_updated,time_archived) VALUES (?,?,NULL,?,?,?,?,?,?,0,0,0,0,0,?,?,NULL)',
  ).run('ses_0', 'prj', 'slug-0', 'C:\\repo', 't', '1.18.22', 'build', 'gpt', 1, 2);
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(
    'msg_0',
    'ses_0',
    1,
    2,
    JSON.stringify({ role: 'assistant' }),
  );
  db.prepare('INSERT INTO event_sequence VALUES (?,?,?)').run('ses_0', 1, 'owner');
  if (running) {
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(
      'prt_live',
      'msg_0',
      'ses_0',
      1,
      2,
      JSON.stringify({
        type: 'tool',
        callID: 'call_live',
        tool: 'bash',
        state: { status: 'running', input: {} },
      }),
    );
  }
  db.close();
}
