/**
 * Agent Deck — the OpenCode schema fingerprint (PLAN.md Phase 4, DoD 4.2).
 *
 * The same compatibility story `src/parser/fingerprint.ts` tells for Claude
 * Code, told over a SQLite schema instead of a directory layout:
 *
 *   - **The structure is the whole of it.** Contract §3's six tables and the
 *     columns the engine reads must be there. Everything else in the file —
 *     nine other tables in both committed corpora, and a dozen unread columns
 *     on `session` and `project` alone — is IGNORED and COUNTED, never
 *     refused. That is the CC unknown-field rule applied to a schema.
 *   - **The version string is a loose window, and the patch component is not
 *     compared at all** ({@link OC_VERSION_WINDOW}). G9, mirrored. The CC side
 *     shipped the same defect twice — an exact pin, then a box of patch ±5 that
 *     the release train walked out of — and blacked out every session on every
 *     user's machine. A tolerance counted in patch releases is a countdown.
 *     This engine starts where that one ended up.
 *   - **{@link PINNED_OPENCODE_VERSION} is a PROVENANCE anchor, not a support
 *     claim.** It names the release whose captured fixture proved the schema
 *     asserted here, it moves only with a harvest, and moving it cannot make a
 *     version work because the patch number is not consulted.
 *     `fingerprint.test.ts` asserts the anchor names a corpus that exists and
 *     carries `opencode.db`, so moving the constant without harvesting fails.
 *
 * ---------------------------------------------------------------------------
 * TWO ALTITUDES OF REFUSAL, KEPT APART
 * ---------------------------------------------------------------------------
 *
 * A missing table or column is a property of the DATABASE: every session
 * refuses, because the engine cannot read the store at all
 * ({@link fingerprintSchema}).
 *
 * A version outside the window is a property of ONE SESSION
 * ({@link fingerprintSessionVersion}). A mixed-version database is the normal
 * case, not a hypothetical — the measured one held five `1.18.21` rows beside
 * twenty-three `1.18.22` — so in-window sessions render and the rest are parked
 * with `unsupportedVersion` ({@link partitionSessionsByVersion}).
 *
 * Degradation is a third thing again and belongs to `db.ts`: a database that
 * will not open is not a schema mismatch, and conflating them would report a
 * missing file as a drifted OpenCode release.
 *
 * ---------------------------------------------------------------------------
 * ONE REQUIRED COLUMN THAT NOTHING READS — ON PURPOSE
 * ---------------------------------------------------------------------------
 *
 * **SUPERSEDED 2026-08-31, and the superseded reason is left here because it was
 * the right reason for two of the three columns and is now wrong for both.**
 * This paragraph used to read "THREE REQUIRED COLUMNS THAT NOTHING READS YET",
 * naming `session.tokens_reasoning`, `session.tokens_cache_read` and
 * `session.tokens_cache_write`, and it explained that `db.ts` did not select
 * them "because the hand-off type `OcSessionRow` has no field for them and
 * `SessionState`'s token totals are `{ in, out }`".
 *
 * Both halves of that explanation expired. `SessionState`'s totals became
 * `TokenPair` at the Phase 7 gate, and on 2026-08-31 `OcSessionRow` gained the
 * two cache fields, because `tokens_input + tokens_cache_read +
 * tokens_cache_write` IS `TokenPair.prompt` — an identity verified on 78 of 78
 * sessions (`docs/evidence/release-0.5.0/OC-CTX.md` §2.4). **`db.ts` selects
 * both cache columns now**, and the assertion here is what guarantees they are
 * there to select.
 *
 * What survives, for **`session.tokens_reasoning` alone**: it is required and
 * unread. OpenCode keeps reasoning in its own bucket — not inside
 * `tokens_output` — and `TokenPair` has nowhere to put a third number, so
 * reading it would mean inventing a place for it. It is asserted rather than
 * read: if a future OpenCode drops it, the engine refuses instead of quietly
 * rendering a tree built on a schema it has never seen. Written down because
 * "a required column nothing reads" looks like an oversight and is not.
 */

import { readSchema } from './db.js';
import type { OcHealthFailure, OcSchema } from './db.js';
import type { OcMismatch, OcMismatchCode, OcSessionRow } from './types.js';

// ---------------------------------------------------------------------------
// The version posture (G9, mirrored)
// ---------------------------------------------------------------------------

/**
 * The **provenance anchor**: the OpenCode release whose committed corpus proved
 * the schema this module asserts — `fixtures/opencode-1.18.22/`, 24 sessions,
 * the Phase 3 anchor.
 *
 * Never the binary's version. OpenCode self-updated `1.18.22` -> `1.18.23`
 * mid-measurement while the database held rows written by `1.18.21` and
 * `1.18.22`; the row is the evidence and the binary is not (OC5).
 */
export const PINNED_OPENCODE_VERSION = '1.18.22';

/**
 * How far a `session.version` may sit from the anchor and still be read.
 *
 * The major must match exactly and the minor may be one step either side, so a
 * rollover such as `1.18.999 -> 1.19.0` does not black the product out. **The
 * patch component is not compared.** See the file header: the CC engine paid
 * for that lesson twice, and this is the only place the allowance is written.
 */
export const OC_VERSION_WINDOW: { readonly minor: number } = {
  minor: 1,
};

/** An OpenCode version string decomposed. Exactly three components. */
export interface OcVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Strictly `<major>.<minor>.<patch>`, each a decimal integer with no leading
 * zero. `1.18`, `1.18.22-beta`, `v1.18.22`, `01.18.22` and `` are NOT parsed
 * into something plausible — they return `undefined` and the caller refuses
 * with `unparseableVersion` (G3).
 */
export function parseOpencodeVersion(value: string): OcVersion | undefined {
  const match = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(value);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** The window around an anchor, materialised. */
export interface OcVersionWindow {
  anchor: string;
  major: number;
  minMinor: number;
  maxMinor: number;
  /** `<min> - <max>`, with `x` in the patch position: it is not compared. */
  label: string;
}

/**
 * Derive the window from an anchor. Every bound comes from
 * {@link OC_VERSION_WINDOW} applied to the anchor — no endpoint is ever written
 * down a second time, so moving either cannot leave a stale literal behind.
 */
export function opencodeVersionWindow(
  anchor: string = PINNED_OPENCODE_VERSION,
): OcVersionWindow | undefined {
  const parsed = parseOpencodeVersion(anchor);
  if (parsed === undefined) return undefined;
  const minMinor = Math.max(0, parsed.minor - OC_VERSION_WINDOW.minor);
  const maxMinor = parsed.minor + OC_VERSION_WINDOW.minor;
  return {
    anchor,
    major: parsed.major,
    minMinor,
    maxMinor,
    label: `${parsed.major}.${minMinor}.x - ${parsed.major}.${maxMinor}.x`,
  };
}

/**
 * Is `version` inside the acceptance window around `anchor`?
 *
 * The string half of the policy, in one predicate. The other half — the half
 * that does the real work — is {@link REQUIRED_COLUMNS}.
 */
export function isOpencodeVersionAccepted(
  version: string,
  anchor: string = PINNED_OPENCODE_VERSION,
): boolean {
  // An anchor that does not parse still accepts itself verbatim: exact
  // equality can never be a guess.
  if (version === anchor) return true;
  const window = opencodeVersionWindow(anchor);
  if (window === undefined) return false;
  const parsed = parseOpencodeVersion(version);
  if (parsed === undefined) return false;
  // The patch component is deliberately absent from this comparison. Re-adding
  // it re-arms the blackout; see OC_VERSION_WINDOW.
  return (
    parsed.major === window.major &&
    parsed.minor >= window.minMinor &&
    parsed.minor <= window.maxMinor
  );
}

// ---------------------------------------------------------------------------
// The structural half
// ---------------------------------------------------------------------------

/**
 * Contract §3's six tables and the columns the engine reads, in the order they
 * are asserted. Insertion order is the refusal order, so a mutated schema
 * refuses at a stable, reportable place.
 *
 * SQLite identifiers are case-insensitive; every comparison here lower-cases
 * both sides, and these keys are already lower-case.
 */
export const REQUIRED_COLUMNS: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ['project', ['id', 'worktree', 'vcs']],
  [
    'session',
    [
      'id',
      'project_id',
      'parent_id',
      'version',
      'agent',
      'title',
      'directory',
      'slug',
      'model',
      'cost',
      'tokens_input',
      'tokens_output',
      'tokens_reasoning',
      'tokens_cache_read',
      'tokens_cache_write',
      'time_created',
      'time_updated',
      'time_archived',
    ],
  ],
  ['message', ['id', 'session_id', 'time_created', 'time_updated', 'data']],
  ['part', ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data']],
  ['event', ['id', 'aggregate_id', 'seq', 'type', 'data']],
  ['event_sequence', ['aggregate_id', 'seq', 'owner_id']],
]);

/** The six table names, derived from {@link REQUIRED_COLUMNS}, never restated. */
export const REQUIRED_TABLES: readonly string[] = [...REQUIRED_COLUMNS.keys()];

/**
 * What a schema that passed looks like.
 *
 * The `unknown*` fields are the "ignored and counted" half of DoD 4.2. They are
 * reported rather than merely tolerated so a new OpenCode table shows up in a
 * counter somewhere instead of being invisible.
 */
export interface OcSchemaReport {
  /** The required tables, in assertion order. All present, by construction. */
  readonly tables: readonly string[];
  /** Tables in the file that the engine does not read. Ignored. */
  readonly unknownTables: readonly string[];
  /** `table.column` for unread columns of REQUIRED tables only. Ignored. */
  readonly unknownColumns: readonly string[];
  readonly unknownTableCount: number;
  readonly unknownColumnCount: number;
}

/** {@link fingerprintSchema}'s result. A mismatch here refuses everything. */
export type OcSchemaResult =
  | { readonly ok: true; readonly value: OcSchemaReport }
  | { readonly ok: false; readonly mismatch: OcMismatch };

function mismatch(
  code: OcMismatchCode,
  reason: string,
  extra: Omit<OcMismatch, 'kind' | 'code' | 'reason'> = {},
): OcMismatch {
  return { kind: 'schemaMismatch', code, reason, ...extra };
}

/**
 * Assert contract §3 over a schema read by `db.ts`.
 *
 * Pure: it takes the schema, not a path, so every branch is testable without a
 * database — and so this module has exactly one way to reach the filesystem
 * ({@link fingerprintDatabase}), which goes through `db.ts` like everything
 * else.
 */
export function fingerprintSchema(schema: OcSchema): OcSchemaResult {
  // Lower-case both sides once. SQLite would match `SESSION` to `session`, and
  // a fingerprint that refused on spelling would be reporting drift that is
  // not there.
  const present = new Map<string, Set<string>>();
  for (const [table, columns] of schema.tables) {
    present.set(table.toLowerCase(), new Set(columns.map((c) => c.toLowerCase())));
  }

  for (const [table, columns] of REQUIRED_COLUMNS) {
    const actual = present.get(table);
    if (actual === undefined) {
      return {
        ok: false,
        mismatch: mismatch(
          'missingTable',
          `required table \`${table}\` is absent from sqlite_master`,
          { at: table, expected: table },
        ),
      };
    }
    for (const column of columns) {
      if (!actual.has(column)) {
        return {
          ok: false,
          mismatch: mismatch(
            'missingColumn',
            `required column \`${table}.${column}\` is absent`,
            { at: `${table}.${column}`, expected: column },
          ),
        };
      }
    }
  }

  const unknownTables = [...present.keys()].filter((name) => !REQUIRED_COLUMNS.has(name)).sort();
  const unknownColumns: string[] = [];
  for (const [table, columns] of REQUIRED_COLUMNS) {
    const required = new Set(columns);
    for (const column of present.get(table) ?? []) {
      if (!required.has(column)) unknownColumns.push(`${table}.${column}`);
    }
  }
  unknownColumns.sort();

  return {
    ok: true,
    value: {
      tables: REQUIRED_TABLES,
      unknownTables,
      unknownColumns,
      unknownTableCount: unknownTables.length,
      unknownColumnCount: unknownColumns.length,
    },
  };
}

/**
 * Three outcomes, named, because two of them are not the same kind of thing.
 *
 * `degraded` is the database's health (`db.ts`); `schemaMismatch` is a refusal
 * about what is in it. Collapsing them into one falsy value is how "OpenCode is
 * not installed" would end up reported as "OpenCode changed its schema".
 */
export type OcFingerprintOutcome =
  | { readonly kind: 'ok'; readonly report: OcSchemaReport }
  | { readonly kind: 'schemaMismatch'; readonly mismatch: OcMismatch }
  | { readonly kind: 'degraded'; readonly health: OcHealthFailure };

/** Read a database's schema through `db.ts` and assert it. Never throws. */
export function fingerprintDatabase(dbPath: string): OcFingerprintOutcome {
  const read = readSchema(dbPath);
  if (!read.ok) return { kind: 'degraded', health: read.health };
  const result = fingerprintSchema(read.value);
  if (!result.ok) return { kind: 'schemaMismatch', mismatch: result.mismatch };
  return { kind: 'ok', report: result.value };
}

// ---------------------------------------------------------------------------
// The per-session half
// ---------------------------------------------------------------------------

/** A refusal that names the session it is about. */
export type OcSessionMismatch = OcMismatch & { readonly sessionId: string };

/**
 * Refuse ONE session on its `version`, or return `undefined` to accept it.
 *
 * Two codes, not one: an unparseable string is a different story from a
 * parseable one that is too far away, and guessing at an unrecognised version
 * is the exact failure the fingerprint exists to prevent.
 */
export function fingerprintSessionVersion(
  session: { readonly id: string; readonly version: string },
  anchor: string = PINNED_OPENCODE_VERSION,
): OcSessionMismatch | undefined {
  const window = opencodeVersionWindow(anchor);
  if (parseOpencodeVersion(session.version) === undefined && session.version !== anchor) {
    return {
      ...mismatch(
        'unparseableVersion',
        `session.version \`${session.version}\` is not <major>.<minor>.<patch>`,
        {
          at: session.id,
          expected: window?.label ?? anchor,
          actual: session.version,
          observedVersion: session.version,
        },
      ),
      sessionId: session.id,
    };
  }
  if (isOpencodeVersionAccepted(session.version, anchor)) return undefined;
  return {
    ...mismatch(
      'unsupportedVersion',
      `session.version \`${session.version}\` is outside ${window?.label ?? anchor}`,
      {
        at: session.id,
        expected: window?.label ?? anchor,
        actual: session.version,
        observedVersion: session.version,
      },
    ),
    sessionId: session.id,
  };
}

/** What a mixed-version database splits into. Order is the input's order. */
export interface OcSessionPartition {
  readonly accepted: readonly OcSessionRow[];
  readonly refused: readonly OcSessionMismatch[];
}

/**
 * Split session rows into the ones that render and the ones that are parked.
 *
 * A refused session is NOT absent — it renders `unsupported` — so both halves
 * are returned and the caller reports the second rather than dropping it.
 */
export function partitionSessionsByVersion(
  sessions: readonly OcSessionRow[],
  anchor: string = PINNED_OPENCODE_VERSION,
): OcSessionPartition {
  const accepted: OcSessionRow[] = [];
  const refused: OcSessionMismatch[] = [];
  for (const session of sessions) {
    const refusal = fingerprintSessionVersion(session, anchor);
    if (refusal === undefined) accepted.push(session);
    else refused.push(refusal);
  }
  return { accepted, refused };
}
