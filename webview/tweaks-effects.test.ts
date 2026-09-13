// @vitest-environment jsdom
//
// What the three renderer-side tweaks DO — v0.8.0 Phase 7, DoD 7.6: "each
// setting's effect has a behaviour test (follow-new-session moves the deck;
// drawer opens on enter; expanded by default)".
//
// THE FOURTH, `defaultOrdering`, IS NOT HERE. Its effect is the deck's
// control-bar sort, which `Deck.svelte` holds
// (`let sortMode = $state.raw<DeckSortMode>(DEFAULT_DECK_SORT)`), and that file
// belongs to another package in this phase. Faking the effect in a test would
// be worse than its absence: it would report a wiring that does not exist.
//
// EVERY EFFECT IS DRIVEN THROUGH THE PRODUCT (D4). The app is mounted through
// `start()` — `webview/main.ts`'s own export, out of the SHIPPED bundle — the
// settings arrive as a real `MessageEvent`, sessions arrive as a real
// `snapshot`, and a session is entered by CLICKING its deck card. The recorded
// failure that shape exists to prevent is a test that hands the component the
// value production never sends it.
//
// Each effect is asserted THREE ways: on, off, and with no `settings` message
// at all. The third is the one that says the store's pre-message behaviour is
// the behaviour that shipped before this DoD, rather than a guessed default.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionState, WebviewToHostMessage } from '../src/model/events.js';
import type { Store } from './store.js';
import type { WebviewHarness } from './testkit.js';
import { all, loadHarness, one, press } from './testkit.js';
import { TESTID } from './canvas-contract.js';
import { liveSession, unsupportedSession } from './testdata.js';

let harness: WebviewHarness;

beforeAll(async () => {
  harness = await loadHarness();
}, 60_000);

interface Panel {
  container: HTMLElement;
  store: Store;
  sent: WebviewToHostMessage[];
  dispose: () => void;
}

const mounted: Panel[] = [];

function render(): Panel {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const sent: WebviewToHostMessage[] = [];
  const started = harness.start(container, { postMessage: (m) => sent.push(m) });
  const panel: Panel = {
    container,
    store: started.store,
    sent,
    dispose: () => {
      started.dispose();
      container.remove();
    },
  };
  mounted.push(panel);
  return panel;
}

function send(data: unknown): void {
  harness.flushSync(() => {
    globalThis.dispatchEvent(new MessageEvent('message', { data }));
  });
}

function act(fn: () => void): void {
  harness.flushSync(fn);
}

/** The host's `settings` message, carrying the four tweaks. */
function settings(tweaks: Record<string, boolean | string>): void {
  send({ type: 'settings', canvasAutoFit: true, tweaks });
}

const OFF: Record<string, boolean | string> = {
  followNewSessions: false,
  openDrawerOnEnter: false,
  drawerExpandedByDefault: false,
  defaultOrdering: 'live',
};

function snapshot(sessions: SessionState[]): void {
  send({ type: 'snapshot', sessions });
}

/** The deck cards, in DOM order. */
function cards(panel: Panel): HTMLElement[] {
  return all(panel.container, TESTID.deckBlob);
}

function card(panel: Panel, sessionId: string): HTMLElement {
  const found = cards(panel).filter((c) => c.dataset['sessionId'] === sessionId);
  expect(found, `no card for ${sessionId}`).toHaveLength(1);
  const first = found[0];
  if (first === undefined) throw new Error('unreachable');
  return first;
}

/** Which card the deck is drawing as selected, by its own attribute. */
function selectedCard(panel: Panel): string | undefined {
  const selected = cards(panel).filter((c) => c.dataset['selected'] === 'true');
  expect(selected.length, 'more than one card drawn as selected').toBeLessThan(2);
  return selected[0]?.dataset['sessionId'];
}

/** Enter a session the way a user does: click its card. */
function enter(panel: Panel, sessionId: string): void {
  act(() => press(card(panel, sessionId)));
}

/** The drawer, or `undefined` when it is not on screen. */
function drawer(panel: Panel): HTMLElement | undefined {
  return all(panel.container, TESTID.inspector)[0];
}

function other(sessionId: string): SessionState {
  return liveSession({ sessionId });
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

describe('followNewSessions — a session that appears moves the deck', () => {
  it('ON: the card that appears becomes the selected one', () => {
    const panel = render();
    settings({ ...OFF, followNewSessions: true });
    snapshot([other('session-a')]);
    // The first snapshot introduces every session at once and picks the first,
    // which is the rule this setting must not reverse.
    expect(selectedCard(panel)).toBe('session-a');

    snapshot([other('session-a'), other('session-b')]);
    // Not vacuous: both cards are on the deck, and the NEW one carries the
    // selection.
    expect(cards(panel)).toHaveLength(2);
    expect(selectedCard(panel)).toBe('session-b');
    expect(card(panel, 'session-a').dataset['selected']).toBe('false');
    expect(panel.store.getView().selectedSessionId).toBe('session-b');
  });

  it('OFF: the same snapshot leaves the selection where it was', () => {
    const panel = render();
    settings({ ...OFF, followNewSessions: false });
    snapshot([other('session-a')]);
    snapshot([other('session-a'), other('session-b')]);
    expect(cards(panel)).toHaveLength(2);
    expect(selectedCard(panel)).toBe('session-a');
  });

  it('with NO settings message at all, nothing follows', () => {
    const panel = render();
    snapshot([other('session-a')]);
    snapshot([other('session-a'), other('session-b')]);
    expect(cards(panel)).toHaveLength(2);
    expect(selectedCard(panel)).toBe('session-a');
  });

  it('ON: several appearing at once selects the last the host listed', () => {
    const panel = render();
    settings({ ...OFF, followNewSessions: true });
    snapshot([other('session-a')]);
    snapshot([other('session-a'), other('session-b'), other('session-c')]);
    expect(cards(panel)).toHaveLength(3);
    expect(selectedCard(panel)).toBe('session-c');
  });

  it('ON: a snapshot that introduces nothing new moves nothing', () => {
    const panel = render();
    settings({ ...OFF, followNewSessions: true });
    snapshot([other('session-a'), other('session-b')]);
    act(() => panel.store.selectSession('session-a'));
    expect(selectedCard(panel)).toBe('session-a');
    // A re-statement of the same two sessions. The host sends these for its
    // own reasons — a resync, a reload — and none of them is an appearance.
    snapshot([other('session-a'), other('session-b')]);
    expect(selectedCard(panel)).toBe('session-a');
  });

  it('ON: a session appearing while the user is INSIDE another one moves nothing', () => {
    const panel = render();
    settings({ ...OFF, followNewSessions: true });
    snapshot([other('session-a')]);
    enter(panel, 'session-a');
    expect(panel.store.getView().altitude).toBe('session');

    snapshot([other('session-a'), other('session-b')]);
    // The setting says "while the deck is open". Moving the selection here
    // would change what the whole panel is showing, under someone who is
    // reading something else.
    expect(panel.store.getView().selectedSessionId).toBe('session-a');
    expect(panel.store.getView().altitude).toBe('session');
  });

  it('ON: following is not a user intent, so nothing is posted to the host', () => {
    const panel = render();
    settings({ ...OFF, followNewSessions: true });
    snapshot([other('session-a')]);
    panel.sent.length = 0;
    snapshot([other('session-a'), other('session-b')]);
    expect(panel.sent).toStrictEqual([]);
    expect(panel.store.getView().selectedSessionId).toBe('session-b');
  });
});

describe('openDrawerOnEnter — entering a session opens its drawer', () => {
  it('ON: clicking a card opens the drawer on the session root', () => {
    const panel = render();
    settings({ ...OFF, openDrawerOnEnter: true });
    snapshot([liveSession()]);
    expect(drawer(panel)).toBeUndefined();

    enter(panel, 'session-live');
    const open = drawer(panel);
    expect(open, 'the drawer did not open').toBeDefined();
    const view = panel.store.getView();
    expect(view.inspectorOpen).toBe(true);
    expect(view.selectedNodeId).toBe('root');
    expect(view.altitude).toBe('inspector');
    // Not vacuous: the drawer is showing the ROOT, and the root's own calls.
    expect(one(panel.container, TESTID.inspector).textContent).toContain('main session');
  });

  it('OFF: clicking a card enters the session and opens nothing', () => {
    const panel = render();
    settings({ ...OFF, openDrawerOnEnter: false });
    snapshot([liveSession()]);
    enter(panel, 'session-live');
    expect(panel.store.getView().altitude).toBe('session');
    expect(panel.store.getView().selectedNodeId).toBeUndefined();
    expect(drawer(panel)).toBeUndefined();
  });

  it('with NO settings message at all, nothing opens', () => {
    const panel = render();
    snapshot([liveSession()]);
    enter(panel, 'session-live');
    expect(panel.store.getView().altitude).toBe('session');
    expect(drawer(panel)).toBeUndefined();
  });

  it('ON: a REFUSED session opens nothing — its interior renders no tree (G3)', () => {
    const panel = render();
    settings({ ...OFF, openDrawerOnEnter: true });
    snapshot([unsupportedSession({ sessionId: 'session-refused' })]);
    enter(panel, 'session-refused');
    const view = panel.store.getView();
    expect(view.refused).toBe(true);
    expect(view.selectedNodeId).toBeUndefined();
    expect(view.altitude).toBe('session');
    expect(drawer(panel)).toBeUndefined();
  });

  it('ON: Escape still walks out of the drawer it opened', () => {
    const panel = render();
    settings({ ...OFF, openDrawerOnEnter: true });
    snapshot([liveSession()]);
    enter(panel, 'session-live');
    act(() => panel.store.escape());
    expect(panel.store.getView().altitude).toBe('session');
    expect(drawer(panel)).toBeUndefined();
    act(() => panel.store.escape());
    expect(panel.store.getView().altitude).toBe('deck');
  });
});

describe('drawerExpandedByDefault — the height a drawer opens at', () => {
  it('ON, with the drawer opening on entry: it opens expanded', () => {
    const panel = render();
    settings({ ...OFF, openDrawerOnEnter: true, drawerExpandedByDefault: true });
    snapshot([liveSession()]);
    enter(panel, 'session-live');
    expect(drawer(panel)?.dataset['expanded']).toBe('true');
    expect(panel.store.getView().drawerExpanded).toBe(true);
  });

  it('OFF, same entry: it opens collapsed', () => {
    const panel = render();
    settings({ ...OFF, openDrawerOnEnter: true, drawerExpandedByDefault: false });
    snapshot([liveSession()]);
    enter(panel, 'session-live');
    expect(drawer(panel)?.dataset['expanded']).toBe('false');
  });

  it('ON: a drawer opened by CLICKING A CELL opens expanded too', () => {
    // The other way a drawer opens, and the one a user reaches most: pick a
    // node in the session interior. Driven by clicking the cell, which is
    // SVG — `press`, never `element.click()`.
    const panel = render();
    settings({ ...OFF, drawerExpandedByDefault: true });
    snapshot([liveSession()]);
    enter(panel, 'session-live');
    expect(drawer(panel)).toBeUndefined();

    const cell = all(panel.container, TESTID.nucleus)[0];
    expect(cell, 'no root cell to click').toBeDefined();
    act(() => {
      if (cell !== undefined) press(cell);
    });
    expect(drawer(panel)?.dataset['expanded']).toBe('true');
  });

  it('OFF: the same click opens it collapsed', () => {
    const panel = render();
    settings({ ...OFF, drawerExpandedByDefault: false });
    snapshot([liveSession()]);
    enter(panel, 'session-live');
    const cell = all(panel.container, TESTID.nucleus)[0];
    act(() => {
      if (cell !== undefined) press(cell);
    });
    expect(drawer(panel)?.dataset['expanded']).toBe('false');
  });

  it('with NO settings message at all, a drawer opens collapsed', () => {
    const panel = render();
    snapshot([liveSession()]);
    enter(panel, 'session-live');
    const cell = all(panel.container, TESTID.nucleus)[0];
    act(() => {
      if (cell !== undefined) press(cell);
    });
    expect(drawer(panel)?.dataset['expanded']).toBe('false');
  });

  it('ON: the user can still collapse it, and the next open is expanded again', () => {
    // The setting names the OPENING height, not a locked one. Toggling is
    // still the user's, and closing discards what they chose — which is the
    // §8.6 rule the setting now supplies the value for.
    const panel = render();
    settings({ ...OFF, openDrawerOnEnter: true, drawerExpandedByDefault: true });
    snapshot([liveSession()]);
    enter(panel, 'session-live');
    expect(drawer(panel)?.dataset['expanded']).toBe('true');

    act(() => press(one(panel.container, TESTID.drawerExpand)));
    expect(drawer(panel)?.dataset['expanded']).toBe('false');

    act(() => panel.store.setInspectorOpen(false));
    expect(drawer(panel)).toBeUndefined();
    act(() => panel.store.setInspectorOpen(true));
    expect(drawer(panel)?.dataset['expanded']).toBe('true');
  });

  it('OFF: the user can still expand it', () => {
    const panel = render();
    settings({ ...OFF, openDrawerOnEnter: true, drawerExpandedByDefault: false });
    snapshot([liveSession()]);
    enter(panel, 'session-live');
    act(() => press(one(panel.container, TESTID.drawerExpand)));
    expect(drawer(panel)?.dataset['expanded']).toBe('true');
  });

  it('a drawer already open keeps its height when the selection moves to another node', () => {
    const panel = render();
    settings({ ...OFF, drawerExpandedByDefault: false });
    snapshot([liveSession()]);
    enter(panel, 'session-live');
    const cell = all(panel.container, TESTID.nucleus)[0];
    act(() => {
      if (cell !== undefined) press(cell);
    });
    act(() => press(one(panel.container, TESTID.drawerExpand)));
    expect(drawer(panel)?.dataset['expanded']).toBe('true');

    // Moving the selection is not opening a drawer, so it does not resize the
    // one in front of the user.
    act(() => panel.store.selectNode('agent-1'));
    expect(panel.store.getView().selectedNodeId).toBe('agent-1');
    expect(drawer(panel)?.dataset['expanded']).toBe('true');
  });
});

describe('the settings message is the only source', () => {
  it('a later message changes the effect, with no reload', () => {
    const panel = render();
    settings({ ...OFF, followNewSessions: false });
    snapshot([other('session-a')]);
    snapshot([other('session-a'), other('session-b')]);
    expect(selectedCard(panel)).toBe('session-a');

    // The user flipped it in the Settings UI, or in the Tweaks panel. The host
    // re-sends on every configuration change.
    settings({ ...OFF, followNewSessions: true });
    snapshot([other('session-a'), other('session-b'), other('session-c')]);
    expect(selectedCard(panel)).toBe('session-c');
  });

  it('a settings message with NO record at all turns everything off, and does not throw', () => {
    // G3. `store.handleMessage` never throws and its guard reads the `type`
    // field alone, so a `settings` message without its record must leave a
    // working store rather than a dead one.
    const panel = render();
    settings({ ...OFF, followNewSessions: true, openDrawerOnEnter: true });
    send({ type: 'settings', canvasAutoFit: true });
    snapshot([liveSession({ sessionId: 'session-a' })]);
    snapshot([liveSession({ sessionId: 'session-a' }), liveSession({ sessionId: 'session-b' })]);
    expect(selectedCard(panel)).toBe('session-a');
    enter(panel, 'session-a');
    expect(drawer(panel)).toBeUndefined();
    // Still alive: the store went on reducing after the malformed message.
    expect(panel.store.getView().altitude).toBe('session');
  });

  it('a value of the wrong type turns nothing on', () => {
    const panel = render();
    // The record is typed `boolean | string` on the wire. A non-empty string
    // is truthy, and truthiness is not what is read.
    settings({ ...OFF, followNewSessions: 'true', openDrawerOnEnter: 'yes' });
    snapshot([other('session-a')]);
    snapshot([other('session-a'), other('session-b')]);
    expect(selectedCard(panel)).toBe('session-a');
    enter(panel, 'session-a');
    expect(drawer(panel)).toBeUndefined();
  });
});
