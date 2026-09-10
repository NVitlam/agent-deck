/**
 * v0.7.0 DoD 5.0 — the shared listener's relay budget: follower attach plus
 * 1,000 relayed frames, in the `perf` project, first two samples discarded.
 *
 * ## Why this exists
 *
 * Phase 1b's own record and its verifier round said the same thing
 * independently: every budget before this one exercises the tailer, the
 * grafter and the two non-CC engines, and NONE binds a socket, attaches a
 * follower or writes a frame. "The listener's idle cost is unchanged" was the
 * strongest sentence available about the relay, and it was a sentence about
 * the paths that already existed.
 *
 * ## The subject is the production path end to end
 *
 * Each sample attaches a FRESH follower to a leader, then POSTs 1,000 hook
 * payloads to the leader's event route exactly as a user's hook command does
 * — one connection per payload, `connection: close` — and stops the clock
 * when the follower has received the thousandth frame. So one sample pays for:
 * the identity probe and the SSE attach; the leader's parse, normalize and
 * local dispatch; the redaction every relayed payload goes through (G4); the
 * SSE encode and write; the follower's frame split, decode and ownership
 * filter; and its dispatch.
 *
 * The payloads are the 285 real ones in `fixtures/hook-events/`, cycled, not
 * a hand-written stub: the redaction walk and the ownership filter cost what
 * the SHAPE of a payload costs, and a one-field stub would time the socket
 * and none of the work. The follower owns them through its WORKSPACE path
 * rather than through `tailsSession`, so the path comparison runs on every
 * frame instead of short-circuiting on the first branch.
 *
 * ## Why the perf project, and what that costs
 *
 * `vitest.config.ts` runs this project on `pool: 'forks'` for a process
 * boundary: the recorded finding is `.tailPoll` measuring 1050.6 ms under
 * total in-process isolation and 12.3 ms across two processes. A relay budget
 * in the main project would measure the vitest host's state after ninety
 * files. This is also the FIRST socket test in this project, and the config's
 * header records why that is not free — see the note there.
 *
 * ## The first two samples are discarded, and the DoD says so
 *
 * The first attach pays JIT and socket setup that no steady state pays. The
 * discard is written into DoD 5.0 itself so that a warm-up allowance can be
 * told apart from a limit quietly widened, and it is printed below rather than
 * dropped silently.
 */

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HookListener } from '../hooks/listener.js';
import { SharedHookListener } from '../hooks/shared.js';

import { RELAY_BUDGET } from './budgets.js';

/** Frames per sample. The DoD's number. */
const FRAMES = 1_000;
/** Samples discarded before the median. The DoD's number. */
const DISCARDED = 2;
/** Samples the median is taken over. */
const MEASURED = 7;

const FIXTURE = join(
  process.cwd(),
  'fixtures',
  'hook-events',
  'cc-2.1.234-redacted.jsonl',
);

/** Every captured payload, parsed once. Read, never hard-coded. */
const PAYLOADS: Record<string, unknown>[] = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as Record<string, unknown>);

/** The workspace the follower owns: the capture's own `cwd`. */
const WORKSPACE = String(PAYLOADS[0]?.['cwd'] ?? '');

let leader: HookListener;
let port = 0;

beforeAll(async () => {
  // A plain leader on an OS-assigned port, the pattern `shared.test.ts` uses:
  // port 0 is bound by the listener itself, so no number exists outside a
  // bound socket and nothing on the machine can take it in between.
  leader = new HookListener({ port: 0, allowEphemeralPort: true });
  await leader.start();
  const bound = leader.address();
  if (bound === null || bound.port === 0) throw new Error('leader reported no bound port');
  port = bound.port;
}, 30_000);

afterAll(async () => {
  await leader.stop();
});

function post(payload: unknown): Promise<number> {
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

/**
 * Wait for a condition, or fail naming what was being waited for. Polled, not
 * slept on: a fixed sleep is a test that passes or fails by CPU load.
 */
async function until(what: string, predicate: () => boolean, budgetMs = 30_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

interface Sample {
  attachMs: number;
  relayMs: number;
  totalMs: number;
  received: number;
  dispatched: number;
  droppedForeign: number;
}

/** One sample: a fresh follower attaches, then 1,000 frames reach it. */
async function sample(): Promise<Sample> {
  const follower = new SharedHookListener({
    port,
    workspacePaths: [WORKSPACE],
    tailsSession: () => false,
  });
  let dispatched = 0;
  follower.subscribe(() => {
    dispatched += 1;
  });
  follower.subscribeCodex(() => {
    dispatched += 1;
  });
  try {
    const started = performance.now();
    await follower.start();
    const attached = performance.now();
    if (follower.role !== 'follower') throw new Error(`expected a follower, got ${follower.role}`);
    for (let i = 0; i < FRAMES; i += 1) {
      const status = await post(PAYLOADS[i % PAYLOADS.length]);
      if (status !== 200) throw new Error(`POST ${String(i)} answered ${String(status)}`);
    }
    await until('the thousandth frame', () => follower.relayCounters.received >= FRAMES);
    const done = performance.now();
    const counters = follower.relayCounters;
    return {
      attachMs: attached - started,
      relayMs: done - attached,
      totalMs: done - started,
      received: counters.received,
      dispatched,
      droppedForeign: counters.droppedForeign,
    };
  } finally {
    await follower.stop();
    // The leader must have let go of this follower before the next sample, or
    // every later sample writes each frame to a dead socket as well and the
    // budget measures an accumulation this rig created.
    await until('the leader dropping the follower', () => leader.followerCount === 0);
  }
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe('the shared listener relays inside its budget (DoD 5.0)', () => {
  let samples: Sample[] = [];

  beforeAll(async () => {
    samples = [];
    for (let i = 0; i < DISCARDED + MEASURED; i += 1) samples.push(await sample());
  }, 300_000);

  it('THE SUBJECT IS REAL — every sample relayed every frame, and the filter did work', () => {
    // A budget over a relay that delivered nothing would be very fast and would
    // pass. So the subject is asserted by count before anything is timed.
    expect(PAYLOADS.length).toBeGreaterThan(100);
    expect(WORKSPACE).not.toBe('');
    expect(samples).toHaveLength(DISCARDED + MEASURED);
    for (const s of samples) {
      expect(s.received).toBe(FRAMES);
      // Every frame is accounted for: kept by this window or dropped as another
      // window's. None vanished between decode and dispatch.
      expect(s.dispatched + s.droppedForeign).toBe(FRAMES);
      // The capture is one workspace, so the filter kept them — through the
      // path comparison, since `tailsSession` answers false for everything.
      expect(s.dispatched).toBeGreaterThan(0);
    }
    expect(leader.counters.relayFramesSent).toBe(FRAMES * (DISCARDED + MEASURED));
  });

  it('attach + 1,000 frames, median of the samples after the first two', () => {
    const discarded = samples.slice(0, DISCARDED);
    const kept = samples.slice(DISCARDED);
    const value = medianOf(kept.map((s) => s.totalMs));
    // The discarded samples are PRINTED, never dropped silently: a reader has
    // to be able to see what the warm-up allowance allowed.
    process.stdout.write(
      `[perf] relay discarded (warm-up): ${discarded
        .map((s) => `${s.totalMs.toFixed(1)} (attach ${s.attachMs.toFixed(1)})`)
        .join(', ')} ms\n` +
        `[perf] relay kept: ${kept.map((s) => s.totalMs.toFixed(1)).join(', ')} ms; ` +
        `attach median ${medianOf(kept.map((s) => s.attachMs)).toFixed(2)} ms, ` +
        `relay median ${medianOf(kept.map((s) => s.relayMs)).toFixed(1)} ms\n` +
        `[perf] budget ${RELAY_BUDGET.id} (${RELAY_BUDGET.source}, enforced): ` +
        `${value.toFixed(3)} vs ${String(RELAY_BUDGET.limitMs)} ms -> ` +
        `${value <= RELAY_BUDGET.limitMs ? 'MET' : 'MISSED'}\n`,
    );
    expect(value).toBeLessThanOrEqual(RELAY_BUDGET.limitMs);
  });

  it('the recorded margin is the recorded numbers, divided', () => {
    expect(RELAY_BUDGET.measured.valueMs).toBeGreaterThan(0);
    expect(RELAY_BUDGET.limitMs / RELAY_BUDGET.measured.valueMs).toBeCloseTo(
      RELAY_BUDGET.measured.marginX,
      1,
    );
    expect(RELAY_BUDGET.enforced).toBe(true);
  });
});
