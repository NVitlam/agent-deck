/**
 * The view controls — v0.9.0 DoD 9.17 (spec `Amendment 2026-09-20 — Sidebar
 * shape`, which supersedes the TreeView ruling of the same day).
 *
 * THE HOST OWNS EVERY CONTROL VALUE AND A RENDERER RENDERS IT. That is the
 * whole of this module's reason to exist, and it is the same arrangement
 * `src/sidebar/tweaks.ts` already describes for settings: one source of
 * truth, one direction of travel. A value moves because a COMMAND ran; the
 * sidebar's job is to name the command and to show what the value is now.
 *
 * NO IMPORTS AT ALL, like `src/sidebar/tweaks.ts` and `src/bridge/contract.ts`.
 * This module is read by the HOST (to hold the state, to register the
 * commands, to validate an inbound `runCommand`) and by the CSP-strict
 * WEBVIEW bundle (to draw the sidebar and to type the message it receives),
 * and an import is how a node dependency reaches a browser bundle.
 *
 * ## The values are written here and CHECKED against the renderer
 *
 * `ViewMode`, `EngineFilter` and `LivenessFilter` also exist in
 * `webview/canvas-contract.ts`, and `DeckLayoutMode`/`DeckSortMode` in
 * `webview/layout.ts`, because those modules are the renderer's own and this
 * one may not import them. The duplication is CHECKED rather than trusted —
 * `src/view/controls.test.ts` compares every list to the renderer's.
 *
 * ## THE TABLE IS THE ALLOW-LIST (DoD 9.18)
 *
 * The sidebar is a webview again and it posts `{type:'runCommand'}`. The
 * defect that shape produced in v0.9.0 was not the message: it was that the
 * GUARD validated against one list (the sidebar's five-entry menu) while the
 * PRODUCER rendered another, so `agentDeck.about` and `agentDeck.insights`
 * were dropped at the boundary and the handler that allowed them was
 * unreachable. There is now exactly ONE list — {@link CONTROL_COMMANDS} —
 * and every party derives from it: `package.json` contributes it, the
 * sidebar renders it, `activate()` registers it, and
 * {@link isControlCommand} is what the boundary asks. `controls.test.ts` and
 * `manifest.test.ts` hold all four against each other, both ways and by
 * count, so a command can be neither unlisted-but-rendered nor
 * contributed-with-nothing-behind-it.
 *
 * ## `renderer` and `surface` are TWO facts, and they were one
 *
 * v0.9.0 carried a single `viewMode: 'canvas' | 'list' | 'stats'`, so opening
 * Statistics DESTROYED the user's renderer choice and Menu ▸ Open Deck had
 * nothing to restore it to. The sidebar mock shows Renderer carrying a value
 * at all times and has no Statistics group at all, which is only coherent if
 * the two are separate — so they are. {@link viewModeOf} is the one place
 * they are combined, and the renderer still sees the three-valued mode it has
 * always seen.
 */

/* ------------------------------------------------------------------------ *
 * The value types
 * ------------------------------------------------------------------------ */

/** Which renderer draws sessions. The View ▸ Renderer choice. */
export type Renderer = 'canvas' | 'list';

/**
 * Which surface the ONE panel is showing — v0.9.0 DoD 9.27, spec `Amendment
 * 2026-09-21 — One window, Insights provider, Menu-only entry`.
 *
 * Four, and every one is a surface of the single Agent Deck panel. Menu ▸ Open
 * Deck, Open Statistics, Open Insights and About each set this field and
 * nothing else about the surface, so the panel switches IN PLACE. The
 * separate About panel is gone; Statistics was already a surface.
 */
export type Surface = 'sessions' | 'stats' | 'insights' | 'about';

/**
 * What the RENDERER sees.
 *
 * Derived from `renderer` and `surface` by {@link viewModeOf} and never
 * stored: a second field holding it would be the second owner this split
 * exists to remove. `canvas`/`list` are the two ways of drawing sessions; the
 * other three are the other surfaces, one each.
 */
export type ViewMode = 'canvas' | 'list' | 'stats' | 'insights' | 'about';

/** Show only sessions of this liveness, or all of them. */
export type LivenessFilter = 'all' | 'live' | 'idle' | 'ended';

/** Show only sessions from this engine, or all of them. */
export type EngineFilter = 'all' | 'cc' | 'oc' | 'cx';

/** How deck cards are placed. */
export type DeckLayout = 'list' | 'grid' | 'lanes';

/** The order deck cards are placed in. */
export type DeckSort = 'live' | 'recent' | 'engine';

/** Which table the Stats view is showing. */
export type StatsTab = 'files' | 'tools' | 'loops' | 'tokens' | 'trends';

/** Which call statuses the drawer lists. */
export type InspectorStatus = 'all' | 'running' | 'done' | 'error';

/** Which end of the run the drawer's list starts at. */
export type InspectorOrder = 'oldest' | 'newest';

/**
 * Every control value, as one object.
 *
 * ONE MESSAGE CARRYING THE WHOLE STATE, never a delta: the host recomputes it
 * and sends it after every command, and the renderer assigns it. A partial
 * update would need the two sides to agree about what "unchanged" means, and
 * this repository has already paid for a value with two owners twice.
 */
export interface ViewControls {
  readonly renderer: Renderer;
  readonly surface: Surface;
  readonly livenessFilter: LivenessFilter;
  readonly engineFilter: EngineFilter;
  readonly deckLayout: DeckLayout;
  readonly deckSort: DeckSort;
  readonly statsTab: StatsTab;
  readonly inspectorStatus: InspectorStatus;
  readonly inspectorOrder: InspectorOrder;
  /** A tool name, or `all`. Free text, because tool names are the engine's. */
  readonly inspectorTool: string;
  /**
   * The session the Stats view is focused ON — v0.9.0 DoD 9.5, the Insights
   * deep link.
   *
   * Absence CLEARS the focus, which is what every caller but the deep link
   * wants: a focus belongs to the link that set it, never to the view.
   */
  readonly focusSessionId?: string;
}

/**
 * The renderer's mode, from the two facts that decide it.
 *
 * THE ONE PLACE THEY ARE COMBINED. A non-session `surface` wins, because
 * Statistics, Insights and About are different surfaces rather than other
 * ways of drawing sessions; the renderer choice survives underneath them and
 * Menu ▸ Open Deck comes back to it.
 */
export function viewModeOf(controls: Pick<ViewControls, 'renderer' | 'surface'>): ViewMode {
  return controls.surface === 'sessions' ? controls.renderer : controls.surface;
}

/* ------------------------------------------------------------------------ *
 * The enumerations, in the order the menus show them
 * ------------------------------------------------------------------------ */

export const RENDERERS: readonly Renderer[] = ['canvas', 'list'];
export const SURFACES: readonly Surface[] = ['sessions', 'stats', 'insights', 'about'];
export const VIEW_MODES: readonly ViewMode[] = ['canvas', 'list', 'stats', 'insights', 'about'];
export const LIVENESS_FILTERS: readonly LivenessFilter[] = ['all', 'live', 'idle', 'ended'];
export const ENGINE_FILTERS: readonly EngineFilter[] = ['all', 'cc', 'oc', 'cx'];
export const DECK_LAYOUTS: readonly DeckLayout[] = ['list', 'grid', 'lanes'];
export const DECK_SORTS: readonly DeckSort[] = ['live', 'recent', 'engine'];
export const STATS_TABS: readonly StatsTab[] = ['files', 'tools', 'loops', 'tokens', 'trends'];
export const INSPECTOR_STATUSES: readonly InspectorStatus[] = ['all', 'running', 'done', 'error'];
export const INSPECTOR_ORDERS: readonly InspectorOrder[] = ['oldest', 'newest'];

/** The value `inspectorTool` takes when no tool is selected. */
export const INSPECTOR_TOOL_ALL = 'all';

/**
 * What every control holds before anything has run.
 *
 * `deckLayout: 'grid'` and `deckSort: 'live'` are the renderer's own
 * `DEFAULT_DECK_LAYOUT`/`DEFAULT_DECK_SORT`, checked against them by the test.
 * `deckSort` is then overwritten at activation by `agentDeck.defaultOrdering`
 * when the user has set one — a SETTING, so the settings are still the source
 * of truth for the value they name.
 */
export const DEFAULT_VIEW_CONTROLS: ViewControls = Object.freeze({
  renderer: 'canvas',
  surface: 'sessions',
  livenessFilter: 'all',
  engineFilter: 'all',
  deckLayout: 'grid',
  deckSort: 'live',
  statsTab: 'files',
  inspectorStatus: 'all',
  inspectorOrder: 'oldest',
  inspectorTool: INSPECTOR_TOOL_ALL,
});

/** The `views` entry the activity-bar container holds. */
export const SIDEBAR_VIEW_ID = 'agentDeck.sidebar';

/** The `viewsContainers.activitybar` id in `package.json`. */
export const SIDEBAR_CONTAINER_ID = 'agentDeck';

/**
 * The panel's `createWebviewPanel` view type, for the keybinding `when`.
 *
 * Written here as well as in `extension.ts` because this module may not
 * import that one; `manifest.test.ts` holds the two literals against each
 * other, which is the treatment every duplicated literal in this repository
 * gets.
 */
export const PANEL_VIEW_TYPE = 'agentDeck.panel';

/* ------------------------------------------------------------------------ *
 * The command table
 * ------------------------------------------------------------------------ */

/**
 * Which page of the sidebar an entry belongs to.
 *
 * Three pages — Menu | View | Tweaks — since spec `Amendment 2026-09-21 — One
 * window` deleted the Insights tab: Insights is a SURFACE of the panel now,
 * reached from Menu ▸ Open Insights. `window` is the fourth member and is NOT
 * a page: it marks a command that is contributed and registered and reachable
 * from the Statistics surface's own tab strip, and that appears in no sidebar
 * page at all. The Stats tabs are the only members, by the ruled exception.
 */
export type ControlSection = 'menu' | 'view' | 'tweaks' | 'window';

/**
 * Which webview may post a given command (DoD 9.18).
 *
 * Derived from `section` rather than written a second time — see
 * {@link commandSurface}. The point of stating it at all is that the panel
 * and the sidebar are different surfaces with different contents, and the
 * defect this release exists to correct was a guard that confused them.
 */
export type ControlSurface = 'sidebar' | 'panel';

/**
 * A condition an entry is shown under, or `undefined` for always.
 *
 * ONE, and the union is closed. It is DATA rather than a branch in a
 * component, so a test can assert "Inspector is absent with no drawer open"
 * against the table instead of against a rendering of it.
 *
 * `insightsInstalled` and `insightsMissing` were members until v0.9.0 DoD
 * 9.28. Spec `Amendment 2026-09-21 — One window`: **"Installed" is never
 * consulted by the UI**; the only Insights state is whether a provider is
 * REGISTERED.
 *
 * The three `insights*` members joined in v0.9.0 DoD 9.45 (spec `Amendment
 * 2026-09-23 — Paid Insights surface`): Pick Agent, Show Payload and Clear
 * History sit under Open Insights only while the registered provider has
 * that action. Each names ONE action, so a provider with two of the three
 * shows two rows — never a row that answers "not offered".
 */
export type ControlWhen =
  | 'drawerOpen'
  | 'insightsPickAgent'
  | 'insightsShowPayload'
  | 'insightsClearHistory';

/**
 * A provider's optional action, as {@link ControlFacts} carries it. The same
 * three names as `InsightsProviderAction` in `src/model/events.ts`, written
 * here because this module imports nothing; `controls.test.ts` holds the two
 * lists equal.
 */
export type ControlInsightsAction = 'pickAgent' | 'showPayload' | 'clearHistory';

/** The facts {@link controlVisible} decides against. */
export interface ControlFacts {
  /** True while the panel is showing a drawer. Reported by the panel. */
  readonly drawerOpen: boolean;
  /**
   * The registered Insights provider's optional actions — empty when none is
   * registered. The HOST's fact, read from its registry (DoD 9.45).
   */
  readonly insightsActions: readonly ControlInsightsAction[];
}

/**
 * The context key the editor's own menus gate each Insights action on —
 * the Menu submenu and the palette in `package.json` (DoD 9.45). The host
 * sets all three from the registry on every provider change, so the editor's
 * menus and the sidebar answer from one fact.
 */
export const INSIGHTS_ACTION_CONTEXT: Readonly<Record<ControlInsightsAction, string>> = Object.freeze({
  pickAgent: 'agentDeck.insights.pickAgent',
  showPayload: 'agentDeck.insights.showPayload',
  clearHistory: 'agentDeck.insights.clearHistory',
});

/**
 * The command each Insights action runs — the rows' ids in
 * {@link CONTROL_COMMANDS}, by action. The same strings as the context keys,
 * which is a coincidence of naming and not a rule: `controls.test.ts` holds
 * this map to the table, and the manifest holds the keys to this map.
 */
export const INSIGHTS_ACTION_COMMANDS: Readonly<Record<ControlInsightsAction, string>> = Object.freeze({
  pickAgent: 'agentDeck.insights.pickAgent',
  showPayload: 'agentDeck.insights.showPayload',
  clearHistory: 'agentDeck.insights.clearHistory',
});

/**
 * Is an entry shown?
 *
 * ONE PREDICATE, read by the sidebar and by every test, so "Inspector appears
 * only while a drawer is open" is a single fact rather than a rule restated
 * per surface.
 */
export function controlVisible(when: ControlWhen | undefined, facts: ControlFacts): boolean {
  switch (when) {
    case undefined:
      return true;
    case 'drawerOpen':
      return facts.drawerOpen;
    case 'insightsPickAgent':
      return facts.insightsActions.includes('pickAgent');
    case 'insightsShowPayload':
      return facts.insightsActions.includes('showPayload');
    case 'insightsClearHistory':
      return facts.insightsActions.includes('clearHistory');
  }
}

/**
 * One command the user can run, from the sidebar or from the view-title menu.
 *
 * THE TABLE IS DATA: `package.json` contributes what is here, the sidebar
 * renders what is here, `activate()` registers what is here, and the boundary
 * accepts what is here.
 */
export interface ControlCommand {
  /** The command id `activate()` registers and `package.json` contributes. */
  readonly command: string;
  /** The words the user reads. A noun or verb phrase; never an id. */
  readonly label: string;
  readonly section: ControlSection;
  /**
   * The group inside the section — the submenu an entry hangs in, and the
   * collapsible parent it sits under in the sidebar. `undefined` means the
   * entry sits directly on its page.
   */
  readonly group?: string;
  /**
   * One line of fact under the label, for the pages that carry explanations.
   *
   * Tweaks has one on every row, because the mock asks for it
   * and because a setting whose name is its only explanation is a setting
   * people guess at. G10 applies: a fact about what the control does, never
   * advice and never a recommendation.
   */
  readonly detail?: string;
  /** The condition this entry is shown under. `undefined` means always. */
  readonly when?: ControlWhen;
  /**
   * The command this entry sits UNDER on its page — drawn one step indented
   * below it, with no twisty (DoD 9.45). Only the three Insights actions,
   * under Open Insights; a collapsible parent is still a group.
   */
  readonly under?: string;
  /**
   * The `ViewControls` field this entry SETS, and the value it sets it to.
   *
   * Present on exactly the entries that are a choice among values, which is
   * what lets the sidebar tick the active one and the host apply them all
   * through one assignment rather than through a switch with twenty arms.
   */
  readonly sets?: { readonly field: keyof ViewControls; readonly value: string };
}

/**
 * A collapsible group — one row that shows its current value and opens to
 * reveal the choices.
 *
 * An ARRAY rather than the `Record<string,string>` v0.9.0 carried, because a
 * group now has more to say than its label: which page it is on, whether it
 * nests inside another group, and what it is shown under. Inspector's three
 * sub-groups are the reason nesting exists at all.
 */
export interface ControlGroup {
  readonly id: string;
  readonly label: string;
  readonly section: ControlSection;
  /** The group this one nests inside, if any. One level is all there is. */
  readonly parent?: string;
  /** The condition this group is shown under. `undefined` means always. */
  readonly when?: ControlWhen;
}

/**
 * Every group, in the order the sidebar shows them.
 *
 * View's five are the mock's five — Renderer, Sessions, Engines, Layout,
 * Sort — each collapsed by default with its current value as a grey suffix.
 *
 * **There is no Statistics group and no Deck ordering group.** The amendment
 * removes both: the Stats tabs went back into the Statistics window (they are
 * `section: 'window'` below) and Deck ordering was a second way to say
 * View ▸ Sort.
 */
export const CONTROL_GROUPS: readonly ControlGroup[] = Object.freeze([
  Object.freeze({ id: 'renderer', label: 'Renderer', section: 'view' as const }),
  Object.freeze({ id: 'sessions', label: 'Sessions', section: 'view' as const }),
  Object.freeze({ id: 'engines', label: 'Engines', section: 'view' as const }),
  Object.freeze({ id: 'layout', label: 'Layout', section: 'view' as const }),
  Object.freeze({ id: 'sort', label: 'Sort', section: 'view' as const }),
  Object.freeze({
    id: 'inspector',
    label: 'Inspector',
    section: 'view' as const,
    when: 'drawerOpen' as const,
  }),
  Object.freeze({
    id: 'inspectorStatus',
    label: 'Status',
    section: 'view' as const,
    parent: 'inspector',
    when: 'drawerOpen' as const,
  }),
  Object.freeze({
    id: 'inspectorOrder',
    label: 'Order',
    section: 'view' as const,
    parent: 'inspector',
    when: 'drawerOpen' as const,
  }),
]);

/** A group by id, or `undefined`. */
export function groupOf(id: string): ControlGroup | undefined {
  return CONTROL_GROUPS.find((group) => group.id === id);
}

/**
 * The three pages, in the order the strip shows them: Menu | View | Tweaks.
 *
 * The Insights tab was the fourth until v0.9.0 DoD 9.28 (spec `Amendment
 * 2026-09-21 — One window`). Its content is a surface of the panel now.
 */
export const CONTROL_SECTIONS: readonly { readonly id: ControlSection; readonly label: string }[] =
  Object.freeze([
    Object.freeze({ id: 'menu' as const, label: 'Menu' }),
    Object.freeze({ id: 'view' as const, label: 'View' }),
    Object.freeze({ id: 'tweaks' as const, label: 'Tweaks' }),
  ]);

/** The page the sidebar opens on. The front door, as it has always been. */
export const DEFAULT_SECTION: ControlSection = 'menu';

/**
 * Every command, in the order it is shown.
 *
 * The Menu page's seven are in the ruled order of spec `Amendment 2026-09-21
 * — One window`: Open Deck · Open Statistics · Open Insights · Show
 * Diagnostics · Settings · Clear Stats History · About. Four of them switch
 * the ONE panel's surface in place. Since DoD 9.45 three more sit under Open
 * Insights — Pick Agent, Show Payload, Clear History — each shown only while
 * the registered provider has that action (`Amendment 2026-09-23`).
 */
export const CONTROL_COMMANDS: readonly ControlCommand[] = Object.freeze([
  /* Menu ------------------------------------------------------------------ */
  { command: 'agentDeck.open', label: 'Open Deck', section: 'menu' },
  { command: 'agentDeck.openStats', label: 'Open Statistics', section: 'menu' },
  { command: 'agentDeck.openInsights', label: 'Open Insights', section: 'menu' },
  /*
   * v0.9.0 DoD 9.45 — spec `Amendment 2026-09-23`: under Open Insights, only
   * while a provider is registered AND has the action. Each calls the
   * provider's optional method and nothing else. No Run entry: Send lives in
   * Insights' own payload preview.
   */
  {
    command: 'agentDeck.insights.pickAgent',
    label: 'Pick Agent',
    section: 'menu',
    when: 'insightsPickAgent',
    under: 'agentDeck.openInsights',
  },
  {
    command: 'agentDeck.insights.showPayload',
    label: 'Show Payload',
    section: 'menu',
    when: 'insightsShowPayload',
    under: 'agentDeck.openInsights',
  },
  {
    command: 'agentDeck.insights.clearHistory',
    label: 'Clear History',
    section: 'menu',
    when: 'insightsClearHistory',
    under: 'agentDeck.openInsights',
  },
  { command: 'agentDeck.showDiagnostics', label: 'Show Diagnostics', section: 'menu' },
  { command: 'agentDeck.openSettings', label: 'Settings', section: 'menu' },
  { command: 'agentDeck.stats.clearHistory', label: 'Clear Stats History', section: 'menu' },
  { command: 'agentDeck.about', label: 'About', section: 'menu' },

  /* View ▸ Renderer ------------------------------------------------------- */
  {
    command: 'agentDeck.view.canvas',
    label: 'Canvas',
    section: 'view',
    group: 'renderer',
    sets: { field: 'renderer', value: 'canvas' },
  },
  {
    command: 'agentDeck.view.list',
    label: 'List',
    section: 'view',
    group: 'renderer',
    sets: { field: 'renderer', value: 'list' },
  },

  /* View ▸ Sessions ------------------------------------------------------- */
  {
    command: 'agentDeck.filter.sessions.all',
    label: 'All',
    section: 'view',
    group: 'sessions',
    sets: { field: 'livenessFilter', value: 'all' },
  },
  {
    command: 'agentDeck.filter.sessions.live',
    label: 'Live',
    section: 'view',
    group: 'sessions',
    sets: { field: 'livenessFilter', value: 'live' },
  },
  {
    command: 'agentDeck.filter.sessions.idle',
    label: 'Idle',
    section: 'view',
    group: 'sessions',
    sets: { field: 'livenessFilter', value: 'idle' },
  },
  {
    command: 'agentDeck.filter.sessions.ended',
    label: 'Ended',
    section: 'view',
    group: 'sessions',
    sets: { field: 'livenessFilter', value: 'ended' },
  },

  /* View ▸ Engines -------------------------------------------------------- */
  {
    command: 'agentDeck.filter.engines.all',
    label: 'All',
    section: 'view',
    group: 'engines',
    sets: { field: 'engineFilter', value: 'all' },
  },
  {
    command: 'agentDeck.filter.engines.cc',
    label: 'Claude Code',
    section: 'view',
    group: 'engines',
    sets: { field: 'engineFilter', value: 'cc' },
  },
  {
    command: 'agentDeck.filter.engines.oc',
    label: 'OpenCode',
    section: 'view',
    group: 'engines',
    sets: { field: 'engineFilter', value: 'oc' },
  },
  {
    command: 'agentDeck.filter.engines.cx',
    label: 'Codex',
    section: 'view',
    group: 'engines',
    sets: { field: 'engineFilter', value: 'cx' },
  },

  /* View ▸ Layout --------------------------------------------------------- */
  {
    command: 'agentDeck.layout.list',
    label: 'List',
    section: 'view',
    group: 'layout',
    sets: { field: 'deckLayout', value: 'list' },
  },
  {
    command: 'agentDeck.layout.grid',
    label: 'Grid',
    section: 'view',
    group: 'layout',
    sets: { field: 'deckLayout', value: 'grid' },
  },
  {
    command: 'agentDeck.layout.lanes',
    label: 'Lanes',
    section: 'view',
    group: 'layout',
    sets: { field: 'deckLayout', value: 'lanes' },
  },

  /* View ▸ Sort ----------------------------------------------------------- */
  {
    command: 'agentDeck.sort.live',
    label: 'Live first',
    section: 'view',
    group: 'sort',
    sets: { field: 'deckSort', value: 'live' },
  },
  {
    command: 'agentDeck.sort.recent',
    label: 'Recent',
    section: 'view',
    group: 'sort',
    sets: { field: 'deckSort', value: 'recent' },
  },
  {
    command: 'agentDeck.sort.engine',
    label: 'Engine',
    section: 'view',
    group: 'sort',
    sets: { field: 'deckSort', value: 'engine' },
  },

  /* View ▸ Inspector — shown only while a drawer is open ------------------- */
  {
    command: 'agentDeck.inspector.status.all',
    label: 'All',
    section: 'view',
    group: 'inspectorStatus',
    when: 'drawerOpen',
    sets: { field: 'inspectorStatus', value: 'all' },
  },
  {
    command: 'agentDeck.inspector.status.running',
    label: 'Running',
    section: 'view',
    group: 'inspectorStatus',
    when: 'drawerOpen',
    sets: { field: 'inspectorStatus', value: 'running' },
  },
  {
    command: 'agentDeck.inspector.status.done',
    label: 'Completed',
    section: 'view',
    group: 'inspectorStatus',
    when: 'drawerOpen',
    sets: { field: 'inspectorStatus', value: 'done' },
  },
  {
    command: 'agentDeck.inspector.status.error',
    label: 'Failed',
    section: 'view',
    group: 'inspectorStatus',
    when: 'drawerOpen',
    sets: { field: 'inspectorStatus', value: 'error' },
  },
  {
    command: 'agentDeck.inspector.order.oldest',
    label: 'Oldest first',
    section: 'view',
    group: 'inspectorOrder',
    when: 'drawerOpen',
    sets: { field: 'inspectorOrder', value: 'oldest' },
  },
  {
    command: 'agentDeck.inspector.order.newest',
    label: 'Newest first',
    section: 'view',
    group: 'inspectorOrder',
    when: 'drawerOpen',
    sets: { field: 'inspectorOrder', value: 'newest' },
  },
  /*
   * The TOOL filter is a QUICK PICK, not a list of contributed commands: the
   * tool names are the engine's, they differ per session, and a command per
   * name is not a thing a manifest can hold. One command, one pick — so it
   * is a ROW under Inspector rather than a group, showing the current value
   * as its grey suffix exactly as a collapsed group does.
   */
  {
    command: 'agentDeck.inspector.tool',
    label: 'Tool',
    section: 'view',
    group: 'inspector',
    when: 'drawerOpen',
  },

  /* View ▸ Reset view (one entry, the active surface) ---------------------- */
  { command: 'agentDeck.resetView', label: 'Reset view', section: 'view' },

  /* The Statistics window's own tabs — a ruled exception, and not a page --- */
  {
    command: 'agentDeck.stats.tab.files',
    label: 'Files',
    section: 'window',
    sets: { field: 'statsTab', value: 'files' },
  },
  {
    command: 'agentDeck.stats.tab.tools',
    label: 'Tools',
    section: 'window',
    sets: { field: 'statsTab', value: 'tools' },
  },
  {
    command: 'agentDeck.stats.tab.loops',
    label: 'Loops & churn',
    section: 'window',
    sets: { field: 'statsTab', value: 'loops' },
  },
  {
    command: 'agentDeck.stats.tab.tokens',
    label: 'Tokens',
    section: 'window',
    sets: { field: 'statsTab', value: 'tokens' },
  },
  {
    command: 'agentDeck.stats.tab.trends',
    label: 'Trends',
    section: 'window',
    sets: { field: 'statsTab', value: 'trends' },
  },

  /* Tweaks ---------------------------------------------------------------- */
  {
    command: 'agentDeck.tweak.followNewSessions',
    label: 'Follow new sessions',
    section: 'tweaks',
    detail: 'A session that appears while the deck is open becomes the selected one.',
  },
  {
    command: 'agentDeck.tweak.openDrawerOnEnter',
    label: 'Open the drawer on entering a session',
    section: 'tweaks',
    detail: 'Entering a session from the deck opens its tool-call drawer.',
  },
  {
    command: 'agentDeck.tweak.drawerExpandedByDefault',
    label: 'Open the drawer expanded',
    section: 'tweaks',
    detail: 'The drawer opens at its expanded height rather than its collapsed one.',
  },

  /*
   * The Insights page's three were here until v0.9.0 DoD 9.28 — Get, Open and
   * Run, shown by whether the Insights EXTENSION was installed. Spec
   * `Amendment 2026-09-21 — One window` deletes the tab: Open Insights is a
   * Menu entry that switches the panel's surface, and "Get" and "Run" are
   * actions ON that surface (the Get tile, and the Run action that calls the
   * registered provider), so neither is a command any more.
   */
]);

/**
 * Which surface may post a command (DoD 9.18).
 *
 * Derived from `section`, so it is a reading of the one table rather than a
 * second list beside it. `window` is the Statistics tab strip, which lives in
 * the PANEL; everything else is a sidebar page.
 */
export function commandSurface(entry: ControlCommand): ControlSurface {
  return entry.section === 'window' ? 'panel' : 'sidebar';
}

/**
 * The `agentDeck.` configuration keys a `tweak.` command writes, derived from
 * the command id rather than written a second time.
 *
 * Returns `undefined` for a command that is not a tweak, so a caller that
 * passes the wrong id gets nothing rather than a key it then writes.
 */
export function tweakKeyOf(command: string): string | undefined {
  const prefix = 'agentDeck.tweak.';
  if (!command.startsWith(prefix)) return undefined;
  const rest = command.slice(prefix.length);
  const dot = rest.indexOf('.');
  return dot === -1 ? rest : rest.slice(0, dot);
}

/**
 * Coerce `agentDeck.defaultOrdering` to a sort this build knows.
 *
 * The setting is typed `string` on `AgentDeckSettings` — it comes out of a
 * user's `settings.json` — and a value this build does not know reads as the
 * DEFAULT rather than as an error: an unknown ordering is not a reason for
 * the deck to refuse to open.
 */
export function asDeckSort(value: unknown): DeckSort {
  return typeof value === 'string' && (DECK_SORTS as readonly string[]).includes(value)
    ? (value as DeckSort)
    : DEFAULT_VIEW_CONTROLS.deckSort;
}

/**
 * The keyboard shortcuts.
 *
 * They were `Deck.svelte`'s own `keydown` handler until v0.9.0, setting values
 * the component owned. It owns none of them now, so the shortcuts are
 * contributed to the EDITOR and bound to the same commands the View page
 * runs. **TEN**, exactly the ten that existed — four engines (`a c o x`),
 * three layouts (`1 2 3`) and three sorts (`l r e`).
 *
 * {@link KEYBINDING_WHEN} is what keeps a bare letter safe: without it, `c`
 * would fire while somebody was typing in a file.
 */
export const CONTROL_KEYBINDINGS: readonly { readonly command: string; readonly key: string }[] =
  Object.freeze([
    { command: 'agentDeck.filter.engines.all', key: 'a' },
    { command: 'agentDeck.filter.engines.cc', key: 'c' },
    { command: 'agentDeck.filter.engines.oc', key: 'o' },
    { command: 'agentDeck.filter.engines.cx', key: 'x' },
    { command: 'agentDeck.layout.list', key: '1' },
    { command: 'agentDeck.layout.grid', key: '2' },
    { command: 'agentDeck.layout.lanes', key: '3' },
    { command: 'agentDeck.sort.live', key: 'l' },
    { command: 'agentDeck.sort.recent', key: 'r' },
    { command: 'agentDeck.sort.engine', key: 'e' },
  ]);

/**
 * The `when` clause every one of them carries.
 *
 * `activeWebviewPanelId` is the editor's own context key and it is set only
 * while the deck panel itself has focus, so these letters cannot reach a text
 * editor, a terminal or a find box. The panel's view type is written out
 * rather than imported: this module may not import `extension.ts`, and
 * `manifest.test.ts` holds the two literals against each other.
 */
export const KEYBINDING_WHEN = "activeWebviewPanelId == 'agentDeck.panel'";

/**
 * The Menu page's entries, in the ruled order — the seven, and the three
 * Insights actions under Open Insights (DoD 9.45).
 *
 * Derived from {@link CONTROL_COMMANDS} rather than written again, so the
 * order a reader sees in the table is the order the page shows.
 */
export const MENU_COMMANDS: readonly ControlCommand[] = Object.freeze(
  CONTROL_COMMANDS.filter((entry) => entry.section === 'menu'),
);

/** Every command id, for the manifest check, for registration, and for the guard. */
export const CONTROL_COMMAND_IDS: readonly string[] = Object.freeze(
  CONTROL_COMMANDS.map((entry) => entry.command),
);

/**
 * True iff `command` is one of them — **THE ALLOW-LIST, and there is one.**
 *
 * Asked by `isWebviewToHostMessage` at the untrusted boundary and by the
 * host's own dispatch. The v0.9.0 defect was two lists that disagreed; a
 * single derived array cannot.
 */
export function isControlCommand(command: string): boolean {
  return CONTROL_COMMAND_IDS.includes(command);
}

/** True iff `surface` may post `command`. The second half of the boundary. */
export function isCommandFrom(surface: ControlSurface, command: string): boolean {
  const entry = CONTROL_COMMANDS.find((row) => row.command === command);
  return entry !== undefined && commandSurface(entry) === surface;
}

/**
 * Does this entry appear in the command palette?
 *
 * The Menu page's entries — the ones a person would think to search for by
 * name. The three Insights actions are gated in the manifest on the context
 * keys in {@link INSIGHTS_ACTION_CONTEXT}, so the palette offers each only
 * while the provider has it. The granular ones (a filter, a layout, a sort, an inspector option, a
 * Stats tab) are hidden, because thirty-odd entries reading `Agent Deck: All`
 * would bury every other command a user has. They are reachable from the
 * sidebar, from the submenus and, for ten of them, from the keyboard.
 */
export function isPaletteVisible(entry: ControlCommand): boolean {
  return entry.section === 'menu';
}

/**
 * Apply a command's `sets` to a control state, returning a NEW state.
 *
 * The host's whole switch, in one function: every value-choosing entry is
 * applied identically, so a new row in the table needs no new arm. A command
 * with no `sets` returns the state unchanged — the caller does the rest.
 */
export function applyControlCommand(
  controls: ViewControls,
  command: string,
): ViewControls {
  const entry = CONTROL_COMMANDS.find((row) => row.command === command);
  if (entry?.sets === undefined) return controls;
  // `focusSessionId` belongs to a deep link and to nothing else, so ANY
  // control command clears it: a user who picks a Stats tab by hand has
  // stopped following the link that focused a session.
  const { focusSessionId: _dropped, ...rest } = controls;
  return { ...rest, [entry.sets.field]: entry.sets.value } as ViewControls;
}
