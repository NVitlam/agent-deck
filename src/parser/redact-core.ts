/**
 * Agent Deck — the redaction WALK, with no filesystem in its closure.
 *
 * SPLIT OUT OF `redact.ts` IN v0.7.0 PHASE 1b, FOR ONE REASON. The hook
 * listener now redacts every payload before relaying it to another window
 * (DoD 1b.3), so it imports the redactor — and `redact.ts` imports
 * `node:fs/promises`, because the offloaded-tool-result reader lives there.
 * `listener.test.ts` asserts the listener's import census, and G1's claim for
 * that module is that it can reach no filesystem API at all. The choice was
 * between weakening that claim, exempting the new import from the census, and
 * making the claim TRUE by moving the part with no filesystem in it. Only the
 * third leaves the guard meaning what it says.
 *
 * A SECOND REDACTOR WAS NEVER AN OPTION. This repository's rule is that two
 * implementations of one rule are two places for the first one's rules to stop
 * being true, so nothing is copied here: `redact.ts` re-exports every symbol
 * below, and every existing call site keeps importing it from where it always
 * did.
 *
 * Nothing in this file opens, names or resolves a path.
 */

import { Buffer } from 'node:buffer';

import type { JsonValue } from '../model/events.js';

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/**
 * 8 KB. Configurable per call; this is the default the DoD names.
 *
 * It has a SECOND job, and lowering it does more than shorten a default:
 * `model/graft.ts` aliases this constant as `MIN_PARSE_CEILING_BYTES`, the
 * floor under the ceiling the grafter hands this layer. Below ~2,186 bytes the
 * `<persisted-output>` stub is cut before its closing tag and the whole G4
 * offload path silently stops running. The coupling is guarded rather than
 * merely written down: `graft.test.ts` measures the largest stub in the
 * capture and asserts the floor exceeds it, so a lowered default fails a test
 * instead of quietly disabling hydration.
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024;

/**
 * Guard against unbounded recursion on hostile or pathological input. A value
 * nested deeper than this is replaced by {@link DEPTH_LIMIT_MARKER} rather than
 * blowing the stack (G3).
 */
export const MAX_REDACTION_DEPTH = 64;

export const DEPTH_LIMIT_MARKER = '[agent-deck: nesting depth limit reached]';

/**
 * Marker appended to a truncated string. It states the original size in bytes
 * so truncation is visible and quantified rather than silent.
 *
 * The marker is our annotation, not payload: the kept payload is exactly
 * `maxBytes` bytes and the marker sits after it. Callers sizing a buffer should
 * budget for marker length on top.
 */
export function truncationMarker(keptBytes: number, originalBytes: number): string {
  return `\n...[agent-deck: truncated, showing ${keptBytes} of ${originalBytes} bytes]`;
}

/** Matches any marker produced by {@link truncationMarker}. */
export const TRUNCATION_MARKER_RE =
  /\n\.\.\.\[agent-deck: truncated, showing (\d+) of (\d+) bytes\]$/;

export interface TruncationResult {
  /** The kept prefix, plus the marker when `truncated` is true. */
  text: string;
  truncated: boolean;
  /** Size of the input in UTF-8 bytes. */
  originalBytes: number;
  /** Bytes of payload kept (excludes the marker). */
  keptBytes: number;
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes.
 *
 * Byte-exact, not character-exact: the cut is made in the encoded buffer and
 * then walked back to the nearest code-point boundary, so a multi-byte sequence
 * is never split. A lone continuation byte can therefore never appear at the
 * end of the kept prefix.
 */
export function truncateUtf8(text: string, maxBytes: number = DEFAULT_MAX_PAYLOAD_BYTES): TruncationResult {
  const cut = cutToBytes(text, maxBytes);
  if (!cut.truncated) {
    return { text, truncated: false, originalBytes: cut.originalBytes, keptBytes: cut.keptBytes };
  }
  return {
    text: cut.kept + truncationMarker(cut.keptBytes, cut.originalBytes),
    truncated: true,
    originalBytes: cut.originalBytes,
    keptBytes: cut.keptBytes,
  };
}

interface Cut {
  /** The kept prefix. No marker: marking is the caller's decision. */
  kept: string;
  keptBytes: number;
  originalBytes: number;
  truncated: boolean;
}

/**
 * The cut itself, with no marker attached.
 *
 * Split out from {@link truncateUtf8} because {@link truncatePreservingMarker}
 * needs to cut with one original size and mark with another; sharing the cut
 * keeps exactly one implementation of the UTF-8 boundary walk.
 */
function cutToBytes(text: string, maxBytes: number): Cut {
  const buf = Buffer.from(text, 'utf8');
  const originalBytes = buf.length;
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  if (originalBytes <= limit) {
    return { kept: text, keptBytes: originalBytes, originalBytes, truncated: false };
  }
  // `end` is the index of the first EXCLUDED byte. If it is a UTF-8
  // continuation byte (0b10xxxxxx) we are mid-sequence; walk back until the
  // first excluded byte starts a new code point.
  let end = limit;
  while (end > 0) {
    const byte = buf[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end--;
  }
  return {
    kept: buf.subarray(0, end).toString('utf8'),
    keptBytes: end,
    originalBytes,
    truncated: true,
  };
}

/** A marker already present on a string, split from the payload it annotates. */
export interface ExistingTruncation {
  /** The string with its trailing marker removed. */
  payload: string;
  /**
   * Bytes the earlier pass says it kept. VALIDATED: this equals the UTF-8
   * length of {@link ExistingTruncation.payload}, or the marker was not
   * recognised at all.
   */
  keptBytes: number;
  /** Bytes the earlier pass says the ORIGINAL payload had. */
  originalBytes: number;
}

/**
 * Split a trailing {@link truncationMarker} off `text`, or `undefined` when
 * there is none. Never throws.
 *
 * A marker is recognised ONLY when its stated kept count measures the prefix
 * beside it. That check is what separates a marker this code wrote from a
 * marker-shaped suffix that arrived as content — and content is the common
 * case here, not a hypothetical: this repo's own `redact.ts` holds the
 * template literal, and `PLAN.md`, `HANDOVER.md` and `CLAUDE.md` all contain
 * literal `8192 of 8248` strings. A tool result that reads one of those files
 * can end at a marker-shaped suffix, and adopting its numbers would make the
 * truncation marker report a figure taken from the observed content instead of
 * from a measurement — the fabricated-`costUsd` class of defect, arriving from
 * the opposite direction to the one this function was written to close.
 *
 * The validation needs no information we do not already have: a string that
 * genuinely came out of a truncation pass has a prefix whose byte length IS
 * its stated `keptBytes`, by construction — {@link truncateUtf8} and
 * {@link truncatePreservingMarker} both count the prefix they emit. A mismatch
 * therefore proves the suffix is content, and the caller re-measures from
 * scratch with the whole string as the payload.
 *
 * The residual, stated rather than hidden: content ending in a marker whose
 * kept count happens to equal its own prefix length is indistinguishable from
 * a real one and is treated as real. Nothing in the string can settle that.
 */
export function splitTruncationMarker(text: string): ExistingTruncation | undefined {
  if (typeof text !== 'string') return undefined;
  const m = TRUNCATION_MARKER_RE.exec(text);
  if (m === null) return undefined;
  const keptBytes = Number(m[1]);
  const originalBytes = Number(m[2]);
  if (!Number.isFinite(keptBytes) || !Number.isFinite(originalBytes)) return undefined;
  const payload = text.slice(0, text.length - m[0].length);
  if (Buffer.byteLength(payload, 'utf8') !== keptBytes) return undefined;
  return { payload, keptBytes, originalBytes };
}

/**
 * Truncate to `maxBytes`, but REFUSE to re-mark an already-marked string
 * against the length of the string this pass was handed.
 *
 * This exists because a marker is a claim about the ORIGINAL payload, and a
 * second truncation pass over a marked string does not know that payload — it
 * only knows the marked string in front of it. Marking that length turns the
 * marker into a fabricated number: measured on the committed capture, a
 * 63,774-byte payload cut at 8,192 (string length 8,248) and then cut again at
 * 8,192 reported "8192 of 8248", under-reporting the original by 7.73x.
 *
 * The rule: strip the existing marker, apply the ceiling to the PAYLOAD, and
 * mark the result with the larger of (a) the original size the existing marker
 * states and (b) the payload actually in hand. The reported original therefore
 * never shrinks across passes and never claims less than what is displayed.
 *
 * Both directions are guarded, and they are separate mechanisms:
 *
 *   under-reporting  `Math.max` above — a marker cannot claim an original
 *                    smaller than the bytes sitting next to it.
 *   over-reporting   {@link splitTruncationMarker} recognises a marker only
 *                    when its kept count MEASURES the prefix. A payload that
 *                    merely ends in marker-shaped content is re-measured from
 *                    scratch, so a forged "of 88888888" cannot become our
 *                    reported original.
 *
 * An unmarked string — or one whose marker fails that validation — is
 * truncated exactly as {@link truncateUtf8} would truncate it.
 */
export function truncatePreservingMarker(
  text: string,
  maxBytes: number = DEFAULT_MAX_PAYLOAD_BYTES,
): TruncationResult {
  const existing = splitTruncationMarker(text);
  if (existing === undefined) return truncateUtf8(text, maxBytes);
  const cut = cutToBytes(existing.payload, maxBytes);
  const originalBytes = Math.max(existing.originalBytes, cut.originalBytes);
  // Re-emitted canonically even when nothing was cut, so the marker's kept
  // count is always a MEASUREMENT of the payload beside it rather than a
  // number inherited from an earlier pass (or from content pretending to be
  // one). `truncated` is true either way: the payload IS a truncation.
  return {
    text: cut.kept + truncationMarker(cut.keptBytes, originalBytes),
    truncated: true,
    originalBytes,
    keptBytes: cut.keptBytes,
  };
}

// ---------------------------------------------------------------------------
// Thinking blocks
// ---------------------------------------------------------------------------

/**
 * Block types dropped outright.
 *
 * `thinking` is the only one measured in the fixtures (15 blocks across the 7
 * committed transcripts). `redacted_thinking` is included as defence in depth:
 * dropping a block that does not exist costs nothing, and letting one through
 * because it was spelled differently violates G4. Anything else is decided by
 * {@link isThinkingBlock}'s payload check, not by name.
 */
export const DROPPED_BLOCK_TYPES: ReadonlySet<string> = new Set(['thinking', 'redacted_thinking']);

/** Field names stripped from any surviving block. */
export const DROPPED_BLOCK_FIELDS: ReadonlySet<string> = new Set(['thinking', 'signature']);

/**
 * True when `value` is a content block that carries model reasoning.
 *
 * Measured shape (CC 2.1.234): `{"type":"thinking","thinking":"...","signature":"..."}`.
 * Note that in the committed fixtures all 15 thinking blocks have an EMPTY
 * `thinking` string and a long populated `signature` — the signature is the
 * reasoning-bearing bytes actually present on disk, which is why it is dropped
 * too and why the G4 test asserts against signatures.
 *
 * The payload check (`typeof thinking === 'string'`) catches a block whose type
 * was renamed in a later CC version but that still carries the field.
 */
export function isThinkingBlock(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const block = value as { type?: unknown; thinking?: unknown };
  if (typeof block.type === 'string' && DROPPED_BLOCK_TYPES.has(block.type)) return true;
  return typeof block.thinking === 'string';
}

// ---------------------------------------------------------------------------
// Deep redaction walk
// ---------------------------------------------------------------------------

export interface RedactionOptions {
  /** Byte ceiling for any single string. Defaults to {@link DEFAULT_MAX_PAYLOAD_BYTES}. */
  maxPayloadBytes?: number;
}

export interface RedactionReport {
  /** Content blocks removed because they carried reasoning. */
  thinkingBlocksDropped: number;
  /** `thinking` / `signature` fields stripped from surviving blocks. */
  thinkingFieldsDropped: number;
  /** Strings that exceeded the byte ceiling and were cut. */
  truncatedStrings: number;
  /** Subtrees replaced because they exceeded {@link MAX_REDACTION_DEPTH}. */
  depthLimited: number;
  /**
   * True when any string held an unpaired UTF-16 surrogate. Such a value cannot
   * round-trip through UTF-8; `parse.ts` treats the line as malformed.
   */
  loneSurrogate: boolean;
}

export interface RedactionOutcome {
  value: JsonValue;
  report: RedactionReport;
}

function emptyReport(): RedactionReport {
  return {
    thinkingBlocksDropped: 0,
    thinkingFieldsDropped: 0,
    truncatedStrings: 0,
    depthLimited: 0,
    loneSurrogate: false,
  };
}

/**
 * True when `text` contains an unpaired surrogate code unit.
 *
 * Hand-rolled rather than `String.prototype.isWellFormed` so the module does
 * not depend on a lib level above the project's ES2022 target.
 */
export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/**
 * Redact and truncate an arbitrary JSON value in place of the raw one.
 *
 * Every string in the tree is subject to the byte ceiling — not just the ones
 * this phase happens to render. CC puts large payloads in several places
 * (`message.content[].text`, `tool_use.input`, `tool_result.content`,
 * `attachment`, `toolUseResult`), and a whitelist would leak the next one CC
 * adds. Uniform beats enumerated here.
 */
export function redactJson(value: unknown, options: RedactionOptions = {}): RedactionOutcome {
  const maxBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const report = emptyReport();
  const out = walk(value, maxBytes, report, 0);
  return { value: out, report };
}

function walk(value: unknown, maxBytes: number, report: RedactionReport, depth: number): JsonValue {
  if (depth > MAX_REDACTION_DEPTH) {
    report.depthLimited++;
    return DEPTH_LIMIT_MARKER;
  }
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) report.loneSurrogate = true;
    const cut = truncateUtf8(value, maxBytes);
    if (cut.truncated) report.truncatedStrings++;
    return cut.text;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    for (const item of value) {
      if (isThinkingBlock(item)) {
        report.thinkingBlocksDropped++;
        continue;
      }
      out.push(walk(item, maxBytes, report, depth + 1));
    }
    return out;
  }
  if (typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (DROPPED_BLOCK_FIELDS.has(key)) {
        report.thinkingFieldsDropped++;
        continue;
      }
      if (isThinkingBlock(item)) {
        report.thinkingBlocksDropped++;
        continue;
      }
      out[key] = walk(item, maxBytes, report, depth + 1);
    }
    return out;
  }
  // Functions, symbols, bigints: unreachable from JSON.parse, but never throw.
  return null;
}
