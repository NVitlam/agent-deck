<script lang="ts">
  import { collapsePreview } from './format.js';

  let {
    label,
    text,
    expanded,
  }: { label: string; text: string; expanded: boolean } = $props();

  // Collapsed shows the first COLLAPSED_PREVIEW_CHARS characters plus an
  // explicit marker naming how many were hidden; expanded shows the whole
  // string the node already carries. Expanding requests nothing from the host
  // — the payload is already here, capped at 8 KB by the host's redaction.
  let collapsed = $derived(collapsePreview(text));
</script>

<div class="preview" data-testid="payload-preview" data-label={label}>
  <span class="preview-label">{label}</span>
  {#if expanded}
    <pre data-testid="preview-body" data-truncated="false">{text}</pre>
  {:else}
    <pre data-testid="preview-body" data-truncated={String(collapsed.truncated)}>{collapsed.text}</pre>
    {#if collapsed.truncated}
      <span class="preview-marker" data-testid="preview-marker">{collapsed.marker}</span>
    {/if}
  {/if}
</div>

<style>
  .preview {
    margin: 2px 0 4px 0;
  }

  .preview-label {
    font-size: 0.85em;
    opacity: 0.75;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  pre {
    margin: 2px 0;
    padding: 4px 6px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    background: var(--vscode-textCodeBlock-background, transparent);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 3px;
    max-height: 24em;
    overflow: auto;
  }

  .preview-marker {
    font-size: 0.85em;
    opacity: 0.8;
    font-style: italic;
  }
</style>
