<script lang="ts">
  import type { ToolNode } from '../src/model/events.js';
  import { statusLabel, stalledForLabel } from './format.js';

  let {
    status,
    stalledForMs = undefined,
  }: {
    status: ToolNode['status'];
    /**
     * How long the stall has been visible. Passed in rather than computed
     * here: the component owns no clock, so two chips in one render cannot
     * disagree about now, and a test can drive the elapsed time directly.
     */
    stalledForMs?: number | undefined;
  } = $props();
</script>

<span class="chip chip-{status}" data-testid="status-chip" data-status={status}>
  {statusLabel(status)}{#if status === 'stalled' && stalledForMs !== undefined}<span
      class="elapsed"
      data-testid="stalled-for">&nbsp;{stalledForLabel(stalledForMs)}</span
    >{/if}
</span>

<style>
  /* All colours come from VS Code theme variables, injected by the host into
     the webview document. Nothing is fetched (G5) and nothing is hard-coded to
     a light or dark palette. */
  .chip {
    display: inline-block;
    padding: 0 6px;
    border-radius: 3px;
    font-size: 0.85em;
    line-height: 1.6;
    border: 1px solid var(--vscode-panel-border, transparent);
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    white-space: nowrap;
  }

  .chip-running {
    color: var(--vscode-charts-blue, var(--vscode-badge-foreground));
    border-color: var(--vscode-charts-blue, var(--vscode-panel-border));
    background: transparent;
  }

  .chip-done {
    color: var(--vscode-charts-green, var(--vscode-badge-foreground));
    border-color: var(--vscode-charts-green, var(--vscode-panel-border));
    background: transparent;
  }

  .chip-error {
    color: var(--vscode-errorForeground, var(--vscode-badge-foreground));
    border-color: var(--vscode-errorForeground, var(--vscode-panel-border));
    background: transparent;
  }

  /* Amber, and deliberately NOT the error colour. A stall is not a failure —
     the tool may still complete, and it did not in the session this was built
     from only because the user intervened. Painting it red would state an
     outcome the product does not know. */
  .chip-stalled {
    color: var(--vscode-charts-yellow, var(--vscode-badge-foreground));
    border-color: var(--vscode-charts-yellow, var(--vscode-panel-border));
    background: transparent;
  }

  .elapsed {
    opacity: 0.85;
    font-variant-numeric: tabular-nums;
  }
</style>
