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
  import type { ToolNode, TreeNode } from '../src/model/events.js';
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
    toggled = [],
    ontogglenode,
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
    /** Node ids the user toggled away from their default — the store's set. */
    toggled?: readonly string[];
    /** Expand/collapse one action row. */
    ontogglenode?: ((nodeId: string) => void) | undefined;
  } = $props();

  /**
   * What an agent DID, in the order it did it.
   *
   * An agent cell's tool children are the actions. This list is the answer to
   * "I clicked an agent, what did it do?" — which the inspector previously
   * could not answer at all: it described the agent and stopped, and reaching
   * an action meant finding its dot on the canvas and clicking that.
   */
  let actions = $derived(
    node === undefined || !isAgentNode(node)
      ? []
      : node.children.filter((child): child is ToolNode => !isAgentNode(child)),
  );

  /**
   * The line a person actually wants to read.
   *
   * NOT the `tool_use` id. The id is the graft key — it is how attribution is
   * proved, and it is meaningless to a reader. What identifies an action to a
   * human is the tool and the first line of what it was given: the command,
   * the path, the pattern. Falls back to the tool name alone when the payload
   * has no usable first line, and never to the id.
   *
   * Reads the ALREADY-REDACTED `inputPreview`, so nothing here can widen what
   * G4 decided may be shown.
   */
  function summarize(node: ToolNode): string {
    const first = node.inputPreview
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (first === undefined) return node.toolName;
    const trimmed = first.length > 96 ? `${first.slice(0, 96)}…` : first;
    return trimmed;
  }

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

    {#if agent !== undefined}
      <!-- The action list. Expanding one opens its payloads DOWNWARD, in
           place, so the list stays the frame of reference and you never lose
           your place in it. -->
      <section class="actions" aria-label="Actions">
        <h3 class="actions-head">
          {actions.length === 0 ? 'No actions yet' : `${actions.length} actions`}
        </h3>
        <ul class="action-list">
          {#each actions as action (action.id)}
            {@const open = toggled.includes(action.id)}
            <li class="action" data-testid={TESTID.actionRow} data-action-id={action.id}
              data-status={action.status} data-open={String(open)}>
              <button
                type="button"
                class="action-button"
                aria-expanded={open}
                onclick={() => ontogglenode?.(action.id)}
              >
                <StatusChip status={action.status} />
                <span class="tool">{action.toolName}</span>
                <span class="summary" data-testid={TESTID.actionSummary}>{summarize(action)}</span>
                <span class="chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
              </button>
              {#if open}
                <div class="action-body">
                  <PayloadPreview label="input" text={action.inputPreview} expanded={false} />
                  {#if action.resultPreview !== undefined}
                    <PayloadPreview label="result" text={action.resultPreview} expanded={false} />
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

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
  .actions {
    border-top: 1px solid var(--vscode-panel-border, transparent);
    margin-top: 6px;
    padding-top: 4px;
  }

  .actions-head {
    margin: 0 0 2px 0;
    padding: 0 8px;
    font-size: 0.8em;
    font-weight: normal;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
  }

  .action-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .action-button {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    text-align: left;
    font: inherit;
    color: var(--vscode-foreground);
    background: transparent;
    border: none;
    padding: 3px 8px;
    cursor: pointer;
  }

  .action-button:hover {
    background: var(--vscode-list-hoverBackground, transparent);
  }

  .action-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
    outline-offset: -1px;
  }

  .tool {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    opacity: 0.85;
    flex: none;
  }

  .summary {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.95;
  }

  .chev {
    flex: none;
    opacity: 0.6;
  }

  .action-body {
    padding: 0 8px 6px 8px;
  }
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
