// Source hygiene: no raw control characters in tracked source.
//
// WHY THIS FILE EXISTS. `CLAUDE.md` has carried the rule since Phase 4 —
// "Never write a raw control character into source. Escapes, always." — and
// until Phase 5 nothing enforced it. It was written after a worker put a
// literal `0x00` into a guard instead of `\0`, which made the file BINARY TO
// GIT (no reviewable diff, ever again) and compounded the documented `grep -a`
// hazard. Phase 4 then hit the same class twice more.
//
// Phase 5 hit it a fourth time, in the orchestrator's own files, by a route
// none of those anticipated: a scripted edit wrote its output with
// `writeFileSync(path, text, 'latin1')`, and latin1 encodes a char by
// TRUNCATING its code point to the low byte. Em-dash is U+2014, so every one of
// them landed as `0x14` (DC4). Seven bytes, in prose that then reads as a gap.
//
// NOTHING CAUGHT IT. `tsc`, `eslint`, `vitest` and `scripts/privacy-sweep.mjs`
// were all green over those seven bytes; the phase verifier found them by
// scanning. That is the argument for this test: every existing gate is blind to
// a byte that is neither a syntax error nor a secret, and the failure mode is
// silent corruption of the one thing this repo leans on hardest — the prose
// that explains why the code is the way it is.
//
// SCOPE. Source, not data. `fixtures/` is deliberately excluded: it holds bytes
// captured from real sessions and from SQLite databases, and normalising a
// recording is how you stop it being a recording. This is about files a human
// wrote.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Directories whose files are hand-written source or hand-written prose.
 *
 * `fixtures/` is absent on purpose — see the header: it holds bytes captured
 * from real sessions, and normalising a recording is how you stop it being a
 * recording.
 *
 * **`docs/` and the root markdown ARE in scope, and the first version of this
 * file had them out.** That omission mattered: the latin1 defect this guard
 * exists for landed in `PLAN.md` BEFORE it landed in any `.ts`, by the same
 * scripted-splice route, and a source-only guard could never have seen it. The
 * prose in this repository is load-bearing — it is where every decision's
 * reasoning lives — so a control byte silently eating a word there costs more
 * than one in a comment.
 *
 * `docs/evidence/ui-states/*.dom.txt` is captured DOM rather than prose, and it
 * stays out by the `fixtures/` argument — `.txt` is simply not in the
 * extension list below.
 */
const SOURCE_PREFIXES = ['src/', 'webview/', 'scripts/', 'spike/', '.github/', 'docs/'];

/**
 * Extensions that are text by construction.
 *
 * Root-level markdown is picked up by {@link ROOT_TEXT_FILES} rather than by a
 * prefix, since the root is not a directory prefix anyone can name.
 */
const TEXT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.svelte',
  '.json',
  '.yml',
  '.yaml',
  '.md',
];

/** Tracked root-level documents, which no prefix in SOURCE_PREFIXES matches. */
const ROOT_TEXT_FILES = [
  'CLAUDE.md',
  'HANDOVER.md',
  'PLAN.md',
  'README.md',
  'SECURITY.md',
  'AGENTS.md',
  'agent-deck-spec.md',
];

/**
 * The ONE tracked source file that legitimately contains a control byte.
 *
 * `src/parser/parse.test.ts` carries exactly one NUL as deliberate fuzz input —
 * a parser that is not tested against a NUL is not tested against the input a
 * real transcript can carry. `CLAUDE.md` records it, and records that it is
 * exactly one byte rather than the 884 an earlier handoff claimed.
 *
 * It is pinned by COUNT, not merely allowed: a second NUL appearing in it is
 * as much a defect as a first NUL anywhere else, and an allow-entry with no
 * number would hide that.
 */
const ALLOWED: ReadonlyMap<string, number> = new Map([
  ['src/parser/parse.test.ts', 1],
  /**
   * A raw `0x08` (backspace), pre-existing, introduced by the Phase 0 archive
   * commit — found only when this guard's scope widened to markdown.
   *
   * **Allowed rather than repaired, and the reason is not laziness.**
   * `docs/PLAN-v2.md` is the BYTE-IDENTICAL archive of the superseded v2 plan.
   * `PLAN.md` and `CLAUDE.md` both state that its closed-phase records are
   * never altered, and "byte-identical" stops being true the moment this file
   * tidies one. So it is pinned by count: the byte cannot multiply, and the
   * archive stays what it claims to be.
   */
  ['docs/PLAN-v2.md', 1],
]);

/**
 * A control byte, for this test's purposes.
 *
 * Tab (0x09), LF (0x0a) and CR (0x0d) are excluded because they are the
 * repository's ordinary whitespace — `src/` is CRLF and that is deliberate.
 * Everything else below 0x20, plus DEL, is a byte no one types on purpose.
 */
function isControl(byte: number): boolean {
  if (byte === 0x09 || byte === 0x0a || byte === 0x0d) return false;
  return byte < 0x20 || byte === 0x7f;
}

function trackedSourceFiles(): readonly string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter((p) => p.length > 0)
    .filter(
      (p) =>
        SOURCE_PREFIXES.some((prefix) => p.startsWith(prefix)) || ROOT_TEXT_FILES.includes(p),
    )
    .filter((p) => TEXT_EXTENSIONS.some((ext) => p.endsWith(ext)));
}

interface Offender {
  readonly file: string;
  readonly byte: string;
  readonly line: number;
  readonly count: number;
}

function scan(file: string): readonly Offender[] {
  const buf = readFileSync(join(REPO_ROOT, file));
  const found = new Map<string, { line: number; count: number }>();
  let line = 1;
  for (const byte of buf) {
    if (byte === 0x0a) {
      line++;
      continue;
    }
    if (!isControl(byte)) continue;
    const key = `0x${byte.toString(16).padStart(2, '0')}`;
    const seen = found.get(key);
    if (seen === undefined) found.set(key, { line, count: 1 });
    else seen.count++;
  }
  return [...found].map(([byte, { line: at, count }]) => ({ file, byte, line: at, count }));
}

describe('source hygiene: no raw control characters', () => {
  const files = trackedSourceFiles();

  it('finds a non-trivial set of source files to scan', () => {
    // Vacuity control, and not a formality: every assertion below is over this
    // list, so a `git ls-files` that returned nothing — a detached checkout, a
    // changed prefix, a renamed directory — would make the whole file pass
    // while scanning zero bytes. That is this repo's recorded "a suite that
    // fails to collect reads green" shape, reached through data instead of
    // through an import.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('src/model/events.ts');
    expect(files).toContain('webview/canvas-contract.ts');
    expect(files).toContain('src/parser/parse.test.ts');
    // The prose half, which the first version of this file did not scan. PLAN.md
    // is named explicitly because it is the file the defect hit first and the
    // one most often edited by script.
    expect(files).toContain('PLAN.md');
    expect(files).toContain('CLAUDE.md');
    expect(files).toContain('docs/PLAN-v2.md');
  });

  it('no tracked source file carries a control byte outside the allow-list', () => {
    const offenders = files
      .flatMap((file) => scan(file))
      .filter((o) => {
        const allowance = ALLOWED.get(o.file);
        return allowance === undefined || o.count !== allowance;
      });

    // The message is the product here. A bare count tells whoever hits this
    // nothing, and the bytes are invisible in an editor by definition.
    const detail = offenders
      .map((o) => `${o.file}:${o.line} carries ${o.count}x ${o.byte}`)
      .join('\n');
    expect(offenders, `raw control bytes in tracked source:\n${detail}`).toEqual([]);
  });

  it('the one allowed control byte is still exactly where and what it claims', () => {
    // The allow-list is pinned by count, so this asserts the entry describes
    // reality rather than merely excusing it. If the deliberate NUL is ever
    // removed, this fails and the allow-entry gets deleted with it — an
    // allowance that outlives its reason is how allow-lists rot.
    for (const [file, expected] of ALLOWED) {
      // Not hard-coded to NUL any more: the second entry's byte is 0x08. What
      // is asserted is that the file still carries exactly ONE control byte of
      // exactly one kind, which is what the allowance claims.
      const found = scan(file);
      expect(found, `${file} no longer carries its documented control byte`).toHaveLength(1);
      expect(found[0]?.count).toBe(expected);
    }
  });

  it('the scanner detects a control byte when one is present', () => {
    // Vacuity control for `scan` itself. Without this, a bug that made `scan`
    // always return [] would turn the assertion above into a permanent pass —
    // the exact failure this file exists to prevent, one level up.
    expect(ALLOWED.has('src/parser/parse.test.ts')).toBe(true);
    const known = scan('src/parser/parse.test.ts');
    expect(known.some((o) => o.byte === '0x00')).toBe(true);
  });
});
