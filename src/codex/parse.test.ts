/**
 * `src/codex/parse.test.ts` - the guard on PLAN.md v0.6.0 DoD 2.3 and 2.3a.
 *
 * ---------------------------------------------------------------------------
 * THE G4 TEST IN THIS FILE MUST NOT BE VACUOUS, AND THAT SHAPED EVERYTHING
 * ---------------------------------------------------------------------------
 *
 * This repository has shipped a vacuous redaction test. On Claude Code the
 * `thinking` string is EMPTY on disk and the `signature` carries the bytes, so
 * "no thinking text leaks" passed for three phases while proving nothing.
 *
 * Codex is the mirror image and has the same trap: measured below from the
 * committed corpus, every `response_item/reasoning` record has an empty
 * `summary` and every `event_msg` `Reasoning` item has an empty `summary_text`
 * and `raw_content`. The bytes live in `encrypted_content`.
 *
 * So the G4 assertions here are made against LITERAL BYTE SEQUENCES READ OUT
 * OF THE FIXTURES AT TEST TIME, not against a field name and not against a
 * pattern - and every one of them is paired with a VACUITY CONTROL that
 * asserts the same bytes ARE present on the input side. A zero with no
 * non-zero beside it is the shape that passes while measuring nothing.
 *
 * `scripts/codex-golden.mjs` has an `assertNoLeakage` that does a version of
 * this. It is deliberately NOT imported: coupling this test to the reference
 * reader would make the two agree by construction, which is the whole reason
 * the golden is standalone in the first place.
 *
 * ---------------------------------------------------------------------------
 * EVERY NUMBER BELOW IS DERIVED FROM THE CORPUS AT RUN TIME
 * ---------------------------------------------------------------------------
 *
 * No fixture-set size is written down. The corpus directory is walked, the
 * expectations are computed by a second reader written for this file, and the
 * parser's output is compared to that. A later harvest that adds a run, a
 * record type or a dialect therefore surfaces as a FAILURE with a name rather
 * than as a silently smaller number.
 */

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_MAX_PAYLOAD_BYTES, TRUNCATION_MARKER_RE } from '../parser/redact.js';

import {
  CODEX_CIPHERTEXT_PREFIX,
  CODEX_RECORD_TYPES,
  CODEX_RESPONSE_ITEM_DISPOSITION,
  asCodexRecord,
  ciphertextMarker,
  forkStartOrdinal,
  isReasoningRecord,
  parseCodexLines,
  parseCodexThread,
  parseCodexTranscript,
  readCiphertextMarker,
  redactCodexRecords,
} from './parse.js';

import type { CodexRecord } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'fixtures');
const CORPUS_PREFIX = 'codex-';

// ---------------------------------------------------------------------------
// A second reader, written for this file. It shares nothing with parse.ts.
// ---------------------------------------------------------------------------

interface Transcript {
  readonly corpus: string;
  readonly run: string;
  readonly file: string;
  readonly abs: string;
  readonly text: string;
  /** Every non-blank line, `JSON.parse`d directly. Not through `parse.ts`. */
  readonly raw: readonly Record<string, unknown>[];
}

interface Run {
  readonly corpus: string;
  readonly run: string;
  readonly transcripts: readonly Transcript[];
  readonly hooks: readonly Record<string, unknown>[];
}

function listCorpora(): string[] {
  if (!fs.existsSync(FIXTURES)) return [];
  return fs
    .readdirSync(FIXTURES)
    .filter((name) => name.startsWith(CORPUS_PREFIX))
    .filter((name) => fs.statSync(path.join(FIXTURES, name)).isDirectory())
    .sort();
}

function listJsonl(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.jsonl')) found.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found.sort();
}

function readJsonl(file: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const value: unknown = JSON.parse(line);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.push(value as Record<string, unknown>);
    }
  }
  return out;
}

function loadRuns(): Run[] {
  const runs: Run[] = [];
  for (const corpus of listCorpora()) {
    const corpusDir = path.join(FIXTURES, corpus);
    for (const run of fs.readdirSync(corpusDir).sort()) {
      const runDir = path.join(corpusDir, run);
      if (!fs.statSync(runDir).isDirectory()) continue;
      const hookFile = path.join(runDir, 'hook-stream.jsonl');
      if (!fs.existsSync(hookFile)) continue;
      const transcripts = listJsonl(path.join(runDir, 'home')).map((abs) => ({
        corpus,
        run,
        file: path.basename(abs),
        abs,
        text: fs.readFileSync(abs, 'utf8'),
        raw: readJsonl(abs),
      }));
      runs.push({ corpus, run, transcripts, hooks: readJsonl(hookFile) });
    }
  }
  return runs;
}

/** `subagent_history_start_ordinal`, derived without touching `parse.ts`. */
function boundaryOf(transcript: Transcript): number | undefined {
  const metas = transcript.raw
    .filter((record) => record['type'] === 'session_meta')
    .sort((a, b) => Number(a['ordinal']) - Number(b['ordinal']));
  const owner = metas[0];
  if (owner === undefined) return undefined;
  const payload = owner['payload'];
  if (payload === null || typeof payload !== 'object') return undefined;
  const bag = payload as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(bag, 'subagent_history_start_ordinal')) return undefined;
  const value = bag['subagent_history_start_ordinal'];
  return typeof value === 'number' ? value : undefined;
}

function ownRecords(transcript: Transcript): Record<string, unknown>[] {
  const start = boundaryOf(transcript);
  if (start === undefined) return [...transcript.raw];
  return transcript.raw.filter((record) => Number(record['ordinal']) >= start);
}

/**
 * Every ciphertext string in a value, INCLUDING the ones hiding inside a
 * JSON-encoded `arguments` string.
 *
 * A structural walk alone under-reports: `arguments` is a string to any walker
 * that does not parse it, and that is exactly where the v2 spawn instruction
 * lives. This is stated in `scripts/codex-golden.mjs` too; it is re-derived
 * here rather than imported.
 */
function ciphertextStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.startsWith(CODEX_CIPHERTEXT_PREFIX)) out.push(value);
    else if (value.includes(CODEX_CIPHERTEXT_PREFIX)) {
      let nested: unknown = null;
      try {
        nested = JSON.parse(value);
      } catch {
        nested = null;
      }
      if (nested !== null && typeof nested === 'object') ciphertextStrings(nested, out);
      else out.push(value);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) ciphertextStrings(entry, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) ciphertextStrings(entry, out);
  }
  return out;
}

/** The committed golden, read as DATA. The generator is never imported. */
function readGolden(): unknown {
  for (const corpus of listCorpora()) {
    const file = path.join(FIXTURES, corpus, 'golden.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  }
  return null;
}

/** C7's two reasoning shapes, derived here rather than imported from parse.ts. */
function isReasoningRaw(raw: Record<string, unknown>): boolean {
  const payload = raw['payload'];
  if (payload === null || typeof payload !== 'object') return false;
  const bag = payload as Record<string, unknown>;
  if (raw['type'] === 'response_item' && bag['type'] === 'reasoning') return true;
  const item = bag['item'];
  return (
    raw['type'] === 'event_msg'
    && item !== null
    && typeof item === 'object'
    && (item as Record<string, unknown>)['type'] === 'Reasoning'
  );
}

/** Largest UTF-8 string length anywhere in a JSON value. */
function maxStringBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Array.isArray(value)) return value.reduce<number>((best, v) => Math.max(best, maxStringBytes(v)), 0);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (best, v) => Math.max(best, maxStringBytes(v)),
      0,
    );
  }
  return 0;
}

/** A minimal, valid rollout record. Used to build adversarial transcripts. */
function record(ordinal: number, type: string, payload: unknown): CodexRecord {
  return { timestamp: `2026-09-03T00:00:${String(ordinal % 60).padStart(2, '0')}.000Z`, ordinal, type, payload };
}

function sessionMeta(ordinal: number, payload: Record<string, unknown>): CodexRecord {
  return record(ordinal, 'session_meta', {
    session_id: 's-1',
    id: 't-1',
    cwd: 'C:\\work',
    cli_version: '0.151.0-alpha.7.2',
    thread_source: 'user',
    originator: 'codex_exec',
    ...payload,
  });
}

let RUNS: Run[] = [];
let ALL: Transcript[] = [];

beforeAll(() => {
  RUNS = loadRuns();
  ALL = RUNS.flatMap((run) => run.transcripts);
}, 60_000);

// ===========================================================================

describe('the corpus this file measures against', () => {
  it('exists, and every transcript is a C2-shaped stream', () => {
    expect(RUNS.length).toBeGreaterThan(0);
    expect(ALL.length).toBeGreaterThan(0);
    for (const transcript of ALL) {
      expect(transcript.raw.length).toBeGreaterThan(0);
      for (const raw of transcript.raw) {
        expect(Object.keys(raw).sort()).toEqual(['ordinal', 'payload', 'timestamp', 'type']);
      }
    }
  });

  it('the reasoning trap is real here: the visible fields are empty', () => {
    // The vacuity control for the whole G4 section. If this ever fails,
    // reasoning summaries have started carrying text and a test asserting on
    // `summary` alone would begin to mean something - but until then, a G4
    // test that only looked at the visible field would pass while the bytes
    // walked straight through.
    let responseItems = 0;
    let visibleBytes = 0;
    for (const transcript of ALL) {
      for (const raw of transcript.raw) {
        const payload = raw['payload'] as Record<string, unknown> | null;
        if (payload === null || typeof payload !== 'object') continue;
        if (raw['type'] === 'response_item' && payload['type'] === 'reasoning') {
          responseItems++;
          visibleBytes += JSON.stringify(payload['summary'] ?? []).length - 2;
        }
        if (raw['type'] === 'event_msg') {
          const item = payload['item'] as Record<string, unknown> | null;
          if (item !== null && typeof item === 'object' && item['type'] === 'Reasoning') {
            visibleBytes += JSON.stringify(item['summary_text'] ?? []).length - 2;
            visibleBytes += JSON.stringify(item['raw_content'] ?? []).length - 2;
          }
        }
      }
    }
    expect(responseItems).toBeGreaterThan(0);
    expect(visibleBytes).toBe(0);
  });
});

describe('C2 - the line boundary never throws (G3)', () => {
  it('parses every committed transcript with zero malformed lines', () => {
    for (const transcript of ALL) {
      const parsed = parseCodexLines(transcript.text);
      expect(parsed.malformedLines).toBe(0);
      expect(parsed.records.length).toBe(transcript.raw.length);
    }
  });

  it('a fuzz corpus of >= 1000 malformed rollout lines throws zero times', () => {
    const lines: string[] = [];
    const shapes = [
      '{',
      '}',
      '[]',
      'null',
      '3',
      '"a string"',
      'undefined',
      '{"type":}',
      '{"type":"event_msg"',
      '{"ordinal":0,"type":"event_msg","payload":{}}', // no timestamp
      '{"timestamp":"t","type":"event_msg","payload":{}}', // no ordinal
      '{"timestamp":"t","ordinal":0,"payload":{}}', // no type
      '{"timestamp":"t","ordinal":0,"type":"event_msg"}', // no payload
      '{"timestamp":"t","ordinal":"zero","type":"event_msg","payload":{}}',
      '{"timestamp":1,"ordinal":0,"type":"event_msg","payload":{}}',
      '{"timestamp":"t","ordinal":null,"type":null,"payload":null}',
      '[{"timestamp":"t","ordinal":0,"type":"event_msg","payload":{}}]',
      '{"timestamp":"t","ordinal":0,"type":"event_msg","payload":{}} trailing',
      '\u0000\u0001\u0002',
      '{"a":"\\ud800"}',
      '{"nested":{"deep":',
      '\\',
      '{"timestamp":"t","ordinal":NaN,"type":"event_msg","payload":{}}',
    ];
    for (let i = 0; lines.length < 1_200; i++) {
      const shape = shapes[i % shapes.length] ?? '{';
      lines.push(`${shape}${i % 7 === 0 ? ` /* ${i} */` : ''}`);
    }
    // A deliberately pathological but syntactically valid line: 500 levels of
    // nesting, well past `MAX_REDACTION_DEPTH`.
    lines.push(
      JSON.stringify({
        timestamp: 't',
        ordinal: 0,
        type: 'world_state',
        payload: nest(500),
      }),
    );

    expect(lines.length).toBeGreaterThanOrEqual(1_000);

    // Zero throws: a throw here fails the test by propagating. The explicit
    // `not.toThrow` below covers the whole-thread path as well.
    const parsed = parseCodexLines(lines);
    // Every generated shape but the last is malformed; the deep one is a
    // well-formed record, which is what makes the count a real assertion
    // rather than "everything failed".
    expect(parsed.malformedLines).toBe(lines.length - 1);
    expect(parsed.records.length).toBe(1);

    expect(() => parseCodexTranscript(lines, { file: 'fuzz.jsonl' })).not.toThrow();
    const thread = parseCodexTranscript(lines, { file: 'fuzz.jsonl' });
    expect(thread.thread).toBeNull();
    expect(thread.counters.malformedLines).toBe(lines.length - 1);
  });

  it('an over-nested payload is depth-limited rather than a stack overflow', () => {
    const records = [sessionMeta(0, {}), record(1, 'world_state', nest(400))];
    expect(() => parseCodexThread(records, { file: 'deep.jsonl' })).not.toThrow();
    const out = parseCodexThread(records, { file: 'deep.jsonl' });
    expect(JSON.stringify(out.kept)).toContain('nesting depth limit reached');
  });

  it('asCodexRecord rejects every non-C2 shape without throwing', () => {
    for (const value of [null, 1, 'x', [], {}, { type: 'x' }, { type: 1, ordinal: 0, timestamp: 't', payload: 1 }]) {
      expect(asCodexRecord(value)).toBeNull();
    }
    expect(asCodexRecord({ timestamp: 't', ordinal: 0, type: 'world_state', payload: null })).not.toBeNull();
  });
});

describe("C2's unknown-type tripwire (DoD 2.3)", () => {
  it('one novel type increments the counter, produces no node, and refuses nothing', () => {
    const callPayload = {
      type: 'function_call',
      name: 'exec_command',
      call_id: 'call_novel',
      arguments: '{"cmd":"ls"}',
    };
    const records = [
      sessionMeta(0, {}),
      record(1, 'turn_context', { multi_agent_version: 'v2' }),
      // Same payload as a real tool call, under a type nothing knows. If the
      // parser fell through to reading payloads by shape rather than by
      // record type, this would produce a node.
      record(2, 'quantum_flux_capacitor', callPayload),
      record(3, 'response_item', callPayload),
    ];
    const result = parseCodexThread(records, { file: 'novel.jsonl' });

    expect(result.counters.unknownRecordTypes).toBe(1);
    expect(result.thread).not.toBeNull();
    expect(result.thread?.toolCalls.length).toBe(1);
    expect(result.thread?.toolCalls[0]?.ordinal).toBe(3);
    expect(result.kept.some((r) => r.type === 'quantum_flux_capacitor')).toBe(false);
    // Not refused: `parseCodexThread` has no refusal channel at all, by
    // design. Refusal is `fingerprint.ts`'s and rests on C3 alone.
    expect(result.thread?.cliVersion).toBe('0.151.0-alpha.7.2');
  });

  it('the committed corpus contains no unknown record type', () => {
    for (const transcript of ALL) {
      const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
      expect(parsed.counters.unknownRecordTypes).toBe(0);
      for (const raw of transcript.raw) expect(CODEX_RECORD_TYPES.has(String(raw['type']))).toBe(true);
    }
  });
});

describe('every response_item type in the corpus is handled or counted-skipped', () => {
  it('the corpus type set is declared in CODEX_RESPONSE_ITEM_DISPOSITION', () => {
    const seen = new Set<string>();
    for (const transcript of ALL) {
      for (const raw of transcript.raw) {
        if (raw['type'] !== 'response_item') continue;
        const payload = raw['payload'] as Record<string, unknown> | null;
        seen.add(payload === null || typeof payload !== 'object' ? '(absent)' : String(payload['type']));
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const type of [...seen].sort()) {
      expect(CODEX_RESPONSE_ITEM_DISPOSITION[type]).toBeDefined();
    }
  });

  it('reports nothing unhandled on the corpus, and reports a novel type as unhandled', () => {
    for (const transcript of ALL) {
      const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
      expect(parsed.unhandledResponseItemTypes).toEqual([]);
    }
    // The vacuity control: the empty list above has to be capable of being
    // non-empty.
    const parsed = parseCodexThread(
      [sessionMeta(0, {}), record(1, 'response_item', { type: 'brand_new_thing' })],
      { file: 'novel.jsonl' },
    );
    expect(parsed.unhandledResponseItemTypes).toEqual(['brand_new_thing']);
    expect(parsed.thread?.toolCalls).toEqual([]);
  });
});

describe('G4 / C7 - reasoning and ciphertext never cross the parse boundary', () => {
  it('drops every reasoning record, on both taps, and counts each one', () => {
    let corpusReasoning = 0;
    for (const transcript of ALL) {
      const expected = ownRecords(transcript).filter((raw) => isReasoningRaw(raw)).length;
      const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
      expect(parsed.counters.reasoningDropped).toBe(expected);
      for (const kept of parsed.kept) expect(isReasoningRecord(kept)).toBe(false);
      corpusReasoning += expected;
    }
    // Control: the corpus really does contain reasoning to drop.
    expect(corpusReasoning).toBeGreaterThan(0);
  });

  it('NO LITERAL CAPTURED CIPHERTEXT SURVIVES, and the control proves it was there', () => {
    let corpusCiphertext = 0;
    for (const transcript of ALL) {
      // Every ciphertext string in the FILE, inherited records included.
      const literals = ciphertextStrings(transcript.raw);
      // The subset the SCRUB actually sees. Two regions are dropped whole
      // before any string is looked at - the inherited fork region and the
      // reasoning records - so their ciphertext is never reached rather than
      // never scrubbed, and the counter must not claim otherwise.
      const scrubbed = ciphertextStrings(
        ownRecords(transcript).filter((raw) => !isReasoningRaw(raw)),
      );

      // ---- vacuity control, on the INPUT side -----------------------------
      // Same assertion, opposite verdict. Without this the zero below is
      // indistinguishable from a reader that found nothing.
      for (const literal of literals) {
        expect(literal.length).toBeGreaterThan(64);
        expect(transcript.text).toContain(literal.slice(0, 128));
      }
      corpusCiphertext += literals.length;

      const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
      const survived = JSON.stringify({ thread: parsed.thread, kept: parsed.kept });

      // ---- the assertion --------------------------------------------------
      for (const literal of literals) {
        expect(survived).not.toContain(literal.slice(0, 64));
      }
      expect(survived).not.toContain(CODEX_CIPHERTEXT_PREFIX);
      expect(parsed.ciphertextStringsDropped).toBe(scrubbed.length);
    }
    expect(corpusCiphertext).toBeGreaterThan(0);
  });

  it('ciphertext is dropped from every shape it arrives in, including inside `arguments`', () => {
    // The bytes are REAL: taken from the committed corpus, not invented. A
    // synthesised ciphertext would only prove the test agrees with itself.
    const literals = ALL.flatMap((transcript) => ciphertextStrings(transcript.raw));
    const secret = literals[0];
    expect(secret).toBeDefined();
    const cipher = secret as string;
    const bytes = Buffer.byteLength(cipher, 'utf8');

    const records: CodexRecord[] = [
      sessionMeta(0, {}),
      record(1, 'turn_context', { multi_agent_version: 'v2' }),
      // (a) a reasoning record - dropped whole
      record(2, 'response_item', { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: cipher }),
      // (b) an agent_message - NOT reasoning, and it carries ciphertext
      record(3, 'response_item', {
        type: 'agent_message',
        content: [{ type: 'output_text', encrypted_content: cipher }],
      }),
      // (c) a spawn - the ciphertext is inside a JSON STRING
      record(4, 'response_item', {
        type: 'function_call',
        name: 'spawn_agent',
        namespace: 'collaboration',
        call_id: 'call_secret',
        arguments: JSON.stringify({ task_name: 'alpha', fork_turns: 'all', message: cipher }),
      }),
      // (d) a tool output that is itself ciphertext
      record(5, 'response_item', {
        type: 'function_call_output',
        call_id: 'call_secret',
        output: cipher,
      }),
    ];

    // Control: the INPUT contains the bytes, four times over.
    expect(JSON.stringify(records)).toContain(cipher.slice(0, 64));
    expect(ciphertextStrings(records).length).toBe(4);

    const parsed = parseCodexThread(records, { file: 'secret.jsonl' });
    const survived = JSON.stringify({ thread: parsed.thread, kept: parsed.kept });
    expect(survived).not.toContain(cipher.slice(0, 32));
    expect(survived).not.toContain(CODEX_CIPHERTEXT_PREFIX);
    expect(parsed.counters.reasoningDropped).toBe(1);
    expect(parsed.ciphertextStringsDropped).toBe(3);

    // DoD 2.3a: the message reaches no label, no node and no field - but its
    // SIZE does.
    const spawn = parsed.thread?.spawns[0];
    expect(spawn).toBeDefined();
    expect(spawn?.messagePresent).toBe(true);
    expect(spawn?.messageEncrypted).toBe(true);
    expect(spawn?.messageBytes).toBe(bytes);
    expect(spawn?.requestedTaskName).toBe('alpha');
    // The plaintext task name survives beside the opaque instruction. That is
    // C7's measured asymmetry and it is the reason `arguments` is descended
    // into rather than dropped whole.
    expect(parsed.thread?.toolCalls[0]?.outputPreview).toBe(ciphertextMarker(bytes));
    expect(readCiphertextMarker(ciphertextMarker(bytes))).toBe(bytes);
    expect(readCiphertextMarker('not a marker')).toBeNull();
  });
});

describe('C5 - the fork boundary, and the `=== null` trap', () => {
  it('absence is the signal: an ABSENT key drops nothing, and neither does null', () => {
    expect(forkStartOrdinal({})).toBeUndefined();
    expect(forkStartOrdinal({ subagent_history_start_ordinal: null })).toBeUndefined();
    expect(forkStartOrdinal({ subagent_history_start_ordinal: '9' })).toBeUndefined();
    expect(forkStartOrdinal({ subagent_history_start_ordinal: 9 })).toBe(9);
    expect(forkStartOrdinal(null)).toBeUndefined();

    // `undefined`, not `null`, is what the key's absence reads as. An engine
    // testing `=== null` takes the wrong branch and throws nothing.
    const absent = redactCodexRecords([record(0, 'world_state', {}), record(1, 'world_state', {})], {
      forkStartOrdinal: forkStartOrdinal({}),
    });
    expect(absent.counters.inheritedRecordsDropped).toBe(0);
    expect(absent.kept.length).toBe(2);
  });

  it("the corpus's forked children drop exactly their inherited region", () => {
    let forkedFiles = 0;
    let unforkedFiles = 0;
    for (const transcript of ALL) {
      const start = boundaryOf(transcript);
      const expected = start === undefined
        ? 0
        : transcript.raw.filter((raw) => Number(raw['ordinal']) < start).length;
      const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
      expect(parsed.counters.inheritedRecordsDropped).toBe(expected);
      expect(parsed.thread?.inheritedRecordsBeforeForkStart).toBe(expected);
      for (const kept of parsed.kept) {
        if (start !== undefined) expect(kept.ordinal).toBeGreaterThanOrEqual(start);
      }
      for (const call of parsed.thread?.toolCalls ?? []) {
        if (start !== undefined) expect(call.ordinal).toBeGreaterThanOrEqual(start);
      }
      if (start === undefined) {
        unforkedFiles++;
        expect(parsed.thread?.subagentHistoryStartOrdinal.present).toBe(false);
      } else {
        forkedFiles++;
        expect(expected).toBeGreaterThan(0);
        expect(parsed.thread?.subagentHistoryStartOrdinal).toEqual({ present: true, value: start });
      }
    }
    // Both arms exercised, or the loop above proves only one of them.
    expect(forkedFiles).toBeGreaterThan(0);
    expect(unforkedFiles).toBeGreaterThan(0);
  });

  it('`resume-twice-v1`\'s subagent carries NO boundary key and loses nothing', () => {
    const run = RUNS.find((r) => r.run === 'resume-twice-v1');
    expect(run).toBeDefined();
    const subagent = (run as Run).transcripts.find((t) => {
      const meta = t.raw.find((raw) => raw['type'] === 'session_meta');
      const payload = meta?.['payload'] as Record<string, unknown> | undefined;
      return payload?.['thread_source'] === 'subagent';
    });
    expect(subagent).toBeDefined();
    const transcript = subagent as Transcript;

    const meta = transcript.raw[0]?.['payload'] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(meta, 'subagent_history_start_ordinal')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(meta, 'forked_from_id')).toBe(false);

    const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
    expect(parsed.counters.inheritedRecordsDropped).toBe(0);
    expect(parsed.kept.length + parsed.counters.reasoningDropped).toBe(transcript.raw.length);
    expect(parsed.thread?.subagentHistoryStartOrdinal).toEqual({ present: false, value: null });
    expect(parsed.thread?.forkedFromId).toEqual({ present: false, value: null });
    // Present-and-null is a different fact from absent, and both occur on this
    // thread: `agent_path` is ABSENT at the top level while the nickname is
    // present with a value.
    expect(parsed.thread?.agentPath).toEqual({ present: false, value: null });
    expect(parsed.thread?.agentNickname.present).toBe(true);
    expect(typeof parsed.thread?.agentNickname.value).toBe('string');
  });

  it('a tool call BELOW the boundary produces no node', () => {
    // The committed corpus's inherited regions happen to contain no tool
    // calls, so the real corpus cannot make this assertion bite. Synthesising
    // one is the only way to prove the drop covers nodes and not just record
    // counts.
    const records: CodexRecord[] = [
      sessionMeta(0, { thread_source: 'subagent', subagent_history_start_ordinal: 3, agent_path: '/root/a' }),
      record(1, 'response_item', {
        type: 'function_call',
        name: 'spawn_agent',
        namespace: 'collaboration',
        call_id: 'call_inherited',
        arguments: '{"task_name":"ghost"}',
      }),
      record(2, 'event_msg', {
        type: 'item_completed',
        item: { type: 'SubAgentActivity', id: 'call_inherited', agent_path: '/root/ghost' },
      }),
      record(3, 'turn_context', { multi_agent_version: 'v2' }),
      record(4, 'response_item', {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call_own',
        arguments: '{"cmd":"ls"}',
      }),
    ];
    const parsed = parseCodexThread(records, { file: 'forked.jsonl' });
    expect(parsed.counters.inheritedRecordsDropped).toBe(3);
    expect(parsed.thread?.toolCalls.map((c) => c.callId)).toEqual(['call_own']);
    expect(parsed.thread?.spawns).toEqual([]);
    expect(JSON.stringify(parsed.kept)).not.toContain('call_inherited');
  });
});

describe('the third tool-call kind, and the skip list that names what it drops', () => {
  it('EMITS `tool_search_call`, and matches the golden on the total and on `no_item`', () => {
    // Derived from `golden.json` at test time, never written down here. The
    // golden is produced by a standalone reader that shares no code with
    // `parse.ts`, which is what makes this a cross-check rather than a
    // restatement.
    const golden = readGolden();
    expect(golden).not.toBeNull();
    const summary = (golden as Record<string, unknown>)['summary'] as Record<string, number>;

    const relations = new Map<string, number>();
    const kinds = new Map<string, number>();
    for (const transcript of ALL) {
      const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
      for (const call of parsed.thread?.toolCalls ?? []) {
        relations.set(call.idRelation, (relations.get(call.idRelation) ?? 0) + 1);
        kinds.set(call.kind, (kinds.get(call.kind) ?? 0) + 1);
      }
    }

    // The arithmetic that found the defect in the hand-off line: the golden's
    // total is `function_call` + `custom_tool_call` + ONE `tool_search_call`,
    // and a parser that cannot express the third kind emits one fewer.
    expect(kinds.get('tool_search_call')).toBe(1);
    expect(
      (kinds.get('function_call') ?? 0)
      + (kinds.get('custom_tool_call') ?? 0)
      + (kinds.get('tool_search_call') ?? 0),
    ).toBe(summary['tool_calls']);

    expect(relations.get('no_item') ?? 0).toBe(summary['tool_calls_without_item']);
    expect(relations.get('item_id_equals_call_id') ?? 0).toBe(summary['tool_calls_item_id_equals_call_id']);
    expect(relations.get('item_id_distinct_from_call_id') ?? 0).toBe(summary['tool_calls_item_id_distinct']);
  });

  it('states only what n=1 shows about `tool_search_call`', () => {
    // One record, in `resume-twice-v1`. Everything asserted here is read off
    // that record first, so the expectations cannot outrun the evidence.
    let raw: Record<string, unknown> | null = null;
    let owner: Transcript | null = null;
    for (const transcript of ALL) {
      for (const entry of transcript.raw) {
        const payload = entry['payload'] as Record<string, unknown> | null;
        if (entry['type'] !== 'response_item' || payload === null || typeof payload !== 'object') continue;
        if (payload['type'] !== 'tool_search_call') continue;
        raw = payload;
        owner = transcript;
      }
    }
    expect(raw).not.toBeNull();
    expect(owner).not.toBeNull();
    const payload = raw as Record<string, unknown>;

    // The two fields it does NOT carry, and the one whose shape differs.
    expect(Object.prototype.hasOwnProperty.call(payload, 'name')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, 'namespace')).toBe(false);
    expect(typeof payload['arguments']).toBe('object');

    const source = owner as Transcript;
    const parsed = parseCodexTranscript(source.text, { file: source.file });
    const call = (parsed.thread?.toolCalls ?? []).find((c) => c.kind === 'tool_search_call');
    expect(call).toBeDefined();
    expect(call?.callId).toBe(payload['call_id']);
    // An absent `namespace` IS representable and IS represented. An absent
    // `name` is not - the type is a bare string - so it is the empty string,
    // which is exactly what the reference reader writes into the golden
    // rather than a default chosen here.
    expect(call?.namespace).toEqual({ present: false, value: null });
    expect(call?.name).toBe('');
    expect(call?.idRelation).toBe('no_item');
    expect(call?.itemId).toBeNull();
    // `tool_search_output` is skipped, so no preview is built from it.
    expect(call?.outputPreview).toBeUndefined();
  });

  it('NAMES every skipped response_item type on the shared counters', () => {
    // Rule 18: a reader that skips an input reports the skip in its verdict.
    // The value is asserted per run, and BOTH a non-empty and an empty case
    // are required - an all-empty result would be indistinguishable from a
    // counter that is never written at all.
    const perRun = new Map<string, Set<string>>();
    for (const run of RUNS) {
      const seen = new Set<string>();
      for (const transcript of run.transcripts) {
        const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
        for (const type of parsed.counters.skippedResponseItemTypes) seen.add(type);
        // Sorted and de-duplicated, per the field's contract.
        expect([...parsed.counters.skippedResponseItemTypes]).toEqual(
          [...new Set(parsed.counters.skippedResponseItemTypes)].sort(),
        );
        expect(parsed.thread?.counters.skippedResponseItemTypes).toEqual(
          parsed.counters.skippedResponseItemTypes,
        );
      }
      perRun.set(run.run, seen);
    }
    const withSkips = [...perRun.entries()].filter(([, seen]) => seen.size > 0);
    const withoutSkips = [...perRun.entries()].filter(([, seen]) => seen.size === 0);
    expect(withSkips.length).toBeGreaterThan(0);
    expect(withoutSkips.length).toBeGreaterThan(0);
    for (const [, seen] of withSkips) expect([...seen].sort()).toEqual(['tool_search_output']);
  });

  it('an UNDECLARED type is named as skipped as well as unhandled', () => {
    // Declared-and-skipped and never-seen-before are different facts and both
    // reach the counter. If only the first did, a new Codex release would add
    // a type that produced nothing and said nothing.
    const parsed = parseCodexThread(
      [
        sessionMeta(0, {}),
        record(1, 'response_item', { type: 'brand_new_thing' }),
        record(2, 'response_item', { type: 'tool_search_output', tools: [] }),
      ],
      { file: 'novel.jsonl' },
    );
    expect(parsed.counters.skippedResponseItemTypes).toEqual(['brand_new_thing', 'tool_search_output']);
    expect(parsed.unhandledResponseItemTypes).toEqual(['brand_new_thing']);
    expect(parsed.thread?.toolCalls).toEqual([]);
  });
});

describe('startedAtMs - a START, and never the end used as one', () => {
  it("is the session_meta record's own timestamp, not the file mtime", () => {
    let widestGapMs = 0;
    for (const transcript of ALL) {
      const metas = transcript.raw
        .filter((entry) => entry['type'] === 'session_meta')
        .sort((a, b) => Number(a['ordinal']) - Number(b['ordinal']));
      const owner = metas[0];
      expect(owner).toBeDefined();
      const envelope = Date.parse(String((owner as Record<string, unknown>)['timestamp']));

      // `mtimeMs` is handed the LAST record's time - which is what a file's
      // last write actually is - so a parser reaching for it lands on a
      // plausible, wrong, LATER number rather than on something obviously
      // broken. That is the shape of the defect this field replaced.
      const last = transcript.raw[transcript.raw.length - 1];
      const endMs = Date.parse(String((last as Record<string, unknown>)['timestamp']));
      const parsed = parseCodexTranscript(transcript.text, {
        file: transcript.file,
        mtimeMs: endMs,
      });

      expect(parsed.thread?.startedAtMs).toBe(envelope);
      expect(parsed.thread?.mtimeMs).toBe(endMs);
      expect(parsed.thread?.startedAtMs).toBeLessThan(endMs);
      widestGapMs = Math.max(widestGapMs, endMs - envelope);

      // The ENVELOPE timestamp, not `payload.timestamp`. They differ.
      const payload = (owner as Record<string, unknown>)['payload'] as Record<string, unknown>;
      if (typeof payload['timestamp'] === 'string') {
        expect(Date.parse(payload['timestamp'])).not.toBe(envelope);
      }
    }
    // The control: if start and end were the same instant everywhere, the
    // assertion above would hold for a parser that used either one.
    expect(widestGapMs).toBeGreaterThan(30_000);
  });

  it("a forked child reports ITS OWN start, not its parent's", () => {
    const forked = ALL.find((transcript) => boundaryOf(transcript) !== undefined);
    expect(forked).toBeDefined();
    const transcript = forked as Transcript;
    const metas = transcript.raw
      .filter((entry) => entry['type'] === 'session_meta')
      .sort((a, b) => Number(a['ordinal']) - Number(b['ordinal']));
    const own = Date.parse(String(metas[0]?.['timestamp']));
    const inherited = Date.parse(String(metas[1]?.['timestamp']));
    expect(own).not.toBe(inherited);
    const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
    expect(parsed.thread?.startedAtMs).toBe(own);
  });

  it('an unparseable timestamp is visibly wrong rather than plausibly wrong', () => {
    const parsed = parseCodexThread(
      [{ timestamp: 'not a date', ordinal: 0, type: 'session_meta', payload: { id: 't', session_id: 's' } }],
      { file: 'bad.jsonl', mtimeMs: 1_788_381_874_925 },
    );
    // 0 renders as 1970. The alternative - falling back to `mtimeMs` - is a
    // plausible wrong date, which is the whole defect.
    expect(parsed.thread?.startedAtMs).toBe(0);
    expect(parsed.thread?.mtimeMs).toBe(1_788_381_874_925);
  });
});

describe('C4 - both id namespaces travel on every tool call', () => {
  it('emits callId, itemId and idRelation, and the corpus exercises all three relations', () => {
    const relations = new Map<string, number>();
    for (const transcript of ALL) {
      const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
      for (const call of parsed.thread?.toolCalls ?? []) {
        relations.set(call.idRelation, (relations.get(call.idRelation) ?? 0) + 1);
        expect(typeof call.callId).toBe('string');
        expect(call.callId.startsWith('call_')).toBe(true);
        if (call.idRelation === 'no_item') expect(call.itemId).toBeNull();
        else expect(typeof call.itemId).toBe('string');
        if (call.idRelation === 'item_id_equals_call_id') expect(call.itemId).toBe(call.callId);
        if (call.idRelation === 'item_id_distinct_from_call_id') {
          expect(call.itemId).not.toBe(call.callId);
          expect(call.itemId?.startsWith('exec-')).toBe(true);
        }
      }
    }
    expect(relations.get('item_id_equals_call_id') ?? 0).toBeGreaterThan(0);
    expect(relations.get('item_id_distinct_from_call_id') ?? 0).toBeGreaterThan(0);
  });

  it('THE UNION RESOLVES STRICTLY MORE HOOK RECORDS THAN `call_id` ALONE', () => {
    // The spec's trap, measured against the committed hook streams: an engine
    // joining on `call_id` alone silently drops every v2 shell call. This is
    // the assertion that goes red if `itemId` stops being emitted.
    let byCallId = 0;
    let byUnion = 0;
    let withToolUseId = 0;
    for (const run of RUNS) {
      const callIds = new Set<string>();
      const itemIds = new Set<string>();
      for (const transcript of run.transcripts) {
        const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
        for (const call of parsed.thread?.toolCalls ?? []) {
          if (call.callId !== '') callIds.add(call.callId);
          if (call.itemId !== null) itemIds.add(call.itemId);
        }
      }
      for (const hook of run.hooks) {
        const raw = hook['raw'] as Record<string, unknown> | undefined;
        const id = typeof hook['toolUseId'] === 'string'
          ? hook['toolUseId']
          : typeof raw?.['tool_use_id'] === 'string'
            ? (raw['tool_use_id'] as string)
            : null;
        if (id === null) continue;
        withToolUseId++;
        if (callIds.has(id)) byCallId++;
        if (callIds.has(id) || itemIds.has(id)) byUnion++;
      }
    }
    expect(withToolUseId).toBeGreaterThan(0);
    expect(byCallId).toBeGreaterThan(0);
    expect(byUnion).toBeGreaterThan(byCallId);
  });
});

describe('C4a / C7 - spawns', () => {
  it('records both join keys, never the instruction, and marks a refusal', () => {
    let spawnsSeen = 0;
    let refusedSeen = 0;
    let v2Keyed = 0;
    let v1Keyed = 0;
    for (const transcript of ALL) {
      const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
      for (const spawn of parsed.thread?.spawns ?? []) {
        spawnsSeen++;
        // The join is the grafter's. Both keys leave here; neither is claimed.
        expect(spawn.childThreadId).toBeNull();
        expect(spawn.childResolvedBy).toBe('unresolved');
        if (spawn.outputTaskName !== null) v2Keyed++;
        if (spawn.outputAgentId !== null) v1Keyed++;
        if (spawn.refused) {
          refusedSeen++;
          expect(spawn.refusalText).toContain('already exists');
          expect(spawn.outputTaskName).toBeNull();
        }
        if (spawn.messagePresent) expect(spawn.messageBytes).toBeGreaterThan(0);
      }
    }
    expect(spawnsSeen).toBeGreaterThan(0);
    expect(v2Keyed).toBeGreaterThan(0);
    expect(v1Keyed).toBeGreaterThan(0);
    expect(refusedSeen).toBeGreaterThan(0);
  });

  it('a v1 PLAINTEXT message is measured and still never stored', () => {
    // C7: 17 of 17 spawn-bearing hook records carry a plaintext `task_name`
    // while 24 of 24 `message` fields are ciphertext - in the v2 dialect. The
    // v1 dialect sends the message in the CLEAR, and it must not be previewed
    // either way.
    const message = 'Please summarise the README and report the line count back to me.';
    const records: CodexRecord[] = [
      sessionMeta(0, {}),
      record(1, 'turn_context', { multi_agent_version: 'v1' }),
      record(2, 'response_item', {
        type: 'function_call',
        name: 'spawn_agent',
        namespace: 'multi_agent_v1',
        call_id: 'call_v1',
        arguments: JSON.stringify({ message, reasoning_effort: 'medium' }),
      }),
      record(3, 'response_item', {
        type: 'function_call_output',
        call_id: 'call_v1',
        output: JSON.stringify({ agent_id: 'child-1', nickname: 'Arendt' }),
      }),
    ];
    const parsed = parseCodexThread(records, { file: 'v1.jsonl' });
    const spawn = parsed.thread?.spawns[0];
    expect(spawn?.messagePresent).toBe(true);
    expect(spawn?.messageEncrypted).toBe(false);
    expect(spawn?.messageBytes).toBe(Buffer.byteLength(message, 'utf8'));
    expect(spawn?.outputAgentId).toBe('child-1');
    expect(spawn?.outputNickname).toBe('Arendt');
    expect(spawn?.requestedTaskName).toBeNull();
    expect(JSON.stringify(parsed.thread)).not.toContain('summarise the README');
    expect(parsed.thread?.dialect).toBe('v1');
  });
});

describe('truncation - Codex stores tool output whole and inline', () => {
  it('the largest committed record parses, and its output truncates with the marker', () => {
    // Derived, not written down: the transcript holding the corpus's longest
    // single line.
    let widest: { transcript: Transcript; bytes: number } | null = null;
    for (const transcript of ALL) {
      for (const line of transcript.text.split('\n')) {
        const bytes = Buffer.byteLength(line, 'utf8');
        if (widest === null || bytes > widest.bytes) widest = { transcript, bytes };
      }
    }
    expect(widest).not.toBeNull();
    const found = widest as { transcript: Transcript; bytes: number };
    expect(found.bytes).toBeGreaterThan(500_000);

    expect(() =>
      parseCodexTranscript(found.transcript.text, { file: found.transcript.file }),
    ).not.toThrow();
    const result = parseCodexTranscript(found.transcript.text, { file: found.transcript.file });
    expect(result.thread).not.toBeNull();
    expect(result.thread?.records).toBe(found.transcript.raw.length);
    expect(result.counters.payloadsTruncated).toBeGreaterThan(0);

    // Nothing anywhere near the raw size survives the boundary.
    expect(maxStringBytes(result.kept)).toBeLessThanOrEqual(DEFAULT_MAX_PAYLOAD_BYTES + 120);

    // The tool call whose output was 40 KB carries a marker stating the TRUE
    // original size - not the size of an intermediate cut. That is the
    // recorded Claude Code defect (a marker under-reporting by 7.73x) checked
    // on the other engine.
    const truncated = (result.thread?.toolCalls ?? []).filter((call) => call.outputTruncated === true);
    expect(truncated.length).toBeGreaterThan(0);
    for (const call of truncated) {
      const match = TRUNCATION_MARKER_RE.exec(call.outputPreview ?? '');
      expect(match).not.toBeNull();
      const rawOutput = found.transcript.raw.find((rec) => {
        const payload = rec['payload'] as Record<string, unknown> | null;
        return (
          rec['type'] === 'response_item'
          && payload !== null
          && typeof payload === 'object'
          && payload['call_id'] === call.callId
          && String(payload['type']).endsWith('_output')
        );
      });
      expect(rawOutput).toBeDefined();
      const payload = rawOutput?.['payload'] as Record<string, unknown>;
      const original = typeof payload['output'] === 'string'
        ? Buffer.byteLength(payload['output'], 'utf8')
        : Buffer.byteLength(JSON.stringify(payload['output']), 'utf8');
      expect(Number(match?.[2])).toBe(original);
      expect(Number(match?.[1])).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
    }
  });

  it('respects a caller-supplied ceiling', () => {
    const long = 'x'.repeat(5_000);
    const records = [
      sessionMeta(0, {}),
      record(1, 'response_item', { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{}' }),
      record(2, 'response_item', { type: 'function_call_output', call_id: 'c1', output: long }),
    ];
    const tight = parseCodexThread(records, { file: 't.jsonl', maxPayloadBytes: 100 });
    expect(tight.counters.payloadsTruncated).toBeGreaterThan(0);
    expect(tight.thread?.toolCalls[0]?.outputTruncated).toBe(true);
    expect(TRUNCATION_MARKER_RE.exec(tight.thread?.toolCalls[0]?.outputPreview ?? '')?.[2]).toBe('5000');

    const loose = parseCodexThread(records, { file: 't.jsonl' });
    expect(loose.counters.payloadsTruncated).toBe(0);
    expect(loose.thread?.toolCalls[0]?.outputTruncated).toBe(false);
  });
});

describe('C8 - tokens, and C3a - the dialect', () => {
  it('reads the level and the total from the last token_count, and never invents one', () => {
    for (const transcript of ALL) {
      const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
      const own = ownRecords(transcript);
      const counts = own.filter((raw) => {
        const payload = raw['payload'] as Record<string, unknown> | null;
        return raw['type'] === 'event_msg' && payload !== null && payload['type'] === 'token_count';
      });
      const last = counts[counts.length - 1];
      if (last === undefined) {
        expect(parsed.thread?.contextNow).toBeUndefined();
        expect(parsed.thread?.burn).toBeUndefined();
        expect(parsed.thread?.modelContextWindow).toBeUndefined();
        continue;
      }
      const info = (last['payload'] as Record<string, unknown>)['info'] as Record<string, unknown>;
      const level = info['last_token_usage'] as Record<string, number>;
      const total = info['total_token_usage'] as Record<string, number>;
      expect(parsed.thread?.contextNow).toEqual({ prompt: level['input_tokens'], output: level['output_tokens'] });
      expect(parsed.thread?.burn).toEqual({ prompt: total['input_tokens'], output: total['output_tokens'] });
      expect(parsed.thread?.modelContextWindow).toBe(info['model_context_window']);
      // The measurement that forced `prompt = input_tokens` alone: Codex's
      // `input_tokens` is already cache-inclusive, unlike Claude Code's.
      expect(level['total_tokens']).toBe((level['input_tokens'] ?? 0) + (level['output_tokens'] ?? 0));
    }
  });

  it('absent is ABSENT, never zero', () => {
    const parsed = parseCodexThread([sessionMeta(0, {})], { file: 'bare.jsonl' });
    expect(parsed.thread?.contextNow).toBeUndefined();
    expect(parsed.thread?.burn).toBeUndefined();
    expect(parsed.thread?.modelContextWindow).toBeUndefined();
    expect('modelContextWindow' in (parsed.thread ?? {})).toBe(false);

    // A transcript stating a window of 0 is not a transcript stating a window.
    const zero = parseCodexThread(
      [
        sessionMeta(0, {}),
        record(1, 'event_msg', { type: 'token_count', info: { model_context_window: 0 } }),
      ],
      { file: 'zero.jsonl' },
    );
    expect(zero.thread?.modelContextWindow).toBeUndefined();
  });

  it('reads the dialect off the session, and records which source decided', () => {
    for (const transcript of ALL) {
      const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
      const declared = new Set<string>();
      for (const raw of ownRecords(transcript)) {
        if (raw['type'] !== 'turn_context') continue;
        const payload = raw['payload'] as Record<string, unknown>;
        if (typeof payload['multi_agent_version'] === 'string') declared.add(payload['multi_agent_version']);
      }
      expect(declared.size).toBe(1);
      expect(parsed.thread?.dialect).toBe([...declared][0]);
      expect(parsed.thread?.dialectSource).toBe('turn_context.multi_agent_version');
    }
  });

  it('falls back to session_meta then to the spawn namespace, and refuses to guess', () => {
    const fromMeta = parseCodexThread([sessionMeta(0, { multi_agent_version: 'v2' })], { file: 'm.jsonl' });
    expect(fromMeta.thread?.dialect).toBe('v2');
    expect(fromMeta.thread?.dialectSource).toBe('session_meta.multi_agent_version');

    const fromNamespace = parseCodexThread(
      [
        sessionMeta(0, {}),
        record(1, 'response_item', {
          type: 'function_call',
          name: 'spawn_agent',
          namespace: 'multi_agent_v1',
          call_id: 'c',
          arguments: '{}',
        }),
      ],
      { file: 'n.jsonl' },
    );
    expect(fromNamespace.thread?.dialect).toBe('v1');
    expect(fromNamespace.thread?.dialectSource).toBe('spawn_namespace');

    // C3a: two sources disagreeing is an error, not a tiebreak. Refusing is
    // the fingerprint's job; reporting `null` is what lets it refuse.
    const conflict = parseCodexThread(
      [
        sessionMeta(0, {}),
        record(1, 'turn_context', { multi_agent_version: 'v1' }),
        record(2, 'turn_context', { multi_agent_version: 'v2' }),
      ],
      { file: 'c.jsonl' },
    );
    expect(conflict.thread?.dialect).toBeNull();
    expect(conflict.thread?.dialectSource).toBeNull();

    const silent = parseCodexThread([sessionMeta(0, {})], { file: 's.jsonl' });
    expect(silent.thread?.dialect).toBeNull();
  });
});

describe('the thread itself', () => {
  it('identifies each committed transcript from its OWNING declaration', () => {
    for (const transcript of ALL) {
      const metas = transcript.raw
        .filter((raw) => raw['type'] === 'session_meta')
        .sort((a, b) => Number(a['ordinal']) - Number(b['ordinal']));
      const owner = metas[0]?.['payload'] as Record<string, unknown>;
      const parsed = parseCodexTranscript(transcript.text, {
        file: transcript.file,
        mtimeMs: 1_234,
      });
      expect(parsed.thread?.threadId).toBe(owner['id'] ?? owner['session_id']);
      expect(parsed.thread?.sessionId).toBe(owner['session_id']);
      expect(parsed.thread?.owningFile).toBe(transcript.file);
      expect(parsed.thread?.cwd).toBe(owner['cwd']);
      expect(parsed.thread?.cliVersion).toBe(owner['cli_version']);
      expect(parsed.thread?.threadSource).toBe(owner['thread_source']);
      expect(parsed.thread?.records).toBe(transcript.raw.length);
      expect(parsed.thread?.mtimeMs).toBe(1_234);
      // A forked child re-serialises its parent's declaration, so more than
      // one `session_meta` in a file is normal, not a defect.
      expect(metas.length).toBeGreaterThan(0);
      for (const call of parsed.thread?.toolCalls ?? []) {
        expect(call.threadId).toBe(parsed.thread?.threadId);
        expect(call.file).toBe(transcript.file);
      }
    }
  });

  it('returns no thread, and still returns counters, for an undeclared file', () => {
    const parsed = parseCodexThread([record(0, 'world_state', {}), record(1, 'nope', {})], { file: 'x.jsonl' });
    expect(parsed.thread).toBeNull();
    expect(parsed.counters.unknownRecordTypes).toBe(1);
  });

  it('the counters are the thread\'s own, and every drop lands on one of them', () => {
    for (const transcript of ALL) {
      const parsed = parseCodexTranscript(transcript.text, { file: transcript.file });
      expect(parsed.thread?.counters).toEqual(parsed.counters);
      const accounted =
        parsed.kept.length
        + parsed.counters.reasoningDropped
        + parsed.counters.inheritedRecordsDropped
        + parsed.counters.unknownRecordTypes;
      expect(accounted).toBe(transcript.raw.length);
    }
  });
});

/** A JSON value nested `depth` levels deep. */
function nest(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let i = 0; i < depth; i++) value = { down: value };
  return value;
}
