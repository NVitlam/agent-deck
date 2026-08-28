<!--
  Altitude 1 — the session tree — and altitude 1.5, the focus view.

  GEOMETRY IS `layout.ts:treeLayout`'s, all of it. This component calls it once
  per render and looks placements up BY ID. It computes no node coordinate of
  its own. The two families of number it does derive are the tool-dot row
  (`layout.ts:spawnDotPos`, also imported) and the parked rail, which is not a
  tree position at all — see below.

  PAN AND ZOOM ARE `viewport.ts`'s, all of it. `panBy`, `zoomAbout`, `fitTo`,
  `boundsOf`, `transformAttr`, `TREE_ZOOM_LIMITS`, `TREE_FIT_PADDING`. Nothing
  in this file does zoom arithmetic. There were two viewports in this package
  once — a component's own and the shared module's — internally consistent,
  disagreeing at the seam, with nothing failing; the duplicate was removed and
  this file is why it must not come back.

  THE TRANSFORM IS A TRANSFORM, NEVER A COORDINATE. It is written onto ONE
  wrapper `<g>`. A placement is never edited. That is what keeps `treeLayout`
  pure, keeps its goldens valid as numbers, and keeps "a spawn adds, it never
  reflows" true while a user drags the view around.

  THE VIEW STATE IS THIS COMPONENT'S, AND THAT IS DELIBERATE. The focus root,
  the collapse depth and the viewport are `$state.raw` locals. They are not
  props, and they are not read from the store — so a snapshot or a diff cannot
  reset them, which is exactly the DoD 7.4 requirement that the transform
  survives a store update. The `canvasView`/`onpan`/`onzoom`/`onreset` props
  are still accepted because `App.svelte` passes them and is not this package's
  file to edit; they are NOT the source of the rendered transform, because two
  sources of one number is the seam this file already paid for once.

  THE FILAMENT COMES FROM `spawnEdges` AND FROM NOTHING ELSE. Not from tree
  adjacency, not from proximity: `ToolNode` has no `children`, so the spawn
  relationship exists ONLY in `SessionState.spawnEdges` — the host's copy of
  the sidecar's `meta.toolUseId` primary-key join. An edge whose spawning DOT
  or whose child NODE is not drawn produces nothing, because the honest
  alternative to a curve with one end missing is no curve.

  THE PARKED RAIL IS G3 MADE VISIBLE. An unresolved graft has NO NODE IN THE
  TREE — the grafter deliberately left it off `root`, so `SessionState.parked`
  is the only record it exists. It goes on a labelled rail to the RIGHT of the
  tree, with its stable code on its face, and it NEVER orbits and never
  attaches. The rail shows only at the session root: at a focus depth it would
  be claiming the parked item belongs to the subtree being looked at, which is
  precisely the guess G3 forbids.

  DOM ORDER IS THE TREE, NEVER THE GEOMETRY (C7.8): each node, then its own
  tool dots, then the next node in pre-order. Filaments are drawn in a separate
  group underneath so painting order cannot dictate reading order; they are
  decorative paths with no focus and no accessible name, so they do not enter
  it.

  ZERO HOST CHANGE (C7.7). Picking a node or a dot calls back to
  `Store.selectNode`, which posts nothing. Focus, collapse and the viewport are
  webview-local and reach no message at all.
-->
<script lang="ts">
  import type { AgentNode, SessionState, ToolNode } from '../src/model/events.js';
  import { isAgentNode } from '../src/model/events.js';
  import { REDUCED_MOTION_CLASS, TESTID } from './canvas-contract.js';
  import type { TreePlacement } from './layout.js';
  import {
    AUTO_COLLAPSE_NODES,
    COLLAPSE_DEPTH,
    NODE_H,
    NODE_W_MIN,
    autoCollapseDepth,
    spawnDotPos,
    toolChildren,
    treeLayout,
    truncateLabel,
    visibleNodeCount,
  } from './layout.js';
  import { findAgent } from './tree.js';
  import type { Viewport } from './viewport.js';
  import {
    IDENTITY_VIEWPORT,
    TREE_FIT_PADDING,
    TREE_ZOOM_LIMITS,
    boundsOf,
    fitTo,
    panBy,
    transformAttr,
    zoomAbout,
  } from './viewport.js';
  import AgentCell from './AgentCell.svelte';
  import Filament from './Filament.svelte';
  import ToolDot from './ToolDot.svelte';

  let {
    session,
    refused = false,
    degraded = false,
    selectedNodeId,
    reducedMotion = false,
    onselect,
    ondeck,
    size = { width: 960, height: 640 },
    canvasView,
    onpan,
    onzoom,
    onreset,
  }: {
    /** The session being looked at. Read, never mutated (G1). */
    session: SessionState;
    /**
     * Refused by a `schemaMismatch` message rather than by the session's own
     * `schemaOk` flag — the half of the store's refusal set that is not
     * recoverable from a `SessionState`. Unioned below with that flag and with
     * `liveness === 'unsupported'`, refusing on any of them because that is
     * the safe direction.
     */
    refused?: boolean;
    /** The hook tap is silent: an active node's box goes dash-hollow (G2). */
    degraded?: boolean;
    /** The store's selected node, if the inspector is open on one. */
    selectedNodeId?: string | undefined;
    /** The user prefers reduced motion. Swapped by class, never by query alone. */
    reducedMotion?: boolean;
    /** Wired to `Store.selectNode` — opens the inspector (C7.8). */
    onselect?: ((nodeId: string) => void) | undefined;
    /**
     * Leave altitude 1 entirely. Escape at the SESSION ROOT is the only thing
     * that calls it — at any focus depth Escape re-roots on the parent first,
     * so the ladder is "out of the subtree, then out of the session".
     */
    ondeck?: (() => void) | undefined;
    /**
     * Client-pixel size of the field, for {@link fitTo}. A PROP, not a
     * measurement, for the reason `deckLayout` takes its width as an
     * argument: a fit that depended on a live `getBoundingClientRect` could
     * not be pinned by a test at all. The live rectangle is preferred when
     * the element has one, and jsdom never gives one.
     */
    size?: { width: number; height: number };
    /**
     * Accepted for `App.svelte`'s sake and deliberately NOT the source of the
     * rendered transform. See the header: the viewport is this component's
     * own state, which is what makes it survive a store update.
     */
    canvasView?: { x: number; y: number; k: number } | undefined;
    onpan?: ((dx: number, dy: number) => void) | undefined;
    onzoom?: ((factor: number, originX: number, originY: number) => void) | undefined;
    onreset?: (() => void) | undefined;
  } = $props();

  /** Above this many tool calls the row draws {@link DOT_KEEP} and a `+N`. */
  const DOT_LIMIT = 24;
  /** How many calls the row keeps when it overflows: the LAST 23. */
  const DOT_KEEP = 23;
  /** Clear space between the widest node and the parked rail. */
  const RAIL_GAP = 64;
  /** The rail's dashed rule sits this far left of the rail's items. */
  const RAIL_RULE_DX = 24;
  /** Vertical gap between two parked items. */
  const RAIL_ITEM_GAP = 12;
  /** The rail's label baseline. */
  const RAIL_LABEL_Y = -4;
  /** Where the first parked item sits. */
  const RAIL_TOP_Y = 8;
  /** The rail's normative label. It says what the state MEANS, not its code. */
  const RAIL_LABEL = 'PARKED · not guessed';

  /* --------------------------------------------------------------------- *
   * View state. Component-local by design — see the header.
   * --------------------------------------------------------------------- */

  /**
   * The node the tree is drawn from. `session.root.id` is altitude 1.
   *
   * Read from the prop ONCE, as an initial value, which is exactly what the
   * suppressed warning is about and exactly what is wanted: a later change to
   * `session` must not silently drag the user back to the session root. When
   * `focusId` names nothing in the current tree, `rootId` below resolves it —
   * that is a derivation, not a reset, and it is the only thing that moves the
   * focus without the user asking.
   */
  // svelte-ignore state_referenced_locally
  let focusId = $state.raw<string>(session.root.id);
  /** The viewport. A transform, never a coordinate. */
  let view = $state.raw<Viewport>(IDENTITY_VIEWPORT);
  /** The user's collapse depth, when they have expressed one (`K`). */
  let userCollapse = $state.raw<number | undefined>(undefined);
  /** Drag state for the pan. */
  let panning = $state.raw(false);
  let lastX = 0;
  let lastY = 0;
  let fieldEl: SVGSVGElement | undefined = $state.raw(undefined);

  /*
   * G3, from this side of the seam. A refused session draws no tree at all —
   * not a partial one. The disjunction is the same one the store's refusal set
   * carries, restated here because the component must be able to refuse on its
   * own account: `schemaOk` is the session's word for it and `refused` is the
   * `schemaMismatch` message's, and they arrive by different routes.
   */
  let isRefused = $derived(
    refused || session.schemaOk === false || session.liveness === 'unsupported',
  );

  /** Every agent in the session, by id. One walk, reused by every derivation. */
  let agentsById = $derived.by(() => {
    const map = new Map<string, AgentNode>();
    const visit = (node: AgentNode): void => {
      if (map.has(node.id)) return;
      map.set(node.id, node);
      for (const child of node.children) if (isAgentNode(child)) visit(child);
    };
    visit(session.root);
    return map;
  });

  /**
   * The root actually laid out.
   *
   * Falls back to the session root when `focusId` names nothing in this tree,
   * which is what happens when the selected session changes underneath a focus
   * — a focus on an id from another session is not a state to defend against
   * downstream, it is one to resolve here.
   */
  let rootId = $derived(
    findAgent(session.root, focusId) !== undefined ? focusId : session.root.id,
  );
  let atSessionRoot = $derived(rootId === session.root.id);

  /** The >300-node rule. ONE implementation, in `layout.ts`; this reads it. */
  let autoDepth = $derived(autoCollapseDepth(session, rootId));
  let collapseDepth = $derived(userCollapse ?? autoDepth);
  let autoCollapsed = $derived(
    userCollapse === undefined && autoDepth !== Number.POSITIVE_INFINITY,
  );

  let placements = $derived(
    isRefused ? [] : treeLayout(session, rootId, { collapseDepth }),
  );
  let drawn = $derived(placements.filter((p) => !p.hidden));

  /** One drawn node, with the dot row that belongs to it. */
  interface DrawnNode {
    placement: TreePlacement;
    agent: AgentNode;
    /** The dots actually drawn, in transcript order, already positioned. */
    dots: { tool: ToolNode; x: number; y: number; spawns: boolean }[];
    /** Calls the cap did not draw. 0 when nothing overflowed. */
    overflow: number;
    /** Where the `+N` glyph goes. Only read when `overflow > 0`. */
    overflowAt: { x: number; y: number };
  }

  /** `tool_use` ids that spawned a subagent: one pass over the edges. */
  let spawningToolIds = $derived.by(() => {
    const ids = new Set<string>();
    for (const edge of session.spawnEdges ?? []) ids.add(edge.toolUseId);
    return ids;
  });

  let nodes = $derived.by((): DrawnNode[] => {
    const out: DrawnNode[] = [];
    for (const placement of drawn) {
      const agent = agentsById.get(placement.id);
      if (agent === undefined) continue;
      const tools = toolChildren(agent);
      // THE LAST 23, not the first: what is happening now is at the end. The
      // `+N` takes dot 0's place, so the row still reads left to right in
      // time and the elision is where the drawing stops rather than a gap in
      // the middle of it.
      const overflow = tools.length > DOT_LIMIT ? tools.length - DOT_KEEP : 0;
      const shown = overflow > 0 ? tools.slice(-DOT_KEEP) : tools;
      const count = overflow > 0 ? shown.length + 1 : shown.length;
      const offset = overflow > 0 ? 1 : 0;
      out.push({
        placement,
        agent,
        overflow,
        overflowAt: spawnDotPos(placement, count, 0),
        dots: shown.map((tool, i) => {
          const at = spawnDotPos(placement, count, i + offset);
          return { tool, x: at.x, y: at.y, spawns: spawningToolIds.has(tool.id) };
        }),
      });
    }
    return out;
  });

  let byId = $derived(new Map(nodes.map((n) => [n.placement.id, n])));

  /** An agent is ACTIVE when it holds the cursor or an in-flight tool call. */
  function isActive(agent: AgentNode | undefined): boolean {
    if (agent === undefined) return false;
    return agent.status === 'running' || toolChildren(agent).some((t) => t.status === 'running');
  }

  interface DrawnFilament {
    toolUseId: string;
    agentId: string;
    from: { x: number; y: number };
    to: { x: number; y: number };
    state: 'default' | 'live' | 'dim';
  }

  /**
   * The filaments. THE JOIN, AND ONLY THE JOIN.
   *
   * One pass over `spawnEdges`; every endpoint is looked up by one of the
   * edge's own ids. Nothing here reads the tree's shape. An agent claimed by
   * two edges keeps the first, so a duplicate edge cannot draw twice.
   */
  let filaments = $derived.by((): DrawnFilament[] => {
    if (isRefused) return [];
    const out: DrawnFilament[] = [];
    const claimed = new Set<string>();
    for (const edge of session.spawnEdges ?? []) {
      if (claimed.has(edge.agentId)) continue;
      const parent = byId.get(edge.parentNodeId);
      const child = byId.get(edge.agentId);
      if (parent === undefined || child === undefined) continue;
      // The spawning DOT, not the parent node: the filament's whole claim is
      // that THIS call made that agent. A call the cap elided has no drawn
      // dot, so it draws no curve rather than one from somewhere plausible.
      const dot = parent.dots.find((d) => d.tool.id === edge.toolUseId);
      if (dot === undefined) continue;
      claimed.add(edge.agentId);
      out.push({
        toolUseId: edge.toolUseId,
        agentId: edge.agentId,
        from: { x: dot.x, y: dot.y },
        to: {
          x: child.placement.x + child.placement.w / 2,
          y: child.placement.y,
        },
        state: isActive(child.agent) ? 'live' : 'dim',
      });
    }
    return out;
  });

  /* --------------------------------------------------------------------- *
   * The parked rail
   * --------------------------------------------------------------------- */

  let railX = $derived(
    drawn.reduce((max, p) => Math.max(max, p.x + p.w), 0) + RAIL_GAP,
  );

  let parkedItems = $derived.by(() => {
    // ONLY AT THE SESSION ROOT. A rail beside a subtree would be claiming the
    // parked item belongs to that subtree, which is the guess G3 forbids.
    if (isRefused || !atSessionRoot) return [];
    return (session.parked ?? []).map((entry, i) => ({
      entry,
      placement: {
        x: railX,
        y: RAIL_TOP_Y + i * (NODE_H + RAIL_ITEM_GAP),
        w: NODE_W_MIN,
      },
    }));
  });

  /* --------------------------------------------------------------------- *
   * The breadcrumb — the ancestor chain, and nothing inferred
   * --------------------------------------------------------------------- */

  /**
   * From the session root down to the focus target, inclusive.
   *
   * Walked over `children` with the path carried along, so the chain is the
   * tree's own parent relation rather than a second opinion about it. DoD 7.6
   * requires it to equal the `parentAgentId` chain, and `canvas.test.ts`
   * asserts exactly that by re-deriving the chain from `spawnEdges`.
   */
  let crumbs = $derived.by(() => {
    const path: AgentNode[] = [];
    const walk = (node: AgentNode, trail: AgentNode[]): boolean => {
      const here = [...trail, node];
      if (node.id === rootId) {
        path.push(...here);
        return true;
      }
      for (const child of node.children) {
        if (isAgentNode(child) && walk(child, here)) return true;
      }
      return false;
    };
    walk(session.root, []);
    return path;
  });

  /* --------------------------------------------------------------------- *
   * Focus, collapse and the viewport
   * --------------------------------------------------------------------- */

  function fieldSize(): { width: number; height: number } {
    const rect = fieldEl?.getBoundingClientRect();
    if (rect !== undefined && rect.width > 0 && rect.height > 0) {
      return { width: rect.width, height: rect.height };
    }
    return size;
  }

  /** Everything on the stage, as extents, for {@link fitTo}. */
  function extentsFor(list: readonly TreePlacement[]): { x: number; y: number; w: number; h: number }[] {
    return list.map((p) => ({ x: p.x, y: p.y, w: p.w, h: NODE_H }));
  }

  function fitPlacements(list: readonly TreePlacement[]): void {
    view = fitTo(boundsOf(extentsFor(list)), fieldSize(), TREE_FIT_PADDING, TREE_ZOOM_LIMITS);
  }

  /**
   * Re-root, and fit ONCE.
   *
   * The fit is computed against the NEW layout rather than the one on screen,
   * because the thing being framed is what the user is about to see. Nothing
   * else in this component calls `fitTo` except the explicit double-click on
   * empty field.
   */
  function focusOn(nodeId: string): void {
    if (findAgent(session.root, nodeId) === undefined) return;
    focusId = nodeId;
    const next = treeLayout(session, nodeId, { collapseDepth }).filter((p) => !p.hidden);
    fitPlacements(next);
  }

  const INTERACTIVE = `[data-testid="${TESTID.cell}"],[data-testid="${TESTID.nucleus}"],[data-testid="${TESTID.dot}"],[data-testid="${TESTID.elidedBadge}"]`;

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    // A drag that starts on a node or a dot belongs to that element, or
    // panning would swallow the click that opens the inspector.
    if (target !== null && target.closest(INTERACTIVE) !== null) return;
    panning = true;
    lastX = event.clientX;
    lastY = event.clientY;
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!panning) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    view = panBy(view, dx, dy);
    onpan?.(dx, dy);
  }

  function endPan(event: PointerEvent): void {
    if (!panning) return;
    panning = false;
    (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    const rect = (event.currentTarget as Element).getBoundingClientRect();
    const notches = event.deltaY < 0 ? 1 : -1;
    const next = zoomAbout(
      view,
      event.clientX - rect.left,
      event.clientY - rect.top,
      notches,
      TREE_ZOOM_LIMITS,
    );
    if (next === view) return;
    onzoom?.(next.k / view.k, event.clientX - rect.left, event.clientY - rect.top);
    view = next;
  }

  function onDoubleClick(event: MouseEvent): void {
    // A double-click on a node re-roots, and that is the node's own handler.
    // Only the empty field fits.
    const target = event.target as Element | null;
    if (target !== null && target.closest(INTERACTIVE) !== null) return;
    fitPlacements(drawn);
  }

  function resetView(): void {
    view = IDENTITY_VIEWPORT;
    onreset?.();
  }

  /**
   * The keyboard ladder.
   *
   * Escape RE-ROOTS ON THE PARENT while there is one, and is stopped there so
   * `App.svelte`'s window handler does not also walk the altitude down. At the
   * session root it is NOT stopped: that is the case where leaving altitude 1
   * is the right answer, and `ondeck` is called for a caller that wants to
   * hear it directly.
   *
   * `K` sets the collapse depth to `COLLAPSE_DEPTH`, and toggles back off.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (atSessionRoot) {
        ondeck?.();
        return;
      }
      const parent = crumbs[crumbs.length - 2];
      if (parent === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      focusOn(parent.id);
      return;
    }
    if (event.key === 'k' || event.key === 'K') {
      event.preventDefault();
      userCollapse =
        userCollapse === COLLAPSE_DEPTH ? Number.POSITIVE_INFINITY : COLLAPSE_DEPTH;
    }
  }

  let transform = $derived(transformAttr(view));
  let atIdentity = $derived(view.x === 0 && view.y === 0 && view.k === 1);
  let hiddenTotal = $derived(
    drawn.reduce((sum, p) => sum + p.hiddenDescendants, 0),
  );
  let totalNodes = $derived(isRefused ? 0 : visibleNodeCount(session, rootId));

  /**
   * The status line. It has to SAY when the auto-collapse fired: a tree that
   * silently stopped drawing two thirds of itself is a tree the user reads as
   * complete.
   */
  let statusText = $derived(
    isRefused
      ? 'refused — no tree is drawn for this session'
      : autoCollapsed
        ? `${String(drawn.length)} of ${String(totalNodes)} nodes — collapsed to depth ${String(COLLAPSE_DEPTH)} automatically above ${String(AUTO_COLLAPSE_NODES)} nodes; ${String(hiddenTotal)} hidden`
        : `${String(drawn.length)} of ${String(totalNodes)} nodes${hiddenTotal > 0 ? `, ${String(hiddenTotal)} hidden` : ''}`,
  );
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class={reducedMotion ? `canvas ${REDUCED_MOTION_CLASS}` : 'canvas'}
  data-testid={TESTID.canvas}
  data-session-id={session.sessionId}
  data-refused={String(isRefused)}
  data-degraded={String(degraded)}
  data-root-id={rootId}
  data-at-session-root={String(atSessionRoot)}
  data-collapse-depth={String(collapseDepth)}
  data-auto-collapsed={String(autoCollapsed)}
  data-cells={String(nodes.length)}
  data-dots={String(nodes.reduce((n, node) => n + node.dots.length, 0))}
  data-parked={String(parkedItems.length)}
  aria-label="Session tree"
  onkeydown={onKeyDown}
>
  <div class="bar">
    <!-- The breadcrumb. Every ancestor is a real button, and the path is the
         tree's own parent chain — see `crumbs` above. -->
    <nav class="crumbs" data-testid="tree-crumbs" aria-label="Focus path">
      <button
        type="button"
        class="crumb"
        data-testid="tree-crumb-deck"
        onclick={() => ondeck?.()}>deck</button
      >
      {#each crumbs as crumb, i (crumb.id)}
        <span class="sep" aria-hidden="true">/</span>
        <button
          type="button"
          class="crumb"
          data-testid="tree-crumb"
          data-crumb-id={crumb.id}
          data-crumb-index={String(i)}
          aria-current={crumb.id === rootId ? 'page' : undefined}
          onclick={() => focusOn(crumb.id)}
          >{i === 0
            ? session.root.label !== ''
              ? truncateLabel(session.root.label)
              : session.sessionId
            : truncateLabel(crumb.label)}</button
        >
      {/each}
    </nav>
    <span class="status" data-testid="tree-status" data-nodes={String(drawn.length)}
      >{statusText}</span
    >
    <!-- Always present, never conditional on the view being off-identity: a
         control that appears only once you are lost is a control you cannot
         learn. `data-identity` says whether pressing it would change
         anything. -->
    <button
      class="reset"
      type="button"
      data-testid={TESTID.canvasReset}
      data-identity={String(atIdentity)}
      onclick={resetView}>Reset view</button
    >
  </div>

  {#if !isRefused}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <svg
      bind:this={fieldEl}
      class="field"
      class:panning
      role="group"
      aria-label="Session tree"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={endPan}
      onpointercancel={endPan}
      onwheel={onWheel}
      ondblclick={onDoubleClick}
    >
      <g data-testid={TESTID.canvasStage} {transform}>
        <!-- Filaments FIRST so they paint UNDER every node and dot. They carry
             no focus and no accessible name, so painting order does not become
             reading order (C7.8). -->
        <g class="filaments">
          {#each filaments as filament (filament.agentId)}
            <Filament
              from={filament.from}
              to={filament.to}
              toolUseId={filament.toolUseId}
              agentId={filament.agentId}
              state={filament.state}
            />
          {/each}
        </g>
        <g class="nodes">
          {#each nodes as node (node.placement.id)}
            <AgentCell
              agent={node.agent}
              placement={node.placement}
              root={node.placement.depth === 0}
              selected={node.agent.id === selectedNodeId}
              {degraded}
              {reducedMotion}
              {onselect}
              onfocus={focusOn}
            />
            {#if node.overflow > 0}
              <ToolDot overflow={node.overflow} placement={node.overflowAt} />
            {/if}
            {#each node.dots as dot (dot.tool.id)}
              <ToolDot
                tool={dot.tool}
                placement={{ x: dot.x, y: dot.y }}
                spawns={dot.spawns}
                selected={dot.tool.id === selectedNodeId}
                {onselect}
              />
            {/each}
          {/each}
        </g>
        {#if parkedItems.length > 0}
          <!-- G3, drawn. Off the tree, on a labelled rail, with the stable
               code on the face of each item. Last in DOM order because it is
               last in the store's account of the session: everything with a
               node comes first. -->
          <g class="rail" data-testid="parked-rail" data-x={String(railX)}>
            <path
              class="rail-rule"
              data-testid="parked-rail-rule"
              d={`M ${railX - RAIL_RULE_DX} ${RAIL_LABEL_Y - 12} L ${railX - RAIL_RULE_DX} ${
                RAIL_TOP_Y + parkedItems.length * (NODE_H + RAIL_ITEM_GAP)
              }`}
            />
            <text class="rail-label" data-testid="parked-rail-label" x={railX} y={RAIL_LABEL_Y}
              >{RAIL_LABEL}</text
            >
            {#each parkedItems as item (item.entry.agentId)}
              <AgentCell parked={item.entry} placement={item.placement} />
            {/each}
          </g>
        {/if}
      </g>
    </svg>
  {/if}
</section>

<style>
  .field {
    touch-action: none;
    cursor: grab;
  }

  .field.panning {
    cursor: grabbing;
  }

  .bar {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    padding: 3px 8px;
    font-size: 0.85em;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }

  .crumbs {
    display: flex;
    align-items: baseline;
    gap: 3px;
    min-width: 0;
  }

  .crumb {
    font: inherit;
    color: var(--vscode-textLink-foreground, inherit);
    background: transparent;
    border: none;
    padding: 0 2px;
    cursor: pointer;
  }

  .crumb[aria-current='page'] {
    color: var(--vscode-foreground);
    font-weight: 600;
  }

  .crumb:focus-visible,
  .reset:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 1px;
  }

  .sep {
    opacity: 0.6;
  }

  .status {
    margin-left: auto;
    opacity: 0.75;
    font-variant-numeric: tabular-nums;
  }

  .reset {
    font: inherit;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 3px;
    padding: 0 6px;
    cursor: pointer;
  }

  /* Every colour is a VS Code theme variable. The frozen mockup hardcodes a
     dark palette only because it lives outside VS Code (C7.7). */
  .canvas {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }

  .field {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: block;
  }

  .rail-rule {
    fill: none;
    stroke: var(--vscode-editorWarning-foreground, currentColor);
    stroke-width: 1;
    stroke-dasharray: 5 6;
    opacity: 0.7;
  }

  .rail-label {
    fill: var(--vscode-editorWarning-foreground, currentColor);
    font-size: 9.5px;
    letter-spacing: 0.06em;
  }
</style>
