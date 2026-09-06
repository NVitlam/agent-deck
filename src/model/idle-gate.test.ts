/**
 * Agent Deck — all three engines, idle, over a 2 GiB corpus
 * (HOTFIX-0.6.1, DoD H.9a).
 *
 * ---------------------------------------------------------------------------
 * GATED BEHIND AN ENVIRONMENT VARIABLE, AND THE REASON IS THE COST
 * ---------------------------------------------------------------------------
 * `AGENT_DECK_IDLE_GATE=1`. Run once for the record; the numbers live in
 * `lab/docs/evidence/hotfix-0.6.1/IDLE.md`. It writes about 2 GiB and then
 * measures for a full minute, and the gate takes three consecutive suite runs
 * — six gigabytes of churn and three idle minutes to re-derive a number that
 * does not move. The packaged-artifact audit in `src/release/vsix.test.ts` is
 * gated the same way for the same reason.
 *
 * The skip is therefore EXPECTED, and it is one of this repository's counted
 * environment-conditional gates. `CLAUDE.md` records that the healthy skip
 * count is a census that moves whenever a gate is added, and this adds one.
 *
 * ---------------------------------------------------------------------------
 * WHY A CHILD PROCESS, AGAIN
 * ---------------------------------------------------------------------------
 * `process.cpuUsage()` and `heapUsed` measured inside a vitest worker report
 * vitest's own work as well as the engines'. The child runs nothing but the
 * three engines, so its CPU time IS theirs. `src/codex/memory.test.ts` takes a
 * child process for the neighbouring reason — there, because the assertion is
 * about a crash that leaves no reporter alive.
 *
 * ---------------------------------------------------------------------------
 * WHAT "IDLE" MEANS HERE, AND THE TWO TIMES THIS FILE GOT IT WRONG
 * ---------------------------------------------------------------------------
 * Every engine has already ingested the corpus before the clock starts. The
 * window then drives each engine **the way its own production trigger drives
 * it**, which is not the same thing for all three:
 *
 *   - **Codex** — every 1 000 ms (`DEFAULT_CODEX_ENGINE_POLL_INTERVAL_MS`).
 *   - **OpenCode** — a liveness poll every 1 000 ms
 *     (`DEFAULT_OC_POLL_INTERVAL_MS`), and a content read ONLY when the cursor
 *     stamp moves, which at idle it never does (`src/extension.ts:734-750`).
 *   - **Claude Code** — **not at all.** `SessionTailer.poll` is reached only
 *     from `ProjectWatcher.#runPoll`, which is reached only from a debounced
 *     chokidar event (`src/watch/watcher.ts:451-454`). No timer drives it. A
 *     workspace where nothing is being appended to polls zero times.
 *
 * **Both of the first two drafts of this file measured work the product does
 * not do, and each was found by acting on the number rather than accepting
 * it.** Draft one called `readOpenCodeEngine` every second — a full read and
 * parse of every row — and scored 7.56 % of one core. Draft two fixed that,
 * scored 8.31 %, and per-engine attribution then showed **Claude Code at
 * 7.32 % of the 7.97 % total**: the harness was polling a tailer once a second
 * that production polls only when a file changes.
 *
 * That is this repository's recorded vacuity class pointed the other way —
 * not a check whose subject never happened, but a check whose subject happened
 * far more often than it ever does. A gate that flatters the product is
 * useless; a gate that slanders it is worse, because the fix is then aimed at
 * whatever the harness invented.
 *
 * So the Claude Code cost is reported SEPARATELY and as what it is: the cost
 * of one poll, times nothing, because at idle it is multiplied by zero. The
 * number is still here — finding 2 and finding 6 are real — it is simply not
 * added to an idle total it does not belong in.
 *
 * **THE THREE OVERSIZE FILES ARE CODEX FILES, AND THAT IS NOT A CONVENIENCE.**
 * Codex is the only engine with a size gate — that gate is what this hotfix
 * adds. Claude Code has none (H.11 finding 2) and OpenCode has no per-file
 * unit to gate on (finding 3), so an oversize transcript in either corpus
 * would be read, and this gate would fail for a finding the user has
 * deliberately deferred to 0.7.0 rather than for anything 0.6.1 changed.
 * Putting them in the Codex corpus measures the gate that exists; saying so
 * here is what stops the number being read as a claim about all three.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PINNED_CODEX_VERSION } from '../codex/fingerprint.js';

const ENABLED = process.env['AGENT_DECK_IDLE_GATE'] === '1';

/**
 * ASYNC, not `spawnSync`, and the reason is a real failure this file hit.
 *
 * `spawnSync` blocks the vitest worker's thread for the whole 60-second
 * window, so the worker cannot service its RPC heartbeat to the main process
 * and vitest reports `[vitest-worker]: Timeout calling "onTaskUpdate"` as an
 * unhandled error — **the test PASSES and the run exits 1**, with a warning
 * saying the result might be a false positive. Measured; the passing run
 * before this change exited 1 for exactly that.
 *
 * `src/codex/memory.test.ts` uses `spawnSync` and is fine: its children finish
 * in about four seconds, well inside the heartbeat.
 */
const run = promisify(execFile);

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** The DoD's three numbers. */
const CORPUS_BYTES = 2 * GIB;
const HEAP_CEILING_BYTES = 256 * MIB;
const CPU_CEILING_FRACTION = 0.05;
const WINDOW_MS = 60_000;

/** 500 files and rows, mixed. The split is stated in `IDLE.md`. */
const CC_FILES = 150;
const CODEX_FILES = 150;
const CODEX_OVERSIZE = 3;
const OC_SESSIONS = 197;

const MODEL_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * The child: ingest once, then poll all three for the window.
 *
 * Written here rather than as a file under `src/` because a generated entry
 * point inside the tree is something the privacy sweep, the packager and
 * `tsc` all have to be told about, and it would exist for exactly as long as
 * nobody crashed mid-run.
 */
const CHILD_SOURCE = `
import { readCodexEngine } from '../codex/index.js';
import { CodexTailStore } from '../codex/store.js';
import { readOpenCodeEngine } from '../opencode/index.js';
import { OcLivenessEngine } from '../opencode/liveness.js';
import { SessionTailer } from '../parser/tailer.js';

const [, , codexRoot, ccProjects, ccWorkspace, dbPath, windowMsRaw] = process.argv;
const windowMs = Number(windowMsRaw);

const store = new CodexTailStore();
const tailer = new SessionTailer({ workspacePath: ccWorkspace, projectsRoot: ccProjects });

/*
 * THE OPENCODE HALF MODELS PRODUCTION, AND THE FIRST DRAFT DID NOT.
 *
 * It called readOpenCodeEngine every pass -- a full read and parse of every
 * session, message and part, once a second. \`OpenCodeEnginePath\` does not do
 * that: \`#onPoll\` builds a cursor stamp from the liveness snapshots and calls
 * \`#refreshContent()\` only when it CHANGES (src/extension.ts:734-750). At
 * idle nothing changes, so the content read never happens and what actually
 * runs every interval is the LIVENESS poll.
 *
 * Measured both ways, because the difference is the whole number: driving the
 * content read every second put this gate at 7.56% of one core, over its 5%
 * ceiling, for work production does not do. The engine is not exonerated by
 * that -- the liveness poll below still carries H.11 finding 5, two
 * unindexable full scans of the part table every interval -- but a gate has to
 * measure the product rather than a harness.
 *
 * No poll trigger and no WAL watch are passed, so this drives \`poll()\` by
 * hand at the same cadence the trigger would.
 */
let ocSnapshots = [];
const ocLiveness = new OcLivenessEngine({
  dbPath,
  now: () => Date.now(),
  // The snapshots arrive through the callback, which is also how
  // \`OpenCodeEnginePath\` receives them -- there is no public accessor, and
  // adding one for a test would be the harness changing the product.
  onUpdate: (snapshots) => {
    ocSnapshots = snapshots;
  },
});
let ocStamp = '';
let ocContentReads = 0;
ocLiveness.start();

/*
 * PER-ENGINE ATTRIBUTION, because a total nobody can split is a number
 * nobody can act on. \`process.cpuUsage(previous)\` is a delta against a
 * mark, so bracketing each call gives that call's own user+system time.
 */
const spent = { codex: 0, cc: 0, oc: 0 };
const charge = async (key, work) => {
  const mark = process.cpuUsage();
  await work();
  const used = process.cpuUsage(mark);
  spent[key] += (used.user + used.system) / 1000;
};

/*
 * The idle pass. NO CLAUDE CODE POLL -- see the header: nothing drives one
 * when no transcript is being written. Its cost is measured separately below.
 */
const pass = async () => {
  await charge('codex', () =>
    readCodexEngine({ root: codexRoot, tails: store, workspaceFolders: [ccWorkspace] }),
  );
  await charge('oc', async () => {
    ocLiveness.poll();
    const stamp = ocSnapshots
      .map((s) => s.sessionId + ':' + String(s.seq ?? -1))
      .sort()
      .join('|');
    if (stamp !== ocStamp) {
      ocStamp = stamp;
      ocContentReads += 1;
      readOpenCodeEngine({ dbPath, workspacePaths: [ccWorkspace] });
    }
  });
};

// INGEST FIRST. Everything before the clock starts is setup, not idle: the
// point of the measurement is what a machine costs when nothing is happening.
// Codex takes several passes by design -- one bounded batch per file per pass.
for (let i = 0; i < 8; i += 1) await pass();
// The Claude Code tailer still has to register its files once, or its
// per-poll cost below would be the cost of a FIRST poll, which is a different
// and much larger number.
await tailer.poll();
const ingestContentReads = ocContentReads;
spent.codex = 0;
spent.cc = 0;
spent.oc = 0;

/*
 * WHAT ONE CLAUDE CODE POLL COSTS, measured outside the idle window because
 * production takes none inside one. Ten polls, so a single scheduling artefact
 * does not become the number.
 */
const ccMark = process.cpuUsage();
const ccPolls = 10;
for (let i = 0; i < ccPolls; i += 1) await tailer.poll();
const ccUsed = process.cpuUsage(ccMark);
const ccCpuPerPollMs = (ccUsed.user + ccUsed.system) / 1000 / ccPolls;
spent.cc = 0;

if (typeof global.gc === 'function') global.gc();
const cpuBefore = process.cpuUsage();
const wallBefore = Date.now();
let peakHeap = process.memoryUsage().heapUsed;
let passes = 0;

while (Date.now() - wallBefore < windowMs) {
  const started = Date.now();
  await pass();
  passes += 1;
  const heap = process.memoryUsage().heapUsed;
  if (heap > peakHeap) peakHeap = heap;
  const remaining = 1000 - (Date.now() - started);
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
}

const cpu = process.cpuUsage(cpuBefore);
const wallMs = Date.now() - wallBefore;
process.stdout.write(
  JSON.stringify({
    passes,
    wallMs,
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
    cpuMs: (cpu.user + cpu.system) / 1000,
    peakHeapBytes: peakHeap,
    rssBytes: process.memoryUsage().rss,
    // Zero is the expected answer and the reason the number is reported: an
    // idle OpenCode store takes no content read at all, and a non-zero here
    // would mean this measurement was of something else.
    ocContentReadsInWindow: ocContentReads - ingestContentReads,
    cpuByEngineMs: spent,
    ccCpuPerPollMs,
    ccTrackedFiles: tailer.trackedFiles().length,
  }) + '\\n',
);
`;

interface ChildResult {
  passes: number;
  wallMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuMs: number;
  peakHeapBytes: number;
  rssBytes: number;
  ocContentReadsInWindow: number;
  cpuByEngineMs: { codex: number; cc: number; oc: number };
  ccCpuPerPollMs: number;
  ccTrackedFiles: number;
}

let scratch = '';
let childPath = '';
let codexRoot = '';
let ccProjects = '';
let dbPath = '';
let corpusBytes = 0;
const CC_WORKSPACE = 'C:\\idle-gate\\workspace';

// ---------------------------------------------------------------------------
// Corpora
// ---------------------------------------------------------------------------

function codexMeta(threadId: string): string {
  return `${JSON.stringify({
    timestamp: '2026-09-05T00:00:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: threadId,
      id: threadId,
      timestamp: '2026-09-05T00:00:00.000Z',
      cwd: CC_WORKSPACE,
      originator: 'codex_exec',
      cli_version: PINNED_CODEX_VERSION,
      source: 'exec',
      thread_source: 'user',
      model_provider: 'openai',
    },
  })}\n`;
}

async function buildCodexCorpus(oversizeEach: number): Promise<number> {
  const root = resolve(scratch, 'codex');
  const dayDir = join(root, 'sessions', '2026', '09', '05');
  await mkdir(dayDir, { recursive: true });
  codexRoot = root;

  let bytes = 0;
  const padding = 'x'.repeat(8 * 1024);
  for (let i = 0; i < CODEX_FILES; i += 1) {
    const id = `01a06400-0000-7000-8000-${String(i).padStart(12, '0')}`;
    const parts = [codexMeta(id)];
    for (let line = 1; line <= 8; line += 1) {
      parts.push(
        `${JSON.stringify({
          timestamp: '2026-09-05T00:00:01.000Z',
          ordinal: line,
          type: 'response_item',
          payload: {
            type: 'message',
            id: `msg_${String(line)}`,
            role: 'assistant',
            content: [{ type: 'output_text', text: padding }],
          },
        })}\n`,
      );
    }
    const text = parts.join('');
    await writeFile(join(dayDir, `rollout-2026-09-05T00-00-00-${id}.jsonl`), text, 'utf8');
    bytes += Buffer.byteLength(text, 'utf8');
  }

  // The three oversize ones. `truncate` extends without writing, which is what
  // makes 2 GiB affordable -- and the engine never opens them, which is the
  // property being measured.
  for (let i = 0; i < CODEX_OVERSIZE; i += 1) {
    const id = `01a06400-0000-7000-8000-ffffffff${String(i).padStart(4, '0')}`;
    const path = join(dayDir, `rollout-2026-09-05T00-00-00-${id}.jsonl`);
    const handle = await open(path, 'w');
    try {
      await handle.write(codexMeta(id));
      await handle.truncate(oversizeEach);
    } finally {
      await handle.close();
    }
    bytes += oversizeEach;
  }
  return bytes;
}

async function buildCcCorpus(): Promise<number> {
  const projectsRoot = resolve(scratch, 'cc', 'projects');
  const slugDir = join(projectsRoot, 'c--idle-gate-workspace');
  await mkdir(slugDir, { recursive: true });
  ccProjects = projectsRoot;
  let bytes = 0;
  for (let i = 0; i < CC_FILES; i += 1) {
    const sessionId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const text = `${JSON.stringify({
      type: 'user',
      uuid: `${sessionId}-u`,
      parentUuid: null,
      sessionId,
      timestamp: '2026-09-05T00:00:00.000Z',
      cwd: CC_WORKSPACE,
      version: '2.1.260',
      message: { role: 'user', content: 'hello' },
    })}\n`;
    await writeFile(join(slugDir, `${sessionId}.jsonl`), text, 'utf8');
    bytes += Buffer.byteLength(text, 'utf8');
  }
  return bytes;
}

function buildOcCorpus(): number {
  const dir = resolve(scratch, 'opencode');
  const path = join(dir, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = delete');
  db.exec(
    'CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, vcs TEXT);' +
      'CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT,' +
      ' directory TEXT, title TEXT, version TEXT, agent TEXT, model TEXT, cost REAL,' +
      ' tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER,' +
      ' tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER,' +
      ' time_archived INTEGER);' +
      'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,' +
      ' time_updated INTEGER, data TEXT);' +
      'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,' +
      ' time_created INTEGER, time_updated INTEGER, data TEXT);' +
      'CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT,' +
      ' data TEXT);' +
      'CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER, owner_id TEXT);',
  );
  db.prepare('INSERT INTO project VALUES (?, ?, ?)').run('p1', CC_WORKSPACE, 'git');
  const session = db.prepare(
    'INSERT INTO session VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, NULL)',
  );
  const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  const sequence = db.prepare('INSERT INTO event_sequence VALUES (?, ?, ?)');
  for (let i = 0; i < OC_SESSIONS; i += 1) {
    const id = `ses_${String(i)}`;
    session.run(id, 'p1', `slug-${String(i)}`, CC_WORKSPACE, 'title', '1.18.22', 'build', 'gpt', 1, 1);
    message.run(`msg_${String(i)}`, id, 1, 1, JSON.stringify({ role: 'assistant' }));
    part.run(
      `prt_${String(i)}`,
      `msg_${String(i)}`,
      id,
      1,
      1,
      JSON.stringify({ type: 'tool', callID: `call_${String(i)}`, state: { status: 'completed' } }),
    );
    sequence.run(id, 1, 'owner');
  }
  db.close();
  dbPath = path;
  return 0;
}

// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('H.9a — three engines idle over a 2 GiB corpus', () => {
  beforeAll(async () => {
    await mkdir(resolve('dist'), { recursive: true });
    scratch = await mkdtemp(resolve('dist', 'idle-gate-'));
    await mkdir(resolve(scratch, 'opencode'), { recursive: true });

    const cc = await buildCcCorpus();
    buildOcCorpus();
    // The oversize three carry whatever the ordinary corpora do not, so the
    // TOTAL is the DoD's 2 GiB rather than 2 GiB plus incidentals.
    const smallCodex = await buildCodexCorpus(0);
    await rm(resolve(scratch, 'codex'), { recursive: true, force: true });
    const each = Math.ceil((CORPUS_BYTES - cc - smallCodex) / CODEX_OVERSIZE);
    corpusBytes = cc + (await buildCodexCorpus(each));

    childPath = resolve(scratch, 'idle-child.mjs');
    buildSync({
      stdin: {
        contents: CHILD_SOURCE,
        resolveDir: MODEL_DIR,
        loader: 'ts',
        sourcefile: 'idle.ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: childPath,
      logLevel: 'silent',
    });
    execFileSync(process.execPath, ['--check', childPath], { stdio: 'pipe' });
  }, 900_000);

  afterAll(async () => {
    if (scratch !== '') await rm(scratch, { recursive: true, force: true });
  });

  it('holds heap under 256 MB and CPU under 5% of one core over 60 s', async () => {
    expect(corpusBytes).toBeGreaterThanOrEqual(CORPUS_BYTES);

    const child = await run(
      process.execPath,
      [childPath, codexRoot, ccProjects, CC_WORKSPACE, dbPath, String(WINDOW_MS)],
      { encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * MIB },
    );

    const result = JSON.parse(child.stdout.trim()) as ChildResult;
    const cpuFraction = result.cpuMs / result.wallMs;
    const share = (key: keyof ChildResult['cpuByEngineMs']): string =>
      `${((result.cpuByEngineMs[key] / result.wallMs) * 100).toFixed(2)}%`;

    console.info(
      `\nH.9a — 2 GiB corpus, ${String(CC_FILES + CODEX_FILES + CODEX_OVERSIZE + OC_SESSIONS)} ` +
        `files/rows, 3 oversize\n` +
        `  corpus        ${String(corpusBytes)} bytes\n` +
        `  passes        ${String(result.passes)} over ${String(result.wallMs)} ms\n` +
        `  cpu           ${result.cpuMs.toFixed(1)} ms ` +
        `(user ${result.cpuUserMs.toFixed(1)}, system ${result.cpuSystemMs.toFixed(1)}) ` +
        `= ${(cpuFraction * 100).toFixed(2)}% of one core\n` +
        `  peak heap     ${String(result.peakHeapBytes)} bytes ` +
        `(${(result.peakHeapBytes / MIB).toFixed(1)} MiB)\n` +
        `  rss at end    ${(result.rssBytes / MIB).toFixed(1)} MiB\n` +
        `  oc content reads in window  ${String(result.ocContentReadsInWindow)}\n` +
        `  cpu by engine codex=${result.cpuByEngineMs.codex.toFixed(1)} ms ` +
        `oc=${result.cpuByEngineMs.oc.toFixed(1)} ms ` +
        `(${share('codex')} / ${share('oc')} of one core)\n` +
        `  cc, OUTSIDE the window: ${result.ccCpuPerPollMs.toFixed(1)} ms per poll ` +
        `over ${String(result.ccTrackedFiles)} tracked files ` +
        `(zero polls at idle -- see the header)`,
    );

    // The window really ran: a child that exited early would otherwise report
    // a flattering fraction of a window that never happened.
    expect(result.wallMs).toBeGreaterThanOrEqual(WINDOW_MS);
    expect(result.passes).toBeGreaterThan(30);

    // The cursor gate held: an idle store took no content read. If this ever
    // moves, the CPU number below is measuring a different thing and the gate
    // should be read as void rather than as a regression.
    expect(result.ocContentReadsInWindow).toBe(0);

    expect(result.peakHeapBytes).toBeLessThan(HEAP_CEILING_BYTES);
    expect(cpuFraction).toBeLessThan(CPU_CEILING_FRACTION);
  }, 900_000);
});
