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
import { defaultWorkspaceMatch, graftCorpus } from './graft.js';
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

  /*
   * The refused ids are handed to the grafter so a `task` part naming one can
   * say WHY its child is missing (`childSessionUnsupported`) instead of
   * reporting a key contradiction for a check that was never run. Refusal
   * itself stays the fingerprint's: `sessions` is still the accepted rows
   * alone, and the grafter still has no refusal of its own.
   */
  const refusedSessionIds = new Set(partition.refused.map((mismatch) => mismatch.sessionId));

  /*
   * ONE workspace predicate, built once, used by the graft AND by the refusal.
   *
   * Passing `defaultWorkspaceMatch` explicitly where the host supplied no
   * folders is behaviourally identical to omitting it — `graft.ts` falls back
   * to that exact function — and it is written out here so the accepted and the
   * refused sessions cannot drift onto two expressions of one rule. Two
   * agreeing literals is not a contract; that is what produced the seam this
   * change closes.
   */
  const matchWorkspace =
    options.workspacePaths === undefined
      ? defaultWorkspaceMatch
      : workspaceMatcher(options.workspacePaths);

  /*
   * THE ONE TRY/CATCH IN THIS ENGINE, AND THE TRADE IT MAKES.
   *
   * `graftCorpus` throws when a `session` row is reachable as neither a root,
   * nor an `AgentNode` under one, nor a parked entry. That throw is deliberate
   * and it is NOT being softened: a silently dropped session is the failure
   * this whole exercise exists to make visible, and `graft.test.ts` asserts it.
   * What changes here is only that it stops ESCAPING. `OcEngineOutcome`'s own
   * doc says "Never thrown, always returned", `readOpenCodeEngine` is called
   * from the extension host's `activate`, and an uncaught throw there is an
   * inert extension with no error a user can see - the same end state the
   * `"type": "module"` / `.cjs` defect produced, reached by a different route.
   *
   * **THE COST, STATED PLAINLY, BECAUSE IT IS REAL AND IT IS NOT SOLVED.**
   * This converts a known, explainable, SINGLE-ROW condition into an opaque
   * engine-wide degrade that darkens EVERY OpenCode session. That is worse
   * behaviour than parking the one row would be. The user took this option at
   * the Phase 5 gate with that cost on the table, because it is correct and
   * cheap now and an uncaught throw at `activate` is neither.
   *
   * The reachable case today is an ACCEPTED session whose parent was REFUSED by
   * the version window: the refused parent is not in the accepted rows and the
   * accepted child is not a root, so nothing can place it. It is EXPLAINABLE -
   * we know exactly why that row is unreachable - and the better fix a later
   * phase should take is to park it, distinguishing "unreachable because an
   * ancestor was refused" from "unreachable for no reason we can name" and
   * degrading only for the second. That needs a decision about which
   * `SessionState` an orphaned grandchild belongs to, and that decision has
   * still not been taken. Do not read this catch as having taken it.
   *
   * The cause is never swallowed (rule 3): the thrown message travels into
   * `health.message` verbatim, so the row the graft could not place is named in
   * the field. Only the message - no stack, and `health.path` stays the file
   * that was opened, never a path read out of the database.
   */
  let grafted: OcEngineResult;
  try {
    grafted = graftCorpus({
      sessions: partition.accepted,
      projects: read.value.projects,
      parse,
      options: {
        projectSlug: projectSlugOf,
        refusedSessionIds,
        workspaceMatch: matchWorkspace,
      },
    });
  } catch (error) {
    return {
      kind: 'degraded',
      health: {
        ok: false,
        code: 'graftFailed',
        message: `graft failed for ${dbPath}: ${messageOf(error)}`,
        path: dbPath,
      },
    };
  }

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
   * A refused CHILD session is deliberately NOT given one of these. A child is
   * a subagent inside its parent's session, not a deck entry of its own
   * (contract §9), so an `unsupported` `SessionState` for it would invent a
   * session the user never started. It parks on its in-window parent instead,
   * with `childSessionUnsupported` — the code `PLAN.md`'s Phase 5 gate (B7)
   * added to close `docs/evidence/phase-4/COVERAGE.md` item 29. Through Phase 4
   * that case reported `joinKeyContradiction`, which was visible and safe and
   * told the wrong story: the keys did not disagree, the child was out of
   * window. `graft.ts`'s `joinTasks` holds the branch and the ordering reason.
   */
  const refusedRootIds = new Set(
    read.value.sessions.filter((s) => s.parentId === null).map((s) => s.id),
  );
  const unsupported: SessionState[] = partition.refused
    .filter((mismatch) => refusedRootIds.has(mismatch.sessionId))
    .map((mismatch) =>
      unsupportedSession(mismatch, read.value.sessions, read.value.projects, matchWorkspace),
    );

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
 * The message off anything `catch` can hand us, without a stack.
 *
 * `db.ts` has a private twin of this. It is restated rather than exported and
 * shared, because that one is about a filesystem/SQLite error and this one is
 * about our own code throwing - the two would drift toward each other's needs
 * and a shared helper would make it look like the two failures are one kind.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The `SessionState` a refused session renders as: a refusal, not a tree.
 *
 * Nothing derived from the session's own content appears — no tool nodes, no
 * totals, no label beyond what the row itself says — because the whole reason
 * it refused is that the engine does not trust its shape.
 *
 * ---------------------------------------------------------------------------
 * `workspaceMatch` IS REAL HERE, AND IT IS THE ONE EXCEPTION
 * ---------------------------------------------------------------------------
 *
 * It used to be hard-coded `false`, which was defensible in isolation and wrong
 * in composition. **The host filters the deck by `workspaceMatch`**, to match
 * what `SessionModel` does for Claude Code, so a hard `false` filtered every
 * refused OpenCode session off the deck entirely: a user whose OpenCode version
 * drifted out of the window saw NOTHING, not an `unsupported` card. That
 * defeats G3 and contradicts the sentence this file already carries — *a
 * refusal that is invisible to the renderer is not a refusal*. Neither package
 * was wrong alone, which is exactly the recorded "a module-boundary partition
 * produces silent seams, not crashes" class. The CC engine never had the hole,
 * because `SessionModel` computes the match from the real workspace.
 *
 * **Why this does not trust the row that failed.** The session refused on
 * `session.version` — a column on the `session` row. `project.worktree`, which
 * is the only thing the match reads *at this call site*, lives in the
 * **`project` table** and is not what refused. Taking the match from the
 * project row is therefore not believing the shape the fingerprint rejected; it
 * is answering a question about a different row entirely. That distinction is
 * the whole licence for this exception, so it is written here rather than left
 * for the next reader to reconstruct — and the 2026-08-31 keying change was
 * kept OUT of this path to preserve it. See the call below.
 *
 * **The line, and it is not moving.** `projectSlug` stays `''`, the tree stays
 * empty, the totals stay zero and the label stays whatever the row itself says.
 * Only the match changes, and only because it comes from another table. This is
 * not "refused sessions get their content back".
 *
 * **Belt and braces, deliberately.** The host is ALSO changed so it never
 * filters a refusal. That redundancy is the point: neither this file nor the
 * host should be able to silently reintroduce the hole alone. Do not
 * "simplify" either half away because the other one covers it.
 *
 * A project row that is absent yields `false`, the old behaviour — there is
 * nothing to derive a match from and inventing one would be a guess.
 */
function unsupportedSession(
  mismatch: OcSessionMismatch,
  sessions: readonly OcSessionRow[],
  projects: readonly OcProjectRow[],
  matchWorkspace: (
    session: OcSessionRow | undefined,
    project: OcProjectRow | undefined,
  ) => boolean,
): SessionState {
  const row = sessions.find((s) => s.id === mismatch.sessionId);
  const project =
    row === undefined ? undefined : projects.find((p) => p.id === row.projectId);
  return {
    sessionId: mismatch.sessionId,
    projectSlug: '',
    engine: 'opencode',
    // `undefined` FOR THE SESSION, DELIBERATELY, and it is what keeps the
    // licence above true after the 2026-08-31 keying change. That licence is
    // "the match does not read the row that refused": the refusal is on
    // `session.version`, and a version out of window means we do not know how
    // to read that row's shape, so reading ANOTHER of its columns —
    // `session.directory` included — would be exactly the thing the paragraph
    // says this does not do. Passing `undefined` here resolves the match from
    // `project.worktree` alone, which is byte-identical to the behaviour this
    // function has always had. The consequence, stated rather than hidden: a
    // refused session in a MOVED workspace does not match, and stays on the
    // deck only through the host's belt-and-braces half, which is why that
    // redundancy is not to be simplified away.
    workspaceMatch: matchWorkspace(undefined, project),
    liveness: 'unsupported',
    schemaOk: false,
    totals: { costUsd: 0 },
    // `contextNow`/`burn` OMITTED, matching `graft.ts`: this engine reports no
    // token figures at all yet, and a refused session must not be the one
    // place it appears to. Absent, never 0.
    spawnEdges: [],
    parked: [],
    root: {
      id: 'root',
      kind: 'main',
      label: row === undefined ? mismatch.sessionId : (row.title ?? mismatch.sessionId),
      status: 'done',
      spawnDepth: 0,
      children: [],
      startedAt: row?.timeCreated ?? 0,
    },
  };
}

/**
 * THE PROJECT KEY, AND WHICH COLUMN IT COMES FROM.
 *
 * `PLAN.md` Phase 4 `Amendment 2026-08-27` A1: `projectSlug` is "the project
 * key" for both engines, and the OpenCode value is the CC slug for the
 * session's workspace path. One workspace observed by two engines, one key.
 *
 * **The column changed on 2026-08-31, and this is the whole of the fix.**
 * Through 0.5.0 the key came from `project.worktree` alone. OpenCode keeps ONE
 * `project` row per repository identity and **never rewrites `worktree` when
 * the directory moves** — measured on the live store, where a project row with
 * a current `time_updated` still named a path the workspace had left, and
 * where a session RUN AT THE NEW PATH landed on that same stale row. Every
 * OpenCode session then keyed to the old slug, matched no open folder, and the
 * deck showed nothing at all. **Absent, not refused** — which is the failure
 * mode a user cannot tell from "this engine does not work".
 *
 * `session.directory` is the session's own cwd and OpenCode keeps it current.
 * It is a REQUIRED column (`fingerprint.ts`'s `REQUIRED_COLUMNS`), so reading
 * it adds no new schema dependency the fingerprint does not already assert.
 *
 * The order, and why it is this order:
 *
 *   1. `session.directory` — what this session actually ran in. Current.
 *   2. `project.worktree`  — the fallback, for a row whose `directory` is NULL
 *                            or empty. Both committed corpora agree with (1)
 *                            byte for byte, so no golden moves.
 *   3. `''`                — neither is available. NOT a guess (G3), counted as
 *                            {@link OcEngineResult.opencodeUnkeyed}, and the
 *                            session still renders: an unkeyed session is
 *                            visible and unmatched, never dropped. Dropping it
 *                            is the "a refusal invisible to the renderer is not
 *                            a refusal" hole this file already closed once.
 *
 * Diagnosis and measurements: `docs/evidence/release-0.5.0/DRIFT-2.1.251.md`
 * §5.2. Witness: `fixtures/opencode-1.18.25/moved-project/`.
 */
function projectKeyPath(
  session: OcSessionRow | undefined,
  project: OcProjectRow | undefined,
): string | undefined {
  // `!== null && !== ''` rather than a truthiness test, so the two "no value"
  // shapes SQLite can hand back are both handled and neither is confused with
  // a path that merely sorts falsy.
  const directory = session?.directory;
  if (directory !== undefined && directory !== null && directory !== '') return directory;
  if (project !== undefined && project.worktree !== '') return project.worktree;
  return undefined;
}

/** See {@link projectKeyPath}. `''` means "no key available", and it is counted. */
function projectSlugOf(
  session: OcSessionRow | undefined,
  project: OcProjectRow | undefined,
): string {
  const path = projectKeyPath(session, project);
  return path === undefined ? '' : slugFromWorktree(path);
}

/**
 * The session's key path against the host's open workspace folders (OC8).
 *
 * Case-insensitive, via the slug both sides encode to. The Windows
 * drive-letter trap applies here exactly as it does to CC slugs — this repo has
 * measured both `c--Users-…` and `C--Users-…` from Claude Code, and the same
 * variance reaches a `directory` string as `c:\` versus `C:\`.
 *
 * It reads {@link projectKeyPath}, the SAME resolution the slug uses, rather
 * than a second expression of the rule. A session whose key and whose match
 * disagreed would be the exact module-boundary seam this engine has already
 * been bitten by once.
 */
function workspaceMatcher(
  workspacePaths: readonly string[],
): (session: OcSessionRow | undefined, project: OcProjectRow | undefined) => boolean {
  const wanted = new Set(workspacePaths.map((p) => slugFromWorktree(p).toLowerCase()));
  return (session, project) => {
    const path = projectKeyPath(session, project);
    return path !== undefined && wanted.has(slugFromWorktree(path).toLowerCase());
  };
}

// ---------------------------------------------------------------------------
// Re-exports — the engine's public surface, named in one place
// ---------------------------------------------------------------------------

export { PINNED_OPENCODE_VERSION, OC_VERSION_WINDOW } from './fingerprint.js';
export { slugFromWorktree } from './slug.js';
export { OPENCODE_DB_FILENAME, opencodeDbPath } from './db.js';
export type { OcEngineResult, OcCounts, OcMismatch, OcMismatchCode } from './types.js';
