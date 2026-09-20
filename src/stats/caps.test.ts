/**
 * v0.9.0 DoD 9.1 — the string caps.
 *
 * Spec `Amendment 2026-09-20`: 64 characters for a NAME (`agentType`,
 * `skills[].name`), 1024 for a PATH (`filePath`, wherever it appears). An
 * over-length string is **refused, never truncated**; the deriver omits the
 * field or drops the row; the record is **not excluded**; and `unavailable`
 * carries `<section>:string-overlength:<field>`.
 *
 * ## Two halves, and they fail for different reasons
 *
 * `validateStatsRecord` REFUSES an over-length string — that is the guarantee,
 * and it is what stops such a record reaching the store or the API.
 * `deriveStats` never BUILDS one — that is the behaviour, and it is what keeps
 * a session with one long path from losing every other fact it has. Both are
 * driven here, and the boundary cases are driven on both sides of the cap.
 *
 * ## The rows are built through the production path
 *
 * A `SessionState` carrying a very long path is assembled with the same
 * testkit every other stats test uses, and `deriveStats` is what produces the
 * record. Nothing here hand-writes a `StatsRecord` and then asserts about it,
 * because the question is what the DERIVER does, not what an object literal
 * can be made to look like.
 */

import { describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, ToolNode } from '../model/events.js';

import { deriveStats } from './derive.js';
import {
  NAME_MAX_CHARS,
  PATH_MAX_CHARS,
  STATS_SCHEMA_VERSION,
  STATS_STRING_CAPS,
  validateStatsRecord,
} from './schema.js';

// ---------------------------------------------------------------------------
// Minimal real-shaped inputs
// ---------------------------------------------------------------------------

let nextId = 0;
const id = (prefix: string): string => `${prefix}-${String((nextId += 1))}`;

function toolNode(over: Partial<ToolNode> = {}): ToolNode {
  return {
    id: id('toolu'),
    toolName: 'Read',
    status: 'done',
    inputPreview: '{}',
    inputHash: 'a'.repeat(64),
    ordinal: 0,
    ...over,
  };
}

function sessionWith(children: (AgentNode | ToolNode)[], rootOver: Partial<AgentNode> = {}): SessionState {
  const root: AgentNode = {
    id: 'root',
    kind: 'main',
    label: 'a session',
    status: 'running',
    spawnDepth: 0,
    children,
    startedAt: 1_000,
    ...rootOver,
  };
  // NO CAST. A `as SessionState` here hid a missing required `totals`
  // until `deriveStats` dereferenced it at run time; letting the compiler
  // check the shape is the whole value of building a real one.
  const state: SessionState = {
    sessionId: id('session'),
    projectSlug: 'c--ws-example',
    engine: 'cc',
    workspaceMatch: true,
    liveness: 'idle',
    schemaOk: true,
    root,
    totals: { costUsd: 0 },
  };
  return state;
}

const LONG_PATH = `C:\\ws\\${'d'.repeat(PATH_MAX_CHARS)}.ts`;
const OK_PATH = `C:\\ws\\${'d'.repeat(40)}.ts`;
const LONG_NAME = 'n'.repeat(NAME_MAX_CHARS + 1);

// ---------------------------------------------------------------------------
// The constants
// ---------------------------------------------------------------------------

describe('the caps are what the spec says', () => {
  it('64 for a name, 1024 for a path', () => {
    expect(NAME_MAX_CHARS).toBe(64);
    expect(PATH_MAX_CHARS).toBe(1024);
  });

  it('governs exactly the three keys the amendment names', () => {
    expect([...STATS_STRING_CAPS.keys()].sort()).toEqual(['agentType', 'filePath', 'name']);
    expect(STATS_STRING_CAPS.get('agentType')).toBe(NAME_MAX_CHARS);
    expect(STATS_STRING_CAPS.get('name')).toBe(NAME_MAX_CHARS);
    expect(STATS_STRING_CAPS.get('filePath')).toBe(PATH_MAX_CHARS);
  });

  it('leaves the engine-written identifiers uncapped, deliberately', () => {
    // Stated as an assertion so that capping one later is a decision somebody
    // takes rather than one that happens. `sessionId` in particular must stay
    // uncapped: the store keys on it.
    for (const key of ['sessionId', 'agentId', 'toolName', 'model', 'projectSlug', 'engine']) {
      expect(STATS_STRING_CAPS.has(key), `${key} acquired a cap`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The validator REFUSES
// ---------------------------------------------------------------------------

describe('validateStatsRecord refuses an over-length string', () => {
  const base = (): Record<string, unknown> => ({
    statsSchemaVersion: STATS_SCHEMA_VERSION,
    sessionId: 's',
    engine: 'cc',
    projectSlug: 'c--ws',
    startedAt: 1,
    coverage: 'full',
    agents: [],
    files: [],
    tools: [],
    loops: [],
    churn: [],
    contextChurn: [],
    compactions: [],
    stalls: [],
    skills: [],
    timing: {},
    totals: { prompt: 0, output: 0, compactions: 0, subagents: 0, silentSubagents: 0, stalls: 0 },
    params: { loopMin: 3 },
    unavailable: [],
  });

  it('accepts the base record, so every refusal below is about the string', () => {
    expect(validateStatsRecord(base()).errors).toEqual([]);
  });

  it('refuses a filePath over the path cap, and says so', () => {
    const record = base();
    record['files'] = [
      { filePath: LONG_PATH, reads: 1, edits: 0, writes: 0, errors: 0, firstTouchSeq: 0, lastTouchSeq: 0 },
    ];
    const verdict = validateStatsRecord(record);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/string over cap: files\[0\]\.filePath/);
    expect(verdict.errors.join('\n')).toContain(String(PATH_MAX_CHARS));
  });

  it('refuses an agentType over the name cap', () => {
    const record = base();
    record['agents'] = [
      {
        agentId: 'a',
        kind: 'subagent',
        spawnDepth: 1,
        prompt: 0,
        output: 0,
        toolCalls: 0,
        silent: true,
        resultUnreceived: false,
        agentType: LONG_NAME,
      },
    ];
    expect(validateStatsRecord(record).errors.join('\n')).toMatch(
      /string over cap: agents\[0\]\.agentType/,
    );
  });

  it('refuses a skill name over the name cap', () => {
    const record = base();
    record['skills'] = [{ name: LONG_NAME, seq: 0 }];
    expect(validateStatsRecord(record).errors.join('\n')).toMatch(
      /string over cap: skills\[0\]\.name/,
    );
  });

  it('caps at every depth filePath appears — loops and churn too', () => {
    const loops = base();
    loops['loops'] = [
      { agentId: 'a', toolName: 'Read', class: 'read', count: 3, ordinals: [0, 1, 2], filePath: LONG_PATH },
    ];
    expect(validateStatsRecord(loops).errors.join('\n')).toMatch(/string over cap: loops\[0\]\.filePath/);

    const churn = base();
    churn['churn'] = [
      { agentId: 'a', filePath: LONG_PATH, fromOrdinal: 0, toOrdinal: 2, ordinals: [1], errors: 1 },
    ];
    expect(validateStatsRecord(churn).errors.join('\n')).toMatch(/string over cap: churn\[0\]\.filePath/);
  });

  it('boundary: exactly at the cap is accepted, one over is refused', () => {
    const atName = base();
    atName['skills'] = [{ name: 'n'.repeat(NAME_MAX_CHARS), seq: 0 }];
    expect(validateStatsRecord(atName).errors).toEqual([]);

    const overName = base();
    overName['skills'] = [{ name: 'n'.repeat(NAME_MAX_CHARS + 1), seq: 0 }];
    expect(validateStatsRecord(overName).ok).toBe(false);

    const row = (filePath: string): unknown => ({
      filePath,
      reads: 1,
      edits: 0,
      writes: 0,
      errors: 0,
      firstTouchSeq: 0,
      lastTouchSeq: 0,
    });
    const atPath = base();
    atPath['files'] = [row('p'.repeat(PATH_MAX_CHARS))];
    expect(validateStatsRecord(atPath).errors).toEqual([]);

    const overPath = base();
    overPath['files'] = [row('p'.repeat(PATH_MAX_CHARS + 1))];
    expect(validateStatsRecord(overPath).ok).toBe(false);
  });

  it('a `name` anywhere but skills[] is still off the allow-list', () => {
    // The scoped entry must not have widened the key-based check. This is the
    // whole reason `name` was not bare-listed.
    const record = base();
    record['tools'] = [{ toolName: 'Read', class: 'read', calls: 1, name: 'anything' }];
    expect(validateStatsRecord(record).errors.join('\n')).toMatch(
      /string field off the allow-list: tools\[0\]\.name/,
    );
  });
});

// ---------------------------------------------------------------------------
// The deriver OMITS or DROPS, and never excludes
// ---------------------------------------------------------------------------

describe('deriveStats refuses rather than truncates', () => {
  it('drops an over-length file row, names it, and keeps the record', () => {
    const state = sessionWith([
      toolNode({ toolName: 'Read', filePath: LONG_PATH, ordinal: 0 }),
      toolNode({ toolName: 'Read', filePath: OK_PATH, ordinal: 1 }),
    ]);
    const record = deriveStats(state);

    // The row is gone, not cut.
    expect(record.files.map((f) => f.filePath)).toEqual([OK_PATH]);
    expect(JSON.stringify(record)).not.toContain('d'.repeat(200));
    // Named.
    expect(record.unavailable).toContain('files:string-overlength:filePath');
    // NOT excluded: the session keeps its coverage and its other facts.
    expect(record.coverage).toBe('full');
    expect(record.tools.length).toBeGreaterThan(0);
    // And the record that results is one the validator accepts.
    expect(validateStatsRecord(record).errors).toEqual([]);
  });

  it('omits an over-length agentType, keeps the agent, and names it', () => {
    const child: AgentNode = {
      id: 'agent-1',
      kind: 'subagent',
      label: 'x',
      status: 'done',
      spawnDepth: 1,
      children: [toolNode({ ordinal: 0 })],
      startedAt: 1_000,
      agentType: LONG_NAME,
    };
    const record = deriveStats(sessionWith([child]));
    const agent = record.agents.find((a) => a.agentId === 'agent-1');

    expect(agent).toBeDefined();
    expect(agent?.agentType).toBeUndefined();
    expect(agent?.toolCalls).toBe(1);
    expect(record.unavailable).toContain('agents:string-overlength:agentType');
    expect(record.coverage).toBe('full');
    expect(validateStatsRecord(record).errors).toEqual([]);
  });

  it('drops an over-length skill row, names it, and keeps the others', () => {
    const state = sessionWith([
      toolNode({ toolName: 'Skill', skillName: LONG_NAME, ordinal: 0 }),
      toolNode({ toolName: 'Skill', skillName: 'handoff', ordinal: 1 }),
    ]);
    const record = deriveStats(state);

    expect(record.skills.map((s) => s.name)).toEqual(['handoff']);
    expect(record.unavailable).toContain('skills:string-overlength:name');
    expect(record.coverage).toBe('full');
    expect(validateStatsRecord(record).errors).toEqual([]);
  });

  it('a string exactly at the cap is kept and nothing is named', () => {
    // The other side of the boundary, through the deriver rather than the
    // validator: a cap that fired one character early would show up here.
    const state = sessionWith([
      toolNode({ toolName: 'Skill', skillName: 'n'.repeat(NAME_MAX_CHARS), ordinal: 0 }),
      toolNode({ toolName: 'Read', filePath: 'p'.repeat(PATH_MAX_CHARS), ordinal: 1 }),
    ]);
    const record = deriveStats(state);

    expect(record.skills).toHaveLength(1);
    expect(record.files).toHaveLength(1);
    expect(record.unavailable.filter((u) => u.includes('string-overlength'))).toEqual([]);
    expect(validateStatsRecord(record).errors).toEqual([]);
  });

  it('names nothing when nothing is over the cap', () => {
    const record = deriveStats(sessionWith([toolNode({ toolName: 'Read', filePath: OK_PATH })]));
    expect(record.unavailable.filter((u) => u.includes('string-overlength'))).toEqual([]);
  });
});
