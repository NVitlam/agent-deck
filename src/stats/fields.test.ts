/**
 * v0.7.0 Phase 1, DoD 1.5 and 1.7 — `filePath`, `inputHash` and `ordinal` on
 * every tool node of every corpus, all three engines, through the PRODUCTION
 * path.
 *
 * ## A deliberate consolidation, recorded rather than done quietly
 *
 * DoD 1.5 names `opencode/parse.test.ts` and `codex/parse.test.ts` as the two
 * places these assertions go, and both of those files gained their own (the G4
 * extension of DoD 1.7 lives there, beside the reasoning needles it reuses).
 * What is HERE is the third engine and the cross-engine table, in one file,
 * driven by `graftSession` / `readOpenCodeEngine` / `readCodexEngine` rather
 * than by a parse function.
 *
 * That is strictly more than 1.5 asks for: a parse-level test proves the parser
 * sets a field, and this proves the field survives the grafter, the tree and the
 * node the webview is handed. The recorded lesson behind the difference is D4 —
 * three green component tests over a prop that no production caller ever passed.
 *
 * ## The absences are asserted, not left out
 *
 * Half of what Phase 0 measured is where a field CANNOT exist: `filePath` on
 * Codex, and a file argument on any search or shell tool. An absence nobody
 * asserts is indistinguishable from an implementation nobody finished, so each
 * one has a test that names the measurement behind it.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { isToolNode, type SessionState, type ToolNode } from '../model/events.js';
import { walk } from '../model/graft.js';
import { classOf, FILE_CLASSES, fileKeyOf, type ToolEngine } from './toolclass.js';

import {
  CORPUS_READ_BUDGET_MS,
  readCcSessions,
  readCodexSessions,
  readOpenCodeSessions,
  warmCorpus,
} from './corpus.testkit.js';

// The ONE cold read of all three corpora, paid here where it has a budget
// rather than inside whichever test happens to call first. See the hook's
// header in corpus.testkit.ts: the tests keep vitest's 5 s default and now do
// only their own work.
beforeAll(warmCorpus, CORPUS_READ_BUDGET_MS);

function toolsOf(states: readonly SessionState[]): ToolNode[] {
  const out: ToolNode[] = [];
  for (const state of states) {
    walk(state.root, (node) => {
      if (isToolNode(node)) out.push(node);
    });
  }
  return out;
}

const ENGINES = [
  { name: 'cc' as ToolEngine, read: readCcSessions },
  { name: 'opencode' as ToolEngine, read: readOpenCodeSessions },
  { name: 'codex' as ToolEngine, read: readCodexSessions },
];

describe.each(ENGINES)('DoD 1.5 — every tool node of $name carries the join fields', ({ name, read }) => {
  it('sets inputHash on every node, as 64 lowercase hex', async () => {
    const tools = toolsOf(await read());
    // NON-VACUITY, first: an engine whose sweep found no tools would satisfy
    // every loop below.
    expect(tools.length, `${name}: no tool nodes at all`).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.inputHash, `${name}/${tool.id}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('numbers ordinals densely from 0 within each agent', async () => {
    for (const state of await read()) {
      walk(state.root, (node) => {
        if (isToolNode(node)) return;
        const ordinals = node.children.filter(isToolNode).map((t) => t.ordinal);
        expect(ordinals, `${name}/${node.id}`).toStrictEqual(ordinals.map((_, i) => i));
      });
    }
  });

  it('never gives two calls in one agent the same ordinal', async () => {
    for (const state of await read()) {
      walk(state.root, (node) => {
        if (isToolNode(node)) return;
        const ordinals = node.children.filter(isToolNode).map((t) => t.ordinal);
        expect(new Set(ordinals).size, `${name}/${node.id}`).toBe(ordinals.length);
      });
    }
  });

  it('gives a file path ONLY to a tool the census says can touch a file', async () => {
    for (const tool of toolsOf(await read())) {
      if (tool.filePath === undefined) continue;
      const klass = classOf(name, tool.toolName);
      expect(FILE_CLASSES.has(klass), `${name}/${tool.toolName} class ${klass}`).toBe(true);
      expect(fileKeyOf(name, tool.toolName), `${name}/${tool.toolName}`).toBeDefined();
      expect(tool.filePath, `${name}/${tool.id}`).not.toBe('');
    }
  });
});

describe('DoD 1.5 — filePath, where it exists and where it measurably cannot', () => {
  it('is populated on Claude Code read/write/edit calls', async () => {
    const tools = toolsOf(await readCcSessions());
    const fileTools = tools.filter((t) => FILE_CLASSES.has(classOf('cc', t.toolName)));
    expect(fileTools.length, 'no CC file-class calls in any corpus').toBeGreaterThan(0);
    // Every one of them, not merely some: the census measures `file_path` on
    // 65 of 65 Reads, 64 of 64 Writes and 50 of 50 Edits.
    for (const tool of fileTools) {
      expect(tool.filePath, `${tool.toolName}/${tool.id}`).toBeDefined();
    }
  });

  it('is populated on OpenCode read/write/edit calls', async () => {
    const tools = toolsOf(await readOpenCodeSessions());
    const fileTools = tools.filter((t) => FILE_CLASSES.has(classOf('opencode', t.toolName)));
    expect(fileTools.length, 'no OpenCode file-class calls in any corpus').toBeGreaterThan(0);
    for (const tool of fileTools) {
      expect(tool.filePath, `${tool.toolName}/${tool.id}`).toBeDefined();
    }
  });

  it('is ABSENT on every Codex call — F1 is UNAVAILABLE:codex, measured', async () => {
    /*
     * Two independent causes, both from Phase 0, and either alone is enough:
     * no Codex tool has a file-argument key at all, and `exec` is a
     * `custom_tool_call` whose input is a STRING of JavaScript that can carry
     * no key. Codex touches files through shell commands, whose names live in
     * command TEXT — which Layer 1 does not read.
     */
    const tools = toolsOf(await readCodexSessions());
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.filePath, `${tool.toolName}/${tool.id}`).toBeUndefined();
    }
  });

  it('is ABSENT on a search tool, whose `path` is a scope rather than a touch', async () => {
    // `Grep`, `Glob`, `grep`, `glob` all take a `path`, and it is where to LOOK.
    // The census gives them no file key for exactly this reason, so no amount of
    // path-shaped content in the value can produce one.
    for (const { name, read } of ENGINES) {
      const searches = toolsOf(await read()).filter((t) => classOf(name, t.toolName) === 'search');
      for (const tool of searches) {
        expect(tool.filePath, `${name}/${tool.toolName}`).toBeUndefined();
      }
    }
  });

  it('is ABSENT on a shell call, though its command text is full of paths', async () => {
    for (const { name, read } of ENGINES) {
      const shells = toolsOf(await read()).filter((t) => classOf(name, t.toolName) === 'shell');
      for (const tool of shells) {
        expect(tool.filePath, `${name}/${tool.toolName}`).toBeUndefined();
      }
    }
  });
});

describe('DoD 1.2 — the hash distinguishes what the preview cannot', () => {
  it('gives two calls with different inputs different hashes, on every engine', async () => {
    for (const { name, read } of ENGINES) {
      const byTool = new Map<string, Set<string>>();
      for (const tool of toolsOf(await read())) {
        const set = byTool.get(tool.toolName) ?? new Set<string>();
        if (tool.inputHash !== undefined) set.add(tool.inputHash);
        byTool.set(tool.toolName, set);
      }
      // Control: some tool really was called with more than one input, or this
      // says nothing at all.
      const discriminating = [...byTool.values()].filter((s) => s.size > 1);
      expect(discriminating.length, `${name}: no tool called twice with different input`)
        .toBeGreaterThan(0);
    }
  });

  it('gives two calls with the SAME input the same hash — what F3 counts', async () => {
    // F3 is repeats of one `toolName + inputHash` within an agent. If equal
    // inputs hashed differently the fact could never fire. Phase 0 measured
    // three real loops across every corpus, one of them on Codex.
    const seen = new Map<string, string>();
    let repeats = 0;
    for (const { name, read } of ENGINES) {
      for (const tool of toolsOf(await read())) {
        const key = `${name}:${tool.toolName}:${tool.inputHash ?? ''}`;
        const previous = seen.get(key);
        if (previous !== undefined) {
          repeats += 1;
          expect(tool.inputHash).toBe(previous);
        }
        if (tool.inputHash !== undefined) seen.set(key, tool.inputHash);
      }
    }
    expect(repeats, 'no repeated call signature anywhere in the corpora').toBeGreaterThan(0);
  });
});

describe('DoD 1.7 — G4 extended to the fields this phase added (Claude Code)', () => {
  /*
   * The Claude Code half. The OpenCode and Codex halves live in their own
   * `parse.test.ts` files, beside the reasoning needles they reuse.
   *
   * CC's trap is the recorded one: `thinking` is EMPTY on disk and the bytes
   * sit in `signature`, so a test asserting "no thinking TEXT leaked" is
   * vacuous. The needles here are therefore the literal captured `signature`
   * values, read out of the fixture at test time, and the control asserts the
   * set is non-empty before anything is searched.
   */
  it('lets no captured signature or thinking byte reach a filePath or an inputHash', async () => {
    const { readFile } = await import('node:fs/promises');
    const { default: fs } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');

    const fixtures = fileURLToPath(new URL('../../fixtures/', import.meta.url));
    const needles: string[] = [];
    const walkDir = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) out.push(...walkDir(full));
        else if (entry.endsWith('.jsonl')) out.push(full);
      }
      return out;
    };

    for (const corpus of fs.readdirSync(fixtures).filter((d) => d.startsWith('cc-'))) {
      const dir = path.join(fixtures, corpus);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of walkDir(dir)) {
        for (const line of (await readFile(file, 'utf8')).split('\n')) {
          if (!line.includes('"signature"')) continue;
          for (const match of line.matchAll(/"signature":"((?:[^"\\]|\\.){32,})"/g)) {
            const value = match[1];
            if (value !== undefined) needles.push(value.slice(0, 64));
          }
        }
      }
    }

    // THE CONTROL, before the assertion. An empty needle set would make every
    // check below pass while proving nothing — this repository's most-recorded
    // defect, and the exact shape the CC `signature` trap produces.
    expect(needles.length, 'no captured signature bytes found to search for').toBeGreaterThan(0);

    const tools = toolsOf(await readCcSessions());
    expect(tools.length).toBeGreaterThan(0);
    const haystack = tools.map((t) => `${t.filePath ?? ''}\n${t.inputHash ?? ''}`).join('\n');

    for (const needle of needles) {
      expect(haystack, `signature bytes reached a stats field: ${needle.slice(0, 24)}`)
        .not.toContain(needle);
    }
  }, 60_000);

  it('keeps inputHash structurally incapable of carrying any content at all', async () => {
    /*
     * Stated rather than left implicit, because the assertion above is one a
     * reader could mistake for the whole guarantee. A 64-character hex digest
     * cannot contain a payload whatever was hashed — which is what makes it
     * safe to hash a Codex spawn's ciphertext or a tool input full of absolute
     * paths. The bytes that must not survive are `filePath`'s, and that is the
     * field the search above is really about.
     */
    for (const { name, read } of ENGINES) {
      for (const tool of toolsOf(await read())) {
        expect(tool.inputHash, `${name}/${tool.id}`).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});
