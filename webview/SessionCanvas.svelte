<!--
  Altitude 1 — the session interior (spec C7.1).

  The main agent is the nucleus at centre; tool calls are dots on a
  chronological arc around their agent; a subagent cell sits at the angle of
  the exact tool dot that spawned it, attached to that dot by a FILAMENT
  (C7.4); depth >= 2 nests identically around its parent cell.

  GEOMETRY IS `layout.ts`'s, all of it. This component calls `sessionLayout`
  once and looks placements up BY ID — `cells` by `AgentNode.id`, `dots` by
  `ToolNode.id`, `parked` by `ParkedGraft.agentId`. It computes no coordinate
  of its own. The one number it derives is the SVG `viewBox`, which is viewport
  fitting rather than layout: a transform of already-placed coordinates, never
  a re-placement of them, exactly as `Deck.svelte` does at altitude 0.

  THE FILAMENT COMES FROM `spawnEdges` AND FROM NOTHING ELSE. Not from tree
  adjacency, not from `parentAgentId`, not from proximity: `ToolNode` has no
  `children`, so the spawn relationship exists ONLY in `SessionState.spawnEdges`
  — the host's copy of the sidecar's `meta.toolUseId` primary-key join. The
  loop below is the whole derivation and it iterates that array. An edge whose
  two ids are not both placed draws NOTHING, because the honest alternative to
  a filament with one end missing is no filament.

  THREE THINGS ABOUT THE LAYOUT MAPS THAT SHAPE THIS FILE:

   - A `ToolNode` MAY HAVE NO ENTRY IN `dots`. Either `DOT_CAP` elided it, or
     another agent's tool call already owns that id — a `tool_use` id is not
     unique across a session tree, and `sessionLayout` is first-writer-wins.
     Such a tool renders no dot, and the elided remainder is a `+n` badge on
     its agent's cell instead. Never assume the map has every tool.
   - `cells` AND `parked` ARE DISJOINT, and a parked agent has NO NODE IN THE
     TREE. So parked cells cannot come from the tree walk; they come from
     `session.parked` zipped against `layout.parked`, and that is the only
     channel through which they exist at all.
   - ON REFUSAL `sessionLayout` RETURNS ALL FOUR MAPS EMPTY. This component
     refuses independently as well, on the same disjunction plus the caller's
     `refused` flag, so the "zero interior elements" rule holds whether the
     refusal arrived in the session's own `schemaOk` or in a `schemaMismatch`
     message that left the wire liveness saying `live`.

  DOM ORDER IS THE TREE, NEVER THE GEOMETRY (C7.8): each agent, then its own
  tool dots, then its subagents. Filaments are drawn in a separate group
  underneath so painting order cannot dictate reading order; they are decorative
  paths with no focus and no accessible name, so they do not enter it.

  ZERO HOST CHANGE (C7.7). Picking a cell or a dot calls back to
  `Store.selectNode`, which posts nothing. The altitude walk is `Store.escape`
  and is not a key handler in this file.
-->
<script lang="ts">
  import type { AgentNode, ParkedGraft, SessionState, ToolNode } from '../src/model/events.js';
  import { isAgentNode } from '../src/model/events.js';
  import type { CellPlacement, DotPlacement, SessionLayout } from './canvas-contract.js';
  import { REDUCED_MOTION_CLASS, TESTID } from './canvas-contract.js';
  import { roundCoord, sessionLayout } from './layout.js';
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
    canvasView = { x: 0, y: 0, k: 1 },
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
     * `liveness === 'unsupported'`: the SAME disjunction `sessionLayout`
     * documents, refusing on any of them because that is the safe direction.
     */
    refused?: boolean;
    /** The hook tap is silent: a running agent's membrane goes dash-hollow (G2). */
    degraded?: boolean;
    /** The store's selected node, if the inspector is open on one. */
    selectedNodeId?: string | undefined;
    /** The user prefers reduced motion. Swapped by class, never by query alone. */
    reducedMotion?: boolean;
    /** Wired to `Store.selectNode` — opens the inspector (C7.8). */
    onselect?: ((nodeId: string) => void) | undefined;
    /**
     * Interior pan/zoom, applied as an SVG TRANSFORM on the stage group.
     *
     * Same rule as the deck and for the same reason: `sessionLayout` stays a
     * pure function of state and its goldens stay valid as numbers. Dragging
     * the view must not be able to move a cell.
     */
    canvasView?: { x: number; y: number; k: number };
    onpan?: ((dx: number, dy: number) => void) | undefined;
    onzoom?: ((factor: number, originX: number, originY: number) => void) | undefined;
    onreset?: (() => void) | undefined;
  } = $props();

  /** Slack around the placed interior, leaving room for labels and stubs. */
  const VIEWBOX_MARGIN = 72;
  /** A degenerate box for an interior with nothing in it. Nothing is drawn into it. */
  const EMPTY_VIEWBOX = '0 0 1 1';

  /** One drawable thing, in tree order. */
  type CanvasNode =
    | {
        kind: 'agent';
        agent: AgentNode;
        placement: CellPlacement;
        nucleus: boolean;
        elided: number;
      }
    | { kind: 'tool'; tool: ToolNode; placement: DotPlacement; root: boolean };

  interface Filamentish {
    toolUseId: string;
    agentId: string;
    from: CellPlacement;
    to: CellPlacement;
    flowing: boolean;
  }

  interface ParkedCell {
    entry: ParkedGraft;
    placement: CellPlacement;
  }

  const EMPTY_LAYOUT: SessionLayout = {
    cells: new Map(),
    dots: new Map(),
    elided: new Map(),
    parked: new Map(),
  };

  /**
   * The tree walk. Agents and dots in reading order, and the agent index the
   * filament pass needs.
   *
   * Tools before subagents at each level, which is also the order
   * `sessionLayout` places in — it lays every one of an agent's own dots
   * before recursing — so when a `tool_use` id appears twice in one tree, the
   * occurrence that renders is the occurrence whose coordinate the map holds.
   */
  function walk(state: SessionState, layout: SessionLayout): {
    nodes: CanvasNode[];
    agents: Map<string, AgentNode>;
  } {
    const nodes: CanvasNode[] = [];
    const agents = new Map<string, AgentNode>();
    const drawnTools = new Set<string>();

    const visit = (agent: AgentNode, depth: number): void => {
      // First occurrence of an id wins, exactly as the layout's own walk does.
      // A tree is what the model produces; a renderer that recursed forever on
      // a state that is not one would be a worse answer than drawing it once.
      if (agents.has(agent.id)) return;
      agents.set(agent.id, agent);
      const cell = layout.cells.get(agent.id);
      // No placement means the layout declined to place it. Draw nothing
      // rather than inventing a coordinate for it.
      if (cell === undefined) return;
      nodes.push({
        kind: 'agent',
        agent,
        placement: cell,
        nucleus: depth === 0,
        elided: layout.elided.get(agent.id) ?? 0,
      });

      const subagents: AgentNode[] = [];
      // TOOL DOTS ARE NOT DRAWN. Removed by the user's decision, 2026-08-21,
      // after seeing a real session: at R2 scale the arcs read as noise rather
      // than as structure, and the thing a person wants from a cell is what
      // that agent did and how much it cost — which is now a line of text
      // under its name, where it can actually be read.
      //
      // The per-tool grammar C7.3 defines (running dot, dim dot, red thorn)
      // moves UP to the agent that owns them: the cell's stats line carries
      // the counts, and an agent whose tool is running is itself running, so
      // the motion channel still says "happening now" without a dot to put it
      // on. Nothing is dropped from the DATA — the inspector lists every
      // action, by description, and that is where per-action detail lives now.
      for (const child of agent.children) {
        if (isAgentNode(child)) subagents.push(child);
      }

      for (const sub of subagents) visit(sub, depth + 1);
    };

    visit(state.root, 0);
    return { nodes, agents };
  }

  /**
   * The filaments. THE JOIN, AND ONLY THE JOIN.
   *
   * One pass over `spawnEdges`; both endpoints are looked up by the edge's own
   * two ids. Nothing here reads the tree's shape, and an agent claimed by two
   * edges keeps the first — the same first-wins rule the layout's join uses,
   * so the drawn filament and the placed cell agree about which edge won.
   */
  function filamentsOf(
    state: SessionState,
    layout: SessionLayout,
    agents: Map<string, AgentNode>,
  ): Filamentish[] {
    const out: Filamentish[] = [];
    const claimed = new Set<string>();
    for (const edge of state.spawnEdges ?? []) {
      if (claimed.has(edge.agentId)) continue;
      // ANCHORED CELL-TO-CELL since the tool dots stopped being drawn.
      //
      // The filament is still the `toolUseId` join made visible — the edge it
      // comes from is unchanged and still carries both halves of the key. Only
      // the point it is drawn FROM moved, from the spawning dot to the centre
      // of the agent that owns that dot. It says "this agent spawned that one,
      // and here is the join that proves it" rather than "this exact call did".
      // The precise call is one click away in the inspector.
      const from = layout.cells.get(edge.parentNodeId);
      const to = layout.cells.get(edge.agentId);
      // One end missing: the parent or the child is not placed. A filament
      // needs both ends of the key.
      if (from === undefined || to === undefined) continue;
      claimed.add(edge.agentId);
      out.push({
        toolUseId: edge.toolUseId,
        agentId: edge.agentId,
        from,
        to,
        // C7.4: the dash flows while the CHILD is running, and is static
        // otherwise — the join itself never animates.
        flowing: agents.get(edge.agentId)?.status === 'running',
      });
    }
    return out;
  }

  function parkedOf(state: SessionState, layout: SessionLayout): ParkedCell[] {
    const out: ParkedCell[] = [];
    for (const entry of state.parked ?? []) {
      const placement = layout.parked.get(entry.agentId);
      // Absent means the layout dropped the claim — an id that is also in
      // `cells` is in the tree, and the tree is the half with a node behind it.
      if (placement === undefined) continue;
      out.push({ entry, placement });
    }
    return out;
  }

  function viewBoxOf(nodes: readonly CanvasNode[], parked: readonly ParkedCell[]): string {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = (x: number, y: number, r: number): void => {
      minX = Math.min(minX, x - r);
      minY = Math.min(minY, y - r);
      maxX = Math.max(maxX, x + r);
      maxY = Math.max(maxY, y + r);
    };
    for (const node of nodes) {
      if (node.kind === 'agent') add(node.placement.x, node.placement.y, node.placement.R);
      else add(node.placement.x, node.placement.y, 0);
    }
    for (const cell of parked) add(cell.placement.x, cell.placement.y, cell.placement.R);
    if (!Number.isFinite(minX)) return EMPTY_VIEWBOX;
    return [
      roundCoord(minX - VIEWBOX_MARGIN),
      roundCoord(minY - VIEWBOX_MARGIN),
      roundCoord(maxX - minX + 2 * VIEWBOX_MARGIN),
      roundCoord(maxY - minY + 2 * VIEWBOX_MARGIN),
    ].join(' ');
  }

  /*
   * G3, from this side of the seam. `sessionLayout` already empties all four
   * maps for a session whose own `schemaOk` is false, so the interior would be
   * empty even if this flag did not exist; the flag is what covers the OTHER
   * refusal channel, a `schemaMismatch` message on a session whose wire
   * liveness still says `live`. Two independent statements of one rule,
   * because the count that has to be 0 is the whole of C7.4's last row.
   */
  let isRefused = $derived(
    refused || session.schemaOk === false || session.liveness === 'unsupported',
  );
  let layout = $derived(isRefused ? EMPTY_LAYOUT : sessionLayout(session));
  let walked = $derived(walk(session, layout));
  let nodes = $derived(isRefused ? [] : walked.nodes);
  let filaments = $derived(isRefused ? [] : filamentsOf(session, layout, walked.agents));
  let parkedCells = $derived(isRefused ? [] : parkedOf(session, layout));
  let viewBox = $derived(viewBoxOf(nodes, parkedCells));

  // Drag to pan, wheel to zoom. Identical shape to `Deck.svelte` — a drag that
  // starts on a cell or a dot belongs to that element, or panning would
  // swallow the click that opens the inspector.
  let dragging = $state.raw(false);
  let lastX = 0;
  let lastY = 0;

  const INTERACTIVE = '[data-testid="canvas-cell"],[data-testid="canvas-nucleus"]';

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    if (target?.closest(INTERACTIVE) !== null) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    onpan?.(dx, dy);
  };

  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
  };

  const onWheel = (event: WheelEvent): void => {
    if (onzoom === undefined) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    const rect = (event.currentTarget as Element).getBoundingClientRect();
    onzoom(factor, event.clientX - rect.left, event.clientY - rect.top);
  };

  let transform = $derived(
    `translate(${canvasView.x} ${canvasView.y}) scale(${canvasView.k})`,
  );
  let atIdentity = $derived(canvasView.x === 0 && canvasView.y === 0 && canvasView.k === 1);
</script>

<section
  class={reducedMotion ? `canvas ${REDUCED_MOTION_CLASS}` : 'canvas'}
  data-testid={TESTID.canvas}
  data-session-id={session.sessionId}
  data-refused={String(isRefused)}
  data-degraded={String(degraded)}
  data-cells={String(nodes.filter((n) => n.kind === 'agent').length)}
  data-dots={String(nodes.filter((n) => n.kind === 'tool').length)}
  data-parked={String(parkedCells.length)}
  aria-label="Session interior"
>
  {#if !isRefused}
    {#if onreset !== undefined}
      <button
        class="reset"
        type="button"
        data-testid={TESTID.canvasReset}
        data-identity={String(atIdentity)}
        onclick={() => onreset?.()}>Reset view</button
      >
    {/if}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <svg
      class="field"
      class:dragging
      {viewBox}
      role="group"
      aria-label="Session interior"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={endDrag}
      onpointercancel={endDrag}
      onwheel={onWheel}
    >
      <g data-testid={TESTID.canvasStage} {transform}>
      <!-- Filaments first so they paint UNDER the cells and dots they join.
           They carry no testid-bearing focus and no accessible name, so
           painting order does not become reading order (C7.8). -->
      <g class="filaments">
        {#each filaments as filament (filament.agentId)}
          <Filament
            from={filament.from}
            to={filament.to}
            toolUseId={filament.toolUseId}
            agentId={filament.agentId}
            flowing={filament.flowing}
          />
        {/each}
      </g>
      <g class="nodes">
        {#each nodes as node (node.kind === 'agent' ? node.agent.id : node.tool.id)}
          {#if node.kind === 'agent'}
            <AgentCell
              agent={node.agent}
              placement={node.placement}
              nucleus={node.nucleus}
              elided={node.elided}
              selected={node.agent.id === selectedNodeId}
              {degraded}
              {onselect}
            />
          {:else}
            <ToolDot
              tool={node.tool}
              placement={node.placement}
              root={node.root}
              selected={node.tool.id === selectedNodeId}
              {onselect}
            />
          {/if}
        {/each}
      </g>
      <!-- C7.4: parked grafts, from `session.parked` and never from the tree —
           there is nothing in the tree to walk. Last in DOM order because they
           are last in the store's account of the session: everything with a
           node comes first. -->
      <g class="parked">
        {#each parkedCells as cell (cell.entry.agentId)}
          <AgentCell parked={cell.entry} placement={cell.placement} />
        {/each}
      </g>
      </g>
    </svg>
  {/if}
</section>

<style>
  .field {
    touch-action: none;
    cursor: grab;
  }

  .field.dragging {
    cursor: grabbing;
  }

  .reset {
    position: absolute;
    right: 8px;
    top: 8px;
    z-index: 1;
    font: inherit;
    font-size: 0.85em;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 3px;
    padding: 0 6px;
    cursor: pointer;
  }

  .reset:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 1px;
  }
  /* Every colour is a VS Code theme variable. The frozen mockup hardcodes a
     dark palette only because it lives outside VS Code (C7.7). */
  .canvas {
    position: relative;
    display: flex;
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
</style>
