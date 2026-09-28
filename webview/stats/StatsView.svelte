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
  import { TESTID } from '../canvas-contract.js';
  import { CONTROL_COMMANDS } from '../../src/view/controls.js';
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

  /**
   * The five tabs, DERIVED FROM THE ONE TABLE — v0.9.0 DoD 9.20.
   *
   * v0.9.0 wrote the ids and labels out here as well as in
   * `src/view/controls.ts`, which is two agreeing literals for the same five
   * strings. They are read out of `CONTROL_COMMANDS` now, so the tab a person
   * clicks, the command it runs, the id the host stores and the words on both
   * are one fact with one definition.
   */
  const TABS: readonly { id: Tab; label: string; command: string }[] = CONTROL_COMMANDS.flatMap(
    (entry) =>
      entry.section === 'window' && entry.sets?.field === 'statsTab'
        ? [{ id: entry.sets.value as Tab, label: entry.label, command: entry.command }]
        : [],
  );
  /*
   * WHICH TAB IS SHOWING IS THE HOST'S, and it stays the host's.
   *
   * v0.9.0 DoD 9.14 removed the strip and left the value on `viewControls`;
   * `Amendment 2026-09-20 — Sidebar shape` rules the strip back INTO this
   * window as a third clickable exception, and Menu ▸ Open Statistics always
   * lands on Files. Both are only coherent while the host owns the value: a
   * tab press RUNS A COMMAND and this surface re-reads what came back, so
   * the strip and the sidebar cannot hold different answers.
   */
  let tab = $derived<Tab>(view.statsTab);

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

  let excludedText = $derived.by(() => {
    const { count, byCode } = layout.excluded;
    const { timeAbsent } = trends;
    // v0.8.0 DoD 7.14: history with no time facts is shown everywhere except the
    // F14 series, and the footer names it — a missing point is said, not implied.
    const time = timeAbsent === 0 ? '' : `; stored history F14:absent ${String(timeAbsent)}, not in tokens per minute`;
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
  <!--
    THE TAB STRIP, RULED BACK IN — v0.9.0 DoD 9.20.

    `Amendment 2026-09-20 — Sidebar shape` keeps the Statistics window's five
    tabs inside the window, a third exception beside selecting a content item
    and the degraded dismiss. `webview/chrome.test.ts` carries it as an
    explicit, reasoned entry rather than as a hole in the walk.

    THE ENGINE CHIPS DO NOT COME BACK. Ruling 6 gives the engine filter one
    entry in View ▸ Engines, acting on whichever surface is active, and
    `view.engineFilter` still narrows every table here.
  -->
  <nav class="tabs" role="tablist" aria-label="Statistics tables">
    {#each TABS as entry (entry.id)}
      <button
        type="button"
        role="tab"
        class="seg"
        data-testid="stats-tab"
        data-tab={entry.id}
        data-active={String(entry.id === tab)}
        aria-selected={entry.id === tab}
        onclick={() => store.runCommand(entry.command)}>{entry.label}</button
      >
    {/each}
  </nav>

  <div class="body">
    {#if tab === 'files'}
      <Files files={layout.files} />
    {:else if tab === 'tools'}
      <Tools tools={layout.tools} />
    {:else if tab === 'loops'}
      <Loops loops={layout.loops} {liveLabels} onordinal={follow} />
    {:else if tab === 'tokens'}
      <Tokens tokens={layout.tokens} {liveLabels} focusSessionId={view.statsFocusSessionId} />
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

  /*
   * The bar's chip/group/count rules stay removed (v0.9.0 DoD 9.14); the tab
   * strip's two come back with the strip (DoD 9.20).
   */
  .tabs {
    display: flex;
    gap: 2px;
    flex: none;
    padding: 4px 12px 0;
    border-bottom: 1px solid var(--line);
  }

  .seg {
    font: inherit;
    color: var(--ink-2);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 4px 10px;
    cursor: pointer;
  }

  .seg[data-active='true'] {
    color: var(--ink);
    border-bottom-color: var(--focus);
  }

  .seg:hover {
    background: var(--press);
  }

  .seg:focus-visible {
    outline: 1px solid var(--focus);
    outline-offset: -1px;
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
