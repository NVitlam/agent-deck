/**
 * The token contract — ported from `hotfix/0.1.3` onto the v0.5.0 tree.
 *
 * WHAT SHIPPED, AND WHY IT WAS WRONG. `AgentNode.tokens.in` read
 * `message.usage.input_tokens` and nothing else. In the anchor corpora that
 * field is **2** on every assistant message; the prompt itself lives in
 * `cache_creation_input_tokens` + `cache_read_input_tokens`. So the deck
 * reported single digits for five-figure prompts — off by four orders of
 * magnitude, on the number a user is most likely to act on.
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
 * structural. Every number below is written as its own sum, so a reader can
 * check it against the transcript without running anything. A test that
 * recomputed the expectation with the production rule could not catch a rule
 * that is wrong the same way twice — which is exactly how the shipped defect
 * survived from Phase 1 to `0.1.3`.
 */

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AgentNode, TranscriptEntry } from './events.js';
import { graftSession, ROOT_NODE_ID, TreeGrafter } from './graft.js';

const ANCHOR = fileURLToPath(
  new URL(
    '../../fixtures/cc-2.1.234/projects/c--Users-dev-projects-agent-deck/05c5482d-5568-44ce-97fe-bc9a6c15afc4.jsonl',
    import.meta.url,
  ),
);

/**
 * `05c5482d-*.jsonl`'s main transcript, read off the bytes.
 *
 * Six of its 22 lines carry `message.usage`, across TWO distinct `message.id`s
 * — four lines for the first and two for the second, because Claude Code
 * writes one line per content block of a streamed message and restates the
 * whole usage object on each. Every line of one message repeats the same
 * prompt figures and a growing `output_tokens`, which is why the rule is
 * max-per-id.
 *
 *   msg_011CeBgXDhoTEXnkTHVvjNSh  4 lines  in 2  cc 13390  cr 28807  out ..1512
 *   msg_011CeBggfAjr14U2gMSHwBkr  2 lines  in 2  cc  3174  cr 42197  out ...617
 *
 * The DoD names the first explicitly: 2 + 13390 + 28807 = 42199, and output
 * 1512 as the maximum over its four lines.
 */
const FIRST = { prompt: 2 + 13_390 + 28_807, output: 1_512 };
const LAST = { prompt: 2 + 3_174 + 42_197, output: 617 };

async function rootOf(transcript: string): Promise<AgentNode> {
  const result = await graftSession(transcript);
  if (!result.ok) throw new Error(`fixture must graft: ${result.mismatch.code}`);
  const root = result.snapshot.root;
  expect(root.id).toBe(ROOT_NODE_ID);
  return root;
}

/** An assistant line carrying exactly the `usage` keys given. */
function assistantLine(id: string, usage: Record<string, unknown>): TranscriptEntry {
  return {
    type: 'assistant',
    uuid: `uuid-${id}`,
    timestamp: '2026-08-28T10:00:00.000Z',
    message: { id, role: 'assistant', usage, content: [] },
  } as unknown as TranscriptEntry;
}

/** A grafter fed only the lines given, so a `usage` shape can be chosen exactly. */
function rootFromEntries(entries: readonly TranscriptEntry[]): AgentNode {
  const grafter = new TreeGrafter({ sessionId: 'S', projectSlug: 'P' });
  grafter.addTranscript({ kind: 'main', path: '/main.jsonl', entries });
  return grafter.snapshot().root;
}

describe('the prompt is all three components, not `input_tokens`', () => {
  it('sums input + cache_creation + cache_read per distinct message.id', async () => {
    const root = await rootOf(ANCHOR);

    // The DoD's own number. `42199` is the assertion the shipped build fails:
    // it reported `2`.
    expect(FIRST.prompt).toBe(42_199);
    // `burn` is both messages, so the first one's contribution is `burn` minus
    // the last one's — which is how a per-message figure is checkable through
    // an interface that exposes only the level and the total.
    expect(root.burn?.prompt !== undefined && root.burn.prompt - LAST.prompt).toBe(FIRST.prompt);
    expect(root.burn?.output !== undefined && root.burn.output - LAST.output).toBe(FIRST.output);
  });

  it('takes contextNow from the LAST assistant message, not from a sum', async () => {
    const root = await rootOf(ANCHOR);
    expect(root.contextNow).toStrictEqual(LAST);
    // 45,373 rather than the 2 the shipped build showed for this message.
    expect(root.contextNow?.prompt).toBe(45_373);
  });

  it('burn is the sum across distinct ids, and it differs from contextNow', async () => {
    const root = await rootOf(ANCHOR);
    expect(root.burn).toStrictEqual({
      prompt: FIRST.prompt + LAST.prompt,
      output: FIRST.output + LAST.output,
    });
    expect(root.burn).toStrictEqual({ prompt: 87_572, output: 2_129 });
    // The vacuity guard. If a future refactor returned the same object for
    // both, every assertion above would still pass on a one-message session;
    // this fixture has two, so they must differ.
    expect(root.burn).not.toStrictEqual(root.contextNow);
    expect(root.burn?.prompt).toBeGreaterThan(root.contextNow?.prompt ?? 0);
  });

  it('degrades to exactly input_tokens when the cache fields are absent', () => {
    // The one thing no captured fixture can prove, because every real
    // assistant message in the committed corpora carries all three
    // components. The risk this closes is an `undefined + n` producing NaN, or
    // a missing field zeroing the whole sum. A session against a local model
    // with no prompt caching is exactly this shape.
    const root = rootFromEntries([
      assistantLine('m1', { input_tokens: 4_321, output_tokens: 99 }),
      assistantLine('m2', { input_tokens: 8_765, output_tokens: 12 }),
    ]);
    expect(root.contextNow).toStrictEqual({ prompt: 8_765, output: 12 });
    expect(root.burn).toStrictEqual({ prompt: 4_321 + 8_765, output: 99 + 12 });
    expect(Number.isFinite(root.burn?.prompt)).toBe(true);
  });

  it('treats a non-finite or wrong-typed component as 0 rather than poisoning the sum', () => {
    const root = rootFromEntries([
      assistantLine('m1', {
        input_tokens: 10,
        cache_creation_input_tokens: 'nonsense',
        cache_read_input_tokens: Number.NaN,
        output_tokens: 5,
      }),
    ]);
    expect(root.contextNow).toStrictEqual({ prompt: 10, output: 5 });
    expect(Number.isFinite(root.burn?.prompt)).toBe(true);
  });

  it('keeps the FIRST sighting ordinal, so a later line of a streamed message does not reorder', () => {
    // Two lines of `m1`, then `m2`, then a third line of `m1` restating its
    // grown counters. `contextNow` must still be `m2`: `m1` was seen first and
    // a repeat line updates its numbers without moving it to the end.
    const root = rootFromEntries([
      assistantLine('m1', { input_tokens: 100, output_tokens: 1 }),
      assistantLine('m1', { input_tokens: 100, output_tokens: 7 }),
      assistantLine('m2', { input_tokens: 200, output_tokens: 3 }),
      assistantLine('m1', { input_tokens: 100, output_tokens: 9 }),
    ]);
    expect(root.contextNow).toStrictEqual({ prompt: 200, output: 3 });
    // max-per-id, not sum-per-line: `m1` contributes 9, not 1 + 7 + 9.
    expect(root.burn).toStrictEqual({ prompt: 300, output: 12 });
  });
});
