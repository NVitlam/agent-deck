/**
 * Tests for the line parser.
 *
 * Two fixture sources, and the distinction matters (G6):
 *   - `fixtures/cc-2.1.234/` is CAPTURED data and is schema law. Opened
 *     read-only; one test asserts it is byte-identical after a full parse.
 *   - `fixtures/synthetic-lines/` is HAND-MADE and exists only to drive the
 *     refusal paths, which a well-formed capture cannot exercise.
 *
 * COVERAGE OF THE CAPTURE IS DERIVED, NEVER DECLARED. `readFixtureLayout()`
 * enumerates the fixture tree with plain readdir, so a newly harvested session,
 * subagent, sidecar or offloaded payload is picked up automatically instead of
 * being silently skipped while the suite still reports green. Counts are
 * asserted against oracles computed from the raw bytes in the same run, not
 * against literals. The only literals left are NAMED PRESENCE CHECKS — "this
 * specific known thing is still in the capture" — which are meant to fail if a
 * harvest removes them.
 *
 * The G4 suite ("no thinking content reaches the session model") is at the
 * bottom, in one clearly-labelled describe block. PLAN.md says that test runs
 * in every phase's suite from here on: `expectNoThinkingContent` is exported
 * from this file's pattern deliberately so later phases can reuse it verbatim.
 *
 * Nothing is written outside the OS temp directory. No network, no sleeps.
 */

import { Buffer } from 'node:buffer';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { TranscriptEntry } from '../model/events.js';
import { emptyDiagnostics } from '../model/events.js';
import {
  KNOWN_ENTRY_TYPES,
  collectPersistedOutputStubs,
  hydratePersistedOutputs,
  parseLine,
  parseLines,
  parseSubagentMeta,
} from './parse.js';
import { TRUNCATION_MARKER_RE } from './redact.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = fileURLToPath(new URL('../../fixtures/cc-2.1.234/projects', import.meta.url));
const SYNTHETIC_ROOT = fileURLToPath(new URL('../../fixtures/synthetic-lines', import.meta.url));
/**
 * NAMED PRESENCE CHECKS ONLY. These identify things the capture is expected to
 * still contain; they are never the source of coverage. If a harvest removes
 * one, that is a real change worth failing on. If a harvest ADDS a session, a
 * subagent, a sidecar or a stub, nothing below needs editing — every "for each"
 * is driven by `readFixtureLayout()`.
 */
const NAMED_SESSION = '05c5482d-5568-44ce-97fe-bc9a6c15afc4';
const NAMED_STUB_TRANSCRIPT = 'agent-a3ecf86bbfb853726.jsonl';
const NAMED_STUB_TOOL_USE_ID = 'toolu_01MobmP15USPJ3NEQRXjrgd6';
const NAMED_STUB_BASENAME = 'b6uvpgxa4.txt';
const NAMED_DEPTH2_SIDECAR = 'agent-a3ecf86bbfb853726.meta.json';

interface FixtureSession {
  sessionId: string;
  slug: string;
  slugDir: string;
  mainTranscript: string;
  subagentTranscripts: string[];
  sidecars: string[];
}

/**
 * Independent re-implementation of "what the fixture tree contains", built
 * from plain readdir rather than from any module under test, so the fixture
 * assertions stay a cross-check and not a tautology. Same approach as
 * `readFixtureLayout()` in tailer.test.ts and fingerprint.test.ts.
 *
 * Everything about the committed capture is DERIVED here. The capture is
 * re-harvested between phases — it grew from one session to two while this
 * package was being written — so no test may hard-code its size or its
 * session ids. Sessions come from `<sessionId>.jsonl` FILES, never from
 * directories: a slug directory also holds `memory/` in a live tree.
 */
async function readFixtureLayout(): Promise<FixtureSession[]> {
  const sessions: FixtureSession[] = [];
  for (const slugEntry of await readdir(FIXTURE_ROOT, { withFileTypes: true })) {
    if (!slugEntry.isDirectory()) continue;
    const slugDir = join(FIXTURE_ROOT, slugEntry.name);
    for (const entry of await readdir(slugDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length);

      const subagentTranscripts: string[] = [];
      const sidecars: string[] = [];
      const subagentsDir = join(slugDir, sessionId, 'subagents');
      try {
        for (const sub of await readdir(subagentsDir, { withFileTypes: true })) {
          if (!sub.isFile()) continue;
          if (sub.name.endsWith('.meta.json')) sidecars.push(join(subagentsDir, sub.name));
          else if (sub.name.endsWith('.jsonl')) subagentTranscripts.push(join(subagentsDir, sub.name));
        }
      } catch {
        // no subagents/ directory: this session spawned none
      }

      sessions.push({
        sessionId,
        slug: slugEntry.name,
        slugDir,
        mainTranscript: join(slugDir, entry.name),
        subagentTranscripts: subagentTranscripts.sort(),
        sidecars: sidecars.sort(),
      });
    }
  }
  sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return sessions;
}

/** Every transcript in the capture: main transcripts plus subagent transcripts. */
function allTranscriptsOf(sessions: FixtureSession[]): string[] {
  return sessions.flatMap((s) => [s.mainTranscript, ...s.subagentTranscripts]).sort();
}

/** The session a transcript path belongs to. */
function sessionOwning(sessions: FixtureSession[], transcript: string): FixtureSession {
  const found = sessions.find(
    (s) => s.mainTranscript === transcript || s.subagentTranscripts.includes(transcript),
  );
  if (found === undefined) throw new Error(`no session owns ${transcript}`);
  return found;
}

/**
 * Complete (newline-terminated, non-blank) lines of a file, read independently
 * of `splitAsTailer`. Used as the oracle that line counts are compared against.
 */
function completeLinesOf(raw: string): string[] {
  const parts = raw.split('\n');
  parts.pop(); // text after the final newline is not yet a complete line
  return parts
    .filter((l) => l.trim() !== '')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/**
 * Split a whole file the way the tailer would: only newline-terminated lines
 * are emitted, so the empty string after a trailing newline is not a line.
 */
function splitAsTailer(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

async function loadSynthetic(name: string): Promise<string[]> {
  const text = await readFile(join(SYNTHETIC_ROOT, name), 'utf8');
  // Deliberately NOT splitAsTailer: these files exercise unterminated and
  // blank lines, so every split element is fed to the parser as-is except the
  // artefact of a trailing newline.
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '' && text.endsWith('\n')) parts.pop();
  return parts;
}

// ---------------------------------------------------------------------------
// DoD 1 — typed events for all harvested fixtures
// ---------------------------------------------------------------------------

describe('parseLine against the captured CC 2.1.234 fixtures', () => {
  it('covers every transcript the fixture directory actually holds', async () => {
    const sessions = await readFixtureLayout();
    // Derived, never a literal: a third harvested session must be picked up
    // automatically, not silently skipped.
    expect(sessions.length).toBeGreaterThan(0);
    expect(allTranscriptsOf(sessions).length).toBeGreaterThanOrEqual(sessions.length);
    // The session this package was written against is still present.
    expect(sessions.map((s) => s.sessionId)).toContain(NAMED_SESSION);
    // Every session's main transcript exists and is a file we can read.
    for (const session of sessions) {
      expect(session.mainTranscript.endsWith(`${session.sessionId}.jsonl`)).toBe(true);
      expect((await readFile(session.mainTranscript, 'utf8')).length).toBeGreaterThan(0);
    }
  });

  it('parses every line of every captured transcript with zero malformed', async () => {
    const files = allTranscriptsOf(await readFixtureLayout());
    expect(files.length).toBeGreaterThan(0);
    let parsed = 0;
    let malformed = 0;
    let oracleLines = 0;
    for (const file of files) {
      const raw = await readFile(file, 'utf8');
      // Independent count of complete, non-blank lines in the raw bytes.
      oracleLines += completeLinesOf(raw).length;
      const result = parseLines(splitAsTailer(raw));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rejections, `rejections in ${file}`).toEqual([]);
      parsed += result.diagnostics.parsedLines;
      malformed += result.diagnostics.malformedLines;
    }
    expect(malformed).toBe(0);
    // Exact equality against a DERIVED total, so the assertion stays true as
    // the capture grows but still fails if the parser drops a line.
    expect(parsed).toBe(oracleLines);
    expect(parsed).toBeGreaterThan(0);
  });

  it('emits exactly the type census an independent read of the raw bytes finds', async () => {
    const files = allTranscriptsOf(await readFixtureLayout());
    const oracle = new Map<string, number>();
    const emitted = new Map<string, number>();

    for (const file of files) {
      const raw = await readFile(file, 'utf8');
      // Oracle: JSON.parse the raw bytes directly, not via the module under test.
      for (const line of completeLinesOf(raw)) {
        const type = (JSON.parse(line) as { type?: unknown }).type;
        if (typeof type === 'string') oracle.set(type, (oracle.get(type) ?? 0) + 1);
      }
      const result = parseLines(splitAsTailer(raw));
      if (!result.ok) return;
      for (const entry of result.value.entries) {
        emitted.set(entry.type, (emitted.get(entry.type) ?? 0) + 1);
      }
    }

    const census = (m: Map<string, number>): Record<string, number> =>
      Object.fromEntries([...m].sort((a, b) => a[0].localeCompare(b[0])));
    // Strong enough to catch a parser that silently drops a type OR miscounts
    // one, without pinning literals the next harvest would break.
    expect(census(emitted)).toEqual(census(oracle));
    expect(oracle.size).toBeGreaterThan(0);
    for (const type of emitted.keys()) expect(KNOWN_ENTRY_TYPES.has(type)).toBe(true);
    // Floor: the capture must still exercise the two types that carry content,
    // otherwise "zero malformed" would be vacuously true.
    expect(emitted.get('assistant') ?? 0).toBeGreaterThan(0);
    expect(emitted.get('user') ?? 0).toBeGreaterThan(0);
  });

  it('preserves the join keys the stitcher needs, on every subagent transcript', async () => {
    const sessions = await readFixtureLayout();
    let checked = 0;
    for (const session of sessions) {
      for (const file of session.subagentTranscripts) {
        const agentId = basename(file).replace(/^agent-/, '').replace(/\.jsonl$/, '');
        const result = parseLines(splitAsTailer(await readFile(file, 'utf8')));
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        const entries = result.value.entries;
        expect(entries.length).toBeGreaterThan(0);
        // agentId is the join key and is derived from the file name.
        const ids = [...new Set(entries.map((e) => e['agentId']).filter((v) => typeof v === 'string'))];
        expect(ids).toEqual([agentId]);
        expect(entries.filter((e) => typeof e.uuid === 'string').length).toBeGreaterThan(0);
        // `parentUuid: null` on the opening entry must survive as null, not vanish.
        expect(entries[0]?.parentUuid).toBeNull();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('keeps the sparse queue-operation shape without inventing fields', async () => {
    const files = allTranscriptsOf(await readFixtureLayout());
    let seen = 0;
    for (const file of files) {
      const result = parseLines(splitAsTailer(await readFile(file, 'utf8')));
      if (!result.ok) continue;
      for (const queue of result.value.entries.filter((e) => e.type === 'queue-operation')) {
        expect(Object.keys(queue).sort()).toEqual([
          'operation',
          'sessionId',
          'timestamp',
          'type',
        ]);
        expect(queue.uuid).toBeUndefined();
        expect(queue.message).toBeUndefined();
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('leaves the captured tree byte-identical after a full parse (G1)', async () => {
    const files = allTranscriptsOf(await readFixtureLayout());
    expect(files.length).toBeGreaterThan(0);
    const before = await Promise.all(files.map((f) => readFile(f)));
    for (const file of files) parseLines(splitAsTailer(await readFile(file, 'utf8')));
    const after = await Promise.all(files.map((f) => readFile(f)));
    for (let i = 0; i < files.length; i++) {
      expect(after[i]?.equals(before[i] as Buffer)).toBe(true);
    }
  });
});

describe('unknown fields are ignored without error (DoD 1)', () => {
  it('parses a line carrying fields CC 2.1.234 never wrote, and keeps them', async () => {
    const lines = await loadSynthetic('unknown-fields-ok.jsonl');
    expect(lines).toHaveLength(2);
    const result = parseLines(lines);
    expect(result.diagnostics.parsedLines).toBe(2);
    expect(result.diagnostics.malformedLines).toBe(0);
    if (!result.ok) return;
    const first = result.value.entries[0];
    expect(first?.type).toBe('assistant');
    expect(first?.['anotherUnknownKey']).toBe(123);
    expect(first?.['futureField']).toEqual({ nested: ['cc', 'added', 'this'] });
    expect(first?.version).toBe('2.1.999');
    const second = result.value.entries[1];
    expect(second?.['brandNewField']).toBe('ignored without error');
  });

  it('does not require any optional field to be present', () => {
    const outcome = parseLine('{"type":"user"}');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.keys(outcome.entry)).toEqual(['type']);
  });
});

// ---------------------------------------------------------------------------
// DoD 2 — malformed lines counted and skipped, never crash
// ---------------------------------------------------------------------------

describe('malformed input is counted and skipped, never thrown (G3, DoD 2)', () => {
  it('invalid JSON: 2 lines in, 2 counted', async () => {
    const lines = await loadSynthetic('invalid-json.jsonl');
    expect(lines).toHaveLength(2);
    const result = parseLines(lines);
    expect(result.diagnostics.malformedLines).toBe(2);
    expect(result.diagnostics.parsedLines).toBe(0);
    if (!result.ok) return;
    expect(result.value.rejections.map((r) => r.rejection)).toEqual(['invalidJson', 'invalidJson']);
  });

  it('a line truncated mid-JSON with no trailing newline: 1 counted', async () => {
    const lines = await loadSynthetic('truncated-mid-json.jsonl');
    expect(lines).toHaveLength(1);
    const result = parseLines(lines);
    expect(result.diagnostics.malformedLines).toBe(1);
    if (!result.ok) return;
    expect(result.value.rejections[0]?.rejection).toBe('invalidJson');
  });

  it('valid JSON of the wrong shape: 5 lines in, 5 counted', async () => {
    const lines = await loadSynthetic('wrong-shape.jsonl');
    expect(lines).toHaveLength(5);
    const result = parseLines(lines);
    expect(result.diagnostics.malformedLines).toBe(5);
    if (!result.ok) return;
    expect(result.value.rejections.map((r) => r.rejection)).toEqual([
      'notAnObject',
      'notAnObject',
      'notAnObject',
      'notAnObject',
      'missingType',
    ]);
  });

  it('empty and whitespace-only lines: 3 counted', async () => {
    const lines = await loadSynthetic('blank-lines.jsonl');
    expect(lines).toHaveLength(3);
    const result = parseLines(lines);
    expect(result.diagnostics.malformedLines).toBe(3);
    if (!result.ok) return;
    expect(result.value.rejections.every((r) => r.rejection === 'empty')).toBe(true);
  });

  it('unexpected type: 2 counted', async () => {
    const lines = await loadSynthetic('unknown-type.jsonl');
    expect(lines).toHaveLength(2);
    const result = parseLines(lines);
    expect(result.diagnostics.malformedLines).toBe(2);
    if (!result.ok) return;
    expect(result.value.rejections.map((r) => r.rejection)).toEqual(['unknownType', 'missingType']);
    expect(result.value.rejections[0]?.reason).toBe('unknown type: sidechain-marker');
  });

  it('an unpaired surrogate: 1 counted', async () => {
    const lines = await loadSynthetic('lone-surrogate.jsonl');
    expect(lines).toHaveLength(1);
    const result = parseLines(lines);
    expect(result.diagnostics.malformedLines).toBe(1);
    if (!result.ok) return;
    expect(result.value.rejections[0]?.rejection).toBe('loneSurrogate');
  });

  it('the counter is exact: N bad lines in, N counted, mixed with good ones', async () => {
    const bad: string[] = [];
    for (const name of [
      'invalid-json.jsonl',
      'truncated-mid-json.jsonl',
      'wrong-shape.jsonl',
      'blank-lines.jsonl',
      'unknown-type.jsonl',
      'lone-surrogate.jsonl',
    ]) {
      bad.push(...(await loadSynthetic(name)));
    }
    expect(bad).toHaveLength(14);
    const good = await loadSynthetic('unknown-fields-ok.jsonl');
    expect(good).toHaveLength(2);

    // Interleave so a failure cannot resynchronise by position.
    const mixed: string[] = [];
    for (let i = 0; i < Math.max(bad.length, good.length); i++) {
      const b = bad[i];
      const g = good[i % good.length];
      if (b !== undefined) mixed.push(b);
      if (g !== undefined) mixed.push(g);
    }
    const result = parseLines(mixed);
    expect(result.diagnostics.malformedLines).toBe(14);
    expect(result.diagnostics.parsedLines).toBe(mixed.length - 14);
    expect(result.diagnostics.malformedLines + result.diagnostics.parsedLines).toBe(mixed.length);
    if (!result.ok) return;
    expect(result.value.rejections).toHaveLength(14);
  });

  it('never throws on hostile input', () => {
    const hostile = [
      '',
      '   ',
      '\t',
      'null',
      'true',
      '0',
      '"string"',
      '[]',
      '{}',
      '{"type":null}',
      '{"type":123}',
      '{"type":"user"',
      '{"type":"user","message":',
      ' ',
      '{"type":"user","x":"\\ud800"}',
      '{"type":"user","x":"\\udfff"}',
      `{"type":"user","x":${JSON.stringify('a'.repeat(2_000_000))}}`,
      `{"type":"user","deep":${'['.repeat(2000)}1${']'.repeat(2000)}}`,
      `{"type":"user","deepObj":${'{"n":'.repeat(500)}1${'}'.repeat(500)}}`,
    ];
    for (const line of hostile) {
      expect(() => parseLine(line)).not.toThrow();
    }
    const result = parseLines(hostile);
    expect(result.diagnostics.malformedLines + result.diagnostics.parsedLines).toBe(hostile.length);
  });

  it('truncates an enormous value rather than holding it', () => {
    const outcome = parseLine(`{"type":"user","x":${JSON.stringify('a'.repeat(2_000_000))}}`);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const x = outcome.entry['x'];
    expect(typeof x).toBe('string');
    expect(Buffer.byteLength(String(x), 'utf8')).toBeLessThan(9000);
    expect(TRUNCATION_MARKER_RE.test(String(x))).toBe(true);
    expect(outcome.report.truncatedStrings).toBe(1);
  });

  it('replaces an over-deep subtree instead of blowing the stack', () => {
    const line = `{"type":"user","deepObj":${'{"n":'.repeat(500)}1${'}'.repeat(500)}}`;
    const outcome = parseLine(line);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.depthLimited).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Sidecars
// ---------------------------------------------------------------------------

describe('parseSubagentMeta', () => {
  it('parses every sidecar the capture holds, and every one names its transcript', async () => {
    const sessions = await readFixtureLayout();
    const sidecars = sessions.flatMap((s) => s.sidecars);
    expect(sidecars.length).toBeGreaterThan(0);
    let deepest = 0;
    for (const file of sidecars) {
      const result = parseSubagentMeta(await readFile(file, 'utf8'), file);
      expect(result.ok, `sidecar ${file} did not parse`).toBe(true);
      if (!result.ok) continue;
      expect(typeof result.value.agentType).toBe('string');
      expect(result.value.toolUseId).toMatch(/^toolu_/);
      expect(result.value.spawnDepth).toBeGreaterThanOrEqual(1);
      expect(result.diagnostics.skippedFiles).toEqual([]);
      // A sidecar at depth >= 2 must carry the parent it was spawned from.
      if (result.value.spawnDepth >= 2) expect(typeof result.value.parentAgentId).toBe('string');
      deepest = Math.max(deepest, result.value.spawnDepth);
    }
    // Coverage floor: the capture is supposed to contain nested spawning.
    expect(deepest).toBeGreaterThanOrEqual(2);
  });

  it('every sidecar has a sibling transcript, and every transcript a sidecar', async () => {
    const sessions = await readFixtureLayout();
    let pairs = 0;
    for (const session of sessions) {
      expect(session.sidecars.map((f) => f.replace(/\.meta\.json$/, '.jsonl')).sort()).toEqual(
        session.subagentTranscripts,
      );
      pairs += session.sidecars.length;
    }
    expect(pairs).toBeGreaterThan(0);
  });

  it('reads the named depth-2 sidecar including parentAgentId', async () => {
    const sessions = await readFixtureLayout();
    const file = sessions
      .flatMap((s) => s.sidecars)
      .find((f) => basename(f) === NAMED_DEPTH2_SIDECAR);
    expect(file, `${NAMED_DEPTH2_SIDECAR} is no longer in the capture`).toBeDefined();
    if (file === undefined) return;
    const result = parseSubagentMeta(await readFile(file, 'utf8'), file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      agentType: 'general-purpose',
      description: 'nested-child',
      toolUseId: 'toolu_012xCBtQH1ejFcfwn9E1pkAw',
      parentAgentId: 'a1a53f42c5eca8824',
      spawnDepth: 2,
    });
  });

  it('refuses a corrupt sidecar with a described, counted failure — never a throw', () => {
    const cases: [string, string][] = [
      ['', 'empty'],
      ['   ', 'empty'],
      ['{"agentType":"x",', 'not valid JSON'],
      ['[1,2,3]', 'not a JSON object'],
      ['"a string"', 'not a JSON object'],
      ['{"description":"d","toolUseId":"t","spawnDepth":1}', 'agentType'],
      ['{"agentType":"a","toolUseId":"t","spawnDepth":1}', 'description'],
      ['{"agentType":"a","description":"d","spawnDepth":1}', 'toolUseId'],
      ['{"agentType":"a","description":"d","toolUseId":"t"}', 'spawnDepth'],
      ['{"agentType":"a","description":"d","toolUseId":"","spawnDepth":1}', 'toolUseId'],
      ['{"agentType":"a","description":"d","toolUseId":"t","spawnDepth":"1"}', 'spawnDepth'],
    ];
    for (const [text, needle] of cases) {
      expect(() => parseSubagentMeta(text, 'meta.json')).not.toThrow();
      const result = parseSubagentMeta(text, 'meta.json');
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.mismatch.kind).toBe('schemaMismatch');
      expect(result.mismatch.reason).toContain(needle);
      expect(result.mismatch.path).toBe('meta.json');
      expect(result.diagnostics.skippedFiles).toHaveLength(1);
    }
  });

  it('keeps unknown sidecar fields', () => {
    const result = parseSubagentMeta(
      '{"agentType":"a","description":"d","toolUseId":"t","spawnDepth":1,"futureField":true}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value['futureField']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DoD 5 — offloaded tool results, resolved by basename
// ---------------------------------------------------------------------------

describe('offloaded tool-results (DoD 5)', () => {
  interface FoundStub {
    session: FixtureSession;
    transcript: string;
    entry: TranscriptEntry;
    toolUseId: string;
    basename: string;
  }

  /** Every `<persisted-output>` stub in the capture, found by walking the layout. */
  async function findStubs(): Promise<FoundStub[]> {
    const sessions = await readFixtureLayout();
    const found: FoundStub[] = [];
    for (const transcript of allTranscriptsOf(sessions)) {
      const result = parseLines(splitAsTailer(await readFile(transcript, 'utf8')));
      if (!result.ok) continue;
      for (const entry of result.value.entries) {
        for (const stub of collectPersistedOutputStubs(entry)) {
          found.push({
            session: sessionOwning(sessions, transcript),
            transcript,
            entry,
            toolUseId: stub.toolUseId,
            basename: stub.pointer.basename,
          });
        }
      }
    }
    return found;
  }

  it('finds the same number of stubs as an independent scan of the raw bytes', async () => {
    const sessions = await readFixtureLayout();
    let oracle = 0;
    for (const transcript of allTranscriptsOf(sessions)) {
      for (const line of completeLinesOf(await readFile(transcript, 'utf8'))) {
        const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          const b = block as { type?: unknown; content?: unknown };
          if (b.type !== 'tool_result') continue;
          if (typeof b.content === 'string' && b.content.startsWith('<persisted-output>')) oracle++;
        }
      }
    }
    const stubs = await findStubs();
    expect(stubs).toHaveLength(oracle);
    // Coverage floor: if a harvest drops the offloaded payload, say so loudly
    // rather than passing an empty loop.
    expect(oracle).toBeGreaterThan(0);
  });

  it('still contains the named stub, with its join key and basename', async () => {
    const stubs = await findStubs();
    const named = stubs.find((s) => s.basename === NAMED_STUB_BASENAME);
    expect(named, `${NAMED_STUB_BASENAME} is no longer referenced by the capture`).toBeDefined();
    expect(named?.toolUseId).toBe(NAMED_STUB_TOOL_USE_ID);
    expect(basename(named?.transcript ?? '')).toBe(NAMED_STUB_TRANSCRIPT);
    expect(named?.session.sessionId).toBe(NAMED_SESSION);
  });

  it('hydrates every stub from the ACTIVE root, redacted and truncated', async () => {
    const stubs = await findStubs();
    expect(stubs.length).toBeGreaterThan(0);
    for (const stub of stubs) {
      const hydrated = await hydratePersistedOutputs(stub.entry, {
        projectsRoot: FIXTURE_ROOT,
        slug: stub.session.slug,
        sessionId: stub.session.sessionId,
      });
      expect(hydrated.length).toBeGreaterThan(0);
      const read = hydrated.find((h) => h.pointer.basename === stub.basename)?.read;
      expect(read?.ok, `${stub.basename} did not resolve`).toBe(true);
      if (read === undefined) continue;

      const expectedPath = join(
        FIXTURE_ROOT,
        stub.session.slug,
        stub.session.sessionId,
        'tool-results',
        stub.basename,
      );
      expect(read.path).toBe(expectedPath);
      // Size is read off the file itself, not asserted as a literal.
      const onDisk = await readFile(expectedPath, 'utf8');
      const diskBytes = Buffer.byteLength(onDisk, 'utf8');
      expect(read.originalBytes).toBe(diskBytes);
      expect(read.truncated).toBe(diskBytes > 8192);

      const payload = read.text.replace(TRUNCATION_MARKER_RE, '');
      expect(Buffer.byteLength(payload, 'utf8')).toBe(Math.min(diskBytes, 8192));
      // The kept prefix is exactly the file's own first bytes...
      expect(payload).toBe(
        Buffer.from(onDisk, 'utf8').subarray(0, Buffer.byteLength(payload, 'utf8')).toString('utf8'),
      );
      // ...and nothing past the cut came through.
      if (read.truncated) expect(read.text).not.toContain(onDisk.slice(-500));
    }
  });

  it('a missing offloaded file is a counted diagnostic and a degraded preview', async () => {
    const stubs = await findStubs();
    expect(stubs.length).toBeGreaterThan(0);
    for (const stub of stubs) {
      const diagnostics = emptyDiagnostics();
      const hydrated = await hydratePersistedOutputs(
        stub.entry,
        { projectsRoot: FIXTURE_ROOT, slug: stub.session.slug, sessionId: 'no-such-session' },
        diagnostics,
      );
      const read = hydrated.find((h) => h.pointer.basename === stub.basename)?.read;
      expect(read?.ok).toBe(false);
      expect(read?.degraded).toBe(true);
      // Degraded text is the stub's own inline preview, which is non-empty.
      expect((read?.text ?? '').length).toBeGreaterThan(0);
      expect(diagnostics.skippedFiles.length).toBeGreaterThan(0);
      expect(diagnostics.skippedFiles.map((f) => f.reason).join('\n')).toContain(stub.basename);
    }
  });

  it('returns nothing for entries with no offloaded payload', async () => {
    const sessions = await readFixtureLayout();
    const first = sessions[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const outcome = parseLine('{"type":"user","message":{"role":"user","content":"plain string"}}');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(collectPersistedOutputStubs(outcome.entry)).toEqual([]);
    expect(
      await hydratePersistedOutputs(outcome.entry, {
        projectsRoot: FIXTURE_ROOT,
        slug: first.slug,
        sessionId: first.sessionId,
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DoD 3 / G4 — NO THINKING CONTENT REACHES THE SESSION MODEL
//
// PLAN.md requires this block in every phase's suite from Phase 1 on. It is
// self-contained on purpose: copy the describe block, not fragments of it.
// ---------------------------------------------------------------------------

/**
 * Every reasoning-bearing string present in the RAW bytes of a captured
 * transcript. In CC 2.1.234 every thinking block carries an EMPTY `thinking`
 * string and a long populated `signature`, so the signatures are the bytes
 * that actually have to disappear. Counts are derived per run, never pinned.
 */
function thinkingStringsInRawBytes(rawFile: string): string[] {
  const found: string[] = [];
  for (const line of rawFile.split('\n')) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (entry as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: unknown; thinking?: unknown; signature?: unknown };
      if (b.type !== 'thinking') continue;
      if (typeof b.thinking === 'string' && b.thinking.length > 0) found.push(b.thinking);
      if (typeof b.signature === 'string' && b.signature.length > 0) found.push(b.signature);
    }
  }
  return found;
}

/**
 * How many thinking blocks the RAW bytes contain, counted by walking the JSON
 * rather than by regex, so the oracle cannot be fooled by the substring
 * appearing inside a payload.
 */
function thinkingBlocksInRawBytes(rawFile: string): number {
  let count = 0;
  for (const line of completeLinesOf(rawFile)) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (entry as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if ((block as { type?: unknown }).type === 'thinking') count++;
    }
  }
  return count;
}

/** Reusable assertion. Later phases: call this on whatever you hand downstream. */
function expectNoThinkingContent(serialised: string, forbidden: readonly string[]): void {
  expect(serialised).not.toContain('"thinking"');
  expect(serialised).not.toContain('"signature"');
  for (const secret of forbidden) {
    expect(serialised).not.toContain(secret);
    // A prefix check catches a partial leak through truncation.
    expect(serialised).not.toContain(secret.slice(0, 64));
  }
}

describe('G4: no thinking content reaches the session model', () => {
  it('the raw capture really does contain thinking blocks (otherwise this suite proves nothing)', async () => {
    const files = allTranscriptsOf(await readFixtureLayout());
    expect(files.length).toBeGreaterThan(0);
    let blocks = 0;
    let secrets = 0;
    for (const file of files) {
      const raw = await readFile(file, 'utf8');
      blocks += thinkingBlocksInRawBytes(raw);
      secrets += thinkingStringsInRawBytes(raw).length;
    }
    // Derived, not pinned: any capture that stops containing reasoning would
    // make the rest of this suite vacuous, so fail loudly instead.
    expect(blocks).toBeGreaterThan(0);
    expect(secrets).toBeGreaterThan(0);
  });

  it('drops every thinking block from every captured transcript', async () => {
    const files = allTranscriptsOf(await readFixtureLayout());
    let dropped = 0;
    let inRawBytes = 0;
    for (const file of files) {
      const raw = await readFile(file, 'utf8');
      inRawBytes += thinkingBlocksInRawBytes(raw);
      const result = parseLines(splitAsTailer(raw));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      dropped += result.value.report.thinkingBlocksDropped;
    }
    // Exact equality against a count derived from the raw bytes.
    expect(dropped).toBe(inRawBytes);
    expect(dropped).toBeGreaterThan(0);
  });

  it('no thinking text or signature from the raw bytes survives into any parsed entry', async () => {
    const files = allTranscriptsOf(await readFixtureLayout());
    let asserted = 0;
    for (const file of files) {
      const raw = await readFile(file, 'utf8');
      const forbidden = thinkingStringsInRawBytes(raw);
      const result = parseLines(splitAsTailer(raw));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expectNoThinkingContent(JSON.stringify(result.value.entries), forbidden);
      asserted += forbidden.length;
    }
    // The loop must actually have had secrets to look for.
    expect(asserted).toBeGreaterThan(0);
  });

  it('no thinking content survives a per-line parse either', async () => {
    const files = allTranscriptsOf(await readFixtureLayout());
    let asserted = 0;
    for (const file of files) {
      const raw = await readFile(file, 'utf8');
      const forbidden = thinkingStringsInRawBytes(raw);
      for (const line of splitAsTailer(raw)) {
        const outcome = parseLine(line);
        if (!outcome.ok) continue;
        expectNoThinkingContent(JSON.stringify(outcome.entry), forbidden);
      }
      asserted += forbidden.length;
    }
    expect(asserted).toBeGreaterThan(0);
  });

  it('the synthetic thinking fixture loses both marker strings but keeps the answer', async () => {
    const lines = await loadSynthetic('thinking-block.jsonl');
    expect(lines).toHaveLength(1);
    const result = parseLines(lines);
    expect(result.diagnostics.parsedLines).toBe(1);
    if (!result.ok) return;
    expect(result.value.report.thinkingBlocksDropped).toBe(1);
    const json = JSON.stringify(result.value.entries);
    expectNoThinkingContent(json, [
      'SYNTHETIC-THINKING-TEXT-MUST-NOT-SURVIVE',
      'SYNTHETIC-SIGNATURE-MUST-NOT-SURVIVE',
    ]);
    expect(json).toContain('visible answer');
  });

  it('cannot be switched off: there is no option that lets a thinking block through', () => {
    const line =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"LEAK","signature":"LEAK-SIG"}]}}';
    for (const options of [
      {},
      { maxPayloadBytes: 1 },
      { maxPayloadBytes: 1024 * 1024 * 64 },
      { allowUnknownTypes: true },
    ]) {
      const outcome = parseLine(line, options);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expectNoThinkingContent(JSON.stringify(outcome.entry), ['LEAK', 'LEAK-SIG']);
    }
  });

  it('drops a thinking block even when nested outside message.content', () => {
    const outcome = parseLine(
      '{"type":"attachment","attachment":{"blocks":[{"type":"thinking","thinking":"LEAK","signature":"LEAK-SIG"}]}}',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expectNoThinkingContent(JSON.stringify(outcome.entry), ['LEAK', 'LEAK-SIG']);
  });
});
