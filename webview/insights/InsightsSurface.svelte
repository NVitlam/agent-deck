<!--
  The Insights SURFACE — v0.9.0 DoD 9.29 and 9.30, spec `Amendment
  2026-09-21 — One window, Insights provider, Menu-only entry`.

  A surface of the ONE panel, switched in place from Menu ▸ Open Insights. Two
  states, decided by ONE fact the host states — whether an Insights provider is
  REGISTERED. Never whether one is installed, and never a licence.

  FREE (no provider): every static Layer 1 fact for the last 7 days the store
  holds, as tiles, each naming the field it was counted from; one rotating
  example, labelled as an example; and one tile, "Get Agent Deck Insights",
  that asks before it opens the page.

  PROVIDER: the latest finding set, the run history, and a Run action that
  calls the provider — rendered from the snapshot the host checked. A finding
  is its kind, its confidence and its numeric evidence; every word about it is
  the parent's own (`layout.ts` `FINDING_LABELS`), because no model prose
  crosses the boundary.

  IT DECIDES NOTHING. `layout.ts` computes every tile and row; this renders
  them. The clock is read here, once per render, because the window is "the
  last 7 days" of NOW and the layout is a pure function that takes it.
-->
<script lang="ts">
  import type { InsightsProviderSnapshot } from '../../src/model/events.js';
  import type { StatsRecord } from '../../src/stats/schema.js';
  import { TESTID } from '../canvas-contract.js';
  import {
    EXAMPLE_LABEL,
    INSIGHTS_WINDOW_DAYS,
    INSIGHT_SOURCES,
    exampleAt,
    formatInstant,
    freeInsightsLayout,
    providerInsightsLayout,
  } from './layout.js';

  let {
    records,
    loaded,
    enabled,
    provider,
    exampleCount,
    getHost,
    idleThresholdMs,
    now = () => Date.now(),
    onget,
    onrun,
  }: {
    /** The STORED history — "the facts the store already holds". */
    records: readonly StatsRecord[];
    /** Has the host read the store yet? Before it has, nothing is counted. */
    loaded: boolean;
    /** `agentDeck.stats.enabled`. A disabled store holds nothing to count. */
    enabled: boolean;
    provider: InsightsProviderSnapshot | null;
    exampleCount: number;
    /** The Get tile's host, from the page the host built; `null` before it. */
    getHost: string | null;
    /** `agentDeck.livenessThresholdMs`, from the host's settings (DoD 9.38). */
    idleThresholdMs: number;
    now?: () => number;
    onget: () => void;
    onrun: () => void;
  } = $props();

  let free = $derived(freeInsightsLayout(records, now(), idleThresholdMs));
  let example = $derived(exampleAt(exampleCount));
  let paid = $derived(provider === null ? null : providerInsightsLayout(provider));
</script>

<main
  class="insights"
  data-testid={TESTID.insightsSurface}
  data-state={provider === null ? 'free' : 'provider'}
>
  {#if paid === null}
    <section class="facts">
      <h1>Insights</h1>
      {#if !loaded}
        <p class="line" data-testid="insights-facts-state" data-reason="loading">
          The stored history has not been read yet.
        </p>
      {:else if !enabled}
        <p class="line" data-testid="insights-facts-state" data-reason="disabled">
          The stats store is off (agentDeck.stats.enabled), so no history is recorded.
        </p>
      {:else}
        <p class="line" data-testid="insights-facts-window">
          Last {INSIGHTS_WINDOW_DAYS} days, since {formatInstant(free.sinceMs)}: {free.counted}
          session{free.counted === 1 ? '' : 's'} recorded in full{free.excluded > 0
            ? `; ${String(free.excluded)} read in part, not counted`
            : ''}.
        </p>
        <div class="tiles">
          {#each free.tiles as tile (tile.id)}
            <div class="tile" data-testid={TESTID.insightsFact} data-fact={tile.id}>
              <span class="value" data-testid="insights-fact-value">{tile.value}</span>
              <span class="label">{tile.label}</span>
              {#if tile.note !== undefined}
                <span class="note" data-testid="insights-fact-note">{tile.note}</span>
              {/if}
              <span class="source">{INSIGHT_SOURCES[tile.id]}</span>
            </div>
          {/each}
        </div>
      {/if}
    </section>
    <section class="example" data-testid={TESTID.insightsExample} data-example={example.id}>
      <p class="example-label">{EXAMPLE_LABEL}</p>
      <h2>{example.title}</h2>
      {#each example.lines as line (line)}
        <p class="example-line">{line}</p>
      {/each}
    </section>
    <div class="tiles">
      <button
        type="button"
        class="tile get"
        data-testid={TESTID.insightsGetTile}
        onclick={() => onget()}
      >
        <span class="label strong">Get Agent Deck Insights</span>
        {#if getHost !== null}
          <span class="source">{getHost}</span>
        {/if}
      </button>
    </div>
  {:else}
    <section class="provider">
      <h1>{paid.title}</h1>
      <button
        type="button"
        class="run"
        data-testid={TESTID.insightsRun}
        data-running={String(paid.running)}
        disabled={paid.running}
        onclick={() => onrun()}>{paid.running ? 'Running' : 'Run'}</button
      >
      {#if paid.dropped !== undefined}
        <p class="line" data-testid="insights-dropped">{paid.dropped}</p>
      {/if}
      <div class="latest" data-testid={TESTID.insightsLatest}>
        {#if paid.latest === null}
          <p class="line">No finding set is recorded yet.</p>
        {:else}
          <h2>{paid.latest.heading}</h2>
          <p class="line">{paid.latest.window}</p>
          {#if paid.latest.findings.length === 0}
            <p class="line">The run recorded no findings.</p>
          {/if}
          {#each paid.latest.findings as finding, index (index)}
            <div class="finding" data-testid={TESTID.insightsFinding}>
              <span class="label strong">{finding.label}</span>
              <span class="note">{finding.confidence}</span>
              {#each finding.evidence as line, at (at)}
                <span class="source">{line}</span>
              {/each}
            </div>
          {/each}
          {#if paid.latest.rejected !== undefined}
            <p class="line">{paid.latest.rejected}</p>
          {/if}
        {/if}
      </div>
      <h2>History</h2>
      {#if paid.history.length === 0}
        <p class="line">No run is recorded yet.</p>
      {:else}
        <ul class="history">
          {#each paid.history as row, at (at)}
            <li data-testid={TESTID.insightsHistoryRow}>
              <span>{row.when}</span> · <span>{row.outcome}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</main>

<style>
  .insights {
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: 32px 24px;
    max-width: 60em;
    overflow: auto;
    user-select: text;
    -webkit-user-select: text;
  }

  h1 {
    margin: 0 0 8px;
    font-size: 1.6em;
    font-weight: 600;
  }

  h2 {
    margin: 0 0 6px;
    font-size: 1.15em;
    font-weight: 600;
  }

  .line {
    margin: 0 0 12px;
    color: var(--vscode-descriptionForeground, inherit);
  }

  .tiles {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
  }

  /* The session card's tile, as on the About surface. */
  .tile {
    box-sizing: border-box;
    width: 220px;
    min-height: 88px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
    padding: 12px 16px;
    text-align: left;
    font: inherit;
    color: inherit;
    background: var(--vscode-editorWidget-background, transparent);
    border: 1px solid var(--vscode-panel-border, currentColor);
    border-left: 3px solid var(--vscode-charts-blue, currentColor);
    border-radius: 10px;
  }

  .tile.get {
    cursor: pointer;
    border-left: 5px solid var(--vscode-charts-yellow, currentColor);
  }

  .tile.get:hover, .tile.get:focus-visible {
    border-color: var(--vscode-focusBorder, currentColor);
  }

  .value {
    font-size: 1.5em;
    font-weight: 600;
  }

  .strong {
    font-weight: 600;
  }

  .note,
  .source {
    font-size: 0.88em;
    color: var(--vscode-descriptionForeground, inherit);
  }

  .source {
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .example {
    max-width: 46em;
    padding: 12px 16px;
    border-left: 3px solid var(--vscode-charts-purple, currentColor);
    background: var(--vscode-editorWidget-background, transparent);
    border-radius: 6px;
  }

  .example-label {
    margin: 0 0 4px;
    font-size: 0.88em;
    color: var(--vscode-descriptionForeground, inherit);
  }

  .example-line {
    margin: 2px 0;
    line-height: 1.5;
  }

  .run {
    align-self: flex-start;
    font: inherit;
    padding: 4px 16px;
    margin-bottom: 12px;
    cursor: pointer;
    color: var(--vscode-button-foreground, inherit);
    background: var(--vscode-button-background, transparent);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
  }

  .run:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .finding {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 12px;
    margin-bottom: 8px;
    border-left: 3px solid var(--vscode-charts-yellow, currentColor);
    background: var(--vscode-editorWidget-background, transparent);
    border-radius: 6px;
  }

  .history {
    margin: 0;
    padding-left: 18px;
  }
</style>
