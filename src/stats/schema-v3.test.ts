/**
 * v0.9.0 DoD 9.4 — schema version 3, and reading what 0.7.x and 0.8.x wrote.
 *
 * Spec `Amendment 2026-09-20`: `statsSchemaVersion` 3, readable `[1, 2, 3]`, a
 * v1 record read with `F14:absent`, `F15:absent`, `agentType:absent` and
 * `skills:absent`, a v2 record with the last two. Unchanged from DoD 7.14 and
 * ruling R3: old records are READ, never skipped and never rewritten, and
 * nothing on disk is touched.
 *
 * ## The store leg is the one that matters
 *
 * The upgrade function can be driven directly and that proves the mapping. It
 * does not prove that a real store FILE holding old lines is read, which is the
 * property a user has. So the last describe writes real v1 and v2 lines into a
 * real store and reads them back through the real reader, then compares the
 * file's bytes before and after — "never rewritten" is a claim about a file.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  HISTORY_ABSENT_FACTS,
  READABLE_STATS_SCHEMA_VERSIONS,
  STATS_SCHEMA_VERSION,
  upgradeStatsRecord,
  validateStatsRecord,
} from './schema.js';

// ---------------------------------------------------------------------------
// The version
// ---------------------------------------------------------------------------

describe('the version and the readable list', () => {
  it('is 3', () => {
    expect(STATS_SCHEMA_VERSION).toBe(3);
  });

  it('reads 1, 2 and 3 — and nothing else', () => {
    expect([...READABLE_STATS_SCHEMA_VERSIONS].sort()).toEqual([1, 2, 3]);
  });

  it('names the facts each older version could not carry', () => {
    expect([...(HISTORY_ABSENT_FACTS[1] ?? [])].sort()).toEqual([
      'F14:absent',
      'F15:absent',
      'agentType:absent',
      'skills:absent',
    ]);
    expect([...(HISTORY_ABSENT_FACTS[2] ?? [])].sort()).toEqual([
      'agentType:absent',
      'skills:absent',
    ]);
    // A version-3 record is not upgraded, so it names nothing.
    expect(HISTORY_ABSENT_FACTS[3]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The upgrade
// ---------------------------------------------------------------------------

/** A record as v1 wrote it: no `timing`, no `resultUnreceived`, no `skills`. */
function v1Record(sessionId = 'old-1'): Record<string, unknown> {
  return {
    statsSchemaVersion: 1,
    sessionId,
    engine: 'cc',
    projectSlug: 'c--ws',
    startedAt: 1_000,
    endedAt: 2_000,
    coverage: 'full',
    agents: [
      { agentId: 'root', kind: 'main', spawnDepth: 0, prompt: 1, output: 1, toolCalls: 1, silent: false },
    ],
    files: [],
    tools: [],
    loops: [],
    churn: [],
    contextChurn: [],
    compactions: [],
    stalls: [],
    totals: { prompt: 1, output: 1, compactions: 0, subagents: 0, silentSubagents: 0, stalls: 0 },
    params: { loopMin: 3 },
    unavailable: [],
  };
}

/** A record as v2 wrote it: `timing` and `resultUnreceived`, but no `skills`. */
function v2Record(sessionId = 'old-2'): Record<string, unknown> {
  return {
    ...v1Record(sessionId),
    statsSchemaVersion: 2,
    agents: [
      {
        agentId: 'root',
        kind: 'main',
        spawnDepth: 0,
        prompt: 1,
        output: 1,
        toolCalls: 1,
        silent: false,
        resultUnreceived: false,
      },
    ],
    timing: { wallMs: 1_000 },
  };
}

describe('upgradeStatsRecord gives an old record the v3 shape', () => {
  it('a v1 record reads as v3, with all four markers', () => {
    const upgraded = upgradeStatsRecord(v1Record()) as Record<string, unknown>;
    expect(upgraded['statsSchemaVersion']).toBe(3);
    expect(upgraded['skills']).toEqual([]);
    expect(upgraded['timing']).toEqual({});
    expect(upgraded['unavailable']).toEqual([
      'F14:absent',
      'F15:absent',
      'agentType:absent',
      'skills:absent',
    ]);
    // And it is a record the validator accepts, which is the whole point of
    // giving it the shape rather than just the version.
    expect(validateStatsRecord(upgraded).errors).toEqual([]);
  });

  it('a v2 record reads as v3, keeps its timing, and names the two new gaps', () => {
    const upgraded = upgradeStatsRecord(v2Record()) as Record<string, unknown>;
    expect(upgraded['statsSchemaVersion']).toBe(3);
    expect(upgraded['skills']).toEqual([]);
    // Its own timing survives — it is not a v1 record and must not be treated
    // as one.
    expect(upgraded['timing']).toEqual({ wallMs: 1_000 });
    expect(upgraded['unavailable']).toEqual(['agentType:absent', 'skills:absent']);
    expect(validateStatsRecord(upgraded).errors).toEqual([]);
  });

  it('no agent gains an agentType — absent is absent, never a substitute', () => {
    const upgraded = upgradeStatsRecord(v1Record()) as { agents: Record<string, unknown>[] };
    for (const agent of upgraded.agents) {
      expect(agent['agentType']).toBeUndefined();
      // The v1 gap R3 already named.
      expect(agent['resultUnreceived']).toBe(false);
    }
  });

  it('does not mutate its input', () => {
    const original = v1Record();
    const snapshot = JSON.stringify(original);
    upgradeStatsRecord(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('a current-version record is returned unchanged', () => {
    const current = { statsSchemaVersion: STATS_SCHEMA_VERSION, skills: [{ name: 'x', seq: 0 }] };
    expect(upgradeStatsRecord(current)).toBe(current);
  });

  it('a version outside the readable list is not upgraded', () => {
    const future = { statsSchemaVersion: 99, skills: [] };
    expect(upgradeStatsRecord(future)).toBe(future);
    // And the validator still refuses it, which is what makes the list the
    // thing that decides.
    expect(validateStatsRecord(future).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A real store file holding old lines
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('the store reads a file 0.7.x and 0.8.x wrote', () => {
  it('reads both old lines, marks them, and leaves the file byte-identical', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-v3-'));
    roots.push(root);

    const { StatsStore } = await import('./store.js');
    const store = new StatsStore({ dir: root, enabled: true, retentionDays: 90 });

    // The file the way 0.7.x and 0.8.x left it: one JSON object per line, in
    // the `stats-<year>-W<week>.jsonl` name the reader globs for.
    const file = join(root, 'stats-2026-W37.jsonl');
    const body =
      `${JSON.stringify({ ...v1Record('s-v1'), derivedAt: 1_700_000_000_000 })}\n` +
      `${JSON.stringify({ ...v2Record('s-v2'), derivedAt: 1_700_000_000_001 })}\n`;
    writeFileSync(file, body, 'utf8');
    const before = readFileSync(file);

    const records = store.readRecords();
    const ids = records.map((r) => r.sessionId).sort();
    expect(ids).toEqual(['s-v1', 's-v2']);

    const byId = new Map(records.map((r) => [r.sessionId, r]));
    expect(byId.get('s-v1')?.unavailable).toEqual([
      'F14:absent',
      'F15:absent',
      'agentType:absent',
      'skills:absent',
    ]);
    expect(byId.get('s-v2')?.unavailable).toEqual(['agentType:absent', 'skills:absent']);
    for (const record of records) {
      expect(record.statsSchemaVersion).toBe(STATS_SCHEMA_VERSION);
      expect(record.skills).toEqual([]);
    }

    // "Never rewritten" is a claim about the FILE.
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});
