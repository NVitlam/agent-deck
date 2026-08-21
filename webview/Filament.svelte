<!--
  The filament — Phase 0's join key, drawn (spec C7.4).

  WHAT THIS ELEMENT IS. `meta.toolUseId` is a PRIMARY KEY, not an inference:
  the sidecar names the exact `tool_use` block that spawned the agent, and the
  host carries that join to the webview as a `SpawnEdge`. This component draws
  a line from the dot of `edge.toolUseId` to the cell of `edge.agentId` and
  takes BOTH endpoints from `sessionLayout`'s maps, keyed by those two ids.
  There is no proximity rule, no "nearest dot" and no parent-order heuristic
  anywhere in this file — the props ARE the join row, so a filament that draws
  is a join that resolved, and nothing else can produce one.

  GEOMETRY. The two endpoints are `layout.ts`'s and are never recomputed. What
  is computed here is the CURVE BETWEEN them — the pull-back to the child's
  membrane edge and the perpendicular bow — transcribed from the frozen mockup
  `docs/ui/agent-deck-canvas-mockup.html` (`drawFilament`; cited, never
  edited). That is presentation between two placed points, the same category as
  `SessionBlob.svelte`'s crack path, and it duplicates no named export of
  `layout.ts`. Rounding goes through `roundCoord` so the path text is written
  at the same precision as everything else on this surface.

  MOTION (C7.6). One class, `ANIMATED_CLASSES[2]` (`is-flowing`), and only
  while the CHILD is running — the dash flows to say a subagent is working
  right now. A resolved join on a finished child is static, which is what the
  motion negative control counts.
-->
<script lang="ts">
  import type { CellPlacement, DotPlacement } from './canvas-contract.js';
  import { ANIMATED_CLASSES, TESTID } from './canvas-contract.js';
  import { roundCoord } from './layout.js';

  let {
    from,
    to,
    toolUseId,
    agentId,
    flowing = false,
  }: {
    /** Where `sessionLayout().dots` put the SPAWNING tool call. */
    from: DotPlacement;
    /** Where `sessionLayout().cells` put the SPAWNED agent. */
    to: CellPlacement;
    /** `SpawnEdge.toolUseId` — the join key itself, kept on the element. */
    toolUseId: string;
    /** `SpawnEdge.agentId` — the other half of the key. */
    agentId: string;
    /** The spawned agent's status is `running`: the dash flows (C7.4). */
    flowing?: boolean;
  } = $props();

  /** The filament's animation class. Taken from the contract, never typed out. */
  const FLOWING = ANIMATED_CLASSES[2];

  /**
   * Perpendicular bow, as a fraction of the run between the endpoints.
   * Mockup: `mx = (from.x + to.x) / 2 - dy * 0.12`.
   */
  const BOW = 0.12;

  function curve(a: DotPlacement, b: CellPlacement): string {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    // Degenerate only if a dot and the cell it spawned share a point, which
    // this layout does not produce. Drawn as a point rather than as NaN: a
    // filament that cannot be shaped still says the join resolved.
    if (len === 0) return `M ${roundCoord(a.x)} ${roundCoord(a.y)}`;
    // Stop at the child's membrane rather than at its centre, so the line
    // touches the cell instead of running under it.
    const ex = b.x - (dx / len) * b.R;
    const ey = b.y - (dy / len) * b.R;
    const mx = (a.x + ex) / 2 - dy * BOW;
    const my = (a.y + ey) / 2 + dx * BOW;
    return (
      `M ${roundCoord(a.x)} ${roundCoord(a.y)}` +
      ` Q ${roundCoord(mx)} ${roundCoord(my)}` +
      ` ${roundCoord(ex)} ${roundCoord(ey)}`
    );
  }

  let d = $derived(curve(from, to));
  let className = $derived(flowing ? `filament ${FLOWING}` : 'filament');
</script>

<path
  class={className}
  {d}
  data-testid={TESTID.filament}
  data-tool-use-id={toolUseId}
  data-agent-id={agentId}
  data-flowing={String(flowing)}
/>

<style>
  /* Colour from the theme only (C7.7). The mockup's `--fil` is a dark-palette
     value because it lives outside VS Code; here the join takes a chart
     colour from the theme. */
  .filament {
    fill: none;
    stroke: var(--vscode-charts-blue, currentColor);
    stroke-width: 1.2;
    opacity: 0.55;
  }

  /* ── motion (C7.6) ────────────────────────────────────────────────────
     The class is built from `ANIMATED_CLASSES`, so the selector below is the
     one place that name is spelled twice; `canvas.test.ts` checks this literal
     back against the constant AND checks the bundled stylesheet for the rule,
     because Svelte prunes a scoped rule it cannot prove is used — which would
     switch the animation off while every DOM assertion still passed.

     `stroke-dashoffset` only: no coordinate is touched, so no golden can flap. */
  .filament:global(.is-flowing) {
    stroke-dasharray: 3 9;
    animation: flow 1.1s linear infinite;
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
