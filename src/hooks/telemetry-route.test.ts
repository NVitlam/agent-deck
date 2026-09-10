/**
 * v0.7.1 Phase 6, DoD 6.2 — the telemetry route, over a real loopback socket.
 *
 * Every body posted here is a `raw` field of `fixtures/otel-cc-2.1.260/` exactly
 * as captured, except where a row of the answer table needs a body the corpus
 * cannot supply (an empty one, a protobuf content type, one byte over the cap),
 * and those are built from a corpus body rather than invented. The listener is a
 * real `HookListener` bound on an ephemeral port — the TEST-ONLY affordance that
 * closes the free-port race — so what answers is the production request path.
 *
 * The answer table (locked ruling, 2026-09-10), asserted row by row:
 *
 *   non-POST                    405
 *   POST, content type not JSON 415
 *   POST, setting off           403 {"error":"agentDeck.telemetry.enabled is false"}
 *   JSON but not OTLP-shaped    400
 *   body over the 512 KiB cap   413
 *   accepted                    200 {}
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_BODY_BYTES,
  HookListener,
  TELEMETRY_DISABLED_BODY,
  TELEMETRY_PATHS,
  type TelemetryRouteCounters,
} from './listener.js';
import type { OtelSignal, TelemetrySlice } from '../otel/parse.js';
import { otelEnvelopes, postTo, type PostResult } from '../model/telemetry.testkit.js';

const live: HookListener[] = [];

afterEach(async () => {
  for (const listener of live.splice(0)) await listener.stop();
});

interface Harness {
  listener: HookListener;
  port: number;
  received: { signal: OtelSignal; slice: TelemetrySlice }[];
  setEnabled: (value: boolean) => void;
}

async function harness(options: { enabled?: boolean; spoofRemoteAddress?: string } = {}): Promise<Harness> {
  let enabled = options.enabled ?? true;
  const listener = new HookListener({
    port: 0,
    allowEphemeralPort: true,
    telemetryEnabled: () => enabled,
    ...(options.spoofRemoteAddress === undefined ? {} : { spoofRemoteAddress: options.spoofRemoteAddress }),
  });
  live.push(listener);
  const received: Harness['received'] = [];
  listener.subscribeOtel((signal, slice) => {
    received.push({ signal, slice });
  });
  await listener.start();
  const port = listener.address()?.port ?? 0;
  expect(port).toBeGreaterThan(0);
  return {
    listener,
    port,
    received,
    setEnabled: (value) => {
      enabled = value;
    },
  };
}

const ENVELOPES = otelEnvelopes();
const firstOf = (signal: OtelSignal): string => {
  const found = ENVELOPES.find((e) => e.signal === signal);
  if (found === undefined) throw new Error(`the corpus has no ${signal} body`);
  return found.raw;
};

/** Every figure on one signal's counters, flattened for exact comparison. */
function flat(counters: TelemetryRouteCounters): Record<string, number> {
  const out: Record<string, number> = {};
  for (const signal of ['metrics', 'logs', 'traces'] as const) {
    const c = counters[signal];
    out[`${signal}.accepted`] = c.accepted;
    out[`${signal}.disabled`] = c.disabled;
    for (const status of [400, 405, 413, 415] as const) out[`${signal}.${String(status)}`] = c.rejected[status];
  }
  return out;
}

/** Only the figures that moved. */
function moved(before: TelemetryRouteCounters, after: TelemetryRouteCounters): Record<string, number> {
  const a = flat(before);
  const b = flat(after);
  const out: Record<string, number> = {};
  for (const key of Object.keys(b)) {
    const delta = (b[key] ?? 0) - (a[key] ?? 0);
    if (delta !== 0) out[key] = delta;
  }
  return out;
}

describe('DoD 6.2 — 200: every captured body is accepted, parsed once and published', () => {
  it('replays all three signals from the corpus, in arrival order', async () => {
    const h = await harness();
    const statuses: PostResult[] = [];
    for (const envelope of ENVELOPES) {
      statuses.push(await postTo(h.port, TELEMETRY_PATHS[envelope.signal], envelope.raw));
    }
    // The control that this replays anything at all, per signal.
    const per = { metrics: 0, logs: 0, traces: 0 };
    for (const e of ENVELOPES) per[e.signal] += 1;
    expect(per.metrics).toBeGreaterThan(0);
    expect(per.logs).toBeGreaterThan(0);
    expect(per.traces).toBeGreaterThan(0);

    expect(statuses.every((r) => r.status === 200)).toBe(true);
    expect(new Set(statuses.map((r) => r.body))).toStrictEqual(new Set(['{}']));
    expect(statuses[0]?.contentType).toBe('application/json');

    // One published slice per accepted body, on the signal it arrived on.
    expect(h.received).toHaveLength(ENVELOPES.length);
    expect(h.received.map((r) => r.signal)).toStrictEqual(ENVELOPES.map((e) => e.signal));
    const counters = h.listener.telemetryCounters;
    expect(counters.metrics.accepted).toBe(per.metrics);
    expect(counters.logs.accepted).toBe(per.logs);
    expect(counters.traces.accepted).toBe(per.traces);

    // The slices carry the facts the join reads: the corpus's 40 tool spans
    // and 46 cost points (its README's census), and nothing unusable.
    const spans = h.received.flatMap((r) => r.slice.toolSpans);
    const costs = h.received.flatMap((r) => r.slice.costPoints);
    expect(spans).toHaveLength(40);
    expect(costs).toHaveLength(46);
    expect(h.received.every((r) => r.slice.counts.bodiesUnparseable === 0)).toBe(true);
    // The parse boundary ran on the route's input: identity attributes were
    // SEEN AND DROPPED, one per record, 850 records.
    const dropped = h.received.reduce((n, r) => n + r.slice.counts.identityAttributesDropped, 0);
    expect(dropped).toBe(850 * 5);

    // The event path's own accounting did not move: telemetry is not a hook.
    expect(h.listener.counters.accepted).toBe(0);
    expect(h.listener.counters.acceptedCodex).toBe(0);
  }, 60_000);

  it('accepts a JSON content type with parameters, and a +json suffix', async () => {
    const h = await harness();
    const body = firstOf('traces');
    expect((await postTo(h.port, TELEMETRY_PATHS.traces, body, { contentType: 'application/json; charset=utf-8' })).status).toBe(200);
    expect((await postTo(h.port, TELEMETRY_PATHS.traces, body, { contentType: 'Application/JSON' })).status).toBe(200);
    expect((await postTo(h.port, TELEMETRY_PATHS.traces, body, { contentType: 'application/vnd.otlp+json' })).status).toBe(200);
    expect(h.listener.telemetryCounters.traces.accepted).toBe(3);
  });

  it('every corpus body is well under the cap, so the cap refuses no real traffic', () => {
    // The ruling's measured maxima: metrics 10,222 · logs 21,266 · traces 20,882.
    const max = { metrics: 0, logs: 0, traces: 0 };
    for (const e of ENVELOPES) max[e.signal] = Math.max(max[e.signal], Buffer.byteLength(e.raw, 'utf8'));
    expect(max).toStrictEqual({ metrics: 10_222, logs: 21_266, traces: 20_882 });
    expect(Math.max(max.metrics, max.logs, max.traces)).toBeLessThan(DEFAULT_MAX_BODY_BYTES / 16);
  });
});

describe('DoD 6.2 — 405: any method but POST, whatever the setting', () => {
  it('answers 405 on GET, PUT, DELETE and OPTIONS, on and off', async () => {
    for (const enabled of [true, false]) {
      const h = await harness({ enabled });
      for (const signal of ['metrics', 'logs', 'traces'] as const) {
        for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
          const before = h.listener.telemetryCounters;
          const r = await postTo(h.port, TELEMETRY_PATHS[signal], method === 'GET' ? '' : firstOf(signal), { method });
          expect(r.status, `${method} ${signal} enabled=${String(enabled)}`).toBe(405);
          expect(moved(before, h.listener.telemetryCounters)).toStrictEqual({ [`${signal}.405`]: 1 });
        }
      }
      expect(h.received).toHaveLength(0);
    }
  });
});

describe('DoD 6.2 — 415: a POST that does not say it is JSON', () => {
  it('answers 415 on protobuf, on text, and on NO content type at all', async () => {
    const h = await harness();
    const body = firstOf('metrics');
    for (const contentType of ['application/x-protobuf', 'text/plain', null] as const) {
      const before = h.listener.telemetryCounters;
      const r = await postTo(h.port, TELEMETRY_PATHS.metrics, body, { contentType });
      expect(r.status, String(contentType)).toBe(415);
      expect(moved(before, h.listener.telemetryCounters)).toStrictEqual({ 'metrics.415': 1 });
    }
    // Stricter than the event path on purpose: the event path accepts an
    // absent header, this one does not. The control is that the SAME body with
    // the header is accepted.
    expect((await postTo(h.port, TELEMETRY_PATHS.metrics, body)).status).toBe(200);
    expect(h.received).toHaveLength(1);
  });

  it('checks the content type BEFORE the setting: protobuf while off is 415, not 403', async () => {
    const h = await harness({ enabled: false });
    const r = await postTo(h.port, TELEMETRY_PATHS.logs, firstOf('logs'), { contentType: 'application/x-protobuf' });
    expect(r.status).toBe(415);
    expect(h.listener.telemetryCounters.logs.disabled).toBe(0);
  });
});

describe('DoD 6.2 — 403: the setting is off (the shipped default)', () => {
  it('a listener built without the option refuses every signal with the named error', async () => {
    const listener = new HookListener({ port: 0, allowEphemeralPort: true });
    live.push(listener);
    const received: unknown[] = [];
    listener.subscribeOtel((signal, slice) => received.push({ signal, slice }));
    await listener.start();
    const port = listener.address()?.port ?? 0;
    for (const signal of ['metrics', 'logs', 'traces'] as const) {
      const r = await postTo(port, TELEMETRY_PATHS[signal], firstOf(signal));
      expect(r.status, signal).toBe(403);
      expect(r.body).toBe(TELEMETRY_DISABLED_BODY);
      expect(JSON.parse(r.body)).toStrictEqual({ error: 'agentDeck.telemetry.enabled is false' });
      expect(r.contentType).toBe('application/json');
      expect(listener.telemetryCounters[signal].disabled).toBe(1);
    }
    expect(received).toHaveLength(0);
  });

  it('parses NO body while off: malformed and oversize bodies are 403, not 400 or 413', async () => {
    const h = await harness({ enabled: false });
    expect((await postTo(h.port, TELEMETRY_PATHS.traces, '{ not json')).status).toBe(403);
    expect((await postTo(h.port, TELEMETRY_PATHS.traces, Buffer.alloc(DEFAULT_MAX_BODY_BYTES + 1, 0x20))).status).toBe(403);
    const t = h.listener.telemetryCounters.traces;
    expect(t.disabled).toBe(2);
    expect(t.rejected).toStrictEqual({ 400: 0, 405: 0, 413: 0, 415: 0 });
    expect(h.received).toHaveLength(0);
  });

  it('follows the setting per REQUEST: off, on, off — no rebind', async () => {
    const h = await harness({ enabled: false });
    const body = firstOf('traces');
    expect((await postTo(h.port, TELEMETRY_PATHS.traces, body)).status).toBe(403);
    h.setEnabled(true);
    expect((await postTo(h.port, TELEMETRY_PATHS.traces, body)).status).toBe(200);
    h.setEnabled(false);
    expect((await postTo(h.port, TELEMETRY_PATHS.traces, body)).status).toBe(403);
    expect(h.received).toHaveLength(1);
    expect(h.listener.telemetryCounters.traces).toMatchObject({ accepted: 1, disabled: 2 });
  });

  it('a setting thunk that throws reads as OFF, never as on', async () => {
    const listener = new HookListener({
      port: 0,
      allowEphemeralPort: true,
      telemetryEnabled: () => {
        throw new Error('settings unreadable');
      },
    });
    live.push(listener);
    await listener.start();
    const r = await postTo(listener.address()?.port ?? 0, TELEMETRY_PATHS.metrics, firstOf('metrics'));
    expect(r.status).toBe(403);
    expect(listener.listening).toBe(true);
  });
});

interface SlowReply {
  status: number;
  body: string;
  /** The answer (or a reset) came before the client had written its last byte. */
  answeredBeforeLastByte: boolean;
}

/**
 * POST half a body, pause, then the rest — and record whether the listener
 * answered before the last byte was written.
 *
 * The pause OPENS A WINDOW; it does not wait for anything to finish. A listener
 * that answers a refusal straight after the headers answers inside it, and this
 * reports `answeredBeforeLastByte: true` (or a reset). A listener that drains
 * first cannot answer until `end`, so the green outcome does not depend on the
 * pause's length at all. Found by the 20-run gate block: 2 of 20 runs read a
 * connection reset instead of the 403.
 */
async function slowPost(
  port: number,
  path: string,
  options: { method?: string; contentType?: string | null; size: number },
): Promise<SlowReply> {
  const bytes = Buffer.alloc(options.size, 0x20);
  const half = Math.floor(options.size / 2);
  const headers: Record<string, string | number> = { 'content-length': bytes.length, connection: 'close' };
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (contentType !== null) headers['content-type'] = contentType;
  const { request } = await import('node:http');
  return new Promise<SlowReply>((resolve) => {
    let lastByteWritten = false;
    const req = request(
      { host: '127.0.0.1', port, path, method: options.method ?? 'POST', agent: false, headers },
      (res) => {
        const early = !lastByteWritten;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), answeredBeforeLastByte: early });
        });
      },
    );
    req.on('error', () => {
      resolve({ status: -1, body: '', answeredBeforeLastByte: !lastByteWritten });
    });
    req.write(bytes.subarray(0, half));
    setTimeout(() => {
      if (req.destroyed) return;
      lastByteWritten = true;
      req.end(bytes.subarray(half));
    }, 250);
  });
}

describe('DoD 6.2 — a refusal drains the body first, so the refusal is what arrives', () => {
  it('403, 415 and 405 all answer only after the last byte, with the refusal intact', async () => {
    const off = await harness({ enabled: false });
    const disabled = await slowPost(off.port, TELEMETRY_PATHS.traces, { size: 256 * 1024 });
    expect(disabled).toStrictEqual({ status: 403, body: TELEMETRY_DISABLED_BODY, answeredBeforeLastByte: false });

    const on = await harness({ enabled: true });
    const protobuf = await slowPost(on.port, TELEMETRY_PATHS.metrics, {
      size: 256 * 1024,
      contentType: 'application/x-protobuf',
    });
    expect(protobuf).toStrictEqual({ status: 415, body: '', answeredBeforeLastByte: false });
    const put = await slowPost(on.port, TELEMETRY_PATHS.logs, { size: 256 * 1024, method: 'PUT' });
    expect(put).toStrictEqual({ status: 405, body: '', answeredBeforeLastByte: false });

    // Nothing was parsed or published on any of them.
    expect(off.received).toHaveLength(0);
    expect(on.received).toHaveLength(0);
  });
});

describe('DoD 6.2 — 400: JSON, but not an OTLP body for this path', () => {
  it('refuses empty, malformed, non-object, empty-object and wrong-signal bodies, and publishes none', async () => {
    const h = await harness();
    const cases: [OtelSignal, string][] = [
      ['traces', ''],
      ['traces', '{ not json'],
      ['metrics', '[]'],
      ['logs', 'null'],
      ['logs', '{}'],
      // A real traces body posted to the METRICS path: JSON, an object, and
      // OTLP — for another signal. The corpus's own bytes, on the wrong path.
      ['metrics', firstOf('traces')],
      ['traces', firstOf('logs')],
    ];
    for (const [signal, body] of cases) {
      const before = h.listener.telemetryCounters;
      const r = await postTo(h.port, TELEMETRY_PATHS[signal], body);
      expect(r.status, `${signal} ${body.slice(0, 20)}`).toBe(400);
      expect(moved(before, h.listener.telemetryCounters)).toStrictEqual({ [`${signal}.400`]: 1 });
    }
    expect(h.received).toHaveLength(0);
    // Control: an EMPTY but well-formed OTLP body is accepted — an exporter
    // with nothing to report is not a malformed one.
    expect((await postTo(h.port, TELEMETRY_PATHS.logs, '{"resourceLogs":[]}')).status).toBe(200);
  });
});

describe('DoD 6.2 — 413: the hooks cap, unchanged, at limit and limit+1', () => {
  /** A real corpus body, padded with JSON whitespace to exactly `size` bytes. */
  function padded(size: number): Buffer {
    const raw = Buffer.from(firstOf('traces'), 'utf8');
    expect(raw.length).toBeLessThan(size);
    return Buffer.concat([raw, Buffer.alloc(size - raw.length, 0x20)]);
  }

  it('accepts a body of exactly DEFAULT_MAX_BODY_BYTES and refuses one byte more', async () => {
    const h = await harness();
    const atLimit = await postTo(h.port, TELEMETRY_PATHS.traces, padded(DEFAULT_MAX_BODY_BYTES));
    expect(atLimit.status).toBe(200);
    const over = await postTo(h.port, TELEMETRY_PATHS.traces, padded(DEFAULT_MAX_BODY_BYTES + 1));
    expect(over.status).toBe(413);
    expect(h.listener.telemetryCounters.traces).toStrictEqual({
      accepted: 1,
      disabled: 0,
      rejected: { 400: 0, 405: 0, 413: 1, 415: 0 },
    });
    expect(h.received).toHaveLength(1);
    // The event path's oversize counter is its own and did not move.
    expect(h.listener.counters.oversize).toBe(0);
  });

  it('refuses limit+1 with NO declared length — the streaming guard, not the header one', async () => {
    const h = await harness();
    const r = await postTo(h.port, TELEMETRY_PATHS.metrics, padded(DEFAULT_MAX_BODY_BYTES + 1), { chunked: true });
    expect(r.status).toBe(413);
    expect(h.listener.telemetryCounters.metrics.rejected[413]).toBe(1);
    expect(h.received).toHaveLength(0);
    // And the listener still serves.
    expect((await postTo(h.port, TELEMETRY_PATHS.metrics, firstOf('metrics'))).status).toBe(200);
  });
});

describe('DoD 6.2 — the loopback drop comes BEFORE routing', () => {
  it('a non-loopback origin on a telemetry path is the plain 403 drop, counted as such and nowhere else', async () => {
    const h = await harness({ enabled: true, spoofRemoteAddress: '10.0.0.5' });
    for (const signal of ['metrics', 'logs', 'traces'] as const) {
      const r = await postTo(h.port, TELEMETRY_PATHS[signal], firstOf(signal));
      expect(r.status).toBe(403);
      // NOT the setting's 403: no body names the setting, because the path was
      // never read.
      expect(r.body).toBe('');
    }
    expect(h.listener.counters.droppedNonLoopback).toBe(3);
    expect(flat(h.listener.telemetryCounters)).toStrictEqual(flat({
      metrics: { accepted: 0, disabled: 0, rejected: { 400: 0, 405: 0, 413: 0, 415: 0 } },
      logs: { accepted: 0, disabled: 0, rejected: { 400: 0, 405: 0, 413: 0, 415: 0 } },
      traces: { accepted: 0, disabled: 0, rejected: { 400: 0, 405: 0, 413: 0, 415: 0 } },
    }));
    expect(h.received).toHaveLength(0);
  });
});

describe('DoD 6.2 — only the three paths are telemetry', () => {
  it('a neighbouring path is a plain 404 on the event path accounting', async () => {
    const h = await harness();
    for (const path of ['/v1/metric', '/v1/traces/', '/v1', '/v2/traces', '/V1/TRACES']) {
      const r = await postTo(h.port, path, firstOf('traces'));
      expect(r.status, path).toBe(404);
    }
    expect(h.listener.counters.badRoute).toBe(5);
    expect(h.received).toHaveLength(0);
  });

  it('the counters snapshot is a deep copy', async () => {
    const h = await harness();
    const snap = h.listener.telemetryCounters;
    snap.traces.accepted = 99;
    snap.traces.rejected[400] = 99;
    expect(h.listener.telemetryCounters.traces.accepted).toBe(0);
    expect(h.listener.telemetryCounters.traces.rejected[400]).toBe(0);
  });

  it('a consumer that throws is counted and the exporter still gets its 200', async () => {
    const h = await harness();
    h.listener.subscribeOtel(() => {
      throw new Error('consumer failure');
    });
    const r = await postTo(h.port, TELEMETRY_PATHS.traces, firstOf('traces'));
    expect(r.status).toBe(200);
    expect(h.listener.counters.handlerErrors).toBe(1);
    expect(h.received).toHaveLength(1);
  });
});
