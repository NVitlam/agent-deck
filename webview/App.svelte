<script lang="ts">
  import type { Store, WebviewView } from './store.js';
  import DegradedBanner from './DegradedBanner.svelte';
  import RefusalScreen from './RefusalScreen.svelte';
  import SessionHeader from './SessionHeader.svelte';
  import SessionRail from './SessionRail.svelte';
  import TreeView from './TreeView.svelte';
  import Deck from './Deck.svelte';
  import SessionCanvas from './SessionCanvas.svelte';
  import Inspector from './Inspector.svelte';
  import { displayLiveness, formatTokens } from './format.js';
  import { TESTID } from './canvas-contract.js';

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

  // C7.6: `prefers-reduced-motion` is swapped BY CLASS, not by media query
  // alone, and this is where the query is read once and handed down as a plain
  // boolean. Reading it here rather than in each component is what makes the
  // rule assertable in jsdom, where the query does not evaluate: a test sets
  // this prop and every animated element responds.
  //
  // Guarded because `matchMedia` is absent in jsdom and in a bare Node test
  // host. Absent means "no preference expressed", which is the same answer as
  // a query that returns false — never a throw, and never a reason for the
  // panel not to render.
  const prefersReducedMotion = (): boolean => {
    const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
    if (typeof mm !== 'function') return false;
    try {
      return mm('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  };
  let reducedMotion = $state.raw(prefersReducedMotion());

  // Escape walks the altitudes up (C7.8): inspector -> session interior -> deck.
  // The walk itself lives in `store.escape()`, not here — this only routes the
  // key to it, and only in canvas mode, so the list view's own keyboard
  // behaviour is untouched.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (view.viewMode !== 'canvas') return;
    if (view.altitude === 'deck') return;
    event.preventDefault();
    store.escape();
  };

  let inspected = $derived(view.selectedNode);
  let inspectedExpanded = $derived(
    inspected !== undefined && view.toggledNodeIds.includes(inspected.id),
  );
</script>

<svelte:window on:keydown={onKeyDown} />

<div
  class="app"
  data-testid="app"
  data-liveness={panelLiveness}
  data-refused={String(view.refused)}
  data-degraded={String(view.degraded)}
  data-view-mode={view.viewMode}
  data-altitude={view.altitude}
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

  <!-- The list/canvas switch is an IN-PANEL control, not a VS Code command and
       not a configuration key. That is deliberate and is what keeps this phase
       free of a host-manifest diff: a setting would be a `package.json`
       contribution (spec C7.2). The canvas is the default immediately. -->
  <div class="chrome">
    <button
      type="button"
      class="toggle"
      data-testid={TESTID.viewToggle}
      data-view-mode={view.viewMode}
      aria-pressed={view.viewMode === 'canvas'}
      onclick={() => store.toggleViewMode()}
    >
      {view.viewMode === 'canvas' ? 'Canvas' : 'List'}
    </button>
  </div>

  {#if view.viewMode === 'list'}
    <!-- Phase 3's renderer, kept for one release behind the toggle (C7.2).
         Both surfaces are projections of the same store, so the state grammar
         holds for both while both exist. -->
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
  {:else if view.altitude === 'deck' || view.selected === undefined}
    <!-- Altitude 0. Also the fallback when nothing is selected: an altitude
         above the deck with no session to show is not a state the store should
         be able to reach, and rendering the deck is the honest answer if it
         ever does. -->
    <main class="main" data-testid="main">
      <Deck
        sessions={view.sessions}
        degraded={view.degraded}
        selectedSessionId={view.selectedSessionId}
        {reducedMotion}
        onenter={(id) => store.enterSession(id)}
      />
    </main>
  {:else}
    <!-- Altitudes 1 and 2. The inspector is a panel BESIDE the interior, not a
         replacement for it: selecting a node should not hide the thing the
         node belongs to. -->
    <div class="body">
      <main class="main" data-testid="main">
        <!-- The HUD carries what the list view puts in its session header:
             totals, and the degraded chip. It is part of the canvas chrome
             rather than of the interior, so it survives a refusal - the one
             thing a refused session may still say is that it refused. -->
        <div class="hud" data-testid={TESTID.hud}>
          <span class="hud-id">{view.selected.sessionId}</span>
          {#if view.degraded}
            <!-- C7.3: liveness is being INFERRED from the JSONL tap because the
                 hook tap is silent. The chip says so rather than showing the
                 same confident green a hook event would have earned (G2). -->
            <span class="hud-chip" data-testid={TESTID.hudDegradedChip}>
              liveness inferred — hooks silent
            </span>
          {/if}
          {#if !view.refused}
            <span class="hud-totals" data-testid="hud-totals">
              {formatTokens(view.selected.totals.inputTokens)} in ·
              {formatTokens(view.selected.totals.outputTokens)} out ·
              <!-- Cost is an em-dash, never 0. The host sends 0 meaning NOT
                   COMPUTED, and 0 rendered as a number reads as "free", which
                   is a fabricated figure - the same class of defect as a
                   truncation marker that under-reports. -->
              <span title="not computed">—</span>
            </span>
          {/if}
        </div>
        <!-- G3 on a new surface. C7.4: entering a refused session shows the
             refusal card AND zero interior elements.
             `SessionCanvas` stays mounted either way, and that is deliberate
             rather than incidental: it decides emptiness from its OWN layout,
             independently of this branch, so the zero is asserted twice - here
             by the absence of cells and dots, and there by `sessionLayout`
             returning four empty maps. Swapping the component out instead
             would have removed the second guard and, with it, the element that
             carries `data-refused` for anyone checking the interior's own
             account of itself. -->
        {#if view.refused}
          <RefusalScreen sessionId={view.selected.sessionId} />
        {/if}
        <SessionCanvas
          session={view.selected}
          refused={view.refused}
          degraded={view.degraded}
          selectedNodeId={view.selectedNodeId}
          {reducedMotion}
          onselect={(id) => store.selectNode(id)}
        />
      </main>
      {#if view.altitude === 'inspector'}
        <aside class="aside">
          <Inspector
            node={inspected}
            expanded={inspectedExpanded}
            ontoggle={() => {
              if (inspected !== undefined) store.toggleNode(inspected.id);
            }}
            onclose={() => store.escape()}
          />
        </aside>
      {/if}
    </div>
  {/if}
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

  .aside {
    width: 22em;
    max-width: 45%;
    overflow: auto;
    border-left: 1px solid var(--vscode-panel-border, transparent);
  }

  .hud {
    display: flex;
    gap: 10px;
    align-items: baseline;
    flex-wrap: wrap;
    padding: 4px 10px;
    font-size: 0.88em;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }

  .hud-id {
    font-family: var(--vscode-editor-font-family, monospace);
    opacity: 0.75;
  }

  .hud-chip {
    padding: 0 6px;
    border-radius: 8px;
    color: var(--vscode-badge-foreground, inherit);
    background: var(--vscode-badge-background, transparent);
  }

  .hud-totals {
    margin-left: auto;
    opacity: 0.85;
  }

  .chrome {
    display: flex;
    justify-content: flex-end;
    padding: 2px 6px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }

  .toggle {
    font: inherit;
    color: var(--vscode-foreground);
    background: var(--vscode-badge-background, transparent);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 3px;
    padding: 1px 8px;
    cursor: pointer;
  }

  .toggle:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 1px;
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
