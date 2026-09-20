/**
 * The native sidebar tree — v0.9.0 DoD 9.14, ruling 1 (2026-09-20).
 *
 * ## Two halves, both driven
 *
 * `buildTree` is the MODEL and it has no `vscode` in it, so most of this file
 * drives structure, order, ticks and checkbox states as data. That alone
 * would be the recorded D4 shape — a model test standing in for an adapter
 * nothing exercises — so `getTreeItem` is driven too, through the real
 * provider, and the mutation that matters is named beside it: an adapter that
 * dropped `command` would leave every row a dead label, which is exactly what
 * the old sidebar shipped.
 *
 * ## The Insights half
 *
 * `src/insights/insights.test.ts` keeps the pure counts and the privacy legs.
 * What is here is the SURFACE: which lines the section shows, that the
 * example rotates on the press and not on being looked at, and that the one
 * button says get or open according to the editor.
 */

import { describe, expect, it } from 'vitest';

import { AgentDeckTreeProvider, buildTree } from './tree.js';
import type { InsightsSection, TreeDeps, TreeNodeModel } from './tree.js';
import { EXAMPLES, exampleAt } from '../insights/layout.js';
import { CONTROL_COMMANDS, DEFAULT_VIEW_CONTROLS } from '../view/controls.js';
import type { ViewControls } from '../view/controls.js';

/* ------------------------------------------------------------------------ *
 * Deps
 * ------------------------------------------------------------------------ */

function deps(over: {
  controls?: Partial<ViewControls>;
  tweaks?: Record<string, boolean | string>;
  insights?: Partial<InsightsSection>;
} = {}): TreeDeps {
  const controls: ViewControls = { ...DEFAULT_VIEW_CONTROLS, ...over.controls };
  const tweaks = over.tweaks ?? {};
  return {
    controls: () => controls,
    tweakValue: (key) => tweaks[key],
    insights: () => ({
      counts: '2 compactions · 1 re-read loop',
      example: exampleAt(0),
      installed: false,
      sessions: 7,
      ...over.insights,
    }),
  };
}

/** One section's rows, flattened, as `label|description|tick|checkbox`. */
function rows(tree: readonly TreeNodeModel[], label: string): string[] {
  const section = tree.find((node) => node.label === label);
  if (section === undefined) throw new Error(`no section: ${label}`);
  const out: string[] = [];
  const walk = (node: TreeNodeModel, depth: number): void => {
    out.push(
      [
        '  '.repeat(depth) + node.label,
        node.description ?? '',
        node.ticked === true ? 'tick' : '',
        node.checked === undefined ? '' : node.checked ? 'checked' : 'unchecked',
      ].join('|'),
    );
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  for (const child of section.children ?? []) walk(child, 0);
  return out;
}

/** Every node of the whole tree, depth first. */
function every(tree: readonly TreeNodeModel[]): TreeNodeModel[] {
  const out: TreeNodeModel[] = [];
  const walk = (node: TreeNodeModel): void => {
    out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of tree) walk(node);
  return out;
}

/* ------------------------------------------------------------------------ *
 * Structure
 * ------------------------------------------------------------------------ */

describe('the four sections', () => {
  it('are Menu, View, Tweaks and Insights, in the amendment’s order', () => {
    expect(buildTree(deps()).map((node) => node.label)).toStrictEqual([
      'Menu',
      'View',
      'Tweaks',
      'Insights',
    ]);
  });

  it('Menu is the six commands, in the locked order — a golden', () => {
    expect(rows(buildTree(deps()), 'Menu')).toStrictEqual([
      'Open Deck|||',
      'Open Statistics|||',
      'Show Diagnostics|||',
      'Settings|||',
      'Clear Stats History|||',
      'About|||',
    ]);
  });

  it('View is every group and every choice, with the active one ticked — a golden', () => {
    expect(rows(buildTree(deps()), 'View')).toStrictEqual([
      'Renderer|Canvas||',
      '  Canvas||tick|',
      '  List|||',
      'Filters: sessions|All||',
      '  All||tick|',
      '  Live|||',
      '  Idle|||',
      '  Ended|||',
      'Filters: engines|All||',
      '  All||tick|',
      '  Claude Code|||',
      '  OpenCode|||',
      '  Codex|||',
      'Layout|Grid||',
      '  List|||',
      '  Grid||tick|',
      '  Lanes|||',
      'Sort|Live first||',
      '  Live first||tick|',
      '  Recent|||',
      '  Engine|||',
      'Statistics|Files||',
      '  Files||tick|',
      '  Tools|||',
      '  Loops & churn|||',
      '  Tokens|||',
      '  Trends|||',
      'Inspector: status|All||',
      '  All||tick|',
      '  Running|||',
      '  Completed|||',
      '  Failed|||',
      'Inspector: order|Oldest first||',
      '  Oldest first||tick|',
      '  Newest first|||',
      'Filter by tool|||',
      'Reset view|||',
    ]);
  });

  it('every group heading names the value it is set to, and the tick follows the state', () => {
    // BOTH channels, and both moved by the same state: a heading that said
    // the right thing while the tick said another would be two accounts of
    // one value, which is the defect this whole design removes.
    const moved = buildTree(
      deps({ controls: { deckSort: 'engine', statsTab: 'trends', inspectorOrder: 'newest' } }),
    );
    const view = rows(moved, 'View');
    expect(view).toContain('Sort|Engine||');
    expect(view).toContain('  Engine||tick|');
    expect(view).toContain('  Live first|||');
    expect(view).toContain('Statistics|Trends||');
    expect(view).toContain('  Trends||tick|');
    expect(view).toContain('Inspector: order|Newest first||');
    expect(view).toContain('  Newest first||tick|');
  });

  it('exactly one row is ticked inside each View group, whatever the state', () => {
    /*
     * SCOPED TO VIEW, and the scope is the point rather than a convenience.
     *
     * A View group ticks a CONTROL VALUE, and `ViewControls` always holds
     * one — there is no "unset" — so exactly one row is always right. The
     * Tweaks ordering group ticks a SETTING, and `src/sidebar/tweaks.ts`
     * carries no default by design: an absent value is the absence of an
     * answer, not `live`, and the test below asserts that it ticks nothing.
     */
    for (const controls of [
      {},
      { engineFilter: 'cx' as const, deckLayout: 'lanes' as const },
      { livenessFilter: 'ended' as const, inspectorStatus: 'error' as const },
      { viewMode: 'list' as const, statsTab: 'tokens' as const, deckSort: 'engine' as const },
    ]) {
      const view = buildTree(deps({ controls })).find((node) => node.label === 'View');
      const groups = (view?.children ?? []).filter(
        (node) => (node.children ?? []).length > 0,
      );
      expect(groups.length, 'no View groups at all').toBeGreaterThan(0);
      for (const group of groups) {
        const ticked = (group.children ?? []).filter((child) => child.ticked === true);
        expect(ticked, `${group.label}: ${JSON.stringify(controls)}`).toHaveLength(1);
      }
    }
  });

  it('every command row names a command from the table, and nothing else does', () => {
    const table = new Set(CONTROL_COMMANDS.map((entry) => entry.command));
    const withCommands = every(buildTree(deps())).filter((node) => node.command !== undefined);
    for (const node of withCommands) expect(table.has(node.command as string), node.label).toBe(true);
    // ...and every row of the table is present, so a contributed command
    // cannot be missing from the surface that is supposed to run it.
    expect(new Set(withCommands.map((node) => node.command)).size).toBe(table.size);
  });

  it('every node id is unique — `getChildren` is keyed on it', () => {
    const ids = every(buildTree(deps())).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ------------------------------------------------------------------------ *
 * Tweaks
 * ------------------------------------------------------------------------ */

describe('Tweaks (ruling 1: checkbox items)', () => {
  it('draws a real checkbox per boolean, and ticks the ordering choice', () => {
    expect(
      rows(buildTree(deps({ tweaks: { followNewSessions: true, defaultOrdering: 'recent' } })), 'Tweaks'),
    ).toStrictEqual([
      'Follow new sessions|||checked',
      'Open the drawer on entering a session|||unchecked',
      'Open the drawer expanded|||unchecked',
      'Deck ordering|Recent||',
      '  Live first|||',
      '  Recent||tick|',
      '  Engine|||',
    ]);
  });

  it('a non-boolean value does NOT tick a box', () => {
    // The record is typed `boolean | string`, and a non-empty string must not
    // turn a checkbox on — the rule `store.ts` states for the same values.
    const tree = buildTree(deps({ tweaks: { followNewSessions: 'yes' as unknown as boolean } }));
    expect(rows(tree, 'Tweaks')[0]).toBe('Follow new sessions|||unchecked');
  });

  it('an unset boolean reads as off; an unset ORDERING ticks nothing', () => {
    /*
     * The two halves differ, and that is `src/sidebar/tweaks.ts`'s rule
     * rather than an inconsistency: a checkbox has two states and "not on"
     * is one of them, while an enum's absence is the absence of an answer
     * and ticking `live` would be this file inventing a default the settings
     * module deliberately does not carry.
     *
     * Production never reaches the second state — `tweaksOf(readSettings())`
     * fills the manifest default, and `extension.test.ts` asserts the tree
     * shows `Live first` in an unconfigured window — so this is the shape
     * the tree survives, not the shape a user sees.
     */
    const tree = buildTree(deps({ tweaks: {} }));
    expect(rows(tree, 'Tweaks')[0]).toBe('Follow new sessions|||unchecked');
    expect(rows(tree, 'Tweaks')[3]).toBe('Deck ordering|||');
    expect(rows(tree, 'Tweaks').filter((row) => row.includes('tick'))).toStrictEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * Insights
 * ------------------------------------------------------------------------ */

describe('Insights (ruling 1: the counts line, the example, the one button)', () => {
  it('shows the counts, the example and its lines, then the two commands', () => {
    expect(rows(buildTree(deps()), 'Insights')).toStrictEqual([
      '2 compactions · 1 re-read loop|over 7 recorded sessions||',
      'Compaction|example||',
      '  Session ses_example01 recorded 3 compactions in 41 minutes.|||',
      '  Each one was preceded by a turn whose cache-creation rose by more than 4,000 tokens.|||',
      '  Prompt tokens after the third compaction: 128,400.|||',
      'See an example|||',
      'Get Insights|||',
    ]);
  });

  it('the one button says get or open, from the editor — both arms', () => {
    expect(rows(buildTree(deps({ insights: { installed: true } })), 'Insights').at(-1)).toBe(
      'Open Insights|||',
    );
    expect(rows(buildTree(deps({ insights: { installed: false } })), 'Insights').at(-1)).toBe(
      'Get Insights|||',
    );
  });

  it('the example the section shows is the one the counter names', () => {
    // Every example, so a section hard-coded to the first passes none of the
    // arms after it — the mutation that survived in v0.9.0 was exactly that.
    for (const [index, example] of EXAMPLES.entries()) {
      const tree = buildTree(deps({ insights: { example: exampleAt(index) } }));
      expect(rows(tree, 'Insights')[1], String(index)).toBe(`${example.title}|example|`.concat('|'));
    }
  });
});

/* ------------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------------ */

describe('the provider hands the editor real TreeItems', () => {
  it('carries the command, the description, the tick icon and the checkbox', () => {
    const provider = new AgentDeckTreeProvider(
      deps({ controls: { deckSort: 'recent' }, tweaks: { followNewSessions: true } }),
    );
    const sections = provider.getChildren();
    expect(sections.map((node) => provider.getTreeItem(node).label)).toStrictEqual([
      'Menu',
      'View',
      'Tweaks',
      'Insights',
    ]);

    // A command row: the id is on the item, which is the whole mechanism —
    // no message, no guard, nothing to be missing from a list.
    const menu = sections[0] as TreeNodeModel;
    const about = provider.getChildren(menu).map((node) => provider.getTreeItem(node)).at(-1);
    expect(about?.label).toBe('About');
    expect(about?.command).toStrictEqual({ command: 'agentDeck.about', title: 'About' });

    // A ticked row carries an ICON, never a changed label.
    const view = sections[1] as TreeNodeModel;
    const sortGroup = provider
      .getChildren(view)
      .find((node) => provider.getTreeItem(node).label === 'Sort') as TreeNodeModel;
    const sortItems = provider.getChildren(sortGroup).map((node) => provider.getTreeItem(node));
    const iconOf = (item: { iconPath?: unknown }): string =>
      (item.iconPath as { id?: string } | undefined)?.id ?? '';
    expect(sortItems.map((item) => `${String(item.label)}:${iconOf(item)}`)).toStrictEqual([
      'Live first:',
      'Recent:check',
      'Engine:',
    ]);

    // A checkbox row carries a state AND no command: the editor fires
    // `onDidChangeCheckboxState` for the box, and a command beside it would
    // write the setting twice, in opposite directions.
    const tweaks = sections[2] as TreeNodeModel;
    const follow = provider.getTreeItem(provider.getChildren(tweaks)[0] as TreeNodeModel);
    expect(follow.checkboxState).toBe(1);
    expect(follow.command).toBeUndefined();
  });

  it('a section is EXPANDED and a choice group is COLLAPSED', () => {
    const provider = new AgentDeckTreeProvider(deps());
    const sections = provider.getChildren();
    expect(provider.getTreeItem(sections[1] as TreeNodeModel).collapsibleState).toBe(2);
    const group = provider.getChildren(sections[1] as TreeNodeModel)[0] as TreeNodeModel;
    expect(provider.getTreeItem(group).collapsibleState).toBe(1);
    // A leaf is neither.
    const leaf = provider.getChildren(group)[0] as TreeNodeModel;
    expect(provider.getTreeItem(leaf).collapsibleState).toBe(0);
  });

  it('`refresh` re-reads the state rather than replaying the first build', () => {
    // The tick has to follow a value that moved AFTER the provider was made,
    // which is every value: a provider that cached its first answer would
    // show the state the window opened in, for ever.
    let controls: ViewControls = { ...DEFAULT_VIEW_CONTROLS };
    const provider = new AgentDeckTreeProvider({
      controls: () => controls,
      tweakValue: () => undefined,
      insights: () => ({ counts: 'none', example: exampleAt(0), installed: false, sessions: 0 }),
    });
    const sortLabels = (): string[] => {
      const view = provider.getChildren()[1] as TreeNodeModel;
      const group = provider
        .getChildren(view)
        .find((node) => node.label === 'Sort') as TreeNodeModel;
      return provider
        .getChildren(group)
        .map((node) => `${node.label}:${node.ticked === true ? 'tick' : ''}`);
    };
    expect(sortLabels()).toStrictEqual(['Live first:tick', 'Recent:', 'Engine:']);

    controls = { ...controls, deckSort: 'engine' };
    provider.refresh();
    expect(sortLabels()).toStrictEqual(['Live first:', 'Recent:', 'Engine:tick']);

    provider.dispose();
  });

  it('fires its change event on refresh, so the editor re-reads', () => {
    const provider = new AgentDeckTreeProvider(deps());
    let fired = 0;
    provider.onDidChangeTreeData(() => {
      fired += 1;
    });
    provider.refresh();
    expect(fired).toBe(1);
    provider.refresh();
    expect(fired).toBe(2);
    provider.dispose();
  });
});
