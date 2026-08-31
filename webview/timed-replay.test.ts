/**
 * Timed replay of a REAL captured session — PLAN.md Phase 5.5, DoD 5.5.5.
 *
 * WHAT THIS ANSWERS. `AUDIT-2026-08-27` §7.4 could measure the upstream half
 * of the reported defect and not the downstream half. Feeding the session's
 * transcripts through the production content path reproduced **537 of 537**
 * tool calls, which eliminated the parser and the grafter — and left the store
 * untested, because "the corpus tooling cannot do it": `record-wire.mjs`
 * recorded a hand-authored ten-event arc and nothing could replay a real
 * session's append history.
 *
 * `record-wire.mjs --timed` is that missing mode and this is the test that
 * uses it. The committed corpus is **107 diffs** driven by the real
 * `SessionModel` and the real `SessionBridge` over a real eight-hour session,
 * at the timing the transcripts themselves recorded.
 *
 * THE NUMBER IS 246, NOT 537, AND THAT IS DELIBERATE. The DoD says "the
 * 537-node corpus". 537 is the tool-call count of the FULL nine-subagent
 * session as it sits in `~/.claude`; the committed fixture carries the main
 * transcript and the **two** subagents the user's report concerns — 121 + 33 +
 * 92 = **246** — because the other seven are 1.9 MB of subagents the report is
 * not about. The property under test is "every tool call the host emitted is
 * visible in the store at the end", which is scale-independent; the fixture's
 * own README records the same split. Written down rather than quietly
 * substituted.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import type { HostToWebviewMessage, SessionState, TreeNode } from '../src/model/events.js';
import { isAgentNode } from '../src/model/events.js';
import { applySessionPatch } from '../src/bridge/apply.js';
import { createStore } from './store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, 'wire', 'dropped-actions-timed.json');

interface TimedCorpus {
  id: string;
  kind: string;
  producedBy: string;
  recordedFrom: string;
  sourceDigests: Record<string, string>;
  sourceLines: number;
  durationMs: number;
  steps: { atMs: number; label: string; what: string }[];
  events: { atMs: number; label: string; message: HostToWebviewMessage }[];
  final: {
    sessions: SessionState[];
    degraded: { degraded: boolean; reason?: 'noHookEvents' | 'listenerDown' };
    schemaMismatchSessionIds: string[];
  };
}

let corpus: TimedCorpus;

/** Tool nodes in a tree. The measurement the audit made upstream. */
function toolNodes(node: TreeNode): number {
  if (!isAgentNode(node)) return 1;
  let n = 0;
  for (const child of node.children) n += toolNodes(child);
  return n;
}

function toolsInView(state: SessionState | undefined): number {
  return state === undefined ? 0 : toolNodes(state.root);
}

beforeAll(async () => {
  corpus = JSON.parse(await readFile(CORPUS, 'utf8')) as TimedCorpus;
}, 120_000);

describe('timed replay of a real session (DoD 5.5.5)', () => {
  it('is a recorded corpus of a real session, not a scripted arc', () => {
    expect(corpus.kind).toBe('recorded');
    expect(corpus.producedBy).toBe('scripts/record-wire.mjs --timed');
    expect(corpus.recordedFrom).toBe('fixtures/synthetic-dropped-actions');
    // Eight hours of transcript time, not eight scripted minutes.
    expect(corpus.durationMs).toBeGreaterThan(8 * 60 * 60 * 1000);
    expect(corpus.sourceLines).toBe(977);
  });

  it('carries far more diffs than the arc corpus, which is the point', () => {
    const diffs = corpus.events.filter((e) => e.message.type === 'diff');
    // The hand-authored arc has 10 events over 3 sessions. This is a different
    // order of magnitude, on one large tree, which is the regime the reported
    // defect lived in.
    expect(diffs.length).toBeGreaterThan(100);
    // Exact, because REPRO.md quotes it. The corpus is a committed,
    // content-addressed artifact, not a fixture directory that grows on the
    // next harvest - so the repo's "do not assert fixture-set sizes" rule does
    // not apply, and an inequality here is what let five of REPRO.md's six
    // headline figures go unpinned for a whole phase.
    expect(diffs.length).toBe(107);
    expect(corpus.steps.length).toBe(corpus.events.length);
  });

  /**
   * THE DoD'S OWN ASSERTION: `patchFailure === undefined` at EVERY step, not
   * only convergence at the end.
   *
   * The distinction matters because convergence-at-the-end is exactly what the
   * shipped `0.1.2` could also pass: a store that discards a patch and waits
   * for a snapshot still converges the moment a snapshot arrives. What it
   * cannot do is stay correct in between, and "in between" is where a live
   * session spends all of its time.
   */
  it('replays with NO patch failure at any step, and every tool visible at the end', () => {
    const store = createStore();
    const failures: { at: number; message: string }[] = [];
    for (const event of corpus.events) {
      store.handleMessage(event.message);
      const failure = store.getView().patchFailure;
      if (failure !== undefined) failures.push({ at: event.atMs, message: failure.message });
    }
    expect(failures).toEqual([]);

    const view = store.getView();
    expect(view.sessions).toHaveLength(1);
    // 246 = 121 main + 33 + 92, the fixture's own `tool_use` census. See the
    // header for why this is not 537.
    expect(toolsInView(view.selected)).toBe(246);
    // And the store agrees with the model's independent final snapshot, which
    // is the property the arc corpus already asserts and this one inherits.
    expect(toolsInView(corpus.final.sessions[0])).toBe(246);
  });

  it('never asked for a resync, because nothing failed', () => {
    const store = createStore();
    for (const event of corpus.events) store.handleMessage(event.message);
    expect(store.getView().resyncs).toBe(0);
  });
});

/**
 * THE REPRODUCTION THE AUDIT LACKED (DoD 5.5.5).
 *
 * A clean replay proves the wire is consistent; it cannot reproduce the
 * reported defect, because the defect needs a TRIGGER — one message the
 * webview never received. `postMessage` to a hidden webview resolves `false`
 * and the host drops the result on purpose (`src/extension.ts`, and its
 * comment's premise that `false` only means "disposed" is wrong).
 *
 * So: drop exactly one diff, then keep replaying, under each of the two
 * policies. The difference between them IS the fix.
 *
 *   - **`0.1.2`'s policy** — any op that cannot be applied aborts the WHOLE
 *     patch; keep the last good tree; tell nobody. Every later diff is then
 *     applied to that stale base.
 *   - **Phase 5.5's policy** — apply what applies, report what does not, ask
 *     the host for a snapshot.
 *
 * `applyLegacy` below is not a copy of the old reducer. It is the NEW reducer
 * under the OLD POLICY, which isolates the one variable that changed.
 */
function replayWithDrop(dropIndex: number, policy: 'legacy' | 'phase55'): {
  tools: number;
  frozenAfter: number | null;
  /** Diffs whose patch was thrown away whole. `0.1.2`'s policy; 0 under 5.5. */
  discarded: number;
  /** Diffs actually delivered - every diff except the dropped one. */
  delivered: number;
} {
  const store = createStore();
  // Legacy policy runs its own reducer loop so the store's new behaviour
  // cannot leak into it.
  let legacyState: SessionState | undefined;
  let frozenAfter: number | null = null;
  let discarded = 0;
  let delivered = 0;
  let index = 0;

  for (const event of corpus.events) {
    const message = event.message;
    const dropped = index === dropIndex && message.type === 'diff';
    index += 1;
    if (message.type === 'diff' && !dropped) delivered += 1;

    if (policy === 'phase55') {
      if (dropped) continue;
      store.handleMessage(message);
      continue;
    }

    if (message.type === 'snapshot') {
      legacyState = message.sessions[0];
      continue;
    }
    if (message.type !== 'diff') continue;
    if (dropped) continue;
    if (legacyState === undefined) continue;
    const errors: unknown[] = [];
    const next = applySessionPatch(legacyState, message.patch, {
      onError: (e) => errors.push(e),
    });
    if (errors.length > 0) {
      // 0.1.2: discard the whole patch, keep the last good tree, say nothing.
      if (frozenAfter === null) frozenAfter = index - 1;
      discarded += 1;
      continue;
    }
    legacyState = next;
  }

  const tools =
    policy === 'phase55' ? toolsInView(store.getView().selected) : toolsInView(legacyState);
  return { tools, frozenAfter, discarded, delivered };
}

describe('the 0.1.2 defect, reproduced (DoD 5.5.5)', () => {
  /**
   * The drop point: the first diff that INSERTS a node. Dropping an update
   * would diverge nothing — the receiver would simply hold an older value for
   * a field, and the next update would overwrite it. Membership is what does
   * not heal.
   */
  function firstInsertingDiff(): number {
    for (let i = 0; i < corpus.events.length; i += 1) {
      const message = corpus.events[i]?.message;
      if (message?.type !== 'diff') continue;
      if ((message.patch.tree ?? []).some((op) => op.op === 'insertNode')) return i;
    }
    throw new Error('the corpus carries no inserting diff');
  }

  it("0.1.2's policy loses nodes permanently after ONE dropped message", () => {
    const drop = firstInsertingDiff();
    const legacy = replayWithDrop(drop, 'legacy');
    const fixed = replayWithDrop(drop, 'phase55');

    // The fix keeps every node the host ever sent, minus only what the dropped
    // message itself carried.
    expect(fixed.tools).toBeGreaterThan(legacy.tools);
    // And the loss is not one node — it is everything after the freeze.
    expect(legacy.tools).toBeLessThan(246);
    expect(fixed.tools).toBeGreaterThan(legacy.tools + 10);
    // The legacy replay froze, and it froze early.
    expect(legacy.frozenAfter).not.toBeNull();

    /*
     * EVERY FIGURE REPRO.md's MEASUREMENT TABLE QUOTES, PINNED EXACTLY.
     *
     * Added 2026-08-27 after a `phase-verifier` audit of that document.
     * REPRO.md's closing line claimed "every number above is printed by the
     * test file named in Reproducing this". It was not: the file printed
     * nothing and pinned two of the six, the rest resting on the
     * inequalities above. All six were TRUE - the auditor re-derived them
     * independently - and `expect(fixed.tools).toBeGreaterThan(legacy.tools
     * + 10)` passes at 244 and equally at 20, so the document's evidence
     * was a claim about a test rather than a test.
     *
     * That is this repo's most-recorded defect class (a vacuous assertion
     * that reads as proof) reached through documentation rather than code.
     * The inequalities stay: they say what the PROPERTY is, and survive a
     * re-record of the corpus. The equalities say what this corpus MEASURED,
     * and they are what REPRO.md is allowed to quote.
     */
    expect(drop).toBe(2);
    expect(legacy.delivered).toBe(106);
    expect(legacy.discarded).toBe(102);
    expect(legacy.frozenAfter).toBe(3);
    expect(legacy.tools).toBe(0);
    expect(fixed.tools).toBe(244);
    // Same delivered set under both policies - the one variable is what
    // happens to a diff that does not apply, not how many arrive.
    expect(fixed.delivered).toBe(106);
    // Zero BY CONSTRUCTION under 5.5, not by measurement: the new reducer
    // has no discard path at all. Asserted so a future reducer that quietly
    // grows one fails here rather than in a user's session.
    expect(fixed.discarded).toBe(0);
  });

  it('the fixed store asks the host for a snapshot instead of going quiet', () => {
    const drop = firstInsertingDiff();
    const sent: { type: string }[] = [];
    const store = createStore((m) => sent.push(m));
    let index = 0;
    let sawFailure = false;
    for (const event of corpus.events) {
      const isDrop = index === drop && event.message.type === 'diff';
      index += 1;
      if (isDrop) continue;
      store.handleMessage(event.message);
      if (store.getView().patchFailure !== undefined) sawFailure = true;
    }
    // Exactly the behaviour `0.1.2` could not produce: the renderer reports.
    expect(sawFailure).toBe(true);
    const requests = sent.filter((m) => m.type === 'resyncRequest');
    expect(requests.length).toBeGreaterThan(0);
    // ONE request, not one per failing diff. `resyncPending` gates it: a
    // renderer that machine-guns the host is a renderer the host learns to
    // ignore, and the host has already reset its bridge by the time the second
    // would arrive.
    expect(requests).toHaveLength(1);
  });

  /**
   * A nuance worth pinning rather than discovering later: `patchFailure` is
   * the BANNER, and it clears as soon as a patch applies cleanly — while the
   * tree is still one node short and the resync is still outstanding.
   *
   * That is deliberate. The banner answers "did the last message apply", which
   * is what a user can act on; "is this tree complete" is answered by the
   * snapshot the host owes us, and `resyncPending` — not the banner — is what
   * remembers that we asked. Asserting it here stops a future reader reading
   * a cleared banner as "the divergence is repaired".
   */
  it('the banner clears on the next clean patch while the resync is still owed', () => {
    const drop = firstInsertingDiff();
    const sent: { type: string }[] = [];
    const store = createStore((m) => sent.push(m));
    let index = 0;
    for (const event of corpus.events) {
      const isDrop = index === drop && event.message.type === 'diff';
      index += 1;
      if (isDrop) continue;
      store.handleMessage(event.message);
    }
    expect(store.getView().patchFailure).toBeUndefined();
    expect(sent.filter((m) => m.type === 'resyncRequest')).toHaveLength(1);
    // The repair has not landed, so the counter has not moved.
    expect(store.getView().resyncs).toBe(0);
  });
});
