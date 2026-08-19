/**
 * Agent Deck — schema fingerprint.
 *
 * The fingerprint is the compatibility story. Claude Code's on-disk exhaust is
 * undocumented, so instead of coping with drift we detect it and refuse:
 * exactly one CC version is pinned, and the *layout* — not merely a list of
 * field names — is the tripwire, because subagent attribution rests on an
 * undocumented directory convention:
 *
 *   <slugDir>/<sessionId>.jsonl                                main transcript
 *   <slugDir>/<sessionId>/subagents/agent-<agentId>.jsonl      subagent transcript
 *   <slugDir>/<sessionId>/subagents/agent-<agentId>.meta.json  sidecar (whole-file JSON)
 *   <slugDir>/<sessionId>/tool-results/<id>.txt                offloaded payloads (optional)
 *
 * `meta.toolUseId` names the exact `tool_use` block that spawned the agent, so
 * attribution is a primary-key join. A sidecar without that key, or a
 * transcript without its sidecar, means the join is unavailable — and this
 * module refuses rather than guessing.
 *
 * Grounding constraints this module is held to:
 *
 *   G1  Read-only. Files are opened with flag 'r' and directories are listed.
 *       Nothing is created, written, renamed or deleted, anywhere.
 *   G3  Refuse, don't guess. No input can make a call throw: missing files,
 *       zero-byte files, corrupt JSON, a directory where a file was expected
 *       and unreadable paths all come back as results. A mismatch marks the
 *       whole session unsupported; it never yields a partial tree.
 *   G5  Zero egress. Node built-ins only; no sockets.
 *   G6  Fixtures are law. Every rule below is derived from the committed
 *       capture under `fixtures/cc-2.1.234/`, never from memory. The measured
 *       counts are quoted at the rule they justify.
 *   G9  One pinned version. `2.1.234` and nothing else — including a `version`
 *       that changes partway through a single file, which is a refusal and not
 *       a tolerated case.
 */

import { Buffer } from 'node:buffer';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type {
  ParseDiagnostics,
  ParseResult,
  SchemaMismatch,
  SubagentMeta,
} from '../model/events.js';

// ---------------------------------------------------------------------------
// Pins and conventions
// ---------------------------------------------------------------------------

/**
 * The single supported CC version. Multi-version support is a hard exclusion:
 * a different value renders the session `unsupported`, and the fix is to
 * capture new fixtures and move the pin — never to add a second code path.
 */
export const PINNED_CC_VERSION = '2.1.234';

/** `<sessionId>.jsonl` in the slug directory. Sessions come from FILES only. */
const SESSION_FILE_RE = /^([0-9a-f][0-9a-f-]{7,})\.jsonl$/i;
/** `agent-<agentId>.jsonl` inside `subagents/`. */
const AGENT_TRANSCRIPT_RE = /^agent-(.+)\.jsonl$/i;
/** `agent-<agentId>.meta.json` inside `subagents/`. */
const AGENT_META_RE = /^agent-(.+)\.meta\.json$/i;

const SUBAGENTS_DIR = 'subagents';
const TOOL_RESULTS_DIR = 'tool-results';

// ---------------------------------------------------------------------------
// Mismatch shape
// ---------------------------------------------------------------------------

/**
 * Machine-readable refusal codes. Every code below is asserted individually by
 * a mutation fixture; a test that only checked "something was rejected" would
 * still pass while a mutation was being rejected for the wrong reason.
 */
export type MismatchCode =
  // --- layout: session level
  | 'mainTranscriptMissing'
  | 'mainTranscriptNotAFile'
  | 'mainTranscriptUnreadable'
  | 'sessionDirUnreadable'
  | 'noSessionTranscripts'
  | 'slugDirUnreadable'
  // --- layout: subagent convention
  | 'subagentsPathNotDirectory'
  | 'subagentsDirUnreadable'
  | 'subagentsDirectoryMisnamed'
  | 'subagentFileNameConvention'
  | 'subagentMetaMissing'
  | 'subagentTranscriptMissing'
  | 'subagentTranscriptUnreadable'
  // --- join keys
  | 'metaUnreadable'
  | 'metaInvalidJson'
  | 'metaNotAnObject'
  | 'metaFieldMissing'
  | 'metaFieldType'
  | 'metaParentAgentIdRule'
  | 'agentIdMismatch'
  | 'sessionIdMismatch'
  // --- entries
  | 'entryFieldMissing'
  | 'entryFieldType'
  // --- version pin
  | 'unsupportedVersion'
  | 'versionChangedMidFile';

/**
 * `SchemaMismatch` from the model, plus a stable `code`. The extra property
 * keeps the exported refusal assignable to `SchemaMismatch` (and therefore to
 * `ParseResult`) while letting tests and the session model branch on something
 * that is not a human-readable sentence.
 */
export interface FingerprintMismatch extends SchemaMismatch {
  code: MismatchCode;
}

/** Type guard, so callers never hand-check `kind`. */
export function isFingerprintMismatch(value: unknown): value is FingerprintMismatch {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { kind?: unknown; code?: unknown };
  return candidate.kind === 'schemaMismatch' && typeof candidate.code === 'string';
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** One `agent-<id>.jsonl` + `agent-<id>.meta.json` pair that matched. */
export interface SubagentFingerprint {
  agentId: string;
  transcriptPath: string;
  metaPath: string;
  /** The sidecar as read. Extra/unknown fields are preserved, never rejected. */
  meta: SubagentMeta;
}

/** What the fingerprint learned about a session that matched. */
export interface SessionFingerprint {
  sessionId: string;
  slugDir: string;
  mainTranscript: string;
  /** `<slugDir>/<sessionId>/`. May not exist yet — that is not a mismatch. */
  sessionDir: string;
  /**
   * The single CC version observed across the session's files, or `undefined`
   * when no line carried one (a just-created transcript). Absence is not
   * evidence of a *different* version, so it is not a refusal.
   */
  version?: string;
  subagents: SubagentFingerprint[];
  /** Set only when `tool-results/` exists AND is a directory. Optional (G6). */
  toolResultsDir?: string;
  /**
   * Paths inside the session directory that were deliberately ignored. Live
   * sessions carry strays such as `auto-mode-classifier-error.txt` beside
   * `subagents/`; recording them keeps "ignored" auditable instead of silent.
   */
  ignored: string[];
}

/**
 * Data or a refusal, never a partial tree. Structurally a
 * `ParseResult<SessionFingerprint>` with the mismatch narrowed to
 * {@link FingerprintMismatch}.
 */
export type FingerprintResult =
  | { ok: true; value: SessionFingerprint; diagnostics: ParseDiagnostics }
  | { ok: false; mismatch: FingerprintMismatch; diagnostics: ParseDiagnostics };

/** Compile-time proof that {@link FingerprintResult} satisfies the model type. */
export type FingerprintResultIsParseResult =
  FingerprintResult extends ParseResult<SessionFingerprint> ? true : never;

/** One entry per `<sessionId>.jsonl` file found in a slug directory. */
export interface SlugSessionOutcome {
  sessionId: string;
  mainTranscript: string;
  result: FingerprintResult;
}

export interface SlugFingerprint {
  slugDir: string;
  sessions: SlugSessionOutcome[];
  /**
   * Slug-directory entries that are not session transcripts — notably the
   * sibling `memory/` directory, which is present in every live tree and is
   * not a session.
   */
  ignored: string[];
}

export type SlugFingerprintResult =
  | { ok: true; value: SlugFingerprint }
  | { ok: false; mismatch: FingerprintMismatch };

export interface FingerprintOptions {
  /** Overrides {@link PINNED_CC_VERSION}. Tests only; there is one pin. */
  pinnedVersion?: string;
}

// ---------------------------------------------------------------------------
// Entry-level requirements — measured, not assumed
// ---------------------------------------------------------------------------

type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'stringOrNull';

export interface FieldSpec {
  readonly name: string;
  readonly type: FieldType;
}

/**
 * Fields present on 100% of lines of a given `type` across the committed
 * capture (124 lines across 7 files), restricted to the fields the session
 * model consumes. Fields that are merely frequent are NOT required: `agentId`
 * is on 84/84 subagent lines but 0/40 main-transcript lines, so requiring it
 * would refuse every main transcript.
 *
 * Measured line counts per type: user 33, attachment 22, assistant 57,
 * queue-operation 4, ai-title 4, file-history-snapshot 2, last-prompt 2.
 */
const CONVERSATION_CORE: readonly FieldSpec[] = [
  { name: 'uuid', type: 'string' },
  // null on the first line of every transcript (7/7 files).
  { name: 'parentUuid', type: 'stringOrNull' },
  { name: 'sessionId', type: 'string' },
  { name: 'timestamp', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'isSidechain', type: 'boolean' },
];

const SESSION_ID_ONLY: readonly FieldSpec[] = [{ name: 'sessionId', type: 'string' }];

/**
 * Per-line-type requirements. A `type` absent from this table is a record kind
 * we have never observed: only `type` itself is required, because refusing an
 * unknown record kind would refuse otherwise valid sessions.
 */
export const REQUIRED_ENTRY_FIELDS: ReadonlyMap<string, readonly FieldSpec[]> = new Map<
  string,
  readonly FieldSpec[]
>([
  ['user', [...CONVERSATION_CORE, { name: 'message', type: 'object' }]],
  ['assistant', [...CONVERSATION_CORE, { name: 'message', type: 'object' }]],
  // `attachment` carries the core but never `message` (0/22).
  ['attachment', CONVERSATION_CORE],
  // `queue-operation` carries almost nothing: type/operation/timestamp/sessionId.
  [
    'queue-operation',
    [
      { name: 'sessionId', type: 'string' },
      { name: 'timestamp', type: 'string' },
    ],
  ],
  ['ai-title', SESSION_ID_ONLY],
  ['last-prompt', SESSION_ID_ONLY],
  // `file-history-snapshot` carries no sessionId and no timestamp (0/2).
  ['file-history-snapshot', []],
]);

/** Sidecar join keys, required on every `agent-<id>.meta.json` (5/5 sidecars). */
export const REQUIRED_META_FIELDS: readonly FieldSpec[] = [
  { name: 'agentType', type: 'string' },
  { name: 'description', type: 'string' },
  { name: 'toolUseId', type: 'string' },
  { name: 'spawnDepth', type: 'number' },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyDiagnostics(): ParseDiagnostics {
  return { malformedLines: 0, parsedLines: 0, skippedFiles: [] };
}

function mismatch(
  code: MismatchCode,
  reason: string,
  detail: Omit<SchemaMismatch, 'kind' | 'reason'> = {},
): FingerprintMismatch {
  return { kind: 'schemaMismatch', code, reason, ...detail };
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'stringOrNull':
      return typeof value === 'string' || value === null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ids come from filenames; Windows drive/slug casing varies between versions. */
function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ---------------------------------------------------------------------------
// Transcript scanning
// ---------------------------------------------------------------------------

interface TranscriptScan {
  mismatch?: FingerprintMismatch;
  /** Version observed on this file, when any line carried one. */
  version?: string;
}

interface TranscriptExpectations {
  sessionId: string;
  /** Set for subagent transcripts only; the id encoded in the filename. */
  agentId?: string;
  pinnedVersion: string;
  /** Which refusal code an unreadable file produces at this position. */
  unreadableCode: MismatchCode;
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Read a whole transcript line by line without holding it in memory.
 *
 * Streaming is not an optimisation here: mid-file version drift can only be
 * detected by looking at every line, and live main transcripts reach megabytes.
 * A trailing line with no newline is still inspected — CC may be mid-write, in
 * which case it fails JSON parsing and is counted, not refused.
 */
async function scanTranscript(
  path: string,
  expect: TranscriptExpectations,
  diagnostics: ParseDiagnostics,
): Promise<TranscriptScan> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    diagnostics.skippedFiles.push({ path, reason: `open failed: ${errorCode(error)}` });
    return {
      mismatch: mismatch(expect.unreadableCode, `cannot read transcript: ${errorMessage(error)}`, {
        path,
        actual: errorCode(error),
      }),
    };
  }

  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let pending = '';
  let lineNumber = 0;
  let fileVersion: string | undefined;

  const consume = (raw: string): FingerprintMismatch | undefined => {
    lineNumber += 1;
    const text = raw.replace(/\r$/, '');
    if (text.trim() === '') return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // G3: malformed input increments a counter and is skipped. It is not
      // schema drift — a half-written trailing line looks exactly like this.
      diagnostics.malformedLines += 1;
      return undefined;
    }
    if (!isPlainObject(parsed)) {
      diagnostics.malformedLines += 1;
      return undefined;
    }
    diagnostics.parsedLines += 1;
    const entryMismatch = checkEntry(parsed, path, lineNumber, expect, fileVersion);
    if (entryMismatch !== undefined) return entryMismatch;
    const version = parsed['version'];
    if (typeof version === 'string' && fileVersion === undefined) fileVersion = version;
    return undefined;
  };

  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const found = consume(pending.slice(0, newline));
        if (found !== undefined) return { mismatch: found, version: fileVersion };
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.end();
    if (pending !== '') {
      const found = consume(pending);
      if (found !== undefined) return { mismatch: found, version: fileVersion };
    }
  } catch (error) {
    diagnostics.skippedFiles.push({ path, reason: `read failed: ${errorMessage(error)}` });
    return {
      mismatch: mismatch(expect.unreadableCode, `read failed: ${errorMessage(error)}`, {
        path,
        actual: errorCode(error),
      }),
      version: fileVersion,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }

  return { version: fileVersion };
}

/** One line's worth of assertions. Returns the first refusal, or undefined. */
function checkEntry(
  entry: Record<string, unknown>,
  path: string,
  lineNumber: number,
  expect: TranscriptExpectations,
  fileVersion: string | undefined,
): FingerprintMismatch | undefined {
  const where = `${path}:${lineNumber}`;

  const type = entry['type'];
  if (!('type' in entry)) {
    return mismatch('entryFieldMissing', 'entry has no `type`', {
      path: where,
      field: 'type',
      expected: 'string',
      actual: 'absent',
    });
  }
  if (typeof type !== 'string' || type === '') {
    return mismatch('entryFieldType', 'entry `type` is not a non-empty string', {
      path: where,
      field: 'type',
      expected: 'string',
      actual: describeType(type),
    });
  }

  for (const spec of REQUIRED_ENTRY_FIELDS.get(type) ?? []) {
    if (!(spec.name in entry)) {
      return mismatch('entryFieldMissing', `\`${type}\` entry is missing \`${spec.name}\``, {
        path: where,
        field: spec.name,
        expected: spec.type,
        actual: 'absent',
      });
    }
    const value = entry[spec.name];
    if (!matchesType(value, spec.type)) {
      return mismatch('entryFieldType', `\`${type}.${spec.name}\` has the wrong type`, {
        path: where,
        field: spec.name,
        expected: spec.type,
        actual: describeType(value),
      });
    }
  }

  const sessionId = entry['sessionId'];
  if (typeof sessionId === 'string' && !sameId(sessionId, expect.sessionId)) {
    return mismatch('sessionIdMismatch', 'entry `sessionId` does not match the transcript', {
      path: where,
      field: 'sessionId',
      expected: expect.sessionId,
      actual: sessionId,
    });
  }

  // The filename encodes the agent id; a line claiming a different one would
  // break the join attribution depends on. Absence is fine — main transcripts
  // carry no `agentId` at all (0/40 lines).
  const agentId = entry['agentId'];
  if (
    expect.agentId !== undefined &&
    typeof agentId === 'string' &&
    !sameId(agentId, expect.agentId)
  ) {
    return mismatch('agentIdMismatch', 'entry `agentId` does not match the filename', {
      path: where,
      field: 'agentId',
      expected: expect.agentId,
      actual: agentId,
    });
  }

  const version = entry['version'];
  if (typeof version === 'string') {
    // Order matters: a file that starts pinned and drifts later must report the
    // drift, not the generic "unsupported version".
    if (fileVersion !== undefined && version !== fileVersion) {
      return mismatch('versionChangedMidFile', '`version` changed partway through the file', {
        path: where,
        field: 'version',
        expected: fileVersion,
        actual: version,
        observedVersion: version,
      });
    }
    if (version !== expect.pinnedVersion) {
      return mismatch('unsupportedVersion', 'transcript was written by an unpinned CC version', {
        path: where,
        field: 'version',
        expected: expect.pinnedVersion,
        actual: version,
        observedVersion: version,
      });
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Sidecar checking — the join keys
// ---------------------------------------------------------------------------

type MetaCheck = { ok: true; meta: SubagentMeta } | { ok: false; mismatch: FingerprintMismatch };

async function checkMeta(metaPath: string, agentId: string): Promise<MetaCheck> {
  let text: string;
  try {
    text = await readFile(metaPath, 'utf8');
  } catch (error) {
    const code = errorCode(error);
    return {
      ok: false,
      mismatch: mismatch(
        code === 'ENOENT' ? 'subagentMetaMissing' : 'metaUnreadable',
        `cannot read sidecar for agent ${agentId}: ${errorMessage(error)}`,
        { path: metaPath, actual: code },
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      mismatch: mismatch('metaInvalidJson', `sidecar is not valid JSON: ${errorMessage(error)}`, {
        path: metaPath,
        expected: 'JSON object',
        actual: 'unparseable',
      }),
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      mismatch: mismatch('metaNotAnObject', 'sidecar is not a JSON object', {
        path: metaPath,
        expected: 'JSON object',
        actual: describeType(parsed),
      }),
    };
  }

  for (const spec of REQUIRED_META_FIELDS) {
    if (!(spec.name in parsed)) {
      return {
        ok: false,
        mismatch: mismatch(
          'metaFieldMissing',
          spec.name === 'toolUseId'
            ? 'sidecar is missing `toolUseId`; attribution would have to be guessed'
            : `sidecar is missing \`${spec.name}\``,
          { path: metaPath, field: spec.name, expected: spec.type, actual: 'absent' },
        ),
      };
    }
    const value = parsed[spec.name];
    if (!matchesType(value, spec.type)) {
      return {
        ok: false,
        mismatch: mismatch('metaFieldType', `sidecar \`${spec.name}\` has the wrong type`, {
          path: metaPath,
          field: spec.name,
          expected: spec.type,
          actual: describeType(value),
        }),
      };
    }
    // A blank join key is a MISSING join key, not a present one. `"   "`
    // type-checks as a string, so without this the layout fingerprint would
    // hand the grafter a key that can never join, and the refusal would happen
    // downstream or nowhere. Refusal belongs at the layout boundary (G3).
    // Scoped to `toolUseId` deliberately: it is the only field the primary-key
    // join reads, and a blank `agentType`/`description` costs a label, not a
    // parent edge.
    if (spec.name === 'toolUseId' && typeof value === 'string' && value.trim() === '') {
      return {
        ok: false,
        mismatch: mismatch(
          'metaFieldMissing',
          'sidecar `toolUseId` is blank; attribution would have to be guessed',
          {
            path: metaPath,
            field: spec.name,
            expected: 'non-blank string',
            actual: 'blank',
          },
        ),
      };
    }
  }

  // Conditional key, verified against the capture: `parentAgentId` is present
  // on the one spawnDepth-2 sidecar and absent on all four spawnDepth-1 ones.
  const spawnDepth = parsed['spawnDepth'] as number;
  const hasParent = 'parentAgentId' in parsed;
  const parentAgentId = parsed['parentAgentId'];
  if (spawnDepth >= 2 && !hasParent) {
    return {
      ok: false,
      mismatch: mismatch(
        'metaParentAgentIdRule',
        'sidecar at spawnDepth >= 2 has no `parentAgentId`',
        {
          path: metaPath,
          field: 'parentAgentId',
          expected: 'string (required at spawnDepth >= 2)',
          actual: 'absent',
        },
      ),
    };
  }
  if (hasParent && typeof parentAgentId !== 'string') {
    return {
      ok: false,
      mismatch: mismatch('metaFieldType', 'sidecar `parentAgentId` has the wrong type', {
        path: metaPath,
        field: 'parentAgentId',
        expected: 'string',
        actual: describeType(parentAgentId),
      }),
    };
  }
  if (spawnDepth < 2 && hasParent) {
    return {
      ok: false,
      mismatch: mismatch(
        'metaParentAgentIdRule',
        'sidecar below spawnDepth 2 carries a `parentAgentId`',
        {
          path: metaPath,
          field: 'parentAgentId',
          expected: 'absent below spawnDepth 2',
          actual: String(parentAgentId),
        },
      ),
    };
  }

  return { ok: true, meta: parsed as SubagentMeta };
}

// ---------------------------------------------------------------------------
// Session fingerprint
// ---------------------------------------------------------------------------

/**
 * Fingerprint one session, identified by its main transcript file.
 *
 * The main transcript FILE is the identity of a session — never a directory.
 * `<slug>/memory/` is a sibling of every `<sessionId>/` directory in a live
 * tree, so enumerating directories would invent a session that does not exist.
 */
export async function fingerprintSession(
  mainTranscript: string,
  options: FingerprintOptions = {},
): Promise<FingerprintResult> {
  const diagnostics = emptyDiagnostics();
  const pinnedVersion = options.pinnedVersion ?? PINNED_CC_VERSION;
  const slugDir = dirname(mainTranscript);
  const name = basename(mainTranscript);
  const sessionId = SESSION_FILE_RE.exec(name)?.[1] ?? name.replace(/\.jsonl$/i, '');
  const sessionDir = join(slugDir, sessionId);
  const versions = new Set<string>();
  const ignored: string[] = [];
  const subagents: SubagentFingerprint[] = [];
  let toolResultsDir: string | undefined;

  const refuse = (m: FingerprintMismatch): FingerprintResult => ({
    ok: false,
    mismatch: m,
    diagnostics,
  });

  const accept = (): FingerprintResult => {
    const value: SessionFingerprint = {
      sessionId,
      slugDir,
      mainTranscript,
      sessionDir,
      subagents,
      ignored,
    };
    if (versions.size === 1) value.version = [...versions][0];
    if (toolResultsDir !== undefined) value.toolResultsDir = toolResultsDir;
    return { ok: true, value, diagnostics };
  };

  // --- 1. the main transcript must be a real file -------------------------
  try {
    const info = await stat(mainTranscript);
    if (!info.isFile()) {
      return refuse(
        mismatch('mainTranscriptNotAFile', 'main transcript path is not a file', {
          path: mainTranscript,
          expected: 'file',
          actual: info.isDirectory() ? 'directory' : 'other',
        }),
      );
    }
  } catch (error) {
    const code = errorCode(error);
    return refuse(
      mismatch(
        code === 'ENOENT' ? 'mainTranscriptMissing' : 'mainTranscriptUnreadable',
        `cannot stat main transcript: ${errorMessage(error)}`,
        { path: mainTranscript, actual: code },
      ),
    );
  }

  const mainScan = await scanTranscript(
    mainTranscript,
    { sessionId, pinnedVersion, unreadableCode: 'mainTranscriptUnreadable' },
    diagnostics,
  );
  if (mainScan.mismatch !== undefined) return refuse(mainScan.mismatch);
  if (mainScan.version !== undefined) versions.add(mainScan.version);

  // --- 2. session directory (absent is fine: no subagents yet) ------------
  let sessionDirents;
  try {
    sessionDirents = await readdir(sessionDir, { withFileTypes: true });
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return refuse(
        mismatch('sessionDirUnreadable', `cannot read session directory: ${errorMessage(error)}`, {
          path: sessionDir,
          actual: code,
        }),
      );
    }
    return accept();
  }

  let hasSubagentsDir = false;
  const strayDirs: string[] = [];
  for (const entry of sessionDirents) {
    if (entry.name === SUBAGENTS_DIR) {
      if (!entry.isDirectory()) {
        return refuse(
          mismatch('subagentsPathNotDirectory', '`subagents` exists but is not a directory', {
            path: join(sessionDir, SUBAGENTS_DIR),
            expected: 'directory',
            actual: entry.isFile() ? 'file' : 'other',
          }),
        );
      }
      hasSubagentsDir = true;
      continue;
    }
    if (entry.name === TOOL_RESULTS_DIR && entry.isDirectory()) {
      // Optional by design: its absence is never a mismatch.
      toolResultsDir = join(sessionDir, TOOL_RESULTS_DIR);
      continue;
    }
    // Everything else is ignored. A live session directory really does contain
    // strays such as `auto-mode-classifier-error.txt` beside `subagents/`.
    if (entry.isDirectory()) strayDirs.push(entry.name);
    ignored.push(join(sessionDir, entry.name));
  }

  // ...with one exception: a stray directory holding agent transcripts means
  // the directory convention itself moved. That is the tripwire, not a stray.
  for (const dir of strayDirs) {
    const full = join(sessionDir, dir);
    let names: string[];
    try {
      names = await readdir(full);
    } catch {
      continue; // an unreadable stray directory is still just a stray
    }
    const strayAgentFile = names.find((n) => AGENT_TRANSCRIPT_RE.test(n) || AGENT_META_RE.test(n));
    if (strayAgentFile !== undefined) {
      return refuse(
        mismatch(
          'subagentsDirectoryMisnamed',
          'agent transcripts found outside `subagents/`; the directory convention changed',
          {
            path: join(full, strayAgentFile),
            field: dir,
            expected: `${SUBAGENTS_DIR}/`,
            actual: `${dir}/`,
          },
        ),
      );
    }
  }

  if (!hasSubagentsDir) return accept();

  // --- 3. subagents/: naming, pairing, join keys --------------------------
  const subagentsDir = join(sessionDir, SUBAGENTS_DIR);
  let subagentDirents;
  try {
    subagentDirents = await readdir(subagentsDir, { withFileTypes: true });
  } catch (error) {
    return refuse(
      mismatch('subagentsDirUnreadable', `cannot read subagents/: ${errorMessage(error)}`, {
        path: subagentsDir,
        actual: errorCode(error),
      }),
    );
  }

  const transcripts = new Map<string, string>(); // agentId -> filename
  const metas = new Map<string, string>();
  for (const entry of subagentDirents) {
    if (!entry.isFile()) {
      ignored.push(join(subagentsDir, entry.name));
      continue;
    }
    const metaId = AGENT_META_RE.exec(entry.name)?.[1];
    if (metaId !== undefined) {
      metas.set(metaId, entry.name);
      continue;
    }
    if (/\.meta\.json$/i.test(entry.name)) {
      return refuse(
        mismatch('subagentFileNameConvention', 'sidecar does not follow `agent-<id>.meta.json`', {
          path: join(subagentsDir, entry.name),
          expected: 'agent-<agentId>.meta.json',
          actual: entry.name,
        }),
      );
    }
    const transcriptId = AGENT_TRANSCRIPT_RE.exec(entry.name)?.[1];
    if (transcriptId !== undefined) {
      transcripts.set(transcriptId, entry.name);
      continue;
    }
    if (/\.jsonl$/i.test(entry.name)) {
      return refuse(
        mismatch('subagentFileNameConvention', 'transcript does not follow `agent-<id>.jsonl`', {
          path: join(subagentsDir, entry.name),
          expected: 'agent-<agentId>.jsonl',
          actual: entry.name,
        }),
      );
    }
    ignored.push(join(subagentsDir, entry.name));
  }

  const agentIds = [...new Set([...transcripts.keys(), ...metas.keys()])].sort();
  for (const agentId of agentIds) {
    const transcriptName = transcripts.get(agentId);
    const metaName = metas.get(agentId);
    if (transcriptName === undefined) {
      return refuse(
        mismatch('subagentTranscriptMissing', 'sidecar has no matching transcript', {
          path: join(subagentsDir, `agent-${agentId}.jsonl`),
          field: agentId,
          expected: `agent-${agentId}.jsonl`,
          actual: 'absent',
        }),
      );
    }
    if (metaName === undefined) {
      return refuse(
        mismatch(
          'subagentMetaMissing',
          'transcript has no matching sidecar; the join key for attribution is unavailable',
          {
            path: join(subagentsDir, `agent-${agentId}.meta.json`),
            field: agentId,
            expected: `agent-${agentId}.meta.json`,
            actual: 'absent',
          },
        ),
      );
    }

    const metaPath = join(subagentsDir, metaName);
    const metaCheck = await checkMeta(metaPath, agentId);
    if (!metaCheck.ok) return refuse(metaCheck.mismatch);

    const transcriptPath = join(subagentsDir, transcriptName);
    const scan = await scanTranscript(
      transcriptPath,
      { sessionId, agentId, pinnedVersion, unreadableCode: 'subagentTranscriptUnreadable' },
      diagnostics,
    );
    if (scan.mismatch !== undefined) return refuse(scan.mismatch);
    if (scan.version !== undefined) versions.add(scan.version);

    subagents.push({ agentId, transcriptPath, metaPath, meta: metaCheck.meta });
  }

  // Per-file drift is refused above; files that disagree with *each other* are
  // the same failure one level up (G9 — one pinned version at a time).
  if (versions.size > 1) {
    const sorted = [...versions].sort();
    return refuse(
      mismatch('versionChangedMidFile', 'session files disagree about the CC version', {
        path: sessionDir,
        field: 'version',
        expected: sorted[0] ?? pinnedVersion,
        actual: sorted.join(', '),
      }),
    );
  }

  return accept();
}

// ---------------------------------------------------------------------------
// Slug-directory fingerprint
// ---------------------------------------------------------------------------

/**
 * Fingerprint every session in a project slug directory.
 *
 * File-first, deliberately: sessions come from `<sessionId>.jsonl` FILES.
 * Directories are never sessions, which is what keeps `memory/` out.
 */
export async function fingerprintSlugDirectory(
  slugDir: string,
  options: FingerprintOptions = {},
): Promise<SlugFingerprintResult> {
  let entries;
  try {
    entries = await readdir(slugDir, { withFileTypes: true });
  } catch (error) {
    return {
      ok: false,
      mismatch: mismatch(
        'slugDirUnreadable',
        `cannot read project slug directory: ${errorMessage(error)}`,
        { path: slugDir, actual: errorCode(error) },
      ),
    };
  }

  const sessionIds: string[] = [];
  const ignored: string[] = [];
  for (const entry of entries) {
    const sessionId = entry.isFile() ? SESSION_FILE_RE.exec(entry.name)?.[1] : undefined;
    if (sessionId === undefined) {
      ignored.push(join(slugDir, entry.name));
      continue;
    }
    sessionIds.push(sessionId);
  }
  sessionIds.sort();

  if (sessionIds.length === 0) {
    return {
      ok: false,
      mismatch: mismatch('noSessionTranscripts', 'no `<sessionId>.jsonl` file in slug directory', {
        path: slugDir,
        expected: '<sessionId>.jsonl',
        actual: 'none',
      }),
    };
  }

  const sessions: SlugSessionOutcome[] = [];
  for (const sessionId of sessionIds) {
    const mainTranscript = join(slugDir, `${sessionId}.jsonl`);
    sessions.push({
      sessionId,
      mainTranscript,
      result: await fingerprintSession(mainTranscript, options),
    });
  }

  return { ok: true, value: { slugDir, sessions, ignored } };
}
