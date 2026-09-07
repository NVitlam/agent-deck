/**
 * v0.7.0 Phase 1, DoD 1.9d/1.9e/1.9f/1.9g — the telemetry join.
 *
 * ## THE TREES HERE ARE CONSTRUCTED, AND THE FIRST VERSION OF THIS HEADER SAID
 * ## OTHERWISE
 *
 * It claimed this file "joins real spans onto a real grafted tree rather than
 * onto a constructed one". That was false: every test builds its tree with
 * {@link stateWith} and takes the tool ids from the telemetry. Caught by
 * `phase-verifier`.
 *
 * The SPANS are real — replayed from the committed capture — and the tool ids
 * they carry are real. The TREES are minimal stand-ins, and they have to be:
 * the two sessions this corpus was captured from have no committed transcript
 * under `fixtures/`, so there is no grafted tree to join onto. That is a real
 * limit on what this file proves, and it is the reason the rejected-`Bash` case
 * below is pinned by NAME against the corpus rather than by a tree walk.
 *
 * Closing it needs the transcripts of `8c1910bb…` and `f7f0eef9…` committed
 * beside the telemetry — the same sessions through both taps. Recorded, not
 * done.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, ToolNode, TreeNode } from '../model/events.js';
import { isToolNode } from '../model/events.js';

import { joinTelemetry } from './join.js';
import {
  TELEMETRY_KEPT_KEYS,
  emptyTelemetryCounts,
  mergeSlices,
  parseOtlpBody,
  type OtelSignal,
  type TelemetrySlice,
} from './parse.js';

/** An OTLP attribute value (`{ stringValue: … }`), reduced to its string. */
function stringAttr(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = (value as { stringValue?: unknown }).stringValue;
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

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

/**
 * DoD 1.9e — **CLOSED UNAVAILABLE by the user on 2026-09-06.** `agentName` is
 * removed from `AgentNode` and from Component 12; `agent-deck-spec.md` §L
 * carries the dated line.
 *
 * WHAT THIS BLOCK ASSERTS, AND WHY IT IS NOT "THE FIELD IS UNDEFINED". The
 * earlier form checked `root.agentName === undefined` on a joined state. That
 * assertion cannot fail once the field is gone — it would be a test of the
 * TypeScript compiler, satisfied by any object in the world, and this
 * repository has a long ledger of exactly that shape passing while proving
 * nothing.
 *
 * So the subject is the MEASUREMENT the decision rests on, read off the raw
 * corpus rather than off our own parse boundary: `agent.name` and `agent_id`
 * never appear on the same record. A capture where they DO co-occur turns this
 * red, which is precisely the signal to reopen the decision — not a regression
 * to route around.
 */
describe('DoD 1.9e — agentName is UNAVAILABLE, and this is the measurement', () => {
  /** Every attribute bag in a raw OTLP body, whatever signal it came from. */
  function attributeBags(): Record<string, unknown>[] {
    const bags: Record<string, unknown>[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      const attrs = record['attributes'];
      if (Array.isArray(attrs)) {
        const bag: Record<string, unknown> = {};
        for (const attr of attrs) {
          if (attr === null || typeof attr !== 'object') continue;
          const key = (attr as { key?: unknown }).key;
          if (typeof key === 'string') bag[key] = (attr as { value?: unknown }).value;
        }
        bags.push(bag);
      }
      for (const child of Object.values(record)) walk(child);
    };
    for (const signal of ['traces', 'metrics', 'logs'] as const) {
      for (const line of readFileSync(`${CORPUS}${signal}.jsonl`, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        walk(JSON.parse((JSON.parse(line) as { raw: string }).raw));
      }
    }
    return bags;
  }

  const BAGS = attributeBags();

  it('CONTROL: the corpus really states both attributes, on their own records', () => {
    // Without this, "they never co-occur" is satisfied by a corpus that
    // mentions neither — a vacuous zero, which is what this file is for.
    expect(BAGS.filter((b) => 'agent.name' in b).length).toBe(36);
    expect(BAGS.filter((b) => 'agent_id' in b).length).toBe(10);
  });

  it('never states both on one record, so no exact key joins a name to an agent', () => {
    const both = BAGS.filter((b) => 'agent.name' in b && 'agent_id' in b);
    expect(
      both.length,
      'agent.name and agent_id now co-occur: DoD 1.9e can be reopened',
    ).toBe(0);
  });

  it('and the fallback guess is demonstrably wrong on this corpus', () => {
    /*
     * "The session had one subagent, so the one name is its" — the guess that
     * looks harmless. Session `f7f0eef9…` carries TWO distinct `agent_id`s
     * against ONE distinct `agent.name`, so the guess is not merely unproven,
     * it is false here. "Exact or discarded" and G3 both forbid it.
     */
    const bySession = new Map<string, { names: Set<string>; agents: Set<string> }>();
    for (const bag of BAGS) {
      const session = stringAttr(bag['session.id']);
      if (session === undefined) continue;
      const entry = bySession.get(session) ?? { names: new Set(), agents: new Set() };
      const name = stringAttr(bag['agent.name']);
      const agent = stringAttr(bag['agent_id']);
      if (name !== undefined) entry.names.add(name);
      if (agent !== undefined) entry.agents.add(agent);
      bySession.set(session, entry);
    }
    const overcommitted = [...bySession.values()].filter(
      (e) => e.names.size === 1 && e.agents.size > 1,
    );
    expect(overcommitted.length).toBeGreaterThan(0);
  });

  it('agent.name does not cross the parse boundary at all', () => {
    // The allow-list, not a rule someone has to remember: `agent.name` is not
    // in TELEMETRY_KEPT_KEYS, so it is dropped by construction.
    expect(TELEMETRY_KEPT_KEYS.has('agent.name')).toBe(false);
    expect(TELEMETRY_KEPT_KEYS.has('agent_id')).toBe(true);
  });
});

describe('DoD 1.9g — why no golden and no wire file can move in Phase 1', () => {
  it('is imported by NO production module, which is the real guarantee', async () => {
    /*
     * DoD 1.9g asks that every golden and wire file be byte-identical with the
     * telemetry channel absent, present-and-empty, and throwing. The
     * state-level assertions below cover the three shapes on a constructed
     * state; THIS is what makes the claim true of the committed artefacts, and
     * it is a different and stronger statement: nothing in production calls
     * `joinTelemetry` at all, so no golden and no wire recorder can reach it.
     *
     * Phase 3 mounts the route and gives it a caller. On that day this test
     * goes red, and it should — it is the tripwire that says "the sweep 1.9g
     * describes now has to be written for real".
     *
     * Recorded rather than glossed: `phase-verifier` found the original 1.9g
     * tests asserting on one hand-built state while the DoD's sentence spoke
     * about every golden and wire file.
     */
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const roots = ['src', 'webview', 'scripts'].map((d) =>
      fileURLToPath(new URL(`../../${d}/`, import.meta.url)),
    );
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (/\.(ts|mjs|svelte)$/.test(entry)) files.push(full);
      }
    };
    for (const root of roots) walk(root);
    expect(files.length).toBeGreaterThan(100);

    /*
     * NARROWED IN v0.7.0 PHASE 1b, AND THE NARROWING IS ITSELF A CLAIM.
     *
     * The shared listener relays a telemetry SLICE between windows (DoD 1b.5),
     * so `TelemetrySlice` and `OtelSignal` — the TYPES — now appear in
     * `src/hooks/`. A type import is erased at build time: it emits no code,
     * calls nothing, and cannot reach a recorder. The guarantee 1.9g is about
     * is that no golden and no wire file can move, and a name that does not
     * exist at runtime cannot move one.
     *
     * So the scan drops TYPE imports and keeps everything else. Two things
     * stop that being a convenient loophole: the value-import ban below is
     * unchanged, `joinTelemetry` is banned BY NAME anywhere in production, and
     * `egress.test.ts` asserts the built artefact contains no telemetry parser
     * at all — which is the same claim checked on the bytes that ship rather
     * than on the text that produced them.
     *
     * Phase 3 mounts the route and gives it a real caller. On that day this
     * still goes red, because a route has to import `parseOtlpBody` as a
     * VALUE.
     */
    const withoutTypeImports = (text: string): string =>
      text.replace(/^\s*import\s+type\s[^;]*;/gm, '');

    const importers = files.filter((file) => {
      // The module's own directory and every test are exempt.
      if (file.includes(`${'src'}${String.fromCharCode(92)}otel`)) return false;
      if (file.includes('/otel/')) return false;
      if (file.endsWith('.test.ts') || file.endsWith('.testkit.ts')) return false;
      const text = withoutTypeImports(readFileSync(file, 'utf8'));
      return /from '.*otel\/(join|parse)\.js'|require\(.*otel/.test(text);
    });
    expect(importers, `a production module reaches otel at runtime: ${importers.join(', ')}`).toEqual([]);

    // THE NAME BAN, unchanged in strength and not narrowed by anything above:
    // the function whose CALL would move a golden may not be named in
    // production at all, type import or no type import.
    const callers = files.filter((file) => {
      if (file.includes(`${'src'}${String.fromCharCode(92)}otel`)) return false;
      if (file.includes('/otel/')) return false;
      if (file.endsWith('.test.ts') || file.endsWith('.testkit.ts')) return false;
      return readFileSync(file, 'utf8').includes('joinTelemetry');
    });
    expect(callers, `a production module names joinTelemetry: ${callers.join(', ')}`).toEqual([]);

    // VACUITY CONTROLS. A narrowed matcher that can no longer see anything
    // reports an empty list for the wrong reason, so both halves are shown to
    // still catch what they are for.
    expect(withoutTypeImports("import type { X } from '../otel/parse.js';")).not.toMatch(/otel/);
    expect(withoutTypeImports("import { parseOtlpBody } from '../otel/parse.js';")).toMatch(
      /from '.*otel\/(join|parse)\.js'/,
    );
    expect(withoutTypeImports("import { joinTelemetry } from '../otel/join.js';")).toContain(
      'joinTelemetry',
    );
  }, 60_000);
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
