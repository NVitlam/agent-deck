/**
 * v0.9.0 DoD 9.3 — `skills[]`, fixture-proven, and `args` proven absent.
 *
 * ## The corpus is the evidence, and it is real
 *
 * `fixtures/cc-2.1.260` carries five genuine `Skill` calls across two
 * transcripts. Their inputs are read HERE, off the committed bytes, and the
 * derived records are produced through the PRODUCTION path — the real corpus
 * reader, the real grafter, the real `deriveStats`. Nothing in this file builds
 * a `SessionState`: a hand-built tree would measure this file's idea of a skill
 * call, and the whole question is what the parse boundary really emits.
 *
 * ## `args` is the control, and it is a real one
 *
 * THREE of those five calls carry prose `args`; a fourth carries `args: "0"`
 * and the fifth carries no `args` key at all. The three are long prose about
 * this project's own work, which makes them the single most content-shaped
 * strings a `Skill` call can carry and exactly the right literal bytes to
 * hold against every derived record — the `redaction.test.ts` technique,
 * applied to the field this DoD adds.
 *
 * (This paragraph said "five … four of them are long prose" until a
 * verifier round re-counted it. The TEST below had 3 all along; the header
 * was the stale half — the recorded shape where a fix lands at one site and
 * the wrong claim survives in the prose above it.)
 *
 * A byte test over a corpus that happened to carry no prose would be vacuous,
 * so the population is pinned non-empty before it is searched: the run fails on
 * "there are five calls with prose args" before it ever asserts "no run of them
 * appears anywhere".
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  isAgentNode,
  type AgentNode,
  type SessionState,
  type ToolNode,
} from '../model/events.js';

import { CORPUS_READ_BUDGET_MS, readCcSessions, warmCorpus } from './corpus.testkit.js';
import { deriveStats } from './derive.js';
import type { StatsRecord } from './schema.js';
import { validateStatsRecord } from './schema.js';
import { SKILL_ENGINE, SKILL_NAME_KEY, SKILL_TOOL, skillNameOf } from './skills.js';
import { TOOLCLASS_ROWS } from './toolclass.js';

beforeAll(warmCorpus, CORPUS_READ_BUDGET_MS);

const CORPUS_DIR = fileURLToPath(new URL('../../fixtures/cc-2.1.260/projects', import.meta.url));

/** Every `Skill` tool_use input in the committed corpus, read off the bytes. */
interface RawSkillCall {
  file: string;
  id: string;
  skill: unknown;
  args: unknown;
}

function readRawSkillCalls(): RawSkillCall[] {
  const out: RawSkillCall[] = [];
  const walkDir = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full);
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
        if (!line.includes('"Skill"')) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const message = (parsed as { message?: { content?: unknown } } | null)?.message;
        const content = message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content as Record<string, unknown>[]) {
          if (block['type'] !== 'tool_use' || block['name'] !== SKILL_TOOL) continue;
          const input = block['input'] as Record<string, unknown> | undefined;
          out.push({
            file: entry.name,
            id: String(block['id']),
            skill: input?.[SKILL_NAME_KEY],
            args: input?.['args'],
          });
        }
      }
    }
  };
  walkDir(CORPUS_DIR);
  return out;
}

const RAW = readRawSkillCalls();

// ---------------------------------------------------------------------------
// The module is bound to the generated census, not a second copy of it
// ---------------------------------------------------------------------------

describe('skills.ts is bound to the generated census', () => {
  it('the census still carries the Skill tool for this engine', () => {
    const row = TOOLCLASS_ROWS.find((r) => r.engine === SKILL_ENGINE && r.tool === SKILL_TOOL);
    expect(row, `census has no ${SKILL_ENGINE}/${SKILL_TOOL} row`).toBeDefined();
    // The premise of reading ONE named key: the input is an object. If the
    // census ever says otherwise, this module's rule moved with it.
    expect(row?.input).toBe('object');
    // And it is not a file-touching tool, so `filePathOf` and `skillNameOf`
    // can never both answer for the same call.
    expect(row?.fileKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

describe('skillNameOf reads one named key and nothing else', () => {
  it('answers for a Skill call with a non-empty name', () => {
    expect(skillNameOf('cc', 'Skill', { skill: 'handoff', args: 'prose' })).toBe('handoff');
  });

  it('answers undefined for every other tool, engine and input shape', () => {
    expect(skillNameOf('cc', 'Read', { skill: 'handoff' })).toBeUndefined();
    expect(skillNameOf('codex', 'Skill', { skill: 'handoff' })).toBeUndefined();
    expect(skillNameOf('opencode', 'Skill', { skill: 'handoff' })).toBeUndefined();
    expect(skillNameOf('cc', 'Skill', 'a string input')).toBeUndefined();
    expect(skillNameOf('cc', 'Skill', null)).toBeUndefined();
    expect(skillNameOf('cc', 'Skill', [{ skill: 'handoff' }])).toBeUndefined();
    expect(skillNameOf('cc', 'Skill', {})).toBeUndefined();
    expect(skillNameOf('cc', 'Skill', { skill: '' })).toBeUndefined();
    expect(skillNameOf('cc', 'Skill', { skill: 42 })).toBeUndefined();
  });

  it('never reads args, even when the name key is missing', () => {
    expect(skillNameOf('cc', 'Skill', { args: 'handoff' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The corpus, through the production path
// ---------------------------------------------------------------------------

describe('the committed corpus proves the join', () => {
  it('carries the five real Skill calls this DoD rests on', () => {
    // The population, pinned non-empty BEFORE anything is asserted about it.
    expect(RAW.length).toBe(5);
    expect(new Set(RAW.map((r) => r.file)).size).toBe(2);
    expect(RAW.every((r) => typeof r.skill === 'string' && r.skill !== '')).toBe(true);
    expect([...new Set(RAW.map((r) => r.skill))].sort()).toEqual(['handoff', 'phase']);
  });

  it('every derived cc record validates and carries a skills array', async () => {
    for (const state of await readCcSessions()) {
      const record = deriveStats(state);
      expect(Array.isArray(record.skills)).toBe(true);
      const verdict = validateStatsRecord(record);
      expect(verdict.errors).toEqual([]);
    }
  });

  it('the derived names are the corpus names, through the production path', async () => {
    const states = await readCcSessions();
    const derived = states.flatMap((state) => deriveStats(state).skills.map((s) => s.name));
    // Every name the corpus states is a name some record carries. This is the
    // join: nothing here constructs a tree or a tool node.
    const corpusNames = [...new Set(RAW.map((r) => String(r.skill)))].sort();
    for (const name of corpusNames) {
      expect(derived, `corpus skill ${name} reached no record`).toContain(name);
    }
    // And nothing was invented: every derived name is one the corpus states.
    for (const name of derived) {
      expect(corpusNames).toContain(name);
    }
  });

  it('seq is the session-wide call position, not the array index', async () => {
    const states = await readCcSessions();
    let sawNonIndex = false;
    for (const state of states) {
      const record = deriveStats(state);
      record.skills.forEach((skill, index) => {
        expect(Number.isInteger(skill.seq)).toBe(true);
        expect(skill.seq).toBeGreaterThanOrEqual(index);
        if (skill.seq !== index) sawNonIndex = true;
      });
      // Ascending, because the sequence is.
      const seqs = record.skills.map((s) => s.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    }
    // THE VACUITY CONTROL. Were `seq` the array index, every value would
    // equal its index and this flag would never be set — so the field could
    // not be wrong, which is this repository's most-recorded defect shape.
    expect(sawNonIndex, 'no corpus skill call sits away from its array index').toBe(true);
  });

  it('seq really indexes the session-wide sequence', async () => {
    // A SECOND, INDEPENDENT implementation of the order `derive.ts`
    // documents: a depth-first walk of the tree, each agent's own calls in
    // ordinal order. Replicating it here rather than importing it is what
    // makes this a cross-check instead of a restatement. `ToolNode.ordinal`
    // is PER-AGENT and is not comparable across agents, which is exactly why
    // the session-wide sequence has to be built rather than sorted.
    const sequenceOf = (root: AgentNode): ToolNode[] => {
      const out: ToolNode[] = [];
      const visit = (node: AgentNode): void => {
        const tools: ToolNode[] = [];
        const children: AgentNode[] = [];
        for (const child of node.children) {
          if (isAgentNode(child)) children.push(child);
          else tools.push(child);
        }
        out.push(
          ...[...tools].sort(
            (a, b) =>
              (a.ordinal ?? Number.MAX_SAFE_INTEGER) -
                (b.ordinal ?? Number.MAX_SAFE_INTEGER) ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          ),
        );
        for (const child of children) visit(child);
      };
      visit(root);
      return out;
    };

    let checked = 0;
    for (const state of await readCcSessions()) {
      const record = deriveStats(state);
      if (record.skills.length === 0) continue;
      const sequence = sequenceOf(state.root);
      for (const skill of record.skills) {
        const at = sequence[skill.seq];
        expect(at, `no call at session seq ${String(skill.seq)}`).toBeDefined();
        expect(at?.toolName).toBe(SKILL_TOOL);
        checked += 1;
      }
    }
    // Non-empty, or the loop above proved nothing.
    expect(checked).toBe(RAW.length);
  });

});

// ---------------------------------------------------------------------------
// `args` never reaches a record — literal captured bytes
// ---------------------------------------------------------------------------

describe('args is prose and never reaches a record', () => {
  const MIN_RUN = 12;

  const proseArgs = RAW.map((r) => r.args).filter(
    (a): a is string => typeof a === "string" && a.length >= MIN_RUN,
  );

  /**
   * Every string the ENGINE wrote, off the session state.
   *
   * `redaction.test.ts`'s assertion B, in miniature: a record string EQUAL to
   * one of these is an allow-listed identifier, and what it happens to
   * CONTAIN says nothing. A path is by construction a run of bytes inside any
   * payload that names it, so a substring scan that did not do this would
   * flag the very field G4 allow-lists.
   */
  const engineStrings = (state: SessionState): Set<string> => {
    const out = new Set<string>([state.sessionId, state.projectSlug]);
    const visit = (node: AgentNode): void => {
      out.add(node.id);
      if (node.model !== undefined) out.add(node.model);
      if (node.agentType !== undefined) out.add(node.agentType);
      for (const child of node.children) {
        if (isAgentNode(child)) {
          visit(child);
          continue;
        }
        out.add(child.toolName);
        if (child.filePath !== undefined) out.add(child.filePath);
        if (child.skillName !== undefined) out.add(child.skillName);
      }
    };
    visit(state.root);
    return out;
  };

  /** Every string in a record, with the path it sits at. */
  const stringsOf = (value: unknown, path: string, out: [string, string][]): void => {
    if (typeof value === "string") {
      out.push([path, value]);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => stringsOf(item, `${path}[${String(i)}]`, out));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) stringsOf(v, `${path}.${k}`, out);
    }
  };

  it('the corpus really carries prose args, so the byte test is not vacuous', () => {
    // MEASURED, not remembered. Five Skill calls: three carry prose args, one
    // carries `args: "0"` and one carries no `args` key at all.
    expect(proseArgs.length).toBe(3);
    // And they really are prose, not identifiers.
    expect(Math.max(...proseArgs.map((a) => a.length))).toBeGreaterThan(200);
    expect(proseArgs.every((a) => a.includes(" "))).toBe(true);
  });

  it('no string a record carries, other than one the engine wrote, holds a run of args', async () => {
    const states: SessionState[] = await readCcSessions();
    let inspected = 0;
    for (const state of states) {
      const allowed = engineStrings(state);
      const record: StatsRecord = deriveStats(state);
      const found: [string, string][] = [];
      stringsOf(record, "", found);
      for (const [path, value] of found) {
        // An allow-listed identifier the engine wrote. What it contains is
        // not this test’s question — `redaction.test.ts` assertion B is.
        if (allowed.has(value)) continue;
        inspected += 1;
        for (const args of proseArgs) {
          for (let i = 0; i + MIN_RUN <= args.length; i += 1) {
            const run = args.slice(i, i + MIN_RUN);
            expect(
              value.includes(run),
              `args run ${JSON.stringify(run)} reached ${path}`,
            ).toBe(false);
          }
        }
      }
    }
    // The population is pinned non-empty: a walk that found no string would
    // otherwise report the same clean pass.
    expect(inspected).toBeGreaterThan(0);
  });

  it('no args value appears in full anywhere in any record', async () => {
    // The total form, which admits no exemption at all: equality, not
    // containment. An args value is never an allow-listed identifier, so
    // this one needs no carve-out and would catch a leak the scan above
    // excused.
    for (const state of await readCcSessions()) {
      const found: [string, string][] = [];
      stringsOf(deriveStats(state), "", found);
      const values = new Set(found.map(([, v]) => v));
      for (const args of RAW.map((r) => r.args)) {
        if (typeof args !== "string") continue;
        expect(values.has(args), `args value reached a record verbatim`).toBe(false);
      }
    }
  });

  it('the scan can fail — a planted run is found', async () => {
    // The control for the control. Without it, a walk over an empty record
    // would report the same clean pass.
    const state = (await readCcSessions())[0];
    if (state === undefined) throw new Error("no cc session");
    const found: [string, string][] = [];
    stringsOf({ ...deriveStats(state), planted: proseArgs[0] }, "", found);
    const run = String(proseArgs[0]).slice(0, MIN_RUN);
    expect(found.some(([, v]) => v.includes(run))).toBe(true);
  });
});

