/**
 * The runner's exit-code classification — v0.7.0 Phase 1c.
 *
 * ## WHY THIS FILE EXISTS
 *
 * The ledger carried an "exit 127" death class for six occurrences, on the
 * reading that 127 is a POSIX shell's "command not found". Phase 1c measured
 * the chain and that reading is wrong. Nothing in the gate's process chain was
 * ever missing; `127` is what **Git Bash prints when Windows terminates the
 * process**, because a POSIX wait status has eight bits for an exit code and
 * every Windows abnormal-termination status has its high bit set.
 *
 * The consequence is that a death read out of a Git Bash scrollback has already
 * lost the only field that names the fault. `scripts/test-run.mjs` runs through
 * `cmd.exe`, which preserves the raw code, and now records what that code IS.
 *
 * ## WHAT MAKES THESE ASSERTIONS NON-VACUOUS
 *
 * The table below is not derived from the implementation — it is the measured
 * output of `node -e "process.exitCode = N"` under Git Bash, one row per value,
 * taken on 2026-09-07. The `live` block re-takes those measurements through the
 * real shell and asserts the pure function agrees, so the table cannot quietly
 * become a restatement of the code that reads it. And the `--explain` block
 * drives the real script, so the classifier being correct and the runner
 * actually USING it are two separate claims with two separate tests — the
 * wiring lesson this repository has now learned twice.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  OBSERVED_STATUS_NAMES,
  POSIX_ABNORMAL_RENDERING,
  classifyExit,
  posixShellRendering,
  toHex,
  toUnsigned32,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- a plain .mjs tool module with no type declarations; the test
  // is the only consumer that needs types and asserts the shape it uses.
} from '../../scripts/exit-class.mjs';

const REPO_ROOT = join(__dirname, '..', '..');
const RUNNER = join(REPO_ROOT, 'scripts', 'test-run.mjs');
const LEDGER = join(REPO_ROOT, 'docs', 'evidence', 'runner', 'LEDGER.md');

/**
 * MEASURED, not derived. `node -e "process.exitCode = N"` run under
 * `C:/Program Files/Git/bin/bash.exe -c '... ; echo $?'`, 2026-09-07.
 *
 * The three rows that matter are the last three: `0xC0000409` is the status
 * this repository has ALREADY captured once, under `test-run.mjs`, and it is
 * indistinguishable from `-1` and from `0xFFFFFFFF` once a POSIX shell has
 * printed it.
 */
const MEASURED_BASH_RENDERING: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 1],
  [126, 126],
  [127, 127],
  [128, 128],
  [129, 129],
  [255, 255],
  [256, 0],
  [383, 127],
  [384, 128],
  [-1, 127],
  [-2, 127],
  [-128, 127],
  [-129, 127],
  [-130, 127],
  [3221226505, 127],
  [4294967295, 127],
];

const BASH = 'C:/Program Files/Git/bin/bash.exe';
const BASH_PRESENT = existsSync(BASH);

describe('posixShellRendering: what a bash prompt shows instead of the truth', () => {
  it.each(MEASURED_BASH_RENDERING)(
    'raw %i renders as %i, matching the 2026-09-07 measurement',
    (raw, rendered) => {
      expect(posixShellRendering(raw)).toBe(rendered);
    },
  );

  it('collapses EVERY high-bit status onto one number, which is why 127 is not a class', () => {
    const distinctStatuses = [0xc0000409, 0xc0000005, 0xc000013a, 0xc0000374, 0xffffffff, -1];
    const rendered = new Set(distinctStatuses.map((c) => posixShellRendering(c)));
    // Six genuinely different faults, one number at the prompt.
    expect(rendered).toStrictEqual(new Set([POSIX_ABNORMAL_RENDERING]));
    expect(new Set(distinctStatuses.map((c) => toUnsigned32(c))).size).toBe(5);
  });

  it('is null for a code that does not exist', () => {
    expect(posixShellRendering(null)).toBeNull();
  });
});

describe.skipIf(!BASH_PRESENT)(
  'the live cross-check: the table is the SHELL speaking, not this module',
  () => {
    /** Ask the real Git Bash what it reports for a raw Windows exit code. */
    function askBash(raw: number): number {
      const out = execFileSync(
        BASH,
        ['-c', `node -e "process.exitCode = ${String(raw)}" ; echo $?`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return Number(out.trim().split(/\s+/).at(-1));
    }

    it('agrees with the real shell on the ordinary, the oversized and the abnormal', () => {
      // One of each kind. Four subprocesses, not seventeen: this is a control
      // on the table, not a re-run of it.
      for (const raw of [1, 255, 383, 3221226505]) {
        expect(askBash(raw), `bash disagrees about raw ${String(raw)}`).toBe(
          posixShellRendering(raw),
        );
      }
    });

    it('shows the shell really does destroy the distinction', () => {
      // The vacuity control for the test above: if bash preserved codes, these
      // two would differ, and every conclusion in this file would be wrong.
      expect(askBash(3221226505)).toBe(askBash(-1));
      expect(askBash(3221226505)).toBe(127);
    });
  },
  60_000,
);

describe('classifyExit', () => {
  it('names 0xC0000409 as an abnormal termination, with the status name', () => {
    const c = classifyExit(-1073740791);
    expect(c.kind).toBe('abnormal');
    expect(c.hex).toBe('0xC0000409');
    expect(c.statusName).toContain('STATUS_STACK_BUFFER_OVERRUN');
    expect(c.posixShellWouldReport).toBe(127);
  });

  it('reads the SIGNED and UNSIGNED spellings of one status as the same thing', () => {
    // The ledger has written this status both ways; they must not read as two
    // different faults.
    expect(classifyExit(-1073740791).hex).toBe(classifyExit(3221226505).hex);
    expect(classifyExit(-1073740791).kind).toBe(classifyExit(3221226505).kind);
  });

  it('does NOT call an ordinary red suite abnormal', () => {
    expect(classifyExit(1).kind).toBe('normal');
    expect(classifyExit(127).kind).toBe('normal');
    expect(classifyExit(0).kind).toBe('ok');
  });

  it('a literal 127 is a NORMAL code and says nothing about a Windows fault', () => {
    // The whole confusion, pinned: the number 127 arriving raw from cmd.exe is
    // a program's chosen code, and the number 127 arriving from bash is
    // unrecoverable. The classifier must not conflate them.
    const raw127 = classifyExit(127);
    expect(raw127.kind).toBe('normal');
    expect(raw127.posixShellWouldReport).toBe(127);
    expect(classifyExit(0xc0000409).posixShellWouldReport).toBe(127);
    expect(classifyExit(0xc0000409).kind).not.toBe(raw127.kind);
  });

  it('separates oversized from abnormal instead of folding them together', () => {
    expect(classifyExit(383).kind).toBe('oversized');
    expect(classifyExit(383).posixShellWouldReport).toBe(127);
  });

  it('reports a signal death as having no exit code at all', () => {
    const c = classifyExit(null, 'SIGTERM');
    expect(c.kind).toBe('signalled');
    expect(c.code).toBeNull();
    expect(c.posixShellWouldReport).toBeNull();
  });

  it('names only statuses this project has observed, never a generic table (G6)', () => {
    expect(Object.keys(OBSERVED_STATUS_NAMES).length).toBeLessThanOrEqual(8);
    expect(toHex(0xc0000409)).toBe('0xC0000409');
  });
});

describe('the RUNNER uses it — a separate claim from the classifier being right', () => {
  function explain(code: string): Record<string, unknown> {
    const out = execFileSync(process.execPath, [RUNNER, '--explain', code], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out) as Record<string, unknown>;
  }

  it('answers "I saw exit N" through the real script', () => {
    const c = explain('-1073740791');
    expect(c.kind).toBe('abnormal');
    expect(c.hex).toBe('0xC0000409');
    expect(c.posixShellWouldReport).toBe(127);
    expect(String(c.note)).toContain('ABNORMAL TERMINATION');
  }, 30_000);

  it('and does not call an ordinary code abnormal — the vacuity control', () => {
    expect(explain('1').kind).toBe('normal');
  }, 30_000);

  it('writes NOTHING while explaining: the ledger is a record of runs', () => {
    // BOTH STATES, because the ledger lives in the private lab/ repository and a
    // clone or a CI runner has none. This test used to stat it unconditionally,
    // and on v0.7.0's first `main` push it failed there with ENOENT. Where it
    // exists, explaining must leave it byte-identical; where it does not,
    // explaining must not create it (or its directory).
    if (existsSync(LEDGER)) {
      const before = statSync(LEDGER);
      const beforeText = readFileSync(LEDGER, 'utf8');
      explain('3221226505');
      expect(statSync(LEDGER).size).toBe(before.size);
      expect(readFileSync(LEDGER, 'utf8')).toBe(beforeText);
    } else {
      explain('3221226505');
      expect(existsSync(LEDGER), 'explaining created the ledger').toBe(false);
      expect(existsSync(dirname(LEDGER)), 'explaining created the ledger directory').toBe(false);
    }
  }, 30_000);

  it('records the class per run, so the next death names its own fault', () => {
    // The wiring, asserted where a mutation can reach it: deleting the
    // `exitClass` line from the record leaves every test above green.
    const source = readFileSync(RUNNER, 'utf8');
    expect(source).toContain("import { classifyExit } from './exit-class.mjs'");
    expect(source).toMatch(/exitClass:\s*classifyExit\(code, signal \?\? null\)/);
  });
});

describe('the verdict vocabulary — a run that never started is not a death', () => {
  /*
   * ADDED AFTER `phase-verifier` FOUND THE LEDGER COMMITTING THIS PHASE'S OWN
   * DEFECT ONE LEVEL IN.
   *
   * The original rule was `non-zero AND no summary -> DEATH`. A `globalSetup`
   * that throws exits 1 with no summary, so seventeen guard refusals in
   * `1c-block3` were recorded as DEATHs — in the same column as a Windows
   * fail-fast, which is precisely the conflation this file exists to undo.
   * A DEATH now requires an ABNORMAL code; an ordinary one is a
   * `startup-error`.
   *
   * Asserted against the SOURCE because the alternative is running the real
   * suite twenty times to produce one of each verdict, and the classifier this
   * rests on is pinned behaviourally above and through `--explain`.
   */
  const source = readFileSync(RUNNER, 'utf8');

  it('a DEATH requires the exit code to be abnormal, not merely non-zero', () => {
    expect(source).toMatch(/classifyExit\(code, signal \?\? null\)\.kind === 'abnormal'/);
    expect(source).toContain("'startup-error'");
  });

  it('names all four verdicts, so none is silently folded into "passed"', () => {
    for (const verdict of ['passed', 'failed', 'DEATH', 'startup-error']) {
      expect(source, verdict).toContain(`'${verdict}'`);
    }
    // The arithmetic that would otherwise count a startup-error as a pass.
    expect(source).toMatch(/results\.length - deaths\.length - failed\.length - startupErrors\.length/);
  });

  it('fails the wrapper on a startup-error too — a block whose denominator shrinks is worse', () => {
    expect(source).toMatch(/deaths\.length > 0 \|\| startupErrors\.length > 0/);
  });

  it('CONTROL: the classifier really separates the two codes this rests on', () => {
    // 1 is what a globalSetup throw exits with; 0xC0000409 is the fail-fast.
    expect(classifyExit(1).kind).toBe('normal');
    expect(classifyExit(-1073740791).kind).toBe('abnormal');
  });
});
