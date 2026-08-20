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
 *
 * ---------------------------------------------------------------------------
 * KNOWN: `npm test` can exit 1 while reporting every test passed
 * ---------------------------------------------------------------------------
 * Symptom: `Unhandled Rejection: Error: Channel closed`, `ERR_IPC_CHANNEL_CLOSED`,
 * raised in the PARENT vitest process at tinypool's `ProcessWorker.send`. Every
 * test still passes; only the exit code is wrong. It is load-dependent.
 *
 * It is NOT an uncaught exception or unhandled rejection in this file's worker:
 * `process.on('uncaughtException')` / `('unhandledRejection')` probes installed
 * here caught nothing across 8 reproducing runs. The parent is posting to a
 * forked child whose IPC channel has already closed.
 *
 * Measured on Windows / Node v24.15.0 / vitest 3.2.7, `npm test` full suite:
 *
 *   forks pool (the vitest 3 default), suite as it stands ....  1 / 24 runs
 *   forks, the dropped-connection test skipped ...............  2 / 24
 *   forks, ALL socket tests in this file skipped .............  0 / 12
 *   forks, this whole file excluded from the run .............  0 / 15
 *   THREADS pool (`vitest run --pool=threads`), nothing skipped  0 / 20
 *
 * So: it needs the socket tests in this file, and it needs the forks pool. It
 * is not any one socket API — swapping RST for FIN, settling the client on
 * socket 'close' instead of response 'end', and `agent: false` each changed
 * nothing measurable. Do not go looking for the bug in a single test; four
 * such attempts failed, and two apparent fixes were small samples of a ~5-15%
 * event.
 *
 * The remedy is one line in `vitest.config.ts` (`pool: 'threads'`), which this
 * package does not own. Until that lands, a red `npm test` whose summary says
 * every test passed is THIS, not a regression in whatever you just touched —
 * re-run before believing it.
 */

import { Buffer } from 'node:buffer';
import { readdir, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
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
  type HookListenerCounters,
  type HookListenerOptions,
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
/** The real onset capture: listener bound first, then a fresh CC window. */
const SESSIONSTART_FIXTURE_PATH = fileURLToPath(
  new URL(
    '../../fixtures/hook-events/cc-2.1.234-sessionstart.jsonl',
    import.meta.url,
  ),
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Start a listener on an OS-assigned loopback port, ATOMICALLY, and report the
 * port it got. Every socket test in this file goes through here.
 *
 * There used to be a `freePort()` helper that bound port 0 on a throwaway
 * server, read the assigned number, CLOSED it and returned the bare number.
 * Between that close and the listener's bind, anything on the machine — most
 * often another worker in this same suite — could take the port. Measured over
 * 15 full-suite runs before the fix: 12 green, 2 red with
 * `HookListenerBindError: ... listen EADDRINUSE`, 1 that died mid-run. The
 * off-box replay alone ran roughly fourteen of those races back to back.
 *
 * Retrying on EADDRINUSE would have left the window open and made the failure
 * rarer, which is the worse answer: a suite that is green 14 times in 15 cannot
 * certify a "100% pass" gate. The window is closed instead — the listener binds
 * port 0 itself, so the number never exists outside a bound socket. Production
 * still refuses port 0; {@link HookListenerOptions.allowEphemeralPort} is a
 * TEST-ONLY opt-in, and a source scan below asserts nothing under `src/`
 * outside `listener.ts` names it.
 */
async function startEphemeralListener(
  options: Omit<HookListenerOptions, 'port' | 'allowEphemeralPort'> = {},
): Promise<{ listener: HookListener; port: number }> {
  const listener = new HookListener({
    ...options,
    port: 0,
    allowEphemeralPort: true,
  });
  await listener.start();
  const bound = listener.address();
  if (bound === null || bound.port === 0) {
    await listener.stop();
    throw new Error('ephemeral listener reported no bound port');
  }
  return { listener, port: bound.port };
}

/**
 * A loopback port with nothing bound to it, for the one test that needs a
 * request to be REFUSED rather than answered.
 *
 * This is the single remaining place where a bare port number outlives its
 * socket, and it is the right shape here: the test wants nothing listening, so
 * the only way it can mislead is if some other process binds this exact port
 * AND speaks HTTP within milliseconds, which would fail the test loudly rather
 * than pass it quietly.
 */
async function closedLoopbackPort(): Promise<number> {
  const { listener, port } = await startEphemeralListener();
  await listener.stop();
  return port;
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
    // Two rules, and the order matters.
    //
    // 1. A socket error is a REAL failure only if it arrives before the reply
    //    is complete. Several listener paths answer and close before reading
    //    the body (403/404/405/415), and stop() destroys keep-alive sockets,
    //    so a reset routinely lands after a perfectly good response has been
    //    received. `reply !== undefined` is the discriminator: once the
    //    response has ended, later errors are the expected consequence of the
    //    server closing first and are dropped. Before that, they reject and
    //    fail the test they belong to.
    //
    // 2. Settle on the socket's 'close', not on the response's 'end'. A
    //    promise that resolves at 'end' hands control back while the socket is
    //    still tearing down, so a test file can finish with sockets mid-close.
    //    Awaiting 'close' means no socket outlives the test that opened it.
    //    `agent: false` guarantees a dedicated socket per request so 'close'
    //    is prompt and never deferred by connection pooling.
    let reply: HttpReply | undefined;
    let failure: Error | undefined;
    let done = false;

    const finish = (): void => {
      if (done) return;
      if (reply !== undefined) {
        done = true;
        resolve(reply);
      } else if (failure !== undefined) {
        done = true;
        reject(failure);
      }
    };

    const onError = (err: Error): void => {
      if (reply !== undefined) return; // post-reply: expected, not a failure
      failure ??= err;
      finish();
    };

    const req = httpRequest(
      { host: LOOPBACK, port, path, method, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('error', onError);
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          reply = {
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          };
          // Do not settle yet; wait for the socket to be released below.
        });
      },
    );
    req.on('error', onError);
    // Fires once the request and its socket are fully done, on every path:
    // clean response, error, or destroy.
    req.on('close', () => {
      if (reply === undefined && failure === undefined) {
        // Closed with no reply and no error. That is a real failure, and
        // saying so beats letting the promise hang until the test times out.
        failure = new Error('connection closed before any reply was received');
      }
      finish();
    });
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

async function readPayloadsFrom(path: string): Promise<RawHookPayload[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawHookPayload);
}

async function readFixturePayloads(): Promise<RawHookPayload[]> {
  return readPayloadsFrom(HOOK_FIXTURE_PATH);
}

/** Never hard-code the count: derive it from the committed capture (G6). */
async function readSessionStartPayloads(): Promise<RawHookPayload[]> {
  return readPayloadsFrom(SESSIONSTART_FIXTURE_PATH);
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
  it('marks every measured name confirmed', () => {
    for (const name of CONFIRMED_HOOK_EVENT_NAMES) {
      expect(isConfirmedHookEventName(name), name).toBe(true);
      expect(normalizeHookEvent({ hook_event_name: name }).eventNameConfirmed).toBe(
        true,
      );
    }
    expect([...CONFIRMED_HOOK_EVENT_NAMES]).toContain('SubagentStart');
  });

  it('marks SessionStart CONFIRMED on the pinned CC version', () => {
    // It was unmeasured for two phases because a listener bound mid-session
    // cannot observe an event that fires at session onset. Binding first and
    // opening a fresh CC window produced the fixture replayed below.
    expect(isConfirmedHookEventName('SessionStart')).toBe(true);
    expect(isKnownHookEventName('SessionStart')).toBe(true);
    expect([...KNOWN_HOOK_EVENT_NAMES]).toContain('SessionStart');
    expect(
      normalizeHookEvent({ hook_event_name: 'SessionStart' }).eventNameConfirmed,
    ).toBe(true);
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
// SessionStart, driven by the committed onset capture
// ---------------------------------------------------------------------------

describe('fixtures/hook-events/cc-2.1.234-sessionstart.jsonl', () => {
  // Real bytes, not a hand-written literal. Nothing here asserts the file's
  // size; every count is derived so a re-harvest cannot read as a regression.
  let payloads: RawHookPayload[] = [];

  beforeEach(async () => {
    payloads = await readSessionStartPayloads();
    expect(payloads.length).toBeGreaterThan(0);
  });

  it('normalizes as a confirmed main-thread event with no join keys', () => {
    const measuredKeySet = [
      'session_id',
      'transcript_path',
      'cwd',
      'hook_event_name',
      'source',
    ].sort();

    for (const payload of payloads) {
      expect(Object.keys(payload).sort()).toEqual(measuredKeySet);
      expect(payload['source']).toBe('startup');

      const event = normalizeHookEvent(payload);
      expect(event.eventName).toBe('SessionStart');
      // The whole point of this package: a real SessionStart is confirmed.
      expect(event.eventNameConfirmed).toBe(true);
      // No agent_id key at all — absence IS the main-thread signal.
      expect(event.isMainThread).toBe(true);
      expect('agentId' in event).toBe(false);
      // Neither join key is present; nothing invents one.
      expect('toolUseId' in event).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(payload, 'prompt_id')).toBe(
        false,
      );
      expect(typeof event.sessionId).toBe('string');
      expect(typeof event.transcriptPath).toBe('string');
    }
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
    received = [];
    ({ listener, port } = await startEphemeralListener({
      maxBodyBytes: 4096,
      onEvent: (event) => {
        received.push(event);
      },
    }));
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

  it('REGRESSION: real SessionStart events never count as unconfirmed', async () => {
    // The defect this test exists for: while SessionStart was listed as
    // unconfirmed, every ordinary session permanently tripped the counter
    // that is supposed to mean "CC sent a name we have never measured". A
    // drift alarm that fires on normal operation is worse than no alarm.
    // Replayed from the committed onset capture; the count is derived.
    const payloads = await readSessionStartPayloads();
    expect(payloads.length).toBeGreaterThan(0);

    for (const payload of payloads) {
      const reply = await postJson(port, payload);
      expect(reply.status).toBe(200);
    }

    expect(listener.counters.accepted).toBe(payloads.length);
    expect(received).toHaveLength(payloads.length);
    expect(listener.counters.unconfirmedEventName).toBe(0);
    expect(received.every((e) => e.eventNameConfirmed)).toBe(true);
    expect(received.every((e) => e.isMainThread)).toBe(true);
    expect(received.every((e) => e.eventName === 'SessionStart')).toBe(true);
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

    it('a connection dropped mid-request is counted, and the server keeps serving', async () => {
      // Covers the request-stream 'error' handler and the clientError handler
      // in listener.ts. An unhandled 'error' on either is an uncaught
      // exception, which in the extension host means the host dies because a
      // hook process went away mid-exchange — the G3 failure this module must
      // not have.
      //
      // DO NOT change `sock.destroy()` below to `sock.resetAndDestroy()`.
      // A real TCP RST is the more faithful simulation of a hook process being
      // killed, and this test used to send one. Measured on Windows / Node
      // v24.15.0, that RST made `npm test` exit 1 while still reporting every
      // test passed, roughly one run in six:
      //     reset test sending RST .................. 3 incidents / 20 runs
      //     reset test skipped, all other sockets on . 0 / 12
      //     all socket tests skipped ................. 0 / 12
      //     this whole file excluded ................. 0 / 15
      // The failure is `ERR_IPC_CHANNEL_CLOSED` raised in the *parent* vitest
      // process (tinypool ProcessWorker.send), not an uncaught exception in
      // this worker — an uncaughtException/unhandledRejection probe installed
      // here caught nothing across 8 reproducing runs. An abrupt FIN provokes
      // the same server-side socket error and does not trigger it.
      //
      // What this does NOT cover, stated plainly so nobody mistakes it: the
      // `res.on('error')` handler. Measured on Node v24, `res` never emits
      // 'error' here — every reply is a zero-length body written in one go, so
      // a dropped connection surfaces on the request stream and via
      // 'clientError'. This test passes unchanged with those three production
      // lines deleted. They are asymmetric-cost insurance, not tested behaviour.
      const before = listener.counters.socketErrors;

      // Announce a body and send only part of it, so the server is provably
      // mid-request — parked in its 'data' handler waiting for the rest — when
      // the connection drops. That beats timing tricks: there is no window in
      // which the exchange has already finished.
      //
      // Still retried, because "the server has parsed the headers by now" is
      // the one thing a client cannot observe, and a first attempt can lose
      // that race on a loaded machine. Each attempt is a real dropped
      // connection; the assertion is that a handled socket error is reachable
      // and survivable, not that it happens on attempt one. An earlier version
      // used a single 20k-request pipeline and flaked under full-suite load.
      const attempt = async (): Promise<void> => {
        await new Promise<void>((resolve) => {
          const sock = netConnect({ host: LOOPBACK, port }, () => {
            sock.pause(); // never read the reply
            sock.write(
              `POST ${DEFAULT_EVENT_PATH} HTTP/1.1\r\n` +
                `Host: ${LOOPBACK}\r\n` +
                `Content-Type: application/json\r\n` +
                `Content-Length: 4096\r\n` +
                `\r\n{"hook_event_name":"Stop","pad":"aaaa`,
            );
            setTimeout(() => sock.destroy(), 25);
          });
          // Resolve on 'close', never on the destroy call itself, so the socket
          // is fully released before the next attempt or the end of the test.
          // The drop is expected here, so 'error' is swallowed deliberately.
          sock.on('error', () => undefined);
          sock.on('close', () => resolve());
        });
        await new Promise((r) => setTimeout(r, 25));
      };

      for (let i = 0; i < 20; i++) {
        await attempt();
        if (listener.counters.socketErrors > before) break;
      }

      expect(listener.counters.socketErrors).toBeGreaterThan(before);
      expect(listener.listening).toBe(true);
      // The partial body was never a complete request, so nothing was accepted
      // from it and no consumer saw a phantom event.
      expect(listener.counters.accepted).toBe(0);
      expect(received).toHaveLength(0);

      // Still serving, and the counters that matter are unharmed.
      const reply = await postJson(port, mainThreadPayload());
      expect(reply.status).toBe(200);
      expect(received[received.length - 1]?.isMainThread).toBe(true);
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
    const { listener: first, port } = await startEphemeralListener();

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

  it('the TEST-ONLY opt-in binds port 0 and still refuses every other bad port', async () => {
    // The escape hatch that removed the freePort race. It must do exactly one
    // thing: permit 0. It must not become a general relaxation of the port
    // policy, and it must not touch the bind address.
    const { listener, port } = await startEphemeralListener();
    try {
      expect(port).toBeGreaterThan(0);
      expect(listener.address()?.address).toBe(HOOK_LISTENER_HOST);
      expect(listener.address()?.port).toBe(port);
      expect(listener.listening).toBe(true);
      expect((await postJson(port, mainThreadPayload())).status).toBe(200);
    } finally {
      await listener.stop();
    }

    for (const bad of [-1, 65536, 1.5, Number.NaN]) {
      const refused = new HookListener({ port: bad, allowEphemeralPort: true });
      let caught: unknown;
      try {
        await refused.start();
      } catch (err) {
        caught = err;
      }
      expect(isHookListenerBindError(caught), String(bad)).toBe(true);
      expect((caught as HookListenerBindError).code).toBe('EPORTINVALID');
      expect(refused.listening).toBe(false);
      await refused.stop();
    }
  });

  it('the test client still fails loudly when nothing answers', async () => {
    // Guards the change that made post-reply socket errors non-fatal. That
    // rule keys off "the reply was already complete"; an error with no reply
    // must still reject, or the helper would quietly pass tests whose request
    // never arrived. Nothing is bound on this port.
    const dead = await closedLoopbackPort();
    await expect(postJson(dead, mainThreadPayload())).rejects.toThrow();
  });

  it('stop() on a never-started listener is a no-op', async () => {
    const listener = new HookListener({ port: 47999 });
    await expect(listener.stop()).resolves.toBeUndefined();
    expect(listener.listening).toBe(false);
  });

  it('can be restarted after stopping, and stop() really releases the socket', async () => {
    // This used to rebind a fixed number obtained from the old freePort()
    // probe, which is the race this file exists to have removed. What it
    // actually guarded was two things, and both are still guarded: start()
    // works again after stop() cleared the server reference, and stop()
    // released the socket rather than leaving it bound. The second is now
    // asserted by connecting to the released port and being refused, which
    // does not require rebinding it.
    const { listener, port } = await startEphemeralListener();
    expect((await postJson(port, mainThreadPayload())).status).toBe(200);

    await listener.stop();
    expect(listener.listening).toBe(false);
    expect(listener.address()).toBeNull();
    await expect(postJson(port, mainThreadPayload())).rejects.toThrow();

    await listener.start();
    expect(listener.listening).toBe(true);
    expect(listener.address()?.address).toBe('127.0.0.1');
    const rebound = listener.address()?.port ?? 0;
    expect(rebound).toBeGreaterThan(0);
    expect((await postJson(rebound, mainThreadPayload())).status).toBe(200);
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
// binding and nothing further. Final measured position, against 25 deliberate
// evasion shapes constructed by the phase verifier: 16 caught, 9 not.
//
//   Caught (16): direct comparison in any operand shape, bracket access
//     (`raw['agent_id']`), optional chaining, reversed operands, membership
//     and switch tests; every BINDING form where the literal sits next to an
//     operator — const/let/var, typed declaration, object property, default
//     parameter, object destructuring; and — via the `unparsed` counter —
//     comparisons whose operand it cannot parse at all, e.g. wrapping the
//     left side in a `String(...)` call. That counter is the safety net: an
//     unrecognised shape FAILS rather than passing quietly.
//   Not caught (9): value-flow indirection where the literal never appears
//     next to an operator — `Object.is(a, b)`, building the word by
//     concatenation, `Set.has`, array `includes` against a list built
//     elsewhere, a regex, `localeCompare`. No regex closes these.
//
// Coverage differs by file, deliberately:
//
//   every production file under src/  comparisons, allowlisted to operands
//                                     ending in a kind discriminant
//   listener.ts, liveness.ts          the above with NO allowance at all,
//                                     plus no bindings
//   session.ts                        no bindings either, except writing the
//                                     literal into a kind-named field
//
// session.ts is in the binding tier because it consumes hook events through
// `ingestHookEvent`. It is not in the no-comparisons tier because it also
// builds the domain tree and may legitimately compare a node's `kind`. An
// earlier version excluded it from both, which gave up more than it needed to:
// the residual gap there is now the two-step named constant alone, not every
// shape.
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
const SENTINEL_BINDINGS: readonly (readonly [RegExp, boolean])[] = [
  // const / let / var NAME [: Type] = <sentinel>.
  // Flagged whatever the name is: binding the bare literal to a variable is
  // the two-step evasion this pattern exists to catch, and no legitimate node
  // write needs one.
  [
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(['"`])ma[i]n\2/g,
    false,
  ],
  // lhs = <sentinel>  (a single '=', never part of ==, ===, !=, <=, >=, =>).
  // Writing into a kind-named field is a legitimate node write.
  [
    /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?<![=!<>])=(?![=>])\s*(['"`])ma[i]n\2/g,
    true,
  ],
  // NAME: <sentinel> in an object-property position. Same allowance: this is
  // how the domain model declares a node's kind (session.ts:118).
  [/([A-Za-z_$][\w$]*)\s*:\s*(['"`])ma[i]n\2/g, true],
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

/**
 * Files where binding the bare sentinel to a name is never allowed, except as
 * a write into a kind-named field (see {@link SENTINEL_BINDINGS}).
 *
 * A superset of {@link HOOK_PATH_FILES}: `session.ts` consumes hook events via
 * `ingestHookEvent`, so it is a live site for this bug class, but it also
 * builds the domain tree and so legitimately writes `kind:` followed by the
 * literal and may one day legitimately compare against it. It therefore gets
 * the binding rule but NOT the "no comparisons at all" rule above — which is
 * the whole reason these are two lists rather than one.
 */
const BINDING_ZERO_TOLERANCE_FILES = [
  ...HOOK_PATH_FILES,
  'src/model/session.ts',
];

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
  // A literal is a violation if ANY matching pattern says so. That is what
  // stops `const kind = <sentinel>` being excused by the assignment pattern's
  // kind allowance — the declaration pattern still flags it.
  const byLiteralEnd = new Map<number, { text: string; violation: boolean }>();
  for (const [pattern, kindAllowed] of SENTINEL_BINDINGS) {
    for (const m of source.matchAll(pattern)) {
      const key = m.index + m[0].length;
      const bound = lastAccessor(m[1] ?? '');
      const violation = !(kindAllowed && KIND_DISCRIMINANTS.has(bound));
      const text = `${file}:${String(lineOf(source, m.index))} ${m[0].replace(/\s+/g, ' ').trim()}`;
      const existing = byLiteralEnd.get(key);
      byLiteralEnd.set(key, {
        text:
          existing === undefined || text.length > existing.text.length
            ? text
            : existing.text,
        violation: (existing?.violation ?? false) || violation,
      });
    }
  }
  const bindings = [...byLiteralEnd.values()]
    .filter((b) => b.violation)
    .map((b) => b.text);

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
      // A variable named `kind` is still a violation: the kind allowance is
      // for writing a node's field, never for parking the literal in a local.
      `const kind = '${W}';`,
      `let transcriptKind = '${W}';`,
    ]) {
      const result = scanSource('sample.ts', sample);
      expect(result.bindings, sample).toHaveLength(1);
    }
  });

  it('allows the sentinel written into a kind-named field', () => {
    // The same allowlist the comparison scan uses. This is how the domain
    // model declares a node's type and it must keep working.
    for (const sample of [
      `const node = { id: 'root', kind: '${W}', children: [] };`,
      `kind: '${W}',`,
      `node.kind = '${W}';`,
      `this.parent.transcriptKind = '${W}';`,
      `transcriptKind: '${W}',`,
    ]) {
      const result = scanSource('sample.ts', sample);
      expect(result.bindings, sample).toEqual([]);
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

  it('no hook-event consumer binds the bare sentinel to a name', async () => {
    // Closes the one non-contrived evasion: bind the literal to a constant,
    // then compare an agent id against that constant. The comparison is
    // invisible to any textual scan once the literal has a name, so the
    // binding is what gets caught.
    //
    // This covers session.ts as well as the listener and the liveness engine.
    // An earlier version excluded session.ts wholesale because of its
    // legitimate `kind:` write on line 118; that gave up more than it needed
    // to, since the kind allowlist already distinguishes the two. The residual
    // gap in session.ts is now one shape rather than every shape.
    const scanned: string[] = [];
    const bindings: string[] = [];

    for (const absolute of await productionSources()) {
      const file = repoRelative(absolute);
      if (!BINDING_ZERO_TOLERANCE_FILES.includes(file)) continue;
      scanned.push(file);
      bindings.push(...scanSource(file, await readFile(absolute, 'utf8')).bindings);
    }

    expect(scanned.sort()).toEqual([...BINDING_ZERO_TOLERANCE_FILES].sort());
    expect(bindings).toEqual([]);
  });

  it('is not vacuous: session.ts really does carry the legitimate kind write', async () => {
    // The test above passes for session.ts only because the kind allowlist
    // excuses line 118. If that write ever vanished, the guard would be
    // trivially satisfiable and this asserts otherwise.
    const source = await readFile(
      fileURLToPath(new URL('../model/session.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain(`kind: '${SENTINEL_WORD}'`);

    const result = scanSource('src/model/session.ts', source);
    expect(result.bindings).toEqual([]);

    // Renaming that property to anything outside the allowlist must flag it.
    const renamed = source.replace(
      `kind: '${SENTINEL_WORD}'`,
      `mainId: '${SENTINEL_WORD}'`,
    );
    expect(scanSource('src/model/session.ts', renamed).bindings).toHaveLength(1);
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

  it('no production module outside listener.ts names either TEST-ONLY option', async () => {
    // `spoofRemoteAddress` and `allowEphemeralPort` exist so the suite can
    // exercise the non-loopback path without binding a non-loopback socket,
    // and can bind a port without racing for it. Both are declared TEST-ONLY
    // in the source, and a comment is not a guard. This is the guard: the only
    // production file under src/ allowed to mention either name is the module
    // that declares them.
    const testOnlyOptions = ['spoofRemoteAddress', 'allowEphemeralPort'];
    const offenders: string[] = [];
    for (const absolute of await productionSources()) {
      const file = repoRelative(absolute);
      if (file === 'src/hooks/listener.ts') continue;
      const source = await readFile(absolute, 'utf8');
      for (const option of testOnlyOptions) {
        if (source.includes(option)) offenders.push(`${file}: ${option}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);

    // Not vacuous twice over: the scan really covers the extension host, which
    // is the file that would set one of these by accident, and the declaring
    // module really does contain both names.
    const scanned = (await productionSources()).map(repoRelative);
    expect(scanned).toContain('src/extension.ts');
    const declaring = await readFile(LISTENER_SOURCE_PATH, 'utf8');
    for (const option of testOnlyOptions) {
      expect(declaring).toContain(option);
    }
  });
});

// ---------------------------------------------------------------------------
// fixtures/synthetic-hook-fuzz — the hostile-input corpus
// ---------------------------------------------------------------------------
//
// Every record is replayed over a REAL loopback socket against a REAL
// HookListener at the SHIPPED default body cap, and each asserts three things:
//
//   1. the HTTP status,
//   2. the EXACT counter deltas — every counter not named must be unchanged,
//   3. that the listener is still serving afterwards.
//
// (3) alone is the DoD line and is far too weak on its own: a listener that
// answered 200 to every byte sequence on earth would satisfy it. (2) is what
// makes the corpus mean something, because G3 is "refuse, DON'T GUESS" — each
// malformed shape has to earn its specific refusal, and a case that starts
// passing for a new reason fails instead of quietly changing meaning.
//
// Nothing here skips. There is no environment in which a case opts out; if the
// corpus file is missing, reading it throws and the block fails loudly. A test
// that quietly opts out is worse than an absent one, because it reports as
// coverage.
// ---------------------------------------------------------------------------

const FUZZ_CORPUS_PATH = fileURLToPath(
  new URL('../../fixtures/synthetic-hook-fuzz/corpus.jsonl', import.meta.url),
);

type FuzzBody =
  | { kind: 'base64'; data: string }
  | { kind: 'pad'; overBy?: number; multiple?: number; valid?: boolean }
  | { kind: 'nest'; depth: number; shape: 'array' | 'object' };

interface FuzzCase {
  id: string;
  class: string;
  note: string;
  body: FuzzBody;
  expect: {
    status: number | number[];
    counters: Record<string, number> | { anyOf: Record<string, number>[] };
  };
  headers?: Record<string, string | null>;
  method?: string;
  path?: string;
  remote?: string;
}

async function readFuzzCorpus(): Promise<FuzzCase[]> {
  const text = await readFile(FUZZ_CORPUS_PATH, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FuzzCase);
}

/**
 * Materialize a record's body against the cap the listener is configured with.
 *
 * Sized cases are descriptors rather than committed blobs, so the same record
 * exercises the shipped 512 KiB default and a small cap alike and the repo
 * carries no megabytes of padding.
 */
function materializeFuzzBody(body: FuzzBody, cap: number): Buffer {
  if (body.kind === 'base64') return Buffer.from(body.data, 'base64');
  if (body.kind === 'nest') {
    const text =
      body.shape === 'array'
        ? '['.repeat(body.depth) + ']'.repeat(body.depth)
        : `${'{"n":'.repeat(body.depth)}1${'}'.repeat(body.depth)}`;
    return Buffer.from(text, 'utf8');
  }
  const target =
    body.multiple === undefined ? cap + (body.overBy ?? 0) : cap * body.multiple;
  if (body.valid !== true) return Buffer.from('x'.repeat(target), 'utf8');
  const prefix = '{"session_id":"x","hook_event_name":"Stop","pad":"';
  const suffix = '"}';
  const padding = target - prefix.length - suffix.length;
  expect(padding, 'a valid padded body must have room for its own skeleton').
    toBeGreaterThanOrEqual(0);
  return Buffer.from(`${prefix}${'z'.repeat(padding)}${suffix}`, 'utf8');
}

/** Only the counters that MOVED, so an exact comparison names them all. */
function counterDelta(
  before: Readonly<HookListenerCounters>,
  after: Readonly<HookListenerCounters>,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const key of Object.keys(after) as (keyof HookListenerCounters)[]) {
    const moved = after[key] - before[key];
    if (moved !== 0) delta[key] = moved;
  }
  return delta;
}

function headersFor(
  fuzzCase: FuzzCase,
): Record<string, string | undefined> | undefined {
  if (fuzzCase.headers === undefined) return undefined;
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(fuzzCase.headers)) {
    // `null` in the fixture means "send no such header"; postRaw deletes on
    // undefined. JSON has no undefined, hence the translation.
    out[key] = value === null ? undefined : value;
  }
  return out;
}

/** Replay one record and assert status + exact counter deltas. */
async function runFuzzCase(
  listener: HookListener,
  targetPort: number,
  fuzzCase: FuzzCase,
): Promise<void> {
  const before = listener.counters;
  const reply = await postRaw(targetPort, {
    body: materializeFuzzBody(fuzzCase.body, listener.maxBodyBytes),
    ...(fuzzCase.method === undefined ? {} : { method: fuzzCase.method }),
    ...(fuzzCase.path === undefined ? {} : { path: fuzzCase.path }),
    ...(headersFor(fuzzCase) === undefined
      ? {}
      : { headers: headersFor(fuzzCase) }),
  });
  const delta = counterDelta(before, listener.counters);

  const allowedStatuses = Array.isArray(fuzzCase.expect.status)
    ? fuzzCase.expect.status
    : [fuzzCase.expect.status];
  expect(allowedStatuses, `${fuzzCase.id}: ${fuzzCase.note}`).toContain(
    reply.status,
  );

  // `anyOf` is used only where more than one outcome is genuinely correct —
  // the two nesting cases, where whether V8's parser copes with the depth is
  // not a property this repo controls. Each alternative is still a COMPLETE
  // delta map and the observed delta must equal one of them outright, so the
  // looser form stays exact: it never degrades into "some counter moved".
  const declared = fuzzCase.expect.counters as {
    anyOf?: Record<string, number>[];
  };
  const alternatives: Record<string, number>[] = declared.anyOf ?? [
    fuzzCase.expect.counters as Record<string, number>,
  ];
  if (alternatives.length === 1) {
    expect(delta, `${fuzzCase.id}: ${fuzzCase.note}`).toStrictEqual(alternatives[0]);
    return;
  }
  const matched = alternatives.some(
    (alternative) =>
      Object.keys(delta).length === Object.keys(alternative).length &&
      Object.entries(alternative).every(([key, value]) => delta[key] === value),
  );
  expect(
    matched,
    `${fuzzCase.id}: ${fuzzCase.note}\n  observed ${JSON.stringify(delta)}\n  expected one of ${JSON.stringify(alternatives)}`,
  ).toBe(true);
}

describe('fixtures/synthetic-hook-fuzz: hostile input never crashes the listener', () => {
  it('the corpus is printable ASCII, so it stays a reviewable text diff', async () => {
    // Several cases are raw NUL bytes, invalid UTF-8 and lone surrogates. They
    // are base64 in the file precisely so the file never becomes binary to git
    // — this repo has already paid once for a source file that did, losing
    // every future diff of it and compounding the `grep -a` hazard. Read as
    // BYTES, not as text, so a stray high byte cannot hide behind a decoder.
    const bytes = await readFile(FUZZ_CORPUS_PATH);
    const offending = [...bytes].findIndex(
      (b) => b !== 0x0a && (b < 0x20 || b > 0x7e),
    );
    expect(
      offending,
      offending === -1
        ? ''
        : `byte 0x${(bytes[offending] ?? 0).toString(16)} at offset ${offending} must be encoded, not embedded`,
    ).toBe(-1);
  });

  it('covers every input class the hardening item names', async () => {
    // The required set, not the actual set: asserting the full list of classes
    // present would fail the next time someone ADDS one, and asserting a count
    // would fail on every addition. This is the floor.
    const corpus = await readFuzzCorpus();
    const classes = new Set(corpus.map((c) => c.class));
    for (const required of [
      'malformed-json',
      'truncated-json',
      'oversize',
      'content-type',
      'missing-keys',
      'non-loopback',
      'control-characters',
      'unknown-fields',
    ]) {
      expect(classes, `the corpus must cover ${required}`).toContain(required);
    }
    // Not vacuous: a corpus of nothing but refusals could not tell "refuses
    // the right things" from "refuses everything".
    expect(classes).toContain('well-formed');
    // Every id unique, so a per-case failure names exactly one record.
    expect(new Set(corpus.map((c) => c.id)).size).toBe(corpus.length);
  });

  it('replays every loopback case: exact status, exact counter deltas, still serving', async () => {
    const corpus = await readFuzzCorpus();
    const cases = corpus.filter((c) => c.remote === undefined);
    // Not derived from a hard-coded number — derived from the file — but a
    // corpus that silently emptied itself must not pass as coverage.
    expect(cases.length).toBeGreaterThan(0);

    const received: NormalizedHookEvent[] = [];
    // The SHIPPED default cap, not a convenient small one: the oversize
    // boundary this asserts is the boundary the extension actually ships.
    const { listener, port } = await startEphemeralListener({
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      onEvent: (event) => received.push(event),
    });
    try {
      for (const fuzzCase of cases) {
        await runFuzzCase(listener, port, fuzzCase);
        expect(listener.listening, `${fuzzCase.id} left the listener down`).toBe(
          true,
        );
      }

      // Still serving a real payload after the whole battery, and the socket
      // is still the loopback one it started as.
      const acceptedBefore = listener.counters.accepted;
      const reply = await postJson(port, mainThreadPayload());
      expect(reply.status).toBe(200);
      expect(listener.counters.accepted).toBe(acceptedBefore + 1);
      expect(received[received.length - 1]?.isMainThread).toBe(true);
      expect(listener.address()?.address).toBe(HOOK_LISTENER_HOST);

      // Not one hostile body reached a consumer as a phantom event: every
      // dispatch corresponds to an accepted payload and nothing else.
      expect(received).toHaveLength(listener.counters.accepted);

      // A `__proto__` body must not have reached Object.prototype. Read
      // through a fresh object so the check is about the prototype chain and
      // not about the payload objects themselves.
      expect(
        Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'),
      ).toBe(false);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

      // The main-thread rule survived the battery: every accepted event with
      // no `agent_id` KEY is main-thread, every one with the key is not, and
      // the value is never consulted.
      for (const event of received) {
        const hasKey = Object.prototype.hasOwnProperty.call(event.raw, 'agent_id');
        expect(event.isMainThread).toBe(!hasKey);
      }
    } finally {
      await listener.stop();
    }
  });

  it('replays every off-box case through the spoofed origin: 403, body never read', async () => {
    const corpus = await readFuzzCorpus();
    const remotes = [
      ...new Set(
        corpus
          .filter((c) => c.remote !== undefined)
          .map((c) => c.remote as string),
      ),
    ];
    expect(remotes.length).toBeGreaterThan(0);

    for (const remote of remotes) {
      const cases = corpus.filter((c) => c.remote === remote);
      const received: NormalizedHookEvent[] = [];
      const { listener, port } = await startEphemeralListener({
        maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
        // TEST-ONLY. The socket is still bound to 127.0.0.1 and nothing else;
        // proving the non-loopback path by binding a non-loopback socket would
        // itself break G5.
        spoofRemoteAddress: remote,
        onEvent: (event) => received.push(event),
      });
      try {
        expect(listener.address()?.address).toBe(HOOK_LISTENER_HOST);
        for (const fuzzCase of cases) {
          await runFuzzCase(listener, port, fuzzCase);
        }
        // Origin is decided before anything reads the body, so a well-formed
        // payload from off-box moves droppedNonLoopback and NOTHING else.
        expect(listener.counters.accepted).toBe(0);
        expect(listener.counters.malformedJson).toBe(0);
        expect(listener.counters.oversize).toBe(0);
        expect(received).toHaveLength(0);
        expect(listener.listening).toBe(true);
      } finally {
        await listener.stop();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// transport-level malformation — things that cannot be expressed as a body
// ---------------------------------------------------------------------------

describe('malformed at the transport layer, not in the body', () => {
  let listener: HookListener;
  let port: number;

  beforeEach(async () => {
    ({ listener, port } = await startEphemeralListener({ maxBodyBytes: 4096 }));
  });

  afterEach(async () => {
    await listener.stop();
  });

  /** Write bytes on a bare socket, then close. Never throws for the caller. */
  async function speakRaw(text: string, closeAfterMs = 50): Promise<void> {
    await new Promise<void>((resolve) => {
      const sock = netConnect({ host: LOOPBACK, port }, () => {
        sock.pause();
        sock.write(text);
        setTimeout(() => sock.destroy(), closeAfterMs);
      });
      sock.on('error', () => undefined); // the drop is the point
      sock.on('close', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 25));
  }

  it('a Content-Length that overstates the body is refused, not believed', async () => {
    // The declared size is over the cap, so the allocation guard refuses it on
    // the header alone — the sender never gets to make the server buffer
    // 4 KiB, let alone the 4 GiB it claimed. The body that follows is a
    // fraction of the declared length and the connection then drops.
    await speakRaw(
      `POST ${DEFAULT_EVENT_PATH} HTTP/1.1\r\n` +
        `Host: ${LOOPBACK}\r\n` +
        'Content-Type: application/json\r\n' +
        'Content-Length: 4294967296\r\n' +
        '\r\n{"hook_event_name":"Stop"}',
    );

    expect(listener.counters.oversize).toBe(1);
    expect(listener.counters.accepted).toBe(0);
    expect(listener.listening).toBe(true);
    expect((await postJson(port, mainThreadPayload())).status).toBe(200);
  });

  it('an unparseable request line does not stop the next request', async () => {
    // Node rejects this before any of the listener's own code runs; what is
    // being asserted is that the resulting clientError is handled rather than
    // thrown, and that the socket teardown does not take the server with it.
    await speakRaw('NOT-HTTP / GARBAGE\r\n\r\n');
    expect(listener.listening).toBe(true);
    expect(listener.counters.accepted).toBe(0);
    expect((await postJson(port, mainThreadPayload())).status).toBe(200);
  });

  it('a header block that never terminates is dropped, and the server keeps serving', async () => {
    await speakRaw(
      `POST ${DEFAULT_EVENT_PATH} HTTP/1.1\r\nHost: ${LOOPBACK}\r\nX-Never: ending`,
    );
    expect(listener.listening).toBe(true);
    expect(listener.counters.accepted).toBe(0);
    expect((await postJson(port, mainThreadPayload())).status).toBe(200);
  });

  it('two pipelined requests on one socket are both answered', async () => {
    // The hook snippet sends `connection: close`, so pipelining is not how CC
    // talks to this server. It is how anything else on the machine could, and
    // a request framing bug shows up here first.
    const body = '{"session_id":"pipelined","hook_event_name":"Stop"}';
    const one =
      `POST ${DEFAULT_EVENT_PATH} HTTP/1.1\r\nHost: ${LOOPBACK}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${String(body.length)}\r\n\r\n${body}`;
    const seen = await new Promise<string>((resolve) => {
      let text = '';
      const sock = netConnect({ host: LOOPBACK, port }, () => {
        sock.write(one + one);
      });
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => {
        text += chunk;
        if (text.split('HTTP/1.1 200').length - 1 >= 2) sock.destroy();
      });
      sock.on('error', () => undefined);
      sock.on('close', () => resolve(text));
    });
    expect(seen.split('HTTP/1.1 200').length - 1).toBe(2);
    expect(listener.counters.accepted).toBe(2);
    expect(listener.listening).toBe(true);
  });
});
