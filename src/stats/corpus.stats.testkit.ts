/**
 * Every committed session as a REAL `SessionState`, labelled with the corpus it
 * came from — the input to every Phase 2 golden.
 *
 * v0.7.0 Phase 2, DoD 2.3. Test-only, `.testkit.ts` for the reason
 * `corpus.testkit.ts` states: vitest collects `*.test.ts`, so this is a helper
 * and never a suite. It shares that file's corpus DISCOVERY and adds two things
 * Phase 2 needs and Phase 1 did not.
 *
 * ## 1. Claude Code goes through `SessionModel`, not through the graft snapshot
 *
 * `corpus.testkit.ts`'s CC reader returns `graftSession(...).snapshot`, cast
 * `as unknown as SessionState`. **That cast is not true, and it was measured
 * rather than suspected.** The two shapes:
 *
 *     graft snapshot   burn contextNow counts depthMismatches edges parked
 *                      projectSlug root sessionId totals
 *     SessionState     burn contextNow engine liveness parked projectSlug root
 *                      schemaOk sessionId spawnEdges totals workspaceMatch
 *
 * It carries `edges` where a state carries `spawnEdges`, and it carries no
 * `engine`, no `liveness`, no `workspaceMatch` and — the one that decides this
 * — **no `schemaOk`**. F11 reads `schemaOk !== true`, so a deriver fed graft
 * snapshots would mark every Claude Code session in the repository
 * `excluded:unsupported`, and 9 of 23 goldens would pin a refusal.
 *
 * That cast is harmless for Phase 1, which asserts fields on `ToolNode` and
 * `AgentNode` — tree-level facts, where the graft output IS the production
 * output. It is not harmless here. `SessionModel` is CC's real assembly point,
 * the only place a `SessionState` is built from CC's two taps, so this reader
 * drives it. Nothing is re-implemented and `corpus.testkit.ts` is untouched.
 *
 * ## 2. Codex needs NO staging any more, and that is the point
 *
 * Phase 2 first read the Codex corpus from a temp copy with every file's mtime
 * pinned, because `AgentNode.endedAt` was `thread.mtimeMs` and **git does not
 * preserve mtimes**: every Codex session reported `2026-09-04T11:08:50Z`, the
 * mtime of its own rollout file in the working tree that produced the reading,
 * so a Codex golden would have been red on any other machine.
 *
 * **v0.7.0 DoD 2.10 (user ruling, 2026-09-08) closed that at the source
 * instead:** the Codex engine derives `endedAt` from the LAST RECORD's own
 * timestamp, and never from a filesystem attribute. The staging is therefore
 * DELETED rather than left in place — and deleting it is what makes the
 * determinism proof mean anything. A reader that pinned mtimes would satisfy
 * "generate twice from different trees and diff" whether or not the engine had
 * been fixed, which is a check whose subject never happens.
 *
 * `codex-determinism.test.ts` is the proof: it copies the corpus, resets the
 * copy's mtimes to a different instant, reads BOTH through the production
 * engine, and requires byte-identical records.
 *
 * ## Determinism, in one list
 *
 *   - the clock is a constant ({@link FIXED_NOW_MS}), injected into
 *     `LivenessEngine`, so no session is `live` and no tool is `stalled`;
 *   - no hook event is ingested, so `lastActivityAt` is absent and F13 is
 *     empty for every corpus session by construction;
 *   - every list is sorted before it is returned.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCodexEngine } from '../codex/index.js';
import type { SessionState } from '../model/events.js';
import { LivenessEngine } from '../model/liveness.js';
import { SessionModel } from '../model/session.js';
import { readOpenCodeEngine } from '../opencode/index.js';
import { parseLines, parseSubagentMeta } from '../parser/parse.js';

import { deriveStats } from './derive.js';
import { parsePricing } from './pricing.js';
import type { StatsEngine, StatsRecord } from './schema.js';
import { SYNTHETIC_NOW_MS, SYNTHETIC_PRICING, buildSyntheticStatsFixtures } from './synthetic.testkit.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));

/**
 * The instant every corpus read is taken at.
 *
 * Far in the past relative to the captures, so nothing is `live`. It is a
 * constant rather than a clock for the reason the deriver takes `now` as a
 * parameter at all: a golden derived against `Date.now()` is not a golden.
 */
export const FIXED_NOW_MS = 1_700_000_000_000;

/** One committed session, and where it came from. */
export interface CorpusSession {
  engine: StatsEngine;
  /** The corpus directory name — `cc-2.1.260`. */
  corpus: string;
  /** That name with the `<engine>-` prefix removed — `2.1.260`. */
  version: string;
  state: SessionState;
}

/**
 * The golden's filename stem: `<engine>-<version>-<session>`.
 *
 * DoD 2.3 names this shape. It is built here rather than at each call site so
 * the generator and the byte-equality test cannot disagree about it — the
 * "two agreeing literals is not a contract" rule.
 */
export function goldenStem(entry: Pick<CorpusSession, 'engine' | 'version' | 'state'>): string {
  return `${entry.engine}-${entry.version}-${entry.state.sessionId}`;
}

function versionOf(corpus: string, engine: StatsEngine): string {
  return corpus.startsWith(`${engine}-`) ? corpus.slice(engine.length + 1) : corpus;
}

/**
 * Corpus directories for one engine.
 *
 * Discovered from disk and never a hard-coded list — the recorded rule against
 * asserting fixture-set sizes — and it THROWS on an empty result rather than
 * returning one, because a discovery bug that finds nothing would otherwise
 * make every caller iterate nothing and pass.
 */
function corpusDirs(prefix: string, marker: (dir: string) => boolean): string[] {
  const named = fs
    .readdirSync(FIXTURES)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(FIXTURES, name))
    .filter((dir) => fs.statSync(dir).isDirectory())
    .sort();
  const dirs = named.filter(marker).sort();
  if (dirs.length === 0) throw new Error(`no ${prefix}* corpus found under ${FIXTURES}`);
  return dirs;
}

// ---------------------------------------------------------------------------
// Claude Code — through SessionModel, the real assembly point
// ---------------------------------------------------------------------------

interface CcTranscript {
  slugDir: string;
  slug: string;
  sessionId: string;
  mainPath: string;
}

function ccTranscripts(corpusDir: string): CcTranscript[] {
  const projects = path.join(corpusDir, 'projects');
  if (!fs.existsSync(projects)) return [];
  const out: CcTranscript[] = [];
  for (const slug of fs.readdirSync(projects)) {
    const slugDir = path.join(projects, slug);
    if (!fs.statSync(slugDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(slugDir)) {
      // Subagent transcripts live one level down and are grafted in, not read
      // as sessions of their own.
      if (!entry.endsWith('.jsonl')) continue;
      out.push({
        slugDir,
        slug,
        sessionId: entry.slice(0, -'.jsonl'.length),
        mainPath: path.join(slugDir, entry),
      });
    }
  }
  return out.sort((a, b) => (a.mainPath < b.mainPath ? -1 : 1));
}

async function readCcCorpus(): Promise<CorpusSession[]> {
  const out: CorpusSession[] = [];
  for (const dir of corpusDirs('cc-', (d) => fs.existsSync(path.join(d, 'projects')))) {
    const corpus = path.basename(dir);
    for (const transcript of ccTranscripts(dir)) {
      const model = new SessionModel({
        // The slug's own decoded form, so `workspaceMatch` is a real answer
        // rather than a coincidence. It reaches no `StatsRecord` field either
        // way — this is here so the state is assembled the way production
        // assembles it, not to satisfy an assertion.
        workspacePath: transcript.slug.replace(/^([a-zA-Z])--/u, '$1:\\').replace(/-/gu, '\\'),
        liveness: new LivenessEngine({ now: () => FIXED_NOW_MS }),
      });
      model.registerSession({ sessionId: transcript.sessionId, projectSlug: transcript.slug });

      const mainText = fs.readFileSync(transcript.mainPath, 'utf8');
      const main = parseLines(mainText.split('\n').filter((l) => l.length > 0));
      // A corpus may legitimately hold a refusal fixture. Skipping it is what
      // `corpus.testkit.ts` does and the reason is the same: this helper
      // supplies the sessions that render, not a re-assertion of the version
      // window.
      if (!main.ok) continue;
      model.ingestTranscript(transcript.sessionId, transcript.slug, {
        kind: 'main',
        path: transcript.mainPath,
        entries: main.value.entries,
      });

      const subagentDir = path.join(transcript.slugDir, transcript.sessionId, 'subagents');
      if (fs.existsSync(subagentDir)) {
        for (const entry of fs.readdirSync(subagentDir).sort()) {
          if (!entry.startsWith('agent-') || !entry.endsWith('.jsonl')) continue;
          const agentId = entry.slice('agent-'.length, -'.jsonl'.length);
          const jsonlPath = path.join(subagentDir, entry);
          const parsed = parseLines(
            fs.readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.length > 0),
          );
          if (!parsed.ok) continue;
          model.ingestTranscript(transcript.sessionId, transcript.slug, {
            kind: 'subagent',
            path: jsonlPath,
            agentId,
            entries: parsed.value.entries,
          });
          const metaPath = path.join(subagentDir, `agent-${agentId}.meta.json`);
          if (!fs.existsSync(metaPath)) continue;
          const meta = parseSubagentMeta(fs.readFileSync(metaPath, 'utf8'), metaPath);
          model.ingestSidecar(transcript.sessionId, transcript.slug, {
            agentId,
            metaPath,
            ...(meta.ok ? { meta: meta.value } : { metaFailure: 'unparsed' }),
          });
        }
      }

      const state = model.sessionState(transcript.sessionId);
      if (state === undefined) continue;
      out.push({ engine: 'cc', corpus, version: versionOf(corpus, 'cc'), state });
    }
  }
  if (out.length === 0) throw new Error('no CC session assembled from any cc-* corpus');
  return await Promise.resolve(out);
}

// ---------------------------------------------------------------------------
// OpenCode — the shipped reader, unchanged
// ---------------------------------------------------------------------------

function findStores(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current)) {
      const full = path.join(current, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      // `opencode-1.18.25` keeps its store a level down. A root-only search
      // silently skipped it once already, which Phase 0 records as a fail-open.
      else if (entry === 'opencode.db') out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

async function readOpenCodeCorpus(): Promise<CorpusSession[]> {
  const out: CorpusSession[] = [];
  for (const dir of corpusDirs('opencode-', () => true)) {
    const corpus = path.basename(dir);
    for (const dbPath of findStores(dir)) {
      const outcome = readOpenCodeEngine({ dbPath, immutable: true });
      if (outcome.kind !== 'ok') continue;
      for (const state of outcome.result.sessions) {
        out.push({ engine: 'opencode', corpus, version: versionOf(corpus, 'opencode'), state });
      }
    }
  }
  if (out.length === 0) throw new Error('no OpenCode session read from any opencode-* corpus');
  return await Promise.resolve(out);
}

// ---------------------------------------------------------------------------
// Codex — read in place; DoD 2.10 removed the reason for staging
// ---------------------------------------------------------------------------

async function readCodexCorpus(): Promise<CorpusSession[]> {
  const out: CorpusSession[] = [];
  // Selected by the presence of a golden, which is what separates an ANCHOR
  // corpus from a witness — never by sort order, which a differently named
  // corpus would break silently.
  for (const dir of corpusDirs('codex-', (d) => fs.existsSync(path.join(d, 'golden.json')))) {
    const corpus = path.basename(dir);
    for (const run of fs.readdirSync(dir).sort()) {
      const root = path.join(dir, run, 'home', '.codex');
      if (!fs.existsSync(root)) continue;
      // Read IN PLACE. No staging, no temp copy, no mtime pinning — see the
      // header: the engine no longer reads a filesystem attribute, so there is
      // nothing left for staging to stabilise.
      const outcome = await readCodexEngine({ root });
      if (outcome.kind !== 'ok') continue;
      for (const state of outcome.result.sessions) {
        out.push({ engine: 'codex', corpus, version: versionOf(corpus, 'codex'), state });
      }
    }
  }
  if (out.length === 0) throw new Error('no Codex session read from any codex-* corpus');
  return out;
}

// ---------------------------------------------------------------------------
// The exported reader
// ---------------------------------------------------------------------------

let pending: Promise<CorpusSession[]> | null = null;

/**
 * Every committed session of every engine, as a real `SessionState`.
 *
 * Memoised per worker for the reason `corpus.testkit.ts` gives: these readers
 * used to be called dozens of times per file to answer questions about bytes
 * that had not changed, and on a loaded machine one uncached read exceeded
 * vitest's 5 s default and reported as a timeout with no failing assertion.
 *
 * NOT deep-frozen, unlike `corpus.testkit.ts`'s readers: the OpenCode and Codex
 * engines hand back states this module does not own, and freezing them would
 * reach into objects other suites read. The consumers here derive from these
 * and mutate none of them; `goldens.test.ts` proves that by deriving twice and
 * comparing bytes.
 */
export function readCorpusSessions(): Promise<CorpusSession[]> {
  pending ??= (async () => {
    const [cc, oc, codex] = await Promise.all([
      readCcCorpus(),
      readOpenCodeCorpus(),
      readCodexCorpus(),
    ]);
    return [...cc, ...oc, ...codex].sort((a, b) =>
      goldenStem(a) < goldenStem(b) ? -1 : goldenStem(a) > goldenStem(b) ? 1 : 0,
    );
  })();
  return pending;
}

// ---------------------------------------------------------------------------
// The goldens: one definition, used by the script AND by the test
// ---------------------------------------------------------------------------

/**
 * A record's committed form.
 *
 * Two-space JSON with a trailing newline — the shape `sessionGoldenText` in
 * `session.ts` already established for this repository's goldens, so a reviewer
 * reads one diff format rather than two. The trailing newline matters: without
 * it every editor that adds one turns every golden into a diff.
 */
export function statsGoldenText(record: StatsRecord): string {
  return `${JSON.stringify(record, null, 2)}
`;
}

/** One golden: the name on disk, and the bytes that belong in it. */
export interface GoldenEntry {
  stem: string;
  /** `corpus` for a harvested session, `synthetic` for an R8 fixture. */
  source: 'corpus' | 'synthetic';
  record: StatsRecord;
  text: string;
  /**
   * The state the record was derived FROM.
   *
   * Carried so `redaction.test.ts` can check PROVENANCE rather than absence:
   * every string in a record must be a value the engine put on a named field of
   * this state, or a closed enum. That is the only form of the G4 question that
   * is not confounded — an agent id and a file path both occur inside message
   * text and tool payloads legitimately, so "this string does not appear in the
   * content corpus" is false of the very fields G4 allow-lists.
   */
  state: SessionState;
}

/**
 * The R8 fixtures as golden entries.
 *
 * Named `<engine>-synthetic-<fixtureId>` rather than by session id, and fixture
 * 13 is why: its session id is the OTel capture's own, because the join is by
 * `session.id`. Keying the golden on the R8 name keeps all fourteen readable
 * and keeps that one from being filed under a UUID.
 *
 * ONE set of params for all fourteen, and that is deliberate: only `11-user-priced`
 * carries a model id in {@link SYNTHETIC_PRICING}, so applying the table to
 * every fixture also proves the other thirteen do not acquire a cost from it.
 */
export function syntheticGoldenEntries(): GoldenEntry[] {
  const { table } = parsePricing(SYNTHETIC_PRICING);
  return buildSyntheticStatsFixtures().map((fixture) => {
    const engine: StatsEngine = fixture.state.engine ?? 'cc';
    const record = deriveStats(fixture.state, { pricing: table, now: SYNTHETIC_NOW_MS });
    return {
      stem: `${engine}-synthetic-${fixture.id}`,
      source: 'synthetic' as const,
      record,
      text: statsGoldenText(record),
      state: fixture.state,
    };
  });
}

/**
 * Every golden this phase commits: the harvested corpora, then R8.
 *
 * The harvested half is derived with NO price table and the fixed corpus clock.
 * An empty table is the shipped default (`agentDeck.pricing` is `{}`), so these
 * records are what a user with no configuration would get — which is what makes
 * them evidence about the product rather than about a test's setup.
 */
export async function allGoldenEntries(): Promise<GoldenEntry[]> {
  const corpus = (await readCorpusSessions()).map((entry) => {
    const record = deriveStats(entry.state, { now: FIXED_NOW_MS });
    return {
      stem: goldenStem(entry),
      source: 'corpus' as const,
      record,
      text: statsGoldenText(record),
      state: entry.state,
    };
  });
  const entries = [...corpus, ...syntheticGoldenEntries()];
  // A duplicate stem would make one golden overwrite another and the count
  // would still look right. Cheap to check, and impossible to notice otherwise.
  const stems = new Set<string>();
  for (const entry of entries) {
    if (stems.has(entry.stem)) throw new Error(`duplicate golden stem: ${entry.stem}`);
    stems.add(entry.stem);
  }
  return entries.sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0));
}

/** Where the goldens live. */
export const STATS_GOLDEN_DIR = fileURLToPath(
  new URL('../../fixtures/golden/stats/', import.meta.url),
);

/** Where the R8 session fixtures live. */
export const SYNTHETIC_STATS_DIR = fileURLToPath(
  new URL('../../fixtures/synthetic-stats/', import.meta.url),
);
