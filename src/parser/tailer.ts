/**
 * Agent Deck — incremental transcript tailer.
 *
 * Reads Claude Code's on-disk exhaust and nothing else:
 *
 *   <projectsRoot>/<slug>/<sessionId>.jsonl                                main transcript
 *   <projectsRoot>/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl      subagent transcript
 *   <projectsRoot>/<slug>/<sessionId>/subagents/agent-<agentId>.meta.json  sidecar (whole-file JSON)
 *   <projectsRoot>/<slug>/<sessionId>/tool-results/<id>.txt                offloaded tool payloads
 *
 * Grounding constraints this module is held to:
 *
 *   G1  Read-only. Every handle is opened with flag 'r'. This module never
 *       creates, writes, renames or deletes anything, anywhere.
 *   G3  Refuse, don't guess. No input can make a call throw: unreadable,
 *       vanished, zero-byte, truncated, directory-where-a-file-was-expected
 *       and unterminated-line cases are all surfaced as counters or explicit
 *       result objects.
 *   G5  Zero egress. Node built-ins only; no sockets.
 *   G7  In-memory only. Byte offsets live in this object and die with the
 *       process. Nothing is persisted — there is no cache file.
 *
 * This module contains no watcher and no ambient timer. The caller drives it
 * with an explicit {@link SessionTailer.poll} and, if it wants burst
 * coalescing, wires its own change signals through {@link Debouncer}.
 */

import { Buffer } from 'node:buffer';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { SkippedFile } from '../model/events.js';

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Counters the tailer accumulates instead of throwing.
 *
 * Deliberately *not* `ParseDiagnostics` from `../model/events.js`: the tailer
 * never parses JSON, so `parsedLines` / `malformedLines` are not its counters
 * to fill — `parse.ts` owns those. `SkippedFile` is reused as-is so a skipped
 * file means the same thing on both sides of the boundary.
 */
export interface TailDiagnostics {
  /** Complete, newline-terminated, non-blank lines handed to the caller. */
  emittedLines: number;
  /** Total bytes consumed off disk since construction. */
  bytesRead: number;
  /** Files whose size shrank below the stored offset (replaced/truncated). */
  resets: number;
  /** Lines that exceeded `maxPartialBytes` and were dropped mid-line. */
  oversizedLines: number;
  /** Transcript files currently tracked (main + subagents). */
  filesTracked: number;
  /** Files that could not be read. Deduplicated by path + reason. */
  skippedFiles: SkippedFile[];
}

function emptyTailDiagnostics(): TailDiagnostics {
  return {
    emittedLines: 0,
    bytesRead: 0,
    resets: 0,
    oversizedLines: 0,
    filesTracked: 0,
    skippedFiles: [],
  };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Projects root resolution
// ---------------------------------------------------------------------------

/** Injection seams. Defaults are the real environment; tests supply fakes. */
export interface RootOptions {
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to `os.homedir`. */
  homedir?: () => string;
}

/**
 * `CLAUDE_PROJECTS_ROOT` replaces `~/.claude/projects` *entirely* when set.
 * There is no merge and no fallback in either direction: a caller that sets
 * the override reads only the override, and a caller that does not gets only
 * the home location (which may not exist — see {@link discoverSessions}).
 */
export function resolveProjectsRoot(options: RootOptions = {}): {
  root: string;
  source: 'env' | 'home';
} {
  const env = options.env ?? process.env;
  const override = env['CLAUDE_PROJECTS_ROOT'];
  if (override !== undefined && override.trim() !== '') {
    return { root: resolve(override), source: 'env' };
  }
  const home = (options.homedir ?? osHomedir)();
  return { root: join(home, '.claude', 'projects'), source: 'home' };
}

/**
 * Workspace absolute path -> CC project slug: ':' and both separators collapse
 * to '-'. Trailing separators are stripped first so `c:\ws` and `c:\ws\` slug
 * identically.
 */
export function slugifyWorkspace(workspacePath: string): string {
  const trimmed = workspacePath.replace(/[\\/]+$/, '');
  return trimmed.replace(/[:\\/]/g, '-');
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoveredSubagent {
  agentId: string;
  transcriptPath: string;
  /** Sidecar path. Computed, not existence-checked; the stitcher reads it. */
  metaPath: string;
}

export interface DiscoveredSession {
  sessionId: string;
  /** `<slugDir>/<sessionId>.jsonl` — always a real file; discovery starts here. */
  mainTranscript: string;
  /** `<slugDir>/<sessionId>/` — may not exist until a subagent spawns. */
  sessionDir: string;
  subagentsDir: string;
  toolResultsDir: string;
  subagents: DiscoveredSubagent[];
}

export type DiscoveryFailureKind =
  | 'projectsRootNotFound'
  | 'projectsRootUnreadable'
  | 'projectSlugNotFound';

/**
 * A refusal, never an empty success. `projectsRootNotFound` is ENOENT-shaped
 * on purpose: it is the negative control that proves the tailer did not
 * silently fall back to a live `~/.claude` when a fixture root was expected.
 */
export interface DiscoveryFailure {
  kind: DiscoveryFailureKind;
  /** The errno code where one exists, e.g. 'ENOENT'. */
  code: string;
  /** The path that was looked for. */
  path: string;
  message: string;
}

export interface DiscoverySuccess {
  ok: true;
  projectsRoot: string;
  rootSource: 'env' | 'home';
  /** The slug directory as spelled on disk (case may differ from the query). */
  slugDir: string;
  slug: string;
  /** The slug we searched for, before case-insensitive matching. */
  requestedSlug: string;
  sessions: DiscoveredSession[];
}

export type DiscoveryResult = DiscoverySuccess | { ok: false; failure: DiscoveryFailure };

/** `<sessionId>.jsonl`. Same shape the spike pinned against real data. */
const SESSION_FILE_RE = /^([0-9a-f][0-9a-f-]{7,})\.jsonl$/i;
/** `agent-<agentId>.jsonl`. */
const AGENT_FILE_RE = /^agent-(.+)\.jsonl$/i;

export interface DiscoverOptions extends RootOptions {
  /** Overrides `resolveProjectsRoot` entirely. Mostly for tests. */
  projectsRoot?: string;
}

/**
 * Find the sessions belonging to `workspacePath`.
 *
 * Ordering is load-bearing and is **file-first**: sessions come from
 * `<sessionId>.jsonl` FILES in the slug directory, and only then do we look
 * for the matching `<sessionId>/` directory. A directory scan would mistake
 * the sibling `<slug>/memory/` directory — present in every live tree — for a
 * session. No fixture catches that, so the ordering is enforced here and in
 * the tests, not left to convention.
 *
 * Slug matching is case-insensitive: the Windows drive letter's case varies
 * between CC versions (`c--Users-...` and `C--Users-...` both occur in real
 * data) and a case-sensitive match silently finds nothing.
 */
export async function discoverSessions(
  workspacePath: string,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  let projectsRoot: string;
  let rootSource: 'env' | 'home';
  if (options.projectsRoot !== undefined) {
    projectsRoot = resolve(options.projectsRoot);
    rootSource = 'env';
  } else {
    const resolved = resolveProjectsRoot(options);
    projectsRoot = resolved.root;
    rootSource = resolved.source;
  }

  const requestedSlug = slugifyWorkspace(workspacePath);

  let rootEntries;
  try {
    rootEntries = await readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    const code = errorCode(error);
    return {
      ok: false,
      failure: {
        kind: code === 'ENOENT' ? 'projectsRootNotFound' : 'projectsRootUnreadable',
        code,
        path: projectsRoot,
        message: `cannot read projects root ${projectsRoot}: ${errorMessage(error)}`,
      },
    };
  }

  const want = requestedSlug.toLowerCase();
  const slugEntry = rootEntries.find((e) => e.isDirectory() && e.name.toLowerCase() === want);
  if (slugEntry === undefined) {
    return {
      ok: false,
      failure: {
        kind: 'projectSlugNotFound',
        code: 'ENOENT',
        path: join(projectsRoot, requestedSlug),
        message: `no project slug directory for ${workspacePath} (looked for ${want} in ${projectsRoot})`,
      },
    };
  }

  const slugDir = join(projectsRoot, slugEntry.name);
  let slugEntries;
  try {
    slugEntries = await readdir(slugDir, { withFileTypes: true });
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: 'projectsRootUnreadable',
        code: errorCode(error),
        path: slugDir,
        message: `cannot read slug directory ${slugDir}: ${errorMessage(error)}`,
      },
    };
  }

  // Step 1 — FILES only. `memory/` and every other sibling directory is
  // structurally incapable of reaching this list.
  const sessionIds: string[] = [];
  for (const entry of slugEntries) {
    if (!entry.isFile()) continue;
    const match = SESSION_FILE_RE.exec(entry.name);
    const sessionId = match?.[1];
    if (sessionId === undefined) continue;
    sessionIds.push(sessionId);
  }
  sessionIds.sort();

  // Step 2 — only now go looking for the matching directory.
  const sessions: DiscoveredSession[] = [];
  for (const sessionId of sessionIds) {
    const sessionDir = join(slugDir, sessionId);
    const subagentsDir = join(sessionDir, 'subagents');
    sessions.push({
      sessionId,
      mainTranscript: join(slugDir, `${sessionId}.jsonl`),
      sessionDir,
      subagentsDir,
      toolResultsDir: join(sessionDir, 'tool-results'),
      subagents: await listSubagents(subagentsDir),
    });
  }

  return {
    ok: true,
    projectsRoot,
    rootSource,
    slugDir,
    slug: slugEntry.name,
    requestedSlug,
    sessions,
  };
}

/** Missing `subagents/` means "no subagents yet", not an error. */
async function listSubagents(subagentsDir: string): Promise<DiscoveredSubagent[]> {
  let entries;
  try {
    entries = await readdir(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: DiscoveredSubagent[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = AGENT_FILE_RE.exec(entry.name);
    const agentId = match?.[1];
    if (agentId === undefined) continue;
    found.push({
      agentId,
      transcriptPath: join(subagentsDir, entry.name),
      metaPath: join(subagentsDir, `agent-${agentId}.meta.json`),
    });
  }
  found.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return found;
}

// ---------------------------------------------------------------------------
// Single-file incremental tail
// ---------------------------------------------------------------------------

/** One complete line, exactly as it sat on disk. Not parsed — that is parse.ts. */
export interface TailLine {
  /** Absolute path of the transcript the line came from. */
  path: string;
  sessionId: string;
  /** `null` for the main transcript; the agent id for a subagent transcript. */
  agentId: string | null;
  /** Line content without its terminating newline (and without a trailing CR). */
  text: string;
  /** 1-based, counted across the lifetime of this tail. */
  lineNo: number;
}

export interface FileReadResult {
  lines: TailLine[];
  bytesRead: number;
  /** Set when the file shrank below the stored offset and we restarted at 0. */
  reset: boolean;
  /** Present when the file could not be read at all this round. */
  skipped?: SkippedFile;
  /** Lines dropped for exceeding `maxPartialBytes`. */
  oversized: number;
}

export interface FileTailOptions {
  sessionId: string;
  agentId?: string | null;
  /**
   * Upper bound on a single unterminated line held in memory. A transcript
   * line longer than this is dropped and the tail resynchronises at the next
   * newline rather than growing without limit. 8 MiB.
   */
  maxPartialBytes?: number;
}

const DEFAULT_MAX_PARTIAL_BYTES = 8 * 1024 * 1024;

/**
 * Incremental tail of a single append-only file.
 *
 * Byte offsets, not character offsets: `read()` asks for exactly the bytes
 * that appeared since last time, and a UTF-8 sequence split across two reads
 * is stitched by a `StringDecoder` rather than being decoded twice and
 * corrupted. A line is emitted only once its terminating newline has actually
 * arrived — the normal condition when tailing a live session is that the last
 * read ends mid-line.
 */
export class FileTail {
  readonly path: string;
  readonly sessionId: string;
  readonly agentId: string | null;

  #offset = 0;
  #lineNo = 0;
  #partial = '';
  #decoder = new StringDecoder('utf8');
  #resyncing = false;
  readonly #maxPartialBytes: number;

  constructor(path: string, options: FileTailOptions) {
    this.path = path;
    this.sessionId = options.sessionId;
    this.agentId = options.agentId ?? null;
    this.#maxPartialBytes = options.maxPartialBytes ?? DEFAULT_MAX_PARTIAL_BYTES;
  }

  /** Bytes consumed so far. In memory only; never persisted (G7). */
  get offset(): number {
    return this.#offset;
  }

  /** Bytes currently held back because their line has no newline yet. */
  get pendingBytes(): number {
    return Buffer.byteLength(this.#partial, 'utf8');
  }

  #reset(): void {
    this.#offset = 0;
    this.#partial = '';
    this.#decoder = new StringDecoder('utf8');
    this.#resyncing = false;
  }

  /**
   * Read everything appended since the previous call. Opens read-only (G1)
   * and never throws (G3) — failures come back as `skipped`.
   */
  async read(): Promise<FileReadResult> {
    const empty: FileReadResult = { lines: [], bytesRead: 0, reset: false, oversized: 0 };

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
        return { ...empty, reset };
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

      const decoded = this.#decoder.write(buffer.subarray(0, total));
      return { ...this.#consume(decoded), bytesRead: total, reset };
    } catch (error) {
      return {
        ...empty,
        skipped: {
          path: this.path,
          reason: `${errorCode(error)}: read failed (${errorMessage(error)})`,
        },
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Split decoded text into complete lines, holding any tail back. */
  #consume(decoded: string): { lines: TailLine[]; oversized: number } {
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

    const lines: TailLine[] = [];
    for (const part of parts) {
      const content = part.endsWith('\r') ? part.slice(0, -1) : part;
      if (content.trim() === '') continue; // blank separator, not a record
      this.#lineNo += 1;
      lines.push({
        path: this.path,
        sessionId: this.sessionId,
        agentId: this.agentId,
        text: content,
        lineNo: this.#lineNo,
      });
    }
    return { lines, oversized };
  }
}

// ---------------------------------------------------------------------------
// Multi-file session tail
// ---------------------------------------------------------------------------

export interface TailBatch {
  /** Complete lines from every tracked file, in file order. */
  lines: TailLine[];
  /** Transcript paths registered for the first time during this poll. */
  newFiles: string[];
  /** Cumulative counters since construction. */
  diagnostics: TailDiagnostics;
  /** Set when the discovery sweep for this poll refused. Tailing continues. */
  discoveryFailure?: DiscoveryFailure;
}

export interface SessionTailerOptions extends DiscoverOptions {
  /** Absolute path of the workspace whose sessions we tail. */
  workspacePath: string;
  /** Restrict to these session ids. Omitted = every session in the slug dir. */
  sessionIds?: readonly string[];
  maxPartialBytes?: number;
}

/**
 * Tails a workspace's main transcripts plus every `subagents/agent-*.jsonl`,
 * each with its own byte offset.
 *
 * There is no watcher here on purpose: the caller decides how change is
 * detected (fs.watch, polling, a manual refresh command) and drives this with
 * {@link poll}. That keeps the module unit-testable with no timers and no fs
 * events, and keeps the watcher's platform quirks out of the parser layer.
 */
export class SessionTailer {
  readonly workspacePath: string;

  readonly #options: SessionTailerOptions;
  readonly #sessionFilter: ReadonlySet<string> | null;
  /** absolute path -> tail. Insertion-ordered: main files precede subagents. */
  readonly #tails = new Map<string, FileTail>();
  readonly #diagnostics = emptyTailDiagnostics();
  readonly #skipKeys = new Set<string>();
  #lastDiscovery: DiscoverySuccess | null = null;

  constructor(options: SessionTailerOptions) {
    this.#options = options;
    this.workspacePath = options.workspacePath;
    this.#sessionFilter = options.sessionIds === undefined ? null : new Set(options.sessionIds);
  }

  /** Cumulative counters. Returned as a copy so callers cannot mutate state. */
  get diagnostics(): TailDiagnostics {
    return {
      ...this.#diagnostics,
      filesTracked: this.#tails.size,
      skippedFiles: [...this.#diagnostics.skippedFiles],
    };
  }

  /** Paths currently tracked, in registration order. */
  trackedFiles(): string[] {
    return [...this.#tails.keys()];
  }

  /** Byte offset for a tracked path, or `undefined` if it is not tracked. */
  offsetOf(path: string): number | undefined {
    return this.#tails.get(path)?.offset;
  }

  /** The most recent successful discovery, or `null` if none has succeeded. */
  get lastDiscovery(): DiscoverySuccess | null {
    return this.#lastDiscovery;
  }

  /**
   * Discovery sweep: register any transcript we have not seen. New subagent
   * files appear at any time during a live session, so this runs on every
   * poll and newcomers start at offset 0.
   */
  async discover(): Promise<{ newFiles: string[]; failure?: DiscoveryFailure }> {
    const result = await discoverSessions(this.workspacePath, this.#options);
    if (!result.ok) {
      return { newFiles: [], failure: result.failure };
    }
    this.#lastDiscovery = result;

    const newFiles: string[] = [];
    for (const session of result.sessions) {
      if (this.#sessionFilter !== null && !this.#sessionFilter.has(session.sessionId)) continue;
      if (this.#register(session.mainTranscript, session.sessionId, null)) {
        newFiles.push(session.mainTranscript);
      }
      for (const subagent of session.subagents) {
        if (this.#register(subagent.transcriptPath, session.sessionId, subagent.agentId)) {
          newFiles.push(subagent.transcriptPath);
        }
      }
    }
    return { newFiles };
  }

  #register(path: string, sessionId: string, agentId: string | null): boolean {
    if (this.#tails.has(path)) return false;
    const options: FileTailOptions = { sessionId, agentId };
    if (this.#options.maxPartialBytes !== undefined) {
      options.maxPartialBytes = this.#options.maxPartialBytes;
    }
    this.#tails.set(path, new FileTail(path, options));
    return true;
  }

  /**
   * "Read what's new now." Sweeps for new files, then reads every tracked
   * file from its own offset. Never throws; a discovery refusal is reported
   * on the batch and already-tracked files are still read.
   */
  async poll(): Promise<TailBatch> {
    const { newFiles, failure } = await this.discover();

    const lines: TailLine[] = [];
    for (const tail of this.#tails.values()) {
      const result = await tail.read();
      if (result.skipped !== undefined) this.#recordSkip(result.skipped);
      if (result.reset) this.#diagnostics.resets += 1;
      this.#diagnostics.bytesRead += result.bytesRead;
      this.#diagnostics.oversizedLines += result.oversized;
      this.#diagnostics.emittedLines += result.lines.length;
      for (const line of result.lines) lines.push(line);
    }
    this.#diagnostics.filesTracked = this.#tails.size;

    const batch: TailBatch = { lines, newFiles, diagnostics: this.diagnostics };
    if (failure !== undefined) batch.discoveryFailure = failure;
    return batch;
  }

  #recordSkip(skipped: SkippedFile): void {
    const key = `${skipped.path}\u0000${skipped.reason}`;
    if (this.#skipKeys.has(key)) return;
    this.#skipKeys.add(key);
    this.#diagnostics.skippedFiles.push(skipped);
  }
}

// ---------------------------------------------------------------------------
// Burst debounce
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
}

/** Opaque to callers; only the scheduler that made it may interpret it. */
export type TimerHandle = unknown;

export interface Scheduler {
  setTimer(fn: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export const systemScheduler: Scheduler = {
  setTimer: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Deterministic clock + scheduler for tests and for any caller that wants to
 * drive time explicitly. Exported because tests that depend on real
 * wall-clock timing are flaky, and every consumer of {@link Debouncer}
 * downstream will need this same seam.
 */
export class ManualTime implements Clock, Scheduler {
  #now: number;
  #seq = 0;
  readonly #timers = new Map<number, { fn: () => void; dueAt: number }>();

  constructor(startMs = 0) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimer(fn: () => void, delayMs: number): TimerHandle {
    const id = ++this.#seq;
    this.#timers.set(id, { fn, dueAt: this.#now + Math.max(0, delayMs) });
    return id;
  }

  clearTimer(handle: TimerHandle): void {
    if (typeof handle === 'number') this.#timers.delete(handle);
  }

  /** Number of timers still armed. */
  get pendingTimers(): number {
    return this.#timers.size;
  }

  /** Advance time, firing every timer that comes due, earliest first. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextDue = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.#timers) {
        if (timer.dueAt <= target && timer.dueAt < nextDue) {
          nextDue = timer.dueAt;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.#timers.get(nextId);
      this.#timers.delete(nextId);
      this.#now = nextDue;
      timer?.fn();
    }
    this.#now = target;
  }
}

export type FlushReason = 'debounce' | 'maxWait' | 'manual';

export interface FlushInfo {
  /** How many signals were coalesced into this emission. Always >= 1. */
  signals: number;
  firstSignalAt: number;
  lastSignalAt: number;
  flushedAt: number;
  reason: FlushReason;
}

export interface DebouncerOptions {
  /** Quiet period after the last signal before emitting. */
  delayMs: number;
  /**
   * Cap on how long a continuous burst may postpone an emission. Without it,
   * a session appending faster than `delayMs` would starve the UI forever.
   */
  maxWaitMs?: number;
  clock: Clock;
  scheduler: Scheduler;
  onFlush: (info: FlushInfo) => void;
}

/**
 * Coalesces a burst of change signals into one emission.
 *
 * The clock and the timer are injected, and {@link flush} forces an immediate
 * emission, so behaviour is fully determined by the caller — no test needs to
 * sleep.
 */
export class Debouncer {
  readonly #options: DebouncerOptions;
  #timer: { handle: TimerHandle } | null = null;
  #signals = 0;
  #firstSignalAt = 0;
  #lastSignalAt = 0;

  constructor(options: DebouncerOptions) {
    this.#options = options;
  }

  /** Signals coalesced so far and not yet emitted. */
  get pendingSignals(): number {
    return this.#signals;
  }

  /** Record a change. Restarts the quiet period, subject to `maxWaitMs`. */
  signal(): void {
    const now = this.#options.clock.now();
    if (this.#signals === 0) this.#firstSignalAt = now;
    this.#signals += 1;
    this.#lastSignalAt = now;

    this.#disarm();

    let delay = this.#options.delayMs;
    const maxWait = this.#options.maxWaitMs;
    if (maxWait !== undefined) {
      const remaining = this.#firstSignalAt + maxWait - now;
      delay = Math.min(delay, Math.max(0, remaining));
    }
    this.#timer = {
      handle: this.#options.scheduler.setTimer(() => {
        this.#timer = null;
        this.#fire(null);
      }, delay),
    };
  }

  /** Emit now if anything is pending. No-op otherwise. */
  flush(): void {
    this.#disarm();
    this.#fire('manual');
  }

  /** Drop pending signals without emitting. */
  cancel(): void {
    this.#disarm();
    this.#signals = 0;
  }

  #disarm(): void {
    if (this.#timer === null) return;
    this.#options.scheduler.clearTimer(this.#timer.handle);
    this.#timer = null;
  }

  #fire(forcedReason: FlushReason | null): void {
    if (this.#signals === 0) return;
    const flushedAt = this.#options.clock.now();
    const maxWait = this.#options.maxWaitMs;
    let reason: FlushReason = forcedReason ?? 'debounce';
    if (
      forcedReason === null &&
      maxWait !== undefined &&
      flushedAt < this.#lastSignalAt + this.#options.delayMs
    ) {
      reason = 'maxWait';
    }
    const info: FlushInfo = {
      signals: this.#signals,
      firstSignalAt: this.#firstSignalAt,
      lastSignalAt: this.#lastSignalAt,
      flushedAt,
      reason,
    };
    this.#signals = 0;
    this.#options.onFlush(info);
  }
}

// ---------------------------------------------------------------------------
// Read-only assertion helper
// ---------------------------------------------------------------------------

export interface TreeSnapshotEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Recursive size+mtime snapshot of a directory tree. Exists so the test suite
 * can prove G1 — that a poll changed nothing on disk — rather than asserting
 * it in prose. Read-only itself.
 */
export async function snapshotTree(root: string): Promise<TreeSnapshotEntry[]> {
  const out: TreeSnapshotEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const stats = await stat(full);
        out.push({ path: full, size: stats.size, mtimeMs: stats.mtimeMs });
      } catch {
        out.push({ path: full, size: -1, mtimeMs: -1 });
      }
    }
  };
  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Basename helper re-exported for callers building labels from paths. */
export function transcriptName(path: string): string {
  return basename(path);
}
