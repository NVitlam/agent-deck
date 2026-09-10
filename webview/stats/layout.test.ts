// The Stats layout — v0.7.0 Phase 4, DoD 4.2.
//
// NODE ENVIRONMENT: `layout.ts` is pure. The goldens under
// `webview/goldens/stats/` were written by `scripts/gen-webview-goldens.mjs`
// through the production path — the committed `fixtures/golden/stats/*.json`
// records, the host-side wire gate (`src/stats/wire.ts`), a real
// `webview/store.ts` fed a real `statsSnapshot`, then `statsLayout` — and this
// file re-runs the same path in-process and compares parsed JSON. That is
// "through hostRun" made literal: the record enters the way the host sends it.
//
// The INCREMENTAL PROPERTY is asserted separately and directly: adding a
// record to the input moves no existing Trends point.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { StatsRecord } from '../../src/stats/schema.js';
import { statsWireRecords } from '../../src/stats/wire.js';
import { createStore } from '../store.js';
import {
  COST_SOURCE_LABELS,
  TREND_STEP,
  VOCABULARY,
  basenameOf,
  excludedSummary,
  filesLayout,
  loopsLayout,
  statsLayout,
  tokensLayout,
  trendsLayout,
} from './layout.js';
import type { StatsLayout, TrendsLayout } from './layout.js';

const RECORDS_DIR = resolve('fixtures/golden/stats');
const GOLDEN_DIR = resolve('webview/goldens/stats');

interface Golden {
  generator: string;
  records: string[];
  layout: StatsLayout;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Every committed record, by stem, sorted the way the generator sorts them. */
const ALL = readdirSync(RECORDS_DIR)
  .filter((n) => n.endsWith('.json'))
  .sort()
  .map((name) => ({ stem: name.replace(/\.json$/u, ''), record: readJson<StatsRecord>(resolve(RECORDS_DIR, name)) }));
const CORPUS = ALL.filter((e) => !e.stem.includes('-synthetic-'));
const R8 = ALL.filter((e) => e.stem.includes('-synthetic-'));

/** The production path from records to layout: wire gate -> store -> layout. */
function hostRun(records: readonly StatsRecord[]): StatsLayout {
  const wire = statsWireRecords(records);
  expect(wire.dropped).toBe(0);
  const store = createStore();
  store.handleMessage({ type: 'statsSnapshot', records: wire.records });
  store.handleMessage({ type: 'statsStore', records: wire.records, enabled: true });
  const view = store.getView();
  return statsLayout(view.statsLive, view.statsStoreEnabled);
}

describe('the goldens at N = 0/1/2/6/12 corpus records', () => {
  it.each([0, 1, 2, 6, 12])('n%i reproduces through the production path', (n) => {
    const golden = readJson<Golden>(resolve(GOLDEN_DIR, `n${String(n)}.json`));
    expect(golden.records).toStrictEqual(CORPUS.slice(0, n).map((e) => e.stem));
    expect(hostRun(CORPUS.slice(0, n).map((e) => e.record))).toStrictEqual(golden.layout);
  });

  it('the twelve-record golden is not empty in any view (vacuity control)', () => {
    const golden = readJson<Golden>(resolve(GOLDEN_DIR, 'n12.json'));
    expect(golden.layout.files.rows.length).toBeGreaterThan(10);
    expect(golden.layout.loops.rows.length).toBeGreaterThan(0);
    expect(golden.layout.tokens.sessions).toHaveLength(12);
    expect(golden.layout.trends.empty).toBe(false);
    // DoD 4.12 made a series one line PER ENGINE, and this corpus carries more
    // than one engine — so the twelve points are DISTRIBUTED across lines
    // rather than sitting on one. What must hold is that every record is drawn
    // exactly once and no engine shares a line with another.
    const prompt = golden.layout.trends.series.find((s) => s.id === 'prompt');
    expect(prompt?.lines.length).toBeGreaterThan(0);
    const engines = prompt?.lines.map((l) => l.engine) ?? [];
    expect(new Set(engines).size, 'an engine appeared twice').toBe(engines.length);
    expect(prompt?.lines.reduce((n, l) => n + l.points.length, 0)).toBe(12);
  });

  it('there are enough corpus records for the widest case, and they exclude the R8 fixtures', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(12);
    expect(CORPUS.every((e) => !e.stem.includes('synthetic'))).toBe(true);
  });
});

describe('the R8 fixtures, each through hostRun', () => {
  const stems = readdirSync(GOLDEN_DIR).filter((n) => n.startsWith('r8-')).sort();

  it('has one golden per committed R8 record — all thirteen', () => {
    expect(stems).toHaveLength(R8.length);
    expect(R8.length).toBe(13);
  });

  it.each(R8.map((e) => e.stem))('%s reproduces', (stem) => {
    const entry = R8.find((e) => e.stem === stem);
    if (entry === undefined) throw new Error('unreachable');
    const id = stem.replace(/^[a-z]+-synthetic-/u, '');
    const golden = readJson<Golden>(resolve(GOLDEN_DIR, `r8-${id}.json`));
    expect(golden.records).toStrictEqual([stem]);
    expect(hostRun([entry.record])).toStrictEqual(golden.layout);
  });

  it('each R8 shape lands where its fixture says it manufactures it', () => {
    const by = (id: string): StatsLayout => readJson<Golden>(resolve(GOLDEN_DIR, `r8-${id}.json`)).layout;
    // 01: a read-class loop, flagged on the file it re-read.
    const loop = by('01-reread-loop');
    expect(loop.loops.rows[0]?.term).toBe(VOCABULARY.rereadLoop);
    expect(loop.loops.rows[0]?.ordinals).toStrictEqual([0, 1, 2]);
    expect(loop.files.rows[0]).toMatchObject({ basename: 'a.ts', loop: true, churn: false });
    // 02: a churn chain, flagged on the file it rewrote.
    const churn = by('02-churn-chain');
    expect(churn.loops.rows.some((r) => r.kind === 'churn' && r.term === VOCABULARY.churn)).toBe(true);
    expect(churn.files.rows.some((r) => r.churn)).toBe(true);
    // 03: one silent subagent.
    expect(by('03-silent-subagent').tokens.sessions[0]?.silentSubagents).toBe(1);
    // 05: excluded — in the footer, in NO table, absent from the aggregates.
    const excluded = by('05-excluded-parked');
    expect(excluded.excluded).toStrictEqual({ count: 1, byCode: { parked: 1 } });
    expect(excluded.files.rows).toStrictEqual([]);
    expect(excluded.loops.rows).toStrictEqual([]);
    expect(excluded.tokens.sessions).toStrictEqual([]);
    expect(excluded.trends.sessions).toStrictEqual([]);
    // 08: context fill, only where the engine states the window.
    expect(by('08-codex-window').tokens.sessions[0]?.contextFill).toBe(0.25);
    expect(by('01-reread-loop').tokens.sessions[0]?.contextFill).toBeUndefined();
    // 09: the engine's own cost, with the engine label.
    expect(by('09-opencode-cost').tokens.sessions[0]?.cost).toStrictEqual({
      usd: 0.4237,
      source: 'engine',
      label: COST_SOURCE_LABELS.engine,
    });
    // 10: a compaction marker on the strip.
    expect(by('10-compaction').tokens.sessions[0]?.strip.markers.map((m) => m.kind)).toStrictEqual([
      'compaction',
    ]);
    // 11: the user's own prices, labelled as such, and the model id listed.
    const priced = by('11-user-priced').tokens.sessions[0];
    expect(priced?.cost.source).toBe('user');
    expect(priced?.cost.label).toBe('estimated from your prices');
    expect(priced?.models).toStrictEqual(['synthetic-model-a']);
    // 12: a stall.
    expect(by('12-stall').tokens.sessions[0]?.stalls).toHaveLength(1);
    // 13: Component 12's one rendering — the telemetry cost and its label.
    expect(by('13-telemetry-cost').tokens.sessions[0]?.cost.label).toBe('estimated by Claude Code');
  });
});

describe('the incremental property — adding a record moves no existing Trends point', () => {
  it('holds over the twelve corpus records, one appended at a time', () => {
    const records = CORPUS.map((e) => e.record);
    for (let n = 1; n < records.length; n += 1) {
      const before = trendsLayout(records.slice(0, n));
      const after = trendsLayout(records.slice(0, n + 1));
      for (const series of before.series) {
        const later = after.series.find((s) => s.id === series.id);
        expect(later, series.id).toBeDefined();
        // Every earlier point is present, unchanged, at the same index — held
        // per ENGINE line, which is the shape DoD 4.12 introduced.
        for (const line of series.lines) {
          const laterLine = later?.lines.find((l) => l.engine === line.engine);
          expect(laterLine, `${series.id}/${line.engine}`).toBeDefined();
          expect(laterLine?.points.slice(0, line.points.length)).toStrictEqual(line.points);
        }
      }
      expect(after.sessions.slice(0, before.sessions.length)).toStrictEqual(before.sessions);
    }
  });

  it('the property is not vacuous: the maxima DO move, and the x step is the constant', () => {
    const records = CORPUS.map((e) => e.record);
    const small = trendsLayout(records.slice(0, 3));
    const large = trendsLayout(records);
    const promptSmall = small.series.find((s) => s.id === 'prompt');
    const promptLarge = large.series.find((s) => s.id === 'prompt');
    expect(promptLarge?.lines[0]?.max).not.toBe(promptSmall?.lines[0]?.max);
    const covered = records.filter((r) => r.coverage === 'full');
    expect(covered.length).toBeLessThan(records.length);
    // Across ALL lines the x positions are still exactly the session positions,
    // each used once: per-engine normalisation changed the y scale and the
    // grouping, and deliberately not where a point sits on the axis.
    const xs = (promptLarge?.lines ?? []).flatMap((l) => l.points.map((point) => point.x));
    expect([...xs].sort((a, b) => a - b)).toStrictEqual(covered.map((_, i) => i * TREND_STEP));
  });

  it('a record with a later startedAt appended last keeps every earlier point (the host orders by startedAt)', () => {
    const records = CORPUS.map((e) => e.record);
    const latest = { ...records[0] as StatsRecord, sessionId: 'appended', startedAt: Number.MAX_SAFE_INTEGER };
    const before = trendsLayout(records);
    const after = trendsLayout([...records, latest]);
    for (const series of before.series) {
      const later = after.series.find((s) => s.id === series.id);
      for (const line of series.lines) {
        const laterLine = later?.lines.find((l) => l.engine === line.engine);
        expect(laterLine?.points.slice(0, line.points.length)).toStrictEqual(line.points);
      }
    }
  });
});

describe('DoD 4.12: the mixed-engine golden', () => {
  /*
   * A GOLDEN NOTHING READS IS NOT A GOLDEN (verifier defect 13). The file was
   * generated, and `--check` proves it regenerates byte-identical — but no test
   * opened it, so rewriting the codex and opencode maxima to the cc maximum left
   * the whole webview project green. `--check` is run by no test and no workflow.
   */
  const golden = readJson<{
    trends: {
      sessions: { sessionId: string; engine: string; prompt: number }[];
      loaded: TrendsLayout;
      loading: TrendsLayout;
    };
  }>(resolve(GOLDEN_DIR, 'engines-mixed.json'));

  it('carries three engines, each with its own maximum, and they are its own points', () => {
    const prompt = golden.trends.loaded.series.find((s) => s.id === 'prompt');
    expect(prompt?.lines.map((l) => l.engine)).toStrictEqual(['cc', 'codex', 'opencode']);
    for (const line of prompt?.lines ?? []) {
      // The recorded maximum is the maximum of the recorded points — which is
      // what a shared scale would break, and what the mutation rewrote.
      expect(line.max, line.engine).toBe(Math.max(...line.points.map((p) => p.y)));
      // ...and it agrees with the input the generator declares.
      const own = golden.trends.sessions.filter((s) => s.engine === line.engine);
      expect(line.max, line.engine).toBe(Math.max(...own.map((s) => s.prompt)));
      expect(line.points).toHaveLength(own.length);
    }
  });

  it('is not vacuous: the three maxima are orders apart, as the real store was', () => {
    const prompt = golden.trends.loaded.series.find((s) => s.id === 'prompt');
    const maxima = (prompt?.lines ?? []).map((l) => l.max);
    expect(maxima).toHaveLength(3);
    // If any two were equal a shared scale would be indistinguishable here.
    expect(new Set(maxima).size).toBe(3);
    const [biggest, smallest] = [Math.max(...maxima), Math.min(...maxima)];
    expect(biggest / smallest).toBeGreaterThan(100);
  });

  it('carries the loading arm, on the same records', () => {
    expect(golden.trends.loading).toMatchObject({ empty: true, reason: 'loading' });
    expect(golden.trends.loaded.empty).toBe(false);
  });
});

describe('DoD 4.12: Trends never shares an axis across engines', () => {
  const base = CORPUS[0]?.record as StatsRecord;

  /** The same record as another engine, with a prompt total of `prompt`. */
  function as(engine: StatsRecord['engine'], sessionId: string, prompt: number): StatsRecord {
    return { ...base, sessionId, engine, totals: { ...base.totals, prompt } };
  }

  it('gives every engine its OWN line and its OWN maximum', () => {
    /*
     * The magnitudes are the measured ones, rounded: over a real 102 MB store
     * the median prompt total was 106,531,677 on Claude Code against 18,584 on
     * Codex. Under one shared maximum the Codex point's share of the box was
     * 0.017%, i.e. the baseline. Here each engine is scaled by its own maximum,
     * so both lines use the full height of their own box.
     */
    const records = [
      as('cc', 'cc-1', 106_000_000),
      as('cc', 'cc-2', 576_000_000),
      as('codex', 'cx-1', 18_584),
      as('codex', 'cx-2', 817_147),
      as('opencode', 'oc-1', 86_502),
    ];
    const prompt = trendsLayout(records).series.find((s) => s.id === 'prompt');
    expect(prompt?.lines.map((l) => l.engine)).toStrictEqual(['cc', 'codex', 'opencode']);
    expect(prompt?.lines.find((l) => l.engine === 'cc')?.max).toBe(576_000_000);
    expect(prompt?.lines.find((l) => l.engine === 'codex')?.max).toBe(817_147);
    expect(prompt?.lines.find((l) => l.engine === 'opencode')?.max).toBe(86_502);
    // THE POINT OF THE RULE: no engine's scale is set by another's.
    for (const line of prompt?.lines ?? []) {
      const own = Math.max(...line.points.map((point) => point.y));
      expect(line.max, line.engine).toBe(own);
    }
  });

  it('a line spans only its own engine, at the GLOBAL session positions', () => {
    const records = [as('cc', 'a', 10), as('codex', 'b', 20), as('cc', 'c', 30)];
    const prompt = trendsLayout(records).series.find((s) => s.id === 'prompt');
    const cc = prompt?.lines.find((l) => l.engine === 'cc');
    const codex = prompt?.lines.find((l) => l.engine === 'codex');
    // The axis is shared and ordered; a line keeps its sessions' own indices,
    // so a point still sits above the session it describes.
    expect(cc?.points.map((point) => point.index)).toStrictEqual([0, 2]);
    expect(codex?.points.map((point) => point.index)).toStrictEqual([1]);
    expect(cc?.points.map((point) => point.x)).toStrictEqual([0, 2 * TREND_STEP]);
  });

  it('an engine with no value in a series gets NO line, not a flat one', () => {
    // A flat line at zero is a claim about that engine; absence is not.
    const records = [
      { ...as('cc', 'a', 10), totals: { ...base.totals, prompt: 10, costUsd: 2, costSource: 'engine' as const } },
      as('codex', 'b', 20),
    ];
    const cost = trendsLayout(records).series.find((s) => s.id === 'cost');
    expect(cost?.lines.map((l) => l.engine)).toStrictEqual(['cc']);
  });

  it('the store not being READ yet is its own empty state, outranking the others', () => {
    const records = [base, { ...base, sessionId: 'b' }];
    // Not loaded: neither "off" nor "empty" is known yet, so neither is claimed.
    expect(trendsLayout(records, true, false)).toMatchObject({ empty: true, reason: 'loading' });
    // ...and it outranks `disabled`, which is also only a guess before the read.
    expect(trendsLayout(records, false, false)).toMatchObject({ empty: true, reason: 'loading' });
    // Loaded and off is `disabled`; loaded with too few is `fewer-than-two`.
    expect(trendsLayout(records, false, true)).toMatchObject({ empty: true, reason: 'disabled' });
    expect(trendsLayout([base], true, true)).toMatchObject({ empty: true, reason: 'fewer-than-two' });
    // And loaded with enough records is not empty at all.
    expect(trendsLayout(records, true, true).empty).toBe(false);
  });
});

describe('the views, as rules', () => {
  const base = CORPUS[0]?.record as StatsRecord;

  it('Files: sorted by total touches, basename primary, path kept for hover', () => {
    const layout = filesLayout(CORPUS.map((e) => e.record));
    const touches = layout.rows.map((r) => r.touches);
    expect(touches).toStrictEqual([...touches].sort((a, b) => b - a));
    for (const row of layout.rows) {
      expect(row.basename).toBe(basenameOf(row.filePath));
      expect(row.basename).not.toBe('');
      expect(row.touches).toBe(row.reads + row.edits + row.writes);
    }
  });

  it('basenameOf handles both separators and a trailing one', () => {
    expect(basenameOf('/a/b/c.ts')).toBe('c.ts');
    expect(basenameOf('C:\\Users\\x\\y.ts')).toBe('y.ts');
    expect(basenameOf('/a/b/')).toBe('b');
    expect(basenameOf('plain')).toBe('plain');
  });

  it('Loops & churn: a loop of a non-read class is an identical-call loop, a churn row carries its chain', () => {
    const layout = loopsLayout([
      {
        ...base,
        loops: [{ agentId: 'a', toolName: 'Bash', class: 'shell', count: 3, ordinals: [4, 7, 9] }],
        churn: [{ agentId: 'a', filePath: '/x/y.ts', fromOrdinal: 1, toOrdinal: 5, ordinals: [2, 3, 4], errors: 2 }],
      },
    ]);
    expect(layout.rows.map((r) => r.term)).toStrictEqual([VOCABULARY.loop, VOCABULARY.churn]);
    expect(layout.rows[1]?.ordinals).toStrictEqual([1, 2, 3, 4, 5]);
    expect(layout.rows[1]?.basename).toBe('y.ts');
    expect(layout.rows[1]?.count).toBe(2);
  });

  it('Tokens: absent cost and fill stay absent (em dash is the renderer\'s), and the agent primary is never the id', () => {
    const layout = tokensLayout([base]);
    const first = layout.sessions[0];
    expect(first?.cost.usd).toBeUndefined();
    expect(first?.cost.label).toBe('not computed');
    for (const agent of first?.agents ?? []) {
      expect(agent.primary).not.toBe(agent.agentId);
      expect(['main', `subagent d${String(agent.spawnDepth)}`]).toContain(agent.primary);
    }
  });

  it('Trends: empty below two records, empty when the store is off, and the cost series is engine-only', () => {
    expect(trendsLayout([]).reason).toBe('fewer-than-two');
    expect(trendsLayout([base]).empty).toBe(true);
    expect(trendsLayout([base, { ...base, sessionId: 'b' }]).empty).toBe(false);
    expect(trendsLayout([base, { ...base, sessionId: 'b' }], false)).toMatchObject({ empty: true, reason: 'disabled' });

    const engine = { ...base, sessionId: 'e', totals: { ...base.totals, costUsd: 1.5, costSource: 'engine' as const } };
    const user = { ...base, sessionId: 'u', totals: { ...base.totals, costUsd: 2.5, costSource: 'user' as const } };
    const telemetry = { ...base, sessionId: 't', totals: { ...base.totals, costUsd: 3.5, costSource: 'telemetry' as const } };
    const cost = trendsLayout([engine, user, telemetry]).series.find((s) => s.id === 'cost');
    expect(cost?.lines).toHaveLength(1);
    expect(cost?.lines[0]?.points.map((p) => p.sessionId)).toStrictEqual(['e']);
    expect(cost?.lines[0]?.points[0]?.y).toBe(1.5);
  });

  it('excluded sessions are counted by code and appear in no view', () => {
    const excluded = { ...base, sessionId: 'x', coverage: 'excluded:unsupported' as const };
    const records = [base, excluded];
    expect(excludedSummary(records)).toStrictEqual({ count: 1, byCode: { unsupported: 1 } });
    expect(filesLayout(records).records).toBe(1);
    expect(tokensLayout(records).sessions.map((s) => s.session.sessionId)).toStrictEqual([base.sessionId]);
    expect(trendsLayout(records).sessions.map((s) => s.sessionId)).toStrictEqual([base.sessionId]);
  });

  it('statsLayout is pure: the same input twice is deep-equal, and the input is not mutated', () => {
    const input = CORPUS.slice(0, 3).map((e) => e.record);
    const frozen = JSON.stringify(input);
    expect(statsLayout(input)).toStrictEqual(statsLayout(input));
    expect(JSON.stringify(input)).toBe(frozen);
  });
});

describe('DoD 4.13: a line whose every value is zero is FLAT, and says so', () => {
  /*
   * The 4.9 smoke drew two full-height arcs across the "loops" panel. A line
   * normalised to its own maximum has no shape when that maximum is zero, and
   * the renderer was drawing one anyway, into a box scaled to a stand-in height.
   * The layout now says so in a field the renderer keys on, and this golden pins
   * that field in BOTH directions: one flat line and one ordinary line in the
   * same series.
   */
  const golden = readJson<{
    from: string[];
    trends: {
      sessions: { sessionId: string; engine: string; loops: number }[];
      loaded: TrendsLayout;
    };
  }>(resolve(GOLDEN_DIR, 'zero-max.json'));

  it('the golden carries a flat loops line AND a non-flat one, side by side', () => {
    const loops = golden.trends.loaded.series.find((s) => s.id === 'loops');
    const byEngine = new Map((loops?.lines ?? []).map((l) => [l.engine, l] as const));
    expect([...byEngine.keys()]).toStrictEqual(['cc', 'codex']);

    const cc = byEngine.get('cc');
    expect(cc?.max).toBe(0);
    expect(cc?.flat, 'an all-zero line was not flagged flat').toBe(true);
    // ...and every one of its points really is zero, from the declared input.
    expect(cc?.points.map((p) => p.y)).toStrictEqual([0, 0]);
    expect(golden.trends.sessions.filter((s) => s.engine === 'cc').map((s) => s.loops)).toStrictEqual([0, 0]);

    // The control, in the same series: a real record with its own loop.
    const codex = byEngine.get('codex');
    expect(codex?.max).toBeGreaterThan(0);
    expect(codex?.flat, 'a line with a non-zero point was flagged flat').toBe(false);
  });

  it('flat is exactly "the maximum is zero", on EVERY line of EVERY committed golden', () => {
    // Over the whole directory, not over one file, because the property is the
    // rule and every golden is an instance of it. The first run of this found
    // nineteen flat lines already committed in the pre-4.13 goldens: the defect
    // was pinned in the outputs, waiting for a renderer to draw it.
    let lines = 0;
    let flat = 0;
    for (const name of readdirSync(GOLDEN_DIR).filter((n) => n.endsWith('.json')).sort()) {
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (node === null || typeof node !== 'object') return;
        const record = node as Record<string, unknown>;
        if (typeof record['max'] === 'number' && Array.isArray(record['points'])) {
          lines += 1;
          expect(typeof record['flat'], `${name}: a line with no flat field`).toBe('boolean');
          expect(record['flat'], `${name}: flat disagrees with max ${String(record['max'])}`).toBe(
            record['max'] === 0,
          );
          if (record['flat'] === true) flat += 1;
        }
        Object.values(record).forEach(walk);
      };
      walk(readJson<unknown>(resolve(GOLDEN_DIR, name)));
    }
    // Both populations exist, or the equality above proved only one direction.
    expect(lines).toBeGreaterThan(flat);
    expect(flat).toBeGreaterThan(0);
  });

  it('a line is flat through the layout itself, not only in the golden', () => {
    const base = CORPUS.find((e) => e.record.loops.length === 0)?.record as StatsRecord;
    expect(base, 'no loopless corpus record').toBeDefined();
    const records = [
      { ...base, sessionId: 'z1' },
      { ...base, sessionId: 'z2' },
    ];
    const loops = trendsLayout(records).series.find((s) => s.id === 'loops');
    expect(loops?.lines).toHaveLength(1);
    expect(loops?.lines[0]).toMatchObject({ max: 0, flat: true });
    // The prompt series over the same records is the ordinary case.
    const prompt = trendsLayout(records).series.find((s) => s.id === 'prompt');
    expect(prompt?.lines[0]?.flat).toBe(false);
  });
});
