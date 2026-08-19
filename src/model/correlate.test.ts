/**
 * Tests for the workspace/session correlator.
 *
 * Three fixture sources, never mixed up:
 *
 *   fixtures/cc-2.1.234/        captured from real CC 2.1.234 sessions. Ground
 *                               truth about CC's layout (G6). Everything about
 *                               it is DERIVED here — the capture is re-harvested
 *                               between phases, so no test hard-codes its counts.
 *   fixtures/synthetic-layout/  hand-mutated slug directories. Evidence about
 *                               *our* behaviour, never about CC's. Carries the
 *                               two committed `memory/` traps.
 *   <os temp>/                  built per test for cases no fixture holds (an
 *                               orphan session directory, an unreachable HOME).
 *                               Nothing is ever written inside the repo.
 *
 * The load-bearing test in this file is the ordering proof. "`memory` is not
 * in the results" is too weak — a directory-first implementation that happens
 * to filter the name `memory` passes it. So the ordering test builds a tree
 * that discriminates and then RUNS a directory-first reference implementation
 * against the same tree, asserting the two disagree. If the tree ever stops
 * discriminating, that assertion fails and the proof does not silently rot.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { snapshotTree } from '../parser/tailer.js';
import {
  correlateWorkspace,
  findByTranscriptPath,
  findSession,
  isOpenWorkspaceSlug,
  normalizeSlug,
  sameWorkspace,
  workspaceMatch,
  workspaceSlug,
} from './correlate.js';
import type { WorkspaceCorrelation } from './correlate.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Repo-relative fixture roots: src/model/ -> repo root. */
const FIXTURE_ROOT = fileURLToPath(new URL('../../fixtures/cc-2.1.234/projects', import.meta.url));
const SYNTHETIC_ROOT = fileURLToPath(new URL('../../fixtures/synthetic-layout', import.meta.url));
const SYNTHETIC_SLUG = 'SYNTHETIC-hand-mutated-not-captured';
/** A workspace path that encodes to {@link SYNTHETIC_SLUG}. */
const SYNTHETIC_WORKSPACE = 'SYNTHETIC\\hand\\mutated\\not\\captured';

const TEST_WORKSPACE = 'c:\\Users\\Test\\Documents\\ws';
const TEST_SLUG_LOWER = 'c--Users-Test-Documents-ws';
const TEST_SLUG_UPPER = 'C--Users-Test-Documents-ws';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'agent-deck-correlate-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** `fixtures/synthetic-layout/<case>` used as a projects root. */
function syntheticProjectsRoot(caseName: string): string {
  return join(SYNTHETIC_ROOT, caseName);
}

/**
 * What the captured slug directory actually contains, read with plain readdir
 * rather than the module under test, so fixture assertions cross-check instead
 * of restating the implementation.
 */
interface FixtureLayout {
  slugDirName: string;
  slugDir: string;
  /** Session ids taken from `<sessionId>.jsonl` FILES. */
  sessionIds: string[];
  mainTranscripts: string[];
  subagentTranscripts: string[];
  /** Entry names directly inside the slug dir that are directories. */
  slugSubdirectories: string[];
}

async function readFixtureLayout(): Promise<FixtureLayout> {
  const rootEntries = await readdir(FIXTURE_ROOT, { withFileTypes: true });
  const slugEntry = rootEntries.find((e) => e.isDirectory());
  if (slugEntry === undefined) throw new Error(`no slug directory under ${FIXTURE_ROOT}`);
  const slugDir = join(FIXTURE_ROOT, slugEntry.name);

  const sessionIds: string[] = [];
  const mainTranscripts: string[] = [];
  const subagentTranscripts: string[] = [];
  const slugSubdirectories: string[] = [];

  for (const entry of await readdir(slugDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      slugSubdirectories.push(entry.name);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const sessionId = entry.name.slice(0, -'.jsonl'.length);
    sessionIds.push(sessionId);
    mainTranscripts.push(join(slugDir, entry.name));

    const subagentsDir = join(slugDir, sessionId, 'subagents');
    try {
      for (const sub of await readdir(subagentsDir, { withFileTypes: true })) {
        if (sub.isFile() && sub.name.endsWith('.jsonl')) {
          subagentTranscripts.push(join(subagentsDir, sub.name));
        }
      }
    } catch {
      // no subagents/ directory: this session spawned none
    }
  }

  return {
    slugDirName: slugEntry.name,
    slugDir,
    sessionIds: sessionIds.sort(),
    mainTranscripts: mainTranscripts.sort(),
    subagentTranscripts: subagentTranscripts.sort(),
    slugSubdirectories: slugSubdirectories.sort(),
  };
}

/**
 * The workspace path CC itself recorded in the capture. Read from the
 * transcript's own `cwd` field rather than hard-coded, so the round-trip test
 * is anchored to captured data on both ends.
 */
async function recordedWorkspacePath(): Promise<string> {
  const layout = await readFixtureLayout();
  for (const transcript of layout.mainTranscripts) {
    const text = await readFile(transcript, 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const cwd = (parsed as { cwd?: unknown }).cwd;
      if (typeof cwd === 'string' && cwd !== '') return cwd;
    }
  }
  throw new Error('no `cwd` recorded in any captured transcript');
}

/** Correlate against a projects root, with no env and no reachable home. */
async function correlateAgainst(
  root: string,
  workspacePath: string,
): Promise<WorkspaceCorrelation> {
  const result = await correlateWorkspace(workspacePath, { projectsRoot: root, env: {} });
  expect(result.ok, `correlation failed: ${result.ok ? '' : result.failure.message}`).toBe(true);
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
}

/**
 * A DIRECTORY-FIRST discovery, written the wrong way on purpose: it enumerates
 * the slug's subdirectories and calls each one a session, filtering the name
 * `memory` — the plausible-looking implementation the spec warns against.
 *
 * It exists so the ordering tests can show their tree actually discriminates
 * between the two orderings, rather than merely being consistent with the
 * right one.
 */
async function directoryFirstSessionIds(slugDir: string): Promise<string[]> {
  const ids: string[] = [];
  for (const entry of await readdir(slugDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'memory') continue;
    ids.push(entry.name.endsWith('.jsonl') ? entry.name.slice(0, -'.jsonl'.length) : entry.name);
  }
  return ids.sort();
}

async function writeFileIn(dir: string, name: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, body, 'utf8');
  return path;
}

// ---------------------------------------------------------------------------
// Slug <-> workspace mapping
// ---------------------------------------------------------------------------

describe('slug <-> workspace mapping', () => {
  it('round-trips this repo\u2019s own workspace: the cwd CC recorded encodes to the slug directory on disk', async () => {
    const layout = await readFixtureLayout();
    const cwd = await recordedWorkspacePath();

    // Forward: workspace path -> slug, matching the directory CC created.
    expect(normalizeSlug(workspaceSlug(cwd))).toBe(normalizeSlug(layout.slugDirName));
    // Reverse: the on-disk slug is recognised as belonging to that workspace.
    expect(workspaceMatch(layout.slugDirName, cwd)).not.toBe('differentWorkspace');
    expect(isOpenWorkspaceSlug(layout.slugDirName, cwd)).toBe(true);

    // And the round trip actually finds the sessions, not just the string.
    const correlation = await correlateAgainst(FIXTURE_ROOT, cwd);
    expect(correlation.slug).toBe(layout.slugDirName);
    expect(correlation.sessions.map((s) => s.sessionId)).toEqual(layout.sessionIds);
    expect(layout.sessionIds.length).toBeGreaterThan(0);
  });

  it('matches the Windows drive-letter case in both directions', () => {
    expect(workspaceMatch(TEST_SLUG_LOWER, TEST_WORKSPACE)).toBe('exact');
    expect(workspaceMatch(TEST_SLUG_UPPER, TEST_WORKSPACE)).toBe('caseInsensitive');
    expect(workspaceMatch(TEST_SLUG_LOWER, 'C:\\Users\\Test\\Documents\\ws')).toBe(
      'caseInsensitive',
    );
    expect(workspaceMatch(TEST_SLUG_UPPER, 'C:\\Users\\Test\\Documents\\ws')).toBe('exact');
    expect(isOpenWorkspaceSlug(TEST_SLUG_UPPER, TEST_WORKSPACE)).toBe(true);
  });

  it('normalises separators and a trailing separator, so one workspace has one slug', () => {
    expect(workspaceSlug('c:/Users/Test/Documents/ws')).toBe(TEST_SLUG_LOWER);
    expect(workspaceSlug('c:\\Users\\Test\\Documents\\ws\\')).toBe(TEST_SLUG_LOWER);
    expect(sameWorkspace('c:/Users/Test/Documents/ws/', 'C:\\Users\\Test\\Documents\\ws')).toBe(
      true,
    );
  });

  it('rejects a slug belonging to a different workspace, including a prefix sibling', () => {
    expect(workspaceMatch('c--Users-Test-Documents-other', TEST_WORKSPACE)).toBe(
      'differentWorkspace',
    );
    // `...-ws` is a strict prefix of `...-ws-2`; neither may match the other.
    expect(workspaceMatch(TEST_SLUG_LOWER, 'c:\\Users\\Test\\Documents\\ws-2')).toBe(
      'differentWorkspace',
    );
    expect(workspaceMatch('c--Users-Test-Documents-ws-2', TEST_WORKSPACE)).toBe(
      'differentWorkspace',
    );
    expect(isOpenWorkspaceSlug('c--Users-Test-Documents-other', TEST_WORKSPACE)).toBe(false);
    expect(sameWorkspace(TEST_WORKSPACE, 'c:\\Users\\Test\\Documents\\other')).toBe(false);
  });

  it('is documented as non-invertible because CC\u2019s encoding is not injective', () => {
    // ':' , '\' and '/' all collapse to '-', so two distinct workspace paths
    // can produce one slug. This is why the module offers no slug -> path
    // inverse: any reconstruction would be a guess (G3).
    expect(workspaceSlug('c:\\ws\\a')).toBe(workspaceSlug('c:\\ws-a'));
  });
});

// ---------------------------------------------------------------------------
// Only the open workspace's sessions
// ---------------------------------------------------------------------------

describe('correlateWorkspace — only the open workspace', () => {
  it('correlates the same sessions whichever drive-letter case the slug directory uses', async () => {
    for (const [rootName, slug, query] of [
      ['lower', TEST_SLUG_LOWER, 'C:\\Users\\Test\\Documents\\ws'],
      ['upper', TEST_SLUG_UPPER, 'c:\\Users\\Test\\Documents\\ws'],
    ] as const) {
      const root = join(tmpRoot, rootName);
      const slugDir = join(root, slug);
      await writeFileIn(slugDir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl', '{}\n');

      const correlation = await correlateAgainst(root, query);
      expect(correlation.slug).toBe(slug);
      expect(correlation.slugMatch).toBe('caseInsensitive');
      expect(correlation.sessions.map((s) => s.sessionId)).toEqual([
        'aaaaaaaa-0000-4000-8000-000000000001',
      ]);
    }
  });

  it('refuses a workspace that is not the one the capture belongs to', async () => {
    const layout = await readFixtureLayout();
    // Not vacuous: the real workspace does correlate to sessions here.
    expect(layout.sessionIds.length).toBeGreaterThan(0);

    const foreign = await correlateWorkspace('c:\\Users\\Test\\Documents\\some-other-repo', {
      projectsRoot: FIXTURE_ROOT,
      env: {},
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.failure.kind).toBe('projectSlugNotFound');
    expect(foreign.failure.code).toBe('ENOENT');
  });

  it('changes nothing on disk (G1)', async () => {
    const before = await snapshotTree(FIXTURE_ROOT);
    await correlateAgainst(FIXTURE_ROOT, await recordedWorkspacePath());
    const after = await snapshotTree(FIXTURE_ROOT);
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// The memory/ trap
// ---------------------------------------------------------------------------

describe('the memory/ trap', () => {
  it('never returns memory/ as a session (00-valid-control)', async () => {
    const root = syntheticProjectsRoot('00-valid-control');
    const slugDir = join(root, SYNTHETIC_SLUG);
    // The trap is present in this fixture, not assumed to be.
    expect((await stat(join(slugDir, 'memory'))).isDirectory()).toBe(true);

    const correlation = await correlateAgainst(root, SYNTHETIC_WORKSPACE);
    const ids = correlation.sessions.map((s) => s.sessionId);
    expect(ids).not.toContain('memory');
    for (const session of correlation.sessions) {
      expect(session.mainTranscript.startsWith(join(slugDir, 'memory'))).toBe(false);
      expect(session.sessionDir).not.toBe(join(slugDir, 'memory'));
      // Every session's main transcript is a real FILE.
      expect((await stat(session.mainTranscript)).isFile()).toBe(true);
    }
    // Exactly the `<sessionId>.jsonl` files, derived from the directory.
    const jsonlFiles = (await readdir(slugDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => e.name.slice(0, -'.jsonl'.length))
      .sort();
    expect(ids).toEqual(jsonlFiles);
    expect(jsonlFiles.length).toBeGreaterThan(0);
  });

  it('yields ZERO sessions for a slug that holds memory/ and no transcript (15-no-session-transcripts)', async () => {
    const root = syntheticProjectsRoot('15-no-session-transcripts');
    const slugDir = join(root, SYNTHETIC_SLUG);
    expect((await stat(join(slugDir, 'memory'))).isDirectory()).toBe(true);

    const correlation = await correlateAgainst(root, SYNTHETIC_WORKSPACE);
    // An existing slug directory with no transcripts is a well-formed empty
    // project, not a refusal — and emphatically not one session named memory.
    expect(correlation.sessions).toEqual([]);
    expect(correlation.slug).toBe(SYNTHETIC_SLUG);
  });
});

// ---------------------------------------------------------------------------
// Discovery ordering: files first, directories second
// ---------------------------------------------------------------------------

describe('discovery starts from <sessionId>.jsonl FILES', () => {
  it('disagrees with a directory-first implementation on a tree that discriminates', async () => {
    const slugDir = join(tmpRoot, 'ordering', TEST_SLUG_LOWER);
    const ghost = 'bbbbbbbb-0000-4000-8000-00000000ffff'; // directory, no transcript
    const real = 'aaaaaaaa-0000-4000-8000-000000000001'; // transcript, no directory

    await writeFileIn(join(slugDir, ghost, 'subagents'), 'agent-a1.jsonl', '{}\n');
    await writeFileIn(join(slugDir, ghost, 'subagents'), 'agent-a1.meta.json', '{}\n');
    await writeFileIn(join(slugDir, 'memory'), 'notes.md', '# not a session\n');
    await writeFileIn(slugDir, `${real}.jsonl`, '{}\n');

    const correlation = await correlateAgainst(join(tmpRoot, 'ordering'), TEST_WORKSPACE);
    expect(correlation.sessions.map((s) => s.sessionId)).toEqual([real]);

    // The proof: the same tree, read directory-first, gives a DIFFERENT answer.
    // If this ever stops being true the tree no longer discriminates and the
    // assertion above would prove nothing — so it is asserted, not assumed.
    const wrong = await directoryFirstSessionIds(slugDir);
    expect(wrong).toEqual([ghost]);
    expect(wrong).not.toEqual(correlation.sessions.map((s) => s.sessionId));
  });

  it('does not treat a session directory without a matching transcript as a session', async () => {
    const root = join(tmpRoot, 'orphan');
    const slugDir = join(root, TEST_SLUG_LOWER);
    const orphan = 'cccccccc-0000-4000-8000-000000000002';
    await writeFileIn(join(slugDir, orphan, 'subagents'), 'agent-a1.jsonl', '{}\n');
    await writeFileIn(join(slugDir, orphan, 'tool-results'), 'x.txt', 'payload\n');

    const correlation = await correlateAgainst(root, TEST_WORKSPACE);
    expect(correlation.sessions).toEqual([]);
    // The directory really is there — the emptiness is a decision, not an absence.
    expect((await stat(join(slugDir, orphan))).isDirectory()).toBe(true);
  });

  it('ignores a DIRECTORY named <sessionId>.jsonl (09-main-transcript-is-a-directory)', async () => {
    const root = syntheticProjectsRoot('09-main-transcript-is-a-directory');
    const slugDir = join(root, SYNTHETIC_SLUG);
    const asDir = join(slugDir, 'deadbeef-0000-4000-8000-000000000001.jsonl');
    expect((await stat(asDir)).isDirectory()).toBe(true);

    const correlation = await correlateAgainst(root, SYNTHETIC_WORKSPACE);
    expect(correlation.sessions).toEqual([]);
    // Directory-first would have called it a session; file-first cannot.
    expect(await directoryFirstSessionIds(slugDir)).toEqual([
      'deadbeef-0000-4000-8000-000000000001',
    ]);
  });

  it('ignores non-transcript files sitting in the slug directory', async () => {
    const root = join(tmpRoot, 'strays');
    const slugDir = join(root, TEST_SLUG_LOWER);
    await writeFileIn(slugDir, 'notes.txt', 'x');
    await writeFileIn(slugDir, 'not-a-session.jsonl.bak', 'x');
    await writeFileIn(slugDir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl', '{}\n');

    const correlation = await correlateAgainst(root, TEST_WORKSPACE);
    expect(correlation.sessions.map((s) => s.sessionId)).toEqual([
      'aaaaaaaa-0000-4000-8000-000000000001',
    ]);
  });

  it('reports the captured slug\u2019s subdirectories as sessions only where a transcript exists', async () => {
    const layout = await readFixtureLayout();
    const correlation = await correlateAgainst(FIXTURE_ROOT, await recordedWorkspacePath());
    const ids = correlation.sessions.map((s) => s.sessionId);

    expect(ids).toEqual(layout.sessionIds);
    for (const name of layout.slugSubdirectories) {
      if (!layout.sessionIds.includes(name)) expect(ids).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// CLAUDE_PROJECTS_ROOT and the negative control
// ---------------------------------------------------------------------------

describe('projects-root resolution', () => {
  it('honours CLAUDE_PROJECTS_ROOT instead of ~/.claude/projects', async () => {
    const layout = await readFixtureLayout();
    const result = await correlateWorkspace(await recordedWorkspacePath(), {
      env: { CLAUDE_PROJECTS_ROOT: FIXTURE_ROOT },
      homedir: () => join(tmpRoot, 'unreachable-home'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rootSource).toBe('env');
    expect(result.value.projectsRoot).toBe(FIXTURE_ROOT);
    expect(result.value.sessions.map((s) => s.sessionId)).toEqual(layout.sessionIds);
  });

  it('NEGATIVE CONTROL: no override and an unreachable HOME fails ENOENT, never an empty success', async () => {
    const home = join(tmpRoot, 'unreachable-home');
    const result = await correlateWorkspace(await recordedWorkspacePath(), {
      env: {},
      homedir: () => home,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('projectsRootNotFound');
    expect(result.failure.code).toBe('ENOENT');
    expect(result.failure.path).toBe(join(home, '.claude', 'projects'));
    // The refusal names the home location, so a silent fall-back to the
    // fixture root (or to a live ~/.claude) cannot hide behind it.
    expect(result.failure.path.startsWith(FIXTURE_ROOT)).toBe(false);
  });

  it('treats an empty CLAUDE_PROJECTS_ROOT as unset rather than as the filesystem root', async () => {
    const home = join(tmpRoot, 'unreachable-home');
    const result = await correlateWorkspace(await recordedWorkspacePath(), {
      env: { CLAUDE_PROJECTS_ROOT: '' },
      homedir: () => home,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.path).toBe(join(home, '.claude', 'projects'));
  });
});

// ---------------------------------------------------------------------------
// Lookups for incoming hook events
// ---------------------------------------------------------------------------

describe('lookups for incoming events', () => {
  it('finds a session by session_id, case-insensitively, and only within this workspace', async () => {
    const layout = await readFixtureLayout();
    const correlation = await correlateAgainst(FIXTURE_ROOT, await recordedWorkspacePath());
    const known = layout.sessionIds[0];
    expect(known).toBeDefined();
    if (known === undefined) return;

    expect(findSession(correlation, known)?.sessionId).toBe(known);
    expect(findSession(correlation, known.toUpperCase())?.sessionId).toBe(known);
    expect(findSession(correlation, 'ffffffff-0000-4000-8000-00000000dead')).toBeUndefined();
  });

  it('maps a transcript_path to its session, distinguishing main from subagent', async () => {
    const layout = await readFixtureLayout();
    const correlation = await correlateAgainst(FIXTURE_ROOT, await recordedWorkspacePath());

    for (const main of layout.mainTranscripts) {
      const ref = findByTranscriptPath(correlation, main);
      expect(ref, `main transcript not correlated: ${main}`).toBeDefined();
      expect(ref?.kind).toBe('main');
      expect(ref?.session.mainTranscript).toBe(main);
    }

    expect(layout.subagentTranscripts.length).toBeGreaterThan(0);
    for (const sub of layout.subagentTranscripts) {
      const ref = findByTranscriptPath(correlation, sub);
      expect(ref, `subagent transcript not correlated: ${sub}`).toBeDefined();
      expect(ref?.kind).toBe('subagent');
      expect(ref?.subagent?.transcriptPath).toBe(sub);
      expect(ref?.agentId).toBe(ref?.subagent?.agentId);
      // The subagent's session is one of this workspace's sessions.
      expect(layout.sessionIds).toContain(ref?.sessionId);
    }
  });

  it('returns undefined for a tool-results payload, a session directory and a foreign path', async () => {
    const correlation = await correlateAgainst(FIXTURE_ROOT, await recordedWorkspacePath());
    const first = correlation.sessions[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    expect(findByTranscriptPath(correlation, join(first.toolResultsDir, 'x.txt'))).toBeUndefined();
    expect(findByTranscriptPath(correlation, first.sessionDir)).toBeUndefined();
    expect(
      findByTranscriptPath(correlation, join(tmpRoot, 'elsewhere', `${first.sessionId}.jsonl`)),
    ).toBeUndefined();
  });
});
