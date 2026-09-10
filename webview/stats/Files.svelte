<!--
  Files — spec §G view 1. Sorted by total touches; read/edit/write/error per
  row; rows flagged when in a loop or churn chain; basename primary, full path
  on hover (labels law, DoD 4.5). Draws `layout.ts:filesLayout` and derives
  nothing.
-->
<script lang="ts">
  import { TESTID } from '../canvas-contract.js';
  import type { FilesLayout } from './layout.js';
  import { VOCABULARY } from './layout.js';

  let { files }: { files: FilesLayout } = $props();
</script>

{#if files.rows.length === 0}
  <p class="empty" data-testid={TESTID.statsEmpty} data-view="files">No file calls in the sessions shown.</p>
{:else}
  <table class="grid" aria-label="Files">
    <thead>
      <tr>
        <th class="name">file</th>
        <th class="num">reads</th>
        <th class="num">edits</th>
        <th class="num">writes</th>
        <th class="num">errors</th>
        <th class="num">sessions</th>
        <th class="flags">flags</th>
      </tr>
    </thead>
    <tbody>
      {#each files.rows as row (row.filePath)}
        <tr
          data-testid={TESTID.statsFileRow}
          data-path={row.filePath}
          data-touches={String(row.touches)}
          data-loop={String(row.loop)}
          data-churn={String(row.churn)}
        >
          <td class="name">
            <span class="primary" data-testid={TESTID.statsFileName} title={row.filePath}>{row.basename}</span>
          </td>
          <td class="num">{row.reads}</td>
          <td class="num">{row.edits}</td>
          <td class="num">{row.writes}</td>
          <td class="num" data-errors={String(row.errors)}>{row.errors}</td>
          <td class="num">{row.sessions}</td>
          <td class="flags">
            {#if row.loop}<span class="flag">{VOCABULARY.rereadLoop}</span>{/if}
            {#if row.churn}<span class="flag">{VOCABULARY.churn}</span>{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .grid {
    width: 100%;
    border-collapse: collapse;
    font-size: 11.5px;
  }

  th {
    text-align: left;
    font-family: var(--mono);
    font-weight: 600;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-3);
    padding: 4px 8px;
    border-bottom: 1px solid var(--line-soft);
  }

  td {
    padding: 3px 8px;
    border-bottom: 1px solid var(--line-soft);
    vertical-align: baseline;
  }

  .num {
    text-align: right;
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
  }

  td.num[data-errors]:not([data-errors='0']) {
    color: var(--err);
  }

  .primary {
    font-weight: 600;
  }

  .flags {
    white-space: nowrap;
  }

  .flag {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--ink-2);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 1px 7px;
    margin-right: 4px;
  }

  .empty {
    margin: 0;
    padding: 12px;
    color: var(--ink-2);
  }
</style>
