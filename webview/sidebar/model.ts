/**
 * The sidebar's layout, as a PURE FUNCTION — v0.9.0 DoD 9.17.
 *
 * Spec `Amendment 2026-09-20 — Sidebar shape`. The sidebar is a webview again
 * (the native `TreeView` that shipped hours earlier was rejected as too long
 * and unexplained), and this is the half of it that can be tested without a
 * DOM: state in, rows out, no clock, no store, no element. The component
 * beside it renders these rows and decides nothing.
 *
 * ## Everything comes from `src/view/controls.ts`
 *
 * Labels, order, grouping, nesting, visibility and the command each row runs
 * are all read from the ONE table. Nothing is written here a second time,
 * which is what lets `package.json`, the sidebar, the registration loop and
 * the message boundary be checked against each other rather than kept in step
 * by hand. A new control is a row in that table and a line in the manifest.
 *
 * ## What is state HERE and what is not
 *
 * Which page is open, and which groups are expanded, are view state of
 * exactly the kind the old sidebar's tab already was: no setting, no host
 * message, no storage, gone when the view is disposed (G7). Everything a row
 * SHOWS — a tick, a checkbox, a grey value — is read from the host's state at
 * render time and stored nowhere.
 */

import type {
  ControlCommand,
  ControlFacts,
  ControlGroup,
  ControlSection,
  ViewControls,
} from '../../src/view/controls.js';
import {
  CONTROL_COMMANDS,
  CONTROL_GROUPS,
  CONTROL_SECTIONS,
  INSPECTOR_TOOL_ALL,
  controlVisible,
} from '../../src/view/controls.js';

/** Everything the host states, as one message states it. */
export interface SidebarState {
  readonly controls: ViewControls;
  /** The three tweaks, keyed without the `agentDeck.` prefix. */
  readonly tweaks: Readonly<Record<string, boolean | string>>;
  readonly insightsInstalled: boolean;
  readonly drawerOpen: boolean;
}

/**
 * A row that runs a command and shows no value — Menu's six, Reset view.
 *
 * `value` is present on exactly one of them today (the Inspector tool filter,
 * which is a quick pick rather than a list of commands) and is the grey
 * suffix a collapsed group would show. It does NOT contribute to a parent
 * group's suffix; see {@link groupValue}.
 */
export interface ActionRow {
  readonly kind: 'action';
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly detail?: string;
  readonly value?: string;
}

/** One value inside a group. Ticked when the host holds it. */
export interface ChoiceRow {
  readonly kind: 'choice';
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly ticked: boolean;
}

/** A boolean tweak. A checkbox whose state is the SETTING's. */
export interface ToggleRow {
  readonly kind: 'toggle';
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly detail?: string;
  readonly checked: boolean;
}

/** A collapsible group: one row, its current value, and its children. */
export interface GroupRow {
  readonly kind: 'group';
  readonly id: string;
  readonly label: string;
  /** The grey suffix — what this group is set to, or `undefined`. */
  readonly value?: string;
  readonly children: readonly SidebarRow[];
}

export type SidebarRow = ActionRow | ChoiceRow | ToggleRow | GroupRow;

/** The tool filter's displayed value. `all` reads as words, not as an id. */
export function toolLabel(tool: string): string {
  return tool === INSPECTOR_TOOL_ALL ? 'All tools' : tool;
}

/**
 * A group's grey suffix.
 *
 * The join of the values its CHOICE children carry — a nested group's own
 * value, or a ticked choice's label. An {@link ActionRow}'s value is
 * deliberately excluded: Inspector's suffix reads `All · Oldest first`, the
 * two things a person chose from a list, rather than trailing a tool name
 * that is already on its own row underneath.
 *
 * `undefined` when nothing underneath is a choice, which is every group on
 * the Menu, Tweaks and Insights pages — none of which has one.
 */
function groupValue(children: readonly SidebarRow[]): string | undefined {
  const parts: string[] = [];
  for (const child of children) {
    if (child.kind === 'choice') {
      if (child.ticked) parts.push(child.label);
      continue;
    }
    if (child.kind === 'group' && child.value !== undefined) parts.push(child.value);
  }
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** One command entry, as the row it renders. */
function rowOf(entry: ControlCommand, state: SidebarState): SidebarRow {
  if (entry.sets !== undefined) {
    return {
      kind: 'choice',
      id: entry.command,
      label: entry.label,
      command: entry.command,
      // A FACT, read now, never a memory: the row is ticked because the host
      // holds this value, not because it was the last one clicked.
      ticked: state.controls[entry.sets.field] === entry.sets.value,
    };
  }

  if (entry.section === 'tweaks') {
    const key = entry.command.slice('agentDeck.tweak.'.length);
    return {
      kind: 'toggle',
      id: entry.command,
      label: entry.label,
      command: entry.command,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      // `=== true` and never truthiness: the record is typed
      // `boolean | string` and a non-empty string must not tick a box.
      checked: state.tweaks[key] === true,
    };
  }

  return {
    kind: 'action',
    id: entry.command,
    label: entry.label,
    command: entry.command,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    ...(entry.command === 'agentDeck.inspector.tool'
      ? { value: toolLabel(state.controls.inspectorTool) }
      : {}),
  };
}

/** The rows under one group: its nested groups first, then its own commands. */
function childrenOf(
  group: ControlGroup,
  state: SidebarState,
  facts: ControlFacts,
): readonly SidebarRow[] {
  const nested = CONTROL_GROUPS.filter(
    (candidate) => candidate.parent === group.id && controlVisible(candidate.when, facts),
  ).map((candidate) => groupRowOf(candidate, state, facts));
  const own = CONTROL_COMMANDS.filter(
    (entry) => entry.group === group.id && controlVisible(entry.when, facts),
  ).map((entry) => rowOf(entry, state));
  return [...nested, ...own];
}

function groupRowOf(group: ControlGroup, state: SidebarState, facts: ControlFacts): GroupRow {
  const children = childrenOf(group, state, facts);
  const value = groupValue(children);
  return {
    kind: 'group',
    id: group.id,
    label: group.label,
    ...(value === undefined ? {} : { value }),
    children,
  };
}

/**
 * The rows one page shows, in order.
 *
 * TOP-LEVEL GROUPS FIRST, in the table's order, then the commands that sit
 * directly on the page. View is the only page with both, and its one
 * ungrouped command is Reset view, which belongs at the bottom.
 *
 * A `section: 'window'` command reaches no page at all — the Statistics tabs
 * live in the Statistics window by the amendment's ruled exception — and
 * nothing here looks for them, because {@link CONTROL_SECTIONS} does not name
 * that section.
 */
export function sidebarPage(
  section: ControlSection,
  state: SidebarState,
): readonly SidebarRow[] {
  const facts: ControlFacts = {
    drawerOpen: state.drawerOpen,
    insightsInstalled: state.insightsInstalled,
  };
  const groups = CONTROL_GROUPS.filter(
    (group) =>
      group.section === section &&
      group.parent === undefined &&
      controlVisible(group.when, facts),
  ).map((group) => groupRowOf(group, state, facts));
  const loose = CONTROL_COMMANDS.filter(
    (entry) =>
      entry.section === section &&
      entry.group === undefined &&
      controlVisible(entry.when, facts),
  ).map((entry) => rowOf(entry, state));
  return [...groups, ...loose];
}

/**
 * Every command any page of the sidebar can run, for the state given.
 *
 * Exported for the boundary test (DoD 9.18): it clicks every one of these
 * through the built bundle and asserts the HOST acted, so the set the sidebar
 * can send is compared to the set the guard accepts rather than assumed equal.
 */
export function sidebarCommands(state: SidebarState): readonly string[] {
  const seen: string[] = [];
  const walk = (rows: readonly SidebarRow[]): void => {
    for (const row of rows) {
      if (row.kind === 'group') {
        walk(row.children);
        continue;
      }
      seen.push(row.command);
    }
  };
  // CONTROL_SECTIONS, not a literal list of the same four: this file's own
  // header says nothing here is written a second time, and a hand-written
  // copy of the strip would quietly stop covering a fifth page the day one
  // is added. (It WAS a literal until DoD 9.21; the two-way equality in
  // `sidebar.test.ts` would have caught the drift, which is why this was
  // latent rather than live.)
  for (const section of CONTROL_SECTIONS) {
    walk(sidebarPage(section.id, state));
  }
  return seen;
}
