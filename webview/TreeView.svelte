<script lang="ts">
  import type { SessionState } from '../src/model/events.js';
  import type { Store } from './store.js';
  import { buildRenderTree } from './tree.js';
  import TreeNodeView from './TreeNodeView.svelte';

  let {
    session,
    store,
    toggled,
  }: { session: SessionState; store: Store; toggled: readonly string[] } = $props();

  // The trunk is the main agent; branches are subagents, drawn under the tool
  // call that spawned them by joining `SessionState.spawnEdges` (see tree.ts).
  let root = $derived(buildRenderTree(session));
</script>

<ul class="tree" data-testid="tree">
  <TreeNodeView render={root} {store} {toggled} />
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
