/**
 * F1 — the project key of a workspace that MOVED.
 *
 * THE DEFECT, AND WHY NOTHING ALREADY HERE COULD SEE IT
 * -----------------------------------------------------
 * Through v0.5.0 `src/opencode/index.ts` derived `SessionState.projectSlug`,
 * and the workspace match with it, from `project.worktree` alone. OpenCode
 * keeps **one `project` row per repository identity** and never rewrites
 * `worktree` when the directory moves. Measured on the live store on
 * 2026-08-31: a project row whose `time_updated` was current still named a
 * path the workspace had left, and a session **run at the new path** landed on
 * that same stale row. Every OpenCode session therefore keyed to the old slug,
 * matched no open workspace folder, and the deck rendered nothing at all —
 * **absent, not refused**, which a user cannot tell from an engine that does
 * not work.
 *
 * `src/opencode/golden.test.ts` reproduces both committed corpora through the
 * same production path and stayed green throughout, because in
 * `fixtures/opencode-1.18.21/` and `fixtures/opencode-1.18.22/`
 * `session.directory` and `project.worktree` are the **same string** — 5 rows
 * and 24 rows respectively, measured. A corpus in which the two agree cannot
 * distinguish the two rules. That is the whole reason this file needs a
 * fixture of its own, and it is `fixtures/opencode-1.18.25/moved-project/`.
 *
 * The consequence for the goldens is the useful half: this change moves **no
 * committed golden byte**, because those two strings agree in both corpora.
 *
 * WHAT THIS FILE ASSERTS
 * ----------------------
 *   1. The fixture is the witness it claims to be — the two columns DISAGREE.
 *      This is the vacuity control: if a future capture made them agree, every
 *      assertion below would pass against either rule and prove nothing.
 *   2. Through the production path, the session keys to `session.directory`.
 *   3. The workspace match follows the same resolution, both ways: the new path
 *      matches, the old path does not.
 *   4. The fallback: `session.directory` NULL falls back to `project.worktree`.
 *   5. Neither available -> `''`, counted as `opencodeUnkeyed`, session still
 *      rendered (G3: no guess, and no silent drop).
 *   6. 1.18.25's additive schema drift refuses nothing, and `project_directory`
 *      — the table OpenCode added to record exactly this move — is reported as
 *      unknown rather than read.
 *
 * Diagnosis and every measurement quoted above:
 * `docs/evidence/release-0.5.0/DRIFT-2.1.251.md` §5.2.
 *
 * G1 — READ-ONLY. The committed fixture is opened `immutable: true` and its
 * SHA-256 is compared before and after. The two variants in 4 and 5 are built
 * on a TEMP COPY, never on the committed file, which is the same move
 * `golden.test.ts` makes to reproduce a refusal.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readOpenCodeEngine, slugFromWorktree } from './index.js';
import { readProjects, readSessions } from './db.js';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../fixtures/opencode-1.18.25/moved-project', import.meta.url),
);
const DB_PATH = join(FIXTURE_DIR, 'opencode.db');

/**
 * The two paths are READ OFF THE FIXTURE, never written as literals here.
 *
 * A hard-coded absolute path in `src/` is a developer identifier the privacy
 * sweep gates on, and it would pin one machine. The fixture's own paths are
 * already tokenised (`<ROOT-OLD>` / `<ROOT-NEW>`); reading them keeps the one
 * spelling in one place.
 */
function paths(): { old: string; moved: string } {
  const projects = readProjects(DB_PATH);
  if (!projects.ok) throw new Error('could not read the project row');
  const [project] = projects.value;
  if (project === undefined) throw new Error('the fixture has no project row');

  const sessions = readSessions(DB_PATH);
  if (!sessions.ok) throw new Error('could not read the session rows');
  const [session] = sessions.value;
  if (session === undefined) throw new Error('the fixture has no session row');
  if (session.directory === null) throw new Error('the fixture session has no directory');

  return { old: project.worktree, moved: session.directory };
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A writable copy of the fixture, for the two variants that mutate rows. */
function onTempCopy(mutate: (db: DatabaseSync) => void, use: (dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'agent-deck-oc-moved-'));
  try {
    const copy = join(dir, 'opencode.db');
    copyFileSync(DB_PATH, copy);
    const db = new DatabaseSync(copy);
    try {
      mutate(db);
    } finally {
      db.close();
    }
    use(copy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('F1 — fixtures/opencode-1.18.25/moved-project', () => {
  it('is a genuine witness: project.worktree and session.directory DISAGREE', () => {
    // The vacuity control for every assertion below it. Written first on
    // purpose: a fixture whose two columns agreed would make the rest of this
    // file pass under the OLD rule as well, which is the failure shape this
    // repository has recorded more than any other.
    const { old, moved } = paths();
    expect(old).not.toBe(moved);
    expect(slugFromWorktree(old)).not.toBe(slugFromWorktree(moved));

    // And it is a 1.18.25 row, which is what makes it evidence about the
    // release the defect was found on rather than about an invented shape.
    const sessions = readSessions(DB_PATH);
    if (!sessions.ok) throw new Error('could not read the session rows');
    expect(sessions.value.every((s) => s.version === '1.18.25')).toBe(true);
  });

  it('keys the session to session.directory, not to the stale project.worktree', () => {
    /*
     * THE ASSERTION THE FIX EXISTS FOR. On `release/0.5.0` HEAD this reads
     * `slugFromWorktree(old)` and fails on the first `expect`.
     */
    const { old, moved } = paths();
    const state = readOpenCodeEngine({ dbPath: DB_PATH, immutable: true });
    if (state.kind !== 'ok') throw new Error(`engine did not read the fixture: ${state.kind}`);
    expect(state.result.sessions).toHaveLength(1);
    const [session] = state.result.sessions;
    if (session === undefined) throw new Error('no session came back');

    expect(session.projectSlug).toBe(slugFromWorktree(moved));
    expect(session.projectSlug).not.toBe(slugFromWorktree(old));
    expect(state.result.opencodeUnkeyed).toBe(0);
  });

  it('matches the moved workspace and rejects the path it left', () => {
    const { old, moved } = paths();

    const atNewPath = readOpenCodeEngine({
      dbPath: DB_PATH,
      immutable: true,
      workspacePaths: [moved],
    });
    if (atNewPath.kind !== 'ok') throw new Error('engine did not read the fixture');
    expect(atNewPath.result.sessions.every((s) => s.workspaceMatch)).toBe(true);

    // The old path is where `project.worktree` still points. A build that keys
    // off the project row matches HERE and nowhere else, so this leg is the
    // one that goes red in the opposite direction.
    const atOldPath = readOpenCodeEngine({
      dbPath: DB_PATH,
      immutable: true,
      workspacePaths: [old],
    });
    if (atOldPath.kind !== 'ok') throw new Error('engine did not read the fixture');
    expect(atOldPath.result.sessions.some((s) => s.workspaceMatch)).toBe(false);

    // Drive-letter case variance, the trap the CC engine already tolerates.
    const flipped = moved.replace(/^([A-Za-z])(?=:)/, (c) =>
      c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
    );
    expect(flipped).not.toBe(moved);
    const flippedRead = readOpenCodeEngine({
      dbPath: DB_PATH,
      immutable: true,
      workspacePaths: [flipped],
    });
    if (flippedRead.kind !== 'ok') throw new Error('engine did not read the fixture');
    expect(flippedRead.result.sessions.every((s) => s.workspaceMatch)).toBe(true);
  });

  it('falls back to project.worktree when session.directory is empty', () => {
    // The fallback is not decoration: a row OpenCode wrote without a directory
    // still has a project, and keying it `''` would drop a session off the deck
    // that the old code placed correctly.
    const { old } = paths();
    onTempCopy(
      (db) => db.prepare('update session set directory = ?').run(''),
      (dbPath) => {
        const state = readOpenCodeEngine({ dbPath });
        if (state.kind !== 'ok') throw new Error('engine did not read the copy');
        const [session] = state.result.sessions;
        if (session === undefined) throw new Error('no session came back');
        expect(session.projectSlug).toBe(slugFromWorktree(old));
        expect(state.result.opencodeUnkeyed).toBe(0);
      },
    );
  });

  it('counts opencodeUnkeyed and still renders when neither column can key it', () => {
    // G3: no guess. And no silent skip either — rule 18's class is a run that
    // passes over an input without saying so. The session stays visible with an
    // empty key rather than vanishing.
    onTempCopy(
      (db) => {
        db.prepare('update session set directory = ?').run('');
        db.prepare('update project set worktree = ?').run('');
      },
      (dbPath) => {
        // `workspacePaths` IS supplied, so the REAL matcher runs. Omitting it
        // installs `defaultWorkspaceMatch` — `project !== undefined` — which
        // answers `true` here and would have made this leg say nothing about
        // the production rule. Measured: without this argument the assertion
        // below reads `true`.
        const state = readOpenCodeEngine({ dbPath, workspacePaths: ['C:/anywhere/at/all'] });
        if (state.kind !== 'ok') throw new Error('engine did not read the copy');
        expect(state.result.opencodeUnkeyed).toBe(1);
        expect(state.result.sessions).toHaveLength(1);
        const [session] = state.result.sessions;
        if (session === undefined) throw new Error('no session came back');
        expect(session.projectSlug).toBe('');
        expect(session.workspaceMatch).toBe(false);
        // Rendered, not refused: the schema was fine, only the key was absent.
        expect(session.schemaOk).toBe(true);
      },
    );
  });

  it('reports 1.18.25 additive drift without refusing anything', () => {
    /*
     * `project_directory` is the table OpenCode added to record exactly the
     * move this fixture witnesses — it holds BOTH directories against the one
     * project. We do not read it: `session.directory` already answers the
     * question and is a column the fingerprint already requires. It is asserted
     * here as UNKNOWN so that a future decision to read it has to come through
     * this file rather than by accident.
     */
    const state = readOpenCodeEngine({ dbPath: DB_PATH, immutable: true });
    if (state.kind !== 'ok') throw new Error('engine did not read the fixture');
    expect(state.report.unknownTables).toContain('project_directory');
    expect(state.result.refused).toStrictEqual([]);

    // The fixture carries both rows, which is the evidence that OpenCode knows
    // about the move even though `project.worktree` does not say so.
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const dirs = db
        .prepare('select directory from project_directory order by time_created')
        .all() as { directory: string }[];
      const { old, moved } = paths();
      expect(dirs.map((d) => d.directory)).toStrictEqual([old, moved]);
    } finally {
      db.close();
    }
  });

  it('reads nothing but the database, and changes no byte of it (G1)', () => {
    const before = sha256File(DB_PATH);
    readOpenCodeEngine({ dbPath: DB_PATH, immutable: true });
    expect(sha256File(DB_PATH)).toBe(before);
    expect(existsSync(`${DB_PATH}-wal`)).toBe(false);
    expect(existsSync(`${DB_PATH}-shm`)).toBe(false);
  });
});
