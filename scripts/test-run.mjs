// Run the suite once and record what happened, whatever happened.
//
// v0.7.0 Phase 1, DoD 1.8c. Carried in from hotfix 0.6.1: the exit-127
// mid-run death ledger stands at 6 with NO FINGERPRINT — no failing assertion,
// no summary line, and two different exit codes across the instances. Every one
// of those was reconstructed afterwards from a scrollback that had already been
// overwritten, which is why none of them has a diagnosis.
//
//   node scripts/test-run.mjs [--runs N] [--label NAME] [-- <vitest args>]
//
// One JSON record per run under `docs/evidence/runner/`, plus a human-readable
// ledger line. What it captures per run:
//
//   exit code · elapsed ms · the last reporter line · a stderr tail ·
//   the pool mode · the command · the HEAD it ran at · a death verdict
//
// ## WHAT MAKES A RUN A "DEATH" HERE, AND WHY IT IS NOT JUST A NON-ZERO EXIT
//
// A suite with a failing assertion exits non-zero and is a NORMAL result: the
// tests did their job. The thing this script exists to catch is the other
// shape — a non-zero exit with no summary line at all, the process gone before
// vitest could report. So `death` is `exit !== 0 AND no summary line was ever
// printed`, and an ordinary red run is recorded as `failed`, not as a death.
//
// Conflating the two is what would make the ledger useless: six deaths among
// forty red runs is a signal, and forty-six "failures" is not.
//
// ## G1
//
// Writes only under `docs/evidence/runner/`, which is inside the repository.
// Nothing outside it is touched.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { argv, exit, hrtime } from 'node:process';

import { classifyExit } from './exit-class.mjs';
import { uniqueRecordName } from './runner-paths.mjs';

const OUT_DIR = 'docs/evidence/runner';
const LEDGER = path.join(OUT_DIR, 'LEDGER.md');

/** The reporter's own totals line, whatever reporter is in use. */
const SUMMARY_RE = /Test Files\s+\d+|Tests\s+\d+\s+passed|no tests/i;

/**
 * Strips the reporter's ANSI colour so a stored line is greppable.
 *
 * BUILT FROM A CHAR CODE, not written as a literal ESC and not as `\u001b`
 * inside a regex literal. Both of those were tried here, in that order:
 *
 *   - the raw 0x1B byte makes git treat this file as binary, so there is never
 *     a reviewable diff again — the control-byte-in-source defect this
 *     repository records four times over;
 *   - the `\u001b` ESCAPE fixes the bytes and still fails eslint's
 *     `no-control-regex`, which is about the pattern rather than the encoding.
 *
 * `String.fromCharCode(27)` has neither problem and says what it means.
 */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function arg(name, fallback) {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
}

// `--explain <code>` answers "I saw exit N, what is it?" and writes NOTHING.
//
// Phase 1c added it because the answer is not obvious and the obvious answer is
// wrong: 127 at a Git Bash prompt is not "command not found", it is every
// Windows abnormal-termination status collapsed into eight bits. A reader who
// finds a 127 in a scrollback needs this before they need the ledger.
const explainAt = argv.indexOf('--explain');
if (explainAt !== -1) {
  const raw = Number(argv[explainAt + 1]);
  if (!Number.isFinite(raw)) throw new Error('--explain needs a numeric exit code');
  console.log(JSON.stringify(classifyExit(raw), null, 2));
  exit(0);
}

const runs = Number(arg('--runs', '1'));
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs needs a positive integer');
const label = arg('--label', 'adhoc');

// Everything after a bare `--` goes to vitest untouched.
const passThroughAt = argv.indexOf('--');
const extra = passThroughAt === -1 ? [] : argv.slice(passThroughAt + 1);

/**
 * The PRIMARY command, deliberately.
 *
 * `CLAUDE.md` records the rule: gate runs use `npx vitest run`. The fallback
 * (`node node_modules/vitest/vitest.mjs run`) is DIAGNOSTIC and has itself died
 * mid-run twice, so it is not a fix and this wrapper does not silently reach
 * for it. A death recorded here is a death of the command a gate actually uses.
 */
const COMMAND = 'npx';
const BASE_ARGS = ['vitest', 'run', '--reporter=dot', ...extra];

function run(command) {
  return new Promise((resolve) => {
    const p = spawn(command, { shell: true });
    let out = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.on('close', () => resolve(out));
    p.on('error', () => resolve(''));
  });
}

/**
 * The HEAD sha, with `-dirty` appended when the worktree does not match it.
 *
 * **A LEDGER ROW MUST NAME THE TREE IT TESTED** (user ruling, 2026-09-10), and
 * for three items running it did not. Twelve rows of the 4.11 blocks name
 * `948c0db` — a commit whose tree they never ran — and two suite sizes ended up
 * recorded against one sha, which makes rule 14 unauditable after the fact: a
 * reader cannot tell which of them the three consecutive greens belong to.
 *
 * The gate rule that came out of it (commit first, then take the block) is a
 * habit, and a habit is not a check. This is the check: a run over an
 * uncommitted tree is recorded as `<sha>-dirty`, which no commit can be confused
 * with. It does not stop the run — measuring an uncommitted tree is exactly what
 * an ad-hoc check is for — it stops the row from claiming a provenance it does
 * not have.
 */
async function head() {
  const sha = (await run('git rev-parse --short HEAD')).trim();
  if (sha === '') return 'unknown';
  const status = (await run('git status --porcelain')).trim();
  return status === '' ? sha : `${sha}-dirty`;
}

/**
 * `passed` and `skipped` out of a vitest summary line, or nulls.
 *
 * Parsed from the line rather than from a reporter API because that line is what
 * a death leaves behind and what every ledger row already carries.
 */
function countsOf(lines) {
  // THE `Tests` LINE SPECIFICALLY, not `summaryLine`. On a RED run vitest's last
  // matching line is `Test Files  1 failed | 123 passed | 1 skipped (125)` — file
  // counts, not test counts — so reusing it made a failed run's row disagree with
  // a green one about units rather than about the suite. Measured on
  // `gate-411c-close` run 3, by the disagreement check itself.
  const summaryLine =
    [...lines].reverse().find((l) => /^\s*Tests\s+\d+/.test(l)) ?? null;
  if (summaryLine === null) return { passed: null, skipped: null };
  const passed = /(\d+) passed/.exec(summaryLine);
  const skipped = /(\d+) skipped/.exec(summaryLine);
  return {
    passed: passed === null ? null : Number(passed[1]),
    // No "skipped" in the line means zero skipped, which is not the same as
    // unknown — a summary with no skips omits the word entirely.
    skipped: skipped === null ? 0 : Number(skipped[1]),
  };
}

function runOnce(index, headSha) {
  return new Promise((resolve) => {
    const started = hrtime.bigint();
    // ONE command string, not (command, args, {shell:true}). Node deprecates
    // the latter (DEP0190) because the args are concatenated unescaped; there
    // is no user input here, but a deprecation warning in every recorded run
    // is noise in exactly the log a death has to be read out of.
    const child = spawn(`${COMMAND} ${BASE_ARGS.join(' ')}`, { shell: true });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));

    child.on('close', (code, signal) => {
      const elapsedMs = Number((hrtime.bigint() - started) / 1_000_000n);
      const plain = stdout.replace(ANSI_RE, '');
      const lines = plain.split(/\r?\n/).filter((l) => l.trim() !== '');
      const summaryLine = [...lines].reverse().find((l) => SUMMARY_RE.test(l)) ?? null;

      const record = {
        label,
        index,
        head: headSha,
        command: `${COMMAND} ${BASE_ARGS.join(' ')}`,
        // Recorded per run rather than assumed: `vitest.config.ts` runs the
        // `perf` project on `forks` and everything else on threads, and a
        // death's pool is the first thing anybody will ask about.
        pool: 'suite=threads perf=forks (vitest.config.ts)',
        exit: code,
        signal: signal ?? null,
        // THE RAW CODE, CLASSIFIED. `cmd.exe` (which `shell: true` uses) hands
        // a Windows exit status through unchanged; Git Bash does not, and
        // collapses every abnormal status to 127. A death recorded here is
        // therefore worth more than the same death read out of a bash
        // scrollback, and this field is what says so on the record rather than
        // in a document nobody opens. See `scripts/exit-class.mjs`.
        exitClass: classifyExit(code, signal ?? null),
        elapsedMs,
        summaryLine,
        /*
         * THE COUNTS AS FIELDS, so a block can compare its own runs.
         *
         * A silent subprocess failure inside a `beforeAll` reports as a FAILED
         * SUITE whose tests are counted as SKIPPED — one gate block of the 4.11b
         * item read `3683 passed | 8 skipped` against the healthy
         * `3685 passed | 6 skipped`, and the two extra skips were the whole visible
         * trace of the cause. This wrapper keys its verdict on the exit code, so
         * the same failure exiting 0 would still be recorded `passed`.
         *
         * What is NOT done here, deliberately: pinning a healthy skip count.
         * `CLAUDE.md` records that count as a census over environment-conditional
         * gates that has been re-derived wrong three times, and a wrapper
         * asserting it would go red on any machine without WSL. What a BLOCK can
         * say without a constant is that its runs disagree with each other —
         * which is rule 14's own claim ("three consecutive runs, identical") and
         * is reported below.
         */
        counts: countsOf(lines),
        lastReporterLine: lines.at(-1) ?? null,
        stderrTail: stderr.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-20),
        /*
         * FOUR VERDICTS, NOT THREE — and the fourth was added because this
         * ledger committed, one level in, the very defect Phase 1c exists to
         * correct.
         *
         * The original rule was `non-zero AND no summary line -> DEATH`, on the
         * reasoning that a red suite reports itself and anything else is the
         * process vanishing. That is true of a process that vanishes and false
         * of a run that never started: a `globalSetup` that throws exits 1 with
         * no summary, and seventeen such refusals were recorded as DEATHs in
         * `1c-block3` — sitting in the same column as a Windows fail-fast,
         * which is exactly the conflation the whole phase is about.
         *
         * So a DEATH now requires the code to be ABNORMAL — high-bit, i.e. the
         * process was terminated rather than exiting. A non-zero code with no
         * summary and an ordinary code is a `startup-error`: vitest refused to
         * run, and the reason is in `stderrTail` rather than in the exit code.
         */
        verdict:
          code === 0
            ? 'passed'
            : summaryLine !== null
              ? 'failed'
              : classifyExit(code, signal ?? null).kind === 'abnormal'
                ? 'DEATH'
                : 'startup-error',
        at: new Date().toISOString(),
      };

      mkdirSync(OUT_DIR, { recursive: true });
      // NEVER OVERWRITTEN (v0.7.0 DoD 4.0a). Every ad-hoc run is `adhoc` at
      // index 1, and the four ad-hoc runs after Phase 3's two mid-run deaths
      // overwrote both deaths' records — the stderr tail and last reporter line
      // that make a death "captured". A record that exists keeps its name and
      // the new one takes `-r2`, `-r3`, ...; see `scripts/runner-paths.mjs`.
      const recordName = uniqueRecordName(label, index, (name) =>
        existsSync(path.join(OUT_DIR, name)),
      );
      record.file = recordName;
      writeFileSync(path.join(OUT_DIR, recordName), `${JSON.stringify(record, null, 2)}\n`);
      // An abnormal code is spelled in hex BESIDE its decimal form, because the
      // decimal form is unreadable and this ledger has already carried the same
      // status written two different ways (`3221226505` and `-1073740791`).
      const codeCell =
        record.exitClass.kind === 'abnormal' || record.exitClass.kind === 'oversized'
          ? `${String(code)} (${record.exitClass.hex}, bash would say ${String(record.exitClass.posixShellWouldReport)})`
          : String(code);
      appendFileSync(
        LEDGER,
        `| ${record.at} | ${label} | ${String(index)} | ${headSha} | ${codeCell} | ` +
          `${String(elapsedMs)} | ${record.verdict} | ${(summaryLine ?? '(none)').trim()} |\n`,
      );
      resolve(record);
    });
  });
}

const headSha = await head();
mkdirSync(OUT_DIR, { recursive: true });

const results = [];
for (let i = 1; i <= runs; i += 1) {
  const record = await runOnce(i, headSha);
  results.push(record);
  console.log(
    `run ${String(i)}/${String(runs)}  exit=${String(record.exit)}  ` +
      `${String(record.elapsedMs)}ms  ${record.verdict}  ${(record.summaryLine ?? '(no summary)').trim()}`,
  );
}

/*
 * RULE 14 IS A CLAIM ABOUT AGREEMENT, so the block checks it rather than leaving
 * it to whoever reads three summary lines. Only completed runs can agree about
 * anything; a death has no counts.
 */
const completed = results.filter((r) => r.summaryLine !== null);
const shapes = new Set(
  completed.map((r) => `${String(r.counts.passed)}/${String(r.counts.skipped)}`),
);
if (shapes.size > 1) {
  console.log(
    `\nDISAGREEMENT: the completed runs report ${shapes.size} different passed/skipped shapes ` +
      `(${[...shapes].join(", ")}). Rule 14 needs them identical; account for every skip by GATE.`,
  );
}

const deaths = results.filter((r) => r.verdict === 'DEATH');
const failed = results.filter((r) => r.verdict === 'failed');
const startupErrors = results.filter((r) => r.verdict === 'startup-error');
const passed = results.length - deaths.length - failed.length - startupErrors.length;
console.log(
  `\n${label}: ${String(results.length)} runs, ${String(deaths.length)} deaths, ` +
    `${String(failed.length)} failed, ${String(startupErrors.length)} startup-error, ` +
    `${String(passed)} passed`,
);

/*
 * A DEATH fails the wrapper, and so does a run that never started.
 *
 * A red suite has already reported itself, so `failed` does not. A
 * `startup-error` does, and for a different reason than a death: it means the
 * block measured NOTHING for that run, and a block whose denominator silently
 * shrinks is worse than one that stops. `1c-block3` is the case — seventeen
 * refusals that produced no measurement and, before this, were counted as
 * seventeen deaths.
 */
exit(deaths.length > 0 || startupErrors.length > 0 ? 1 : 0);
