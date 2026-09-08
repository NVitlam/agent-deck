/**
 * DoD 2.10 — a Codex record is the same on any machine, and mtime is why it
 * was not.
 *
 * User ruling, 2026-09-08: *"Codex `endedAt` never derives from mtime — from
 * the last record timestamp in the rollout, else `unavailable`. Regenerate
 * affected goldens; prove determinism by generating from a copied tree (mtimes
 * reset) and diffing."*
 *
 * ## What was wrong, measured rather than suspected
 *
 * `src/codex/graft.ts` set `endedAt: thread.mtimeMs` for any thread that was
 * not running, reasoning that a finished thread stops being written when it
 * stops. That is true of the SESSION and false of the FILE. Measured at the
 * Phase 2 gate: **all four finished Codex sessions reported
 * `2026-09-04T11:08:50Z`** — the mtime of their own rollout files in the
 * working tree that produced the reading, and nothing whatever about the
 * capture. Git does not preserve mtimes, so two checkouts of byte-identical
 * bytes disagree.
 *
 * The engine now reads the last record's own envelope timestamp. The four
 * sessions report durations of 40.3 s, 56.6 s, 46.3 s and 13.5 s, and the
 * first of those independently corroborates a note `parse.ts` has carried
 * since Phase 1 — that on the baseline root the start and the file's last
 * write differ by 40 seconds. The number the mtime used to mean, when the
 * capture was fresh, is the number the content states permanently.
 *
 * ## Why this test copies the tree TWICE, with two different instants
 *
 * A single copy would prove only that the reader survives one unfamiliar
 * mtime. Two copies stamped decades apart, compared to each other AND to the
 * committed goldens, can only agree if no output depends on the attribute at
 * all — and if a future change reintroduces one, the two copies disagree and
 * this test names the field.
 *
 * **The staging that used to hide this is gone.** `corpus.stats.testkit.ts`
 * read Codex from a temp copy with mtimes PINNED, which would have satisfied
 * "generate twice and diff" whether or not the engine had ever been fixed —
 * the check-whose-subject-never-happens shape. It reads in place now, and this
 * file is the only thing that touches a temp copy.
 */

import { cpSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readCodexEngine } from '../codex/index.js';
import type { AgentNode, SessionState, TreeNode } from '../model/events.js';
import { isAgentNode } from '../model/events.js';

import { statsGoldenText } from './corpus.stats.testkit.js';
import { deriveStats } from './derive.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const GOLDEN_DIR = fileURLToPath(new URL('../../fixtures/golden/stats/', import.meta.url));

/** Two instants decades apart. Neither is any file's real mtime. */
const INSTANT_A = new Date('2001-02-03T04:05:06.000Z');
const INSTANT_B = new Date('2031-12-25T18:30:00.000Z');

const scratch: string[] = [];

afterAll(() => {
  // `test/scratch-guard.ts` fails the whole run over one leaked directory, and
  // 765 of them accumulated in %TEMP% before it existed.
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** The anchor corpus: the `codex-*` directory carrying a golden. */
function anchorCorpus(): { name: string; dir: string } {
  const name = readdirSync(FIXTURES)
    .filter((entry) => entry.startsWith('codex-'))
    .filter((entry) => statSync(join(FIXTURES, entry)).isDirectory())
    .filter((entry) => {
      try {
        return statSync(join(FIXTURES, entry, 'golden.json')).isFile();
      } catch {
        return false;
      }
    })
    .sort()[0];
  if (name === undefined) throw new Error('no Codex anchor corpus');
  return { name, dir: join(FIXTURES, name) };
}

/** Copy the corpus and stamp every file with `when`. */
function copyWithMtimes(source: string, when: Date): string {
  // `realpathSync.native` for the recorded libuv reason: a `RUNNER~1` short
  // path is the shape that aborts a process with no failing assertion.
  const stage = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-deck-codex-det-')));
  scratch.push(stage);
  const root = join(stage, 'corpus');
  cpSync(source, root, { recursive: true });
  const stamp = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stamp(full);
      else if (entry.isFile()) utimesSync(full, when, when);
    }
  };
  stamp(root);
  return root;
}

/** Every Codex session under one corpus directory, through the real engine. */
async function readSessions(corpusDir: string): Promise<SessionState[]> {
  const out: SessionState[] = [];
  for (const run of readdirSync(corpusDir).sort()) {
    const root = join(corpusDir, run, 'home', '.codex');
    try {
      if (!statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    const outcome = await readCodexEngine({ root });
    if (outcome.kind !== 'ok') continue;
    out.push(...outcome.result.sessions);
  }
  return out.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
}

function agentsOf(root: AgentNode): AgentNode[] {
  const out: AgentNode[] = [];
  const walk = (node: TreeNode): void => {
    if (!isAgentNode(node)) return;
    out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

let inPlace: SessionState[] = [];
let copyA: SessionState[] = [];
let copyB: SessionState[] = [];
let corpusName = '';

beforeAll(async () => {
  const anchor = anchorCorpus();
  corpusName = anchor.name;
  inPlace = await readSessions(anchor.dir);
  copyA = await readSessions(copyWithMtimes(anchor.dir, INSTANT_A));
  copyB = await readSessions(copyWithMtimes(anchor.dir, INSTANT_B));
}, 120_000);

describe('the subject is real', () => {
  it('read the same sessions three ways', () => {
    // Vacuity control before anything is compared: three empty arrays are
    // byte-identical and prove nothing at all.
    expect(inPlace.length).toBeGreaterThan(3);
    expect(copyA.map((s) => s.sessionId)).toEqual(inPlace.map((s) => s.sessionId));
    expect(copyB.map((s) => s.sessionId)).toEqual(inPlace.map((s) => s.sessionId));
  });

  it('the two copies really do carry different mtimes', () => {
    // The control on the control. If `cpSync` or `utimesSync` silently did
    // nothing, every assertion below would hold for the wrong reason — which
    // is exactly the state the OLD staging left this phase in.
    const a = copyWithMtimes(join(FIXTURES, corpusName), INSTANT_A);
    const b = copyWithMtimes(join(FIXTURES, corpusName), INSTANT_B);
    const oneFile = (dir: string): string => {
      const runs = readdirSync(dir).sort();
      const run = runs[0];
      if (run === undefined) throw new Error('no run in the corpus copy');
      return join(dir, run, 'manifest.json');
    };
    const mtimeOf = (dir: string): number => {
      try {
        return statSync(oneFile(dir)).mtimeMs;
      } catch {
        // Fall back to any file, so the control does not depend on a
        // manifest existing.
        const walk = (d: string): string | null => {
          for (const entry of readdirSync(d, { withFileTypes: true })) {
            const full = join(d, entry.name);
            if (entry.isDirectory()) {
              const found = walk(full);
              if (found !== null) return found;
            } else return full;
          }
          return null;
        };
        const file = walk(dir);
        if (file === null) throw new Error('no file in the corpus copy');
        return statSync(file).mtimeMs;
      }
    };
    expect(mtimeOf(a)).toBe(INSTANT_A.getTime());
    expect(mtimeOf(b)).toBe(INSTANT_B.getTime());
    expect(mtimeOf(a)).not.toBe(mtimeOf(b));
  }, 60_000);
});

describe('DoD 2.10 — no Codex output depends on a filesystem mtime', () => {
  it('two trees stamped thirty years apart yield identical SessionStates', () => {
    expect(JSON.stringify(copyB)).toBe(JSON.stringify(copyA));
    expect(JSON.stringify(copyA)).toBe(JSON.stringify(inPlace));
  });

  it('no AgentNode timestamp is any file’s mtime', () => {
    // The direct form of the defect. `endedAt` was `mtimeMs`; under
    // `INSTANT_A` every file's mtime is that instant, so if any timestamp
    // still came from the filesystem it would read `2001-02-03`.
    let checked = 0;
    for (const state of copyA) {
      for (const agent of agentsOf(state.root)) {
        expect(agent.startedAt).not.toBe(INSTANT_A.getTime());
        if (agent.endedAt !== undefined) {
          expect(agent.endedAt, `${state.sessionId}/${agent.id}`).not.toBe(INSTANT_A.getTime());
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('every stated end is at or after its start, and inside the session', () => {
    // A real end rather than merely a stable one. An mtime satisfied
    // "different from the start" too; what it could not do is fall inside the
    // window the records describe.
    let ended = 0;
    for (const state of copyA) {
      for (const agent of agentsOf(state.root)) {
        if (agent.endedAt === undefined) continue;
        expect(agent.endedAt, `${state.sessionId}/${agent.id}`).toBeGreaterThanOrEqual(
          agent.startedAt,
        );
        // The capture is from 2026-09-02/03. A filesystem-derived value would
        // sit outside that window on any machine but the one that captured it.
        expect(agent.endedAt).toBeGreaterThan(Date.parse('2026-09-01T00:00:00Z'));
        expect(agent.endedAt).toBeLessThan(Date.parse('2026-09-04T00:00:00Z'));
        ended += 1;
      }
    }
    expect(ended).toBeGreaterThan(0);
  });

  it('a running thread states no end at all', () => {
    // `unavailable` rather than a substitute, and the corpus carries the case:
    // one of the five threads is still running.
    const running = copyA.flatMap((s) =>
      agentsOf(s.root).filter((a) => a.status === 'running'),
    );
    expect(running.length).toBeGreaterThan(0);
    for (const agent of running) expect(agent.endedAt).toBeUndefined();
  });
});

describe('DoD 2.10 — the committed goldens regenerate from a copied tree', () => {
  it('records derived from the mtime-reset copy equal the committed bytes', async () => {
    // The ruling's own words: "generating from a copied tree (mtimes reset) and
    // diffing". The goldens on disk were generated from the working tree; these
    // come from a copy whose every file claims 2001, and they must match byte
    // for byte.
    const { readFile } = await import('node:fs/promises');
    let compared = 0;
    for (const state of copyA) {
      const stem = `codex-${corpusName.slice('codex-'.length)}-${state.sessionId}`;
      const committed = await readFile(join(GOLDEN_DIR, `${stem}.json`), 'utf8');
      const derived = statsGoldenText(deriveStats(state, { now: 1_700_000_000_000 }));
      expect(derived, stem).toBe(committed);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(3);
  });
});
