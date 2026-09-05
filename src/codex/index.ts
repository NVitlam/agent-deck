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

import type { SkippedFile } from '../model/events.js';
import { sameWorkspace, workspaceSlug } from '../model/correlate.js';
import { fingerprintThread } from './fingerprint.js';
import { graftCodexThreads } from './graft.js';
import { locateCodex } from './locate.js';
import { parseCodexLines, parseCodexThread } from './parse.js';
import { CodexTailStore, DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES } from './store.js';
import { CODEX_HEAD_BYTES, CODEX_READ_BATCH_BYTES } from './tail.js';
import type {
  CodexCounters,
  CodexDiscovery,
  CodexEngineOptions,
  CodexEngineOutcome,
  CodexEngineResult,
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
 *      `statSync().size`. A transcript over the limit is `skipped` with
 *      `oversize:<bytes>` and NEVER OPENED — no handle, no buffer, no parse.
 *   3. **Head first.** The first read is bounded at {@link CODEX_HEAD_BYTES},
 *      and the fingerprint and the workspace match run on it. A refused
 *      version or a foreign `cwd` is terminal: no further byte of that file is
 *      ever read, this pass or any later one.
 *   4. **Bounded batches.** Every read after the head is capped at
 *      {@link CODEX_READ_BATCH_BYTES}, so no single allocation exceeds it
 *      whatever the file's size.
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
     * — so nothing is opened and nothing is allocated.
     *
     * It applies only to a file with no tail, which is what makes the locked
     * decision "the limit gates the first read, not the tail" true: a live
     * session already being followed keeps its tail and its offset when it
     * grows past the limit, because abandoning a session mid-stream is a worse
     * answer than reading the next 4 MiB of it.
     */
    if (entry.tail === null) {
      if (ref.bytes > maxTranscriptBytes) {
        entry.verdict = 'oversize';
        entry.skipped = {
          path: ref.path,
          reason: `oversize:${String(ref.bytes)} limit=${String(maxTranscriptBytes)}`,
        };
        skipped.push(entry.skipped);
        continue;
      }
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
      malformedLines: entry.malformedLines,
      ...(options.maxPayloadBytes === undefined
        ? {}
        : { maxPayloadBytes: options.maxPayloadBytes }),
    });

    /*
     * THE RECORDS ARE DROPPED HERE, AND THAT IS THE RETENTION CONTRACT.
     *
     * `parsed.thread` carries payloads `parse.ts` has already truncated; the
     * raw records are the large thing, and holding them between passes would
     * make this hotfix a memory regression rather than a memory fix. The cost
     * is that a later append re-reads the file from zero — bounded by the size
     * gate and spread over passes by the batch ceiling — which is the trade
     * `store.ts`'s header states.
     */
    entry.records = [];
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

  return {
    sessions: grafted.sessions,
    threads,
    refused,
    skipped,
    // Amendment 2026-09-03: the golden may not exclude topology, and the
    // spawn-to-child join is the topology. graft.ts always computed these;
    // the engine simply did not pass them on.
    spawnJoins: grafted.spawnJoins,
    counters,
    discovery,
  };
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

