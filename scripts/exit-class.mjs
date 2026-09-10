// What a process exit code MEANS on this platform, and what a POSIX shell will
// show you instead.
//
// v0.7.0 Phase 1c. This module exists because a whole death class in this
// repository's ledger was an artefact of the shell the gate happened to be
// typed into.
//
// ## THE MEASUREMENT THIS ENCODES
//
// A Windows process can exit with any 32-bit value. `cmd.exe` and PowerShell
// hand that value through unchanged. **Git Bash does not**: it renders the code
// the way a POSIX shell must, and a POSIX wait status has only eight bits for
// an exit code. Measured on 2026-09-07, Git Bash 2.x on Windows 11, one
// `node -e "process.exitCode = N"` per row:
//
// | raw exit code | Git Bash `$?` |
// |---|---|
// | 0..255 | itself |
// | 256 | 0 |
// | 383 | 127 |
// | 384 | 128 |
// | -1, -2, -128, -129, -130 | **127** |
// | 3221226505 (`0xC0000409`) | **127** |
// | 4294967295 (`0xFFFFFFFF`) | **127** |
//
// So: read the code as unsigned 32-bit; if its high bit is set it is reported
// as **127**, and otherwise as the code modulo 256. Every Windows *abnormal
// termination* status — every `0xC…` NTSTATUS, and every negative code — has
// the high bit set. **They all arrive at a bash prompt as 127.**
//
// ## WHY THAT MATTERS HERE, AND IT IS THE WHOLE POINT
//
// `127` is famously a POSIX shell's "command not found". This repository's
// ledger carried an exit-127 death class for six occurrences on that reading,
// and the reading is wrong: nothing in the chain was missing. `127` is what
// Git Bash prints when the process it ran was **killed by Windows**, and the
// real status — the thing that names the fault — has already been discarded by
// the time the shell prints it.
//
// A gate run must therefore be taken through a shell that preserves the code,
// which is what `scripts/test-run.mjs` does (`spawn(..., { shell: true })` uses
// `ComSpec`, i.e. `cmd.exe`). Reading a death out of a Git Bash scrollback
// tells you only that the process died.

/** What a POSIX shell has room for. */
const POSIX_EXIT_BITS = 256;

/** The value every high-bit Windows status collapses to at a bash prompt. */
export const POSIX_ABNORMAL_RENDERING = 127;

/**
 * The NTSTATUS values this project has actually observed, by name.
 *
 * Deliberately short. A lookup table of every NTSTATUS would be memory rather
 * than measurement (G6); these are the ones with a row in the ledger or a
 * bullet in `CLAUDE.md`.
 */
export const OBSERVED_STATUS_NAMES = Object.freeze({
  0xc0000409: 'STATUS_STACK_BUFFER_OVERRUN (Windows fail-fast)',
  0xc0000005: 'STATUS_ACCESS_VIOLATION',
  0xc000013a: 'STATUS_CONTROL_C_EXIT',
  0xc0000374: 'STATUS_HEAP_CORRUPTION',
});

/**
 * The code as Windows means it: unsigned 32-bit.
 *
 * Node reports a Windows exit code through `child.on('close')` as a SIGNED
 * 32-bit integer, so `0xC0000409` arrives as `-1073740791`. Both spellings name
 * one status and this repository has written it both ways.
 */
export function toUnsigned32(code) {
  return code >>> 0;
}

/** `0xC0000409` — the form a Windows debugger or `$LASTEXITCODE` shows. */
export function toHex(code) {
  return `0x${toUnsigned32(code).toString(16).toUpperCase().padStart(8, '0')}`;
}

/**
 * What Git Bash (or any POSIX shell) would print for a raw Windows exit code.
 *
 * The inverse is NOT computable, which is the finding: 127 at a bash prompt
 * could be a genuine `exit 127`, a genuine "command not found", or any of the
 * ~2 billion high-bit statuses. That is why it must not be recorded as a class.
 */
export function posixShellRendering(code) {
  if (code === null || code === undefined) return null;
  const unsigned = toUnsigned32(code);
  if ((unsigned & 0x80000000) !== 0) return POSIX_ABNORMAL_RENDERING;
  return unsigned % POSIX_EXIT_BITS;
}

/**
 * Classify a raw exit code.
 *
 * `kind` is the load-bearing field:
 *
 *   - `ok`          — 0.
 *   - `normal`      — 1..255. A program chose this; read it as a program's
 *                     verdict (a red suite, a refusal, a usage error).
 *   - `abnormal`    — high bit set. The process was TERMINATED: an NTSTATUS
 *                     from a fail-fast, an access violation, a `TerminateProcess`
 *                     with a negative code. No program chose this and no summary
 *                     line will exist.
 *   - `oversized`   — 256..0x7FFFFFFF. Legal for Windows, meaningless to POSIX;
 *                     recorded separately so it is never silently folded in.
 *   - `signalled`   — the process died on a signal; `code` is null.
 */
export function classifyExit(code, signal = null) {
  if (code === null || code === undefined) {
    return {
      code: null,
      signal,
      kind: 'signalled',
      hex: null,
      statusName: null,
      posixShellWouldReport: null,
      note: `terminated by ${String(signal ?? 'an unreported signal')}; no exit code exists`,
    };
  }

  const unsigned = toUnsigned32(code);
  const hex = toHex(code);
  const statusName = OBSERVED_STATUS_NAMES[unsigned] ?? null;
  const posix = posixShellRendering(code);

  if ((unsigned & 0x80000000) !== 0) {
    return {
      code,
      signal,
      kind: 'abnormal',
      hex,
      statusName,
      posixShellWouldReport: posix,
      note:
        `${hex}${statusName === null ? '' : ` — ${statusName}`}: a Windows ABNORMAL ` +
        `TERMINATION, not a code any program chose. A POSIX shell (Git Bash) would ` +
        `show this as ${String(posix)}, which is why an exit-127 reading is not a ` +
        `class. Read the raw code, never a bash $?.`,
    };
  }

  if (unsigned === 0) {
    return { code, signal, kind: 'ok', hex, statusName, posixShellWouldReport: posix, note: '' };
  }

  if (unsigned < POSIX_EXIT_BITS) {
    return {
      code,
      signal,
      kind: 'normal',
      hex,
      statusName,
      posixShellWouldReport: posix,
      note: 'a code the program chose; expect a summary line or a diagnostic to go with it',
    };
  }

  return {
    code,
    signal,
    kind: 'oversized',
    hex,
    statusName,
    posixShellWouldReport: posix,
    note: `${hex} is legal on Windows and does not fit a POSIX exit status; a POSIX shell would show ${String(posix)}`,
  };
}
