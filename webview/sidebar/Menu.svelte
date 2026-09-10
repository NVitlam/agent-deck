<!--
  The activity-bar sidebar's menu — v0.7.0 Phase 4, DoD 4.6b (spec §G2).

  A LIST OF COMMANDS, and nothing else. The entries come from
  `src/sidebar/menu.ts` (data, read by the host too) and each click posts one
  `runCommand` message; the host's controller validates the id against the
  same list and runs it. The sidebar holds no session data, reads no store,
  and reaches no network: it is the front door, and the panel is the room.

  The same bundle the panel loads mounts this component when the host's
  document carries the sidebar root — see `webview/main.ts`.
-->
<script lang="ts">
  import type { SidebarMenuEntry } from '../../src/sidebar/menu.js';
  import { TESTID } from '../canvas-contract.js';

  let {
    entries,
    onrun,
  }: {
    entries: readonly SidebarMenuEntry[];
    onrun: (command: string) => void;
  } = $props();
</script>

<nav class="menu" data-testid={TESTID.sidebarMenu} aria-label="Agent Deck">
  <ul>
    {#each entries as entry (entry.command)}
      <li>
        <button
          type="button"
          class="entry"
          data-testid={TESTID.sidebarEntry}
          data-command={entry.command}
          onclick={() => onrun(entry.command)}>{entry.label}</button
        >
      </li>
    {/each}
  </ul>
</nav>

<style>
  .menu {
    padding: 6px 0;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .entry {
    display: block;
    width: 100%;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    text-align: left;
    padding: 5px 20px;
    cursor: pointer;
  }

  .entry:hover {
    background: var(--vscode-list-hoverBackground, transparent);
  }

  .entry:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
    outline-offset: -1px;
  }
</style>
