/**
 * DoD 2.1 — byte-offset tailing of a Codex rollout transcript.
 *
 * The property that matters most here is the one the corpus forces: Codex
 * stores tool output whole and inline, so a single line of 554,126 bytes is
 * ordinary data and a read that lands mid-line is the ordinary state. A tailer
 * that emitted the fragment would hand `parse.ts` a truncated JSON line, which
 * it would count as malformed — and the record would be gone for good.
 *
 * The last suite is the one that makes the ported algorithm safe: the same byte
 * streams are run through BOTH `CodexFileTail` and the Claude Code `FileTail`
 * and the outputs are compared. A drift between the two implementations is a
 * failure here rather than a surprise in production.
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { FileTail } from '../parser/tailer.js';
import { CODEX_MAX_PARTIAL_BYTES, CodexFileTail, Debouncer, ManualTime } from './tail.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const LONG_OUTPUT_DIR = join(
  REPO_ROOT,
  'fixtures',
  'codex-0.151.0-alpha.7.2',
  'long-output',
  'home',
  '.codex',
  'sessions',
  '2026',
  '09',
  '03',
);
const LONG_OUTPUT_FILE = join(
  LONG_OUTPUT_DIR,
  'rollout-2026-09-03T00-56-40-01a0641f-c9c0-7471-821c-946af20ef96e.jsonl',
);

const tempDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function newFile(name = 'rollout-a-1.jsonl', body = ''): string {
  const dir = tmp('cx-tail-');
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

/** The corpus's longest line, measured rather than remembered. */
function longestCorpusLine(): string {
  const text = readFileSync(LONG_OUTPUT_FILE, 'utf8');
  let longest = '';
  for (const line of text.split('\n')) {
    if (Buffer.byteLength(line, 'utf8') > Buffer.byteLength(longest, 'utf8')) longest = line;
  }
  return longest;
}

// ===========================================================================
// The partial line
// ===========================================================================

describe('the partial trailing line is held back until its newline arrives', () => {
  it('emits complete lines and keeps the fragment as `pending`', async () => {
    const path = newFile('rollout-a-1.jsonl', '{"a":1}\n{"b":2}\n{"c":');
    const tail = new CodexFileTail(path);

    const first = await tail.read();
    expect(first.lines.map((l) => l.text)).toEqual(['{"a":1}', '{"b":2}']);
    expect(first.state.pending).toBe('{"c":');
    expect(first.bytesRead).toBe(21);
    // `offset` counts bytes CONSUMED FROM THE FILE, pending ones included.
    // `pending` is what tells a reader how many of those became lines.
    expect(first.state.offset).toBe(21);
    expect(tail.pendingBytes).toBe(5);
  });

  it('never emits a truncated JSON line as a malformed one', async () => {
    const path = newFile('rollout-a-1.jsonl', '{"a":1}\n{"trunc');
    const tail = new CodexFileTail(path);
    const first = await tail.read();
    expect(first.lines).toHaveLength(1);
    for (const line of first.lines) {
      expect(() => JSON.parse(line.text)).not.toThrow();
    }
  });

  it('completes the held-back line on the next append, byte-identical', async () => {
    const path = newFile('rollout-a-1.jsonl', '{"a":1}\n{"c":');
    const tail = new CodexFileTail(path);
    await tail.read();

    appendFileSync(path, '3}\n');
    const second = await tail.read();
    expect(second.lines.map((l) => l.text)).toEqual(['{"c":3}']);
    expect(second.state.pending).toBe('');
    expect(second.bytesRead).toBe(3);
    expect(second.state.offset).toBe(16);
  });

  it('stitches a UTF-8 sequence split across two reads rather than corrupting it', async () => {
    const path = newFile('rollout-a-1.jsonl', '');
    const bytes = Buffer.from('{"s":"é中"}\n', 'utf8');
    const tail = new CodexFileTail(path);

    // Cut mid-character: byte 9 lands inside the three-byte CJK sequence,
    // which starts at byte 8. Decoding the two halves separately would
    // produce two replacement characters and no error.
    expect(bytes.subarray(0, 9).toString('utf8').endsWith('�')).toBe(true);
    writeFileSync(path, bytes.subarray(0, 9));
    const first = await tail.read();
    expect(first.lines).toEqual([]);

    appendFileSync(path, bytes.subarray(9));
    const second = await tail.read();
    expect(second.lines.map((l) => l.text)).toEqual(['{"s":"é中"}']);
    expect(JSON.parse(second.lines[0]?.text ?? '')).toEqual({ s: 'é中' });
  });

  it('numbers lines 1-based across the lifetime of the tail, not per read', async () => {
    const path = newFile('rollout-a-1.jsonl', 'a\nb\n');
    const tail = new CodexFileTail(path);
    const first = await tail.read();
    appendFileSync(path, 'c\n');
    const second = await tail.read();
    expect(first.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(second.lines.map((l) => l.lineNo)).toEqual([3]);
  });

  it('reports the transcript basename rather than inventing an id from the path', async () => {
    // Spec C1: a subagent's transcript is a SIBLING of its parent's with
    // nothing in the path marking it, so a tail that derived identity from the
    // filename would be classifying by path.
    const path = newFile('rollout-2026-09-03T00-00-00-uuid.jsonl', 'a\n');
    const tail = new CodexFileTail(path);
    const result = await tail.read();
    expect(tail.file).toBe('rollout-2026-09-03T00-00-00-uuid.jsonl');
    expect(result.lines[0]?.file).toBe(tail.file);
    expect(Object.keys(result.lines[0] ?? {}).sort()).toEqual(['file', 'lineNo', 'path', 'text']);
  });
});

// ===========================================================================
// The 554,126-byte line
// ===========================================================================

describe('a single very long line survives whole', () => {
  const longest = longestCorpusLine();

  it('the corpus really does carry a line in the hundreds of kilobytes', () => {
    // Vacuity control for the two cases below: if the fixture ever stopped
    // carrying a long line they would pass while testing nothing.
    expect(Buffer.byteLength(longest, 'utf8')).toBeGreaterThan(500_000);
  });

  it('tails the corpus transcript and emits that line intact', async () => {
    const tail = new CodexFileTail(LONG_OUTPUT_FILE);
    const result = await tail.read();
    const emitted = result.lines.map((l) => l.text);

    expect(emitted).toContain(longest);
    // And the tail consumed the whole file: the fixture ends with a newline,
    // so nothing is left pending.
    expect(result.state.pending).toBe('');
    expect(result.state.offset).toBe(readFileSync(LONG_OUTPUT_FILE).length);
    expect(result.skipped).toBeUndefined();
  });

  it('holds it back across an arbitrary split and reassembles it byte-identically', async () => {
    const dir = tmp('cx-longline-');
    const path = join(dir, 'rollout-long-1.jsonl');
    const bytes = Buffer.from(`${longest}\n`, 'utf8');
    const cut = 300_000;

    writeFileSync(path, bytes.subarray(0, cut));
    const tail = new CodexFileTail(path);
    const first = await tail.read();
    expect(first.lines).toEqual([]);
    expect(first.bytesRead).toBe(cut);
    expect(tail.pendingBytes).toBe(cut);
    expect(first.oversized).toBe(0);

    appendFileSync(path, bytes.subarray(cut));
    const second = await tail.read();
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]?.text).toBe(longest);
    expect(Buffer.from(second.lines[0]?.text ?? '', 'utf8')).toEqual(bytes.subarray(0, bytes.length - 1));
    expect(tail.pendingBytes).toBe(0);
  });

  it('the default ceiling is well above the measured maximum', () => {
    expect(CODEX_MAX_PARTIAL_BYTES).toBeGreaterThan(Buffer.byteLength(longest, 'utf8') * 10);
  });
});

describe('the resync ceiling', () => {
  it('drops an over-long unterminated line, counts it, and resumes at the next newline', async () => {
    const path = newFile('rollout-a-1.jsonl', `${'x'.repeat(200)}`);
    const tail = new CodexFileTail(path, { maxPartialBytes: 64 });

    const first = await tail.read();
    expect(first.lines).toEqual([]);
    expect(first.oversized).toBe(1);
    expect(tail.pendingBytes).toBe(0);

    appendFileSync(path, '\n{"after":1}\n');
    const second = await tail.read();
    expect(second.lines.map((l) => l.text)).toEqual(['{"after":1}']);
    expect(second.oversized).toBe(0);
  });
});

// ===========================================================================
// G3 — no input makes a call throw
// ===========================================================================

describe('G3 — never throws, whatever is on disk', () => {
  it('reports a missing file as skipped', async () => {
    const tail = new CodexFileTail(join(tmp('cx-missing-'), 'rollout-nope.jsonl'));
    const result = await tail.read();
    expect(result.skipped?.reason).toContain('ENOENT');
    expect(result.lines).toEqual([]);
    expect(result.state.offset).toBe(0);
  });

  it('reports a directory where a transcript was expected', async () => {
    const dir = tmp('cx-dir-');
    const asDir = join(dir, 'rollout-a-1.jsonl');
    mkdirSync(asDir);
    const result = await new CodexFileTail(asDir).read();
    expect(result.skipped?.reason).toContain('ENOTFILE');
  });

  it('returns nothing and no error for a zero-byte transcript', async () => {
    const result = await new CodexFileTail(newFile('rollout-a-1.jsonl', '')).read();
    expect(result.lines).toEqual([]);
    expect(result.bytesRead).toBe(0);
    expect(result.skipped).toBeUndefined();
  });

  it('does not throw on malformed, binary or NUL-bearing input', async () => {
    const dir = tmp('cx-malformed-');
    const path = join(dir, 'rollout-a-1.jsonl');
    const bad = Buffer.concat([
      Buffer.from('{"ok":1}\n', 'utf8'),
      Buffer.from('not json at all\n', 'utf8'),
      Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a]),
      Buffer.from('{"unterminated"\n', 'utf8'),
      Buffer.from([0xc3, 0x0a]), // a lead byte with no continuation
      Buffer.from('{"ok":2}\n', 'utf8'),
    ]);
    writeFileSync(path, bad);

    const tail = new CodexFileTail(path);
    await expect(tail.read()).resolves.toBeDefined();

    const result = await new CodexFileTail(path).read();
    expect(result.skipped).toBeUndefined();
    expect(result.lines.map((l) => l.text)).toContain('{"ok":1}');
    expect(result.lines.map((l) => l.text)).toContain('{"ok":2}');
  });

  it('skips blank separator lines rather than reporting empty records', async () => {
    const result = await new CodexFileTail(newFile('rollout-a-1.jsonl', 'a\n\n\r\n  \nb\n')).read();
    expect(result.lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('strips a trailing CR, so a CRLF transcript parses', async () => {
    const result = await new CodexFileTail(newFile('rollout-a-1.jsonl', '{"a":1}\r\n')).read();
    expect(result.lines.map((l) => l.text)).toEqual(['{"a":1}']);
  });
});

describe('offsets and truncation', () => {
  it('advances the offset by exactly the bytes appended, across many reads', async () => {
    const path = newFile('rollout-a-1.jsonl', '');
    const tail = new CodexFileTail(path);
    let expected = 0;
    for (const chunk of ['{"a":1}\n', '{"b":2}\n{"c":3}\n', '{"d":', '4}\n']) {
      appendFileSync(path, chunk);
      const result = await tail.read();
      expected += Buffer.byteLength(chunk, 'utf8');
      expect(result.bytesRead).toBe(Buffer.byteLength(chunk, 'utf8'));
      expect(tail.offset).toBe(expected);
      expect(result.state.offset).toBe(expected);
    }
  });

  it('reads nothing, and reports nothing, when the file has not grown', async () => {
    const path = newFile('rollout-a-1.jsonl', 'a\n');
    const tail = new CodexFileTail(path);
    await tail.read();
    const again = await tail.read();
    expect(again.lines).toEqual([]);
    expect(again.bytesRead).toBe(0);
    expect(again.reset).toBe(false);
  });

  it('restarts at 0 when the file shrinks below the stored offset', async () => {
    const path = newFile('rollout-a-1.jsonl', '{"a":1}\n{"b":2}\n');
    const tail = new CodexFileTail(path);
    await tail.read();
    expect(tail.offset).toBe(16);

    writeFileSync(path, '{"z":9}\n'); // replaced, not appended to
    const result = await tail.read();
    expect(result.reset).toBe(true);
    expect(result.lines.map((l) => l.text)).toEqual(['{"z":9}']);
    expect(tail.offset).toBe(8);
    expect(result.state.pending).toBe('');
  });
});

// ===========================================================================
// The ported algorithm, pinned against the one it was ported from
// ===========================================================================

describe('differential — identical behaviour to the Claude Code FileTail', () => {
  const streams: { name: string; chunks: string[] }[] = [
    { name: 'complete lines', chunks: ['{"a":1}\n{"b":2}\n'] },
    { name: 'a partial held across reads', chunks: ['{"a":1}\n{"b":', '2}\n'] },
    { name: 'a partial that never completes', chunks: ['{"a":1}\n{"b":'] },
    { name: 'blank separators', chunks: ['a\n\n\nb\n'] },
    { name: 'crlf', chunks: ['a\r\nb\r\n'] },
    { name: 'no trailing newline at all', chunks: ['a\nb'] },
    { name: 'many small appends', chunks: ['{', '"a"', ':1}', '\n', '{"b":2}\n'] },
    { name: 'empty appends between real ones', chunks: ['a\n', '', 'b\n'] },
  ];

  it.each(streams)('$name', async ({ chunks }) => {
    const dir = tmp('cx-diff-');
    const mine = join(dir, 'mine.jsonl');
    const theirs = join(dir, 'theirs.jsonl');
    writeFileSync(mine, '');
    writeFileSync(theirs, '');

    const codex = new CodexFileTail(mine);
    const cc = new FileTail(theirs, { sessionId: 'theirs.jsonl', agentId: null });

    for (const chunk of chunks) {
      if (chunk !== '') {
        appendFileSync(mine, chunk);
        appendFileSync(theirs, chunk);
      }
      const a = await codex.read();
      const b = await cc.read();
      expect(a.lines.map((l) => ({ text: l.text, lineNo: l.lineNo }))).toEqual(
        b.lines.map((l) => ({ text: l.text, lineNo: l.lineNo })),
      );
      expect(a.bytesRead).toBe(b.bytesRead);
      expect(a.reset).toBe(b.reset);
      expect(a.oversized).toBe(b.oversized);
      expect(codex.offset).toBe(cc.offset);
      expect(codex.pendingBytes).toBe(cc.pendingBytes);
      expect(codex.pending).toBe(cc.pending);
    }
  });

  it('agrees on truncation-reset too', async () => {
    const dir = tmp('cx-diff-reset-');
    const mine = join(dir, 'mine.jsonl');
    const theirs = join(dir, 'theirs.jsonl');
    for (const p of [mine, theirs]) writeFileSync(p, 'a\nb\nc\n');

    const codex = new CodexFileTail(mine);
    const cc = new FileTail(theirs, { sessionId: 'theirs.jsonl', agentId: null });
    await codex.read();
    await cc.read();

    for (const p of [mine, theirs]) writeFileSync(p, 'z\n');
    const a = await codex.read();
    const b = await cc.read();
    expect(a.reset).toBe(b.reset);
    expect(a.reset).toBe(true);
    expect(a.lines.map((l) => l.text)).toEqual(b.lines.map((l) => l.text));
    expect(codex.offset).toBe(cc.offset);
  });
});

// ===========================================================================
// The accessor this wrapper rests on
// ===========================================================================

describe('FileTail.pending — the one additive change made in src/parser', () => {
  it('is the held-back text, and agrees with pendingBytes', async () => {
    const path = newFile('rollout-a-1.jsonl', '{"a":1}\n{"unterminated"');
    const cc = new FileTail(path, { sessionId: 'x', agentId: null });
    await cc.read();
    expect(cc.pending).toBe('{"unterminated"');
    expect(Buffer.byteLength(cc.pending, 'utf8')).toBe(cc.pendingBytes);
  });

  it('is empty when every consumed byte became a line', async () => {
    const path = newFile('rollout-a-1.jsonl', '{"a":1}\n');
    const cc = new FileTail(path, { sessionId: 'x', agentId: null });
    await cc.read();
    expect(cc.pending).toBe('');
    expect(cc.pendingBytes).toBe(0);
  });

  it('clears on a truncation reset, like every other piece of tail state', async () => {
    const path = newFile('rollout-a-1.jsonl', '{"a":1}\n{"held"');
    const cc = new FileTail(path, { sessionId: 'x', agentId: null });
    await cc.read();
    expect(cc.pending).not.toBe('');
    writeFileSync(path, 'z\n');
    await cc.read();
    expect(cc.pending).toBe('');
  });

  it('is what makes `state.pending` honest beside `state.offset`', async () => {
    // The whole reason the accessor exists. `offset` counts bytes CONSUMED,
    // pending ones included, so an empty `pending` beside a non-zero `offset`
    // asserts that every consumed byte became a line. Here it has not.
    const path = newFile('rollout-a-1.jsonl', '{"a":1}\n{"held"');
    const tail = new CodexFileTail(path);
    const result = await tail.read();
    expect(result.state.offset).toBe(15);
    expect(result.state.pending).toBe('{"held"');
    const emitted = result.lines.reduce((n, l) => n + Buffer.byteLength(l.text, 'utf8') + 1, 0);
    expect(emitted + Buffer.byteLength(result.state.pending, 'utf8')).toBe(result.state.offset);
  });
});

// ===========================================================================
// The debounce seam, reused literally
// ===========================================================================

describe('the debounce seam is the CC one, re-exported rather than restated', () => {
  it('coalesces a burst on an injected clock, with no sleeping', () => {
    const time = new ManualTime(1_000);
    const flushes: number[] = [];
    const debouncer = new Debouncer({
      delayMs: 120,
      clock: time,
      scheduler: time,
      onFlush: (info) => flushes.push(info.signals),
    });

    debouncer.signal();
    time.advance(50);
    debouncer.signal();
    expect(flushes).toEqual([]);
    time.advance(120);
    expect(flushes).toEqual([2]);
  });
});
