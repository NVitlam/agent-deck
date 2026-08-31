/**
 * PLAN v0.5.0 Phase 3 / DoD 3.4 — the OpenCode goldens.
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * DoD 3.4: "The expected `SessionState` tree for the harvested DB is generated
 * through a documented manual procedure this once (no parser exists yet) and
 * committed as `fixtures/opencode-<version>/golden.json`. Phase 4 must
 * reproduce it through the production path."
 *
 * A golden is only worth something if three things are true, and each has a
 * suite below:
 *
 *   1. the committed file IS what the documented procedure produces today
 *      (otherwise it pins whatever an editor believed);
 *   2. the procedure is INDEPENDENT of the code it will one day check — this
 *      generator imports nothing from `src/`, because if Phase 4's engine and
 *      the golden agree only by sharing code the golden proves nothing;
 *   3. the golden is REPRODUCIBLE off the machine that made it — no absolute
 *      paths, no wall-clock values, previews by digest. Those are the three
 *      rules `fixtures/golden/session/README.md` already states for the CC
 *      goldens, applied to the second engine.
 *
 * G4 IS NOT VACUOUS HERE, AND THAT IS THE POINT
 * ---------------------------------------------
 * In Claude Code the thinking text is EMPTY on disk and the bytes sit in
 * `signature`, so a test asserting only that thinking text does not leak passes
 * forever while proving nothing — a trap this repository actually fell into. In
 * OpenCode the bytes are plainly present in `part.data.text` (contract §4, spec
 * OC6): the anchor carries 167 reasoning parts, the longest 36,716 characters.
 * The G4 suite below reads those bytes off the fixture and searches the golden
 * for them. If redaction were removed the test would fail with real evidence.
 *
 * A COLLECTION FAILURE LOOKS LIKE A PASS
 * --------------------------------------
 * This file imports a `.mjs` script. If that import throws, vitest's summary
 * reads "N skipped", which at a glance is not distinguishable from green — how
 * a shebang on line 1 of `scripts/privacy-sweep.mjs` once reached a merged
 * commit with a green report attached. The import is CAUGHT, not thrown, and
 * suite 0 depends on nothing so it still runs and still fails when that breaks.
 * Suite 0 reads the script's first two bytes with `fs`, deliberately not
 * through the import, because a guard against an import failure must not itself
 * import the broken module.
 *
 * NO SIZES ARE PINNED
 * -------------------
 * Standing repo law: a fixture-set count hard-coded against this capture breaks
 * on the next harvest and reads as a regression. Every count asserted below is
 * derived from the corpus database in this process and compared against what
 * the generator recorded. The literal numbers live in
 * `fixtures/opencode-1.18.22/GOLDEN.md`, which is regenerated alongside them.
 *
 * NOTHING IS WRITTEN. The suite opens each corpus `{ readOnly: true }` and
 * generates golden text in memory; the on-disk `golden.json` is only read. The
 * database's SHA-256 is compared before and after, so "read-only" is measured
 * rather than intended (G1).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_MAX_PAYLOAD_BYTES, truncationMarker } from '../parser/redact.js';

/* ------------------------------------------------------------------ *
 * The slice of the generator's exports this suite relies on.
 * Deliberately partial: it names only what is asserted.
 * ------------------------------------------------------------------ */
interface GoldenModule {
  PREVIEW_BYTES: number;
  truncationMarker: (keptBytes: number, originalBytes: number) => string;
  truncateOnce: (
    text: string,
    maxBytes?: number,
  ) => { text: string; truncated: boolean; keptBytes: number; originalBytes: number };
  previewFingerprint: (text: string | undefined) => string | null;
  canonicalJson: (value: unknown) => string;
  stripDroppedFields: (value: unknown) => unknown;
  listCorpora: (fixturesDir?: string) => string[];
  generate: (corpusName: string, fixturesDir?: string) => string;
  goldenPath: (corpusName: string, fixturesDir?: string) => string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'opencode-golden.mjs');
const FIXTURES = path.join(REPO_ROOT, 'fixtures');
const ANCHOR = 'opencode-1.18.22';
const GOLDEN_MD = path.join(FIXTURES, ANCHOR, 'GOLDEN.md');

/**
 * THE CORPUS NAMES ARE RESOLVED AT COLLECTION TIME, ON PURPOSE.
 *
 * `describe.each(...)` is evaluated while vitest is COLLECTING, before any
 * `beforeAll` has run. A list populated in `beforeAll` is still empty at that
 * moment, so every `.each` over it generates ZERO tests — and a file that
 * generates zero tests reports as a clean pass.
 */
const CORPUS_NAMES: string[] = fs.existsSync(FIXTURES)
  ? fs
      .readdirSync(FIXTURES, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('opencode-'))
      .filter((d) => fs.existsSync(path.join(FIXTURES, d.name, 'opencode.db')))
      .map((d) => d.name)
      .sort()
  : [];

let mod: GoldenModule | null = null;
let loadError: unknown = null;

/* ------------------------------------------------------------------ *
 * Shapes. These MIRROR `src/model/events.ts`, they do not import it as
 * a value: the golden is JSON on disk and has to be validated as JSON.
 *
 * `engine` and the `taskWithoutChild` park code are spec'd (OC7, OC3)
 * and Phase 4 has since added both to `src/model/events.ts`. The shapes
 * below stay LOCAL anyway, for the reason above rather than for the one
 * that first put them here: this suite validates JSON read off disk, and
 * validating it against the very interface the engine is written to
 * would let a widening of that interface silently widen the golden's
 * acceptance too. See the DEVIATIONS list in
 * `fixtures/opencode-1.18.22/GOLDEN.md`.
 * ------------------------------------------------------------------ */
interface GoldenToolNode {
  node: 'tool';
  id: string;
  toolName: string;
  status: 'running' | 'done' | 'error';
  inputPreview: string | null;
  resultPreview: string | null;
  durationMs: number | null;
}

/**
 * A token pair as the goldens serialise one: `null`, never absent.
 *
 * `null` and a pair are two different facts and both occur. The OpenCode
 * generator omits `contextNow`/`burn` because `session.tokens_input` counts
 * only UNCACHED input and would under-report a cached prompt by roughly 7x; an
 * omitted key serialises to `null`, and `null` renders as an em-dash — "we do
 * not have this number" — where `0` would be a claim that nothing was spent.
 */
type GoldenTokenPair = { prompt: number; output: number } | null;

interface GoldenAgentNode {
  node: 'agent';
  id: string;
  kind: 'main' | 'subagent';
  label: string;
  status: 'running' | 'done' | 'error';
  spawnDepth: number;
  /**
   * CORRECTED 2026-08-28. This read `tokens: { in: number; out: number }`, a
   * field `src/model/events.ts` no longer has: `AgentNode.tokens` was REMOVED
   * rather than renamed, so every reader would break at compile time, and
   * `contextNow` (a level) and `burn` (a total) replaced it.
   *
   * This annotation did not break, because it is an unchecked assertion on
   * `JSON.parse` and nothing in this file ever read `tokens`. A wrong type that
   * describes the file it validates, on a value no assertion touches, is the
   * quietest form of the "the document describes the old state" defect.
   */
  contextNow: GoldenTokenPair;
  burn: GoldenTokenPair;
  startedAtOffsetMs: number;
  endedAtOffsetMs: number | null;
  children: (GoldenAgentNode | GoldenToolNode)[];
}

interface GoldenSession {
  sessionId: string;
  projectSlug: string;
  engine: 'cc' | 'opencode';
  workspaceMatch: boolean;
  liveness: 'live' | 'idle' | 'ended' | 'unsupported';
  schemaOk: boolean;
  epochAnchor: string;
  /**
   * CORRECTED 2026-08-28, for the same reason as `contextNow` above. This read
   * `{ inputTokens, outputTokens, costUsd }`; every committed golden carries
   * `{"costUsd": 0}` and nothing else, with the session's own token pair beside
   * `totals` rather than inside it. `fixtures/opencode-1.18.22/GOLDEN.md`
   * carries the dated amendment and the measured counts.
   */
  totals: { costUsd: number };
  contextNow: GoldenTokenPair;
  burn: GoldenTokenPair;
  spawnEdges: {
    toolUseId: string;
    agentId: string;
    parentNodeId: string;
    depth: number;
    recordedDepth: number;
  }[];
  parked: { agentId: string; code: string; toolUseId?: string; reason: string }[];
  root: GoldenAgentNode;
}

/**
 * The generator's own tally, named field by field rather than as a
 * `Record<string, number>`.
 *
 * Deliberate: with `noUncheckedIndexedAccess` an index signature makes every
 * counter `number | undefined`, and `expect(undefined).toBe(undefined)` is a
 * green assertion that measured nothing. Naming them means a counter the
 * generator renames or drops fails a comparison against a real number, and
 * `COUNT_KEYS` below asserts the two sides still hold the same set.
 */
interface GoldenCounts {
  sessionRows: number;
  rootSessions: number;
  childSessions: number;
  partRows: number;
  partsMalformed: number;
  reasoningPartsDropped: number;
  partsIgnoredNoNode: number;
  toolParts: number;
  taskParts: number;
  taskPartsJoined: number;
  taskPartsParked: number;
  previewsTruncated: number;
}

const COUNT_KEYS: readonly (keyof GoldenCounts)[] = [
  'sessionRows',
  'rootSessions',
  'childSessions',
  'partRows',
  'partsMalformed',
  'reasoningPartsDropped',
  'partsIgnoredNoNode',
  'toolParts',
  'taskParts',
  'taskPartsJoined',
  'taskPartsParked',
  'previewsTruncated',
];

interface GoldenFile {
  schema: string;
  generator: string;
  generatedFrom: string;
  dataVersion: string;
  engine: 'opencode';
  previewBytes: number;
  counts: GoldenCounts;
  sessions: GoldenSession[];
}

/** What the corpus database itself says, read independently of the generator. */
interface Measured {
  dbSha: string;
  sessionRows: { id: string; parentId: string | null; version: string }[];
  rootIds: string[];
  reasoningHeads: string[];
  reasoningRows: number;
  toolRows: number;
  taskRowsTotal: number;
  taskRowsWithoutChild: number;
  taskJoins: { callId: string; partSession: string; childId: string; agrees: boolean }[];
  oversizePayloads: number;
  partIds: Set<string>;
}

interface Loaded {
  name: string;
  fileText: string;
  regenerated: string;
  golden: GoldenFile;
  measured: Measured;
}

const loaded = new Map<string, Loaded>();

function need(name: string): Loaded {
  const l = loaded.get(name);
  if (l === undefined) throw new Error(`corpus ${name} was not loaded in beforeAll`);
  return l;
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Every node in a tree, depth-first. */
function walk(node: GoldenAgentNode | GoldenToolNode): (GoldenAgentNode | GoldenToolNode)[] {
  if (node.node === 'tool') return [node];
  return [node, ...node.children.flatMap(walk)];
}

/**
 * Read the corpus with our own queries, so the assertions below compare the
 * golden against the DATABASE rather than against the generator's own summary
 * of it.
 *
 * SQLite `LIKE` is CASE-INSENSITIVE and is not used: nothing here matches
 * strings in SQL. Integers are irrelevant to these queries and are left alone.
 */
function measure(dbPath: string): Measured {
  const dbSha = sha256File(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sessionRows = (
      db.prepare('SELECT id, parent_id, version FROM session ORDER BY time_created, id').all() as
        unknown as { id: string; parent_id: string | null; version: string }[]
    ).map((r) => ({ id: r.id, parentId: r.parent_id, version: r.version }));
    const parentOf = new Map(sessionRows.map((s) => [s.id, s.parentId]));

    const parts = db
      .prepare('SELECT id, session_id, data FROM part ORDER BY time_created, id')
      .all() as unknown as { id: string; session_id: string; data: string }[];

    const reasoningHeads: string[] = [];
    const taskJoins: Measured['taskJoins'] = [];
    const partIds = new Set<string>();
    let reasoningRows = 0;
    let toolRows = 0;
    let taskRowsTotal = 0;
    let taskRowsWithoutChild = 0;
    let oversizePayloads = 0;

    for (const row of parts) {
      partIds.add(row.id);
      const data = JSON.parse(row.data) as {
        type?: string;
        tool?: string;
        callID?: string;
        text?: string;
        state?: {
          status?: string;
          output?: unknown;
          error?: unknown;
          metadata?: { sessionId?: unknown; parentSessionId?: unknown };
        };
      };
      if (data.type === 'reasoning') {
        reasoningRows++;
        const text = typeof data.text === 'string' ? data.text : '';
        // The first 64 BYTES, as OC6 specifies. Empty texts are skipped: a
        // zero-length needle is in every string and would make the search a
        // guaranteed failure that says nothing.
        const head = Buffer.from(text, 'utf8').subarray(0, 64).toString('utf8');
        if (head.length > 0) reasoningHeads.push(head);
        continue;
      }
      if (data.type !== 'tool') continue;
      toolRows++;
      const payload =
        typeof data.state?.output === 'string'
          ? data.state.output
          : typeof data.state?.error === 'string'
            ? data.state.error
            : '';
      if (Buffer.byteLength(payload, 'utf8') > DEFAULT_MAX_PAYLOAD_BYTES) oversizePayloads++;
      if (data.tool !== 'task') continue;
      taskRowsTotal++;
      const childId = data.state?.metadata?.sessionId;
      if (typeof childId !== 'string' || childId === '') {
        taskRowsWithoutChild++;
        continue;
      }
      taskJoins.push({
        callId: String(data.callID),
        partSession: row.session_id,
        childId,
        agrees:
          parentOf.get(childId) === row.session_id &&
          data.state?.metadata?.parentSessionId === row.session_id,
      });
    }

    return {
      dbSha,
      sessionRows,
      rootIds: sessionRows.filter((s) => s.parentId === null).map((s) => s.id),
      reasoningHeads,
      reasoningRows,
      toolRows,
      taskRowsTotal,
      taskRowsWithoutChild,
      taskJoins,
      oversizePayloads,
      partIds,
    };
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  try {
    mod = (await import(/* @vite-ignore */ pathToFileURL(SCRIPT).href)) as GoldenModule;
  } catch (error) {
    loadError = error;
    return;
  }
  for (const name of CORPUS_NAMES) {
    const dbPath = path.join(FIXTURES, name, 'opencode.db');
    const before = sha256File(dbPath);
    const regenerated = mod.generate(name, FIXTURES);
    const after = sha256File(dbPath);
    if (before !== after) throw new Error(`${name}: generating the golden CHANGED opencode.db`);
    const goldenFile = mod.goldenPath(name, FIXTURES);
    const fileText = fs.existsSync(goldenFile)
      ? fs.readFileSync(goldenFile, 'utf8')
      : '';
    loaded.set(name, {
      name,
      fileText,
      regenerated,
      golden: JSON.parse(regenerated) as GoldenFile,
      measured: measure(dbPath),
    });
  }
}, 120_000);

/* ================================================================== *
 * 0. The suite can run at all
 * ================================================================== */
describe('0 · the generator is loadable', () => {
  it('has no shebang — a `#!` breaks vitest collection in a CRLF checkout only', () => {
    // Read as BYTES, not through the import: a guard against an import failure
    // must not itself import the broken module.
    const head = fs.readFileSync(SCRIPT).subarray(0, 2).toString('latin1');
    expect(head).not.toBe('#!');
  });

  it('imports without throwing', () => {
    expect(loadError, `importing ${SCRIPT} threw: ${String(loadError)}`).toBeNull();
    expect(mod).not.toBeNull();
  });

  it('finds at least one corpus', () => {
    expect(CORPUS_NAMES.length).toBeGreaterThan(0);
  });

  it('lists the same corpora the generator does', () => {
    expect(mod?.listCorpora(FIXTURES)).toEqual(CORPUS_NAMES);
  });
});

/* ================================================================== *
 * 1. Independence — the rule that makes this a golden, not a tautology
 * ================================================================== */
describe('1 · the generator is independent of the code it will check', () => {
  const source = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, 'utf8') : '';

  it('imports nothing from src/', () => {
    const imports = [...source.matchAll(/^\s*import[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec, `generator must not import ${spec}`).not.toMatch(/(^|\/)src\//);
      expect(spec).not.toMatch(/opencode\//);
    }
  });

  it('imports only node: builtins', () => {
    const imports = [...source.matchAll(/^\s*import[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    for (const spec of imports) expect(spec).toMatch(/^node:/);
  });

  it('opens the corpus read-only (G1)', () => {
    expect(source).toContain('readOnly: true');
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|CREATE)\b/);
  });

  it('never uses SQL LIKE — it is case-insensitive and has already cost one wrong count', () => {
    // The check is on the SQL, not on the prose: this file and the generator
    // both DISCUSS `LIKE` in comments, and a bare word search would fail on the
    // documentation of the very rule it is enforcing. Single-quoted literals
    // that do not span a line are exactly where the generator's SQL lives.
    const literals = source.match(/'[^'\n]*'/g) ?? [];
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(literal, `SQL literal uses LIKE: ${literal}`).not.toMatch(/\bLIKE\b/);
    }
  });

  it('reads integers as BigInt so no millisecond timestamp passes through a float', () => {
    expect(source).toContain('setReadBigInts(true)');
  });
});

/* ================================================================== *
 * 2. The truncation contract is redact.ts's, not a second policy (OC6)
 * ================================================================== */
describe('2 · truncation matches src/parser/redact.ts', () => {
  it('uses the same ceiling', () => {
    expect(mod?.PREVIEW_BYTES).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
  });

  it('emits a byte-identical marker', () => {
    expect(mod?.truncationMarker(8192, 88478)).toBe(truncationMarker(8192, 88478));
    expect(mod?.truncationMarker(0, 1)).toBe(truncationMarker(0, 1));
  });

  it('cuts ONCE — a marker states the real original size, never an intermediate one', () => {
    const big = 'x'.repeat(DEFAULT_MAX_PAYLOAD_BYTES * 4);
    const once = mod!.truncateOnce(big);
    expect(once.truncated).toBe(true);
    expect(once.keptBytes).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
    expect(once.text.endsWith(truncationMarker(DEFAULT_MAX_PAYLOAD_BYTES, big.length))).toBe(true);
    // Re-cutting the already-marked string is what under-reported by 7.73x on
    // the committed CC capture. The generator must never do it, so the marked
    // string's own original count must still be the TRUE original.
    expect(once.text).toContain(`of ${big.length} bytes`);
  });

  it('never splits a multi-byte code point', () => {
    // A 3-byte character repeated so the ceiling lands mid-sequence.
    const text = '中'.repeat(DEFAULT_MAX_PAYLOAD_BYTES);
    const cut = mod!.truncateOnce(text);
    const kept = cut.text.slice(0, cut.text.length - truncationMarker(cut.keptBytes, cut.originalBytes).length);
    expect(Buffer.byteLength(kept, 'utf8')).toBe(cut.keptBytes);
    expect(kept).not.toContain('�');
  });
});

/* ================================================================== *
 * 3-8. Per corpus
 * ================================================================== */
describe.each(CORPUS_NAMES)('%s', (name) => {
  describe('3 · the committed golden is what the procedure produces', () => {
    it('exists', () => {
      expect(fs.existsSync(path.join(FIXTURES, name, 'golden.json'))).toBe(true);
    });

    it('is byte-identical to a fresh generation', () => {
      const l = need(name);
      expect(l.fileText).toBe(l.regenerated);
    });

    it('is deterministic — two generations agree', () => {
      expect(mod!.generate(name, FIXTURES)).toBe(need(name).regenerated);
    });

    it('generating it does not write the corpus database (G1)', () => {
      const l = need(name);
      expect(sha256File(path.join(FIXTURES, name, 'opencode.db'))).toBe(l.measured.dbSha);
    });

    it('is canonical JSON: 2-space indent, LF only, one trailing newline', () => {
      const l = need(name);
      expect(l.fileText).not.toContain('\r');
      expect(l.fileText.endsWith('\n')).toBe(true);
      expect(l.fileText.endsWith('\n\n')).toBe(false);
      // Key order is fixed by the serializer, so a diff between two goldens is
      // a real difference and never a reordering.
      expect(`${JSON.stringify(JSON.parse(l.fileText), null, 2)}\n`).toBe(l.fileText);
    });

    it('names the corpus it came from and the data version the rows carry (OC5)', () => {
      const l = need(name);
      expect(l.golden.generatedFrom).toBe(`fixtures/${name}/opencode.db`);
      expect(l.golden.dataVersion).toBe(name.slice('opencode-'.length));
      for (const s of l.measured.sessionRows) expect(s.version).toBe(l.golden.dataVersion);
    });
  });

  describe('4 · G4 — no reasoning bytes reach the golden (OC6)', () => {
    it('the corpus actually carries reasoning bytes, so the search is not vacuous', () => {
      const l = need(name);
      expect(l.measured.reasoningRows).toBeGreaterThan(0);
      expect(l.measured.reasoningHeads.length).toBeGreaterThan(0);
      // OpenCode is the INVERSE of the CC trap: the bytes are in `text`, not in
      // an empty field beside a populated `signature`. Prove the needles are
      // real content, not empty strings.
      for (const head of l.measured.reasoningHeads) expect(head.length).toBeGreaterThan(0);
    });

    it('the first 64 bytes of every reasoning part occur ZERO times in the golden', () => {
      const l = need(name);
      const offenders = l.measured.reasoningHeads.filter((h) => l.regenerated.includes(h));
      expect(offenders.slice(0, 3)).toEqual([]);
    });

    it('every reasoning part was dropped at the parse boundary, counted', () => {
      const l = need(name);
      expect(l.golden.counts.reasoningPartsDropped).toBe(l.measured.reasoningRows);
    });

    it('drops signature and thinking fields by policy, not by observation', () => {
      const stripped = mod!.stripDroppedFields({
        keep: 1,
        signature: 'secret',
        nested: [{ thinking: 'x', redacted_thinking: 'y', ok: 2 }],
      });
      expect(stripped).toEqual({ keep: 1, nested: [{ ok: 2 }] });
    });
  });

  describe('5 · the golden reproduces off the capturing machine', () => {
    it('carries no absolute path, drive letter, or home directory', () => {
      const l = need(name);
      // `generatedFrom` is a repo-relative path and is the only `/` allowed to
      // look path-like; a drive letter or a home directory is not.
      //
      // THESE ARE NOW THE CC GOLDENS' FOUR CHECKS, EXACTLY — `[A-Za-z]:[\\/]`,
      // `/Users/`, `.claude`, `\\`. They used to be six: this file also
      // forbade the bare words `Users` and `projects`, which was affordable
      // only while `projectSlug` was the empty placeholder.
      //
      // `PLAN.md` Phase 4 Amendment A1 fills it with the CC slug
      // `c--Users-dev-projects-…`, and that slug contains both words. The
      // narrower rule is the CORRECT one and always was: it is the one
      // `fixtures/golden/session/README.md` rule 1 states and the one
      // `src/model/session.test.ts` enforces on the CC goldens, which have
      // carried this exact string since Phase 2. Rule 1 forbids a filesystem
      // PATH; a slug is not a path — `:`, `\` and `/` have all been collapsed
      // out of it, which is why the drive-letter and separator checks still
      // bite while the bare words cannot.
      //
      // What this costs, stated rather than glossed: the golden now contains a
      // username. That is not new exposure — the identical string is already in
      // `fixtures/golden/session/*.json`, and `scripts/privacy-sweep.mjs`
      // classifies this developer's own paths as deliberate fixture content
      // rather than as a leak. What the sweep gates on is FOREIGN content and
      // secrets, and neither counter moves.
      expect(l.fileText).not.toMatch(/[A-Za-z]:[\\/]/);
      expect(l.fileText).not.toContain('\\\\');
      expect(l.fileText).not.toContain('/Users/');
      expect(l.fileText.toLowerCase()).not.toContain('.claude');
      expect(l.fileText).not.toContain('/home/');
    });

    it('holds exactly one ISO-8601 timestamp per session, and no other wall clock', () => {
      const l = need(name);
      const stamps = l.fileText.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g) ?? [];
      expect(stamps.length).toBe(l.golden.sessions.length);
      for (const s of l.golden.sessions) expect(s.epochAnchor).toMatch(/Z$/);
    });

    it('anchors every node time as an offset, with the root at 0', () => {
      for (const s of need(name).golden.sessions) {
        expect(s.root.startedAtOffsetMs).toBe(0);
        for (const node of walk(s.root)) {
          if (node.node !== 'agent') continue;
          expect(Number.isFinite(node.startedAtOffsetMs)).toBe(true);
          if (node.endedAtOffsetMs !== null) expect(Number.isFinite(node.endedAtOffsetMs)).toBe(true);
        }
      }
    });

    it('pins every preview by digest, never verbatim', () => {
      for (const s of need(name).golden.sessions) {
        for (const node of walk(s.root)) {
          if (node.node !== 'tool') continue;
          expect(node.inputPreview).toMatch(/^sha256:[0-9a-f]{16}:\d+$/);
          if (node.resultPreview !== null) {
            expect(node.resultPreview).toMatch(/^sha256:[0-9a-f]{16}:\d+$/);
          }
        }
      }
    });

    it('holds every preview at or just above the redact.ts ceiling', () => {
      const l = need(name);
      let truncated = 0;
      for (const s of l.golden.sessions) {
        for (const node of walk(s.root)) {
          if (node.node !== 'tool') continue;
          for (const preview of [node.inputPreview, node.resultPreview]) {
            if (preview === null) continue;
            const bytes = Number(preview.split(':')[2]);
            if (bytes <= DEFAULT_MAX_PAYLOAD_BYTES) continue;
            truncated++;
            // Over the ceiling means the marker was appended; the excess is the
            // marker's own length and nothing else.
            const excess = bytes - DEFAULT_MAX_PAYLOAD_BYTES;
            expect(excess).toBeGreaterThan(truncationMarker(0, 0).length - 1);
            expect(excess).toBeLessThan(truncationMarker(0, 0).length + 40);
          }
        }
      }
      // Derived from the corpus, not hard-coded: if the database holds a
      // payload over the ceiling the golden must show a truncated preview, and
      // if it holds none it must show none.
      expect(truncated > 0).toBe(l.measured.oversizePayloads > 0);
      expect(l.golden.counts.previewsTruncated).toBe(truncated);
    });
  });

  describe('6 · the tree accounts for every session row', () => {
    it('emits one SessionState per root session', () => {
      const l = need(name);
      expect(l.golden.sessions.map((s) => s.sessionId).sort()).toEqual(
        [...l.measured.rootIds].sort(),
      );
      expect(l.golden.counts.sessionRows).toBe(l.measured.sessionRows.length);
      expect(l.golden.counts.rootSessions).toBe(l.measured.rootIds.length);
    });

    it('reaches every session row: a root, or a subagent node under one', () => {
      const l = need(name);
      const reached = new Set<string>();
      for (const s of l.golden.sessions) {
        reached.add(s.sessionId);
        for (const node of walk(s.root)) {
          if (node.node === 'agent' && node.kind === 'subagent') reached.add(node.id);
        }
        for (const p of s.parked) reached.add(p.agentId);
      }
      const missing = l.measured.sessionRows.map((r) => r.id).filter((id) => !reached.has(id));
      expect(missing).toEqual([]);
    });

    it('carries the token shape the local interfaces declare, and no other', () => {
      // WHY THIS EXISTS. `GoldenSession.totals` and `GoldenAgentNode`'s token
      // fields were WRONG — `{inputTokens, outputTokens, costUsd}` and
      // `tokens: {in, out}`, both from a mapping Phase 7 deleted — and nothing
      // failed, because the interfaces are an unchecked annotation on
      // `JSON.parse` and no assertion in this file ever read either field. A
      // type that is never exercised is a comment with a colon in it.
      //
      // This reads them, by KEY SET rather than by presence, so the annotation
      // above and the bytes on disk cannot drift apart again in either
      // direction: a key added to the golden fails, and a key the golden stops
      // emitting fails too.
      const l = need(name);
      for (const s of l.golden.sessions) {
        expect({ id: s.sessionId, keys: Object.keys(s.totals).sort() }).toStrictEqual({
          id: s.sessionId,
          keys: ['costUsd'],
        });
        expect(typeof s.totals.costUsd).toBe('number');
        /*
         * `contextNow` stays `null` — not absent and not `0`. An omitted key
         * serialises to `null`, which renders as an em-dash; a `0` would be a
         * fabricated claim that the window is empty. It cannot be filled from
         * the `session` row because a context window is a LEVEL, and the
         * per-step reader that would give it is 0.5.1's.
         *
         * **`burn` stopped being `null` on 2026-08-31.** The old comment here
         * said the generator omits it "because `session.tokens_input` counts
         * only uncached input" — true of that column alone, and it stopped
         * being the whole story: `tokens_input + tokens_cache_read +
         * tokens_cache_write` IS the whole prompt, verified against the
         * `step-finish` rows on every session in both corpora.
         */
        expect({ id: s.sessionId, contextNow: s.contextNow }).toStrictEqual({
          id: s.sessionId,
          contextNow: null,
        });
        expect(s.burn, `${s.sessionId} burn`).not.toBeNull();
        expect(Object.keys(s.burn ?? {}).sort()).toStrictEqual(['output', 'prompt']);
        expect(s.burn?.prompt, `${s.sessionId} burn.prompt`).toBeGreaterThan(0);
      }

      const agents = l.golden.sessions
        .flatMap((s) => walk(s.root))
        .filter((n): n is GoldenAgentNode => n.node === 'agent');
      expect(agents.length).toBeGreaterThan(0);
      for (const a of agents) {
        // Same split as the session level above: `contextNow` absent, `burn`
        // present. A node's `burn` is that agent's OWN figure, not its
        // subtree's — the subtree sum is the session-level one.
        expect({ id: a.id, contextNow: a.contextNow }).toStrictEqual({
          id: a.id,
          contextNow: null,
        });
        expect(a.burn, `${a.id} burn`).not.toBeNull();
        expect(Object.keys(a.burn ?? {}).sort()).toStrictEqual(['output', 'prompt']);
        // The removed field is REMOVED, not renamed and not left beside its
        // replacement. `AgentNode.tokens` was deleted from
        // `src/model/events.ts` precisely so every reader breaks; a golden
        // still emitting it would mean the generator had not followed.
        expect({ id: a.id, hasTokens: 'tokens' in a }).toStrictEqual({
          id: a.id,
          hasTokens: false,
        });
      }
    });

    it('tags every session with the engine that observed it (OC7)', () => {
      const l = need(name);
      expect(l.golden.engine).toBe('opencode');
      for (const s of l.golden.sessions) expect(s.engine).toBe('opencode');
    });

    it('carries the CC slug for project.worktree as projectSlug (Amendment A1)', () => {
      // SUPERSEDES the assertion that stood here, which pinned `''` and cited
      // OC7's "not decided by this amendment ... Open item, for Phase 5".
      // `PLAN.md` Phase 4 `Amendment 2026-08-27 — projectSlug, liveness proof,
      // coverage law` item A1 closed it in Phase 4 instead: `projectSlug` means
      // "the project key" for both engines, and the OpenCode value is the slug
      // derived from `project.worktree` by CC's own directory-naming rule.
      //
      // Both sides are read OFF DISK here and neither is a literal in this
      // file, which is what makes this a pin rather than a restatement: the
      // left is what the generator produced from the corpus's `worktree`
      // column, the right is the name of the one slug directory CC itself
      // wrote under `fixtures/cc-2.1.246/projects/`.
      const projectRoot = path.join(FIXTURES, 'cc-2.1.246', 'projects');
      const ccSlugs = fs
        .readdirSync(projectRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      expect(ccSlugs).toHaveLength(1);
      const [ccSlug] = ccSlugs;
      const sessions = need(name).golden.sessions;
      expect(sessions.length).toBeGreaterThan(0);
      for (const s of sessions) expect(s.projectSlug).toBe(ccSlug);
    });

    it('carries the SAME projectSlug the CC goldens carry for this workspace', () => {
      // The whole content of A1 is that one workspace observed by two engines
      // gets ONE key. Asserting the OpenCode value against the CC directory
      // name alone would leave that unstated; this compares it against what the
      // CC engine's own committed goldens hold, which is the value a deck
      // grouping sessions by project would actually compare.
      const ccGoldenDir = path.join(FIXTURES, 'golden', 'session');
      const ccSlugs = new Set(
        fs
          .readdirSync(ccGoldenDir)
          .filter((n) => n.endsWith('.json'))
          .map(
            (n) =>
              (JSON.parse(fs.readFileSync(path.join(ccGoldenDir, n), 'utf8')) as {
                projectSlug: string;
              }).projectSlug,
          ),
      );
      expect(ccSlugs.size).toBe(1);
      for (const s of need(name).golden.sessions) {
        expect(ccSlugs.has(s.projectSlug)).toBe(true);
      }
    });

    it('never nests a subagent inside the ToolNode that spawned it', () => {
      // `ToolNode` has no `children` field and that stays true; the real spawn
      // relationship lives in `spawnEdges` alone (src/model/events.ts).
      for (const s of need(name).golden.sessions) {
        for (const node of walk(s.root)) {
          if (node.node !== 'tool') continue;
          expect(Object.keys(node)).not.toContain('children');
        }
      }
    });

    it('records liveness the data can support — never `live` from a static file', () => {
      // OC4's tap is a cursor over `event`. A committed fixture is a file: no
      // seq can advance while it is read, so no session here can be `live`.
      for (const s of need(name).golden.sessions) {
        expect(['idle', 'ended', 'unsupported']).toContain(s.liveness);
      }
    });
  });

  describe('7 · the subagent join (OC3, contract §5)', () => {
    it('emits one spawn edge per agreeing task pair, and no others', () => {
      const l = need(name);
      const edges = l.golden.sessions.flatMap((s) => s.spawnEdges);
      const agreeing = l.measured.taskJoins.filter((j) => j.agrees);
      expect(edges.length).toBe(agreeing.length);
      expect(edges.map((e) => e.toolUseId).sort()).toEqual(agreeing.map((j) => j.callId).sort());
      expect(edges.map((e) => e.agentId).sort()).toEqual(agreeing.map((j) => j.childId).sort());
      expect(l.golden.counts.taskPartsJoined).toBe(agreeing.length);
    });

    it('every spawn edge names a subagent node that is in the tree', () => {
      for (const s of need(name).golden.sessions) {
        const ids = new Set(
          walk(s.root)
            .filter((n): n is GoldenAgentNode => n.node === 'agent')
            .map((n) => n.id),
        );
        const toolIds = new Set(walk(s.root).filter((n) => n.node === 'tool').map((n) => n.id));
        for (const edge of s.spawnEdges) {
          expect(ids.has(edge.agentId), `edge agent ${edge.agentId}`).toBe(true);
          expect(toolIds.has(edge.toolUseId), `edge tool ${edge.toolUseId}`).toBe(true);
          expect(ids.has(edge.parentNodeId), `edge parent ${edge.parentNodeId}`).toBe(true);
        }
      }
    });

    it('parks every task part with no child session id, and guesses nothing (§G)', () => {
      const l = need(name);
      const parked = l.golden.sessions.flatMap((s) => s.parked);
      const without = parked.filter((p) => p.code === 'taskWithoutChild');
      expect(without.length).toBe(l.measured.taskRowsWithoutChild);
      expect(l.golden.counts.taskPartsParked).toBe(l.measured.taskRowsWithoutChild);
      for (const p of without) {
        // A parked entry names the tool call it could not resolve. It does NOT
        // name a child session, because there is none — the whole point.
        expect(p.toolUseId).toBeTruthy();
        expect(p.reason).toBeTruthy();
      }
    });

    it('a parked entry is absent from the tree — refusal is visible, not silent', () => {
      for (const s of need(name).golden.sessions) {
        const nodeIds = new Set(walk(s.root).map((n) => n.id));
        for (const p of s.parked) {
          expect(nodeIds.has(p.agentId), `parked ${p.agentId} is in the tree`).toBe(false);
        }
      }
    });

    it('uses a stable enumerated code for every park', () => {
      const codes = new Set([
        'taskWithoutChild',
        'joinKeyContradiction',
        'ambiguousJoinKey',
        'noSpawningTaskPart',
      ]);
      for (const s of need(name).golden.sessions) {
        for (const p of s.parked) expect(codes.has(p.code), `code ${p.code}`).toBe(true);
      }
    });

    it('walks depth from parent_id rather than assuming a cap', () => {
      const l = need(name);
      const parentOf = new Map(l.measured.sessionRows.map((s) => [s.id, s.parentId]));
      for (const s of l.golden.sessions) {
        for (const node of walk(s.root)) {
          if (node.node !== 'agent' || node.kind !== 'subagent') continue;
          let depth = 0;
          let cursor: string | null | undefined = node.id;
          while (cursor !== null && cursor !== undefined) {
            cursor = parentOf.get(cursor) ?? null;
            if (cursor !== null) depth++;
          }
          expect(node.spawnDepth, `depth of ${node.id}`).toBe(depth);
        }
      }
    });
  });

  describe('8 · counts the golden records agree with the corpus', () => {
    it('records exactly the counters this suite knows how to check', () => {
      // Without this, a counter the generator renames becomes `undefined` on
      // the reading side and every comparison against it quietly stops meaning
      // anything.
      expect(Object.keys(need(name).golden.counts).sort()).toEqual([...COUNT_KEYS].sort());
    });

    it('tool and task part counts', () => {
      const l = need(name);
      expect(l.golden.counts.toolParts).toBe(l.measured.toolRows);
      expect(l.golden.counts.taskParts).toBe(l.measured.taskRowsTotal);
      expect(l.golden.counts.taskPartsJoined + l.golden.counts.taskPartsParked).toBe(
        l.measured.taskRowsTotal,
      );
    });

    it('no part was malformed, and every part is accounted for', () => {
      const l = need(name);
      expect(l.golden.counts.partsMalformed).toBe(0);
      expect(
        l.golden.counts.reasoningPartsDropped +
          l.golden.counts.partsIgnoredNoNode +
          l.golden.counts.toolParts +
          l.golden.counts.partsMalformed,
      ).toBe(l.golden.counts.partRows);
    });

    it('every tool part became exactly one ToolNode', () => {
      const l = need(name);
      const toolNodes = l.golden.sessions.flatMap((s) => walk(s.root)).filter((n) => n.node === 'tool');
      expect(toolNodes.length).toBe(l.measured.toolRows);
      expect(new Set(toolNodes.map((n) => n.id)).size).toBe(toolNodes.length);
    });
  });
});

/* ================================================================== *
 * 9. The hand-verified half is grounded in the corpus (DoD 3.4, half 2)
 * ================================================================== */
describe('9 · GOLDEN.md', () => {
  it('exists beside the anchor corpus', () => {
    expect(fs.existsSync(GOLDEN_MD)).toBe(true);
  });

  it('names only part and session ids that exist in the anchor corpus', () => {
    const text = fs.readFileSync(GOLDEN_MD, 'utf8');
    const l = need(ANCHOR);
    const sessionIds = new Set(l.measured.sessionRows.map((s) => s.id));
    const cited = [...text.matchAll(/\b(prt_[A-Za-z0-9]+|ses_[A-Za-z0-9]+)\b/g)].map((m) => m[1]!);
    expect(cited.length).toBeGreaterThan(0);
    const unknown = [
      ...new Set(
        cited.filter((id) =>
          id.startsWith('prt_') ? !l.measured.partIds.has(id) : !sessionIds.has(id),
        ),
      ),
    ];
    expect(unknown).toEqual([]);
  });

  it('says which half is hand-verified and which is machine-generated', () => {
    const text = fs.readFileSync(GOLDEN_MD, 'utf8');
    expect(text).toContain('hand-verified');
    expect(text).toContain('machine-generated');
  });
});
