/**
 * The Tweaks panel's four settings — v0.8.0 Phase 7, DoD 7.6 (spec
 * `Amendment 2026-09-12`).
 *
 * THE LIST IS DATA, exactly as `menu.ts`'s is, and for the same reason: the
 * panel renders whatever is here, in this order, and a later release adds a
 * row rather than a component. `manifest.test.ts` asserts every row is a
 * contributed setting and `extension.test.ts` asserts every row is readable,
 * so a row can be neither a control over nothing nor a setting with no control.
 *
 * NO IMPORTS AT ALL, like `menu.ts` and `src/bridge/contract.ts`. This module
 * is read by the host (to validate an inbound `updateTweak`) and by the webview
 * bundle (to draw the panel), and an import is how a node dependency reaches a
 * CSP-strict browser bundle.
 *
 * ## THE SETTINGS ARE THE STATE. THE PANEL IS A RENDERER.
 *
 * The amendment says it in as many words: *"settings are the source of truth;
 * the panel writes through the VS Code settings API and stores nothing
 * itself."* So there is no default in this file and there is no copy of a
 * value in the webview: a control's position comes from the `tweaks` message
 * the host sends, a click sends `updateTweak`, the host calls
 * `WorkspaceConfiguration.update`, and the next `tweaks` message is what moves
 * the control. A panel holding its own copy would show the user a position
 * that `settings.json` disagreed with the moment anything else wrote it — and
 * "anything else" includes the Settings UI, which this panel's own `Settings`
 * menu entry opens.
 *
 * That is why {@link TweakSetting} carries no `default`. The defaults live in
 * `package.json` and in `SETTING_BOUNDS`/`SETTING_SHAPES`, which
 * `extension.test.ts` already binds to each other; a third copy here would be
 * the stale one.
 */

/** What kind of control a tweak needs. Two, and the union is closed. */
export type TweakKind = 'boolean' | 'enum';

/** A value a tweak may hold on the wire. */
export type TweakValue = boolean | string;

/** One row of the panel. */
export interface TweakSetting {
  /**
   * The configuration key WITHOUT the `agentDeck.` section prefix — the form
   * `WorkspaceConfiguration.get`/`.update` take, and the form
   * `readSettings` already keys on.
   */
  readonly key: string;
  /** The label. Sans, a noun phrase; never a key. */
  readonly label: string;
  /** One line of fact under the label. No advice, no recommendation (G10). */
  readonly detail: string;
  readonly kind: TweakKind;
  /** Every value an `enum` tweak may take, in the order they are shown. */
  readonly options?: readonly string[];
}

/** The `agentDeck.` configuration section, so neither side writes it twice. */
export const TWEAK_SECTION = 'agentDeck';

/**
 * The four, in the order the panel shows them.
 *
 * Ordered deck-outward: what the deck does with a new session, then what
 * entering a session does, then how the drawer opens, then how the deck is
 * sorted — so a reader meets them in the order they meet the product.
 */
export const TWEAK_SETTINGS: readonly TweakSetting[] = [
  {
    key: 'followNewSessions',
    label: 'Follow new sessions',
    detail: 'A session that appears while the deck is open becomes the selected one.',
    kind: 'boolean',
  },
  {
    key: 'openDrawerOnEnter',
    label: 'Open the drawer on entering a session',
    detail: 'Entering a session from the deck opens its tool-call drawer.',
    kind: 'boolean',
  },
  {
    key: 'drawerExpandedByDefault',
    label: 'Open the drawer expanded',
    detail: 'The drawer opens at its expanded height rather than its collapsed one.',
    kind: 'boolean',
  },
  {
    key: 'defaultOrdering',
    label: 'Deck ordering',
    detail: 'The order deck cards are placed in when a window opens.',
    kind: 'enum',
    // `DeckSortMode` in `webview/layout.ts`. NOT imported — this module has no
    // imports, by the rule above — so `webview/tweaks.test.ts` asserts the two
    // lists are equal, which is a check a shared type could not give the HOST
    // (the host cannot import a webview module either).
    options: ['live', 'recent', 'engine'],
  },
];

/** True iff `key` names a tweak. The guard's one question. */
export function isTweakKey(key: string): boolean {
  return TWEAK_SETTINGS.some((tweak) => tweak.key === key);
}

/**
 * True iff `value` is a value `key` may take.
 *
 * Type-strict for booleans and set-membership for enums — never truthiness and
 * never "a string is fine". An inbound message is untrusted input, and the
 * host's next act is to write it into the user's `settings.json`.
 */
export function isTweakValue(key: string, value: unknown): value is TweakValue {
  const tweak = TWEAK_SETTINGS.find((entry) => entry.key === key);
  if (tweak === undefined) return false;
  if (tweak.kind === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string' && (tweak.options ?? []).includes(value);
}
