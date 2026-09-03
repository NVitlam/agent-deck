/**
 * Agent Deck - the Codex schema fingerprint (PLAN.md v0.6.0 Phase 2, DoD 2.2).
 *
 * The compatibility story `src/parser/fingerprint.ts` tells over a directory
 * layout and `src/opencode/fingerprint.ts` tells over a SQLite schema, told a
 * third time over a JSONL rollout transcript:
 *
 *   - **The structure is the whole of it** (spec C3). `session_meta.payload`
 *     must carry `id`, `cwd`, `cli_version` and `thread_source`; a subagent
 *     thread must carry `source.subagent.thread_spawn` with `depth` and
 *     `parent_thread_id`; every record must carry exactly C2's four top-level
 *     keys; every `function_call` / `custom_tool_call` must carry a `call_id`.
 *     Everything else in the file is IGNORED - six record types are observed
 *     and an unrecognised one is not this module's business at all (C2:
 *     "Unknown types are ignored, not refused"; the COUNT is P3's, through
 *     `CodexCounters.unknownRecordTypes`).
 *   - **The version string is a loose window, and neither the patch component
 *     nor the prerelease tag is compared at all** ({@link CODEX_VERSION_WINDOW},
 *     G9). The CC engine shipped the opposite defect twice - an exact pin, then
 *     a box of patch +/-5 that the release train simply walked out of - and from
 *     a given date every session on every user's machine rendered `unsupported`
 *     with the extension live on the Marketplace. A tolerance counted in patch
 *     releases is a countdown, not a policy. This engine starts where that one
 *     ended up, and the anchor's own prerelease tag (`alpha.7.2`) is proof that
 *     the component exists to be ignored rather than tracked.
 *   - **{@link PINNED_CODEX_VERSION} is a PROVENANCE anchor, not a support
 *     claim.** It names the release whose captured corpus proved the structure
 *     asserted here (`fixtures/codex-0.151.0-alpha.7.2/`), it moves only with a
 *     harvest, and moving it cannot make a version work, because the patch and
 *     prerelease components are not consulted. `fingerprint.test.ts` asserts the
 *     anchor names a corpus directory that exists and whose transcripts carry
 *     it, so moving the constant without harvesting fails.
 *
 * ---------------------------------------------------------------------------
 * THE DIALECT IS RESOLVED HERE AND IT NEVER REFUSES ON ITS OWN
 * ---------------------------------------------------------------------------
 *
 * Spec C3a. Codex ships two multi-agent toolsets and hands a session one of
 * them BY MODEL, at one `cli_version`: `v2` speaks `collaboration` and
 * populates `agent_path`, `v1` speaks `multi_agent_v1` and leaves it null.
 *
 * **A `v1` session is not refused, and a session that states no dialect at all
 * is not refused either** - it is `dialect: null`. That ruling was reversed
 * once already on corrected evidence, and `types.ts` records why: an earlier
 * draft parked the whole `v1` dialect on the premise that a `v1` child "cannot
 * be grafted", which was "I did not find a join" written down as "there is no
 * join". The only thing that refuses here is a STRUCTURAL mismatch above, plus
 * the one dialect case that is an error rather than an absence: two sources
 * DISAGREEING ({@link resolveCodexDialect}, C3a: "an error, not a tiebreak").
 *
 * The resolution order is normative and the first source is load-bearing:
 * `session_meta.payload.multi_agent_version` is ABSENT on every root thread in
 * the corpus, so `session_meta` alone cannot type a session that never spawned
 * anything. The corpus contains exactly that case - the `long-output` run, one
 * thread, no spawn records, `v1` stated only on its `turn_context`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PARAMETER IS `unknown[]` AND NOT `CodexRecord[]`
 * ---------------------------------------------------------------------------
 *
 * The hand-off line in `types.ts` names this module's input `CodexRecord[]`,
 * and a `CodexRecord[]` is what every caller passes. The parameter is widened
 * to `readonly unknown[]` because `recordShapeMismatch` exists: deciding
 * whether the input IS a `CodexRecord[]` is half of this module's job, and a
 * parameter that asserted the answer could not check it. Widening costs
 * callers nothing - `CodexRecord[]` is assignable to `unknown[]` - and it is
 * the difference between a guard and a restatement.
 */

import type {
  CodexDialect,
  CodexDialectSource,
  CodexFingerprint,
  CodexMismatch,
  CodexMismatchCode,
  CodexRecord,
} from './types.js';

// ---------------------------------------------------------------------------
// The version posture (G9)
// ---------------------------------------------------------------------------

/**
 * The **provenance anchor**: the Codex release whose committed corpus proved
 * the structure this module asserts - `fixtures/codex-0.151.0-alpha.7.2/`,
 * five runs, fourteen transcripts, 22 `session_meta` records.
 *
 * Never the version a binary reports. OpenCode self-updated `1.18.22` ->
 * `1.18.23` in the middle of a measurement while its store held rows written
 * by two other versions; the captured record is the evidence and the binary is
 * not. Spec C9 states the same rule for Codex before it could be re-learned.
 */
export const PINNED_CODEX_VERSION = '0.151.0-alpha.7.2';

/**
 * How far a `cli_version` may sit from the anchor and still be read.
 *
 * The major must match exactly and the minor may be one step either side, so a
 * rollover such as `0.151.999 -> 0.152.0` does not black the product out.
 * **The patch component is not compared, and neither is the prerelease tag.**
 * See the file header: the CC engine paid for that lesson twice, and this
 * object is the only place the allowance is written down.
 */
export const CODEX_VERSION_WINDOW: { readonly minor: number } = {
  minor: 1,
};

/**
 * A Codex version string decomposed.
 *
 * `prerelease` and `build` are parsed so that a malformed one can be REFUSED
 * rather than silently truncated to its numeric head. They are never compared;
 * they exist here to be recognised, not to be honoured.
 */
export interface CodexVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** `alpha.7.2` for the anchor. `null` when the string carries no `-` part. */
  readonly prerelease: string | null;
  /** The `+build` metadata. Never observed in the corpus; parsed anyway. */
  readonly build: string | null;
}

/**
 * `<major>.<minor>.<patch>` with an optional `-<prerelease>` and an optional
 * `+<build>`, each numeric component a decimal integer with no leading zero.
 *
 * Defensive by construction: `0.151`, `v0.151.0`, `00.151.0`, `0.151.0-`,
 * `nightly` and the empty string are NOT parsed into something plausible.
 * They return `undefined`, and the caller refuses (G3 - refuse, don't guess).
 *
 * `CodexMismatchCode` has no `unparseableVersion` member, so an unparseable
 * string refuses as {@link fingerprintThread}'s `versionOutOfWindow`. That is a
 * deliberate narrowing of the OpenCode engine, which distinguishes the two
 * codes; the code list is the frozen hand-off line and this module does not
 * widen it. The `field` of the mismatch names the field, and the reason is
 * recoverable by calling this function on the same string.
 */
export function parseCodexVersion(value: unknown): CodexVersion | undefined {
  if (typeof value !== 'string') return undefined;
  const match =
    /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(
      value,
    );
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    build: match[5] ?? null,
  };
}

/** The window around an anchor, materialised. */
export interface CodexVersionWindow {
  readonly anchor: string;
  readonly major: number;
  readonly minMinor: number;
  readonly maxMinor: number;
  /**
   * `<min> - <max>`, with `x` in the patch position and `-*` in the prerelease
   * position: neither is compared, and a label that hid that would be the
   * first place a reader learned the wrong policy.
   */
  readonly label: string;
}

/**
 * Derive the window from an anchor. Every bound comes from
 * {@link CODEX_VERSION_WINDOW} applied to the anchor - no endpoint is written
 * down a second time, so moving either cannot leave a stale literal behind.
 */
export function codexVersionWindow(
  anchor: string = PINNED_CODEX_VERSION,
): CodexVersionWindow | undefined {
  const parsed = parseCodexVersion(anchor);
  if (parsed === undefined) return undefined;
  const minMinor = Math.max(0, parsed.minor - CODEX_VERSION_WINDOW.minor);
  const maxMinor = parsed.minor + CODEX_VERSION_WINDOW.minor;
  return {
    anchor,
    major: parsed.major,
    minMinor,
    maxMinor,
    label: `${parsed.major}.${minMinor}.x-* - ${parsed.major}.${maxMinor}.x-*`,
  };
}

/**
 * Is `version` inside the acceptance window around `anchor`? (G9, spec C9.)
 *
 * The string half of the policy, in one predicate. The other half - the half
 * that does the real work - is {@link fingerprintThread}'s structural pass.
 */
export function isCodexVersionAccepted(
  version: unknown,
  anchor: string = PINNED_CODEX_VERSION,
): boolean {
  // An anchor that does not parse still accepts itself verbatim: exact
  // equality can never be a guess.
  if (typeof version === 'string' && version === anchor) return true;
  const window = codexVersionWindow(anchor);
  if (window === undefined) return false;
  const parsed = parseCodexVersion(version);
  if (parsed === undefined) return false;
  // `parsed.patch`, `parsed.prerelease` and `parsed.build` are deliberately
  // absent from this comparison. Re-adding any of them re-arms the blackout.
  return (
    parsed.major === window.major &&
    parsed.minor >= window.minMinor &&
    parsed.minor <= window.maxMinor
  );
}

// ---------------------------------------------------------------------------
// The structural half (spec C2, C3)
// ---------------------------------------------------------------------------

/**
 * C2: "Every record carries exactly four top-level keys and no others."
 *
 * Asserted as an exact SET, never a containment. Rule 19 is written about
 * artifacts, and the reasoning transfers without change: the defect shape is a
 * key nobody expected, so the only assertion that can see it is equality.
 */
export const CODEX_RECORD_KEYS: readonly string[] = ['timestamp', 'ordinal', 'type', 'payload'];

/**
 * C3's `session_meta.payload` fields, minus `cli_version`, which has its own
 * mismatch code and its own window and is therefore checked separately.
 *
 * Insertion order is the refusal order, so a mutated `session_meta` refuses at
 * a stable, reportable field.
 */
export const CODEX_SESSION_META_FIELDS: readonly string[] = ['id', 'cwd', 'thread_source'];

/**
 * C3: a thread whose `thread_source` is `subagent` carries
 * `source.subagent.thread_spawn` with these two.
 *
 * **`agent_path` is deliberately NOT here** (spec C3, user decision
 * 2026-09-03), and neither is `agent_nickname`. Requiring `agent_path` would
 * refuse an entire dialect of live sessions, because a `v1` thread's
 * `agent_path` is present-and-`null`. `types.ts` leaves the corresponding code
 * out of `CodexMismatchCode` for the same reason.
 */
export const CODEX_THREAD_SPAWN_FIELDS: readonly string[] = ['depth', 'parent_thread_id'];

/**
 * The `response_item.payload.type` values that must carry a `call_id` (DoD
 * 2.2). Both are observed in the corpus - a `v2` shell command is a
 * `custom_tool_call` named `exec` and a `v1` one is a `function_call` named
 * `exec_command` - so a check written against either alone would pass on half
 * the corpus while measuring nothing on the other half.
 */
export const CODEX_CALL_PAYLOAD_TYPES: readonly string[] = ['function_call', 'custom_tool_call'];

/**
 * The tool whose `namespace` corroborates the dialect (C3a). Exported rather
 * than repeated: `parse.ts` needs the same literal, and "two agreeing literals
 * is not a contract" is this repository's most expensive recorded seam.
 */
export const CODEX_SPAWN_TOOL_NAME = 'spawn_agent';

/**
 * The namespace-to-dialect map (C3a). Corroboration only: it is the LAST
 * source in the resolution order, and a session that never spawns has none.
 */
export const CODEX_DIALECT_BY_NAMESPACE: ReadonlyMap<string, CodexDialect> = new Map<
  string,
  CodexDialect
>([
  ['collaboration', 'v2'],
  ['multi_agent_v1', 'v1'],
]);

/** The three dialect sources in the normative resolution order of C3a. */
export const CODEX_DIALECT_SOURCE_ORDER: readonly CodexDialectSource[] = [
  'turn_context.multi_agent_version',
  'session_meta.multi_agent_version',
  'spawn_namespace',
];

// ---------------------------------------------------------------------------
// Small readers. Every one of them tolerates `unknown` - the input to this
// module is JSON somebody else parsed, and a thrown TypeError is not a refusal.
// ---------------------------------------------------------------------------

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readObject(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecordObject(value)) return undefined;
  const child = value[key];
  return isRecordObject(child) ? child : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecordObject(value)) return undefined;
  const child = value[key];
  return typeof child === 'string' ? child : undefined;
}

/** The basename of a path in either separator, so `at` can never be a path. */
function baseName(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return cut < 0 ? file : file.slice(cut + 1);
}

// ---------------------------------------------------------------------------
// fingerprintThread
// ---------------------------------------------------------------------------

export interface CodexFingerprintOptions {
  /**
   * The transcript's basename, for `CodexMismatch.at`. A full path is reduced
   * to its basename here rather than trusted: `types.ts` says `at` is
   * "`<basename>:<ordinal>` ... Never a full path", and a guarantee a caller
   * can break by passing the wrong string is not a guarantee.
   */
  readonly file?: string;
  /** Overrides {@link PINNED_CODEX_VERSION}. Tests move the anchor, not the window. */
  readonly anchor?: string;
}

/** A shape-checked record, plus where it sat, so `at` never has to guess. */
export interface CodexLocatedRecord {
  readonly record: CodexRecord;
  readonly index: number;
}

/** One dialect declaration, with the source that made it and where it was. */
interface DialectDeclaration {
  readonly dialect: CodexDialect;
  readonly source: CodexDialectSource;
  readonly at: string;
}

function refuse(
  code: CodexMismatchCode,
  at?: string,
  field?: string,
): { readonly ok: false; readonly mismatch: CodexMismatch } {
  const mismatch: CodexMismatch = {
    code,
    ...(at === undefined ? {} : { at }),
    ...(field === undefined ? {} : { field }),
  };
  return { ok: false, mismatch };
}

/**
 * Assert C2's record shape over one line's parsed value.
 *
 * Returns the record when the four keys are all there and nothing else is, and
 * when `ordinal` is a number, `type` a string and `timestamp` a string - the
 * ones the rest of this module reads structurally. A record whose `ordinal` is
 * the STRING `"0"` would otherwise pass every check here and then fail to be
 * found at ordinal 0, which is a refusal reported at the wrong place.
 */
function shapeOf(value: unknown): CodexRecord | undefined {
  if (!isRecordObject(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== CODEX_RECORD_KEYS.length) return undefined;
  for (const key of CODEX_RECORD_KEYS) {
    if (!Object.hasOwn(value, key)) return undefined;
  }
  const ordinal = value['ordinal'];
  if (typeof ordinal !== 'number' || !Number.isFinite(ordinal)) return undefined;
  if (typeof value['type'] !== 'string') return undefined;
  if (typeof value['timestamp'] !== 'string') return undefined;
  return value as unknown as CodexRecord;
}

/** {@link resolveCodexDialect}'s result. A refusal here is never an absence. */
export type CodexDialectResolution =
  | {
      readonly ok: true;
      readonly dialect: CodexDialect | null;
      readonly dialectSource: CodexDialectSource | null;
    }
  | { readonly ok: false; readonly mismatch: CodexMismatch };

/**
 * Resolve the dialect of a thread from its records, in C3a's normative order.
 *
 * Three outcomes and only three:
 *
 *   - exactly one dialect declared, by any number of sources that agree ->
 *     that dialect, labelled with the FIRST source in the order that declared
 *     it (so `long-output` reports `turn_context.multi_agent_version`, which is
 *     the only source it has);
 *   - two or more dialects declared -> `dialectContradiction`. C3a:
 *     "Two sources disagreeing is an error, not a tiebreak." This is stricter
 *     than `scripts/codex-golden.mjs`, which falls through to the next source
 *     and labels the result `ambiguous(...)`; the generator is a diagnostic
 *     reference and the engine is the thing a user's tree is built from. On
 *     the committed corpus the two agree on all five runs, so nothing rests on
 *     the difference today.
 *   - nothing declared -> `dialect: null`, `dialectSource: null`, and NOT a
 *     refusal.
 *
 * A declared value that is neither `v1` nor `v2` is not a declaration: it
 * cannot be represented as a {@link CodexDialect}, and refusing on it would
 * black out a future dialect exactly the way the CC version box blacked out a
 * future patch release. Such a session resolves to `dialect: null`, which is
 * the "unknown" the type already has a value for.
 */
export function resolveCodexDialect(
  records: readonly CodexLocatedRecord[],
): CodexDialectResolution {
  const declarations: DialectDeclaration[] = [];

  for (const { record } of records) {
    const at = String(record.ordinal);
    if (record.type === 'turn_context' || record.type === 'session_meta') {
      const declared = readString(record.payload, 'multi_agent_version');
      if (declared === 'v1' || declared === 'v2') {
        declarations.push({
          dialect: declared,
          source:
            record.type === 'turn_context'
              ? 'turn_context.multi_agent_version'
              : 'session_meta.multi_agent_version',
          at,
        });
      }
      continue;
    }
    if (record.type !== 'response_item') continue;
    const payload = record.payload;
    if (!isRecordObject(payload)) continue;
    if (payload['name'] !== CODEX_SPAWN_TOOL_NAME) continue;
    const namespace = readString(payload, 'namespace');
    if (namespace === undefined) continue;
    const declared = CODEX_DIALECT_BY_NAMESPACE.get(namespace);
    if (declared !== undefined) {
      declarations.push({ dialect: declared, source: 'spawn_namespace', at });
    }
  }

  if (declarations.length === 0) return { ok: true, dialect: null, dialectSource: null };

  // The reference is the HIGHEST-PRIORITY source that declared anything, not
  // the first record in the file. `turn_context` is C3a's primary source, and
  // a subagent transcript's `session_meta` sits at ordinal 0 - so a
  // record-order reference would report the normative source as the dissenter
  // and name the innocent party.
  const primary = CODEX_DIALECT_SOURCE_ORDER.map((source) =>
    declarations.find((d) => d.source === source),
  ).find((d) => d !== undefined)!;

  const distinct = new Set(declarations.map((d) => d.dialect));
  if (distinct.size > 1) {
    const dissent = declarations.find((d) => d.dialect !== primary.dialect)!;
    return refuse('dialectContradiction', dissent.at, dissent.source);
  }

  const dialect = primary.dialect;
  for (const source of CODEX_DIALECT_SOURCE_ORDER) {
    if (declarations.some((d) => d.source === source)) {
      return { ok: true, dialect, dialectSource: source };
    }
  }
  /* c8 ignore next 2 -- every declaration carries one of the three sources. */
  return { ok: true, dialect, dialectSource: null };
}

/**
 * Fingerprint one thread's records (spec C3). Never throws; a refusal is
 * RETURNED, and it renders the session `unsupported` with no tree (G3).
 *
 * The checks run in this order, and the order is part of the contract because
 * a mutation fixture asserts an exact code:
 *
 *   1. every record's shape                     -> `recordShapeMismatch`
 *   2. a `session_meta` at ordinal 0            -> `sessionMetaMissing`
 *   3. its `id` / `cwd` / `thread_source`       -> `sessionMetaFieldMissing`
 *   4. its `cli_version` present                -> `cliVersionMissing`
 *   5. that version inside the G9 window        -> `versionOutOfWindow`
 *   6. EVERY subagent `session_meta`'s spawn    -> `subagentSpawnMissing`
 *   7. every call's `call_id`                   -> `callIdMissing`
 *   8. the dialect                              -> `dialectContradiction`
 *
 * Step 6 walks every `session_meta` in the input, not only the one at ordinal
 * 0. A forked child re-serialises its parent's `session_meta` into its own
 * file (C5), so one transcript declares more than one thread - 8 of the 14
 * committed transcripts do - and a check scoped to ordinal 0 would leave the
 * inherited declaration unasserted.
 */
export function fingerprintThread(
  records: readonly unknown[],
  options: CodexFingerprintOptions = {},
): CodexFingerprint {
  const anchor = options.anchor ?? PINNED_CODEX_VERSION;
  const file = options.file === undefined ? undefined : baseName(options.file);
  const at = (ordinal: number | string): string =>
    file === undefined ? String(ordinal) : `${file}:${ordinal}`;

  // 1. C2's four keys, exactly, on every record.
  const located: CodexLocatedRecord[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const raw = records[index];
    const record = shapeOf(raw);
    if (record === undefined) {
      // The ordinal is exactly what is in doubt here, so `at` falls back to
      // the position in the input, marked `#` so it cannot be misread as one.
      const ordinal =
        isRecordObject(raw) && typeof raw['ordinal'] === 'number'
          ? String(raw['ordinal'])
          : `#${index}`;
      return refuse('recordShapeMismatch', at(ordinal), 'record');
    }
    located.push({ record, index });
  }

  // 2. The owning thread is declared by the `session_meta` at ordinal 0.
  const meta = located.find(
    ({ record }) => record.type === 'session_meta' && record.ordinal === 0,
  )?.record;
  if (meta === undefined) return refuse('sessionMetaMissing', at(0), 'session_meta');

  // 3. C3's three plain fields.
  for (const field of CODEX_SESSION_META_FIELDS) {
    if (readString(meta.payload, field) === undefined) {
      return refuse('sessionMetaFieldMissing', at(meta.ordinal), `session_meta.payload.${field}`);
    }
  }

  // 4. and 5. `cli_version`: present, then inside the window. Two codes,
  // because "Codex did not say" and "Codex said something we have never
  // harvested" are different stories and a user is told which.
  const cliVersion = readString(meta.payload, 'cli_version');
  if (cliVersion === undefined || cliVersion === '') {
    return refuse('cliVersionMissing', at(meta.ordinal), 'session_meta.payload.cli_version');
  }
  if (!isCodexVersionAccepted(cliVersion, anchor)) {
    return refuse('versionOutOfWindow', at(meta.ordinal), 'session_meta.payload.cli_version');
  }

  // 6. Every subagent declaration in the file, inherited ones included.
  for (const { record } of located) {
    if (record.type !== 'session_meta') continue;
    if (readString(record.payload, 'thread_source') !== 'subagent') continue;
    const source = readObject(record.payload, 'source');
    const subagent = source === undefined ? undefined : readObject(source, 'subagent');
    const spawn = subagent === undefined ? undefined : readObject(subagent, 'thread_spawn');
    if (spawn === undefined) {
      return refuse(
        'subagentSpawnMissing',
        at(record.ordinal),
        'session_meta.payload.source.subagent.thread_spawn',
      );
    }
    for (const field of CODEX_THREAD_SPAWN_FIELDS) {
      const value = spawn[field];
      if (value === undefined || value === null) {
        return refuse(
          'subagentSpawnMissing',
          at(record.ordinal),
          `session_meta.payload.source.subagent.thread_spawn.${field}`,
        );
      }
    }
  }

  // 7. Every tool call names itself. C4's two id namespaces both hang off
  // this key, so a call without one cannot be joined to anything at all.
  for (const { record } of located) {
    if (record.type !== 'response_item') continue;
    const payload = record.payload;
    if (!isRecordObject(payload)) continue;
    const payloadType = payload['type'];
    if (typeof payloadType !== 'string') continue;
    if (!CODEX_CALL_PAYLOAD_TYPES.includes(payloadType)) continue;
    const callId = readString(payload, 'call_id');
    if (callId === undefined || callId === '') {
      return refuse('callIdMissing', at(record.ordinal), `${payloadType}.call_id`);
    }
  }

  // 8. The dialect. Never a refusal except when two sources disagree.
  const dialect = resolveCodexDialect(located);
  if (!dialect.ok) {
    return refuse(
      dialect.mismatch.code,
      dialect.mismatch.at === undefined ? undefined : at(dialect.mismatch.at),
      dialect.mismatch.field,
    );
  }

  return {
    ok: true,
    cliVersion,
    dialect: dialect.dialect,
    dialectSource: dialect.dialectSource,
  };
}
