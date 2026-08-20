// @vitest-environment jsdom
//
// The five UI states, one file: live, idle, ended, unsupported, degraded.
//
// This is the CODE half of the PLAN Phase 4 DoD item "all UI states
// screenshot-verified". The screenshots themselves need a human at a real
// VS Code window and are not claimed here; what is claimed is that each of the
// five states renders, renders differently from the other four, and says which
// state it is in a place a screenshot check can read.
//
// Four of the five are values of `SessionState.liveness`. `degraded` is not —
// it is the hook tap's health and arrives on its own message, so it composes
// with the other four rather than replacing them (G2: a silent hook tap costs
// "what is running right now", not the tree).
//
// Mounts the REAL bundle through `testkit.ts`, the same esbuild + Svelte
// pipeline `npm run build` runs. See `render.test.ts` for why.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionState, WebviewToHostMessage } from '../src/model/events.js';
import type { Store } from './store.js';
import type { WebviewHarness } from './testkit.js';
import { all, loadHarness, one } from './testkit.js';
import { LIVENESS_INFERRED_LABEL, LIVENESS_VALUES, livenessTitle } from './format.js';
import { liveSession, unsupportedSession } from './testdata.js';

let harness: WebviewHarness;

beforeAll(async () => {
  harness = await loadHarness();
}, 60_000);

interface Mounted {
  container: HTMLElement;
  store: Store;
  sent: WebviewToHostMessage[];
  dispose: () => void;
}

const mounted: Mounted[] = [];

function render(): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const sent: WebviewToHostMessage[] = [];
  const started = harness.start(container, { postMessage: (m) => sent.push(m) });
  // Idempotent, and it removes itself from `mounted`: a test that disposes a
  // renderer mid-test must not be unmounted a second time by `afterEach`, and
  // a renderer left mounted would keep receiving every later `send()` — both
  // mounted apps would then be answering the same assertions.
  let disposed = false;
  const record: Mounted = {
    container,
    store: started.store,
    sent,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const at = mounted.indexOf(record);
      if (at >= 0) mounted.splice(at, 1);
      started.dispose();
      container.remove();
    },
  };
  mounted.push(record);
  return record;
}

/** Feed a host message the way VS Code does — through `window.postMessage`. */
function send(message: unknown): void {
  harness.flushSync(() => {
    globalThis.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

function click(element: HTMLElement): void {
  harness.flushSync(() => {
    element.click();
  });
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

/**
 * A session in one of the three healthy liveness states.
 *
 * `liveness` is set on the state, not simulated: it is the field the host
 * computes in `src/model/liveness.ts` and hands over on the wire, and it is
 * the hand-off line this file mutates to prove the assertions below are real.
 * `fixture-render.test.ts` drives the same three values out of the real
 * liveness engine instead of setting them.
 */
function sessionWith(liveness: SessionState['liveness']): SessionState {
  return liveSession({ liveness });
}

// ---------------------------------------------------------------------------
// live / idle / ended
// ---------------------------------------------------------------------------

describe('the three healthy liveness states each render distinguishably', () => {
  for (const liveness of ['live', 'idle', 'ended'] as const) {
    it(`renders ${liveness} in the panel, the header and the rail`, () => {
      const { container } = render();
      send({ type: 'snapshot', sessions: [sessionWith(liveness)] });

      // One place answers "which state is this?" for the whole panel.
      expect(one(container, 'app').dataset['liveness']).toBe(liveness);
      expect(one(container, 'app').dataset['refused']).toBe('false');
      expect(one(container, 'app').dataset['degraded']).toBe('false');

      const header = one(container, 'header-liveness');
      expect(header.dataset['liveness']).toBe(liveness);
      expect(header.textContent?.trim()).toBe(liveness);
      expect(header.getAttribute('title')).toBe(livenessTitle(liveness));

      const rail = one(container, 'rail-item');
      expect(rail.dataset['liveness']).toBe(liveness);
      expect(rail.dataset['refused']).toBe('false');
      expect(one(container, 'rail-liveness').textContent?.trim()).toBe(liveness);

      // None of the three is a refusal and none is degraded: the tree renders.
      expect(all(container, 'tree-node').length).toBeGreaterThan(0);
      expect(all(container, 'refusal-screen')).toHaveLength(0);
      expect(all(container, 'degraded-banner')).toHaveLength(0);
      expect(all(container, 'header-liveness-inferred')).toHaveLength(0);
    });
  }

  it('gives each of the four liveness values a different rendering', () => {
    // The point of the DoD item is that the states are TOLD APART on screen.
    // Four states rendering four identical panels would satisfy every
    // per-state assertion above and fail the actual requirement.
    const signatures = LIVENESS_VALUES.map((liveness) => {
      const { container, dispose } = render();
      const session =
        liveness === 'unsupported'
          ? unsupportedSession()
          : liveSession({ liveness, sessionId: 'session-x' });
      send({ type: 'snapshot', sessions: [session] });
      const app = one(container, 'app');
      const signature = [
        app.dataset['liveness'],
        app.dataset['refused'],
        one(container, 'rail-liveness').textContent?.trim(),
        String(all(container, 'refusal-screen').length),
      ].join('|');
      dispose();
      return signature;
    });

    expect(new Set(signatures).size).toBe(LIVENESS_VALUES.length);
    // Every liveness value must also produce a DIFFERENT explanation.
    expect(new Set(LIVENESS_VALUES.map(livenessTitle)).size).toBe(LIVENESS_VALUES.length);
  });

  it('names no number of seconds anywhere on screen', () => {
    // The recency threshold is configurable in `liveness.ts` and the webview is
    // never told its value, so any duration printed beside a liveness state
    // would be a number the renderer cannot stand behind.
    const { container } = render();
    for (const liveness of ['live', 'idle', 'ended'] as const) {
      send({ type: 'snapshot', sessions: [sessionWith(liveness)] });
      const text = one(container, 'session-header').textContent ?? '';
      expect(text).not.toMatch(/\b\d+\s*(s|sec|secs|seconds|m|min|minutes)\b/);
      expect(one(container, 'header-liveness').getAttribute('title')).not.toMatch(/\d/);
    }
  });
});

// ---------------------------------------------------------------------------
// unsupported (G3 — refuse, don't guess)
// ---------------------------------------------------------------------------

describe('unsupported', () => {
  it('replaces the tree with the refusal screen and says so in every surface', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [unsupportedSession()] });

    expect(one(container, 'app').dataset['liveness']).toBe('unsupported');
    expect(one(container, 'app').dataset['refused']).toBe('true');

    const refusal = one(container, 'refusal-screen');
    expect(refusal.dataset['liveness']).toBe('unsupported');
    expect(one(refusal, 'refusal-session-id').textContent).toContain('session-unsupported');
    expect(one(refusal, 'refusal-cause').textContent).toContain('on-disk format');

    // Not "a tree with a warning" — no tree, and no header either.
    expect(all(container, 'tree-node')).toHaveLength(0);
    expect(all(container, 'session-header')).toHaveLength(0);

    const rail = one(container, 'rail-item');
    expect(rail.dataset['liveness']).toBe('unsupported');
    expect(rail.dataset['refused']).toBe('true');
  });

  it('shows unsupported in the rail for a session refused AFTER a live snapshot', () => {
    // The seam this closes: `schemaMismatch` refuses a session without
    // changing the `liveness` the last snapshot delivered, so without
    // `displayLiveness` the rail keeps saying "live" beside a main pane
    // showing the refusal screen. Two surfaces, one session, disagreeing.
    const { container } = render();
    send({ type: 'snapshot', sessions: [sessionWith('live')] });
    expect(one(container, 'rail-item').dataset['liveness']).toBe('live');

    send({ type: 'schemaMismatch', sessionId: 'session-live' });

    expect(one(container, 'rail-item').dataset['liveness']).toBe('unsupported');
    expect(one(container, 'rail-item').dataset['refused']).toBe('true');
    expect(one(container, 'rail-liveness').textContent?.trim()).toBe('unsupported');
    expect(one(container, 'app').dataset['liveness']).toBe('unsupported');
    expect(all(container, 'refusal-screen')).toHaveLength(1);
    expect(all(container, 'tree-node')).toHaveLength(0);
  });

  it('leaves the other sessions in the rail alone', () => {
    const { container } = render();
    send({
      type: 'snapshot',
      sessions: [unsupportedSession(), liveSession({ sessionId: 'session-other' })],
    });
    const items = all(container, 'rail-item');
    expect(items.map((i) => i.dataset['liveness'])).toStrictEqual(['unsupported', 'live']);
    expect(items.map((i) => i.dataset['refused'])).toStrictEqual(['true', 'false']);
  });
});

// ---------------------------------------------------------------------------
// degraded (G2 — source separation, spec C4 — informative, not nagging)
// ---------------------------------------------------------------------------

describe('degraded', () => {
  it('banners the tap, keeps the tree, and marks the liveness as inferred', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [sessionWith('live')] });
    send({ type: 'degraded', degraded: true, reason: 'noHookEvents' });

    expect(one(container, 'app').dataset['degraded']).toBe('true');
    const banner = one(container, 'degraded-banner');
    expect(banner.dataset['reason']).toBe('noHookEvents');
    expect(banner.textContent).toContain('no hook events received');

    // G2: losing the hook tap costs liveness, not content.
    expect(all(container, 'tree-node').length).toBeGreaterThan(0);

    // ...and the liveness value that remains is marked as what it now is.
    const marker = one(container, 'header-liveness-inferred');
    expect(marker.textContent).toContain(LIVENESS_INFERRED_LABEL);
    expect(one(container, 'session-header').dataset['livenessInferred']).toBe('true');
  });

  it('carries the reason into the DOM for both reasons', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [sessionWith('idle')] });
    send({ type: 'degraded', degraded: true, reason: 'listenerDown' });
    expect(one(container, 'degraded-banner').dataset['reason']).toBe('listenerDown');
    expect(one(container, 'degraded-banner').textContent).toContain(
      'the hook listener is not running',
    );
  });

  it('keeps the inferred marker after the banner is dismissed', () => {
    // Dismissing silences one episode; it does not improve the source of the
    // number. Without this the user dismisses the banner and then reads
    // "live" with nothing on screen saying where "live" came from.
    const { container } = render();
    send({ type: 'snapshot', sessions: [sessionWith('live')] });
    send({ type: 'degraded', degraded: true, reason: 'listenerDown' });
    click(one(container, 'degraded-dismiss'));

    expect(all(container, 'degraded-banner')).toHaveLength(0);
    expect(all(container, 'header-liveness-inferred')).toHaveLength(1);
    expect(one(container, 'app').dataset['degraded']).toBe('true');
  });

  it('drops both the banner and the marker when the tap recovers', () => {
    const { container } = render();
    send({ type: 'snapshot', sessions: [sessionWith('live')] });
    send({ type: 'degraded', degraded: true, reason: 'listenerDown' });
    send({ type: 'degraded', degraded: false });

    expect(all(container, 'degraded-banner')).toHaveLength(0);
    expect(all(container, 'header-liveness-inferred')).toHaveLength(0);
    expect(one(container, 'app').dataset['degraded']).toBe('false');
    expect(one(container, 'session-header').dataset['livenessInferred']).toBe('false');
  });

  it('composes with a refusal: the banner sits above the refusal screen', () => {
    // Degraded is the hook tap; unsupported is the content tap. They are
    // independent sources (G2) and both can be true at once.
    const { container } = render();
    send({ type: 'snapshot', sessions: [unsupportedSession()] });
    send({ type: 'degraded', degraded: true, reason: 'noHookEvents' });

    expect(all(container, 'degraded-banner')).toHaveLength(1);
    expect(all(container, 'refusal-screen')).toHaveLength(1);
    expect(all(container, 'tree-node')).toHaveLength(0);
    // No header exists to carry the marker in a refusal — that is correct, not
    // a gap: the refusal screen is the whole main pane.
    expect(all(container, 'header-liveness-inferred')).toHaveLength(0);
  });
});
