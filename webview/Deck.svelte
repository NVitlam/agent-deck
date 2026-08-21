<!--
  Altitude 0 — the Deck (spec C7.1).

  Every session of the open workspace as a blob on a dark field: silhouette from
  a hash of the `sessionId`, size from `log(nodeCount)`, membrane colour from
  liveness, and a faint interior constellation of one dot per node so density
  reads without a number. It answers one question at a glance — "is anything
  running right now" — and nothing else.

  IT TAKES `SessionSummary`, THE STORE'S OWN VIEW ROW. A summary carries
  `sessionId` and `nodeCount`, which is exactly `layout.ts:DeckSession`, so it
  satisfies `deckLayout` directly and no surface needs a whole `SessionState`
  to size a blob. `refused` comes from the summary too, so this component holds
  no second opinion about what refusal means — the disjunction it used to
  restate is gone, and with it the `refusedIds` prop that existed only to patch
  the half of that union a `SessionState` could not express.

  ORDERING IS LOAD-BEARING AND THIS COMPONENT DOES NOT TOUCH IT. `deckLayout`
  places by ARRAY INDEX, so whoever re-sorts the list moves the blobs. This
  component renders `sessions` in the order it was handed them, with no sort,
  no filter and no partition — which is the store's `order`, which is the order
  the host's snapshot arrived in. That also satisfies C7.8's "screen-reader
  order follows the store, not the geometry": DOM order here IS store order,
  because nothing in between reorders anything.

  GEOMETRY IS `layout.ts`'s. Every coordinate on this surface comes from
  `deckLayout`, `blobPath` and `constellationPoints`. The one thing computed
  here is the SVG `viewBox`, and that is viewport fitting rather than layout —
  `layout.ts`'s header assigns it to the renderer explicitly, and it is a
  transform of already-placed coordinates, never a re-placement of them.

  ZERO HOST CHANGE (C7.7). Selecting a blob calls back to `Store.enterSession`;
  no new message exists in either direction and the altitude is never told to
  the host.
-->
<script lang="ts">
  import type { DeckPlacement } from './canvas-contract.js';
  import { REDUCED_MOTION_CLASS, TESTID } from './canvas-contract.js';
  import { deckLayout, roundCoord } from './layout.js';
  import type { SessionSummary } from './store.js';
  import SessionBlob from './SessionBlob.svelte';

  let {
    sessions = [],
    degraded = false,
    selectedSessionId,
    reducedMotion = false,
    onenter,
    deckView = { x: 0, y: 0, k: 1 },
    onpan,
    onzoom,
    onreset,
    total,
  }: {
    /**
     * Every session the host reported, summarised by the store, in the order
     * it reported them.
     */
    sessions?: readonly SessionSummary[];
    /** The hook tap is silent: every live membrane goes dash-hollow (G2). */
    degraded?: boolean;
    /** The store's selected session, if any. */
    selectedSessionId?: string | undefined;
    /** The user prefers reduced motion. Swapped by class, never by query alone. */
    reducedMotion?: boolean;
    /** Wired to `Store.enterSession` — the deck to session-interior move. */
    onenter?: ((sessionId: string) => void) | undefined;
    /**
     * Pan/zoom, applied as an SVG TRANSFORM on the stage group.
     *
     * The whole point of taking it as a transform rather than as an offset to
     * apply to placements: `deckLayout` stays a pure function of state, its
     * goldens stay valid as numbers, and "a spawn adds, it never reflows" is
     * untouched by a user dragging the view around. A pan implementation that
     * edited coordinates would break all three silently.
     */
    deckView?: { x: number; y: number; k: number };
    onpan?: ((dx: number, dy: number) => void) | undefined;
    onzoom?: ((factor: number, originX: number, originY: number) => void) | undefined;
    onreset?: (() => void) | undefined;
    /** How many sessions exist before filtering. Defaults to what is shown. */
    total?: number | undefined;
  } = $props();

  /** Slack around the placed blobs, leaving room for labels and tags. */
  const VIEWBOX_MARGIN = 96;

  /*
   * The summaries go straight in. `DeckSession` is `{ sessionId, nodeCount }`
   * and a `SessionSummary` carries both, so there is no conversion step and no
   * opportunity for one to be skipped — which is what `toDeckSession` existed
   * to prevent back when the deck was fed whole `SessionState`s.
   */
  let placements = $derived(deckLayout(sessions));

  function viewBoxOf(placed: readonly DeckPlacement[]): string {
    // A degenerate box for the empty deck; nothing is drawn into it.
    if (placed.length === 0) return '0 0 1 1';
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of placed) {
      minX = Math.min(minX, p.x - p.R);
      minY = Math.min(minY, p.y - p.R);
      maxX = Math.max(maxX, p.x + p.R);
      maxY = Math.max(maxY, p.y + p.R);
    }
    return [
      roundCoord(minX - VIEWBOX_MARGIN),
      roundCoord(minY - VIEWBOX_MARGIN),
      roundCoord(maxX - minX + 2 * VIEWBOX_MARGIN),
      roundCoord(maxY - minY + 2 * VIEWBOX_MARGIN),
    ].join(' ');
  }

  let viewBox = $derived(viewBoxOf(placements));

  // Drag to pan. Pointer events rather than mouse events so a trackpad and a
  // pen behave the same, and `setPointerCapture` so a fast drag that leaves
  // the element does not stick the deck mid-pan.
  let dragging = $state.raw(false);
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (event: PointerEvent): void => {
    // Only a plain primary-button drag on the background. A drag that starts
    // on a blob is that blob's business — otherwise panning would swallow the
    // click that enters a session.
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    if (target?.closest('[data-testid="deck-blob"]') !== null) return;
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
    // A fixed step per notch rather than one proportional to deltaY: browsers
    // report wildly different magnitudes for the same physical gesture, and a
    // proportional factor makes a trackpad and a mouse wheel feel like two
    // different controls.
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    const rect = (event.currentTarget as Element).getBoundingClientRect();
    onzoom(factor, event.clientX - rect.left, event.clientY - rect.top);
  };

  let shown = $derived(sessions.length);
  let totalCount = $derived(total ?? sessions.length);
  let transform = $derived(
    `translate(${deckView.x} ${deckView.y}) scale(${deckView.k})`,
  );

  /** The placement and the summary it belongs to, paired by index. */
  let blobs = $derived(
    placements.map((placement, index) => ({ placement, summary: sessions[index] })),
  );
</script>

<section
  class={reducedMotion ? `deck ${REDUCED_MOTION_CLASS}` : 'deck'}
  data-testid={TESTID.deck}
  data-degraded={String(degraded)}
  data-sessions={String(sessions.length)}
  aria-label="Deck"
>
  <div class="deck-chrome">
    <!-- Says what is showing AND out of how many, so a filter can never look
         like "these are all the sessions there are". -->
    <span class="count" data-testid={TESTID.countChip} data-shown={String(shown)}
      data-total={String(totalCount)}
      >{shown === totalCount ? `${shown} sessions` : `${shown} of ${totalCount}`}</span
    >
    <!-- The membrane-colour key. The grammar is only legible if it is stated
         somewhere; C7.3 defines it and until now nothing showed it. -->
    <span class="legend" data-testid={TESTID.legend}>
      <span class="key" data-liveness="live">live</span>
      <span class="key" data-liveness="idle">idle</span>
      <span class="key" data-liveness="ended">ended</span>
      <span class="key" data-liveness="unsupported">refused</span>
    </span>
    {#if onreset !== undefined}
      <button
        class="reset"
        type="button"
        data-testid={TESTID.deckReset}
        data-identity={String(deckView.x === 0 && deckView.y === 0 && deckView.k === 1)}
        onclick={() => onreset?.()}>Reset view</button
      >
    {/if}
  </div>

  {#if sessions.length === 0}
    <!-- C7.3, the last row: an empty deck and one quiet line. Not an error,
         not a spinner, and not a call to action. -->
    <p class="empty" data-testid={TESTID.deckEmpty}>No sessions in this workspace.</p>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <svg
      class="field"
      class:dragging
      {viewBox}
      role="group"
      aria-label="Sessions"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={endDrag}
      onpointercancel={endDrag}
      onwheel={onWheel}
    >
      <!-- THE STAGE. Everything pan/zoom does happens on this one attribute.
           Nothing below it knows the view has moved, which is exactly why the
           layout goldens cannot be disturbed by a drag. -->
      <g data-testid={TESTID.deckStage} {transform}>
        {#each blobs as blob (blob.placement.sessionId)}
          {#if blob.summary !== undefined}
            <SessionBlob
              summary={blob.summary}
              placement={blob.placement}
              {degraded}
              selected={blob.summary.sessionId === selectedSessionId}
              {onenter}
            />
          {/if}
        {/each}
      </g>
    </svg>
  {/if}
</section>

<style>
  .deck-chrome {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 3px 10px;
    font-size: 0.85em;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }

  .count {
    opacity: 0.8;
  }

  .legend {
    display: flex;
    gap: 10px;
    margin-left: auto;
    opacity: 0.85;
  }

  .key::before {
    content: '';
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 4px;
    border-radius: 50%;
    vertical-align: baseline;
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

  .reset {
    font: inherit;
    font-size: 0.95em;
    color: var(--vscode-foreground);
    background: transparent;
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 3px;
    padding: 0 6px;
    cursor: pointer;
  }

  .reset:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 1px;
  }

  .field {
    touch-action: none;
    cursor: grab;
  }

  .field.dragging {
    cursor: grabbing;
  }
  /* Every colour is a VS Code theme variable. The frozen mockup hardcodes a
     dark palette only because it lives outside VS Code (C7.7). */
  .deck {
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

  .empty {
    margin: auto;
    opacity: 0.75;
  }
</style>
