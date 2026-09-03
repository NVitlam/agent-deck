/**
 * Agent Deck — Codex data-root resolution and transcript discovery
 * (PLAN.md v0.6.0 Phase 2, DoD 2.1).
 *
 * Spec C1:
 *
 *   > The data root is `$CODEX_HOME` when set, otherwise `~/.codex`, resolved
 *   > at read time. This is not a convenience: `CODEX_HOME` relocates the
 *   > entire surface — sessions, writer locks, `hooks.json` and the credential
 *   > file — so an engine that hard-codes the home location observes nothing at
 *   > all for such a user.
 *
 * ---------------------------------------------------------------------------
 * THREE PROPERTIES THIS MODULE EXISTS TO HOLD
 * ---------------------------------------------------------------------------
 *
 * **1. Resolved at READ time, from an injected environment.** Nothing here is
 * captured at module load. A module-scope `const ROOT = ...` would be resolved
 * once per extension-host process, so a user who set the variable after the
 * host started, or a test that faked it, would be observed against a stale
 * root — and the failure is silence, not an error.
 *
 * **2. The home fallback is PLATFORM-FAITHFUL, and that is a test property.**
 * `os.homedir()` reads `USERPROFILE` on Windows and `HOME` on POSIX.
 * {@link resolveCodexRoot} consults exactly the one its platform would, so the
 * recorded trap stays visible:
 *
 *   > The negative control needs `USERPROFILE` faked, not just `HOME`. Faking
 *   > only `HOME` runs happily against the REAL home and reports a green,
 *   > confident, completely false pass.
 *
 * Reading both would hide it: a test faking only the decoy would pass, and the
 * check whose entire purpose is proving we never touch the real home would be
 * measuring nothing. `locate.test.ts` asserts the decoy alone does NOT move the
 * root, which is the assertion that goes red if this is ever "helpfully"
 * widened.
 *
 * **3. An absent root is a VALUE, not an error.** DoD 2.1: the engine is
 * silently off and logs once at info. A machine with no Codex installed must
 * not produce a diagnostic every poll — and it must not throw, because the
 * poll that throws takes the other two engines' rendering with it (G2).
 *
 * ---------------------------------------------------------------------------
 * THE WALK
 * ---------------------------------------------------------------------------
 *
 * `<root>/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl`. Spec C1: the date
 * directories are keyed on the day a thread STARTED, so a session running past
 * midnight puts a child under a different day from its parent. **Discovery
 * walks the tree; it never reads a single day directory** and never composes
 * today's date. `locate.test.ts` plants a transcript under a day that is not
 * today and asserts it is found.
 *
 * The walk carries no idea of what a subagent is, on purpose. Spec C1: a
 * subagent's transcript is a SIBLING of its parent's, with nothing in the path
 * marking it — so a discovery pass that classifies by path cannot work, and
 * {@link CodexTranscriptRef} has nowhere to put such a classification.
 *
 * G10: every directory entry is tested by name BEFORE it is joined, stat'ed or
 * descended into ({@link isNeverOpenName}). The forbidden names are not spelled
 * anywhere in this file — see `never-open.ts` for why that is load-bearing
 * rather than fastidious.
 *
 * G1: read-only. `statSync` and `readdirSync` and nothing else. No handle is
 * opened here at all; the transcripts are read by `tail.ts`.
 * G5: node built-ins only, no sockets.
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

import type { CodexDiscovery, CodexTranscriptRef } from './types.js';
import { isNeverOpenName } from './never-open.js';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** The environment variable that relocates the entire Codex surface (C1). */
export const CODEX_HOME_VAR = 'CODEX_HOME';

/** The home-relative default, used only when {@link CODEX_HOME_VAR} is unset. */
export const CODEX_DEFAULT_DIR_NAME = '.codex';

/** `<root>/sessions` — the only content the engine reads. */
export const CODEX_SESSIONS_DIR_NAME = 'sessions';

/** `<root>/thread-writer-locks` — read by `liveness.ts`, not by this module. */
export const CODEX_LOCK_DIR_NAME = 'thread-writer-locks';

/**
 * `rollout-<ISO-ts>-<uuid>.jsonl`.
 *
 * Deliberately loose about the middle: the timestamp spelling and the uuid
 * version are Codex's business, and a pattern that pinned them would turn a
 * cosmetic change in a filename into a machine with no sessions. The parts that
 * matter are the prefix (which distinguishes a transcript from anything else
 * Codex may one day put in a day directory) and the extension.
 */
export const CODEX_ROLLOUT_FILE_RE = /^rollout-.+\.jsonl$/i;

/**
 * How deep below `<root>/sessions` the observed corpus puts a transcript:
 * `YYYY`, `MM`, `DD`.
 *
 * Documentation and a test anchor, **not** a rule the walk enforces. A
 * transcript found shallower or deeper is still reported, with `day` carrying
 * the segments actually walked. Pinning the depth would turn a Codex that
 * regroups its sessions into a machine with none.
 */
export const CODEX_DAY_DEPTH = 3;

/**
 * Hard stop on recursion below `sessions/`, whatever the tree holds. Not a
 * schema either — it is the thing that stops a symlink loop or a pathological
 * tree from spinning a poll forever.
 */
const MAX_WALK_DEPTH = 8;

// ---------------------------------------------------------------------------
// The fs seam
// ---------------------------------------------------------------------------

/** Only what this module reads. Structurally satisfied by `fs.Stats`. */
export interface CodexLocateStats {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtimeMs: number;
}

/** Structurally satisfied by `fs.Dirent`. */
export interface CodexLocateDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * Synchronous, like `src/watch/inference.ts`'s seam and for the same reason:
 * discovery is called on a poll and returns a value, not a promise. Both
 * members may throw; every call site here catches.
 *
 * It is a seam rather than a convenience. A test can record every path this
 * module hands to the filesystem and assert the G10 list never appears among
 * them — which is an enforcement of "never opened", not a proxy for it.
 */
export interface CodexLocateFs {
  statSync(path: string): CodexLocateStats;
  readdirSync(path: string): CodexLocateDirent[];
}

const nodeLocateFs: CodexLocateFs = {
  statSync: (path) => statSync(path),
  readdirSync: (path) => readdirSync(path, { withFileTypes: true }),
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * The one thing DoD 2.1 asks to be logged, and the levels it may be logged at.
 *
 * `info`, not `warn`: a machine without Codex is the normal case, not a
 * degradation. The reason travels beside the level so a reader of the log
 * never has to infer why the engine went quiet — rule 18's "a check that skips
 * an input must say so", applied to an engine that skips a whole machine.
 */
export interface CodexLocateLogRecord {
  readonly level: 'info';
  readonly event: 'rootAbsent';
  readonly root: string;
  readonly rootSource: CodexDiscovery['rootSource'];
  readonly message: string;
}

export type CodexLocateLogger = (record: CodexLocateLogRecord) => void;

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

export interface CodexRootOptions {
  /**
   * The environment to resolve against. Defaults to `process.env`.
   *
   * An explicit data root is expressed as `{ CODEX_HOME: '<path>' }` rather
   * than as a separate `root` option, because that is precisely what the
   * variable means (C1) — and because {@link CodexDiscovery.rootSource} has two
   * members, so a third source of truth would have to be reported as a lie.
   */
  readonly env?: NodeJS.ProcessEnv;
}

export interface CodexResolvedRoot {
  readonly root: string;
  readonly rootSource: CodexDiscovery['rootSource'];
}

/**
 * The home directory, read from `env` the way `os.homedir()` reads
 * `process.env` — one variable, chosen by platform. See property 2 in the file
 * header for why consulting both would destroy a test rather than improve it.
 */
function homeFromEnv(env: NodeJS.ProcessEnv): string {
  const name = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const value = env[name];
  if (typeof value === 'string' && value.trim() !== '') return value;
  // `env` said nothing. Fall back to node's own answer, which on a real
  // process is the same variable plus a syscall.
  return osHomedir();
}

/**
 * `$CODEX_HOME` when set and non-empty, else `<home>/.codex`. Resolved on every
 * call; nothing is memoised (property 1).
 *
 * An empty or whitespace-only `CODEX_HOME` is treated as unset. A variable set
 * to the empty string is how a shell spells "I cleared this", and honouring it
 * literally would resolve the root to `sessions` relative to the process cwd —
 * a wrong answer that reads as a Codex with no sessions.
 */
export function resolveCodexRoot(options: CodexRootOptions = {}): CodexResolvedRoot {
  const env = options.env ?? process.env;
  const fromVar = env[CODEX_HOME_VAR];
  if (typeof fromVar === 'string' && fromVar.trim() !== '') {
    return { root: fromVar, rootSource: 'CODEX_HOME' };
  }
  return { root: join(homeFromEnv(env), CODEX_DEFAULT_DIR_NAME), rootSource: 'homedir' };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface CodexLocateOptions extends CodexRootOptions {
  /** Injection seam for tests. Defaults to `node:fs`. */
  readonly fs?: CodexLocateFs;
}

/**
 * One discovery pass. Never throws (G3): an unreadable root, an unreadable day
 * directory and a vanished file are all absorbed, and the result is whatever
 * was legibly there.
 *
 * `rootExists: false` with an empty `transcripts` is the normal state on a
 * machine with no Codex. It is NOT distinguished here from a root that exists
 * but holds no `sessions` directory — that one reports `rootExists: true` with
 * no transcripts, which is a different fact and is the one a user who has
 * installed Codex but never run it will see.
 */
export function locateCodex(options: CodexLocateOptions = {}): CodexDiscovery {
  const fs = options.fs ?? nodeLocateFs;
  const { root, rootSource } = resolveCodexRoot(options);
  const lockDir = join(root, CODEX_LOCK_DIR_NAME);

  if (!isDirectory(fs, root)) {
    return { root, rootSource, rootExists: false, transcripts: [], lockDir };
  }

  const sessionsDir = join(root, CODEX_SESSIONS_DIR_NAME);
  const transcripts: CodexTranscriptRef[] = [];
  if (isDirectory(fs, sessionsDir)) {
    walk(fs, sessionsDir, [], transcripts, 0);
  }

  // Stable across polls and across platforms: `readdirSync` order is the
  // filesystem's, and a caller diffing two discoveries must not see a reorder
  // reported as a change.
  transcripts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { root, rootSource, rootExists: true, transcripts, lockDir };
}

function isDirectory(fs: CodexLocateFs, path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Depth-first walk below `sessions/`, accumulating rollout files.
 *
 * `relative` is the segments walked so far, so `day` is reported as the tree
 * spelled it rather than as a date this module composed. That distinction is
 * the whole of "it never reads a single day directory": there is no place here
 * where a `YYYY/MM/DD` could be built from a clock.
 */
function walk(
  fs: CodexLocateFs,
  dir: string,
  relative: readonly string[],
  out: CodexTranscriptRef[],
  depth: number,
): void {
  if (depth > MAX_WALK_DEPTH) return;

  let entries: CodexLocateDirent[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // G3: an unreadable directory is empty, not fatal.
  }

  for (const entry of entries) {
    // G10, and the order matters: the name is judged BEFORE anything is
    // joined, stat'ed or descended into. There is no point at which a
    // forbidden path exists as a string that has been handed to the
    // filesystem.
    if (isNeverOpenName(entry.name)) continue;

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(fs, full, [...relative, entry.name], out, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!CODEX_ROLLOUT_FILE_RE.test(entry.name)) continue;

    let stats: CodexLocateStats;
    try {
      stats = fs.statSync(full);
    } catch {
      continue; // vanished between readdir and stat: it is simply not there.
    }
    if (!stats.isFile()) continue;

    out.push({
      path: full,
      file: entry.name,
      day: relative.join('/'),
      bytes: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  }
}

// ---------------------------------------------------------------------------
// The once-latch
// ---------------------------------------------------------------------------

export interface CodexLocatorOptions extends CodexLocateOptions {
  /**
   * Where the one absent-root line goes. Omitted means nothing is logged at
   * all, which is the right default for a library: this module must not reach
   * for a global console, because a host that wants the line in its own output
   * channel would then get it twice and a test could not count it.
   */
  readonly log?: CodexLocateLogger;
}

/**
 * A locator that carries the "logged once" of DoD 2.1 across polls.
 *
 * {@link locateCodex} is a pure function of the environment and the filesystem
 * and has no memory, which is what makes it testable. The latch has to live
 * somewhere, so it lives here rather than in a module-scope boolean — a global
 * would be shared between the extension host's engines and between a test file's
 * cases, and "exactly once" is not assertable against shared state.
 *
 * **The latch is per resolved root, and it CLEARS when the root appears.** A
 * user who installs Codex mid-session, then uninstalls it, gets one line each
 * time it goes away rather than one line ever: the second disappearance is new
 * information. The alternative — latch forever — is silence about a state
 * change, which is the fail-open reading rule 18 exists to refuse.
 */
export class CodexLocator {
  readonly #options: CodexLocatorOptions;
  #loggedAbsentRoot: string | null = null;

  constructor(options: CodexLocatorOptions = {}) {
    this.#options = options;
  }

  /** Runs one discovery pass and logs the absent root at most once per absence. */
  locate(): CodexDiscovery {
    const discovery = locateCodex(this.#options);

    if (discovery.rootExists) {
      this.#loggedAbsentRoot = null;
      return discovery;
    }

    if (this.#loggedAbsentRoot !== discovery.root) {
      this.#loggedAbsentRoot = discovery.root;
      this.#options.log?.({
        level: 'info',
        event: 'rootAbsent',
        root: discovery.root,
        rootSource: discovery.rootSource,
        message:
          `no Codex data root at ${discovery.root} ` +
          `(from ${discovery.rootSource}); the Codex engine is off`,
      });
    }

    return discovery;
  }

  /** Whether the absent-root line has been emitted for the current absence. */
  get hasLoggedAbsentRoot(): boolean {
    return this.#loggedAbsentRoot !== null;
  }
}
