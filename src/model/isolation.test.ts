/**
 * Agent Deck — PLAN.md **DoD 5.3: isolation, both directions**.
 *
 * Three tests, and each one exists because the property it names is invisible
 * until something breaks:
 *
 *   1. OpenCode DB corrupt/absent  -> Claude Code sessions render UNCHANGED.
 *   2. Claude Code parse failure   -> OpenCode sessions render UNCHANGED.
 *   3. Claude Code hook listener down -> OpenCode liveness UNAFFECTED.
 *
 * ---------------------------------------------------------------------------
 * HOW "UNCHANGED" IS MEASURED, AND WHY IT IS NOT A SPOT CHECK
 * ---------------------------------------------------------------------------
 * Each test emits twice through the REAL `AgentDeckDataPath.pump()`: once with
 * the other engine healthy, once with it broken. The two runs' `SessionState`
 * lists for the engine under protection are compared as JSON, whole. Asserting
 * "the tree still has 5 nodes" would pass while liveness silently flipped, and
 * a byte comparison is the only form of "unchanged" that cannot be satisfied by
 * accident.
 *
 * **Every test carries a control that the sabotage really landed.** An
 * isolation test whose sabotage did nothing passes forever while proving
 * nothing — this repo's most-recorded shape of a vacuous test. So test 1
 * asserts the OpenCode half actually degraded, test 2 asserts the Claude Code
 * half actually refused every session, and test 3 asserts the bind actually
 * failed AND that OpenCode liveness actually MOVED while it was down.
 *
 * ---------------------------------------------------------------------------
 * WHICH SESSIONS BELONG TO WHICH ENGINE
 * ---------------------------------------------------------------------------
 * `SessionState.engine` is what makes any of this assertable — its own doc
 * comment says a test can only name the sessions that must be unaffected if
 * the state says which engine produced them.
 *
 * The field is OPTIONAL and `src/model/events.ts` documents an absent value as
 * reading `'cc'`. Gate amendment B3 makes the Claude Code engine stamp it
 * explicitly, and that change lands in this same phase from a different
 * package. So nothing here hard-codes one spelling: {@link engineOf} normalises
 * absence to `'cc'`, and the assertions are correct whether or not B3 has
 * merged yet.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE READS A LIVE DATABASE OR A REAL HOME DIRECTORY
 * ---------------------------------------------------------------------------
 * The Claude Code corpus is a committed fixture copied into a temp projects
 * root; the OpenCode corpus is a `synthetic-` copy of a committed one, made per
 * test in a `mkdtemp` directory (Phase 4 Amendment A2). Both clocks are
 * injected. `%USERPROFILE%\.local\share\opencode` is never resolved: every
 * construction passes an explicit `dbPath`.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  AgentDeckDataPath,
  DEFAULT_LIVENESS_THRESHOLD_MS,
  DEFAULT_PREVIEW_BYTES,
} from '../extension.js';
import type { DataPathEmission, DataPathOptions } from '../extension.js';
import type { SessionState } from './events.js';
import type { GraftSessionResult } from './graft.js';
import { slugifyWorkspace } from '../parser/tailer.js';
import {
  copyCorpus,
  corpusDbPath,
  listCorpora,
  writeNonDatabase,
} from '../opencode/synthetic.js';
import { DEFAULT_OC_LIVENESS_THRESHOLD_MS } from '../opencode/liveness.js';
import type { PollTrigger, PollTriggerHandle } from '../opencode/liveness.js';
import { readCodexEngine } from '../codex/index.js';
import type { CodexThread } from '../codex/index.js';

// ---------------------------------------------------------------------------
// Fixture roots — derived, never named
// ---------------------------------------------------------------------------

const CC_ROOT = fileURLToPath(new URL('../../fixtures/cc-2.1.234/projects', import.meta.url));
const EXTENSION_SOURCE = fileURLToPath(new URL('../extension.ts', import.meta.url));
/** The committed real Codex corpus's `.codex` root, containing `sessions/`. */
const CODEX_ROOT_DIR = fileURLToPath(
  new URL('../../fixtures/codex-0.151.0-alpha.7.2/baseline/home/.codex', import.meta.url),
);
/**
 * A deterministic, guaranteed-nonexistent root — the Codex engine's default
 * "off" state for every test in this file that does not stage it. Never
 * created, so no real filesystem access happens (G6): `statSync` on it fails
 * ENOENT and the engine reports `rootAbsent`, exactly as it would on a
 * machine with no Codex installed.
 */
const ABSENT_CODEX_ROOT = join(tmpdir(), 'agent-deck-isolation-codex-absent-does-not-exist');

/**
 * The budget every body in this file that STAGES A CORPUS needs, and did not
 * all carry.
 *
 * Two of them declared `120_000` from the day they were written; the rest ran
 * on vitest's **5 s default** while doing the same work — copying a Claude Code
 * projects tree, an OpenCode SQLite store and a Codex rollout root, then
 * building a whole data path over each. That is fine run alone and a coin flip
 * under a loaded suite: adding one fixture corpus elsewhere (2026-09-03) was
 * enough to turn one of them red, as a TIMEOUT with no failing assertion —
 * the shape rule 14 refuses a gate on, and the class this repository already
 * records for `vsce ls` and for `egress.test.ts`'s hook.
 *
 * Named once rather than repeated five times, so the next body that stages
 * something inherits the decision instead of re-discovering it at a gate.
 */
const STAGING_BUDGET_MS = 120_000;

/**
 * A fixed Claude Code clock, taken ONCE before anything is staged.
 *
 * The CC liveness engine reads transcript mtimes against a clock, so an
 * un-injected `Date.now()` would make the two halves of a byte comparison
 * differ for a reason that has nothing to do with the property under test.
 * Taken before staging so the copied files' mtimes land just after it and every
 * session reads the same way in both runs.
 */
const CC_CLOCK = Date.now();

/** OpenCode's clock. A `let` the tests move by hand (Amendment A2). */
let ocClock = 0;

const scratch: string[] = [];

/**
 * A temp directory whose path is safe to hand to a filesystem watch.
 *
 * `realpathSync.native()` first: libuv ABORTS the process — no failing
 * assertion, no summary line — when a watched path carries an 8.3 short
 * component, and `os.tmpdir()` on a Windows CI runner is exactly that shape.
 */
async function makeTempDir(prefix = 'agent-deck-isolation-'): Promise<string> {
  const dir = await mkdtemp(join(realpathSync.native(tmpdir()), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Staging: one Claude Code corpus, one OpenCode corpus
// ---------------------------------------------------------------------------

interface StagedCc {
  projectsRoot: string;
  workspacePath: string;
  slug: string;
}

/** The one slug directory in the committed Claude Code capture. */
async function capturedSlugDir(): Promise<string> {
  const entries = await readdir(CC_ROOT, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  expect(dirs.length, 'the CC capture must carry a slug directory').toBeGreaterThan(0);
  return join(CC_ROOT, dirs[0] as string);
}

/**
 * Copy the committed slug directory into a temp projects root, renamed to the
 * slug of a temp workspace path, so correlation can match it.
 *
 * The mutation stays in `fixtures/` (G6); only its LOCATION changes.
 */
async function stageCc(): Promise<StagedCc> {
  const projectsRoot = await makeTempDir('agent-deck-isolation-cc-');
  const workspacePath = join(await makeTempDir('agent-deck-isolation-ws-'), 'ws');
  const slug = slugifyWorkspace(workspacePath);
  await cp(await capturedSlugDir(), join(projectsRoot, slug), { recursive: true });
  return { projectsRoot, workspacePath, slug };
}

/**
 * The smallest committed OpenCode corpus, chosen BY SIZE rather than by name —
 * nothing here depends on which one it is, and the recorded rule is not to
 * hard-code a capture's name or assert a fixture set's size.
 */
function smallestCorpus(): string {
  const names = listCorpora();
  expect(names.length, 'there must be a committed OpenCode corpus').toBeGreaterThan(0);
  let best = '';
  let bestSize = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const size = statSync(corpusDbPath(name)).size;
    if (size < bestSize) {
      bestSize = size;
      best = name;
    }
  }
  return best;
}

interface StagedOc {
  dir: string;
  dbPath: string;
  worktree: string;
  /** The root session with the most recently updated row. Derived, not named. */
  freshestRootId: string;
  /** `max(session.time_updated)` across the corpus. */
  maxTimeUpdated: number;
}

function readRows(dbPath: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

async function stageOc(): Promise<StagedOc> {
  const dir = await makeTempDir('agent-deck-isolation-oc-');
  const dbPath = copyCorpus(smallestCorpus(), dir);

  const projects = readRows(dbPath, 'SELECT worktree FROM project ORDER BY id');
  const worktree = projects[0]?.['worktree'];
  expect(typeof worktree, 'the corpus must carry a project row').toBe('string');

  const sessions = readRows(
    dbPath,
    'SELECT id, parent_id, time_updated FROM session ORDER BY id',
  );
  let freshestRootId = '';
  let freshest = -1;
  let maxTimeUpdated = 0;
  for (const row of sessions) {
    const updated = Number(row['time_updated'] ?? 0);
    if (updated > maxTimeUpdated) maxTimeUpdated = updated;
    if (row['parent_id'] !== null) continue;
    if (updated > freshest) {
      freshest = updated;
      freshestRootId = String(row['id']);
    }
  }
  expect(freshestRootId, 'the corpus must carry a root session').not.toBe('');
  return { dir, dbPath, worktree: worktree as string, freshestRootId, maxTimeUpdated };
}

interface StagedCodex {
  root: string;
  workspaceFolder: string;
  rootSessionId: string;
}

/**
 * The committed Codex fixture's ROOT thread, read through the PRODUCTION
 * engine (`readCodexEngine`) rather than by hand-parsing the transcript —
 * the same rule `stageOc` follows by reading rows off the real database
 * rather than trusting a filename. Nothing here mutates the fixture (G6):
 * it is read directly, in place, never copied.
 */
async function stageCodex(): Promise<StagedCodex> {
  const outcome = await readCodexEngine({ root: CODEX_ROOT_DIR });
  expect(outcome.kind, 'the Codex fixture must be readable').toBe('ok');
  if (outcome.kind !== 'ok') throw new Error('unreachable: asserted above');
  const root = outcome.result.threads.find((t: CodexThread) => t.threadSource === 'user');
  expect(root, 'the Codex fixture must carry a root thread').toBeDefined();
  return {
    root: CODEX_ROOT_DIR,
    workspaceFolder: (root as CodexThread).cwd,
    rootSessionId: (root as CodexThread).sessionId,
  };
}

/** Bump one session's `event_sequence.seq`. The one mutation these tests make. */
function bumpSeq(dbPath: string, sessionId: string, by = 1): number {
  const db = new DatabaseSync(dbPath);
  try {
    const current = db
      .prepare('SELECT seq FROM event_sequence WHERE aggregate_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
    const next = Number(current?.['seq'] ?? 0) + by;
    db.prepare('UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?').run(next, sessionId);
    return next;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Injection stubs
// ---------------------------------------------------------------------------

function manualPollTrigger(): { trigger: PollTrigger; fire: () => void } {
  const runs: (() => void)[] = [];
  const trigger: PollTrigger = (run): PollTriggerHandle => {
    runs.push(run);
    return { stop: () => {} };
  };
  return {
    trigger,
    fire: () => {
      for (const run of runs) run();
    },
  };
}

/** No chokidar: these tests drive the cadence, not the filesystem. */
const noWalWatch = (): { close: () => void } => ({ close: () => {} });

// ---------------------------------------------------------------------------
// Ports — the same probe-and-retry the extension tests use, in miniature
// ---------------------------------------------------------------------------

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** Hold a port so the next bind on it collides. */
async function holdPort(port: number): Promise<() => Promise<void>> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
}

const ATTEMPTS = 6;

/**
 * Build and start a data path on a port that was free a moment ago, retrying
 * when the machine steals it in between.
 *
 * The window cannot be closed here for the reason `extension.test.ts` records:
 * the production listener binds exactly the port it is configured with and
 * refuses to pick another. A collision is REPORTED (`bindError`), not thrown,
 * so the retry checks the returned value.
 */
async function startOnFreePort(
  make: (port: number) => AgentDeckDataPath,
): Promise<AgentDeckDataPath> {
  const tried: number[] = [];
  for (;;) {
    const port = await freePort();
    tried.push(port);
    const path = make(port);
    await path.start();
    if (path.diagnostics.bindError?.code !== 'EADDRINUSE') return path;
    await path.dispose();
    if (tried.length >= ATTEMPTS) {
      throw new Error(`EADDRINUSE on all ${String(tried.length)} probed ports`);
    }
  }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  cc: StagedCc;
  /** A path that does not exist means "the OpenCode store is ABSENT". */
  ocDbPath: string;
  ocWorktree: string;
  /** Overrides the CC content path, so a content failure can be CAUSED. */
  graft?: DataPathOptions['graft'];
  ocRead?: NonNullable<DataPathOptions['opencode']>['read'];
  ocPollTrigger?: PollTrigger;
  /**
   * Defaults to {@link ABSENT_CODEX_ROOT} — the Codex engine off,
   * deterministically (G6): a test that wants it ON must stage it and pass
   * `stageCodex()`'s `root` explicitly, the same opt-in shape `ocDbPath` has
   * for OpenCode's absent case.
   */
  codexRoot?: string;
  /** Required to make a staged Codex session workspace-match. See B6 below. */
  codexWorkspace?: string;
  codexRead?: NonNullable<DataPathOptions['codex']>['read'];
  /** Every emission the path produced, in order. */
  captured?: DataPathEmission[];
}

function buildDataPath(options: HarnessOptions, port: number): AgentDeckDataPath {
  const captured = options.captured;
  return new AgentDeckDataPath({
    workspacePath: options.cc.workspacePath,
    // B6: every root, because each corpus was captured in a different
    // directory from the staged Claude Code workspace.
    workspacePaths: [
      options.cc.workspacePath,
      options.ocWorktree,
      ...(options.codexWorkspace !== undefined ? [options.codexWorkspace] : []),
    ],
    settings: {
      port,
      livenessThresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
      previewBytes: DEFAULT_PREVIEW_BYTES,
    },
    projectsRoot: options.cc.projectsRoot,
    now: () => CC_CLOCK,
    tickMs: 0,
    onEmission: (payload) => {
      captured?.push(payload);
    },
    onError: () => {},
    ...(options.graft !== undefined ? { graft: options.graft } : {}),
    opencode: {
      dbPath: options.ocDbPath,
      now: () => ocClock,
      pollTrigger: options.ocPollTrigger ?? ((): PollTriggerHandle => ({ stop: () => {} })),
      walWatchFactory: noWalWatch,
      log: () => {},
      ...(options.ocRead !== undefined ? { read: options.ocRead } : {}),
    },
    codex: {
      root: options.codexRoot ?? ABSENT_CODEX_ROOT,
      now: () => CC_CLOCK,
      pollTrigger: (): PollTriggerHandle => ({ stop: () => {} }),
      log: () => {},
      ...(options.codexRead !== undefined ? { read: options.codexRead } : {}),
    },
  });
}

/** Everything one emission says, split by the engine that produced it. */
interface Split {
  cc: SessionState[];
  opencode: SessionState[];
  codex: SessionState[];
}

/**
 * `SessionState.engine`, with absence normalised to `'cc'`.
 *
 * `src/model/events.ts` documents an absent field as reading `'cc'`, and gate
 * amendment B3 makes the CC engine stamp it explicitly in this same phase. This
 * function is correct before and after that lands, which is the point: an
 * assertion hard-coded to one spelling would go red on a merge rather than on a
 * defect.
 */
function engineOf(state: SessionState): 'cc' | 'opencode' | 'codex' {
  return state.engine ?? 'cc';
}

function split(emission: DataPathEmission): Split {
  const sessions = [...emission.emission.sessions].sort((a, b) =>
    a.sessionId.localeCompare(b.sessionId),
  );
  return {
    cc: sessions.filter((s) => engineOf(s) === 'cc'),
    opencode: sessions.filter((s) => engineOf(s) === 'opencode'),
    codex: sessions.filter((s) => engineOf(s) === 'codex'),
  };
}

/**
 * One full pass: start on a free port, take one REAL emission, tear down.
 *
 * The emission is the one `pump()` published to `onEmission` — the production
 * consumer seam — not a list reassembled here. A test that rebuilt the payload
 * out of the two engines' internals would be asserting about its own arithmetic
 * rather than about what the panel is sent.
 */
async function runOnce(
  options: HarnessOptions,
): Promise<{ split: Split; path: AgentDeckDataPath; emission: DataPathEmission }> {
  const captured: DataPathEmission[] = [];
  const path = await startOnFreePort((port) =>
    buildDataPath({ ...options, captured }, port),
  );
  try {
    // `start()` already pumped at least once; pump again so the emission read
    // below is the settled one rather than whichever round the drain landed in.
    path.pump();
    const last = captured.at(-1);
    expect(last, 'the data path published no emission at all').toBeDefined();
    const emission = last as DataPathEmission;
    return { split: split(emission), path, emission };
  } finally {
    await path.dispose();
  }
}

// ---------------------------------------------------------------------------
// Preconditions — measured once, so a green result cannot be an empty one
// ---------------------------------------------------------------------------

let corpusName = '';

beforeAll(() => {
  corpusName = smallestCorpus();
  expect(existsSync(corpusDbPath(corpusName))).toBe(true);
});

describe('DoD 5.3 (1) — a broken OpenCode store leaves Claude Code sessions unchanged', () => {
  it('renders the same CC sessions with the store healthy, corrupt, absent, and throwing', async () => {
    const cc = await stageCc();
    const oc = await stageOc();
    ocClock = oc.maxTimeUpdated + DEFAULT_OC_LIVENESS_THRESHOLD_MS + 1;

    // (a) HEALTHY. The baseline both engines render from.
    const healthy = await runOnce({ cc, ocDbPath: oc.dbPath, ocWorktree: oc.worktree });
    const baseline = JSON.stringify(healthy.split.cc);
    expect(healthy.split.cc.length, 'the CC fixture must produce sessions').toBeGreaterThan(0);
    expect(
      healthy.split.opencode.length,
      'the OpenCode corpus must produce sessions, or the sabotage below removes nothing',
    ).toBeGreaterThan(0);
    expect(healthy.path.diagnostics.opencode.enabled).toBe(true);
    expect(healthy.path.diagnostics.opencode.degradedReads).toBe(0);

    // (b) CORRUPT. A file that is present, non-empty, and not a database.
    const corruptDir = await makeTempDir('agent-deck-isolation-corrupt-');
    const corrupt = writeNonDatabase(corruptDir);
    const broken = await runOnce({ cc, ocDbPath: corrupt, ocWorktree: oc.worktree });
    expect(JSON.stringify(broken.split.cc)).toBe(baseline);
    // The control: the sabotage landed. Without this the test would pass if
    // `writeNonDatabase` had written a perfectly good database.
    expect(broken.path.diagnostics.opencode.enabled).toBe(true);
    expect(broken.path.diagnostics.opencode.degradedReads).toBeGreaterThan(0);
    expect(broken.split.opencode).toStrictEqual([]);

    // (c) ABSENT. The store is simply not there.
    const emptyDir = await makeTempDir('agent-deck-isolation-empty-');
    const absent = join(emptyDir, 'opencode.db');
    expect(existsSync(absent)).toBe(false);
    const off = await runOnce({ cc, ocDbPath: absent, ocWorktree: oc.worktree });
    expect(JSON.stringify(off.split.cc)).toBe(baseline);
    expect(off.path.diagnostics.opencode.enabled).toBe(false);
    expect(off.split.opencode).toStrictEqual([]);

    // (d) THROWING. `readOpenCodeEngine` is documented never to throw, so the
    // only way to prove the catch is to inject one. Same argument
    // `DataPathOptions.graft` makes for the Claude Code side.
    const thrown = await runOnce({
      cc,
      ocDbPath: oc.dbPath,
      ocWorktree: oc.worktree,
      ocRead: () => {
        throw new Error('injected OpenCode read failure');
      },
    });
    expect(JSON.stringify(thrown.split.cc)).toBe(baseline);
    expect(thrown.path.diagnostics.opencode.contentFailures).toBeGreaterThan(0);
    expect(thrown.path.diagnostics.opencode.lastError).toContain('injected OpenCode read failure');
    expect(thrown.split.opencode).toStrictEqual([]);
    // ...and the Claude Code half never noticed.
    expect(thrown.path.diagnostics.graftErrors).toBe(0);
    expect(thrown.path.diagnostics.ccEmitErrors).toBe(0);
  }, 120_000);
});

describe('DoD 5.3 (2) — a Claude Code parse failure leaves OpenCode sessions unchanged', () => {
  it('renders the same OpenCode sessions while every CC session refuses', async () => {
    const cc = await stageCc();
    const oc = await stageOc();
    ocClock = oc.maxTimeUpdated + DEFAULT_OC_LIVENESS_THRESHOLD_MS + 1;

    const healthy = await runOnce({ cc, ocDbPath: oc.dbPath, ocWorktree: oc.worktree });
    const baseline = JSON.stringify(healthy.split.opencode);
    expect(healthy.split.opencode.length).toBeGreaterThan(0);
    expect(healthy.split.cc.length).toBeGreaterThan(0);
    expect(healthy.path.diagnostics.graftRefusals).toBe(0);
    expect(healthy.path.diagnostics.graftErrors).toBe(0);

    // (a) The content path REFUSES — a G3 schema mismatch, the shape a
    // synthetic corpus produces, handed back rather than thrown.
    const refusal: GraftSessionResult = {
      ok: false,
      mismatch: {
        kind: 'schemaMismatch',
        code: 'subagentsDirectoryMisnamed',
        reason: 'injected refusal',
      },
      diagnostics: { malformedLines: 0, parsedLines: 0, ignoredLines: 0, skippedFiles: [] },
    };
    const refused = await runOnce({
      cc,
      ocDbPath: oc.dbPath,
      ocWorktree: oc.worktree,
      graft: () => Promise.resolve(refusal),
    });
    expect(JSON.stringify(refused.split.opencode)).toBe(baseline);
    // The control: every CC session really did refuse.
    expect(refused.path.diagnostics.graftRefusals).toBe(
      refused.path.diagnostics.grafts,
    );
    expect(refused.path.diagnostics.grafts).toBeGreaterThan(0);
    for (const session of refused.split.cc) expect(session.schemaOk).toBe(false);

    // (b) The content path THROWS. `AgentDeckDataPath.#graft`'s catch is the
    // last thing between a CC parser bug and the whole deck.
    const threw = await runOnce({
      cc,
      ocDbPath: oc.dbPath,
      ocWorktree: oc.worktree,
      graft: () => {
        throw new Error('injected CC parse failure');
      },
    });
    expect(JSON.stringify(threw.split.opencode)).toBe(baseline);
    expect(threw.path.diagnostics.graftErrors).toBeGreaterThan(0);
    expect(threw.path.diagnostics.lastGraftError).toContain('injected CC parse failure');
    // ...and the OpenCode half read the store exactly as it would have anyway.
    expect(threw.path.diagnostics.opencode.contentFailures).toBe(0);
    expect(threw.path.diagnostics.opencode.degradedReads).toBe(0);
    expect(threw.path.diagnostics.opencodeEmitErrors).toBe(0);
  }, STAGING_BUDGET_MS);
});

describe('DoD 5.3 (3) — the hook listener being down leaves OpenCode liveness alone', () => {
  it('advances OpenCode liveness from idle to live while the CC socket is refused', async () => {
    const cc = await stageCc();
    const oc = await stageOc();

    // A clock at which EVERY OpenCode session is already stale. The `idle`
    // assertion below is the control for the `live` one: without it, a corpus
    // that read `live` from the start would prove nothing.
    ocClock = oc.maxTimeUpdated + DEFAULT_OC_LIVENESS_THRESHOLD_MS + 1;

    const port = await freePort();
    const release = await holdPort(port);
    const poll = manualPollTrigger();
    try {
      // The emissions this path publishes. Captured so the assertion below
      // can read the real payload rather than the engine accessor a second
      // time — see the note at that assertion.
      const captured: DataPathEmission[] = [];
      const path = buildDataPath(
        {
          cc,
          ocDbPath: oc.dbPath,
          ocWorktree: oc.worktree,
          ocPollTrigger: poll.trigger,
          captured,
        },
        port,
      );
      try {
        await path.start();

        // The control: the hook tap really is down.
        expect(path.diagnostics.listening).toBe(false);
        expect(path.diagnostics.bindError?.code).toBe('EADDRINUSE');
        expect(path.diagnostics.bindError?.port).toBe(port);
        expect(path.liveness.degradedState()).toStrictEqual({
          degraded: true,
          reason: 'listenerDown',
        });

        // The OpenCode engine started anyway, and its sessions are stale.
        const before = path.opencode
          .sessions()
          .find((s) => s.sessionId === oc.freshestRootId);
        expect(before, 'the corpus root session must render').toBeDefined();
        expect(before?.liveness).toBe('idle');

        // Something happens in OpenCode: its event cursor advances. Nothing
        // about the hook listener changes.
        bumpSeq(oc.dbPath, oc.freshestRootId);
        ocClock += 1;
        poll.fire();

        const after = path.opencode
          .sessions()
          .find((s) => s.sessionId === oc.freshestRootId);
        expect(
          after?.liveness,
          'OpenCode liveness must move on its own cursor while the CC socket is down',
        ).toBe('live');

        // AND IT REACHES THE EMITTED STREAM — which the accessor above cannot
        // speak for, and which the code that stood here did not check.
        //
        // What stood here called pump() and then re-read
        // path.opencode.sessions() into a variable named "emitted": the SAME
        // accessor the assertion three lines up had already used. No
        // DataPathEmission was ever inspected, because this call site passed
        // no `captured` array, so deleting the pump() would not have turned
        // it red. The comment claimed coverage the code did not add — this
        // repo's most-recorded defect class, arriving inside the test written
        // to prevent its cousin.
        //
        // What the emission adds over the accessor: everything between
        // OpenCodeEnginePath.sessions() and the panel. #emitOpenCode() can
        // return null when it reads `enabled` wrong; pump() can abandon the
        // round when the Claude Code half throws (and this test is running
        // with the CC socket refused, which is exactly when that matters);
        // mergeEmissions() can drop a half; and emit() deep-freezes and diffs
        // against #previous, so it can publish the PREVIOUS state while the
        // accessor happily reports the new one. None of that is reachable by
        // calling sessions() twice.
        const seen = captured.length;
        path.pump();
        expect(captured.length, 'pump() must publish exactly one emission').toBe(
          seen + 1,
        );
        const published = captured[captured.length - 1] as DataPathEmission;
        const liveOnTheWire = published.emission.sessions
          .filter((s) => engineOf(s) === 'opencode' && s.liveness === 'live')
          .map((s) => s.sessionId);
        expect(
          liveOnTheWire,
          'the live OpenCode session must reach the payload the panel is sent',
        ).toContain(oc.freshestRootId);
        // ...in the SAME payload that still reports the hook tap as down, so
        // one emission carries both engines' truths rather than one of them.
        expect(published.degraded).toStrictEqual({
          degraded: true,
          reason: 'listenerDown',
        });

        // The CC socket is still down; the OpenCode engine is still healthy.
        expect(path.diagnostics.listening).toBe(false);
        expect(path.diagnostics.opencode.livenessDegraded).toBe(false);
        expect(path.diagnostics.opencode.livenessPolls).toBeGreaterThan(1);
      } finally {
        await path.dispose();
      }
    } finally {
      await release();
    }
  }, STAGING_BUDGET_MS);
});

/**
 * PLAN.md v0.6.0 DoD 3.2's isolation requirement: three engines means three
 * isolation directions, not the two DoD 5.3 checked before Codex existed.
 * The two blocks below are the new ones — a Codex-side failure leaving the
 * other two unaffected, and either of the other two failing leaving Codex
 * unaffected — using the same byte-comparison methodology and the same
 * "assert the sabotage really landed" discipline the file's header describes.
 */
describe('DoD 3.2 (3rd direction) — a broken Codex engine leaves Claude Code and OpenCode sessions unchanged', () => {
  it('renders the same CC and OpenCode sessions with the Codex root healthy, absent, and throwing', async () => {
    const cc = await stageCc();
    const oc = await stageOc();
    ocClock = oc.maxTimeUpdated + DEFAULT_OC_LIVENESS_THRESHOLD_MS + 1;
    const codex = await stageCodex();

    // (a) HEALTHY. The baseline both other engines render from, with Codex on.
    const healthy = await runOnce({
      cc,
      ocDbPath: oc.dbPath,
      ocWorktree: oc.worktree,
      codexRoot: codex.root,
      codexWorkspace: codex.workspaceFolder,
    });
    const ccBaseline = JSON.stringify(healthy.split.cc);
    const ocBaseline = JSON.stringify(healthy.split.opencode);
    expect(healthy.split.cc.length, 'the CC fixture must produce sessions').toBeGreaterThan(0);
    expect(
      healthy.split.opencode.length,
      'the OpenCode corpus must produce sessions',
    ).toBeGreaterThan(0);
    expect(
      healthy.split.codex.length,
      'the Codex fixture must produce a session, or the sabotage below removes nothing',
    ).toBeGreaterThan(0);
    expect(healthy.path.diagnostics.codex.enabled).toBe(true);

    // (b) ABSENT. `codexRoot` omitted -> `ABSENT_CODEX_ROOT` (G6: never a live
    // root, always a path guaranteed not to exist).
    const absent = await runOnce({ cc, ocDbPath: oc.dbPath, ocWorktree: oc.worktree });
    expect(JSON.stringify(absent.split.cc)).toBe(ccBaseline);
    expect(JSON.stringify(absent.split.opencode)).toBe(ocBaseline);
    // The control: the sabotage landed.
    expect(absent.path.diagnostics.codex.enabled).toBe(false);
    expect(absent.split.codex).toStrictEqual([]);

    // (c) THROWING. `readCodexEngine` is documented never to throw, so the
    // only way to prove the catch is to inject one — the same argument
    // `DataPathOptions.graft` and `OpenCodePathOptions.read` make for their
    // own engines.
    const thrown = await runOnce({
      cc,
      ocDbPath: oc.dbPath,
      ocWorktree: oc.worktree,
      codexRoot: codex.root,
      codexWorkspace: codex.workspaceFolder,
      codexRead: () => {
        throw new Error('injected Codex read failure');
      },
    });
    expect(JSON.stringify(thrown.split.cc)).toBe(ccBaseline);
    expect(JSON.stringify(thrown.split.opencode)).toBe(ocBaseline);
    expect(thrown.path.diagnostics.codex.contentFailures).toBeGreaterThan(0);
    expect(thrown.path.diagnostics.codex.lastError).toContain('injected Codex read failure');
    expect(thrown.split.codex).toStrictEqual([]);
    // ...and neither of the other two engines ever noticed.
    expect(thrown.path.diagnostics.graftErrors).toBe(0);
    expect(thrown.path.diagnostics.ccEmitErrors).toBe(0);
    expect(thrown.path.diagnostics.opencodeEmitErrors).toBe(0);
  }, 120_000);
});

describe('DoD 3.2 (3rd direction) — a Claude Code or OpenCode failure leaves Codex sessions unchanged', () => {
  it('renders the same Codex sessions while the CC content path throws and while the OpenCode store is corrupt', async () => {
    const cc = await stageCc();
    const oc = await stageOc();
    ocClock = oc.maxTimeUpdated + DEFAULT_OC_LIVENESS_THRESHOLD_MS + 1;
    const codex = await stageCodex();

    const healthy = await runOnce({
      cc,
      ocDbPath: oc.dbPath,
      ocWorktree: oc.worktree,
      codexRoot: codex.root,
      codexWorkspace: codex.workspaceFolder,
    });
    const codexBaseline = JSON.stringify(healthy.split.codex);
    expect(healthy.split.codex.length).toBeGreaterThan(0);
    expect(healthy.path.diagnostics.graftRefusals).toBe(0);
    expect(healthy.path.diagnostics.graftErrors).toBe(0);

    // (a) The CC content path THROWS.
    const ccThrew = await runOnce({
      cc,
      ocDbPath: oc.dbPath,
      ocWorktree: oc.worktree,
      codexRoot: codex.root,
      codexWorkspace: codex.workspaceFolder,
      graft: () => {
        throw new Error('injected CC parse failure');
      },
    });
    expect(JSON.stringify(ccThrew.split.codex)).toBe(codexBaseline);
    // The control: the CC content path really did throw.
    expect(ccThrew.path.diagnostics.graftErrors).toBeGreaterThan(0);
    expect(ccThrew.path.diagnostics.codexEmitErrors).toBe(0);

    // (b) The OpenCode store is CORRUPT — a file that is present, non-empty,
    // and not a database.
    const corruptDir = await makeTempDir('agent-deck-isolation-corrupt-codex-');
    const corrupt = writeNonDatabase(corruptDir);
    const ocBroken = await runOnce({
      cc,
      ocDbPath: corrupt,
      ocWorktree: oc.worktree,
      codexRoot: codex.root,
      codexWorkspace: codex.workspaceFolder,
    });
    expect(JSON.stringify(ocBroken.split.codex)).toBe(codexBaseline);
    // The control: the sabotage landed.
    expect(ocBroken.path.diagnostics.opencode.degradedReads).toBeGreaterThan(0);
    expect(ocBroken.path.diagnostics.codexEmitErrors).toBe(0);
  }, STAGING_BUDGET_MS);
});

describe('the two engines share no state that could carry a failure across', () => {
  it('the OpenCode path holds its own clock, trigger and store, and none of the CC objects', async () => {
    const cc = await stageCc();
    const oc = await stageOc();
    ocClock = oc.maxTimeUpdated + 1;
    const path = await startOnFreePort((port) =>
      buildDataPath({ cc, ocDbPath: oc.dbPath, ocWorktree: oc.worktree }, port),
    );
    try {
      // Reading the source is the check that survives a refactor: an
      // implementation that quietly handed `LivenessEngine` or the
      // `HookListener` to the OpenCode path would still pass every behavioural
      // test above until the day it did not.
      const source = await readFile(EXTENSION_SOURCE, 'utf8');
      const construction = /this\.opencode = new OpenCodeEnginePath\(\{[\s\S]*?\n {4}\}\);/.exec(
        source,
      );
      expect(construction, 'the OpenCode path construction site must be findable').not.toBeNull();
      const text = construction?.[0] ?? '';
      for (const forbidden of ['this.liveness', 'this.model', 'this.listener', 'this.watcher']) {
        expect(text, `the OpenCode path was handed ${forbidden}`).not.toContain(forbidden);
      }
      expect(path.opencode.dbPath).toBe(oc.dbPath);
    } finally {
      await path.dispose();
    }
  }, STAGING_BUDGET_MS);

  it('disposing the data path stops the OpenCode poll trigger and the WAL watch', async () => {
    const cc = await stageCc();
    const oc = await stageOc();
    ocClock = oc.maxTimeUpdated + 1;

    let stops = 0;
    let closes = 0;
    const path = await startOnFreePort(
      (port) =>
        new AgentDeckDataPath({
          workspacePath: cc.workspacePath,
          workspacePaths: [cc.workspacePath, oc.worktree],
          settings: {
            port,
            livenessThresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
            previewBytes: DEFAULT_PREVIEW_BYTES,
          },
          projectsRoot: cc.projectsRoot,
          now: () => CC_CLOCK,
          tickMs: 0,
          onEmission: () => {},
          onError: () => {},
          opencode: {
            dbPath: oc.dbPath,
            now: () => ocClock,
            pollTrigger: () => ({
              stop: () => {
                stops += 1;
              },
            }),
            walWatchFactory: () => ({
              close: () => {
                closes += 1;
              },
            }),
            log: () => {},
          },
          // G6: never a live root. This construction site bypasses
          // `buildDataPath`, which is the only other place that supplies it.
          codex: {
            root: ABSENT_CODEX_ROOT,
            pollTrigger: () => ({ stop: () => {} }),
            log: () => {},
          },
        }),
    );
    expect(stops).toBe(0);
    expect(closes).toBe(0);
    await path.dispose();
    expect(stops).toBe(1);
    expect(closes).toBe(1);
    expect(path.diagnostics.timersArmed).toBe(0);
    expect(path.diagnostics.listening).toBe(false);
    expect(path.opencode.sessions()).toStrictEqual([]);
  }, STAGING_BUDGET_MS);
});

/** Kept honest: the staging helpers must actually produce something. */
describe('the harness itself', () => {
  it('stages a Claude Code corpus whose slug matches its workspace', async () => {
    const cc = await stageCc();
    expect(existsSync(join(cc.projectsRoot, cc.slug))).toBe(true);
    await mkdir(cc.workspacePath, { recursive: true });
    expect(slugifyWorkspace(cc.workspacePath)).toBe(cc.slug);
  });

  it('stages an OpenCode corpus with a worktree and a root session', async () => {
    const oc = await stageOc();
    expect(oc.worktree).not.toBe('');
    expect(oc.freshestRootId).toMatch(/^ses_/);
    expect(oc.maxTimeUpdated).toBeGreaterThan(0);
    expect(corpusName).not.toBe('');
  });

  it('stages a Codex corpus with a workspace folder and a root session id', async () => {
    const codex = await stageCodex();
    expect(codex.root).toBe(CODEX_ROOT_DIR);
    expect(codex.workspaceFolder).not.toBe('');
    expect(codex.rootSessionId).not.toBe('');
  });

  it('ABSENT_CODEX_ROOT really does not exist', () => {
    expect(existsSync(ABSENT_CODEX_ROOT)).toBe(false);
  });
});
