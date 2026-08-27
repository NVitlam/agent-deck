<script lang="ts">
  import type { SessionState } from '../src/model/events.js';
  import {
    COST_NOT_COMPUTED_TITLE,
    LIVENESS_INFERRED_LABEL,
    LIVENESS_INFERRED_TITLE,
    formatCost,
    formatTokens,
    livenessLabel,
    livenessTitle,
  } from './format.js';

  // `degraded` is the hook tap's health, not a property of this session — it
  // arrives on its own message (see `DegradedMessage`). It is passed in
  // because the liveness value beside the session id means something weaker
  // while the tap is silent, and the header is where that value is read.
  let { session, degraded = false }: { session: SessionState; degraded?: boolean } = $props();
</script>

<header
  class="header"
  data-testid="session-header"
  data-liveness={session.liveness}
  data-liveness-inferred={String(degraded)}
>
  <div class="title">
    <span class="session-id" data-testid="header-session-id">{session.sessionId}</span>
    <span
      class="liveness liveness-{session.liveness}"
      data-testid="header-liveness"
      data-liveness={session.liveness}
      title={livenessTitle(session.liveness)}
    >
      <span class="dot" aria-hidden="true"></span>{livenessLabel(session.liveness)}</span
    >
    {#if degraded}
      <!-- Deliberately independent of `degradedDismissed`: dismissing the
           banner silences one episode, it does not improve the source of this
           number. Without this the user dismisses the banner and then reads
           "live" with nothing saying where "live" came from. -->
      <span class="inferred" data-testid="header-liveness-inferred" title={LIVENESS_INFERRED_TITLE}
        >({LIVENESS_INFERRED_LABEL})</span
      >
    {/if}
  </div>
  <dl class="totals">
    <!-- `contextNow` is the MAIN transcript's last assistant message, not a
         sum over the tree: a subagent has its own window, so adding them
         answers no question. `burn` is the sum, and it is labelled as one.
         Both replace a single "tokens in" that read `input_tokens` alone -
         ~2 per message in the anchor corpora. -->
    <div class="total">
      <dt>context</dt>
      <dd data-testid="header-context">{formatTokens(session.contextNow.prompt)}</dd>
    </div>
    <div class="total">
      <dt>burn</dt>
      <dd data-testid="header-burn">{formatTokens(session.burn.prompt)}</dd>
    </div>
    <div class="total">
      <dt>cost</dt>
      <!-- `totals.costUsd` is hard 0 and 0 means NOT COMPUTED, never "free":
           there is no price table in this repo, and graft.ts refuses to invent
           one. "$0.00" would assert that the session was free, so the header
           leads with tokens and says plainly that cost is unknown. -->
      <dd data-testid="header-cost" title={COST_NOT_COMPUTED_TITLE}>
        {formatCost(session.totals.costUsd)}
      </dd>
    </div>
  </dl>
</header>

<style>
  .header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }

  .title {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .session-id {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The four liveness states must be distinguishable in a screenshot, not
     only in the DOM, so each gets a colour AND a filled/hollow dot — colour
     alone fails for a colour-blind reader and fails again in a greyscale
     screenshot. All colours are VS Code theme variables (G5: nothing is
     fetched, and no palette is hard-coded to light or dark). */
  .liveness {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    font-size: 0.85em;
    opacity: 0.75;
  }

  .dot {
    width: 0.55em;
    height: 0.55em;
    border-radius: 50%;
    border: 1px solid currentColor;
    align-self: center;
  }

  .liveness-live {
    color: var(--vscode-charts-green, inherit);
    opacity: 1;
  }

  .liveness-live .dot {
    background: currentColor;
  }

  .liveness-idle {
    color: var(--vscode-charts-yellow, inherit);
    opacity: 1;
  }

  .liveness-idle .dot {
    background: transparent;
  }

  .liveness-ended .dot {
    background: currentColor;
    opacity: 0.5;
  }

  .liveness-unsupported {
    color: var(--vscode-errorForeground, inherit);
    opacity: 1;
  }

  .liveness-unsupported .dot {
    background: transparent;
    border-style: dashed;
  }

  .inferred {
    font-size: 0.85em;
    font-style: italic;
    opacity: 0.75;
  }

  .totals {
    display: flex;
    gap: 16px;
    margin: 0;
  }

  .total {
    display: flex;
    align-items: baseline;
    gap: 5px;
  }

  dt {
    font-size: 0.8em;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
</style>
