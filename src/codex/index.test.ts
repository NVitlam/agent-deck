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

import { mkdir, mkdtemp, open as realOpen, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { readCodexEngine } from './index.js';
import { PINNED_CODEX_VERSION } from './fingerprint.js';
import { CodexTailStore, DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES } from './store.js';
import { CODEX_HEAD_BYTES, CODEX_READ_BATCH_BYTES } from './tail.js';

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

/**
 * A transcript whose declared size is `targetBytes` and whose content stops
 * after the head. `truncate` extends without writing, which is what makes a
 * 65 MiB case affordable — and the file is never opened by the engine anyway,
 * which is the whole assertion.
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

describe('H.3 — a transcript over the limit is measured, not read', () => {
  it('skips 65 MiB with oversize: and the limit, and never opens it', async () => {
    const root = await makeRoot('h3-over');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-0000000000ff');
    const size = await writeSparse(path, 65 * MIB);
    expect(size).toBeGreaterThan(DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES);

    resetTally();
    const outcome = await readCodexEngine({ root });
    if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');

    expect(outcome.result.skipped).toHaveLength(1);
    const skip = outcome.result.skipped[0];
    expect(skip?.path).toBe(path);
    // The bytes AND the limit. A reason saying only "oversize" leaves a user
    // reading the diagnostics channel with no way to know what to set.
    expect(skip?.reason).toBe(
      `oversize:${String(size)} limit=${String(DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES)}`,
    );
    expect(outcome.result.threads).toHaveLength(0);

    // THE ASSERTION: not one syscall against the file. Measured from
    // discovery's own `statSync().size`, which was already taken.
    expect(tally.opens.get(path) ?? 0).toBe(0);
    expect(tally.readLengths.get(path) ?? []).toStrictEqual([]);
  }, 120_000);

  it('reads a transcript one byte under the limit — the gate is a limit, not a mood', async () => {
    const root = await makeRoot('h3-under');
    const path = transcriptPath(root, '01a06400-0000-7000-8000-00000000003a');
    const size = await writeTranscript(path, 8 * MIB);
    resetTally();
    const outcome = await readCodexEngine({ root, maxTranscriptBytes: size });
    if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');

    // `>` not `>=`: a file EQUAL to the limit is read. Stated as a test
    // because an off-by-one here is silent and permanent.
    expect(outcome.result.skipped).toHaveLength(0);
    expect(outcome.result.threads).toHaveLength(1);
    expect(tally.opens.get(path) ?? 0).toBeGreaterThan(0);

    resetTally();
    const refusedOutcome = await readCodexEngine({ root, maxTranscriptBytes: size - 1 });
    if (refusedOutcome.kind !== 'ok') throw new Error('engine did not read the corpus');
    expect(refusedOutcome.result.skipped).toHaveLength(1);
    expect(tally.opens.get(path) ?? 0).toBe(0);
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
});
