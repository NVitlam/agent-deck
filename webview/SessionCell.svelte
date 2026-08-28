<!--
  Altitude 0 — ONE session card.

  Replaces `SessionBlob.svelte`, which drew a phyllotaxis blob: a silhouette
  hashed from the session id, a radius from `log(nodeCount)` and a faint
  interior constellation of one dot per node. All of that geometry is DELETED
  rather than deprecated (`layout.ts`'s header records the deletion), so this
  file is a rewrite and not an edit.

  ONE SHAPE IN EVERY LAYOUT. 220 x 88, radius 10, three rows, in `list`, in
  `grid` and in `lanes` alike. The layout mode chooses where the card goes and
  never what it looks like — which is what lets `deckLayout` stay a pure
  function of `{ id, engine, status, last }` with no drawn size anywhere in it.
  The predecessor separated on a DRAWN RADIUS that grew with child count, so
  one new tool call moved cards already on screen; a constant footprint is the
  fix and a constant card is what makes the footprint constant.

  IT TAKES `SessionSummary`, THE STORE'S OWN VIEW ROW, and derives nothing.
  Every number on the card — `agents`, `inflight`, `errorCount`, `burn`,
  `costUsd`, `lastEventAt` — is computed once in `store.ts:summarize`. A
  component that walked the tree itself would be a second implementation of
  each rule, and two implementations of one rule is how they come to disagree.

  NOTHING HERE IS DRAGGABLE, and a DoD item greps this file to prove it — so
  the pattern it greps for is deliberately NOT written anywhere below, comment
  included. The blob this replaces could be pulled aside because a spiral
  overlaps itself and a covered blob had to be movable; a grid does not
  overlap, so the gesture has nothing left to do, and its threshold logic —
  which existed to tell a pull-aside from the click that enters a session —
  goes with it. Moving the VIEW is the field's job and lives in `Deck.svelte`.

  SVG, NOT HTML, AND THAT IS FORCED. The stage is one `<g>` carrying the
  pan/zoom transform (`viewport.ts:transformAttr` emits SVG syntax), so a card
  drawn as a `<div>` could not sit inside it. Two consequences worth knowing
  before editing: `element.click()` THROWS on an `SVGElement` in jsdom, so a
  test must dispatch a `MouseEvent` (`testkit.ts:press`); and the shared
  `StatusChip.svelte` is an HTML `<span>` and therefore cannot be reused here,
  which is why row 3's chip is drawn inline.
-->
<script lang="ts">
  import {
    CRACKED_CLASS,
    FOREIGN_CLASS,
    HOLLOW_LIVE_CLASS,
    ANIMATED_CLASSES,
    TESTID,
  } from './canvas-contract.js';
  import {
    EM_DASH,
    degradedReasonText,
    displayLiveness,
    formatCost,
    livenessLabel,
    livenessTitle,
  } from './format.js';
  import { DECK_CARD_H, DECK_CARD_W, formatCompactTokens } from './layout.js';
  import type { SessionSummary } from './store.js';

  let {
    summary,
    x = 0,
    y = 0,
    degraded = false,
    degradedReason = undefined,
    selected = false,
    reducedMotion = false,
    now = 0,
    onenter,
  }: {
    /** The store's row. Everything drawn below comes from it. */
    summary: SessionSummary;
    /** Stage x, from `layout.ts:deckLayout`. A placement, never edited here. */
    x?: number;
    /** Stage y, from `layout.ts:deckLayout`. */
    y?: number;
    /** The hook tap is silent (G2): liveness is inferred, and the card says so. */
    degraded?: boolean;
    /** Why the hook tap is silent, when the host said. Feeds the tooltip. */
    degradedReason?: 'noHookEvents' | 'listenerDown' | undefined;
    /** This is the session the store has selected. */
    selected?: boolean;
    /** The user prefers reduced motion: the pulse becomes a static ring. */
    reducedMotion?: boolean;
    /**
     * The renderer's clock, in epoch milliseconds, for the row-3 age.
     *
     * PASSED IN rather than read here, so this component has no clock of its
     * own and a test can pin the rendered string exactly. 0 means "no clock
     * supplied", and the age then renders as an em-dash rather than as the
     * 56-year-old figure `Date.now() - 0` would produce.
     */
    now?: number;
    onenter?: ((sessionId: string) => void) | undefined;
  } = $props();

  /* --------------------------------------------------------------------- *
   * Geometry. Every number is a constant of the frozen design; the two that
   * are the card's own size come from `layout.ts`, so the drawn card and the
   * placed footprint cannot drift apart.
   * --------------------------------------------------------------------- */

  /** Corner radius. */
  const RADIUS = 10;
  /** Horizontal padding. */
  const PAD_X = 12;
  /** Vertical padding. */
  const PAD_Y = 9;
  /** Baseline of row 1 — engine pill and label. */
  const ROW1_Y = 24;
  /** Baseline of row 2 — the mono figures. */
  const ROW2_Y = 50;
  /** Baseline of row 3 — status chip and age. */
  const ROW3_Y = 76;
  /** Engine pill box. */
  const PILL_W = 22;
  const PILL_H = 14;
  const PILL_Y = ROW1_Y - 11;
  /** Where the session label starts, clear of the pill. */
  const LABEL_X = PAD_X + PILL_W + 6;
  /** Status dot radius, and its centre offset from the row-3 baseline. */
  const DOT_R = 4;
  const DOT_DY = -4;
  /** Error badge, top right. */
  const BADGE_R = 8;
  const BADGE_CX = DECK_CARD_W - PAD_X - BADGE_R;
  const BADGE_CY = PAD_Y + BADGE_R;
  /** The pulse ring stands off the card by this much on every side. */
  const RING_GAIN = 4;

  /* The two animation-bearing classes this altitude uses, taken from the
     contract rather than typed out. `is-flowing` is the filament's, in the
     session interior, and is not this component's to carry. */
  const BREATHING = ANIMATED_CLASSES[0];
  const PULSING = ANIMATED_CLASSES[1];
  /**
   * Applied ALONGSIDE the animation class under `prefers-reduced-motion`.
   *
   * The classes stay on (C7.6: the swap must not make the reduced-motion path
   * indistinguishable from an ended session — the semantics are carried by
   * the class, the motion by the animation) and this one turns the animation
   * off and leaves a static ring in its place.
   */
  const STATIC_CLASS = 'is-static';

  /** How long a label may be before it is cut. 220 units at ~6.6/char. */
  const LABEL_MAX_CHARS = 24;

  /**
   * The row-2 separator: a middle dot with a space either side.
   *
   * A `\u` escape in the script block rather than a numeric character
   * reference in the markup. The reference form for this glyph is a hash
   * followed by three digits, and three digits are three hex digits — the
   * no-hardcoded-colour guard reads this file as TEXT and takes it for a
   * short colour literal. Measured, not guessed: it failed exactly that way.
   */
  const SEP = ' \u00b7 ';

  /* --------------------------------------------------------------------- *
   * Derived state
   * --------------------------------------------------------------------- */

  /* A refused session displays `unsupported` even when the last snapshot said
     `live`: `schemaMismatch` refuses without changing the wire liveness, and
     `displayLiveness` is the ONE place that reconciliation happens. */
  let shown = $derived(displayLiveness(summary.liveness, summary.refused));
  let isLive = $derived(shown === 'live');
  let foreign = $derived(!summary.workspaceMatch);

  /**
   * The card's border treatment, and the one attribute that answers "which of
   * the six rows of the state table is this?".
   *
   * `degraded` outranks `live` here and ONLY here: a degraded live session is
   * still live everywhere else on the card (`data-liveness` says `live`, the
   * status chip says `live`, the breath still runs), because the value is
   * INFERRED rather than absent. What changes is the border, which is the
   * channel the design gave to "how well is this being observed".
   */
  let state = $derived(
    summary.refused
      ? 'unsupported'
      : degraded && isLive
        ? 'degraded'
        : shown,
  );

  /**
   * DoD 7.5, the deck half.
   *
   * Exactly the sessions with an in-flight tool call or a live cursor pulse,
   * and `idle`, `ended` and `unsupported` never do — the second clause is
   * written as a guard rather than left to follow from the first, because a
   * stale `running` tool under an idle session is a real state and the design
   * says an idle card is still.
   *
   * Suppressed while selected: the selection ring is itself amber, and a ring
   * pulsing inside a ring reads as a rendering fault rather than as two
   * different facts.
   */
  let pulses = $derived(
    (isLive || summary.inflight > 0) &&
      shown !== 'idle' &&
      shown !== 'ended' &&
      shown !== 'unsupported' &&
      !selected,
  );

  let label = $derived(
    summary.label.length > LABEL_MAX_CHARS
      ? `${summary.label.slice(0, LABEL_MAX_CHARS - 1)}…`
      : summary.label,
  );

  /** `CC` / `OC`. The deck's own two-letter vocabulary; `layout.ts` agrees. */
  let glyph = $derived(summary.engine === 'opencode' ? 'OC' : 'CC');
  /** The engine, spelled out, for the accessible name and the tooltip. */
  let engineName = $derived(
    summary.engine === 'opencode' ? 'OpenCode' : 'Claude Code',
  );

  /**
   * Row 2's token figure: `burn.prompt + burn.output`, compacted.
   *
   * BURN, the total — not `contextNow`, which is a level. A deck card answers
   * "what has this session spent", and summing a level across sessions would
   * be meaningless. `undefined` in yields `EM_DASH` out, never `0`: the
   * OpenCode engine reports no burn at all and printing 0 would claim it spent
   * nothing.
   */
  let burnTotal = $derived(
    summary.burn === undefined ? undefined : summary.burn.prompt + summary.burn.output,
  );
  let tokensText = $derived(formatCompactTokens(burnTotal));

  /* 0 means NOT YET COMPUTED, never "free" — `formatCost` renders it as an
     em-dash with the tooltip below, and there is no price table anywhere in
     this repository to render anything else. */
  let costText = $derived(formatCost(summary.costUsd));

  /**
   * The row-3 age: `4s`, `2m`, `3h`, `5d`.
   *
   * Coarse on purpose. The figure is a difference of two millisecond stamps
   * and the useful question is "how long ago", so it truncates rather than
   * rounds — a card reading `0s` for an event 900 ms old is correct, and one
   * reading `1s` would be a claim about a second that has not happened.
   */
  function ageText(atMs: number, nowMs: number): string {
    if (atMs <= 0 || !Number.isFinite(atMs)) return EM_DASH;
    if (!Number.isFinite(nowMs) || nowMs <= 0) return EM_DASH;
    const ms = nowMs - atMs;
    if (ms < 0) return EM_DASH;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  let age = $derived(ageText(summary.lastEventAt, now));

  /**
   * The tooltip, which is state-dependent (C7.3, and the deck half of it).
   *
   * `degraded` names the ENGINE and the reason code, because "liveness is
   * inferred" is only actionable if you know which tap went quiet.
   * `unsupported` names the refusal, and it names it in the words
   * `format.ts:livenessTitle` already owns rather than in a code — the
   * `schemaMismatch` message on the wire carries NO code (see
   * `src/model/events.ts`), so a card that printed one would be inventing it.
   */
  let tooltip = $derived(
    summary.refused
      ? livenessTitle('unsupported')
      : degraded
        ? `${engineName}: ${degradedReasonText(degradedReason)}`
        : livenessTitle(shown),
  );

  let groupClass = $derived(
    ['cell', summary.refused ? CRACKED_CLASS : '', foreign ? FOREIGN_CLASS : '']
      .filter((c) => c !== '')
      .join(' '),
  );

  let borderClass = $derived(
    [
      'border',
      summary.refused ? CRACKED_CLASS : '',
      isLive && degraded ? HOLLOW_LIVE_CLASS : '',
      isLive ? BREATHING : '',
      isLive && reducedMotion ? STATIC_CLASS : '',
    ]
      .filter((c) => c !== '')
      .join(' '),
  );

  let ringClass = $derived(
    ['ring', PULSING, reducedMotion ? STATIC_CLASS : ''].filter((c) => c !== '').join(' '),
  );

  let ariaLabel = $derived(
    `${summary.label} — ${shown}, ${summary.engine}${
      foreign ? ', other workspace' : ''
    }${
      summary.errorCount > 0
        ? `, ${summary.errorCount} tool ${summary.errorCount === 1 ? 'error' : 'errors'}`
        : ''
    }`,
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
  data-engine={summary.engine}
  data-liveness={shown}
  data-state={state}
  data-liveness-inferred={String(degraded)}
  data-foreign={String(foreign)}
  data-refused={String(summary.refused)}
  data-errors={String(summary.errorCount)}
  data-nodes={String(summary.nodeCount)}
  data-agents={String(summary.agents)}
  data-inflight={String(summary.inflight)}
  data-selected={String(selected)}
  data-pulsing={String(pulses)}
  data-cost={String(summary.costUsd)}
  data-burn={burnTotal === undefined ? '' : String(burnTotal)}
  aria-current={selected}
  role="button"
  tabindex="0"
  aria-label={ariaLabel}
  transform={`translate(${x} ${y})`}
  onclick={enter}
  onkeydown={onKeyDown}
>
  <title>{tooltip}</title>

  <!-- THE SELECTION RING, and the pulse, are the same geometry at two
       different jobs, so they are two elements rather than one class swap:
       a selected card must be able to show its ring while NOT pulsing. -->
  {#if selected}
    <rect
      class="selection"
      data-testid="deck-cell-selection"
      x={-RING_GAIN}
      y={-RING_GAIN}
      width={DECK_CARD_W + RING_GAIN * 2}
      height={DECK_CARD_H + RING_GAIN * 2}
      rx={RADIUS + RING_GAIN}
      fill="none"
    />
  {/if}
  {#if pulses}
    <rect
      class={ringClass}
      data-testid="deck-cell-pulse"
      data-static={String(reducedMotion)}
      x={-RING_GAIN}
      y={-RING_GAIN}
      width={DECK_CARD_W + RING_GAIN * 2}
      height={DECK_CARD_H + RING_GAIN * 2}
      rx={RADIUS + RING_GAIN}
      fill="none"
    />
  {/if}

  <rect
    class={borderClass}
    data-testid="deck-cell-border"
    x="0"
    y="0"
    width={DECK_CARD_W}
    height={DECK_CARD_H}
    rx={RADIUS}
  />

  <!-- Row 1: engine pill, then the session label. -->
  <rect
    class="pill"
    data-testid="deck-cell-pill"
    x={PAD_X}
    y={PILL_Y}
    width={PILL_W}
    height={PILL_H}
    rx="4"
  />
  <text
    class="pill-text"
    data-testid="deck-cell-engine"
    x={PAD_X + PILL_W / 2}
    y={ROW1_Y}
    text-anchor="middle">{glyph}</text
  >
  <text class="label" data-testid="deck-cell-label" x={LABEL_X} y={ROW1_Y}>{label}</text>

  {#if foreign}
    <text
      class="foreign"
      data-testid="deck-cell-foreign"
      x={summary.errorCount > 0 ? BADGE_CX - BADGE_R - 6 : DECK_CARD_W - PAD_X}
      y={ROW1_Y}
      text-anchor="end">other workspace</text
    >
  {/if}

  {#if summary.errorCount > 0}
    <g data-testid={TESTID.deckErrorBadge} data-count={String(summary.errorCount)}>
      <circle class="badge" cx={BADGE_CX} cy={BADGE_CY} r={BADGE_R} />
      <text class="badge-text" x={BADGE_CX} y={BADGE_CY + 3.5} text-anchor="middle"
        >{summary.errorCount}</text
      >
    </g>
  {/if}

  <!-- Row 2. Every figure is its own tspan so a test can assert it BY VALUE:
       `toContain('—')` on a concatenated row passes when every figure is a
       dash, which is exactly how a fully-dashed token line shipped once. -->
  <text class="meta" data-testid="deck-cell-meta" x={PAD_X} y={ROW2_Y}>
    <tspan data-testid="deck-cell-agents">{summary.agents} ag</tspan><tspan class="sep"
      >{SEP}</tspan
    ><tspan
      class={summary.inflight > 0 ? 'inflight busy' : 'inflight'}
      data-testid="deck-cell-inflight"
      data-busy={String(summary.inflight > 0)}>{summary.inflight} in flight</tspan
    ><tspan class="sep">{SEP}</tspan><tspan data-testid="deck-cell-tokens"
      >{tokensText}</tspan
    ><tspan class="sep">{SEP}</tspan><tspan data-testid="deck-cell-cost"
      >{costText}</tspan
    >
  </text>

  <!-- Row 3: status chip left, age right. -->
  <g data-testid="deck-cell-status" data-liveness={shown}>
    <circle class="dot dot-{shown}" cx={PAD_X + DOT_R} cy={ROW3_Y + DOT_DY} r={DOT_R} />
    <text class="status-text" x={PAD_X + DOT_R * 2 + 6} y={ROW3_Y}>{livenessLabel(shown)}</text>
  </g>
  <text
    class="age"
    data-testid="deck-cell-age"
    x={DECK_CARD_W - PAD_X}
    y={ROW3_Y}
    text-anchor="end">{age}</text
  >
</g>

<style>
  /* Every colour is a VS Code theme variable. The frozen mockup hardcodes a
     dark palette only because it lives outside VS Code (C7.7). */
  .cell {
    cursor: pointer;
  }

  .cell:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 2px;
  }

  /* --- the border, which is the state channel (C7.3) -------------------- */

  .border {
    fill: var(--vscode-editorWidget-background, transparent);
    stroke: var(--vscode-panel-border, currentColor);
    stroke-width: 1;
  }

  .cell:hover .border {
    /* Hover BRIGHTENS the border and does nothing else: no scale, no shadow.
       A card that grew on hover would move its neighbours' apparent spacing
       on a grid whose whole promise is that nothing already placed moves. */
    stroke: var(--vscode-focusBorder, currentColor);
  }

  .cell[data-state='live'] .border {
    stroke: var(--vscode-charts-yellow, currentColor);
    stroke-width: 1.5;
  }

  .cell[data-state='idle'] .border {
    stroke: var(--vscode-panel-border, currentColor);
    stroke-width: 1;
  }

  .cell[data-state='ended'] {
    opacity: 0.55;
  }

  .cell[data-state='ended'] .border {
    stroke: none;
  }

  .cell[data-state='degraded'] .border,
  .cell[data-state='unsupported'] .border {
    stroke: var(--vscode-editorWarning-foreground, currentColor);
    stroke-width: 1;
    stroke-dasharray: 4 3;
  }

  /* A live membrane whose liveness was INFERRED from the transcript because
     the hook tap is silent (G2). Hollow rather than filled: the card states
     that it is inferring instead of showing the same confident colour a hook
     event would have earned. */
  .is-hollow-live {
    fill: none;
  }

  /* A session the fingerprint refused (G3). Dashed, and never animated. */
  .is-cracked {
    stroke-dasharray: 4 3;
  }

  /* `workspaceMatch: false` — another workspace's session. Ghosted. */
  .is-foreign {
    opacity: 0.6;
  }

  /* --- selection and pulse --------------------------------------------- */

  .selection {
    stroke: var(--vscode-charts-yellow, currentColor);
    stroke-width: 2;
  }

  .ring {
    stroke: var(--vscode-charts-yellow, currentColor);
    stroke-width: 1.5;
  }

  .is-breathing {
    animation: cell-breathe 2400ms ease-in-out infinite;
  }

  .is-pulsing {
    animation: cell-pulse 1600ms ease-in-out infinite;
  }

  /* prefers-reduced-motion (C7.6): the motion is SWAPPED for a static ring,
     never removed along with the meaning. The classes above stay on the
     element — that is what keeps the reduced-motion path distinguishable
     from an ended session — and only the animation stops. */
  .is-static {
    animation: none;
    stroke-opacity: 0.9;
  }

  @keyframes cell-breathe {
    0%,
    100% {
      stroke-opacity: 1;
    }
    50% {
      stroke-opacity: 0.45;
    }
  }

  @keyframes cell-pulse {
    0% {
      stroke-opacity: 0.7;
    }
    50% {
      stroke-opacity: 0.15;
    }
    100% {
      stroke-opacity: 0.7;
    }
  }

  /* --- row 1 ------------------------------------------------------------ */

  .pill {
    fill: var(--vscode-badge-background, transparent);
  }

  .pill-text {
    fill: var(--vscode-badge-foreground, currentColor);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    font-weight: 700;
  }

  .label {
    fill: var(--vscode-foreground, currentColor);
    font-size: 12px;
    font-weight: 600;
  }

  .foreign {
    fill: var(--vscode-descriptionForeground, currentColor);
    font-size: 10px;
    font-style: italic;
  }

  .badge {
    fill: var(--vscode-errorForeground, currentColor);
  }

  .badge-text {
    fill: var(--vscode-editor-background, currentColor);
    font-size: 10px;
    font-weight: 700;
  }

  /* --- row 2 ------------------------------------------------------------ */

  .meta {
    fill: var(--vscode-descriptionForeground, currentColor);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }

  .busy {
    fill: var(--vscode-charts-yellow, currentColor);
  }

  .sep {
    opacity: 0.6;
  }

  /* --- row 3 ------------------------------------------------------------ */

  .dot {
    stroke: currentColor;
    stroke-width: 1;
  }

  .dot-live {
    fill: var(--vscode-charts-green, currentColor);
    stroke: var(--vscode-charts-green, currentColor);
  }

  .dot-idle {
    fill: none;
    stroke: var(--vscode-charts-yellow, currentColor);
  }

  .dot-ended {
    fill: var(--vscode-descriptionForeground, currentColor);
    stroke: var(--vscode-descriptionForeground, currentColor);
  }

  .dot-unsupported {
    fill: none;
    stroke: var(--vscode-errorForeground, currentColor);
    stroke-dasharray: 2 2;
  }

  .status-text,
  .age {
    fill: var(--vscode-descriptionForeground, currentColor);
    font-size: 11px;
  }
</style>
