/**
 * Liveness engine tests (spec v2 §C4).
 *
 * Two rules govern this file:
 *
 *   - No sleeping. Recency is exercised with an injected clock and an injected
 *     threshold; a test that waited 120 s would be a worse test AND a slower
 *     one.
 *   - No hard-coded fixture counts. Every expectation about
 *     `fixtures/hook-events/cc-2.1.234-redacted.jsonl` is derived from the
 *     file, so the next capture cannot make a harvest look like a regression.
 *
 * Events are built through the real `normalizeHookEvent` from the listener, so
 * the key-absence contract (`agent_id` omitted means main thread) is exercised
 * end to end rather than re-implemented here.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { normalizeHookEvent } from '../hooks/listener.js';
import type { NormalizedHookEvent, RawHookPayload } from './events.js';
import {
  DEFAULT_MTIME_THRESHOLD_MS,
  LivenessEngine,
  type JsonlInferenceSource,
} from './liveness.js';

const HOOK_FIXTURE_PATH = fileURLToPath(
  new URL('../../fixtures/hook-events/cc-2.1.234-redacted.jsonl', import.meta.url),
);

/** The onset capture: a listener bound first, then a fresh CC window. */
const SESSIONSTART_FIXTURE_PATH = fileURLToPath(
  new URL(
    '../../fixtures/hook-events/cc-2.1.234-sessionstart.jsonl',
    import.meta.url,
  ),
);

async function readSessionStartPayloads(): Promise<RawHookPayload[]> {
  const text = await readFile(SESSIONSTART_FIXTURE_PATH, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawHookPayload);
}

const LIVENESS_SOURCE_PATH = fileURLToPath(
  new URL('./liveness.ts', import.meta.url),
);

let seq = 0;

/** Build a normalized event exactly as the listener would. */
function ev(payload: RawHookPayload, receivedAt: number): NormalizedHookEvent {
  seq += 1;
  return normalizeHookEvent(payload, { seq, receivedAt });
}

const SESSION = 'session-under-test';

/** A main-thread payload: the `agent_id` key is ABSENT, never a sentinel. */
function mainPayload(
  name: string,
  extra: Record<string, unknown> = {},
): RawHookPayload {
  return { hook_event_name: name, session_id: SESSION, ...extra };
}

/** A subagent payload: the `agent_id` key is present and carries a real id. */
function subPayload(
  name: string,
  agentId: string,
  extra: Record<string, unknown> = {},
): RawHookPayload {
  return {
    hook_event_name: name,
    session_id: SESSION,
    agent_id: agentId,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// fixture replay
// ---------------------------------------------------------------------------

describe('replay of the committed hook-event capture', () => {
  let payloads: RawHookPayload[] = [];

  beforeAll(async () => {
    const text = await readFile(HOOK_FIXTURE_PATH, 'utf8');
    payloads = text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RawHookPayload);
    expect(payloads.length).toBeGreaterThan(0);
  });

  /** One event per fixture line, one second apart, on an injected clock. */
  function replay(): {
    engine: LivenessEngine;
    lastAt: number;
    events: NormalizedHookEvent[];
  } {
    const base = 1_700_000_000_000;
    const events = payloads.map((p, i) => ev(p, base + i * 1000));
    const lastAt = base + (payloads.length - 1) * 1000;
    const engine = new LivenessEngine({ now: () => lastAt });
    engine.ingestAll(events);
    return { engine, lastAt, events };
  }

  it('ingests every captured event without throwing', () => {
    const { engine } = replay();
    const counters = engine.counters();
    expect(counters.eventsReceived).toBe(payloads.length);
    expect(counters.ingestErrors).toBe(0);
    expect(counters.eventsSkippedNoSession).toBe(0);
    expect(counters.eventsSkippedUnattributable).toBe(0);
    expect(counters.eventsSkippedOrphanTerminal).toBe(0);
    expect(counters.eventsApplied).toBe(payloads.length);
  });

  it('tracks exactly the sessions and subagents the capture contains', () => {
    const { engine } = replay();

    const expectedSessions = new Set(
      payloads.map((p) => p.session_id).filter((id): id is string => !!id),
    );
    expect(new Set(engine.sessionIds())).toEqual(expectedSessions);

    for (const sessionId of expectedSessions) {
      const expectedAgents = new Set(
        payloads
          .filter((p) => p.session_id === sessionId && 'agent_id' in p)
          .map((p) => p.agent_id)
          .filter((id): id is string => typeof id === 'string'),
      );
      const snapshot = engine.snapshot(sessionId);
      expect(snapshot).toBeDefined();
      const seen = new Set(
        (snapshot?.subagents ?? []).map((a) => a.agentId ?? ''),
      );
      expect(seen).toEqual(expectedAgents);
    }
  });

  it('derives each agent status from that agent last event in the capture', () => {
    const { engine } = replay();
    const sessionId = payloads[0]?.session_id ?? '';
    const snapshot = engine.snapshot(sessionId);
    expect(snapshot).toBeDefined();
    if (!snapshot) return;

    // Main thread: the last payload with NO agent_id key.
    const mainEvents = payloads.filter(
      (p) => p.session_id === sessionId && !('agent_id' in p),
    );
    const lastMain = mainEvents[mainEvents.length - 1];
    expect(lastMain).toBeDefined();
    expect(snapshot.main.status).toBe(
      lastMain?.hook_event_name === 'Stop' ? 'done' : 'running',
    );

    // Each subagent: the last payload carrying its id.
    for (const agent of snapshot.subagents) {
      const own = payloads.filter(
        (p) => p.session_id === sessionId && p.agent_id === agent.agentId,
      );
      const last = own[own.length - 1];
      expect(agent.status).toBe(
        last?.hook_event_name === 'SubagentStop' ? 'done' : 'running',
      );
    }
  });

  it('reports the capture as live at capture time and stale later', () => {
    const { engine, lastAt } = replay();
    const sessionId = payloads[0]?.session_id ?? '';
    expect(engine.livenessOf(sessionId)).toBe('live');

    const stale = new LivenessEngine({
      now: () => lastAt + DEFAULT_MTIME_THRESHOLD_MS + 1,
    });
    const base = 1_700_000_000_000;
    stale.ingestAll(payloads.map((p, i) => ev(p, base + i * 1000)));
    expect(stale.livenessOf(sessionId)).not.toBe('live');
  });

  it('carries the SubagentStop transcript pointer through to the snapshot', () => {
    const { engine } = replay();
    const withPointer = payloads.filter(
      (p) =>
        p.hook_event_name === 'SubagentStop' &&
        typeof p['agent_transcript_path'] === 'string',
    );
    for (const payload of withPointer) {
      const snapshot = engine.snapshot(payload.session_id ?? '');
      const agent = snapshot?.subagents.find(
        (a) => a.agentId === payload.agent_id,
      );
      expect(agent?.agentTranscriptPath).toBe(payload['agent_transcript_path']);
    }
  });

  it('never invents a main-thread agent id from the capture', () => {
    const { engine } = replay();
    for (const snapshot of engine.snapshotAll()) {
      expect(snapshot.main.isMainThread).toBe(true);
      expect('agentId' in snapshot.main).toBe(false);
      for (const agent of snapshot.subagents) {
        expect(agent.isMainThread).toBe(false);
        expect(typeof agent.agentId).toBe('string');
        expect(agent.agentId).not.toBe('main');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// main-thread attribution — the sharp one
// ---------------------------------------------------------------------------

describe('main-thread vs subagent attribution', () => {
  it('ends only the named subagent on SubagentStop and leaves main alive', () => {
    const engine = new LivenessEngine({ now: () => 5_000 });
    engine.ingest(ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), 1_000));
    engine.ingest(ev(subPayload('SubagentStart', 'agentA'), 1_100));
    engine.ingest(ev(subPayload('SubagentStart', 'agentB'), 1_200));
    engine.ingest(
      ev(subPayload('PreToolUse', 'agentA', { tool_use_id: 't2' }), 1_300),
    );
    engine.ingest(ev(subPayload('SubagentStop', 'agentA'), 1_400));

    const snapshot = engine.snapshot(SESSION);
    expect(snapshot).toBeDefined();
    expect(snapshot?.main.status).toBe('running');
    expect(
      snapshot?.subagents.find((a) => a.agentId === 'agentA')?.status,
    ).toBe('done');
    expect(
      snapshot?.subagents.find((a) => a.agentId === 'agentB')?.status,
    ).toBe('running');
    expect(snapshot?.liveness).toBe('live');
  });

  it('ends the main agent on Stop, which carries no agent_id', () => {
    const engine = new LivenessEngine({ now: () => 5_000 });
    engine.ingest(ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), 1_000));
    engine.ingest(ev(subPayload('SubagentStart', 'agentA'), 1_100));
    engine.ingest(ev(subPayload('SubagentStop', 'agentA'), 1_200));
    engine.ingest(ev(mainPayload('Stop'), 1_300));

    const snapshot = engine.snapshot(SESSION);
    expect(snapshot?.main.status).toBe('done');
    expect(snapshot?.main.endedAt).toBe(1_300);
    expect(
      snapshot?.subagents.find((a) => a.agentId === 'agentA')?.status,
    ).toBe('done');
    // Nothing running, but activity is recent: neither live nor ended.
    expect(snapshot?.liveness).toBe('idle');
    expect(snapshot?.runningAgentCount).toBe(0);
  });

  it('does not end a subagent when the main thread stops', () => {
    const engine = new LivenessEngine({ now: () => 5_000 });
    engine.ingest(ev(subPayload('SubagentStart', 'agentA'), 1_000));
    engine.ingest(ev(mainPayload('Stop'), 1_100));

    const snapshot = engine.snapshot(SESSION);
    expect(snapshot?.main.status).toBe('done');
    expect(
      snapshot?.subagents.find((a) => a.agentId === 'agentA')?.status,
    ).toBe('running');
    // A running subagent keeps the session live even with main stopped.
    expect(snapshot?.liveness).toBe('live');
  });

  it('reopens the main agent when a new turn starts after Stop', () => {
    const engine = new LivenessEngine({ now: () => 5_000 });
    engine.ingest(ev(mainPayload('Stop'), 1_000));
    // Orphan: no session existed yet, so that Stop was dropped.
    expect(engine.hasSession(SESSION)).toBe(false);

    engine.ingest(ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), 1_100));
    engine.ingest(ev(mainPayload('Stop'), 1_200));
    expect(engine.snapshot(SESSION)?.main.status).toBe('done');

    engine.ingest(ev(mainPayload('PreToolUse', { tool_use_id: 't2' }), 1_300));
    const snapshot = engine.snapshot(SESSION);
    expect(snapshot?.main.status).toBe('running');
    expect(snapshot?.main.endedAt).toBeUndefined();
    expect(snapshot?.liveness).toBe('live');
  });

  it('tracks in-flight tool calls per agent, not per session', () => {
    const engine = new LivenessEngine({ now: () => 5_000 });
    engine.ingest(ev(mainPayload('PreToolUse', { tool_use_id: 'm1' }), 1_000));
    engine.ingest(
      ev(subPayload('PreToolUse', 'agentA', { tool_use_id: 's1' }), 1_100),
    );
    engine.ingest(
      ev(subPayload('PostToolUse', 'agentA', { tool_use_id: 's1' }), 1_200),
    );

    const snapshot = engine.snapshot(SESSION);
    expect(snapshot?.main.activeToolUseIds).toEqual(['m1']);
    expect(
      snapshot?.subagents.find((a) => a.agentId === 'agentA')
        ?.activeToolUseIds,
    ).toEqual([]);
  });

  it('records agent_type from the events that carry it', () => {
    const engine = new LivenessEngine({ now: () => 5_000 });
    engine.ingest(
      ev(
        subPayload('SubagentStart', 'agentA', {
          agent_type: 'phase-implementer',
        }),
        1_000,
      ),
    );
    expect(
      engine.snapshot(SESSION)?.subagents[0]?.agentType,
    ).toBe('phase-implementer');
  });
});

// ---------------------------------------------------------------------------
// R3: liveness never requires SessionStart
// ---------------------------------------------------------------------------

describe('SessionStart is never required', () => {
  it('becomes live from a stream that begins at PreToolUse', () => {
    const engine = new LivenessEngine({ now: () => 2_000 });
    const stream = [
      mainPayload('PreToolUse', { tool_use_id: 't1' }),
      mainPayload('PostToolUse', { tool_use_id: 't1' }),
    ];
    expect(
      stream.some((p) => p.hook_event_name === 'SessionStart'),
    ).toBe(false);

    stream.forEach((p, i) => engine.ingest(ev(p, 1_000 + i)));

    const snapshot = engine.snapshot(SESSION);
    expect(snapshot?.liveness).toBe('live');
    expect(snapshot?.main.status).toBe('running');
    expect(snapshot?.main.startedAt).toBe(1_000);
  });

  it('becomes live from a stream that begins at SubagentStart', () => {
    const engine = new LivenessEngine({ now: () => 2_000 });
    engine.ingest(ev(subPayload('SubagentStart', 'agentA'), 1_000));
    expect(engine.livenessOf(SESSION)).toBe('live');
  });

  it('becomes live from SessionStart, and counts it as CONFIRMED', () => {
    const engine = new LivenessEngine({ now: () => 2_000 });
    engine.ingest(ev(mainPayload('SessionStart'), 1_000));
    expect(engine.livenessOf(SESSION)).toBe('live');
    const counters = engine.counters();
    expect(counters.eventsApplied).toBe(1);
    // Superseded: this used to expect 1. SessionStart was unmeasured only
    // because every earlier capture bound its listener mid-session, and the
    // event fires at session onset.
    expect(counters.unconfirmedNameEvents).toBe(0);
    expect(counters.eventsSkippedUnknownName).toBe(0);
  });

  it('REGRESSION: replaying the real onset capture leaves every counter clean', async () => {
    // The behavioural consequence of the promotion, driven by committed bytes
    // rather than a hand-written payload (G6). unconfirmedNameEvents exists to
    // flag a name CC has never been measured sending; if an ordinary
    // SessionStart tripped it, the drift signal would fire on every session
    // and be ignored. Count derived from the file, never hard-coded.
    const payloads = await readSessionStartPayloads();
    expect(payloads.length).toBeGreaterThan(0);

    const engine = new LivenessEngine({ now: () => 2_000 });
    payloads.forEach((p, i) => {
      engine.ingest(ev(p, 1_000 + i));
    });

    const counters = engine.counters();
    expect(counters.eventsReceived).toBe(payloads.length);
    expect(counters.eventsApplied).toBe(payloads.length);
    expect(counters.unconfirmedNameEvents).toBe(0);
    expect(counters.eventsSkippedUnknownName).toBe(0);
    expect(counters.eventsSkippedNoSession).toBe(0);
    expect(counters.eventsSkippedUnattributable).toBe(0);
    expect(counters.ingestErrors).toBe(0);

    // Each captured onset opens its own session, main thread only: the
    // payload carries no agent_id key, and none is invented.
    const expectedSessions = new Set(payloads.map((p) => p.session_id));
    expect(new Set(engine.sessionIds())).toEqual(expectedSessions);
    for (const sessionId of engine.sessionIds()) {
      const snapshot = engine.snapshot(sessionId);
      expect(snapshot?.liveness).toBe('live');
      expect(snapshot?.main.isMainThread).toBe(true);
      expect(snapshot?.subagents).toHaveLength(0);
      expect('agentId' in (snapshot?.main ?? {})).toBe(false);
    }
  });

  it('still counts a genuinely unmeasured name as unconfirmed', () => {
    // The mechanism must keep working now that the known-but-unconfirmed list
    // is empty: an unknown name is skipped and counted, never fatal (G3).
    const engine = new LivenessEngine({ now: () => 2_000 });
    engine.ingest(ev(mainPayload('SomeFutureHook'), 1_000));
    const counters = engine.counters();
    expect(counters.eventsSkippedUnknownName).toBe(1);
    expect(counters.eventsApplied).toBe(0);
    expect(counters.ingestErrors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// degraded flag
// ---------------------------------------------------------------------------

describe('degraded flag', () => {
  it('is set with a reason before any hook event arrives', () => {
    const engine = new LivenessEngine({ now: () => 1_000 });
    expect(engine.isDegraded()).toBe(true);
    expect(engine.degradedState()).toEqual({
      degraded: true,
      reason: 'noHookEvents',
    });
  });

  it('is cleared by the first hook event', () => {
    const engine = new LivenessEngine({ now: () => 1_000 });
    engine.ingest(ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), 900));
    expect(engine.isDegraded()).toBe(false);
    expect(engine.degradedState().reason).toBeUndefined();
    expect(engine.snapshot(SESSION)?.degraded).toBe(false);
  });

  it('stays set per session for sessions no hook event ever named', () => {
    const engine = new LivenessEngine({ now: () => 1_000 });
    engine.ingest(ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), 900));
    engine.observeJsonl('other-session', { mtimeMs: 950 });

    expect(engine.isDegraded()).toBe(false);
    expect(engine.snapshot(SESSION)?.degraded).toBe(false);
    const other = engine.snapshot('other-session');
    expect(other?.degraded).toBe(true);
    expect(other?.degradedReason).toBe('noHookEvents');
    expect(other?.hookEventCount).toBe(0);
  });

  it('is forced by a listener that is known to be down, events or not', () => {
    const engine = new LivenessEngine({ now: () => 1_000 });
    engine.ingest(ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), 900));
    engine.setHookListenerRunning(false);
    expect(engine.degradedState()).toEqual({
      degraded: true,
      reason: 'listenerDown',
    });
    expect(engine.snapshot(SESSION)?.degradedReason).toBe('listenerDown');

    engine.setHookListenerRunning(true);
    expect(engine.isDegraded()).toBe(false);
  });

  it('still derives state from mtime alone while degraded', () => {
    const now = 1_000_000;
    const engine = new LivenessEngine({
      now: () => now,
      mtimeThresholdMs: 10_000,
      hookListenerRunning: false,
    });

    engine.observeJsonl('fresh', { mtimeMs: now - 1_000 });
    engine.observeJsonl('quiet', { mtimeMs: now - 50_000 });
    engine.observeJsonl('stopped-recently', {
      mtimeMs: now - 1_000,
      hasStopEntry: true,
    });
    engine.observeJsonl('stopped-long-ago', {
      mtimeMs: now - 50_000,
      hasStopEntry: true,
    });

    expect(engine.isDegraded()).toBe(true);
    // running (no Stop entry) + recent mtime
    expect(engine.livenessOf('fresh')).toBe('live');
    // running but stale
    expect(engine.livenessOf('quiet')).toBe('idle');
    // stopped but recent
    expect(engine.livenessOf('stopped-recently')).toBe('idle');
    // stopped and stale
    expect(engine.livenessOf('stopped-long-ago')).toBe('ended');
  });

  it('lets hook state override a stale Stop entry once hooks arrive', () => {
    const now = 1_000_000;
    const engine = new LivenessEngine({ now: () => now });
    engine.observeJsonl(SESSION, { mtimeMs: now - 1_000, hasStopEntry: true });
    expect(engine.livenessOf(SESSION)).toBe('idle');

    engine.ingest(ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), now - 5));
    expect(engine.livenessOf(SESSION)).toBe('live');
    expect(engine.snapshot(SESSION)?.hasStopEntry).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mtime threshold
// ---------------------------------------------------------------------------

describe('mtime recency threshold', () => {
  it('defaults to 120 seconds', () => {
    expect(DEFAULT_MTIME_THRESHOLD_MS).toBe(120_000);
    expect(new LivenessEngine().mtimeThresholdMs).toBe(120_000);
  });

  it('honours the default boundary exactly, with an injected clock', () => {
    const at = 1_000_000;
    const build = (now: number): LivenessEngine => {
      const engine = new LivenessEngine({ now: () => now });
      engine.ingest(ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), at));
      return engine;
    };
    expect(build(at + DEFAULT_MTIME_THRESHOLD_MS).livenessOf(SESSION)).toBe(
      'live',
    );
    expect(build(at + DEFAULT_MTIME_THRESHOLD_MS + 1).livenessOf(SESSION)).toBe(
      'idle',
    );
  });

  it('honours a configured threshold at construction', () => {
    const at = 1_000_000;
    const build = (now: number): LivenessEngine => {
      const engine = new LivenessEngine({
        now: () => now,
        mtimeThresholdMs: 5_000,
      });
      engine.ingest(ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), at));
      return engine;
    };
    expect(build(at + 5_000).livenessOf(SESSION)).toBe('live');
    expect(build(at + 5_001).livenessOf(SESSION)).toBe('idle');
    // The same instant is live under the default threshold: the value, not the
    // clock, is what changed.
    expect(
      build(at + 5_001).mtimeThresholdMs,
    ).toBe(5_000);
  });

  it('is reconfigurable at runtime', () => {
    let now = 1_000_000;
    const engine = new LivenessEngine({
      now: () => now,
      mtimeThresholdMs: 5_000,
    });
    engine.ingest(ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), now));

    now += 60_000;
    expect(engine.livenessOf(SESSION)).toBe('idle');
    engine.setMtimeThresholdMs(120_000);
    expect(engine.livenessOf(SESSION)).toBe('live');
    expect(engine.mtimeThresholdMs).toBe(120_000);

    // Nonsense values are refused rather than applied.
    engine.setMtimeThresholdMs(Number.NaN);
    engine.setMtimeThresholdMs(-1);
    expect(engine.mtimeThresholdMs).toBe(120_000);
  });

  it('takes the later of hook time and mtime as activity', () => {
    const now = 1_000_000;
    const engine = new LivenessEngine({
      now: () => now,
      mtimeThresholdMs: 10_000,
    });
    // Hook event is stale; the transcript was written a moment ago.
    engine.ingest(
      ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), now - 60_000),
    );
    engine.observeJsonl(SESSION, { mtimeMs: now - 1_000 });

    const snapshot = engine.snapshot(SESSION);
    expect(snapshot?.lastHookEventAt).toBe(now - 60_000);
    expect(snapshot?.lastActivityAt).toBe(now - 1_000);
    expect(snapshot?.liveness).toBe('live');
  });
});

// ---------------------------------------------------------------------------
// G2: JSONL inference is a degradable supplement
// ---------------------------------------------------------------------------

describe('G2 source separation', () => {
  it('keeps hook-driven liveness fully functional when inference throws', () => {
    const now = 1_000_000;
    const exploding: JsonlInferenceSource = () => {
      throw new Error('fingerprint mismatch: layout assertion failed');
    };
    const engine = new LivenessEngine({
      now: () => now,
      inferenceSource: exploding,
    });

    engine.ingest(
      ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), now - 1_000),
    );
    engine.ingest(ev(subPayload('SubagentStart', 'agentA'), now - 900));
    engine.ingest(ev(subPayload('SubagentStop', 'agentA'), now - 800));

    const snapshot = engine.snapshot(SESSION);
    expect(snapshot?.liveness).toBe('live');
    expect(snapshot?.main.status).toBe('running');
    expect(
      snapshot?.subagents.find((a) => a.agentId === 'agentA')?.status,
    ).toBe('done');
    expect(snapshot?.inferenceOk).toBe(false);
    expect(snapshot?.mtimeMs).toBeUndefined();
    expect(engine.counters().inferenceFailures).toBeGreaterThan(0);
    expect(engine.lastFailure()).toContain('fingerprint mismatch');

    // And it keeps updating afterwards.
    engine.ingest(ev(mainPayload('Stop'), now - 700));
    expect(engine.snapshot(SESSION)?.main.status).toBe('done');
    expect(engine.snapshot(SESSION)?.liveness).toBe('idle');
  });

  it('falls back to pushed inference when the pull source throws', () => {
    const now = 1_000_000;
    const engine = new LivenessEngine({
      now: () => now,
      mtimeThresholdMs: 10_000,
      inferenceSource: () => {
        throw new Error('boom');
      },
    });
    engine.observeJsonl(SESSION, { mtimeMs: now - 1_000 });
    expect(engine.livenessOf(SESSION)).toBe('live');
    expect(engine.snapshot(SESSION)?.mtimeMs).toBe(now - 1_000);
  });

  it('keeps hook state updating under an unsupported schema', () => {
    const now = 1_000_000;
    const engine = new LivenessEngine({ now: () => now });
    engine.ingest(
      ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), now - 100),
    );
    engine.setSchemaSupported(SESSION, false);

    let snapshot = engine.snapshot(SESSION);
    expect(snapshot?.liveness).toBe('unsupported');
    expect(snapshot?.schemaSupported).toBe(false);
    // Underneath, the hook tap is unaffected.
    expect(snapshot?.main.status).toBe('running');

    engine.ingest(ev(subPayload('SubagentStart', 'agentA'), now - 50));
    snapshot = engine.snapshot(SESSION);
    expect(snapshot?.subagents).toHaveLength(1);
    expect(snapshot?.liveness).toBe('unsupported');

    // Resolving the schema question reveals correct, already-current state.
    engine.setSchemaSupported(SESSION, true);
    expect(engine.livenessOf(SESSION)).toBe('live');
  });

  it('imports nothing from the parser', async () => {
    const source = await readFile(LIVENESS_SOURCE_PATH, 'utf8');
    const imports = source.match(/from\s+'[^']+'/g) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toContain('parser');
    }
    // No sockets, no filesystem of its own either (G1/G5).
    expect(source).not.toContain("'node:fs");
    expect(source).not.toContain("'node:http'");
    expect(source).not.toContain("'node:net'");
  });
});

// ---------------------------------------------------------------------------
// G3: never crash on input
// ---------------------------------------------------------------------------

describe('G3 malformed and unknown input', () => {
  it('counts and skips unknown event names without creating a session', () => {
    const engine = new LivenessEngine({ now: () => 1_000 });
    engine.ingest(ev({ hook_event_name: 'Frobnicate', session_id: SESSION }, 900));
    engine.ingest(ev({ session_id: SESSION }, 901));
    engine.ingest(ev({}, 902));

    expect(engine.counters().eventsSkippedUnknownName).toBe(3);
    expect(engine.counters().eventsApplied).toBe(0);
    expect(engine.hasSession(SESSION)).toBe(false);
    expect(engine.snapshotAll()).toEqual([]);
  });

  it('counts and skips events with no session id', () => {
    const engine = new LivenessEngine({ now: () => 1_000 });
    engine.ingest(ev({ hook_event_name: 'PreToolUse' }, 900));
    engine.ingest(ev({ hook_event_name: 'PreToolUse', session_id: '' }, 901));
    expect(engine.counters().eventsSkippedNoSession).toBe(2);
    expect(engine.sessionIds()).toEqual([]);
  });

  it('does not invent a session from a Stop it has never seen', () => {
    const engine = new LivenessEngine({ now: () => 1_000 });
    engine.ingest(ev(mainPayload('Stop'), 900));
    engine.ingest(ev(subPayload('SubagentStop', 'ghost'), 901));

    expect(engine.hasSession(SESSION)).toBe(false);
    expect(engine.snapshot(SESSION)).toBeUndefined();
    expect(engine.counters().eventsSkippedOrphanTerminal).toBe(2);
    expect(engine.counters().eventsApplied).toBe(0);
  });

  it('does not invent a subagent from a SubagentStop it has never seen', () => {
    const engine = new LivenessEngine({ now: () => 1_000 });
    engine.ingest(ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), 900));
    engine.ingest(ev(subPayload('SubagentStop', 'ghost'), 901));

    const snapshot = engine.snapshot(SESSION);
    expect(snapshot?.subagents).toEqual([]);
    expect(snapshot?.main.status).toBe('running');
    expect(engine.counters().eventsSkippedOrphanTerminal).toBe(1);
  });

  it('refuses to promote an unusable agent_id to the main thread', () => {
    const engine = new LivenessEngine({ now: () => 1_000 });
    const payload: RawHookPayload = {
      hook_event_name: 'PreToolUse',
      session_id: SESSION,
      agent_id: null as unknown as string,
    };
    const event = ev(payload, 900);
    expect(event.isMainThread).toBe(false);
    expect('agentId' in event).toBe(false);

    engine.ingest(event);
    expect(engine.counters().eventsSkippedUnattributable).toBe(1);
    expect(engine.hasSession(SESSION)).toBe(false);
  });

  it('survives events carrying junk in unknown keys', () => {
    const engine = new LivenessEngine({ now: () => 1_000 });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    engine.ingest(
      ev(
        mainPayload('PreToolUse', {
          tool_use_id: 't1',
          background_tasks: cyclic,
          duration_ms: Number.NaN,
          effort: [1, 2, 3],
        }),
        900,
      ),
    );
    expect(engine.counters().ingestErrors).toBe(0);
    expect(engine.livenessOf(SESSION)).toBe('live');
  });

  it('falls back to its own clock when receivedAt is not a number', () => {
    const engine = new LivenessEngine({ now: () => 2_000 });
    const event = ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), 1_000);
    (event as { receivedAt: unknown }).receivedAt = 'not a number';
    engine.ingest(event);
    expect(engine.snapshot(SESSION)?.lastHookEventAt).toBe(2_000);
  });

  it('exposes a pre-bound handler usable as a listener subscription', () => {
    const engine = new LivenessEngine({ now: () => 2_000 });
    const handler = engine.onHookEvent;
    handler(ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), 1_000));
    expect(engine.livenessOf(SESSION)).toBe('live');
  });
});

// ---------------------------------------------------------------------------
// DoD 4.11c — the write-side instant: bytes, not a timestamp
// ---------------------------------------------------------------------------

/**
 * `witnessedActivityAt` is what the local stats store may promote a session on,
 * and it is a NARROWER question than `lastActivityAt` answers.
 *
 * The store flooded three times through three readings of one signal. The last
 * of them: an mtime moves when a clone, a restore, a sync client, an indexer or
 * a virus scanner touches a transcript, and none of those is a session doing
 * work. So a mtime counts here only with appended BYTES behind it, while a hook
 * event always counts — the tap fires because a tool ran, and no filesystem
 * accident produces one.
 *
 * These are unit tests on the engine rather than host tests, deliberately: each
 * arm below is a single decision, and a `phase-verifier` proved the host tests
 * could not see three of them (dropping the hook instant left 252 tests green).
 */
describe('DoD 4.11c: an mtime is activity only with bytes behind it', () => {
  const NOW = 5_000_000;

  /** An engine whose transcript reports whatever this test says it does. */
  function engineOver(reads: { mtimeMs?: number; sizeBytes?: number }[]) {
    let index = 0;
    const engine = new LivenessEngine({
      now: () => NOW,
      mtimeThresholdMs: 10 * 60_000,
      inferenceSource: () => {
        const read = reads[Math.min(index, reads.length - 1)];
        index += 1;
        return read;
      },
    });
    // The session has to exist for the engine to have anything to report on,
    // and `observeJsonl` with no facts is how `SessionModel` announces one.
    engine.observeJsonl(SESSION, {});
    return engine;
  }

  it('the FIRST sighting is a baseline, so an untouched transcript is not activity', () => {
    const engine = engineOver([{ mtimeMs: NOW - 1_000, sizeBytes: 4_096 }]);
    const snapshot = engine.snapshot(SESSION);

    // The enum still sees a recent write — that half is untouched, and DoD 3.2b
    // and 4.9 depend on it.
    expect(snapshot?.lastActivityAt, 'the enum lost its instant').toBe(NOW - 1_000);
    expect(snapshot?.liveness).toBe('live');

    // The WRITE side sees nothing yet: the first size is the baseline.
    expect(snapshot?.sizeBytes).toBe(4_096);
    expect(snapshot?.transcriptGrew, 'the baseline claimed growth').toBe(false);
    expect(snapshot?.witnessedActivityAt, 'a baseline was read as activity').toBeUndefined();
  });

  it('APPENDED BYTES are activity; a touch of the same size is not', () => {
    // Read 1 latches 4,096. Read 2 is a TOUCH: the mtime jumps, the size does
    // not. Read 3 is an APPEND: both move.
    const engine = engineOver([
      { mtimeMs: NOW - 5_000, sizeBytes: 4_096 },
      { mtimeMs: NOW - 1_000, sizeBytes: 4_096 },
      { mtimeMs: NOW - 500, sizeBytes: 5_000 },
    ]);
    expect(engine.snapshot(SESSION)?.witnessedActivityAt).toBeUndefined();

    const touched = engine.snapshot(SESSION);
    expect(touched?.lastActivityAt, 'the touch did move the mtime').toBe(NOW - 1_000);
    expect(touched?.transcriptGrew).toBe(false);
    expect(touched?.witnessedActivityAt, 'a touched transcript was read as activity').toBeUndefined();

    const appended = engine.snapshot(SESSION);
    expect(appended?.transcriptGrew).toBe(true);
    expect(appended?.witnessedActivityAt, 'appended bytes were not read as activity').toBe(NOW - 500);
  });

  it('a HOOK EVENT is activity on its own, with no byte ever appended', () => {
    /*
     * THE MUTATION THIS KILLS, and a `phase-verifier` found it live: returning
     * only the growth-gated mtime from `witnessedActivityAt` — i.e. discarding
     * the hook instant — left **252 tests green**. The ruling's second clause is
     * "hook events unchanged and unconditional", and it is the clause that keeps
     * 4.11c's stated cost narrow: a working session fires a hook on every tool
     * call whether or not its transcript has been flushed to disk yet.
     */
    const engine = engineOver([{ mtimeMs: NOW - 90_000, sizeBytes: 4_096 }]);
    expect(engine.snapshot(SESSION)?.witnessedActivityAt).toBeUndefined();

    engine.ingest(ev(mainPayload('PreToolUse', { tool_use_id: 't1' }), NOW - 1_000));

    const snapshot = engine.snapshot(SESSION);
    expect(snapshot?.transcriptGrew, 'no byte was appended').toBe(false);
    expect(
      snapshot?.witnessedActivityAt,
      'a hook event was not read as activity',
    ).toBe(NOW - 1_000);
  });

  it('an UNKNOWN size fails CLOSED — an unanswerable question is not a yes', () => {
    // User ruling, 2026-09-10. A source that reports no size (an older reader, a
    // pushed inference, a stat that gave one number and not the other) leaves the
    // growth question unanswerable, and `undefined` must not read as `true`.
    const engine = engineOver([{ mtimeMs: NOW - 1_000 }]);
    const snapshot = engine.snapshot(SESSION);
    expect(snapshot?.lastActivityAt, 'the enum still has its instant').toBe(NOW - 1_000);
    expect(snapshot?.sizeBytes).toBeUndefined();
    expect(snapshot?.transcriptGrew, 'an unknown size answered the growth question').toBeUndefined();
    expect(snapshot?.witnessedActivityAt, 'an unknown size failed OPEN').toBeUndefined();
  });

  it('a SHRINK re-baselines, so a truncated transcript is not lost for a window', () => {
    /*
     * User ruling, 2026-09-10. Read 1 latches 40,000. Read 2 finds 1,000 — the
     * file was truncated, rotated, or rewritten in place. Against a stale
     * high-water mark the session would then be unpromotable until it passed
     * 40,000 bytes again, which is a WINDOW of lost records rather than one. The
     * baseline follows the shrink down, and the very next append counts.
     */
    const engine = engineOver([
      { mtimeMs: NOW - 5_000, sizeBytes: 40_000 },
      { mtimeMs: NOW - 4_000, sizeBytes: 1_000 },
      { mtimeMs: NOW - 3_000, sizeBytes: 1_200 },
    ]);
    expect(engine.snapshot(SESSION)?.witnessedActivityAt).toBeUndefined();

    const shrunk = engine.snapshot(SESSION);
    expect(shrunk?.sizeBytes).toBe(1_000);
    expect(shrunk?.transcriptGrew, 'a shrink was read as growth').toBe(false);
    expect(shrunk?.witnessedActivityAt).toBeUndefined();

    // 1,200 is far BELOW the original 40,000 and above the new baseline. Under a
    // high-water mark this assertion fails.
    const regrown = engine.snapshot(SESSION);
    expect(regrown?.transcriptGrew, 'growth from the new baseline was not seen').toBe(true);
    expect(regrown?.witnessedActivityAt).toBe(NOW - 3_000);
  });
});
