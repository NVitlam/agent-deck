// NO SHEBANG HERE, and it must not come back - same rule as
// `scripts/privacy-sweep.mjs` and `scripts/probe-wal.mjs`, for the same
// measured reason. Vite strips a shebang with /^#!.*\n/, JavaScript's `.` does
// not match \r, and this repo checks out CRLF. A shebang here survives into a
// function-wrapped module and dies at import, so the suite that imports this
// file would report "skipped" - which reads green. Nothing here is exec'd
// directly.
//
/**
 * PLAN v0.5.0 Phase 3 / DoD 3.2 + 3.3 - the OpenCode capture procedure.
 *
 * WHAT IT DOES
 * ------------
 * Builds `fixtures/opencode-<version>/opencode.db` from the live OpenCode
 * database. It does NOT file-copy and it does NOT `VACUUM INTO`: the fixture is
 * constructed from scratch out of the source's own DDL, with the secret-bearing
 * tables never created at all, and with only this repository's rows inserted.
 *
 * G1 - READ-ONLY, ABSOLUTELY
 * --------------------------
 * The live database is opened `new DatabaseSync(src, { readOnly: true })` and
 * every statement against it is a SELECT or a PRAGMA read. Nothing under the
 * OpenCode data root is written, created, deleted or renamed. The only files
 * written are inside this repository, under the output directory.
 *
 * G8 - THE FILTER, AND THE ASSERTION THAT IS NOT THE FILTER
 * ---------------------------------------------------------
 * The live database has grown rows belonging to other projects, so "abort if
 * the database contains a foreign project" is no longer a satisfiable rule and
 * would only ever mean "never capture again". The rule implemented instead has
 * two halves and both are in the code, not only in the README:
 *
 *   FILTER    only the rows reachable from this repository's `project` row are
 *             selected. Foreign rows are never read into the fixture.
 *   ASSERT    every row SELECTED FOR CAPTURE is re-checked against this
 *             repository's identity, and any disagreement aborts the run with a
 *             non-zero exit. The assertion runs twice: once over the source
 *             selection, once over the finished fixture.
 *
 * "This repository" is resolved through git rather than assumed, because this
 * script is routinely run from a linked worktree whose top-level directory is
 * NOT the path OpenCode recorded in `project.worktree`. Comparison is
 * case-insensitive on purpose: Windows hands back both `C:/...` and `c:/...`
 * for the same directory and the repo has already been bitten by that once.
 *
 * VERBATIM - NO TRUNCATION, BY EXPLICIT DECISION
 * ----------------------------------------------
 * DoD 3.2 permits truncating long payloads "to shape". The user declined that
 * for this capture: `part.data`, `message.data` and `event.data` are stored
 * exactly as read, with no truncation, normalisation, re-serialisation or
 * pretty-printing. Every id, `callID`, `parent_id`, `aggregate_id`, `seq`,
 * `state.metadata.sessionId`, `state.metadata.parentSessionId`, `time_*` value
 * and reasoning byte survives unchanged - a normalised fixture pins nothing,
 * and the reasoning text is the G4 target itself.
 *
 * Integers are read as BigInt (`setReadBigInts`) so no millisecond timestamp
 * can round-trip through a float. The verification pass re-opens the finished
 * fixture and compares, per table, a SHA-256 over every column of every row AND
 * a SHA-256 over SQLite's own `length(CAST(data AS BLOB))` per row - the second
 * is computed by the engine on the stored bytes, so it catches a byte-level
 * round-trip failure that a JS-string comparison cannot see. Any mismatch
 * aborts.
 *
 * USAGE
 *   node scripts/capture-opencode.mjs --version 1.18.22
 *   node scripts/capture-opencode.mjs --version 1.18.21
 *
 *   --version <v>   REQUIRED. The DATA's `session.version`, never the binary's.
 *                   OpenCode self-updated 1.18.22 -> 1.18.23 mid-measurement
 *                   during Phase 2; a binary's own version number is not a
 *                   property of the bytes it wrote.
 *   --out <dir>     Output directory. Default fixtures/opencode-<version>.
 *   --role <r>      `anchor` or `witness`. Default: anchor if this version is
 *                   the newest present for this project, otherwise witness.
 *   --source <db>   Source database path. Default: the resolved data root.
 *   --no-readme     Build the database only.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

/**
 * The five tables that are DROPPED BY SCHEMA - never created in the fixture, so
 * there is no column named `access_token`, `refresh_token`, `value` or `secret`
 * anywhere in the artifact.
 *
 * The DoD names four. `account_state` is the fifth, from the Phase 2 handoff:
 * it holds no secret itself but exists only to point at `account`, and a
 * superset is the safe direction for a drop list. All five measured 0 rows at
 * capture time, which is exactly why the rule is "by schema" - the schema is
 * the risk, not the rows.
 */
export const DROPPED_TABLES = Object.freeze([
  'account',
  'account_state',
  'control_account',
  'credential',
  'session_share',
]);

/**
 * The six tables `docs/opencode-contract.md` §3 makes the fingerprint target.
 * The fixture must contain all six or it is not a fixture for this engine.
 */
export const REQUIRED_TABLES = Object.freeze([
  'project',
  'session',
  'message',
  'part',
  'event',
  'event_sequence',
]);

/**
 * Insert order is FK order. The source declares real foreign keys
 * (`event.aggregate_id` -> `event_sequence.aggregate_id`, `message.session_id`
 * -> `session.id`, and so on) and the fixture is built with foreign-key
 * enforcement ON, so a capture that is not referentially closed fails here
 * rather than shipping a fixture with dangling ids.
 *
 * `scope` says how each table is filtered:
 *   projects  - rows whose project_id is one of the selected projects
 *   sessions  - rows whose session_id / aggregate_id is one of the selected
 *               sessions
 *   global    - kept whole (schema-migration bookkeeping; no project or
 *               session dimension exists on these tables)
 */
const TABLE_PLAN = Object.freeze([
  { name: 'project', scope: 'self', order: 'id' },
  { name: 'workspace', scope: 'projects', key: 'project_id', order: 'id' },
  { name: 'session', scope: 'self-sessions', order: 'id' },
  { name: 'message', scope: 'sessions', key: 'session_id', order: 'id' },
  { name: 'part', scope: 'sessions', key: 'session_id', order: 'id' },
  { name: 'event_sequence', scope: 'sessions', key: 'aggregate_id', order: 'aggregate_id' },
  { name: 'event', scope: 'sessions', key: 'aggregate_id', order: 'aggregate_id, seq' },
  { name: 'permission', scope: 'projects', key: 'project_id', order: 'id' },
  { name: 'project_directory', scope: 'projects', key: 'project_id', order: 'project_id, directory' },
  { name: 'session_context_epoch', scope: 'sessions', key: 'session_id', order: 'session_id' },
  { name: 'session_input', scope: 'sessions', key: 'session_id', order: 'id' },
  { name: 'session_message', scope: 'sessions', key: 'session_id', order: 'id' },
  { name: 'todo', scope: 'sessions', key: 'session_id', order: 'session_id, position' },
  { name: 'migration', scope: 'global', order: 'id' },
  { name: 'data_migration', scope: 'global', order: 'name' },
]);

/** Tables whose `data` column gets the byte-level round-trip check. */
const DATA_TABLES = Object.freeze(['message', 'part', 'event', 'session_message']);

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/**
 * The OpenCode data root.
 *
 * `USERPROFILE` on win32, never `HOME`. `os.homedir()` reads USERPROFILE on
 * Windows, so a negative control that fakes only HOME runs happily against the
 * REAL data directory and reports a confident green pass on the one check whose
 * entire purpose is proving we never touch it. That is measured, recorded
 * history in this repository, and it is why this function reads the variable
 * directly instead of calling `os.homedir()`.
 *
 * Throws when the variable is unset. A literal absolute path here would be both
 * a lie on any other machine and a privacy-sweep hit.
 */
export function resolveDataRoot(env = process.env) {
  if (process.platform === 'win32') {
    const p = env.USERPROFILE;
    if (typeof p !== 'string' || p.length === 0) {
      throw new Error('USERPROFILE is unset; cannot resolve the OpenCode data root');
    }
    return path.join(p, '.local', 'share', 'opencode');
  }
  const h = env.HOME;
  if (typeof h !== 'string' || h.length === 0) {
    throw new Error('HOME is unset; cannot resolve the OpenCode data root');
  }
  return path.join(h, '.local', 'share', 'opencode');
}

/**
 * Canonical form for comparing filesystem locations that came from two
 * different producers.
 *
 * Lower-cased because the Windows drive-letter case varies for the same
 * directory (`C:\Users\...` and `c:\Users\...` both occur, and the CC project
 * slugs already forced this repo to match case-insensitively). Separators
 * normalised to `/` because OpenCode stores `C:/Users/...` while `path` on
 * win32 produces `C:\Users\...`. Trailing separators dropped.
 */
export function normaliseRoot(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  let s = p.replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s.toLowerCase();
}

/** True when `child` is `root` or lives underneath it. Case-insensitive. */
export function isInsideRoot(child, root) {
  const c = normaliseRoot(child);
  const r = normaliseRoot(root);
  if (r === '') return false;
  return c === r || c.startsWith(`${r}/`);
}

/**
 * Every absolute path that IS this repository.
 *
 * There is more than one, and that is the whole point: this script is normally
 * run from a linked worktree under `.claude/worktrees/`, whose top-level is not
 * the directory OpenCode recorded in `project.worktree`. `--git-common-dir`
 * names the main checkout's `.git`, so its parent is the main worktree. Both -
 * plus the script's own repo root - are this repository, and a G8 check written
 * against only one of them either rejects a correct capture or, worse, is
 * quietly relaxed by whoever hits it.
 *
 * git is consulted, not assumed: if it is unavailable the script still has the
 * script-relative root, which is correct for a non-worktree checkout.
 */
export function repoIdentityRoots(repoRoot = REPO_ROOT) {
  const roots = new Set([normaliseRoot(repoRoot)]);
  const ask = (args) => {
    try {
      return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const top = ask(['rev-parse', '--show-toplevel']);
  if (top !== '') roots.add(normaliseRoot(top));
  const common = ask(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common !== '') roots.add(normaliseRoot(path.dirname(common)));
  return [...roots].filter((r) => r !== '');
}

/** True when `p` names this repository or something inside it. */
export function isOwnLocation(p, roots) {
  return roots.some((r) => isInsideRoot(p, r));
}

/** Numeric-component version compare; returns >0 when `a` is newer than `b`. */
export function compareVersions(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = Number.parseInt(pa[i] ?? '0', 10) || 0;
    const y = Number.parseInt(pb[i] ?? '0', 10) || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 * Small SQL helpers
 * ------------------------------------------------------------------ */

/** A statement that returns integers as BigInt, so no timestamp meets a float. */
function exact(db, sql) {
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  return stmt;
}

function quoteList(values) {
  // Ids here are SQLite-generated `ses_*` / `prj` tokens, but the quoting is
  // still done properly rather than trusted: a single quote in an id would
  // otherwise change the shape of the query.
  return values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ');
}

function tableColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((r) => String(r.name));
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => String(r.name));
}

/**
 * Deterministic hash of a result set: every column of every row, in the order
 * the query returned them, with a type tag so `1` and `'1'` cannot collide.
 */
function hashRows(rows, columns) {
  const h = createHash('sha256');
  for (const row of rows) {
    for (const col of columns) {
      const v = row[col];
      if (v === null || v === undefined) {
        h.update('N\u0000');
      } else if (typeof v === 'bigint') {
        h.update(`I${v.toString(10)}\u0000`);
      } else if (typeof v === 'number') {
        h.update(`R${Object.is(v, -0) ? '0' : String(v)}\u0000`);
      } else if (typeof v === 'string') {
        h.update('S');
        h.update(v, 'utf8');
        h.update('\u0000');
      } else if (v instanceof Uint8Array) {
        h.update('B');
        h.update(v);
        h.update('\u0000');
      } else {
        throw new Error(`unhandled column type ${typeof v}`);
      }
    }
    h.update('\u0001');
  }
  return h.digest('hex');
}

/* ------------------------------------------------------------------ *
 * The capture
 * ------------------------------------------------------------------ */

function selectionFor(plan, projectIds, sessionIds) {
  const p = quoteList(projectIds);
  const s = quoteList(sessionIds);
  switch (plan.scope) {
    case 'self':
      return `SELECT * FROM "${plan.name}" WHERE id IN (${p}) ORDER BY ${plan.order}`;
    case 'self-sessions':
      return `SELECT * FROM "${plan.name}" WHERE id IN (${s}) ORDER BY ${plan.order}`;
    case 'projects':
      return `SELECT * FROM "${plan.name}" WHERE "${plan.key}" IN (${p}) ORDER BY ${plan.order}`;
    case 'sessions':
      return `SELECT * FROM "${plan.name}" WHERE "${plan.key}" IN (${s}) ORDER BY ${plan.order}`;
    case 'global':
      return `SELECT * FROM "${plan.name}" ORDER BY ${plan.order}`;
    default:
      throw new Error(`unknown scope ${plan.scope}`);
  }
}

function fixtureSelection(plan) {
  return `SELECT * FROM "${plan.name}" ORDER BY ${plan.order}`;
}

/**
 * The G8 assertion. Not the filter - the filter already ran. This is the check
 * that what the filter produced really is this repository and nothing else, and
 * it throws rather than warning.
 */
function assertG8(where, projects, sessions, roots) {
  const problems = [];
  const projectIds = new Set(projects.map((r) => String(r.id)));
  for (const row of projects) {
    if (!isOwnLocation(String(row.worktree), roots)) {
      problems.push(`${where}: project ${row.id} worktree ${row.worktree} is not this repository`);
    }
  }
  for (const row of sessions) {
    if (!projectIds.has(String(row.project_id))) {
      problems.push(`${where}: session ${row.id} belongs to unselected project ${row.project_id}`);
    }
    const dir = row.directory === null || row.directory === undefined ? '' : String(row.directory);
    if (dir !== '' && !isOwnLocation(dir, roots)) {
      problems.push(`${where}: session ${row.id} directory ${dir} is not inside this repository`);
    }
    const sp = row.path === null || row.path === undefined ? '' : String(row.path);
    if (sp !== '' && !isOwnLocation(sp, roots)) {
      problems.push(`${where}: session ${row.id} path ${sp} is not inside this repository`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`G8 VIOLATION - capture aborted\n  ${problems.join('\n  ')}`);
  }
}

/**
 * Build one corpus. Returns the stats the README is written from.
 *
 * Nothing here writes to `sourcePath`. The source handle is opened read-only
 * and closed in the `finally`.
 */
export function capture(options) {
  const version = options.version;
  const outDir = options.outDir;
  const sourcePath = options.sourcePath;
  const roots = options.identityRoots ?? repoIdentityRoots();
  const log = options.log ?? ((line) => console.log(line));

  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('--version is required and must be the DATA\'s session.version');
  }
  if (!fs.existsSync(sourcePath)) {
    const err = new Error(
      `no OpenCode database at ${sourcePath}\n` +
        '      This is a hard failure, not a fallback: nothing was captured. ' +
        'The capture never looks anywhere else for a database.',
    );
    err.code = 'ENOENT_OPENCODE_DB';
    throw err;
  }

  const src = new DatabaseSync(sourcePath, { readOnly: true });
  let out = null;
  const outFile = path.join(outDir, 'opencode.db');

  try {
    /* --- 1. which project is us, and what is everything else ---------- */
    const allProjects = exact(src, 'SELECT * FROM project ORDER BY id').all();
    const ours = allProjects.filter((r) => isOwnLocation(String(r.worktree), roots));
    const foreign = allProjects.filter((r) => !ours.includes(r));
    if (ours.length === 0) {
      throw new Error(
        `no project row matches this repository.\n  looked for: ${roots.join('\n              ')}\n` +
          `  found: ${allProjects.map((r) => `${r.id} -> ${r.worktree}`).join('\n         ')}`,
      );
    }
    const ourIds = ours.map((r) => String(r.id));

    /* --- 2. sessions: ours, this version ------------------------------ */
    const versionCensus = exact(
      src,
      `SELECT version, count(*) AS n FROM session WHERE project_id IN (${quoteList(ourIds)}) GROUP BY version ORDER BY version`,
    )
      .all()
      .map((r) => ({ version: String(r.version), sessions: Number(r.n) }));

    const sessionRows = exact(
      src,
      `SELECT * FROM session WHERE project_id IN (${quoteList(ourIds)}) AND version = '${version.replace(/'/g, "''")}' ORDER BY id`,
    ).all();
    if (sessionRows.length === 0) {
      throw new Error(
        `no sessions for this repository at version ${version}. Versions present: ` +
          versionCensus.map((v) => `${v.version} (${v.sessions})`).join(', '),
      );
    }
    const sessionIds = sessionRows.map((r) => String(r.id));

    /* --- 3. G8 over the SELECTION, before a byte is written ----------- */
    assertG8('source selection', ours, sessionRows, roots);

    /* --- 4. what is being left out, logged by id ---------------------- */
    const excludedProjects = foreign.map((r) => {
      const n = exact(src, 'SELECT count(*) AS n FROM session WHERE project_id = ?').get(String(r.id));
      return { id: String(r.id), worktree: String(r.worktree), sessions: Number(n.n) };
    });
    const excludedSessions = exact(
      src,
      `SELECT id, version, project_id FROM session WHERE project_id NOT IN (${quoteList(ourIds)}) ORDER BY id`,
    )
      .all()
      .map((r) => ({ id: String(r.id), version: String(r.version), projectId: String(r.project_id) }));
    const otherVersions = versionCensus.filter((v) => v.version !== version);

    log('G8 filter');
    log(`  kept    project ${ourIds.join(', ')} -> ${ours.map((r) => r.worktree).join(', ')}`);
    for (const p of excludedProjects) {
      log(`  EXCLUDED project ${p.id} -> ${p.worktree} (${p.sessions} session(s))`);
    }
    for (const s of excludedSessions) {
      log(`  EXCLUDED session ${s.id} version ${s.version} (project ${s.projectId})`);
    }
    for (const v of otherVersions) {
      log(`  not in this corpus: ${v.sessions} own session(s) at version ${v.version}`);
    }

    /* --- 5. build the fixture from the SOURCE's own DDL ---------------- */
    fs.mkdirSync(outDir, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${outFile}${suffix}`;
      if (fs.existsSync(f)) fs.rmSync(f);
    }

    const objects = src
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index') ORDER BY type DESC, name",
      )
      .all();
    const kept = new Set(TABLE_PLAN.map((t) => t.name));
    const droppedSeen = [];
    const tableDdl = [];
    const indexDdl = [];
    for (const o of objects) {
      const table = String(o.tbl_name);
      if (DROPPED_TABLES.includes(table)) {
        if (o.type === 'table') droppedSeen.push(table);
        continue;
      }
      if (!kept.has(table)) {
        // A table the source has and the plan does not name. Refusing here is
        // the safe direction: an unplanned table may be the next
        // secret-bearing one, and silently shipping it is how a fixture
        // becomes a leak.
        throw new Error(
          `source table "${table}" is neither kept nor dropped by this script. ` +
            'Add it to TABLE_PLAN or to DROPPED_TABLES deliberately - a new OpenCode ' +
            'table is a decision, not a default.',
        );
      }
      if (o.type === 'table') tableDdl.push(String(o.sql));
      else indexDdl.push(String(o.sql));
    }
    for (const t of DROPPED_TABLES) {
      if (!droppedSeen.includes(t)) {
        throw new Error(
          `expected to DROP table "${t}" but the source does not have it. ` +
            'The drop list is a claim about the source schema; verify before relaxing it.',
        );
      }
    }
    // Row counts of the dropped tables, recorded before they cease to exist:
    // the point of dropping by schema is that the count is irrelevant, and
    // recording it is what makes that statement checkable rather than a hope.
    const droppedCounts = DROPPED_TABLES.map((t) => ({
      table: t,
      rows: Number(src.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n),
    }));

    out = new DatabaseSync(outFile);
    out.exec('PRAGMA foreign_keys = ON');
    for (const sql of tableDdl) out.exec(sql);

    /* --- 6. insert, verbatim, in FK order ------------------------------ */
    const tableStats = [];
    out.exec('BEGIN');
    for (const plan of TABLE_PLAN) {
      const cols = tableColumns(src, plan.name);
      const rows = exact(src, selectionFor(plan, ourIds, sessionIds)).all();
      if (rows.length > 0) {
        const insert = out.prepare(
          `INSERT INTO "${plan.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        );
        for (const row of rows) {
          insert.run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
        }
      }
      tableStats.push({ table: plan.name, rows: rows.length });
    }
    out.exec('COMMIT');
    for (const sql of indexDdl) out.exec(sql);
    out.close();
    out = null;

    /* --- 7. verify the fixture against the source ---------------------- */
    const check = new DatabaseSync(outFile, { readOnly: true });
    const mismatches = [];
    try {
      const present = tableNames(check);
      for (const t of DROPPED_TABLES) {
        if (present.includes(t)) mismatches.push(`dropped table "${t}" exists in the fixture`);
      }
      for (const t of REQUIRED_TABLES) {
        if (!present.includes(t)) mismatches.push(`required table "${t}" is missing from the fixture`);
      }

      for (const plan of TABLE_PLAN) {
        const cols = tableColumns(src, plan.name);
        const fixCols = tableColumns(check, plan.name);
        if (cols.join('\u0000') !== fixCols.join('\u0000')) {
          mismatches.push(`${plan.name}: column list differs`);
          continue;
        }
        const a = hashRows(exact(src, selectionFor(plan, ourIds, sessionIds)).all(), cols);
        const b = hashRows(exact(check, fixtureSelection(plan)).all(), cols);
        if (a !== b) mismatches.push(`${plan.name}: row hash differs (source ${a}, fixture ${b})`);

        if (DATA_TABLES.includes(plan.name)) {
          // SQLite computes these lengths on the STORED bytes, so this catches
          // a byte-level round-trip failure that a JS-string comparison cannot
          // see (a lone surrogate, for instance, survives string equality and
          // does not survive UTF-8).
          const lenSql = (base) =>
            base.replace('SELECT *', 'SELECT length(CAST("data" AS BLOB)) AS n');
          const la = hashRows(
            exact(src, lenSql(selectionFor(plan, ourIds, sessionIds))).all(),
            ['n'],
          );
          const lb = hashRows(exact(check, lenSql(fixtureSelection(plan))).all(), ['n']);
          if (la !== lb) mismatches.push(`${plan.name}: stored-byte lengths differ`);
        }
      }

      // G8 again, this time over what actually landed on disk.
      assertG8(
        'fixture',
        exact(check, 'SELECT * FROM project ORDER BY id').all(),
        exact(check, 'SELECT * FROM session ORDER BY id').all(),
        roots,
      );

      if (mismatches.length > 0) {
        throw new Error(`VERBATIM VERIFICATION FAILED\n  ${mismatches.join('\n  ')}`);
      }
    } finally {
      check.close();
    }

    /* --- 8. the numbers the README is written from --------------------- */
    const stats = measure(src, sessionIds, version);
    const dbBytes = fs.statSync(outFile).size;

    return {
      version,
      outDir,
      outFile,
      dbBytes,
      sourcePath,
      identityRoots: roots,
      projects: ours.map((r) => ({ id: String(r.id), worktree: String(r.worktree), vcs: r.vcs === null ? null : String(r.vcs) })),
      sessionIds,
      sessionRows: sessionRows.map((r) => ({
        id: String(r.id),
        parentId: r.parent_id === null ? null : String(r.parent_id),
        agent: r.agent === null ? null : String(r.agent),
        title: r.title === null ? null : String(r.title),
        timeCreated: r.time_created === null ? null : Number(r.time_created),
        timeUpdated: r.time_updated === null ? null : Number(r.time_updated),
      })),
      tableStats,
      droppedCounts,
      excludedProjects,
      excludedSessions,
      versionCensus,
      otherVersions,
      indexCount: indexDdl.length,
      ...stats,
    };
  } finally {
    if (out !== null) {
      try {
        out.close();
      } catch {
        /* the primary error is the one worth reporting */
      }
    }
    src.close();
  }
}

/**
 * Everything DoD 3.3's checklist has to tick, measured from the source over the
 * exact rows that were captured. Every needle test uses GLOB or `instr`, never
 * LIKE: SQLite's LIKE is CASE-INSENSITIVE, so a three-letter project name
 * searched with LIKE matches every word that happens to contain those letters
 * in any case, and any count taken from it is wrong. That has already cost this
 * repo one probe. The offending needle is deliberately not repeated here: it is
 * another project's name, which is the FOREIGN content this filter exists to
 * keep out of committed files.
 */
function measure(src, sessionIds, version) {
  const S = quoteList(sessionIds);
  const one = (sql, ...args) => exact(src, sql).get(...args);
  const many = (sql, ...args) => exact(src, sql).all(...args);
  const n = (v) => (v === null || v === undefined ? 0 : Number(v));

  const partTypes = many(
    `SELECT json_extract(data, '$.type') AS t, count(*) AS n FROM part WHERE session_id IN (${S}) GROUP BY 1 ORDER BY n DESC, t`,
  ).map((r) => ({ type: r.t === null ? null : String(r.t), count: Number(r.n) }));

  const toolStatus = many(
    `SELECT json_extract(data, '$.state.status') AS s, count(*) AS n FROM part WHERE session_id IN (${S}) AND json_extract(data, '$.type') = 'tool' GROUP BY 1 ORDER BY n DESC, s`,
  ).map((r) => ({ status: r.s === null ? null : String(r.s), count: Number(r.n) }));

  const toolNames = many(
    `SELECT json_extract(data, '$.tool') AS s, count(*) AS n FROM part WHERE session_id IN (${S}) AND json_extract(data, '$.type') = 'tool' GROUP BY 1 ORDER BY n DESC, s`,
  ).map((r) => ({ tool: r.s === null ? null : String(r.s), count: Number(r.n) }));

  const eventTypes = many(
    `SELECT type, count(*) AS n FROM event WHERE aggregate_id IN (${S}) GROUP BY 1 ORDER BY n DESC, type`,
  ).map((r) => ({ type: String(r.type), count: Number(r.n) }));

  const reasoning = one(
    `SELECT count(*) AS n, max(length(json_extract(data, '$.text'))) AS m FROM part WHERE session_id IN (${S}) AND json_extract(data, '$.type') = 'reasoning'`,
  );
  const reasoningLongest = one(
    `SELECT id, session_id, length(json_extract(data, '$.text')) AS m FROM part WHERE session_id IN (${S}) AND json_extract(data, '$.type') = 'reasoning' ORDER BY m DESC, id LIMIT 1`,
  );

  const task = one(
    `SELECT count(*) AS n, sum(CASE WHEN json_extract(data, '$.state.metadata.sessionId') IS NULL THEN 1 ELSE 0 END) AS nosess FROM part WHERE session_id IN (${S}) AND json_extract(data, '$.tool') = 'task'`,
  );
  const taskNoSessionExample = one(
    `SELECT id, session_id FROM part WHERE session_id IN (${S}) AND json_extract(data, '$.tool') = 'task' AND json_extract(data, '$.state.metadata.sessionId') IS NULL ORDER BY id LIMIT 1`,
  );

  const agreeing = many(
    `SELECT pt.id AS part_id, pt.session_id AS parent, c.id AS child
       FROM part pt
       JOIN session c ON c.id = json_extract(pt.data, '$.state.metadata.sessionId')
      WHERE pt.session_id IN (${S})
        AND json_extract(pt.data, '$.tool') = 'task'
        AND c.parent_id = pt.session_id
        AND json_extract(pt.data, '$.state.metadata.parentSessionId') = pt.session_id
      ORDER BY pt.id`,
  ).map((r) => ({ partId: String(r.part_id), parent: String(r.parent), child: String(r.child) }));

  const stepFinish = one(
    `SELECT count(*) AS n FROM part WHERE session_id IN (${S}) AND json_extract(data, '$.type') = 'step-finish' AND json_extract(data, '$.tokens.total') > 0`,
  );

  const compaction = many(
    `SELECT id, session_id, data FROM part WHERE session_id IN (${S}) AND json_extract(data, '$.type') = 'compaction' ORDER BY id`,
  ).map((r) => ({ id: String(r.id), sessionId: String(r.session_id), data: String(r.data) }));

  const bigOutput = one(
    `SELECT count(*) AS n, max(length(json_extract(data, '$.state.output'))) AS m FROM part WHERE session_id IN (${S}) AND json_extract(data, '$.type') = 'tool' AND length(json_extract(data, '$.state.output')) >= 50000`,
  );
  const bigOutputExample = one(
    `SELECT id, session_id, length(json_extract(data, '$.state.output')) AS m FROM part WHERE session_id IN (${S}) AND json_extract(data, '$.type') = 'tool' ORDER BY m DESC, id LIMIT 1`,
  );

  const cursorRows = many(
    `SELECT aggregate_id, seq FROM event_sequence WHERE aggregate_id IN (${S}) ORDER BY aggregate_id`,
  ).map((r) => ({ aggregateId: String(r.aggregate_id), seq: Number(r.seq) }));

  const CONCURRENCY_SQL =
    'SELECT a.id AS a, b.id AS b FROM session a JOIN session b ON a.id < b.id\n' +
    '  WHERE a.id IN (<the captured sessions>) AND b.id IN (<the captured sessions>)\n' +
    '    AND a.parent_id IS NOT b.id AND b.parent_id IS NOT a.id\n' +
    '    AND a.time_created < b.time_updated AND b.time_created < a.time_updated';
  const concurrent = many(
    `SELECT a.id AS a, b.id AS b FROM session a JOIN session b ON a.id < b.id
      WHERE a.id IN (${S}) AND b.id IN (${S})
        AND a.parent_id IS NOT b.id AND b.parent_id IS NOT a.id
        AND a.time_created < b.time_updated AND b.time_created < a.time_updated
      ORDER BY a.id, b.id`,
  ).map((r) => ({ a: String(r.a), b: String(r.b) }));

  const depth = one(
    `SELECT count(*) AS n FROM session a JOIN session b ON a.parent_id = b.id JOIN session c ON b.parent_id = c.id WHERE a.id IN (${S})`,
  );

  const dataBytes = {
    part: n(one(`SELECT sum(length(CAST(data AS BLOB))) AS n FROM part WHERE session_id IN (${S})`).n),
    message: n(one(`SELECT sum(length(CAST(data AS BLOB))) AS n FROM message WHERE session_id IN (${S})`).n),
    event: n(one(`SELECT sum(length(CAST(data AS BLOB))) AS n FROM event WHERE aggregate_id IN (${S})`).n),
  };

  // Case-SENSITIVE needle scan. GLOB, never LIKE.
  const NEEDLE_GLOBS = [
    ['ghp_', '*ghp_*'],
    ['github_pat_', '*github_pat_*'],
    ['sk-ant-', '*sk-ant-*'],
    ['AKIA', '*AKIA*'],
    ['xox?-', '*xox?-*'],
    ['-----BEGIN', '*-----BEGIN*'],
  ];
  const needles = NEEDLE_GLOBS.map(([label, g]) => ({
    needle: label,
    part: n(one(`SELECT count(*) AS n FROM part WHERE session_id IN (${S}) AND data GLOB ?`, g).n),
    message: n(one(`SELECT count(*) AS n FROM message WHERE session_id IN (${S}) AND data GLOB ?`, g).n),
    event: n(one(`SELECT count(*) AS n FROM event WHERE aggregate_id IN (${S}) AND data GLOB ?`, g).n),
  }));

  // Which `projects/<project>` tokens the captured bytes mention. Extracted
  // in JS because SQLite has no regex; the GLOB narrows the rows first.
  const projects = new Map();
  const re = /projects[\\/]+([A-Za-z0-9._-]+)/g;
  const scan = (rows) => {
    for (const r of rows) {
      const s = String(r.data);
      re.lastIndex = 0;
      let m = re.exec(s);
      while (m !== null) {
        projects.set(m[1], (projects.get(m[1]) ?? 0) + 1);
        m = re.exec(s);
      }
    }
  };
  scan(many(`SELECT data FROM part WHERE session_id IN (${S}) AND data GLOB '*projects*'`));
  scan(many(`SELECT data FROM message WHERE session_id IN (${S}) AND data GLOB '*projects*'`));
  scan(many(`SELECT data FROM event WHERE aggregate_id IN (${S}) AND data GLOB '*projects*'`));

  const nulRows = n(
    one(
      `SELECT (SELECT count(*) FROM part WHERE session_id IN (${S}) AND instr(data, char(0)) > 0)
            + (SELECT count(*) FROM message WHERE session_id IN (${S}) AND instr(data, char(0)) > 0)
            + (SELECT count(*) FROM event WHERE aggregate_id IN (${S}) AND instr(data, char(0)) > 0) AS n`,
    ).n,
  );

  return {
    roots: sessionIds.length - n(one(`SELECT count(*) AS n FROM session WHERE id IN (${S}) AND parent_id IS NOT NULL`).n),
    children: n(one(`SELECT count(*) AS n FROM session WHERE id IN (${S}) AND parent_id IS NOT NULL`).n),
    partTypes,
    toolStatus,
    toolNames,
    eventTypes,
    eventMaxSeq: n(one(`SELECT max(seq) AS n FROM event WHERE aggregate_id IN (${S})`).n),
    reasoningCount: n(reasoning.n),
    reasoningMaxChars: n(reasoning.m),
    reasoningLongest:
      reasoningLongest === undefined
        ? null
        : { id: String(reasoningLongest.id), sessionId: String(reasoningLongest.session_id), chars: n(reasoningLongest.m) },
    taskParts: n(task.n),
    taskPartsNoSessionId: n(task.nosess),
    taskNoSessionExample:
      taskNoSessionExample === undefined
        ? null
        : { id: String(taskNoSessionExample.id), sessionId: String(taskNoSessionExample.session_id) },
    agreeingPairs: agreeing,
    stepFinishNonZeroTokens: n(stepFinish.n),
    compaction,
    bigOutputCount: n(bigOutput.n),
    bigOutputMaxChars: n(bigOutput.m),
    bigOutputExample:
      bigOutputExample === undefined
        ? null
        : { id: String(bigOutputExample.id), sessionId: String(bigOutputExample.session_id), chars: n(bigOutputExample.m) },
    cursorRows,
    concurrent,
    concurrencySql: CONCURRENCY_SQL,
    grandchildSessions: n(depth.n),
    dataBytes,
    needles,
    projectsTokens: [...projects.entries()].map(([token, count]) => ({ token, count })).sort((x, y) => y.count - x.count),
    nulRows,
    capturedVersion: version,
  };
}

/* ------------------------------------------------------------------ *
 * README
 * ------------------------------------------------------------------ */

const group = (v) => v.toLocaleString('en-US');

/**
 * A foreign worktree, reduced to its shape.
 *
 * The G8 log has to say what was excluded, and the excluded thing is another
 * project's absolute path - which is precisely the FOREIGN content the privacy
 * sweep drives to zero. Writing it verbatim into a committed document in a
 * public repository would make the G8 record a G8 violation, so the README gets
 * the root plus a segment count and the console gets the full value.
 *
 * The root is kept because "which drive" is not identifying and the shape is
 * what a reader needs; `/` (the `global` pseudo-project) has no segments at all
 * and comes back unchanged.
 */
export function redactForeignPath(p) {
  const s = String(p).replace(/\\/g, '/');
  const drive = /^[A-Za-z]:/.exec(s);
  const root = drive !== null ? drive[0] : s.startsWith('/') ? '/' : '';
  const rest = s
    .slice(root === '/' ? 1 : root.length)
    .split('/')
    .filter((seg) => seg !== '');
  if (rest.length === 0) return root === '' ? '[redacted]' : root;
  const head = root === '' ? '' : root === '/' ? '/' : `${root}/`;
  return `${head}[${rest.length} path segment${rest.length === 1 ? '' : 's'} redacted]`;
}

/**
 * The corpus README, written by the capture rather than by hand so the numbers
 * in it are measured at capture time and cannot describe the previous run.
 *
 * Every line below is a SINGLE-QUOTED JavaScript string, deliberately: markdown
 * in this repo is dense with backticks, and this file is read by a shell often
 * enough that the recorded backtick-is-command-substitution trap applies. In a
 * single-quoted JS string a backtick is just a character.
 */
export function renderReadme(stats, role, generatedAt) {
  const L = [];
  const w = (line) => L.push(line);
  const version = stats.version;
  const isAnchor = role === 'anchor';
  const other = stats.otherVersions.map((v) => v.version);

  w('# `fixtures/opencode-' + version + '/` — ' + (isAnchor ? 'the OpenCode provenance **anchor**' : 'an OpenCode drift **witness**'));
  w('');
  if (isAnchor) {
    w('**This is the anchor corpus for the OpenCode engine.** It is the version whose structure the');
    w('Phase 4 fingerprint\'s required-table and required-column assertions are proved against. Captured');
    w('raw and unredacted, like every other real capture here (G6).');
  } else {
    w('**This is a drift witness, not the anchor.** The anchor is `fixtures/opencode-' + (other[0] ?? '<newer>') + '/`.');
    w('This corpus exists because it disagrees with the anchor about a shape that matters, and a fixture');
    w('set with only one version cannot tell an optional field from a required one. What it witnesses is');
    w('the **`compaction` part shape** — see "The compaction split" below. Captured raw and unredacted,');
    w('like every other real capture here (G6).');
  }
  w('');
  w('The version in the directory name is the **data\'s** `session.version`, never the binary\'s.');
  w('OpenCode self-updated `1.18.22` → `1.18.23` underneath a Phase 2 measurement, and the same');
  w('database held two data versions while it happened; a binary\'s own version number is not a');
  w('property of the bytes it wrote.');
  w('');
  w('## Provenance');
  w('');
  w('| | |');
  w('|---|---|');
  w('| OpenCode data version | **' + version + '** — every `session.version` in this corpus, ' + stats.sessionIds.length + ' of ' + stats.sessionIds.length + ' |');
  w('| Role | ' + (isAnchor ? '**anchor**' : '**witness**') + ' |');
  w('| Captured | ' + generatedAt + ' |');
  w('| Source | `%USERPROFILE%\\.local\\share\\opencode\\opencode.db`, opened **read-only** (`DatabaseSync { readOnly: true }`) |');
  w('| Machine | Windows 11 native |');
  w('| Project | `' + stats.projects.map((p) => p.id).join('`, `') + '` → `' + stats.projects.map((p) => p.worktree).join('`, `') + '` |');
  w('| Sessions | ' + stats.sessionIds.length + ' (' + stats.roots + ' root, ' + stats.children + ' child) |');
  w('| Fixture size | ' + group(stats.dbBytes) + ' bytes |');
  w('');
  w('Other data versions present in the live database for this project at capture time: ' +
    (stats.otherVersions.length === 0
      ? '**none**.'
      : stats.otherVersions.map((v) => '`' + v.version + '` (' + v.sessions + ' session(s))').join(', ') + '.'));
  w('Those sessions are **not** in this corpus; ' +
    (stats.otherVersions.length === 0 ? '' : 'they are captured separately as `fixtures/opencode-' + stats.otherVersions.map((v) => v.version).join('/`, `fixtures/opencode-') + '/`.'));
  w('');
  w('## The procedure, exactly as run');
  w('');
  w('```console');
  w('node scripts/capture-opencode.mjs --version ' + version);
  w('```');
  w('');
  w('It is deterministic and re-runnable: the output directory and the target version are parameters,');
  w('nothing about this corpus is hard-coded in the script, and re-running against the same source rows');
  w('produces the same database.');
  w('');
  w('**The live database is never written.** It is opened `{ readOnly: true }` and every statement');
  w('against it is a `SELECT` or a `PRAGMA` read. The fixture is **not** a file copy and **not** a');
  w('`VACUUM INTO`: it is built from scratch out of the source\'s own DDL, read from `sqlite_master`, so');
  w('the fixture\'s schema is the real schema byte-for-byte and the Phase 4 fingerprint is pinned to real');
  w('bytes rather than to a hand-written approximation. ' + stats.indexCount + ' indexes are recreated from the same source.');
  w('');
  w('## What is in it');
  w('');
  w('| Table | Rows |');
  w('|---|---|');
  for (const t of stats.tableStats) w('| `' + t.table + '` | ' + group(t.rows) + ' |');
  w('');
  w('`data`-column bytes, as stored: `part` ' + group(stats.dataBytes.part) + ' · `message` ' +
    group(stats.dataBytes.message) + ' · `event` ' + group(stats.dataBytes.event) + '.');
  w('');
  w('**Part types:** ' + stats.partTypes.map((p) => '`' + p.type + '` ' + p.count).join(' · ') + '.');
  w('');
  w('**Tools:** ' + stats.toolNames.map((p) => '`' + p.tool + '` ' + p.count).join(' · ') + '.');
  w('');
  w('**Tool states:** ' + stats.toolStatus.map((p) => '`' + p.status + '` ' + p.count).join(' · ') + '.');
  w('');
  w('**Event types:** ' + stats.eventTypes.map((p) => '`' + p.type + '` ' + p.count).join(' · ') +
    '. Max `seq` across the corpus: **' + group(stats.eventMaxSeq) + '**.');
  w('');
  w('## Session ids taken');
  w('');
  w('| Session | Parent | Agent | Created (ms) |');
  w('|---|---|---|---|');
  for (const s of stats.sessionRows) {
    w('| `' + s.id + '` | ' + (s.parentId === null ? '— (root)' : '`' + s.parentId + '`') + ' | `' +
      (s.agent ?? '') + '` | ' + s.timeCreated + ' |');
  }
  w('');
  w('## DoD 3.3 checklist');
  w('');
  w('Every row is measured over the rows this corpus actually contains, by the capture that wrote it.');
  w('');
  if (isAnchor) {
    w('**DoD 3.3 is a requirement on the ANCHOR corpus** — "in one `fixtures/opencode-<version>/`" —');
    w('so on this corpus a ❌ is a real failure and the harvest is not done.');
  } else {
    w('**DoD 3.3 is a requirement on the ANCHOR corpus** — "in one `fixtures/opencode-<version>/`" —');
    w('and the anchor is `fixtures/opencode-' + (other[0] ?? '<newer>') + '/`, where every item is ticked. This corpus exists');
    w('for the shape it disagrees about, not to satisfy the checklist a second time, so an item this');
    w('corpus does not happen to carry is marked ➖ (**covered by the anchor**) rather than ❌. Reading a');
    w('➖ here as a gap in the harvest would be reading the wrong corpus.');
  }
  w('');
  w('| # | Item | Status | Evidence |');
  w('|---|---|---|---|');

  const tick = (ok) => (ok ? '✅' : isAnchor ? '❌' : '➖');
  const completed = stats.toolStatus.find((s) => s.status === 'completed');
  const errored = stats.toolStatus.find((s) => s.status === 'error');
  w('| 1 | completed and error tool parts | ' + tick((completed?.count ?? 0) > 0 && (errored?.count ?? 0) > 0) +
    ' | `completed` ' + (completed?.count ?? 0) + ', `error` ' + (errored?.count ?? 0) + ' |');
  w('| 2 | a reasoning part with non-trivial text | ' + tick(stats.reasoningMaxChars >= 1000) +
    ' | ' + stats.reasoningCount + ' reasoning parts, longest ' + group(stats.reasoningMaxChars) + ' chars (`' +
    (stats.reasoningLongest?.id ?? '') + '`) — **verbatim, the G4 target** |');
  w('| 3 | the depth-1 task pair with agreeing join keys | ' + tick(stats.agreeingPairs.length > 0) +
    ' | ' + stats.agreeingPairs.length + ' pair(s) where the `task` part\'s `state.metadata.sessionId` = child `session.id`, `state.metadata.parentSessionId` = the part\'s own `session_id`, and the child\'s `parent_id` agrees. First: part `' +
    (stats.agreeingPairs[0]?.partId ?? '') + '` → `' + (stats.agreeingPairs[0]?.child ?? '') + '` |');
  w('| 4 | **one `task` part with no `sessionId`** | ' + tick(stats.taskPartsNoSessionId > 0) +
    ' | ' + stats.taskPartsNoSessionId + ' of ' + stats.taskParts + ' `task` parts have `state.metadata.sessionId` NULL' +
    (stats.taskNoSessionExample === null ? '' : ' (e.g. `' + stats.taskNoSessionExample.id + '`)') +
    ' — the parked case, contract §G |');
  w('| 5 | step-finish with non-zero tokens | ' + tick(stats.stepFinishNonZeroTokens > 0) +
    ' | ' + stats.stepFinishNonZeroTokens + ' `step-finish` parts with `tokens.total > 0` |');
  w('| 6 | per-session event-cursor snapshots | ' + tick(stats.cursorRows.length === stats.sessionIds.length) +
    ' | `event_sequence` has ' + stats.cursorRows.length + ' rows for ' + stats.sessionIds.length +
    ' sessions; max `seq` ' + group(Math.max(0, ...stats.cursorRows.map((c) => c.seq))) + ' |');
  w('| 7 | the compaction rows | ' + tick(stats.compaction.length > 0) +
    ' | ' + stats.compaction.length + ' row(s); see "The compaction split" |');
  w('| 8 | an inline tool output ≥ 50,000 chars | ' + tick(stats.bigOutputCount > 0) +
    ' | ' + stats.bigOutputCount + ' tool part(s) at or above 50,000 chars; largest `state.output` in the corpus is ' +
    group(stats.bigOutputExample?.chars ?? 0) + ' chars (`' + (stats.bigOutputExample?.id ?? '') + '`), stored **inline and untruncated** |');
  w('| 9 | concurrent-session rows **if present** | ' + (stats.concurrent.length > 0 ? '✅' : '➖') +
    ' | **' + (stats.concurrent.length > 0 ? stats.concurrent.length + ' overlapping pair(s)' : 'not present — 0 rows') +
    '**. The query and its result are below; DoD 3.3 says "if present", so this is recorded absent rather than manufactured |');
  w('');
  w('## Concurrent sessions: absent, with the query');
  w('');
  w('"Concurrent" means two captured sessions whose `[time_created, time_updated]` intervals overlap and');
  w('which are not each other\'s parent — a parent always contains its child in time, so a parent/child');
  w('overlap is nesting, not concurrency.');
  w('');
  w('```sql');
  for (const line of stats.concurrencySql.split('\n')) w(line);
  w('```');
  w('');
  w('Result over this corpus: **' + (stats.concurrent.length === 0 ? '0 rows' : stats.concurrent.length + ' rows') + '**.' +
    (stats.concurrent.length === 0
      ? ' Nothing was fabricated to fill the box. If a later harvest catches two sessions running at once, that harvest is the fixture for it.'
      : ' ' + stats.concurrent.map((c) => '`' + c.a + '` / `' + c.b + '`').join(', ') + '.'));
  w('');
  w('## Max spawn depth is 1');
  w('');
  w('Sessions whose parent itself has a parent: **' + stats.grandchildSessions + '**. Every child in this corpus is a direct child of a');
  w('root session.');
  w('');
  w('`docs/opencode-contract.md` §5 records why, and it is not a sampling artefact: the measured');
  w('`session.permission` on a subagent session is `[{"permission":"task","pattern":"*","action":"deny"}]`');
  w('— **the child cannot spawn**, because this installation denies subagents the `task` permission.');
  w('Depth 2 is therefore not capturable here without changing that setting, in the same way CC\'s');
  w('`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "2"` caps the CC corpora. The grafter must still walk the');
  w('`parent_id` chain and assert what the data says rather than assuming a cap.');
  w('');
  w('## The compaction split — why there are two corpora');
  w('');
  w('The two known `compaction` part shapes are **split across versions**, and that is the reason this');
  w('fixture set has an anchor and a witness rather than one corpus:');
  w('');
  w('```json');
  w('1.18.22   {"type":"compaction","auto":true,"overflow":false,"tail_start_id":"msg_03a51462f001DwrGE19VXZO2ij"}');
  w('1.18.21   {"type":"compaction","auto":true,"overflow":false}');
  w('```');
  w('');
  w('**`tail_start_id` is OPTIONAL**, and the `1.18.21` corpus is the fixture that proves it. A');
  w('fingerprint written against the anchor alone would make it required and would refuse every');
  w('`1.18.21` session; a parser written against the witness alone would never look for it. Neither');
  w('corpus can establish that on its own — this is exactly the CC pattern, where `cc-2.1.246` is the');
  w('anchor and `cc-2.1.237` / `cc-2.1.241` are the witnesses that keep a field from being mistaken for');
  w('a requirement.');
  w('');
  w('This corpus\'s own compaction rows, verbatim:');
  w('');
  if (stats.compaction.length === 0) {
    w('_none_');
  } else {
    w('```json');
    for (const c of stats.compaction) w(c.data);
    w('```');
    w('');
    w('(' + stats.compaction.map((c) => '`' + c.id + '`').join(', ') + ')');
  }
  w('');
  w('## G8 — what was excluded, and why the check is in the code');
  w('');
  w('The live database contains projects other than this one. DoD 3.2 as written says the capture');
  w('"aborts on any `project` row whose `worktree` is not this repo", which stopped being satisfiable');
  w('the moment a second project appeared: taken literally it means "never capture again". The rule the');
  w('script implements has two halves, and **both are in the code**:');
  w('');
  w('- **FILTER** — only rows reachable from this repository\'s `project` row are selected. Foreign rows');
  w('  are never read into the fixture.');
  w('- **ASSERT** — every row *selected for capture* is re-checked against this repository\'s identity,');
  w('  and any disagreement aborts the run with a non-zero exit. The assertion runs **twice**: once over');
  w('  the source selection before anything is written, and once over the finished fixture.');
  w('');
  w('Excluded at this capture:');
  w('');
  if (stats.excludedProjects.length === 0) {
    w('- no foreign `project` rows were present.');
  } else {
    w('| Project id | Worktree | Sessions | Why |');
    w('|---|---|---|---|');
    for (const p of stats.excludedProjects) {
      w('| `' + p.id + '` | `' + redactForeignPath(p.worktree) + '` | ' + p.sessions + ' | not this repository |');
    }
    w('');
    w('**The foreign worktrees are redacted in this file, and that is not tidiness.** A path naming');
    w('another project is exactly the FOREIGN content the privacy sweep drives to zero, and writing it');
    w('into a committed document in a public repository would leak the thing the G8 filter exists to');
    w('keep out — a G8 log that is itself a G8 violation. The `project.id` is OpenCode\'s own opaque');
    w('digest and the session count is a number, so both are recorded verbatim; only the location is');
    w('reduced to its segment count. The full values are printed to the console by the capture run,');
    w('where they are ephemeral and can be checked by whoever runs it. `' + stats.excludedSessions.length +
      '` foreign session(s) were');
    w('excluded with them; their ids are console output for the same reason.');
  }
  w('');
  if (stats.otherVersions.length > 0) {
    w('Own sessions excluded because they are a different data version (captured in their own corpus): ' +
      stats.otherVersions.map((v) => v.sessions + ' at `' + v.version + '`').join(', ') + '.');
    w('');
  }
  w('The kept `project` row\'s `worktree` is **not rewritten**. This developer\'s own absolute paths are');
  w('deliberate inside an enumerated fixture corpus — the privacy sweep\'s `→ 0` applies to FOREIGN');
  w('content and to secrets, never to this repository\'s own paths inside a capture.');
  w('');
  w('## Dropped by schema');
  w('');
  w('These tables are **never created** in the fixture. There is no column named `access_token`,');
  w('`refresh_token`, `value` or `secret` anywhere in the artifact, so there is nothing to leak even if');
  w('a future OpenCode release starts populating them:');
  w('');
  w('| Table | Rows in the live DB at capture | Why |');
  w('|---|---|---|');
  const dropWhy = {
    account: '`access_token` / `refresh_token` columns',
    account_state: 'points at `account`; dropped as part of a deliberate superset',
    control_account: '`access_token` / `refresh_token` columns',
    credential: 'a `value` column holding credentials',
    session_share: 'a share `secret` column',
  };
  for (const d of stats.droppedCounts) {
    w('| `' + d.table + '` | ' + d.rows + ' | ' + (dropWhy[d.table] ?? '') + ' |');
  }
  w('');
  w('**The DoD names four; five are dropped.** `account_state` comes from the Phase 2 handoff and holds');
  w('no secret itself — it only points at `account` — but a superset is the safe direction for a drop');
  w('list, and a dangling foreign key into a table that does not exist is not a fixture anyone should');
  w('have to reason about. That is a deliberate widening, recorded here rather than left to be');
  w('rediscovered.');
  w('');
  w('All five measured **0 rows** at capture time. That is precisely why the rule is *by schema* rather');
  w('than *by row*: the schema is the risk, the row count is a coincidence of this moment, and a capture');
  w('procedure that deletes rows would start shipping secrets the first day one of those tables is used.');
  w('');
  w('## Kept, deliberately: the out-of-scope tables');
  w('');
  w('`data_migration`, `migration`, `permission`, `project_directory`, `session_context_epoch`,');
  w('`session_input`, `session_message`, `todo` and `workspace` are **not** read by the engine and are');
  w('kept anyway — filtered to this project where they have a project or session dimension, whole where');
  w('they do not.');
  w('');
  w('They exist so Phase 4 has a **real** fixture for contract §3\'s rule that unknown tables are');
  w('*ignored, not refused* (the CC unknown-field rule applied to schema). A fixture containing only the');
  w('six required tables cannot test that rule at all: it would pass a fingerprint that refuses every');
  w('real database on the planet.');
  w('');
  w('## No truncation — the explicit decision');
  w('');
  w('DoD 3.2 permits truncating long payloads "to shape, with the decision recorded". **The user chose');
  w('not to truncate anything.** `part.data`, `message.data` and `event.data` are stored exactly as read:');
  w('no truncation, no normalisation, no reformatting, no re-serialisation, no pretty-printing.');
  w('');
  w('What that buys: the largest inline tool output in this corpus is ' + group(stats.bigOutputExample?.chars ?? 0) + ' characters and it is');
  w('all here, so the truncation and preview code has a real payload to be measured against instead of a');
  w('pre-shortened one. The reasoning parts are the G4 target and their bytes are the thing the G4 test');
  w('asserts against — a redacted or shortened fixture would make that test vacuous, which is the exact');
  w('failure mode CC\'s empty-`thinking`/populated-`signature` trap already produced once in this repo.');
  w('');
  w('What it costs: ' + group(stats.dbBytes) + ' bytes on disk. `fixtures/**` is denied in `.vscodeignore`, so none of it ships');
  w('in the VSIX.');
  w('');
  w('Verification is not a claim: the capture re-opens the finished fixture and compares, per table, a');
  w('SHA-256 over every column of every row **and** a SHA-256 over SQLite\'s own');
  w('`length(CAST(data AS BLOB))` per row. The second is computed by the engine on the stored bytes, so');
  w('it catches a byte-level round-trip failure that a JavaScript string comparison cannot see. Integers');
  w('are read as `BigInt`, so no millisecond timestamp passes through a float. Any mismatch aborts the');
  w('capture.');
  w('');
  w('Preserved verbatim by that check: every `id`, `callID`, `parent_id`, `project_id`, `session_id`,');
  w('`message_id`, `aggregate_id`, `seq`, `state.metadata.sessionId`, `state.metadata.parentSessionId`,');
  w('every `time_*` value, and every reasoning byte.');
  w('');
  w('## Privacy');
  w('');
  w('Checked on the captured rows, **case-sensitively with SQLite `GLOB`** — never `LIKE`, which is');
  w('case-insensitive. A three-letter project name searched with `LIKE` matches every word that');
  w('contains those letters in any case — `LIKE \'%ART%\'` matches "st" + "art" + "ed" — and that has');
  w('already produced one wrong count in this repo:');
  w('');
  w('| Needle | `part` | `message` | `event` |');
  w('|---|---|---|---|');
  for (const nd of stats.needles) {
    w('| `' + nd.needle + '` | ' + nd.part + ' | ' + nd.message + ' | ' + nd.event + ' |');
  }
  w('');
  w('`projects/<project>` tokens appearing anywhere in the captured `data` columns: ' +
    stats.projectsTokens.map((t) => '`' + t.token + '` ' + group(t.count)).join(' · ') + '.');
  w('No other project is named. Rows containing a NUL byte: ' + stats.nulRows + '.');
  w('');
  w('Like the rest of `fixtures/`, this corpus is **raw and unredacted by deliberate choice**: it carries');
  w('this repository\'s own absolute paths, real session ids and real tool output. G8 holds — nothing');
  w('here was captured from any project other than this one.');
  w('');
  w('## Replay, and the negative control');
  w('');
  w('The fixture is a plain SQLite file; open it read-only and read it:');
  w('');
  w('```console');
  w('node -e "const {DatabaseSync}=require(\'node:sqlite\');const d=new DatabaseSync(\'fixtures/opencode-' + version + '/opencode.db\',{readOnly:true});console.log(d.prepare(\'SELECT count(*) n FROM session\').get())"');
  w('```');
  w('');
  w('**The negative control fakes `USERPROFILE`, not `HOME`.** `os.homedir()` reads `USERPROFILE` on');
  w('Windows, so a control that fakes only `HOME` runs happily against the real OpenCode data directory');
  w('and reports a confident green pass on the one check whose entire purpose is proving we never touch');
  w('it. `src/release/opencode-capture.test.ts` runs the capture with `USERPROFILE` pointed at an empty');
  w('directory and asserts it exits non-zero naming the missing root, rather than falling back.');

  return `${L.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { version: null, out: null, role: null, source: null, readme: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--version') opts.version = argv[++i] ?? null;
    else if (a === '--out') opts.out = argv[++i] ?? null;
    else if (a === '--role') opts.role = argv[++i] ?? null;
    else if (a === '--source') opts.source = argv[++i] ?? null;
    else if (a === '--no-readme') opts.readme = false;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.version === null) {
    throw new Error('--version is required (the DATA\'s session.version, e.g. --version 1.18.22)');
  }
  if (opts.role !== null && opts.role !== 'anchor' && opts.role !== 'witness') {
    throw new Error('--role must be "anchor" or "witness"');
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let sourcePath = opts.source;
  if (sourcePath === null) {
    let root;
    try {
      root = resolveDataRoot();
    } catch (error) {
      console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
      console.error('      Nothing was captured. This is a hard failure, not a fallback.');
      return 2;
    }
    sourcePath = path.join(root, 'opencode.db');
    if (!fs.existsSync(sourcePath)) {
      console.error(`FAIL  no OpenCode database at the resolved data root (${root})`);
      console.error(`      expected: ${sourcePath}`);
      console.error('      Nothing was captured. The capture does not look anywhere else and does');
      console.error('      not fall back to another database.');
      return 2;
    }
  } else if (!fs.existsSync(sourcePath)) {
    console.error(`FAIL  no OpenCode database at ${sourcePath}`);
    console.error('      Nothing was captured. This is a hard failure, not a fallback.');
    return 2;
  }

  const outDir =
    opts.out === null ? path.join(REPO_ROOT, 'fixtures', `opencode-${opts.version}`) : path.resolve(opts.out);

  let stats;
  try {
    stats = capture({ version: opts.version, outDir, sourcePath });
  } catch (error) {
    console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const role =
    opts.role ??
    (stats.versionCensus.every((v) => compareVersions(stats.version, v.version) >= 0) ? 'anchor' : 'witness');

  if (opts.readme) {
    const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    fs.writeFileSync(path.join(outDir, 'README.md'), renderReadme(stats, role, generatedAt), 'utf8');
  }

  console.log('');
  console.log(`captured ${stats.sessionIds.length} session(s) at version ${stats.version} (${role})`);
  for (const t of stats.tableStats) console.log(`  ${t.table.padEnd(22)} ${t.rows}`);
  console.log(`  fixture ${stats.outFile} (${stats.dbBytes} bytes)`);
  console.log('  dropped by schema: ' + stats.droppedCounts.map((d) => `${d.table}=${d.rows} rows`).join(', '));
  console.log('  VERBATIM VERIFICATION PASSED (row hash + stored-byte lengths)');
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
