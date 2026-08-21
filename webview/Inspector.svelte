<!--
  Altitude 2 — the inspector (spec C7.1).

  A text detail panel for one node: kind, id, status, tokens, duration, and
  the input/result payload previews.

  WHAT THIS COMPONENT IS NOT. It is not a new home for redaction or truncation
  logic. `PayloadPreview.svelte` is IMPORTED, not copied: the 512-character
  collapse, the exact marker string and the full expand all still come from
  `format.ts:collapsePreview`, through the same component the Phase 3 list view
  renders. C7.1 calls this "rehoused, not redesigned", and importing is what
  makes that true by construction rather than by re-verification. A second copy
  of the cut-and-mark logic on a second surface is precisely the defect Phase 4
  carry-forward A spent itself on — a marker that under-reported by 7.73x
  because two layers cut the same string.

  Selection and altitude are the store's (C7.7, C7.8). This component reads a
  node and reports clicks; it owns no altitude transition and no key handler.
-->
<script lang="ts">
  import type { TreeNode } from '../src/model/events.js';
  import { isAgentNode } from '../src/model/events.js';
  import { TESTID } from './canvas-contract.js';
  import { formatDuration, formatTokens } from './format.js';
  import PayloadPreview from './PayloadPreview.svelte';
  import StatusChip from './StatusChip.svelte';

  let {
    node,
    expanded = false,
    ontoggle,
    onclose,
  }: {
    /** The node under inspection. `undefined` renders the empty state. */
    node?: TreeNode | undefined;
    /**
     * Whether the payload previews are expanded. Tool payloads default to
     * COLLAPSED, exactly as they do in the tree — an 8 KB preview open by
     * default buries everything under it.
     */
    expanded?: boolean;
    /** The user asked to expand/collapse the payloads. */
    ontoggle?: (() => void) | undefined;
    /** The user asked to leave the inspector (Escape's altitude walk, C7.8). */
    onclose?: (() => void) | undefined;
  } = $props();

  let agent = $derived(node !== undefined && isAgentNode(node) ? node : undefined);
  let tool = $derived(node !== undefined && !isAgentNode(node) ? node : undefined);

  // An agent carries `startedAt`/`endedAt`; a tool carries `durationMs`
  // already. Neither is invented when it is missing — `formatDuration` prints
  // an em-dash for "we do not have this number".
  let agentDuration = $derived(
    agent !== undefined && agent.endedAt !== undefined
      ? agent.endedAt - agent.startedAt
      : undefined,
  );
</script>

<aside
  class="inspector"
  data-testid={TESTID.inspector}
  data-empty={String(node === undefined)}
  data-node-id={node?.id ?? ''}
  aria-label="Inspector"
>
  {#if node === undefined}
    <p class="empty" data-testid={TESTID.inspectorEmpty}>Select a cell or a dot to inspect it.</p>
  {:else}
    <header class="head">
      <span class="kind" data-testid="inspector-kind">{agent !== undefined ? agent.kind : 'tool'}</span>
      <span class="title" data-testid="inspector-title"
        >{agent !== undefined ? agent.label : tool?.toolName}</span
      >
      <StatusChip status={node.status} />
      {#if onclose !== undefined}
        <button class="close" type="button" data-testid="inspector-close" onclick={() => onclose?.()}
          >Close</button
        >
      {/if}
    </header>

    <dl class="rows">
      <div class="row" data-testid="inspector-row" data-field="id">
        <dt>id</dt>
        <dd data-testid="inspector-id">{node.id}</dd>
      </div>
      {#if agent !== undefined}
        <div class="row" data-testid="inspector-row" data-field="spawnDepth">
          <dt>spawn depth</dt>
          <dd data-testid="inspector-spawn-depth">{agent.spawnDepth}</dd>
        </div>
        <div class="row" data-testid="inspector-row" data-field="tokens">
          <dt>tokens</dt>
          <dd data-testid="inspector-tokens"
            >{formatTokens(agent.tokens.in)} in / {formatTokens(agent.tokens.out)} out</dd
          >
        </div>
        <div class="row" data-testid="inspector-row" data-field="duration">
          <dt>duration</dt>
          <dd data-testid="inspector-duration">{formatDuration(agentDuration)}</dd>
        </div>
      {:else if tool !== undefined}
        <div class="row" data-testid="inspector-row" data-field="duration">
          <dt>duration</dt>
          <dd data-testid="inspector-duration">{formatDuration(tool.durationMs)}</dd>
        </div>
      {/if}
    </dl>

    {#if tool !== undefined}
      <div class="payloads">
        <button
          class="expander"
          type="button"
          data-testid="inspector-expand"
          aria-expanded={expanded}
          onclick={() => ontoggle?.()}>{expanded ? 'Collapse payloads' : 'Expand payloads'}</button
        >
        <!-- IMPORTED, never reimplemented. See the header comment. -->
        <PayloadPreview label="input" text={tool.inputPreview} {expanded} />
        {#if tool.resultPreview !== undefined}
          <PayloadPreview label="result" text={tool.resultPreview} {expanded} />
        {/if}
      </div>
    {/if}
  {/if}
</aside>

<style>
  /* Every colour is a VS Code theme variable; nothing is fetched (G5) and
     nothing is pinned to a light or dark palette. */
  .inspector {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    min-width: 0;
    overflow: auto;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    border-left: 1px solid var(--vscode-panel-border, transparent);
  }

  .empty {
    margin: 0;
    opacity: 0.75;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .kind {
    font-size: 0.8em;
    opacity: 0.7;
    text-transform: uppercase;
  }

  .title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .close {
    margin-left: auto;
  }

  .rows {
    margin: 0;
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0 10px;
  }

  .row {
    display: contents;
  }

  dt {
    font-size: 0.85em;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  dd {
    margin: 0;
    min-width: 0;
    word-break: break-word;
  }

  button {
    color: inherit;
    font: inherit;
    background: transparent;
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 3px;
    padding: 0 6px;
    cursor: pointer;
  }

  /* C7.8: a visible focus ring, on a real focusable element. `:focus-visible`
     rather than `:focus` so a mouse click does not leave a ring behind. */
  button:focus-visible {
    outline: 2px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 1px;
  }
</style>
