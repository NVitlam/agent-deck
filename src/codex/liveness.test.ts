/**
 * DoD 2.5 — the Codex engine's liveness tap.
 *
 * The one rule everything here defends is Phase 0 decision D0.1:
 *
 *   > An agent is dead when its writer lock is gone AND no hook event has
 *   > arrived within `livenessThresholdMs`. `SubagentStop` only clears
 *   > "in flight"; it never marks dead.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL CAPTURED DATA HERE AND WHAT IS SYNTHETIC
 * ---------------------------------------------------------------------------
 * Stated plainly, because the two prove different things and a reader should
 * never have to guess which is which:
 *
 * **REAL** — every hook stream and every transcript under
 * `fixtures/codex-0.151.0-alpha.7.2`. The `resume-twice-v1` two-stops case,
 * the union-join counts, the C11 root attribution and the
 * no-`SubagentStart`-required case are all derived from those bytes at test
 * time. No count from the corpus is written into this file: the suite derives
 * it and asserts the RELATION, because the numbers in the spec come from Phase
 * 0's probe corpus and are not this corpus's.
 *
 * **SYNTHETIC** — every writer lock, and every clock. There is no committed
 * lock directory and there cannot be one: a lock is a 0-byte file that exists
 * only while its thread is live, so a corpus captured after the fact contains
 * exactly zero of them. Every lock scenario below is built in a temp
 * directory. The clock is injected for the recorded reason — a threshold test
 * that sleeps measures the machine it ran on and fails under load — so **no
 * test here sleeps, at all.**
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  CODEX_COORDINATION_LOCK_NAME,
  CodexLivenessEngine,
  DEFAULT_CODEX_POLL_INTERVAL_MS,
  buildCodexToolCallIndex,
  codexHookJoinKeys,
  computeCodexLiveness,
  joinCodexHookToolIds,
  readCodexHookStream,
  readTranscriptMtimeMs,
  reduceCodexHookEvents,
  scanCodexWriterLocks,
  type CodexHookEvent,
  type CodexLockDirent,
  type CodexLockScan,
  type CodexLivenessThread,
} from './liveness.js';
import { parseCodexTranscript } from './parse.js';
import type { CodexToolCall } from './types.js';

// ---------------------------------------------------------------------------
// The corpus, discovered rather than listed
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CORPUS = join(REPO_ROOT, 'fixtures', 'codex-0.151.0-alpha.7.2');

/**
 * Run directories, read off the disk.
 *
 * `CLAUDE.md`: "Do not assert fixture-set sizes. Counts hard-coded against the
 * capture break on the next harvest and read as regressions."
 */
function runDirs(): string[] {
  return readdirSync(CORPUS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function hookStreamText(run: string): string {
  return readFileSync(join(CORPUS, run, 'hook-stream.jsonl'), 'utf8');
}

function hookEvents(run: string): readonly CodexHookEvent[] {
  return readCodexHookStream(hookStreamText(run)).events;
}

function payloadOf(event: CodexHookEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

/** Every rollout transcript of one run, deepest-first walk of the day tree. */
function transcriptPaths(run: string): string[] {
  const root = join(CORPUS, run, 'home', '.codex', 'sessions');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function toolCallsOf(run: string): CodexToolCall[] {
  const calls: CodexToolCall[] = [];
  for (const path of transcriptPaths(run)) {
    const parsed = parseCodexTranscript(readFileSync(path, 'utf8'), {
      file: basename(path),
      mtimeMs: 0,
    });
    if (parsed.thread !== null) calls.push(...parsed.thread.toolCalls);
  }
  return calls;
}

/** The root thread id of a run: every hook event carries it as `session_id`. */
function rootThreadId(run: string): string {
  const first = hookEvents(run)[0];
  expect(first).toBeDefined();
  return String(payloadOf(first as CodexHookEvent)['session_id']);
}

function lastEventMs(events: readonly CodexHookEvent[]): number {
  return Math.max(...events.map((e) => e.receivedAtMs));
}

// ---------------------------------------------------------------------------
// Temp directories — every lock in this file is synthetic
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

/** `realpathSync.native` first: libuv aborts on an 8.3 short path component. */
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A synthetic writer-lock directory: 0-byte files, exactly as Codex writes. */
function lockDirWith(names: readonly string[]): string {
  const dir = join(tmp('cx-lock-'), 'thread-writer-locks');
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, name), '');
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixed clock
// ---------------------------------------------------------------------------

const THRESHOLD = 120_000;

function at(now: number): { now: () => number; livenessThresholdMs: number } {
  return { now: () => now, livenessThresholdMs: THRESHOLD };
}

function thread(threadId: string, sessionId = threadId, mtimeMs?: number): CodexLivenessThread {
  return mtimeMs === undefined ? { threadId, sessionId } : { threadId, sessionId, mtimeMs };
}

function stateOf(
  report: { threads: readonly { threadId: string }[] },
  threadId: string,
): Record<string, unknown> {
  const found = report.threads.find((t) => t.threadId === threadId);
  expect(found, `no liveness for ${threadId}`).toBeDefined();
  return found as unknown as Record<string, unknown>;
}

// ===========================================================================

describe('the hook stream reader — the envelope is not the payload', () => {
  it('reads every committed stream with no malformed lines and no envelope disagreement', () => {
    const runs = runDirs();
    expect(runs.length).toBeGreaterThan(0);
    let total = 0;
    for (const run of runs) {
      const read = readCodexHookStream(hookStreamText(run));
      expect(read.malformedLines, run).toBe(0);
      expect(read.envelopeDisagreements, run).toBe(0);
      expect(read.skipped, run).toEqual([]);
      expect(read.events.length, run).toBeGreaterThan(0);
      total += read.events.length;
    }
    // Derived, not pinned: the corpus's own record count.
    expect(total).toBe(
      runs.reduce(
        (n, run) => n + hookStreamText(run).split('\n').filter((l) => l.trim() !== '').length,
        0,
      ),
    );
  });

  it('takes identity from the PAYLOAD and counts the envelope disagreeing', () => {
    // Vacuity control for the assertion above: a stream where the envelope and
    // the payload tell different stories must be VISIBLE, and the payload must
    // win. If the reader trusted the envelope this test reads the wrong thread.
    const line = JSON.stringify({
      seq: 1,
      receivedAt: 1000,
      eventName: 'SessionStart',
      sessionId: 'ENVELOPE-SAYS-THIS',
      raw: { session_id: 'PAYLOAD-SAYS-THIS', hook_event_name: 'SessionStart' },
    });
    const read = readCodexHookStream(line);
    expect(read.envelopeDisagreements).toBe(1);
    const reduced = reduceCodexHookEvents(read.events);
    expect([...reduced.states.keys()]).toEqual(['PAYLOAD-SAYS-THIS']);
  });

  it('counts a malformed line and never throws (G3)', () => {
    const good = hookStreamText(runDirs()[0] as string).split('\n').filter((l) => l.trim() !== '')[0];
    const read = readCodexHookStream(`${good as string}\n{not json\n`);
    expect(read.malformedLines).toBe(1);
    expect(read.events).toHaveLength(1);
    expect(read.skipped).toEqual([{ line: 2, reason: 'malformedJson' }]);
  });

  it('skips a record with no payload, and says which line and why (rule 18)', () => {
    const read = readCodexHookStream('{"seq":1,"receivedAt":5}\n[1,2]\n{"raw":{},"seq":2}\n');
    expect(read.events).toEqual([]);
    expect(read.skipped).toEqual([
      { line: 1, reason: 'noPayload' },
      { line: 2, reason: 'notAnObject' },
      { line: 3, reason: 'noReceivedAt' },
    ]);
  });
});

// ===========================================================================

describe("D0.1 — SubagentStop clears in flight and NEVER marks dead (resume-twice-v1)", () => {
  const RUN = 'resume-twice-v1';

  /** Agents with their stops and the distinct turn ids of those stops. */
  function stopsByAgent(run: string): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const event of hookEvents(run)) {
      const p = payloadOf(event);
      if (p['hook_event_name'] !== 'SubagentStop') continue;
      const agent = String(p['agent_id']);
      const turns = out.get(agent) ?? new Set<string>();
      turns.add(String(p['turn_id']));
      out.set(agent, turns);
    }
    return out;
  }

  it('the corpus really does hold one agent with two stops on two turn ids', () => {
    // Derived from the fixture, not hard-coded: this is the precondition the
    // rest of the suite rests on, so it is measured rather than assumed.
    const stops = stopsByAgent(RUN);
    const multi = [...stops.entries()].filter(([, turns]) => turns.size >= 2);
    expect(multi).toHaveLength(1);
    const entry = multi[0] as [string, Set<string>];
    expect(entry[1].size).toBe(2);

    const events = hookEvents(RUN);
    const stopCount = events.filter(
      (e) => payloadOf(e)['hook_event_name'] === 'SubagentStop' && payloadOf(e)['agent_id'] === entry[0],
    ).length;
    const startCount = events.filter(
      (e) => payloadOf(e)['hook_event_name'] === 'SubagentStart' && payloadOf(e)['agent_id'] === entry[0],
    ).length;
    expect(stopCount).toBe(2);
    // 1 start against 2 stops: the under-report the contract's A2 reproduces.
    expect(startCount).toBeLessThan(stopCount);
  });

  it('one agent, two SubagentStops, STILL LIVE', () => {
    // This is DoD 2.5's named test. The lock directory EXISTS and is EMPTY —
    // the agent's lock is gone — so the only thing keeping it alive is the
    // hook conjunct of D0.1. An engine that marked dead on `SubagentStop`
    // would fail here, and so would one that read D0.1 as an OR.
    const events = hookEvents(RUN);
    const agent = [...stopsByAgent(RUN).keys()][0] as string;
    const root = rootThreadId(RUN);
    const now = lastEventMs(events) + 1_000;

    const report = computeCodexLiveness(
      {
        threads: [thread(root), thread(agent, root)],
        hookEvents: events,
        lockScan: scanCodexWriterLocks(lockDirWith([])),
      },
      at(now),
    );

    const agentLiveness = stateOf(report, agent);
    expect(agentLiveness['state']).toBe('live');
    expect(agentLiveness['lockPresent']).toBe(false);
    // The last event for this agent IS its second stop, and a stop clears
    // in flight. Live and not in flight are different facts.
    expect(agentLiveness['inFlight']).toBe(false);
    expect(report.counters.subagentStops).toBeGreaterThan(report.counters.subagentStarts);
  });

  it('in flight goes true, false, true, false across the two turns', () => {
    // The agent stopped, was resumed (a PreToolUse after the first stop), and
    // stopped again. Replaying the real stream one event at a time is the only
    // way to see that the first stop did not end anything.
    const events = hookEvents(RUN);
    const agent = [...stopsByAgent(RUN).keys()][0] as string;
    const root = rootThreadId(RUN);
    const emptyLockDir = scanCodexWriterLocks(lockDirWith([]));
    const first = events.findIndex((e) => payloadOf(e)['agent_id'] === agent);
    expect(first).toBeGreaterThanOrEqual(0);
    // Every prefix from the agent's FIRST event on. Before that it has no
    // events at all, which is a different case (and a dead one, correctly).
    const seen: string[] = [];
    for (let i = first + 1; i <= events.length; i += 1) {
      const slice = events.slice(0, i);
      const report = computeCodexLiveness(
        { threads: [thread(agent, root)], hookEvents: slice, lockScan: emptyLockDir },
        at(lastEventMs(slice) + 1),
      );
      const l = stateOf(report, agent);
      const mark = `${String(l['state'])}/${l['inFlight'] === true ? 'inflight' : 'idlecall'}`;
      if (seen[seen.length - 1] !== mark) seen.push(mark);
    }
    // Never dead at any prefix, and in flight toggles more than once.
    expect(seen.some((m) => m.startsWith('dead'))).toBe(false);
    expect(seen.filter((m) => m.endsWith('/inflight')).length).toBeGreaterThanOrEqual(2);
  });

  it('the same agent IS dead once the threshold passes with the lock gone', () => {
    // The control for the test above: it is live because of hook recency, not
    // because this arrangement can never produce a death.
    const events = hookEvents(RUN);
    const agent = [...stopsByAgent(RUN).keys()][0] as string;
    const report = computeCodexLiveness(
      {
        threads: [thread(agent, rootThreadId(RUN))],
        hookEvents: events,
        lockScan: scanCodexWriterLocks(lockDirWith([])),
      },
      at(lastEventMs(events) + THRESHOLD + 1),
    );
    expect(stateOf(report, agent)['state']).toBe('dead');
  });
});

// ===========================================================================

describe('D0.1 is an AND, not an OR', () => {
  const AGENT = 'agent-1';
  const ROOT = 'root-1';

  function stream(atMs: number): CodexHookEvent[] {
    return [
      {
        receivedAtMs: atMs,
        payload: { session_id: ROOT, agent_id: AGENT, hook_event_name: 'PreToolUse', tool_use_id: 'exec-1' },
      },
    ];
  }

  it('lock GONE but a recent hook event -> not dead', () => {
    const report = computeCodexLiveness(
      { threads: [thread(AGENT, ROOT)], hookEvents: stream(1_000), lockScan: scanCodexWriterLocks(lockDirWith([])) },
      at(1_000 + THRESHOLD),
    );
    const l = stateOf(report, AGENT);
    expect(l['state']).toBe('live');
    expect(l['lockPresent']).toBe(false);
  });

  it('lock PRESENT but no hook event inside the window -> not dead', () => {
    const report = computeCodexLiveness(
      {
        threads: [thread(AGENT, ROOT)],
        hookEvents: stream(1_000),
        lockScan: scanCodexWriterLocks(lockDirWith([`${AGENT}.lock`])),
      },
      at(1_000 + THRESHOLD + 1),
    );
    const l = stateOf(report, AGENT);
    expect(l['state']).toBe('idle');
    expect(l['lockPresent']).toBe(true);
  });

  it('lock PRESENT and no hook events AT ALL -> not dead, and it says it is degraded', () => {
    const report = computeCodexLiveness(
      { threads: [thread(AGENT, ROOT)], lockScan: scanCodexWriterLocks(lockDirWith([`${AGENT}.lock`])) },
      at(9_999_999),
    );
    const l = stateOf(report, AGENT);
    expect(l['state']).toBe('idle');
    expect(l['degraded']).toBe('noHookEvents');
    expect(l['lastHookEventMs']).toBeNull();
  });

  it('BOTH halves -> dead', () => {
    const report = computeCodexLiveness(
      { threads: [thread(AGENT, ROOT)], hookEvents: stream(1_000), lockScan: scanCodexWriterLocks(lockDirWith([])) },
      at(1_000 + THRESHOLD + 1),
    );
    expect(stateOf(report, AGENT)['state']).toBe('dead');
    expect(report.counters.dead).toBe(1);
  });

  it('a fresh mtime does NOT resurrect a thread that satisfies both halves', () => {
    // Spec C6: a lock is "evidence of life, not proof - corroborated by
    // transcript mtime". Corroboration confirms life; it does not create it.
    // If mtime were a third disjunct, D0.1 would have three terms.
    const now = 1_000 + THRESHOLD + 1;
    const report = computeCodexLiveness(
      {
        threads: [thread(AGENT, ROOT, now)],
        hookEvents: stream(1_000),
        lockScan: scanCodexWriterLocks(lockDirWith([])),
      },
      at(now),
    );
    const l = stateOf(report, AGENT);
    expect(l['state']).toBe('dead');
    expect(l['lastMtimeMs']).toBe(now);
  });
});

// ===========================================================================

describe('the threshold boundary, through the injected clock and with no sleeping', () => {
  const AGENT = 'agent-b';
  const EVENT_AT = 500_000;
  const events: CodexHookEvent[] = [
    { receivedAtMs: EVENT_AT, payload: { session_id: AGENT, hook_event_name: 'Stop' } },
  ];

  function stateAt(now: number): string {
    const report = computeCodexLiveness(
      { threads: [thread(AGENT)], hookEvents: events, lockScan: scanCodexWriterLocks(lockDirWith([])) },
      at(now),
    );
    return String(stateOf(report, AGENT)['state']);
  }

  it('exactly AT livenessThresholdMs is still live', () => {
    expect(stateAt(EVENT_AT + THRESHOLD)).toBe('live');
  });

  it('one millisecond past it is dead', () => {
    expect(stateAt(EVENT_AT + THRESHOLD + 1)).toBe('dead');
  });

  it('one millisecond before it is live', () => {
    expect(stateAt(EVENT_AT + THRESHOLD - 1)).toBe('live');
  });

  it('the clock is read exactly once per report, so one report is one instant', () => {
    let calls = 0;
    computeCodexLiveness(
      { threads: [thread('a'), thread('b'), thread('c')], hookEvents: events },
      {
        now: () => {
          calls += 1;
          return EVENT_AT;
        },
        livenessThresholdMs: THRESHOLD,
      },
    );
    expect(calls).toBe(1);
  });
});

// ===========================================================================

describe('SubagentStart is never required', () => {
  it('a real stream with its SubagentStarts removed produces the same states', () => {
    // REAL data, filtered: every `SubagentStart` deleted from every stream.
    // A2 retired the observation that the event can go missing; it did not
    // retire the rule, so the rule is what is tested.
    for (const run of runDirs()) {
      const all = hookEvents(run);
      const withoutStarts = all.filter((e) => payloadOf(e)['hook_event_name'] !== 'SubagentStart');
      const ids = new Set<string>();
      for (const e of all) {
        const p = payloadOf(e);
        ids.add(String(p['agent_id'] ?? p['session_id']));
      }
      const threads = [...ids].map((id) => thread(id, rootThreadId(run)));
      const now = lastEventMs(all) + 1_000;
      const lockScan = scanCodexWriterLocks(lockDirWith([]));
      // The "every thread is live" assertion below only means anything while
      // a run is shorter than the threshold. Stated, so a longer future
      // harvest fails here with the reason rather than somewhere downstream.
      const span = now - Math.min(...all.map((e) => e.receivedAtMs));
      expect(span, `${run} span`).toBeLessThan(THRESHOLD);

      const withAll = computeCodexLiveness({ threads, hookEvents: all, lockScan }, at(now));
      const withNone = computeCodexLiveness(
        { threads, hookEvents: withoutStarts, lockScan },
        at(now),
      );
      expect(withNone.threads.map((t) => t.state), run).toEqual(withAll.threads.map((t) => t.state));
      expect(withNone.threads.every((t) => t.state === 'live'), run).toBe(true);
    }
  });

  it('a stop-only stream still resolves the agent, with no start anywhere', () => {
    const events: CodexHookEvent[] = [
      { receivedAtMs: 10, payload: { session_id: 'r', agent_id: 'ghost', hook_event_name: 'SubagentStop' } },
    ];
    const report = computeCodexLiveness(
      { threads: [thread('ghost', 'r')], hookEvents: events, lockScan: scanCodexWriterLocks(lockDirWith([])) },
      at(11),
    );
    expect(report.counters.subagentStarts).toBe(0);
    expect(report.counters.subagentStops).toBe(1);
    expect(stateOf(report, 'ghost')['state']).toBe('live');
  });
});

// ===========================================================================

describe('every fallback names its degradation, and the primary names none', () => {
  const T = 'thread-d';
  const events: CodexHookEvent[] = [
    { receivedAtMs: 1_000, payload: { session_id: T, hook_event_name: 'Stop' } },
  ];

  it('the hook tap deciding is not degraded, and the key is ABSENT not undefined', () => {
    const report = computeCodexLiveness(
      { threads: [thread(T)], hookEvents: events, lockScan: scanCodexWriterLocks(lockDirWith([])) },
      at(1_001),
    );
    const l = stateOf(report, T);
    expect('degraded' in l).toBe(false);
    expect(report.counters.degraded).toBe(0);
  });

  it('no lock directory, with hook events -> lockDirMissing', () => {
    const report = computeCodexLiveness(
      { threads: [thread(T, T, 1_000)], hookEvents: events },
      at(1_000 + THRESHOLD + 1),
    );
    const l = stateOf(report, T);
    expect(l['degraded']).toBe('lockDirMissing');
    expect(report.counters.lockDirMissing).toBe(true);
  });

  it('a lock directory that cannot be read is the same as one that is not there', () => {
    const scan = scanCodexWriterLocks(join(tmp('cx-nolock-'), 'nope'));
    expect(scan.exists).toBe(false);
    expect(scan.error).not.toBeNull();
    const report = computeCodexLiveness({ threads: [thread(T)], hookEvents: events, lockScan: scan }, at(1_000 + THRESHOLD + 1));
    expect(stateOf(report, T)['degraded']).toBe('lockDirMissing');
  });

  it('no lock directory and no hook events, but an mtime -> mtimeOnly, idle', () => {
    const report = computeCodexLiveness({ threads: [thread(T, T, 900)] }, at(1_000));
    const l = stateOf(report, T);
    expect(l['state']).toBe('idle');
    expect(l['degraded']).toBe('mtimeOnly');
    expect(l['lastMtimeMs']).toBe(900);
  });

  it('no lock directory, no hook events and a STALE mtime -> mtimeOnly, unknown', () => {
    const report = computeCodexLiveness({ threads: [thread(T, T, 900)] }, at(900 + THRESHOLD + 1));
    const l = stateOf(report, T);
    expect(l['state']).toBe('unknown');
    expect(l['degraded']).toBe('mtimeOnly');
  });

  it('nothing at all -> unknown, and it blames the lock directory rather than an mtime it never had', () => {
    const report = computeCodexLiveness({ threads: [thread(T)] }, at(1_000));
    const l = stateOf(report, T);
    expect(l['state']).toBe('unknown');
    expect(l['degraded']).toBe('lockDirMissing');
    expect(l['lastMtimeMs']).toBeNull();
    expect(report.counters.threadsWithoutHookEvents).toBe(1);
  });

  it('reads a real transcript mtime, and reports null for a path that is not there', () => {
    const path = transcriptPaths('long-output')[0] as string;
    expect(readTranscriptMtimeMs(path)).toBe(statSync(path).mtimeMs);
    expect(readTranscriptMtimeMs(join(path, 'nope.jsonl'))).toBeNull();
  });
});

// ===========================================================================

describe('the writer-lock scan', () => {
  it('.coordination.lock is not a thread, and the skip is named', () => {
    const scan = scanCodexWriterLocks(lockDirWith([CODEX_COORDINATION_LOCK_NAME, 'aaa-bbb.lock']));
    expect(scan.threadIds).toEqual(['aaa-bbb']);
    expect(scan.skipped).toEqual([{ name: CODEX_COORDINATION_LOCK_NAME, reason: 'coordinationLock' }]);
  });

  it('a thread called `.coordination` never becomes live off that file', () => {
    // The failure this prevents: a scan that strips `.lock` from every entry
    // invents an agent named `.coordination` which is live FOREVER, because
    // that file outlives every thread (present at exit on 6 of 6 runs).
    const scan = scanCodexWriterLocks(lockDirWith([CODEX_COORDINATION_LOCK_NAME]));
    const report = computeCodexLiveness(
      { threads: [thread('.coordination'), thread('.coordination.lock')], lockScan: scan },
      at(1_000),
    );
    expect(report.threads.every((t) => t.lockPresent === false)).toBe(true);
    expect(report.counters.locksWithoutThread).toBe(0);
    expect(report.counters.locksSkipped).toBe(1);
  });

  it('names every other entry it declines, with a reason (rule 18)', () => {
    const scan = scanCodexWriterLocks(lockDirWith(['.hidden.lock', 'notes.txt', '.lock', 'ok-1.lock']));
    expect(scan.threadIds).toEqual(['ok-1']);
    expect([...scan.skipped].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: '.hidden.lock', reason: 'dotFile' },
      { name: '.lock', reason: 'dotFile' },
      { name: 'notes.txt', reason: 'notALockFile' },
    ]);
  });

  it('reads directory ENTRIES and never opens a lock file (G1)', () => {
    const opened: string[] = [];
    const scan = scanCodexWriterLocks('/fake/thread-writer-locks', {
      readdirSync: (path: string): CodexLockDirent[] => {
        opened.push(path);
        return [{ name: 'x.lock', isFile: () => true }];
      },
    });
    expect(scan.threadIds).toEqual(['x']);
    expect(opened).toEqual(['/fake/thread-writer-locks']);
  });

  it('a lock naming a thread nobody parsed is counted, not silently dropped', () => {
    const scan = scanCodexWriterLocks(lockDirWith(['known.lock', 'stranger.lock']));
    const report = computeCodexLiveness({ threads: [thread('known')], lockScan: scan }, at(1));
    expect(report.counters.locksWithoutThread).toBe(1);
    expect(stateOf(report, 'known')['lockPresent']).toBe(true);
  });
});

// ===========================================================================

describe('the hook join is over the UNION of both id namespaces (spec C4)', () => {
  it('indexes a call under call_id AND item_id when they differ', () => {
    const call = {
      callId: 'call_X',
      itemId: 'exec-Y',
    } as unknown as CodexToolCall;
    expect(codexHookJoinKeys(call)).toEqual(['call_X', 'exec-Y']);
    const index = buildCodexToolCallIndex([call]);
    expect(index.get('call_X')).toBe(call);
    expect(index.get('exec-Y')).toBe(call);
  });

  it('the union resolves strictly more of the real corpus than call_id alone', () => {
    // Derived at test time. The numbers in the spec are Phase 0's probe
    // corpus, not this one, so nothing here is quoted from a document.
    let unionTotal = 0;
    let callIdTotal = 0;
    let seenTotal = 0;
    for (const run of runDirs()) {
      const counts = joinCodexHookToolIds(hookEvents(run), toolCallsOf(run));
      unionTotal += counts.resolvedUnion;
      callIdTotal += counts.resolvedByCallId;
      seenTotal += counts.hookIdsSeen;
      // Nothing joined is ever lost by adding the second namespace.
      expect(counts.resolvedUnion, run).toBeGreaterThanOrEqual(counts.resolvedByCallId);
      expect(counts.resolvedUnion, run).toBeGreaterThanOrEqual(counts.resolvedByItemId);
    }
    expect(seenTotal).toBeGreaterThan(0);
    expect(unionTotal).toBeGreaterThan(callIdTotal);
    // And the difference is not a rounding artefact: it is whole shell calls.
    expect(unionTotal - callIdTotal).toBeGreaterThan(0);
  });

  it('every hook tool id in the corpus resolves against the union, none unresolved', () => {
    for (const run of runDirs()) {
      const counts = joinCodexHookToolIds(hookEvents(run), toolCallsOf(run));
      expect(counts.unresolved, run).toBe(0);
      expect(counts.resolvedUnion, run).toBe(counts.hookIdsSeen);
    }
  });

  it('computeCodexLiveness reports the join beside the states', () => {
    const run = 'baseline';
    const report = computeCodexLiveness(
      { threads: [thread(rootThreadId(run))], hookEvents: hookEvents(run), toolCalls: toolCallsOf(run) },
      at(lastEventMs(hookEvents(run)) + 1),
    );
    expect(report.join.hookIdsSeen).toBeGreaterThan(0);
    expect(report.join.unresolved).toBe(0);
  });
});

// ===========================================================================

describe('C11 — a main-thread event has no agent_id and belongs to the ROOT', () => {
  it('the literal "main" never appears as an agent id anywhere in the corpus', () => {
    let withAgentId = 0;
    let withoutAgentId = 0;
    let literalMain = 0;
    for (const run of runDirs()) {
      for (const event of hookEvents(run)) {
        const p = payloadOf(event);
        if ('agent_id' in p) withAgentId += 1;
        else withoutAgentId += 1;
        if (p['agent_id'] === 'main') literalMain += 1;
      }
    }
    expect(literalMain).toBe(0);
    expect(withoutAgentId).toBeGreaterThan(0);
    expect(withAgentId).toBeGreaterThan(0);
  });

  it('root events are attributed to the root thread, not dropped', () => {
    const run = 'baseline';
    const events = hookEvents(run);
    const root = rootThreadId(run);
    const rootEvents = events.filter((e) => !('agent_id' in payloadOf(e)));
    expect(rootEvents.length).toBeGreaterThan(0);

    const reduced = reduceCodexHookEvents(events);
    const rootState = reduced.states.get(root);
    expect(rootState).toBeDefined();
    expect((rootState as { events: number }).events).toBe(rootEvents.length);
    expect((rootState as { attributedBy: string }).attributedBy).toBe('session_id');
    expect(reduced.counters.rootEvents).toBe(rootEvents.length);
  });

  it('every hook state in every run maps to a thread the corpus declares', () => {
    // The vacuity control for the test above: if attribution invented ids the
    // transcripts do not declare, this goes red.
    for (const run of runDirs()) {
      const declared = new Set<string>();
      for (const path of transcriptPaths(run)) {
        const parsed = parseCodexTranscript(readFileSync(path, 'utf8'), { file: 'x.jsonl' });
        if (parsed.thread !== null) declared.add(parsed.thread.threadId);
      }
      const reduced = reduceCodexHookEvents(hookEvents(run));
      expect(declared.size, run).toBeGreaterThan(0);
      for (const id of reduced.states.keys()) expect([...declared], `${run}/${id}`).toContain(id);
    }
  });

  it('an event for a thread nobody parsed is COUNTED, not dropped in silence', () => {
    const report = computeCodexLiveness(
      {
        threads: [thread('known')],
        hookEvents: [{ receivedAtMs: 1, payload: { session_id: 'known' } }, { receivedAtMs: 2, payload: { session_id: 'stranger' } }],
      },
      at(3),
    );
    expect(report.counters.hookStatesWithoutThread).toBe(1);
    expect(report.counters.eventsSeen).toBe(2);
  });

  it('a payload that is not an object, or has no session_id, is unusable and counted', () => {
    const report = computeCodexLiveness(
      {
        threads: [],
        hookEvents: [
          { receivedAtMs: 1, payload: 'nope' },
          { receivedAtMs: 2, payload: { hook_event_name: 'Stop' } },
        ],
      },
      at(3),
    );
    expect(report.counters.eventsUnusable).toBe(2);
    expect(report.counters.eventsSeen).toBe(2);
  });

  it('agent_id present but empty is counted and falls back to the root', () => {
    const report = computeCodexLiveness(
      { threads: [thread('r')], hookEvents: [{ receivedAtMs: 1, payload: { session_id: 'r', agent_id: '' } }] },
      at(2),
    );
    expect(report.counters.agentIdMalformed).toBe(1);
    expect(report.counters.rootEvents).toBe(1);
    expect(stateOf(report, 'r')['lastHookEventMs']).toBe(1);
  });
});

// ===========================================================================

describe('in flight tracks open tool calls by their hook id', () => {
  const T = 'thread-f';

  function ev(atMs: number, name: string, toolUseId?: string): CodexHookEvent {
    return {
      receivedAtMs: atMs,
      payload:
        toolUseId === undefined
          ? { session_id: T, hook_event_name: name }
          : { session_id: T, hook_event_name: name, tool_use_id: toolUseId },
    };
  }

  function inFlightAfter(events: readonly CodexHookEvent[]): boolean {
    const report = computeCodexLiveness({ threads: [thread(T)], hookEvents: events }, at(100));
    return stateOf(report, T)['inFlight'] === true;
  }

  it('PreToolUse opens and the matching PostToolUse closes', () => {
    expect(inFlightAfter([ev(1, 'PreToolUse', 'exec-1')])).toBe(true);
    expect(inFlightAfter([ev(1, 'PreToolUse', 'exec-1'), ev(2, 'PostToolUse', 'exec-1')])).toBe(false);
  });

  it('a PostToolUse for a DIFFERENT call does not close the open one', () => {
    expect(inFlightAfter([ev(1, 'PreToolUse', 'exec-1'), ev(2, 'PostToolUse', 'call_9')])).toBe(true);
  });

  it('Stop and SessionEnd clear in flight without touching the state', () => {
    for (const terminator of ['Stop', 'SessionEnd', 'SubagentStop']) {
      const events = [ev(1, 'PreToolUse', 'exec-1'), ev(2, terminator)];
      expect(inFlightAfter(events), terminator).toBe(false);
      const report = computeCodexLiveness({ threads: [thread(T)], hookEvents: events }, at(3));
      expect(stateOf(report, T)['state'], terminator).not.toBe('dead');
    }
  });
});

// ===========================================================================

describe('the engine — the poll trigger is injected and no timer lives in the module', () => {
  interface Fake {
    runs: (() => void)[];
    intervals: number[];
    stops: number;
  }

  function fakeTrigger(f: Fake) {
    return (run: () => void, intervalMs: number) => {
      f.runs.push(run);
      f.intervals.push(intervalMs);
      return {
        stop: () => {
          f.stops += 1;
        },
      };
    };
  }

  function engineFor(now: () => number, lockScan: CodexLockScan | undefined, threads: CodexLivenessThread[], f: Fake) {
    return new CodexLivenessEngine({
      now,
      livenessThresholdMs: THRESHOLD,
      sample: () => (lockScan === undefined ? { threads } : { threads, lockScan }),
      pollTrigger: fakeTrigger(f),
    });
  }

  it('registers the trigger at the default interval and polls once on start', () => {
    const f: Fake = { runs: [], intervals: [], stops: 0 };
    const engine = engineFor(() => 1_000, scanCodexWriterLocks(lockDirWith([])), [thread('t')], f);
    engine.start();
    expect(f.intervals).toEqual([DEFAULT_CODEX_POLL_INTERVAL_MS]);
    expect(engine.latest?.threads).toHaveLength(1);
    engine.stop();
    engine.stop();
    expect(f.stops).toBe(1);
  });

  it('ingested events decide the state, and firing the trigger by hand re-applies the rule', () => {
    const f: Fake = { runs: [], intervals: [], stops: 0 };
    let now = 1_000;
    const engine = engineFor(() => now, scanCodexWriterLocks(lockDirWith([])), [thread('t')], f);
    engine.ingest({ receivedAtMs: 1_000, payload: { session_id: 't', hook_event_name: 'PreToolUse', tool_use_id: 'exec-1' } });
    engine.start();
    expect(engine.latest?.threads[0]?.state).toBe('live');
    expect(engine.latest?.threads[0]?.inFlight).toBe(true);

    now = 1_000 + THRESHOLD + 1;
    (f.runs[0] as () => void)();
    expect(engine.latest?.threads[0]?.state).toBe('dead');
    // The tool call is still open: nothing told us it finished. Dead and in
    // flight is a real, reportable combination, not a contradiction.
    expect(engine.latest?.threads[0]?.inFlight).toBe(true);
  });

  it('agrees exactly with computeCodexLiveness over the same real stream', () => {
    // The anti-drift check. Two code paths applying one rule is this repo's
    // recorded module-boundary defect; both go through renderCodexLiveness,
    // and this is what would catch it if one stopped.
    const run = 'spawn-shapes';
    const events = hookEvents(run);
    const root = rootThreadId(run);
    const ids = new Set<string>();
    for (const e of events) {
      const p = payloadOf(e);
      ids.add(String(p['agent_id'] ?? p['session_id']));
    }
    const threads = [...ids].map((id) => thread(id, root));
    const lockScan = scanCodexWriterLocks(lockDirWith([`${root}.lock`]));
    const now = lastEventMs(events) + THRESHOLD + 1;

    const f: Fake = { runs: [], intervals: [], stops: 0 };
    const engine = engineFor(() => now, lockScan, threads, f);
    for (const event of events) engine.ingest(event);
    const fromEngine = engine.poll();
    const fromPure = computeCodexLiveness({ threads, hookEvents: events, lockScan }, at(now));

    expect(fromEngine.threads).toEqual(fromPure.threads);
    expect(fromEngine.counters).toEqual(fromPure.counters);
    // The root holds a lock, so it is idle rather than dead; the subagents do
    // not, and the window has passed.
    expect(fromEngine.threads.find((t) => t.threadId === root)?.state).toBe('idle');
    expect(fromEngine.counters.dead).toBe(threads.length - 1);
  });

  it('an onUpdate that throws is counted and never escapes (G2)', () => {
    const engine = new CodexLivenessEngine({
      now: () => 1,
      livenessThresholdMs: THRESHOLD,
      sample: () => ({ threads: [thread('t')] }),
      onUpdate: () => {
        throw new Error('renderer blew up');
      },
    });
    expect(() => engine.poll()).not.toThrow();
    expect(engine.onUpdateFailures).toBe(1);
  });

  it('no Date.now, setInterval or setTimeout appears in the module OUTSIDE its comments', () => {
    const source = readFileSync(join(HERE, 'liveness.ts'), 'utf8');
    // BLOCK comments first, on the raw source. Doing the line pass first eats
    // code: blanking every line that starts with `*` leaves a multi-line
    // comment's opener unclosed, so the block regex then runs from that opener
    // to the next SINGLE-LINE `/** … */` and deletes everything between.
    // Measured on this very file — the vacuity control below is what caught it.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => (line.trim().startsWith('//') ? '' : line))
      .join('\n');
    expect(code).not.toContain('Date.now');
    expect(code).not.toContain('setInterval');
    expect(code).not.toContain('setTimeout');
    // Vacuity control: the stripper must not simply be deleting everything.
    expect(code).toContain('export function computeCodexLiveness');
  });
});
