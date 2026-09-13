<!--
  Tools — F2, and the first surface it has ever had.

  v0.8.0 Phase 7, DoD 7.5. `toolName`, `class`, `calls`, `errors`,
  `durationMsSum` and `durationMsMax` have been derived, validated, stored and
  carried on the extension API since v0.7.0; `record.tools` had no reader in
  this directory at all, so the DoD's two duration columns had no table to sit
  in. This is that table. Draws `layout.ts:toolsLayout` and derives nothing.

  EVERY OPTIONAL COLUMN IS THE EM DASH WHEN ABSENT, and absent is common rather
  than exotic: Codex states no structured tool status and no per-call duration,
  so a Codex-only session's rows carry three em dashes and that is the correct
  render, not a gap to be filled. `ToolRow`'s header states the aggregation rule
  a mixed row follows.
-->
<script lang="ts">
  import { EM_DASH } from '../format.js';
  import { TESTID } from '../canvas-contract.js';
  import type { ToolsLayout } from './layout.js';
  import { formatSpan } from './text.js';

  let { tools }: { tools: ToolsLayout } = $props();
</script>

{#if tools.rows.length === 0}
  <p class="empty" data-testid={TESTID.statsEmpty} data-view="tools">No tool call in the sessions shown.</p>
{:else}
  <table class="grid" aria-label="Tools">
    <thead>
      <tr>
        <th class="name">tool</th>
        <th>class</th>
        <th class="num">calls</th>
        <th class="num">errors</th>
        <th class="num">longest call</th>
        <th class="num">total duration</th>
        <th class="num">sessions</th>
      </tr>
    </thead>
    <tbody>
      {#each tools.rows as row (row.toolName)}
        <tr
          data-testid={TESTID.statsToolRow}
          data-tool={row.toolName}
          data-class={row.class}
          data-calls={String(row.calls)}
          data-duration={String(row.durationMsSum !== undefined)}
        >
          <td class="name">
            <span class="primary" data-testid={TESTID.statsToolCell} data-column="tool">{row.toolName}</span>
          </td>
          <td><span data-testid={TESTID.statsToolCell} data-column="class">{row.class}</span></td>
          <td class="num"><span data-testid={TESTID.statsToolCell} data-column="calls">{row.calls}</span></td>
          <td class="num" data-errors={String(row.errors ?? EM_DASH)}
            ><span data-testid={TESTID.statsToolCell} data-column="errors">{row.errors ?? EM_DASH}</span></td
          >
          <td class="num"
            ><span data-testid={TESTID.statsToolCell} data-column="durationMsMax"
              >{formatSpan(row.durationMsMax)}</span
            ></td
          >
          <td class="num"
            ><span data-testid={TESTID.statsToolCell} data-column="durationMsSum"
              >{formatSpan(row.durationMsSum)}</span
            ></td
          >
          <td class="num"><span data-testid={TESTID.statsToolCell} data-column="sessions">{row.sessions}</span></td>
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

  /* An errored count is coloured; an ABSENT one is not. `data-errors` carries
     the em dash itself when the column is absent, so the selector below cannot
     match it and an engine that states no status is never painted as clean. */
  td.num[data-errors]:not([data-errors='0']):not([data-errors='—']) {
    color: var(--err);
  }

  .primary {
    font-weight: 600;
  }

  .empty {
    margin: 0;
    padding: 12px;
    color: var(--ink-2);
  }
</style>
