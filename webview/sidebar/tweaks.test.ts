// @vitest-environment jsdom
//
// The Tweaks panel — v0.8.0 Phase 7, DoD 7.6, the RENDERER half: "a 'Tweaks'
// sidebar tab renders them and writes through
// `workspace.getConfiguration().update`" and "the panel holds no state of its
// own (test: reload -> values equal settings)". The host half
// (`src/sidebar/provider.test.ts`, `src/extension.test.ts`) proves the
// `updateTweak` message reaches that `.update()` call and that the four keys
// are contributed and readable.
//
// EVERY TEST DRIVES THE PRODUCT (D4). Nothing here constructs a prop by hand:
// the sidebar is mounted through `startSidebar` — an export of
// `webview/main.ts`, the same entry point VS Code loads — out of the SHIPPED
// bundle, and a `settings` message arrives as a real `MessageEvent` on the
// window, which is the only way the host has of reaching this surface. The
// recorded failure this avoids is a component test that passes the value by
// hand and proves the component honours something nothing ever sends it; it
// has shipped in this repository four times.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WebviewToHostMessage } from '../../src/model/events.js';
import { TWEAK_SETTINGS } from '../../src/sidebar/tweaks.js';
import { DECK_SORTS } from '../store.js';
import type { WebviewHarness } from '../testkit.js';
import { all, loadHarness, one } from '../testkit.js';
import { TESTID } from '../canvas-contract.js';

let harness: WebviewHarness;

beforeAll(async () => {
  harness = await loadHarness();
}, 60_000);

interface Mounted {
  container: HTMLElement;
  sent: WebviewToHostMessage[];
  dispose: () => void;
}

const mounted: Mounted[] = [];

function render(): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const sent: WebviewToHostMessage[] = [];
  const started = harness.startSidebar(container, { postMessage: (m) => sent.push(m) });
  const record: Mounted = {
    container,
    sent,
    dispose: () => {
      started.dispose();
      container.remove();
    },
  };
  mounted.push(record);
  return record;
}

/**
 * Deliver a host `settings` message the way VS Code does.
 *
 * `canvasAutoFit` rides on the same message and is the PANEL's setting; the
 * sidebar ignores it. Sending it anyway is what makes this the real message
 * rather than a Tweaks-shaped subset of it.
 */
function send(tweaks: Record<string, boolean | string>, canvasAutoFit = true): void {
  harness.flushSync(() => {
    globalThis.dispatchEvent(
      new MessageEvent('message', { data: { type: 'settings', canvasAutoFit, tweaks } }),
    );
  });
}

function act(fn: () => void): void {
  harness.flushSync(fn);
}

/** Press a tab the way a user does. */
function showTab(m: Mounted, tab: 'menu' | 'tweaks'): void {
  const button = all(m.container, TESTID.sidebarTab).find((b) => b.dataset['tab'] === tab);
  expect(button, `no ${tab} tab`).toBeDefined();
  act(() => button?.click());
}

function rows(m: Mounted): HTMLElement[] {
  return all(m.container, TESTID.tweakRow);
}

function control(m: Mounted, key: string): HTMLElement {
  const found = all(m.container, TESTID.tweakControl).filter((c) => c.dataset['key'] === key);
  expect(found).toHaveLength(1);
  const first = found[0];
  if (first === undefined) throw new Error('unreachable');
  return first;
}

function checkbox(m: Mounted, key: string): HTMLInputElement {
  return control(m, key) as HTMLInputElement;
}

function select(m: Mounted, key: string): HTMLSelectElement {
  return control(m, key) as HTMLSelectElement;
}

/** Every value the four keys can be positioned at, as one message. */
const ALL_ON: Record<string, boolean | string> = {
  followNewSessions: true,
  openDrawerOnEnter: true,
  drawerExpandedByDefault: true,
  defaultOrdering: 'recent',
};

const ALL_OFF: Record<string, boolean | string> = {
  followNewSessions: false,
  openDrawerOnEnter: false,
  drawerExpandedByDefault: false,
  defaultOrdering: 'live',
};

/** Mounted, on the Tweaks tab. */
function onTweaks(): Mounted {
  const m = render();
  showTab(m, 'tweaks');
  return m;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

describe('the sidebar has two tabs', () => {
  it('shows exactly two, Menu first, with the menu tab the one selected', () => {
    const m = render();
    one(m.container, TESTID.sidebarTablist);
    const tabs = all(m.container, TESTID.sidebarTab);
    // The count beside the set: an empty tablist satisfies "no wrong tab".
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.dataset['tab'])).toStrictEqual(['menu', 'tweaks']);
    expect(tabs.map((t) => t.textContent?.trim())).toStrictEqual(['Menu', 'Tweaks']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toStrictEqual(['true', 'false']);
    expect(tabs.map((t) => t.getAttribute('role'))).toStrictEqual(['tab', 'tab']);
    // The menu is what is showing, and the Tweaks panel is not merely hidden.
    expect(all(m.container, TESTID.sidebarMenu)).toHaveLength(1);
    expect(all(m.container, TESTID.tweaksPanel)).toHaveLength(0);
  });

  it('pressing Tweaks swaps the panel, and pressing Menu swaps it back', () => {
    const m = render();
    showTab(m, 'tweaks');
    expect(all(m.container, TESTID.tweaksPanel)).toHaveLength(1);
    expect(all(m.container, TESTID.sidebarMenu)).toHaveLength(0);
    expect(one(m.container, TESTID.sidebarPanel).dataset['tab']).toBe('tweaks');

    showTab(m, 'menu');
    expect(all(m.container, TESTID.sidebarMenu)).toHaveLength(1);
    expect(all(m.container, TESTID.tweaksPanel)).toHaveLength(0);
  });

  it('the five menu entries are untouched by the tab', () => {
    const m = render();
    // DoD 7.6 asks for a TAB, not a sixth entry. `manifest.test.ts` and
    // `readme.test.ts` both pin that list; this is the webview saying the
    // same thing.
    expect(all(m.container, TESTID.sidebarEntry)).toHaveLength(5);
    showTab(m, 'tweaks');
    showTab(m, 'menu');
    expect(all(m.container, TESTID.sidebarEntry)).toHaveLength(5);
  });

  it('posts nothing on mount, and nothing on a settings message', () => {
    const m = onTweaks();
    send(ALL_ON);
    expect(m.sent).toStrictEqual([]);
  });
});

describe('the panel renders src/sidebar/tweaks.ts', () => {
  it('one row per setting, in order, each with its label, its detail and a control of its kind', () => {
    const m = onTweaks();
    send(ALL_ON);
    const list = rows(m);
    // Count beside the set, and the literal four beside the derived count:
    // an empty list satisfies every "no wrong row" assertion below.
    expect(list).toHaveLength(TWEAK_SETTINGS.length);
    expect(list).toHaveLength(4);
    expect(list.map((r) => r.dataset['key'])).toStrictEqual(TWEAK_SETTINGS.map((t) => t.key));
    // Spelled out, so a re-sort of the data goes red here too.
    expect(list.map((r) => r.dataset['key'])).toStrictEqual([
      'followNewSessions',
      'openDrawerOnEnter',
      'drawerExpandedByDefault',
      'defaultOrdering',
    ]);
    expect(all(m.container, TESTID.tweakLabel).map((l) => l.textContent?.trim())).toStrictEqual(
      TWEAK_SETTINGS.map((t) => t.label),
    );
    expect(all(m.container, TESTID.tweakDetail).map((d) => d.textContent?.trim())).toStrictEqual(
      TWEAK_SETTINGS.map((t) => t.detail),
    );

    const controls = all(m.container, TESTID.tweakControl);
    expect(controls).toHaveLength(4);
    expect(controls.map((c) => c.tagName)).toStrictEqual(
      TWEAK_SETTINGS.map((t) => (t.kind === 'boolean' ? 'INPUT' : 'SELECT')),
    );
    for (const tweak of TWEAK_SETTINGS) {
      if (tweak.kind !== 'boolean') continue;
      expect(checkbox(m, tweak.key).type).toBe('checkbox');
    }
  });

  it('the enum row offers exactly the values the setting may take, in order', () => {
    const m = onTweaks();
    send(ALL_ON);
    const el = select(m, 'defaultOrdering');
    const options = [...el.options].map((o) => o.value);
    expect(options).toStrictEqual(['live', 'recent', 'engine']);
    expect(options).toStrictEqual([
      ...(TWEAK_SETTINGS.find((t) => t.key === 'defaultOrdering')?.options ?? []),
    ]);
    expect(options.length).toBeGreaterThan(0);
  });

  it("the enum's options are exactly webview/layout.ts's DeckSortMode", () => {
    // `tweaks.ts` may not import — it is read by the host AND by this bundle,
    // and an import is how a node dependency reaches a CSP-strict browser
    // bundle — so the three values are written twice. This is the check that
    // makes the duplication safe, and it is the standing treatment here for a
    // value declared in two places.
    //
    // The right-hand side is not a literal list. `store.ts:DECK_SORTS` is the
    // keys of a `Record<DeckSortMode, true>`, which `tsc` checks for
    // exhaustiveness — a member added to the union is a compile error there
    // and a member removed is an excess property — so it cannot lag the type,
    // and it is the list the PRODUCT validates against (`isDeckSort`). This
    // test is therefore comparing the panel's options to the same enumeration
    // the store refuses on, not to a third copy written for the test.
    const sorts = [...DECK_SORTS];
    const options = [...(TWEAK_SETTINGS.find((t) => t.key === 'defaultOrdering')?.options ?? [])];
    expect(options).toStrictEqual(sorts);
    // Order is asserted above; this says the SETS agree even if someone
    // re-orders one of them, so the failure names the real disagreement.
    expect([...options].sort()).toStrictEqual([...sorts].sort());
    expect(sorts).toHaveLength(3);
  });

  it('no control carries a configuration key as its text, and each has a label that names it', () => {
    const m = onTweaks();
    send(ALL_ON);
    for (const tweak of TWEAK_SETTINGS) {
      const el = control(m, tweak.key);
      const label = el.closest('label');
      expect(label, `no label for ${tweak.key}`).not.toBeNull();
      expect(label?.textContent).toContain(tweak.label);
      expect(el.textContent ?? '').not.toContain('agentDeck.');
      expect(el.textContent ?? '').not.toContain(tweak.key);
    }
  });
});

describe('before the first settings message, a row states that it has no value', () => {
  it('every row is unknown: indeterminate, unselected, disabled, and saying so', () => {
    const m = onTweaks();
    const list = rows(m);
    expect(list).toHaveLength(4);
    expect(list.map((r) => r.dataset['known'])).toStrictEqual(['false', 'false', 'false', 'false']);
    expect(list.map((r) => r.dataset['value'])).toStrictEqual(['', '', '', '']);
    expect(all(m.container, TESTID.tweakUnknown)).toHaveLength(4);

    for (const tweak of TWEAK_SETTINGS) {
      if (tweak.kind === 'boolean') {
        const el = checkbox(m, tweak.key);
        expect(el.indeterminate).toBe(true);
        expect(el.checked).toBe(false);
        expect(el.disabled).toBe(true);
      } else {
        const el = select(m, tweak.key);
        // No option is chosen. A guessed default drawn here would be a
        // position `settings.json` never stated.
        expect(el.selectedIndex).toBe(-1);
        expect(el.disabled).toBe(true);
      }
    }
    expect(m.sent).toStrictEqual([]);
  });

  it('an unknown control writes nothing even when it is operated', () => {
    const m = onTweaks();
    const el = checkbox(m, 'followNewSessions');
    act(() => {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(m.sent).toStrictEqual([]);
    expect(el.checked).toBe(false);

    const ordering = select(m, 'defaultOrdering');
    act(() => {
      ordering.value = 'engine';
      ordering.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(m.sent).toStrictEqual([]);
  });
});

describe('a settings message positions every control', () => {
  it('both arms of every boolean, and every value of the enum', () => {
    const m = onTweaks();

    send(ALL_ON);
    expect(rows(m).map((r) => r.dataset['known'])).toStrictEqual(['true', 'true', 'true', 'true']);
    expect(all(m.container, TESTID.tweakUnknown)).toHaveLength(0);
    expect(checkbox(m, 'followNewSessions').checked).toBe(true);
    expect(checkbox(m, 'openDrawerOnEnter').checked).toBe(true);
    expect(checkbox(m, 'drawerExpandedByDefault').checked).toBe(true);
    expect(checkbox(m, 'followNewSessions').indeterminate).toBe(false);
    expect(checkbox(m, 'followNewSessions').disabled).toBe(false);
    expect(select(m, 'defaultOrdering').value).toBe('recent');
    expect(select(m, 'defaultOrdering').disabled).toBe(false);

    send(ALL_OFF);
    expect(checkbox(m, 'followNewSessions').checked).toBe(false);
    expect(checkbox(m, 'openDrawerOnEnter').checked).toBe(false);
    expect(checkbox(m, 'drawerExpandedByDefault').checked).toBe(false);
    expect(select(m, 'defaultOrdering').value).toBe('live');
    // Still positioned: `false` is a value, not an absence.
    expect(rows(m).map((r) => r.dataset['known'])).toStrictEqual(['true', 'true', 'true', 'true']);

    for (const ordering of ['live', 'recent', 'engine']) {
      send({ ...ALL_OFF, defaultOrdering: ordering });
      expect(select(m, 'defaultOrdering').value).toBe(ordering);
    }
  });

  it('a key the message omits stays unknown while its neighbours are positioned', () => {
    const m = onTweaks();
    const missingOne: Record<string, boolean | string> = { ...ALL_ON };
    delete missingOne['openDrawerOnEnter'];
    send(missingOne);
    const list = rows(m);
    expect(list.map((r) => r.dataset['key'])).toStrictEqual(TWEAK_SETTINGS.map((t) => t.key));
    expect(list.map((r) => r.dataset['known'])).toStrictEqual(['true', 'false', 'true', 'true']);
    expect(all(m.container, TESTID.tweakUnknown)).toHaveLength(1);
    expect(checkbox(m, 'openDrawerOnEnter').disabled).toBe(true);
    expect(checkbox(m, 'followNewSessions').disabled).toBe(false);
  });

  it('a value the key cannot hold is unknown, not drawn as though it were true', () => {
    const m = onTweaks();
    // A string on a boolean key, and an enum value outside the list. Both are
    // shapes `isTweakValue` refuses at the host boundary; the panel refuses to
    // draw them for the same reason.
    send({ ...ALL_ON, followNewSessions: 'yes', defaultOrdering: 'alphabetical' });
    const list = rows(m);
    expect(list.map((r) => r.dataset['known'])).toStrictEqual(['false', 'true', 'true', 'false']);
    expect(checkbox(m, 'followNewSessions').checked).toBe(false);
    expect(checkbox(m, 'followNewSessions').indeterminate).toBe(true);
    expect(select(m, 'defaultOrdering').selectedIndex).toBe(-1);
  });

  it('a settings message with NO record at all leaves every row unknown, and does not throw', () => {
    // G3 on this surface. `isHostMessage` checks the `type` field and nothing
    // else, so the renderer has to survive a `settings` message without its
    // record — the contract says the field is required; the message port is
    // not the contract.
    const m = onTweaks();
    send(ALL_ON);
    expect(rows(m).map((r) => r.dataset['known'])).toStrictEqual(['true', 'true', 'true', 'true']);
    act(() => {
      globalThis.dispatchEvent(
        new MessageEvent('message', { data: { type: 'settings', canvasAutoFit: true } }),
      );
    });
    expect(rows(m)).toHaveLength(4);
    expect(rows(m).map((r) => r.dataset['known'])).toStrictEqual([
      'false',
      'false',
      'false',
      'false',
    ]);
  });

  it('a key that is not a tweak renders no row', () => {
    const m = onTweaks();
    send({ ...ALL_ON, somethingElse: true, 'agentDeck.followNewSessions': false });
    expect(rows(m)).toHaveLength(4);
    expect(rows(m).map((r) => r.dataset['key'])).toStrictEqual(TWEAK_SETTINGS.map((t) => t.key));
  });
});

describe('the panel is a renderer: a click writes through the host, never into the panel', () => {
  it('a checkbox posts the negation and DOES NOT MOVE; the next settings message moves it', () => {
    // THE TEST THAT MATTERS. A panel that flipped itself on click would show a
    // position `settings.json` disagreed with the moment anything else wrote
    // the key — and "anything else" includes the Settings UI that this
    // sidebar's own `Settings` entry opens.
    const m = onTweaks();
    send(ALL_OFF);
    const el = checkbox(m, 'followNewSessions');
    expect(el.checked).toBe(false);

    act(() => el.click());
    expect(m.sent).toStrictEqual([
      { type: 'updateTweak', key: 'followNewSessions', value: true },
    ]);
    // Unmoved: the browser's own toggle was undone.
    expect(el.checked).toBe(false);
    expect(rows(m)[0]?.dataset['value']).toBe('false');

    // A second click, before any answer, posts the same thing again — it is
    // still the negation of the value the HOST last stated.
    m.sent.length = 0;
    act(() => el.click());
    expect(m.sent).toStrictEqual([
      { type: 'updateTweak', key: 'followNewSessions', value: true },
    ]);
    expect(el.checked).toBe(false);

    // The host wrote it. NOW the control moves.
    send({ ...ALL_OFF, followNewSessions: true });
    expect(checkbox(m, 'followNewSessions').checked).toBe(true);
    expect(rows(m)[0]?.dataset['value']).toBe('true');
  });

  it('the same, the other way: a checked box posts false and stays checked', () => {
    const m = onTweaks();
    send(ALL_ON);
    const el = checkbox(m, 'drawerExpandedByDefault');
    expect(el.checked).toBe(true);
    act(() => el.click());
    expect(m.sent).toStrictEqual([
      { type: 'updateTweak', key: 'drawerExpandedByDefault', value: false },
    ]);
    expect(checkbox(m, 'drawerExpandedByDefault').checked).toBe(true);
  });

  it('the enum posts the chosen value and snaps back until the host answers', () => {
    const m = onTweaks();
    send(ALL_OFF);
    const el = select(m, 'defaultOrdering');
    expect(el.value).toBe('live');

    act(() => {
      el.value = 'engine';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(m.sent).toStrictEqual([
      { type: 'updateTweak', key: 'defaultOrdering', value: 'engine' },
    ]);
    expect(select(m, 'defaultOrdering').value).toBe('live');

    send({ ...ALL_OFF, defaultOrdering: 'engine' });
    expect(select(m, 'defaultOrdering').value).toBe('engine');
  });

  it('every row can be written, and each writes its own key and nothing else', () => {
    const m = onTweaks();
    send(ALL_OFF);
    for (const tweak of TWEAK_SETTINGS) {
      m.sent.length = 0;
      if (tweak.kind === 'boolean') {
        act(() => checkbox(m, tweak.key).click());
        expect(m.sent).toStrictEqual([{ type: 'updateTweak', key: tweak.key, value: true }]);
      } else {
        const el = select(m, tweak.key);
        act(() => {
          el.value = 'recent';
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(m.sent).toStrictEqual([{ type: 'updateTweak', key: tweak.key, value: 'recent' }]);
      }
    }
  });
});

describe('the panel holds no state of its own', () => {
  it('a tab switch away and back leaves every control where the settings put it', () => {
    const m = onTweaks();
    send({ ...ALL_OFF, followNewSessions: true, defaultOrdering: 'engine' });
    const before = rows(m).map((r) => `${r.dataset['key'] ?? ''}=${r.dataset['value'] ?? ''}`);

    showTab(m, 'menu');
    showTab(m, 'tweaks');
    expect(rows(m).map((r) => `${r.dataset['key'] ?? ''}=${r.dataset['value'] ?? ''}`)).toStrictEqual(
      before,
    );
    expect(before).toStrictEqual([
      'followNewSessions=true',
      'openDrawerOnEnter=false',
      'drawerExpandedByDefault=false',
      'defaultOrdering=engine',
    ]);
  });

  it('a click survives nothing: switching tabs after one shows the HOST\'s value', () => {
    const m = onTweaks();
    send(ALL_OFF);
    act(() => checkbox(m, 'followNewSessions').click());
    showTab(m, 'menu');
    showTab(m, 'tweaks');
    // The click was a request, not a value. Nothing anywhere in the panel
    // remembers it.
    expect(checkbox(m, 'followNewSessions').checked).toBe(false);
    expect(rows(m)[0]?.dataset['known']).toBe('true');
  });

  it('RELOAD: a fresh mount knows nothing until the host says, then equals what it said', () => {
    // G7 in the form DoD 7.6 asks for. The first sidebar is positioned and
    // then disposed, exactly as a window reload disposes it; the second one
    // starts with no values at all — nothing was stored anywhere — and the
    // host's message is what fills it.
    const first = onTweaks();
    send(ALL_ON);
    expect(rows(first).map((r) => r.dataset['value'])).toStrictEqual([
      'true',
      'true',
      'true',
      'recent',
    ]);
    first.dispose();
    mounted.splice(mounted.indexOf(first), 1);

    const second = onTweaks();
    expect(rows(second).map((r) => r.dataset['known'])).toStrictEqual([
      'false',
      'false',
      'false',
      'false',
    ]);

    // The host re-sends on create. The values are the settings', exactly.
    const settings = { ...ALL_OFF, defaultOrdering: 'engine' };
    send(settings);
    expect(
      Object.fromEntries(
        rows(second).map((r) => [r.dataset['key'] ?? '', r.dataset['value'] ?? '']),
      ),
    ).toStrictEqual({
      followNewSessions: 'false',
      openDrawerOnEnter: 'false',
      drawerExpandedByDefault: 'false',
      defaultOrdering: 'engine',
    });
    expect(Object.keys(settings)).toHaveLength(4);
  });
});
