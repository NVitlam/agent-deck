/**
 * API v2 — the Insights provider contract (v0.9.0 DoD 9.30).
 *
 * Spec `Amendment 2026-09-21 — One window, Insights provider, Menu-only
 * entry`. What is held here:
 *
 *  1. THE TYPES, pinned at compile time: the provider's shape is the
 *     amendment's, and `FindingSetView`/`RunSummary` carry exactly the keys
 *     they declare — so a field added on either side is a compile error here
 *     before it is anything else.
 *  2. THE ALLOW-LIST: every string a provider returns is an enumeration member
 *     or matches a strict shape, and **no raw model output crosses** — a
 *     finding carrying Insights' `cause`/`action` prose is refused whole.
 *  3. ONE PROVIDER AT A TIME, a second refused BY NAME.
 *  4. THE PARENT CALLS NOTHING ELSE: a provider wrapped in a Proxy records
 *     every property the registry touches.
 *  5. `onDidChange`, `run()` and DISPOSAL: a change re-renders, a run is one
 *     at a time, and disposing returns to the free state.
 */

import { describe, expect, it } from 'vitest';

import type {
  FindingSetView,
  FindingView,
  InsightsConfidence,
  InsightsFindingKind,
  RunSummary,
} from './model/events.js';
import type { InsightsProvider, ProviderEvent } from './insights-provider.js';
import {
  CONFIDENCES,
  FINDING_KINDS,
  InsightsProviderRegistry,
  MAX_EVIDENCE,
  MAX_FINDINGS,
  MAX_RUNS,
  PROVIDER_VERSION,
  viewOfAbout,
  viewOfFindingSet,
  viewOfRuns,
} from './insights-provider.js';

/* ------------------------------------------------------------------------ *
 * 1. The types — compile-time
 * ------------------------------------------------------------------------ */

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The amendment's provider shape, written out, and held equal to the export. */
interface AmendmentProvider {
  readonly providerVersion: 1;
  readonly about: { name: string; version: string };
  getLatest(): FindingSetView | null;
  listRuns(): RunSummary[];
  run(): Promise<void>;
  readonly onDidChange: ProviderEvent<void>;
}

const providerShape: Exact<keyof InsightsProvider, keyof AmendmentProvider> = true;
const setKeys: Exact<
  keyof FindingSetView,
  'runId' | 'createdAt' | 'agent' | 'window' | 'findings' | 'findingsRejected'
> = true;
const findingKeys: Exact<keyof FindingView, 'kind' | 'confidence' | 'evidence'> = true;
const runKeys: Exact<keyof RunSummary, 'runId' | 'createdAt' | 'outcome' | 'findings'> = true;
const kindsExhaustive: Exact<(typeof FINDING_KINDS)[number], InsightsFindingKind> = true;
const confidencesExhaustive: Exact<(typeof CONFIDENCES)[number], InsightsConfidence> = true;

describe('the contract types', () => {
  it('are the amendment’s, key for key (a violation is a compile error)', () => {
    expect([
      providerShape,
      setKeys,
      findingKeys,
      runKeys,
      kindsExhaustive,
      confidencesExhaustive,
    ]).toStrictEqual([true, true, true, true, true, true]);
    expect(PROVIDER_VERSION).toBe(1);
  });

  it('the finding kinds are Insights’ own eight, in its order', () => {
    // Insights' `src/engine/validator.ts` `FINDING_KINDS`, read 2026-09-21.
    // A second copy of another repository's list is a claim; this pins it
    // so a change is a deliberate edit here rather than a silent drop.
    expect([...FINDING_KINDS]).toStrictEqual([
      're-read-loop',
      'churn-chain',
      'context-churn',
      'stall',
      'silent-subagent',
      'compaction',
      'cache-miss',
      'other',
    ]);
  });
});

/* ------------------------------------------------------------------------ *
 * Builders
 * ------------------------------------------------------------------------ */

function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 're-read-loop',
    confidence: 'high',
    evidence: [{ statsKey: 'sessions[0].loops[1].count', value: 7 }],
    ...over,
  };
}

function findingSet(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run-2026-09-21.1',
    createdAt: 1_790_000_000_000,
    agent: 'claude',
    window: { sinceMs: 1_789_400_000_000, sessions: 5 },
    findings: [finding()],
    findingsRejected: 0,
    ...over,
  };
}

function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { runId: 'run-1', createdAt: 1_790_000_000_000, outcome: 'findings', findings: 1, ...over };
}

/** A provider with its own change emitter, for the registry tests. */
function fakeProvider(over: Partial<Record<string, unknown>> = {}): {
  provider: InsightsProvider;
  fire: () => void;
  runs: number;
  listeners: number;
} {
  const listeners = new Set<() => unknown>();
  const state = {
    runs: 0,
    get listeners(): number {
      return listeners.size;
    },
  };
  const provider = {
    providerVersion: 1 as const,
    about: { name: 'Agent Deck Insights', version: '0.2.0' },
    getLatest: () => findingSet() as unknown as FindingSetView,
    listRuns: () => [run() as unknown as RunSummary],
    run: () => {
      state.runs += 1;
      return Promise.resolve();
    },
    onDidChange: (listener: () => unknown) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    ...over,
  } as unknown as InsightsProvider;
  return {
    provider,
    fire: () => {
      for (const listener of [...listeners]) listener();
    },
    get runs() {
      return state.runs;
    },
    get listeners() {
      return state.listeners;
    },
  };
}

/* ------------------------------------------------------------------------ *
 * 2. The allow-list
 * ------------------------------------------------------------------------ */

describe('a finding set is checked field by field, and copied', () => {
  it('a valid set passes whole, as a FRESH object', () => {
    const input = findingSet();
    const { value, dropped } = viewOfFindingSet(input);
    expect(dropped).toBe(0);
    expect(value).toStrictEqual(input);
    expect(value).not.toBe(input);
    expect(value?.findings[0]).not.toBe((input['findings'] as unknown[])[0]);
  });

  it('REFUSES a finding carrying the model’s prose — no raw model output crosses', () => {
    /*
     * Insights' stored finding carries `cause` and `action`, written by the
     * model. The view has no field for either, so a finding that brings them
     * has extra keys and is dropped WHOLE rather than trimmed: trimming
     * would render a finding the provider did not send.
     */
    for (const prose of [
      { cause: 'The agent re-read the file because the edit failed.' },
      { action: 'You should cache the schema.' },
    ]) {
      const { value, dropped } = viewOfFindingSet(
        findingSet({ findings: [finding(prose), finding()] }),
      );
      expect(value?.findings).toHaveLength(1);
      expect(dropped).toBe(1);
      expect(JSON.stringify(value)).not.toMatch(/cause|action|should|re-read the file/);
    }
  });

  it('refuses a string where a number belongs, and a key that is not a stats path', () => {
    for (const evidence of [
      [{ statsKey: 'sessions[0].files[2].filePath', value: 'C:/Users/someone/secret.ts' }],
      [{ statsKey: 'process.env.HOME', value: 1 }],
      [{ statsKey: 'sessions.', value: 1 }],
      [{ statsKey: 'sessions[0].totals.prompt', value: Number.NaN }],
      [],
    ]) {
      const { value, dropped } = viewOfFindingSet(findingSet({ findings: [finding({ evidence })] }));
      expect(value?.findings, JSON.stringify(evidence)).toHaveLength(0);
      expect(dropped).toBe(1);
    }
  });

  it('refuses an unknown kind or confidence — enumerations, not free text', () => {
    for (const over of [{ kind: 'Your agent is slow' }, { confidence: 'certain' }]) {
      const { dropped } = viewOfFindingSet(findingSet({ findings: [finding(over)] }));
      expect(dropped, JSON.stringify(over)).toBe(1);
    }
  });

  it('a broken ENVELOPE drops the whole set, counted once', () => {
    for (const over of [
      { runId: 'run 1; <script>' },
      { createdAt: -1 },
      { agent: 'gpt' },
      { window: { sinceMs: 1, sessions: 1, extra: 'x' } },
      { findingsRejected: 1.5 },
      { findings: 'none' },
      { note: 'an extra top-level key' },
    ]) {
      const { value, dropped } = viewOfFindingSet(findingSet(over));
      expect(value, JSON.stringify(over)).toBeNull();
      expect(dropped).toBe(1);
    }
  });

  it('`null` is "no latest set" and costs nothing', () => {
    expect(viewOfFindingSet(null)).toStrictEqual({ value: null, dropped: 0 });
  });

  it('a GETTER is never run: an accessor field reads as absent', () => {
    let ran = false;
    const input = findingSet();
    Object.defineProperty(input, 'runId', {
      enumerable: true,
      get: () => {
        ran = true;
        return 'run-1';
      },
    });
    expect(viewOfFindingSet(input).value).toBeNull();
    expect(ran).toBe(false);
  });

  it('past the cap is counted as dropped, never silently cut', () => {
    const many = Array.from({ length: MAX_FINDINGS + 3 }, () => finding());
    const { value, dropped } = viewOfFindingSet(findingSet({ findings: many }));
    expect(value?.findings).toHaveLength(MAX_FINDINGS);
    expect(dropped).toBe(3);
  });
});

describe('the run history is checked the same way', () => {
  it('passes valid runs, drops and counts the rest, caps at MAX_RUNS', () => {
    const { value, dropped } = viewOfRuns([
      run(),
      run({ outcome: 'crashed' }),
      run({ runId: '' }),
      run({ findings: -1 }),
      run({ runId: 'run-2', outcome: 'refused', findings: 0 }),
    ]);
    expect(value.map((r) => r.runId)).toStrictEqual(['run-1', 'run-2']);
    expect(dropped).toBe(3);
    const capped = viewOfRuns(Array.from({ length: MAX_RUNS + 2 }, (_, i) => run({ runId: `run-${String(i)}` })));
    expect(capped.value).toHaveLength(MAX_RUNS);
    expect(capped.dropped).toBe(2);
  });

  it('about is two strings in their shapes, and nothing else', () => {
    expect(viewOfAbout({ name: 'Agent Deck Insights', version: '0.2.0' })).toStrictEqual({
      name: 'Agent Deck Insights',
      version: '0.2.0',
    });
    for (const bad of [
      { name: '<img src=x>', version: '0.2.0' },
      { name: 'Insights', version: 'latest' },
      { name: 'Insights', version: '0.2.0', licence: 'valid' },
      null,
    ]) {
      expect(viewOfAbout(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------------ *
 * 3. One provider at a time
 * ------------------------------------------------------------------------ */

describe('the registry holds ONE provider', () => {
  it('registers, announces the change, and states the about', () => {
    let changes = 0;
    const registry = new InsightsProviderRegistry({ onChange: () => (changes += 1) });
    expect(registry.registered).toBe(false);
    expect(registry.snapshot()).toBeNull();
    registry.register(fakeProvider().provider);
    expect(registry.registered).toBe(true);
    expect(changes).toBe(1);
    expect(registry.about()).toStrictEqual({ name: 'Agent Deck Insights', version: '0.2.0' });
  });

  it('a SECOND registration is refused BY NAME, and changes nothing', () => {
    let changes = 0;
    const registry = new InsightsProviderRegistry({ onChange: () => (changes += 1) });
    registry.register(fakeProvider().provider);
    const second = fakeProvider({ about: { name: 'Other Insights', version: '9.9.9' } });
    expect(() => registry.register(second.provider)).toThrow(
      'an Insights provider is already registered (Agent Deck Insights 0.2.0); Other Insights 9.9.9 was refused.',
    );
    expect(registry.about()?.name).toBe('Agent Deck Insights');
    expect(changes).toBe(1);
    // The refused one was never subscribed to.
    expect(second.listeners).toBe(0);
  });

  it('refuses anything that is not a provider of this contract', () => {
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    for (const bad of [
      null,
      {},
      fakeProvider({ providerVersion: 2 }).provider,
      fakeProvider({ about: { name: 'x' } }).provider,
      fakeProvider({ run: 'not a function' }).provider,
      fakeProvider({ onDidChange: undefined }).provider,
    ]) {
      expect(() => registry.register(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
    expect(registry.registered).toBe(false);
  });

  it('a provider written as a CLASS (methods on the prototype) registers', () => {
    class Provider {
      readonly providerVersion = 1 as const;
      readonly about = { name: 'Class Insights', version: '1.0.0' };
      getLatest(): null {
        return null;
      }
      listRuns(): RunSummary[] {
        return [];
      }
      run(): Promise<void> {
        return Promise.resolve();
      }
      onDidChange(): { dispose(): void } {
        return { dispose: () => undefined };
      }
    }
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    registry.register(new Provider());
    expect(registry.snapshot()).toStrictEqual({
      about: { name: 'Class Insights', version: '1.0.0' },
      latest: null,
      runs: [],
      running: false,
      dropped: 0,
    });
  });
});

/* ------------------------------------------------------------------------ *
 * 4. The parent calls nothing else
 * ------------------------------------------------------------------------ */

describe('the parent reads and calls ONLY the contract’s members', () => {
  it('a Proxy provider sees no other property touched, and only three called', async () => {
    const touched = new Set<string>();
    const called: string[] = [];
    const base = fakeProvider().provider as unknown as Record<string, unknown>;
    const wrap = (key: string, value: unknown): unknown =>
      typeof value === 'function'
        ? (...args: unknown[]): unknown => {
            called.push(key);
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value;
    const spy = new Proxy(base, {
      get(target, key) {
        if (typeof key === 'string') touched.add(key);
        return wrap(String(key), Reflect.get(target, key));
      },
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === 'string') touched.add(key);
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        return descriptor === undefined || !('value' in descriptor)
          ? descriptor
          : { ...descriptor, value: wrap(String(key), descriptor.value) };
      },
      has(target, key) {
        if (typeof key === 'string') touched.add(key);
        return Reflect.has(target, key);
      },
    });
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    const handle = registry.register(spy);
    registry.snapshot();
    await registry.run();
    handle.dispose();

    const CONTRACT = ['providerVersion', 'about', 'getLatest', 'listRuns', 'run', 'onDidChange'];
    expect([...touched].filter((key) => !CONTRACT.includes(key))).toStrictEqual([]);
    // The population is not empty: every member was reached.
    expect([...touched].sort()).toStrictEqual([...CONTRACT].sort());
    expect([...new Set(called)].sort()).toStrictEqual(
      ['getLatest', 'listRuns', 'onDidChange', 'run'].sort(),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * 5. onDidChange, run(), disposal
 * ------------------------------------------------------------------------ */

describe('onDidChange, run and disposal', () => {
  it('the provider’s onDidChange reaches the registry’s onChange', () => {
    let changes = 0;
    const registry = new InsightsProviderRegistry({ onChange: () => (changes += 1) });
    const fake = fakeProvider();
    registry.register(fake.provider);
    expect(changes).toBe(1);
    fake.fire();
    fake.fire();
    expect(changes).toBe(3);
  });

  it('run() calls the provider once, shows running, and ignores a second press meanwhile', async () => {
    const states: boolean[] = [];
    let release: () => void = () => undefined;
    const fake = fakeProvider({
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    let calls = 0;
    const counting = { ...fake.provider, run: () => ((calls += 1), fake.provider.run()) };
    const registry = new InsightsProviderRegistry({
      onChange: () => states.push(registry.snapshot()?.running ?? false),
    });
    registry.register(counting);
    const first = registry.run();
    const second = registry.run();
    await second;
    expect(calls).toBe(1);
    expect(registry.snapshot()?.running).toBe(true);
    release();
    await first;
    expect(registry.snapshot()?.running).toBe(false);
    expect(states).toStrictEqual([false, true, false]);
  });

  it('a rejected run is reported, never thrown, and running resets', async () => {
    const errors: unknown[] = [];
    const registry = new InsightsProviderRegistry({
      onChange: () => undefined,
      onError: (error) => errors.push(error),
    });
    registry.register(fakeProvider({ run: () => Promise.reject(new Error('no licence')) }).provider);
    await expect(registry.run()).resolves.toBeUndefined();
    expect(errors.map((e) => (e as Error).message)).toStrictEqual(['no licence']);
    expect(registry.snapshot()?.running).toBe(false);
  });

  it('a throwing getLatest reads as nothing and counts one drop', () => {
    const registry = new InsightsProviderRegistry({ onChange: () => undefined, onError: () => undefined });
    registry.register(
      fakeProvider({
        getLatest: () => {
          throw new Error('store unreadable');
        },
      }).provider,
    );
    expect(registry.snapshot()?.latest).toBeNull();
    expect(registry.snapshot()?.dropped).toBe(1);
  });

  it('DISPOSAL returns to the free state, unsubscribes, and allows the next provider', () => {
    let changes = 0;
    const registry = new InsightsProviderRegistry({ onChange: () => (changes += 1) });
    const fake = fakeProvider();
    const handle = registry.register(fake.provider);
    expect(fake.listeners).toBe(1);
    handle.dispose();
    expect(registry.registered).toBe(false);
    expect(registry.snapshot()).toBeNull();
    expect(registry.about()).toBeNull();
    expect(fake.listeners).toBe(0);
    expect(changes).toBe(2);
    // Idempotent.
    handle.dispose();
    expect(changes).toBe(2);
    // A change from the disposed provider no longer reaches the registry.
    fake.fire();
    expect(changes).toBe(2);
    // The next provider may register.
    registry.register(fakeProvider({ about: { name: 'Next', version: '1.0.0' } }).provider);
    expect(registry.about()?.name).toBe('Next');
  });

  it('a STALE handle cannot unregister the provider after it', () => {
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    const first = registry.register(fakeProvider().provider);
    first.dispose();
    registry.register(fakeProvider({ about: { name: 'Second', version: '1.0.0' } }).provider);
    first.dispose();
    expect(registry.about()?.name).toBe('Second');
  });
});

/* ------------------------------------------------------------------------ *
 * Verifier round 9.33 — the paths no test drove (D1, D4)
 * ------------------------------------------------------------------------ */

describe('what the first round left undriven', () => {
  it('D1: a repeated run id is dropped and counted — the history names runs by id', () => {
    const checked = viewOfRuns([run(), run({ createdAt: 1 }), run({ runId: 'run-2' })]);
    expect(checked.value.map((r) => r.runId)).toStrictEqual(['run-1', 'run-2']);
    expect(checked.dropped).toBe(1);
  });

  it('D1: a finding citing one stats key twice is dropped, and the set keeps the rest', () => {
    const twice = finding({
      evidence: [
        { statsKey: 'sessions[0].loops[1].count', value: 7 },
        { statsKey: 'sessions[0].loops[1].count', value: 8 },
      ],
    });
    const checked = viewOfFindingSet(findingSet({ findings: [twice, finding()] }));
    expect(checked.value?.findings).toHaveLength(1);
    expect(checked.dropped).toBe(1);
  });

  it('V38: evidence past MAX_EVIDENCE drops the finding; at the cap it passes', () => {
    const items = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ statsKey: `sessions[${String(i)}].totals.prompt`, value: i }));
    const at = viewOfFindingSet(findingSet({ findings: [finding({ evidence: items(MAX_EVIDENCE) })] }));
    expect(at.value?.findings).toHaveLength(1);
    const past = viewOfFindingSet(findingSet({ findings: [finding({ evidence: items(MAX_EVIDENCE + 1) })] }));
    expect(past.value?.findings).toHaveLength(0);
    expect(past.dropped).toBe(1);
  });

  it('V21: a contract MEMBER given as a getter is refused, and the getter never runs', () => {
    let ran = 0;
    const provider = fakeProvider().provider as unknown as Record<string, unknown>;
    const withGetter = { ...provider };
    delete withGetter['getLatest'];
    Object.defineProperty(withGetter, 'getLatest', {
      enumerable: true,
      get: () => {
        ran += 1;
        return () => null;
      },
    });
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    expect(() => registry.register(withGetter as unknown as InsightsProvider)).toThrow(TypeError);
    expect(ran).toBe(0);
    expect(registry.registered).toBe(false);
  });

  it('V14/V18: a provider disposed MID-RUN leaves the next one free to run, and its late settle changes nothing', async () => {
    let releaseA: () => void = () => undefined;
    const a = fakeProvider({ run: () => new Promise<void>((resolve) => (releaseA = resolve)) });
    let releaseB: () => void = () => undefined;
    let bRuns = 0;
    const b = fakeProvider({
      about: { name: 'Second', version: '1.0.0' },
      run: () => {
        bRuns += 1;
        return new Promise<void>((resolve) => (releaseB = resolve));
      },
    });
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    const handleA = registry.register(a.provider);
    const runA = registry.run();
    expect(registry.snapshot()?.running).toBe(true);
    handleA.dispose();
    registry.register(b.provider);
    // Disposal reset the flag, so B is not stuck behind A's run...
    expect(registry.snapshot()?.running).toBe(false);
    const runB = registry.run();
    expect(bRuns).toBe(1);
    expect(registry.snapshot()?.running).toBe(true);
    // ...and A settling late does not clear B's.
    releaseA();
    await runA;
    expect(registry.snapshot()?.running).toBe(true);
    releaseB();
    await runB;
    expect(registry.snapshot()?.running).toBe(false);
  });

  it('V15: after the registry is disposed (deactivation) nothing can register', () => {
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    registry.register(fakeProvider().provider);
    registry.dispose();
    expect(registry.registered).toBe(false);
    expect(() => registry.register(fakeProvider().provider)).toThrow(/shutting down/);
  });
});
