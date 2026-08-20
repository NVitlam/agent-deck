<script lang="ts">
  import type { Store, WebviewView } from './store.js';
  import DegradedBanner from './DegradedBanner.svelte';
  import RefusalScreen from './RefusalScreen.svelte';
  import SessionHeader from './SessionHeader.svelte';
  import SessionRail from './SessionRail.svelte';
  import TreeView from './TreeView.svelte';
  import { displayLiveness } from './format.js';

  let { store }: { store: Store } = $props();

  // The whole reactive surface of the webview is this one snapshot. `store` is
  // deliberately Svelte-free, so the component pulls a fresh plain view object
  // whenever the store says something changed. Nothing is derived and cached
  // across messages — re-reading is cheap and cannot drift from the host.
  //
  // `$state.raw`, not `$state`, and that is load-bearing rather than an
  // optimisation: `applySessionPatch` returns a DEEP-FROZEN `SessionState`,
  // and a deep $state proxy over a frozen object violates the Proxy invariant
  // for non-writable non-configurable properties (the get trap would have to
  // return a wrapped value where the target holds the raw one) and throws at
  // runtime. The view object is replaced wholesale on every change anyway, so
  // there is nothing for a deep proxy to observe. (The invariant itself was
  // measured, not assumed: a get trap returning a wrapped value for a frozen
  // property throws TypeError on this Node.)
  // svelte-ignore state_referenced_locally
  let view = $state.raw<WebviewView>(store.getView());

  $effect(() => {
    view = store.getView();
    return store.subscribe(() => {
      view = store.getView();
    });
  });

  // The whole panel's state in two attributes, so "which of the five states is
  // this?" has exactly one answer rather than one per component. `none` is not
  // a liveness value — it is the no-session-selected case, which is why it is
  // spelled differently from the four that are.
  let panelLiveness = $derived(
    view.selected === undefined
      ? 'none'
      : displayLiveness(view.selected.liveness, view.refused),
  );
</script>

<div
  class="app"
  data-testid="app"
  data-liveness={panelLiveness}
  data-refused={String(view.refused)}
  data-degraded={String(view.degraded)}
>
  {#if view.degraded && !view.degradedDismissed}
    <DegradedBanner reason={view.degradedReason} ondismiss={() => store.dismissDegraded()} />
  {/if}
  {#if view.patchFailure !== undefined}
    <!-- A patch that would not apply. Quiet, one line: the host is required to
         send a fresh snapshot, so this clears itself. It is NOT an error
         dialog and it does not block the last good tree. -->
    <div class="notice" role="status" data-testid="patch-failure">
      An update could not be applied ({view.patchFailure.message}); waiting for the
      next full snapshot.
    </div>
  {/if}
  <div class="body">
    <SessionRail
      sessions={view.sessions}
      selectedSessionId={view.selectedSessionId}
      onselect={(id) => store.selectSession(id)}
    />
    <main class="main" data-testid="main">
      {#if view.selected === undefined}
        <p class="empty" data-testid="no-selection">No session selected.</p>
      {:else if view.refused}
        <!-- G3: the refusal screen replaces the tree entirely. No header, no
             totals, no nodes — a partial render of an unrecognised layout is
             the failure mode this screen exists to prevent. -->
        <RefusalScreen sessionId={view.selected.sessionId} />
      {:else}
        <SessionHeader session={view.selected} degraded={view.degraded} />
        <TreeView session={view.selected} {store} toggled={view.toggledNodeIds} />
      {/if}
    </main>
  </div>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .main {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  .notice {
    padding: 3px 10px;
    font-size: 0.88em;
    opacity: 0.85;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }

  .empty {
    padding: 16px 20px;
    opacity: 0.75;
  }
</style>
