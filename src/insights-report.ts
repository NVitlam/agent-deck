/**
 * One run's REPORT, as words — v0.9.0 DoD 9.46 and 9.47.
 *
 * Spec `Amendment 2026-09-23 — Paid Insights surface, export, provider v1
 * growth`: the preview renders a selected run "exactly like the latest
 * report", and Export builds HTML, Markdown and plain text "only from
 * `FindingSetView`". This module is the one function both do it with, so a
 * preview and the file exported from it cannot say different things.
 *
 * It was the provider half of `webview/insights/layout.ts` until DoD 9.46,
 * and moved here, beside the host, because the host now renders it too:
 * `src/insights-export.ts` writes files the webview never sees. The layout
 * re-exports every name, so nothing that imported it there moved.
 *
 * A pure function of the set: no clock, no provider, no DOM, no `vscode`.
 *
 * ## The order is the 2026-09-22 amendment's
 *
 * The run's own facts head the report. Each finding reads its action's LEAD
 * first, then what kind it is, the detail, the cause, and the evidence with
 * its labels. Kind, confidence and "since last run" sit beside the lead as
 * WORDS — no score. A Claude Code run's usage says it is
 * {@link ESTIMATED_BY_CLAUDE_CODE}. A refused run shows its step and reason.
 */

import type {
  FindingSetView,
  FindingSinceLastRun,
  FindingView,
  InsightsAgentKind,
  InsightsFindingKind,
  InsightsRunState,
  RunSummary,
} from './model/events.js';

/** The parent's own name for each finding kind, shown beside the provider's lead. */
export const FINDING_LABELS: Readonly<Record<InsightsFindingKind, string>> = Object.freeze({
  're-read-loop': 'Re-read loop',
  'churn-chain': 'Churn chain',
  'context-churn': 'Context churn',
  stall: 'Stall',
  'silent-subagent': 'Silent subagent',
  compaction: 'Compaction',
  'cache-miss': 'Cache miss',
  other: 'Other pattern',
});

/** The agent CLI a run used, by the name the rest of the product gives it. */
export const AGENT_LABELS: Readonly<Record<InsightsAgentKind, string>> = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
});

/**
 * The words on a Claude Code run's usage, verbatim from the 2026-09-22
 * amendment: Claude Code's own usage and cost are its estimate. A Codex
 * run's line carries no such words.
 */
export const ESTIMATED_BY_CLAUDE_CODE = 'estimated by Claude Code';

/**
 * The head of the line naming kinds no longer reported — verbatim, round 5b
 * of 2026-09-22. The kinds follow in the parent's own labels.
 */
export const NO_LONGER_REPORTED = 'No longer reported:';

/** "Since last run", as a word. No score, no arrow, no colour of its own. */
export const SINCE_LAST_RUN_WORDS: Readonly<Record<FindingSinceLastRun, string>> = Object.freeze({
  new: 'new',
  still: 'still',
  resolved: 'resolved',
});

/** A count as the surfaces print it: `12,345`. */
export function formatCount(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A number as stated, with its whole part grouped: `28,100,113`, `1,234.5`.
 * Unlike {@link formatCount} it drops nothing: the raw number stays whole
 * beside its duration (DoD 9.59).
 */
function groupedRaw(n: number): string {
  const text = String(n);
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const rest = dot === -1 ? '' : text.slice(dot);
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${rest}`;
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DURATION_DAY_MS = 24 * HOUR_MS;

/**
 * Milliseconds as a human duration — v0.9.0 DoD 9.59: `7 h 48 m`, `2 m`,
 * `12 s`, `under 1 s`. At most two units, the smaller left out when it is
 * zero; every unit TRUNCATED, never rounded, so the duration never claims
 * more time than the number beside it. Deterministic: no clock, no locale.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  const pair = (big: number, bigUnit: string, unit: number, smallUnit: string): string => {
    const high = Math.trunc(abs / big);
    const low = Math.trunc((abs - high * big) / unit);
    return `${sign}${String(high)} ${bigUnit}${low === 0 ? '' : ` ${String(low)} ${smallUnit}`}`;
  };
  if (abs < SECOND_MS) return `${sign}under 1 s`;
  if (abs < MINUTE_MS) return `${sign}${String(Math.trunc(abs / SECOND_MS))} s`;
  if (abs < HOUR_MS) return pair(MINUTE_MS, 'm', SECOND_MS, 's');
  if (abs < DURATION_DAY_MS) return pair(HOUR_MS, 'h', MINUTE_MS, 'm');
  return pair(DURATION_DAY_MS, 'd', HOUR_MS, 'h');
}

/**
 * A millisecond value as every Insights surface prints it — DoD 9.59:
 * `28,100,113 ms · 7 h 48 m`. The raw number first and whole, the duration
 * beside it.
 */
export function formatMs(ms: number): string {
  return `${groupedRaw(ms)} ms · ${formatDuration(ms)}`;
}

/**
 * A `statsKey`'s last segment, its array index dropped:
 * `sessions[0].tools[2].durationMsMax` → `durationMsMax`.
 */
function lastSegment(statsKey: string): string {
  const tail = statsKey.slice(statsKey.lastIndexOf('.') + 1);
  return tail.replace(/\[\d+\]$/, '');
}

/**
 * Whether a `statsKey` names a millisecond value — round 9b: its last
 * segment carries `Ms` as a camel-case WORD, at its end or before another
 * word. So `longestGapMs`, `gapBeforeMs`, `durationMsSum` and
 * `durationMsMax` all render alike (the Insights v3 smoke found the last two
 * printed raw under the round-9 rule, which read "ends in `Ms`"). Every such
 * key in the stats record is a duration; none is an instant.
 */
export function isMsKey(statsKey: string): boolean {
  return /Ms(?=[A-Z]|$)/.test(lastSegment(statsKey));
}

/** The ratios the stats record carries, printed to two places (round 9b). */
const RATIO_KEYS: ReadonlySet<string> = new Set(['cacheRatio', 'contextFill']);

/**
 * How a number at this key is SHOWN — round 9b. `null` prints it as stated.
 *
 *   - a cost (`costUsd`, `costPerHourUsd`: the segment ends in `Usd`) and a
 *     ratio ({@link RATIO_KEYS}): two places;
 *   - a per-minute rate (`tokensPerMin`, `callsPerMin`): a whole number.
 *
 * `costPerHourUsd` is a per-hour rate AND a cost; it is printed as a cost,
 * because a whole number of dollars an hour reads a 0.37 USD hour as `0`.
 */
function roundedOf(statsKey: string, value: number): string | null {
  const segment = lastSegment(statsKey);
  if (segment.endsWith('Usd') || RATIO_KEYS.has(segment)) return value.toFixed(2);
  if (/Per(?:Min|Hour)$/.test(segment)) return formatCount(Math.round(value));
  return null;
}

/** An evidence value as the report prints it, and the exact number when that differs. */
export interface EvidenceText {
  readonly value: string;
  /** The number as stated, present only when {@link EvidenceText.value} rounds it. */
  readonly exact?: string;
}

/** An evidence value as the report prints it. */
export function evidenceText(statsKey: string, value: number | string): EvidenceText {
  if (typeof value !== 'number') return { value };
  if (isMsKey(statsKey)) return { value: formatMs(value) };
  const exact = String(value);
  const rounded = roundedOf(statsKey, value);
  if (rounded === null || rounded === exact) return { value: exact };
  return { value: rounded, exact };
}

/** {@link evidenceText}'s printed half. */
export function evidenceValue(statsKey: string, value: number | string): string {
  return evidenceText(statsKey, value).value;
}

/** An instant as the surfaces print it: `2026-09-21 14:05 UTC`. */
export function formatInstant(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * A cost as the surfaces print it. Two places, or four under a cent: a run
 * that cost 0.004 USD printed as `0.00 USD` is a confident zero standing
 * where a number is.
 */
export function formatUsd(usd: number): string {
  return `${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)} USD`;
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** One labelled piece of evidence. */
export interface EvidenceRow {
  readonly label: string;
  /** The value as the report prints it — see {@link evidenceText}. */
  readonly value: string;
  /**
   * The number exactly as the provider stated it, present only where
   * `value` rounds it (round 9b): the surface's tooltip, the HTML export's
   * `title`, and beside the value in Markdown and plain text.
   */
  readonly exact?: string;
  /** Where it is from: `statsKey · sessionId`. */
  readonly source: string;
}

/**
 * One finding, in the amendment's order: the action's LEAD first, then what
 * kind it is, the detail behind an expand, the cause, and the evidence.
 */
export interface FindingRow {
  readonly lead: string;
  /** `Re-read loop · high confidence · since last run: new`. */
  readonly meta: string;
  /** `''` for a one-sentence action (round 5b), which shows no expand. */
  readonly detail: string;
  readonly cause: string;
  readonly evidence: readonly EvidenceRow[];
}

/** A run's facts, above its findings. */
export interface RunFacts {
  /** `Report · 2026-09-21 10:00 UTC`. */
  readonly heading: string;
  /** `Claude Code 2.1.246`. */
  readonly agent: string;
  readonly window: string;
  /** The run's own usage, or `null` when the provider stated none. */
  readonly usage: string | null;
}

/** Everything one run's report says, in the order it says it. */
export interface RunReport {
  readonly state: InsightsRunState;
  readonly facts: RunFacts;
  readonly findings: readonly FindingRow[];
  /** A line when there is no finding to show, saying which of two reasons. */
  readonly note?: string;
  /** A refused run's step and reason. */
  readonly refusal?: { readonly step: string; readonly reason: string };
  /** Present when the provider's own validator rejected any. */
  readonly rejected?: string;
  /** "No longer reported: <kinds>", when the set names any (round 5b). */
  readonly resolved?: string;
  /**
   * How many values of this set the PARENT's check dropped, as a sentence —
   * present when any were. Part of the report, not of the preview, so an
   * export says it too (verifier round 9.48, D3: a preview and its export
   * disagreed about a set with a dropped finding).
   */
  readonly dropped?: string;
}

/**
 * "N values ... did not pass the check and are not shown" — the one wording
 * every surface and every export uses for a drop, or `undefined` for none.
 */
export function droppedLine(n: number, what: string): string | undefined {
  if (n <= 0) return undefined;
  return `${plural(n, 'value')} ${what} did not pass the check and ${n === 1 ? 'is' : 'are'} not shown`;
}

/** The heading's word. "Report", not "Latest run": an older run is not the latest. */
export const REPORT_HEADING = 'Report';

function factsOf(set: FindingSetView): RunFacts {
  const excluded = set.window.excluded > 0 ? `; ${formatCount(set.window.excluded)} excluded` : '';
  let usage: string | null = null;
  if (set.usage !== null) {
    const parts = [
      plural(set.usage.prompt, 'prompt token'),
      plural(set.usage.output, 'output token'),
      ...(set.usage.costUsd === undefined ? [] : [formatUsd(set.usage.costUsd)]),
    ];
    const estimated = set.agent.kind === 'claude' ? ` (${ESTIMATED_BY_CLAUDE_CODE})` : '';
    usage = `Run usage: ${parts.join(' · ')}${estimated}`;
  }
  return {
    heading: `${REPORT_HEADING} · ${formatInstant(set.createdAt)}`,
    agent: `${AGENT_LABELS[set.agent.kind]} ${set.agent.version}`,
    window: `${plural(set.window.sessions, 'session')} since ${formatInstant(set.window.sinceMs)}${excluded}`,
    usage,
  };
}

function findingOf(finding: FindingView): FindingRow {
  const since =
    finding.sinceLastRun === null ? '' : ` · since last run: ${SINCE_LAST_RUN_WORDS[finding.sinceLastRun]}`;
  return {
    lead: finding.action.lead,
    meta: `${FINDING_LABELS[finding.kind]} · ${finding.confidence} confidence${since}`,
    detail: finding.action.detail,
    cause: finding.cause,
    evidence: finding.evidence.map((item) => ({
      label: item.label,
      // DoD 9.59 and round 9b — a `...Ms` number carries its duration; a
      // cost, a ratio or a per-minute rate is rounded, with the exact number
      // kept beside it. The source line is untouched: provenance is the
      // statsKey as stated.
      ...evidenceText(item.statsKey, item.value),
      source: `${item.statsKey} · ${item.sessionId}`,
    })),
  };
}

/**
 * One run's report, from its checked set and how many of its values the
 * check dropped on the way (`Checked.dropped`, 0 when none).
 */
export function reportOf(set: FindingSetView, dropped = 0): RunReport {
  const droppedText = droppedLine(dropped, 'from this report');
  const findings = set.findings.map(findingOf);
  let note: string | undefined;
  if (set.state === 'empty') note = 'The run read the window and recorded no findings.';
  // `ok` promises at least one finding; none left here means the parent
  // dropped every one, and the drop line says how many.
  else if (set.state === 'ok' && findings.length === 0) note = 'No finding from this run passed the check.';
  return {
    state: set.state,
    facts: factsOf(set),
    findings,
    ...(note === undefined ? {} : { note }),
    ...(set.refusal === undefined ? {} : { refusal: { step: set.refusal.step, reason: set.refusal.reason } }),
    ...(set.resolvedKinds.length > 0
      ? {
          resolved: `${NO_LONGER_REPORTED} ${set.resolvedKinds
            .map((kind) => FINDING_LABELS[kind as InsightsFindingKind] ?? kind)
            .join(', ')}`,
        }
      : {}),
    ...(set.rejected > 0
      ? { rejected: `${plural(set.rejected, 'finding')} rejected by the provider` }
      : {}),
    ...(droppedText === undefined ? {} : { dropped: droppedText }),
  };
}

/** A run's outcome in one word or two: `2 findings`, `no findings`, `refused`. */
export function outcomeOf(run: Pick<RunSummary, 'state' | 'findings'>): string {
  if (run.state === 'refused') return 'refused';
  if (run.state === 'empty') return 'no findings';
  return plural(run.findings, 'finding');
}
