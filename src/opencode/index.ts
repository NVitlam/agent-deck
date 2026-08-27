/**
 * Agent Deck — the OpenCode engine's entry point (PLAN.md Phase 4).
 *
 * One function chains the four packages into the production path:
 *
 *   db.ts          open read-only, read rows, close        (DoD 4.1)
 *   fingerprint.ts assert the schema, window each session  (DoD 4.2)
 *   parse.ts       part rows -> tool records, redacted     (DoD 4.3)
 *   graft.ts       rows + records -> SessionState trees    (DoD 4.4)
 *   slug.ts        project.worktree -> projectSlug         (Amendment A1)
 *
 * `liveness.ts` is deliberately NOT chained here. It is a POLLING engine with
 * an injected clock and an injected trigger, and wiring it needs a host that
 * owns both — `PLAN.md` DoD 5.2's work. A one-shot read has no cursor to
 * advance, so folding it in would mean inventing a wall clock inside a
 * function whose whole value is being a pure function of the database.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS AUDITED FOR
 * ---------------------------------------------------------------------------
 *
 * DoD 4.7: loading `src/opencode/*` opens zero sockets, and the accessor
 * exposes no write surface. `src/hooks/egress.test.ts` bundles the import
 * graph rooted at THIS file and asserts both, so two properties have to hold
 * here rather than merely being true today:
 *
 *   - it imports no network-capable module, directly or transitively;
 *   - it does not reach `./synthetic.js`, the one module under `src/opencode/`
 *     that opens a database for write. That file is a test fixture builder and
 *     nothing on this path may import it.
 *
 * ---------------------------------------------------------------------------
 * G1, AS AMENDED 2026-08-27
 * ---------------------------------------------------------------------------
 *
 * "No writes to any file the observed engine treats as content." `opencode.db`
 * is never modified and the four secret-bearing tables are never read. What
 * SQLite touches on a WAL database is its own `-shm` index sidecar, which every
 * reader of one touches, OpenCode's own process included. `agent-deck-spec.md`
 * OC1's `G1 amendment 2026-08-27` and `SECURITY.md` §2 carry the measurements;
 * `db.test.ts` re-asserts them.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SessionState } from '../model/events.js';
import { opencodeDbPath, readDatabase } from './db.js';
import type { OcHealthFailure, OcSchema } from './db.js';
import {
  PINNED_OPENCODE_VERSION,
  fingerprintSchema,
  partitionSessionsByVersion,
} from './fingerprint.js';
import type { OcSchemaReport, OcSessionMismatch } from './fingerprint.js';
import { graftCorpus } from './graft.js';
import { parseParts } from './parse.js';
import { slugFromWorktree } from './slug.js';
import type { OcEngineResult, OcMismatch, OcProjectRow, OcSessionRow } from './types.js';

// ---------------------------------------------------------------------------
// Where the store lives
// ---------------------------------------------------------------------------

/**
 * The OpenCode data directory, relative to the user profile (contract §2).
 *
 * Joined rather than written as one string so the separator is the platform's.
 */
export const OPENCODE_DATA_SUBPATH = ['.local', 'share', 'opencode'] as const;

/**
 * Agent Deck's OWN test override, on the `CLAUDE_PROJECTS_ROOT` precedent.
 *
 * `XDG_DATA_HOME` *does* relocate OpenCode's data root on Windows — measured
 * in Phase 2, against the expectation that Windows would ignore it — but the
 * engine deliberately does not honour it (spec OC1): relying on another
 * project's environment handling would make our tests hostage to it. What that
 * measurement bought is a capture harness that can drive OpenCode against a
 * scratch root, which is a different thing from how we resolve one.
 */
export const OPENCODE_DATA_ROOT_ENV = 'AGENT_DECK_OPENCODE_ROOT';

/**
 * Resolve the data directory.
 *
 * `homedir()` reads `USERPROFILE` on Windows, and that is load-bearing for the
 * negative control: a test that fakes only `HOME` runs happily against the
 * REAL database and returns a confident false pass. That trap is recorded for
 * the Claude Code engine and it is the same one here.
 */
export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[OPENCODE_DATA_ROOT_ENV];
  if (override !== undefined && override !== '') return override;
  return join(homedir(), ...OPENCODE_DATA_SUBPATH);
}

// ---------------------------------------------------------------------------
// The one call
// ---------------------------------------------------------------------------

export interface OcEngineOptions {
  /** The database to read. Overrides {@link OcEngineOptions.dataDir}. */
  dbPath?: string;
  /** The data directory holding `opencode.db`. Defaults to the resolved one. */
  dataDir?: string;
  /** Environment for {@link opencodeDataDir}. Injected so tests never guess. */
  env?: NodeJS.ProcessEnv;
  /**
   * Open through `file:…?immutable=1`. **Committed fixtures only** — it skips
   * the WAL, and `db.ts` refuses it on a WAL-mode file for that reason.
   */
  immutable?: boolean;
  /** Version anchor override. Tests only; production uses the pinned one. */
  anchor?: string;
  /**
   * The workspace folders VS Code has open, for the `project.worktree` match
   * (OC8). Absent means "do not filter" — every project matches — which is
   * what the goldens carry and what a Phase 4 caller wants. Real discovery is
   * `PLAN.md` DoD 5.2.
   */
  workspacePaths?: readonly string[];
}

/** What one pass over the store produced. Never thrown, always returned. */
export type OcEngineOutcome =
  | { readonly kind: 'ok'; readonly result: OcEngineResult; readonly report: OcSchemaReport }
  /** The schema is not OpenCode's. Every session renders `unsupported` (G3). */
  | { readonly kind: 'schemaMismatch'; readonly mismatch: OcMismatch }
  /** The store is unusable. The engine is flagged; CC sessions are unaffected (G2). */
  | { readonly kind: 'degraded'; readonly health: OcHealthFailure };

/**
 * Read one OpenCode store and build its `SessionState` trees.
 *
 * Reads ONCE: the schema, the rows, and the fingerprint all come from a single
 * `readDatabase` call rather than from `fingerprintDatabase`, which would open
 * the file a second time. Two opens is two chances for the store to change
 * underneath us and, on a WAL database, two touches of the `-shm` sidecar.
 */
export function readOpenCodeEngine(options: OcEngineOptions = {}): OcEngineOutcome {
  const dbPath =
    options.dbPath ??
    opencodeDbPath(options.dataDir ?? opencodeDataDir(options.env ?? process.env));

  const read = readDatabase(dbPath, {
    ...(options.immutable === true ? { immutable: true } : {}),
  });
  if (!read.ok) return { kind: 'degraded', health: read.health };

  // The schema half of the fingerprint, over the schema that read returned.
  const schema: OcSchema = read.value.schema;
  const fingerprint = fingerprintSchema(schema);
  if (!fingerprint.ok) return { kind: 'schemaMismatch', mismatch: fingerprint.mismatch };

  // The version half, PER SESSION: a mixed-version database renders its
  // in-window sessions and parks the rest (OC5, DoD 4.2). The mixed database is
  // the normal case, not a hypothetical — the measured one held five `1.18.21`
  // rows beside twenty-three `1.18.22` rows while the binary self-updated.
  const partition = partitionSessionsByVersion(
    read.value.sessions,
    options.anchor ?? PINNED_OPENCODE_VERSION,
  );

  /*
   * EVERY part row is parsed, including those of refused sessions.
   *
   * `counts.partRows` means "every `part` row read", which is what the golden's
   * counts block records and what DoD 4.6 compares byte-for-byte. Filtering
   * first would make the counter mean "rows of sessions that rendered", a
   * different and less useful number. A refused session's records simply never
   * attach: `toolsBySession` is keyed by session id and the grafter is handed
   * only the accepted rows.
   */
  const parse = parseParts(read.value.parts);

  const grafted = graftCorpus({
    sessions: partition.accepted,
    projects: read.value.projects,
    parse,
    options: {
      projectSlug: projectSlugOf,
      ...(options.workspacePaths === undefined
        ? {}
        : { workspaceMatch: workspaceMatcher(options.workspacePaths) }),
    },
  });

  /*
   * A REFUSED SESSION IS NOT AN ABSENT ONE.
   *
   * Spec OC2 is explicit — "a stable code, the session list renders
   * `unsupported`, never a partial tree (G3)" — and this repo's own rule, from
   * `GOLDEN.md`'s parked-graft note, is that **a refusal that is invisible to
   * the renderer is not a refusal**. Putting the mismatch in `refused` and
   * nothing in `sessions` would drop the session off the deck entirely, which
   * looks to a user exactly like a session that never existed.
   *
   * So every refused ROOT session gets a `SessionState` carrying
   * `schemaOk: false`, `liveness: 'unsupported'` and an empty tree. Empty is
   * the point: a refusal renders nothing, and a new field is not a hole to
   * smuggle content through.
   *
   * Both committed corpora refuse nothing, so this adds no session to either
   * golden and DoD 4.6's byte compare is unaffected.
   *
   * A refused CHILD session is NOT handled here and is listed in
   * `docs/evidence/phase-4/COVERAGE.md`: it currently surfaces as a
   * `joinKeyContradiction` park on its in-window parent, because the grafter
   * looks the child up among the accepted rows and does not find it. That is
   * visible and it is safe, but the code is the wrong story — it says the keys
   * disagreed when what happened is that the child was out of window. Fixing it
   * needs a park code that does not exist yet, and it is recorded rather than
   * guessed at.
   */
  const refusedRootIds = new Set(
    read.value.sessions.filter((s) => s.parentId === null).map((s) => s.id),
  );
  const unsupported: SessionState[] = partition.refused
    .filter((mismatch) => refusedRootIds.has(mismatch.sessionId))
    .map((mismatch) => unsupportedSession(mismatch, read.value.sessions));

  return {
    kind: 'ok',
    report: fingerprint.value,
    result: {
      ...grafted,
      sessions: [...grafted.sessions, ...unsupported],
      // `graftCorpus` cannot refuse anything — refusal is the fingerprint's —
      // so it always returns an empty list and this is where the two halves
      // meet. This list is the machine-readable reason behind every
      // `unsupported` session above.
      refused: [...grafted.refused, ...partition.refused],
    },
  };
}

/**
 * The `SessionState` a refused session renders as: a refusal, not a tree.
 *
 * Nothing derived from the session's own content appears — no tool nodes, no
 * totals, no label beyond what the row itself says — because the whole reason
 * it refused is that the engine does not trust its shape.
 */
function unsupportedSession(
  mismatch: OcSessionMismatch,
  sessions: readonly OcSessionRow[],
): SessionState {
  const row = sessions.find((s) => s.id === mismatch.sessionId);
  return {
    sessionId: mismatch.sessionId,
    projectSlug: '',
    engine: 'opencode',
    workspaceMatch: false,
    liveness: 'unsupported',
    schemaOk: false,
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    spawnEdges: [],
    parked: [],
    root: {
      id: 'root',
      kind: 'main',
      label: row === undefined ? mismatch.sessionId : (row.title ?? mismatch.sessionId),
      status: 'done',
      spawnDepth: 0,
      children: [],
      tokens: { in: 0, out: 0 },
      startedAt: row?.timeCreated ?? 0,
    },
  };
}

/**
 * `PLAN.md` Phase 4 `Amendment 2026-08-27` A1: `projectSlug` is "the project
 * key" for both engines, and the OpenCode value is the CC slug for
 * `project.worktree`. One workspace observed by two engines, one key.
 *
 * A session whose `project` row is absent yields `''` — there is no worktree to
 * derive a key from, and inventing one would be a guess.
 */
function projectSlugOf(project: OcProjectRow | undefined): string {
  return project === undefined ? '' : slugFromWorktree(project.worktree);
}

/**
 * `project.worktree` against the host's open workspace folders (OC8).
 *
 * Case-insensitive, via the slug both sides encode to. The Windows
 * drive-letter trap applies here exactly as it does to CC slugs — this repo has
 * measured both `c--Users-…` and `C--Users-…` from Claude Code, and the same
 * variance reaches a `worktree` string as `c:\` versus `C:\`.
 *
 * `session.directory` is the session's cwd and is NOT the join key.
 */
function workspaceMatcher(
  workspacePaths: readonly string[],
): (project: OcProjectRow | undefined) => boolean {
  const wanted = new Set(workspacePaths.map((p) => slugFromWorktree(p).toLowerCase()));
  return (project) =>
    project !== undefined && wanted.has(slugFromWorktree(project.worktree).toLowerCase());
}

// ---------------------------------------------------------------------------
// Re-exports — the engine's public surface, named in one place
// ---------------------------------------------------------------------------

export { PINNED_OPENCODE_VERSION, OC_VERSION_WINDOW } from './fingerprint.js';
export { slugFromWorktree } from './slug.js';
export { OPENCODE_DB_FILENAME, opencodeDbPath } from './db.js';
export type { OcEngineResult, OcCounts, OcMismatch, OcMismatchCode } from './types.js';
