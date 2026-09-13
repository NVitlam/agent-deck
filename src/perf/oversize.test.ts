/**
 * Agent Deck — one whole Codex engine pass over a 1.2 GB transcript
 * (v0.8.0 Phase 7, DoD 7.7).
 *
 * ---------------------------------------------------------------------------
 * THE CORPUS IS SPARSE, AND THE TEST PROVES IT WAS NOT READ WHOLE
 * ---------------------------------------------------------------------------
 * `truncate` extends a file without writing it, so 1,288,490,188 bytes cost
 * kilobytes on disk and a run of this file measures the READER rather than
 * this machine's disk. A test that really moved 1.2 GB would pass or fail by
 * how fast the disk is, which `CLAUDE.md` records as a defect class in its own
 * right.
 *
 * That makes one control mandatory: sparseness is exactly what would let a
 * broken reader look fast. So the pass is pinned from two directions —
 *
 *   - the ENGINE's own answer: `readBytes` equals
 *     `CODEX_HEAD_BYTES + CODEX_OVERSIZE_TAIL_BYTES`, to the byte;
 *   - the SYSCALLS: every `handle.read` against the transcript falls inside
 *     the head window or the tail window, and their sum is that same figure.
 *
 * A reader that fell back to reading the middle fails both, whatever the clock
 * says. The budget is the third leg, and it is the one that catches a reader
 * that is linear in the file's size while still landing its bytes correctly —
 * a resync that accumulates, an allocation sized from `stat`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TRANSCRIPT HAS RECORDS AT ITS END
 * ---------------------------------------------------------------------------
 * A purely sparse tail is a run of NUL bytes with no newline in it, so the
 * tail read yields no record at all and the pass would be timed over a session
 * with nothing in it. Six `function_call` records are written at the end, the
 * first of them straddling the landing point, so what is timed is a pass that
 * fingerprints, parses, grafts and drops the boundary fragment.
 */

import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { readCodexEngine } from '../codex/index.js';
import { PINNED_CODEX_VERSION } from '../codex/fingerprint.js';
import { CODEX_HEAD_BYTES, CODEX_OVERSIZE_TAIL_BYTES } from '../codex/tail.js';
import { OVERSIZE_TAIL_BUDGET } from './budgets.js';

// ---------------------------------------------------------------------------
// The syscall tally, the same shape `src/codex/index.test.ts` uses
// ---------------------------------------------------------------------------

interface Read {
  readonly position: number;
  readonly length: number;
}

const reads = new Map<string, Read[]>();

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (path: unknown, ...rest: unknown[]) => {
      const key = String(path);
      const handle = await (actual.open as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
      const target = handle as { read: (...args: unknown[]) => Promise<{ bytesRead: number }> };
      const original = target.read.bind(target);
      target.read = async (...args: unknown[]) => {
        const length = typeof args[2] === 'number' ? args[2] : 0;
        const position = typeof args[3] === 'number' ? args[3] : -1;
        const list = reads.get(key) ?? [];
        list.push({ position, length });
        reads.set(key, list);
        return original(...args);
      };
      return handle;
    },
  };
});

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/** 1.2 GB, to the byte. 1,288,490,188 = 1.2 * 2^30, rounded to a whole byte. */
const TRANSCRIPT_BYTES = 1_288_490_188;

const THREAD_ID = '01a06400-0000-7000-8000-0000000012aa';
const TAIL_RECORDS = 6;

/** Samples taken per run. The first is discarded as a warm-up and PRINTED. */
const WARM_UP = 1;
const KEPT = 5;

let scratch = '';
let root = '';
let transcript = '';
let workspace = '';
/** The byte offset the 16 MiB tail lands on. The fragment straddles it. */
let landing = 0;

function metaLine(cwd: string): string {
  return `${JSON.stringify({
    timestamp: '2026-09-13T00:00:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: THREAD_ID,
      id: THREAD_ID,
      timestamp: '2026-09-13T00:00:00.000Z',
      cwd,
      originator: 'codex_exec',
      cli_version: PINNED_CODEX_VERSION,
      source: 'exec',
      thread_source: 'user',
      model_provider: 'openai',
    },
  })}\n`;
}

function callLine(ordinal: number, padding: string): string {
  return `${JSON.stringify({
    timestamp: '2026-09-13T00:00:01.000Z',
    ordinal,
    type: 'response_item',
    payload: {
      type: 'function_call',
      id: `fc_${String(ordinal)}`,
      call_id: `call_${String(ordinal)}`,
      name: 'shell',
      arguments: JSON.stringify({ command: padding }),
    },
  })}\n`;
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

beforeAll(async () => {
  await mkdir(resolve('dist'), { recursive: true });
  scratch = await mkdtemp(resolve('dist', 'codex-oversize-perf-'));
  root = resolve(scratch, '.codex');
  workspace = resolve(scratch, 'workspace');
  const dayDir = resolve(root, 'sessions', '2026', '09', '13');
  await mkdir(dayDir, { recursive: true });
  transcript = resolve(dayDir, `rollout-2026-09-13T00-00-00-${THREAD_ID}.jsonl`);

  const padding = 'z'.repeat(64 * 1024);
  const lines: string[] = [];
  for (let i = 0; i < TAIL_RECORDS; i += 1) lines.push(callLine(500 + i, padding));
  const firstLineBytes = Buffer.byteLength(lines[0] as string, 'utf8');
  landing = TRANSCRIPT_BYTES - CODEX_OVERSIZE_TAIL_BYTES;
  // Half a line before the landing point, so the landing point falls INSIDE
  // the first record — the fragment case, which is the ordinary one.
  const recordsStart = landing - Math.floor(firstLineBytes / 2);

  const handle = await open(transcript, 'w');
  try {
    await handle.write(metaLine(workspace));
    await handle.truncate(recordsStart);
    await handle.write(lines.join(''), recordsStart);
    await handle.truncate(TRANSCRIPT_BYTES);
  } finally {
    await handle.close();
  }
  const size = (await stat(transcript)).size;
  if (size !== TRANSCRIPT_BYTES) {
    throw new Error(`the corpus is ${String(size)} bytes, not ${String(TRANSCRIPT_BYTES)}`);
  }
}, 600_000);

afterAll(async () => {
  if (scratch !== '') await rm(scratch, { recursive: true, force: true });
});

describe('DoD 7.7 — a 1.2 GB transcript costs one head and one tail', () => {
  it('reads 16.25 MiB of it, in those two windows and nowhere else', async () => {
    reads.clear();
    const outcome = await readCodexEngine({ root, workspaceFolders: [workspace] });
    if (outcome.kind !== 'ok') throw new Error(`engine did not read the corpus: ${outcome.kind}`);

    // THE SESSION EXISTS. Every assertion below is about a pass that produced
    // something; without this they would all hold over a pass that produced
    // nothing at all.
    expect(outcome.result.threads).toHaveLength(1);
    expect(outcome.result.sessions).toHaveLength(1);
    expect(outcome.result.skipped).toStrictEqual([]);
    const thread = outcome.result.threads[0];
    // FIVE of the six records at the end: the sixth straddled the landing
    // point and was dropped as a fragment. The population is pinned, not its
    // size alone.
    expect(thread?.toolCalls.map((c) => c.ordinal)).toStrictEqual([501, 502, 503, 504, 505]);

    // THE ENGINE'S OWN ANSWER.
    const partial = outcome.result.partialTranscripts;
    expect(partial).toHaveLength(1);
    expect(partial[0]?.totalBytes).toBe(TRANSCRIPT_BYTES);
    expect(partial[0]?.readBytes).toBe(CODEX_HEAD_BYTES + CODEX_OVERSIZE_TAIL_BYTES);
    expect(partial[0]?.boundaryFragments).toBe(1);
    expect(outcome.result.sessions[0]?.partial).toStrictEqual({
      readBytes: CODEX_HEAD_BYTES + CODEX_OVERSIZE_TAIL_BYTES,
      totalBytes: TRANSCRIPT_BYTES,
    });

    /*
     * AND THE SYSCALLS, which is the half a sparse file makes necessary: a
     * reader that read the middle and threw it away would satisfy every
     * assertion above and every clock.
     */
    const against = reads.get(transcript) ?? [];
    expect(against.length).toBeGreaterThan(0);
    let bytes = 0;
    for (const read of against) {
      bytes += read.length;
      const inHead = read.position >= 0 && read.position + read.length <= CODEX_HEAD_BYTES;
      const inTail = read.position >= landing && read.position + read.length <= TRANSCRIPT_BYTES;
      expect(
        inHead || inTail,
        `a read of ${String(read.length)} bytes at ${String(read.position)} is in neither window`,
      ).toBe(true);
    }
    expect(bytes).toBe(CODEX_HEAD_BYTES + CODEX_OVERSIZE_TAIL_BYTES);
  }, 600_000);

  it('meets the budget', async () => {
    const samples: number[] = [];
    for (let i = 0; i < WARM_UP + KEPT; i += 1) {
      reads.clear();
      const started = performance.now();
      const outcome = await readCodexEngine({ root, workspaceFolders: [workspace] });
      samples.push(performance.now() - started);
      if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');
      // Each sample is a WHOLE pass that produced the session, not an early
      // return: a timing loop over a failing call is a fast loop.
      expect(outcome.result.sessions).toHaveLength(1);
    }
    const discarded = samples.slice(0, WARM_UP);
    const kept = samples.slice(WARM_UP);
    const value = medianOf(kept);

    // The warm-up is PRINTED rather than dropped silently, so a reader can
    // tell a warm-up allowance from a quietly widened limit.
    process.stdout.write(
      `[perf] oversize discarded (warm-up): ${discarded.map((s) => s.toFixed(1)).join(', ')} ms\n` +
        `[perf] oversize kept: ${kept.map((s) => s.toFixed(1)).join(', ')} ms\n` +
        `[perf] budget ${OVERSIZE_TAIL_BUDGET.id} (${OVERSIZE_TAIL_BUDGET.source}, enforced): ` +
        `${value.toFixed(3)} vs ${String(OVERSIZE_TAIL_BUDGET.limitMs)} ms -> ` +
        `${value <= OVERSIZE_TAIL_BUDGET.limitMs ? 'MET' : 'MISSED'}\n`,
    );
    expect(value).toBeLessThanOrEqual(OVERSIZE_TAIL_BUDGET.limitMs);
  }, 600_000);

  it('the recorded margin is the recorded numbers, divided', () => {
    expect(OVERSIZE_TAIL_BUDGET.measured.valueMs).toBeGreaterThan(0);
    expect(OVERSIZE_TAIL_BUDGET.limitMs / OVERSIZE_TAIL_BUDGET.measured.valueMs).toBeCloseTo(
      OVERSIZE_TAIL_BUDGET.measured.marginX,
      1,
    );
    expect(OVERSIZE_TAIL_BUDGET.enforced).toBe(true);
  });
});
