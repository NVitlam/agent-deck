<!--
  One level of the sidebar's rows — v0.9.0 DoD 9.17.

  RECURSIVE, because a group can hold a group: View ▸ Inspector holds Status
  and Order. One level is all the table declares, but a component that can
  only draw one level would have to be edited the day a second appears, and
  recursion costs nothing here.

  IT DECIDES NOTHING. Every label, order, tick, checkbox and grey value comes
  from `model.ts`, which is a pure function of the state the host sent. What
  this file owns is which groups are expanded — view state, gone with the
  view — and the one behaviour the mock asks for that a row cannot express on
  its own: **a group collapses again as soon as a choice inside it is made.**
-->
<script lang="ts">
  import type { SidebarRow } from './model.js';
  import Rows from './Rows.svelte';

  let {
    rows,
    open,
    onrun,
    ontoggle,
    depth = 0,
    group = undefined,
  }: {
    rows: readonly SidebarRow[];
    /** The ids of the groups currently expanded. Owned by `Sidebar.svelte`. */
    open: ReadonlySet<string>;
    onrun: (command: string, inGroup: string | undefined) => void;
    ontoggle: (groupId: string) => void;
    depth?: number;
    /** The group these rows sit in, so a choice can collapse it. */
    group?: string | undefined;
  } = $props();

  /** 16px per level, matching the editor's own tree indentation. */
  const indent = (extra: number): string => `padding-left: ${String(16 * (depth + extra))}px`;
</script>

{#each rows as row (row.id)}
  {#if row.kind === 'group'}
    <div
      class="group"
      data-testid="sidebar-group"
      data-group={row.id}
      data-open={String(open.has(row.id))}
    >
      <button
        type="button"
        class="row head"
        data-testid="sidebar-group-head"
        data-group={row.id}
        aria-expanded={open.has(row.id)}
        style={indent(0)}
        onclick={() => ontoggle(row.id)}
      >
        <span class="tw" aria-hidden="true">{open.has(row.id) ? '⌄' : '›'}</span>
        <span class="lbl">{row.label}</span>
        {#if row.value !== undefined}
          <span class="val" data-testid="sidebar-value">{row.value}</span>
        {/if}
      </button>
      {#if open.has(row.id)}
        <Rows rows={row.children} {open} {onrun} {ontoggle} depth={depth + 1} group={row.id} />
      {/if}
    </div>
  {:else if row.kind === 'choice'}
    <button
      type="button"
      class="row"
      data-testid="sidebar-row"
      data-kind="choice"
      data-command={row.command}
      data-ticked={String(row.ticked)}
      aria-checked={row.ticked}
      role="menuitemradio"
      style={indent(0)}
      onclick={() => onrun(row.command, group)}
    >
      <span class="tick" aria-hidden="true">{row.ticked ? '✓' : ''}</span>
      <span class="lbl">{row.label}</span>
    </button>
  {:else if row.kind === 'toggle'}
    <button
      type="button"
      class="row"
      data-testid="sidebar-row"
      data-kind="toggle"
      data-command={row.command}
      data-checked={String(row.checked)}
      aria-checked={row.checked}
      role="menuitemcheckbox"
      style={indent(1)}
      onclick={() => onrun(row.command, group)}
    >
      <span class="chk" aria-hidden="true" data-checked={String(row.checked)}
        >{row.checked ? '✓' : ''}</span
      >
      <span class="lbl">{row.label}</span>
    </button>
    {#if row.detail !== undefined}
      <span class="desc" data-testid="sidebar-detail" data-for={row.command}>{row.detail}</span>
    {/if}
  {:else}
    <button
      type="button"
      class="row"
      data-testid="sidebar-row"
      data-kind="action"
      data-command={row.command}
      data-nested={row.nested === true ? 'true' : undefined}
      role="menuitem"
      style={indent(row.nested === true ? 2 : 1)}
      onclick={() => onrun(row.command, group)}
    >
      <span class="lbl">{row.label}</span>
      {#if row.value !== undefined}
        <span class="val" data-testid="sidebar-value">{row.value}</span>
      {/if}
    </button>
    {#if row.detail !== undefined}
      <span class="desc" data-testid="sidebar-detail" data-for={row.command}>{row.detail}</span>
    {/if}
  {/if}
{/each}

<style>
  .row {
    display: flex;
    align-items: center;
    width: 100%;
    height: 22px;
    padding-right: 8px;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }

  .row:hover {
    background: var(--vscode-list-hoverBackground, transparent);
  }

  .row:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
    outline-offset: -1px;
  }

  .tw,
  .tick {
    width: 16px;
    flex: none;
    text-align: center;
    opacity: 0.8;
  }

  .chk {
    width: 14px;
    height: 14px;
    margin-right: 6px;
    flex: none;
    display: inline-grid;
    place-items: center;
    font-size: 10px;
    border: 1px solid var(--vscode-checkbox-border, currentColor);
    border-radius: 3px;
  }

  .lbl {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .val {
    margin-left: 8px;
    opacity: 0.65;
  }

  .desc {
    display: block;
    opacity: 0.65;
    font-size: 0.9em;
    line-height: 1.35;
    padding: 0 8px 6px 38px;
    white-space: normal;
  }
</style>
