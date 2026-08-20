/**
 * Agent Deck — the JSONL half of the liveness merge.
 *
 * `LivenessEngine` has accepted a {@link JsonlInferenceSource} since Phase 2
 * and its merge logic is tested, but until now nothing in `src/` produced one:
 * the single production call site passes `{}`. This module is that producer.
 *
 * It answers, per session, the two facts `JsonlInference` allows and nothing
 * else.
 *
 * ---------------------------------------------------------------------------
 * `hasStopEntry`: omitted, deliberately, on the fixture evidence
 * ---------------------------------------------------------------------------
 *
 * `JsonlInference.hasStopEntry` documents `false` as "looked, none found" and
 * omission as "cannot say". We omit it, because the committed fixtures show no
 * in-transcript marker that means "this session stopped".
 *
 * Measured over every `*.jsonl` under
 * `fixtures/cc-2.1.234/projects/c--Users-dev-projects-agent-deck/`
 * — the 2 main transcripts `05c5482d-…jsonl` and `4299490e-…jsonl` plus the 5
 * `…/subagents/agent-*.jsonl` — on CC 2.1.234:
 *
 *   - Entry `type` values present: `user`, `assistant`, `attachment`,
 *     `queue-operation`, `file-history-snapshot`, `ai-title`, `last-prompt`.
 *     There is **no** `stop` entry type, and no top-level stop/end field.
 *   - The only "stop" tokens on disk are `message.stop_reason`,
 *     `message.stop_sequence` and `message.stop_details` — the Anthropic API's
 *     per-message fields, carried through verbatim — plus the literal strings
 *     `Stop` and `stop_hook_active` appearing inside message *text* (this
 *     repo's own notes about hook events), which are content, not structure.
 *   - `stop_reason: "end_turn"` is not a session terminator: it occurs at
 *     lines 21 *and* 22 of `05c5482d-…jsonl` and at lines 17 *and* 18 of
 *     `4299490e-…jsonl`. A transcript accumulates one per assistant turn, so a
 *     running session that has ever finished a turn already has one.
 *
 * The thing genuinely named `Stop` is a **hook event**, and it arrives on the
 * hook tap — `src/hooks/listener.ts` into `LivenessEngine.ingest` — not
 * through this file. Conflating the two would make every idle-but-open session
 * report as ended.
 *
 * Consequence in the engine, and it is the safe direction: with `hasStopEntry`
 * absent, `LivenessEngine.isRunning` falls to `hasStopEntry !== true` for a
 * hookless session, i.e. "still running", and `mtimeMs` recency alone decides
 * `live` vs `idle` vs `ended`. That is spec §C4's stated degradation. Emitting
 * `false` would say the same thing while pretending we looked; emitting `true`
 * off `end_turn` would mark live sessions dead. Both are G3 violations.
 *
 * Grounding constraints:
 *
 *   G1  Read-only. `statSync` and `readdirSync` only.
 *   G2  Never throws out of the source. The engine wraps the call in a
 *       try/catch and counts throws as failures; we return `undefined`
 *       instead, so a missing transcript does not read as a degraded tap.
 *   G3  Cannot say -> say nothing. No key is emitted on a guess.
 *   G6  The `hasStopEntry` decision above is fixture evidence, not recall.
 *       `inference.test.ts` re-derives it from the committed files, so if a
 *       future capture introduces a real marker the test fails rather than
 *       this comment silently going stale.
 *   G7  In-memory only; the one cache is a resolved directory name.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';

import type { JsonlInference, JsonlInferenceSource } from '../model/liveness.js';
import { resolveProjectsRoot, slugifyWorkspace } from '../parser/tailer.js';
import type { RootOptions } from '../parser/tailer.js';

// ---------------------------------------------------------------------------
// fs seam
// ---------------------------------------------------------------------------

/** Only what this module reads. Structurally satisfied by `fs.Stats`. */
export interface InferenceStats {
  isFile(): boolean;
  isDirectory(): boolean;
  mtimeMs: number;
}

/** Structurally satisfied by `fs.Dirent`. */
export interface InferenceDirent {
  name: string;
  isDirectory(): boolean;
}

/**
 * Synchronous on purpose: {@link JsonlInferenceSource} is called on every
 * liveness read and returns a value, not a promise. Both members may throw;
 * every call site here catches.
 */
export interface InferenceFs {
  statSync(path: string): InferenceStats;
  readdirSync(path: string): InferenceDirent[];
}

const nodeInferenceFs: InferenceFs = {
  statSync: (path) => statSync(path),
  readdirSync: (path) => readdirSync(path, { withFileTypes: true }),
};

// ---------------------------------------------------------------------------
// Options and diagnostics
// ---------------------------------------------------------------------------

export interface JsonlInferenceOptions extends RootOptions {
  /** Absolute path of the workspace whose sessions we report on. */
  workspacePath: string;
  /** Overrides `resolveProjectsRoot` entirely. Mostly for tests. */
  projectsRoot?: string;
  /**
   * The slug directory as spelled on disk. Supplying it (e.g. from
   * `SessionTailer.lastDiscovery.slugDir`) skips slug resolution altogether.
   */
  slugDir?: string;
  /** Injection seam for tests. Defaults to `node:fs`. */
  fs?: InferenceFs;
}

export interface InferenceDiagnostics {
  /** Calls into the source. */
  calls: number;
  /** Calls that returned an `mtimeMs`. */
  hits: number;
  /** Calls that returned `undefined`. */
  misses: number;
  /** Times the slug directory had to be resolved by scanning the root. */
  slugResolutions: number;
  /** Session ids refused by the path guard (separators, `..`, empty, NUL). */
  rejectedSessionIds: number;
  /** Unexpected fs failures. ENOENT is a miss, not an error. */
  errors: number;
  lastError?: string;
  /** The slug directory currently cached, if any. */
  slugDir?: string;
}

/** A source plus the counters it accumulates, for the host's status surface. */
export interface JsonlInferenceReader {
  readonly source: JsonlInferenceSource;
  readonly diagnostics: InferenceDiagnostics;
  /** Drop the cached slug directory. The next call re-resolves it. */
  invalidate(): void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}

/** ENOENT/ENOTDIR are ordinary "not there" answers, not tap failures. */
function isAbsence(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * A session id must name one file inside the slug directory and nothing else.
 * CC's ids are UUIDs, so this refuses rather than sanitises: an id carrying a
 * separator or `..` is not a session we know about, and following it would
 * read outside the resolved projects root.
 */
function isSafeSessionId(sessionId: string): boolean {
  if (sessionId.length === 0) return false;
  if (sessionId.includes('/') || sessionId.includes('\\')) return false;
  if (sessionId.includes('\0')) return false;
  if (sessionId === '.' || sessionId === '..') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a reader: the {@link JsonlInferenceSource} plus its counters.
 *
 * Cost per call is one `statSync` of `<slugDir>/<sessionId>.jsonl`. The slug
 * directory is resolved once and cached, because resolving it means scanning
 * the projects root case-insensitively (the Windows drive letter's case varies
 * between CC versions) and the source is called on every liveness read. The
 * cache is dropped whenever the cached directory stops being a directory, so a
 * renamed or deleted root re-resolves instead of answering from a stale name.
 *
 * No transcript is ever read: `hasStopEntry` is omitted (see the module
 * header), so there is nothing to read and nothing to invalidate on content
 * change.
 */
export function createJsonlInferenceReader(
  options: JsonlInferenceOptions,
): JsonlInferenceReader {
  const fs = options.fs ?? nodeInferenceFs;

  let projectsRoot: string;
  if (options.projectsRoot !== undefined) {
    projectsRoot = resolvePath(options.projectsRoot);
  } else {
    const rootOptions: RootOptions = {};
    if (options.env !== undefined) rootOptions.env = options.env;
    if (options.homedir !== undefined) rootOptions.homedir = options.homedir;
    projectsRoot = resolveProjectsRoot(rootOptions).root;
  }

  const requestedSlug = slugifyWorkspace(options.workspacePath);
  const pinnedSlugDir =
    options.slugDir !== undefined ? resolvePath(options.slugDir) : undefined;

  const diagnostics: InferenceDiagnostics = {
    calls: 0,
    hits: 0,
    misses: 0,
    slugResolutions: 0,
    rejectedSessionIds: 0,
    errors: 0,
  };

  let cachedSlugDir: string | undefined = pinnedSlugDir;
  if (cachedSlugDir !== undefined) diagnostics.slugDir = cachedSlugDir;

  const invalidate = (): void => {
    if (pinnedSlugDir !== undefined) return; // caller pinned it; not ours to drop
    cachedSlugDir = undefined;
    delete diagnostics.slugDir;
  };

  /** Case-insensitive slug lookup, mirroring `discoverSessions`. */
  const resolveSlugDir = (): string | undefined => {
    if (cachedSlugDir !== undefined) return cachedSlugDir;
    diagnostics.slugResolutions += 1;
    let entries: InferenceDirent[];
    try {
      entries = fs.readdirSync(projectsRoot);
    } catch (error) {
      if (!isAbsence(error)) {
        diagnostics.errors += 1;
        diagnostics.lastError = errorMessage(error);
      }
      return undefined;
    }
    const want = requestedSlug.toLowerCase();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.toLowerCase() !== want) continue;
      cachedSlugDir = join(projectsRoot, entry.name);
      diagnostics.slugDir = cachedSlugDir;
      return cachedSlugDir;
    }
    return undefined;
  };

  /** Re-resolve next time if the cached directory has gone away. */
  const dropSlugDirIfStale = (): void => {
    if (cachedSlugDir === undefined || pinnedSlugDir !== undefined) return;
    try {
      if (fs.statSync(cachedSlugDir).isDirectory()) return;
    } catch {
      // fall through: unreadable counts as gone
    }
    invalidate();
  };

  const source: JsonlInferenceSource = (sessionId: string) => {
    diagnostics.calls += 1;

    if (typeof sessionId !== 'string' || !isSafeSessionId(sessionId)) {
      diagnostics.rejectedSessionIds += 1;
      diagnostics.misses += 1;
      return undefined;
    }

    const slugDir = resolveSlugDir();
    if (slugDir === undefined) {
      diagnostics.misses += 1;
      return undefined;
    }

    const transcript = join(slugDir, `${sessionId}.jsonl`);
    // Belt and braces on top of `isSafeSessionId`: the path we are about to
    // stat must live inside the resolved root (G1's blast radius, asserted
    // rather than assumed).
    const guard = resolvePath(slugDir) + sep;
    if (!resolvePath(transcript).startsWith(guard)) {
      diagnostics.rejectedSessionIds += 1;
      diagnostics.misses += 1;
      return undefined;
    }

    let stats: InferenceStats;
    try {
      stats = fs.statSync(transcript);
    } catch (error) {
      if (!isAbsence(error)) {
        diagnostics.errors += 1;
        diagnostics.lastError = errorMessage(error);
      }
      dropSlugDirIfStale();
      diagnostics.misses += 1;
      return undefined;
    }

    if (!stats.isFile() || !Number.isFinite(stats.mtimeMs)) {
      diagnostics.misses += 1;
      return undefined;
    }

    diagnostics.hits += 1;
    // `hasStopEntry` is absent on purpose. See the module header.
    const inference: JsonlInference = { mtimeMs: stats.mtimeMs };
    return inference;
  };

  return {
    source,
    diagnostics,
    invalidate,
  };
}

/** The source alone, for callers that do not want the counters. */
export function createJsonlInferenceSource(
  options: JsonlInferenceOptions,
): JsonlInferenceSource {
  return createJsonlInferenceReader(options).source;
}
