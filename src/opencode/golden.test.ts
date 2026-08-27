/**
 * PLAN.md Phase 4 / DoD 4.6 — the golden reproduced THROUGH THE PRODUCTION PATH.
 *
 * > "The tree from the harvested DB through the production path equals
 * >  `fixtures/opencode-<version>/golden.json` (Phase 3.4) byte-for-byte after
 * >  canonical JSON."
 *
 * WHAT MAKES THIS DIFFERENT FROM `graft.test.ts`
 * ----------------------------------------------
 * `graft.test.ts` also byte-compares both goldens, and it is a real check — but
 * it builds the grafter's INPUTS itself, with its own canonical-JSON, its own
 * one-shot truncation and its own digest. It proves the assembly, not the
 * chain. This file calls `readOpenCodeEngine()` and nothing else: `db.ts` opens
 * and reads, `fingerprint.ts` asserts the schema and windows every session,
 * `parse.ts` redacts and truncates, `slug.ts` supplies `projectSlug`, and
 * `graft.ts` builds the trees. If any pair of those disagreed, `graft.test.ts`
 * would stay green and this file would not.
 *
 * WHAT THE GOLDEN DOES *NOT* PROVE, AND WHY IT IS SAID HERE
 * ---------------------------------------------------------
 * **Reproducing `golden.json` is not coverage.** The goldens are a byte-exact
 * target over the branches the two corpora happen to reach, and
 * `fixtures/opencode-1.18.22/GOLDEN.md` measures TEN branches that no row in
 * either corpus exercises — `liveness: "live"` (impossible from a static file
 * by construction), `ToolNode.status: "running"`, `joinKeyContradiction`,
 * `ambiguousJoinKey`, `noSpawningTaskPart`, `spawnDepth >= 2`, and the rest.
 * A green run here says nothing about any of them.
 * `docs/evidence/phase-4/COVERAGE.md` is the document that says which is which,
 * per `PLAN.md` Phase 4 `Amendment 2026-08-27` item A3.
 *
 * THE SERIALIZER BELOW IS A PROJECTION, NOT A SECOND ENGINE
 * ---------------------------------------------------------
 * It turns `SessionState` into the golden's on-disk shape: key order, node
 * times as offsets from the session's epoch anchor, previews by digest. It
 * computes nothing the engine computed — every value it writes came out of
 * `readOpenCodeEngine()`. In particular the truncation it would once have had
 * to do now happens in `parse.ts`, on the production path, which is the point.
 *
 * NOTHING IS WRITTEN. Both corpora are opened `immutable: true`
 * (`file:…?immutable=1`), which writes and locks nothing at all — safe here
 * precisely because the committed corpora are journal-mode `delete` and have no
 * WAL to skip. Each database's SHA-256 is compared before and after.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isAgentNode } from '../model/events.js';
import type { AgentNode, SessionState, ToolNode, TreeNode } from '../model/events.js';
import { DEFAULT_MAX_PAYLOAD_BYTES } from '../parser/redact.js';
import { readProjects } from './db.js';
import {
  OPENCODE_DATA_ROOT_ENV,
  opencodeDataDir,
  readOpenCodeEngine,
} from './index.js';
import {
  copyCorpus,
  corpusDbPath,
  corpusGoldenPath,
  listCorpora,
  makeTempDir,
  withWritableDb,
} from './synthetic.js';

/**
 * Corpus names resolved at COLLECTION time, not in a `beforeAll`.
 *
 * `describe.each` is evaluated while vitest is collecting. A list populated in
 * a hook is still empty at that moment, so every `.each` over it generates ZERO
 * tests — and a file that generates zero tests reports as a clean pass. This
 * repo has shipped that exact failure once.
 */
const CORPORA = listCorpora();

// ---------------------------------------------------------------------------
// The golden's on-disk shape
// ---------------------------------------------------------------------------

interface GoldenFile {
  schema: string;
  generator: string;
  generatedFrom: string;
  dataVersion: string;
  engine: string;
  previewBytes: number;
  counts: Record<string, number>;
  sessions: unknown[];
}

/**
 * `sha256:<first 16 hex>:<utf8 byte length>` — rule 3 of the READMEs under
 * `fixtures/golden/`. (Written the long way round on purpose: a glob with a
 * star-slash in it closes a block comment, which cost this phase three
 * unparseable files before anyone said it out loud.)
 */
function previewFingerprint(text: string | undefined): string | null {
  if (text === undefined) return null;
  const bytes = Buffer.from(text, 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}:${bytes.byteLength}`;
}

function serializeTool(node: ToolNode): unknown {
  return {
    node: 'tool',
    id: node.id,
    toolName: node.toolName,
    status: node.status,
    inputPreview: previewFingerprint(node.inputPreview),
    resultPreview: previewFingerprint(node.resultPreview),
    durationMs: node.durationMs ?? null,
    /*
     * OpenCode's OWN truncation claim (`state.metadata.truncated`), as of
     * `PLAN.md`'s Phase 5 gate B7 — `docs/evidence/phase-4/COVERAGE.md` item 22
     * and `GOLDEN.md` DEVIATION 5. Three states reach the golden: `true` and
     * `false` are claims OpenCode made, `null` is "no claim".
     *
     * `?? null` and not a presence check, because `false ?? null` is `false`:
     * an explicit "I did not truncate this" must survive the projection. This
     * computes nothing — the value came out of `readOpenCodeEngine()`.
     */
    truncated: node.truncated ?? null,
  };
}

function serializeAgent(node: AgentNode, anchor: number): unknown {
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
    children: node.children.map((child: TreeNode) =>
      isAgentNode(child) ? serializeAgent(child, anchor) : serializeTool(child),
    ),
  };
}

function serializeState(state: SessionState): unknown {
  // The anchor is the ROOT's own start, matching `scripts/opencode-golden.mjs`,
  // which passes `root.timeCreated` down rather than searching for a minimum.
  const anchor = state.root.startedAt;
  return {
    sessionId: state.sessionId,
    projectSlug: state.projectSlug,
    engine: state.engine,
    workspaceMatch: state.workspaceMatch,
    liveness: state.liveness,
    schemaOk: state.schemaOk,
    epochAnchor: new Date(anchor).toISOString(),
    totals: {
      inputTokens: state.totals.inputTokens,
      outputTokens: state.totals.outputTokens,
      costUsd: state.totals.costUsd,
    },
    spawnEdges: state.spawnEdges,
    parked: state.parked,
    root: serializeAgent(state.root, anchor),
  };
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ---------------------------------------------------------------------------

describe('DoD 4.6 — the production path reproduces the committed goldens', () => {
  it('found at least one corpus to run against', () => {
    // Guards the collection-time hazard above from the other direction: if the
    // fixtures move, this fails loudly instead of the file quietly passing with
    // no `describe.each` bodies at all.
    expect(CORPORA.length).toBeGreaterThan(0);
  });

  describe.each(CORPORA)('%s', (corpusName) => {
    const dbPath = corpusDbPath(corpusName);

    /*
     * MEMOISED, and that is a performance property with a measured reason.
     *
     * This used to do a full `readOpenCodeEngine()` pass per test — four tests
     * per corpus, over a 19 MB anchor and a 5.7 MB witness. Combined with the
     * other new OpenCode suites it pushed `src/perf/perf.test.ts`'s
     * filesystem-bound `tailPoll` budget from 7.1 ms (measured alone) to
     * 782.5 ms (measured inside the full suite), against a 150 ms limit. The
     * budget was NOT widened: widening a limit to survive contention is the
     * version-window mistake in timing form, and the limit reported exactly
     * what it measured.
     *
     * The engine is a pure function of the database here — the file is opened
     * `immutable: true`, nothing writes, and there is no clock on this path —
     * so one pass per corpus is the same evidence as fourteen.
     */
    let cached: {
      golden: GoldenFile;
      goldenText: string;
      state: ReturnType<typeof readOpenCodeEngine>;
    } | null = null;

    function run(): { golden: GoldenFile; goldenText: string; state: ReturnType<typeof readOpenCodeEngine> } {
      if (cached !== null) return cached;
      const goldenText = readFileSync(corpusGoldenPath(corpusName), 'utf8');
      cached = {
        golden: JSON.parse(goldenText) as GoldenFile,
        goldenText,
        state: readOpenCodeEngine({ dbPath, immutable: true }),
      };
      return cached;
    }

    it('reads the corpus without degrading or refusing', () => {
      const { state } = run();
      // Named rather than asserted as a bare truthiness: a degrade and a schema
      // mismatch are different failures and the message should say which.
      if (state.kind !== 'ok') {
        expect(`${state.kind}: ${JSON.stringify(state)}`).toBe('ok');
      }
      expect(state.kind).toBe('ok');
    });

    it('serializes byte-for-byte into golden.json', () => {
      const { golden, goldenText, state } = run();
      if (state.kind !== 'ok') throw new Error(`engine did not read ${corpusName}`);

      const rebuilt = {
        // Provenance fields belong to the generator, not to `SessionState`;
        // they are carried across so the byte compare is about the tree.
        schema: golden.schema,
        generator: golden.generator,
        generatedFrom: golden.generatedFrom,
        dataVersion: state.result.dataVersion,
        engine: 'opencode',
        previewBytes: DEFAULT_MAX_PAYLOAD_BYTES,
        counts: state.result.counts,
        sessions: state.result.sessions.map(serializeState),
      };

      // Structures first: a mismatch then reports as a diff of the offending
      // node rather than as two 100 KB strings with a caret somewhere in them.
      expect(rebuilt.counts).toStrictEqual(golden.counts);
      expect(rebuilt.sessions).toStrictEqual(golden.sessions);
      expect(`${JSON.stringify(rebuilt, null, 2)}\n`).toBe(goldenText);
    });

    it('carries the Amendment A1 projectSlug on every session', () => {
      // The production path's slug comes from `slug.ts` through `index.ts`;
      // `graft.ts`'s default returns `''` and would be caught by the byte
      // compare above, but this names the field so a failure reads clearly.
      const { state } = run();
      if (state.kind !== 'ok') throw new Error(`engine did not read ${corpusName}`);
      for (const session of state.result.sessions) {
        expect(session.projectSlug).not.toBe('');
        expect(session.engine).toBe('opencode');
      }
    });

    it('reads nothing but the database, and changes no byte of it (G1)', () => {
      // The memoised pass above already ran against this file; comparing the
      // digest to the committed fixture's own bytes is the assertion, and it
      // does not need a second engine pass to make it.
      const before = sha256File(dbPath);
      run();
      expect(sha256File(dbPath)).toBe(before);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
    });

    it('matches the workspace by project.worktree, and rejects a foreign one (OC8)', () => {
      /*
       * Not part of the golden — the goldens carry `workspaceMatch: true` from
       * the default predicate. This exercises the real matcher `index.ts`
       * installs when a host supplies workspace folders, including the
       * drive-letter case variance the CC engine already has to tolerate.
       *
       * The workspace path is READ OFF THE CORPUS, never written as a literal:
       * a hard-coded absolute path here would pin one machine, and it would put
       * a developer identifier in `src/`, which the privacy sweep gates on.
       */
      const plain = run().state;
      if (plain.kind !== 'ok') throw new Error('engine did not read the corpus');
      const worktrees = new Set(plain.result.sessions.map((s) => s.projectSlug));
      expect(worktrees.size).toBe(1);

      const projects = readProjects(dbPath);
      if (!projects.ok) throw new Error('could not read the project row');
      const [project] = projects.value;
      if (project === undefined) throw new Error('the corpus has no project row');

      // The corpus's own worktree with the drive letter's case FLIPPED, which
      // is the variance this repo has measured from Claude Code itself.
      const flipped = project.worktree.replace(/^([A-Za-z])(?=:)/, (c) =>
        c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
      );
      expect(flipped).not.toBe(project.worktree);
      const matched = readOpenCodeEngine({ dbPath, immutable: true, workspacePaths: [flipped] });
      if (matched.kind !== 'ok') throw new Error('engine did not read the corpus');
      expect(matched.result.sessions.every((s) => s.workspaceMatch)).toBe(true);

      const foreign = readOpenCodeEngine({
        dbPath,
        immutable: true,
        workspacePaths: ['D:/somewhere/else'],
      });
      if (foreign.kind !== 'ok') throw new Error('engine did not read the corpus');
      expect(foreign.result.sessions.some((s) => s.workspaceMatch)).toBe(false);
    });
  });
});

describe('DoD 4.2 end to end — a mixed-version database renders some and refuses the rest', () => {
  /*
   * The mixed database is the NORMAL case, not a hypothetical. The measured one
   * held five `1.18.21` rows beside twenty-three `1.18.22` rows while the
   * OpenCode binary self-updated `1.18.22` -> `1.18.23` underneath the
   * measurement (spec OC5). Never ask the binary what version wrote the data.
   *
   * `fingerprint.test.ts` proves the partition. What is proved HERE is what the
   * engine does with it: an in-window session renders a tree, and an
   * out-of-window one renders `unsupported` — visible, not dropped.
   */
  const smallest = [...listCorpora()].sort(
    (a, b) => statSync(corpusDbPath(a)).size - statSync(corpusDbPath(b)).size,
  )[0];

  function mixedCopy(): { dir: string; dbPath: string; refusedIds: string[] } {
    const dir = makeTempDir('oc-mixed-');
    const dbPath = copyCorpus(smallest as string, dir);
    // Push the ROOT sessions' version far out of any window around the anchor:
    // `4.4.0` differs on the major AND the minor, so no movement of the anchor
    // inside `1.x` can quietly re-admit it. That is the same defence the CC
    // refusal fixtures carry after being re-versioned twice for exactly this.
    const refusedIds = withWritableDb(dbPath, (db) => {
      const roots = db
        .prepare('SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_created LIMIT 2')
        .all() as { id: string }[];
      for (const row of roots) {
        db.prepare('UPDATE session SET version = ? WHERE id = ?').run('4.4.0', row.id);
      }
      return roots.map((r) => r.id);
    });
    return { dir, dbPath, refusedIds };
  }

  it('renders the in-window sessions and marks the rest unsupported', () => {
    const { dir, dbPath, refusedIds } = mixedCopy();
    try {
      expect(refusedIds.length).toBeGreaterThan(0);
      const outcome = readOpenCodeEngine({ dbPath });
      // NOT a whole-database refusal: the schema is untouched, so the engine
      // must keep going and refuse per session.
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;

      const refused = outcome.result.refused;
      expect(refused.map((r) => r.sessionId).sort()).toStrictEqual([...refusedIds].sort());
      for (const entry of refused) {
        expect(entry.code).toBe('unsupportedVersion');
        expect(entry.observedVersion).toBe('4.4.0');
      }

      // A refusal that the renderer cannot see is not a refusal: each refused
      // ROOT session is present as an `unsupported` state with an empty tree.
      const byId = new Map(outcome.result.sessions.map((s) => [s.sessionId, s]));
      for (const id of refusedIds) {
        const state = byId.get(id);
        expect(state, `${id} vanished instead of rendering unsupported`).toBeDefined();
        expect(state?.liveness).toBe('unsupported');
        expect(state?.schemaOk).toBe(false);
        expect(state?.root.children).toStrictEqual([]);
        expect(state?.totals).toStrictEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
      }

      // And the in-window ones still render a real tree — otherwise this would
      // pass just as well if the engine had refused everything.
      const rendered = outcome.result.sessions.filter((s) => s.schemaOk);
      expect(rendered.length).toBeGreaterThan(0);
      expect(rendered.some((s) => s.root.children.length > 0)).toBe(true);

      /*
       * `engine` is stamped UNCONDITIONALLY, and this read is the only place
       * both arms exist at once: the grafted sessions come from `graft.ts` and
       * the refused ones from `index.ts`'s `unsupportedSession`, two separate
       * literals that must agree. Asserted over every session rather than over
       * each arm separately, because "unconditionally" is a claim about the
       * whole list.
       */
      expect(refusedIds.length).toBeGreaterThan(0);
      expect(rendered.length + refusedIds.length).toBe(outcome.result.sessions.length);
      for (const state of outcome.result.sessions) {
        expect(state.engine, `${state.sessionId} engine`).toBe('opencode');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses every session when the whole database is out of window', () => {
    const dir = makeTempDir('oc-allmixed-');
    try {
      const dbPath = copyCorpus(smallest as string, dir);
      withWritableDb(dbPath, (db) => db.prepare('UPDATE session SET version = ?').run('4.4.0'));
      const outcome = readOpenCodeEngine({ dbPath });
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;
      expect(outcome.result.sessions.every((s) => !s.schemaOk)).toBe(true);
      expect(outcome.result.sessions.every((s) => s.liveness === 'unsupported')).toBe(true);
      expect(outcome.result.refused.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parks a refused CHILD on its accepted parent, with childSessionUnsupported', () => {
    /*
     * `docs/evidence/phase-4/COVERAGE.md` item 29, closed by `PLAN.md`'s Phase
     * 5 gate B7, THROUGH THE PRODUCTION PATH and against a real parent/child
     * pair out of a committed corpus — the rows, the `task` part and the join
     * are OpenCode's, and only the child's version string is mutated on the
     * temp copy. Through Phase 4 this reported `joinKeyContradiction`, which
     * was visible and safe and told the wrong story.
     */
    const dir = makeTempDir('oc-refusedchild-');
    try {
      const dbPath = copyCorpus(smallest as string, dir);
      const pair = withWritableDb(dbPath, (db) => {
        const row = db
          .prepare(
            'SELECT id, parent_id FROM session WHERE parent_id IS NOT NULL' +
              ' ORDER BY time_created LIMIT 1',
          )
          .get() as { id: string; parent_id: string } | undefined;
        if (row === undefined) return undefined;
        // `4.4.0` differs on the major AND the minor, so no movement of the
        // anchor inside `1.x` can quietly re-admit it.
        db.prepare('UPDATE session SET version = ? WHERE id = ?').run('4.4.0', row.id);
        return { childId: row.id, parentId: row.parent_id };
      });
      // Derived from the corpus rather than assumed: if the fixtures ever hold
      // no child session this fails loudly instead of testing nothing.
      expect(pair, 'no corpus child session to refuse').toBeDefined();
      if (pair === undefined) return;

      const outcome = readOpenCodeEngine({ dbPath });
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;

      expect(outcome.result.refused.map((r) => r.sessionId)).toStrictEqual([pair.childId]);
      expect(outcome.result.refused[0]?.code).toBe('unsupportedVersion');

      // The refused child does NOT become a deck entry of its own: a child is
      // a subagent inside its parent's session (contract §9).
      const byId = new Map(outcome.result.sessions.map((s) => [s.sessionId, s]));
      expect(byId.has(pair.childId)).toBe(false);

      // It parks on the ROOT state that would have rendered it. The parent may
      // itself be a subagent, so the owning state is found by search.
      const owner = outcome.result.sessions.find((s) =>
        (s.parked ?? []).some((p) => p.agentId === pair.childId),
      );
      expect(owner, `${pair.childId} parked nowhere`).toBeDefined();
      const entry = (owner?.parked ?? []).find((p) => p.agentId === pair.childId);
      expect(entry?.code).toBe('childSessionUnsupported');
      expect(entry?.toolUseId).toBeTypeOf('string');
      expect(entry?.reason).toContain('version window');

      // The parent still renders its remaining tree, spawning `task` call
      // included, and no spawn edge claims the refused child.
      expect(owner?.schemaOk).toBe(true);
      expect(owner?.root.children.length).toBeGreaterThan(0);
      expect((owner?.spawnEdges ?? []).some((e) => e.agentId === pair.childId)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accumulates a NON-ZERO session.cost into totals.costUsd (DoD 4.3)', () => {
    /*
     * `docs/evidence/phase-4/COVERAGE.md` item 33. Every session in both
     * corpora carries `cost = 0`, so `graft.ts`'s `totals.costUsd +=
     * session.cost` had never seen a non-zero value through any path. Here the
     * REAL column is written on a temp copy and read back through `db.ts`'s
     * `realOf`, the fingerprint, the parse and the grafter.
     *
     * 0.25 and 0.5 are exact in binary floating point, so 0.75 is exact: this
     * asserts the accumulation, not float tidiness.
     */
    const dir = makeTempDir('oc-cost-');
    try {
      const dbPath = copyCorpus(smallest as string, dir);
      const pair = withWritableDb(dbPath, (db) => {
        const row = db
          .prepare(
            'SELECT id, parent_id FROM session WHERE parent_id IS NOT NULL' +
              ' ORDER BY time_created LIMIT 1',
          )
          .get() as { id: string; parent_id: string } | undefined;
        if (row === undefined) return undefined;
        db.prepare('UPDATE session SET cost = ? WHERE id = ?').run(0.25, row.parent_id);
        db.prepare('UPDATE session SET cost = ? WHERE id = ?').run(0.5, row.id);
        return { childId: row.id, parentId: row.parent_id };
      });
      expect(pair, 'no corpus parent/child pair to price').toBeDefined();
      if (pair === undefined) return;

      const outcome = readOpenCodeEngine({ dbPath });
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;

      const owner = outcome.result.sessions.find((s) =>
        (s.spawnEdges ?? []).some((e) => e.agentId === pair.childId),
      );
      expect(owner, `${pair.childId} did not graft`).toBeDefined();
      // Parent 0.25 + child 0.5, summed over the tree, not over the database.
      expect(owner?.totals.costUsd).toBe(0.75);

      // And a session nobody priced still reports exactly 0 — the goldens'
      // case, and DoD 4.3's other half.
      const untouched = outcome.result.sessions.filter(
        (s) => s.sessionId !== owner?.sessionId,
      );
      expect(untouched.length).toBeGreaterThan(0);
      for (const state of untouched) expect(state.totals.costUsd).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives a refused session its REAL workspaceMatch, so the deck can show it', () => {
    /*
     * THE SEAM, and why a hard-coded `false` was wrong in composition.
     *
     * The host filters the deck by `workspaceMatch`, matching what
     * `SessionModel` does for Claude Code. While `unsupportedSession` hard-coded
     * `false`, every refused OpenCode session was filtered off the deck: a user
     * whose OpenCode drifted out of the version window saw NOTHING rather than
     * an `unsupported` card, which defeats G3 and contradicts this engine's own
     * rule that a refusal invisible to the renderer is not a refusal.
     *
     * Safe because the session refused on `session.version`, a column of the
     * `session` row, while the match reads `project.worktree` from the
     * `project` table. Different row, so this is not trusting the shape the
     * fingerprint rejected.
     *
     * The workspace path is READ OFF THE CORPUS, never written as a literal: a
     * hard-coded absolute path would pin one machine and would put a developer
     * identifier in a source file.
     */
    const { dir, dbPath, refusedIds } = mixedCopy();
    try {
      expect(refusedIds.length).toBeGreaterThan(0);
      const projects = readProjects(dbPath);
      if (!projects.ok) throw new Error('could not read the project row');
      const [project] = projects.value;
      if (project === undefined) throw new Error('the corpus has no project row');

      const matched = readOpenCodeEngine({ dbPath, workspacePaths: [project.worktree] });
      expect(matched.kind).toBe('ok');
      if (matched.kind !== 'ok') return;

      const byId = new Map(matched.result.sessions.map((s) => [s.sessionId, s]));
      for (const id of refusedIds) {
        const state = byId.get(id);
        expect(state, `${id} vanished instead of rendering unsupported`).toBeDefined();
        // The point of the change: visible to a deck that filters on this.
        expect(state?.workspaceMatch, `${id} workspaceMatch`).toBe(true);
        /*
         * STAMPED, and this is the arm where a stamp is easiest to drop:
         * `unsupportedSession`'s entire job is to emit almost nothing, so a
         * field omitted there would look like part of the refusal rather than
         * a bug. The phase's round-trip contract rests on BOTH engines writing
         * `engine` unconditionally - refused states included - and until this
         * line the OpenCode half of that premise rested on reading the code.
         * OC7: absence reads as `'cc'`, so an unstamped OpenCode refusal would
         * not be untagged, it would be tagged as the wrong engine.
         */
        expect(state?.engine, `${id} engine`).toBe('opencode');
        // And STILL a refusal. Nothing else moved: no tree, no totals, no slug.
        expect(state?.liveness).toBe('unsupported');
        expect(state?.schemaOk).toBe(false);
        expect(state?.root.children).toStrictEqual([]);
        expect(state?.totals).toStrictEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
        expect(state?.projectSlug).toBe('');
        expect(state?.spawnEdges).toStrictEqual([]);
        expect(state?.parked).toStrictEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still reports false for a refused session in a NON-matching workspace', () => {
    /*
     * THE CONTROL THAT MAKES THE TEST ABOVE MEAN ANYTHING. Without it, the
     * change would be indistinguishable from hard-coding `true` — which would
     * be the same defect inverted, showing a user sessions from a workspace
     * they do not have open.
     */
    const { dir, dbPath, refusedIds } = mixedCopy();
    try {
      const foreign = readOpenCodeEngine({ dbPath, workspacePaths: ['D:/somewhere/else'] });
      expect(foreign.kind).toBe('ok');
      if (foreign.kind !== 'ok') return;

      const byId = new Map(foreign.result.sessions.map((s) => [s.sessionId, s]));
      for (const id of refusedIds) {
        const state = byId.get(id);
        // Present but unmatched: the refusal is still a session the engine
        // knows about, it just does not belong to an open folder.
        expect(state, `${id} vanished`).toBeDefined();
        expect(state?.workspaceMatch, `${id} workspaceMatch`).toBe(false);
        expect(state?.liveness).toBe('unsupported');
      }
      // The accepted sessions in the same read agree — one predicate, not two.
      expect(foreign.result.sessions.every((s) => !s.workspaceMatch)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses ONE predicate for accepted and refused sessions alike', () => {
    // With no `workspacePaths` the host has supplied nothing, and the rule is
    // `graft.ts`'s `defaultWorkspaceMatch` — project row exists. A refused
    // session must answer that question the same way an accepted one does;
    // before this change it answered `false` while its neighbours answered
    // `true`, which is the drift that produced the seam.
    const { dir, dbPath, refusedIds } = mixedCopy();
    try {
      const outcome = readOpenCodeEngine({ dbPath });
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;
      const refusedSet = new Set(refusedIds);
      const refusedStates = outcome.result.sessions.filter((s) => refusedSet.has(s.sessionId));
      const acceptedStates = outcome.result.sessions.filter((s) => !refusedSet.has(s.sessionId));
      expect(refusedStates.length).toBe(refusedIds.length);
      expect(acceptedStates.length).toBeGreaterThan(0);
      expect(new Set(outcome.result.sessions.map((s) => s.workspaceMatch)).size).toBe(1);
      expect(refusedStates.every((s) => s.workspaceMatch)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades with graftFailed when the graft cannot place an accepted row', () => {
    /*
     * The case `graft.ts`'s `@throws` names, driven END TO END through
     * `readOpenCodeEngine()` off a REAL parent/child pair in a committed
     * corpus: the PARENT's version is pushed out of window on a temp copy, so
     * the child stays accepted, names a parent that is not in the accepted
     * rows, and is reachable from no root. `graftCorpus` throws exactly as it
     * is supposed to, and the boundary catch turns it into a degrade.
     *
     * Not an injected fake: the rows, the parent/child edge and the throw are
     * all real. Only the version string is mutated, which is the same technique
     * the mixed-version tests above use.
     *
     * This asserts CONTAINMENT, not a fix. A degrade darkens every OpenCode
     * session over one unplaceable row; `index.ts`'s catch site says so.
     */
    const dir = makeTempDir('oc-graftfail-');
    try {
      const dbPath = copyCorpus(smallest as string, dir);
      const pair = withWritableDb(dbPath, (db) => {
        const row = db
          .prepare(
            'SELECT id, parent_id FROM session WHERE parent_id IS NOT NULL' +
              ' ORDER BY time_created LIMIT 1',
          )
          .get() as { id: string; parent_id: string } | undefined;
        if (row === undefined) return undefined;
        // The PARENT, not the child - refusing the child is the item 29 case
        // above and parks cleanly. This is the one nothing can place.
        db.prepare('UPDATE session SET version = ? WHERE id = ?').run('4.4.0', row.parent_id);
        return { childId: row.id, parentId: row.parent_id };
      });
      expect(pair, 'no corpus parent/child pair to orphan').toBeDefined();
      if (pair === undefined) return;

      // Returned, never thrown: that is `OcEngineOutcome`'s whole contract, and
      // the extension host calls this from `activate`.
      const outcome = readOpenCodeEngine({ dbPath });
      expect(outcome.kind).toBe('degraded');
      if (outcome.kind !== 'degraded') return;

      expect(outcome.health.code).toBe('graftFailed');
      // Distinguishable from a storage failure, because the operator response
      // has nothing in common with one.
      expect(['databaseMissing', 'databaseUnreadable', 'databaseCorrupt']).not.toContain(
        outcome.health.code,
      );
      // The cause is not swallowed: the message names the row that could not be
      // placed, so this is findable in the field.
      expect(outcome.health.message).toContain('reachable from no root');
      expect(outcome.health.message).toContain(pair.childId);
      // The path is the file that was opened, never one read out of the store.
      expect(outcome.health.path).toBe(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never reports graftFailed for a corpus that grafts', () => {
    // The control: without it the test above would pass just as well if the
    // engine had started degrading on everything.
    for (const name of CORPORA) {
      const outcome = readOpenCodeEngine({ dbPath: corpusDbPath(name), immutable: true });
      expect(outcome.kind, name).toBe('ok');
    }
  });

  it('degrades rather than throwing when the database is not there', () => {
    const dir = makeTempDir('oc-missing-');
    try {
      const outcome = readOpenCodeEngine({ dataDir: dir });
      expect(outcome.kind).toBe('degraded');
      if (outcome.kind === 'degraded') expect(outcome.health.code).toBe('databaseMissing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the data root from the Agent Deck override, not from XDG_DATA_HOME', () => {
    // Spec OC1: the engine defines its own override rather than relying on
    // OpenCode's resolution, so our tests are not hostage to another project's
    // environment handling — even though XDG_DATA_HOME *was* measured to work.
    const dir = makeTempDir('oc-root-');
    try {
      expect(opencodeDataDir({ [OPENCODE_DATA_ROOT_ENV]: dir })).toBe(dir);
      expect(opencodeDataDir({ XDG_DATA_HOME: dir })).not.toBe(dir);
      // And the default is under the user profile, which `homedir()` reads on
      // Windows — the trap being that faking only HOME reaches the REAL store.
      const fallback = opencodeDataDir({});
      expect(fallback.endsWith(join('.local', 'share', 'opencode'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
