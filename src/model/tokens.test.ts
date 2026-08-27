/**
 * The token contract — `0.1.3`'s second fix.
 *
 * WHAT SHIPPED, AND WHY IT WAS WRONG. `AgentNode.tokens.in` read
 * `message.usage.input_tokens` and nothing else. In the two ANCHOR corpora
 * that field is **~2** on every assistant message — 79 of 116 across every
 * `cc-*` corpus, with `fixtures/cc-2.1.241` (a local GGUF model, no prompt
 * caching) reaching 65,627 and both cache fields at 0. The prompt itself
 * lives in `cache_creation_input_tokens` + `cache_read_input_tokens`. So the
 * deck reported "848 in" for a session Claude Code's own context display put at
 * roughly 76% of a 1M window — off by three orders of magnitude, on the number
 * a user is most likely to act on.
 *
 * `0.1.3` replaces it with two figures that answer two different questions:
 *
 *   - **`contextNow`** — the LAST assistant message by ordinal. A level. This
 *     is what fills a context window and what a user watching a long session
 *     is actually asking about.
 *   - **`burn`** — summed across distinct `message.id`. A total. Unbounded,
 *     and useless for "how much room is left".
 *
 * WHAT THIS FILE PINS, and it is deliberately arithmetic rather than
 * structural. Every number below was read off a committed fixture by hand and
 * is written as its own sum, so a reader can check it against the transcript
 * without running anything. A test that recomputed the expectation with the
 * production rule could not catch a rule that is wrong the same way twice —
 * which is exactly how the shipped defect survived from Phase 1 to `0.1.3`.
 */

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { graftSession, ROOT_NODE_ID } from './graft.js';
import type { AgentNode } from './events.js';

const ANCHOR = fileURLToPath(
  new URL(
    '../../fixtures/cc-2.1.234/projects/c--Users-dev-projects-agent-deck/05c5482d-5568-44ce-97fe-bc9a6c15afc4.jsonl',
    import.meta.url,
  ),
);

const NO_CACHE = fileURLToPath(
  new URL(
    '../../fixtures/synthetic-tokens/00-cache-fields-absent/SYNTHETIC-hand-mutated-not-captured/deadbeef-0000-4000-8000-0000000000a1.jsonl',
    import.meta.url,
  ),
);

/**
 * `05c5482d-*.jsonl`'s main transcript, read by hand.
 *
 * Six lines carry `message.usage`, across TWO distinct `message.id`s — four
 * lines for the first and two for the second, because Claude Code writes one
 * line per content block of a streamed message and restates the whole usage
 * object on each. Every line of one message repeats the same prompt figures
 * and a growing `output_tokens`, which is why the rule is max-per-id.
 *
 *   msg_011CeBgXDhoTEXnkTHVvjNSh   4 lines   in 2  cache_creation 13390  cache_read 28807  out ..1512
 *   msg_011CeBggfAjr14U2gMSHwBkr   2 lines   in 2  cache_creation  3174  cache_read 42197  out ...617
 *
 * The DoD names the first of these explicitly: 2 + 13390 + 28807 = 42199, and
 * output 1512 as the maximum over its four lines.
 */
const FIRST = { prompt: 2 + 13390 + 28807, output: 1512 };
const LAST = { prompt: 2 + 3174 + 42197, output: 617 };

async function rootOf(transcript: string): Promise<AgentNode> {
  const result = await graftSession(transcript);
  if (!result.ok) throw new Error(`fixture must graft: ${result.mismatch.code}`);
  const root = result.snapshot.root;
  expect(root.id).toBe(ROOT_NODE_ID);
  return root;
}

describe('the prompt is all three components, not `input_tokens`', () => {
  it('sums input + cache_creation + cache_read per distinct message.id', async () => {
    const root = await rootOf(ANCHOR);

    // The DoD's own numbers. `42199` is the assertion the shipped build fails:
    // it reported `2`.
    expect(FIRST.prompt).toBe(42_199);
    // `burn` is both messages, so the first one's contribution is `burn` minus
    // the last one's — which is how a per-message figure is checkable through
    // an interface that exposes only the level and the total.
    expect(root.burn.prompt - LAST.prompt).toBe(FIRST.prompt);
    expect(root.burn.output - LAST.output).toBe(FIRST.output);
  });

  it('takes contextNow from the LAST assistant message, not from a sum', async () => {
    const root = await rootOf(ANCHOR);
    expect(root.contextNow).toStrictEqual(LAST);
  });

  it('burn is the sum across distinct ids, and it differs from contextNow', async () => {
    const root = await rootOf(ANCHOR);
    expect(root.burn).toStrictEqual({
      prompt: FIRST.prompt + LAST.prompt,
      output: FIRST.output + LAST.output,
    });
    // The vacuity guard. If a future refactor returned the same object for
    // both, every assertion above would still pass on a one-message session;
    // this fixture has two, so they must differ.
    expect(root.burn).not.toStrictEqual(root.contextNow);
    expect(root.burn.prompt).toBeGreaterThan(root.contextNow.prompt);
  });

  it('degrades to exactly input_tokens when the cache fields are absent', async () => {
    // `fixtures/synthetic-tokens/00-cache-fields-absent` — the one thing no
    // captured fixture can prove, because every real assistant message in the
    // corpora carries all three components. The risk this closes is an
    // `undefined + n` producing NaN, or a missing field zeroing the whole sum.
    const root = await rootOf(NO_CACHE);
    expect(root.contextNow).toStrictEqual({ prompt: 8765, output: 12 });
    expect(root.burn).toStrictEqual({ prompt: 4321 + 8765, output: 99 + 12 });
    expect(Number.isFinite(root.burn.prompt)).toBe(true);
  });
});
