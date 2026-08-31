/**
 * `burn` for OpenCode — the three-way cross-check.
 *
 * WHY THIS FILE IS NOT PART OF THE GOLDEN TEST
 * --------------------------------------------
 * `golden.test.ts` proves the engine reproduces `golden.json` byte for byte.
 * That is a strong check and it cannot catch the one thing this change could
 * plausibly get wrong: the engine and `scripts/opencode-golden.mjs` are two
 * separate implementations of the same mapping, and the golden was **generated
 * by the script**. If both implementations shared a mistake, the byte compare
 * would be green and both would be wrong together.
 *
 * So this file adds a THIRD, independent derivation — read straight out of the
 * database with `node:sqlite`, from the `step-finish` part rows, which is a
 * different source from the one both implementations use (the `session` row's
 * own columns). Three values, one assertion, per session:
 *
 *     engine's SessionState.burn
 *       ==  the committed golden's burn        (what the script produced)
 *       ==  Σ over that session's step-finish rows of
 *             { input + cache.write + cache.read, output }
 *
 * The third leg is what makes the first two mean something. If the session
 * columns ever stopped being the cumulative sum of the steps, this goes red
 * while the byte compare stays green.
 *
 * THE DEFINITION BEING PINNED
 * ---------------------------
 * `TokenPair` (`../model/events.ts`) is `{ prompt, output }`, where `prompt` is
 * everything sent to the model — input plus both cache buckets — and `output`
 * is the completion. Applied to OpenCode:
 *
 *     prompt = tokens_input + tokens_cache_read + tokens_cache_write
 *     output = tokens_output
 *
 * **`tokens_reasoning` is in neither**, and that is a decision this file pins
 * rather than a gap. OpenCode keeps reasoning in its own column — it is NOT
 * inside `tokens_output` — and its own displayed `total` adds every bucket
 * INCLUDING reasoning. So our pair sums to OpenCode's total minus
 * `tokens_reasoning`, exactly, and the test below asserts that identity so the
 * difference can never be mistaken for drift.
 *
 * `contextNow` is deliberately still absent for this engine and is asserted so
 * here too: a level cannot be recovered from a cumulative total.
 * `docs/evidence/release-0.5.0/OC-CTX.md` is the measurement;
 * `PLAN.md` §0's CARRY-BACK DEBT item 2 carries what is left.
 *
 * G1 — read-only. Every open is `readOnly: true` and the corpora's digests are
 * unchanged by this file.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, TreeNode } from '../model/events.js';
import { isAgentNode } from '../model/events.js';
import { readOpenCodeEngine } from './index.js';
import { corpusDbPath, corpusGoldenPath, listCorpora } from './synthetic.js';

const CORPORA = listCorpora();

interface GoldenPair {
  prompt: number;
  output: number;
}

interface GoldenAgent {
  node: string;
  id: string;
  burn: GoldenPair | null;
  contextNow: GoldenPair | null;
  /** Agents and tools are mixed; only `node === 'agent'` entries recurse. */
  children: GoldenAgent[];
}

interface GoldenSession {
  sessionId: string;
  burn: GoldenPair | null;
  contextNow: GoldenPair | null;
  root: GoldenAgent;
}

/** Every session's step-finish token sum, read from the database directly. */
function stepSums(dbPath: string): Map<string, GoldenPair> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const out = new Map<string, GoldenPair>();
    const rows = db
      .prepare(
        "SELECT session_id, data FROM part WHERE json_extract(data,'$.type')='step-finish'",
      )
      .all() as { session_id: string; data: string }[];
    for (const row of rows) {
      const tokens = (JSON.parse(row.data) as { tokens?: Record<string, unknown> }).tokens;
      if (tokens === undefined) continue;
      const cache = (tokens['cache'] ?? {}) as { read?: number; write?: number };
      const prior = out.get(row.session_id) ?? { prompt: 0, output: 0 };
      prior.prompt +=
        Number(tokens['input'] ?? 0) + Number(cache.read ?? 0) + Number(cache.write ?? 0);
      prior.output += Number(tokens['output'] ?? 0);
      out.set(row.session_id, prior);
    }
    return out;
  } finally {
    db.close();
  }
}

/** Every session's raw token columns, read from the database directly. */
function sessionColumns(
  dbPath: string,
): Map<string, { input: number; output: number; read: number; write: number; reasoning: number }> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const out = new Map<
      string,
      { input: number; output: number; read: number; write: number; reasoning: number }
    >();
    const rows = db
      .prepare(
        'SELECT id, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,' +
          ' tokens_reasoning FROM session',
      )
      .all() as Record<string, number | string>[];
    for (const row of rows) {
      out.set(String(row['id']), {
        input: Number(row['tokens_input']),
        output: Number(row['tokens_output']),
        read: Number(row['tokens_cache_read']),
        write: Number(row['tokens_cache_write']),
        reasoning: Number(row['tokens_reasoning']),
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Every session id in a root's subtree, from the database's own `parent_id`
 * closure — NOT from the engine's tree.
 *
 * `SessionState.burn` is the sum over every agent in the tree, so comparing it
 * to a single row's columns compares two different things. It did, in the first
 * draft of this file: `1.18.22` reported prompt 9,979,697 against 8,196,904,
 * which is one root plus its twenty children against the root alone. The test
 * was wrong, not the mapping. Deriving the set from `parent_id` rather than by
 * walking the built tree keeps this leg independent of the thing under test.
 */
function subtreeIds(dbPath: string, rootId: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, parent_id FROM session').all() as {
      id: string;
      parent_id: string | null;
    }[];
    const childrenOf = new Map<string, string[]>();
    for (const row of rows) {
      const parent = row.parent_id;
      if (parent === null || parent === '') continue;
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), row.id]);
    }
    const out: string[] = [];
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined) continue;
      out.push(id);
      for (const child of childrenOf.get(id) ?? []) stack.push(child);
    }
    return out;
  } finally {
    db.close();
  }
}

function agentsOf(node: AgentNode): AgentNode[] {
  return [node, ...node.children.filter((c: TreeNode) => isAgentNode(c)).flatMap(agentsOf)];
}

function goldenAgentsOf(node: GoldenAgent): GoldenAgent[] {
  return [
    node,
    ...node.children
      .filter((c): c is GoldenAgent => c.node === 'agent')
      .flatMap((c) => goldenAgentsOf(c)),
  ];
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe.each(CORPORA)('burn — %s', (corpusName) => {
  const dbPath = corpusDbPath(corpusName);

  function engineSessions(): SessionState[] {
    const outcome = readOpenCodeEngine({ dbPath, immutable: true });
    if (outcome.kind !== 'ok') throw new Error(`engine did not read ${corpusName}`);
    return [...outcome.result.sessions];
  }

  function goldenSessions(): GoldenSession[] {
    const parsed = JSON.parse(readFileSync(corpusGoldenPath(corpusName), 'utf8')) as {
      sessions: GoldenSession[];
    };
    return parsed.sessions;
  }

  it('every session-row token column equals its own step-finish sum', () => {
    /*
     * THE THIRD LEG, and the only one neither implementation uses. Both the
     * engine and the generator read the `session` row; this reads the `part`
     * rows. If those two sources ever disagreed, `burn` would be a plausible
     * number derived from a stale total, and nothing else in the suite would
     * notice.
     */
    const steps = stepSums(dbPath);
    const columns = sessionColumns(dbPath);
    let checked = 0;
    for (const [sessionId, step] of steps) {
      const col = columns.get(sessionId);
      expect(col, `session ${sessionId} has step rows but no session row`).toBeDefined();
      if (col === undefined) continue;
      expect({ sessionId, ...step }).toStrictEqual({
        sessionId,
        prompt: col.input + col.read + col.write,
        output: col.output,
      });
      checked++;
    }
    // Vacuity control: a corpus whose step rows had all vanished would satisfy
    // the loop above by never entering it.
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBe(steps.size);
  });

  it('the engine and the committed golden agree on burn, session by session', () => {
    const engine = engineSessions();
    const golden = goldenSessions();
    expect(engine.length).toBe(golden.length);
    expect(engine.length).toBeGreaterThan(0);

    const goldenById = new Map(golden.map((s) => [s.sessionId, s]));
    for (const state of engine) {
      const g = goldenById.get(state.sessionId);
      expect(g, `${state.sessionId} missing from the golden`).toBeDefined();
      if (g === undefined) continue;
      expect(state.burn, `${state.sessionId} session burn`).toStrictEqual(g.burn);
      // And node by node, because a session-level match would hide a subtree
      // that summed correctly out of the wrong per-agent figures.
      const engineNodes = agentsOf(state.root);
      const goldenNodes = goldenAgentsOf(g.root);
      expect(engineNodes.length).toBe(goldenNodes.length);
      for (let i = 0; i < engineNodes.length; i++) {
        expect(engineNodes[i]?.burn, `${state.sessionId} node ${String(i)}`).toStrictEqual(
          goldenNodes[i]?.burn,
        );
      }
    }
  });

  it('the engine, the golden and the step rows all give the same session burn', () => {
    // The three-way join. A session with no step-finish rows contributes to
    // neither side and is reported rather than silently skipped.
    const engine = engineSessions();
    const golden = new Map(goldenSessions().map((s) => [s.sessionId, s]));
    const steps = stepSums(dbPath);

    let agreed = 0;
    const withoutSteps: string[] = [];
    for (const state of engine) {
      const ids = subtreeIds(dbPath, state.sessionId);
      // The engine counts every agent in the tree, so this must sum the same
      // rows. Asserting the two agree on the SET SIZE first means a divergence
      // shows up as "the subtree is a different shape" rather than as a wrong
      // number with no explanation.
      expect(ids.length, `${state.sessionId} subtree size`).toBe(agentsOf(state.root).length);
      const summed = { prompt: 0, output: 0 };
      let sawSteps = false;
      for (const id of ids) {
        const step = steps.get(id);
        if (step === undefined) continue;
        sawSteps = true;
        summed.prompt += step.prompt;
        summed.output += step.output;
      }
      if (!sawSteps) {
        withoutSteps.push(state.sessionId);
        continue;
      }
      const g = golden.get(state.sessionId);
      expect(state.burn, `${state.sessionId} engine vs step rows`).toStrictEqual(summed);
      expect(g?.burn, `${state.sessionId} golden vs step rows`).toStrictEqual(summed);
      agreed++;
    }
    expect(agreed).toBeGreaterThan(0);
    // Recorded, not hidden: a root session whose own row has no step rows is a
    // real shape and the count says how many there are.
    expect(withoutSteps, `sessions with no step-finish rows: ${withoutSteps.join(', ')}`).toEqual(
      [],
    );
  });

  it('reasoning is in NEITHER field, and the gap to OpenCode total is exactly it', () => {
    /*
     * The decision, pinned. `tokens_reasoning` is its own column and OpenCode's
     * own `total` includes it, so `burn.prompt + burn.output` is short of that
     * total by exactly `tokens_reasoning`. Asserting the gap — rather than just
     * omitting the column — is what stops a future reader "fixing" the
     * shortfall by folding reasoning into `output`, where OpenCode does not
     * keep it.
     */
    const columns = sessionColumns(dbPath);
    const engine = engineSessions();
    let discriminating = 0;
    for (const state of engine) {
      // Subtree again: `burn` spans every agent, so the OpenCode total it is
      // measured against has to span the same rows.
      const cols = subtreeIds(dbPath, state.sessionId)
        .map((id) => columns.get(id))
        .filter((c): c is NonNullable<typeof c> => c !== undefined);
      expect(cols.length).toBeGreaterThan(0);
      const sum = (pick: (c: (typeof cols)[number]) => number): number =>
        cols.reduce((acc, c) => acc + pick(c), 0);
      const reasoning = sum((c) => c.reasoning);
      const ours = (state.burn?.prompt ?? 0) + (state.burn?.output ?? 0);
      const ocTotal =
        sum((c) => c.input) +
        sum((c) => c.output) +
        sum((c) => c.read) +
        sum((c) => c.write) +
        reasoning;
      expect(ocTotal - ours, `${state.sessionId} reasoning gap`).toBe(reasoning);
      if (reasoning > 0) discriminating++;
    }
    // Reported, not asserted: `1.18.21` has no reasoning anywhere, so on that
    // corpus this test cannot tell the two conventions apart and says so
    // instead of pretending it did.
    expect(engine.length).toBeGreaterThan(0);
    if (discriminating === 0) {
      expect(
        [...columns.values()].every((c) => c.reasoning === 0),
        'no reasoning anywhere, so this corpus cannot discriminate — that is the reason, not a pass',
      ).toBe(true);
    }
  });

  it('contextNow is still absent on every session and node', () => {
    // The other half of the 0.5.0 decision. A level cannot come from a total.
    for (const state of engineSessions()) {
      expect('contextNow' in state).toBe(false);
      for (const node of agentsOf(state.root)) expect('contextNow' in node).toBe(false);
    }
  });

  it('reads nothing but the database, and changes no byte of it (G1)', () => {
    const before = sha256File(dbPath);
    engineSessions();
    stepSums(dbPath);
    sessionColumns(dbPath);
    expect(sha256File(dbPath)).toBe(before);
  });
});
