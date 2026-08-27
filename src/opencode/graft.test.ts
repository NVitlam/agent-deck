/**
 * `src/opencode/graft.ts` — DoD 4.4.
 *
 * Two halves, and the split is deliberate:
 *
 *   1. **Reproduction.** Both committed corpora are read out of their
 *      `opencode.db` with `node:sqlite` read-only, turned into raw rows and
 *      tool records HERE, handed to `graftCorpus`, serialized into the
 *      goldens' canonical form and compared to `golden.json` byte for byte.
 *      Corpora are derived from disk (`listCorpora`), never hard-coded, and
 *      every expected count is read out of that corpus's own `counts` block.
 *
 *   2. **The branches no fixture reaches.** `fixtures/opencode-1.18.22/
 *      GOLDEN.md` "Measured gaps" enumerates ten; `PLAN.md` Phase 4
 *      `Amendment 2026-08-27` A3 makes covering them mandatory. The six that
 *      belong to the grafter are built from hand-written rows below —
 *      `graftCorpus` takes plain arrays, so none of them needs a database.
 *
 * `scripts/opencode-golden.mjs` is NOT imported, by this file or by the module
 * under test. The generator and the engine agree only because they were
 * written from the same contract; if they shared code the goldens would prove
 * nothing. The preview/redaction helpers below are therefore a second
 * implementation, living in the test rather than in the engine — building the
 * INPUT to the grafter is not the thing under test here, `parse.ts` owns it.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, ToolNode, TreeNode } from '../model/events.js';
import { isAgentNode } from '../model/events.js';
import {
  OC_PARK_REASONS,
  agentLabel,
  compareToolRecords,
  defaultProjectSlug,
  defaultSessionLiveness,
  defaultWorkspaceMatch,
  graftCorpus,
  toToolNode,
} from './graft.js';
import { slugFromWorktree } from './slug.js';
import { corpusDbPath, corpusGoldenPath, listCorpora } from './synthetic.js';
import type {
  OcParseCounts,
  OcParseResult,
  OcProjectRow,
  OcSessionRow,
  OcToolRecord,
} from './types.js';

// ---------------------------------------------------------------------------
// Hand-built rows — the branches no corpus reaches
// ---------------------------------------------------------------------------

let rowSeq = 0;

function session(over: Partial<OcSessionRow> & { id: string }): OcSessionRow {
  rowSeq++;
  return {
    projectId: 'prj_test',
    parentId: null,
    slug: null,
    directory: null,
    title: `title ${over.id}`,
    version: '1.18.22',
    agent: 'general',
    model: 'qwen-local',
    cost: 0,
    tokensInput: 0,
    tokensOutput: 0,
    timeCreated: 1_000_000 + rowSeq,
    timeUpdated: 2_000_000 + rowSeq,
    timeArchived: null,
    ...over,
  };
}

function tool(over: Partial<OcToolRecord> & { partId: string; sessionId: string }): OcToolRecord {
  rowSeq++;
  return {
    id: `call_${over.partId}`,
    toolName: 'bash',
    status: 'done',
    inputPreview: '{}',
    order: [1_000_000 + rowSeq, over.partId] as [number, string],
    inputTruncated: false,
    resultTruncated: false,
    ...over,
  };
}

/** A `task` record whose three join keys agree with `child`. */
function taskFor(partId: string, parent: OcSessionRow, child: OcSessionRow): OcToolRecord {
  return tool({
    partId,
    sessionId: parent.id,
    toolName: 'task',
    taskChildSessionId: child.id,
    taskParentSessionId: parent.id,
  });
}

const ZERO_PARSE_COUNTS: OcParseCounts = {
  partRows: 0,
  partsMalformed: 0,
  reasoningPartsDropped: 0,
  partsIgnoredNoNode: 0,
  toolParts: 0,
  taskParts: 0,
  previewsTruncated: 0,
};

function parseOf(records: readonly OcToolRecord[]): OcParseResult {
  const bySession = new Map<string, OcToolRecord[]>();
  for (const record of records) {
    const list = bySession.get(record.sessionId) ?? [];
    list.push(record);
    bySession.set(record.sessionId, list);
  }
  return {
    toolsBySession: bySession,
    counts: {
      ...ZERO_PARSE_COUNTS,
      toolParts: records.length,
      taskParts: records.filter((r) => r.toolName === 'task').length,
    },
  };
}

const PROJECT: OcProjectRow = { id: 'prj_test', worktree: 'C:\\repo', vcs: 'git' };

function graft(
  sessions: readonly OcSessionRow[],
  records: readonly OcToolRecord[],
  options?: Parameters<typeof graftCorpus>[0]['options'],
) {
  return graftCorpus({
    sessions,
    projects: [PROJECT],
    parse: parseOf(records),
    ...(options === undefined ? {} : { options }),
  });
}

function agentsOf(node: AgentNode): AgentNode[] {
  return [node, ...node.children.filter(isAgentNode).flatMap(agentsOf)];
}

// ---------------------------------------------------------------------------
// The goldens' canonical serialization — a second implementation, on purpose
// ---------------------------------------------------------------------------

/** `DEFAULT_MAX_PAYLOAD_BYTES` in `src/parser/redact.ts`. */
const PREVIEW_BYTES = 8 * 1024;

function truncationMarker(keptBytes: number, originalBytes: number): string {
  return `\n...[agent-deck: truncated, showing ${keptBytes} of ${originalBytes} bytes]`;
}

/** The UTF-8-boundary-safe cut of `truncateUtf8()`. Applied ONCE, to the raw payload. */
function truncateOnce(text: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= PREVIEW_BYTES) return { text, truncated: false };
  let end = PREVIEW_BYTES;
  while (end > 0) {
    const byte = buf[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end--;
  }
  return {
    text: buf.subarray(0, end).toString('utf8') + truncationMarker(end, buf.length),
    truncated: true,
  };
}

/** `sha256:<first 16 hex>:<utf8 byte length>` — the house preview convention. */
function previewFingerprint(text: string | undefined): string | null {
  if (text === undefined) return null;
  const bytes = Buffer.from(text, 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}:${bytes.byteLength}`;
}

const DROPPED_FIELDS = new Set(['signature', 'thinking', 'redacted_thinking']);

function stripDroppedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDroppedFields);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (DROPPED_FIELDS.has(key)) continue;
    out[key] = stripDroppedFields((value as Record<string, unknown>)[key]);
  }
  return out;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

function serializeTool(node: ToolNode): unknown {
  return {
    node: 'tool',
    id: node.id,
    toolName: node.toolName,
    status: node.status,
    inputPreview: previewFingerprint(node.inputPreview),
    resultPreview: previewFingerprint(node.resultPreview),
    durationMs: node.durationMs ?? null,
  };
}

function serializeAgent(node: AgentNode, anchor: number): unknown {
  return {
    node: 'agent',
    id: node.id,
    kind: node.kind,
    label: node.label,
    status: node.status,
    spawnDepth: node.spawnDepth,
    tokens: { in: node.tokens.in, out: node.tokens.out },
    startedAtOffsetMs: node.startedAt - anchor,
    endedAtOffsetMs: node.endedAt === undefined ? null : node.endedAt - anchor,
    children: node.children.map((child: TreeNode) =>
      isAgentNode(child) ? serializeAgent(child, anchor) : serializeTool(child),
    ),
  };
}

function serializeState(state: SessionState): unknown {
  const anchor = state.root.startedAt;
  return {
    sessionId: state.sessionId,
    projectSlug: state.projectSlug,
    engine: state.engine,
    workspaceMatch: state.workspaceMatch,
    liveness: state.liveness,
    schemaOk: state.schemaOk,
    epochAnchor: new Date(anchor).toISOString(),
    totals: {
      inputTokens: state.totals.inputTokens,
      outputTokens: state.totals.outputTokens,
      costUsd: state.totals.costUsd,
    },
    spawnEdges: state.spawnEdges,
    parked: state.parked,
    root: serializeAgent(state.root, anchor),
  };
}

// ---------------------------------------------------------------------------
// Reading a committed corpus into the grafter's inputs
// ---------------------------------------------------------------------------

interface RawPart {
  id: string;
  sessionId: string;
  timeCreated: number;
  data: string;
}

interface Corpus {
  sessions: OcSessionRow[];
  projects: OcProjectRow[];
  parse: OcParseResult;
}

interface OcPartData {
  type?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    time?: { start?: number; end?: number };
    metadata?: { sessionId?: unknown; parentSessionId?: unknown };
  };
}

function toolStatus(status: string | undefined): ToolNode['status'] {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'done';
  if (status === 'error') return 'error';
  throw new Error(`unmapped tool state.status ${JSON.stringify(status)}`);
}

/**
 * G1: opened `{ readOnly: true }`, every statement a `SELECT`, nothing under
 * `fixtures/` written. Integers are read as BigInt (`setReadBigInts`) so no
 * millisecond timestamp passes through a float, then narrowed at this
 * boundary — the same thing `scripts/capture-opencode.mjs` does.
 *
 * No SQL string matching at all: SQLite `LIKE` is case-insensitive for ASCII
 * and hands back confident wrong answers.
 */
function readCorpus(dbPath: string): Corpus {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const projectStmt = db.prepare('SELECT id, worktree, vcs FROM project ORDER BY id');
    projectStmt.setReadBigInts(false);
    const projects = projectStmt.all() as unknown as OcProjectRow[];

    const sessionStmt = db.prepare(
      'SELECT id, project_id, parent_id, slug, directory, title, version, agent, model, cost,' +
        ' tokens_input, tokens_output, time_created, time_updated, time_archived FROM session' +
        ' ORDER BY time_created, id',
    );
    sessionStmt.setReadBigInts(true);
    const sessions = (
      sessionStmt.all() as unknown as Record<string, string | bigint | null>[]
    ).map<OcSessionRow>((r) => ({
      id: r['id'] as string,
      projectId: r['project_id'] as string,
      parentId: r['parent_id'] as string | null,
      slug: r['slug'] as string | null,
      directory: r['directory'] as string | null,
      title: r['title'] as string,
      version: r['version'] as string,
      agent: r['agent'] as string | null,
      model: r['model'] as string | null,
      cost: Number(r['cost']),
      tokensInput: Number(r['tokens_input']),
      tokensOutput: Number(r['tokens_output']),
      timeCreated: Number(r['time_created']),
      timeUpdated: Number(r['time_updated']),
      timeArchived: r['time_archived'] === null ? null : Number(r['time_archived']),
    }));

    const partStmt = db.prepare(
      'SELECT id, session_id, time_created, data FROM part ORDER BY time_created, id',
    );
    partStmt.setReadBigInts(true);
    const parts = (
      partStmt.all() as unknown as Record<string, string | bigint>[]
    ).map<RawPart>((r) => ({
      id: r['id'] as string,
      sessionId: r['session_id'] as string,
      timeCreated: Number(r['time_created']),
      data: r['data'] as string,
    }));

    return { sessions, projects, parse: parseParts(parts) };
  } finally {
    db.close();
  }
}

/** The `parse.ts` half, reimplemented here because that module is not this package's. */
function parseParts(parts: readonly RawPart[]): OcParseResult {
  const counts: OcParseCounts = { ...ZERO_PARSE_COUNTS, partRows: parts.length };
  const toolsBySession = new Map<string, OcToolRecord[]>();

  for (const part of parts) {
    let data: OcPartData;
    try {
      data = JSON.parse(part.data) as OcPartData;
    } catch {
      counts.partsMalformed++;
      continue;
    }
    if (data.type === 'reasoning') {
      counts.reasoningPartsDropped++;
      continue;
    }
    if (data.type !== 'tool') {
      counts.partsIgnoredNoNode++;
      continue;
    }
    counts.toolParts++;
    const state = data.state ?? {};
    const inputCut = truncateOnce(canonicalJson(stripDroppedFields(state.input ?? null)));
    const outputText =
      typeof state.output === 'string'
        ? state.output
        : typeof state.error === 'string'
          ? state.error
          : undefined;
    const outputCut = outputText === undefined ? undefined : truncateOnce(outputText);
    const start = state.time?.start;
    const end = state.time?.end;
    const isTask = data.tool === 'task';
    if (isTask) counts.taskParts++;
    if (inputCut.truncated) counts.previewsTruncated++;
    if (outputCut?.truncated === true) counts.previewsTruncated++;
    const childId = state.metadata?.sessionId;
    const parentClaim = state.metadata?.parentSessionId;

    const record: OcToolRecord = {
      id: data.callID as string,
      toolName: data.tool as string,
      status: toolStatus(state.status),
      inputPreview: inputCut.text,
      ...(outputCut === undefined ? {} : { resultPreview: outputCut.text }),
      ...(typeof start === 'number' && typeof end === 'number'
        ? { durationMs: end - start }
        : {}),
      partId: part.id,
      sessionId: part.sessionId,
      order: [part.timeCreated, part.id],
      ...(isTask && typeof childId === 'string' && childId !== ''
        ? { taskChildSessionId: childId }
        : {}),
      ...(isTask && typeof parentClaim === 'string'
        ? { taskParentSessionId: parentClaim }
        : {}),
      inputTruncated: inputCut.truncated,
      resultTruncated: outputCut?.truncated === true,
    };
    const list = toolsBySession.get(part.sessionId) ?? [];
    list.push(record);
    toolsBySession.set(part.sessionId, list);
  }

  return { toolsBySession, counts };
}

interface Golden {
  schema: string;
  generator: string;
  generatedFrom: string;
  dataVersion: string;
  engine: string;
  previewBytes: number;
  counts: Record<string, number>;
  sessions: unknown[];
}

const CORPORA = listCorpora();

interface Loaded {
  golden: Golden;
  goldenText: string;
  corpus: Corpus;
  result: ReturnType<typeof graftCorpus>;
}

const LOADED = new Map<string, Loaded>();

/**
 * Memoised, and called INSIDE each `it` rather than in the `describe` body.
 *
 * A throw during collection reports as a SKIP with a clean-looking totals
 * line — the recorded failure class where 24 assertions ran zero times and the
 * summary read green. Inside a test it is a red failure with a stack.
 */
function load(corpusName: string): Loaded {
  const cached = LOADED.get(corpusName);
  if (cached !== undefined) return cached;
  const goldenText = readFileSync(corpusGoldenPath(corpusName), 'utf8');
  const corpus = readCorpus(corpusDbPath(corpusName));
  const loaded: Loaded = {
    golden: JSON.parse(goldenText) as Golden,
    goldenText,
    corpus,
    result: graftCorpus({
      sessions: corpus.sessions,
      projects: corpus.projects,
      parse: corpus.parse,
      options: {
        /*
         * The slug seam, filled exactly as `src/opencode/index.ts` fills it in
         * production.
         *
         * NOT optional, and the failure it caused is worth recording. This call
         * originally passed no options, so the corpus reproduction ran on
         * `defaultProjectSlug` (`''`) — which matched the goldens as they stood
         * when this file was written. `PLAN.md` Phase 4 Amendment A1 then filled
         * `projectSlug` in both goldens, and the byte compare below began
         * failing on that one field while every other field still matched.
         *
         * `graft.ts` deliberately does not import `slug.ts`, so the seam has to
         * be filled by whoever drives it. Filling it here with the real rule is
         * what makes this a reproduction of the production path rather than of
         * a default the production path never uses.
         */
        projectSlug: (project) =>
          project === undefined ? '' : slugFromWorktree(project.worktree),
      },
    }),
  };
  LOADED.set(corpusName, loaded);
  return loaded;
}

// ---------------------------------------------------------------------------
// 1 — Reproduction: both committed corpora, through the production grafter
// ---------------------------------------------------------------------------

describe('graftCorpus reproduces the committed goldens', () => {
  // Corpora are resolved at COLLECTION time: a list populated in `beforeAll`
  // generates zero tests and reads green.
  it('finds at least one corpus on disk', () => {
    expect(CORPORA.length).toBeGreaterThan(0);
  });

  for (const corpusName of CORPORA) {
    describe(corpusName, () => {
      it('produces the golden counts block, key order included', () => {
        const { golden, result } = load(corpusName);
        // Read from the corpus's own file — never hard-coded, so a re-harvest
        // does not read as a regression.
        expect(result.counts).toStrictEqual(golden.counts);
        expect(Object.keys(result.counts)).toStrictEqual(Object.keys(golden.counts));
      });

      it('produces one SessionState per root session', () => {
        const { corpus, golden, result } = load(corpusName);
        expect(result.sessions.length).toBe(golden.counts['rootSessions']);
        const roots = corpus.sessions.filter((s) => s.parentId === null);
        expect(result.sessions.map((s) => s.sessionId)).toStrictEqual(roots.map((s) => s.id));
      });

      it('grafts every child session in as an AgentNode or parks it', () => {
        const { corpus, result } = load(corpusName);
        const seen = new Set<string>();
        for (const state of result.sessions) {
          for (const node of agentsOf(state.root)) {
            seen.add(node.id === 'root' ? state.sessionId : node.id);
          }
          for (const entry of state.parked ?? []) seen.add(entry.agentId);
        }
        const unreachable = corpus.sessions.filter((s) => !seen.has(s.id)).map((s) => s.id);
        // Anchor 24/24, witness 5/5 — derived, not asserted as a literal.
        expect(unreachable).toStrictEqual([]);
      });

      it('serializes byte-for-byte into golden.json', () => {
        const { golden, goldenText, result } = load(corpusName);
        const rebuilt = {
          schema: golden.schema,
          generator: golden.generator,
          generatedFrom: golden.generatedFrom,
          dataVersion: result.dataVersion,
          engine: 'opencode',
          previewBytes: PREVIEW_BYTES,
          counts: result.counts,
          sessions: result.sessions.map(serializeState),
        };
        // Compare the parsed structures first: a mismatch reports as a diff of
        // the offending node rather than as two 300 KB strings.
        expect(rebuilt.sessions).toStrictEqual(golden.sessions);
        expect(`${JSON.stringify(rebuilt, null, 2)}\n`).toBe(goldenText);
      });

      it('reports the corpus dataVersion', () => {
        const { golden, result } = load(corpusName);
        expect(result.dataVersion).toBe(golden.dataVersion);
        expect(result.dataVersion).toBe(corpusName.slice('opencode-'.length));
      });

      it('refuses nothing — refusal is the fingerprint\'s, not the grafter\'s', () => {
        const { result } = load(corpusName);
        expect(result.refused).toStrictEqual([]);
        expect(result.sessions.every((s) => s.schemaOk)).toBe(true);
      });

      it('places no parked identity anywhere in the tree', () => {
        const { result } = load(corpusName);
        for (const state of result.sessions) {
          const inTree = new Set(agentsOf(state.root).map((n) => n.id));
          for (const entry of state.parked ?? []) {
            expect(inTree.has(entry.agentId)).toBe(false);
          }
        }
      });

      it('places every subagent node immediately after its spawning tool node', () => {
        const { result } = load(corpusName);
        for (const state of result.sessions) {
          const edges = new Map((state.spawnEdges ?? []).map((e) => [e.agentId, e]));
          for (const parent of agentsOf(state.root)) {
            parent.children.forEach((child: TreeNode, index: number) => {
              if (!isAgentNode(child)) return;
              const edge = edges.get(child.id);
              expect(edge).toBeDefined();
              const before = parent.children[index - 1];
              expect(before).toBeDefined();
              expect(isAgentNode(before as TreeNode)).toBe(false);
              expect((before as ToolNode).id).toBe(edge?.toolUseId);
              expect((before as ToolNode).toolName).toBe('task');
              expect(edge?.parentNodeId).toBe(parent.id);
              expect(edge?.depth).toBe(parent.spawnDepth + 1);
              expect(child.spawnDepth).toBe(parent.spawnDepth + 1);
            });
          }
        }
      });

      it('sums totals over the root and every descendant session', () => {
        const { corpus, result } = load(corpusName);
        const byId = new Map(corpus.sessions.map((s) => [s.id, s]));
        for (const state of result.sessions) {
          const ids = agentsOf(state.root).map((n) => (n.id === 'root' ? state.sessionId : n.id));
          const rows = ids.map((id) => byId.get(id) as OcSessionRow);
          expect(state.totals.inputTokens).toBe(
            rows.reduce((sum, r) => sum + r.tokensInput, 0),
          );
          expect(state.totals.outputTokens).toBe(
            rows.reduce((sum, r) => sum + r.tokensOutput, 0),
          );
        }
      });

      it('tags every state with engine opencode and the injected seams', () => {
        const { corpus, result } = load(corpusName);
        // `projectSlug` used to be asserted as `''` here — the placeholder the
        // goldens carried before `PLAN.md` Phase 4 Amendment A1 closed OC7's
        // open item. It is now the CC slug for `project.worktree`, derived from
        // the corpus's OWN project row rather than written as a literal, so
        // this stays a pin on the rule and not on one machine's path.
        const [project] = corpus.projects;
        const expectedSlug =
          project === undefined ? '' : slugFromWorktree(project.worktree);
        expect(expectedSlug).not.toBe('');
        for (const state of result.sessions) {
          expect(state.engine).toBe('opencode');
          expect(state.projectSlug).toBe(expectedSlug);
          expect(state.workspaceMatch).toBe(true);
          expect(state.liveness).toBe('idle');
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 2 — The park codes, byte-exact against the committed files
// ---------------------------------------------------------------------------

describe('park reason strings are byte-exact', () => {
  it('taskWithoutChild matches the anchor golden verbatim', () => {
    const anchor = CORPORA.find((n) => n === 'opencode-1.18.22');
    expect(anchor).toBeDefined();
    const golden = JSON.parse(readFileSync(corpusGoldenPath(anchor as string), 'utf8')) as {
      sessions: { parked: { code: string; reason: string; toolUseId?: string }[] }[];
    };
    const parked = golden.sessions.flatMap((s) => s.parked);
    const sample = parked.find((p) => p.code === 'taskWithoutChild');
    expect(sample).toBeDefined();
    expect(OC_PARK_REASONS.taskWithoutChild).toBe(sample?.reason);
    // The `§` is U+00A7 and the separator is a spaced hyphen, not an en dash.
    expect(Buffer.byteLength(OC_PARK_REASONS.taskWithoutChild, 'utf8')).toBe(131);
    expect(OC_PARK_REASONS.taskWithoutChild).toContain('(contract amendment \u00a7G) - not');
  });

  it('the three unexercised reasons carry the contract citation', () => {
    expect(OC_PARK_REASONS.joinKeyContradiction).toBe(
      "task state.metadata.sessionId, state.metadata.parentSessionId and the child session's parent_id do not agree (contract \u00a75)",
    );
    expect(OC_PARK_REASONS.ambiguousJoinKey).toBe(
      'more than one task part names this child session (contract \u00a75)',
    );
    expect(OC_PARK_REASONS.noSpawningTaskPart).toBe(
      'child session names a parent_id but no task part in that parent joins to it (contract \u00a75)',
    );
  });
});

// ---------------------------------------------------------------------------
// 3 — taskWithoutChild, on hand-built rows: no AgentNode, no edge, still a tool
// ---------------------------------------------------------------------------

describe('taskWithoutChild', () => {
  const root = session({ id: 'ses_root' });
  const orphanTask = tool({
    partId: 'prt_no_child',
    sessionId: root.id,
    toolName: 'task',
    status: 'error',
  });
  const result = graft([root], [orphanTask]);
  const state = result.sessions[0] as SessionState;

  it('parks with the part row id, since no agent id exists', () => {
    expect(state.parked).toStrictEqual([
      {
        agentId: 'prt_no_child',
        code: 'taskWithoutChild',
        toolUseId: orphanTask.id,
        reason: OC_PARK_REASONS.taskWithoutChild,
      },
    ]);
  });

  it('still emits the ToolNode — the call happened and the user saw it', () => {
    expect(state.root.children).toStrictEqual([toToolNode(orphanTask)]);
  });

  it('emits no spawn edge', () => {
    expect(state.spawnEdges).toStrictEqual([]);
  });

  it('does not guess a child from timing', () => {
    // A child session exists and is the nearest in time by construction. The
    // grafter must not look: absence of the key is the whole signal (OC3).
    const nearby = session({ id: 'ses_nearby', parentId: null, timeCreated: 1 });
    const two = graft([root, nearby], [orphanTask]);
    const first = two.sessions[0] as SessionState;
    expect(first.spawnEdges).toStrictEqual([]);
    expect(agentsOf(first.root).map((n) => n.id)).toStrictEqual(['root']);
    expect(two.counts.taskPartsJoined).toBe(0);
  });

  it('counts the part as parked, not as joined', () => {
    expect(result.counts.taskPartsParked).toBe(1);
    expect(result.counts.taskPartsJoined).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4 — joinKeyContradiction: all three ways it can fire (UNEXERCISED by fixtures)
// ---------------------------------------------------------------------------

describe('joinKeyContradiction (no corpus reaches this)', () => {
  const expectContradiction = (
    result: ReturnType<typeof graft>,
    claimedChildId: string,
    toolUseId: string,
  ): void => {
    const state = result.sessions[0] as SessionState;
    expect(state.parked).toStrictEqual([
      {
        agentId: claimedChildId,
        code: 'joinKeyContradiction',
        toolUseId,
        reason: OC_PARK_REASONS.joinKeyContradiction,
      },
    ]);
    expect(state.spawnEdges).toStrictEqual([]);
  };

  it('fires when the named child row is absent', () => {
    const root = session({ id: 'ses_root' });
    const task = tool({
      partId: 'prt_task',
      sessionId: root.id,
      toolName: 'task',
      taskChildSessionId: 'ses_ghost',
      taskParentSessionId: root.id,
    });
    expectContradiction(graft([root], [task]), 'ses_ghost', task.id);
  });

  it("fires when the child's parent_id names a different session", () => {
    const root = session({ id: 'ses_root' });
    const other = session({ id: 'ses_other' });
    const child = session({ id: 'ses_child', parentId: other.id });
    const task = tool({
      partId: 'prt_task',
      sessionId: root.id,
      toolName: 'task',
      taskChildSessionId: child.id,
      taskParentSessionId: root.id,
    });
    const result = graft([root, other, child], [task]);
    expectContradiction(result, child.id, task.id);
    // The child is not dropped: it parks under `ses_other`, which is where its
    // own `parent_id` points and where nothing joins it.
    const otherState = result.sessions.find((s) => s.sessionId === other.id) as SessionState;
    expect(otherState.parked?.map((p) => p.code)).toStrictEqual(['noSpawningTaskPart']);
  });

  it('fires when state.metadata.parentSessionId disagrees with the part\'s own session', () => {
    const root = session({ id: 'ses_root' });
    const child = session({ id: 'ses_child', parentId: root.id });
    const task = tool({
      partId: 'prt_task',
      sessionId: root.id,
      toolName: 'task',
      taskChildSessionId: child.id,
      taskParentSessionId: 'ses_somewhere_else',
    });
    const result = graft([root, child], [task]);
    const state = result.sessions[0] as SessionState;
    expect(state.parked?.map((p) => p.code)).toStrictEqual([
      'joinKeyContradiction',
      'noSpawningTaskPart',
    ]);
    expect(state.spawnEdges).toStrictEqual([]);
  });

  it('is a DIFFERENT code from a missing key', () => {
    expect(OC_PARK_REASONS.joinKeyContradiction).not.toBe(OC_PARK_REASONS.taskWithoutChild);
  });
});

// ---------------------------------------------------------------------------
// 5 — ambiguousJoinKey (UNEXERCISED by fixtures)
// ---------------------------------------------------------------------------

describe('ambiguousJoinKey (no corpus reaches this)', () => {
  const root = session({ id: 'ses_root' });
  const child = session({ id: 'ses_child', parentId: root.id });
  const first = taskFor('prt_a', root, child);
  const second = taskFor('prt_b', root, child);
  const result = graft([root, child], [first, second]);
  const state = result.sessions[0] as SessionState;

  it('parks the later task part and keeps the earlier join', () => {
    expect(compareToolRecords(first, second)).toBeLessThan(0);
    expect(state.parked).toStrictEqual([
      {
        agentId: child.id,
        code: 'ambiguousJoinKey',
        toolUseId: second.id,
        reason: OC_PARK_REASONS.ambiguousJoinKey,
      },
    ]);
    expect(state.spawnEdges).toStrictEqual([
      {
        toolUseId: first.id,
        agentId: child.id,
        parentNodeId: 'root',
        depth: 1,
        recordedDepth: 1,
      },
    ]);
  });

  it('grafts the child exactly once, beside the winning tool node', () => {
    const kinds = state.root.children.map((c: TreeNode) => (isAgentNode(c) ? c.id : 'tool'));
    expect(kinds).toStrictEqual(['tool', child.id, 'tool']);
  });
});

// ---------------------------------------------------------------------------
// 6 — noSpawningTaskPart (UNEXERCISED by fixtures)
// ---------------------------------------------------------------------------

describe('noSpawningTaskPart (no corpus reaches this)', () => {
  const root = session({ id: 'ses_root' });
  const child = session({ id: 'ses_child', parentId: root.id });
  const result = graft([root, child], []);
  const state = result.sessions[0] as SessionState;

  it('parks the child with no toolUseId key at all', () => {
    expect(state.parked).toStrictEqual([
      {
        agentId: child.id,
        code: 'noSpawningTaskPart',
        reason: OC_PARK_REASONS.noSpawningTaskPart,
      },
    ]);
    expect('toolUseId' in ((state.parked ?? [])[0] as object)).toBe(false);
  });

  it('hangs the child off nothing — it is absent from the tree', () => {
    expect(agentsOf(state.root).map((n) => n.id)).toStrictEqual(['root']);
  });

  it('runs after the tool walk, so it follows this session\'s other parks', () => {
    const orphanTask = tool({ partId: 'prt_x', sessionId: root.id, toolName: 'task' });
    const mixed = graft([root, child], [orphanTask]);
    expect((mixed.sessions[0] as SessionState).parked?.map((p) => p.code)).toStrictEqual([
      'taskWithoutChild',
      'noSpawningTaskPart',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 7 — spawnDepth >= 2, and no cap (UNEXERCISED by fixtures)
// ---------------------------------------------------------------------------

describe('depth is walked from parent_id and is not capped', () => {
  const s0 = session({ id: 'ses_0' });
  const s1 = session({ id: 'ses_1', parentId: 'ses_0', agent: 'general' });
  const s2 = session({ id: 'ses_2', parentId: 'ses_1', agent: 'general' });
  const s3 = session({ id: 'ses_3', parentId: 'ses_2', agent: 'general' });
  const t1 = taskFor('prt_1', s0, s1);
  const t2 = taskFor('prt_2', s1, s2);
  const t3 = taskFor('prt_3', s2, s3);
  const result = graft([s0, s1, s2, s3], [t1, t2, t3]);
  const state = result.sessions[0] as SessionState;

  it('produces one SessionState carrying the whole chain', () => {
    expect(result.sessions.length).toBe(1);
    expect(result.counts.rootSessions).toBe(1);
    expect(result.counts.childSessions).toBe(3);
  });

  it('walks spawnDepth 0,1,2,3 with no cap', () => {
    expect(agentsOf(state.root).map((n) => n.spawnDepth)).toStrictEqual([0, 1, 2, 3]);
    expect(agentsOf(state.root).map((n) => n.id)).toStrictEqual(['root', 'ses_1', 'ses_2', 'ses_3']);
    expect(agentsOf(state.root).map((n) => n.kind)).toStrictEqual([
      'main',
      'subagent',
      'subagent',
      'subagent',
    ]);
  });

  it('chains parentNodeId root -> ses_1 -> ses_2', () => {
    expect(state.spawnEdges).toStrictEqual([
      { toolUseId: t1.id, agentId: 'ses_1', parentNodeId: 'root', depth: 1, recordedDepth: 1 },
      { toolUseId: t2.id, agentId: 'ses_2', parentNodeId: 'ses_1', depth: 2, recordedDepth: 2 },
      { toolUseId: t3.id, agentId: 'ses_3', parentNodeId: 'ses_2', depth: 3, recordedDepth: 3 },
    ]);
  });

  it('keeps recordedDepth equal to depth by construction', () => {
    // OpenCode records no depth anywhere, so nothing can disagree. Vacuous for
    // this engine rather than wrong — GOLDEN.md DEVIATIONS item 4.
    for (const edge of state.spawnEdges ?? []) expect(edge.recordedDepth).toBe(edge.depth);
  });

  it('nests each subagent inside its parent agent, never inside a ToolNode', () => {
    const depth1 = state.root.children.filter(isAgentNode)[0] as AgentNode;
    expect(depth1.id).toBe('ses_1');
    for (const node of state.root.children) {
      if (isAgentNode(node)) continue;
      expect('children' in node).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 8 — running status, and the omitted endedAt (UNEXERCISED by fixtures)
// ---------------------------------------------------------------------------

describe('AgentNode.status running (no corpus reaches this)', () => {
  const root = session({ id: 'ses_root', timeArchived: 4_000_000 });
  const running = tool({ partId: 'prt_run', sessionId: root.id, status: 'running' });
  const state = graft([root], [running]).sessions[0] as SessionState;

  it('reads running from any running tool record in that session', () => {
    expect(state.root.status).toBe('running');
  });

  it('OMITS endedAt entirely rather than setting it to null', () => {
    expect(state.root.endedAt).toBeUndefined();
    expect('endedAt' in state.root).toBe(false);
    // Even though `time_archived` is set — a running agent has no end.
    expect(root.timeArchived).toBe(4_000_000);
  });
});

describe('AgentNode.status and endedAt when nothing is running', () => {
  it('falls back to time_updated when time_archived is NULL', () => {
    const root = session({ id: 'ses_root', timeUpdated: 77 });
    const state = graft([root], []).sessions[0] as SessionState;
    expect(state.root.endedAt).toBe(77);
    expect(state.root.status).toBe('done');
  });

  it('prefers time_archived when it is set', () => {
    const root = session({ id: 'ses_root', timeUpdated: 77, timeArchived: 99 });
    const state = graft([root], []).sessions[0] as SessionState;
    expect(state.root.endedAt).toBe(99);
  });

  it("takes a subagent's status from its spawning task part", () => {
    const root = session({ id: 'ses_root' });
    const child = session({ id: 'ses_child', parentId: root.id });
    const errored = { ...taskFor('prt_t', root, child), status: 'error' as const };
    const state = graft([root, child], [errored]).sessions[0] as SessionState;
    const node = state.root.children.filter(isAgentNode)[0] as AgentNode;
    expect(node.status).toBe('error');
  });

  it('reports done for a subagent whose spawning task part completed', () => {
    const root = session({ id: 'ses_root' });
    const child = session({ id: 'ses_child', parentId: root.id });
    const state = graft([root, child], [taskFor('prt_t', root, child)]).sessions[0] as SessionState;
    const node = state.root.children.filter(isAgentNode)[0] as AgentNode;
    expect(node.status).toBe('done');
  });

  it("lets a subagent's own running tool beat its spawning task part's status", () => {
    const root = session({ id: 'ses_root' });
    const child = session({ id: 'ses_child', parentId: root.id });
    const errored = { ...taskFor('prt_t', root, child), status: 'error' as const };
    const inner = tool({ partId: 'prt_i', sessionId: child.id, status: 'running' });
    const state = graft([root, child], [errored, inner]).sessions[0] as SessionState;
    const node = state.root.children.filter(isAgentNode)[0] as AgentNode;
    expect(node.status).toBe('running');
    expect('endedAt' in node).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9 — the three injected seams (liveness 'ended' is UNEXERCISED by fixtures)
// ---------------------------------------------------------------------------

describe('injected options', () => {
  const root = session({ id: 'ses_root' });
  const archived = session({ id: 'ses_archived', timeArchived: 5_000 });

  it('defaults liveness to the static rule so the goldens need no clock', () => {
    expect(defaultSessionLiveness(root)).toBe('idle');
    expect(defaultSessionLiveness(archived)).toBe('ended');
    expect((graft([root], []).sessions[0] as SessionState).liveness).toBe('idle');
  });

  it('produces liveness ended from time_archived, which no corpus row carries', () => {
    expect((graft([archived], []).sessions[0] as SessionState).liveness).toBe('ended');
  });

  it('takes liveness from livenessFor when supplied', () => {
    const state = graft([root], [], { livenessFor: () => 'live' }).sessions[0] as SessionState;
    expect(state.liveness).toBe('live');
  });

  it('passes the ROOT session row to livenessFor, not a child', () => {
    const child = session({ id: 'ses_child', parentId: root.id });
    const seen: string[] = [];
    graft([root, child], [taskFor('prt_t', root, child)], {
      livenessFor: (s) => {
        seen.push(s.id);
        return 'idle';
      },
    });
    expect(seen).toStrictEqual([root.id]);
  });

  it('defaults workspaceMatch to project-exists and honours an override', () => {
    expect(defaultWorkspaceMatch(PROJECT)).toBe(true);
    expect(defaultWorkspaceMatch(undefined)).toBe(false);
    const state = graft([root], [], { workspaceMatch: () => false }).sessions[0] as SessionState;
    expect(state.workspaceMatch).toBe(false);
  });

  it('reports workspaceMatch false when no project row matches', () => {
    const stray = session({ id: 'ses_stray', projectId: 'prj_absent' });
    expect((graft([stray], []).sessions[0] as SessionState).workspaceMatch).toBe(false);
  });

  it('defaults projectSlug to the empty placeholder and honours an override', () => {
    // OC7 leaves the field open; `slugFromWorktree` in `src/opencode/slug.ts`
    // is what the orchestrator injects (PLAN.md Phase 4 Amendment A1). This
    // module neither imports nor decides it.
    expect(defaultProjectSlug(PROJECT)).toBe('');
    const state = graft([root], [], {
      projectSlug: (p) => (p === undefined ? '' : p.worktree.toLowerCase()),
    }).sessions[0] as SessionState;
    expect(state.projectSlug).toBe('c:\\repo');
  });
});

// ---------------------------------------------------------------------------
// 10 — labels, ordering, and the reachability throw
// ---------------------------------------------------------------------------

describe('agentLabel', () => {
  it('joins agent and title with a colon and a space', () => {
    expect(agentLabel(session({ id: 'a', agent: 'general', title: 'Do a thing' }))).toBe(
      'general: Do a thing',
    );
  });

  it('yields the title alone rather than a ": " prefix on nothing', () => {
    expect(agentLabel(session({ id: 'a', agent: null, title: 'Do a thing' }))).toBe('Do a thing');
    expect(agentLabel(session({ id: 'a', agent: '', title: 'Do a thing' }))).toBe('Do a thing');
  });
});

describe('tool ordering', () => {
  it('sorts by time_created then by the part id, byte-wise', () => {
    const root = session({ id: 'ses_root' });
    const late = tool({ partId: 'prt_a', sessionId: root.id, order: [200, 'prt_a'] });
    const earlyB = tool({ partId: 'prt_b', sessionId: root.id, order: [100, 'prt_b'] });
    const earlyA = tool({ partId: 'prt_c', sessionId: root.id, order: [100, 'prt_a'] });
    const state = graft([root], [late, earlyB, earlyA]).sessions[0] as SessionState;
    expect(state.root.children.map((c: TreeNode) => (c as ToolNode).id)).toStrictEqual([
      earlyA.id,
      earlyB.id,
      late.id,
    ]);
  });

  it('never uses locale collation', () => {
    const a = tool({ partId: 'prt_Z', sessionId: 's', order: [1, 'prt_Z'] });
    const b = tool({ partId: 'prt_a', sessionId: 's', order: [1, 'prt_a'] });
    // Byte order puts uppercase first; `localeCompare` does not.
    expect(compareToolRecords(a, b)).toBeLessThan(0);
  });
});

describe('toToolNode', () => {
  it('keeps the first six fields and drops the join carriers', () => {
    const record = tool({
      partId: 'prt_x',
      sessionId: 'ses_x',
      resultPreview: 'out',
      durationMs: 12,
      taskChildSessionId: 'ses_c',
      taskParentSessionId: 'ses_x',
      inputTruncated: true,
    });
    expect(toToolNode(record)).toStrictEqual({
      id: record.id,
      toolName: 'bash',
      status: 'done',
      inputPreview: '{}',
      resultPreview: 'out',
      durationMs: 12,
    });
  });

  it('omits resultPreview and durationMs rather than setting them undefined', () => {
    const node = toToolNode(tool({ partId: 'prt_y', sessionId: 'ses_y' }));
    expect('resultPreview' in node).toBe(false);
    expect('durationMs' in node).toBe(false);
  });
});

describe('every session row must be reachable', () => {
  it('throws rather than dropping a row whose parent_id names nothing', () => {
    const root = session({ id: 'ses_root' });
    const stray = session({ id: 'ses_stray', parentId: 'ses_nowhere' });
    expect(() => graft([root, stray], [])).toThrow(/reachable from no root: ses_stray/);
  });

  it('does not throw when the row parks instead', () => {
    const root = session({ id: 'ses_root' });
    const child = session({ id: 'ses_child', parentId: root.id });
    expect(() => graft([root, child], [])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 11 — counters, including the placement this module pins deliberately
// ---------------------------------------------------------------------------

describe('counts', () => {
  it('passes the parse counters through untouched, in the goldens key order', () => {
    const parse: OcParseResult = {
      toolsBySession: new Map(),
      counts: {
        partRows: 9,
        partsMalformed: 1,
        reasoningPartsDropped: 2,
        partsIgnoredNoNode: 3,
        toolParts: 4,
        taskParts: 5,
        previewsTruncated: 6,
      },
    };
    const result = graftCorpus({ sessions: [session({ id: 'a' })], projects: [PROJECT], parse });
    expect(Object.keys(result.counts)).toStrictEqual([
      'sessionRows',
      'rootSessions',
      'childSessions',
      'partRows',
      'partsMalformed',
      'reasoningPartsDropped',
      'partsIgnoredNoNode',
      'toolParts',
      'taskParts',
      'taskPartsJoined',
      'taskPartsParked',
      'previewsTruncated',
    ]);
    expect(result.counts.partsMalformed).toBe(1);
    expect(result.counts.previewsTruncated).toBe(6);
    expect(result.counts.sessionRows).toBe(1);
    expect(result.counts.rootSessions).toBe(1);
    expect(result.counts.childSessions).toBe(0);
  });

  it('increments taskPartsParked ONLY on taskWithoutChild — pinned, not assumed', () => {
    /*
     * `scripts/opencode-golden.mjs` increments this counter on the
     * `taskWithoutChild` branch alone, and the committed `counts` blocks were
     * generated that way. `OcCounts` in `types.ts` describes the field as
     * "`taskWithoutChild`, or a contradiction", which reads as all three
     * branches. Neither corpus can tell the readings apart (0 contradictions
     * in both), so this assertion is what makes changing it deliberate.
     */
    const root = session({ id: 'ses_root' });
    const child = session({ id: 'ses_child', parentId: root.id });
    const contradiction = tool({
      partId: 'prt_c',
      sessionId: root.id,
      toolName: 'task',
      taskChildSessionId: child.id,
      taskParentSessionId: 'ses_elsewhere',
    });
    const ambiguousA = taskFor('prt_d', root, child);
    const result = graft([root, child], [contradiction, ambiguousA]);
    const state = result.sessions[0] as SessionState;
    expect(state.parked?.map((p) => p.code)).toStrictEqual(['joinKeyContradiction']);
    expect(result.counts.taskPartsJoined).toBe(1);
    expect(result.counts.taskPartsParked).toBe(0);
  });

  it('reports dataVersion only when every session agrees', () => {
    const a = session({ id: 'a', version: '1.18.22' });
    const b = session({ id: 'b', version: '1.18.21' });
    expect(graft([a], []).dataVersion).toBe('1.18.22');
    const mixed = graft([a, b], []);
    expect(mixed.dataVersion).toBeUndefined();
    expect('dataVersion' in mixed).toBe(false);
  });
});
