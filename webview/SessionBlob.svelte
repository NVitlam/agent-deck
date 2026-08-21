<!--
  One session blob on the deck — altitude 0 (spec C7.1).

  IT READS A `SessionSummary`, NOT A `SessionState`. Everything this altitude
  draws is on the summary: liveness, workspaceMatch, refused, label, and the
  two numbers the store now derives once — `nodeCount` (blob radius, C7.1's
  `log(nodeCount)`, and the constellation's point count) and `errorCount` (the
  deck-level badge). That is not a convenience: it deletes the second walk of
  the tree this component used to do and the second statement of what "refused"
  means that it used to carry. `summary.refused` is the single source, by
  construction rather than by two implementations agreeing.

  WHAT THIS COMPONENT DOES NOT DO: geometry. `webview/layout.ts` owns every
  coordinate on this surface and is golden-tested; this file consumes
  `deckLayout`'s output and calls `blobPath` and `constellationPoints`, and
  computes nothing layout.ts already computes. The only numbers written here
  are the label offsets, the pulse-ring stand-off, the constellation dot radius
  and the crack decoration — none of which layout.ts defines and none of which
  any golden pins. They are presentation, transcribed from the frozen mockup
  `docs/ui/agent-deck-canvas-mockup.html` (cited, never edited), and none of
  them duplicates a named export of layout.ts.

  MOTION IS A RESERVED CHANNEL (C7.6). Every animation this component carries
  rides a class from `ANIMATED_CLASSES` in `canvas-contract.ts`, imported and
  never spelled as a literal in the markup. That is what makes the negative
  control — set every session `ended`, count animated elements, expect 0 —
  capable of detecting the one failure it exists to detect. An animation hung
  on a class outside that list would pass the control while animating.

  THE CONSTELLATION DOES NOT MOVE, and it is placed OUTSIDE the breathing wrap
  rather than merely left un-classed. A dot is a node that exists, not a node
  that is happening: inheriting the membrane's transform would animate it in
  fact while the class-counting control still read zero. `deck.test.ts` asserts
  no constellation dot has an animated ancestor, which is the form of the check
  that can see that failure.

  The contract class names are dynamic (built from the imported constants), so
  every CSS rule that targets one pairs a scoped `.blob` with a `:global(...)`
  half: the `.blob` still takes Svelte's scope hash, so nothing leaks into
  another component, and `:global` stops Svelte PRUNING a rule it cannot
  statically prove is used. Pruning is the failure that matters — it deletes
  the styling while every DOM assertion still passes — so `deck.test.ts` checks
  the bundled stylesheet for each class name built from the contract, and that
  check was mutation-tested against a renamed selector.

  Colour comes from `--vscode-*` variables only (C7.7). The mockup's dark hexes
  live outside VS Code and are not shipped.
-->
<script lang="ts">
  import type { DeckPlacement } from './canvas-contract.js';
  import {
    ANIMATED_CLASSES,
    CRACKED_CLASS,
    FOREIGN_CLASS,
    HOLLOW_LIVE_CLASS,
    TESTID,
  } from './canvas-contract.js';
  import { blobPath, constellationPoints, hashSessionId, roundCoord } from './layout.js';
  import { displayLiveness } from './format.js';
  import type { SessionSummary } from './store.js';

  let {
    summary,
    placement,
    degraded = false,
    selected = false,
    onenter,
    nudge = { dx: 0, dy: 0 },
    onnudge,
    scale = 1,
  }: {
    /**
     * The store's summary of this session. Read, never mutated (G1).
     *
     * `refused` comes from here rather than being re-derived, because a
     * `schemaMismatch` message refuses a session WITHOUT changing the
     * `liveness` the last snapshot delivered. The store owns that union;
     * `format.ts:displayLiveness` is the one place the two are reconciled.
     */
    summary: SessionSummary;
    /** Where `deckLayout` put it. Never recomputed here. */
    placement: DeckPlacement;
    /** The hook tap is silent, so `live` here was inferred from JSONL (G2). */
    degraded?: boolean;
    /** This blob is the store's selected session. */
    selected?: boolean;
    /** The user chose this session. Wired to `Store.enterSession` (C7.8). */
    /** The user chose this session. Wired to Store.enterSession (C7.8). */
    onenter?: ((sessionId: string) => void) | undefined;
    /** Where the user dragged this blob, relative to where layout put it. */
    nudge?: { dx: number; dy: number };
    /** Report a drag delta in stage units. */
    onnudge?: ((dx: number, dy: number) => void) | undefined;
    /** Current stage zoom, so a drag tracks the pointer at any zoom level. */
    scale?: number;
  } = $props();

  // DRAG TO MOVE, WITHOUT LOSING CLICK-TO-ENTER.
  //
  // Blobs are placed on a golden-angle spiral and can overlap, so one has to
  // be movable to see what is under it. The catch is that the same gesture
  // starts a click, and a blob that entered a session every time you tried to
  // move it would be worse than not being movable at all.
  //
  // The discriminator is distance, not a modifier or a double-click: under
  // DRAG_THRESHOLD px the gesture is a click and enters the session; past it,
  // it is a drag and the click is suppressed. That is how every map does it,
  // and it needs nothing explained to the user.
  const DRAG_THRESHOLD = 4;
  let pointerDown = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    pointerDown = true;
    moved = false;
    lastX = event.clientX;
    lastY = event.clientY;
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!pointerDown) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    if (!moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
    moved = true;
    lastX = event.clientX;
    lastY = event.clientY;
    // Divided by the zoom so the blob stays under the pointer: at 2x, one
    // screen pixel is half a stage unit.
    onnudge?.(dx / (scale || 1), dy / (scale || 1));
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!pointerDown) return;
    pointerDown = false;
    (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
  };

  /** Swallow the click that ends a drag; let a real click through. */
  const onClick = (event: MouseEvent): void => {
    if (moved) {
      moved = false;
      event.stopPropagation();
      return;
    }
    enter();
  };

  let nudgeTransform = $derived(
    nudge.dx === 0 && nudge.dy === 0 ? undefined : `translate(${nudge.dx} ${nudge.dy})`,
  );

  /* The two animation-bearing classes this altitude uses, taken from the
     contract rather than typed out. `is-flowing` belongs to the filament in
     the session interior and is not this component's to carry. */
  const BREATHING = ANIMATED_CLASSES[0];
  const PULSING = ANIMATED_CLASSES[1];

  /** Pulse-ring stand-off, in the same units as R. Mockup: `blobPath(x, y, R + 6)`. */
  const PULSE_RING_GAIN = 6;
  /** Baseline of the session label, below the membrane. Mockup: `y + R + 20`. */
  const LABEL_DY = 20;
  /** Baseline of the "other workspace" tag, below the label. Mockup: `y + R + 36`. */
  const TAG_DY = 36;
  /** Baseline of the error badge, above the membrane. Mockup: `y - R - 10`. */
  const BADGE_DY = 10;
  /** Radius of one constellation dot. Mockup: `el('circle', { ..., r: 1.6 })`. */
  const CONSTELLATION_DOT_R = 1.6;

  /**
   * The crack, as `dx,dy` pairs in units of R, walked from the start point.
   *
   * Transcribed verbatim from the frozen mockup's cracked-membrane path
   * (`docs/ui/agent-deck-canvas-mockup.html`, the `s.refused` branch of
   * `renderDeck`). Written as data rather than as a template string so the
   * shape is one reviewable list instead of ten inline numbers.
   */
  const CRACK_START: readonly [number, number] = [-0.62, -0.28];
  const CRACK_STEPS: readonly (readonly [number, number])[] = [
    [0.34, 0.2],
    [0.22, -0.26],
    [0.3, 0.42],
    [0.2, -0.1],
  ];

  function crackPath(x: number, y: number, R: number): string {
    let d = `M ${roundCoord(x + CRACK_START[0] * R)} ${roundCoord(y + CRACK_START[1] * R)}`;
    for (const [dx, dy] of CRACK_STEPS) {
      d += ` l ${roundCoord(dx * R)} ${roundCoord(dy * R)}`;
    }
    return d;
  }

  let seed = $derived(hashSessionId(summary.sessionId));
  let shownLiveness = $derived(displayLiveness(summary.liveness, summary.refused));
  /* Only a session the fingerprint accepted animates as live. A refused one
     shows `unsupported` here, so it is still by construction. */
  let isLive = $derived(shownLiveness === 'live');
  let foreign = $derived(!summary.workspaceMatch);

  /*
   * One dot per node, seeded exactly as the silhouette is, so a blob's
   * constellation belongs to its own shape. `constellationPoints` saturates at
   * `CONSTELLATION_CAP` and is incremental by index — this component relies on
   * both rather than re-checking them, and neither is restated here.
   *
   * A refused session carries `nodeCount: 0` (G3: no number is read off a tree
   * we declined to trust), and a count of 0 yields no points — so the refusal
   * needs no branch of its own. The blob draws at `DECK_RADIUS_MIN` and says
   * nothing about content.
   */
  let constellation = $derived(
    constellationPoints(placement.x, placement.y, placement.R, summary.nodeCount, seed),
  );

  let membraneClass = $derived(
    ['membrane', summary.refused ? CRACKED_CLASS : '', isLive && degraded ? HOLLOW_LIVE_CLASS : '']
      .filter((c) => c !== '')
      .join(' '),
  );
  let groupClass = $derived(
    ['blob', summary.refused ? CRACKED_CLASS : '', foreign ? FOREIGN_CLASS : '']
      .filter((c) => c !== '')
      .join(' '),
  );

  function enter(): void {
    onenter?.(summary.sessionId);
  }

  function onKeyDown(event: KeyboardEvent): void {
    // A real focusable control answers Enter and Space (C7.8). Space is
    // prevented so the panel does not scroll under the activation.
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    enter();
  }
</script>

<g
  class={groupClass}
  data-testid={TESTID.deckBlob}
  data-session-id={summary.sessionId}
  data-liveness={shownLiveness}
  data-liveness-inferred={String(degraded)}
  data-foreign={String(foreign)}
  data-refused={String(summary.refused)}
  data-errors={String(summary.errorCount)}
  data-nodes={String(summary.nodeCount)}
  data-constellation={String(constellation.length)}
  data-selected={String(selected)}
  aria-current={selected}
  role="button"
  tabindex="0"
  aria-label={`${summary.label} — ${shownLiveness}${foreign ? ', other workspace' : ''}${
    summary.errorCount > 0
      ? `, ${summary.errorCount} tool ${summary.errorCount === 1 ? 'error' : 'errors'}`
      : ''
  }`}
  data-nudged={String(nudge.dx !== 0 || nudge.dy !== 0)}
  transform={nudgeTransform}
  onclick={onClick}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  onkeydown={onKeyDown}
>
  {#if isLive}
    <!-- The pulse ring. Present only while the session is live, which is what
         keeps the motion negative control meaningful. -->
    <path
      class={`pulse ${PULSING}`}
      d={blobPath(placement.x, placement.y, placement.R + PULSE_RING_GAIN, seed)}
    />
  {/if}
  <g class={isLive ? `wrap ${BREATHING}` : 'wrap'}>
    <path class={membraneClass} d={blobPath(placement.x, placement.y, placement.R, seed)} />
    {#if summary.refused}
      <path class="crack" d={crackPath(placement.x, placement.y, placement.R)} />
    {/if}
  </g>
  <!-- Deliberately a SIBLING of the breathing wrap, not a child of it. See the
       header: a constellation dot is a node that exists, not a node that is
       happening, so it must not inherit the membrane's transform. -->
  <g class="constellation" aria-hidden="true">
    {#each constellation as point, index (index)}
      <circle
        data-testid={TESTID.deckConstellation}
        cx={point.x}
        cy={point.y}
        r={CONSTELLATION_DOT_R}
      />
    {/each}
  </g>
  <text class="label" x={placement.x} y={roundCoord(placement.y + placement.R + LABEL_DY)}
    >{summary.label}</text
  >
  {#if foreign}
    <text class="tag" x={placement.x} y={roundCoord(placement.y + placement.R + TAG_DY)}
      >other workspace</text
    >
  {/if}
  {#if summary.errorCount > 0}
    <text
      class="badge"
      data-testid={TESTID.deckErrorBadge}
      data-count={String(summary.errorCount)}
      x={placement.x}
      y={roundCoord(placement.y - placement.R - BADGE_DY)}>{summary.errorCount}</text
    >
  {/if}
</g>

<style>
  .blob {
    cursor: pointer;
  }

  /* C7.8: a real focusable element with a VISIBLE focus ring. Both an outline
     and a membrane weight change, because outline support on SVG containers is
     uneven — the stroke change is the one that always shows. */
  .blob:focus-visible {
    outline: 2px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 2px;
  }

  .blob:focus-visible .membrane,
  .blob:hover .membrane {
    stroke-width: 2.4;
  }

  .membrane {
    fill: var(--vscode-editor-background);
    stroke: var(--vscode-descriptionForeground, currentColor);
    stroke-width: 1.6;
  }

  /* Membrane colour is the liveness channel (C7.3). One rule per row. */
  .blob[data-liveness='live'] .membrane {
    stroke: var(--vscode-charts-green, currentColor);
  }

  .blob[data-liveness='idle'] .membrane {
    stroke: var(--vscode-charts-yellow, currentColor);
  }

  .blob[data-liveness='ended'] .membrane {
    stroke: var(--vscode-descriptionForeground, currentColor);
    opacity: 0.7;
  }

  /* G3: refused. Red, dashed, cracked — never a partial tree. Hung on the
     contract class rather than on the liveness attribute, so the class the
     matrix suite asserts is the class that does the work. Placed after the
     liveness rules because it has the same specificity and must win. */
  .blob :global(.is-cracked) {
    stroke: var(--vscode-errorForeground, currentColor);
    stroke-dasharray: 7 5;
    opacity: 1;
  }

  .crack {
    fill: none;
    stroke: var(--vscode-errorForeground, currentColor);
    stroke-width: 1.2;
    opacity: 0.8;
  }

  /* G2, degraded: liveness was INFERRED from the JSONL tap, so the ring goes
     hollow rather than showing the same confident fill a hook event earns. */
  .blob :global(.is-hollow-live) {
    fill: none;
    stroke-dasharray: 6 4;
  }

  /* `workspaceMatch: false` — another workspace's session, ghosted. */
  .blob:global(.is-foreign) {
    opacity: 0.38;
  }

  .pulse {
    fill: none;
    stroke: var(--vscode-charts-green, currentColor);
    opacity: 0;
  }

  /* C7.1: faint, and faint is the point — density readable without a number,
     never competing with the membrane that carries liveness. */
  .constellation circle {
    fill: var(--vscode-descriptionForeground, currentColor);
    opacity: 0.35;
  }

  .label {
    fill: var(--vscode-foreground);
    font-size: 13px;
    text-anchor: middle;
  }

  .tag {
    fill: var(--vscode-descriptionForeground, currentColor);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-anchor: middle;
  }

  .badge {
    fill: var(--vscode-errorForeground, currentColor);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    text-anchor: middle;
  }

  /* ── motion (C7.6) ────────────────────────────────────────────────────
     Transform and opacity only, on `fill-box` origins, so no animation can
     touch a coordinate a golden pins. Both selectors reach classes built from
     `ANIMATED_CLASSES`; `deck.test.ts` checks these literals against the
     constants. Nothing else in this file animates — in particular the
     constellation has no rule here and no animated ancestor. */
  .blob :global(.is-breathing) {
    transform-box: fill-box;
    transform-origin: center;
    animation: breathe 4.6s ease-in-out infinite;
  }

  @keyframes breathe {
    50% {
      transform: scale(1.022);
    }
  }

  .blob :global(.is-pulsing) {
    transform-box: fill-box;
    transform-origin: center;
    animation: pulse 2.6s ease-out infinite;
  }

  @keyframes pulse {
    0% {
      opacity: 0.55;
      stroke-width: 1.4;
      transform: scale(1);
    }
    100% {
      opacity: 0;
      stroke-width: 0.4;
      transform: scale(1.22);
    }
  }

  /* `prefers-reduced-motion` is swapped BY CLASS from the deck root, not by a
     media query alone, because a media query does not evaluate in jsdom and
     the rule has to stay assertable. The static variant keeps the live ring
     visible — it stops moving, it does not disappear. */
  :global(.reduced-motion) .blob :global(.is-breathing) {
    animation: none;
  }

  :global(.reduced-motion) .blob :global(.is-pulsing) {
    animation: none;
    opacity: 0.3;
  }

  @media (prefers-reduced-motion: reduce) {
    .blob :global(.is-breathing),
    .blob :global(.is-pulsing) {
      animation: none;
    }
  }
</style>
