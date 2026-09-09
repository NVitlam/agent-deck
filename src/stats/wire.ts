/**
 * The host-side gate a `StatsRecord` passes before it reaches the webview —
 * v0.7.0 Phase 4, DoD 4.1.
 *
 * ## The validator runs HERE, on the host, and nowhere else
 *
 * `messages.ts` guards the INBOUND direction because a webview is untrusted
 * input. The OUTBOUND direction carries what a trusted host derived, and the
 * plan is explicit that no untrusted-input guard is to be invented for it.
 * What is asserted instead is the G4 property at the last point the host can
 * assert it: every record on the wire has passed `validateStatsRecord`, the
 * Phase 2 allow-list walk, so a string field nobody declared cannot reach a
 * renderer even in principle.
 *
 * A record that fails is DROPPED AND COUNTED — the `dropped-actions` pattern
 * from Phase 5.5: the good records still go out, the bad one is named on the
 * diagnostics channel once, and the counters line carries the running total
 * (`statsDropped`). Dropping the whole message for one bad record would let
 * one defective session blank the entire Stats view.
 *
 * ## What is stripped
 *
 * `derivedAt`. It is the STORE's stamp (`StoredStatsRecord`), not a fact about
 * the session, and spec §H exposes `StatsRecord` only. The strip happens before
 * validation so a store line is judged on the same shape a live record is.
 */

import type { StatsRecord } from './schema.js';
import { validateStatsRecord } from './schema.js';

/** What the gate produced, and what it refused. */
export interface StatsWire {
  records: StatsRecord[];
  /** How many input records were refused. */
  dropped: number;
  /** One reason per refused record, in input order. For the diagnostics line. */
  reasons: string[];
}

/**
 * Validate, strip the store stamp, and keep only what passes.
 *
 * Total: never throws on any input element, because a throw here would take
 * the panel's publish down with it (the same G2 guard `AgentDeckHost` keeps
 * around the pipeline).
 */
export function statsWireRecords(records: readonly unknown[]): StatsWire {
  const out: StatsRecord[] = [];
  const reasons: string[] = [];
  for (const raw of records) {
    let candidate: unknown = raw;
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const { derivedAt: _stamp, ...rest } = raw as Record<string, unknown>;
      candidate = rest;
    }
    const verdict = validateStatsRecord(candidate);
    if (!verdict.ok) {
      const id =
        candidate !== null && typeof candidate === 'object'
          ? String((candidate as { sessionId?: unknown }).sessionId ?? 'unknown')
          : 'unknown';
      reasons.push(`${id}: ${verdict.errors[0] ?? 'invalid'}`);
      continue;
    }
    out.push(candidate as StatsRecord);
  }
  return { records: out, dropped: reasons.length, reasons };
}

/**
 * The Trends order: `startedAt` ascending, then `sessionId`.
 *
 * "One point per session, in session order" (locked open question). Stable
 * and total, so the same store contents always produce the same order and
 * the webview's incremental property — adding a record moves no existing
 * point — holds for a record that started later than every stored one.
 */
export function inSessionOrder<T extends { startedAt: number; sessionId: string }>(
  records: readonly T[],
): T[] {
  return [...records].sort(
    (a, b) =>
      a.startedAt - b.startedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
  );
}
