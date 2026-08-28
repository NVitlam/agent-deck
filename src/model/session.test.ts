/**
 * Tests for the session model — the place the two taps meet.
 *
 * The two headline tests are the Phase 2 DoD items and they are written to
 * fail for the right reason:
 *
 *   R4  Two captured sessions are replayed INTERLEAVED — partial arrivals
 *       alternating between them, never one session then the other — and both
 *       must come out byte-identical to the tree an isolated `graftSession`
 *       produces, with provably disjoint node/agent/edge id sets. A model that
 *       shared one grafter, one accumulator or one id map between sessions
 *       fails on the disjointness assertions, not on a golden diff nobody can
 *       read.
 *
 *   G2  A genuine content hard failure (a getter that throws deep inside the
 *       grafter's scan, and separately a real layout mismatch from
 *       `fixtures/synthetic-layout/`) must leave the session `unsupported`
 *       with NO tree, while hook-driven liveness keeps advancing for that same
 *       session and for its neighbour. "The parser returned empty" would not
 *       test this, so it is not what is injected.
 *
 * Fixture discipline (G6): every session id, agent id, slug and workspace path
 * used here is DERIVED from the committed fixtures at run time. Nothing is
 * hard-coded, including the workspace path — it is read from the transcripts'
 * own `cwd` field, so a re-harvest moves it without touching this file. Set
 * sizes are never asserted; a count pinned to today's capture reads as a
 * regression on the next one.
 *
 * Golden snapshots live in `fixtures/golden/session/` and are regenerated with
 * `AGENT_DECK_UPDATE_GOLDENS=1`; see that directory's README. Nothing is
 * written without that variable set.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type {
  AgentNode,
  ApplyError,
  NormalizedHookEvent,
  RawHookPayload,
  SessionState,
  SubagentMeta,
  ToolNode,
  TranscriptEntry,
  TreeNode,
} from './events.js';
import { isAgentNode } from './events.js';
import { normalizeHookEvent } from '../hooks/listener.js';
import type { GraftSnapshot, SidecarArrival, TranscriptBatch } from './graft.js';
import { agentNodes, graftSession, walk } from './graft.js';
import { LivenessEngine } from './liveness.js';
import { correlateWorkspace } from './correlate.js';
import { slugifyWorkspace } from '../parser/tailer.js';
import { splitTranscript } from '../parser/attribution.js';
import { hydratePersistedOutputs, parseLines, parseSubagentMeta } from '../parser/parse.js';
import {
  SessionModel,
  SessionPatchError,
  applySessionPatch,
  diffSessionState,
  serializeSessionState,
  sessionGoldenText,
} from './session.js';

// ---------------------------------------------------------------------------
// Fixture roots — derived, never assumed
// ---------------------------------------------------------------------------

const CAPTURED_ROOT = fileURLToPath(new URL('../../fixtures/cc-2.1.234/projects', import.meta.url));
const LAYOUT_ROOT = fileURLToPath(new URL('../../fixtures/synthetic-layout', import.meta.url));
const HOOK_CAPTURE = fileURLToPath(
  new URL('../../fixtures/hook-events/cc-2.1.234-redacted.jsonl', import.meta.url),
);
const GOLDEN_DIR = fileURLToPath(new URL('../../fixtures/golden/session', import.meta.url));
const UPDATE_GOLDENS = process.env['AGENT_DECK_UPDATE_GOLDENS'] === '1';

const SYNTHETIC_SLUG = 'SYNTHETIC-hand-mutated-not-captured';
const LAYOUT_SESSION = 'deadbeef-0000-4000-8000-000000000001';

/**
 * A fixed instant. Liveness moves with the clock, and a test that read
 * `Date.now()` would pin a golden to the second it ran.
 */
const CLOCK_BASE = 1_700_000_000_000;
/** Inside the engine's 120 s recency threshold, so `recent` is deterministic. */
const NOW = CLOCK_BASE + 60_000;

/** The one slug directory in the captured root, read rather than named. */
async function capturedSlugDir(): Promise<string> {
  const entries = await readdir(CAPTURED_ROOT, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  expect(dirs.length).toBeGreaterThan(0);
  return join(CAPTURED_ROOT, dirs[0] as string);
}

/** Session ids in the captured slug, from the `<id>.jsonl` files on disk. */
async function capturedSessionIds(slugDir: string): Promise<string[]> {
  const names = await readdir(slugDir, { withFileTypes: true });
  return names
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => e.name.replace(/\.jsonl$/, ''))
    .sort();
}

/**
 * The workspace path the capture was taken in, read from the transcripts' own
 * `cwd`. Deriving it means a re-harvest on another machine needs no edit here,
 * and it is the same string CC itself slug-encoded.
 */
async function capturedWorkspacePath(slugDir: string, sessionIds: readonly string[]): Promise<string> {
  for (const sessionId of sessionIds) {
    const text = await readFile(join(slugDir, `${sessionId}.jsonl`), 'utf8');
    for (const line of splitTranscript(text)) {
      const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
      if (match === null) continue;
      const raw = match[1];
      if (raw === undefined) continue;
      const decoded = JSON.parse(`"${raw}"`) as string;
      if (decoded !== '') return decoded;
    }
  }
  throw new Error('no cwd found in the captured transcripts');
}

// ---------------------------------------------------------------------------
// A replayable session: every file read once, then fed in whatever order and
// in whatever slices a test wants.
// ---------------------------------------------------------------------------

interface ReplayFile {
  path: string;
  kind: 'main' | 'subagent';
  agentId?: string;
  entries: TranscriptEntry[];
}

interface ReplaySession {
  sessionId: string;
  projectSlug: string;
  mainPath: string;
  main: ReplayFile;
  agents: ReplayFile[];
  sidecars: SidecarArrival[];
  /** `tool_use` id -> offloaded payload text, already resolved from disk. */
  payloads: Map<string, string>;
}

async function loadReplay(mainTranscript: string): Promise<ReplaySession> {
  const slugDir = dirname(mainTranscript);
  const sessionId = basename(mainTranscript).replace(/\.jsonl$/, '');
  const sessionDir = join(slugDir, sessionId);

  const readEntries = async (path: string): Promise<TranscriptEntry[]> => {
    const text = await readFile(path, 'utf8');
    const batch = parseLines(splitTranscript(text));
    return batch.ok ? batch.value.entries : [];
  };

  const main: ReplayFile = {
    path: mainTranscript,
    kind: 'main',
    entries: await readEntries(mainTranscript),
  };

  const agents: ReplayFile[] = [];
  const sidecars: SidecarArrival[] = [];
  let subagentNames: string[] = [];
  try {
    subagentNames = (await readdir(join(sessionDir, 'subagents'))).sort();
  } catch {
    subagentNames = [];
  }
  for (const name of subagentNames) {
    const match = /^agent-(.+)\.jsonl$/.exec(name);
    if (match === null) continue;
    const agentId = match[1] as string;
    const transcriptPath = join(sessionDir, 'subagents', name);
    agents.push({
      path: transcriptPath,
      kind: 'subagent',
      agentId,
      entries: await readEntries(transcriptPath),
    });
    const metaPath = join(sessionDir, 'subagents', `agent-${agentId}.meta.json`);
    const arrival: SidecarArrival = { agentId, metaPath };
    try {
      const parsed = parseSubagentMeta(await readFile(metaPath, 'utf8'), metaPath);
      if (parsed.ok) arrival.meta = parsed.value;
      else arrival.metaFailure = parsed.mismatch.reason;
    } catch (error: unknown) {
      arrival.metaFailure = error instanceof Error ? error.message : String(error);
    }
    sidecars.push(arrival);
  }

  const payloads = new Map<string, string>();
  for (const file of [main, ...agents]) {
    for (const entry of file.entries) {
      const hydrated = await hydratePersistedOutputs(entry, {
        projectsRoot: dirname(slugDir),
        slug: basename(slugDir),
        sessionId,
      });
      for (const item of hydrated) {
        if (item.toolUseId !== '') payloads.set(item.toolUseId, item.read.text);
      }
    }
  }

  return {
    sessionId,
    projectSlug: basename(slugDir),
    mainPath: mainTranscript,
    main,
    agents,
    sidecars,
    payloads,
  };
}

/** Cut `n` roughly-equal prefixes of an array, always ending at the full length. */
function prefixCuts(length: number, n: number): number[] {
  if (length === 0) return [0];
  const cuts: number[] = [];
  for (let i = 1; i <= n; i += 1) {
    const cut = Math.max(1, Math.round((length * i) / n));
    if (cuts[cuts.length - 1] !== cut) cuts.push(cut);
  }
  if (cuts[cuts.length - 1] !== length) cuts.push(length);
  return cuts;
}

/**
 * One session's arrivals, as a list of independent steps.
 *
 * A transcript arrives the way a tailer delivers it: the whole file as read so
 * far, growing. `TreeGrafter` tracks how much of each path it has consumed, so
 * passing a growing prefix is the honest simulation, not a shortcut.
 */
function arrivalsFor(session: ReplaySession, model: SessionModel): (() => void)[] {
  const steps: (() => void)[] = [];
  const slug = session.projectSlug;

  const fileSteps = (file: ReplayFile, chunks: number): (() => void)[] =>
    prefixCuts(file.entries.length, chunks).map((cut) => () => {
      const batch: TranscriptBatch = {
        kind: file.kind,
        path: file.path,
        entries: file.entries.slice(0, cut),
      };
      if (file.agentId !== undefined) batch.agentId = file.agentId;
      model.ingestTranscript(session.sessionId, slug, batch);
    });

  const mainSteps = fileSteps(session.main, 3);
  const agentSteps: (() => void)[] = [];
  for (const file of session.agents) {
    const sidecar = session.sidecars.find((s) => s.agentId === file.agentId);
    if (sidecar !== undefined) {
      agentSteps.push(() => {
        model.ingestSidecar(session.sessionId, slug, sidecar);
      });
    }
    agentSteps.push(...fileSteps(file, 2));
  }
  const payloadSteps = [...session.payloads.entries()].map(([toolUseId, text]) => () => {
    model.ingestToolResultPayload(session.sessionId, slug, toolUseId, text);
  });

  // Deliberately not "all main, then all agents": a subagent transcript
  // arriving before the main lines that spawned it is the normal case on a
  // live tail, and the grafter is order-independent by design.
  const lanes = [mainSteps, agentSteps, payloadSteps];
  let more = true;
  for (let i = 0; more; i += 1) {
    more = false;
    for (const lane of lanes) {
      const step = lane[i];
      if (step === undefined) continue;
      steps.push(step);
      more = true;
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Hook-event replay
// ---------------------------------------------------------------------------

interface HookPartition {
  /** sessionId -> the agent ids whose events were routed to it. */
  agentIds: Map<string, Set<string>>;
  /** The retargeted, normalized event stream, in capture order. */
  events: NormalizedHookEvent[];
}

/**
 * Replay the captured hook stream against two sessions.
 *
 * The capture is one real session's events. Only `session_id` is rewritten;
 * every other key — including the PRESENCE or ABSENCE of `agent_id` — is
 * carried through untouched, because absence of that key is how CC signals the
 * main thread and a replay that normalised it would test nothing.
 *
 * Events are partitioned by `agent_id` so the two sessions receive disjoint
 * subagent id sets. That is what makes liveness cross-contamination
 * detectable: an id appearing under the wrong session is a bug, not a
 * coincidence.
 */
async function partitionedHookEvents(sessionIds: readonly string[]): Promise<HookPartition> {
  const text = await readFile(HOOK_CAPTURE, 'utf8');
  const raw = splitTranscript(text).map((line) => JSON.parse(line) as RawHookPayload);

  const distinctAgents = [...new Set(
    raw
      .map((p) => (typeof p.agent_id === 'string' ? p.agent_id : undefined))
      .filter((id): id is string => id !== undefined),
  )].sort();
  expect(distinctAgents.length).toBeGreaterThanOrEqual(sessionIds.length);

  const owner = new Map<string, string>();
  distinctAgents.forEach((agentId, i) => {
    owner.set(agentId, sessionIds[i % sessionIds.length] as string);
  });

  const agentIds = new Map<string, Set<string>>();
  for (const sessionId of sessionIds) agentIds.set(sessionId, new Set<string>());
  for (const [agentId, sessionId] of owner) agentIds.get(sessionId)?.add(agentId);

  const events: NormalizedHookEvent[] = [];
  let mainThreadSeen = 0;
  raw.forEach((payload, i) => {
    const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : undefined;
    let target: string;
    if (agentId !== undefined) {
      target = owner.get(agentId) as string;
    } else {
      // Main-thread events carry no agent id at all, so they are dealt round
      // robin. `'main'` is never written anywhere — CC omits the key.
      target = sessionIds[mainThreadSeen % sessionIds.length] as string;
      mainThreadSeen += 1;
    }
    events.push(
      normalizeHookEvent(
        { ...payload, session_id: target },
        { seq: i + 1, receivedAt: CLOCK_BASE + i },
      ),
    );
  });

  return { agentIds, events };
}

// ---------------------------------------------------------------------------
// Assorted helpers
// ---------------------------------------------------------------------------

function nodeIds(root: AgentNode): string[] {
  const out: string[] = [];
  walk(root, (node: TreeNode) => out.push(node.id));
  return out;
}

function toolIds(root: AgentNode): string[] {
  const out: string[] = [];
  walk(root, (node: TreeNode) => {
    if (!isAgentNode(node)) out.push(node.id);
  });
  return out;
}

function makeModel(workspacePath: string): SessionModel {
  return new SessionModel({
    workspacePath,
    liveness: new LivenessEngine({ now: () => NOW }),
  });
}

interface Fixtures {
  slugDir: string;
  slug: string;
  workspacePath: string;
  sessionIds: string[];
  replays: ReplaySession[];
}

let cached: Fixtures | undefined;

async function fixtures(): Promise<Fixtures> {
  if (cached !== undefined) return cached;
  const slugDir = await capturedSlugDir();
  const sessionIds = await capturedSessionIds(slugDir);
  const workspacePath = await capturedWorkspacePath(slugDir, sessionIds);
  const replays: ReplaySession[] = [];
  for (const sessionId of sessionIds) {
    replays.push(await loadReplay(join(slugDir, `${sessionId}.jsonl`)));
  }
  cached = { slugDir, slug: basename(slugDir), workspacePath, sessionIds, replays };
  return cached;
}

/**
 * The R4 subject: both captured sessions fed to ONE model in interleaved
 * slices, with the partitioned hook stream interleaved between them too.
 *
 * Every emission is diffed and the diff applied to the caller's own
 * reconstruction, so the snapshot/diff contract is exercised over the whole
 * replay rather than on one hand-made pair of states.
 */
async function replayInterleaved(): Promise<{
  model: SessionModel;
  reconstructed: Map<string, SessionState>;
  emissions: number;
  hookAgentIds: Map<string, Set<string>>;
  /** How many ops of each kind the replay actually produced. */
  opCounts: Map<string, number>;
  /** Ops addressing a node that is not the root — the "nested change" proof. */
  nestedOps: number;
}> {
  const { workspacePath, sessionIds, replays } = await fixtures();
  const model = makeModel(workspacePath);
  const { agentIds, events } = await partitionedHookEvents(sessionIds);

  const lanes = replays.map((replay) => arrivalsFor(replay, model));
  const longest = Math.max(...lanes.map((l) => l.length));
  const reconstructed = new Map<string, SessionState>();
  const opCounts = new Map<string, number>();
  let emissions = 0;
  let nestedOps = 0;

  const drainEmission = (): void => {
    const emission = model.emit();
    emissions += 1;
    for (const id of emission.addedSessionIds) {
      const state = emission.sessions.find((s) => s.sessionId === id);
      expect(state).toBeDefined();
      if (state !== undefined) reconstructed.set(id, state);
    }
    for (const { sessionId, patch } of emission.diffs) {
      const prior = reconstructed.get(sessionId);
      expect(prior, `diff for unknown session ${sessionId}`).toBeDefined();
      if (prior === undefined) continue;
      for (const op of patch.tree ?? []) {
        opCounts.set(op.op, (opCounts.get(op.op) ?? 0) + 1);
        const target =
          'id' in op ? op.id : 'parentId' in op ? op.parentId : undefined;
        if (target !== undefined && target !== 'root') nestedOps += 1;
      }
      reconstructed.set(sessionId, applySessionPatch(prior, patch));
    }
    for (const id of emission.removedSessionIds) reconstructed.delete(id);
    // The contract, checked every single step: apply(prev, diff) === next.
    for (const state of emission.sessions) {
      expect(reconstructed.get(state.sessionId), state.sessionId).toStrictEqual(state);
    }
  };

  let hookCursor = 0;
  const hooksPerStep = Math.ceil(events.length / Math.max(1, longest * lanes.length));

  for (let step = 0; step < longest; step += 1) {
    for (const lane of lanes) {
      const arrival = lane[step];
      if (arrival !== undefined) arrival();
      // Hook events arrive between content arrivals, not in a separate phase.
      for (let k = 0; k < hooksPerStep && hookCursor < events.length; k += 1) {
        const event = events[hookCursor];
        hookCursor += 1;
        if (event !== undefined) model.ingestHookEvent(event);
      }
      drainEmission();
    }
  }
  while (hookCursor < events.length) {
    const event = events[hookCursor];
    hookCursor += 1;
    if (event !== undefined) model.ingestHookEvent(event);
  }
  drainEmission();

  return { model, reconstructed, emissions, hookAgentIds: agentIds, opCounts, nestedOps };
}

// ---------------------------------------------------------------------------
// R4 — two interleaved sessions, both trees correct, zero cross-contamination
// ---------------------------------------------------------------------------

describe('R4: two interleaved sessions', () => {
  it('the captured slug holds at least two sessions to interleave', async () => {
    const { sessionIds } = await fixtures();
    // Derived, not pinned: a re-harvest adds sessions rather than failing here.
    expect(sessionIds.length).toBeGreaterThanOrEqual(2);
  });

  it('every session tree matches the tree an isolated graft produces', async () => {
    const { slugDir, sessionIds } = await fixtures();
    const { model } = await replayInterleaved();

    for (const sessionId of sessionIds) {
      const isolated = await graftSession(join(slugDir, `${sessionId}.jsonl`));
      if (!isolated.ok) throw new Error(`captured session ${sessionId} refused`);
      const interleaved = model.sessionState(sessionId);
      expect(interleaved, sessionId).toBeDefined();
      if (interleaved === undefined) continue;

      expect(interleaved.schemaOk, sessionId).toBe(true);
      expect(interleaved.root, sessionId).toStrictEqual(isolated.snapshot.root);
      expect(interleaved.totals, sessionId).toStrictEqual(isolated.snapshot.totals);
      expect(interleaved.spawnEdges, sessionId).toStrictEqual(
        isolated.snapshot.edges.map((e) => ({
          toolUseId: e.toolUseId,
          agentId: e.agentId,
          parentNodeId: e.parentNodeId,
          depth: e.depth,
          recordedDepth: e.recordedDepth,
        })),
      );
    }
  });

  it('interleaving changes nothing: the same model fed one session at a time agrees', async () => {
    const { workspacePath, sessionIds, replays } = await fixtures();
    const sequential = makeModel(workspacePath);
    for (const replay of replays) {
      for (const step of arrivalsFor(replay, sequential)) step();
    }
    const { model } = await replayInterleaved();
    for (const sessionId of sessionIds) {
      const a = model.sessionState(sessionId);
      const b = sequential.sessionState(sessionId);
      expect(a?.root, sessionId).toStrictEqual(b?.root);
      expect(a?.totals, sessionId).toStrictEqual(b?.totals);
      expect(a?.spawnEdges, sessionId).toStrictEqual(b?.spawnEdges);
    }
  });

  it('no node id appears in more than one session', async () => {
    const { sessionIds } = await fixtures();
    const { model } = await replayInterleaved();

    const seen = new Map<string, string>();
    for (const sessionId of sessionIds) {
      const state = model.sessionState(sessionId);
      if (state === undefined) continue;
      for (const id of nodeIds(state.root)) {
        if (id === 'root') continue; // every main transcript's root is 'root'
        const owner = seen.get(id);
        expect(owner === undefined || owner === sessionId, `${id} in ${owner} and ${sessionId}`).toBe(
          true,
        );
        seen.set(id, sessionId);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("a session's tree contains only agents whose sidecars are its own", async () => {
    const { sessionIds, replays } = await fixtures();
    const { model } = await replayInterleaved();

    for (const sessionId of sessionIds) {
      const replay = replays.find((r) => r.sessionId === sessionId);
      const state = model.sessionState(sessionId);
      if (replay === undefined || state === undefined) continue;
      const own = new Set(replay.sidecars.map((s) => s.agentId));
      const foreign = replays
        .filter((r) => r.sessionId !== sessionId)
        .flatMap((r) => r.sidecars.map((s) => s.agentId));

      const inTree = agentNodes(state.root)
        .filter((n) => n.kind === 'subagent')
        .map((n) => n.id);
      for (const id of inTree) expect(own.has(id), `${id} grafted into ${sessionId}`).toBe(true);

      // The strong form: not merely "the right ones are there" but "the other
      // session's ids appear nowhere at all", including in previews and labels.
      const serialized = JSON.stringify(serializeSessionState(state));
      for (const id of foreign) {
        expect(serialized.includes(id), `${id} leaked into ${sessionId}`).toBe(false);
      }
    }
  });

  it('spawn edges reference only their own session, and never nest a subagent inside a ToolNode', async () => {
    const { sessionIds } = await fixtures();
    const { model } = await replayInterleaved();

    for (const sessionId of sessionIds) {
      const state = model.sessionState(sessionId);
      if (state === undefined) continue;
      const ownNodeIds = new Set(nodeIds(state.root));
      const ownToolIds = new Set(toolIds(state.root));
      const edges = state.spawnEdges ?? [];
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        // The join key names a tool_use block in THIS session...
        expect(ownToolIds.has(edge.toolUseId), `${edge.toolUseId} not in ${sessionId}`).toBe(true);
        // ...and the agent and its parent are nodes of THIS session's tree.
        expect(ownNodeIds.has(edge.agentId), `${edge.agentId} not in ${sessionId}`).toBe(true);
        expect(ownNodeIds.has(edge.parentNodeId), `${edge.parentNodeId} not in ${sessionId}`).toBe(
          true,
        );
      }
      // ToolNode has no `children`, so the spawned agent is a SIBLING of its
      // spawning tool call. The edge is the only record of the relationship,
      // which is exactly why it has to survive into SessionState.
      walk(state.root, (node) => {
        if (isAgentNode(node)) return;
        expect(Object.prototype.hasOwnProperty.call(node, 'children')).toBe(false);
      });
    }
  });

  it('token totals are per session and never pooled', async () => {
    const { slugDir, sessionIds } = await fixtures();
    const { model } = await replayInterleaved();

    let summed = 0;
    for (const sessionId of sessionIds) {
      const isolated = await graftSession(join(slugDir, `${sessionId}.jsonl`));
      if (!isolated.ok) throw new Error('captured session refused');
      const state = model.sessionState(sessionId);
      expect(state?.burn?.prompt, sessionId).toBe(isolated.snapshot.burn.prompt);
      expect(state?.burn?.output, sessionId).toBe(isolated.snapshot.burn.output);
      expect(state?.contextNow, sessionId).toStrictEqual(isolated.snapshot.contextNow);
      // Not yet computed, and 0 does not mean "this session was free".
      expect(state?.totals.costUsd, sessionId).toBe(0);
      summed += isolated.snapshot.burn.output;
    }
    // A pooled accumulator would give every session the sum; assert no session
    // carries it (guarded so a hypothetical single-session capture cannot pass
    // this vacuously).
    if (sessionIds.length > 1) {
      for (const sessionId of sessionIds) {
        expect(model.sessionState(sessionId)?.burn?.output).not.toBe(summed);
      }
    }
  });

  it('liveness state does not cross between sessions either', async () => {
    const { sessionIds } = await fixtures();
    const { model, hookAgentIds } = await replayInterleaved();

    for (const sessionId of sessionIds) {
      const live = model.livenessSnapshot(sessionId);
      expect(live, sessionId).toBeDefined();
      if (live === undefined) continue;
      const own = hookAgentIds.get(sessionId) ?? new Set<string>();
      expect(own.size).toBeGreaterThan(0);
      const foreign = [...hookAgentIds.entries()]
        .filter(([id]) => id !== sessionId)
        .flatMap(([, ids]) => [...ids]);

      for (const agent of live.subagents) {
        expect(agent.agentId, `${sessionId} subagent`).toBeDefined();
        expect(own.has(agent.agentId as string), `${agent.agentId} under ${sessionId}`).toBe(true);
        expect(foreign.includes(agent.agentId as string)).toBe(false);
      }
      // The main thread has no id and none is invented: CC omits `agent_id`
      // and the literal 'main' appears in no capture ever taken.
      expect(live.main.isMainThread).toBe(true);
      expect('agentId' in live.main).toBe(false);
      for (const agent of live.subagents) expect(agent.agentId).not.toBe('main');
    }
  });

  it('every emission round-trips through its own diff', async () => {
    const { sessionIds } = await fixtures();
    const { model, reconstructed, emissions, opCounts, nestedOps } = await replayInterleaved();
    // `replayInterleaved` asserts the round trip after every single emission;
    // this pins that it really did run many of them over both sessions.
    expect(emissions).toBeGreaterThan(4);
    for (const sessionId of sessionIds) {
      expect(reconstructed.get(sessionId)).toStrictEqual(model.sessionState(sessionId));
    }
    // And that the round trip was not trivially satisfied by append-only
    // patches: a real replay changes nodes that already exist, deep in the
    // tree, and those are the patches most likely to be wrong.
    expect(opCounts.get('insertNode') ?? 0).toBeGreaterThan(0);
    expect((opCounts.get('updateTool') ?? 0) + (opCounts.get('updateAgent') ?? 0)).toBeGreaterThan(0);
    expect(nestedOps).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// G2 — a content hard failure must not touch liveness
// ---------------------------------------------------------------------------

/** An entry whose `message` explodes when the grafter's scan reads it. */
function explodingEntry(message: string): TranscriptEntry {
  const entry: TranscriptEntry = { type: 'assistant' };
  Object.defineProperty(entry, 'message', {
    enumerable: true,
    get(): never {
      throw new Error(message);
    },
  });
  return entry;
}

/** A sidecar whose join key explodes at snapshot time, not at arrival time. */
function explodingSidecar(agentId: string, message: string): SidecarArrival {
  const meta = { agentType: 'x', description: 'y', spawnDepth: 1 } as unknown as SubagentMeta;
  Object.defineProperty(meta, 'toolUseId', {
    enumerable: true,
    get(): never {
      throw new Error(message);
    },
  });
  return { agentId, metaPath: `${agentId}.meta.json`, meta };
}

/** Hook events for one session id, main thread only, at a fixed instant. */
function mainThreadEvents(sessionId: string, names: readonly string[], from: number): NormalizedHookEvent[] {
  return names.map((hook_event_name, i) =>
    // No `agent_id` key at all — this is what a real main-thread event is.
    normalizeHookEvent(
      { hook_event_name, session_id: sessionId, tool_use_id: `toolu_g2_${i}`, tool_name: 'Bash' },
      { seq: from + i, receivedAt: CLOCK_BASE + from + i },
    ),
  );
}

describe('G2: a parser hard failure never reaches liveness', () => {
  it('a throw inside the grafter refuses one session and no other', async () => {
    const { slugDir, slug, workspacePath, sessionIds } = await fixtures();
    const [victim, bystander] = sessionIds as [string, string];
    const model = makeModel(workspacePath);

    for (const sessionId of sessionIds) {
      const result = await graftSession(join(slugDir, `${sessionId}.jsonl`));
      model.ingestGraftResult(sessionId, slug, result);
    }
    model.ingestHookEvent(mainThreadEvents(victim, ['PreToolUse'], 1)[0] as NormalizedHookEvent);
    model.ingestHookEvent(mainThreadEvents(bystander, ['PreToolUse'], 2)[0] as NormalizedHookEvent);

    const before = model.sessionState(victim);
    expect(before?.schemaOk).toBe(true);
    expect(before?.root.children.length).toBeGreaterThan(0);
    const beforeAgents = agentNodes(before?.root as AgentNode).map((n) => n.id);
    const beforeLive = model.livenessSnapshot(victim);
    expect(beforeLive?.hookEventCount).toBe(1);

    // The hard failure. Not "the parser returned nothing" — a real throw from
    // inside the grafter's scan of a transcript line.
    expect(() => {
      model.ingestTranscript(victim, slug, {
        kind: 'main',
        path: `${victim}-late.jsonl`,
        entries: [explodingEntry('injected parser hard failure')],
      });
    }).not.toThrow();

    const after = model.sessionState(victim);
    expect(after?.schemaOk).toBe(false);
    expect(after?.liveness).toBe('unsupported');
    // G3: no partial tree. Not a smaller tree — no tree.
    expect(after?.root.children).toStrictEqual([]);
    expect(after?.totals).toStrictEqual({ costUsd: 0 });
    // A refused session reports zero tokens rather than the numbers it had:
    // G3's 'never a partial tree' covers numbers too.
    expect(after?.contextNow).toStrictEqual({ prompt: 0, output: 0 });
    expect(after?.burn).toStrictEqual({ prompt: 0, output: 0 });
    expect(after?.spawnEdges).toStrictEqual([]);
    const serialized = JSON.stringify(serializeSessionState(after as SessionState));
    for (const id of beforeAgents) {
      if (id === 'root') continue;
      expect(serialized.includes(id), `${id} survived the refusal`).toBe(false);
    }
    expect(model.counters().contentFailures).toBe(1);
    expect(model.lastFailure()).toContain('injected parser hard failure');
    expect(model.refusalOf(victim)?.thrown).toContain('injected parser hard failure');

    // The whole point: liveness for the refused session keeps advancing.
    for (const event of mainThreadEvents(victim, ['PreToolUse', 'PostToolUse', 'PreToolUse'], 10)) {
      model.ingestHookEvent(event);
    }
    const afterLive = model.livenessSnapshot(victim);
    expect(afterLive?.hookEventCount).toBe(4);
    expect(afterLive?.main.status).toBe('running');
    expect(afterLive?.runningAgentCount).toBeGreaterThan(0);
    // And the underlying state is correct the moment the schema question is
    // resolved — `unsupported` is a mask over a live engine, not a dead one.
    expect(afterLive?.schemaSupported).toBe(false);

    // The bystander is untouched in both halves.
    const other = model.sessionState(bystander);
    expect(other?.schemaOk).toBe(true);
    expect(other?.root.children.length).toBeGreaterThan(0);
    expect(other?.liveness).not.toBe('unsupported');
    for (const event of mainThreadEvents(bystander, ['PreToolUse', 'PostToolUse'], 20)) {
      model.ingestHookEvent(event);
    }
    expect(model.livenessSnapshot(bystander)?.hookEventCount).toBe(3);
    expect(model.sessionState(bystander)?.root.children.length).toBeGreaterThan(0);
  });

  it('a throw raised at snapshot time is caught the same way', async () => {
    const { workspacePath } = await fixtures();
    const model = makeModel(workspacePath);
    const slug = slugifyWorkspace(workspacePath);

    model.ingestSidecar('s-late', slug, explodingSidecar('a1', 'exploding join key'));
    model.ingestHookEvent(mainThreadEvents('s-late', ['PreToolUse'], 1)[0] as NormalizedHookEvent);

    // The arrival itself stored fine; the failure happens when the tree is built.
    const state = model.sessionState('s-late');
    expect(state?.schemaOk).toBe(false);
    expect(state?.liveness).toBe('unsupported');
    expect(state?.root.children).toStrictEqual([]);
    expect(model.counters().contentFailures).toBe(1);
    expect(model.lastFailure()).toContain('exploding join key');

    model.ingestHookEvent(mainThreadEvents('s-late', ['PostToolUse'], 2)[0] as NormalizedHookEvent);
    expect(model.livenessSnapshot('s-late')?.hookEventCount).toBe(2);
  });

  it('a real layout mismatch refuses without a partial tree, liveness still flowing', async () => {
    const { workspacePath } = await fixtures();
    const model = makeModel(workspacePath);
    const slug = slugifyWorkspace(workspacePath);

    // A hand-mutated layout from `fixtures/synthetic-layout/`: the subagents
    // directory is renamed, which is the drift the fingerprint exists to catch.
    const main = join(LAYOUT_ROOT, '05-subagents-dir-renamed', SYNTHETIC_SLUG, `${LAYOUT_SESSION}.jsonl`);
    const result = await graftSession(main);
    expect(result.ok).toBe(false);

    model.ingestHookEvent(mainThreadEvents(LAYOUT_SESSION, ['PreToolUse'], 1)[0] as NormalizedHookEvent);
    model.ingestGraftResult(LAYOUT_SESSION, slug, result);

    const state = model.sessionState(LAYOUT_SESSION);
    expect(state?.schemaOk).toBe(false);
    expect(state?.liveness).toBe('unsupported');
    expect(state?.root.children).toStrictEqual([]);
    expect(state?.spawnEdges).toStrictEqual([]);
    expect(model.refusalOf(LAYOUT_SESSION)?.mismatch).toBeDefined();
    // A refusal is not a throw: it is a typed answer, so nothing was counted
    // as a content failure.
    expect(model.counters().contentFailures).toBe(0);

    for (const event of mainThreadEvents(LAYOUT_SESSION, ['PreToolUse', 'PostToolUse'], 30)) {
      model.ingestHookEvent(event);
    }
    expect(model.livenessSnapshot(LAYOUT_SESSION)?.hookEventCount).toBe(3);
    expect(model.livenessSnapshot(LAYOUT_SESSION)?.main.status).toBe('running');
  });

  it('the emission reports the schema mismatch exactly once, on the transition', async () => {
    const { slugDir, slug, workspacePath, sessionIds } = await fixtures();
    const [victim] = sessionIds as [string];
    const model = makeModel(workspacePath);
    model.ingestGraftResult(
      victim,
      slug,
      await graftSession(join(slugDir, `${victim}.jsonl`)),
    );
    expect(model.emit().schemaMismatchSessionIds).toStrictEqual([]);

    model.refuseSession(victim, slug, { kind: 'schemaMismatch', reason: 'test refusal' });
    expect(model.emit().schemaMismatchSessionIds).toStrictEqual([victim]);
    // Sticky, and not re-announced on every tick.
    expect(model.emit().schemaMismatchSessionIds).toStrictEqual([]);
    expect(model.sessionState(victim)?.schemaOk).toBe(false);
  });

  it('a successful whole-session graft is the only thing that clears a refusal', async () => {
    const { slugDir, slug, workspacePath, sessionIds } = await fixtures();
    const [victim] = sessionIds as [string];
    const model = makeModel(workspacePath);

    model.refuseSession(victim, slug, { kind: 'schemaMismatch', reason: 'test refusal' });
    expect(model.sessionState(victim)?.schemaOk).toBe(false);

    // A single later batch parsing cleanly is NOT evidence the session reads
    // cleanly, so it must not clear the refusal.
    const replay = (await fixtures()).replays.find((r) => r.sessionId === victim);
    if (replay === undefined) throw new Error('replay missing');
    model.ingestTranscript(victim, slug, {
      kind: 'main',
      path: replay.main.path,
      entries: replay.main.entries,
    });
    expect(model.sessionState(victim)?.schemaOk).toBe(false);
    expect(model.sessionState(victim)?.root.children).toStrictEqual([]);

    model.ingestGraftResult(victim, slug, await graftSession(join(slugDir, `${victim}.jsonl`)));
    expect(model.sessionState(victim)?.schemaOk).toBe(true);
    expect(model.sessionState(victim)?.root.children.length).toBeGreaterThan(0);
    expect(model.sessionState(victim)?.liveness).not.toBe('unsupported');
  });
});

// ---------------------------------------------------------------------------
// Snapshot / diff contract
// ---------------------------------------------------------------------------

function baseState(): SessionState {
  return {
    sessionId: 's1',
    projectSlug: 'slug',
    workspaceMatch: true,
    liveness: 'live',
    schemaOk: true,
    root: {
      id: 'root',
      kind: 'main',
      label: 'root',
      status: 'running',
      spawnDepth: 0,
      contextNow: { prompt: 1, output: 2 }, burn: { prompt: 1, output: 2 },
      startedAt: 100,
      children: [
        {
          id: 't1',
          toolName: 'Agent',
          status: 'done',
          inputPreview: 'in',
          resultPreview: 'out',
          durationMs: 5,
        },
        {
          id: 'a1',
          kind: 'subagent',
          label: 'general-purpose: one',
          status: 'running',
          spawnDepth: 1,
          contextNow: { prompt: 3, output: 4 }, burn: { prompt: 3, output: 4 },
          startedAt: 110,
          children: [
            { id: 't2', toolName: 'Bash', status: 'running', inputPreview: 'ls' },
            { id: 't3', toolName: 'Read', status: 'done', inputPreview: 'f', durationMs: 2 },
          ],
        },
      ],
    },
    totals: { costUsd: 0 }, contextNow: { prompt: 4, output: 6 }, burn: { prompt: 4, output: 6 },
    spawnEdges: [
      { toolUseId: 't1', agentId: 'a1', parentNodeId: 'root', depth: 1, recordedDepth: 1 },
    ],
  };
}

function roundTrip(prev: SessionState, next: SessionState): void {
  const patch = diffSessionState(prev, next);
  expect(patch, 'expected a patch').toBeDefined();
  if (patch === undefined) return;
  expect(applySessionPatch(prev, patch)).toStrictEqual(applySessionPatch(next, {}));
}

describe('snapshot/diff contract', () => {
  it('identical states produce no patch at all', () => {
    expect(diffSessionState(baseState(), baseState())).toBeUndefined();
  });

  it('removing a nested node round-trips', () => {
    const prev = baseState();
    const next = baseState();
    const agent = next.root.children[1] as AgentNode;
    agent.children = agent.children.filter((c) => c.id !== 't2');
    const patch = diffSessionState(prev, next);
    expect(patch?.tree).toContainEqual({ op: 'removeNode', id: 't2' });
    roundTrip(prev, next);
  });

  it('changing a nested node round-trips, and clears fields that became absent', () => {
    const prev = baseState();
    const next = baseState();
    const agent = next.root.children[1] as AgentNode;
    agent.status = 'done';
    agent.endedAt = 500;
    agent.contextNow = { prompt: 9, output: 9 };
    agent.burn = { prompt: 18, output: 18 };
    const tool = agent.children[1];
    if (tool !== undefined && !isAgentNode(tool)) {
      tool.status = 'error';
      delete tool.durationMs;
    }
    const patch = diffSessionState(prev, next);
    expect(patch?.tree).toContainEqual({
      op: 'updateTool',
      id: 't3',
      fields: { status: 'error', durationMs: null },
    });
    const applied = applySessionPatch(prev, patch as NonNullable<typeof patch>);
    const appliedTool = (applied.root.children[1] as AgentNode).children[1];
    expect(appliedTool && 'durationMs' in appliedTool).toBe(false);
    roundTrip(prev, next);
  });

  it('removing a whole subtree round-trips', () => {
    const prev = baseState();
    const next = baseState();
    next.root.children = next.root.children.filter((c) => c.id !== 'a1');
    next.spawnEdges = [];
    roundTrip(prev, next);
    const patch = diffSessionState(prev, next);
    expect(patch?.spawnEdges).toStrictEqual([]);
  });

  it('reordered children round-trip', () => {
    const prev = baseState();
    const next = baseState();
    next.root.children = [...next.root.children].reverse();
    const patch = diffSessionState(prev, next);
    expect(patch?.tree).toContainEqual({
      op: 'reorderChildren',
      parentId: 'root',
      order: ['a1', 't1'],
    });
    roundTrip(prev, next);
  });

  it('a node moving to a different parent round-trips', () => {
    const prev = baseState();
    const next = baseState();
    const agent = next.root.children[1] as AgentNode;
    const moved = agent.children.find((c) => c.id === 't2');
    agent.children = agent.children.filter((c) => c.id !== 't2');
    if (moved !== undefined) next.root.children.push(moved);
    roundTrip(prev, next);
  });

  it('a node changing kind is replaced, not patched into a chimera', () => {
    const prev = baseState();
    const next = baseState();
    next.root.children[0] = {
      id: 't1',
      kind: 'subagent',
      label: 'was a tool',
      status: 'running',
      spawnDepth: 1,
      contextNow: { prompt: 0, output: 0 }, burn: { prompt: 0, output: 0 },
      startedAt: 1,
      children: [],
    };
    const patch = diffSessionState(prev, next);
    expect(patch?.tree?.[0]?.op).toBe('replaceNode');
    roundTrip(prev, next);
  });

  it('a changed root id replaces the whole tree', () => {
    const prev = baseState();
    const next = baseState();
    next.root = { ...next.root, id: 'other' };
    const patch = diffSessionState(prev, next);
    expect(patch?.tree?.[0]?.op).toBe('replaceRoot');
    roundTrip(prev, next);
  });

  it('session-level scalars round-trip on their own', () => {
    const prev = baseState();
    const next = baseState();
    next.liveness = 'ended';
    next.schemaOk = false;
    next.totals = { costUsd: 0 };
    next.contextNow = { prompt: 99, output: 1 };
    next.burn = { prompt: 198, output: 2 };
    const patch = diffSessionState(prev, next);
    expect(patch?.tree).toBeUndefined();
    expect(patch?.fields).toStrictEqual({
      liveness: 'ended',
      schemaOk: false,
      contextNow: { prompt: 99, output: 1 },
      burn: { prompt: 198, output: 2 },
    });
    roundTrip(prev, next);
  });

  // -------------------------------------------------------------------------
  // ToolNode.truncated — gate amendment B7
  // -------------------------------------------------------------------------
  // The CC engine never sets this flag; the OpenCode engine does. What is at
  // stake here is not the flag's content but the EXACTNESS of the patch
  // contract: `events.ts` states that apply(prev, diff(prev, next)) deep-equals
  // `next` for any two states the model produces, and an optional field the
  // patch cannot express breaks that property rather than under-reporting it.
  // So all three transitions are pinned — set, changed, and cleared — and the
  // clear has to remove the key rather than write `false`.

  it('a tool node gaining truncated round-trips', () => {
    const prev = baseState();
    const next = baseState();
    (next.root.children[0] as ToolNode).truncated = true;
    const patch = diffSessionState(prev, next);
    expect(patch?.tree).toContainEqual({
      op: 'updateTool',
      id: 't1',
      fields: { truncated: true },
    });
    roundTrip(prev, next);
  });

  it('a tool node changing truncated from true to false round-trips as false, not as a clear', () => {
    // `false` is the engine claiming the payload IS whole. That is a different
    // statement from making no claim at all, and collapsing the two would tell
    // a renderer a truncated payload is retrievable.
    const prev = baseState();
    (prev.root.children[0] as ToolNode).truncated = true;
    const next = baseState();
    (next.root.children[0] as ToolNode).truncated = false;
    const patch = diffSessionState(prev, next);
    expect(patch?.tree).toContainEqual({
      op: 'updateTool',
      id: 't1',
      fields: { truncated: false },
    });
    const applied = applySessionPatch(prev, patch as NonNullable<typeof patch>);
    expect((applied.root.children[0] as ToolNode).truncated).toBe(false);
    roundTrip(prev, next);
  });

  it('a tool node losing truncated emits null and the key really goes away', () => {
    const prev = baseState();
    (prev.root.children[0] as ToolNode).truncated = true;
    const next = baseState();
    const patch = diffSessionState(prev, next);
    expect(patch?.tree).toContainEqual({
      op: 'updateTool',
      id: 't1',
      fields: { truncated: null },
    });
    const applied = applySessionPatch(prev, patch as NonNullable<typeof patch>);
    const appliedTool = applied.root.children[0];
    expect(appliedTool && 'truncated' in appliedTool).toBe(false);
    roundTrip(prev, next);
  });

  // -------------------------------------------------------------------------
  // SessionState.engine — gate amendment B2
  // -------------------------------------------------------------------------
  // These states are hand-built on purpose. `diffSessionState` can never see an
  // engine change from the model — `stateOf` stamps `'cc'` on every state it
  // produces and nothing can change a session's engine — so the branch is
  // reachable only from literals. Nothing below claims otherwise.

  it('two states carrying the same engine produce no patch at all', () => {
    const prev = baseState();
    prev.engine = 'cc';
    const next = baseState();
    next.engine = 'cc';
    expect(diffSessionState(prev, next)).toBeUndefined();
  });

  it('an engine change is expressible and round-trips, though no engine produces one', () => {
    const prev = baseState();
    prev.engine = 'cc';
    const next = baseState();
    next.engine = 'opencode';
    const patch = diffSessionState(prev, next);
    expect(patch?.fields).toStrictEqual({ engine: 'opencode' });
    expect(patch?.tree).toBeUndefined();
    roundTrip(prev, next);
  });

  it('a stamped state going back to an UNSTAMPED one is inexpressible, and says nothing', () => {
    // Recorded rather than papered over. `SessionFieldPatch.engine` has no
    // `null` — unlike `ToolNodeFieldPatch.truncated` — so "the engine tag went
    // away" cannot be put on the wire. This is therefore the one state pair for
    // which apply(prev, diff(prev, next)) does NOT deep-equal `next`.
    //
    // It is safe because no state the model produces makes that transition:
    // every one is stamped. What IS asserted is that the diff stays silent
    // instead of emitting `engine: undefined`, which would be a patch claiming
    // a change it cannot make and would be read back as "unchanged" anyway.
    const prev = baseState();
    prev.engine = 'cc';
    const next = baseState();
    expect(diffSessionState(prev, next)).toBeUndefined();
    expect(applySessionPatch(prev, {}).engine).toBe('cc');
    expect(applySessionPatch(next, {}).engine).toBeUndefined();
  });

  it('applying a patch does not mutate the state it was applied to', () => {
    const prev = baseState();
    const next = baseState();
    (next.root.children[1] as AgentNode).status = 'done';
    const patch = diffSessionState(prev, next) as NonNullable<
      ReturnType<typeof diffSessionState>
    >;
    const snapshotBefore = JSON.stringify(prev);
    applySessionPatch(prev, patch);
    expect(JSON.stringify(prev)).toBe(snapshotBefore);
  });

  /**
   * DoD 5.5.1 SPLIT THIS TEST IN TWO, and the split is the whole point of the
   * item. Before Phase 5.5 all four cases below threw, and the webview's catch
   * discarded the entire patch — which is how one missing node became a
   * session-long divergence (`AUDIT-2026-08-27` section 7.3, H5).
   *
   * Now: a DIVERGENCE (an id this tree does not have) is reported and skipped,
   * and a PRODUCER BUG (a patch that would leave the session without an agent
   * root) still throws.
   */
  it('a divergent op is reported and skipped, not thrown', () => {
    const prev = baseState();
    const errors: ApplyError[] = [];
    const collect = { onError: (e: ApplyError) => errors.push(e) };

    const afterRemove = applySessionPatch(prev, { tree: [{ op: 'removeNode', id: 'nope' }] }, collect);
    expect(errors.map((e) => e.op)).toEqual(['removeNode']);
    expect(errors[0]?.id).toBe('nope');
    // The tree is untouched: the op asked for a node to be absent and it is.
    // `toStrictEqual` rather than a JSON compare — the reducer rebuilds every
    // node, so key ORDER legitimately differs while the value does not.
    expect(afterRemove.root).toStrictEqual(prev.root);

    errors.length = 0;
    applySessionPatch(
      prev,
      { tree: [{ op: 'insertNode', parentId: 't1', afterId: null, node: prev.root }] },
      collect,
    );
    expect(errors.map((e) => e.op)).toEqual(['insertNode']);
    expect(errors[0]?.id).toBe('t1');

    errors.length = 0;
    applySessionPatch(
      prev,
      { tree: [{ op: 'reorderChildren', parentId: 'root', order: ['t1'] }] },
      collect,
    );
    expect(errors.map((e) => e.op)).toEqual(['reorderChildren']);

    // And with NO reporter the same patches are silent rather than fatal —
    // which is what makes the reducer safe to call from a renderer that has
    // nowhere to put an exception.
    expect(() => applySessionPatch(prev, { tree: [{ op: 'removeNode', id: 'nope' }] })).not.toThrow();
  });

  it('a patch that would break the root invariant still throws', () => {
    const prev = baseState();
    // Removing the root cannot be a divergence: every session has one, and a
    // producer that asks for this is broken rather than behind.
    expect(() => applySessionPatch(prev, { tree: [{ op: 'removeNode', id: 'root' }] })).toThrow(
      SessionPatchError,
    );
    // Same class: the root must be an agent node.
    expect(() =>
      applySessionPatch(prev, {
        tree: [{ op: 'replaceNode', id: 'root', node: prev.root.children[0] as TreeNode }],
      }),
    ).toThrow(SessionPatchError);
    // A reporter does not soften either one.
    expect(() =>
      applySessionPatch(prev, { tree: [{ op: 'removeNode', id: 'root' }] }, { onError: () => {} }),
    ).toThrow(SessionPatchError);
  });

  /**
   * THE REGRESSION TEST FOR THE SHIPPED DEFECT (DoD 5.5.1).
   *
   * Stage the exact `0.1.2` failure shape — a receiver whose child list is one
   * node short of the sender's — then drive fifty further ops through it. With
   * index-keyed inserts every one of those fifty landed in the wrong place or
   * addressed a node that was not there. With sibling anchors the tree
   * converges: every node the sender ever inserted is present at the end.
   */
  it('converges after a missing node instead of compounding (the 0.1.2 shape)', () => {
    const prev = baseState();
    // The receiver is missing one child the sender believes it has.
    const short = structuredClone(prev) as SessionState;
    const shortRoot = short.root as AgentNode;
    const dropped = shortRoot.children[0] as TreeNode;
    shortRoot.children = shortRoot.children.slice(1);

    const errors: ApplyError[] = [];
    let receiver: SessionState = short;
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const id = `late-${String(i)}`;
      ids.push(id);
      const node: ToolNode = {
        id,
        toolName: 'Bash',
        status: 'done',
        inputPreview: '',
      };
      // Anchored on the node inserted immediately before it, exactly as
      // `diffNode` emits a run of consecutive inserts. The FIRST one anchors
      // on the child the receiver is missing, which is the divergence.
      const afterId = i === 0 ? dropped.id : `late-${String(i - 1)}`;
      receiver = applySessionPatch(
        receiver,
        { tree: [{ op: 'insertNode', parentId: 'root', afterId, node }] },
        { onError: (e) => errors.push(e) },
      );
    }

    // Exactly ONE op could not be honoured as written — the first, whose
    // anchor is the missing node. The other forty-nine anchored on nodes this
    // tree does have, so they are not merely present, they are IN ORDER.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.op).toBe('insertNode');
    expect(errors[0]?.id).toBe(dropped.id);

    const present = (receiver.root as AgentNode).children.map((c) => c.id);
    for (const id of ids) expect(present).toContain(id);
    // The run kept its relative order despite starting from a divergence.
    const positions = ids.map((id) => present.indexOf(id));
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// Immutability, workspace scoping, refusal hygiene
// ---------------------------------------------------------------------------

describe('emitted snapshots are immutable', () => {
  it('a snapshot handed out earlier is not changed by later ingestion', async () => {
    const { slugDir, slug, workspacePath, sessionIds, replays } = await fixtures();
    const [sessionId] = sessionIds as [string];
    const replay = replays.find((r) => r.sessionId === sessionId);
    if (replay === undefined) throw new Error('replay missing');
    const model = makeModel(workspacePath);

    // Half the main transcript, then a snapshot the caller keeps.
    const half = Math.max(1, Math.floor(replay.main.entries.length / 2));
    model.ingestTranscript(sessionId, slug, {
      kind: 'main',
      path: replay.main.path,
      entries: replay.main.entries.slice(0, half),
    });
    const early = model.sessionState(sessionId) as SessionState;
    const earlyJson = JSON.stringify(serializeSessionState(early));
    expect(Object.isFrozen(early)).toBe(true);
    expect(Object.isFrozen(early.root)).toBe(true);

    // Everything else arrives.
    for (const step of arrivalsFor(replay, model)) step();
    const later = model.sessionState(sessionId) as SessionState;

    expect(JSON.stringify(serializeSessionState(early))).toBe(earlyJson);
    expect(early.root).not.toBe(later.root);
    expect(JSON.stringify(serializeSessionState(later))).not.toBe(earlyJson);

    // And the frozen graph really is frozen, not merely unmutated by luck.
    expect(() => {
      (early.root.children as TreeNode[]).push({
        id: 'x',
        toolName: 'x',
        status: 'done',
        inputPreview: '',
      });
    }).toThrow();
    expect(JSON.stringify(serializeSessionState(early))).toBe(earlyJson);

    // The isolated graft agrees with the fully-fed model.
    const isolated = await graftSession(join(slugDir, `${sessionId}.jsonl`));
    if (!isolated.ok) throw new Error('captured session refused');
    expect(later.root).toStrictEqual(isolated.snapshot.root);
  });

  it('repeated snapshots of unchanged content reuse the same tree object', async () => {
    const { slugDir, slug, workspacePath, sessionIds } = await fixtures();
    const [sessionId] = sessionIds as [string];
    const model = makeModel(workspacePath);
    model.ingestGraftResult(
      sessionId,
      slug,
      await graftSession(join(slugDir, `${sessionId}.jsonl`)),
    );
    const a = model.sessionState(sessionId) as SessionState;
    const b = model.sessionState(sessionId) as SessionState;
    expect(a.root).toBe(b.root);
    expect(a).not.toBe(b);
  });
});

describe('workspace scoping', () => {
  it('sessions outside the open workspace are excluded from the snapshot', async () => {
    const { slugDir, slug, workspacePath, sessionIds } = await fixtures();
    const [mine] = sessionIds as [string];
    const model = makeModel(workspacePath);

    model.ingestGraftResult(mine, slug, await graftSession(join(slugDir, `${mine}.jsonl`)));
    model.registerSession({
      sessionId: 'foreign-session',
      projectSlug: 'c--Users-dev-some-other-workspace',
    });

    expect(model.snapshot().map((s) => s.sessionId)).toStrictEqual([mine]);
    const all = model.allSessions().map((s) => s.sessionId).sort();
    expect(all).toStrictEqual([...[mine, 'foreign-session']].sort());
    expect(model.allSessions().find((s) => s.sessionId === 'foreign-session')?.workspaceMatch).toBe(
      false,
    );
    // The emission the webview would receive never mentions it.
    const emission = model.emit();
    expect(emission.addedSessionIds).toStrictEqual([mine]);
    expect(JSON.stringify(emission.sessions).includes('foreign-session')).toBe(false);
  });

  it('a slug differing only in drive-letter case still matches', async () => {
    const { workspacePath } = await fixtures();
    const model = makeModel(workspacePath);
    const slug = slugifyWorkspace(workspacePath);
    const flipped = slug.charAt(0) === slug.charAt(0).toLowerCase()
      ? slug.charAt(0).toUpperCase() + slug.slice(1)
      : slug.charAt(0).toLowerCase() + slug.slice(1);
    expect(flipped).not.toBe(slug);
    model.registerSession({ sessionId: 'case-variant', projectSlug: flipped });
    expect(model.snapshot().map((s) => s.sessionId)).toStrictEqual(['case-variant']);
  });

  it('applyCorrelation registers exactly the correlator’s sessions', async () => {
    const { workspacePath, sessionIds } = await fixtures();
    const correlation = await correlateWorkspace(workspacePath, { projectsRoot: CAPTURED_ROOT });
    expect(correlation.ok).toBe(true);
    if (!correlation.ok) return;
    const model = makeModel(workspacePath);
    model.applyCorrelation(correlation.value);
    expect(model.sessionIds()).toStrictEqual([...sessionIds].sort());
    // Registered but with no content yet: every one is schemaOk with an empty
    // tree, which is "nothing has arrived", not "the schema failed".
    for (const state of model.snapshot()) {
      expect(state.schemaOk).toBe(true);
      expect(state.root.children).toStrictEqual([]);
      expect(state.workspaceMatch).toBe(true);
    }
  });

  it('hook events for a session outside the workspace are counted, never rendered', async () => {
    const { workspacePath } = await fixtures();
    const model = makeModel(workspacePath);
    model.ingestHookEvent(
      mainThreadEvents('someone-elses-session', ['PreToolUse'], 1)[0] as NormalizedHookEvent,
    );
    expect(model.counters().hookEventsForeignSession).toBe(1);
    expect(model.snapshot()).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Golden snapshots
// ---------------------------------------------------------------------------

describe('the interleaved replay matches its committed goldens', () => {
  it('every captured session has a session golden and matches it', async () => {
    const { sessionIds } = await fixtures();
    const { model } = await replayInterleaved();
    if (UPDATE_GOLDENS) await mkdir(GOLDEN_DIR, { recursive: true });

    for (const sessionId of sessionIds) {
      const state = model.sessionState(sessionId);
      expect(state, sessionId).toBeDefined();
      if (state === undefined) continue;
      const produced = sessionGoldenText(state);
      const goldenPath = join(GOLDEN_DIR, `${sessionId}.json`);
      if (UPDATE_GOLDENS) {
        await writeFile(goldenPath, produced, 'utf8');
        continue;
      }
      const committed = await readFile(goldenPath, 'utf8');
      expect(committed.split('\r\n').join('\n'), `golden mismatch for ${sessionId}`).toBe(produced);
    }
  });

  it('the golden directory holds exactly one golden per captured session', async () => {
    if (UPDATE_GOLDENS) return;
    const { sessionIds } = await fixtures();
    const goldens = (await readdir(GOLDEN_DIR))
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.replace(/\.json$/, ''))
      .sort();
    expect(goldens).toStrictEqual([...sessionIds].sort());
  });

  it('no golden carries a machine path, a drive letter or a ~/.claude reference', async () => {
    if (UPDATE_GOLDENS) return;
    const names = (await readdir(GOLDEN_DIR)).filter((n) => n.endsWith('.json'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const text = await readFile(join(GOLDEN_DIR, name), 'utf8');
      expect(/[A-Za-z]:[\\/]/.test(text), `${name} carries a drive letter`).toBe(false);
      expect(text.includes('/Users/'), `${name} carries /Users/`).toBe(false);
      expect(text.toLowerCase().includes('.claude'), `${name} references .claude`).toBe(false);
      expect(text.includes('\\\\'), `${name} carries a windows path separator`).toBe(false);
    }
  });

  it('a golden carries exactly one wall-clock string, the epoch anchor', async () => {
    if (UPDATE_GOLDENS) return;
    const names = (await readdir(GOLDEN_DIR)).filter((n) => n.endsWith('.json'));
    for (const name of names) {
      const text = await readFile(join(GOLDEN_DIR, name), 'utf8');
      const isoStrings = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g) ?? [];
      expect(isoStrings.length, `${name} has ${isoStrings.length} ISO timestamps`).toBe(1);
    }
  });

  it('goldens are byte-stable across two independent replays', async () => {
    const { sessionIds } = await fixtures();
    const first = await replayInterleaved();
    const second = await replayInterleaved();
    for (const sessionId of sessionIds) {
      const a = first.model.sessionState(sessionId) as SessionState;
      const b = second.model.sessionState(sessionId) as SessionState;
      expect(sessionGoldenText(a), sessionId).toBe(sessionGoldenText(b));
    }
  });
});

// ---------------------------------------------------------------------------
// G1 — nothing this model does writes anything
// ---------------------------------------------------------------------------

describe('G1: the session model writes nothing', () => {
  it('a full interleaved replay leaves every captured fixture byte-identical', async () => {
    const { slugDir } = await fixtures();
    const digest = async (): Promise<string> => {
      const names = (await readdir(slugDir, { recursive: true })).sort();
      const parts: string[] = [];
      for (const name of names) {
        const full = join(slugDir, name);
        let bytes: Buffer;
        try {
          bytes = await readFile(full);
        } catch {
          continue; // a directory, not a file
        }
        parts.push(`${name}:${createHash('sha256').update(bytes).digest('hex')}`);
      }
      return parts.join('|');
    };
    const before = await digest();
    await replayInterleaved();
    expect(await digest()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Parked grafts on the wire
// ---------------------------------------------------------------------------

/**
 * A parked graft is an agent the grafter knows exists and refused to attach,
 * because its join to a spawning `tool_use` block did not resolve. It is
 * deliberately absent from `root` and carries no spawn edge, so
 * `SessionState.parked` is the ONLY channel by which it reaches a renderer.
 *
 * Everything below is driven by `fixtures/synthetic-graft/` through
 * `graftSession` and `SessionModel` — the production path. No `SessionState`
 * literal with a parked entry appears here: a hand-built one would assert that
 * a field can hold a value it was handed, which is true of any field.
 *
 * Fixtures are chosen by PROPERTY — graft it, then ask whether it parked —
 * never by directory name and never by count. A re-harvest that renames, adds
 * or drops cases changes which subject is used and changes no assertion.
 */
const SYNTHETIC_GRAFT_ROOT = fileURLToPath(
  new URL('../../fixtures/synthetic-graft', import.meta.url),
);

interface GraftSubject {
  /** Case directory name. Used in failure messages only, never to select. */
  caseName: string;
  mainPath: string;
  sessionId: string;
  snapshot: GraftSnapshot;
}

let graftSubjectCache: GraftSubject[] | undefined;

/** Every committed synthetic-graft transcript that fingerprints, grafted once. */
async function graftSubjects(): Promise<GraftSubject[]> {
  if (graftSubjectCache !== undefined) return graftSubjectCache;
  const subdirs = async (dir: string): Promise<string[]> =>
    (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

  const out: GraftSubject[] = [];
  for (const caseName of await subdirs(SYNTHETIC_GRAFT_ROOT)) {
    const caseDir = join(SYNTHETIC_GRAFT_ROOT, caseName);
    for (const slugName of await subdirs(caseDir)) {
      const slugDir = join(caseDir, slugName);
      const mains = (await readdir(slugDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => e.name)
        .sort();
      for (const main of mains) {
        const mainPath = join(slugDir, main);
        const result = await graftSession(mainPath);
        if (!result.ok) continue;
        out.push({
          caseName,
          mainPath,
          sessionId: main.replace(/\.jsonl$/, ''),
          snapshot: result.snapshot,
        });
      }
    }
  }
  graftSubjectCache = out;
  return out;
}

/** The committed cases whose graft actually parks something. */
async function parkingSubjects(): Promise<GraftSubject[]> {
  return (await graftSubjects()).filter((s) => s.snapshot.parked.length > 0);
}

/** A committed case that parks nothing — the "before" half of a diff. */
async function cleanSubject(): Promise<GraftSubject> {
  const found = (await graftSubjects()).find((s) => s.snapshot.parked.length === 0);
  if (found === undefined) throw new Error('no committed graft fixture parks nothing');
  return found;
}

describe('SessionState.parked — the parked graft reaches the wire', () => {
  it('at least one committed fixture parks, so nothing below is vacuous', async () => {
    const parking = await parkingSubjects();
    expect(parking.length, 'no committed graft fixture parks an agent').toBeGreaterThan(0);
    for (const subject of parking) {
      for (const p of subject.snapshot.parked) {
        expect(p.agentId.length, subject.caseName).toBeGreaterThan(0);
        expect(p.code.length, subject.caseName).toBeGreaterThan(0);
      }
    }
  });

  it('every parking fixture carries its parked list into SessionState verbatim', async () => {
    const { workspacePath } = await fixtures();
    const slug = slugifyWorkspace(workspacePath);
    for (const subject of await parkingSubjects()) {
      const model = makeModel(workspacePath);
      model.ingestGraftResult(subject.sessionId, slug, await graftSession(subject.mainPath));
      const state = model.sessionState(subject.sessionId);

      expect(state?.parked, subject.caseName).toBeDefined();
      expect(state?.parked?.length, subject.caseName).toBe(subject.snapshot.parked.length);
      for (const p of subject.snapshot.parked) {
        const onWire = state?.parked?.find((w) => w.agentId === p.agentId);
        expect(onWire, `${subject.caseName}: ${p.agentId} did not reach the wire`).toBeDefined();
        expect(onWire?.code).toBe(p.code);
        expect(onWire?.reason).toBe(p.reason);
        expect(onWire?.toolUseId).toBe(p.toolUseId);
        expect(onWire?.parentAgentId).toBe(p.parentAgentId);
      }
    }
  });

  it('the parked agent is in no tree and on no edge, so the field is its only channel', async () => {
    const { workspacePath } = await fixtures();
    const slug = slugifyWorkspace(workspacePath);
    for (const subject of await parkingSubjects()) {
      const model = makeModel(workspacePath);
      model.ingestGraftResult(subject.sessionId, slug, await graftSession(subject.mainPath));
      const state = model.sessionState(subject.sessionId) as SessionState;
      const inTree = agentNodes(state.root).map((n) => n.id);
      for (const p of state.parked ?? []) {
        expect(inTree, `${subject.caseName}: ${p.agentId} is in the tree`).not.toContain(
          p.agentId,
        );
        expect(
          (state.spawnEdges ?? []).some((e) => e.agentId === p.agentId),
          `${subject.caseName}: ${p.agentId} has a spawn edge`,
        ).toBe(false);
      }
    }
  });

  it('parked survives a snapshot, then a diff that introduces it, then one that ignores it', async () => {
    const { workspacePath } = await fixtures();
    const slug = slugifyWorkspace(workspacePath);
    const clean = await cleanSubject();
    const parking = (await parkingSubjects())[0] as GraftSubject;
    const sessionId = clean.sessionId;
    const model = makeModel(workspacePath);

    // (1) SNAPSHOT — the only message a fresh webview can be started from. A
    // clean graft: the field is present and empty, not absent.
    model.ingestGraftResult(sessionId, slug, await graftSession(clean.mainPath));
    const first = model.emit();
    expect(first.addedSessionIds).toContain(sessionId);
    let webview = first.sessions.find((s) => s.sessionId === sessionId) as SessionState;
    expect(webview.parked).toStrictEqual([]);

    // (2) DIFF that introduces parked. From here the webview never sees this
    // session's state again, only patches — so a `parked` the patch does not
    // carry is a parked graft that never arrives.
    model.ingestGraftResult(sessionId, slug, await graftSession(parking.mainPath));
    const second = model.emit();
    const introducing = second.diffs.find((d) => d.sessionId === sessionId);
    expect(introducing, 'the parking graft produced no diff at all').toBeDefined();
    if (introducing === undefined) return;
    expect(introducing.patch.parked, 'the patch did not carry parked').toBeDefined();
    webview = applySessionPatch(webview, introducing.patch);
    expect(webview.parked?.length).toBe(parking.snapshot.parked.length);
    expect(webview).toStrictEqual(second.sessions.find((s) => s.sessionId === sessionId));

    // (3) DIFF that says nothing about parked. This is the failure mode the
    // test exists for: a field carried on the snapshot and dropped by the
    // reducer appears once and then silently vanishes. Liveness moves here;
    // the tree and the parked set do not.
    model.ingestHookEvent(
      mainThreadEvents(sessionId, ['PreToolUse'], 1)[0] as NormalizedHookEvent,
    );
    const third = model.emit();
    const quiet = third.diffs.find((d) => d.sessionId === sessionId);
    expect(quiet, 'the hook event produced no diff').toBeDefined();
    if (quiet === undefined) return;
    expect(quiet.patch.parked, 'a patch that changed no parked graft named parked').toBeUndefined();
    expect(quiet.patch.fields?.liveness).toBeDefined();
    webview = applySessionPatch(webview, quiet.patch);
    expect(webview.parked?.length, 'parked vanished across a diff that ignored it').toBe(
      parking.snapshot.parked.length,
    );
    expect(webview).toStrictEqual(third.sessions.find((s) => s.sessionId === sessionId));
  });

  it('a refused session carries an empty parked list, never the agents it had parked', async () => {
    const { workspacePath } = await fixtures();
    const slug = slugifyWorkspace(workspacePath);
    const parking = (await parkingSubjects())[0] as GraftSubject;
    const model = makeModel(workspacePath);

    // Fed through the INCREMENTAL path, not `ingestGraftResult`, so the session's
    // own grafter really holds the parked agent. A refusal that reached back
    // into the grafter would then have something to leak; fed the other way this
    // test could not tell "withheld" from "never computed".
    const replay = await loadReplay(parking.mainPath);
    const sessionId = replay.sessionId;
    for (const sidecar of replay.sidecars) model.ingestSidecar(sessionId, slug, sidecar);
    model.ingestTranscript(sessionId, slug, {
      kind: 'main',
      path: replay.main.path,
      entries: replay.main.entries,
    });
    for (const file of replay.agents) {
      const batch: TranscriptBatch = {
        kind: 'subagent',
        path: file.path,
        entries: file.entries,
      };
      if (file.agentId !== undefined) batch.agentId = file.agentId;
      model.ingestTranscript(sessionId, slug, batch);
    }
    expect(model.sessionState(sessionId)?.parked?.length).toBeGreaterThan(0);

    model.refuseSession(sessionId, slug, {
      kind: 'schemaMismatch',
      reason: 'injected refusal',
    });
    const refused = model.sessionState(sessionId);
    expect(refused?.schemaOk).toBe(false);
    expect(refused?.parked).toStrictEqual([]);
    expect(refused?.root.children).toStrictEqual([]);
    expect(refused?.spawnEdges).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The engine stamp — gate amendment B3
// ---------------------------------------------------------------------------

/**
 * Until Phase 5 the CC engine identified itself by NOT setting a field, and
 * absence was documented as reading `'cc'`. That is unassertable from outside:
 * a state with no tag is indistinguishable from a state whose tag was dropped
 * on the way through the bridge. From here the CC engine names itself, so a
 * cross-engine isolation test can say which sessions must be unaffected.
 *
 * Everything below goes through `SessionModel` — `stateOf` is the production
 * construction site and `toSessionState` in `graft.ts` has no production
 * callers at all — so a stamp added only to a convenience helper would fail
 * here rather than pass.
 */
describe('SessionState.engine — the CC engine stamps its own name', () => {
  it('every state the model hands out is stamped cc, on both output paths', async () => {
    const { sessionIds } = await fixtures();
    const { model } = await replayInterleaved();
    const snapshot = model.snapshot();
    // Guard against a vacuous loop: an empty snapshot would satisfy every
    // assertion below while measuring nothing.
    expect(snapshot.length).toBeGreaterThan(0);
    for (const state of snapshot) expect(state.engine, state.sessionId).toBe('cc');
    for (const sessionId of sessionIds) {
      expect(model.sessionState(sessionId)?.engine, sessionId).toBe('cc');
    }
    for (const state of model.allSessions()) expect(state.engine, state.sessionId).toBe('cc');
  });

  it('the stamp survives a diff and an apply, so the wire never loses it', async () => {
    const { sessionIds } = await fixtures();
    const { reconstructed } = await replayInterleaved();
    for (const sessionId of sessionIds) {
      // `reconstructed` is built by applying every emitted patch in order — the
      // webview's own path — so this is the field surviving the reducer, not
      // just the snapshot.
      expect(reconstructed.get(sessionId)?.engine, sessionId).toBe('cc');
    }
  });

  it('a REFUSED session is stamped too: G3 withholds the tree, not the identity', async () => {
    const { workspacePath, sessionIds, replays } = await fixtures();
    const slug = slugifyWorkspace(workspacePath);
    const model = makeModel(workspacePath);
    const sessionId = sessionIds[0] as string;
    const replay = replays[0] as ReplaySession;
    model.ingestTranscript(sessionId, slug, {
      kind: 'main',
      path: replay.main.path,
      entries: replay.main.entries,
    });
    model.refuseSession(sessionId, slug, {
      kind: 'schemaMismatch',
      reason: 'injected refusal',
    });
    const refused = model.sessionState(sessionId);
    expect(refused?.schemaOk).toBe(false);
    expect(refused?.root.children).toStrictEqual([]);
    expect(refused?.engine).toBe('cc');
  });

  it('no CC-produced tool node carries truncated - the flag belongs to the other engine', async () => {
    // `ToolNode.truncated` is OpenCode's `state.metadata.truncated`. CC's
    // `<persisted-output>` stub is the opposite mechanism: it offloads bytes to
    // `tool-results/` and they are still there to read. This is why the golden
    // serializer does not record the flag — it would be a constant `null` in
    // every file here — and this test is what pins that reasoning instead.
    const { model } = await replayInterleaved();
    let toolNodes = 0;
    for (const state of model.snapshot()) {
      walk(state.root, (node: TreeNode) => {
        if (isAgentNode(node)) return;
        toolNodes += 1;
        expect('truncated' in node, `${state.sessionId}/${node.id}`).toBe(false);
      });
    }
    expect(toolNodes, 'no tool nodes were examined').toBeGreaterThan(0);
  });

  it('the golden serializer records the tag verbatim, never normalised', async () => {
    // `state.engine ?? null`, not `?? 'cc'`. If the stamp were deleted the
    // goldens must go to `null` and fail; normalising would make the committed
    // files identical with and without B3, which is a golden that cannot
    // observe the thing it exists to observe.
    const { sessionIds } = await fixtures();
    const { model } = await replayInterleaved();
    for (const sessionId of sessionIds) {
      const state = model.sessionState(sessionId) as SessionState;
      expect(serializeSessionState(state).engine, sessionId).toBe('cc');
    }
    // A state that was never stamped serialises as `null`, not as `'cc'`.
    const untagged = baseState();
    expect(serializeSessionState(untagged).engine).toBeNull();
  });
});
