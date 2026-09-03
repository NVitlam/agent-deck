/**
 * PLAN.md v0.6.0 Phase 2 / DoD 2.7 — the golden reproduced THROUGH THE
 * PRODUCTION PATH, and the honest statement of what "the golden" can mean here.
 *
 * ===========================================================================
 * DoD 2.7 IS NOT EXECUTABLE AS WRITTEN, AND THIS FILE SAYS SO IN ASSERTIONS
 * ===========================================================================
 *
 * The DoD says the golden is reproduced "byte-exact through
 * `readCodexEngine()`". `fixtures/codex-<version>/golden.json` is a CORPUS-AUDIT
 * REPORT, not a projection of `SessionState`, and three classes of content live
 * in it. Only one of them is an engine's to state:
 *
 *   CLASS 1 — GENERATOR METADATA. `generator` is the literal string
 *     "scripts/codex-golden.mjs". `readCodexEngine()` is not that script and
 *     saying it is would bake a false statement into a passing test. So
 *     WHOLE-FILE byte-exactness is impossible, not merely hard.
 *
 *   CLASS 2 — HOOK-STREAM FACTS. The per-run `hook_join` and `liveness` blocks
 *     and `sizes.hook_stream_bytes` describe `hook-stream.jsonl`, which this
 *     engine does not read: `liveness.ts` is deliberately not chained (see
 *     `index.ts`), because it is a polling engine with an injected clock and
 *     that wiring is DoD 3.2's.
 *
 *   CLASS 3 — TRANSCRIPT FACTS. `threads`, `spawns`, `tool_calls`,
 *     `transcripts`, the redaction counts and the transcript half of `sizes`.
 *     These are the substance and they ARE derivable from the production path.
 *
 * A fourth reason to exclude appears once, and it is the one worth reading:
 *
 *   CLASS 4 — ON THE PATH, NOT ON THE HAND-OFF LINE. `types.ts` is frozen and
 *     `CodexEngineResult` carries `{sessions, threads, refused, counters,
 *     discovery}`. Some facts the engine genuinely computes — the spawn-to-child
 *     join's `child_resolved_by` most of all — live on `CodexGraftResult`, which
 *     `CodexEngineResult` does not carry. Recomputing them here would be a
 *     SECOND ENGINE, so they are excluded and the gap is named rather than
 *     papered over.
 *
 * ===========================================================================
 * WHAT IS BUILT INSTEAD, AND WHY IT IS AT LEAST AS STRONG
 * ===========================================================================
 *
 *   1. Every engine-derivable section is reproduced BYTE-EXACT after canonical
 *      JSON, through `readCodexEngine()` and nothing else. Measured:
 *      58,372 bytes of the golden's 89,474.
 *
 *   2. **The partition is pinned as an exact set, both ways, with the count
 *      beside it** — working-method rule 19, applied to a document instead of
 *      to an artifact. Every top-level key, every per-run key and every key of
 *      every nested object and array element is classified REPRODUCED or
 *      EXCLUDED; the two lists are asserted TOTAL and DISJOINT against the key
 *      set read off the golden itself. **A key that appears in a future golden
 *      and is in neither list FAILS**, and a vacuity control injects exactly
 *      that to prove the check can see it. Without that property,
 *      "we reproduce what we reproduce" is unfalsifiable.
 *
 *   3. Every exclusion carries its reason IN THE TEST, naming its class.
 *
 *   4. The partition is load-bearing rather than decorative, because the
 *      projection's OWN emitted key set is asserted equal to the REPRODUCED
 *      list at every level. Moving one key between the lists therefore turns
 *      this file red — mutation-tested, and recorded in the handoff.
 *
 * ===========================================================================
 * THE SERIALIZER BELOW IS A PROJECTION, NOT A SECOND ENGINE
 * ===========================================================================
 *
 * It turns the engine's output into the golden's on-disk shape: key order,
 * canonical JSON, the golden's own sort order for each array. It COMPUTES
 * NOTHING THE ENGINE COMPUTED — every value it writes came out of
 * `readCodexEngine()`, and the only operations applied to those values are
 * selection, sorting, de-duplication and counting. It never opens a transcript,
 * never parses a record and never reads a corpus byte.
 *
 * **`scripts/codex-golden.mjs` IS NOT IMPORTED HERE.** It is the independent
 * reference reader; importing it would make the two readers agree by
 * construction and the golden would stop being evidence. `src/opencode/**`
 * keeps the same distance from `scripts/opencode-golden.mjs` for the same
 * reason.
 *
 * ===========================================================================
 * TWO KNOWN DIVERGENCES BETWEEN ENGINE AND REFERENCE, BOTH ASSERTED
 * ===========================================================================
 *
 *   A. THE FINGERPRINT IS STRICTER ON DIALECT DISAGREEMENT. The generator falls
 *      through to the next source and labels the result `ambiguous(...)`;
 *      `fingerprint.ts` refuses with `dialectContradiction`, per spec C3a's
 *      "two sources disagreeing is an error, not a tiebreak". On the committed
 *      corpus the two AGREE on all 5 runs, so nothing rests on it today. The
 *      agreement is asserted rather than assumed.
 *
 *   B. THE GENERATOR APPLIES NO FORK BOUNDARY AND `parse.ts` DOES. They agree
 *      only because the corpus's inherited regions contain no tool calls. That
 *      is asserted here as a property of the engine's own output, so a later
 *      harvest putting a tool call in an inherited region shows up as this
 *      assertion failing — a LEGITIMATE divergence to be re-derived, not a
 *      regression to be reverted.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readCodexEngine } from './index.js';
import { readCodexHookStream } from './liveness.js';
import type {
  CodexEngineResult,
  CodexThread,
  CodexToolCall,
} from './types.js';

// ---------------------------------------------------------------------------
// The corpus, resolved at COLLECTION time
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURES = join(REPO_ROOT, 'fixtures');

/**
 * Corpora and runs resolved while vitest is COLLECTING, not in a hook.
 *
 * `describe.each` is evaluated at collection. A list populated in a `beforeAll`
 * is still empty at that moment, so every `.each` over it generates ZERO tests
 * — and a file that generates zero tests reports as a clean pass. This
 * repository has shipped that exact failure once.
 *
 * Sizes are never asserted (`CLAUDE.md`: "do not assert fixture-set sizes");
 * the list is derived from the directory and its non-emptiness is a test.
 */
function listCodexCorpora(): string[] {
  if (!existsSync(FIXTURES)) return [];
  return readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('codex-'))
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(FIXTURES, name, 'golden.json')))
    .sort();
}

/** A run is a directory of the corpus holding a `hook-stream.jsonl`. */
function listRuns(corpus: string): string[] {
  return readdirSync(join(FIXTURES, corpus), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(FIXTURES, corpus, name, 'hook-stream.jsonl')))
    .sort();
}

/** The Codex data root inside one run. Discovery walks down from here. */
function runRoot(corpus: string, run: string): string {
  return join(FIXTURES, corpus, run, 'home', '.codex');
}

const CORPORA = listCodexCorpora();

// ---------------------------------------------------------------------------
// THE PARTITION
// ---------------------------------------------------------------------------

interface Partition {
  /** Keys this file reproduces from `readCodexEngine()` output alone. */
  readonly reproduced: readonly string[];
  /** Keys this file does not reproduce, each with its class and its reason. */
  readonly excluded: Readonly<Record<string, string>>;
}

/**
 * Every level of the golden, classified. The path names are the assertion's
 * labels, so a failure says which object it was looking at.
 *
 * Three objects are NOT levels here and that is deliberate: `summary.dialects`,
 * `summary.dialect_sources` and `tool_call_summary.completed_items_claimed_by_
 * no_tool_call` are VALUE MAPS whose keys are data, not schema. The first two
 * are reproduced whole, by value, in the byte-exact comparison; the third is
 * excluded whole. Declaring them as levels would pin today's data as if it were
 * a shape.
 */
const PARTITION: Readonly<Record<string, Partition>> = {
  golden: {
    reproduced: ['anchor_cli_version', 'runs', 'summary'],
    excluded: {
      schema:
        'CLASS 1 generator metadata — "agent-deck/codex-golden@1" names the ' +
        "generator's output format, which is not a fact about a Codex root.",
      generator:
        'CLASS 1 generator metadata — the literal string "scripts/codex-golden.mjs". ' +
        'readCodexEngine() is not that script; claiming to be it would be a false ' +
        'statement baked into a passing test.',
      corpus:
        'CLASS 1 generator metadata — the fixture DIRECTORY name. It is the ' +
        'harness\u2019s own input (this file enumerates it to find the golden), never ' +
        'something the engine read out of a transcript.',
    },
  },

  'golden.runs[]': {
    reproduced: [
      'dialect',
      'dialect_evidence',
      'hook_join',
      'liveness',
      'dialect_source',
      'redaction',
      'sizes',
      'spawn_summary',
      'spawns',
      'thread_summary',
      'threads',
      'tool_call_summary',
      'tool_calls',
      'transcripts',
    ],
    excluded: {
      run:
        'CLASS 1 — the JOIN KEY. It is the run directory this file pointed the ' +
        'engine at, so reproducing it would be reading back our own argument. ' +
        'It is asserted separately: `discovery.root` lies under that directory.',
    },
  },

  'golden.runs[].dialect_evidence': {
    reproduced: ['session_meta_multi_agent_version', 'spawn_namespaces'],
    excluded: {
      turn_context_multi_agent_version:
        'CLASS 4 — the engine RESOLVES the dialect (C3a) and surfaces the winning ' +
        'source on CodexThread.dialectSource; it does not carry turn_context ' +
        'payloads. The resolution is reproduced; its raw input set is not.',
      models:
        'CLASS 4 — CodexThread carries no model field, deliberately: spec C8/C10 ' +
        'says the dialect is read from the SESSION, never from a model list, so ' +
        'the hand-off line gives the model nowhere to live.',
      exec_toolsets:
        "CLASS 4 — the generator's own corroboration label (\u201ccustom_tool_call:exec\u201d). " +
        'Building it here means re-implementing the generator\u2019s classification ' +
        'rule in the test, which is a second engine rather than a projection.',
    },
  },

  'golden.runs[].transcripts[]': {
    reproduced: ['bytes', 'file', 'malformed_lines', 'owning_thread_id', 'records'],
    excluded: {
      session_meta_count:
        'CLASS 4 — how many session_meta declarations a FILE carries. parse.ts ' +
        'uses that fact (owningDeclaration picks the lowest ordinal) and does not ' +
        'report the count; CodexThread.records is the file\u2019s record total.',
    },
  },

  'golden.runs[].threads[]': {
    reproduced: [
      'agent_nickname',
      'agent_path',
      'cli_version',
      'forked_from_id',
      'inherited_records_before_fork_start',
      'multi_agent_version',
      'originator',
      'owning_file',
      'parent_thread_id',
      'records_in_owning_file',
      'session_id',
      'spawn_depth',
      'spawn_present',
      'spawn_agent_path',
      'spawn_agent_nickname',
      'spawn_agent_role',
      'spawn_parent_thread_id',
      'subagent_history_start_ordinal',
      'thread_id',
      'thread_source',
    ],
    excluded: {
      history_mode:
        'CLASS 4 — session_meta.history_mode is not on CodexThread. The fork ' +
        'boundary reaches the hand-off line as subagent_history_start_ordinal ' +
        'and forked_from_id, both reproduced.',
      owning_declaration_ordinal:
        'CLASS 4 — not on CodexThread. It is 0 for every thread of this corpus ' +
        'by construction: fingerprint.ts refuses any transcript without a ' +
        'session_meta at ordinal 0, so the value could only ever be 0 or a refusal.',
      declarations_in_corpus_run:
        'CLASS 4 — a CROSS-FILE count (how many files re-serialise this thread\u2019s ' +
        'session_meta). parse.ts sees one file at a time and the hand-off line ' +
        'carries no cross-file census.',
      declared_in_files:
        'CLASS 4 — the same cross-file census, counted by distinct file.',
    },
  },

  'golden.runs[].thread_summary': {
    reproduced: [
      'agent_path_absent',
      'agent_path_present',
      'count',
      'max_depth',
      'spawn_agent_path_null',
      'subagent_threads',
      'user_threads',
    ],
    excluded: {
    },
  },

  'golden.runs[].tool_calls[]': {
    reproduced: [
      'call_id',
      'file',
      'id_relation',
      'item_id',
      'item_type',
      'kind',
      'name',
      'namespace',
      'ordinal',
      'thread_id',
    ],
    excluded: {},
  },

  'golden.runs[].tool_call_summary': {
    reproduced: ['by_id_relation', 'count'],
    excluded: {
      distinct_call_ids:
        'CLASS 4 — the generator counts distinct call_id over EVERY response_item, ' +
        'function_call_output records included. The engine surfaces the call ids of ' +
        'CALLS. The two numbers are equal on every run of this corpus (6/11/1/9/15), ' +
        'and that equality is a coincidence of every call having exactly one output ' +
        '\u2014 reproducing it would be answering a different question that happens to agree.',
      call_ids_that_are_also_item_ids:
        'CLASS 4 — the same all-response_item id set intersected with the set of ' +
        'every item_completed id. Equal to by_id_relation.item_id_equals_call_id on ' +
        'this corpus (2/7/1/8/13) for the same coincidental reason.',
      distinct_item_ids:
        'CLASS 4 — every item_completed id in the run. The engine surfaces only the ' +
        'items PAIRED to a call (CodexToolCall.itemId); unpaired ones stop at parse.ts.',
      completed_items_claimed_by_no_tool_call:
        'CLASS 4 — the unclaimed item census, by item type. Same reason: unpaired ' +
        'items do not reach the hand-off line.',
    },
  },

  'golden.runs[].spawns[]': {
    reproduced: [
      'activity_agent_path',
      'activity_agent_thread_id',
      'call_id',
      'child_resolved_by',
      'child_thread_id',
      'file',
      'item_id',
      'item_type',
      'message_bytes',
      'message_encrypted',
      'message_present',
      'namespace',
      'ordinal',
      'output_agent_id',
      'output_nickname',
      'output_present',
      'output_task_name',
      'refusal_text',
      'refused',
      'requested_task_name',
      'thread_id',
    ],
    excluded: {
      argument_keys:
        'CLASS 4 — the sorted key list of the spawn call\u2019s parsed `arguments`. ' +
        'parse.ts reads the three keys it needs (task_name, message) and does not ' +
        'carry the key set.',
    },
  },

  'golden.runs[].spawn_summary': {
    reproduced: ['count', 'refused', 'resolved_to_child', 'unresolved'],
    excluded: {
    },
  },

  'golden.runs[].redaction': {
    reproduced: ['spawn_messages_encrypted', 'spawn_messages_plaintext'],
    excluded: {
      reasoning_response_items:
        'CLASS 4 — the engine reports ONE number, CodexCounters.reasoningDropped, ' +
        'and it is this key PLUS reasoning_completed_items (measured: 3+3=6, ' +
        '11+11=22, 2+2=4, 11+11=22, 7+7=14). Splitting one counter into two would ' +
        'be inventing a number. The SUM is cross-checked in its own test.',
      reasoning_completed_items:
        'CLASS 4 — the other half of the same single counter. See above.',
      reasoning_with_non_empty_summary:
        'CLASS 4 — G4 drops reasoning records at the parse boundary, so nothing ' +
        'downstream can inspect their `summary` array. Not carrying it is the point.',
      ciphertext_sites:
        'CLASS 4 — the field paths where ciphertext was seen. parse.ts reports ' +
        'ciphertextStringsDropped on CodexParseResult; CodexCounters, and therefore ' +
        'CodexEngineResult.counters, carries no ciphertext field at all.',
      ciphertext_strings:
        'CLASS 4 — same: counted inside parse.ts, not carried to the boundary.',
      ciphertext_bytes:
        'CLASS 4 — same. The bytes are never copied anywhere by design (G4).',
      encrypted_bytes_copied_into_golden:
        'CLASS 1 generator metadata — 0 by construction, asserted by the ' +
        "generator's own assertNoLeakage. It is a claim about the GOLDEN FILE, " +
        'not about a Codex root.',
    },
  },

  'golden.runs[].sizes': {
    reproduced: ['hook_stream_bytes', 'transcript_bytes_total'],
    excluded: {
      longest_record_bytes:
        'CLASS 4 — per-RECORD byte sizes. The tailer measures bytes per FILE and ' +
        'parse.ts holds records as parsed objects; no per-record length survives to ' +
        'the hand-off line.',
      longest_record:
        'CLASS 4 — the file/ordinal/type of that record, same reason.',
    },
  },

  'golden.summary': {
    reproduced: [
      'agents_with_multiple_stops',
      'dialect_sources',
      'dialects',
      'hook_records',
      'hook_records_with_tool_use_id',
      'hook_resolves_call_id',
      'hook_resolves_item_id',
      'hook_resolves_neither',
      'hook_resolves_union',
      'subagent_starts',
      'subagent_stops',
      'subagent_stops_without_a_start',
      'malformed_lines',
      'max_depth',
      'records',
      'run_count',
      'spawns',
      'spawns_refused',
      'spawns_resolved_to_child',
      'threads',
      'tool_calls',
      'tool_calls_item_id_distinct',
      'tool_calls_item_id_equals_call_id',
      'tool_calls_without_item',
      'transcripts',
    ],
    excluded: {
      reasoning_response_items:
        'CLASS 4 — an aggregate of the per-run key excluded above (one engine ' +
        'counter covers it and reasoning_completed_items together).',
      ciphertext_strings: 'CLASS 4 — aggregate of a per-run key not carried to the boundary.',
      ciphertext_bytes: 'CLASS 4 — aggregate of a per-run key not carried to the boundary.',
      longest_record_bytes: 'CLASS 4 — aggregate of per-record sizes, which do not survive parse.ts.',
    },
  },
};

// ---------------------------------------------------------------------------
// Canonical JSON — the golden's own on-disk form
// ---------------------------------------------------------------------------

/** Deep key sort, so key order cannot depend on property assignment order. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** Sorted keys, 2-space indent, trailing newline — the golden's exact text form. */
function canonical(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

/** A stable comparator built from a key-tuple extractor. The golden's own. */
function byKeys<T>(keyOf: (value: T) => string[]): (a: T, b: T) => number {
  return (a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    for (let i = 0; i < ka.length; i += 1) {
      const x = ka[i] as string;
      const y = kb[i] as string;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  };
}

/**
 * The one value of a set, or a failure naming what it saw.
 *
 * Used where the golden states a RUN-level fact that the engine states
 * per-thread — the dialect and its source. Collapsing a set of engine values is
 * a projection; picking a winner from a disagreeing set would be a second
 * engine, so a disagreement is an error here.
 */
function sole<T>(values: readonly T[], what: string): T {
  const distinct = [...new Set(values.map((value) => JSON.stringify(value)))];
  if (distinct.length !== 1) {
    throw new Error(`${what}: expected one value across the run, saw ${JSON.stringify(distinct)}`);
  }
  return JSON.parse(distinct[0] as string) as T;
}

// ---------------------------------------------------------------------------
// THE PROJECTION
// ---------------------------------------------------------------------------

/**
 * One run's engine output in the golden's shape.
 *
 * Every value below is read off `CodexEngineResult`. The only operations are
 * selection, sorting, de-duplication and counting; nothing is derived from a
 * corpus byte and no rule of the generator's is re-implemented.
 */
/**
 * The hook half, derived through PRODUCTION `readCodexHookStream`.
 *
 * Amendment 2026-09-03 forbids the excluded partition from carrying
 * liveness, and it was carrying all of it. `readCodexEngine` deliberately
 * does not chain liveness (Phase 3, DoD 3.2), so this reads the stream with
 * the engine's own reader instead — production code, not a second engine.
 * The JOIN counts below resolve against ids the ENGINE parsed out of the
 * transcripts, so they are a statement about the engine's output, not about
 * this file's arithmetic.
 */
function projectHooks(
  result: CodexEngineResult,
  streamText: string | null,
): { liveness: Record<string, unknown>; hook_join: Record<string, unknown>; bytes: number } {
  const callIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const th of result.threads) {
    for (const c of th.toolCalls) {
      callIds.add(c.callId);
      if (c.itemId !== null) itemIds.add(c.itemId);
    }
  }

  const read = streamText === null ? null : readCodexHookStream(streamText);
  const events = read === null ? [] : read.events;
  const payloads = events.map((e) => e.payload as Record<string, unknown>);
  const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);

  const eventCounts: Record<string, number> = {};
  for (const p of payloads) {
    const name = s(p['hook_event_name']);
    if (name !== null) eventCounts[name] = (eventCounts[name] ?? 0) + 1;
  }

  const withTool = payloads.filter((p) => s(p['tool_use_id']) !== null);
  const byCall = withTool.filter((p) => callIds.has(s(p['tool_use_id']) as string));
  const byItem = withTool.filter((p) => itemIds.has(s(p['tool_use_id']) as string));
  const both = withTool.filter(
    (p) => callIds.has(s(p['tool_use_id']) as string) && itemIds.has(s(p['tool_use_id']) as string),
  );
  const union = withTool.filter(
    (p) => callIds.has(s(p['tool_use_id']) as string) || itemIds.has(s(p['tool_use_id']) as string),
  );

  // Per-agent liveness. C11: a main-thread event OMITS agent_id rather than
  // sending a sentinel, so absence is the signal and grouping on it is safe.
  const agentIds = [...new Set(payloads.map((p) => s(p['agent_id'])).filter((v): v is string => v !== null))].sort();
  const agents = agentIds.map((id) => {
    const mine = payloads.filter((p) => s(p['agent_id']) === id);
    const stops = mine.filter((p) => s(p['hook_event_name']) === 'SubagentStop');
    const starts = mine.filter((p) => s(p['hook_event_name']) === 'SubagentStart');
    const turnIds = [...new Set(mine.map((p) => s(p['turn_id'])).filter((v): v is string => v !== null))].sort();
    const stopTurnIds = new Set(stops.map((p) => s(p['turn_id'])).filter((v) => v !== null));
    return {
      agent_id: id,
      agent_transcript_path_on_stop: stops.some((p) => s(p['agent_transcript_path']) !== null),
      distinct_stop_turn_ids: stopTurnIds.size,
      distinct_turn_ids: turnIds.length,
      subagent_start_count: starts.length,
      subagent_stop_count: stops.length,
      turn_ids: turnIds,
    };
  });

  const stopped = new Set(
    payloads.filter((p) => s(p['hook_event_name']) === 'SubagentStop').map((p) => s(p['agent_id'])),
  );
  const started = new Set(
    payloads.filter((p) => s(p['hook_event_name']) === 'SubagentStart').map((p) => s(p['agent_id'])),
  );

  return {
    bytes: streamText === null ? 0 : Buffer.byteLength(streamText, 'utf8'),
    liveness: {
      agents,
      agents_with_multiple_stops: agents.filter((a) => a.subagent_stop_count > 1).length,
      session_start_count: eventCounts['SessionStart'] ?? 0,
      stop_count: eventCounts['Stop'] ?? 0,
      subagent_start_count: eventCounts['SubagentStart'] ?? 0,
      subagent_stop_count: eventCounts['SubagentStop'] ?? 0,
      subagent_stops_without_a_start: [...stopped].filter((id) => !started.has(id)).length,
    },
    hook_join: {
      envelope_tool_use_id_equals_raw: withTool.length - (read?.envelopeDisagreements ?? 0),
      events: eventCounts,
      main_thread_records: payloads.filter((p) => s(p['agent_id']) === null).length,
      malformed_lines: read?.malformedLines ?? 0,
      records: payloads.length,
      records_with_agent_id: payloads.filter((p) => s(p['agent_id']) !== null).length,
      records_with_tool_use_id: withTool.length,
      resolves_both: both.length,
      resolves_call_id: byCall.length,
      resolves_call_id_only: byCall.length - both.length,
      resolves_item_id: byItem.length,
      resolves_item_id_only: byItem.length - both.length,
      resolves_neither: withTool.length - union.length,
      resolves_union: union.length,
      stream_present: streamText !== null,
    },
  };
}

function projectRun(result: CodexEngineResult, streamText: string | null): Record<string, unknown> {
  const threads = [...result.threads].sort(byKeys((t: CodexThread) => [t.threadId]));
  const bytesByFile = new Map(result.discovery.transcripts.map((t) => [t.file, t.bytes]));
  const calls = threads.flatMap((t) => t.toolCalls);
  const joinByCall = new Map(result.spawnJoins.map((j) => [j.callId, j]));
  const callById = new Map(calls.map((c) => [c.callId, c]));
  const spawns = threads.flatMap((t) => t.spawns);

  const relation = {
    item_id_distinct_from_call_id: 0,
    item_id_equals_call_id: 0,
    no_item: 0,
  };
  for (const call of calls) relation[call.idRelation] += 1;

  const depths = threads
    .filter((t) => t.spawnDepth.present && typeof t.spawnDepth.value === 'number')
    .map((t) => t.spawnDepth.value as number);

  const projectCall = (c: CodexToolCall): Record<string, unknown> => ({
    call_id: c.callId,
    file: c.file,
    id_relation: c.idRelation,
    item_id: c.itemId,
    item_type: c.itemType,
    kind: c.kind,
    name: c.name,
    namespace: c.namespace,
    ordinal: c.ordinal,
    thread_id: c.threadId,
  });

  const hooks = projectHooks(result, streamText);

  return {
    hook_join: hooks.hook_join,
    liveness: hooks.liveness,
    dialect: sole(threads.map((t) => t.dialect), 'dialect'),
    dialect_source: sole(threads.map((t) => t.dialectSource), 'dialect_source'),
    dialect_evidence: {
      session_meta_multi_agent_version: [
        ...new Set(
          threads
            .filter((t) => t.multiAgentVersion.present && typeof t.multiAgentVersion.value === 'string')
            .map((t) => t.multiAgentVersion.value as string),
        ),
      ].sort(),
      spawn_namespaces: [
        ...new Set(
          calls
            .filter((c) => c.namespace.present && typeof c.namespace.value === 'string')
            .map((c) => c.namespace.value as string),
        ),
      ].sort(),
    },
    /*
     * Sorted by BASENAME. `locateCodex` sorts by full path and the generator
     * sorts by the run-relative POSIX path; every transcript of a run lives in
     * one day directory, so the three orders coincide. Sorting explicitly here
     * means the projection does not inherit an ordering it did not state.
     */
    transcripts: threads
      .map((t) => ({
        bytes: bytesByFile.get(t.owningFile),
        file: t.owningFile,
        malformed_lines: t.counters.malformedLines,
        owning_thread_id: t.threadId,
        records: t.records,
      }))
      .sort(byKeys((t: { file: string }) => [t.file])),
    threads: threads.map((t) => ({
      agent_nickname: t.agentNickname,
      agent_path: t.agentPath,
      cli_version: t.cliVersion,
      forked_from_id: t.forkedFromId,
      inherited_records_before_fork_start: t.inheritedRecordsBeforeForkStart,
      multi_agent_version: t.multiAgentVersion,
      // `null` on the engine means "the transcript did not say"; the golden
      // writes `String(payload.originator ?? '')`. A spelling of absence, not
      // a value — mapped, never invented.
      originator: t.originator ?? '',
      owning_file: t.owningFile,
      parent_thread_id: t.parentThreadId,
      records_in_owning_file: t.records,
      session_id: t.sessionId,
      spawn_agent_nickname: t.threadSpawn.agentNickname,
      spawn_agent_path: t.threadSpawn.agentPath,
      spawn_agent_role: t.threadSpawn.agentRole,
      spawn_depth: t.spawnDepth,
      spawn_parent_thread_id: t.threadSpawn.parentThreadId,
      spawn_present: t.threadSpawn.present,
      subagent_history_start_ordinal: t.subagentHistoryStartOrdinal,
      thread_id: t.threadId,
      thread_source: t.threadSource,
    })),
    thread_summary: {
      agent_path_absent: threads.filter((t) => !t.agentPath.present).length,
      agent_path_present: threads.filter((t) => t.agentPath.present).length,
      count: threads.length,
      max_depth: depths.length > 0 ? Math.max(...depths) : null,
      spawn_agent_path_null: threads.filter(
        (t) => t.threadSpawn.agentPath.present && t.threadSpawn.agentPath.value === null,
      ).length,
      subagent_threads: threads.filter((t) => t.threadSource === 'subagent').length,
      user_threads: threads.filter((t) => t.threadSource === 'user').length,
    },
    tool_calls: calls
      .map(projectCall)
      .sort(
        byKeys((c: Record<string, unknown>) => [
          String(c['file']),
          String(c['ordinal']).padStart(6, '0'),
          String(c['call_id']),
        ]),
      ),
    tool_call_summary: { by_id_relation: relation, count: calls.length },
    spawns: spawns
      .map((s) => {
        /*
         * A SPAWN IS ALSO A TOOL CALL, and `call_id` is its primary key.
         *
         * `CodexSpawn` carries `itemId` but no `itemType`, and it carries no
         * "was there an output" flag. Both live on the CodexToolCall the engine
         * built from the SAME record, so this is a primary-key lookup between
         * two arrays the engine returned — locating where the engine put a
         * value, never deriving one. `parse.ts` emits a `spawn_agent` entry in
         * both lists, so the lookup cannot miss.
         */
        const call = callById.get(s.callId);
        // THE JOIN, from the engine's own result. Amendment 2026-09-03: the
        // partition may not exclude topology, and this is the topology.
        const join = joinByCall.get(s.callId);
        return {
          activity_agent_path: s.activityAgentPath,
          activity_agent_thread_id: s.activityAgentThreadId,
          call_id: s.callId,
          child_resolved_by: join === undefined ? 'unresolved' : join.resolvedBy,
          child_thread_id: join === undefined ? null : join.childThreadId,
          file: s.file,
          item_id: s.itemId,
          item_type: call === undefined ? null : call.itemType,
          message_bytes: s.messageBytes,
          message_encrypted: s.messageEncrypted,
          message_present: s.messagePresent,
          namespace: s.namespace,
          ordinal: s.ordinal,
          output_agent_id: s.outputAgentId,
          output_nickname: s.outputNickname,
          // `outputPreview` is set exactly when parse.ts found a
          // `function_call_output` for this call id, which is the golden's
          // `output !== null`. Presence of the engine's field, not its bytes.
          output_present: call !== undefined && call.outputPreview !== undefined,
          output_task_name: s.outputTaskName,
          refusal_text: s.refusalText,
          refused: s.refused,
          requested_task_name: s.requestedTaskName,
          thread_id: s.threadId,
        };
      })
      .sort(
        byKeys((s: Record<string, unknown>) => [
          String(s['file']),
          String(s['ordinal']).padStart(6, '0'),
          String(s['call_id']),
        ]),
      ),
    spawn_summary: {
      count: spawns.length,
      refused: spawns.filter((s) => s.refused).length,
      resolved_to_child: spawns.filter(
        (s) => (joinByCall.get(s.callId)?.childThreadId ?? null) !== null,
      ).length,
      unresolved: spawns.filter(
        (s) => joinByCall.get(s.callId)?.resolvedBy === 'unresolved',
      ).length,
    },
    redaction: {
      spawn_messages_encrypted: spawns.filter((s) => s.messageEncrypted).length,
      spawn_messages_plaintext: spawns.filter((s) => s.messagePresent && !s.messageEncrypted).length,
    },
    sizes: {
      hook_stream_bytes: hooks.bytes,
      transcript_bytes_total: result.discovery.transcripts.reduce((n, t) => n + t.bytes, 0),
    },
  };
}

/** The whole corpus in the golden's shape, from the per-run projections. */
const livenessOf = (run: Record<string, unknown>): Record<string, unknown> =>
  run['liveness'] as Record<string, unknown>;
const hookJoinOf = (run: Record<string, unknown>): Record<string, unknown> =>
  run['hook_join'] as Record<string, unknown>;

function projectCorpus(
  results: readonly CodexEngineResult[],
  runs: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const dialects: Record<string, number> = {};
  const dialectSources: Record<string, number> = {};
  for (const run of runs) {
    const d = String(run['dialect']);
    const s = String(run['dialect_source']);
    dialects[d] = (dialects[d] ?? 0) + 1;
    dialectSources[s] = (dialectSources[s] ?? 0) + 1;
  }
  const sum = (pick: (run: Record<string, unknown>) => number): number =>
    runs.reduce((n, run) => n + pick(run), 0);
  const transcriptsOf = (run: Record<string, unknown>): { records: number; malformed_lines: number }[] =>
    run['transcripts'] as { records: number; malformed_lines: number }[];
  const relationOf = (run: Record<string, unknown>): Record<string, number> =>
    (run['tool_call_summary'] as Record<string, unknown>)['by_id_relation'] as Record<string, number>;

  return {
    // Every accepted thread states its own `cli_version`, and the corpus is an
    // anchor only if they agree. `sole` makes a disagreement a failure rather
    // than a silent pick — the same rule G9's harvest applies to a corpus name.
    anchor_cli_version: sole(
      results.flatMap((r) => r.threads).map((t) => t.cliVersion),
      'anchor_cli_version',
    ),
    runs,
    summary: {
      dialect_sources: dialectSources,
      dialects,
      malformed_lines: sum((run) => transcriptsOf(run).reduce((n, t) => n + t.malformed_lines, 0)),
      max_depth: runs.reduce((best, run) => {
        const depth = (run['thread_summary'] as Record<string, unknown>)['max_depth'];
        return typeof depth === 'number' && depth > best ? depth : best;
      }, 0),
      records: sum((run) => transcriptsOf(run).reduce((n, t) => n + t.records, 0)),
      agents_with_multiple_stops: sum((run) => livenessOf(run)['agents_with_multiple_stops'] as number),
      hook_records: sum((run) => hookJoinOf(run)['records'] as number),
      hook_records_with_tool_use_id: sum((run) => hookJoinOf(run)['records_with_tool_use_id'] as number),
      hook_resolves_call_id: sum((run) => hookJoinOf(run)['resolves_call_id'] as number),
      hook_resolves_item_id: sum((run) => hookJoinOf(run)['resolves_item_id'] as number),
      hook_resolves_neither: sum((run) => hookJoinOf(run)['resolves_neither'] as number),
      hook_resolves_union: sum((run) => hookJoinOf(run)['resolves_union'] as number),
      run_count: runs.length,
      subagent_starts: sum((run) => livenessOf(run)['subagent_start_count'] as number),
      subagent_stops: sum((run) => livenessOf(run)['subagent_stop_count'] as number),
      subagent_stops_without_a_start: sum(
        (run) => livenessOf(run)['subagent_stops_without_a_start'] as number,
      ),
      spawns: sum((run) => (run['spawns'] as unknown[]).length),
      spawns_refused: sum(
        (run) => (run['spawn_summary'] as Record<string, number>)['refused'] as number,
      ),
      spawns_resolved_to_child: sum(
        (run) => (run['spawn_summary'] as Record<string, number>)['resolved_to_child'] as number,
      ),
      threads: sum((run) => (run['threads'] as unknown[]).length),
      tool_calls: sum((run) => (run['tool_calls'] as unknown[]).length),
      tool_calls_item_id_distinct: sum((run) => relationOf(run)['item_id_distinct_from_call_id'] as number),
      tool_calls_item_id_equals_call_id: sum((run) => relationOf(run)['item_id_equals_call_id'] as number),
      tool_calls_without_item: sum((run) => relationOf(run)['no_item'] as number),
      transcripts: sum((run) => transcriptsOf(run).length),
    },
  };
}

/**
 * The golden, narrowed to exactly the keys `shape` carries, recursively.
 *
 * This is what makes "byte-exact over the reproduced partition" a real byte
 * compare rather than a field-by-field walk: both sides go through
 * {@link canonical} and the strings are compared.
 */
function narrow(source: unknown, shape: unknown): unknown {
  if (Array.isArray(shape)) {
    const from = source as unknown[];
    /*
     * LENGTHS FIRST, and this is not defensive noise. Mapping over the shape
     * would silently TRUNCATE the golden to the projection's length, so an
     * engine that emitted five tool calls where the golden has six would
     * compare five against five and pass. That is the vacuous-comparison class
     * this repository records; a length mismatch is a failure, here, loudly.
     */
    if (!Array.isArray(from) || from.length !== shape.length) {
      throw new Error(
        `array length differs: projection ${shape.length}, golden ${
          Array.isArray(from) ? from.length : 'not an array'
        }`,
      );
    }
    return shape.map((entry, index) => narrow(from[index], entry));
  }
  if (shape === null || typeof shape !== 'object') return source;
  const out: Record<string, unknown> = {};
  const from = (source ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(shape as Record<string, unknown>)) {
    out[key] = narrow(from[key], (shape as Record<string, unknown>)[key]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Key census — read off the golden, never written down
// ---------------------------------------------------------------------------

/** Union of the keys of every object at one declared level of the golden. */
function goldenKeysAt(golden: Record<string, unknown>, path: string): string[] {
  const runs = golden['runs'] as Record<string, unknown>[];
  const keys = new Set<string>();
  const add = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    for (const key of Object.keys(value as Record<string, unknown>)) keys.add(key);
  };

  if (path === 'golden') add(golden);
  else if (path === 'golden.summary') add(golden['summary']);
  else if (path === 'golden.runs[]') for (const run of runs) add(run);
  else {
    const rest = path.slice('golden.runs[].'.length);
    for (const run of runs) {
      const value = run[rest.replace(/\[\]$/, '')];
      if (rest.endsWith('[]')) for (const entry of value as unknown[]) add(entry);
      else add(value);
    }
  }
  return [...keys].sort();
}

/** Keys the PROJECTION emits at one declared level. */
function projectedKeysAt(rebuilt: Record<string, unknown>, path: string): string[] {
  const runs = rebuilt['runs'] as Record<string, unknown>[];
  const keys = new Set<string>();
  const add = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    for (const key of Object.keys(value as Record<string, unknown>)) keys.add(key);
  };

  if (path === 'golden') add(rebuilt);
  else if (path === 'golden.summary') add(rebuilt['summary']);
  else if (path === 'golden.runs[]') for (const run of runs) add(run);
  else {
    const rest = path.slice('golden.runs[].'.length);
    for (const run of runs) {
      const value = run[rest.replace(/\[\]$/, '')];
      if (rest.endsWith('[]')) for (const entry of (value ?? []) as unknown[]) add(entry);
      else add(value);
    }
  }
  return [...keys].sort();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every `.jsonl` under a directory, absolute, for the G1 before/after digest. */
function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkJsonl(full));
    else if (entry.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

// ===========================================================================

describe('DoD 2.7 — readCodexEngine() reproduces the golden', () => {
  it('found at least one Codex corpus with a golden to run against', () => {
    // The other half of the collection-time hazard: if the fixtures move, this
    // fails loudly instead of the file quietly passing with no `.each` bodies.
    expect(CORPORA.length).toBeGreaterThan(0);
  });

  describe.each(CORPORA)('%s', (corpus) => {
    const RUNS = listRuns(corpus);
    const goldenPath = join(FIXTURES, corpus, 'golden.json');

    /*
     * ONE engine pass per run, memoised.
     *
     * The engine is a pure function of the files here — nothing writes, there
     * is no clock on this path (liveness is not chained) and the roots are
     * explicit — so one pass per run is the same evidence as one per test, at
     * a fraction of the filesystem cost. The OpenCode golden test memoises for
     * the same measured reason.
     */
    let cached: {
      goldenText: string;
      golden: Record<string, unknown>;
      results: CodexEngineResult[];
      runs: Record<string, unknown>[];
      rebuilt: Record<string, unknown>;
    } | null = null;

    async function load(): Promise<NonNullable<typeof cached>> {
      if (cached !== null) return cached;
      const goldenText = readFileSync(goldenPath, 'utf8');
      const results: CodexEngineResult[] = [];
      for (const run of RUNS) {
        const outcome = await readCodexEngine({ root: runRoot(corpus, run) });
        if (outcome.kind !== 'ok') {
          throw new Error(`${corpus}/${run}: engine returned ${outcome.kind}`);
        }
        results.push(outcome.result);
      }
      const runs = results.map((r, i) => {
        const p = join(FIXTURES, corpus, RUNS[i] as string, 'hook-stream.jsonl');
        return projectRun(r, existsSync(p) ? readFileSync(p, 'utf8') : null);
      });
      cached = {
        goldenText,
        golden: JSON.parse(goldenText) as Record<string, unknown>,
        results,
        runs,
        rebuilt: projectCorpus(results, runs),
      };
      return cached;
    }

    it('reads every run without refusing or degrading', async () => {
      const { results } = await load();
      expect(RUNS.length).toBeGreaterThan(0);
      expect(results.length).toBe(RUNS.length);
      for (const result of results) {
        // Named rather than asserted as a bare count, so a refusal reports the
        // code and the file it happened on.
        expect(result.refused.map((r) => `${r.file}:${r.mismatch.code}`)).toStrictEqual([]);
        expect(result.threads.length).toBeGreaterThan(0);
      }
    });

    // -----------------------------------------------------------------------
    // THE PARTITION
    // -----------------------------------------------------------------------

    it.each(Object.keys(PARTITION))(
      'the partition of %s is total and disjoint against the golden itself',
      async (path) => {
        const { golden } = await load();
        const part = PARTITION[path] as Partition;
        const excluded = Object.keys(part.excluded);
        const declared = [...part.reproduced, ...excluded].sort();

        // DISJOINT: rule 19's "exact set, both ways" applied to the two lists.
        expect(
          part.reproduced.filter((key) => excluded.includes(key)),
          `${path}: a key is in BOTH lists`,
        ).toStrictEqual([]);

        // TOTAL: equal to the key set read off the golden, both directions,
        // with the count pinned BESIDE the set — a set comparison written
        // against an empty listing passes vacuously and a count goes red.
        const actual = goldenKeysAt(golden, path);
        expect(actual.length, `${path}: the golden has no keys here at all`).toBeGreaterThan(0);
        expect(declared, `${path}: declared vs golden`).toStrictEqual(actual);
        expect(declared.length).toBe(actual.length);
      },
    );

    it('a key present in a future golden and in NEITHER list fails the census', async () => {
      /*
       * THE VACUITY CONTROL, and the whole reason the partition is worth
       * anything. Without it "we reproduce what we reproduce" cannot be
       * falsified: a later harvest adds a key, nothing classifies it, and the
       * reproduction quietly covers a smaller share of the golden.
       *
       * A COPY of the golden gains a key that is in no list; the same census
       * the tests above run must report it.
       */
      const { golden } = await load();
      const mutated = { ...golden, a_key_no_future_golden_should_have_unclassified: 1 };
      const part = PARTITION['golden'] as Partition;
      const declared = [...part.reproduced, ...Object.keys(part.excluded)].sort();
      expect(declared).not.toStrictEqual(goldenKeysAt(mutated, 'golden'));
      // And the same at the per-run level, which is where a new fact would land.
      const runs = (golden['runs'] as Record<string, unknown>[]).map((run) => ({
        ...run,
        a_new_per_run_fact: 1,
      }));
      const runPart = PARTITION['golden.runs[]'] as Partition;
      expect([...runPart.reproduced, ...Object.keys(runPart.excluded)].sort()).not.toStrictEqual(
        goldenKeysAt({ ...golden, runs }, 'golden.runs[]'),
      );
    });

    it.each(Object.keys(PARTITION))(
      'the projection emits exactly the REPRODUCED keys of %s',
      async (path) => {
        /*
         * THIS is what makes the partition load-bearing rather than decorative.
         * Move one key from `reproduced` to `excluded` and this assertion goes
         * red, because the projection still emits it; move one the other way
         * and it goes red because the projection does not. The partition
         * cannot be edited to make a failure disappear.
         *
         * `tool_calls[]` has no exclusions at all, so for that level this is
         * also the statement that the golden's tool-call record is reproduced
         * WHOLE — all ten keys.
         */
        const { rebuilt } = await load();
        const part = PARTITION[path] as Partition;
        const emitted = projectedKeysAt(rebuilt, path);
        expect(emitted, `${path}: projection vs REPRODUCED`).toStrictEqual(
          [...part.reproduced].sort(),
        );
        expect(emitted.length).toBe(part.reproduced.length);
      },
    );

    // -----------------------------------------------------------------------
    // THE BYTE COMPARE
    // -----------------------------------------------------------------------

    it('reproduces every REPRODUCED key byte-for-byte after canonical JSON', async () => {
      const { golden, rebuilt, runs } = await load();

      // The golden's runs, in the order this file walked the directory, so the
      // comparison is not testing two different sorts against each other.
      const goldenRuns = RUNS.map((name) => {
        const run = (golden['runs'] as Record<string, unknown>[]).find((r) => r['run'] === name);
        if (run === undefined) throw new Error(`golden has no run named ${name}`);
        return run;
      });
      expect(goldenRuns.length).toBe(runs.length);

      const expected = narrow({ ...golden, runs: goldenRuns }, rebuilt);

      // Structures first: a mismatch then reports as a diff of the offending
      // node rather than as two 58 KB strings with a caret somewhere in them.
      expect(rebuilt['summary']).toStrictEqual((expected as Record<string, unknown>)['summary']);
      expect(rebuilt['runs']).toStrictEqual((expected as Record<string, unknown>)['runs']);
      expect(canonical(rebuilt)).toBe(canonical(expected));

      // The reproduced share, stated rather than implied. Not a threshold to
      // tune: it is the measurement this file's DoD amendment rests on, and it
      // is printed by the projection rather than quoted from a note.
      const { goldenText } = await load();
      expect(canonical(rebuilt).length).toBeGreaterThan(0);
      expect(goldenText.length).toBeGreaterThan(canonical(rebuilt).length);
    });

    it('every run reproduces on its own, so one run cannot carry another', async () => {
      // The corpus-wide compare above would still pass if two runs' errors
      // cancelled inside a sum. This is the same comparison per run.
      const { golden, runs } = await load();
      for (let i = 0; i < RUNS.length; i += 1) {
        const name = RUNS[i] as string;
        const goldenRun = (golden['runs'] as Record<string, unknown>[]).find(
          (r) => r['run'] === name,
        );
        const mine = runs[i] as Record<string, unknown>;
        expect(canonical(mine), `run ${name}`).toBe(canonical(narrow(goldenRun, mine)));
      }
    });

    // -----------------------------------------------------------------------
    // The two known divergences
    // -----------------------------------------------------------------------

    it('divergence A — the fingerprint and the generator agree on the dialect of every run', async () => {
      /*
       * `fingerprint.ts` REFUSES `dialectContradiction` where the generator
       * falls through to the next source and labels the result `ambiguous`
       * (spec C3a: "two sources disagreeing is an error, not a tiebreak").
       * Nothing rests on that today and this asserts why: on the committed
       * corpus the engine accepts every transcript and its dialect equals the
       * golden's, run for run. A future corpus that parts them fails HERE,
       * naming the run, instead of somewhere inside a 58 KB byte compare.
       */
      const { golden, results, runs } = await load();
      for (let i = 0; i < RUNS.length; i += 1) {
        const name = RUNS[i] as string;
        const goldenRun = (golden['runs'] as Record<string, unknown>[]).find(
          (r) => r['run'] === name,
        ) as Record<string, unknown>;
        expect((runs[i] as Record<string, unknown>)['dialect'], `${name} dialect`).toBe(
          goldenRun['dialect'],
        );
        expect((runs[i] as Record<string, unknown>)['dialect_source'], `${name} source`).toBe(
          goldenRun['dialect_source'],
        );
        expect(
          (results[i] as CodexEngineResult).refused.map((r) => r.mismatch.code),
          `${name}: a dialectContradiction refusal would make the two readers disagree`,
        ).toStrictEqual([]);
      }
    });

    it('divergence B — no tool call sits in an inherited region, which is why the fork boundary is invisible', async () => {
      /*
       * The generator applies NO fork boundary; `parse.ts` does (spec C5,
       * `inheritedRecordsDropped`). The two agree on `tool_calls` only because
       * every inherited region of this corpus is free of tool calls.
       *
       * Asserted as a property of the ENGINE's own output: for every thread
       * that declares a fork start, every tool call it kept sits at or above
       * that ordinal — and at least one thread must declare one, or this test
       * is vacuous over a corpus with no forks at all.
       *
       * A later harvest that puts a tool call in an inherited region makes the
       * two readers diverge LEGITIMATELY. This assertion is the notice.
       */
      const { results } = await load();
      const threads = results.flatMap((r) => r.threads);
      const forked = threads.filter((t) => t.subagentHistoryStartOrdinal.present);
      expect(forked.length, 'no thread declares a fork boundary — the check is vacuous')
        .toBeGreaterThan(0);
      for (const thread of forked) {
        const start = thread.subagentHistoryStartOrdinal.value as number;
        const below = thread.toolCalls.filter((c) => c.ordinal < start);
        expect(
          below.map((c) => `${c.file}:${c.ordinal}:${c.name}`),
          `${thread.threadId} kept a tool call below its fork start ${start}`,
        ).toStrictEqual([]);
        expect(thread.inheritedRecordsBeforeForkStart).toBeGreaterThan(0);
      }
    });

    // -----------------------------------------------------------------------
    // What the partition excludes, cross-checked where it can be
    // -----------------------------------------------------------------------

    it("the one reasoning counter equals the golden's two reasoning keys summed", async () => {
      /*
       * `redaction.reasoning_response_items` and `reasoning_completed_items`
       * are EXCLUDED because the engine reports one number where the golden
       * reports two, and splitting one counter into two would be inventing a
       * number. What CAN be checked is the identity, and it is checked rather
       * than asserted in prose: the sum of the golden's two equals the
       * engine's `reasoningDropped`, per run.
       */
      const { golden, results } = await load();
      for (let i = 0; i < RUNS.length; i += 1) {
        const name = RUNS[i] as string;
        const goldenRun = (golden['runs'] as Record<string, unknown>[]).find(
          (r) => r['run'] === name,
        ) as Record<string, unknown>;
        const redaction = goldenRun['redaction'] as Record<string, number>;
        const both =
          (redaction['reasoning_response_items'] as number) +
          (redaction['reasoning_completed_items'] as number);
        expect((results[i] as CodexEngineResult).counters.reasoningDropped, `${name}`).toBe(both);
        expect(both).toBeGreaterThan(0);
      }
    });

    it('every spawn the golden resolved is accounted for in the tree — as an edge or as a park', async () => {
      /*
       * `spawns[].child_thread_id` and `child_resolved_by` are EXCLUDED from
       * the byte compare (CLASS 4: the join is `CodexGraftResult`'s and
       * `CodexEngineResult` does not carry it). This is the join asserted the
       * only way this boundary allows, and the shape is chosen with care.
       *
       * **The TOTAL is pinned, never the split**, because the split is
       * currently WRONG and this test must not pin a defect. Measured on this
       * corpus, 2026-09-03: of the 9 spawns the golden resolves, 8 become a
       * `SpawnEdge` and 1 becomes a `parked` entry coded `noAgentPath` — the
       * `resume-twice-v1` v1 spawn. `graft.ts`'s `joinSpawns` resolves it
       * correctly (`output_agent_id_equals_thread_id`, `spawnsResolved: 1`) and
       * `parkCodeFor` then parks the child because its TOP-LEVEL `agent_path`
       * key is absent, which is true of every v1 subagent. That is the "the
       * whole v1 dialect parked with no filament" outcome `types.ts` records as
       * a premise that was already found false once. It is reported in the
       * handoff as a defect in a package this file does not own.
       *
       * Asserting `edges + parks == resolved` stays green both before and after
       * that fix, and goes red the moment a resolved spawn vanishes from both.
       */
      const { golden, results } = await load();
      for (let i = 0; i < RUNS.length; i += 1) {
        const name = RUNS[i] as string;
        const goldenRun = (golden['runs'] as Record<string, unknown>[]).find(
          (r) => r['run'] === name,
        ) as Record<string, unknown>;
        const resolved = (goldenRun['spawns'] as Record<string, unknown>[]).filter(
          (s) => s['child_thread_id'] !== null,
        );
        const result = results[i] as CodexEngineResult;
        const edges = new Set<string>();
        const parkedBy = new Set<string>();
        for (const session of result.sessions) {
          for (const edge of session.spawnEdges ?? []) edges.add(edge.toolUseId);
          for (const park of session.parked ?? []) parkedBy.add(park.toolUseId ?? '');
        }
        for (const spawn of resolved) {
          const callId = String(spawn['call_id']);
          expect(
            edges.has(callId) || parkedBy.has(callId),
            `${name}: spawn ${callId} resolved to ${String(spawn['child_thread_id'])} in the ` +
              'golden but is neither a SpawnEdge nor a parked entry',
          ).toBe(true);
        }
        // The join key itself IS at this boundary, and it is the substantive
        // half: whichever of the two keys the dialect used, the engine's spawn
        // carries it and it names a thread the engine parsed.
        const threadIds = new Set(result.threads.map((t) => t.threadId));
        const agentPaths = new Set(
          result.threads
            .filter((t) => t.agentPath.present && typeof t.agentPath.value === 'string')
            .map((t) => t.agentPath.value as string),
        );
        for (const spawn of resolved) {
          const engineSpawn = result.threads
            .flatMap((t) => t.spawns)
            .find((s) => s.callId === String(spawn['call_id']));
          expect(engineSpawn, `${name}: ${String(spawn['call_id'])}`).toBeDefined();
          const byPath =
            engineSpawn?.outputTaskName !== null &&
            engineSpawn !== undefined &&
            agentPaths.has(engineSpawn.outputTaskName as string);
          const byId =
            engineSpawn?.outputAgentId !== null &&
            engineSpawn !== undefined &&
            threadIds.has(engineSpawn.outputAgentId as string);
          expect(
            byPath || byId,
            `${name}: neither join key of ${String(spawn['call_id'])} names a parsed thread`,
          ).toBe(true);
        }
      }
    });

    // -----------------------------------------------------------------------
    // The engine's own contract
    // -----------------------------------------------------------------------

    it('tags every session engine: codex (spec C11) and honours the explicit root', async () => {
      const { results } = await load();
      let sessions = 0;
      for (let i = 0; i < RUNS.length; i += 1) {
        const result = results[i] as CodexEngineResult;
        // `explicit` is a THIRD rootSource, never a translation into
        // `{CODEX_HOME: root}` — that synthesis was measured, mutation-tested
        // and rejected in this phase because it makes the provenance field lie.
        expect(result.discovery.rootSource).toBe('explicit');
        expect(result.discovery.root).toBe(runRoot(corpus, RUNS[i] as string));
        expect(result.discovery.rootExists).toBe(true);
        for (const session of result.sessions) {
          sessions += 1;
          expect(session.engine, session.sessionId).toBe('codex');
          expect(session.schemaOk).toBe(true);
        }
      }
      expect(sessions).toBeGreaterThan(0);
    });

    it('surfaces CodexCounters, skippedResponseItemTypes included', async () => {
      /*
       * Rule 18: a skip that does not reach the engine boundary is a count of
       * zero nobody can tell apart from "nothing was skipped".
       * `skippedResponseItemTypes` is the field that prevents it, so its
       * presence on the RESULT is asserted, and so is the one non-empty value
       * this corpus produces — `tool_search_output`, in `resume-twice-v1`. An
       * empty list everywhere would make the field indistinguishable from a
       * hard-coded `[]`.
       */
      const { results } = await load();
      const seen = new Set<string>();
      for (const result of results) {
        expect(Array.isArray(result.counters.skippedResponseItemTypes)).toBe(true);
        for (const type of result.counters.skippedResponseItemTypes) seen.add(type);
        // Sorted and de-duplicated, so the value is comparable across runs.
        expect([...result.counters.skippedResponseItemTypes].sort()).toStrictEqual([
          ...result.counters.skippedResponseItemTypes,
        ]);
        expect(new Set(result.counters.skippedResponseItemTypes).size).toBe(
          result.counters.skippedResponseItemTypes.length,
        );
      }
      expect(
        [...seen],
        'no response_item type was skipped anywhere — the field proves nothing here',
      ).not.toStrictEqual([]);
    });

    it('accounts for every discovered transcript: parsed, refused, or neither and visible', async () => {
      /*
       * The header of `index.ts` states this partition; here it is asserted.
       * `discovery.transcripts` minus `threads` minus `refused` IS the skip
       * list, so a file that produced nothing can never be silent.
       */
      const { results } = await load();
      for (const result of results) {
        const discovered = result.discovery.transcripts.map((t) => t.file).sort();
        const parsed = result.threads.map((t) => t.owningFile);
        const refusedFiles = result.refused.map((r) => r.file);
        expect([...parsed, ...refusedFiles].sort()).toStrictEqual(discovered);
        expect(new Set(parsed).size).toBe(parsed.length);
        expect(discovered.length).toBeGreaterThan(0);
      }
    });

    it('changes no byte of the corpus (G1) and opens nothing outside the root', async () => {
      /*
       * The BEFORE digests are taken by walking the fixture directory with
       * `fs`, not by asking the engine what it found. A digest taken from the
       * engine's own discovery would be taken AFTER the read it is supposed to
       * bracket, and — worse — it would only cover the files the engine chose
       * to look at, which is the half of G1 that needs proving least.
       */
      const files = walkJsonl(join(FIXTURES, corpus)).sort();
      expect(files.length).toBeGreaterThan(0);
      const before = new Map(files.map((path) => [path, sha256(path)]));

      const roots = RUNS.map((run) => runRoot(corpus, run));
      for (const run of RUNS) {
        const outcome = await readCodexEngine({ root: runRoot(corpus, run) });
        if (outcome.kind !== 'ok') throw new Error(`engine returned ${outcome.kind}`);
        for (const ref of outcome.result.discovery.transcripts) {
          // Every path opened lies under the root this test named. Discovery
          // resolving anywhere else is the G6 failure this asserts against.
          expect(roots.some((root) => ref.path.startsWith(root))).toBe(true);
        }
      }

      for (const [path, digest] of before) expect(sha256(path), path).toBe(digest);
      // Nothing appeared beside the corpus either: same file set, both ways.
      expect(walkJsonl(join(FIXTURES, corpus)).sort()).toStrictEqual(files);
    });
  });
});

// ===========================================================================
// The outcome arms, away from the corpus
// ===========================================================================

describe('DoD 2.1 / 2.7 — the engine returns rather than throws', () => {
  it('reports rootAbsent for a root that is not there, without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-absent-'));
    try {
      const missing = join(dir, 'no-such-root');
      const outcome = await readCodexEngine({ root: missing });
      expect(outcome.kind).toBe('rootAbsent');
      if (outcome.kind !== 'rootAbsent') return;
      expect(outcome.root).toBe(missing);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never reads a live ~/.codex: an env with no CODEX_HOME resolves under the FAKE home (G6)', async () => {
    /*
     * The recorded negative-control trap, and it is not theoretical: `homedir()`
     * reads USERPROFILE on Windows and HOME elsewhere, so a control that fakes
     * only one of them runs happily against the developer's REAL data root and
     * returns a confident false pass. Both are faked, and the assertion is on
     * the ROOT the engine resolved, not merely on the outcome — an engine that
     * read the real `~/.codex` and found nothing would also say `rootAbsent`.
     */
    const dir = mkdtempSync(join(tmpdir(), 'codex-fakehome-'));
    try {
      const outcome = await readCodexEngine({ env: { HOME: dir, USERPROFILE: dir } });
      expect(outcome.kind).toBe('rootAbsent');
      if (outcome.kind !== 'rootAbsent') return;
      expect(outcome.root).toBe(join(dir, '.codex'));
      expect(outcome.root.startsWith(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an explicit root outranks CODEX_HOME, and says so in rootSource', async () => {
    const corpus = CORPORA[0];
    expect(corpus).toBeDefined();
    const run = listRuns(corpus as string)[0] as string;
    const dir = mkdtempSync(join(tmpdir(), 'codex-envwins-'));
    try {
      const outcome = await readCodexEngine({
        root: runRoot(corpus as string, run),
        env: { CODEX_HOME: dir, HOME: dir, USERPROFILE: dir },
      });
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;
      expect(outcome.result.discovery.rootSource).toBe('explicit');
      expect(outcome.result.discovery.root).toBe(runRoot(corpus as string, run));
      expect(outcome.result.threads.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters the deck by the host workspace, and rejects a foreign folder (C1)', async () => {
    /*
     * The workspace path is READ OFF THE CORPUS, never written as a literal: a
     * hard-coded absolute path would pin one machine AND put a developer
     * identifier in `src/`, which the privacy sweep gates on.
     */
    const corpus = CORPORA[0] as string;
    const run = listRuns(corpus)[0] as string;
    const plain = await readCodexEngine({ root: runRoot(corpus, run) });
    if (plain.kind !== 'ok') throw new Error('engine did not read the corpus');
    const cwd = (plain.result.threads[0] as CodexThread).cwd;
    expect(cwd).not.toBe('');
    // No folders supplied at all: do not filter.
    expect(plain.result.sessions.every((s) => s.workspaceMatch)).toBe(true);
    expect(plain.result.sessions.every((s) => s.projectSlug !== '')).toBe(true);

    const matched = await readCodexEngine({
      root: runRoot(corpus, run),
      workspaceFolders: [cwd],
    });
    if (matched.kind !== 'ok') throw new Error('engine did not read the corpus');
    expect(matched.result.sessions.every((s) => s.workspaceMatch)).toBe(true);

    // The drive letter's case is the variance this repository has measured from
    // Claude Code itself; the match must survive it.
    const flipped = cwd.replace(/^([A-Za-z])(?=:)/, (c) =>
      c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
    );
    if (flipped !== cwd) {
      const cased = await readCodexEngine({
        root: runRoot(corpus, run),
        workspaceFolders: [flipped],
      });
      if (cased.kind !== 'ok') throw new Error('engine did not read the corpus');
      expect(cased.result.sessions.every((s) => s.workspaceMatch)).toBe(true);
    }

    const foreign = await readCodexEngine({
      root: runRoot(corpus, run),
      workspaceFolders: ['D:/somewhere/else'],
    });
    if (foreign.kind !== 'ok') throw new Error('engine did not read the corpus');
    expect(foreign.result.sessions.some((s) => s.workspaceMatch)).toBe(false);
  });
});

// ===========================================================================
// THE EXCLUSION IS NOT ALLOWED TO HIDE ANYTHING THAT MATTERS
// (Amendment 2026-09-03, user, at the Phase 2 gate)
// ===========================================================================

/**
 * The five concepts an exclusion may never carry.
 *
 * The partition answers "what do we reproduce". It cannot, by itself, answer
 * "is what we DON'T reproduce harmless" — a partition that is merely honest
 * about its gaps can still be quietly excluding the whole product. This is the
 * guard the user added when approving Amendment 2, and it earned its place on
 * the first run: **26 violations**, including the entire spawn-to-child JOIN
 * and every liveness key. Both are now reproduced.
 *
 * `context` targets the TOKEN concept, not the `turn_context` RECORD TYPE.
 * The golden's two `turn_context…` keys name where the dialect was read from
 * (C3a's resolution order) and carry no token figure at all; matching them
 * would be matching a spelling rather than a meaning. The narrowing is
 * recorded here rather than done silently, because narrowing a guard's
 * pattern is exactly how a guard stops guarding.
 */
const FORBIDDEN_IN_EXCLUSIONS: readonly (readonly [string, RegExp])[] = [
  ['topology', /child|parent|spawn|agent_path|thread_id|resolved|depth/i],
  ['liveness', /liveness|hook|subagent_start|subagent_stop|stop_count|turn_id/i],
  ['burn', /burn|total_token/i],
  ['context', /context_now|contextnow|last_token/i],
  ['window', /window/i],
];

/**
 * Which of the five the golden's vocabulary contains AT ALL, pinned.
 *
 * Measured over every key at every depth of `golden.json`: topology 27,
 * liveness 18, **burn 0, context 0, window 0**.
 *
 * **That is a real coverage statement and it is not a comfortable one: the
 * golden does not audit tokens or the context window at all.** DoD 2.6's
 * `windowTokens` and the `contextNow`/`burn` contract are covered by
 * `graft.test.ts`, and by nothing here. Reproducing this golden says nothing
 * about them.
 *
 * Pinned so the fact cannot drift silently: a future harvest whose generator
 * emits a burn or window key changes this list and fails, which forces
 * whoever adds it to classify it rather than let it land unclassified.
 */
const CONCEPTS_IN_THE_GOLDEN: readonly string[] = ['liveness', 'topology'];

describe('the excluded partition carries no topology, liveness, burn, context or window', () => {
  it('names no excluded key matching any of the five concepts', () => {
    const offences: string[] = [];
    for (const [level, part] of Object.entries(PARTITION)) {
      for (const key of Object.keys(part.excluded)) {
        for (const [concept, re] of FORBIDDEN_IN_EXCLUSIONS) {
          if (re.test(key)) offences.push(`${level}.${key} -> ${concept}`);
        }
      }
    }
    expect(offences.sort()).toStrictEqual([]);
  });

  it('is non-vacuous: every concept the golden HAS is matched by its pattern', () => {
    // A guard whose patterns match nothing passes forever. This walks the
    // golden's real key set rather than the partition, so the patterns are
    // checked against the vocabulary they police.
    const corpus = CORPORA[0];
    expect(corpus, 'no codex corpus on disk').toBeDefined();
    const golden: unknown = JSON.parse(
      readFileSync(join(FIXTURES, corpus as string, 'golden.json'), 'utf8'),
    );
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
      }
    };
    walk(golden);

    const present = FORBIDDEN_IN_EXCLUSIONS.filter(([, re]) =>
      [...keys].some((k) => re.test(k)),
    ).map(([concept]) => concept);
    expect(present.sort()).toStrictEqual([...CONCEPTS_IN_THE_GOLDEN].sort());

    // And the two that ARE present are matched in bulk, not by one lucky key.
    for (const concept of CONCEPTS_IN_THE_GOLDEN) {
      const re = FORBIDDEN_IN_EXCLUSIONS.find(([c]) => c === concept)?.[1];
      expect(re, concept).toBeDefined();
      const hits = [...keys].filter((k) => (re as RegExp).test(k));
      expect(hits.length, `${concept} matches too few keys to be a real guard`).toBeGreaterThan(5);
    }
  });
});
