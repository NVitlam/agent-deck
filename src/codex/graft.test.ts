/**
 * `src/codex/graft.ts` — DoD 2.4 (graft), 2.3a (labels), 2.6 (window).
 *
 * Two halves, and the split is the same one `src/opencode/graft.test.ts` uses:
 *
 *  1. **The real corpus.** `fixtures/codex-0.151.0-alpha.7.2/`'s rollout files
 *     are read here into `CodexThread[]` and handed to `graftCodexThreads`.
 *     Every count that could go stale on a re-harvest is derived from the
 *     corpus or cross-checked against `golden.json`, never written down.
 *
 *  2. **The branches no fixture reaches.** Four of the five park codes fire
 *     zero times on the corpus — two of them are TRIPWIRES that are supposed
 *     to — so they are proved on threads built by hand. `graftCodexThreads`
 *     takes plain data, so none of them needs a file.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE CONTAINS A SECOND READER, AND WHY THAT IS NOT A DEFECT
 * ---------------------------------------------------------------------------
 *
 * `src/codex/parse.ts` (P3) is what builds `CodexThread` in production. It did
 * not exist when this package was written, which is the entire reason
 * `src/codex/types.ts` was declared before the fleet: the grafter is written
 * against the TYPE, not against another worker's implementation.
 *
 * So {@link readCorpusThreads} below is a reader written from the spec and the
 * corpus, living in the test. It is not the module under test and it is not a
 * copy of one. Its own correctness is not assumed either — it is cross-checked
 * against `golden.json`, an artefact produced by `scripts/codex-golden.mjs`,
 * which this file does not import and shares no code with. Thread count, spawn
 * count and refusal count all come back from that independent artefact.
 *
 * ---------------------------------------------------------------------------
 * ONE MEASURED THING THE READER HAD TO GET RIGHT, RECORDED HERE BECAUSE IT IS
 * THE OPPOSITE OF CLAUDE CODE
 * ---------------------------------------------------------------------------
 *
 * Codex's `input_tokens` ALREADY INCLUDES `cached_input_tokens` and
 * `cache_write_input_tokens`. Measured over all 116 usage objects in the
 * corpus: `input_tokens + output_tokens === total_tokens` on 116 of 116, and
 * `input + cached + cache_write + output === total` on **0** of 116.
 *
 * Claude Code is the other way round — `TokenPair`'s own doc comment exists
 * because there `input_tokens` is roughly 2 while the prompt sits in the two
 * cache fields, so the three must be summed. Carrying that rule across to
 * Codex would over-report every Codex prompt by the cached amount: 93,261
 * would be reported as 174,669 on the `baseline` root, 1.87x. `TokenPair.
 * prompt` for Codex is `input_tokens`, alone.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, ToolNode, TreeNode } from '../model/events.js';
import type {
  CodexCounters,
  CodexOptional,
  CodexSpawn,
  CodexThread,
  CodexToolCall,
} from './types.js';
import {
  CODEX_PARK_REASONS,
  CODEX_ROOT_LABEL,
  CODEX_UNNAMED_LABEL,
  agentPathLeaf,
  codexNodeLabel,
  graftCodexThreads,
} from './graft.js';
import { readCodexEngine } from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'fixtures');

/**
 * The Codex corpora on disk, derived rather than written down.
 *
 * A hard-coded corpus name breaks on the next harvest and reads as a
 * regression; a hard-coded fixture-set SIZE does the same, which is why
 * nothing below asserts how many corpora, runs or files there are.
 */
const CORPUS_DIRS = fs
  .readdirSync(FIXTURES)
  .filter((name) => name.startsWith('codex-'))
  .filter((name) => fs.statSync(path.join(FIXTURES, name)).isDirectory())
  // THE ANCHOR CORPUS IS THE ONE WITH A `golden.json`, and saying so is what
  // stops this from depending on sort order. A WITNESS corpus
  // (`codex-vscode-*`, added 2026-09-03) carries no golden by design; before
  // this filter it was excluded only because `codex-0…` happens to sort before
  // `codex-vscode-…`, which a differently-named future witness would break
  // silently. `golden.test.ts` and `src/hooks/egress.test.ts` already select
  // this way and this file now joins them. `fingerprint.test.ts` does NOT
  // select by golden and does not need to: it names the anchor
  // (`codex-${PINNED_CODEX_VERSION}`) and only asserts the directory list
  // CONTAINS it, so it has no `[0]` pick to be fragile about.
  .filter((name) => fs.existsSync(path.join(FIXTURES, name, 'golden.json')))
  .sort();

const CORPUS = CORPUS_DIRS[0] === undefined ? null : path.join(FIXTURES, CORPUS_DIRS[0]);

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

interface RawRecord {
  readonly timestamp: string;
  readonly ordinal: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function opt<T>(container: Record<string, unknown> | undefined, key: string): CodexOptional<T> {
  if (container === undefined || !Object.prototype.hasOwnProperty.call(container, key)) {
    return { present: false, value: null };
  }
  const value = container[key];
  return { present: true, value: (value === undefined ? null : value) as T | null };
}

/** `source.subagent.thread_spawn`, or undefined. */
function threadSpawn(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return obj(obj(obj(payload['source'])?.['subagent'])?.['thread_spawn']);
}

function runDirs(corpusDir: string): string[] {
  return fs
    .readdirSync(corpusDir)
    .filter((name) => fs.statSync(path.join(corpusDir, name)).isDirectory())
    .filter((name) => fs.existsSync(path.join(corpusDir, name, 'hook-stream.jsonl')))
    .sort();
}

function transcriptFiles(runDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(path.join(runDir, 'home'));
  return out.sort();
}

function records(file: string): RawRecord[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RawRecord);
}

/** A tool call's output, flattened. `custom_tool_call_output` holds an array. */
function outputText(payload: Record<string, unknown>): string | null {
  const output = payload['output'];
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => str(obj(part)?.['text']) ?? '')
      .join('');
  }
  return null;
}

const PREVIEW_BYTES = 512;

/**
 * One transcript -> one {@link CodexThread}, the fork boundary applied.
 *
 * Spec C5: records below `subagent_history_start_ordinal` are the parent's
 * history re-serialised into the child's file and are dropped. When the key is
 * absent nothing is dropped — absence is the signal, and a reader testing
 * `=== null` would take the wrong branch on every `fork_turns: "none"` spawn.
 */
function readThread(file: string): CodexThread {
  const all = records(file);
  const meta = all.find((r) => r.type === 'session_meta' && r.ordinal === 0);
  if (meta === undefined) throw new Error(`no ordinal-0 session_meta in ${path.basename(file)}`);
  const payload = meta.payload;
  const spawn = threadSpawn(payload);

  const forkStartOpt = opt<number>(payload, 'subagent_history_start_ordinal');
  const forkStart =
    forkStartOpt.present && typeof forkStartOpt.value === 'number' ? forkStartOpt.value : 0;
  const own = all.filter((r) => r.ordinal >= forkStart);

  // -- tool calls and their outputs ---------------------------------------
  const outputs = new Map<string, string>();
  for (const r of own) {
    if (r.type !== 'response_item') continue;
    const t = str(r.payload['type']);
    if (t !== 'function_call_output' && t !== 'custom_tool_call_output') continue;
    const callId = str(r.payload['call_id']);
    const text = outputText(r.payload);
    if (callId !== null && text !== null) outputs.set(callId, text);
  }

  // The hook tap reports `event_msg.payload.item.id`, which for a shell command
  // is an `exec-<uuid>` unrelated to the call's `call_id` (spec C4). The
  // completion item that follows a call is the one that names it; taking the
  // NEXT `item_completed` is a reader-local heuristic and nothing below asserts
  // on it — it exists so the field is populated rather than invented.
  const completions = own
    .filter((r) => r.type === 'event_msg' && str(r.payload['type']) === 'item_completed')
    .map((r) => ({ ordinal: r.ordinal, item: obj(r.payload['item']) }));

  let payloadsTruncated = 0;
  const toolCalls: CodexToolCall[] = [];
  const spawns: CodexSpawn[] = [];

  for (const r of own) {
    if (r.type !== 'response_item') continue;
    const kind = str(r.payload['type']);
    if (kind !== 'function_call' && kind !== 'custom_tool_call') continue;
    const callId = str(r.payload['call_id']);
    if (callId === null) continue;
    const name = str(r.payload['name']) ?? '';
    const raw = outputs.get(callId);
    const truncated = raw !== undefined && raw.length > PREVIEW_BYTES;
    if (truncated) payloadsTruncated += 1;
    const preview = raw === undefined ? undefined : raw.slice(0, PREVIEW_BYTES);
    const completion = completions.find((c) => c.ordinal > r.ordinal);
    const itemId = completion === undefined ? null : str(completion.item?.['id']);
    const itemType = completion === undefined ? null : str(completion.item?.['type']);

    toolCalls.push({
      threadId: str(payload['id']) ?? '',
      file: path.basename(file),
      ordinal: r.ordinal,
      kind,
      name,
      namespace: opt<string>(r.payload, 'namespace'),
      callId,
      itemId,
      itemType,
      idRelation:
        itemId === null
          ? 'no_item'
          : itemId === callId
            ? 'item_id_equals_call_id'
            : 'item_id_distinct_from_call_id',
      ...(preview === undefined ? {} : { outputPreview: preview }),
      ...(raw === undefined ? {} : { outputTruncated: truncated }),
    });

    if (name !== 'spawn_agent') continue;

    const args = obj(JSON.parse(str(r.payload['arguments']) ?? '{}') as unknown) ?? {};
    const message = str(args['message']);
    // The OUTPUT is the engine's answer to the spawn. A `v2` success is
    // `{"task_name": "/root/alpha"}`, a `v1` success is
    // `{"agent_id": "...", "nickname": "..."}`, and a REFUSAL is a bare
    // sentence that is not JSON at all. Refusal is therefore read from the
    // SHAPE of the engine's reply, not from a substring of it: this repository
    // has already shipped a checklist row that ticked on the operator's own
    // prompt text, and `already exists` is a phrase a prompt can contain.
    let parsed: Record<string, unknown> | undefined;
    if (raw !== undefined) {
      try {
        parsed = obj(JSON.parse(raw) as unknown);
      } catch {
        parsed = undefined;
      }
    }
    const outputTaskName = parsed === undefined ? null : str(parsed['task_name']);
    const outputAgentId = parsed === undefined ? null : str(parsed['agent_id']);
    const refused =
      raw !== undefined && raw !== '' && outputTaskName === null && outputAgentId === null;

    const activityItem = obj(completion?.item);
    spawns.push({
      activityAgentPath: opt<string>(activityItem, 'agent_path'),
      activityAgentThreadId: activityItem === undefined ? null : str(activityItem['agent_thread_id']),
      threadId: str(payload['id']) ?? '',
      file: path.basename(file),
      ordinal: r.ordinal,
      callId,
      itemId,
      namespace: opt<string>(r.payload, 'namespace'),
      requestedTaskName: str(args['task_name']),
      outputTaskName,
      outputAgentId,
      outputNickname: parsed === undefined ? null : str(parsed['nickname']),
      // NOT resolved here. `parse.ts` sees one thread at a time and cannot know
      // another thread's id; the join is the grafter's (DoD 2.4) and it is
      // handed the KEYS, never an answer.
      childThreadId: null,
      childResolvedBy: 'unresolved',
      refused,
      refusalText: refused && raw !== undefined ? raw : null,
      messagePresent: message !== null,
      // G4/C7: the byte COUNT crosses; the bytes never do. Fernet's `gAAAA`
      // prefix is what every ciphertext string in the corpus starts with.
      messageEncrypted: message !== null && message.startsWith('gAAAA'),
      messageBytes: message === null ? 0 : Buffer.byteLength(message, 'utf8'),
    });
  }

  // -- token usage and the window (spec C8) --------------------------------
  let modelContextWindow: number | undefined;
  let contextNow: { prompt: number; output: number } | undefined;
  let burn: { prompt: number; output: number } | undefined;
  for (const r of own) {
    if (r.type !== 'event_msg' || str(r.payload['type']) !== 'token_count') continue;
    const info = obj(r.payload['info']);
    if (info === undefined) continue;
    const window = info['model_context_window'];
    if (typeof window === 'number') modelContextWindow = window;
    const last = obj(info['last_token_usage']);
    // `input_tokens` already includes the two cache buckets — see the header.
    if (last !== undefined) {
      contextNow = {
        prompt: Number(last['input_tokens'] ?? 0),
        output: Number(last['output_tokens'] ?? 0),
      };
    }
    const total = obj(info['total_token_usage']);
    if (total !== undefined) {
      burn = {
        prompt: Number(total['input_tokens'] ?? 0),
        output: Number(total['output_tokens'] ?? 0),
      };
    }
  }

  let reasoningDropped = 0;
  for (const r of own) {
    if (r.type === 'response_item' && str(r.payload['type']) === 'reasoning') reasoningDropped += 1;
    if (
      r.type === 'event_msg' &&
      str(r.payload['type']) === 'item_completed' &&
      str(obj(r.payload['item'])?.['type']) === 'Reasoning'
    ) {
      reasoningDropped += 1;
    }
  }

  const counters: CodexCounters = {
    malformedLines: 0,
    unknownRecordTypes: 0,
    reasoningDropped,
    inheritedRecordsDropped: all.length - own.length,
    payloadsTruncated,
    skippedResponseItemTypes: [],
  };

  const dialectFromMeta = str(payload['multi_agent_version']);
  const dialectFromTurn = own
    .filter((r) => r.type === 'turn_context')
    .map((r) => str(r.payload['multi_agent_version']))
    .find((v) => v !== null);
  const dialect = (dialectFromMeta ?? dialectFromTurn ?? null) as CodexThread['dialect'];

  return {
    threadSpawn: {
      present: spawn !== undefined,
      agentPath: opt<string>(spawn, 'agent_path'),
      agentNickname: opt<string>(spawn, 'agent_nickname'),
      agentRole: opt<string>(spawn, 'agent_role'),
      parentThreadId: opt<string>(spawn, 'parent_thread_id'),
      depth: opt<number>(spawn, 'depth'),
    },
    threadId: str(payload['id']) ?? '',
    sessionId: str(payload['session_id']) ?? '',
    owningFile: path.basename(file),
    cwd: str(payload['cwd']) ?? '',
    cliVersion: str(payload['cli_version']) ?? '',
    threadSource: str(payload['thread_source']) ?? '',
    originator: str(payload['originator']),
    dialect,
    dialectSource:
      dialectFromMeta !== null
        ? 'session_meta.multi_agent_version'
        : dialectFromTurn !== undefined && dialectFromTurn !== null
          ? 'turn_context.multi_agent_version'
          : null,
    multiAgentVersion: opt<string>(payload, 'multi_agent_version'),
    // THIS READER USED TO READ THE WRONG FIELD, AND THAT IS WHY 57 TESTS
    // STAYED GREEN THROUGH A DEFECT THAT EMPTIED EVERY v1 TREE.
    //
    // It read `spawn` — the NESTED `source.subagent.thread_spawn.agent_path` —
    // while `parse.ts` reads the TOP-LEVEL `payload.agent_path`. Two different
    // fields under one name. On a v1 subagent they disagree exactly:
    //
    //   payload.agent_path                              key ABSENT
    //   ...source.subagent.thread_spawn.agent_path      present, null
    //
    // So this file's `CodexThread`s never carried the absent case, the branch
    // that parks on it was unreachable from here, and every assertion below —
    // including the ones that DO check the tree — passed while production put
    // no v1 child in any tree at all.
    //
    // A second reader is evidence only while it models the same thing. When it
    // models a neighbouring field it is a second opinion about a different
    // question, delivered in the voice of the first.
    //
    // It now reads what `parse.ts` reads. `agentNickname` and `spawnDepth`
    // legitimately live on the spawn record and still come from `spawn`.
    agentPath: opt<string>(payload, 'agent_path'),
    agentNickname: opt<string>(spawn, 'agent_nickname'),
    parentThreadId: opt<string>(payload, 'parent_thread_id'),
    spawnDepth: opt<number>(spawn, 'depth'),
    subagentHistoryStartOrdinal: forkStartOpt,
    forkedFromId: opt<string>(payload, 'forked_from_id'),
    inheritedRecordsBeforeForkStart: all.length - own.length,
    ...(modelContextWindow === undefined ? {} : { modelContextWindow }),
    ...(contextNow === undefined ? {} : { contextNow }),
    ...(burn === undefined ? {} : { burn }),
    toolCalls,
    spawns,
    counters,
    records: own.length,
    // The `session_meta` record's OWN timestamp, not the file's mtime. On this
    // very corpus the baseline root's two differ by 40 seconds, and `mtimeMs`
    // is the LAST write - an end, not a start.
    startedAtMs: Date.parse(meta.timestamp),
    mtimeMs: Math.round(fs.statSync(file).mtimeMs),
  };
}

/** Every thread of one run directory. */
function readCorpusThreads(run: string): CodexThread[] {
  if (CORPUS === null) throw new Error('no codex corpus on disk');
  return transcriptFiles(path.join(CORPUS, run)).map(readThread);
}

/** Every thread of every run. */
function readWholeCorpus(): CodexThread[] {
  if (CORPUS === null) throw new Error('no codex corpus on disk');
  return runDirs(CORPUS).flatMap(readCorpusThreads);
}

function golden(): Record<string, unknown> {
  if (CORPUS === null) throw new Error('no codex corpus on disk');
  return JSON.parse(fs.readFileSync(path.join(CORPUS, 'golden.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

// ---------------------------------------------------------------------------
// Tree walkers
// ---------------------------------------------------------------------------

function isAgent(node: TreeNode): node is AgentNode {
  return 'children' in node;
}

function agentsOf(node: AgentNode): AgentNode[] {
  const out: AgentNode[] = [node];
  for (const child of node.children) if (isAgent(child)) out.push(...agentsOf(child));
  return out;
}

function toolsOf(node: AgentNode): ToolNode[] {
  const out: ToolNode[] = [];
  for (const child of node.children) {
    if (isAgent(child)) out.push(...toolsOf(child));
    else out.push(child);
  }
  return out;
}

function agentById(state: SessionState, id: string): AgentNode | undefined {
  return agentsOf(state.root).find((a) => a.id === id);
}

// ---------------------------------------------------------------------------
// Hand-built threads, for the branches no fixture reaches
// ---------------------------------------------------------------------------

const ABSENT: CodexOptional<never> = { present: false, value: null };

function makeThread(over: Partial<CodexThread> & { threadId: string; sessionId: string }): CodexThread {
  return {
    threadSpawn: {
      present: false,
      agentPath: ABSENT,
      agentNickname: ABSENT,
      agentRole: ABSENT,
      parentThreadId: ABSENT,
      depth: ABSENT,
    },
    owningFile: `rollout-${over.threadId}.jsonl`,
    cwd: 'C:/w',
    cliVersion: '0.151.0-alpha.7.2',
    threadSource: 'subagent',
    originator: 'codex_exec',
    dialect: 'v2',
    dialectSource: 'turn_context.multi_agent_version',
    multiAgentVersion: { present: true, value: 'v2' },
    agentPath: ABSENT,
    agentNickname: ABSENT,
    parentThreadId: ABSENT,
    spawnDepth: ABSENT,
    subagentHistoryStartOrdinal: ABSENT,
    forkedFromId: ABSENT,
    inheritedRecordsBeforeForkStart: 0,
    toolCalls: [],
    spawns: [],
    counters: {
      malformedLines: 0,
      unknownRecordTypes: 0,
      reasoningDropped: 0,
      inheritedRecordsDropped: 0,
      payloadsTruncated: 0,
      skippedResponseItemTypes: [],
    },
    records: 1,
    startedAtMs: 1_700_000_000_000,
    // Deliberately DIFFERENT from `startedAtMs`, and later, so any test that
    // reads a start and gets an end fails instead of passing on two equal
    // numbers. That equality is what made the old `mtimeMs` default invisible.
    mtimeMs: 1_700_000_555_000,
    ...over,
  };
}

function makeRoot(id: string, over: Partial<CodexThread> = {}): CodexThread {
  return makeThread({ threadId: id, sessionId: id, threadSource: 'user', ...over });
}

function makeSpawn(over: Partial<CodexSpawn> & { threadId: string; callId: string }): CodexSpawn {
  return {
    activityAgentPath: { present: false, value: null },
    activityAgentThreadId: null,
    file: 'rollout.jsonl',
    ordinal: 1,
    itemId: over.callId,
    namespace: { present: true, value: 'collaboration' },
    requestedTaskName: null,
    outputTaskName: null,
    outputAgentId: null,
    outputNickname: null,
    childThreadId: null,
    childResolvedBy: 'unresolved',
    refused: false,
    refusalText: null,
    messagePresent: true,
    messageEncrypted: true,
    messageBytes: 268,
    ...over,
  };
}

function makeCall(over: Partial<CodexToolCall> & { threadId: string; callId: string }): CodexToolCall {
  return {
    file: 'rollout.jsonl',
    ordinal: 1,
    kind: 'function_call',
    name: 'spawn_agent',
    namespace: { present: true, value: 'collaboration' },
    itemId: over.callId,
    itemType: 'SubAgentActivity',
    idRelation: 'item_id_equals_call_id',
    outputPreview: '{"task_name":"/root/x"}',
    outputTruncated: false,
    ...over,
  };
}

// ===========================================================================
// 0 — the corpus is there, and the reader agrees with an independent artefact
// ===========================================================================

describe('the corpus, and the reader that turns it into CodexThread[]', () => {
  it('finds a codex corpus on disk', () => {
    expect(CORPUS_DIRS.length).toBeGreaterThan(0);
    expect(CORPUS).not.toBeNull();
  });

  it('reads the thread, spawn and refusal counts golden.json independently records', () => {
    const threads = readWholeCorpus();
    const summary = golden()['summary'] as Record<string, number>;
    // `golden.json` is produced by `scripts/codex-golden.mjs`, which this file
    // does not import and shares no code with. These three numbers agreeing is
    // what makes the reader below evidence rather than a restatement.
    expect(threads.length).toBe(summary['threads']);
    expect(threads.flatMap((t) => t.spawns).length).toBe(summary['spawns']);
    expect(threads.flatMap((t) => t.spawns).filter((s) => s.refused).length).toBe(
      summary['spawns_refused'],
    );
  });

  it('grafts the whole corpus into one SessionState per root thread', () => {
    const threads = readWholeCorpus();
    const result = graftCodexThreads({ threads });
    const roots = threads.filter((t) => t.threadId === t.sessionId);
    expect(roots.length).toBeGreaterThan(0);
    expect(result.sessions.map((s) => s.sessionId).sort()).toStrictEqual(
      roots.map((t) => t.threadId).sort(),
    );
    expect(result.sessionsWithoutRootThread).toStrictEqual([]);
    expect(result.rootIdentityDisagreements).toStrictEqual([]);
  });

  it('tags every session codex (spec C11)', () => {
    const result = graftCodexThreads({ threads: readWholeCorpus() });
    for (const state of result.sessions) expect(state.engine).toBe('codex');
    expect(result.sessions.every((s) => s.schemaOk)).toBe(true);
  });

  it('leaves no thread both ungrafted and unparked', () => {
    const threads = readWholeCorpus();
    const result = graftCodexThreads({ threads });
    const accounted = new Set<string>();
    for (const state of result.sessions) {
      for (const agent of agentsOf(state.root)) {
        accounted.add(agent.id === 'root' ? state.sessionId : agent.id);
      }
      for (const parked of state.parked ?? []) accounted.add(parked.agentId);
    }
    expect([...threads.map((t) => t.threadId)].filter((id) => !accounted.has(id))).toStrictEqual([]);
  });
});

// ===========================================================================
// 1 — the two-key join (DoD 2.4, spec C4 / C4a)
// ===========================================================================

describe('the v2 join: output.task_name <-> child agent_path', () => {
  it('grafts every v2 child onto the call that spawned it', () => {
    const threads = readCorpusThreads('spawn-shapes');
    const result = graftCodexThreads({ threads });
    const state = result.sessions[0];
    expect(state).toBeDefined();
    if (state === undefined) return;

    const byName = new Map(agentsOf(state.root).map((a) => [a.label, a]));
    // The names come from the corpus's own agent_paths, not from a list here.
    const paths = threads
      .map((t) => (typeof t.agentPath.value === 'string' ? t.agentPath.value : null))
      .filter((p): p is string => p !== null);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(byName.has(agentPathLeaf(p))).toBe(true);

    const joins = result.spawnJoins.filter((j) => j.childThreadId !== null);
    expect(joins.length).toBe(paths.length);
    for (const join of joins) {
      expect(join.resolvedBy).toBe('output_task_name_equals_agent_path');
    }
  });

  it('names the spawning call_id on every SpawnEdge', () => {
    const threads = readCorpusThreads('spawn-shapes');
    const result = graftCodexThreads({ threads });
    const state = result.sessions[0];
    if (state === undefined) throw new Error('no session');
    const callIds = new Set(threads.flatMap((t) => t.spawns).map((s) => s.callId));
    expect(state.spawnEdges?.length).toBeGreaterThan(0);
    for (const edge of state.spawnEdges ?? []) {
      expect(callIds.has(edge.toolUseId)).toBe(true);
      // The edge names a node that is really in the tree.
      expect(agentById(state, edge.agentId)).toBeDefined();
    }
  });
});

describe('the v1 join: output.agent_id <-> child thread id', () => {
  /*
   * THE RULING THAT WAS REVERSED ON CORRECTED EVIDENCE.
   *
   * An earlier decision parked the whole `v1` dialect with no filament, on the
   * premise that a `v1` child "cannot be grafted - there is no `task_name` to
   * join on". `task_name` is absent; the join is not. Spec C4a calls the id
   * join the STRONGER of the two, "because a name is not an identity".
   *
   * These tests exist so that ruling cannot come back by accident.
   */
  it('has a child whose TOP-LEVEL agent_path key is absent, and no task_name', () => {
    const threads = readCorpusThreads('resume-twice-v1');
    const child = threads.find((t) => t.threadSource === 'subagent');
    expect(child).toBeDefined();
    if (child === undefined) return;
    // ABSENT. This assertion said `present === true` until 2026-09-03, and it
    // was measuring the reader's own mistake rather than the corpus: it read
    // the nested `thread_spawn.agent_path` (present, null) where production
    // reads the top-level key (absent). The corpus is the authority and it
    // says absent, so the graft must not treat absence as unjoinable.
    expect(child.agentPath.present).toBe(false);
    expect(child.agentPath.value).toBeNull();
    expect(threads.flatMap((t) => t.spawns).every((s) => s.requestedTaskName === null)).toBe(true);
  });

  it('grafts the v1 child onto its spawning call by id', () => {
    const threads = readCorpusThreads('resume-twice-v1');
    const result = graftCodexThreads({ threads });
    const state = result.sessions[0];
    expect(state).toBeDefined();
    if (state === undefined) return;

    const child = threads.find((t) => t.threadSource === 'subagent');
    if (child === undefined) throw new Error('no v1 subagent');

    const join = result.spawnJoins.find((j) => j.childThreadId === child.threadId);
    expect(join).toBeDefined();
    expect(join?.resolvedBy).toBe('output_agent_id_equals_thread_id');

    // In the tree, with a filament, and NOT parked.
    expect(agentById(state, child.threadId)).toBeDefined();
    expect(state.parked ?? []).toStrictEqual([]);
    const edge = (state.spawnEdges ?? []).find((e) => e.agentId === child.threadId);
    expect(edge).toBeDefined();
    const spawn = threads.flatMap((t) => t.spawns).find((s) => s.outputAgentId === child.threadId);
    expect(spawn).toBeDefined();
    expect(edge?.toolUseId).toBe(spawn?.callId);
  });

  it('labels the v1 node by nickname, which is correct and not a defect', () => {
    const threads = readCorpusThreads('resume-twice-v1');
    const result = graftCodexThreads({ threads });
    const state = result.sessions[0];
    if (state === undefined) throw new Error('no session');
    const child = threads.find((t) => t.threadSource === 'subagent');
    if (child === undefined) throw new Error('no v1 subagent');
    const node = agentById(state, child.threadId);
    expect(node?.label).toBe(child.agentNickname.value);
    expect(node?.label).not.toBe(child.threadId);
  });
});

// ===========================================================================
// 1c — THE OUTCOME, over the whole corpus (DoD 2.4)
// ===========================================================================

describe('every subagent in the corpus reaches a tree or a park, by outcome', () => {
  /*
   * WHY THIS BLOCK EXISTS, AND WHAT IT WOULD HAVE CAUGHT.
   *
   * On 2026-09-03 the grafter parked EVERY v1 subagent and put none of them in
   * any tree, and this file passed 57 of 57 both before and after that defect
   * was fixed. Not one test changed state.
   *
   * The reason was not that the assertions were join-only — the v1 block above
   * already checked `agentById` and `parked`. It was that this file's own
   * reader built `agentPath` from the NESTED `thread_spawn.agent_path` while
   * `parse.ts` builds it from the TOP-LEVEL `payload.agent_path`. Those
   * disagree exactly on a v1 subagent — present-and-null against absent — so
   * the input that triggers the defect was never constructed here.
   *
   * A second reader is evidence only while it models the same field. This
   * block is therefore written to be reader-agnostic where it can be: it
   * asserts a TOTAL over the corpus, so a thread that goes missing is caught
   * even if the reason it went missing is one nobody predicted.
   */

  it('accounts for every subagent: in a tree, or parked with a code, never neither', () => {
    const threads = readWholeCorpus();
    const subagents = threads.filter((t) => t.threadSource === 'subagent');
    expect(subagents.length).toBeGreaterThan(0);

    const result = graftCodexThreads({ threads });
    const inTree = new Set<string>();
    const parked = new Set<string>();
    for (const state of result.sessions) {
      for (const node of agentsOf(state.root as AgentNode)) inTree.add(node.id);
      inTree.add((state.root as AgentNode).id);
      for (const p of state.parked ?? []) parked.add(p.agentId);
    }

    const missing = subagents
      .map((t) => t.threadId)
      .filter((id) => !inTree.has(id) && !parked.has(id));
    expect(missing).toStrictEqual([]);

    // And never both, which would mean the tree and the refusal disagree.
    const both = subagents.map((t) => t.threadId).filter((id) => inTree.has(id) && parked.has(id));
    expect(both).toStrictEqual([]);
  });

  it('puts EVERY v1 subagent in a tree, and parks none of them', () => {
    const threads = readWholeCorpus();
    const v1Subagents = threads.filter((t) => t.threadSource === 'subagent' && t.dialect === 'v1');

    // Non-vacuity: the corpus must actually contain the population this
    // asserts about, or the empty list below proves nothing. If a later
    // harvest drops the v1 runs, this line fails rather than the test
    // silently becoming an assertion about nothing.
    expect(v1Subagents.length).toBeGreaterThan(0);

    const result = graftCodexThreads({ threads });
    const inTree = new Set<string>();
    const parkedBy = new Map<string, string>();
    for (const state of result.sessions) {
      for (const node of agentsOf(state.root as AgentNode)) inTree.add(node.id);
      for (const p of state.parked ?? []) parkedBy.set(p.agentId, p.code);
    }

    const parkedV1 = v1Subagents
      .map((t) => t.threadId)
      .filter((id) => parkedBy.has(id))
      .map((id) => `${id}:${parkedBy.get(id) ?? '?'}`);
    expect(parkedV1).toStrictEqual([]);

    const absent = v1Subagents.map((t) => t.threadId).filter((id) => !inTree.has(id));
    expect(absent).toStrictEqual([]);
  });

  it('gives every v1 subagent a filament and a nickname label, not an id', () => {
    const threads = readWholeCorpus();
    const v1Subagents = threads.filter((t) => t.threadSource === 'subagent' && t.dialect === 'v1');
    expect(v1Subagents.length).toBeGreaterThan(0);

    const result = graftCodexThreads({ threads });
    for (const child of v1Subagents) {
      const state = result.sessions.find((s) => agentById(s, child.threadId) !== undefined);
      expect(state, `no session contains ${child.threadId}`).toBeDefined();
      if (state === undefined) continue;

      const edge = (state.spawnEdges ?? []).find((e) => e.agentId === child.threadId);
      expect(edge, `no spawn edge for ${child.threadId}`).toBeDefined();

      const node = agentById(state, child.threadId);
      expect(node?.label).toBe(child.agentNickname.value);
      expect(node?.label).not.toBe(child.threadId);
    }
  });
});

// ===========================================================================
// 2 — the park codes (DoD 2.4)
// ===========================================================================

describe('the tripwires fire zero times on the measured corpus', () => {
  /*
   * A tripwire that fires routinely is not a tripwire. `dialectV1` is the one
   * that matters: spec C4a says it "parks only a child carrying neither key,
   * which no observed session produces", and the earlier wrong ruling would
   * have made it fire on every `v1` child in the corpus. This assertion is what
   * would have caught it.
   */
  it('never parks dialectV1 anywhere in the corpus', () => {
    const result = graftCodexThreads({ threads: readWholeCorpus() });
    const codes = result.sessions.flatMap((s) => (s.parked ?? []).map((p) => p.code));
    expect(codes.filter((c) => c === 'dialectV1')).toStrictEqual([]);
  });

  it('never parks duplicateAgentPath anywhere in the corpus', () => {
    const result = graftCodexThreads({ threads: readWholeCorpus() });
    const codes = result.sessions.flatMap((s) => (s.parked ?? []).map((p) => p.code));
    expect(codes.filter((c) => c === 'duplicateAgentPath')).toStrictEqual([]);
  });

  it('parks nothing at all on the corpus', () => {
    // The vacuity guard on the two assertions above: they would both pass if
    // `parked` were never populated for any reason. This states the whole set.
    const result = graftCodexThreads({ threads: readWholeCorpus() });
    expect(result.sessions.flatMap((s) => s.parked ?? [])).toStrictEqual([]);
    expect(result.spawnsOrphaned).toBe(0);
    expect(result.agentsWithoutSpawnEdge).toBe(0);
  });
});

describe('each park code fires on a constructed input, with the exact code', () => {
  it('dialectV1: a subagent carrying neither join key', () => {
    const root = makeRoot('r');
    const child = makeThread({
      threadId: 'c',
      sessionId: 'r',
      // Present-and-null, as `v1` writes it: so no name key...
      agentPath: { present: true, value: null },
      // ...and no spawn anywhere names its id, so no id key either.
      parentThreadId: { present: true, value: 'r' },
      agentNickname: { present: true, value: 'Arendt' },
    });
    const result = graftCodexThreads({ threads: [root, child] });
    const parked = result.sessions[0]?.parked ?? [];
    expect(parked.map((p) => p.code)).toStrictEqual(['dialectV1']);
    expect(parked[0]?.agentId).toBe('c');
    expect(parked[0]?.reason).toBe(CODEX_PARK_REASONS.dialectV1);
  });

  it('dialectV1 does NOT fire once a spawn names the same child by id', () => {
    // The control for the test above: the ONLY difference is the id key
    // arriving. If `dialectV1` fired here it would be the routine v1 state,
    // which is exactly the reversed ruling.
    const spawn = makeSpawn({ threadId: 'r', callId: 'call_1', outputAgentId: 'c' });
    const root = makeRoot('r', {
      spawns: [spawn],
      toolCalls: [makeCall({ threadId: 'r', callId: 'call_1' })],
    });
    const child = makeThread({
      threadId: 'c',
      sessionId: 'r',
      agentPath: { present: true, value: null },
      parentThreadId: { present: true, value: 'r' },
      agentNickname: { present: true, value: 'Arendt' },
    });
    const result = graftCodexThreads({ threads: [root, child] });
    expect(result.sessions[0]?.parked ?? []).toStrictEqual([]);
    expect(agentById(result.sessions[0] as SessionState, 'c')).toBeDefined();
  });

  it('noAgentPath: the agent_path KEY is absent, not null', () => {
    const root = makeRoot('r');
    const child = makeThread({
      threadId: 'c',
      sessionId: 'r',
      agentPath: ABSENT,
      parentThreadId: { present: true, value: 'r' },
    });
    const result = graftCodexThreads({ threads: [root, child] });
    const parked = result.sessions[0]?.parked ?? [];
    expect(parked.map((p) => p.code)).toStrictEqual(['noAgentPath']);
    expect(parked[0]?.reason).toBe(CODEX_PARK_REASONS.noAgentPath);
  });

  it('orphanSpawn: a spawn output naming a child no thread carries', () => {
    const spawn = makeSpawn({
      threadId: 'r',
      callId: 'call_1',
      outputTaskName: '/root/ghost',
      requestedTaskName: 'ghost',
    });
    const root = makeRoot('r', {
      spawns: [spawn],
      toolCalls: [makeCall({ threadId: 'r', callId: 'call_1' })],
    });
    const result = graftCodexThreads({ threads: [root] });
    const parked = result.sessions[0]?.parked ?? [];
    expect(parked.map((p) => p.code)).toStrictEqual(['orphanSpawn']);
    // Keyed on the NAME the spawn used: there is no thread id to key on, which
    // is the entire content of the case.
    expect(parked[0]?.agentId).toBe('/root/ghost');
    expect(parked[0]?.toolUseId).toBe('call_1');
    expect(result.spawnsOrphaned).toBe(1);
    // The call still renders: it happened and the user saw it.
    expect(toolsOf((result.sessions[0] as SessionState).root).map((t) => t.id)).toStrictEqual([
      'call_1',
    ]);
  });

  it('parentAgentMissing: a subagent whose parent_thread_id names no thread', () => {
    // Was `orphanSpawn` until the review. `orphanSpawn` is the SPAWN side - the
    // engine named a child we cannot find - and this is the child side, where
    // we have the child and cannot find its parent. Two codes because a user
    // reading the wrong one goes looking at the wrong end of the data.
    const root = makeRoot('r');
    const child = makeThread({
      threadId: 'c',
      sessionId: 'r',
      agentPath: { present: true, value: '/root/x' },
      parentThreadId: { present: true, value: 'nobody' },
    });
    const result = graftCodexThreads({ threads: [root, child] });
    const parked = result.sessions[0]?.parked ?? [];
    expect(parked.map((p) => p.code)).toStrictEqual(['parentAgentMissing']);
    expect(parked[0]?.agentId).toBe('c');
    expect(parked[0]?.parentAgentId).toBe('nobody');
    expect(parked[0]?.reason).toBe(CODEX_PARK_REASONS.parentAgentMissing);
    // And it is NOT the spawn-side code.
    expect(parked[0]?.code).not.toBe('orphanSpawn');
  });

  it('parentAgentMissing: a subagent with no parent_thread_id key at all', () => {
    const root = makeRoot('r');
    const child = makeThread({
      threadId: 'c',
      sessionId: 'r',
      agentPath: { present: true, value: '/root/x' },
      parentThreadId: ABSENT,
    });
    const result = graftCodexThreads({ threads: [root, child] });
    const parked = result.sessions[0]?.parked ?? [];
    expect(parked.map((p) => p.code)).toStrictEqual(['parentAgentMissing']);
    // No `parentAgentId` key: there was no parent id to quote. An empty string
    // would claim a key was read and found blank.
    expect(Object.prototype.hasOwnProperty.call(parked[0], 'parentAgentId')).toBe(false);
  });

  it('parentNotGrafted: a subagent whose own parent parked', () => {
    // A three-level chain whose MIDDLE link parks. The grandchild is otherwise
    // perfectly well formed - it has a path, a parent that exists and was read,
    // and a fork boundary - so without this code it would be reachable from
    // neither the tree nor `parked`: a silently dropped agent, which is the
    // failure the whole park vocabulary exists to make visible.
    const root = makeRoot('r');
    const middle = makeThread({
      threadId: 'm',
      sessionId: 'r',
      // Parks as `noAgentPath`: the KEY is absent.
      agentPath: ABSENT,
      parentThreadId: { present: true, value: 'r' },
    });
    const grandchild = makeThread({
      threadId: 'g',
      sessionId: 'r',
      agentPath: { present: true, value: '/root/m/g' },
      parentThreadId: { present: true, value: 'm' },
    });
    const result = graftCodexThreads({ threads: [root, middle, grandchild] });
    const parked = result.sessions[0]?.parked ?? [];
    expect(parked.map((p) => p.code).sort()).toStrictEqual(['noAgentPath', 'parentNotGrafted']);
    const entry = parked.find((p) => p.agentId === 'g');
    expect(entry?.code).toBe('parentNotGrafted');
    expect(entry?.reason).toBe(CODEX_PARK_REASONS.parentNotGrafted);
    expect(entry?.parentAgentId).toBe('m');
    // Neither is in the tree, and the root still renders.
    expect(agentById(result.sessions[0] as SessionState, 'g')).toBeUndefined();
    expect(agentById(result.sessions[0] as SessionState, 'm')).toBeUndefined();
    expect(result.sessions[0]?.root.id).toBe('root');
  });

  it('duplicateAgentPath: two threads carrying one agent_path', () => {
    const root = makeRoot('r');
    const first = makeThread({
      threadId: 'c1',
      sessionId: 'r',
      agentPath: { present: true, value: '/root/dup' },
      parentThreadId: { present: true, value: 'r' },
    });
    const second = makeThread({
      threadId: 'c2',
      sessionId: 'r',
      agentPath: { present: true, value: '/root/dup' },
      parentThreadId: { present: true, value: 'r' },
    });
    const result = graftCodexThreads({ threads: [root, first, second] });
    const parked = result.sessions[0]?.parked ?? [];
    expect(parked.map((p) => p.code)).toStrictEqual(['duplicateAgentPath']);
    // First claim wins, later one parks.
    expect(parked[0]?.agentId).toBe('c2');
    expect(agentById(result.sessions[0] as SessionState, 'c1')).toBeDefined();
  });

  it('forkBoundaryMissing: the C5 pair is half-declared', () => {
    const root = makeRoot('r');
    const child = makeThread({
      threadId: 'c',
      sessionId: 'r',
      agentPath: { present: true, value: '/root/x' },
      parentThreadId: { present: true, value: 'r' },
      forkedFromId: { present: true, value: 'r' },
      // ...and no `subagent_history_start_ordinal`, so the boundary between
      // inherited records and this thread's own work cannot be applied.
      subagentHistoryStartOrdinal: ABSENT,
    });
    const result = graftCodexThreads({ threads: [root, child] });
    const parked = result.sessions[0]?.parked ?? [];
    expect(parked.map((p) => p.code)).toStrictEqual(['forkBoundaryMissing']);
    expect(parked[0]?.reason).toBe(CODEX_PARK_REASONS.forkBoundaryMissing);
  });

  it('forkBoundaryMissing does NOT fire when NEITHER key is present', () => {
    // Spec C5: a `fork_turns: "none"` spawn carries neither, and that is the
    // normal, silent case. It is also what every `v1` child in the corpus is.
    const spawn = makeSpawn({ threadId: 'r', callId: 'call_1', outputAgentId: 'c' });
    const root = makeRoot('r', {
      spawns: [spawn],
      toolCalls: [makeCall({ threadId: 'r', callId: 'call_1' })],
    });
    const child = makeThread({
      threadId: 'c',
      sessionId: 'r',
      agentPath: { present: true, value: null },
      agentNickname: { present: true, value: 'Arendt' },
      parentThreadId: { present: true, value: 'r' },
      forkedFromId: ABSENT,
      subagentHistoryStartOrdinal: ABSENT,
    });
    const result = graftCodexThreads({ threads: [root, child] });
    expect(result.sessions[0]?.parked ?? []).toStrictEqual([]);
  });
});

// ===========================================================================
// 3 — dup-names: a refused spawn is a FAILED CALL, never a park (DoD 2.4)
// ===========================================================================

describe('dup-names: one child, one refused spawn', () => {
  it('grafts exactly one child under the root and refuses the second spawn', () => {
    const threads = readCorpusThreads('dup-names');
    const result = graftCodexThreads({ threads });
    const state = result.sessions[0];
    expect(state).toBeDefined();
    if (state === undefined) return;

    // The root spawned twice and exactly one child attached to it.
    const rootChildren = state.root.children.filter(isAgent);
    expect(rootChildren.length).toBe(1);
    expect(rootChildren[0]?.label).toBe('dup');

    expect(result.spawnsRefused).toBe(1);
    // And the refusal is not counted as a join that failed.
    expect(result.spawnsOrphaned).toBe(0);
    expect(result.spawnsWithoutOutputKey).toBe(0);
  });

  it('renders the refused spawn as a failed CALL carrying the engine refusal', () => {
    const threads = readCorpusThreads('dup-names');
    const refused = threads.flatMap((t) => t.spawns).filter((s) => s.refused);
    expect(refused.length).toBe(1);
    const spawn = refused[0];
    if (spawn === undefined) throw new Error('no refused spawn');

    const result = graftCodexThreads({ threads });
    const state = result.sessions[0];
    if (state === undefined) throw new Error('no session');
    const node = toolsOf(state.root).find((t) => t.id === spawn.callId);
    expect(node).toBeDefined();
    expect(node?.status).toBe('error');
    // The refusal bytes are read out of the corpus, not written down here.
    expect(node?.resultPreview).toBe(spawn.refusalText);
    expect(spawn.refusalText).toContain('already exists');
  });

  it('produces NO parked node for the refused spawn, and none at all', () => {
    // Asserted as an ABSENCE on purpose: a missing park is the thing that would
    // silently pass. DoD 2.4 - "rendered as a failed call, not a parked node".
    const threads = readCorpusThreads('dup-names');
    const result = graftCodexThreads({ threads });
    const state = result.sessions[0];
    if (state === undefined) throw new Error('no session');
    const refusedCallId = threads.flatMap((t) => t.spawns).find((s) => s.refused)?.callId;
    expect(refusedCallId).toBeDefined();
    expect((state.parked ?? []).filter((p) => p.toolUseId === refusedCallId)).toStrictEqual([]);
    expect(state.parked ?? []).toStrictEqual([]);
    // And no filament either: a declined call spawned nothing.
    expect((state.spawnEdges ?? []).some((e) => e.toolUseId === refusedCallId)).toBe(false);
  });

  it('records the refused spawn as REFUSED in the join, naming no child', () => {
    // `refused` is a RESOLUTION, not an unresolved join: the engine answered
    // the call by declining it. The golden's distribution over this corpus is
    // 8 / 1 / 1 / 0, so `unresolved` is the member that fires zero times.
    const threads = readCorpusThreads('dup-names');
    const result = graftCodexThreads({ threads });
    const refusedCallId = threads.flatMap((t) => t.spawns).find((s) => s.refused)?.callId;
    const join = result.spawnJoins.find((j) => j.callId === refusedCallId);
    expect(join).toBeDefined();
    expect(join?.resolvedBy).toBe('refused');
    expect(join?.childThreadId).toBeNull();
  });

  it('leaves the whole corpus with no unresolved join at all', () => {
    // The vacuity guard on the line above: `unresolved` reaching zero is only
    // evidence if something states the whole distribution. Every spawn in the
    // corpus is resolved by one of the two keys or refused.
    const result = graftCodexThreads({ threads: readWholeCorpus() });
    const byKind = new Map<string, number>();
    for (const join of result.spawnJoins) {
      byKind.set(join.resolvedBy, (byKind.get(join.resolvedBy) ?? 0) + 1);
    }
    expect(byKind.get('unresolved') ?? 0).toBe(0);
    expect(byKind.get('refused')).toBe(result.spawnsRefused);
    expect(result.spawnJoins.length).toBe(
      readWholeCorpus().flatMap((t) => t.spawns).length,
    );
  });
});

// ===========================================================================
// 4 — depth comes from the transcript (DoD 2.4)
// ===========================================================================

describe('depth is the transcript"s, not a recomputed one', () => {
  for (const run of ['dup-names', 'spawn-shapes']) {
    it(`${run}: every node reports its recorded spawn_depth`, () => {
      const threads = readCorpusThreads(run);
      const result = graftCodexThreads({ threads });
      const state = result.sessions[0];
      if (state === undefined) throw new Error('no session');

      const recorded = new Map(
        threads
          .filter((t) => t.spawnDepth.present)
          .map((t) => [t.threadId, t.spawnDepth.value as number]),
      );
      // The corpus has a depth-2 thread in both of these runs; derived, not
      // written down, so a re-harvest that loses it fails here rather than
      // passing on an empty map.
      expect([...recorded.values()]).toContain(2);

      for (const [threadId, depth] of recorded) {
        expect(agentById(state, threadId)?.spawnDepth).toBe(depth);
        const edge = (state.spawnEdges ?? []).find((e) => e.agentId === threadId);
        expect(edge?.depth).toBe(depth);
        expect(edge?.recordedDepth).toBe(depth);
      }
      expect(result.depthDisagreements).toStrictEqual([]);
    });
  }

  it('emits the RECORDED depth when it disagrees with the walked one, and says so', () => {
    const threads = readCorpusThreads('spawn-shapes');
    const deep = threads.find((t) => t.spawnDepth.value === 2);
    expect(deep).toBeDefined();
    if (deep === undefined) return;

    const mutated = threads.map((t) =>
      t.threadId === deep.threadId ? { ...t, spawnDepth: { present: true, value: 7 } } : t,
    );
    const result = graftCodexThreads({ threads: mutated });
    const state = result.sessions[0];
    if (state === undefined) throw new Error('no session');

    // The recorded value wins. A grafter that recomputed would say 2.
    expect(agentById(state, deep.threadId)?.spawnDepth).toBe(7);
    expect((state.spawnEdges ?? []).find((e) => e.agentId === deep.threadId)?.depth).toBe(7);
    // And the disagreement is RECORDED rather than silently resolved - kept
    // once, not once per visit.
    expect(result.depthDisagreements).toStrictEqual([
      { threadId: deep.threadId, recorded: 7, walked: 2 },
    ]);
  });
});

// ===========================================================================
// 5 — labels (DoD 2.3a, spec C7)
// ===========================================================================

describe('node labels: task_name first, agent_nickname second, never a raw id', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('renders no label anywhere in the corpus that is a bare thread uuid', () => {
    const threads = readWholeCorpus();
    const result = graftCodexThreads({ threads });
    const ids = new Set(threads.map((t) => t.threadId));
    const labels: string[] = [];
    for (const state of result.sessions) for (const a of agentsOf(state.root)) labels.push(a.label);

    // Walked, not spot-checked: every agent in every tree.
    expect(labels.length).toBeGreaterThan(threads.length - result.sessions.length);
    for (const label of labels) {
      expect(ids.has(label)).toBe(false);
      expect(UUID.test(label)).toBe(false);
      expect(label).not.toBe('');
    }
  });

  it('labels every root /root and every v2 child by its agent_path leaf', () => {
    const threads = readWholeCorpus();
    const result = graftCodexThreads({ threads });
    for (const state of result.sessions) expect(state.root.label).toBe(CODEX_ROOT_LABEL);

    for (const thread of threads) {
      const path = thread.agentPath.value;
      if (typeof path !== 'string') continue;
      const state = result.sessions.find((s) => s.sessionId === thread.sessionId);
      expect(agentById(state as SessionState, thread.threadId)?.label).toBe(agentPathLeaf(path));
    }
  });

  it('prefers task_name over agent_nickname when both exist', () => {
    const thread = makeThread({
      threadId: 'c',
      sessionId: 'r',
      agentPath: { present: true, value: '/root/outer/inner' },
      agentNickname: { present: true, value: 'Confucius' },
    });
    expect(codexNodeLabel(thread, false)).toBe('inner');
    // The order is what is under test, so the secondary is proved to be
    // reachable rather than assumed dead.
    expect(codexNodeLabel({ ...thread, agentPath: { present: true, value: null } }, false)).toBe(
      'Confucius',
    );
  });

  it('falls back to a constant, never an id, when a node has neither label', () => {
    const spawn = makeSpawn({ threadId: 'r', callId: 'call_1', outputAgentId: 'c' });
    const root = makeRoot('r', {
      spawns: [spawn],
      toolCalls: [makeCall({ threadId: 'r', callId: 'call_1' })],
    });
    const child = makeThread({
      threadId: 'c',
      sessionId: 'r',
      agentPath: { present: true, value: null },
      agentNickname: ABSENT,
      parentThreadId: { present: true, value: 'r' },
    });
    const result = graftCodexThreads({ threads: [root, child] });
    const node = agentById(result.sessions[0] as SessionState, 'c');
    expect(node?.label).toBe(CODEX_UNNAMED_LABEL);
    expect(node?.label).not.toBe('c');
  });

  it('takes the leaf of a hierarchical path', () => {
    expect(agentPathLeaf('/root/outer/inner')).toBe('inner');
    expect(agentPathLeaf('/root/dup')).toBe('dup');
    expect(agentPathLeaf('/root')).toBe('root');
  });
});

// ===========================================================================
// 6 — the ciphertext reaches nothing (DoD 2.3a, G4, spec C7)
// ===========================================================================

describe('the spawn arguments.message ciphertext reaches no label, node or field', () => {
  /** Every encrypted `spawn_agent` `arguments.message` in the corpus, with its file. */
  function ciphertexts(): { text: string; file: string }[] {
    if (CORPUS === null) return [];
    const out: { text: string; file: string }[] = [];
    for (const run of runDirs(CORPUS)) {
      for (const file of transcriptFiles(path.join(CORPUS, run))) {
        for (const r of records(file)) {
          if (r.type !== 'response_item') continue;
          if (str(r.payload['type']) !== 'function_call') continue;
          if (str(r.payload['name']) !== 'spawn_agent') continue;
          const args = obj(JSON.parse(str(r.payload['arguments']) ?? '{}') as unknown);
          const message = str(args?.['message']);
          if (message !== null && message.startsWith('gAAAA')) out.push({ text: message, file });
        }
      }
    }
    return out;
  }

  it('finds encrypted spawn messages in the corpus at all (the vacuity control)', () => {
    // A zero with no control is the shape that passes while measuring nothing.
    // This states what was looked at before the next test states that it is
    // absent from the output.
    const found = ciphertexts();
    expect(found.length).toBeGreaterThan(0);
    for (const { text, file } of found) {
      expect(fs.readFileSync(file, 'utf8')).toContain(text);
      expect(text.length).toBeGreaterThan(100);
    }
  });

  it('serialises every SessionState in the corpus without one byte of it', () => {
    const found = ciphertexts();
    const result = graftCodexThreads({ threads: readWholeCorpus() });
    const wire = JSON.stringify(result.sessions);
    expect(wire.length).toBeGreaterThan(1000);
    for (const { text } of found) expect(wire).not.toContain(text);
  });

  it('reaches no label and no node id, checked field by field', () => {
    const found = ciphertexts().map((c) => c.text);
    const result = graftCodexThreads({ threads: readWholeCorpus() });
    for (const state of result.sessions) {
      for (const agent of agentsOf(state.root)) {
        for (const text of found) {
          expect(agent.label).not.toBe(text);
          expect(agent.label.includes(text)).toBe(false);
          expect(agent.id).not.toBe(text);
        }
      }
      for (const tool of toolsOf(state.root)) {
        for (const text of found) {
          expect(tool.inputPreview.includes(text)).toBe(false);
          expect((tool.resultPreview ?? '').includes(text)).toBe(false);
        }
      }
    }
  });
});

// ===========================================================================
// 7 — the window (DoD 2.6, spec C8)
// ===========================================================================

describe('windowTokens', () => {
  it('is the transcript"s model_context_window when the transcript states one', () => {
    const threads = readWholeCorpus();
    const result = graftCodexThreads({ threads });
    let checked = 0;
    for (const state of result.sessions) {
      const root = threads.find((t) => t.threadId === state.sessionId);
      if (root?.modelContextWindow === undefined) continue;
      expect(state.windowTokens).toBe(root.modelContextWindow);
      expect(state.windowTokens).toBeGreaterThan(0);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('is ABSENT, and not 0, when the transcript states none', () => {
    const root = makeRoot('r');
    expect(root.modelContextWindow).toBeUndefined();
    const result = graftCodexThreads({ threads: [root] });
    const state = result.sessions[0];
    if (state === undefined) throw new Error('no session');
    // The KEY is omitted, not set to undefined and not set to 0. A 0 would
    // claim a model with no context at all, which is a wrong number rather
    // than a missing one.
    expect(Object.prototype.hasOwnProperty.call(state, 'windowTokens')).toBe(false);
    expect(state.windowTokens).toBeUndefined();
    expect(state.windowTokens).not.toBe(0);
    expect(JSON.stringify(state)).not.toContain('windowTokens');
  });

  it('reads the window from the ROOT thread, not from a subagent', () => {
    const spawn = makeSpawn({
      threadId: 'r',
      callId: 'call_1',
      outputTaskName: '/root/x',
      requestedTaskName: 'x',
    });
    const root = makeRoot('r', {
      spawns: [spawn],
      toolCalls: [makeCall({ threadId: 'r', callId: 'call_1' })],
      modelContextWindow: 258_400,
    });
    const child = makeThread({
      threadId: 'c',
      sessionId: 'r',
      agentPath: { present: true, value: '/root/x' },
      parentThreadId: { present: true, value: 'r' },
      modelContextWindow: 999,
    });
    const result = graftCodexThreads({ threads: [root, child] });
    expect(result.sessions[0]?.windowTokens).toBe(258_400);
  });
});

// ===========================================================================
// 8 — tokens
// ===========================================================================

describe('tokens', () => {
  it('takes contextNow from the root thread"s last_token_usage', () => {
    const threads = readWholeCorpus();
    const result = graftCodexThreads({ threads });
    let checked = 0;
    for (const state of result.sessions) {
      const root = threads.find((t) => t.threadId === state.sessionId);
      if (root?.contextNow === undefined) continue;
      expect(state.contextNow).toStrictEqual(root.contextNow);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('sums burn over the agents in the tree, parked agents contributing nothing', () => {
    const threads = readCorpusThreads('spawn-shapes');
    const result = graftCodexThreads({ threads });
    const state = result.sessions[0];
    if (state === undefined) throw new Error('no session');
    const expected = threads.reduce(
      (acc, t) => ({
        prompt: acc.prompt + (t.burn?.prompt ?? 0),
        output: acc.output + (t.burn?.output ?? 0),
      }),
      { prompt: 0, output: 0 },
    );
    expect(state.burn).toStrictEqual(expected);
    expect(state.parked ?? []).toStrictEqual([]);
  });

  it('leaves contextNow and burn ABSENT when no thread reports them, never 0', () => {
    const root = makeRoot('r');
    expect(root.contextNow).toBeUndefined();
    const result = graftCodexThreads({ threads: [root] });
    const state = result.sessions[0];
    if (state === undefined) throw new Error('no session');
    expect(Object.prototype.hasOwnProperty.call(state, 'contextNow')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(state, 'burn')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(state.root, 'contextNow')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(state.root, 'burn')).toBe(false);
    // `costUsd` 0 means NOT YET COMPUTED - there is no cost anywhere in a
    // Codex transcript and no price table in this repository.
    expect(state.totals).toStrictEqual({ costUsd: 0 });
  });

  it('carries each agent"s own contextNow onto its own node", not the session"s', () => {
    const threads = readCorpusThreads('baseline');
    const result = graftCodexThreads({ threads });
    const state = result.sessions[0];
    if (state === undefined) throw new Error('no session');
    const child = threads.find((t) => t.threadSource === 'subagent');
    if (child === undefined) throw new Error('no subagent');
    expect(agentById(state, child.threadId)?.contextNow).toStrictEqual(child.contextNow);
    expect(state.contextNow).not.toStrictEqual(child.contextNow);
  });
});

// ===========================================================================
// 9 — tool nodes and the injected seams
// ===========================================================================

describe('tool nodes', () => {
  it('keys every tool node on call_id and renders every call in the thread', () => {
    const threads = readWholeCorpus();
    const result = graftCodexThreads({ threads });
    const rendered = new Set(result.sessions.flatMap((s) => toolsOf(s.root)).map((t) => t.id));
    const expected = new Set(threads.flatMap((t) => t.toolCalls).map((c) => c.callId));
    expect(rendered).toStrictEqual(expected);
    expect(expected.size).toBeGreaterThan(0);
  });

  it('orders a thread"s tool nodes by transcript ordinal', () => {
    const threads = readCorpusThreads('spawn-shapes');
    const result = graftCodexThreads({ threads });
    const state = result.sessions[0];
    if (state === undefined) throw new Error('no session');
    const rootCalls = threads
      .filter((t) => t.threadId === state.sessionId)
      .flatMap((t) => [...t.toolCalls].sort((a, b) => a.ordinal - b.ordinal))
      .map((c) => c.callId);
    const rootToolIds = state.root.children.filter((n) => !isAgent(n)).map((n) => n.id);
    expect(rootToolIds).toStrictEqual(rootCalls);
  });

  it('marks a call with no output record as running, and one with an output as done', () => {
    const root = makeRoot('r', {
      toolCalls: [
        makeCall({ threadId: 'r', callId: 'call_done', name: 'exec', outputPreview: 'ok' }),
        makeCall({ threadId: 'r', callId: 'call_open', name: 'exec', ordinal: 2 }),
      ],
    });
    // The second call has no `outputPreview` key at all.
    const open = { ...(root.toolCalls[1] as CodexToolCall) };
    delete (open as { outputPreview?: string }).outputPreview;
    const result = graftCodexThreads({
      threads: [{ ...root, toolCalls: [root.toolCalls[0] as CodexToolCall, open] }],
    });
    const state = result.sessions[0];
    if (state === undefined) throw new Error('no session');
    const tools = new Map(toolsOf(state.root).map((t) => [t.id, t]));
    expect(tools.get('call_done')?.status).toBe('done');
    expect(tools.get('call_open')?.status).toBe('running');
    expect(state.root.status).toBe('running');
  });

  it('carries the engine"s own truncation claim verbatim, including false', () => {
    const root = makeRoot('r', {
      toolCalls: [
        makeCall({ threadId: 'r', callId: 'a', name: 'exec', outputTruncated: true }),
        makeCall({ threadId: 'r', callId: 'b', name: 'exec', ordinal: 2, outputTruncated: false }),
      ],
    });
    const result = graftCodexThreads({ threads: [root] });
    const tools = new Map(
      toolsOf((result.sessions[0] as SessionState).root).map((t) => [t.id, t]),
    );
    expect(tools.get('a')?.truncated).toBe(true);
    expect(tools.get('b')?.truncated).toBe(false);
  });
});

describe('the injected seams', () => {
  it('uses the four defaults when no options are passed', () => {
    const result = graftCodexThreads({ threads: [makeRoot('r')] });
    const state = result.sessions[0];
    if (state === undefined) throw new Error('no session');
    expect(state.liveness).toBe('idle');
    expect(state.workspaceMatch).toBe(true);
    expect(state.projectSlug).toBe('');
  });

  it('takes startedAt from startedAtMs, never from mtimeMs', () => {
    // There is no `startedAtFor` seam and there used to be, defaulting to
    // `mtimeMs` - the last write, i.e. an END used as a START. The two are
    // deliberately different numbers on every hand-built thread so this cannot
    // pass by coincidence.
    const root = makeRoot('r');
    expect(root.startedAtMs).not.toBe(root.mtimeMs);
    const result = graftCodexThreads({ threads: [root] });
    const state = result.sessions[0];
    if (state === undefined) throw new Error('no session');
    expect(state.root.startedAt).toBe(root.startedAtMs);
    expect(state.root.startedAt).not.toBe(root.mtimeMs);
    // `endedAt` IS the mtime: for a thread that is not running, the last write
    // is when it stopped changing.
    expect(state.root.endedAt).toBe(root.mtimeMs);
  });

  it('reads every corpus thread"s start from its session_meta, before its mtime', () => {
    const threads = readWholeCorpus();
    const result = graftCodexThreads({ threads });
    let checked = 0;
    for (const state of result.sessions) {
      for (const agent of agentsOf(state.root)) {
        const id = agent.id === 'root' ? state.sessionId : agent.id;
        const thread = threads.find((t) => t.threadId === id);
        if (thread === undefined) continue;
        expect(agent.startedAt).toBe(thread.startedAtMs);
        // Real transcripts: the start precedes the last write.
        expect(thread.startedAtMs).toBeLessThan(thread.mtimeMs);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('honours every override', () => {
    const result = graftCodexThreads({
      threads: [makeRoot('r')],
      options: {
        livenessFor: () => 'live',
        workspaceMatch: () => false,
        projectSlug: () => 'c--w',
      },
    });
    const state = result.sessions[0];
    if (state === undefined) throw new Error('no session');
    expect(state.liveness).toBe('live');
    expect(state.workspaceMatch).toBe(false);
    expect(state.projectSlug).toBe('c--w');
  });

  it('never throws on a thread set with nothing joinable in it', () => {
    // G3: a refusal is carried, never thrown. There is no root here at all.
    const orphan = makeThread({ threadId: 'c', sessionId: 'gone' });
    expect(() => graftCodexThreads({ threads: [orphan] })).not.toThrow();
    const result = graftCodexThreads({ threads: [orphan] });
    expect(result.sessions).toStrictEqual([]);
    expect(result.sessionsWithoutRootThread).toStrictEqual(['gone']);
  });

  it('sums the per-thread counters across the corpus', () => {
    const threads = readWholeCorpus();
    const result = graftCodexThreads({ threads });
    const expected = threads.reduce(
      (acc, t) => ({
        malformedLines: acc.malformedLines + t.counters.malformedLines,
        unknownRecordTypes: acc.unknownRecordTypes + t.counters.unknownRecordTypes,
        reasoningDropped: acc.reasoningDropped + t.counters.reasoningDropped,
        inheritedRecordsDropped:
          acc.inheritedRecordsDropped + t.counters.inheritedRecordsDropped,
        payloadsTruncated: acc.payloadsTruncated + t.counters.payloadsTruncated,
        // NOT summed: a census of distinct type names, unioned and sorted.
        // Adding lengths would report "9 kinds skipped" for one kind seen in
        // nine threads.
        skippedResponseItemTypes: [
          ...new Set([...acc.skippedResponseItemTypes, ...t.counters.skippedResponseItemTypes]),
        ].sort(),
      }),
      {
        malformedLines: 0,
        unknownRecordTypes: 0,
        reasoningDropped: 0,
        inheritedRecordsDropped: 0,
        payloadsTruncated: 0,
        skippedResponseItemTypes: [] as readonly string[],
      },
    );
    expect(result.counters).toStrictEqual(expected);
    expect(result.counters.inheritedRecordsDropped).toBeGreaterThan(0);
  });

  it('UNIONS the skipped response-item census instead of summing it', () => {
    // No thread in the corpus skips a response-item type, so this branch has no
    // fixture at all and is proved on hand-built threads. It is the only member
    // of `CodexCounters` that is not a number, and adding lengths would report
    // "3 kinds skipped" for one kind seen in three threads - a wrong number
    // rather than a missing one.
    const mk = (id: string, types: string[]): CodexThread =>
      makeRoot(id, {
        counters: {
          malformedLines: 0,
          unknownRecordTypes: 0,
          reasoningDropped: 0,
          inheritedRecordsDropped: 0,
          payloadsTruncated: 0,
          skippedResponseItemTypes: types,
        },
      });
    const result = graftCodexThreads({
      threads: [mk('a', ['web_search_call']), mk('b', ['web_search_call']), mk('c', ['mcp_call'])],
    });
    // Two threads saw the same type and one saw another: two DISTINCT kinds,
    // not three occurrences. Sorted, so the answer does not depend on the order
    // the threads arrived in.
    expect(result.counters.skippedResponseItemTypes).toStrictEqual([
      'mcp_call',
      'web_search_call',
    ]);
    expect(result.counters.skippedResponseItemTypes.length).not.toBe(3);
  });
});


// ===========================================================================
// 4b — END TO END, through `readCodexEngine` (the half this file did not have)
// ===========================================================================

/*
 * WHY THIS SECTION EXISTS, AND WHAT IT IS WORTH.
 *
 * Everything above builds `CodexThread[]` in this file and hands it to
 * `graftCodexThreads`. That proves the grafter against a contract. It cannot
 * prove the grafter against the PARSER, and the defect P6 found lived exactly
 * there: `parse.ts` reads the top-level `agent_path` and this file's reader read
 * the nested one, so the grafter was fed a different value in production than in
 * every test above. Every join assertion passed; every `v1` subagent parked.
 *
 * Two lessons, and the second is the general one:
 *
 *  - a test that builds its own input cannot see a seam in the input;
 *  - "the join resolved" is not "the node is in the tree". A node can be joined
 *    and then dropped one branch later, and every assertion about the join
 *    still passes. The question to ask of any assertion here is **would this
 *    still pass if the node were joined and then dropped?** Where the answer is
 *    yes, the assertion is measuring the join, not the outcome.
 */
describe('end to end through readCodexEngine: no v1 subagent is lost', () => {
  /** Every run directory, derived from the corpus. */
  const RUNS = CORPUS === null ? [] : runDirs(CORPUS);

  it('finds run directories to walk', () => {
    expect(RUNS.length).toBeGreaterThan(0);
  });

  /** `readCodexEngine` over one run's own `home/.codex`. */
  async function engineFor(run: string): Promise<{
    sessions: readonly SessionState[];
    threads: readonly CodexThread[];
  }> {
    if (CORPUS === null) throw new Error('no codex corpus on disk');
    const outcome = await readCodexEngine({ root: path.join(CORPUS, run, 'home', '.codex') });
    if (outcome.kind !== 'ok') throw new Error(`engine outcome ${outcome.kind} for ${run}`);
    return { sessions: outcome.result.sessions, threads: outcome.result.threads };
  }

  it('parks nothing and loses no subagent, in any run of the corpus', async () => {
    for (const run of RUNS) {
      const { sessions, threads } = await engineFor(run);
      const subagents = threads.filter((t) => t.threadSource === 'subagent');
      const inTree = new Set(
        sessions.flatMap((s) => agentsOf(s.root)).map((a) => a.id),
      );
      for (const sub of subagents) {
        expect(`${run}:${sub.threadId} in tree`).toBe(
          `${run}:${sub.threadId} ${inTree.has(sub.threadId) ? 'in tree' : 'PARKED OR LOST'}`,
        );
      }
      expect(sessions.flatMap((s) => s.parked ?? [])).toStrictEqual([]);
      // One filament per subagent: joined AND drawn.
      expect(sessions.flatMap((s) => s.spawnEdges ?? []).length).toBe(subagents.length);
    }
  });

  it('grafts every v1 subagent in the corpus and labels it by nickname', async () => {
    // Derived from the corpus, not named: a re-harvest that adds a v1 run is
    // covered, and one that removes them fails the floor below instead of
    // passing on an empty loop.
    let v1Subagents = 0;
    for (const run of RUNS) {
      const { sessions, threads } = await engineFor(run);
      for (const sub of threads) {
        if (sub.threadSource !== 'subagent') continue;
        if (sub.dialect !== 'v1') continue;
        v1Subagents += 1;

        // The shape that caused the defect, asserted so it cannot be re-read as
        // "present and null" by the next person: the TOP-LEVEL key is absent.
        expect(sub.agentPath.present).toBe(false);

        const state = sessions.find((s) => s.sessionId === sub.sessionId);
        expect(state).toBeDefined();
        if (state === undefined) continue;

        // (a) in the tree
        const node = agentsOf(state.root).find((a) => a.id === sub.threadId);
        expect(node).toBeDefined();
        // (b) labelled by agent_nickname (C7), never by an id
        expect(node?.label).toBe(sub.agentNickname.value);
        expect(node?.label).not.toBe(sub.threadId);
        // (c) drawing a filament
        expect((state.spawnEdges ?? []).some((e) => e.agentId === sub.threadId)).toBe(true);
        // (d) and NOT parked, by any code
        expect((state.parked ?? []).map((pk) => pk.agentId)).not.toContain(sub.threadId);
      }
    }
    expect(v1Subagents).toBeGreaterThan(0);
  });

  it('reproduces the reported resume-twice-v1 numbers exactly', async () => {
    // The bug report's own three lines: spawnEdges 0, parked 1 (noAgentPath),
    // labels ["/root"]. They must now read 1, 0, ["/root", "Arendt"].
    const { sessions, threads } = await engineFor('resume-twice-v1');
    expect(sessions.length).toBe(1);
    const state = sessions[0];
    if (state === undefined) throw new Error('no session');
    expect((state.spawnEdges ?? []).length).toBe(1);
    expect(state.parked ?? []).toStrictEqual([]);
    const labels = agentsOf(state.root).map((a) => a.label);
    const nickname = threads.find((t) => t.threadSource === 'subagent')?.agentNickname.value;
    expect(nickname).toBe('Arendt');
    expect(labels).toStrictEqual([CODEX_ROOT_LABEL, nickname]);
    // And the child's own tool calls came with it. A dropped subagent takes its
    // calls out of the tree too, which is the cheapest independent witness that
    // it is really there.
    const child = threads.find((t) => t.threadSource === 'subagent');
    expect(child?.toolCalls.length).toBeGreaterThan(0);
    const toolIds = new Set(toolsOf(state.root).map((n) => n.id));
    for (const call of child?.toolCalls ?? []) expect(toolIds.has(call.callId)).toBe(true);
  });

  it('agrees with parse.ts field by field, so this file cannot drift again', async () => {
    /*
     * THE GUARD FOR THE WHOLE CLASS.
     *
     * `readCorpusThreads` is a second reader of the same hand-off line, and it
     * disagreed with `parse.ts` about which `agent_path` feeds
     * `CodexThread.agentPath`. Nothing caught that, because both readers were
     * internally consistent — the recorded "two agreeing literals is not a
     * contract" defect, with the two literals being two readers.
     *
     * So the readers are compared directly on every field this module joins,
     * labels or parks on. A future divergence fails HERE, naming the field,
     * rather than three suites away as a wrong tree.
     */
    let compared = 0;
    for (const run of RUNS) {
      const { threads: production } = await engineFor(run);
      const mine = new Map(readCorpusThreads(run).map((t) => [t.threadId, t]));
      expect(production.length).toBeGreaterThan(0);
      for (const prod of production) {
        const ours = mine.get(prod.threadId);
        expect(ours).toBeDefined();
        if (ours === undefined) continue;
        compared += 1;
        const at = `${run}:${prod.threadId.slice(0, 8)}`;
        expect(`${at} agentPath ${JSON.stringify(ours.agentPath)}`).toBe(
          `${at} agentPath ${JSON.stringify(prod.agentPath)}`,
        );
        expect(`${at} agentNickname ${JSON.stringify(ours.agentNickname)}`).toBe(
          `${at} agentNickname ${JSON.stringify(prod.agentNickname)}`,
        );
        expect(`${at} parentThreadId ${JSON.stringify(ours.parentThreadId)}`).toBe(
          `${at} parentThreadId ${JSON.stringify(prod.parentThreadId)}`,
        );
        expect(`${at} spawnDepth ${JSON.stringify(ours.spawnDepth)}`).toBe(
          `${at} spawnDepth ${JSON.stringify(prod.spawnDepth)}`,
        );
        expect(`${at} sessionId ${ours.sessionId}`).toBe(`${at} sessionId ${prod.sessionId}`);
        expect(`${at} threadSource ${ours.threadSource}`).toBe(
          `${at} threadSource ${prod.threadSource}`,
        );
        expect(`${at} startedAtMs ${ours.startedAtMs}`).toBe(
          `${at} startedAtMs ${prod.startedAtMs}`,
        );
        expect(`${at} window ${String(ours.modelContextWindow)}`).toBe(
          `${at} window ${String(prod.modelContextWindow)}`,
        );
        expect(`${at} spawn callIds ${ours.spawns.map((s) => s.callId).sort().join(',')}`).toBe(
          `${at} spawn callIds ${prod.spawns.map((s) => s.callId).sort().join(',')}`,
        );
        expect(
          `${at} spawn keys ${ours.spawns.map((s) => `${String(s.outputTaskName)}/${String(s.outputAgentId)}/${String(s.refused)}`).sort().join(',')}`,
        ).toBe(
          `${at} spawn keys ${prod.spawns.map((s) => `${String(s.outputTaskName)}/${String(s.outputAgentId)}/${String(s.refused)}`).sort().join(',')}`,
        );
      }
    }
    expect(compared).toBeGreaterThan(0);
  });
});

