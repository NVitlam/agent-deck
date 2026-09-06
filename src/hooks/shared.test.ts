/**
 * v0.7.0 Phase 1b — the shared listener, DoD 1b.1 through 1b.6.
 *
 * EVERYTHING HERE RUNS OVER REAL LOOPBACK SOCKETS. There is no fake server and
 * no injected transport: the defect this phase fixes is a real `EADDRINUSE` on
 * a real bind, and a suite that mocked the socket would be asserting that our
 * model of a socket behaves the way we modelled it. The two things that ARE
 * injected are the ones a test cannot otherwise pin — the failover scheduler
 * and its jitter source — for the reason every clock in this repository is
 * injected.
 *
 * THE LEADER IN MOST OF THESE TESTS IS A PLAIN `HookListener`, DELIBERATELY.
 * Every leader-side behaviour Phase 1b adds — the two routes, the redaction,
 * the broadcast — lives in `listener.ts`, so a plain listener on an ephemeral
 * port is a complete leader and needs no test-only option forwarded through
 * `SharedHookListener` to get one. Where a `SharedHookListener` must itself BE
 * a leader (1b.6) it gets there the way the product does: by binding the fixed
 * port the previous leader released.
 */

import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, ToolNode, TreeNode } from '../model/events.js';
import type { NormalizedHookEvent } from '../model/events.js';
import type { CodexHookEvent } from '../codex/liveness.js';
import { joinTelemetry } from '../otel/join.js';
import { parseOtlpBody } from '../otel/parse.js';
import type { TelemetrySlice } from '../otel/parse.js';
import { DEFAULT_MAX_PAYLOAD_BYTES } from '../parser/redact.js';
import { ManualTime } from '../parser/tailer.js';
import { HookListener } from './listener.js';
import {
  EVENTS_PATH,
  IDENTITY_PATH,
  REBIND_BACKOFF_MAX_MS,
  REBIND_BACKOFF_MIN_MS,
  RELAY_API_VERSION,
  RELAY_ENVELOPE_KINDS,
  RELAY_PRODUCT,
  backoffDelayMs,
  decodeSseFrame,
  encodeSseFrame,
  isLeaderIdentity,
  isPathUnder,
  ownsRelayedPayload,
  splitFrames,
} from './relay.js';
import { SharedHookListener } from './shared.js';

const REPO_ROOT = join(__dirname, '..', '..');
const HOOK_FIXTURE = join(REPO_ROOT, 'fixtures', 'hook-events', 'cc-2.1.234-redacted.jsonl');
const OTEL_TRACES = join(REPO_ROOT, 'fixtures', 'otel-cc-2.1.260', 'traces.jsonl');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const openLeaders: HookListener[] = [];
const openShared: SharedHookListener[] = [];
const openServers: Server[] = [];

afterEach(async () => {
  for (const s of openShared.splice(0)) await s.stop();
  for (const l of openLeaders.splice(0)) await l.stop();
  for (const s of openServers.splice(0)) await closeServer(s);
});

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

/**
 * A leader on an OS-assigned port.
 *
 * Port 0 is bound by the listener ITSELF rather than probed-then-bound,
 * because the probe-and-bind form hands out a number anything on the machine
 * may take in between — the recorded race that made this suite intermittently
 * red with the very error code this phase is about.
 */
async function startLeader(options: { previewBytes?: number; relay?: boolean } = {}): Promise<{
  leader: HookListener;
  port: number;
}> {
  const leader = new HookListener({
    port: 0,
    allowEphemeralPort: true,
    ...(options.previewBytes !== undefined ? { relayPreviewBytes: options.previewBytes } : {}),
    ...(options.relay === false ? { enableRelay: false } : {}),
  });
  await leader.start();
  openLeaders.push(leader);
  const bound = leader.address();
  if (bound === null || bound.port === 0) throw new Error('leader reported no bound port');
  return { leader, port: bound.port };
}

/** A leader that takes a NAMED port — for the failover races. */
async function startLeaderOn(port: number): Promise<HookListener> {
  const leader = new HookListener({ port });
  await leader.start();
  openLeaders.push(leader);
  return leader;
}

function track(shared: SharedHookListener): SharedHookListener {
  openShared.push(shared);
  return shared;
}

interface Stranger {
  server: Server;
  port: number;
  requests: string[];
}

/** Something that holds a port and is not us. */
async function startStranger(
  respond: (path: string) => { status: number; body: string } | null,
  port = 0,
): Promise<Stranger> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method ?? '?'} ${req.url ?? '?'}`);
    const reply = respond(req.url ?? '');
    if (reply === null) {
      // Accept and never answer: the shape a bare `createServer()` has, and
      // the case the probe timeout exists for.
      req.resume();
      return;
    }
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.body);
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stranger has no port');
  return { server, port: address.port, requests };
}

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function get(port: number, path: string, method = 'GET'): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers: { connection: 'close' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5_000, () => {
      req.destroy(new Error('timeout'));
    });
    req.end();
  });
}

function post(port: number, payload: unknown): Promise<number> {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/event',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.length),
          connection: 'close',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Open a raw SSE reader, so a claim about BYTES is checked below every decoder. */
async function rawStream(port: number): Promise<{ text: () => string }> {
  const chunks: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: EVENTS_PATH }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => chunks.push(c));
      resolve();
    });
    req.on('error', reject);
    req.end();
  });
  return { text: () => chunks.join('') };
}

/**
 * Wait for a condition, or fail naming what was being waited for.
 *
 * Bounded and polled rather than slept on: a fixed sleep is a test that passes
 * or fails by CPU load, which this repository has paid for twice.
 */
async function until(what: string, predicate: () => boolean, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function mainThreadPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'sess-1',
    transcript_path: 'C:\\ws\\one\\.claude\\projects\\slug\\sess-1.jsonl',
    cwd: 'C:\\ws\\one',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_1',
    ...over,
  };
}

/** A follower that owns everything, for tests whose subject is not the filter. */
function followerOwningAll(
  port: number,
  over: Record<string, unknown> = {},
): SharedHookListener {
  return track(new SharedHookListener({ port, tailsSession: () => true, ...over }));
}

/** The minimum `SessionState` a telemetry join needs. Mirrors `join.test.ts`. */
function stateWith(sessionId: string, toolIds: readonly string[]): SessionState {
  const children: TreeNode[] = toolIds.map((id, index) => ({
    id,
    toolName: 'Bash',
    status: 'done',
    inputPreview: '{}',
    inputHash: 'x'.repeat(64),
    ordinal: index,
  }) as ToolNode);
  const root: AgentNode = {
    id: 'root',
    kind: 'main',
    label: 'root',
    status: 'done',
    spawnDepth: 0,
    children,
    startedAt: 0,
  };
  return {
    sessionId,
    projectSlug: 'p',
    workspaceMatch: true,
    liveness: 'idle',
    schemaOk: true,
    root,
    totals: { costUsd: 0 },
  };
}

// ---------------------------------------------------------------------------
// 1b.1 — the identity route
// ---------------------------------------------------------------------------

describe('1b.1 identity route', () => {
  it('GET answers the exact document the locked block names', async () => {
    const { port } = await startLeader();
    const reply = await get(port, IDENTITY_PATH);
    expect(reply.status).toBe(200);
    expect(String(reply.headers['content-type'])).toContain('application/json');
    expect(JSON.parse(reply.body)).toEqual({
      product: RELAY_PRODUCT,
      apiVersion: RELAY_API_VERSION,
      role: 'leader',
    });
    // The follower's own guard agrees with what the leader serves. Two agreeing
    // literals is not a contract; this drives both halves against one document.
    expect(isLeaderIdentity(JSON.parse(reply.body))).toBe(true);
  });

  it('every other method on that path is 404, not 405', async () => {
    const { leader, port } = await startLeader();
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      expect((await get(port, IDENTITY_PATH, method)).status, method).toBe(404);
    }
    // ...and the listener is still serving, which is the half a 404 test can
    // pass while the socket has quietly died.
    expect(await post(port, mainThreadPayload())).toBe(200);
    expect(leader.counters.accepted).toBe(1);
  });

  it('every other path near the relay prefix is 404', async () => {
    const { port } = await startLeader();
    for (const path of [
      '/agent-deck',
      '/agent-deck/',
      '/agent-deck/identity/',
      '/agent-deck/identity/extra',
      '/agent-deck/Identity',
      '/agent-deck/events/extra',
      '/agent-deck/anything',
    ]) {
      expect((await get(port, path)).status, path).toBe(404);
    }
  });

  it('counts the probes, so "nobody asked" differs from "nobody answered"', async () => {
    const { leader, port } = await startLeader();
    expect(leader.counters.identityProbes).toBe(0);
    await get(port, IDENTITY_PATH);
    await get(port, IDENTITY_PATH);
    expect(leader.counters.identityProbes).toBe(2);
    // A refused method is not a probe: nothing was told anything.
    await get(port, IDENTITY_PATH, 'POST');
    expect(leader.counters.identityProbes).toBe(2);
  });

  it('the events route is 404 when relaying is off, and 200 when it is on', async () => {
    const off = await startLeader({ relay: false });
    expect((await get(off.port, EVENTS_PATH)).status).toBe(404);

    // The control that stops the line above passing for the wrong reason.
    const on = await startLeader();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: on.port, path: EVENTS_PATH }, (res) => {
        const code = res.statusCode ?? 0;
        res.destroy();
        resolve(code);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 1b.2 — follower attach
// ---------------------------------------------------------------------------

describe('1b.2 follower attach', () => {
  it('a second instance fails to bind, probes, subscribes, and receives', async () => {
    const { leader, port } = await startLeader();

    const seen: NormalizedHookEvent[] = [];
    const follower = followerOwningAll(port);
    follower.subscribe((event) => {
      seen.push(event);
    });
    await follower.start();

    expect(follower.role).toBe('follower');
    // IT HOLDS NO SOCKET AND IS STILL RECEIVING. The two getters are separate
    // precisely so the host cannot paint "no hook events" over a live window.
    expect(follower.bound).toBe(false);
    expect(follower.address()).toBeNull();
    expect(follower.listening).toBe(true);
    await until('the leader to register a follower', () => leader.followerCount === 1);

    expect(await post(port, mainThreadPayload())).toBe(200);
    await until('the relayed event to reach the follower', () => seen.length === 1);

    const event = seen[0] as NormalizedHookEvent;
    expect(event.sessionId).toBe('sess-1');
    expect(event.toolName).toBe('Bash');
    expect(event.isMainThread).toBe(true);
    // The follower's own sequence, not the leader's: a relayed event enters
    // this window's pipeline as if it had arrived on this window's socket.
    expect(event.seq).toBe(1);
    expect(follower.relayCounters.received).toBe(1);
    expect(leader.counters.relayFramesSent).toBeGreaterThanOrEqual(1);
  });

  it("a Codex payload reaches a follower's Codex handlers and never its CC ones", async () => {
    const { port } = await startLeader();
    const cc: NormalizedHookEvent[] = [];
    const codex: CodexHookEvent[] = [];
    const follower = followerOwningAll(port);
    follower.subscribe((e) => cc.push(e));
    follower.subscribeCodex((e) => codex.push(e));
    await follower.start();
    await until('subscription', () => follower.listening);

    // The discriminator is the PRESENCE of `model`, never its value — decided
    // on the same bytes by the same rule at both ends.
    await post(port, mainThreadPayload({ model: 'gpt-5.6-terra' }));
    await until('the Codex frame', () => codex.length === 1);
    expect(cc).toHaveLength(0);
    expect((codex[0] as CodexHookEvent).payload).toMatchObject({ tool_name: 'Bash' });

    // And the control: the identical payload WITHOUT the key goes the other way.
    await post(port, mainThreadPayload());
    await until('the CC frame', () => cc.length === 1);
    expect(codex).toHaveLength(1);
  });

  it('a stranger on the port is refused, and is asked exactly once', async () => {
    // A stranger that answers JSON — but not OUR JSON. The interesting case: a
    // timeout is easy to get right, a plausible wrong answer is not.
    const stranger = await startStranger(() => ({
      status: 200,
      body: JSON.stringify({ product: 'something-else', apiVersion: 1, role: 'leader' }),
    }));

    const follower = followerOwningAll(stranger.port);
    await expect(follower.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(follower.role).toBe('refused');
    expect(follower.listening).toBe(false);

    // ONE probe, and no subscription attempt beyond it. A follower that
    // hammered a stranger with retries would behave badly toward a process it
    // has no business talking to at all.
    expect(stranger.requests).toEqual([`GET ${IDENTITY_PATH}`]);
  });

  it('a stranger that never answers is refused on the probe budget', async () => {
    const stranger = await startStranger(() => null);
    const follower = followerOwningAll(stranger.port);
    const started = Date.now();
    await expect(follower.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(follower.role).toBe('refused');
    // Bounded by the probe budget, not by a TCP timeout.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(stranger.requests).toEqual([`GET ${IDENTITY_PATH}`]);
  });

  it('a stranger whose identity document is enormous is refused, not read', async () => {
    const stranger = await startStranger(() => ({
      status: 200,
      body: JSON.stringify({
        product: RELAY_PRODUCT,
        apiVersion: 1,
        role: 'leader',
        pad: 'x'.repeat(64 * 1024),
      }),
    }));
    const follower = followerOwningAll(stranger.port);
    await expect(follower.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(follower.role).toBe('refused');
  });

  it('two followers both receive, and the follower count is a gauge', async () => {
    const { leader, port } = await startLeader();
    const a: NormalizedHookEvent[] = [];
    const b: NormalizedHookEvent[] = [];
    const one = followerOwningAll(port);
    const two = followerOwningAll(port);
    one.subscribe((e) => a.push(e));
    two.subscribe((e) => b.push(e));
    await one.start();
    await two.start();
    await until('both followers attached', () => leader.followerCount === 2);

    await post(port, mainThreadPayload());
    await until('both received', () => a.length === 1 && b.length === 1);

    await two.stop();
    // A GAUGE: it goes DOWN. Every other counter on the listener only rises,
    // which is why the field's own doc comment says so out loud.
    await until('the gauge to fall', () => leader.counters.relayFollowers === 1);
    expect(leader.followerCount).toBe(1);
  });

  it('a handler that throws takes down neither the tap nor another handler', async () => {
    const { port } = await startLeader();
    const good: NormalizedHookEvent[] = [];
    const follower = followerOwningAll(port);
    follower.subscribe(() => {
      throw new Error('a consumer exploded');
    });
    follower.subscribe((e) => good.push(e));
    await follower.start();
    await until('subscription', () => follower.listening);

    await post(port, mainThreadPayload());
    await post(port, mainThreadPayload({ tool_use_id: 'toolu_2' }));
    await until('both events past the throwing handler', () => good.length === 2);
    expect(follower.listening).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1b.3 — redaction before relay (G4)
// ---------------------------------------------------------------------------

describe('1b.3 redaction happens before the frame exists', () => {
  it('an over-limit tool_input reaches the follower already truncated', async () => {
    const previewBytes = 1_024;
    const { port } = await startLeader({ previewBytes });
    const seen: NormalizedHookEvent[] = [];
    const follower = followerOwningAll(port);
    follower.subscribe((e) => seen.push(e));
    await follower.start();
    await until('subscription', () => follower.listening);

    const huge = 'A'.repeat(64 * 1024);
    await post(port, mainThreadPayload({ tool_input: { command: huge } }));
    await until('the frame', () => seen.length === 1);

    const relayed = (seen[0] as NormalizedHookEvent).raw as Record<string, unknown>;
    const command = (relayed['tool_input'] as Record<string, unknown>)['command'] as string;
    expect(command.length).toBeLessThan(huge.length);
    expect(command).toContain('agent-deck');
    // The cut is the CEILING'S and not an accident of chunking: exactly
    // `previewBytes` of the original survive, and not one byte more.
    expect(command.startsWith('A'.repeat(previewBytes))).toBe(true);
    expect(command.startsWith('A'.repeat(previewBytes + 1))).toBe(false);
  });

  it('no thinking or signature bytes cross the events route', async () => {
    const { port } = await startLeader();
    const frames: string[] = [];
    const follower = followerOwningAll(port);
    follower.subscribe((e) => frames.push(JSON.stringify(e.raw)));
    await follower.start();
    await until('subscription', () => follower.listening);

    // The literal-bytes pattern G4 uses. An assertion that a redactor "dropped
    // a block" passes for a redactor that dropped the wrong one.
    const SECRET_THINKING = 'SECRET-REASONING-9f3a';
    const SECRET_SIGNATURE = 'CAIS-SECRET-SIGNATURE-9f3a';
    await post(
      port,
      mainThreadPayload({
        tool_input: {
          content: [
            { type: 'thinking', thinking: SECRET_THINKING, signature: SECRET_SIGNATURE },
            { type: 'text', text: 'kept' },
          ],
          signature: SECRET_SIGNATURE,
        },
      }),
    );
    await until('the frame', () => frames.length === 1);

    const wire = frames[0] as string;
    expect(wire).not.toContain(SECRET_THINKING);
    expect(wire).not.toContain(SECRET_SIGNATURE);
    // A VACUITY CONTROL: the rest of the payload DID cross, so the absences
    // above are redaction rather than an empty frame.
    expect(wire).toContain('kept');
    expect(wire).toContain('toolu_1');
  });

  it('the raw body never reaches the wire, checked below every decoder', async () => {
    // The claim is about BYTES, and a claim about bytes checked after parsing
    // has been checked one layer too late.
    const { port } = await startLeader({ previewBytes: 256 });
    const stream = await rawStream(port);
    await until('the stream head', () => stream.text().includes('agent-deck relay'));

    const secret = 'Z'.repeat(4096);
    await post(port, mainThreadPayload({ tool_input: { blob: secret } }));
    await until('a data frame', () => stream.text().includes('data:'));

    expect(stream.text()).not.toContain(secret);
    expect(stream.text()).toContain('sess-1');
  });

  it("the relay ceiling defaults to the parse boundary's, never to 'no ceiling'", async () => {
    const { port } = await startLeader(); // no previewBytes given
    const seen: NormalizedHookEvent[] = [];
    const follower = followerOwningAll(port);
    follower.subscribe((e) => seen.push(e));
    await follower.start();
    await until('subscription', () => follower.listening);

    await post(port, mainThreadPayload({ tool_input: { blob: 'B'.repeat(32 * 1024) } }));
    await until('the frame', () => seen.length === 1);
    const input = ((seen[0] as NormalizedHookEvent).raw as Record<string, unknown>)[
      'tool_input'
    ] as Record<string, unknown>;
    const blob = input['blob'] as string;
    expect(blob.startsWith('B'.repeat(DEFAULT_MAX_PAYLOAD_BYTES))).toBe(true);
    expect(blob.startsWith('B'.repeat(DEFAULT_MAX_PAYLOAD_BYTES + 1))).toBe(false);
  });

  it('the leader still hands its OWN consumers the unredacted payload', async () => {
    // The redaction is for the RELAY. A leader window's own liveness path is
    // unchanged by this phase, and asserting so keeps a later reader from
    // "tidying" the redaction up into the dispatch path and silently changing
    // what the panel is fed.
    const { leader, port } = await startLeader({ previewBytes: 16 });
    const local: NormalizedHookEvent[] = [];
    leader.subscribe((e) => local.push(e));
    await post(port, mainThreadPayload({ tool_input: { command: 'C'.repeat(1024) } }));
    await until('the local event', () => local.length === 1);
    const raw = (local[0] as NormalizedHookEvent).raw as Record<string, unknown>;
    const command = (raw['tool_input'] as Record<string, unknown>)['command'] as string;
    expect(command).toHaveLength(1024);
  });
});

// ---------------------------------------------------------------------------
// 1b.4 — the ownership filter
// ---------------------------------------------------------------------------

describe('1b.4 ownership filter (fixture-driven)', () => {
  const OWN = 'C:\\Users\\dev\\projects\\agent-deck';
  const OTHER = 'C:\\Users\\dev\\projects\\other-thing';
  /** The prefix trap: a sibling whose path starts with the whole of OWN. */
  const SIBLING = 'C:\\Users\\dev\\projects\\agent-deck-lab';

  async function fixturePayloads(): Promise<Record<string, unknown>[]> {
    const text = await readFile(HOOK_FIXTURE, 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('the fixture is what this test thinks it is', async () => {
    // The census, stated so a re-harvest that moves it fails HERE with a
    // readable reason rather than three assertions down as a mystery.
    const rows = await fixturePayloads();
    expect(rows).toHaveLength(285);
    const cwds = new Set(rows.map((r) => r['cwd'] as string));
    expect(cwds.size).toBe(5);
    // BOTH drive-letter cases occur in one capture, which is why the filter
    // compares case-insensitively rather than by exact string.
    expect([...cwds].some((c) => c.startsWith('C:\\'))).toBe(true);
    expect([...cwds].some((c) => c.startsWith('c:\\'))).toBe(true);
    // And three of the five are subdirectories, not the workspace root — so
    // containment is genuinely exercised rather than equality wearing its coat.
    expect([...cwds].filter((c) => c.toLowerCase() !== OWN.toLowerCase())).toHaveLength(3);
  });

  it('a window keeps every fixture event for its own workspace, and none for another', async () => {
    const rows = await fixturePayloads();
    const mine = { tailsSession: () => false, workspacePaths: [OWN] };
    const theirs = { tailsSession: () => false, workspacePaths: [OTHER] };
    expect(rows.filter((r) => ownsRelayedPayload(r, mine))).toHaveLength(285);
    expect(rows.filter((r) => ownsRelayedPayload(r, theirs))).toHaveLength(0);
  });

  it('a sibling whose name merely starts with the workspace owns nothing', async () => {
    // `...\agent-deck-lab` starts with `...\agent-deck`. A filter built on the
    // prefix alone would hand one window another window's sessions and look
    // entirely correct doing it.
    const rows = await fixturePayloads();
    const sibling = { tailsSession: () => false, workspacePaths: [SIBLING] };
    expect(rows.filter((r) => ownsRelayedPayload(r, sibling))).toHaveLength(0);
    expect(isPathUnder(SIBLING, OWN)).toBe(false);
    expect(isPathUnder(`${OWN}\\src`, OWN)).toBe(true);
    expect(isPathUnder(OWN, OWN)).toBe(true);
    // Separator and trailing-slash forms are the same path, not three paths.
    expect(isPathUnder('C:/Users/dev/projects/agent-deck/src', `${OWN}\\`)).toBe(true);
  });

  it('a session this window tails is kept whatever its cwd says', async () => {
    // The disjunction's second arm, and the one that matters for a subagent:
    // its `cwd` is the agent's worktree, which is not under the spawning
    // window's workspace in every layout.
    const foreignCwd = { session_id: 'sess-9', cwd: 'D:\\somewhere\\else' };
    expect(
      ownsRelayedPayload(foreignCwd, {
        tailsSession: (id) => id === 'sess-9',
        workspacePaths: [OWN],
      }),
    ).toBe(true);
    expect(
      ownsRelayedPayload(foreignCwd, { tailsSession: () => false, workspacePaths: [OWN] }),
    ).toBe(false);
  });

  it('a payload with neither key is dropped, and nothing throws', () => {
    const ctx = { tailsSession: () => false, workspacePaths: [OWN] };
    for (const junk of [
      null,
      undefined,
      42,
      'text',
      [],
      {},
      { cwd: 5 },
      { session_id: {} },
      { cwd: '' },
      { session_id: '' },
    ]) {
      expect(ownsRelayedPayload(junk, ctx)).toBe(false);
    }
  });

  it("end to end: two windows on one leader, and neither sees the other's events", async () => {
    const { port } = await startLeader();
    const rows = await fixturePayloads();

    const mineSeen: NormalizedHookEvent[] = [];
    const theirsSeen: NormalizedHookEvent[] = [];
    const mine = track(new SharedHookListener({ port, workspacePaths: [OWN] }));
    const theirs = track(new SharedHookListener({ port, workspacePaths: [OTHER] }));
    mine.subscribe((e) => mineSeen.push(e));
    theirs.subscribe((e) => theirsSeen.push(e));
    await mine.start();
    await theirs.start();
    await until('both attached', () => mine.listening && theirs.listening);

    // Ten real captured payloads, POSTed at the one shared port exactly as two
    // real Claude Code sessions would.
    for (const row of rows.slice(0, 10)) await post(port, row);

    await until('the owning window to receive all ten', () => mineSeen.length === 10);
    // ...and the other window RECEIVED them and threw them away. That is a
    // different claim from "received nothing", and it is the one that proves
    // the FILTER ran rather than the relay having quietly failed.
    await until('the other window to drop all ten', () => theirs.relayCounters.droppedForeign === 10);
    expect(theirsSeen).toHaveLength(0);
    expect(theirs.relayCounters.received).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 1b.5 — telemetry relay (Component 12)
// ---------------------------------------------------------------------------

describe('1b.5 telemetry relay', () => {
  async function traceSlice(): Promise<TelemetrySlice> {
    const text = await readFile(OTEL_TRACES, 'utf8');
    const bodies = text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => (JSON.parse(l) as { raw: string }).raw);
    const slices = bodies.map((b) => parseOtlpBody(b, 'traces'));
    const first = slices[0];
    if (first === undefined) throw new Error('the otel fixture produced no slice');
    return slices.reduce<TelemetrySlice>(
      (acc, s) => ({
        toolSpans: [...acc.toolSpans, ...s.toolSpans],
        costPoints: [...acc.costPoints, ...s.costPoints],
        counts: s.counts,
      }),
      { toolSpans: [], costPoints: [], counts: first.counts },
    );
  }

  it('the follower receives the same slice the leader parsed', async () => {
    const { leader, port } = await startLeader();
    const received: { signal: string; slice: TelemetrySlice }[] = [];
    const follower = followerOwningAll(port);
    follower.subscribeOtel((signal, slice) => received.push({ signal, slice }));
    await follower.start();
    await until('subscription', () => follower.listening);

    const slice = await traceSlice();
    expect(slice.toolSpans.length).toBeGreaterThan(0);
    leader.relayTelemetry('traces', slice);
    await until('the telemetry frame', () => received.length === 1);

    expect(received[0]?.signal).toBe('traces');
    expect(received[0]?.slice.toolSpans).toEqual(slice.toolSpans);
    expect(received[0]?.slice.costPoints).toEqual(slice.costPoints);
    // TYPES, not only values: a JSON wire is exactly where a number becomes a
    // string, and `durationMs` feeds arithmetic downstream.
    for (const span of received[0]?.slice.toolSpans ?? []) {
      expect(typeof span.durationMs).toBe('number');
      expect(typeof span.sessionId).toBe('string');
    }
  });

  it("the follower's join equals the leader's on the otel-cc fixture", async () => {
    const { leader, port } = await startLeader();
    const received: TelemetrySlice[] = [];
    const follower = followerOwningAll(port);
    follower.subscribeOtel((_signal, slice) => received.push(slice));
    await follower.start();
    await until('subscription', () => follower.listening);

    const slice = await traceSlice();
    leader.relayTelemetry('traces', slice);
    await until('the frame', () => received.length === 1);

    // Asserted on the JOIN'S OUTPUT and not only on the slice's fields: a slice
    // that survived the wire but joined differently would satisfy the weaker
    // claim, and the join is what Component 12 exists for.
    const bySession = new Map<string, string[]>();
    for (const span of slice.toolSpans) {
      const ids = bySession.get(span.sessionId) ?? [];
      ids.push(span.toolUseId);
      bySession.set(span.sessionId, ids);
    }
    const states = [...bySession].map(([id, ids]) => stateWith(id, ids));
    expect(states.length).toBeGreaterThan(0);

    const here = joinTelemetry(states, slice);
    const there = joinTelemetry(states, received[0] as TelemetrySlice);
    expect(there.states).toEqual(here.states);
    expect(there.report).toEqual(here.report);
    // Vacuity control: the join actually matched something. Two joins that
    // both matched nothing are also "equal".
    expect(here.report.spansMatched).toBeGreaterThan(0);
  });

  it('no OTLP body and no identity attribute crosses the wire', async () => {
    // Why the envelope carries a SLICE and not a body: the five identity
    // attributes occur on 850 of 850 records of this corpus, and an attribute
    // that never reaches the relay cannot leak from it whatever anyone forgets.
    const { leader, port } = await startLeader();
    const stream = await rawStream(port);
    await until('the stream head', () => stream.text().includes('agent-deck relay'));

    leader.relayTelemetry('traces', await traceSlice());
    await until('a data frame', () => stream.text().includes('data:'));

    const wire = stream.text();
    for (const key of [
      'user.email',
      'user.id',
      'user.account_id',
      'user.account_uuid',
      'organization.id',
    ]) {
      expect(wire, `${key} reached the relay`).not.toContain(key);
    }
    expect(wire).not.toContain('resourceSpans');
    // Vacuity control: something DID cross, so the absences above are the
    // envelope's shape rather than an empty frame.
    expect(wire).toContain('toolSpans');
  });
});

// ---------------------------------------------------------------------------
// 1b.6 — failover
// ---------------------------------------------------------------------------

describe('1b.6 failover', () => {
  /** A follower on a fake clock, so every delay below is a measurement. */
  function failoverFollower(port: number, time: ManualTime, jitter = 1): SharedHookListener {
    return track(
      new SharedHookListener({
        port,
        tailsSession: () => true,
        scheduler: time,
        random: () => jitter,
      }),
    );
  }

  it('the leader closing makes a follower the leader, and it serves the route', async () => {
    const { leader, port } = await startLeader();
    const time = new ManualTime(0);
    const follower = failoverFollower(port, time);
    const seen: NormalizedHookEvent[] = [];
    follower.subscribe((e) => seen.push(e));
    await follower.start();
    await until('attached', () => follower.listening);

    await leader.stop();
    await until('the follower to notice', () => follower.relayCounters.failovers === 1);
    await until('the first attempt to be armed', () => time.pendingTimers > 0);

    // THE FIRST ATTEMPT IS ARMED AT ZERO DELAY, deliberately: a lost leader is
    // a race to enter, not a queue to wait in. Backing off before the first
    // try would spend a whole window on a port that is already free.
    time.advance(0);
    await until('the follower to become leader', () => follower.role === 'leader');
    expect(time.now()).toBe(0);
    expect(follower.relayCounters.rebindAttempts).toBe(1);
    expect(follower.bound).toBe(true);
    expect(follower.listening).toBe(true);

    // It serves the route it now owns, and a third window attaches to it.
    expect((await get(port, IDENTITY_PATH)).status).toBe(200);
    const third = followerOwningAll(port);
    const thirdSeen: NormalizedHookEvent[] = [];
    third.subscribe((e) => thirdSeen.push(e));
    await third.start();
    expect(third.role).toBe('follower');

    // Events flow again — to the new leader's own handlers and to the third.
    await post(port, mainThreadPayload());
    await until('the new leader to receive', () => seen.length === 1);
    await until('the third window to receive', () => thirdSeen.length === 1);
  });

  it('a lost race costs at most one backoff window, and the window is the locked one', async () => {
    const { leader, port } = await startLeader();
    const time = new ManualTime(0);
    const follower = failoverFollower(port, time); // jitter pinned to the ceiling
    await follower.start();
    await until('attached', () => follower.listening);

    await leader.stop();
    await until('the first attempt to be armed', () => time.pendingTimers > 0);

    // A STRANGER takes the port before the first attempt fires. This is the
    // case that actually costs a backoff, and it is why the bound is stated in
    // the DoD at all — the uncontested changeover above costs nothing.
    const stranger = await startStranger(() => ({ status: 404, body: '{}' }), port);
    time.advance(0);
    await until('the lost attempt', () => follower.relayCounters.rebindAttempts === 1);
    expect(follower.role).toBe('follower'); // still not leader, still not refused

    await until('the next attempt to be armed', () => time.pendingTimers > 0);
    await closeServer(stranger.server);
    openServers.splice(openServers.indexOf(stranger.server), 1);

    time.advance(REBIND_BACKOFF_MAX_MS);
    await until('the second attempt to win', () => follower.role === 'leader');

    // ONE backoff window, measured on the fake clock rather than hoped for.
    expect(time.now()).toBe(REBIND_BACKOFF_MAX_MS);
    expect(follower.relayCounters.rebindAttempts).toBe(2);
  });

  it('a window that loses the race to another Agent Deck re-subscribes instead', async () => {
    const { leader, port } = await startLeader();
    const time = new ManualTime(0);
    const follower = failoverFollower(port, time);
    const seen: NormalizedHookEvent[] = [];
    follower.subscribe((e) => seen.push(e));
    await follower.start();
    await until('attached', () => follower.listening);

    await leader.stop();
    await until('the first attempt to be armed', () => time.pendingTimers > 0);

    // A THIRD WINDOW wins the port first. The loser must follow it, not keep
    // hammering the bind — "the winner becomes leader; losers re-subscribe".
    const newLeader = await startLeaderOn(port);
    time.advance(0);
    await until('the loser to re-subscribe', () => follower.role === 'follower' && follower.listening);
    expect(follower.bound).toBe(false);

    await post(port, mainThreadPayload());
    await until('events flowing through the new leader', () => seen.length === 1);
    expect(newLeader.counters.accepted).toBe(1);
  });

  it('the events inside the gap are lost, and nothing pretends otherwise', async () => {
    const { leader, port } = await startLeader();
    const time = new ManualTime(0);
    const follower = failoverFollower(port, time);
    const seen: NormalizedHookEvent[] = [];
    follower.subscribe((e) => seen.push(e));
    await follower.start();
    await until('attached', () => follower.listening);

    await post(port, mainThreadPayload({ tool_use_id: 'before' }));
    await until('the first event', () => seen.length === 1);

    await leader.stop();
    // IN THE GAP nothing is bound, so this POST is refused at the socket. That
    // is the loss the design accepts; asserting it is what stops a later
    // reader assuming a queue exists that this product has no store for.
    await expect(post(port, mainThreadPayload({ tool_use_id: 'during' }))).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });

    await until('the first attempt to be armed', () => time.pendingTimers > 0);
    time.advance(0);
    await until('the rebind', () => follower.role === 'leader');

    await post(port, mainThreadPayload({ tool_use_id: 'after' }));
    await until('the event after the rebind', () => seen.length === 2);
    expect(seen.map((e) => e.toolUseId)).toEqual(['before', 'after']);
  });

  it('a failover is counted once however many ways one socket reports itself lost', async () => {
    const { leader, port } = await startLeader();
    const time = new ManualTime(0);
    const follower = failoverFollower(port, time, 0);
    await follower.start();
    await until('attached', () => follower.listening);
    await leader.stop();
    await until('the first attempt to be armed', () => time.pendingTimers > 0);
    time.advance(0);
    await until('the rebind', () => follower.role === 'leader');
    // 'end', 'close' and 'error' can all arrive for one broken socket. Counted
    // three times, the diagnostics line would say the leader died three times.
    expect(follower.relayCounters.failovers).toBe(1);
  });

  it('stop() during a backoff arms nothing further', async () => {
    const { leader, port } = await startLeader();
    const time = new ManualTime(0);
    const follower = failoverFollower(port, time);
    await follower.start();
    await until('attached', () => follower.listening);
    await leader.stop();
    await until('the first attempt to be armed', () => time.pendingTimers > 0);

    await follower.stop();
    expect(time.pendingTimers).toBe(0);
    expect(follower.role).toBe('idle');
    // And a fired timer after a stop is a no-op rather than a resurrection.
    time.advance(REBIND_BACKOFF_MAX_MS * 4);
    expect(follower.role).toBe('idle');
    expect(follower.bound).toBe(false);
  });

  it('the backoff stays inside the locked bounds at both ends of the jitter', () => {
    expect(backoffDelayMs(() => 0)).toBe(REBIND_BACKOFF_MIN_MS);
    expect(backoffDelayMs(() => 1)).toBe(REBIND_BACKOFF_MAX_MS);
    // An out-of-range jitter source is clamped rather than trusted.
    expect(backoffDelayMs(() => -5)).toBe(REBIND_BACKOFF_MIN_MS);
    expect(backoffDelayMs(() => 9)).toBe(REBIND_BACKOFF_MAX_MS);
    for (let i = 0; i < 200; i++) {
      const d = backoffDelayMs(Math.random);
      expect(d).toBeGreaterThanOrEqual(REBIND_BACKOFF_MIN_MS);
      expect(d).toBeLessThanOrEqual(REBIND_BACKOFF_MAX_MS);
    }
  });
});

// ---------------------------------------------------------------------------
// The protocol, as units
// ---------------------------------------------------------------------------

describe('relay protocol', () => {
  it('a frame round-trips, and a frame from another version does not decode', () => {
    const envelope = { v: RELAY_API_VERSION, kind: 'hook' as const, payload: { a: 1 } };
    const frame = encodeSseFrame(envelope);
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(decodeSseFrame(frame.trimEnd())).toEqual(envelope);

    // A version this build does not speak is REFUSED, not read for the fields
    // it happens to recognise — the fingerprint's rule, applied to the wire.
    // Two Agent Deck versions side by side is an ordinary state: the user
    // updates the extension and one window has not been reloaded yet.
    const future = `data: ${JSON.stringify({ ...envelope, v: RELAY_API_VERSION + 1 })}`;
    expect(decodeSseFrame(future)).toBeUndefined();
  });

  it('every malformed frame decodes to undefined rather than throwing', () => {
    for (const junk of [
      '',
      'data:',
      'data: {',
      'data: null',
      'data: []',
      'data: 42',
      'data: "text"',
      `data: ${JSON.stringify({ v: RELAY_API_VERSION, kind: 'nope' })}`,
      `data: ${JSON.stringify({ v: RELAY_API_VERSION, kind: 'otel', signal: 'bogus', slice: {} })}`,
      `data: ${JSON.stringify({ v: RELAY_API_VERSION, kind: 'otel', signal: 'traces', slice: 5 })}`,
      `data: ${JSON.stringify({ v: RELAY_API_VERSION, kind: 'hook' })}`,
      ': a comment',
    ]) {
      expect(decodeSseFrame(junk), junk).toBeUndefined();
    }
  });

  it('a payload carrying a blank line cannot forge a frame boundary', () => {
    // The property `encodeSseFrame`'s comment rests on: JSON escapes newlines,
    // so a frame is two lines whatever the payload holds. A payload that could
    // inject a boundary could inject a frame.
    const nasty = {
      v: RELAY_API_VERSION,
      kind: 'hook' as const,
      payload: { t: 'a\n\ndata: {"v":1,"kind":"hook","payload":"forged"}' },
    };
    const frame = encodeSseFrame(nasty);
    const split = splitFrames(frame);
    expect(split.frames).toHaveLength(1);
    expect(decodeSseFrame(split.frames[0] as string)).toEqual(nasty);
  });

  it('frames split across chunk boundaries are reassembled, not dropped', () => {
    const a = encodeSseFrame({ v: RELAY_API_VERSION, kind: 'hook', payload: { n: 1 } });
    const b = encodeSseFrame({ v: RELAY_API_VERSION, kind: 'hook', payload: { n: 2 } });
    // Byte by byte: the worst chunking a socket can produce.
    let buffer = '';
    const out: unknown[] = [];
    for (const ch of a + b) {
      buffer += ch;
      const split = splitFrames(buffer);
      buffer = split.rest;
      for (const f of split.frames) out.push(decodeSseFrame(f));
    }
    expect(out).toHaveLength(2);
    expect(out.map((e) => (e as { payload: { n: number } }).payload.n)).toEqual([1, 2]);
    expect(buffer).toBe('');
  });

  it('the decoder handles every declared envelope kind, and only those', () => {
    // The union as DATA, so "the decoder is total" is checked against the list
    // rather than against whichever kinds the tests above happened to use. A
    // fourth kind added without a decoder branch turns this red on the day it
    // is added, not on the day somebody relays one.
    const built: Record<string, unknown> = {
      hook: { v: RELAY_API_VERSION, kind: 'hook', payload: { ok: true } },
      otel: {
        v: RELAY_API_VERSION,
        kind: 'otel',
        signal: 'traces',
        slice: { toolSpans: [], costPoints: [], counts: {} },
      },
    };
    expect(Object.keys(built).sort()).toEqual([...RELAY_ENVELOPE_KINDS].sort());
    for (const kind of RELAY_ENVELOPE_KINDS) {
      const envelope = built[kind];
      expect(envelope, `no sample for kind ${kind}`).toBeDefined();
      expect(decodeSseFrame(encodeSseFrame(envelope as never)), kind).toEqual(envelope);
    }
  });

  it('the identity guard refuses everything that is not exactly the document', () => {
    expect(isLeaderIdentity({ product: RELAY_PRODUCT, apiVersion: 1, role: 'leader' })).toBe(true);
    for (const wrong of [
      null,
      undefined,
      'agent-deck',
      [],
      { product: RELAY_PRODUCT, apiVersion: 1 },
      { product: RELAY_PRODUCT, apiVersion: 2, role: 'leader' },
      { product: RELAY_PRODUCT, apiVersion: '1', role: 'leader' },
      { product: 'agent-deck-lab', apiVersion: 1, role: 'leader' },
      { product: RELAY_PRODUCT, apiVersion: 1, role: 'follower' },
    ]) {
      expect(isLeaderIdentity(wrong), JSON.stringify(wrong)).toBe(false);
    }
  });
});
