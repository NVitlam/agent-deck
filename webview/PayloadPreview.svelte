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

  /**
   * THE MARKER IS A CONTROL — v0.7.0 Phase 4, DoD 4.9c.
   *
   * It said "expand to see all" and was a `<span>`: on the drawer's detail
   * pane, where the parent passes `expanded={false}` and offers no toggle of
   * its own, clicking it did nothing. Reproduced in the harness before this
   * line existed (`inspector.test.ts`, "the expand affordance"), fixed here.
   *
   * `open` is THIS component's state and is OR-ed with the parent's
   * `expanded`: a parent that expands everything still expands everything, and
   * a parent that offers nothing gets a marker that works. Clicking the marker
   * opens; clicking the collapse control shuts it again. The text shown when
   * open is `text` itself — the host's cap is the only bound, exactly as when
   * the parent expands, so this cannot widen what G4 decided may be shown.
   */
  let open = $state(false);
  let showAll = $derived(expanded || open);
</script>

<div class="preview" data-testid="payload-preview" data-label={label} data-open={String(showAll)}>
  <span class="preview-label">{label}</span>
  {#if showAll}
    <pre data-testid="preview-body" data-truncated="false">{text}</pre>
    {#if !expanded && collapsed.truncated}
      <button
        type="button"
        class="preview-marker preview-control"
        data-testid="preview-collapse"
        onclick={() => (open = false)}>[collapse]</button
      >
    {/if}
  {:else}
    <pre data-testid="preview-body" data-truncated={String(collapsed.truncated)}>{collapsed.text}</pre>
    {#if collapsed.truncated}
      <button
        type="button"
        class="preview-marker preview-control"
        data-testid="preview-marker"
        onclick={() => (open = true)}>{collapsed.marker}</button
      >
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

  /* A button that reads as the marker it replaced: no chrome, inherited
     colour, a pointer cursor. The focus ring is the one thing it gains. */
  .preview-control {
    font: inherit;
    font-size: 0.85em;
    font-style: italic;
    color: inherit;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }

  .preview-control:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 1px;
  }
</style>
