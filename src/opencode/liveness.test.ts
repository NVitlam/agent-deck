/**
 * `src/opencode/liveness.ts` — DoD 4.5, proven the way `PLAN.md` Phase 4
 * Amendment A2 requires.
 *
 * ---------------------------------------------------------------------------
 * THE RULES THIS FILE IS WRITTEN UNDER
 * ---------------------------------------------------------------------------
 * A2: "Liveness is proven with an injected clock and mutated fixtures, **never
 * with a live database**. A liveness test that reads a live DB measures the
 * machine it ran on."
 *
 * So: every clock in here is a `let` a test moves by hand, every database is a
 * `synthetic-` copy made per test in a `mkdtemp` directory from a committed
 * fixture, and nothing in this file opens
 * `%USERPROFILE%\.local\share\opencode` or writes inside `fixtures/`
 * (`withWritableDb` refuses that outright).
 *
 * **Every assertion has a control.** A liveness test can pass for the wrong
 * reason more easily than most: assert `live` at a clock where every session is
 * already `live` and the mutation proved nothing. So the `live` case asserts
 * `idle` first at a baseline clock, the `ended` case asserts `live` first at
 * the same clock, and the running-tool case asserts `done` first. The baseline
 * clock is derived from the fixture's own `time_updated` values at test time,
 * never written as a literal.
 *
 * **No fixture-set size is asserted.** Session counts, event counts and part
 * counts are all read off the copy inside the test, per the recorded rule.
 *
 * The witness corpus `opencode-1.18.21` (5.7 MB) is used rather than the
 * 19 MB anchor: nothing here depends on which corpus it is, and copying the
 * smaller one per test is the difference between a fast file and a slow one.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_OC_LIVENESS_THRESHOLD_MS,
  DEFAULT_OC_POLL_INTERVAL_MS,
  EVENT_TYPE_FORM,
  MEASURED_EVENT_TYPES,
  OcLivenessEngine,
  createWalWatchFactory,
  resolveWatchPath,
  walPathFor,
} from './liveness.js';
import type {
  OcSessionLiveness,
  PollTrigger,
  WalWatchCallbacks,
  WalWatchFactory,
} from './liveness.js';
import { copyCorpus, corpusDbPath, makeTempDir, withWritableDb } from './synthetic.js';

const CORPUS = 'opencode-1.18.21';

const MODULE_PATH = fileURLToPath(new URL('./liveness.ts', import.meta.url));
const PACKAGE_JSON_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));

// ---------------------------------------------------------------------------
// Row helpers — `all()` hands back `Record<string, SQLOutputValue>`
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

function readOnly<T>(dbPath: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

interface SessionFixtureRow {
  id: string;
  timeUpdated: number;
}

function readSessions(dbPath: string): SessionFixtureRow[] {
  return readOnly(dbPath, (db) =>
    (db.prepare('SELECT id, time_updated FROM session ORDER BY id').all() as Row[]).map(
      (row) => ({ id: str(row['id']), timeUpdated: num(row['time_updated']) }),
    ),
  );
}

function readCursors(dbPath: string): { aggregateId: string; seq: number }[] {
  return readOnly(dbPath, (db) =>
    (
      db
        .prepare('SELECT aggregate_id, seq FROM event_sequence ORDER BY aggregate_id')
        .all() as Row[]
    ).map((row) => ({ aggregateId: str(row['aggregate_id']), seq: num(row['seq']) })),
  );
}

function countEventsFor(dbPath: string, sessionId: string): number {
  return readOnly(dbPath, (db) =>
    num(
      (db.prepare('SELECT count(*) AS n FROM event WHERE aggregate_id = ?').get(sessionId) as
        | Row
        | undefined)?.['n'],
    ),
  );
}

// ---------------------------------------------------------------------------
// Mutations. Each one is named, small, and visible at the call site.
// ---------------------------------------------------------------------------

function setSeq(dbPath: string, sessionId: string, seq: number): void {
  withWritableDb(dbPath, (db) => {
    db.prepare('UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?').run(seq, sessionId);
  });
}

function setArchived(dbPath: string, sessionId: string, at: number): void {
  withWritableDb(dbPath, (db) => {
    db.prepare('UPDATE session SET time_archived = ? WHERE id = ?').run(at, sessionId);
  });
}

function insertEvent(dbPath: string, sessionId: string, seq: number, type: string): void {
  withWritableDb(dbPath, (db) => {
    db.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)').run(
      `evt_synthetic_${seq}_${type}`,
      sessionId,
      seq,
      type,
      '{}',
    );
    db.prepare('UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?').run(seq, sessionId);
  });
}

interface MutatedToolPart {
  partId: string;
  sessionId: string;
  callId: string;
}

/**
 * Turn the lowest-id `tool` part into an in-flight one.
 *
 * `keepEnd` exists because DoD 4.5's rule is a CONJUNCTION — "running tool part
 * with no `state.time.end`" — and the disagreement arm needs its own fixture.
 * Neither shape occurs in either committed corpus (`GOLDEN.md` § *Measured
 * gaps*: 0 running tool parts, 0 parts missing `state.time.end`), which is
 * exactly why it is mutated here.
 */
function makeToolRunning(dbPath: string, keepEnd = false): MutatedToolPart {
  return withWritableDb(dbPath, (db) => {
    const rows = db.prepare('SELECT id, session_id, data FROM part ORDER BY id').all() as Row[];
    for (const row of rows) {
      let data: unknown;
      try {
        data = JSON.parse(str(row['data']));
      } catch {
        continue;
      }
      const part = data as { type?: string; callID?: string; state?: Record<string, unknown> };
      if (part.type !== 'tool' || part.state === undefined) continue;
      part.state['status'] = 'running';
      if (!keepEnd) {
        const time = part.state['time'];
        if (time !== null && typeof time === 'object') {
          delete (time as Record<string, unknown>)['end'];
        }
      }
      db.prepare('UPDATE part SET data = ? WHERE id = ?').run(
        JSON.stringify(part),
        str(row['id']),
      );
      return {
        partId: str(row['id']),
        sessionId: str(row['session_id']),
        callId: typeof part.callID === 'string' ? part.callID : '',
      };
    }
    throw new Error('the corpus carries no tool part to mutate');
  });
}

function dropPartTable(dbPath: string): void {
  withWritableDb(dbPath, (db) => {
    db.exec('DROP TABLE part');
  });
}

// ---------------------------------------------------------------------------
// Injection stubs
// ---------------------------------------------------------------------------

function manualTrigger(): {
  trigger: PollTrigger;
  registrations: { intervalMs: number }[];
  fire: () => void;
  stops: () => number;
} {
  const runs: (() => void)[] = [];
  const registrations: { intervalMs: number }[] = [];
  let stops = 0;
  const trigger: PollTrigger = (run, intervalMs) => {
    runs.push(run);
    registrations.push({ intervalMs });
    return {
      stop: () => {
        stops += 1;
      },
    };
  };
  return {
    trigger,
    registrations,
    fire: () => {
      for (const run of runs) run();
    },
    stops: () => stops,
  };
}

function manualWalWatch(): {
  factory: WalWatchFactory;
  paths: string[];
  wake: () => void;
  raise: (error: unknown) => void;
  closes: () => number;
} {
  const callbacks: WalWatchCallbacks[] = [];
  const paths: string[] = [];
  let closes = 0;
  const factory: WalWatchFactory = (walPath, cb) => {
    paths.push(walPath);
    callbacks.push(cb);
    return {
      close: () => {
        closes += 1;
      },
    };
  };
  return {
    factory,
    paths,
    wake: () => {
      for (const cb of callbacks) cb.onWake();
    },
    raise: (error) => {
      for (const cb of callbacks) cb.onError(error);
    },
    closes: () => closes,
  };
}

// ---------------------------------------------------------------------------
// Per-test scratch
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

function freshCopy(): { dir: string; dbPath: string } {
  const dir = makeTempDir('agent-deck-oc-liveness-');
  scratchDirs.push(dir);
  return { dir, dbPath: copyCorpus(CORPUS, dir) };
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir === undefined) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Facts read off the committed corpus once, so no literal is written here. */
let maxTimeUpdated = 0;
/** The session carrying the highest `event_sequence.seq` — the busiest one. */
let busiestSessionId = '';
/** The session with the most recently updated row. */
let freshestSessionId = '';
let freshestTimeUpdated = 0;

beforeAll(() => {
  const fixture = corpusDbPath(CORPUS);
  const sessions = readSessions(fixture);
  expect(sessions.length).toBeGreaterThan(1);
  for (const session of sessions) {
    if (session.timeUpdated > maxTimeUpdated) {
      maxTimeUpdated = session.timeUpdated;
      freshestSessionId = session.id;
      freshestTimeUpdated = session.timeUpdated;
    }
  }
  const cursors = readCursors(fixture);
  let best = -1;
  for (const cursor of cursors) {
    if (cursor.seq > best) {
      best = cursor.seq;
      busiestSessionId = cursor.aggregateId;
    }
  }
  expect(busiestSessionId).not.toBe('');
  expect(freshestSessionId).not.toBe('');
});

/** A clock at which EVERY session in the corpus is already stale. */
function baselineClock(): number {
  return maxTimeUpdated + DEFAULT_OC_LIVENESS_THRESHOLD_MS + 1;
}

function snapshotOrFail(engine: OcLivenessEngine, sessionId: string): OcSessionLiveness {
  const snapshot = engine.snapshot(sessionId);
  if (snapshot === undefined) throw new Error(`no snapshot for ${sessionId}`);
  return snapshot;
}

// ===========================================================================
// A2's six named cases
// ===========================================================================

describe('OcLivenessEngine — the A2 mutation table', () => {
  it('reads live when event_sequence.seq advances and the clock is inside agentDeck.livenessThresholdMs', () => {
    const { dbPath } = freshCopy();
    let clock = baselineClock();
    const engine = new OcLivenessEngine({ dbPath, now: () => clock });

    engine.poll();
    // Control: at the baseline clock every session is stale, so the `live`
    // below cannot be inherited from the fixture's own timestamps.
    const before = snapshotOrFail(engine, busiestSessionId);
    expect(before.liveness).toBe('idle');
    expect(before.cursorSeeded).toBe(true);
    const seededSeq = before.seq ?? -1;
    expect(seededSeq).toBeGreaterThan(0);

    setSeq(dbPath, busiestSessionId, seededSeq + 3);
    clock = baselineClock() + 1000;
    engine.poll();

    const after = snapshotOrFail(engine, busiestSessionId);
    expect(after.liveness).toBe('live');
    expect(after.seq).toBe(seededSeq + 3);
    expect(after.seqAdvancedAt).toBe(clock);
    expect(after.cursorSeeded).toBe(false);
    expect(engine.counters().seqAdvances).toBe(1);
    expect(engine.health().ok).toBe(true);
    engine.dispose();
  });

  it('reads idle when the clock advances past agentDeck.livenessThresholdMs with no new seq', () => {
    const { dbPath } = freshCopy();
    let clock = freshestTimeUpdated;
    const engine = new OcLivenessEngine({ dbPath, now: () => clock });

    engine.poll();
    // Control: at the row's own `time_updated` this session IS live, so the
    // `idle` below is the clock moving and not a session that was never live.
    expect(snapshotOrFail(engine, freshestSessionId).liveness).toBe('live');

    clock = freshestTimeUpdated + DEFAULT_OC_LIVENESS_THRESHOLD_MS + 1;
    engine.poll();

    const after = snapshotOrFail(engine, freshestSessionId);
    expect(after.liveness).toBe('idle');
    expect(after.recent).toBe(false);
    expect(after.ageMs).toBe(DEFAULT_OC_LIVENESS_THRESHOLD_MS + 1);
    expect(engine.counters().seqAdvances).toBe(0);
    engine.dispose();
  });

  it('reads ended when session.time_archived is set, even with a cursor that just advanced', () => {
    const { dbPath } = freshCopy();
    let clock = baselineClock();
    const engine = new OcLivenessEngine({ dbPath, now: () => clock });

    engine.poll();
    const seededSeq = snapshotOrFail(engine, busiestSessionId).seq ?? -1;
    setSeq(dbPath, busiestSessionId, seededSeq + 1);
    clock = baselineClock() + 1000;
    engine.poll();
    // Control: without `time_archived` this exact state reads `live`.
    expect(snapshotOrFail(engine, busiestSessionId).liveness).toBe('live');

    setArchived(dbPath, busiestSessionId, clock);
    engine.poll();

    const after = snapshotOrFail(engine, busiestSessionId);
    expect(after.liveness).toBe('ended');
    expect(after.timeArchived).toBe(clock);
    expect(after.recent).toBe(true);
    engine.dispose();
  });

  it('reads toolStatus running for a tool part with no state.time.end, and leaves liveness alone', () => {
    const { dbPath } = freshCopy();
    const clock = baselineClock();
    const engine = new OcLivenessEngine({ dbPath, now: () => clock });

    engine.poll();
    // Control: the committed corpora carry zero running tool parts.
    for (const snapshot of engine.snapshotAll()) {
      expect(snapshot.toolStatus).toBe('done');
      expect(snapshot.runningToolCount).toBe(0);
    }

    const mutated = makeToolRunning(dbPath);
    engine.poll();

    const after = snapshotOrFail(engine, mutated.sessionId);
    expect(after.toolStatus).toBe('running');
    expect(after.runningToolCount).toBe(1);
    expect(after.runningTools[0]?.callId).toBe(mutated.callId);
    expect(after.runningTools[0]?.partId).toBe(mutated.partId);
    // `running` is an AgentNode status, NOT a SessionState liveness value: the
    // liveness enum must be untouched by the mutation.
    expect(after.liveness).toBe('idle');
    expect(engine.counters().toolPartsRunning).toBe(1);
    engine.dispose();
  });

  it('does a full re-read and increments a counter when seq drops below the last-seen value, and never refuses', () => {
    const { dbPath } = freshCopy();
    const clock = baselineClock();
    const engine = new OcLivenessEngine({ dbPath, now: () => clock });

    engine.poll();
    const seededSeq = engine.cursorOf(busiestSessionId) ?? -1;
    expect(seededSeq).toBeGreaterThan(3);
    expect(engine.counters().eventsRead).toBe(0);

    const eventRowsForSession = countEventsFor(dbPath, busiestSessionId);
    expect(eventRowsForSession).toBeGreaterThan(0);

    setSeq(dbPath, busiestSessionId, 3);
    engine.poll();

    const counters = engine.counters();
    expect(counters.seqRegressions).toBe(1);
    expect(counters.fullRereads).toBe(1);
    // The re-read really read: every event row for that aggregate, not a range.
    expect(counters.eventsRead).toBe(eventRowsForSession);
    expect(engine.cursorOf(busiestSessionId)).toBe(3);

    // Never a refusal: the engine is healthy and the session still renders.
    expect(engine.health().ok).toBe(true);
    expect(counters.pollErrors).toBe(0);
    const after = snapshotOrFail(engine, busiestSessionId);
    expect(['live', 'idle', 'ended']).toContain(after.liveness);
    engine.dispose();
  });

  it('degrades to engineDegraded without throwing when the database file is deleted mid-poll', () => {
    const { dbPath } = freshCopy();
    const clock = baselineClock();
    const engine = new OcLivenessEngine({ dbPath, now: () => clock });

    engine.poll();
    expect(engine.health().ok).toBe(true);
    const idsBefore = engine.sessionIds().length;
    expect(idsBefore).toBeGreaterThan(0);

    rmSync(dbPath, { force: true });
    rmSync(walPathFor(dbPath), { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    expect(() => {
      engine.poll();
    }).not.toThrow();

    const health = engine.health();
    expect(health.ok).toBe(false);
    if (health.ok) throw new Error('unreachable');
    expect(health.code).toBe('databaseMissing');
    expect(health.path).toBe(dbPath);
    expect(engine.isDegraded()).toBe(true);
    expect(engine.counters().degradedPolls).toBe(1);
    expect(engine.counters().pollErrors).toBe(0);
    // The engine stopped SEEING; it did not learn that anything ended.
    expect(engine.sessionIds().length).toBe(idsBefore);
    engine.dispose();
  });
});

// ===========================================================================
// The cursor rule (OC4)
// ===========================================================================

describe('OcLivenessEngine — the cursor', () => {
  it('tracks the cursor per session, so one busy session cannot make a quiet one live', () => {
    const { dbPath } = freshCopy();
    let clock = baselineClock();
    const engine = new OcLivenessEngine({ dbPath, now: () => clock });

    engine.poll();
    const seededSeq = engine.cursorOf(busiestSessionId) ?? -1;
    const othersBefore = engine
      .snapshotAll()
      .filter((s) => s.sessionId !== busiestSessionId)
      .map((s) => ({ id: s.sessionId, seq: s.seq }));
    expect(othersBefore.length).toBeGreaterThan(0);

    setSeq(dbPath, busiestSessionId, seededSeq + 50);
    clock = baselineClock() + 1000;
    engine.poll();

    expect(snapshotOrFail(engine, busiestSessionId).liveness).toBe('live');
    for (const other of othersBefore) {
      const after = snapshotOrFail(engine, other.id);
      expect(after.liveness).toBe('idle');
      expect(after.seq).toBe(other.seq);
      expect(after.seqAdvancedAt).toBeUndefined();
      expect(after.cursorSeeded).toBe(true);
    }
    expect(engine.counters().seqAdvances).toBe(1);
    engine.dispose();
  });

  it('seeds a cursor without claiming activity, so the first poll invents no liveness', () => {
    const { dbPath } = freshCopy();
    const clock = baselineClock();
    const engine = new OcLivenessEngine({ dbPath, now: () => clock });

    engine.poll();

    const counters = engine.counters();
    expect(counters.sessionsSeeded).toBe(counters.cursorRows);
    expect(counters.seqAdvances).toBe(0);
    expect(counters.eventsRead).toBe(0);
    for (const snapshot of engine.snapshotAll()) {
      expect(snapshot.seqAdvancedAt).toBeUndefined();
      expect(snapshot.lastActivityAt).toBe(snapshot.timeUpdated);
    }
    engine.dispose();
  });

  it('counts a well-formed but unmeasured event type instead of refusing it', () => {
    const { dbPath } = freshCopy();
    const clock = baselineClock();
    const engine = new OcLivenessEngine({ dbPath, now: () => clock });

    engine.poll();
    const seededSeq = engine.cursorOf(busiestSessionId) ?? -1;

    insertEvent(dbPath, busiestSessionId, seededSeq + 1, 'session.exploded.7');
    engine.poll();

    const counters = engine.counters();
    expect(counters.eventsRead).toBe(1);
    expect(counters.eventTypesUnknown).toBe(1);
    expect(counters.eventTypesMalformed).toBe(0);
    expect(engine.health().ok).toBe(true);
    expect(engine.snapshot(busiestSessionId)).toBeDefined();
    engine.dispose();
  });

  it('counts an event type that is not name-plus-dotted-version instead of refusing it', () => {
    const { dbPath } = freshCopy();
    const clock = baselineClock();
    const engine = new OcLivenessEngine({ dbPath, now: () => clock });

    engine.poll();
    const seededSeq = engine.cursorOf(busiestSessionId) ?? -1;

    insertEvent(dbPath, busiestSessionId, seededSeq + 1, 'sessioncreated');
    engine.poll();

    const counters = engine.counters();
    expect(counters.eventsRead).toBe(1);
    expect(counters.eventTypesMalformed).toBe(1);
    expect(counters.eventTypesUnknown).toBe(0);
    expect(engine.health().ok).toBe(true);
    engine.dispose();
  });

  it('accepts every event type the corpus actually carries as well formed', () => {
    const types = readOnly(corpusDbPath(CORPUS), (db) =>
      (db.prepare('SELECT DISTINCT type FROM event ORDER BY type').all() as Row[]).map((row) =>
        str(row['type']),
      ),
    );
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      expect(EVENT_TYPE_FORM.test(type)).toBe(true);
      expect(MEASURED_EVENT_TYPES.has(type)).toBe(true);
    }
  });
});

// ===========================================================================
// Running tools — the conjunction, both arms
// ===========================================================================

describe('OcLivenessEngine — in-flight tool calls', () => {
  it('does not count a tool part whose status is running but which still carries state.time.end', () => {
    const { dbPath } = freshCopy();
    const clock = baselineClock();
    const engine = new OcLivenessEngine({ dbPath, now: () => clock });

    const mutated = makeToolRunning(dbPath, true);
    engine.poll();

    const after = snapshotOrFail(engine, mutated.sessionId);
    expect(after.toolStatus).toBe('done');
    expect(after.runningToolCount).toBe(0);
    const counters = engine.counters();
    expect(counters.toolPartsRunningWithEnd).toBe(1);
    expect(counters.toolPartsRunning).toBe(0);
    engine.dispose();
  });

  it('keeps answering liveness when the part scan fails (G2 inside the engine)', () => {
    const { dbPath } = freshCopy();
    const clock = freshestTimeUpdated;
    const engine = new OcLivenessEngine({ dbPath, now: () => clock });

    dropPartTable(dbPath);
    engine.poll();

    const counters = engine.counters();
    expect(counters.partScanFailures).toBe(1);
    expect(engine.health().ok).toBe(true);
    const after = snapshotOrFail(engine, freshestSessionId);
    expect(after.liveness).toBe('live');
    expect(after.toolStatus).toBe('done');
    engine.dispose();
  });
});

// ===========================================================================
// Degradation
// ===========================================================================

describe('OcLivenessEngine — degradation', () => {
  it('degrades as databaseUnreadable for a file that is present but is not a database', () => {
    const dir = makeTempDir('agent-deck-oc-liveness-');
    scratchDirs.push(dir);
    const dbPath = join(dir, 'opencode.db');
    // Deliberately NOT zero-length: SQLite opens a zero-length file happily as
    // a valid empty database, which would prove the opposite of the point.
    writeFileSync(dbPath, Buffer.from('SQLite format 3\u0000 -- not really\n'.repeat(64), 'utf8'));

    const engine = new OcLivenessEngine({ dbPath, now: () => baselineClock() });
    expect(() => {
      engine.poll();
    }).not.toThrow();

    const health = engine.health();
    expect(health.ok).toBe(false);
    if (health.ok) throw new Error('unreachable');
    expect(health.code).toBe('databaseUnreadable');
    expect(health.path).toBe(dbPath);
    expect(engine.counters().pollErrors).toBe(0);
    engine.dispose();
  });

  it('degrades as databaseMissing when the path never existed, and recovers when it appears', () => {
    const dir = makeTempDir('agent-deck-oc-liveness-');
    scratchDirs.push(dir);
    const dbPath = join(dir, 'opencode.db');

    const engine = new OcLivenessEngine({ dbPath, now: () => baselineClock() });
    engine.poll();
    const health = engine.health();
    expect(health.ok).toBe(false);
    if (health.ok) throw new Error('unreachable');
    expect(health.code).toBe('databaseMissing');
    expect(engine.snapshotAll()).toHaveLength(0);

    copyCorpus(CORPUS, dir);
    engine.poll();
    expect(engine.health().ok).toBe(true);
    expect(engine.sessionIds().length).toBeGreaterThan(0);
    engine.dispose();
  });

  it('counts an onUpdate callback that throws and keeps polling (G2)', () => {
    const { dbPath } = freshCopy();
    let calls = 0;
    const engine = new OcLivenessEngine({
      dbPath,
      now: () => baselineClock(),
      onUpdate: () => {
        calls += 1;
        throw new Error('the UI blew up');
      },
    });

    expect(() => {
      engine.poll();
      engine.poll();
    }).not.toThrow();

    expect(calls).toBe(2);
    expect(engine.counters().callbackErrors).toBe(2);
    expect(engine.counters().polls).toBe(2);
    expect(engine.health().ok).toBe(true);
    engine.dispose();
  });
});

// ===========================================================================
// Injected trigger and wake signal
// ===========================================================================

describe('OcLivenessEngine — poll trigger and WAL wake', () => {
  it('registers the injected trigger with the named 1000 ms poll interval', () => {
    const { dbPath } = freshCopy();
    const trigger = manualTrigger();
    const engine = new OcLivenessEngine({
      dbPath,
      now: () => baselineClock(),
      pollTrigger: trigger.trigger,
    });

    engine.start();
    expect(DEFAULT_OC_POLL_INTERVAL_MS).toBe(1000);
    expect(trigger.registrations).toHaveLength(1);
    expect(trigger.registrations[0]?.intervalMs).toBe(DEFAULT_OC_POLL_INTERVAL_MS);
    // `start` polls once itself so the first render does not wait a second.
    expect(engine.counters().polls).toBe(1);

    trigger.fire();
    expect(engine.counters().polls).toBe(2);
    engine.dispose();
    expect(trigger.stops()).toBe(1);
  });

  it('polls on an injected WAL wake and counts a watcher error without rethrowing', () => {
    const { dbPath } = freshCopy();
    const watch = manualWalWatch();
    const engine = new OcLivenessEngine({
      dbPath,
      now: () => baselineClock(),
      walWatchFactory: watch.factory,
    });

    engine.start();
    expect(watch.paths).toEqual([walPathFor(dbPath)]);
    expect(engine.counters().polls).toBe(1);

    watch.wake();
    expect(engine.counters().wakes).toBe(1);
    expect(engine.counters().polls).toBe(2);

    expect(() => {
      watch.raise(new Error('EPERM'));
    }).not.toThrow();
    expect(engine.counters().watchErrors).toBe(1);
    expect(engine.lastFailure()).toBe('EPERM');

    engine.dispose();
    expect(watch.closes()).toBe(1);
    // After dispose the engine is inert.
    watch.wake();
    trailingPollIsInert(engine);
  });

  it('stops polling after dispose and never throws from a late trigger', () => {
    const { dbPath } = freshCopy();
    const trigger = manualTrigger();
    const engine = new OcLivenessEngine({
      dbPath,
      now: () => baselineClock(),
      pollTrigger: trigger.trigger,
    });
    engine.start();
    const pollsAtStart = engine.counters().polls;
    engine.dispose();
    engine.dispose();

    expect(() => {
      trigger.fire();
      engine.poll();
    }).not.toThrow();
    expect(engine.counters().polls).toBe(pollsAtStart);
    expect(trigger.stops()).toBe(1);
  });

  it(
    'wakes a real chokidar watch on the opencode.db-wal mtime',
    async () => {
      const { dir, dbPath } = freshCopy();
      const walPath = walPathFor(dbPath);
      // A ZERO-LENGTH `-wal` is a valid empty WAL, so the database still opens
      // while the file exists to be touched. The file's SIZE is never read by
      // anything here: it measured at exactly 4,181,832 bytes across 2 h 30 m
      // and four probes while the database grew 425 KB, so size is not a write
      // indicator and no control in this file may key on it.
      writeFileSync(walPath, Buffer.alloc(0));

      const engine = new OcLivenessEngine({
        dbPath,
        now: () => baselineClock(),
        walWatchFactory: createWalWatchFactory(),
      });
      engine.start();

      const deadline = Date.now() + 15_000;
      while (engine.counters().wakes === 0 && Date.now() < deadline) {
        // Rewritten on every iteration: a single missed fs event is retried
        // rather than being the whole result, so a failure here is a real
        // timeout and not a race lost once.
        writeFileSync(walPath, Buffer.alloc(0));
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }

      engine.dispose();
      expect(engine.counters().wakes).toBeGreaterThan(0);
      expect(engine.counters().polls).toBeGreaterThan(1);
      expect(existsSync(dir)).toBe(true);
    },
    20_000,
  );

  it('resolves a watch path through realpathSync.native, which is the libuv 8.3 guard', () => {
    const dir = makeTempDir('agent-deck-oc-liveness-');
    scratchDirs.push(dir);
    const walPath = walPathFor(join(dir, 'opencode.db'));

    const resolved = resolveWatchPath(walPath);
    expect(resolved.endsWith('opencode.db-wal')).toBe(true);
    // No 8.3 short component survives: libuv ABORTS the process on one, with
    // no failing assertion and no summary line.
    expect(resolved).not.toMatch(/~\d/);

    // A directory that is not there resolves to the absolute path rather than
    // throwing, so the caller degrades on the missing database instead.
    const gone = resolveWatchPath(join(dir, 'nope', 'opencode.db-wal'));
    expect(gone.endsWith('opencode.db-wal')).toBe(true);
  });
});

function trailingPollIsInert(engine: OcLivenessEngine): void {
  const polls = engine.counters().polls;
  engine.poll();
  expect(engine.counters().polls).toBe(polls);
}

// ===========================================================================
// Contracts this module is held to by other documents
// ===========================================================================

describe('OcLivenessEngine — contracts', () => {
  it('reuses the agentDeck.livenessThresholdMs default from package.json rather than re-deciding it', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
      contributes: {
        configuration: {
          properties: Record<string, { default?: unknown }>;
        };
      };
    };
    const declared = manifest.contributes.configuration.properties['agentDeck.livenessThresholdMs'];
    expect(declared).toBeDefined();
    expect(declared?.default).toBe(DEFAULT_OC_LIVENESS_THRESHOLD_MS);
  });

  it('honours a threshold override at the exact boundary, inclusive', () => {
    const { dbPath } = freshCopy();
    let clock = freshestTimeUpdated;
    const engine = new OcLivenessEngine({ dbPath, now: () => clock, thresholdMs: 5_000 });
    expect(engine.thresholdMs).toBe(5_000);

    engine.poll();
    clock = freshestTimeUpdated + 5_000;
    expect(snapshotOrFail(engine, freshestSessionId).liveness).toBe('live');
    clock = freshestTimeUpdated + 5_001;
    expect(snapshotOrFail(engine, freshestSessionId).liveness).toBe('idle');

    engine.setThresholdMs(10_000);
    expect(engine.thresholdMs).toBe(10_000);
    expect(snapshotOrFail(engine, freshestSessionId).liveness).toBe('live');
    // A nonsense value is ignored rather than adopted.
    engine.setThresholdMs(Number.NaN);
    engine.setThresholdMs(-1);
    expect(engine.thresholdMs).toBe(10_000);
    engine.dispose();
  });

  it('never produces unsupported: that value belongs to the fingerprint', () => {
    const { dbPath } = freshCopy();
    const engine = new OcLivenessEngine({ dbPath, now: () => baselineClock() });
    engine.poll();
    const values = new Set(engine.snapshotAll().map((s) => String(s.liveness)));
    expect(values.size).toBeGreaterThan(0);
    expect(values.has('unsupported')).toBe(false);
    for (const value of values) expect(['live', 'idle', 'ended']).toContain(value);
    engine.dispose();
  });

  it('writes nothing to the database it observes (G1)', () => {
    const { dbPath } = freshCopy();
    const before = createHash('sha256').update(readFileSync(dbPath)).digest('hex');

    const engine = new OcLivenessEngine({ dbPath, now: () => baselineClock() });
    engine.poll();
    engine.poll();
    engine.dispose();

    const after = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
    expect(after).toBe(before);
  });

  it('has no clock, no timer and no socket in its own source (A2 + G5)', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    // Comments are stripped first: the header carries a `setInterval` sketch
    // showing the orchestrator what to wire, and scanning raw text would
    // report the documentation as the defect.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/\bsetInterval\b/);
    expect(code).not.toMatch(/\bsetTimeout\b/);
    expect(code).not.toMatch(/\bsetImmediate\b/);
    expect(code).not.toMatch(/\bperformance\.now\b/);
    // G5: zero sockets. No listener, no client, no server, no SSE.
    for (const forbidden of ['node:net', 'node:http', 'node:https', 'node:dns', 'node:tls']) {
      expect(code).not.toContain(forbidden);
    }
    // G2 across engines: no import from the Claude Code engine.
    expect(code).not.toContain('../model/liveness');
    expect(code).not.toContain('../parser/');
    // The test-only write surface must not be reachable from production code.
    expect(code).not.toContain('./synthetic');
    // And the sketch the header carries is still there, so removing it is a
    // visible edit rather than a silent one.
    expect(source).toContain('setInterval(run, intervalMs)');
  });

  it('opens the database read-only, in the module, on every poll path', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    expect(source).toContain('new DatabaseSync(this.dbPath, { readOnly: true })');
    expect(source.match(/new DatabaseSync\(/g)).toHaveLength(1);
  });
});
