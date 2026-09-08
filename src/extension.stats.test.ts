/**
 * The stats wiring — v0.7.0 Phase 3, DoD 3.2b, 3.3b, 3.5 and 3.7.
 *
 * A file of its own rather than more of `src/extension.test.ts`, which is
 * already 4,000 lines: everything here is about ONE seam — emissions in,
 * records on disk — and a reader looking for why a record was or was not
 * written should not have to find it among the port, panel and correlation
 * suites.
 *
 * ## Real states, a manual clock, real files
 *
 * The subjects are `SessionState`s from the committed Claude Code corpus, read
 * through the production path by `corpus.testkit.ts`, with `liveness` set by
 * the test. That is the one field these tests own, and they own it because the
 * corpus cannot supply both arms: every committed session is finished, so a
 * "none before `ended`" assertion needs a state that has not ended yet, and
 * manufacturing one from a real session is honest in a way a hand-built tree
 * would not be — every other field is what the engine produced.
 *
 * `ManualTime` supplies both the clock and the scheduler, so an hour of silence
 * is `advance(3_600_000)` and `derivedAt` is whatever the test says it is.
 * Nothing here sleeps and nothing here reads a wall clock.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { mock, resetVscodeMock } from '../test/vscode-mock.js';

import type { SessionState } from './model/events.js';
import { ManualTime } from './parser/tailer.js';
import type { SessionEmission } from './model/session.js';
import { CORPUS_READ_BUDGET_MS, readCcSessions, warmCorpus } from './stats/corpus.testkit.js';
import { STORE_DIR_NAME, StatsStore, resolveStoreDir } from './stats/store.js';
import { parsePricing } from './stats/pricing.js';
import {
  CLEAR_STATS_COMMAND,
  CLEAR_STATS_CONFIRM,
  CLEAR_STATS_PROMPT,
  DEFAULT_STATS_IDLE_FLUSH_MS,
  StatsPipeline,
  activate,
  deactivate,
} from './extension.js';

// ---------------------------------------------------------------------------
// Scratch
// ---------------------------------------------------------------------------

const scratch: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-deck-wiring-'));
  scratch.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

const START = Date.parse('2026-09-08T10:00:00.000Z');

let corpus: readonly SessionState[];

beforeAll(async () => {
  await warmCorpus();
  corpus = await readCcSessions();
  expect(corpus.length, 'no Claude Code session to drive the pipeline with').toBeGreaterThan(0);
}, CORPUS_READ_BUDGET_MS);

/**
 * A real corpus session with `liveness` set, and optionally a nudged tree.
 *
 * The testkit's states are deep-frozen, so this clones first — which is what
 * the testkit's header tells a mutating caller to do, and it is said here
 * rather than assumed.
 */
function subject(index: number, liveness: SessionState['liveness'], tweak = 0): SessionState {
  const state = structuredClone(corpus[index % corpus.length]) as SessionState;
  const mutable = state as unknown as Record<string, unknown>;
  mutable['liveness'] = liveness;
  if (tweak !== 0) {
    // A change that reaches the RECORD, which is what the pipeline's
    // "did a patch arrive?" test reads. Token totals are on every record and
    // are a number, so a nudge is unambiguous.
    const totals = mutable['totals'] as Record<string, unknown> | undefined;
    if (totals !== undefined) totals['costUsd'] = tweak;
  }
  return state;
}

function emissionOf(...sessions: SessionState[]): SessionEmission {
  return {
    sessions,
    diffs: [],
    addedSessionIds: [],
    removedSessionIds: [],
    schemaMismatchSessionIds: [],
  };
}

interface Harness {
  pipeline: StatsPipeline;
  store: StatsStore;
  dir: string;
  time: ManualTime;
  errors: unknown[];
}

function harness(
  overrides: {
    enabled?: boolean;
    idleFlushMs?: number;
    pricing?: unknown;
    retentionDays?: number;
  } = {},
): Harness {
  const dir = join(tempDir(), STORE_DIR_NAME);
  const time = new ManualTime(START);
  const errors: unknown[] = [];
  const store = new StatsStore({
    dir,
    enabled: overrides.enabled ?? true,
    retentionDays: overrides.retentionDays ?? 90,
    onError: (error) => errors.push(error),
  });
  const parsed = parsePricing(overrides.pricing ?? {});
  const pipeline = new StatsPipeline({
    store,
    pricing: parsed.table,
    pricingInvalid: parsed.invalid,
    idleFlushMs: overrides.idleFlushMs ?? DEFAULT_STATS_IDLE_FLUSH_MS,
    now: () => time.now(),
    scheduler: time,
    onError: (error) => errors.push(error),
  });
  return { pipeline, store, dir, time, errors };
}

function linesOn(dir: string): string[] {
  const store = new StatsStore({ dir, enabled: true, retentionDays: 3_650 });
  return store
    .files()
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n'))
    .filter((line) => line !== '');
}

// ---------------------------------------------------------------------------
// DoD 3.7 — derive on each patch, append on ended
// ---------------------------------------------------------------------------

describe('DoD 3.7: one record at ended, none before', () => {
  it('writes nothing while a session is live, and exactly one when it ends', () => {
    const h = harness();
    // Several patches while live. Each one derives; none appends.
    h.pipeline.observe(emissionOf(subject(0, 'live')));
    h.time.advance(1_000);
    h.pipeline.observe(emissionOf(subject(0, 'live', 1)));
    h.time.advance(1_000);
    h.pipeline.observe(emissionOf(subject(0, 'idle', 2)));
    expect(h.store.appended, 'a record was written before the session ended').toBe(0);
    expect(h.store.files()).toStrictEqual([]);

    h.time.advance(1_000);
    h.pipeline.observe(emissionOf(subject(0, 'ended', 2)));
    expect(h.store.appended).toBe(1);
    expect(linesOn(h.dir)).toHaveLength(1);
  });

  it('twenty pumps over an ended session write ONE line, not twenty', () => {
    // The deck pumps on a 5 s liveness tick whether or not anything changed, so
    // idempotence is not a nicety here — without it a finished session would
    // gain a record every five seconds for as long as the window stayed open.
    const h = harness();
    for (let i = 0; i < 20; i += 1) {
      h.time.advance(5_000);
      h.pipeline.observe(emissionOf(subject(0, 'ended')));
    }
    expect(h.store.appended).toBe(1);
    expect(linesOn(h.dir)).toHaveLength(1);
  });

  it('every session in an emission gets its own record', () => {
    const h = harness();
    const distinct = Math.min(3, corpus.length);
    h.pipeline.observe(
      emissionOf(...Array.from({ length: distinct }, (_, i) => subject(i, 'ended'))),
    );
    const ids = new Set(
      linesOn(h.dir).map((line) => (JSON.parse(line) as { sessionId: string }).sessionId),
    );
    expect(ids.size).toBe(new Set(Array.from({ length: distinct }, (_, i) => corpus[i]?.sessionId)).size);
  });

  it('the record carries derivedAt from the injected clock, and nothing else added', () => {
    const h = harness();
    h.time.advance(12_345);
    h.pipeline.observe(emissionOf(subject(0, 'ended')));
    const [line] = linesOn(h.dir);
    expect(line).toBeDefined();
    const written = JSON.parse(line ?? '{}') as { derivedAt: number; sessionId: string };
    expect(written.derivedAt).toBe(START + 12_345);
    expect(written.sessionId).toBe(corpus[0]?.sessionId);
  });
});

// ---------------------------------------------------------------------------
// DoD 3.2b — idle flush and supersede
// ---------------------------------------------------------------------------

describe('DoD 3.2b: idle flush, supersede, and timer disposal', () => {
  it('patch, then an hour of silence, writes exactly one record', () => {
    const h = harness();
    h.pipeline.observe(emissionOf(subject(0, 'live')));
    expect(h.store.appended).toBe(0);
    expect(h.pipeline.armedTimers).toBe(1);

    // One millisecond short of the flush: still nothing.
    h.time.advance(DEFAULT_STATS_IDLE_FLUSH_MS - 1);
    expect(h.store.appended, 'flushed before the idle window elapsed').toBe(0);

    h.time.advance(1);
    expect(h.store.appended).toBe(1);
    expect(h.pipeline.idleFlushes).toBe(1);
    expect(h.pipeline.armedTimers, 'the timer re-armed itself after firing').toBe(0);
  });

  it('a further patch supersedes: two lines, one read, the later derivedAt', () => {
    const h = harness();

    // 1. A patch, then an hour of silence -> the first record.
    h.pipeline.observe(emissionOf(subject(0, 'live')));
    h.time.advance(DEFAULT_STATS_IDLE_FLUSH_MS);
    expect(h.store.appended).toBe(1);
    const firstAt = h.time.now();

    // 2. The session resumes and then ends -> a SECOND record.
    h.time.advance(60_000);
    h.pipeline.observe(emissionOf(subject(0, 'live', 7)));
    h.time.advance(60_000);
    h.pipeline.observe(emissionOf(subject(0, 'ended', 7)));
    const secondAt = h.time.now();
    expect(h.store.appended).toBe(2);
    expect(secondAt).toBeGreaterThan(firstAt);

    // THE FILE HOLDS TWO LINES: nothing on disk is ever rewritten.
    const lines = linesOn(h.dir);
    expect(lines).toHaveLength(2);
    const stamps = lines.map((l) => (JSON.parse(l) as { derivedAt: number }).derivedAt);
    expect(stamps).toStrictEqual([firstAt, secondAt]);

    // AND THE READ RETURNS EXACTLY ONE, the later one.
    const read = h.store.readRecords();
    expect(read).toHaveLength(1);
    expect(read[0]?.derivedAt).toBe(secondAt);
    expect(read[0]?.sessionId).toBe(corpus[0]?.sessionId);
  });

  it('reaching ended disposes the idle timer', () => {
    const h = harness();
    h.pipeline.observe(emissionOf(subject(0, 'live')));
    expect(h.pipeline.armedTimers).toBe(1);
    h.pipeline.observe(emissionOf(subject(0, 'ended')));
    expect(h.pipeline.armedTimers).toBe(0);
    expect(h.time.pendingTimers).toBe(0);

    // And the disposed timer really is gone: an hour later, still one record.
    h.time.advance(DEFAULT_STATS_IDLE_FLUSH_MS * 2);
    expect(h.store.appended).toBe(1);
  });

  it('dispose() drops every timer and flushes nothing', () => {
    const h = harness();
    h.pipeline.observe(emissionOf(subject(0, 'live'), subject(1, 'live')));
    expect(h.pipeline.armedTimers).toBeGreaterThan(0);
    h.pipeline.dispose();
    expect(h.pipeline.armedTimers).toBe(0);
    expect(h.time.pendingTimers, 'a timer survived dispose()').toBe(0);
    // A window closing is not evidence that a session ended, so teardown
    // writes nothing. See the reasoning on `StatsPipeline.dispose`.
    expect(h.store.appended).toBe(0);
    // And a post-dispose emission is inert.
    h.pipeline.observe(emissionOf(subject(0, 'ended')));
    expect(h.store.appended).toBe(0);
  });

  it('an unchanged session does not restart the idle countdown', () => {
    /*
     * THE CASE THAT DECIDES THE DESIGN. The host pumps every 5 s from the
     * liveness tick with nothing changed. A timer rearmed on every emission
     * would be pushed forward forever and the idle flush would never fire —
     * i.e. the trigger that exists for the session that never reaches `ended`
     * would never fire for exactly that session.
     */
    // A pump every 5 s, the host's real liveness tick, for TWICE the idle
    // window. The total elapsed time is what makes the assertion mean
    // anything, so it is computed from the window rather than from a step
    // count — the first draft ran 100 steps of one two-hundredth of the window
    // and covered only half of it, so the flush had not fired for an ordinary
    // arithmetic reason rather than because the timer was being pushed
    // forward, and the test would have gone green on either behaviour.
    const TICK = 5_000;
    /*
     * A SHORT WINDOW, PUMPED AT THE HOST'S REAL RATE.
     *
     * The property is "an unchanged pump does not restart the countdown", and
     * nothing about it depends on the window being an hour. Driving the
     * SHIPPED hour at the real 5 s tick is 1,440 iterations, each one a
     * `structuredClone` of a real corpus session plus a full `deriveStats`
     * plus a `JSON.stringify` — seconds of work to prove something the
     * manifest's own minimum window proves in twenty-four.
     *
     * So the window is the minimum the manifest admits and the TICK is the
     * real one, which keeps the ratio between them realistic — a test that
     * shrank the tick instead would be pumping at a rate the host never uses.
     */
    const WINDOW = 60_000;
    const STEPS = Math.ceil((WINDOW * 2) / TICK);
    expect(STEPS * TICK).toBeGreaterThan(WINDOW);

    const h = harness({ idleFlushMs: WINDOW });
    h.pipeline.observe(emissionOf(subject(0, 'live')));
    for (let i = 0; i < STEPS; i += 1) {
      h.time.advance(TICK);
      h.pipeline.observe(emissionOf(subject(0, 'live')));
    }
    expect(h.pipeline.idleFlushes, 'the idle flush never fired under a steady pump').toBe(1);

    // The control on the other side: a CHANGED state DOES restart it, so the
    // flush above is the timer surviving unchanged pumps and not the timer
    // simply ignoring `observe`.
    const g = harness({ idleFlushMs: WINDOW });
    g.pipeline.observe(emissionOf(subject(0, 'live')));
    for (let i = 0; i < STEPS; i += 1) {
      g.time.advance(TICK);
      g.pipeline.observe(emissionOf(subject(0, 'live', i + 1)));
    }
    expect(g.pipeline.idleFlushes, 'a changing session flushed anyway').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DoD 3.4 — the pipeline over a disabled store
// ---------------------------------------------------------------------------

describe('DoD 3.4: with the store disabled the pipeline writes nothing at all', () => {
  it('no file, no directory, and the deck path is untouched', () => {
    const h = harness({ enabled: false });
    h.pipeline.observe(emissionOf(subject(0, 'live')));
    h.time.advance(DEFAULT_STATS_IDLE_FLUSH_MS * 2);
    h.pipeline.observe(emissionOf(subject(0, 'ended')));
    expect(h.store.appended).toBe(0);
    expect(h.store.readRecords()).toStrictEqual([]);
    expect(() => statSync(h.dir)).toThrow();
    expect(h.errors).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// G2 — a deriver failure is counted and skipped
// ---------------------------------------------------------------------------

describe('G2: a deriver failure is counted and skipped, never propagated', () => {
  it('a state the deriver throws on increments statsErrors and does not stop the rest', () => {
    const h = harness();
    // A state whose `root` is missing: `deriveStats` walks the tree, so this
    // throws inside the deriver rather than being refused by the store — the
    // two failure modes are different and both count.
    const broken = structuredClone(corpus[0]) as unknown as Record<string, unknown>;
    delete broken['root'];

    const good = subject(1 % corpus.length, 'ended', 3);
    h.pipeline.observe(emissionOf(broken as unknown as SessionState, good));

    expect(h.pipeline.errors).toBeGreaterThan(0);
    // The session AFTER the broken one still produced its record: the skip is
    // per session, not per emission.
    expect(h.store.appended).toBe(1);
    expect(linesOn(h.dir)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DoD 3.3b — pricing
// ---------------------------------------------------------------------------

describe('DoD 3.3b: agentDeck.pricing reaches the deriver, and a bad entry is reported', () => {
  it('a valid entry is parsed and handed to deriveStats', () => {
    const model = 'claude-sonnet-4-5';
    const parsed = parsePricing({
      [model]: { prompt: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
    });
    expect(parsed.invalid).toStrictEqual([]);
    expect(parsed.table.get(model)).toStrictEqual({
      prompt: 3,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      output: 15,
    });
  });

  it('an invalid entry is dropped and NAMED, never repaired', () => {
    const parsed = parsePricing({
      good: { prompt: 1, cacheRead: 1, cacheWrite: 1, output: 1 },
      'missing-output': { prompt: 1, cacheRead: 1, cacheWrite: 1 },
      'negative-price': { prompt: -1, cacheRead: 1, cacheWrite: 1, output: 1 },
      'not-an-object': 7,
    });
    expect([...parsed.table.keys()]).toStrictEqual(['good']);
    expect(parsed.invalid).toStrictEqual(['missing-output', 'negative-price', 'not-an-object']);
  });

  it('a priced session reaches the store with a user-sourced cost', () => {
    // End to end through the pipeline rather than through `parsePricing`
    // alone: what the DoD asks is that the setting REACHES `deriveStats`, and
    // the only proof of that is a record that could not have been produced
    // without it.
    const models = new Set<string>();
    const walk = (node: { model?: string; children?: unknown[] }): void => {
      if (typeof node.model === 'string') models.add(node.model);
      for (const child of node.children ?? []) {
        walk(child as { model?: string; children?: unknown[] });
      }
    };
    let index = -1;
    for (let i = 0; i < corpus.length; i += 1) {
      models.clear();
      walk(corpus[i]?.root as unknown as { model?: string; children?: unknown[] });
      if (models.size > 0) {
        index = i;
        break;
      }
    }
    // If no committed session states a model id, this test has nothing to
    // measure and says so rather than passing quietly.
    expect(index, 'no committed Claude Code session carries a model id').toBeGreaterThanOrEqual(0);

    const priced = Object.fromEntries(
      [...models].map((id) => [id, { prompt: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 }]),
    );
    const withPrices = harness({ pricing: priced });
    withPrices.pipeline.observe(emissionOf(subject(index, 'ended')));
    const priced1 = JSON.parse(linesOn(withPrices.dir)[0] ?? '{}') as {
      totals: { costUsd?: number; costSource?: string };
    };

    // AND THE CONTROL: the same session with an EMPTY price table produces no
    // cost. Without this the assertion above would pass on a record that
    // carried a cost from somewhere else entirely.
    const without = harness();
    without.pipeline.observe(emissionOf(subject(index, 'ended')));
    const unpriced = JSON.parse(linesOn(without.dir)[0] ?? '{}') as {
      totals: { costUsd?: number; costSource?: string };
    };

    expect(unpriced.totals.costSource).toBeUndefined();
    expect(priced1.totals.costSource).toBe('user');
    expect(priced1.totals.costUsd).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DoD 3.5 — the clear command
// ---------------------------------------------------------------------------

describe('DoD 3.5: Clear Stats History is a modal command, and cancel means cancel', () => {
  let globalStorage: string;

  beforeEach(() => {
    resetVscodeMock();
    globalStorage = tempDir();
    // No workspace folder: activation stops before the data path, which is the
    // point — the command must exist in a window that observes nothing,
    // because the history is per MACHINE and that is the window a user opens
    // to tidy up.
    mock.setWorkspaceFolder(undefined);
  });

  afterAll(async () => {
    await deactivate();
  });

  /** Activate, and seed a real history under the context's global storage. */
  async function activateWithHistory(): Promise<{ dir: string }> {
    const context = {
      subscriptions: [],
      extensionUri: { fsPath: '/ext', scheme: 'file' },
      globalStorageUri: { fsPath: globalStorage },
    };
    await activate(context as unknown as Parameters<typeof activate>[0]);
    const dir = resolveStoreDir({ globalStorageUri: { fsPath: globalStorage } });
    const h = harness();
    // Seed through a store pointed at the REAL resolved directory, so the
    // command is clearing what production would have written rather than a
    // directory this test invented.
    const seeded = new StatsStore({ dir, enabled: true, retentionDays: 90 });
    h.pipeline.observe(emissionOf(subject(0, 'ended')));
    for (const record of h.store.readRecords()) seeded.appendRecord(record);
    expect(seeded.readRecords().length).toBeGreaterThan(0);
    return { dir };
  }

  it('registers the command, even in a window with no workspace', async () => {
    await activateWithHistory();
    expect(mock.hasCommand(CLEAR_STATS_COMMAND)).toBe(true);
  });

  it('asks with a MODAL carrying one destructive button', async () => {
    await activateWithHistory();
    mock.answerWarningWith(undefined);
    await mock.runCommand(CLEAR_STATS_COMMAND);
    expect(mock.warningMessages).toHaveLength(1);
    const asked = mock.warningMessages[0];
    // `modal: true` is the whole difference between a confirmation and a toast
    // a user can miss. Asserted, not assumed.
    expect(asked?.modal).toBe(true);
    expect(asked?.message).toBe(CLEAR_STATS_PROMPT);
    expect(asked?.items).toStrictEqual([CLEAR_STATS_CONFIRM]);
  });

  it('confirm removes the directory', async () => {
    const { dir } = await activateWithHistory();
    mock.answerWarningWith(CLEAR_STATS_CONFIRM);
    await mock.runCommand(CLEAR_STATS_COMMAND);
    expect(() => statSync(dir), 'the store directory survived a confirmed clear').toThrow();
  });

  it('cancel leaves everything — and every non-answer is a cancel', async () => {
    for (const answer of [undefined, 'Cancel', 'delete history', '']) {
      resetVscodeMock();
      mock.setWorkspaceFolder(undefined);
      globalStorage = tempDir();
      const { dir } = await activateWithHistory();
      const before = new StatsStore({ dir, enabled: true, retentionDays: 90 }).readRecords();
      expect(before.length).toBeGreaterThan(0);

      mock.answerWarningWith(answer as string | undefined);
      await mock.runCommand(CLEAR_STATS_COMMAND);

      const after = new StatsStore({ dir, enabled: true, retentionDays: 90 }).readRecords();
      expect(after, `answer ${JSON.stringify(answer)} deleted the history`).toStrictEqual(before);
      await deactivate();
    }
  });
});
