/**
 * `src/view/controls.ts` — v0.9.0 DoD 9.17 / 9.18.
 *
 * ## What this file is for
 *
 * The module writes out five unions the RENDERER also declares, because it
 * may not import the renderer — it is read by the CSP-strict webview bundle,
 * and `src/sidebar/tweaks.ts` already carries the rule and the reason. So the
 * duplication is CHECKED here, which is the treatment `tweaks.ts`'s `options`
 * gets and the only thing that makes a second copy safe.
 *
 * It also holds the command table's own invariants: unique ids, every `sets`
 * naming a real field and a value that field can take, every group having a
 * label, and `applyControlCommand` applying exactly one field.
 */

import { describe, expect, it } from 'vitest';

import {
  CONTROL_COMMANDS,
  CONTROL_COMMAND_IDS,
  CONTROL_GROUPS,
  CONTROL_KEYBINDINGS,
  CONTROL_SECTIONS,
  DECK_LAYOUTS,
  DECK_SORTS,
  DEFAULT_VIEW_CONTROLS,
  ENGINE_FILTERS,
  INSPECTOR_ORDERS,
  INSPECTOR_STATUSES,
  INSPECTOR_TOOL_ALL,
  LIVENESS_FILTERS,
  MENU_COMMANDS,
  RENDERERS,
  STATS_TABS,
  SURFACES,
  VIEW_MODES,
  applyControlCommand,
  asDeckSort,
  commandSurface,
  controlVisible,
  groupOf,
  isCommandFrom,
  isControlCommand,
  isPaletteVisible,
  tweakKeyOf,
  viewModeOf,
} from './controls.js';
import type { ControlFacts, Renderer, Surface, ViewControls, ViewMode } from './controls.js';
import { TWEAK_SETTINGS } from '../sidebar/tweaks.js';
import {
  ENGINE_FILTERS as RENDERER_ENGINE_FILTERS,
  LIVENESS_FILTERS as RENDERER_LIVENESS_FILTERS,
  VIEW_MODES as RENDERER_VIEW_MODES,
} from '../../webview/canvas-contract.js';
import { DEFAULT_DECK_LAYOUT, DEFAULT_DECK_SORT } from '../../webview/layout.js';
import { DECK_SORTS as RENDERER_DECK_SORTS } from '../../webview/store.js';

describe('the host writes the renderer’s own values, and they are checked', () => {
  it('the three view modes are the renderer’s three, in order', () => {
    expect(VIEW_MODES).toStrictEqual(RENDERER_VIEW_MODES);
  });

  it('the filters are the renderer’s, both axes, in order', () => {
    expect(LIVENESS_FILTERS).toStrictEqual(RENDERER_LIVENESS_FILTERS);
    expect(ENGINE_FILTERS).toStrictEqual(RENDERER_ENGINE_FILTERS);
  });

  it('the deck sorts are the renderer’s, and the layouts are its three', () => {
    expect(DECK_SORTS).toStrictEqual(RENDERER_DECK_SORTS);
    // `DeckLayoutMode` is a TYPE in `layout.ts` and types are erased, so the
    // list cannot be compared to one. What CAN be compared is the default,
    // and that every value here is accepted by the layout function's union —
    // which `tsc` does at compile time for every caller in this repository.
    expect([...DECK_LAYOUTS].sort()).toStrictEqual(['grid', 'lanes', 'list']);
  });

  it('the defaults are the renderer’s defaults, not a second opinion', () => {
    expect(DEFAULT_VIEW_CONTROLS.deckLayout).toBe(DEFAULT_DECK_LAYOUT);
    expect(DEFAULT_VIEW_CONTROLS.deckSort).toBe(DEFAULT_DECK_SORT);
    expect(DEFAULT_VIEW_CONTROLS.renderer).toBe(RENDERERS[0]);
    expect(DEFAULT_VIEW_CONTROLS.surface).toBe(SURFACES[0]);
    expect(DEFAULT_VIEW_CONTROLS.livenessFilter).toBe('all');
    expect(DEFAULT_VIEW_CONTROLS.engineFilter).toBe('all');
    expect(DEFAULT_VIEW_CONTROLS.inspectorTool).toBe(INSPECTOR_TOOL_ALL);
  });

  it('every default is a member of its own enumeration', () => {
    // Both directions of the same claim: the defaults object cannot hold a
    // value the menus never offer, and a value the menus offer is a value
    // the field's type admits.
    expect(RENDERERS).toContain(DEFAULT_VIEW_CONTROLS.renderer);
    expect(SURFACES).toContain(DEFAULT_VIEW_CONTROLS.surface);
    expect(LIVENESS_FILTERS).toContain(DEFAULT_VIEW_CONTROLS.livenessFilter);
    expect(ENGINE_FILTERS).toContain(DEFAULT_VIEW_CONTROLS.engineFilter);
    expect(DECK_LAYOUTS).toContain(DEFAULT_VIEW_CONTROLS.deckLayout);
    expect(DECK_SORTS).toContain(DEFAULT_VIEW_CONTROLS.deckSort);
    expect(STATS_TABS).toContain(DEFAULT_VIEW_CONTROLS.statsTab);
    expect(INSPECTOR_STATUSES).toContain(DEFAULT_VIEW_CONTROLS.inspectorStatus);
    expect(INSPECTOR_ORDERS).toContain(DEFAULT_VIEW_CONTROLS.inspectorOrder);
  });

  it('`defaultOrdering`’s options are exactly the deck’s sorts', () => {
    // `tweaks.ts` writes them a third time, for the same no-imports reason.
    const options = TWEAK_SETTINGS.find((t) => t.key === 'defaultOrdering')?.options ?? [];
    expect([...options]).toStrictEqual([...DECK_SORTS]);
  });

  /* ---------------------------------------------------------------------- *
   * `renderer` and `surface` — the split (DoD 9.17)
   * ---------------------------------------------------------------------- */

  it('`viewModeOf` combines the two, and `surface` wins', () => {
    expect(viewModeOf({ renderer: 'canvas', surface: 'sessions' })).toBe('canvas');
    expect(viewModeOf({ renderer: 'list', surface: 'sessions' })).toBe('list');
    // BOTH renderers under Statistics, which is the whole point: the choice
    // survives underneath so Menu -> Open Deck can come back to it. A
    // derivation that only ever saw `canvas` here would pass a one-armed
    // test and lose a List user's choice in the product.
    expect(viewModeOf({ renderer: 'canvas', surface: 'stats' })).toBe('stats');
    expect(viewModeOf({ renderer: 'list', surface: 'stats' })).toBe('stats');
  });

  it('every view mode is reachable, and the renderers are its first two', () => {
    const reachable = new Set(
      RENDERERS.flatMap((renderer) =>
        SURFACES.map((surface) => viewModeOf({ renderer, surface })),
      ),
    );
    expect([...reachable].sort()).toStrictEqual([...VIEW_MODES].sort());
    // The renderers are the modes that are not also a surface of their own.
    expect(RENDERERS).toStrictEqual(
      VIEW_MODES.filter((mode) => !(SURFACES as readonly string[]).includes(mode)),
    );
  });
});

describe('the command table', () => {
  it('has no duplicate id, and every id is namespaced', () => {
    expect(new Set(CONTROL_COMMAND_IDS).size).toBe(CONTROL_COMMAND_IDS.length);
    for (const id of CONTROL_COMMAND_IDS) expect(id.startsWith('agentDeck.'), id).toBe(true);
  });

  it('the strip is the amendment’s three, in its order', () => {
    // Four until v0.9.0 DoD 9.28 deleted the Insights tab.
    expect(CONTROL_SECTIONS.map((s) => s.label)).toStrictEqual(['Menu', 'View', 'Tweaks']);
  });

  it('every row is on one of the three pages, or is the window’s', () => {
    const pages = new Set(CONTROL_SECTIONS.map((section) => section.id));
    for (const entry of CONTROL_COMMANDS) {
      expect(pages.has(entry.section) || entry.section === 'window', entry.command).toBe(true);
    }
    /*
     * `window` IS NOT A PAGE, and the amendment's ruled exception is exactly
     * the five Statistics tabs. Pinned as a SET, so a later row that quietly
     * hid itself from the sidebar by taking this section is red here rather
     * than silently unreachable.
     */
    expect(
      CONTROL_COMMANDS.filter((entry) => entry.section === 'window').map((e) => e.command),
    ).toStrictEqual([
      'agentDeck.stats.tab.files',
      'agentDeck.stats.tab.tools',
      'agentDeck.stats.tab.loops',
      'agentDeck.stats.tab.tokens',
      'agentDeck.stats.tab.trends',
    ]);
    expect(CONTROL_SECTIONS.map((s) => s.id)).not.toContain('window');
  });

  it('every group is used, every used group is declared, and nesting is one deep', () => {
    const used = new Set(
      CONTROL_COMMANDS.map((entry) => entry.group).filter((g): g is string => g !== undefined),
    );
    const declared = new Set(CONTROL_GROUPS.map((group) => group.id));
    for (const group of used) expect(declared.has(group), `${group} is used but not declared`).toBe(true);
    // ...and the other way, so a group left behind by a removed row is red.
    // A PARENT counts as used by its children, which is what lets Inspector
    // exist while holding only other groups and one row.
    for (const group of CONTROL_GROUPS) {
      const isParent = CONTROL_GROUPS.some((child) => child.parent === group.id);
      expect(used.has(group.id) || isParent, `${group.id} is declared but unused`).toBe(true);
      expect(group.label.length, group.id).toBeGreaterThan(0);
      if (group.parent === undefined) continue;
      const parent = groupOf(group.parent);
      expect(parent, `${group.id} names a parent that is not a group`).toBeDefined();
      // ONE LEVEL. A grandparent would need a renderer that draws one, and
      // the table is not allowed to declare a shape nothing can show.
      expect(parent?.parent, `${group.id} nests two deep`).toBeUndefined();
      expect(parent?.section, group.id).toBe(group.section);
    }
  });

  it('THE STATISTICS AND DECK-ORDERING GROUPS ARE GONE', () => {
    /*
     * Both were in the table on 2026-09-20 and the sidebar amendment removes
     * them by name: the Stats tabs went back into the Statistics window, and
     * "Deck ordering" was a second way to say View -> Sort. Asserted by
     * ABSENCE because a group nothing references is invisible to every other
     * test in this file.
     */
    const ids = CONTROL_GROUPS.map((group) => group.id);
    expect(ids).not.toContain('statistics');
    expect(ids).not.toContain('ordering');
    expect(CONTROL_COMMAND_IDS.filter((id) => id.includes('defaultOrdering'))).toStrictEqual([]);
  });

  it('View’s groups are the mock’s five, then Inspector', () => {
    expect(
      CONTROL_GROUPS.filter((g) => g.section === 'view' && g.parent === undefined).map(
        (g) => g.label,
      ),
    ).toStrictEqual(['Renderer', 'Sessions', 'Engines', 'Layout', 'Sort', 'Inspector']);
    expect(
      CONTROL_GROUPS.filter((g) => g.parent === 'inspector').map((g) => g.label),
    ).toStrictEqual(['Status', 'Order']);
  });

  it('every `sets` names a real field and a value that field admits', () => {
    const admits: Readonly<Record<string, readonly string[]>> = {
      renderer: RENDERERS,
      livenessFilter: LIVENESS_FILTERS,
      engineFilter: ENGINE_FILTERS,
      deckLayout: DECK_LAYOUTS,
      deckSort: DECK_SORTS,
      statsTab: STATS_TABS,
      inspectorStatus: INSPECTOR_STATUSES,
      inspectorOrder: INSPECTOR_ORDERS,
    };
    for (const entry of CONTROL_COMMANDS) {
      if (entry.sets === undefined) continue;
      const values = admits[entry.sets.field];
      expect(values, `${entry.command} sets an unknown field`).toBeDefined();
      expect(values, entry.command).toContain(entry.sets.value);
    }
    /*
     * EVERY value of every enumeration has a command. A filter a user cannot
     * choose is a filter that does not exist.
     *
     * `surface` is NOT in the table above and that is the reason it is not:
     * all four of its values are reached from Menu — Open Deck, Open
     * Statistics, Open Insights and About (v0.9.0 DoD 9.27) — each of which
     * reveals the panel as well as moving the value, so none can be a plain
     * value-setting row (the generic registration loop would register it
     * twice). All four are asserted here, by command id, so "no row sets it"
     * cannot quietly become "nothing sets it".
     */
    for (const [field, values] of Object.entries(admits)) {
      const offered = CONTROL_COMMANDS.filter((e) => e.sets?.field === field).map(
        (e) => e.sets?.value,
      );
      expect([...offered].sort(), field).toStrictEqual([...values].sort());
    }
    expect(CONTROL_COMMANDS.filter((e) => e.sets?.field === 'surface')).toStrictEqual([]);
    expect(SURFACES).toStrictEqual(['sessions', 'stats', 'insights', 'about']);
    for (const id of ['agentDeck.open', 'agentDeck.openStats', 'agentDeck.openInsights', 'agentDeck.about']) {
      expect(CONTROL_COMMAND_IDS, id).toContain(id);
    }
  });

  it('`viewModeOf`: a session surface shows the renderer, every other surface itself', () => {
    // THE ONE PLACE `renderer` and `surface` combine (DoD 9.27): both
    // renderers under each of the four surfaces.
    const cases: [Renderer, Surface, ViewMode][] = [
      ['canvas', 'sessions', 'canvas'],
      ['list', 'sessions', 'list'],
      ['canvas', 'stats', 'stats'],
      ['list', 'stats', 'stats'],
      ['canvas', 'insights', 'insights'],
      ['list', 'insights', 'insights'],
      ['canvas', 'about', 'about'],
      ['list', 'about', 'about'],
    ];
    for (const [renderer, surface, mode] of cases) {
      expect(viewModeOf({ renderer, surface }), `${renderer}/${surface}`).toBe(mode);
    }
  });

  /* ---------------------------------------------------------------------- *
   * Visibility, surfaces and the palette
   * ---------------------------------------------------------------------- */

  it('`controlVisible` answers its one condition and defaults to shown', () => {
    const shut: ControlFacts = { drawerOpen: false };
    const open: ControlFacts = { drawerOpen: true };
    expect(controlVisible(undefined, shut)).toBe(true);
    expect(controlVisible(undefined, open)).toBe(true);
    expect(controlVisible('drawerOpen', shut)).toBe(false);
    expect(controlVisible('drawerOpen', open)).toBe(true);
  });

  it('the Inspector entries are the ONLY ones gated on a drawer', () => {
    const gated = CONTROL_COMMANDS.filter((e) => e.when === 'drawerOpen').map((e) => e.command);
    expect(gated).toStrictEqual([
      'agentDeck.inspector.status.all',
      'agentDeck.inspector.status.running',
      'agentDeck.inspector.status.done',
      'agentDeck.inspector.status.error',
      'agentDeck.inspector.order.oldest',
      'agentDeck.inspector.order.newest',
      'agentDeck.inspector.tool',
    ]);
    // ...and every group holding one is gated too, or the heading would sit
    // above nothing while a drawer is shut.
    for (const entry of CONTROL_COMMANDS) {
      if (entry.when !== 'drawerOpen' || entry.group === undefined) continue;
      expect(groupOf(entry.group)?.when, entry.command).toBe('drawerOpen');
    }
  });

  it('THE INSIGHTS TAB IS GONE, and nothing is gated on what is installed', () => {
    /*
     * v0.9.0 DoD 9.28, spec `Amendment 2026-09-21 — One window`: the strip is
     * Menu | View | Tweaks, Insights is a SURFACE reached from Menu, and
     * "Installed" is never consulted by the UI. Asserted by absence against
     * the TABLE, because a row nothing renders is invisible to every other
     * test here.
     */
    expect(CONTROL_SECTIONS.map((s) => s.label)).toStrictEqual(['Menu', 'View', 'Tweaks']);
    expect(CONTROL_COMMAND_IDS.filter((id) => id.startsWith('agentDeck.insights.'))).toStrictEqual([]);
    // `ControlFacts` has ONE member: no installed, no licence, no provider.
    const facts: ControlFacts = { drawerOpen: false };
    expect(Object.keys(facts)).toStrictEqual(['drawerOpen']);
    const serialised = JSON.stringify(CONTROL_COMMANDS);
    expect(serialised).not.toContain('licen');
    expect(serialised).not.toContain('installed');
  });

  it('the Menu is the ruled seven, in the ruled order', () => {
    expect(MENU_COMMANDS.map((e) => e.label)).toStrictEqual([
      'Open Deck',
      'Open Statistics',
      'Open Insights',
      'Show Diagnostics',
      'Settings',
      'Clear Stats History',
      'About',
    ]);
  });

  it('every Tweaks row carries its one-line explanation', () => {
    const tweaks = CONTROL_COMMANDS.filter((e) => e.section === 'tweaks');
    expect(tweaks.length).toBe(3);
    for (const entry of tweaks) {
      expect((entry.detail ?? '').length, entry.command).toBeGreaterThan(20);
    }
  });

  it('the surface split is exactly `window` -> panel, everything else sidebar', () => {
    for (const entry of CONTROL_COMMANDS) {
      const surface = commandSurface(entry);
      expect(surface, entry.command).toBe(entry.section === 'window' ? 'panel' : 'sidebar');
      // BOTH WAYS, per command: a command is accepted from its own surface
      // and refused from the other. This is the assertion the v0.9.0 dead
      // About button would have failed — its guard asked a different list
      // from the one the surface rendered.
      expect(isCommandFrom(surface, entry.command), entry.command).toBe(true);
      const other = surface === 'panel' ? 'sidebar' : 'panel';
      expect(isCommandFrom(other, entry.command), entry.command).toBe(false);
    }
    // A command outside the table is refused from both.
    for (const outside of ['workbench.action.closeWindow', 'agentDeck.nope', '']) {
      expect(isCommandFrom('sidebar', outside), outside).toBe(false);
      expect(isCommandFrom('panel', outside), outside).toBe(false);
    }
    // The panel's set, pinned: five Stats tabs and NOTHING destructive.
    const panel = CONTROL_COMMANDS.filter((e) => commandSurface(e) === 'panel').map((e) => e.command);
    expect(panel.every((id) => id.startsWith('agentDeck.stats.tab.')), panel.join(',')).toBe(true);
    expect(isCommandFrom('panel', 'agentDeck.stats.clearHistory')).toBe(false);
  });

  it('the palette shows the Menu seven and hides the rest', () => {
    expect(CONTROL_COMMANDS.filter(isPaletteVisible).map((e) => e.command)).toStrictEqual([
      'agentDeck.open',
      'agentDeck.openStats',
      'agentDeck.openInsights',
      'agentDeck.showDiagnostics',
      'agentDeck.openSettings',
      'agentDeck.stats.clearHistory',
      'agentDeck.about',
    ]);
  });

  it('MENU_COMMANDS is the Menu section, derived and not written again', () => {
    expect(MENU_COMMANDS).toStrictEqual(
      CONTROL_COMMANDS.filter((entry) => entry.section === 'menu'),
    );
  });

  it('`isControlCommand` admits every id and nothing else', () => {
    for (const id of CONTROL_COMMAND_IDS) expect(isControlCommand(id), id).toBe(true);
    for (const outside of ['workbench.action.closeWindow', 'agentDeck', '', 'agentDeck.nope']) {
      expect(isControlCommand(outside), outside).toBe(false);
    }
  });
});

describe('the tweak helpers', () => {
  it('reads the key off the command id', () => {
    expect(tweakKeyOf('agentDeck.tweak.followNewSessions')).toBe('followNewSessions');
    expect(tweakKeyOf('agentDeck.tweak.drawerExpandedByDefault')).toBe('drawerExpandedByDefault');
    /*
     * `tweakValueOf` was here until DoD 9.17. It read the VALUE off a
     * `tweak.<key>.<value>` id, which existed for one group — Deck ordering —
     * and the sidebar amendment removes that group as a second way to say
     * View -> Sort. With no `tweak.` command carrying a value, the function
     * had no caller, and an exported helper nothing reads is this
     * repository's most-recorded shape. The suffix form is still parsed here
     * so a future enum tweak gets the key and not the whole tail.
     */
    expect(tweakKeyOf('agentDeck.tweak.someEnum.value')).toBe('someEnum');
  });

  it('answers NOTHING for a command that is not a tweak', () => {
    // The caller's next act is to write into the user's settings, so a wrong
    // answer here is a wrong key in `settings.json`.
    for (const other of ['agentDeck.open', 'agentDeck.sort.live', 'workbench.x', '']) {
      expect(tweakKeyOf(other), other).toBeUndefined();
    }
  });

  it('every tweak command names a declared setting', () => {
    const keys = new Set(TWEAK_SETTINGS.map((t) => t.key));
    for (const entry of CONTROL_COMMANDS) {
      if (entry.section !== 'tweaks') continue;
      const key = tweakKeyOf(entry.command);
      expect(key, entry.command).toBeDefined();
      expect(keys.has(key as string), entry.command).toBe(true);
    }
    /*
     * ...and every BOOLEAN setting has a command, so a tweak cannot be
     * declared with no way to set it.
     *
     * The enum tweak — `defaultOrdering` — deliberately has none: the
     * sidebar amendment removes the Deck ordering group because it was a
     * second way to say View -> Sort, and the setting stays as the thing
     * that decides what the deck OPENS sorted by. It is still reachable,
     * from Menu -> Settings, which is where a setting with no menu entry
     * belongs.
     */
    for (const tweak of TWEAK_SETTINGS) {
      const commands = CONTROL_COMMANDS.filter((e) => tweakKeyOf(e.command) === tweak.key);
      if (tweak.kind === 'enum') {
        expect(commands.map((c) => c.command), tweak.key).toStrictEqual([]);
        continue;
      }
      expect(commands.length, tweak.key).toBe(1);
    }
  });
});

describe('`asDeckSort` coerces a user’s setting', () => {
  it('keeps a sort this build knows', () => {
    for (const sort of DECK_SORTS) expect(asDeckSort(sort), sort).toBe(sort);
  });

  it('answers the default for anything else, rather than throwing', () => {
    // An unknown ordering in someone's `settings.json` is not a reason for
    // the deck to refuse to open.
    for (const junk of ['sideways', '', 42, null, undefined, {}, ['live']]) {
      expect(asDeckSort(junk), JSON.stringify(junk)).toBe(DEFAULT_VIEW_CONTROLS.deckSort);
    }
  });
});

describe('`applyControlCommand`', () => {
  it('sets exactly the field the row names, and leaves the rest alone', () => {
    for (const entry of CONTROL_COMMANDS) {
      if (entry.sets === undefined) continue;
      const next = applyControlCommand(DEFAULT_VIEW_CONTROLS, entry.command);
      expect(next[entry.sets.field], entry.command).toBe(entry.sets.value);
      for (const [field, value] of Object.entries(DEFAULT_VIEW_CONTROLS)) {
        if (field === entry.sets.field) continue;
        expect(next[field as keyof ViewControls], `${entry.command} moved ${field}`).toBe(value);
      }
    }
  });

  it('returns the state unchanged for a row with no `sets`', () => {
    for (const entry of CONTROL_COMMANDS) {
      if (entry.sets !== undefined) continue;
      expect(applyControlCommand(DEFAULT_VIEW_CONTROLS, entry.command)).toStrictEqual(
        DEFAULT_VIEW_CONTROLS,
      );
    }
    expect(applyControlCommand(DEFAULT_VIEW_CONTROLS, 'agentDeck.nope')).toStrictEqual(
      DEFAULT_VIEW_CONTROLS,
    );
  });

  it('CLEARS the deep-link focus on any control command', () => {
    // A user who picks a Stats tab by hand has stopped following the link
    // that focused a session. Asserted on a state that HAS a focus, or the
    // clearing would be indistinguishable from never setting one.
    const focused: ViewControls = { ...DEFAULT_VIEW_CONTROLS, focusSessionId: 'ses-1' };
    expect(focused.focusSessionId).toBe('ses-1');
    const next = applyControlCommand(focused, 'agentDeck.stats.tab.tokens');
    expect(next.statsTab).toBe('tokens');
    expect(next.focusSessionId).toBeUndefined();
    expect('focusSessionId' in next).toBe(false);
  });

  it('does not mutate the state it was given', () => {
    const before = { ...DEFAULT_VIEW_CONTROLS };
    applyControlCommand(DEFAULT_VIEW_CONTROLS, 'agentDeck.sort.recent');
    expect(DEFAULT_VIEW_CONTROLS).toStrictEqual(before);
  });
});

describe('the keyboard shortcuts', () => {
  it('bind real commands, with no duplicate key', () => {
    const ids = new Set(CONTROL_COMMAND_IDS);
    for (const row of CONTROL_KEYBINDINGS) expect(ids.has(row.command), row.command).toBe(true);
    const keys = CONTROL_KEYBINDINGS.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('are the TEN the deck had — the set is pinned', () => {
    expect(CONTROL_KEYBINDINGS.map((row) => `${row.key}=${row.command.split('.').pop() ?? ''}`))
      .toStrictEqual([
        'a=all',
        'c=cc',
        'o=oc',
        'x=cx',
        '1=list',
        '2=grid',
        '3=lanes',
        'l=live',
        'r=recent',
        'e=engine',
      ]);
  });
});
