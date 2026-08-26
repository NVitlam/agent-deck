/**
 * Corpus-level tests for the 2026-08-26 version posture.
 *
 * The posture in one sentence: the version string refuses only a different
 * major line or a minor more than one step away, and the STRUCTURE is what
 * refuses everything else. That sentence has two halves and this file proves
 * both, on captured bytes rather than on constants:
 *
 *   fixtures/cc-2.1.234/   the layout and join capture
 *   fixtures/cc-2.1.237/   a content-destroyed drift witness
 *   fixtures/cc-2.1.241/   a session on a LOCAL local-model model, flat, with
 *                          `atis` / `atis-latch` and a stray file in the
 *                          session directory
 *   fixtures/cc-2.1.246/   the provenance anchor: an R1 mirror pair
 *   fixtures/synthetic-structure-2.1.246/
 *                          hand-mutated: the anchor's own head slice with one
 *                          required key renamed. Nothing here is evidence
 *                          about CC (G6).
 *
 * Nothing is written inside the repo. The one test that needs a second copy of
 * a fixture builds it under the OS temp directory.
 */

import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { graftSession } from '../model/graft.js';
import {
  PINNED_CC_VERSION,
  REQUIRED_ENTRY_FIELDS,
  fingerprintSession,
  fingerprintSlugDirectory,
  isVersionAccepted,
} from './fingerprint.js';
import { KNOWN_ENTRY_TYPES, parseLines } from './parse.js';

const SLUG = 'c--Users-dev-projects-agent-deck';

const fixture = (...parts: string[]): string =>
  fileURLToPath(new URL(['..', '..', 'fixtures', ...parts].join('/'), import.meta.url));

const CORPORA = [
  { version: '2.1.234', slugDir: fixture('cc-2.1.234', 'projects', SLUG), sessions: 2 },
  { version: '2.1.237', slugDir: fixture('cc-2.1.237', 'projects', SLUG), sessions: 1 },
  { version: '2.1.241', slugDir: fixture('cc-2.1.241', 'projects', SLUG), sessions: 1 },
  { version: '2.1.246', slugDir: fixture('cc-2.1.246', 'projects', SLUG), sessions: 1 },
] as const;

const SESSION_246 = '07e6c820-b285-4ea8-8127-98ea762291d9';
const SESSION_241 = '6082be25-cfea-49b9-9821-2de9c23cac65';

const MAIN_246 = fixture('cc-2.1.246', 'projects', SLUG, `${SESSION_246}.jsonl`);
const MAIN_241 = fixture('cc-2.1.241', 'projects', SLUG, `${SESSION_241}.jsonl`);
const HEAD_5 = fixture('cc-2.1.246', 'head-5.jsonl');
const MUTANT = fixture(
  'synthetic-structure-2.1.246',
  'SYNTHETIC-hand-mutated-not-captured',
  `${SESSION_246}.jsonl`,
);

/** Every non-blank line of a JSONL file, parsed. Throws on malformed input. */
async function entriesOf(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

let temp: string;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'agent-deck-corpus-'));
});

afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// DoD 1.3 - every captured corpus reads through the production path
// ---------------------------------------------------------------------------

describe('every captured corpus parses through the production path', () => {
  it.each(CORPORA)('$version accepts every session it holds', async (corpus) => {
    const slug = await fingerprintSlugDirectory(corpus.slugDir);
    if (!slug.ok) throw new Error(`slug refused: ${slug.mismatch.reason}`);
    expect(slug.value.sessions).toHaveLength(corpus.sessions);
    for (const session of slug.value.sessions) {
      if (!session.result.ok) {
        throw new Error(
          `${corpus.version} ${basename(session.mainTranscript)} refused: ` +
            `${session.result.mismatch.code} - ${session.result.mismatch.reason}`,
        );
      }
      expect(session.result.value.versions, corpus.version).toEqual([corpus.version]);
      expect(session.result.diagnostics.malformedLines, corpus.version).toBe(0);
      expect(session.result.diagnostics.parsedLines, corpus.version).toBeGreaterThan(0);
    }
  });

  it('spans four CC releases, each of which the previous posture refused at some point', () => {
    // Vacuity control on the list above: a corpus set that all sat inside the
    // OLD patch box would prove nothing about the change. 2.1.241 and 2.1.246
    // were both hard refusals until this phase.
    for (const corpus of CORPORA) expect(isVersionAccepted(corpus.version)).toBe(true);
    expect(new Set(CORPORA.map((c) => c.version)).size).toBe(CORPORA.length);
  });
});

// ---------------------------------------------------------------------------
// The anchor
// ---------------------------------------------------------------------------

describe('the provenance anchor is the corpus, not a number in a file', () => {
  it('PINNED_CC_VERSION names a corpus that exists and carries that version', async () => {
    // The anchor's whole meaning is "the release whose fixture proved the
    // structure". Moving the constant without harvesting fails right here,
    // which is the point of writing the rule as a test rather than as prose.
    const named = CORPORA.find((c) => c.version === PINNED_CC_VERSION);
    expect(named, `no fixtures/cc-${PINNED_CC_VERSION}/ corpus for the anchor`).toBeDefined();
    const slug = await fingerprintSlugDirectory(named?.slugDir ?? '');
    if (!slug.ok) throw new Error(slug.mismatch.reason);
    for (const session of slug.value.sessions) {
      expect(session.result.ok && session.result.value.versions).toEqual([PINNED_CC_VERSION]);
    }
  });

  it('reads the R1 mirror pair: one subagent, its sidecar, the primary-key join', async () => {
    const result = await fingerprintSession(MAIN_246);
    if (!result.ok) throw new Error(`${result.mismatch.code}: ${result.mismatch.reason}`);
    const value = result.value;
    expect(value.sessionId).toBe(SESSION_246);
    expect(value.version).toBe('2.1.246');
    expect(value.subagents).toHaveLength(1);
    const [agent] = value.subagents;
    expect(agent?.agentId).toBe('a676c705dca135e9d');
    expect(agent?.meta.agentType).toBe('general-purpose');
    expect(agent?.meta.description).toBe('r1-mirror-b');
    expect(agent?.meta.spawnDepth).toBe(1);
    expect(agent?.meta.toolUseId).toBe('toolu_01UDHVquGaAwLm2mAk3nvoQi');
    // spawnDepth 1 carries no parent id; that is the rule, not an omission.
    expect(agent?.meta.parentAgentId).toBeUndefined();
    // The sidecar's toolUseId is a real block in the main transcript, so the
    // attribution here is a join rather than an inference.
    const main = await entriesOf(MAIN_246);
    const toolUseIds = main.flatMap((entry) => {
      const message = entry['message'];
      if (typeof message !== 'object' || message === null) return [];
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) return [];
      return content
        .filter((b): b is { type: string; id: string; name: string } =>
          typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_use',
        )
        .map((b) => b.id);
    });
    expect(toolUseIds).toContain(agent?.meta.toolUseId);
    // No offload directory in this capture; cc-2.1.234 still owns that path.
    expect(value.toolResultsDir).toBeUndefined();
  });

  it('carries agent B six scripted tool calls, in order - the mirror-pair check', async () => {
    const subagent = fixture(
      'cc-2.1.246',
      'projects',
      SLUG,
      SESSION_246,
      'subagents',
      'agent-a676c705dca135e9d.jsonl',
    );
    const names = (await entriesOf(subagent)).flatMap((entry) => {
      const message = entry['message'];
      if (typeof message !== 'object' || message === null) return [];
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) return [];
      return content
        .filter((b): b is { type: string; name: string } =>
          typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_use',
        )
        .map((b) => b.name);
    });
    expect(names).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Read']);
  });

  it('head-5.jsonl carries the version on a line the scanner reaches', async () => {
    // The slice exists so the version-string path can be asserted on five
    // lines. It is only useful if a `version` is actually in it.
    const head = await entriesOf(HEAD_5);
    expect(head).toHaveLength(5);
    const versioned = head.filter((entry) => typeof entry['version'] === 'string');
    expect(versioned.length).toBeGreaterThan(0);
    for (const entry of versioned) expect(entry['version']).toBe(PINNED_CC_VERSION);
  });
});

// ---------------------------------------------------------------------------
// DoD 1.4 - the tripwire
// ---------------------------------------------------------------------------

describe('an in-range session still refuses on a renamed required key', () => {
  it('refuses the mutated anchor slice - structure not string', async () => {
    const result = await fingerprintSession(MUTANT);
    if (result.ok) throw new Error('the mutated slice was accepted');
    expect(result.mismatch.code).toBe('entryFieldMissing');
    expect(result.mismatch.field).toBe('uuid');
    // Line 3 is the first entry carrying CONVERSATION_CORE, and `uuid` is the
    // first key asserted on it.
    expect(result.mismatch.path).toMatch(/:3$/);

    // And the version on that line is not merely in range - it is the anchor
    // itself. Nothing about the string is doing this work.
    const mutated = await entriesOf(MUTANT);
    expect(mutated[2]?.['version']).toBe(PINNED_CC_VERSION);
    expect(isVersionAccepted(String(mutated[2]?.['version']))).toBe(true);
    expect('uuid' in (mutated[2] ?? {})).toBe(false);
    expect('uuidRenamedByHand' in (mutated[2] ?? {})).toBe(true);
  });

  it('accepts the same five lines unmutated, so the refusal is the one key', async () => {
    // The control. Without it "the mutant is refused" could be a statement
    // about head-5.jsonl rather than about the rename.
    const slugDir = join(temp, 'unmutated', 'SYNTHETIC-hand-mutated-not-captured');
    await mkdir(slugDir, { recursive: true });
    const main = join(slugDir, `${SESSION_246}.jsonl`);
    await copyFile(HEAD_5, main);
    const result = await fingerprintSession(main);
    if (!result.ok) throw new Error(`${result.mismatch.code}: ${result.mismatch.reason}`);
    expect(result.value.versions).toEqual([PINNED_CC_VERSION]);
    expect(result.diagnostics.malformedLines).toBe(0);
  });

  it('differs from its source by exactly one key on one line', async () => {
    const source = await entriesOf(HEAD_5);
    const mutated = await entriesOf(MUTANT);
    expect(mutated).toHaveLength(source.length);
    const differing = source
      .map((entry, i) => [i, JSON.stringify(entry) === JSON.stringify(mutated[i])] as const)
      .filter(([, same]) => !same)
      .map(([i]) => i);
    expect(differing).toEqual([2]);
    expect(Object.keys(mutated[2] ?? {})).toHaveLength(Object.keys(source[2] ?? {}).length);
  });
});

// ---------------------------------------------------------------------------
// DoD 1.5 - the local-model corpus
// ---------------------------------------------------------------------------

describe('a session on a local local-model model is read like any other', () => {
  it('renders a tree, with nothing parked', async () => {
    const result = await graftSession(MAIN_241);
    if (!result.ok) throw new Error(`${result.mismatch.code}: ${result.mismatch.reason}`);
    const { snapshot } = result;
    expect(snapshot.sessionId).toBe(SESSION_241);
    // Flat: the session spawned nothing, so there is nothing to graft AND
    // nothing to park. Both halves matter - a parked agent would mean the join
    // had failed rather than been absent.
    expect(snapshot.counts.parked).toBe(0);
    expect(snapshot.counts.grafted).toBe(0);
    expect(snapshot.parked).toEqual([]);
    expect(snapshot.edges).toEqual([]);
    // It is a tree, not an empty shell: the session really did call tools.
    expect(snapshot.counts.toolNodes).toBe(21);
  });

  it('counts the two record types it does not know, and refuses neither', async () => {
    // `atis-latch` and `system` are entry TYPES outside KNOWN_ENTRY_TYPES, so
    // the line parser rejects them as `unknownType` - one line each, counted,
    // skipped. Unknown FIELDS are a different thing and are kept silently;
    // that is the `atis` half, asserted below.
    const text = await readFile(MAIN_241, 'utf8');
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(121);

    const batch = parseLines(lines);
    if (!batch.ok) throw new Error('parseLines never reports ok:false');
    const unknown = batch.value.rejections.filter((r) => r.rejection === 'unknownType');
    expect(unknown).toHaveLength(11);
    expect(batch.diagnostics.malformedLines).toBe(11);
    expect(batch.diagnostics.parsedLines).toBe(110);

    const byType = new Map<string, number>();
    for (const r of unknown) {
      const type = r.reason.replace('unknown type: ', '');
      byType.set(type, (byType.get(type) ?? 0) + 1);
    }
    expect(Object.fromEntries(byType)).toEqual({ 'atis-latch': 9, system: 2 });
    for (const type of byType.keys()) expect(KNOWN_ENTRY_TYPES.has(type)).toBe(false);
    // The fingerprint tolerates the same two: an unrecognised record kind is
    // not a layout change, so only `type` itself is required of it.
    for (const type of byType.keys()) expect(REQUIRED_ENTRY_FIELDS.has(type)).toBe(false);
  });

  it('treats `atis` as part of the atis-latch record, not as a new envelope key', async () => {
    // Worth stating because a first-20-lines shape diff reads the other way:
    // `atis` looks like a top-level field CC 2.1.241 added. It is not. Every
    // line carrying it in EITHER corpus is an `atis-latch` record, so `atis`
    // and `atis-latch` are one finding, not two.
    const here = await entriesOf(MAIN_241);
    const withAtis = here.filter((entry) => 'atis' in entry);
    expect(withAtis).toHaveLength(9);
    expect(new Set(withAtis.map((entry) => entry['type']))).toEqual(new Set(['atis-latch']));

    const anchor = await entriesOf(MAIN_246);
    const anchorAtis = anchor.filter((entry) => 'atis' in entry);
    expect(anchorAtis).toHaveLength(1);
    expect(new Set(anchorAtis.map((entry) => entry['type']))).toEqual(new Set(['atis-latch']));

    // Admit the record type and the field survives the parse boundary intact,
    // so the skip above is about the TYPE and nothing is being stripped.
    const batch = parseLines([JSON.stringify(withAtis[0])], { allowUnknownTypes: true });
    expect(batch.value.rejections).toEqual([]);
    expect(batch.value.entries[0]).toHaveProperty('atis');
  });

  it('keeps fields the requirement table has never heard of, on known types too', async () => {
    // The unknown-FIELD half, on a record kind the parser does know, so it
    // cannot be confused with the unknown-TYPE path above.
    const here = await entriesOf(MAIN_241);
    const assistant = here.find((entry) => entry['type'] === 'assistant');
    expect(assistant).toBeDefined();
    const required = new Set([
      'type',
      ...(REQUIRED_ENTRY_FIELDS.get('assistant') ?? []).map((f) => f.name),
    ]);
    const extras = Object.keys(assistant ?? {}).filter((key) => !required.has(key));
    expect(extras.length).toBeGreaterThan(0);

    const batch = parseLines([JSON.stringify(assistant)]);
    expect(batch.value.rejections).toEqual([]);
    for (const key of extras) expect(batch.value.entries[0]).toHaveProperty(key);
  });

  it('tolerates the absence of requestId and message.diagnostics', async () => {
    // Both are present in the 2.1.246 anchor and absent here, so the two
    // corpora disagree about a field in each direction and both still parse.
    const here = await entriesOf(MAIN_241);
    expect(here.filter((entry) => 'requestId' in entry)).toHaveLength(0);
    expect(
      here.filter((entry) => {
        const message = entry['message'];
        return typeof message === 'object' && message !== null && 'diagnostics' in message;
      }),
    ).toHaveLength(0);

    const anchor = await entriesOf(MAIN_246);
    expect(anchor.filter((entry) => 'requestId' in entry).length).toBeGreaterThan(0);
    expect(
      anchor.filter((entry) => {
        const message = entry['message'];
        return typeof message === 'object' && message !== null && 'diagnostics' in message;
      }).length,
    ).toBeGreaterThan(0);
  });

  it('records the model as an absolute local-model path, and does not care', async () => {
    const models = new Set<string>();
    for (const entry of await entriesOf(MAIN_241)) {
      const message = entry['message'];
      if (typeof message !== 'object' || message === null) continue;
      const model = (message as { model?: unknown }).model;
      if (typeof model === 'string') models.add(model);
    }
    expect([...models]).toEqual(['C:\\AI <LOCAL_MODEL>']);
  });

  it('lands the unrecognised file in the session directory in `ignored`', async () => {
    const result = await fingerprintSession(MAIN_241);
    if (!result.ok) throw new Error(`${result.mismatch.code}: ${result.mismatch.reason}`);
    const ignored = result.value.ignored.map((p) =>
      relative(result.value.sessionDir, p).split(sep).join('/'),
    );
    expect(ignored).toEqual(['auto-mode-classifier-error.txt']);
    // And it is `ignored`, not a mismatch of any kind - the session is ok.
    expect(result.value.subagents).toEqual([]);
  });
});
