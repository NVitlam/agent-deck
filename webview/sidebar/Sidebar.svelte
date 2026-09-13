<!--
  The activity-bar sidebar — v0.8.0 Phase 7, DoD 7.6.

  TWO TABS, and that is the whole of this component: `Menu` (v0.7.0's five
  commands, untouched) and `Tweaks` (the four settings). The DoD asks for a
  tab, not a sixth menu entry, and the entries are pinned elsewhere by count
  and by order — `manifest.test.ts` and `readme.test.ts` both read that list —
  so the list this file passes down is `SIDEBAR_MENU` unchanged.

  WHICH TAB IS SHOWING IS THE ONE PIECE OF STATE HERE, and it is not the state
  DoD 7.6 forbids. That rule is about the four SETTINGS: the panel stores no
  value of theirs, because `settings.json` holds them. Which tab a person is
  looking at is view state of exactly the kind `viewMode` already is in
  `store.ts` — no setting, no host message, no storage, gone when the view is
  disposed (G7).

  Only the active tab's panel is MOUNTED. A hidden panel that kept a component
  alive would be a second place a value could persist across a tab switch; a
  panel that is rebuilt from the source every time it is shown cannot.
-->
<script lang="ts">
  import Menu from './Menu.svelte';
  import Tweaks from './Tweaks.svelte';
  import type { SidebarMenuEntry } from '../../src/sidebar/menu.js';
  import { TESTID } from '../canvas-contract.js';
  import type { TweaksSource } from './tweaks-source.js';

  let {
    entries,
    onrun,
    source,
  }: {
    entries: readonly SidebarMenuEntry[];
    onrun: (command: string) => void;
    source: TweaksSource;
  } = $props();

  type TabId = 'menu' | 'tweaks';

  /** The tabs, in the order they render. The menu is the front door. */
  const TABS: readonly { id: TabId; label: string }[] = [
    { id: 'menu', label: 'Menu' },
    { id: 'tweaks', label: 'Tweaks' },
  ];

  let active = $state.raw<TabId>('menu');
</script>

<div class="sidebar">
  <div
    class="tabs"
    role="tablist"
    data-testid={TESTID.sidebarTablist}
    aria-label="Sidebar sections"
  >
    {#each TABS as tab (tab.id)}
      <button
        type="button"
        role="tab"
        class="tab"
        id={`sidebar-tab-${tab.id}`}
        data-testid={TESTID.sidebarTab}
        data-tab={tab.id}
        data-active={String(active === tab.id)}
        aria-selected={active === tab.id}
        aria-controls={`sidebar-panel-${tab.id}`}
        tabindex={active === tab.id ? 0 : -1}
        onclick={() => (active = tab.id)}>{tab.label}</button
      >
    {/each}
  </div>

  {#if active === 'menu'}
    <div
      role="tabpanel"
      id="sidebar-panel-menu"
      aria-labelledby="sidebar-tab-menu"
      data-testid={TESTID.sidebarPanel}
      data-tab="menu"
    >
      <Menu {entries} {onrun} />
    </div>
  {:else}
    <div
      role="tabpanel"
      id="sidebar-panel-tweaks"
      aria-labelledby="sidebar-tab-tweaks"
      data-testid={TESTID.sidebarPanel}
      data-tab="tweaks"
    >
      <Tweaks {source} />
    </div>
  {/if}
</div>

<style>
  .sidebar {
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
  }

  .tabs {
    display: flex;
    gap: 2px;
    padding: 4px 8px 0;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }

  .tab {
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    border-bottom: 1px solid transparent;
    padding: 4px 8px;
    cursor: pointer;
    opacity: 0.75;
  }

  .tab[data-active='true'] {
    opacity: 1;
    border-bottom-color: var(--vscode-panelTitle-activeBorder, currentColor);
  }

  .tab:hover {
    background: var(--vscode-list-hoverBackground, transparent);
  }

  .tab:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
    outline-offset: -1px;
  }
</style>
