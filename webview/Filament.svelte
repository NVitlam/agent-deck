<!--
  The filament — Phase 0's join key, drawn (spec C7.4). The signature element
  of altitude 1.

  WHAT THIS ELEMENT IS. `meta.toolUseId` is a PRIMARY KEY, not an inference:
  the sidecar names the exact `tool_use` block that spawned the agent, and the
  host carries that join to the webview as a `SpawnEdge`. This component draws
  a curve from the DOT of `edge.toolUseId` to the top-centre of the NODE of
  `edge.agentId`, and takes both endpoints from its caller, which looked them
  up by those two ids. There is no proximity rule, no "nearest dot" and no
  parent-order heuristic anywhere in this file — the props ARE the join row, so
  a filament that draws is a join that resolved, and nothing else can produce
  one.

  THE CURVE. A cubic Bézier with both control points on the vertical midpoint
  between the two ends:

      M dx,dy  C dx,my  cx,my  cx,cy        my = (dy + cy) / 2

  `dy` is the PARENT'S BOTTOM EDGE (design amendment A8.2). It was the bottom
  of the spawning dot, `dy + 4`, until 2026-08-29; A8.1 removed the dots, and
  with them the only reason for the offset. Both control points share `my`,
  which is what makes the curve leave vertically and arrive vertically: a
  spawn reads as descending from its parent, at any zoom, without an
  arrowhead. WHICH call spawned it is read in the drawer's call rows, not
  from where the curve starts.

  MOTION (C7.6). One class, `ANIMATED_CLASSES[2]` (`is-flowing`), and only
  while the CHILD is running — the dash flows to say a subagent is working
  right now. A resolved join on a finished child is static and dimmed, which is
  what the motion negative control counts. The animation is on
  `stroke-dashoffset` alone, so no coordinate moves.

  DRAWN UNDER THE NODES. The caller puts every filament in one group ahead of
  the node group, so painting order cannot become reading order (C7.8) and a
  curve can never cross a label.
-->
<script lang="ts">
  import { ANIMATED_CLASSES, TESTID } from './canvas-contract.js';
  import { roundCoord } from './layout.js';

  let {
    from,
    to,
    toolUseId,
    agentId,
    state = 'default',
  }: {
    /** The parent node's bottom centre: `x + w / 2`, `y + NODE_H` (A8.2). */
    from: { x: number; y: number };
    /** The SPAWNED node's top centre: `placement.x + placement.w / 2`, `y`. */
    to: { x: number; y: number };
    /** `SpawnEdge.toolUseId` — the join key itself, kept on the element. */
    toolUseId: string;
    /** `SpawnEdge.agentId` — the other half of the key. */
    agentId: string;
    /**
     * `live` when the child has a running tool, `dim` when the child has
     * ended, `default` otherwise. Passed in rather than derived here: the
     * caller already holds the child node, and a second traversal would be a
     * second answer to one question.
     */
    state?: 'default' | 'live' | 'dim';
  } = $props();

  /** The filament's animation class. Taken from the contract, never typed out. */
  const FLOWING = ANIMATED_CLASSES[2];

  function curve(a: { x: number; y: number }, b: { x: number; y: number }): string {
    const my = roundCoord((a.y + b.y) / 2);
    const ax = roundCoord(a.x);
    const ay = roundCoord(a.y);
    const bx = roundCoord(b.x);
    const by = roundCoord(b.y);
    return `M ${ax} ${ay} C ${ax} ${my} ${bx} ${my} ${bx} ${by}`;
  }

  let d = $derived(curve(from, to));
  let flowing = $derived(state === 'live');
  let className = $derived(flowing ? `filament ${FLOWING}` : 'filament');
</script>

<path
  class={className}
  {d}
  data-testid={TESTID.filament}
  data-tool-use-id={toolUseId}
  data-agent-id={agentId}
  data-state={state}
  data-flowing={String(flowing)}
/>

<style>
  /* Colour from the theme only (C7.7). Amber at 55%: present, and never
     louder than the nodes it joins. */
  .filament {
    fill: none;
    stroke: var(--vscode-charts-yellow, currentColor);
    stroke-width: 1.25;
    opacity: 0.55;
  }

  /* The child has ended: the join is still true, it is just no longer news. */
  .filament[data-state='dim'] {
    opacity: 0.35;
  }

  /* ── motion (C7.6) ────────────────────────────────────────────────────
     The class is built from `ANIMATED_CLASSES`, so the selector below is the
     one place that name is spelled twice; `canvas.test.ts` checks this literal
     back against the constant AND checks the bundled stylesheet for the rule,
     because Svelte prunes a scoped rule it cannot prove is used — which would
     switch the animation off while every DOM assertion still passed.

     `stroke-dashoffset` only: no coordinate is touched, so no golden can flap. */
  .filament:global(.is-flowing) {
    stroke-width: 1.5;
    opacity: 0.85;
    stroke-dasharray: 6 6;
    animation: flow 1s linear infinite;
  }

  @keyframes flow {
    to {
      stroke-dashoffset: -12;
    }
  }

  /* Reduced motion swaps the animation for a static variant BY CLASS, because
     a media query does not evaluate in jsdom. The dash stays: the filament
     still reads as "child running", it just stops moving. */
  :global(.reduced-motion) .filament:global(.is-flowing) {
    animation: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .filament:global(.is-flowing) {
      animation: none;
    }
  }
</style>
