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
  metrics: { accepted: 21, disabled: 22, unmatched: 23, foreign: 28, rejected: { 400: 24, 405: 25, 413: 26, 415: 27 } },
  logs: { accepted: 31, disabled: 32, unmatched: 33, foreign: 38, rejected: { 400: 34, 405: 35, 413: 36, 415: 37 } },
  traces: { accepted: 41, disabled: 42, unmatched: 43, foreign: 48, rejected: { 400: 44, 405: 45, 413: 46, 415: 47 } },
};

const TELEMETRY_SAMPLE_LINE =
  'otel.metrics=accepted:21,disabled:22,unmatched:23,400:24,405:25,413:26,415:27,foreign:28 ' +
  'otel.logs=accepted:31,disabled:32,unmatched:33,400:34,405:35,413:36,415:37,foreign:38 ' +
  'otel.traces=accepted:41,disabled:42,unmatched:43,400:44,405:45,413:46,415:47,foreign:48 ' +
  'otel.unmatched-scope=(this window)';

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
  /*
   * A FORMATTER FIXTURE, and its `reason` is a string no path now produces.
   *
   * `oversize:<bytes> limit=<limit>` was the size gate refusing to open a large
   * transcript; v0.8.0 DoD 7.7 reads such a transcript as a head plus a tail
   * and reports it as `transcriptPartial` instead. It is kept rather than
   * re-pointed because `reason` is the one FREE-TEXT field on this event and
   * what these tests pin is the clipping and the line's shape — a reason with
   * a colon, a number and a space in it exercises that better than a fresh
   * one would, and swapping it would quietly reduce what the sample covers.
   * The reasons the engine does produce today are
   * `oversizeHeadUndecided:<bytes> limit=<limit> head=<head>` and `FileTail`'s
   * own open/read failures.
   */
  transcriptSkipped: {
    kind: 'transcriptSkipped',
    engine: 'codex',
    file: 'rollout-2026-09-05T00-00-00-01a06400.jsonl',
    reason: 'oversize:83890435 limit=67108864',
  },
  transcriptPartial: {
    kind: 'transcriptPartial',
    engine: 'codex',
    file: 'rollout-2026-09-05T00-00-00-01a06400.jsonl',
    readBytes: 17039360,
    totalBytes: 83890435,
    fragments: 1,
  },
  listenerRole: { kind: 'listenerRole', role: 'follower', port: 47821 },
  hookListenerError: { kind: 'hookListenerError', detail: 'EADDRINUSE 47821' },
  hookNon2xx: { kind: 'hookNon2xx', status: 413, detail: 'payload too large' },
  patchFailure: { kind: 'patchFailure', sessionId: 's1', detail: 'no node with id x' },
  resyncRequest: { kind: 'resyncRequest', sessionId: 's1', reason: 'insertNode failed', failedOp: 'insertNode' },
  otelSpanUnmatched: { kind: 'otelSpanUnmatched', sessionId: 's1', toolUseId: 'toolu_01x' },
  ccEnabledLate: { kind: 'ccEnabledLate', slug: 'c--ws-first-session' },
};

describe('cc enabled late (hotfix 0.8.1)', () => {
  it('names the slug, in a fixed format', () => {
    expect(formatEvent(SAMPLES.ccEnabledLate, '2026-09-15T12:00:00.000Z')).toBe(
      '2026-09-15T12:00:00.000Z cc enabled late slug=c--ws-first-session',
    );
  });

  it('holds the slug to one token, so it cannot forge a second key', () => {
    const line = formatEvent({ kind: 'ccEnabledLate', slug: 'a b\nslug=forged' }, '2026-09-15T12:00:00.000Z');
    expect(line).not.toContain('\n');
    expect(line.split(' slug=')).toHaveLength(2);
  });
});

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

  it('holds each value to one token, so a value cannot forge a second key', () => {
    const line = formatEvent(
      { kind: 'otelSpanUnmatched', sessionId: 's1 tool_use_id=forged', toolUseId: 'toolu_01x' },
      '2026-08-27T12:00:00.000Z',
    );
    // Exactly one space-separated `tool_use_id=` key; the forged one is glued to the session value.
    expect(line.split(' tool_use_id=')).toHaveLength(2);
    expect(line).toBe(
      '2026-08-27T12:00:00.000Z otel span unmatched session=s1_tool_use_id=forged tool_use_id=toolu_01x',
    );
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
      // v0.8.0 DoD 7.7 — a value nothing else on the line holds, so the
      // by-value loop below cannot be satisfied by another field.
      oversizePartial: 13,
      ccLateEnabled: 51,
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
        oversizePartial: 0,
        ccLateEnabled: 0,
      },
      '2026-09-10T00:00:00.000Z',
    );
    // The whole tail, byte for byte: order, labels, separators, and the four
    // statuses by number — up to the two fields appended after it in v0.8.0,
    // which is the prefix rule working rather than an exception to it.
    expect(line).toContain(` statsDropped=7 ${TELEMETRY_SAMPLE_LINE}`);
  });

  /*
   * v0.8.0 DoD 7.8 — the line carries `foreign` beside `unmatched`, and says
   * that `unmatched` is this window's.
   *
   * Pinned here as FORMAT only: what lands in each figure is the joiner's, and
   * `extension.telemetry.test.ts` drives that through the socket. What this
   * block can say, and what no host test says as cheaply, is that the two
   * figures reach the line in their own slots — a formatter that printed
   * `unmatched` into both would satisfy every host assertion about the
   * numbers.
   */
  it('carries foreign beside unmatched, each in its own slot, and names the scope (DoD 7.8)', () => {
    const line = formatCounters(
      {
        grafts: 0, graftRefusals: 0, graftErrors: 0, malformedLines: 0, unknownFields: 0,
        patchesSent: 0, patchesApplied: 0, patchesFailed: 0, resyncs: 0,
        ccSessions: 0, opencodeSessions: 0, codexSessions: 0,
        relayRole: 'idle', relayFollowers: 0, relayed: 0, relayReceived: 0,
        statsErrors: 0, storeMalformed: 0, statsDropped: 0,
        telemetry: TELEMETRY_SAMPLE,
        oversizePartial: 0,
        ccLateEnabled: 0,
      },
      '2026-09-13T00:00:00.000Z',
    );
    // The DoD's literal text, on the line.
    expect(line).toContain('(this window)');
    // Each signal's own pair, with both numbers distinct across all six slots
    // (21..48 in `TELEMETRY_SAMPLE`) so no figure can stand in for another.
    expect(line).toContain('otel.metrics=accepted:21,disabled:22,unmatched:23,400:24,405:25,413:26,415:27,foreign:28');
    expect(line).toContain('otel.logs=accepted:31,disabled:32,unmatched:33,400:34,405:35,413:36,415:37,foreign:38');
    expect(line).toContain('otel.traces=accepted:41,disabled:42,unmatched:43,400:44,405:45,413:46,415:47,foreign:48');

    /*
     * THE VACUITY CONTROL, and it is the one that matters here: the three
     * assertions above are satisfied by a formatter that reads `foreign` and
     * one that reads any OTHER field holding the same number. So move one
     * figure and nothing else, and watch exactly one token move.
     */
    const moved = formatCounters(
      {
        grafts: 0, graftRefusals: 0, graftErrors: 0, malformedLines: 0, unknownFields: 0,
        patchesSent: 0, patchesApplied: 0, patchesFailed: 0, resyncs: 0,
        ccSessions: 0, opencodeSessions: 0, codexSessions: 0,
        relayRole: 'idle', relayFollowers: 0, relayed: 0, relayReceived: 0,
        statsErrors: 0, storeMalformed: 0, statsDropped: 0,
        telemetry: { ...TELEMETRY_SAMPLE, traces: { ...TELEMETRY_SAMPLE.traces, foreign: 99 } },
        oversizePartial: 0,
        ccLateEnabled: 0,
      },
      '2026-09-13T00:00:00.000Z',
    );
    expect(moved).toContain('415:47,foreign:99');
    expect(moved).not.toContain('415:47,foreign:48');
    // ...and `unmatched` did NOT move with it, which is what proves the two
    // are read from two fields rather than from one.
    expect(moved).toContain('unmatched:43,400:44');
  });

  it('every 0.7.1 signal figure is still a prefix of the 0.8.0 one (DoD 7.8 appends)', () => {
    // The append-only rule, applied to the per-signal blob rather than to the
    // whole line: a figure quoted in a 0.7.1 evidence file or bug report is
    // still comparable field by field to one read off a 0.8.0 line.
    const before = 'accepted:41,disabled:42,unmatched:43,400:44,405:45,413:46,415:47';
    expect(TELEMETRY_SAMPLE_LINE).toContain(`otel.traces=${before},foreign:`);
  });

  /*
   * v0.8.0 DoD 7.7 — `transcript partial`, the line that replaced
   * `transcript skipped ... oversize`.
   */
  it('writes a partial transcript as one line carrying both byte figures', () => {
    expect(formatEvent(SAMPLES.transcriptPartial, '2026-09-13T12:00:00.000Z')).toBe(
      '2026-09-13T12:00:00.000Z transcript partial codex ' +
        'rollout-2026-09-05T00-00-00-01a06400.jsonl read=17039360 of=83890435 fragments=1',
    );
  });

  it('says PARTIAL rather than SKIPPED, which is the opposite claim', () => {
    const partial = formatEvent(SAMPLES.transcriptPartial, '2026-09-13T12:00:00.000Z');
    const skipped = formatEvent(SAMPLES.transcriptSkipped, '2026-09-13T12:00:00.000Z');
    expect(partial).toContain('transcript partial');
    expect(partial).not.toContain('transcript skipped');
    // And the other way, so this pair cannot both be satisfied by one string.
    expect(skipped).toContain('transcript skipped');
    expect(skipped).not.toContain('transcript partial');
  });

  it('clips the basename: it came off a filesystem this module does not control', () => {
    const line = formatEvent(
      {
        kind: 'transcriptPartial',
        engine: 'codex',
        file: 'r'.repeat(4000),
        readBytes: 17039360,
        totalBytes: 83890435,
        fragments: 1,
      },
      '2026-09-13T12:00:00.000Z',
    );
    expect(line.length).toBeLessThan(4000);
    // The clip did not eat the figures: they follow the name on the line.
    expect(line).toContain('read=17039360');
  });

  it('prints ccLateEnabled LAST on the counters line, from its own field (hotfix 0.8.1)', () => {
    const base = {
      grafts: 0, graftRefusals: 0, graftErrors: 0, malformedLines: 0, unknownFields: 0,
      patchesSent: 0, patchesApplied: 0, patchesFailed: 0, resyncs: 0,
      ccSessions: 0, opencodeSessions: 0, codexSessions: 0,
      relayRole: 'idle' as const, relayFollowers: 0, relayed: 0, relayReceived: 0,
      statsErrors: 0, storeMalformed: 0, statsDropped: 0,
      telemetry: TELEMETRY_SAMPLE,
      oversizePartial: 0,
      ccLateEnabled: 0,
    };
    const atZero = formatCounters(base, '2026-09-15T12:00:00.000Z');
    expect(atZero.endsWith(' oversizePartial=0 ccLateEnabled=0')).toBe(true);
    // Moved alone, so no other field can be standing in for it.
    const moved = formatCounters({ ...base, ccLateEnabled: 1 }, '2026-09-15T12:00:00.000Z');
    expect(moved.endsWith(' ccLateEnabled=1')).toBe(true);
    // Appended: the line before it is unchanged, so every 0.8.0 line is a prefix.
    expect(moved.slice(0, moved.lastIndexOf(' ccLateEnabled='))).toBe(
      atZero.slice(0, atZero.lastIndexOf(' ccLateEnabled=')),
    );
  });

  it('prints oversizePartial on the counters line, from its own field', () => {
    const base = {
      grafts: 0, graftRefusals: 0, graftErrors: 0, malformedLines: 0, unknownFields: 0,
      patchesSent: 0, patchesApplied: 0, patchesFailed: 0, resyncs: 0,
      ccSessions: 0, opencodeSessions: 0, codexSessions: 0,
      relayRole: 'idle' as const, relayFollowers: 0, relayed: 0, relayReceived: 0,
      statsErrors: 0, storeMalformed: 0, statsDropped: 0,
      telemetry: TELEMETRY_SAMPLE,
      oversizePartial: 0,
      ccLateEnabled: 0,
    };
    expect(formatCounters(base, '2026-09-13T12:00:00.000Z')).toContain('oversizePartial=0');
    // Moved alone, so no other field can be standing in for it — the same
    // control the `foreign` block above uses, for the same reason.
    const moved = formatCounters({ ...base, oversizePartial: 4 }, '2026-09-13T12:00:00.000Z');
    expect(moved).toContain('oversizePartial=4');
    expect(moved).not.toContain('oversizePartial=0');
    expect(moved).toContain('codex=0');
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
      oversizePartial: 0,
      ccLateEnabled: 0,
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
