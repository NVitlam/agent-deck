/**
 * Agent Deck — what one idle pass of each engine actually costs
 * (HOTFIX-0.6.1, DoD H.11 item 4).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHY IT MEASURES RATHER THAN REASONS
 * ---------------------------------------------------------------------------
 * The Codex OOM was found by a user, not by this repository, and the audit it
 * triggered asks the same five questions of all three engines. Four of those
 * questions can be answered by reading source. The fourth — what a pass costs
 * at idle with 500 historical sessions — cannot: it is a claim about syscalls
 * and rows, and a claim about syscalls that nobody counted is a guess with a
 * `file:line` next to it.
 *
 * So `node:fs` and `node:fs/promises` are wrapped and every `open`, `stat`,
 * `statSync`, `readdir` and `readdirSync` is counted by path, and the SQLite
 * tables OpenCode's per-pass SQL scans are counted directly. The numbers this
 * file prints are the numbers in `lab/docs/evidence/hotfix-0.6.1/AUDIT.md`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not assert a budget. `src/perf/perf.test.ts` is where budgets live,
 * it runs in its own process for reasons this repository has measured at
 * length, and adding a timing limit here would put a wall-clock assertion in
 * the shared pool where the same repository has already recorded that they
 * fail by CPU load rather than by regression.
 *
 * What it DOES assert is the SHAPE — zero bytes on an idle Codex pass, one
 * directory entry per file for Claude Code, a full scan for OpenCode — because
 * a shape is what the audit is about and a shape does not move with load.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { readCodexEngine } from '../codex/index.js';
import { CodexTailStore } from '../codex/store.js';
import { PINNED_CODEX_VERSION } from '../codex/fingerprint.js';
import { SessionTailer } from '../parser/tailer.js';

// ---------------------------------------------------------------------------
// The syscall tally, across BOTH fs modules
// ---------------------------------------------------------------------------

interface Counts {
  open: number;
  stat: number;
  readdir: number;
  bytesRead: number;
}

const counts: Counts = { open: 0, stat: 0, readdir: 0, bytesRead: 0 };
/** Only paths under this prefix are counted, so vitest's own IO is excluded. */
let countUnder = '\u0000never';

function inScope(path: unknown): boolean {
  return typeof path === 'string' && path.startsWith(countUnder);
}

function reset(): void {
  counts.open = 0;
  counts.stat = 0;
  counts.readdir = 0;
  counts.bytesRead = 0;
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const call = (name: keyof Counts) => (path: unknown) => {
    if (inScope(path)) counts[name] += 1;
  };
  const onOpen = call('open');
  const onStat = call('stat');
  const onReaddir = call('readdir');
  return {
    ...actual,
    open: async (path: unknown, ...rest: unknown[]) => {
      onOpen(path);
      const handle = await (actual.open as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
      const target = handle as { read: (...a: unknown[]) => Promise<{ bytesRead: number }> };
      const original = target.read.bind(target);
      target.read = async (...a: unknown[]) => {
        const outcome = await original(...a);
        if (inScope(path)) counts.bytesRead += outcome.bytesRead;
        return outcome;
      };
      return handle;
    },
    stat: async (path: unknown, ...rest: unknown[]) => {
      onStat(path);
      return (actual.stat as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    },
    readdir: async (path: unknown, ...rest: unknown[]) => {
      onReaddir(path);
      return (actual.readdir as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: (path: unknown, ...rest: unknown[]) => {
      if (inScope(path)) counts.stat += 1;
      return (actual.statSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
    readdirSync: (path: unknown, ...rest: unknown[]) => {
      if (inScope(path)) counts.readdir += 1;
      return (actual.readdirSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

// ---------------------------------------------------------------------------
// Corpora — 500 historical sessions per engine
// ---------------------------------------------------------------------------

/**
 * The audit's N. Large enough that a per-file cost is visible against the
 * fixed cost of a pass, small enough that three corpora build in seconds.
 */
const N = 500;

let scratch = '';
const table: string[] = [];

function record(line: string): void {
  table.push(line);
}

// ---- Claude Code ----------------------------------------------------------

const CC_SLUG = 'c--audit-workspace';

async function buildClaudeCode(): Promise<{ projectsRoot: string; workspacePath: string }> {
  const projectsRoot = resolve(scratch, 'cc', 'projects');
  const slugDir = join(projectsRoot, CC_SLUG);
  await mkdir(slugDir, { recursive: true });
  for (let i = 0; i < N; i += 1) {
    const sessionId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    await writeFile(join(slugDir, `${sessionId}.jsonl`), ccTranscript(sessionId), 'utf8');
  }
  return { projectsRoot, workspacePath: 'C:\\audit\\workspace' };
}

function ccTranscript(sessionId: string): string {
  const line = {
    type: 'user',
    uuid: `${sessionId}-u`,
    parentUuid: null,
    sessionId,
    timestamp: '2026-09-05T00:00:00.000Z',
    cwd: 'C:\\audit\\workspace',
    version: '2.1.260',
    message: { role: 'user', content: 'hello' },
  };
  return `${JSON.stringify(line)}\n`;
}

// ---- Codex ----------------------------------------------------------------

async function buildCodex(): Promise<string> {
  const root = resolve(scratch, 'codex');
  const dayDir = join(root, 'sessions', '2026', '09', '05');
  await mkdir(dayDir, { recursive: true });
  for (let i = 0; i < N; i += 1) {
    const id = `01a06400-0000-7000-8000-${String(i).padStart(12, '0')}`;
    await writeFile(
      join(dayDir, `rollout-2026-09-05T00-00-00-${id}.jsonl`),
      codexTranscript(id),
      'utf8',
    );
  }
  return root;
}

function codexTranscript(threadId: string): string {
  const meta = {
    timestamp: '2026-09-05T00:00:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: threadId,
      id: threadId,
      timestamp: '2026-09-05T00:00:00.000Z',
      cwd: 'C:\\audit\\workspace',
      originator: 'codex_exec',
      cli_version: PINNED_CODEX_VERSION,
      source: 'exec',
      thread_source: 'user',
      model_provider: 'openai',
    },
  };
  return `${JSON.stringify(meta)}\n`;
}

// ---- OpenCode -------------------------------------------------------------

/**
 * Row counts of the tables OpenCode's per-pass SQL scans.
 *
 * Not a mocked `node:sqlite`: the queries in `src/opencode/db.ts` carry no
 * `WHERE` and no `LIMIT`, so the rows they return ARE the rows in the table.
 * Counting the tables answers the audit's question without a stub that could
 * be wrong in a way the real engine is not.
 */
interface OcScan {
  dbPath: string;
  sessions: number;
  messages: number;
  parts: number;
  events: number;
}

function buildOpenCode(): OcScan {
  const dir = resolve(scratch, 'opencode');
  const dbPath = join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
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
  db.exec("INSERT INTO project VALUES ('p1', 'C:\\audit\\workspace', 'git')");
  const session = db.prepare(
    'INSERT INTO session VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, NULL)',
  );
  const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  const sequence = db.prepare('INSERT INTO event_sequence VALUES (?, ?, ?)');
  for (let i = 0; i < N; i += 1) {
    const id = `ses_${String(i)}`;
    session.run(id, 'p1', `slug-${String(i)}`, 'C:\\audit\\workspace', 'title', '1.18.22',
      'build', 'gpt', 1, 1);
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
  const count = (t: string): number =>
    Number((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);
  const scan = {
    dbPath,
    sessions: count('session'),
    messages: count('message'),
    parts: count('part'),
    events: count('event_sequence'),
  };
  db.close();
  return scan;
}

// ---------------------------------------------------------------------------

let ccCorpus: { projectsRoot: string; workspacePath: string };
let codexRoot = '';
let ocScan: OcScan;

beforeAll(async () => {
  await mkdir(resolve('dist'), { recursive: true });
  scratch = await mkdtemp(resolve('dist', 'ingest-audit-'));
  await mkdir(resolve(scratch, 'opencode'), { recursive: true });
  countUnder = scratch;
  ccCorpus = await buildClaudeCode();
  codexRoot = await buildCodex();
  ocScan = buildOpenCode();
}, 600_000);

afterAll(async () => {
  countUnder = '\u0000never';
  if (table.length > 0) {
    // Printed, because these numbers are the audit's evidence and a number
    // that only a passing test ever saw is a number nobody can quote.
    console.info(`\nH.11 item 4 — one idle pass, N=${String(N)} historical sessions per engine`);
    for (const line of table) console.info(`  ${line}`);
  }
  if (scratch !== '') await rm(scratch, { recursive: true, force: true });
});

describe('H.11 item 4 — what one idle pass costs, per engine, at N=500', () => {
  it('Claude Code: one readdir sweep, one stat per tracked file, ZERO bytes', async () => {
    const tailer = new SessionTailer({
      workspacePath: ccCorpus.workspacePath,
      projectsRoot: ccCorpus.projectsRoot,
    });

    const first = await tailer.poll();
    expect(first.lines.length, 'the corpus must actually be read once').toBeGreaterThan(0);
    expect(tailer.trackedFiles()).toHaveLength(N);

    reset();
    const second = await tailer.poll();

    record(
      `cc      pass2: opens=${String(counts.open)} stats=${String(counts.stat)} ` +
        `readdirs=${String(counts.readdir)} bytes=${String(counts.bytesRead)} ` +
        `tracked=${String(tailer.trackedFiles().length)}`,
    );

    // ZERO bytes: `FileTail.read` returns early when `stats.size === offset`.
    expect(second.lines).toHaveLength(0);
    expect(counts.bytesRead).toBe(0);

    /*
     * BUT ONE OPEN PER FILE, EVERY PASS, AND THAT IS THE FINDING.
     *
     * `FileTail.read` opens the file and calls `handle.stat()` on the handle —
     * it does not `stat` the path first. So an idle Claude Code workspace with
     * N transcripts costs N `open`/`fstat`/`close` triples per poll, where the
     * Codex engine now costs zero (its size comes from the discovery sweep
     * that already ran).
     *
     * This is bounded by the WORKSPACE, not by the machine, which is the whole
     * reason it never produced the Codex symptom. Recorded as a finding rather
     * than fixed here: the fix is the hotfix's own shape and the decision
     * about whether it ships in 0.6.1 is the user's.
     */
    expect(counts.open).toBe(N);
    expect(counts.readdir).toBeGreaterThan(0);
  }, 600_000);

  it('Codex: one discovery sweep, ZERO opens and ZERO bytes on an idle pass', async () => {
    const store = new CodexTailStore();

    // Drain first: "idle" means read AND unchanged.
    for (let i = 0; i < 5; i += 1) {
      const outcome = await readCodexEngine({ root: codexRoot, tails: store });
      if (outcome.kind !== 'ok') throw new Error('engine did not read the corpus');
      if (outcome.result.threads.length === N) break;
    }
    expect(store.size).toBe(N);

    reset();
    const idle = await readCodexEngine({ root: codexRoot, tails: store });
    if (idle.kind !== 'ok') throw new Error('engine did not read the corpus');

    record(
      `codex   pass2: opens=${String(counts.open)} stats=${String(counts.stat)} ` +
        `readdirs=${String(counts.readdir)} bytes=${String(counts.bytesRead)} ` +
        `tails=${String(store.size)}`,
    );

    expect(idle.result.threads).toHaveLength(N);
    // THE HOTFIX, measured at N=500: not one file is opened.
    expect(counts.open).toBe(0);
    expect(counts.bytesRead).toBe(0);
    // The discovery sweep still stats every file — that is where the size
    // comes from, and it is what the size gate is measured against.
    expect(counts.stat).toBeGreaterThanOrEqual(N);
  }, 600_000);

  it('OpenCode: the per-pass content SQL is unfiltered, so a pass scans every row', () => {
    /*
     * NOT A MOCK. The queries in `src/opencode/db.ts` carry no `WHERE` and no
     * `LIMIT`, so what they return is what the table holds — counting the
     * tables answers the question without a stub that could be wrong in a way
     * the engine is not.
     */
    record(
      `oc      per content read: session=${String(ocScan.sessions)} ` +
        `message=${String(ocScan.messages)} part=${String(ocScan.parts)} ` +
        `event_sequence=${String(ocScan.events)} (rows returned, unfiltered)`,
    );

    expect(ocScan.sessions).toBe(N);
    expect(ocScan.parts).toBe(N);

    /*
     * The SQL is read from the module rather than restated, so this cannot
     * pass against a query that has since gained a filter — which is exactly
     * the outcome H.11b asks for.
     */
    const sql = readOpenCodeSql();
    for (const [name, text] of Object.entries(sql)) {
      expect(text.toUpperCase(), `${name} is expected to be unfiltered today`).not.toContain(
        ' WHERE ',
      );
      expect(text.toUpperCase(), `${name} is expected to be unbounded today`).not.toContain(
        ' LIMIT ',
      );
    }
  }, 120_000);
});

/**
 * The three per-pass content queries, read out of `db.ts` as source.
 *
 * A test that restated them would agree with itself forever. This one goes
 * red the day one of them gains a `WHERE`, which is the day the finding stops
 * being true — and a finding that outlives its own truth is worse than none.
 */
function readOpenCodeSql(): Record<string, string> {
  const source = readFileSync(
    fileURLToPath(new URL('../opencode/db.ts', import.meta.url)),
    'utf8',
  );
  const grab = (name: string): string => {
    // `;\r?\n`, not `;\n`: this repository's source is CRLF, and a pattern
    // matching only LF finds nothing here and everything in an LF checkout.
    // The recorded shebang lesson, arriving in a regex.
    const match = new RegExp(`const ${name} =([\\s\\S]*?);\\r?\\n`).exec(source);
    expect(match, `${name} not found in db.ts`).not.toBeNull();
    return match?.[1] ?? '';
  };
  return {
    SESSION_SQL: grab('SESSION_SQL'),
    MESSAGE_SQL: grab('MESSAGE_SQL'),
    PART_SQL: grab('PART_SQL'),
  };
}
