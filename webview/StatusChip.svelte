<script lang="ts">
  import { statusLabel } from './format.js';

  let { status }: { status: 'running' | 'done' | 'error' } = $props();
</script>

<span class="chip chip-{status}" data-testid="status-chip" data-status={status}>
  {statusLabel(status)}
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
</style>
