<!--
  The Stats view mode — spec §G, Component 9 (v0.7.0 Phase 4).

  The third entry in the view-mode switch: the Layer 1 facts, rendered from
  `StatsRecord[]` and never from a session tree. Five views under one tab row
  — Files · Tools · Loops & churn · Tokens · Trends — every one drawn from the pure
  `layout.ts` over the records the host put on the wire. The engine chips
  narrow every view exactly as they narrow the deck (DoD 4.6): the SAME store
  state, `engineFilter`, so a chip pressed here is pressed on the deck too.

  Excluded sessions appear as a footer count with reason codes, never in a
  table (spec §G). The measurement parameters (`LOOP_MIN`, `SPIKE_TOKENS`) are
  shown as parameters, not judgments (G10).

  G10 applies to every string in this directory: `scripts/forbidden-words.mjs`
  scans the markup as well as the script.
-->
<script lang="ts">
  import type { Store, WebviewView } from '../store.js';
  import { ENGINE_FILTERS, TESTID } from '../canvas-contract.js';
  import type { EngineFilter } from '../canvas-contract.js';
  import { deckEngine } from '../layout.js';
  import type { StatsRecord } from '../../src/stats/schema.js';
  import type { SessionRef } from './layout.js';
  import { statsLayout, trendsLayout } from './layout.js';
  import Files from './Files.svelte';
  import Loops from './Loops.svelte';
  import Tokens from './Tokens.svelte';
  import Tools from './Tools.svelte';
  import Trends from './Trends.svelte';

  let { store, view }: { store: Store; view: WebviewView } = $props();

  /**
   * FIVE tabs as of v0.8.0 Phase 7 (DoD 7.5). `tools` sits second, next to
   * Files: both are aggregates over every session shown, keyed on a name the
   * engine wrote, while Tokens and Trends are per session and over time.
   */
  type Tab = 'files' | 'tools' | 'loops' | 'tokens' | 'trends';
  const TABS: readonly { id: Tab; label: string }[] = [
    { id: 'files', label: 'Files' },
    { id: 'tools', label: 'Tools' },
    { id: 'loops', label: 'Loops & churn' },
    { id: 'tokens', label: 'Tokens' },
    { id: 'trends', label: 'Trends' },
  ];
  /** Local: nothing walks it, and §1.1's reset-on-close rule fits it. */
  let tab = $state<Tab>('files');

  const ENGINE_LABELS: Readonly<Record<EngineFilter, string>> = {
    all: 'All',
    cc: 'Claude Code',
    oc: 'OpenCode',
    cx: 'Codex',
  };

  /** The deck's rule, restated once: `all` admits everything. */
  function admits(record: StatsRecord): boolean {
    return view.engineFilter === 'all' || deckEngine(record.engine) === view.engineFilter;
  }

  let live = $derived(view.statsLive.filter(admits));
  let stored = $derived(view.statsStored.filter(admits));

  /** Files, Loops and Tokens read the LIVE records; Trends reads the STORE. */
  let layout = $derived(statsLayout(live, view.statsStoreEnabled));
  let trends = $derived(trendsLayout(stored, view.statsStoreEnabled, view.statsStoreLoaded));

  /** Session labels the deck already carries, for the primary slot (DoD 4.5). */
  let liveLabels = $derived(new Map(view.sessions.map((s) => [s.sessionId, s.label])));

  /** Per-chip counts over the live records, unfiltered — the deck's own rule. */
  let counts = $derived.by(() => {
    const out: Record<EngineFilter, number> = { all: view.statsLive.length, cc: 0, oc: 0, cx: 0 };
    for (const record of view.statsLive) out[deckEngine(record.engine)] += 1;
    return out;
  });

  let excludedText = $derived.by(() => {
    const { count, byCode } = layout.excluded;
    const { timeAbsent } = trends;
    // v0.8.0 DoD 7.14: history with no time facts is shown everywhere except the
    // F14 series, and the footer names it — a missing point is said, not implied.
    const time = timeAbsent === 0 ? '' : `; F14:absent ${String(timeAbsent)}, not in tokens per minute`;
    if (count === 0) return `no session excluded${time}`;
    const parts = Object.entries(byCode).map(([code, n]) => `${code} ${String(n)}`);
    return `${String(count)} session${count === 1 ? '' : 's'} excluded: ${parts.join(', ')}${time}`;
  });

  function follow(session: SessionRef, agentId: string, ordinal: number): boolean {
    return store.selectToolByOrdinal(session.sessionId, agentId, ordinal);
  }
</script>

<section
  class="stats"
  data-testid={TESTID.statsView}
  data-view={tab}
  data-engine-filter={view.engineFilter}
  data-live={String(view.statsLive.length)}
  data-stored={String(view.statsStored.length)}
  aria-label="Statistics"
>
  <div class="bar">
    <div class="group" role="group" aria-label="Filter by engine">
      {#each ENGINE_FILTERS as filter (filter)}
        <button
          type="button"
          class="chip"
          data-testid={TESTID.statsEngineChip}
          data-engine={filter}
          data-active={String(view.engineFilter === filter)}
          data-count={String(counts[filter])}
          aria-pressed={view.engineFilter === filter}
          onclick={() => store.setEngineFilter(filter)}
          >{ENGINE_LABELS[filter]}<span class="count">{counts[filter]}</span></button
        >
      {/each}
    </div>
    <div class="group tabs" role="tablist" aria-label="Statistics views">
      {#each TABS as entry (entry.id)}
        <button
          type="button"
          role="tab"
          class="seg"
          data-testid={TESTID.statsTab}
          data-view={entry.id}
          data-active={String(tab === entry.id)}
          aria-selected={tab === entry.id}
          onclick={() => (tab = entry.id)}>{entry.label}</button
        >
      {/each}
    </div>
  </div>

  <div class="body">
    {#if tab === 'files'}
      <Files files={layout.files} />
    {:else if tab === 'tools'}
      <Tools tools={layout.tools} />
    {:else if tab === 'loops'}
      <Loops loops={layout.loops} {liveLabels} onordinal={follow} />
    {:else if tab === 'tokens'}
      <Tokens tokens={layout.tokens} {liveLabels} />
    {:else}
      <Trends {trends} {liveLabels} />
    {/if}
  </div>

  <footer class="foot">
    <span data-testid={TESTID.statsFooter} data-excluded={String(layout.excluded.count)}>{excludedText}</span>
    <span class="spacer"></span>
    <span data-testid={TESTID.statsParams} class="params">
      {#if layout.params.loopMin !== undefined}
        LOOP_MIN = {layout.params.loopMin}
        {#if layout.params.spikeTokens !== undefined}
          · SPIKE_TOKENS = {layout.params.spikeTokens}
        {/if}
      {:else}
        no record yet
      {/if}
    </span>
  </footer>
</section>

<style>
  /* §8's token ladder, scoped here as `Inspector.svelte` scopes it. */
  .stats {
    --bg: var(--vscode-editor-background, #1b1d21);
    --panel: var(--vscode-sideBar-background, #202327);
    --line: var(--vscode-panel-border, #33373d);
    --line-soft: var(--vscode-panel-border, #2a2d32);
    --line-soft: color-mix(in srgb, var(--line) 45%, var(--panel));
    --ink: var(--vscode-foreground, #dcdee2);
    --ink-2: var(--vscode-descriptionForeground, #9aa0a8);
    --ink-3: var(--vscode-disabledForeground, #6b6f77);
    --press: var(--vscode-list-hoverBackground, #2e3238);
    --amber-text: var(--vscode-charts-yellow, #f2a93b);
    --amber-line: rgba(242, 169, 59, 0.55);
    --err: var(--vscode-editorError-foreground, #e07a6a);
    --focus: var(--vscode-focusBorder, #5b9dd9);
    --mono: var(--vscode-editor-font-family, ui-monospace, "Cascadia Code", Menlo, Consolas, monospace);

    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    color: var(--ink);
    background: var(--bg);
    user-select: text;
    -webkit-user-select: text;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    padding: 4px 12px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }

  .group {
    display: flex;
    gap: 4px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: inherit;
    font-size: 11px;
    color: var(--ink-2);
    background: none;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 2px 9px;
    cursor: pointer;
  }

  .chip[data-active='true'] {
    background: var(--press);
    border-color: var(--ink-3);
    color: var(--ink);
  }

  .count {
    font-family: var(--mono);
    font-weight: 600;
    font-size: 10px;
    min-width: 16px;
    text-align: center;
    border-radius: 999px;
    background: var(--line-soft);
  }

  .tabs {
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
    gap: 0;
  }

  .seg {
    font: inherit;
    font-size: 11px;
    color: var(--ink-2);
    background: none;
    border: none;
    border-right: 1px solid var(--line-soft);
    padding: 3px 10px;
    cursor: pointer;
  }

  .seg:last-child {
    border-right: none;
  }

  .seg[data-active='true'] {
    background: var(--press);
    color: var(--ink);
  }

  .chip:focus-visible,
  .seg:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }

  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  .foot {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 4px 12px;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-3);
    border-top: 1px solid var(--line);
    background: var(--panel);
  }

  .spacer {
    flex: 1 1 auto;
  }

  .params {
    white-space: nowrap;
  }
</style>
