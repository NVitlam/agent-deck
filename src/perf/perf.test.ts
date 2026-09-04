/**
 * PLAN Phase 4, DoD item 2 -- the harness half.
 *
 * >   **Perf harvest:** an extended R2 run producing a >=10k-line session;
 * >   post-append tree update < 100 ms; memory bounded (heap evidence
 * >   committed)
 *
 * THE HARVEST HALF IS NOT HERE AND IS NOT CLAIMED. PLAN answers "where does
 * the >=10k-line session come from?" with "a live extended R2 run, harvested
 * -- not synthesised", and refuses to let a programmatically amplified
 * transcript count. Until that run happens this file measures the SYNTHETIC
 * corpus, which is calibration scaffolding: it makes the harness runnable and
 * threshold-asserted now, and it drops out the moment `AGENT_DECK_PERF_ROOT`
 * points at the real thing. Every number this file prints carries the corpus
 * origin next to it for exactly that reason.
 *
 * HOW THIS FILE AVOIDS BEING A FLAKY TEST. Three rules:
 *
 *   1. No assertion is ever made on a single timing. Every wall-clock budget
 *      is compared against a median over >=7 samples, and the budgets and
 *      their margins live in `budgets.ts` with the measurements they came
 *      from.
 *   2. The assertions with real teeth are NOT wall-clock at all. "The tail is
 *      incremental" is asserted against `TailDiagnostics.bytesRead`; "the
 *      re-graft is whole-session" against `ParseDiagnostics.parsedLines`;
 *      "the update is not vacuous" against the ops in the emitted patch. None
 *      of those can be perturbed by a loaded machine.
 *   3. Every budget in the table is enforced by default, and each one's margin
 *      is justified from the measurements recorded beside it in `budgets.ts`.
 *      That is a change made in Wave 0 of Phase 4.5: the DoD's 100 ms used to
 *      sit here unenforced against the post-append TOTAL, which it has never
 *      met (medians of 235-555 ms across the runs on record). The user
 *      re-scoped it -- the same 100 ms now bounds the INCREMENTAL stages,
 *      which do meet it -- and `budgets.ts`'s `RESCOPED_DOD_TOTAL` keeps the
 *      original number, what it measured and why it is unmet. A known-red
 *      test in the default suite would be worse than a flaky one; a re-scope
 *      that quietly deleted the red number would be worse than both, so the
 *      last test in "timing budgets" asserts the record is still there and
 *      still describes reality.
 *
 * KNOBS:
 *   AGENT_DECK_PERF_ROOT=<projects root>   measure a supplied corpus
 *   AGENT_DECK_PERF_ASSERT=1               force-enforce every budget (no-op
 *                                          today: all four already are)
 *   AGENT_DECK_PERF_FULL=1                 longer runs (evidence-grade counts)
 *   AGENT_DECK_PERF_RECORD=<path>          write the measurements as JSON
 *
 * WRITES: only under an OS temp directory made by `makeWorkDir()`, plus the
 * one path `AGENT_DECK_PERF_RECORD` explicitly names. Nothing under
 * `~/.claude` is opened at all -- `corpus.ts` never uses
 * `resolveProjectsRoot()`'s home fallback.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MIN_SESSION_LINES,
  generateSyntheticCorpus,
  makeWorkDir,
  openPerfCorpus,
  removeWorkDir,
} from './corpus.js';
import type { PerfCorpus } from './corpus.js';
import {
  CORPUS_GROWTH_FRACTION_LIMIT,
  HEAP_FLOOR_RATIO_LIMIT,
  CODEX_ENGINE_READ_BUDGET,
  REAL_CORPUS_GRAFT_BUDGET,
  RESCOPED_DOD_TOTAL,
  TIMING_BUDGETS,
} from './budgets.js';
import { readCodexEngine } from '../codex/index.js';
import { graftSession } from '../model/graft.js';
import { isAgentNode } from '../model/events.js';
import type { TreeNode } from '../model/events.js';
import type { TimingBudget } from './budgets.js';
import { idsTouched, measureHeap, measurePostAppend, resolveGc, stats } from './measure.js';
import type { HeapResult, PostAppendResult, Stats } from './measure.js';

const FULL = process.env['AGENT_DECK_PERF_FULL'] === '1';
const ASSERT_ALL = process.env['AGENT_DECK_PERF_ASSERT'] === '1';
const RECORD_TO = process.env['AGENT_DECK_PERF_RECORD'];

/**
 * Sample counts, and what they cost. MEASURED over repeated runs, because the
 * first draft of this comment guessed and was wrong by 2.7x: the suite WITHOUT
 * this file ran 6.5-35.9 s over 28 files / 919 tests (n=5), and WITH it
 * 37.2-41.9 s over 29 / 937 (n=7). So the default counts add ~29-33 s, not the
 * ~12 s once claimed here. Ranges rather than point values on purpose -- the
 * exclude-perf figure spans 5.5x on machine state alone, and a file arguing
 * that single wall-clock samples are not properties of the code should not
 * quote one.
 *
 * PAST TENSE ON PURPOSE: those file/test counts are what the timings were taken
 * with on 2026-08-21 and are no longer current -- Phase 4.5's Wave 0 took this
 * file from 18 tests to 21 and `src/extension.test.ts` from 51 to 55, without
 * re-timing the whole suite. The three tests added here are constant-time table
 * assertions costing ~14 ms; the wall-clock shape below is unaffected.
 *
 * Worse, they add it to the CRITICAL PATH. This file is ~41 s of serial work
 * and vitest runs files in parallel threads, so the whole suite's wall time is
 * now essentially this one file's. Each post-append cycle costs ~330 ms and
 * nothing here is parallelisable -- that is the price of measuring the real
 * path against a 17 MB session, and it is stated rather than discovered by
 * whoever next wonders why the suite got four times slower.
 *
 * `EVIDENCE.md` and `evidence/perf-full.json` were taken with
 * `AGENT_DECK_PERF_FULL=1`, which is where the larger counts matter.
 */
const COUNTS = FULL
  ? { warmups: 3, samples: 15, heapCycles: 40, heapWarmups: 4 }
  : { warmups: 2, samples: 7, heapCycles: 14, heapWarmups: 2 };

/** One suite-wide corpus and two measurements; both are minutes-scale in FULL. */
const SETUP_TIMEOUT = 600_000;
const TEST_TIMEOUT = 600_000;

let workDir: string;
let corpus: PerfCorpus;
let transcriptText: string;
let postAppend: PostAppendResult;
let heap: HeapResult;

beforeAll(async () => {
  workDir = await makeWorkDir();
  corpus = await openPerfCorpus({ workDir });
  // Already in hand: `openPerfCorpus` read every candidate transcript to find
  // the largest. Re-reading 17 MB to get the same string back costs ~300 ms.
  transcriptText = corpus.mainText;

  // Ordered: post-append first, then heap. Both append to the same staged
  // transcript, which is fine -- each builds its own rig and takes its own
  // baseline emission, so neither inherits the other's diff state.
  postAppend = await measurePostAppend(corpus, transcriptText, {
    warmups: COUNTS.warmups,
    samples: COUNTS.samples,
  });
  heap = await measureHeap(corpus, transcriptText, {
    cycles: COUNTS.heapCycles,
    warmups: COUNTS.heapWarmups,
  });

  report();
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (RECORD_TO !== undefined && RECORD_TO !== '') await record(RECORD_TO);
  if (workDir !== undefined) await removeWorkDir(workDir);
}, SETUP_TIMEOUT);

function ms(value: number): string {
  return value.toFixed(1);
}

function line(label: string, s: Stats): string {
  return `${label}: median ${ms(s.median)} tmean ${ms(s.trimmedMean)} p90 ${ms(s.p90)} min ${ms(
    s.min,
  )} max ${ms(s.max)} (n=${String(s.n)})`;
}

/**
 * Print everything measured, always.
 *
 * A perf suite whose numbers only appear when it fails is a perf suite nobody
 * reads. The origin is on the first line so a number can never be quoted
 * without it.
 */
function report(): void {
  const out = [
    `[perf] corpus origin=${corpus.origin} lines=${String(corpus.mainLines)} bytes=${String(
      corpus.mainBytes,
    )} session=${corpus.sessionId}`,
    `[perf] source=${corpus.sourceRoot}`,
    `[perf] ${line('postAppend.total', postAppend.total)}`,
    `[perf] ${line('  .tailPoll     ', postAppend.tailPoll)}`,
    `[perf] ${line('  .graft        ', postAppend.graft)}`,
    `[perf] ${line('  .apply        ', postAppend.apply)}`,
    `[perf] ${line('  .incremental  ', incrementalStats())}`,
    `[perf] patched ${String(postAppend.patched)}/${String(
      postAppend.samples.length,
    )} refusals ${String(postAppend.refusals)} ops ${JSON.stringify(postAppend.opCounts)}`,
    `[perf] heap gcForced=${String(heap.gcForced)} floor ${(heap.firstFloorBytes / 1e6).toFixed(
      2,
    )}MB -> ${(heap.lastFloorBytes / 1e6).toFixed(2)}MB ratio ${heap.floorRatio.toFixed(4)} ` +
      `| trimmed-mean ratio ${heap.growthRatio.toFixed(4)} | corpus grew ${(
        heap.corpusGrowthFraction * 100
      ).toFixed(3)}%`,
  ];
  for (const budget of TIMING_BUDGETS) {
    const value = statFor(budget);
    const verdict = value <= budget.limitMs ? 'MET' : 'NOT MET';
    out.push(
      `[perf] budget ${budget.id} (${budget.source}, ${
        budget.enforced || ASSERT_ALL ? 'enforced' : 'recorded'
      }): ${ms(value)} vs ${String(budget.limitMs)} ms -> ${verdict}`,
    );
  }
  console.log(out.join('\n'));
}

/**
 * The genuinely incremental half of a post-append update: read the appended
 * bytes, apply the resulting patch. Everything except the deliberate
 * whole-session re-graft.
 *
 * SUMMED PER SAMPLE, then summarised -- not `tailPoll.median + apply.median`,
 * which is a different and smaller quantity whenever the two stages' slow
 * cycles do not coincide. This is the series `postAppend.incremental.dod` is
 * compared against, so how it is built is part of the budget.
 *
 * Derived here rather than in `measure.ts` because this package owns the
 * budget table and the assertions; `measure.ts` records the raw stages and is
 * not this wave's to change.
 */
function incrementalStats(): Stats {
  return stats(postAppend.samples.map((s) => s.tailPoll + s.apply));
}

function statFor(budget: TimingBudget): number {
  const stage = (
    {
      total: postAppend.total,
      tailPoll: postAppend.tailPoll,
      graft: postAppend.graft,
      apply: postAppend.apply,
      incremental: incrementalStats(),
    } as Record<string, Stats | undefined>
  )[budget.what];
  if (stage === undefined) throw new Error(`budget ${budget.id} names unknown stage ${budget.what}`);
  return budget.statistic === 'median' ? stage.median : stage.trimmedMean;
}

async function record(target: string): Promise<void> {
  const path = resolve(target);
  await mkdir(dirname(path), { recursive: true });
  const payload = {
    // Stated first and unconditionally, so a recorded file can never be read
    // as the DoD's harvest by someone skimming it.
    corpusOrigin: corpus.origin,
    isDodHarvest: corpus.origin === 'supplied',
    corpus: {
      sessionId: corpus.sessionId,
      slug: corpus.slug,
      lines: corpus.mainLines,
      bytes: corpus.mainBytes,
      source: corpus.sourceRoot,
    },
    counts: COUNTS,
    postAppend: {
      total: postAppend.total,
      tailPoll: postAppend.tailPoll,
      graft: postAppend.graft,
      apply: postAppend.apply,
      // The derived series `postAppend.incremental.dod` is compared against.
      // Written out so the budget's value is re-derivable from the record
      // rather than taken on trust.
      incremental: incrementalStats(),
      patched: postAppend.patched,
      samples: postAppend.samples.length,
      refusals: postAppend.refusals,
      opCounts: postAppend.opCounts,
      previewBytes: postAppend.previewBytes,
    },
    heap: {
      gcForced: heap.gcForced,
      firstFloorBytes: heap.firstFloorBytes,
      lastFloorBytes: heap.lastFloorBytes,
      floorRatio: heap.floorRatio,
      firstWindowBytes: heap.firstWindowBytes,
      lastWindowBytes: heap.lastWindowBytes,
      growthRatio: heap.growthRatio,
      corpusGrowthBytes: heap.corpusGrowthBytes,
      corpusGrowthFraction: heap.corpusGrowthFraction,
      heapUsedSeries: heap.samples.map((s) => s.heapUsed),
      rssSeries: heap.samples.map((s) => s.rss),
    },
    budgets: TIMING_BUDGETS.map((b) => ({
      id: b.id,
      limitMs: b.limitMs,
      statistic: b.statistic,
      source: b.source,
      enforced: b.enforced,
      valueMs: statFor(b),
      met: statFor(b) <= b.limitMs,
    })),
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[perf] recorded to ${path}`);
}

// ---------------------------------------------------------------------------

describe('the corpus the harness measures', () => {
  it('is at least the DoD\'s 10k lines, and says which origin it has', () => {
    expect(corpus.mainLines).toBeGreaterThanOrEqual(MIN_SESSION_LINES);
    expect(corpus.mainBytes).toBeGreaterThan(0);
    expect(['synthetic', 'supplied']).toContain(corpus.origin);
  });

  it('names itself as synthetic on disk when it is synthetic', () => {
    if (corpus.origin !== 'synthetic') {
      // A supplied corpus is whatever the human harvested; nothing to assert
      // about its naming, and inventing a rule would refuse a real harvest.
      expect(corpus.origin).toBe('supplied');
      return;
    }
    // The `synthetic-`/SYNTHETIC marker convention this repo already uses for
    // `synthetic-graft`, `synthetic-layout` and `synthetic-hook-fuzz`. A
    // measurement quoted out of context still carries it, because the slug is
    // in every path the harness prints.
    expect(corpus.slug.toUpperCase()).toContain('SYNTHETIC');
    expect(corpus.slug.toLowerCase()).toContain('not-a-harvest');
  });

  it('is staged in a temp directory, never in the repo tree', () => {
    // `relative` from the repo root to a temp path starts with `..`; a path
    // inside the repo never would. This is the G1-adjacent guard: the harness
    // appends bytes to the transcript it measures, and it must never be
    // appending to a committed fixture or to anything under `~/.claude`.
    expect(relative(resolve('.'), corpus.projectsRoot).startsWith('..')).toBe(true);
    expect(relative(resolve('fixtures'), corpus.projectsRoot).startsWith('..')).toBe(true);
    expect(corpus.projectsRoot.startsWith(workDir)).toBe(true);
  });
});

describe('the synthetic generator', () => {
  it(
    'produces a byte-identical tree from the same arguments',
    async () => {
      // A SMALL corpus, on purpose: determinism is a property of the
      // generator's seeding, not of its size, and a second 17 MB generation
      // would cost 1.6 s to prove the same thing. Compared by digest over the
      // whole tree rather than by a pinned literal, which would rot the first
      // time the generator legitimately changes.
      const a = join(workDir, 'det-a');
      const b = join(workDir, 'det-b');
      const options = { lines: 400, subagents: 2, seed: 12_345 };
      await generateSyntheticCorpus(a, options);
      await generateSyntheticCorpus(b, options);
      // The `projects/` subtree only: `manifest.json` records the seed, so
      // including it would make the seed test below pass on the manifest alone.
      expect(await digestTree(join(a, 'projects'))).toBe(await digestTree(join(b, 'projects')));
    },
    TEST_TIMEOUT,
  );

  it(
    'changes its output when the seed changes',
    async () => {
      // Without this the previous test would pass for a generator that emitted
      // a constant, which is deterministic and useless.
      const a = join(workDir, 'seed-a');
      const b = join(workDir, 'seed-b');
      await generateSyntheticCorpus(a, { lines: 400, subagents: 2, seed: 1 });
      await generateSyntheticCorpus(b, { lines: 400, subagents: 2, seed: 2 });
      expect(await digestTree(join(a, 'projects'))).not.toBe(await digestTree(join(b, 'projects')));
    },
    TEST_TIMEOUT,
  );
});

describe('post-append tree update — what the measured path actually did', () => {
  it('produced a SessionPatch for every single append', () => {
    // The anti-vacuity guard. A benchmark that timed a no-op would be fast,
    // green, and meaningless; this is the assertion that makes the number mean
    // "the tree was updated".
    expect(postAppend.patched).toBe(postAppend.samples.length);
    expect(postAppend.samples.length).toBeGreaterThanOrEqual(7);
  });

  it('the patch names the id the append introduced', () => {
    for (const sample of postAppend.samples) {
      const ids = idsTouched(sample.patch);
      expect(ids.length).toBeGreaterThan(0);
    }
    // Both tree operations are exercised: an insert (a new tool node) and an
    // update (its result arriving). Measuring only one and reporting both
    // would be wrong in a direction nobody would notice.
    expect(postAppend.opCounts['insertNode'] ?? 0).toBeGreaterThan(0);
    expect(postAppend.opCounts['updateTool'] ?? 0).toBeGreaterThan(0);
  });

  it('never refused the session: the appended lines stay layout-valid', () => {
    // If an append broke the fingerprint, `graftSession` would refuse, the
    // tree would vanish, and the remaining cycles would be timing a refusal
    // rather than a graft -- fast, green, and measuring nothing.
    expect(postAppend.refusals).toBe(0);
  });

  it('the tailer read only the appended bytes (the incremental property)', () => {
    // Behavioural, not wall-clock: no machine load can perturb a byte count.
    // If the byte-offset tail regressed to re-reading the file, this would be
    // ~17,000,000 rather than ~500 and the timing budgets would never notice.
    for (const sample of postAppend.samples) {
      expect(sample.bytesRead).toBe(sample.appendedBytes);
      expect(sample.bytesRead).toBeLessThan(corpus.mainBytes / 100);
    }
  });

  it('the re-graft read the WHOLE session (this is why the DoD total is missed)', () => {
    // Pinned deliberately. `src/extension.ts` re-grafts the whole session on
    // every append because a tree built from tail lines would be content
    // accepted before the layout was asserted -- the partial tree G3 forbids.
    // That decision is ~95% of the total in every run on record (315.9 of
    // 332.3 ms in the committed FULL run), and it is the whole reason the DoD
    // sentence was re-scoped off the total -- see `RESCOPED_DOD_TOTAL`. So it
    // is asserted here rather than left as a claim in a comment: if someone
    // makes the graft incremental, this test fails, and the re-scope and its
    // record are what get revisited.
    for (const sample of postAppend.samples) {
      expect(sample.parsedLines).toBeGreaterThanOrEqual(corpus.mainLines);
    }
  });

  it('G4: no thinking content or signature bytes in what the path produced', () => {
    const state = postAppend.finalStateJson;
    expect(state.length).toBeGreaterThan(0);

    // CC's thinking blocks are EMPTY on disk and the `signature` carries the
    // bytes, so asserting that thinking TEXT does not leak is vacuous. The
    // signatures are read out of the corpus at measurement time; pinning a
    // literal here would rot on the next harvest.
    const signatures: string[] = [];
    for (const match of transcriptText.matchAll(/"signature":"([^"\\]{40,})"/g)) {
      const value = match[1];
      if (value !== undefined) signatures.push(value);
    }
    if (corpus.origin === 'synthetic') {
      // The generator emits them, so a zero here means the corpus stopped
      // exercising the redaction boundary and this test went quietly vacuous.
      expect(signatures.length).toBeGreaterThan(0);
    }
    for (const signature of signatures) {
      expect(state).not.toContain(signature.slice(0, 64));
    }
    expect(state).not.toContain('"signature"');
    expect(state).not.toContain('"thinking"');
  });
});

describe('timing budgets', () => {
  for (const budget of TIMING_BUDGETS) {
    const enforced = budget.enforced || ASSERT_ALL;
    it(`${budget.id} ${enforced ? 'holds' : 'is recorded (not enforced)'}`, () => {
      const value = statFor(budget);
      expect(Number.isFinite(value)).toBe(true);
      if (!enforced) {
        // Nothing lands here today -- all four budgets are enforced. The
        // branch stays because the table permits `enforced: false`, and if
        // anyone uses it the rule is the one that held for the old
        // `postAppend.total.dod`: an unenforced budget must be one that is
        // genuinely not met, or it should have been enforced.
        expect(budget.measured.valueMs).toBeGreaterThan(budget.limitMs);
        return;
      }
      expect(value).toBeLessThanOrEqual(budget.limitMs);
    });
  }

  it('every budget carries the measurement and margin it was set from', () => {
    // The table's own integrity, asserted on constants only -- no wall clock,
    // so this cannot flake. The failure it catches is a budget whose stated
    // margin has drifted from its stated measurement, which is how a threshold
    // silently becomes "a round number someone typed".
    expect(TIMING_BUDGETS.length).toBeGreaterThan(0);
    for (const budget of TIMING_BUDGETS) {
      expect(budget.measured.on).not.toBe('');
      expect(budget.measured.note.length).toBeGreaterThan(40);
      expect(budget.measured.valueMs).toBeGreaterThan(0);
      const stated = budget.limitMs / budget.measured.valueMs;
      // Two significant figures is how the margins are written down.
      expect(budget.measured.marginX).toBeCloseTo(stated, 1);
      if (budget.enforced) {
        // An enforced budget must be one its own recorded measurement passes.
        expect(budget.measured.valueMs).toBeLessThanOrEqual(budget.limitMs);
      }
    }
  });

  it('the DoD number that was re-scoped is still on the record, and still red', () => {
    // Wave 0 of Phase 4.5 replaced `postAppend.total.dod` with
    // `postAppend.incremental.dod`. The whole justification for doing that
    // rather than deleting a red budget is that the original number stays
    // legible, so this asserts it does. Constants only -- the wall-clock claim
    // is pinned behaviourally by the `parsedLines` test above instead.
    expect(RESCOPED_DOD_TOTAL.originalLimitMs).toBe(100);
    expect(RESCOPED_DOD_TOTAL.originalWhat).toBe('total');
    expect(RESCOPED_DOD_TOTAL.observedMedianMs.length).toBeGreaterThanOrEqual(4);
    for (const median of RESCOPED_DOD_TOTAL.observedMedianMs) {
      // Every run on record missed it. If one ever does not, this record is
      // the thing that needs rewriting -- loudly.
      expect(median).toBeGreaterThan(RESCOPED_DOD_TOTAL.originalLimitMs);
    }
    // The number that replaced it is the SAME number, applied to the stages
    // the DoD sentence was reaching for. A re-scope that also moved the
    // literal would be a different decision than the one that was taken.
    const rescoped = TIMING_BUDGETS.find((b) => b.source === 'dod');
    expect(rescoped?.id).toBe('postAppend.incremental.dod');
    expect(rescoped?.limitMs).toBe(RESCOPED_DOD_TOTAL.originalLimitMs);
    expect(rescoped?.enforced).toBe(true);
    expect(rescoped?.what).toBe('incremental');
  });

  it('the incremental series is the per-sample sum, not a sum of medians', () => {
    // How the series is built is part of the budget: summing the two stage
    // medians would understate the quantity whenever their slow cycles do not
    // coincide, and would make the budget easier to pass than it claims.
    // Asserted against the samples themselves rather than against `stats`.
    const derived = incrementalStats();
    expect(derived.n).toBe(postAppend.samples.length);
    for (const sample of postAppend.samples) {
      expect(sample.tailPoll + sample.apply).toBeLessThanOrEqual(derived.max + 1e-9);
      expect(sample.tailPoll + sample.apply).toBeGreaterThanOrEqual(derived.min - 1e-9);
    }
    // And it is genuinely the total minus the re-graft, to floating-point
    // slack -- i.e. it excludes exactly the stage the re-scope excluded.
    for (const sample of postAppend.samples) {
      expect(sample.total - sample.graft).toBeCloseTo(sample.tailPoll + sample.apply, 6);
    }
  });
});

describe('memory is bounded', () => {
  it('the retained heap plateaus rather than climbing', () => {
    expect(heap.samples.length).toBe(COUNTS.heapCycles);
    // "Bounded" is a claim about growth, not size, so the assertion is a ratio
    // between the retained floors of two windows -- not an absolute byte
    // count, which would be a machine and V8-version pin dressed as a budget.
    expect(heap.floorRatio).toBeLessThanOrEqual(HEAP_FLOOR_RATIO_LIMIT);
    expect(heap.firstFloorBytes).toBeGreaterThan(0);
  });

  it('states, rather than assumes, how much of any climb the run itself caused', () => {
    // Every cycle appends a line, so the corpus and the tree really do grow
    // during the run. Bounding that confound is what lets the ratio above mean
    // "no leak" instead of "no leak, probably".
    expect(heap.corpusGrowthFraction).toBeLessThan(CORPUS_GROWTH_FRACTION_LIMIT);
    expect(heap.corpusGrowthBytes).toBeGreaterThan(0);
  });

  it('a real collection ran before each sample, or says it could not', () => {
    // Without a collection, an uncollected cycle's garbage is
    // indistinguishable from a leak. `resolveGc()` reaches the collector via
    // v8.setFlagsFromString rather than requiring `--expose-gc`, because
    // `vitest.config.ts` is not this package's to edit. Measured available on
    // this machine; if it ever is not, the number is still recorded and the
    // suite says so rather than asserting on noise.
    if (!heap.gcForced) {
      console.warn('[perf] gc unavailable: heap numbers are allocation noise, not retention');
      expect(resolveGc()).toBeUndefined();
      return;
    }
    expect(heap.gcForced).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/** SHA-256 over every file in a tree, keyed by repo-relative path. */
async function digestTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      hash.update(relative(root, full).replace(/\\/g, '/'));
      hash.update(await readFile(full));
    }
  };
  await walk(root);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// DoD 5.5.7 — the same path, on a REAL captured session
// ---------------------------------------------------------------------------

/**
 * The synthetic corpus is a tripwire; this is a check against reality.
 *
 * Every timing above is measured on `fixtures/synthetic-perf`, which is
 * GENERATED: 10,400 lines built to a shape this repo chose. That is the right
 * instrument for a regression tripwire and the wrong one for "does this hold on
 * data Claude Code actually wrote". DoD 5.5.7 asks for both, and
 * `fixtures/synthetic-dropped-actions/` is the real half — 977 lines, 3.1 MB,
 * 246 tool calls across a main transcript and two subagents, captured from the
 * eight-hour session `AUDIT-2026-08-27` section 7 was written about.
 *
 * Deliberately CHEAP — one stage, seven samples, well under a second — because
 * `perf.test.ts` is the suite's critical path and a second full post-append rig
 * would double it to re-measure three stages this file already covers.
 */
describe('DoD 5.5.7 — the real captured corpus', () => {
  // Resolved from this file rather than from a repo-root constant: `perf.test.ts`
  // has none, and adding one here would be a second definition of a path the
  // rest of the file gets from `import.meta.url`.
  const REAL_MAIN = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'fixtures',
    'synthetic-dropped-actions',
    'projects',
    'c--Users-dev-projects-agent-deck',
    '41194183-a387-4072-bb84-bc472bf7b5e9.jsonl',
  );

  let samples: number[] = [];
  let result: Awaited<ReturnType<typeof graftSession>> | undefined;

  beforeAll(async () => {
    const taken: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const t0 = performance.now();
      const r = await graftSession(REAL_MAIN, { previewBytes: 8192 });
      const dt = performance.now() - t0;
      if (i >= 2) taken.push(dt);
      result = r;
    }
    taken.sort((a, b) => a - b);
    samples = taken;
  }, 120_000);

  function medianOf(values: readonly number[]): number {
    const mid = Math.floor(values.length / 2);
    return values.length % 2 === 1
      ? (values[mid] ?? 0)
      : ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2;
  }

  it('grafts the real session inside its budget', () => {
    const value = medianOf(samples);
    process.stdout.write(
      `[perf] budget ${REAL_CORPUS_GRAFT_BUDGET.id} (${REAL_CORPUS_GRAFT_BUDGET.source}, enforced): ` +
        `${value.toFixed(1)} vs ${String(REAL_CORPUS_GRAFT_BUDGET.limitMs)} ms -> ` +
        `${value <= REAL_CORPUS_GRAFT_BUDGET.limitMs ? 'MET' : 'MISSED'}\n`,
    );
    expect(value).toBeLessThanOrEqual(REAL_CORPUS_GRAFT_BUDGET.limitMs);
  });

  it('produced the whole tree, so the timing is of real work', () => {
    // A budget met by REFUSING the session would be worthless. This is the
    // vacuity control, and it is the audit's own measurement: 246 tool calls in
    // the corpus, 246 in the tree.
    expect(result?.ok).toBe(true);
    if (result === undefined || !result.ok) throw new Error('the real corpus refused');
    let tools = 0;
    const visit = (node: TreeNode): void => {
      if (!isAgentNode(node)) {
        tools += 1;
        return;
      }
      for (const child of node.children) visit(child);
    };
    visit(result.snapshot.root);
    expect(tools).toBe(246);
  });

  it('DoD 5.5.6: the real corpus is 0 malformed and 84 ignored', () => {
    // Before 5.5.6 these eighty-four lines were counted as malformed, which
    // made a healthy CC 2.1.246 session read as 4.8% damaged. They are
    // `atis-latch`, `mode`, `file-history-delta` and `system` entries: shapes
    // this model does not read, none of them carrying a `tool_use` block.
    if (result === undefined) throw new Error('no result');
    expect(result.diagnostics.malformedLines).toBe(0);
    expect(result.diagnostics.ignoredLines).toBe(84);
    expect(result.diagnostics.parsedLines).toBe(893);
    // All three buckets account for every line of the corpus.
    expect(
      result.diagnostics.malformedLines +
        result.diagnostics.ignoredLines +
        result.diagnostics.parsedLines,
    ).toBe(977);
  });

  it("the budget records the measurement it was set from, and the DoD's conditional did not fire", () => {
    // Same rule the four budgets above follow: a limit with no recorded
    // measurement is a number someone liked.
    expect(REAL_CORPUS_GRAFT_BUDGET.measured.valueMs).toBeGreaterThan(0);
    expect(REAL_CORPUS_GRAFT_BUDGET.limitMs / REAL_CORPUS_GRAFT_BUDGET.measured.valueMs).toBeCloseTo(
      REAL_CORPUS_GRAFT_BUDGET.measured.marginX,
      0,
    );
    // 5.5.7's conditional — "if #graft's full re-read per append is what's over
    // budget, make the re-read incremental" — is gated on a MISS. Nothing
    // misses, so the incremental re-read was not built, and the whole-session
    // re-read that G3 depends on is still pinned by the test below.
    expect(medianOf(samples)).toBeLessThan(REAL_CORPUS_GRAFT_BUDGET.limitMs);
  });
});

/*
 * DoD 4.2a — the Codex engine, measured. See CODEX_ENGINE_READ_BUDGET for why
 * the subject is the committed corpus and what that does NOT establish.
 */
describe('DoD 4.2a — the Codex engine read', () => {
  const CODEX_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

  /**
   * The anchor corpus, derived rather than named: it is the one carrying a
   * `golden.json`. Selecting by that file rather than by sort order is the same
   * rule `golden.test.ts`, `graft.test.ts` and `context-window.test.ts` use —
   * a witness corpus added later must not silently become the subject.
   */
  function anchorRoots(): string[] {
    const corpus = readdirSync(CODEX_FIXTURES, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('codex-'))
      .map((e) => e.name)
      .filter((name) => existsSync(join(CODEX_FIXTURES, name, 'golden.json')))
      .sort()[0];
    if (corpus === undefined) throw new Error('no Codex anchor corpus');
    return readdirSync(join(CODEX_FIXTURES, corpus), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(CODEX_FIXTURES, corpus, e.name, 'home', '.codex'))
      .filter((p) => existsSync(p))
      .sort();
  }

  let samples: number[] = [];
  let sessionCount = 0;
  let longestLine = 0;

  beforeAll(async () => {
    const roots = anchorRoots();
    if (roots.length === 0) throw new Error('no runs in the Codex anchor corpus');

    // The stress shape this budget is really about, measured off the corpus
    // rather than written down: Codex stores tool output whole and inline.
    for (const root of roots) {
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith('.jsonl')) {
            for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
              longestLine = Math.max(longestLine, Buffer.byteLength(line, 'utf8'));
            }
          }
        }
      };
      const sessions = join(root, 'sessions');
      if (existsSync(sessions)) walk(sessions);
    }

    const taken: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const t0 = performance.now();
      let n = 0;
      for (const root of roots) {
        const outcome = await readCodexEngine({ root });
        if (outcome.kind !== 'ok') throw new Error(`engine refused ${root}: ${outcome.kind}`);
        n += outcome.result.sessions.length;
      }
      const dt = performance.now() - t0;
      if (i >= 2) taken.push(dt);
      sessionCount = n;
    }
    taken.sort((a, b) => a - b);
    samples = taken;
  }, 120_000);

  function medianOf(values: readonly number[]): number {
    const mid = Math.floor(values.length / 2);
    return values.length % 2 === 1
      ? (values[mid] ?? 0)
      : ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2;
  }

  it('the subject is real, and it carries the long line this budget is about', () => {
    // Vacuity control. A budget measured over an empty corpus is a fast zero,
    // and a fast zero passes every limit ever written.
    expect(samples.length).toBe(7);
    expect(sessionCount).toBeGreaterThan(0);
    /*
     * PINNED EXACTLY, and the reason is that the loose form let a wrong number
     * ship. `budgets.ts` and `PLAN.md` first carried "554,122 bytes", which is
     * the CHARACTER count — `line.length` — of the same line whose UTF-8 byte
     * length is 554,126. `> 500_000` was true of both, so nothing went red, and
     * `src/perf/EVIDENCE.md` had the right figure the whole time. A verifier
     * caught it by measuring both.
     *
     * The exact form is safe here for the reason a fixture-set SIZE is not: this
     * is one line of one committed transcript, and a re-harvest that changes it
     * SHOULD go red — the budget's whole subject is that line.
     */
    expect(longestLine).toBe(554_126);
  });

  it('reads the whole Codex corpus inside its budget', () => {
    const value = medianOf(samples);
    process.stdout.write(
      `[perf] budget ${CODEX_ENGINE_READ_BUDGET.id} (${CODEX_ENGINE_READ_BUDGET.source}, enforced): ` +
        `${value.toFixed(1)} vs ${String(CODEX_ENGINE_READ_BUDGET.limitMs)} ms -> ` +
        `${value <= CODEX_ENGINE_READ_BUDGET.limitMs ? 'MET' : 'MISSED'}\n`,
    );
    expect(value).toBeLessThanOrEqual(CODEX_ENGINE_READ_BUDGET.limitMs);
  });

  it('the recorded margin is the recorded numbers, divided', () => {
    // The same self-consistency check the other budgets carry: a note claiming
    // a margin the two numbers do not produce is a number written from memory.
    expect(CODEX_ENGINE_READ_BUDGET.measured.valueMs).toBeGreaterThan(0);
    expect(
      CODEX_ENGINE_READ_BUDGET.limitMs / CODEX_ENGINE_READ_BUDGET.measured.valueMs,
    ).toBeCloseTo(CODEX_ENGINE_READ_BUDGET.measured.marginX, 1);
  });
});
