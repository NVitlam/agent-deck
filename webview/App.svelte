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
  import { LIVENESS_FILTERS, TESTID } from './canvas-contract.js';

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
    {#if view.viewMode === 'canvas'}
      <!-- The dock, spec C7.8: "The session dock is a <nav>". Phase 4.5 built
           the altitudes and shipped no visible way between them — Escape
           walked up and nothing said so. A keystroke nobody is told about is
           not navigation. -->
      <nav class="dock" data-testid={TESTID.dock} aria-label="Altitude" style="margin-right:auto">
        <button
          type="button"
          class="crumb"
          data-testid={TESTID.crumbDeck}
          aria-current={view.altitude === 'deck' ? 'page' : undefined}
          disabled={view.altitude === 'deck'}
          onclick={() => {
            // Walk all the way out, whatever altitude we are at, so one click
            // always means "back to the deck" rather than "up one".
            while (store.getView().altitude !== 'deck') store.escape();
          }}>Deck</button
        >
        {#if view.altitude !== 'deck' && view.selected !== undefined}
          <span class="sep" aria-hidden="true">▸</span>
          <span class="crumb here" data-testid={TESTID.crumbHere}
            >{view.selected.root.label !== ''
              ? view.selected.root.label
              : view.selected.sessionId}</span
          >
        {/if}
      </nav>

      {#if view.altitude === 'deck'}
        <!-- Liveness filter. View state only: `view.sessions` remains the
             host's full account and the count chip on the deck says "n of m",
             so a filter can never be mistaken for "this is all there is". -->
        <div class="filters" role="group" aria-label="Filter sessions">
          {#each LIVENESS_FILTERS as filter (filter)}
            <button
              type="button"
              class="chip"
              data-testid={TESTID.filterChip}
              data-filter={filter}
              data-active={String(view.livenessFilter === filter)}
              aria-pressed={view.livenessFilter === filter}
              onclick={() => store.setLivenessFilter(filter)}>{filter}</button
            >
          {/each}
        </div>

        <!-- Beside the filter, not on a row of its own. Says what is showing
             AND out of how many, so a filter can never read as "these are all
             the sessions there are". -->
        <span
          class="count"
          data-testid={TESTID.countChip}
          data-shown={String(view.filteredSessions.length)}
          data-total={String(view.sessions.length)}
          >{view.filteredSessions.length === view.sessions.length
            ? `${view.sessions.length} sessions`
            : `${view.filteredSessions.length} of ${view.sessions.length}`}</span
        >

        <!-- The membrane-colour key. The grammar is only legible if something
             states it; C7.3 defines it and nothing showed it. -->
        <span class="legend" data-testid={TESTID.legend}>
          <span class="key" data-liveness="live">live</span>
          <span class="key" data-liveness="idle">idle</span>
          <span class="key" data-liveness="ended">ended</span>
          <span class="key" data-liveness="unsupported">refused</span>
        </span>
      {/if}

      {#if view.altitude !== 'deck' && view.selectedNodeId !== undefined}
        <!-- Reopening. The close button existed; nothing reopened it, so a
             closed inspector could only come back by re-picking the node. -->
        <button
          type="button"
          class="chip"
          data-testid={TESTID.inspectorToggle}
          aria-pressed={view.inspectorOpen}
          onclick={() => store.setInspectorOpen(!view.inspectorOpen)}
          >{view.inspectorOpen ? 'Hide details' : 'Show details'}</button
        >
      {/if}
    {/if}

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
         ever does.

         THIS BRANCH IS WHY THE ENGINE FILTER IS STORE STATE. `<Deck>` is
         mounted only here, so it is DESTROYED on entering a session and
         rebuilt on returning. Anything the component held is gone; anything
         the store holds survives. The filter used to be the former and reset
         to `all` on every session visit, beside a liveness filter that did
         not. Both are now passed in and reported back. -->
    <main class="main" data-testid="main">
      <Deck
        sessions={view.filteredSessions}
        total={view.sessions.length}
        degraded={view.degraded}
        selectedSessionId={view.selectedSessionId}
        deckView={view.deckView}
        {reducedMotion}
        engineFilter={view.engineFilter}
        onenginefilter={(filter) => store.setEngineFilter(filter)}
        onenter={(id) => store.enterSession(id)}
        onpan={(dx, dy) => store.panDeck(dx, dy)}
        onzoom={(notches, x, y) => store.zoomDeck(notches, x, y)}
        onreset={() => store.resetDeckView()}
        onfit={(content, size) => store.fitDeck(content, size)}
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
            <!-- CONTEXT AND BURN, and this line is why `.svelte` files being
                 outside the type checker is a recorded hazard rather than a
                 note. On the hotfix this read `totals.inputTokens` /
                 `totals.outputTokens` until a `phase-verifier` caught it:
                 those two fields were REMOVED from the contract, `tsc` does
                 not see this file, eslint does not lint it, and
                 `formatTokens(undefined)` returns an em-dash - so the DEFAULT
                 view's token line rendered `— in · — out · —` on every
                 session, in the shipped artifact, in the release whose
                 changelog entry is about token counts being wrong. The tests
                 assert the VALUES, not the presence of a dash. -->
            <span class="hud-totals" data-testid="hud-totals">
              {formatTokens(view.selected.contextNow?.prompt)} in ctx ·
              {formatTokens(view.selected.burn?.prompt)} burn ·
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
          canvasView={view.canvasView}
          {reducedMotion}
          onselect={(id) => store.selectNode(id)}
          onpan={(dx, dy) => store.panCanvas(dx, dy)}
          onzoom={(factor, x, y) => store.zoomCanvas(factor, x, y)}
          onreset={() => store.resetCanvasView()}
        />
      </main>
      {#if view.inspectorOpen && view.selectedNode !== undefined}
        <aside class="aside">
          <Inspector
            node={inspected}
            toggled={view.toggledNodeIds}
            ontogglenode={(id) => store.toggleNode(id)}
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
    /* A drag across the canvas was selecting labels instead of panning, which
       is the classic way a pan control feels broken. Selection is off by
       default and turned back ON below for the two places a person actually
       needs to copy text: the inspector and the refusal/notice strip. */
    user-select: none;
    -webkit-user-select: none;
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
    /* Payload text is meant to be copied — that is most of what the inspector
       is for. */
    user-select: text;
    -webkit-user-select: text;
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

  .dock {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .crumb {
    font: inherit;
    font-size: 0.9em;
    color: var(--vscode-textLink-foreground, inherit);
    background: transparent;
    border: none;
    padding: 0 2px;
    cursor: pointer;
  }

  .crumb:disabled {
    color: var(--vscode-descriptionForeground, inherit);
    cursor: default;
  }

  .crumb.here {
    color: var(--vscode-foreground);
    max-width: 18em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sep {
    opacity: 0.6;
  }

  .filters {
    display: flex;
    gap: 4px;
  }

  .count {
    font-size: 0.85em;
    opacity: 0.8;
    white-space: nowrap;
  }

  .legend {
    display: flex;
    gap: 10px;
    font-size: 0.85em;
    opacity: 0.85;
  }

  .key::before {
    content: '';
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 4px;
    border-radius: 50%;
    background: currentColor;
  }

  .key[data-liveness='live'] {
    color: var(--vscode-charts-green, currentColor);
  }

  .key[data-liveness='idle'] {
    color: var(--vscode-charts-yellow, currentColor);
  }

  .key[data-liveness='ended'] {
    color: var(--vscode-descriptionForeground, currentColor);
  }

  .key[data-liveness='unsupported'] {
    color: var(--vscode-errorForeground, currentColor);
  }

  .chip {
    font: inherit;
    font-size: 0.85em;
    color: var(--vscode-foreground);
    background: transparent;
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 9px;
    padding: 0 8px;
    cursor: pointer;
  }

  .chip[data-active='true'],
  .chip[aria-pressed='true'] {
    background: var(--vscode-badge-background, transparent);
    color: var(--vscode-badge-foreground, inherit);
  }

  .crumb:focus-visible,
  .chip:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 1px;
  }

  .chrome {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
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
    user-select: text;
    -webkit-user-select: text;
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
