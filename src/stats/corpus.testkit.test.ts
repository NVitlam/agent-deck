/**
 * The corpus testkit's own contract — v0.7.0 Phase 1c.
 *
 * `corpus.testkit.ts` was changed on 2026-09-07 from "re-read and re-graft the
 * whole corpus on every call" to "read once per engine per worker, hand back a
 * deep-frozen array". Both halves of that are load-bearing and neither is
 * visible to the files that consume it:
 *
 *   - **memoised**, because the old shape parsed the committed corpora through
 *     the production path dozens of times per file and a single call could
 *     exceed vitest's 5 s default `testTimeout` on a loaded machine — which
 *     reports as a timeout with no failing assertion. It cost 2 of the 30 runs
 *     in the Phase 1c blocks.
 *   - **frozen**, because a memoised array is shared, and a test that mutated
 *     it would damage every later test in the file with the failure surfacing
 *     somewhere else entirely.
 *
 * THE FREEZE IS THE AUDIT. The alternative was reading every consumer and
 * asserting by inspection that none mutates; freezing makes the question
 * mechanical, since ESM is strict mode and an assignment to a frozen property
 * throws at the offending line. A consumer that legitimately needs to mutate
 * takes a `structuredClone` first — none does today.
 *
 * These tests are what stop either property being removed by someone who reads
 * `once()` as a caching nicety.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { SessionState } from '../model/events.js';

import {
  CORPUS_READ_BUDGET_MS,
  readCcSessions,
  readCodexSessions,
  readOpenCodeSessions,
  warmCorpus,
} from './corpus.testkit.js';

// The ONE cold read of all three corpora, paid here where it has a budget
// rather than inside whichever test happens to call first. See the hook's
// header in corpus.testkit.ts: the tests keep vitest's 5 s default and now do
// only their own work.
beforeAll(warmCorpus, CORPUS_READ_BUDGET_MS);

const ENGINES = [
  { name: 'cc', read: readCcSessions },
  { name: 'opencode', read: readOpenCodeSessions },
  { name: 'codex', read: readCodexSessions },
];

describe.each(ENGINES)('$name: the corpus is read once and handed out frozen', ({ name, read }) => {
  it('hands back the SAME array object on a second call', async () => {
    const first = await read();
    const second = await read();
    // Identity, not deep equality: two equal arrays would mean it read twice.
    expect(second).toBe(first);
  });

  it('read something, so the assertions below are not about an empty array', async () => {
    // The non-vacuity control this repository requires of every sweep: a
    // discovery bug that found nothing would satisfy "every element is frozen"
    // and "no element can be mutated" perfectly.
    expect((await read()).length, `${name}: no sessions at all`).toBeGreaterThan(0);
  });

  it('freezes the array, its sessions, and the tree inside them', async () => {
    const states = await read();
    expect(Object.isFrozen(states)).toBe(true);
    const first = states[0];
    if (first === undefined) throw new Error(`${name}: no sessions`);
    expect(Object.isFrozen(first)).toBe(true);
    // DEEP, not one level: a shallow freeze would leave every node of every
    // tree writable, which is where a consumer would actually do damage.
    expect(Object.isFrozen(first.root)).toBe(true);
    expect(Object.isFrozen(first.root.children)).toBe(true);
  });

  it('THROWS on a mutation rather than accepting it silently', async () => {
    const states = await read();
    const first = states[0];
    if (first === undefined) throw new Error(`${name}: no sessions`);
    // The property that makes the freeze an audit rather than a decoration.
    // Cast because the type says these are writable; the runtime says no.
    expect(() => {
      (first as { engine: string }).engine = 'mutated';
    }).toThrow(TypeError);
    expect(() => {
      (first.root as { id: string }).id = 'mutated';
    }).toThrow(TypeError);
    expect(() => {
      (states as SessionState[]).push(first);
    }).toThrow(TypeError);
  });

  it('and the mutation really did not land', async () => {
    // Belt and braces on the test above: `toThrow` passing tells you an
    // exception was raised, not that the value survived it.
    const states = await read();
    const first = states[0];
    if (first === undefined) throw new Error(`${name}: no sessions`);
    expect(first.engine).not.toBe('mutated');
    expect(first.root.id).not.toBe('mutated');
  });

  it('a consumer that needs to mutate can still clone', async () => {
    // The documented escape hatch, proved to work rather than asserted to.
    const states = await read();
    const first = states[0];
    if (first === undefined) throw new Error(`${name}: no sessions`);
    const clone = structuredClone(first) as { engine: string };
    clone.engine = 'mutated';
    expect(clone.engine).toBe('mutated');
    expect(first.engine).not.toBe('mutated');
  });
});
