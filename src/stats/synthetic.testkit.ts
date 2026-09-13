/**
 * R8 — the manufactured stats fixtures, one per shape the harvested corpora
 * cannot supply.
 *
 * v0.7.0 Phase 2. TEST-ONLY, and named for what each one manufactures rather
 * than for what it is made of, exactly as `PLAN.md`'s Swarm Self-Test Protocol
 * R8 names them.
 *
 * ## Why these are hand-built `SessionState`s, and what that costs
 *
 * The deriver's contract is `SessionState -> StatsRecord`, so a `SessionState`
 * is its honest input and building one directly is not a shortcut past a parse.
 * The harvested corpora are what prove the PRODUCTION PATH: 23 real sessions,
 * read through `graftSession`, `readOpenCodeEngine` and `readCodexEngine`, each
 * with a committed golden. These fourteen prove the DERIVER over shapes no real
 * session in this repository contains — a non-zero engine cost, a user price
 * table, a currently-stalled tool, a spawning call with no result.
 *
 * **The cost, stated rather than left for a reader to find:** a hand-built
 * state could in principle describe a session no engine can produce, and then
 * its golden would pin behaviour over an impossible input. Two things bound
 * that. Every fixture is validated as a `SessionState` shape by
 * `synthetic.test.ts` before it is used, and every VALUE that could have been
 * invented is instead taken from something measured — the compaction entry's
 * key set from `cc-2.1.260`, the Codex window from the anchor corpus's own
 * `258400`, and fixture 13's cost and session id from the committed OTel
 * capture rather than from a number chosen here.
 *
 * ## Labelled `synthetic-` in every id and slug
 *
 * R8 requires it and the privacy sweep depends on it: a fixture whose slug
 * looked like a real project would be indistinguishable from a capture in every
 * inventory this repository keeps.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type {
  AgentNode,
  SessionState,
  ToolNode,
  UsageTurn,
} from '../model/events.js';

import { joinTelemetry } from '../otel/join.js';
import { emptyTelemetryCounts, mergeSlices, parseOtlpBody } from '../otel/parse.js';
import type { OtelSignal } from '../otel/parse.js';

/** A fixed instant every fixture is anchored to. No clock is ever read here. */
export const SYNTHETIC_EPOCH_MS = 1_700_000_000_000;

/**
 * The instant `deriveStats` is told is "now" when deriving these.
 *
 * Only fixture 12 reads it, and it is a CONSTANT rather than `Date.now()` for
 * the reason the whole deriver takes `now` as a parameter: a golden derived
 * against a moving clock is not a golden.
 */
export const SYNTHETIC_NOW_MS = SYNTHETIC_EPOCH_MS + 3_600_000;

/** The price table fixture 11 is priced under. Not shipped, not a default. */
export const SYNTHETIC_PRICING = {
  'synthetic-model-a': { prompt: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
} as const;

/** One manufactured session, and the shape it exists to manufacture. */
export interface SyntheticStatsFixture {
  /** `01-reread-loop`, ... — the R8 name. */
  id: string;
  /** The one shape this fixture manufactures, in a sentence. */
  manufactures: string;
  state: SessionState;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

interface ToolSpec {
  id: string;
  toolName: string;
  ordinal: number;
  status?: ToolNode['status'];
  filePath?: string;
  inputHash?: string;
  durationMs?: number;
  stalledSinceMs?: number;
  inputPreview?: string;
}

function tool(spec: ToolSpec): ToolNode {
  return {
    id: spec.id,
    toolName: spec.toolName,
    status: spec.status ?? 'done',
    // Deliberately content-free. A preview is a payload and no fixture here
    // needs one to be real — DoD 2.7 asserts no payload reaches a record, and a
    // fixture carrying invented payload text would make that assertion easier
    // to pass than the corpora make it.
    inputPreview: spec.inputPreview ?? '',
    ordinal: spec.ordinal,
    ...(spec.filePath === undefined ? {} : { filePath: spec.filePath }),
    ...(spec.inputHash === undefined ? {} : { inputHash: spec.inputHash }),
    ...(spec.durationMs === undefined ? {} : { durationMs: spec.durationMs }),
    ...(spec.stalledSinceMs === undefined ? {} : { stalledSinceMs: spec.stalledSinceMs }),
  };
}

/**
 * A 64-hex `inputHash` that is stable, readable in a diff, and provably not a
 * real SHA-256 of anything.
 *
 * Real hashes are not used because a fixture's job here is to say "these two
 * calls had the SAME input" — the property F3 groups on — and a recognisable
 * repeated token states that far more clearly to a reader of the committed
 * JSON than sixty-four bytes of entropy would.
 */
function hash(tag: string): string {
  const body = tag.replace(/[^0-9a-f]/gu, '0');
  return (body + 'f'.repeat(64)).slice(0, 64);
}

interface AgentSpec {
  id: string;
  kind?: AgentNode['kind'];
  spawnDepth?: number;
  prompt?: number;
  output?: number;
  model?: string;
  series?: UsageTurn[];
  compactions?: AgentNode['compactions'];
  children?: (AgentNode | ToolNode)[];
}

function agent(spec: AgentSpec): AgentNode {
  return {
    id: spec.id,
    kind: spec.kind ?? 'main',
    // Never prose. `AgentNode.label` is the most content-shaped string on the
    // tree and the record deliberately does not carry it; a fixture states the
    // fact by using a name that could not be mistaken for a description.
    label: `synthetic-${spec.id}`,
    status: 'done',
    spawnDepth: spec.spawnDepth ?? 0,
    children: spec.children ?? [],
    startedAt: SYNTHETIC_EPOCH_MS,
    ...(spec.prompt === undefined && spec.output === undefined
      ? {}
      : { burn: { prompt: spec.prompt ?? 0, output: spec.output ?? 0 } }),
    ...(spec.model === undefined ? {} : { model: spec.model }),
    ...(spec.series === undefined ? {} : { usageSeries: spec.series }),
    ...(spec.compactions === undefined ? {} : { compactions: spec.compactions }),
  };
}

interface StateSpec {
  id: string;
  engine?: SessionState['engine'];
  root: AgentNode;
  costUsd?: number;
  windowTokens?: number;
  contextNow?: { prompt: number; output: number };
  parked?: SessionState['parked'];
  telemetryCostUsd?: number;
  /**
   * F15's input, and OPTIONAL here because it is optional on `SessionState`.
   *
   * Absence is the state a session reports when it says nothing about how its
   * agents were spawned, and the deriver answers it with an absent
   * `totals.subagentsUnreceived` plus `F15:<engine>` — so a builder that always
   * supplied edges would make that arm unreachable from R8. Thirteen of the
   * fourteen fixtures leave it out; fixture 14 states it.
   */
  spawnEdges?: SessionState['spawnEdges'];
}

function state(spec: StateSpec): SessionState {
  return {
    sessionId: `synthetic-${spec.id}`,
    projectSlug: 'synthetic-stats',
    workspaceMatch: true,
    liveness: 'ended',
    schemaOk: true,
    root: spec.root,
    totals: { costUsd: spec.costUsd ?? 0 },
    ...(spec.contextNow === undefined ? {} : { contextNow: spec.contextNow }),
    ...(spec.windowTokens === undefined ? {} : { windowTokens: spec.windowTokens }),
    ...(spec.parked === undefined ? {} : { parked: spec.parked }),
    ...(spec.spawnEdges === undefined ? {} : { spawnEdges: spec.spawnEdges }),
    ...(spec.telemetryCostUsd === undefined
      ? {}
      : { telemetryCostUsd: spec.telemetryCostUsd }),
    engine: spec.engine ?? 'cc',
  };
}

function turn(ordinal: number, cacheCreation: number, extra: Partial<UsageTurn> = {}): UsageTurn {
  return {
    ordinal,
    input: extra.input ?? 10,
    cacheCreation,
    cacheRead: extra.cacheRead ?? 100,
    output: extra.output ?? 20,
  };
}

// ---------------------------------------------------------------------------
// The OTel corpus — fixture 13's cost and session id, both DISCOVERED
// ---------------------------------------------------------------------------

const OTEL_CORPUS = fileURLToPath(new URL('../../fixtures/otel-cc-2.1.260/', import.meta.url));

function otelSlice(signal: OtelSignal): ReturnType<typeof mergeSlices> {
  const counts = emptyTelemetryCounts();
  const lines = readFileSync(`${OTEL_CORPUS}${signal}.jsonl`, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { signal: OtelSignal; raw: string });
  return mergeSlices(lines.map((line) => parseOtlpBody(line.raw, signal, counts)));
}

/**
 * Fixture 13's session id: the FIRST cost-bearing session in the committed OTel
 * capture, by sorted id.
 *
 * Discovered rather than written down, and sorted rather than taken in file
 * order, so the fixture names a session the corpus really carries and does so
 * identically on every machine. If the capture is ever re-harvested and that
 * session goes, this throws instead of silently manufacturing a record whose
 * telemetry cost is `undefined` — which would look exactly like a passing test
 * of a feature that had stopped working.
 */
function telemetrySessionId(slice: ReturnType<typeof mergeSlices>): string {
  const ids = [...new Set(slice.costPoints.map((p) => p.sessionId))].sort();
  const first = ids[0];
  if (first === undefined) {
    throw new Error('the committed OTel capture carries no cost point: fixture 13 cannot be built');
  }
  return first;
}

// ---------------------------------------------------------------------------
// The fourteen
// ---------------------------------------------------------------------------

/**
 * Build every R8 fixture. Deterministic: the same bytes on every machine.
 *
 * Reads the committed OTel capture (fixture 13 only). Everything else is
 * constructed from the constants above.
 */
export function buildSyntheticStatsFixtures(): SyntheticStatsFixture[] {
  const out: SyntheticStatsFixture[] = [];

  // 01 — LOOP_MIN identical calls in one agent, and a pair that is one short.
  out.push({
    id: '01-reread-loop',
    manufactures: 'three identical Read calls in one agent, beside a two-call pair that is one short of LOOP_MIN',
    state: state({
      id: '01-reread-loop',
      root: agent({
        id: 'root',
        prompt: 1000,
        output: 100,
        series: [turn(0, 0)],
        children: [
          tool({ id: 't0', toolName: 'Read', ordinal: 0, inputHash: hash('aaa'), filePath: '/synthetic/a.ts' }),
          tool({ id: 't1', toolName: 'Read', ordinal: 1, inputHash: hash('aaa'), filePath: '/synthetic/a.ts' }),
          tool({ id: 't2', toolName: 'Read', ordinal: 2, inputHash: hash('aaa'), filePath: '/synthetic/a.ts' }),
          // The negative arm: same tool, same input, ONE SHORT of LOOP_MIN.
          tool({ id: 't3', toolName: 'Grep', ordinal: 3, inputHash: hash('bbb') }),
          tool({ id: 't4', toolName: 'Grep', ordinal: 4, inputHash: hash('bbb') }),
        ],
      }),
    }),
  });

  // 02 — Edit A, an error, Edit A. And Edit B, a SUCCESS, Edit B.
  out.push({
    id: '02-churn-chain',
    manufactures: 'one churn chain (write -> error -> write) beside a write pair with no error between them',
    state: state({
      id: '02-churn-chain',
      root: agent({
        id: 'root',
        prompt: 1000,
        output: 100,
        series: [turn(0, 0)],
        children: [
          tool({ id: 'c0', toolName: 'Edit', ordinal: 0, filePath: '/synthetic/a.ts', inputHash: hash('c0') }),
          tool({ id: 'c1', toolName: 'Bash', ordinal: 1, status: 'error', inputHash: hash('c1') }),
          tool({ id: 'c2', toolName: 'Edit', ordinal: 2, filePath: '/synthetic/a.ts', inputHash: hash('c2') }),
          // The negative arm: two writes of a different file with a SUCCESSFUL
          // call between them is not a chain.
          tool({ id: 'c3', toolName: 'Edit', ordinal: 3, filePath: '/synthetic/b.ts', inputHash: hash('c3') }),
          tool({ id: 'c4', toolName: 'Bash', ordinal: 4, inputHash: hash('c4') }),
          tool({ id: 'c5', toolName: 'Edit', ordinal: 5, filePath: '/synthetic/b.ts', inputHash: hash('c5') }),
        ],
      }),
    }),
  });

  // 03 — a spawned agent that called nothing, beside one that called something.
  out.push({
    id: '03-silent-subagent',
    manufactures: 'one subagent with zero tool calls, beside a subagent that made one',
    state: state({
      id: '03-silent-subagent',
      root: agent({
        id: 'root',
        prompt: 1000,
        output: 100,
        series: [turn(0, 0)],
        children: [
          tool({ id: 's0', toolName: 'Agent', ordinal: 0, inputHash: hash('s0') }),
          agent({ id: 'quiet', kind: 'subagent', spawnDepth: 1, prompt: 10, output: 1, series: [turn(0, 0)] }),
          agent({
            id: 'busy',
            kind: 'subagent',
            spawnDepth: 1,
            prompt: 20,
            output: 2,
            series: [turn(0, 0)],
            children: [tool({ id: 's1', toolName: 'Read', ordinal: 0, inputHash: hash('s1') })],
          }),
        ],
      }),
    }),
  });

  // 04 — one turn over SPIKE_TOKENS.cc, one turn under it.
  out.push({
    id: '04-context-spike',
    manufactures: 'one turn whose cache-creation delta clears SPIKE_TOKENS.cc, and one that falls short by a single token',
    state: state({
      id: '04-context-spike',
      root: agent({
        id: 'root',
        prompt: 1000,
        output: 100,
        series: [
          turn(0, 0),
          // +6,000 — over the 5,000 threshold.
          turn(1, 6_000),
          // +4,999 — ONE SHORT. The boundary is asserted, not approached.
          turn(2, 10_999),
        ],
        children: [],
      }),
    }),
  });

  // 05 — a parked graft. Everything must come back empty.
  out.push({
    id: '05-excluded-parked',
    manufactures: 'a session with a real parked entry, which G3 excludes in full',
    state: state({
      id: '05-excluded-parked',
      parked: [
        {
          agentId: 'orphan',
          code: 'noMatchingToolUse',
          reason: 'synthetic: manufactured for DoD 2.5',
        },
      ],
      root: agent({
        id: 'root',
        prompt: 1000,
        output: 100,
        series: [turn(0, 0)],
        // Deliberately NOT empty. An excluded session whose tree was already
        // empty would satisfy "empty tables" for the wrong reason, and the
        // exclusion would be untested.
        children: [
          tool({ id: 'p0', toolName: 'Read', ordinal: 0, filePath: '/synthetic/a.ts', inputHash: hash('p0') }),
          tool({ id: 'p1', toolName: 'Read', ordinal: 1, filePath: '/synthetic/a.ts', inputHash: hash('p0') }),
          tool({ id: 'p2', toolName: 'Read', ordinal: 2, filePath: '/synthetic/a.ts', inputHash: hash('p0') }),
        ],
      }),
    }),
  });

  // 06 — no usage series at all.
  out.push({
    id: '06-no-cache-fields',
    manufactures: 'an agent with no usageSeries, so F6 has no numerator and says so',
    state: state({
      id: '06-no-cache-fields',
      root: agent({
        id: 'root',
        prompt: 1000,
        output: 100,
        children: [tool({ id: 'n0', toolName: 'Read', ordinal: 0, inputHash: hash('n0') })],
      }),
    }),
  });

  // 07 — a truncated preview beside a hash taken before the cut.
  out.push({
    id: '07-oversize-input',
    manufactures: 'two calls with identical truncated previews and DIFFERENT hashes, so a loop cannot be manufactured by truncation',
    state: state({
      id: '07-oversize-input',
      root: agent({
        id: 'root',
        prompt: 1000,
        output: 100,
        series: [turn(0, 0)],
        children: [
          // Identical previews, different hashes: the calls differ only PAST
          // the truncation point. Grouping on the preview would report a loop
          // here, which is exactly what hashing before the cut prevents.
          tool({ id: 'o0', toolName: 'Write', ordinal: 0, filePath: '/synthetic/big.txt', inputHash: hash('0a'), inputPreview: 'x'.repeat(64) }),
          tool({ id: 'o1', toolName: 'Write', ordinal: 1, filePath: '/synthetic/big.txt', inputHash: hash('0b'), inputPreview: 'x'.repeat(64) }),
          tool({ id: 'o2', toolName: 'Write', ordinal: 2, filePath: '/synthetic/big.txt', inputHash: hash('0c'), inputPreview: 'x'.repeat(64) }),
        ],
      }),
    }),
  });

  // 08 — the only engine that states a window.
  out.push({
    id: '08-codex-window',
    manufactures: 'a Codex session stating windowTokens, so F10 has both halves',
    state: state({
      id: '08-codex-window',
      engine: 'codex',
      // The anchor corpus's own single distinct value. Not invented here.
      windowTokens: 258_400,
      contextNow: { prompt: 64_600, output: 100 },
      root: agent({
        id: 'root',
        prompt: 1000,
        output: 100,
        children: [tool({ id: 'w0', toolName: 'exec', ordinal: 0, inputHash: hash('w0') })],
      }),
    }),
  });

  // 09 — an engine-reported cost. No committed OpenCode store has one.
  out.push({
    id: '09-opencode-cost',
    manufactures: 'an OpenCode session with a NON-ZERO session.cost, which no captured store carries (VERDICT.md 0.4: 0 across 30 sessions)',
    state: state({
      id: '09-opencode-cost',
      engine: 'opencode',
      costUsd: 0.4237,
      root: agent({
        id: 'root',
        prompt: 1000,
        output: 100,
        series: [turn(0, 0)],
        children: [tool({ id: 'k0', toolName: 'read', ordinal: 0, filePath: '/synthetic/a.ts', inputHash: hash('k0') })],
      }),
    }),
  });

  // 10 — the CC compaction entry, both triggers' shared key set.
  out.push({
    id: '10-compaction',
    manufactures: 'one structural compaction entry with trigger, preTokens and postTokens stated',
    state: state({
      id: '10-compaction',
      root: agent({
        id: 'root',
        prompt: 1000,
        output: 100,
        series: [turn(0, 0)],
        compactions: [
          { ordinal: 1, trigger: 'auto', preTokens: 150_000, postTokens: 40_000, durationMs: 8_200 },
        ],
        children: [tool({ id: 'm0', toolName: 'Read', ordinal: 0, inputHash: hash('m0') })],
      }),
    }),
  });

  // 11 — the user's own prices, times the series.
  out.push({
    id: '11-user-priced',
    manufactures: 'a CC session whose model id matches a test agentDeck.pricing entry, so F9(b) can be hand-checked',
    state: state({
      id: '11-user-priced',
      root: agent({
        id: 'root',
        prompt: 1000,
        output: 100,
        model: 'synthetic-model-a',
        series: [
          { ordinal: 0, input: 1_000_000, cacheCreation: 0, cacheRead: 0, output: 0 },
          { ordinal: 1, input: 0, cacheCreation: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 },
        ],
        children: [tool({ id: 'u0', toolName: 'Read', ordinal: 0, inputHash: hash('u0') })],
      }),
    }),
  });

  // 12 — one stalled call, one long-running call that COMPLETED.
  out.push({
    id: '12-stall',
    manufactures: 'one tool past the stall threshold beside one that ran far longer and completed — the pair spec §L uses to separate silence from duration',
    state: state({
      id: '12-stall',
      root: agent({
        id: 'root',
        prompt: 1000,
        output: 100,
        series: [turn(0, 0)],
        children: [
          // Crossed the threshold 10 minutes before `SYNTHETIC_NOW_MS`.
          tool({
            id: 'z0',
            toolName: 'Bash',
            ordinal: 0,
            status: 'stalled',
            stalledSinceMs: SYNTHETIC_NOW_MS - 600_000,
            inputHash: hash('z0'),
          }),
          // Ran for 47 minutes and finished. NOT a stall under Component 13,
          // and it is here because the duration reading would call it the
          // bigger of the two.
          tool({
            id: 'z1',
            toolName: 'Agent',
            ordinal: 1,
            status: 'done',
            durationMs: 2_846_600,
            inputHash: hash('z1'),
          }),
        ],
      }),
    }),
  });

  // 13 — F9(c), joined from the committed OTel capture through the real join.
  const metrics = otelSlice('metrics');
  const sessionId = telemetrySessionId(metrics);
  const base: SessionState = {
    ...state({
      id: '13-telemetry-cost',
      root: agent({
        id: 'root',
        prompt: 1000,
        output: 100,
        series: [turn(0, 0)],
        children: [tool({ id: 'y0', toolName: 'Read', ordinal: 0, inputHash: hash('y0') })],
      }),
    }),
    // The join is BY `session.id`, so the fixture must carry the capture's own
    // id rather than a `synthetic-` one. That is the one place R8's naming rule
    // gives way, and it gives way to a real join rather than to convenience:
    // renaming the session would make `joinTelemetry` match nothing and the
    // fixture would silently manufacture no cost at all.
    sessionId,
  };
  const joined = joinTelemetry([base], metrics).states[0];
  if (joined === undefined || joined.telemetryCostUsd === undefined) {
    throw new Error('the OTel join produced no telemetry cost: fixture 13 would be vacuous');
  }
  out.push({
    id: '13-telemetry-cost',
    manufactures: "Claude Code's own OTel cost estimate, joined onto a session by session.id through the real joinTelemetry",
    state: joined,
  });

  // 14 — F15. One spawning call with no result, one with a result.
  out.push({
    id: '14-aborted-spawn',
    manufactures:
      'two spawned agents, one whose spawning Agent call carries no result and one whose spawning call carries one, both of which made a tool call',
    state: state({
      id: '14-aborted-spawn',
      root: agent({
        id: 'root',
        prompt: 1000,
        output: 100,
        series: [turn(0, 0)],
        children: [
          // The spawning call with NO result: the grafter writes `running`
          // when `resultPreview` is undefined, which is the structural form of
          // "no `tool_result` in the parent transcript".
          tool({ id: 'g0', toolName: 'Agent', ordinal: 0, status: 'running', inputHash: hash('a0') }),
          // The negative arm, one status away: the same tool, the same shape,
          // with a result. `done` and `error` both mean a result arrived.
          tool({ id: 'g1', toolName: 'Agent', ordinal: 1, status: 'done', inputHash: hash('a1') }),
          // BOTH subagents make a tool call, so neither is `silent`. Without
          // that, `resultUnreceived` and F8's flag would move together on this
          // fixture and a reader could not tell which fact a row reported.
          agent({
            id: 'unreceived',
            kind: 'subagent',
            spawnDepth: 1,
            prompt: 20,
            output: 2,
            series: [turn(0, 0)],
            children: [tool({ id: 'g2', toolName: 'Read', ordinal: 0, inputHash: hash('a2') })],
          }),
          agent({
            id: 'received',
            kind: 'subagent',
            spawnDepth: 1,
            prompt: 30,
            output: 3,
            series: [turn(0, 0)],
            children: [tool({ id: 'g3', toolName: 'Read', ordinal: 0, inputHash: hash('a3') })],
          }),
        ],
      }),
      // The join key F15 reads. Without these the session states nothing about
      // how its agents were spawned and the deriver reports `F15:cc` instead —
      // which is the OTHER arm, and the thirteen fixtures above cover it.
      spawnEdges: [
        { toolUseId: 'g0', agentId: 'unreceived', parentNodeId: 'root', depth: 1, recordedDepth: 1 },
        { toolUseId: 'g1', agentId: 'received', parentNodeId: 'root', depth: 1, recordedDepth: 1 },
      ],
    }),
  });

  return out;
}
