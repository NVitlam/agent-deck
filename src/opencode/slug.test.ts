/**
 * `src/opencode/slug.ts` — PLAN.md Phase 4 `Amendment 2026-08-27` A1.
 *
 * The pin is a FIXTURE pin, not a memory pin: both sides of the load-bearing
 * assertion are read off disk inside the test, one out of `opencode.db` and one
 * out of the Claude Code projects directory. Neither is written as a literal
 * here, so a re-harvest that changed either side fails instead of quietly
 * agreeing with a string somebody typed.
 *
 * Nothing here writes anything. The corpora are opened read-only through
 * `db.ts`, which is the only module that opens them at all.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSlug } from '../model/correlate.js';
import { slugifyWorkspace } from '../parser/tailer.js';
import { readProjects } from './db.js';
import { slugFromWorktree } from './slug.js';
import { FIXTURES_DIR, corpusDbPath, listCorpora } from './synthetic.js';

interface SlugCase {
  readonly id: string;
  readonly form: string;
  readonly workspacePath: string;
  readonly expectedSlug: string;
  readonly witness: string;
  readonly note: string;
}

/** `fixtures/synthetic-path-matrix/slug-cases.json`, read at test time. */
function slugCases(): SlugCase[] {
  const path = join(FIXTURES_DIR, 'synthetic-path-matrix', 'slug-cases.json');
  return JSON.parse(readFileSync(path, 'utf8')) as SlugCase[];
}

/** The one CC slug directory this repo has captured, read at test time. */
function ccSlugDirectories(): string[] {
  return readdirSync(join(FIXTURES_DIR, 'cc-2.1.246', 'projects'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** Every `project.worktree` in a committed corpus, through the accessor. */
function worktreesOf(corpus: string): string[] {
  const read = readProjects(corpusDbPath(corpus));
  if (!read.ok) throw new Error(`${corpus}: ${read.health.code} ${read.health.message}`);
  return read.value.map((project) => project.worktree);
}

// ---------------------------------------------------------------------------
// The fixture pin
// ---------------------------------------------------------------------------

describe('the OpenCode project key is the Claude Code slug of the same workspace', () => {
  it('has both corpora and a CC projects directory to compare (vacuity control)', () => {
    // Without this, every assertion below could pass over an empty list.
    expect(listCorpora().length).toBeGreaterThan(0);
    expect(ccSlugDirectories().length).toBeGreaterThan(0);
    for (const corpus of listCorpora()) expect(worktreesOf(corpus).length).toBeGreaterThan(0);
  });

  it('slugFromWorktree(project.worktree) === the CC slug directory name', () => {
    // Both sides read off disk. The CC capture holds exactly one workspace, so
    // one directory name; if a future capture holds more, this asserts the
    // OpenCode key is one OF them rather than silently picking the first.
    const ccSlugs = ccSlugDirectories();
    for (const corpus of listCorpora()) {
      for (const worktree of worktreesOf(corpus)) {
        expect(ccSlugs, `${corpus} ${worktree}`).toContain(slugFromWorktree(worktree));
      }
    }
  });

  it('differs from the raw CC encoding by exactly the drive letter, on the fixture', () => {
    // The delta, measured on the real pair rather than on a constructed path:
    // `slugifyWorkspace` keeps the upper-case drive, this keeps everything else.
    for (const corpus of listCorpora()) {
      for (const worktree of worktreesOf(corpus)) {
        const raw = slugifyWorkspace(worktree);
        const key = slugFromWorktree(worktree);
        expect(key).toHaveLength(raw.length);
        const differing = [...raw].map((_, i) => i).filter((i) => raw[i] !== key[i]);
        expect(differing, `${corpus} ${worktree}`).toEqual([0]);
        expect(key[0]).toBe(raw[0]?.toLowerCase());
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The named cases A1 requires
// ---------------------------------------------------------------------------

describe('the encoding rule, case by case', () => {
  it('Windows drive letter: the drive is lower-cased and nothing else is', () => {
    expect(slugFromWorktree('C:\\Users\\dev\\projects\\projects')).toBe(
      'c--Users-dev-projects-projects',
    );
    // Already lower-case: unchanged, and the same answer either way.
    expect(slugFromWorktree('c:\\Users\\dev\\projects\\projects')).toBe(
      'c--Users-dev-projects-projects',
    );
  });

  it('backslashes become dashes', () => {
    expect(slugFromWorktree('D:\\a\\b\\c')).toBe('d--a-b-c');
  });

  it('forward slashes become dashes, and slug the same as backslashes', () => {
    expect(slugFromWorktree('D:/a/b/c')).toBe('d--a-b-c');
    expect(slugFromWorktree('D:/a/b/c')).toBe(slugFromWorktree('D:\\a\\b\\c'));
  });

  it('a trailing separator is stripped before encoding, in both spellings', () => {
    expect(slugFromWorktree('C:\\Users\\dev\\ws\\')).toBe('c--Users-dev-ws');
    expect(slugFromWorktree('C:/Users/dev/ws/')).toBe('c--Users-dev-ws');
    expect(slugFromWorktree('C:/Users/dev/ws///')).toBe('c--Users-dev-ws');
  });

  it('mixed case survives everywhere except the drive letter', () => {
    expect(slugFromWorktree('C:/Users/dev/MiXeD/CaSe-Dir')).toBe(
      'c--Users-dev-MiXeD-CaSe-Dir',
    );
    // A POSIX path has no drive prefix, so nothing at all is lower-cased.
    expect(slugFromWorktree('/home/Probe/MiXeD')).toBe('-home-Probe-MiXeD');
    // `/mnt/C` is a directory named `C`, not a drive: it keeps its case.
    expect(slugFromWorktree('/mnt/C/Users/dev/ws')).toBe('-mnt-C-Users-dev-ws');
  });

  it('a UNC path has no drive prefix and is untouched by the delta', () => {
    expect(slugFromWorktree('\\\\server\\share\\ws')).toBe('--server-share-ws');
    expect(slugFromWorktree('\\\\server\\share\\ws')).toBe(slugifyWorkspace('\\\\server\\share\\ws'));
  });
});

// ---------------------------------------------------------------------------
// "The same rule" — over the whole committed path matrix
// ---------------------------------------------------------------------------

describe('slugFromWorktree is slugifyWorkspace plus the drive letter', () => {
  it('agrees with slugifyWorkspace case-insensitively on every committed case', () => {
    const cases = slugCases();
    expect(cases.length).toBeGreaterThan(0);
    for (const testCase of cases) {
      expect(
        normalizeSlug(slugFromWorktree(testCase.workspacePath)),
        `${testCase.id} ${testCase.workspacePath}`,
      ).toBe(normalizeSlug(slugifyWorkspace(testCase.workspacePath)));
      // And `normalizeSlug` really is a lower-case, so the assertion above is
      // the `.toLowerCase()` one the package brief names.
      expect(normalizeSlug(slugFromWorktree(testCase.workspacePath))).toBe(
        slugFromWorktree(testCase.workspacePath).toLowerCase(),
      );
    }
  });

  it('differs from slugifyWorkspace at index 0 or not at all, on every case', () => {
    for (const testCase of slugCases()) {
      const raw = slugifyWorkspace(testCase.workspacePath);
      const key = slugFromWorktree(testCase.workspacePath);
      const differing = [...raw].map((_, i) => i).filter((i) => raw[i] !== key[i]);
      expect(differing.length, testCase.id).toBeLessThanOrEqual(1);
      for (const index of differing) expect(index, testCase.id).toBe(0);
      // The committed expectation is `slugifyWorkspace`'s, so this also pins
      // that the CC rule itself has not moved underneath us.
      expect(raw, testCase.id).toBe(testCase.expectedSlug);
    }
  });

  it('leaves the non-drive cases byte-identical to slugifyWorkspace', () => {
    const untouched = slugCases().filter((c) => !/^[A-Za-z]:/.test(c.workspacePath));
    expect(untouched.length).toBeGreaterThan(0);
    for (const testCase of untouched) {
      expect(slugFromWorktree(testCase.workspacePath), testCase.id).toBe(testCase.expectedSlug);
    }
  });
});
