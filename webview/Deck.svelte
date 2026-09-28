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
  import {
    boundsOf,
    createWheelNotcher,
    transformAttr,
    viewportWidthInStageUnits,
  } from './viewport.js';
  import type { Rect, Viewport, ViewportSize } from './viewport.js';
  import type { SessionSummary } from './store.js';
  import SessionCell from './SessionCell.svelte';

  let {
    sessions = [],
    degraded = false,
    degradedReason = undefined,
    degradedByEngine = undefined,
    selectedSessionId,
    reducedMotion = false,
    onenter,
    deckView = { x: 0, y: 0, k: 1 },
    onpan,
    onzoom,
    onfit,
    total,
    engineFilter = DEFAULT_ENGINE_FILTER,
    layoutMode = DEFAULT_DECK_LAYOUT,
    sortMode = DEFAULT_DECK_SORT,
    now,
    viewportWidth,
    viewportHeight,
  }: {
    /** Every session the host reported, summarised by the store. */
    sessions?: readonly SessionSummary[];
    /**
     * The CLAUDE CODE hook tap is silent (G2).
     *
     * Still here because `data-degraded` on the section is a panel-wide
     * attribute and this is the panel-wide fact. Cards do NOT read it -
     * see `degradedByEngine`.
     */
    degraded?: boolean;
    degradedReason?: 'noHookEvents' | 'listenerDown' | undefined;
    /**
     * EVERY hook tap's health, by engine (DoD 5.0b). What CARDS read.
     *
     * D2's fix stopped a Claude Code flag being painted onto Codex cards
     * by giving the cards nothing; this gives them the right thing. A
     * Codex card whose own tap is silent now says so, and one whose tap is
     * fine says nothing, which is what a user reported was missing.
     *
     * NO `oc` MEMBER: OpenCode has no hook tap at all, so an OpenCode card
     * asking is a type error rather than a rule to remember.
     *
     * Optional, and absent means "no tap is degraded" rather than
     * "Claude Code's value applies to everyone" - the default is what
     * every mount that does not care gets, and it must not be a lie.
     */
    degradedByEngine?:
      | Readonly<
          Record<'cc' | 'codex', { degraded: boolean; reason?: 'noHookEvents' | 'listenerDown' }>
        >
      | undefined;
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
    /**
     * Double-click on empty field: fit the content with `DECK_FIT_PADDING`.
     *
     * The other answer — back to the identity transform — is View ▸ Reset
     * view now, and it reaches the store directly. The two are still
     * different answers: reset goes to 1:1 at the origin, fit goes to
     * whatever scale shows everything, and a user who has zoomed out to find
     * a card wants the second one.
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
     * How the cards are placed, and in what order — v0.9.0 DoD 9.14.
     *
     * Props, like `engineFilter` beside them, and for the same reason: with
     * the values in the store there is exactly one of each, and a component
     * that also kept its own copy would be the two-agreeing-literals defect
     * `canvas-contract.ts` exists to prevent, in state instead of in a name.
     *
     * The defaults are here so this component can still be mounted on its own.
     * They are the values the store also starts at, not a second opinion about
     * what the defaults are — `layout.ts` owns both constants.
     */
    layoutMode?: DeckLayoutMode;
    sortMode?: DeckSortMode;
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


  /*
   * THE LAYOUT AND THE SORT WERE COMPONENT STATE UNTIL v0.9.0 DoD 9.14, and
   * the argument for that is now the argument against it.
   *
   * It ran: this component's lifetime is one deck visit, layout and sort are
   * "re-chosen from the bar that is in front of you at the moment you want
   * them", so a session visit resetting them is a decision rather than a leak.
   * Spec `Amendment 2026-09-20` removes the bar. There is nothing in front of
   * the user to re-choose from, so the lifetime argument has no subject, and
   * both values follow the engine filter into the HOST — which is also what
   * makes the sidebar's tick and the field agree.
   *
   * `agentDeck.defaultOrdering` still seeds the sort. It does it ONCE, at
   * activation, in `extension.ts`, which removes the two-mechanism dance this
   * block used to describe: there is no `sortChosen`, because a command the
   * user ran and a setting they set cannot race inside a component that no
   * longer holds either.
   */

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
  /**
   * The tap health for ONE engine (DoD 5.0b).
   *
   * `oc` returns a healthy tap rather than throwing, because OpenCode cards
   * are drawn by the same loop: it has no hook tap, so it can never be
   * hook-degraded, and that is a true answer rather than a fallback. The
   * TYPE is what forbids storing an `oc` value; this is what lets the
   * renderer stay one loop.
   *
   * When `degradedByEngine` is absent it falls back to the SCALAR for `cc`
   * only. That keeps every existing mount that passes `degraded` alone
   * behaving exactly as it did, and it is the one place the two shapes are
   * allowed to meet.
   */
  function tapFor(
    engine: DeckEngine,
  ): { degraded: boolean; reason?: 'noHookEvents' | 'listenerDown' } {
    if (engine === 'oc') return { degraded: false };
    // THE TWO VOCABULARIES MEET HERE, IN ONE PLACE, ON PURPOSE. The deck's
    // engine tag is `cx`; the tap record's key is `codex`, because that is
    // what `SessionState.engine` and the wire message call it. Two agreeing
    // literals is not a contract - this repository's recorded module-seam
    // defect - so the translation is a single expression rather than a
    // convention repeated at each call site. Written the wrong way first,
    // and `webview/deck.test.ts` caught it as a TypeError rather than as a
    // silently absent chip.
    const key = engine === 'cx' ? 'codex' : 'cc';
    if (degradedByEngine !== undefined) return degradedByEngine[key];
    if (key !== 'cc') return { degraded: false };
    return degradedReason === undefined ? { degraded } : { degraded, reason: degradedReason };
  }

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

  /*
   * ONE NOTCH PER GESTURE, NOT PER EVENT — v0.9.0 DoD 9.14.
   *
   * The accumulator is in `viewport.ts` so this surface and the session
   * interior obey one rule, and so the rule can be driven by a golden without
   * a DOM. `preventDefault` is unconditional, which is what makes ctrl+wheel
   * and trackpad pinch take the same path as an ordinary wheel: the amendment
   * says they obey the same law, and a special case here is how they would
   * stop.
   */
  const notcher = createWheelNotcher();

  const onWheel = (event: WheelEvent): void => {
    if (onzoom === undefined) return;
    event.preventDefault();
    const notches = notcher.feed(event.deltaY, event.deltaMode, event.timeStamp);
    if (notches === 0) return;
    const point = local(event);
    onzoom(notches, point.x, point.y);
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

  /*
   * The deck's own key handler was here until v0.9.0 DoD 9.14.
   *
   * THE SHORTCUTS STAY — the ruling says so — but they are the EDITOR'S now:
   * `package.json` binds c/o/x, 1/2/3 and l/r/e to the same commands the View
   * submenu runs, scoped by `activeWebviewPanelId == 'agentDeck.panel'` so
   * they cannot fire while somebody is typing in a file. A handler here would
   * be a second way to move a value this component no longer owns.
   *
   * Escape and `k` are NOT here and never were: they belong to
   * `SessionCanvas.svelte`, they move content rather than a control, and they
   * stay exactly where they are.
   */
</script>

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
  <!--
    THE CONTROL BAR WAS HERE UNTIL v0.9.0 DoD 9.14: four engine chips with
    their counts, three layout segments, three sort segments, the "n of m"
    count and Reset view.

    Spec `Amendment 2026-09-20 — Clean windows`: the field is content, and
    every one of those is an entry in View. The values still arrive — they are
    props now, from the store, from the host — so the deck draws exactly what
    it drew; nothing on it can be pressed.
  -->

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
              degraded={tapFor(engineOf(card.summary)).degraded}
              degradedReason={tapFor(engineOf(card.summary)).reason}
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

  /*
   * The control bar's rules were here until v0.9.0 DoD 9.14: bar, group,
   * chip, seg, badge and count. Every element they styled is gone.
   */

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
