/**
 * v0.7.0 Phase 1, DoD 1.9b/1.9c — the OTel parse boundary.
 *
 * Every body here is a REAL captured one, replayed from
 * `fixtures/otel-cc-2.1.260/`'s `raw` field, which stores the request body as
 * the exact string an HTTP receiver is handed. That is why the corpus stores it
 * as a string rather than as a nested object, and it is what lets this file
 * test the parse boundary with no socket anywhere.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  emptyTelemetryCounts,
  mergeSlices,
  parseOtlpBody,
  TELEMETRY_CONTENT_KEYS,
  TELEMETRY_IDENTITY_KEYS,
  type OtelSignal,
  type TelemetrySlice,
} from './parse.js';

const CORPUS = fileURLToPath(new URL('../../fixtures/otel-cc-2.1.260/', import.meta.url));

interface CapturedLine {
  signal: OtelSignal;
  raw: string;
}

function captured(signal: OtelSignal): CapturedLine[] {
  const text = readFileSync(`${CORPUS}${signal}.jsonl`, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CapturedLine)
    .filter((line) => line.signal === signal);
}

function sliceOf(signal: OtelSignal): TelemetrySlice {
  const counts = emptyTelemetryCounts();
  return mergeSlices(captured(signal).map((line) => parseOtlpBody(line.raw, signal, counts)));
}

describe('the corpus is really there, before anything is asserted about it', () => {
  it('carries all three signals, with bodies in each', () => {
    // Non-vacuity for the whole file: a missing corpus would otherwise make
    // every "no identity survived" assertion below pass over nothing.
    for (const signal of ['metrics', 'logs', 'traces'] as const) {
      expect(captured(signal).length, signal).toBeGreaterThan(0);
    }
  });
});

describe('DoD 1.9b — the five identity attributes are dropped at the boundary', () => {
  it('drops one of each per record, and COUNTS the drops', () => {
    for (const signal of ['metrics', 'logs', 'traces'] as const) {
      const slice = sliceOf(signal);
      // Rule 18: a drop that is not counted is indistinguishable from an input
      // that never arrived. Non-zero here is the NORMAL, healthy state.
      expect(slice.counts.identityAttributesDropped, signal).toBeGreaterThan(0);
    }
  });

  it('lets no attribute NAME and no placeholder VALUE survive into the slice', () => {
    // Both halves, because they fail differently: a name surviving means the
    // bag was copied wholesale, a value surviving means it was copied under a
    // different key.
    const placeholders = [
      'redacted@example.invalid',
      '0'.repeat(64),
      'user_' + '0'.repeat(26),
      '00000000-0000-0000-0000-000000000000',
      '00000000-0000-0000-0000-000000000001',
    ];

    for (const signal of ['metrics', 'logs', 'traces'] as const) {
      const serialized = JSON.stringify(sliceOf(signal));
      for (const key of TELEMETRY_IDENTITY_KEYS) {
        expect(serialized, `${signal}: ${key}`).not.toContain(key);
      }
      for (const value of placeholders) {
        expect(serialized, `${signal}: placeholder ${value.slice(0, 12)}`).not.toContain(value);
      }
    }
  });

  it('CONTROL: those placeholders really are in the raw bodies', () => {
    // Without this the assertion above is satisfied by a corpus that never
    // carried the attributes at all — this repository's most-recorded defect.
    const raw = captured('traces')
      .map((line) => line.raw)
      .join('\n');
    expect(raw).toContain('user.email');
    expect(raw).toContain('redacted@example.invalid');
    expect(raw).toContain('organization.id');
  });
});

describe('DoD 1.9c — content fields are dropped even when they carry real text', () => {
  it('drops prompt, response and user_prompt when they hold actual prose', () => {
    /*
     * THE POINT OF THIS TEST. In the corpus these three arrive as the literal
     * `"<REDACTED>"`, because four env flags were unset — and those flags are
     * the USER'S to set in their own settings.json. So a test over the corpus
     * alone would prove only that Claude Code redacted them, never that WE do.
     *
     * Real text is planted in each, in a body otherwise shaped exactly like a
     * captured one.
     */
    /*
     * Deliberately PROSE, with spaces, and not assigned to a name like
     * `secret`. The first version of this test read
     * `const secret = 'PLANTED-PROSE-that-must...'` and the privacy sweep
     * failed the gate on it: a long unbroken token in an assignment is exactly
     * the high-entropy credential shape it scans for. It was right to, so the
     * planted text is now unmistakably a sentence rather than a key.
     */
    const planted = 'planted prompt text that must never survive the boundary';
    const body = JSON.stringify({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: 'claude_code.api_request' },
                  attributes: [
                    { key: 'session.id', value: { stringValue: 'S' } },
                    { key: 'prompt', value: { stringValue: planted } },
                    { key: 'response', value: { stringValue: planted } },
                    { key: 'user_prompt', value: { stringValue: planted } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const slice = parseOtlpBody(body, 'logs');
    expect(JSON.stringify(slice)).not.toContain(planted);
    // Counted, all three, so the drop is visible rather than merely effective.
    expect(slice.counts.contentFieldsDropped).toBe(3);
    for (const key of TELEMETRY_CONTENT_KEYS) {
      expect(JSON.stringify(slice)).not.toContain(key);
    }
  });

  it('does not depend on the exporter having redacted anything', () => {
    // Same shape, on a span, where the fields would ride alongside a value we
    // DO keep — so this also proves the drop is per-attribute rather than
    // per-record.
    const planted = 'a second planted sentence, on a span this time';
    const body = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: 'claude_code.tool',
                  attributes: [
                    { key: 'session.id', value: { stringValue: 'S' } },
                    { key: 'tool_use_id', value: { stringValue: 'toolu_1' } },
                    { key: 'duration_ms', value: { asDouble: 5 } },
                    { key: 'prompt', value: { stringValue: planted } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const slice = parseOtlpBody(body, 'traces');
    expect(slice.toolSpans).toHaveLength(1);
    expect(slice.toolSpans[0]?.durationMs).toBe(5);
    expect(JSON.stringify(slice)).not.toContain(planted);
  });
});

describe('the allow-list keeps an attribute nobody has seen yet', () => {
  it('drops an unknown attribute without anyone adding a rule for it', () => {
    /*
     * The defence is an allow-list, not the identity DENY-list. A deny-list
     * covers what has been observed, and a producer that adds a new identifying
     * attribute tomorrow would sail straight through it. This is the assertion
     * that says the boundary is closed by default.
     */
    const body = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: 'claude_code.tool',
                  attributes: [
                    { key: 'session.id', value: { stringValue: 'S' } },
                    { key: 'tool_use_id', value: { stringValue: 'toolu_1' } },
                    { key: 'duration_ms', value: { asDouble: 1 } },
                    { key: 'user.phone_number', value: { stringValue: '+441234567890' } },
                    { key: 'something.new', value: { stringValue: 'whatever' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(parseOtlpBody(body, 'traces'));
    expect(serialized).not.toContain('+441234567890');
    expect(serialized).not.toContain('user.phone_number');
    expect(serialized).not.toContain('something.new');
  });
});

describe('what the corpus yields', () => {
  it('reads a tool span for every claude_code.tool span, with a duration', () => {
    const slice = sliceOf('traces');
    expect(slice.toolSpans.length).toBeGreaterThan(0);
    for (const span of slice.toolSpans) {
      expect(span.sessionId).not.toBe('');
      expect(span.toolUseId).not.toBe('');
      expect(Number.isFinite(span.durationMs)).toBe(true);
    }
  });

  it('reads agent_id on a MINORITY of spans, which is the correct shape', () => {
    // 4 of 40 — the two subagents' own tool calls. A main-thread call carries
    // none, so "spans carry agent_id" is the wrong sentence to remember, and a
    // consumer requiring it would drop every main-thread call.
    const spans = sliceOf('traces').toolSpans;
    const withAgent = spans.filter((s) => s.agentId !== undefined);
    expect(withAgent.length).toBeGreaterThan(0);
    expect(withAgent.length).toBeLessThan(spans.length);
  });

  it('reads cost points, and they are DELTA so they sum', () => {
    const points = sliceOf('metrics').costPoints;
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(point.sessionId).not.toBe('');
      expect(Number.isFinite(point.usd)).toBe(true);
    }
    // More than one point per session somewhere, or "they sum" is untested.
    const perSession = new Map<string, number>();
    for (const point of points) {
      perSession.set(point.sessionId, (perSession.get(point.sessionId) ?? 0) + 1);
    }
    expect([...perSession.values()].some((n) => n > 1)).toBe(true);
  });
});

describe('G3 — nothing here throws, whatever arrives', () => {
  it('counts a body that is not JSON and returns an empty slice', () => {
    const slice = parseOtlpBody('{ not json', 'traces');
    expect(slice.counts.bodiesUnparseable).toBe(1);
    expect(slice.toolSpans).toHaveLength(0);
  });

  it('counts a body that is JSON but not an object', () => {
    for (const body of ['[]', '"a string"', '42', 'null']) {
      const slice = parseOtlpBody(body, 'metrics');
      expect(slice.counts.bodiesUnparseable, body).toBe(1);
    }
  });

  it('never throws on a hostile or merely wrong shape', () => {
    const shapes = [
      '{}',
      '{"resourceSpans":null}',
      '{"resourceSpans":[{"scopeSpans":[{"spans":[null,1,"x"]}]}]}',
      '{"resourceSpans":[{"scopeSpans":[{"spans":[{"name":"claude_code.tool"}]}]}]}',
      '{"resourceMetrics":[{"scopeMetrics":[{"metrics":[{"sum":{"dataPoints":[{}]}}]}]}]}',
      '{"__proto__":{"polluted":true}}',
    ];
    for (const body of shapes) {
      for (const signal of ['metrics', 'logs', 'traces'] as const) {
        expect(() => parseOtlpBody(body, signal), `${signal} ${body}`).not.toThrow();
      }
    }
    // The pollution attempt changed nothing.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('skips a span with no usable session.id or tool_use_id, and counts it', () => {
    const body = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: 'claude_code.tool',
                  attributes: [{ key: 'duration_ms', value: { asDouble: 3 } }],
                },
              ],
            },
          ],
        },
      ],
    });
    const slice = parseOtlpBody(body, 'traces');
    expect(slice.toolSpans).toHaveLength(0);
    expect(slice.counts.recordsUnusable).toBe(1);
  });

  it('reads ONLY claude_code.tool spans, not the two that measure other intervals', () => {
    // `tool.execution` and `tool.blocked_on_user` cover different intervals of
    // the same call. Reading them would report a duration the engine never
    // stated for the call as a whole.
    const body = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: 'claude_code.tool.execution',
                  attributes: [
                    { key: 'session.id', value: { stringValue: 'S' } },
                    { key: 'tool_use_id', value: { stringValue: 'toolu_1' } },
                    { key: 'duration_ms', value: { asDouble: 99 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parseOtlpBody(body, 'traces').toolSpans).toHaveLength(0);
  });
});
