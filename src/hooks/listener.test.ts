/**
 * Tests for the loopback hook-event listener.
 *
 * Two things these tests are careful about:
 *
 * - The non-loopback rejection path is exercised through the listener's
 *   TEST-ONLY `spoofRemoteAddress` option. No test ever binds a non-loopback
 *   socket — doing so would itself violate G5, and would make the suite
 *   unrunnable on a locked-down machine.
 * - Nothing derived from `fixtures/` is hard-coded. Counts come from reading
 *   the fixture, so the next harvest changes the expected numbers with the
 *   data instead of failing as a fake regression.
 */

import { Buffer } from 'node:buffer';
import { readdir, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFIRMED_HOOK_EVENT_NAMES,
  isConfirmedHookEventName,
  isKnownHookEventName,
  KNOWN_HOOK_EVENT_NAMES,
  type NormalizedHookEvent,
  type RawHookPayload,
} from '../model/events.js';
import {
  DEFAULT_EVENT_PATH,
  DEFAULT_HOOK_PORT,
  DEFAULT_MAX_BODY_BYTES,
  HOOK_LISTENER_HOST,
  HookListener,
  HookListenerBindError,
  isHookListenerBindError,
  isLoopbackAddress,
  normalizeHookEvent,
} from './listener.js';

const LOOPBACK = '127.0.0.1';

const LISTENER_SOURCE_PATH = fileURLToPath(
  new URL('./listener.ts', import.meta.url),
);
const EVENTS_SOURCE_PATH = fileURLToPath(
  new URL('../model/events.ts', import.meta.url),
);
const HOOK_FIXTURE_PATH = fileURLToPath(
  new URL(
    '../../fixtures/phase0-evidence/synthetic-hook-events.jsonl',
    import.meta.url,
  ),
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Ask the OS for a currently-free port, then release it.
 *
 * Production forbids ephemeral binding; tests may probe for one so that the
 * suite does not fight a real listener that may be bound to
 * {@link DEFAULT_HOOK_PORT} on the developer's machine.
 */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, LOOPBACK, () => {
      const addr = probe.address() as AddressInfo;
      const port = addr.port;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

interface HttpReply {
  status: number;
  body: string;
}

function postRaw(
  port: number,
  options: {
    path?: string;
    method?: string;
    body?: string | Buffer;
    headers?: Record<string, string | undefined>;
  } = {},
): Promise<HttpReply> {
  const method = options.method ?? 'POST';
  const path = options.path ?? DEFAULT_EVENT_PATH;
  const payload =
    options.body === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(options.body, 'utf8');

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    connection: 'close',
  };
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[key.toLowerCase()];
    else headers[key.toLowerCase()] = value;
  }

  return new Promise<HttpReply>((resolve, reject) => {
    // Several of these requests are answered early and the connection closed
    // under the client on purpose (403/404/405/415 before the body is read, and
    // stop() destroying keep-alive sockets). Both streams therefore need an
    // 'error' listener: an unhandled 'error' on the RESPONSE stream is an
    // uncaught exception that kills the vitest worker process outright, which
    // surfaces as an unrelated-looking "Channel closed / ERR_IPC_CHANNEL_CLOSED".
    // Late errors after the reply has been read are expected and ignored.
    let settled = false;
    const succeed = (reply: HttpReply): void => {
      if (settled) return;
      settled = true;
      resolve(reply);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = httpRequest(
      { host: LOOPBACK, port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('error', fail);
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          succeed({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', fail);
    req.setTimeout(5_000, () => {
      req.destroy(new Error('test client timeout'));
    });
    req.end(payload);
  });
}

function postJson(port: number, value: unknown): Promise<HttpReply> {
  return postRaw(port, { body: JSON.stringify(value) });
}

/** A minimal payload with no `agent_id` key at all — a main-thread event. */
function mainThreadPayload(): RawHookPayload {
  return {
    session_id: '9f1c2ad4-77b1-4e0e-9f3a-0b5c1d2e3f40',
    hook_event_name: 'Stop',
    stop_hook_active: false,
  };
}

async function readFixturePayloads(): Promise<RawHookPayload[]> {
  const text = await readFile(HOOK_FIXTURE_PATH, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawHookPayload);
}

// ---------------------------------------------------------------------------
// the loopback guard, as a unit
// ---------------------------------------------------------------------------

describe('isLoopbackAddress', () => {
  it('accepts the whole 127.0.0.0/8 block, ::1 and IPv4-mapped loopback', () => {
    for (const addr of [
      '127.0.0.1',
      '127.0.0.2',
      '127.1.2.3',
      '127.255.255.255',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      '::1%lo0',
      ' 127.0.0.1 ',
      '::FFFF:127.0.0.1',
    ]) {
      expect(isLoopbackAddress(addr), addr).toBe(true);
    }
  });

  it('rejects every off-loopback address and every non-string', () => {
    for (const addr of [
      '0.0.0.0',
      '10.0.0.1',
      '192.168.1.5',
      '203.0.113.7',
      '128.0.0.1',
      '126.255.255.255',
      '227.0.0.1',
      '2001:db8::1',
      'fe80::1%eth0',
      'localhost',
      '127.0.0.1.evil.com',
      '999.0.0.1',
      '',
    ]) {
      expect(isLoopbackAddress(addr), addr).toBe(false);
    }
    for (const value of [undefined, null, 0, 127, {}, [], true]) {
      expect(isLoopbackAddress(value)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// normalization: the correlation contract
// ---------------------------------------------------------------------------

describe('normalizeHookEvent — main-thread correlation rule', () => {
  it('attributes a payload with NO agent_id key to the main thread and omits agentId', () => {
    const event = normalizeHookEvent(mainThreadPayload());

    expect(event.isMainThread).toBe(true);
    // Not merely undefined: the key is absent, so nothing downstream can
    // mistake a default for something CC said.
    expect('agentId' in event).toBe(false);
    expect(event.agentId).toBeUndefined();
  });

  it('does NOT treat a literal agent_id value as the main thread', () => {
    // This payload is synthetic. CC has never been observed to send this value
    // for agent_id in any capture; the point of the test is that a correlator
    // which string-matched it would be wrong twice over — it would drop real
    // main-thread events (which have no key) and would swallow this subagent.
    const sentinel = 'ma' + 'in';
    const event = normalizeHookEvent({
      session_id: 's',
      hook_event_name: 'SubagentStop',
      agent_id: sentinel,
    });

    expect(event.isMainThread).toBe(false);
    expect(event.agentId).toBe(sentinel);
    expect('agentId' in event).toBe(true);
  });

  it('treats a present-but-unusable agent_id as an unattributable subagent, never as the main thread', () => {
    for (const value of [null, '', 0, {}, []]) {
      const event = normalizeHookEvent({
        session_id: 's',
        hook_event_name: 'SubagentStop',
        agent_id: value,
      } as unknown as RawHookPayload);

      // The key was present, so the main-thread signal (key absence) is absent.
      expect(event.isMainThread).toBe(false);
      expect('agentId' in event).toBe(false);
    }
  });

  it('does not let an inherited property masquerade as a present agent_id key', () => {
    const proto = { agent_id: 'inherited' };
    const payload = Object.create(proto) as RawHookPayload;
    payload.session_id = 's';
    payload.hook_event_name = 'Stop';

    const event = normalizeHookEvent(payload);
    expect(event.isMainThread).toBe(true);
    expect('agentId' in event).toBe(false);
  });

  it('carries the join keys through and preserves unknown keys in raw', () => {
    const event = normalizeHookEvent({
      session_id: 'sess-1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01BBB',
      transcript_path: 'C:\\x.jsonl',
      cwd: 'C:\\repo',
      agent_id: 'a17b3c9d',
      something_new_from_a_future_cc: 42,
    });

    expect(event.sessionId).toBe('sess-1');
    expect(event.toolUseId).toBe('toolu_01BBB');
    expect(event.toolName).toBe('Bash');
    expect(event.agentId).toBe('a17b3c9d');
    expect(event.isMainThread).toBe(false);
    expect(event.eventNameConfirmed).toBe(true);
    expect(event.raw['something_new_from_a_future_cc']).toBe(42);
  });

  it('never throws on a hostile or empty payload', () => {
    expect(() => normalizeHookEvent({} as RawHookPayload)).not.toThrow();
    expect(() =>
      normalizeHookEvent({
        hook_event_name: 12345,
        session_id: { nested: true },
        tool_use_id: [],
      } as unknown as RawHookPayload),
    ).not.toThrow();

    const junk = normalizeHookEvent({
      hook_event_name: 12345,
    } as unknown as RawHookPayload);
    expect('eventName' in junk).toBe(false);
    expect(junk.eventNameConfirmed).toBe(false);
    expect(junk.isMainThread).toBe(true);
  });
});

describe('confirmed vs unconfirmed hook event names', () => {
  it('marks the five measured names confirmed', () => {
    for (const name of CONFIRMED_HOOK_EVENT_NAMES) {
      expect(isConfirmedHookEventName(name), name).toBe(true);
      expect(normalizeHookEvent({ hook_event_name: name }).eventNameConfirmed).toBe(
        true,
      );
    }
    expect(CONFIRMED_HOOK_EVENT_NAMES).toContain('SubagentStart');
  });

  it('marks SessionStart known but NOT confirmed on the pinned CC version', () => {
    expect(isKnownHookEventName('SessionStart')).toBe(true);
    expect(isConfirmedHookEventName('SessionStart')).toBe(false);
    expect(KNOWN_HOOK_EVENT_NAMES).toContain('SessionStart');
  });

  it('accepts an entirely unknown name, flags it, and never throws', () => {
    const event = normalizeHookEvent({ hook_event_name: 'SomeFutureHook' });
    expect(event.eventName).toBe('SomeFutureHook');
    expect(event.eventNameConfirmed).toBe(false);
    expect(isKnownHookEventName('SomeFutureHook')).toBe(false);
  });
});

describe('SubagentStart payload shape', () => {
  // SEAM: this exercise uses a hand-written payload matching the key set
  // measured on 3/3 live SubagentStart events (session_id, transcript_path,
  // cwd, prompt_id, agent_id, agent_type, hook_event_name). The redacted
  // capture fixture is being produced separately and is not owned by this
  // package; when it lands under fixtures/, point this describe block at it
  // and delete the inline payload below. Do not paste raw capture data here —
  // the live capture carries verbatim tool_input content.
  const measuredKeySet = [
    'session_id',
    'transcript_path',
    'cwd',
    'prompt_id',
    'agent_id',
    'agent_type',
    'hook_event_name',
  ];

  function subagentStartPayload(): RawHookPayload {
    return {
      session_id: '9f1c2ad4-77b1-4e0e-9f3a-0b5c1d2e3f40',
      transcript_path: 'C:\\projects\\slug\\9f1c2ad4.jsonl',
      cwd: 'C:\\repo',
      prompt_id: '5b2e0d31-6c44-4f0a-9f11-77d0c9a5e112',
      agent_id: 'a1a53f42c5eca8824',
      agent_type: 'phase-implementer',
      hook_event_name: 'SubagentStart',
    };
  }

  it('normalizes with agentId present, no toolUseId, and a confirmed name', () => {
    const payload = subagentStartPayload();
    expect(Object.keys(payload).sort()).toEqual([...measuredKeySet].sort());

    const event = normalizeHookEvent(payload);
    expect(event.eventNameConfirmed).toBe(true);
    expect(event.isMainThread).toBe(false);
    expect(event.agentId).toBe('a1a53f42c5eca8824');
    // Confirmed absent on all 3 measured events: the parent tool_use join must
    // come from the JSONL sidecar's meta.toolUseId, never from this event.
    expect('toolUseId' in event).toBe(false);
    // prompt_id was not in any previously documented key set; it survives.
    expect(event.raw['prompt_id']).toBe('5b2e0d31-6c44-4f0a-9f11-77d0c9a5e112');
  });
});

// ---------------------------------------------------------------------------
// the synthetic fixture
// ---------------------------------------------------------------------------

describe('fixtures/phase0-evidence/synthetic-hook-events.jsonl', () => {
  it('every payload normalizes without throwing', async () => {
    const payloads = await readFixturePayloads();
    expect(payloads.length).toBeGreaterThan(0);

    const events: NormalizedHookEvent[] = [];
    for (const payload of payloads) {
      expect(() => events.push(normalizeHookEvent(payload))).not.toThrow();
    }
    expect(events).toHaveLength(payloads.length);
  });

  it('main-thread attribution over the fixture matches key absence exactly', async () => {
    const payloads = await readFixturePayloads();

    // Counts derived from the file, never hard-coded: a re-harvest changes the
    // data and the expectation together.
    const expectedMain = payloads.filter(
      (p) => !Object.prototype.hasOwnProperty.call(p, 'agent_id'),
    ).length;
    const expectedSub = payloads.length - expectedMain;

    // Guard against a vacuous fixture: the test only means something if both
    // kinds are present.
    expect(expectedMain).toBeGreaterThan(0);
    expect(expectedSub).toBeGreaterThan(0);

    const events = payloads.map((p) => normalizeHookEvent(p));
    expect(events.filter((e) => e.isMainThread)).toHaveLength(expectedMain);
    expect(events.filter((e) => !e.isMainThread)).toHaveLength(expectedSub);

    // No main-thread event carries an agent id under any name.
    for (const event of events.filter((e) => e.isMainThread)) {
      expect('agentId' in event).toBe(false);
    }
    for (const event of events.filter((e) => !e.isMainThread)) {
      expect(typeof event.agentId).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// the listener over a real loopback socket
// ---------------------------------------------------------------------------

describe('HookListener over a real loopback socket', () => {
  let listener: HookListener;
  let port: number;
  let received: NormalizedHookEvent[];

  beforeEach(async () => {
    port = await freePort();
    received = [];
    listener = new HookListener({
      port,
      maxBodyBytes: 4096,
      onEvent: (event) => {
        received.push(event);
      },
    });
    await listener.start();
  });

  afterEach(async () => {
    await listener.stop();
  });

  it('binds to the literal loopback address, never a wildcard', () => {
    const addr = listener.address();
    expect(addr).not.toBeNull();
    expect(addr?.address).toBe('127.0.0.1');
    expect(addr?.address).toBe(HOOK_LISTENER_HOST);
    expect(addr?.port).toBe(port);
    expect(listener.host).toBe('127.0.0.1');
    expect(listener.listening).toBe(true);
  });

  it('defaults to the fixed port 47821 without binding it', () => {
    const idle = new HookListener();
    expect(idle.port).toBe(47821);
    expect(idle.port).toBe(DEFAULT_HOOK_PORT);
    expect(idle.maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(idle.eventPath).toBe('/event');
    expect(idle.listening).toBe(false);
    expect(idle.address()).toBeNull();
  });

  it('accepts a well-formed payload and dispatches it to subscribers', async () => {
    const extra: NormalizedHookEvent[] = [];
    const unsubscribe = listener.subscribe((e) => extra.push(e));

    const reply = await postJson(port, {
      session_id: 'sess-1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01BBB',
      agent_id: 'a17b3c9d',
    });

    expect(reply.status).toBe(200);
    expect(listener.counters.accepted).toBe(1);
    expect(received).toHaveLength(1);
    expect(extra).toHaveLength(1);
    expect(received[0]?.seq).toBe(1);
    expect(received[0]?.agentId).toBe('a17b3c9d');
    expect(received[0]?.isMainThread).toBe(false);
    expect(received[0]?.receivedAt).toBeGreaterThan(0);

    unsubscribe();
    await postJson(port, mainThreadPayload());
    expect(received).toHaveLength(2);
    expect(extra).toHaveLength(1);
    expect(received[1]?.seq).toBe(2);
    expect(received[1]?.isMainThread).toBe(true);
  });

  it('accepts an unconfirmed event name, counts it, and marks it not-confirmed', async () => {
    const reply = await postJson(port, {
      session_id: 'sess-1',
      hook_event_name: 'SomeFutureHook',
    });

    expect(reply.status).toBe(200);
    expect(listener.counters.accepted).toBe(1);
    expect(listener.counters.unconfirmedEventName).toBe(1);
    expect(received[0]?.eventNameConfirmed).toBe(false);
    expect(received[0]?.eventName).toBe('SomeFutureHook');
  });

  it('accepts SubagentStart without counting it as unconfirmed', async () => {
    const reply = await postJson(port, {
      session_id: 'sess-1',
      hook_event_name: 'SubagentStart',
      agent_id: 'a1a53f42c5eca8824',
      agent_type: 'phase-implementer',
      prompt_id: '5b2e0d31-6c44-4f0a-9f11-77d0c9a5e112',
    });

    expect(reply.status).toBe(200);
    expect(listener.counters.unconfirmedEventName).toBe(0);
    expect(received[0]?.eventNameConfirmed).toBe(true);
    expect('toolUseId' in (received[0] ?? {})).toBe(false);
  });

  it('replays every fixture payload over the wire', async () => {
    const payloads = await readFixturePayloads();
    for (const payload of payloads) {
      const reply = await postJson(port, payload);
      expect(reply.status).toBe(200);
    }

    const expectedMain = payloads.filter(
      (p) => !Object.prototype.hasOwnProperty.call(p, 'agent_id'),
    ).length;
    const expectedUnconfirmed = payloads.filter(
      (p) => !isConfirmedHookEventName(p.hook_event_name),
    ).length;

    expect(listener.counters.accepted).toBe(payloads.length);
    expect(received).toHaveLength(payloads.length);
    expect(received.filter((e) => e.isMainThread)).toHaveLength(expectedMain);
    expect(listener.counters.unconfirmedEventName).toBe(expectedUnconfirmed);
    expect(received.map((e) => e.seq)).toEqual(
      payloads.map((_, index) => index + 1),
    );
  });

  it('drops a non-loopback POST with 403 and counts it', async () => {
    await listener.stop();
    listener = new HookListener({
      port,
      maxBodyBytes: 4096,
      // TEST-ONLY: makes the server believe the request came from an off-box
      // address. No non-loopback socket is ever bound by this suite.
      spoofRemoteAddress: '203.0.113.7',
      onEvent: (event) => received.push(event),
    });
    await listener.start();

    // The socket itself is still loopback-only: the drop is a policy decision,
    // not an artefact of where we connected from.
    expect(listener.address()?.address).toBe('127.0.0.1');

    const reply = await postJson(port, mainThreadPayload());
    expect(reply.status).toBe(403);
    expect(listener.counters.droppedNonLoopback).toBe(1);
    expect(listener.counters.accepted).toBe(0);
    expect(received).toHaveLength(0);
  });

  it('does not let proxy headers grant loopback status', async () => {
    await listener.stop();
    listener = new HookListener({
      port,
      maxBodyBytes: 4096,
      spoofRemoteAddress: '203.0.113.7',
      onEvent: (event) => received.push(event),
    });
    await listener.start();

    const spoofAttempts: Record<string, string>[] = [
      { 'x-forwarded-for': '127.0.0.1' },
      { 'x-forwarded-for': '127.0.0.1, 203.0.113.7' },
      { 'x-real-ip': '127.0.0.1' },
      { forwarded: 'for=127.0.0.1;proto=http' },
      { 'x-forwarded-host': 'localhost' },
      {
        'x-forwarded-for': '::1',
        'x-real-ip': '127.0.0.1',
        forwarded: 'for="[::1]"',
      },
    ];

    for (const headers of spoofAttempts) {
      const reply = await postRaw(port, {
        body: JSON.stringify(mainThreadPayload()),
        headers,
      });
      expect(reply.status, JSON.stringify(headers)).toBe(403);
    }

    expect(listener.counters.accepted).toBe(0);
    expect(received).toHaveLength(0);
    expect(listener.counters.droppedNonLoopback).toBe(spoofAttempts.length);
  });

  it('ignores proxy headers claiming an off-box origin on a genuinely loopback request', async () => {
    const reply = await postRaw(port, {
      body: JSON.stringify(mainThreadPayload()),
      headers: { 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '10.0.0.9' },
    });

    // Headers are not consulted in either direction; only the socket matters.
    expect(reply.status).toBe(200);
    expect(listener.counters.droppedNonLoopback).toBe(0);
    expect(listener.counters.accepted).toBe(1);
  });

  describe('malformed input never crashes the listener', () => {
    /** Every case: 4xx, the right counter, and the server still serving. */
    async function expectStillAlive(before: number): Promise<void> {
      const reply = await postJson(port, mainThreadPayload());
      expect(reply.status).toBe(200);
      expect(listener.listening).toBe(true);
      expect(listener.counters.accepted).toBe(before + 1);
      expect(received[received.length - 1]?.isMainThread).toBe(true);
    }

    it('invalid JSON → 400', async () => {
      const reply = await postRaw(port, { body: '{"session_id": ' });
      expect(reply.status).toBe(400);
      expect(listener.counters.malformedJson).toBe(1);
      expect(listener.counters.accepted).toBe(0);
      await expectStillAlive(0);
    });

    it('a JSON array body → 400', async () => {
      const reply = await postRaw(port, { body: '[{"hook_event_name":"Stop"}]' });
      expect(reply.status).toBe(400);
      expect(listener.counters.notAnObject).toBe(1);
      await expectStillAlive(0);
    });

    it('a JSON null body → 400', async () => {
      const reply = await postRaw(port, { body: 'null' });
      expect(reply.status).toBe(400);
      expect(listener.counters.notAnObject).toBe(1);
      await expectStillAlive(0);
    });

    it('JSON scalars → 400', async () => {
      for (const body of ['42', '"a string"', 'true']) {
        const reply = await postRaw(port, { body });
        expect(reply.status, body).toBe(400);
      }
      expect(listener.counters.notAnObject).toBe(3);
      await expectStillAlive(0);
    });

    it('an empty body → 400', async () => {
      const reply = await postRaw(port, { body: '' });
      expect(reply.status).toBe(400);
      expect(listener.counters.emptyBody).toBe(1);
      await expectStillAlive(0);
    });

    it('a body over the size cap → 413', async () => {
      const oversize = JSON.stringify({
        session_id: 'sess-1',
        hook_event_name: 'PreToolUse',
        tool_input: { prompt: 'x'.repeat(listener.maxBodyBytes * 2) },
      });
      expect(Buffer.byteLength(oversize)).toBeGreaterThan(listener.maxBodyBytes);

      const reply = await postRaw(port, { body: oversize });
      expect(reply.status).toBe(413);
      expect(listener.counters.oversize).toBe(1);
      expect(listener.counters.accepted).toBe(0);
      expect(received).toHaveLength(0);
      await expectStillAlive(0);
    });

    it('a body exactly at the cap is accepted', async () => {
      const skeleton = '{"hook_event_name":"Stop","pad":""}';
      const padded = skeleton.replace(
        '""}',
        `"${'z'.repeat(listener.maxBodyBytes - skeleton.length)}"}`,
      );
      expect(Buffer.byteLength(padded)).toBe(listener.maxBodyBytes);

      const reply = await postRaw(port, { body: padded });
      expect(reply.status).toBe(200);
      expect(listener.counters.oversize).toBe(0);
      expect(listener.counters.accepted).toBe(1);
    });

    it('a non-JSON Content-Type → 415', async () => {
      const reply = await postRaw(port, {
        body: JSON.stringify(mainThreadPayload()),
        headers: { 'content-type': 'text/plain' },
      });
      expect(reply.status).toBe(415);
      expect(listener.counters.badContentType).toBe(1);
      expect(listener.counters.accepted).toBe(0);
      await expectStillAlive(0);
    });

    it('an absent Content-Type is tolerated', async () => {
      const reply = await postRaw(port, {
        body: JSON.stringify(mainThreadPayload()),
        headers: { 'content-type': undefined },
      });
      expect(reply.status).toBe(200);
      expect(listener.counters.badContentType).toBe(0);
      expect(listener.counters.accepted).toBe(1);
    });

    it('an unknown path → 404', async () => {
      const reply = await postRaw(port, {
        path: '/not-the-event-path',
        body: JSON.stringify(mainThreadPayload()),
      });
      expect(reply.status).toBe(404);
      expect(listener.counters.badRoute).toBe(1);
      expect(listener.counters.accepted).toBe(0);
      await expectStillAlive(0);
    });

    it('a GET on the event path → 405', async () => {
      const reply = await postRaw(port, { method: 'GET', body: '' });
      expect(reply.status).toBe(405);
      expect(listener.counters.badMethod).toBe(1);
      expect(listener.counters.accepted).toBe(0);
      await expectStillAlive(0);
    });

    it('survives the whole malformed battery back to back', async () => {
      const bodies = [
        '{',
        '[]',
        'null',
        '',
        'not json at all',
        '{"a":',
        '\u0000',
        '   ',
        '{"a":1,',
        '{"a":1}{"b":2}',
      ];
      for (const body of bodies) {
        const reply = await postRaw(port, { body });
        expect(reply.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
        expect(reply.status).toBeLessThan(500);
      }
      expect(listener.listening).toBe(true);
      const reply = await postJson(port, mainThreadPayload());
      expect(reply.status).toBe(200);
    });

    it('a consumer that throws is counted and does not break the response', async () => {
      listener.subscribe(() => {
        throw new Error('consumer exploded');
      });

      const reply = await postJson(port, mainThreadPayload());
      expect(reply.status).toBe(200);
      expect(listener.counters.handlerErrors).toBe(1);
      expect(listener.counters.accepted).toBe(1);
      // The well-behaved subscriber still got the event.
      expect(received).toHaveLength(1);

      const second = await postJson(port, mainThreadPayload());
      expect(second.status).toBe(200);
      expect(listener.counters.handlerErrors).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// bind failures are explicit, never a silent rebind
// ---------------------------------------------------------------------------

describe('HookListener bind failures', () => {
  it('surfaces a port collision as a typed error and does not rebind elsewhere', async () => {
    const port = await freePort();
    const first = new HookListener({ port });
    await first.start();

    const second = new HookListener({ port });
    let caught: unknown;
    try {
      await second.start();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HookListenerBindError);
    expect(isHookListenerBindError(caught)).toBe(true);
    const bindError = caught as HookListenerBindError;
    expect(bindError.name).toBe('HookListenerBindError');
    expect(bindError.code).toBe('EADDRINUSE');
    expect(bindError.port).toBe(port);
    expect(bindError.host).toBe('127.0.0.1');

    // No silent fallback: the second listener owns no socket at all.
    expect(second.listening).toBe(false);
    expect(second.address()).toBeNull();

    // The first listener is unaffected and still serving.
    expect(first.address()?.port).toBe(port);
    const reply = await postJson(port, mainThreadPayload());
    expect(reply.status).toBe(200);
    expect(first.counters.accepted).toBe(1);

    await second.stop();
    await first.stop();
  });

  it('refuses an ephemeral port rather than binding one', async () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      const listener = new HookListener({ port });
      let caught: unknown;
      try {
        await listener.start();
      } catch (err) {
        caught = err;
      }
      expect(isHookListenerBindError(caught), String(port)).toBe(true);
      expect((caught as HookListenerBindError).code).toBe('EPORTINVALID');
      expect(listener.listening).toBe(false);
      expect(listener.address()).toBeNull();
      await listener.stop();
    }
  });

  it('stop() on a never-started listener is a no-op', async () => {
    const listener = new HookListener({ port: 47999 });
    await expect(listener.stop()).resolves.toBeUndefined();
    expect(listener.listening).toBe(false);
  });

  it('can be restarted on the same port after stopping', async () => {
    const port = await freePort();
    const listener = new HookListener({ port });
    await listener.start();
    await listener.stop();
    expect(listener.listening).toBe(false);
    await listener.start();
    expect(listener.address()?.address).toBe('127.0.0.1');
    await listener.stop();
  });
});

// ---------------------------------------------------------------------------
// source-level grounding guards
// ---------------------------------------------------------------------------

// DoD item 2, second clause: "a regression test asserts no code path matches
// the string <sentinel>". The scan below covers the hook-event CONSUMERS, not
// only the listener, because that is where the bug actually lands: a
// correlator that string-matches the sentinel silently drops every main-thread
// event, since CC omits the `agent_id` key rather than sending a placeholder.
//
// Two things made this non-trivial:
//
//   1. Several modules legitimately compare against the same word. Every such
//      site in this repo is a NODE-KIND discriminant — `AgentNode.kind` or
//      `AttributionSite.transcriptKind`, both declared `'main' | 'subagent'`
//      in the domain model. Those must keep working.
//   2. A scan that silently matches nothing is worse than no scan, because it
//      reads as coverage. So the scan is allowlist-shaped, not blocklist-
//      shaped: it finds EVERY comparison against the sentinel and then demands
//      each one's operand end in a declared kind discriminant. Anything else —
//      `agentId`, `raw['agent_id']`, a bare id — is a violation, and a
//      comparison whose shape the extractor cannot parse is ALSO a failure, so
//      a novel construct cannot slip through unexamined.
//
// The file set is walked off disk, never hard-coded, so a consumer module
// added tomorrow is covered the day it lands.
//
// WHAT THIS SCAN IS AND IS NOT
// ----------------------------
// It is a TEXTUAL scan, not a proof. It reads source as text and has no model
// of value flow, so it catches the literal at the point of comparison or
// binding and nothing further. Measured against 16 deliberate evasion shapes
// by the phase verifier: 9 caught, 7 not.
//
//   Caught: direct comparison in any operand shape, bracket access
//     (`raw['agent_id']`), optional chaining, reversed operands, membership
//     and switch tests, and — via the `unparsed` counter — comparisons whose
//     operand it cannot parse at all, e.g. wrapping the left side in a
//     `String(...)` call. That counter is the safety net: an unrecognised
//     shape FAILS rather than passing quietly.
//   Not caught: value-flow indirection where the literal never appears next
//     to the comparison — `Object.is(a, b)`, building the word by
//     concatenation, `Set.has`, array `includes` against a list built
//     elsewhere, a regex, `localeCompare`. A named constant is the one
//     realistic member of that family, and it is closed in the
//     zero-tolerance tier by flagging the BINDING (see SENTINEL_BINDINGS)
//     rather than the comparison.
//
// Note that this comment block, like the ones below, avoids writing the
// sentinel as a bare quoted literal. That is not squeamishness: the scan reads
// this file too, and prose that spells out a violation would be flagged as
// one. A false positive here fails loudly and is reworded in seconds, which is
// the right trade against stripping comments and risking a false negative.
//
// Do not read a green run as proof that no code path matches the sentinel. It
// is evidence that no path does so in a shape a reader would recognise. The
// behavioural tests above — absence-of-key attribution and its sharp converse
// — are what actually pin the semantics.

/** The sentinel word, assembled so this file's own source never contains it. */
const SENTINEL_WORD = 'ma' + 'in';

/** Left operand, then an equality operator, then the quoted sentinel. */
const LEFT_COMPARISON =
  /([A-Za-z_$][\w$]*(?:\s*(?:\??\.\s*[A-Za-z_$][\w$]*|\[\s*['"][^'"\]]*['"]\s*\]))*)\s*(?:===|!==|==|!=)\s*(['"`])ma[i]n\2/g;

/** The quoted sentinel, then an equality operator, then the right operand. */
const RIGHT_COMPARISON =
  /(['"`])ma[i]n\1\s*(?:===|!==|==|!=)\s*([A-Za-z_$][\w$]*(?:\s*(?:\??\.\s*[A-Za-z_$][\w$]*|\[\s*['"][^'"\]]*['"]\s*\]))*)/g;

/** Any equality comparison against the sentinel, whatever the operand shape. */
const ANY_COMPARISON =
  /(?:===|!==|==|!=)\s*(['"`])ma[i]n\1|(['"`])ma[i]n\2\s*(?:===|!==|==|!=)/g;

/** Membership / switch tests. Never a legitimate kind discriminant here. */
const MEMBERSHIP_TEST =
  /(?:\.includes\(|\.indexOf\(|\.startsWith\(|\.endsWith\(|case\s+)\s*(['"`])ma[i]n\1/g;

/** A quoted string literal whose entire content is the sentinel word. */
const QUOTED_SENTINEL = /(['"`])ma[i]n\1/g;

/**
 * The bare sentinel bound to a name — a `const`/`let`/`var` declaration, a
 * plain assignment, or an object property whose value is the bare literal.
 * Checked ONLY in the zero-tolerance tier, because the identical shape
 * (`kind:` followed by the literal) is a legitimate object-property write in
 * the domain-model files and must not be flagged there.
 *
 * This exists because a named constant is the way a developer would most
 * naturally write the bug the whole scan is aimed at: declare the literal
 * once under a name, then compare an agent id against that name. The
 * comparison is invisible to any textual scan the moment the literal has a
 * name, so catching the BINDING is what closes it.
 */
const SENTINEL_BINDINGS: readonly RegExp[] = [
  // const / let / var NAME [: Type] = <sentinel>
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=;\n]+)?=\s*(['"`])ma[i]n\1/g,
  // lhs = <sentinel>  (a single '=', never part of ==, ===, !=, <=, >=, =>)
  /[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*(?<![=!<>])=(?![=>])\s*(['"`])ma[i]n\1/g,
  // NAME: <sentinel> in an object-property position
  /[A-Za-z_$][\w$]*\s*:\s*(['"`])ma[i]n\1/g,
];

/**
 * The only operands allowed to be compared against the sentinel: the declared
 * discriminants of the domain model. Widening this set is a deliberate act to
 * be argued in review, not something to do to make a test go green.
 */
const KIND_DISCRIMINANTS = new Set(['kind', 'transcriptKind']);

/**
 * The hook-event path proper. These modules consume `NormalizedHookEvent` and
 * build no domain tree, so they have no legitimate reason to compare anything
 * against the sentinel at all — zero tolerance here, not an allowlist.
 */
const HOOK_PATH_FILES = ['src/hooks/listener.ts', 'src/model/liveness.ts'];

/** Consumers the scan must reach; a rename or move must fail loudly. */
const REQUIRED_IN_SCAN = [
  'src/hooks/listener.ts',
  'src/model/events.ts',
  'src/model/liveness.ts',
  'src/model/correlate.ts',
  'src/model/session.ts',
];

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

function repoRelative(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

/** Every non-test .ts file under src/, discovered from disk rather than listed. */
async function productionSources(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        found.push(full);
      }
    }
  };
  await walk(SRC_ROOT);
  return found.sort();
}

interface SentinelHit {
  file: string;
  line: number;
  operand: string;
  accessor: string;
  isKindDiscriminant: boolean;
  text: string;
}

interface ScanResult {
  hits: SentinelHit[];
  /** Comparisons the extractor could not attribute to an operand. */
  unparsed: number;
  /** Membership/switch tests against the sentinel; always a violation. */
  membership: string[];
  /**
   * The bare sentinel bound to a name. Only meaningful in the zero-tolerance
   * tier — see {@link SENTINEL_BINDINGS}.
   */
  bindings: string[];
}

/** The trailing accessor of an operand chain: `a.b.kind` -> `kind`. */
function lastAccessor(operand: string): string {
  const cleaned = operand.replace(/\s+/g, '');
  const bracketed = /\[['"]([^'"\]]*)['"]\]$/.exec(cleaned);
  if (bracketed) return bracketed[1] ?? '';
  const parts = cleaned.split(/\??\./);
  return parts[parts.length - 1] ?? '';
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function scanSource(file: string, source: string): ScanResult {
  const hits: SentinelHit[] = [];

  for (const [pattern, group] of [
    [LEFT_COMPARISON, 1],
    [RIGHT_COMPARISON, 2],
  ] as const) {
    for (const match of source.matchAll(pattern)) {
      const operand = match[group] ?? '';
      const accessor = lastAccessor(operand);
      hits.push({
        file,
        line: lineOf(source, match.index),
        operand,
        accessor,
        isKindDiscriminant: KIND_DISCRIMINANTS.has(accessor),
        text: match[0].replace(/\s+/g, ' '),
      });
    }
  }

  const total = [...source.matchAll(ANY_COMPARISON)].length;
  const membership = [...source.matchAll(MEMBERSHIP_TEST)].map(
    (m) => `${file}:${String(lineOf(source, m.index))} ${m[0].trim()}`,
  );

  // The binding patterns deliberately overlap — a declaration is also an
  // assignment — so results are keyed by where the sentinel literal ends,
  // which is identical across patterns for one occurrence. Without this a
  // single `const X = <sentinel>` would be reported twice.
  const byLiteralEnd = new Map<number, string>();
  for (const pattern of SENTINEL_BINDINGS) {
    for (const m of source.matchAll(pattern)) {
      const key = m.index + m[0].length;
      const text = `${file}:${String(lineOf(source, m.index))} ${m[0].replace(/\s+/g, ' ').trim()}`;
      const existing = byLiteralEnd.get(key);
      if (existing === undefined || text.length > existing.length) {
        byLiteralEnd.set(key, text);
      }
    }
  }
  const bindings = [...byLiteralEnd.values()];

  return { hits, unparsed: total - hits.length, membership, bindings };
}

function describeHit(hit: SentinelHit): string {
  return `${hit.file}:${String(hit.line)} ${hit.text} (operand ends in "${hit.accessor}")`;
}

describe('sentinel scan: the scanner itself', () => {
  // These cases are independent of what the repo currently contains, so the
  // scanner cannot rot into something that matches nothing and still passes.
  const W = SENTINEL_WORD;

  it('flags a hook-derived agent id compared against the sentinel', () => {
    for (const sample of [
      `if (event.agentId === '${W}') { drop(); }`,
      `if (event.raw['agent_id'] === '${W}') { drop(); }`,
      `return e.agentId !== '${W}';`,
      `const isMainThread = '${W}' === event.agentId;`,
      `if (event?.agentId === '${W}') { drop(); }`,
      `if (agentId === "${W}") { drop(); }`,
      `if (p.agent_id === '${W}') { drop(); }`,
    ]) {
      const result = scanSource('sample.ts', sample);
      expect(result.hits, sample).toHaveLength(1);
      expect(result.unparsed, sample).toBe(0);
      expect(result.hits[0]?.isKindDiscriminant, sample).toBe(false);
    }
  });

  it('allows a declared node-kind discriminant', () => {
    for (const sample of [
      `if (node.kind === '${W}') { return root; }`,
      `const acc = batch.kind === '${W}' ? this.main : other;`,
      `if (a.parent.transcriptKind === '${W}') return { depth };`,
      `return site.transcriptKind === '${W}' ? x : y;`,
      `if (kind === '${W}') { return root; }`,
    ]) {
      const result = scanSource('sample.ts', sample);
      expect(result.hits, sample).toHaveLength(1);
      expect(result.unparsed, sample).toBe(0);
      expect(result.hits[0]?.isKindDiscriminant, sample).toBe(true);
    }
  });

  it('ignores writes and prose, which are not comparisons', () => {
    for (const sample of [
      `const node = { kind: '${W}', id: 'root' };`,
      `kind: '${W}' | 'subagent';`,
      `// never compare an id to the literal ${W}`,
      `/** CC omits the key; the literal \`"${W}"\` never appears. */`,
    ]) {
      const result = scanSource('sample.ts', sample);
      expect(result.hits, sample).toHaveLength(0);
      expect(result.unparsed, sample).toBe(0);
      expect(result.membership, sample).toEqual([]);
    }
  });

  it('reports a comparison whose operand shape it cannot parse', () => {
    const result = scanSource(
      'sample.ts',
      `if (resolve() === '${W}') { drop(); }`,
    );
    expect(result.hits).toHaveLength(0);
    expect(result.unparsed).toBe(1);
  });

  it('flags the bare sentinel bound to a name', () => {
    for (const sample of [
      `const MAIN_ID = '${W}';`,
      `const MAIN_ID: string = '${W}';`,
      `let fallback = '${W}';`,
      `var legacy = "${W}";`,
      `this.mainId = '${W}';`,
      `const cfg = { mainId: '${W}' };`,
    ]) {
      const result = scanSource('sample.ts', sample);
      expect(result.bindings, sample).toHaveLength(1);
    }
  });

  it('does not mistake a comparison or prose for a binding', () => {
    for (const sample of [
      `if (node.kind === '${W}') { return root; }`,
      `if (x !== '${W}') { return; }`,
      `const arrow = () => '${W}';`,
      `// the literal \`"${W}"\` has never appeared in any capture`,
    ]) {
      const result = scanSource('sample.ts', sample);
      expect(result.bindings, sample).toEqual([]);
    }
  });

  it('flags membership and switch tests against the sentinel', () => {
    for (const sample of [
      `if (ids.includes('${W}')) { drop(); }`,
      `switch (x) { case '${W}': return null; }`,
      `if (id.startsWith('${W}')) { drop(); }`,
    ]) {
      const result = scanSource('sample.ts', sample);
      expect(result.membership, sample).toHaveLength(1);
    }
  });
});

describe('sentinel scan: every production source under src/', () => {
  it('reaches the hook-event consumers, discovered from disk', async () => {
    const files = (await productionSources()).map(repoRelative);
    expect(files.length).toBeGreaterThan(0);
    for (const required of REQUIRED_IN_SCAN) {
      expect(files, `scan must reach ${required}`).toContain(required);
    }
  });

  it('no production file compares a non-kind operand against the sentinel', async () => {
    const violations: string[] = [];
    const allowed: SentinelHit[] = [];
    const unparsed: string[] = [];

    for (const absolute of await productionSources()) {
      const file = repoRelative(absolute);
      const result = scanSource(file, await readFile(absolute, 'utf8'));

      for (const hit of result.hits) {
        if (hit.isKindDiscriminant) allowed.push(hit);
        else violations.push(describeHit(hit));
      }
      violations.push(...result.membership);
      if (result.unparsed > 0) {
        unparsed.push(
          `${file}: ${String(result.unparsed)} unrecognised comparison(s)`,
        );
      }
    }

    expect(violations).toEqual([]);
    // A shape the extractor cannot attribute must be reviewed, never ignored.
    expect(unparsed).toEqual([]);
    // Anti-vacuity. A scan that silently matches nothing reads as coverage
    // while proving nothing, so the scanner must demonstrably be finding real
    // comparisons in this repo — in more than one file, so a single refactor
    // cannot quietly hollow it out. This is also why the guard cannot be
    // satisfied by DELETING the legitimate sites it was built to allow.
    expect(allowed.length).toBeGreaterThan(0);
    expect(new Set(allowed.map((hit) => hit.file)).size).toBeGreaterThan(1);
    // Every allowed hit is a kind discriminant and nothing else.
    expect([...new Set(allowed.map((hit) => hit.accessor))].sort()).toEqual(
      [...KIND_DISCRIMINANTS].sort(),
    );
  });

  it('the hook-event path compares nothing against the sentinel, kind or not', async () => {
    const scanned: string[] = [];
    const violations: string[] = [];

    for (const absolute of await productionSources()) {
      const file = repoRelative(absolute);
      if (!HOOK_PATH_FILES.includes(file)) continue;
      scanned.push(file);

      const result = scanSource(file, await readFile(absolute, 'utf8'));
      // These modules consume NormalizedHookEvent and build no domain tree, so
      // even a kind discriminant would be out of place here.
      violations.push(...result.hits.map(describeHit));
      violations.push(...result.membership);
      if (result.unparsed > 0) violations.push(`${file}: unrecognised comparison`);
    }

    expect(scanned.sort()).toEqual([...HOOK_PATH_FILES].sort());
    expect(violations).toEqual([]);
  });

  it('the hook-event path never binds the bare sentinel to a name', async () => {
    // Closes the one non-contrived evasion: bind the literal to a constant,
    // then compare an agent id against that constant. The comparison is
    // invisible to any textual scan once the literal has a name, so the
    // binding is what gets caught. Scoped to these two files precisely
    // because the same shape (`kind:` followed by the literal) is a
    // legitimate property write elsewhere in the model.
    const scanned: string[] = [];
    const bindings: string[] = [];

    for (const absolute of await productionSources()) {
      const file = repoRelative(absolute);
      if (!HOOK_PATH_FILES.includes(file)) continue;
      scanned.push(file);
      bindings.push(...scanSource(file, await readFile(absolute, 'utf8')).bindings);
    }

    expect(scanned.sort()).toEqual([...HOOK_PATH_FILES].sort());
    expect(bindings).toEqual([]);
  });
});

describe('grounding guards, asserted against the source text', () => {
  it('src/hooks/listener.ts contains no quoted agent-id sentinel at all', async () => {
    const source = await readFile(LISTENER_SOURCE_PATH, 'utf8');
    expect(source.match(QUOTED_SENTINEL)).toBeNull();
    expect(scanSource('listener.ts', source).hits).toEqual([]);
  });

  it('src/hooks/listener.test.ts never compares an agent id against the sentinel', async () => {
    // The test file legitimately *contains* the sentinel as payload data; what
    // it must never do is compare against it the way a broken correlator would.
    const source = await readFile(
      fileURLToPath(new URL('./listener.test.ts', import.meta.url)),
      'utf8',
    );
    const result = scanSource('listener.test.ts', source);
    expect(result.hits).toEqual([]);
    expect(result.unparsed).toBe(0);
    expect(result.membership).toEqual([]);
  });

  it('the hook-event contract added to events.ts contains no quoted sentinel', async () => {
    const source = await readFile(EVENTS_SOURCE_PATH, 'utf8');
    const marker = '(d) Hook-event contract';
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(-1);

    const hookSection = source.slice(start);
    expect(hookSection.match(QUOTED_SENTINEL)).toBeNull();
    expect(scanSource('events.ts#hooks', hookSection).hits).toEqual([]);
  });

  it('is not vacuous: events.ts does carry the legitimate AgentNode.kind literal', async () => {
    const source = await readFile(EVENTS_SOURCE_PATH, 'utf8');
    const marker = '(d) Hook-event contract';
    const preHookSection = source.slice(0, source.indexOf(marker));

    // The domain model's `kind` discriminant uses the same word deliberately
    // and must keep working. Its presence proves the scan above would have
    // fired had the hook contract used the word the same way.
    expect(preHookSection).toContain(`kind: '${SENTINEL_WORD}' | 'subagent'`);
    expect(preHookSection.match(QUOTED_SENTINEL)).not.toBeNull();
    // ...and even the pre-existing model never *compares* against it.
    expect(scanSource('events.ts#model', preHookSection).hits).toEqual([]);
  });

  it('G1: the listener imports no filesystem API and writes nothing', async () => {
    const source = await readFile(LISTENER_SOURCE_PATH, 'utf8');
    expect(source).not.toMatch(/from\s+['"]node:fs(\/promises)?['"]/);
    expect(source).not.toMatch(/require\(\s*['"](node:)?fs(\/promises)?['"]\s*\)/);
    expect(source).not.toMatch(/createWriteStream|writeFileSync|appendFileSync/);
    // No home-directory resolution either: the listener has no business
    // knowing where ~/.claude is, let alone opening anything in it.
    expect(source).not.toMatch(/homedir|USERPROFILE|process\.env\.HOME/);
    // Only the two modules it actually needs are imported.
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(
      new Set(['node:buffer', 'node:http', 'node:net', '../model/events.js']),
    );
  });

  it('G5: the listener binds the literal loopback address and no wildcard', async () => {
    const source = await readFile(LISTENER_SOURCE_PATH, 'utf8');
    expect(source).toContain("'127.0.0.1'");
    expect(source).not.toContain('0.0.0.0');
    expect(source).not.toMatch(/listen\(\s*0\s*[,)]/);
    // The bind host is a constant, not read from options.
    expect(source).not.toMatch(/options\.host/);
  });
});
