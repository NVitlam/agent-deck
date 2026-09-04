<!--
  Altitude 0 — the Deck.

  A fixed 40 px control bar over a pan/zoom field of session cards. The bar
  does NOT pan and does NOT zoom: it is a sibling of the SVG, not a child of
  the stage, which is the only arrangement in which a control stays where the
  user left it while the field moves under it.

  THE TRANSFORM IS A TRANSFORM, NEVER A COORDINATE. Pan and zoom are one
  `transform` attribute on one wrapper `<g>` (`TESTID.deckStage`), produced by
  `viewport.ts:transformAttr`. Nothing here edits a placement. Three things
  depend on that and all three break silently if it is violated: `layout.ts`
  stays a pure function of state, its goldens stay valid as NUMBERS rather
  than as numbers-at-a-zoom, and "a spawn adds, it never reflows" survives a
  user dragging the view around.

  ONE VIEWPORT MODULE, NOT TWO. Every gesture below routes through
  `viewport.ts` — `panBy` for the drag, `zoomAbout` for the wheel, `fitTo` for
  the double-click, all at `DECK_ZOOM_LIMITS` — and it routes through it VIA
  THE STORE, which owns `deckView`. This component does no pan/zoom arithmetic
  of its own. That is not tidiness: a second viewport with different clamps
  existed in this codebase once, agreed with itself, disagreed with the design,
  and nothing failed.

  WHEEL NOTCHES, NOT A FACTOR. `onzoom` reports a signed notch count and the
  store applies `ZOOM_FACTOR ** notches`. A fixed step per notch rather than
  one proportional to `deltaY`: browsers report wildly different magnitudes for
  the same physical gesture, and a proportional factor makes a trackpad and a
  mouse wheel feel like two different controls.

  THE CONTROL BAR'S STATE IS SPLIT, ON PURPOSE, AND THE SPLIT IS THE FIX.
  Layout and sort are `$state` here. The ENGINE FILTER is not: it arrives as a
  prop and its changes go out through `onenginefilter`, because `App.svelte`
  mounts this component only while the altitude is `deck`. Component state
  therefore dies on entering a session and comes back at its default — which
  is what the engine filter used to do, silently, while the liveness filter
  beside it persisted in the store. Two chips side by side behaving
  differently, with nothing explaining why.

  G7 is satisfied either way and by neither placement in particular: no VS Code
  setting, no `workspaceState`, no `localStorage`, no host message. What decides
  it is LIFETIME. A control whose value must outlive an unmount belongs to the
  store; one that need not, does not. Layout and sort are re-chosen from the bar
  in front of you; the engine filter answers "which half of my machine am I
  looking at", and having to re-answer it after every session visit is the bug.

  ORDER IS THE SORT'S, AND THE DOM FOLLOWS IT. `deckLayout` returns placements
  in sorted order and the cards are emitted in that same order, so C7.8's
  "screen-reader order follows the store, not the geometry" still holds — what
  a screen reader walks is what the user chose to sort by, and nothing in
  between reorders anything a second time.
-->
<script lang="ts">
  import {
    DEFAULT_ENGINE_FILTER,
    ENGINE_FILTERS,
    REDUCED_MOTION_CLASS,
    TESTID,
  } from './canvas-contract.js';
  import type { EngineFilter } from './canvas-contract.js';
  import {
    DECK_CARD_H,
    DECK_CARD_W,
    DEFAULT_DECK_LAYOUT,
    DEFAULT_DECK_SORT,
    deckEngine,
    deckLayout,
  } from './layout.js';
  import type {
    DeckEngine,
    DeckLayoutMode,
    DeckSession,
    DeckSortMode,
  } from './layout.js';
  import { displayLiveness } from './format.js';
  import { boundsOf, transformAttr, viewportWidthInStageUnits } from './viewport.js';
  import type { Rect, Viewport, ViewportSize } from './viewport.js';
  import type { SessionSummary } from './store.js';
  import SessionCell from './SessionCell.svelte';

  let {
    sessions = [],
    degraded = false,
    degradedReason = undefined,
    selectedSessionId,
    reducedMotion = false,
    onenter,
    deckView = { x: 0, y: 0, k: 1 },
    onpan,
    onzoom,
    onreset,
    onfit,
    total,
    engineFilter = DEFAULT_ENGINE_FILTER,
    onenginefilter,
    now,
    viewportWidth,
    viewportHeight,
  }: {
    /** Every session the host reported, summarised by the store. */
    sessions?: readonly SessionSummary[];
    /** The hook tap is silent: liveness is inferred everywhere (G2). */
    degraded?: boolean;
    degradedReason?: 'noHookEvents' | 'listenerDown' | undefined;
    /** The store's selected session, if any. */
    selectedSessionId?: string | undefined;
    /** The user prefers reduced motion. Swapped by class, never by query alone. */
    reducedMotion?: boolean;
    /** Wired to `Store.enterSession` — the deck to session-interior move. */
    onenter?: ((sessionId: string) => void) | undefined;
    /**
     * Pan/zoom, applied as an SVG TRANSFORM on the stage group.
     *
     * Taken as a transform rather than as an offset to apply to placements,
     * and held by the STORE rather than here, so it survives every re-render:
     * a new snapshot or diff replaces the session list and does not touch the
     * view. That is asserted directly in `deck.test.ts`.
     */
    deckView?: Viewport;
    /** Drag on empty field. Client-pixel deltas; `viewport.ts:panBy` applies them. */
    onpan?: ((dx: number, dy: number) => void) | undefined;
    /**
     * Wheel on the field. SIGNED NOTCHES, positive zooms in, and the point is
     * the cursor position in this element's own coordinates.
     */
    onzoom?: ((notches: number, clientX: number, clientY: number) => void) | undefined;
    /** The "Reset view" control: back to the identity transform. */
    onreset?: (() => void) | undefined;
    /**
     * Double-click on empty field: fit the content with `DECK_FIT_PADDING`.
     *
     * Separate from `onreset` because they are two different answers — reset
     * goes to 1:1 at the origin, fit goes to whatever scale shows everything —
     * and a user who has zoomed out to find a card wants the second one.
     */
    onfit?: ((content: Rect, size: ViewportSize) => void) | undefined;
    /** How many sessions exist before filtering. Defaults to what is shown. */
    total?: number | undefined;
    /*
     * `enabledEngines` WAS HERE, and its removal is the D4 fix (2026-09-04).
     *
     * It fed the empty state and nothing else: one waiting line per engine
     * this installation observes, so a machine with no OpenCode was never
     * shown a panel waiting for one. Sound reasoning, and it produced a
     * user-visible defect anyway — NOTHING EVER PASSED THE PROP. `App.svelte`
     * did not, so the default `['cc']` applied on every install, and an empty
     * deck told a Codex-only user that Agent Deck was "Waiting for a Claude
     * Code session…". The user found it by own eyes at the DoD 3.5 pass.
     *
     * The ruling is that a GENERIC state names no engine at all, so the prop
     * has nothing left to feed and is deleted rather than left as a parameter
     * whose documentation describes a behaviour that no longer exists.
     * Per-engine copy still exists where it is ABOUT one engine — the filter
     * chips, and a card's own tag — and `deck.test.ts` pins that boundary.
     */
    /**
     * Which engine's sessions to show. STORE STATE, arriving as a prop.
     *
     * The default is here so this component can still be mounted on its own —
     * it is the value the store also starts at, not a second opinion about
     * what the default is. `canvas-contract.ts` owns that constant.
     */
    engineFilter?: EngineFilter;
    /**
     * A chip or a key asked for a different engine. Wired to
     * `Store.setEngineFilter`.
     *
     * Reporting rather than setting: with the value in the store there is
     * exactly one of it, and a component that also kept its own copy would be
     * the two-agreeing-literals defect `canvas-contract.ts` exists to prevent,
     * in state instead of in a name.
     */
    onenginefilter?: ((filter: EngineFilter) => void) | undefined;
    /**
     * The renderer's clock, in epoch milliseconds, for each card's age.
     *
     * Read once per render from `Date.now()` when not supplied, and passed
     * down rather than read per card, so every card on one render measures
     * against one instant. A test supplies it and pins the strings exactly.
     */
    now?: number | undefined;
    /**
     * Field size in CLIENT PIXELS, for the grid's column count and for the
     * fit. Measured from the element when not supplied; supplied by tests,
     * where jsdom reports every box as zero.
     */
    viewportWidth?: number | undefined;
    viewportHeight?: number | undefined;
  } = $props();

  /**
   * Fallback field size, used when nothing has measured one yet.
   *
   * jsdom reports 0 for every box, and a 0-wide viewport gives
   * `deckColumns` its floor of 1 — a single column, which is a layout nobody
   * chose. A named constant makes the fallback visible instead of letting a
   * zero propagate silently into the geometry.
   */
  const FALLBACK_FIELD_W = 960;
  const FALLBACK_FIELD_H = 600;

  /** The control bar's fixed height. Not part of the field, never transformed. */
  const CONTROL_BAR_H = 40;

  /* --------------------------------------------------------------------- *
   * Control-bar state (G7)
   * --------------------------------------------------------------------- */

  /**
   * WHY THESE TWO LIVE HERE AND THE ENGINE FILTER DOES NOT.
   *
   * All three are webview-only view state — no setting, no persistence, no
   * host message, discarded when the panel closes — so G7 is satisfied
   * wherever they sit. What decides it is LIFETIME, and this component's
   * lifetime is shorter than the panel's: `App.svelte` mounts it only while
   * the altitude is `deck`, so anything held here is reset by a session visit.
   *
   * Layout and sort survive that correctly. They are re-chosen from the bar
   * that is in front of you at the moment you want them, and coming back to
   * the design's default grid is not a surprise. The engine filter does not:
   * it is a statement about which sessions the user considers theirs, it has
   * to hold across an entry and an exit, and it lived here through Phase 7 —
   * quietly resetting to `all` on every return from a session while the
   * liveness filter, already store state, held. It is `store.ts`'s now and
   * arrives as a prop.
   */
  let layoutMode = $state.raw<DeckLayoutMode>(DEFAULT_DECK_LAYOUT);
  let sortMode = $state.raw<DeckSortMode>(DEFAULT_DECK_SORT);

  /**
   * The chips and segments, in the order they render.
   *
   * The engine chips' VALUES come from `canvas-contract.ts:ENGINE_FILTERS`
   * rather than being spelled again here; only the label and the access key,
   * which are this component's, are added. A chip list that restated the
   * values could drift from the store's own validity check.
   */
  const ENGINE_LABELS: Readonly<Record<EngineFilter, { label: string; key: string }>> = {
    all: { label: 'All', key: 'a' },
    cc: { label: 'Claude Code', key: 'c' },
    oc: { label: 'OpenCode', key: 'o' },
    cx: { label: 'Codex', key: 'x' },
  };
  const ENGINE_CHIPS: readonly { value: EngineFilter; label: string; key: string }[] =
    ENGINE_FILTERS.map((value) => ({ value, ...ENGINE_LABELS[value] }));
  const LAYOUTS: readonly { value: DeckLayoutMode; label: string; key: string }[] = [
    { value: 'list', label: 'List', key: '1' },
    { value: 'grid', label: 'Grid', key: '2' },
    { value: 'lanes', label: 'Lanes', key: '3' },
  ];
  const SORTS: readonly { value: DeckSortMode; label: string; key: string }[] = [
    { value: 'live', label: 'Live first', key: 'l' },
    { value: 'recent', label: 'Recent', key: 'r' },
    { value: 'engine', label: 'Engine', key: 'e' },
  ];

  /**
   * The empty deck's one line. ENGINE-FREE, by ruling (D4, 2026-09-04).
   *
   * A deck with no sessions is a statement about the whole panel, so naming an
   * engine in it is naming the wrong thing twice over: it is not true of the
   * other engines, and it tells a user whose engine IS running that the panel
   * is waiting for a different one.
   */
  const WAITING = 'Waiting for a session to start.';

  /* --------------------------------------------------------------------- *
   * Derived geometry
   * --------------------------------------------------------------------- */

  let field = $state.raw<SVGSVGElement | undefined>(undefined);
  let measuredW = $state.raw(FALLBACK_FIELD_W);
  let measuredH = $state.raw(FALLBACK_FIELD_H);

  /** The engine each summary belongs to, in the deck's own two-letter tag. */
  const engineOf = (row: SessionSummary): DeckEngine => deckEngine(row.engine);

  /**
   * The visible set: the engine filter applied, and nothing else.
   *
   * `sessions` stays the full list the store handed over — the count chip
   * says "n of m" off it — so nothing downstream can mistake a filtered view
   * for the host's account of what exists.
   */
  let visible = $derived(
    engineFilter === 'all'
      ? [...sessions]
      : sessions.filter((row) => engineOf(row) === engineFilter),
  );

  /** Per-chip counts. Of the FULL set, so a chip says what it would show. */
  let counts = $derived({
    all: sessions.length,
    cc: sessions.filter((row) => engineOf(row) === 'cc').length,
    oc: sessions.filter((row) => engineOf(row) === 'oc').length,
    cx: sessions.filter((row) => engineOf(row) === 'cx').length,
  });

  /**
   * `SessionSummary` to `layout.ts:DeckSession`.
   *
   * `status` is the DISPLAYED liveness, which is not always the one on the
   * wire: a session refused by a `schemaMismatch` still says `live` there, and
   * sorting it among the live ones would put a card that shows `unsupported`
   * at the top of a "live first" deck.
   *
   * `DeckStatus` also has a `degraded` member and this never produces it. That
   * is deliberate: `degraded` here is the HOOK TAP's health, which is
   * panel-wide, so mapping it onto a per-session sort key would re-order the
   * whole deck the moment the tap went quiet — for every session at once, on a
   * fact about none of them.
   */
  let deckSessions = $derived<DeckSession[]>(
    visible.map((row) => ({
      id: row.sessionId,
      engine: engineOf(row),
      status: displayLiveness(row.liveness, row.refused),
      last: row.lastEventAt,
    })),
  );

  let fieldW = $derived(viewportWidth ?? measuredW);
  let fieldH = $derived(viewportHeight ?? measuredH);

  /**
   * The grid's width, in STAGE UNITS — pixels divided by the scale.
   *
   * `viewport.ts:viewportWidthInStageUnits` is the only supported conversion
   * and `deckLayout` takes stage units; handing it raw pixels is the one
   * argument allowed to be a measurement, and getting the units wrong there
   * is a reflow of every card.
   */
  let stageW = $derived(viewportWidthInStageUnits(fieldW, deckView.k));

  let placements = $derived(deckLayout(deckSessions, layoutMode, sortMode, stageW));

  /** The summary behind each placement, paired by id rather than by index. */
  let cards = $derived(
    placements.map((placement) => ({
      placement,
      summary: visible.find((row) => row.sessionId === placement.id),
    })),
  );

  /** The bounding rectangle of everything drawn, in stage units. */
  let content = $derived(
    boundsOf(
      placements.map((p) => ({ x: p.x, y: p.y, w: DECK_CARD_W, h: DECK_CARD_H })),
    ),
  );

  let transform = $derived(transformAttr(deckView));
  let clock = $derived(now ?? Date.now());
  let shown = $derived(visible.length);
  let totalCount = $derived(total ?? sessions.length);

  /* --------------------------------------------------------------------- *
   * The field: measurement, drag, wheel, double-click
   * --------------------------------------------------------------------- */

  const measure = (): void => {
    // `bind:this` writes NULL on unmount, not `undefined`, and this effect
    // re-runs after the field has gone — filtering down to an empty set
    // removes the `<svg>` entirely. A check against `undefined` alone threw
    // on the very next flush.
    if (field === undefined || field === null) return;
    const rect = field.getBoundingClientRect();
    // A zero box is jsdom, or an element not yet laid out. Keeping the
    // fallback is the honest answer to "nothing has measured this yet";
    // adopting the zero would collapse the grid to one column.
    if (rect.width > 0) measuredW = rect.width;
    if (rect.height > 0) measuredH = rect.height;
  };

  $effect(() => {
    measure();
    const onResize = (): void => measure();
    globalThis.addEventListener('resize', onResize);
    return () => globalThis.removeEventListener('resize', onResize);
  });

  /** Field-local coordinates of a pointer, which is what the transform uses. */
  function local(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = field?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  }

  /** True when the event started on a card rather than on the empty field. */
  function onCard(event: Event): boolean {
    const target = event.target as Element | null;
    return target?.closest(`[data-testid="${TESTID.deckBlob}"]`) !== null;
  }

  // Pointer events rather than mouse events, so a trackpad and a pen behave
  // the same, and `setPointerCapture` so a fast drag that leaves the element
  // does not strand the field mid-pan.
  let panning = $state.raw(false);
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (event: PointerEvent): void => {
    // Primary button, on the empty field only. A press on a card is that
    // card's business — the card has no drag of its own, and swallowing the
    // press here would swallow the click that enters the session.
    if (event.button !== 0) return;
    if (onCard(event)) return;
    panning = true;
    lastX = event.clientX;
    lastY = event.clientY;
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!panning) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    onpan?.(dx, dy);
  };

  const endPan = (event: PointerEvent): void => {
    if (!panning) return;
    panning = false;
    (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
  };

  const onWheel = (event: WheelEvent): void => {
    if (onzoom === undefined) return;
    event.preventDefault();
    const point = local(event);
    onzoom(event.deltaY < 0 ? 1 : -1, point.x, point.y);
  };

  const onDoubleClick = (event: MouseEvent): void => {
    // On the empty field only. A double-click on a card is two entries into
    // the same session, which is what the user asked for.
    if (onCard(event)) return;
    onfit?.(content, { width: fieldW, height: fieldH });
  };

  /* --------------------------------------------------------------------- *
   * Keyboard: A C O, 1 2 3, L R E
   * --------------------------------------------------------------------- */

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName ?? '';
    // Never steal a keystroke from a field the user is typing into.
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true) return;
    const key = event.key.toLowerCase();
    const engine = ENGINE_CHIPS.find((c) => c.key === key);
    if (engine !== undefined) {
      // Reported, not set. The store owns the value; see the note above.
      onenginefilter?.(engine.value);
      event.preventDefault();
      return;
    }
    const layout = LAYOUTS.find((c) => c.key === key);
    if (layout !== undefined) {
      layoutMode = layout.value;
      event.preventDefault();
      return;
    }
    const sort = SORTS.find((c) => c.key === key);
    if (sort !== undefined) {
      sortMode = sort.value;
      event.preventDefault();
    }
  };
</script>

<svelte:window on:keydown={onKeyDown} />

<section
  class={reducedMotion ? `deck ${REDUCED_MOTION_CLASS}` : 'deck'}
  data-testid={TESTID.deck}
  data-degraded={String(degraded)}
  data-sessions={String(sessions.length)}
  data-shown={String(shown)}
  data-layout={layoutMode}
  data-sort={sortMode}
  data-engine-filter={engineFilter}
  aria-label="Deck"
>
  <!-- THE CONTROL BAR. Fixed height, outside the SVG, so it neither pans nor
       zooms. Three groups: engines left, layout centre, sort right. -->
  <div class="bar" data-testid="deck-bar" style={`height:${CONTROL_BAR_H}px`}>
    <div class="group left" role="group" aria-label="Filter by engine">
      {#each ENGINE_CHIPS as chip (chip.value)}
        <button
          type="button"
          class="chip"
          data-testid="deck-engine-chip"
          data-engine={chip.value}
          data-active={String(engineFilter === chip.value)}
          data-count={String(counts[chip.value])}
          aria-pressed={engineFilter === chip.value}
          title={`${chip.label} (${chip.key.toUpperCase()})`}
          onclick={() => onenginefilter?.(chip.value)}
          >{chip.label}<span class="badge">{counts[chip.value]}</span></button
        >
      {/each}
    </div>

    <div class="group centre" role="group" aria-label="Layout">
      {#each LAYOUTS as option (option.value)}
        <button
          type="button"
          class="seg"
          data-testid="deck-layout-option"
          data-layout={option.value}
          data-active={String(layoutMode === option.value)}
          aria-pressed={layoutMode === option.value}
          title={`${option.label} (${option.key})`}
          onclick={() => (layoutMode = option.value)}>{option.label}</button
        >
      {/each}
    </div>

    <div class="group right" role="group" aria-label="Sort">
      {#each SORTS as option (option.value)}
        <button
          type="button"
          class="seg"
          data-testid="deck-sort-option"
          data-sort={option.value}
          data-active={String(sortMode === option.value)}
          aria-pressed={sortMode === option.value}
          title={`${option.label} (${option.key.toUpperCase()})`}
          onclick={() => (sortMode = option.value)}>{option.label}</button
        >
      {/each}
      <span
        class="count"
        data-testid="deck-count"
        data-shown={String(shown)}
        data-total={String(totalCount)}
        >{shown === totalCount ? `${totalCount}` : `${shown} of ${totalCount}`}</span
      >
      {#if onreset !== undefined}
        <button
          type="button"
          class="seg"
          data-testid={TESTID.deckReset}
          data-identity={String(deckView.x === 0 && deckView.y === 0 && deckView.k === 1)}
          onclick={() => onreset?.()}>Reset view</button
        >
      {/if}
    </div>
  </div>

  {#if visible.length === 0}
    <!-- One quiet line. Not an error, not a spinner, not a call to action —
         and it names no engine, because an empty deck is a fact about the
         panel rather than about any one of the three things feeding it. -->
    <div class="empty" data-testid={TESTID.deckEmpty}>
      {#if sessions.length > 0}
        <p data-testid="deck-empty-filtered">No sessions match this filter.</p>
      {:else}
        <p data-testid="deck-waiting">{WAITING}</p>
      {/if}
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <svg
      bind:this={field}
      class="field"
      class:panning
      role="group"
      aria-label="Sessions"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={endPan}
      onpointercancel={endPan}
      onwheel={onWheel}
      ondblclick={onDoubleClick}
    >
      <!-- THE STAGE. Everything pan and zoom do happens on this one attribute.
           Nothing below it knows the view has moved, which is exactly why the
           layout goldens cannot be disturbed by a drag. -->
      <g data-testid={TESTID.deckStage} {transform}>
        {#each cards as card (card.placement.id)}
          {#if card.summary !== undefined}
            <!--
              D2 (2026-09-03): `degraded` is the CLAUDE CODE hook tap's health
              and it is panel-wide, so it is passed only to a Claude Code card.

              It used to go to every card, which put "Codex: no hook events"
              on a Codex cell whose hooks were arriving perfectly — reported by
              own eyes against the shipped release/0.6.0 build. The banner is
              produced by `LivenessEngine.degradedState()`, which reads
              `eventsReceived === 0` on the CC engine alone; before Phase 3's
              discriminator every Codex payload was ALSO dispatched into the CC
              handler, so that counter moved and the tap looked alive. Routing
              them correctly is what exposed the mislabelling.

              The same reasoning the sort key above already states: a fact
              about none of these sessions must not be rendered onto all of
              them.
            -->
            <SessionCell
              summary={card.summary}
              x={card.placement.x}
              y={card.placement.y}
              degraded={degraded && engineOf(card.summary) === 'cc'}
              {degradedReason}
              {reducedMotion}
              now={clock}
              selected={card.summary.sessionId === selectedSessionId}
              {onenter}
            />
          {/if}
        {/each}
      </g>
    </svg>
  {/if}
</section>

<style>
  /* Every colour is a VS Code theme variable. The frozen mockup hardcodes a
     dark palette only because it lives outside VS Code (C7.7). */
  .deck {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 0 0 auto;
    padding: 0 8px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    /* The bar is a sibling of the field, so it cannot inherit the stage
       transform. Stated here as well as in the header because it is the whole
       reason the markup is shaped this way. */
    transform: none;
  }

  .group {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .group.centre {
    margin: 0 auto;
  }

  .group.right {
    margin-left: auto;
  }

  .chip,
  .seg {
    font: inherit;
    font-size: 0.85em;
    color: var(--vscode-foreground);
    background: transparent;
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 9px;
    padding: 0 8px;
    cursor: pointer;
    white-space: nowrap;
  }

  .seg {
    border-radius: 3px;
  }

  .chip[data-active='true'],
  .seg[data-active='true'] {
    background: var(--vscode-badge-background, transparent);
    color: var(--vscode-badge-foreground, inherit);
  }

  .chip:focus-visible,
  .seg:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 1px;
  }

  .badge {
    margin-left: 5px;
    opacity: 0.75;
    font-variant-numeric: tabular-nums;
  }

  .count {
    font-size: 0.85em;
    opacity: 0.8;
    white-space: nowrap;
  }

  .field {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: block;
    width: 100%;
    touch-action: none;
    cursor: grab;
  }

  .field.panning {
    cursor: grabbing;
  }

  /* C7.6, the field's half. The card swaps its pulse for a static ring; the
     field's own job is to run no transition at all. Stated as a rule rather
     than left implicit because Svelte PRUNES a scoped selector it cannot
     prove is used, and a class applied with no rule behind it is a
     reduced-motion mode that exists only in the DOM. */
  .deck.reduced-motion .field {
    transition: none;
  }

  .empty {
    margin: auto;
    opacity: 0.75;
    text-align: center;
  }

  .empty p {
    margin: 4px 0;
  }
</style>
