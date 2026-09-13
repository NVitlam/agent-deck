/**
 * Agent Deck — the Codex engine's entry point (PLAN.md v0.6.0 Phase 2, DoD 2.7).
 *
 * One function chains the five packages into the production path:
 *
 *   locate.ts      env + fs walk, never-open filtered   (DoD 2.1)
 *   tail.ts        byte offsets, partial line held back (DoD 2.1)
 *   fingerprint.ts refuse or accept, per transcript     (DoD 2.2)
 *   parse.ts       records -> CodexThread, redacted     (DoD 2.3)
 *   graft.ts       threads -> SessionState trees        (DoD 2.4 / 2.6)
 *
 * `never-open.ts` is not called from here directly: `locate.ts` applies the G10
 * list during the walk, which is the only place a path can be excluded before
 * anything opens it. Chaining it a second time here would be a second
 * expression of one rule, which is the module-boundary seam this project has
 * already been bitten by.
 *
 * ---------------------------------------------------------------------------
 * `liveness.ts` IS DELIBERATELY NOT CHAINED
 * ---------------------------------------------------------------------------
 *
 * The OpenCode engine's entry point says why, and every word of it transfers:
 * liveness is a POLLING engine with an injected clock and an injected trigger,
 * and wiring it needs a host that owns both — `PLAN.md` DoD 3.2's work. A
 * one-shot read has no cursor to advance, so folding it in would mean inventing
 * a wall clock inside a function whose whole value is being a pure function of
 * the data on disk.
 *
 * The consequence is stated rather than hidden: every session this function
 * produces carries `graft.ts`'s STATIC liveness, `idle`. A committed fixture is
 * a file — no writer lock can be held and no hook event can arrive while it is
 * read — so no fixture can ever produce `live` anyway, and a clock here would
 * buy nothing but a value that moves between runs.
 *
 * ---------------------------------------------------------------------------
 * NEVER THROWS; ALWAYS RETURNS
 * ---------------------------------------------------------------------------
 *
 * `CodexEngineOutcome` has three arms and two of them are failures carried
 * rather than raised.
 *
 *   - `rootAbsent` is NOT a failure. DoD 2.1: an absent root means the engine
 *     is silently off. A machine with no Codex installed must not produce a
 *     diagnostic every poll, so this arm is the ordinary answer there.
 *   - `unreadable` is the escape hatch, and it exists because this function is
 *     called from the extension host's activation path. An uncaught throw there
 *     is an inert extension with no error a user can see — the same end state
 *     the `"type": "module"` / `.cjs` defect produced, reached by another route.
 *
 * ---------------------------------------------------------------------------
 * A TRANSCRIPT THAT PRODUCED NOTHING IS VISIBLE AT THIS BOUNDARY
 * ---------------------------------------------------------------------------
 *
 * Working-method rule 18: a reader that skips an input reports the skip. Three
 * things can happen to a discovered transcript, and all three are legible in
 * the result WITHOUT a new field on the frozen hand-off line:
 *
 *   1. it parsed        -> a {@link CodexThread} whose `owningFile` is its
 *                          basename appears in `result.threads`;
 *   2. it was refused   -> a {@link CodexRefusal} naming that basename appears
 *                          in `result.refused` (G3, DoD 2.2);
 *   3. it could not be  -> it appears in `result.discovery.transcripts` and in
 *      read, or it          NEITHER of the two lists above.
 *      declared no thread
 *
 * So `discovery.transcripts` minus `threads` minus `refused` IS the skip list,
 * computable by any caller, and `golden.test.ts` asserts that partition is
 * total. A count of zero is only evidence when something says what was looked
 * at; here the thing looked at is enumerated in the same object.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS AUDITED FOR
 * ---------------------------------------------------------------------------
 *
 * DoD 2.8: the Codex engine opens zero sockets. `src/hooks/egress.test.ts`
 * bundles the import graph rooted at THIS file and asserts it, so two
 * properties have to hold here rather than merely being true today:
 *
 *   - it imports no network-capable module, directly or transitively;
 *   - the bundled graph opens no socket at all — not even `node:http`, which
 *     the host bundle is allowed because the hook listener is the one
 *     sanctioned socket in this product. This engine has no listener and no
 *     client: it reads files.
 *
 * G1 read-only: every file on this path is opened for read by `FileTail`, and
 * the G10 never-open list is applied before anything is opened at all.
 */

import type { SessionState, SkippedFile, TranscriptPartial } from '../model/events.js';
import { sameWorkspace, workspaceSlug } from '../model/correlate.js';
import { fingerprintThread } from './fingerprint.js';
import { graftCodexThreads } from './graft.js';
import { locateCodex } from './locate.js';
import { parseCodexLines, parseCodexThread } from './parse.js';
import { CodexTailStore, DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES } from './store.js';
import {
  CODEX_HEAD_BYTES,
  CODEX_OVERSIZE_TAIL_BYTES,
  CODEX_READ_BATCH_BYTES,
} from './tail.js';
import type {
  CodexCounters,
  CodexDiscovery,
  CodexEngineOptions,
  CodexEngineOutcome,
  CodexEngineResult,
  CodexPartialTranscript,
  CodexRecord,
  CodexRefusal,
  CodexThread,
} from './types.js';

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

/** The zero of {@link CodexCounters}. Every field named, so a new one breaks here. */
function emptyCounters(): CodexCounters {
  return {
    malformedLines: 0,
    unknownRecordTypes: 0,
    reasoningDropped: 0,
    inheritedRecordsDropped: 0,
    payloadsTruncated: 0,
    skippedResponseItemTypes: [],
  };
}

/**
 * Sum two {@link CodexCounters}.
 *
 * `skippedResponseItemTypes` is a SET union, sorted, because it is a list of
 * NAMES rather than a count: two transcripts skipping the same
 * `response_item` type is one kind of skip seen twice, not two kinds. Sorted so
 * the value is comparable across runs and cannot depend on discovery order.
 */
function addCounters(a: CodexCounters, b: CodexCounters): CodexCounters {
  return {
    malformedLines: a.malformedLines + b.malformedLines,
    unknownRecordTypes: a.unknownRecordTypes + b.unknownRecordTypes,
    reasoningDropped: a.reasoningDropped + b.reasoningDropped,
    inheritedRecordsDropped: a.inheritedRecordsDropped + b.inheritedRecordsDropped,
    payloadsTruncated: a.payloadsTruncated + b.payloadsTruncated,
    skippedResponseItemTypes: [
      ...new Set([...a.skippedResponseItemTypes, ...b.skippedResponseItemTypes]),
    ].sort(),
  };
}

// ---------------------------------------------------------------------------
// The refused thread's own id
// ---------------------------------------------------------------------------

/**
 * The thread id a REFUSED transcript declares, or `''`.
 *
 * `CodexRefusal.sessionId` has to name something, and by the time a refusal
 * exists `parse.ts` has deliberately not been run — G3 refuses before it reads.
 * So one field of one record is read here, directly: the ordinal-0
 * `session_meta`'s `id`. Nothing else is taken from the record, and `''` is the
 * honest answer for the refusals where there is no such record to read
 * (`sessionMetaMissing`, `recordShapeMismatch`) rather than a guess.
 *
 * This is not a second parser. It reads one key and it never widens: anything
 * more would be believing the shape the fingerprint just rejected.
 */
function declaredThreadId(records: readonly CodexRecord[]): string {
  for (const record of records) {
    if (record.type !== 'session_meta' || record.ordinal !== 0) continue;
    const payload = record.payload;
    if (payload === null || typeof payload !== 'object') return '';
    const id = (payload as Record<string, unknown>)['id'];
    return typeof id === 'string' ? id : '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// The host's two seams
// ---------------------------------------------------------------------------

/**
 * THE PROJECT KEY (`PLAN.md` Phase 4 `Amendment 2026-08-27` A1).
 *
 * `projectSlug` is "the project key" for every engine, and it is the Claude
 * Code slug for the session's workspace path: one workspace observed by three
 * engines, one key. The path is `session_meta.payload.cwd` (spec C1) and
 * `correlate.ts` owns the encoding — `workspaceSlug` is a re-export of the
 * tailer's own `slugifyWorkspace`, so this reaches CC's encoding rather than a
 * second expression of it.
 *
 * **The drive letter's case is left as the transcript wrote it.** CC's own
 * slugs vary (`c--Users-…` and `C--Users-…` both occur in this repository's
 * history) and every comparison in `correlate.ts` is case-insensitive for
 * exactly that reason. `src/opencode/slug.ts` additionally lower-cases the
 * first character; that difference is in the KEY's spelling, never in whether
 * two keys match, and it is recorded here rather than copied blind — reaching
 * into another engine's module for a rule this one can state is how two engines
 * end up agreeing by accident.
 *
 * A thread with no `cwd` yields `''`. That is NOT a guess (G3): an unkeyed
 * session is visible and unmatched, never dropped.
 */
function codexProjectSlug(thread: CodexThread): string {
  return thread.cwd === '' ? '' : workspaceSlug(thread.cwd);
}

/**
 * Does this thread's `cwd` belong to one of the host's open folders (C1)?
 *
 * `undefined` folders means "do not filter" — every session matches, which is
 * `graft.ts`'s own default and what a one-shot read wants. Real discovery is
 * DoD 3.x's.
 *
 * `sameWorkspace` is `correlate.ts`'s comparison, which encodes BOTH sides and
 * compares case-insensitively. Comparing raw paths would fail on the drive
 * letter alone.
 */
function codexWorkspaceMatcher(
  folders: readonly string[] | undefined,
): ((thread: CodexThread) => boolean) | undefined {
  const match = codexCwdMatcher(folders);
  if (match === undefined) return undefined;
  return (thread: CodexThread) => match(thread.cwd);
}

/**
 * The same comparison, over a bare `cwd`.
 *
 * Hotfix 0.6.1 needs the workspace decision BEFORE a thread exists — it is
 * made on the 256 KiB head, from the `session_meta` at ordinal 0, so that a
 * foreign transcript is never read past it. A `CodexThread` is the output of
 * the parse this decision exists to avoid, so the matcher above cannot be the
 * one used there. This is the shared half; nothing compares paths twice.
 */
function codexCwdMatcher(
  folders: readonly string[] | undefined,
): ((cwd: string) => boolean) | undefined {
  if (folders === undefined) return undefined;
  return (cwd: string) => cwd !== '' && folders.some((folder) => sameWorkspace(folder, cwd));
}

/**
 * The `cwd` the ordinal-0 `session_meta` declares, or `''`.
 *
 * The sibling of {@link declaredThreadId} and written the same way, reading
 * the record directly rather than parsing the thread: both are answers needed
 * before a parse, from bytes a parse would be the expensive way to reach.
 * `''` is the "not stated" answer, and `codexCwdMatcher` treats it as no
 * match — a transcript that does not say where it ran cannot be claimed by a
 * workspace.
 */
function declaredCwd(records: readonly CodexRecord[]): string {
  for (const record of records) {
    if (record.type !== 'session_meta' || record.ordinal !== 0) continue;
    const payload = record.payload;
    if (payload === null || typeof payload !== 'object') return '';
    const cwd = (payload as Record<string, unknown>)['cwd'];
    return typeof cwd === 'string' ? cwd : '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// The one call
// ---------------------------------------------------------------------------

/**
 * Read one Codex data root and build its `SessionState` trees.
 *
 * Asynchronous because `tail.ts` is: it wraps the Claude Code `FileTail`, whose
 * `read()` is async, and there is no second implementation of "hold the last
 * line back until its newline arrives" in this repository. A synchronous
 * re-read here would be that second implementation.
 *
 * **Each transcript's JSON is parsed exactly once.** `parseCodexLines` produces
 * the records, the fingerprint asserts them and `parseCodexThread` consumes the
 * same array. `parseCodexTranscript` would re-parse every line, and on a corpus
 * whose defining record is 554,126 bytes on one line that is not a rounding
 * error.
 */
export async function readCodexEngine(
  options: CodexEngineOptions = {},
): Promise<CodexEngineOutcome> {
  const discovery: CodexDiscovery = locateCodex({
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  // DoD 2.1. Not an error, and not a diagnostic: the engine is off.
  if (!discovery.rootExists) return { kind: 'rootAbsent', root: discovery.root };

  try {
    return { kind: 'ok', result: await readDiscovered(discovery, options) };
  } catch (error) {
    return { kind: 'unreadable', root: discovery.root, reason: messageOf(error) };
  }
}

/**
 * The body of one pass, with the outcome's failure arms lifted out.
 *
 * ---------------------------------------------------------------------------
 * HOTFIX 0.6.1 REWROTE THIS LOOP. WHAT IT USED TO DO, AND WHY IT WAS FATAL
 * ---------------------------------------------------------------------------
 * `const tail = new CodexFileTail(ref.path)` stood at the top of this loop, so
 * every poll re-read every transcript on the machine from byte zero;
 * `FileTail.read` allocated `size - offset` — on a fresh tail, the whole file —
 * in one buffer; and the JSON was parsed BEFORE the fingerprint, with the
 * workspace match running later still inside the grafter, so a refused version
 * and a foreign workspace were both fully ingested and then discarded. Seven
 * extension-host OOM dumps, one external user, 3.11 GB of `~/.codex/sessions`.
 * `lab/docs/evidence/hotfix-0.6.1/RED.md` reproduces it at 80 MiB.
 *
 * Four changes, and they are answers to four different questions:
 *
 *   1. **Persistent tails.** {@link CodexEngineOptions.tails} carries a
 *      {@link CodexTailStore} across passes, so an unchanged file costs the
 *      `stat` discovery already took and nothing else. A call with no store
 *      gets a throwaway one and behaves exactly as this function always did,
 *      which is what keeps every golden byte-identical (DoD H.7).
 *   2. **A size gate from `stat` alone.** `ref.bytes` is discovery's own
 *      `statSync().size`, so the decision costs no syscall. Until v0.8.0 it
 *      decided whether the file was opened AT ALL; see change 5.
 *   3. **Head first.** The first read is bounded at {@link CODEX_HEAD_BYTES},
 *      and the fingerprint and the workspace match run on it. A refused
 *      version or a foreign `cwd` is terminal: no further byte of that file is
 *      ever read, this pass or any later one.
 *   4. **Bounded batches.** Every read after the head is capped at
 *      {@link CODEX_READ_BATCH_BYTES}, so no single allocation exceeds it
 *      whatever the file's size.
 *
 * ---------------------------------------------------------------------------
 * 5. HEAD PLUS TAIL FOR AN OVERSIZE TRANSCRIPT (v0.8.0 DoD 7.7)
 * ---------------------------------------------------------------------------
 * A transcript over the limit used to be measured and never opened. That was
 * right about memory and wrong about the user: the largest session on the
 * machine was the one the deck said nothing about, and the only trace was one
 * line on a channel nobody had a reason to open. G3 says refuse rather than
 * guess; it does not say refuse silently.
 *
 * Such a transcript is now read TWICE-BOUNDED — the head above, then a jump to
 * the last {@link CODEX_OVERSIZE_TAIL_BYTES} — and the session it produces
 * carries `SessionState.partial` saying how many of how many bytes were read.
 * The peak retention for one of these is `CODEX_HEAD_BYTES +
 * CODEX_OVERSIZE_TAIL_BYTES` = 16.25 MiB, a QUARTER of what a transcript under
 * the 64 MiB default may hold, so the shape is tighter than the one the size
 * gate already permits.
 *
 * **The head is not optional and a bare tail cannot work.** `fingerprintThread`
 * check 2 requires a `session_meta` at ordinal 0 and a tail has none, so a
 * bare tail refuses `sessionMetaMissing` and renders `unsupported` with no
 * tree; `declaredCwd` would come back `''` as well, so the session would never
 * match a workspace and would not reach a deck at all. The ordinals a record
 * carries are its OWN (`parse.ts` reads `ordinal` off the record rather than
 * counting positions), so head records and tail records keep their real
 * numbers with a gap between them, and no check in `fingerprintThread`
 * requires those numbers to be contiguous.
 *
 * **What is lost, stated rather than implied.** A call in the head whose
 * completion is in the gap never completes; a completion in the tail whose
 * call is in the gap has nothing to attach to. Both are the ordinary
 * consequence of not having read the middle, and both are why the session says
 * `partial` instead of presenting its counts as the session's.
 *
 * ---------------------------------------------------------------------------
 * DRAIN VERSUS BATCH, AND WHY THE STORE'S PRESENCE DECIDES IT
 * ---------------------------------------------------------------------------
 * With no store this function drains each accepted transcript to end-of-file
 * within the call, in 4 MiB steps. With a store it takes ONE batch per file per
 * pass and resumes on the next one, which is what the host wants: a 20 MiB
 * transcript arrives over five polls instead of blocking one for the whole
 * read. Both paths produce the same `SessionState` for the same bytes, and
 * `index.test.ts` asserts that against the same corpus rather than trusting
 * this sentence.
 *
 * The store's presence is the switch because it is not an independent choice:
 * batching across passes is only meaningful when something remembers the
 * offset between them.
 *
 * ---------------------------------------------------------------------------
 * THE FINGERPRINT RUNS TWICE, AND THE SECOND ONE IS NOT REDUNDANT
 * ---------------------------------------------------------------------------
 * Once on the head, to decide whether to keep reading; once at end-of-file,
 * over every record. Only the second is the verdict, and it is the same
 * verdict `v0.6.0` produced from the same bytes — `fingerprintThread`'s
 * checks 6, 7 and 8 walk the whole file, and a `callIdMissing` at ordinal 5000
 * cannot be seen from a 256 KiB head. Refusing early on a head check is sound
 * because a refusal is monotone in records: more records cannot repair a
 * record that already violated the shape.
 */
async function readDiscovered(
  discovery: CodexDiscovery,
  options: CodexEngineOptions,
): Promise<CodexEngineResult> {
  const threads: CodexThread[] = [];
  const refused: CodexRefusal[] = [];
  const skipped: SkippedFile[] = [];
  let counters = emptyCounters();

  // No store = one-shot: a throwaway map, drained to EOF, exactly as this
  // function behaved before hotfix 0.6.1. See the header.
  const store = options.tails ?? new CodexTailStore();
  const drain = options.tails === undefined;
  const maxTranscriptBytes = options.maxTranscriptBytes ?? DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES;
  // ONE comparison, reached two ways: `cwdMatch` on the head (before a thread
  // exists) and `workspaceMatch` in the grafter (which takes a thread).
  // `codexWorkspaceMatcher` delegates to `codexCwdMatcher`, so the two cannot
  // disagree about a path — which matters, because a head that says "foreign"
  // and a grafter that says "mine" would drop a session with no trace.
  const cwdMatch = codexCwdMatcher(options.workspaceFolders);
  const workspaceMatch = codexWorkspaceMatcher(options.workspaceFolders);

  // Files discovery no longer reports lose their tail and their state. Done
  // BEFORE the loop so an entry created below survives its own pass.
  store.retain(discovery.transcripts.map((ref) => ref.path));

  for (const ref of discovery.transcripts) {
    let entry = store.entry(ref.path);

    /*
     * REPLACED, NOT APPENDED TO. `FileTail` resets its own offset when a file
     * shrinks, but the VERDICT has to go with it: a replaced file may be a
     * different session, a different version or a different workspace, and
     * inheriting `refused` or `foreign` would hide a real session for the life
     * of the window.
     *
     * Two detectable shapes, and the second was found by a test rather than by
     * reasoning — a refused transcript replaced by a supported one OF THE SAME
     * SIZE kept its refusal, because size alone cannot see a rewrite in place.
     * See `CodexIngestEntry.sourceMtimeMs`, which also records the shape that
     * is still not detected.
     */
    const shrank = entry.sourceBytes >= 0 && ref.bytes < entry.sourceBytes;
    const rewritten =
      entry.sourceBytes >= 0 &&
      ref.bytes === entry.sourceBytes &&
      ref.mtimeMs !== entry.sourceMtimeMs;
    if (shrank || rewritten) entry = store.reset(ref.path);
    entry.sourceBytes = ref.bytes;
    entry.sourceMtimeMs = ref.mtimeMs;

    /*
     * THE SIZE GATE. Measured from `ref.bytes` — discovery's `statSync().size`
     * — so the decision itself costs nothing: no open, no allocation.
     *
     * It applies only to a file with no tail, which is what makes the locked
     * decision "the limit gates the first read, not the tail" true: a live
     * session already being followed keeps its tail and its offset when it
     * grows past the limit, because abandoning a session mid-stream is a worse
     * answer than reading the next 4 MiB of it.
     *
     * WHAT IT DECIDES CHANGED IN v0.8.0 DoD 7.7. It used to decide whether the
     * file was opened at all; a transcript over the limit was measured, marked
     * `oversize` and never read, so the biggest session on the machine was the
     * one the deck was silent about — one line on a channel the user had no
     * reason to open. It now decides the SHAPE of the read: over the limit
     * means head plus the last `CODEX_OVERSIZE_TAIL_BYTES`, with the middle
     * skipped, and the session says so through `SessionState.partial`.
     */
    if (entry.tail === null) {
      entry.oversizeTail = ref.bytes > maxTranscriptBytes;
      store.openTail(ref.path);
    }
    const tail = entry.tail;
    // Narrowing only: `openTail` above assigns it, and the gate is the one
    // path that leaves it null.
    if (tail === null) continue;

    // Terminal verdicts read nothing, this pass or ever. They are still
    // REPORTED every pass — a refusal that stops being reported reads as a
    // session that came right (rule 18).
    if (entry.verdict === 'refused') {
      if (entry.refusal !== null) refused.push(entry.refusal);
      counters = addCounters(counters, {
        ...emptyCounters(),
        malformedLines: entry.malformedLines,
      });
      continue;
    }
    if (entry.verdict === 'foreign') continue;
    // Terminal for the same reason and reported on the same rule as `refused`
    // above: a skip that stops being restated is a count of zero nobody can
    // tell apart from "nothing was skipped" (rule 18).
    if (entry.verdict === 'oversize') {
      if (entry.skipped !== null) skipped.push(entry.skipped);
      continue;
    }

    /*
     * NOTHING NEW: the cheapest pass there is.
     *
     * Discovery already `stat`ed this file, so this comparison costs nothing
     * and skips the open, the read, the parse and the graft. DoD H.2 asserts
     * `bytesRead === 0` on the second of two passes over an unchanged file,
     * which is the assertion this branch exists to satisfy.
     */
    if (entry.thread !== null && entry.counters !== null && ref.bytes === entry.completedBytes) {
      threads.push(entry.thread);
      counters = addCounters(counters, entry.counters);
      continue;
    }

    // --- reads -------------------------------------------------------------
    let unreadable = false;
    let atEof = false;
    for (;;) {
      const maxBytes = entry.verdict === 'undecided' ? CODEX_HEAD_BYTES : CODEX_READ_BATCH_BYTES;
      const read = await tail.read({ maxBytes });
      entry.boundaryFragments += read.boundaryFragments;

      // G3 / G2. `FileTail` reports an unreadable file as `skipped` rather
      // than throwing, and one bad file must not darken an engine. Unlike
      // `v0.6.0`, which dropped it silently, the skip is CARRIED — a reader
      // that skips an input reports the skip (rule 18).
      if (read.skipped !== undefined) {
        entry.skipped = read.skipped;
        skipped.push(read.skipped);
        unreadable = true;
        break;
      }

      const lines = parseCodexLines(read.lines.map((line) => line.text));
      // Not `push(...records)`: spreading a large array into an argument list
      // is a stack overflow waiting for a big batch.
      for (const record of lines.records) entry.records.push(record);
      entry.malformedLines += lines.malformedLines;

      /*
       * THE HEAD DECISION. Made as soon as there is anything to decide on, and
       * NOT made on an empty head: a first line longer than
       * `CODEX_HEAD_BYTES` is a shape nobody has observed, and answering
       * "no `session_meta`" to "I have not reached the first newline yet"
       * would be guessing in the direction G3 forbids.
       */
      if (entry.verdict === 'undecided' && entry.records.length > 0) {
        const head = fingerprintThread(entry.records, { file: ref.file });
        if (!head.ok) {
          entry.verdict = 'refused';
          entry.refusal = {
            sessionId: declaredThreadId(entry.records),
            file: ref.file,
            mismatch: head.mismatch,
          };
          entry.records = [];
          break;
        }
        if (cwdMatch !== undefined && !cwdMatch(declaredCwd(entry.records))) {
          entry.verdict = 'foreign';
          entry.records = [];
          break;
        }
        entry.verdict = 'accepted';

        /*
         * THE JUMP. Made here and nowhere else: the head has been read and
         * believed, so everything the fingerprint and the workspace match need
         * is already in `entry.records`, and the bytes between here and the
         * last `CODEX_OVERSIZE_TAIL_BYTES` are the ones nobody will read.
         *
         * `skipTo` is forward-only and returns where it will read next, so a
         * file smaller than head + tail lands back on the current offset,
         * `skippedBytes` stays 0 and the read is a whole read. That is not a
         * special case handled here — it is the arithmetic, and it is the
         * reason `oversizeTail` and `partial` are two different fields.
         */
        if (entry.oversizeTail) {
          const before = tail.offset;
          const landed = tail.skipTo(ref.bytes - CODEX_OVERSIZE_TAIL_BYTES);
          entry.skippedBytes = landed - before;
          if (entry.skippedBytes > 0) {
            entry.partial = {
              readBytes: ref.bytes - entry.skippedBytes,
              totalBytes: ref.bytes,
            };
          }
        }
      }

      /*
       * THE HEAD BUDGET IS ONE HEAD FOR AN OVERSIZE TRANSCRIPT (DoD 7.7).
       *
       * Checked AFTER the head has been read and had its chance to decide, so
       * the verdict lands in the pass that spent the budget rather than in the
       * next one — with a store this loop takes one read per pass, and a check
       * at the top would report a decided-nothing file a poll late.
       *
       * For an ordinary file an undecided verdict means "read more": a head
       * that ends mid-first-line is answered by another head, and the file is
       * bounded by `maxTranscriptBytes` so that cannot run away. An oversize
       * file has no such bound — it is the size the gate exists not to
       * allocate — so a first line longer than `CODEX_HEAD_BYTES` would buy
       * one head per poll for the life of the window and, in the drained
       * one-shot path, the whole file in one call.
       *
       * So it is terminal, counted and reported rather than retried. The
       * measurement that makes it near-unreachable is on `CODEX_HEAD_BYTES`
       * itself: the largest ordinal-0 record across the 14 committed
       * transcripts is 1,113 bytes, and the head is ~236x that.
       */
      if (entry.verdict === 'undecided' && entry.oversizeTail && tail.offset >= CODEX_HEAD_BYTES) {
        entry.verdict = 'oversize';
        entry.records = [];
        entry.skipped = {
          path: ref.path,
          reason:
            `oversizeHeadUndecided:${String(ref.bytes)} ` +
            `limit=${String(maxTranscriptBytes)} head=${String(CODEX_HEAD_BYTES)}`,
        };
        break;
      }

      if (tail.offset >= ref.bytes) {
        atEof = true;
        break;
      }
      // The file did not give us what its size promised — a live truncation, a
      // read that came up short. Stop; the next pass re-measures.
      if (read.bytesRead === 0) break;
      if (!drain) break;
    }

    if (unreadable) continue;
    if (entry.verdict === 'refused') {
      if (entry.refusal !== null) refused.push(entry.refusal);
      counters = addCounters(counters, {
        ...emptyCounters(),
        malformedLines: entry.malformedLines,
      });
      continue;
    }
    if (entry.verdict === 'foreign') continue;
    if (entry.verdict === 'oversize') {
      if (entry.skipped !== null) skipped.push(entry.skipped);
      continue;
    }

    /*
     * INCOMPLETE: keep reporting the last COMPLETE parse and say nothing new.
     *
     * A partial tree from a partial file is the thing G3 exists to forbid, and
     * a session that vanished from the deck for four polls while a 20 MiB
     * append caught up would be a worse defect than the one being fixed.
     */
    if (!atEof) {
      if (entry.thread !== null && entry.counters !== null) {
        threads.push(entry.thread);
        counters = addCounters(counters, entry.counters);
      }
      continue;
    }

    /*
     * FINGERPRINT FIRST, ALWAYS (G3: refuse, don't guess).
     *
     * A refused transcript is not parsed at all — a partial tree from a shape
     * we do not trust is the thing G3 exists to forbid. Its malformed-line
     * count is still added below, because "how many lines of this root did not
     * parse as JSON" is a fact about the read rather than about the tree.
     *
     * This is the whole-file verdict, and it is the same one `v0.6.0` reached
     * from the same bytes. The head check above is an early exit, not a
     * replacement for it.
     */
    const fingerprint = fingerprintThread(entry.records, { file: ref.file });
    if (!fingerprint.ok) {
      entry.verdict = 'refused';
      entry.refusal = {
        sessionId: declaredThreadId(entry.records),
        file: ref.file,
        mismatch: fingerprint.mismatch,
      };
      entry.records = [];
      refused.push(entry.refusal);
      counters = addCounters(counters, {
        ...emptyCounters(),
        malformedLines: entry.malformedLines,
      });
      continue;
    }

    const parsed = parseCodexThread(entry.records, {
      file: ref.file,
      mtimeMs: ref.mtimeMs,
      // DoD 4.11c: the size from the SAME discovery stat as the mtime above.
      // `ref.bytes` is already what the tailer's byte offsets rest on, so this
      // is one number reaching a second consumer rather than a second stat.
      sizeBytes: ref.bytes,
      malformedLines: entry.malformedLines,
      ...(options.maxPayloadBytes === undefined
        ? {}
        : { maxPayloadBytes: options.maxPayloadBytes }),
    });

    /*
     * THE RECORDS ARE KEPT, AND THE FIRST DRAFT OF THIS HOTFIX DROPPED THEM.
     *
     * Dropping them here was a SHIPPING DEFECT and it is worth writing down in
     * full, because it was introduced by a memory fix and it destroyed every
     * live session:
     *
     *   pass 1  the file is read whole, parsed, records dropped, session shown
     *   pass 2  the session appends; the tail reads ONLY the new bytes
     *   pass 3  at EOF `fingerprintThread` runs over those new records alone —
     *           which contain no `session_meta` at ordinal 0 — and refuses
     *           `sessionMetaMissing`, TERMINALLY. The card vanishes and never
     *           comes back.
     *
     * Measured through the production entry point: `sessions=1, 1, 1, 0` with
     * `refused=[sessionMetaMissing]` from pass 4 onward. The comment that used
     * to sit here claimed "a later append re-reads the file from zero", and
     * nothing did: only a SHRINK or a same-size rewrite resets a tail, and an
     * append is neither. A comment and the code disagreeing, in the same file.
     *
     * So the records stay, and the retention that buys is stated rather than
     * hidden:
     *
     *   - **Bounded by the size gate**, which is what the gate is for: no
     *     entry can hold more than `maxTranscriptBytes` of source.
     *   - **Bounded by the workspace**, because the head decision drops a
     *     foreign transcript before a single record of it is kept. `v0.6.0`
     *     had no such bound — it read every transcript on the machine, once a
     *     second, and retained a `CodexThread` for each.
     *   - **Zero for refused, foreign and oversize entries**, which is where
     *     the drops that remain are.
     *
     * The alternative — drop them and re-read from zero on every append — was
     * rejected after the defect was found: it is correct, and it re-reads an
     * entire live transcript every time it grows, which for a long session is
     * the I/O this hotfix exists to remove.
     */
    entry.thread = parsed.thread;
    entry.counters = parsed.counters;
    entry.completedBytes = ref.bytes;

    /*
     * EVERY transcript's counters are summed, refusals included.
     *
     * The OpenCode engine takes the same decision for the same reason: filtering
     * first would make the counter mean "of the sessions that rendered", a
     * different and less useful number. Note that this therefore does NOT equal
     * `graftCodexThreads`'s own `counters`, which sums the threads it was
     * handed — a deliberate difference, not a drift.
     */
    counters = addCounters(counters, parsed.counters);
    if (parsed.thread !== null) threads.push(parsed.thread);
  }

  const grafted = graftCodexThreads({
    threads,
    options: {
      projectSlug: codexProjectSlug,
      ...(workspaceMatch === undefined ? {} : { workspaceMatch }),
    },
  });

  /*
   * THE PARTIAL CENSUS, TAKEN FROM THE STORE RATHER THAN ACCUMULATED IN THE
   * LOOP (DoD 7.7).
   *
   * The loop above leaves by six different `continue`s, so a push inside it
   * would have to be repeated at each one and would be missing from whichever
   * arm a later edit adds. Every discovered transcript has an entry by the
   * time this runs — `store.retain` ran before the loop and the loop's first
   * statement takes one — so this is a read of state the loop already wrote.
   *
   * It is a CENSUS OF THE PASS: an entry that is partial is reported every
   * pass, including the passes where nothing was read because nothing changed.
   *
   * **A COMPLETE PARSE IS REQUIRED, and that is not tidiness.** An entry is
   * counted here from the pass its `thread` first exists, not from the pass
   * its jump happened, because until then there is no session for the figures
   * to be about — and, concretely, `boundaryFragments` has not settled: the
   * fragment at the landing point is dropped when its newline arrives, which
   * is the tail's first read and not the head's. Reporting at the jump
   * published a `fragments: 0` that became 1 one pass later, and the host
   * announces a partial transcript exactly ONCE, so the 0 would have been the
   * only number a user ever saw.
   */
  const partialTranscripts: CodexPartialTranscript[] = [];
  const partialByFile = new Map<string, TranscriptPartial>();
  const bytesByFile = new Map<string, number>();
  for (const ref of discovery.transcripts) {
    bytesByFile.set(ref.file, ref.bytes);
    const entry = store.entry(ref.path);
    if (entry.partial === null || entry.thread === null) continue;
    partialByFile.set(ref.file, entry.partial);
    partialTranscripts.push({
      path: ref.path,
      file: ref.file,
      readBytes: entry.partial.readBytes,
      totalBytes: entry.partial.totalBytes,
      boundaryFragments: entry.boundaryFragments,
    });
  }

  return {
    sessions:
      partialByFile.size === 0
        ? grafted.sessions
        : markPartialSessions(grafted.sessions, threads, partialByFile, bytesByFile),
    threads,
    refused,
    skipped,
    partialTranscripts,
    // Amendment 2026-09-03: the golden may not exclude topology, and the
    // spawn-to-child join is the topology. graft.ts always computed these;
    // the engine simply did not pass them on.
    spawnJoins: grafted.spawnJoins,
    counters,
    discovery,
  };
}

/**
 * Stamp `SessionState.partial` onto every session built from a partial read
 * (v0.8.0 DoD 7.7).
 *
 * ## Why this is per SESSION and the read is per FILE
 *
 * A Codex session is a root thread plus its subagents, and each of those is
 * its own transcript (spec C1). So "how much of this session was read" is a
 * sum over the FILES its threads came from — and over files, not threads,
 * because one file can declare several threads (C5: a forked child
 * re-serialises its parent's `session_meta`) and summing per thread would
 * count that file twice. `owningFile` is the file whose ordinal-0
 * `session_meta` declares the thread — the one whose records count — so a
 * thread re-serialised into a second file does not drag that file in.
 *
 * A file that was read whole contributes its own size to both numbers, so a
 * session with one partial transcript and three whole ones reports the whole
 * ones honestly instead of hiding them. `readBytes === totalBytes` is
 * therefore not a possible output here: the function is only reached for
 * sessions holding at least one partial file, and such a file has
 * `readBytes < totalBytes` by construction.
 *
 * A session none of whose files is partial is returned UNCHANGED, by identity
 * — no copy, no `partial: undefined` key — because absence is what "read
 * whole" means on the wire and a key present-and-undefined is a different
 * claim from a key absent.
 */
function markPartialSessions(
  sessions: readonly SessionState[],
  threads: readonly CodexThread[],
  partialByFile: ReadonlyMap<string, TranscriptPartial>,
  bytesByFile: ReadonlyMap<string, number>,
): readonly SessionState[] {
  const filesBySession = new Map<string, Set<string>>();
  for (const thread of threads) {
    const files = filesBySession.get(thread.sessionId) ?? new Set<string>();
    files.add(thread.owningFile);
    filesBySession.set(thread.sessionId, files);
  }

  return sessions.map((session) => {
    const files = filesBySession.get(session.sessionId);
    if (files === undefined) return session;
    let readBytes = 0;
    let totalBytes = 0;
    let anyPartial = false;
    for (const file of files) {
      const partial = partialByFile.get(file);
      if (partial !== undefined) {
        anyPartial = true;
        readBytes += partial.readBytes;
        totalBytes += partial.totalBytes;
        continue;
      }
      // Read whole: it contributes the same number to both sides. `0` for a
      // file discovery no longer reports is the honest fallback — a file that
      // is gone contributed bytes nobody can measure now.
      const whole = bytesByFile.get(file) ?? 0;
      readBytes += whole;
      totalBytes += whole;
    }
    if (!anyPartial) return session;
    return { ...session, partial: { readBytes, totalBytes } };
  });
}

/** The message off anything `catch` can hand us, without a stack. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Re-exports — the engine's public surface, named in one place
// ---------------------------------------------------------------------------

export { PINNED_CODEX_VERSION, CODEX_VERSION_WINDOW } from './fingerprint.js';
export { CODEX_HOME_VAR, resolveCodexRoot } from './locate.js';
export { CODEX_NEVER_OPEN } from './never-open.js';
export type {
  CodexCounters,
  CodexDiscovery,
  CodexEngineOptions,
  CodexEngineOutcome,
  CodexEngineResult,
  CodexRefusal,
  CodexThread,
} from './types.js';

