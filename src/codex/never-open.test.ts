/**
 * G10 — the Codex never-open list (PLAN.md v0.6.0 DoD 2.1).
 *
 * Spec C10: "A test greps the engine source for each name and asserts it
 * appears only in that list."
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THAT WOULD MAKE THIS TEST VACUOUS, AND HOW IT IS AVOIDED
 * ---------------------------------------------------------------------------
 *
 * This file is under `src/codex/`, so it is one of the files the grep walks.
 * If it spelled the forbidden names out in its own assertions it would be the
 * single file that could never satisfy the property it asserts — and the only
 * ways out of that are to exempt the test file (which is the self-exemption
 * door rule 18 records) or to narrow the walk (which is the extension
 * allow-list door). So the needles are DERIVED from the exported constants and
 * no literal appears here at all. The walk covers every `.ts` under
 * `src/codex/`, this file included, with no exemption of any kind.
 *
 * A derived needle list has its own failure mode — an empty or truncated list
 * greps for nothing and passes — so every needle is asserted to occur at least
 * once in `never-open.ts` before it is asserted to occur nowhere else. That is
 * the vacuity control, and it is the assertion that goes red if the list is
 * silently emptied.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  CODEX_NEVER_OPEN,
  CODEX_NEVER_OPEN_DIR_NAMES,
  CODEX_NEVER_OPEN_NAMES,
  CODEX_NEVER_OPEN_SUFFIXES,
  isNeverOpen,
  isNeverOpenName,
} from './never-open.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIST_FILE = 'never-open.ts';

/**
 * The SECOND, independent statement of the same list in this repository.
 *
 * `scripts/capture-codex.mjs` names the paths a harvest must never copy, and
 * `src/release/codex-capture.test.ts` already asserts three of them by name.
 * Cross-checking against it is what stops this file's assertions from being
 * self-consistent and empty: every other constant here is DERIVED from the
 * module under test, so a name silently dropped from the list would leave
 * every derived assertion green. Found by mutation testing — deleting one
 * name survived the whole file until this anchor and the literal count below
 * were added.
 *
 * The engine list is a strict SUPERSET: the model cache joined by dated
 * amendment on 2026-09-03, after that script was written, so equality would be
 * the wrong assertion and a count is pinned beside the set instead (rule 19).
 */
const CAPTURE_SCRIPT = resolve(HERE, '..', '..', 'scripts', 'capture-codex.mjs');
let captureNeverOpen: readonly string[] = [];

beforeAll(async () => {
  const mod = (await import(pathToFileURL(CAPTURE_SCRIPT).href)) as {
    NEVER_OPEN: readonly string[];
  };
  captureNeverOpen = mod.NEVER_OPEN;
}, 30_000);

/**
 * Every name the grep must police, taken from the module under test.
 *
 * The three suffixes overlap by construction — one is a prefix of the other two
 * — which is harmless: each is still asserted to occur only in the list file.
 */
const NEEDLES: readonly string[] = [
  ...CODEX_NEVER_OPEN_NAMES,
  ...CODEX_NEVER_OPEN_DIR_NAMES,
  ...CODEX_NEVER_OPEN_SUFFIXES,
];

/** Every `.ts` file under `src/codex/`, recursively. No exemptions. */
function engineSourceFiles(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        out.push({ name: rel, text: readFileSync(join(dir, entry.name), 'utf8') });
      }
    }
  };
  walk(HERE, '');
  return out;
}

function countOf(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

describe('G10 — the list itself', () => {
  it('is non-empty and names every class the spec names', () => {
    expect(CODEX_NEVER_OPEN_NAMES.length).toBeGreaterThan(0);
    expect(CODEX_NEVER_OPEN_DIR_NAMES.length).toBeGreaterThan(0);
    expect(CODEX_NEVER_OPEN_SUFFIXES.length).toBeGreaterThan(0);
    expect(NEEDLES.length).toBe(
      CODEX_NEVER_OPEN_NAMES.length +
        CODEX_NEVER_OPEN_DIR_NAMES.length +
        CODEX_NEVER_OPEN_SUFFIXES.length,
    );
  });

  it('is the exact set of the three classes, spelled as the spec spells them', () => {
    // Rule 19's shape, applied to a list rather than to an artifact: the exact
    // set AND the count, so a silent truncation cannot pass by containment.
    const expected = [
      ...CODEX_NEVER_OPEN_NAMES,
      ...CODEX_NEVER_OPEN_DIR_NAMES.map((d) => `${d}/**`),
      ...CODEX_NEVER_OPEN_SUFFIXES.map((s) => `*${s}`),
    ];
    expect([...CODEX_NEVER_OPEN].sort()).toEqual([...expected].sort());
    expect(CODEX_NEVER_OPEN.length).toBe(expected.length);
  });

  it('has exactly 8 entries: 4 files, 1 directory, 3 suffixes', () => {
    // The count as a LITERAL, which is the one assertion in this file that is
    // not derived from the module under test and so can see a silent drop.
    // Rule 19: the count is pinned beside the set, never instead of it.
    expect(CODEX_NEVER_OPEN_NAMES.length).toBe(4);
    expect(CODEX_NEVER_OPEN_DIR_NAMES.length).toBe(1);
    expect(CODEX_NEVER_OPEN_SUFFIXES.length).toBe(3);
    expect(CODEX_NEVER_OPEN.length).toBe(8);
  });

  it('covers every path the capture script refuses to copy (an outside anchor)', () => {
    expect(captureNeverOpen.length).toBeGreaterThan(0);
    for (const entry of captureNeverOpen) {
      // The script spells a directory bare and a suffix with a leading star.
      const probe = entry.startsWith('*') ? `threads${entry.slice(1)}` : entry;
      expect(isNeverOpenName(probe), `${entry} must stay on the engine's list`).toBe(true);
    }
  });

  it('is a strict superset of the capture list, by exactly the 2026-09-03 amendment', () => {
    const mine = new Set(CODEX_NEVER_OPEN.map((e) => e.replace('/**', '')));
    const theirs = new Set(captureNeverOpen.map((e) => e.replace('/**', '')));
    const extra = [...mine].filter((e) => !theirs.has(e));
    const missing = [...theirs].filter((e) => !mine.has(e));
    expect(missing).toEqual([]);
    expect(extra).toHaveLength(1);
  });
});

describe('G10 — the grep over every file under src/codex/', () => {
  const files = engineSourceFiles();

  it('walks more than the list file itself (the walk is not empty)', () => {
    // Without this, a broken walk returning [] would make every assertion
    // below pass while looking at nothing.
    expect(files.length).toBeGreaterThan(1);
    expect(files.map((f) => f.name)).toContain(LIST_FILE);
  });

  it.each(NEEDLES)('%s occurs at least once in the list file (vacuity control)', (needle) => {
    const list = files.find((f) => f.name === LIST_FILE);
    expect(list, 'the list file must be among the walked files').toBeDefined();
    expect(countOf(list?.text ?? '', needle)).toBeGreaterThan(0);
  });

  it.each(NEEDLES)('%s appears ONLY in the list file', (needle) => {
    const offenders = files
      .filter((f) => f.name !== LIST_FILE)
      .filter((f) => countOf(f.text, needle) > 0)
      .map((f) => f.name);
    expect(
      offenders,
      `${needle} is named outside ${LIST_FILE}: a module that reaches for a ` +
        `G10 path has to write its name, and writing it is what this test sees`,
    ).toEqual([]);
  });
});

describe('isNeverOpenName — the form a directory walk can ask before touching anything', () => {
  it.each([...CODEX_NEVER_OPEN_NAMES])('%s is on the list', (name) => {
    expect(isNeverOpenName(name)).toBe(true);
  });

  it.each([...CODEX_NEVER_OPEN_DIR_NAMES])('%s is on the list', (name) => {
    expect(isNeverOpenName(name)).toBe(true);
  });

  it.each([...CODEX_NEVER_OPEN_SUFFIXES])('a file ending %s is on the list', (suffix) => {
    expect(isNeverOpenName(`threads${suffix}`)).toBe(true);
    expect(isNeverOpenName(`a.b.c${suffix}`)).toBe(true);
  });

  it('matches case-insensitively, in the refusing direction', () => {
    for (const name of NEEDLES) {
      expect(isNeverOpenName(name.toUpperCase())).toBe(true);
    }
  });

  it('does not condemn a transcript, a lock or an ordinary directory', () => {
    for (const name of [
      'rollout-2026-09-03T00-54-10-01a0641d-8281-7703-97fa-5a829bb77563.jsonl',
      'sessions',
      'thread-writer-locks',
      '.coordination.lock',
      '2026',
      '09',
      '03',
      'hooks.json',
      'config.toml',
    ]) {
      expect(isNeverOpenName(name), `${name} must NOT be refused`).toBe(false);
    }
  });

  it('does not match a suffix appearing anywhere but the end', () => {
    for (const suffix of CODEX_NEVER_OPEN_SUFFIXES) {
      expect(isNeverOpenName(`a${suffix}.jsonl`)).toBe(false);
    }
  });
});

describe('isNeverOpen — resolved against a data root', () => {
  const root = join('C:', 'fake', '.codex');

  it.each([...CODEX_NEVER_OPEN_NAMES])('%s directly under the root is on the list', (name) => {
    expect(isNeverOpen(root, join(root, name))).toBe(true);
  });

  it.each([...CODEX_NEVER_OPEN_SUFFIXES])('a file ending %s under the root is on the list', (s) => {
    expect(isNeverOpen(root, join(root, `threads${s}`))).toBe(true);
  });

  it('condemns everything beneath a forbidden directory', () => {
    for (const dir of CODEX_NEVER_OPEN_DIR_NAMES) {
      expect(isNeverOpen(root, join(root, dir))).toBe(true);
      expect(isNeverOpen(root, join(root, dir, 'a', 'b.txt'))).toBe(true);
    }
  });

  it('condemns an exact name at any depth, which is the widening in the safe direction', () => {
    for (const name of CODEX_NEVER_OPEN_NAMES) {
      expect(isNeverOpen(root, join(root, 'sessions', '2026', '09', name))).toBe(true);
    }
  });

  it('leaves the root itself, and a transcript under it, alone', () => {
    expect(isNeverOpen(root, root)).toBe(false);
    expect(
      isNeverOpen(root, join(root, 'sessions', '2026', '09', '03', 'rollout-a-b.jsonl')),
    ).toBe(false);
  });

  it('claims nothing about a path outside the root', () => {
    // The list is a statement about the Codex data root. A file of the same
    // name in a user's project is not this predicate's business, and the engine
    // never reaches outside the root anyway.
    for (const name of CODEX_NEVER_OPEN_NAMES) {
      expect(isNeverOpen(root, join('C:', 'someone', 'else', name))).toBe(false);
    }
  });

  it('compares the root case-insensitively rather than dropping the match', () => {
    for (const name of CODEX_NEVER_OPEN_NAMES) {
      expect(isNeverOpen(root.toUpperCase(), join(root, name))).toBe(true);
    }
  });

  it('accepts both separators on either side', () => {
    for (const name of CODEX_NEVER_OPEN_NAMES) {
      expect(isNeverOpen('C:/fake/.codex', `C:\\fake\\.codex\\${name}`)).toBe(true);
      expect(isNeverOpen('C:\\fake\\.codex', `C:/fake/.codex/${name}`)).toBe(true);
    }
  });
});
