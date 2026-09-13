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
 * single enormous LINE, and the corpus already carries one of **554,126 bytes**.
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
    on: 'fixtures/codex-0.151.0-alpha.7.2, 5 runs / 14 transcripts / longest line 554,126 bytes, 2026-09-04',
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

/**
 * v0.7.0 DoD 1.8b — the OpenCode liveness poll, CLOSED AS MEASURED-AND-REJECTED.
 *
 * WHY A BUDGET EXISTS ON A COST WE DECIDED NOT TO FIX. 1.8b asked for the two
 * unindexable full `part` scans per poll to be bounded. A per-session watermark
 * over `part_session_idx` was written and reached **1.2 ms at 200 k rows against
 * 402.8 ms unbounded** — and was REVERTED, because `liveness.test.ts`'s A2
 * mutation table starts a tool by rewriting one part's `data` IN PLACE, with no
 * new row, no `event_sequence` move and no `time_updated` bump, and under the
 * bound that tool became invisible. Four candidates, each failing on its own
 * terms — session scope depends on OpenCode writing an `event` per part write
 * (never measured); a `rowid` watermark catches an INSERT and misses the UPDATE
 * IN PLACE that turns `running` into `completed`; a `time_updated` watermark is
 * evidence-backed (865 of 865 parts in the anchor) but is still a full scan at
 * 26.5 ms on 200 k and not flat; an index of our own is a write to the observed
 * database, which G1 forbids. The user closed it on 2026-09-06 as
 * measured-and-rejected rather than deferred, and directed that the cost be
 * PINNED so growth is caught. This is that pin.
 *
 * WHAT IT DOES AND DOES NOT CATCH. The row count is FIXED at 20,000, so this is
 * a guard on the PER-ROW cost of the scan — a regression in the predicate, the
 * row decoding or the poll's per-row work goes red here. It is NOT a guard on
 * the unboundedness itself, which is the accepted cost: a user's store growing
 * to 200 k rows still pays ~400 ms per poll and this budget will not notice,
 * because its subject is a store of a size we choose. `partscan.test.ts` is the
 * measurement of that growth and carries the tripwire that goes red the day
 * anyone bounds the scan.
 *
 * WHY A SYNTHETIC STORE RATHER THAN THE COMMITTED CORPUS. The anchor carries
 * 865 `part` rows and polls in ~1 ms — too small to separate a real regression
 * from scheduler noise. 20,000 is the same row count `partscan.test.ts` uses for
 * its small store, so the two instruments are directly comparable, and it is a
 * plausible size for a real developer's store after a few months.
 *
 * WHY NOT MEASURED IN THE MAIN PROJECT. A budget has to live where the host
 * process state is controlled, which is this project (`pool: 'forks'`): this
 * repo has an evidence file about a perf stage that measured 1050.6 ms in the
 * main project and 12.3 ms in a separate process, on an unchanged tree, with
 * the mechanism still unidentified.
 *
 * AMENDED 2026-09-07 (Phase 1c). This section used to read "`partscan.test.ts`
 * reports 48.4 ms for the same scan, in the MAIN vitest project", offered as a
 * live instrument difference. **`partscan.test.ts` has moved into this project**
 * — it was failing in the main one for exactly the reason this paragraph gives.
 *
 * AND THE INSTRUMENT DIFFERENCE LARGELY WAS NOT ONE. Re-measured here after the
 * move, with a warm-up poll discarded: **53.0 ms**, against the 48.4 ms recorded
 * from the main project. Those agree. What the main project was really adding
 * was START-UP cost landing on whichever store was measured first — the same
 * store measured 617 ms in a cold process during the Phase 1c blocks, and that
 * is what made the ratio assertion there a coin toss. So the honest reading of
 * the old 48.4 is that it was a warm measurement all along, and the gap between
 * 48.4 and this budget's 93.8 is NOT explained by the project boundary. That
 * gap is unexplained and is recorded as unexplained; the margin below is wide
 * enough that it does not need explaining to do its job.
 */
export const OPENCODE_POLL_BUDGET: TimingBudget = {
  id: 'opencode.poll.regression',
  what: 'total',
  statistic: 'median',
  limitMs: 950,
  source: 'regression',
  enforced: true,
  measured: {
    valueMs: 93.8,
    on: 'synthetic OpenCode store, 20,000 `part` rows across 8 sessions, journal-mode delete, 2026-09-06',
    marginX: 10.1,
    note:
      'One steady-state `OcLivenessEngine.poll()` — both unindexable full `part` ' +
      'scans, every row decoded. 7 samples after 2 warm-ups in the `perf` project ' +
      '(pool: forks). Two consecutive runs measured medians of 72.6 and 93.8 ms — ' +
      'a 1.3x spread on an unchanged tree, recorded rather than averaged away. ' +
      '93.8 is kept as the set point because a budget set from the FASTER of two ' +
      'observations is a budget that fails on a normal day — the same rule ' +
      'codex.engineRead.dod records. THE SECOND INSTRUMENT IS NOW IN THIS ' +
      'PROJECT TOO: `partscan.test.ts` reported 48.4 ms for the same scan at the ' +
      'same row count from the MAIN project, and 53.0 ms here after Phase 1c ' +
      'moved it on 2026-09-07 and discarded a warm-up poll. Those two agree, so ' +
      'the project boundary does NOT explain the gap to 93.8 and nothing here ' +
      'claims it does; see this budget\'s header. ' +
      'THE MARGIN IS DELIBERATELY WIDE (10x) AND THAT IS THE POINT OF THIS ' +
      'PARTICULAR BUDGET: it guards a cost the user ACCEPTED, so it must catch an ' +
      'order-of-magnitude regression in per-row work without going red on a ' +
      'slower machine or a loaded runner. A tight limit here would be a flaky ' +
      'test defending a decision that is already recorded. The FIRST-PASS cost is ' +
      'deliberately not the subject: the steady state is what is paid forever, ' +
      'and it is what 1.8b was about.',
  },
};

export const HEAP_FLOOR_RATIO_LIMIT = 1.1;

/**
 * Ceiling on how much of the run's heap movement the run's OWN appends could
 * explain. Every cycle appends a line, so the corpus and the tree really do
 * grow; this bounds that confound instead of ignoring it. Measured: 0.120%.
 */
export const CORPUS_GROWTH_FRACTION_LIMIT = 0.01;

/**
 * v0.7.0 DoD 2.8 — `deriveStats` per 1,000 tree nodes.
 *
 * ## What it measures, and why the unit is NODES rather than a session
 *
 * The deriver's cost is a function of how many `ToolNode`s and `AgentNode`s it
 * walks, not of how long the session lasted or how many bytes its transcripts
 * held. Committed sessions span 0 to 454 tool calls, so a per-session budget
 * would be dominated by which corpus happened to be biggest and would move
 * every time one was added. A fixed 1,000-node subject is comparable across
 * releases and is the unit DoD 2.8 names.
 *
 * The subject exercises every fact that costs anything: eight agents so the
 * per-agent grouping is real, 40 distinct files across three tool classes so F1
 * and F4 both have work, 50 distinct input hashes so F3's grouping produces 30
 * genuine loops, an error every seventeenth call so churn chains actually form,
 * and a 40-turn usage series per agent for F6 and F7. A subject with one agent
 * and no repeats would measure the walk and none of the derivation.
 *
 * ## The measurement
 *
 * Three standalone runs on the Windows 11 development machine, 2026-09-08, 40
 * samples each with the FIRST FIVE DISCARDED (JIT warm-up: those five ran
 * 1.634, 1.248, 0.853, 0.932, 0.524 ms in an early run, against a warm median
 * of 0.540). Medians: **0.566, 0.574, 0.609 ms**. The slowest of the three is
 * the set point, per this file's rule that a budget set from the faster of two
 * observations is a budget that fails on a normal day.
 *
 * ## THE FIRST SUBJECT WAS MEASURING F7's LOOP WITHOUT ITS WORK
 *
 * Recorded because the correction is the useful part, and because a vacuity
 * control is what found it rather than review. The subject's usage series
 * first rose by 300 tokens a turn, so every turn-over-turn delta was 300
 * against a `SPIKE_TOKENS.cc` of 5,000 and **F7 produced zero rows** — the
 * scan ran and pushed nothing. Medians under that subject were 0.540, 0.503,
 * 0.498 ms, and a budget set from them would have been a budget on a fact that
 * was never derived.
 *
 * The series now rises by 6,000 a turn, so all 39 deltas per agent clear the
 * threshold and F7 pushes 312 rows. That is the number above, and the cost of
 * the fix — roughly 13 % — is the honest size of the work that had been
 * missing. The test carries the control that caught it: it asserts every
 * expensive fact produced rows before it times anything.
 *
 * ## Why 5 ms and not 1 ms
 *
 * An 8.2x margin on a sub-millisecond pure function is not slack for its own
 * sake. At this scale timer granularity and a single GC pause are a large share
 * of the sample, and Phase 1c measured this machine running at roughly half
 * speed for a whole 20-run block — under which the median would be ~1.1 ms and
 * a 1 ms limit would be red on correct code. What the limit is FOR is an
 * algorithmic regression: every grouping here is linear or `n log n`, and the
 * plausible defect is one of them going quadratic, which at 1,000 nodes is two
 * orders of magnitude and clears 5 ms without ambiguity. A budget that goes red
 * on a loaded machine teaches people to re-run it, which is worth less than a
 * budget that only ever goes red for a reason.
 *
 * What it does NOT establish: behaviour above 1,000 nodes. `fuzz.test.ts`
 * covers 5,000 for CORRECTNESS (it must not throw), not for time.
 */
export const DERIVE_STATS_BUDGET: TimingBudget = {
  id: 'stats.derive.dod',
  what: 'deriveStats per 1,000 nodes',
  statistic: 'median',
  limitMs: 5,
  source: 'dod',
  enforced: true,
  measured: {
    valueMs: 0.609,
    on: 'synthetic 1,000-tool-node session (8 agents, 40 files, 50 hashes, 40-turn series, 312 F7 rows), 3 runs x 35 warm samples, 2026-09-08',
    marginX: 8.2,
    note:
      'Medians 0.566 / 0.574 / 0.609 ms across three standalone runs; the ' +
      'SLOWEST is the set point. First five samples of each run discarded as ' +
      'JIT warm-up and recorded above rather than dropped silently. ' +
      'SUPERSEDED SET POINT, kept because the reason matters: 0.540 ms, ' +
      'measured over a subject whose cache-creation rose 300 tokens a turn, ' +
      'so F7 scanned every turn and reported none. The subject now spikes on ' +
      'all 39 deltas per agent and the derivation costs ~13% more. Measured ' +
      'in a plain node process, the closest available analogue of the forked, ' +
      'single-fork worker the `perf` project runs on.',
  },
};

/**
 * The local store's two stages — v0.7.0 DoD 3.9.
 *
 * ## THE SUBJECT IS THE STEADY STATE, AND CHOOSING IT MOVED THE NUMBER
 *
 * Both budgets are measured against a store already holding a FULL RETENTION
 * WINDOW: 90 days at 20 sessions a day — 1,800 records across 14 weekly files,
 * the same projection `docs/evidence/phase-0-stats/VERDICT.md` 0.7 used to
 * confirm the 90-day default. That is what a user three months in has, and it
 * is chosen so the plausible regression is visible at the subject's own scale:
 * an append that starts READING the history it is appending to costs nothing
 * measurable against an empty store and about 50 ms against this one.
 *
 * The first attempt measured append into a FRESH store seeded with one week,
 * a new `mkdtemp` per sample, and reported a median of 17.5-18.6 ms. That
 * number was mostly the seeding: re-measured against the steady state it is
 * **10.0-10.6 ms**. Recorded because the correction is the useful part — a
 * per-sample setup that dominates the sample is a budget measuring its own
 * harness, and the only thing that catches it is looking at where the time
 * went.
 *
 * ## WHAT THESE LIMITS ARE AND ARE NOT FOR
 *
 * `appendRecord` is FILESYSTEM-BOUND and the wall-clock number is a property
 * of this machine, not of the code. Measured by syscall on the development
 * box: `mkdirSync` 0.166 ms, `existsSync` 0.156 ms, `readdirSync` 0.148 ms —
 * and `appendFileSync` **17.2 ms**. Nearly all of an append is one open-write-
 * close of a growing file, which on Windows is dominated by whatever scans it.
 * The retention prune, which runs on every append, is 0.30 ms of the total.
 *
 * So these are the `postAppend.tailPoll.regression` kind of budget, not the
 * `stats.derive` kind, and they carry its kind of margin (12.5x there, 14.1x
 * and 10.0x here). Phase 1c measured this machine running at roughly half
 * speed for a whole 20-run block, and the corpus read — also filesystem-bound
 * — degraded by a factor of MORE THAN 13 while the suite's own wall-clock only
 * doubled. A limit set for a 2x regression would be red on correct code on an
 * ordinary bad day, and a budget that goes red on a loaded machine teaches
 * people to re-run it, which is worth less than a budget that only ever goes
 * red for a reason.
 *
 * **Stated plainly: these catch an ORDER-OF-MAGNITUDE regression — a stage
 * going quadratic in the number of records or of files — and they do not catch
 * a doubling.** The append limit would not go red on an append that re-read
 * the whole store (+50 ms), and that is a known gap rather than an oversight:
 * closing it would need a limit near 40 ms, which this machine has already
 * been measured exceeding on identical code.
 */
export const STORE_APPEND_BUDGET: TimingBudget = {
  id: 'stats.store.append.dod',
  what: 'StatsStore.appendRecord into a full retention window',
  statistic: 'median',
  limitMs: 150,
  source: 'dod',
  enforced: true,
  measured: {
    valueMs: 10.63,
    on: 'a store holding 1,800 records across 14 weekly files, 3 runs x 45 samples, 2026-09-08',
    marginX: 14.1,
    note:
      'Medians 10.03 / 9.91 / 10.63 ms across three standalone runs; the ' +
      'SLOWEST is the set point, so the margin stated is the worst case. ' +
      'Maxima 15.5 / 14.8 / 18.2 ms. Measured in a plain node process, the ' +
      'closest available analogue of the forked, single-fork worker the ' +
      '`perf` project runs on. SUPERSEDED SET POINT, kept because the reason ' +
      'matters: 18.6 ms, measured against a fresh store re-seeded with 140 ' +
      'records per sample — most of which was the seeding rather than the ' +
      'append. Nearly all of what remains is `appendFileSync` itself (17.2 ' +
      'ms by syscall on this machine); the retention prune is 0.30 ms.',
  },
};

export const STORE_READ_BUDGET: TimingBudget = {
  id: 'stats.store.read.dod',
  what: 'StatsStore.readRecords over a full retention window',
  statistic: 'median',
  limitMs: 500,
  source: 'dod',
  enforced: true,
  measured: {
    valueMs: 49.86,
    on: '1,800 records across 14 weekly files, all read and reduced, 3 runs x 45 samples, 2026-09-08',
    marginX: 10.0,
    note:
      'Medians 48.92 / 49.86 / 48.74 ms across three standalone runs; the ' +
      'SLOWEST is the set point. Maxima 60.7 / 63.9 / 61.5 ms. This is the ' +
      'whole-history read the Trends view and the extension API will make, ' +
      'not anything on the emission path — a read never happens while a ' +
      'session is being observed. The cost is 14 file reads plus 1,800 ' +
      '`JSON.parse` and 1,800 `validateStatsRecord` walks; the reduction to ' +
      'newest-per-session is a single `Map` pass and is not where the time ' +
      'goes. The regression this is for is that reduction going quadratic, ' +
      'which at 1,800 records is 3.2 million comparisons and clears 500 ms ' +
      'without ambiguity.',
  },
};


/**
 * The two pure webview computations Phase 4 added — v0.7.0 DoD 4.10.
 *
 * Both are functions of their arguments with no I/O, so the number is the
 * function. `fit` runs on EVERY trigger in the table (`webview/store.ts:
 * FIT_TRIGGERS`), including every structural diff, so its limit is per
 * trigger; `statsLayout` runs on every `statsSnapshot` and every engine-chip
 * toggle, over every live record. Set from the measurements below;
 * `webview-layout.test.ts` re-measures and prints beside them.
 */
export const WEBVIEW_FIT_BUDGET: TimingBudget = {
  id: 'webview.fit.dod',
  what: 'boundsOf + fit over the 40-node wrapped tree, with the drawer open',
  statistic: 'median',
  limitMs: 1,
  source: 'dod',
  enforced: true,
  measured: {
    valueMs: 0.008,
    on: 'the 40-node fit golden subject (sessionOf(40)), 1600x900, drawer 190 px, 3 standalone runs x 40 warm samples, 2026-09-09',
    marginX: 125,
    note:
      'Medians 0.008 / 0.007 / 0.006 ms across three standalone runs; the SLOWEST is ' +
      'the set point. The subject is boundsOf over 40 placements plus one fitTo, which ' +
      'is what a trigger pays. Measured in the forked perf worker. The limit is 1 ms ' +
      'because a trigger can fire on every structural diff and the whole per-diff ' +
      'incremental budget is 100 ms; this stage must stay invisible inside it.',
  },
};

/**
 * v0.7.0 DoD 5.0 — the shared listener's relay: follower attach plus 1,000
 * relayed frames, first two samples discarded.
 *
 * ## What it measures
 *
 * One sample is a FRESH follower attaching to a leader and then receiving
 * 1,000 hook payloads that were POSTed to the leader the way a hook command
 * POSTs them — one connection each. So it is the leader's whole per-event cost
 * with a follower attached (parse, normalize, local dispatch, the G4 redaction
 * every relayed payload goes through, the SSE write) plus the follower's
 * (frame split, decode, ownership filter, dispatch). The payloads are the 285
 * real ones in `fixtures/hook-events/`, cycled. `relay.test.ts` carries the
 * subject control: every sample received exactly 1,000 frames and every frame
 * was either dispatched or dropped as another window's.
 *
 * **Where the time goes:** attach is ~2 ms of a ~550 ms sample. Nearly all of
 * it is the thousand loopback connections and the leader's handling of them —
 * which is the honest cost of the relay to a leader, because a relayed frame
 * only exists once a hook has POSTed it.
 *
 * ## THIS BUDGET DOES NOT RUN ON NODE 24.15.0, AND THAT IS THE 5.0c FINDING
 *
 * It was first measured on this machine's default `node.exe`, 24.15.0, and the
 * forked perf worker died before reporting in **4 of 6** runs
 * (`ERR_IPC_CHANNEL_CLOSED` in the parent, no test output, no WER record). The
 * same workload in a plain Node process, no vitest, exits `0xC0000409` in
 * **14 of 28** runs on 24.15.0 and **0 of 20** on each of 22.23.2 and 24.18.1,
 * interleaved. It is the fail-fast Phase 1c could not diagnose, reproduced by
 * this repository's own relay code, and it is why the gate's Node is pinned —
 * `docs/evidence/v0.7.0/phase-5/NODE-5.0c.md` is the record. The numbers below
 * are therefore Node 22.23.2 numbers, the gate runtime pinned when they were
 * taken.
 *
 * **The gate was re-pinned to 24.18.1 on 2026-09-10 (v0.7.1 DoD 6.0)** — the
 * other build 5.0c measured clean, and the Node VS Code's Electron runs the
 * host on. The set point below was NOT re-measured for the move and still names
 * the Node it came from; the budget runs, and must pass, on the new pin.
 *
 * ## The measurement, and the margin
 *
 * Three standalone runs under Node 22.23.2, 2026-09-10, 2 discarded + 7 kept
 * each. Kept medians **560.95, 545.62, 562.88 ms**; the slowest is the set
 * point. Discarded (warm-up) samples ran 620–730 ms and are printed by the test
 * rather than dropped silently — the DoD states the discard so a warm-up
 * allowance can be told from a quietly widened limit.
 *
 * 5,000 ms is 8.9x. The stage is loopback-socket-bound, the kind of stage this
 * machine has been measured running at half speed for whole blocks, so a limit
 * set for a doubling would be red on correct code. What it is FOR is a relay
 * that goes quadratic in frames — a follower buffer re-scanned from the start,
 * a leader still writing to followers that left — which at 1,000 frames clears
 * 5 s without ambiguity. It does not catch a doubling, stated rather than
 * implied.
 */
export const RELAY_BUDGET: TimingBudget = {
  id: 'relay.follower.dod',
  what: 'follower attach + 1,000 relayed hook frames',
  statistic: 'median',
  limitMs: 5_000,
  source: 'dod',
  enforced: true,
  measured: {
    valueMs: 562.88,
    on: 'fixtures/hook-events (285 real payloads, cycled) x 1,000 frames per sample, Node 22.23.2, 3 runs x (2 discarded + 7 kept), 2026-09-10',
    marginX: 8.9,
    note:
      'Kept medians 560.95 / 545.62 / 562.88 ms across three standalone runs in the ' +
      '`perf` project (pool: forks) under Node 22.23.2; the SLOWEST is the set point. ' +
      'Attach medians 1.7-2.0 ms: nearly all of a sample is the thousand loopback ' +
      'POSTs and the leader handling them. On Node 24.15.0 the same file lost its ' +
      'forked worker before reporting in 4 of 6 runs — the 5.0c fail-fast — so this ' +
      'budget is only meaningful on the pinned gate Node.',
  },
};

/**
 * v0.8.0 DoD 7.7 — one whole-engine pass over a 1.2 GB oversize transcript.
 *
 * ## What the subject is
 *
 * `readCodexEngine` against a data root holding ONE transcript of
 * 1,288,490,188 bytes, drained to end-of-file in a single call: discovery's
 * `stat`, the 256 KiB head, the fingerprint, the jump, the last 16 MiB in
 * 4 MiB batches, the parse and the graft. It is the whole production path, not
 * a timed slice of it, because the claim the DoD makes is about the pass a
 * user's window performs.
 *
 * ## THE FILE IS SPARSE, AND THE TEST ASSERTS THAT IT WAS NOT READ WHOLE
 *
 * `truncate` extends a file without writing it, so the corpus costs kilobytes
 * on disk and this measures the reader rather than the disk. The read is
 * pinned twice over: `partialTranscripts[0].readBytes` must equal
 * `CODEX_HEAD_BYTES + CODEX_OVERSIZE_TAIL_BYTES` exactly, and the test's own
 * `fs` spy must show no read outside those two windows. A budget met by a
 * machine that never opened the file would be the vacuity this table's header
 * warns about, and a budget met by reading 1.2 GB fast would be a measurement
 * of an SSD.
 *
 * ## The measurement, and the margin
 *
 * Three standalone runs of `src/perf/oversize.test.ts` in the `perf` project
 * (`pool: 'forks'`), Windows 11, 2026-09-13, 1 discarded warm-up + 5 kept
 * samples each. Kept medians **39.54, 38.53, 38.02 ms**; the SLOWEST is the
 * set point below. The warm-up is discarded and PRINTED rather than dropped
 * silently, the same rule `RELAY_BUDGET` states.
 *
 * The limit is 2,000 ms, 50.6x the set point. What it is FOR is a reader that
 * went LINEAR in the file's size — a jump that fell back to reading the
 * middle, a `Buffer.alloc(size - offset)` restored, a resync that accumulated
 * instead of discarding — any of which moves 1.2 GB through a buffer and a
 * `StringDecoder` and clears this limit by orders of magnitude rather than
 * marginally. It does not catch a doubling, stated rather than implied, and it
 * is not the file's main guard: `oversize.test.ts` pins the bytes read and the
 * two windows they fall in, which is what a clock cannot say.
 *
 * The margin is wide on purpose. This machine has been measured running a
 * whole block at half speed, and a wall-clock limit set for a doubling would
 * be red on correct code — the mistake the version window's own history
 * records, in timing form.
 */
export const OVERSIZE_TAIL_BUDGET: TimingBudget = {
  id: 'codex.oversizeTail.dod',
  what: 'one readCodexEngine pass over a 1.2 GB sparse transcript, drained to EOF',
  statistic: 'median',
  limitMs: 2_000,
  source: 'dod',
  enforced: true,
  measured: {
    valueMs: 39.54,
    on: 'a generated 1,288,490,188-byte sparse Codex transcript, 3 runs x (1 discarded + 5 kept), 2026-09-13',
    marginX: 50.6,
    note:
      'Kept medians 39.54 / 38.53 / 38.02 ms across three standalone runs in the `perf` ' +
      'project (pool: forks); the SLOWEST is the set point. Warm-up samples ran 38.9-44.5 ms ' +
      'and are printed by the test rather than dropped silently. The subject is the WHOLE ' +
      'pass — discovery stat, 256 KiB head, fingerprint, jump, 16 MiB tail in 4 MiB batches, ' +
      'parse, graft — against a file 79x larger than the bytes it reads.',
  },
};

export const STATS_LAYOUT_BUDGET: TimingBudget = {
  id: 'webview.statsLayout.dod',
  what: 'statsLayout over every harvested corpus record',
  statistic: 'median',
  limitMs: 20,
  source: 'dod',
  enforced: true,
  measured: {
    valueMs: 0.129,
    on: 'the harvested fixtures/golden/stats records (23, one excluded), 3 standalone runs x 40 warm samples, 2026-09-09',
    marginX: 155,
    note:
      'Medians 0.129 / 0.090 / 0.110 ms across three standalone runs; the SLOWEST is ' +
      'the set point. The subject is every harvested corpus record through all four ' +
      'views. The limit is 20 ms because the layout re-runs on every statsSnapshot ' +
      'the host sends, which is every emission while the Stats view is open, and a ' +
      'layout that took longer than a frame would show up as a stutter on a live deck.',
  },
};
