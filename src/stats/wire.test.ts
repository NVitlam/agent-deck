/**
 * The host-side stats wire gate — v0.7.0 Phase 4, DoD 4.1.
 *
 * "The untrusted-input guard validates each record with the Phase 2
 * validator; a record with an extra string field is dropped and counted." The
 * validator is `validateStatsRecord`; this file proves the gate USES it, drops
 * on its verdict, counts the drop, keeps the rest, and strips the store stamp.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { StatsRecord } from './schema.js';
import { inSessionOrder, statsWireRecords } from './wire.js';

const GOLDEN_DIR = fileURLToPath(new URL('../../fixtures/golden/stats/', import.meta.url));

function goldens(): StatsRecord[] {
  return readdirSync(GOLDEN_DIR)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => JSON.parse(readFileSync(`${GOLDEN_DIR}${n}`, 'utf8')) as StatsRecord);
}

describe('statsWireRecords', () => {
  it('passes every committed golden unchanged', () => {
    const records = goldens();
    expect(records.length).toBeGreaterThan(30);
    const wire = statsWireRecords(records);
    expect(wire.dropped).toBe(0);
    expect(wire.reasons).toStrictEqual([]);
    expect(wire.records).toStrictEqual(records);
  });

  it('drops a record with an EXTRA STRING FIELD, counts it, names it, and keeps the rest', () => {
    const [a, b, c] = goldens();
    if (a === undefined || b === undefined || c === undefined) throw new Error('need three goldens');
    // A label — the single most content-shaped string a record could grow.
    const poisoned = { ...b, agents: [{ ...(b.agents[0] ?? {}), label: 'fix the login bug' }] };
    const wire = statsWireRecords([a, poisoned, c]);
    expect(wire.dropped).toBe(1);
    expect(wire.records.map((r) => r.sessionId)).toStrictEqual([a.sessionId, c.sessionId]);
    expect(wire.reasons).toHaveLength(1);
    expect(wire.reasons[0]).toContain(b.sessionId);
    expect(wire.reasons[0]).toContain("key 'label'");
  });

  it('drops a structural defect too — a missing table — on the validator\'s own verdict', () => {
    const [a] = goldens();
    if (a === undefined) throw new Error('need a golden');
    const { files: _files, ...broken } = a;
    const wire = statsWireRecords([broken]);
    expect(wire.dropped).toBe(1);
    expect(wire.reasons[0]).toContain('files must be an array');
  });

  it('strips the store stamp before judging: a StoredStatsRecord passes, and derivedAt does not travel', () => {
    const [a] = goldens();
    if (a === undefined) throw new Error('need a golden');
    const wire = statsWireRecords([{ ...a, derivedAt: 1_700_000_000_000 }]);
    expect(wire.dropped).toBe(0);
    expect('derivedAt' in (wire.records[0] as object)).toBe(false);
    expect(wire.records[0]).toStrictEqual(a);
  });

  it('never throws, whatever is in the array', () => {
    const wire = statsWireRecords([null, 42, 'x', [], {}, { sessionId: 's' }, undefined]);
    expect(wire.records).toStrictEqual([]);
    expect(wire.dropped).toBe(7);
    expect(wire.reasons).toHaveLength(7);
  });
});

describe('inSessionOrder', () => {
  it('orders by startedAt, then sessionId, and does not mutate its input', () => {
    const input = [
      { sessionId: 'b', startedAt: 20 },
      { sessionId: 'a', startedAt: 20 },
      { sessionId: 'z', startedAt: 5 },
    ];
    const copy = [...input];
    expect(inSessionOrder(input).map((r) => r.sessionId)).toStrictEqual(['z', 'a', 'b']);
    expect(input).toStrictEqual(copy);
  });
});
