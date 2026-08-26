// NO SHEBANG HERE, and it must not come back — same rule as
// `scripts/privacy-sweep.mjs`, for the same measured reason. Vite strips a
// shebang with /^#!.*\n/, JavaScript's `.` does not match \r, and this repo
// checks out CRLF. A shebang here survives into a function-wrapped module and
// dies at import. Nothing in this directory is exec'd directly.
//
/**
 * PLAN v0.5.0 Phase 2 / DoD 2.3 — the hot-WAL probe.
 *
 * WHAT IT SETTLES
 * ---------------
 * `docs/opencode-contract.md` §7 records an UNBACKED claim, and records it
 * honestly as one: "if OpenCode dies with a hot (uncheckpointed) WAL, a
 * read-only connection **may** not be able to open at all". RECON A4 row 29
 * carries it forward as UNBACKED / not probed. "May" is not a measurement, and
 * the engine's whole degrade path (G3: refuse, don't guess) is designed around
 * a failure mode nobody has seen.
 *
 * So this opens the LIVE database read-only, 20 times over 60 seconds, while
 * the user keeps an OpenCode session mid-tool-call, and counts what happens.
 * Either way the result closes §7: a clean 20/20 means the "may block" line
 * becomes "did not block under a hot WAL, measured"; any failure gives the
 * degrade path a real error code to key on instead of a guess.
 *
 * READ-ONLY. Every statement is a SELECT or a PRAGMA read; the connection is
 * opened `{ readOnly: true }`. Nothing under the OpenCode data directory is
 * written, created or deleted. The only file written is the evidence JSON
 * inside this repository.
 *
 * USAGE
 *   node scripts/probe-wal.mjs [--json <path>] [--samples N] [--interval-ms N]
 *
 * Defaults: 20 samples, 3000 ms apart (= 60 s), JSON to
 * docs/evidence/phase-2/probe-wal.json.
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * The OpenCode data root. `USERPROFILE` on win32, `HOME` elsewhere — the
 * recorded trap (`os.homedir()` reads USERPROFILE on Windows, so the negative
 * control fakes USERPROFILE, not HOME). Resolved explicitly, never hard-coded:
 * a literal absolute path here would be a privacy-sweep hit as well as a lie on
 * any other machine.
 */
function dataRoot() {
  if (process.platform === 'win32') {
    const p = process.env.USERPROFILE;
    if (!p) throw new Error('USERPROFILE is unset; cannot resolve the OpenCode data root');
    return path.join(p, '.local', 'share', 'opencode');
  }
  const h = process.env.HOME;
  if (!h) throw new Error('HOME is unset; cannot resolve the OpenCode data root');
  return path.join(h, '.local', 'share', 'opencode');
}

function describeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: typeof error.code === 'string' ? error.code : null,
      errcode: typeof error.errcode === 'number' ? error.errcode : null,
    };
  }
  return { name: 'non-Error', message: String(error), code: null, errcode: null };
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const opts = { json: null, samples: 20, intervalMs: 1500 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = argv[++i] ?? null;
    else if (a === '--samples') opts.samples = Number(argv[++i]);
    else if (a === '--interval-ms') opts.intervalMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(opts.samples) || opts.samples < 1) {
    throw new Error('--samples must be a positive integer');
  }
  if (!Number.isInteger(opts.intervalMs) || opts.intervalMs < 0) {
    throw new Error('--interval-ms must be a non-negative integer');
  }
  return opts;
}

/** One open → read → close cycle. Never throws; the failure IS the datum. */
function sample(dbPath, walPath, shmPath, index) {
  const started = Date.now();
  const record = {
    i: index,
    at: new Date(started).toISOString(),
    dbBytes: sizeOf(dbPath),
    walBytes: sizeOf(walPath),
    shmBytes: sizeOf(shmPath),
    ok: false,
    openMs: null,
    totalMs: null,
    sessionCount: null,
    eventCount: null,
    eventMaxSeq: null,
    journalMode: null,
    error: null,
    busy: false,
  };

  let db = null;
  try {
    const t0 = Date.now();
    db = new DatabaseSync(dbPath, { readOnly: true });
    record.openMs = Date.now() - t0;

    const s = db.prepare('SELECT count(*) AS n FROM session').get();
    record.sessionCount = Number(s?.n ?? -1);

    const e = db.prepare('SELECT count(*) AS n, max(seq) AS m FROM event').get();
    record.eventCount = Number(e?.n ?? -1);
    record.eventMaxSeq = e?.m === null || e?.m === undefined ? null : Number(e.m);

    const j = db.prepare('PRAGMA journal_mode').get();
    record.journalMode = typeof j?.journal_mode === 'string' ? j.journal_mode : null;

    record.ok = true;
  } catch (error) {
    const d = describeError(error);
    record.error = d;
    // SQLITE_BUSY is the specific outcome §7 predicts. Match on both the
    // string code and the primary result code (5), because node:sqlite's
    // surface for these is not something to assume from memory.
    record.busy =
      d.errcode === 5 || /SQLITE_BUSY|database is locked/i.test(`${d.code ?? ''} ${d.message}`);
  } finally {
    if (db !== null) {
      try {
        db.close();
      } catch (error) {
        if (record.error === null) record.error = describeError(error);
      }
    }
  }

  record.totalMs = Date.now() - started;
  return record;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = dataRoot();
  const dbPath = path.join(root, 'opencode.db');
  const walPath = path.join(root, 'opencode.db-wal');
  const shmPath = path.join(root, 'opencode.db-shm');

  if (!fs.existsSync(dbPath)) {
    console.error(`FAIL  no database at the resolved data root (${root})`);
    console.error('      This is a negative control, not a pass: nothing was measured.');
    process.exitCode = 2;
    return;
  }

  const outPath =
    opts.json ??
    path.join(process.cwd(), 'docs', 'evidence', 'phase-2', 'probe-wal.json');

  console.log(
    `probe-wal: ${opts.samples} read-only opens, ${opts.intervalMs} ms apart ` +
      `(~${Math.round((opts.samples - 1) * opts.intervalMs) / 1000}s). ` +
      'Keep an OpenCode session mid-tool-call for the whole window.',
  );
  console.log(`  db      ${sizeOf(dbPath)} bytes`);
  console.log(`  wal     ${sizeOf(walPath)} bytes at start`);
  console.log('');

  const samples = [];
  for (let i = 0; i < opts.samples; i += 1) {
    if (i > 0) await sleep(opts.intervalMs);
    const r = sample(dbPath, walPath, shmPath, i);
    samples.push(r);
    console.log(
      `  [${String(i).padStart(2, '0')}] ${r.ok ? 'ok  ' : 'FAIL'} ` +
        `open ${String(r.openMs ?? '-').padStart(4)}ms  total ${String(r.totalMs).padStart(4)}ms  ` +
        `db ${String(r.dbBytes ?? '-').padStart(9)}  ` +
        `sessions ${String(r.sessionCount ?? '-').padStart(3)}  ` +
        `events ${String(r.eventCount ?? '-').padStart(6)}/max ${r.eventMaxSeq ?? '-'}` +
        (r.ok ? '' : `  ${r.busy ? 'SQLITE_BUSY' : (r.error?.code ?? r.error?.name)}: ${r.error?.message}`),
    );
  }

  const failures = samples.filter((s) => !s.ok);
  const busy = samples.filter((s) => s.busy);
  const walSizes = samples.map((s) => s.walBytes).filter((n) => typeof n === 'number');
  const walMoved = walSizes.length > 1 && new Set(walSizes).size > 1;

  /**
   * THE VACUITY CONTROL, and the first version of it was WRONG in the direction
   * that matters: it keyed on the WAL file's SIZE changing.
   *
   * Measured on this machine across 2h08m and three separate probes:
   * `opencode.db` grew 24,289,280 -> 24,338,432 bytes and the event table gained
   * 73 rows, while `opencode.db-wal` sat at EXACTLY 4,181,832 bytes throughout.
   * SQLite reuses WAL frames in place and the file stays at its high-water mark,
   * so WAL size is not a write indicator at all. A control built on it does not
   * merely fail to detect writes -- it REJECTS RUNS THAT DID CAPTURE THEM, which
   * is the expensive direction: the user re-runs a good measurement forever
   * while being told it proved nothing.
   *
   * Writes are detected by what a write actually moves: the event counter, the
   * per-aggregate max seq, or the main database file's size.
   */
  const distinct = (key) => new Set(samples.map((s) => s[key]).filter((n) => typeof n === 'number')).size;
  const writesObserved = distinct('eventCount') > 1 || distinct('eventMaxSeq') > 1 || distinct('dbBytes') > 1;

  const report = {
    probe: 'PLAN v0.5.0 Phase 2 / DoD 2.3 — hot-WAL read-only open, repeated',
    generatedAt: new Date().toISOString(),
    node: process.versions.node,
    platform: process.platform,
    dataRootSource: process.platform === 'win32' ? 'USERPROFILE' : 'HOME',
    config: { samples: opts.samples, intervalMs: opts.intervalMs },
    dbBytesAtStart: sizeOf(dbPath),
    samples,
    summary: {
      attempts: samples.length,
      succeeded: samples.length - failures.length,
      failed: failures.length,
      sqliteBusy: busy.length,
      walBytesMin: walSizes.length > 0 ? Math.min(...walSizes) : null,
      walBytesMax: walSizes.length > 0 ? Math.max(...walSizes) : null,
      /**
       * The vacuity control. A 20/20 pass against a WAL that never changed
       * size proves the open works when nothing is writing — which is NOT what
       * §7 is about. If this is false, the run does not close §7.
       */
      walObservedChanging: walMoved,
      /**
       * The real control. True only if the database changed under us during the
       * window, which is the condition contract §7 is actually about.
       */
      writesObserved,
      eventCountFirst: samples[0]?.eventCount ?? null,
      eventCountLast: samples[samples.length - 1]?.eventCount ?? null,
      dbBytesFirst: samples[0]?.dbBytes ?? null,
      dbBytesLast: samples[samples.length - 1]?.dbBytes ?? null,
      openMsMax: Math.max(...samples.map((s) => s.openMs ?? 0)),
    },
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(
    `VERDICT  ${report.summary.succeeded}/${report.summary.attempts} opens succeeded, ` +
      `${report.summary.failed} failed, ${report.summary.sqliteBusy} SQLITE_BUSY`,
  );
  console.log(
    `         writes landed during the window: ${writesObserved ? 'YES' : 'NO — this run does not close §7'}` +
      `  (events ${report.summary.eventCountFirst} -> ${report.summary.eventCountLast}, ` +
      `db ${report.summary.dbBytesFirst} -> ${report.summary.dbBytesLast} bytes)`,
  );
  console.log(`report written to ${outPath}`);

  // A failed open is a legitimate measurement, not a script error, so the exit
  // code reports the vacuity control instead: a run in which nothing was written
  // did not test what it claims to test.
  process.exitCode = writesObserved ? 0 : 3;
}

await main();
