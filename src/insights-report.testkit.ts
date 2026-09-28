/**
 * The Insights report FIXTURE SETS — v0.9.0 DoD 9.46, 9.47.
 *
 * One place, read by two suites: `src/insights-facts.test.ts` renders each
 * through the surface's layout against `webview/goldens/insights/`, and
 * `src/insights-export.test.ts` writes each through all three export formats
 * against `webview/goldens/export/`. The DoD's "golden files per format from
 * every fixture set" is a claim about THESE sets, and holding them in one
 * module is what makes it one claim rather than two lists kept in step.
 *
 * The four of DoD 9.41 — an `ok` set carrying every finding kind, an `empty`
 * one, a `refused` one and one of mixed evidence — plus {@link HOSTILE_SET},
 * whose provider text is markup, Markdown syntax and a remote image, for the
 * export's no-external-resource and escaping tests.
 *
 * Every id and path is synthetic (`ses_example*`, `repo/`).
 */

import type { FindingSetView, FindingView } from './model/events.js';
import { FINDING_KINDS } from './insights-provider.js';

/** The instant every set is stated against. */
export const REPORT_NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

const DAY = 86_400_000;

/** "Since last run", cycled through every value and `null`. */
export const FINDING_SINCE = ['new', 'still', 'resolved', null] as const;

/** A checked finding as the host would send it. Neutral text: no advice words. */
export function reportFinding(index: number, over: Partial<FindingView> = {}): FindingView {
  const kind = FINDING_KINDS[index % FINDING_KINDS.length] as FindingView['kind'];
  return {
    id: `f-${String(index)}`,
    kind,
    confidence: (['low', 'medium', 'high'] as const)[index % 3] as FindingView['confidence'],
    action: {
      lead: `Lead line ${String(index)} for ${kind}`,
      detail: `Detail paragraph ${String(index)}.\nIt spans two lines.`,
    },
    cause: `Cause sentence ${String(index)}.`,
    evidence: [
      { label: 'Prompt tokens', sessionId: 'ses_example01', statsKey: 'sessions[0].totals.prompt', value: 128_400 },
    ],
    sinceLastRun: FINDING_SINCE[index % FINDING_SINCE.length] ?? null,
    ...over,
  };
}

/** The four sets DoD 9.41 names — each one run's checked set. */
export const REPORT_SETS: Readonly<Record<'ok' | 'empty' | 'refused' | 'mixed-evidence', FindingSetView>> = {
  ok: {
    runId: 'run-3',
    createdAt: REPORT_NOW,
    agent: { kind: 'claude', version: '2.1.246' },
    window: { sessions: 12, excluded: 2, sinceMs: REPORT_NOW - 7 * DAY },
    usage: { prompt: 48_210, output: 3_904, costUsd: 0.2381 },
    findings: FINDING_KINDS.map((_, index) => reportFinding(index)),
    resolvedKinds: [],
    rejected: 1,
    state: 'ok',
  },
  empty: {
    runId: 'run-2',
    createdAt: REPORT_NOW - DAY,
    agent: { kind: 'codex', version: '0.151.0-alpha.7.2' },
    window: { sessions: 1, excluded: 0, sinceMs: REPORT_NOW - 2 * DAY },
    usage: { prompt: 9_000, output: 400 },
    findings: [],
    resolvedKinds: [],
    rejected: 0,
    state: 'empty',
  },
  refused: {
    runId: 'run-1',
    createdAt: REPORT_NOW - 2 * DAY,
    agent: { kind: 'claude', version: '2.1.246' },
    window: { sessions: 4, excluded: 0, sinceMs: REPORT_NOW - 9 * DAY },
    usage: null,
    findings: [],
    resolvedKinds: [],
    rejected: 0,
    state: 'refused',
    refusal: { step: 'validate', reason: 'The response held no JSON object.\nNothing was stored.' },
  },
  'mixed-evidence': {
    runId: 'run-4',
    createdAt: REPORT_NOW - 3 * DAY,
    agent: { kind: 'claude', version: '2.1.246' },
    window: { sessions: 3, excluded: 0, sinceMs: REPORT_NOW - 10 * DAY },
    usage: { prompt: 1_000, output: 100, costUsd: 0.004 },
    findings: [
      reportFinding(0, {
        action: { lead: 'Lead line 0 for re-read-loop', detail: '' },
        evidence: [
          { label: 'Reads', sessionId: 'ses_example01', statsKey: 'sessions[0].loops[0].count', value: 7 },
          { label: 'File', sessionId: 'ses_example01', statsKey: 'sessions[0].files[2].filePath', value: 'repo/docs/schema.md' },
          { label: 'Skill', sessionId: 'ses_example02', statsKey: 'sessions[1].skills[0].name', value: 'phase' },
          { label: 'Cache ratio', sessionId: 'ses_example02', statsKey: 'sessions[1].totals.prompt', value: 0.11 },
          // DoD 9.59 and round 9b — every `Ms` key prints with a duration:
          // `longestGapMs`, `gapBeforeMs`, `durationMsSum` and `durationMsMax`.
          { label: 'Longest gap', sessionId: 'ses_example01', statsKey: 'sessions[0].timing.longestGapMs', value: 28_100_113 },
          { label: 'Gap before spike', sessionId: 'ses_example02', statsKey: 'sessions[1].contextChurn[0].gapBeforeMs', value: 312_450 },
          { label: 'Duration sum', sessionId: 'ses_example02', statsKey: 'sessions[1].tools[0].durationMsSum', value: 90_500 },
          { label: 'Duration max', sessionId: 'ses_example02', statsKey: 'sessions[1].tools[0].durationMsMax', value: 61_250 },
          // Round 9b — floats: a cost and a ratio to two places, a
          // per-minute rate to a whole number, the exact value beside.
          { label: 'Cost', sessionId: 'ses_example01', statsKey: 'sessions[0].totals.costUsd', value: 0.238149 },
          { label: 'Cost per hour', sessionId: 'ses_example01', statsKey: 'sessions[0].timing.costPerHourUsd', value: 0.37125 },
          { label: 'Cache ratio', sessionId: 'ses_example01', statsKey: 'sessions[0].agents[0].cacheRatio', value: 0.8234567 },
          { label: 'Context fill', sessionId: 'ses_example01', statsKey: 'sessions[0].totals.contextFill', value: 0.4 },
          { label: 'Tokens per minute', sessionId: 'ses_example01', statsKey: 'sessions[0].timing.tokensPerMin', value: 1_234.5678 },
          { label: 'Calls per minute', sessionId: 'ses_example01', statsKey: 'sessions[0].timing.callsPerMin', value: 3 },
        ],
      }),
    ],
    resolvedKinds: ['stall', 'cache-miss'],
    rejected: 0,
    state: 'ok',
  },
};

/**
 * A REFUSED set whose step and reason try to be markup — verifier round
 * 9.48, W1: the hostile set above has no refusal, so the step's escaping in
 * HTML and Markdown went unexercised.
 */
export const HOSTILE_REFUSED_SET: FindingSetView = {
  runId: 'run-hostile-refused',
  createdAt: REPORT_NOW - DAY,
  agent: { kind: 'codex', version: '0.151.0' },
  window: { sessions: 2, excluded: 1, sinceMs: REPORT_NOW - 3 * DAY },
  usage: null,
  findings: [],
  resolvedKinds: [],
  rejected: 0,
  state: 'refused',
  refusal: {
    step: '<img src=x onerror=y> ![s](https://example.invalid/s.png)',
    reason: '<script src="https://example.invalid/r.js"></script>\n[r](https://example.invalid/) | # *',
  },
};

/**
 * A set whose provider text tries to be markup — HTML elements that load
 * things, a Markdown image and link, a code fence, a table cell — all of it
 * text the check admits (markup is not refused; it is escaped). Used to prove
 * no export turns provider text into a resource.
 */
export const HOSTILE_SET: FindingSetView = {
  runId: 'run-hostile:1',
  createdAt: REPORT_NOW,
  agent: { kind: 'claude', version: '2.1.246' },
  window: { sessions: 1, excluded: 0, sinceMs: REPORT_NOW - DAY },
  usage: null,
  findings: [
    reportFinding(1, {
      action: {
        lead: '<img src="https://example.invalid/t.png"> ![x](https://example.invalid/i.png)',
        detail: '<script src="https://example.invalid/s.js"></script>\n[link](https://example.invalid/)\n```\ncode\n```',
      },
      cause: '<iframe src="https://example.invalid/f"></iframe> <link rel="stylesheet" href="https://example.invalid/c.css"> | cell | *em* _em_ ~~s~~ # h <https://example.invalid/a>',
      evidence: [
        { label: '<b>label</b>', sessionId: 'ses_example01', statsKey: 'sessions[0].files[0].filePath', value: 'repo/<img src=x onerror=y>.md' },
      ],
    }),
  ],
  resolvedKinds: [],
  rejected: 0,
  state: 'ok',
};
