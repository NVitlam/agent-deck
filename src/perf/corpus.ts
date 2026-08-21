/**
 * Where the perf harness gets its session from, and how it gets a writable
 * copy of it.
 *
 * TWO ORIGINS, ONE CODE PATH. PLAN's Phase 4 answers "where does the perf
 * DoD's >=10k-line session come from?" with "a live extended R2 run, harvested
 * -- not synthesised". That harvest is a human action and had not happened
 * when this harness was written. So the harness is corpus-agnostic: pointing
 * it at the harvest is setting one environment variable, never an edit here.
 *
 *   AGENT_DECK_PERF_ROOT=<a projects root>   -> origin 'supplied'
 *   CLAUDE_PROJECTS_ROOT=<a projects root>   -> origin 'supplied'
 *   neither set                              -> origin 'synthetic'
 *
 * `CLAUDE_PROJECTS_ROOT` is read second rather than first, and the reason is
 * not style: that variable is set repo-wide for fixture replay (the spike
 * audit runs with it pointed at `fixtures/cc-2.1.234/projects`, whose largest
 * session is 22 lines). A harness that read it first would silently measure a
 * 22-line session and report a number that looks wonderful and means nothing.
 * `AGENT_DECK_PERF_ROOT` therefore wins, and either way the >=10k-line
 * precondition is ASSERTED rather than assumed -- a corpus too small for the
 * DoD fails loudly instead of quietly answering the wrong question.
 *
 * `resolveProjectsRoot()`'s home fallback is deliberately NOT used. Unset, it
 * resolves to the real `~/.claude/projects`; this module appends bytes to the
 * transcript it measures, and appending into `~/.claude` would break G1 on the
 * one rule this product's trust rests on. The fallback here is the synthetic
 * generator in a temp directory, never the user's own sessions.
 *
 * WRITES: this module writes only under the `workDir` its caller supplies, and
 * every caller supplies an OS temp directory. A supplied corpus is COPIED
 * before a byte is appended to it, so `fixtures/` and `~/.claude` alike are
 * read-only to the harness.
 */

import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { slugifyWorkspace } from '../parser/tailer.js';

const execFileAsync = promisify(execFile);

/** The DoD's number. A corpus below this cannot answer the DoD's question. */
export const MIN_SESSION_LINES = 10_000;

/** Perf-specific override; wins over `CLAUDE_PROJECTS_ROOT`. */
export const PERF_ROOT_ENV = 'AGENT_DECK_PERF_ROOT';
/** The repo-wide projects-root override, honoured as a fallback. */
export const PROJECTS_ROOT_ENV = 'CLAUDE_PROJECTS_ROOT';

/** Resolved against the process cwd, which vitest sets to the repo root. */
const GENERATOR = resolve('fixtures/synthetic-perf/build-corpus.mjs');

export interface PerfCorpus {
  /**
   * `'synthetic'` means the numbers are calibration, NOT the DoD's harvest.
   * Anything reporting a measurement must carry this value with it.
   */
  origin: 'synthetic' | 'supplied';
  /** Where the corpus came from before it was staged. */
  sourceRoot: string;
  /** The staged, writable projects root. Everything else points inside it. */
  projectsRoot: string;
  slug: string;
  slugDir: string;
  /** Absolute workspace path, read from the transcript's own `cwd`. */
  workspacePath: string;
  sessionId: string;
  mainTranscript: string;
  /** Lines in the main transcript as staged, before any append. */
  mainLines: number;
  /** Bytes in the main transcript as staged. */
  mainBytes: number;
  /** `<workDir>/appends.jsonl` when the generator wrote one. */
  appendsPath?: string;
  /**
   * The main transcript's text as staged.
   *
   * Carried on the corpus rather than re-read by the caller: resolving a
   * corpus already reads every candidate transcript once to find the largest,
   * and on a 17 MB session each extra read costs about 300 ms of suite time
   * for a string we are holding anyway.
   */
  mainText: string;
}

export interface OpenCorpusOptions {
  /** Directory the corpus is staged into. Must be outside the repo tree. */
  workDir: string;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Forwarded to the generator; ignored for a supplied corpus. */
  lines?: number;
  subagents?: number;
  seed?: number;
}

/** Make a temp directory for one harness run. Caller disposes it. */
export async function makeWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-deck-perf-'));
}

export async function removeWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Run `fixtures/synthetic-perf/build-corpus.mjs` as a child process.
 *
 * A child process rather than an import, because the generator is an `.mjs`
 * under `fixtures/` -- outside both tsconfig projects and the eslint scope, by
 * the same rule that puts `build-corpus.mjs` there for the hook fuzz corpus.
 * Spawning it means the harness exercises the exact command the README tells a
 * human to run, instead of a second entry point that could drift from it.
 */
export async function generateSyntheticCorpus(
  outDir: string,
  options: { lines?: number; subagents?: number; seed?: number } = {},
): Promise<{ projectsRoot: string; mainTranscript: string; mainLines: number }> {
  await mkdir(outDir, { recursive: true });
  const args = [GENERATOR, '--out', outDir];
  if (options.lines !== undefined) args.push('--lines', String(options.lines));
  if (options.subagents !== undefined) args.push('--subagents', String(options.subagents));
  if (options.seed !== undefined) args.push('--seed', String(options.seed));
  const { stdout } = await execFileAsync(process.execPath, args, {
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as {
    projectsRoot: string;
    mainTranscript: string;
    mainLines: number;
  };
  return parsed;
}

/**
 * Stage a corpus into `workDir` and describe the largest session in it.
 *
 * The staged copy is what gets appended to. The source is never written.
 */
export async function openPerfCorpus(options: OpenCorpusOptions): Promise<PerfCorpus> {
  const env = options.env ?? process.env;
  const supplied = suppliedRoot(env);

  let projectsRoot: string;
  let origin: PerfCorpus['origin'];
  let sourceRoot: string;
  let appendsPath: string | undefined;

  if (supplied === undefined) {
    const built = await generateSyntheticCorpus(options.workDir, {
      ...(options.lines === undefined ? {} : { lines: options.lines }),
      ...(options.subagents === undefined ? {} : { subagents: options.subagents }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    });
    projectsRoot = built.projectsRoot;
    origin = 'synthetic';
    sourceRoot = GENERATOR;
    appendsPath = join(options.workDir, 'appends.jsonl');
  } else {
    const info = await stat(supplied).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) {
      throw new Error(
        `${PERF_ROOT_ENV}/${PROJECTS_ROOT_ENV} names ${supplied}, which is not a readable directory`,
      );
    }
    projectsRoot = join(options.workDir, 'projects');
    await cp(supplied, projectsRoot, { recursive: true });
    origin = 'supplied';
    sourceRoot = supplied;
  }

  const largest = await findLargestSession(projectsRoot);
  const workspacePath = workspaceOf(largest.text, largest.mainTranscript);

  // The slug directory on disk must be the slug of the workspace the
  // transcripts name, or `discoverSessions` will not find this session at all
  // and the harness would measure a tree that is silently empty. Compared
  // case-insensitively: the Windows drive letter's case varies between CC
  // versions (`c--Users-...` and `C--Users-...` both occur in real data).
  const expected = slugifyWorkspace(workspacePath);
  if (expected.toLowerCase() !== largest.slug.toLowerCase()) {
    throw new Error(
      `corpus slug directory '${largest.slug}' is not the slug of the transcript's own cwd ` +
        `'${workspacePath}' (which slugs to '${expected}'); discovery would find nothing`,
    );
  }

  const result: PerfCorpus = {
    origin,
    sourceRoot,
    projectsRoot,
    slug: largest.slug,
    slugDir: largest.slugDir,
    workspacePath,
    sessionId: largest.sessionId,
    mainTranscript: largest.mainTranscript,
    mainLines: largest.lines,
    mainBytes: largest.bytes,
    mainText: largest.text,
  };
  if (appendsPath !== undefined) result.appendsPath = appendsPath;
  return result;
}

function suppliedRoot(env: Record<string, string | undefined>): string | undefined {
  for (const name of [PERF_ROOT_ENV, PROJECTS_ROOT_ENV]) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') return resolve(value.trim());
  }
  return undefined;
}

interface FoundSession {
  slug: string;
  slugDir: string;
  sessionId: string;
  mainTranscript: string;
  lines: number;
  bytes: number;
  text: string;
}

/**
 * The session with the most lines anywhere under a projects root.
 *
 * File-first, the same rule `discoverSessions` is built on: a session is a
 * `<sessionId>.jsonl` FILE. Enumerating directories would mistake the sibling
 * `<slug>/memory/` directory, present in every live tree, for a session.
 *
 * "The largest" rather than "the one named X": a harvested corpus's session id
 * is not knowable in advance, and hard-coding one would make dropping the
 * harvest in a code change rather than a configuration change.
 */
async function findLargestSession(projectsRoot: string): Promise<FoundSession> {
  const slugs = (await readdir(projectsRoot, { withFileTypes: true })).filter((e) =>
    e.isDirectory(),
  );
  let best: FoundSession | undefined;

  for (const slugEntry of slugs) {
    const slugDir = join(projectsRoot, slugEntry.name);
    const files = (await readdir(slugDir, { withFileTypes: true })).filter(
      (e) => e.isFile() && e.name.toLowerCase().endsWith('.jsonl'),
    );
    for (const file of files) {
      const path = join(slugDir, file.name);
      const text = await readFile(path, 'utf8');
      const { lines, bytes } = countLines(text);
      if (best !== undefined && lines <= best.lines) continue;
      best = {
        slug: slugEntry.name,
        slugDir,
        sessionId: basename(file.name, '.jsonl'),
        mainTranscript: path,
        lines,
        bytes,
        text,
      };
    }
  }

  if (best === undefined) {
    throw new Error(`no <sessionId>.jsonl transcripts found under ${projectsRoot}`);
  }
  return best;
}

/** Non-empty lines, counted the way the tailer counts them (blank lines skipped). */
function countLines(text: string): { lines: number; bytes: number } {
  let lines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() !== '') lines += 1;
  }
  return { lines, bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * The workspace a transcript was captured in, read from its own `cwd`.
 *
 * Derived rather than configured, so a harvest taken on another machine needs
 * no edit here -- the same trick `webview/fixture-render.test.ts` uses.
 */
function workspaceOf(text: string, mainTranscript: string): string {
  const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text);
  const raw = match?.[1];
  if (raw === undefined) {
    throw new Error(`no "cwd" field anywhere in ${mainTranscript}; cannot derive the workspace`);
  }
  const decoded = JSON.parse(`"${raw}"`) as string;
  if (decoded === '') throw new Error(`empty "cwd" in ${mainTranscript}`);
  return decoded;
}
