/**
 * Tests for the JSONL half of the liveness merge.
 *
 * The `hasStopEntry` decision is not asserted from the module's comment — it
 * is re-derived here from the committed fixtures with plain `readdir`/JSON
 * parsing, so a future capture that introduces a real in-transcript stop
 * marker fails this file rather than silently invalidating the comment (G6).
 *
 * Nothing is written outside the OS temp directory. One test proves the
 * fixture tree is byte-identical after a run (G1).
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LivenessEngine } from '../model/liveness.js';
import { slugifyWorkspace, snapshotTree } from '../parser/tailer.js';
import { createJsonlInferenceReader, createJsonlInferenceSource } from './inference.js';
import type { InferenceDirent, InferenceFs, InferenceStats } from './inference.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Repo-relative fixture root: src/watch/ -> repo root. */
const FIXTURE_ROOT = fileURLToPath(new URL('../../fixtures/cc-2.1.234/projects', import.meta.url));
const FIXTURE_WORKSPACE = 'c:\\Users\\dev\\projects\\agent-deck';

const WORKSPACE = 'c:\\Users\\Test\\Documents\\ws';
const SLUG = slugifyWorkspace(WORKSPACE);
const SESSION_A = '4299490e-4a09-46a0-a544-7ffb0429e7e7';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'agent-deck-infer-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function jsonl(...objects: Record<string, unknown>[]): string {
  return objects.map((o) => `${JSON.stringify(o)}\n`).join('');
}

/**
 * What the committed capture actually contains, read independently of the
 * module under test. Every number below is derived; none is pinned.
 */
async function fixtureTranscripts(): Promise<{ slugDir: string; files: string[] }> {
  const rootEntries = await readdir(FIXTURE_ROOT, { withFileTypes: true });
  const slugEntry = rootEntries.find((e) => e.isDirectory());
  if (slugEntry === undefined) throw new Error(`no slug directory under ${FIXTURE_ROOT}`);
  const slugDir = join(FIXTURE_ROOT, slugEntry.name);

  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(full);
      }
    }
  };
  await walk(slugDir);
  files.sort();
  return { slugDir, files };
}

async function fixtureSessionIds(): Promise<string[]> {
  const { slugDir } = await fixtureTranscripts();
  const ids: string[] = [];
  for (const entry of await readdir(slugDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^([0-9a-f][0-9a-f-]{7,})\.jsonl$/i.exec(entry.name);
    if (match?.[1] !== undefined) ids.push(match[1]);
  }
  ids.sort();
  return ids;
}

// ---------------------------------------------------------------------------
// mtimeMs
// ---------------------------------------------------------------------------

describe('createJsonlInferenceSource — mtimeMs', () => {
  it('reports the real mtime of every fixture session transcript', async () => {
    const ids = await fixtureSessionIds();
    expect(ids.length).toBeGreaterThan(0);

    const source = createJsonlInferenceSource({
      workspacePath: FIXTURE_WORKSPACE,
      projectsRoot: FIXTURE_ROOT,
    });
    const { slugDir } = await fixtureTranscripts();

    for (const id of ids) {
      const expected = (await stat(join(slugDir, `${id}.jsonl`))).mtimeMs;
      const inference = source(id);
      expect(inference).toBeDefined();
      expect(inference?.mtimeMs).toBe(expected);
    }
  });

  it('resolves the projects root from CLAUDE_PROJECTS_ROOT', async () => {
    const ids = await fixtureSessionIds();
    const first = ids[0];
    if (first === undefined) throw new Error('no fixture sessions');

    const source = createJsonlInferenceSource({
      workspacePath: FIXTURE_WORKSPACE,
      env: { CLAUDE_PROJECTS_ROOT: FIXTURE_ROOT },
      // A homedir that does not exist: reading ~/.claude would fail loudly.
      homedir: () => join(tmpRoot, 'nowhere'),
    });
    expect(source(first)?.mtimeMs).toBeGreaterThan(0);
  });

  it('never reads ~/.claude when CLAUDE_PROJECTS_ROOT is set', async () => {
    const reads: string[] = [];
    const fs: InferenceFs = {
      statSync: (path) => {
        reads.push(path);
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      readdirSync: (path) => {
        reads.push(path);
        return [];
      },
    };
    const source = createJsonlInferenceSource({
      workspacePath: FIXTURE_WORKSPACE,
      env: { CLAUDE_PROJECTS_ROOT: FIXTURE_ROOT },
      homedir: () => 'c:\\fake-home',
      fs,
    });
    source('4299490e-4a09-46a0-a544-7ffb0429e7e7');
    expect(reads.length).toBeGreaterThan(0);
    // Asserted as containment, not by grepping for '.claude': this repo's own
    // worktree path contains '.claude', so a substring check passes or fails
    // for reasons that have nothing to do with the home directory.
    const home = 'c:\\fake-home';
    for (const path of reads) {
      expect(path.toLowerCase().startsWith(FIXTURE_ROOT.toLowerCase())).toBe(true);
      expect(path.toLowerCase().startsWith(home)).toBe(false);
    }
  });

  it('matches the slug directory case-insensitively', async () => {
    const root = join(tmpRoot, 'projects');
    // Upper-case drive letter on disk; lower-case in the workspace path.
    await mkdir(join(root, 'C--Users-Test-Documents-ws'), { recursive: true });
    await writeFile(
      join(root, 'C--Users-Test-Documents-ws', `${SESSION_A}.jsonl`),
      jsonl({ type: 'user' }),
    );
    const source = createJsonlInferenceSource({
      workspacePath: 'c:\\Users\\Test\\Documents\\ws',
      projectsRoot: root,
    });
    expect(source(SESSION_A)?.mtimeMs).toBeGreaterThan(0);
  });

  it('accepts a pinned slugDir and skips resolution entirely', async () => {
    const root = join(tmpRoot, 'projects');
    const slugDir = join(root, SLUG);
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    const reader = createJsonlInferenceReader({
      workspacePath: WORKSPACE,
      projectsRoot: root,
      slugDir,
    });
    expect(reader.source(SESSION_A)?.mtimeMs).toBeGreaterThan(0);
    expect(reader.diagnostics.slugResolutions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Absence and refusal
// ---------------------------------------------------------------------------

describe('createJsonlInferenceSource — absence is undefined, never a throw', () => {
  it('returns undefined for an unknown session id', () => {
    const source = createJsonlInferenceSource({
      workspacePath: FIXTURE_WORKSPACE,
      projectsRoot: FIXTURE_ROOT,
    });
    expect(source('00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });

  it('returns undefined once the transcript is deleted', async () => {
    const root = join(tmpRoot, 'projects');
    const slugDir = join(root, SLUG);
    await mkdir(slugDir, { recursive: true });
    const transcript = join(slugDir, `${SESSION_A}.jsonl`);
    await writeFile(transcript, jsonl({ type: 'user' }));

    const reader = createJsonlInferenceReader({
      workspacePath: WORKSPACE,
      projectsRoot: root,
    });
    expect(reader.source(SESSION_A)?.mtimeMs).toBeGreaterThan(0);

    await rm(transcript);

    expect(reader.source(SESSION_A)).toBeUndefined();
    expect(reader.diagnostics.errors).toBe(0); // ENOENT is a miss, not a failure
    expect(reader.diagnostics.misses).toBe(1);
  });

  it('returns undefined when the projects root does not exist', () => {
    const source = createJsonlInferenceSource({
      workspacePath: WORKSPACE,
      projectsRoot: join(tmpRoot, 'no-such-root'),
    });
    expect(source(SESSION_A)).toBeUndefined();
  });

  it('returns undefined when the slug directory does not exist', async () => {
    const root = join(tmpRoot, 'projects');
    await mkdir(root, { recursive: true });
    const source = createJsonlInferenceSource({
      workspacePath: WORKSPACE,
      projectsRoot: root,
    });
    expect(source(SESSION_A)).toBeUndefined();
  });

  it('returns undefined when the transcript path is a directory', async () => {
    const root = join(tmpRoot, 'projects');
    await mkdir(join(root, SLUG, `${SESSION_A}.jsonl`), { recursive: true });
    const source = createJsonlInferenceSource({
      workspacePath: WORKSPACE,
      projectsRoot: root,
    });
    expect(source(SESSION_A)).toBeUndefined();
  });

  it('refuses session ids that would escape the projects root', () => {
    const reader = createJsonlInferenceReader({
      workspacePath: FIXTURE_WORKSPACE,
      projectsRoot: FIXTURE_ROOT,
    });
    // The NUL cases are spelled with an escape, never a raw byte. A source
    // file carrying a literal NUL is binary to git — no reviewable diff — and
    // silently defeats a `git log -p | grep` history audit run without `-a`.
    // CLAUDE.md records that trap against parse.test.ts, where the NUL is a
    // deliberate fuzz fixture. Here there is no reason for a raw byte at all.
    const ids = ['..', '../../etc/passwd', '..\\..\\secrets', 'a/b', 'a\\b', '', '\0', 'a\0b'];
    for (const id of ids) {
      expect(reader.source(id)).toBeUndefined();
    }
    expect(reader.diagnostics.rejectedSessionIds).toBe(ids.length);
  });

  it('does not throw when stat fails with something other than ENOENT', () => {
    const fs: InferenceFs = {
      statSync: () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
      readdirSync: () => [{ name: SLUG, isDirectory: () => true }],
    };
    const reader = createJsonlInferenceReader({
      workspacePath: WORKSPACE,
      projectsRoot: join(tmpRoot, 'projects'),
      fs,
    });
    expect(() => reader.source(SESSION_A)).not.toThrow();
    expect(reader.source(SESSION_A)).toBeUndefined();
    expect(reader.diagnostics.errors).toBeGreaterThan(0);
    expect(reader.diagnostics.lastError).toContain('EACCES');
  });
});

// ---------------------------------------------------------------------------
// Slug-directory cache
// ---------------------------------------------------------------------------

describe('createJsonlInferenceReader — slug cache invalidation', () => {
  it('resolves the slug directory once across many calls', async () => {
    const root = join(tmpRoot, 'projects');
    const slugDir = join(root, SLUG);
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    const reader = createJsonlInferenceReader({
      workspacePath: WORKSPACE,
      projectsRoot: root,
    });
    for (let i = 0; i < 25; i += 1) reader.source(SESSION_A);

    expect(reader.diagnostics.calls).toBe(25);
    expect(reader.diagnostics.hits).toBe(25);
    expect(reader.diagnostics.slugResolutions).toBe(1);
  });

  it('re-resolves after the slug directory is renamed away', async () => {
    const root = join(tmpRoot, 'projects');
    const slugDir = join(root, SLUG);
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    const reader = createJsonlInferenceReader({
      workspacePath: WORKSPACE,
      projectsRoot: root,
    });
    expect(reader.source(SESSION_A)?.mtimeMs).toBeGreaterThan(0);
    expect(reader.diagnostics.slugResolutions).toBe(1);

    // The whole slug directory disappears: the cached name is now a lie.
    await rm(slugDir, { recursive: true, force: true });
    expect(reader.source(SESSION_A)).toBeUndefined();
    expect(reader.diagnostics.slugDir).toBeUndefined();

    // Re-created with a differently-cased name, as CC versions do.
    const recased = join(root, SLUG.replace(/^c/, 'C'));
    await mkdir(recased, { recursive: true });
    await writeFile(join(recased, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    expect(reader.source(SESSION_A)?.mtimeMs).toBeGreaterThan(0);
    expect(reader.diagnostics.slugResolutions).toBe(2);
  });

  it('keeps a cached directory that is still present when a session is missing', async () => {
    const root = join(tmpRoot, 'projects');
    const slugDir = join(root, SLUG);
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    const reader = createJsonlInferenceReader({
      workspacePath: WORKSPACE,
      projectsRoot: root,
    });
    reader.source(SESSION_A);
    for (let i = 0; i < 5; i += 1) reader.source('deadbeef-0000-4000-8000-000000000001');

    // The misses must not cost a readdir each: the directory is still there.
    expect(reader.diagnostics.slugResolutions).toBe(1);
    expect(reader.diagnostics.misses).toBe(5);
  });

  it('invalidate() forces the next call to re-resolve', async () => {
    const root = join(tmpRoot, 'projects');
    const slugDir = join(root, SLUG);
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    const reader = createJsonlInferenceReader({
      workspacePath: WORKSPACE,
      projectsRoot: root,
    });
    reader.source(SESSION_A);
    reader.invalidate();
    reader.source(SESSION_A);
    expect(reader.diagnostics.slugResolutions).toBe(2);
  });

  it('picks up a slug directory created after the reader was built', async () => {
    const root = join(tmpRoot, 'projects');
    await mkdir(root, { recursive: true });

    const reader = createJsonlInferenceReader({
      workspacePath: WORKSPACE,
      projectsRoot: root,
    });
    expect(reader.source(SESSION_A)).toBeUndefined();

    const slugDir = join(root, SLUG);
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    expect(reader.source(SESSION_A)?.mtimeMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// hasStopEntry — the fixture evidence, re-derived
// ---------------------------------------------------------------------------

describe('hasStopEntry — omitted on the fixture evidence (G3/G6)', () => {
  it('omits the key entirely rather than answering false', async () => {
    const ids = await fixtureSessionIds();
    const first = ids[0];
    if (first === undefined) throw new Error('no fixture sessions');

    const source = createJsonlInferenceSource({
      workspacePath: FIXTURE_WORKSPACE,
      projectsRoot: FIXTURE_ROOT,
    });
    const inference = source(first);
    expect(inference).toBeDefined();
    if (inference === undefined) throw new Error('no inference');
    // Not `toBeUndefined()`: the contract distinguishes an absent key
    // ("cannot say") from a present `false` ("looked, none found").
    expect(Object.prototype.hasOwnProperty.call(inference, 'hasStopEntry')).toBe(false);
    expect(Object.keys(inference)).toEqual(['mtimeMs']);
  });

  it('no committed transcript carries an in-transcript stop marker', async () => {
    const { files } = await fixtureTranscripts();
    expect(files.length).toBeGreaterThan(0);

    const types = new Set<string>();
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        const entry: unknown = JSON.parse(line);
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as Record<string, unknown>;
        if (typeof record['type'] === 'string') types.add(record['type']);
        // No top-level field claims the session ended.
        expect(record['stop']).toBeUndefined();
        expect(record['stopped']).toBeUndefined();
        expect(record['stopReason']).toBeUndefined();
        expect(record['isStop']).toBeUndefined();
        expect(record['endedAt']).toBeUndefined();
      }
    }
    expect(types.size).toBeGreaterThan(0);
    for (const type of types) {
      expect(type.toLowerCase()).not.toContain('stop');
      expect(type.toLowerCase()).not.toContain('end');
    }
  });

  it('stop_reason:end_turn is per-turn, so it cannot mean "session ended"', async () => {
    const { files } = await fixtureTranscripts();

    let maxPerFile = 0;
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      let count = 0;
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        const entry = JSON.parse(line) as { message?: { stop_reason?: unknown } };
        if (entry.message?.stop_reason === 'end_turn') count += 1;
      }
      maxPerFile = Math.max(maxPerFile, count);
    }
    // At least one committed transcript carries more than one `end_turn`.
    // A once-per-session terminator cannot appear twice in one file.
    expect(maxPerFile).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// The merge, end to end
// ---------------------------------------------------------------------------

describe('LivenessEngine wired to a real JsonlInferenceSource', () => {
  it('surfaces a fixture transcript mtime in the session snapshot', async () => {
    const ids = await fixtureSessionIds();
    const sessionId = ids[0];
    if (sessionId === undefined) throw new Error('no fixture sessions');
    const { slugDir } = await fixtureTranscripts();
    const expected = (await stat(join(slugDir, `${sessionId}.jsonl`))).mtimeMs;

    const engine = new LivenessEngine({
      now: () => expected + 1_000,
      inferenceSource: createJsonlInferenceSource({
        workspacePath: FIXTURE_WORKSPACE,
        projectsRoot: FIXTURE_ROOT,
      }),
    });
    // A transcript on disk with no hook events is still a session.
    engine.observeJsonl(sessionId, {});

    const snapshot = engine.snapshot(sessionId);
    expect(snapshot).toBeDefined();
    expect(snapshot?.mtimeMs).toBe(expected);
    expect(snapshot?.lastActivityAt).toBe(expected);
    expect(snapshot?.hasStopEntry).toBeUndefined();
    expect(snapshot?.inferenceOk).toBe(true);
    // Recent mtime, no Stop knowledge -> live. Degraded, because no hooks.
    expect(snapshot?.liveness).toBe('live');
    expect(snapshot?.degraded).toBe(true);
    expect(snapshot?.degradedReason).toBe('noHookEvents');
    expect(engine.counters().inferenceFailures).toBe(0);
  });

  it('goes idle once the mtime falls outside the threshold', async () => {
    const ids = await fixtureSessionIds();
    const sessionId = ids[0];
    if (sessionId === undefined) throw new Error('no fixture sessions');
    const { slugDir } = await fixtureTranscripts();
    const expected = (await stat(join(slugDir, `${sessionId}.jsonl`))).mtimeMs;

    const engine = new LivenessEngine({
      now: () => expected + 10_000,
      mtimeThresholdMs: 1_000,
      inferenceSource: createJsonlInferenceSource({
        workspacePath: FIXTURE_WORKSPACE,
        projectsRoot: FIXTURE_ROOT,
      }),
    });
    engine.observeJsonl(sessionId, {});
    expect(engine.snapshot(sessionId)?.liveness).toBe('idle');
  });

  it('a missing transcript degrades to hooks-only rather than failing the tap', () => {
    const engine = new LivenessEngine({
      now: () => 1_000,
      inferenceSource: createJsonlInferenceSource({
        workspacePath: WORKSPACE,
        projectsRoot: join(tmpRoot, 'no-such-root'),
      }),
    });
    engine.observeJsonl('4299490e-4a09-46a0-a544-7ffb0429e7e7', {});
    const snapshot = engine.snapshot('4299490e-4a09-46a0-a544-7ffb0429e7e7');
    expect(snapshot?.mtimeMs).toBeUndefined();
    // `undefined` is not a throw: the source refused, it did not fail.
    expect(snapshot?.inferenceOk).toBe(true);
    expect(engine.counters().inferenceFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// G1
// ---------------------------------------------------------------------------

describe('createJsonlInferenceSource — read-only (G1)', () => {
  it('leaves the fixture tree byte-identical', async () => {
    const before = await snapshotTree(FIXTURE_ROOT);
    const ids = await fixtureSessionIds();
    const source = createJsonlInferenceSource({
      workspacePath: FIXTURE_WORKSPACE,
      projectsRoot: FIXTURE_ROOT,
    });
    for (const id of ids) source(id);
    source('00000000-0000-4000-8000-000000000000');
    const after = await snapshotTree(FIXTURE_ROOT);
    expect(after).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });

  it('reads through the injected fs only — no other path is touched', () => {
    const seen: string[] = [];
    const stats: InferenceStats = {
      isFile: () => true,
      isDirectory: () => true,
      mtimeMs: 42,
    };
    const dirents: InferenceDirent[] = [{ name: SLUG, isDirectory: () => true }];
    const fs: InferenceFs = {
      statSync: (path) => {
        seen.push(path);
        return stats;
      },
      readdirSync: (path) => {
        seen.push(path);
        return dirents;
      },
    };
    const root = join(tmpRoot, 'projects');
    const source = createJsonlInferenceSource({
      workspacePath: WORKSPACE,
      projectsRoot: root,
      fs,
    });
    expect(source(SESSION_A)?.mtimeMs).toBe(42);
    expect(seen).toEqual([root, join(root, SLUG, `${SESSION_A}.jsonl`)]);
  });
});
