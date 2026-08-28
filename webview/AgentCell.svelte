<!--
  One agent inside a session interior (spec C7.1) — and the parked graft that
  is not inside it (C7.4).

  TWO MODES, ONE COMPONENT, deliberately. An in-tree agent arrives as an
  `AgentNode`; a PARKED graft has no node in the tree at all — the grafter
  refused to attach it, so `SessionState.parked` is the only record it exists
  and it carries no children, no tokens and no status to render. One component
  because they are one visual object in two states, and the state is passed as
  two mutually exclusive props rather than inferred: a cell that guessed which
  kind it was would be the guess G3 forbids, on the surface built to show that
  refusal.

  WHAT THE PARKED MODE SAYS. Unattached (nothing draws a filament to it —
  `SessionCanvas.svelte` only draws filaments from `spawnEdges`, and no edge
  resolved for this agent), dash-membraned, with a dangling dashed stub
  labelled "awaiting attribution". The stub points back toward the nucleus at
  the origin and STOPS — it reaches no dot, because reaching a plausible dot is
  exactly what the grafter declined to do.

  GEOMETRY IS `layout.ts`'s. The centre and radius come from
  `sessionLayout().cells` (or `.parked`), the silhouette from `blobPath` seeded
  by `hashSessionId(agentId)`. The label offsets, the stub length and the badge
  stand-off are presentation, transcribed from the frozen mockup
  `docs/ui/agent-deck-canvas-mockup.html` (`drawCell`; cited, never edited);
  none of them duplicates a named export of `layout.ts`.

  MOTION (C7.6). `is-breathing` on the membrane wrap, only while the agent's
  own status is `running`. A parked cell has no status, so it never animates —
  which is not an omission but the point: nothing is happening in it that we
  can see.
-->
<script lang="ts">
  import type { AgentNode, ParkedGraft } from '../src/model/events.js';
  import { isAgentNode } from '../src/model/events.js';
  import type { CellPlacement } from './canvas-contract.js';
  import {
    ANIMATED_CLASSES,
    HOLLOW_LIVE_CLASS,
    PARKED_CLASS,
    TESTID,
  } from './canvas-contract.js';
  import { blobPath, hashSessionId, LABEL_MAX_CHARS, roundCoord } from './layout.js';
  import { formatTokens } from './format.js';

  let {
    agent,
    parked,
    placement,
    nucleus = false,
    elided = 0,
    selected = false,
    degraded = false,
    onselect,
  }: {
    /** The in-tree agent. Mutually exclusive with {@link parked}. */
    agent?: AgentNode | undefined;
    /**
     * The parked graft this cell stands for, straight off `SessionState.parked`.
     * Mutually exclusive with {@link agent} — a parked agent has no node.
     */
    parked?: ParkedGraft | undefined;
    /** Where `sessionLayout()` put it. Never recomputed here. */
    placement: CellPlacement;
    /** This is the main agent: the nucleus at centre (C7.1). */
    nucleus?: boolean;
    /**
     * Tool dots this agent's arc dropped to `DOT_CAP`, rendered as `+n`.
     * `sessionLayout().elided` never writes 0, so `+0` cannot appear; 0 here
     * is this component's "the map had no entry", and draws no badge.
     */
    elided?: number;
    /** This cell is the store's selected node. */
    selected?: boolean;
    /** Hooks are silent, so a running agent's liveness was inferred (G2). */
    degraded?: boolean;
    /** The user picked this cell. Wired to `Store.selectNode` (C7.8). */
    onselect?: ((nodeId: string) => void) | undefined;
  } = $props();

  /** The live membrane's animation class, from the contract, never typed out. */
  const BREATHING = ANIMATED_CLASSES[0];

  /** Baseline of the cell's name, relative to its centre. Mockup: `c.y + 4`. */
  const LABEL_DY = 2;
  /** Baseline of the nucleus's sub-line. Mockup: `c.y + 22`. */
  const NUCLEUS_SUB_DY = 24;
  /** Baseline of a nested cell's sub-line. Mockup: `c.y + c.R + 16`. */
  const SUB_DY = 18;
  /** The stats line sits under the token counts. */
  const STATS_DY = 32;
  /** Stand-off of the `+n` badge above the membrane. */
  const BADGE_DY = 10;
  /** Length of the parked graft's dangling stub. Mockup: `58`. */
  const STUB_LENGTH = 58;
  /** Where the stub points when the cell sits exactly on the nucleus. */
  const STUB_FALLBACK: readonly [number, number] = [0, 1];

  /** The label a parked cell wears. Normative wording, C7.4. */
  const AWAITING = 'awaiting attribution';

  /**
   * The stub: from the parked cell's membrane, back toward the nucleus at the
   * origin, stopping in mid-air.
   */
  function stubPath(p: CellPlacement): string {
    const len = Math.hypot(p.x, p.y);
    const ux = len === 0 ? STUB_FALLBACK[0] : -p.x / len;
    const uy = len === 0 ? STUB_FALLBACK[1] : -p.y / len;
    const sx = p.x + ux * p.R;
    const sy = p.y + uy * p.R;
    return (
      `M ${roundCoord(sx)} ${roundCoord(sy)}` +
      ` l ${roundCoord(ux * STUB_LENGTH)} ${roundCoord(uy * STUB_LENGTH)}`
    );
  }

  let isParked = $derived(agent === undefined && parked !== undefined);
  let nodeId = $derived(agent?.id ?? parked?.agentId ?? '');
  /* A parked agent has NO status: the grafter refused to place it, and a
     status invented for it would be a value nobody measured. */
  let status = $derived(agent?.status);
  let running = $derived(status === 'running');
  /**
   * Cut a label to what the layout reserved room for.
   *
   * `LABEL_MAX_CHARS` is the SAME constant `layout.ts` derives `LABEL_PAD`
   * from, so the space kept clear and the text drawn into it cannot disagree —
   * the two-agreeing-literals defect, on a surface where the symptom is
   * unreadable overlapping text rather than a crash.
   *
   * The full name is on the cell's `aria-label` and in the inspector, so
   * nothing is lost, only shortened.
   */
  function fit(text: string): string {
    return text.length <= LABEL_MAX_CHARS ? text : `${text.slice(0, LABEL_MAX_CHARS - 1)}…`;
  }

  let fullName = $derived(
    agent === undefined
      ? nodeId
      : agent.label !== ''
        ? agent.label
        : nucleus
          ? agent.kind
          : agent.id,
  );
  let name = $derived(fit(fullName));
  let subline = $derived(
    agent === undefined
      ? AWAITING
      : // CONTEXT, not spend. `contextNow.prompt` is the last assistant
        // message's whole prompt - input plus both cache components - which is
        // the number that answers "how full is this agent's window". The old
        // line read `tokens.in`, i.e. `input_tokens` alone, which is ~2 on
        // every real message in the anchor corpora; see `events.ts`'s
        // TokenPair. OPTIONAL-CHAINED: an engine that reports no context level
        // leaves the field unset and `formatTokens(undefined)` is an em-dash,
        // which is the honest render. `.svelte` is outside `tsc`, so a missing
        // `?.` here would be a runtime throw that no checker catches.
        `${formatTokens(agent.contextNow?.prompt)} in ctx · ${formatTokens(agent.contextNow?.output)} out`,
  );

  /**
   * What this agent DID, counted.
   *
   * This line is why the tool dots could go. The dots showed that N things
   * happened and roughly how they ended, at a size nobody could read at R2
   * scale; the count says the same thing in words, and the inspector says
   * WHICH. Nothing left the data — only the arcs left the picture.
   *
   * Errors are named only when there are some. A "0 errors" on every healthy
   * cell is noise, and the absence of the word is the signal.
   */
  let stats = $derived.by(() => {
    if (agent === undefined) return '';
    const tools = agent.children.filter((child) => !isAgentNode(child));
    if (tools.length === 0) return 'no actions yet';
    const errors = tools.filter((t) => !isAgentNode(t) && t.status === 'error').length;
    const running = tools.filter((t) => !isAgentNode(t) && t.status === 'running').length;
    const parts = [`${tools.length} action${tools.length === 1 ? '' : 's'}`];
    if (running > 0) parts.push(`${running} running`);
    if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
    return parts.join(' · ');
  });
  let d = $derived(blobPath(placement.x, placement.y, placement.R, hashSessionId(nodeId)));

  let membraneClass = $derived(
    [
      'membrane',
      isParked ? PARKED_CLASS : '',
      running && degraded ? HOLLOW_LIVE_CLASS : '',
    ]
      .filter((c) => c !== '')
      .join(' '),
  );
  let groupClass = $derived(isParked ? `cell ${PARKED_CLASS}` : 'cell');
  let label = $derived(
    isParked
      ? `${nodeId} — ${AWAITING}${parked === undefined ? '' : ` (${parked.code})`}`
      : `${name} — ${status ?? ''}`,
  );

  function select(): void {
    onselect?.(nodeId);
  }

  function onKeyDown(event: KeyboardEvent): void {
    // A real focusable control answers Enter and Space (C7.8). Space is
    // prevented so the panel does not scroll under the activation.
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    select();
  }
</script>

{#if isParked}
  <!-- C7.4: unattached, dash-membraned, stubbed. Focusable so the keyboard can
       reach it and a screen reader can read WHY it is here, but not a `button`
       and not wired to selection: there is no node to inspect, and
       `Store.selectNode` would refuse an id that is in no tree. Refuse, do not
       guess — including about what a click on it could mean.

       The suppressed warning is `a11y_no_noninteractive_tabindex`, and it is
       suppressed rather than answered because the two rules genuinely conflict
       here: C7.8 requires cells to be reachable by keyboard, and this one has
       nothing to activate. The alternative — a `role="button"` that does
       nothing when pressed — is the worse half of the trade. Suppressed
       narrowly, on this element, with the reason attached; a blanket ignore
       would also hide the warning on the interactive branch below, where it
       would be a real defect. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <g
    class={groupClass}
    data-testid={TESTID.cell}
    data-agent-id={nodeId}
    data-parked="true"
    data-park-code={parked?.code ?? ''}
    data-selected="false"
    role="img"
    tabindex="0"
    aria-label={label}
  >
    <path class={membraneClass} {d} />
    <path class="stub" data-testid={TESTID.parkedStub} d={stubPath(placement)} />
    <text
      class="sub"
      x={placement.x}
      y={roundCoord(placement.y + placement.R + SUB_DY)}>{AWAITING}</text
    >
  </g>
{:else if agent !== undefined}
  <g
    class={groupClass}
    data-testid={nucleus ? TESTID.nucleus : TESTID.cell}
    data-agent-id={nodeId}
    data-status={status}
    data-parked="false"
    data-selected={String(selected)}
    data-liveness-inferred={String(running && degraded)}
    role="button"
    tabindex="0"
    aria-label={label}
    aria-current={selected}
    onclick={select}
    onkeydown={onKeyDown}
  >
    <g class={running ? `wrap ${BREATHING}` : 'wrap'}>
      <path class={membraneClass} {d} />
    </g>
    <text class="lbl" x={placement.x} y={roundCoord(placement.y + LABEL_DY)}>{name}</text>
    <text class="stats" x={placement.x} y={roundCoord(placement.y + STATS_DY)}>{stats}</text>
    <text
      class="sub"
      x={placement.x}
      y={roundCoord(
        nucleus ? placement.y + NUCLEUS_SUB_DY : placement.y + placement.R + SUB_DY,
      )}>{subline}</text
    >
    {#if elided > 0}
      <!-- C7.5: the last DOT_CAP dots are drawn and the remainder collapses to
           a count. `sessionLayout().elided` never stores 0, so this badge
           cannot read "+0". -->
      <text
        class="badge"
        data-testid={TESTID.elidedBadge}
        data-count={String(elided)}
        x={placement.x}
        y={roundCoord(placement.y - placement.R - BADGE_DY)}>+{elided}</text
      >
    {/if}
  </g>
{/if}

<style>
  .cell {
    cursor: pointer;
  }

  /* C7.8: a real focusable element with a VISIBLE focus ring. Outline plus a
     membrane weight change, because outline support on SVG containers is
     uneven — the stroke is the half that always shows. */
  .cell:focus-visible {
    outline: 2px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 2px;
  }

  .cell:focus-visible .membrane,
  .cell:hover .membrane {
    stroke-width: 2.4;
  }

  .membrane {
    fill: var(--vscode-editor-background);
    stroke: var(--vscode-descriptionForeground, currentColor);
    stroke-width: 1.6;
  }

  /* Agent status IS the membrane colour (C7.3). One rule per row. */
  .cell[data-status='running'] .membrane {
    stroke: var(--vscode-charts-green, currentColor);
  }

  .cell[data-status='done'] .membrane {
    stroke: var(--vscode-descriptionForeground, currentColor);
    opacity: 0.75;
  }

  .cell[data-status='error'] .membrane {
    stroke: var(--vscode-errorForeground, currentColor);
  }

  .cell[data-selected='true'] .membrane {
    stroke: var(--vscode-focusBorder, currentColor);
  }

  /* G2, degraded: a running agent's liveness was INFERRED from the JSONL tap,
     so the membrane goes hollow rather than showing the confident fill a hook
     event earns. After the status rules, which it must beat. */
  .cell :global(.is-hollow-live) {
    fill: none;
    stroke-dasharray: 6 4;
  }

  /* C7.4: the parked graft. Dashed and error-coloured, like the refused
     membrane at deck level, because it is the same statement — we will not
     guess where this belongs. */
  .cell :global(.is-parked) {
    stroke: var(--vscode-errorForeground, currentColor);
    stroke-dasharray: 7 5;
    fill: none;
  }

  .stub {
    fill: none;
    stroke: var(--vscode-errorForeground, currentColor);
    stroke-width: 1.2;
    stroke-dasharray: 4 6;
    opacity: 0.7;
  }

  /* Titles sit ON the membrane, so they need to survive whatever colour is
     under them. `paint-order: stroke fill` draws a halo in the editor's own
     background first and the glyph over it — legible on a green live cell, a
     grey ended one and a red thorn alike, without a plate behind the text
     that would cover the shape the cell is trying to show. */
  .lbl {
    fill: var(--vscode-foreground);
    font-size: 15px;
    font-weight: 600;
    text-anchor: middle;
    paint-order: stroke fill;
    stroke: var(--vscode-editor-background);
    stroke-width: 3.5;
    stroke-linejoin: round;
  }

  .stats {
    fill: var(--vscode-foreground);
    font-size: 11px;
    text-anchor: middle;
    opacity: 0.8;
    paint-order: stroke fill;
    stroke: var(--vscode-editor-background);
    stroke-width: 3;
    stroke-linejoin: round;
  }

  .sub {
    fill: var(--vscode-foreground);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    text-anchor: middle;
    opacity: 0.9;
    paint-order: stroke fill;
    stroke: var(--vscode-editor-background);
    stroke-width: 3;
    stroke-linejoin: round;
  }

  .badge {
    fill: var(--vscode-descriptionForeground, currentColor);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    text-anchor: middle;
  }

  /* ── motion (C7.6) ────────────────────────────────────────────────────
     Transform only, on a `fill-box` origin, so no animation touches a
     coordinate a golden pins. The class is built from `ANIMATED_CLASSES`;
     this selector is its second spelling and `canvas.test.ts` checks it back
     against the constant and against the bundled stylesheet, because Svelte
     prunes a scoped rule it cannot prove is used. */
  .cell :global(.is-breathing) {
    transform-box: fill-box;
    transform-origin: center;
    animation: breathe 4.6s ease-in-out infinite;
  }

  @keyframes breathe {
    50% {
      transform: scale(1.022);
    }
  }

  /* Swapped BY CLASS, not by media query alone: a media query does not
     evaluate in jsdom. The membrane keeps saying `running`; it stops moving. */
  :global(.reduced-motion) .cell :global(.is-breathing) {
    animation: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .cell :global(.is-breathing) {
      animation: none;
    }
  }
</style>
