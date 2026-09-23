/**
 * The Insights surface's FREE state — v0.9.0 DoD 9.29 (spec `Amendment
 * 2026-09-21 — One window, Insights provider, Menu-only entry`).
 *
 * "Every static Layer 1 fact for the last 7 days the store already holds."
 * So the first block here uses THE STORE, not a list of records written in
 * the test: a real `StatsStore` on a temp directory, seeded with the
 * committed golden records (`fixtures/golden/stats/`), read back with
 * `readRecords` — the reader the host uses — and handed to the layout the
 * surface renders. The result is pinned by a golden in the parent
 * (`webview/goldens/insights/free-facts.json`).
 *
 * Two windows over the one store, because the corpus has two populations:
 * the real captures (Claude Code, Codex, OpenCode, 2026-08/09) and the
 * synthetic records (2023-11), which carry the cases the captures do not — a
 * stall, a silent subagent, an excluded session, and a cost from each of the
 * three sources, only ONE of which the "engine-reported" tile may count.
 *
 * Also here: each fact from its own field, the window boundary, the
 * vacuity controls, the example rotation (golden), the advice scan, the
 * privacy legs on the examples, and the provider state's words.
 *
 * In `src/` rather than beside the component because the store is a node
 * module and the webview project has no node types; the layout it tests is
 * the one the webview bundle ships.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { StatsRecord } from './stats/schema.js';
import { STATS_SCHEMA_VERSION } from './stats/schema.js';
import { StatsStore } from './stats/store.js';
import { STATS_GOLDEN_DIR } from './stats/corpus.stats.testkit.js';
import type { FindingSetView, InsightsProviderSnapshot, RunSummary } from './model/events.js';
import {
  EXAMPLES,
  EXAMPLE_LABEL,
  ESTIMATED_BY_CLAUDE_CODE,
  NO_LONGER_REPORTED,
  NO_RAW_OUTPUT,
  NO_REPORT,
  REPORT_HEADING,
  SELECT_A_REPORT,
  FINDING_LABELS,
  IDLE_RESUME_MS,
  INSIGHTS_WINDOW_DAYS,
  INSIGHT_SOURCES,
  exampleAt,
  freeInsightsLayout,
  providerInsightsLayout,
} from '../webview/insights/layout.js';
import { FINDING_KINDS } from './insights-provider.js';
import { FINDING_SINCE, REPORT_NOW, REPORT_SETS } from './insights-report.testkit.js';

const GOLDEN_FILE = resolve('webview/goldens/insights/free-facts.json');
const ROTATION_FILE = resolve('webview/goldens/insights/rotation.json');
const UPDATING = process.env['AGENT_DECK_UPDATE_INSIGHTS_GOLDENS'] === '1';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------------ */

const TEMP = mkdtempSync(join(tmpdir(), 'agent-deck-insights-'));
afterAll(() => {
  rmSync(TEMP, { recursive: true, force: true });
});

/** Every committed golden record. */
function goldenRecords(): StatsRecord[] {
  return readdirSync(STATS_GOLDEN_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(STATS_GOLDEN_DIR, name), 'utf8')) as StatsRecord);
}

/** A real store on a temp directory, holding every golden record, read back. */
function storedRecords(): StatsRecord[] {
  const dir = join(TEMP, 'store');
  mkdirSync(dir, { recursive: true });
  const store = new StatsStore({ dir, enabled: true, retentionDays: 3_650 });
  const records = goldenRecords();
  for (const record of records) store.appendRecord({ ...record, derivedAt: Date.now() });
  expect(store.appended).toBe(records.length);
  return store.readRecords();
}

/** The instant the layout counts back from, for a record set's newest end. */
function nowAfter(records: readonly StatsRecord[], filter: (r: StatsRecord) => boolean): number {
  const instants = records.filter(filter).map((r) => r.endedAt ?? r.startedAt);
  return Math.max(...instants) + HOUR;
}

function goldenCompare(file: string, actual: unknown): void {
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (UPDATING) {
    mkdirSync(resolve('webview/goldens/insights'), { recursive: true });
    writeFileSync(file, text, 'utf8');
  }
  expect(existsSync(file), `${file} is missing`).toBe(true);
  expect(
    text,
    `${file} is stale — re-run with AGENT_DECK_UPDATE_INSIGHTS_GOLDENS=1 if the change is intended`,
  ).toBe(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
}

describe('the free facts, from the REAL store, against a golden in the parent', () => {
  it('two windows over the one store match the committed golden', () => {
    const records = storedRecords();
    // The population: the store really holds the corpus, both populations.
    expect(records.length).toBeGreaterThan(30);
    const synthetic = (r: StatsRecord): boolean => r.startedAt < 1_750_000_000_000;
    const captured = (r: StatsRecord): boolean => !synthetic(r);
    expect(records.filter(synthetic).length).toBeGreaterThan(10);
    expect(records.filter(captured).length).toBeGreaterThan(10);

    const latest = freeInsightsLayout(records, nowAfter(records, captured), IDLE_RESUME_MS);
    // The synthetic population alone: a window counts every later record too,
    // so without the filter this window would be the whole store.
    const syntheticWindow = freeInsightsLayout(records.filter(synthetic), nowAfter(records, synthetic), IDLE_RESUME_MS);
    goldenCompare(GOLDEN_FILE, { latest, synthetic: syntheticWindow });

    // Not a vacuous golden: each window counted something, and the
    // synthetic one reached the cases it exists for.
    expect(latest.counted).toBeGreaterThan(0);
    const tile = (id: string) => syntheticWindow.tiles.find((t) => t.id === id);
    expect(tile('stalls')?.count).toBeGreaterThan(0);
    expect(tile('silentSubagents')?.count).toBeGreaterThan(0);
    expect(syntheticWindow.excluded).toBeGreaterThan(0);
  });

  it('the engine-cost tile sums ONLY engine-reported cost — never user prices or telemetry', () => {
    const records = storedRecords();
    const synthetic = (r: StatsRecord): boolean => r.startedAt < 1_750_000_000_000;
    const layout = freeInsightsLayout(records.filter(synthetic), nowAfter(records, synthetic), IDLE_RESUME_MS);
    const inWindow = records.filter(synthetic).filter((r) => r.coverage === 'full');
    // The window really holds all three sources, or "only engine" is untested.
    const sources = new Set(inWindow.map((r) => r.totals.costSource).filter(Boolean));
    expect([...sources].sort()).toStrictEqual(['engine', 'telemetry', 'user']);
    const engine = inWindow.filter((r) => r.totals.costSource === 'engine');
    const expected = engine.reduce((sum, r) => sum + (r.totals.costUsd ?? 0), 0);
    const cost = layout.tiles.find((t) => t.id === 'engineCost');
    expect(cost?.count).toBeCloseTo(expected, 9);
    expect(cost?.note).toBe(`over ${String(engine.length)} session${engine.length === 1 ? '' : 's'}`);
  });

  it('VACUITY CONTROL: a window after every record counts nothing, and says so', () => {
    const records = storedRecords();
    const after = freeInsightsLayout(records, Date.UTC(2099, 0, 1), IDLE_RESUME_MS);
    expect(after.counted).toBe(0);
    expect(after.excluded).toBe(0);
    for (const tile of after.tiles) expect(tile.count, tile.id).toBe(0);
    // An absent cost is an em dash, never 0.00.
    expect(after.tiles.find((t) => t.id === 'engineCost')?.value).toBe('—');
  });
});

/* ------------------------------------------------------------------------ *
 * Each fact from its own field
 * ------------------------------------------------------------------------ */

/** A record with nothing in it, ending one hour before `NOW`. */
/** The shared instant (`src/insights-report.testkit.ts`): the free facts and the report sets are stated against one clock. */
const NOW = REPORT_NOW;
function record(sessionId: string, over: Partial<StatsRecord> = {}): StatsRecord {
  return {
    statsSchemaVersion: STATS_SCHEMA_VERSION,
    sessionId,
    engine: 'cc',
    projectSlug: 'c--ws-example',
    startedAt: NOW - 2 * HOUR,
    endedAt: NOW - HOUR,
    coverage: 'full',
    agents: [],
    files: [],
    tools: [],
    loops: [],
    churn: [],
    contextChurn: [],
    compactions: [],
    stalls: [],
    skills: [],
    timing: {},
    totals: { prompt: 0, output: 0, compactions: 0, subagents: 0, silentSubagents: 0, stalls: 0 },
    params: { loopMin: 3 },
    unavailable: [],
    ...over,
  };
}

const totals = (over: Partial<StatsRecord['totals']>): StatsRecord['totals'] => ({
  prompt: 0,
  output: 0,
  compactions: 0,
  subagents: 0,
  silentSubagents: 0,
  stalls: 0,
  ...over,
});

function counts(records: StatsRecord[]): Record<string, number> {
  return Object.fromEntries(freeInsightsLayout(records, NOW, IDLE_RESUME_MS).tiles.map((t) => [t.id, t.count]));
}

describe('each fact is counted from its own field', () => {
  it('every tile moves when, and only when, its own field does', () => {
    const base = counts([record('s0')]);
    const cases: [string, Partial<StatsRecord>][] = [
      ['compactions', { totals: totals({ compactions: 2 }) }],
      ['idleResumes', { timing: { longestGapMs: IDLE_RESUME_MS } }],
      ['rereadLoops', { loops: [{ agentId: 'a', toolName: 'Read', class: 'read', count: 3, ordinals: [0, 1, 2] }] }],
      ['failedCalls', { tools: [{ toolName: 'Bash', class: 'shell', calls: 4, errors: 3 }] }],
      ['stalls', { totals: totals({ stalls: 1 }) }],
      ['silentSubagents', { totals: totals({ silentSubagents: 2 }) }],
      ['promptTokens', { totals: totals({ prompt: 1234 }) }],
      ['outputTokens', { totals: totals({ output: 56 }) }],
      ['engineCost', { totals: totals({ costUsd: 1.5, costSource: 'engine' }) }],
    ];
    for (const [id, over] of cases) {
      const moved = counts([record('s1', over)]);
      for (const [other, value] of Object.entries(moved)) {
        if (other === id || other === 'sessions') continue;
        expect(value, `${id} moved ${other}`).toBe(base[other]);
      }
      expect(moved[id], id).not.toBe(base[id]);
    }
    // Every tile names the field it came from.
    expect(Object.keys(INSIGHT_SOURCES).sort()).toStrictEqual(Object.keys(base).sort());
  });

  it('the idle threshold is the one the caller passes — the user’s setting (DoD 9.38)', () => {
    // A NON-default setting: five minutes. A 3-minute gap counts at the
    // default and must not count here; a 5-minute gap counts at both.
    const three = [record('s', { timing: { longestGapMs: 180_000 } })];
    const five = [record('s', { timing: { longestGapMs: 300_000 } })];
    const idle = (records: StatsRecord[], ms: number) =>
      freeInsightsLayout(records, NOW, ms).tiles.find((tile) => tile.id === 'idleResumes');
    expect(idle(three, IDLE_RESUME_MS)?.count).toBe(1);
    expect(idle(three, 300_000)?.count).toBe(0);
    expect(idle(five, 300_000)?.count).toBe(1);
    // ...and the tile states the rule it counted by.
    expect(idle(five, 300_000)?.note).toBe('sessions with a gap of 300 s or more');
    // EXACTLY, never rounded (verifier round 9.39, D11: 90,500 ms read "91 s").
    expect(idle(five, 90_500)?.note).toBe('sessions with a gap of 90.5 s or more');
    expect(idle(five, 1_800_250)?.note).toBe('sessions with a gap of 1,800.25 s or more');
  });

  it('a gap BELOW the idle threshold is not a resume; AT it, it is', () => {
    expect(counts([record('s', { timing: { longestGapMs: IDLE_RESUME_MS - 1 } })])['idleResumes']).toBe(0);
    expect(counts([record('s', { timing: { longestGapMs: IDLE_RESUME_MS } })])['idleResumes']).toBe(1);
  });

  it('only a READ loop is a re-read loop; an absent `errors` adds nothing', () => {
    expect(
      counts([record('s', { loops: [{ agentId: 'a', toolName: 'Edit', class: 'edit', count: 3, ordinals: [0, 1, 2] }] })])[
        'rereadLoops'
      ],
    ).toBe(0);
    expect(counts([record('s', { tools: [{ toolName: 'shell', class: 'shell', calls: 4 }] })])['failedCalls']).toBe(0);
  });

  it('an EXCLUDED record is skipped and counted as excluded, never as zeroes', () => {
    const layout = freeInsightsLayout(
      [record('full', { totals: totals({ compactions: 1 }) }), record('part', { coverage: 'excluded:partial', totals: totals({ compactions: 9 }) })],
      NOW,
      IDLE_RESUME_MS,
    );
    expect(layout.counted).toBe(1);
    expect(layout.excluded).toBe(1);
    expect(layout.tiles.find((t) => t.id === 'compactions')?.count).toBe(1);
  });

  it('the window is 7 days of the record’s LAST instant, inclusive at the edge', () => {
    const edge = NOW - INSIGHTS_WINDOW_DAYS * DAY;
    const layout = freeInsightsLayout(
      [
        record('in-by-end', { startedAt: edge - DAY, endedAt: edge }),
        record('out', { startedAt: edge - 2 * DAY, endedAt: edge - 1 }),
        record('open', { startedAt: edge + HOUR, endedAt: undefined }),
      ],
      NOW,
      IDLE_RESUME_MS,
    );
    expect(layout.counted).toBe(2);
    expect(layout.sinceMs).toBe(edge);
  });

  it('sessions break down by engine, in a fixed order, naming only engines present', () => {
    const layout = freeInsightsLayout(
      [record('a', { engine: 'opencode' }), record('b', { engine: 'cc' }), record('c', { engine: 'cc' })],
      NOW,
      IDLE_RESUME_MS,
    );
    expect(layout.byEngine).toStrictEqual({ cc: 2, codex: 0, opencode: 1 });
    expect(layout.tiles[0]).toMatchObject({ id: 'sessions', count: 3, note: 'Claude Code 2 · OpenCode 1' });
  });

  it('the idle threshold is the shipped livenessThresholdMs default', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      contributes?: { configuration?: { properties?: Record<string, { default?: number }> } };
    };
    expect(manifest.contributes?.configuration?.properties?.['agentDeck.livenessThresholdMs']?.default).toBe(
      IDLE_RESUME_MS,
    );
  });
});

/* ------------------------------------------------------------------------ *
 * The examples
 * ------------------------------------------------------------------------ */

describe('the example rotation', () => {
  it('is 1 -> 2 -> 3 -> 1, pinned by a golden', () => {
    const rotation = [0, 1, 2, 3, 4, 5, 6].map((n) => {
      const example = exampleAt(n);
      return { count: n, id: example.id, title: example.title };
    });
    goldenCompare(ROTATION_FILE, { label: EXAMPLE_LABEL, rotation });
    expect(rotation.map((r) => r.id)).toStrictEqual([
      'compaction',
      'cache-miss',
      'reread-loop',
      'compaction',
      'cache-miss',
      'reread-loop',
      'compaction',
    ]);
  });

  it('answers with the first example for a counter that cannot arise', () => {
    expect(exampleAt(-1).id).toBe('compaction');
    expect(exampleAt(1.5).id).toBe('compaction');
  });

  it('the goldens are not being written by this run', () => {
    expect(UPDATING, 'AGENT_DECK_UPDATE_INSIGHTS_GOLDENS is set: the goldens were REWRITTEN').toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 9.41 — the provider state's renderer, against goldens
 * ------------------------------------------------------------------------ */

const SINCE = FINDING_SINCE;

const ABOUT = { name: 'Agent Deck Insights', version: '0.2.0' };

/** The four sets DoD 9.41 names — from `src/insights-report.testkit.ts`, which the export goldens read too. */
const SETS = REPORT_SETS;

/** The report list every state shows: the four runs, newest first (DoD 9.46). */
const RUNS: RunSummary[] = [
  { runId: 'run-3', createdAt: NOW, state: 'ok', findings: 8, agentKind: 'claude' },
  { runId: 'run-2', createdAt: NOW - DAY, state: 'empty', findings: 0, agentKind: 'codex' },
  { runId: 'run-1', createdAt: NOW - 2 * DAY, state: 'refused', findings: 0, agentKind: 'claude' },
  { runId: 'run-4', createdAt: NOW - 3 * DAY, state: 'ok', findings: 1, agentKind: 'claude' },
];

/** A snapshot with the given set selected — the host's shape since DoD 9.46. */
function selecting(set: FindingSetView, over: { rawOutput?: boolean; dropped?: number } = {}): InsightsProviderSnapshot {
  return {
    about: ABOUT,
    runs: RUNS,
    dropped: 0,
    selected: {
      runId: set.runId,
      set,
      dropped: over.dropped ?? 0,
      rawOutput: over.rawOutput ?? set.state === 'refused',
    },
  };
}

/**
 * The states the goldens pin: nothing selected, each of DoD 9.41's four sets
 * selected, and a selected run the provider had no report for.
 */
const PROVIDER_STATES: Readonly<
  Record<'none-selected' | 'ok' | 'empty' | 'refused' | 'mixed-evidence' | 'missing', InsightsProviderSnapshot>
> = {
  'none-selected': {
    about: { ...ABOUT, status: 'licensed until 2027-09-23' },
    runs: RUNS,
    dropped: 2,
    selected: null,
  },
  ok: selecting(SETS.ok),
  empty: selecting(SETS.empty),
  refused: selecting(SETS.refused),
  'mixed-evidence': selecting(SETS['mixed-evidence'], { dropped: 1 }),
  missing: {
    about: ABOUT,
    runs: RUNS,
    dropped: 0,
    selected: { runId: 'run-2', set: null, dropped: 1, rawOutput: false },
  },
};

/** The selected report's rows, or undefined. */
function reportIn(snapshot: InsightsProviderSnapshot): ReturnType<typeof providerInsightsLayout>['preview'] extends infer P
  ? P extends { report: infer R } ? R | undefined : never
  : never {
  return providerInsightsLayout(snapshot).preview?.report ?? undefined;
}

describe('the provider state’s renderer — DoD 9.41, 9.46', () => {
  for (const [name, snapshot] of Object.entries(PROVIDER_STATES)) {
    it(`${name}: matches webview/goldens/insights/provider-${name}.json`, () => {
      goldenCompare(resolve(`webview/goldens/insights/provider-${name}.json`), providerInsightsLayout(snapshot));
    });
  }

  it('a finding reads in the amendment’s order: the LEAD, then kind, confidence and since-last-run as words', () => {
    const rows = reportIn(PROVIDER_STATES.ok)?.findings ?? [];
    expect(rows.map((r) => r.lead)).toStrictEqual(FINDING_KINDS.map((kind, i) => `Lead line ${String(i)} for ${kind}`));
    expect(rows.map((r) => r.meta)).toStrictEqual(
      FINDING_KINDS.map((kind, i) => {
        const since = SINCE[i % SINCE.length];
        return `${FINDING_LABELS[kind]} · ${(['low', 'medium', 'high'] as const)[i % 3] ?? ''} confidence${since === null || since === undefined ? '' : ` · since last run: ${since}`}`;
      }),
    );
    // No score anywhere: every meta is words.
    for (const row of rows) expect(row.meta, row.meta).not.toMatch(/\d/);
  });

  it('"estimated by Claude Code" is on a Claude Code run’s usage, and never on a Codex run’s', () => {
    const claude = reportIn(PROVIDER_STATES.ok)?.facts.usage ?? '';
    const codex = reportIn(PROVIDER_STATES.empty)?.facts.usage ?? '';
    expect(claude).toContain(`(${ESTIMATED_BY_CLAUDE_CODE})`);
    expect(codex).not.toContain('estimated');
    expect(codex).toBe('Run usage: 9,000 prompt tokens · 400 output tokens');
    expect(ESTIMATED_BY_CLAUDE_CODE).toBe('estimated by Claude Code');
    // No usage: no line.
    expect(reportIn(PROVIDER_STATES.refused)?.facts.usage).toBeNull();
  });

  it('a string and a number sit side by side in one finding, each under its label', () => {
    const evidence = reportIn(PROVIDER_STATES['mixed-evidence'])?.findings[0]?.evidence;
    expect(evidence).toStrictEqual([
      { label: 'Reads', value: '7', source: 'sessions[0].loops[0].count · ses_example01' },
      { label: 'File', value: 'repo/docs/schema.md', source: 'sessions[0].files[2].filePath · ses_example01' },
      { label: 'Skill', value: 'phase', source: 'sessions[1].skills[0].name · ses_example02' },
      { label: 'Cache ratio', value: '0.11', source: 'sessions[1].totals.prompt · ses_example02' },
    ]);
  });

  it('raw output is offered only on a REFUSED set, and only when the host said so', () => {
    expect(reportIn(PROVIDER_STATES.refused)?.rawOutput).toBe(true);
    expect(reportIn(selecting(SETS.refused, { rawOutput: false }))?.rawOutput).toBe(false);
    expect(reportIn(selecting(SETS.ok, { rawOutput: true }))?.rawOutput).toBe(false);
  });

  it('ruling 2026-09-22 (4): a refused set with no raw output says so, verbatim — and only then', () => {
    expect(NO_RAW_OUTPUT).toBe('No raw output for this run.');
    expect(reportIn(selecting(SETS.refused, { rawOutput: false }))?.rawOutputNote).toBe(NO_RAW_OUTPUT);
    // Offered: the action, not the sentence.
    expect(reportIn(PROVIDER_STATES.refused)?.rawOutputNote).toBeUndefined();
    // Not refused: neither, whatever the flag says.
    for (const flag of [true, false]) {
      expect(reportIn(selecting(SETS.ok, { rawOutput: flag }))?.rawOutputNote).toBeUndefined();
    }
  });

  it('round 5b: "No longer reported" names the kinds in the parent\u2019s own labels, and only when there are any', () => {
    expect(NO_LONGER_REPORTED).toBe('No longer reported:');
    expect(reportIn(PROVIDER_STATES['mixed-evidence'])?.resolved).toBe(
      'No longer reported: Stall, Cache miss',
    );
    for (const state of ['ok', 'empty', 'refused'] as const) {
      expect(reportIn(PROVIDER_STATES[state])?.resolved, state).toBeUndefined();
    }
  });

  it('round 5b: an empty detail reaches the row empty — the component shows no expand for it', () => {
    expect(reportIn(PROVIDER_STATES['mixed-evidence'])?.findings[0]?.detail).toBe('');
  });

  it('an ok set the parent emptied says so, and is not read as a run that found nothing', () => {
    const emptied = reportIn(selecting({ ...SETS.ok, findings: [] }));
    expect(emptied?.note).toBe('No finding from this run passed the check.');
    expect(reportIn(PROVIDER_STATES.empty)?.note).toBe(
      'The run read the window and recorded no findings.',
    );
  });

  it('DoD 9.46: the report list reads date, findings count and engine, in the list order the host sent', () => {
    const rows = providerInsightsLayout(PROVIDER_STATES['none-selected']).rows;
    expect(rows.map((r) => [r.runId, r.state, r.outcome, r.agent])).toStrictEqual([
      ['run-3', 'ok', '8 findings', 'Claude Code'],
      ['run-2', 'empty', 'no findings', 'Codex'],
      ['run-1', 'refused', 'refused', 'Claude Code'],
      ['run-4', 'ok', '1 finding', 'Claude Code'],
    ]);
    expect(rows[0]?.when).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/u);
  });

  it('DoD 9.46: nothing selected says so, verbatim; a selection with no report says that instead', () => {
    expect(SELECT_A_REPORT).toBe('Select a report to preview / download.');
    expect(providerInsightsLayout(PROVIDER_STATES['none-selected']).preview).toBeNull();
    const missing = providerInsightsLayout(PROVIDER_STATES.missing).preview;
    expect(missing).toStrictEqual({
      runId: 'run-2',
      report: null,
      missing: NO_REPORT,
      dropped: '1 value from this report did not pass the check and is not shown',
    });
  });

  it('DoD 9.46: the heading says Report, not Latest run — an older run is not the latest', () => {
    expect(REPORT_HEADING).toBe('Report');
    expect(reportIn(PROVIDER_STATES.refused)?.facts.heading).toMatch(/^Report · /u);
    for (const state of Object.values(PROVIDER_STATES)) {
      expect(JSON.stringify(providerInsightsLayout(state))).not.toContain('Latest run');
    }
  });

  it('DoD 9.44: the provider’s status sits under its title, and only when it states one', () => {
    expect(providerInsightsLayout(PROVIDER_STATES['none-selected']).status).toBe('licensed until 2027-09-23');
    expect(providerInsightsLayout(PROVIDER_STATES.ok).status).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------ *
 * No advice, and nothing real in the examples
 * ------------------------------------------------------------------------ */

describe('the Insights surface states facts and never advises', () => {
  /**
   * Every string the PARENT can show, built from the DATA and the component.
   *
   * Since DoD 9.40 a finding carries the PROVIDER's text — an action is
   * imperative by definition (the amendment's word), so advice is what it is
   * for, and it is Insights' to write. This ban is on the parent's OWN words:
   * the provider fixtures below carry neutral text, and every fixed string
   * the layout and the component add around them is scanned.
   */
  function surfaceText(): string {
    const layout = freeInsightsLayout(storedRecords(), NOW, IDLE_RESUME_MS);
    const shownOf = (snapshot: InsightsProviderSnapshot): string[] => {
      const paid = providerInsightsLayout(snapshot);
      const latest = paid.preview?.report ?? null;
      return [
        paid.title,
        latest?.facts.heading ?? '',
        latest?.facts.agent ?? '',
        latest?.facts.window ?? '',
        latest?.facts.usage ?? '',
        latest?.note ?? '',
        latest?.rejected ?? '',
        ...(latest?.findings ?? []).flatMap((f) => [f.meta, ...f.evidence.map((e) => e.source)]),
        ...paid.rows.flatMap((h) => [h.when, h.outcome, h.agent]),
        paid.dropped ?? '',
        paid.preview?.missing ?? '',
        paid.preview?.dropped ?? '',
        latest?.rawOutputNote ?? '',
      ];
    };
    // The component's own fixed sentences, read from its source.
    const component = readFileSync(resolve('webview/insights/InsightsSurface.svelte'), 'utf8');
    const markup = component.slice(component.indexOf('</script>'), component.indexOf('<style>'));
    const shown = [
      ...layout.tiles.flatMap((t) => [t.label, t.value, t.note ?? '']),
      EXAMPLE_LABEL,
      ...EXAMPLES.flatMap((e) => [e.title, ...e.lines]),
      ...Object.values(PROVIDER_STATES).flatMap(shownOf),
      markup.replace(/<[^>]*>/g, ' ').replace(/\{[^}]*\}/g, ' '),
    ];
    return shown.join('\n');
  }

  const BANNED = [
    'you should',
    'you can',
    'you may',
    'try ',
    'consider ',
    'recommend',
    'suggest',
    'ought',
    'need to',
    'must ',
    'better',
    'worse',
    'improve',
    'optimi',
    'fix ',
    'avoid ',
    'too many',
    'too much',
  ];

  it('carries no advice vocabulary and no second person, in either state', () => {
    const text = surfaceText().toLowerCase();
    // The population, pinned non-empty first.
    expect(text.length).toBeGreaterThan(600);
    for (const banned of BANNED) {
      expect(text.includes(banned), `the Insights surface says ${JSON.stringify(banned)}`).toBe(false);
    }
  });

  it('the scan can fail — a planted phrase is found', () => {
    const text = `${surfaceText()} you should consider this`.toLowerCase();
    expect(BANNED.some((banned) => text.includes(banned))).toBe(true);
  });

  it('every finding kind has the parent’s own words, and nothing of the model’s', () => {
    expect(Object.keys(FINDING_LABELS).sort()).toStrictEqual([...FINDING_KINDS].sort());
    for (const label of Object.values(FINDING_LABELS)) expect(label.length).toBeGreaterThan(3);
  });

  it('no example string appears anywhere in the committed corpora', () => {
    const TOKENS = ['ses_example01', 'ses_example02', 'a_example03', 'repo/src/config.ts', 'repo/docs/schema.md'];
    const exampleBody = EXAMPLES.flatMap((e) => [e.title, ...e.lines]).join('\n');
    for (const token of TOKENS) expect(exampleBody, `${token} is in no example`).toContain(token);
    let filesRead = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const text = readFileSync(full).toString('latin1');
        filesRead += 1;
        for (const token of TOKENS) expect(text.includes(token), `${token} appears in ${full}`).toBe(false);
      }
    };
    walk(resolve('fixtures'));
    expect(filesRead).toBeGreaterThan(50);
  }, 120_000);

  it('every example path and id is synthetic in SHAPE too', () => {
    const exampleText = EXAMPLES.flatMap((e) => [e.title, ...e.lines]).join('\n');
    expect(exampleText).not.toMatch(/[A-Za-z]:\\/u);
    expect(exampleText).not.toMatch(/(?:^|\s)\/(?:home|Users|var|etc)\//u);
    expect(exampleText).not.toMatch(/toolu_[A-Za-z0-9]{10,}/u);
    expect(exampleText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u);
    expect(exampleText).toContain('ses_example');
    expect(exampleText).toContain('a_example');
  });
});
