/**
 * v0.9.0 DoD 9.57 and 9.58 — `churn[].fileErrors` and
 * `contextChurn[].gapBeforeMs`, spec `Amendment 2026-09-26 — Facts for report
 * quality`.
 *
 * Three things are asserted for each field: the DERIVATION (both arms, one
 * unit apart where there is a boundary), the FIXTURE PROOF (the committed
 * goldens of real sessions carry the field, derived through the production
 * path — `goldens.test.ts` holds them byte for byte), and the READ of a record
 * written before the field existed (`<field>:absent`, never a zero standing in
 * for an absence).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ToolNode, UsageTurn } from '../model/events.js';

import { deriveContextChurn } from './context.js';
import { STATS_GOLDEN_DIR } from './corpus.stats.testkit.js';
import { deriveChurn } from './loops.js';
import type { StatsRecord, StatsToolClass } from './schema.js';
import {
  ROW_FIELDS_ADDED,
  STATS_SCHEMA_VERSION,
  STATS_STRING_FIELDS,
  upgradeStatsRecord,
  validateStatsRecord,
} from './schema.js';

function tool(ordinal: number, toolName: string, over: Partial<ToolNode> = {}): ToolNode {
  return { id: `t${String(ordinal)}`, toolName, status: 'done', inputPreview: '', ordinal, ...over };
}

const classOf = (name: string): StatsToolClass =>
  name === 'Edit' ? 'edit' : name === 'Write' ? 'write' : name === 'Read' ? 'read' : 'shell';

function turn(ordinal: number, cacheCreation: number, atMs?: number): UsageTurn {
  return {
    ordinal,
    input: 0,
    cacheCreation,
    cacheRead: 0,
    output: 0,
    ...(atMs === undefined ? {} : { atMs }),
  };
}

/** Every committed stats golden, parsed. */
function goldens(): { name: string; record: StatsRecord }[] {
  return readdirSync(STATS_GOLDEN_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
      name,
      record: JSON.parse(readFileSync(join(STATS_GOLDEN_DIR, name), 'utf8')) as StatsRecord,
    }));
}

/** A real harvested session's golden, not an R8 synthetic one. */
const isCorpus = (name: string): boolean => !name.includes('-synthetic-');

describe('DoD 9.57 — churn[].fileErrors', () => {
  it('counts the failures in the gap that NAME the chain’s file; errors keeps counting every one', () => {
    const [chain] = deriveChurn(
      [
        {
          agentId: 'root',
          tools: [
            tool(0, 'Edit', { filePath: '/r/a.ts' }),
            tool(1, 'Read', { filePath: '/r/a.ts', status: 'error' }),
            tool(2, 'Bash', { status: 'error' }),
            tool(3, 'Read', { filePath: '/r/b.ts', status: 'error' }),
            tool(4, 'Read', { filePath: '/r/a.ts' }),
            tool(5, 'Edit', { filePath: '/r/a.ts' }),
          ],
        },
      ],
      classOf,
    );
    expect(chain).toMatchObject({ filePath: '/r/a.ts', ordinals: [1, 2, 3, 4], errors: 3, fileErrors: 1 });
  });

  it('a chain whose only failure names ANOTHER file reads fileErrors 0, and is still a chain', () => {
    const chains = deriveChurn(
      [
        {
          agentId: 'root',
          tools: [
            tool(0, 'Write', { filePath: '/r/a.ts' }),
            tool(1, 'Read', { filePath: '/r/b.ts', status: 'error' }),
            tool(2, 'Write', { filePath: '/r/a.ts' }),
          ],
        },
      ],
      classOf,
    );
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({ errors: 1, fileErrors: 0 });
  });

  it('FIXTURE-PROVEN: every committed golden’s chain carries it, 0 <= fileErrors <= errors, and a real session has one', () => {
    const rows = goldens().flatMap(({ name, record }) => record.churn.map((row) => ({ name, row })));
    expect(rows.filter(({ name }) => isCorpus(name)).length).toBeGreaterThan(0);
    for (const { name, row } of rows) {
      expect(Number.isInteger(row.fileErrors), `${name}: fileErrors`).toBe(true);
      expect(row.fileErrors ?? -1).toBeGreaterThanOrEqual(0);
      expect(row.fileErrors ?? Infinity).toBeLessThanOrEqual(row.errors);
    }
  });
});

describe('DoD 9.58 — contextChurn[].gapBeforeMs', () => {
  it('is the instant of the spike turn minus the instant of the turn before it', () => {
    const out = deriveContextChurn(
      [{ agentId: 'root', series: [turn(0, 0, 1_000), turn(1, 6_000, 301_000), turn(2, 6_100, 302_000)] }],
      5_000,
    );
    expect(out).toStrictEqual([{ agentId: 'root', ordinal: 1, delta: 6_000, gapBeforeMs: 300_000 }]);
  });

  it('is null, never 0, where either turn states no instant', () => {
    const previousUnstated = deriveContextChurn(
      [{ agentId: 'root', series: [turn(0, 0), turn(1, 6_000, 301_000)] }],
      5_000,
    );
    const spikeUnstated = deriveContextChurn(
      [{ agentId: 'root', series: [turn(0, 0, 1_000), turn(1, 6_000)] }],
      5_000,
    );
    expect(previousUnstated?.[0]?.gapBeforeMs).toBeNull();
    expect(spikeUnstated?.[0]?.gapBeforeMs).toBeNull();
  });

  it('is taken against the PREVIOUS turn by ordinal, whatever order the series arrived in', () => {
    const out = deriveContextChurn(
      [{ agentId: 'root', series: [turn(2, 6_000, 90_000), turn(0, 0, 10_000), turn(1, 0, 60_000)] }],
      5_000,
    );
    expect(out?.[0]).toMatchObject({ ordinal: 2, gapBeforeMs: 30_000 });
  });

  it('FIXTURE-PROVEN: every committed golden’s spike carries it, and a real session states a non-negative number', () => {
    const rows = goldens().flatMap(({ name, record }) => record.contextChurn.map((row) => ({ name, row })));
    for (const { name, row } of rows) {
      expect(Object.hasOwn(row, 'gapBeforeMs'), `${name}: gapBeforeMs`).toBe(true);
      expect(row.gapBeforeMs === null || Number.isFinite(row.gapBeforeMs), name).toBe(true);
    }
    const stated = rows.filter(
      ({ name, row }) => isCorpus(name) && typeof row.gapBeforeMs === 'number',
    );
    expect(stated.length).toBeGreaterThan(0);
    for (const { row } of stated) expect(row.gapBeforeMs ?? -1).toBeGreaterThanOrEqual(0);
  });
});

describe('a record written before 9.57/9.58 reads with the gap named', () => {
  /** A committed real golden carrying both a chain and a spike. */
  function withBoth(): StatsRecord {
    const found = goldens().find(
      ({ name, record }) => isCorpus(name) && record.churn.length > 0 && record.contextChurn.length > 0,
    );
    if (found === undefined) throw new Error('no committed golden carries both a chain and a spike');
    return found.record;
  }

  function without(record: StatsRecord): Record<string, unknown> {
    return {
      ...record,
      churn: record.churn.map(({ fileErrors: _f, ...row }) => row),
      contextChurn: record.contextChurn.map(({ gapBeforeMs: _g, ...row }) => row),
    };
  }

  it('the markers are the amendment’s two, one per field', () => {
    expect(ROW_FIELDS_ADDED.map((f) => f.marker)).toStrictEqual(['fileErrors:absent', 'gapBeforeMs:absent']);
  });

  it('v3 without the fields: both markers, the input untouched, and the record still valid', () => {
    const old = without(withBoth());
    const before = JSON.stringify(old);
    const read = upgradeStatsRecord(old) as StatsRecord;
    expect(read).not.toBe(old);
    expect(JSON.stringify(old)).toBe(before);
    expect(read.unavailable).toContain('fileErrors:absent');
    expect(read.unavailable).toContain('gapBeforeMs:absent');
    expect([...read.unavailable]).toStrictEqual([...read.unavailable].sort());
    expect(read.statsSchemaVersion).toBe(STATS_SCHEMA_VERSION);
    expect(validateStatsRecord(read)).toStrictEqual({ ok: true, errors: [] });
  });

  it('v3 WITH the fields is returned as the same object, naming nothing', () => {
    const current = withBoth();
    expect(upgradeStatsRecord(current)).toBe(current);
    expect(current.unavailable).not.toContain('fileErrors:absent');
    expect(current.unavailable).not.toContain('gapBeforeMs:absent');
  });

  it('ONE row lacking the field is enough; the other field, present, is not named', () => {
    const current = withBoth();
    const [first, ...rest] = current.churn;
    if (first === undefined) throw new Error('no chain');
    const { fileErrors: _f, ...bare } = first;
    const read = upgradeStatsRecord({ ...current, churn: [bare, ...rest] }) as StatsRecord;
    expect(read.unavailable).toContain('fileErrors:absent');
    expect(read.unavailable).not.toContain('gapBeforeMs:absent');
  });

  it('a record with no chain and no spike has nothing to mark', () => {
    const current = { ...withBoth(), churn: [], contextChurn: [] };
    expect(upgradeStatsRecord(current)).toBe(current);
  });

  it('v2 without the fields: its own markers AND both row markers', () => {
    const { skills: _s, ...v3 } = without(withBoth()) as Record<string, unknown> & { skills: unknown };
    const v2 = { ...v3, statsSchemaVersion: 2 };
    const read = upgradeStatsRecord(v2) as StatsRecord;
    for (const marker of ['agentType:absent', 'skills:absent', 'fileErrors:absent', 'gapBeforeMs:absent']) {
      expect(read.unavailable).toContain(marker);
    }
    expect(validateStatsRecord(read)).toStrictEqual({ ok: true, errors: [] });
  });

  it('the validator and the string allow-list are unchanged: both are numbers (or null), and neither is a string key', () => {
    expect(STATS_STRING_FIELDS.has('fileErrors')).toBe(false);
    expect(STATS_STRING_FIELDS.has('gapBeforeMs')).toBe(false);
    const current = withBoth();
    const nulled = {
      ...current,
      contextChurn: current.contextChurn.map((row) => ({ ...row, gapBeforeMs: null })),
    };
    expect(validateStatsRecord(nulled).ok).toBe(true);
    expect(validateStatsRecord(without(current)).ok).toBe(true);
  });
});
