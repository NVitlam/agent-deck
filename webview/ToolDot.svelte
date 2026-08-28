<!--
  One tool call, as a dot on the row beneath its node (altitude 1).

  THREE STATES, THREE COLOURS, and a fourth axis that is a SHAPE:

      completed -> muted fill
      running   -> amber fill, plus an expanding ring
      error     -> warn/red fill
      spawned a subagent -> HOLLOW, amber stroke (filled amber while running)

  The spawn axis is a shape rather than a fifth colour because it is
  orthogonal to status: a call that spawned a subagent can be running, done or
  errored, and encoding both on one channel would make one of them unreadable.

  NAMES ARE ON HOVER ONLY. An SVG `<title>` and nothing else — no always-on
  label at any zoom. A row of twenty-four labelled dots under a node 200 units
  wide is unreadable text drawn over unreadable text, which is the exact
  failure the predecessor canvas shipped.

  GEOMETRY IS NOT HERE. The centre comes from `layout.ts:spawnDotPos`, handed
  in by `SessionCanvas.svelte`. The radius and the ring are presentation.

  THE OVERFLOW GLYPH IS THIS COMPONENT TOO. Above the cap the row draws the
  LAST 23 calls and a `+N` in dot 0's place — what is happening now is at the
  end, and the count of what is not drawn belongs where the drawing stops. It
  is not a tool call, so it carries no status, no title and no selection: it
  is a statement about the row. THE EXACT COUNTS STAY ON ROW 2 OF THE NODE,
  uncapped, so nothing about the cap can make a number wrong.
-->
<script lang="ts">
  import type { ToolNode } from '../src/model/events.js';
  import { ANIMATED_CLASSES, TESTID } from './canvas-contract.js';
  import { roundCoord } from './layout.js';
  import { formatDuration } from './format.js';

  let {
    tool,
    placement,
    spawns = false,
    overflow = 0,
    selected = false,
    onselect,
  }: {
    /** The tool call. Read, never mutated (G1). Absent on the overflow glyph. */
    tool?: ToolNode | undefined;
    /** Where `spawnDotPos` put it. Never recomputed here. */
    placement: { x: number; y: number };
    /**
     * This call spawned a subagent — it is one end of a `spawnEdges` row.
     * Drawn hollow, so the join has a visible origin even before the eye
     * follows the filament.
     */
    spawns?: boolean;
    /**
     * Render the `+N` glyph instead of a dot, standing for N calls the cap
     * did not draw. Mutually exclusive with {@link tool}.
     */
    overflow?: number;
    /** This dot is the store's selected node. */
    selected?: boolean;
    /** The user picked this dot. Wired to `Store.selectNode` (C7.8). */
    onselect?: ((nodeId: string) => void) | undefined;
  } = $props();

  /** The running dot's animation class, from the contract rather than typed out. */
  const PULSING = ANIMATED_CLASSES[1];

  /** Dot radius. One size: a dot that grew with anything would move its row. */
  const R = 4;
  /** The expanding ring a running call carries, at rest. */
  const RING_R = 5.5;

  let isOverflow = $derived(tool === undefined && overflow > 0);
  let status = $derived(tool?.status);
  let running = $derived(status === 'running');
  let title = $derived(
    tool === undefined ? '' : `${tool.toolName} · ${status ?? ''} · ${formatDuration(tool.durationMs)}`,
  );

  let cx = $derived(roundCoord(placement.x));
  let cy = $derived(roundCoord(placement.y));

  function select(): void {
    if (tool === undefined) return;
    onselect?.(tool.id);
  }

  function onKeyDown(event: KeyboardEvent): void {
    // A real focusable control answers Enter and Space (C7.8). Space is
    // prevented so the panel does not scroll under the activation.
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    select();
  }
</script>

{#if isOverflow}
  <!-- Not a tool call: a statement about the row. No status, no title, no
       selection, and no place in the tab order — there is nothing to inspect,
       and the exact numbers are on the node's own row 2. -->
  <text
    class="more"
    data-testid="tool-dot-overflow"
    data-count={String(overflow)}
    x={cx}
    y={roundCoord(cy + 3.5)}
    aria-hidden="true">+{overflow}</text
  >
{:else if tool !== undefined}
  <g
    class="dot"
    data-testid={TESTID.dot}
    data-tool-id={tool.id}
    data-status={status}
    data-spawns={String(spawns)}
    data-selected={String(selected)}
    role="button"
    tabindex="0"
    aria-label={`${tool.toolName} — ${status ?? ''}`}
    aria-current={selected}
    onclick={select}
    onkeydown={onKeyDown}
  >
    {#if running}
      <!-- C7.6: the only state that animates, and it animates a RING rather
           than the dot, so the coordinate `spawnDotPos` produced is never
           touched by the animation. -->
      <circle class={`halo ${PULSING}`} {cx} {cy} r={RING_R} />
    {/if}
    <circle class="bud" {cx} {cy} r={R} />
    <!-- HOVER ONLY. The row would be illegible with these drawn. -->
    <title>{title}</title>
  </g>
{/if}

<style>
  .dot {
    cursor: pointer;
  }

  /* C7.8: a real focusable element with a VISIBLE focus ring. Both an outline
     and a stroke change, because outline support on SVG containers is
     uneven — the stroke is the half that always shows. */
  .dot:focus-visible {
    outline: 2px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 2px;
  }

  .dot:focus-visible .bud,
  .dot:hover .bud {
    stroke: var(--vscode-foreground);
    stroke-width: 1;
  }

  /* completed: muted. One rule per state row. */
  .bud {
    fill: var(--vscode-descriptionForeground, currentColor);
    opacity: 0.75;
  }

  .dot[data-status='running'] .bud {
    fill: var(--vscode-charts-yellow, currentColor);
    opacity: 1;
  }

  .dot[data-status='error'] .bud {
    fill: var(--vscode-errorForeground, currentColor);
    opacity: 1;
  }

  /* The spawn axis is a SHAPE: hollow with an amber stroke. Filled amber
     again while the call is still running, because "running" is the louder
     of the two things it has to say. */
  .dot[data-spawns='true'] .bud {
    fill: none;
    stroke: var(--vscode-charts-yellow, currentColor);
    stroke-width: 1.4;
    opacity: 1;
  }

  .dot[data-spawns='true'][data-status='running'] .bud {
    fill: var(--vscode-charts-yellow, currentColor);
  }

  .dot[data-selected='true'] .bud {
    stroke: var(--vscode-focusBorder, currentColor);
    stroke-width: 1.4;
  }

  .halo {
    fill: none;
    stroke: var(--vscode-charts-yellow, currentColor);
    stroke-width: 1;
    opacity: 0.6;
  }

  .more {
    fill: var(--vscode-descriptionForeground, currentColor);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
    text-anchor: middle;
  }

  /* ── motion (C7.6) ────────────────────────────────────────────────────
     Transform and opacity on a `fill-box` origin, so the animation cannot
     move the coordinate the layout pinned. The class comes from
     `ANIMATED_CLASSES`; this selector is the second spelling and
     `canvas.test.ts` checks it back against the constant and against the
     bundled stylesheet. */
  .halo:global(.is-pulsing) {
    transform-box: fill-box;
    transform-origin: center;
    animation: dotpulse 1.15s ease-in-out infinite;
  }

  @keyframes dotpulse {
    50% {
      transform: scale(1.55);
      opacity: 0.2;
    }
  }

  /* Swapped BY CLASS, not by media query alone — a media query does not
     evaluate in jsdom, and the rule has to stay assertable. The ring stays
     drawn: it stops moving, it does not stop meaning `running`. */
  :global(.reduced-motion) .halo:global(.is-pulsing) {
    animation: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .halo:global(.is-pulsing) {
      animation: none;
    }
  }
</style>
