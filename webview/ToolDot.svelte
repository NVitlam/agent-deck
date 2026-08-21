<!--
  One tool call, as a dot on its agent's chronological arc (spec C7.1).

  Three states, three encodings, straight off C7.3's matrix:

      running  ->  pulsing dot          (the only state that animates)
      done     ->  settled dim dot
      error    ->  RED THORN, persists  (it is still there after the session ends)

  The thorn is a shape rather than a colour so the error row survives a theme
  that renders every chart colour at low contrast, and it is drawn instead of
  the circle rather than on top of it — an errored tool call is not a dot with
  a decoration.

  GEOMETRY IS NOT HERE. The dot's centre is `sessionLayout().dots`, handed in.
  The two radii and the thorn's arm lengths are presentation, transcribed from
  the frozen mockup `docs/ui/agent-deck-canvas-mockup.html` (`drawDot`,
  `thornPath`), and neither duplicates a named export of `layout.ts`.

  SELECTION IS THE STORE'S (C7.7, C7.8). This dot is a real focusable control
  and reports its own id; `Store.selectNode` decides what that means and posts
  nothing to the host. Escape's altitude walk is `Store.escape` and is not a
  key handler in this file.
-->
<script lang="ts">
  import type { ToolNode } from '../src/model/events.js';
  import type { DotPlacement } from './canvas-contract.js';
  import { ANIMATED_CLASSES, TESTID } from './canvas-contract.js';
  import { roundCoord } from './layout.js';
  import { formatDuration } from './format.js';

  let {
    tool,
    placement,
    root = false,
    selected = false,
    onselect,
  }: {
    /** The tool call. Read, never mutated (G1). */
    tool: ToolNode;
    /** Where `sessionLayout().dots` put it. Never recomputed here. */
    placement: DotPlacement;
    /** Its agent is the nucleus. Mockup: `agent.spawnDepth === 0` sizes it up. */
    root?: boolean;
    /** This dot is the store's selected node. */
    selected?: boolean;
    /** The user picked this dot. Wired to `Store.selectNode` (C7.8). */
    onselect?: ((nodeId: string) => void) | undefined;
  } = $props();

  /** The running dot's animation class, from the contract rather than typed out. */
  const PULSING = ANIMATED_CLASSES[1];

  /** Dot radius on the nucleus's arc. Mockup: `agent.spawnDepth === 0 ? 6 : 4.6`. */
  const R_ROOT = 6;
  /** Dot radius on a nested cell's arc. */
  const R_NESTED = 4.6;
  /** Half-height of the error thorn. Mockup: `thornPath`'s `s`. */
  const THORN = 6;
  /** The thorn's waist, as a fraction of {@link THORN}. Mockup: `s * 0.45`, `s * 0.3`. */
  const THORN_WAIST = 0.45;
  const THORN_SHOULDER = 0.3;

  function thornPath(x: number, y: number): string {
    const w = THORN * THORN_WAIST;
    const s = THORN * THORN_SHOULDER;
    const p = (px: number, py: number): string => `${roundCoord(px)} ${roundCoord(py)}`;
    return (
      `M ${p(x, y - THORN)}` +
      ` L ${p(x + w, y - s)}` +
      ` L ${p(x + THORN, y)}` +
      ` L ${p(x + w, y + s)}` +
      ` L ${p(x, y + THORN)}` +
      ` L ${p(x - w, y + s)}` +
      ` L ${p(x - THORN, y)}` +
      ` L ${p(x - w, y - s)}` +
      ' Z'
    );
  }

  let radius = $derived(root ? R_ROOT : R_NESTED);
  let running = $derived(tool.status === 'running');
  let errored = $derived(tool.status === 'error');
  let budClass = $derived(running ? `bud ${PULSING}` : 'bud');
  let title = $derived(`${tool.toolName} · ${formatDuration(tool.durationMs)}`);

  function select(): void {
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

<g
  class="dot"
  data-testid={TESTID.dot}
  data-tool-id={tool.id}
  data-status={tool.status}
  data-selected={String(selected)}
  role="button"
  tabindex="0"
  aria-label={`${tool.toolName} — ${tool.status}`}
  aria-current={selected}
  onclick={select}
  onkeydown={onKeyDown}
>
  {#if errored}
    <!-- C7.3: red thorn, and it PERSISTS — no status makes it go away, and it
         carries no animation class in any state. -->
    <path class="thorn" d={thornPath(placement.x, placement.y)} />
  {:else}
    <circle class={budClass} cx={placement.x} cy={placement.y} r={radius} />
  {/if}
  <title>{title}</title>
</g>

<style>
  .dot {
    cursor: pointer;
  }

  /* C7.8: a real focusable element with a VISIBLE focus ring. Both an outline
     and a stroke change, because outline support on SVG containers is uneven —
     the stroke is the half that always shows. */
  .dot:focus-visible {
    outline: 2px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 2px;
  }

  .dot:focus-visible .bud,
  .dot:hover .bud {
    stroke: var(--vscode-foreground);
    stroke-width: 1;
  }

  .bud {
    fill: var(--vscode-descriptionForeground, currentColor);
    opacity: 0.75;
  }

  /* One rule per state row (C7.3). `done` is the settled dim dot above. */
  .dot[data-status='running'] .bud {
    fill: var(--vscode-charts-green, currentColor);
    opacity: 1;
  }

  .thorn {
    fill: var(--vscode-errorForeground, currentColor);
  }

  .dot[data-selected='true'] .bud,
  .dot[data-selected='true'] .thorn {
    stroke: var(--vscode-focusBorder, currentColor);
    stroke-width: 1.4;
  }

  /* ── motion (C7.6) ────────────────────────────────────────────────────
     Transform and opacity on a `fill-box` origin, so the animation cannot move
     the coordinate a golden pins. The class comes from `ANIMATED_CLASSES`;
     this selector is the second spelling and `canvas.test.ts` checks it back
     against the constant and against the bundled stylesheet. */
  .bud:global(.is-pulsing) {
    transform-box: fill-box;
    transform-origin: center;
    animation: dotpulse 1.15s ease-in-out infinite;
  }

  @keyframes dotpulse {
    50% {
      transform: scale(1.55);
      opacity: 0.65;
    }
  }

  /* Swapped BY CLASS, not by media query alone — a media query does not
     evaluate in jsdom, and the rule has to stay assertable. The running dot
     keeps its colour: it stops moving, it does not stop meaning `running`. */
  :global(.reduced-motion) .bud:global(.is-pulsing) {
    animation: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .bud:global(.is-pulsing) {
      animation: none;
    }
  }
</style>
