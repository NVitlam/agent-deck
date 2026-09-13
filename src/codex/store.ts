/**
 * Agent Deck — the Codex engine's per-transcript ingestion state
 * (HOTFIX-0.6.1, DoD H.2).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FIXES, AND WHY A MAP IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 * `readDiscovered` used to construct `new CodexFileTail(ref.path)` inside its
 * per-transcript loop. A tail's byte offset is its entire memory, so a tail
 * built fresh every pass starts every file at zero — and with a 1 000 ms poll
 * that is *every Codex transcript on the machine, re-read from the beginning,
 * once a second*. An external user with a 3.11 GB `~/.codex/sessions` folder
 * collected seven extension-host OOM dumps.
 * `lab/docs/evidence/hotfix-0.6.1/RED.md` is the reproduction.
 *
 * The Claude Code engine never had this defect: `SessionTailer` has always kept
 * `#tails = new Map<string, FileTail>()`. This class is that idea, plus the
 * ingestion state a Codex transcript needs that a CC one does not.
 *
 * ---------------------------------------------------------------------------
 * THE LIFETIME IS THE CALLER'S, DELIBERATELY
 * ---------------------------------------------------------------------------
 * There is no module-level store. `readCodexEngine` takes one through
 * `CodexEngineOptions.tails`, and a call that passes none gets a throwaway —
 * which is exactly the one-shot, read-everything-now behaviour every golden
 * test and every fixture replay already depends on (DoD H.7). The host
 * (`CodexEnginePath`) owns one for the lifetime of its data path.
 *
 * That is the same shape this codebase already uses for clocks and poll
 * triggers, and it is the reason two VS Code windows cannot share a cursor by
 * accident.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS RETAINED, AND WHAT IS DROPPED THE MOMENT IT CAN BE
 * ---------------------------------------------------------------------------
 * An OOM hotfix that retains more than the code it replaces has fixed nothing,
 * so retention is the property this file is designed around:
 *
 *   - {@link CodexIngestEntry.records} is kept for an ACCEPTED transcript and
 *     dropped the instant one is terminally judged — refused, foreign or
 *     oversize. **An earlier draft dropped them at end-of-file too, and that
 *     was a shipping defect**: the next append re-fingerprinted the appended
 *     records ALONE, found no `session_meta` at ordinal 0, and refused the
 *     session terminally. `index.ts` carries the measurement.
 *
 *     What bounds the retention is the size gate and the workspace decision,
 *     not a drop: no entry can hold more than `maxTranscriptBytes` of source,
 *     and a transcript belonging to another workspace never keeps a record at
 *     all. `v0.6.0` had neither bound — it read every transcript on the
 *     machine once a second and retained a `CodexThread` for each.
 *   - {@link CodexIngestEntry.thread} is the parsed result, whose payloads are
 *     already truncated by `parse.ts`. It is what `v0.6.0` retained too, via
 *     the engine's return value.
 *   - A transcript over the size limit is read as a HEAD PLUS A TAIL, with the
 *     middle skipped (v0.8.0 DoD 7.7). It used to get an entry with no tail at
 *     all — nothing opened, nothing read, one `SkippedFile` — and the
 *     retention bound that gave up is replaced by a tighter one: such an entry
 *     holds at most `CODEX_HEAD_BYTES + CODEX_OVERSIZE_TAIL_BYTES` of source,
 *     16.25 MiB, which is a QUARTER of the 64 MiB an under-the-limit
 *     transcript may hold.
 *
 * G1 read-only and G7 in-memory-only are inherited from `CodexFileTail`;
 * nothing here writes or persists anything.
 */

import type { SkippedFile, TranscriptPartial } from '../model/events.js';

import { CodexFileTail } from './tail.js';
import type { CodexCounters, CodexRecord, CodexRefusal, CodexThread } from './types.js';

/**
 * Default ceiling on a transcript the engine will open at all: **64 MiB**.
 *
 * Overridden by `agentDeck.codex.maxTranscriptBytes`. The gate is applied to
 * `statSync().size`, which discovery already collected
 * (`CodexTranscriptRef.bytes`), so refusing a file costs ZERO extra syscalls
 * and, more to the point, zero bytes of allocation.
 *
 * **This number is a locked decision, not a measurement**, and saying so is the
 * point: `HOTFIX-0.6.1.md` fixes it at 64 MiB. For scale, the largest
 * transcript in the committed corpus is 635,376 bytes — this is ~105x it — and
 * the user who reported the defect has a 3.11 GB folder.
 */
export const DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/**
 * How far one transcript has got, as a closed set.
 *
 * `refused`, `foreign` and `oversize` are TERMINAL for as long as the entry
 * lives: the contract's "refused or foreign → no further bytes are ever read"
 * is this union plus the `switch` in `index.ts`, rather than a comment asking
 * a future reader to remember.
 *
 * `undecided` is not "unknown" — it is the specific state of having read some
 * bytes and not yet having a `session_meta` at ordinal 0 to judge them by. A
 * head that lands mid-first-line produces it, and the answer is to read more,
 * never to refuse.
 *
 * ---------------------------------------------------------------------------
 * `oversize` STAYED IN THIS UNION AND ITS MEANING NARROWED (v0.8.0 DoD 7.7)
 * ---------------------------------------------------------------------------
 * It used to mean "this transcript is over `maxTranscriptBytes`", which is now
 * the ORDINARY case and is not terminal at all: such a transcript is read as
 * a head plus the last `CODEX_OVERSIZE_TAIL_BYTES` (`tail.ts`), becomes `accepted`
 * like any other, and carries {@link CodexIngestEntry.partial}. A partial read
 * that stopped reading would be the defect the item exists to fix.
 *
 * What is left here is the one oversize shape that cannot be read at all: a
 * transcript over the limit whose HEAD spent its whole budget without yielding
 * a record to decide on. For an ordinary file that state means "read more" —
 * for this one there is no bounded amount of "more" to read, because the file
 * is the size the gate exists to refuse to allocate. It is terminal so the
 * engine cannot spend one head per poll for the life of the window on a file
 * it has already failed to decide, and `index.ts` states the measurement that
 * makes it near-unreachable: the largest ordinal-0 record in the committed
 * corpus is 1,113 bytes against a 256 KiB head.
 *
 * A REPLACED file still gets a fresh entry and a fresh chance — terminality is
 * for the life of THIS entry, and `index.ts`'s shrink/rewrite detection resets
 * it. That is what the two `sourceBytes`/`sourceMtimeMs` fields below are for.
 */
export type CodexIngestVerdict = 'undecided' | 'accepted' | 'refused' | 'foreign' | 'oversize';

/** Everything the engine remembers about one transcript between passes. */
export interface CodexIngestEntry {
  readonly path: string;
  /**
   * `null` until the first read is authorised.
   *
   * Until v0.8.0 DoD 7.7 the size gate was the one thing that could leave it
   * null for ever; now the gate chooses a READ SHAPE instead, and every
   * transcript discovery reports gets a tail. What the gate still decides is
   * {@link oversizeTail} — head plus the last
   * `CODEX_OVERSIZE_TAIL_BYTES` (`tail.ts`), rather than the whole file.
   */
  tail: CodexFileTail | null;
  /**
   * This transcript is over `maxTranscriptBytes`, so it is read as a head plus
   * a tail with the middle skipped (DoD 7.7).
   *
   * Set by the size gate, from `stat` alone, before anything is opened. It is
   * NOT the same question as {@link partial}: this one says which shape the
   * read takes, that one says a jump really happened. They differ whenever the
   * file is over the limit and yet smaller than head + tail, which is the case
   * for any `maxTranscriptBytes` below 16.25 MiB — there the two reads cover
   * the same bytes and nothing is skipped.
   */
  oversizeTail: boolean;
  /**
   * Bytes between the end of the head and the tail's landing point: the part
   * of this transcript that was never read.
   *
   * `0` for every whole read, which is what makes it the test for "is this
   * session partial" without a second flag to keep in step.
   */
  skippedBytes: number;
  /**
   * What this transcript's session states about how much of it was read, LATCHED
   * at the jump (DoD 7.7).
   *
   * **Latched rather than live, and the reason is the wire.** `SessionPatch`
   * has no key for `partial` — `src/model/events.ts` is frozen for this phase
   * — so a figure that moved would be carried on a snapshot and never on a
   * diff, and the webview's copy would silently disagree with the host's. A
   * number that cannot change cannot disagree.
   *
   * The cost, stated: for a live session the file keeps growing and every byte
   * of that growth IS read (the tail follows it), so `readBytes` understates
   * from the moment after the jump. It names the read that established the
   * tail, which is the read the diagnostics channel announced.
   */
  partial: TranscriptPartial | null;
  /** Leading fragments dropped at this transcript's tail landing point. */
  boundaryFragments: number;
  verdict: CodexIngestVerdict;
  /**
   * Every record read from this transcript so far.
   *
   * **Emptied on a terminal verdict only** — refused, foreign, oversize. NOT
   * at end-of-file: the fingerprint and the parse both need the whole thread,
   * and an append that arrives after a drop leaves them holding the appended
   * records alone. See `index.ts`, where that shipped for an hour and is
   * written up.
   */
  records: CodexRecord[];
  /** Malformed lines across every read of this file, for the counters. */
  malformedLines: number;
  /** Set once, when `verdict` becomes `refused`. Re-reported every pass. */
  refusal: CodexRefusal | null;
  /** Set when the file could not be read, or was measured over the limit. */
  skipped: SkippedFile | null;
  /** The last COMPLETE parse. Kept and re-reported while a re-read catches up. */
  thread: CodexThread | null;
  /** {@link thread}'s counters, so a cached pass reports what a fresh one did. */
  counters: CodexCounters | null;
  /**
   * The file's size when {@link thread} was produced.
   *
   * The change detector. Discovery already `stat`s every transcript, so
   * comparing this to `CodexTranscriptRef.bytes` tells the engine whether a
   * file is worth opening — and an unchanged file is not opened at all.
   * `-1` means "no complete parse yet", which no real size can equal.
   */
  completedBytes: number;
  /**
   * The size and last-write this entry last OBSERVED, whatever its verdict.
   *
   * Distinct from {@link completedBytes}, which only a successful parse sets:
   * a refused, foreign or oversize entry has no thread and still has to notice
   * when the file underneath it is replaced. `-1` on both means "never
   * observed".
   *
   * **Why the mtime is here at all.** Size alone cannot see a file REWRITTEN
   * IN PLACE at the same length — measured, in the test that now covers it: a
   * transcript refused for `versionOutOfWindow`, replaced by a supported one
   * of the same size, kept the refusal and would have kept it for the life of
   * the window. `FileTail`'s own reset (`stats.size < offset`) has the same
   * blind spot and always has; this is strictly more than the Claude Code
   * engine detects.
   *
   * It is used ONLY as a change signal, never as content — the Phase 3
   * distinction that matters, since git does not preserve mtimes across a
   * checkout. The worst a wrong mtime can do here is cost one re-read.
   *
   * **What is still not detected**, stated rather than left to be discovered:
   * a file replaced by a LARGER one reads as an append, and the tail resumes
   * at an offset naming bytes that are no longer those bytes. That is
   * `FileTail`'s long-standing semantics for Claude Code as well, and closing
   * it needs an identity a `stat` does not carry.
   */
  sourceBytes: number;
  sourceMtimeMs: number;
}

function freshEntry(path: string): CodexIngestEntry {
  return {
    path,
    tail: null,
    oversizeTail: false,
    skippedBytes: 0,
    partial: null,
    boundaryFragments: 0,
    verdict: 'undecided',
    records: [],
    malformedLines: 0,
    refusal: null,
    skipped: null,
    thread: null,
    counters: null,
    completedBytes: -1,
    sourceBytes: -1,
    sourceMtimeMs: -1,
  };
}

/**
 * One `CodexIngestEntry` per transcript path, for the lifetime of its owner.
 *
 * Keyed by absolute path because that is what discovery hands over and what a
 * tail is bound to. Codex thread ids are NOT usable as the key: one file can
 * declare several threads (C5 — a forked child re-serialises its parent's
 * `session_meta`), and the id lives inside the file, so it is not known until
 * after the read a key would have to precede.
 */
export class CodexTailStore {
  readonly #entries = new Map<string, CodexIngestEntry>();

  /** Entries currently held. Asserted by `index.test.ts`; diagnostics otherwise. */
  get size(): number {
    return this.#entries.size;
  }

  has(path: string): boolean {
    return this.#entries.has(path);
  }

  /** The entry for `path`, created empty on first sight. */
  entry(path: string): CodexIngestEntry {
    const existing = this.#entries.get(path);
    if (existing !== undefined) return existing;
    const created = freshEntry(path);
    this.#entries.set(path, created);
    return created;
  }

  /**
   * Forget everything about `path` and start again.
   *
   * Used when a file has SHRUNK below its own tail's offset — the file was
   * replaced rather than appended to, so the offset names bytes that are no
   * longer the bytes it named. Keeping the old verdict would be worse than
   * keeping the old offset: a replaced file may be a different session, a
   * different version, or a different workspace.
   */
  reset(path: string): CodexIngestEntry {
    const created = freshEntry(path);
    this.#entries.set(path, created);
    return created;
  }

  /**
   * Drop every entry whose path is not in `paths` — the files discovery no
   * longer reports.
   *
   * Without this the map is a leak with a slow fuse: a long-lived window
   * watching a root whose day directories keep turning over would accumulate
   * one entry per transcript that has ever existed. `SessionTailer` has the
   * same requirement and meets it the same way.
   */
  retain(paths: Iterable<string>): void {
    const keep = paths instanceof Set ? paths : new Set(paths);
    for (const path of [...this.#entries.keys()]) {
      if (!keep.has(path)) this.#entries.delete(path);
    }
  }

  /** Authorise reads for `path` by giving its entry a tail. Idempotent. */
  openTail(path: string): CodexFileTail {
    const entry = this.entry(path);
    entry.tail ??= new CodexFileTail(path);
    return entry.tail;
  }
}
