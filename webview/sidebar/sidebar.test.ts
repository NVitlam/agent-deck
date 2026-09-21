// @vitest-environment jsdom
/**
 * THE SIDEBAR — v0.9.0 DoD 9.17 and 9.18, spec `Amendment 2026-09-20 —
 * Sidebar shape (supersedes the TreeView ruling)`.
 *
 * ## What this file drives
 *
 * The SHIPPED BUNDLE, through `startSidebar` — the same function `main.ts`
 * calls when VS Code loads the view — fed the same `sidebarState` message the
 * host really posts. Nothing here mounts a component by hand and nothing here
 * supplies a prop the product does not supply, which is the recorded D4 shape
 * this repository has now paid for five times.
 *
 * ## The goldens
 *
 * One per page, and one per state the amendment names: Insights installed and
 * not, Inspector visible and hidden, and every View group both collapsed and
 * expanded. They are the DOM as a text outline, so a row that gains a tick, a
 * grey value, an explanation or an indent is a diff a person can read.
 *
 * `AGENT_DECK_UPDATE_SIDEBAR_GOLDENS=1` rewrites them. It is not a mode
 * anything runs by default and the files are committed: a golden regenerated
 * in the same run that checks it would be a check of nothing, which is why
 * the update path is an explicit env var and says so in the failure message.
 *
 * ## The boundary half (DoD 9.18)
 *
 * The last block clicks EVERY control the sidebar can render and puts what it
 * posted through the REAL host-side guard. That is the defect class that made
 * About and Get Insights dead: the guard was asked about one list while the
 * surface rendered another, and the only check that can see it is one that
 * compares the two sets rather than testing a sample of either.
 *
 * The other half of that join — that the host ACTS on what gets through —
 * is `src/extension.test.ts`, which fires the same messages at the real
 * provider and watches the registered commands run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { isWebviewToHostMessage } from '../../src/bridge/messages.js';
import {
  CONTROL_COMMANDS,
  CONTROL_GROUPS,
  CONTROL_SECTIONS,
  DEFAULT_VIEW_CONTROLS,
  isCommandFrom,
} from '../../src/view/controls.js';
import type { ControlSection, ViewControls } from '../../src/view/controls.js';
import type { WebviewToHostMessage } from '../../src/model/events.js';
import type { WebviewHarness } from '../testkit.js';
import { all, loadHarness, one, press } from '../testkit.js';
import { FREE_INSIGHTS_VALUE, OPEN_INSIGHTS_ID, sidebarCommands } from './model.js';
import type { SidebarState } from './model.js';

let harness: WebviewHarness;
beforeAll(async () => {
  harness = await loadHarness();
}, 120_000);

const GOLDEN_DIR = resolve('webview/goldens/sidebar');
const UPDATING = process.env['AGENT_DECK_UPDATE_SIDEBAR_GOLDENS'] === '1';

/* ------------------------------------------------------------------------ *
 * Mounting
 * ------------------------------------------------------------------------ */

interface Mounted {
  container: HTMLElement;
  sent: WebviewToHostMessage[];
  dispose: () => void;
}

const mounted: Mounted[] = [];

/** The default state: nothing set, no provider registered, no drawer. */
function baseState(over: Partial<SidebarState> = {}): SidebarState {
  return {
    controls: DEFAULT_VIEW_CONTROLS,
    tweaks: {},
    provider: null,
    drawerOpen: false,
    ...over,
  };
}

function controls(over: Partial<ViewControls> = {}): ViewControls {
  return { ...DEFAULT_VIEW_CONTROLS, ...over };
}

function mount(state: SidebarState = baseState()): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const sent: WebviewToHostMessage[] = [];
  const started = harness.startSidebar(container, {
    postMessage: (message) => sent.push(message),
  });
  const panel: Mounted = {
    container,
    sent,
    dispose: () => {
      started.dispose();
      container.remove();
    },
  };
  mounted.push(panel);
  send(state);
  return panel;
}

/** The host stating the whole thing, exactly as `activate()` states it. */
function send(state: SidebarState): void {
  harness.flushSync(() => {
    globalThis.dispatchEvent(
      new MessageEvent('message', { data: { type: 'sidebarState', ...state } }),
    );
  });
}

/** Open a page of the strip, the way a person does. */
function openPage(panel: Mounted, section: ControlSection): void {
  const tab = all(panel.container, 'sidebar-tab').find((t) => t.dataset['tab'] === section);
  expect(tab, `no tab for ${section}`).toBeDefined();
  harness.flushSync(() => {
    press(tab as HTMLElement);
  });
}

/** A row's label text, without the tick or checkbox glyph beside it. */
function labelOf(el: Element): string {
  return (el.querySelector('.lbl')?.textContent ?? '').trim();
}

/** A row's grey value suffix, or `''`. */
function valueOf(el: Element): string {
  return (el.querySelector('[data-testid="sidebar-value"]')?.textContent ?? '').trim();
}

/** Click a row or a group head by its label. */
function click(panel: Mounted, label: string): void {
  const row = [
    ...all(panel.container, 'sidebar-row'),
    ...all(panel.container, 'sidebar-group-head'),
  ].find((el) => labelOf(el) === label);
  expect(row, `no row labelled ${label}`).toBeDefined();
  harness.flushSync(() => {
    press(row as HTMLElement);
  });
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

/* ------------------------------------------------------------------------ *
 * The golden serializer
 * ------------------------------------------------------------------------ */

/**
 * One line per element: indent, tag, testid, the data attributes that carry
 * state, and the element's own text.
 *
 * `svelte-<hash>` classes are dropped — they change whenever a stylesheet
 * does, which would churn every file here for an edit that alters no state —
 * and so is `style`, which carries only the computed indent.
 */
const KEEP_ATTRS = new Set([
  'aria-checked',
  'aria-expanded',
  'aria-selected',
  'data-active',
  'data-checked',
  'data-command',
  'data-for',
  'data-group',
  'data-kind',
  'data-open',
  'data-section',
  'data-tab',
  'data-testid',
  'data-ticked',
  'role',
]);

function ownText(el: Element): string {
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) out += node.textContent ?? '';
  }
  return out.replace(/\s+/g, ' ').trim();
}

function outline(el: Element, depth: number, lines: string[]): string[] {
  const parts = [`${'  '.repeat(depth)}${el.tagName.toLowerCase()}`];
  for (const cls of [...el.classList]) {
    if (!cls.startsWith('svelte-')) parts.push(`.${cls}`);
  }
  const attrs = [...el.attributes]
    .filter((a) => KEEP_ATTRS.has(a.name))
    .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
    .sort();
  parts.push(...attrs);
  const text = ownText(el);
  if (text !== '') parts.push(JSON.stringify(text));
  lines.push(parts.join(' '));
  for (const child of el.children) outline(child, depth + 1, lines);
  return lines;
}

function domText(panel: Mounted): string {
  return `${outline(one(panel.container, 'sidebar'), 0, []).join('\n')}\n`;
}

/**
 * Compare to the committed golden, or write it.
 *
 * The failure message names the env var, because a stale golden and a real
 * regression look identical in a diff and the reader needs to know which
 * action is available.
 */
function golden(name: string, actual: string): void {
  const file = resolve(GOLDEN_DIR, `${name}.dom.txt`);
  if (UPDATING) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, actual, 'utf8');
    return;
  }
  expect(existsSync(file), `webview/goldens/sidebar/${name}.dom.txt is missing`).toBe(true);
  // Line endings are normalised on BOTH sides: this repository's sources are
  // CRLF and a fresh clone can translate, which is the recorded defect that
  // made `goldens --check` report every file as changed.
  const expected = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  expect(
    actual.replace(/\r\n/g, '\n'),
    `webview/goldens/sidebar/${name}.dom.txt is stale — re-run with ` +
      'AGENT_DECK_UPDATE_SIDEBAR_GOLDENS=1 if the change is intended',
  ).toBe(expected);
}

/* ------------------------------------------------------------------------ *
 * The strip
 * ------------------------------------------------------------------------ */

describe('the strip', () => {
  it('is the amendment’s three, with Menu open and ONE page showing', () => {
    // Menu | View | Tweaks since v0.9.0 DoD 9.28 — the Insights tab is
    // deleted, and Insights is a surface of the panel reached from Menu.
    const panel = mount();
    expect(all(panel.container, 'sidebar-tab').map((t) => t.textContent)).toStrictEqual([
      'Menu',
      'View',
      'Tweaks',
    ]);
    // ONE page at a time is the whole reason the strip exists: the native
    // tree that shipped in the morning showed all four at once and was
    // rejected for being too long.
    expect(all(panel.container, 'sidebar-page')).toHaveLength(1);
    expect(one(panel.container, 'sidebar-page').dataset['section']).toBe('menu');
    expect(
      all(panel.container, 'sidebar-tab').filter((t) => t.dataset['active'] === 'true'),
    ).toHaveLength(1);
  });

  it('switches the page, and the page really changes', () => {
    const panel = mount();
    for (const section of CONTROL_SECTIONS) {
      openPage(panel, section.id);
      expect(one(panel.container, 'sidebar-page').dataset['section']).toBe(section.id);
      expect(all(panel.container, 'sidebar-page')).toHaveLength(1);
      // The page is not empty, or every golden below would be a comparison
      // of nothing.
      expect(all(panel.container, 'sidebar-row').length, section.id).toBeGreaterThan(0);
    }
  });

  it('switching a page posts NOTHING: it is view state, and it dies with the view', () => {
    const panel = mount();
    for (const section of CONTROL_SECTIONS) openPage(panel, section.id);
    expect(panel.sent).toStrictEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * Collapsing
 * ------------------------------------------------------------------------ */

describe('the View groups', () => {
  it('are collapsed by default, each showing its current value', () => {
    const panel = mount(baseState({ controls: controls({ deckSort: 'recent' }) }));
    openPage(panel, 'view');
    const groups = all(panel.container, 'sidebar-group');
    expect(groups.map((g) => g.dataset['group'])).toStrictEqual([
      'renderer',
      'sessions',
      'engines',
      'layout',
      'sort',
    ]);
    for (const group of groups) expect(group.dataset['open'], group.dataset['group']).toBe('false');
    const sort = groups.find((g) => g.dataset['group'] === 'sort');
    expect(sort?.querySelector('[data-testid="sidebar-value"]')?.textContent).toBe('Recent');
  });

  it('expand on a click, and the choices carry the tick the HOST holds', () => {
    const panel = mount(baseState({ controls: controls({ deckSort: 'engine' }) }));
    openPage(panel, 'view');
    click(panel, 'Sort');
    const rows = all(panel.container, 'sidebar-row').filter(
      (r) => r.dataset['command']?.startsWith('agentDeck.sort.') === true,
    );
    expect(rows.map((r) => `${labelOf(r)}=${r.dataset['ticked'] ?? ''}`)).toStrictEqual([
      'Live first=false',
      'Recent=false',
      'Engine=true',
    ]);
  });

  it('THE TICK IS A FACT, not a memory of what was pressed', () => {
    /*
     * The host is the only owner. A row is ticked because the state says so,
     * so a state that arrives from somewhere else entirely — a keybinding, a
     * submenu, the palette, another window's command — moves the tick with
     * no click here at all.
     */
    const panel = mount();
    openPage(panel, 'view');
    click(panel, 'Layout');
    const ticked = (): string[] =>
      all(panel.container, 'sidebar-row')
        .filter((r) => r.dataset['ticked'] === 'true')
        .map(labelOf);
    expect(ticked()).toStrictEqual(['Grid']);
    send(baseState({ controls: controls({ deckLayout: 'lanes' }) }));
    expect(ticked()).toStrictEqual(['Lanes']);
  });

  it('COLLAPSE BACK AFTER A CHOICE, and the group shows what was chosen', () => {
    /*
     * The mock's own behaviour, and it is what keeps the page short: without
     * it the sidebar grows every time it is used and the strip's whole
     * reason is lost by the third click.
     */
    const panel = mount();
    openPage(panel, 'view');
    click(panel, 'Sort');
    const group = (): HTMLElement =>
      all(panel.container, 'sidebar-group').find((g) => g.dataset['group'] === 'sort') as HTMLElement;
    expect(group().dataset['open']).toBe('true');

    click(panel, 'Recent');
    expect(group().dataset['open']).toBe('false');
    // The command went out; the value comes BACK from the host, so the grey
    // suffix still reads the old one until it does. That is the contract,
    // not a lag to paper over: one owner, one direction.
    expect(panel.sent).toStrictEqual([{ type: 'runCommand', command: 'agentDeck.sort.recent' }]);
    expect(group().querySelector('[data-testid="sidebar-value"]')?.textContent).toBe('Live first');
    send(baseState({ controls: controls({ deckSort: 'recent' }) }));
    expect(group().querySelector('[data-testid="sidebar-value"]')?.textContent).toBe('Recent');
  });

  it('a row that is NOT in a group collapses nothing', () => {
    // Reset view sits directly on the page, so there is nothing to shut.
    const panel = mount();
    openPage(panel, 'view');
    click(panel, 'Renderer');
    const renderer = (): HTMLElement =>
      all(panel.container, 'sidebar-group').find(
        (g) => g.dataset['group'] === 'renderer',
      ) as HTMLElement;
    expect(renderer().dataset['open']).toBe('true');
    click(panel, 'Reset view');
    expect(renderer().dataset['open']).toBe('true');
    expect(panel.sent).toStrictEqual([{ type: 'runCommand', command: 'agentDeck.resetView' }]);
  });
});

/* ------------------------------------------------------------------------ *
 * The Inspector, which is conditional
 * ------------------------------------------------------------------------ */

describe('View ▸ Inspector', () => {
  it('is ABSENT while no drawer is open', () => {
    const panel = mount(baseState({ drawerOpen: false }));
    openPage(panel, 'view');
    expect(
      all(panel.container, 'sidebar-group').map((g) => g.dataset['group']),
    ).not.toContain('inspector');
    // ...and so is every command under it, which is the half that matters:
    // a heading that is hidden while its rows are not is the shape of a
    // control the user can reach and cannot see.
    const commands = all(panel.container, 'sidebar-row').map((r) => r.dataset['command']);
    for (const entry of CONTROL_COMMANDS) {
      if (entry.when !== 'drawerOpen') continue;
      expect(commands, entry.command).not.toContain(entry.command);
    }
  });

  it('APPEARS while one is, nested, with Status and Order under it', () => {
    const panel = mount(baseState({ drawerOpen: true }));
    openPage(panel, 'view');
    const inspector = all(panel.container, 'sidebar-group').find(
      (g) => g.dataset['group'] === 'inspector',
    );
    expect(inspector).toBeDefined();
    // The suffix is the two CHOICES, not the tool row's value.
    expect(inspector?.querySelector('[data-testid="sidebar-value"]')?.textContent).toBe(
      'All · Oldest first',
    );
    click(panel, 'Inspector');
    const nested = all(panel.container, 'sidebar-group')
      .filter((g) => g.dataset['group'] !== 'inspector' && inspector?.contains(g) === true)
      .map((g) => g.dataset['group']);
    expect(nested).toStrictEqual(['inspectorStatus', 'inspectorOrder']);
    // ...and the Tool row, which is a quick pick rather than a list.
    const tool = all(panel.container, 'sidebar-row').find(
      (r) => r.dataset['command'] === 'agentDeck.inspector.tool',
    );
    expect(tool === undefined ? '' : `${labelOf(tool)}=${valueOf(tool)}`).toBe('Tool=All tools');
  });

  it('the tool row shows the engine’s own name when one is chosen', () => {
    const panel = mount(
      baseState({ drawerOpen: true, controls: controls({ inspectorTool: 'Bash' }) }),
    );
    openPage(panel, 'view');
    click(panel, 'Inspector');
    const tool = all(panel.container, 'sidebar-row').find(
      (r) => r.dataset['command'] === 'agentDeck.inspector.tool',
    );
    expect(tool === undefined ? '' : `${labelOf(tool)}=${valueOf(tool)}`).toBe('Tool=Bash');
  });

  it('appearing and disappearing is driven by the HOST, not by a click here', () => {
    const panel = mount(baseState({ drawerOpen: false }));
    openPage(panel, 'view');
    const hasInspector = (): boolean =>
      all(panel.container, 'sidebar-group').some((g) => g.dataset['group'] === 'inspector');
    expect(hasInspector()).toBe(false);
    send(baseState({ drawerOpen: true }));
    expect(hasInspector()).toBe(true);
    send(baseState({ drawerOpen: false }));
    expect(hasInspector()).toBe(false);
    expect(panel.sent).toStrictEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * Tweaks
 * ------------------------------------------------------------------------ */

describe('the Tweaks page', () => {
  it('is three rows, each with its one-line explanation, and no Deck ordering', () => {
    const panel = mount();
    openPage(panel, 'tweaks');
    const rows = all(panel.container, 'sidebar-row');
    expect(rows.map((r) => r.dataset['command'])).toStrictEqual([
      'agentDeck.tweak.followNewSessions',
      'agentDeck.tweak.openDrawerOnEnter',
      'agentDeck.tweak.drawerExpandedByDefault',
    ]);
    // ONE explanation PER ROW, addressed to the row it explains — the half
    // of the rejection that was about the tree having no room for any.
    const details = all(panel.container, 'sidebar-detail');
    expect(details.map((d) => d.dataset['for'])).toStrictEqual(
      rows.map((r) => r.dataset['command']),
    );
    for (const detail of details) {
      expect((detail.textContent ?? '').length, detail.dataset['for']).toBeGreaterThan(20);
    }
    expect(all(panel.container, 'sidebar-group')).toHaveLength(0);
  });

  it('the checkbox is the SETTING’s state, and a click runs the command', () => {
    const panel = mount(baseState({ tweaks: { followNewSessions: true } }));
    openPage(panel, 'tweaks');
    const row = (command: string): HTMLElement =>
      all(panel.container, 'sidebar-row').find(
        (r) => r.dataset['command'] === command,
      ) as HTMLElement;
    expect(row('agentDeck.tweak.followNewSessions').dataset['checked']).toBe('true');
    expect(row('agentDeck.tweak.openDrawerOnEnter').dataset['checked']).toBe('false');

    click(panel, 'Follow new sessions');
    expect(panel.sent).toStrictEqual([
      { type: 'runCommand', command: 'agentDeck.tweak.followNewSessions' },
    ]);
    // The box does NOT move on the click: the setting is the source of
    // truth, so the position is whatever the last message said, and the box
    // moves when the write comes back.
    expect(row('agentDeck.tweak.followNewSessions').dataset['checked']).toBe('true');
    send(baseState({ tweaks: { followNewSessions: false } }));
    expect(row('agentDeck.tweak.followNewSessions').dataset['checked']).toBe('false');
  });

  it('a non-boolean value does NOT tick a box', () => {
    // `=== true`, never truthiness: the record is typed `boolean | string`
    // and a settings file can hold anything.
    const panel = mount(baseState({ tweaks: { followNewSessions: 'yes' } }));
    openPage(panel, 'tweaks');
    expect(all(panel.container, 'sidebar-row')[0]?.dataset['checked']).toBe('false');
  });
});

describe('the Insights state, on the Menu entry that opens it — DoD 9.28, 9.31', () => {
  /*
   * The Insights TAB is gone (spec `Amendment 2026-09-21 — One window`).
   * What the sidebar still says about Insights it says on Menu ▸ Open
   * Insights, as a grey value the way a collapsed group states its own: the
   * registered provider's name and version, or "facts only". The state comes
   * from the HOST — the next block drives that through `activate()` — so
   * here it is the renderer's half: it shows what it was told, both ways.
   */
  const insightsValueOf = (panel: Mounted): string | null | undefined =>
    row(panel, OPEN_INSIGHTS_ID).querySelector('[data-testid="sidebar-value"]')?.textContent;

  function row(panel: Mounted, command: string): HTMLElement {
    const found = all(panel.container, 'sidebar-row').find((r) => r.dataset['command'] === command);
    if (found === undefined) throw new Error(`no row for ${command}`);
    return found;
  }

  it('with NO provider registered: "facts only"', () => {
    const panel = mount(baseState({ provider: null }));
    expect(insightsValueOf(panel)).toBe(FREE_INSIGHTS_VALUE);
  });

  it('with a provider registered: its name and version', () => {
    const panel = mount(baseState({ provider: { name: 'Agent Deck Insights', version: '0.2.0' } }));
    expect(insightsValueOf(panel)).toBe('Agent Deck Insights 0.2.0');
  });

  it('a state message moves it, both ways, with no reload', () => {
    const panel = mount(baseState());
    expect(insightsValueOf(panel)).toBe(FREE_INSIGHTS_VALUE);
    send(baseState({ provider: { name: 'Agent Deck Insights', version: '0.2.0' } }));
    expect(insightsValueOf(panel)).toBe('Agent Deck Insights 0.2.0');
    send(baseState({ provider: null }));
    expect(insightsValueOf(panel)).toBe(FREE_INSIGHTS_VALUE);
  });

  it('a malformed provider reads as NONE, never as "undefined undefined"', () => {
    const panel = mount(baseState());
    send({ ...baseState(), provider: { name: 7 } } as unknown as SidebarState);
    expect(insightsValueOf(panel)).toBe(FREE_INSIGHTS_VALUE);
  });

  it('nothing on any page names installation, a licence, a count or an example', () => {
    for (const provider of [null, { name: 'Agent Deck Insights', version: '0.2.0' }]) {
      const panel = mount(baseState({ provider }));
      for (const section of CONTROL_SECTIONS) {
        openPage(panel, section.id);
        const text = (one(panel.container, 'sidebar-page').textContent ?? '').toLowerCase();
        for (const gone of ['install', 'licen', 'example', 'compaction']) {
          expect(text, `${section.id}: ${gone}`).not.toContain(gone);
        }
      }
      panel.dispose();
      mounted.pop();
    }
  });
});

/* ------------------------------------------------------------------------ *
 * The goldens (DoD 9.17)
 * ------------------------------------------------------------------------ */

describe('the DOM goldens', () => {
  it('one per page', () => {
    for (const section of ['menu', 'tweaks'] as const) {
      const panel = mount();
      openPage(panel, section);
      golden(section, domText(panel));
      panel.dispose();
      mounted.pop();
    }
  });

  it('Menu, with a provider registered — the other Insights state', () => {
    for (const [name, provider] of [
      ['menu-provider', { name: 'Agent Deck Insights', version: '0.2.0' }],
    ] as const) {
      const panel = mount(baseState({ provider }));
      openPage(panel, 'menu');
      golden(name, domText(panel));
      panel.dispose();
      mounted.pop();
    }
  });

  it('View, with the Inspector hidden and visible', () => {
    for (const [name, drawerOpen] of [
      ['view-collapsed', false],
      ['view-drawer', true],
    ] as const) {
      const panel = mount(baseState({ drawerOpen }));
      openPage(panel, 'view');
      golden(name, domText(panel));
      panel.dispose();
      mounted.pop();
    }
  });

  it('EVERY View group, expanded — all eight, derived from the table', () => {
    /*
     * DERIVED FROM `CONTROL_GROUPS`, not a list written here, and that is
     * the fix rather than a tidy-up: the hand-written list held SIX of the
     * eight, so `inspectorStatus` and `inspectorOrder` — the two nested
     * groups, the only ones this delta's nesting exists for — had no
     * expanded golden at all. A verifier round counted the table against
     * the list. A list that has to be kept in step with a table is a list
     * that falls behind it.
     *
     * A nested group needs its PARENT opened first, or its head is not in
     * the DOM to click.
     */
    expect(CONTROL_GROUPS.filter((group) => group.section === 'view')).toHaveLength(8);
    for (const group of CONTROL_GROUPS) {
      if (group.section !== 'view') continue;
      const panel = mount(baseState({ drawerOpen: true }));
      openPage(panel, 'view');
      if (group.parent !== undefined) {
        const parent = CONTROL_GROUPS.find((row) => row.id === group.parent);
        expect(parent, `${group.id} names a parent that is not a group`).toBeDefined();
        click(panel, parent?.label ?? '');
      }
      click(panel, group.label);
      golden(`view-group-${group.id}`, domText(panel));
      panel.dispose();
      mounted.pop();
    }
  });

  it('a group after a choice, collapsed again', () => {
    const panel = mount();
    openPage(panel, 'view');
    click(panel, 'Sort');
    click(panel, 'Recent');
    // The host answers, as it does in production, so the golden shows the
    // shut group carrying its NEW value rather than a half-applied state.
    send(baseState({ controls: controls({ deckSort: 'recent' }) }));
    golden('collapse-after-choice', domText(panel));
  });

  it('the goldens are not being written by this run', () => {
    // A suite that silently regenerated what it compares is a suite that can
    // never fail. The env var is off unless somebody set it on purpose.
    expect(UPDATING, 'AGENT_DECK_UPDATE_SIDEBAR_GOLDENS is set: the goldens were REWRITTEN').toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------------ *
 * The boundary (DoD 9.18)
 * ------------------------------------------------------------------------ */

describe('every control the sidebar can send passes the host’s own guard', () => {
  /**
   * Click every row on every page, in every state that reveals a row, and
   * collect what was posted.
   */
  function everyCommandPosted(): string[] {
    const posted: string[] = [];
    for (const provider of [null, { name: 'Agent Deck Insights', version: '0.2.0' }]) {
      for (const drawerOpen of [false, true]) {
        const panel = mount(baseState({ provider, drawerOpen }));
        for (const section of CONTROL_SECTIONS) {
          openPage(panel, section.id);
          /*
           * CLICK BY COMMAND, RE-READING THE DOM EVERY TIME.
           *
           * A snapshot of the rows goes stale the moment a group collapses
           * after a choice: the elements are detached, and pressing a
           * detached element posts nothing at all. The first version of this
           * walk did exactly that and silently reached 21 of the 36 commands
           * — a walk that misses two thirds of its subject and reports a
           * clean pass, which is the vacuity class this file exists to close.
           *
           * So: open every shut group, click the first row whose command has
           * not been clicked, and go round again.
           */
          const clicked = new Set<string>();
          for (let guard = 0; ; guard += 1) {
            expect(guard, `${section.id}: the walk never finished`).toBeLessThan(200);
            let opened = false;
            for (const head of all(panel.container, 'sidebar-group-head')) {
              const group = head.closest('[data-testid="sidebar-group"]') as HTMLElement | null;
              if (group?.dataset['open'] !== 'false') continue;
              harness.flushSync(() => {
                press(head);
              });
              opened = true;
              break;
            }
            if (opened) continue;
            const next = all(panel.container, 'sidebar-row').find((row) => {
              const command = row.dataset['command'];
              return command !== undefined && !clicked.has(command);
            });
            if (next === undefined) break;
            clicked.add(next.dataset['command'] as string);
            harness.flushSync(() => {
              press(next);
            });
          }
        }
        for (const message of panel.sent) {
          expect(message.type).toBe('runCommand');
          posted.push((message as { command: string }).command);
        }
        panel.dispose();
        mounted.pop();
      }
    }
    return posted;
  }

  it('clicks every row, and the set is exactly what the model says it can send', () => {
    const posted = new Set(everyCommandPosted());
    const reachable = new Set([
      ...sidebarCommands(baseState({ provider: null, drawerOpen: false })),
      ...sidebarCommands(
        baseState({ provider: { name: 'Agent Deck Insights', version: '0.2.0' }, drawerOpen: true }),
      ),
    ]);
    expect([...posted].sort()).toStrictEqual([...reachable].sort());
    /*
     * THE POPULATION, EXACTLY — every command in the table that is not the
     * panel's.
     *
     * It read `toBeGreaterThan(20)` until DoD 9.21, and **21 is precisely
     * what the broken first version of this walk reached** before it was
     * fixed to re-read the DOM. A floor that the known-bad case clears is a
     * floor that would not have reported the known-bad case.
     */
    expect(posted.size).toBe(
      CONTROL_COMMANDS.filter((entry) => isCommandFrom('sidebar', entry.command)).length,
    );
  });

  it('...and EVERY ONE of them is accepted by the real host-side guard', () => {
    /*
     * THE DEFECT, ASSERTED AT ITS OWN JOIN.
     *
     * v0.9.0 rendered `agentDeck.about` and `agentDeck.insights` on a
     * surface and validated them against a list that held neither, so both
     * were dropped HERE — at `isWebviewToHostMessage` — and the handler that
     * allowed them could not be reached. Nothing compared the two sets.
     *
     * This does, through the REAL guard imported from `src/bridge`, for
     * every command a click can actually produce.
     */
    for (const command of new Set(everyCommandPosted())) {
      expect(isWebviewToHostMessage({ type: 'runCommand', command }), command).toBe(true);
      expect(isCommandFrom('sidebar', command), command).toBe(true);
    }
  });

  it('...and every SIDEBAR command in the table is reachable from a click', () => {
    /*
     * The other direction, which is the one that catches a control that was
     * contributed and registered and shown in no page — the shape the whole
     * Insights section had when its two entries were dead.
     */
    const posted = new Set(everyCommandPosted());
    const unreachable = CONTROL_COMMANDS.filter(
      (entry) => isCommandFrom('sidebar', entry.command) && !posted.has(entry.command),
    ).map((entry) => entry.command);
    expect(unreachable).toStrictEqual([]);
  });

  it('a mutation of the allow-list is what this catches: the panel’s own are refused', () => {
    // The negative control for the assertion above. A Stats tab is a real
    // command in the same table and the sidebar renders none of them, so it
    // must be refused FROM THIS SURFACE — which is what makes the check a
    // statement about the surface rather than about the table.
    for (const entry of CONTROL_COMMANDS) {
      if (entry.section !== 'window') continue;
      expect(isWebviewToHostMessage({ type: 'runCommand', command: entry.command })).toBe(true);
      expect(isCommandFrom('sidebar', entry.command), entry.command).toBe(false);
    }
  });
});
