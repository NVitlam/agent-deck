/**
 * Tests for redaction and truncation (G4).
 *
 * The committed fixture tree is opened read-only and never modified. Any file
 * a test creates lives under the OS temp directory. No network, no sleeps.
 */

import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEPTH_LIMIT_MARKER,
  MAX_REDACTION_DEPTH,
  TRUNCATION_MARKER_RE,
  hasLoneSurrogate,
  isSafeToolResultBasename,
  isThinkingBlock,
  parsePersistedOutputPointer,
  readRedactedToolResult,
  redactJson,
  redactText,
  resolveToolResultPath,
  splitTruncationMarker,
  truncatePreservingMarker,
  truncateUtf8,
  truncationMarker,
} from './redact.js';

// ---------------------------------------------------------------------------
// Fixture locations (read-only)
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = fileURLToPath(new URL('../../fixtures/cc-2.1.234/projects', import.meta.url));
const SLUG = 'c--Users-dev-projects-agent-deck';
const SESSION = '05c5482d-5568-44ce-97fe-bc9a6c15afc4';
/** The transcript holding the one measured `<persisted-output>` stub. */
const STUB_TRANSCRIPT = join(FIXTURE_ROOT, SLUG, SESSION, 'subagents', 'agent-a3ecf86bbfb853726.jsonl');
const TOOL_RESULT_BASENAME = 'b6uvpgxa4.txt';
const TOOL_RESULT_FILE = join(FIXTURE_ROOT, SLUG, SESSION, 'tool-results', TOOL_RESULT_BASENAME);

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'agent-deck-redact-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Pull the real stub string out of the captured transcript. */
async function realStubText(): Promise<string> {
  const text = await readFile(STUB_TRANSCRIPT, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.includes('<persisted-output>')) continue;
    const entry: unknown = JSON.parse(line);
    const content = (entry as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: unknown; content?: unknown };
      if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.startsWith('<persisted-output>')) {
        return b.content;
      }
    }
  }
  throw new Error('no persisted-output stub found in the fixture');
}

// ---------------------------------------------------------------------------
// (b) Truncation — bytes, not characters; UTF-8 safe
// ---------------------------------------------------------------------------

describe('truncateUtf8', () => {
  it('defaults to 8 KB', () => {
    expect(DEFAULT_MAX_PAYLOAD_BYTES).toBe(8 * 1024);
  });

  it('leaves a payload at or under the ceiling untouched', () => {
    const text = 'x'.repeat(DEFAULT_MAX_PAYLOAD_BYTES);
    const result = truncateUtf8(text);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
    expect(result.originalBytes).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
  });

  it('truncates one byte over the ceiling and marks it', () => {
    const text = 'x'.repeat(DEFAULT_MAX_PAYLOAD_BYTES + 1);
    const result = truncateUtf8(text);
    expect(result.truncated).toBe(true);
    expect(result.keptBytes).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
    expect(result.originalBytes).toBe(DEFAULT_MAX_PAYLOAD_BYTES + 1);
    expect(result.text.endsWith(truncationMarker(8192, 8193))).toBe(true);
  });

  it('states the original size in the marker', () => {
    const result = truncateUtf8('y'.repeat(20000), 100);
    const m = TRUNCATION_MARKER_RE.exec(result.text);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('100');
    expect(m?.[2]).toBe('20000');
  });

  it('counts BYTES not characters (multi-byte payload)', () => {
    // Each 'é' is 2 UTF-8 bytes: 50 chars, 100 bytes.
    const text = 'é'.repeat(50);
    expect(text.length).toBe(50);
    expect(Buffer.byteLength(text, 'utf8')).toBe(100);
    expect(truncateUtf8(text, 100).truncated).toBe(false);
    expect(truncateUtf8(text, 99).truncated).toBe(true);
  });

  it('never splits a 2-byte sequence', () => {
    const result = truncateUtf8('é'.repeat(50), 99);
    // 99 lands mid-'é'; the cut must back off to 98.
    expect(result.keptBytes).toBe(98);
    const payload = result.text.replace(TRUNCATION_MARKER_RE, '');
    expect(payload).toBe('é'.repeat(49));
    expect(Buffer.from(payload, 'utf8').includes(0xef)).toBe(false); // no U+FFFD
  });

  it('never splits a 3-byte sequence', () => {
    const text = '☃'.repeat(20); // 3 bytes each -> 60 bytes
    for (const limit of [10, 11, 12]) {
      const result = truncateUtf8(text, limit);
      const payload = result.text.replace(TRUNCATION_MARKER_RE, '');
      expect(result.keptBytes % 3).toBe(0);
      expect(payload).toBe('☃'.repeat(result.keptBytes / 3));
      expect(payload.includes('\ufffd')).toBe(false);
    }
  });

  it('never splits a 4-byte sequence (astral plane)', () => {
    const text = '\u{1F600}'.repeat(10); // 4 bytes each -> 40 bytes
    for (let limit = 1; limit <= 40; limit++) {
      const result = truncateUtf8(text, limit);
      const payload = result.text.replace(TRUNCATION_MARKER_RE, '');
      expect(result.keptBytes % 4).toBe(0);
      expect(payload.includes('\ufffd')).toBe(false);
      expect(Buffer.byteLength(payload, 'utf8')).toBeLessThanOrEqual(limit);
    }
  });

  it('yields an empty payload when even one character does not fit', () => {
    const result = truncateUtf8('\u{1F600}', 2);
    expect(result.keptBytes).toBe(0);
    expect(result.text.replace(TRUNCATION_MARKER_RE, '')).toBe('');
    expect(result.truncated).toBe(true);
  });

  it('treats a non-positive or non-finite ceiling as zero rather than throwing', () => {
    expect(truncateUtf8('abc', 0).keptBytes).toBe(0);
    expect(truncateUtf8('abc', -5).keptBytes).toBe(0);
    expect(truncateUtf8('abc', Number.NaN).keptBytes).toBe(0);
  });

  it('is configurable per call', () => {
    expect(truncateUtf8('a'.repeat(9000), 16 * 1024).truncated).toBe(false);
    expect(redactText('a'.repeat(9000), { maxPayloadBytes: 16 * 1024 }).truncated).toBe(false);
    expect(redactText('a'.repeat(9000)).truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b2) Second passes: the marker keeps quantifying the ORIGINAL payload
// ---------------------------------------------------------------------------

describe('truncatePreservingMarker (Phase 4 carry-forward A, defect (b))', () => {
  /**
   * The defect this closes, measured on the committed capture: a 63,774-byte
   * payload cut at 8,192 becomes an 8,248-byte STRING, and a second pass at
   * 8,192 re-marked that string as "8192 of 8248" — under-reporting the
   * original by 7.73x (63774/8248). The number in the marker is the whole
   * point of the marker, so a wrong one is a fabricated measurement.
   *
   * Units: every number below is UTF-8 BYTES. `keptBytes` counts payload only;
   * the marker sits on top, so the returned string is longer than `maxBytes`.
   */
  const once = truncateUtf8('z'.repeat(63774), 8192);

  it('the input to these tests really is the double-cut shape (8192 payload + marker)', () => {
    expect(once.keptBytes).toBe(8192);
    expect(once.originalBytes).toBe(63774);
    expect(Buffer.byteLength(once.text, 'utf8')).toBe(8192 + truncationMarker(8192, 63774).length);
  });

  it('refuses to re-mark a marked string against the length it was handed', () => {
    const twice = truncatePreservingMarker(once.text, 8192);
    const m = TRUNCATION_MARKER_RE.exec(twice.text);
    expect(m).not.toBeNull();
    expect(m?.[2]).toBe('63774');
    // The old behaviour, spelled out so this test fails if it comes back.
    expect(m?.[2]).not.toBe(String(Buffer.byteLength(once.text, 'utf8')));
    expect(truncateUtf8(once.text, 8192).text).toContain('of 8248 bytes');
  });

  it('re-cutting a marked string lowers the kept count but never the original', () => {
    const smaller = truncatePreservingMarker(once.text, 512);
    expect(smaller.keptBytes).toBe(512);
    expect(smaller.originalBytes).toBe(63774);
    const payload = smaller.text.replace(TRUNCATION_MARKER_RE, '');
    expect(Buffer.byteLength(payload, 'utf8')).toBe(512);
    expect(smaller.text.endsWith(truncationMarker(512, 63774))).toBe(true);
  });

  it('leaves an already-compliant marked string byte-identical', () => {
    const again = truncatePreservingMarker(once.text, 8192);
    expect(again.text).toBe(once.text);
    expect(again.truncated).toBe(true);
    expect(again.keptBytes).toBe(8192);
  });

  it('is a no-op difference from truncateUtf8 for an unmarked payload', () => {
    for (const [text, max] of [
      ['short', 8192],
      ['x'.repeat(20000), 100],
      ['é'.repeat(50), 51],
      ['', 8192],
    ] as [string, number][]) {
      expect(truncatePreservingMarker(text, max)).toEqual(truncateUtf8(text, max));
    }
  });

  it('re-emits the marker as a MEASUREMENT, so a lying marker cannot survive', () => {
    // Content that ends in something shaped like our marker cannot make the
    // kept count disagree with the bytes beside it.
    const spoofed = 'q'.repeat(100) + truncationMarker(999_999, 5);
    const out = truncatePreservingMarker(spoofed, 8192);
    const m = TRUNCATION_MARKER_RE.exec(out.text);
    expect(Number(m?.[1])).toBe(100);
    // The reported original never claims less than what is on screen.
    expect(Number(m?.[2])).toBeGreaterThanOrEqual(100);
  });

  it('splitTruncationMarker returns undefined for an unmarked string and never throws', () => {
    expect(splitTruncationMarker('plain')).toBeUndefined();
    expect(splitTruncationMarker('')).toBeUndefined();
    // Marker not at the end: not a marker.
    expect(splitTruncationMarker(`${truncationMarker(1, 2)} trailing`)).toBeUndefined();
    const split = splitTruncationMarker(`abc${truncationMarker(3, 9)}`);
    expect(split?.payload).toBe('abc');
    expect(split?.keptBytes).toBe(3);
    expect(split?.originalBytes).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// (a) Thinking blocks
// ---------------------------------------------------------------------------

describe('isThinkingBlock', () => {
  it('matches the measured CC 2.1.234 shape', () => {
    expect(isThinkingBlock({ type: 'thinking', thinking: '', signature: 'CAIS…' })).toBe(true);
  });

  it('matches redacted_thinking and any block still carrying a thinking payload', () => {
    expect(isThinkingBlock({ type: 'redacted_thinking', data: 'x' })).toBe(true);
    expect(isThinkingBlock({ type: 'some_future_name', thinking: 'reasoning' })).toBe(true);
  });

  it('does not match ordinary blocks or non-objects', () => {
    expect(isThinkingBlock({ type: 'text', text: 'hello' })).toBe(false);
    expect(isThinkingBlock({ type: 'tool_use', id: 't', name: 'Bash', input: {} })).toBe(false);
    expect(isThinkingBlock(null)).toBe(false);
    expect(isThinkingBlock('thinking')).toBe(false);
    expect(isThinkingBlock(['thinking'])).toBe(false);
  });
});

describe('redactJson thinking removal', () => {
  it('drops the block from a content array and counts it', () => {
    const out = redactJson({
      message: {
        content: [
          { type: 'thinking', thinking: 'SECRET-REASONING', signature: 'SECRET-SIGNATURE' },
          { type: 'text', text: 'visible' },
        ],
      },
    });
    expect(out.report.thinkingBlocksDropped).toBe(1);
    const json = JSON.stringify(out.value);
    expect(json).not.toContain('SECRET-REASONING');
    expect(json).not.toContain('SECRET-SIGNATURE');
    expect(json).toContain('visible');
  });

  it('strips thinking/signature fields from a surviving object', () => {
    const out = redactJson({ type: 'text', text: 'ok', signature: 'SECRET-SIGNATURE' });
    expect(out.report.thinkingFieldsDropped).toBe(1);
    expect(JSON.stringify(out.value)).not.toContain('SECRET-SIGNATURE');
  });

  it('drops a thinking block nested arbitrarily deep', () => {
    const out = redactJson({ a: { b: [{ c: [{ type: 'thinking', thinking: 'SECRET' }] }] } });
    expect(out.report.thinkingBlocksDropped).toBe(1);
    expect(JSON.stringify(out.value)).not.toContain('SECRET');
  });
});

// ---------------------------------------------------------------------------
// G3 — nothing about input crashes
// ---------------------------------------------------------------------------

describe('redactJson robustness', () => {
  it('replaces subtrees past the depth limit instead of blowing the stack', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 5000; i++) deep = { next: deep };
    const out = redactJson(deep);
    expect(out.report.depthLimited).toBeGreaterThan(0);
    expect(JSON.stringify(out.value)).toContain(DEPTH_LIMIT_MARKER);
  });

  it('handles a deeply nested array without throwing', () => {
    let deep: unknown = [];
    for (let i = 0; i < 5000; i++) deep = [deep];
    expect(() => redactJson(deep)).not.toThrow();
  });

  it('normalises non-JSON scalars rather than emitting them', () => {
    expect(redactJson(undefined).value).toBeNull();
    expect(redactJson(Number.NaN).value).toBeNull();
    expect(redactJson(Number.POSITIVE_INFINITY).value).toBeNull();
  });

  it('reports lone surrogates', () => {
    expect(hasLoneSurrogate('plain')).toBe(false);
    expect(hasLoneSurrogate('\u{1F600}')).toBe(false); // a valid pair
    expect(hasLoneSurrogate('a\ud800b')).toBe(true); // unpaired high
    expect(hasLoneSurrogate('a\udc00b')).toBe(true); // unpaired low
    expect(hasLoneSurrogate('a\ud800')).toBe(true); // high at end of string
    expect(redactJson({ t: 'x\ud800' }).report.loneSurrogate).toBe(true);
    expect(redactJson({ t: 'x\u{1F600}' }).report.loneSurrogate).toBe(false);
  });

  it('truncates every string in the tree, not just the ones this phase renders', () => {
    const big = 'z'.repeat(9000);
    const out = redactJson(
      { attachment: { blob: big }, toolUseResult: big, message: { content: [{ type: 'text', text: big }] } },
      { maxPayloadBytes: 100 },
    );
    expect(out.report.truncatedStrings).toBe(3);
    expect(JSON.stringify(out.value)).not.toContain('z'.repeat(200));
  });
});

// ---------------------------------------------------------------------------
// (c) Offloaded tool results — pinned to the real capture
// ---------------------------------------------------------------------------

describe('parsePersistedOutputPointer (real captured stub)', () => {
  it('parses the measured stub and keeps only the basename', async () => {
    const stub = await realStubText();
    // Pin the captured bytes themselves.
    expect(stub.length).toBe(2184);
    expect(Buffer.byteLength(stub, 'utf8')).toBe(2186);
    expect(stub).toContain(
      'Full output saved to: C:\\Users\\dev\\.claude\\projects\\c--Users-dev-projects-agent-deck\\05c5482d-5568-44ce-97fe-bc9a6c15afc4\\tool-results\\b6uvpgxa4.txt',
    );

    const pointer = parsePersistedOutputPointer(stub);
    expect(pointer).toBeDefined();
    expect(pointer?.basename).toBe(TOOL_RESULT_BASENAME);
    expect(pointer?.reportedSize).toBe('62.3KB');
    expect(pointer?.previewSize).toBe('2KB');
    expect(pointer?.originalPath).toContain('C:\\Users\\dev\\.claude');
    expect(pointer?.preview.startsWith('===== run.mjs =====')).toBe(true);
    expect(pointer?.preview.endsWith('...')).toBe(true);
  });

  it("CC's own stub is already ~2 KB, so our 8 KB ceiling does not fire on it", async () => {
    const stub = await realStubText();
    expect(Buffer.byteLength(stub, 'utf8')).toBeLessThan(DEFAULT_MAX_PAYLOAD_BYTES);
    expect(redactText(stub).truncated).toBe(false);
  });

  it('returns undefined for ordinary inline output', () => {
    expect(parsePersistedOutputPointer('just some tool output')).toBeUndefined();
    expect(parsePersistedOutputPointer('')).toBeUndefined();
    expect(parsePersistedOutputPointer(undefined)).toBeUndefined();
    expect(parsePersistedOutputPointer(42)).toBeUndefined();
    expect(parsePersistedOutputPointer([{ type: 'text', text: 'x' }])).toBeUndefined();
  });

  it('refuses a stub whose path would escape the tool-results directory', () => {
    const evil =
      '<persisted-output>\nOutput too large (1KB). Full output saved to: C:\\x\\..\n\nPreview (first 2KB):\np\n</persisted-output>';
    expect(parsePersistedOutputPointer(evil)).toBeUndefined();
    expect(isSafeToolResultBasename('..')).toBe(false);
    expect(isSafeToolResultBasename('a/b')).toBe(false);
    expect(isSafeToolResultBasename('a\\b')).toBe(false);
    expect(isSafeToolResultBasename('')).toBe(false);
    expect(isSafeToolResultBasename('b6uvpgxa4.txt')).toBe(true);
  });

  it('tolerates a truncated or malformed stub without throwing', () => {
    expect(parsePersistedOutputPointer('<persisted-output>\nOutput too large (1KB). Full')).toBeUndefined();
    expect(parsePersistedOutputPointer('<persisted-output>')).toBeUndefined();
  });
});

describe('readRedactedToolResult (real 63,774-byte capture)', () => {
  it('resolves by basename under the ACTIVE root, never the path CC wrote', async () => {
    const stub = await realStubText();
    const pointer = parsePersistedOutputPointer(stub);
    expect(pointer).toBeDefined();
    if (pointer === undefined) return;

    const path = resolveToolResultPath(pointer.basename, {
      projectsRoot: FIXTURE_ROOT,
      slug: SLUG,
      sessionId: SESSION,
    });
    expect(path).toBe(TOOL_RESULT_FILE);
    expect(path).not.toContain('.claude\\projects');
  });

  it('never opens the absolute path embedded in the stub', async () => {
    const stub = await realStubText();
    const pointer = parsePersistedOutputPointer(stub);
    if (pointer === undefined) throw new Error('pointer expected');
    const opened: string[] = [];
    await readRedactedToolResult(pointer, {
      projectsRoot: FIXTURE_ROOT,
      slug: SLUG,
      sessionId: SESSION,
      readFileImpl: async (p) => {
        opened.push(p);
        return 'x';
      },
    });
    expect(opened).toEqual([TOOL_RESULT_FILE]);
    for (const p of opened) {
      // Never the CC home layout, never the literal string CC wrote. (This
      // repo's own checkout lives under a `.claude/worktrees/` path, so the
      // discriminating check is `.claude\projects`, not `.claude`.)
      expect(p.toLowerCase()).not.toContain(`${'.claude'}\\projects`);
      expect(p).not.toBe(pointer.originalPath);
      expect(p.startsWith(FIXTURE_ROOT)).toBe(true);
    }
  });

  it('reads the file and truncates it through the same 8 KB path', async () => {
    const stub = await realStubText();
    const pointer = parsePersistedOutputPointer(stub);
    if (pointer === undefined) throw new Error('pointer expected');

    const onDisk = await readFile(TOOL_RESULT_FILE, 'utf8');
    expect(Buffer.byteLength(onDisk, 'utf8')).toBe(63774);

    const read = await readRedactedToolResult(pointer, {
      projectsRoot: FIXTURE_ROOT,
      slug: SLUG,
      sessionId: SESSION,
    });
    expect(read.ok).toBe(true);
    expect(read.degraded).toBe(false);
    expect(read.originalBytes).toBe(63774);
    expect(read.truncated).toBe(true);

    const m = TRUNCATION_MARKER_RE.exec(read.text);
    expect(m).not.toBeNull();
    expect(m?.[2]).toBe('63774');
    const payload = read.text.replace(TRUNCATION_MARKER_RE, '');
    expect(Buffer.byteLength(payload, 'utf8')).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
    expect(payload).toBe(
      Buffer.from(onDisk, 'utf8').subarray(0, DEFAULT_MAX_PAYLOAD_BYTES).toString('utf8'),
    );
    // The tail of the real file must not survive.
    expect(read.text).not.toContain(onDisk.slice(-200));
  });

  it('honours a configured ceiling on the offloaded path too', async () => {
    const stub = await realStubText();
    const pointer = parsePersistedOutputPointer(stub);
    if (pointer === undefined) throw new Error('pointer expected');
    const read = await readRedactedToolResult(pointer, {
      projectsRoot: FIXTURE_ROOT,
      slug: SLUG,
      sessionId: SESSION,
      maxPayloadBytes: 512,
    });
    expect(read.text.replace(TRUNCATION_MARKER_RE, '').length).toBeLessThanOrEqual(512);
  });

  it('degrades to the stub preview when the file is missing — counted, not thrown', async () => {
    const stub = await realStubText();
    const pointer = parsePersistedOutputPointer(stub);
    if (pointer === undefined) throw new Error('pointer expected');
    const read = await readRedactedToolResult(pointer, {
      projectsRoot: tmpRoot, // empty temp tree: the file is not there
      slug: SLUG,
      sessionId: SESSION,
    });
    expect(read.ok).toBe(false);
    expect(read.degraded).toBe(true);
    expect(read.code).toBe('ENOENT');
    expect(read.reason).toContain('b6uvpgxa4.txt');
    expect(read.text.startsWith('===== run.mjs =====')).toBe(true);
  });

  it('degrades on any reader error, including a non-errno throw', async () => {
    const stub = await realStubText();
    const pointer = parsePersistedOutputPointer(stub);
    if (pointer === undefined) throw new Error('pointer expected');
    const read = await readRedactedToolResult(pointer, {
      projectsRoot: FIXTURE_ROOT,
      slug: SLUG,
      sessionId: SESSION,
      readFileImpl: () => Promise.reject('not an Error object'),
    });
    expect(read.ok).toBe(false);
    expect(read.code).toBe('EUNKNOWN');
    expect(read.degraded).toBe(true);
  });

  it('reads an offloaded file that ends mid-multi-byte-character safely', async () => {
    const dir = join(tmpRoot, SLUG, SESSION, 'tool-results');
    await mkdir(dir, { recursive: true });
    const target = join(dir, 'multibyte.txt');
    await writeFile(target, '☃'.repeat(4000), 'utf8'); // 12,000 bytes

    const read = await readRedactedToolResult(
      { originalPath: 'C:\\nope\\multibyte.txt', basename: 'multibyte.txt', preview: '' },
      { projectsRoot: tmpRoot, slug: SLUG, sessionId: SESSION },
    );
    expect(read.ok).toBe(true);
    expect(read.originalBytes).toBe(12000);
    const payload = read.text.replace(TRUNCATION_MARKER_RE, '');
    expect(payload.includes('\ufffd')).toBe(false);
    expect(Buffer.byteLength(payload, 'utf8') % 3).toBe(0);
  });
});

describe('G1 read-only', () => {
  it('leaves the captured tool-results file byte-identical after a full read', async () => {
    const before = await readFile(TOOL_RESULT_FILE);
    const stub = await realStubText();
    const pointer = parsePersistedOutputPointer(stub);
    if (pointer === undefined) throw new Error('pointer expected');
    await readRedactedToolResult(pointer, {
      projectsRoot: FIXTURE_ROOT,
      slug: SLUG,
      sessionId: SESSION,
    });
    const after = await readFile(TOOL_RESULT_FILE);
    expect(after.equals(before)).toBe(true);
  });
});

describe('constants', () => {
  it('exposes the depth limit it enforces', () => {
    expect(MAX_REDACTION_DEPTH).toBe(64);
  });
});
