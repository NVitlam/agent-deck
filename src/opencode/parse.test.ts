/**
 * Agent Deck — `src/opencode/parse.ts` (PLAN.md DoD 4.3).
 *
 * Two kinds of evidence, kept apart on purpose:
 *
 * 1. **Against the committed corpora.** Every `part` row of every
 *    `fixtures/opencode-*` database is read here with `node:sqlite` in
 *    `readOnly` mode, handed to `parseParts` as `OcPartRow[]`, and the result
 *    is compared to that corpus's committed `golden.json` — the counters
 *    field by field, and every tool node's `toolName` / `status` / `durationMs`
 *    / preview DIGEST. That is DoD 4.3's half of the DoD 4.6 reproduction:
 *    `graft.ts` owns the tree, this file owns the leaves.
 *
 *    The expected numbers are READ OUT OF `golden.json` at test time, never
 *    written here as literals. The recorded rule is not to assert fixture-set
 *    sizes: a count hard-coded against one capture breaks on the next harvest
 *    and reads as a regression.
 *
 * 2. **Against synthetic rows built in this file.** `fixtures/opencode-1.18.22/
 *    GOLDEN.md`'s "Measured gaps" table names branches no committed row
 *    reaches — `status: 'running'`, a part with no `state.time.end`,
 *    `counts.partsMalformed > 0` — and OC6 names one more: a `signature` field,
 *    which the measured provider (`qwen-local`) never writes. A rule that is
 *    only exercised by what one provider happened to emit is not a rule, so
 *    each of those is pinned by a row constructed here.
 *
 * NO SKIPS. Every corpus-dependent suite fails loudly if the corpus is absent
 * rather than skipping: the recorded hazard is that a suite which fails to
 * collect, or gates itself off, reports as "skipped" and reads green in the
 * summary line. The only conditional here is `describe.each(CORPUS_NAMES)`,
 * and `CORPUS_NAMES` is asserted non-empty by its own test.
 *
 * G1: every database opened here is a committed fixture opened `readOnly`, and
 * nothing is written anywhere.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_MAX_PAYLOAD_BYTES } from '../parser/redact.js';

import {
  OC_DROPPED_FIELDS,
  canonicalJson,
  parseParts,
  stripDroppedFields,
  toolStatus,
} from './parse.js';
import { corpusDbPath, corpusGoldenPath, listCorpora } from './synthetic.js';

import type { OcParseOutcome } from './parse.js';
import type { OcParseResult, OcPartRow, OcToolRecord } from './types.js';

/**
 * Resolved at COLLECTION time, on purpose.
 *
 * `describe.each(...)` is evaluated while vitest collects, before any
 * `beforeAll` runs. A list populated in `beforeAll` is still empty at that
 * moment, so every `.each` over it generates ZERO tests — and a file that
 * generates zero tests reports as a clean pass.
 */
const CORPUS_NAMES: readonly string[] = listCorpora();

/** The corpus GOLDEN.md calls "the anchor" (24 sessions). */
const ANCHOR = 'opencode-1.18.22';
/** The witness whose only job is the compaction part's optional `tail_start_id`. */
const WITNESS = 'opencode-1.18.21';

// ---------------------------------------------------------------------------
// Reading a corpus (read-only, G1)
// ---------------------------------------------------------------------------

function str(value: unknown, column: string): string {
  if (typeof value !== 'string') throw new Error(`column ${column} is not a string`);
  return value;
}

function num(value: unknown, column: string): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  throw new Error(`column ${column} is not an integer`);
}

/**
 * Every `part` row of one corpus as `OcPartRow[]`.
 *
 * Integers are read as BigInt (`setReadBigInts`) and narrowed at this boundary,
 * so no millisecond timestamp passes through a float — the same thing
 * `scripts/capture-opencode.mjs` and `scripts/opencode-golden.mjs` do.
 *
 * Nothing in this file does a string match in SQL. SQLite `LIKE` is
 * CASE-INSENSITIVE for ASCII and hands back confident wrong answers; the needle
 * work below happens in JavaScript over exact bytes.
 */
function readPartRows(corpusName: string): OcPartRow[] {
  const db = new DatabaseSync(corpusDbPath(corpusName), { readOnly: true });
  try {
    const stmt = db.prepare(
      'SELECT id, message_id, session_id, time_created, time_updated, data FROM part' +
        ' ORDER BY time_created, id',
    );
    stmt.setReadBigInts(true);
    return stmt.all().map((r) => ({
      id: str(r['id'], 'id'),
      messageId: str(r['message_id'], 'message_id'),
      sessionId: str(r['session_id'], 'session_id'),
      timeCreated: num(r['time_created'], 'time_created'),
      timeUpdated: num(r['time_updated'], 'time_updated'),
      data: str(r['data'], 'data'),
    }));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The committed golden, as JSON (validated shape, not imported types)
// ---------------------------------------------------------------------------

interface GoldenToolNode {
  node: 'tool';
  id: string;
  toolName: string;
  status: 'running' | 'done' | 'error';
  inputPreview: string | null;
  resultPreview: string | null;
  durationMs: number | null;
}

interface GoldenNode {
  node: 'agent' | 'tool';
  children?: GoldenNode[];
}

interface Golden {
  previewBytes: number;
  counts: Record<string, number>;
  sessions: { root: GoldenNode }[];
}

function readGolden(corpusName: string): Golden {
  return JSON.parse(readFileSync(corpusGoldenPath(corpusName), 'utf8')) as Golden;
}

function goldenToolNodes(golden: Golden): GoldenToolNode[] {
  const out: GoldenToolNode[] = [];
  const walk = (node: GoldenNode): void => {
    if (node.node === 'tool') out.push(node as unknown as GoldenToolNode);
    for (const child of node.children ?? []) walk(child);
  };
  for (const session of golden.sessions) walk(session.root);
  return out;
}

/**
 * `sha256:<first 16 hex>:<utf8 byte length>` — the house preview convention
 * (`fixtures/golden/session/README.md` rule 3), restated here rather than
 * imported from the generator, because comparing to the committed goldens is
 * the whole point and a shared helper would compare the generator to itself.
 *
 * The trailing byte length is what makes truncation VISIBLE: an 88,478-byte
 * payload shows as `:8248`, not `:88478`.
 */
function previewFingerprint(text: string | undefined): string | null {
  if (text === undefined) return null;
  const bytes = Buffer.from(text, 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}:${bytes.byteLength}`;
}

/** `\n...[agent-deck: truncated, showing K of N bytes]` at the very end. */
const MARKER_RE = /\n\.\.\.\[agent-deck: truncated, showing (\d+) of (\d+) bytes\]$/;

// ---------------------------------------------------------------------------
// Synthetic rows
// ---------------------------------------------------------------------------

let syntheticSeq = 0;

/** One `part` row, with `data` supplied as a value or as raw text. */
function row(
  data: unknown,
  overrides: Partial<OcPartRow> & { rawData?: string } = {},
): OcPartRow {
  syntheticSeq++;
  const { rawData, ...rest } = overrides;
  return {
    id: `prt_synthetic_${String(syntheticSeq).padStart(4, '0')}`,
    messageId: 'msg_synthetic',
    sessionId: 'ses_synthetic',
    timeCreated: 1_787_000_000_000 + syntheticSeq,
    timeUpdated: 1_787_000_000_000 + syntheticSeq,
    data: rawData ?? JSON.stringify(data),
    ...rest,
  };
}

/** A `tool` part payload, with `state` merged over a completed default. */
function toolData(
  tool: string,
  state: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'tool',
    tool,
    callID: `call_${tool}_${String(syntheticSeq + 1)}`,
    ...extra,
    state: {
      status: 'completed',
      input: { a: 1 },
      output: 'ok',
      time: { start: 1000, end: 1163 },
      ...state,
    },
  };
}

function onlyRecord(result: OcParseResult): OcToolRecord {
  const all = [...result.toolsBySession.values()].flat();
  expect(all).toHaveLength(1);
  return all[0] as OcToolRecord;
}

// ---------------------------------------------------------------------------
// Suite 1 — the committed corpora
// ---------------------------------------------------------------------------

it('finds at least one committed OpenCode corpus (a .each over an empty list is a green no-op)', () => {
  expect(CORPUS_NAMES.length).toBeGreaterThan(0);
  expect(CORPUS_NAMES).toContain(ANCHOR);
  expect(CORPUS_NAMES).toContain(WITNESS);
});

describe.each(CORPUS_NAMES)('corpus %s', (corpusName) => {
  let rows: OcPartRow[] = [];
  let result: OcParseOutcome;
  let golden: Golden;

  // Reading ~865 rows out of SQLite and parsing them is fast, but a hook that
  // does real work on a loaded machine loses vitest's 10 s DEFAULT hookTimeout
  // and the failure then reports as SKIPS with a clean-looking tests line.
  beforeAll(() => {
    rows = readPartRows(corpusName);
    result = parseParts(rows);
    golden = readGolden(corpusName);
  }, 60_000);

  it('reproduces every parse counter in the committed golden counts block', () => {
    // Read from the golden, never restated here: the counters move with the
    // corpus, and a literal would only pin the machine that captured it.
    const expected = golden.counts;
    for (const key of [
      'partRows',
      'partsMalformed',
      'reasoningPartsDropped',
      'partsIgnoredNoNode',
      'toolParts',
      'taskParts',
      'previewsTruncated',
    ] as const) {
      expect(expected[key], `golden has no counts.${key}`).toBeTypeOf('number');
      expect(result.counts[key], `counts.${key}`).toBe(expected[key]);
    }
    // The counter is the row count, not a filtered one.
    expect(result.counts.partRows).toBe(rows.length);
    // Every row landed in exactly one arm of the classification.
    expect(
      result.counts.partsMalformed +
        result.counts.reasoningPartsDropped +
        result.counts.partsIgnoredNoNode +
        result.counts.toolParts +
        result.toolPartsUnusable +
        result.toolPartsUnknownStatus,
    ).toBe(rows.length);
  });

  it('skips nothing: every tool part of both corpora is representable', () => {
    expect(result.toolPartsUnusable).toBe(0);
    expect(result.toolPartsUnknownStatus).toBe(0);
    // The two skip counters must stay OFF the golden's `counts` key set: DoD
    // 4.6 compares that block byte for byte, so an extra key would fail the
    // reproduction even at 0.
    expect(Object.keys(golden.counts)).not.toContain('toolPartsUnusable');
    expect(Object.keys(golden.counts)).not.toContain('toolPartsUnknownStatus');
    expect(Object.keys(result.counts).sort()).toEqual(
      [
        'partRows',
        'partsIgnoredNoNode',
        'partsMalformed',
        'previewsTruncated',
        'reasoningPartsDropped',
        'taskParts',
        'toolParts',
      ].sort(),
    );
  });

  it('keys every record under its own session and totals the tool count', () => {
    const flat = [...result.toolsBySession.values()].flat();
    expect(flat).toHaveLength(result.counts.toolParts);
    for (const [sessionId, records] of result.toolsBySession) {
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) expect(record.sessionId).toBe(sessionId);
    }
    // `id` is the callID, never the `prt_*` row id (contract amendment §D).
    for (const record of flat) {
      expect(record.id).not.toBe(record.partId);
      expect(record.partId.startsWith('prt_')).toBe(true);
      expect(record.order[0]).toBeTypeOf('number');
      expect(record.order[1]).toBe(record.partId);
    }
    expect(new Set(flat.map((r) => r.id)).size).toBe(flat.length);
  });

  it('reproduces every golden tool node field for field, previews by digest', () => {
    const nodes = goldenToolNodes(golden);
    expect(nodes.length).toBe(result.counts.toolParts);

    const byId = new Map<string, OcToolRecord>();
    for (const record of [...result.toolsBySession.values()].flat()) byId.set(record.id, record);

    for (const node of nodes) {
      const record = byId.get(node.id);
      expect(record, `no record for golden tool ${node.id}`).toBeDefined();
      if (record === undefined) continue;
      expect(record.toolName, node.id).toBe(node.toolName);
      expect(record.status, node.id).toBe(node.status);
      expect(record.durationMs ?? null, node.id).toBe(node.durationMs);
      expect(previewFingerprint(record.inputPreview), `${node.id} inputPreview`).toBe(
        node.inputPreview,
      );
      expect(previewFingerprint(record.resultPreview), `${node.id} resultPreview`).toBe(
        node.resultPreview,
      );
    }
  });

  it('cuts ONCE: every marker states the TRUE original byte count', () => {
    expect(golden.previewBytes).toBe(DEFAULT_MAX_PAYLOAD_BYTES);

    // Re-derive each record's uncut source straight from the stored row, so
    // the stated original is compared against the bytes on disk rather than
    // against another number this module produced.
    const sources = new Map<string, { input: string; output: string | undefined }>();
    for (const r of rows) {
      const data: unknown = JSON.parse(r.data);
      if (typeof data !== 'object' || data === null) continue;
      const rec = data as Record<string, unknown>;
      if (rec['type'] !== 'tool') continue;
      const state = (rec['state'] ?? {}) as Record<string, unknown>;
      const output =
        typeof state['output'] === 'string'
          ? state['output']
          : typeof state['error'] === 'string'
            ? state['error']
            : undefined;
      sources.set(r.id, {
        input: canonicalJson(stripDroppedFields(state['input'] ?? null)),
        output,
      });
    }

    let truncatedSeen = 0;
    for (const record of [...result.toolsBySession.values()].flat()) {
      const source = sources.get(record.partId);
      expect(source, record.partId).toBeDefined();
      if (source === undefined) continue;

      for (const [preview, truncated, raw] of [
        [record.inputPreview, record.inputTruncated, source.input] as const,
        [record.resultPreview, record.resultTruncated, source.output] as const,
      ]) {
        if (preview === undefined) {
          expect(truncated).toBe(false);
          continue;
        }
        const match = MARKER_RE.exec(preview);
        expect(Boolean(match), `${record.partId} marker vs truncated flag`).toBe(truncated);
        if (match === null || raw === undefined) continue;
        truncatedSeen++;
        const kept = Number(match[1]);
        const stated = Number(match[2]);
        // The stated original is the REAL source length, not the length of an
        // intermediate cut: a second cut would state 8248 here.
        expect(stated, `${record.partId} stated original`).toBe(Buffer.byteLength(raw, 'utf8'));
        expect(kept).toBeLessThanOrEqual(DEFAULT_MAX_PAYLOAD_BYTES);
        expect(stated).toBeGreaterThan(DEFAULT_MAX_PAYLOAD_BYTES);
      }
    }
    expect(truncatedSeen).toBe(result.counts.previewsTruncated);
  });

  /**
   * G4 / OC6 — the assertion that carries the weight.
   *
   * In Claude Code the thinking text is EMPTY on disk and the bytes sit in
   * `signature`, so a test asserting only that thinking text does not leak
   * passes forever while proving nothing. In OpenCode the bytes are plainly
   * present in `part.data.text`: 167 reasoning parts in the anchor, longest
   * 36,716 characters, none empty.
   *
   * MEASURED EXCEPTION, and it is not a redaction failure. The witness corpus
   * holds a session that was dumping OpenCode's OWN `part` table, so the stored
   * OUTPUT of `bash` part `prt_033c87862001xZXdJsRwZX6Ae1` quotes reasoning part
   * `prt_033c86b14001Xs7V5QAX2mooqp` ("The repos directory is empty…") verbatim,
   * inside session `ses_fcc8ec1ebffe81y3a6Ddc6DsMw`. Those bytes reach a record
   * through the TOOL payload, not through the reasoning part, and no redaction
   * of the reasoning path could remove them.
   *
   * The exclusion is therefore derived from disk — a needle is excluded only if
   * the same bytes are present in the RAW stored `data` of some non-reasoning
   * row — and it is fenced twice so it can never become a hole in the test:
   * the excluded set is asserted to be STRICTLY SMALLER than the needle set (it
   * can never grow to cover everything), and the anchor is asserted to need
   * ZERO exclusions, which keeps the strong claim where it can be made
   * (measured: anchor 0 of 167 excluded, witness 2 of 65 excluded, of which 1
   * would otherwise hit).
   */
  it('G4: no reasoning bytes reach the produced records', () => {
    const needles: string[] = [];
    const otherRaw: string[] = [];
    for (const r of rows) {
      const data: unknown = JSON.parse(r.data);
      const rec = data as Record<string, unknown>;
      if (rec['type'] === 'reasoning') {
        const text = rec['text'];
        expect(typeof text, `${r.id} reasoning text`).toBe('string');
        if (typeof text !== 'string') continue;
        // First 64 BYTES, with any split trailing code point dropped by the
        // decoder — never a character count.
        needles.push(Buffer.from(text, 'utf8').subarray(0, 64).toString('utf8'));
      } else {
        otherRaw.push(r.data);
      }
    }

    // Non-vacuous, asserted before the search: an empty needle set would make
    // every assertion below pass while proving nothing.
    expect(needles.length).toBe(result.counts.reasoningPartsDropped);
    expect(needles.length).toBeGreaterThan(0);
    for (const needle of needles) expect(needle.length).toBeGreaterThan(0);

    const otherBlob = otherRaw.join('\u0000');
    const quoted = needles.filter(
      (n) => otherBlob.includes(n) || otherBlob.includes(JSON.stringify(n).slice(1, -1)),
    );
    // The exclusion must never swallow the set it exists to except from.
    expect(quoted.length).toBeLessThan(needles.length);
    if (corpusName === ANCHOR) {
      expect(quoted, 'the anchor must need no exclusion at all').toHaveLength(0);
    }

    const records = [...result.toolsBySession.values()].flat();
    const serialized = JSON.stringify(records);
    // A second haystack of the RAW field values, because JSON.stringify escapes
    // newlines and quotes and a byte search of the escaped form can miss.
    const rawFields = records
      .flatMap((r) => [r.inputPreview, r.resultPreview ?? '', r.id, r.toolName])
      .join('\u0000');

    const hits = needles
      .filter((n) => !quoted.includes(n))
      .filter((n) => serialized.includes(n) || rawFields.includes(n));
    expect(hits, `reasoning bytes reached the records: ${hits.slice(0, 2).join(' | ')}`).toEqual([]);
  });

  it('leaves no dropped field name in any preview', () => {
    const records = [...result.toolsBySession.values()].flat();
    for (const field of OC_DROPPED_FIELDS) {
      for (const record of records) {
        expect(record.inputPreview.includes(`"${field}":`), `${record.partId} ${field}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — the anchor's largest payload, by name
// ---------------------------------------------------------------------------

describe(`the largest tool output in ${ANCHOR}`, () => {
  let result: OcParseOutcome;
  let rows: OcPartRow[] = [];

  beforeAll(() => {
    rows = readPartRows(ANCHOR);
    result = parseParts(rows);
  }, 60_000);

  it('states the real original byte count, not the intermediate one', () => {
    // Largest stored output, found from the rows rather than named by id.
    let largest: { partId: string; bytes: number } = { partId: '', bytes: -1 };
    for (const r of rows) {
      const rec = JSON.parse(r.data) as Record<string, unknown>;
      if (rec['type'] !== 'tool') continue;
      const state = (rec['state'] ?? {}) as Record<string, unknown>;
      const output = state['output'];
      if (typeof output !== 'string') continue;
      const bytes = Buffer.byteLength(output, 'utf8');
      if (bytes > largest.bytes) largest = { partId: r.id, bytes };
    }
    expect(largest.bytes).toBeGreaterThan(DEFAULT_MAX_PAYLOAD_BYTES);

    const record = [...result.toolsBySession.values()]
      .flat()
      .find((r) => r.partId === largest.partId);
    expect(record).toBeDefined();
    if (record === undefined) return;

    expect(record.resultTruncated).toBe(true);
    expect(record.resultPreview).toContain(`showing 8192 of ${largest.bytes} bytes`);
    // The double-cut number. `8192 + marker length` is what a second pass
    // would have reported as the original.
    const doubleCut = Buffer.byteLength(record.resultPreview ?? '', 'utf8');
    expect(record.resultPreview).not.toContain(`of ${doubleCut} bytes`);
    expect(doubleCut).toBe(DEFAULT_MAX_PAYLOAD_BYTES + 56);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — the witness's non-task error tool part
// ---------------------------------------------------------------------------

describe(`${WITNESS}'s error tool part`, () => {
  it('takes resultPreview from state.error on a NON-task tool', () => {
    const rows = readPartRows(WITNESS);
    const result = parseParts(rows);

    const errors: { partId: string; tool: string; source: 'error' | 'output' | 'none'; text: string }[] =
      [];
    for (const r of rows) {
      const rec = JSON.parse(r.data) as Record<string, unknown>;
      if (rec['type'] !== 'tool') continue;
      const state = (rec['state'] ?? {}) as Record<string, unknown>;
      if (state['status'] !== 'error') continue;
      const output = state['output'];
      const error = state['error'];
      errors.push({
        partId: r.id,
        tool: String(rec['tool']),
        source:
          typeof output === 'string' ? 'output' : typeof error === 'string' ? 'error' : 'none',
        text: typeof output === 'string' ? output : typeof error === 'string' ? error : '',
      });
    }
    const nonTask = errors.filter((e) => e.tool !== 'task');
    // GOLDEN.md DEVIATION 6: all 27 anchor error parts are `task` parts, so the
    // witness is the only corpus that exercises this rule on a plain tool.
    expect(nonTask.length).toBeGreaterThan(0);
    // ... and it has to exercise the `state.error` arm, not the output one, or
    // the rule under test is not the rule being run.
    expect(nonTask.filter((e) => e.source === 'error').length).toBeGreaterThan(0);

    const records = [...result.toolsBySession.values()].flat();
    for (const e of nonTask) {
      const record = records.find((r) => r.partId === e.partId);
      expect(record, e.partId).toBeDefined();
      expect(record?.status).toBe('error');
      if (e.source === 'none') expect(record && 'resultPreview' in record).toBe(false);
      else if (Buffer.byteLength(e.text, 'utf8') <= DEFAULT_MAX_PAYLOAD_BYTES)
        expect(record?.resultPreview).toBe(e.text);
      else expect(record?.resultPreview?.startsWith(e.text.slice(0, 100))).toBe(true);
      expect(record?.taskChildSessionId).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — canonical JSON
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { d: 1, c: [{ b: 1, a: 2 }] } })).toBe(
      '{"z":{"c":[{"a":2,"b":1}],"d":1}}',
    );
  });

  it('renders null, primitives and arrays the way JSON.stringify does', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(7)).toBe('7');
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson([1, 'two', null])).toBe('[1,"two",null]');
    expect(canonicalJson(undefined)).toBe('null');
    // A newline is escaped, not embedded — no raw control byte reaches a preview.
    expect(canonicalJson({ t: 'a\nb' })).toBe('{"t":"a\\nb"}');
  });

  it('produces the same bytes for two objects differing only in key order', () => {
    expect(canonicalJson({ filePath: 'x', limit: 2 })).toBe(canonicalJson({ limit: 2, filePath: 'x' }));
  });
});

describe('stripDroppedFields', () => {
  it('removes signature, thinking and redacted_thinking at any depth', () => {
    const input = {
      keep: 1,
      signature: 'AAAA',
      nested: { thinking: 'secret', deeper: [{ redacted_thinking: 'secret', ok: 2 }] },
    };
    expect(stripDroppedFields(input)).toEqual({ keep: 1, nested: { deeper: [{ ok: 2 }] } });
    // The input is not mutated.
    expect(input.signature).toBe('AAAA');
  });

  it('passes primitives, null and arrays through unchanged', () => {
    expect(stripDroppedFields(null)).toBeNull();
    expect(stripDroppedFields(5)).toBe(5);
    expect(stripDroppedFields(['a', 1, null])).toEqual(['a', 1, null]);
  });
});

describe('toolStatus', () => {
  it('maps the three measured values and refuses everything else', () => {
    expect(toolStatus('running')).toBe('running');
    expect(toolStatus('completed')).toBe('done');
    expect(toolStatus('error')).toBe('error');
    for (const bad of ['pending', 'RUNNING', '', undefined, null, 3, {}]) {
      expect(toolStatus(bad), JSON.stringify(bad) ?? 'undefined').toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — synthetic rows: the branches no committed corpus reaches
// ---------------------------------------------------------------------------

describe('synthetic rows', () => {
  it('counts a malformed data column and skips it, never throwing (G3)', () => {
    const result = parseParts([
      row(null, { rawData: '{"type":"tool", TRUNCATED' }),
      row(toolData('read')),
    ]);
    expect(result.counts.partsMalformed).toBe(1);
    expect(result.counts.toolParts).toBe(1);
    expect(result.counts.partRows).toBe(2);
  });

  it('counts a data column that parses to a NON-object as malformed', () => {
    // The reference generator would read `.type` off these and raise a
    // TypeError on `null`; a crash on input is what G3 forbids.
    const result = parseParts([
      row(null, { rawData: 'null' }),
      row(null, { rawData: '7' }),
      row(null, { rawData: '"text"' }),
      row(null, { rawData: '[]' }),
    ]);
    expect(result.counts.partsMalformed).toBe(4);
    expect(result.toolsBySession.size).toBe(0);
  });

  it('drops a reasoning part at the parse boundary, before any record exists', () => {
    // Lower-case, spaced, and named `needle` rather than `secret`: the
    // privacy sweep's `generic-high-entropy` rule keys on ASSIGNMENT SHAPE, and
    // the original spelling tripped it as a credential. It is still a unique
    // string that cannot occur by accident, which is all this test needs.
    const needle = 'reasoning bytes that must not survive redaction';
    const result = parseParts([
      row({ type: 'reasoning', text: needle, time: { start: 1, end: 2 } }),
      row(toolData('read')),
    ]);
    expect(result.counts.reasoningPartsDropped).toBe(1);
    expect(result.counts.partsIgnoredNoNode).toBe(0);
    expect(JSON.stringify([...result.toolsBySession.values()].flat())).not.toContain(needle);
  });

  it('ignores every non-tool part type, including a compaction with tail_start_id', () => {
    const result = parseParts([
      row({ type: 'text', text: 'hello' }),
      row({ type: 'step-start' }),
      row({ type: 'step-finish', tokens: { input: 1, output: 2 } }),
      row({ type: 'patch', hash: 'abc' }),
      row({ type: 'compaction', tail_start_id: 'prt_x' }),
      row({ type: 'compaction' }),
      row({ type: 'a-type-opencode-has-not-shipped-yet' }),
    ]);
    expect(result.counts.partsIgnoredNoNode).toBe(7);
    expect(result.counts.partsMalformed).toBe(0);
    expect(result.counts.toolParts).toBe(0);
    // Ignored, never refused: the session is not affected at all.
    expect(result.toolsBySession.size).toBe(0);
  });

  it('maps a RUNNING tool part (0 in either corpus)', () => {
    const result = parseParts([
      row(toolData('bash', { status: 'running', output: undefined, time: { start: 1000 } })),
    ]);
    const record = onlyRecord(result);
    expect(record.status).toBe('running');
    expect(record.resultPreview).toBeUndefined();
    expect(record.resultTruncated).toBe(false);
    expect('durationMs' in record).toBe(false);
  });

  it('omits durationMs when state.time.end is absent (0 such parts in either corpus)', () => {
    const noEnd = onlyRecord(parseParts([row(toolData('bash', { time: { start: 1000 } }))]));
    expect('durationMs' in noEnd).toBe(false);

    const noTime = onlyRecord(parseParts([row(toolData('bash', { time: undefined }))]));
    expect('durationMs' in noTime).toBe(false);

    const both = onlyRecord(parseParts([row(toolData('bash', { time: { start: 10, end: 42 } }))]));
    expect(both.durationMs).toBe(32);
  });

  it('strips signature/thinking/redacted_thinking out of a tool input (qwen-local writes none)', () => {
    const sig = 'SIGNATURE-BYTES-THAT-MUST-NOT-SURVIVE';
    const result = parseParts([
      row(
        toolData('task', {
          input: {
            prompt: 'go',
            signature: sig,
            nested: { thinking: sig, list: [{ redacted_thinking: sig, keep: true }] },
          },
        }),
      ),
    ]);
    const record = onlyRecord(result);
    expect(record.inputPreview).not.toContain(sig);
    expect(record.inputPreview).toBe('{"nested":{"list":[{"keep":true}]},"prompt":"go"}');
  });

  /*
   * G3, in its literal form: "malformed lines increment a counter and are
   * skipped; never crash on input". `scripts/opencode-golden.mjs` throws on
   * both of these cases and is right to — it is a build-time script a human
   * re-runs. The engine is a long-running observer, where one bad row must not
   * darken every session in the database.
   *
   * The load-bearing assertion in both tests is the LAST one: the rows around
   * the bad row in the same batch still produce their records.
   */
  it('skips a tool part with an unmapped state.status and counts it, without guessing', () => {
    const result = parseParts([
      row(toolData('read'), { id: 'prt_before' }),
      row(toolData('bash', { status: 'pending' }), { id: 'prt_bad_status' }),
      row(toolData('bash', { status: undefined }), { id: 'prt_no_status' }),
      row(toolData('edit'), { id: 'prt_after' }),
    ]);
    expect(result.toolPartsUnknownStatus).toBe(2);
    expect(result.toolPartsUnusable).toBe(0);
    // Not folded into `partsMalformed`, which means only "the `data` column did
    // not parse as JSON".
    expect(result.counts.partsMalformed).toBe(0);
    // The skipped parts produced no record and did not inflate `toolParts`.
    expect(result.counts.toolParts).toBe(2);
    const kept = [...result.toolsBySession.values()].flat();
    expect(kept.map((r) => r.partId)).toEqual(['prt_before', 'prt_after']);
    expect(kept.map((r) => r.toolName)).toEqual(['read', 'edit']);
    // And nothing was guessed into one of the three statuses.
    expect(kept.every((r) => r.status === 'done')).toBe(true);
  });

  it('skips a tool part with no callID or no tool name and counts it', () => {
    const result = parseParts([
      row(toolData('read'), { id: 'prt_before' }),
      row({ type: 'tool', tool: 'bash', state: { status: 'completed' } }, { id: 'prt_no_call' }),
      row({ type: 'tool', callID: 'c1', state: { status: 'completed' } }, { id: 'prt_no_tool' }),
      row({ type: 'tool', tool: 'bash', callID: '', state: { status: 'completed' } }, {
        id: 'prt_blank_call',
      }),
      row(toolData('edit'), { id: 'prt_after' }),
    ]);
    expect(result.toolPartsUnusable).toBe(3);
    expect(result.toolPartsUnknownStatus).toBe(0);
    expect(result.counts.partsMalformed).toBe(0);
    expect(result.counts.toolParts).toBe(2);
    const kept = [...result.toolsBySession.values()].flat();
    expect(kept.map((r) => r.partId)).toEqual(['prt_before', 'prt_after']);
    // The row id is never substituted for the missing callID.
    expect(kept.map((r) => r.id)).not.toContain('prt_no_call');
  });

  it('never throws on any shape of input row', () => {
    const rows = [
      row(null, { rawData: '{oops' }),
      row(null, { rawData: 'null' }),
      row({ type: 'tool' }),
      row({ type: 'tool', tool: 'bash', callID: 'c', state: 'not-an-object' }),
      row({ type: 'tool', tool: 'bash', callID: 'c', state: { status: 42 } }),
      row({ type: 'reasoning' }),
      row({}),
      row([]),
      row(toolData('read')),
    ];
    expect(() => parseParts(rows)).not.toThrow();
    const result = parseParts(rows);
    expect(result.counts.partRows).toBe(rows.length);
    expect(result.counts.toolParts).toBe(1);
  });

  it('takes the task join keys only from a task part, with the generator predicates', () => {
    const joined = onlyRecord(
      parseParts([
        row(
          toolData('task', {
            metadata: { sessionId: 'ses_child', parentSessionId: 'ses_parent' },
          }),
        ),
      ]),
    );
    expect(joined.taskChildSessionId).toBe('ses_child');
    expect(joined.taskParentSessionId).toBe('ses_parent');

    // The parked case (OC3): 9 of the anchor's 29 task parts carry no
    // `state.metadata.sessionId`. Absence is not guessed from timing.
    const parked = onlyRecord(parseParts([row(toolData('task', { metadata: {} }))]));
    expect('taskChildSessionId' in parked).toBe(false);
    expect('taskParentSessionId' in parked).toBe(false);

    /*
     * The two keys use DIFFERENT predicates, matching
     * `scripts/opencode-golden.mjs`'s `toToolNode`: the CHILD key is
     * non-empty-checked (`&& state.metadata.sessionId`) because its absence is
     * the `taskWithoutChild` signal, and the PARENT key takes any string
     * because the reference does. Measured: 0 empty-string values of either key
     * in both corpora, so this divergence moves no committed byte — it exists
     * so the engine cannot be stricter than the goldens it must reproduce.
     */
    const empty = onlyRecord(
      parseParts([row(toolData('task', { metadata: { sessionId: '', parentSessionId: '' } }))]),
    );
    expect('taskChildSessionId' in empty).toBe(false);
    expect(empty.taskParentSessionId).toBe('');

    const parentOnly = onlyRecord(
      parseParts([row(toolData('task', { metadata: { parentSessionId: 42 } }))]),
    );
    expect('taskParentSessionId' in parentOnly).toBe(false);

    // A non-task tool carrying the same metadata is NOT a spawn.
    const notTask = onlyRecord(
      parseParts([row(toolData('bash', { metadata: { sessionId: 'ses_child' } }))]),
    );
    expect('taskChildSessionId' in notTask).toBe(false);
  });

  it('counts task parts as tool parts too', () => {
    const result = parseParts([
      row(toolData('task', { metadata: { sessionId: 'ses_child' } })),
      row(toolData('bash')),
    ]);
    expect(result.counts.toolParts).toBe(2);
    expect(result.counts.taskParts).toBe(1);
  });

  it('maps a NON-task error tool part to resultPreview from state.error', () => {
    const record = onlyRecord(
      parseParts([
        row(toolData('bash', { status: 'error', output: undefined, error: 'command failed: 127' })),
      ]),
    );
    expect(record.status).toBe('error');
    expect(record.resultPreview).toBe('command failed: 127');
  });

  it('prefers state.output over state.error when both are strings', () => {
    const record = onlyRecord(
      parseParts([row(toolData('bash', { output: 'the output', error: 'the error' }))]),
    );
    expect(record.resultPreview).toBe('the output');
  });

  it('omits resultPreview when neither output nor error is a string', () => {
    const record = onlyRecord(
      parseParts([row(toolData('bash', { output: { not: 'a string' }, error: 42 }))]),
    );
    expect('resultPreview' in record).toBe(false);
  });

  it('counts each truncated preview once, input and result separately', () => {
    const big = 'x'.repeat(200);
    const result = parseParts([row(toolData('bash', { input: { big }, output: big }))], {
      maxPayloadBytes: 64,
    });
    const record = onlyRecord(result);
    expect(record.inputTruncated).toBe(true);
    expect(record.resultTruncated).toBe(true);
    expect(result.counts.previewsTruncated).toBe(2);
    expect(record.resultPreview).toContain('showing 64 of 200 bytes');
  });

  it('does not miscount a payload whose own text ENDS in marker-shaped bytes', () => {
    // The recorded `splitTruncationMarker` hazard: truncation is read off the
    // cut, never sniffed out of the text.
    const output = `already cut\n...[agent-deck: truncated, showing 10 of 999999 bytes]`;
    const record = onlyRecord(parseParts([row(toolData('bash', { output }))]));
    expect(record.resultTruncated).toBe(false);
    expect(record.resultPreview).toBe(output);
  });

  it('cuts on a UTF-8 boundary rather than splitting a code point', () => {
    // 'é' is two bytes; a naive slice at an odd limit would split it.
    const output = 'é'.repeat(50);
    const record = onlyRecord(parseParts([row(toolData('bash', { output }))], { maxPayloadBytes: 9 }));
    expect(record.resultTruncated).toBe(true);
    expect(record.resultPreview).toContain('showing 8 of 100 bytes');
    expect(record.resultPreview?.startsWith('éééé\n')).toBe(true);
  });

  it('groups records by the ROW session id and preserves row order per session', () => {
    const result = parseParts([
      row(toolData('read'), { id: 'prt_a', sessionId: 'ses_1', timeCreated: 10 }),
      row(toolData('bash'), { id: 'prt_b', sessionId: 'ses_2', timeCreated: 11 }),
      row(toolData('edit'), { id: 'prt_c', sessionId: 'ses_1', timeCreated: 12 }),
    ]);
    expect([...result.toolsBySession.keys()].sort()).toEqual(['ses_1', 'ses_2']);
    expect(result.toolsBySession.get('ses_1')?.map((r) => r.partId)).toEqual(['prt_a', 'prt_c']);
    expect(result.toolsBySession.get('ses_1')?.[1]?.order).toEqual([12, 'prt_c']);
  });

  it('returns zeroed counters and an empty map for zero rows', () => {
    const result = parseParts([]);
    expect(result.toolsBySession.size).toBe(0);
    expect(result.counts).toEqual({
      partRows: 0,
      partsMalformed: 0,
      reasoningPartsDropped: 0,
      partsIgnoredNoNode: 0,
      toolParts: 0,
      taskParts: 0,
      previewsTruncated: 0,
    });
  });
});
