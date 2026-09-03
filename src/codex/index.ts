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

import { sameWorkspace, workspaceSlug } from '../model/correlate.js';
import { fingerprintThread } from './fingerprint.js';
import { graftCodexThreads } from './graft.js';
import { locateCodex } from './locate.js';
import { parseCodexLines, parseCodexThread } from './parse.js';
import { CodexFileTail } from './tail.js';
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
  if (folders === undefined) return undefined;
  return (thread: CodexThread) =>
    thread.cwd !== '' && folders.some((folder) => sameWorkspace(folder, thread.cwd));
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

/** The body of one pass, with the outcome's failure arms lifted out. */
async function readDiscovered(
  discovery: CodexDiscovery,
  options: CodexEngineOptions,
): Promise<CodexEngineResult> {
  const threads: CodexThread[] = [];
  const refused: CodexRefusal[] = [];
  let counters = emptyCounters();

  for (const ref of discovery.transcripts) {
    const tail = new CodexFileTail(ref.path);
    const read = await tail.read();
    // G3 / G2. `FileTail` reports an unreadable file as `skipped` rather than
    // throwing, and one bad file must not darken an engine. It contributes no
    // thread and no refusal, which is precisely how the header's three-way
    // partition makes it visible to the caller.
    if (read.skipped !== undefined) continue;

    const lines = parseCodexLines(read.lines.map((line) => line.text));

    /*
     * FINGERPRINT FIRST, ALWAYS (G3: refuse, don't guess).
     *
     * A refused transcript is not parsed at all — a partial tree from a shape
     * we do not trust is the thing G3 exists to forbid. Its malformed-line
     * count is still added below, because "how many lines of this root did not
     * parse as JSON" is a fact about the read rather than about the tree.
     */
    const fingerprint = fingerprintThread(lines.records, { file: ref.file });
    if (!fingerprint.ok) {
      refused.push({
        sessionId: declaredThreadId(lines.records),
        file: ref.file,
        mismatch: fingerprint.mismatch,
      });
      counters = addCounters(counters, { ...emptyCounters(), malformedLines: lines.malformedLines });
      continue;
    }

    const parsed = parseCodexThread(lines.records, {
      file: ref.file,
      mtimeMs: ref.mtimeMs,
      malformedLines: lines.malformedLines,
      ...(options.maxPayloadBytes === undefined
        ? {}
        : { maxPayloadBytes: options.maxPayloadBytes }),
    });

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

  const workspaceMatch = codexWorkspaceMatcher(options.workspaceFolders);
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

