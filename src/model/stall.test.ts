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
