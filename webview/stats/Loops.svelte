<!--
  Loops & churn — spec §G view 2. A list; expanding a row shows the ordinals in
  the chain, each a link that fires the existing select intent on that tool
  node (DoD 4.4). Draws `layout.ts:loopsLayout` and derives nothing.
-->
<script lang="ts">
  import { EM_DASH } from '../format.js';
  import { TESTID } from '../canvas-contract.js';
  import type { LoopsLayout, SessionRef } from './layout.js';
  import { sessionPrimary, shortId } from './text.js';

  let {
    loops,
    liveLabels,
    onordinal,
  }: {
    loops: LoopsLayout;
    liveLabels: ReadonlyMap<string, string>;
    /**
     * Link-back. Returns whether the ordinal resolved to a live tool node —
     * a stored record's session may be gone, and the row says so rather
     * than pretending the click did something.
     */
    onordinal: (session: SessionRef, agentId: string, ordinal: number) => boolean;
  } = $props();

  /** Which rows are expanded. Local state: nothing walks it (G7 rule as §1.1). */
  let expanded = $state<Set<string>>(new Set());
  /** Ordinals whose link-back found no live node, by row key. */
  let unresolved = $state<Set<string>>(new Set());

  function toggle(key: string): void {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  }

  function follow(row: { key: string; session: SessionRef; agentId: string }, ordinal: number): void {
    const ok = onordinal(row.session, row.agentId, ordinal);
    const next = new Set(unresolved);
    if (ok) next.delete(row.key);
    else next.add(row.key);
    unresolved = next;
  }
</script>

{#if loops.rows.length === 0}
  <p class="empty" data-testid={TESTID.statsEmpty} data-view="loops">No loop and no churn chain in the sessions shown.</p>
{:else}
  <ul class="chains" aria-label="Loops and churn chains">
    {#each loops.rows as row (row.key)}
      <li
        class="chain"
        data-testid={TESTID.statsChainRow}
        data-kind={row.kind}
        data-session={row.session.sessionId}
        data-agent={row.agentId}
        data-expanded={String(expanded.has(row.key))}
        data-unresolved={String(unresolved.has(row.key))}
      >
        <button type="button" class="head" onclick={() => toggle(row.key)} aria-expanded={expanded.has(row.key)}>
          <span class="term">{row.term}</span>
          <span class="primary" title={row.filePath ?? row.toolName ?? ''}
            >{row.kind === 'loop' ? row.toolName : (row.basename ?? EM_DASH)}</span
          >
          {#if row.kind === 'loop' && row.basename !== undefined}
            <span class="secondary" title={row.filePath}>{row.basename}</span>
          {/if}
          <span class="count"
            >{row.kind === 'loop'
              ? `${String(row.count)} identical calls`
              : `${String(row.count)} errored between two writes`}</span
          >
          <span class="session" title={row.session.sessionId}
            >{sessionPrimary(row.session, liveLabels)} · {shortId(row.session.sessionId)} · {row.agentId}</span
          >
        </button>
        {#if expanded.has(row.key)}
          <div class="ordinals" role="group" aria-label="Calls in the chain">
            {#each row.ordinals as ordinal (ordinal)}
              <button
                type="button"
                class="ordinal"
                data-testid={TESTID.statsChainOrdinal}
                data-ordinal={String(ordinal)}
                data-agent={row.agentId}
                data-session={row.session.sessionId}
                onclick={() => follow(row, ordinal)}>#{ordinal}</button
              >
            {/each}
            {#if unresolved.has(row.key)}
              <span class="note">this session is not on the deck now, so the call cannot be opened</span>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .chains {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .chain {
    border-bottom: 1px solid var(--line-soft);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    font: inherit;
    font-size: 11.5px;
    color: var(--ink);
    background: none;
    border: none;
    padding: 5px 12px;
    text-align: left;
    cursor: pointer;
  }

  .head:hover {
    background: var(--press);
  }

  .term {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-3);
    min-width: 12ch;
  }

  .primary {
    font-weight: 600;
  }

  .secondary,
  .session {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-3);
  }

  .session {
    margin-left: auto;
    white-space: nowrap;
  }

  .count {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-2);
  }

  .ordinals {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 2px 12px 8px 40px;
  }

  .ordinal {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 1px 6px;
    cursor: pointer;
  }

  .ordinal:hover {
    border-color: var(--ink-3);
  }

  .note {
    font-size: 10.5px;
    color: var(--ink-3);
    align-self: center;
  }

  .empty {
    margin: 0;
    padding: 12px;
    color: var(--ink-2);
  }
</style>
