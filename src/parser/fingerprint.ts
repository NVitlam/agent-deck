/**
 * Agent Deck — schema fingerprint.
 *
 * The fingerprint is the compatibility story. Claude Code's on-disk exhaust is
 * undocumented, so instead of coping with drift we detect it and refuse: a
 * narrow *window* of CC versions around a pinned anchor is accepted, and the
 * *layout* — not merely a list of field names — is the tripwire, because
 * subagent attribution rests on an undocumented directory convention:
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
 *   G9  SUPERSEDED by an explicit user decision (Phase 4). G9 required one
 *       pinned version and nothing else; the shipped extension went dark the
 *       moment CC updated itself past the pin. Measured on the live projects
 *       directory on 2026-08-20 with the pin at 2.1.234: 6 of 12 of this
 *       repo's own sessions were refused, including every session written by
 *       2.1.237. The pin is now the ANCHOR of an acceptance window
 *       ({@link VERSION_WINDOW}); out-of-window versions still refuse exactly
 *       as before. See {@link isVersionAccepted}.
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
 * The anchor of the acceptance window: the CC version the committed fixtures
 * under `fixtures/cc-2.1.234/` were captured from, and the only version whose
 * behaviour is pinned byte-for-byte.
 *
 * It is no longer the *only* accepted version — see {@link VERSION_WINDOW} —
 * but it is still the reference point, and moving it moves the whole window.
 */
export const PINNED_CC_VERSION = '2.1.234';

/**
 * How far a `version` may sit from {@link PINNED_CC_VERSION} and still be read.
 *
 * The third component is the one that actually moves in CC releases (234 ->
 * 235 -> 237 inside a single week of this repo's own sessions), so it gets the
 * wider allowance; the second component gets one step in either direction so a
 * rollover such as `2.1.239 -> 2.2.0` does not black the product out.
 *
 * The major component is NOT windowed. A major bump is the one release that
 * may reasonably rearrange the layout this module exists to assert.
 *
 * This is a **box, not a lexicographic range**: `2.2.100` sits between the
 * corners `2.0.229` and `2.2.239` and is refused, because its third component
 * is 134 away from the anchor's. {@link VersionWindow.label} names the corners
 * for humans; {@link isVersionAccepted} is the rule.
 */
export const VERSION_WINDOW: { readonly minor: number; readonly patch: number } = {
  minor: 1,
  patch: 5,
};

/** A CC version string decomposed. Exactly three components, no prerelease. */
export interface CcVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Strictly `<major>.<minor>.<patch>`, each a decimal integer with no leading
 * zero. Anything else — `2.1`, `2.1.234-beta`, `02.1.234`, `` — is *not*
 * parsed into something plausible: it returns `undefined`, and the caller
 * refuses (G3). Guessing at an unrecognised version string is exactly the
 * failure mode the fingerprint exists to prevent.
 */
export function parseCcVersion(value: string): CcVersion | undefined {
  const match = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(value);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** The window around an anchor, materialised. `undefined` if the anchor is not parseable. */
export interface VersionWindow {
  anchor: string;
  major: number;
  minMinor: number;
  maxMinor: number;
  minPatch: number;
  maxPatch: number;
  /** `<min> - <max>`, the corners of the box. Reporting only; see {@link VERSION_WINDOW}. */
  label: string;
}

/**
 * Derive the window from an anchor. Every bound comes from {@link VERSION_WINDOW}
 * applied to the anchor — the endpoints are never written down a second time,
 * so moving the anchor or the allowance cannot leave a stale literal behind.
 */
export function versionWindow(anchor: string = PINNED_CC_VERSION): VersionWindow | undefined {
  const parsed = parseCcVersion(anchor);
  if (parsed === undefined) return undefined;
  const minMinor = Math.max(0, parsed.minor - VERSION_WINDOW.minor);
  const maxMinor = parsed.minor + VERSION_WINDOW.minor;
  const minPatch = Math.max(0, parsed.patch - VERSION_WINDOW.patch);
  const maxPatch = parsed.patch + VERSION_WINDOW.patch;
  return {
    anchor,
    major: parsed.major,
    minMinor,
    maxMinor,
    minPatch,
    maxPatch,
    label: `${parsed.major}.${minMinor}.${minPatch} - ${parsed.major}.${maxMinor}.${maxPatch}`,
  };
}

/** Shared by every version check; the window is computed once per session. */
function acceptsVersion(
  version: string,
  anchor: string,
  window: VersionWindow | undefined,
): boolean {
  // An anchor that does not parse still accepts itself verbatim: a test may
  // pin something exotic, and exact equality can never be a guess.
  if (version === anchor) return true;
  if (window === undefined) return false;
  const parsed = parseCcVersion(version);
  if (parsed === undefined) return false;
  return (
    parsed.major === window.major &&
    parsed.minor >= window.minMinor &&
    parsed.minor <= window.maxMinor &&
    parsed.patch >= window.minPatch &&
    parsed.patch <= window.maxPatch
  );
}

/**
 * Is `version` inside the acceptance window around `anchor`?
 *
 * The whole compatibility policy, in one predicate, exported so it can be
 * asserted directly rather than only through a transcript.
 */
export function isVersionAccepted(version: string, anchor: string = PINNED_CC_VERSION): boolean {
  return acceptsVersion(version, anchor, versionWindow(anchor));
}

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
  // --- version window
  /** A version outside the window around {@link PINNED_CC_VERSION}. */
  | 'unsupportedVersion'
  /**
   * A file whose `version` changed partway through **to one outside the
   * window**. A change to another in-window version is accepted: that is a CC
   * self-update landing under a live session, which is now a supported case.
   */
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
   * when no line carried one (a just-created transcript) — and also when the
   * session spans more than one in-window version, because there is then no
   * single answer. Use {@link versions} for the full set.
   *
   * Absence is not evidence of a *different* version, so it is not a refusal.
   */
  version?: string;
  /**
   * Every distinct CC version observed across the session's files, sorted.
   * Empty when no line carried one. More than one entry means CC updated
   * itself while the session was live — accepted since Phase 4, provided every
   * one of them is inside the window.
   */
  versions: string[];
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
  /**
   * Overrides {@link PINNED_CC_VERSION} as the window's anchor. Tests only;
   * production has one anchor.
   */
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
  /**
   * Every distinct version observed on this file, in the order first seen.
   * More than one is a CC self-update mid-file; each was window-checked as it
   * was read, so the list only ever holds accepted versions.
   */
  versions: string[];
}

interface TranscriptExpectations {
  sessionId: string;
  /** Set for subagent transcripts only; the id encoded in the filename. */
  agentId?: string;
  /** The window's anchor. */
  pinnedVersion: string;
  /** Derived from `pinnedVersion` once per session, not once per line. */
  versionWindow: VersionWindow | undefined;
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
      versions: [],
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
  const versions: string[] = [];

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
    if (typeof version === 'string') {
      // `fileVersion` stays the FIRST version seen, so drift is measured
      // against the file's origin rather than against its previous line.
      if (fileVersion === undefined) fileVersion = version;
      if (!versions.includes(version)) versions.push(version);
    }
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
        if (found !== undefined) return { mismatch: found, versions };
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.end();
    if (pending !== '') {
      const found = consume(pending);
      if (found !== undefined) return { mismatch: found, versions };
    }
  } catch (error) {
    diagnostics.skippedFiles.push({ path, reason: `read failed: ${errorMessage(error)}` });
    return {
      mismatch: mismatch(expect.unreadableCode, `read failed: ${errorMessage(error)}`, {
        path,
        actual: errorCode(error),
      }),
      versions,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }

  return { versions };
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
    const accepted = acceptsVersion(version, expect.pinnedVersion, expect.versionWindow);
    // Order matters: a file that starts inside the window and then drifts OUT
    // of it must report the drift, not the generic "unsupported version" — the
    // two are different stories and the line number is the interesting part.
    if (fileVersion !== undefined && version !== fileVersion) {
      if (!accepted) {
        return mismatch(
          'versionChangedMidFile',
          '`version` changed partway through the file to one outside the accepted window',
          {
            path: where,
            field: 'version',
            expected: fileVersion,
            actual: version,
            observedVersion: version,
          },
        );
      }
      // Both versions are in the window: CC updated itself under a live
      // session. Accepted since Phase 4, and recorded by the caller.
    } else if (!accepted) {
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
  const window = versionWindow(pinnedVersion);
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
      versions: [...versions].sort(),
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
    { sessionId, pinnedVersion, versionWindow: window, unreadableCode: 'mainTranscriptUnreadable' },
    diagnostics,
  );
  if (mainScan.mismatch !== undefined) return refuse(mainScan.mismatch);
  for (const observed of mainScan.versions) versions.add(observed);

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
      {
        sessionId,
        agentId,
        pinnedVersion,
        versionWindow: window,
        unreadableCode: 'subagentTranscriptUnreadable',
      },
      diagnostics,
    );
    if (scan.mismatch !== undefined) return refuse(scan.mismatch);
    for (const observed of scan.versions) versions.add(observed);

    subagents.push({ agentId, transcriptPath, metaPath, meta: metaCheck.meta });
  }

  // No cross-file version check. There used to be one, refusing whenever the
  // session's files disagreed; under a window it would be unreachable, because
  // every version is checked against the window on the line that carries it,
  // in whichever file that is. Files that disagree therefore disagree only
  // about which IN-WINDOW version they were written by — a CC self-update
  // landing mid-session, which is the case Phase 4 exists to accept. The set
  // of versions is reported on the fingerprint instead of being refused.
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
