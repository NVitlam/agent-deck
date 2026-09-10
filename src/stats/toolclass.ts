/**
 * Tool classes and file-argument keys, GENERATED — do not hand-edit.
 *
 *     node scripts/gen-toolclass.mjs
 *
 * Source: `docs/evidence/phase-0-stats/TOOLCLASS.md` (Phase 0, DoD 0.3), a census over every committed
 * corpus. DoD 0.3 says the table, not memory, generates this file.
 *
 *   `cc`: 12 tools
 *   `codex`: 7 tools
 *   `opencode`: 10 tools
 *
 * ## The rows are here on purpose
 *
 * `docs/` is a junction into the private `lab/` repository and is gitignored
 * in the public one, so the census is NOT reachable from a fresh clone or from
 * CI. Carrying the rows makes this file checkable against its own source
 * everywhere, and {@link TOOLCLASS_DIGEST} goes red if they are edited without
 * regenerating. `toolclass.test.ts` checks the derivation here; its dev-only
 * leg checks these rows still match the census.
 *
 * ## Unknown tools
 *
 * `classOf` answers `'other'` and `fileKeyOf` answers `undefined` for any tool
 * not listed. That is the defined answer, not a fallback: a tool nobody has
 * captured has no measured class, and inventing one would be memory rather than
 * fixture (G6). `NotebookEdit`, `patch` and `local_shell_call` are absent for
 * exactly this reason — the Phase 0 spike guessed at them; no corpus has one.
 */

/** What a tool DOES, as measured. */
export type ToolClass = 'read' | 'write' | 'edit' | 'search' | 'shell' | 'spawn' | 'other';

/**
 * The shape of a tool's recorded input.
 *
 * Three states, not two, and the distinction is the census's. `'string'` is an
 * unstructured input that can carry no key at all — Codex's `exec` is a
 * `custom_tool_call` whose input is a string of JavaScript — which is a
 * different fact from an object input with no path in it.
 */
export type ToolInputShape = 'object' | 'string' | 'none';

/** Which engine's vocabulary a row belongs to. Tool names collide across engines. */
export type ToolEngine = 'cc' | 'opencode' | 'codex';

export interface ToolClassRow {
  readonly engine: ToolEngine;
  readonly tool: string;
  readonly class: ToolClass;
  readonly input: ToolInputShape;
  /** The key holding the file this call touches. Only ever on a file class. */
  readonly fileKey?: string;
}

/** SHA-256 over the census rows below. Recomputed and asserted by the test. */
export const TOOLCLASS_DIGEST = '9f97bbce0e201d7bd813551db0e6b47d54fba9314c23d0fd608afdc09a58e5d4';

/** Classes whose calls touch a named file. */
export const FILE_CLASSES: ReadonlySet<ToolClass> = new Set(['read', 'write', 'edit']);

/** Every row of the census, verbatim. */
export const TOOLCLASS_ROWS: readonly ToolClassRow[] = [
  { engine: 'cc', tool: 'Agent', class: 'spawn', input: 'object' },
  { engine: 'cc', tool: 'AskUserQuestion', class: 'other', input: 'object' },
  { engine: 'cc', tool: 'Bash', class: 'shell', input: 'object' },
  { engine: 'cc', tool: 'Edit', class: 'edit', input: 'object', fileKey: 'file_path' },
  { engine: 'cc', tool: 'Glob', class: 'search', input: 'object' },
  { engine: 'cc', tool: 'Grep', class: 'search', input: 'object' },
  { engine: 'cc', tool: 'Read', class: 'read', input: 'object', fileKey: 'file_path' },
  { engine: 'cc', tool: 'SendMessage', class: 'other', input: 'object' },
  { engine: 'cc', tool: 'Skill', class: 'other', input: 'object' },
  { engine: 'cc', tool: 'TaskStop', class: 'other', input: 'object' },
  { engine: 'cc', tool: 'ToolSearch', class: 'other', input: 'object' },
  { engine: 'cc', tool: 'Write', class: 'write', input: 'object', fileKey: 'file_path' },
  { engine: 'codex', tool: 'exec', class: 'shell', input: 'string' },
  { engine: 'codex', tool: 'exec_command', class: 'shell', input: 'object' },
  { engine: 'codex', tool: 'list_agents', class: 'spawn', input: 'object' },
  { engine: 'codex', tool: 'send_input', class: 'spawn', input: 'object' },
  { engine: 'codex', tool: 'send_message', class: 'spawn', input: 'object' },
  { engine: 'codex', tool: 'spawn_agent', class: 'spawn', input: 'object' },
  { engine: 'codex', tool: 'wait_agent', class: 'spawn', input: 'object' },
  { engine: 'opencode', tool: 'bash', class: 'shell', input: 'object' },
  { engine: 'opencode', tool: 'edit', class: 'edit', input: 'object', fileKey: 'filePath' },
  { engine: 'opencode', tool: 'glob', class: 'search', input: 'object' },
  { engine: 'opencode', tool: 'grep', class: 'search', input: 'object' },
  { engine: 'opencode', tool: 'question', class: 'other', input: 'object' },
  { engine: 'opencode', tool: 'read', class: 'read', input: 'object', fileKey: 'filePath' },
  { engine: 'opencode', tool: 'skill', class: 'other', input: 'object' },
  { engine: 'opencode', tool: 'task', class: 'spawn', input: 'object' },
  { engine: 'opencode', tool: 'webfetch', class: 'other', input: 'object' },
  { engine: 'opencode', tool: 'write', class: 'write', input: 'object', fileKey: 'filePath' },
];

/**
 * The map key for one (engine, tool) pair.
 *
 * A STRUCTURAL key, not a separator-joined string. A separator has to be a
 * character neither half can contain, and this repository has already committed
 * a real NUL byte into source reaching for exactly that — invisible in a diff,
 * and it makes git treat the file as binary. `JSON.stringify` of a pair cannot
 * be ambiguous and cannot hold a control byte.
 */
const keyOf = (engine: string, tool: string): string => JSON.stringify([engine, tool]);

const BY_KEY = new Map<string, ToolClassRow>(
  TOOLCLASS_ROWS.map((r) => [keyOf(r.engine, r.tool), r]),
);

/**
 * The class of one engine's tool.
 *
 * Keyed by engine as well as name because the vocabularies overlap and a
 * name-only table would be a latent collision: CC's `Read` and OpenCode's
 * `read` differ only in case today, and nothing makes that permanent.
 */
export function classOf(engine: ToolEngine, tool: string): ToolClass {
  return BY_KEY.get(keyOf(engine, tool))?.class ?? 'other';
}

/** The input shape of one engine's tool; `'none'` when unmeasured. */
export function inputShapeOf(engine: ToolEngine, tool: string): ToolInputShape {
  return BY_KEY.get(keyOf(engine, tool))?.input ?? 'none';
}

/** The file-argument key for one engine's tool, when it has one. */
export function fileKeyOf(engine: ToolEngine, tool: string): string | undefined {
  return BY_KEY.get(keyOf(engine, tool))?.fileKey;
}

/**
 * The file this call touches, or `undefined`.
 *
 * Reads ONE named key off the structured input. No regex over any value, no
 * scan for path-shaped strings: Layer 1 reads structure, never text. A tool
 * whose class cannot touch a file, whose input is unstructured, or whose key
 * holds anything but a non-empty string, has no file path — and `Grep`/`glob`
 * are the recorded case, where `path` is a SCOPE to search rather than a file
 * touched, and the census gives them no key for that reason.
 */
export function filePathOf(engine: ToolEngine, tool: string, input: unknown): string | undefined {
  const row = BY_KEY.get(keyOf(engine, tool));
  if (row?.fileKey === undefined) return undefined;
  if (!FILE_CLASSES.has(row.class)) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[row.fileKey];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
