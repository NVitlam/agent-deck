/**
 * `src/view/controls.ts` — v0.9.0 DoD 9.14.
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
  STATS_TABS,
  VIEW_MODES,
  applyControlCommand,
  asDeckSort,
  isControlCommand,
  tweakKeyOf,
  tweakValueOf,
} from './controls.js';
import type { ViewControls } from './controls.js';
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
    expect(DEFAULT_VIEW_CONTROLS.viewMode).toBe(VIEW_MODES[0]);
    expect(DEFAULT_VIEW_CONTROLS.livenessFilter).toBe('all');
    expect(DEFAULT_VIEW_CONTROLS.engineFilter).toBe('all');
    expect(DEFAULT_VIEW_CONTROLS.inspectorTool).toBe(INSPECTOR_TOOL_ALL);
  });

  it('every default is a member of its own enumeration', () => {
    // Both directions of the same claim: the defaults object cannot hold a
    // value the menus never offer, and a value the menus offer is a value
    // the field's type admits.
    expect(VIEW_MODES).toContain(DEFAULT_VIEW_CONTROLS.viewMode);
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
});

describe('the command table', () => {
  it('has no duplicate id, and every id is namespaced', () => {
    expect(new Set(CONTROL_COMMAND_IDS).size).toBe(CONTROL_COMMAND_IDS.length);
    for (const id of CONTROL_COMMAND_IDS) expect(id.startsWith('agentDeck.'), id).toBe(true);
  });

  it('every row names one of the four sections', () => {
    const sections = new Set(CONTROL_SECTIONS.map((section) => section.id));
    for (const entry of CONTROL_COMMANDS) {
      expect(sections.has(entry.section), entry.command).toBe(true);
    }
    expect(CONTROL_SECTIONS.map((s) => s.label)).toStrictEqual([
      'Menu',
      'View',
      'Tweaks',
      'Insights',
    ]);
  });

  it('every group has a label, and every label belongs to a group in use', () => {
    const used = new Set(
      CONTROL_COMMANDS.map((entry) => entry.group).filter((g): g is string => g !== undefined),
    );
    for (const group of used) expect(CONTROL_GROUPS[group], group).toBeDefined();
    // ...and the other way, so a label left behind by a removed group is red.
    for (const group of Object.keys(CONTROL_GROUPS)) {
      expect(used.has(group), `${group} is labelled but unused`).toBe(true);
    }
  });

  it('every `sets` names a real field and a value that field admits', () => {
    const admits: Readonly<Record<string, readonly string[]>> = {
      viewMode: VIEW_MODES,
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
     * ONE EXEMPTION, enumerated rather than granted by loosening the
     * equality: `viewMode: 'stats'` is reached from Menu -> Open Statistics,
     * which OPENS the panel as well as setting the mode and so cannot be a
     * plain value-setting row — the generic registration loop would register
     * it twice. View -> Canvas | List is the pair the amendment names.
     */
    const EXEMPT: readonly { field: string; value: string; why: string }[] = [
      {
        field: 'viewMode',
        value: 'stats',
        why: 'Menu -> Open Statistics (agentDeck.openStats) sets it and opens the '
          + 'panel; the amendment names Canvas | List as the View pair.',
      },
    ];
    for (const entry of EXEMPT) expect(entry.why.length, entry.value).toBeGreaterThan(20);
    for (const [field, values] of Object.entries(admits)) {
      const offered = CONTROL_COMMANDS.filter((e) => e.sets?.field === field).map(
        (e) => e.sets?.value,
      );
      const exempt = EXEMPT.filter((e) => e.field === field).map((e) => e.value);
      expect([...offered, ...exempt].sort(), field).toStrictEqual([...values].sort());
    }
    // The exemption is not a hole: the command it names is contributed, and
    // a test in `extension.test.ts` drives it into the mode.
    for (const entry of EXEMPT) {
      expect(CONTROL_COMMAND_IDS).toContain('agentDeck.openStats');
      expect(entry.field).toBe('viewMode');
    }
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
  it('reads the key, and the value when the id names one', () => {
    expect(tweakKeyOf('agentDeck.tweak.followNewSessions')).toBe('followNewSessions');
    expect(tweakValueOf('agentDeck.tweak.followNewSessions')).toBeUndefined();
    expect(tweakKeyOf('agentDeck.tweak.defaultOrdering.engine')).toBe('defaultOrdering');
    expect(tweakValueOf('agentDeck.tweak.defaultOrdering.engine')).toBe('engine');
  });

  it('answers NOTHING for a command that is not a tweak', () => {
    // The caller's next act is to write into the user's settings, so a wrong
    // answer here is a wrong key in `settings.json`.
    for (const other of ['agentDeck.open', 'agentDeck.sort.live', 'workbench.x', '']) {
      expect(tweakKeyOf(other), other).toBeUndefined();
      expect(tweakValueOf(other), other).toBeUndefined();
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
    // ...and every declared setting has a command, so a tweak cannot be
    // declared with no way to set it.
    for (const tweak of TWEAK_SETTINGS) {
      const commands = CONTROL_COMMANDS.filter((e) => tweakKeyOf(e.command) === tweak.key);
      expect(commands.length, tweak.key).toBeGreaterThan(0);
      if (tweak.kind === 'enum') {
        expect(commands.map((c) => tweakValueOf(c.command)), tweak.key).toStrictEqual([
          ...(tweak.options ?? []),
        ]);
      }
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

  it('are the nine the deck had, plus All — the set is pinned', () => {
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
