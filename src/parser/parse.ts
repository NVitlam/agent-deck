/**
 * Agent Deck — line parser.
 *
 * Turns one assembled transcript line (from `tailer.ts`, which owns byte
 * offsets and line assembly) into a typed `TranscriptEntry`, and one
 * `agent-<id>.meta.json` sidecar into a `SubagentMeta`.
 *
 * Grounding constraints this module is held to:
 *
 *   G1  Read-only. The only I/O is reading offloaded tool-results files, and
 *       that goes through `redact.ts`. Nothing is written anywhere.
 *   G3  Refuse, don't guess. Malformed input increments a counter and is
 *       skipped; no input can make a call throw. Covered and tested: invalid
 *       JSON, a line truncated mid-JSON, a JSON scalar or array where an object
 *       was expected, an empty or whitespace-only line, an unexpected `type`,
 *       deeply nested or enormous values, and unpaired surrogates.
 *   G4  Redaction happens HERE, at the parse boundary. There is no option to
 *       turn it off: a thinking block is dropped before the entry object is
 *       constructed, so no caller can ever observe one.
 *   G6  Every shape below was measured from the committed CC 2.1.234 fixtures.
 *
 * Measured over the 7 committed transcripts (124 non-empty lines): 7 distinct
 * `type` values, `type` present on 124/124, `sessionId` 122, `timestamp` 116,
 * `uuid`/`parentUuid`/`isSidechain`/`version`/`cwd`/`gitBranch` 112,
 * `message` 90, `agentId` 84. Content block types: `tool_use` 26,
 * `tool_result` 26, `text` 19, `thinking` 15; `message.content` is a plain
 * string on 5 lines (the opening prompt of each subagent transcript).
 */

import type {
  ParseDiagnostics,
  ParseResult,
  SubagentMeta,
  TranscriptEntry,
} from '../model/events.js';
import { emptyDiagnostics } from '../model/events.js';
import type {
  PersistedOutputPointer,
  RedactionOptions,
  RedactionReport,
  ToolResultContext,
  ToolResultRead,
} from './redact.js';
import { parsePersistedOutputPointer, readRedactedToolResult, redactJson } from './redact.js';

// ---------------------------------------------------------------------------
// Known entry types
// ---------------------------------------------------------------------------

/**
 * The `type` values observed in the committed capture, with counts:
 * assistant 57, user 33, attachment 22, queue-operation 4, ai-title 4,
 * file-history-snapshot 2, last-prompt 2.
 *
 * A line whose `type` is not in this set is counted as malformed and skipped
 * rather than guessed at (G3). Unknown *fields* are a different matter and are
 * kept without complaint — CC adds fields between versions.
 */
export const KNOWN_ENTRY_TYPES: ReadonlySet<string> = new Set([
  'assistant',
  'user',
  'attachment',
  'queue-operation',
  'ai-title',
  'file-history-snapshot',
  'last-prompt',
]);

// ---------------------------------------------------------------------------
// Single-line parse
// ---------------------------------------------------------------------------

/** Why a line was rejected. Stable strings; tests and diagnostics match on them. */
export type LineRejection =
  | 'empty'
  | 'invalidJson'
  | 'notAnObject'
  | 'missingType'
  | 'unknownType'
  | 'loneSurrogate';

export interface LineParseSuccess {
  ok: true;
  entry: TranscriptEntry;
  /** What redaction did to this line. */
  report: RedactionReport;
}

export interface LineParseFailure {
  ok: false;
  rejection: LineRejection;
  /** Human-readable detail, e.g. `unknown type: sidechain-marker`. */
  reason: string;
}

export type LineParseOutcome = LineParseSuccess | LineParseFailure;

export interface ParseOptions extends RedactionOptions {
  /**
   * Accept `type` values outside {@link KNOWN_ENTRY_TYPES}. Off by default;
   * exists so a future drift fixture can be explored without editing code.
   * It does NOT affect redaction, which is unconditional.
   */
  allowUnknownTypes?: boolean;
}

/**
 * Parse one assembled line. Never throws, for any input.
 *
 * Redaction runs before the entry is built, so a thinking block cannot reach
 * the returned object even transiently.
 */
export function parseLine(text: string, options: ParseOptions = {}): LineParseOutcome {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, rejection: 'empty', reason: 'empty or whitespace-only line' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, rejection: 'invalidJson', reason: `invalid JSON: ${detail}` };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      rejection: 'notAnObject',
      reason: `expected a JSON object, got ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}`,
    };
  }

  const typeValue = (raw as { type?: unknown }).type;
  if (typeof typeValue !== 'string' || typeValue === '') {
    return {
      ok: false,
      rejection: 'missingType',
      reason: `missing or non-string "type" (got ${typeof typeValue})`,
    };
  }
  if (!KNOWN_ENTRY_TYPES.has(typeValue) && options.allowUnknownTypes !== true) {
    return { ok: false, rejection: 'unknownType', reason: `unknown type: ${typeValue}` };
  }

  // --- G4 boundary. Nothing below this line sees unredacted content. ---
  const redacted = redactJson(raw, options);
  if (redacted.report.loneSurrogate) {
    return {
      ok: false,
      rejection: 'loneSurrogate',
      reason: 'line contains an unpaired UTF-16 surrogate and cannot round-trip as UTF-8',
    };
  }

  const record = redacted.value as Record<string, unknown>;
  const entry: TranscriptEntry = { type: typeValue };
  for (const key of Object.keys(record)) {
    if (key === 'type') continue;
    entry[key] = record[key];
  }
  return { ok: true, entry, report: redacted.report };
}

// ---------------------------------------------------------------------------
// Batch parse with diagnostics
// ---------------------------------------------------------------------------

export interface ParsedBatch {
  entries: TranscriptEntry[];
  /** One item per rejected line, in input order. `length` equals `malformedLines`. */
  rejections: { index: number; rejection: LineRejection; reason: string }[];
  /** Aggregate of every line's redaction report. */
  report: RedactionReport;
}

/**
 * Parse many lines, accumulating counters instead of throwing.
 *
 * The counter is exact: feed N bad lines and `diagnostics.malformedLines` is
 * N. `parsedLines` counts successes. The two always sum to the number of lines
 * supplied.
 *
 * Always `ok: true` — refusing a whole session on a schema mismatch is
 * `fingerprint.ts`'s job, not this module's. A bad line degrades one line.
 */
export function parseLines(
  lines: Iterable<string>,
  options: ParseOptions = {},
): ParseResult<ParsedBatch> {
  const diagnostics = emptyDiagnostics();
  const entries: TranscriptEntry[] = [];
  const rejections: ParsedBatch['rejections'] = [];
  const report: RedactionReport = {
    thinkingBlocksDropped: 0,
    thinkingFieldsDropped: 0,
    truncatedStrings: 0,
    depthLimited: 0,
    loneSurrogate: false,
  };

  let index = 0;
  for (const line of lines) {
    const outcome = parseLine(line, options);
    if (outcome.ok) {
      entries.push(outcome.entry);
      diagnostics.parsedLines++;
      report.thinkingBlocksDropped += outcome.report.thinkingBlocksDropped;
      report.thinkingFieldsDropped += outcome.report.thinkingFieldsDropped;
      report.truncatedStrings += outcome.report.truncatedStrings;
      report.depthLimited += outcome.report.depthLimited;
    } else {
      diagnostics.malformedLines++;
      rejections.push({ index, rejection: outcome.rejection, reason: outcome.reason });
    }
    index++;
  }

  return { ok: true, value: { entries, rejections, report }, diagnostics };
}

// ---------------------------------------------------------------------------
// Subagent sidecar
// ---------------------------------------------------------------------------

/**
 * Parse an `agent-<agentId>.meta.json` sidecar (whole-file JSON, not JSONL).
 *
 * `toolUseId` names the exact parent `tool_use` block, which is what makes
 * subagent attribution a primary-key join rather than an inference, so the
 * three fields the join needs are required. A corrupt sidecar produces a
 * counted, described failure — `ok: false` plus a `skippedFiles` entry — never
 * an exception.
 *
 * Measured sidecar (CC 2.1.234, 5 files):
 *   {"agentType":"general-purpose","description":"nested-child",
 *    "toolUseId":"toolu_012x...","parentAgentId":"a1a53f42c5eca8824","spawnDepth":2}
 */
export function parseSubagentMeta(text: string, path = ''): ParseResult<SubagentMeta> {
  const diagnostics = emptyDiagnostics();
  const refuse = (
    reason: string,
    extra: { field?: string; expected?: string; actual?: string } = {},
  ): ParseResult<SubagentMeta> => {
    diagnostics.skippedFiles.push({ path, reason });
    return {
      ok: false,
      mismatch: { kind: 'schemaMismatch', reason, path, ...extra },
      diagnostics,
    };
  };

  if (typeof text !== 'string' || text.trim() === '') {
    return refuse('sidecar is empty', { expected: 'JSON object', actual: 'empty file' });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return refuse(`sidecar is not valid JSON: ${detail}`, {
      expected: 'JSON object',
      actual: 'unparseable',
    });
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refuse('sidecar is not a JSON object', {
      expected: 'JSON object',
      actual: raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw,
    });
  }

  const redacted = redactJson(raw, {});
  const record = redacted.value as Record<string, unknown>;

  const agentType = record['agentType'];
  const description = record['description'];
  const toolUseId = record['toolUseId'];
  const spawnDepth = record['spawnDepth'];

  if (typeof agentType !== 'string') {
    return refuse('sidecar field "agentType" is missing or not a string', {
      field: 'agentType',
      expected: 'string',
      actual: typeof agentType,
    });
  }
  if (typeof description !== 'string') {
    return refuse('sidecar field "description" is missing or not a string', {
      field: 'description',
      expected: 'string',
      actual: typeof description,
    });
  }
  if (typeof toolUseId !== 'string' || toolUseId === '') {
    return refuse('sidecar field "toolUseId" is missing or not a non-empty string', {
      field: 'toolUseId',
      expected: 'non-empty string',
      actual: typeof toolUseId,
    });
  }
  if (typeof spawnDepth !== 'number' || !Number.isFinite(spawnDepth)) {
    return refuse('sidecar field "spawnDepth" is missing or not a finite number', {
      field: 'spawnDepth',
      expected: 'number',
      actual: typeof spawnDepth,
    });
  }

  const meta: SubagentMeta = { agentType, description, toolUseId, spawnDepth };
  for (const key of Object.keys(record)) {
    if (key === 'agentType' || key === 'description' || key === 'toolUseId' || key === 'spawnDepth') {
      continue;
    }
    meta[key] = record[key];
  }
  const parentAgentId = record['parentAgentId'];
  if (typeof parentAgentId === 'string') meta.parentAgentId = parentAgentId;

  diagnostics.parsedLines = 1;
  return { ok: true, value: meta, diagnostics };
}

// ---------------------------------------------------------------------------
// Offloaded tool results
// ---------------------------------------------------------------------------

/** A `<persisted-output>` stub found inside a parsed entry. */
export interface PersistedOutputStub {
  /** The `tool_use` id the result belongs to — the graft key. */
  toolUseId: string;
  pointer: PersistedOutputPointer;
}

function contentBlocks(entry: TranscriptEntry): unknown[] {
  const message = entry['message'];
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

/**
 * Find every offloaded-payload pointer in a parsed entry.
 *
 * Measured: 1 stub in the committed capture, in
 * `05c5482d-.../subagents/agent-a3ecf86bbfb853726.jsonl` line 12, pointing at
 * `tool-results/b6uvpgxa4.txt` (63,774 bytes on disk; CC's stub says '62.3KB',
 * i.e. it reports KiB).
 *
 * Only `tool_result` blocks whose `content` is a plain string can carry a stub
 * — the array-of-text form (5 of 26 tool_results) is inline output.
 */
export function collectPersistedOutputStubs(entry: TranscriptEntry): PersistedOutputStub[] {
  const found: PersistedOutputStub[] = [];
  for (const block of contentBlocks(entry)) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown };
    if (b.type !== 'tool_result') continue;
    const pointer = parsePersistedOutputPointer(b.content);
    if (pointer === undefined) continue;
    found.push({
      toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
      pointer,
    });
  }
  return found;
}

export interface HydratedToolResult extends PersistedOutputStub {
  read: ToolResultRead;
}

/**
 * Resolve every offloaded payload referenced by `entry` and put it through the
 * same redaction/truncation path as inline content.
 *
 * The absolute path CC wrote into the stub is DISCARDED. Only the basename
 * survives, and the file is resolved under the ACTIVE projects root. This is
 * not a nicety: under fixture replay the embedded path points into the real
 * user's `~/.claude`, so following it would read live data instead of the
 * fixture, or fail. We never open the path CC wrote.
 *
 * A missing or unreadable file appends a `skippedFiles` diagnostic and yields a
 * degraded preview taken from the stub itself. It never throws (G3).
 */
export async function hydratePersistedOutputs(
  entry: TranscriptEntry,
  ctx: ToolResultContext,
  diagnostics?: ParseDiagnostics,
): Promise<HydratedToolResult[]> {
  const stubs = collectPersistedOutputStubs(entry);
  const out: HydratedToolResult[] = [];
  for (const stub of stubs) {
    const read = await readRedactedToolResult(stub.pointer, ctx);
    if (!read.ok && diagnostics !== undefined) {
      diagnostics.skippedFiles.push({ path: read.path, reason: read.reason ?? 'unreadable' });
    }
    out.push({ ...stub, read });
  }
  return out;
}
