<script lang="ts">
  import type { SessionState } from '../src/model/events.js';
  import type { Store } from './store.js';
  import { buildRenderTree } from './tree.js';
  import TreeNodeView from './TreeNodeView.svelte';

  let {
    session,
    store,
    toggled,
    now = undefined,
  }: {
    session: SessionState;
    store: Store;
    toggled: readonly string[];
    /** The renderer's clock, threaded to a stalled tool's elapsed time. */
    now?: number | undefined;
  } = $props();

  // The trunk is the main agent; branches are subagents, drawn under the tool
  // call that spawned them by joining `SessionState.spawnEdges` (see tree.ts).
  let root = $derived(buildRenderTree(session));
</script>

<ul class="tree" data-testid="tree">
  <TreeNodeView render={root} {store} {toggled} {now} />
</ul>

<style>
  .tree {
    list-style: none;
    margin: 0;
    padding: 6px 10px;
    overflow: auto;
    flex: 1;
  }
</style>
