import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type {
  AgentNode,
  HostToWebviewMessage,
  SessionPatch,
  SessionState,
} from '../model/events.js';
import { SessionModel, diffSessionState } from '../model/session.js';
import type { SessionEmission } from '../model/session.js';
import { graftSession } from '../model/graft.js';
import { LivenessEngine } from '../model/liveness.js';
import { slugifyWorkspace } from '../parser/tailer.js';
import { applySessionPatch } from './apply.js';
import {
  SessionBridge,
  isWebviewToHostMessage,
  type HostToWebviewPort,
} from './messages.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function agent(id: string, children: AgentNode['children'] = []): AgentNode {
  return {
    id,
    kind: id === 'root' ? 'main' : 'subagent',
    label: id,
    status: 'running',
    spawnDepth: id === 'root' ? 0 : 1,
    children,
    tokens: { in: 1, out: 2 },
    startedAt: 1_000,
  };
}

function session(sessionId: string, root: AgentNode = agent('root')): SessionState {
  return {
    sessionId,
    projectSlug: 'c--Users-dev-repo',
    workspaceMatch: true,
    liveness: 'live',
    schemaOk: true,
    root,
    totals: { inputTokens: 1, outputTokens: 2, costUsd: 0 },
    spawnEdges: [],
  };
}

function emission(over: Partial<SessionEmission> = {}): SessionEmission {
  return {
    sessions: over.sessions ?? [],
    diffs: over.diffs ?? [],
    addedSessionIds: over.addedSessionIds ?? [],
    removedSessionIds: over.removedSessionIds ?? [],
    schemaMismatchSessionIds: over.schemaMismatchSessionIds ?? [],
  };
}

/** A recording port. Nothing here touches vscode, by design. */
class RecordingPort implements HostToWebviewPort {
  readonly sent: HostToWebviewMessage[] = [];
  throwNext = false;

  postMessage(message: HostToWebviewMessage): void {
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error('webview disposed');
    }
    this.sent.push(message);
  }

  types(): string[] {
    return this.sent.map((m) => m.type);
  }
}

function firstSnapshot(bridge: SessionBridge, states: SessionState[]): void {
  bridge.publish(
    emission({ sessions: states, addedSessionIds: states.map((s) => s.sessionId) }),
  );
}

// ---------------------------------------------------------------------------
// (a) inbound guard — the untrusted boundary
// ---------------------------------------------------------------------------

describe('isWebviewToHostMessage — accepts', () => {
  it('a well-formed expandNode', () => {
    expect(
      isWebviewToHostMessage({ type: 'expandNode', sessionId: 's1', nodeId: 'n1' }),
    ).toBe(true);
  });

  it('a well-formed selectSession', () => {
    expect(isWebviewToHostMessage({ type: 'selectSession', sessionId: 's1' })).toBe(
      true,
    );
  });

  it('a message carrying extra keys the host does not read', () => {
    expect(
      isWebviewToHostMessage({ type: 'selectSession', sessionId: 's1', extra: 1 }),
    ).toBe(true);
  });

  it('the JSON round trip of a real message', () => {
    const wire = JSON.stringify({ type: 'expandNode', sessionId: 's', nodeId: 'n' });
    expect(isWebviewToHostMessage(JSON.parse(wire))).toBe(true);
  });
});

describe('isWebviewToHostMessage — rejects', () => {
  // Everything a `window.postMessage` handler can actually be handed. Each case
  // must return false and must not throw; the assertion below covers both,
  // because a throw fails the test rather than being caught.
  const rejected: readonly [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a string', 'expandNode'],
    ['a JSON string of a valid message', '{"type":"selectSession","sessionId":"s"}'],
    ['a boolean', true],
    ['a symbol', Symbol('expandNode')],
    ['a function', (): void => undefined],
    ['an array', ['expandNode', 's1']],
    ['an array of valid messages', [{ type: 'selectSession', sessionId: 's' }]],
    ['an empty object', {}],
    ['no type', { sessionId: 's1', nodeId: 'n1' }],
    ['an unknown type', { type: 'deleteEverything', sessionId: 's1' }],
    ['a host-to-webview type', { type: 'snapshot', sessions: [] }],
    ['a non-string type', { type: 7, sessionId: 's1' }],
    ['an empty type', { type: '', sessionId: 's1' }],
    ['expandNode without nodeId', { type: 'expandNode', sessionId: 's1' }],
    ['expandNode without sessionId', { type: 'expandNode', nodeId: 'n1' }],
    ['selectSession without sessionId', { type: 'selectSession' }],
    ['a numeric sessionId', { type: 'selectSession', sessionId: 1 }],
    ['a null sessionId', { type: 'selectSession', sessionId: null }],
    ['an object sessionId', { type: 'selectSession', sessionId: { toString: 1 } }],
    ['an array nodeId', { type: 'expandNode', sessionId: 's', nodeId: ['n'] }],
    ['an empty sessionId', { type: 'selectSession', sessionId: '' }],
    ['an empty nodeId', { type: 'expandNode', sessionId: 's', nodeId: '' }],
    ['a deeply nested object', deeplyNested(2_000)],
  ];

  for (const [name, value] of rejected) {
    it(name, () => {
      expect(isWebviewToHostMessage(value)).toBe(false);
    });
  }

  it('an object whose type is an inherited property, not an own one', () => {
    const parent = { type: 'selectSession', sessionId: 's1' };
    expect(isWebviewToHostMessage(Object.create(parent) as unknown)).toBe(false);
  });

  it('an object whose type is a getter — without ever calling the getter', () => {
    let called = 0;
    const hostile = {
      get type() {
        called += 1;
        throw new Error('boom');
      },
      sessionId: 's1',
    };
    expect(isWebviewToHostMessage(hostile)).toBe(false);
    expect(called).toBe(0);
  });

  it('a Proxy whose traps throw', () => {
    const hostile = new Proxy(
      { type: 'selectSession', sessionId: 's1' },
      {
        getOwnPropertyDescriptor(): never {
          throw new Error('trap');
        },
        has(): never {
          throw new Error('trap');
        },
      },
    );
    expect(isWebviewToHostMessage(hostile)).toBe(false);
  });
});

describe('isWebviewToHostMessage — prototype pollution', () => {
  const payloads: readonly [string, string][] = [
    [
      '__proto__ alongside a valid message',
      '{"type":"selectSession","sessionId":"s1","__proto__":{"polluted":"yes"}}',
    ],
    [
      'a nested __proto__',
      '{"type":"expandNode","sessionId":"s","nodeId":{"__proto__":{"polluted":"yes"}}}',
    ],
    ['constructor', '{"type":"selectSession","sessionId":"s1","constructor":{}}'],
    ['prototype', '{"type":"selectSession","sessionId":"s1","prototype":{}}'],
  ];

  for (const [name, json] of payloads) {
    it(`rejects ${name} and mutates nothing`, () => {
      const parsed: unknown = JSON.parse(json);
      const accepted = isWebviewToHostMessage(parsed);
      const probe = {} as Record<string, unknown>;
      expect(probe['polluted']).toBeUndefined();
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty('polluted');
      // The nested case carries no forbidden key at the top level, but its
      // nodeId is an object, so it is rejected on type anyway.
      expect(accepted).toBe(false);
    });
  }

  it('rejects a message assembled with a poisoned prototype', () => {
    const poisoned = Object.create({ nodeId: 'inherited' }) as Record<string, unknown>;
    poisoned['type'] = 'expandNode';
    poisoned['sessionId'] = 's1';
    expect(isWebviewToHostMessage(poisoned)).toBe(false);
  });
});

/** `{a:{a:{a:…}}}`, deep enough that a recursive validator would blow the stack. */
function deeplyNested(depth: number): unknown {
  let value: unknown = { type: 'selectSession', sessionId: 's1' };
  for (let i = 0; i < depth; i += 1) value = { a: value };
  return value;
}

// ---------------------------------------------------------------------------
// (b) SessionBridge — snapshot / diff contract
// ---------------------------------------------------------------------------

describe('SessionBridge — snapshot first', () => {
  it('sends a snapshot as the first message to a fresh webview', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    bridge.publish(emission({ sessions: [session('s1')], addedSessionIds: ['s1'] }));

    expect(port.types()).toEqual(['snapshot']);
    expect(port.sent[0]).toEqual({ type: 'snapshot', sessions: [session('s1')] });
    expect(bridge.counters.snapshotsSent).toBe(1);
    // The first snapshot is not "forced": there was never a diff path to take.
    expect(bridge.counters.snapshotsForced).toBe(0);
  });

  it('sends a snapshot even when the first emission is empty', () => {
    const port = new RecordingPort();
    new SessionBridge(port).publish(emission());
    expect(port.types()).toEqual(['snapshot']);
    expect(port.sent[0]).toEqual({ type: 'snapshot', sessions: [] });
  });

  it('sends a fresh snapshot after reset, which is what a webview reload is', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    firstSnapshot(bridge, [session('s1')]);
    bridge.reset();
    expect(bridge.knownSessionIds).toEqual([]);
    bridge.publish(emission({ sessions: [session('s1')] }));
    expect(port.types()).toEqual(['snapshot', 'snapshot']);
  });
});

describe('SessionBridge — diffs', () => {
  it('sends a diff once the webview holds the session', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    firstSnapshot(bridge, [session('s1')]);

    const patch: SessionPatch = { fields: { liveness: 'idle' } };
    bridge.publish(
      emission({
        sessions: [{ ...session('s1'), liveness: 'idle' }],
        diffs: [{ sessionId: 's1', patch }],
      }),
    );

    expect(port.types()).toEqual(['snapshot', 'diff']);
    expect(port.sent[1]).toEqual({ type: 'diff', sessionId: 's1', patch });
    expect(bridge.counters.diffsSent).toBe(1);
    expect(bridge.counters.snapshotsSent).toBe(1);
  });

  it('sends nothing at all when nothing changed', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    firstSnapshot(bridge, [session('s1')]);
    bridge.publish(emission({ sessions: [session('s1')] }));
    expect(port.types()).toEqual(['snapshot']);
  });

  it('never sends a diff for a session the webview does not hold', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    firstSnapshot(bridge, [session('s1')]);

    bridge.publish(
      emission({
        sessions: [session('s1'), session('s2')],
        diffs: [{ sessionId: 's2', patch: { fields: { liveness: 'idle' } } }],
      }),
    );

    expect(port.types()).toEqual(['snapshot', 'snapshot']);
    expect(bridge.counters.unknownSessionDiffs).toBe(1);
    expect(bridge.counters.snapshotsForced).toBe(1);
    expect(port.sent.some((m) => m.type === 'diff')).toBe(false);
  });

  it('forces a snapshot when a session is added', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    firstSnapshot(bridge, [session('s1')]);
    bridge.publish(
      emission({ sessions: [session('s1'), session('s2')], addedSessionIds: ['s2'] }),
    );
    expect(port.types()).toEqual(['snapshot', 'snapshot']);
    expect(bridge.knownSessionIds).toEqual(['s1', 's2']);
  });

  it('forces a snapshot when a session is removed, and forgets it', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    firstSnapshot(bridge, [session('s1'), session('s2')]);
    bridge.publish(
      emission({ sessions: [session('s1')], removedSessionIds: ['s2'] }),
    );
    expect(port.types()).toEqual(['snapshot', 'snapshot']);
    expect(bridge.knownSessionIds).toEqual(['s1']);
  });

  it('sends one diff per changed session, in emission order', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    firstSnapshot(bridge, [session('s1'), session('s2')]);
    bridge.publish(
      emission({
        sessions: [session('s1'), session('s2')],
        diffs: [
          { sessionId: 's2', patch: { fields: { liveness: 'idle' } } },
          { sessionId: 's1', patch: { fields: { liveness: 'ended' } } },
        ],
      }),
    );
    expect(port.sent.slice(1).map((m) => (m.type === 'diff' ? m.sessionId : m.type)))
      .toEqual(['s2', 's1']);
  });
});

describe('SessionBridge — patch-failure recovery', () => {
  /** Addresses a node id that is not in the tree: applySessionPatch throws. */
  const UNAPPLIABLE: SessionPatch = {
    tree: [{ op: 'updateAgent', id: 'no-such-node', fields: { status: 'done' } }],
  };

  it('sends a snapshot instead of a diff that cannot be applied', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    firstSnapshot(bridge, [session('s1')]);

    bridge.publish(
      emission({ sessions: [session('s1')], diffs: [{ sessionId: 's1', patch: UNAPPLIABLE }] }),
    );

    expect(port.types()).toEqual(['snapshot', 'snapshot']);
    expect(bridge.counters.patchFailures).toBe(1);
    expect(bridge.counters.snapshotsForced).toBe(1);
    expect(bridge.counters.diffsSent).toBe(0);
  });

  it('abandons the WHOLE round, so no half-applied diff reaches the webview', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    firstSnapshot(bridge, [session('s1'), session('s2')]);

    bridge.publish(
      emission({
        sessions: [session('s1'), session('s2')],
        diffs: [
          { sessionId: 's1', patch: { fields: { liveness: 'idle' } } },
          { sessionId: 's2', patch: UNAPPLIABLE },
        ],
      }),
    );

    expect(port.types()).toEqual(['snapshot', 'snapshot']);
    expect(bridge.counters.diffsSent).toBe(0);
  });

  it('keeps working after a failure: the next change diffs again', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    firstSnapshot(bridge, [session('s1')]);
    bridge.publish(
      emission({ sessions: [session('s1')], diffs: [{ sessionId: 's1', patch: UNAPPLIABLE }] }),
    );
    bridge.publish(
      emission({
        sessions: [{ ...session('s1'), liveness: 'idle' }],
        diffs: [{ sessionId: 's1', patch: { fields: { liveness: 'idle' } } }],
      }),
    );
    expect(port.types()).toEqual(['snapshot', 'snapshot', 'diff']);
  });

  it('tracks the webview belief through the same reducer the webview runs', () => {
    // The bridge's baseline is what applySessionPatch produced, not what the
    // model said the next state was. A second patch chained onto the first
    // therefore has to apply against the applied result.
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    const before = session('s1');
    firstSnapshot(bridge, [before]);

    const withChild = session('s1', agent('root', [agent('a1')]));
    const insert = diffSessionState(before, withChild);
    expect(insert).toBeDefined();
    bridge.publish(
      emission({ sessions: [withChild], diffs: [{ sessionId: 's1', patch: insert as SessionPatch }] }),
    );

    const withoutChild = session('s1');
    const remove = diffSessionState(withChild, withoutChild);
    expect(remove).toBeDefined();
    bridge.publish(
      emission({ sessions: [withoutChild], diffs: [{ sessionId: 's1', patch: remove as SessionPatch }] }),
    );

    expect(port.types()).toEqual(['snapshot', 'diff', 'diff']);
    expect(bridge.counters.patchFailures).toBe(0);
  });
});

describe('SessionBridge — schemaMismatch', () => {
  it('sends one per refused session, after the state message', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    bridge.publish(
      emission({
        sessions: [session('s1'), session('s2')],
        addedSessionIds: ['s1', 's2'],
        schemaMismatchSessionIds: ['s1', 's2'],
      }),
    );
    expect(port.types()).toEqual(['snapshot', 'schemaMismatch', 'schemaMismatch']);
    expect(port.sent[1]).toEqual({ type: 'schemaMismatch', sessionId: 's1' });
    expect(port.sent[2]).toEqual({ type: 'schemaMismatch', sessionId: 's2' });
    expect(bridge.counters.schemaMismatchesSent).toBe(2);
  });

  it('is sent alongside a diff round too', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    firstSnapshot(bridge, [session('s1')]);
    bridge.publish(
      emission({
        sessions: [{ ...session('s1'), schemaOk: false }],
        diffs: [{ sessionId: 's1', patch: { fields: { schemaOk: false } } }],
        schemaMismatchSessionIds: ['s1'],
      }),
    );
    expect(port.types()).toEqual(['snapshot', 'diff', 'schemaMismatch']);
  });
});

describe('SessionBridge — degraded', () => {
  it('sends the first state it is told, degraded or not', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    bridge.publishDegraded({ degraded: false });
    expect(port.sent).toEqual([{ type: 'degraded', degraded: false }]);
  });

  it('carries the reason when degraded', () => {
    const port = new RecordingPort();
    new SessionBridge(port).publishDegraded({
      degraded: true,
      reason: 'noHookEvents',
    });
    expect(port.sent).toEqual([
      { type: 'degraded', degraded: true, reason: 'noHookEvents' },
    ]);
  });

  it('does not nag: an unchanged state is not re-sent', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    for (let i = 0; i < 50; i += 1) {
      bridge.publishDegraded({ degraded: true, reason: 'noHookEvents' });
    }
    expect(port.sent).toHaveLength(1);
    expect(bridge.counters.degradedSent).toBe(1);
  });

  it('sends on every transition, including a changed reason', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    bridge.publishDegraded({ degraded: true, reason: 'noHookEvents' });
    bridge.publishDegraded({ degraded: true, reason: 'listenerDown' });
    bridge.publishDegraded({ degraded: false });
    bridge.publishDegraded({ degraded: false });
    bridge.publishDegraded({ degraded: true, reason: 'listenerDown' });
    expect(port.sent).toEqual([
      { type: 'degraded', degraded: true, reason: 'noHookEvents' },
      { type: 'degraded', degraded: true, reason: 'listenerDown' },
      { type: 'degraded', degraded: false },
      { type: 'degraded', degraded: true, reason: 'listenerDown' },
    ]);
  });

  it('never carries a reason when not degraded', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    bridge.publishDegraded({ degraded: true, reason: 'listenerDown' });
    bridge.publishDegraded({ degraded: false, reason: 'listenerDown' });
    expect(port.sent[1]).toEqual({ type: 'degraded', degraded: false });
  });

  it('re-sends after reset, because the new webview was never told', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    bridge.publishDegraded({ degraded: true, reason: 'noHookEvents' });
    bridge.reset();
    bridge.publishDegraded({ degraded: true, reason: 'noHookEvents' });
    expect(port.sent).toHaveLength(2);
  });

  it('is independent of content: a refused session changes nothing here (G2)', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    bridge.publishDegraded({ degraded: false });
    bridge.publish(
      emission({
        sessions: [session('s1')],
        addedSessionIds: ['s1'],
        schemaMismatchSessionIds: ['s1'],
      }),
    );
    expect(port.types()).toEqual(['degraded', 'snapshot', 'schemaMismatch']);
    expect(bridge.counters.degradedSent).toBe(1);
  });
});

describe('SessionBridge — a port that throws', () => {
  it('does not propagate the throw', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    port.throwNext = true;
    expect(() =>
      bridge.publish(emission({ sessions: [session('s1')], addedSessionIds: ['s1'] })),
    ).not.toThrow();
    expect(bridge.counters.postFailures).toBe(1);
    expect(bridge.counters.snapshotsSent).toBe(0);
  });

  it('re-snapshots afterwards rather than diffing against a state never sent', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    firstSnapshot(bridge, [session('s1')]);
    port.throwNext = true;
    bridge.publish(
      emission({
        sessions: [{ ...session('s1'), liveness: 'idle' }],
        diffs: [{ sessionId: 's1', patch: { fields: { liveness: 'idle' } } }],
      }),
    );
    expect(bridge.counters.diffsSent).toBe(0);
    expect(bridge.knownSessionIds).toEqual([]);

    bridge.publish(
      emission({
        sessions: [{ ...session('s1'), liveness: 'idle' }],
        diffs: [{ sessionId: 's1', patch: { fields: { liveness: 'ended' } } }],
      }),
    );
    expect(port.types()).toEqual(['snapshot', 'snapshot']);
  });
});

describe('SessionBridge — counters', () => {
  it('are a copy; mutating what the getter returns changes nothing', () => {
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    const counters = bridge.counters;
    counters.snapshotsSent = 999;
    expect(bridge.counters.snapshotsSent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) Parked grafts, end to end, from a fixture that really parks
// ---------------------------------------------------------------------------

/**
 * `SessionState.parked` is host -> webview only. What matters here is not that
 * the field exists but that it survives the transport: the bridge sends a
 * snapshot, then patches, and it maintains its own copy of the webview's belief
 * by running the SAME reducer the webview runs. A reducer that dropped `parked`
 * would leave the bridge and the webview agreeing on a wrong state, which no
 * counter would notice.
 *
 * So the whole path is driven for real — `graftSession` -> `SessionModel` ->
 * `SessionBridge` -> `RecordingPort` — and the recorded wire messages are then
 * replayed exactly as `webview/store.ts` replays them.
 *
 * The fixture is chosen by property (graft it, ask whether it parked), never by
 * name and never by count.
 */
const SYNTHETIC_GRAFT_ROOT = fileURLToPath(
  new URL('../../fixtures/synthetic-graft', import.meta.url),
);

/**
 * Any absolute path at all: the model only compares its slug against the one a
 * session is registered under, and both sides are derived from this constant by
 * `slugifyWorkspace`. Nothing here touches the filesystem at this path, so it is
 * deliberately not a real directory on anyone's machine.
 */
const WORKSPACE = 'C:\\synthetic\\not-a-real-workspace';

interface GraftFixture {
  caseName: string;
  mainPath: string;
  sessionId: string;
  parkedCount: number;
}

async function subdirs(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Every committed synthetic-graft transcript that fingerprints. */
async function graftFixtures(): Promise<GraftFixture[]> {
  const out: GraftFixture[] = [];
  for (const caseName of await subdirs(SYNTHETIC_GRAFT_ROOT)) {
    const caseDir = join(SYNTHETIC_GRAFT_ROOT, caseName);
    for (const slugName of await subdirs(caseDir)) {
      const slugDir = join(caseDir, slugName);
      const mains = (await readdir(slugDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => e.name)
        .sort();
      for (const main of mains) {
        const mainPath = join(slugDir, main);
        const result = await graftSession(mainPath);
        if (!result.ok) continue;
        out.push({
          caseName,
          mainPath,
          sessionId: main.replace(/\.jsonl$/, ''),
          parkedCount: result.snapshot.parked.length,
        });
      }
    }
  }
  return out;
}

describe('SessionBridge — a parked graft survives the transport', () => {
  it('snapshot then diff: the wire carries parked, and the webview still has it', async () => {
    const all = await graftFixtures();
    const parking = all.find((f) => f.parkedCount > 0);
    const clean = all.find((f) => f.parkedCount === 0);
    expect(parking, 'no committed graft fixture parks an agent').toBeDefined();
    expect(clean, 'no committed graft fixture parks nothing').toBeDefined();
    if (parking === undefined || clean === undefined) return;

    const slug = slugifyWorkspace(WORKSPACE);
    const model = new SessionModel({
      workspacePath: WORKSPACE,
      liveness: new LivenessEngine({ now: () => 1_700_000_060_000 }),
    });
    const port = new RecordingPort();
    const bridge = new SessionBridge(port);
    const sessionId = clean.sessionId;

    // Round 1 — the snapshot a fresh webview starts from. Nothing parked yet.
    model.ingestGraftResult(sessionId, slug, await graftSession(clean.mainPath));
    bridge.publish(model.emit());

    // Round 2 — the parking graft arrives. The bridge has already snapshotted,
    // so this must go out as a diff, and the diff must carry `parked`.
    model.ingestGraftResult(sessionId, slug, await graftSession(parking.mainPath));
    bridge.publish(model.emit());

    expect(port.types()).toEqual(['snapshot', 'diff']);
    expect(bridge.counters.snapshotsForced).toBe(0);
    expect(bridge.counters.patchFailures).toBe(0);

    // Replay the recorded messages the way `webview/store.ts` does: adopt the
    // snapshot, then apply each patch with the shared reducer.
    const webview = new Map<string, SessionState>();
    for (const message of port.sent) {
      if (message.type === 'snapshot') {
        webview.clear();
        for (const s of message.sessions) webview.set(s.sessionId, s);
      } else if (message.type === 'diff') {
        const prev = webview.get(message.sessionId);
        expect(prev, `diff for a session the webview never got: ${message.sessionId}`).toBeDefined();
        if (prev === undefined) continue;
        webview.set(message.sessionId, applySessionPatch(prev, message.patch));
      }
    }

    const snapshotMessage = port.sent[0];
    expect(snapshotMessage?.type).toBe('snapshot');
    if (snapshotMessage?.type === 'snapshot') {
      expect(snapshotMessage.sessions[0]?.parked).toStrictEqual([]);
    }
    const diffMessage = port.sent[1];
    expect(diffMessage?.type).toBe('diff');
    if (diffMessage?.type === 'diff') {
      expect(diffMessage.patch.parked).toHaveLength(parking.parkedCount);
    }

    // What the webview now holds must be what the host holds, parked included.
    const rendered = webview.get(sessionId);
    expect(rendered?.parked).toHaveLength(parking.parkedCount);
    expect(rendered).toStrictEqual(model.sessionState(sessionId));
  });
});

describe('isWebviewToHostMessage — parked is outbound only', () => {
  it('rejects a parked payload arriving from the webview side', () => {
    expect(
      isWebviewToHostMessage({
        type: 'parked',
        sessionId: 's1',
        parked: [{ agentId: 'a1', code: 'noMatchingToolUse', reason: 'injected' }],
      }),
    ).toBe(false);
  });

  it('rejects a snapshot message replayed inbound, parked and all', () => {
    expect(
      isWebviewToHostMessage({
        type: 'snapshot',
        sessions: [{ sessionId: 's1', parked: [{ agentId: 'a1' }] }],
      }),
    ).toBe(false);
  });

  it('accepts a valid message carrying a stray parked key, and reads nothing from it', () => {
    // Extra keys were already accepted and ignored — that is the existing case
    // named "a message carrying extra keys the host does not read", and this
    // adds nothing to the guard. It is asserted here so that "the guard covers
    // parked" cannot be misread as "the guard now parses parked". It does not,
    // because no inbound message carries it.
    const message = {
      type: 'selectSession',
      sessionId: 's1',
      parked: [{ agentId: 'a1', code: 'nonsense' }],
    };
    expect(isWebviewToHostMessage(message)).toBe(true);
    expect('parked' in message).toBe(true);
  });
});
