<script lang="ts">
  import { degradedReasonText } from './format.js';

  let {
    reason,
    ondismiss,
  }: {
    reason: 'noHookEvents' | 'listenerDown' | undefined;
    ondismiss: () => void;
  } = $props();
</script>

<!-- Spec C4: informative, dismissible, NOT nagging. One line, one dismiss
     button, and once dismissed it stays gone for this degraded episode — it
     reappears only if the tap recovers and degrades again. The tree keeps
     rendering underneath: content and liveness are separate sources (G2), so
     losing the hook tap costs "what is running right now", not the session. -->
<div class="banner" role="status" data-testid="degraded-banner">
  <span class="text">
    Liveness is degraded — {degradedReasonText(reason)}. The tree below is still
    accurate; only "running right now" is unavailable. See the README for the
    hook block.
  </span>
  <button type="button" class="dismiss" data-testid="degraded-dismiss" onclick={ondismiss}>
    Dismiss
  </button>
</div>

<style>
  .banner {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 4px 10px;
    font-size: 0.9em;
    background: var(--vscode-inputValidation-warningBackground, transparent);
    color: var(--vscode-inputValidation-warningForeground, inherit);
    border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, transparent);
  }

  .text {
    flex: 1;
  }

  .dismiss {
    background: transparent;
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 3px;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 0 6px;
  }
</style>
