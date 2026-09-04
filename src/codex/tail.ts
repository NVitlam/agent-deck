/**
 * Agent Deck — byte-offset tailing of a Codex rollout transcript
 * (PLAN.md v0.6.0 Phase 2, DoD 2.1).
 *
 * ---------------------------------------------------------------------------
 * THIS IS A WRAPPER. THE TAILER IS THE CLAUDE CODE ONE.
 * ---------------------------------------------------------------------------
 *
 * `PLAN.md` Phase 2, open question, answered:
 *
 *   > *Reuse the CC tailer?* Yes — same byte-offset, partial-line, debounce
 *   > semantics. Any change needed is made in `src/watch` with CC tests kept
 *   > green.
 *
 * Both halves of that are taken literally. {@link CodexFileTail} holds a
 * `FileTail` from `../parser/tailer.js` and delegates every byte to it; the
 * `Debouncer` seam is re-exported unchanged. There is no second implementation
 * of "hold the last line back until its newline arrives" in this repository,
 * which is the only way that property can be guaranteed not to drift.
 *
 * **One additive change was needed there, and the reason is recorded because it
 * is not obvious.** An earlier draft of this file PORTED the algorithm, because
 * `CodexTailState.pending` is declared `string` in the frozen hand-off line
 * while `FileTail` exposed only `pendingBytes`, a number. Filling `pending`
 * with the empty string was rejected as a silent wrong answer rather than a
 * small inaccuracy: `offset` counts bytes CONSUMED FROM THE FILE, pending ones
 * included, so a downstream package reading an empty `pending` beside a
 * non-zero `offset` concludes that every consumed byte became a line.
 * `FileTail` now carries a read-only `get pending(): string` beside
 * `get pendingBytes()`, and this file is a wrapper again.
 *
 * `tail.test.ts` keeps its differential suite, which now does a different job:
 * it pins the WRAPPER's faithfulness — that nothing is dropped, renumbered or
 * re-ordered on the way through — rather than an independent algorithm's
 * agreement with the one it was copied from.
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
 *     which it would count as malformed — and the record would be lost for
 *     good: the bytes are consumed, the counter says "malformed", and nothing
 *     ever re-reads them. **Holding the partial back is not deferring a
 *     problem; it is the only correct answer.**
 *   - {@link CODEX_MAX_PARTIAL_BYTES} is 32 MiB rather than `FileTail`'s 8 MiB
 *     default. The measured line is 554 KB and 8 MiB would hold it, but this
 *     ceiling is a RESYNC threshold: a line exceeding it is dropped and the
 *     tail resynchronises at the next newline. Sizing it against the largest
 *     line anyone has captured so far would make the drop a function of how big
 *     the next build log was. 32 MiB is ~58x the measured maximum and still a
 *     bound.
 *
 * G1 read-only, G3 never throws, G5 no sockets, G7 offsets in memory only — all
 * inherited from `FileTail`, which is the other half of why this is a wrapper.
 */

import type { SkippedFile } from '../model/events.js';
import { FileTail } from '../parser/tailer.js';
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
 * to establish. The inner `FileTail` is handed the basename because it requires
 * a session id; that value is never re-exported under a name implying identity.
 *
 * The caller drives it: no watcher, no ambient timer, exactly as in
 * `../parser/tailer.js`.
 */
export class CodexFileTail {
  readonly path: string;
  readonly file: string;
  readonly #tail: FileTail;

  constructor(path: string, options: CodexFileTailOptions = {}) {
    this.path = path;
    this.file = basenameOf(path);
    this.#tail = new FileTail(path, {
      sessionId: this.file,
      agentId: null,
      maxPartialBytes: options.maxPartialBytes ?? CODEX_MAX_PARTIAL_BYTES,
    });
  }

  /** Bytes consumed from the file, pending ones included. In memory only (G7). */
  get offset(): number {
    return this.#tail.offset;
  }

  /** Bytes currently held back because their line has no newline yet. */
  get pendingBytes(): number {
    return this.#tail.pendingBytes;
  }

  /** The held-back text itself, which is what makes `state.pending` honest. */
  get pending(): string {
    return this.#tail.pending;
  }

  /** The hand-off shape of `types.ts`. `pending` is the real held-back text. */
  get state(): CodexTailState {
    return { path: this.path, offset: this.#tail.offset, pending: this.#tail.pending };
  }

  /**
   * Read everything appended since the previous call. Opens read-only (G1) and
   * never throws (G3) — failures come back as `skipped`.
   */
  async read(): Promise<CodexReadResult> {
    const result = await this.#tail.read();
    const lines: CodexTailLine[] = result.lines.map((line) => ({
      path: line.path,
      file: this.file,
      text: line.text,
      lineNo: line.lineNo,
    }));
    const base = {
      lines,
      bytesRead: result.bytesRead,
      reset: result.reset,
      oversized: result.oversized,
      state: this.state,
    };
    return result.skipped === undefined ? base : { ...base, skipped: result.skipped };
  }
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
