<script lang="ts">
  import type { RenderNode } from './tree.js';
  import type { Store } from './store.js';
  import { formatDuration, formatTokens } from './format.js';
  import PayloadPreview from './PayloadPreview.svelte';
  import StatusChip from './StatusChip.svelte';
  // Svelte 5 replaced `<svelte:self>` with a plain self-import; the cycle is
  // resolved by the bundler, and the reference is only read at render time.
  import Self from './TreeNodeView.svelte';

  let {
    render,
    store,
    toggled,
    now = undefined,
  }: {
    render: RenderNode;
    store: Store;
    toggled: readonly string[];
    /**
     * The renderer's clock, for a stalled tool's elapsed time.
     *
     * Optional and defaulted to `Date.now()` exactly as `Deck.svelte` does,
     * so the DEFAULT is the shipping behaviour and a test injects instead of
     * the other way round. That direction matters: a prop whose default is
     * wrong and whose only correct value comes from a test is the D4 defect
     * this repository already shipped once.
     */
    now?: number | undefined;
  } = $props();

  let clock = $derived(now ?? Date.now());

  /**
   * How long this tool has been stalled, or `undefined`.
   *
   * `stalledSinceMs` is the instant the threshold was crossed, computed once
   * in the host (`src/model/stall.ts`), so every chip in a render differences
   * against the same crossing rather than each deriving its own.
   */
  let stalledForMs = $derived(
    render.kind !== 'agent'
      && render.node.status === 'stalled'
      && render.node.stalledSinceMs !== undefined
      ? Math.max(0, clock - render.node.stalledSinceMs)
      : undefined,
  );

  /**
   * Stalled tools at or beneath this agent — the badge.
   *
   * Counted over the RENDER subtree, not `AgentNode.children`, because a
   * spawned subagent is joined by a `spawnEdge` and is not a child of the
   * agent in the model. Counting the model tree would miss every stall that
   * happened inside a subagent, which is exactly the reported case.
   */
  function countStalled(node: RenderNode): number {
    let n =
      node.kind !== 'agent' && node.node.status === 'stalled' ? 1 : 0;
    for (const child of node.children) n += countStalled(child);
    return n;
  }

  let stalledBelow = $derived(render.kind === 'agent' ? countStalled(render) : 0);

  // Agents default to expanded — a tree whose branches are all shut is not a
  // tree — and tool payloads default to collapsed, because an 8 KB preview
  // inline would bury everything under it. `toggled` records the deviation
  // from that default, so nothing has to be seeded per node.
  let defaultExpanded = $derived(render.kind === 'agent');
  let isToggled = $derived(toggled.includes(render.node.id));
  let expanded = $derived(isToggled ? !defaultExpanded : defaultExpanded);

  let agentDuration = $derived(
    render.kind === 'agent' && render.node.endedAt !== undefined
      ? render.node.endedAt - render.node.startedAt
      : undefined,
  );

  function toggle(): void {
    store.toggleNode(render.node.id);
  }
</script>

{#if render.kind === 'agent'}
  <li
    class="node node-agent"
    data-testid="tree-node"
    data-kind="agent"
    data-node-id={render.node.id}
    data-depth={render.depth}
    data-spawn-depth={render.node.spawnDepth}
    data-spawned-by={render.spawnedByToolUseId ?? ''}
    data-expanded={String(expanded)}
  >
    <div class="row">
      <button
        class="twisty"
        type="button"
        data-testid="toggle"
        aria-expanded={expanded}
        onclick={toggle}
      >{expanded ? '▾' : '▸'}</button>
      <span class="agent-kind" data-testid="agent-kind">{render.node.kind}</span>
      <span class="label" data-testid="node-label">{render.node.label}</span>
      <StatusChip status={render.node.status} />
      {#if stalledBelow > 0}
        <!-- The agent's own status is untouched; a stall is a property of its
             TOOLS, and inventing a fourth agent status would create a value no
             producer writes. The badge is the agent-level surface. -->
        <span class="stall-badge" data-testid="stalled-badge" title="tools with no activity past the threshold"
          >{stalledBelow} stalled</span
        >
      {/if}
      <!-- Context level, not spend: see `events.ts`'s TokenPair for why the
           old `tokens.in` reported single digits on real sessions. Burn lives
           in the inspector, where there is room to label it. Optional-chained
           because an engine may report no context level at all. -->
      <span class="meta" data-testid="node-tokens"
        >{formatTokens(render.node.contextNow?.prompt)} in ctx / {formatTokens(
          render.node.contextNow?.output,
        )} out</span
      >
      <span class="meta" data-testid="node-duration">{formatDuration(agentDuration)}</span>
    </div>
    {#if expanded && render.children.length > 0}
      <ul class="children">
        {#each render.children as child (child.node.id)}
          <Self render={child} {store} {toggled} {now} />
        {/each}
      </ul>
    {/if}
  </li>
{:else}
  <li
    class="node node-tool"
    data-testid="tree-node"
    data-kind="tool"
    data-node-id={render.node.id}
    data-depth={render.depth}
    data-expanded={String(expanded)}
  >
    <div class="row">
      <button
        class="twisty"
        type="button"
        data-testid="toggle"
        aria-expanded={expanded}
        onclick={toggle}
      >{expanded ? '▾' : '▸'}</button>
      <span class="label" data-testid="node-label">{render.node.toolName}</span>
      <StatusChip status={render.node.status} {stalledForMs} toolName={render.node.toolName} />
      <span class="meta" data-testid="node-duration"
        >{formatDuration(render.node.durationMs)}</span
      >
    </div>
    <div class="payloads">
      <PayloadPreview label="input" text={render.node.inputPreview} {expanded} />
      {#if render.node.resultPreview !== undefined}
        <PayloadPreview label="result" text={render.node.resultPreview} {expanded} />
      {/if}
    </div>
    {#if render.children.length > 0}
      <!-- Subagents grafted here by `SessionState.spawnEdges`. They are NOT
           children of the tool node in the model — `ToolNode` has no
           `children` field — they are siblings joined by the edge. -->
      <ul class="children children-spawned" data-testid="spawned-children">
        {#each render.children as child (child.node.id)}
          <Self render={child} {store} {toggled} {now} />
        {/each}
      </ul>
    {/if}
  </li>
{/if}

<style>
  .node {
    list-style: none;
    margin: 0;
    padding: 0 0 0 2px;
    border-left: 1px solid var(--vscode-panel-border, transparent);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 1px 0;
  }

  .twisty {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 0 2px;
    width: 1.4em;
  }

  .label {
    font-weight: 600;
  }

  .agent-kind {
    font-size: 0.8em;
    opacity: 0.7;
    text-transform: uppercase;
  }

  .meta {
    font-size: 0.85em;
    opacity: 0.75;
    white-space: nowrap;
  }

  .stall-badge {
    font-size: 0.8em;
    padding: 0 5px;
    border-radius: 3px;
    white-space: nowrap;
    color: var(--vscode-charts-yellow, var(--vscode-badge-foreground));
    border: 1px solid var(--vscode-charts-yellow, var(--vscode-panel-border));
  }

  .children {
    margin: 0 0 0 12px;
    padding: 0;
  }

  .payloads {
    margin-left: 26px;
  }
</style>
