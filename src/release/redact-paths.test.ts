/**
 * `scripts/redact-paths.mjs` — PLAN.md Phase 5.5, DoD 5.5.4.
 *
 * The DoD names four properties and this file asserts all four:
 *
 *   1. developer absolute paths become `<HOME>`-relative;
 *   2. machine name and username become placeholders;
 *   3. deterministic and **idempotent** — a second run is a no-op;
 *   4. **join keys and tool ordinals untouched** — the `tool_use` count and
 *      every `toolUseId` survive byte-identical.
 *
 * (4) is the one that matters. The corpus this script exists to clean is the
 * one `AUDIT-2026-08-27` §7.2 measured at 537 `tool_use` blocks against 537
 * tree nodes. A redaction that moved one id would delete the measurement it
 * was preserving, and it would do it silently.
 *
 * The script is driven through its exported functions rather than through a
 * subprocess: a `spawnSync` here would be one more shell-out hook to budget
 * (rule 14) for no extra coverage — the CLI is four lines over the same
 * `redactDirectory`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'redact-paths.mjs');

interface RedactReport {
  dir: string;
  user: string;
  host: string;
  files: number;
  skipped: number;
  changed: number;
  hits: Record<string, number>;
  changedFiles: string[];
}

interface RedactModule {
  HOME_TOKEN: string;
  USER_TOKEN: string;
  HOST_TOKEN: string;
  buildRules: (user: string, host: string) => { id: string }[];
  redactText: (text: string, rules: unknown) => { text: string; hits: Record<string, number> };
  redactDirectory: (
    dir: string,
    options?: { user?: string; host?: string; dryRun?: boolean },
  ) => RedactReport;
}

let mod: RedactModule;

const USER = 'Testuser';
const HOST = 'TESTBOX';

/** One transcript line with every shape the redactor has to reach. */
function transcriptLine(index: number): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `uuid-${String(index)}`,
    parentUuid: index === 0 ? null : `uuid-${String(index - 1)}`,
    sessionId: '41194183-a387-4072-bb84-bc472bf7b5e9',
    cwd: `C:\\Users\\${USER}\\projects\\agent-deck`,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `toolu_${String(index).padStart(4, '0')}`,
          name: 'Bash',
          input: {
            command: `cd "c:/Users/${USER}/projects/x" && cat /home/${USER}/y && ls /mnt/c/Users/${USER}/z`,
            description: `run on ${HOST} as ${USER}`,
          },
        },
      ],
    },
  });
}

/** Every `tool_use` id in a transcript, in order. The ordinals under test. */
function toolIds(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const entry = JSON.parse(line) as { message?: { content?: { type?: string; id?: string }[] } };
    for (const block of entry.message?.content ?? []) {
      if (block.type === 'tool_use' && typeof block.id === 'string') out.push(block.id);
    }
  }
  return out;
}

function stageCorpus(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-redact-'));
  const slug = 'c--Users-Testuser-projects-agent-deck';
  const dir = path.join(root, 'projects', slug, '41194183-a387-4072-bb84-bc472bf7b5e9', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: 12 }, (_, i) => transcriptLine(i)).join('\n');
  fs.writeFileSync(path.join(root, 'projects', slug, '41194183-a387-4072-bb84-bc472bf7b5e9.jsonl'), `${lines}\n`);
  fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), `${lines}\n`);
  fs.writeFileSync(
    path.join(dir, 'agent-a1.meta.json'),
    JSON.stringify({
      agentType: 'phase-implementer',
      worktreePath: `C:\\Users\\${USER}\\projects\\agent-deck\\.claude\\worktrees\\agent-a1`,
      toolUseId: 'toolu_0003',
      spawnDepth: 1,
    }),
  );
  // A non-text file, to prove the walker skips rather than corrupts.
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
  return root;
}

beforeAll(async () => {
  mod = (await import(/* @vite-ignore */ pathToFileURL(SCRIPT).href)) as unknown as RedactModule;
}, 120_000);

describe('scripts/redact-paths.mjs (DoD 5.5.4)', () => {
  it('has no shebang — the recorded vite/CRLF collection trap', () => {
    // `hashbangRE` is `/^#!.*\n/` and `.` does not match `\r`, so a shebang
    // makes a file uncollectable in a CRLF checkout and fine in an LF one.
    // `scripts/privacy-sweep.mjs` paid for this once; this asserts by BYTES,
    // not by importing, so a broken file cannot make its own guard pass.
    const head = fs.readFileSync(SCRIPT).subarray(0, 2).toString('latin1');
    expect(head).not.toBe('#!');
  });

  it('replaces every home shape with <HOME>, in raw and JSON-escaped form', () => {
    const rules = mod.buildRules(USER, HOST);
    const sample =
      `C:\\Users\\${USER}\\a ` +
      `C:\\\\Users\\\\${USER}\\\\b ` +
      `c:/Users/${USER}/c ` +
      `/c/Users/${USER}/d ` +
      `/mnt/c/Users/${USER}/e ` +
      `/home/${USER}/f`;
    const { text } = mod.redactText(sample, rules);
    expect(text).not.toContain(USER);
    // Six paths, six tokens, and nothing left that looks like a home.
    expect(text.split(mod.HOME_TOKEN)).toHaveLength(7);
  });

  it('a bare username and the machine name become placeholders', () => {
    const rules = mod.buildRules(USER, HOST);
    const { text } = mod.redactText(`user=${USER} host=${HOST}`, rules);
    expect(text).toBe(`user=${mod.USER_TOKEN} host=${mod.HOST_TOKEN}`);
  });

  it('is word-bounded: a longer name containing the username survives', () => {
    const rules = mod.buildRules(USER, HOST);
    const { text } = mod.redactText(`${USER}son and ${USER}`, rules);
    expect(text).toBe(`${USER}son and ${mod.USER_TOKEN}`);
  });

  it('rewrites a staged corpus, and the SECOND run is a no-op (idempotent)', () => {
    const root = stageCorpus();
    try {
      const first = mod.redactDirectory(root, { user: USER, host: HOST });
      expect(first.changed).toBeGreaterThan(0);
      expect(first.skipped).toBe(1); // blob.bin
      const afterFirst = new Map(
        first.changedFiles.map((rel) => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]),
      );

      const second = mod.redactDirectory(root, { user: USER, host: HOST });
      expect(second.changed).toBe(0);
      expect(second.hits).toEqual({});
      for (const [rel, text] of afterFirst) {
        expect(fs.readFileSync(path.join(root, rel), 'utf8')).toBe(text);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves join keys and tool ordinals byte-identical (the DoD clause)', () => {
    const root = stageCorpus();
    try {
      const main = path.join(
        root,
        'projects',
        'c--Users-Testuser-projects-agent-deck',
        '41194183-a387-4072-bb84-bc472bf7b5e9.jsonl',
      );
      const before = fs.readFileSync(main, 'utf8');
      const idsBefore = toolIds(before);
      expect(idsBefore).toHaveLength(12);

      mod.redactDirectory(root, { user: USER, host: HOST });

      const after = fs.readFileSync(main, 'utf8');
      // Changed, or this test is vacuous.
      expect(after).not.toBe(before);
      // Same ids, same count, same ORDER.
      expect(toolIds(after)).toEqual(idsBefore);
      // Still valid JSONL, line for line.
      expect(after.split('\n').filter((l) => l.trim() !== '')).toHaveLength(12);
      // The sidecar's join key survives too — it is what makes attribution a
      // primary-key join rather than an inference.
      const meta = JSON.parse(
        fs.readFileSync(
          path.join(
            root,
            'projects',
            'c--Users-Testuser-projects-agent-deck',
            '41194183-a387-4072-bb84-bc472bf7b5e9',
            'subagents',
            'agent-a1.meta.json',
          ),
          'utf8',
        ),
      ) as { toolUseId: string; worktreePath: string };
      expect(meta.toolUseId).toBe('toolu_0003');
      expect(meta.worktreePath.startsWith(mod.HOME_TOKEN)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves the project slug alone, deliberately', () => {
    // The slug uses `-` as its separator so no home pattern matches it, and it
    // IS a join key: `projectSlug` is derived from it and `src/opencode/slug.ts`
    // pins the two engines' agreement on it. This is why the corpus still needs
    // an ALLOW rule after redaction (DoD 5.5.5), and the script's own header
    // says so. Asserted rather than assumed, because "the redactor missed it"
    // and "the redactor was told not to" look identical in a diff.
    const rules = mod.buildRules(USER, HOST);
    const slug = 'c--Users-Testuser-projects-agent-deck';
    const { text } = mod.redactText(slug, rules);
    expect(text).toBe(slug);
  });

  it('--dry-run reports without writing', () => {
    const root = stageCorpus();
    try {
      const main = path.join(
        root,
        'projects',
        'c--Users-Testuser-projects-agent-deck',
        '41194183-a387-4072-bb84-bc472bf7b5e9.jsonl',
      );
      const before = fs.readFileSync(main, 'utf8');
      const report = mod.redactDirectory(root, { user: USER, host: HOST, dryRun: true });
      expect(report.changed).toBeGreaterThan(0);
      expect(fs.readFileSync(main, 'utf8')).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
