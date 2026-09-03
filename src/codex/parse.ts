/**
 * Agent Deck - the Codex engine's parse + redact boundary (PLAN.md v0.6.0
 * DoD 2.3 and 2.3a).
 *
 * `CodexRecord[]` for ONE rollout transcript in, one {@link CodexThread} out.
 * No I/O: `tail.ts` reads the bytes, `fingerprint.ts` decides whether the
 * session is supported, and this file is a pure function of the records. That
 * is what lets the tests build a novel record type, a malformed line and a
 * ciphertext-bearing tool output by hand.
 *
 * ---------------------------------------------------------------------------
 * G3 - NOTHING HERE REFUSES, AND NOTHING HERE THROWS
 * ---------------------------------------------------------------------------
 *
 * Spec C2: "Unknown types are ignored, not refused", and the user note of
 * 2026-09-03 that makes the ignore honest:
 *
 *   > An unknown record type is COUNTED per session and surfaced through the
 *   > existing degraded/diagnostic counter. Refusal stays on the fingerprinted
 *   > structure of C3 and nothing else. Ignoring one SILENTLY is the fail-open
 *   > class this project has shipped through three separate doors. The counter
 *   > is what makes the ignore honest, so it is normative, not advisory.
 *
 * So every drop this module makes lands on one of {@link CodexCounters}' six
 * fields - including {@link CodexCounters.skippedResponseItemTypes}, which
 * NAMES a skipped `response_item` payload type rather than merely counting it,
 * because a bare zero there cannot be told apart from an empty corpus. No
 * input - malformed, novel, hostile or 554 KB - produces a throw or a refusal.
 *
 * ---------------------------------------------------------------------------
 * THE BOUNDARY IS A REAL FILTER, NOT AN OMISSION
 * ---------------------------------------------------------------------------
 *
 * `redactCodexRecords` produces the list of records that SURVIVE, and
 * everything the thread is built from is read out of that list. It would have
 * been cheaper to skip the rebuild and simply never read a reasoning payload -
 * and that is exactly the shape whose G4 test cannot fail. This repository's
 * most-recorded defect is a redaction test that passes while proving nothing
 * (Claude Code's `thinking` string is empty on disk, so asserting "no thinking
 * text leaked" was vacuous for three phases). A filter with a survivor list can
 * be asserted on directly, and breaking it turns the test red.
 *
 * Codex is the mirror image of the Claude Code trap and has its own version of
 * it. Reasoning summaries are EMPTY here too - measured over the committed
 * corpus, 0 of 34 `response_item/reasoning` records carry a non-empty
 * `summary`, and 0 of 34 `event_msg` `Reasoning` items carry non-empty
 * `summary_text` or `raw_content`. The bytes are in `encrypted_content`, a
 * Fernet-style ciphertext. A test that only looked at the visible field would
 * pass forever.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CIPHERTEXT ACTUALLY IS, AND WHY A STRUCTURAL WALK MISSES SOME
 * ---------------------------------------------------------------------------
 *
 * Measured over the committed corpus, ciphertext strings occur at four field
 * paths - not one:
 *
 *   response_item/reasoning.encrypted_content                (dropped whole)
 *   response_item/agent_message.content[].encrypted_content  (NOT a reasoning
 *                                                             record)
 *   response_item/function_call.arguments{spawn_agent}.message
 *   response_item/function_call.arguments{send_message}.message
 *
 * Two consequences that shape the walk below:
 *
 *   a) Dropping reasoning records is NOT sufficient. `agent_message` carries
 *      ciphertext and is not reasoning, so the scrub has to be a property of
 *      every surviving string rather than of one record type.
 *   b) `arguments` is a JSON STRING. A structural walk over the parsed record
 *      never descends into it, so a walk that looks thorough silently misses
 *      the spawn instruction - the single most sensitive string in the file.
 *      `scripts/codex-golden.mjs` records the same finding from the other
 *      side: 12 of its 57 ciphertext strings live inside `arguments`.
 *
 * C7 is categorical about the spawn message: "never decoded, never stored,
 * never displayed". Its BYTE COUNT is kept - {@link CodexSpawn.messageBytes} -
 * and the bytes are replaced by {@link ciphertextMarker} at the boundary, so
 * the count survives the scrub without the payload surviving with it.
 *
 * ---------------------------------------------------------------------------
 * C5 - THE FORK BOUNDARY, AND THE `=== null` TRAP
 * ---------------------------------------------------------------------------
 *
 * A child spawned with `fork_turns: "all"` re-serialises its parent's history
 * into its own file under its own dense ordinals.
 * `session_meta.payload.subagent_history_start_ordinal` is the boundary and
 * records below it are inherited context.
 *
 * When the spawn was `fork_turns: "none"` the key is ABSENT - not null, not
 * zero. `resume-twice-v1`'s subagent is that case in the committed corpus.
 * The spec:
 *
 *   > An engine testing `=== null` reads `undefined`, takes the wrong branch,
 *   > and throws nothing.
 *
 * {@link forkStartOrdinal} therefore tests for the OWN PROPERTY and then for a
 * finite number, and returns `undefined` for every other shape. There is no
 * `=== null` anywhere in this file.
 *
 * One consequence is worth stating because it looks like a bug and is not: the
 * child's OWN `session_meta` sits at ordinal 0, BELOW its own boundary, and is
 * therefore counted as inherited and dropped from the content pass. The
 * declaration is read first - it is what states the boundary - and the record
 * is then dropped like any other. `scripts/codex-golden.mjs` counts it the
 * same way, which is why `inheritedRecordsBeforeForkStart` for the `baseline`
 * child is 9 rather than 8.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * **It does not resolve a spawn to its child thread.** A child's transcript is
 * a SIBLING FILE, and this function sees one file. So every
 * {@link CodexSpawn} leaves here with `childThreadId: null` and
 * `childResolvedBy: 'unresolved'`, carrying both join keys - `outputTaskName`
 * (v2, joins the child's `agent_path`) and `outputAgentId` (v1, IS the child's
 * thread id) - for `graft.ts` to join across threads. Filling `childThreadId`
 * from `outputAgentId` alone would be asserting a join nobody verified, which
 * is the failure `types.ts` records at length against the `dialectV1` park
 * code.
 *
 * **It does not join the hook tap.** It supplies both id namespaces of C4 -
 * `callId` from `response_item.payload.call_id` and `itemId` from
 * `event_msg.payload.item.id` - plus {@link CodexToolCall.idRelation}. A shell
 * command carries an `exec-<uuid>` item id and an unrelated `call_<...>`, and
 * the hook tap reports the ITEM id: measured over 81 hook records carrying a
 * `tool_use_id`, 61 resolve against `call_id` and 81 against the union. An
 * engine joining on `call_id` alone drops every v2 shell call.
 */

import { Buffer } from 'node:buffer';

import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  MAX_REDACTION_DEPTH,
  splitTruncationMarker,
  truncatePreservingMarker,
  truncateUtf8,
} from '../parser/redact.js';

import type { TokenPair } from '../model/events.js';
import type {
  CodexCounters,
  CodexDialect,
  CodexDialectSource,
  CodexIdRelation,
  CodexOptional,
  CodexRecord,
  CodexSpawn,
  CodexThread,
  CodexToolCall,
} from './types.js';

// ---------------------------------------------------------------------------
// C2 - the record types, and the line boundary
// ---------------------------------------------------------------------------

/**
 * The six record types of spec C2. Anything else is counted on
 * {@link CodexCounters.unknownRecordTypes} and ignored - never refused, and
 * never allowed to produce a node.
 */
export const CODEX_RECORD_TYPES: ReadonlySet<string> = new Set([
  'session_meta',
  'event_msg',
  'response_item',
  'turn_context',
  'world_state',
  'inter_agent_communication_metadata',
]);

/**
 * What this module does with each `response_item` payload type, declared
 * rather than discovered.
 *
 * DoD 2.3: "Every `response_item` type in the corpus handled or
 * counted-skipped." `src/codex/parse.test.ts` derives the set of payload types
 * present in the committed corpus AT TEST TIME and asserts every one of them
 * appears here, so a later harvest carrying a new type fails a test instead of
 * being silently ignored.
 *
 * A type whose disposition is `skipped` - and any type with no entry here at
 * all - is NAMED on {@link CodexCounters.skippedResponseItemTypes}, not merely
 * absent from the output. That field exists because the census used to live on
 * this module's own result type, where it stopped existing at the engine
 * boundary: a count of zero nobody can tell apart from "nothing was skipped",
 * which is working-method rule 18's silent skip.
 *
 * `tool_search_call` IS a tool call and is emitted as one. An earlier version
 * of this file counted it as skipped, because `CodexToolCall.kind` then had
 * two members and `types.ts` is the hand-off line no work package may edit -
 * so the record was reported rather than mislabelled as a `function_call`.
 * `types.ts` gained the third member at `4515669` and the arithmetic is the
 * evidence: `golden.json`'s 42 tool calls are 31 `function_call` + 10
 * `custom_tool_call` + 1 `tool_search_call`, and its 3 `no_item` relations are
 * this repository's 2 plus that one.
 *
 * **n=1, and nothing about its shape is claimed beyond that record.** Two
 * differences from the other two kinds are measured rather than assumed:
 * it carries NO `name` key (so `name` is `''`, which is what the reference
 * reader writes into the golden, not a default chosen here) and NO
 * `namespace` key (so `namespace` is `{present: false}`, which the type can
 * state honestly). Its `arguments` is a JSON OBJECT, where the other two
 * kinds carry a JSON string.
 *
 * `tool_search_output` stays SKIPPED: it is a ~25 KB catalogue of tool
 * schemas rather than a result a user reads, so it feeds no
 * {@link CodexToolCall.outputPreview} - and it is named on the counter
 * instead of quietly producing nothing.
 */
export type CodexResponseItemDisposition =
  /** Becomes a {@link CodexToolCall}. */
  | 'tool_call'
  /** Supplies {@link CodexToolCall.outputPreview} for a call. */
  | 'tool_output'
  /** Dropped whole at the boundary (G4 / C7). */
  | 'reasoning'
  /** Recognised, carries no node: conversation content. */
  | 'content'
  /** Recognised, produces nothing, and SAYS SO on the counters. */
  | 'skipped';

export const CODEX_RESPONSE_ITEM_DISPOSITION: Readonly<Record<string, CodexResponseItemDisposition>> = {
  function_call: 'tool_call',
  custom_tool_call: 'tool_call',
  tool_search_call: 'tool_call',
  function_call_output: 'tool_output',
  custom_tool_call_output: 'tool_output',
  reasoning: 'reasoning',
  message: 'content',
  agent_message: 'content',
  tool_search_output: 'skipped',
};

/** The payload types that become a {@link CodexToolCall}. */
const TOOL_CALL_PAYLOAD_TYPES: ReadonlySet<string> = new Set([
  'function_call',
  'custom_tool_call',
  'tool_search_call',
]);

/** Narrow a checked payload type onto the union, explicitly rather than by cast. */
function toolCallKind(type: string): CodexToolCall['kind'] {
  if (type === 'custom_tool_call') return 'custom_tool_call';
  if (type === 'tool_search_call') return 'tool_search_call';
  return 'function_call';
}

/** The payload types that carry a call's result. */
const TOOL_OUTPUT_PAYLOAD_TYPES: ReadonlySet<string> = new Set([
  'function_call_output',
  'custom_tool_call_output',
]);

/** C4: a shell command's completed-item id. Not a `call_<...>`. */
const EXEC_ITEM_PREFIX = 'exec-';

/** The multi-agent spawn tool, in both dialects. */
const SPAWN_TOOL_NAME = 'spawn_agent';

/** C3a: the namespace a spawn was made in, as a dialect of last resort. */
const DIALECT_BY_NAMESPACE: ReadonlyMap<string, CodexDialect> = new Map<string, CodexDialect>([
  ['collaboration', 'v2'],
  ['multi_agent_v1', 'v1'],
]);

export interface CodexLineParse {
  readonly records: readonly CodexRecord[];
  /** Lines that were not a well-formed rollout record. Counted, never thrown. */
  readonly malformedLines: number;
}

/**
 * JSON text (or already-split lines) to records. A blank line is not a record
 * and is not malformed; anything else that is not a C2-shaped object is
 * counted and skipped.
 *
 * The shape check is deliberately a SUBSET of `fingerprint.ts`'s: C2 says a
 * record carries exactly four top-level keys, and a record with a fifth is the
 * fingerprint's `recordShapeMismatch` to refuse on. This function only needs
 * the four to be there and to be the right kinds, because a record without a
 * numeric `ordinal` cannot be placed against the fork boundary at all.
 */
export function parseCodexLines(input: string | readonly string[]): CodexLineParse {
  const lines = typeof input === 'string' ? input.split('\n') : input;
  const records: CodexRecord[] = [];
  let malformedLines = 0;
  for (const raw of lines) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      malformedLines++;
      continue;
    }
    const record = asCodexRecord(value);
    if (record === null) {
      malformedLines++;
      continue;
    }
    records.push(record);
  }
  return { records, malformedLines };
}

/** A parsed JSON value as a {@link CodexRecord}, or `null` when it is not one. */
export function asCodexRecord(value: unknown): CodexRecord | null {
  const object = asObject(value);
  if (object === null) return null;
  const type = object['type'];
  const ordinal = object['ordinal'];
  const timestamp = object['timestamp'];
  if (typeof type !== 'string') return null;
  if (typeof ordinal !== 'number' || !Number.isFinite(ordinal)) return null;
  if (typeof timestamp !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(object, 'payload')) return null;
  return { timestamp, ordinal, type, payload: object['payload'] };
}

// ---------------------------------------------------------------------------
// G4 - ciphertext
// ---------------------------------------------------------------------------

/**
 * Fernet-style ciphertext prefix. Every encrypted string Codex writes begins
 * with it: reasoning content, agent message content, and the v2 spawn and
 * send-message `arguments.message`.
 *
 * A literal prefix rather than a pattern, and matched with `startsWith` /
 * `includes` rather than a RegExp, on purpose. The committed corpus's defining
 * record is a single 554,126-byte line, and a scan pattern with an unanchored
 * leading character class over lines that long is the measured cause of the
 * privacy sweep going from 3 s to 169 s on 2026-09-03.
 */
export const CODEX_CIPHERTEXT_PREFIX = 'gAAAAAB';

/**
 * What replaces a ciphertext string at the boundary. The byte count survives;
 * the bytes do not.
 *
 * It has a second job: {@link CodexSpawn.messageBytes} is read back out of
 * this marker, so the spawn's instruction size is reported without the
 * instruction ever being held anywhere the extractor can see it.
 */
export function ciphertextMarker(bytes: number): string {
  return `[agent-deck: encrypted content dropped, ${bytes} bytes]`;
}

/**
 * Anchored at BOTH ends - the marker is the whole string or it is not a
 * marker. An unanchored leading `.*` here is the quadratic-scan hazard this
 * repository has already paid for once.
 */
const CIPHERTEXT_MARKER_RE = /^\[agent-deck: encrypted content dropped, (\d+) bytes\]$/;

/** The byte count a {@link ciphertextMarker} states, or `null`. Never throws. */
export function readCiphertextMarker(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const match = CIPHERTEXT_MARKER_RE.exec(text);
  if (match === null) return null;
  const bytes = Number(match[1]);
  return Number.isFinite(bytes) ? bytes : null;
}

/** True when the record carries model reasoning (C7). Both taps. */
export function isReasoningRecord(record: CodexRecord): boolean {
  const payload = asObject(record.payload);
  if (payload === null) return false;
  if (record.type === 'response_item' && payload['type'] === 'reasoning') return true;
  if (record.type === 'event_msg') {
    const item = asObject(payload['item']);
    if (item !== null && item['type'] === 'Reasoning') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The redaction walk
// ---------------------------------------------------------------------------

interface WalkState {
  readonly maxPayloadBytes: number;
  ciphertextDropped: number;
  truncated: number;
  depthLimited: number;
}

const DEPTH_MARKER = '[agent-deck: nesting depth limit reached]';

/**
 * Redact one payload: ciphertext out, every string under the byte ceiling,
 * nested-JSON `arguments` descended into rather than treated as opaque.
 *
 * `key` is the property name this value arrived under, and it is what makes
 * the `arguments` descent possible without descending into every string in
 * the transcript - `custom_tool_call.input` is JavaScript source, not JSON,
 * and re-serialising it would change bytes for nothing.
 */
function redactValue(value: unknown, key: string | null, state: WalkState, depth: number): unknown {
  if (depth > MAX_REDACTION_DEPTH) {
    state.depthLimited++;
    return DEPTH_MARKER;
  }
  if (typeof value === 'string') return redactString(value, key, state, depth);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(redactValue(item, key, state, depth + 1));
    return out;
  }
  const object = asObject(value);
  if (object === null) return value;
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(object)) {
    out[name] = redactValue(object[name], name, state, depth + 1);
  }
  return out;
}

function redactString(value: string, key: string | null, state: WalkState, depth: number): string {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (value.startsWith(CODEX_CIPHERTEXT_PREFIX)) {
    state.ciphertextDropped++;
    return ciphertextMarker(bytes);
  }
  // `arguments` is a JSON string, and the v2 dialect puts its spawn
  // instruction inside it. Descend, redact, re-serialise - so `task_name`
  // survives while `message` does not.
  //
  // The container is NOT cut afterwards, deliberately. Every string inside it
  // has already been through the ceiling, and truncating the re-serialised
  // JSON would produce a string that no longer parses - silently destroying
  // `task_name`, the one plaintext label C7 says survives beside the
  // ciphertext.
  if (key === 'arguments') {
    const nested = redactJsonString(value, state, depth);
    if (nested !== null) return nested;
  }
  // The fail-safe leg: a ciphertext string reached under any other shape is
  // dropped whole rather than truncated to a shorter ciphertext.
  if (value.includes(CODEX_CIPHERTEXT_PREFIX)) {
    state.ciphertextDropped++;
    return ciphertextMarker(bytes);
  }
  return cut(value, state);
}

function redactJsonString(text: string, state: WalkState, depth: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const redacted = redactValue(parsed, null, state, depth + 1);
  const serialised = JSON.stringify(redacted);
  return typeof serialised === 'string' ? serialised : null;
}

function cut(value: string, state: WalkState): string {
  const result = truncateUtf8(value, state.maxPayloadBytes);
  if (result.truncated) state.truncated++;
  return result.text;
}

// ---------------------------------------------------------------------------
// C5 - the fork boundary
// ---------------------------------------------------------------------------

/**
 * The boundary a `session_meta` payload states, or `undefined`.
 *
 * ABSENCE IS THE SIGNAL AND IT IS NOT `null`. The key is missing entirely on a
 * `fork_turns: "none"` spawn, so this tests `hasOwnProperty` first and then
 * requires a finite number. A `null` value, a string, a negative number and a
 * missing key all return `undefined`, which means "drop nothing".
 */
export function forkStartOrdinal(sessionMetaPayload: unknown): number | undefined {
  const payload = asObject(sessionMetaPayload);
  if (payload === null) return undefined;
  if (!Object.prototype.hasOwnProperty.call(payload, 'subagent_history_start_ordinal')) return undefined;
  const value = payload['subagent_history_start_ordinal'];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

// ---------------------------------------------------------------------------
// The boundary itself
// ---------------------------------------------------------------------------

export interface CodexRedactionOptions {
  readonly maxPayloadBytes?: number;
  /** C5. `undefined` means nothing is inherited and nothing is dropped. */
  readonly forkStartOrdinal?: number | undefined;
}

export interface CodexRedaction {
  /** The records that survive the boundary. Everything else is built from these. */
  readonly kept: readonly CodexRecord[];
  /** `malformedLines` is 0 here: this function is handed records, not lines. */
  readonly counters: CodexCounters;
  /** Every `response_item` payload type seen, and how many. A diagnostic. */
  readonly responseItemTypes: Readonly<Record<string, number>>;
  /**
   * The NARROWER of the two skip lists: payload types with no entry in
   * {@link CODEX_RESPONSE_ITEM_DISPOSITION} at all, i.e. types this build has
   * never seen. Kept beside {@link CodexCounters.skippedResponseItemTypes},
   * which is the wider one P6 surfaces (declared-and-skipped, plus these).
   * A novel type must appear on BOTH: undeclared is a strictly stronger
   * statement than unhandled, and collapsing them loses it.
   */
  readonly unhandledResponseItemTypes: readonly string[];
  /** Ciphertext strings replaced by {@link ciphertextMarker}. */
  readonly ciphertextStringsDropped: number;
}

/**
 * Apply C5's fork boundary, C2's unknown-type count and C7's reasoning drop,
 * then redact every surviving payload.
 *
 * Order matters and is fixed: inherited first, then unknown, then reasoning.
 * A reasoning record below the boundary is counted ONCE, as inherited -
 * double-counting a single record on two diagnostic fields would make the sum
 * of the counters exceed the records that existed.
 */
export function redactCodexRecords(
  records: readonly CodexRecord[],
  options: CodexRedactionOptions = {},
): CodexRedaction {
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const start = options.forkStartOrdinal;
  const state: WalkState = { maxPayloadBytes, ciphertextDropped: 0, truncated: 0, depthLimited: 0 };

  const kept: CodexRecord[] = [];
  const responseItemTypes: Record<string, number> = {};
  const unhandled = new Set<string>();
  const skipped = new Set<string>();
  let unknownRecordTypes = 0;
  let reasoningDropped = 0;
  let inheritedRecordsDropped = 0;

  for (const record of records) {
    if (start !== undefined && record.ordinal < start) {
      inheritedRecordsDropped++;
      continue;
    }
    if (!CODEX_RECORD_TYPES.has(record.type)) {
      unknownRecordTypes++;
      continue;
    }
    if (record.type === 'response_item') {
      const payload = asObject(record.payload);
      const name = typeof payload?.['type'] === 'string' ? payload['type'] : '(absent)';
      responseItemTypes[name] = (responseItemTypes[name] ?? 0) + 1;
      const disposition = CODEX_RESPONSE_ITEM_DISPOSITION[name];
      // Undeclared and declared-but-skipped are DIFFERENT facts and both are
      // reported. A type with no handler is named either way, so a skip can
      // never be a zero the reader cannot distinguish from an empty corpus.
      if (disposition === undefined) unhandled.add(name);
      if (disposition === undefined || disposition === 'skipped') skipped.add(name);
    }
    if (isReasoningRecord(record)) {
      reasoningDropped++;
      continue;
    }
    kept.push({
      timestamp: record.timestamp,
      ordinal: record.ordinal,
      type: record.type,
      payload: redactValue(record.payload, null, state, 0),
    });
  }

  return {
    kept,
    counters: {
      malformedLines: 0,
      unknownRecordTypes,
      reasoningDropped,
      inheritedRecordsDropped,
      payloadsTruncated: state.truncated,
      skippedResponseItemTypes: [...skipped].sort(),
    },
    responseItemTypes,
    unhandledResponseItemTypes: [...unhandled].sort(),
    ciphertextStringsDropped: state.ciphertextDropped,
  };
}

// ---------------------------------------------------------------------------
// Tool calls and the two id namespaces (C4)
// ---------------------------------------------------------------------------

interface CompletedItem {
  readonly ordinal: number;
  readonly id: string;
  readonly type: string;
  claimed: boolean;
}

interface RawCall {
  readonly ordinal: number;
  readonly kind: CodexToolCall['kind'];
  readonly name: string;
  readonly namespace: CodexOptional<string>;
  readonly callId: string;
  readonly args: Record<string, unknown> | null;
  item: CompletedItem | null;
  relation: CodexIdRelation;
}

/**
 * Pair each call with its completed item, in two legs.
 *
 *   1. KEY JOIN - the item whose `id` equals the `call_id`. This is every
 *      `function_call` in both dialects and the v1 `exec_command`.
 *   2. POSITIONAL - a still-unmatched call claims the first unclaimed item at
 *      a HIGHER ordinal whose id begins `exec-`. This is the v2
 *      `custom_tool_call` named `exec`, whose `call_<...>` and `exec-<uuid>`
 *      have no field linking them.
 *
 * Leg 2 is a corpus-derived heuristic and is LABELLED as one:
 * `item_id_distinct_from_call_id` says the id was paired positionally rather
 * than proved. Anything it cannot pair is `no_item` - reported, never guessed.
 */
function pairCalls(kept: readonly CodexRecord[]): { calls: RawCall[]; items: CompletedItem[] } {
  const items: CompletedItem[] = [];
  const calls: RawCall[] = [];

  for (const record of kept) {
    const payload = asObject(record.payload);
    if (payload === null) continue;
    if (record.type === 'event_msg' && payload['type'] === 'item_completed') {
      const item = asObject(payload['item']);
      items.push({
        ordinal: record.ordinal,
        id: typeof item?.['id'] === 'string' ? item['id'] : '',
        type: typeof item?.['type'] === 'string' ? item['type'] : '',
        claimed: false,
      });
      continue;
    }
    if (record.type !== 'response_item') continue;
    const kind = payload['type'];
    if (typeof kind !== 'string' || !TOOL_CALL_PAYLOAD_TYPES.has(kind)) continue;
    calls.push({
      ordinal: record.ordinal,
      kind: toolCallKind(kind),
      name: typeof payload['name'] === 'string' ? payload['name'] : '',
      namespace: optionalString(payload, 'namespace'),
      callId: typeof payload['call_id'] === 'string' ? payload['call_id'] : '',
      args: parseArguments(payload['arguments']),
      item: null,
      relation: 'no_item',
    });
  }

  const byId = new Map<string, CompletedItem>();
  for (const item of items) if (item.id !== '' && !byId.has(item.id)) byId.set(item.id, item);

  calls.sort((a, b) => a.ordinal - b.ordinal);

  for (const call of calls) {
    const keyed = call.callId === '' ? undefined : byId.get(call.callId);
    if (keyed !== undefined && !keyed.claimed) {
      keyed.claimed = true;
      call.item = keyed;
      call.relation = 'item_id_equals_call_id';
      continue;
    }
    const positional = items.find(
      (item) => !item.claimed && item.ordinal > call.ordinal && item.id.startsWith(EXEC_ITEM_PREFIX),
    );
    if (positional !== undefined) {
      positional.claimed = true;
      call.item = positional;
      call.relation = 'item_id_distinct_from_call_id';
      continue;
    }
    call.item = null;
    call.relation = 'no_item';
  }

  return { calls, items };
}

/** `payload.arguments` as an object, whether it arrived as JSON text or a value. */
function parseArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asObject(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return asObject(value);
}

/** Every call output in this file, keyed by `call_id`. First occurrence wins. */
function collectOutputs(kept: readonly CodexRecord[]): Map<string, unknown> {
  const outputs = new Map<string, unknown>();
  for (const record of kept) {
    if (record.type !== 'response_item') continue;
    const payload = asObject(record.payload);
    if (payload === null) continue;
    const kind = payload['type'];
    if (typeof kind !== 'string' || !TOOL_OUTPUT_PAYLOAD_TYPES.has(kind)) continue;
    const callId = payload['call_id'];
    if (typeof callId !== 'string' || callId === '' || outputs.has(callId)) continue;
    outputs.set(callId, payload['output']);
  }
  return outputs;
}

/**
 * A call output rendered as text, or `null` when there was none.
 *
 * The `custom_tool_call_output` shape is an array of `{type, text}`; the
 * `function_call_output` shape is a bare string. Anything else is serialised.
 */
function renderOutput(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        parts.push(entry);
        continue;
      }
      const object = asObject(entry);
      if (object !== null && typeof object['text'] === 'string') parts.push(object['text']);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  const serialised = JSON.stringify(value);
  return typeof serialised === 'string' ? serialised : null;
}

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

export interface CodexParseOptions {
  /** Basename of the rollout file. Recorded on the thread and on every call. */
  readonly file: string;
  /**
   * `statSync().mtimeMs` - the file's LAST WRITE, an END. Liveness
   * corroboration only, and never a start: the thread's start comes off the
   * `session_meta` record's own timestamp ({@link CodexThread.startedAtMs}).
   * Defaults to 0.
   */
  readonly mtimeMs?: number;
  readonly maxPayloadBytes?: number;
  /** Malformed lines already counted by {@link parseCodexLines}. */
  readonly malformedLines?: number;
}

export interface CodexParseResult {
  /**
   * `null` when the file declares no `session_meta` at all - an undeclared
   * file has no thread to be. The counters are still returned, so a file that
   * produces nothing still says what it saw.
   */
  readonly thread: CodexThread | null;
  readonly counters: CodexCounters;
  readonly responseItemTypes: Readonly<Record<string, number>>;
  readonly unhandledResponseItemTypes: readonly string[];
  readonly ciphertextStringsDropped: number;
  /**
   * The records that survived the boundary, redacted. Exposed so the G4 test
   * can assert on the boundary's OUTPUT rather than on the thread alone: a
   * property that holds only because nothing downstream happens to read a
   * field is the vacuous shape this file exists to avoid.
   */
  readonly kept: readonly CodexRecord[];
}

/** Records for ONE transcript to one {@link CodexThread}. Never throws. */
export function parseCodexThread(
  records: readonly CodexRecord[],
  options: CodexParseOptions,
): CodexParseResult {
  const owner = owningDeclaration(records);
  const start = owner === null ? undefined : forkStartOrdinal(owner.payload);

  const redaction = redactCodexRecords(records, {
    ...(options.maxPayloadBytes === undefined ? {} : { maxPayloadBytes: options.maxPayloadBytes }),
    forkStartOrdinal: start,
  });

  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const kept = redaction.kept;
  const { calls } = pairCalls(kept);
  const outputs = collectOutputs(kept);

  const ownerPayload = owner === null ? null : asObject(owner.payload);
  const threadId = ownerPayload === null ? '' : firstString(ownerPayload, ['id', 'session_id']);

  let previewTruncations = 0;
  const toolCalls: CodexToolCall[] = [];
  const spawns: CodexSpawn[] = [];
  const namespaces = new Set<string>();

  for (const call of calls) {
    if (call.namespace.present && typeof call.namespace.value === 'string') {
      namespaces.add(call.namespace.value);
    }
    const rendered = renderOutput(outputs.get(call.callId));
    const toolCall: {
      -readonly [K in keyof CodexToolCall]: CodexToolCall[K];
    } = {
      threadId,
      file: options.file,
      ordinal: call.ordinal,
      kind: call.kind,
      name: call.name,
      namespace: call.namespace,
      callId: call.callId,
      itemId: call.item === null ? null : call.item.id,
      itemType: call.item === null ? null : call.item.type,
      idRelation: call.relation,
    };
    if (rendered !== null) {
      const wasMarked = splitTruncationMarker(rendered) !== undefined;
      const preview = truncatePreservingMarker(rendered, maxPayloadBytes);
      if (preview.truncated && !wasMarked) previewTruncations++;
      toolCall.outputPreview = preview.text;
      toolCall.outputTruncated = preview.truncated;
    }
    toolCalls.push(toolCall);

    if (call.name === SPAWN_TOOL_NAME) {
      spawns.push(buildSpawn(threadId, options.file, call, rendered));
    }
  }

  const counters: CodexCounters = {
    malformedLines: options.malformedLines ?? 0,
    unknownRecordTypes: redaction.counters.unknownRecordTypes,
    reasoningDropped: redaction.counters.reasoningDropped,
    inheritedRecordsDropped: redaction.counters.inheritedRecordsDropped,
    payloadsTruncated: redaction.counters.payloadsTruncated + previewTruncations,
    skippedResponseItemTypes: redaction.counters.skippedResponseItemTypes,
  };

  const base: Omit<CodexParseResult, 'thread'> = {
    counters,
    responseItemTypes: redaction.responseItemTypes,
    unhandledResponseItemTypes: redaction.unhandledResponseItemTypes,
    ciphertextStringsDropped: redaction.ciphertextStringsDropped,
    kept,
  };

  if (owner === null || ownerPayload === null) return { thread: null, ...base };

  const spawnMeta = subagentSpawn(ownerPayload);
  const dialect = resolveDialect(kept, ownerPayload, namespaces);
  const usage = readUsage(kept);

  const thread: {
    -readonly [K in keyof CodexThread]: CodexThread[K];
  } = {
    threadId,
    sessionId: typeof ownerPayload['session_id'] === 'string' ? ownerPayload['session_id'] : threadId,
    owningFile: options.file,
    cwd: typeof ownerPayload['cwd'] === 'string' ? ownerPayload['cwd'] : '',
    cliVersion: typeof ownerPayload['cli_version'] === 'string' ? ownerPayload['cli_version'] : '',
    threadSource: typeof ownerPayload['thread_source'] === 'string' ? ownerPayload['thread_source'] : '',
    originator: typeof ownerPayload['originator'] === 'string' ? ownerPayload['originator'] : null,
    dialect: dialect.dialect,
    dialectSource: dialect.source,
    multiAgentVersion: optionalString(ownerPayload, 'multi_agent_version'),
    agentPath: optionalString(ownerPayload, 'agent_path'),
    agentNickname: optionalString(ownerPayload, 'agent_nickname'),
    parentThreadId: optionalString(ownerPayload, 'parent_thread_id'),
    spawnDepth: optionalNumber(spawnMeta, 'depth'),
    subagentHistoryStartOrdinal: optionalNumber(ownerPayload, 'subagent_history_start_ordinal'),
    forkedFromId: optionalString(ownerPayload, 'forked_from_id'),
    inheritedRecordsBeforeForkStart: redaction.counters.inheritedRecordsDropped,
    toolCalls,
    spawns,
    counters,
    records: records.length,
    startedAtMs: startedAtMs(owner),
    mtimeMs: options.mtimeMs ?? 0,
  };
  if (usage.modelContextWindow !== undefined) thread.modelContextWindow = usage.modelContextWindow;
  if (usage.contextNow !== undefined) thread.contextNow = usage.contextNow;
  if (usage.burn !== undefined) thread.burn = usage.burn;

  return { thread, ...base };
}

/** Text of one transcript to one thread, counting malformed lines on the way. */
export function parseCodexTranscript(
  text: string | readonly string[],
  options: CodexParseOptions,
): CodexParseResult {
  const lines = parseCodexLines(text);
  return parseCodexThread(lines.records, { ...options, malformedLines: lines.malformedLines });
}

/**
 * When the thread started: the OWNING `session_meta` record's own envelope
 * `timestamp`, as epoch milliseconds.
 *
 * The ENVELOPE timestamp, not `payload.timestamp` - they differ. On the
 * corpus's baseline root the envelope says `20:43:54.630Z` and the payload
 * says `20:43:54.496Z`, 134 ms apart. The envelope is the record's own time
 * and is the one every other record in the file is keyed on.
 *
 * For a forked child this is the CHILD's start, because the owning
 * declaration is the lowest-ordinal `session_meta` and a child's own
 * declaration sits at ordinal 0 with its parent's re-serialised above it.
 *
 * **It is emphatically not `mtimeMs`.** That is the file's last write - an
 * end used as a start, differing by 40 s on the baseline root and by a whole
 * session's duration on a long one. `types.ts` records that this field exists
 * because the grafter was about to default to exactly that.
 *
 * An unparseable or absent timestamp yields 0, which renders as 1970 and is
 * therefore visibly wrong. That is deliberate: the alternative is a PLAUSIBLE
 * wrong date, which is the defect this field was added to remove. It cannot
 * be reached from a fingerprint-accepted thread - C2 requires the timestamp
 * and `asCodexRecord` refuses a record without one.
 */
function startedAtMs(owner: CodexRecord): number {
  const parsed = Date.parse(owner.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The declaration that OWNS the file: the `session_meta` at the lowest
 * ordinal. A forked child re-serialises its parent's `session_meta` into its
 * own file, so a rollout carries more than one and the rest are inherited.
 */
function owningDeclaration(records: readonly CodexRecord[]): CodexRecord | null {
  let owner: CodexRecord | null = null;
  for (const record of records) {
    if (record.type !== 'session_meta') continue;
    if (owner === null || record.ordinal < owner.ordinal) owner = record;
  }
  return owner;
}

/** `source.subagent.thread_spawn`, or `null`. Where v1 states its nulls. */
function subagentSpawn(payload: Record<string, unknown>): Record<string, unknown> | null {
  const source = asObject(payload['source']);
  if (source === null) return null;
  const subagent = asObject(source['subagent']);
  if (subagent === null) return null;
  return asObject(subagent['thread_spawn']);
}

// ---------------------------------------------------------------------------
// Spawns (C4a, C7)
// ---------------------------------------------------------------------------

function buildSpawn(
  threadId: string,
  file: string,
  call: RawCall,
  renderedOutput: string | null,
): CodexSpawn {
  const args = call.args;
  const message = args === null ? undefined : args['message'];
  const encryptedBytes = readCiphertextMarker(message);

  const parsed = parseOutputObject(renderedOutput);
  const refused = renderedOutput !== null && parsed === null;

  return {
    threadId,
    file,
    ordinal: call.ordinal,
    callId: call.callId,
    itemId: call.item === null ? null : call.item.id,
    namespace: call.namespace,
    requestedTaskName: args !== null && typeof args['task_name'] === 'string' ? args['task_name'] : null,
    outputTaskName: parsed !== null && typeof parsed['task_name'] === 'string' ? parsed['task_name'] : null,
    outputAgentId: parsed !== null && typeof parsed['agent_id'] === 'string' ? parsed['agent_id'] : null,
    outputNickname: parsed !== null && typeof parsed['nickname'] === 'string' ? parsed['nickname'] : null,
    // NOT this module's join - see the header. Both keys are above.
    childThreadId: null,
    childResolvedBy: 'unresolved',
    refused,
    refusalText: refused ? renderedOutput : null,
    messagePresent: typeof message === 'string',
    messageEncrypted: encryptedBytes !== null,
    messageBytes: messageBytes(message, encryptedBytes),
  };
}

/**
 * The instruction's size WITHOUT the instruction.
 *
 * Three cases, and none of them holds the bytes: a v2 message is already a
 * {@link ciphertextMarker} and states its own original size; a v1 plaintext
 * message long enough to have been cut carries a truncation marker that states
 * its original size; anything shorter is measured where it stands. The string
 * itself is never copied onto the spawn.
 */
function messageBytes(message: unknown, encryptedBytes: number | null): number {
  if (encryptedBytes !== null) return encryptedBytes;
  if (typeof message !== 'string') return 0;
  const existing = splitTruncationMarker(message);
  if (existing !== undefined) return existing.originalBytes;
  return Buffer.byteLength(message, 'utf8');
}

/**
 * A spawn output as an object, or `null`.
 *
 * `null` is the REFUSAL signal, and it is not an error: the engine enforces
 * `agent_path` uniqueness and answers a duplicate with a bare English string -
 * "agent path `/root/dup` already exists" - rather than with JSON. DoD 2.4
 * renders that as a failed call, not as a parked node.
 */
function parseOutputObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    return asObject(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// C3a - the dialect, read from the session rather than inferred from a model
// ---------------------------------------------------------------------------

interface ResolvedDialect {
  readonly dialect: CodexDialect | null;
  readonly source: CodexDialectSource | null;
}

/**
 * Precedence, and the SOURCE is recorded so a reader can see which one decided
 * rather than trusting a comment:
 *
 *   1. `turn_context.multi_agent_version` - present on every turn_context
 *      record of every run in the committed corpus, including the run that
 *      spawns nothing and therefore has no namespace to infer from.
 *   2. `session_meta.multi_agent_version` - subagent declarations only.
 *   3. the spawn namespace - corroboration, last resort.
 *
 * Disagreement inside a level resolves to `null`, never to a guess. C3a calls
 * a contradiction "an error, not a tiebreak"; refusing on it is
 * `fingerprint.ts`'s `dialectContradiction`, and reporting `null` here is what
 * lets it.
 */
function resolveDialect(
  kept: readonly CodexRecord[],
  ownerPayload: Record<string, unknown>,
  namespaces: ReadonlySet<string>,
): ResolvedDialect {
  const fromTurnContext = new Set<string>();
  for (const record of kept) {
    if (record.type !== 'turn_context') continue;
    const payload = asObject(record.payload);
    const value = payload?.['multi_agent_version'];
    if (typeof value === 'string') fromTurnContext.add(value);
  }
  const one = soleDialect(fromTurnContext);
  if (one !== null) return { dialect: one, source: 'turn_context.multi_agent_version' };

  const declared = ownerPayload['multi_agent_version'];
  const fromMeta = soleDialect(new Set(typeof declared === 'string' ? [declared] : []));
  if (fromMeta !== null) return { dialect: fromMeta, source: 'session_meta.multi_agent_version' };

  const fromNamespace = new Set<CodexDialect>();
  for (const namespace of namespaces) {
    const mapped = DIALECT_BY_NAMESPACE.get(namespace);
    if (mapped !== undefined) fromNamespace.add(mapped);
  }
  if (fromNamespace.size === 1) {
    const only = [...fromNamespace][0];
    if (only !== undefined) return { dialect: only, source: 'spawn_namespace' };
  }
  return { dialect: null, source: null };
}

function soleDialect(values: ReadonlySet<string>): CodexDialect | null {
  const kept = [...values].filter((value): value is CodexDialect => value === 'v1' || value === 'v2');
  return kept.length === 1 ? (kept[0] ?? null) : null;
}

// ---------------------------------------------------------------------------
// C8 - tokens
// ---------------------------------------------------------------------------

interface Usage {
  readonly contextNow?: TokenPair;
  readonly burn?: TokenPair;
  readonly modelContextWindow?: number;
}

/**
 * The LAST `event_msg` `token_count` of the thread supplies both figures:
 * `last_token_usage` is the level (Context) and `total_token_usage` the
 * running total (Burn).
 *
 * `prompt` is `input_tokens` ALONE, and that is a measurement rather than a
 * transcription of the Claude Code rule. On Claude Code `input_tokens` is ~2
 * and the prompt lives in the two cache fields, so they are summed. Here
 * `input_tokens` is already cache-inclusive: across the committed corpus,
 * 116 of 116 usage objects satisfy
 * `total_tokens === input_tokens + output_tokens`, and 0 of 116 satisfy the
 * Claude Code sum. Adding `cached_input_tokens` would double-count.
 *
 * A thread with no `token_count` record leaves every field ABSENT.
 * `modelContextWindow` is `undefined` when the transcript states none, never
 * `0`: PLAN's answered question says burn shows an em dash when the contract
 * says absent, and a zero here would be a wrong number rather than a missing
 * one.
 */
function readUsage(kept: readonly CodexRecord[]): Usage {
  let contextNow: TokenPair | undefined;
  let burn: TokenPair | undefined;
  let window: number | undefined;

  for (const record of kept) {
    if (record.type !== 'event_msg') continue;
    const payload = asObject(record.payload);
    if (payload === null || payload['type'] !== 'token_count') continue;
    const info = asObject(payload['info']);
    if (info === null) continue;
    const last = tokenPair(info['last_token_usage']);
    const total = tokenPair(info['total_token_usage']);
    if (last !== null) contextNow = last;
    if (total !== null) burn = total;
    const stated = info['model_context_window'];
    if (typeof stated === 'number' && Number.isFinite(stated) && stated > 0) window = stated;
  }

  const usage: { contextNow?: TokenPair; burn?: TokenPair; modelContextWindow?: number } = {};
  if (contextNow !== undefined) usage.contextNow = contextNow;
  if (burn !== undefined) usage.burn = burn;
  if (window !== undefined) usage.modelContextWindow = window;
  return usage;
}

function tokenPair(value: unknown): TokenPair | null {
  const object = asObject(value);
  if (object === null) return null;
  const prompt = object['input_tokens'];
  const output = object['output_tokens'];
  if (typeof prompt !== 'number' || !Number.isFinite(prompt)) return null;
  if (typeof output !== 'number' || !Number.isFinite(output)) return null;
  return { prompt, output };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstString(object: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/**
 * `{present, value}` for a string-valued key.
 *
 * PRESENT-AND-NULL IS NOT ABSENT. A v1 subagent's nested `agent_path` is a
 * JSON `null` while a user thread has no such key at all; collapsing the two
 * renders a v1 subagent as though Codex had said the path was empty, which is
 * how the whole dialect was nearly parked.
 */
function optionalString(container: Record<string, unknown> | null, key: string): CodexOptional<string> {
  if (container === null || !Object.prototype.hasOwnProperty.call(container, key)) {
    return { present: false, value: null };
  }
  const value = container[key];
  return { present: true, value: typeof value === 'string' ? value : null };
}

function optionalNumber(container: Record<string, unknown> | null, key: string): CodexOptional<number> {
  if (container === null || !Object.prototype.hasOwnProperty.call(container, key)) {
    return { present: false, value: null };
  }
  const value = container[key];
  return { present: true, value: typeof value === 'number' && Number.isFinite(value) ? value : null };
}
