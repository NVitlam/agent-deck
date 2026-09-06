/**
 * Agent Deck — stall detection (v0.7.0 Phase 0c).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 * ---------------------------------------------------------------------------
 * The user observed, live on 2026-09-05, a tool that ran for a quarter of an
 * hour without completing. The session card read `idle` — correct, per the
 * liveness matrix. The agent view read `running` — wrong, in the only sense
 * that matters to a user: nothing had arrived for fourteen minutes and the
 * deck had no way to say so.
 *
 * The corpus is that session, harvested in DoD 0c.1:
 * `fixtures/cc-2.1.260/projects/…/99f96635-…`. It is real captured data, and
 * it carries the defect at TWO levels — see below.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIRST BLOCK ASSERTS THE DEFECT
 * ---------------------------------------------------------------------------
 * DoD 0c.2 requires the reproduction to be recorded BEFORE the fix, so the
 * `describe('the defect …')` block below asserts CURRENT behaviour and passes
 * on unfixed code. That is deliberate. `docs/evidence/phase-0c/ROOTCAUSE.md`
 * is its written form.
 *
 * The root cause is one expression, `src/model/graft.ts`:
 *
 *     status: call.isError ? 'error'
 *           : call.resultPreview === undefined ? 'running' : 'done'
 *
 * `ToolNode.status` is a pure function of WHETHER A RESULT EXISTS. There is no
 * clock in it, no threshold and no notion of activity — so a tool that never
 * completes is `running` for ever BY CONSTRUCTION, and no passage of time can
 * change the answer. That is why the faked clock below is not incidental
 * decoration: it is the whole point. Advancing it by the liveness threshold
 * plus a day changes nothing, which is what "there is no stalled state" means
 * concretely.
 *
 * ---------------------------------------------------------------------------
 * THE NESTING, WHICH IS THE PART A ONE-LEVEL FIX GETS WRONG
 * ---------------------------------------------------------------------------
 * Two calls in this session never received a `tool_result`:
 *
 *   outer  Agent  toolu_01NTu6y7z1wxWDtCDxMCQge4  ordinal 161/191
 *   inner  Bash   toolu_018fuffcyA46w1xfU6Wpcj5z  ordinal  38/38
 *
 * The inner one is the last entry its subagent ever wrote; the subagent's
 * `meta.toolUseId` names the outer one exactly. A stalled child implies a
 * stalled parent spawn — the parent cannot complete until the child does — so
 * a derivation that flags the child alone still leaves a `running` agent on
 * the deck for ever, which is the reported defect wearing a smaller hat.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AgentNode, ToolNode, TreeNode } from './events.js';
import { isAgentNode } from './events.js';
import { TreeGrafter, walk } from './graft.js';
import { stallOf, stalledForMs, stalledCount } from './stall.js';
import { LivenessEngine } from './liveness.js';
import { SessionModel } from './session.js';
import { normalizeHookEvent } from '../hooks/listener.js';
import { parseLines, parseSubagentMeta } from '../parser/parse.js';

const CORPUS = fileURLToPath(
  new URL(
    '../../fixtures/cc-2.1.260/projects/c--Users-dev-projects-agent-deck',
    import.meta.url,
  ),
);
const SESSION_ID = '99f96635-2042-41dc-9000-bbc9f9233bc3';
const PROJECT_SLUG = 'c--Users-dev-projects-agent-deck';

/** The three sidecars, all `phase-verifier`. The middle one holds the stall. */
const AGENT_IDS = [
  'a0ed8c3aae39da276',
  'a7d51ba7a0fe16c4b',
  'a982bfcc574017a33',
] as const;

/** The never-completing `Agent` spawn in the main transcript. */
const OUTER_TOOL_ID = 'toolu_01NTu6y7z1wxWDtCDxMCQge4';
/** The never-completing `Bash` call inside `agent-a7d51ba7a0fe16c4b`. */
const INNER_TOOL_ID = 'toolu_018fuffcyA46w1xfU6Wpcj5z';
/** The subagent that issued the inner call and then wrote nothing more. */
const STALLED_AGENT_ID = 'a7d51ba7a0fe16c4b';

/** Wall-clock facts, measured from the corpus in DoD 0c.1 — not recollection. */
const OUTER_START_MS = Date.parse('2026-09-05T09:36:28.071Z');
const INNER_START_MS = Date.parse('2026-09-05T09:40:27.418Z');
/** The user's nudge: the message `did you get stuck?`. */
const NUDGE_MS = Date.parse('2026-09-05T09:54:40.711Z');

/** `agentDeck.livenessThresholdMs` — the existing liveness value. No new constant. */
const THRESHOLD_MS = 120_000;

/**
 * The session's last observed activity. The subagent's final write IS the
 * session's final activity: nothing — no hook, no transcript append — arrived
 * after it until the user intervened. Under the liveness engine's own rule
 * (`recent` is the LATER of the last hook event and the transcript mtime) this
 * is the value `lastActivityAt` would carry.
 */
const LAST_ACTIVITY_MS = INNER_START_MS;

async function graftCorpus(): Promise<TreeGrafter> {
  const grafter = new TreeGrafter({ sessionId: SESSION_ID, projectSlug: PROJECT_SLUG });

  const mainPath = `${CORPUS}/${SESSION_ID}.jsonl`;
  const mainText = await readFile(mainPath, 'utf8');
  const main = parseLines(mainText.split('\n').filter((l) => l.length > 0));
  if (!main.ok) throw new Error('main transcript did not parse');
  grafter.addTranscript({ kind: 'main', path: mainPath, entries: main.value.entries });

  for (const agentId of AGENT_IDS) {
    const dir = `${CORPUS}/${SESSION_ID}/subagents`;
    const jsonlPath = `${dir}/agent-${agentId}.jsonl`;
    const metaPath = `${dir}/agent-${agentId}.meta.json`;

    const text = await readFile(jsonlPath, 'utf8');
    const parsed = parseLines(text.split('\n').filter((l) => l.length > 0));
    if (!parsed.ok) throw new Error(`subagent ${agentId} did not parse`);
    grafter.addTranscript({
      kind: 'subagent',
      path: jsonlPath,
      agentId,
      entries: parsed.value.entries,
    });

    const metaText = await readFile(metaPath, 'utf8');
    const meta = parseSubagentMeta(metaText, metaPath);
    grafter.addSidecar({
      agentId,
      metaPath,
      ...(meta.ok ? { meta: meta.value } : { metaFailure: 'unparsed' }),
    });
  }

  return grafter;
}

function toolsOf(root: AgentNode): Map<string, ToolNode> {
  const out = new Map<string, ToolNode>();
  walk(root, (node: TreeNode) => {
    if (!isAgentNode(node)) out.set(node.id, node);
  });
  return out;
}

describe('the corpus carries the reported stall, at both levels', () => {
  it('grafts the harvested session with every sidecar joined', async () => {
    const snapshot = (await graftCorpus()).snapshot();

    // Vacuity control: if the corpus stopped grafting, every assertion below
    // would pass over an empty tree. Pin the population first.
    expect(snapshot.parked).toHaveLength(0);
    const agents = [];
    walk(snapshot.root, (node) => {
      if (isAgentNode(node)) agents.push(node.id);
    });
    expect(agents.length).toBeGreaterThan(1);

    const tools = toolsOf(snapshot.root);
    expect(tools.size).toBeGreaterThan(100);
    expect(tools.has(OUTER_TOOL_ID)).toBe(true);
    expect(tools.has(INNER_TOOL_ID)).toBe(true);
  });

  it('the inner call is the last thing its subagent ever wrote', async () => {
    const dir = `${CORPUS}/${SESSION_ID}/subagents`;
    const text = await readFile(`${dir}/agent-${STALLED_AGENT_ID}.jsonl`, 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines[lines.length - 1]).toContain(INNER_TOOL_ID);
  });

  it('the stalled subagent`s sidecar names the outer call — the nesting join', async () => {
    const dir = `${CORPUS}/${SESSION_ID}/subagents`;
    const metaText = await readFile(`${dir}/agent-${STALLED_AGENT_ID}.meta.json`, 'utf8');
    const meta = parseSubagentMeta(metaText, 'meta');
    expect(meta.ok).toBe(true);
    if (meta.ok) expect(meta.value.toolUseId).toBe(OUTER_TOOL_ID);
  });
});

describe('the defect, reproduced on current code (DoD 0c.2 — RED)', () => {
  /**
   * The faked clock. Every case below picks a `now` and the answer never
   * moves, because nothing downstream of the graft reads a clock at all.
   */
  const CLOCKS: readonly { label: string; now: number }[] = [
    { label: 'at the inner call`s start', now: INNER_START_MS },
    { label: 'at start + threshold + 1', now: INNER_START_MS + THRESHOLD_MS + 1 },
    { label: 'at the moment the user gave up and nudged', now: NUDGE_MS },
    { label: 'a full day later', now: INNER_START_MS + 86_400_000 },
  ];

  it('both never-completing calls are `running`, at every clock value', async () => {
    const snapshot = (await graftCorpus()).snapshot();
    const tools = toolsOf(snapshot.root);

    const outer = tools.get(OUTER_TOOL_ID);
    const inner = tools.get(INNER_TOOL_ID);
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();

    for (const { now } of CLOCKS) {
      // There is nowhere to PUT `now`. That is the defect, stated as code:
      // the graft takes no clock, so the status is already fixed before any
      // question about time can be asked.
      expect(now).toBeGreaterThanOrEqual(INNER_START_MS);
      expect(outer?.status).toBe('running');
      expect(inner?.status).toBe('running');
    }
  });

  it('the elapsed time is far past the threshold, and nothing reflects it', () => {
    // The measurements from the corpus README, asserted rather than recited.
    expect(NUDGE_MS - OUTER_START_MS).toBe(1_092_640);
    expect(NUDGE_MS - INNER_START_MS).toBe(853_293);
    expect(NUDGE_MS - LAST_ACTIVITY_MS).toBeGreaterThan(THRESHOLD_MS * 7);
  });

  it('no `stalled` state exists anywhere in the model', async () => {
    const snapshot = (await graftCorpus()).snapshot();
    const statuses = new Set<string>();
    walk(snapshot.root, (node: TreeNode) => {
      if (!isAgentNode(node)) statuses.add(node.status);
    });
    // The whole vocabulary the product can express today.
    expect([...statuses].sort()).toEqual(['done', 'error', 'running']);
    expect(statuses.has('stalled')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DoD 0c.3 — the pure function, at its boundary
// ---------------------------------------------------------------------------

describe('stallOf — the pure derivation', () => {
  const RUNNING = { status: 'running' } as const;

  it('is NOT stalled at exactly the threshold, and IS one millisecond past it', () => {
    // The comparison is strictly greater than, which keeps this boundary
    // identical to the liveness engine's own `recent` test rather than off by
    // one from it. Both arms, because only the pair pins the direction.
    expect(stallOf(RUNNING, 1_000, THRESHOLD_MS, 1_000 + THRESHOLD_MS).stalled).toBe(false);
    expect(stallOf(RUNNING, 1_000, THRESHOLD_MS, 1_000 + THRESHOLD_MS + 1).stalled).toBe(true);
  });

  it('reports the instant the threshold was crossed, not the instant asked', () => {
    const a = stallOf(RUNNING, 1_000, THRESHOLD_MS, 1_000 + THRESHOLD_MS + 1);
    const b = stallOf(RUNNING, 1_000, THRESHOLD_MS, 1_000 + THRESHOLD_MS + 9_999_999);
    expect(a.stalledSinceMs).toBe(1_000 + THRESHOLD_MS);
    // Two derivations of ONE underlying state agree, however far apart they
    // are asked. If this used `now`, the elapsed time on screen would jump
    // with the poll cadence.
    expect(b.stalledSinceMs).toBe(a.stalledSinceMs);
  });

  it('only a running tool can stall', () => {
    for (const status of ['done', 'error'] as const) {
      expect(stallOf({ status }, 1_000, THRESHOLD_MS, 1e12).stalled).toBe(false);
    }
    expect(stallOf(RUNNING, 1_000, THRESHOLD_MS, 1e12).stalled).toBe(true);
  });

  it('every unusable input returns false, never a stall (G3, safe direction)', () => {
    const far = 1_000 + THRESHOLD_MS + 1;
    // Each case is paired against the same inputs made VALID, so a case that
    // stopped exercising its own guard would show up as both arms agreeing.
    expect(stallOf(RUNNING, null, THRESHOLD_MS, far).stalled).toBe(false);
    expect(stallOf(RUNNING, undefined, THRESHOLD_MS, far).stalled).toBe(false);
    expect(stallOf(RUNNING, Number.NaN, THRESHOLD_MS, far).stalled).toBe(false);
    expect(stallOf(RUNNING, 1_000, Number.NaN, far).stalled).toBe(false);
    expect(stallOf(RUNNING, 1_000, THRESHOLD_MS, Number.NaN).stalled).toBe(false);
    expect(stallOf(RUNNING, 1_000, Number.POSITIVE_INFINITY, far).stalled).toBe(false);
    expect(stallOf(RUNNING, 1_000, 0, far).stalled).toBe(false);
    expect(stallOf(RUNNING, 1_000, -1, far).stalled).toBe(false);
    // A clock behind the last activity is a clock problem, not a stall.
    expect(stallOf(RUNNING, 1_000, THRESHOLD_MS, 999).stalled).toBe(false);
    expect(stallOf(RUNNING, 1_000, THRESHOLD_MS, far).stalled).toBe(true);
  });

  it('stalledForMs is null unless stalled, and counts from the crossing', () => {
    expect(stalledForMs({ stalled: false }, 1e12)).toBeNull();
    const v = stallOf(RUNNING, 1_000, THRESHOLD_MS, 1_000 + THRESHOLD_MS + 1);
    expect(stalledForMs(v, 1_000 + THRESHOLD_MS + 5_000)).toBe(5_000);
  });
});

describe('the import guard (DoD 0c.3)', () => {
  it('stall.ts imports from events.js and nothing else', async () => {
    const src = await readFile(
      fileURLToPath(new URL('./stall.ts', import.meta.url)),
      'utf8',
    );
    const specifiers = [...src.matchAll(/^import[^;]*?from\s+'([^']+)'/gmu)].map(
      (m) => m[1],
    );
    // Vacuity control: if the regex stopped matching, an empty list would
    // satisfy "every specifier is events.js" forever.
    expect(specifiers.length).toBeGreaterThan(0);
    expect([...new Set(specifiers)]).toEqual(['./events.js']);
    // A pure function that reaches for a clock or the filesystem is not pure.
    //
    // SCANNED WITH COMMENTS STRIPPED, and the first draft of this test is why:
    // it matched `Date.now()` inside stall.ts's OWN PROSE — a comment
    // explaining that an mtime need not agree with `Date.now()` — and reported
    // a purity violation in a file that calls nothing. A guard that reads
    // documentation as if it were code is this repository's recorded
    // "the corpus contains the instructions that produced it" trap, one layer
    // in. Anchor to code.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '');
    // Vacuity control: stripping must not have eaten the file.
    expect(code).toMatch(/export function stallOf/u);
    expect(code).not.toMatch(/Date\.now\(\)/u);
    expect(code).not.toMatch(/require\(|readFileSync/u);
    // No `node:` check here, and its absence is deliberate: a naive
    // /node:/ matched the PARAMETER `node: TreeNode`. The specifier
    // assertion above already forbids every builtin by enumeration, which is
    // the exact property rather than a proxy for it.
  });
});

// ---------------------------------------------------------------------------
// DoD 0c.4 / 0c.5 — GREEN, through the production assembly path
// ---------------------------------------------------------------------------

/**
 * Everything below drives `SessionModel` — the real assembly point — rather
 * than calling `applyStalls` on a hand-built tree.
 *
 * That is not fussiness. This repository's most expensive recorded defect
 * class is a component test standing in for a wiring that does not exist: a
 * prop honoured by a component that nothing ever passes, green across eighteen
 * files while the feature was absent from the product. `stallOf` being correct
 * says nothing about whether a stall ever reaches a `SessionState`. Only a
 * test that lets production build the state can say that, and the mutation
 * that proves these are not vacuous is deleting the `applyStallsToRoot` call
 * in `stateOf` — which turns this block red and leaves every case above green.
 */

/** A clock the test moves by hand; the model reads it through the engine. */
let NOW = 0;

async function modelWithCorpus(): Promise<SessionModel> {
  const liveness = new LivenessEngine({ now: () => NOW });
  const model = new SessionModel({
    workspacePath: 'C:\\Users\\dev\\projects\\agent-deck',
    liveness,
  });
  model.registerSession({ sessionId: SESSION_ID, projectSlug: PROJECT_SLUG });

  const mainPath = `${CORPUS}/${SESSION_ID}.jsonl`;
  const mainText = await readFile(mainPath, 'utf8');
  const main = parseLines(mainText.split('\n').filter((l) => l.length > 0));
  if (!main.ok) throw new Error('main transcript did not parse');
  model.ingestTranscript(SESSION_ID, PROJECT_SLUG, {
    kind: 'main',
    path: mainPath,
    entries: main.value.entries,
  });

  for (const agentId of AGENT_IDS) {
    const dir = `${CORPUS}/${SESSION_ID}/subagents`;
    const jsonlPath = `${dir}/agent-${agentId}.jsonl`;
    const metaPath = `${dir}/agent-${agentId}.meta.json`;
    const text = await readFile(jsonlPath, 'utf8');
    const parsed = parseLines(text.split('\n').filter((l) => l.length > 0));
    if (!parsed.ok) throw new Error(`subagent ${agentId} did not parse`);
    model.ingestTranscript(SESSION_ID, PROJECT_SLUG, {
      kind: 'subagent',
      path: jsonlPath,
      agentId,
      entries: parsed.value.entries,
    });
    const meta = parseSubagentMeta(await readFile(metaPath, 'utf8'), metaPath);
    model.ingestSidecar(SESSION_ID, PROJECT_SLUG, {
      agentId,
      metaPath,
      ...(meta.ok ? { meta: meta.value } : { metaFailure: 'unparsed' }),
    });
  }

  // The session's last observed activity. This is the ONLY input that decides
  // a stall, and it arrives the way production supplies it: a hook event,
  // normalized by the listener's own function.
  model.ingestHookEvent(
    normalizeHookEvent(
      {
        session_id: SESSION_ID,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: INNER_TOOL_ID,
      },
      { seq: 1, receivedAt: LAST_ACTIVITY_MS },
    ),
  );

  return model;
}

function agentsOf(root: AgentNode): AgentNode[] {
  const out: AgentNode[] = [];
  walk(root, (node: TreeNode) => {
    if (isAgentNode(node)) out.push(node);
  });
  return out;
}

function toolsAt(model: SessionModel, now: number): Map<string, ToolNode> {
  NOW = now;
  const state = model.sessionState(SESSION_ID);
  if (state === undefined) throw new Error('no state for the harvested session');
  return toolsOf(state.root);
}

describe('the fix, through SessionModel (DoD 0c.4 — GREEN)', () => {
  it('promotes BOTH never-completing calls at the threshold, and neither before it', async () => {
    const model = await modelWithCorpus();

    // Vacuity control first: the state must actually carry the tree, or every
    // assertion below is satisfied by an empty map.
    expect(toolsAt(model, LAST_ACTIVITY_MS).size).toBeGreaterThan(100);

    // At exactly the threshold — not stalled. The boundary holds end to end,
    // not only inside the pure function.
    const atEdge = toolsAt(model, LAST_ACTIVITY_MS + THRESHOLD_MS);
    expect(atEdge.get(OUTER_TOOL_ID)?.status).toBe('running');
    expect(atEdge.get(INNER_TOOL_ID)?.status).toBe('running');

    // One millisecond past it — BOTH levels. That is the nesting, and it is
    // not special-cased: `lastActivityAt` is a property of the SESSION, so the
    // hung child and the parent spawn waiting on it promote in one pass.
    const past = toolsAt(model, LAST_ACTIVITY_MS + THRESHOLD_MS + 1);
    expect(past.get(INNER_TOOL_ID)?.status).toBe('stalled');
    expect(past.get(OUTER_TOOL_ID)?.status).toBe('stalled');
    expect(past.get(INNER_TOOL_ID)?.stalledSinceMs).toBe(LAST_ACTIVITY_MS + THRESHOLD_MS);
    expect(past.get(OUTER_TOOL_ID)?.stalledSinceMs).toBe(LAST_ACTIVITY_MS + THRESHOLD_MS);
  });

  it('leaves every COMPLETED call alone, including the 47-minute one', async () => {
    const model = await modelWithCorpus();
    const tools = toolsAt(model, NUDGE_MS);

    // The control that makes the whole design defensible: ordinal 160 ran
    // 2,846.6 s — far LONGER than the stall — and RECEIVED A RESULT. A rule
    // keyed on duration would flag it. This one must not.
    //
    // Its result is an `error`, not a success, and that is measured rather
    // than assumed — the first draft of this test asserted `'done'` and the
    // corpus refused it. The distinction does not weaken the control, it
    // sharpens it: what matters is that the call reached an OUTCOME, and both
    // outcome values must be immune to promotion. A tool that failed after 47
    // minutes is finished, not silent.
    expect(tools.get('toolu_01TXCoxHQY62PHyVKwFC7XJo')?.status).toBe('error');

    // And nothing that already has an outcome is ever promoted.
    let promotedWithOutcome = 0;
    for (const t of tools.values()) {
      if (t.status === 'stalled' && t.resultPreview !== undefined) promotedWithOutcome += 1;
    }
    expect(promotedWithOutcome).toBe(0);
  });

  it('stalls EXACTLY the two calls the corpus says never completed', async () => {
    const model = await modelWithCorpus();
    const stalled = [...toolsAt(model, NUDGE_MS).values()]
      .filter((t) => t.status === 'stalled')
      .map((t) => t.id)
      .sort();
    // An exact set, not a containment — rule 19's shape. A containment would
    // pass just as happily if the derivation painted the entire tree amber.
    expect(stalled).toEqual([OUTER_TOOL_ID, INNER_TOOL_ID].sort());
  });

  it('clears on activity: a later hook event returns both to `running` (DoD 0c.5)', async () => {
    const model = await modelWithCorpus();
    expect(toolsAt(model, NUDGE_MS).get(INNER_TOOL_ID)?.status).toBe('stalled');

    // The resume. No reset path is called and none exists: the derivation
    // reads `lastActivityAt`, so moving it IS the clearing.
    model.ingestHookEvent(
      normalizeHookEvent(
        { session_id: SESSION_ID, hook_event_name: 'PostToolUse', tool_name: 'Bash' },
        { seq: 2, receivedAt: NUDGE_MS },
      ),
    );

    const after = toolsAt(model, NUDGE_MS + 1);
    expect(after.get(INNER_TOOL_ID)?.status).toBe('running');
    expect(after.get(OUTER_TOOL_ID)?.status).toBe('running');
    expect(after.get(INNER_TOOL_ID)?.stalledSinceMs).toBeUndefined();

    // And it stalls again once the NEW silence passes the threshold, so
    // "cleared" is not quietly "disabled for the rest of the session".
    expect(toolsAt(model, NUDGE_MS + THRESHOLD_MS + 1).get(INNER_TOOL_ID)?.status)
      .toBe('stalled');
  });

  it('the agent badge counts stalled descendants', async () => {
    const model = await modelWithCorpus();
    NOW = NUDGE_MS;
    const state = model.sessionState(SESSION_ID);
    if (state === undefined) throw new Error('no state');

    expect(stalledCount(state.root)).toBe(2);

    const stalledAgent = agentsOf(state.root).find((a) => a.id === STALLED_AGENT_ID);
    expect(stalledAgent).toBeDefined();
    // The subagent holding the hung Bash carries exactly one of the two; the
    // other belongs to the main thread, which is what the nesting means.
    if (stalledAgent !== undefined) expect(stalledCount(stalledAgent)).toBe(1);
  });

  it('leaves the session liveness matrix untouched (G2, locked)', async () => {
    const model = await modelWithCorpus();
    NOW = NUDGE_MS;
    // running x stale => idle. A stalled tool must NOT make the session
    // `live`: that is precisely the phase's struck first draft, which would
    // have forced `live` on the hung case and turned the one correct surface
    // into a second wrong one.
    expect(model.sessionState(SESSION_ID)?.liveness).toBe('idle');
  });

  it('allocates nothing when nothing is stalled: the root is the SAME object', async () => {
    const model = await modelWithCorpus();
    NOW = LAST_ACTIVITY_MS;
    const a = model.sessionState(SESSION_ID);
    NOW = LAST_ACTIVITY_MS + 1;
    const b = model.sessionState(SESSION_ID);
    // Structural sharing: with no stall the differ sees the identical object
    // graph, so "a spawn adds, it never reflows" survives the assembly layer.
    expect(a?.root).toBe(b?.root);
  });
});

// ---------------------------------------------------------------------------
// DoD 0c.5 — the two synthetic fixtures
// ---------------------------------------------------------------------------

/**
 * `fixtures/synthetic-liveness/` isolates the two ends of a stall's life,
 * neither of which the harvested corpus holds as a clean pair: it contains a
 * stall that never resolved, and no tool that stalled and then RECOVERED.
 *
 * Both are generated by `scripts/make-stall-fixtures.mjs`, which declares the
 * offsets once so the corpus and these assertions quote the same numbers
 * rather than two hand-typed sets that can drift apart.
 */
const SYNTH = fileURLToPath(new URL('../../fixtures/synthetic-liveness', import.meta.url));
const SYNTH_SLUG = 'SYNTHETIC-hand-mutated-not-captured';
const SYNTH_TOOL = 'toolu_SYNTHETICSTALL000000001';
const SYNTH_T0 = Date.parse('2026-09-05T00:00:00.000Z');
const SYNTH_LAST_ACTIVITY = SYNTH_T0 + 1_000;
const SYNTH_RESUME = SYNTH_T0 + 1_000 + THRESHOLD_MS + 300_000;

async function synthModel(
  caseName: string,
  sessionId: string,
  opts: { throughLine?: number } = {},
): Promise<SessionModel> {
  const liveness = new LivenessEngine({ now: () => NOW });
  const model = new SessionModel({ workspacePath: 'C:\\SYNTHETIC', liveness });
  model.registerSession({ sessionId, projectSlug: SYNTH_SLUG });

  const path = `${SYNTH}/${caseName}/${SYNTH_SLUG}/${sessionId}.jsonl`;
  let lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.length > 0);
  if (opts.throughLine !== undefined) lines = lines.slice(0, opts.throughLine);

  const parsed = parseLines(lines);
  if (!parsed.ok) throw new Error(`${caseName} did not parse`);
  model.ingestTranscript(sessionId, SYNTH_SLUG, {
    kind: 'main',
    path,
    entries: parsed.value.entries,
  });

  model.ingestHookEvent(
    normalizeHookEvent(
      { session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Bash' },
      { seq: 1, receivedAt: SYNTH_LAST_ACTIVITY },
    ),
  );
  return model;
}

function statusOf(model: SessionModel, sessionId: string, now: number): string | undefined {
  NOW = now;
  const state = model.sessionState(sessionId);
  if (state === undefined) return undefined;
  return toolsOf(state.root).get(SYNTH_TOOL)?.status;
}

describe('synthetic-liveness (DoD 0c.5)', () => {
  const RESUME_ID = 'deadbeef-0000-4000-8000-00000000c001';
  const ENDED_ID = 'deadbeef-0000-4000-8000-00000000c002';

  it('stall-then-resume: running -> stalled -> done, with no reset path', async () => {
    // Replay the head only: the tool has been issued and no result exists yet.
    const before = await synthModel('stall-then-resume', RESUME_ID, { throughLine: 2 });
    expect(statusOf(before, RESUME_ID, SYNTH_LAST_ACTIVITY)).toBe('running');
    expect(statusOf(before, RESUME_ID, SYNTH_LAST_ACTIVITY + THRESHOLD_MS)).toBe('running');
    expect(statusOf(before, RESUME_ID, SYNTH_LAST_ACTIVITY + THRESHOLD_MS + 1)).toBe('stalled');

    // Now replay the WHOLE file, result included. The result is content, so it
    // reaches the tool through the grafter; nothing calls a reset.
    const after = await synthModel('stall-then-resume', RESUME_ID);
    expect(statusOf(after, RESUME_ID, SYNTH_RESUME + 1)).toBe('done');
    // And it stays `done` however long the session is then silent for — an
    // outcome is permanent, and only a RUNNING tool can stall.
    expect(statusOf(after, RESUME_ID, SYNTH_RESUME + THRESHOLD_MS * 100)).toBe('done');
  });

  it('stall-until-ended: silence is not an outcome, so it stays stalled', async () => {
    const model = await synthModel('stall-until-ended', ENDED_ID);
    expect(statusOf(model, ENDED_ID, SYNTH_LAST_ACTIVITY)).toBe('running');
    expect(statusOf(model, ENDED_ID, SYNTH_LAST_ACTIVITY + THRESHOLD_MS)).toBe('running');
    expect(statusOf(model, ENDED_ID, SYNTH_LAST_ACTIVITY + THRESHOLD_MS + 1)).toBe('stalled');
    // A day later it is still stalled, NOT quietly promoted to done or error.
    // Resolving a tool because the session went quiet would be exactly the
    // guess G3 forbids: we do not know how it ended, or whether it did.
    expect(statusOf(model, ENDED_ID, SYNTH_LAST_ACTIVITY + 86_400_000)).toBe('stalled');
  });

  it('the two fixtures differ ONLY in whether the result arrives', async () => {
    // The control that makes the pair a pair. If they differed in some other
    // way, the contrast above would not isolate what it claims to.
    const a = (
      await readFile(`${SYNTH}/stall-then-resume/${SYNTH_SLUG}/${RESUME_ID}.jsonl`, 'utf8')
    )
      .split('\n')
      .filter((l) => l.length > 0);
    const b = (
      await readFile(`${SYNTH}/stall-until-ended/${SYNTH_SLUG}/${ENDED_ID}.jsonl`, 'utf8')
    )
      .split('\n')
      .filter((l) => l.length > 0);

    expect(a).toHaveLength(3);
    expect(b).toHaveLength(2);
    // The shared prefix is identical once the session id (the only field that
    // must differ, so the two can be registered in one model) is normalised.
    const norm = (s: string): string => s.split(RESUME_ID).join('ID').split(ENDED_ID).join('ID');
    expect(a.slice(0, 2).map(norm)).toEqual(b.map(norm));
    // And the extra line is the result, for the tool under test.
    expect(a[2]).toContain('tool_result');
    expect(a[2]).toContain(SYNTH_TOOL);
  });

  it('both fixtures declare themselves synthetic (G6)', async () => {
    for (const [c, id] of [
      ['stall-then-resume', RESUME_ID],
      ['stall-until-ended', ENDED_ID],
    ] as const) {
      const text = await readFile(`${SYNTH}/${c}/${SYNTH_SLUG}/${id}.jsonl`, 'utf8');
      expect(text).toContain('SYNTHETIC FIXTURE');
      expect(text).toContain('C:\\\\SYNTHETIC');
    }
  });
});
