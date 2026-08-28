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
   * What a person actually wants to read on an action row.
   *
   * **The `description` field, when the payload carries one.** Most tools take
   * one and it is written BY the caller, in words, saying why the call is being
   * made — "List phase headings in PLAN.md" rather than the shell one-liner
   * that does it. Nothing else in the payload comes close: the command, the
   * path and the pattern are all the *how*.
   *
   * Never the `tool_use` id. The id is the graft key — it is how attribution is
   * proved and it is meaningless to a reader.
   *
   * The fallbacks descend from intent to mechanism, and the last one is the
   * tool name rather than nothing, so a row is never blank.
   *
   * Reads the ALREADY-REDACTED, ALREADY-TRUNCATED `inputPreview`, so nothing
   * here can widen what G4 decided may be shown — and truncation is exactly why
   * the JSON parse cannot be trusted: an 8 KB cut lands mid-object far more
   * often than not, which is what the regex path below is for.
   */
  const INTENT_KEYS = ['description', 'command', 'prompt', 'pattern', 'query', 'file_path', 'url'];

  /** `"description": "..."` out of a payload too truncated to parse. */
  function scrapeKey(raw: string, key: string): string | undefined {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const m = re.exec(raw);
    if (m?.[1] === undefined) return undefined;
    // Unescape the JSON string body by hand: `JSON.parse` on the whole payload
    // is what already failed, and wrapping the captured body in quotes to parse
    // it would throw again on a capture cut mid-escape.
    return m[1]
      .replace(/\\n/g, ' ')
      .replace(/\\t/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim();
  }

  function describe(node: ToolNode): string {
    const raw = node.inputPreview;

    // Whole-payload parse first: it is the only path that cannot be fooled by a
    // `"description"` appearing inside some other string value.
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        for (const key of INTENT_KEYS) {
          const value = record[key];
          if (typeof value === 'string' && value.trim() !== '') return value.trim();
        }
      }
    } catch {
      // Truncated, or not JSON at all. Fall through.
    }

    for (const key of INTENT_KEYS) {
      const scraped = scrapeKey(raw, key);
      if (scraped !== undefined && scraped !== '') return scraped;
    }

    const first = raw
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return first === undefined || first === '' ? node.toolName : first;
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
        <!-- TWO ROWS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS. `contextNow` is
             the context LEVEL - the last assistant message's prompt and
             output, which is what fills a window - and `burn` is the running
             total across every distinct message. The shipped single row summed
             `input_tokens`, which is ~2 per message in the anchor corpora, so
             it under-reported a 42,199-token prompt as 2. Both are
             optional-chained: an engine may report neither, and an em-dash is
             the honest render for a number we do not have. -->
        <div class="row" data-testid="inspector-row" data-field="tokens">
          <dt>tokens</dt>
          <dd data-testid="inspector-tokens"
            >{formatTokens(agent.contextNow?.prompt)} in ctx / {formatTokens(
              agent.contextNow?.output,
            )} out</dd
          >
        </div>
        <div class="row" data-testid="inspector-row" data-field="burn">
          <dt>burn</dt>
          <dd data-testid="inspector-burn"
            >{formatTokens(agent.burn?.prompt)} in / {formatTokens(agent.burn?.output)} out</dd
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
                <span class="summary" data-testid={TESTID.actionSummary} title={describe(action)}
                  >{describe(action)}</span
                >
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
