/**
 * The resync contract, end to end — PLAN.md Phase 5.5, DoD 5.5.2.
 *
 * The DoD's test reads: *"inject a failing patch, assert `resyncRequest` sent,
 * snapshot applied, tree equals model."* Four claims, and they span three
 * modules, so this file drives all three rather than asserting each in
 * isolation: `webview/store.ts` sends, `src/bridge/messages.ts` validates, and
 * `PanelController` repairs.
 *
 * The seam between them is what the defect lived in. `AUDIT-2026-08-27` §7.3
 * found a store that recorded a failure, a comment saying *"the host owes us a
 * snapshot"*, and no message that could carry the claim. Each module was
 * internally consistent; the gap was between them. That is the class
 * `src/bridge/contract.ts` exists to prevent, arriving through a different
 * door, so the test crosses the boundary on purpose.
 */

import { describe, expect, it } from 'vitest';

import type {
  HostToWebviewMessage,
  SessionPatch,
  SessionState,
  WebviewToHostMessage,
} from '../model/events.js';
import { isWebviewToHostMessage, RESYNC_FAILED_OPS, RESYNC_REASON_MAX_CHARS } from './messages.js';
import { createStore } from '../../webview/store.js';

function baseState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 'session-1',
    projectSlug: 'slug',
    workspaceMatch: true,
    liveness: 'live',
    schemaOk: true,
    root: {
      id: 'root',
      kind: 'main',
      label: 'main',
      status: 'running',
      spawnDepth: 0,
      children: [
        { id: 't1', toolName: 'Read', status: 'done', inputPreview: '{}' },
        { id: 't2', toolName: 'Bash', status: 'done', inputPreview: '{}' },
      ],
      tokens: { in: 1, out: 1 },
      startedAt: 1,
    },
    totals: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    spawnEdges: [],
    engine: 'cc',
    ...overrides,
  };
}

/** A patch that addresses a node the receiver does not have. */
const FAILING_PATCH: SessionPatch = {
  tree: [{ op: 'updateTool', id: 'ghost', fields: { status: 'error' } }],
};

describe('the resync contract (DoD 5.5.2)', () => {
  it('a failing patch makes the store ask the host for a snapshot', () => {
    const sent: WebviewToHostMessage[] = [];
    const store = createStore((m) => sent.push(m));
    store.handleMessage({ type: 'snapshot', sessions: [baseState()] });

    store.handleMessage({ type: 'diff', sessionId: 'session-1', patch: FAILING_PATCH });

    expect(sent).toHaveLength(1);
    const request = sent[0];
    expect(request?.type).toBe('resyncRequest');
    if (request?.type !== 'resyncRequest') throw new Error('unreachable');
    expect(request.sessionId).toBe('session-1');
    expect(request.failedOp).toBe('updateTool');
    expect(request.reason).toContain('ghost');
    expect(store.getView().patchFailure).toBeDefined();
  });

  it('the snapshot that answers it replaces the state, clears the failure, counts the resync', () => {
    const sent: WebviewToHostMessage[] = [];
    const store = createStore((m) => sent.push(m));
    store.handleMessage({ type: 'snapshot', sessions: [baseState()] });
    store.handleMessage({ type: 'diff', sessionId: 'session-1', patch: FAILING_PATCH });
    expect(store.getView().resyncs).toBe(0);

    // The host's authoritative re-statement, with a third tool the store never
    // saw — so "replaces" is testable rather than a no-op.
    const repaired = baseState();
    const root = repaired.root;
    const model: SessionState = {
      ...repaired,
      root: {
        ...root,
        children: [
          ...root.children,
          { id: 't3', toolName: 'Glob', status: 'running', inputPreview: '{}' },
        ],
      },
    };
    store.handleMessage({ type: 'snapshot', sessions: [model] });

    const view = store.getView();
    expect(view.patchFailure).toBeUndefined();
    expect(view.resyncs).toBe(1);
    // Tree equals model, node for node.
    expect(view.selected).toStrictEqual(model);
  });

  it('a burst of failing diffs asks ONCE, not once per diff', () => {
    const sent: WebviewToHostMessage[] = [];
    const store = createStore((m) => sent.push(m));
    store.handleMessage({ type: 'snapshot', sessions: [baseState()] });
    for (let i = 0; i < 20; i += 1) {
      store.handleMessage({ type: 'diff', sessionId: 'session-1', patch: FAILING_PATCH });
    }
    expect(sent.filter((m) => m.type === 'resyncRequest')).toHaveLength(1);
  });

  it('and asks again after the repair, if it diverges a second time', () => {
    const sent: WebviewToHostMessage[] = [];
    const store = createStore((m) => sent.push(m));
    store.handleMessage({ type: 'snapshot', sessions: [baseState()] });
    store.handleMessage({ type: 'diff', sessionId: 'session-1', patch: FAILING_PATCH });
    store.handleMessage({ type: 'snapshot', sessions: [baseState()] });
    store.handleMessage({ type: 'diff', sessionId: 'session-1', patch: FAILING_PATCH });
    expect(sent.filter((m) => m.type === 'resyncRequest')).toHaveLength(2);
    expect(store.getView().resyncs).toBe(1);
  });

  it('a diff for an unknown session asks too — it cannot be applied either', () => {
    const sent: WebviewToHostMessage[] = [];
    const store = createStore((m) => sent.push(m));
    store.handleMessage({ type: 'diff', sessionId: 'never-seen', patch: FAILING_PATCH });
    expect(sent.filter((m) => m.type === 'resyncRequest')).toHaveLength(1);
  });

  it('a clean patch sends nothing at all', () => {
    const sent: WebviewToHostMessage[] = [];
    const store = createStore((m) => sent.push(m));
    store.handleMessage({ type: 'snapshot', sessions: [baseState()] });
    store.handleMessage({
      type: 'diff',
      sessionId: 'session-1',
      patch: { tree: [{ op: 'updateTool', id: 't1', fields: { status: 'error' } }] },
    });
    expect(sent).toEqual([]);
    expect(store.getView().patchFailure).toBeUndefined();
  });
});

describe('the guard accepts exactly this message and nothing near it', () => {
  const valid: WebviewToHostMessage = {
    type: 'resyncRequest',
    reason: 'updateTool: no node with id ghost',
    failedOp: 'updateTool',
    sessionId: 'session-1',
  };

  it('accepts the message the store actually sends', () => {
    expect(isWebviewToHostMessage(valid)).toBe(true);
    // And the minimum: `reason` alone.
    expect(isWebviewToHostMessage({ type: 'resyncRequest', reason: 'x' })).toBe(true);
  });

  it('rejects an unbounded reason — a log is not a denial-of-service surface', () => {
    const long = 'x'.repeat(RESYNC_REASON_MAX_CHARS + 1);
    expect(isWebviewToHostMessage({ type: 'resyncRequest', reason: long })).toBe(false);
    const atLimit = 'x'.repeat(RESYNC_REASON_MAX_CHARS);
    expect(isWebviewToHostMessage({ type: 'resyncRequest', reason: atLimit })).toBe(true);
  });

  it('rejects a failedOp outside the closed set', () => {
    expect(isWebviewToHostMessage({ ...valid, failedOp: 'dropTables' })).toBe(false);
    expect(isWebviewToHostMessage({ ...valid, failedOp: 42 })).toBe(false);
    for (const op of RESYNC_FAILED_OPS) {
      expect(isWebviewToHostMessage({ ...valid, failedOp: op })).toBe(true);
    }
  });

  it('rejects an empty reason, an empty sessionId, and a poisoned prototype', () => {
    expect(isWebviewToHostMessage({ type: 'resyncRequest', reason: '' })).toBe(false);
    expect(isWebviewToHostMessage({ ...valid, sessionId: '' })).toBe(false);
    expect(isWebviewToHostMessage({ ...valid, sessionId: 7 })).toBe(false);
    expect(
      isWebviewToHostMessage(JSON.parse('{"type":"resyncRequest","reason":"x","__proto__":{}}')),
    ).toBe(false);
  });

  it('the op list equals the ops a diff can actually carry', () => {
    // Two agreeing literals is the defect `contract.ts` exists to prevent, so
    // the duplication is CHECKED rather than trusted. `TreeOp` is a type and
    // types are erased, which is why the guard needs a runtime list at all.
    expect([...RESYNC_FAILED_OPS].sort()).toEqual(
      [
        'insertNode',
        'removeNode',
        'reorderChildren',
        'replaceNode',
        'replaceRoot',
        'updateAgent',
        'updateTool',
      ].sort(),
    );
  });
});

describe('the message survives the structured-clone hop', () => {
  it('round-trips through JSON, which is what postMessage does', () => {
    const sent: WebviewToHostMessage[] = [];
    const store = createStore((m) => sent.push(m));
    store.handleMessage({ type: 'snapshot', sessions: [baseState()] });
    store.handleMessage({ type: 'diff', sessionId: 'session-1', patch: FAILING_PATCH });
    const hopped: unknown = JSON.parse(JSON.stringify(sent[0]));
    expect(isWebviewToHostMessage(hopped)).toBe(true);
  });

  it('and nothing the host sends is mistaken for it', () => {
    const outbound: HostToWebviewMessage[] = [
      { type: 'snapshot', sessions: [] },
      { type: 'degraded', degraded: false },
      { type: 'schemaMismatch', sessionId: 's' },
    ];
    for (const message of outbound) expect(isWebviewToHostMessage(message)).toBe(false);
  });
});
