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
 * Directories whose files are hand-written source.
 *
 * `fixtures/` is absent on purpose — see the header. `docs/` is absent because
 * it carries captured evidence (`docs/evidence/ui-states/*.dom.txt` holds
 * rendered DOM), which is data by the same argument.
 */
const SOURCE_PREFIXES = ['src/', 'webview/', 'scripts/', 'spike/', '.github/'];

/** Extensions that are text by construction. */
const TEXT_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.svelte', '.json', '.yml', '.yaml'];

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
const ALLOWED: ReadonlyMap<string, number> = new Map([['src/parser/parse.test.ts', 1]]);

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
    .filter((p) => SOURCE_PREFIXES.some((prefix) => p.startsWith(prefix)))
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
      const nuls = scan(file).filter((o) => o.byte === '0x00');
      expect(nuls, `${file} no longer carries its documented control byte`).toHaveLength(1);
      expect(nuls[0]?.count).toBe(expected);
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
