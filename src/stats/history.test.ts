/**
 * v0.8.0 DoD 7.14 — history read across schema versions (user ruling R3,
 * 2026-09-13): "Records with an older statsSchemaVersion are READ, never
 * skipped and never rewritten (append-only store). Every field the old record
 * lacks is `unavailable: F14:absent` for that record."
 *
 * THE INPUT IS A REAL 0.7.1 RECORD, not a record typed out here. The fixture
 * under `fixtures/golden/stats-history/` is byte-identical to
 * `v0.7.1:fixtures/golden/stats/cc-2.1.260-75ef0bbf-….json` — a record the
 * shipped 0.7.1 deriver produced from a harvested session — and this test
 * pins that before relying on it (schema 1, no `timing`, no F15 field).
 *
 * THE PATH IS THE PRODUCTION ONE. The record is planted as a line in a store
 * file named the way the store names its files, and read by `StatsStore`,
 * which is what `activate()` constructs. A test that called the upgrade
 * function directly would pass while the store still refused the line.
 *
 * The view half (tables, Trends, the footer) is in `webview/stats/stats-view.test.ts`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { storeFileName } from './retention.js';
import { HISTORY_ABSENT_FACTS, READABLE_STATS_SCHEMA_VERSIONS, STATS_SCHEMA_VERSION } from './schema.js';
import { StatsStore } from './store.js';

const FIXTURE = resolve(
  'fixtures/golden/stats-history/v0.7.1-cc-2.1.260-75ef0bbf-2493-4c77-8af7-3a56fb2ce36e.json',
);

let dir = '';
let file = '';
let planted = '';
let raw: Record<string, unknown> = {};

beforeAll(() => {
  raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
  dir = mkdtempSync(join(tmpdir(), 'agent-deck-history-'));
  const derivedAt = Date.now();
  file = join(dir, storeFileName(derivedAt));
  // One line, exactly as a 0.7.1 store holds it: the record plus `derivedAt`.
  planted = `${JSON.stringify({ ...raw, derivedAt })}\n`;
  writeFileSync(file, planted);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('DoD 7.14 — a record 0.7.1 wrote is read by 0.8.0', () => {
  it('the planted record really is a 0.7.1 record', () => {
    // If this ever reads 2, the test below is reading current data and proves nothing.
    expect(raw['statsSchemaVersion']).toBe(1);
    expect(raw['timing']).toBeUndefined();
    expect((raw['agents'] as Record<string, unknown>[]).every((a) => a['resultUnreceived'] === undefined)).toBe(true);
    expect(STATS_SCHEMA_VERSION).toBe(2);
    expect(READABLE_STATS_SCHEMA_VERSIONS).toStrictEqual([1, 2]);
  });

  it('is READ — not skipped, not counted malformed — with every table intact', () => {
    const store = new StatsStore({ dir, enabled: true, retentionDays: 90 });
    const records = store.readRecords();
    expect(store.malformed).toBe(0);
    expect(records).toHaveLength(1);
    const record = records[0];
    if (record === undefined) throw new Error('no record');
    expect(record.sessionId).toBe(raw['sessionId']);
    // The tables a 0.7.1 build derived, carried whole. Counts read off the
    // fixture itself, then pinned, so an empty read cannot pass.
    expect(record.files).toHaveLength((raw['files'] as unknown[]).length);
    expect(record.files).toHaveLength(81);
    expect(record.churn).toHaveLength(7);
    expect(record.tools).toHaveLength(8);
    expect(record.totals.prompt).toBe((raw['totals'] as Record<string, number>)['prompt']);
  });

  it('names what its version could not carry, and substitutes nothing', () => {
    const store = new StatsStore({ dir, enabled: true, retentionDays: 90 });
    const record = store.readRecords()[0];
    if (record === undefined) throw new Error('no record');
    for (const fact of HISTORY_ABSENT_FACTS[1] ?? []) expect(record.unavailable).toContain(fact);
    expect(record.unavailable).toContain('F14:absent');
    // No time, as a session stating no instant has no time: an empty block.
    expect(record.timing).toStrictEqual({});
    // No F15, as a session stating no spawn edges has none: flag false, count absent.
    expect(record.agents.every((a) => a.resultUnreceived === false)).toBe(true);
    expect(record.totals.subagentsUnreceived).toBeUndefined();
    // The facts it DID state are still stated: nothing it had was named absent.
    for (const fact of raw['unavailable'] as string[]) expect(record.unavailable).toContain(fact);
  });

  it('is never rewritten — the line on disk is byte-identical after two reads', () => {
    const store = new StatsStore({ dir, enabled: true, retentionDays: 90 });
    store.readRecords();
    store.readRecords();
    expect(readFileSync(file, 'utf8')).toBe(planted);
    expect(store.appended).toBe(0);
  });

  it('a version this reader does not know is still refused, and counted', () => {
    // Control: the upgrade is for KNOWN older versions only. A future format
    // means something this build cannot know.
    const futureDir = mkdtempSync(join(tmpdir(), 'agent-deck-history-future-'));
    try {
      const derivedAt = Date.now();
      writeFileSync(
        join(futureDir, storeFileName(derivedAt)),
        `${JSON.stringify({ ...raw, statsSchemaVersion: 3, derivedAt })}\n`,
      );
      const store = new StatsStore({ dir: futureDir, enabled: true, retentionDays: 90 });
      expect(store.readRecords()).toHaveLength(0);
      expect(store.malformed).toBe(1);
    } finally {
      rmSync(futureDir, { recursive: true, force: true });
    }
  });
});
