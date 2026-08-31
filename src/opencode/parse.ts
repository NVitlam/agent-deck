/**
 * Agent Deck — the OpenCode engine's parse + redact boundary (PLAN.md DoD 4.3).
 *
 * `OcPartRow[]` in, `OcParseResult` out. Every byte OpenCode stored in the
 * `part` table passes through here, and this is the LAST place a `reasoning`
 * part exists: it is read off disk, counted, and thrown away before any record
 * is constructed (G4 / OC6).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE MAY AND MAY NOT DO
 * ---------------------------------------------------------------------------
 *
 * No I/O. `db.ts` reads the rows; this file is a pure function of them, which
 * is what lets the tests build a malformed row, a `running` tool part or a
 * `signature`-bearing input by hand — none of which exists in either committed
 * corpus (`fixtures/opencode-1.18.22/GOLDEN.md`, "Measured gaps").
 *
 * It imports the truncation ceiling from `../parser/redact.js` rather than
 * restating it. OC6: tool payloads "go through the existing `redact.ts`
 * ceiling" — ONE redaction module, two engines. A second copy of 8,192 and of
 * the marker text is a second thing that can drift.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CUT HAPPENS EXACTLY ONCE
 * ---------------------------------------------------------------------------
 *
 * The recorded defect on the Claude Code side is a payload cut twice — once by
 * the parser, again by a preview — producing a marker that states the
 * INTERMEDIATE length as the original, under-reporting the largest committed CC
 * payload by 7.73x. So the ceiling is applied here, once, to the raw stored
 * payload, and nothing downstream cuts again. The anchor's largest tool output
 * is 88,478 UTF-8 bytes and its marker reads `showing 8192 of 88478 bytes`.
 *
 * `truncatePreservingMarker` is deliberately NOT used: it exists for the CC
 * path where a payload may already carry a marker from an earlier stage, and it
 * cuts with one original size while marking with another. Here there is no
 * earlier stage.
 *
 * ---------------------------------------------------------------------------
 * RELATIONSHIP TO `scripts/opencode-golden.mjs`
 * ---------------------------------------------------------------------------
 *
 * That script is the reference implementation of this mapping and the source of
 * the committed `golden.json` files, which Phase 4 must reproduce through the
 * production path (DoD 3.4 / 4.6). It is deliberately NOT imported: it depends
 * on `node:` builtins only, and an engine that imported it would make the
 * goldens prove that a function agrees with itself. The duplication is the
 * proof. Where this file knowingly departs from it, the departure is written at
 * the decision — see {@link parseParts}'s notes on non-object `data` and on a
 * `tool` part missing its join keys.
 *
 * **THE ENGINE SKIPS WHERE THE GENERATOR ABORTS, AND THAT IS NOT AN OVERSIGHT.**
 * The generator is a build-time script run by a human who reads the error and
 * re-harvests, so aborting on an unrepresentable row is the correct answer
 * there, and `fixtures/opencode-1.18.22/GOLDEN.md`'s "reported by the caller,
 * which aborts" is a statement about it. This module runs inside a
 * long-running observer, where G3 is law — "malformed lines increment a counter
 * and are skipped; never crash on input" — because one unrecognised
 * `state.status` throwing would darken every session in the database. The half
 * of the rule that does NOT change is the guessing: an unmeasured status is
 * still never coerced into one of the three. Do not "fix" this back into a
 * throw.
 */

import { DEFAULT_MAX_PAYLOAD_BYTES, truncateUtf8 } from '../parser/redact.js';

import type { OcParseCounts, OcParseResult, OcPartRow, OcToolRecord } from './types.js';

// ---------------------------------------------------------------------------
// Redaction policy (G4 / OC6)
// ---------------------------------------------------------------------------

/**
 * Fields stripped wherever they appear, at any depth, in any part payload that
 * survives to become a record.
 *
 * BY FIELD POLICY, NOT BY OBSERVATION. OC6: "the measured provider
 * (`qwen-local`) writes no `signature`; another may (contract §4), and a
 * redaction rule that only covers what one provider happened to emit is not a
 * rule." Neither committed corpus can exercise this set inside a `tool` part —
 * `src/opencode/parse.test.ts` builds a synthetic one that does.
 *
 * `../parser/redact.js` has `DROPPED_BLOCK_FIELDS` (`thinking`, `signature`)
 * for the CC content-block shape. This set is a third name — `redacted_thinking`
 * — wider, and applied to arbitrary JSON rather than to a block, so it is
 * stated here rather than borrowed and quietly diverging.
 */
export const OC_DROPPED_FIELDS: ReadonlySet<string> = new Set([
  'signature',
  'thinking',
  'redacted_thinking',
]);

/**
 * Part types dropped whole at the parse boundary, before a record exists.
 *
 * OC6: "`reasoning` parts are dropped at the parse boundary, before any record
 * reaches the session model". For OpenCode the thinking bytes are plainly
 * present in `part.data.text` — the inverse of the CC trap where the text is
 * empty on disk and the bytes sit in `signature`. The anchor's longest
 * reasoning part is 36,716 characters.
 */
export const OC_DROPPED_PART_TYPES: ReadonlySet<string> = new Set(['reasoning']);

/** Recursively strip {@link OC_DROPPED_FIELDS}. Returns a new value. */
export function stripDroppedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => stripDroppedFields(v));
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (OC_DROPPED_FIELDS.has(key)) continue;
    out[key] = stripDroppedFields(source[key]);
  }
  return out;
}

/**
 * Canonical JSON with SORTED keys.
 *
 * `state.input` is an object and a preview has to be a string. Key order in the
 * stored JSON is OpenCode's business and could move between releases without
 * the content changing, so the preview sorts. Byte-identical to `canonicalJson`
 * in `scripts/opencode-golden.mjs`, which is what the committed goldens'
 * preview digests were computed from.
 *
 * The `?? 'null'` is not decorative: `JSON.stringify(undefined)` returns
 * `undefined`, not a string.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(source[k])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Unusable tool parts — counted and skipped, never guessed and never thrown
// ---------------------------------------------------------------------------

/**
 * Why one `tool` part produced no record.
 *
 * Neither case invents a value: an unmeasured `state.status` is not coerced
 * into one of the three, and a missing `callID` is not replaced by the row id.
 * Both are SKIPPED and counted, so one unrepresentable row costs exactly that
 * row — its neighbours in the same batch still parse, and the session still
 * renders. See the module doc for why this differs from the generator.
 */
export type OcToolPartSkipCode =
  /** `state.status` is outside the measured `running`/`completed`/`error`. */
  | 'unknownStatus'
  /** `callID` or `tool` is not a non-empty string, so the record has no key. */
  | 'unusable';

/**
 * `part.data.state.status` -> `ToolNode.status`.
 *
 * Contract §4 measures exactly three values in the live database: `running`,
 * `completed`, `error`, and `ToolNode.status` (`src/model/events.ts`) is
 * `'running' | 'done' | 'error'`. One to one, with `completed` renamed to the
 * model's `done`.
 *
 * Anything else returns `undefined`, and the caller counts the part as
 * `toolPartsUnknownStatus` and skips it. Measured: the anchor holds 219
 * `completed` + 27 `error` and ZERO `running`, so the `running` arm has no
 * fixture and is pinned synthetically.
 */
export function toolStatus(status: unknown): OcToolRecord['status'] | undefined {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'done';
  if (status === 'error') return 'error';
  return undefined;
}

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

/**
 * {@link parseParts}'s return value: an `OcParseResult` plus the two skip
 * counters, which are DELIBERATELY NOT inside `counts`.
 *
 * `OcParseCounts` (`./types.js`) is the key set `golden.json`'s `counts` block
 * carries, and DoD 4.6 compares that block byte for byte — an extra key in it
 * would fail the reproduction even at 0. `partsMalformed` in particular keeps
 * meaning exactly "the `data` column did not parse as JSON" and nothing is
 * folded into it. Putting these two beside `counts` rather than in it also
 * means a grafter that builds `OcCounts` by spreading `result.counts` cannot
 * leak them into the golden by accident.
 *
 * Both are **0 on both committed corpora**: every one of the 246 + 99 tool
 * parts carries a measured status and both join keys.
 */
export interface OcParseOutcome extends OcParseResult {
  /** `tool` parts skipped for a missing `callID`/`tool` (`'unusable'`). */
  readonly toolPartsUnusable: number;
  /** `tool` parts skipped for an unrecognised `state.status`. */
  readonly toolPartsUnknownStatus: number;
}

/** Options for {@link parseParts}. */
export interface OcParseOptions {
  /**
   * The truncation ceiling, in bytes. Defaults to `DEFAULT_MAX_PAYLOAD_BYTES`
   * (8,192) from `../parser/redact.js`, which is the number the committed
   * goldens were generated at (`golden.json`'s `previewBytes`).
   *
   * Exposed so a test can cut a small payload without carrying an 8 KB string;
   * production passes nothing.
   */
  readonly maxPayloadBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Build the {@link OcToolRecord} for one `tool` part.
 *
 * `id` is `data.callID`, NOT the `prt_*` row id: `ToolNode.id` is documented as
 * "the graft key", and `callID` is a join key OpenCode itself uses — its plugin
 * API's `tool.execute.before`/`after` carry `sessionID` and `callID` (contract
 * amendment §D). The row id travels separately as `partId`, because a parked
 * part has no other identity (OC3).
 *
 * Returns the skip code instead of a record when the part cannot be
 * represented. It never throws on input (G3).
 */
function toToolRecord(
  row: OcPartRow,
  data: Record<string, unknown>,
  maxPayloadBytes: number,
  counts: OcParseCounts,
): OcToolRecord | OcToolPartSkipCode {
  const state = isRecord(data['state']) ? data['state'] : {};

  // An unmeasured status is NOT guessed into one of the three — a silent
  // default renders a wrong tree. It is dropped, and counted.
  const status = toolStatus(state['status']);
  if (status === undefined) return 'unknownStatus';

  /*
   * DEPARTURE from `scripts/opencode-golden.mjs`, stated at the decision.
   *
   * The generator writes `id: data.callID` unconditionally, so a part without
   * one would produce a node whose id is `undefined` — a tool that can never be
   * grafted and never matched, rendered as if it were fine. `OcToolRecord.id`
   * and `.toolName` are typed `string`, and the honest way to satisfy that type
   * is to drop the row rather than to invent an id. Unreachable from both
   * corpora (246 + 99 tool parts, every one carrying both), so the two
   * implementations cannot disagree on any committed row and the goldens are
   * unaffected.
   */
  const id = nonEmptyString(data['callID']);
  const toolName = nonEmptyString(data['tool']);
  if (id === undefined || toolName === undefined) return 'unusable';

  // `state.input` is an object; its preview is canonical JSON, cut ONCE.
  const inputCut = truncateUtf8(
    canonicalJson(stripDroppedFields(state['input'] ?? null)),
    maxPayloadBytes,
  );

  /*
   * `resultPreview` source, in order:
   *   1. `state.output` — a string, present once completed (contract §4).
   *   2. `state.error`  — a string, measured on all 27 anchor error parts,
   *      which carry no `output` at all. Mapping the failure text to the result
   *      preview is the direct analogue of a CC error `tool_result`.
   *   3. neither — the preview is OMITTED (a `running` tool has no result).
   *
   * `state.error` is redacted through the same `stripDroppedFields` policy only
   * where it is structured; here both sources are plain strings, so there is
   * nothing to strip and the string is cut as-is — the same thing the generator
   * does.
   */
  const outputText =
    typeof state['output'] === 'string'
      ? state['output']
      : typeof state['error'] === 'string'
        ? state['error']
        : undefined;
  const outputCut = outputText === undefined ? undefined : truncateUtf8(outputText, maxPayloadBytes);

  const time = isRecord(state['time']) ? state['time'] : {};
  const start = time['start'];
  const end = time['end'];
  const durationMs =
    typeof start === 'number' && typeof end === 'number' ? end - start : undefined;

  /*
   * The two task join keys use DIFFERENT predicates, matching
   * `scripts/opencode-golden.mjs`'s `toToolNode` line for line:
   *
   *   _taskChildSessionId: ... typeof state.metadata?.sessionId === 'string'
   *                            && state.metadata.sessionId ? ... : undefined
   *   _taskParentSessionId: ... typeof state.metadata?.parentSessionId === 'string'
   *                            ? ... : undefined
   *
   * The child key is non-empty-checked because its ABSENCE is the whole
   * `taskWithoutChild` signal (OC3: 9 of the anchor's 29 task parts carry no
   * `state.metadata.sessionId`, and the grafter parks them). The parent key
   * takes any string, including `''`, because the reference does and a
   * predicate stricter than the reference's is a divergence waiting for the
   * first empty string to expose it. Measured: 0 empty-string values of either
   * key in both corpora, so no committed byte moves either way.
   */
  const metadata = isRecord(state['metadata']) ? state['metadata'] : {};

  /*
   * `state.metadata.truncated` — OPENCODE'S OWN truncation claim (contract
   * §8.4, "the flag to trust"). Dropped silently through Phase 4 and recorded
   * as `docs/evidence/phase-4/COVERAGE.md` item 22 / `GOLDEN.md` DEVIATION 5;
   * `ToolNode` gained a field for it at `PLAN.md`'s Phase 5 gate (B7).
   *
   * CARRIED VERBATIM, ALL THREE STATES. `true` and `false` are both claims and
   * both are kept; an absent key is no claim and the field is OMITTED, never
   * defaulted to `false`. Defaulting would turn "OpenCode said nothing" into
   * "OpenCode said the payload is whole", which is the exact information loss
   * this item exists to close, inverted.
   *
   * A value that is not a boolean is treated as NO CLAIM: it is not coerced,
   * for the same reason an unmeasured `state.status` is not coerced into one of
   * the three. It is not counted either — a new key in `counts` would fail DoD
   * 4.6's byte comparison of the goldens' `counts` block even at 0. Measured:
   * zero non-boolean values across both corpora, so no committed byte depends
   * on this arm.
   *
   * NOT the same claim as `inputTruncated`/`resultTruncated` below, which
   * record whether OUR ceiling fired. Ours is recoverable by raising
   * `agentDeck.previewBytes`; this one is not, and a renderer that shows one
   * marker for both lies to the user.
   */
  const engineTruncated =
    typeof metadata['truncated'] === 'boolean' ? metadata['truncated'] : undefined;

  const isTask = toolName === 'task';
  const taskChildSessionId = isTask ? nonEmptyString(metadata['sessionId']) : undefined;
  const parentValue = metadata['parentSessionId'];
  const taskParentSessionId =
    isTask && typeof parentValue === 'string' ? parentValue : undefined;

  /*
   * Counted from the CUT itself, never sniffed out of the text: a payload whose
   * own content ends in marker-shaped bytes must not be miscounted as truncated
   * (the recorded `splitTruncationMarker` hazard in `redact.ts`).
   */
  const inputTruncated = inputCut.truncated;
  const resultTruncated = outputCut !== undefined && outputCut.truncated;
  if (inputTruncated) counts.previewsTruncated++;
  if (resultTruncated) counts.previewsTruncated++;

  return {
    id,
    toolName,
    status,
    inputPreview: inputCut.text,
    ...(outputCut === undefined ? {} : { resultPreview: outputCut.text }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(engineTruncated === undefined ? {} : { truncated: engineTruncated }),
    partId: row.id,
    sessionId: row.sessionId,
    order: [row.timeCreated, row.id],
    ...(taskChildSessionId === undefined ? {} : { taskChildSessionId }),
    ...(taskParentSessionId === undefined ? {} : { taskParentSessionId }),
    inputTruncated,
    resultTruncated,
  };
}

/**
 * Rows -> typed records (DoD 4.3).
 *
 * The classification, in order, and every arm has a counter:
 *
 * 1. `data` does not parse as JSON — `partsMalformed++`, skipped, never thrown
 *    (G3). It is 0 in both committed corpora, so the branch is pinned by a
 *    synthetic row rather than by a fixture.
 * 2. `reasoning` — `reasoningPartsDropped++` and the payload is dropped HERE,
 *    before any record exists (G4 / OC6). Anchor 167, witness 65.
 * 3. any other non-`tool` type — `partsIgnoredNoNode++`. `text`, `step-start`,
 *    `step-finish`, `patch` and `compaction` have no counterpart in
 *    `AgentNode`/`ToolNode`, so they are IGNORED, never refused: the CC
 *    unknown-field rule applied to part types (OC2). In particular the
 *    `compaction` part with `tail_start_id` lands here, and its presence must
 *    not change the tree and must not refuse the session.
 * 4. `tool` with an unrecognised `state.status` — `toolPartsUnknownStatus++`,
 *    skipped. 0 in both corpora; pinned by a synthetic row.
 * 5. `tool` with no usable `callID`/`tool` — `toolPartsUnusable++`, skipped.
 *    0 in both corpora; pinned by a synthetic row.
 * 6. `tool` — one {@link OcToolRecord}; `toolParts++`, and `taskParts++` when
 *    `data.tool === 'task'`. `toolParts` counts records PRODUCED, which is what
 *    `golden.json`'s `counts.toolParts` means, so 4 and 5 do not inflate it.
 *
 * DEPARTURE from `scripts/opencode-golden.mjs`: a `data` column that parses to
 * a non-object (`null`, `7`, `"text"`, `[]`) counts as `partsMalformed` here.
 * The generator would read `.type` off it and raise a `TypeError` on `null`,
 * which is a crash on input and G3 forbids it. Both corpora parse every row to
 * an object, so the two cannot disagree on a committed row.
 *
 * **This function never throws on input.** Every arm above increments a counter
 * and continues, so one unrepresentable row costs that row and nothing else —
 * the rows around it in the same batch still parse.
 */
export function parseParts(
  rows: readonly OcPartRow[],
  options: OcParseOptions = {},
): OcParseOutcome {
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;

  const counts: OcParseCounts = {
    partRows: rows.length,
    partsMalformed: 0,
    reasoningPartsDropped: 0,
    partsIgnoredNoNode: 0,
    toolParts: 0,
    taskParts: 0,
    previewsTruncated: 0,
  };

  const toolsBySession = new Map<string, OcToolRecord[]>();
  let toolPartsUnusable = 0;
  let toolPartsUnknownStatus = 0;

  for (const row of rows) {
    let data: unknown;
    try {
      data = JSON.parse(row.data);
    } catch {
      counts.partsMalformed++;
      continue;
    }
    if (!isRecord(data)) {
      counts.partsMalformed++;
      continue;
    }

    const type = data['type'];
    if (typeof type === 'string' && OC_DROPPED_PART_TYPES.has(type)) {
      // The bytes are read off disk and thrown away right here. This is a real
      // code path with a counter, not an omission by oversight.
      counts.reasoningPartsDropped++;
      continue;
    }
    if (type !== 'tool') {
      counts.partsIgnoredNoNode++;
      continue;
    }

    const record = toToolRecord(row, data, maxPayloadBytes, counts);
    if (record === 'unknownStatus') {
      toolPartsUnknownStatus++;
      continue;
    }
    if (record === 'unusable') {
      toolPartsUnusable++;
      continue;
    }

    counts.toolParts++;
    if (record.toolName === 'task') counts.taskParts++;

    const list = toolsBySession.get(row.sessionId);
    if (list === undefined) toolsBySession.set(row.sessionId, [record]);
    else list.push(record);
  }

  return { toolsBySession, counts, toolPartsUnusable, toolPartsUnknownStatus };
}
