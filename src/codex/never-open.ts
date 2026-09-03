/**
 * Agent Deck — the Codex engine's G10 exclusion list (PLAN.md v0.6.0 DoD 2.1).
 *
 * Spec C10, verbatim:
 *
 *   > Named in code as an exclusion list and never opened, under the resolved
 *   > data root: the credential file, the two machine identifiers, the
 *   > sandbox-secrets directory, the network-fetched model cache (added
 *   > 2026-09-03 — a network-fetched cache is not exhaust), and every SQLite
 *   > store and its two sidecars. A test greps the engine source for each name
 *   > and asserts it appears only in that list.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NAMES ARE SPELLED OUT HERE AND NOWHERE ELSE UNDER `src/codex/`
 * ---------------------------------------------------------------------------
 *
 * The grep test in `never-open.test.ts` walks EVERY file under `src/codex/`,
 * including itself, and asserts each name occurs only in this file. That is
 * what makes the list auditable rather than decorative: a module that reaches
 * for one of these paths has to write its name to do so, and writing the name
 * turns the test red before the code is ever run.
 *
 * Two consequences a reader will otherwise trip over:
 *
 *   - **No other module here may mention these names, not even in a comment.**
 *     `locate.ts` does not skip `.sandbox-secrets` by name; it asks
 *     {@link isNeverOpenName}. That is the whole design, not an accident of
 *     style.
 *   - **The test derives its needles from these constants**, so the test file
 *     itself contains no literal either. A test that had to spell the names
 *     out would be the one file that could never satisfy the property it
 *     asserts.
 *
 * ---------------------------------------------------------------------------
 * TWO DELIBERATE WIDENINGS, BOTH IN THE SAFE DIRECTION
 * ---------------------------------------------------------------------------
 *
 * 1. **The exact-name entries match at ANY depth under the root**, not only at
 *    the top level. The spec places them at the root, and today they are there.
 *    Matching deeper costs nothing — the engine reads transcripts, which are
 *    named `rollout-<ts>-<uuid>.jsonl` — and a future Codex that moves the
 *    credential file one directory down does not get to walk through this list.
 *
 * 2. **Matching is case-insensitive.** NTFS is case-insensitive, so on the
 *    development and target platform a case-varied spelling names the same
 *    byte for byte file. Refusing both spellings on every platform refuses more,
 *    never less.
 *
 * Both widen a refusal. Neither can make the engine open something it would
 * otherwise have skipped, which is the only direction that could hurt.
 *
 * G1/G10: nothing in this file opens anything. It holds names and answers
 * questions about them; the filesystem is `locate.ts`'s business.
 */

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * Files named exactly, matched on the final path segment at any depth under
 * the resolved data root.
 *
 * The last of the four joined the list by dated amendment on 2026-09-03: it is
 * fetched over the network rather than written by a session, so it is not
 * exhaust, and a context window read out of it would be a claim about a model
 * rather than an observation of a thread.
 */
export const CODEX_NEVER_OPEN_NAMES = [
  'auth.json',
  'installation_id',
  'cap_sid',
  'models_cache.json',
] as const;

/**
 * Directories never descended into. A walk that meets one of these does not
 * read it, does not stat inside it, and does not report what it holds.
 */
export const CODEX_NEVER_OPEN_DIR_NAMES = ['.sandbox-secrets'] as const;

/**
 * File suffixes never opened: the SQLite store and its two sidecars.
 *
 * Excluded **by decision, not difficulty** (spec C10). They are live databases
 * Codex is writing, and opening one is a separate question with its own gate —
 * the OpenCode engine's read-only-WAL argument does not transfer for free.
 */
export const CODEX_NEVER_OPEN_SUFFIXES = ['.sqlite', '.sqlite-wal', '.sqlite-shm'] as const;

/**
 * The G10 list as a single auditable artifact, spelled the way the spec spells
 * it: a bare name is an exact file, a trailing `/` plus stars is a directory
 * and everything under it, a leading star is a suffix.
 *
 * Composed from the three constants above rather than restated, so there is
 * exactly one place a name can be added or dropped.
 */
export const CODEX_NEVER_OPEN: readonly string[] = [
  ...CODEX_NEVER_OPEN_NAMES,
  ...CODEX_NEVER_OPEN_DIR_NAMES.map((dir) => `${dir}/**`),
  ...CODEX_NEVER_OPEN_SUFFIXES.map((suffix) => `*${suffix}`),
];

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** Lower-cased once; see the case note in the file header. */
const NAMES_LC = new Set(CODEX_NEVER_OPEN_NAMES.map((n) => n.toLowerCase()));
const DIR_NAMES_LC = new Set(CODEX_NEVER_OPEN_DIR_NAMES.map((n) => n.toLowerCase()));
const SUFFIXES_LC = CODEX_NEVER_OPEN_SUFFIXES.map((s) => s.toLowerCase());

/**
 * Is a single path SEGMENT — a `Dirent.name`, never a path — on the list?
 *
 * This is the form a directory walk needs: it can be asked about a name before
 * anything has been joined, stat'ed or opened, so a forbidden directory is
 * skipped without the walk ever touching it.
 */
export function isNeverOpenName(name: string): boolean {
  const lower = name.toLowerCase();
  if (NAMES_LC.has(lower)) return true;
  if (DIR_NAMES_LC.has(lower)) return true;
  return SUFFIXES_LC.some((suffix) => lower.endsWith(suffix));
}

/** Split a path on both separators, dropping empty segments. */
function segments(value: string): string[] {
  return value.split(/[\\/]+/).filter((part) => part.length > 0);
}

/**
 * Is `target` on the never-open list, resolved against the data root `root`?
 *
 * `false` for anything that is not under `root`: this list is a statement about
 * the Codex data root, and a file of the same name in a user's project is not
 * ours to have an opinion about. The engine never reaches outside the root
 * anyway, so the two readings agree in production and differ only in what this
 * predicate is willing to claim.
 *
 * A path EQUAL to the root is not on the list; the root itself is walked.
 */
export function isNeverOpen(root: string, target: string): boolean {
  const rootParts = segments(root);
  const targetParts = segments(target);
  if (targetParts.length <= rootParts.length) return false;

  for (let i = 0; i < rootParts.length; i += 1) {
    const a = rootParts[i];
    const b = targetParts[i];
    if (a === undefined || b === undefined) return false;
    if (a.toLowerCase() !== b.toLowerCase()) return false;
  }

  // Any segment below the root being on the list condemns the whole path:
  // that is what the directory entry means — nothing beneath it is read.
  return targetParts.slice(rootParts.length).some((part) => isNeverOpenName(part));
}
