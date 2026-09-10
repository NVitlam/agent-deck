/**
 * Agent Deck — redaction and truncation.
 *
 * This is production code from Phase 1, not a later hardening pass (G4). It
 * runs *at the parse boundary*: `parse.ts` calls into here before it hands a
 * `TranscriptEntry` to anything else, so nothing downstream ever holds a
 * thinking block or an untruncated payload.
 *
 * Three jobs:
 *
 *   a) Thinking blocks are dropped. A `thinking` content block (with its
 *      `signature`) is removed as the entry is parsed. It never reaches the
 *      session model, is never stored, previewed or logged.
 *   b) Payloads over 8 KB (default, configurable) are truncated with a marker
 *      that states the original size. Truncation is on BYTES, and never cuts a
 *      UTF-8 multi-byte sequence in half.
 *   c) `tool-results/*.txt` offloaded payloads go through the same path. Large
 *      tool output lives OUTSIDE the JSONL, behind a `<persisted-output>` stub,
 *      so a redaction pass that only walks JSONL silently misses it.
 *
 * Other grounding constraints:
 *
 *   G1  Read-only. The only I/O here is `readFile` with flag 'r'. Nothing is
 *       created, written, renamed or deleted, anywhere.
 *   G3  Refuse, don't guess. No input can make a call throw. A missing or
 *       unreadable tool-results file is a described failure, not an exception.
 *   G5  Zero egress. Node built-ins only.
 *   G7  In-memory only. No cache, no persisted state.
 *
 * Schema notes are measured from the committed CC 2.1.234 fixtures, not from
 * memory (G6). Where this file states a count, the count came from those bytes.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';


// ---------------------------------------------------------------------------
// The redaction walk lives in `redact-core.ts` (v0.7.0 Phase 1b)
// ---------------------------------------------------------------------------
//
// Moved rather than copied, and RE-EXPORTED here so no call site moved with
// it. The split exists so the hook listener — which redacts before relaying to
// another window — can import the walk without pulling `node:fs/promises` into
// its closure; `redact-core.ts`'s own header carries the reasoning.

export * from './redact-core.js';

import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  truncateUtf8,
  type RedactionOptions,
  type TruncationResult,
} from './redact-core.js';

// ---------------------------------------------------------------------------
// Offloaded tool results (`tool-results/*.txt`)
// ---------------------------------------------------------------------------

/**
 * The `<persisted-output>` stub CC leaves in the JSONL when a tool result is
 * too large to inline. Measured against the committed capture:
 *
 *   <persisted-output>
 *   Output too large (62.3KB). Full output saved to: C:\Users\...\tool-results\b6uvpgxa4.txt
 *
 *   Preview (first 2KB):
 *   ...first ~2 KB of the payload...
 *   ...
 *   </persisted-output>
 *
 * Two measured consequences:
 *
 *   1. The stub is ALREADY truncated by CC to a ~2 KB preview (the real one is
 *      2,184 characters / 2,186 bytes), so the 8 KB ceiling does not fire on it.
 *      Truncation is not only ever caused by us.
 *   2. The embedded path is absolute and points at the developer's live
 *      `~/.claude`. It is stale under fixture replay. We parse the pointer,
 *      DISCARD the absolute path, and keep only the basename — the path CC
 *      wrote is never opened.
 */
export interface PersistedOutputPointer {
  /** Kept for diagnostics and for tests. Never passed to `readFile`. */
  originalPath: string;
  /** The only part of the path that is used. */
  basename: string;
  /** e.g. '62.3KB', exactly as CC spelled it. Absent if CC changes the wording. */
  reportedSize?: string;
  /** e.g. '2KB'. */
  previewSize?: string;
  /** The inline preview CC embedded. Used as the degraded result if the file is gone. */
  preview: string;
}

const PERSISTED_OUTPUT_RE =
  /^<persisted-output>\n(?:Output too large \(([^)]*)\)\.\s*)?Full output saved to:[ \t]*(.+?)[ \t]*\n\n(?:Preview \(first ([^)]*)\):\n)?([\s\S]*?)\n<\/persisted-output>\s*$/;

/** Last path segment, for both separators, independent of the host OS. */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.length > 0 ? (parts[parts.length - 1] ?? '') : '';
}

/**
 * True when a basename is safe to join onto the tool-results directory: no
 * separators, no traversal, not empty, not a device-ish name.
 */
export function isSafeToolResultBasename(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (/[\\/]/.test(name)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f<>:"|?*]/.test(name)) return false;
  return true;
}

/**
 * Parse a `tool_result` content string into a pointer, or `undefined` when it
 * is ordinary inline output. Never throws.
 */
export function parsePersistedOutputPointer(text: unknown): PersistedOutputPointer | undefined {
  if (typeof text !== 'string') return undefined;
  if (!text.startsWith('<persisted-output>')) return undefined;
  const m = PERSISTED_OUTPUT_RE.exec(text);
  if (m === null) return undefined;
  const originalPath = m[2] ?? '';
  const basename = lastSegment(originalPath);
  if (!isSafeToolResultBasename(basename)) return undefined;
  const pointer: PersistedOutputPointer = {
    originalPath,
    basename,
    preview: m[4] ?? '',
  };
  if (m[1] !== undefined) pointer.reportedSize = m[1];
  if (m[3] !== undefined) pointer.previewSize = m[3];
  return pointer;
}

/**
 * Where the offloaded payload is looked for. Deliberately built from the
 * ACTIVE projects root, never from the absolute path inside the stub: under
 * fixture replay that path would reach into the real user's `~/.claude`.
 */
export interface ToolResultContext extends RedactionOptions {
  /** The active projects root (`CLAUDE_PROJECTS_ROOT` or `~/.claude/projects`). */
  projectsRoot: string;
  /** Slug directory as spelled on disk. */
  slug: string;
  sessionId: string;
  /** Injection seam for tests. Defaults to `fs.readFile` with flag 'r'. */
  readFileImpl?: (path: string) => Promise<string>;
}

/** `<projectsRoot>/<slug>/<sessionId>/tool-results/<basename>`. */
export function resolveToolResultPath(basename: string, ctx: ToolResultContext): string {
  return join(ctx.projectsRoot, ctx.slug, ctx.sessionId, 'tool-results', basename);
}

export interface ToolResultRead {
  ok: boolean;
  /** The path we actually opened (or would have). */
  path: string;
  /** Redacted and truncated content, or the stub's inline preview on failure. */
  text: string;
  /** True when `text` came from the stub because the file was unusable. */
  degraded: boolean;
  truncated: boolean;
  /** Size of the file on disk in UTF-8 bytes; 0 when it could not be read. */
  originalBytes: number;
  /** errno-shaped code, e.g. 'ENOENT'. Present only when `ok` is false. */
  code?: string;
  /** Human-readable failure description. Present only when `ok` is false. */
  reason?: string;
}

/**
 * Read an offloaded tool result and put it through the SAME redaction and
 * truncation path as inline content.
 *
 * A missing or unreadable file is a counted diagnostic and a degraded preview
 * (the stub's own inline text), never a throw (G3).
 */
export async function readRedactedToolResult(
  pointer: PersistedOutputPointer,
  ctx: ToolResultContext,
): Promise<ToolResultRead> {
  const path = resolveToolResultPath(pointer.basename, ctx);
  const read = ctx.readFileImpl ?? ((p: string) => readFile(p, { encoding: 'utf8', flag: 'r' }));
  let raw: string;
  try {
    raw = await read(path);
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'EUNKNOWN';
    const degraded = redactText(pointer.preview, ctx);
    return {
      ok: false,
      path,
      text: degraded.text,
      degraded: true,
      truncated: degraded.truncated,
      originalBytes: 0,
      code,
      reason: `tool-results file unreadable (${code}): ${pointer.basename}`,
    };
  }
  const redacted = redactText(raw, ctx);
  return {
    ok: true,
    path,
    text: redacted.text,
    degraded: false,
    truncated: redacted.truncated,
    originalBytes: redacted.originalBytes,
  };
}

/**
 * Redact + truncate a plain text payload. Text has no content blocks, so the
 * thinking pass is a no-op here; the byte ceiling and the UTF-8-safe cut are
 * exactly the ones inline content gets.
 */
export function redactText(text: string, options: RedactionOptions = {}): TruncationResult {
  return truncateUtf8(text, options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES);
}

