/**
 * PHASE 2 / DoD 2.1 — the OpenCode kill-gate host probe. THROWAWAY.
 *
 * This file and its registration in `src/extension.ts` are added and then
 * REMOVED in a separate commit before `phase-2-oc-killgate` merges, so
 * `git log --oneline` shows both halves. It is not product code and nothing
 * else in `src/` may import it.
 *
 * WHY IT EXISTS
 * -------------
 * The whole OpenCode engine design (PLAN Phases 3–5) rests on one assumption
 * that has never been run where it has to work: that `node:sqlite` can open the
 * live OpenCode database READ-ONLY **from inside the VS Code extension host**.
 * RECON A4 row 30 records the assumption as UNBACKED against a VS Code host —
 * it was measured only in a Node 24.15.0 terminal, where `node:sqlite` is
 * unflagged. The extension host is Electron's Node, which is a different build
 * at a different version, and `engines.vscode` is currently `^1.75.0`, a floor
 * whose host Node predates `node:sqlite` entirely.
 *
 * So this probe answers three questions and nothing else:
 *
 *   1. does `import('node:sqlite')` resolve in this host?
 *   2. does `new DatabaseSync(db, { readOnly: true })` OPEN and can it SELECT,
 *      while OpenCode is writing?
 *   3. does a WRITE through that same handle THROW?
 *
 * GO requires all three. (3) is the G1 proof: the read-only posture is a claim
 * until the database itself refuses us.
 *
 * SAFETY
 * ------
 * Every statement here is a read except the deliberate `CREATE TABLE`, which
 * MUST be refused. If it is not refused we have written to the user's live
 * OpenCode database — so that branch immediately tries to drop the table again
 * and records the whole thing as a loud NO-GO. Nothing under the OpenCode data
 * directory is otherwise opened, created or deleted; the only file written is
 * the evidence JSON inside this repository (G1 permits repo/extension storage).
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** The dev-only command id. Palette-visible so the user can run it by hand. */
export const PROBE_COMMAND = 'agentDeck.__probeSqlite';

/** Relative location of the evidence file, from the workspace root. */
const EVIDENCE_RELATIVE = path.join('docs', 'evidence', 'phase-2', 'probe-host.json');

/**
 * The OpenCode data root. `opencode-contract.md` §2 measured it at
 * `%USERPROFILE%\.local\share\opencode` on this machine, and §2 also records
 * the trap this reproduces deliberately: `os.homedir()` reads `USERPROFILE` on
 * Windows, so a probe that consults `HOME` on win32 can silently read a
 * different (or absent) directory. Resolve per-platform, explicitly.
 */
function openCodeDataRoot(): { root: string | null; source: string } {
  if (process.platform === 'win32') {
    const userProfile = process.env['USERPROFILE'];
    if (userProfile === undefined || userProfile.length === 0) {
      return { root: null, source: 'USERPROFILE (unset)' };
    }
    return { root: path.join(userProfile, '.local', 'share', 'opencode'), source: 'USERPROFILE' };
  }
  const home = process.env['HOME'];
  if (home === undefined || home.length === 0) {
    return { root: null, source: 'HOME (unset)' };
  }
  return { root: path.join(home, '.local', 'share', 'opencode'), source: 'HOME' };
}

interface ErrorShape {
  name: string;
  message: string;
  code: string | null;
  errcode: number | null;
}

/** `useUnknownInCatchVariables` is on, so every catch goes through this. */
function describeError(error: unknown): ErrorShape {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown; errcode?: unknown };
    return {
      name: error.name,
      message: error.message,
      code: typeof withCode.code === 'string' ? withCode.code : null,
      errcode: typeof withCode.errcode === 'number' ? withCode.errcode : null,
    };
  }
  return { name: 'non-Error', message: String(error), code: null, errcode: null };
}

interface FileFact {
  name: string;
  exists: boolean;
  bytes: number | null;
}

async function statFile(file: string): Promise<FileFact> {
  const name = path.basename(file);
  try {
    const st = await fs.stat(file);
    return { name, exists: true, bytes: st.size };
  } catch {
    return { name, exists: false, bytes: null };
  }
}

/**
 * The probe result. Serialised verbatim to `probe-host.json`; the user pastes
 * that file back, so every field here is evidence someone will read cold.
 */
export interface ProbeResult {
  probe: string;
  generatedAt: string;
  host: {
    nodeVersion: string;
    electronVersion: string | null;
    v8Version: string | null;
    modulesAbi: string | null;
    vscodeVersion: string;
    vscodeAppHost: string;
    remoteName: string | null;
    uiKind: string;
    platform: string;
    arch: string;
  };
  dbPath: string | null;
  dbPathSource: string;
  files: FileFact[];
  steps: {
    import: { ok: boolean; exportNames: string[]; error: ErrorShape | null };
    open: { ok: boolean; error: ErrorShape | null };
    select: { ok: boolean; sessionCount: number | null; error: ErrorShape | null };
    write: {
      attempted: boolean;
      threw: boolean;
      error: ErrorShape | null;
      /** True only in the alarming case: the write SUCCEEDED. */
      wroteToLiveDatabase: boolean;
      cleanupAttempted: boolean;
      cleanupOk: boolean | null;
    };
    close: { ok: boolean; error: ErrorShape | null };
  };
  /** Read-only extras. Each is independently guarded so it cannot move the gate. */
  extra: {
    journalMode: string | null;
    eventCount: number | null;
    eventMaxSeq: number | null;
    sessionVersions: Array<{ version: string; sessions: number }> | null;
    notes: string[];
  };
  verdict: {
    go: boolean;
    reasons: string[];
  };
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Run the probe. Pure with respect to the extension: it constructs no watcher,
 * binds no socket and starts no timer, and it touches no Agent Deck state.
 */
export async function runSqliteProbe(): Promise<ProbeResult> {
  const { root, source } = openCodeDataRoot();
  const dbPath = root === null ? null : path.join(root, 'opencode.db');

  const result: ProbeResult = {
    probe: 'PLAN v0.5.0 Phase 2 / DoD 2.1 — node:sqlite read-only from the VS Code extension host',
    generatedAt: new Date().toISOString(),
    host: {
      nodeVersion: process.versions.node,
      electronVersion: process.versions['electron'] ?? null,
      v8Version: process.versions.v8 ?? null,
      modulesAbi: process.versions.modules ?? null,
      vscodeVersion: vscode.version,
      vscodeAppHost: vscode.env.appHost,
      remoteName: vscode.env.remoteName ?? null,
      uiKind: vscode.UIKind[vscode.env.uiKind] ?? String(vscode.env.uiKind),
      platform: process.platform,
      arch: process.arch,
    },
    dbPath,
    dbPathSource: source,
    files: [],
    steps: {
      import: { ok: false, exportNames: [], error: null },
      open: { ok: false, error: null },
      select: { ok: false, sessionCount: null, error: null },
      write: {
        attempted: false,
        threw: false,
        error: null,
        wroteToLiveDatabase: false,
        cleanupAttempted: false,
        cleanupOk: null,
      },
      close: { ok: false, error: null },
    },
    extra: {
      journalMode: null,
      eventCount: null,
      eventMaxSeq: null,
      sessionVersions: null,
      notes: [],
    },
    verdict: { go: false, reasons: [] },
  };

  if (root !== null) {
    result.files = await Promise.all(
      ['opencode.db', 'opencode.db-wal', 'opencode.db-shm'].map((f) => statFile(path.join(root, f))),
    );
  }

  // ---- 1. does node:sqlite resolve in THIS host? -------------------------
  //
  // The whole gate starts here. `node:sqlite` landed in Node 22.5 behind a
  // flag and became unflagged later; an older Electron has no such builtin at
  // all and throws ERR_UNKNOWN_BUILTIN_MODULE.
  let sqlite: typeof import('node:sqlite') | null = null;
  try {
    sqlite = await import('node:sqlite');
    result.steps.import.ok = true;
    result.steps.import.exportNames = Object.keys(sqlite).sort();
  } catch (error) {
    result.steps.import.error = describeError(error);
  }

  // ---- 2. open read-only, and SELECT, against the LIVE database ----------
  let db: InstanceType<typeof import('node:sqlite').DatabaseSync> | null = null;
  if (sqlite !== null && dbPath !== null) {
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      result.steps.open.ok = true;
    } catch (error) {
      result.steps.open.error = describeError(error);
    }
  } else if (dbPath === null) {
    result.steps.open.error = {
      name: 'ProbeSetup',
      message: `OpenCode data root could not be resolved from ${source}`,
      code: null,
      errcode: null,
    };
  }

  if (db !== null) {
    try {
      const row = db.prepare('SELECT count(*) AS n FROM session').get() as
        | Record<string, unknown>
        | undefined;
      const n = asNumber(row?.['n']);
      result.steps.select.ok = n !== null;
      result.steps.select.sessionCount = n;
      if (n === null) {
        result.steps.select.error = {
          name: 'ProbeShape',
          message: `SELECT returned an unreadable row: ${JSON.stringify(row ?? null)}`,
          code: null,
          errcode: null,
        };
      }
    } catch (error) {
      result.steps.select.error = describeError(error);
    }

    // ---- 3. the write MUST be refused -----------------------------------
    //
    // This is the G1 proof, and it is the one statement here that is not a
    // read. If SQLite refuses it, the read-only posture is measured rather
    // than asserted. If SQLite does NOT refuse it we have just written to the
    // user's live OpenCode database: undo it, and fail the gate loudly.
    result.steps.write.attempted = true;
    try {
      db.exec('CREATE TABLE __probe(x)');
      result.steps.write.threw = false;
      result.steps.write.wroteToLiveDatabase = true;
      result.steps.write.cleanupAttempted = true;
      try {
        db.exec('DROP TABLE __probe');
        result.steps.write.cleanupOk = true;
      } catch (cleanupError) {
        result.steps.write.cleanupOk = false;
        result.extra.notes.push(
          `CLEANUP FAILED — a table named __probe may remain in the live OpenCode database: ${
            describeError(cleanupError).message
          }`,
        );
      }
    } catch (error) {
      result.steps.write.threw = true;
      result.steps.write.error = describeError(error);
    }

    // ---- read-only extras. Guarded individually; cannot move the gate. ----
    try {
      const row = db.prepare('PRAGMA journal_mode').get() as Record<string, unknown> | undefined;
      result.extra.journalMode = asString(row?.['journal_mode']);
    } catch (error) {
      result.extra.notes.push(`journal_mode unavailable: ${describeError(error).message}`);
    }
    try {
      const row = db.prepare('SELECT count(*) AS n, max(seq) AS m FROM event').get() as
        | Record<string, unknown>
        | undefined;
      result.extra.eventCount = asNumber(row?.['n']);
      result.extra.eventMaxSeq = asNumber(row?.['m']);
    } catch (error) {
      result.extra.notes.push(`event counts unavailable: ${describeError(error).message}`);
    }
    try {
      const rows = db
        .prepare('SELECT version AS v, count(*) AS n FROM session GROUP BY version ORDER BY v')
        .all() as Array<Record<string, unknown>>;
      result.extra.sessionVersions = rows.map((r) => ({
        version: asString(r['v']) ?? '(null)',
        sessions: asNumber(r['n']) ?? -1,
      }));
    } catch (error) {
      result.extra.notes.push(`session versions unavailable: ${describeError(error).message}`);
    }

    try {
      db.close();
      result.steps.close.ok = true;
    } catch (error) {
      result.steps.close.error = describeError(error);
    }
  }

  // ---- the gate ---------------------------------------------------------
  const reasons: string[] = [];
  if (!result.steps.import.ok) reasons.push("import('node:sqlite') did not resolve in this host");
  if (!result.steps.open.ok) reasons.push('read-only open of the live database failed');
  if (!result.steps.select.ok) reasons.push('SELECT count(*) FROM session failed');
  if (!result.steps.write.threw) {
    reasons.push(
      result.steps.write.wroteToLiveDatabase
        ? 'CREATE TABLE SUCCEEDED through a readOnly handle — the read-only posture is not enforced'
        : 'CREATE TABLE was not attempted (an earlier step failed)',
    );
  }
  result.verdict.go = reasons.length === 0;
  result.verdict.reasons = reasons.length === 0 ? ['import, read-only open + SELECT, write refused'] : reasons;

  return result;
}

/**
 * Command handler: run the probe, write the evidence file, tell the user.
 * Returns the path written so the caller can surface it.
 */
export async function probeSqliteCommand(): Promise<void> {
  let result: ProbeResult;
  try {
    result = await runSqliteProbe();
  } catch (error) {
    // A probe that crashes tells us nothing; make the crash itself the report.
    void vscode.window.showErrorMessage(
      `Agent Deck probe crashed before it could report: ${describeError(error).message}`,
    );
    return;
  }

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const target =
    workspace === undefined
      ? path.join(os.tmpdir(), 'agent-deck-probe-host.json')
      : path.join(workspace, EVIDENCE_RELATIVE);

  let written: string | null = null;
  let writeError: string | null = null;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    written = target;
  } catch (error) {
    writeError = describeError(error).message;
  }

  const verdict = result.verdict.go ? 'GO' : 'NO-GO';
  const summary =
    `Agent Deck Phase 2 probe: ${verdict} — ` +
    `node ${result.host.nodeVersion}, electron ${result.host.electronVersion ?? 'n/a'}, ` +
    `VS Code ${result.host.vscodeVersion}; ` +
    `import ${result.steps.import.ok ? 'ok' : 'FAILED'}, ` +
    `open ${result.steps.open.ok ? 'ok' : 'FAILED'}, ` +
    `sessions ${result.steps.select.sessionCount ?? 'n/a'}, ` +
    `write ${result.steps.write.threw ? 'refused (correct)' : 'NOT REFUSED'}. ` +
    (written !== null ? `Written to ${written}` : `NOT WRITTEN: ${writeError ?? 'unknown error'}`);

  if (result.verdict.go && written !== null) {
    void vscode.window.showInformationMessage(summary);
  } else {
    void vscode.window.showErrorMessage(summary);
  }

  // The information message truncates; the full JSON goes to the Debug Console
  // of the launching window, which is where the user can copy it from if the
  // file write failed.
  console.log('[agent-deck][phase-2 probe]', JSON.stringify(result, null, 2));
}
