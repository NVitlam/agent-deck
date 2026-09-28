<!--
  The activity-bar sidebar — v0.9.0 DoD 9.17, spec `Amendment 2026-09-20 —
  Sidebar shape (supersedes the TreeView ruling)`.

  A HORIZONTAL STRIP AND ONE PAGE. Menu | View | Tweaks, one open at a time.
  The native `TreeView` that shipped in the morning put every section on
  screen at once with no room for an explanation under anything; this is the
  shape the user drew instead. (The strip had a fourth tab, Insights, until
  v0.9.0 DoD 9.28 — spec `Amendment 2026-09-21 — One window` made Insights a
  surface of the panel, opened from Menu.)

  ONLY THE OPEN PAGE IS BUILT. A hidden page that stayed mounted would be a
  second place a value could persist across a page switch; a page rebuilt
  from the state every time it is shown cannot.

  THE SIDEBAR IS THE ONE WEBVIEW THAT CARRIES CONTROLS, and that is the
  amendment's own exception rather than a hole in it: the deck, the session
  interior, the drawer and the Statistics window stay content only (plus the
  Stats tab strip, ruled back in), and everything that was a chip or a bar on
  one of them is a row here.
-->
<script lang="ts">
  import type { ControlSection } from '../../src/view/controls.js';
  import { CONTROL_SECTIONS, DEFAULT_SECTION } from '../../src/view/controls.js';
  import { sidebarPage } from './model.js';
  import type { SidebarSource } from './source.js';
  import Rows from './Rows.svelte';

  /*
   * A SOURCE, not a state prop, and the reason is mechanical: `mount()`
   * takes props once, and this surface has to answer a message that arrives
   * at any time. `App.svelte` has the same shape against `store.ts`.
   *
   * It is also why nothing here is called `state`: a local binding of that
   * name makes the compiler read `$state` as an auto-subscription to a store
   * called `state` rather than as the rune, and the mount dies with
   * `store.subscribe is not a function`. Measured, not guessed.
   */
  let { source }: { source: SidebarSource } = $props();

  // `$state.raw`, for the reason `App.svelte` gives: the value is replaced
  // whole and a deep proxy over it would buy nothing.
  let model = $state.raw(source.get());

  $effect(() => {
    model = source.get();
    return source.subscribe(() => {
      model = source.get();
    });
  });

  let page = $state.raw<ControlSection>(DEFAULT_SECTION);

  /**
   * The expanded groups.
   *
   * A `Set` held in a `$state.raw` box and REPLACED rather than mutated:
   * Svelte 5 tracks the assignment, and a mutated set would move without
   * anything re-reading it. Empty at first, which is the mock's "each
   * collapsed by default, showing its current value as a grey suffix".
   */
  let open = $state.raw<ReadonlySet<string>>(new Set());

  let rows = $derived(sidebarPage(page, model));

  const toggle = (groupId: string): void => {
    const next = new Set(open);
    if (!next.delete(groupId)) next.add(groupId);
    open = next;
  };

  /**
   * Run a command and, when it came from inside a group, shut the group.
   *
   * The mock's "collapsing back after a choice": a person opens Sort, picks
   * Recent, and the group folds up again showing `Recent`. Without it the
   * sidebar grows every time it is used and the strip's whole reason —
   * a short page — is lost by the third click.
   *
   * `inGroup` is `undefined` for a row that sits directly on a page (Menu's
   * seven, Reset view), and nothing collapses for those.
   */
  const run = (command: string, inGroup: string | undefined): void => {
    source.run(command);
    if (inGroup === undefined) return;
    const next = new Set(open);
    next.delete(inGroup);
    open = next;
  };
</script>

<div class="sidebar" data-testid="sidebar">
  <nav class="strip" data-testid="sidebar-strip" role="tablist" aria-label="Agent Deck sections">
    {#each CONTROL_SECTIONS as section (section.id)}
      <button
        type="button"
        role="tab"
        class="tab"
        data-testid="sidebar-tab"
        data-tab={section.id}
        data-active={String(page === section.id)}
        aria-selected={page === section.id}
        aria-controls="sidebar-page"
        tabindex={page === section.id ? 0 : -1}
        onclick={() => (page = section.id)}>{section.label}</button
      >
    {/each}
  </nav>

  <div
    id="sidebar-page"
    role="tabpanel"
    class="page"
    data-testid="sidebar-page"
    data-section={page}
  >
    <Rows {rows} {open} onrun={run} ontoggle={toggle} />
  </div>
</div>

<style>
  .sidebar {
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    padding-bottom: 6px;
  }

  .strip {
    display: flex;
    gap: 2px;
    padding: 4px 8px 0;
    margin-bottom: 4px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }

  .tab {
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
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
