/**
 * v0.7.1 Phase 6 — Component 12 through the PRODUCT: DoD 6.3, 6.4, 6.6, 6.7.
 *
 * What is real here, because that is the point (CLAUDE.md D4):
 *
 *   REAL   the `AgentDeckHost`, its `AgentDeckDataPath`, the shared listener on
 *          a genuinely bound loopback socket, the watcher/tailer/fingerprint/
 *          grafter/liveness/stall chain over staged transcripts, the stats
 *          pipeline and store, the relay to a second window, and every
 *          telemetry body — posted byte for byte from
 *          `fixtures/otel-cc-2.1.260/` over HTTP.
 *   STAGED the transcripts: committed CC corpora renamed to the telemetry's
 *          session ids with some tool ids remapped onto its span ids
 *          (`src/model/telemetry.testkit.ts` says exactly what and why).
 *
 * No test here builds a `TelemetrySlice`, calls `joinTelemetry`, or constructs
 * a `SessionState` by hand. Every join is the host's, reached by POSTing to the
 * port.
 */

import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentDeckHost,
  CONFIG_SECTION,
  activate,
  currentHost,
  deactivate,
  DEFAULT_LIVENESS_THRESHOLD_MS,
  DEFAULT_PORT,
  DEFAULT_PREVIEW_BYTES,
  DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES,
  statsSettingDefaults,
  type AgentDeckSettings,
  type DataPathEmission,
  type PanelSurface,
} from './extension.js';
import { formatCounters } from './bridge/diagnostics.js';
import type { DiagnosticsSink } from './bridge/diagnostics.js';
import { TELEMETRY_PATHS } from './hooks/listener.js';
import { EVENTS_PATH } from './hooks/relay.js';
import type { HostToWebviewMessage, SessionState, TreeNode } from './model/events.js';
import { isAgentNode } from './model/events.js';
import { ManualTime, slugifyWorkspace } from './parser/tailer.js';
import { OPENCODE_DATA_ROOT_ENV } from './opencode/index.js';
import { CODEX_HOME_VAR } from './codex/index.js';
import { emptyTelemetryCounts, parseOtlpBody } from './otel/parse.js';
import { PENDING_SESSIONS_MAX } from './model/telemetry.js';
import { createExtensionContext, mock, resetVscodeMock } from '../test/vscode-mock.js';
import {
  CONTENT_KEYS,
  IDENTITY_NAMES,
  IDENTITY_PLACEHOLDERS,
  IDLE_SOURCE,
  OTEL_SESSION_A,
  OTEL_SESSION_B,
  STALLED_SOURCE,
  otelEnvelopes,
  postTo,
  spanToolIds,
  stageSessionAs,
  waitFor,
  type OtelEnvelope,
  type StagedSession,
} from './model/telemetry.testkit.js';

// ---------------------------------------------------------------------------
// Scaffolding — OS temp only; nothing is written under fixtures/ (G1, G6)
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];
const liveHosts: AgentDeckHost[] = [];
const openStreams: { destroy: () => void }[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-deck-otel-'));
  tempRoots.push(dir);
  return dir;
}

const savedOpencodeRoot = process.env[OPENCODE_DATA_ROOT_ENV];
const savedCodexHome = process.env[CODEX_HOME_VAR];

beforeEach(async () => {
  // Never read the developer's real OpenCode store or Codex root: an empty
  // store directory and a Codex root that does not exist (the recorded
  // `extension.test.ts` treatment).
  process.env[OPENCODE_DATA_ROOT_ENV] = await tempDir();
  process.env[CODEX_HOME_VAR] = join(await tempDir(), 'no-codex-root-here');
});

afterEach(async () => {
  for (const stream of openStreams.splice(0)) stream.destroy();
  for (const host of liveHosts.splice(0)) await host.dispose();
  if (savedOpencodeRoot === undefined) delete process.env[OPENCODE_DATA_ROOT_ENV];
  else process.env[OPENCODE_DATA_ROOT_ENV] = savedOpencodeRoot;
  if (savedCodexHome === undefined) delete process.env[CODEX_HOME_VAR];
  else process.env[CODEX_HOME_VAR] = savedCodexHome;
  for (const dir of tempRoots.splice(0)) await rm(dir, { recursive: true, force: true });
});

function settings(overrides: Partial<AgentDeckSettings> = {}): AgentDeckSettings {
  return {
    port: DEFAULT_PORT,
    livenessThresholdMs: DEFAULT_LIVENESS_THRESHOLD_MS,
    previewBytes: DEFAULT_PREVIEW_BYTES,
    'codex.maxTranscriptBytes': DEFAULT_CODEX_MAX_TRANSCRIPT_BYTES,
    ...statsSettingDefaults(),
    'telemetry.enabled': true,
    ...overrides,
  };
}

/** A free loopback port, taken and released — retried below on a lost race. */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** A panel surface that records what the deck was sent. */
function recordingPanel(posted: HostToWebviewMessage[]): PanelSurface {
  const none = (): (() => void) => () => {};
  return {
    cspSource: "'self' https://*.vscode-cdn.net",
    setHtml: () => {},
    asWebviewUri: (...segments: string[]) => `webview://ext/${segments.join('/')}`,
    postMessage: (message) => {
      posted.push(message);
    },
    onDidReceiveMessage: none,
    onDidBecomeVisible: none,
    onDidDispose: none,
    reveal: () => {},
    dispose: () => {},
  };
}

interface Rig {
  host: AgentDeckHost;
  port: number;
  emissions: DataPathEmission[];
  posted: HostToWebviewMessage[];
  lines: string[];
  staged: StagedSession[];
  scheduler: ManualTime;
}

interface RigOptions {
  /** Which telemetry sessions to stage, and from what. */
  stage: ('idle-as-A' | 'stalled-as-B')[];
  /** The leader's port; omitted to take a free one (with retry). */
  port?: number;
  /** A shared staged projects root, for two windows on one machine. */
  shared?: { projectsRoot: string; workspacePath: string; staged: StagedSession[] };
  /** Keep a store (DoD 6.3's provenance arm). */
  stats?: boolean;
  /** Clock offset: an hour ahead makes a running call stalled and a session idle. */
  aheadMs?: number;
  /** `agentDeck.pricing`, for the arm where a user's prices are the fallback. */
  pricing?: Record<string, unknown>;
}

/** Stage the chosen sessions into a fresh projects root under a temp workspace's slug. */
async function stage(which: RigOptions['stage']): Promise<RigOptions['shared'] & object> {
  const projectsRoot = await tempDir();
  const workspacePath = join(await tempDir(), 'ws');
  const slugDir = join(projectsRoot, slugifyWorkspace(workspacePath));
  const staged: StagedSession[] = [];
  if (which.includes('idle-as-A')) {
    staged.push(
      await stageSessionAs(slugDir, {
        ...IDLE_SOURCE,
        asSessionId: OTEL_SESSION_A,
        spanIds: spanToolIds(OTEL_SESSION_A),
      }),
    );
  }
  if (which.includes('stalled-as-B')) {
    staged.push(
      await stageSessionAs(slugDir, {
        slugDir: STALLED_SOURCE.slugDir,
        sessionId: STALLED_SOURCE.sessionId,
        asSessionId: OTEL_SESSION_B,
        spanIds: spanToolIds(OTEL_SESSION_B),
        pinFirst: STALLED_SOURCE.stalledToolId,
      }),
    );
  }
  return { projectsRoot, workspacePath, staged };
}

async function rig(options: RigOptions): Promise<Rig> {
  const shared = options.shared ?? (await stage(options.stage));
  const ahead = options.aheadMs ?? 3_600_000;
  const scheduler = new ManualTime(Date.now());
  const statsDir = options.stats === true ? await tempDir() : undefined;
  const sinkLines: string[] = [];
  const sink: DiagnosticsSink = {
    appendLine: (line: string) => {
      sinkLines.push(line);
    },
    show: () => {},
    dispose: () => {},
  };

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = options.port ?? (await freePort());
    const emissions: DataPathEmission[] = [];
    const posted: HostToWebviewMessage[] = [];
    const host = new AgentDeckHost({
      workspacePath: shared.workspacePath,
      projectsRoot: shared.projectsRoot,
      settings: settings({ port, ...(options.pricing === undefined ? {} : { pricing: options.pricing }) }),
      onEmission: (payload) => {
        emissions.push(payload);
      },
      createPanel: () => recordingPanel(posted),
      createDiagnosticsSink: () => sink,
      // A clock an hour ahead of the files' real mtimes: the staged sessions
      // read as idle, and a call that never returned reads as stalled.
      now: () => Date.now() + ahead,
      // The host's own timers (the coalesced emit, the stats idle flush) are
      // MANUAL, so nothing fires unless a test advances it. Pumps are explicit.
      scheduler,
      tickMs: 0,
      ...(statsDir === undefined ? {} : { statsDir }),
    });
    liveHosts.push(host);
    await host.start();
    if (options.port === undefined && host.dataPath.diagnostics.bindError?.code === 'EADDRINUSE') {
      liveHosts.splice(liveHosts.indexOf(host), 1);
      await host.dispose();
      continue;
    }
    return { host, port, emissions, posted, lines: sinkLines, staged: shared.staged, scheduler };
  }
  throw new Error('six free ports were all taken between probe and bind');
}

/**
 * Pump and return what the host emitted (`raw`, what the deck is handed) and
 * what the STATS LAYER WAS HANDED (`joined`) — the value that left the host,
 * never a mirror the joiner keeps of it (M8).
 */
function pumpOnce(r: Rig): { raw: readonly SessionState[]; joined: readonly SessionState[] } {
  const before = r.emissions.length;
  r.host.dataPath.pump();
  const emission = r.emissions[before];
  expect(emission, 'a pump emitted nothing').toBeDefined();
  const observed = r.host.statsObserved;
  expect(observed, 'the stats layer was handed nothing').not.toBeNull();
  return { raw: emission?.emission.sessions ?? [], joined: observed?.sessions ?? [] };
}

const ENVELOPES: readonly OtelEnvelope[] = otelEnvelopes();

async function replayCorpus(port: number, envelopes: readonly OtelEnvelope[] = ENVELOPES): Promise<void> {
  for (const envelope of envelopes) {
    const reply = await postTo(port, TELEMETRY_PATHS[envelope.signal], envelope.raw);
    expect(reply.status, `${envelope.signal} ${envelope.receivedAt}`).toBe(200);
  }
}

/** Every liveness-bearing field of a state: the session enum, and per node its status and stall instant. */
function livenessOf(states: readonly SessionState[]): unknown {
  const walk = (node: TreeNode): unknown[] => {
    if (isAgentNode(node)) {
      return [{ id: node.id, status: node.status }, ...node.children.flatMap(walk)];
    }
    return [{ id: node.id, status: node.status, stalledSinceMs: node.stalledSinceMs ?? null }];
  };
  return states.map((s) => ({ id: s.sessionId, liveness: s.liveness, nodes: walk(s.root) }));
}

function toolById(state: SessionState | undefined, id: string): TreeNode | undefined {
  if (state === undefined) return undefined;
  const walk = (node: TreeNode): TreeNode | undefined => {
    if (!isAgentNode(node)) return node.id === id ? node : undefined;
    for (const child of node.children) {
      const found = walk(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(state.root);
}

/** The corpus's per-session census, through the real parse boundary. */
function census(envelopes: readonly OtelEnvelope[] = ENVELOPES): {
  costBySession: Map<string, number>;
  costPoints: Map<string, number>;
  sessionCounts: string[];
  spans: number;
} {
  const counts = emptyTelemetryCounts();
  const costBySession = new Map<string, number>();
  const costPoints = new Map<string, number>();
  const sessionCounts: string[] = [];
  let spans = 0;
  for (const e of envelopes) {
    const slice = parseOtlpBody(e.raw, e.signal, counts);
    spans += slice.toolSpans.length;
    sessionCounts.push(...slice.sessionCounts);
    for (const p of slice.costPoints) {
      costBySession.set(p.sessionId, (costBySession.get(p.sessionId) ?? 0) + p.usd);
      costPoints.set(p.sessionId, (costPoints.get(p.sessionId) ?? 0) + 1);
    }
  }
  return { costBySession, costPoints, sessionCounts, spans };
}

const SESSION_COUNT = '"claude_code.session.count"';

interface MetricsBody {
  resourceMetrics: {
    resource?: unknown;
    scopeMetrics: {
      scope?: unknown;
      metrics: {
        name: string;
        sum?: { dataPoints: { attributes: { key: string; value: unknown }[] }[] };
      }[];
    }[];
  }[];
}

/**
 * The corpus with every `claude_code.session.count` metric removed from the
 * bodies that carry one — DoD 6.3b's "same replay, count points stripped".
 * Every other byte of every body, and every other body, is the capture's.
 */
function withoutSessionCounts(envelopes: readonly OtelEnvelope[]): OtelEnvelope[] {
  return envelopes.map((e) => {
    if (e.signal !== 'metrics' || !e.raw.includes(SESSION_COUNT)) return e;
    const body = JSON.parse(e.raw) as MetricsBody;
    for (const resource of body.resourceMetrics) {
      for (const scope of resource.scopeMetrics) {
        scope.metrics = scope.metrics.filter((m) => m.name !== 'claude_code.session.count');
      }
    }
    return { ...e, raw: JSON.stringify(body) };
  });
}

/**
 * One metrics body carrying `ids.length` session-count points, each a copy of
 * the corpus's own point with only its `session.id` changed.
 */
function sessionCountBody(ids: readonly string[]): string {
  const source = ENVELOPES.find((e) => e.signal === 'metrics' && e.raw.includes(SESSION_COUNT));
  if (source === undefined) throw new Error('the corpus carries no session.count body');
  const body = JSON.parse(source.raw) as MetricsBody;
  for (const resource of body.resourceMetrics) {
    for (const scope of resource.scopeMetrics) {
      const metric = scope.metrics.find((m) => m.name === 'claude_code.session.count');
      const point = metric?.sum?.dataPoints[0];
      if (metric === undefined || metric.sum === undefined || point === undefined) continue;
      const points = ids.map((id) => ({
        ...point,
        attributes: point.attributes.map((a) => (a.key === 'session.id' ? { key: a.key, value: { stringValue: id } } : a)),
      }));
      return JSON.stringify({
        resourceMetrics: [
          { resource: resource.resource, scopeMetrics: [{ scope: scope.scope, metrics: [{ ...metric, sum: { ...metric.sum, dataPoints: points } }] }] },
        ],
      });
    }
  }
  throw new Error('the session.count body has no data point');
}

/**
 * Stage session B into a running host's slug dir and wait until EVERY staged
 * call is in its emitted tree — a session that starts late.
 *
 * "Grafted" is not enough: the graft that first makes B appear can be of a
 * partial read, with a tree holding no tool node at all (measured, M26 on
 * 1e3abc1). An assertion about B's spans made at that pump compares an empty
 * tree with an empty tree and cannot fail.
 *
 * It waits on the MODEL and does NOT pump (changed 2026-09-11): a span is
 * judged at the first pump after it arrives, so a helper that pumped would
 * decide, invisibly, which pump that is. The caller's next pump is the first
 * to emit B, and B's tree is whole when it does.
 */
async function stageLate(r: Rig): Promise<StagedSession> {
  const slugDir = r.host.dataPath.watcher.lastDiscovery?.slugDir;
  expect(slugDir, 'the host has not discovered its slug dir').toBeDefined();
  const grafts = r.host.dataPath.diagnostics.grafts;
  const staged = await stageSessionAs(slugDir as string, {
    ...IDLE_SOURCE,
    asSessionId: OTEL_SESSION_B,
    spanIds: spanToolIds(OTEL_SESSION_B),
  });
  await waitFor(
    () => r.host.dataPath.diagnostics.grafts > grafts && r.host.dataPath.model.hasSession(OTEL_SESSION_B),
    'the late session to be discovered and grafted',
    30_000,
  );
  const want = [...staged.remapped.values()];
  expect(want.length, 'the late staging placed no span id').toBeGreaterThan(0);
  await waitFor(
    () => {
      const b = r.host.dataPath.model.sessionState(OTEL_SESSION_B);
      return want.every((id) => toolById(b, id) !== undefined);
    },
    'every staged call of the late session to be in its tree',
    30_000,
  );
  return staged;
}

// ---------------------------------------------------------------------------
// DoD 6.3 — the join, wired; telemetry is content, never activity
// ---------------------------------------------------------------------------

describe('DoD 6.3 — the host joins the route\'s slices onto the live states, and touches no liveness', () => {
  it('an idle session and a stalled one: liveness byte-identical, cost and durations joined', async () => {
    const r = await rig({ stage: ['idle-as-A', 'stalled-as-B'] });
    const before = pumpOnce(r);
    const a0 = before.raw.find((s) => s.sessionId === OTEL_SESSION_A);
    const b0 = before.raw.find((s) => s.sessionId === OTEL_SESSION_B);

    // CONTROLS on the subjects, before any telemetry: both sessions grafted
    // under the telemetry's ids, one idle with nothing stalled, one holding the
    // real never-returned call of `fixtures/cc-2.1.260` as `stalled`.
    expect(a0?.schemaOk).toBe(true);
    expect(b0?.schemaOk).toBe(true);
    expect(a0?.liveness).toBe('idle');
    expect(JSON.stringify(livenessOf([a0 as SessionState]))).not.toContain('"stalled"');
    const pinnedSpan = r.staged[1]?.remapped.get(STALLED_SOURCE.stalledToolId);
    expect(pinnedSpan).toBeDefined();
    const stalledBefore = toolById(b0, pinnedSpan as string);
    expect(stalledBefore?.status).toBe('stalled');
    expect(stalledBefore !== undefined && !isAgentNode(stalledBefore) ? stalledBefore.durationMs : 'n/a').toBeUndefined();
    const livenessBefore = JSON.stringify(livenessOf(before.raw));
    const activityBefore = JSON.stringify([...(r.emissions.at(-1)?.emission.lastActivityAt ?? [])]);

    await replayCorpus(r.port);
    const after = pumpOnce(r);

    // THE CONTENT ARRIVED (the controls the DoD names).
    const report = r.host.telemetry.lastReport;
    expect(report?.spansMatched ?? 0).toBeGreaterThan(0);
    expect(report?.costPointsApplied ?? 0).toBeGreaterThan(0);
    const { costBySession } = census();
    const a1 = after.joined.find((s) => s.sessionId === OTEL_SESSION_A);
    const b1 = after.joined.find((s) => s.sessionId === OTEL_SESSION_B);
    expect(a1?.telemetryCostUsd).toBeCloseTo(costBySession.get(OTEL_SESSION_A) ?? Number.NaN, 10);
    expect(b1?.telemetryCostUsd).toBeCloseTo(costBySession.get(OTEL_SESSION_B) ?? Number.NaN, 10);

    // THE STALLED CALL: stays stalled, and gains the duration telemetry states
    // — the engine stated none for a call that never returned.
    const stalledAfter = toolById(b1, pinnedSpan as string);
    expect(stalledAfter?.status).toBe('stalled');
    expect(stalledAfter !== undefined && !isAgentNode(stalledAfter) ? stalledAfter.durationMs : undefined).toBeGreaterThan(0);

    // THE ENGINE WINS where it stated a duration: every call of A that a span
    // landed on AND that the engine had already timed keeps the engine's
    // value, byte for byte.
    expect(report?.durationsKept ?? 0).toBeGreaterThan(0);
    const aRaw = after.raw.find((s) => s.sessionId === OTEL_SESSION_A);
    let engineTimed = 0;
    for (const spanId of r.staged[0]?.remapped.values() ?? []) {
      const rawNode = toolById(aRaw, spanId);
      const joinedNode = toolById(a1, spanId);
      if (rawNode === undefined || isAgentNode(rawNode) || rawNode.durationMs === undefined) continue;
      engineTimed += 1;
      expect(joinedNode !== undefined && !isAgentNode(joinedNode) ? joinedNode.durationMs : undefined, spanId).toBe(
        rawNode.durationMs,
      );
    }
    expect(engineTimed, 'no engine-timed call received a span').toBeGreaterThan(0);

    // LIVENESS, byte-identical: before telemetry vs after, and the raw
    // emission vs what the stats layer observed from the same pump.
    expect(JSON.stringify(livenessOf(after.raw))).toBe(livenessBefore);
    expect(JSON.stringify(livenessOf(after.joined))).toBe(livenessBefore);
    // ...and the provenance gate's one input is untouched.
    expect(JSON.stringify([...(r.emissions.at(-1)?.emission.lastActivityAt ?? [])])).toBe(activityBefore);

    // THE DECK IS NOT FED: the raw emission carries no telemetry at all, and
    // the joined states are different objects only where telemetry landed.
    expect(JSON.stringify(after.raw)).not.toContain('telemetryCostUsd');
    expect(after.joined).not.toBe(after.raw);
    expect(after.joined.map((s) => s.sessionId)).toStrictEqual(after.raw.map((s) => s.sessionId));
    // ...and on the WIRE: a panel opened now is sent a full snapshot from a
    // pump that runs with the telemetry already held, so whatever the deck is
    // handed is on this list — and none of it carries telemetry.
    r.host.open();
    const snapshots = r.posted.filter((m) => m.type === 'snapshot');
    expect(snapshots.length, 'the new panel was sent no snapshot').toBeGreaterThan(0);
    expect(JSON.stringify(snapshots)).toContain(OTEL_SESSION_B);
    expect(JSON.stringify(r.posted)).not.toContain('telemetryCostUsd');
  }, 120_000);

  it('a session present only in telemetry creates nothing, and its rows are counted', async () => {
    const r = await rig({ stage: ['idle-as-A'] });
    pumpOnce(r);
    await replayCorpus(r.port);
    const after = pumpOnce(r);

    expect(after.joined.map((s) => s.sessionId)).toStrictEqual([OTEL_SESSION_A]);
    expect(r.host.stats).toBeUndefined();
    const { costPoints } = census();
    // B's spans are not kept (B is never held), so the pump counts every one.
    // B's cost and count points are HELD for B, not counted: they could still
    // join if B appeared, and are counted only if their slot is evicted
    // (ruling 2026-09-11).
    expect(costPoints.get(OTEL_SESSION_B) ?? 0).toBeGreaterThan(0);
    expect(r.host.telemetry.unmatched.metrics).toBe(0);
    expect(r.host.telemetry.pendingSessions).toBe(1);
    const unplacedA = r.staged[0]?.unplaced.length ?? Number.NaN;
    expect(r.host.telemetry.unmatched.traces).toBe(spanToolIds(OTEL_SESSION_B).length + unplacedA);
    // CONTROL: A's own rows DID land, so the zero-creation is not a join that
    // placed nothing anywhere.
    expect(after.joined[0]?.telemetryCostUsd).toBeGreaterThan(0);
  }, 120_000);

  /*
   * A SESSION THAT STARTS AFTER THE WINDOW OPENED — the ordinary case, and the
   * one no test here reached until the phase verifier froze the joiner's live
   * set at the first emission (V5) and dropped its held-sessions filter (V8),
   * and all eight host tests stayed green. (6.3b then narrowed that filter to
   * spans: a count point and cost are held for a session not yet shown.) Both
   * arms below stage session B
   * into the projects root only AFTER the host is running, so the watcher,
   * tailer and grafter discover it the way a new Claude Code session is
   * discovered ({@link stageLate}).
   */
  it('a session that appears AFTER the first pump is joined once it is held', async () => {
    const r = await rig({ stage: ['idle-as-A'] });
    pumpOnce(r);
    await stageLate(r);
    const mid = pumpOnce(r);
    expect(mid.raw.map((s) => s.sessionId).sort()).toStrictEqual([OTEL_SESSION_A, OTEL_SESSION_B].sort());

    await replayCorpus(r.port);
    const after = pumpOnce(r);
    const { costBySession } = census();
    const b = after.joined.find((s) => s.sessionId === OTEL_SESSION_B);
    expect(b?.telemetryCostUsd).toBeCloseTo(costBySession.get(OTEL_SESSION_B) ?? Number.NaN, 10);
    expect(r.host.telemetry.unmatched.metrics).toBe(0);
    // B held when its spans arrived: they join too — the control for the
    // spans arm of the next test, where the same spans arrive too early.
    expect(r.host.telemetry.lastReport?.spansMatched).toBeGreaterThan(r.staged[0]?.remapped.size ?? Number.NaN);
  }, 120_000);

  it('rows that arrive BEFORE their session is held: the count point and cost are applied once it is; spans whose session the next pump does not show are dropped and counted (DoD 6.3b, ruling 2026-09-11)', async () => {
    /*
     * The ORDER A REAL SESSION PRODUCES. In both captured sessions the
     * session.count point arrives before the first prompt, and the transcript
     * starts at that prompt, so no window can hold the session when its count
     * point lands. A joiner that kept rows only for sessions held at arrival
     * (as 6.3 shipped) would leave every such session's cost unselected under
     * 6.3b. Here every one of B's rows arrives before B's transcript exists.
     */
    const r = await rig({ stage: ['idle-as-A'], stats: true });
    pumpOnce(r);
    await replayCorpus(r.port);
    const { costPoints, costBySession } = census();
    // At arrival B matched nothing; its count point and cost are HELD for it,
    // and a held row is not unmatched (ruling 2026-09-11) — it joins below.
    expect(costPoints.get(OTEL_SESSION_B) ?? 0).toBeGreaterThan(0);
    expect(r.host.telemetry.unmatched.metrics).toBe(0);
    expect(r.host.telemetry.pendingSessions).toBe(1);

    // THE NEXT PUMP DOES NOT SHOW B, so it is where B's spans are judged: each
    // is dropped and counted, with one line naming it. A's unplaced spans are
    // counted at the same pump (A is shown; they name no call of A's).
    pumpOnce(r);
    const unplacedA = r.staged[0]?.unplaced.length ?? Number.NaN;
    const bSpans = spanToolIds(OTEL_SESSION_B);
    expect(bSpans.length).toBeGreaterThan(0);
    expect(r.host.telemetry.unmatched.traces).toBe(bSpans.length + unplacedA);
    const bLines = r.lines.filter((l) => l.includes(` otel span unmatched session=${OTEL_SESSION_B} `));
    expect(bLines.map((l) => / tool_use_id=(\S+)$/.exec(l)?.[1]).sort()).toStrictEqual([...bSpans].sort());

    const lateB = await stageLate(r);
    const after = pumpOnce(r);
    // Judged once: B appearing later neither re-counts nor revives its spans.
    expect(r.host.telemetry.unmatched.traces).toBe(bSpans.length + unplacedA);
    const b = after.joined.find((s) => s.sessionId === OTEL_SESSION_B);
    const bRaw = after.raw.find((s) => s.sessionId === OTEL_SESSION_B);
    expect(b, 'the late session was not emitted').toBeDefined();
    // CONTROL for the spans arm below: B's tree carries every span id the
    // staging placed on it, so a span of B that had been kept WOULD match.
    expect(lateB.remapped.size).toBeGreaterThan(0);
    for (const id of lateB.remapped.values()) expect(toolById(bRaw, id), id).toBeDefined();
    expect(b?.telemetryCostUsd).toBeCloseTo(costBySession.get(OTEL_SESSION_B) ?? Number.NaN, 10);
    expect(b?.telemetrySessionCountSeen).toBe(true);
    expect(r.host.telemetry.pendingSessions).toBe(0);
    const record = r.host.stats?.liveRecords().find((rec) => rec.sessionId === OTEL_SESSION_B);
    expect(record?.totals.costSource).toBe('telemetry');
    expect(record?.unavailable).not.toContain('F9:telemetry-partial');

    // SPANS WAIT ONE PUMP, NO LONGER: B's were dropped at the pump that did not
    // show B, so the join matched A's placed spans and not one of B's —
    // although B's tree carries every one of B's placed span ids (the control
    // above). The next test is the other arm: B shown at that pump.
    expect(r.staged.length).toBe(1);
    const placedA = r.staged[0]?.remapped.size ?? Number.NaN;
    expect(placedA).toBeGreaterThan(0);
    expect(r.host.telemetry.lastReport?.spansMatched).toBe(placedA);
    expect(JSON.stringify(b?.root)).toBe(JSON.stringify(bRaw?.root));
    // Control: A, held at arrival, did get its cost.
    expect(after.joined.find((s) => s.sessionId === OTEL_SESSION_A)?.telemetryCostUsd).toBeGreaterThan(0);
  }, 120_000);

  it('spans that arrive BEFORE their session is shown, and whose session and calls the next pump shows, join and are never counted (ruling 2026-09-11)', async () => {
    /*
     * phase-verifier round 3's first defect: a window reloaded during a live
     * session receives that session's spans before its first emission shows
     * it. Judged against "held when it arrived", every such span read as
     * unmatched — the first smoke's symptom — although the next pump shows the
     * session and every call. Only B's bodies are posted, so A has no spans and
     * any count here is one of B's.
     */
    const r = await rig({ stage: ['idle-as-A'] });
    pumpOnce(r);
    const onlyB = ENVELOPES.filter((e) => e.raw.includes(OTEL_SESSION_B));
    await replayCorpus(r.port, onlyB);
    // CONTROL on the ordering: B is not shown when its spans arrive.
    expect(r.emissions.at(-1)?.emission.sessions.some((s) => s.sessionId === OTEL_SESSION_B)).toBe(false);

    const lateB = await stageLate(r);
    pumpOnce(r);

    // VACUITY: B's spans joined — one match per span id the staging placed.
    expect(lateB.remapped.size).toBeGreaterThan(0);
    expect(r.host.telemetry.lastReport?.spansMatched).toBe(lateB.remapped.size);
    // THE RULING: B's placed spans are not counted; the ones the staging placed
    // on no call are, and they alone have lines.
    expect(r.host.telemetry.unmatched.traces).toBe(lateB.unplaced.length);
    const lines = r.lines.filter((l) => / otel span unmatched session=/.test(l));
    expect(lines.map((l) => / tool_use_id=(\S+)$/.exec(l)?.[1]).sort()).toStrictEqual([...lateB.unplaced].sort());
  }, 120_000);

  it('an evicted slot counts every row it held — its count point and each cost point (ruling 2026-09-11)', async () => {
    const r = await rig({ stage: ['idle-as-A'] });
    pumpOnce(r);
    const onlyB = ENVELOPES.filter((e) => e.raw.includes(OTEL_SESSION_B));
    const bCostPoints = census(onlyB).costPoints.get(OTEL_SESSION_B) ?? 0;
    // CONTROL: the slot holds more than one row, so "one per slot" and "count
    // points only" both give a different figure from the true one.
    expect(bCostPoints).toBeGreaterThan(1);
    expect(census(onlyB).sessionCounts).toStrictEqual([OTEL_SESSION_B]);

    await replayCorpus(r.port, onlyB);
    expect(r.host.telemetry.pendingSessions).toBe(1);
    expect(r.host.telemetry.unmatched.metrics).toBe(0);

    const flood = Array.from({ length: PENDING_SESSIONS_MAX }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect((await postTo(r.port, TELEMETRY_PATHS.metrics, sessionCountBody(flood))).status).toBe(200);
    expect(r.host.telemetry.pendingSessions).toBe(PENDING_SESSIONS_MAX);
    // B's slot, and only B's, was pushed out: its count point plus every cost point.
    expect(r.host.telemetry.unmatched.metrics).toBe(1 + bCostPoints);
  }, 120_000);

  it('never satisfies the provenance gate: a history session with telemetry is not written; the same session is, once it works', async () => {
    const r = await rig({ stage: ['idle-as-A'], stats: true, aheadMs: 0 });
    pumpOnce(r);
    await replayCorpus(r.port);
    pumpOnce(r);

    const store = r.host.stats?.store;
    expect(store).toBeDefined();
    // The join reached the stats layer: A's live record states Claude Code's
    // estimate as its cost source.
    const live = r.host.stats?.liveRecords().find((rec) => rec.sessionId === OTEL_SESSION_A);
    expect(live?.totals.costSource).toBe('telemetry');
    expect(live?.totals.costUsd).toBeGreaterThan(0);

    // Past every idle flush, and pumped again: nothing written. The staged
    // transcript has not grown since this window first read it, so it is
    // HISTORY, and telemetry naming it changes nothing about that.
    r.scheduler.advance(r.host.dataPath.settings['stats.idleFlushMs'] + 1);
    pumpOnce(r);
    expect(store?.appended).toBe(0);

    // CONTROL — the gate can open in this very harness: the session does
    // WORK (its transcript grows, which is what liveness witnesses), and the
    // record written carries the telemetry cost.
    const slugDir = r.host.dataPath.watcher.lastDiscovery?.slugDir;
    expect(slugDir).toBeDefined();
    const transcript = join(slugDir as string, `${OTEL_SESSION_A}.jsonl`);
    const text = await readFile(transcript, 'utf8');
    const last = text.split(/\r?\n/).filter((l) => l.trim() !== '').at(-1) as string;
    const entry = JSON.parse(last) as Record<string, unknown>;
    entry['uuid'] = '6d0c0000-0000-4000-8000-000000000001';
    const grafts = r.host.dataPath.diagnostics.grafts;
    await appendFile(transcript, `${JSON.stringify(entry)}\n`, 'utf8');
    await waitFor(() => r.host.dataPath.diagnostics.grafts > grafts, 'the grown transcript to be re-grafted');
    pumpOnce(r);
    r.scheduler.advance(r.host.dataPath.settings['stats.idleFlushMs'] + 1);
    expect(store?.appended).toBe(1);
    const written = store?.readRecords({}).find((rec) => rec.sessionId === OTEL_SESSION_A);
    expect(written?.totals.costSource).toBe('telemetry');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// DoD 6.3b — a telemetry cost is the cost source only with the session's start
// ---------------------------------------------------------------------------

/** The one model id a staged session's transcript names, read off the staged bytes. */
async function stagedModel(shared: { projectsRoot: string; workspacePath: string }, sessionId: string): Promise<string> {
  const path = join(shared.projectsRoot, slugifyWorkspace(shared.workspacePath), `${sessionId}.jsonl`);
  const text = await readFile(path, 'utf8');
  const models = [...new Set([...text.matchAll(/"model":"([^"]+)"/g)].map((m) => m[1] as string))];
  expect(models, 'the staged transcript names one model').toHaveLength(1);
  return models[0] as string;
}

describe('DoD 6.3b — Claude Code\'s cost is selected only when its session.count point was received', () => {
  const STRIPPED = withoutSessionCounts(ENVELOPES);

  it('(c) the stripped replay is the same replay: the same cost points, no count point', () => {
    const full = census(ENVELOPES);
    const stripped = census(STRIPPED);
    // VACUITY: cost points are non-empty for both sessions in BOTH replays,
    // and identical — the strip removed the count points and nothing else.
    for (const id of [OTEL_SESSION_A, OTEL_SESSION_B]) {
      expect(full.costPoints.get(id) ?? 0, id).toBeGreaterThan(0);
      expect(stripped.costPoints.get(id), id).toBe(full.costPoints.get(id));
      expect(stripped.costBySession.get(id), id).toBe(full.costBySession.get(id));
    }
    expect([...full.sessionCounts].sort()).toStrictEqual([OTEL_SESSION_A, OTEL_SESSION_B].sort());
    expect(stripped.sessionCounts).toStrictEqual([]);
    expect(STRIPPED.map((e) => e.raw).join('\n')).not.toContain(SESSION_COUNT);
    expect(STRIPPED).toHaveLength(ENVELOPES.length);
    expect(STRIPPED.filter((e, i) => e.raw !== ENVELOPES[i]?.raw)).toHaveLength(2);
  });

  it('(a) the full corpus through the route: telemetry is the cost source, nothing partial', async () => {
    const r = await rig({ stage: ['idle-as-A', 'stalled-as-B'], stats: true });
    pumpOnce(r);
    await replayCorpus(r.port);
    const after = pumpOnce(r);
    const { costBySession } = census();
    for (const id of [OTEL_SESSION_A, OTEL_SESSION_B]) {
      const joined = after.joined.find((s) => s.sessionId === id);
      expect(joined?.telemetrySessionCountSeen, id).toBe(true);
      const record = r.host.stats?.liveRecords().find((rec) => rec.sessionId === id);
      expect(record?.totals.costSource, id).toBe('telemetry');
      expect(record?.totals.costUsd, id).toBeCloseTo(costBySession.get(id) ?? Number.NaN, 10);
      expect(record?.unavailable, id).not.toContain('F9:telemetry-partial');
    }
  }, 120_000);

  it('(b) the same replay with the count points stripped: the cost is stored, not selected, and named partial', async () => {
    const r = await rig({ stage: ['idle-as-A', 'stalled-as-B'], stats: true });
    pumpOnce(r);
    await replayCorpus(r.port, STRIPPED);
    const after = pumpOnce(r);
    const { costBySession } = census(STRIPPED);
    for (const id of [OTEL_SESSION_A, OTEL_SESSION_B]) {
      const joined = after.joined.find((s) => s.sessionId === id);
      // STORED: the same sum as (a), on the state the stats layer was handed.
      expect(joined?.telemetryCostUsd ?? 0, id).toBeGreaterThan(0);
      expect(joined?.telemetryCostUsd, id).toBeCloseTo(costBySession.get(id) ?? Number.NaN, 10);
      expect(joined, id).not.toHaveProperty('telemetrySessionCountSeen');
      // NOT SELECTED: no prices configured, so no figure at all.
      const record = r.host.stats?.liveRecords().find((rec) => rec.sessionId === id);
      expect(record, id).toBeDefined();
      expect(record?.totals, id).not.toHaveProperty('costSource');
      expect(record?.totals, id).not.toHaveProperty('costUsd');
      expect(record?.unavailable, id).toContain('F9:telemetry-partial');
      expect(record?.unavailable, id).toContain('F9:cc');
    }
  }, 120_000);

  it('(b, priced) with prices for the session\'s model, those are the figure and the telemetry is named partial', async () => {
    const shared = await stage(['idle-as-A']);
    const model = await stagedModel(shared, OTEL_SESSION_A);
    const r = await rig({
      stage: [],
      shared,
      stats: true,
      pricing: { [model]: { prompt: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 } },
    });
    pumpOnce(r);
    await replayCorpus(r.port, STRIPPED);
    const after = pumpOnce(r);
    const telemetryCost = after.joined[0]?.telemetryCostUsd ?? 0;
    expect(telemetryCost).toBeGreaterThan(0);
    const record = r.host.stats?.liveRecords().find((rec) => rec.sessionId === OTEL_SESSION_A);
    expect(record?.totals.costSource).toBe('user');
    expect(record?.totals.costUsd ?? 0).toBeGreaterThan(0);
    // The figure is the user's, not the telemetry sum under another label.
    expect(record?.totals.costUsd).not.toBe(telemetryCost);
    expect(record?.unavailable).toContain('F9:telemetry-partial');
    expect(record?.unavailable).not.toContain('F9:telemetry-present');
  }, 120_000);

  it('THE SMOKE\'S SHAPE: a window holding only sessions with no telemetry, and one new session whose rows all arrive before it is shown', async () => {
    /*
     * Every other 6.3b test holds session A WITH A's own telemetry, so the
     * joiner always had something to apply. A real window mostly holds
     * history with no telemetry at all, plus the one session that just
     * started. phase-verifier round 2 (V1) moved the pending promotion below
     * the "nothing to apply" early return and every host test stayed green,
     * while in this shape the new session's cost would never be shown.
     */
    const r = await rig({ stage: ['idle-as-A'], stats: true });
    pumpOnce(r);
    // B's METRICS bodies only — a new session's first rows are its count point
    // and its cost, before any span. With no span in flight the joiner holds
    // nothing but the pending slot, which is the empty path V1 broke (a span
    // waiting for its verdict is kept at the judging pump, and would hide it:
    // measured, M35 went green on 8413729 with spans in this replay).
    const onlyB = ENVELOPES.filter((e) => e.signal === 'metrics' && e.raw.includes(OTEL_SESSION_B));
    // CONTROLS: B's bodies name no other session, and carry B's count point
    // and cost; A receives nothing at all.
    expect(onlyB.length).toBeGreaterThan(0);
    for (const e of onlyB) expect(e.raw.includes(OTEL_SESSION_A), e.receivedAt).toBe(false);
    expect(census(onlyB).sessionCounts).toStrictEqual([OTEL_SESSION_B]);
    expect(census(onlyB).costPoints.get(OTEL_SESSION_B) ?? 0).toBeGreaterThan(0);

    await replayCorpus(r.port, onlyB);
    expect(r.host.telemetry.pendingSessions).toBe(1);
    await stageLate(r);
    const after = pumpOnce(r);

    const a = after.joined.find((s) => s.sessionId === OTEL_SESSION_A);
    expect(a).toBeDefined();
    expect(a).not.toHaveProperty('telemetryCostUsd');
    const b = after.joined.find((s) => s.sessionId === OTEL_SESSION_B);
    expect(b?.telemetryCostUsd).toBeCloseTo(census(onlyB).costBySession.get(OTEL_SESSION_B) ?? Number.NaN, 10);
    expect(b?.telemetrySessionCountSeen).toBe(true);
    expect(r.host.telemetry.pendingSessions).toBe(0);
    const record = r.host.stats?.liveRecords().find((rec) => rec.sessionId === OTEL_SESSION_B);
    expect(record?.totals.costSource).toBe('telemetry');
  }, 120_000);

  it(`the held slots are bounded: a count point pushed out by ${String(PENDING_SESSIONS_MAX)} newer sessions leaves the cost unselected`, async () => {
    /*
     * B's count point arrives before B is held; then PENDING_SESSIONS_MAX other
     * sessions' count points; then B's cost. The bound evicts B's slot, and
     * B's cost, arriving after, is held in a fresh slot with no count point.
     * So B's cost is stored and NOT selected — the direction that shows no
     * figure rather than a short one. The control is the 6.3 test above with
     * the same ordering and no flood, which selects telemetry.
     */
    const r = await rig({ stage: ['idle-as-A'], stats: true });
    pumpOnce(r);
    const countAt = ENVELOPES.findIndex(
      (e) => e.signal === 'metrics' && e.raw.includes(OTEL_SESSION_B) && e.raw.includes(SESSION_COUNT),
    );
    expect(countAt).toBeGreaterThanOrEqual(0);
    const head = ENVELOPES.slice(0, countAt + 1);
    const tail = ENVELOPES.slice(countAt + 1);
    // CONTROL on the ordering: B's count point is in the head, B's cost only in the tail.
    expect(census(head).sessionCounts).toContain(OTEL_SESSION_B);
    expect(census(head).costPoints.get(OTEL_SESSION_B) ?? 0).toBe(0);
    expect(census(tail).costPoints.get(OTEL_SESSION_B) ?? 0).toBeGreaterThan(0);

    await replayCorpus(r.port, head);
    expect(r.host.telemetry.pendingSessions).toBe(1);
    const flood = Array.from({ length: PENDING_SESSIONS_MAX }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect((await postTo(r.port, TELEMETRY_PATHS.metrics, sessionCountBody(flood))).status).toBe(200);
    expect(r.host.telemetry.pendingSessions).toBe(PENDING_SESSIONS_MAX);
    await replayCorpus(r.port, tail);
    expect(r.host.telemetry.pendingSessions).toBe(PENDING_SESSIONS_MAX);

    await stageLate(r);
    const after = pumpOnce(r);
    const b = after.joined.find((s) => s.sessionId === OTEL_SESSION_B);
    expect(b?.telemetryCostUsd).toBeCloseTo(census().costBySession.get(OTEL_SESSION_B) ?? Number.NaN, 10);
    expect(b).not.toHaveProperty('telemetrySessionCountSeen');
    const record = r.host.stats?.liveRecords().find((rec) => rec.sessionId === OTEL_SESSION_B);
    expect(record).toBeDefined();
    expect(record?.totals).not.toHaveProperty('costSource');
    expect(record?.unavailable).toContain('F9:telemetry-partial');
    // An EVICTED slot's rows can no longer join, and that is where they are
    // counted: B's count point (pushed out by the flood), then the one flood
    // row B's cost slot pushed out. Nothing else was evicted.
    expect(r.host.telemetry.unmatched.metrics).toBe(2);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// DoD 6.1 + 6.2 — the setting reaches the route through activate(), and moves
// ---------------------------------------------------------------------------

describe('DoD 6.2 — agentDeck.telemetry.enabled, from the settings file to the answer', () => {
  it('activate() with the key unset answers 403; turning it on answers 200; off again, 403 — no reload', async () => {
    /*
     * The value has ONE production path in and one live path: `readSettings`
     * at activation and the configuration-change handler in `activate()`. A
     * test that set the data path's field by hand would prove the route honours
     * a value nothing was shown to send it — the D4 shape — so this drives the
     * real `activate()` against the `vscode` double and reads the answer off the
     * socket.
     */
    const shared = await stage(['idle-as-A']);
    const savedRoot = process.env['CLAUDE_PROJECTS_ROOT'];
    process.env['CLAUDE_PROJECTS_ROOT'] = shared.projectsRoot;
    const body = ENVELOPES.find((e) => e.signal === 'traces')?.raw ?? '';
    try {
      let port = 0;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        port = await freePort();
        resetVscodeMock();
        mock.setWorkspaceFolder(shared.workspacePath);
        mock.setConfig(CONFIG_SECTION, { port });
        await activate(createExtensionContext() as unknown as Parameters<typeof activate>[0]);
        if (currentHost()?.dataPath.diagnostics.bindError?.code !== 'EADDRINUSE') break;
        await deactivate();
      }
      expect(currentHost()?.dataPath.listener.bound).toBe(true);

      // Unset -> the shipped default, off.
      expect((await postTo(port, TELEMETRY_PATHS.traces, body)).status).toBe(403);

      mock.setConfig(CONFIG_SECTION, { port, 'telemetry.enabled': true });
      mock.fireConfigurationChange(CONFIG_SECTION);
      expect((await postTo(port, TELEMETRY_PATHS.traces, body)).status).toBe(200);

      mock.setConfig(CONFIG_SECTION, { port, 'telemetry.enabled': false });
      mock.fireConfigurationChange(CONFIG_SECTION);
      expect((await postTo(port, TELEMETRY_PATHS.traces, body)).status).toBe(403);

      expect(currentHost()?.counters().telemetry.traces).toMatchObject({ accepted: 1, disabled: 2 });
    } finally {
      await deactivate();
      if (savedRoot === undefined) delete process.env['CLAUDE_PROJECTS_ROOT'];
      else process.env['CLAUDE_PROJECTS_ROOT'] = savedRoot;
    }
  }, 120_000);

  it('activate() with the key already true accepts from the first request', async () => {
    const shared = await stage(['idle-as-A']);
    const savedRoot = process.env['CLAUDE_PROJECTS_ROOT'];
    process.env['CLAUDE_PROJECTS_ROOT'] = shared.projectsRoot;
    try {
      let port = 0;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        port = await freePort();
        resetVscodeMock();
        mock.setWorkspaceFolder(shared.workspacePath);
        mock.setConfig(CONFIG_SECTION, { port, 'telemetry.enabled': true });
        await activate(createExtensionContext() as unknown as Parameters<typeof activate>[0]);
        if (currentHost()?.dataPath.diagnostics.bindError?.code !== 'EADDRINUSE') break;
        await deactivate();
      }
      const body = ENVELOPES.find((e) => e.signal === 'metrics')?.raw ?? '';
      expect((await postTo(port, TELEMETRY_PATHS.metrics, body)).status).toBe(200);
    } finally {
      await deactivate();
      if (savedRoot === undefined) delete process.env['CLAUDE_PROJECTS_ROOT'];
      else process.env['CLAUDE_PROJECTS_ROOT'] = savedRoot;
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// DoD 6.4 — the counters, in the listener and on the diagnostics line
// ---------------------------------------------------------------------------

describe('DoD 6.4 — per-signal accepted, rejected by status, disabled and unmatched', () => {
  it('pins every figure after the corpus replay and one request per refusal', async () => {
    const r = await rig({ stage: ['idle-as-A', 'stalled-as-B'] });
    pumpOnce(r);
    await replayCorpus(r.port);
    // The verdict on every span is the NEXT pump's (ruling 2026-09-11).
    pumpOnce(r);

    const traces = ENVELOPES.find((e) => e.signal === 'traces')?.raw ?? '';
    expect((await postTo(r.port, TELEMETRY_PATHS.metrics, '', { method: 'GET' })).status).toBe(405);
    expect((await postTo(r.port, TELEMETRY_PATHS.logs, traces, { contentType: 'application/x-protobuf' })).status).toBe(415);
    expect((await postTo(r.port, TELEMETRY_PATHS.traces, '{}')).status).toBe(400);
    expect(
      (await postTo(r.port, TELEMETRY_PATHS.traces, Buffer.concat([Buffer.from(traces), Buffer.alloc(512 * 1024, 0x20)]))).status,
    ).toBe(413);
    r.host.dataPath.setTelemetryEnabled(false);
    expect((await postTo(r.port, TELEMETRY_PATHS.metrics, traces)).status).toBe(403);
    r.host.dataPath.setTelemetryEnabled(true);

    // The corpus's own census (its README): 77 metrics, 74 logs and 43 traces
    // requests; 40 tool spans. The unmatched spans are the ones the staging
    // placed on no call: 40 minus every placed span id.
    const perSignal = { metrics: 0, logs: 0, traces: 0 };
    for (const e of ENVELOPES) perSignal[e.signal] += 1;
    expect(perSignal).toStrictEqual({ metrics: 77, logs: 74, traces: 43 });
    const placed = r.staged.reduce((n, s) => n + s.remapped.size, 0);
    expect(placed).toBeGreaterThan(0);
    expect(census().spans).toBe(40);

    const expected = {
      metrics: { accepted: 77, disabled: 1, unmatched: 0, rejected: { 400: 0, 405: 1, 413: 0, 415: 0 } },
      logs: { accepted: 74, disabled: 0, unmatched: 0, rejected: { 400: 0, 405: 0, 413: 0, 415: 1 } },
      traces: { accepted: 43, disabled: 0, unmatched: 40 - placed, rejected: { 400: 1, 405: 0, 413: 1, 415: 0 } },
    };
    expect(r.host.counters().telemetry).toStrictEqual(expected);
    // One diagnostics line per counted span, each naming a span id the staging
    // placed on no call.
    const unmatchedLines = r.lines.filter((l) => / otel span unmatched session=/.test(l));
    expect(unmatchedLines).toHaveLength(40 - placed);
    const placedIds = new Set(r.staged.flatMap((s) => [...s.remapped.values()]));
    for (const line of unmatchedLines) {
      const id = / tool_use_id=(\S+)$/.exec(line)?.[1] ?? '';
      expect(id, line).not.toBe('');
      expect(placedIds.has(id), line).toBe(false);
    }

    // The LISTENER's own counters carry the route's half, with no `unmatched`
    // (the join is per window, not per socket).
    const listener = r.host.dataPath.listener.telemetryCounters;
    for (const signal of ['metrics', 'logs', 'traces'] as const) {
      expect(listener[signal]).toStrictEqual({
        accepted: expected[signal].accepted,
        disabled: expected[signal].disabled,
        rejected: expected[signal].rejected,
      });
    }

    // The DIAGNOSTICS VIEW: the counters line a user copies into a report.
    const line = formatCounters(r.host.counters(), '2026-09-10T00:00:00.000Z');
    expect(line).toContain(' otel.metrics=accepted:77,disabled:1,unmatched:0,400:0,405:1,413:0,415:0');
    expect(line).toContain(' otel.logs=accepted:74,disabled:0,unmatched:0,400:0,405:0,413:0,415:1');
    expect(line).toContain(
      ` otel.traces=accepted:43,disabled:0,unmatched:${String(40 - placed)},400:1,405:0,413:1,415:0`,
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// DoD 6.4, amended by the ruling of 2026-09-11 — `unmatched` means STILL
// unmatched after the join retried on the next pump
// ---------------------------------------------------------------------------

/** One traces body carrying ONE `claude_code.tool` span, a copy of the corpus's own with three values changed. */
function oneSpanBody(sessionId: string, toolUseId: string, durationMs: number): string {
  const source = ENVELOPES.find(
    (e) => e.signal === 'traces' && e.raw.includes(sessionId) && e.raw.includes('"claude_code.tool"'),
  );
  if (source === undefined) throw new Error(`no traces body with a claude_code.tool span for ${sessionId}`);
  const body = JSON.parse(source.raw) as {
    resourceSpans: {
      resource?: unknown;
      scopeSpans: { scope?: unknown; spans: { name: string; attributes: { key: string; value: unknown }[] }[] }[];
    }[];
  };
  for (const resource of body.resourceSpans) {
    for (const scope of resource.scopeSpans) {
      const span = scope.spans.find((s) => s.name === 'claude_code.tool');
      if (span === undefined) continue;
      const set: Record<string, unknown> = {
        'session.id': { stringValue: sessionId },
        tool_use_id: { stringValue: toolUseId },
        duration_ms: { intValue: String(durationMs) },
      };
      const attributes = span.attributes.map((a) => (a.key in set ? { key: a.key, value: set[a.key] } : a));
      return JSON.stringify({
        resourceSpans: [{ resource: resource.resource, scopeSpans: [{ scope: scope.scope, spans: [{ ...span, attributes }] }] }],
      });
    }
  }
  throw new Error('the traces body holds no claude_code.tool span');
}

/**
 * Append one assistant entry to a staged transcript whose only content is a
 * Bash tool_use with `toolUseId`: the transcript's own last assistant entry,
 * with a new uuid and message id and that one block. No result follows it.
 */
async function appendToolUse(slugDir: string, sessionId: string, toolUseId: string): Promise<void> {
  const path = join(slugDir, `${sessionId}.jsonl`);
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter((l) => l.trim() !== '');
  const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const source = [...entries].reverse().find((e) => e['type'] === 'assistant' && typeof e['message'] === 'object');
  if (source === undefined) throw new Error('the staged transcript holds no assistant entry to copy');
  const message = source['message'] as Record<string, unknown>;
  const entry = {
    ...source,
    uuid: '6d0c0000-0000-4000-8000-0000000000e1',
    parentUuid: entries.at(-1)?.['uuid'] ?? null,
    message: {
      ...message,
      id: 'msg_01EARLYSPANPROBE0000000001',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'echo early', description: 'probe' } }],
    },
  };
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}

describe('DoD 6.4 as amended (2026-09-11) — unmatched counts what the next pump still cannot place', () => {
  const EARLY = 'toolu_01EarlySpanArrivesFirst000';
  const NEVER = 'toolu_01NeverInAnyTranscript0000';
  const UNMATCHED_LINE = / otel span unmatched session=(\S+) tool_use_id=(\S+)$/;

  it('a span that arrives before its tool call reaches the tree, and matches on the next pump, is never counted', async () => {
    const r = await rig({ stage: ['idle-as-A'] });
    pumpOnce(r);
    const slugDir = r.host.dataPath.watcher.lastDiscovery?.slugDir;
    expect(slugDir).toBeDefined();
    // CONTROL on the ordering: the tool call is not in the model when the span lands.
    expect(toolById(r.host.dataPath.model.sessionState(OTEL_SESSION_A), EARLY)).toBeUndefined();

    expect((await postTo(r.port, TELEMETRY_PATHS.traces, oneSpanBody(OTEL_SESSION_A, EARLY, 4321))).status).toBe(200);
    await waitFor(() => r.host.telemetry.slicesIngested === 1, 'the span to be ingested');

    // The tool call is written AFTER the span arrived, and no pump runs until
    // the model holds it — so the next pump is the one that judges the span.
    await appendToolUse(slugDir as string, OTEL_SESSION_A, EARLY);
    await waitFor(
      () => toolById(r.host.dataPath.model.sessionState(OTEL_SESSION_A), EARLY) !== undefined,
      'the late tool call to be grafted into the model',
      30_000,
    );
    const after = pumpOnce(r);

    // VACUITY: the span really joined — the join matched it, and the tool
    // call, which the engine timed with no result, carries the span's duration.
    expect(r.host.telemetry.lastReport?.spansMatched ?? 0).toBeGreaterThan(0);
    const node = toolById(after.joined.find((s) => s.sessionId === OTEL_SESSION_A), EARLY);
    expect(node !== undefined && !isAgentNode(node) ? node.durationMs : undefined).toBe(4321);
    // THE RULING: an early arrival that matched later is not counted, and not logged.
    expect(r.host.telemetry.unmatched.traces).toBe(0);
    expect(r.lines.filter((l) => UNMATCHED_LINE.test(l))).toStrictEqual([]);
  }, 120_000);

  it('a span whose id never appears is counted after the pump, and written as one line with the two keys and nothing else', async () => {
    const r = await rig({ stage: ['idle-as-A'] });
    pumpOnce(r);
    // Sent TWICE before the pump: a re-sent span replaces, and is judged once.
    for (let i = 0; i < 2; i += 1) {
      expect((await postTo(r.port, TELEMETRY_PATHS.traces, oneSpanBody(OTEL_SESSION_A, NEVER, 777))).status).toBe(200);
    }
    await waitFor(() => r.host.telemetry.slicesIngested === 2, 'both copies to be ingested');
    // Before the pump nothing is judged.
    expect(r.host.telemetry.unmatched.traces).toBe(0);
    pumpOnce(r);
    expect(r.host.telemetry.unmatched.traces).toBe(1);
    const lines = r.lines.filter((l) => UNMATCHED_LINE.test(l));
    expect(lines).toHaveLength(1);
    const match = UNMATCHED_LINE.exec(lines[0] ?? '');
    expect(match?.[1]).toBe(OTEL_SESSION_A);
    expect(match?.[2]).toBe(NEVER);
    // Nothing else from the span: a timestamp, the words, the two keys.
    expect(lines[0]).toMatch(new RegExp(`^\\S+ otel span unmatched session=${OTEL_SESSION_A} tool_use_id=${NEVER}$`));
    expect(lines[0]).not.toContain('777');
    // Judged once: a second pump does not count it again.
    pumpOnce(r);
    expect(r.host.telemetry.unmatched.traces).toBe(1);
    expect(r.lines.filter((l) => UNMATCHED_LINE.test(l))).toHaveLength(1);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// DoD 6.6 — literal bytes, through the route, to every surface
// ---------------------------------------------------------------------------

/** A corpus logs body with REAL-LOOKING text planted in each of the three content fields. */
const PLANTED = {
  prompt: 'PLANTED-PROMPT-TEXT refactor the billing module for acme',
  response: 'PLANTED-RESPONSE-TEXT here is the rewritten function',
  user_prompt: 'PLANTED-USER-PROMPT-TEXT my api key is in the env',
} as const;

function plantedLogsBody(): string {
  const source = ENVELOPES.find((e) => e.signal === 'logs' && e.raw.includes('"user_prompt"'));
  if (source === undefined) throw new Error('no logs body carries user_prompt');
  const body = JSON.parse(source.raw) as { resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string; value: unknown }[] }[] }[] }[] };
  const record = body.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
  if (record === undefined) throw new Error('the logs body has no record');
  for (const key of CONTENT_KEYS) {
    const existing = record.attributes.find((a) => a.key === key);
    const value = { stringValue: PLANTED[key as keyof typeof PLANTED] };
    if (existing === undefined) record.attributes.push({ key, value });
    else existing.value = value;
  }
  return JSON.stringify(body);
}

/** Every object key named like a content field whose value is a STRING. Token counts named `prompt` are numbers. */
function stringContentKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) stringContentKeys(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (CONTENT_KEYS.includes(key) && typeof child === 'string') found.push(key);
      stringContentKeys(child, found);
    }
  }
  return found;
}

/** Subscribe to the leader's relay as a raw SSE client, collecting every byte. */
function captureRelay(port: number): { text: () => string; ready: Promise<void> } {
  let collected = '';
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const req = httpRequest({ host: '127.0.0.1', port, path: EVENTS_PATH, method: 'GET', agent: false }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      collected += chunk;
    });
    resolveReady();
  });
  req.on('error', () => {});
  req.end();
  openStreams.push({ destroy: () => req.destroy() });
  return { text: () => collected, ready };
}

/** Occurrences of every needle in a text. */
function needleCounts(text: string, needles: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const needle of needles) out[needle] = text.split(needle).length - 1;
  return out;
}

describe('DoD 6.6 — no identity attribute and no content field survives the route, on any surface', () => {
  /*
   * WHY SOME SURFACES ARE COMPARED TO A BASELINE AND NOT TO ZERO. The staged
   * transcripts are REAL sessions of this repository, and their tool payloads
   * can quote the very strings this test looks for — a session that worked on
   * the telemetry spike may well have `user.id` in a Bash command. Those bytes
   * came from the transcript, not from the route, and a test that counted them
   * would fail for a reason that has nothing to do with telemetry. So each
   * surface a transcript can reach is measured BEFORE any telemetry is posted
   * and again after, and the assertion is that telemetry added not one needle.
   * The surfaces only telemetry can reach — the relay frames (no hook is
   * posted here), the diagnostics lines and panel messages written after the
   * baseline — are held to an absolute zero. The planted strings are unique to
   * this test, so they are held to zero everywhere.
   */
  it('posts every corpus body and one planted body; states, relay frames, stats and diagnostics add nothing', async () => {
    const r = await rig({ stage: ['idle-as-A', 'stalled-as-B'], stats: true });
    r.host.open();
    const relay = captureRelay(r.port);
    await relay.ready;
    await waitFor(() => r.host.dataPath.relayCounters.followers === 1, 'the capture to attach as a follower');
    const base = pumpOnce(r);

    const NEEDLES = [...IDENTITY_NAMES, ...IDENTITY_PLACEHOLDERS, '<REDACTED>'];
    const PLANTS = Object.values(PLANTED);
    const baseline = {
      states: needleCounts(JSON.stringify(base.raw), NEEDLES),
      stats: needleCounts(JSON.stringify(r.host.stats?.liveRecords() ?? []), NEEDLES),
      contentKeys: stringContentKeys([base.raw, r.host.stats?.liveRecords() ?? []]).length,
    };
    // The baseline is MEASURED ZERO on these staged transcripts (the phase
    // verifier re-derived it), so it is pinned: every comparison below is then
    // "free of", literally, and a future staging that brings a needle in fails
    // here, naming it, instead of quietly raising the bar it is compared with.
    const zeros = (needles: readonly string[]): Record<string, number> =>
      Object.fromEntries(needles.map((n) => [n, 0]));
    expect(baseline.states, 'the staged transcripts carry a needle').toStrictEqual(zeros(NEEDLES));
    expect(baseline.stats, 'the baseline stats records carry a needle').toStrictEqual(zeros(NEEDLES));
    expect(baseline.contentKeys).toBe(0);
    const linesAt = r.lines.length;
    const postedAt = r.posted.length;

    const planted = plantedLogsBody();
    await replayCorpus(r.port);
    expect((await postTo(r.port, TELEMETRY_PATHS.logs, planted)).status).toBe(200);
    await waitFor(
      () => (relay.text().match(/"kind":"otel"/g) ?? []).length === ENVELOPES.length + 1,
      'one relay frame per accepted body',
    );
    const after = pumpOnce(r);
    r.scheduler.advance(61_000); // the 60 s counters line, written after the replay

    // VACUITY CONTROLS. The bodies really carried every needle and every
    // plant; the join ran; the capture received the frames; a counters line
    // written after the replay exists and names the planted body's signal.
    const allBodies = ENVELOPES.map((e) => e.raw).join('\n') + planted;
    for (const needle of [...NEEDLES, ...PLANTS]) {
      expect(allBodies, `the posted bodies never carried ${needle}`).toContain(needle);
    }
    for (const key of CONTENT_KEYS) expect(planted).toContain(`"key":"${key}"`);
    expect(JSON.stringify(after.joined)).toContain('telemetryCostUsd');
    const frames = relay
      .text()
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5)) as { kind?: string });
    expect(frames.filter((f) => f.kind === 'otel')).toHaveLength(ENVELOPES.length + 1);
    const newLines = r.lines.slice(linesAt).join('\n');
    expect(newLines).toContain(' otel.logs=accepted:75,');
    const newPosted = JSON.stringify(r.posted.slice(postedAt));
    expect(r.posted.length).toBeGreaterThan(0);

    // TELEMETRY-ONLY SURFACES: not one needle, not one plant.
    const telemetryOnly: Record<string, string> = {
      'relay frames': relay.text(),
      'diagnostics lines written after the replay began': newLines,
      'panel messages sent after the replay began': newPosted,
      'the diagnostics counters record': JSON.stringify(r.host.counters()),
    };
    for (const [name, text] of Object.entries(telemetryOnly)) {
      for (const needle of [...NEEDLES, ...PLANTS]) {
        expect(text.includes(needle), `${name} carries ${needle}`).toBe(false);
      }
    }
    expect(stringContentKeys(frames), 'a relay frame carries a content field').toStrictEqual([]);

    // TRANSCRIPT-REACHABLE SURFACES: telemetry added nothing to them.
    expect(needleCounts(JSON.stringify(after.raw), NEEDLES), 'raw states').toStrictEqual(baseline.states);
    expect(needleCounts(JSON.stringify(after.joined), NEEDLES), 'joined states').toStrictEqual(baseline.states);
    expect(
      needleCounts(JSON.stringify(r.host.stats?.liveRecords() ?? []), NEEDLES),
      'stats live records',
    ).toStrictEqual(baseline.stats);
    expect(stringContentKeys([after.joined, r.host.stats?.liveRecords() ?? []]).length).toBe(baseline.contentKeys);
    // ...and the plants reached none of them.
    const everything = [
      JSON.stringify(r.emissions.map((e) => e.emission.sessions)),
      JSON.stringify(after.joined),
      JSON.stringify(r.host.stats?.liveRecords() ?? []),
      JSON.stringify(r.posted),
      r.lines.join('\n'),
    ].join('\n');
    for (const plant of PLANTS) expect(everything.includes(plant), plant).toBe(false);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// DoD 6.7 — a follower's joined states equal the leader's
// ---------------------------------------------------------------------------

describe('DoD 6.7 — follower parity, through the production caller', () => {
  it('the leader receives the corpus over its socket; a second window joins identically by relay', async () => {
    const shared = await stage(['idle-as-A', 'stalled-as-B']);
    const leader = await rig({ stage: [], shared });
    const follower = await rig({ stage: [], shared, port: leader.port });
    expect(leader.host.dataPath.relayRole).toBe('leader');
    expect(follower.host.dataPath.relayRole).toBe('follower');
    pumpOnce(leader);
    pumpOnce(follower);

    await replayCorpus(leader.port);
    await waitFor(
      () => follower.host.telemetry.slicesIngested === ENVELOPES.length,
      'every relayed slice at the follower',
    );
    expect(leader.host.telemetry.slicesIngested).toBe(ENVELOPES.length);
    const l = pumpOnce(leader);
    const f = pumpOnce(follower);

    // Non-vacuous: telemetry landed on both sessions in the leader's join.
    for (const id of [OTEL_SESSION_A, OTEL_SESSION_B]) {
      expect(l.joined.find((s) => s.sessionId === id)?.telemetryCostUsd, id).toBeGreaterThan(0);
    }
    expect(JSON.stringify(f.joined)).toBe(JSON.stringify(l.joined));
    expect(follower.host.telemetry.unmatched).toStrictEqual(leader.host.telemetry.unmatched);
    // The follower holds no socket: its route counted nothing, the leader's
    // counted every body.
    expect(follower.host.counters().telemetry.traces.accepted).toBe(0);
    expect(leader.host.counters().telemetry.traces.accepted).toBe(43);
  }, 180_000);
});
