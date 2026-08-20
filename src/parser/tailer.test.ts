/**
 * Tests for the incremental tailer.
 *
 * Every file these tests create lives under the OS temp directory. Nothing is
 * written inside the repo, inside `fixtures/`, or inside any observed projects
 * root — the committed fixture tree is opened read-only and one test asserts
 * that a full poll leaves it byte-identical (G1).
 *
 * No test sleeps. The debounce tests drive an injected clock/scheduler.
 */

import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  Debouncer,
  FileTail,
  ManualTime,
  SessionTailer,
  discoverSessions,
  resolveProjectsRoot,
  selectSlugDirectory,
  slugifyWorkspace,
  snapshotTree,
  systemClock,
  systemScheduler,
} from './tailer.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const WORKSPACE = 'c:\\Users\\Test\\Documents\\ws';
const SLUG = 'c--Users-Test-Documents-ws';
const SESSION_A = '4299490e-4a09-46a0-a544-7ffb0429e7e7';
const SESSION_B = 'b1c2d3e4-0000-4000-8000-000000000001';

/** Repo-relative fixture root: src/parser/ -> repo root. */
const FIXTURE_ROOT = fileURLToPath(new URL('../../fixtures/cc-2.1.234/projects', import.meta.url));
const FIXTURE_WORKSPACE = 'c:\\Users\\dev\\projects\\agent-deck';
const FIXTURE_SESSION = '4299490e-4a09-46a0-a544-7ffb0429e7e7';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'agent-deck-tailer-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** A projects root under the temp dir. Never inside the repo. */
async function makeProjectsRoot(name = 'projects'): Promise<string> {
  const root = join(tmpRoot, name);
  await mkdir(root, { recursive: true });
  return root;
}

async function makeSlugDir(root: string, slug = SLUG): Promise<string> {
  const dir = join(root, slug);
  await mkdir(dir, { recursive: true });
  return dir;
}

function jsonl(...objects: Record<string, unknown>[]): string {
  return objects.map((o) => `${JSON.stringify(o)}\n`).join('');
}

/**
 * Independent re-implementation of "what the fixture tree contains", built
 * from plain readdir rather than the module under test, so fixture assertions
 * are a cross-check and not a tautology.
 *
 * Everything about the committed capture is DERIVED here. The capture is
 * re-harvested between phases — it grew from one session to two while this
 * package was being written — so no test may hard-code its counts.
 */
interface FixtureSession {
  sessionId: string;
  mainTranscript: string;
  subagentTranscripts: string[];
  subagentMetaFiles: string[];
  /** Entry names directly inside <sessionId>/, e.g. subagents, tool-results. */
  sessionDirEntries: string[];
}

async function readFixtureLayout(): Promise<{ slugDir: string; sessions: FixtureSession[] }> {
  const rootEntries = await readdir(FIXTURE_ROOT, { withFileTypes: true });
  const slugEntry = rootEntries.find((e) => e.isDirectory());
  if (slugEntry === undefined) throw new Error(`no slug directory under ${FIXTURE_ROOT}`);
  const slugDir = join(FIXTURE_ROOT, slugEntry.name);

  const sessions: FixtureSession[] = [];
  for (const entry of await readdir(slugDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const sessionId = entry.name.slice(0, -'.jsonl'.length);
    const sessionDir = join(slugDir, sessionId);

    let sessionDirEntries: string[] = [];
    try {
      sessionDirEntries = (await readdir(sessionDir)).sort();
    } catch {
      sessionDirEntries = []; // no session directory for this transcript
    }

    const subagentTranscripts: string[] = [];
    const subagentMetaFiles: string[] = [];
    const subagentsDir = join(sessionDir, 'subagents');
    try {
      for (const sub of await readdir(subagentsDir, { withFileTypes: true })) {
        if (!sub.isFile()) continue;
        if (sub.name.endsWith('.meta.json')) subagentMetaFiles.push(join(subagentsDir, sub.name));
        else if (sub.name.endsWith('.jsonl')) subagentTranscripts.push(join(subagentsDir, sub.name));
      }
    } catch {
      // no subagents/ directory: this session spawned none
    }

    sessions.push({
      sessionId,
      mainTranscript: join(slugDir, entry.name),
      subagentTranscripts: subagentTranscripts.sort(),
      subagentMetaFiles: subagentMetaFiles.sort(),
      sessionDirEntries,
    });
  }
  sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return { slugDir, sessions };
}

/** Every transcript in the capture: main transcripts plus subagent transcripts. */
function allTranscriptsOf(sessions: FixtureSession[]): string[] {
  return sessions.flatMap((s) => [s.mainTranscript, ...s.subagentTranscripts]).sort();
}

/** Complete (newline-terminated, non-blank) lines of a file, read independently. */
async function completeLinesOf(file: string): Promise<string[]> {
  const parts = (await readFile(file, 'utf8')).split('\n');
  parts.pop(); // text after the final newline is not yet a complete line
  return parts
    .filter((l) => l.trim() !== '')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// ---------------------------------------------------------------------------
// Slug + root resolution
// ---------------------------------------------------------------------------

describe('slugifyWorkspace', () => {
  it('collapses colon and both separators to dashes', () => {
    expect(slugifyWorkspace('c:\\Users\\X\\Documents\\agent-deck')).toBe(
      'c--Users-X-Documents-agent-deck',
    );
    expect(slugifyWorkspace('/home/x/agent-deck')).toBe('-home-x-agent-deck');
  });

  it('ignores a trailing separator so c:\\ws and c:\\ws\\ slug identically', () => {
    expect(slugifyWorkspace('c:\\ws\\')).toBe(slugifyWorkspace('c:\\ws'));
    expect(slugifyWorkspace('/home/x/')).toBe(slugifyWorkspace('/home/x'));
  });
});

describe('resolveProjectsRoot', () => {
  it('uses CLAUDE_PROJECTS_ROOT when set', () => {
    const resolved = resolveProjectsRoot({
      env: { CLAUDE_PROJECTS_ROOT: join(tmpRoot, 'fixture-root') },
      homedir: () => join(tmpRoot, 'home'),
    });
    expect(resolved.source).toBe('env');
    expect(resolved.root).toBe(join(tmpRoot, 'fixture-root'));
  });

  it('falls back to <home>/.claude/projects when the override is absent', () => {
    const resolved = resolveProjectsRoot({ env: {}, homedir: () => join(tmpRoot, 'home') });
    expect(resolved.source).toBe('home');
    expect(resolved.root).toBe(join(tmpRoot, 'home', '.claude', 'projects'));
  });

  it('treats an empty override as unset rather than as the filesystem root', () => {
    const resolved = resolveProjectsRoot({
      env: { CLAUDE_PROJECTS_ROOT: '   ' },
      homedir: () => join(tmpRoot, 'home'),
    });
    expect(resolved.source).toBe('home');
  });
});

describe('selectSlugDirectory', () => {
  // The full matrix, including the WSL/case-sensitive legs, lives in
  // src/model/pathmatrix.test.ts. These are the contract points discovery
  // itself depends on.
  const want = 'c--Users-Test-Documents-ws';

  it('prefers the exact spelling to a case variant', () => {
    expect(selectSlugDirectory(['C--Users-Test-Documents-WS', want], want)).toEqual({
      kind: 'exact',
      name: want,
    });
  });

  it('accepts a lone case variant, because CC varies the drive letter', () => {
    expect(selectSlugDirectory(['C--Users-Test-Documents-ws'], want)).toEqual({
      kind: 'caseInsensitive',
      name: 'C--Users-Test-Documents-ws',
    });
  });

  it('refuses two case variants rather than picking by readdir order', () => {
    expect(
      selectSlugDirectory(['C--Users-Test-Documents-ws', 'c--Users-Test-Documents-WS'], want),
    ).toEqual({
      kind: 'ambiguous',
      candidates: ['C--Users-Test-Documents-ws', 'c--Users-Test-Documents-WS'],
    });
  });

  it('reports none when nothing matches', () => {
    expect(selectSlugDirectory(['-home-test-ws'], want)).toEqual({ kind: 'none' });
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('discoverSessions — file-first ordering', () => {
  it('never treats a directory as a session: memory/ and an orphan session dir yield zero sessions', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    // A live slug dir always has memory/ as a sibling of the session dirs.
    await mkdir(join(slugDir, 'memory'), { recursive: true });
    // A session *directory* with real contents but no <sessionId>.jsonl file.
    await mkdir(join(slugDir, SESSION_A, 'subagents'), { recursive: true });
    await writeFile(join(slugDir, SESSION_A, 'subagents', 'agent-aaa.jsonl'), jsonl({ type: 'user' }));

    const result = await discoverSessions(WORKSPACE, { projectsRoot: root, env: {} });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A directory scan would have returned 1 or 2 here.
    expect(result.sessions).toHaveLength(0);
  });

  it('discovers only the session that has a <sessionId>.jsonl FILE', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    await mkdir(join(slugDir, 'memory'), { recursive: true });
    await mkdir(join(slugDir, SESSION_B), { recursive: true }); // dir only, no file
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    const result = await discoverSessions(WORKSPACE, { projectsRoot: root, env: {} });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions.map((s) => s.sessionId)).toEqual([SESSION_A]);
  });

  it('ignores a DIRECTORY named <sessionId>.jsonl', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    await mkdir(join(slugDir, `${SESSION_A}.jsonl`), { recursive: true });

    const result = await discoverSessions(WORKSPACE, { projectsRoot: root, env: {} });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions).toHaveLength(0);
  });

  it('ignores non-session files in the slug dir', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    await writeFile(join(slugDir, 'notes.txt'), 'x');
    await writeFile(join(slugDir, 'summary.json'), '{}');
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), '');

    const result = await discoverSessions(WORKSPACE, { projectsRoot: root, env: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions.map((s) => s.sessionId)).toEqual([SESSION_A]);
  });
});

describe('discoverSessions — slug matching', () => {
  it('matches the slug case-insensitively (Windows drive-letter case varies)', async () => {
    const root = await makeProjectsRoot();
    // Written with an upper-case drive letter, queried with a lower-case one.
    const slugDir = await makeSlugDir(root, 'C--Users-Test-Documents-ws');
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    const result = await discoverSessions('c:\\Users\\Test\\Documents\\ws', {
      projectsRoot: root,
      env: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).toBe('C--Users-Test-Documents-ws');
    expect(result.requestedSlug).toBe('c--Users-Test-Documents-ws');
    expect(result.sessions).toHaveLength(1);
  });

  it('matches when the on-disk slug is lower-case and the query is upper-case', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root, 'c--users-test-documents-ws');
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    const result = await discoverSessions('C:\\Users\\Test\\Documents\\ws', {
      projectsRoot: root,
      env: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions).toHaveLength(1);
  });

  it('refuses with projectSlugNotFound when the workspace has no slug dir', async () => {
    const root = await makeProjectsRoot();
    await makeSlugDir(root, 'c--some-other-workspace');

    const result = await discoverSessions(WORKSPACE, { projectsRoot: root, env: {} });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('projectSlugNotFound');
    expect(result.failure.code).toBe('ENOENT');
  });
});

describe('discoverSessions — subagents', () => {
  it('lists subagent transcripts and their sidecar paths', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));
    const subDir = join(slugDir, SESSION_A, 'subagents');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'agent-a5e718f3cb731b607.jsonl'), jsonl({ type: 'user' }));
    await writeFile(join(subDir, 'agent-a5e718f3cb731b607.meta.json'), '{}');

    const result = await discoverSessions(WORKSPACE, { projectsRoot: root, env: {} });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const session = result.sessions[0];
    expect(session).toBeDefined();
    expect(session?.subagents).toHaveLength(1);
    expect(session?.subagents[0]?.agentId).toBe('a5e718f3cb731b607');
    expect(session?.subagents[0]?.metaPath).toBe(
      join(subDir, 'agent-a5e718f3cb731b607.meta.json'),
    );
    // The sidecar is not a transcript and must not be tailed as one.
    expect(session?.subagents.map((s) => s.transcriptPath)).toEqual([
      join(subDir, 'agent-a5e718f3cb731b607.jsonl'),
    ]);
  });

  it('treats a missing subagents/ directory as zero subagents, not an error', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    const result = await discoverSessions(WORKSPACE, { projectsRoot: root, env: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions[0]?.subagents).toEqual([]);
  });
});

describe('discoverSessions — CLAUDE_PROJECTS_ROOT override', () => {
  it('reads the override root instead of ~/.claude/projects', async () => {
    const envRoot = await makeProjectsRoot('env-root');
    const envSlug = await makeSlugDir(envRoot);
    await writeFile(join(envSlug, `${SESSION_A}.jsonl`), jsonl({ type: 'user' }));

    const home = join(tmpRoot, 'home');
    const homeSlug = join(home, '.claude', 'projects', SLUG);
    await mkdir(homeSlug, { recursive: true });
    await writeFile(join(homeSlug, `${SESSION_B}.jsonl`), jsonl({ type: 'user' }));

    const result = await discoverSessions(WORKSPACE, {
      env: { CLAUDE_PROJECTS_ROOT: envRoot },
      homedir: () => home,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rootSource).toBe('env');
    // Replacement, not a merge: the home root's session must not appear.
    expect(result.sessions.map((s) => s.sessionId)).toEqual([SESSION_A]);
  });

  it('NEGATIVE CONTROL: no override + no ~/.claude/projects fails ENOENT, never an empty success', async () => {
    const home = join(tmpRoot, 'empty-home');
    await mkdir(home, { recursive: true });

    const result = await discoverSessions(WORKSPACE, { env: {}, homedir: () => home });

    // Must NOT be a success a caller could read as "no sessions".
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('projectsRootNotFound');
    expect(result.failure.code).toBe('ENOENT');
    // Must NOT have silently fallen back anywhere else.
    expect(result.failure.path).toBe(join(home, '.claude', 'projects'));
    expect(result).not.toHaveProperty('sessions');
  });

  it('NEGATIVE CONTROL: the tailer surfaces the same refusal and tracks no files', async () => {
    const home = join(tmpRoot, 'empty-home-2');
    await mkdir(home, { recursive: true });

    const tailer = new SessionTailer({ workspacePath: WORKSPACE, env: {}, homedir: () => home });
    const batch = await tailer.poll();

    expect(batch.discoveryFailure?.kind).toBe('projectsRootNotFound');
    expect(batch.discoveryFailure?.code).toBe('ENOENT');
    expect(batch.lines).toEqual([]);
    expect(tailer.trackedFiles()).toEqual([]);
    expect(tailer.lastDiscovery).toBeNull();
  });
});

describe('discoverSessions — a session directory holds more than subagents/', () => {
  it('ignores tool-results/ and stray files sitting beside subagents/', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    const main = join(slugDir, `${SESSION_A}.jsonl`);
    await writeFile(main, jsonl({ n: 1 }));

    const sessionDir = join(slugDir, SESSION_A);
    const subDir = join(sessionDir, 'subagents');
    await mkdir(subDir, { recursive: true });
    const agent = join(subDir, 'agent-aaa111.jsonl');
    await writeFile(agent, jsonl({ src: 'agent' }));
    await writeFile(join(subDir, 'agent-aaa111.meta.json'), '{"agentType":"x"}');

    // Both of these occur in real session directories beside subagents/.
    await mkdir(join(sessionDir, 'tool-results'), { recursive: true });
    await writeFile(join(sessionDir, 'tool-results', 'b6uvpgxa4.txt'), 'offloaded payload');
    await writeFile(join(sessionDir, 'auto-mode-classifier-error.txt'), 'boom');

    const result = await discoverSessions(WORKSPACE, { projectsRoot: root, env: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.subagents.map((s) => s.transcriptPath)).toEqual([agent]);
    expect(result.sessions[0]?.toolResultsDir).toBe(join(sessionDir, 'tool-results'));

    // tool-results/*.txt is not JSONL and must never be tailed as a transcript.
    const tailer = new SessionTailer({ workspacePath: WORKSPACE, projectsRoot: root, env: {} });
    const batch = await tailer.poll();
    expect(tailer.trackedFiles().sort()).toEqual([main, agent].sort());
    expect(batch.lines.map((l) => l.text)).toEqual(['{"n":1}', '{"src":"agent"}']);
  });

  it('treats a subagents path that is a FILE as zero subagents, not a crash', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ n: 1 }));
    await mkdir(join(slugDir, SESSION_A), { recursive: true });
    await writeFile(join(slugDir, SESSION_A, 'subagents'), 'not a directory');

    const result = await discoverSessions(WORKSPACE, { projectsRoot: root, env: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions[0]?.subagents).toEqual([]);
  });

  it('ignores a directory inside subagents/ that is named like a transcript', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ n: 1 }));
    const subDir = join(slugDir, SESSION_A, 'subagents');
    await mkdir(join(subDir, 'agent-bogus.jsonl'), { recursive: true });

    const result = await discoverSessions(WORKSPACE, { projectsRoot: root, env: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions[0]?.subagents).toEqual([]);
  });
});

describe('discoverSessions — committed fixture', () => {
  it('discovers exactly the sessions the fixture slug directory actually contains', async () => {
    const layout = await readFixtureLayout();
    const result = await discoverSessions(FIXTURE_WORKSPACE, {
      projectsRoot: FIXTURE_ROOT,
      env: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(layout.sessions.length).toBeGreaterThan(0);
    // Derived from the directory, never a literal: the capture is re-harvested
    // between phases and grew from one session to two mid-package.
    expect(result.sessions.map((s) => s.sessionId).sort()).toEqual(
      layout.sessions.map((s) => s.sessionId),
    );
    // The session this package was originally written against is still present.
    expect(result.sessions.map((s) => s.sessionId)).toContain(FIXTURE_SESSION);
  });

  it("matches each session's subagents to the files its subagents/ directory holds", async () => {
    const layout = await readFixtureLayout();
    const result = await discoverSessions(FIXTURE_WORKSPACE, {
      projectsRoot: FIXTURE_ROOT,
      env: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const expected of layout.sessions) {
      const found = result.sessions.find((s) => s.sessionId === expected.sessionId);
      expect(found, `session ${expected.sessionId} was not discovered`).toBeDefined();
      if (found === undefined) continue;

      expect(found.subagents.map((s) => s.transcriptPath).sort()).toEqual(
        expected.subagentTranscripts,
      );
      for (const subagent of found.subagents) {
        // A sidecar is never mistaken for a transcript...
        expect(subagent.transcriptPath.endsWith('.meta.json')).toBe(false);
        // ...and every transcript names its own sidecar.
        expect(subagent.metaPath).toBe(subagent.transcriptPath.replace(/\.jsonl$/, '.meta.json'));
        // Subagent transcripts live under subagents/, never loose in <sessionId>/.
        expect(subagent.transcriptPath.startsWith(join(found.sessionDir, 'subagents'))).toBe(true);
      }
      // Every sidecar on disk is reachable from a discovered subagent.
      const metaPaths = found.subagents.map((s) => s.metaPath);
      for (const meta of expected.subagentMetaFiles) expect(metaPaths).toContain(meta);
    }
  });

  it('reports tool-results/ as a path and never mistakes a session-directory entry for a session', async () => {
    const layout = await readFixtureLayout();
    const result = await discoverSessions(FIXTURE_WORKSPACE, {
      projectsRoot: FIXTURE_ROOT,
      env: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const discoveredIds = result.sessions.map((s) => s.sessionId);
    for (const expected of layout.sessions) {
      const found = result.sessions.find((s) => s.sessionId === expected.sessionId);
      if (found === undefined) continue;
      expect(found.toolResultsDir).toBe(join(found.sessionDir, 'tool-results'));
      // Whatever else the session directory holds — tool-results/ in the
      // re-harvested capture, stray .txt files in live trees — is not a session.
      for (const name of expected.sessionDirEntries) {
        expect(discoveredIds).not.toContain(name);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// FileTail — incremental reads
// ---------------------------------------------------------------------------

describe('FileTail — byte offsets', () => {
  it('returns only bytes appended since the last read', async () => {
    const file = join(tmpRoot, 'a.jsonl');
    await writeFile(file, jsonl({ n: 1 }, { n: 2 }));
    const tail = new FileTail(file, { sessionId: SESSION_A });

    const first = await tail.read();
    expect(first.lines.map((l) => l.text)).toEqual(['{"n":1}', '{"n":2}']);
    const offsetAfterFirst = tail.offset;
    expect(offsetAfterFirst).toBe(16);

    await appendFile(file, jsonl({ n: 3 }));
    const second = await tail.read();
    // Only the new line, and only the new bytes.
    expect(second.lines.map((l) => l.text)).toEqual(['{"n":3}']);
    expect(second.bytesRead).toBe(8);
    expect(tail.offset).toBe(offsetAfterFirst + 8);
  });

  it('reads nothing and costs no bytes when the file has not grown', async () => {
    const file = join(tmpRoot, 'b.jsonl');
    await writeFile(file, jsonl({ n: 1 }));
    const tail = new FileTail(file, { sessionId: SESSION_A });

    await tail.read();
    const again = await tail.read();
    expect(again.lines).toEqual([]);
    expect(again.bytesRead).toBe(0);
  });

  it('numbers lines continuously across reads', async () => {
    const file = join(tmpRoot, 'c.jsonl');
    await writeFile(file, jsonl({ n: 1 }, { n: 2 }));
    const tail = new FileTail(file, { sessionId: SESSION_A, agentId: 'agent-1' });

    const first = await tail.read();
    await appendFile(file, jsonl({ n: 3 }));
    const second = await tail.read();

    expect(first.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(second.lines.map((l) => l.lineNo)).toEqual([3]);
    expect(second.lines[0]?.agentId).toBe('agent-1');
    expect(second.lines[0]?.sessionId).toBe(SESSION_A);
  });
});

describe('FileTail — partial-line buffering', () => {
  it('emits zero lines after a half-written line and exactly one after the newline arrives', async () => {
    const file = join(tmpRoot, 'partial.jsonl');
    const line = '{"type":"assistant","text":"hello world"}';
    const cut = 20;

    await writeFile(file, line.slice(0, cut));
    const tail = new FileTail(file, { sessionId: SESSION_A });

    const first = await tail.read();
    expect(first.lines).toHaveLength(0);
    expect(first.bytesRead).toBe(cut);
    expect(tail.pendingBytes).toBe(cut);

    await appendFile(file, `${line.slice(cut)}\n`);
    const second = await tail.read();

    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]?.text).toBe(line);
    expect(JSON.parse(second.lines[0]?.text ?? 'null')).toEqual({
      type: 'assistant',
      text: 'hello world',
    });
    expect(tail.pendingBytes).toBe(0);
  });

  it('withholds a final line that has no trailing newline, then releases it', async () => {
    const file = join(tmpRoot, 'no-trailing-newline.jsonl');
    await writeFile(file, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}`);
    const tail = new FileTail(file, { sessionId: SESSION_A });

    const first = await tail.read();
    expect(first.lines.map((l) => l.text)).toEqual(['{"n":1}']);
    expect(first.skipped).toBeUndefined();

    await appendFile(file, '\n');
    const second = await tail.read();
    expect(second.lines.map((l) => l.text)).toEqual(['{"n":2}']);
  });

  it('strips CR from CRLF line endings', async () => {
    const file = join(tmpRoot, 'crlf.jsonl');
    await writeFile(file, '{"n":1}\r\n{"n":2}\r\n');
    const tail = new FileTail(file, { sessionId: SESSION_A });

    const result = await tail.read();
    expect(result.lines.map((l) => l.text)).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('skips blank lines rather than emitting empty records', async () => {
    const file = join(tmpRoot, 'blank.jsonl');
    await writeFile(file, '{"n":1}\n\n   \n{"n":2}\n');
    const tail = new FileTail(file, { sessionId: SESSION_A });

    const result = await tail.read();
    expect(result.lines.map((l) => l.text)).toEqual(['{"n":1}', '{"n":2}']);
  });
});

describe('FileTail — UTF-8 across read boundaries', () => {
  it('does not corrupt a 2-byte character split between two reads', async () => {
    const file = join(tmpRoot, 'utf8-2byte.jsonl');
    const full = Buffer.from(`${JSON.stringify({ text: 'café' })}\n`, 'utf8');
    const eIndex = full.indexOf(0xc3);
    expect(eIndex).toBeGreaterThan(0);

    // Split so 0xC3 lands in the first read and 0xA9 in the second.
    await writeFile(file, full.subarray(0, eIndex + 1));
    const tail = new FileTail(file, { sessionId: SESSION_A });

    const first = await tail.read();
    expect(first.lines).toHaveLength(0);

    await appendFile(file, full.subarray(eIndex + 1));
    const second = await tail.read();

    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]?.text).toBe(JSON.stringify({ text: 'café' }));
    expect(JSON.parse(second.lines[0]?.text ?? 'null')).toEqual({ text: 'café' });
  });

  it('does not corrupt a 4-byte character split between two reads, while still emitting the complete line before it', async () => {
    const file = join(tmpRoot, 'utf8-4byte.jsonl');
    const complete = Buffer.from(`${JSON.stringify({ n: 1 })}\n`, 'utf8');
    const second = Buffer.from(`${JSON.stringify({ text: 'go 🚀 now' })}\n`, 'utf8');
    const full = Buffer.concat([complete, second]);

    const rocketStart = full.indexOf(0xf0);
    expect(rocketStart).toBeGreaterThan(complete.length);
    // Cut two bytes into the 4-byte sequence.
    const cut = rocketStart + 2;

    await writeFile(file, full.subarray(0, cut));
    const tail = new FileTail(file, { sessionId: SESSION_A });

    const firstRead = await tail.read();
    expect(firstRead.lines.map((l) => l.text)).toEqual(['{"n":1}']);

    await appendFile(file, full.subarray(cut));
    const secondRead = await tail.read();

    expect(secondRead.lines).toHaveLength(1);
    expect(JSON.parse(secondRead.lines[0]?.text ?? 'null')).toEqual({ text: 'go 🚀 now' });
  });
});

describe('FileTail — replacement and truncation', () => {
  it('resets to offset 0 and re-reads when the file shrinks below the stored offset', async () => {
    const file = join(tmpRoot, 'replaced.jsonl');
    await writeFile(file, jsonl({ n: 1 }, { n: 2 }, { n: 3 }));
    const tail = new FileTail(file, { sessionId: SESSION_A });

    const first = await tail.read();
    expect(first.lines).toHaveLength(3);
    expect(first.reset).toBe(false);
    const before = tail.offset;

    // Replaced with strictly shorter content.
    await writeFile(file, jsonl({ n: 9 }));
    expect(tail.offset).toBe(before);

    const second = await tail.read();
    expect(second.reset).toBe(true);
    expect(second.lines.map((l) => l.text)).toEqual(['{"n":9}']);
    expect(tail.offset).toBe(8);
  });

  it('drops a stale partial buffer when the file is replaced', async () => {
    const file = join(tmpRoot, 'replaced-partial.jsonl');
    await writeFile(file, '{"n":1}\n{"partial"');
    const tail = new FileTail(file, { sessionId: SESSION_A });

    await tail.read();
    expect(tail.pendingBytes).toBeGreaterThan(0);

    await writeFile(file, '{"n":9}\n');
    const second = await tail.read();

    expect(second.reset).toBe(true);
    // The stale '{"partial"' must not be glued onto the new content.
    expect(second.lines.map((l) => l.text)).toEqual(['{"n":9}']);
  });
});

describe('FileTail — hostile input never throws (G3)', () => {
  it('handles a zero-byte file', async () => {
    const file = join(tmpRoot, 'empty.jsonl');
    await writeFile(file, '');
    const tail = new FileTail(file, { sessionId: SESSION_A });

    const result = await tail.read();
    expect(result.lines).toEqual([]);
    expect(result.bytesRead).toBe(0);
    expect(result.skipped).toBeUndefined();
    expect(tail.offset).toBe(0);
  });

  it('reports a missing file as skipped instead of throwing', async () => {
    const tail = new FileTail(join(tmpRoot, 'does-not-exist.jsonl'), { sessionId: SESSION_A });

    const result = await tail.read();
    expect(result.lines).toEqual([]);
    expect(result.skipped?.reason).toContain('ENOENT');
  });

  it('reports a file that vanishes between listing and reading', async () => {
    const file = join(tmpRoot, 'vanishing.jsonl');
    await writeFile(file, jsonl({ n: 1 }));
    const tail = new FileTail(file, { sessionId: SESSION_A });

    const first = await tail.read();
    expect(first.lines).toHaveLength(1);

    await rm(file);
    const second = await tail.read();
    expect(second.skipped).toBeDefined();
    expect(second.skipped?.path).toBe(file);
    expect(second.lines).toEqual([]);
  });

  it('reports a directory where a file was expected', async () => {
    const path = join(tmpRoot, 'now-a-dir.jsonl');
    await writeFile(path, jsonl({ n: 1 }));
    const tail = new FileTail(path, { sessionId: SESSION_A });
    await tail.read();

    await rm(path);
    await mkdir(path, { recursive: true });

    const result = await tail.read();
    expect(result.lines).toEqual([]);
    expect(result.skipped).toBeDefined();
  });

  it('bounds memory: a line longer than maxPartialBytes is dropped and the tail resyncs at the next newline', async () => {
    const file = join(tmpRoot, 'oversized.jsonl');
    await writeFile(file, 'x'.repeat(200));
    const tail = new FileTail(file, { sessionId: SESSION_A, maxPartialBytes: 16 });

    const first = await tail.read();
    expect(first.lines).toEqual([]);
    expect(first.oversized).toBe(1);
    expect(tail.pendingBytes).toBe(0); // buffer released, not grown

    await appendFile(file, `\n${jsonl({ n: 1 })}`);
    const second = await tail.read();
    expect(second.lines.map((l) => l.text)).toEqual(['{"n":1}']);
  });
});

// ---------------------------------------------------------------------------
// SessionTailer — multi-file
// ---------------------------------------------------------------------------

describe('SessionTailer — multi-file tailing', () => {
  it('tails the main transcript and every subagent transcript with independent offsets', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    const main = join(slugDir, `${SESSION_A}.jsonl`);
    await writeFile(main, jsonl({ src: 'main', n: 1 }));
    const subDir = join(slugDir, SESSION_A, 'subagents');
    await mkdir(subDir, { recursive: true });
    const agent = join(subDir, 'agent-aaa111.jsonl');
    await writeFile(agent, jsonl({ src: 'agent', n: 1 }));

    const tailer = new SessionTailer({ workspacePath: WORKSPACE, projectsRoot: root, env: {} });

    const first = await tailer.poll();
    expect(first.newFiles).toEqual([main, agent]);
    expect(first.lines).toHaveLength(2);
    expect(first.lines.map((l) => l.agentId)).toEqual([null, 'aaa111']);

    // Append to only one of them.
    await appendFile(agent, jsonl({ src: 'agent', n: 2 }));
    const mainOffsetBefore = tailer.offsetOf(main);

    const second = await tailer.poll();
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]?.agentId).toBe('aaa111');
    expect(tailer.offsetOf(main)).toBe(mainOffsetBefore);
  });

  it('picks up a subagent file that appears on a later poll', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    const main = join(slugDir, `${SESSION_A}.jsonl`);
    await writeFile(main, jsonl({ n: 1 }));

    const tailer = new SessionTailer({ workspacePath: WORKSPACE, projectsRoot: root, env: {} });

    const first = await tailer.poll();
    expect(first.newFiles).toEqual([main]);
    expect(tailer.trackedFiles()).toHaveLength(1);

    // The subagent spawns mid-session.
    const subDir = join(slugDir, SESSION_A, 'subagents');
    await mkdir(subDir, { recursive: true });
    const agent = join(subDir, 'agent-late.jsonl');
    await writeFile(agent, jsonl({ src: 'late', n: 1 }));

    const second = await tailer.poll();
    expect(second.newFiles).toEqual([agent]);
    expect(second.lines.map((l) => l.agentId)).toEqual(['late']);
    expect(tailer.trackedFiles()).toHaveLength(2);
  });

  it('picks up a session that appears on a later poll', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ n: 1 }));

    const tailer = new SessionTailer({ workspacePath: WORKSPACE, projectsRoot: root, env: {} });
    await tailer.poll();

    await writeFile(join(slugDir, `${SESSION_B}.jsonl`), jsonl({ n: 1 }));
    const second = await tailer.poll();

    expect(second.newFiles).toEqual([join(slugDir, `${SESSION_B}.jsonl`)]);
    expect(second.lines[0]?.sessionId).toBe(SESSION_B);
  });

  it('honours a session id filter', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    await writeFile(join(slugDir, `${SESSION_A}.jsonl`), jsonl({ n: 1 }));
    await writeFile(join(slugDir, `${SESSION_B}.jsonl`), jsonl({ n: 2 }));

    const tailer = new SessionTailer({
      workspacePath: WORKSPACE,
      projectsRoot: root,
      env: {},
      sessionIds: [SESSION_B],
    });
    const batch = await tailer.poll();

    expect(batch.lines).toHaveLength(1);
    expect(batch.lines[0]?.sessionId).toBe(SESSION_B);
  });

  it('accumulates diagnostics instead of throwing when a tracked file is deleted', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    const main = join(slugDir, `${SESSION_A}.jsonl`);
    await writeFile(main, jsonl({ n: 1 }, { n: 2 }));

    const tailer = new SessionTailer({ workspacePath: WORKSPACE, projectsRoot: root, env: {} });
    await tailer.poll();
    expect(tailer.diagnostics.emittedLines).toBe(2);

    await rm(main);
    const second = await tailer.poll();
    const third = await tailer.poll();

    expect(second.lines).toEqual([]);
    // The refusal is recorded once, not once per poll.
    expect(third.diagnostics.skippedFiles).toHaveLength(1);
    expect(third.diagnostics.skippedFiles[0]?.path).toBe(main);
    expect(third.diagnostics.emittedLines).toBe(2);
  });

  it('counts a truncation reset in diagnostics', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    const main = join(slugDir, `${SESSION_A}.jsonl`);
    await writeFile(main, jsonl({ n: 1 }, { n: 2 }, { n: 3 }));

    const tailer = new SessionTailer({ workspacePath: WORKSPACE, projectsRoot: root, env: {} });
    await tailer.poll();
    await writeFile(main, jsonl({ n: 9 }));
    const batch = await tailer.poll();

    expect(batch.diagnostics.resets).toBe(1);
    expect(batch.lines.map((l) => l.text)).toEqual(['{"n":9}']);
  });

  it('tails exactly the transcripts the committed fixture contains, and reads each to EOF', async () => {
    const layout = await readFixtureLayout();
    const expectedFiles = allTranscriptsOf(layout.sessions);
    expect(expectedFiles.length).toBeGreaterThan(0);

    const tailer = new SessionTailer({
      workspacePath: FIXTURE_WORKSPACE,
      projectsRoot: FIXTURE_ROOT,
      env: {},
    });

    const batch = await tailer.poll();

    // Derived from the directory: every transcript on disk and nothing else.
    // This is what proves tool-results/*.txt and the .meta.json sidecars are
    // not tailed, whatever the next re-harvest adds.
    expect([...batch.newFiles].sort()).toEqual(expectedFiles);
    expect(tailer.trackedFiles().sort()).toEqual(expectedFiles);

    // "End to end", per file: the emitted lines are exactly the complete lines
    // on disk, in order, and the offset landed on EOF.
    for (const file of expectedFiles) {
      const onDisk = await completeLinesOf(file);
      const emitted = batch.lines.filter((l) => l.path === file);
      expect(emitted.map((l) => l.text), file).toEqual(onDisk);
      expect(emitted.map((l) => l.lineNo)).toEqual(onDisk.map((_line, i) => i + 1));
      expect(tailer.offsetOf(file), file).toBe((await stat(file)).size);
    }

    // Nothing was invented or dropped between files.
    const totalOnDisk = (
      await Promise.all(expectedFiles.map(async (f) => (await completeLinesOf(f)).length))
    ).reduce((a, b) => a + b, 0);
    expect(batch.lines).toHaveLength(totalOnDisk);
    expect(batch.diagnostics.emittedLines).toBe(totalOnDisk);
    expect(batch.diagnostics.skippedFiles).toEqual([]);

    // Every emitted line is a complete JSON record.
    for (const line of batch.lines) {
      expect(() => JSON.parse(line.text)).not.toThrow();
    }

    // A second poll on an unchanged tree yields nothing new.
    const second = await tailer.poll();
    expect(second.lines).toEqual([]);
    expect(second.newFiles).toEqual([]);
  });

  it('G1: a full poll of the fixture tree writes nothing', async () => {
    const before = await snapshotTree(FIXTURE_ROOT);

    const tailer = new SessionTailer({
      workspacePath: FIXTURE_WORKSPACE,
      projectsRoot: FIXTURE_ROOT,
      env: {},
    });
    await tailer.poll();
    await tailer.poll();

    const after = await snapshotTree(FIXTURE_ROOT);
    expect(after).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

describe('Debouncer', () => {
  it('coalesces a burst of signals into one emission', () => {
    const time = new ManualTime();
    const flushes: number[] = [];
    const debouncer = new Debouncer({
      delayMs: 50,
      clock: time,
      scheduler: time,
      onFlush: (info) => flushes.push(info.signals),
    });

    for (let i = 0; i < 10; i += 1) {
      debouncer.signal();
      time.advance(5); // faster than the quiet period
    }
    expect(flushes).toEqual([]); // nothing yet: the burst keeps resetting it

    time.advance(50);
    expect(flushes).toEqual([10]);
    expect(debouncer.pendingSignals).toBe(0);
  });

  it('emits again for a second burst', () => {
    const time = new ManualTime();
    const flushes: number[] = [];
    const debouncer = new Debouncer({
      delayMs: 20,
      clock: time,
      scheduler: time,
      onFlush: (info) => flushes.push(info.signals),
    });

    debouncer.signal();
    time.advance(20);
    debouncer.signal();
    debouncer.signal();
    time.advance(20);

    expect(flushes).toEqual([1, 2]);
  });

  it('does not emit before the quiet period elapses', () => {
    const time = new ManualTime();
    let flushed = 0;
    const debouncer = new Debouncer({
      delayMs: 100,
      clock: time,
      scheduler: time,
      onFlush: () => {
        flushed += 1;
      },
    });

    debouncer.signal();
    time.advance(99);
    expect(flushed).toBe(0);
    time.advance(1);
    expect(flushed).toBe(1);
  });

  it('flush() emits immediately and disarms the timer', () => {
    const time = new ManualTime();
    const reasons: string[] = [];
    const debouncer = new Debouncer({
      delayMs: 1000,
      clock: time,
      scheduler: time,
      onFlush: (info) => reasons.push(info.reason),
    });

    debouncer.signal();
    debouncer.signal();
    debouncer.flush();

    expect(reasons).toEqual(['manual']);
    expect(time.pendingTimers).toBe(0);

    time.advance(5000);
    expect(reasons).toEqual(['manual']); // no duplicate emission
  });

  it('flush() with nothing pending is a no-op', () => {
    const time = new ManualTime();
    let flushed = 0;
    const debouncer = new Debouncer({
      delayMs: 10,
      clock: time,
      scheduler: time,
      onFlush: () => {
        flushed += 1;
      },
    });

    debouncer.flush();
    expect(flushed).toBe(0);
  });

  it('cancel() drops pending signals without emitting', () => {
    const time = new ManualTime();
    let flushed = 0;
    const debouncer = new Debouncer({
      delayMs: 10,
      clock: time,
      scheduler: time,
      onFlush: () => {
        flushed += 1;
      },
    });

    debouncer.signal();
    debouncer.cancel();
    time.advance(1000);
    expect(flushed).toBe(0);
  });

  it('maxWaitMs stops a continuous burst from starving the emission', () => {
    const time = new ManualTime();
    const infos: { signals: number; flushedAt: number; reason: string }[] = [];
    const debouncer = new Debouncer({
      delayMs: 50,
      maxWaitMs: 30,
      clock: time,
      scheduler: time,
      onFlush: (info) =>
        infos.push({ signals: info.signals, flushedAt: info.flushedAt, reason: info.reason }),
    });

    debouncer.signal(); // t=0
    time.advance(10);
    debouncer.signal(); // t=10
    time.advance(10);
    debouncer.signal(); // t=20
    time.advance(10); // t=30 -> maxWait reached

    expect(infos).toHaveLength(1);
    expect(infos[0]?.signals).toBe(3);
    expect(infos[0]?.flushedAt).toBe(30);
    expect(infos[0]?.reason).toBe('maxWait');
  });

  it('reports timing metadata for the coalesced burst', () => {
    const time = new ManualTime(1000);
    const infos: { firstSignalAt: number; lastSignalAt: number; flushedAt: number }[] = [];
    const debouncer = new Debouncer({
      delayMs: 25,
      clock: time,
      scheduler: time,
      onFlush: (info) =>
        infos.push({
          firstSignalAt: info.firstSignalAt,
          lastSignalAt: info.lastSignalAt,
          flushedAt: info.flushedAt,
        }),
    });

    debouncer.signal(); // t=1000
    time.advance(5);
    debouncer.signal(); // t=1005
    time.advance(25); // t=1030

    expect(infos).toEqual([{ firstSignalAt: 1000, lastSignalAt: 1005, flushedAt: 1030 }]);
  });

  it('drives exactly one tailer poll per burst', async () => {
    const root = await makeProjectsRoot();
    const slugDir = await makeSlugDir(root);
    const main = join(slugDir, `${SESSION_A}.jsonl`);
    await writeFile(main, jsonl({ n: 1 }));

    const tailer = new SessionTailer({ workspacePath: WORKSPACE, projectsRoot: root, env: {} });
    const time = new ManualTime();
    let polls = 0;
    const pending: Promise<unknown>[] = [];
    const debouncer = new Debouncer({
      delayMs: 30,
      clock: time,
      scheduler: time,
      onFlush: () => {
        polls += 1;
        pending.push(tailer.poll());
      },
    });

    // Five appends arriving as a burst, as a live session produces them.
    for (let i = 0; i < 5; i += 1) {
      await appendFile(main, jsonl({ n: i + 2 }));
      debouncer.signal();
      time.advance(5);
    }
    time.advance(30);
    await Promise.all(pending);

    expect(polls).toBe(1);
    expect(tailer.diagnostics.emittedLines).toBe(6);
  });
});

describe('system clock and scheduler', () => {
  it('expose the same shape the Debouncer consumes', () => {
    expect(typeof systemClock.now()).toBe('number');
    const handle = systemScheduler.setTimer(() => undefined, 10_000);
    expect(() => systemScheduler.clearTimer(handle)).not.toThrow();
  });
});

describe('ManualTime', () => {
  it('advances the clock and fires due timers in order', () => {
    const time = new ManualTime(100);
    const fired: string[] = [];

    time.setTimer(() => fired.push('b'), 20);
    time.setTimer(() => fired.push('a'), 10);
    expect(time.pendingTimers).toBe(2);

    time.advance(15);
    expect(fired).toEqual(['a']);
    expect(time.now()).toBe(115);

    time.advance(10);
    expect(fired).toEqual(['a', 'b']);
    expect(time.pendingTimers).toBe(0);
    expect(time.now()).toBe(125);
  });

  it('clearTimer prevents a pending timer from firing', () => {
    const time = new ManualTime();
    let fired = false;
    const handle = time.setTimer(() => {
      fired = true;
    }, 10);

    time.clearTimer(handle);
    time.advance(100);
    expect(fired).toBe(false);
  });
});
