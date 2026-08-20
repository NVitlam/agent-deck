/**
 * Tests for the schema fingerprint.
 *
 * Two fixture trees are used and never mixed up:
 *
 *   fixtures/cc-2.1.234/     captured from real CC 2.1.234 sessions. Ground
 *                            truth: if the fingerprint refuses anything here,
 *                            the rule is wrong (G6).
 *   fixtures/cc-2.1.237/     captured from a real CC 2.1.237 session and then
 *                            content-destroyed. Ground truth about SHAPE only;
 *                            it cannot say anything about content.
 *   fixtures/synthetic-layout/  hand-mutated, invented. Evidence about *our*
 *                            behaviour, never about CC's.
 *
 * Every mutation is asserted by its own reason code. "It was rejected" is not
 * an assertion — a mutation rejected for the wrong reason would pass that.
 *
 * Nothing is written inside the repo. The two tests that need a hostile file
 * (unreadable / vanished) build it under the OS temp directory, and one test
 * asserts that fingerprinting the captured tree leaves it byte-identical (G1).
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ParseResult } from '../model/events.js';
import { isSchemaMismatch } from '../model/events.js';
import {
  PINNED_CC_VERSION,
  REQUIRED_ENTRY_FIELDS,
  REQUIRED_META_FIELDS,
  VERSION_WINDOW,
  fingerprintSession,
  fingerprintSlugDirectory,
  isFingerprintMismatch,
  isVersionAccepted,
  parseCcVersion,
  versionWindow,
} from './fingerprint.js';
import type { FingerprintResult, MismatchCode, SessionFingerprint } from './fingerprint.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CAPTURED_SLUG = fileURLToPath(
  new URL(
    '../../fixtures/cc-2.1.234/projects/c--Users-dev-projects-agent-deck',
    import.meta.url,
  ),
);
const CAPTURED_237_SLUG = fileURLToPath(
  new URL(
    '../../fixtures/cc-2.1.237/projects/c--Users-dev-projects-agent-deck',
    import.meta.url,
  ),
);
const SYNTHETIC_ROOT = fileURLToPath(new URL('../../fixtures/synthetic-layout', import.meta.url));
const SYNTHETIC_SLUG = 'SYNTHETIC-hand-mutated-not-captured';
const SYNTHETIC_SESSION = 'deadbeef-0000-4000-8000-000000000001';

const CAPTURED_SESSION_WITH_SUBAGENTS = '05c5482d-5568-44ce-97fe-bc9a6c15afc4';
const CAPTURED_SESSION_SINGLE = '4299490e-4a09-46a0-a544-7ffb0429e7e7';

/** `fixtures/synthetic-layout/<case>/<slug>` — a whole miniature slug dir. */
function syntheticSlug(caseName: string): string {
  return join(SYNTHETIC_ROOT, caseName, SYNTHETIC_SLUG);
}

function syntheticMain(caseName: string): string {
  return join(syntheticSlug(caseName), `${SYNTHETIC_SESSION}.jsonl`);
}

/** Fingerprint a synthetic case's single session. */
async function fingerprintCase(caseName: string): Promise<FingerprintResult> {
  return fingerprintSession(syntheticMain(caseName));
}

function expectRefusal(result: FingerprintResult, code: MismatchCode) {
  if (result.ok) {
    throw new Error(`expected refusal ${code}, got ok with ${result.value.subagents.length} subagents`);
  }
  expect(result.mismatch.code).toBe(code);
  // Refusals are `SchemaMismatch`-shaped and self-describing.
  expect(result.mismatch.kind).toBe('schemaMismatch');
  expect(isSchemaMismatch(result.mismatch)).toBe(true);
  expect(isFingerprintMismatch(result.mismatch)).toBe(true);
  expect(result.mismatch.reason.length).toBeGreaterThan(0);
  return result.mismatch;
}

function expectAccepted(result: FingerprintResult): SessionFingerprint {
  if (!result.ok) {
    throw new Error(
      `expected acceptance, got ${result.mismatch.code}: ${result.mismatch.reason} @ ${String(result.mismatch.path)}`,
    );
  }
  return result.value;
}

interface Snapshot {
  path: string;
  size: number;
  sha256: string;
}

/** Content hash of every file under `root`, for the read-only assertion. */
async function snapshot(root: string): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const body = await readFile(full);
      out.push({
        path: relative(root, full).split(sep).join('/'),
        size: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
      });
    }
  };
  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

let temp: string;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'agent-deck-fp-'));
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

const BLANK_KEY_AGENT = 'asynthetic0000001';
const BLANK_KEY_TOOL_USE = 'toolu_SYNTHETIC00000000000001';

/**
 * A minimal valid session under `dir`, with the sidecar's `toolUseId` set to
 * `toolUseId` and any extra sidecar fields overridden.
 *
 * Built under the OS temp directory so the whitespace matrix does not need a
 * committed fixture per variant; the one variant worth committing is
 * `synthetic-layout/21-meta-tooluseid-whitespace`, which pins the rule.
 */
async function buildBlankKeyCase(
  dir: string,
  toolUseId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const subagents = join(dir, SYNTHETIC_SESSION, 'subagents');
  await mkdir(subagents, { recursive: true });
  const common = {
    isSidechain: false,
    sessionId: SYNTHETIC_SESSION,
    version: PINNED_CC_VERSION,
    timestamp: '2026-08-19T00:00:00.000Z',
  };
  await writeFile(
    join(dir, `${SYNTHETIC_SESSION}.jsonl`),
    `${JSON.stringify({
      ...common,
      parentUuid: null,
      type: 'assistant',
      uuid: '00000001-0000-4000-8000-000000000001',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: BLANK_KEY_TOOL_USE, name: 'Agent', input: {} }],
      },
    })}
`,
    'utf8',
  );
  await writeFile(
    join(subagents, `agent-${BLANK_KEY_AGENT}.jsonl`),
    `${JSON.stringify({
      ...common,
      parentUuid: null,
      isSidechain: true,
      type: 'user',
      uuid: '00000002-0000-4000-8000-000000000002',
      agentId: BLANK_KEY_AGENT,
      message: { role: 'user', content: [{ type: 'text', text: 'SYNTHETIC SUBAGENT PROMPT' }] },
    })}
`,
    'utf8',
  );
  await writeFile(
    join(subagents, `agent-${BLANK_KEY_AGENT}.meta.json`),
    JSON.stringify({
      agentType: 'general-purpose',
      description: 'synthetic',
      toolUseId,
      spawnDepth: 1,
      ...overrides,
    }),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Positive case — the captured tree is ground truth
// ---------------------------------------------------------------------------

describe('captured CC 2.1.234 fixtures', () => {
  it('accepts every session in the harvested slug directory', async () => {
    const slug = await fingerprintSlugDirectory(CAPTURED_SLUG);
    if (!slug.ok) throw new Error(`slug refused: ${slug.mismatch.reason}`);
    expect(slug.value.sessions.map((s) => s.sessionId)).toEqual([
      CAPTURED_SESSION_WITH_SUBAGENTS,
      CAPTURED_SESSION_SINGLE,
    ]);
    for (const session of slug.value.sessions) {
      expectAccepted(session.result);
    }
  });

  it('reads the 4-subagent session: join keys, depth-2 parent, tool-results/', async () => {
    const result = await fingerprintSession(
      join(CAPTURED_SLUG, `${CAPTURED_SESSION_WITH_SUBAGENTS}.jsonl`),
    );
    const value = expectAccepted(result);
    expect(value.version).toBe(PINNED_CC_VERSION);
    // One version across main transcript and all four subagent files.
    expect(value.versions).toEqual([PINNED_CC_VERSION]);
    expect(value.subagents).toHaveLength(4);
    expect(value.toolResultsDir).toBe(
      join(CAPTURED_SLUG, CAPTURED_SESSION_WITH_SUBAGENTS, 'tool-results'),
    );

    // Every sidecar carries the join key, and it is non-empty.
    for (const sub of value.subagents) {
      expect(sub.meta.toolUseId).toMatch(/^toolu_/);
      expect(typeof sub.meta.agentType).toBe('string');
      expect(typeof sub.meta.description).toBe('string');
    }

    const depths = value.subagents.map((s) => s.meta.spawnDepth).sort();
    expect(depths).toEqual([1, 1, 1, 2]);

    const nested = value.subagents.find((s) => s.meta.spawnDepth === 2);
    expect(nested?.meta.parentAgentId).toBe('a1a53f42c5eca8824');
    // The parent named by the depth-2 sidecar is itself one of the subagents:
    // spawnDepth >= 2 is real data, not a synthetic construction.
    expect(value.subagents.map((s) => s.agentId)).toContain(nested?.meta.parentAgentId);

    // Depth-1 sidecars carry no parentAgentId at all.
    for (const sub of value.subagents.filter((s) => s.meta.spawnDepth === 1)) {
      expect('parentAgentId' in sub.meta).toBe(false);
    }

    expect(result.ok && result.diagnostics.malformedLines).toBe(0);
    expect(result.ok && result.diagnostics.parsedLines).toBe(73); // 22 main + 51 subagent
  });

  it('reads the single-subagent session, which has no tool-results/', async () => {
    const result = await fingerprintSession(join(CAPTURED_SLUG, `${CAPTURED_SESSION_SINGLE}.jsonl`));
    const value = expectAccepted(result);
    expect(value.subagents).toHaveLength(1);
    expect(value.subagents[0]?.meta.toolUseId).toBe('toolu_018fbDjBX1ah7FTXs727doeC');
    expect(value.subagents[0]?.meta.spawnDepth).toBe(1);
    // Absence of tool-results/ is not a mismatch.
    expect(value.toolResultsDir).toBeUndefined();
    expect(result.ok && result.diagnostics.parsedLines).toBe(51); // 18 main + 33 subagent
  });

  it('leaves the captured tree byte-identical (G1: read-only)', async () => {
    const before = await snapshot(CAPTURED_SLUG);
    await fingerprintSlugDirectory(CAPTURED_SLUG);
    expect(await snapshot(CAPTURED_SLUG)).toEqual(before);
  });

  it('refuses the captured tree when the anchor moves far enough off 2.1.234', async () => {
    // Proves the version assertion is load-bearing rather than vacuous. 2.1.999
    // is 765 above the capture's third component, far outside a +/-5 window.
    const slug = await fingerprintSlugDirectory(CAPTURED_SLUG, { pinnedVersion: '2.1.999' });
    if (!slug.ok) throw new Error('slug directory itself should still be readable');
    for (const session of slug.value.sessions) {
      const mismatch = expectRefusal(session.result, 'unsupportedVersion');
      expect(mismatch.observedVersion).toBe(PINNED_CC_VERSION);
    }
  });
});

// ---------------------------------------------------------------------------
// The acceptance window
// ---------------------------------------------------------------------------

/**
 * One valid line at `version`, in a temp slug directory. Built rather than
 * committed: the window is a matrix and a fixture per row would be 20 trees
 * saying one thing each.
 */
async function sessionAtVersion(dir: string, ...versions: string[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  const main = join(dir, `${SYNTHETIC_SESSION}.jsonl`);
  const lines = versions.map((version, index) =>
    JSON.stringify({
      type: 'user',
      uuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      parentUuid: null,
      sessionId: SYNTHETIC_SESSION,
      timestamp: '2026-08-20T00:00:00.000Z',
      version,
      isSidechain: false,
      message: { role: 'user', content: [] },
    }),
  );
  await writeFile(main, `${lines.join('\n')}\n`, 'utf8');
  return main;
}

describe('CC version acceptance window', () => {
  it('derives its bounds from the anchor and the allowance, never from a literal', () => {
    const anchor = parseCcVersion(PINNED_CC_VERSION);
    if (anchor === undefined) throw new Error('the shipped anchor must parse');
    const window = versionWindow();
    if (window === undefined) throw new Error('the shipped anchor must yield a window');

    expect(window.anchor).toBe(PINNED_CC_VERSION);
    expect(window.major).toBe(anchor.major);
    expect(window.minMinor).toBe(anchor.minor - VERSION_WINDOW.minor);
    expect(window.maxMinor).toBe(anchor.minor + VERSION_WINDOW.minor);
    expect(window.minPatch).toBe(anchor.patch - VERSION_WINDOW.patch);
    expect(window.maxPatch).toBe(anchor.patch + VERSION_WINDOW.patch);

    // And, spelled out for the shipped anchor, so a silent change to either
    // constant fails here rather than only widening what the product accepts.
    expect(window.label).toBe('2.0.229 - 2.2.239');
  });

  it('moves with the anchor, and clamps at zero rather than going negative', () => {
    expect(versionWindow('9.4.100')?.label).toBe('9.3.95 - 9.5.105');
    // minor 0, patch 2: both lower bounds would be negative.
    expect(versionWindow('3.0.2')?.label).toBe('3.0.0 - 3.1.7');
    expect(isVersionAccepted('3.0.0', '3.0.2')).toBe(true);
    expect(isVersionAccepted('3.1.7', '3.0.2')).toBe(true);
    expect(isVersionAccepted('3.2.0', '3.0.2')).toBe(false);
  });

  it('accepts and refuses exactly this table, anchored on 2.1.234', () => {
    // Every row is a decision, not an illustration: the boundary rows are the
    // ones that fail if either allowance is edited.
    const table: [string, boolean][] = [
      // --- the anchor and the versions this repo has actually seen on disk
      ['2.1.234', true], // the anchor; the committed capture
      ['2.1.235', true], // seen live, +1
      ['2.1.237', true], // seen live, +3 — the update that blacked the panel out
      ['2.1.178', false], // seen live, -56 — still refused
      // --- third component, the one that moves: +/-5
      ['2.1.229', true],
      ['2.1.239', true],
      ['2.1.228', false],
      ['2.1.240', false],
      // --- second component: +/-1, and the third still applies inside it
      ['2.0.234', true],
      ['2.2.234', true],
      ['2.0.229', true], // the low corner
      ['2.2.239', true], // the high corner
      ['2.2.100', false], // between the corners, but 134 off the anchor's third
      ['2.3.234', false],
      // --- the first component is not windowed at all
      ['1.1.234', false],
      ['3.1.234', false],
      // --- not a three-component version: refused, never guessed at (G3)
      ['2.1.234-beta', false],
      ['2.1.234.1', false],
      ['2.1', false],
      ['02.1.234', false],
      ['v2.1.234', false],
      ['', false],
      ['nonsense', false],
    ];
    const wrong = table.filter(([version, want]) => isVersionAccepted(version) !== want);
    expect(wrong).toEqual([]);
  });

  it('reads a transcript at every accepted version and refuses every rejected one', async () => {
    // The predicate above is only interesting if the transcript path agrees
    // with it, so the same rows are driven through real files.
    for (const version of ['2.1.229', '2.1.234', '2.1.235', '2.1.237', '2.1.239', '2.2.239']) {
      const main = await sessionAtVersion(join(temp, `ok-${version}`), version);
      const value = expectAccepted(await fingerprintSession(main));
      expect(value.version, version).toBe(version);
      expect(value.versions, version).toEqual([version]);
    }
    for (const version of ['2.1.178', '2.1.228', '2.1.240', '2.2.100', '3.1.234', '2.1.234-beta']) {
      const main = await sessionAtVersion(join(temp, `no-${version}`), version);
      const mismatch = expectRefusal(await fingerprintSession(main), 'unsupportedVersion');
      expect(mismatch.observedVersion, version).toBe(version);
      expect(mismatch.expected, version).toBe(PINNED_CC_VERSION);
      expect(mismatch.field, version).toBe('version');
    }
  });

  it('accepts a mid-file change while every version stays inside the window', async () => {
    // Three steps in one file, in the order CC actually shipped them.
    const main = await sessionAtVersion(join(temp, 'drift-in'), '2.1.234', '2.1.235', '2.1.237');
    const value = expectAccepted(await fingerprintSession(main));
    expect(value.versions).toEqual(['2.1.234', '2.1.235', '2.1.237']);
    expect(value.version).toBeUndefined();
  });

  it('refuses a mid-file change that leaves the window, naming the line', async () => {
    const main = await sessionAtVersion(join(temp, 'drift-out'), '2.1.234', '2.1.235', '2.1.400');
    const mismatch = expectRefusal(await fingerprintSession(main), 'versionChangedMidFile');
    expect(mismatch.expected).toBe('2.1.234');
    expect(mismatch.actual).toBe('2.1.400');
    expect(mismatch.observedVersion).toBe('2.1.400');
    expect(mismatch.path).toMatch(/:3$/);
  });

  it('refuses from the first line when a file STARTS outside the window', async () => {
    // Not a mid-file story: there is nothing to drift from yet, so the generic
    // code is correct and the mid-file code would be a lie.
    const main = await sessionAtVersion(join(temp, 'starts-out'), '2.1.178', '2.1.234');
    const mismatch = expectRefusal(await fingerprintSession(main), 'unsupportedVersion');
    expect(mismatch.observedVersion).toBe('2.1.178');
    expect(mismatch.path).toMatch(/:1$/);
  });

  it('parses only strict three-component versions', () => {
    expect(parseCcVersion('2.1.234')).toEqual({ major: 2, minor: 1, patch: 234 });
    expect(parseCcVersion('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 });
    for (const bad of ['2.1', '2.1.234.1', '2.1.234-beta', '02.1.234', '2.01.234', ' 2.1.234', '']) {
      expect(parseCcVersion(bad), bad).toBeUndefined();
    }
  });

  it('accepts an anchor that does not parse, but then only itself', () => {
    // A pinnedVersion override is a test affordance; if it is nonsense the
    // rule degrades to exact equality rather than to "everything".
    expect(versionWindow('not-a-version')).toBeUndefined();
    expect(isVersionAccepted('not-a-version', 'not-a-version')).toBe(true);
    expect(isVersionAccepted('2.1.234', 'not-a-version')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The CC 2.1.237 capture — content destroyed, shape intact
// ---------------------------------------------------------------------------

describe('captured CC 2.1.237 fixture (redacted)', () => {
  it('accepts the 2.1.237 session that the single pin refused', async () => {
    const slug = await fingerprintSlugDirectory(CAPTURED_237_SLUG);
    if (!slug.ok) throw new Error(`slug refused: ${slug.mismatch.reason}`);
    expect(slug.value.sessions.length).toBeGreaterThan(0);
    for (const session of slug.value.sessions) {
      const value = expectAccepted(session.result);
      expect(value.versions).toEqual(['2.1.237']);
      expect(session.result.ok && session.result.diagnostics.malformedLines).toBe(0);
      expect(session.result.ok && session.result.diagnostics.parsedLines).toBeGreaterThan(0);
    }
  });

  it('refuses the same tree with the anchor two windows away', async () => {
    // The acceptance above is a decision, not an accident of a permissive rule.
    const slug = await fingerprintSlugDirectory(CAPTURED_237_SLUG, { pinnedVersion: '2.1.100' });
    if (!slug.ok) throw new Error('slug directory itself should still be readable');
    for (const session of slug.value.sessions) {
      const mismatch = expectRefusal(session.result, 'unsupportedVersion');
      expect(mismatch.observedVersion).toBe('2.1.237');
    }
  });

  it('carries record types the requirement table has never seen, and tolerates them', async () => {
    // 2.1.237 introduced `atis-latch`. The fingerprint requires only `type` of
    // a record kind it does not know, which is why the capture is accepted.
    const slug = await fingerprintSlugDirectory(CAPTURED_237_SLUG);
    if (!slug.ok) throw new Error(slug.mismatch.reason);
    const types = new Set<string>();
    for (const session of slug.value.sessions) {
      const text = await readFile(session.mainTranscript, 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        const entry: unknown = JSON.parse(line);
        const type = (entry as { type?: unknown }).type;
        if (typeof type === 'string') types.add(type);
      }
    }
    const unknown = [...types].filter((type) => !REQUIRED_ENTRY_FIELDS.has(type));
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown).toContain('atis-latch');
  });

  it('contains no conversation content (the redaction whitelist held)', async () => {
    // The capture is this repo's own session, content-destroyed. The guard is
    // a length bound: every surviving string is an id, a path, a timestamp or
    // a marker, and none of those is long. Prose would blow straight past it.
    const slug = await fingerprintSlugDirectory(CAPTURED_237_SLUG);
    if (!slug.ok) throw new Error(slug.mismatch.reason);
    let longest = '';
    const visit = (value: unknown): void => {
      if (typeof value === 'string') {
        if (value.length > longest.length) longest = value;
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const item of Object.values(value)) visit(item);
      }
    };
    for (const session of slug.value.sessions) {
      const text = await readFile(session.mainTranscript, 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim() !== '') visit(JSON.parse(line));
      }
      // The capture has thinking blocks; G4 says neither half may survive.
      expect(text).toContain('"type":"thinking"');
      expect(text).toContain('"thinking":"<redacted>"');
      expect(text).toContain('"signature":"<redacted>"');
    }
    // The one long-ish string is the workspace path, kept deliberately.
    expect(longest.length).toBeLessThanOrEqual(64);
    expect(longest.toLowerCase()).toContain('agent-deck');
  });

  it('leaves the 2.1.237 capture byte-identical (G1: read-only)', async () => {
    const before = await snapshot(CAPTURED_237_SLUG);
    await fingerprintSlugDirectory(CAPTURED_237_SLUG);
    expect(await snapshot(CAPTURED_237_SLUG)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Synthetic control — accepted, so every mutation is one edit from valid
// ---------------------------------------------------------------------------

describe('synthetic control case', () => {
  it('accepts 00-valid-control, ignoring strays, unknown fields and unknown record types', async () => {
    const value = expectAccepted(await fingerprintCase('00-valid-control'));
    expect(value.subagents.map((s) => s.agentId)).toEqual([
      'asynthetic0000001',
      'asynthetic0000002',
    ]);
    expect(value.version).toBe(PINNED_CC_VERSION);
    // Strays inside the session directory are ignored, never a mismatch.
    const ignored = value.ignored.map((p) => relative(value.sessionDir, p).split(sep).join('/'));
    expect(ignored).toContain('auto-mode-classifier-error.txt');
    expect(ignored).toContain('notes');
    expect(ignored).toContain('subagents/README-stray.txt');
  });

  it('never treats the sibling memory/ directory as a session', async () => {
    const slug = await fingerprintSlugDirectory(syntheticSlug('00-valid-control'));
    if (!slug.ok) throw new Error(slug.mismatch.reason);
    expect(slug.value.sessions.map((s) => s.sessionId)).toEqual([SYNTHETIC_SESSION]);
    expect(slug.value.ignored.some((p) => p.endsWith(`${sep}memory`))).toBe(true);
    expect(slug.value.ignored.some((p) => p.endsWith('not-a-session.txt'))).toBe(true);
  });

  it('accepts 19-tool-results-present: the directory is optional, not forbidden', async () => {
    const value = expectAccepted(await fingerprintCase('19-tool-results-present'));
    expect(value.toolResultsDir).toBe(join(value.sessionDir, 'tool-results'));
    expect(value.subagents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mutations — one distinct, asserted reason each
// ---------------------------------------------------------------------------

describe('mutated-layout fixtures are refused, each for its own reason', () => {
  it('01 transcript without its sidecar -> subagentMetaMissing', async () => {
    const mismatch = expectRefusal(
      await fingerprintCase('01-subagent-meta-missing'),
      'subagentMetaMissing',
    );
    expect(mismatch.path).toContain('agent-asynthetic0000001.meta.json');
  });

  it('02 sidecar without its transcript -> subagentTranscriptMissing', async () => {
    const mismatch = expectRefusal(
      await fingerprintCase('02-subagent-transcript-missing'),
      'subagentTranscriptMissing',
    );
    expect(mismatch.path).toContain('agent-asynthetic0000001.jsonl');
  });

  it('03 sidecar without the join key -> metaFieldMissing(toolUseId)', async () => {
    const mismatch = expectRefusal(
      await fingerprintCase('03-meta-missing-tooluseid'),
      'metaFieldMissing',
    );
    expect(mismatch.field).toBe('toolUseId');
    expect(mismatch.actual).toBe('absent');
  });

  it('21 sidecar whose join key is whitespace-only -> metaFieldMissing(toolUseId)', async () => {
    // `"   "` type-checks as a string, so before this rule the layout
    // fingerprint handed the grafter a key that can never join and the refusal
    // happened downstream or nowhere. A blank join key IS a missing join key,
    // so it shares case 03's code and is told apart by `actual`.
    const mismatch = expectRefusal(
      await fingerprintCase('21-meta-tooluseid-whitespace'),
      'metaFieldMissing',
    );
    expect(mismatch.field).toBe('toolUseId');
    expect(mismatch.actual).toBe('blank');
    expect(mismatch.expected).toBe('non-blank string');
    expect(mismatch.reason).toContain('blank');
  });

  it('21 is one edit away from 03: same code, different `actual`', async () => {
    const blank = expectRefusal(
      await fingerprintCase('21-meta-tooluseid-whitespace'),
      'metaFieldMissing',
    );
    const absent = expectRefusal(
      await fingerprintCase('03-meta-missing-tooluseid'),
      'metaFieldMissing',
    );
    expect(blank.actual).not.toBe(absent.actual);
  });

  it('every flavour of blank toolUseId is refused, and a padded real key is not', async () => {
    // Built in the OS temp directory, never inside the repo.
    const cases: [string, boolean][] = [
      ['', false],
      [' ', false],
      ['   ', false],
      ['\t', false],
      ['\n', false],
      ['\r', false],
      [' \t\r\n ', false],
      ['\u00a0', false],
      ['toolu_SYNTHETIC00000000000001', true],
      [' toolu_SYNTHETIC00000000000001 ', true],
    ];
    for (const [key, shouldAccept] of cases) {
      const dir = join(temp, `blank-${Buffer.from(key).toString('hex')}`);
      await buildBlankKeyCase(dir, key);
      const result = await fingerprintSession(join(dir, `${SYNTHETIC_SESSION}.jsonl`));
      if (shouldAccept) {
        // A key with surrounding whitespace is NOT blank; it is a key we have
        // no business trimming. It is accepted here and fails to join
        // downstream, which is the honest outcome.
        expect(result.ok, JSON.stringify(key)).toBe(true);
        continue;
      }
      const mismatch = expectRefusal(result, 'metaFieldMissing');
      expect(mismatch.actual, JSON.stringify(key)).toBe('blank');
    }
  });

  it('a blank agentType or description is NOT a refusal (the join does not read them)', async () => {
    const dir = join(temp, 'blank-label-fields');
    await buildBlankKeyCase(dir, 'toolu_SYNTHETIC00000000000001', {
      agentType: '   ',
      description: '',
    });
    expectAccepted(await fingerprintSession(join(dir, `${SYNTHETIC_SESSION}.jsonl`)));
  });

  it('04 unparseable sidecar -> metaInvalidJson', async () => {
    const mismatch = expectRefusal(await fingerprintCase('04-meta-invalid-json'), 'metaInvalidJson');
    expect(mismatch.path).toContain('.meta.json');
  });

  it('05 subagents/ renamed -> subagentsDirectoryMisnamed', async () => {
    const mismatch = expectRefusal(
      await fingerprintCase('05-subagents-dir-renamed'),
      'subagentsDirectoryMisnamed',
    );
    expect(mismatch.expected).toBe('subagents/');
    expect(mismatch.actual).toBe('agents/');
  });

  it('06 agent filename breaking the id convention -> subagentFileNameConvention', async () => {
    const mismatch = expectRefusal(
      await fingerprintCase('06-agent-filename-convention'),
      'subagentFileNameConvention',
    );
    expect(mismatch.expected).toBe('agent-<agentId>.jsonl');
    expect(mismatch.actual).toBe('asynthetic0000001.jsonl');
  });

  // 07 and 08 were re-versioned in Phase 4: they used to carry 2.1.235, which
  // the acceptance window now accepts, so each was moved to 2.1.400 to keep
  // demonstrating the code its name claims. See the corpus README.

  it('07 whole file on a version outside the window -> unsupportedVersion', async () => {
    const mismatch = expectRefusal(await fingerprintCase('07-version-not-pinned'), 'unsupportedVersion');
    expect(mismatch.expected).toBe(PINNED_CC_VERSION);
    expect(mismatch.observedVersion).toBe('2.1.400');
    // The refusal sentence is unchanged from the single-pin era.
    expect(mismatch.reason).toBe('transcript was written by an unpinned CC version');
    expect(isVersionAccepted('2.1.400')).toBe(false);
  });

  it('08 version changing partway through a file, OUT of the window -> versionChangedMidFile', async () => {
    const mismatch = expectRefusal(
      await fingerprintCase('08-version-changes-midfile'),
      'versionChangedMidFile',
    );
    // Starts at the anchor, so the refusal is about the change, not the origin.
    expect(mismatch.expected).toBe(PINNED_CC_VERSION);
    expect(mismatch.actual).toBe('2.1.400');
    expect(mismatch.observedVersion).toBe('2.1.400');
    // The line number is the interesting part of a mid-file refusal.
    expect(mismatch.path).toMatch(/:3$/);
  });

  it('08 would be ACCEPTED if the change had landed inside the window', async () => {
    // The same shape, one version different: this is the CC-self-update case,
    // and it is the reason 08 had to be re-versioned rather than left alone.
    const drifted = await sessionAtVersion(join(temp, 'like-08'), PINNED_CC_VERSION, '2.1.235');
    const value = expectAccepted(await fingerprintSession(drifted));
    expect(value.versions).toEqual([PINNED_CC_VERSION, '2.1.235']);
  });

  it('09 main transcript path is a directory -> mainTranscriptNotAFile', async () => {
    const mismatch = expectRefusal(
      await fingerprintCase('09-main-transcript-is-a-directory'),
      'mainTranscriptNotAFile',
    );
    expect(mismatch.actual).toBe('directory');
  });

  it('10 sidecar is JSON but not an object -> metaNotAnObject', async () => {
    const mismatch = expectRefusal(await fingerprintCase('10-meta-not-an-object'), 'metaNotAnObject');
    expect(mismatch.actual).toBe('array');
  });

  it('11 entry missing a required field -> entryFieldMissing', async () => {
    const mismatch = expectRefusal(await fingerprintCase('11-entry-missing-uuid'), 'entryFieldMissing');
    expect(mismatch.field).toBe('uuid');
    expect(mismatch.path).toMatch(/agent-asynthetic0000001\.jsonl:3$/);
  });

  it('12 transcript agentId disagreeing with its filename -> agentIdMismatch', async () => {
    const mismatch = expectRefusal(await fingerprintCase('12-agent-id-mismatch'), 'agentIdMismatch');
    expect(mismatch.expected).toBe('asynthetic0000001');
    expect(mismatch.actual).toBe('asynthetic0000002');
  });

  it('13 spawnDepth 2 without parentAgentId -> metaParentAgentIdRule', async () => {
    const mismatch = expectRefusal(
      await fingerprintCase('13-depth2-without-parent-agent-id'),
      'metaParentAgentIdRule',
    );
    expect(mismatch.field).toBe('parentAgentId');
  });

  it('15 slug directory with no session transcript -> noSessionTranscripts', async () => {
    const slug = await fingerprintSlugDirectory(syntheticSlug('15-no-session-transcripts'));
    if (slug.ok) throw new Error('expected refusal');
    expect(slug.mismatch.code).toBe('noSessionTranscripts');
  });

  it('17 sidecar field of the wrong type -> metaFieldType', async () => {
    const mismatch = expectRefusal(
      await fingerprintCase('17-meta-spawndepth-wrong-type'),
      'metaFieldType',
    );
    expect(mismatch.field).toBe('spawnDepth');
    expect(mismatch.expected).toBe('number');
    expect(mismatch.actual).toBe('string');
  });

  it('18 transcript sessionId disagreeing with the session -> sessionIdMismatch', async () => {
    const mismatch = expectRefusal(await fingerprintCase('18-session-id-mismatch'), 'sessionIdMismatch');
    expect(mismatch.expected).toBe(SYNTHETIC_SESSION);
  });

  it('20 subagents present but not a directory -> subagentsPathNotDirectory', async () => {
    const mismatch = expectRefusal(
      await fingerprintCase('20-subagents-is-a-file'),
      'subagentsPathNotDirectory',
    );
    expect(mismatch.expected).toBe('directory');
    expect(mismatch.actual).toBe('file');
  });

  it('every mutation case reports a code no other mutation case reports', async () => {
    const cases: [string, MismatchCode][] = [
      ['01-subagent-meta-missing', 'subagentMetaMissing'],
      ['02-subagent-transcript-missing', 'subagentTranscriptMissing'],
      ['03-meta-missing-tooluseid', 'metaFieldMissing'],
      ['04-meta-invalid-json', 'metaInvalidJson'],
      ['05-subagents-dir-renamed', 'subagentsDirectoryMisnamed'],
      ['06-agent-filename-convention', 'subagentFileNameConvention'],
      ['07-version-not-pinned', 'unsupportedVersion'],
      ['08-version-changes-midfile', 'versionChangedMidFile'],
      ['09-main-transcript-is-a-directory', 'mainTranscriptNotAFile'],
      ['10-meta-not-an-object', 'metaNotAnObject'],
      ['11-entry-missing-uuid', 'entryFieldMissing'],
      ['12-agent-id-mismatch', 'agentIdMismatch'],
      ['13-depth2-without-parent-agent-id', 'metaParentAgentIdRule'],
      ['17-meta-spawndepth-wrong-type', 'metaFieldType'],
      ['18-session-id-mismatch', 'sessionIdMismatch'],
      ['20-subagents-is-a-file', 'subagentsPathNotDirectory'],
      // 21 is deliberately absent: it shares 03's `metaFieldMissing` code
      // because a blank join key IS a missing one. The two are told apart by
      // `actual` ('blank' vs 'absent'), asserted above.
    ];
    const observed: string[] = [];
    for (const [name, code] of cases) {
      const result = await fingerprintCase(name);
      expect(result.ok, `${name} should be refused`).toBe(false);
      if (result.ok) continue;
      expect(result.mismatch.code, name).toBe(code);
      observed.push(result.mismatch.code);
    }
    expect(new Set(observed).size).toBe(cases.length);
  });

  it('covers every synthetic case directory on disk (no fixture is left untested)', async () => {
    const onDisk = (await readdir(SYNTHETIC_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(onDisk).toEqual([
      '00-valid-control',
      '01-subagent-meta-missing',
      '02-subagent-transcript-missing',
      '03-meta-missing-tooluseid',
      '04-meta-invalid-json',
      '05-subagents-dir-renamed',
      '06-agent-filename-convention',
      '07-version-not-pinned',
      '08-version-changes-midfile',
      '09-main-transcript-is-a-directory',
      '10-meta-not-an-object',
      '11-entry-missing-uuid',
      '12-agent-id-mismatch',
      '13-depth2-without-parent-agent-id',
      '14-malformed-lines-tolerated',
      '15-no-session-transcripts',
      '16-zero-byte-main-transcript',
      '17-meta-spawndepth-wrong-type',
      '18-session-id-mismatch',
      '19-tool-results-present',
      '20-subagents-is-a-file',
      '21-meta-tooluseid-whitespace',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tolerance — malformed input is counted, not refused
// ---------------------------------------------------------------------------

describe('tolerance', () => {
  it('counts malformed lines and non-object JSON instead of refusing (G3)', async () => {
    const result = await fingerprintCase('14-malformed-lines-tolerated');
    const value = expectAccepted(result);
    expect(value.version).toBe(PINNED_CC_VERSION);
    expect(result.ok && result.diagnostics.malformedLines).toBe(2);
    expect(result.ok && result.diagnostics.parsedLines).toBe(5);
  });

  it('accepts a zero-byte main transcript and reports no version', async () => {
    const value = expectAccepted(await fingerprintCase('16-zero-byte-main-transcript'));
    expect(value.version).toBeUndefined();
    expect(value.subagents).toEqual([]);
  });

  it('accepts a session with no session directory at all', async () => {
    const slugDir = join(temp, 'slug');
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${SYNTHETIC_SESSION}.jsonl`), '', 'utf8');
    const value = expectAccepted(await fingerprintSession(join(slugDir, `${SYNTHETIC_SESSION}.jsonl`)));
    expect(value.subagents).toEqual([]);
    expect(value.ignored).toEqual([]);
  });

  it('ignores a session directory that is actually a file', async () => {
    const slugDir = join(temp, 'slug');
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${SYNTHETIC_SESSION}.jsonl`), '', 'utf8');
    await writeFile(join(slugDir, SYNTHETIC_SESSION), 'not a directory', 'utf8');
    expectAccepted(await fingerprintSession(join(slugDir, `${SYNTHETIC_SESSION}.jsonl`)));
  });

  it('tolerates an unknown record type carrying none of the model fields', async () => {
    const slugDir = join(temp, 'slug');
    await mkdir(slugDir, { recursive: true });
    const main = join(slugDir, `${SYNTHETIC_SESSION}.jsonl`);
    await writeFile(main, '{"type":"some-future-record-kind"}\n', 'utf8');
    expectAccepted(await fingerprintSession(main));
  });
});

// ---------------------------------------------------------------------------
// Hostile input — results, never exceptions
// ---------------------------------------------------------------------------

describe('hostile input never throws', () => {
  it('returns mainTranscriptMissing for a path that does not exist', async () => {
    const mismatch = expectRefusal(
      await fingerprintSession(join(temp, 'nope', `${SYNTHETIC_SESSION}.jsonl`)),
      'mainTranscriptMissing',
    );
    expect(mismatch.actual).toBe('ENOENT');
  });

  it('returns slugDirUnreadable for a slug directory that does not exist', async () => {
    const slug = await fingerprintSlugDirectory(join(temp, 'nope'));
    if (slug.ok) throw new Error('expected refusal');
    expect(slug.mismatch.code).toBe('slugDirUnreadable');
    expect(slug.mismatch.actual).toBe('ENOENT');
  });

  it('returns slugDirUnreadable when the slug path is a file', async () => {
    const file = join(temp, 'slug-is-a-file');
    await writeFile(file, 'x', 'utf8');
    const slug = await fingerprintSlugDirectory(file);
    if (slug.ok) throw new Error('expected refusal');
    expect(slug.mismatch.code).toBe('slugDirUnreadable');
  });

  it('refuses a sidecar that is a directory instead of a file', async () => {
    const slugDir = join(temp, 'slug');
    const sub = join(slugDir, SYNTHETIC_SESSION, 'subagents');
    await mkdir(join(sub, 'agent-a1.meta.json'), { recursive: true });
    await writeFile(join(slugDir, `${SYNTHETIC_SESSION}.jsonl`), '', 'utf8');
    await writeFile(join(sub, 'agent-a1.jsonl'), '', 'utf8');
    // The sidecar directory is not a file, so it never registers as a sidecar:
    // the transcript is left unpaired, which is the same refusal as case 01.
    expectRefusal(
      await fingerprintSession(join(slugDir, `${SYNTHETIC_SESSION}.jsonl`)),
      'subagentMetaMissing',
    );
  });

  it('refuses an empty sidecar without throwing', async () => {
    const slugDir = join(temp, 'slug');
    const sub = join(slugDir, SYNTHETIC_SESSION, 'subagents');
    await mkdir(sub, { recursive: true });
    await writeFile(join(slugDir, `${SYNTHETIC_SESSION}.jsonl`), '', 'utf8');
    await writeFile(join(sub, 'agent-a1.jsonl'), '', 'utf8');
    await writeFile(join(sub, 'agent-a1.meta.json'), '', 'utf8');
    expectRefusal(await fingerprintSession(join(slugDir, `${SYNTHETIC_SESSION}.jsonl`)), 'metaInvalidJson');
  });

  it('refuses a transcript whose lines are JSON but have no type', async () => {
    const slugDir = join(temp, 'slug');
    await mkdir(slugDir, { recursive: true });
    const main = join(slugDir, `${SYNTHETIC_SESSION}.jsonl`);
    await writeFile(main, '{"uuid":"x"}\n', 'utf8');
    const mismatch = expectRefusal(await fingerprintSession(main), 'entryFieldMissing');
    expect(mismatch.field).toBe('type');
  });

  it('refuses a transcript whose type is not a string', async () => {
    const slugDir = join(temp, 'slug');
    await mkdir(slugDir, { recursive: true });
    const main = join(slugDir, `${SYNTHETIC_SESSION}.jsonl`);
    await writeFile(main, '{"type":42}\n', 'utf8');
    const mismatch = expectRefusal(await fingerprintSession(main), 'entryFieldType');
    expect(mismatch.field).toBe('type');
  });

  it('refuses a required field present with the wrong type', async () => {
    const slugDir = join(temp, 'slug');
    await mkdir(slugDir, { recursive: true });
    const main = join(slugDir, `${SYNTHETIC_SESSION}.jsonl`);
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u',
      parentUuid: null,
      sessionId: SYNTHETIC_SESSION,
      timestamp: 't',
      version: PINNED_CC_VERSION,
      isSidechain: 'yes', // measured as boolean on 33/33 user lines
      message: {},
    });
    await writeFile(main, `${line}\n`, 'utf8');
    const mismatch = expectRefusal(await fingerprintSession(main), 'entryFieldType');
    expect(mismatch.field).toBe('isSidechain');
    expect(mismatch.expected).toBe('boolean');
  });

  it('refuses a sidecar that does not follow agent-<id>.meta.json', async () => {
    const slugDir = join(temp, 'slug');
    const sub = join(slugDir, SYNTHETIC_SESSION, 'subagents');
    await mkdir(sub, { recursive: true });
    await writeFile(join(slugDir, `${SYNTHETIC_SESSION}.jsonl`), '', 'utf8');
    await writeFile(join(sub, 'a1.meta.json'), '{}', 'utf8');
    const mismatch = expectRefusal(
      await fingerprintSession(join(slugDir, `${SYNTHETIC_SESSION}.jsonl`)),
      'subagentFileNameConvention',
    );
    expect(mismatch.expected).toBe('agent-<agentId>.meta.json');
  });

  it('accepts, then refuses, when two files of the same session disagree', async () => {
    const slugDir = join(temp, 'slug');
    const sub = join(slugDir, SYNTHETIC_SESSION, 'subagents');
    await mkdir(sub, { recursive: true });
    const entry = (version: string, agentId?: string) =>
      JSON.stringify({
        type: 'user',
        uuid: 'u',
        parentUuid: null,
        sessionId: SYNTHETIC_SESSION,
        timestamp: 't',
        version,
        isSidechain: agentId !== undefined,
        ...(agentId === undefined ? {} : { agentId }),
        message: {},
      }) + '\n';
    await writeFile(join(slugDir, `${SYNTHETIC_SESSION}.jsonl`), entry(PINNED_CC_VERSION), 'utf8');
    await writeFile(join(sub, 'agent-a1.jsonl'), entry(PINNED_CC_VERSION, 'a1'), 'utf8');
    await writeFile(
      join(sub, 'agent-a1.meta.json'),
      JSON.stringify({ agentType: 'x', description: 'y', toolUseId: 'toolu_x', spawnDepth: 1 }),
      'utf8',
    );
    // Same version on both files: accepted, one version reported.
    const same = expectAccepted(
      await fingerprintSession(join(slugDir, `${SYNTHETIC_SESSION}.jsonl`)),
    );
    expect(same.versions).toEqual([PINNED_CC_VERSION]);

    // The subagent file was written by a later CC — one that is still inside
    // the window. Accepted, and BOTH versions are reported: the session really
    // does span two, and hiding that would be the lie.
    await writeFile(join(sub, 'agent-a1.jsonl'), entry('2.1.235', 'a1'), 'utf8');
    const spanning = expectAccepted(
      await fingerprintSession(join(slugDir, `${SYNTHETIC_SESSION}.jsonl`)),
    );
    expect(spanning.versions).toEqual([PINNED_CC_VERSION, '2.1.235']);
    expect(spanning.version).toBeUndefined();

    // Out of the window, and the refusal comes from the file that carries it —
    // the subagent transcript, by line, not from a whole-session comparison.
    await writeFile(join(sub, 'agent-a1.jsonl'), entry('2.1.178', 'a1'), 'utf8');
    const mismatch = expectRefusal(
      await fingerprintSession(join(slugDir, `${SYNTHETIC_SESSION}.jsonl`)),
      'unsupportedVersion',
    );
    expect(mismatch.observedVersion).toBe('2.1.178');
    expect(mismatch.path).toMatch(/agent-a1\.jsonl:1$/);
  });
});

// ---------------------------------------------------------------------------
// Contract shape
// ---------------------------------------------------------------------------

describe('contract', () => {
  it('anchors the window on the version the fixtures were captured from', () => {
    expect(PINNED_CC_VERSION).toBe('2.1.234');
    expect(VERSION_WINDOW).toEqual({ minor: 1, patch: 5 });
  });

  it('requires the four join keys on every sidecar and nothing else', () => {
    expect(REQUIRED_META_FIELDS.map((f) => f.name)).toEqual([
      'agentType',
      'description',
      'toolUseId',
      'spawnDepth',
    ]);
    // worktree fields are optional: the capture has none of them.
    const optional = ['worktreePath', 'spawnedWithWorktree', 'worktreeBranch', 'parentAgentId'];
    for (const name of optional) {
      expect(REQUIRED_META_FIELDS.some((f) => f.name === name)).toBe(false);
    }
  });

  it('requires per-line-type fields, not one universal set', () => {
    // Measured: `type` is the only field on 100% of all 124 captured lines.
    expect(REQUIRED_ENTRY_FIELDS.get('queue-operation')?.map((f) => f.name)).toEqual([
      'sessionId',
      'timestamp',
    ]);
    expect(REQUIRED_ENTRY_FIELDS.get('file-history-snapshot')).toEqual([]);
    expect(REQUIRED_ENTRY_FIELDS.get('attachment')?.some((f) => f.name === 'message')).toBe(false);
    expect(REQUIRED_ENTRY_FIELDS.get('user')?.some((f) => f.name === 'message')).toBe(true);
    // agentId is never required: it is absent from all 40 main-transcript lines.
    for (const [, specs] of REQUIRED_ENTRY_FIELDS) {
      expect(specs.some((f) => f.name === 'agentId')).toBe(false);
    }
  });

  it('returns a value assignable to ParseResult<SessionFingerprint>', async () => {
    const result = await fingerprintCase('00-valid-control');
    const asParseResult: ParseResult<SessionFingerprint> = result;
    expect(asParseResult.ok).toBe(true);
  });

  it('does not create anything inside the synthetic fixture tree', async () => {
    const before = await snapshot(SYNTHETIC_ROOT);
    for (const entry of await readdir(SYNTHETIC_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      await fingerprintSlugDirectory(syntheticSlug(entry.name));
    }
    expect(await snapshot(SYNTHETIC_ROOT)).toEqual(before);
    // and the temp dir the harness made is still the only writable thing used
    expect((await stat(temp)).isDirectory()).toBe(true);
  });
});
