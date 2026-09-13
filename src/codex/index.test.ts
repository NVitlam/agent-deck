/**
 * Agent Deck — the Codex engine's ingestion contract
 * (HOTFIX-0.6.1, DoD H.2, H.3, H.4, H.5).
 *
 * ---------------------------------------------------------------------------
 * THE SPY IS ON `node:fs/promises`, AND IT IS THE POINT OF THE FILE
 * ---------------------------------------------------------------------------
 * Every claim this hotfix makes is a claim about SYSCALLS: an unchanged file
 * is not opened, an oversize file is never read, a refused version costs one
 * head and no more, a batch never exceeds 4 MiB. None of those is visible in
 * the engine's return value, and a test written against the return value would
 * be measuring the wrong thing entirely — `v0.6.0` returns exactly the same
 * sessions while reading the whole machine once a second.
 *
 * So `open` is wrapped and every `FileHandle.read` it hands out is counted, by
 * path. What is asserted is what the process did, not what it produced.
 *
 * `vi.mock` with `importOriginal` rather than a fake filesystem: the real
 * `open` still runs, the real bytes still move, and the only thing added is
 * the tally. A stubbed filesystem would let a bug in the reader hide behind a
 * bug in the stub.
 */

import { mkdir, mkdtemp, open as realOpen, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { deriveStats } from '../stats/derive.js';
import { readCodexEngine } from './index.js';
import { PINNED_CODEX_VERSION } from './fingerprint.js';
import { CodexTailStore, DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES } from './store.js';
import {
  CODEX_HEAD_BYTES,
  CODEX_OVERSIZE_TAIL_BYTES,
  CODEX_READ_BATCH_BYTES,
} from './tail.js';

// ---------------------------------------------------------------------------
// The syscall tally
// ---------------------------------------------------------------------------

interface Tally {
  /** `open()` calls, by absolute path. */
  opens: Map<string, number>;
  /** Bytes actually returned by `handle.read`, by absolute path. */
  bytesRead: Map<string, number>;
  /** Every individual read's requested length, in order, by path. */
  readLengths: Map<string, number[]>;
}

const tally: Tally = { opens: new Map(), bytesRead: new Map(), readLengths: new Map() };

function resetTally(): void {
  tally.opens.clear();
  tally.bytesRead.clear();
  tally.readLengths.clear();
}

function bump(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (path: unknown, ...rest: unknown[]) => {
      const key = String(path);
      // `readCodexEngine` is not the only thing in this process that opens
      // files — the generators below do too. Counting every open and filtering
      // by path at the assertion is more honest than trying to be clever about
      // which caller is which.
      bump(tally.opens, key, 1);
      const handle = await (actual.open as (...args: unknown[]) => Promise<unknown>)(
        path,
        ...rest,
      );
      const target = handle as { read: (...args: unknown[]) => Promise<{ bytesRead: number }> };
      const original = target.read.bind(target);
      target.read = async (...args: unknown[]) => {
        const length = typeof args[2] === 'number' ? args[2] : 0;
        const list = tally.readLengths.get(key) ?? [];
        list.push(length);
        tally.readLengths.set(key, list);
        const outcome = await original(...args);
        bump(tally.bytesRead, key, outcome.bytesRead);
        return outcome;
      };
      return handle;
    },
  };
});

// ---------------------------------------------------------------------------
// Corpora
// ---------------------------------------------------------------------------

const MIB = 1024 * 1024;

/**
 * A version outside the window whose STRING LENGTH equals the anchor's.
 *
 * `CODEX_VERSION_WINDOW` is major-exact and minor +/-1, so a different major
 * is refused; the same character count is what lets a test write two files
 * that differ in content and not in size. The equal-size case would otherwise
 * be untestable without padding the record by hand.
 */
const REFUSED_VERSION_SAME_LENGTH = '9.151.0-alpha.7.2';

let scratch = '';

/** `<root>/sessions/2026/09/05/` — the layout `locate.ts` walks. */
async function makeRoot(name: string): Promise<string> {
  const root = resolve(scratch, name);
  await mkdir(resolve(root, 'sessions', '2026', '09', '05'), { recursive: true });
  return root;
}

function transcriptPath(root: string, id: string): string {
  return resolve(root, 'sessions', '2026', '09', '05', `rollout-2026-09-05T00-00-00-${id}.jsonl`);
}

interface MetaOverrides {
  readonly cwd?: string;
  readonly cliVersion?: string;
}

function sessionMeta(threadId: string, overrides: MetaOverrides = {}): string {
  return JSON.stringify({
    timestamp: '2026-09-05T00:00:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: threadId,
      id: threadId,
      timestamp: '2026-09-05T00:00:00.000Z',
      cwd: overrides.cwd ?? resolve(scratch, 'workspace'),
      originator: 'codex_exec',
      cli_version: overrides.cliVersion ?? PINNED_CODEX_VERSION,
      source: 'exec',
      thread_source: 'user',
      model_provider: 'openai',
    },
  });
}

/**
 * A `response_item` / `message` record.
 *
 * `message` rather than a call type because `fingerprint.ts` requires a
 * `call_id` on `function_call` and `custom_tool_call`, and a corpus that
 * refused at the fingerprint would say nothing about ingestion.
 */
function bulk(ordinal: number, padding: string): string {
  return JSON.stringify({
    timestamp: '2026-09-05T00:00:01.000Z',
    ordinal,
    type: 'response_item',
    payload: {
      type: 'message',
      id: `msg_${String(ordinal)}`,
      role: 'assistant',
      content: [{ type: 'output_text', text: padding }],
    },
  });
}

/**
 * A `response_item` / `function_call` with `bytes` of padding in its arguments.
 *
 * The shape from `fixtures/codex-0.151.0-alpha.7.2`: a `call_id` (check 7 of
 * `fingerprintThread` refuses a call without one) and a `name`. Used where a
 * test has to name the records that survived a partial read, because a thread
 * carries `toolCalls` with their ordinals and carries plain messages as a
 * count alone.
 */
function call(ordinal: number, padding: string): string {
  return JSON.stringify({
    timestamp: '2026-09-05T00:00:01.000Z',
    ordinal,
    type: 'response_item',
    payload: {
      type: 'function_call',
      id: `fc_${String(ordinal)}`,
      call_id: `call_${String(ordinal)}`,
      name: 'shell',
      arguments: JSON.stringify({ command: padding }),
    },
  });
}

/** Write a Codex-shaped transcript of at least `targetBytes`. Returns its size. */
async function writeTranscript(
  path: string,
  targetBytes: number,
  overrides: MetaOverrides = {},
): Promise<number> {
  const padding = 'x'.repeat(8 * 1024);
  const parts = [`${sessionMeta('01a06400-0000-7000-8000-00000000000d', overrides)}\n`];
  let size = Buffer.byteLength(parts[0] as string, 'utf8');
  let ordinal = 1;
  while (size < targetBytes) {
    const line = `${bulk(ordinal, padding)}\n`;
    parts.push(line);
    size += Buffer.byteLength(line, 'utf8');
    ordinal += 1;
  }
  await writeFile(path, parts.join(''), 'utf8');
  return size;
}

/** Append `count` more records to an existing transcript. Returns its size. */
async function appendRecords(path: string, count: number): Promise<number> {
  const padding = 'x'.repeat(8 * 1024);
  const handle = await realOpen(path, 'a');
  try {
    for (let i = 0; i < count; i += 1) {
      await handle.write(`${bulk(1000 + i, padding)}\n`);
    }
  } finally {
    await handle.close();
  }
  return (await stat(path)).size;
}

/**
 * A transcript whose declared size is `targetBytes` and whose content stops
 * after the head. `truncate` extends without writing, which is what makes a
 * 65 MiB case affordable.
 *
 * **Its tail holds no newline**, so a head+tail read of one of these lands in
 * a run of NUL bytes and resynchronises for ever without finding a line —
 * which is why the partial-read cases below that assert on RECORDS use
 * {@link writeSparseWithTail} instead. This one is for the cases whose subject
 * is bytes and syscalls.
 */
async function writeSparse(path: string, targetBytes: number): Promise<number> {
  const handle = await realOpen(path, 'w');
  try {
    await handle.write(`${sessionMeta('01a06400-0000-7000-8000-0000000000ff')}\n`);
    await handle.truncate(targetBytes);
  } finally {
    await handle.close();
  }
  return targetBytes;
}

/**
 * A sparse transcript with real records written at its END, plus a deliberate
 * MID-LINE cut at the point a 16 MiB tail lands (DoD 7.7).
 *
 * The shape the oversize tail is for: a head to fingerprint on, a hole nobody
 * reads, and recent records. `tailRecords` records are written so that the
 * byte at `targetBytes - CODEX_OVERSIZE_TAIL_BYTES` falls INSIDE the first of
 * them — which is the ordinary case for a jump to an offset chosen without
 * reading the file, and the case whose fragment has to be dropped and counted.
 *
 * Returns the ordinals of the records it wrote after the landing point, so a
 * test can assert exactly which ones survived rather than only how many.
 */
async function writeSparseWithTail(
  path: string,
  targetBytes: number,
  tailRecords: number,
): Promise<{ size: number; landingOrdinal: number; afterLanding: number[] }> {
  const padding = 'x'.repeat(64 * 1024);
  const lines: string[] = [];
  for (let i = 0; i < tailRecords; i += 1) lines.push(`${call(500 + i, padding)}\n`);
  const tailBytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0);
  const firstLineBytes = Buffer.byteLength(lines[0] as string, 'utf8');
  // Where the records start, chosen so the landing point is inside the FIRST
  // of them rather than at its start: half a line in.
  const landing = targetBytes - CODEX_OVERSIZE_TAIL_BYTES;
  const recordsStart = landing - Math.floor(firstLineBytes / 2);
  if (recordsStart <= 0 || recordsStart + tailBytes > targetBytes) {
    throw new Error('writeSparseWithTail: the records do not fit where they were asked to go');
  }

  const handle = await realOpen(path, 'w');
  try {
    await handle.write(`${sessionMeta('01a06400-0000-7000-8000-0000000000ff')}\n`);
    await handle.truncate(recordsStart);
    await handle.write(lines.join(''), recordsStart);
    await handle.truncate(targetBytes);
  } finally {
    await handle.close();
  }
  const size = (await stat(path)).size;
  if (size !== targetBytes) throw new Error(`writeSparseWithTail: size ${String(size)}`);
  return {
    size,
    landingOrdinal: 500,
    afterLanding: lines.slice(1).map((_line, i) => 501 + i),
  };
}

beforeAll(async () => {
  await mkdir(resolve('dist'), { recursive: true });
  scratch = await mkdtemp(resolve('dist', 'codex-index-'));
}, 300_000);

afterAll(async () => {
  if (scratch !== '') await rm(scratch, { recursive: true, force: true });
});

afterEach(() => {
  resetTally();
});

// ===========================================================================
// H.2 — persistent tails
// ===========================================================================

describe('H.2 — a tail survives the pass that created it', () => {
  it('reads a 10 MiB transcript once, then ZERO bytes on every later pass', async () => {
    const root = await makeRoot('h2-unchanged');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-00000000000d');
    const size = await writeTranscript(path, 10 * MIB);
    const store = new CodexTailStore();

    /*
     * DRAINED FIRST, AND THE DRAIN IS NOT A WORKAROUND.
     *
     * "Unchanged" has to mean "unchanged AND already ingested": with a store
     * the engine takes one 4 MiB batch per file per pass, so a 10 MiB
     * transcript legitimately needs three of them. Asserting zero on the
     * literal second pass would have asserted that batching does not work.
     * The first draft of this test did exactly that and measured 4,194,304
     * bytes - the batch ceiling, doing its job.
     */
    resetTally();
    let passes = 0;
    for (let i = 0; i < 20; i += 1) {
      passes += 1;
      const outcome = await readCodexEngine({ root, tails: store });
      if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');
      if (outcome.result.threads.length > 0) break;
    }
    const ingestBytes = tally.bytesRead.get(path) ?? 0;
    expect(size).toBeGreaterThan(2 * CODEX_READ_BATCH_BYTES);
    expect(passes).toBeGreaterThan(1);
    // Read ONCE across the whole ingest, not once per pass.
    expect(ingestBytes).toBeGreaterThanOrEqual(size);
    expect(ingestBytes).toBeLessThan(size + CODEX_READ_BATCH_BYTES);

    resetTally();
    const steady = await readCodexEngine({ root, tails: store });
    if (steady.kind !== 'ok') throw new Error('engine did not read the corpus');

    // THE ASSERTION. `v0.6.0` re-read the whole file here, once a second.
    expect(tally.bytesRead.get(path) ?? 0).toBe(0);
    // Not merely zero bytes: the file is not OPENED. Discovery already
    // `stat`ed it, and that is the entire cost of an unchanged transcript.
    expect(tally.opens.get(path) ?? 0).toBe(0);
    // And the session is still on the deck. Zero reads must not mean zero
    // output - that would be a cheaper engine that shows nothing.
    expect(steady.result.threads).toHaveLength(1);
    expect(steady.result.sessions).toHaveLength(1);
  }, 300_000);

  it('drops the tail of a file discovery no longer reports', async () => {
    const root = await makeRoot('h2-retain');
    const a = transcriptPath(root, '01a06400-0000-7000-8000-00000000001a');
    const b = transcriptPath(root, '01a06400-0000-7000-8000-00000000001b');
    await writeTranscript(a, 4096);
    await writeTranscript(b, 4096);
    const store = new CodexTailStore();

    await readCodexEngine({ root, tails: store });
    expect(store.size).toBe(2);
    expect(store.has(a)).toBe(true);
    expect(store.has(b)).toBe(true);

    await rm(b);
    await readCodexEngine({ root, tails: store });

    // Without this the map is a leak with a slow fuse: one entry per
    // transcript that has ever existed under a root whose day directories
    // keep turning over.
    expect(store.size).toBe(1);
    expect(store.has(a)).toBe(true);
    expect(store.has(b)).toBe(false);
  }, 120_000);

  it('a replaced file loses its offset AND its verdict, not just its offset', async () => {
    const root = await makeRoot('h2-replaced');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-00000000002a');
    // First life: a version outside the window, so the entry goes terminal.
    await writeTranscript(path, 64 * 1024, { cliVersion: '99.0.0' });
    const store = new CodexTailStore();
    const before = await readCodexEngine({ root, tails: store });
    if (before.kind !== 'ok') throw new Error('engine did not read the corpus');
    expect(before.result.refused).toHaveLength(1);
    expect(before.result.threads).toHaveLength(0);

    /*
     * Second life: same path, SMALLER, supported. Inheriting `refused` would
     * hide a real session for as long as the window stayed open.
     *
     * The first draft wrote 4096 then 2048 and both files came out ~9 KB -
     * the generator rounds up to a whole padded record - so the sizes were
     * EQUAL and the shrink branch never fired. It found a real gap doing it:
     * size alone cannot see a rewrite in place, which is why the entry now
     * also carries the mtime. These two sizes are far enough apart to be a
     * shrink, and the case below covers the equal-size shape on purpose.
     */
    await writeTranscript(path, 8 * 1024);
    resetTally();
    const after = await readCodexEngine({ root, tails: store });
    if (after.kind !== 'ok') throw new Error('engine did not read the corpus');
    expect(after.result.refused).toHaveLength(0);
    expect(after.result.threads).toHaveLength(1);
  }, 120_000);

  it('a file rewritten IN PLACE at the same size is noticed, by its mtime', async () => {
    const root = await makeRoot('h2-inplace');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-00000000002b');
    const refusedSize = await writeTranscript(path, 32 * 1024, {
      cliVersion: REFUSED_VERSION_SAME_LENGTH,
    });
    const store = new CodexTailStore();
    const before = await readCodexEngine({ root, tails: store });
    if (before.kind !== 'ok') throw new Error('engine did not read the corpus');
    expect(before.result.refused).toHaveLength(1);

    /*
     * The same number of bytes, a supported version, a later mtime.
     * Size-based change detection is blind to exactly this, and the blindness
     * is permanent rather than transient: the entry is terminal, so it would
     * never be re-read and the session would never appear at all.
     *
     * The equal size is ASSERTED rather than assumed, and the assertion
     * earned its place immediately: the first draft used '99.0.0' against an
     * anchor of '0.151.0-alpha.7.2' and the files came out 11 bytes apart, so
     * the case would have exercised the SHRINK branch while claiming to
     * exercise the rewrite one. See REFUSED_VERSION_SAME_LENGTH.
     */
    const supported = await writeTranscript(path, 32 * 1024);
    expect(supported).toBe(refusedSize);

    const after = await readCodexEngine({ root, tails: store });
    if (after.kind !== 'ok') throw new Error('engine did not read the corpus');
    expect(after.result.refused).toHaveLength(0);
    expect(after.result.threads).toHaveLength(1);
  }, 120_000);
});

// ===========================================================================
// H.3 — the size gate
// ===========================================================================

describe('H.3 / DoD 7.7 — a transcript over the limit is read head-plus-tail', () => {
  it('reads 65 MiB as 256 KiB of head plus the last 16 MiB, and says so', async () => {
    const root = await makeRoot('h3-over');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-0000000000ff');
    const size = await writeSparse(path, 65 * MIB);
    expect(size).toBeGreaterThan(DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES);

    resetTally();
    const outcome = await readCodexEngine({ root });
    if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');

    // NOT SKIPPED. Before DoD 7.7 this file was measured from `stat` and never
    // opened, so the largest session on a machine was the one the deck said
    // nothing about.
    expect(outcome.result.skipped).toStrictEqual([]);
    expect(outcome.result.threads).toHaveLength(1);

    // THE BYTES, exactly. `readBytes` is the file less the hole; the hole is
    // everything between the end of the head and the tail's landing point.
    const partial = outcome.result.partialTranscripts;
    expect(partial).toHaveLength(1);
    expect(partial[0]?.path).toBe(path);
    expect(partial[0]?.totalBytes).toBe(size);
    const skippedMiddle = size - CODEX_OVERSIZE_TAIL_BYTES - CODEX_HEAD_BYTES;
    expect(partial[0]?.readBytes).toBe(size - skippedMiddle);
    expect(partial[0]?.readBytes).toBe(CODEX_HEAD_BYTES + CODEX_OVERSIZE_TAIL_BYTES);

    // THE READ ITSELF, from the syscall tally rather than from the return
    // value: 65 MiB on disk, 16.25 MiB through the handle.
    const read = tally.bytesRead.get(path) ?? 0;
    expect(read).toBeLessThanOrEqual(CODEX_HEAD_BYTES + CODEX_OVERSIZE_TAIL_BYTES);
    // VACUITY CONTROL: the file WAS opened and bytes DID move. A `toBeLessThan`
    // on its own passes over a file nobody touched, which is precisely the
    // behaviour this test was written to replace.
    expect(tally.opens.get(path) ?? 0).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(0);

    // AND THE SESSION SAYS IT. The mark is on the state, not only in the
    // engine's diagnostics — a figure a user cannot tell is partial is worse
    // than no figure.
    const session = outcome.result.sessions[0];
    expect(session?.partial).toStrictEqual({
      readBytes: CODEX_HEAD_BYTES + CODEX_OVERSIZE_TAIL_BYTES,
      totalBytes: size,
    });

    // AND IT IS KEPT OUT OF STATS, through the real deriver: a count over part of
    // a transcript is a subset carrying no sign of it. Found by the phase-7
    // verifier (D2) stored as `coverage: full`.
    if (session === undefined) throw new Error('no session');
    const record = deriveStats(session, {});
    expect(record.coverage).toBe('excluded:partial');
    expect(record.tools).toStrictEqual([]);
    // Control: the same state without the mark is derived in full.
    const whole = { ...session };
    delete (whole as { partial?: unknown }).partial;
    expect(deriveStats(whole, {}).coverage).not.toBe('excluded:partial');
  }, 120_000);

  it('keeps the records at the end and drops the fragment where the tail lands', async () => {
    const root = await makeRoot('h3-tail-records');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-0000000000ff');
    const written = await writeSparseWithTail(path, 65 * MIB, 6);

    resetTally();
    const outcome = await readCodexEngine({ root });
    if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');

    const thread = outcome.result.threads[0];
    if (thread === undefined) throw new Error('no thread');
    const ordinals = thread.toolCalls.map((toolCall) => toolCall.ordinal).sort((a, b) => a - b);
    // THE POPULATION IS NON-EMPTY AND IS EXACTLY THE RECORDS AFTER THE LANDING
    // POINT. Asserting only "the straddling record is absent" would pass over
    // a thread with no records at all, which is the vacuity this file's own
    // header warns about.
    expect(ordinals).toStrictEqual(written.afterLanding);
    expect(ordinals.length).toBe(5);
    expect(ordinals).not.toContain(written.landingOrdinal);

    // THE FRAGMENT IS COUNTED, NOT SILENTLY DROPPED (G3, rule 18). One line
    // straddled the landing point and one is reported.
    expect(outcome.result.partialTranscripts[0]?.boundaryFragments).toBe(1);
    // It is NOT counted as malformed: the bytes were never offered to the JSON
    // parser, so calling them malformed would be a different and untrue claim.
    expect(outcome.result.counters.malformedLines).toBe(0);
  }, 120_000);

  it('reads a transcript one byte under the limit — the gate is a limit, not a mood', async () => {
    const root = await makeRoot('h3-under');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-00000000003a');
    // Bigger than head + tail, or the two read shapes cover the same bytes and
    // the off-by-one this test exists for would be invisible.
    const size = await writeSparse(path, 20 * MIB);
    expect(size).toBeGreaterThan(CODEX_HEAD_BYTES + CODEX_OVERSIZE_TAIL_BYTES);

    resetTally();
    const outcome = await readCodexEngine({ root, maxTranscriptBytes: size });
    if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');

    // `>` not `>=`: a file EQUAL to the limit is read WHOLE. Stated as a test
    // because an off-by-one here is silent and permanent.
    expect(outcome.result.skipped).toStrictEqual([]);
    expect(outcome.result.partialTranscripts).toStrictEqual([]);
    expect(outcome.result.threads).toHaveLength(1);
    expect(outcome.result.sessions[0]?.partial).toBeUndefined();
    expect(tally.bytesRead.get(path) ?? 0).toBe(size);

    resetTally();
    const overOutcome = await readCodexEngine({ root, maxTranscriptBytes: size - 1 });
    if (overOutcome.kind !== 'ok') throw new Error('engine did not read the corpus');
    // One byte over: the same file, read in two bounded pieces.
    expect(overOutcome.result.skipped).toStrictEqual([]);
    expect(overOutcome.result.partialTranscripts).toHaveLength(1);
    expect(overOutcome.result.sessions[0]?.partial?.totalBytes).toBe(size);
    expect(tally.bytesRead.get(path) ?? 0).toBeLessThan(size);
  }, 120_000);

  it('a file over the limit but smaller than head+tail is read whole and is not partial', async () => {
    const root = await makeRoot('h3-small-over');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-00000000003b');
    const size = await writeTranscript(path, 512 * 1024);
    expect(size).toBeLessThan(CODEX_HEAD_BYTES + CODEX_OVERSIZE_TAIL_BYTES);

    resetTally();
    const outcome = await readCodexEngine({ root, maxTranscriptBytes: 256 * 1024 });
    if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');

    // OVER the limit, so the oversize read shape applies — and the jump has
    // nowhere to go, because the last 16 MiB of a 512 KiB file is all of it.
    // `skipTo` is forward-only, so nothing is skipped and nothing is claimed.
    expect(outcome.result.partialTranscripts).toStrictEqual([]);
    expect(outcome.result.sessions[0]?.partial).toBeUndefined();
    expect(tally.bytesRead.get(path) ?? 0).toBe(size);
    // The vacuity control for the line above: the file really does hold
    // records, so "no partial" is a statement about a session that exists.
    expect(outcome.result.threads[0]?.records).toBeGreaterThan(1);
  }, 120_000);

  it('an oversize transcript whose head decides nothing is terminal, counted and named', async () => {
    const root = await makeRoot('h3-head-undecided');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-00000000003c');
    // A first line longer than the head budget: one JSON record whose padding
    // runs past 256 KiB, with the file then extended past the size gate.
    const handle = await realOpen(path, 'w');
    let size = 0;
    try {
      await handle.write(`${bulk(0, 'x'.repeat(CODEX_HEAD_BYTES + 1024))}\n`);
      await handle.truncate(20 * MIB);
      size = 20 * MIB;
    } finally {
      await handle.close();
    }

    resetTally();
    const outcome = await readCodexEngine({ root, maxTranscriptBytes: 1024 });
    if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');

    expect(outcome.result.skipped).toHaveLength(1);
    expect(outcome.result.skipped[0]?.reason).toBe(
      `oversizeHeadUndecided:${String(size)} limit=1024 head=${String(CODEX_HEAD_BYTES)}`,
    );
    expect(outcome.result.partialTranscripts).toStrictEqual([]);
    expect(outcome.result.threads).toStrictEqual([]);
    // ONE HEAD, then it stops. Without the bound the drained path reads the
    // whole 20 MiB looking for a newline that is 257 KiB in — and on a 3 GB
    // transcript it reads 3 GB.
    expect(tally.bytesRead.get(path) ?? 0).toBeLessThanOrEqual(CODEX_HEAD_BYTES);
    expect(tally.bytesRead.get(path) ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it('a terminal oversize verdict is re-reported every pass and re-read never', async () => {
    const root = await makeRoot('h3-head-undecided-again');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-00000000003d');
    const handle = await realOpen(path, 'w');
    try {
      await handle.write(`${bulk(0, 'x'.repeat(CODEX_HEAD_BYTES + 1024))}\n`);
      await handle.truncate(20 * MIB);
    } finally {
      await handle.close();
    }
    const store = new CodexTailStore();

    const first = await readCodexEngine({ root, tails: store, maxTranscriptBytes: 1024 });
    if (first.kind !== 'ok') throw new Error('engine did not read the corpus');
    expect(first.result.skipped).toHaveLength(1);

    resetTally();
    const second = await readCodexEngine({ root, tails: store, maxTranscriptBytes: 1024 });
    if (second.kind !== 'ok') throw new Error('engine did not read the corpus');
    // STILL REPORTED (rule 18): a skip that stops being restated is a zero
    // nobody can tell from "nothing was skipped".
    expect(second.result.skipped).toStrictEqual(first.result.skipped);
    // AND NOT RE-READ: terminal means terminal.
    expect(tally.bytesRead.get(path) ?? 0).toBe(0);
  }, 120_000);

  it('a live session that grows past the limit keeps its tail', async () => {
    const root = await makeRoot('h3-growing');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-00000000004a');
    await writeTranscript(path, 64 * 1024);
    const store = new CodexTailStore();
    const limit = 128 * 1024;

    const first = await readCodexEngine({ root, tails: store, maxTranscriptBytes: limit });
    if (first.kind !== 'ok') throw new Error('engine did not read the corpus');
    expect(first.result.threads).toHaveLength(1);

    // Now push it over the limit, the way a live session does.
    await writeTranscript(path, limit * 4);
    resetTally();
    const second = await readCodexEngine({ root, tails: store, maxTranscriptBytes: limit });
    if (second.kind !== 'ok') throw new Error('engine did not read the corpus');

    // The locked decision: the limit gates the FIRST read, not the tail.
    // Abandoning a session mid-stream is a worse answer than reading its next
    // batch, and a user watching a session vanish would report a new defect.
    expect(second.result.skipped).toHaveLength(0);
    expect(tally.opens.get(path) ?? 0).toBeGreaterThan(0);
  }, 120_000);
});

// ===========================================================================
// H.4 — head first
// ===========================================================================

describe('H.4 — refused and foreign transcripts cost one head', () => {
  it('refuses an unsupported version after reading at most CODEX_HEAD_BYTES', async () => {
    const root = await makeRoot('h4-version');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-00000000005a');
    const size = await writeTranscript(path, 50 * MIB, { cliVersion: '99.0.0' });
    expect(size).toBeGreaterThan(CODEX_HEAD_BYTES);

    resetTally();
    const outcome = await readCodexEngine({ root });
    if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');

    expect(outcome.result.refused).toHaveLength(1);
    expect(outcome.result.refused[0]?.mismatch.code).toBe('versionOutOfWindow');
    // 50 MiB on disk, one head read. `v0.6.0` read all of it and then threw
    // the result away.
    expect(tally.bytesRead.get(path) ?? 0).toBeLessThanOrEqual(CODEX_HEAD_BYTES);
  }, 120_000);

  it('a refused transcript is not re-read on the next pass, and is still reported', async () => {
    const root = await makeRoot('h4-refused-again');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-00000000006a');
    await writeTranscript(path, 2 * MIB, { cliVersion: '99.0.0' });
    const store = new CodexTailStore();

    await readCodexEngine({ root, tails: store });
    resetTally();
    const second = await readCodexEngine({ root, tails: store });
    if (second.kind !== 'ok') throw new Error('engine did not read the corpus');

    expect(tally.opens.get(path) ?? 0).toBe(0);
    // Terminal is not the same as forgotten. A refusal that stops being
    // reported reads as a session that came right.
    expect(second.result.refused).toHaveLength(1);
  }, 120_000);

  it('stops on a foreign workspace after the head, and reports no session', async () => {
    const root = await makeRoot('h4-foreign');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-00000000007a');
    const size = await writeTranscript(path, 20 * MIB, { cwd: resolve(scratch, 'somewhere-else') });
    expect(size).toBeGreaterThan(CODEX_HEAD_BYTES);

    resetTally();
    const outcome = await readCodexEngine({
      root,
      workspaceFolders: [resolve(scratch, 'workspace')],
    });
    if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');

    expect(tally.bytesRead.get(path) ?? 0).toBeLessThanOrEqual(CODEX_HEAD_BYTES);
    // The host filtered this session out anyway (`belongsOnDeck`), so what
    // changed is the cost, not the deck.
    expect(outcome.result.sessions).toHaveLength(0);
    expect(outcome.result.threads).toHaveLength(0);
  }, 120_000);

  it('no workspace folders means no filter — every session, read whole', async () => {
    const root = await makeRoot('h4-nofilter');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-00000000008a');
    await writeTranscript(path, 512 * 1024, { cwd: resolve(scratch, 'somewhere-else') });

    const outcome = await readCodexEngine({ root });
    if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');
    // The control for the case above. Without it, "foreign is skipped" and
    // "everything is skipped" are the same green.
    expect(outcome.result.sessions).toHaveLength(1);
    expect(outcome.result.sessions[0]?.workspaceMatch).toBe(true);
  }, 120_000);
});

// ===========================================================================
// H.5 — bounded batches
// ===========================================================================

describe('H.5 — a large transcript arrives over several passes', () => {
  it('consumes 20 MiB across at least 5 passes, no read over the batch ceiling', async () => {
    const root = await makeRoot('h5');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-00000000009a');
    const size = await writeTranscript(path, 20 * MIB);
    const store = new CodexTailStore();

    resetTally();
    let passes = 0;
    let batched = null as Awaited<ReturnType<typeof readCodexEngine>> | null;
    // A bound, not a loop-until-done: a batching bug that read nothing would
    // otherwise hang the suite rather than fail it.
    for (let i = 0; i < 40; i += 1) {
      passes += 1;
      batched = await readCodexEngine({ root, tails: store });
      if (batched.kind !== 'ok') throw new Error('engine did not read the corpus');
      if (batched.result.threads.length > 0) break;
    }
    if (batched === null || batched.kind !== 'ok') throw new Error('no pass produced a result');

    expect(size).toBeGreaterThan(5 * CODEX_READ_BATCH_BYTES);
    expect(passes).toBeGreaterThanOrEqual(5);
    // EVERY read, not the average and not the last: the ceiling is a ceiling.
    for (const length of tally.readLengths.get(path) ?? []) {
      expect(length).toBeLessThanOrEqual(CODEX_READ_BATCH_BYTES);
    }

    // AND THE RESULT IS THE SAME RESULT. A cheaper read that produces a
    // different tree has not been made cheaper, it has been made wrong.
    const oneShot = await readCodexEngine({ root });
    if (oneShot.kind !== 'ok') throw new Error('engine did not read the corpus');
    expect(JSON.stringify(batched.result.sessions)).toBe(
      JSON.stringify(oneShot.result.sessions),
    );
    expect(JSON.stringify(batched.result.threads)).toBe(JSON.stringify(oneShot.result.threads));
  }, 300_000);

  it('keeps reporting the last complete parse while a re-read catches up', async () => {
    const root = await makeRoot('h5-append');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-0000000000aa');
    // Comfortably inside CODEX_HEAD_BYTES, so the head read reaches EOF and
    // one pass is genuinely enough. The first draft asked for 256 KiB, which
    // the generator rounds up past the 256 KiB head - one pass short, and the
    // test said so.
    await writeTranscript(path, 64 * 1024);
    const store = new CodexTailStore();

    const first = await readCodexEngine({ root, tails: store });
    if (first.kind !== 'ok') throw new Error('engine did not read the corpus');
    expect(first.result.sessions).toHaveLength(1);

    // A large append: the re-read cannot finish in one pass.
    await writeTranscript(path, 12 * MIB);
    const during = await readCodexEngine({ root, tails: store });
    if (during.kind !== 'ok') throw new Error('engine did not read the corpus');

    // NOT a partial tree (G3) and NOT an empty deck. A session that vanished
    // for four polls while an append caught up would be a worse defect than
    // the one this hotfix fixes.
    expect(during.result.sessions).toHaveLength(1);
  }, 300_000);

  /*
   * THE TEST THAT WOULD HAVE CAUGHT THE ONE DEFECT THIS HOTFIX SHIPPED, and
   * the reason it did not is that its predecessor stopped after ONE pass.
   *
   * A `phase-verifier` found it by doing what the test above does not: keep
   * going. The first draft dropped `entry.records` at end-of-file to bound
   * retention. The consequence took four passes to appear and then never went
   * away:
   *
   *   pass 1  read whole, parsed, records dropped, session shown
   *   pass 2  the session appends; the tail reads ONLY the appended bytes
   *   pass 3  at EOF the fingerprint runs over those records ALONE, finds no
   *           `session_meta` at ordinal 0, and refuses `sessionMetaMissing`
   *   pass 4+ the refusal is terminal. The card is gone for good.
   *
   * Measured through the production entry point, `sessions=1, 1, 1, 0`. A
   * memory fix that silently deletes every live Codex session is a worse
   * defect than the crash it was fixing, and nothing in a 13-test file that
   * asserted bytes, opens, batches and byte-identical results went red.
   *
   * So: append repeatedly, drain each time, and assert the session is STILL
   * THERE - by id, not by count, because a count of one is also what a
   * different session appearing would produce.
   */
  it('survives repeated appends: a live session is not refused into oblivion', async () => {
    const root = await makeRoot('h5-live');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-0000000000ab');
    await writeTranscript(path, 32 * 1024);
    const store = new CodexTailStore();

    const drain = async (): Promise<Awaited<ReturnType<typeof readCodexEngine>>> => {
      let last = await readCodexEngine({ root, tails: store });
      for (let i = 0; i < 20; i += 1) {
        last = await readCodexEngine({ root, tails: store });
        if (last.kind === 'ok' && last.result.sessions.length > 0) break;
      }
      return last;
    };

    const first = await drain();
    if (first.kind !== 'ok') throw new Error('engine did not read the corpus');
    expect(first.result.sessions).toHaveLength(1);
    const sessionId = first.result.sessions[0]?.sessionId;
    expect(sessionId).toBeTruthy();

    // Six appends, each drained. The defect appeared on the FOURTH pass, so a
    // loop that stops at three proves nothing.
    for (let round = 0; round < 6; round += 1) {
      await appendRecords(path, 2);
      const outcome = await drain();
      if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');

      expect(outcome.result.refused, `round ${String(round)} refused the session`).toHaveLength(0);
      expect(outcome.result.sessions, `round ${String(round)} lost the session`).toHaveLength(1);
      // BY ID. A count of one is also what a different session would give.
      expect(outcome.result.sessions[0]?.sessionId, `round ${String(round)}`).toBe(sessionId);
    }

    // And the appended content actually arrived: the tree grew. Without this
    // the test passes on an engine that reports a stale cached thread for
    // ever and never reads another byte.
    const finalOutcome = await drain();
    if (finalOutcome.kind !== 'ok') throw new Error('engine did not read the corpus');
    const finalThread = finalOutcome.result.threads[0];
    const firstThread = first.result.threads[0];
    expect(finalThread?.records).toBeGreaterThan(firstThread?.records ?? 0);
  }, 300_000);
});

// ===========================================================================
// The order of the two head checks
// ===========================================================================

/*
 * THE FINGERPRINT RUNS BEFORE THE WORKSPACE MATCH, AND NOTHING DEFENDED IT.
 *
 * A `phase-verifier` proved the property true and the suite indifferent: it
 * hoisted the workspace check above `fingerprintThread` in `index.ts` and
 * `index.test.ts`, `graft.test.ts` and `codex-golden.test.ts` stayed 108/108
 * green while a refused session silently vanished instead of being refused.
 *
 * It matters because `belongsOnDeck` in `src/extension.ts` deliberately keeps
 * `!schemaOk` sessions - "a refusal that is invisible to the renderer is not a
 * refusal" - so a Codex version drifting out of the window must produce a
 * REFUSAL a user can see, not silence. Reversing these two checks would reopen
 * that hole from a new direction, for exactly the sessions least likely to be
 * in the current workspace.
 */
describe('a refused transcript is refused, not silently dropped as foreign', () => {
  it('reports versionOutOfWindow even when the workspace does not match either', async () => {
    const root = await makeRoot('order');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-0000000000ba');
    await writeTranscript(path, 32 * 1024, {
      cliVersion: REFUSED_VERSION_SAME_LENGTH,
      cwd: resolve(scratch, 'somewhere-else'),
    });

    const outcome = await readCodexEngine({
      root,
      workspaceFolders: [resolve(scratch, 'workspace')],
    });
    if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');

    // BOTH would drop this transcript. Only one of them says why.
    expect(outcome.result.refused).toHaveLength(1);
    expect(outcome.result.refused[0]?.mismatch.code).toBe('versionOutOfWindow');

    // The control: the same foreign cwd with a SUPPORTED version is dropped
    // silently and correctly. Without it this test would pass on an engine
    // that refused everything foreign.
    const supported = transcriptPath(root, '01a06400-0000-7000-8000-0000000000bb');
    await writeTranscript(supported, 32 * 1024, { cwd: resolve(scratch, 'somewhere-else') });
    const second = await readCodexEngine({
      root,
      workspaceFolders: [resolve(scratch, 'workspace')],
    });
    if (second.kind !== 'ok') throw new Error('engine did not read the corpus');
    expect(second.result.refused).toHaveLength(1);
    expect(second.result.sessions).toHaveLength(0);
  }, 120_000);
});
