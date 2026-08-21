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
 *   3. The DoD's own 100 ms is NOT enforced by default, because it is not met
 *      (medians of 235-555 ms across the runs on record; see `budgets.ts`
 *      and `evidence/perf-full.json`). It is recorded as data and enforced
 *      on demand with `AGENT_DECK_PERF_ASSERT=1`. A known-red test in the
 *      default suite would be worse than a flaky one.
 *
 * KNOBS:
 *   AGENT_DECK_PERF_ROOT=<projects root>   measure a supplied corpus
 *   AGENT_DECK_PERF_ASSERT=1               enforce every budget, DoD included
 *   AGENT_DECK_PERF_FULL=1                 longer runs (evidence-grade counts)
 *   AGENT_DECK_PERF_RECORD=<path>          write the measurements as JSON
 *
 * WRITES: only under an OS temp directory made by `makeWorkDir()`, plus the
 * one path `AGENT_DECK_PERF_RECORD` explicitly names. Nothing under
 * `~/.claude` is opened at all -- `corpus.ts` never uses
 * `resolveProjectsRoot()`'s home fallback.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

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
  TIMING_BUDGETS,
} from './budgets.js';
import type { TimingBudget } from './budgets.js';
import { idsTouched, measureHeap, measurePostAppend, resolveGc } from './measure.js';
import type { HeapResult, PostAppendResult, Stats } from './measure.js';

const FULL = process.env['AGENT_DECK_PERF_FULL'] === '1';
const ASSERT_ALL = process.env['AGENT_DECK_PERF_ASSERT'] === '1';
const RECORD_TO = process.env['AGENT_DECK_PERF_RECORD'];

/**
 * Sample counts, and what they cost. MEASURED, because the first draft of this
 * comment guessed and was wrong by 2.7x: the suite WITHOUT this file is 9.19 s
 * over 28 files / 919 tests, and WITH it 40.4-41.2 s over 29 / 937. So the
 * default counts add ~31 s, not the ~12 s once claimed here.
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

function statFor(budget: TimingBudget): number {
  const stage = (
    {
      total: postAppend.total,
      tailPoll: postAppend.tailPoll,
      graft: postAppend.graft,
      apply: postAppend.apply,
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

  it('the re-graft read the WHOLE session (this is why the DoD budget is missed)', () => {
    // Pinned deliberately. `src/extension.ts` re-grafts the whole session on
    // every append because a tree built from tail lines would be content
    // accepted before the layout was asserted -- the partial tree G3 forbids.
    // That decision is ~95% of the total in every run on record (315.9 of
    // 332.3 ms at full counts), so it is asserted here
    // rather than left as a claim in a comment: if someone makes the graft
    // incremental, this test fails and the budget numbers get revisited.
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
        // The DoD's 100 ms lands here today. Not skipped and not silently
        // passing: the verdict is printed by `report()` above and written into
        // `EVIDENCE.md`. What IS asserted is that the table still describes
        // reality -- an unenforced budget must be one that is genuinely not
        // met, or it should have been enforced.
        expect(budget.source).toBe('dod');
        expect(budget.measured.valueMs).toBeGreaterThan(budget.limitMs);
        return;
      }
      expect(value).toBeLessThanOrEqual(budget.limitMs);
    });
  }
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
