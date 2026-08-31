/**
 * Agent Deck — fuzz corpus.
 *
 * 1,000+ corrupted transcript lines and 340 corrupted sidecars are pushed
 * through the real pipeline — `FileTail` → `parseLines` → `redactJson` →
 * `fingerprintSession` → `attributeSubagents` — and the suite asserts three
 * things:
 *
 *   1. ZERO CRASHES. Nothing throws. Every call is wrapped so that a throw is
 *      recorded as a test failure with the seed and the offending input rather
 *      than aborting the run — the assertion is `thrown.length === 0`, which is
 *      a proof that the modules do not throw, not a licence to swallow.
 *   2. THE COUNTER IS EXACT. Not "at least N". The set of rejected line indices
 *      is compared element-by-element against an INDEPENDENT oracle
 *      (`classify()` below) that re-implements the documented contract of
 *      `parse.ts` from its rules, using nothing but `JSON.parse` and a
 *      hand-written surrogate check. An off-by-one, or a rejection landing on
 *      the wrong line, fails.
 *   3. CORRUPTION DOES NOT SPREAD. Good lines interleaved with bad ones are
 *      recovered in order, with their `uuid`s intact.
 *
 * The corpus is generated from a fixed seed with a PRNG written into this file
 * (`mulberry32`), never `Math.random()`: a failure is reproducible and points
 * at a specific input. The seed is printed on any failure and can be overridden
 * with `AGENT_DECK_FUZZ_SEED` to widen the search locally.
 *
 * Grounding constraints:
 *
 *   G1  Read-only. Every corrupted byte is written to a fresh directory under
 *       the OS temp dir; the committed fixtures are never touched. This file
 *       hashes all of `fixtures/cc-2.1.234/` before and after the whole run and
 *       asserts byte-identity.
 *   G3  Refuse, don't guess — the entire point.
 *   G5  Zero egress. Node built-ins only.
 *   G7  In-memory only. The temp tree is removed in `afterAll`.
 *
 * Runtime budget: this file runs in every future phase's suite, so it is sized
 * to seconds. Corpus sizes are constants at the top; raise them for a local
 * soak, not in the committed default.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SubagentMeta } from '../model/events.js';
import type { AttributionInput, TranscriptSource } from './attribution.js';
import { attributeSubagents, loadSessionForAttribution, splitTranscript } from './attribution.js';
import { fingerprintSession } from './fingerprint.js';
import type { MismatchCode } from './fingerprint.js';
import { KNOWN_ENTRY_TYPES, parseLines, parseSubagentMeta } from './parse.js';
import { redactJson, redactText } from './redact.js';
import { FileTail } from './tailer.js';

// ---------------------------------------------------------------------------
// Corpus size — the DoD floor is 1,000 corrupted transcript lines
// ---------------------------------------------------------------------------

/** Corrupted lines per transcript file; 3 files => 1,050 corrupted lines. */
const CORRUPT_LINES_PER_FILE = 350;
const TRANSCRIPT_FILES = 3;
const TOTAL_CORRUPT_LINES = CORRUPT_LINES_PER_FILE * TRANSCRIPT_FILES;
/** Good lines interleaved among them, per file. */
const GOOD_LINES_PER_FILE = 60;

/** Corrupted sidecars parsed in memory. */
const CORRUPT_SIDECARS_IN_MEMORY = 300;
/** Corrupted sidecars written to disk and fingerprinted. */
const CORRUPT_SIDECARS_ON_DISK = 40;

const SEED = Number(process.env['AGENT_DECK_FUZZ_SEED'] ?? 0x5eed1234);

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32. Written out so a seed reproduces a corpus exactly.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  #next: () => number;
  constructor(readonly seed: number) {
    this.#next = mulberry32(seed);
  }
  float(): number {
    return this.#next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.#next() * maxExclusive);
  }
  /** Inclusive range. */
  between(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty array');
    return item;
  }
}

// ---------------------------------------------------------------------------
// The independent oracle
// ---------------------------------------------------------------------------

/**
 * A lone UTF-16 surrogate: a high surrogate with no low after it, or a low
 * surrogate with no high before it. Hand-written here on purpose — reusing
 * `redact.ts`'s own detector would make the counter assertion circular.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function anyStringHasLoneSurrogate(value: unknown, depth = 0): boolean {
  if (depth > 200) return false;
  if (typeof value === 'string') return LONE_SURROGATE_RE.test(value);
  if (Array.isArray(value)) return value.some((v) => anyStringHasLoneSurrogate(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (LONE_SURROGATE_RE.test(k)) return true;
      if (anyStringHasLoneSurrogate(v, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Independent restatement of `parse.ts`'s documented line contract:
 * a line is REJECTED unless it is a JSON object with a non-empty string `type`
 * drawn from `KNOWN_ENTRY_TYPES` and contains no unpaired surrogate.
 *
 * `KNOWN_ENTRY_TYPES` is imported rather than re-typed because it is the
 * measured fixture fact (G6), not the logic under test.
 */
function classify(line: string): { rejected: true; why: string } | { rejected: false } {
  if (line.trim() === '') return { rejected: true, why: 'blank' };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { rejected: true, why: 'invalidJson' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { rejected: true, why: 'notAnObject' };
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || type === '') return { rejected: true, why: 'missingType' };
  if (!KNOWN_ENTRY_TYPES.has(type)) return { rejected: true, why: 'unknownType' };
  if (anyStringHasLoneSurrogate(value)) return { rejected: true, why: 'loneSurrogate' };
  return { rejected: false };
}

// ---------------------------------------------------------------------------
// Corpus construction
// ---------------------------------------------------------------------------

const SESSION_ID = 'deadbeef-0000-4000-8000-00000000fuzz'.replace('fuzz', '0f22');
const VERSION = '2.1.234';

/** A well-formed line. `seq` is recoverable from the parsed entry's `uuid`. */
function goodLine(seq: number, agentId?: string): string {
  const entry: Record<string, unknown> = {
    parentUuid: seq === 0 ? null : `0000${String(seq - 1).padStart(4, '0')}-0000-4000-8000-000000000000`,
    isSidechain: agentId !== undefined,
    type: 'assistant',
    uuid: `0000${String(seq).padStart(4, '0')}-0000-4000-8000-000000000000`,
    timestamp: '2026-08-19T00:00:00.000Z',
    sessionId: SESSION_ID,
    version: VERSION,
    cwd: 'C:\\FUZZ',
    gitBranch: 'fuzz',
    message: { role: 'assistant', content: [{ type: 'text', text: `good line ${seq}` }] },
  };
  if (agentId !== undefined) entry['agentId'] = agentId;
  return JSON.stringify(entry);
}

/** A line rich in multi-byte characters, for the mid-UTF-8 truncations. */
function multibyteLine(seq: number): string {
  return JSON.stringify({
    type: 'user',
    uuid: `0000${String(seq).padStart(4, '0')}-0000-4000-8000-000000000000`,
    sessionId: SESSION_ID,
    message: { role: 'user', content: [{ type: 'text', text: 'ｆｕｌｌｗｉｄｔｈ 日本語 ☃ é 🙂 ' }] },
  });
}

const CORRUPTION_KINDS = [
  'truncateMidJson',
  'truncateMidUtf8',
  'truncateMidEscape',
  'bitFlip',
  'injectNul',
  'injectControlChar',
  'unbalancedBrace',
  'unbalancedBracket',
  'scalarJson',
  'arrayJson',
  'nullJson',
  'enormousString',
  'deeplyNested',
  'loneSurrogate',
  'duplicateKeyWins',
  'bom',
] as const;

type CorruptionKind = (typeof CORRUPTION_KINDS)[number];

/**
 * Newlines are the ONE thing a corruption may not introduce: a stray `\n`
 * would split one corrupt line into two and silently change the denominator
 * the counter is being checked against. CR and LF bytes are mapped to spaces.
 * CRLF is exercised deliberately, as a line TERMINATOR, further down.
 */
function stripNewlines(buf: Buffer): Buffer {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) {
    const byte = out[i];
    if (byte === 0x0a || byte === 0x0d) out[i] = 0x20;
  }
  return out;
}

interface CorruptLine {
  kind: CorruptionKind;
  bytes: Buffer;
}

function makeCorruption(rng: Rng, kind: CorruptionKind, seq: number): Buffer {
  const base = goodLine(seq);
  switch (kind) {
    case 'truncateMidJson': {
      const cut = rng.between(1, base.length - 1);
      return Buffer.from(base.slice(0, cut), 'utf8');
    }
    case 'truncateMidUtf8': {
      const bytes = Buffer.from(multibyteLine(seq), 'utf8');
      // Cut inside the multi-byte tail: any continuation byte (0b10xxxxxx).
      let cut = rng.between(Math.floor(bytes.length * 0.6), bytes.length - 1);
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[(cut + i) % bytes.length];
        if (b !== undefined && (b & 0xc0) === 0x80) {
          cut = (cut + i) % bytes.length;
          break;
        }
      }
      return bytes.subarray(0, Math.max(cut, 1));
    }
    case 'truncateMidEscape': {
      const withEscape = JSON.stringify({
        type: 'user',
        sessionId: SESSION_ID,
        text: `esc-${seq}\u0007\u00e9`,
      });
      const at = withEscape.lastIndexOf('\\u');
      return Buffer.from(withEscape.slice(0, at + rng.between(2, 4)), 'utf8');
    }
    case 'bitFlip': {
      // Structural characters only. Flipping a bit inside a string value is
      // very often harmless, and a corruption that does not corrupt would make
      // the count a lie.
      const structural = new Set(['{', '}', '[', ']', '"', ':', ',']);
      const positions: number[] = [];
      for (let i = 0; i < base.length; i++) {
        const ch = base[i];
        if (ch !== undefined && structural.has(ch)) positions.push(i);
      }
      const bytes = Buffer.from(base, 'utf8');
      for (let attempt = 0; attempt < 12; attempt++) {
        const at = rng.pick(positions);
        const bit = 1 << rng.int(7);
        const candidate = Buffer.from(bytes);
        const original = candidate[at];
        if (original === undefined) continue;
        candidate[at] = original ^ bit;
        const cleaned = stripNewlines(candidate);
        if (classify(cleaned.toString('utf8')).rejected) return cleaned;
      }
      // Deterministic fallback: remove the opening brace outright.
      return Buffer.from(base.slice(1), 'utf8');
    }
    case 'injectNul':
    case 'injectControlChar': {
      // A raw control character inside a JSON string is invalid JSON.
      const marker = '"text":"';
      const at = base.indexOf(marker) + marker.length;
      const code = kind === 'injectNul' ? 0x00 : rng.between(0x01, 0x08);
      const bytes = Buffer.from(base, 'utf8');
      return Buffer.concat([
        bytes.subarray(0, at),
        Buffer.from([code]),
        bytes.subarray(at),
      ]);
    }
    case 'unbalancedBrace':
      return Buffer.from(rng.float() < 0.5 ? `${base}}` : base.replace('{', ''), 'utf8');
    case 'unbalancedBracket':
      return Buffer.from(rng.float() < 0.5 ? `${base}]` : base.replace('[', ''), 'utf8');
    case 'scalarJson':
      return Buffer.from(rng.pick(['42', '-0.5', 'true', 'false', '"a bare string"']), 'utf8');
    case 'arrayJson':
      return Buffer.from(JSON.stringify([{ type: 'assistant' }, seq]), 'utf8');
    case 'nullJson':
      return Buffer.from('null', 'utf8');
    case 'enormousString': {
      // Valid JSON, ~64 KB, with the bulk in `type` so it is rejected for a
      // reason the oracle can restate rather than for its size.
      const huge = 'x'.repeat(64 * 1024);
      return Buffer.from(JSON.stringify({ type: huge, sessionId: SESSION_ID }), 'utf8');
    }
    case 'deeplyNested': {
      const depth = rng.between(500, 3000);
      const text = `{"sessionId":"${SESSION_ID}","deep":${'['.repeat(depth)}1${']'.repeat(depth)}}`;
      return Buffer.from(text, 'utf8');
    }
    case 'loneSurrogate': {
      // Valid JSON. `parse.ts` rejects it because it cannot round-trip UTF-8.
      const escape = rng.float() < 0.5 ? '\\ud83d' : '\\udc00';
      return Buffer.from(
        `{"type":"assistant","sessionId":"${SESSION_ID}","message":{"role":"assistant","content":[{"type":"text","text":"${escape} orphan ${seq}"}]}}`,
        'utf8',
      );
    }
    case 'duplicateKeyWins': {
      // Two `type` keys. Last wins per JSON semantics, and the last is unknown:
      // a parser that read the FIRST occurrence would accept this line.
      return Buffer.from(
        `{"type":"assistant","sessionId":"${SESSION_ID}","uuid":"dup-${seq}","type":"a-type-that-does-not-exist"}`,
        'utf8',
      );
    }
    case 'bom':
      return Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(base, 'utf8')]);
  }
}

/** One corrupted line, guaranteed non-blank, newline-free, and oracle-rejected. */
function corruptLine(rng: Rng, seq: number): CorruptLine {
  for (let attempt = 0; attempt < 32; attempt++) {
    const kind = rng.pick(CORRUPTION_KINDS);
    const bytes = stripNewlines(makeCorruption(rng, kind, seq));
    const text = bytes.toString('utf8');
    if (text.trim() === '') continue;
    if (!classify(text).rejected) continue;
    return { kind, bytes };
  }
  throw new Error(`seed ${rng.seed}: could not build a corrupt line at seq ${seq}`);
}

// ---------------------------------------------------------------------------
// Corrupted sidecars
// ---------------------------------------------------------------------------

const VALID_META: SubagentMeta = {
  agentType: 'general-purpose',
  description: 'fuzz',
  toolUseId: 'toolu_FUZZ0000000000000000001',
  spawnDepth: 1,
};

function corruptSidecar(rng: Rng, seq: number): string {
  const base = JSON.stringify({ ...VALID_META, description: `fuzz-${seq}` });
  const kind = rng.int(14);
  switch (kind) {
    case 0:
      return base.slice(0, rng.between(1, base.length - 1)); // truncated
    case 1:
      return '';
    case 2:
      return '   \n\t  ';
    case 3:
      return 'null';
    case 4:
      return '[1,2,3]';
    case 5:
      return '"a bare string"';
    case 6:
      return base.replace('"toolUseId"', '"toolUseIdX"'); // key renamed away
    case 7:
      return base.replace(VALID_META.toolUseId, ''); // key present but empty
    case 8:
      return base.replace(VALID_META.toolUseId, '   '); // key present but blank
    case 9:
      return base.replace('"spawnDepth":1', '"spawnDepth":"1"'); // wrong type
    case 10:
      return `\uFEFF${base}`; // BOM
    case 11:
      return `${base}}`; // unbalanced
    case 12:
      return base.replace('"description"', '"\ud800description"'); // lone surrogate in a key
    default: {
      // Bit flip on a structural character.
      const bytes = Buffer.from(base, 'utf8');
      const at = rng.int(bytes.length);
      const original = bytes[at];
      if (original !== undefined) bytes[at] = original ^ (1 << rng.int(7));
      return bytes.toString('utf8');
    }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CAPTURED_ROOT = fileURLToPath(new URL('../../fixtures/cc-2.1.234', import.meta.url));

interface Snapshot {
  path: string;
  size: number;
  sha256: string;
}

async function snapshot(root: string): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const body = await readFile(full);
      out.push({
        path: relative(root, full).split(sep).join('/'),
        size: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
      });
    }
  };
  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Every throw seen anywhere in this file, with the seed and the input. */
const thrown: string[] = [];

function noThrow<T>(label: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error: unknown) {
    thrown.push(
      `seed=${SEED} ${label}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
    return undefined;
  }
}

async function noThrowAsync<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error: unknown) {
    thrown.push(
      `seed=${SEED} ${label}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
    return undefined;
  }
}

let temp: string;
let capturedBefore: Snapshot[];

beforeAll(async () => {
  capturedBefore = await snapshot(CAPTURED_ROOT);
  temp = await mkdtemp(join(tmpdir(), 'agent-deck-fuzz-'));
});

afterAll(async () => {
  // G1: every corrupted byte went to the temp tree, never to the fixtures.
  expect(await snapshot(CAPTURED_ROOT)).toEqual(capturedBefore);
  await rm(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Transcript fuzz
// ---------------------------------------------------------------------------

interface BuiltFile {
  path: string;
  /** Index -> what we injected. `undefined` marks a good line. */
  plan: ({ kind: CorruptionKind } | { good: number })[];
}

/**
 * Write one transcript: `GOOD_LINES_PER_FILE` good lines interleaved among
 * `CORRUPT_LINES_PER_FILE` corrupted ones, with terminators alternating between
 * LF and CRLF so the CRLF-mixed-into-LF case is exercised on real bytes.
 */
async function buildTranscript(rng: Rng, path: string, agentId?: string): Promise<BuiltFile> {
  const plan: BuiltFile['plan'] = [];
  const chunks: Buffer[] = [];
  const total = CORRUPT_LINES_PER_FILE + GOOD_LINES_PER_FILE;
  let goodSeq = 0;
  let goodLeft = GOOD_LINES_PER_FILE;
  let corruptLeft = CORRUPT_LINES_PER_FILE;

  for (let i = 0; i < total; i++) {
    const takeGood =
      corruptLeft === 0 || (goodLeft > 0 && rng.float() < goodLeft / (goodLeft + corruptLeft));
    if (takeGood) {
      const seq = goodSeq++;
      goodLeft--;
      plan.push({ good: seq });
      chunks.push(Buffer.from(goodLine(seq, agentId), 'utf8'));
    } else {
      corruptLeft--;
      const line = corruptLine(rng, i);
      plan.push({ kind: line.kind });
      chunks.push(line.bytes);
    }
    chunks.push(Buffer.from(rng.float() < 0.15 ? '\r\n' : '\n', 'utf8'));
  }

  await writeFile(path, Buffer.concat(chunks));
  return { path, plan };
}

describe('fuzz: corrupted transcript lines', () => {
  let built: BuiltFile[];

  beforeAll(async () => {
    const rng = new Rng(SEED);
    built = [];
    built.push(await buildTranscript(rng, join(temp, `${SESSION_ID}.jsonl`)));
    await mkdir(join(temp, SESSION_ID, 'subagents'), { recursive: true });
    for (let i = 1; i < TRANSCRIPT_FILES; i++) {
      const agentId = `afuzz00000000000${i}`;
      built.push(
        await buildTranscript(
          rng,
          join(temp, SESSION_ID, 'subagents', `agent-${agentId}.jsonl`),
          agentId,
        ),
      );
    }
  });

  it(`injects ${TOTAL_CORRUPT_LINES} corrupted lines across ${TRANSCRIPT_FILES} transcript files`, () => {
    const corrupt = built.reduce(
      (n, f) => n + f.plan.filter((p) => 'kind' in p).length,
      0,
    );
    expect(corrupt).toBe(TOTAL_CORRUPT_LINES);
    expect(corrupt).toBeGreaterThanOrEqual(1000);
    // Every corruption kind is actually exercised.
    const kinds = new Set<string>();
    for (const f of built) for (const p of f.plan) if ('kind' in p) kinds.add(p.kind);
    expect([...kinds].sort()).toEqual([...CORRUPTION_KINDS].sort());
  });

  it('the tailer recovers exactly the lines that were written, and never throws', async () => {
    for (const file of built) {
      const tail = new FileTail(file.path, { sessionId: SESSION_ID });
      const result = await noThrowAsync(`FileTail(${file.path})`, () => tail.read());
      expect(result?.skipped).toBeUndefined();
      const independent = splitTranscript((await readFile(file.path)).toString('utf8'));
      expect(result?.lines.map((l) => l.text)).toEqual(independent);
      expect(independent).toHaveLength(CORRUPT_LINES_PER_FILE + GOOD_LINES_PER_FILE);
      expect(tail.pendingBytes).toBe(0);
    }
    expect(thrown).toEqual([]);
  });

  it('malformedLines is EXACTLY the number of rejected lines, on the exact indices', async () => {
    for (const file of built) {
      const lines = splitTranscript((await readFile(file.path)).toString('utf8'));
      const expectedRejected: number[] = [];
      const expectedWhy: string[] = [];
      lines.forEach((line, i) => {
        const verdict = classify(line);
        if (verdict.rejected) {
          expectedRejected.push(i);
          expectedWhy.push(verdict.why);
        }
      });

      const batch = noThrow(`parseLines(${file.path})`, () => parseLines(lines));
      if (batch === undefined || !batch.ok) throw new Error(`seed=${SEED}: parseLines refused`);

      expect(batch.diagnostics.malformedLines).toBe(expectedRejected.length);
      expect(batch.diagnostics.parsedLines).toBe(lines.length - expectedRejected.length);
      expect(batch.diagnostics.malformedLines + batch.diagnostics.parsedLines).toBe(lines.length);
      // Exact indices, not just the count: a rejection landing on the wrong
      // line would keep the total right while losing a different record.
      expect(batch.value.rejections.map((r) => r.index)).toEqual(expectedRejected);
      // And for the same stated reason.
      expect(batch.value.rejections.map((r) => r.rejection)).toEqual(expectedWhy);
      // Every injected corruption was rejected; nothing else was.
      expect(expectedRejected).toHaveLength(CORRUPT_LINES_PER_FILE);
      expect(batch.value.entries).toHaveLength(GOOD_LINES_PER_FILE);
    }
    expect(thrown).toEqual([]);
  });

  it('good lines interleaved with corruption survive intact and in order', async () => {
    for (const file of built) {
      const lines = splitTranscript((await readFile(file.path)).toString('utf8'));
      const batch = parseLines(lines);
      if (!batch.ok) throw new Error('parseLines refused');
      const expectedUuids = file.plan
        .filter((p): p is { good: number } => 'good' in p)
        .map((p) => `0000${String(p.good).padStart(4, '0')}-0000-4000-8000-000000000000`);
      expect(batch.value.entries.map((e) => e['uuid'])).toEqual(expectedUuids);
      for (const entry of batch.value.entries) {
        expect(entry.type).toBe('assistant');
        expect(entry['sessionId']).toBe(SESSION_ID);
      }
    }
  });

  it('redaction never throws on the corpus, valid or not', async () => {
    for (const file of built) {
      for (const line of splitTranscript((await readFile(file.path)).toString('utf8'))) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          value = line; // feed the raw text instead
        }
        noThrow('redactJson', () => redactJson(value));
        noThrow('redactText', () => redactText(line));
      }
    }
    expect(thrown).toEqual([]);
  });

  it('fingerprints a session built entirely of corrupted transcripts without throwing', async () => {
    const result = await noThrowAsync('fingerprintSession(corrupt transcripts)', () =>
      fingerprintSession(join(temp, `${SESSION_ID}.jsonl`)),
    );
    expect(result).toBeDefined();
    if (result === undefined) return;
    // Accepted or refused, but always described and never a partial tree.
    if (!result.ok) {
      expect(result.mismatch.kind).toBe('schemaMismatch');
      expect(result.mismatch.reason.length).toBeGreaterThan(0);
    } else {
      expect(result.diagnostics.malformedLines).toBeGreaterThan(0);
    }
    expect(thrown).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sidecar fuzz — the half most likely to be skipped
// ---------------------------------------------------------------------------

describe('fuzz: corrupted sidecars', () => {
  const transcripts: TranscriptSource[] = [
    {
      kind: 'main',
      path: '/fuzz/main.jsonl',
      entries: [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: VALID_META.toolUseId, name: 'Agent', input: {} }],
          },
        },
      ],
    },
  ];

  it(`parses ${CORRUPT_SIDECARS_IN_MEMORY} corrupted sidecars without throwing`, () => {
    const rng = new Rng(SEED ^ 0x51de);
    let refused = 0;
    let accepted = 0;
    for (let i = 0; i < CORRUPT_SIDECARS_IN_MEMORY; i++) {
      const text = corruptSidecar(rng, i);
      const result = noThrow(`parseSubagentMeta(${JSON.stringify(text.slice(0, 60))})`, () =>
        parseSubagentMeta(text, `/fuzz/agent-a${i}.meta.json`),
      );
      expect(result).toBeDefined();
      if (result === undefined) continue;
      if (result.ok) {
        accepted++;
        // Anything accepted must carry a usable join key.
        expect(typeof result.value.toolUseId).toBe('string');
        expect(result.value.toolUseId).not.toBe('');
      } else {
        refused++;
        // A refusal is described, not silent.
        expect(result.mismatch.kind).toBe('schemaMismatch');
        expect(result.mismatch.reason.length).toBeGreaterThan(0);
        expect(result.diagnostics.skippedFiles).toHaveLength(1);
      }
    }
    expect(refused + accepted).toBe(CORRUPT_SIDECARS_IN_MEMORY);
    expect(refused).toBeGreaterThan(0);
    expect(thrown).toEqual([]);
  });

  it('a corrupted sidecar yields UNRESOLVED, never a guessed parent', () => {
    const rng = new Rng(SEED ^ 0x51de);
    let unresolved = 0;
    let resolved = 0;
    for (let i = 0; i < CORRUPT_SIDECARS_IN_MEMORY; i++) {
      const text = corruptSidecar(rng, i);
      const parsed = parseSubagentMeta(text, `/fuzz/agent-a${i}.meta.json`);
      const source = parsed.ok
        ? { agentId: `afuzz${i}`, metaPath: `/fuzz/agent-a${i}.meta.json`, meta: parsed.value }
        : {
            agentId: `afuzz${i}`,
            metaPath: `/fuzz/agent-a${i}.meta.json`,
            metaFailure: parsed.mismatch.reason,
          };
      const input: AttributionInput = { transcripts, subagents: [source] };
      const report = noThrow(`attributeSubagents(sidecar ${i})`, () => attributeSubagents(input));
      expect(report).toBeDefined();
      if (report === undefined) continue;
      const a = report.attributions[0];
      expect(a).toBeDefined();
      if (a === undefined) continue;
      expect(a.status).not.toBe('ambiguous');
      if (a.status === 'resolved') {
        resolved++;
        // The ONLY licence to resolve is a key that really is in a transcript.
        expect(a.toolUseId).toBe(VALID_META.toolUseId);
        expect(a.parent.transcriptPath).toBe('/fuzz/main.jsonl');
      } else if (a.status === 'unresolved') {
        unresolved++;
        expect(['sidecarUnusable', 'missingJoinKey', 'noMatchingToolUse']).toContain(a.code);
      }
    }
    expect(unresolved + resolved).toBe(CORRUPT_SIDECARS_IN_MEMORY);
    expect(unresolved).toBeGreaterThan(0);
    expect(thrown).toEqual([]);
  });

  it(`fingerprints ${CORRUPT_SIDECARS_ON_DISK} sessions with corrupted sidecars on disk`, async () => {
    const rng = new Rng(SEED ^ 0xd15c);
    const knownCodes: MismatchCode[] = [
      'metaInvalidJson',
      'metaNotAnObject',
      'metaFieldMissing',
      'metaFieldType',
      'metaParentAgentIdRule',
      'metaUnreadable',
      'subagentMetaMissing',
      'agentIdMismatch',
      'sessionIdMismatch',
      'entryFieldMissing',
      'entryFieldType',
      'unsupportedVersion',
      'versionChangedMidFile',
    ];
    let refusals = 0;
    let acceptances = 0;

    for (let i = 0; i < CORRUPT_SIDECARS_ON_DISK; i++) {
      const dir = join(temp, `sidecar-case-${i}`);
      const agentId = `afuzzdisk${String(i).padStart(6, '0')}`;
      await mkdir(join(dir, SESSION_ID, 'subagents'), { recursive: true });
      await writeFile(
        join(dir, `${SESSION_ID}.jsonl`),
        `${JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          type: 'assistant',
          uuid: '00000001-0000-4000-8000-000000000001',
          timestamp: '2026-08-19T00:00:00.000Z',
          sessionId: SESSION_ID,
          version: VERSION,
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: VALID_META.toolUseId, name: 'Agent', input: {} }],
          },
        })}\n`,
      );
      await writeFile(
        join(dir, SESSION_ID, 'subagents', `agent-${agentId}.jsonl`),
        `${JSON.stringify({
          parentUuid: null,
          isSidechain: true,
          type: 'user',
          uuid: '00000002-0000-4000-8000-000000000002',
          timestamp: '2026-08-19T00:00:01.000Z',
          sessionId: SESSION_ID,
          version: VERSION,
          agentId,
          message: { role: 'user', content: [{ type: 'text', text: 'FUZZ' }] },
        })}\n`,
      );
      await writeFile(
        join(dir, SESSION_ID, 'subagents', `agent-${agentId}.meta.json`),
        corruptSidecar(rng, i),
      );

      const fp = await noThrowAsync(`fingerprintSession(sidecar-case-${i})`, () =>
        fingerprintSession(join(dir, `${SESSION_ID}.jsonl`)),
      );
      expect(fp).toBeDefined();
      if (fp === undefined) continue;

      if (!fp.ok) {
        refusals++;
        expect(fp.mismatch.reason.length).toBeGreaterThan(0);
        expect(knownCodes).toContain(fp.mismatch.code);
        continue;
      }
      acceptances++;
      // Accepted: the sidecar survived corruption as valid. The join must then
      // be honest about whether the key matches anything.
      const loaded = await noThrowAsync(`loadSessionForAttribution(${i})`, () =>
        loadSessionForAttribution(fp.value),
      );
      expect(loaded).toBeDefined();
      if (loaded === undefined) continue;
      const report = noThrow(`attributeSubagents(disk ${i})`, () =>
        attributeSubagents(loaded.input),
      );
      expect(report).toBeDefined();
      const a = report?.attributions[0];
      if (a?.status === 'resolved') {
        expect(a.toolUseId).toBe(VALID_META.toolUseId);
      }
    }

    expect(refusals + acceptances).toBe(CORRUPT_SIDECARS_ON_DISK);
    expect(refusals).toBeGreaterThan(0);
    expect(thrown).toEqual([]);
  }, 120_000);

  it(`injected ${TOTAL_CORRUPT_LINES + CORRUPT_SIDECARS_IN_MEMORY + CORRUPT_SIDECARS_ON_DISK} corrupted inputs in total, with zero throws`, () => {
    expect(TOTAL_CORRUPT_LINES + CORRUPT_SIDECARS_IN_MEMORY + CORRUPT_SIDECARS_ON_DISK).toBe(1390);
    expect(thrown).toEqual([]);
  });
});
