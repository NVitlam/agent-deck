/**
 * DoD 2.3 — one committed golden `StatsRecord` per committed session, three
 * engines, plus every R8 fixture, asserted BYTE FOR BYTE.
 *
 * The population is discovered from disk, never listed here: the recorded rule
 * against asserting fixture-set sizes is that a count hard-coded against one
 * capture breaks on the next harvest and reads as a regression. What IS
 * asserted is that the population is non-trivial and covers all three engines,
 * because a discovery bug that finds nothing satisfies "every golden matches".
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  CORPUS_READ_BUDGET_MS,
} from './corpus.testkit.js';
import {
  STATS_GOLDEN_DIR,
  SYNTHETIC_STATS_DIR,
  allGoldenEntries,
  readCorpusSessions,
} from './corpus.stats.testkit.js';
import type { GoldenEntry } from './corpus.stats.testkit.js';
import { validateStatsRecord } from './schema.js';
import { buildSyntheticStatsFixtures } from './synthetic.testkit.js';

let entries: GoldenEntry[] = [];

/**
 * The cold read of all three corpora, hoisted into a hook with an EXPLICIT
 * budget.
 *
 * `corpus.testkit.ts` records why: a test that carries no explicit budget
 * reports an over-running read as a TIMEOUT with no failing assertion, which
 * reads green in the summary line, and that cost two of the thirty runs in the
 * Phase 1c block. The tests below keep the 5 s default and do only their own
 * work.
 */
beforeAll(async () => {
  entries = await allGoldenEntries();
}, CORPUS_READ_BUDGET_MS);

describe('the population is real', () => {
  it('covers all three engines and both sources', async () => {
    const sessions = await readCorpusSessions();
    const engines = new Set(sessions.map((s) => s.engine));
    expect([...engines].sort()).toEqual(['cc', 'codex', 'opencode']);
    // A floor, not an equality: the number moves with every harvest, and this
    // is here to catch a discovery bug that finds one corpus of six — which
    // `corpus.testkit.ts` records as a real event that made every sweep test
    // pass over a sixth of the data.
    expect(sessions.length).toBeGreaterThan(15);
    expect(entries.filter((e) => e.source === 'corpus')).toHaveLength(sessions.length);
    expect(entries.filter((e) => e.source === 'synthetic')).toHaveLength(
      buildSyntheticStatsFixtures().length,
    );
  });

  it('every golden name follows <engine>-<version>-<session>', () => {
    for (const entry of entries) {
      expect(entry.stem).toMatch(/^(cc|opencode|codex)-[^/\\]+$/u);
      // A stem that could not be a filename would be written somewhere
      // surprising rather than failing.
      expect(entry.stem).not.toMatch(/[/\\:*?"<>|]/u);
    }
  });
});

describe('DoD 2.3 — byte equality', () => {
  it('every derived record equals its committed golden, byte for byte', async () => {
    const missing: string[] = [];
    const differing: string[] = [];
    for (const entry of entries) {
      const path = join(STATS_GOLDEN_DIR, `${entry.stem}.json`);
      let committed: string;
      try {
        committed = await readFile(path, 'utf8');
      } catch {
        missing.push(entry.stem);
        continue;
      }
      if (committed !== entry.text) differing.push(entry.stem);
    }
    expect({ missing, differing }).toEqual({ missing: [], differing: [] });
  });

  it('the golden directory holds nothing else', async () => {
    // The exact set AND the exact count, per working-method rule 19. A
    // containment check ("every golden we expect is present") passes with a
    // stale file beside it forever — and a stale golden is worse than a missing
    // one, because it keeps passing its own byte comparison while describing a
    // session that no longer exists.
    const onDisk = (await readdir(STATS_GOLDEN_DIR))
      .filter((name) => name !== 'README.md')
      .sort();
    const expected = entries.map((e) => `${e.stem}.json`).sort();
    expect(onDisk).toEqual(expected);
    expect(onDisk).toHaveLength(entries.length);
  });

  it('every committed R8 fixture is the one the builder produces', async () => {
    // The R8 session fixtures are committed so the INPUT to each synthetic
    // golden is reviewable on its own. That creates a second thing that can
    // drift from its builder, which `src/opencode/synthetic.ts` gives as its
    // reason for committing nothing. Rebuilding and comparing removes the
    // drift: the file on disk cannot be edited without this going red.
    const onDisk = (await readdir(SYNTHETIC_STATS_DIR))
      .filter((name) => name !== 'README.md')
      .sort();
    const fixtures = buildSyntheticStatsFixtures();
    expect(onDisk).toEqual(fixtures.map((f) => `${f.id}.json`).sort());
    for (const fixture of fixtures) {
      const committed = await readFile(join(SYNTHETIC_STATS_DIR, `${fixture.id}.json`), 'utf8');
      const rebuilt = `${JSON.stringify(
        { id: fixture.id, manufactures: fixture.manufactures, state: fixture.state },
        null,
        2,
      )}\n`;
      expect(committed).toBe(rebuilt);
    }
  });
});

describe('every golden is a valid record', () => {
  it('passes the runtime validator, read back off disk', async () => {
    // Read from DISK rather than from `entries`, so this is a statement about
    // the committed bytes rather than about the object that produced them. A
    // record that serialises to something the validator rejects would otherwise
    // be invisible until Phase 3's store read it back.
    let checked = 0;
    for (const entry of entries) {
      const text = await readFile(join(STATS_GOLDEN_DIR, `${entry.stem}.json`), 'utf8');
      const verdict = validateStatsRecord(JSON.parse(text));
      expect({ stem: entry.stem, ...verdict }).toEqual({ stem: entry.stem, ok: true, errors: [] });
      checked += 1;
    }
    expect(checked).toBe(entries.length);
    expect(checked).toBeGreaterThan(20);
  });
});

describe('the goldens are reproducible, not merely present', () => {
  it('deriving the whole population twice produces identical bytes', async () => {
    // The property that makes a golden evidence at all. It also catches the
    // deriver mutating its input: the second pass reads the same `SessionState`
    // objects, so a mutation in the first would show up here.
    const second = await allGoldenEntries();
    expect(second.map((e) => e.text)).toEqual(entries.map((e) => e.text));
  });
});
