/**
 * DoD 2.8, first half — R5-style mutation: the deriver never throws.
 *
 * "missing `usageSeries`, empty agents, no `filePath`, 5,000 tool nodes: never
 * throws".
 *
 * ## Why "never throws" is the property, and not "returns something sensible"
 *
 * G2, extended: *"A deriver failure increments `statsErrors` on the diagnostics
 * channel and is skipped; the deck renders identically with the deriver
 * present, absent, or throwing."* The deck is protected either way. What a
 * throw actually costs is the RECORD — a session whose facts silently stop
 * being derived — so the cheapest way to honour G2 is not to fail at all, and
 * this file is what says the deriver does not.
 *
 * The mutations are applied to REAL fixtures rather than to invented objects,
 * because the interesting inputs are the ones a real engine can nearly produce:
 * a `SessionState` with one field removed is what a partly-implemented engine
 * hands over, and it is what the wire's optional `inputHash` and `ordinal`
 * already make possible today.
 */

import { describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, ToolNode } from '../model/events.js';
import { deriveStats } from './derive.js';
import { validateStatsRecord } from './schema.js';
import { buildSyntheticStatsFixtures } from './synthetic.testkit.js';

const FIXTURES = buildSyntheticStatsFixtures();

/** Deep-clone so a mutation cannot reach the next case. */
function clone(state: SessionState): SessionState {
  return structuredClone(state) as SessionState;
}

function mapTools(node: AgentNode, fn: (tool: ToolNode) => ToolNode): AgentNode {
  return {
    ...node,
    children: node.children.map((child) =>
      'children' in child ? mapTools(child, fn) : fn(child),
    ),
  };
}

/**
 * Every mutation, named, so a failure says which one.
 *
 * `validRecord` defaults to true. Exactly one mutation sets it false, and that
 * is a finding rather than a concession — see the comment on it.
 */
const MUTATIONS: {
  name: string;
  apply: (state: SessionState) => SessionState;
  validRecord?: boolean;
}[] = [
  {
    name: 'no usageSeries anywhere',
    apply: (state) => {
      const strip = (node: AgentNode): AgentNode => {
        const { usageSeries: _dropped, ...rest } = node;
        void _dropped;
        return { ...rest, children: node.children.map((c) => ('children' in c ? strip(c) : c)) };
      };
      return { ...state, root: strip(state.root) };
    },
  },
  {
    name: 'no children at all',
    apply: (state) => ({ ...state, root: { ...state.root, children: [] } }),
  },
  {
    name: 'no filePath on any tool',
    apply: (state) => ({
      ...state,
      root: mapTools(state.root, ({ filePath: _dropped, ...tool }) => {
        void _dropped;
        return tool;
      }),
    }),
  },
  {
    name: 'no inputHash on any tool — F3 and F4 lose their join key',
    apply: (state) => ({
      ...state,
      root: mapTools(state.root, ({ inputHash: _dropped, ...tool }) => {
        void _dropped;
        return tool;
      }),
    }),
  },
  {
    name: 'no ordinal on any tool — the wire’s optional case',
    apply: (state) => ({
      ...state,
      root: mapTools(state.root, ({ ordinal: _dropped, ...tool }) => {
        void _dropped;
        return tool;
      }),
    }),
  },
  {
    name: 'no burn on any agent',
    apply: (state) => {
      const strip = (node: AgentNode): AgentNode => {
        const { burn: _dropped, ...rest } = node;
        void _dropped;
        return { ...rest, children: node.children.map((c) => ('children' in c ? strip(c) : c)) };
      };
      return { ...state, root: strip(state.root) };
    },
  },
  {
    name: 'a tool claiming stalled with no stalledSinceMs',
    apply: (state) => ({
      ...state,
      root: mapTools(state.root, (tool) => {
        const { stalledSinceMs: _dropped, ...rest } = tool;
        void _dropped;
        return { ...rest, status: 'stalled' as const };
      }),
    }),
  },
  {
    name: 'a window of zero — F10 must not divide by it',
    apply: (state) => ({ ...state, windowTokens: 0, contextNow: { prompt: 10, output: 1 } }),
  },
  {
    name: 'a negative window and a negative prompt',
    apply: (state) => ({ ...state, windowTokens: -1, contextNow: { prompt: -5, output: -1 } }),
  },
  {
    /*
     * UNREACHABLE THROUGH THE TYPED API, and kept because what it demonstrates
     * is the layering rather than the deriver.
     *
     * `SessionState.engine` is a closed union written only by this repository's
     * own three engines, so no production path can produce this. Fed one
     * anyway, the deriver does the right thing twice over: it does not throw,
     * and it does not INVENT a value - it passes the engine through unchanged
     * rather than quietly normalising it to `cc`, which would turn a corrupt
     * state into a plausible-looking Claude Code record.
     *
     * The record is then structurally invalid, and that is the point: the
     * validator is the second line of defence and it fires, naming the field. A
     * deriver that silently repaired this would leave it nothing to catch. This
     * is the one mutation whose record must NOT validate, and saying so per
     * mutation is what stops the expectation being softened for the other
     * eleven at the same time.
     */
    name: 'an engine nobody declared',
    apply: (state) => ({ ...state, engine: 'gemini' as SessionState['engine'] }),
    validRecord: false,
  },
  {
    name: 'a tool name nobody has captured — class other, no file key',
    apply: (state) => ({
      ...state,
      root: mapTools(state.root, (tool) => ({ ...tool, toolName: 'NotebookEdit' })),
    }),
  },
  {
    name: 'duplicate ordinals across every call',
    apply: (state) => ({ ...state, root: mapTools(state.root, (tool) => ({ ...tool, ordinal: 0 })) }),
  },
];

describe('DoD 2.8 — the deriver never throws', () => {
  it('survives every mutation of every fixture, and still returns a valid record', () => {
    let derived = 0;
    for (const fixture of FIXTURES) {
      for (const mutation of MUTATIONS) {
        const mutated = mutation.apply(clone(fixture.state));
        const label = `${fixture.id} / ${mutation.name}`;
        expect(() => deriveStats(mutated, { now: 1 }), label).not.toThrow();
        const record = deriveStats(mutated, { now: 1 });
        // Not throwing is not enough: a record that comes back malformed would
        // fail Phase 3's store read instead, one layer further from the cause.
        const verdict = validateStatsRecord(record);
        expect({ label, ok: verdict.ok }).toEqual({ label, ok: mutation.validRecord ?? true });
        if (mutation.validRecord === false) {
          // The failure must be the one the mutation causes, not other damage
          // that happens to make the record invalid too.
          expect(verdict.errors.join(' ')).toContain('engine');
        }
        derived += 1;
      }
    }
    // Vacuity control: an empty fixture list or an empty mutation list would
    // satisfy every assertion above.
    expect(derived).toBe(FIXTURES.length * MUTATIONS.length);
    expect(derived).toBeGreaterThan(100);
  });

  it('survives a state with no optional field at all', () => {
    const bare: SessionState = {
      sessionId: 'bare',
      projectSlug: 'bare',
      workspaceMatch: false,
      liveness: 'ended',
      schemaOk: true,
      totals: { costUsd: 0 },
      root: {
        id: 'root',
        kind: 'main',
        label: '',
        status: 'done',
        spawnDepth: 0,
        children: [],
        startedAt: 0,
      },
    };
    const record = deriveStats(bare);
    expect(record.coverage).toBe('full');
    // Absence reads as `cc` — the convention `events.ts` states.
    expect(record.engine).toBe('cc');
    expect(validateStatsRecord(record).ok).toBe(true);
  });

  it('survives 5,000 tool nodes', () => {
    const tools: ToolNode[] = [];
    for (let i = 0; i < 5_000; i += 1) {
      tools.push({
        id: `t${String(i)}`,
        toolName: i % 2 === 0 ? 'Edit' : 'Bash',
        status: i % 13 === 0 ? 'error' : 'done',
        inputPreview: '',
        ordinal: i,
        ...(i % 2 === 0 ? { filePath: `/repo/f-${String(i % 25)}.ts` } : {}),
        inputHash: (String(i % 60) + 'f'.repeat(64)).slice(0, 64),
      });
    }
    const state: SessionState = {
      sessionId: 'big',
      projectSlug: 'big',
      workspaceMatch: true,
      liveness: 'ended',
      schemaOk: true,
      engine: 'cc',
      totals: { costUsd: 0 },
      root: {
        id: 'root',
        kind: 'main',
        label: '',
        status: 'done',
        spawnDepth: 0,
        children: tools,
        startedAt: 0,
      },
    };
    let record = validateStatsRecord(deriveStats(state, { now: 1 }));
    expect(record).toEqual({ ok: true, errors: [] });
    // And the derivation really did work rather than bailing out early.
    const derivedRecord = deriveStats(state, { now: 1 });
    expect(derivedRecord.tools).toHaveLength(2);
    expect(derivedRecord.files).toHaveLength(25);
    expect(derivedRecord.loops.length).toBeGreaterThan(0);
    expect(derivedRecord.churn.length).toBeGreaterThan(0);
    record = validateStatsRecord(derivedRecord);
    expect(record.ok).toBe(true);
  }, 30_000);

  it('survives a deeply nested tree without overflowing', () => {
    // G3 says never crash on input, and depth is the classic way a recursive
    // walker does. The grafter caps real trees far below this.
    let node: AgentNode = {
      id: 'leaf',
      kind: 'subagent',
      label: '',
      status: 'done',
      spawnDepth: 400,
      children: [],
      startedAt: 0,
    };
    for (let depth = 399; depth >= 0; depth -= 1) {
      node = {
        id: `a${String(depth)}`,
        kind: depth === 0 ? 'main' : 'subagent',
        label: '',
        status: 'done',
        spawnDepth: depth,
        children: [node],
        startedAt: 0,
      };
    }
    const state: SessionState = {
      sessionId: 'deep',
      projectSlug: 'deep',
      workspaceMatch: true,
      liveness: 'ended',
      schemaOk: true,
      engine: 'cc',
      totals: { costUsd: 0 },
      root: node,
    };
    expect(() => deriveStats(state, { now: 1 })).not.toThrow();
    expect(deriveStats(state, { now: 1 }).agents).toHaveLength(401);
  });
});
