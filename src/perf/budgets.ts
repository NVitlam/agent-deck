/**
 * The thresholds `perf.test.ts` asserts, and the measurements each was set
 * from.
 *
 * WHY A TABLE RATHER THAN LITERALS IN THE TEST. Every phase in this repo gates
 * on "full suite 100% pass", so a wall-clock assertion inside that suite is a
 * flaky test waiting to happen -- and a suite that randomly goes red reads as a
 * fresh regression to whoever hits it. Putting the numbers here forces each one
 * to carry the measurement it came from and the margin that was chosen, so a
 * future reader can tell "this budget is tight because the code is fast" from
 * "this budget is tight because someone typed a round number".
 *
 * EVERY BUDGET IN THE TABLE IS NOW ENFORCED. Until Wave 0 of Phase 4.5 one was
 * not: `postAppend.total.dod` carried the DoD's 100 ms against the post-append
 * TOTAL, was never met, and sat here at `enforced: false` with a note saying so.
 * The user re-scoped it on 2026-08-21 -- see {@link RESCOPED_DOD_TOTAL}, which
 * keeps the original number, what it measured and why it is unmet, because the
 * point of the re-scope is honesty rather than a green light. What replaced it
 * is `postAppend.incremental.dod`: the same 100 ms, applied to the stages the
 * DoD's sentence was actually reaching for. The literal was not softened; its
 * SCOPE changed and its enforcement went from off to on.
 *
 * ALL MEASUREMENTS BELOW were taken on the SYNTHETIC corpus (10,400 lines,
 * 17,041,245 bytes) on the Windows 11 development machine, on 2026-08-21. The
 * three `regression` entries were first set from four runs -- three via
 * `npx vitest run src/perf` in isolation, one inside the full 29-file suite --
 * and their notes now also carry the four runs the Phase 4.5 Wave 0 re-scope
 * added, NINE in total. `postAppend.incremental.dod` was set from the three of
 * those nine that measured the derived series directly, one
 * `AGENT_DECK_PERF_FULL=1` (n=15) and two at default counts (n=7). The series
 * did not exist before that wave, so the earlier runs cannot contribute to it,
 * and later runs will print medians this table does not list: what is recorded
 * here is what each limit was SET from, not a running total.
 * They are calibration, not the DoD's harvest -- see
 * `fixtures/synthetic-perf/README.md`.
 *
 * Each `measured.valueMs` is the SLOWEST value observed for that statistic, not
 * a representative one, so every margin stated here is the worst case rather
 * than a flattering one. The wall-clock numbers are machine- and state-
 * dependent and are not properties of the code; the stage RATIO -- incremental
 * work in single-digit ms, whole-session re-graft dominating -- reproduced in
 * every run and is the durable observation.
 */

export interface TimingBudget {
  id: string;
  /**
   * What is being timed. Four of the five values are `measure.ts` stage names
   * (`total`, `tailPoll`, `graft`, `apply`); `incremental` is the one derived
   * series -- `tailPoll + apply` summed PER SAMPLE, not median plus median --
   * and `perf.test.ts`'s `statFor` is where all five are resolved.
   */
  what: string;
  /** Which order statistic the budget is compared against. Never a single sample. */
  statistic: 'median' | 'trimmedMean';
  limitMs: number;
  /** `'dod'` = a number PLAN names. `'regression'` = a tripwire we chose. */
  source: 'dod' | 'regression';
  /** Asserted by the default suite. `false` = recorded and reported only. */
  enforced: boolean;
  /** The measurement the limit was set from, and the margin it leaves. */
  measured: {
    valueMs: number;
    on: string;
    /** `limitMs / valueMs`. Stated so nobody has to divide. */
    marginX: number;
    note: string;
  };
}

/**
 * The DoD number as it was originally written, and why it is not met.
 *
 * THIS IS NOT DEAD TEXT AND MUST NOT BE DELETED. PLAN's Phase 4 DoD item 2 says
 * "post-append tree update < 100 ms". Read as the TOTAL, that number has never
 * been met on any run this repo has taken, and the re-scope above does not
 * change that -- it changes which quantity carries the 100 ms, and says so out
 * loud here rather than quietly retiring a red budget. A reader who finds
 * `postAppend.incremental.dod` green is one field away from learning that the
 * post-append TOTAL is 2.3-5.6x over the same 100 ms.
 *
 * WHAT THE ORIGINAL NUMBER MEASURED: `SessionTailer.poll` + `graftSession` +
 * `ingestGraftResult` + `emit`, end to end, per appended line.
 *
 * WHY IT IS UNMET, and why that is not a defect to fix here: `src/extension.ts`
 * re-grafts the WHOLE session on every append. A tree built from tail lines
 * alone would be content accepted before the layout was asserted -- the partial
 * tree G3 forbids -- so the re-read is deliberate. `graftSession` is ~95% of the
 * total in every run on record, so the budget is missed by that architectural
 * choice and not by any one slow function. `perf.test.ts` pins the choice
 * behaviourally (`parsedLines >= mainLines`): make the graft incremental and
 * that test goes red, which is the signal to revisit this record.
 *
 * The three options were fix / accept-and-carry / re-scope. The user chose
 * re-scope on 2026-08-21. `AGENT_DECK_PERF_ASSERT=1` no longer enforces
 * anything extra -- every budget in the table is enforced by default now -- so
 * the total is checked against this record by `perf.test.ts` instead.
 */
export const RESCOPED_DOD_TOTAL = {
  /** Verbatim from PLAN's Phase 4 DoD item 2. */
  sentence: 'post-append tree update < 100 ms',
  /** What the sentence's number was read as before the re-scope. */
  originalWhat: 'total',
  originalLimitMs: 100,
  /**
   * Medians of the post-append TOTAL, in ms, from the runs on record when this
   * was written (2026-08-21). Not a running total -- later runs will print
   * medians this list does not contain, and that does not falsify it.
   */
  observedMedianMs: [234.9, 287.9, 555.3, 355.7, 332.3, 342.5, 345.8, 343.6, 351.6],
  /** Slowest single post-append total ever observed, in ms. */
  slowestSampleMs: 727.1,
  /** Share of the total spent in `graftSession`, every run on record. */
  graftShareOfTotal: 0.95,
  status: 'NOT MET as a total, by 2.3-5.6x across nine runs, and not fixable in this package',
} as const;

export const TIMING_BUDGETS: readonly TimingBudget[] = [
  {
    id: 'postAppend.incremental.dod',
    what: 'incremental',
    statistic: 'median',
    limitMs: 100,
    source: 'dod',
    enforced: true,
    measured: {
      valueMs: 17.1,
      on: 'synthetic 10,400 lines / 17,041,245 bytes; SLOWER of the two runs that measured it',
      marginX: 5.8,
      note:
        'THE RE-SCOPED DoD NUMBER. `SessionTailer.poll` + `ingestGraftResult` + `emit`, summed ' +
        'PER SAMPLE -- everything a post-append update does EXCEPT the deliberate whole-session ' +
        're-graft. See RESCOPED_DOD_TOTAL for the number this replaced and why it is unmet. ' +
        'THREE runs measured this series directly, all on 2026-08-21 in the worktree that ' +
        'added it: AGENT_DECK_PERF_FULL=1 gave median 16.2 (tmean 16.4, p90 18.2, min 14.3, ' +
        'max 24.3, n=15); the default counts gave 17.1 (tmean 17.0, p90 22.1, min 15.0, ' +
        'max 22.1, n=7) and 16.4 (tmean 16.3, p90 17.8, min 14.9, max 17.8, n=7). 17.1 is the ' +
        'slowest of the three medians, so 100 ms is 5.8x it and 4.1x ' +
        'the slowest single sample any of them saw (24.3 ms). MARGIN JUSTIFICATION: the three ' +
        'medians span 5.5% while the post-append TOTAL on the same machine has spanned ' +
        '234.9-555.3 ms (2.4x) across nine runs -- so the incremental stages are the stable ' +
        'part of the measurement, not the volatile one. The margin is 480% above the slowest ' +
        'median against a 5.5% observed spread across the three runs of it, i.e. ~87x the ' +
        'run-to-run variation seen so far; three runs is a thin base for a variance claim and ' +
        'that is exactly why the margin is not tighter. The stage that could still move it is ' +
        'tailPoll, whose per-poll readdir sweep grows with the session directory; that is ' +
        'guarded separately and more tightly at 150 ms.',
    },
  },
  {
    id: 'postAppend.total.regression',
    what: 'total',
    statistic: 'median',
    limitMs: 2500,
    source: 'regression',
    enforced: true,
    measured: {
      valueMs: 555.3,
      on: 'synthetic 10,400 lines / 17,041,245 bytes; SLOWEST of nine completed runs',
      marginX: 4.5,
      note:
        'NINE runs, all on the same machine, medians: 234.9 (n=12, isolated), 287.9 (n=15, ' +
        'isolated), 555.3 (n=7, isolated), 355.7 (n=7, inside the full 29-file suite), 332.3 ' +
        '(n=15, FULL, the committed evidence/perf-full.json), and three more added by the ' +
        'Phase 4.5 Wave 0 re-scope -- 342.5 (n=15, FULL), 345.8 (n=15, FULL), 343.6 (n=7, ' +
        'default), 351.6 (n=7, default). Slowest ' +
        'single sample anywhere: 727.1 ms. 2500 ms is 4.5x the slowest median and 3.4x the ' +
        'slowest single sample, which is the headroom the first draft of this budget INTENDED ' +
        'at 1200 ms and did not have: 1200 was 2.2x the slowest median and 1.65x the slowest ' +
        'sample, because the first two runs were the only ones then in hand. Note what the ' +
        'runs actually show -- the full-suite run was FASTER than an isolated one, so ' +
        'parallel suite load is not the dominant source of variance and sizing the budget ' +
        'against it was the wrong model. Machine state is. It still catches an order-of-' +
        'magnitude regression against a ~350 ms typical median and nothing smaller -- that is ' +
        'the trade, taken on purpose.',
    },
  },
  {
    id: 'postAppend.apply.regression',
    what: 'apply',
    statistic: 'median',
    limitMs: 150,
    source: 'regression',
    enforced: true,
    measured: {
      valueMs: 8.7,
      on: 'synthetic 10,400 lines / 17,041,245 bytes; SLOWEST median of nine runs',
      marginX: 17.2,
      note:
        'ingestGraftResult + emit + diffSessionState over a tree with ~2,400 tool nodes. ' +
        'Medians 5.8 / 6.6 / 8.7 ms across the first four runs and 5.9 / 5.9 / 5.9 / 5.9 ms ' +
        'across the four added by the Phase 4.5 Wave 0 re-scope; slowest single sample ' +
        'anywhere 11.0 ms. This is the stage that would betray a ' +
        'quadratic diff, so it gets its own budget rather than hiding inside the total, where ' +
        'a 20x regression here would still be under 3% of it.',
    },
  },
  {
    id: 'postAppend.tailPoll.regression',
    what: 'tailPoll',
    statistic: 'median',
    limitMs: 150,
    source: 'regression',
    enforced: true,
    measured: {
      valueMs: 12.0,
      on: 'synthetic 10,400 lines / 17,041,245 bytes; SLOWEST median of nine runs',
      marginX: 12.5,
      note:
        'Medians 8.0 / 9.8 / 12.0 ms across the first four runs and 10.4 / 9.7 / 11.1 / 10.0 ' +
        'ms across the four added by the Phase 4.5 Wave 0 re-scope; slowest single sample ' +
        'anywhere 24.9 ms. Mostly the per-poll discovery sweep (readdir of the slug ' +
        'and subagents directories); the byte-offset read itself is a few hundred bytes. ' +
        'A LOOSE guard on purpose: the property that matters for this stage is that it reads ' +
        'only the appended bytes, and that is asserted behaviourally against ' +
        'TailDiagnostics.bytesRead, which no machine load can perturb.',
    },
  },
];

/**
 * Ceiling on `HeapResult`'s window-FLOOR ratio.
 *
 * The floor -- the minimum post-GC `heapUsed` in a window -- is the retained
 * set, and retention is what "bounded" means. The trimmed mean is reported too
 * but is NOT what is asserted: the measured series is cleanly bimodal
 * (42.1 MB and 52.6 MB, a 1.25x spread), so a trimmed mean moves by up to 25%
 * depending only on how many high-mode samples happened to land in each half.
 * Asserting on it would be asserting on sampling luck.
 *
 * Measured floor ratio over 36 cycles after 4 warm-ups: 1.0012, in the run
 * committed as `evidence/perf-full.json` -- re-derivable from its raw
 * `heapUsedSeries` rather than taken on trust. An earlier draft recorded 1.002
 * here from a run that was never committed; the figure is close, and that is
 * exactly why it needed replacing with one a reader can check. The limit of
 * 1.10 leaves ~80x headroom over that drift while still catching a leak of
 * roughly 120 KB or more per update cycle on a 42 MB floor.
 */
/**
 * The whole-session graft of a REAL captured session — PLAN.md Phase 5.5,
 * DoD 5.5.7.
 *
 * WHY A SECOND CORPUS AT ALL. Every timing above is measured on
 * `fixtures/synthetic-perf`, which is generated: 10,400 lines built to a shape
 * this repo chose. That is the right instrument for a regression tripwire and
 * the wrong one for "does this hold on data Claude Code actually wrote". DoD
 * 5.5.7 asks for both, and `fixtures/synthetic-dropped-actions/` is the real
 * half — 977 lines, 3.1 MB, 246 tool calls across a main transcript and two
 * subagents, captured from an eight-hour session.
 *
 * WHAT IT MEASURES: one `graftSession` over that corpus, which is exactly what
 * `AgentDeckDataPath.#graft` does on every append. Not the whole post-append
 * rig — that is the synthetic corpus's job and doubling it would double the
 * suite's critical path for a second copy of the same three stages.
 *
 * MEASURED 2026-08-27, 10 samples after 2 warmups, nothing else running:
 * min 50.2, median 55.7, max 64.7 ms. The limit is 400, a 7.2x margin, chosen
 * once and not to be widened — the rule that survived three phases of
 * temptation on the two budgets above.
 *
 * THE DoD'S CONDITIONAL DID NOT TRIGGER, and that is worth recording rather
 * than leaving as an absence. 5.5.7 says "if `#graft`'s full re-read per append
 * is what's over budget, make the re-read incremental per transcript". Nothing
 * is over budget: the re-read of the real corpus is 55.7 ms and the synthetic
 * corpus's `.graft` stage is 322.8 ms against a 2500 ms limit. So the
 * incremental re-read was NOT built, deliberately — it would trade the G3
 * property `perf.test.ts` pins behaviourally (`parsedLines >= mainLines`: the
 * graft reads the WHOLE session, so no content is accepted before the layout is
 * asserted) for latency nothing is asking for.
 */
export const REAL_CORPUS_GRAFT_BUDGET: TimingBudget = {
  id: 'realCorpus.graft.dod',
  what: 'graft',
  statistic: 'median',
  limitMs: 400,
  source: 'dod',
  enforced: true,
  measured: {
    valueMs: 55.7,
    on: 'fixtures/synthetic-dropped-actions, 977 lines / 3.1 MB / 246 tool nodes, 2026-08-27',
    marginX: 7.2,
    note:
      'One whole-session graftSession, which is what #graft does per append. ' +
      '10 samples after 2 warmups: min 50.2, median 55.7, max 64.7. The margin ' +
      'is deliberate headroom for a slower machine, not room to grow into.',
  },
};

/**
 * DoD 4.2a — ONE WHOLE-CORPUS READ THROUGH THE CODEX ENGINE.
 *
 * The stage is `readCodexEngine()` over the committed anchor corpus: discovery,
 * fingerprint, parse, redaction and graft for every run in it. That is exactly
 * what the Codex content poll performs, so a regression in any of those five
 * shows up here rather than in a stage nobody measures.
 *
 * WHY THIS EXISTS AT ALL. Until 2026-09-04 **no perf budget touched the Codex
 * engine** — recorded as an open item since Phase 2 and carried through three
 * phases. Two engines were measured and the third was not.
 *
 * WHY THE CORPUS IS THE RIGHT SUBJECT DESPITE BEING SMALL. DoD 4.2 asks for a
 * harvested >= 10k-line transcript and the largest committed Codex transcript is
 * **73 lines**; that half is BLOCKED-QUOTA until 2026-10-03 and is tracked as
 * 4.2b. But line count is the wrong axis for this engine. Codex stores tool
 * output **whole and inline** — no offload file — so its stress shape is a
 * single enormous LINE, and the corpus already carries one of **554,122 bytes**.
 * That is the shape that turned a plausible scan pattern quadratic and cost the
 * privacy sweep 62 seconds on 2026-09-03. A 10k-line transcript of ordinary
 * lines would exercise less of what is actually risky here.
 *
 * What this budget therefore does NOT establish: how the engine scales to a
 * transcript with many thousands of records. 4.2b is the item for that, and it
 * stays open with its reason on the box.
 */
export const CODEX_ENGINE_READ_BUDGET: TimingBudget = {
  id: 'codex.engineRead.dod',
  what: 'graft',
  statistic: 'median',
  limitMs: 400,
  source: 'dod',
  enforced: true,
  measured: {
    valueMs: 29.1,
    on: 'fixtures/codex-0.151.0-alpha.7.2, 5 runs / 14 transcripts / longest line 554,122 bytes, 2026-09-04',
    marginX: 13.7,
    note:
      'One readCodexEngine() per run directory — discovery, fingerprint, parse, ' +
      'redaction and graft, which is what the content poll performs. 7 samples ' +
      'after 2 warmups, in the `perf` project (pool: forks). Two consecutive ' +
      'runs measured medians of 29.1 and 17.8 ms — a 1.6x spread on an ' +
      'unchanged tree, recorded rather than averaged away, and the reason the ' +
      'limit is nowhere near either. 29.1 is kept as the set point because a ' +
      'budget set from the FASTER of two observations is a budget that fails ' +
      'on a normal day. ' +
      'The 400 ms limit is the same set point realCorpus.graft.dod uses, chosen ' +
      'once: this stage is not the one under pressure, and a tight limit here ' +
      'would fail on a slower machine while measuring nothing new.',
  },
};

export const HEAP_FLOOR_RATIO_LIMIT = 1.1;

/**
 * Ceiling on how much of the run's heap movement the run's OWN appends could
 * explain. Every cycle appends a line, so the corpus and the tree really do
 * grow; this bounds that confound instead of ignoring it. Measured: 0.120%.
 */
export const CORPUS_GROWTH_FRACTION_LIMIT = 0.01;
