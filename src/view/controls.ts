/**
 * The view controls — v0.9.0 DoD 9.14 (spec `Amendment 2026-09-20 — Clean
 * windows: all controls in the view menu`).
 *
 * THE HOST OWNS EVERY CONTROL VALUE AND THE WEBVIEW RENDERS IT. That is the
 * whole of this module's reason to exist, and it is the same arrangement
 * `src/sidebar/tweaks.ts` already describes for settings: one source of
 * truth, one direction of travel. Under the amendment no webview surface has
 * a control on it, so the renderer has nothing to write back — a value moves
 * because a command ran, never because something was clicked on a canvas.
 *
 * NO IMPORTS AT ALL, like `src/sidebar/menu.ts`, `src/sidebar/tweaks.ts` and
 * `src/bridge/contract.ts`. This module is read by the HOST (to hold the
 * state, to build the tree and to validate nothing — there is nothing inbound
 * to validate any more) and by the CSP-strict WEBVIEW bundle (to type the
 * message it receives), and an import is how a node dependency reaches a
 * browser bundle.
 *
 * ## The values are written here and CHECKED against the renderer
 *
 * `ViewMode`, `EngineFilter` and `LivenessFilter` also exist in
 * `webview/canvas-contract.ts`, and `DeckLayoutMode`/`DeckSortMode` in
 * `webview/layout.ts`, because those modules are the renderer's own and this
 * one may not import them. The duplication is CHECKED rather than trusted —
 * `src/view/controls.test.ts` compares every list to the renderer's — which
 * is the treatment `tweaks.ts`'s `options` already gets.
 *
 * ## `insights` is NOT a view mode any more
 *
 * v0.9.0 shipped `viewMode: 'insights'` as a fourth panel mode. The amendment
 * moves the whole tab into the sidebar tree, so the mode is gone and the
 * renderer's `VIEW_MODES` loses a member. Three remain, and `Canvas | List`
 * is the pair the amendment names; `stats` is reached from Menu ▸ Open
 * Statistics.
 */

/* ------------------------------------------------------------------------ *
 * The value types
 * ------------------------------------------------------------------------ */

/** Which renderer the panel is showing. */
export type ViewMode = 'canvas' | 'list' | 'stats';

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
  readonly viewMode: ViewMode;
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
   * deep link, carried here now that `showView` is gone.
   *
   * Absence CLEARS the focus, which is what every caller but the deep link
   * wants: a focus belongs to the link that set it, never to the view.
   */
  readonly focusSessionId?: string;
}

/* ------------------------------------------------------------------------ *
 * The enumerations, in the order the menus show them
 * ------------------------------------------------------------------------ */

export const VIEW_MODES: readonly ViewMode[] = ['canvas', 'list', 'stats'];
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
  viewMode: 'canvas',
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
 * Which section of the sidebar tree — and which `view/title` submenu — an
 * entry belongs to. The amendment names exactly these four.
 */
export type ControlSection = 'menu' | 'view' | 'tweaks' | 'insights';

/**
 * One command the user can run, from the tree or from the view-title menu.
 *
 * THE TABLE IS DATA, exactly as `menu.ts`'s list is, and for the same reason:
 * `package.json` contributes what is here, the tree renders what is here, and
 * `manifest.test.ts` reads it back, so an entry can be neither an unlisted
 * command nor a contributed command with nothing behind it.
 */
export interface ControlCommand {
  /** The command id `activate()` registers and `package.json` contributes. */
  readonly command: string;
  /** The words the user reads. A noun or verb phrase; never an id. */
  readonly label: string;
  readonly section: ControlSection;
  /**
   * The group inside the section — the submenu an entry hangs in, and the
   * parent item it sits under in the tree. `undefined` means the entry sits
   * directly under its section.
   */
  readonly group?: string;
  /**
   * The `ViewControls` field this entry SETS, and the value it sets it to.
   *
   * Present on exactly the entries that are a choice among values, which is
   * what lets the tree tick the active one and the host apply them all
   * through one assignment rather than through a switch with 20 arms.
   */
  readonly sets?: { readonly field: keyof ViewControls; readonly value: string };
}

/** The group labels, written once so the tree and the manifest agree. */
export const CONTROL_GROUPS: Readonly<Record<string, string>> = Object.freeze({
  renderer: 'Renderer',
  sessions: 'Filters: sessions',
  engines: 'Filters: engines',
  layout: 'Layout',
  sort: 'Sort',
  statistics: 'Statistics',
  inspectorStatus: 'Inspector: status',
  inspectorOrder: 'Inspector: order',
  ordering: 'Deck ordering',
});

/** The section headings, in the order the tree shows them. */
export const CONTROL_SECTIONS: readonly { readonly id: ControlSection; readonly label: string }[] =
  Object.freeze([
    Object.freeze({ id: 'menu' as const, label: 'Menu' }),
    Object.freeze({ id: 'view' as const, label: 'View' }),
    Object.freeze({ id: 'tweaks' as const, label: 'Tweaks' }),
    Object.freeze({ id: 'insights' as const, label: 'Insights' }),
  ]);

/**
 * Every command, in the order it is shown.
 *
 * The Menu section's first five are the v0.7.0 sidebar's own list, in the
 * user's locked order (Open Deck · Open Statistics · Show Diagnostics ·
 * Settings · Clear Stats History), with About added by the amendment.
 * `src/sidebar/menu.ts` is GONE — its list is these six rows minus About, and
 * `controls.test.ts` is where the order is now pinned.
 */
export const CONTROL_COMMANDS: readonly ControlCommand[] = Object.freeze([
  /* Menu ------------------------------------------------------------------ */
  { command: 'agentDeck.open', label: 'Open Deck', section: 'menu' },
  { command: 'agentDeck.openStats', label: 'Open Statistics', section: 'menu' },
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
    sets: { field: 'viewMode', value: 'canvas' },
  },
  {
    command: 'agentDeck.view.list',
    label: 'List',
    section: 'view',
    group: 'renderer',
    sets: { field: 'viewMode', value: 'list' },
  },

  /* View ▸ Filters: sessions ---------------------------------------------- */
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

  /* View ▸ Filters: engines ----------------------------------------------- */
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

  /* View ▸ Statistics (ruling 4) ------------------------------------------ */
  {
    command: 'agentDeck.stats.tab.files',
    label: 'Files',
    section: 'view',
    group: 'statistics',
    sets: { field: 'statsTab', value: 'files' },
  },
  {
    command: 'agentDeck.stats.tab.tools',
    label: 'Tools',
    section: 'view',
    group: 'statistics',
    sets: { field: 'statsTab', value: 'tools' },
  },
  {
    command: 'agentDeck.stats.tab.loops',
    label: 'Loops & churn',
    section: 'view',
    group: 'statistics',
    sets: { field: 'statsTab', value: 'loops' },
  },
  {
    command: 'agentDeck.stats.tab.tokens',
    label: 'Tokens',
    section: 'view',
    group: 'statistics',
    sets: { field: 'statsTab', value: 'tokens' },
  },
  {
    command: 'agentDeck.stats.tab.trends',
    label: 'Trends',
    section: 'view',
    group: 'statistics',
    sets: { field: 'statsTab', value: 'trends' },
  },

  /* View ▸ Inspector (ruling 5) ------------------------------------------- */
  {
    command: 'agentDeck.inspector.status.all',
    label: 'All',
    section: 'view',
    group: 'inspectorStatus',
    sets: { field: 'inspectorStatus', value: 'all' },
  },
  {
    command: 'agentDeck.inspector.status.running',
    label: 'Running',
    section: 'view',
    group: 'inspectorStatus',
    sets: { field: 'inspectorStatus', value: 'running' },
  },
  {
    command: 'agentDeck.inspector.status.done',
    label: 'Completed',
    section: 'view',
    group: 'inspectorStatus',
    sets: { field: 'inspectorStatus', value: 'done' },
  },
  {
    command: 'agentDeck.inspector.status.error',
    label: 'Failed',
    section: 'view',
    group: 'inspectorStatus',
    sets: { field: 'inspectorStatus', value: 'error' },
  },
  {
    command: 'agentDeck.inspector.order.oldest',
    label: 'Oldest first',
    section: 'view',
    group: 'inspectorOrder',
    sets: { field: 'inspectorOrder', value: 'oldest' },
  },
  {
    command: 'agentDeck.inspector.order.newest',
    label: 'Newest first',
    section: 'view',
    group: 'inspectorOrder',
    sets: { field: 'inspectorOrder', value: 'newest' },
  },
  /*
   * The TOOL filter is a QUICK PICK, not a list of contributed commands: the
   * tool names are the engine's, they differ per session, and a command per
   * name is not a thing a manifest can hold. One command, one pick.
   */
  { command: 'agentDeck.inspector.tool', label: 'Filter by tool', section: 'view' },

  /* View ▸ Reset view (ruling 6: one entry, the active surface) ------------ */
  { command: 'agentDeck.resetView', label: 'Reset view', section: 'view' },

  /* Tweaks ---------------------------------------------------------------- */
  {
    command: 'agentDeck.tweak.followNewSessions',
    label: 'Follow new sessions',
    section: 'tweaks',
  },
  {
    command: 'agentDeck.tweak.openDrawerOnEnter',
    label: 'Open the drawer on entering a session',
    section: 'tweaks',
  },
  {
    command: 'agentDeck.tweak.drawerExpandedByDefault',
    label: 'Open the drawer expanded',
    section: 'tweaks',
  },
  {
    command: 'agentDeck.tweak.defaultOrdering.live',
    label: 'Live first',
    section: 'tweaks',
    group: 'ordering',
  },
  {
    command: 'agentDeck.tweak.defaultOrdering.recent',
    label: 'Recent',
    section: 'tweaks',
    group: 'ordering',
  },
  {
    command: 'agentDeck.tweak.defaultOrdering.engine',
    label: 'Engine',
    section: 'tweaks',
    group: 'ordering',
  },

  /* Insights -------------------------------------------------------------- */
  { command: 'agentDeck.insights.nextExample', label: 'See an example', section: 'insights' },
  { command: 'agentDeck.insights', label: 'Insights', section: 'insights' },
]);

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

/** The enum VALUE a `tweak.<key>.<value>` command writes, if it names one. */
export function tweakValueOf(command: string): string | undefined {
  const prefix = 'agentDeck.tweak.';
  if (!command.startsWith(prefix)) return undefined;
  const rest = command.slice(prefix.length);
  const dot = rest.indexOf('.');
  return dot === -1 ? undefined : rest.slice(dot + 1);
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
 * The keyboard shortcuts, which the RULING keeps — v0.9.0 DoD 9.14.
 *
 * They were `Deck.svelte`'s own `keydown` handler until this release, setting
 * values the component owned. It owns none of them now, so the shortcuts are
 * contributed to the EDITOR and bound to the same commands the View submenu
 * runs. **TEN**, exactly the ten that existed — four engines (`a c o x`),
 * three layouts (`1 2 3`) and three sorts (`l r e`).
 *
 * (This comment said "nine" until a verifier round counted the array. The
 * array was always ten; `git show 0991ef7:webview/Deck.svelte` has
 * `all: { label: 'All', key: 'a' }` in its engine table. A number written
 * beside the thing it counts is this repository's most-recorded defect.)
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
 * The Menu section's six, in the user's locked order.
 *
 * `src/sidebar/menu.ts`'s `SIDEBAR_MENU` until v0.9.0 DoD 9.14, plus About.
 * Derived from {@link CONTROL_COMMANDS} rather than written again, so the
 * order a reader sees in the table is the order the tree and the submenu show.
 */
export const MENU_COMMANDS: readonly ControlCommand[] = Object.freeze(
  CONTROL_COMMANDS.filter((entry) => entry.section === 'menu'),
);

/** Every command id, for the manifest check and for registration. */
export const CONTROL_COMMAND_IDS: readonly string[] = Object.freeze(
  CONTROL_COMMANDS.map((entry) => entry.command),
);

/** True iff `command` is one of them. */
export function isControlCommand(command: string): boolean {
  return CONTROL_COMMAND_IDS.includes(command);
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
