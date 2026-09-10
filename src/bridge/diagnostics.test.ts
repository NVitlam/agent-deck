/**
 * The diagnostics channel — PLAN.md Phase 5.5, DoD 5.5.3.
 *
 * The DoD's assertion is "every listed event emits exactly one line, assert by
 * spy". `DIAGNOSTICS_EVENT_KINDS` is what makes that checkable rather than
 * reviewable: the test walks the union instead of trusting that someone found
 * every call site.
 *
 * The properties that are NOT about line contents matter as much:
 *
 *   - **Lazy.** No sink is created until the first line. An output channel
 *     made at activation puts an "Agent Deck" entry in every user's Output
 *     dropdown whether or not this extension has anything to say.
 *   - **Never auto-shown.** `show()` is reachable only from the
 *     `agentDeck.showDiagnostics` command. A liveness product that pops a log
 *     panel over your editor is worse than one that stays quiet.
 *   - **Never fatal.** A channel that cannot be created, or that throws on
 *     write, must not take the data path down (G2). Writing a diagnostic is
 *     never the thing that breaks the session being diagnosed.
 */

import { describe, expect, it } from 'vitest';

import {
  COUNTERS_INTERVAL_MS,
  DIAGNOSTICS_CHANNEL_NAME,
  DIAGNOSTICS_EVENT_KINDS,
  DiagnosticsChannel,
  MAX_DETAIL_CHARS,
  SHOW_DIAGNOSTICS_COMMAND,
  formatCounters,
  formatEvent,
} from './diagnostics.js';
import type {
  DiagnosticsCounters,
  DiagnosticsEvent,
  DiagnosticsSink,
  DiagnosticsTelemetry,
} from './diagnostics.js';

const AT = Date.parse('2026-08-27T12:00:00.000Z');

/**
 * v0.7.1 DoD 6.4. Every number distinct and non-zero, so the pinned line below
 * can only match if each figure landed in its own slot.
 */
const TELEMETRY_SAMPLE: DiagnosticsTelemetry = {
  metrics: { accepted: 21, disabled: 22, unmatched: 23, rejected: { 400: 24, 405: 25, 413: 26, 415: 27 } },
  logs: { accepted: 31, disabled: 32, unmatched: 33, rejected: { 400: 34, 405: 35, 413: 36, 415: 37 } },
  traces: { accepted: 41, disabled: 42, unmatched: 43, rejected: { 400: 44, 405: 45, 413: 46, 415: 47 } },
};

const TELEMETRY_SAMPLE_LINE =
  'otel.metrics=accepted:21,disabled:22,unmatched:23,400:24,405:25,413:26,415:27 ' +
  'otel.logs=accepted:31,disabled:32,unmatched:33,400:34,405:35,413:36,415:37 ' +
  'otel.traces=accepted:41,disabled:42,unmatched:43,400:44,405:45,413:46,415:47';

/** A spy sink. Records everything and can be made to fail on demand. */
function spySink(options: { throwOnWrite?: boolean } = {}): DiagnosticsSink & {
  lines: string[];
  shown: number;
  disposed: number;
} {
  const lines: string[] = [];
  return {
    lines,
    shown: 0,
    disposed: 0,
    appendLine(line: string): void {
      if (options.throwOnWrite === true) throw new Error('channel is gone');
      lines.push(line);
    },
    show(): void {
      this.shown += 1;
    },
    dispose(): void {
      this.disposed += 1;
    },
  };
}

function channelWith(sink: DiagnosticsSink, options: { failCreate?: boolean } = {}): DiagnosticsChannel {
  return new DiagnosticsChannel({
    createSink: () => {
      if (options.failCreate === true) throw new Error('no window');
      return sink;
    },
    now: () => AT,
  });
}

/** One instance of every event kind. Kept exhaustive by the assertion below. */
const SAMPLES: Record<DiagnosticsEvent['kind'], DiagnosticsEvent> = {
  sessionDiscovered: { kind: 'sessionDiscovered', sessionId: 's1', engine: 'cc' },
  sessionRemoved: { kind: 'sessionRemoved', sessionId: 's1', engine: 'opencode' },
  engineDegraded: { kind: 'engineDegraded', engine: 'opencode', reason: 'database missing' },
  sessionRefused: { kind: 'sessionRefused', sessionId: 's2', engine: 'cc', code: 'schemaMismatch' },
  graftRefused: {
    kind: 'graftRefused',
    sessionId: 's2',
    engine: 'cc',
    code: 'unsupportedVersion',
    at: 's2.jsonl:1',
    field: 'version',
    expected: '2.1.246',
    actual: '1.0',
  },
  transcriptSkipped: {
    kind: 'transcriptSkipped',
    engine: 'codex',
    file: 'rollout-2026-09-05T00-00-00-01a06400.jsonl',
    reason: 'oversize:83890435 limit=67108864',
  },
  listenerRole: { kind: 'listenerRole', role: 'follower', port: 47821 },
  hookListenerError: { kind: 'hookListenerError', detail: 'EADDRINUSE 47821' },
  hookNon2xx: { kind: 'hookNon2xx', status: 413, detail: 'payload too large' },
  patchFailure: { kind: 'patchFailure', sessionId: 's1', detail: 'no node with id x' },
  resyncRequest: { kind: 'resyncRequest', sessionId: 's1', reason: 'insertNode failed', failedOp: 'insertNode' },
  otelSpanUnmatched: { kind: 'otelSpanUnmatched', sessionId: 's1', toolUseId: 'toolu_01x' },
};

describe('otel span unmatched (v0.7.1, ruling 2026-09-11)', () => {
  it('writes the two join keys and nothing else, in a fixed format', () => {
    expect(formatEvent(SAMPLES.otelSpanUnmatched, '2026-08-27T12:00:00.000Z')).toBe(
      '2026-08-27T12:00:00.000Z otel span unmatched session=s1 tool_use_id=toolu_01x',
    );
  });

  it('clips both values: they arrived in an HTTP body', () => {
    const line = formatEvent(
      { kind: 'otelSpanUnmatched', sessionId: 'a\nb', toolUseId: 'x'.repeat(10_000) },
      '2026-08-27T12:00:00.000Z',
    );
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(10_000);
  });
});

describe('DiagnosticsChannel (DoD 5.5.3)', () => {
  it('the sample set covers every event kind, so the test below cannot go stale', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...DIAGNOSTICS_EVENT_KINDS].sort());
  });

  it('emits EXACTLY ONE line per listed event', () => {
    const sink = spySink();
    const channel = channelWith(sink);
    for (const kind of DIAGNOSTICS_EVENT_KINDS) {
      const before = sink.lines.length;
      channel.record(SAMPLES[kind]);
      expect(sink.lines.length - before).toBe(1);
    }
    expect(sink.lines).toHaveLength(DIAGNOSTICS_EVENT_KINDS.length);
    expect(channel.lineCount).toBe(DIAGNOSTICS_EVENT_KINDS.length);
    // Every line is stamped, single-line, and names its subject.
    for (const line of sink.lines) {
      expect(line.startsWith('2026-08-27T12:00:00.000Z ')).toBe(true);
      expect(line).not.toContain('\n');
    }
  });

  it('the counters line reports every counter the DoD names', () => {
    const counters: DiagnosticsCounters = {
      grafts: 12,
      graftRefusals: 1,
      graftErrors: 0,
      malformedLines: 3,
      unknownFields: 84,
      patchesSent: 107,
      patchesApplied: 107,
      patchesFailed: 2,
      resyncs: 1,
      ccSessions: 2,
      opencodeSessions: 1,
      codexSessions: 3,
      relayRole: 'leader',
      relayFollowers: 2,
      relayed: 17,
      relayReceived: 0,
      // v0.7.0 DoD 3.8. DISTINCT values, and not by accident: the loop below
      // asserts containment of each counter's value, which a zero satisfies
      // from any other field on the line. A counter fixture of all zeroes is
      // the vacuity shape this repository keeps recording.
      statsErrors: 5,
      storeMalformed: 9,
      statsDropped: 11,
      // v0.7.1 DoD 6.4 — distinct values again, for the same reason.
      telemetry: TELEMETRY_SAMPLE,
    };
    const line = formatCounters(counters, '2026-08-27T12:00:00.000Z');
    for (const key of Object.keys(counters)) {
      // `unknownFields`, `ccSessions`, `opencodeSessions` and `codexSessions`
      // are rendered under shorter labels; the rest appear verbatim. Asserted
      // by VALUE so a renamed label cannot silently drop a counter. The one
      // nested field has its own pinned form, below.
      if (key === 'telemetry') continue;
      expect(line).toContain(String(counters[key as keyof DiagnosticsCounters]));
    }
    expect(line).toContain(TELEMETRY_SAMPLE_LINE);
    expect(line).toContain('grafts=12');
    expect(line).toContain('resyncs=1');
    expect(line).toContain('cc=2');
    expect(line).toContain('opencode=1');
    expect(line).toContain('codex=3');
    // Phase 1b — the pinned format for the four relay fields (DoD 1b.7).
    expect(line).toContain('role=leader');
    expect(line).toContain('followers=2');
    expect(line).toContain('relayed=17');
    expect(line).toContain('received=0');
    // Phase 3 — the pinned format for the two store fields (DoD 3.8).
    expect(line).toContain('statsErrors=5');
    expect(line).toContain('storeMalformed=9');

    // AND THE OTHER ROLE, because `relayed` and `received` are what make a
    // leader's line distinguishable from a follower's, and one fixture can
    // only ever show one of them. Same counters, roles swapped.
    const asFollower = formatCounters(
      { ...counters, relayRole: 'follower', relayFollowers: 0, relayed: 0, relayReceived: 41 },
      '2026-08-27T12:00:00.000Z',
    );
    expect(asFollower).toContain('role=follower');
    expect(asFollower).toContain('followers=0');
    expect(asFollower).toContain('relayed=0');
    expect(asFollower).toContain('received=41');
    expect(asFollower).not.toBe(line);
  });

  it('appends the three telemetry fields AFTER statsDropped, so every older line is a prefix (DoD 6.4)', () => {
    const line = formatCounters(
      {
        grafts: 0, graftRefusals: 0, graftErrors: 0, malformedLines: 0, unknownFields: 0,
        patchesSent: 0, patchesApplied: 0, patchesFailed: 0, resyncs: 0,
        ccSessions: 0, opencodeSessions: 0, codexSessions: 0,
        relayRole: 'idle', relayFollowers: 0, relayed: 0, relayReceived: 0,
        statsErrors: 0, storeMalformed: 0, statsDropped: 7,
        telemetry: TELEMETRY_SAMPLE,
      },
      '2026-09-10T00:00:00.000Z',
    );
    // The whole tail, byte for byte: order, labels, separators, and the four
    // statuses by number.
    expect(line.endsWith(` statsDropped=7 ${TELEMETRY_SAMPLE_LINE}`)).toBe(true);
  });

  it('creates no sink until the first line', () => {
    let created = 0;
    const sink = spySink();
    const channel = new DiagnosticsChannel({
      createSink: () => {
        created += 1;
        return sink;
      },
      now: () => AT,
    });
    expect(created).toBe(0);
    expect(channel.opened).toBe(false);
    channel.record(SAMPLES.sessionDiscovered);
    expect(created).toBe(1);
    expect(channel.opened).toBe(true);
    channel.record(SAMPLES.sessionRemoved);
    expect(created).toBe(1);
  });

  it('never shows itself — only show() does, and only the command calls it', () => {
    const sink = spySink();
    const channel = channelWith(sink);
    for (const kind of DIAGNOSTICS_EVENT_KINDS) channel.record(SAMPLES[kind]);
    channel.recordCounters({
      grafts: 0,
      graftRefusals: 0,
      graftErrors: 0,
      malformedLines: 0,
      unknownFields: 0,
      patchesSent: 0,
      patchesApplied: 0,
      patchesFailed: 0,
      resyncs: 0,
      ccSessions: 0,
      relayRole: 'leader',
      relayFollowers: 0,
      relayed: 0,
      relayReceived: 0,
      opencodeSessions: 0,
      codexSessions: 0,
      statsErrors: 0,
      storeMalformed: 0,
      statsDropped: 0,
      telemetry: TELEMETRY_SAMPLE,
    });
    expect(sink.shown).toBe(0);
    channel.show();
    expect(sink.shown).toBe(1);
  });

  it('show() on a quiet window opens a channel that says so', () => {
    const sink = spySink();
    const channel = channelWith(sink);
    channel.show();
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toContain('nothing recorded yet');
    expect(sink.shown).toBe(1);
  });

  it('a sink that cannot be created is counted, never thrown (G2)', () => {
    const channel = channelWith(spySink(), { failCreate: true });
    expect(() => {
      channel.record(SAMPLES.patchFailure);
    }).not.toThrow();
    // The counter still moves, so "diagnostics are not reaching the user" is
    // itself observable rather than silent.
    expect(channel.lineCount).toBe(1);
    expect(channel.opened).toBe(false);
  });

  it('a sink that throws on write is survivable (G2)', () => {
    const channel = channelWith(spySink({ throwOnWrite: true }));
    expect(() => {
      channel.record(SAMPLES.hookListenerError);
    }).not.toThrow();
  });

  it('clips free text and strips newlines, at the writer as well as the guard', () => {
    const long = 'x'.repeat(MAX_DETAIL_CHARS + 50);
    const line = formatEvent(
      { kind: 'patchFailure', sessionId: 's', detail: `${long}\nsecond line` },
      '2026-08-27T12:00:00.000Z',
    );
    expect(line).not.toContain('\n');
    expect(line.endsWith('...')).toBe(true);
    // Bounded because the renderer composes some of these strings and a log a
    // party on the other side of a boundary can grow without limit is a
    // denial-of-service surface, not a diagnostic.
    expect(line.length).toBeLessThan(MAX_DETAIL_CHARS + 80);
  });

  it('dispose is idempotent and stops writing', () => {
    const sink = spySink();
    const channel = channelWith(sink);
    channel.record(SAMPLES.sessionDiscovered);
    channel.dispose();
    channel.dispose();
    expect(sink.disposed).toBe(1);
    channel.record(SAMPLES.sessionRemoved);
    expect(sink.lines).toHaveLength(1);
  });

  it('the constants the manifest and the host must agree on', () => {
    expect(DIAGNOSTICS_CHANNEL_NAME).toBe('Agent Deck');
    expect(SHOW_DIAGNOSTICS_COMMAND).toBe('agentDeck.showDiagnostics');
    expect(COUNTERS_INTERVAL_MS).toBe(60_000);
  });

  it('opens no socket and touches no filesystem — the module imports nothing', async () => {
    // G5 and G7 in the cheapest possible form: a module with no imports cannot
    // reach `net`, `dns`, `http` or `fs`. Asserted against the SOURCE, because
    // an import added later is exactly the regression this guards.
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, 'diagnostics.ts'), 'utf8');
    expect(/^\s*import\s/m.test(source)).toBe(false);
  });
});
