/**
 * The extension API — v0.7.0 DoD 5.1 (shape, validation, no leak) and DoD 5.2
 * (the throttle law, on a faked clock).
 *
 * The subjects are REAL records: every committed golden under
 * `fixtures/golden/stats/`, all three engines, read off disk. The live getter
 * is fed them as the pipeline would hold them; the stored getter reads them back
 * out of a real `StatsStore` in a temp directory, so both getters are asserted
 * over what production actually produces rather than over hand-built objects.
 *
 * The END-TO-END half — `activate()` returns this object, and the host's
 * pipeline feeds its event — is in `extension.test.ts`, beside the activation
 * machinery it needs. This file is the module's own contract.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, ToolNode } from './model/events.js';
import { ManualTime } from './parser/tailer.js';
import type { StatsRecord } from './stats/schema.js';
import { validateStatsRecord } from './stats/schema.js';
import { STORE_DIR_NAME, StatsStore } from './stats/store.js';
import type { StoredStatsRecord } from './stats/store.js';
import { STATS_GOLDEN_DIR } from './stats/corpus.stats.testkit.js';

import {
  API_VERSION,
  LIVE_EVENT_MIN_INTERVAL_MS,
  MODEL_ONLY_KEYS,
  MODEL_SHARED_KEYS,
  StatsUpdateEmitter,
  createAgentDeckApi,
  modelKeyIn,
  refusalOf,
} from './api.js';
import type { AgentDeckApi, ApiSources } from './api.js';

// ---------------------------------------------------------------------------
// The type-level guards (DoD 5.1: "a type-level `never` guard")
// ---------------------------------------------------------------------------
//
// These are checked by `npm run typecheck`, which covers `src/**/*.ts` test
// files included. A violation is a COMPILE error, not a red test — which is the
// point: a field cannot reach the API's types without somebody editing a list
// here on purpose.

/** Every key reachable in a type, at any depth, through arrays and objects. */
type DeepKeys<T> = T extends readonly (infer U)[]
  ? DeepKeys<U>
  : T extends object
    ? { [K in keyof T & string]-?: K | DeepKeys<NonNullable<T[K]>> }[keyof T & string]
    : never;

/** Resolves to `true` only when `T` is `never`. */
type IsNever<T> = [T] extends [never] ? true : false;

/** Every top-level key of the three model types a record must never carry. */
type ModelKey = keyof SessionState | keyof AgentNode | keyof ToolNode;

/** What the API hands out, from all three doors. */
type LiveRecord = ReturnType<AgentDeckApi['getLiveStats']>[number];
type StoredRecord = Awaited<ReturnType<AgentDeckApi['getStoredStats']>>[number];
type EventRecord = Parameters<Parameters<AgentDeckApi['onDidUpdateStats']>[0]>[0];
type ApiRecordKey = DeepKeys<LiveRecord> | DeepKeys<StoredRecord> | DeepKeys<EventRecord>;

/**
 * (1) THE LISTS COVER EVERY MODEL KEY. A key added to `SessionState`,
 * `AgentNode` or `ToolNode` that is on neither list makes this `false` and the
 * assignment below stops compiling.
 */
type Unlisted = Exclude<
  ModelKey,
  (typeof MODEL_ONLY_KEYS)[number] | (typeof MODEL_SHARED_KEYS)[number]
>;
const everyModelKeyIsListed: IsNever<Unlisted> = true;

/**
 * (2) NO API RECORD CARRIES A MODEL-ONLY KEY, anywhere in its type. A
 * `preview`, a `label`, a `children` or a `usageSeries` reaching
 * `StatsRecord` makes this `false`.
 */
const noModelOnlyKeyInAnyApiRecord: IsNever<Extract<ApiRecordKey, (typeof MODEL_ONLY_KEYS)[number]>> =
  true;

/**
 * (3) NOTHING THE API RETURNS IS A `SessionState`, in either direction of
 * assignability. The key check above is the substantive one; this is the
 * literal reading of "never exposes `SessionState`".
 */
const recordIsNotSessionState: IsNever<Extract<LiveRecord | StoredRecord, SessionState>> = true;
const sessionStateIsNotRecord: SessionState extends LiveRecord ? false : true = true;

/**
 * (4) THE SHARED LIST IS NOT A BACK DOOR. Every key on it really is a key a
 * record carries — so nothing can be moved to "shared" to silence (1) unless
 * the record genuinely has it.
 */
const sharedKeysAreRecordKeys: IsNever<
  Exclude<(typeof MODEL_SHARED_KEYS)[number], DeepKeys<StatsRecord>>
> = true;

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

/** Every committed golden record, all engines. Read, never hard-coded. */
const GOLDENS: StatsRecord[] = readdirSync(STATS_GOLDEN_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(STATS_GOLDEN_DIR, name), 'utf8')) as StatsRecord);

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A real store under a temp directory, holding every golden, stamped. */
function storeOfGoldens(): StatsStore {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-api-'));
  scratch.push(root);
  const store = new StatsStore({ dir: join(root, STORE_DIR_NAME), enabled: true, retentionDays: 3_650 });
  const base = Date.now();
  GOLDENS.forEach((record, i) => {
    store.appendRecord({ ...record, derivedAt: base + i } as StoredStatsRecord);
  });
  return store;
}

function sourcesOver(live: readonly StatsRecord[], store: StatsStore | null): ApiSources {
  return {
    liveRecords: () => live,
    readStored: (query) => (store === null ? [] : store.readRecords(query)),
  };
}

function emitter(time = new ManualTime(1_000_000)): { emitter: StatsUpdateEmitter; time: ManualTime } {
  return { emitter: new StatsUpdateEmitter({ now: () => time.now(), scheduler: time }), time };
}

/** One golden with `sessionId` replaced, for the throttle's per-session law. */
function recordOf(sessionId: string, tweak = 0): StatsRecord {
  const base = structuredClone(GOLDENS[0]) as StatsRecord;
  return { ...base, sessionId, totals: { ...base.totals, prompt: base.totals.prompt + tweak } };
}

// ---------------------------------------------------------------------------
// DoD 5.1 — shape
// ---------------------------------------------------------------------------

describe('DoD 5.1: the API has the shape spec §H names', () => {
  it('the type-level guards are compiled, and all hold', () => {
    // The values are `true` by construction when they compile; asserting them
    // keeps the constants referenced, so a lint rule cannot delete them as
    // unused and take the guards with them.
    expect([
      everyModelKeyIsListed,
      noModelOnlyKeyInAnyApiRecord,
      recordIsNotSessionState,
      sessionStateIsNotRecord,
      sharedKeysAreRecordKeys,
    ]).toStrictEqual([true, true, true, true, true]);
  });

  it('apiVersion 1, two getters and an event — and nothing else', () => {
    const { emitter: e } = emitter();
    const api = createAgentDeckApi(sourcesOver([], null), e);
    expect(api.apiVersion).toBe(1);
    expect(API_VERSION).toBe(1);
    expect(typeof api.getLiveStats).toBe('function');
    expect(typeof api.getStoredStats).toBe('function');
    expect(typeof api.onDidUpdateStats).toBe('function');
    // The EXACT surface, not a containment: a fourth member is a promise to
    // every consumer, and it would arrive without anyone deciding to make it.
    expect(Object.keys(api).sort()).toStrictEqual(
      ['apiVersion', 'getLiveStats', 'getStoredStats', 'onDidUpdateStats'].sort(),
    );
    expect(Object.isFrozen(api)).toBe(true);
  });

  it('the event has the shape of vscode.Event: subscribe, dispose, disposables, thisArgs', () => {
    const { emitter: e } = emitter();
    const api = createAgentDeckApi(sourcesOver([], null), e);
    const bag: { dispose(): unknown }[] = [];
    const seen: string[] = [];
    const owner = { name: 'owner', push(record: StatsRecord): void { seen.push(`${this.name}:${record.sessionId}`); } };
    const sub = api.onDidUpdateStats(function (this: typeof owner, record: StatsRecord) {
      this.push(record);
    }, owner, bag);
    expect(bag).toHaveLength(1);
    e.flushed(recordOf('s1'));
    expect(seen).toStrictEqual(['owner:s1']);
    sub.dispose();
    e.flushed(recordOf('s2'));
    expect(seen).toStrictEqual(['owner:s1']);
    expect(e.listenerCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DoD 5.1 — every record from both getters validates, and none leaks
// ---------------------------------------------------------------------------

describe('DoD 5.1: every record from both getters validates, and no property exposes the model', () => {
  it('THE SUBJECT IS REAL — the goldens span all three engines', () => {
    // Without this the loops below could run over nothing and pass.
    expect(GOLDENS.length).toBeGreaterThan(10);
    expect(new Set(GOLDENS.map((r) => r.engine))).toStrictEqual(new Set(['cc', 'opencode', 'codex']));
  });

  it('getLiveStats: every golden comes back, every one validates, none carries a model key', () => {
    const { emitter: e } = emitter();
    const api = createAgentDeckApi(sourcesOver(GOLDENS, null), e);
    const live = api.getLiveStats();
    expect(live).toHaveLength(GOLDENS.length);
    for (const record of live) {
      expect(validateStatsRecord(record).errors, record.sessionId).toStrictEqual([]);
      expect(modelKeyIn(record), record.sessionId).toBeNull();
    }
    expect(live).toStrictEqual(GOLDENS);
    expect(e.counters.refused).toBe(0);
  });

  it('getStoredStats: every golden round-trips through a real store, and validates', async () => {
    const store = storeOfGoldens();
    const { emitter: e } = emitter();
    const api = createAgentDeckApi(sourcesOver([], store), e);
    const stored = await api.getStoredStats({});
    // Newest per session: the goldens are one record per session, so all of them.
    expect(stored).toHaveLength(new Set(GOLDENS.map((r) => r.sessionId)).size);
    for (const record of stored) {
      expect(validateStatsRecord(record).errors, record.sessionId).toStrictEqual([]);
      expect(modelKeyIn(record), record.sessionId).toBeNull();
      expect(typeof record.derivedAt).toBe('number');
    }
    expect(e.counters.refused).toBe(0);
    // The argument is optional, and an absent one is the same call.
    expect(await api.getStoredStats()).toStrictEqual(stored);
  });

  it('getStoredStats honours sinceMs and limit, through the store', async () => {
    const store = storeOfGoldens();
    const { emitter: e } = emitter();
    const api = createAgentDeckApi(sourcesOver([], store), e);
    const all = await api.getStoredStats();
    expect(await api.getStoredStats({ limit: 3 })).toStrictEqual(all.slice(0, 3));
    const newest = all[0];
    expect(newest).toBeDefined();
    const since = await api.getStoredStats({ sinceMs: newest?.derivedAt ?? 0 });
    expect(since.map((r) => r.sessionId)).toStrictEqual([newest?.sessionId]);
  });

  it('getStoredStats refuses a query it would have to guess about', async () => {
    const { emitter: e } = emitter();
    const api = createAgentDeckApi(sourcesOver([], null), e);
    await expect(api.getStoredStats({ sinceMs: Number.NaN })).rejects.toThrow(TypeError);
    await expect(api.getStoredStats({ limit: -1 })).rejects.toThrow(TypeError);
    await expect(api.getStoredStats({ limit: 1.5 })).rejects.toThrow(TypeError);
    await expect(
      api.getStoredStats(null as unknown as Parameters<AgentDeckApi['getStoredStats']>[0]),
    ).rejects.toThrow(TypeError);
  });

  it('a record carrying a model field is REFUSED at the door — including one the validator passes', () => {
    // THE CASE THAT MAKES THE KEY WALK LOAD-BEARING. `usageSeries` is an
    // `AgentNode` field whose every value is a number, so the G4 validator —
    // which judges strings — passes it. Asserted first, so this test cannot be
    // satisfied by the validator alone.
    const base = GOLDENS[0] as StatsRecord;
    const numericLeak = {
      ...base,
      agents: base.agents.map((a) => ({
        ...a,
        usageSeries: [{ ordinal: 0, input: 1, cacheCreation: 2, cacheRead: 3, output: 4 }],
      })),
    };
    expect(validateStatsRecord(numericLeak).ok, 'the validator passes a numeric model field').toBe(true);
    expect(refusalOf(numericLeak)).toMatch(/usageSeries/);

    // A preview is a string, and the validator alone would have caught it —
    // the walk must still name it rather than depend on the order of checks.
    const previewLeak = { ...base, tools: base.tools.map((t) => ({ ...t, inputPreview: 'rm -rf' })) };
    expect(refusalOf(previewLeak)).not.toBeNull();
    expect(modelKeyIn(previewLeak)).toMatch(/inputPreview/);

    // A SessionState handed in whole is refused.
    const state = { ...base, root: { id: 'root', children: [] }, liveness: 'live' };
    expect(refusalOf(state)).not.toBeNull();

    const { emitter: e } = emitter();
    const reasons: string[] = [];
    const api = createAgentDeckApi(
      sourcesOver([numericLeak, base, previewLeak] as StatsRecord[], null),
      e,
      (reason) => reasons.push(reason),
    );
    const live = api.getLiveStats();
    expect(live.map((r) => r.sessionId)).toStrictEqual([base.sessionId]);
    expect(e.counters.refused).toBe(2);
    expect(reasons).toHaveLength(2);
  });

  it('every model-only key really is a model key, and the walk finds each one', () => {
    // A list entry that no model type carries would be dead weight that looks
    // like a guard; `(1)` above proves completeness, this proves each entry is
    // live by planting it.
    for (const key of MODEL_ONLY_KEYS) {
      expect(modelKeyIn({ a: [{ b: { [key]: 1 } }] }), key).toBe(`a[0].b.${key}`);
    }
    expect(modelKeyIn(GOLDENS)).toBeNull();
  });

  it('hands out COPIES: a consumer mutating a record changes nothing held', async () => {
    const held = [structuredClone(GOLDENS[0]) as StatsRecord];
    const store = storeOfGoldens();
    const { emitter: e } = emitter();
    const api = createAgentDeckApi(sourcesOver(held, store), e);

    const live = api.getLiveStats();
    (live[0] as StatsRecord).totals.prompt = -1;
    (live[0] as StatsRecord).agents.length = 0;
    expect(held[0]).toStrictEqual(GOLDENS[0]);
    expect(api.getLiveStats()).toStrictEqual([GOLDENS[0]]);

    const before = store.readRecords();
    const stored = await api.getStoredStats();
    (stored[0] as StoredStatsRecord).files.length = 0;
    expect(store.readRecords()).toStrictEqual(before);

    // And each LISTENER gets its own copy: one consumer cannot edit what the
    // next one sees.
    const seen: StatsRecord[] = [];
    api.onDidUpdateStats((record) => {
      record.totals.prompt = -1;
      seen.push(record);
    });
    api.onDidUpdateStats((record) => seen.push(record));
    const flushed = recordOf('copy');
    e.flushed(flushed);
    expect(seen[1]?.totals.prompt).toBe(flushed.totals.prompt);
    expect(flushed.totals.prompt).not.toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// DoD 5.2 — the throttle law, faked clock
// ---------------------------------------------------------------------------

describe('DoD 5.2: a live event at most once per 2 s per session; every flush at once', () => {
  it('the floor is the locked 2 s', () => {
    expect(LIVE_EVENT_MIN_INTERVAL_MS).toBe(2_000);
  });

  it('the first change is delivered at once; a burst inside the window becomes ONE trailing delivery, the newest', () => {
    const { emitter: e, time } = emitter();
    const got: { at: number; prompt: number }[] = [];
    e.event((record) => got.push({ at: time.now(), prompt: record.totals.prompt }));
    const base = recordOf('s').totals.prompt;

    e.live(recordOf('s', 1));
    expect(got).toHaveLength(1);
    time.advance(500);
    e.live(recordOf('s', 2));
    time.advance(500);
    e.live(recordOf('s', 3));
    expect(got, 'a change inside the window was delivered early').toHaveLength(1);
    expect(e.pendingLive).toBe(1);

    time.advance(999);
    expect(got).toHaveLength(1);
    time.advance(1);
    expect(got).toHaveLength(2);
    expect(got[1]).toStrictEqual({ at: 1_000_000 + 2_000, prompt: base + 3 });
    expect(e.pendingLive).toBe(0);
  });

  it('a flood never breaks the floor: 200 changes over 20 s, spacing >= 2 s, the last one delivered', () => {
    const { emitter: e, time } = emitter();
    const at: number[] = [];
    let last = 0;
    e.event((record) => {
      at.push(time.now());
      last = record.totals.prompt;
    });
    const base = recordOf('s').totals.prompt;
    for (let i = 1; i <= 200; i += 1) {
      e.live(recordOf('s', i));
      time.advance(100);
    }
    time.advance(LIVE_EVENT_MIN_INTERVAL_MS);
    for (let i = 1; i < at.length; i += 1) {
      expect((at[i] ?? 0) - (at[i - 1] ?? 0), `deliveries ${String(i - 1)} and ${String(i)}`)
        .toBeGreaterThanOrEqual(LIVE_EVENT_MIN_INTERVAL_MS);
    }
    // 20 s of changes at the floor is 11 deliveries: the leading one and one
    // per elapsed window. Pinned, not bounded, so a throttle that dropped the
    // trailing edge (10) or leaked a second leading edge (more) both go red.
    expect(at).toHaveLength(11);
    expect(last, 'the newest change was lost to the throttle').toBe(base + 200);
  });

  it('the floor is PER SESSION: two sessions do not share a window', () => {
    const { emitter: e } = emitter();
    const got: string[] = [];
    e.event((record) => got.push(record.sessionId));
    e.live(recordOf('a', 1));
    e.live(recordOf('b', 1));
    e.live(recordOf('a', 2));
    e.live(recordOf('b', 2));
    expect(got).toStrictEqual(['a', 'b']);
    expect(e.pendingLive).toBe(2);
  });

  it('a flush is delivered at once, inside a live window, and drops the stale trailing delivery', () => {
    const { emitter: e, time } = emitter();
    const got: { kind: string; prompt: number }[] = [];
    e.event((record) => got.push({ kind: 'event', prompt: record.totals.prompt }));
    const base = recordOf('s').totals.prompt;

    e.live(recordOf('s', 1));
    time.advance(100);
    e.live(recordOf('s', 2));
    expect(e.pendingLive).toBe(1);
    e.flushed(recordOf('s', 3));
    expect(got.map((g) => g.prompt)).toStrictEqual([base + 1, base + 3]);
    expect(e.pendingLive, 'the older record would have arrived after the flushed one').toBe(0);
    time.advance(10_000);
    expect(got).toHaveLength(2);
  });

  it('flushes are never throttled: two flushes one millisecond apart are two events', () => {
    const { emitter: e, time } = emitter();
    let count = 0;
    e.event(() => {
      count += 1;
    });
    e.flushed(recordOf('s', 1));
    time.advance(1);
    e.flushed(recordOf('s', 2));
    expect(count).toBe(2);
  });

  it('a listener that throws is counted and does not stop the next one hearing', () => {
    const errors: unknown[] = [];
    const time = new ManualTime(0);
    const e = new StatsUpdateEmitter({ now: () => time.now(), scheduler: time, onError: (x) => errors.push(x) });
    let heard = 0;
    e.event(() => {
      throw new Error('consumer bug');
    });
    e.event(() => {
      heard += 1;
    });
    e.flushed(recordOf('s'));
    expect(heard).toBe(1);
    expect(e.counters.listenerErrors).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('dispose drops every pending delivery and every listener', () => {
    const { emitter: e, time } = emitter();
    let count = 0;
    e.event(() => {
      count += 1;
    });
    e.live(recordOf('s', 1));
    e.live(recordOf('s', 2));
    expect(time.pendingTimers).toBe(1);
    e.dispose();
    expect(time.pendingTimers).toBe(0);
    expect(e.listenerCount).toBe(0);
    time.advance(10_000);
    e.flushed(recordOf('s', 3));
    expect(count).toBe(1);
  });
});
