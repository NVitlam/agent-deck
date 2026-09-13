/**
 * The Stats view's small text helpers — v0.7.0 Phase 4.
 *
 * Pure, DOM-free, and G10-scanned like everything under `webview/stats/`.
 * `format.ts` owns the em dash and the token formatter; this file owns only
 * what the stats surface needs beyond them.
 */

import { EM_DASH, formatDuration } from '../format.js';
import type { SessionRef } from './layout.js';

/** The engines, as a person reads them. The deck's chips use the same words. */
export const ENGINE_NAMES: Readonly<Record<SessionRef['engine'], string>> = {
  cc: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
};

/**
 * A session's PRIMARY text (labels law, DoD 4.5): the live session's label
 * when the session is on the deck, else the engine and the start time. Never
 * the id and never the slug — those are secondary, mono, muted.
 */
export function sessionPrimary(ref: SessionRef, liveLabels: ReadonlyMap<string, string>): string {
  const label = liveLabels.get(ref.sessionId);
  if (label !== undefined && label !== '' && label !== ref.sessionId) return label;
  return `${ENGINE_NAMES[ref.engine]} session, ${startedAtText(ref.startedAt)}`;
}

/** `2026-09-08 13:05 UTC`, or the em dash for a start nobody stated. */
export function startedAtText(startedAt: number): string {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return EM_DASH;
  const iso = new Date(startedAt).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** A ratio as a percentage with one decimal, or the em dash. */
export function formatRatio(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * A cost in USD with four decimals — a user-priced session can be a fraction
 * of a cent, and two decimals would print `0.00` for a figure that exists.
 * Absent is the em dash; 0 is printed as 0, because a record carries a cost
 * only when a source computed one (`costSource` is present iff `costUsd` is).
 */
export function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${value.toFixed(4)} USD`;
}

/**
 * A span of milliseconds — F14's three durations and F2's two — or the em dash.
 *
 * v0.8.0 Phase 7, DoD 7.3 / 7.5. The scaling is `format.ts`'s `formatDuration`,
 * unchanged, so a duration reads the same here as it does on a tool node in the
 * inspector. Two cases are handled here instead, because `formatDuration`
 * answers both with the em dash and only one of them is an absence:
 *
 *   - **ABSENT** is the em dash, and that is the whole point of the column. An
 *     engine that timestamps no call states no duration, and §D forbids a
 *     substitute; `0ms` would claim a call that took no time.
 *   - **NEGATIVE** is printed WITH ITS SIGN. `TimingStats.longestGapMs` is
 *     documented as able to run backwards — the session-wide call order is
 *     structural, so the pair crossing from one agent to the next can precede
 *     it in time — and `timing.ts` deliberately does not clamp it. Rendering a
 *     stated negative as the em dash would report a measured value as a
 *     missing one, which is the same defect as a zero standing in for an
 *     absence, in the other direction.
 *
 * `0` is a real answer and prints as `0ms`: `timeToFirstToolMs` is 0 whenever
 * a session's first tool call IS its first stated instant.
 */
export function formatSpan(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return EM_DASH;
  return ms < 0 ? `-${formatDuration(-ms)}` : formatDuration(ms);
}

/**
 * A rate, or the em dash — F14's `tokensPerMin` and `callsPerMin`.
 *
 * The record carries the EXACT IEEE quotient by design (`timing.ts`: "rounding
 * is presentation and belongs to the renderer"), so the rounding is here and
 * only here. Two decimals below 10 and one above, with the integer part grouped
 * in threes: a rate of 0.83 calls a minute and a rate of 5,733,000 tokens a
 * minute are both real on this corpus, and one rule at one precision makes the
 * first read as `0.8` or the second as an unreadable run of digits.
 */
export function formatRate(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return EM_DASH;
  const text = Math.abs(value) < 10 ? value.toFixed(2) : value.toFixed(1);
  const [whole = '', fraction = ''] = text.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign === '' ? whole : whole.slice(1);
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

/** The first characters of an id, for the secondary slot. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Copy text to the clipboard, where the host allows it.
 *
 * `navigator.clipboard` is the only channel and it is LOCAL: no fetch, no
 * socket, nothing leaves the machine (G5). A webview that has not been
 * granted it simply does nothing, and the id stays selectable on screen.
 * Returns whether a copy was attempted, so a test can assert the wiring.
 */
export function copyText(text: string): boolean {
  const nav = (globalThis as { navigator?: { clipboard?: { writeText(t: string): Promise<void> } } })
    .navigator;
  const clipboard = nav?.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') return false;
  try {
    void clipboard.writeText(text).catch(() => {});
  } catch {
    return false;
  }
  return true;
}
