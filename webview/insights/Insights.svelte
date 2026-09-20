<!--
  The Insights view mode — v0.9.0 DoD 9.6, spec `Amendment 2026-09-20`.

  Four counts over THIS USER'S OWN Layer 1 records, one product sentence, three
  static examples, one button.

  G10 APPLIES TO EVERY STRING IN THIS FILE, markup included —
  `scripts/forbidden-words.mjs` scans both — and DoD 9.6 adds a second rule on
  top of it: NO ADVICE. No "you should", no "try", no "consider", no
  "recommend". This surface states counts and says what the other extension
  does. `insights.test.ts` scans the built bundle for the advice vocabulary and
  for the second person.

  A ZERO COUNT IS HIDDEN, and all-zero is one plain fact line rather than an
  empty row of zeroes. A zero is a real measurement and printing four of them
  would be a wall of nothing; the fact line says the same thing in a sentence.

  Every path and id in the examples is SYNTHETIC. They are illustrations, not
  this user's data, and the label on each says so in the user's own view.
-->
<script lang="ts">
  import type { Store, WebviewView } from '../store.js';
  import { TESTID } from '../canvas-contract.js';
  import type { StatsRecord } from '../../src/stats/schema.js';
  import {
    ALL_ZERO_LINE,
    EXAMPLE_LABEL,
    IDLE_RESUME_MS,
    INSIGHT_SOURCES,
    PRODUCT_SENTENCE,
    exampleAt,
    insightsLayout,
  } from './layout.js';

  let {
    store,
    view,
    records,
  }: { store: Store; view: WebviewView; records: readonly StatsRecord[] } = $props();

  const layout = $derived(insightsLayout(records));
  const example = $derived(exampleAt(view.insightsOpenCount));

  /** Seconds, for the parameters line. The constant is milliseconds. */
  const idleSeconds = Math.round(IDLE_RESUME_MS / 1000);
</script>

<section class="insights" data-testid={TESTID.insightsView} data-installed={view.insightsInstalled}>
  {#if layout.allZero}
    <p class="fact" data-testid={TESTID.insightsAllZero}>{ALL_ZERO_LINE}</p>
  {:else}
    <p class="counts" data-testid={TESTID.insightsCounts}>
      {#each layout.shown as entry, index (entry.id)}<span
          class="count"
          data-testid={TESTID.insightsCount}
          data-id={entry.id}
          data-count={entry.count}
          >{index > 0 ? ' · ' : ''}<b>{entry.count}</b> {entry.label}</span
        >{/each}
    </p>
  {/if}

  <p class="params" data-testid={TESTID.insightsParams}>
    Over {layout.sessions} recorded sessions. A long-idle resume is a gap of {idleSeconds}s or more
    between one call starting and the next. Fields: {INSIGHT_SOURCES.compactions} ·
    {INSIGHT_SOURCES.idleResumes} · {INSIGHT_SOURCES.rereadLoops} · {INSIGHT_SOURCES.failedCalls}.
  </p>

  <p class="sentence" data-testid={TESTID.insightsSentence}>{PRODUCT_SENTENCE}</p>

  <div class="example" data-testid={TESTID.insightsExample} data-example={example.id}>
    <span class="label" data-testid={TESTID.insightsExampleLabel}>{EXAMPLE_LABEL}</span>
    <h3>{example.title}</h3>
    {#each example.lines as line (line)}
      <p>{line}</p>
    {/each}
  </div>

  <div class="actions">
    <button
      type="button"
      class="toggle"
      data-testid={TESTID.insightsExampleButton}
      onclick={() => store.nextInsightsExample()}
    >
      See an example
    </button>
    <button
      type="button"
      class="toggle primary"
      data-testid={TESTID.insightsAction}
      data-action={view.insightsInstalled ? 'open' : 'get'}
      onclick={() => store.openInsights()}
    >
      {view.insightsInstalled ? 'Open Insights' : 'Get Insights'}
    </button>
  </div>
</section>

<style>
  .insights {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow: auto;
  }
  .counts {
    margin: 0;
    font-size: 15px;
  }
  .counts b {
    font-variant-numeric: tabular-nums;
  }
  .fact {
    margin: 0;
    font-size: 15px;
    opacity: 0.9;
  }
  .params {
    margin: 0;
    font-size: 11px;
    opacity: 0.7;
  }
  .sentence {
    margin: 0;
    font-size: 13px;
  }
  .example {
    border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    border-radius: 6px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .example .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.65;
  }
  .example h3 {
    margin: 0;
    font-size: 13px;
  }
  .example p {
    margin: 0;
    font-size: 12px;
    opacity: 0.85;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .toggle {
    font: inherit;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .toggle.primary {
    background: var(--vscode-button-background, rgba(128, 128, 128, 0.25));
    color: var(--vscode-button-foreground, inherit);
  }
</style>
