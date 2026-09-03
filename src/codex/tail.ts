/**
 * Agent Deck — byte-offset tailing of a Codex rollout transcript
 * (PLAN.md v0.6.0 Phase 2, DoD 2.1).
 *
 * ---------------------------------------------------------------------------
 * SAME SEMANTICS AS THE CLAUDE CODE TAILER, AND A TEST THAT PROVES IT
 * ---------------------------------------------------------------------------
 *
 * `PLAN.md` Phase 2, open question, answered:
 *
 *   > *Reuse the CC tailer?* Yes — same byte-offset, partial-line, debounce
 *   > semantics. Any change needed is made in `src/watch` with CC tests kept
 *   > green.
 *
 * The **debounce** half is reused literally: `Debouncer`, `Clock`, `Scheduler`
 * and `ManualTime` are re-exported from `../parser/tailer.js` below, so a Codex
 * caller wiring burst coalescing gets the same objects the CC watcher uses,
 * with the clock and the timer injected and no test needing to sleep.
 *
 * The **byte-offset and partial-line** half is a deliberate port rather than a
 * wrap, and the reason is one field of the frozen hand-off line:
 *
 *   > `CodexTailState.pending` — "Bytes read but not yet terminated by a
 *   > newline." Declared `string`.
 *
 * `FileTail` keeps its partial buffer in a `#private` field and exposes only
 * `pendingBytes`, a number. A wrapper therefore cannot fill `pending`
 * truthfully, and filling it with `''` would be worse than useless: `offset`
 * counts bytes CONSUMED FROM THE FILE, pending ones included, so a downstream
 * package reading `{offset, pending: ''}` would conclude that every byte up to
 * `offset` had been emitted as a line. That is a silent wrong answer of exactly
 * the shape this repository keeps recording.
 *
 * Filling it truthfully by wrapping would need a one-line `get pending()` on
 * `FileTail`, in `src/parser/`, which this package does not own. So the
 * algorithm is ported here — and, because a second implementation of a property
 * is a second place for it to be subtly wrong, `tail.test.ts` runs the same
 * byte streams through BOTH tailers and asserts identical lines, identical
 * offsets and identical reset behaviour. The duplication is pinned rather than
 * trusted.
 *
 * ---------------------------------------------------------------------------
 * THE PARTIAL LINE IS THE NORMAL STATE, NOT A CORNER CASE
 * ---------------------------------------------------------------------------
 *
 * Codex stores tool output whole and inline — there is no offload path, the
 * opposite of CC's `tool-results/<id>.txt`. The corpus's defining record is
 * **554,126 bytes on one line**. Two consequences:
 *
 *   - A read landing mid-line is the ordinary case for a live session. A tailer
 *     that emitted the fragment would hand `parse.ts` a truncated JSON line,
 *     which it would count as malformed — and the record would then be lost for
 *     good: the bytes are consumed, the counter says "malformed", and nothing
 *     ever re-reads them. **Holding the partial back is not deferring a
 *     problem; it is the only correct answer.**
 *   - {@link CODEX_MAX_PARTIAL_BYTES} is 32 MiB rather than `FileTail`'s 8 MiB
 *     default. The measured line is 554 KB and 8 MiB would hold it, but this
 *     ceiling is a RESYNC threshold: a line exceeding it is dropped and the tail
 *     resynchronises at the next newline. Sizing it against the largest line
 *     anyone has captured so far would make the drop a function of how big the
 *     next build log was. 32 MiB is ~58x the measured maximum and still a bound.
 *
 * G1 read-only: every handle is opened with flag `'r'` and this module creates,
 * writes, renames and deletes nothing, anywhere.
 * G3 refuse, don't guess: no input makes a call throw. Unreadable, vanished,
 * zero-byte, truncated, directory-where-a-file-was-expected and
 * unterminated-line are all surfaced as counters or result fields.
 * G5 zero egress: node built-ins only.
 * G7 in-memory only: the offset lives in this object and dies with the process.
 */

import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

import type { SkippedFile } from '../model/events.js';
import type { CodexTailState } from './types.js';

// The debounce seam, reused literally rather than restated. One import site for
// a Codex caller; the same objects the CC watcher drives.
export { Debouncer, ManualTime, systemClock, systemScheduler } from '../parser/tailer.js';
export type {
  Clock,
  DebouncerOptions,
  FlushInfo,
  FlushReason,
  Scheduler,
  TimerHandle,
} from '../parser/tailer.js';

/**
 * Upper bound on one unterminated line held in memory before the tail drops it
 * and resynchronises at the next newline. See the header for the sizing.
 */
export const CODEX_MAX_PARTIAL_BYTES = 32 * 1024 * 1024;

/** One complete line of a rollout transcript, exactly as it sat on disk. */
export interface CodexTailLine {
  /** Absolute path of the transcript. */
  readonly path: string;
  /** Basename, `rollout-<ISO-ts>-<uuid>.jsonl`. The golden keys on this. */
  readonly file: string;
  /** Line content without its terminating newline (and without a trailing CR). */
  readonly text: string;
  /** 1-based, counted across the lifetime of this tail. */
  readonly lineNo: number;
}

export interface CodexReadResult {
  readonly lines: readonly CodexTailLine[];
  readonly bytesRead: number;
  /** The file shrank below the stored offset and the tail restarted at 0. */
  readonly reset: boolean;
  /** Present when the file could not be read at all this round. */
  readonly skipped?: SkippedFile;
  /** Lines dropped for exceeding {@link CODEX_MAX_PARTIAL_BYTES}. */
  readonly oversized: number;
  /** The state after this read, in the hand-off shape of `types.ts`. */
  readonly state: CodexTailState;
}

export interface CodexFileTailOptions {
  /** Overrides {@link CODEX_MAX_PARTIAL_BYTES}. Tests use it; production does not. */
  readonly maxPartialBytes?: number;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'EUNKNOWN';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Incremental tail of one rollout transcript.
 *
 * **Why the basename and not a session id.** `FileTail`'s `TailLine` carries
 * `sessionId` and `agentId`, which are Claude Code facts: a CC transcript's
 * path states the session and the agent. A Codex transcript's path states
 * neither — spec C1, "a subagent's transcript is a SIBLING of its parent's,
 * with nothing in the path marking it as a subagent" — and the thread id lives
 * inside the file at ordinal 0. A tail that invented an id from the filename
 * would be classifying by path, which the spec says cannot work. So a line
 * carries `file`, the key the golden itself uses, and identity is `parse.ts`'s
 * to establish.
 *
 * The caller drives it: no watcher, no ambient timer, exactly as in
 * `../parser/tailer.js`.
 */
export class CodexFileTail {
  readonly path: string;
  readonly file: string;

  #offset = 0;
  #lineNo = 0;
  #partial = '';
  #decoder = new StringDecoder('utf8');
  #resyncing = false;
  readonly #maxPartialBytes: number;

  constructor(path: string, options: CodexFileTailOptions = {}) {
    this.path = path;
    this.file = basenameOf(path);
    this.#maxPartialBytes = options.maxPartialBytes ?? CODEX_MAX_PARTIAL_BYTES;
  }

  /** Bytes consumed from the file, pending ones included. In memory only (G7). */
  get offset(): number {
    return this.#offset;
  }

  /** Bytes currently held back because their line has no newline yet. */
  get pendingBytes(): number {
    return Buffer.byteLength(this.#partial, 'utf8');
  }

  /** The hand-off shape of `types.ts`. `pending` is the real held-back text. */
  get state(): CodexTailState {
    return { path: this.path, offset: this.#offset, pending: this.#partial };
  }

  #reset(): void {
    this.#offset = 0;
    this.#partial = '';
    this.#decoder = new StringDecoder('utf8');
    this.#resyncing = false;
  }

  /**
   * Read everything appended since the previous call. Opens read-only (G1) and
   * never throws (G3) — failures come back as `skipped`.
   */
  async read(): Promise<CodexReadResult> {
    const empty = { lines: [] as CodexTailLine[], bytesRead: 0, reset: false, oversized: 0 };

    let handle;
    try {
      handle = await open(this.path, 'r');
    } catch (error) {
      return {
        ...empty,
        skipped: {
          path: this.path,
          reason: `${errorCode(error)}: cannot open for reading (${errorMessage(error)})`,
        },
        state: this.state,
      };
    }

    try {
      const stats = await handle.stat();

      if (!stats.isFile()) {
        return {
          ...empty,
          skipped: {
            path: this.path,
            reason: 'ENOTFILE: expected a file, found a directory or special file',
          },
          state: this.state,
        };
      }

      let reset = false;
      if (stats.size < this.#offset) {
        // Smaller than where we stopped: the file was replaced, not appended
        // to. Reading from the stale offset would yield garbage.
        this.#reset();
        reset = true;
      }
      if (stats.size === this.#offset) {
        return { ...empty, reset, state: this.state };
      }

      const length = stats.size - this.#offset;
      const buffer = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const { bytesRead } = await handle.read(buffer, total, length - total, this.#offset + total);
        if (bytesRead === 0) break; // shrank mid-read; take what we got
        total += bytesRead;
      }
      this.#offset += total;

      // A UTF-8 sequence split across two reads is stitched by the decoder
      // rather than decoded twice and corrupted.
      const decoded = this.#decoder.write(buffer.subarray(0, total));
      const consumed = this.#consume(decoded);
      return { ...consumed, bytesRead: total, reset, state: this.state };
    } catch (error) {
      return {
        ...empty,
        skipped: {
          path: this.path,
          reason: `${errorCode(error)}: read failed (${errorMessage(error)})`,
        },
        state: this.state,
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Split decoded text into complete lines, holding any tail back. */
  #consume(decoded: string): { lines: CodexTailLine[]; oversized: number } {
    let text = decoded;
    let oversized = 0;

    if (this.#resyncing) {
      const nl = text.indexOf('\n');
      if (nl === -1) return { lines: [], oversized };
      text = text.slice(nl + 1);
      this.#resyncing = false;
    }

    text = this.#partial + text;
    const parts = text.split('\n');
    this.#partial = parts.pop() ?? '';

    if (Buffer.byteLength(this.#partial, 'utf8') > this.#maxPartialBytes) {
      this.#partial = '';
      this.#resyncing = true;
      oversized += 1;
    }

    const lines: CodexTailLine[] = [];
    for (const part of parts) {
      const content = part.endsWith('\r') ? part.slice(0, -1) : part;
      if (content.trim() === '') continue; // blank separator, not a record
      this.#lineNo += 1;
      lines.push({ path: this.path, file: this.file, text: content, lineNo: this.#lineNo });
    }
    return { lines, oversized };
  }
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
