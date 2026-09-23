<!--
  The Insights SURFACE — v0.9.0 DoD 9.29, 9.30, and since DoD 9.46 the
  two-pane registered state of spec `Amendment 2026-09-23 — Paid Insights
  surface, export, provider v1 growth`.

  A surface of the ONE panel, switched in place from Menu ▸ Open Insights. Two
  states, decided by ONE fact the host states — whether an Insights provider is
  REGISTERED. Never whether one is installed, and never a licence.

  FREE (no provider): every static Layer 1 fact for the last 7 days the store
  holds, as tiles, each naming the field it was counted from; one rotating
  example, labelled as an example; and one tile, "Get Agent Deck Insights",
  that asks before it opens the page.

  PROVIDER: a REPORT LIST on the left — date, findings count, engine, newest
  first, a tick box per row and "Export ticked (n)" under it — and a PREVIEW
  on the right: "Select a report to preview / download." until a row is
  selected, then that run rendered exactly as the latest report was, with
  Export HTML / Markdown / Copy in its header. The fact tiles sit below both.
  Those controls are the amendment's RULED EXCEPTION to the clean-windows law,
  enumerated in `webview/chrome.test.ts`; there is no Run action.

  IT DECIDES NOTHING. `layout.ts` computes every tile, row and line; the host
  holds the selection; the store holds the ticks; this renders them. The clock
  is read here, once per render, because the window is "the last 7 days" of
  NOW and the layout is a pure function that takes it.
-->
<script lang="ts">
  import type { InsightsProviderSnapshot } from '../../src/model/events.js';
  import type { StatsRecord } from '../../src/stats/schema.js';
  import { TESTID } from '../canvas-contract.js';
  import {
    EXAMPLE_LABEL,
    INSIGHTS_WINDOW_DAYS,
    INSIGHT_SOURCES,
    NO_RUNS,
    SELECT_A_REPORT,
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
    ticks,
    exampleCount,
    getHost,
    idleThresholdMs,
    now = () => Date.now(),
    onget,
    onrawoutput,
    onselect,
    ontick,
    onexport,
    onexportticked,
  }: {
    /** The STORED history — "the facts the store already holds". */
    records: readonly StatsRecord[];
    /** Has the host read the store yet? Before it has, nothing is counted. */
    loaded: boolean;
    /** `agentDeck.stats.enabled`. A disabled store holds nothing to count. */
    enabled: boolean;
    provider: InsightsProviderSnapshot | null;
    /** The ticked run ids (DoD 9.46) — the store's view state. */
    ticks: readonly string[];
    exampleCount: number;
    /** The Get tile's host, from the page the host built; `null` before it. */
    getHost: string | null;
    /** `agentDeck.livenessThresholdMs`, from the host's settings (DoD 9.38). */
    idleThresholdMs: number;
    now?: () => number;
    onget: () => void;
    /** "Show raw output" on the selected refused run (DoD 9.40, 9.46). */
    onrawoutput: () => void;
    /** A report-list row was clicked (DoD 9.46). */
    onselect: (runId: string) => void;
    /** A row's tick box (DoD 9.46). */
    ontick: (runId: string) => void;
    /** One of the preview's Export actions (DoD 9.47). */
    onexport: (target: 'html' | 'markdown' | 'copy') => void;
    /** "Export ticked (n)" (DoD 9.47). */
    onexportticked: () => void;
  } = $props();

  let free = $derived(freeInsightsLayout(records, now(), idleThresholdMs));
  let example = $derived(exampleAt(exampleCount));
  let paid = $derived(provider === null ? null : providerInsightsLayout(provider));
  let report = $derived(paid?.preview?.report ?? null);

  /** The three Export actions, in the amendment's order. */
  const EXPORTS: readonly { target: 'html' | 'markdown' | 'copy'; label: string }[] = [
    { target: 'html', label: 'HTML' },
    { target: 'markdown', label: 'Markdown' },
    { target: 'copy', label: 'Copy' },
  ];
</script>

<main
  class="insights"
  data-testid={TESTID.insightsSurface}
  data-state={provider === null ? 'free' : 'provider'}
>
  {#snippet facts()}
    <section class="facts">
      {#if paid === null}<h1>Insights</h1>{:else}<h2>Stored facts</h2>{/if}
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
  {/snippet}

  {#if paid === null}
    {@render facts()}
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
      {#if paid.status !== undefined}
        <p class="line" data-testid="insights-status">{paid.status}</p>
      {/if}
      {#if paid.dropped !== undefined}
        <p class="line" data-testid="insights-dropped">{paid.dropped}</p>
      {/if}
      <div class="panes">
        <div class="list" data-testid={TESTID.insightsReportList}>
          <h2>Reports</h2>
          {#if paid.rows.length === 0}
            <p class="line">{NO_RUNS}</p>
          {:else}
            <!-- Keyed by POSITION: run ids are the provider's data (round 4, D1). -->
            {#each paid.rows as row, at (at)}
              <div
                class="report-row"
                data-testid={TESTID.insightsReportRow}
                data-run={row.runId}
                data-state={row.state}
                data-selected={String(paid.preview?.runId === row.runId)}
                data-ticked={String(ticks.includes(row.runId))}
              >
                <input
                  type="checkbox"
                  data-testid={TESTID.insightsReportTick}
                  aria-label={`Tick the report of ${row.when}`}
                  checked={ticks.includes(row.runId)}
                  onchange={() => ontick(row.runId)}
                />
                <button
                  type="button"
                  class="report-select"
                  data-testid={TESTID.insightsReportSelect}
                  aria-pressed={paid.preview?.runId === row.runId}
                  onclick={() => onselect(row.runId)}
                >
                  <span class="strong">{row.when}</span>
                  <span class="note">{row.outcome} · {row.agent}</span>
                </button>
              </div>
            {/each}
          {/if}
          <button
            type="button"
            class="action"
            data-testid={TESTID.insightsExportTicked}
            disabled={ticks.length === 0}
            onclick={() => onexportticked()}>Export ticked ({ticks.length})</button
          >
        </div>
        <div class="preview" data-testid={TESTID.insightsPreview} data-run={paid.preview?.runId ?? ''}>
          {#if paid.preview === null}
            <p class="line" data-testid="insights-preview-empty">{SELECT_A_REPORT}</p>
          {:else}
            {#if paid.preview.dropped !== undefined}
              <p class="line" data-testid="insights-preview-dropped">{paid.preview.dropped}</p>
            {/if}
            {#if report === null}
              <p class="line" data-testid="insights-preview-missing">{paid.preview.missing}</p>
            {:else}
              <div class="latest" data-testid={TESTID.insightsLatest} data-state={report.state}>
                <div class="facts-block" data-testid={TESTID.insightsRunFacts}>
                  <div class="head">
                    <h2>{report.facts.heading}</h2>
                    <span class="exports">
                      {#each EXPORTS as item (item.target)}
                        <button
                          type="button"
                          class="action"
                          data-testid={TESTID.insightsExport}
                          data-target={item.target}
                          onclick={() => onexport(item.target)}>{item.label}</button
                        >
                      {/each}
                    </span>
                  </div>
                  <p class="fact">{report.facts.agent}</p>
                  <p class="fact">{report.facts.window}</p>
                  {#if report.facts.usage !== null}
                    <p class="fact" data-testid="insights-run-usage">{report.facts.usage}</p>
                  {/if}
                </div>
                {#if report.dropped !== undefined}
                  <p class="line" data-testid="insights-preview-dropped">{report.dropped}</p>
                {/if}
                {#if report.refusal !== undefined}
                  <div class="refusal" data-testid={TESTID.insightsRefusal}>
                    <span class="label strong">Refused at step: {report.refusal.step}</span>
                    <p class="text">{report.refusal.reason}</p>
                    {#if report.rawOutput}
                      <button
                        type="button"
                        class="action"
                        data-testid={TESTID.insightsRawOutput}
                        onclick={() => onrawoutput()}>Show raw output</button
                      >
                    {:else if report.rawOutputNote !== undefined}
                      <p class="line" data-testid="insights-raw-output-note">{report.rawOutputNote}</p>
                    {/if}
                  </div>
                {/if}
                {#if report.note !== undefined}
                  <p class="line" data-testid="insights-latest-note">{report.note}</p>
                {/if}
                {#each report.findings as finding, index (index)}
                  <div class="finding" data-testid={TESTID.insightsFinding}>
                    <span class="lead strong" data-testid="insights-finding-lead">{finding.lead}</span>
                    <span class="note" data-testid="insights-finding-meta">{finding.meta}</span>
                    {#if finding.detail !== ''}
                      <details class="detail">
                        <summary data-testid={TESTID.insightsDetail}>Detail</summary>
                        <p class="text" data-testid="insights-finding-detail">{finding.detail}</p>
                      </details>
                    {/if}
                    <p class="text" data-testid="insights-finding-cause">
                      <span class="caption">Cause</span>
                      {finding.cause}
                    </p>
                    <ul class="evidence">
                      {#each finding.evidence as item, at (at)}
                        <li data-testid={TESTID.insightsEvidence}>
                          <span class="caption">{item.label}</span>
                          <span class="strong">{item.value}</span>
                          <span class="source">{item.source}</span>
                        </li>
                      {/each}
                    </ul>
                  </div>
                {/each}
                {#if report.resolved !== undefined}
                  <p class="line" data-testid="insights-resolved-kinds">{report.resolved}</p>
                {/if}
                {#if report.rejected !== undefined}
                  <p class="line">{report.rejected}</p>
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      </div>
      {@render facts()}
    </section>
  {/if}
</main>

<style>
  .insights {
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: 32px 24px;
    max-width: 72em;
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

  .action {
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

  .action:disabled {
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

  /* DoD 9.46 — the report list on the left, the preview on the right. */
  .panes {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    margin-bottom: 24px;
  }

  .list {
    flex: 0 0 260px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-right: 12px;
    border-right: 1px solid var(--vscode-panel-border, currentColor);
  }

  .preview {
    flex: 1;
    min-width: 0;
  }

  .report-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px;
    border-radius: 4px;
  }

  .report-row[data-selected='true'] {
    background: var(--vscode-list-activeSelectionBackground, transparent);
    color: var(--vscode-list-activeSelectionForeground, inherit);
  }

  .report-row input {
    margin: 3px 0 0;
  }

  .report-select {
    flex: 1;
    display: flex;
    flex-direction: column;
    text-align: left;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  .report-select:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
  }

  .list > .action {
    margin-top: 12px;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px 16px;
  }

  .exports {
    display: flex;
    gap: 6px;
  }

  .exports .action {
    margin-bottom: 0;
    padding: 2px 10px;
  }

  @media (max-width: 720px) {
    .panes {
      flex-direction: column;
    }

    .list {
      flex: none;
      border-right: none;
      padding-right: 0;
    }
  }

  .facts-block {
    margin-bottom: 12px;
  }

  .fact {
    margin: 2px 0;
  }

  /* Provider text keeps its own line breaks; it is never parsed as markup. */
  .text {
    margin: 4px 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }

  .caption {
    font-size: 0.88em;
    color: var(--vscode-descriptionForeground, inherit);
  }

  .detail summary {
    cursor: pointer;
    font-size: 0.88em;
    color: var(--vscode-textLink-foreground, inherit);
  }

  .evidence {
    margin: 4px 0 0;
    padding-left: 18px;
  }

  .refusal {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 12px;
    margin-bottom: 8px;
    border-left: 3px solid var(--vscode-charts-red, currentColor);
    background: var(--vscode-editorWidget-background, transparent);
    border-radius: 6px;
  }
</style>
