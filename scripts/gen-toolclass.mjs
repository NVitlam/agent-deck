// Generate `src/stats/toolclass.ts` from the Phase 0 tool-class census.
//
// v0.7.0 Phase 1, DoD 1.3. The census is
// `docs/evidence/phase-0-stats/TOOLCLASS.md`, produced by
// `lab/spike/stats/toolclass-census.mjs` over every committed corpus. DoD 0.3
// says in as many words: "This table, not memory, generates
// `src/stats/toolclass.ts` in Phase 1."
//
//   node scripts/gen-toolclass.mjs [--check]
//
// `--check` regenerates in memory and exits 1 on any difference, writing
// nothing. That is what the dev-only leg of `toolclass.test.ts` runs.
//
// ## THE SOURCE IS NOT REACHABLE FROM THE PUBLIC REPOSITORY, AND THAT SHAPED
// ## THIS SCRIPT
//
// `docs/` is a directory junction into the private `lab/` repository and is
// gitignored in the public one (`.gitignore:77`). So TOOLCLASS.md exists on a
// developer's machine and does NOT exist in a fresh public clone or on a CI
// runner. A test asserting "the table agrees with the census" would therefore
// pass on the machine that wrote it and be silently absent everywhere else —
// which is precisely the defect class this repository already shipped once,
// when CI ran a spike audit against a checkout that had no `spike/`.
//
// The generated file therefore carries the census ROWS it was built from, plus
// a digest over them. That makes the public repository self-sufficient: the
// committed table can be checked against its own stated source everywhere, and
// the digest goes red if anyone hand-edits the rows without regenerating. The
// dev-only leg then checks those rows still match TOOLCLASS.md itself.
//
// ## WHAT IS DELIBERATELY NOT CARRIED
//
// `lab/spike/stats/derive-facts.mjs` also classifies `NotebookEdit`, `patch`
// and `local_shell_call`. **None of them appears in any committed corpus**, so
// none is in the census, so none is generated here. That is G6 rather than an
// oversight: a class for a tool nobody has captured is memory, and an unknown
// tool already has a defined answer (`other`, no file argument). When one is
// captured the census gains a row and this script carries it across.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';

const CENSUS = 'docs/evidence/phase-0-stats/TOOLCLASS.md';
const OUT = 'src/stats/toolclass.ts';

/** Classes that can carry a file argument. Mirrors the census's own column. */
const FILE_CLASSES = new Set(['read', 'write', 'edit']);
const CLASSES = new Set(['read', 'write', 'edit', 'search', 'shell', 'spawn', 'other']);
const ENGINES = new Set(['cc', 'opencode', 'codex']);

/**
 * Parse the census's `## Tools` table.
 *
 * Columns: engine | tool | class | calls | input | file-arg key | evidence |
 * corpora. Only the first six are read; the last two are provenance for a human
 * and move with every harvest.
 */
function parseCensus(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '## Tools');
  if (start < 0) throw new Error(`${CENSUS}: no "## Tools" section`);

  const rows = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('## ')) break; // next section — the table is over
    if (!line.startsWith('|')) continue;

    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    if (cells[0] === 'engine' || /^-+$/.test(cells[0].replace(/[: ]/g, ''))) continue;

    const [engine, toolCell, klass, , inputCell, fileKeyCell] = cells;
    if (!ENGINES.has(engine)) continue;

    const tool = unbacktick(toolCell);
    if (tool === undefined) throw new Error(`${CENSUS}: unreadable tool cell ${toolCell}`);
    if (!CLASSES.has(klass)) throw new Error(`${CENSUS}: unknown class "${klass}" for ${tool}`);
    if (!['object', 'string', 'none'].includes(inputCell)) {
      throw new Error(`${CENSUS}: unknown input state "${inputCell}" for ${tool}`);
    }

    // The file-argument cell is either a backticked key or an em dash, and the
    // dash may carry a parenthetical reason (`scope path, not a touch`). Any
    // cell without a backticked key means "no file argument".
    const fileKey = unbacktick(fileKeyCell);

    if (fileKey !== undefined && !FILE_CLASSES.has(klass)) {
      throw new Error(`${CENSUS}: ${tool} is class ${klass} but states file key ${fileKey}`);
    }
    rows.push({ engine, tool, class: klass, input: inputCell, fileKey });
  }

  if (rows.length === 0) throw new Error(`${CENSUS}: parsed zero rows`);
  return rows.sort((a, b) => a.engine.localeCompare(b.engine) || a.tool.localeCompare(b.tool));
}

/** `` `x` `` -> `x`; anything else (an em dash, with or without a note) -> undefined. */
function unbacktick(cell) {
  const m = /^`([^`]+)`/.exec(cell);
  return m ? m[1] : undefined;
}

/**
 * Digest over the parsed rows — not over the markdown, whose prose moves.
 *
 * Each row is serialised STRUCTURALLY, with `JSON.stringify` of a fixed-order
 * array. Not a separator-joined string: a separator has to be a character no
 * field can contain, and reaching for one is how this repository has three
 * times put a real control byte into source — invisible in a diff, and it makes
 * git treat the file as binary. It is also genuinely ambiguous, because
 * concatenating fields lets two different rows produce one string.
 */
function digestOf(rows) {
  const canon = rows
    .map((r) => JSON.stringify([r.engine, r.tool, r.class, r.input, r.fileKey ?? null]))
    .join('\n');
  return createHash('sha256').update(canon, 'utf8').digest('hex');
}

function render(rows) {
  const digest = digestOf(rows);
  const byEngine = new Map();
  for (const r of rows) {
    if (!byEngine.has(r.engine)) byEngine.set(r.engine, []);
    byEngine.get(r.engine).push(r);
  }

  const counts = [...byEngine.entries()]
    .map(([e, rs]) => ` *   \`${e}\`: ${String(rs.length)} tools`)
    .join('\n');

  const rowLines = rows
    .map((r) => {
      const fileKey = r.fileKey === undefined ? '' : `, fileKey: '${r.fileKey}'`;
      return `  { engine: '${r.engine}', tool: '${r.tool}', class: '${r.class}', input: '${r.input}'${fileKey} },`;
    })
    .join('\n');

  return `/**
 * Tool classes and file-argument keys, GENERATED — do not hand-edit.
 *
 *     node scripts/gen-toolclass.mjs
 *
 * Source: \`${CENSUS}\` (Phase 0, DoD 0.3), a census over every committed
 * corpus. DoD 0.3 says the table, not memory, generates this file.
 *
${counts}
 *
 * ## The rows are here on purpose
 *
 * \`docs/\` is a junction into the private \`lab/\` repository and is gitignored
 * in the public one, so the census is NOT reachable from a fresh clone or from
 * CI. Carrying the rows makes this file checkable against its own source
 * everywhere, and {@link TOOLCLASS_DIGEST} goes red if they are edited without
 * regenerating. \`toolclass.test.ts\` checks the derivation here; its dev-only
 * leg checks these rows still match the census.
 *
 * ## Unknown tools
 *
 * \`classOf\` answers \`'other'\` and \`fileKeyOf\` answers \`undefined\` for any tool
 * not listed. That is the defined answer, not a fallback: a tool nobody has
 * captured has no measured class, and inventing one would be memory rather than
 * fixture (G6). \`NotebookEdit\`, \`patch\` and \`local_shell_call\` are absent for
 * exactly this reason — the Phase 0 spike guessed at them; no corpus has one.
 */

/** What a tool DOES, as measured. */
export type ToolClass = 'read' | 'write' | 'edit' | 'search' | 'shell' | 'spawn' | 'other';

/**
 * The shape of a tool's recorded input.
 *
 * Three states, not two, and the distinction is the census's. \`'string'\` is an
 * unstructured input that can carry no key at all — Codex's \`exec\` is a
 * \`custom_tool_call\` whose input is a string of JavaScript — which is a
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
export const TOOLCLASS_DIGEST = '${digest}';

/** Classes whose calls touch a named file. */
export const FILE_CLASSES: ReadonlySet<ToolClass> = new Set(['read', 'write', 'edit']);

/** Every row of the census, verbatim. */
export const TOOLCLASS_ROWS: readonly ToolClassRow[] = [
${rowLines}
];

/**
 * The map key for one (engine, tool) pair.
 *
 * A STRUCTURAL key, not a separator-joined string. A separator has to be a
 * character neither half can contain, and this repository has already committed
 * a real NUL byte into source reaching for exactly that — invisible in a diff,
 * and it makes git treat the file as binary. \`JSON.stringify\` of a pair cannot
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
 * name-only table would be a latent collision: CC's \`Read\` and OpenCode's
 * \`read\` differ only in case today, and nothing makes that permanent.
 */
export function classOf(engine: ToolEngine, tool: string): ToolClass {
  return BY_KEY.get(keyOf(engine, tool))?.class ?? 'other';
}

/** The input shape of one engine's tool; \`'none'\` when unmeasured. */
export function inputShapeOf(engine: ToolEngine, tool: string): ToolInputShape {
  return BY_KEY.get(keyOf(engine, tool))?.input ?? 'none';
}

/** The file-argument key for one engine's tool, when it has one. */
export function fileKeyOf(engine: ToolEngine, tool: string): string | undefined {
  return BY_KEY.get(keyOf(engine, tool))?.fileKey;
}

/**
 * The file this call touches, or \`undefined\`.
 *
 * Reads ONE named key off the structured input. No regex over any value, no
 * scan for path-shaped strings: Layer 1 reads structure, never text. A tool
 * whose class cannot touch a file, whose input is unstructured, or whose key
 * holds anything but a non-empty string, has no file path — and \`Grep\`/\`glob\`
 * are the recorded case, where \`path\` is a SCOPE to search rather than a file
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
`;
}

// ---------------------------------------------------------------------------

const check = argv.includes('--check');
let census;
try {
  census = readFileSync(CENSUS, 'utf8');
} catch {
  console.error(
    `gen-toolclass: cannot read ${CENSUS}.\n` +
      'It lives in the private lab repository and reaches the public checkout through a\n' +
      'directory junction. Run this on a developer machine with lab/ present.',
  );
  exit(2);
}

const rows = parseCensus(census);
const rendered = render(rows).replace(/\n/g, '\r\n');

if (check) {
  const current = readFileSync(OUT, 'utf8');
  if (current === rendered) {
    console.log(`gen-toolclass: OK, ${String(rows.length)} rows, digest ${digestOf(rows).slice(0, 12)}`);
    exit(0);
  }
  console.error(`gen-toolclass: ${OUT} DIFFERS from the census. Re-run without --check.`);
  exit(1);
}

writeFileSync(OUT, rendered);
console.log(
  `gen-toolclass: wrote ${OUT} — ${String(rows.length)} rows, digest ${digestOf(rows).slice(0, 12)}`,
);
