/**
 * The one Insights export writer — v0.9.0 DoD 9.47.
 *
 * `src/insights-save.ts` holds the only `workspace.fs.writeFile` in `src/`,
 * beside the G1 refusal of any path inside an observed engine's directory.
 * The arrangement is the G7 amendment's for the stats store: ONE writer, and
 * its readers pinned. What is held here:
 *
 *  1. No other production module in `src/` names `workspace.fs.writeFile`,
 *     and `src/extension.ts` is the only module that imports this one.
 *  2. The roots it refuses are resolved from the environment the engines
 *     resolve them from — `CLAUDE_PROJECTS_ROOT`, `CODEX_HOME`, the OpenCode
 *     data override — plus `~/.claude` itself, always.
 *  3. A refused path writes NOTHING and says why; a failed write says so and
 *     logs; a good path writes the text as UTF-8.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import * as vscode from 'vscode';

import { mock, resetVscodeMock } from '../test/vscode-mock.js';
import { OPENCODE_DATA_ROOT_ENV } from './opencode/index.js';
import { observedRoots, realPathOf, refusedExportPath, writeExportFile } from './insights-save.js';

/** Every production `.ts` under `src/`, relative, with its text. */
function productionSources(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.testkit.ts') &&
        !entry.name.endsWith('testdata.ts')
      ) {
        out.push([full.replace(/\\/g, '/'), readFileSync(full, 'utf8')]);
      }
    }
  };
  walk(resolve('src'));
  return out;
}

describe('ONE writer, and its one reader', () => {
  it('no other production module in src/ names workspace.fs.writeFile', () => {
    const sources = productionSources();
    expect(sources.length).toBeGreaterThan(50);
    const writers = sources.filter(([, text]) => text.includes('workspace.fs.writeFile')).map(([file]) => file);
    expect(writers.map((file) => file.slice(file.indexOf('src/')))).toStrictEqual(['src/insights-save.ts']);
  });

  it('src/extension.ts is the only module that imports it', () => {
    const importers = productionSources()
      .filter(([, text]) => /from '\.\/insights-save\.js'|from '\.\.\/insights-save\.js'/u.test(text))
      .map(([file]) => file.slice(file.indexOf('src/')));
    expect(importers).toStrictEqual(['src/extension.ts']);
  });
});

describe('the observed roots', () => {
  it('are ~/.claude and the three engines’ roots, each from its own override', () => {
    const env = {
      CLAUDE_PROJECTS_ROOT: 'C:/elsewhere/projects',
      CODEX_HOME: 'C:/elsewhere/codex',
      [OPENCODE_DATA_ROOT_ENV]: 'C:/elsewhere/opencode',
    };
    expect(observedRoots(env)).toStrictEqual([
      join(homedir(), '.claude'),
      resolve('C:/elsewhere/projects'),
      'C:/elsewhere/codex',
      'C:/elsewhere/opencode',
    ]);
  });

  it('with no override, each falls back to its home location — and ~/.claude is never dropped', () => {
    const roots = observedRoots({});
    expect(roots[0]).toBe(join(homedir(), '.claude'));
    expect(roots[1]).toBe(join(homedir(), '.claude', 'projects'));
    expect(roots).toHaveLength(4);
  });
});

describe('through a LINK — verifier round 9.48, W5', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'adinsave-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('a junction that leads into an observed root is that root: refused', () => {
    const real = join(scratch, 'projects');
    mkdirSync(real);
    const link = join(scratch, 'innocent-looking');
    // A directory junction: no privilege needed on Windows; a symlink elsewhere.
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    const env = { CLAUDE_PROJECTS_ROOT: real };
    const target = join(link, 'session', 'report.html');
    expect(realPathOf(target).toLowerCase()).toBe(join(real, 'session', 'report.html').toLowerCase());
    expect(refusedExportPath(target, env)).toBe(resolve(real));
    // The control: a plain sibling that leads nowhere near it is not refused.
    const sibling = join(scratch, 'exports');
    mkdirSync(sibling);
    expect(refusedExportPath(join(sibling, 'report.html'), env)).toBeNull();
  });

  it('realPathOf keeps the part that does not exist yet, under the part that does', () => {
    expect(realPathOf(join(scratch, 'not', 'yet', 'here.md')).toLowerCase()).toBe(
      join(realPathOf(scratch), 'not', 'yet', 'here.md').toLowerCase(),
    );
  });
});

describe('writeExportFile', () => {
  beforeEach(() => resetVscodeMock());

  it('writes the text as UTF-8 to a path outside every observed root', async () => {
    const lines: string[] = [];
    const uri = vscode.Uri.file('C:/exports/report — é.md');
    expect(await writeExportFile(uri, 'text — é', (line) => lines.push(line))).toBe(true);
    expect(mock.writtenFiles.get('C:/exports/report — é.md')).toBe('text — é');
    expect(lines).toStrictEqual([]);
  });

  it('REFUSES a path inside ~/.claude: nothing written, and the reason said', async () => {
    const target = join(homedir(), '.claude', 'projects', 'x', 'report.html');
    expect(refusedExportPath(target)).toBe(join(homedir(), '.claude'));
    expect(await writeExportFile(vscode.Uri.file(target), 'x', () => undefined)).toBe(false);
    expect(mock.writtenFiles.size).toBe(0);
    expect(mock.informationMessages).toStrictEqual([
      `Agent Deck: ${target} is inside ${join(homedir(), '.claude')}, which Agent Deck only reads; nothing was written.`,
    ]);
  });
});
