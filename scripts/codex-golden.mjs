/**
 * `scripts/codex-golden.mjs` - the Codex golden generator (PLAN.md DoD 1.5).
 *
 * Emits `fixtures/codex-<version>/golden.json`: everything the committed Codex
 * corpus STATES about itself, derived from its bytes and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS STANDALONE, AND WHY THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 *
 * DoD 1.5 says "Phase 2 reproduces it through the production path byte-exact".
 * That proof is worth nothing if the two readers share code: two calls into one
 * parser agree by construction, not by evidence.
 *
 * So this file imports NOTHING but `node:` builtins. Not `src/`, not
 * `webview/`, not `lab/`, not a dependency. Every mapping decision below is
 * derived from the corpus on disk, with the measurement written at the
 * decision.
 *
 * PHASE 2 MUST NEVER MAKE `src/codex/` IMPORT THIS FILE. If the engine and this
 * generator ever agree only because they share a module, the golden has stopped
 * being evidence and become a restatement. `src/release/codex-golden.test.ts`
 * asserts the import list; keeping the engine off it is a review obligation.
 *
 * The precedent is `scripts/opencode-golden.mjs`, whose shape this follows.
 * Nothing is imported from it either.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GOLDEN IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is NOT a `SessionState` tree. No Codex engine exists at Phase 1, and no
 * design decision has been taken about how a Codex thread becomes an
 * `AgentNode`. Inventing one here would pin a shape nobody has agreed, and
 * Phase 2 would then be reproducing this file's guesses rather than the
 * corpus's facts.
 *
 * It IS the corpus's observable structure: threads and their declared
 * provenance, the spawn-to-child join, the two tool-call id namespaces, the
 * hook tap's join rate against each namespace, the liveness event shape, the
 * redaction surface (counted, never copied) and the record sizes. Every one of
 * those is a property Phase 2's engine must read the same way, and every one is
 * a number a later Codex release can move.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *
 *     node scripts/codex-golden.mjs                    # every corpus, write
 *     node scripts/codex-golden.mjs --check            # compare only, exit 1 if stale
 *     node scripts/codex-golden.mjs --corpus fixtures/codex-0.151.0-alpha.7.2
 *     node scripts/codex-golden.mjs --corpus <dir> --out <path>
 *
 * G1: every corpus file is opened for READ. The only thing this script writes
 * is the golden, and with `--check` it writes nothing at all.
 *
 * NOTE: no shebang, deliberately. vite's hashbang strip is `/^#!.*\n/` and `.`
 * does not match `\r`, so a shebang breaks vitest COLLECTION in a CRLF checkout
 * only - green for whoever wrote it, `SyntaxError` for everyone else.
 * `scripts/opencode-golden.mjs` and `scripts/privacy-sweep.mjs` have none either.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');

/** Corpus directory prefix. A corpus is `codex-<cli_version>`. */
const CORPUS_PREFIX = 'codex-';

/**
 * Fernet-style ciphertext prefix. Codex encrypts reasoning content, agent
 * message content and (in the v2 dialect) the spawn `message` argument, and
 * every one of those strings begins with this. G4 says the bytes never reach
 * the session model; this generator counts them and refuses to copy them.
 */
const CIPHERTEXT_PREFIX = 'gAAAAAB';

/** Schema tag. Bump it when the golden's SHAPE changes, not when a count moves. */
const SCHEMA = 'agent-deck/codex-golden@1';

// ---------------------------------------------------------------------------
// Canonical serialisation
// ---------------------------------------------------------------------------

/**
 * Deep key sort. The golden must be byte-identical across runs and across
 * machines, so key order cannot depend on the order this file happened to
 * assign properties. Sorting removes that whole class of drift.
 */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
  return out;
}

/** The exact text a golden holds: sorted keys, 2-space indent, LF, trailing newline. */
export function goldenText(golden) {
  const text = `${JSON.stringify(sortKeysDeep(golden), null, 2)}\n`;
  assertNoLeakage(text);
  return text;
}

/**
 * The golden is a tracked fixture in a repository that has already shipped a
 * developer path once. Two classes are refused outright rather than reviewed:
 * an absolute Windows path (the corpus is full of them - `cwd`,
 * `transcript_path`, every `CommandExecution.cwd`) and ciphertext.
 *
 * This is a generator-side guard, not a test-side one, so it fires for anyone
 * who runs the script, including a future harvest that adds a field.
 */
export function assertNoLeakage(text) {
  // `C:\Users\...` serialises into JSON as `C:\\Users\\...`, i.e. a drive
  // letter, a colon and two literal backslashes.
  const winPath = text.match(/[A-Za-z]:\\\\/);
  if (winPath) throw new Error(`golden would carry an absolute path: ${winPath[0]}`);
  if (text.includes(CIPHERTEXT_PREFIX)) {
    throw new Error('golden would carry ciphertext bytes; count them, never copy them');
  }
  const posixHome = text.match(/\/(?:home|Users)\/[^"\\/]+/);
  if (posixHome) throw new Error(`golden would carry a home path: ${posixHome[0]}`);
}

// ---------------------------------------------------------------------------
// Absent versus null - the distinction this corpus makes load-bearing
// ---------------------------------------------------------------------------

/**
 * A v2 subagent's `session_meta.payload` carries `agent_path: "/root/alpha"`.
 * A v1 subagent's carries NO top-level `agent_path` at all, and its nested
 * `source.subagent.thread_spawn.agent_path` is a JSON `null`.
 *
 * Those are three different states - present-with-a-value, present-and-null,
 * absent - and an engine that collapses the last two renders a v1 subagent as
 * if Codex had told it the path was empty. `{present, value}` keeps all three
 * legible in the golden and in any diff of it.
 */
export function optionalField(container, key) {
  const has = container !== null
    && typeof container === 'object'
    && Object.prototype.hasOwnProperty.call(container, key);
  return has ? { present: true, value: container[key] } : { present: false, value: null };
}

// ---------------------------------------------------------------------------
// Corpus discovery. Never a hard-coded list - a later harvest adds a directory
// and a run, and the golden should grow rather than lie.
// ---------------------------------------------------------------------------

export function listCorpora(fixturesDir = FIXTURES_DIR) {
  if (!existsSync(fixturesDir)) return [];
  return readdirSync(fixturesDir)
    .filter((name) => name.startsWith(CORPUS_PREFIX))
    .filter((name) => statSync(path.join(fixturesDir, name)).isDirectory())
    .filter((name) => listRuns(path.join(fixturesDir, name)).length > 0)
    .sort();
}

/** A run is a directory holding a `hook-stream.jsonl` and a `home/` tree. */
export function listRuns(corpusDir) {
  if (!existsSync(corpusDir)) return [];
  return readdirSync(corpusDir)
    .filter((name) => statSync(path.join(corpusDir, name)).isDirectory())
    .filter((name) => existsSync(path.join(corpusDir, name, 'hook-stream.jsonl')))
    .sort();
}

/**
 * Every `.jsonl` under a run's `home/`, as POSIX-separated paths relative to
 * the run, sorted.
 *
 * `readdirSync` order is a filesystem property, not a corpus property. The sort
 * is what makes the golden reproducible on a machine whose directory order
 * differs; `listFiles` is injectable so the test can hand this function a
 * DELIBERATELY reversed listing and prove the sort is doing the work.
 */
export function listTranscripts(runDir, listFiles = readdirSync) {
  const root = path.join(runDir, 'home');
  const found = [];
  const walk = (dir) => {
    for (const name of listFiles(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.jsonl')) found.push(path.relative(runDir, full).split(path.sep).join('/'));
    }
  };
  if (existsSync(root)) walk(root);
  return found.sort();
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Parse a JSONL file. A malformed line is COUNTED and skipped, never fatal -
 * G3, applied to the reference reader so a corpus with one bad line still
 * produces a golden that says so.
 */
export function readJsonl(file) {
  const raw = readFileSync(file, 'utf8');
  const records = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  return { records, malformed, bytes: Buffer.byteLength(raw, 'utf8') };
}

/** Longest single line in a JSONL file, measured in UTF-8 bytes without its terminator. */
function longestLine(file) {
  const raw = readFileSync(file, 'utf8');
  let best = { bytes: 0, ordinal: null, type: null };
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes <= best.bytes) continue;
    let ordinal = null;
    let type = null;
    try {
      const parsed = JSON.parse(line);
      ordinal = parsed.ordinal ?? null;
      type = recordLabel(parsed);
    } catch {
      type = 'malformed';
    }
    best = { bytes, ordinal, type };
  }
  return best;
}

/** A stable human label for a rollout record: its type plus its payload's. */
export function recordLabel(record) {
  const type = String(record?.type ?? 'unknown');
  const payload = record?.payload;
  if (type === 'response_item') return `response_item/${String(payload?.type ?? 'unknown')}`;
  if (type === 'event_msg') {
    const inner = String(payload?.type ?? 'unknown');
    const item = payload?.item?.type;
    return item ? `event_msg/${inner}/${String(item)}` : `event_msg/${inner}`;
  }
  return type;
}

// ---------------------------------------------------------------------------
// One transcript file
// ---------------------------------------------------------------------------

/**
 * A rollout file carries MORE THAN ONE `session_meta`. A forked child
 * re-serialises its parent's inherited records into its own file under its own
 * ordinals, so the parent's `session_meta` reappears there. The file's OWN
 * thread is the declaration at the lowest ordinal; the rest are inherited
 * context. `subagent_history_start_ordinal` is the boundary.
 */
function readTranscript(runDir, relative) {
  const file = path.join(runDir, relative);
  const { records, malformed, bytes } = readJsonl(file);

  const declarations = records
    .filter((r) => r?.type === 'session_meta')
    .map((r) => ({ ordinal: r.ordinal ?? null, payload: r.payload ?? {} }))
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));

  const owner = declarations[0] ?? null;

  return {
    file: relative,
    basename: path.posix.basename(relative),
    records,
    malformed,
    bytes,
    declarations,
    ownerThreadId: owner ? String(owner.payload.id ?? owner.payload.session_id ?? '') : '',
    longest: longestLine(file),
  };
}

/** The `{present, value}` view of a session_meta declaration. */
function describeDeclaration(payload) {
  const spawn = payload?.source?.subagent?.thread_spawn ?? null;
  return {
    thread_id: String(payload?.id ?? payload?.session_id ?? ''),
    session_id: String(payload?.session_id ?? ''),
    cli_version: String(payload?.cli_version ?? ''),
    thread_source: String(payload?.thread_source ?? ''),
    originator: String(payload?.originator ?? ''),
    // Top-level. Present on a v2 subagent, ABSENT on a v1 subagent and on any
    // user thread.
    agent_path: optionalField(payload, 'agent_path'),
    agent_nickname: optionalField(payload, 'agent_nickname'),
    parent_thread_id: optionalField(payload, 'parent_thread_id'),
    forked_from_id: optionalField(payload, 'forked_from_id'),
    subagent_history_start_ordinal: optionalField(payload, 'subagent_history_start_ordinal'),
    multi_agent_version: optionalField(payload, 'multi_agent_version'),
    history_mode: optionalField(payload, 'history_mode'),
    // Nested under `source.subagent.thread_spawn`. This is where a v1 subagent
    // says `agent_path: null` - present, and null.
    spawn_present: spawn !== null && typeof spawn === 'object',
    spawn_depth: optionalField(spawn, 'depth'),
    spawn_agent_path: optionalField(spawn, 'agent_path'),
    spawn_agent_nickname: optionalField(spawn, 'agent_nickname'),
    spawn_agent_role: optionalField(spawn, 'agent_role'),
    spawn_parent_thread_id: optionalField(spawn, 'parent_thread_id'),
  };
}

// ---------------------------------------------------------------------------
// Tool calls and the two id namespaces
// ---------------------------------------------------------------------------

/**
 * A tool call and its completion event are reported under ids from two
 * different namespaces, and which one you get depends on the toolset:
 *
 *   - a `function_call` (both dialects' multi-agent tools, and the v1 dialect's
 *     `exec_command`) has an `item.id` EQUAL to its `call_id`;
 *   - a v2 `custom_tool_call` named `exec` has `call_id` `call_<...>` and an
 *     `item.id` of `exec-<uuid>`, with NO field linking them.
 *
 * Measured over this corpus: 10 `custom_tool_call` records and exactly 10
 * `CommandExecution` items whose id begins `exec-`, against 5 `CommandExecution`
 * items whose id is a `call_` id. So the pairing rule is:
 *
 *   1. key join - claim the item whose `id` equals the `call_id`;
 *   2. positional - for a still-unmatched call, claim the first unclaimed item
 *      at a HIGHER ordinal whose id begins `exec-`.
 *
 * Leg 2 is a corpus-derived heuristic and is labelled as one in the golden
 * (`item_id_distinct_from_call_id`). Anything it cannot pair is reported as
 * `no_item` rather than guessed, and the per-run counts make a future harvest's
 * change visible instead of silent.
 */
const EXEC_ITEM_PREFIX = 'exec-';

function collectToolCalls(transcript) {
  const items = [];
  const calls = [];

  for (const record of transcript.records) {
    const ordinal = record?.ordinal ?? null;
    if (record?.type === 'event_msg' && record.payload?.type === 'item_completed') {
      const item = record.payload.item ?? {};
      items.push({ ordinal, id: String(item.id ?? ''), type: String(item.type ?? ''), item, claimed: false });
      continue;
    }
    if (record?.type !== 'response_item') continue;
    const payload = record.payload ?? {};
    const kind = String(payload.type ?? '');
    if (kind !== 'function_call' && kind !== 'custom_tool_call' && kind !== 'tool_search_call') continue;
    calls.push({
      ordinal,
      kind,
      name: String(payload.name ?? ''),
      namespace: optionalField(payload, 'namespace'),
      call_id: String(payload.call_id ?? ''),
      argumentsRaw: typeof payload.arguments === 'string' ? payload.arguments : null,
      payload,
    });
  }

  const byId = new Map();
  for (const item of items) if (item.id && !byId.has(item.id)) byId.set(item.id, item);

  calls.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));

  for (const call of calls) {
    const keyed = byId.get(call.call_id);
    if (keyed && !keyed.claimed) {
      keyed.claimed = true;
      call.item = keyed;
      call.relation = 'item_id_equals_call_id';
      continue;
    }
    const positional = items.find(
      (i) => !i.claimed && (i.ordinal ?? 0) > (call.ordinal ?? 0) && i.id.startsWith(EXEC_ITEM_PREFIX),
    );
    if (positional) {
      positional.claimed = true;
      call.item = positional;
      call.relation = 'item_id_distinct_from_call_id';
      continue;
    }
    call.item = null;
    call.relation = 'no_item';
  }

  return { calls, items };
}

// ---------------------------------------------------------------------------
// Dialect
// ---------------------------------------------------------------------------

const STR_V1 = 'v1';
const STR_V2 = 'v2';

/**
 * Codex ships two multi-agent toolsets and hands a session one BY MODEL, at one
 * `cli_version`: `collaboration` is v2, `multi_agent_v1` is v1.
 *
 * THE ENGINE STATES THE DIALECT ITSELF, and it states it on a record every
 * session has. Measured across this corpus: every `turn_context` record in all
 * five runs carries `multi_agent_version` - 3, 6, 1, 3 and 12 records
 * respectively, one value per run, agreeing with `session_meta` everywhere
 * `session_meta` has one. So no inference is needed from a namespace, from a
 * spawn, or from a model name - and none from `models_cache.json`, which G10
 * forbids an engine to open at all.
 *
 * That matters most where there is nothing to infer FROM: `long-output` spawns
 * nothing and has no subagent, so it carries no spawn namespace and no
 * `session_meta.multi_agent_version` - and its `turn_context` says v1 anyway.
 * An earlier version of this file bucketed that run as `undetermined` on the
 * strength of having looked in two places rather than three.
 *
 * Precedence, and the golden records WHICH SOURCE DECIDED so a reader can see
 * the precedence actually applied rather than trusting this comment:
 *
 *   1. turn_context.multi_agent_version         - present on every run here
 *   2. session_meta.payload.multi_agent_version - subagent metas only
 *   3. the spawn namespace                      - corroboration, last resort
 *
 * `undetermined` STAYS REACHABLE. A future corpus whose transcripts declare
 * nothing must land there rather than be guessed at, and the test asserts the
 * bucket is EMPTY on this corpus - a stronger claim than the bucket not
 * existing.
 */
const DIALECT_BY_NAMESPACE = new Map([
  ['collaboration', STR_V2],
  ['multi_agent_v1', STR_V1],
]);

/** The one declared dialect in a set, or null if the set is empty or disagrees. */
function soleDeclaredDialect(values) {
  const kept = [...new Set(values)].filter((v) => v === STR_V1 || v === STR_V2);
  return kept.length === 1 ? kept[0] : null;
}

/**
 * Returns `{dialect, source}`. `source` names the RECORD TYPE that decided it,
 * never a priority index - an index would have to be read against the comment
 * above to mean anything.
 */
function resolveDialect({ turnContextVersions, sessionMetaVersions, namespaces }) {
  const fromTurnContext = soleDeclaredDialect(turnContextVersions);
  if (fromTurnContext !== null) {
    return { dialect: fromTurnContext, source: 'turn_context.multi_agent_version' };
  }
  const fromSessionMeta = soleDeclaredDialect(sessionMetaVersions);
  if (fromSessionMeta !== null) {
    return { dialect: fromSessionMeta, source: 'session_meta.multi_agent_version' };
  }
  const fromNamespace = new Set();
  for (const ns of namespaces) {
    const d = DIALECT_BY_NAMESPACE.get(ns);
    if (d) fromNamespace.add(d);
  }
  if (fromNamespace.size === 1) {
    return { dialect: [...fromNamespace][0], source: 'spawn_namespace' };
  }

  // Reachable, deliberately. Two shapes: nothing declared anything, or the
  // declarations disagree. Neither may be resolved by guessing.
  const declared = [
    ...new Set([...turnContextVersions, ...sessionMetaVersions, ...fromNamespace]),
  ].sort();
  if (declared.length > 1) {
    return { dialect: `ambiguous(${declared.join(',')})`, source: 'conflicting_declarations' };
  }
  return { dialect: 'undetermined', source: 'none' };
}

const SPAWN_TOOL_NAME = 'spawn_agent';

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

function buildRun(corpusDir, runName, listFiles) {
  const runDir = path.join(corpusDir, runName);
  const relatives = listTranscripts(runDir, listFiles);
  const transcripts = relatives.map((rel) => readTranscript(runDir, rel));

  // ---- threads -----------------------------------------------------------
  const declarationsByThread = new Map();
  for (const t of transcripts) {
    for (const decl of t.declarations) {
      const described = describeDeclaration(decl.payload);
      const list = declarationsByThread.get(described.thread_id) ?? [];
      list.push({ ...described, file: t.basename, ordinal: decl.ordinal, owns: t.ownerThreadId === described.thread_id });
      declarationsByThread.set(described.thread_id, list);
    }
  }

  const threads = [...declarationsByThread.entries()]
    .map(([threadId, list]) => {
      const owning = list.find((d) => d.owns) ?? list[0];
      const owningTranscript = transcripts.find((t) => t.basename === owning.file) ?? null;
      const startOrdinal = owning.subagent_history_start_ordinal.present
        ? Number(owning.subagent_history_start_ordinal.value)
        : null;
      const inherited = owningTranscript && startOrdinal !== null
        ? owningTranscript.records.filter((r) => (r.ordinal ?? 0) < startOrdinal).length
        : 0;
      const { owns, file, ordinal, ...fields } = owning;
      return {
        ...fields,
        thread_id: threadId,
        owning_file: owns ? file : null,
        owning_declaration_ordinal: owns ? ordinal : null,
        declarations_in_corpus_run: list.length,
        declared_in_files: [...new Set(list.map((d) => d.file))].sort().length,
        records_in_owning_file: owningTranscript && owns ? owningTranscript.records.length : 0,
        inherited_records_before_fork_start: inherited,
      };
    })
    .sort((a, b) => (a.thread_id < b.thread_id ? -1 : a.thread_id > b.thread_id ? 1 : 0));

  // ---- tool calls --------------------------------------------------------
  const perTranscript = new Map();
  for (const t of transcripts) perTranscript.set(t.basename, collectToolCalls(t));

  const toolCalls = [];
  const spawns = [];
  const namespacesSeen = new Set();
  const execToolsets = new Set();
  const callIds = new Set();
  const itemIds = new Set();
  const multiAgentVersions = new Set();
  const turnContextVersions = new Set();
  const models = new Set();

  for (const t of transcripts) {
    const { calls, items } = perTranscript.get(t.basename);
    for (const item of items) if (item.id) itemIds.add(item.id);
    for (const record of t.records) {
      if (record?.type === 'response_item' && typeof record.payload?.call_id === 'string') {
        callIds.add(record.payload.call_id);
      }
      if (record?.type === 'turn_context') {
        if (typeof record.payload?.model === 'string') models.add(record.payload.model);
        // The dialect the engine declares. Present on EVERY turn_context record
        // of every run in this corpus, including the run with no subagent and
        // no spawn - which is the case the other two sources cannot answer.
        if (typeof record.payload?.multi_agent_version === 'string') {
          turnContextVersions.add(record.payload.multi_agent_version);
        }
      }
      if (record?.type === 'session_meta' && typeof record.payload?.multi_agent_version === 'string') {
        multiAgentVersions.add(record.payload.multi_agent_version);
      }
    }

    for (const call of calls) {
      if (call.namespace.present && typeof call.namespace.value === 'string') {
        namespacesSeen.add(call.namespace.value);
      }
      if (call.kind === 'custom_tool_call' && call.name === 'exec') execToolsets.add('custom_tool_call:exec');
      if (call.kind === 'function_call' && call.name === 'exec_command') execToolsets.add('function_call:exec_command');

      toolCalls.push({
        thread_id: t.ownerThreadId,
        file: t.basename,
        ordinal: call.ordinal,
        kind: call.kind,
        name: call.name,
        namespace: call.namespace,
        call_id: call.call_id,
        item_id: call.item ? call.item.id : null,
        item_type: call.item ? call.item.type : null,
        id_relation: call.relation,
      });

      if (call.name !== SPAWN_TOOL_NAME) continue;
      spawns.push(buildSpawn({ transcript: t, call, transcripts, perTranscript }));
    }
  }

  toolCalls.sort(byKeys((c) => [c.file, String(c.ordinal ?? 0).padStart(6, '0'), c.call_id]));
  spawns.sort(byKeys((s) => [s.file, String(s.ordinal ?? 0).padStart(6, '0'), s.call_id]));

  // Resolve each spawn to a child thread now that every thread is known.
  const byAgentPath = new Map();
  const byThreadId = new Map();
  for (const thread of threads) {
    byThreadId.set(thread.thread_id, thread);
    if (thread.agent_path.present && typeof thread.agent_path.value === 'string') {
      byAgentPath.set(thread.agent_path.value, thread.thread_id);
    }
  }
  for (const spawn of spawns) {
    if (spawn.refused) {
      spawn.child_thread_id = null;
      spawn.child_resolved_by = 'refused';
      continue;
    }
    if (spawn.output_task_name !== null && byAgentPath.has(spawn.output_task_name)) {
      spawn.child_thread_id = byAgentPath.get(spawn.output_task_name);
      spawn.child_resolved_by = 'output_task_name_equals_agent_path';
      continue;
    }
    if (spawn.output_agent_id !== null && byThreadId.has(spawn.output_agent_id)) {
      spawn.child_thread_id = spawn.output_agent_id;
      spawn.child_resolved_by = 'output_agent_id_equals_thread_id';
      continue;
    }
    spawn.child_thread_id = null;
    spawn.child_resolved_by = 'unresolved';
  }

  // ---- hooks -------------------------------------------------------------
  const hooks = buildHookJoin(path.join(runDir, 'hook-stream.jsonl'), callIds, itemIds);

  // ---- redaction ---------------------------------------------------------
  const redaction = buildRedaction(transcripts, spawns);

  // ---- sizes -------------------------------------------------------------
  const longest = transcripts.reduce(
    (best, t) => (t.longest.bytes > best.bytes ? { ...t.longest, file: t.basename } : best),
    { bytes: 0, ordinal: null, type: null, file: null },
  );

  const relationCounts = { item_id_equals_call_id: 0, item_id_distinct_from_call_id: 0, no_item: 0 };
  for (const call of toolCalls) relationCounts[call.id_relation] += 1;

  const unclaimedItemsByType = {};
  for (const t of transcripts) {
    for (const item of perTranscript.get(t.basename).items) {
      if (item.claimed) continue;
      unclaimedItemsByType[item.type] = (unclaimedItemsByType[item.type] ?? 0) + 1;
    }
  }

  const depths = threads
    .filter((t) => t.spawn_depth.present && typeof t.spawn_depth.value === 'number')
    .map((t) => t.spawn_depth.value);

  const resolved = resolveDialect({
    turnContextVersions,
    sessionMetaVersions: multiAgentVersions,
    namespaces: namespacesSeen,
  });

  return {
    run: runName,
    dialect: resolved.dialect,
    dialect_source: resolved.source,
    dialect_evidence: {
      turn_context_multi_agent_version: [...turnContextVersions].sort(),
      session_meta_multi_agent_version: [...multiAgentVersions].sort(),
      spawn_namespaces: [...namespacesSeen].sort(),
      // Corroboration, and never the basis: the exec toolset shape happens to
      // separate the two groups on this corpus, but it is a statement about the
      // exec tool rather than about the multi-agent one.
      exec_toolsets: [...execToolsets].sort(),
      models: [...models].sort(),
    },
    transcripts: transcripts.map((t) => ({
      file: t.basename,
      bytes: t.bytes,
      records: t.records.length,
      malformed_lines: t.malformed,
      session_meta_count: t.declarations.length,
      owning_thread_id: t.ownerThreadId,
    })),
    threads,
    thread_summary: {
      count: threads.length,
      user_threads: threads.filter((t) => t.thread_source === 'user').length,
      subagent_threads: threads.filter((t) => t.thread_source === 'subagent').length,
      max_depth: depths.length > 0 ? Math.max(...depths) : null,
      agent_path_present: threads.filter((t) => t.agent_path.present).length,
      agent_path_absent: threads.filter((t) => !t.agent_path.present).length,
      spawn_agent_path_null: threads.filter(
        (t) => t.spawn_agent_path.present && t.spawn_agent_path.value === null,
      ).length,
    },
    spawns,
    spawn_summary: {
      count: spawns.length,
      refused: spawns.filter((s) => s.refused).length,
      resolved_to_child: spawns.filter((s) => s.child_thread_id !== null).length,
      unresolved: spawns.filter((s) => s.child_resolved_by === 'unresolved').length,
    },
    tool_calls: toolCalls,
    tool_call_summary: {
      count: toolCalls.length,
      by_id_relation: relationCounts,
      distinct_call_ids: callIds.size,
      distinct_item_ids: itemIds.size,
      call_ids_that_are_also_item_ids: [...callIds].filter((id) => itemIds.has(id)).length,
      completed_items_claimed_by_no_tool_call: unclaimedItemsByType,
    },
    hook_join: hooks.join,
    liveness: hooks.liveness,
    redaction,
    sizes: {
      longest_record_bytes: longest.bytes,
      longest_record: { file: longest.file, ordinal: longest.ordinal, type: longest.type },
      transcript_bytes_total: transcripts.reduce((n, t) => n + t.bytes, 0),
      hook_stream_bytes: hooks.bytes,
    },
  };
}

/** Sort helper: a stable comparator built from a key-tuple extractor. */
function byKeys(keyOf) {
  return (a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  };
}

// ---------------------------------------------------------------------------
// Spawns
// ---------------------------------------------------------------------------

/**
 * The spawn-to-child join, in both dialects.
 *
 * v2 (`collaboration`): the call's `arguments` carry a RELATIVE `task_name`
 * ("dup"); the `function_call_output` carries the ABSOLUTE one
 * ("/root/dup"), which is the value a child thread declares as its
 * `agent_path`. That is the join.
 *
 * v1 (`multi_agent_v1`): there is no `task_name` at all. The output carries
 * `{agent_id, nickname}` and `agent_id` IS the child's thread id. So a v1 run
 * does have a spawn join - it is keyed differently - and the golden records
 * which key resolved it rather than assuming one.
 *
 * A REFUSAL is not JSON. `dup-names` returns the literal string
 * "agent path `/root/dup` already exists", and the refused call gets NO
 * `SubAgentActivity` item, so the absence of the item is a second witness.
 */
function buildSpawn({ transcript, call, transcripts, perTranscript }) {
  let args = null;
  try {
    args = call.argumentsRaw === null ? null : JSON.parse(call.argumentsRaw);
  } catch {
    args = null;
  }
  const message = args && typeof args.message === 'string' ? args.message : null;

  const output = findCallOutput(transcripts, perTranscript, call.call_id);
  const parsedOutput = parseMaybeJson(output);

  const refused = output !== null && parsedOutput === null;
  const activity = call.item && call.item.type === 'SubAgentActivity' ? call.item.item : null;

  return {
    thread_id: transcript.ownerThreadId,
    file: transcript.basename,
    ordinal: call.ordinal,
    call_id: call.call_id,
    namespace: call.namespace,
    argument_keys: args === null ? [] : Object.keys(args).sort(),
    requested_task_name: args && typeof args.task_name === 'string' ? args.task_name : null,
    message_present: message !== null,
    message_encrypted: message !== null && message.startsWith(CIPHERTEXT_PREFIX),
    message_bytes: message === null ? 0 : Buffer.byteLength(message, 'utf8'),
    item_id: call.item ? call.item.id : null,
    item_type: call.item ? call.item.type : null,
    activity_agent_path: optionalField(activity, 'agent_path'),
    activity_agent_thread_id: activity && typeof activity.agent_thread_id === 'string'
      ? activity.agent_thread_id
      : null,
    output_present: output !== null,
    output_task_name: parsedOutput && typeof parsedOutput.task_name === 'string'
      ? parsedOutput.task_name
      : null,
    output_agent_id: parsedOutput && typeof parsedOutput.agent_id === 'string'
      ? parsedOutput.agent_id
      : null,
    output_nickname: parsedOutput && typeof parsedOutput.nickname === 'string'
      ? parsedOutput.nickname
      : null,
    refused,
    refusal_text: refused ? output : null,
    // Filled in by the caller once every thread of the run is known.
    child_thread_id: null,
    child_resolved_by: 'pending',
  };
}

/** The `function_call_output` text for a `call_id`, searched across the whole run. */
function findCallOutput(transcripts, perTranscript, callId) {
  for (const t of transcripts) {
    for (const record of t.records) {
      if (record?.type !== 'response_item') continue;
      const payload = record.payload ?? {};
      if (payload.type !== 'function_call_output') continue;
      if (payload.call_id !== callId) continue;
      if (typeof payload.output === 'string') return payload.output;
      return JSON.stringify(payload.output ?? null);
    }
  }
  return null;
}

/** JSON if it parses to an object, otherwise null. A refusal is a bare string. */
function parseMaybeJson(text) {
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hooks: the join, and liveness
// ---------------------------------------------------------------------------

/**
 * The hook tap reports a tool call under the ITEM id, not the `call_id` - the
 * field a reader reaches for first. A join written against `call_id` alone
 * silently drops every v2 shell call and reads as a Codex deficiency rather
 * than as a bug in the question.
 *
 * So this counts BOTH memberships for every hook record carrying a
 * `tool_use_id`, and reports call-only, item-only, both, neither and the union.
 * The union is the number an engine can actually achieve.
 */
function buildHookJoin(hookFile, callIds, itemIds) {
  const join = {
    stream_present: existsSync(hookFile),
    records: 0,
    malformed_lines: 0,
    events: {},
    main_thread_records: 0,
    records_with_agent_id: 0,
    records_with_tool_use_id: 0,
    envelope_tool_use_id_equals_raw: 0,
    resolves_call_id: 0,
    resolves_item_id: 0,
    resolves_call_id_only: 0,
    resolves_item_id_only: 0,
    resolves_both: 0,
    resolves_neither: 0,
    resolves_union: 0,
  };
  const liveness = {
    session_start_count: 0,
    stop_count: 0,
    subagent_start_count: 0,
    subagent_stop_count: 0,
    agents: [],
    agents_with_multiple_stops: 0,
    subagent_stops_without_a_start: 0,
  };

  if (!join.stream_present) return { join, liveness, bytes: 0 };

  const { records, malformed, bytes } = readJsonl(hookFile);
  join.malformed_lines = malformed;
  join.records = records.length;

  const agents = new Map();

  for (const record of records) {
    const eventName = String(record?.eventName ?? '');
    join.events[eventName] = (join.events[eventName] ?? 0) + 1;
    if (record?.isMainThread === true) join.main_thread_records += 1;

    const raw = record?.raw ?? {};
    const agentId = typeof record?.agentId === 'string'
      ? record.agentId
      : typeof raw.agent_id === 'string' ? raw.agent_id : null;
    if (agentId !== null) join.records_with_agent_id += 1;

    const toolUseId = typeof record?.toolUseId === 'string'
      ? record.toolUseId
      : typeof raw.tool_use_id === 'string' ? raw.tool_use_id : null;
    if (toolUseId !== null) {
      join.records_with_tool_use_id += 1;
      if (record?.toolUseId === raw.tool_use_id) join.envelope_tool_use_id_equals_raw += 1;
      const inCalls = callIds.has(toolUseId);
      const inItems = itemIds.has(toolUseId);
      if (inCalls) join.resolves_call_id += 1;
      if (inItems) join.resolves_item_id += 1;
      if (inCalls && inItems) join.resolves_both += 1;
      else if (inCalls) join.resolves_call_id_only += 1;
      else if (inItems) join.resolves_item_id_only += 1;
      else join.resolves_neither += 1;
      if (inCalls || inItems) join.resolves_union += 1;
    }

    if (eventName === 'SessionStart') liveness.session_start_count += 1;
    if (eventName === 'Stop') liveness.stop_count += 1;
    if (eventName !== 'SubagentStart' && eventName !== 'SubagentStop') continue;

    if (eventName === 'SubagentStart') liveness.subagent_start_count += 1;
    if (eventName === 'SubagentStop') liveness.subagent_stop_count += 1;

    const key = agentId ?? '';
    const entry = agents.get(key) ?? {
      agent_id: key,
      subagent_start_count: 0,
      subagent_stop_count: 0,
      stop_turn_ids: new Set(),
      turn_ids: new Set(),
      agent_transcript_path_seen: false,
    };
    if (eventName === 'SubagentStart') entry.subagent_start_count += 1;
    else {
      entry.subagent_stop_count += 1;
      if (typeof raw.turn_id === 'string') entry.stop_turn_ids.add(raw.turn_id);
      if (typeof raw.agent_transcript_path === 'string') entry.agent_transcript_path_seen = true;
    }
    if (typeof raw.turn_id === 'string') entry.turn_ids.add(raw.turn_id);
    agents.set(key, entry);
  }

  liveness.agents = [...agents.values()]
    .map((a) => ({
      agent_id: a.agent_id,
      subagent_start_count: a.subagent_start_count,
      subagent_stop_count: a.subagent_stop_count,
      distinct_turn_ids: a.turn_ids.size,
      distinct_stop_turn_ids: a.stop_turn_ids.size,
      turn_ids: [...a.turn_ids].sort(),
      agent_transcript_path_on_stop: a.agent_transcript_path_seen,
    }))
    .sort(byKeys((a) => [a.agent_id]));

  liveness.agents_with_multiple_stops = liveness.agents.filter((a) => a.subagent_stop_count > 1).length;
  liveness.subagent_stops_without_a_start = liveness.agents.filter(
    (a) => a.subagent_stop_count > 0 && a.subagent_start_count === 0,
  ).length;

  return { join, liveness, bytes };
}

// ---------------------------------------------------------------------------
// Redaction surface (G4)
// ---------------------------------------------------------------------------

/**
 * G4 evidence: WHERE the reasoning and ciphertext live, and HOW MUCH of it
 * there is - never the bytes. Phase 2's engine must drop all of this at the
 * parse boundary, and a golden that quoted a single ciphertext string would put
 * the thing being dropped into a tracked file.
 *
 * `encrypted_bytes_copied_into_golden` is 0 by construction and is asserted by
 * `assertNoLeakage`, which refuses to emit any string carrying the prefix.
 */
function buildRedaction(transcripts, spawns) {
  const sites = new Map();
  let reasoningResponseItems = 0;
  let reasoningCompletedItems = 0;
  let reasoningWithNonEmptySummary = 0;
  let encryptedBytes = 0;

  const visit = (value, label) => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'string' && value.startsWith(CIPHERTEXT_PREFIX)) {
        const site = sites.get(label) ?? { count: 0, bytes: 0 };
        site.count += 1;
        site.bytes += Buffer.byteLength(value, 'utf8');
        sites.set(label, site);
        encryptedBytes += Buffer.byteLength(value, 'utf8');
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, `${label}[]`);
      return;
    }
    for (const key of Object.keys(value)) visit(value[key], `${label}.${key}`);
  };

  for (const transcript of transcripts) {
    for (const record of transcript.records) {
      const label = recordLabel(record);
      if (label === 'response_item/reasoning') {
        reasoningResponseItems += 1;
        const summary = record.payload?.summary;
        if (Array.isArray(summary) && summary.length > 0) reasoningWithNonEmptySummary += 1;
      }
      if (label === 'event_msg/item_completed/Reasoning') reasoningCompletedItems += 1;
      visit(record?.payload ?? null, label);

      // A tool call's `arguments` is a JSON STRING, so a structural walk over
      // the parsed record never descends into it - and that is exactly where
      // the v2 dialect puts its ciphertext. Measured on this corpus: 9
      // `spawn_agent` messages and 3 `send_message` messages, 12 strings a
      // walk alone does not see. Parse and descend, or the G4 count
      // under-reports by a fifth while looking thorough.
      const payload = record?.payload ?? null;
      if (payload !== null && typeof payload.arguments === 'string') {
        let parsed = null;
        try {
          parsed = JSON.parse(payload.arguments);
        } catch {
          parsed = null;
        }
        if (parsed !== null) visit(parsed, `${label}.arguments{${String(payload.name ?? '')}}`);
      }
    }
  }

  return {
    reasoning_response_items: reasoningResponseItems,
    reasoning_completed_items: reasoningCompletedItems,
    reasoning_with_non_empty_summary: reasoningWithNonEmptySummary,
    ciphertext_sites: [...sites.entries()]
      .map(([field_path, site]) => ({ field_path, count: site.count, bytes: site.bytes }))
      .sort(byKeys((s) => [s.field_path])),
    ciphertext_strings: [...sites.values()].reduce((n, s) => n + s.count, 0),
    ciphertext_bytes: encryptedBytes,
    // The spawn `message` is ciphertext in v2 and PLAINTEXT in v1. Counted here
    // because it is the one place a user prompt can reach a subagent in the
    // clear, and Phase 2 must not preview it either way.
    spawn_messages_encrypted: spawns.filter((s) => s.message_encrypted).length,
    spawn_messages_plaintext: spawns.filter((s) => s.message_present && !s.message_encrypted).length,
    encrypted_bytes_copied_into_golden: 0,
  };
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

export function buildCorpusGolden(corpusName, corpusDir, listFiles = readdirSync) {
  const runNames = listRuns(corpusDir);
  const runs = runNames.map((name) => buildRun(corpusDir, name, listFiles));

  const anchorVersion = corpusName.slice(CORPUS_PREFIX.length);
  const versions = new Set();
  for (const run of runs) for (const thread of run.threads) versions.add(thread.cli_version);
  if (versions.size !== 1 || !versions.has(anchorVersion)) {
    // G9's harvest rule applied to the reference reader: a corpus whose records
    // disagree with its directory name is not a corpus for that version.
    throw new Error(
      `${corpusName}: cli_version set is {${[...versions].sort().join(', ')}}, expected {${anchorVersion}}`,
    );
  }

  const dialects = {};
  const dialectSources = {};
  for (const run of runs) {
    dialects[run.dialect] = (dialects[run.dialect] ?? 0) + 1;
    dialectSources[run.dialect_source] = (dialectSources[run.dialect_source] ?? 0) + 1;
  }

  const sum = (pick) => runs.reduce((n, run) => n + pick(run), 0);

  return {
    schema: SCHEMA,
    corpus: corpusName,
    anchor_cli_version: anchorVersion,
    generator: 'scripts/codex-golden.mjs',
    runs,
    summary: {
      run_count: runs.length,
      dialects,
      dialect_sources: dialectSources,
      transcripts: sum((r) => r.transcripts.length),
      records: sum((r) => r.transcripts.reduce((n, t) => n + t.records, 0)),
      malformed_lines: sum((r) => r.transcripts.reduce((n, t) => n + t.malformed_lines, 0)),
      threads: sum((r) => r.threads.length),
      max_depth: runs.reduce(
        (best, r) => (r.thread_summary.max_depth !== null && r.thread_summary.max_depth > best ? r.thread_summary.max_depth : best),
        0,
      ),
      spawns: sum((r) => r.spawns.length),
      spawns_refused: sum((r) => r.spawn_summary.refused),
      spawns_resolved_to_child: sum((r) => r.spawn_summary.resolved_to_child),
      tool_calls: sum((r) => r.tool_calls.length),
      tool_calls_item_id_equals_call_id: sum((r) => r.tool_call_summary.by_id_relation.item_id_equals_call_id),
      tool_calls_item_id_distinct: sum((r) => r.tool_call_summary.by_id_relation.item_id_distinct_from_call_id),
      tool_calls_without_item: sum((r) => r.tool_call_summary.by_id_relation.no_item),
      hook_records: sum((r) => r.hook_join.records),
      hook_records_with_tool_use_id: sum((r) => r.hook_join.records_with_tool_use_id),
      hook_resolves_call_id: sum((r) => r.hook_join.resolves_call_id),
      hook_resolves_item_id: sum((r) => r.hook_join.resolves_item_id),
      hook_resolves_union: sum((r) => r.hook_join.resolves_union),
      hook_resolves_neither: sum((r) => r.hook_join.resolves_neither),
      subagent_starts: sum((r) => r.liveness.subagent_start_count),
      subagent_stops: sum((r) => r.liveness.subagent_stop_count),
      agents_with_multiple_stops: sum((r) => r.liveness.agents_with_multiple_stops),
      subagent_stops_without_a_start: sum((r) => r.liveness.subagent_stops_without_a_start),
      reasoning_response_items: sum((r) => r.redaction.reasoning_response_items),
      ciphertext_strings: sum((r) => r.redaction.ciphertext_strings),
      ciphertext_bytes: sum((r) => r.redaction.ciphertext_bytes),
      longest_record_bytes: runs.reduce((best, r) => Math.max(best, r.sizes.longest_record_bytes), 0),
    },
  };
}

/** Produce the golden TEXT for one corpus directory name. Reads only. */
export function generate(corpusName, fixturesDir = FIXTURES_DIR, listFiles = readdirSync) {
  const corpusDir = path.join(fixturesDir, corpusName);
  return goldenText(buildCorpusGolden(corpusName, corpusDir, listFiles));
}

export function goldenPath(corpusName, fixturesDir = FIXTURES_DIR) {
  return path.join(fixturesDir, corpusName, 'golden.json');
}

/** sha256 of a string, for the WROTE line. Not part of the golden. */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function main(argv) {
  const check = argv.includes('--check');
  const corpusFlag = argv.indexOf('--corpus');
  const outFlag = argv.indexOf('--out');
  const names = corpusFlag >= 0 ? [path.basename(argv[corpusFlag + 1] ?? '')] : listCorpora();
  if (names.length === 0) {
    process.stderr.write(`no ${FIXTURES_DIR}${path.sep}${CORPUS_PREFIX}* corpus found\n`);
    return 1;
  }
  let failed = 0;
  for (const name of names) {
    const text = generate(name);
    const out = outFlag >= 0 ? argv[outFlag + 1] : goldenPath(name);
    if (check) {
      const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
      if (current === text) {
        // BYTES, not `text.length`: the golden can carry multi-byte characters.
        process.stdout.write(`OK      ${name}/golden.json (${Buffer.byteLength(text, 'utf8')} bytes)\n`);
      } else {
        failed++;
        process.stdout.write(`STALE   ${name}/golden.json - regenerate\n`);
      }
    } else {
      writeFileSync(out, text, 'utf8');
      process.stdout.write(
        `WROTE   ${out} (${Buffer.byteLength(text, 'utf8')} bytes, sha256 ${sha256(text)})\n`,
      );
    }
  }
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
