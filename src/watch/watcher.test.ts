/**
 * Tests for the project file watcher.
 *
 * Everything these tests create lives under the OS temp directory. The
 * committed fixture tree is opened read-only, and one test proves it with a
 * before/after `snapshotTree` comparison (G1).
 *
 * No test sleeps on a fixed duration. The debounce tests drive the injected
 * `ManualTime`; the two tests that exercise real chokidar wait on a condition
 * (a batch arriving) with a bounded ceiling, because the tailer's polls are
 * genuinely asynchronous — there is no deterministic point at which a promise
 * chain over real fs I/O has settled.
 */

import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ManualTime, slugifyWorkspace, snapshotTree } from '../parser/tailer.js';
import type { TailBatch } from '../parser/tailer.js';
import {
  DEFAULT_DEBOUNCE_MS,
  ProjectWatcher,
  WATCH_DEPTH,
  createChokidarWatchFactory,
} from './watcher.js';
import type { WatchCallbacks, WatchFactory, WatchHandle } from './watcher.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const WORKSPACE = 'c:\\Users\\Test\\Documents\\ws';
const SLUG = slugifyWorkspace(WORKSPACE);
const SESSION_A = '4299490e-4a09-46a0-a544-7ffb0429e7e7';

/** Repo-relative fixture root: src/watch/ -> repo root. */
const FIXTURE_ROOT = fileURLToPath(new URL('../../fixtures/cc-2.1.234/projects', import.meta.url));
const FIXTURE_WORKSPACE = 'c:\\Users\\dev\\projects\\agent-deck';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'agent-deck-watch-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function makeProjectsRoot(name = 'projects'): Promise<string> {
  const root = join(tmpRoot, name);
  await mkdir(root, { recursive: true });
  return root;
}

function jsonl(...objects: Record<string, unknown>[]): string {
  return objects.map((o) => `${JSON.stringify(o)}\n`).join('');
}

/** A watcher we can drive by hand: no fs events, no timers, no platform. */
interface FakeWatcher {
  dir: string;
  callbacks: WatchCallbacks;
  closed: boolean;
  closeCalls: number;
}

interface FakeFactory {
  factory: WatchFactory;
  watchers: FakeWatcher[];
  /** The most recently created watcher. Throws if none exists. */
  latest(): FakeWatcher;
}

function fakeWatchFactory(options: { throwOnCreate?: Error } = {}): FakeFactory {
  const watchers: FakeWatcher[] = [];
  const factory: WatchFactory = (dir, callbacks) => {
    if (options.throwOnCreate !== undefined) throw options.throwOnCreate;
    const fake: FakeWatcher = { dir, callbacks, closed: false, closeCalls: 0 };
    watchers.push(fake);
    const handle: WatchHandle = {
      close: async () => {
        fake.closeCalls += 1;
        fake.closed = true;
      },
    };
    return handle;
  };
  return {
    factory,
    watchers,
    latest: () => {
      const last = watchers[watchers.length - 1];
      if (last === undefined) throw new Error('no watcher was created');
      return last;
    },
  };
}

/**
 * Wait until `predicate` holds. Not a sleep: it returns on the first tick the
 * condition is true, and fails loudly rather than hanging if it never is.
 */
async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Yield to the event loop enough times for an in-flight poll to finish.
 *
 * A poll is a chain of real fs promises, so microtask draining is not enough;
 * each tick here lets threadpool completions run. Used only to assert that
 * something did NOT happen — every positive assertion goes through
 * {@link waitUntil}, which returns on the first tick the condition holds.
 */
async function settle(ticks = 30): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

describe('ProjectWatcher — projects root resolution', () => {
  it('honours CLAUDE_PROJECTS_ROOT through resolveProjectsRoot', () => {
    const watcher = new ProjectWatcher({
      workspacePath: WORKSPACE,
      onBatch: () => undefined,
      env: { CLAUDE_PROJECTS_ROOT: FIXTURE_ROOT },
      homedir: () => 'c:\\nowhere',
      watchFactory: fakeWatchFactory().factory,
    });
    expect(watcher.projectsRoot).toBe(FIXTURE_ROOT);
    expect(watcher.rootSource).toBe('env');
    expect(watcher.watchDir).toBe(join(FIXTURE_ROOT, SLUG));
  });

  it('falls back to <home>/.claude/projects with no override', () => {
    const home = join(tmpRoot, 'fake-home');
    const watcher = new ProjectWatcher({
      workspacePath: WORKSPACE,
      onBatch: () => undefined,
      env: {},
      homedir: () => home,
      watchFactory: fakeWatchFactory().factory,
    });
    expect(watcher.projectsRoot).toBe(join(home, '.claude', 'projects'));
    expect(watcher.rootSource).toBe('home');
  });

  it('watches the slug directory, which is where all four file kinds live', async () => {
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: FIXTURE_WORKSPACE,
      onBatch: () => undefined,
      projectsRoot: FIXTURE_ROOT,
      watchFactory: fake.factory,
    });
    await watcher.start();
    expect(fake.watchers).toHaveLength(1);
    expect(fake.latest().dir).toBe(watcher.watchDir);
    // subagents/ and tool-results/ sit two levels under the slug dir.
    expect(WATCH_DEPTH).toBe(2);
    await watcher.dispose();
  });
});

// ---------------------------------------------------------------------------
// Initial read
// ---------------------------------------------------------------------------

describe('ProjectWatcher — start', () => {
  it('delivers an initial batch covering main and subagent transcripts', async () => {
    const batches: TailBatch[] = [];
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: FIXTURE_WORKSPACE,
      onBatch: (batch) => batches.push(batch),
      projectsRoot: FIXTURE_ROOT,
      watchFactory: fake.factory,
    });
    await watcher.start();

    expect(batches).toHaveLength(1);
    const batch = batches[0];
    if (batch === undefined) throw new Error('no batch');
    expect(batch.discoveryFailure).toBeUndefined();
    expect(batch.lines.length).toBeGreaterThan(0);
    // Derived from the tree, never a pinned count: both file kinds appear.
    const tracked = watcher.trackedFiles();
    expect(tracked.some((p) => /[/\\]subagents[/\\]agent-.*\.jsonl$/.test(p))).toBe(true);
    expect(tracked.some((p) => /[/\\][0-9a-f][0-9a-f-]+\.jsonl$/.test(p))).toBe(true);
    expect(watcher.diagnostics.polls).toBe(1);
    expect(watcher.diagnostics.batches).toBe(1);

    await watcher.dispose();
  });

  it('is idempotent: a second start does not arm a second watcher', async () => {
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: FIXTURE_WORKSPACE,
      onBatch: () => undefined,
      projectsRoot: FIXTURE_ROOT,
      watchFactory: fake.factory,
    });
    await watcher.start();
    await watcher.start();
    expect(fake.watchers).toHaveLength(1);
    expect(watcher.diagnostics.polls).toBe(1);
    await watcher.dispose();
  });
});

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

describe('ProjectWatcher — burst coalescing', () => {
  it('collapses a burst of fs events into exactly one poll', async () => {
    const root = await makeProjectsRoot();
    const slugDir = join(root, SLUG);
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user', n: 0 }));

    const time = new ManualTime();
    const batches: TailBatch[] = [];
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: WORKSPACE,
      onBatch: (batch) => batches.push(batch),
      projectsRoot: root,
      debounceMs: 50,
      maxWaitMs: 1_000,
      clock: time,
      scheduler: time,
      watchFactory: fake.factory,
    });
    await watcher.start();
    expect(watcher.diagnostics.polls).toBe(1); // the initial read

    // Twelve appends' worth of events, each inside the quiet period.
    for (let i = 1; i <= 12; i += 1) {
      await appendFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user', n: i }));
      fake.latest().callbacks.onChange('change', join(slugDir, `${SESSION_A}.jsonl`));
      time.advance(10);
    }
    expect(watcher.diagnostics.fsEvents).toBe(12);
    expect(watcher.diagnostics.polls).toBe(1); // nothing fired mid-burst
    expect(watcher.pendingSignals).toBe(12);

    time.advance(50);
    await waitUntil(() => watcher.diagnostics.polls === 2, 'the coalesced poll');

    expect(watcher.diagnostics.polls).toBe(2);
    expect(batches).toHaveLength(2);
    const second = batches[1];
    if (second === undefined) throw new Error('no second batch');
    expect(second.lines).toHaveLength(12);

    // Quiet from here on: no timer left armed, no further poll.
    expect(time.pendingTimers).toBe(0);
    time.advance(10_000);
    await settle();
    expect(watcher.diagnostics.polls).toBe(2);

    await watcher.dispose();
  });

  it('maxWait keeps a continuous burst from starving the poll', async () => {
    const root = await makeProjectsRoot();
    const slugDir = join(root, SLUG);
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user', n: 0 }));

    const time = new ManualTime();
    const batches: TailBatch[] = [];
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: WORKSPACE,
      onBatch: (batch) => batches.push(batch),
      projectsRoot: root,
      debounceMs: 100,
      maxWaitMs: 250,
      clock: time,
      scheduler: time,
      watchFactory: fake.factory,
    });
    await watcher.start();

    // Signal every 50 ms forever: the quiet period never elapses.
    for (let i = 0; i < 10; i += 1) {
      fake.latest().callbacks.onChange('change', join(slugDir, `${SESSION_A}.jsonl`));
      time.advance(50);
      await settle(3);
    }
    await waitUntil(() => watcher.diagnostics.polls > 1, 'a maxWait-forced poll');
    expect(watcher.diagnostics.polls).toBeGreaterThan(1);

    await watcher.dispose();
  });

  it('flush() polls immediately without waiting out the quiet period', async () => {
    const root = await makeProjectsRoot();
    const slugDir = join(root, SLUG);
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user', n: 0 }));

    const time = new ManualTime();
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: WORKSPACE,
      onBatch: () => undefined,
      projectsRoot: root,
      debounceMs: 5_000,
      clock: time,
      scheduler: time,
      watchFactory: fake.factory,
    });
    await watcher.start();
    fake.latest().callbacks.onChange('change', join(slugDir, `${SESSION_A}.jsonl`));
    expect(watcher.diagnostics.polls).toBe(1);

    watcher.flush();
    await waitUntil(() => watcher.diagnostics.polls === 2, 'the flushed poll');
    expect(watcher.diagnostics.polls).toBe(2);
    expect(time.pendingTimers).toBe(0);

    await watcher.dispose();
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe('ProjectWatcher — dispose', () => {
  it('closes every watcher and cancels every timer', async () => {
    const root = await makeProjectsRoot();
    await mkdir(join(root, SLUG), { recursive: true });
    await writeFile(join(root, SLUG, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    const time = new ManualTime();
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: WORKSPACE,
      onBatch: () => undefined,
      projectsRoot: root,
      debounceMs: 100,
      clock: time,
      scheduler: time,
      watchFactory: fake.factory,
    });
    await watcher.start();
    fake.latest().callbacks.onChange('change', join(root, SLUG, `${SESSION_A}.jsonl`));
    expect(time.pendingTimers).toBe(1);

    await watcher.dispose();

    expect(time.pendingTimers).toBe(0);
    expect(fake.latest().closed).toBe(true);
    expect(fake.latest().closeCalls).toBe(1);
    expect(watcher.diagnostics.disposed).toBe(true);
  });

  it('is idempotent and closes the watcher only once', async () => {
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: FIXTURE_WORKSPACE,
      onBatch: () => undefined,
      projectsRoot: FIXTURE_ROOT,
      watchFactory: fake.factory,
    });
    await watcher.start();
    await watcher.dispose();
    await watcher.dispose();
    expect(fake.latest().closeCalls).toBe(1);
  });

  it('never invokes onBatch after dispose — pending signals are dropped', async () => {
    const root = await makeProjectsRoot();
    await mkdir(join(root, SLUG), { recursive: true });
    await writeFile(join(root, SLUG, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    const time = new ManualTime();
    const batches: TailBatch[] = [];
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: WORKSPACE,
      onBatch: (batch) => batches.push(batch),
      projectsRoot: root,
      debounceMs: 100,
      clock: time,
      scheduler: time,
      watchFactory: fake.factory,
    });
    await watcher.start();
    expect(batches).toHaveLength(1);

    fake.latest().callbacks.onChange('change', join(root, SLUG, `${SESSION_A}.jsonl`));
    await watcher.dispose();
    time.advance(10_000);
    await settle();

    expect(batches).toHaveLength(1);
  });

  it('never invokes onBatch for a poll that was in flight when dispose ran', async () => {
    const batches: TailBatch[] = [];
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: FIXTURE_WORKSPACE,
      onBatch: (batch) => batches.push(batch),
      projectsRoot: FIXTURE_ROOT,
      watchFactory: fake.factory,
    });
    await watcher.start();
    expect(batches).toHaveLength(1);

    const inFlight = watcher.refresh();
    const disposed = watcher.dispose();
    await Promise.all([inFlight, disposed]);
    await settle();

    expect(batches).toHaveLength(1);
    expect(watcher.diagnostics.polls).toBe(2); // the poll ran; its batch was dropped
  });

  it('ignores fs events that arrive after dispose', async () => {
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: FIXTURE_WORKSPACE,
      onBatch: () => undefined,
      projectsRoot: FIXTURE_ROOT,
      watchFactory: fake.factory,
    });
    await watcher.start();
    const handle = fake.latest();
    await watcher.dispose();

    expect(() => handle.callbacks.onChange('change', 'whatever')).not.toThrow();
    expect(watcher.diagnostics.fsEvents).toBe(0);
    expect(watcher.pendingSignals).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Failure containment (G2/G3)
// ---------------------------------------------------------------------------

describe('ProjectWatcher — failures never escape', () => {
  it('surfaces a missing slug directory as discoveryFailure and does not throw', async () => {
    const root = await makeProjectsRoot(); // exists, but has no slug dir
    const batches: TailBatch[] = [];
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: WORKSPACE,
      onBatch: (batch) => batches.push(batch),
      projectsRoot: root,
      watchFactory: fake.factory,
    });

    await expect(watcher.start()).resolves.toBeUndefined();

    const batch = batches[0];
    if (batch === undefined) throw new Error('no batch');
    expect(batch.discoveryFailure?.kind).toBe('projectSlugNotFound');
    expect(batch.lines).toHaveLength(0);
    const diagnostics = watcher.diagnostics;
    expect(diagnostics.discoveryFailures).toBe(1);
    expect(diagnostics.lastDiscoveryFailure?.kind).toBe('projectSlugNotFound');

    await watcher.dispose();
  });

  it('surfaces a missing projects root as a refusal, not an empty success', async () => {
    const batches: TailBatch[] = [];
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: WORKSPACE,
      onBatch: (batch) => batches.push(batch),
      projectsRoot: join(tmpRoot, 'does-not-exist'),
      watchFactory: fake.factory,
    });
    await watcher.start();
    expect(batches[0]?.discoveryFailure?.kind).toBe('projectsRootNotFound');
    expect(batches[0]?.discoveryFailure?.code).toBe('ENOENT');
    await watcher.dispose();
  });

  it('counts a watcher-level error instead of propagating it', async () => {
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: FIXTURE_WORKSPACE,
      onBatch: () => undefined,
      projectsRoot: FIXTURE_ROOT,
      watchFactory: fake.factory,
    });
    await watcher.start();

    expect(() =>
      fake.latest().callbacks.onError(new Error('EMFILE: too many open files')),
    ).not.toThrow();

    const diagnostics = watcher.diagnostics;
    expect(diagnostics.watchErrors).toBe(1);
    expect(diagnostics.lastWatchError).toContain('EMFILE');
    // Still usable: the JSONL side keeps working when the watcher complains.
    await watcher.refresh();
    expect(watcher.diagnostics.polls).toBe(2);

    await watcher.dispose();
  });

  it('still reads on start when the watch factory itself throws', async () => {
    const batches: TailBatch[] = [];
    const watcher = new ProjectWatcher({
      workspacePath: FIXTURE_WORKSPACE,
      onBatch: (batch) => batches.push(batch),
      projectsRoot: FIXTURE_ROOT,
      watchFactory: fakeWatchFactory({ throwOnCreate: new Error('ENOSPC: watch limit') })
        .factory,
    });

    await expect(watcher.start()).resolves.toBeUndefined();

    expect(watcher.diagnostics.watchErrors).toBe(1);
    expect(watcher.diagnostics.lastWatchError).toContain('ENOSPC');
    expect(batches).toHaveLength(1);
    expect(batches[0]?.lines.length).toBeGreaterThan(0);

    await watcher.dispose();
  });

  it('contains a throwing onBatch callback and keeps polling', async () => {
    let calls = 0;
    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: FIXTURE_WORKSPACE,
      onBatch: () => {
        calls += 1;
        throw new Error('renderer blew up');
      },
      projectsRoot: FIXTURE_ROOT,
      watchFactory: fake.factory,
    });

    await expect(watcher.start()).resolves.toBeUndefined();
    await watcher.refresh();

    expect(calls).toBe(2);
    expect(watcher.diagnostics.callbackErrors).toBe(2);
    expect(watcher.diagnostics.batches).toBe(0);
    expect(watcher.diagnostics.lastCallbackError).toContain('renderer blew up');

    await watcher.dispose();
  });
});

// ---------------------------------------------------------------------------
// G1
// ---------------------------------------------------------------------------

describe('ProjectWatcher — read-only (G1)', () => {
  it('leaves the observed tree byte-identical', async () => {
    const before = await snapshotTree(FIXTURE_ROOT);

    const fake = fakeWatchFactory();
    const watcher = new ProjectWatcher({
      workspacePath: FIXTURE_WORKSPACE,
      onBatch: () => undefined,
      projectsRoot: FIXTURE_ROOT,
      watchFactory: fake.factory,
    });
    await watcher.start();
    fake.latest().callbacks.onChange('change', watcher.watchDir);
    await watcher.refresh();
    await watcher.dispose();

    const after = await snapshotTree(FIXTURE_ROOT);
    expect(after).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });

  it('leaves the observed tree byte-identical under real chokidar', async () => {
    const root = await makeProjectsRoot();
    const slugDir = join(root, SLUG);
    await mkdir(join(slugDir, SESSION_A, 'subagents'), { recursive: true });
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user', n: 0 }));
    await writeFile(
      join(slugDir, SESSION_A, 'subagents', 'agent-a1.jsonl'),
      jsonl({ type: 'assistant' }),
    );

    const watcher = new ProjectWatcher({
      workspacePath: WORKSPACE,
      onBatch: () => undefined,
      projectsRoot: root,
      debounceMs: 10,
      watchFactory: createChokidarWatchFactory(),
    });
    await watcher.start();
    const before = await snapshotTree(root);
    await waitUntil(() => watcher.diagnostics.ready, 'chokidar ready');
    await watcher.dispose();
    const after = await snapshotTree(root);

    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Real chokidar
// ---------------------------------------------------------------------------

describe('ProjectWatcher — real chokidar', () => {
  it('turns a real append into a batch carrying the appended line', async () => {
    const root = await makeProjectsRoot();
    const slugDir = join(root, SLUG);
    await mkdir(slugDir, { recursive: true });
    const transcript = join(slugDir, `${SESSION_A}.jsonl`);
    await writeFile(transcript, jsonl({ type: 'user', marker: 'initial' }));

    const batches: TailBatch[] = [];
    const watcher = new ProjectWatcher({
      workspacePath: WORKSPACE,
      onBatch: (batch) => batches.push(batch),
      projectsRoot: root,
      debounceMs: 20,
      maxWaitMs: 200,
      watchFactory: createChokidarWatchFactory({ usePolling: true, pollIntervalMs: 20 }),
    });

    try {
      await watcher.start();
      expect(batches).toHaveLength(1);
      await waitUntil(() => watcher.diagnostics.ready, 'chokidar ready');

      await appendFile(transcript, jsonl({ type: 'assistant', marker: 'appended' }));

      await waitUntil(
        () => batches.slice(1).some((b) => b.lines.some((l) => l.text.includes('appended'))),
        'a batch carrying the appended line',
      );
      expect(watcher.diagnostics.fsEvents).toBeGreaterThan(0);
    } finally {
      await watcher.dispose();
    }
  });

  it('picks up a subagent transcript created after start (depth 2)', async () => {
    const root = await makeProjectsRoot();
    const slugDir = join(root, SLUG);
    await mkdir(slugDir, { recursive: true });
    const transcript = join(slugDir, `${SESSION_A}.jsonl`);
    await writeFile(transcript, jsonl({ type: 'user' }));

    const batches: TailBatch[] = [];
    const watcher = new ProjectWatcher({
      workspacePath: WORKSPACE,
      onBatch: (batch) => batches.push(batch),
      projectsRoot: root,
      debounceMs: 20,
      maxWaitMs: 200,
      watchFactory: createChokidarWatchFactory({ usePolling: true, pollIntervalMs: 20 }),
    });

    try {
      await watcher.start();
      await waitUntil(() => watcher.diagnostics.ready, 'chokidar ready');

      await mkdir(join(slugDir, SESSION_A, 'subagents'), { recursive: true });
      await writeFile(
        join(slugDir, SESSION_A, 'subagents', 'agent-a99.jsonl'),
        jsonl({ type: 'assistant', marker: 'from-subagent' }),
      );

      await waitUntil(
        () => batches.some((b) => b.lines.some((l) => l.text.includes('from-subagent'))),
        'a batch carrying the subagent line',
      );
      expect(watcher.trackedFiles().some((p) => p.includes('agent-a99.jsonl'))).toBe(true);
    } finally {
      await watcher.dispose();
    }
  });

  it('closes the real chokidar watcher on dispose', async () => {
    const root = await makeProjectsRoot();
    await mkdir(join(root, SLUG), { recursive: true });
    await writeFile(join(root, SLUG, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    const watcher = new ProjectWatcher({
      workspacePath: WORKSPACE,
      onBatch: () => undefined,
      projectsRoot: root,
      debounceMs: DEFAULT_DEBOUNCE_MS,
      watchFactory: createChokidarWatchFactory({ usePolling: true, pollIntervalMs: 20 }),
    });
    await watcher.start();
    await waitUntil(() => watcher.diagnostics.ready, 'chokidar ready');
    await watcher.dispose();

    // If this left a handle open, vitest would hang rather than fail; the
    // assertion below is the cheap half of the check.
    expect(watcher.diagnostics.disposed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v0.7.0 DoD 1b.10 — the slug directory that does not exist yet
// ---------------------------------------------------------------------------
//
// FOUND BY THE 1b.8 LIVE SMOKE, 2026-09-07, and neither half was visible to
// any test here because every fixture corpus is a slug directory that already
// exists.
//
// The user opened a second window on a repo Claude Code had never run in.
// Activation was 13:14:35Z; CC created the project directory at 13:17Z, when
// /init first ran a Bash tool. The deck showed cc=0 for five minutes and
// would have shown it forever.
//
// TWO INDEPENDENT CAUSES, each fatal on its own:
//
//   D1  the watcher watches <projectsRoot>/<slug>, and chokidar given a path
//       that does not exist reports nothing and does not begin reporting when
//       it appears. The only other poll trigger is an fs event on that same
//       absent path, and the host tick calls pump() and never refresh(). So
//       there is exactly ONE discovery attempt per window, at activation.
//
//   D1b the slug encoder replaced the separators and NOT spaces, while CC
//       replaces spaces too. Measured against the real directory: ours ended
//       the workspace name with its spaces INTACT, while CC had written
//       the same name with its spaces as DASHES. No match, exact or
//       case-insensitive, so that window was watching a path that could
//       never exist.

describe('1b.10 — a slug directory created AFTER activation', () => {
  /*
   * DRIVEN THROUGH THE INJECTION SEAM, NOT THROUGH REAL CHOKIDAR.
   * Changed 2026-09-07 (Phase 1c) after this test failed in 8 of 30 recorded
   * runs across two commits.
   *
   * It used to arm the REAL watcher — `usePolling: true, pollIntervalMs: 20`,
   * on a real temp directory — and wait up to 25 s for a real fs event. It was
   * the ONLY test in this file that did, while `fakeWatchFactory` sits at the
   * top of the file for exactly this purpose. Every recorded failure reported
   * `0 fsEvents, 0 lateAttachments`: on a loaded machine chokidar's initial
   * scan had not completed inside the deadline, so the product was never
   * reached and the run went red for a reason with no product in it. That is
   * this repository's recorded "a test that passes or fails by CPU load" class,
   * and the rule it carries is that such a failure is a defect report about the
   * TEST.
   *
   * THE DEADLINES BELOW ARE UNCHANGED, deliberately. They were never what was
   * wrong, and raising them would have hidden this instead of fixing it. They
   * are simply never approached now.
   *
   * TWO ARMS, because production says there are exactly two cases and no third.
   * chokidar runs `ignoreInitial: true`, so a slug directory that already
   * exists when the root watch becomes ready is absorbed into the initial scan
   * and NEVER reported — that case is caught only by the `onReady` re-check,
   * which is the line `#armRootWatch` exists to justify. One created after
   * ready arrives as an ordinary event. Driving both is strictly more than the
   * old test did: it could only ever exercise whichever case the machine
   * happened to produce, and it could not tell you which.
   *
   * The mutations this test exists for are untouched and still fatal: removing
   * the root watch, and removing the `onReady` re-check, each make discovery
   * never happen in the arm that covers them.
   */
  interface Arm {
    readonly name: string;
    readonly drive: (rootWatcher: FakeWatcher, createSlug: () => Promise<void>) => Promise<void>;
  }

  const ARMS: readonly Arm[] = [
    {
      name: 'created BEFORE the root watch is ready — the onReady re-check catches it',
      drive: async (rootWatcher, createSlug) => {
        await createSlug();
        rootWatcher.callbacks.onReady();
      },
    },
    {
      name: 'created AFTER the root watch is ready — the event catches it',
      drive: async (rootWatcher, createSlug) => {
        // Ready first, with nothing there. The re-check must find nothing and
        // must NOT count a late attachment; the assertion below pins that.
        rootWatcher.callbacks.onReady();
        await createSlug();
        // The path is deliberately not the slug directory: `#onRootEvent` asks
        // the filesystem whether ITS path exists rather than matching the
        // event's path, because chokidar's paths differ across platforms.
        rootWatcher.callbacks.onChange('addDir', 'a path this watcher never reads');
      },
    },
  ];

  it.each(ARMS)('discovers the session on the next poll (D1): $name', async ({ drive }) => {
    const root = await makeProjectsRoot();
    // The slug directory is deliberately NOT created. That is the ordinary
    // state of a repository Claude Code has not run in yet.
    const slugDir = join(root, SLUG);

    const fake = fakeWatchFactory();
    const batches: TailBatch[] = [];
    const watcher = new ProjectWatcher({
      workspacePath: WORKSPACE,
      onBatch: (batch) => {
        batches.push(batch);
      },
      env: { CLAUDE_PROJECTS_ROOT: root },
      homedir: () => 'c:\\nowhere',
      watchFactory: fake.factory,
      debounceMs: 20,
    });

    try {
      await watcher.start();
      // The activation poll found nothing, which is correct and is not the
      // defect: there was nothing there to find.
      const atStart = batches.length;
      expect(watcher.diagnostics.discoveryFailures).toBeGreaterThan(0);

      // What `start()` armed is the ROOT watch, on the projects root — asserted
      // rather than assumed, because driving the wrong watcher would make every
      // arm below vacuous while still looking like it drove something.
      expect(fake.watchers).toHaveLength(1);
      const rootWatcher = fake.latest();
      expect(rootWatcher.dir).toBe(root);
      expect(watcher.diagnostics.lateAttachments).toBe(0);

      // Now Claude Code starts, exactly as it did in the smoke.
      await drive(rootWatcher, async () => {
        await mkdir(slugDir, { recursive: true });
        await writeFile(
          join(slugDir, SESSION_A + '.jsonl'),
          jsonl({
            type: 'user',
            uuid: '11111111-1111-4111-8111-111111111111',
            sessionId: SESSION_A,
            version: '2.1.234',
            timestamp: '2026-09-07T13:17:00.000Z',
            cwd: WORKSPACE,
            message: { role: 'user', content: 'hello' },
          }),
          'utf8',
        );
      });

      // Bounded rather than slept on. The ceiling is a LIVENESS bound — "did
      // it happen at all" — and NOT a performance claim.
      //
      // IT WAS RAISED FROM 5 s TO 25 s ONCE, AND THAT WAS TREATING THE SYMPTOM.
      // The history is kept because it is the more useful half: the raise was
      // argued for on the grounds that a liveness ceiling is not a budget,
      // which is true, and it still did not work — the test went on failing in
      // 8 of 30 runs because no ceiling rescues a real fs event that never
      // arrives. Phase 1c removed the race instead and left the number alone.
      //
      // All that remains behind this deadline is the debouncer's 20 ms, so if
      // it is ever approached again something is genuinely wrong.
      const deadline = Date.now() + 25_000;
      for (;;) {
        if (batches.slice(atStart).some((x) => x.newFiles.length > 0)) break;
        if (Date.now() > deadline) {
          throw new Error(
            'the slug directory was created after activation and was never discovered: ' +
              String(batches.length - atStart) + ' batches since, ' +
              String(watcher.diagnostics.discoveryFailures) + ' discovery failures, ' +
              String(watcher.diagnostics.fsEvents) + ' fsEvents, ' +
              String(watcher.diagnostics.lateAttachments) + ' lateAttachments, ' +
              String(watcher.diagnostics.watchErrors) + ' watchErrors ' +
              String(watcher.diagnostics.lastWatchError ?? ''),
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      const discovered = batches.slice(atStart).flatMap((x) => x.newFiles);
      expect(discovered.some((f) => f.includes(SESSION_A))).toBe(true);
      // The switch is OBSERVABLE, not merely effective: a window whose deck
      // filled late says so, and a counter nothing reads is a counter that can
      // be wrong forever.
      expect(watcher.diagnostics.lateAttachments).toBe(1);

      // AND THE HANDOVER ACTUALLY HAPPENED, which the old test could not see at
      // all. The root watch is narrow and temporary by design — it is closed
      // the instant the real one is armed, because the projects root holds a
      // directory per workspace on the machine and this window has business
      // with exactly one. A version that discovered the session and left the
      // root watch open would have passed every assertion above.
      expect(rootWatcher.closed).toBe(true);
      expect(fake.watchers).toHaveLength(2);
      expect(fake.latest().dir).toBe(slugDir);
    } finally {
      await watcher.dispose();
    }
  }, 30_000);
});

describe('1b.10 — the slug encoder and a workspace path with spaces (D1b)', () => {
  /*
   * THE WITNESS IS A REAL DIRECTORY, AND IT IS NOT THIS PATH.
   *
   * Measured on the user's machine 2026-09-07, during the 1b.8 smoke: the
   * directory Claude Code created for a real workspace path containing two
   * spaces had written both of them as dashes. **The real pair is not
   * reproduced here** — it carries developer identity, which the privacy sweep
   * refuses under `src/` and which no allow rule covers for a project slug —
   * so it lives in the phase-1b lab evidence and this test carries a synthetic
   * pair with the identical shape.
   *
   * That single real directory is the whole evidence for the space rule, and
   * it is ONE witness — so the rule asserted here is exactly what it shows (a
   * space becomes a dash) and nothing wider. A future capture that contradicts
   * it turns this red, which is the signal to re-measure rather than to widen
   * the class quietly.
   *
   * `fixtures/synthetic-path-matrix/slug-cases.json` carried the opposite
   * expectation until this date, with a note saying in as many words that it
   * was NOT witnessed from a CC capture. It was honest and it was wrong; the
   * smoke supplied the witness it said it lacked.
   */
  const SPACED_WORKSPACE = 'C:\\Users\\dev\\Documents\\Two Word Repo';
  const CC_ACTUAL = 'c--Users-dev-Documents-Two-Word-Repo';

  it('equals the directory Claude Code actually made', () => {
    // Case-insensitively: the drive letter case varies between CC versions,
    // and both spellings occur in this repository own history.
    expect(slugifyWorkspace(SPACED_WORKSPACE).toLowerCase()).toBe(CC_ACTUAL.toLowerCase());
  });

  it('leaves no space in a slug, and moves no slug that had none', () => {
    expect(slugifyWorkspace(SPACED_WORKSPACE)).not.toMatch(/ /);
    // THE CONTROL, and it is the assertion that keeps the change narrow:
    // every corpus this repository has captured is a spaceless path, and not
    // one of their slugs may move.
    expect(slugifyWorkspace('c:\\Users\\dev\\projects\\agent-deck')).toBe(
      'c--Users-dev-projects-agent-deck',
    );
    expect(slugifyWorkspace(WORKSPACE)).toBe(SLUG);
  });

  it('agrees with CC even where CC own encoding is lossy', () => {
    // Guards the direction nobody thinks about: two genuinely different
    // workspaces CAN collide under this encoding, and that is correct
    // because it is the collision CC itself makes when it picks a project
    // directory. Agreeing with CC is the behaviour; a wider collapse is not.
    expect(slugifyWorkspace('c:\\ws\\a b')).toBe(slugifyWorkspace('c:\\ws\\a-b'));
  });
});
