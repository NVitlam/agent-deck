<script lang="ts">
  import type { SessionState } from '../src/model/events.js';
  import { COST_NOT_COMPUTED_TITLE, formatCost, formatTokens, livenessLabel } from './format.js';

  let { session }: { session: SessionState } = $props();
</script>

<header class="header" data-testid="session-header">
  <div class="title">
    <span class="session-id" data-testid="header-session-id">{session.sessionId}</span>
    <span class="liveness" data-testid="header-liveness">{livenessLabel(session.liveness)}</span>
  </div>
  <dl class="totals">
    <div class="total">
      <dt>tokens in</dt>
      <dd data-testid="header-tokens-in">{formatTokens(session.totals.inputTokens)}</dd>
    </div>
    <div class="total">
      <dt>tokens out</dt>
      <dd data-testid="header-tokens-out">{formatTokens(session.totals.outputTokens)}</dd>
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

  .liveness {
    font-size: 0.85em;
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
