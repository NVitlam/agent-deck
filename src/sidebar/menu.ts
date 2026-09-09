/**
 * The activity-bar sidebar's menu — v0.7.0 Phase 4, DoD 4.6b (spec §G2).
 *
 * THE LIST IS DATA, and that is the whole design: the sidebar renders whatever
 * is here, in this order, and a later release adds an entry by adding a row.
 * Every row names a command `activate()` registers — `manifest.test.ts`
 * asserts each one is contributed and `extension.test.ts` asserts each one is
 * registered, so a row can be neither a dead button nor an unlisted one.
 *
 * NO IMPORTS AT ALL, like `src/bridge/contract.ts`: this module is read by the
 * host (to validate a `runCommand` message against the list) and by the
 * webview bundle (to draw the menu), and an import is how a node dependency
 * reaches a CSP-strict browser bundle.
 *
 * The order is the user's (locked open question, 2026-09-05): Open Deck · Open
 * Statistics · Show Diagnostics · Settings · Clear Stats History. The last one
 * is the ONLY sidebar surface for clearing — never a visible button on the deck
 * or the Stats view — and it still confirms with a modal on the host side.
 */

/** One sidebar entry: the command it runs and the words the user reads. */
export interface SidebarMenuEntry {
  /** A command id `activate()` registers. */
  readonly command: string;
  /** The label. Sans, a verb phrase; never an id. */
  readonly label: string;
}

/** The `viewsContainers.activitybar` id in `package.json`. */
export const SIDEBAR_CONTAINER_ID = 'agentDeck';

/** The `views` entry the container holds — the `webviewView` id. */
export const SIDEBAR_VIEW_ID = 'agentDeck.sidebar';

/** The command ids the sidebar can name. Declared once, read by both sides. */
export const SIDEBAR_MENU: readonly SidebarMenuEntry[] = [
  { command: 'agentDeck.open', label: 'Open Deck' },
  { command: 'agentDeck.openStats', label: 'Open Statistics' },
  { command: 'agentDeck.showDiagnostics', label: 'Show Diagnostics' },
  { command: 'agentDeck.openSettings', label: 'Settings' },
  { command: 'agentDeck.stats.clearHistory', label: 'Clear Stats History' },
];

/** True iff `command` is a menu entry. The guard's one question. */
export function isSidebarCommand(command: string): boolean {
  return SIDEBAR_MENU.some((entry) => entry.command === command);
}
