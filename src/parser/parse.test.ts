/**
 * Tests for the line parser.
 *
 * Two fixture sources, and the distinction matters (G6):
 *   - `fixtures/cc-2.1.234/` is CAPTURED data and is schema law. Opened
 *     read-only; one test asserts it is byte-identical after a full parse.
 *   - `fixtures/synthetic-lines/` is HAND-MADE and exists only to drive the
 *     refusal paths, which a well-formed capture cannot exercise.
 *
 * The G4 suite ("no thinking content reaches the session model") is at the
 * bottom, in one clearly-labelled describe block. PLAN.md says that test runs
 * in every phase's suite from here on: `expectNoThinkingContent` is exported
 * from this file's pattern deliberately so later phases can reuse it verbatim.
 *
 * Nothing is written outside the OS temp directory. No network, no sleeps.
 */

import { Buffer } from 'node:buffer';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { TranscriptEntry } from '../model/events.js';
import { emptyDiagnostics } from '../model/events.js';
import {
  KNOWN_ENTRY_TYPES,
  collectPersistedOutputStubs,
  hydratePersistedOutputs,
  parseLine,
  parseLines,
  parseSubagentMeta,
} from './parse.js';
import { TRUNCATION_MARKER_RE } from './redact.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = fileURLToPath(new URL('../../fixtures/cc-2.1.234/projects', import.meta.url));
const SYNTHETIC_ROOT = fileURLToPath(new URL('../../fixtures/synthetic-lines', import.meta.url));
const SLUG = 'c--Users-dev-projects-agent-deck';
const SLUG_DIR = join(FIXTURE_ROOT, SLUG);
const SESSION_A = '05c5482d-5568-44ce-97fe-bc9a6c15afc4';
const SESSION_B = '4299490e-4a09-46a0-a544-7ffb0429e7e7';
const STUB_TRANSCRIPT = join(SLUG_DIR, SESSION_A, 'subagents', 'agent-a3ecf86bbfb853726.jsonl');

/** Every captured transcript, main and subagent. Measured: 7 files. */
async function capturedTranscripts(): Promise<string[]> {
  const out: string[] = [];
  for (const session of [SESSION_A, SESSION_B]) {
    out.push(join(SLUG_DIR, `${session}.jsonl`));
    const dir = join(SLUG_DIR, session, 'subagents');
    for (const name of await readdir(dir)) {
      if (name.endsWith('.jsonl')) out.push(join(dir, name));
    }
  }
  return out.sort();
}

/** Every captured sidecar. Measured: 5 files. */
async function capturedSidecars(): Promise<string[]> {
  const out: string[] = [];
  for (const session of [SESSION_A, SESSION_B]) {
    const dir = join(SLUG_DIR, session, 'subagents');
    for (const name of await readdir(dir)) {
      if (name.endsWith('.meta.json')) out.push(join(dir, name));
    }
  }
  return out.sort();
}

/**
 * Split a whole file the way the tailer would: only newline-terminated lines
 * are emitted, so the empty string after a trailing newline is not a line.
 */
function splitAsTailer(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

async function loadSynthetic(name: string): Promise<string[]> {
  const text = await readFile(join(SYNTHETIC_ROOT, name), 'utf8');
  // Deliberately NOT splitAsTailer: these files exercise unterminated and
  // blank lines, so every split element is fed to the parser as-is except the
  // artefact of a trailing newline.
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '' && text.endsWith('\n')) parts.pop();
  return parts;
}

// ---------------------------------------------------------------------------
// DoD 1 — typed events for all harvested fixtures
// ---------------------------------------------------------------------------

describe('parseLine against the captured CC 2.1.234 fixtures', () => {
  it('parses every line of every captured transcript with zero malformed', async () => {
    const files = await capturedTranscripts();
    expect(files).toHaveLength(7);
    let parsed = 0;
    let malformed = 0;
    for (const file of files) {
      const result = parseLines(splitAsTailer(await readFile(file, 'utf8')));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rejections).toEqual([]);
      parsed += result.diagnostics.parsedLines;
      malformed += result.diagnostics.malformedLines;
    }
    // Measured over the committed capture.
    expect(parsed).toBe(124);
    expect(malformed).toBe(0);
  });

  it('emits exactly the seven measured entry types, with measured counts', async () => {
    const counts = new Map<string, number>();
    for (const file of await capturedTranscripts()) {
      const result = parseLines(splitAsTailer(await readFile(file, 'utf8')));
      if (!result.ok) return;
      for (const entry of result.value.entries) {
        counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
      }
    }
    expect(Object.fromEntries(counts)).toEqual({
      assistant: 57,
      user: 33,
      attachment: 22,
      'queue-operation': 4,
      'ai-title': 4,
      'file-history-snapshot': 2,
      'last-prompt': 2,
    });
    for (const type of counts.keys()) expect(KNOWN_ENTRY_TYPES.has(type)).toBe(true);
  });

  it('preserves the join keys the stitcher needs', async () => {
    const text = await readFile(STUB_TRANSCRIPT, 'utf8');
    const result = parseLines(splitAsTailer(text));
    if (!result.ok) return;
    const withAgent = result.value.entries.filter((e) => typeof e['agentId'] === 'string');
    expect(withAgent.length).toBeGreaterThan(0);
    expect(withAgent[0]?.['agentId']).toBe('a3ecf86bbfb853726');
    const withUuid = result.value.entries.filter((e) => typeof e.uuid === 'string');
    expect(withUuid.length).toBeGreaterThan(0);
    // `parentUuid: null` on the first entry must survive as null, not vanish.
    const first = result.value.entries[0];
    expect(first?.parentUuid).toBeNull();
  });

  it('keeps the sparse queue-operation shape without inventing fields', async () => {
    const text = await readFile(join(SLUG_DIR, `${SESSION_A}.jsonl`), 'utf8');
    const result = parseLines(splitAsTailer(text));
    if (!result.ok) return;
    const queue = result.value.entries.find((e) => e.type === 'queue-operation');
    expect(queue).toBeDefined();
    expect(Object.keys(queue ?? {}).sort()).toEqual([
      'operation',
      'sessionId',
      'timestamp',
      'type',
    ]);
    expect(queue?.uuid).toBeUndefined();
    expect(queue?.message).toBeUndefined();
  });

  it('leaves the captured tree byte-identical after a full parse (G1)', async () => {
    const files = await capturedTranscripts();
    const before = await Promise.all(files.map((f) => readFile(f)));
    for (const file of files) parseLines(splitAsTailer(await readFile(file, 'utf8')));
    const after = await Promise.all(files.map((f) => readFile(f)));
    for (let i = 0; i < files.length; i++) {
      expect(after[i]?.equals(before[i] as Buffer)).toBe(true);
    }
  });
});

describe('unknown fields are ignored without error (DoD 1)', () => {
  it('parses a line carrying fields CC 2.1.234 never wrote, and keeps them', async () => {
    const lines = await loadSynthetic('unknown-fields-ok.jsonl');
    expect(lines).toHaveLength(2);
    const result = parseLines(lines);
    expect(result.diagnostics.parsedLines).toBe(2);
    expect(result.diagnostics.malformedLines).toBe(0);
    if (!result.ok) return;
    const first = result.value.entries[0];
    expect(first?.type).toBe('assistant');
    expect(first?.['anotherUnknownKey']).toBe(123);
    expect(first?.['futureField']).toEqual({ nested: ['cc', 'added', 'this'] });
    expect(first?.version).toBe('2.1.999');
    const second = result.value.entries[1];
    expect(second?.['brandNewField']).toBe('ignored without error');
  });

  it('does not require any optional field to be present', () => {
    const outcome = parseLine('{"type":"user"}');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.keys(outcome.entry)).toEqual(['type']);
  });
});

// ---------------------------------------------------------------------------
// DoD 2 — malformed lines counted and skipped, never crash
// ---------------------------------------------------------------------------

describe('malformed input is counted and skipped, never thrown (G3, DoD 2)', () => {
  it('invalid JSON: 2 lines in, 2 counted', async () => {
    const lines = await loadSynthetic('invalid-json.jsonl');
    expect(lines).toHaveLength(2);
    const result = parseLines(lines);
    expect(result.diagnostics.malformedLines).toBe(2);
    expect(result.diagnostics.parsedLines).toBe(0);
    if (!result.ok) return;
    expect(result.value.rejections.map((r) => r.rejection)).toEqual(['invalidJson', 'invalidJson']);
  });

  it('a line truncated mid-JSON with no trailing newline: 1 counted', async () => {
    const lines = await loadSynthetic('truncated-mid-json.jsonl');
    expect(lines).toHaveLength(1);
    const result = parseLines(lines);
    expect(result.diagnostics.malformedLines).toBe(1);
    if (!result.ok) return;
    expect(result.value.rejections[0]?.rejection).toBe('invalidJson');
  });

  it('valid JSON of the wrong shape: 5 lines in, 5 counted', async () => {
    const lines = await loadSynthetic('wrong-shape.jsonl');
    expect(lines).toHaveLength(5);
    const result = parseLines(lines);
    expect(result.diagnostics.malformedLines).toBe(5);
    if (!result.ok) return;
    expect(result.value.rejections.map((r) => r.rejection)).toEqual([
      'notAnObject',
      'notAnObject',
      'notAnObject',
      'notAnObject',
      'missingType',
    ]);
  });

  it('empty and whitespace-only lines: 3 counted', async () => {
    const lines = await loadSynthetic('blank-lines.jsonl');
    expect(lines).toHaveLength(3);
    const result = parseLines(lines);
    expect(result.diagnostics.malformedLines).toBe(3);
    if (!result.ok) return;
    expect(result.value.rejections.every((r) => r.rejection === 'empty')).toBe(true);
  });

  it('unexpected type: 2 counted', async () => {
    const lines = await loadSynthetic('unknown-type.jsonl');
    expect(lines).toHaveLength(2);
    const result = parseLines(lines);
    expect(result.diagnostics.malformedLines).toBe(2);
    if (!result.ok) return;
    expect(result.value.rejections.map((r) => r.rejection)).toEqual(['unknownType', 'missingType']);
    expect(result.value.rejections[0]?.reason).toBe('unknown type: sidechain-marker');
  });

  it('an unpaired surrogate: 1 counted', async () => {
    const lines = await loadSynthetic('lone-surrogate.jsonl');
    expect(lines).toHaveLength(1);
    const result = parseLines(lines);
    expect(result.diagnostics.malformedLines).toBe(1);
    if (!result.ok) return;
    expect(result.value.rejections[0]?.rejection).toBe('loneSurrogate');
  });

  it('the counter is exact: N bad lines in, N counted, mixed with good ones', async () => {
    const bad: string[] = [];
    for (const name of [
      'invalid-json.jsonl',
      'truncated-mid-json.jsonl',
      'wrong-shape.jsonl',
      'blank-lines.jsonl',
      'unknown-type.jsonl',
      'lone-surrogate.jsonl',
    ]) {
      bad.push(...(await loadSynthetic(name)));
    }
    expect(bad).toHaveLength(14);
    const good = await loadSynthetic('unknown-fields-ok.jsonl');
    expect(good).toHaveLength(2);

    // Interleave so a failure cannot resynchronise by position.
    const mixed: string[] = [];
    for (let i = 0; i < Math.max(bad.length, good.length); i++) {
      const b = bad[i];
      const g = good[i % good.length];
      if (b !== undefined) mixed.push(b);
      if (g !== undefined) mixed.push(g);
    }
    const result = parseLines(mixed);
    expect(result.diagnostics.malformedLines).toBe(14);
    expect(result.diagnostics.parsedLines).toBe(mixed.length - 14);
    expect(result.diagnostics.malformedLines + result.diagnostics.parsedLines).toBe(mixed.length);
    if (!result.ok) return;
    expect(result.value.rejections).toHaveLength(14);
  });

  it('never throws on hostile input', () => {
    const hostile = [
      '',
      '   ',
      '\t',
      'null',
      'true',
      '0',
      '"string"',
      '[]',
      '{}',
      '{"type":null}',
      '{"type":123}',
      '{"type":"user"',
      '{"type":"user","message":',
      ' ',
      '{"type":"user","x":"\\ud800"}',
      '{"type":"user","x":"\\udfff"}',
      `{"type":"user","x":${JSON.stringify('a'.repeat(2_000_000))}}`,
      `{"type":"user","deep":${'['.repeat(2000)}1${']'.repeat(2000)}}`,
      `{"type":"user","deepObj":${'{"n":'.repeat(500)}1${'}'.repeat(500)}}`,
    ];
    for (const line of hostile) {
      expect(() => parseLine(line)).not.toThrow();
    }
    const result = parseLines(hostile);
    expect(result.diagnostics.malformedLines + result.diagnostics.parsedLines).toBe(hostile.length);
  });

  it('truncates an enormous value rather than holding it', () => {
    const outcome = parseLine(`{"type":"user","x":${JSON.stringify('a'.repeat(2_000_000))}}`);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const x = outcome.entry['x'];
    expect(typeof x).toBe('string');
    expect(Buffer.byteLength(String(x), 'utf8')).toBeLessThan(9000);
    expect(TRUNCATION_MARKER_RE.test(String(x))).toBe(true);
    expect(outcome.report.truncatedStrings).toBe(1);
  });

  it('replaces an over-deep subtree instead of blowing the stack', () => {
    const line = `{"type":"user","deepObj":${'{"n":'.repeat(500)}1${'}'.repeat(500)}}`;
    const outcome = parseLine(line);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.depthLimited).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Sidecars
// ---------------------------------------------------------------------------

describe('parseSubagentMeta', () => {
  it('parses all 5 captured sidecars', async () => {
    const files = await capturedSidecars();
    expect(files).toHaveLength(5);
    for (const file of files) {
      const result = parseSubagentMeta(await readFile(file, 'utf8'), file);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(typeof result.value.agentType).toBe('string');
      expect(result.value.toolUseId).toMatch(/^toolu_/);
      expect(result.value.spawnDepth).toBeGreaterThanOrEqual(1);
      expect(result.diagnostics.skippedFiles).toEqual([]);
    }
  });

  it('reads the measured depth-2 sidecar including parentAgentId', async () => {
    const file = join(SLUG_DIR, SESSION_A, 'subagents', 'agent-a3ecf86bbfb853726.meta.json');
    const result = parseSubagentMeta(await readFile(file, 'utf8'), file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      agentType: 'general-purpose',
      description: 'nested-child',
      toolUseId: 'toolu_012xCBtQH1ejFcfwn9E1pkAw',
      parentAgentId: 'a1a53f42c5eca8824',
      spawnDepth: 2,
    });
  });

  it('refuses a corrupt sidecar with a described, counted failure — never a throw', () => {
    const cases: [string, string][] = [
      ['', 'empty'],
      ['   ', 'empty'],
      ['{"agentType":"x",', 'not valid JSON'],
      ['[1,2,3]', 'not a JSON object'],
      ['"a string"', 'not a JSON object'],
      ['{"description":"d","toolUseId":"t","spawnDepth":1}', 'agentType'],
      ['{"agentType":"a","toolUseId":"t","spawnDepth":1}', 'description'],
      ['{"agentType":"a","description":"d","spawnDepth":1}', 'toolUseId'],
      ['{"agentType":"a","description":"d","toolUseId":"t"}', 'spawnDepth'],
      ['{"agentType":"a","description":"d","toolUseId":"","spawnDepth":1}', 'toolUseId'],
      ['{"agentType":"a","description":"d","toolUseId":"t","spawnDepth":"1"}', 'spawnDepth'],
    ];
    for (const [text, needle] of cases) {
      expect(() => parseSubagentMeta(text, 'meta.json')).not.toThrow();
      const result = parseSubagentMeta(text, 'meta.json');
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.mismatch.kind).toBe('schemaMismatch');
      expect(result.mismatch.reason).toContain(needle);
      expect(result.mismatch.path).toBe('meta.json');
      expect(result.diagnostics.skippedFiles).toHaveLength(1);
    }
  });

  it('keeps unknown sidecar fields', () => {
    const result = parseSubagentMeta(
      '{"agentType":"a","description":"d","toolUseId":"t","spawnDepth":1,"futureField":true}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value['futureField']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DoD 5 — offloaded tool results, resolved by basename
// ---------------------------------------------------------------------------

describe('offloaded tool-results (DoD 5)', () => {
  async function stubEntry(): Promise<TranscriptEntry> {
    const result = parseLines(splitAsTailer(await readFile(STUB_TRANSCRIPT, 'utf8')));
    if (!result.ok) throw new Error('parse failed');
    const entry = result.value.entries.find((e) => collectPersistedOutputStubs(e).length > 0);
    if (entry === undefined) throw new Error('no stub entry found in the capture');
    return entry;
  }

  it('finds exactly one stub in the captured session, with its join key', async () => {
    let total = 0;
    for (const file of await capturedTranscripts()) {
      const result = parseLines(splitAsTailer(await readFile(file, 'utf8')));
      if (!result.ok) continue;
      for (const entry of result.value.entries) total += collectPersistedOutputStubs(entry).length;
    }
    expect(total).toBe(1);

    const stubs = collectPersistedOutputStubs(await stubEntry());
    expect(stubs).toHaveLength(1);
    expect(stubs[0]?.toolUseId).toBe('toolu_01MobmP15USPJ3NEQRXjrgd6');
    expect(stubs[0]?.pointer.basename).toBe('b6uvpgxa4.txt');
  });

  it('hydrates it from the ACTIVE root, redacted and truncated', async () => {
    const entry = await stubEntry();
    const hydrated = await hydratePersistedOutputs(entry, {
      projectsRoot: FIXTURE_ROOT,
      slug: SLUG,
      sessionId: SESSION_A,
    });
    expect(hydrated).toHaveLength(1);
    const read = hydrated[0]?.read;
    expect(read?.ok).toBe(true);
    expect(read?.originalBytes).toBe(63774);
    expect(read?.truncated).toBe(true);
    expect(read?.path).toBe(join(FIXTURE_ROOT, SLUG, SESSION_A, 'tool-results', 'b6uvpgxa4.txt'));

    const payload = String(read?.text).replace(TRUNCATION_MARKER_RE, '');
    expect(Buffer.byteLength(payload, 'utf8')).toBe(8192);
    // Content actually present in the offloaded file's first 8 KB.
    expect(payload).toContain('===== run.mjs =====');
    // Content present only beyond the cut must not have come through.
    const onDisk = await readFile(
      join(FIXTURE_ROOT, SLUG, SESSION_A, 'tool-results', 'b6uvpgxa4.txt'),
      'utf8',
    );
    expect(String(read?.text)).not.toContain(onDisk.slice(-500));
  });

  it('a missing offloaded file is a counted diagnostic and a degraded preview', async () => {
    const entry = await stubEntry();
    const diagnostics = emptyDiagnostics();
    const hydrated = await hydratePersistedOutputs(
      entry,
      { projectsRoot: FIXTURE_ROOT, slug: SLUG, sessionId: 'no-such-session' },
      diagnostics,
    );
    expect(hydrated[0]?.read.ok).toBe(false);
    expect(hydrated[0]?.read.degraded).toBe(true);
    expect(hydrated[0]?.read.text.startsWith('===== run.mjs =====')).toBe(true);
    expect(diagnostics.skippedFiles).toHaveLength(1);
    expect(diagnostics.skippedFiles[0]?.reason).toContain('b6uvpgxa4.txt');
  });

  it('returns nothing for entries with no offloaded payload', async () => {
    const outcome = parseLine('{"type":"user","message":{"role":"user","content":"plain string"}}');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(collectPersistedOutputStubs(outcome.entry)).toEqual([]);
    expect(await hydratePersistedOutputs(outcome.entry, {
      projectsRoot: FIXTURE_ROOT,
      slug: SLUG,
      sessionId: SESSION_A,
    })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DoD 3 / G4 — NO THINKING CONTENT REACHES THE SESSION MODEL
//
// PLAN.md requires this block in every phase's suite from Phase 1 on. It is
// self-contained on purpose: copy the describe block, not fragments of it.
// ---------------------------------------------------------------------------

/**
 * Every reasoning-bearing string present in the RAW bytes of a captured
 * transcript. In CC 2.1.234 all 15 thinking blocks carry an empty `thinking`
 * string and a long populated `signature`, so the signatures are the bytes
 * that actually have to disappear.
 */
function thinkingStringsInRawBytes(rawFile: string): string[] {
  const found: string[] = [];
  for (const line of rawFile.split('\n')) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (entry as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: unknown; thinking?: unknown; signature?: unknown };
      if (b.type !== 'thinking') continue;
      if (typeof b.thinking === 'string' && b.thinking.length > 0) found.push(b.thinking);
      if (typeof b.signature === 'string' && b.signature.length > 0) found.push(b.signature);
    }
  }
  return found;
}

/** Reusable assertion. Later phases: call this on whatever you hand downstream. */
function expectNoThinkingContent(serialised: string, forbidden: readonly string[]): void {
  expect(serialised).not.toContain('"thinking"');
  expect(serialised).not.toContain('"signature"');
  for (const secret of forbidden) {
    expect(serialised).not.toContain(secret);
    // A prefix check catches a partial leak through truncation.
    expect(serialised).not.toContain(secret.slice(0, 64));
  }
}

describe('G4: no thinking content reaches the session model', () => {
  it('the raw capture really does contain thinking blocks (otherwise this suite proves nothing)', async () => {
    let blocks = 0;
    let secrets = 0;
    for (const file of await capturedTranscripts()) {
      const raw = await readFile(file, 'utf8');
      blocks += (raw.match(/"type":"thinking"/g) ?? []).length;
      secrets += thinkingStringsInRawBytes(raw).length;
    }
    // Measured: 15 thinking blocks, each with a non-empty signature.
    expect(blocks).toBe(15);
    expect(secrets).toBe(15);
  });

  it('drops every thinking block from every captured transcript', async () => {
    let dropped = 0;
    for (const file of await capturedTranscripts()) {
      const raw = await readFile(file, 'utf8');
      const result = parseLines(splitAsTailer(raw));
      if (!result.ok) continue;
      dropped += result.value.report.thinkingBlocksDropped;
    }
    expect(dropped).toBe(15);
  });

  it('no thinking text or signature from the raw bytes survives into any parsed entry', async () => {
    for (const file of await capturedTranscripts()) {
      const raw = await readFile(file, 'utf8');
      const forbidden = thinkingStringsInRawBytes(raw);
      const result = parseLines(splitAsTailer(raw));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expectNoThinkingContent(JSON.stringify(result.value.entries), forbidden);
    }
  });

  it('no thinking content survives a per-line parse either', async () => {
    for (const file of await capturedTranscripts()) {
      const raw = await readFile(file, 'utf8');
      const forbidden = thinkingStringsInRawBytes(raw);
      for (const line of splitAsTailer(raw)) {
        const outcome = parseLine(line);
        if (!outcome.ok) continue;
        expectNoThinkingContent(JSON.stringify(outcome.entry), forbidden);
      }
    }
  });

  it('the synthetic thinking fixture loses both marker strings but keeps the answer', async () => {
    const lines = await loadSynthetic('thinking-block.jsonl');
    expect(lines).toHaveLength(1);
    const result = parseLines(lines);
    expect(result.diagnostics.parsedLines).toBe(1);
    if (!result.ok) return;
    expect(result.value.report.thinkingBlocksDropped).toBe(1);
    const json = JSON.stringify(result.value.entries);
    expectNoThinkingContent(json, [
      'SYNTHETIC-THINKING-TEXT-MUST-NOT-SURVIVE',
      'SYNTHETIC-SIGNATURE-MUST-NOT-SURVIVE',
    ]);
    expect(json).toContain('visible answer');
  });

  it('cannot be switched off: there is no option that lets a thinking block through', () => {
    const line =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"LEAK","signature":"LEAK-SIG"}]}}';
    for (const options of [
      {},
      { maxPayloadBytes: 1 },
      { maxPayloadBytes: 1024 * 1024 * 64 },
      { allowUnknownTypes: true },
    ]) {
      const outcome = parseLine(line, options);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expectNoThinkingContent(JSON.stringify(outcome.entry), ['LEAK', 'LEAK-SIG']);
    }
  });

  it('drops a thinking block even when nested outside message.content', () => {
    const outcome = parseLine(
      '{"type":"attachment","attachment":{"blocks":[{"type":"thinking","thinking":"LEAK","signature":"LEAK-SIG"}]}}',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expectNoThinkingContent(JSON.stringify(outcome.entry), ['LEAK', 'LEAK-SIG']);
  });
});
