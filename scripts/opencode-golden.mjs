/**
 * `scripts/opencode-golden.mjs` — the OpenCode golden generator (PLAN.md DoD 3.4).
 *
 * Emits `fixtures/opencode-<version>/golden.json`: the expected `SessionState`
 * tree for a captured OpenCode corpus, in the same canonical serialization the
 * Claude Code goldens under `fixtures/golden/` use.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS STANDALONE, AND WHY THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 *
 * DoD 3.4 says the golden is produced "through a documented manual procedure
 * this once (no parser exists yet)" and that "Phase 4 must reproduce it through
 * the production path". `src/opencode/` does not exist while this runs.
 *
 * So this file imports NOTHING from `src/`. Not the parser, not the redactor,
 * not the grafter. Every mapping decision below is derived from
 * `docs/opencode-contract.md` (sections §1-§10 plus the appended
 * `Amendment 2026-08-26 - Phase 2 kill gate`, cited as "amendment §X") and from
 * `agent-deck-spec.md`'s `Amendment 2026-08-27 - Second observation source:
 * OpenCode` (cited as OC1..OC9), with the citation written at the decision.
 *
 * If Phase 4's engine and this generator ever agree only because they share
 * code, the golden proves nothing. The duplication is deliberate.
 *
 * The one thing this file deliberately COPIES rather than derives is the
 * truncation ceiling and marker text of `src/parser/redact.ts`. OC6 says tool
 * payloads "go through the existing `redact.ts` ceiling" - it is the same
 * redaction module for both engines, so the marker is a contract to match, not
 * a decision to re-take. `src/release/opencode-golden.test.ts` asserts the two
 * constants still agree with `redact.ts`, so a change there fails here.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *
 *     node scripts/opencode-golden.mjs                 # every corpus, write
 *     node scripts/opencode-golden.mjs --check         # every corpus, compare only
 *     node scripts/opencode-golden.mjs --corpus fixtures/opencode-1.18.22
 *
 * Exit 0 on success; exit 1 if `--check` finds a golden that is not what the
 * generator produces today.
 *
 * G1: the corpus database is opened `{ readOnly: true }` and every statement is
 * a `SELECT`. Nothing under a corpus directory is written except
 * `golden.json`.
 *
 * NOTE: no shebang, deliberately. vite's hashbang strip is `/^#!.*\n/` and `.`
 * does not match `\r`, so a shebang breaks vitest COLLECTION in a CRLF
 * checkout only - green for whoever wrote it, `SyntaxError` for everyone else.
 * `scripts/privacy-sweep.mjs` has none either.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');

// ---------------------------------------------------------------------------
// Constants copied from src/parser/redact.ts (OC6: one redaction module, two
// engines). Asserted equal to their source by the test file.
// ---------------------------------------------------------------------------

/** `DEFAULT_MAX_PAYLOAD_BYTES` in `src/parser/redact.ts`. */
export const PREVIEW_BYTES = 8 * 1024;

/** `truncationMarker()` in `src/parser/redact.ts`, character for character. */
export function truncationMarker(keptBytes, originalBytes) {
  return `\n...[agent-deck: truncated, showing ${keptBytes} of ${originalBytes} bytes]`;
}

/**
 * The UTF-8-boundary-safe cut of `truncateUtf8()` in `src/parser/redact.ts`.
 *
 * Cut ONCE. The recorded defect is that a payload cut twice - once by the
 * parser and again by a preview - produces a marker stating the intermediate
 * length as the original, under-reporting the true size by up to 7.73x on the
 * committed CC capture. This generator applies the ceiling exactly once, to the
 * raw stored payload, so every marker states the real original byte count.
 */
export function truncateOnce(text, maxBytes = PREVIEW_BYTES) {
  const buf = Buffer.from(text, 'utf8');
  const originalBytes = buf.length;
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, keptBytes: originalBytes, originalBytes };
  }
  // `end` is the index of the first EXCLUDED byte; walk back off any UTF-8
  // continuation byte (0b10xxxxxx) so a code point is never split.
  let end = maxBytes;
  while (end > 0) {
    const byte = buf[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end--;
  }
  const kept = buf.subarray(0, end).toString('utf8');
  return {
    text: kept + truncationMarker(end, originalBytes),
    truncated: true,
    keptBytes: end,
    originalBytes,
  };
}

/**
 * `sha256:<first 16 hex>:<utf8 byte length>` - the house preview convention
 * (`previewFingerprint()` in `src/model/graft.ts`, documented in
 * `fixtures/golden/session/README.md` rule 3).
 *
 * Previews are pinned by digest rather than verbatim because OpenCode tool
 * inputs and outputs embed the capturing machine's absolute paths, and a golden
 * containing those only reproduces on that machine. The digest still fails on a
 * one-byte change, and the trailing byte length is what makes the truncation
 * above VISIBLE in the file: a payload of 88,478 bytes shows as `:8248`, not as
 * `:88478`.
 */
export function previewFingerprint(text) {
  if (text === undefined) return null;
  const bytes = Buffer.from(text, 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}:${bytes.byteLength}`;
}

// ---------------------------------------------------------------------------
// Redaction (G4 / OC6)
// ---------------------------------------------------------------------------

/**
 * Fields dropped wherever they appear, by field policy rather than by
 * observation.
 *
 * OC6: "Provider `signature` and provider metadata are dropped too, by field
 * policy rather than by observation. The measured provider (`qwen-local`)
 * writes no `signature`; another may (contract §4), and a redaction rule that
 * only covers what one provider happened to emit is not a rule."
 */
export const DROPPED_FIELDS = new Set(['signature', 'thinking', 'redacted_thinking']);

/**
 * Part types dropped whole at the parse boundary.
 *
 * OC6: "`reasoning` parts are dropped at the parse boundary, before any record
 * reaches the session model". Contract §4: for OpenCode the thinking bytes are
 * in `part.data.text`, verbatim - the inverse of the CC trap where the text is
 * empty and the bytes sit in `signature`.
 */
export const DROPPED_PART_TYPES = new Set(['reasoning']);

/** Recursively strip {@link DROPPED_FIELDS}. Returns a new value. */
export function stripDroppedFields(value) {
  if (Array.isArray(value)) return value.map(stripDroppedFields);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (DROPPED_FIELDS.has(key)) continue;
    out[key] = stripDroppedFields(value[key]);
  }
  return out;
}

/**
 * Canonical JSON with sorted keys.
 *
 * Tool `state.input` is an object, and a preview of it has to be a string. Key
 * order in the stored JSON is OpenCode's business and could change between
 * releases without the content changing, so the preview sorts keys. Phase 4
 * must sort too; that is recorded in `fixtures/opencode-1.18.22/GOLDEN.md`.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Reading the corpus
// ---------------------------------------------------------------------------

/**
 * Every row the mapping needs, read in one pass.
 *
 * SQLite `LIKE` is CASE-INSENSITIVE and is not used anywhere here; nothing in
 * this file does a string match in SQL at all. Integers are read as BigInt
 * (`setReadBigInts`) so no millisecond timestamp passes through a float, then
 * narrowed to Number at the one place a JSON number is required - matching what
 * `scripts/capture-opencode.mjs` does.
 */
export function readCorpus(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const project = db.prepare('SELECT id, worktree, vcs FROM project ORDER BY id');
    project.setReadBigInts(false);
    const sessionStmt = db.prepare(
      'SELECT id, project_id, parent_id, slug, directory, title, version, agent, model, cost,' +
        ' tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,' +
        ' time_created, time_updated, time_archived FROM session ORDER BY time_created, id',
    );
    sessionStmt.setReadBigInts(true);
    const partStmt = db.prepare(
      'SELECT id, message_id, session_id, time_created, time_updated, data FROM part' +
        ' ORDER BY time_created, id',
    );
    partStmt.setReadBigInts(true);
    const sessions = sessionStmt.all().map((r) => ({
      id: r.id,
      projectId: r.project_id,
      parentId: r.parent_id,
      slug: r.slug,
      directory: r.directory,
      title: r.title,
      version: r.version,
      agent: r.agent,
      model: r.model,
      cost: Number(r.cost),
      tokensInput: Number(r.tokens_input),
      tokensOutput: Number(r.tokens_output),
      timeCreated: Number(r.time_created),
      timeUpdated: Number(r.time_updated),
      timeArchived: r.time_archived === null ? null : Number(r.time_archived),
    }));

    const parts = partStmt.all().map((r) => ({
      id: r.id,
      messageId: r.message_id,
      sessionId: r.session_id,
      timeCreated: Number(r.time_created),
      timeUpdated: Number(r.time_updated),
      raw: r.data,
    }));

    return { projects: project.all(), sessions, parts };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

/**
 * `part.data.state.status` -> `ToolNode.status`.
 *
 * Contract §4 measures exactly three `state.status` values in the live
 * database: `running`, `completed`, `error`. `ToolNode.status` (src/model/
 * events.ts) is `'running' | 'done' | 'error'`. The map is one to one, with
 * `completed` renamed to the model's `done`.
 *
 * An unmeasured status is NOT guessed into one of the three (G3): it is
 * reported by the caller, which aborts. A silent default would render a wrong
 * tree, which is exactly what "refuse, don't guess" exists to prevent.
 */
export function toolStatus(status) {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'done';
  if (status === 'error') return 'error';
  return undefined;
}

/**
 * Build the `ToolNode` for one `tool` part.
 *
 * Contract §9 maps CC's `tool_use` / `tool_result` blocks onto `part` type
 * `tool` with `state.status` / `state.input` / `state.output`. Contract §4
 * gives the row shape; contract amendment §D records that `callID` is a join
 * key OpenCode itself uses (`tool.execute.before`/`after` carry `sessionID` and
 * `callID`), which is why `ToolNode.id` - documented in events.ts as "the graft
 * key" - is the `callID` and not the `prt_*` row id.
 */
export function toToolNode(part, data) {
  const state = data.state ?? {};
  const status = toolStatus(state.status);
  if (status === undefined) {
    throw new Error(`unmapped tool state.status ${JSON.stringify(state.status)} on ${part.id}`);
  }

  // `state.input` is an object; the preview is its canonical JSON, cut once.
  const inputText = canonicalJson(stripDroppedFields(state.input ?? null));

  /*
   * `resultPreview` source, in order:
   *   1. `state.output` - a string, present once completed (contract §4).
   *   2. `state.error`  - a string, measured on all 27 error parts of the
   *      anchor, which carry no `output` at all. Contract §4 names `error` as
   *      one of the three measured statuses but does not name the field; the
   *      field is measured, and mapping the failure text to the result preview
   *      is the direct analogue of a CC error `tool_result`. Recorded as a
   *      generator decision in GOLDEN.md, not as a contract citation.
   *   3. neither - the preview is omitted (a `running` tool has no result).
   */
  const outputText =
    typeof state.output === 'string'
      ? state.output
      : typeof state.error === 'string'
        ? state.error
        : undefined;

  const start = state.time?.start;
  const end = state.time?.end;
  const durationMs =
    typeof start === 'number' && typeof end === 'number' ? end - start : undefined;

  const inputCut = truncateOnce(inputText);
  const outputCut = outputText === undefined ? undefined : truncateOnce(outputText);

  /*
   * `state.metadata.truncated` - OPENCODE'S OWN truncation claim (contract
   * §8.4, "the flag to trust"). It has a `ToolNode` field as of Phase 5's gate
   * amendment B7; before that there was nowhere to put it and the golden did
   * not represent it (GOLDEN.md DEVIATION 5).
   *
   * All three states are carried and they are three different facts: `true`
   * and `false` are both CLAIMS OpenCode made, and an absent key is no claim -
   * which is not the same as "the payload is whole". An absent key serializes
   * as `null` below, exactly as an absent `durationMs` does.
   *
   * A non-boolean is treated as no claim rather than coerced. Unlike the
   * unmapped `state.status` above this does NOT abort the generator: a status
   * decides which of three node states to render and there is no honest
   * default, whereas "OpenCode said nothing usable about truncation" is
   * representable, and it is exactly what an absent key already means.
   */
  const truncated =
    typeof state.metadata?.truncated === 'boolean' ? state.metadata.truncated : undefined;

  return {
    id: data.callID,
    toolName: data.tool,
    status,
    inputPreview: inputCut.text,
    resultPreview: outputCut === undefined ? undefined : outputCut.text,
    durationMs,
    truncated,
    _inputTruncated: inputCut.truncated,
    _resultTruncated: outputCut !== undefined && outputCut.truncated,
    // Not part of ToolNode; used to place the node and to build the join.
    _partId: part.id,
    _sessionId: part.sessionId,
    _order: [part.timeCreated, part.id],
    _taskChildSessionId:
      data.tool === 'task' && typeof state.metadata?.sessionId === 'string' && state.metadata.sessionId
        ? state.metadata.sessionId
        : undefined,
    _taskParentSessionId:
      data.tool === 'task' && typeof state.metadata?.parentSessionId === 'string'
        ? state.metadata.parentSessionId
        : undefined,
  };
}

/**
 * `AgentNode.label` - OC3: "`session.agent` + `session.title` fill
 * `AgentNode.label`, replacing CC's `meta.agentType` + `meta.description`".
 *
 * The separator is `': '`, matching the CC goldens' `"Explore: List contents of
 * spike/"`. `agent` is nullable in the schema; an absent agent yields the title
 * alone rather than a `": "` prefix on nothing.
 */
export function agentLabel(session) {
  const agent = typeof session.agent === 'string' && session.agent ? session.agent : undefined;
  return agent === undefined ? session.title : `${agent}: ${session.title}`;
}

/**
 * `SessionState.projectSlug` for an OpenCode session.
 *
 * `PLAN.md` Phase 4 `Amendment 2026-08-27 - projectSlug, liveness proof,
 * coverage law`, item A1. It **supersedes** OC7's "Open item, for Phase 5 to
 * decide" and this file's own earlier note that the goldens carry `''` as a
 * placeholder; the decision was taken before Phase 4 implementation started.
 *
 * The decision: `projectSlug` means "the project key" for both engines, and
 * the OpenCode value is the slug derived from `project.worktree` by the same
 * rule Claude Code uses to name its `~/.claude/projects/<slug>` directory. One
 * workspace observed by two engines therefore carries one key, and the value
 * these goldens hold is byte-identical to the one `fixtures/golden/session/`'s
 * CC goldens already hold for the same workspace.
 *
 * The rule, and the one place it differs from `slugifyWorkspace()` in
 * `src/parser/tailer.ts`: strip trailing separators, map `:`, `\` and `/` to
 * `-`, then LOWER-CASE THE DRIVE LETTER AND NOTHING ELSE. The two sides of the
 * pin are `C:/Users/.../agent-deck` (the `worktree` column, upper-case drive)
 * and `c--Users-...-agent-deck` (the captured CC slug directory, lower-case
 * drive). Exactly one character differs and every other component keeps its
 * case, which is why nothing else is lower-cased.
 *
 * **This is a duplicate of `src/opencode/slug.ts` on purpose**, in the same way
 * and for the same reason the truncation ceiling above is a duplicate of
 * `src/parser/redact.ts`: this file imports nothing from `src/`, so that the
 * golden and the engine cannot agree merely by sharing code.
 * `src/release/opencode-golden.test.ts` asserts the value against the CC slug
 * directory name read off disk, so the duplication is checked rather than
 * trusted.
 */
export function slugFromWorktree(worktreePath) {
  const trimmed = worktreePath.replace(/[\\/]+$/, '');
  const slug = trimmed.replace(/[:\\/]/g, '-');
  // Keyed on the ORIGINAL path carrying a drive letter, not on the slug's first
  // two characters: after the substitution a relative path such as `A/b` is
  // indistinguishable from a drive, and lower-casing its first component would
  // be a silent rewrite of a name rather than a drive-letter normalisation.
  return /^[A-Za-z]:/.test(worktreePath) ? slug[0].toLowerCase() + slug.slice(1) : slug;
}

/**
 * `SessionState.liveness` for a STATIC corpus.
 *
 * OC4: the tap is the `event` table polled by cursor - "a new seq inside the
 * 120 s threshold reads as live". A committed fixture is a file: no seq can
 * ever advance while it is being read, so **no session in a golden can be
 * `live`**, and a golden that claimed one would be claiming a wall-clock fact.
 * That is what keeps this value out of `fixtures/golden/session/README.md`
 * rule 2's "no wall-clock values" prohibition.
 *
 * What remains is decided by the data alone:
 *   - `time_archived` set -> `ended` (OC4, explicit).
 *   - otherwise -> `idle`.
 *
 * `unsupported` is what a fingerprint refusal produces (G3, OC2). Nothing here
 * refuses: see `schemaOk` in {@link buildSessionState}.
 *
 * MEASURED GAP: `time_archived` is NULL on all 24 anchor sessions and all 5
 * witness sessions, so the `ended` branch is unexercised by this corpus.
 * Recorded in GOLDEN.md rather than papered over.
 */
export function sessionLiveness(session) {
  return session.timeArchived === null ? 'idle' : 'ended';
}

/**
 * `AgentNode.status` for a session.
 *
 * OC4: "a `tool` part whose `state.status` is `running` with no `state.time.end`
 * -> running". Otherwise, for a subagent, the spawning `task` part's own status
 * is the honest answer - it is the parent's record of how the child ended - and
 * for a root session with nothing running there is nothing left to say but
 * `done`.
 *
 * MEASURED GAP: the anchor has 0 `running` tool parts (219 completed, 27 error)
 * and 0 parts missing `state.time.end`, so the `running` branch is unexercised.
 * Recorded in GOLDEN.md.
 */
export function agentStatus({ toolNodes, spawningTask }) {
  if (toolNodes.some((t) => t.status === 'running')) return 'running';
  if (spawningTask !== undefined) return spawningTask.status === 'error' ? 'error' : 'done';
  return 'done';
}

/**
 * Build one `SessionState` per ROOT session (a `session` row with a NULL
 * `parent_id`), with every descendant session grafted in as an `AgentNode`.
 *
 * Contract §9: `subagents/agent-<id>.jsonl` + `.meta.json` maps onto
 * `session.parent_id` rows + the `task` part join. A child session is therefore
 * a subagent INSIDE its parent's session, exactly as a CC subagent transcript
 * is - not a deck entry of its own.
 */
export function buildCorpusGolden({ corpusName, dataVersion, corpus }) {
  const { sessions, parts, projects } = corpus;

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const childrenOf = new Map();
  for (const s of sessions) {
    if (!s.parentId) continue;
    if (!childrenOf.has(s.parentId)) childrenOf.set(s.parentId, []);
    childrenOf.get(s.parentId).push(s);
  }

  // --- parse + redact every part once -------------------------------------
  const counts = {
    partRows: parts.length,
    partsMalformed: 0,
    reasoningPartsDropped: 0,
    partsIgnoredNoNode: 0,
    toolParts: 0,
    taskParts: 0,
    taskPartsJoined: 0,
    taskPartsParked: 0,
    previewsTruncated: 0,
  };

  const toolsBySession = new Map();
  const taskParts = [];

  for (const part of parts) {
    let data;
    try {
      data = JSON.parse(part.raw);
    } catch {
      // G3: malformed input increments a counter and is skipped, never throws.
      counts.partsMalformed++;
      continue;
    }
    // G4 / OC6: reasoning parts are dropped at the parse boundary. This is a
    // real code path with a counter, not an omission by oversight - the bytes
    // are read off disk and thrown away here.
    if (DROPPED_PART_TYPES.has(data.type)) {
      if (data.type === 'reasoning') counts.reasoningPartsDropped++;
      continue;
    }
    // Contract §4 measures seven part types. Only `tool` produces a node:
    // `text`, `step-start`, `step-finish`, `patch` and `compaction` have no
    // counterpart in `AgentNode`/`ToolNode` (src/model/events.ts). They are
    // IGNORED, not refused - the CC unknown-field rule, OC2. The `compaction`
    // part with `tail_start_id` (contract amendment §E) lands here: its
    // presence must not change the tree and must not refuse the session.
    if (data.type !== 'tool') {
      counts.partsIgnoredNoNode++;
      continue;
    }
    counts.toolParts++;
    const node = toToolNode(part, data);
    if (node.toolName === 'task') {
      counts.taskParts++;
      taskParts.push(node);
    }
    if (!toolsBySession.has(part.sessionId)) toolsBySession.set(part.sessionId, []);
    toolsBySession.get(part.sessionId).push(node);
  }

  // --- the subagent join (OC3, contract §5) -------------------------------
  /** child session id -> the `task` node that spawned it. */
  const spawningTask = new Map();
  /** parked entries, per root session id. */
  const parkedBySession = new Map();

  for (const task of taskParts) {
    const childId = task._taskChildSessionId;
    if (childId === undefined) {
      // OC3, contract amendment §G: 9 of 30 `task` parts carry no
      // `state.metadata.sessionId`. Absence PARKS with a stable code. It is not
      // guessed from timing, and it is not a disagreement.
      counts.taskPartsParked++;
      const list = parkedBySession.get(task._sessionId) ?? [];
      list.push({
        // See GOLDEN.md "The parked case": `ParkedGraft.agentId` names the
        // agent that did not graft, and the whole point of this case is that
        // no agent id exists. The `prt_*` row id is the only stable identity
        // the data offers for the thing that was parked. Phase 4 owns whether
        // the interface should carry a part id instead.
        agentId: task._partId,
        code: 'taskWithoutChild',
        toolUseId: task.id,
        reason:
          'task part carries no state.metadata.sessionId; no child session to attach ' +
          '(contract amendment §G) - not inferred from timing (OC3)',
      });
      parkedBySession.set(task._sessionId, list);
      continue;
    }
    const child = byId.get(childId);
    // Cross-assert all three keys (contract §5, OC3). A disagreement parks with
    // a DIFFERENT code from an absence: "a missing key and a contradicted key
    // are different stories and get different codes".
    const agrees =
      child !== undefined &&
      child.parentId === task._sessionId &&
      task._taskParentSessionId === task._sessionId;
    if (!agrees) {
      const list = parkedBySession.get(task._sessionId) ?? [];
      list.push({
        agentId: childId,
        code: 'joinKeyContradiction',
        toolUseId: task.id,
        reason:
          'task state.metadata.sessionId, state.metadata.parentSessionId and the child ' +
          "session's parent_id do not agree (contract §5)",
      });
      parkedBySession.set(task._sessionId, list);
      continue;
    }
    if (spawningTask.has(childId)) {
      // Two task parts naming one child. G3: a contradicted key parks, it does
      // not pick a winner. Unexercised by both corpora (20 task parts, 20
      // distinct children in the anchor; 1 and 1 in the witness).
      const list = parkedBySession.get(task._sessionId) ?? [];
      list.push({
        agentId: childId,
        code: 'ambiguousJoinKey',
        toolUseId: task.id,
        reason: 'more than one task part names this child session (contract §5)',
      });
      parkedBySession.set(task._sessionId, list);
      continue;
    }
    counts.taskPartsJoined++;
    spawningTask.set(childId, task);
  }

  // --- assemble one SessionState per root session -------------------------
  const roots = sessions.filter((s) => !s.parentId);
  const states = [];
  const seenSessionRows = new Set();

  for (const root of roots) {
    states.push(
      buildSessionState({
        root,
        childrenOf,
        toolsBySession,
        spawningTask,
        parkedBySession,
        projects,
        counts,
        seenSessionRows,
      }),
    );
  }

  // Every `session` row must be reachable: a root, or an AgentNode under one.
  // A row reachable through neither would be a session silently dropped, which
  // is the failure this whole exercise exists to make visible.
  const orphans = sessions.filter((s) => !seenSessionRows.has(s.id)).map((s) => s.id);
  if (orphans.length > 0) {
    throw new Error(`session rows reachable from no root: ${orphans.join(', ')}`);
  }

  return {
    schema: 'agent-deck/opencode-golden@1',
    generator: 'scripts/opencode-golden.mjs',
    generatedFrom: `fixtures/${corpusName}/opencode.db`,
    /**
     * OC5: "The anchor is the data's per-session `session.version`. Never the
     * binary's." Every session in a corpus carries the same one - the capture
     * partitions by it - and the directory is named for it.
     */
    dataVersion,
    /** OC7: every session here was observed by the OpenCode engine. */
    engine: 'opencode',
    previewBytes: PREVIEW_BYTES,
    counts: {
      sessionRows: sessions.length,
      rootSessions: roots.length,
      childSessions: sessions.length - roots.length,
      ...counts,
    },
    sessions: states,
  };
}

function buildSessionState(ctx) {
  const {
    root,
    childrenOf,
    toolsBySession,
    spawningTask,
    parkedBySession,
    projects,
    counts,
    seenSessionRows,
  } = ctx;

  const spawnEdges = [];
  const parked = [];
  const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  /** Recursively build the AgentNode for `session` at `depth`. */
  const buildAgent = (session, depth) => {
    seenSessionRows.add(session.id);
    totals.inputTokens += session.tokensInput;
    totals.outputTokens += session.tokensOutput;
    totals.costUsd += session.cost;

    const nodeId = depth === 0 ? 'root' : session.id;
    const tools = (toolsBySession.get(session.id) ?? [])
      .slice()
      .sort((a, b) => (a._order[0] - b._order[0]) || (a._order[1] < b._order[1] ? -1 : 1));

    for (const entry of parkedBySession.get(session.id) ?? []) parked.push(entry);

    const children = [];
    for (const tool of tools) {
      children.push(tool);
      // A subagent AgentNode sits BESIDE the tool call that spawned it, never
      // inside it: `ToolNode` has no `children` field and that stays true
      // (src/model/events.ts, `SessionState.spawnEdges`). Placing it
      // immediately after its spawning tool node is what the CC grafter does
      // and what `fixtures/golden/session/*.json` shows.
      const child = (childrenOf.get(session.id) ?? []).find(
        (c) => spawningTask.get(c.id) === tool,
      );
      if (child === undefined) continue;
      spawnEdges.push({
        // OC3: the join is `task` part -> child session, by primary key. The
        // `toolUseId` slot carries OpenCode's `callID`, which is the same thing
        // `tool_use_id` is for CC.
        toolUseId: tool.id,
        agentId: child.id,
        parentNodeId: nodeId,
        depth: depth + 1,
        // `SpawnEdge.recordedDepth` is "`spawnDepth` as written in the sidecar,
        // kept even when it disagrees". OpenCode records NO depth anywhere -
        // depth is walked from `parent_id` (OC3, "Depth comes from the data,
        // not from a cap") - so there is no independent value that could
        // disagree, and this equals `depth` by construction. Flagged in
        // GOLDEN.md as a field that says nothing for this engine.
        recordedDepth: depth + 1,
      });
      children.push(buildAgent(child, depth + 1));
    }

    // A child that joined but whose spawning task part lives in a different
    // session would be unreachable above; catch it rather than dropping it.
    for (const child of childrenOf.get(session.id) ?? []) {
      if (seenSessionRows.has(child.id)) continue;
      const task = spawningTask.get(child.id);
      if (task === undefined) {
        parked.push({
          agentId: child.id,
          code: 'noSpawningTaskPart',
          reason:
            'child session names a parent_id but no task part in that parent joins to it ' +
            '(contract §5)',
        });
        seenSessionRows.add(child.id);
        continue;
      }
      throw new Error(`child ${child.id} joined a task part outside its parent session`);
    }

    const status = agentStatus({
      toolNodes: tools,
      spawningTask: depth === 0 ? undefined : spawningTask.get(session.id),
    });

    return {
      _agent: true,
      id: nodeId,
      kind: depth === 0 ? 'main' : 'subagent',
      label: agentLabel(session),
      status,
      spawnDepth: depth,
      children,
      tokens: { in: session.tokensInput, out: session.tokensOutput },
      startedAt: session.timeCreated,
      /*
       * `endedAt`: OC4 makes `time_archived` the session-end signal. It is NULL
       * throughout both corpora, so the fallback carries every row here:
       * `time_updated` is the last write to the session (contract §3 lists it
       * as a read column), which for a session that is not running IS when it
       * stopped changing. A running agent has no end and the field is omitted
       * rather than filled.
       */
      endedAt:
        status === 'running' ? undefined : (session.timeArchived ?? session.timeUpdated),
    };
  };

  const rootNode = buildAgent(root, 0);

  const project = projects.find((p) => p.id === root.projectId);

  const state = {
    sessionId: root.id,
    /*
     * CLOSED 2026-08-27 by `PLAN.md` Phase 4 `Amendment 2026-08-27 -
     * projectSlug, liveness proof, coverage law`, item A1.
     *
     * This line used to carry `''` and a note that OC7 left the question open
     * for Phase 5. That note is superseded: the value is the CC slug derived
     * from `project.worktree`, so one workspace observed by two engines carries
     * one project key. See {@link slugFromWorktree} for the rule and for why
     * this file implements it rather than importing `src/opencode/slug.ts`.
     *
     * `fixtures/golden/session/README.md` rule 1 is unchanged and still
     * satisfied: it forbids a filesystem PATH in a golden - a drive letter,
     * `/Users/`, `.claude`, a Windows separator - and a slug is none of those.
     * It is fixture content, byte-identical to the `projectSlug` the CC goldens
     * beside it already carry, and reproducible from the committed corpus on
     * any machine.
     *
     * A root session whose `project` row is absent yields `''`, which is the
     * honest answer: there is no worktree to derive a key from.
     */
    projectSlug: project === undefined ? '' : slugFromWorktree(project.worktree),
    /** OC7: additive and optional; absence reads as `'cc'`, so it is written. */
    engine: 'opencode',
    /*
     * OC8: the match is `project.worktree`, case-insensitively, against the
     * open workspace folders. That is an input from the host, not a fact in the
     * database - the golden fixes it to the workspace the corpus was captured
     * from, which is this repository (`project.worktree` =
     * <repo root>, asserted at capture by the G8 check in
     * `scripts/capture-opencode.mjs`). Every session in both corpora belongs to
     * that one project row, so the value is uniform.
     */
    workspaceMatch: project !== undefined,
    liveness: sessionLiveness(root),
    /*
     * OC2's fingerprint refuses a MISSING required table or read column. Both
     * corpora were built from the source's own DDL by
     * `scripts/capture-opencode.mjs`, so the six required tables and every read
     * column are present verbatim.
     *
     * The VERSION half is deliberately not applied: OC5 says "The concrete
     * window belongs to Phase 4 and to that capture; writing a number here
     * before the harvest would be writing a number nobody measured." This
     * generator therefore does not decide whether 1.18.21 is inside a window
     * anchored on 1.18.22 - it records what each corpus contains and leaves the
     * window to Phase 4. Recorded in GOLDEN.md.
     */
    schemaOk: true,
    epochAnchor: new Date(root.timeCreated).toISOString(),
    totals: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costUsd: totals.costUsd,
    },
    spawnEdges,
    parked,
    root: serializeAgent(rootNode, root.timeCreated, counts),
  };
  return state;
}

// ---------------------------------------------------------------------------
// Canonical serialization - the house form, `fixtures/golden/*/README.md`
// ---------------------------------------------------------------------------

function serializeAgent(node, anchor, counts) {
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
    children: node.children.map((child) =>
      child._agent === true ? serializeAgent(child, anchor, counts) : serializeTool(child, counts),
    ),
  };
}

function serializeTool(node, counts) {
  const inputPreview = previewFingerprint(node.inputPreview);
  const resultPreview = previewFingerprint(node.resultPreview);
  // Counted from the cut itself, never sniffed out of the text: a payload whose
  // own content ends in marker-shaped bytes must not be miscounted as truncated
  // (the recorded `splitTruncationMarker` hazard in redact.ts).
  if (node._inputTruncated) counts.previewsTruncated++;
  if (node._resultTruncated) counts.previewsTruncated++;
  return {
    node: 'tool',
    id: node.id,
    toolName: node.toolName,
    status: node.status,
    inputPreview,
    resultPreview,
    durationMs: node.durationMs ?? null,
    // OpenCode's own truncation claim, or `null` for "no claim was made".
    // `?? null` and not `=== undefined`: a claim of `false` must survive, and
    // `??` fires only on null/undefined, so it does.
    truncated: node.truncated ?? null,
  };
}

/** The exact text a golden holds: canonical JSON, LF endings, trailing newline. */
export function goldenText(golden) {
  return `${JSON.stringify(golden, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** Corpus directory names, derived from disk - never a hard-coded list. */
export function listCorpora(fixturesDir = FIXTURES_DIR) {
  return readdirSync(fixturesDir)
    .filter((name) => name.startsWith('opencode-'))
    .filter((name) => existsSync(path.join(fixturesDir, name, 'opencode.db')))
    .sort();
}

/** Produce the golden text for one corpus directory name. Reads only. */
export function generate(corpusName, fixturesDir = FIXTURES_DIR) {
  const dbPath = path.join(fixturesDir, corpusName, 'opencode.db');
  const dataVersion = corpusName.slice('opencode-'.length);
  const corpus = readCorpus(dbPath);
  const versions = new Set(corpus.sessions.map((s) => s.version));
  if (versions.size !== 1 || !versions.has(dataVersion)) {
    // OC5's harvest rule: record the `session.version` of every captured
    // session. A corpus whose rows disagree with its directory name is not a
    // corpus for that version.
    throw new Error(
      `${corpusName}: session.version set is {${[...versions].join(', ')}}, expected {${dataVersion}}`,
    );
  }
  return goldenText(buildCorpusGolden({ corpusName, dataVersion, corpus }));
}

export function goldenPath(corpusName, fixturesDir = FIXTURES_DIR) {
  return path.join(fixturesDir, corpusName, 'golden.json');
}

function main(argv) {
  const check = argv.includes('--check');
  const corpusFlag = argv.indexOf('--corpus');
  const names =
    corpusFlag >= 0 ? [path.basename(argv[corpusFlag + 1] ?? '')] : listCorpora();
  if (names.length === 0) {
    process.stderr.write('no fixtures/opencode-*/opencode.db found\n');
    return 1;
  }
  let failed = 0;
  for (const name of names) {
    const text = generate(name);
    const out = goldenPath(name);
    const dbBytes = statSync(path.join(FIXTURES_DIR, name, 'opencode.db')).size;
    if (check) {
      const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
      if (current === text) {
        // BYTES, not string length: the file carries multi-byte characters, so
        // `text.length` under-reports what is on disk by 9 on the anchor.
        process.stdout.write(
          `OK      ${name}/golden.json (${Buffer.byteLength(text, 'utf8')} bytes)\n`,
        );
      } else {
        failed++;
        process.stdout.write(`STALE   ${name}/golden.json - regenerate\n`);
      }
    } else {
      writeFileSync(out, text, 'utf8');
      process.stdout.write(
        `WROTE   ${name}/golden.json (${Buffer.byteLength(text, 'utf8')} bytes)` +
          ` from ${dbBytes}-byte db\n`,
      );
    }
  }
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
