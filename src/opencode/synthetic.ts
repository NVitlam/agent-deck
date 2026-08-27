/**
 * Agent Deck — `synthetic-` corpus primitives for the OpenCode engine's tests.
 *
 * ---------------------------------------------------------------------------
 * TEST-ONLY, AND THE ENGINE MUST NEVER REACH IT
 * ---------------------------------------------------------------------------
 *
 * This is the ONE file under `src/opencode/` that opens a database for WRITE
 * and the ONE that writes to disk at all. It is a test fixture builder, the
 * same role `src/perf/corpus.ts` plays for the Claude Code engine.
 *
 * G1 is not weakened by it, and the reason is worth stating rather than
 * assuming: everything here writes to a fresh `mkdtemp` directory, from a
 * committed fixture, and never to `%USERPROFILE%\.local\share\opencode`, never
 * to `%USERPROFILE%\.config\opencode`, and never to `fixtures/`. The user's
 * real database is never opened by this module at all — it takes a corpus name
 * from `fixtures/` and a destination directory, and it has no code path to
 * anything else.
 *
 * `src/hooks/egress.test.ts` asserts that the import graph rooted at
 * `src/opencode/index.ts` does NOT reach this file, so the write surface
 * cannot arrive in the shipped bundle by an import somebody added without
 * noticing. That assertion is the guard; this comment is only the reason.
 *
 * ---------------------------------------------------------------------------
 * WHY MUTATIONS ARE BUILT PER TEST AND NOT COMMITTED
 * ---------------------------------------------------------------------------
 *
 * `PLAN.md` Phase 4 `Amendment 2026-08-27` A2: liveness is proven with an
 * injected clock and mutated fixtures, "never with a live DB". Tests build
 * `synthetic-` copies "in a temp dir, from the fixture, per test".
 *
 * Committing them instead would add a 5.7 MB binary per branch to a repo whose
 * whole pack is 9.27 MiB, and every one of them would be a second thing that
 * can drift from the corpus it was cut from. A copy made at test time cannot
 * drift: it is the committed bytes plus one named, readable mutation.
 */

import { copyFileSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

/** `fixtures/`, resolved from this file rather than from `process.cwd()`. */
export const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/', import.meta.url));

/**
 * Corpus directory names, DERIVED FROM DISK — never a hard-coded list.
 *
 * The recorded rule is not to assert fixture-set sizes: a count hard-coded
 * against one capture breaks on the next harvest and reads as a regression.
 * A caller that needs a specific corpus names it; a caller that needs "all of
 * them" gets whatever is on disk.
 */
export function listCorpora(fixturesDir: string = FIXTURES_DIR): string[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('opencode-'))
    .map((e) => e.name)
    .filter((name) => {
      try {
        return readdirSync(join(fixturesDir, name)).includes('opencode.db');
      } catch {
        return false;
      }
    })
    .sort();
}

/** The committed `opencode.db` of one corpus. Read-only; never mutate it. */
export function corpusDbPath(corpusName: string, fixturesDir: string = FIXTURES_DIR): string {
  return join(fixturesDir, corpusName, 'opencode.db');
}

/** The committed `golden.json` of one corpus. */
export function corpusGoldenPath(
  corpusName: string,
  fixturesDir: string = FIXTURES_DIR,
): string {
  return join(fixturesDir, corpusName, 'golden.json');
}

/**
 * A scratch directory that is safe to point a filesystem watch at.
 *
 * `realpathSync.native()` is not decoration. libuv **ABORTS the process** when
 * a watched path carries an 8.3 short component —
 * `Assertion failed: !_wcsnicmp(filename, dir, dirlen), src\win\fs-event.c:72`
 * — with no failing assertion to read and no summary line, ~1 s in. GitHub's
 * Windows runners hand back `C:\Users\RUNNER~1\AppData\Local\Temp` from
 * `os.tmpdir()`, which is exactly that shape. Resolving the long form first is
 * the actual fix; it protects any Windows developer whose `TEMP` is
 * short-named, not only the runner.
 */
export function makeTempDir(prefix = 'agent-deck-oc-'): string {
  return mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
}

/**
 * Copy one committed corpus's database into `destDir` and return the copy's
 * path. The copy is writable; the fixture is never touched.
 *
 * The WAL and shared-memory siblings are deliberately NOT copied: a committed
 * corpus has none (`scripts/capture-opencode.mjs` checkpoints), and a caller
 * that wants one writes it with {@link writeSyntheticWal} so the bytes are
 * visible in the test rather than inherited.
 */
export function copyCorpus(
  corpusName: string,
  destDir: string,
  fixturesDir: string = FIXTURES_DIR,
): string {
  const dest = join(destDir, 'opencode.db');
  copyFileSync(corpusDbPath(corpusName, fixturesDir), dest);
  return dest;
}

/**
 * Open a synthetic copy for WRITE, run `mutate`, and always close.
 *
 * Refuses any path inside `fixtures/`. That check is cheap and it closes the
 * one way this helper could damage the corpus it exists to protect — a
 * copy/paste that passed `corpusDbPath(...)` where a copy was meant.
 */
export function withWritableDb<T>(dbPath: string, mutate: (db: DatabaseSync) => T): T {
  if (dbPath.replace(/\\/g, '/').includes('/fixtures/')) {
    throw new Error(`refusing to open a committed fixture for write: ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath);
  try {
    return mutate(db);
  } finally {
    db.close();
  }
}

/**
 * Write a `-wal` sibling beside a synthetic database.
 *
 * Used to build the hot-WAL crash copy DoD 4.1 requires: OpenCode *dying* and
 * leaving an unrecoverable WAL behind was never reproduced (OC9), because
 * reproducing it means killing a live session mid-write, so the degrade path
 * is specified rather than measured and a synthetic stand-in is what pins it.
 *
 * **A `-wal` file is not a write indicator and must never be read as one.**
 * `opencode.db-wal` measured at exactly 4,181,832 bytes across 2 h 30 m and
 * four probes while the main database grew 425 KB and gained 116 event rows,
 * because SQLite reuses WAL frames in place and the file rests at its
 * high-water mark. Nothing in this module or its callers may key a control on
 * its size.
 */
export function writeSyntheticWal(dbPath: string, bytes: Uint8Array): string {
  const walPath = `${dbPath}-wal`;
  writeFileSync(walPath, bytes);
  return walPath;
}

/**
 * Write a file that is present, non-empty, and not a SQLite database.
 *
 * The `databaseUnreadable` case. Deliberately carries a plausible-looking
 * header rather than being empty: SQLite treats a ZERO-length file as a valid
 * empty database and opens it happily, so an empty file proves the opposite of
 * what the test means to prove.
 */
export function writeNonDatabase(destDir: string, name = 'opencode.db'): string {
  const target = join(destDir, name);
  writeFileSync(target, Buffer.from('SQLite format 3\u0000 -- not really\n'.repeat(64), 'utf8'));
  return target;
}
