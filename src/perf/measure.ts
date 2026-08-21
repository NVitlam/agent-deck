/**
 * The two numbers PLAN's Phase 4 DoD item 2 names, measured through the
 * production path.
 *
 * >   **Perf harvest:** an extended R2 run producing a >=10k-line session;
 * >   post-append tree update < 100 ms; memory bounded (heap evidence
 * >   committed)
 *
 * WHAT "THE PRODUCTION PATH" MEANS HERE, precisely, because a benchmark that
 * measures something adjacent is worse than no benchmark. `src/extension.ts`
 * reacts to an append like this, and so does {@link measurePostAppend}:
 *
 *   1. `SessionTailer.poll()` -- discovery sweep plus a byte-offset read of
 *      every tracked file. Its lines are a CHANGE SIGNAL, not content:
 *      `#onBatch` uses them only to mark a session dirty.
 *   2. `graftSession(mainTranscript)` -- fingerprint the whole session, read
 *      every transcript, parse, redact, hydrate `tool-results/`, graft.
 *      `#graft` calls exactly this, with `previewBytes` from settings.
 *   3. `SessionModel.ingestGraftResult` then `SessionModel.emit()` -- the
 *      snapshot/diff that produces the `SessionPatch` the webview receives.
 *
 * Step 2 is a WHOLE-SESSION re-read on every append, and that is not an
 * oversight in this file: `extension.ts` documents why ("grafting incrementally
 * from tail lines would mean accepting content before the layout was asserted,
 * which is exactly the partial tree G3 forbids"). Measuring the incremental
 * steps alone would report a number the product does not have. The stages are
 * timed separately so the total is attributable rather than merely large.
 *
 * NOTHING HERE IS A MICROBENCHMARK OF A PURE FUNCTION. Every sample runs
 * against a real file on disk that a real append just grew.
 */

import { appendFile } from 'node:fs/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { graftSession } from '../model/graft.js';
import { LivenessEngine } from '../model/liveness.js';
import { SessionModel } from '../model/session.js';
import { SessionTailer } from '../parser/tailer.js';
import type { SessionPatch, TreeOp } from '../model/events.js';
import type { PerfCorpus } from './corpus.js';
import { planAppends, readTemplates } from './append.js';
import type { AppendPlan } from './append.js';

/** The shipped `agentDeck.previewBytes` default. Measure what users run. */
export const SHIPPED_PREVIEW_BYTES = 8192;

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Order statistics over a sample.
 *
 * A single timing is not a measurement on a loaded machine, so nothing in this
 * module ever asserts on one. `median` and `trimmedMean` are what the budgets
 * are compared against; `max` is recorded so a tail that has moved is visible
 * rather than averaged away.
 */
export interface Stats {
  n: number;
  min: number;
  median: number;
  /** Mean after discarding the lowest and highest 10% (at least one each). */
  trimmedMean: number;
  p90: number;
  max: number;
}

export function stats(samples: readonly number[]): Stats {
  if (samples.length === 0) {
    throw new Error('stats: refusing to summarise an empty sample');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const at = (i: number): number => sorted[Math.min(Math.max(i, 0), n - 1)] as number;

  const cut = n >= 5 ? Math.max(1, Math.floor(n * 0.1)) : 0;
  const kept = sorted.slice(cut, n - cut);
  const body = kept.length > 0 ? kept : sorted;
  const trimmedMean = body.reduce((a, b) => a + b, 0) / body.length;

  const median = n % 2 === 1 ? at((n - 1) / 2) : (at(n / 2 - 1) + at(n / 2)) / 2;

  return {
    n,
    min: at(0),
    median,
    trimmedMean,
    p90: at(Math.ceil(n * 0.9) - 1),
    max: at(n - 1),
  };
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

/** The host-side objects `extension.ts` wires together, minus `vscode`. */
interface Rig {
  tailer: SessionTailer;
  model: SessionModel;
  plans: AppendPlan[];
}

/**
 * A fixed instant. Liveness moves with the clock, and a session whose liveness
 * flipped mid-run would put a `fields.liveness` change into the diff and make
 * one sample's patch bigger than its neighbours' for a reason that has nothing
 * to do with the append.
 */
const FIXED_NOW = 1_700_000_000_000;

async function buildRig(
  corpus: PerfCorpus,
  transcriptText: string,
  appendCount: number,
  previewBytes: number,
): Promise<Rig> {
  const tailer = new SessionTailer({
    workspacePath: corpus.workspacePath,
    projectsRoot: corpus.projectsRoot,
  });
  const model = new SessionModel({
    workspacePath: corpus.workspacePath,
    liveness: new LivenessEngine({ now: () => FIXED_NOW }),
    previewBytes,
  });

  // The state the extension is in after `#start()`: everything discovered,
  // every session grafted once, one emission taken so the diff baseline
  // exists. Without this baseline the first sample would be an `added`
  // session with no patch at all, and would measure a different thing.
  await tailer.poll();
  model.registerSession({ sessionId: corpus.sessionId, projectSlug: corpus.slug });
  model.ingestGraftResult(
    corpus.sessionId,
    corpus.slug,
    await graftSession(corpus.mainTranscript, { previewBytes }),
  );
  model.emit();

  return { tailer, model, plans: planAppends(readTemplates(transcriptText), appendCount) };
}

// ---------------------------------------------------------------------------
// Post-append tree update
// ---------------------------------------------------------------------------

export interface PostAppendSample {
  /** Wall-clock ms from "the line is on disk" to "the patch exists". */
  total: number;
  /** `SessionTailer.poll()`: discovery sweep + byte-offset reads. */
  tailPoll: number;
  /** `graftSession()`: fingerprint + whole-session read + parse + redact + graft. */
  graft: number;
  /** `ingestGraftResult()` + `emit()`: snapshot, diff, baseline advance. */
  apply: number;
  /** The plan that produced it. */
  kind: AppendPlan['kind'];
  /** `undefined` when the append produced no patch -- a vacuous sample. */
  patch?: SessionPatch;
  /** UTF-8 bytes this cycle appended to the transcript. */
  appendedBytes: number;
  /**
   * Bytes `SessionTailer.poll()` read this cycle, from its own cumulative
   * diagnostics. Equal to `appendedBytes` when the tail is genuinely
   * incremental, and equal to the whole file when it is not -- a
   * machine-load-proof statement of the property the wall clock only hints at.
   */
  bytesRead: number;
  /** Lines `graftSession` parsed this cycle. Whole-session, by design. */
  parsedLines: number;
}

export interface PostAppendResult {
  samples: PostAppendSample[];
  total: Stats;
  tailPoll: Stats;
  graft: Stats;
  apply: Stats;
  /** Samples that produced a `SessionPatch`. Must equal `samples.length`. */
  patched: number;
  /** Tree ops seen across every patch, by `op`. The anti-vacuity evidence. */
  opCounts: Record<string, number>;
  /** Refusals from `graftSession`. Must stay 0; a refused session has no tree. */
  refusals: number;
  previewBytes: number;
  /**
   * The last emitted `SessionState` for the measured session, as JSON.
   *
   * Carried out so G4 can be asserted against what this path actually
   * produced. A patch after the baseline carries only deltas, so grepping the
   * patches alone would let a signature sitting in an untouched node pass.
   */
  finalStateJson: string;
}

export interface PostAppendOptions {
  /** Cycles whose timings are discarded. JIT warm-up, not measurement. */
  warmups?: number;
  /** Timed cycles. */
  samples?: number;
  previewBytes?: number;
}

export async function measurePostAppend(
  corpus: PerfCorpus,
  transcriptText: string,
  options: PostAppendOptions = {},
): Promise<PostAppendResult> {
  const warmups = options.warmups ?? 3;
  const sampleCount = options.samples ?? 15;
  const previewBytes = options.previewBytes ?? SHIPPED_PREVIEW_BYTES;
  const rig = await buildRig(corpus, transcriptText, warmups + sampleCount, previewBytes);

  const samples: PostAppendSample[] = [];
  const opCounts: Record<string, number> = {};
  let refusals = 0;
  let patched = 0;
  let bytesReadBefore = rig.tailer.diagnostics.bytesRead;
  let finalStateJson = '';

  for (let i = 0; i < warmups + sampleCount; i += 1) {
    const plan = rig.plans[i];
    if (plan === undefined) throw new Error(`no append plan at index ${String(i)}`);

    // The append itself is NOT inside the timed region. Writing the line is
    // the thing being reacted to, not part of the reaction; including it would
    // fold the disk's write latency into a number about our own code.
    const line = `${plan.text}\n`;
    await appendFile(corpus.mainTranscript, line, 'utf8');

    const t0 = performance.now();
    await rig.tailer.poll();
    const t1 = performance.now();
    const grafted = await graftSession(corpus.mainTranscript, { previewBytes });
    const t2 = performance.now();
    rig.model.ingestGraftResult(corpus.sessionId, corpus.slug, grafted);
    const emission = rig.model.emit();
    const t3 = performance.now();

    if (!grafted.ok) refusals += 1;
    const patch = emission.diffs.find((d) => d.sessionId === corpus.sessionId)?.patch;
    const bytesReadAfter = rig.tailer.diagnostics.bytesRead;
    const bytesRead = bytesReadAfter - bytesReadBefore;
    bytesReadBefore = bytesReadAfter;
    const state = emission.sessions.find((s) => s.sessionId === corpus.sessionId);
    if (state !== undefined) finalStateJson = JSON.stringify(state);

    if (i < warmups) continue;

    const sample: PostAppendSample = {
      total: t3 - t0,
      tailPoll: t1 - t0,
      graft: t2 - t1,
      apply: t3 - t2,
      kind: plan.kind,
      appendedBytes: Buffer.byteLength(line, 'utf8'),
      bytesRead,
      parsedLines: grafted.diagnostics.parsedLines,
    };
    if (patch !== undefined) {
      sample.patch = patch;
      patched += 1;
      for (const op of patch.tree ?? []) {
        opCounts[op.op] = (opCounts[op.op] ?? 0) + 1;
      }
    }
    samples.push(sample);
  }

  return {
    samples,
    total: stats(samples.map((s) => s.total)),
    tailPoll: stats(samples.map((s) => s.tailPoll)),
    graft: stats(samples.map((s) => s.graft)),
    apply: stats(samples.map((s) => s.apply)),
    patched,
    opCounts,
    refusals,
    previewBytes,
    finalStateJson,
  };
}

/** Ids named by the ops in a patch, for the anti-vacuity assertions. */
export function idsTouched(patch: SessionPatch | undefined): string[] {
  const out: string[] = [];
  const visit = (op: TreeOp): void => {
    switch (op.op) {
      case 'replaceRoot':
      case 'insertNode':
        out.push(op.node.id);
        break;
      case 'replaceNode':
        out.push(op.id, op.node.id);
        break;
      case 'removeNode':
      case 'updateAgent':
      case 'updateTool':
        out.push(op.id);
        break;
      case 'reorderChildren':
        out.push(...op.order);
        break;
    }
  };
  for (const op of patch?.tree ?? []) visit(op);
  return out;
}

// ---------------------------------------------------------------------------
// Bounded heap
// ---------------------------------------------------------------------------

/**
 * `global.gc`, obtained without requiring `--expose-gc` on the command line.
 *
 * The vitest config is not this package's to edit, and a heap number sampled
 * without a collection measures allocation noise rather than retention: an
 * uncollected cycle's garbage is indistinguishable from a leak. `v8.setFlags`
 * + a fresh vm context is the documented way to reach the collector from
 * inside an already-running process.
 *
 * `undefined` when it cannot be reached, and the caller degrades rather than
 * fails: a heap sample without GC is still evidence of shape, just noisier.
 * The flag is turned back off immediately so nothing else in the process sees
 * a `gc` it did not ask for.
 */
export function resolveGc(): (() => void) | undefined {
  const direct = (globalThis as { gc?: unknown }).gc;
  if (typeof direct === 'function') return direct as () => void;
  try {
    setFlagsFromString('--expose-gc');
    const fn: unknown = runInNewContext('gc');
    setFlagsFromString('--no-expose-gc');
    if (typeof fn === 'function') return fn as () => void;
  } catch {
    return undefined;
  }
  return undefined;
}

export interface HeapSample {
  cycle: number;
  heapUsed: number;
  rss: number;
}

export interface HeapResult {
  samples: HeapSample[];
  /** True when a real collection ran before each sample. */
  gcForced: boolean;
  /** Cycles discarded before the windows are cut. */
  warmups: number;
  /** Trimmed-mean heapUsed of the first half of the measured cycles, bytes. */
  firstWindowBytes: number;
  /** ...and of the last half. Reported, not asserted -- see HEAP_FLOOR_RATIO_LIMIT. */
  lastWindowBytes: number;
  /** `lastWindowBytes / firstWindowBytes`. 1.0 is a flat plateau. */
  growthRatio: number;
  /** Minimum post-GC heapUsed in the first half. The retained set. */
  firstFloorBytes: number;
  /** ...and in the last half. */
  lastFloorBytes: number;
  /** `lastFloorBytes / firstFloorBytes`. This is what the suite asserts on. */
  floorRatio: number;
  /** Bytes the transcript grew during the run, for attributing any climb. */
  corpusGrowthBytes: number;
  /** ...as a fraction of the transcript's size before the run. */
  corpusGrowthFraction: number;
}

export interface HeapOptions {
  cycles?: number;
  warmups?: number;
  previewBytes?: number;
}

/**
 * Drive a long append stream and watch the heap's SHAPE.
 *
 * "Bounded" is a claim about growth, not about size, so this returns a ratio
 * between two windows rather than an absolute byte count. An absolute ceiling
 * would be a machine and V8-version pin dressed up as a budget.
 *
 * The confound is stated rather than ignored: every cycle appends a line, so
 * the corpus and the tree really do grow during the run. `corpusGrowthFraction`
 * quantifies exactly how much, so a reader can tell a leak from the data the
 * run itself added. On the synthetic corpus that fraction is well under 1%.
 */
export async function measureHeap(
  corpus: PerfCorpus,
  transcriptText: string,
  options: HeapOptions = {},
): Promise<HeapResult> {
  const cycles = options.cycles ?? 40;
  const warmups = options.warmups ?? 4;
  const previewBytes = options.previewBytes ?? SHIPPED_PREVIEW_BYTES;
  const gc = resolveGc();
  const rig = await buildRig(corpus, transcriptText, cycles, previewBytes);

  const samples: HeapSample[] = [];
  let appendedBytes = 0;

  for (let i = 0; i < cycles; i += 1) {
    const plan = rig.plans[i];
    if (plan === undefined) throw new Error(`no append plan at index ${String(i)}`);
    const line = `${plan.text}\n`;
    appendedBytes += Buffer.byteLength(line, 'utf8');
    await appendFile(corpus.mainTranscript, line, 'utf8');

    await rig.tailer.poll();
    const grafted = await graftSession(corpus.mainTranscript, { previewBytes });
    rig.model.ingestGraftResult(corpus.sessionId, corpus.slug, grafted);
    rig.model.emit();

    if (gc !== undefined) {
      // Twice: the first pass can resurrect nothing but does let finalizers
      // run, and a single collection routinely leaves a sawtooth that reads
      // as growth over a short window.
      gc();
      gc();
    }
    const usage = process.memoryUsage();
    samples.push({ cycle: i, heapUsed: usage.heapUsed, rss: usage.rss });
  }

  const measured = samples.slice(warmups);
  if (measured.length < 4) {
    throw new Error(
      `measureHeap: ${String(measured.length)} cycles after warm-up is too few to compare windows`,
    );
  }
  const half = Math.floor(measured.length / 2);
  const first = stats(measured.slice(0, half).map((s) => s.heapUsed));
  const last = stats(measured.slice(measured.length - half).map((s) => s.heapUsed));

  return {
    samples,
    gcForced: gc !== undefined,
    warmups,
    firstWindowBytes: first.trimmedMean,
    lastWindowBytes: last.trimmedMean,
    growthRatio: last.trimmedMean / first.trimmedMean,
    firstFloorBytes: first.min,
    lastFloorBytes: last.min,
    floorRatio: last.min / first.min,
    corpusGrowthBytes: appendedBytes,
    corpusGrowthFraction: appendedBytes / corpus.mainBytes,
  };
}
