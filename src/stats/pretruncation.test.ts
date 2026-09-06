/**
 * v0.7.0 Phase 1, DoD 1.2 — `inputHash` is taken BEFORE truncation.
 *
 * This is the whole reason the field exists rather than being derived from
 * `inputPreview`. A preview is cut at `agentDeck.previewBytes`; two calls that
 * differ only past that cut have IDENTICAL previews. Hashing the preview would
 * report them as the same call — so F3 would count a loop that never happened,
 * and F4 would chain two edits of different files.
 *
 * ## Two deviations from the DoD's wording, both deliberate
 *
 * 1. **It is not in `redact.test.ts`.** That file tests `redact.ts`, which
 *    truncates and knows nothing about hashing — the two meet in the GRAFTER,
 *    which is where the preview and the hash are produced from one input. A
 *    test in `redact.test.ts` could only have re-tested truncation.
 *
 * 2. **There is no `fixtures/synthetic-stats/07-oversize-input`.** The input is
 *    built in-process instead. The precedent is this repository's own: hotfix
 *    `0.1.3`'s `fixtures/synthetic-tokens/` was six committed files proving an
 *    assertion that survived as an in-test builder "with the same numbers", and
 *    a fixture whose only content is `'x'.repeat(N)` states nothing about any
 *    engine's schema — which is what G6 keeps fixtures for. Building it here
 *    also lets the SAME bytes be varied past the cut, which is the half a
 *    single committed file could not do.
 */

import { describe, expect, it } from 'vitest';

import type { AgentNode, ToolNode, TranscriptEntry } from '../model/events.js';
import { isToolNode } from '../model/events.js';
import { TreeGrafter } from '../model/graft.js';
import { DEFAULT_MAX_PAYLOAD_BYTES } from '../parser/redact.js';

import { canonicalJson, inputHash } from './canonical.js';

/** One assistant entry carrying one `tool_use` block with the given input. */
function entryWith(id: string, input: unknown): TranscriptEntry {
  return {
    type: 'assistant',
    uuid: `uuid-${id}`,
    timestamp: '2026-09-06T10:00:00.000Z',
    message: {
      id: `msg-${id}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Write', input }],
    },
  } as unknown as TranscriptEntry;
}

function toolsFrom(entries: readonly TranscriptEntry[], previewBytes?: number): ToolNode[] {
  // TWO arguments: the init and the OPTIONS. Passing `previewBytes` inside the
  // first silently applied the 512-byte default to both arms of the
  // two-ceilings test below, so it compared a setting against itself.
  const grafter = new TreeGrafter(
    { sessionId: 'S', projectSlug: 'P' },
    previewBytes === undefined ? {} : { previewBytes },
  );
  grafter.addTranscript({ kind: 'main', path: '/main.jsonl', entries });
  const root: AgentNode = grafter.snapshot().root;
  return root.children.filter(isToolNode);
}

/** Comfortably past the default ceiling, so the cut certainly happens. */
const OVERSIZE = DEFAULT_MAX_PAYLOAD_BYTES * 2;

describe('DoD 1.2 — an oversize input is cut in the preview and whole in the hash', () => {
  const input = { file_path: '/a/b.ts', content: 'A'.repeat(OVERSIZE) };
  const tools = toolsFrom([entryWith('toolu_big', input)]);
  const tool = tools[0];

  it('produced exactly one tool node to test', () => {
    // Control first: everything below reads `tools[0]`.
    expect(tools).toHaveLength(1);
    expect(tool).toBeDefined();
  });

  it('TRUNCATES the preview — the control for everything else here', () => {
    /*
     * Without this, "the hash is of the untruncated input" is satisfied by an
     * input that was never truncated at all, which is exactly the vacuous
     * shape this repository keeps recording.
     */
    const preview = tool?.inputPreview ?? '';
    expect(preview.length).toBeLessThan(canonicalJson(input).length);
    expect(preview).toContain('agent-deck: truncated');
  });

  it('hashes the UNTRUNCATED input, not the preview', () => {
    expect(tool?.inputHash).toBe(inputHash(input));
    // And is demonstrably NOT the hash of what the user can see.
    expect(tool?.inputHash).not.toBe(inputHash(tool?.inputPreview ?? ''));
  });
});

describe('DoD 1.2 — two inputs differing ONLY past the cut hash differently', () => {
  /*
   * The defect this prevents, stated as data: both calls write the same file
   * with a body that agrees for the first 16 KB and differs after. Their
   * previews are byte-identical because the difference is past the ceiling.
   */
  const shared = 'A'.repeat(OVERSIZE);
  /*
   * The two endings are the SAME LENGTH, and that is not cosmetic. The
   * truncation marker states the ORIGINAL byte count — `showing 8192 of N` —
   * so inputs of different total length produce different previews through the
   * marker alone, and the "identical previews" control below would pass for
   * the wrong reason. Found by writing the control first and watching it fail.
   */
  const first = { file_path: '/a/b.ts', content: `${shared}ENDING-ONE` };
  const second = { file_path: '/a/b.ts', content: `${shared}ENDING-TWO` };

  const tools = toolsFrom([entryWith('toolu_1', first), entryWith('toolu_2', second)]);

  it('produced two nodes whose previews really are identical', () => {
    // The control that makes the next assertion mean something. If the
    // previews differed, hashing the preview would also have worked and this
    // test would prove nothing about WHEN the hash is taken.
    expect(tools).toHaveLength(2);
    expect(tools[0]?.inputPreview).toBe(tools[1]?.inputPreview);
  });

  it('gives them DIFFERENT hashes', () => {
    expect(tools[0]?.inputHash).not.toBe(tools[1]?.inputHash);
  });

  it('would have collapsed them if the hash came from the preview', () => {
    // The counterfactual, spelled out: this is the value the field would have
    // had under the wrong design, and it is the same for both calls.
    const fromPreview = tools.map((t) => inputHash(t.inputPreview));
    expect(fromPreview[0]).toBe(fromPreview[1]);
    expect(tools[0]?.inputHash).not.toBe(fromPreview[0]);
  });
});

describe('DoD 1.2 — the property holds at a NON-default ceiling too', () => {
  it('still hashes the whole input when previewBytes is tiny', () => {
    /*
     * `agentDeck.previewBytes` is a user setting. A hash that happened to be
     * pre-truncation only at the default would break for anyone who changed it,
     * and the failure would look like a loop appearing in their stats and
     * nobody else's.
     */
    const input = { file_path: '/a/b.ts', content: 'B'.repeat(4_096) };
    const tools = toolsFrom([entryWith('toolu_small', input)], 512);
    expect(tools[0]?.inputPreview.length).toBeLessThan(1_024);
    expect(tools[0]?.inputHash).toBe(inputHash(input));
  });

  it('is identical at two different ceilings — the hash does not move with the setting', () => {
    const input = { file_path: '/a/b.ts', content: 'C'.repeat(OVERSIZE) };
    const wide = toolsFrom([entryWith('toolu_w', input)], DEFAULT_MAX_PAYLOAD_BYTES);
    const narrow = toolsFrom([entryWith('toolu_w', input)], 1_024);
    expect(wide[0]?.inputPreview).not.toBe(narrow[0]?.inputPreview);
    expect(wide[0]?.inputHash).toBe(narrow[0]?.inputHash);
  });
});
