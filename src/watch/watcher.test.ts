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
      watchFactory: createChokidarWatchFactory({ usePolling: true, pollIntervalMs: 20 }),
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
