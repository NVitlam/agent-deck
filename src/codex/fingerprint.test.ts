/**
 * `src/codex/fingerprint.ts` — PLAN.md v0.6.0 Phase 2, DoD 2.2.
 *
 * Shaped after `src/opencode/fingerprint.test.ts` and `src/parser/corpus.test.ts`,
 * for the reason those two share: the anchor's whole meaning is "the release
 * whose captured corpus proved the structure", so it is asserted against the
 * corpus on disk rather than against itself. Moving `PINNED_CODEX_VERSION`
 * without harvesting fails here.
 *
 * Three properties this file is built to have, each because the repository has
 * shipped the absence of it:
 *
 *  - **Every refusal asserts its EXACT code and field.** A test that only
 *    checked "something was rejected" keeps passing while the rejection moves
 *    to the wrong cause, which is exactly how a fixture ends up proving
 *    nothing.
 *  - **Every refusal fixture has an unmutated CONTROL.** Without one, the
 *    slicing that built the fixture could be what refuses.
 *  - **The version half and the structural half cannot be confused.** Every
 *    structural fixture carries the anchor version untouched; every version
 *    fixture is structurally perfect. `fixtures/synthetic-codex-structure/README.md`
 *    records both directions, and this file asserts them rather than trusting
 *    the README - see the describe block "the structural half and the version
 *    half cannot be confused".
 *
 * Nothing here writes anything anywhere. Every input is a committed file.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CODEX_CALL_PAYLOAD_TYPES,
  CODEX_DIALECT_BY_NAMESPACE,
  CODEX_DIALECT_SOURCE_ORDER,
  CODEX_RECORD_KEYS,
  CODEX_SESSION_META_FIELDS,
  CODEX_SPAWN_TOOL_NAME,
  CODEX_THREAD_SPAWN_FIELDS,
  CODEX_VERSION_WINDOW,
  PINNED_CODEX_VERSION,
  codexVersionWindow,
  fingerprintThread,
  isCodexVersionAccepted,
  parseCodexVersion,
} from './fingerprint.js';
import type { CodexMismatchCode } from './types.js';

// ---------------------------------------------------------------------------
// Corpora on disk
// ---------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));

/**
 * The anchor's corpus directory name, DERIVED from the constant. Writing
 * `codex-0.151.0-alpha.7.2` here as a literal would make the two agree by
 * coincidence rather than by construction, and the constant could then move
 * without this file noticing.
 */
const ANCHOR_CORPUS = `codex-${PINNED_CODEX_VERSION}`;
const ANCHOR_DIR = join(FIXTURES, ANCHOR_CORPUS);
const MUTATIONS_DIR = join(FIXTURES, 'synthetic-codex-structure');

/** Every rollout transcript under a corpus directory. Hook streams excluded. */
function transcripts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...transcripts(full));
      continue;
    }
    if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out.sort();
}

function readRecords(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/** One committed mutation fixture, by filename. */
function mutation(name: string): unknown[] {
  return readRecords(join(MUTATIONS_DIR, name));
}

/**
 * The corpus's transcripts, derived from the directory. **The count is never
 * written down** — a fixture-set size hard-coded against one harvest breaks on
 * the next one and reads as a regression (recorded rule).
 */
const CORPUS_TRANSCRIPTS = transcripts(ANCHOR_DIR);

/** The run directory a transcript belongs to, e.g. `long-output`. */
function runOf(path: string): string {
  const rel = path.slice(ANCHOR_DIR.length).replace(/\\/g, '/').replace(/^\//, '');
  return rel.split('/')[0] as string;
}

// ---------------------------------------------------------------------------
// The anchor
// ---------------------------------------------------------------------------

describe('PINNED_CODEX_VERSION is a provenance anchor, not a support claim', () => {
  it('names a corpus directory that exists and holds transcripts', () => {
    const corpora = readdirSync(FIXTURES, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('codex-'))
      .map((d) => d.name);
    expect(corpora, `no fixtures/${ANCHOR_CORPUS}/ for the anchor`).toContain(ANCHOR_CORPUS);
    expect(CORPUS_TRANSCRIPTS.length).toBeGreaterThan(0);
  });

  it('is the cli_version every session_meta in that corpus carries', () => {
    const versions = new Set<unknown>();
    for (const path of CORPUS_TRANSCRIPTS) {
      for (const record of readRecords(path)) {
        const r = record as { type: string; payload: { cli_version?: unknown } };
        if (r.type === 'session_meta') versions.add(r.payload.cli_version);
      }
    }
    // Both legs: the set is exactly the anchor, and it is not empty. An empty
    // set would satisfy a subset check while proving nothing was read.
    expect([...versions]).toEqual([PINNED_CODEX_VERSION]);
  });

  it('parses, so the window it defines is a real window', () => {
    expect(parseCodexVersion(PINNED_CODEX_VERSION)).toEqual({
      major: 0,
      minor: 151,
      patch: 0,
      prerelease: 'alpha.7.2',
      build: null,
    });
  });
});

// ---------------------------------------------------------------------------
// The version half (G9, spec C9)
// ---------------------------------------------------------------------------

describe('parseCodexVersion is defensive: it never guesses', () => {
  it('decomposes a plain three-component version', () => {
    expect(parseCodexVersion('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
      build: null,
    });
  });

  it('decomposes a prerelease and build metadata without honouring either', () => {
    expect(parseCodexVersion('0.151.4-rc.1+2026090301')).toEqual({
      major: 0,
      minor: 151,
      patch: 4,
      prerelease: 'rc.1',
      build: '2026090301',
    });
  });

  it.each([
    ['too few components', '0.151'],
    ['too many components', '0.151.0.1'],
    ['a leading v', 'v0.151.0'],
    ['a leading zero', '00.151.0'],
    ['an empty prerelease', '0.151.0-'],
    ['a non-numeric patch', '0.151.x'],
    ['a bare word', 'nightly'],
    ['the empty string', ''],
    ['leading whitespace', ' 0.151.0'],
    ['trailing whitespace', '0.151.0 '],
  ])('returns undefined for %s', (_why, value) => {
    expect(parseCodexVersion(value)).toBeUndefined();
  });

  const NON_STRINGS: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 151],
    ['an object', { major: 0 }],
  ];

  it.each(NON_STRINGS)('returns undefined rather than throwing for %s', (_why, value) => {
    expect(parseCodexVersion(value)).toBeUndefined();
  });
});

describe('the G9 window: major exact, minor +/-1, patch and prerelease uncompared', () => {
  const window = codexVersionWindow();

  it('derives its bounds from CODEX_VERSION_WINDOW rather than from a literal', () => {
    const anchor = parseCodexVersion(PINNED_CODEX_VERSION)!;
    expect(window).toEqual({
      anchor: PINNED_CODEX_VERSION,
      major: anchor.major,
      minMinor: anchor.minor - CODEX_VERSION_WINDOW.minor,
      maxMinor: anchor.minor + CODEX_VERSION_WINDOW.minor,
      label: `${anchor.major}.${anchor.minor - CODEX_VERSION_WINDOW.minor}.x-* - ${anchor.major}.${anchor.minor + CODEX_VERSION_WINDOW.minor}.x-*`,
    });
  });

  it('accepts the anchor itself', () => {
    expect(isCodexVersionAccepted(PINNED_CODEX_VERSION)).toBe(true);
  });

  it.each(['0.150.0-alpha.7.2', '0.151.0-alpha.7.2', '0.152.0-alpha.7.2'])(
    'accepts %s: the minor is within one step',
    (version) => {
      expect(isCodexVersionAccepted(version)).toBe(true);
    },
  );

  it.each(['0.149.0-alpha.7.2', '0.153.0-alpha.7.2', '0.0.0-alpha.7.2', '0.999.0'])(
    'refuses %s: the minor is two or more steps away',
    (version) => {
      expect(isCodexVersionAccepted(version)).toBe(false);
    },
  );

  it.each(['1.151.0-alpha.7.2', '2.151.0', '1.150.0'])(
    'refuses %s: the major must match exactly',
    (version) => {
      expect(isCodexVersionAccepted(version)).toBe(false);
    },
  );

  it.each(['0.151.1-alpha.7.2', '0.151.999-alpha.7.2', '0.150.874', '0.152.12'])(
    'accepts %s: the patch component is not compared at all',
    (version) => {
      expect(isCodexVersionAccepted(version)).toBe(true);
    },
  );

  it.each([
    '0.151.0',
    '0.151.0-alpha.7.3',
    '0.151.0-alpha.8.0',
    '0.151.0-beta.1',
    '0.151.0-rc.1',
    '0.151.0-nightly.20260903',
    '0.151.0-alpha.7.2+build.9',
  ])('accepts %s: a prerelease difference ALONE never refuses', (version) => {
    // The anchor is itself a prerelease. If the tag were compared, every one
    // of these would black out, which is the CC blackout with a new field.
    expect(isCodexVersionAccepted(version)).toBe(true);
    expect(version === PINNED_CODEX_VERSION).toBe(version === '0.151.0-alpha.7.2');
  });

  it.each(['nightly', '0.151', '', 'v0.152.0'])(
    'refuses %s: an unparseable version is a mismatch, not a crash',
    (version) => {
      expect(isCodexVersionAccepted(version)).toBe(false);
    },
  );

  it('is not vacuously permissive: the accepted set has a boundary on both sides', () => {
    // A predicate that returned true for everything would satisfy every
    // "accepts" case above. These two are the cheapest thing that goes red.
    expect(isCodexVersionAccepted('0.152.999')).toBe(true);
    expect(isCodexVersionAccepted('0.153.0')).toBe(false);
  });

  it('accepts an unparseable ANCHOR only as an exact string match', () => {
    expect(codexVersionWindow('nightly')).toBeUndefined();
    expect(isCodexVersionAccepted('nightly', 'nightly')).toBe(true);
    expect(isCodexVersionAccepted('0.151.0', 'nightly')).toBe(false);
  });

  it('never lets the minor floor go below zero', () => {
    expect(codexVersionWindow('3.0.0')).toMatchObject({ minMinor: 0, maxMinor: 1 });
    expect(isCodexVersionAccepted('3.1.7', '3.0.0')).toBe(true);
    expect(isCodexVersionAccepted('3.2.0', '3.0.0')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The constants agree with the corpus
// ---------------------------------------------------------------------------

describe('the asserted structure is the structure the corpus has', () => {
  it('CODEX_RECORD_KEYS is exactly the key set of every record in the corpus', () => {
    const seen = new Set<string>();
    let records = 0;
    for (const path of CORPUS_TRANSCRIPTS) {
      for (const record of readRecords(path)) {
        records += 1;
        for (const key of Object.keys(record as object)) seen.add(key);
      }
    }
    expect(records).toBeGreaterThan(0);
    expect([...seen].sort()).toEqual([...CODEX_RECORD_KEYS].sort());
  });

  it('every session_meta in the corpus carries the fields C3 requires', () => {
    let metas = 0;
    let subagents = 0;
    for (const path of CORPUS_TRANSCRIPTS) {
      for (const record of readRecords(path)) {
        const r = record as { type: string; payload: Record<string, unknown> };
        if (r.type !== 'session_meta') continue;
        metas += 1;
        for (const field of CODEX_SESSION_META_FIELDS) {
          expect(typeof r.payload[field], `${field} on ${runOf(path)}`).toBe('string');
        }
        expect(typeof r.payload['cli_version']).toBe('string');
        if (r.payload['thread_source'] !== 'subagent') continue;
        subagents += 1;
        const spawn = (
          r.payload['source'] as { subagent: { thread_spawn: Record<string, unknown> } }
        ).subagent.thread_spawn;
        for (const field of CODEX_THREAD_SPAWN_FIELDS) {
          expect(spawn[field], `${field} on ${runOf(path)}`).not.toBeUndefined();
        }
      }
    }
    expect(metas).toBeGreaterThan(0);
    expect(subagents).toBeGreaterThan(0);
  });

  it('both call payload types occur, so neither branch of the call_id check is dead', () => {
    const kinds = new Set<string>();
    const namespaces = new Set<string>();
    for (const path of CORPUS_TRANSCRIPTS) {
      for (const record of readRecords(path)) {
        const r = record as { type: string; payload: Record<string, unknown> };
        if (r.type !== 'response_item') continue;
        const type = r.payload['type'];
        if (typeof type === 'string' && CODEX_CALL_PAYLOAD_TYPES.includes(type)) kinds.add(type);
        if (r.payload['name'] === CODEX_SPAWN_TOOL_NAME && typeof r.payload['namespace'] === 'string') {
          namespaces.add(r.payload['namespace']);
        }
      }
    }
    expect([...kinds].sort()).toEqual([...CODEX_CALL_PAYLOAD_TYPES].sort());
    // Both dialects' spawn namespaces are present, so the namespace map has no
    // key the corpus cannot witness and no witness the map does not know.
    expect([...namespaces].sort()).toEqual([...CODEX_DIALECT_BY_NAMESPACE.keys()].sort());
  });
});

// ---------------------------------------------------------------------------
// The real corpus fingerprints
// ---------------------------------------------------------------------------

describe('every transcript in the committed corpus fingerprints', () => {
  it.each(CORPUS_TRANSCRIPTS.map((p): [string, string] => [runOf(p), p]))(
    '%s / %s is accepted, with the anchor version',
    (_run, path) => {
      const result = fingerprintThread(readRecords(path), { file: path });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.cliVersion).toBe(PINNED_CODEX_VERSION);
    },
  );

  it('refuses none of them — the accept count equals the transcript count', () => {
    const refused = CORPUS_TRANSCRIPTS.filter(
      (p) => !fingerprintThread(readRecords(p), { file: p }).ok,
    );
    expect(refused).toEqual([]);
  });
});

describe('the dialect, resolved from the session being observed (C3a)', () => {
  /** Every transcript of one run, fingerprinted. */
  function runResults(run: string) {
    const paths = CORPUS_TRANSCRIPTS.filter((p) => runOf(p) === run);
    expect(paths.length, `no transcripts for run ${run}`).toBeGreaterThan(0);
    return paths.map((p) => ({ path: p, result: fingerprintThread(readRecords(p), { file: p }) }));
  }

  it.each(['baseline', 'dup-names', 'spawn-shapes'])('%s is v2', (run) => {
    for (const { path, result } of runResults(run)) {
      expect(result.ok, path).toBe(true);
      if (!result.ok) continue;
      expect(result.dialect, path).toBe('v2');
    }
  });

  it.each(['resume-twice-v1', 'long-output'])(
    '%s is v1 and is NOT REFUSED — the ruling that was reversed on corrected evidence',
    (run) => {
      for (const { path, result } of runResults(run)) {
        expect(result.ok, `${path} was refused: ${JSON.stringify(result)}`).toBe(true);
        if (!result.ok) continue;
        expect(result.dialect, path).toBe('v1');
      }
    },
  );

  it('long-output — one thread, no spawn — is typed by turn_context ALONE', () => {
    const results = runResults('long-output');
    expect(results).toHaveLength(1);
    const { path, result } = results[0]!;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dialect).toBe('v1');
    expect(result.dialectSource).toBe('turn_context.multi_agent_version');

    // The claim that makes this test the reason the resolution order exists:
    // the two other sources are ABSENT from this transcript, so a resolver
    // reading session_meta alone could not have typed it. Asserted against the
    // bytes rather than restated from the spec.
    let metasWithDialect = 0;
    let spawns = 0;
    for (const record of readRecords(path)) {
      const r = record as { type: string; payload: Record<string, unknown> };
      if (r.type === 'session_meta' && r.payload['multi_agent_version'] !== undefined) {
        metasWithDialect += 1;
      }
      if (r.type === 'response_item' && r.payload['name'] === CODEX_SPAWN_TOOL_NAME) spawns += 1;
    }
    expect(metasWithDialect).toBe(0);
    expect(spawns).toBe(0);
  });

  it('session_meta states no dialect on ANY root thread in the corpus', () => {
    // The measurement C3a rests on, re-derived here rather than cited: this is
    // why session_meta cannot be first in the resolution order.
    let roots = 0;
    let rootsStatingADialect = 0;
    for (const path of CORPUS_TRANSCRIPTS) {
      for (const record of readRecords(path)) {
        const r = record as { type: string; payload: Record<string, unknown> };
        if (r.type !== 'session_meta') continue;
        if (r.payload['thread_source'] !== 'user') continue;
        roots += 1;
        if (r.payload['multi_agent_version'] !== undefined) rootsStatingADialect += 1;
      }
    }
    expect(roots).toBeGreaterThan(0);
    expect(rootsStatingADialect).toBe(0);
  });

  it('reports turn_context as the source everywhere in the corpus', () => {
    for (const path of CORPUS_TRANSCRIPTS) {
      const result = fingerprintThread(readRecords(path), { file: path });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.dialectSource, path).toBe('turn_context.multi_agent_version');
    }
  });

  it('orders the three sources exactly as C3a states', () => {
    expect(CODEX_DIALECT_SOURCE_ORDER).toEqual([
      'turn_context.multi_agent_version',
      'session_meta.multi_agent_version',
      'spawn_namespace',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The mutation corpus
// ---------------------------------------------------------------------------

/** Each refusal fixture, with the EXACT code and field it must produce. */
const REFUSALS: [string, CodexMismatchCode, string][] = [
  ['session-meta-missing.jsonl', 'sessionMetaMissing', 'session_meta'],
  ['session-meta-not-at-ordinal-zero.jsonl', 'sessionMetaMissing', 'session_meta'],
  ['session-meta-field-missing-id.jsonl', 'sessionMetaFieldMissing', 'session_meta.payload.id'],
  ['session-meta-field-missing-cwd.jsonl', 'sessionMetaFieldMissing', 'session_meta.payload.cwd'],
  [
    'session-meta-field-missing-thread-source.jsonl',
    'sessionMetaFieldMissing',
    'session_meta.payload.thread_source',
  ],
  ['cli-version-missing.jsonl', 'cliVersionMissing', 'session_meta.payload.cli_version'],
  ['record-shape-extra-key.jsonl', 'recordShapeMismatch', 'record'],
  ['record-shape-missing-key.jsonl', 'recordShapeMismatch', 'record'],
  ['record-shape-ordinal-not-a-number.jsonl', 'recordShapeMismatch', 'record'],
  [
    'subagent-spawn-missing.jsonl',
    'subagentSpawnMissing',
    'session_meta.payload.source.subagent.thread_spawn',
  ],
  [
    'subagent-spawn-no-depth.jsonl',
    'subagentSpawnMissing',
    'session_meta.payload.source.subagent.thread_spawn.depth',
  ],
  [
    'subagent-spawn-no-parent-thread-id.jsonl',
    'subagentSpawnMissing',
    'session_meta.payload.source.subagent.thread_spawn.parent_thread_id',
  ],
  ['call-id-missing-function-call.jsonl', 'callIdMissing', 'function_call.call_id'],
  ['call-id-missing-custom-tool-call.jsonl', 'callIdMissing', 'custom_tool_call.call_id'],
  [
    'version-out-of-window-major.jsonl',
    'versionOutOfWindow',
    'session_meta.payload.cli_version',
  ],
  [
    'version-out-of-window-minor-below.jsonl',
    'versionOutOfWindow',
    'session_meta.payload.cli_version',
  ],
  [
    'version-out-of-window-minor-above.jsonl',
    'versionOutOfWindow',
    'session_meta.payload.cli_version',
  ],
  ['version-unparseable.jsonl', 'versionOutOfWindow', 'session_meta.payload.cli_version'],
  [
    'version-unparseable-two-components.jsonl',
    'versionOutOfWindow',
    'session_meta.payload.cli_version',
  ],
  [
    'dialect-contradiction-meta-vs-turn-context.jsonl',
    'dialectContradiction',
    'session_meta.multi_agent_version',
  ],
  [
    'dialect-contradiction-namespace-vs-turn-context.jsonl',
    'dialectContradiction',
    'spawn_namespace',
  ],
];

/** Each fixture that must be ACCEPTED, with the dialect it must report. */
const ACCEPTED: [string, 'v1' | 'v2' | null, string | null][] = [
  ['ok-root-v2.jsonl', 'v2', 'turn_context.multi_agent_version'],
  ['ok-subagent-v2.jsonl', 'v2', 'turn_context.multi_agent_version'],
  ['ok-root-v1.jsonl', 'v1', 'turn_context.multi_agent_version'],
  ['ok-root-v1-no-spawn.jsonl', 'v1', 'turn_context.multi_agent_version'],
  ['subagent-agent-path-absent.jsonl', 'v2', 'turn_context.multi_agent_version'],
  ['subagent-agent-path-null.jsonl', 'v2', 'turn_context.multi_agent_version'],
  ['dialect-absent.jsonl', null, null],
  ['dialect-unrecognised.jsonl', null, null],
  ['dialect-namespace-only.jsonl', 'v2', 'spawn_namespace'],
  ['dialect-session-meta-only.jsonl', 'v2', 'session_meta.multi_agent_version'],
  ['version-in-window-minor-below.jsonl', 'v2', 'turn_context.multi_agent_version'],
  ['version-in-window-minor-above.jsonl', 'v2', 'turn_context.multi_agent_version'],
  ['version-in-window-patch-far.jsonl', 'v2', 'turn_context.multi_agent_version'],
  ['version-in-window-other-prerelease.jsonl', 'v2', 'turn_context.multi_agent_version'],
  ['version-in-window-no-prerelease.jsonl', 'v2', 'turn_context.multi_agent_version'],
];

describe('the mutation corpus is fully consumed', () => {
  it('every committed fixture is named by exactly one case, never quietly dropped', () => {
    const onDisk = readdirSync(MUTATIONS_DIR)
      .filter((n) => n.endsWith('.jsonl'))
      .sort();
    const named = [...REFUSALS.map(([n]) => n), ...ACCEPTED.map(([n]) => n)].sort();
    expect(onDisk).toEqual(named);
    // The count pinned beside the set: a set comparison written against an
    // empty listing passes vacuously, and this is the cheapest thing that goes
    // red when it does (rule 19, applied to a fixture directory).
    expect(onDisk.length).toBe(REFUSALS.length + ACCEPTED.length);
    expect(new Set(named).size).toBe(named.length);
  });

  it('covers every member of CodexMismatchCode', () => {
    // The code list is the frozen hand-off line; this is the assertion that
    // makes "one mutation fixture per refusal code" checkable rather than
    // claimed. A new code added to types.ts fails here until it has a fixture.
    const covered = new Set(REFUSALS.map(([, code]) => code));
    const declared: CodexMismatchCode[] = [
      'sessionMetaMissing',
      'cliVersionMissing',
      'recordShapeMismatch',
      'sessionMetaFieldMissing',
      'subagentSpawnMissing',
      'callIdMissing',
      'versionOutOfWindow',
      'dialectContradiction',
    ];
    expect([...covered].sort()).toEqual([...declared].sort());
  });
});

describe('refusals name the exact cause (G3: no tree, never a partial one)', () => {
  it.each(REFUSALS)('%s refuses with %s at %s', (name, code, field) => {
    const result = fingerprintThread(mutation(name), { file: name });
    expect(result.ok, `${name} was ACCEPTED: ${JSON.stringify(result)}`).toBe(false);
    if (result.ok) return;
    expect(result.mismatch.code).toBe(code);
    expect(result.mismatch.field).toBe(field);
    expect(result.mismatch.at).toMatch(new RegExp(`^${name.replace(/\./g, '\\.')}:`));
  });
});

describe('acceptances: the fingerprint refuses on structure and NOTHING else', () => {
  it.each(ACCEPTED)('%s is accepted as dialect %s from %s', (name, dialect, source) => {
    const result = fingerprintThread(mutation(name), { file: name });
    expect(result.ok, `${name} was REFUSED: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;
    expect(result.dialect).toBe(dialect);
    expect(result.dialectSource).toBe(source);
  });

  it('the four unmutated controls pass, so a refusal is caused by its mutation', () => {
    for (const name of [
      'ok-root-v2.jsonl',
      'ok-subagent-v2.jsonl',
      'ok-root-v1.jsonl',
      'ok-root-v1-no-spawn.jsonl',
    ]) {
      const result = fingerprintThread(mutation(name), { file: name });
      expect(result.ok, name).toBe(true);
      if (!result.ok) continue;
      expect(result.cliVersion, name).toBe(PINNED_CODEX_VERSION);
    }
  });
});

describe('the structural half and the version half cannot be confused', () => {
  // The recorded trap: `synthetic-layout/07` and `08` had to be re-versioned
  // TWICE because a refusal fixture whose version quietly became acceptable
  // does not fail — it passes, while testing nothing. Both directions are
  // asserted rather than left to the README.

  it('every STRUCTURAL refusal fixture carries an in-window version', () => {
    for (const [name, code] of REFUSALS) {
      if (code === 'versionOutOfWindow') continue;
      for (const record of mutation(name)) {
        const r = record as { type?: string; payload?: { cli_version?: unknown } };
        if (r.type !== 'session_meta') continue;
        const version = r.payload?.cli_version;
        // `cli-version-missing` is the one that legitimately has none.
        if (version === undefined) {
          expect(name).toBe('cli-version-missing.jsonl');
          continue;
        }
        expect(isCodexVersionAccepted(version), `${name} carries ${String(version)}`).toBe(true);
      }
    }
  });

  it('every VERSION fixture is structurally perfect but for its version string', () => {
    const versionFixtures = [...REFUSALS.map(([n]) => n), ...ACCEPTED.map(([n]) => n)].filter(
      (n) => n.startsWith('version-'),
    );
    expect(versionFixtures.length).toBeGreaterThan(0);
    for (const name of versionFixtures) {
      const records = mutation(name);
      // Restoring the anchor version must make the whole fixture pass. If
      // anything else in it were broken, this would not.
      const restored = records.map((record) => {
        const r = JSON.parse(JSON.stringify(record)) as {
          type: string;
          payload: Record<string, unknown>;
        };
        if (r.type === 'session_meta') r.payload['cli_version'] = PINNED_CODEX_VERSION;
        return r;
      });
      const result = fingerprintThread(restored, { file: name });
      expect(result.ok, `${name} is refused for a NON-version reason too`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// agent_path — the field that is deliberately not asserted
// ---------------------------------------------------------------------------

describe('agent_path is deliberately outside the fingerprint (spec C3)', () => {
  it('is absent from the required thread_spawn fields', () => {
    expect(CODEX_THREAD_SPAWN_FIELDS).toEqual(['depth', 'parent_thread_id']);
    expect(CODEX_THREAD_SPAWN_FIELDS).not.toContain('agent_path');
  });

  it('a subagent with NO agent_path key at all is accepted', () => {
    const records = mutation('subagent-agent-path-absent.jsonl');
    // The fixture really does lack it — otherwise this test asserts nothing.
    for (const record of records) {
      const r = record as { type: string; payload: Record<string, unknown> };
      if (r.type !== 'session_meta') continue;
      expect(r.payload['agent_path']).toBeUndefined();
    }
    expect(fingerprintThread(records, { file: 'agent-path-absent' }).ok).toBe(true);
  });

  it('a subagent whose agent_path is present-and-null is accepted (the v1 shape)', () => {
    const records = mutation('subagent-agent-path-null.jsonl');
    const nulls = records.filter((record) => {
      const r = record as { type: string; payload: Record<string, unknown> };
      return r.type === 'session_meta' && r.payload['agent_path'] === null;
    });
    expect(nulls.length).toBeGreaterThan(0);
    expect(fingerprintThread(records, { file: 'agent-path-null' }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hostile input: a refusal is returned, never thrown
// ---------------------------------------------------------------------------

describe('never throws: a refusal is a value (G3)', () => {
  const HOSTILE: [string, unknown[], CodexMismatchCode][] = [
    ['an empty thread', [], 'sessionMetaMissing'],
    ['a null record', [null], 'recordShapeMismatch'],
    ['a string record', ['session_meta'], 'recordShapeMismatch'],
    ['an empty object', [{}], 'recordShapeMismatch'],
    ['an array record', [[]], 'recordShapeMismatch'],
    [
      'a record with a null payload at ordinal 0',
      [{ timestamp: 't', ordinal: 0, type: 'session_meta', payload: null }],
      'sessionMetaFieldMissing',
    ],
  ];

  it.each(HOSTILE)('%s refuses with %s', (_why, records, code) => {
    const result = fingerprintThread(records);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatch.code).toBe(code);
  });

  it('reports a position even when the ordinal is what is malformed', () => {
    const result = fingerprintThread([{ ordinal: 'zero' }], { file: 'x.jsonl' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatch.at).toBe('x.jsonl:#0');
  });
});

describe('CodexMismatch.at is a basename and an ordinal, never a path', () => {
  it('reduces a full path to its basename in either separator', () => {
    const records = mutation('cli-version-missing.jsonl');
    for (const given of [
      'C:\\Users\\dev\\.codex\\sessions\\2026\\09\\03\\rollout-x.jsonl',
      '/home/dev/.codex/sessions/2026/09/03/rollout-x.jsonl',
    ]) {
      const result = fingerprintThread(records, { file: given });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.mismatch.at).toBe('rollout-x.jsonl:0');
      expect(result.mismatch.at).not.toContain('dev');
    }
  });

  it('falls back to the bare ordinal when no file is named', () => {
    const result = fingerprintThread(mutation('cli-version-missing.jsonl'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatch.at).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// The anchor is an argument, not a hard-coded comparison
// ---------------------------------------------------------------------------

describe('the anchor can be moved by a caller, and the window moves with it', () => {
  it('accepts a corpus transcript under a neighbouring anchor', () => {
    const path = CORPUS_TRANSCRIPTS[0]!;
    expect(fingerprintThread(readRecords(path), { anchor: '0.152.4' }).ok).toBe(true);
  });

  it('refuses the same transcript under a distant anchor', () => {
    const path = CORPUS_TRANSCRIPTS[0]!;
    const result = fingerprintThread(readRecords(path), { anchor: '9.0.0', file: path });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatch.code).toBe('versionOutOfWindow');
  });
});
