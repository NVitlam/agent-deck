/**
 * v0.7.0 Phase 1, DoD 1.9d/1.9e/1.9f/1.9g — the telemetry join.
 *
 * The corpus and the transcripts are the SAME sessions read through two
 * different taps, so this file joins real spans onto a real grafted tree rather
 * than onto a constructed one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, ToolNode, TreeNode } from '../model/events.js';
import { isAgentNode, isToolNode } from '../model/events.js';

import { joinTelemetry } from './join.js';
import {
  emptyTelemetryCounts,
  mergeSlices,
  parseOtlpBody,
  type OtelSignal,
  type TelemetrySlice,
} from './parse.js';

const CORPUS = fileURLToPath(new URL('../../fixtures/otel-cc-2.1.260/', import.meta.url));

function sliceOf(signal: OtelSignal): TelemetrySlice {
  const counts = emptyTelemetryCounts();
  const lines = readFileSync(`${CORPUS}${signal}.jsonl`, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { signal: OtelSignal; raw: string })
    .filter((line) => line.signal === signal);
  return mergeSlices(lines.map((line) => parseOtlpBody(line.raw, signal, counts)));
}

const TRACES = sliceOf('traces');
const METRICS = sliceOf('metrics');

/** A minimal tree carrying the given tool ids, so the join has something to hit. */
function stateWith(
  sessionId: string,
  tools: readonly Partial<ToolNode>[],
): SessionState {
  const children: TreeNode[] = tools.map((tool, index) => ({
    id: tool.id ?? `toolu_${String(index)}`,
    toolName: tool.toolName ?? 'Bash',
    status: 'done',
    inputPreview: '{}',
    inputHash: 'x'.repeat(64),
    ordinal: index,
    ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
  }));
  const root: AgentNode = {
    id: 'root',
    kind: 'main',
    label: 'root',
    status: 'done',
    spawnDepth: 0,
    children,
    startedAt: 0,
  };
  return {
    sessionId,
    projectSlug: 'p',
    workspaceMatch: true,
    liveness: 'idle',
    schemaOk: true,
    root,
    totals: { costUsd: 0 },
  };
}

function toolsOf(state: SessionState): ToolNode[] {
  const out: ToolNode[] = [];
  const walk = (node: TreeNode): void => {
    if (isToolNode(node)) {
      out.push(node);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(state.root);
  return out;
}

describe('the corpus really carries spans and cost, before anything is joined', () => {
  it('has tool spans and cost points', () => {
    expect(TRACES.toolSpans.length).toBeGreaterThan(0);
    expect(METRICS.costPoints.length).toBeGreaterThan(0);
  });
});

describe('DoD 1.9d — the join is by primary key, exact or discarded', () => {
  it('fills a duration on the node whose id the span names', () => {
    const span = TRACES.toolSpans[0];
    expect(span).toBeDefined();
    if (span === undefined) return;

    const state = stateWith(span.sessionId, [{ id: span.toolUseId }]);
    const { states, report } = joinTelemetry([state], TRACES);

    expect(report.spansMatched).toBeGreaterThan(0);
    expect(toolsOf(states[0] as SessionState)[0]?.durationMs).toBe(span.durationMs);
  });

  it('discards a span whose session this host has not read, and counts it', () => {
    const { states, report } = joinTelemetry([stateWith('a-session-nobody-read', [])], TRACES);
    expect(report.spansMatched).toBe(0);
    expect(report.spansUnmatched).toBe(TRACES.toolSpans.length);
    expect(states[0]?.telemetryCostUsd).toBeUndefined();
  });

  it('discards a span whose tool_use_id matches no node — no prefix, no fallback', () => {
    const span = TRACES.toolSpans[0];
    if (span === undefined) return;
    // A node whose id is a PREFIX of the span's. A fuzzy join would match it.
    const truncated = span.toolUseId.slice(0, span.toolUseId.length - 3);
    const { states, report } = joinTelemetry(
      [stateWith(span.sessionId, [{ id: truncated }])],
      TRACES,
    );
    expect(report.spansMatched).toBe(0);
    expect(toolsOf(states[0] as SessionState)[0]?.durationMs).toBeUndefined();
  });

  it('treats an UNMATCHED ToolNode as ordinary — the rejected Bash of session A', () => {
    /*
     * `toolu_01AbDNECE12Dz5RCYmmyxWMZ` is ordinal 14 of 32 in session A: a
     * `Bash` REJECTED BY INPUT VALIDATION before it executed. The transcript
     * records the attempt and its error; telemetry records tools that RAN.
     *
     * So a node with no span is not a defect, and this is the case that proves
     * it rather than a hypothetical: the join must leave it alone, report no
     * error, and still match its neighbours.
     */
    const rejected = 'toolu_01AbDNECE12Dz5RCYmmyxWMZ';
    const spanIds = new Set(TRACES.toolSpans.map((s) => s.toolUseId));
    // The control: telemetry really has no span for it.
    expect(spanIds.has(rejected)).toBe(false);

    const sessionA = TRACES.toolSpans[0]?.sessionId;
    expect(sessionA).toBeDefined();
    if (sessionA === undefined) return;
    const sibling = TRACES.toolSpans.find((s) => s.sessionId === sessionA);
    if (sibling === undefined) return;

    const state = stateWith(sessionA, [{ id: rejected }, { id: sibling.toolUseId }]);
    const { states, report } = joinTelemetry([state], TRACES);

    const tools = toolsOf(states[0] as SessionState);
    expect(tools[0]?.id).toBe(rejected);
    expect(tools[0]?.durationMs, 'the rejected call gains no duration').toBeUndefined();
    expect(tools[1]?.durationMs, 'its neighbour still joins').toBe(sibling.durationMs);
    expect(report.spansMatched).toBeGreaterThan(0);
  });
});

describe('the duration precedence is decided, and asserted BOTH ways', () => {
  it('never overwrites a duration the ENGINE stated', () => {
    /*
     * The engine wins. Every committed golden carries the engine-derived value,
     * so letting telemetry overwrite it would move goldens whenever a user
     * happened to have telemetry enabled — making their `settings.json` a
     * factor in whether this repository's fixtures reproduce.
     */
    const span = TRACES.toolSpans.find((s) => s.durationMs !== 12_345);
    if (span === undefined) return;
    const state = stateWith(span.sessionId, [{ id: span.toolUseId, durationMs: 12_345 }]);
    const { states, report } = joinTelemetry([state], TRACES);

    expect(toolsOf(states[0] as SessionState)[0]?.durationMs).toBe(12_345);
    expect(report.durationsKept).toBeGreaterThan(0);
    expect(report.durationsFilled).toBe(0);
  });

  it('fills a duration the engine did NOT state', () => {
    const span = TRACES.toolSpans[0];
    if (span === undefined) return;
    const state = stateWith(span.sessionId, [{ id: span.toolUseId }]);
    const { report } = joinTelemetry([state], TRACES);
    expect(report.durationsFilled).toBeGreaterThan(0);
    expect(report.durationsKept).toBe(0);
  });
});

describe('DoD 1.9f — cost is parsed and stored, and DELTA points SUM', () => {
  it('sums every point of a session rather than taking the last', () => {
    const sessionId = METRICS.costPoints[0]?.sessionId;
    expect(sessionId).toBeDefined();
    if (sessionId === undefined) return;

    const expected = METRICS.costPoints
      .filter((p) => p.sessionId === sessionId)
      .reduce((n, p) => n + p.usd, 0);
    // The control that this test discriminates at all: a single-point session
    // cannot tell summing from replacing.
    expect(METRICS.costPoints.filter((p) => p.sessionId === sessionId).length).toBeGreaterThan(1);

    const { states } = joinTelemetry([stateWith(sessionId, [])], METRICS);
    expect(states[0]?.telemetryCostUsd).toBeCloseTo(expected, 10);
  });

  it('leaves totals.costUsd ALONE — an estimate is not an engine-stated figure', () => {
    /*
     * `totals.costUsd` means "the engine reported this", and 0 there means NOT
     * COMPUTED. Phase 0 measured F9 as UNAVAILABLE on all three engines, so
     * merging an estimate into that field would make the two indistinguishable
     * at exactly the moment nothing else fills it.
     */
    const sessionId = METRICS.costPoints[0]?.sessionId;
    if (sessionId === undefined) return;
    const { states } = joinTelemetry([stateWith(sessionId, [])], METRICS);
    expect(states[0]?.totals.costUsd).toBe(0);
    expect(states[0]?.telemetryCostUsd).toBeGreaterThan(0);
  });

  it('discards a cost point naming a session this host has not read', () => {
    const { report } = joinTelemetry([stateWith('unknown-session', [])], METRICS);
    expect(report.costPointsApplied).toBe(0);
    expect(report.costPointsUnmatched).toBe(METRICS.costPoints.length);
  });
});

describe('DoD 1.9f — Phase 1 RENDERS nothing', () => {
  it('is read by no webview surface', async () => {
    /*
     * The field is stored and nothing draws it: F9(c) derivation is Phase 2 and
     * the cost-source label is Phase 4. Asserted rather than intended, because
     * "we did not render it" is exactly the kind of claim that quietly stops
     * being true.
     */
    const { readdirSync, readFileSync: read, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = fileURLToPath(new URL('../../webview/', import.meta.url));

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === 'wire' || entry === 'goldens') continue;
          walk(full);
          continue;
        }
        if (entry.endsWith('.svelte') || entry.endsWith('.ts')) files.push(full);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);

    const hits = files.filter((file) => read(file, 'utf8').includes('telemetryCostUsd'));
    expect(hits, `a webview file reads telemetryCostUsd: ${hits.join(', ')}`).toEqual([]);
  });
});

describe('DoD 1.9e — agentName is NOT set, and the reason is a measurement', () => {
  it('leaves agentName absent on every agent, even with the full corpus joined', () => {
    /*
     * Over the whole committed corpus, `agent.name` appears on 6 `api_request`
     * records and 30 metric points and NEVER carries `agent_id`; `agent_id`
     * appears on 4 of 40 tool spans and NEVER carries `agent.name`. The two do
     * not co-occur on any record, so there is no exact key from a name to an
     * `AgentNode`.
     *
     * Attaching the one observed name to the one subagent of a session would
     * work on this corpus and be a guess — which "exact or discarded" and G3
     * both forbid. So the field exists, nothing sets it, and this says so.
     */
    const sessionId = TRACES.toolSpans[0]?.sessionId;
    if (sessionId === undefined) return;
    const { states } = joinTelemetry([stateWith(sessionId, [])], TRACES);
    const root = states[0]?.root;
    expect(root).toBeDefined();
    if (root === undefined || !isAgentNode(root)) return;
    expect(root.agentName).toBeUndefined();
  });
});

describe('DoD 1.9g — telemetry absent changes nothing (G2)', () => {
  const base = stateWith('S', [{ id: 'toolu_1' }, { id: 'toolu_2', durationMs: 7 }]);

  it('is byte-identical with the channel ABSENT', () => {
    const empty: TelemetrySlice = {
      toolSpans: [],
      costPoints: [],
      counts: emptyTelemetryCounts(),
    };
    const { states } = joinTelemetry([base], empty);
    expect(JSON.stringify(states[0])).toBe(JSON.stringify(base));
  });

  it('returns the SAME OBJECT when nothing matched, so no diff is produced', () => {
    // Stronger than deep equality, and it is the property that matters in a
    // live panel: a new object with equal contents would still be a new
    // snapshot for the differ to walk.
    const { states } = joinTelemetry([base], TRACES);
    expect(states[0]).toBe(base);
  });

  it('does not mutate the input state', () => {
    const span = TRACES.toolSpans[0];
    if (span === undefined) return;
    const input = stateWith(span.sessionId, [{ id: span.toolUseId }]);
    const before = JSON.stringify(input);
    joinTelemetry([input], TRACES);
    // The caller's previous snapshot is what a diff is computed against;
    // mutating it in place would make that diff empty.
    expect(JSON.stringify(input)).toBe(before);
  });
});
