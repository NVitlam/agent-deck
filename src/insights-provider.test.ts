/**
 * API v2 — the Insights provider contract (v0.9.0 DoD 9.30), WIDENED by DoD
 * 9.40 (spec `Amendment 2026-09-22 — Provider contract v1 widened
 * (pre-publish; API_VERSION stays 2)`).
 *
 * What is held here:
 *
 *  1. THE TYPES, pinned at compile time: the provider's shape and every view
 *     is the amendment's, key for key — so a field added on either side is a
 *     compile error here before it is anything else.
 *  2. THE ALLOW-LIST. Every string a provider returns is an enumeration
 *     member, matches a strict shape, or is TEXT of one class — a name (64),
 *     a path (1,024) or free text (2,000) — with no control character, no
 *     bidirectional override and no lone surrogate. A string evidence value
 *     only where the store allows a string. Anything else is DROPPED AND
 *     COUNTED, never truncated: each cap is driven at the cap and one past it.
 *  3. ONE PROVIDER AT A TIME, a second refused BY NAME.
 *  4. THE PARENT CALLS NOTHING ELSE: a provider wrapped in a Proxy records
 *     every property the registry touches.
 *  5. `onDidChange`, the optional ACTIONS (DoD 9.44) and DISPOSAL.
 *  6. RAW OUTPUT: optional, asked only for the SELECTED run when it is listed
 *     and refused, refused whole over its cap.
 *  7. DoD 9.44 — `getRun` answers for the run ASKED, the list is sorted
 *     newest first, the selection previews only a listed run, and
 *     `about.status` is a name.
 */

import { describe, expect, it } from 'vitest';

import type {
  FindingActionView,
  FindingEvidenceView,
  FindingSetView,
  FindingView,
  InsightsConfidence,
  InsightsFindingKind,
  InsightsProviderAction,
  InsightsProviderSnapshot,
  InsightsRunPreview,
  RunSummary,
} from './model/events.js';
import type { InsightsProvider, ProviderEvent, TextClass } from './insights-provider.js';
import {
  CONFIDENCES,
  FINDING_KINDS,
  FREE_TEXT_MAX_CHARS,
  InsightsProviderRegistry,
  LEAD_MAX_WORDS,
  MAX_EVIDENCE,
  MAX_FINDINGS,
  MAX_RUNS,
  PROVIDER_VERSION,
  PROVIDER_ACTIONS,
  RAW_OUTPUT_MAX_CHARS,
  TEXT_CAPS,
  stringEvidenceClass,
  viewOfAbout,
  viewOfFindingSet,
  viewOfRunSet,
  viewOfRuns,
  providerErrorText,
} from './insights-provider.js';
import { NAME_MAX_CHARS, PATH_MAX_CHARS, STATS_STRING_CAPS } from './stats/schema.js';

/* ------------------------------------------------------------------------ *
 * 1. The types — compile-time
 * ------------------------------------------------------------------------ */

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The amendment's provider shape, written out, and held equal to the export. */
interface AmendmentProvider {
  readonly providerVersion: 1;
  readonly about: { name: string; version: string; status?: string };
  getLatest(): FindingSetView | null;
  listRuns(): RunSummary[];
  getRun(runId: string): FindingSetView | null;
  run?(): Promise<void>;
  getRawOutput?(runId: string): string | null;
  pickAgent?(): Promise<void>;
  showPayload?(): Promise<void>;
  clearHistory?(): Promise<void>;
  investigate?(runId: string): Promise<void>;
  readonly onDidChange: ProviderEvent<void>;
}

/** The amendment's finding view, written out. */
interface AmendmentFinding {
  id: string;
  kind: InsightsFindingKind;
  confidence: InsightsConfidence;
  action: { lead: string; detail: string };
  cause: string;
  evidence: { label: string; sessionId: string; statsKey: string; value: number | string }[];
  sinceLastRun: 'new' | 'still' | 'resolved' | null;
}

/** The amendment's set view, written out. */
interface AmendmentSet {
  runId: string;
  createdAt: number;
  agent: { kind: 'claude' | 'codex'; version: string };
  window: { sessions: number; excluded: number; sinceMs: number };
  usage: { prompt: number; output: number; costUsd?: number } | null;
  resolvedKinds: string[];
  findings: FindingView[];
  rejected: number;
  state: 'ok' | 'empty' | 'refused';
  refusal?: { step: string; reason: string };
}

/** The amendment's run summary, written out. */
interface AmendmentRun {
  runId: string;
  createdAt: number;
  state: 'ok' | 'empty' | 'refused';
  findings: number;
  agentKind: 'claude' | 'codex';
}

const providerShape: Exact<InsightsProvider, AmendmentProvider> = true;
const findingShape: Exact<FindingView, AmendmentFinding> = true;
const setShape: Exact<FindingSetView, AmendmentSet> = true;
const runShape: Exact<RunSummary, AmendmentRun> = true;
const actionKeys: Exact<keyof FindingActionView, 'lead' | 'detail'> = true;
const evidenceKeys: Exact<keyof FindingEvidenceView, 'label' | 'sessionId' | 'statsKey' | 'value'> = true;
const snapshotKeys: Exact<keyof InsightsProviderSnapshot, 'about' | 'runs' | 'dropped' | 'selected'> = true;
const previewKeys: Exact<keyof InsightsRunPreview, 'runId' | 'set' | 'dropped' | 'rawOutput' | 'investigate'> = true;
const actionNames: Exact<InsightsProviderAction, 'pickAgent' | 'showPayload' | 'clearHistory'> = true;
const kindsExhaustive: Exact<(typeof FINDING_KINDS)[number], InsightsFindingKind> = true;
const confidencesExhaustive: Exact<(typeof CONFIDENCES)[number], InsightsConfidence> = true;

describe('the contract types', () => {
  it('are the amendment’s, key for key (a violation is a compile error)', () => {
    expect([
      providerShape,
      findingShape,
      setShape,
      runShape,
      actionKeys,
      evidenceKeys,
      snapshotKeys,
      previewKeys,
      actionNames,
      kindsExhaustive,
      confidencesExhaustive,
    ]).toStrictEqual(Array.from({ length: 11 }, () => true));
    // The actions, in the Menu's order (DoD 9.45).
    expect([...PROVIDER_ACTIONS]).toStrictEqual(['pickAgent', 'showPayload', 'clearHistory']);
    // Pre-publish widening: neither version moved (the amendment's title).
    expect(PROVIDER_VERSION).toBe(1);
  });

  it('the finding kinds are Insights’ own eight, in its order', () => {
    // Insights' `src/engine/validator.ts` `FINDING_KINDS`, read 2026-09-21.
    expect([...FINDING_KINDS]).toStrictEqual([
      're-read-loop',
      'churn-chain',
      'context-churn',
      'stall',
      'silent-subagent',
      'compaction',
      'cache-miss',
      'other',
    ]);
  });

  it('the text caps are the store’s two and the amendment’s third', () => {
    expect(TEXT_CAPS).toStrictEqual({ name: NAME_MAX_CHARS, path: PATH_MAX_CHARS, free: FREE_TEXT_MAX_CHARS });
    expect([NAME_MAX_CHARS, PATH_MAX_CHARS, FREE_TEXT_MAX_CHARS]).toStrictEqual([64, 1024, 2000]);
    expect(LEAD_MAX_WORDS).toBe(15);
  });
});

/* ------------------------------------------------------------------------ *
 * Builders
 * ------------------------------------------------------------------------ */

type Obj = Record<string, unknown>;

function evidence(over: Obj = {}): Obj {
  return {
    label: 'Reads of the schema file',
    sessionId: 'ses_example01',
    statsKey: 'sessions[0].loops[1].count',
    value: 7,
    ...over,
  };
}

function finding(over: Obj = {}): Obj {
  return {
    id: 'f-1',
    kind: 're-read-loop',
    confidence: 'high',
    action: {
      lead: 'Keep the schema file open between edits',
      detail: 'The agent read the file 7 times.\nEach read followed a failed edit.',
    },
    cause: 'An edit failed and the agent re-read the file before retrying.',
    evidence: [evidence()],
    sinceLastRun: 'new',
    ...over,
  };
}

function findingSet(over: Obj = {}): Obj {
  return {
    runId: 'run-1',
    createdAt: 1_790_000_000_000,
    agent: { kind: 'claude', version: '2.1.246' },
    window: { sessions: 5, excluded: 1, sinceMs: 1_789_400_000_000 },
    usage: { prompt: 12_345, output: 2_345, costUsd: 0.42 },
    resolvedKinds: [],
    findings: [finding()],
    rejected: 0,
    state: 'ok',
    ...over,
  };
}

function refusedSet(over: Obj = {}): Obj {
  return findingSet({
    findings: [],
    state: 'refused',
    refusal: { step: 'validate', reason: 'The model returned no JSON object.' },
    ...over,
  });
}

function run(over: Obj = {}): Obj {
  return {
    runId: 'run-1',
    createdAt: 1_790_000_000_000,
    state: 'ok',
    findings: 1,
    agentKind: 'claude',
    ...over,
  };
}

/** Deep-set `path` (dot-separated, numeric parts index arrays) on a fresh copy. */
function withField(base: Obj, path: string, value: unknown): Obj {
  const copy = structuredClone(base);
  const parts = path.split('.');
  let target: Record<string, unknown> = copy;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  target[parts[parts.length - 1] as string] = value;
  return copy;
}

/** A fake provider with its own change emitter, for the registry tests. */
function fakeProvider(over: Partial<Record<string, unknown>> = {}): {
  provider: InsightsProvider;
  fire: () => void;
  runs: number;
  listeners: number;
} {
  const listeners = new Set<() => unknown>();
  const state = {
    runs: 0,
    get listeners(): number {
      return listeners.size;
    },
  };
  const provider = {
    providerVersion: 1 as const,
    about: { name: 'Agent Deck Insights', version: '0.2.0' },
    getLatest: () => findingSet() as unknown as FindingSetView,
    listRuns: () => [run() as unknown as RunSummary],
    // DoD 9.44: the set of the run asked for — `run-1` is the only one held.
    getRun: (runId: string) => (runId === 'run-1' ? (findingSet() as unknown as FindingSetView) : null),
    run: () => {
      state.runs += 1;
      return Promise.resolve();
    },
    onDidChange: (listener: () => unknown) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    ...over,
  } as unknown as InsightsProvider;
  return {
    provider,
    fire: () => {
      for (const listener of [...listeners]) listener();
    },
    get runs() {
      return state.runs;
    },
    get listeners() {
      return state.listeners;
    },
  };
}

/** One finding in a set of two, checked; how many findings survived and were dropped. */
function checkOne(over: Obj): { kept: number; dropped: number; json: string } {
  const { value, dropped } = viewOfFindingSet(findingSet({ findings: [finding({ id: 'ok' }), over] }));
  return { kept: (value?.findings.length ?? 0) - 1, dropped, json: JSON.stringify(value) };
}

/* ------------------------------------------------------------------------ *
 * 2. The allow-list
 * ------------------------------------------------------------------------ */

describe('a finding set is checked field by field, and copied', () => {
  it('a valid set passes whole, as a FRESH object at every level', () => {
    const input = findingSet();
    const { value, dropped } = viewOfFindingSet(input);
    expect(dropped).toBe(0);
    expect(value).toStrictEqual(input);
    expect(value).not.toBe(input);
    const inputFinding = (input['findings'] as Obj[])[0] as Obj;
    expect(value?.findings[0]).not.toBe(inputFinding);
    expect(value?.findings[0]?.action).not.toBe(inputFinding['action']);
    expect(value?.findings[0]?.evidence[0]).not.toBe((inputFinding['evidence'] as Obj[])[0]);
    expect(value?.usage).not.toBe(input['usage']);
  });

  it('the three states, each whole: ok, empty, refused', () => {
    expect(viewOfFindingSet(findingSet({ findings: [], state: 'empty' })).value?.state).toBe('empty');
    const refused = viewOfFindingSet(refusedSet());
    expect(refused.dropped).toBe(0);
    expect(refused.value?.refusal).toStrictEqual({
      step: 'validate',
      reason: 'The model returned no JSON object.',
    });
    // `refusal` is absent, not undefined, on the other two.
    expect(Object.hasOwn(viewOfFindingSet(findingSet()).value ?? {}, 'refusal')).toBe(false);
  });
});

/** Every text field of a finding, its class, and whether it may span lines. */
const FINDING_TEXT: readonly { path: string; cls: TextClass; multiline: boolean }[] = [
  { path: 'action.lead', cls: 'free', multiline: false },
  { path: 'action.detail', cls: 'free', multiline: true },
  { path: 'cause', cls: 'free', multiline: true },
  { path: 'evidence.0.label', cls: 'name', multiline: false },
];

/** A string of exactly `n` characters with at most a few words. */
function charsOf(n: number): string {
  return 'x'.repeat(n);
}

describe('TEXT: every field at its cap passes, one past it is dropped and counted — never cut', () => {
  for (const field of FINDING_TEXT) {
    it(`${field.path}: ${field.cls}, ${String(TEXT_CAPS[field.cls])} characters`, () => {
      const cap = TEXT_CAPS[field.cls];
      const at = checkOne(withField(finding(), field.path, charsOf(cap)));
      expect(at, 'at the cap').toMatchObject({ kept: 1, dropped: 0 });
      // A marker that would survive any cut, placed past the cap.
      const over = `${charsOf(cap)}Z`;
      const past = checkOne(withField(finding(), field.path, over));
      expect(past, 'one past the cap').toMatchObject({ kept: 0, dropped: 1 });
      // NEVER TRUNCATED: neither the whole string nor its first `cap` characters reached the view.
      expect(past.json).not.toContain(charsOf(cap));
    });
  }

  it('the refusal: step is a name (64), reason free text (2,000); a bad one drops the SET', () => {
    for (const [path, cap] of [
      ['refusal.step', NAME_MAX_CHARS],
      ['refusal.reason', FREE_TEXT_MAX_CHARS],
    ] as const) {
      expect(viewOfFindingSet(withField(refusedSet(), path, charsOf(cap))).dropped, path).toBe(0);
      const past = viewOfFindingSet(withField(refusedSet(), path, charsOf(cap + 1)));
      expect(past, path).toStrictEqual({ value: null, dropped: 1 });
    }
  });

  it('the LEAD: at most 15 words and one line', () => {
    const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${String(i)}`).join(' ');
    expect(checkOne(withField(finding(), 'action.lead', words(LEAD_MAX_WORDS))).kept).toBe(1);
    expect(checkOne(withField(finding(), 'action.lead', words(LEAD_MAX_WORDS + 1))).kept).toBe(0);
    // Whitespace runs are one separator; leading and trailing space are not words.
    expect(checkOne(withField(finding(), 'action.lead', `  ${words(LEAD_MAX_WORDS).replace(/ /g, '   ')}  `)).kept).toBe(1);
  });

  it('a line break or a tab: allowed in free text that may span lines, refused in one-line text', () => {
    for (const field of FINDING_TEXT) {
      for (const breaker of ['one\ntwo', 'one\ttwo']) {
        const checked = checkOne(withField(finding(), field.path, breaker));
        expect(checked.kept, `${field.path} ${JSON.stringify(breaker)}`).toBe(field.multiline ? 1 : 0);
      }
    }
  });

  it('refuses control characters, bidirectional overrides, separators, lone surrogates and blanks everywhere', () => {
    const hostile = [
      'a\u0000b',
      'a\u001Bb',
      'a\u007Fb',
      'a\u0085b',
      'a\u009Fb',
      'a\u202Eb',
      'a\u2066b',
      'a\u2069b',
      'a\u061Cb',
      'a\u200Fb',
      'a\u2028b',
      'a\u2029b',
      'a\uD800b',
      'a\uDC00b',
      '',
      '   ',
      '\n\n',
    ];
    for (const field of FINDING_TEXT) {
      for (const text of hostile) {
        // Round 5b (2026-09-22): the EMPTY detail is a valid one-sentence
        // action and is tested as such in its own block; every other blank,
        // and the empty string in every other field, is still refused here.
        if (text === '' && field.path === 'action.detail') continue;
        const checked = checkOne(withField(finding(), field.path, text));
        expect(checked.kept, `${field.path} ${JSON.stringify(text)}`).toBe(0);
        expect(checked.dropped).toBe(1);
      }
      // The control: a paired surrogate (an emoji) is text.
      expect(checkOne(withField(finding(), field.path, 'a \uD83D\uDE00 b')).kept, field.path).toBe(1);
      // A non-string is not text.
      expect(checkOne(withField(finding(), field.path, 42)).kept, field.path).toBe(0);
    }
  });

  /** Every hostile character, built from its code point (never an escape a tool can decode). */
  const HOSTILE_CODES = [
    0x00, 0x0d, 0x1b, 0x7f, 0x85, 0x9f, // controls, CR alone included
    0x202e, 0x2066, 0x2069, 0x061c, 0x200f, // bidi
    0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0xfff9, 0xe0041, // format (D3)
    0x2028, 0x2029, // separators
    0xd800, 0xdc00, // lone surrogates
  ];
  const hostile = (code: number): string => `a${String.fromCodePoint(code)}b`;

  it('9.43 D3: every FORMAT character is refused too — zero-width, soft hyphen, BOM, tags', () => {
    for (const field of FINDING_TEXT) {
      for (const code of [0x200b, 0x200d, 0x2060, 0xfeff, 0x00ad, 0xe0041]) {
        expect(checkOne(withField(finding(), field.path, hostile(code))).kept, `${field.path} U+${code.toString(16)}`).toBe(0);
      }
      // A label made ONLY of zero-width spaces, which passed the old blank check.
      expect(checkOne(withField(finding(), field.path, String.fromCodePoint(0x200b).repeat(3))).kept).toBe(0);
    }
  });

  it('9.43 D1: evidence string values, a refusal’s step and its reason take every hostile character too', () => {
    for (const code of HOSTILE_CODES) {
      const text = hostile(code);
      const onFile = checkOne(finding({ evidence: [evidence({ statsKey: 'sessions[0].files[0].filePath', value: text })] }));
      expect(onFile.kept, `evidence U+${code.toString(16)}`).toBe(0);
      for (const path of ['refusal.step', 'refusal.reason']) {
        expect(viewOfFindingSet(withField(refusedSet(), path, text)), `${path} U+${code.toString(16)}`).toStrictEqual({
          value: null,
          dropped: 1,
        });
      }
    }
    // The controls: the same fields pass plain text.
    expect(checkOne(finding({ evidence: [evidence({ statsKey: 'sessions[0].files[0].filePath', value: 'a/b.ts' })] })).kept).toBe(1);
    expect(viewOfFindingSet(withField(refusedSet(), 'refusal.reason', 'plain')).dropped).toBe(0);
  });

  it('9.43: CRLF line ends are admitted where text may span lines, kept as sent; a CR alone never', () => {
    const crlf = `one${String.fromCharCode(13, 10)}two`;
    const { value } = viewOfFindingSet(findingSet({ findings: [finding({ cause: crlf })] }));
    expect(value?.findings[0]?.cause).toBe(crlf);
    expect(checkOne(withField(finding(), 'action.lead', crlf)).kept).toBe(0);
    expect(checkOne(withField(finding(), 'cause', `one${String.fromCharCode(13)}two`)).kept).toBe(0);
  });

  it('markup is TEXT, not refused: the renderer escapes it, and refusing it would refuse every code sample', () => {
    const checked = checkOne(withField(finding(), 'cause', 'The edit wrote <script>alert(1)</script> into a.ts.'));
    expect(checked.kept).toBe(1);
  });
});

describe('round 5b (2026-09-22): an empty detail, and the kinds no longer reported', () => {
  it('an EMPTY detail is a one-sentence action and passes; a blank that is not empty is still refused', () => {
    expect(checkOne(withField(finding(), 'action.detail', '')).kept).toBe(1);
    const { value } = viewOfFindingSet(findingSet({ findings: [finding({ action: { lead: 'One sentence', detail: '' } })] }));
    expect(value?.findings[0]?.action).toStrictEqual({ lead: 'One sentence', detail: '' });
    for (const blank of [' ', '\n', '\t ']) {
      expect(checkOne(withField(finding(), 'action.detail', blank)).kept, JSON.stringify(blank)).toBe(0);
    }
    // Only the DETAIL may be empty: an empty lead or cause is still refused.
    expect(checkOne(withField(finding(), 'action.lead', '')).kept).toBe(0);
    expect(checkOne(withField(finding(), 'cause', '')).kept).toBe(0);
  });

  it('resolvedKinds: kinds from the eight, each once, none the set still lists — copied fresh', () => {
    const input = findingSet({ resolvedKinds: ['stall', 'cache-miss'] });
    const { value, dropped } = viewOfFindingSet(input);
    expect(dropped).toBe(0);
    expect(value?.resolvedKinds).toStrictEqual(['stall', 'cache-miss']);
    expect(value?.resolvedKinds).not.toBe(input['resolvedKinds']);
    // An empty list is the ordinary case.
    expect(viewOfFindingSet(findingSet()).value?.resolvedKinds).toStrictEqual([]);
  });

  it('a bad entry is dropped and COUNTED, and the rest are shown', () => {
    for (const [entries, kept] of [
      [['stall', 'Stall'], ['stall']], // not a kind (case matters)
      [['stall', 'stall'], ['stall']], // said twice
      [['stall', 're-read-loop'], ['stall']], // the set still lists a re-read loop
      [['stall', 42], ['stall']], // not a string
      [['stall', 'other', 'nonsense'], ['stall', 'other']],
    ] as const) {
      const { value, dropped } = viewOfFindingSet(findingSet({ resolvedKinds: entries }));
      expect(value?.resolvedKinds, JSON.stringify(entries)).toStrictEqual(kept);
      expect(dropped, JSON.stringify(entries)).toBe(entries.length - kept.length);
    }
  });

  it('a kind the set lists is refused even when the parent dropped that finding', () => {
    // The provider says re-read-loop is present (a finding of it, though one the
    // parent refuses) and also that it is no longer reported: a contradiction.
    const bad = finding({ id: 'bad', kind: 'churn-chain', cause: '' });
    const { value, dropped } = viewOfFindingSet(findingSet({ findings: [finding(), bad], resolvedKinds: ['churn-chain'] }));
    expect(value?.resolvedKinds).toStrictEqual([]);
    expect(dropped).toBe(2);
  });

  it('a non-array or a missing list drops the SET; past eight entries is counted', () => {
    expect(viewOfFindingSet(findingSet({ resolvedKinds: 'stall' }))).toStrictEqual({ value: null, dropped: 1 });
    expect(viewOfFindingSet(findingSet({ resolvedKinds: null }))).toStrictEqual({ value: null, dropped: 1 });
    const without = Object.fromEntries(Object.entries(findingSet()).filter(([key]) => key !== 'resolvedKinds'));
    expect(viewOfFindingSet(without)).toStrictEqual({ value: null, dropped: 1 });
    const nine = [...FINDING_KINDS.filter((k) => k !== 're-read-loop'), 'stall', 'stall'];
    const { value, dropped } = viewOfFindingSet(findingSet({ resolvedKinds: nine }));
    expect(value?.resolvedKinds).toHaveLength(FINDING_KINDS.length - 1);
    expect(dropped).toBe(2);
  });

  it('on an empty and on a refused set too — the field is on every set', () => {
    const empty = viewOfFindingSet(findingSet({ findings: [], state: 'empty', resolvedKinds: ['re-read-loop'] }));
    expect(empty.value?.resolvedKinds).toStrictEqual(['re-read-loop']);
    expect(viewOfFindingSet(refusedSet({ resolvedKinds: ['stall'] })).value?.resolvedKinds).toStrictEqual(['stall']);
  });
});

describe('EVIDENCE: labelled, per session, a number — or a string only where the store allows one', () => {
  it('a string value is admitted on the store’s string keys, under the store’s caps', () => {
    const cases: readonly [string, TextClass][] = [
      ['sessions[0].files[2].filePath', 'path'],
      ['sessions[3].projectSlug', 'path'],
      ['sessions[0].skills[1].name', 'name'],
      ['sessions[0].agents[0].agentType', 'name'],
      ['sessions[0].agents[0].agentId', 'name'],
      ['sessions[0].tools[4].toolName', 'name'],
      ['sessions[0].unavailable[3]', 'name'],
      ['sessions[0].engine', 'name'],
      ['sessions[0].sessionId', 'name'],
    ];
    for (const [statsKey, cls] of cases) {
      expect(stringEvidenceClass(statsKey), statsKey).toBe(cls);
      const cap = TEXT_CAPS[cls];
      const at = checkOne(finding({ evidence: [evidence({ statsKey, value: charsOf(cap) })] }));
      expect(at.kept, `${statsKey} at ${String(cap)}`).toBe(1);
      const past = checkOne(finding({ evidence: [evidence({ statsKey, value: charsOf(cap + 1) })] }));
      expect(past.kept, `${statsKey} past ${String(cap)}`).toBe(0);
      expect(past.json).not.toContain(charsOf(cap));
    }
  });

  it('the caps agree with the STORE’s, key for key, wherever the store caps one', () => {
    const probe: Readonly<Record<string, string>> = {
      agentType: 'sessions[0].agents[0].agentType',
      name: 'sessions[0].skills[0].name',
      filePath: 'sessions[0].files[0].filePath',
    };
    expect(Object.keys(probe).sort()).toStrictEqual([...STATS_STRING_CAPS.keys()].sort());
    for (const [key, cap] of STATS_STRING_CAPS) {
      const cls = stringEvidenceClass(probe[key] as string);
      expect(cls === null ? null : TEXT_CAPS[cls], key).toBe(cap);
    }
  });

  it('a string anywhere else DROPS THE FINDING: numbers, off-list keys, a `name` outside skills, no record index', () => {
    for (const statsKey of [
      'sessions[0].totals.prompt',
      'sessions[0].loops[1].count',
      'sessions[0].agents[0].name',
      'sessions[0].name',
      'sessions[0].files[0].filePath.extra',
      'sessions.filePath',
      'sessions[0]',
      'sessions[0].description',
      'sessions[0].agents[0].description',
    ]) {
      expect(checkOne(finding({ evidence: [evidence({ statsKey, value: 'C:/x/y.ts' })] })).kept, statsKey).toBe(0);
    }
  });

  it('refuses a non-finite number, a bad key, a bad label or session id, and an empty or oversized list', () => {
    for (const items of [
      [evidence({ value: Number.NaN })],
      [evidence({ value: Number.POSITIVE_INFINITY })],
      [evidence({ value: true })],
      [evidence({ statsKey: 'process.env.HOME' })],
      [evidence({ statsKey: 'sessions.' })],
      [evidence({ sessionId: 'ses 1; <x>' })],
      [evidence({ sessionId: '' })],
      [evidence({ label: 'x'.repeat(NAME_MAX_CHARS + 1) })],
      [evidence({ note: 'an extra key' })],
      [{ statsKey: 'sessions[0].totals.prompt', value: 1 }],
      [],
      Array.from({ length: MAX_EVIDENCE + 1 }, (_, i) => evidence({ statsKey: `sessions[${String(i)}].totals.prompt` })),
    ]) {
      expect(checkOne(finding({ evidence: items })).kept, JSON.stringify(items).slice(0, 80)).toBe(0);
    }
    // At the cap it passes.
    const atCap = Array.from({ length: MAX_EVIDENCE }, (_, i) =>
      evidence({ statsKey: `sessions[${String(i)}].totals.prompt` }),
    );
    expect(checkOne(finding({ evidence: atCap })).kept).toBe(1);
  });

  it('one key of one session twice drops the finding; the same key of two sessions is two facts', () => {
    expect(checkOne(finding({ evidence: [evidence(), evidence({ value: 8 })] })).kept).toBe(0);
    expect(
      checkOne(finding({ evidence: [evidence(), evidence({ sessionId: 'ses_example02' })] })).kept,
    ).toBe(1);
  });
});

describe('FINDINGS: ids, enumerations, and nothing the amendment does not name', () => {
  it('refuses an unknown kind, confidence or sinceLastRun — enumerations, not free text', () => {
    for (const over of [
      { kind: 'Your agent is slow' },
      { confidence: 'certain' },
      { sinceLastRun: 'gone' },
      { sinceLastRun: undefined },
      { id: 'f 1' },
      { id: '' },
    ]) {
      expect(checkOne(finding(over)).kept, JSON.stringify(over)).toBe(0);
    }
    for (const since of ['new', 'still', 'resolved', null]) {
      expect(checkOne(finding({ sinceLastRun: since })).kept, String(since)).toBe(1);
    }
  });

  it('a key the amendment does not name is refused whole — a score, a severity, a raw payload', () => {
    for (const extra of [{ score: 0.93 }, { severity: 'high' }, { raw: '{"cause":"..."}' }]) {
      expect(checkOne(finding(extra)).kept, JSON.stringify(extra)).toBe(0);
    }
    expect(checkOne(finding({ action: { lead: 'Keep it open', detail: 'd', why: 'x' } })).kept).toBe(0);
    expect(checkOne(finding({ action: 'Keep it open' })).kept).toBe(0);
  });

  it('a finding id seen before in the set is dropped and counted; the first stays', () => {
    const { value, dropped } = viewOfFindingSet(
      findingSet({ findings: [finding({ id: 'f-1' }), finding({ id: 'f-1', cause: 'second' }), finding({ id: 'f-2' })] }),
    );
    expect(value?.findings.map((f) => f.id)).toStrictEqual(['f-1', 'f-2']);
    expect(value?.findings[0]?.cause).not.toBe('second');
    expect(dropped).toBe(1);
  });

  it('past the cap is counted as dropped, never silently cut', () => {
    const many = Array.from({ length: MAX_FINDINGS + 3 }, (_, i) => finding({ id: `f-${String(i)}` }));
    const { value, dropped } = viewOfFindingSet(findingSet({ findings: many }));
    expect(value?.findings).toHaveLength(MAX_FINDINGS);
    expect(dropped).toBe(3);
  });
});

describe('the ENVELOPE: whole, self-consistent, or dropped as one', () => {
  it('a broken envelope drops the whole set, counted once', () => {
    for (const set of [
      findingSet({ createdAt: -1 }),
      findingSet({ agent: 'claude' }),
      findingSet({ agent: { kind: 'gpt', version: '1.0.0' } }),
      findingSet({ agent: { kind: 'claude', version: 'latest' } }),
      findingSet({ agent: { kind: 'claude', version: '2.1.246', extra: 1 } }),
      findingSet({ window: { sessions: 1, sinceMs: 1 } }),
      findingSet({ window: { sessions: 1, excluded: -1, sinceMs: 1 } }),
      findingSet({ usage: { prompt: 1.5, output: 1 } }),
      findingSet({ usage: { prompt: -1, output: 1 } }),
      findingSet({ usage: { prompt: 1, output: -1 } }),
      findingSet({ usage: { prompt: 1, output: 1, costUsd: -0.01 } }),
      findingSet({ usage: { prompt: 1, output: 1, costUsd: Number.NaN } }),
      findingSet({ usage: { prompt: 1 } }),
      findingSet({ usage: { prompt: 1, output: 1, currency: 'USD' } }),
      findingSet({ rejected: 1.5 }),
      findingSet({ findings: 'none' }),
      findingSet({ state: 'partial' }),
      findingSet({ note: 'an extra top-level key' }),
      findingSet({ runId: 'run 1; <script>' }),
      findingSet({ runId: '' }),
      findingSet({ runId: 42 }),
      Object.fromEntries(Object.entries(findingSet()).filter(([key]) => key !== 'runId')),
    ]) {
      expect(viewOfFindingSet(set), JSON.stringify(set).slice(0, 120)).toStrictEqual({ value: null, dropped: 1 });
    }
  });

  it('usage: null, tokens only, or tokens and a cost — and a token count may pass a billion', () => {
    for (const usage of [
      null,
      { prompt: 0, output: 0 },
      { prompt: 5_000_000_000, output: 12, costUsd: 0 },
    ]) {
      expect(viewOfFindingSet(findingSet({ usage })).value?.usage, JSON.stringify(usage)).toStrictEqual(usage);
    }
  });

  it('STATE and FINDINGS agree, and REFUSAL is present exactly when refused', () => {
    for (const set of [
      findingSet({ findings: [] }), // ok with nothing found
      findingSet({ state: 'empty' }), // empty with a finding
      refusedSet({ findings: [finding()] }), // refused with a finding
      findingSet({ findings: [], state: 'refused' }), // refused with no refusal
      findingSet({ refusal: { step: 's', reason: 'r' } }), // a refusal on an ok set
      findingSet({ findings: [], state: 'empty', refusal: { step: 's', reason: 'r' } }),
      refusedSet({ refusal: { step: 's' } }),
      refusedSet({ refusal: { step: 'a\nb', reason: 'r' } }),
    ]) {
      expect(viewOfFindingSet(set), JSON.stringify(set).slice(0, 160)).toStrictEqual({ value: null, dropped: 1 });
    }
  });

  it('`null` is "no latest set" and costs nothing', () => {
    expect(viewOfFindingSet(null)).toStrictEqual({ value: null, dropped: 0 });
  });

  it('a GETTER is never run: an accessor field reads as absent', () => {
    let ran = false;
    const input = findingSet();
    Object.defineProperty(input, 'createdAt', {
      enumerable: true,
      get: () => {
        ran = true;
        return 1;
      },
    });
    expect(viewOfFindingSet(input).value).toBeNull();
    expect(ran).toBe(false);
  });

  it('the 9.30 shape — numbers only, with a run id — is refused whole now', () => {
    const old = {
      runId: 'run-1',
      createdAt: 1_790_000_000_000,
      agent: 'claude',
      window: { sinceMs: 1, sessions: 1 },
      findings: [{ kind: 'stall', confidence: 'low', evidence: [{ statsKey: 'sessions[0].totals.stalls', value: 2 }] }],
      findingsRejected: 0,
    };
    expect(viewOfFindingSet(old)).toStrictEqual({ value: null, dropped: 1 });
  });
});

describe('the run history is checked the same way', () => {
  it('passes valid runs, drops and counts the rest, caps at MAX_RUNS', () => {
    const { value, dropped } = viewOfRuns([
      run(),
      run({ runId: 'run-2', state: 'empty', findings: 0, agentKind: 'codex' }),
      run({ runId: 'run-3', state: 'refused', findings: 0 }),
      run({ runId: 'run-4', state: 'crashed' }),
      run({ runId: 'run-5', state: 'ok', findings: 0 }),
      run({ runId: 'run-6', state: 'empty', findings: 2 }),
      run({ runId: 'run-7', agentKind: 'gpt' }),
      run({ runId: '' }),
      run({ runId: 'run-8', findings: -1 }),
      { runId: 'run-9', createdAt: 1, outcome: 'findings', findings: 1 },
    ]);
    expect(value.map((r) => r.runId)).toStrictEqual(['run-1', 'run-2', 'run-3']);
    expect(dropped).toBe(7);
    const capped = viewOfRuns(Array.from({ length: MAX_RUNS + 2 }, (_, i) => run({ runId: `run-${String(i)}` })));
    expect(capped.value).toHaveLength(MAX_RUNS);
    expect(capped.dropped).toBe(2);
  });

  it('D1: a repeated run id is dropped and counted — the history names runs by id', () => {
    const checked = viewOfRuns([run(), run({ createdAt: 1 }), run({ runId: 'run-2' })]);
    expect(checked.value.map((r) => r.runId)).toStrictEqual(['run-1', 'run-2']);
    expect(checked.dropped).toBe(1);
  });

  it('about is two strings in their shapes and an optional status, and nothing else', () => {
    expect(viewOfAbout({ name: 'Agent Deck Insights', version: '0.2.0' })).toStrictEqual({
      name: 'Agent Deck Insights',
      version: '0.2.0',
    });
    // DoD 9.44: status is a NAME — one line, at most 64 characters.
    expect(viewOfAbout({ name: 'Insights', version: '0.2.0', status: 'licensed until 2027-09-23' })).toStrictEqual({
      name: 'Insights',
      version: '0.2.0',
      status: 'licensed until 2027-09-23',
    });
    const at = 's'.repeat(NAME_MAX_CHARS);
    expect(viewOfAbout({ name: 'Insights', version: '0.2.0', status: at })?.status).toBe(at);
    // A status that fails is LEFT OUT and refuses nothing else — never cut.
    for (const status of [
      's'.repeat(NAME_MAX_CHARS + 1),
      'two\nlines',
      `zero${String.fromCharCode(0x200b)}width`,
      '   ',
      42,
      null,
    ]) {
      expect(viewOfAbout({ name: 'Insights', version: '0.2.0', status }), JSON.stringify(status)).toStrictEqual({
        name: 'Insights',
        version: '0.2.0',
      });
    }
    for (const bad of [
      { name: '<img src=x>', version: '0.2.0' },
      { name: 'Insights', version: 'latest' },
      { name: 'Insights', version: '0.2.0', licence: 'valid' },
      null,
    ]) {
      expect(viewOfAbout(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('viewOfRunSet: a set answers for the run ASKED (DoD 9.44)', () => {
  it('the set of the run asked for passes; one naming another run is dropped and counted', () => {
    expect(viewOfRunSet(findingSet({ runId: 'r-9' }), 'r-9').value?.runId).toBe('r-9');
    expect(viewOfRunSet(findingSet({ runId: 'r-9' }), 'r-8')).toStrictEqual({ value: null, dropped: 1 });
    // Null is "no report", not a drop.
    expect(viewOfRunSet(null, 'r-9')).toStrictEqual({ value: null, dropped: 0 });
    // Every other rule still applies.
    expect(viewOfRunSet(findingSet({ runId: 'r-9', state: 'nope' }), 'r-9')).toStrictEqual({ value: null, dropped: 1 });
  });

  it('the list is SORTED newest first, whatever order the provider gave, ties in its order', () => {
    const { value } = viewOfRuns([
      run({ runId: 'old', createdAt: 1_000 }),
      run({ runId: 'new', createdAt: 3_000 }),
      run({ runId: 'tie-a', createdAt: 2_000 }),
      run({ runId: 'tie-b', createdAt: 2_000 }),
    ]);
    expect(value.map((r) => r.runId)).toStrictEqual(['new', 'tie-a', 'tie-b', 'old']);
  });
});

/* ------------------------------------------------------------------------ *
 * 3. One provider at a time
 * ------------------------------------------------------------------------ */

describe('the registry holds ONE provider', () => {
  it('registers, announces the change, and states the about', () => {
    let changes = 0;
    const registry = new InsightsProviderRegistry({ onChange: () => (changes += 1) });
    expect(registry.registered).toBe(false);
    expect(registry.snapshot()).toBeNull();
    registry.register(fakeProvider().provider);
    expect(registry.registered).toBe(true);
    expect(changes).toBe(1);
    expect(registry.about()).toStrictEqual({ name: 'Agent Deck Insights', version: '0.2.0' });
  });

  it('a SECOND registration is refused BY NAME, and changes nothing', () => {
    let changes = 0;
    const registry = new InsightsProviderRegistry({ onChange: () => (changes += 1) });
    registry.register(fakeProvider().provider);
    const second = fakeProvider({ about: { name: 'Other Insights', version: '9.9.9' } });
    expect(() => registry.register(second.provider)).toThrow(
      'an Insights provider is already registered (Agent Deck Insights 0.2.0); Other Insights 9.9.9 was refused.',
    );
    expect(registry.about()?.name).toBe('Agent Deck Insights');
    expect(changes).toBe(1);
    expect(second.listeners).toBe(0);
  });

  it('refuses anything that is not a provider of this contract', () => {
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    for (const bad of [
      null,
      {},
      fakeProvider({ providerVersion: 2 }).provider,
      fakeProvider({ about: { name: 'x' } }).provider,
      fakeProvider({ run: 'not a function' }).provider,
      fakeProvider({ onDidChange: undefined }).provider,
      fakeProvider({ getRawOutput: 'not a function' }).provider,
      fakeProvider({ getRawOutput: null }).provider,
      // DoD 9.44: getRun is REQUIRED; each optional action is a function or absent.
      fakeProvider({ getRun: undefined }).provider,
      fakeProvider({ getRun: 'not a function' }).provider,
      fakeProvider({ pickAgent: 'x' }).provider,
      fakeProvider({ showPayload: null }).provider,
      fakeProvider({ clearHistory: 1 }).provider,
      // DoD 9.54: investigate is optional; present, it must be a function.
      fakeProvider({ investigate: 'x' }).provider,
      fakeProvider({ investigate: null }).provider,
    ]) {
      expect(() => registry.register(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
    expect(registry.registered).toBe(false);
  });

  it('ruling 2026-09-23 (1): run() is OPTIONAL — absent registers; present must be a function; getLatest stays required', () => {
    const withoutRun = fakeProvider().provider as unknown as Record<string, unknown>;
    delete withoutRun['run'];
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    expect(() => registry.register(withoutRun)).not.toThrow();
    expect(registry.registered).toBe(true);
    const other = new InsightsProviderRegistry({ onChange: () => undefined });
    expect(() => other.register(fakeProvider({ run: 'not a function' }).provider)).toThrow(TypeError);
    const withoutLatest = fakeProvider().provider as unknown as Record<string, unknown>;
    delete withoutLatest['getLatest'];
    expect(() => other.register(withoutLatest)).toThrow('an Insights provider must have getLatest.');
    expect(other.registered).toBe(false);
  });

  it('a provider written as a CLASS (methods on the prototype) registers, getRawOutput included', () => {
    class Provider {
      readonly providerVersion = 1 as const;
      readonly about = { name: 'Class Insights', version: '1.0.0' };
      getLatest(): unknown {
        return refusedSet();
      }
      listRuns(): unknown[] {
        return [run({ state: 'refused', findings: 0 })];
      }
      getRun(runId: string): unknown {
        return refusedSet({ runId });
      }
      pickAgent(): Promise<void> {
        return Promise.resolve();
      }
      run(): Promise<void> {
        return Promise.resolve();
      }
      getRawOutput(runId: string): string {
        return `raw for ${runId} from ${this.about.name}`;
      }
      onDidChange(): { dispose(): void } {
        return { dispose: () => undefined };
      }
    }
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    registry.register(new Provider());
    expect(registry.snapshot('run-1')?.selected?.rawOutput).toBe(true);
    // `this` is the provider: a prototype method is called ON it.
    expect(registry.rawOutput('run-1')).toStrictEqual({ ok: true, runId: 'run-1', text: 'raw for run-1 from Class Insights' });
    // An optional action on the prototype is found too (DoD 9.44).
    expect(registry.actions()).toStrictEqual(['pickAgent']);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. The parent calls nothing else
 * ------------------------------------------------------------------------ */

describe('the parent reads and calls ONLY the contract’s members', () => {
  it('a Proxy provider sees no other property touched, and getRawOutput called only when asked', async () => {
    const touched = new Set<string>();
    const called: string[] = [];
    const base = fakeProvider({
      getLatest: () => refusedSet(),
      listRuns: () => [run({ state: 'refused', findings: 0 })],
      getRun: (runId: string) => refusedSet({ runId }),
      getRawOutput: () => 'raw',
      pickAgent: () => Promise.resolve(),
      showPayload: () => Promise.resolve(),
      clearHistory: () => Promise.resolve(),
      investigate: () => Promise.resolve(),
    }).provider as unknown as Record<string, unknown>;
    const wrap = (key: string, value: unknown): unknown =>
      typeof value === 'function'
        ? (...args: unknown[]): unknown => {
            called.push(key);
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value;
    const spy = new Proxy(base, {
      get(target, key) {
        if (typeof key === 'string') touched.add(key);
        return wrap(String(key), Reflect.get(target, key));
      },
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === 'string') touched.add(key);
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        return descriptor === undefined || !('value' in descriptor)
          ? descriptor
          : { ...descriptor, value: wrap(String(key), descriptor.value) };
      },
      has(target, key) {
        if (typeof key === 'string') touched.add(key);
        return Reflect.has(target, key);
      },
    });
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    const handle = registry.register(spy);
    registry.snapshot();
    registry.snapshot('run-1');
    // Snapshots never ask for raw output, and never run an action.
    expect(called).not.toContain('getRawOutput');
    expect(called).not.toContain('pickAgent');
    expect(registry.rawOutput('run-1')).toMatchObject({ ok: true, text: 'raw' });
    for (const action of PROVIDER_ACTIONS) await registry.invoke(action);
    expect(called).not.toContain('investigate');
    expect(await registry.investigate('run-1')).toBe('done');
    handle.dispose();

    const CONTRACT = [
      'providerVersion',
      'about',
      'getLatest',
      'listRuns',
      'getRun',
      'run',
      'getRawOutput',
      'pickAgent',
      'showPayload',
      'clearHistory',
      'investigate',
      'onDidChange',
    ];
    expect([...touched].filter((key) => !CONTRACT.includes(key))).toStrictEqual([]);
    expect([...touched].sort()).toStrictEqual([...CONTRACT].sort());
    // DoD 9.44: getLatest and run are READ at registration (still required)
    // and CALLED by nothing — the surface shows the selected run and has no Run.
    expect([...new Set(called)].sort()).toStrictEqual(
      ['listRuns', 'getRun', 'onDidChange', 'getRawOutput', 'pickAgent', 'showPayload', 'clearHistory', 'investigate'].sort(),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * 5. onDidChange, run(), disposal
 * ------------------------------------------------------------------------ */

describe('onDidChange, run and disposal', () => {
  it('the provider’s onDidChange reaches the registry’s onChange', () => {
    let changes = 0;
    const registry = new InsightsProviderRegistry({ onChange: () => (changes += 1) });
    const fake = fakeProvider();
    registry.register(fake.provider);
    fake.fire();
    fake.fire();
    expect(changes).toBe(3);
  });

  it('DoD 9.44: actions() names the optional actions the provider HAS, in the Menu order', () => {
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    expect(registry.actions()).toStrictEqual([]);
    registry.register(
      fakeProvider({ clearHistory: () => Promise.resolve(), pickAgent: () => Promise.resolve() }).provider,
    );
    expect(registry.actions()).toStrictEqual(['pickAgent', 'clearHistory']);
  });

  it('DoD 9.44: invoke() calls the action ONCE, awaits it, and answers what it came to', async () => {
    const calls: string[] = [];
    let release: () => void = () => undefined;
    const errors: unknown[] = [];
    const registry = new InsightsProviderRegistry({ onChange: () => undefined, onError: (e) => errors.push(e) });
    expect(await registry.invoke('pickAgent')).toBe('no-provider');
    registry.register(
      fakeProvider({
        pickAgent: () => {
          calls.push('pickAgent');
          return new Promise<void>((resolve) => (release = resolve));
        },
        clearHistory: () => {
          calls.push('clearHistory');
          return Promise.reject(new Error('disk full'));
        },
      }).provider,
    );
    let settled = false;
    const pending = registry.invoke('pickAgent').then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await pending).toBe('done');
    expect(await registry.invoke('showPayload')).toBe('absent');
    expect(await registry.invoke('clearHistory')).toBe('failed');
    expect(errors.map((e) => (e as Error).message)).toStrictEqual(['disk full']);
    expect(calls).toStrictEqual(['pickAgent', 'clearHistory']);
  });

  it('DoD 9.44: an action ADDED after registration is not called — what it had then is what it has', async () => {
    // Mutation C3 survived without this: the registry checks the actions it
    // recorded at registration, and nothing drove a member that arrived later.
    let calls = 0;
    const provider = fakeProvider().provider as unknown as Record<string, unknown>;
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    registry.register(provider);
    provider['showPayload'] = () => ((calls += 1), Promise.resolve());
    expect(registry.actions()).toStrictEqual([]);
    expect(await registry.invoke('showPayload')).toBe('absent');
    expect(calls).toBe(0);
  });

  it('DoD 9.44: an action given as a GETTER reads as absent and never runs', async () => {
    let ran = 0;
    const provider = fakeProvider().provider as unknown as Record<string, unknown>;
    Object.defineProperty(provider, 'showPayload', {
      enumerable: true,
      get: () => {
        ran += 1;
        return () => Promise.resolve();
      },
    });
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    registry.register(provider);
    expect(registry.actions()).toStrictEqual([]);
    expect(await registry.invoke('showPayload')).toBe('absent');
    expect(ran).toBe(0);
  });

  it('DoD 9.44: a throwing listRuns or getRun reads as nothing and counts one drop', () => {
    const throws = (): never => {
      throw new Error('store unreadable');
    };
    const noList = new InsightsProviderRegistry({ onChange: () => undefined, onError: () => undefined });
    noList.register(fakeProvider({ listRuns: throws }).provider);
    expect(noList.snapshot('run-1')).toMatchObject({ runs: [], dropped: 1, selected: null });
    const noRun = new InsightsProviderRegistry({ onChange: () => undefined, onError: () => undefined });
    noRun.register(fakeProvider({ getRun: throws }).provider);
    expect(noRun.snapshot('run-1')?.selected).toStrictEqual({ runId: 'run-1', set: null, dropped: 1, rawOutput: false, investigate: false });
  });

  it('DoD 9.44: the selection previews ONLY a run the list holds, read through getRun', () => {
    const asked: string[] = [];
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    registry.register(
      fakeProvider({
        getRun: (runId: string) => {
          asked.push(runId);
          return findingSet({ runId });
        },
      }).provider,
    );
    expect(registry.snapshot()?.selected).toBeNull();
    expect(registry.snapshot('run-404')?.selected).toBeNull();
    expect(asked).toStrictEqual([]);
    expect(registry.snapshot('run-1')?.selected?.set?.runId).toBe('run-1');
    expect(asked).toStrictEqual(['run-1']);
    expect(registry.lists('run-1')).toBe(true);
    expect(registry.lists('run-404')).toBe(false);
    expect(registry.readRun('run-404')).toBeNull();
    expect(registry.readRun('run-1')?.value?.runId).toBe('run-1');
  });

  it('DoD 9.44: a getRun answer naming ANOTHER run is dropped, never shown under the row clicked', () => {
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    registry.register(fakeProvider({ getRun: () => findingSet({ runId: 'run-other' }) }).provider);
    expect(registry.snapshot('run-1')?.selected).toStrictEqual({ runId: 'run-1', set: null, dropped: 1, rawOutput: false, investigate: false });
  });

  it('DISPOSAL returns to the free state, unsubscribes, and allows the next provider', () => {
    let changes = 0;
    const registry = new InsightsProviderRegistry({ onChange: () => (changes += 1) });
    const fake = fakeProvider();
    const handle = registry.register(fake.provider);
    expect(fake.listeners).toBe(1);
    handle.dispose();
    expect(registry.registered).toBe(false);
    expect(registry.snapshot()).toBeNull();
    expect(registry.about()).toBeNull();
    expect(fake.listeners).toBe(0);
    expect(changes).toBe(2);
    handle.dispose();
    expect(changes).toBe(2);
    fake.fire();
    expect(changes).toBe(2);
    registry.register(fakeProvider({ about: { name: 'Next', version: '1.0.0' } }).provider);
    expect(registry.about()?.name).toBe('Next');
  });

  it('a STALE handle cannot unregister the provider after it', () => {
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    const first = registry.register(fakeProvider().provider);
    first.dispose();
    registry.register(fakeProvider({ about: { name: 'Second', version: '1.0.0' } }).provider);
    first.dispose();
    expect(registry.about()?.name).toBe('Second');
  });

  it('V21: a contract MEMBER given as a getter is refused, and the getter never runs', () => {
    let ran = 0;
    const provider = fakeProvider().provider as unknown as Record<string, unknown>;
    const withGetter = { ...provider };
    delete withGetter['getLatest'];
    Object.defineProperty(withGetter, 'getLatest', {
      enumerable: true,
      get: () => {
        ran += 1;
        return () => null;
      },
    });
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    expect(() => registry.register(withGetter as unknown as InsightsProvider)).toThrow(TypeError);
    expect(ran).toBe(0);
    expect(registry.registered).toBe(false);
  });

  it('an action pressed after its provider went away answers no-provider and calls nothing', async () => {
    let calls = 0;
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    const handle = registry.register(
      fakeProvider({ pickAgent: () => ((calls += 1), Promise.resolve()) }).provider,
    );
    handle.dispose();
    expect(await registry.invoke('pickAgent')).toBe('no-provider');
    expect(registry.actions()).toStrictEqual([]);
    expect(calls).toBe(0);
  });

  it('V15: after the registry is disposed (deactivation) nothing can register', () => {
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    registry.register(fakeProvider().provider);
    registry.dispose();
    expect(registry.registered).toBe(false);
    expect(() => registry.register(fakeProvider().provider)).toThrow(/shutting down/);
  });
});

/* ------------------------------------------------------------------------ *
 * 6. Raw output — optional, placed, and never cut
 * ------------------------------------------------------------------------ */

describe('9.43 D2: a thrown provider message is provider text', () => {
  it('passes as it is when it is free text; withheld with its length otherwise; never runs code', () => {
    expect(providerErrorText(new Error('store unreadable'))).toBe('store unreadable');
    expect(providerErrorText('plain string')).toBe('plain string');
    const bidi = `abc${String.fromCharCode(0x202e)}def`;
    expect(providerErrorText(new Error(bidi))).toBe('(a message of 7 characters that did not pass the check, not shown)');
    expect(providerErrorText(new Error('x'.repeat(FREE_TEXT_MAX_CHARS + 1)))).toContain('2001 characters');
    let ran = 0;
    const sneaky = {
      get message(): string {
        ran += 1;
        return 'from a getter';
      },
      toString(): string {
        ran += 1;
        return 'from toString';
      },
    };
    expect(providerErrorText(sneaky)).toBe('(an error with no message)');
    expect(providerErrorText(42)).toBe('(an error with no message)');
    expect(ran).toBe(0);
  });
});

describe('raw output (DoD 9.40), for the SELECTED run (DoD 9.46)', () => {
  const REFUSED_RUN = run({ state: 'refused', findings: 0 });

  function registryWith(over: Partial<Record<string, unknown>>): {
    registry: InsightsProviderRegistry;
    asked: string[];
    errors: unknown[];
  } {
    const asked: string[] = [];
    const errors: unknown[] = [];
    const registry = new InsightsProviderRegistry({ onChange: () => undefined, onError: (e) => errors.push(e) });
    registry.register(
      fakeProvider({
        getLatest: () => refusedSet(),
        listRuns: () => [REFUSED_RUN],
        getRun: (runId: string) => (runId === 'run-1' ? refusedSet() : null),
        getRawOutput: (runId: string) => {
          asked.push(runId);
          return `raw output of ${runId}`;
        },
        ...over,
      }).provider,
    );
    return { registry, asked, errors };
  }

  it('offered only when both hold: the method, and the SELECTED run refused', () => {
    expect(registryWith({}).registry.snapshot('run-1')?.selected?.rawOutput).toBe(true);
    // No method.
    const without = new InsightsProviderRegistry({ onChange: () => undefined });
    without.register(
      fakeProvider({ listRuns: () => [REFUSED_RUN], getRun: () => refusedSet() }).provider,
    );
    expect(without.snapshot('run-1')?.selected?.rawOutput).toBe(false);
    expect(without.rawOutput('run-1')).toStrictEqual({ ok: false, reason: 'unsupported' });
    // Not refused.
    expect(registryWith({ getRun: () => findingSet() }).registry.snapshot('run-1')?.selected?.rawOutput).toBe(false);
    // Not selected: no preview, nothing offered.
    expect(registryWith({}).registry.snapshot()?.selected).toBeNull();
  });

  it('asks for the resolved run id and nothing else, and returns the text WHOLE', () => {
    const { registry, asked } = registryWith({});
    expect(registry.rawOutput('run-1')).toStrictEqual({ ok: true, runId: 'run-1', text: 'raw output of run-1' });
    expect(asked).toStrictEqual(['run-1']);
  });

  it('each way it shows nothing is named, with the run where there is one', () => {
    expect(registryWith({ getRun: () => findingSet() }).registry.rawOutput('run-1')).toStrictEqual({ ok: false, reason: 'no-run' });
    // A run the list does not hold, and no selection at all, ask nothing.
    expect(registryWith({}).registry.rawOutput('run-404')).toStrictEqual({ ok: false, reason: 'no-run' });
    expect(registryWith({}).registry.rawOutput(null)).toStrictEqual({ ok: false, reason: 'no-run' });
    expect(registryWith({ getRawOutput: () => null }).registry.rawOutput('run-1')).toStrictEqual({
      ok: false,
      reason: 'none',
      runId: 'run-1',
    });
    expect(registryWith({ getRawOutput: () => 42 }).registry.rawOutput('run-1')).toStrictEqual({
      ok: false,
      reason: 'invalid',
      runId: 'run-1',
    });
    const threw = registryWith({
      getRawOutput: () => {
        throw new Error('gone');
      },
    });
    expect(threw.registry.rawOutput('run-1')).toStrictEqual({ ok: false, reason: 'threw', runId: 'run-1' });
    expect(threw.errors.map((e) => (e as Error).message)).toStrictEqual(['gone']);
    expect(new InsightsProviderRegistry({ onChange: () => undefined }).rawOutput('run-1')).toStrictEqual({
      ok: false,
      reason: 'no-provider',
    });
  });

  it(`at ${String(RAW_OUTPUT_MAX_CHARS)} characters it opens; one more is refused whole, with its length`, () => {
    const at = registryWith({ getRawOutput: () => 'r'.repeat(RAW_OUTPUT_MAX_CHARS) }).registry.rawOutput('run-1');
    expect(at.ok && at.text.length).toBe(RAW_OUTPUT_MAX_CHARS);
    const past = registryWith({ getRawOutput: () => 'r'.repeat(RAW_OUTPUT_MAX_CHARS + 1) }).registry.rawOutput('run-1');
    expect(past).toStrictEqual({ ok: false, reason: 'too-large', runId: 'run-1', length: RAW_OUTPUT_MAX_CHARS + 1 });
  });

  it('a getRawOutput given as a getter reads as ABSENT and never runs', () => {
    let ran = 0;
    const provider = fakeProvider({ listRuns: () => [REFUSED_RUN], getRun: () => refusedSet() })
      .provider as unknown as Record<string, unknown>;
    Object.defineProperty(provider, 'getRawOutput', {
      enumerable: true,
      get: () => {
        ran += 1;
        return () => 'raw';
      },
    });
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    registry.register(provider);
    expect(registry.snapshot('run-1')?.selected?.rawOutput).toBe(false);
    expect(registry.rawOutput('run-1')).toStrictEqual({ ok: false, reason: 'unsupported' });
    expect(ran).toBe(0);
  });

  it('reads the selected run NOW through getRun: a run that stopped being refused asks nothing', () => {
    let refused = true;
    const { registry, asked } = registryWith({
      getRun: (runId: string) => (refused ? refusedSet({ runId }) : findingSet({ runId })),
    });
    expect(registry.snapshot('run-1')?.selected?.rawOutput).toBe(true);
    refused = false;
    expect(registry.rawOutput('run-1')).toStrictEqual({ ok: false, reason: 'no-run' });
    expect(asked).toStrictEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * Investigate Report — DoD 9.54
 * ------------------------------------------------------------------------ */

describe('investigate (DoD 9.54): optional, called with the selected run id and nothing else', () => {
  it('absent: the preview offers nothing and the registry calls nothing', async () => {
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    expect(await registry.investigate('run-1')).toBe('no-provider');
    registry.register(fakeProvider().provider);
    expect(registry.snapshot('run-1')?.selected?.investigate).toBe(false);
    expect(await registry.investigate('run-1')).toBe('absent');
  });

  it('present: the preview offers it, and a press passes exactly the run id, awaited', async () => {
    const calls: unknown[][] = [];
    let release: () => void = () => undefined;
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    registry.register(
      fakeProvider({
        investigate: (...args: unknown[]) => {
          calls.push(args);
          return new Promise<void>((resolve) => (release = resolve));
        },
      }).provider,
    );
    expect(registry.snapshot('run-1')?.selected?.investigate).toBe(true);
    // Nothing selected: no preview to offer it on.
    expect(registry.snapshot()?.selected).toBeNull();
    let settled = false;
    const pending = registry.investigate('run-1').then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await pending).toBe('done');
    expect(calls).toStrictEqual([['run-1']]);
  });

  it('no selection, or a run the list no longer holds, calls nothing', async () => {
    let calls = 0;
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    registry.register(
      fakeProvider({
        investigate: () => {
          calls += 1;
          return Promise.resolve();
        },
      }).provider,
    );
    expect(await registry.investigate(null)).toBe('no-run');
    expect(await registry.investigate('run-404')).toBe('no-run');
    expect(calls).toBe(0);
  });

  it('a throw and a rejection are each reported once and answered failed, never rethrown', async () => {
    for (const investigate of [
      () => {
        throw new Error('no agent CLI');
      },
      () => Promise.reject(new Error('no agent CLI')),
    ]) {
      const errors: unknown[] = [];
      const registry = new InsightsProviderRegistry({ onChange: () => undefined, onError: (e) => errors.push(e) });
      registry.register(fakeProvider({ investigate }).provider);
      expect(await registry.investigate('run-1')).toBe('failed');
      expect(errors.map((e) => (e as Error).message)).toStrictEqual(['no agent CLI']);
    }
  });

  it('given as a getter it reads as ABSENT and never runs; added after registration it is not called', async () => {
    let ran = 0;
    const provider = fakeProvider().provider as unknown as Record<string, unknown>;
    Object.defineProperty(provider, 'investigate', {
      enumerable: true,
      configurable: true,
      get: () => {
        ran += 1;
        return () => Promise.resolve();
      },
    });
    const registry = new InsightsProviderRegistry({ onChange: () => undefined });
    registry.register(provider);
    expect(registry.snapshot('run-1')?.selected?.investigate).toBe(false);
    expect(await registry.investigate('run-1')).toBe('absent');
    expect(ran).toBe(0);
    const later = fakeProvider().provider as unknown as Record<string, unknown>;
    const other = new InsightsProviderRegistry({ onChange: () => undefined });
    other.register(later);
    let calls = 0;
    later['investigate'] = () => {
      calls += 1;
      return Promise.resolve();
    };
    expect(await other.investigate('run-1')).toBe('absent');
    expect(calls).toBe(0);
  });
});
