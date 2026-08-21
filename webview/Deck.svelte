<!--
  Altitude 0 — the Deck (spec C7.1).

  Every session of the open workspace as a blob on a dark field: silhouette from
  a hash of the `sessionId`, size from `log(nodeCount)`, membrane colour from
  liveness. It answers one question at a glance — "is anything running right
  now" — and nothing else.

  ORDERING IS LOAD-BEARING AND THIS COMPONENT DOES NOT TOUCH IT. `deckLayout`
  places by ARRAY INDEX, so whoever re-sorts the list moves the blobs. This
  component renders `sessions` in the order it was handed them, with no sort,
  no filter and no partition — which is the store's `order`, which is the order
  the host's snapshot arrived in. That also satisfies C7.8's "screen-reader
  order follows the store, not the geometry": DOM order here IS store order,
  because nothing in between reorders anything.

  GEOMETRY IS `layout.ts`'s. Every coordinate on this surface comes from
  `deckLayout` / `blobPath` / `toDeckSession`. The one thing computed here is
  the SVG `viewBox`, and that is viewport fitting rather than layout —
  `layout.ts`'s header assigns it to the renderer explicitly, and it is a
  transform of already-placed coordinates, never a re-placement of them.

  ZERO HOST CHANGE (C7.7). Selecting a blob calls back to `Store.enterSession`;
  no new message exists in either direction and the altitude is never told to
  the host.
-->
<script lang="ts">
  import type { SessionState } from '../src/model/events.js';
  import type { DeckPlacement } from './canvas-contract.js';
  import { REDUCED_MOTION_CLASS, TESTID } from './canvas-contract.js';
  import { deckLayout, roundCoord, toDeckSession } from './layout.js';
  import SessionBlob from './SessionBlob.svelte';

  let {
    sessions = [],
    refusedIds = [],
    degraded = false,
    selectedSessionId,
    reducedMotion = false,
    onenter,
  }: {
    /**
     * Every session the host reported, in the order it reported them.
     *
     * Full `SessionState`s rather than the store's `SessionSummary`s, because
     * blob radius is a function of `nodeCount` (C7.1) and the deck-level error
     * badge is a function of the tree — neither is on a summary.
     */
    sessions?: readonly SessionState[];
    /**
     * Sessions refused by a `schemaMismatch` message rather than by their own
     * `schemaOk` flag — the half of the store's refusal set that is not
     * recoverable from a `SessionState`. Unioned below, so passing the store's
     * whole refused set instead is equally correct.
     *
     * The other half of that union is re-stated here rather than imported
     * because `store.ts` does not export it. It is the SAME disjunction
     * `layout.ts:sessionLayout` documents — `schemaOk === false` OR
     * `liveness === 'unsupported'`, refusing on either because that is the
     * safe direction — not a third opinion about what refusal means.
     */
    refusedIds?: readonly string[];
    /** The hook tap is silent: every live membrane goes dash-hollow (G2). */
    degraded?: boolean;
    /** The store's selected session, if any. */
    selectedSessionId?: string | undefined;
    /** The user prefers reduced motion. Swapped by class, never by query alone. */
    reducedMotion?: boolean;
    /** Wired to `Store.enterSession` — the deck to session-interior move. */
    onenter?: ((sessionId: string) => void) | undefined;
  } = $props();

  /** Slack around the placed blobs, leaving room for labels and tags. */
  const VIEWBOX_MARGIN = 96;

  let refused = $derived(new Set(refusedIds));

  /*
   * `toDeckSession` is the ONE supported conversion, and using it is not
   * stylistic: `SessionState` deliberately does not structurally satisfy
   * `DeckSession`, so passing a state straight in is a compile error rather
   * than a silently wrong radius.
   */
  let placements = $derived(deckLayout(sessions.map(toDeckSession)));

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

  /** The placement and the session it belongs to, paired by index. */
  let blobs = $derived(
    placements.map((placement, index) => ({ placement, session: sessions[index] })),
  );
</script>

<section
  class={reducedMotion ? `deck ${REDUCED_MOTION_CLASS}` : 'deck'}
  data-testid={TESTID.deck}
  data-degraded={String(degraded)}
  data-sessions={String(sessions.length)}
  aria-label="Deck"
>
  {#if sessions.length === 0}
    <!-- C7.3, the last row: an empty deck and one quiet line. Not an error,
         not a spinner, and not a call to action. -->
    <p class="empty" data-testid={TESTID.deckEmpty}>No sessions in this workspace.</p>
  {:else}
    <svg class="field" {viewBox} role="group" aria-label="Sessions">
      {#each blobs as blob (blob.placement.sessionId)}
        {#if blob.session !== undefined}
          <SessionBlob
            session={blob.session}
            placement={blob.placement}
            refused={!blob.session.schemaOk ||
              blob.session.liveness === 'unsupported' ||
              refused.has(blob.session.sessionId)}
            {degraded}
            selected={blob.session.sessionId === selectedSessionId}
            {onenter}
          />
        {/if}
      {/each}
    </svg>
  {/if}
</section>

<style>
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
