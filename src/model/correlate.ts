/**
 * Agent Deck — workspace/session correlator.
 *
 * Answers exactly three questions and nothing else:
 *
 *   1. Which CC project slug encodes the workspace VS Code has open?
 *   2. Which sessions belong to that slug — and only that slug?
 *   3. Given a `session_id` / `transcript_path` from a hook event, is it one
 *      of those sessions?
 *
 * Grounding constraints this module is held to:
 *
 *   G1  Read-only. This module opens nothing for write and creates nothing.
 *       Its only filesystem access is delegated to `discoverSessions`.
 *   G3  Refuse, don't guess. Every failure is a typed refusal carrying the
 *       path that was looked for; there is no empty-success and no fallback.
 *   G6  Fixtures are law. Every layout fact here is pinned by a committed
 *       fixture; nothing is inferred from memory.
 *   G8  Single test subject. This module never enumerates the projects root
 *       to list *other* workspaces' slugs — it only ever looks up the one
 *       slug the open workspace encodes to.
 *
 * There is deliberately **no second discovery implementation** here. Session
 * discovery is `discoverSessions` from `../parser/tailer.js`, which is
 * file-first: sessions come from `<sessionId>.jsonl` FILES and only then is
 * the matching `<sessionId>/` directory computed. Two discovery paths that
 * disagree is the exact bug this module exists to prevent, so this file
 * delegates rather than re-derives. `correlate.test.ts` proves the ordering
 * survives the delegation.
 */

import { resolve, sep } from 'node:path';

import { discoverSessions, slugifyWorkspace } from '../parser/tailer.js';
import type {
  DiscoverOptions,
  DiscoveredSession,
  DiscoveredSubagent,
  DiscoveryFailure,
} from '../parser/tailer.js';

// ---------------------------------------------------------------------------
// Slug <-> workspace
// ---------------------------------------------------------------------------

/**
 * Workspace absolute path -> CC project slug.
 *
 * One encoding, defined in one place: this re-exports the tailer's
 * {@link slugifyWorkspace} rather than restating the substitution rules.
 *
 * The encoding is **lossy and not injective**: ':', '\' and '/' all collapse
 * to '-', so `c:\ws\a` and `c:\ws-a` produce the identical slug `c--ws-a`.
 * That is CC's encoding, not ours, and it is why this module offers no
 * slug -> workspace inverse: reconstructing a path from a slug would be
 * guessing, which G3 forbids. Correlation therefore always runs forward —
 * encode the open workspace, then compare.
 */
export function workspaceSlug(workspacePath: string): string {
  return slugifyWorkspace(workspacePath);
}

/**
 * The comparison form of a slug.
 *
 * Case is dropped because the Windows drive letter's case varies between CC
 * versions: `c--Users-...` and `C--Users-...` both occur in this repo's own
 * history for one workspace, and a case-sensitive compare silently finds
 * nothing.
 */
export function normalizeSlug(slug: string): string {
  return slug.toLowerCase();
}

/**
 * How a slug found on disk relates to the open workspace.
 *
 * `caseInsensitive` is a *match* — it is reported separately only so a caller
 * can surface the spelling difference, never so it can reject it.
 */
export type SlugMatchKind = 'exact' | 'caseInsensitive' | 'differentWorkspace';

/** Classify a slug against the open workspace path. */
export function workspaceMatch(slug: string, workspacePath: string): SlugMatchKind {
  const want = workspaceSlug(workspacePath);
  if (slug === want) return 'exact';
  if (normalizeSlug(slug) === normalizeSlug(want)) return 'caseInsensitive';
  return 'differentWorkspace';
}

/**
 * True when `slug` belongs to the open workspace. The gate for "only the open
 * workspace's sessions are shown".
 */
export function isOpenWorkspaceSlug(slug: string, workspacePath: string): boolean {
  return workspaceMatch(slug, workspacePath) !== 'differentWorkspace';
}

/**
 * True when two workspace paths denote the same workspace under CC's slug
 * encoding. Used against a hook event's `cwd` field, which carries a
 * workspace path, not a slug.
 *
 * Because the encoding is not injective (see {@link workspaceSlug}) this can
 * in principle say `true` for two genuinely different paths. It is the same
 * comparison CC itself makes when it picks a project directory, so agreeing
 * with CC is the correct behaviour, not a bug to fix here.
 */
export function sameWorkspace(a: string, b: string): boolean {
  return normalizeSlug(workspaceSlug(a)) === normalizeSlug(workspaceSlug(b));
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

/** Injection seams, identical to the tailer's: `env`, `homedir`, `projectsRoot`. */
export type CorrelateOptions = DiscoverOptions;

export interface WorkspaceCorrelation {
  /** The workspace path as given by the caller, unmodified. */
  workspacePath: string;
  /** `workspaceSlug(workspacePath)` — what we looked for. */
  requestedSlug: string;
  /** The slug directory name as spelled on disk; case may differ. */
  slug: string;
  slugDir: string;
  /** Whether the on-disk spelling matched the requested one exactly. */
  slugMatch: Exclude<SlugMatchKind, 'differentWorkspace'>;
  projectsRoot: string;
  /** 'env' when CLAUDE_PROJECTS_ROOT (or an explicit root) supplied it. */
  rootSource: 'env' | 'home';
  /** Sessions of this workspace only, sorted by session id. Never `memory/`. */
  sessions: DiscoveredSession[];
}

/** Data or a refusal, never an empty success. */
export type CorrelationResult =
  | { ok: true; value: WorkspaceCorrelation }
  | { ok: false; failure: DiscoveryFailure };

/**
 * Correlate the open workspace to its CC sessions.
 *
 * Failure modes, all typed refusals carrying the path that was looked for:
 * `projectsRootNotFound` (ENOENT — the negative control that proves no silent
 * fallback to a live `~/.claude` when a fixture root was expected),
 * `projectsRootUnreadable`, and `projectSlugNotFound` (this workspace has no
 * CC project directory, i.e. it has never been opened in CC).
 *
 * A slug directory that exists but holds no `<sessionId>.jsonl` file is an
 * `ok: true` correlation with **zero** sessions, not a refusal: `memory/`
 * alone is a well-formed, empty project.
 */
export async function correlateWorkspace(
  workspacePath: string,
  options: CorrelateOptions = {},
): Promise<CorrelationResult> {
  const result = await discoverSessions(workspacePath, options);
  if (!result.ok) return { ok: false, failure: result.failure };

  const kind = workspaceMatch(result.slug, workspacePath);
  if (kind === 'differentWorkspace') {
    // Unreachable through `discoverSessions`, which matches case-insensitively
    // on the same encoding. Asserted rather than assumed: if the two ever
    // drift apart this refuses instead of showing a foreign workspace.
    return {
      ok: false,
      failure: {
        kind: 'projectSlugNotFound',
        code: 'ENOENT',
        path: result.slugDir,
        message: `slug ${result.slug} does not belong to workspace ${workspacePath}`,
      },
    };
  }

  return {
    ok: true,
    value: {
      workspacePath,
      requestedSlug: result.requestedSlug,
      slug: result.slug,
      slugDir: result.slugDir,
      slugMatch: kind,
      projectsRoot: result.projectsRoot,
      rootSource: result.rootSource,
      sessions: result.sessions,
    },
  };
}

// ---------------------------------------------------------------------------
// Lookups for incoming events
// ---------------------------------------------------------------------------

/**
 * A hook event's `session_id` -> the discovered session, or `undefined` when
 * the event belongs to a session outside the open workspace.
 *
 * `undefined` is a routine, expected answer: CC fires hooks for every session
 * the user is running, and only this workspace's may be rendered.
 */
export function findSession(
  correlation: WorkspaceCorrelation,
  sessionId: string,
): DiscoveredSession | undefined {
  const want = sessionId.toLowerCase();
  return correlation.sessions.find((s) => s.sessionId.toLowerCase() === want);
}

/** What a transcript path turned out to be. */
export interface TranscriptRef {
  sessionId: string;
  session: DiscoveredSession;
  kind: 'main' | 'subagent';
  /** Set only for `kind === 'subagent'`. */
  agentId?: string;
  subagent?: DiscoveredSubagent;
}

/**
 * Path comparison form. Separators are unified and case is dropped, matching
 * the Windows semantics this project is developed against and the same
 * case-insensitivity the slug match already relies on. Phase 4 owns the
 * cross-OS matrix; on a case-sensitive filesystem this is more permissive
 * than the filesystem, which can only widen a match to paths differing by
 * case alone.
 */
function comparablePath(path: string): string {
  return resolve(path).split(sep).join('/').replace(/\/+$/, '').toLowerCase();
}

/**
 * A hook event's `transcript_path` -> the session it belongs to.
 *
 * Matches the main transcript and every discovered subagent transcript, and
 * nothing else: a `tool-results/*.txt` path, a session *directory*, or a
 * foreign workspace's transcript all return `undefined`.
 */
export function findByTranscriptPath(
  correlation: WorkspaceCorrelation,
  transcriptPath: string,
): TranscriptRef | undefined {
  const want = comparablePath(transcriptPath);
  for (const session of correlation.sessions) {
    if (comparablePath(session.mainTranscript) === want) {
      return { sessionId: session.sessionId, session, kind: 'main' };
    }
    for (const subagent of session.subagents) {
      if (comparablePath(subagent.transcriptPath) === want) {
        return {
          sessionId: session.sessionId,
          session,
          kind: 'subagent',
          agentId: subagent.agentId,
          subagent,
        };
      }
    }
  }
  return undefined;
}
