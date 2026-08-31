// Generate the WIDE-RANK synthetic wire corpus.
//
// WHY IT EXISTS. The first real swarm session put 15 subagents at depth 1 under
// a root with 173 tool calls, and the renderer failed three ways at once: dot
// rows wider than their nodes overlapped each other, the sibling rank ran off
// the field faster than the zoom floor could compensate, and the root carried
// its session id instead of a label. None of that is reachable from the shapes
// this repository already had on disk — `synthetic-stress` is wide in SESSIONS
// and deep in nodes, and the captured corpora have three children at most — so
// the defect had no fixture and therefore no test.
//
// This corpus is that fixture. It is SYNTHETIC and says so in its id, per
// `canvas-contract.ts:SYNTHETIC_CORPUS_PREFIX`: it states nothing about Claude
// Code's schema, only about what the renderer does with a `SessionState` shape
// that is ours. G6 is unaffected — the parser is still pinned to harvested
// fixtures, and nothing here is read by it.
//
// DETERMINISTIC, and that is load-bearing rather than tidy: `wide-rank.test.ts`
// regenerates it in-process and byte-compares against the committed file, so a
// corpus that drifted from its generator fails instead of quietly becoming the
// thing the goldens describe. Every count below is a literal; nothing is random
// and nothing reads a clock.
//
//   node scripts/make-wide-rank.mjs [--out webview/wire]
//
// Writing is the only side effect and it lands on one committed artifact inside
// the repository, the same way the layout goldens are regenerated. G1 is about
// `~/.claude` and the engines' own directories; this touches neither.

import { resolve } from 'node:path';

import { writeCorpus, WIRE_FORMAT_VERSION } from './record-wire.mjs';

/**
 * The shape, in one place, so the evidence document and the goldens quote a
 * single source.
 *
 * ROOT 180 calls: above the old flat `DOT_LIMIT` of 24 by a wide margin, so the
 * root's row overflows on any rule. CHILDREN 30..240 calls: the low end is
 * still above 24 and the high end is 10x it, so every sibling overflows and
 * they overflow by DIFFERENT amounts — a per-node cap that ignored node width
 * would produce identical rows and hide the defect this corpus exists to show.
 * TWO GRANDCHILDREN, on two different children, so wrapping has to keep a
 * subtree under its own parent across rows.
 */
export const WIDE_RANK = {
  sessionId: 'session-wide-rank',
  rootCalls: 180,
  /** 15 siblings, call counts ascending from 30 to 240 in steps of 15. */
  childCalls: Array.from({ length: 15 }, (_, i) => 30 + i * 15),
  /** `childIndex -> calls`, for the two depth-2 agents. */
  grandchildren: [
    { parent: 2, calls: 12 },
    { parent: 11, calls: 47 },
  ],
};

const tool = (id, index, status) => ({
  id,
  toolName: index % 3 === 0 ? 'Bash' : index % 3 === 1 ? 'Read' : 'Edit',
  status,
  inputPreview: `{"description":"call ${String(index)}"}`,
  resultPreview: status === 'running' ? undefined : `ok ${String(index)}`,
  durationMs: 40 + ((index * 7) % 900),
});

/**
 * Tool calls for one agent: the last one runs, everything before it is done,
 * and every seventh errors. Fixed by index, so the same agent always produces
 * the same row.
 */
function callsFor(prefix, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const last = i === count - 1;
    const status = last ? 'running' : i % 7 === 6 ? 'error' : 'done';
    const call = tool(`${prefix}-t${String(i)}`, i, status);
    if (call.resultPreview === undefined) delete call.resultPreview;
    out.push(call);
  }
  return out;
}

const agent = (id, kind, label, spawnDepth, children, burn) => ({
  id,
  kind,
  label,
  status: 'running',
  spawnDepth,
  children,
  contextNow: { prompt: burn.prompt, output: burn.output },
  burn,
  startedAt: 1_700_000_000_000,
});

/** The session, built the same way every time. */
export function wideRankSession() {
  const children = WIDE_RANK.childCalls.map((count, i) => {
    const kids = WIDE_RANK.grandchildren
      .filter((g) => g.parent === i)
      .map((g, j) =>
        agent(
          `wide-${String(i)}-g${String(j)}`,
          'subagent',
          `deep worker ${String(i)}.${String(j)}`,
          2,
          callsFor(`wide-${String(i)}-g${String(j)}`, g.calls),
          { prompt: 4_000 + g.calls * 90, output: 700 + g.calls * 11 },
        ),
      );
    return agent(
      `wide-${String(i)}`,
      'subagent',
      `phase-implementer ${String(i)}`,
      1,
      [...callsFor(`wide-${String(i)}`, count), ...kids],
      { prompt: 20_000 + count * 310, output: 3_000 + count * 42 },
    );
  });

  const root = agent(
    'root',
    'main',
    'wide rank reproduction, sixteen agents',
    0,
    callsFor('root', WIDE_RANK.rootCalls),
    { prompt: 812_000, output: 61_500 },
  );
  root.children = [...root.children, ...children];

  /** The spawn join, by primary key, exactly as the grafter states it. */
  const spawnEdges = [];
  children.forEach((child, i) => {
    spawnEdges.push({
      toolUseId: `root-t${String(i * 11)}`,
      agentId: child.id,
      parentNodeId: 'root',
      depth: 1,
      recordedDepth: 1,
    });
    for (const kid of child.children) {
      if (!('children' in kid)) continue;
      spawnEdges.push({
        toolUseId: `${child.id}-t3`,
        agentId: kid.id,
        parentNodeId: child.id,
        depth: 2,
        recordedDepth: 2,
      });
    }
  });

  return {
    sessionId: WIDE_RANK.sessionId,
    projectSlug: 'synthetic-wide-rank-slug',
    root,
    spawnEdges,
    parked: [],
    liveness: 'live',
    schemaOk: true,
    lastEventAt: 1_700_000_600_000,
    cost: 4.13,
    engine: 'cc',
    contextNow: { prompt: 812_000, output: 61_500 },
    burn: { prompt: 812_000, output: 61_500 },
  };
}

/**
 * The arc. One snapshot and nothing else, deliberately: this corpus is a
 * STATIC SHAPE for the layout to be measured against, not a timeline. The
 * timing questions belong to `synthetic-stress` and the timed corpus, which
 * already own them; adding invented diffs here would put a second, weaker
 * answer to those questions in the repository.
 */
export function wideRankCorpus() {
  const session = wideRankSession();
  return {
    formatVersion: WIRE_FORMAT_VERSION,
    id: 'synthetic-wide-rank',
    kind: 'synthetic',
    title: 'Wide rank — 15 siblings at depth 1',
    description:
      'One root with 180 tool calls, 15 subagents at depth 1 carrying 30 to 240 calls each, ' +
      'and 2 grandchildren. The shape the first real swarm session produced, which no ' +
      'corpus in this repository held: dot rows wider than their nodes, a sibling rank wider ' +
      'than any field, and a root whose label had to come from somewhere.',
    producedBy: 'scripts/make-wide-rank.mjs',
    engine: 'cc',
    durationMs: 0,
    steps: [
      {
        atMs: 0,
        label: 'snapshot',
        what: 'the whole session at once: 1 root, 15 children, 2 grandchildren',
      },
    ],
    events: [
      {
        atMs: 0,
        label: 'snapshot',
        message: { type: 'snapshot', sessions: [session] },
      },
    ],
    final: {
      sessions: [session],
      degraded: { degraded: false },
      schemaMismatchSessionIds: [],
    },
  };
}

const isEntry = process.argv[1] !== undefined && process.argv[1].endsWith('make-wide-rank.mjs');
if (isEntry) {
  const at = process.argv.indexOf('--out');
  const outDir = at === -1 ? 'webview/wire' : (process.argv[at + 1] ?? 'webview/wire');
  const name = await writeCorpus(resolve(outDir), wideRankCorpus());
  process.stdout.write(`wrote ${name}\n`);
}
