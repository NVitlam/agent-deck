/**
 * The sidebar — a NATIVE `TreeView` — v0.9.0 DoD 9.14, ruling 1 (2026-09-20).
 *
 * The sidebar was a webview until this release: `webview/sidebar/*` drew a two
 * tab panel and posted `runCommand`/`updateTweak` back at the host. Spec
 * `Amendment 2026-09-20 — Clean windows` moves every control out of every
 * webview, so a webview whose whole content was controls has nothing left to
 * draw. It is deleted, and this is what stands in the same slot.
 *
 * ## What this buys, beyond obeying the amendment
 *
 * The dead About button is the argument. A `runCommand` from the PANEL was
 * validated against the SIDEBAR's five-entry menu list, so `agentDeck.about`
 * and `agentDeck.insights` were dropped at the boundary and the handler that
 * allowed them was unreachable — two dead buttons, one line. A tree item runs
 * its command through `TreeItem.command`, which is the editor's own path: there
 * is no message, no guard, and nothing to validate a command against a list it
 * was never on.
 *
 * ## The shape
 *
 * Four sections, in the amendment's order — Menu · View · Tweaks · Insights.
 * Every row under them comes from {@link CONTROL_COMMANDS}, which is also what
 * `package.json` contributes and what the `view/title` submenus mirror, so a
 * row can be neither an unlisted command nor a contributed command with
 * nothing behind it. Nothing here writes a label a second time.
 *
 * ## The tick is a FACT, never a memory
 *
 * A choice row is ticked when the host's control state holds its value, read
 * at the moment the row is built. The tree stores no selection of its own —
 * the same rule `src/sidebar/tweaks.ts` states for settings, applied to view
 * controls: one owner, and the renderer asks it.
 */

import * as vscode from 'vscode';

import type { InsightExample } from '../insights/layout.js';
import type { ControlCommand, ViewControls } from '../view/controls.js';
import {
  CONTROL_COMMANDS,
  CONTROL_GROUPS,
  CONTROL_SECTIONS,
  tweakKeyOf,
  tweakValueOf,
} from '../view/controls.js';

// The two view ids live in `src/view/controls.ts` — the no-imports module —
// so a manifest test can read them without pulling `vscode` in behind them.
// Re-exported here for every caller that thinks of them as the sidebar's.
export { SIDEBAR_CONTAINER_ID, SIDEBAR_VIEW_ID } from '../view/controls.js';

/**
 * What the Insights section prints, from the host's own store.
 *
 * A STRUCT rather than a callback per field: the section is one read of one
 * state, and four callbacks would let two of its lines describe two different
 * moments.
 */
export interface InsightsSection {
  /** The counts line, already rendered — `2 compactions, 1 re-read loop`. */
  readonly counts: string;
  /** The example currently shown. Rotated by `agentDeck.insights.nextExample`. */
  readonly example: InsightExample;
  /** Whether `nvitlam.agent-deck-insights` is installed in this editor. */
  readonly installed: boolean;
  /** How many recorded sessions the counts are over. Printed, so 0 is legible. */
  readonly sessions: number;
}

/** Everything the tree asks the host. Injected, so the model is testable. */
export interface TreeDeps {
  /** The host's authoritative control state. Read per build, never cached. */
  controls(): ViewControls;
  /** One `agentDeck.` setting, as the configuration reads it now. */
  tweakValue(key: string): boolean | string | undefined;
  /** The Insights section's four lines. */
  insights(): InsightsSection;
}

/**
 * One node of the tree, with no `vscode` in it.
 *
 * The provider below turns these into `vscode.TreeItem`s and does nothing
 * else, which is what lets `tree.test.ts` drive the whole structure — labels,
 * order, ticks, checkbox states, commands — without a fake editor, and then
 * drive the ADAPTER separately. The recorded D4 shape is a component test
 * standing in for a wiring nothing exercises, so both halves have a test.
 */
export interface TreeNodeModel {
  /** Stable, unique, and what `getChildren` is keyed on. */
  readonly id: string;
  readonly label: string;
  /** The grey text after the label. A value, a count; never a sentence. */
  readonly description?: string;
  readonly children?: readonly TreeNodeModel[];
  /** The command this row runs when clicked. Absent on a heading. */
  readonly command?: string;
  /** True when this row's value is the one the host currently holds. */
  readonly ticked?: boolean;
  /** A boolean tweak's state. Absent on every row that is not one. */
  readonly checked?: boolean;
  /** The `agentDeck.` key a checkbox writes. */
  readonly tweakKey?: string;
  /** Collapsed rather than expanded when it has children. */
  readonly collapsed?: boolean;
}

/**
 * Build the whole tree, as data.
 *
 * ONE PASS OVER {@link CONTROL_COMMANDS}, grouped by section and then by
 * group, so the order the table declares is the order the user reads and a
 * new row needs no code here.
 */
export function buildTree(deps: TreeDeps): readonly TreeNodeModel[] {
  const controls = deps.controls();
  const sections: TreeNodeModel[] = [];

  for (const section of CONTROL_SECTIONS) {
    const rows = CONTROL_COMMANDS.filter((entry) => entry.section === section.id);
    const children: TreeNodeModel[] = [];
    const groupsDone = new Set<string>();

    for (const entry of rows) {
      if (entry.group === undefined) {
        children.push(leafOf(entry, controls, deps));
        continue;
      }
      if (groupsDone.has(entry.group)) continue;
      groupsDone.add(entry.group);
      const groupRows = rows.filter((row) => row.group === entry.group);
      const groupChildren = groupRows.map((row) => leafOf(row, controls, deps));
      const active = groupChildren.find((row) => row.ticked === true);
      children.push({
        id: `${section.id}:${entry.group}`,
        label: CONTROL_GROUPS[entry.group] ?? entry.group,
        // The active value on the heading, so a collapsed group still says
        // what it is set to. A group whose rows are not a choice (Tweaks'
        // ordering rows are, the booleans are not) simply has none.
        ...(active === undefined ? {} : { description: active.label }),
        children: groupChildren,
        collapsed: true,
      });
    }

    if (section.id === 'insights') children.unshift(...insightsRows(deps));

    sections.push({
      id: `section:${section.id}`,
      label: section.label,
      children,
    });
  }

  return sections;
}

/** The three rows the Insights section shows above its two commands. */
function insightsRows(deps: TreeDeps): readonly TreeNodeModel[] {
  const insights = deps.insights();
  return [
    {
      id: 'insights:counts',
      label: insights.counts,
      description: `over ${String(insights.sessions)} recorded sessions`,
    },
    {
      id: 'insights:example',
      label: insights.example.title,
      description: 'example',
      children: insights.example.lines.map((line, index) => ({
        id: `insights:example:${String(index)}`,
        label: line,
      })),
    },
  ];
}

/** One command row, ticked or checked according to the state it names. */
function leafOf(
  entry: ControlCommand,
  controls: ViewControls,
  deps: TreeDeps,
): TreeNodeModel {
  const node: {
    -readonly [K in keyof TreeNodeModel]: TreeNodeModel[K];
  } = {
    id: entry.command,
    label: entry.label,
    command: entry.command,
  };

  if (entry.sets !== undefined) {
    node.ticked = controls[entry.sets.field] === entry.sets.value;
    return node;
  }

  const key = tweakKeyOf(entry.command);
  if (key !== undefined) {
    const value = deps.tweakValue(key);
    const wanted = tweakValueOf(entry.command);
    if (wanted === undefined) {
      // A boolean tweak: a real checkbox (ruling 1), whose state is the
      // setting's. `=== true` and never truthiness — the value is typed
      // `boolean | string` and a non-empty string must not tick a box.
      node.checked = value === true;
      node.tweakKey = key;
      return node;
    }
    node.ticked = value === wanted;
    return node;
  }

  if (entry.command === 'agentDeck.insights') {
    // DoD 9.6's one row, two words. The branch is a fact about the editor.
    node.label = deps.insights().installed ? 'Open Insights' : 'Get Insights';
  }
  return node;
}

/**
 * The provider VS Code talks to.
 *
 * It holds the built tree between refreshes so `getChildren(element)` can
 * answer from the same pass that produced the parent — a second build would
 * read the state again and could hand a child a different answer from its own
 * parent's.
 */
export class AgentDeckTreeProvider implements vscode.TreeDataProvider<TreeNodeModel> {
  readonly #changed = new vscode.EventEmitter<TreeNodeModel | undefined>();

  readonly onDidChangeTreeData = this.#changed.event;

  #roots: readonly TreeNodeModel[];

  constructor(private readonly deps: TreeDeps) {
    this.#roots = buildTree(deps);
  }

  /** Rebuild from the host's current state and tell the editor. */
  refresh(): void {
    this.#roots = buildTree(this.deps);
    this.#changed.fire(undefined);
  }

  getChildren(element?: TreeNodeModel): TreeNodeModel[] {
    // A COPY, because the editor's own signature is mutable and handing it
    // the frozen model would be handing it something it may legitimately
    // sort or splice.
    if (element === undefined) return [...this.#roots];
    return [...(element.children ?? [])];
  }

  getTreeItem(element: TreeNodeModel): vscode.TreeItem {
    const collapsible =
      element.children === undefined || element.children.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : element.collapsed === true
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded;
    const item = new vscode.TreeItem(element.label, collapsible);
    item.id = element.id;
    if (element.description !== undefined) item.description = element.description;
    if (element.command !== undefined) {
      item.command = { command: element.command, title: element.label };
    }
    // The tick is an ICON, never a changed label: a label that gains a glyph
    // is a label two tests then disagree about.
    if (element.ticked === true) item.iconPath = new vscode.ThemeIcon('check');
    if (element.checked !== undefined) {
      item.checkboxState = element.checked
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
      // A checkbox row must not ALSO run its command on click: the editor
      // fires `onDidChangeCheckboxState` for the box, and a command beside it
      // would write the setting twice, in opposite directions.
      item.command = undefined;
    }
    return item;
  }

  dispose(): void {
    this.#changed.dispose();
  }
}
