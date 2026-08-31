<!--
  One node of the tidy tree (altitude 1), and the parked graft that is not in
  it.

  TWO MODES, ONE COMPONENT, unchanged in intent from the canvas this replaces.
  An in-tree agent arrives as an `AgentNode`; a PARKED graft has no node in the
  tree at all — the grafter refused to attach it, so `SessionState.parked` is
  the only record it exists, and it carries no children, no tokens and no
  status to render. The two are passed as mutually exclusive props rather than
  inferred: a node that guessed which kind it was would be the guess G3
  forbids, on the surface built to show that refusal.

  THE BOX IS `w` x `NODE_H`, AND `w` IS NOT THIS FILE'S TO DERIVE. It arrives
  on `placement.w`, which `layout.ts:treeLayout` computed from CHARACTER COUNTS
  — `NODE_W_MIN` at the floor, and above it the longer of the two rows at their
  nominal advances. The wide thing on this canvas is the TEXT, not the box: the
  predecessor separated on a drawn radius and produced shapes with clear space
  between them and labels written straight through each other. Re-deriving a
  width here would put the drawn box and the reserved space back into
  disagreement.

  HEIGHT IS FIXED, AND THAT IS THE OTHER HALF OF THE SAME RULE. Token share is
  TEXT on row 2, never size. A node whose box grew with its spend would move
  its siblings every time a tool call finished, which is the incremental
  promise `treeLayout`'s header states and the exact defect that killed the
  radius-driven layout.

  ROW 2 IS `layout.ts:nodeSubText`, IMPORTED. It is `burn.prompt +
  burn.output`, compact, then the call count, then the running count when there
  is one — and the FROZEN WIDTHS ARE COMPUTED FROM ITS LENGTH. Restating the
  string here, even identically, would recreate the two-agreeing-literals
  defect on the one surface where the symptom is text overlapping text.

  MOTION (C7.6, DoD 7.5). `is-breathing`, on EXACTLY the nodes with an
  in-flight tool or a live cursor. `ended`, `idle` and `parked` never carry it.
  Under `prefers-reduced-motion` the pulse is SWAPPED for a static ring rather
  than removed: the node keeps saying "something is happening here", it stops
  moving. The ring element is rendered in both cases so the swap is a CSS
  change on one element rather than a difference in the DOM, which is what
  lets a test assert both halves.

  NO POINTER GEOMETRY OF ANY KIND. This node is not movable: `treeLayout` is a
  pure function of state and its output is the whole truth about where a node
  is. Pan and zoom are a transform on the wrapper group, applied by
  `SessionCanvas.svelte` through `viewport.ts`.
-->
<script lang="ts">
  import type { AgentNode, ParkedGraft } from '../src/model/events.js';
  import type { TreePlacement } from './layout.js';
  import {
    ANIMATED_CLASSES,
    HOLLOW_LIVE_CLASS,
    PARKED_CLASS,
    TESTID,
  } from './canvas-contract.js';
  import {
    NODE_H,
    labelIsClipped,
    labelLines,
    nodeLabelText,
    nodeSubText,
    roundCoord,
    toolChildren,
  } from './layout.js';

  let {
    agent,
    parked,
    placement,
    root = false,
    selected = false,
    degraded = false,
    reducedMotion = false,
    onselect,
    onfocus,
  }: {
    /** The in-tree agent. Mutually exclusive with {@link parked}. */
    agent?: AgentNode | undefined;
    /**
     * The parked graft this node stands for, straight off `SessionState.parked`.
     * Mutually exclusive with {@link agent} — a parked agent has no node.
     */
    parked?: ParkedGraft | undefined;
    /**
     * Where `treeLayout` put it, including the WIDTH it reserved. Never
     * recomputed here. The parked rail supplies the same shape by hand, which
     * is why the prop is the placement rather than the tree's own row.
     */
    placement: Pick<TreePlacement, 'x' | 'y' | 'w'> &
      Partial<Pick<TreePlacement, 'depth' | 'collapsed' | 'hiddenDescendants'>>;
    /** This node is the layout root — the session root, or the focus target. */
    root?: boolean;
    /** This node is the store's selected node. */
    selected?: boolean;
    /** Hooks are silent, so a running agent's liveness was inferred (G2). */
    degraded?: boolean;
    /** The user prefers reduced motion: the pulse becomes a static ring. */
    reducedMotion?: boolean;
    /** Single click: select. Wired to `Store.selectNode` (C7.8). */
    onselect?: ((nodeId: string) => void) | undefined;
    /** Double click, or the `+N` badge: re-root here (DoD 7.6). */
    onfocus?: ((nodeId: string) => void) | undefined;
  } = $props();

  /** The pulse class, from the contract rather than typed out. */
  const BREATHING = ANIMATED_CLASSES[0];

  /** Corner radius of the node box. */
  const RADIUS = 9;
  /** Row-1 baseline, relative to the box top. */
  const ROW1_Y = 21;
  /** Second LABEL line's baseline, when the label wrapped (A9.1). */
  const LABEL_ROW2_Y = 37;
  /** Sub-text baseline for a one-line label. */
  const ROW2_Y = 38;
  /** Sub-text baseline when the label took two lines: one 18-unit row lower. */
  const ROW2_Y_WRAPPED = 56;
  /** Inset of both rows from the box edge. */
  const PAD_X = 11;
  /** The `+N` collapse badge sits below the box. */
  const BADGE_DY = 13;
  /** Radius of the static ring the reduced-motion swap shows. */
  const RING_R = 4.5;
  /** The ring sits inside the top-right corner. */
  const RING_INSET = 13;

  /** The label a parked node wears. Normative wording, C7.4. */
  const AWAITING = 'awaiting attribution';
  /** How far the parked stub dangles to the left of the rail. */
  const STUB_LENGTH = 26;

  let isParked = $derived(agent === undefined && parked !== undefined);
  let nodeId = $derived(agent?.id ?? parked?.agentId ?? '');
  /* A parked agent has NO status: the grafter refused to place it, and a
     status invented for it would be a value nobody measured. */
  let status = $derived(agent?.status);

  /**
   * DoD 7.5, and the whole of it.
   *
   * `active` is "an in-flight tool OR a live cursor" and nothing else: a node
   * whose own status is `running` has the cursor, and a node holding a tool
   * call that has not returned has the tool. `done` and `error` are settled,
   * and a parked node has no status at all, so neither can reach this.
   */
  let hasRunningTool = $derived(
    agent === undefined
      ? false
      : toolChildren(agent).some((t) => t.status === 'running'),
  );
  let active = $derived(!isParked && (status === 'running' || hasRunningTool));
  let ended = $derived(!isParked && !active);

  /**
   * The FULL label — what hover shows, and what `labelLines` wraps.
   *
   * NOT `nodeLabelText`, which cuts at `LABEL_MAX_CHARS` with an ellipsis. A9.1
   * removed every ellipsis from every surface: the label wraps to two rows and
   * the whole string is one hover away.
   */
  let fullLabel = $derived(agent === undefined ? nodeId : agent.label);
  /** The rows actually drawn. One or two (A9.1). */
  let lines = $derived(labelLines(fullLabel, w));
  /** True when two rows still did not hold it — hover carries the rest. */
  let clipped = $derived(labelIsClipped(fullLabel, w));
  /** Row 1, and the name every aria/badge string uses. */
  let label = $derived(lines[0] ?? '');
  /** Box height follows the wrap: the placement is the one source (A9.2). */
  let boxH = $derived(placement.h ?? NODE_H);
  /** Sub-text drops a row when the label took two. */
  let subY = $derived(lines.length > 1 ? ROW2_Y_WRAPPED : ROW2_Y);
  /** Row 2. IMPORTED, never restated: the widths were measured from it. */
  let sub = $derived(agent === undefined ? parked?.code ?? '' : nodeSubText(agent));

  /**
   * The depth marker on row 1's right.
   *
   * `root` for the layout root, `d1`, `d2`, ... below it. It is the RENDERED
   * depth from `treeLayout`, not `AgentNode.spawnDepth`: after a re-root the
   * two disagree, and the marker is telling the user where they are in the
   * picture in front of them.
   */
  let depthMark = $derived(
    isParked ? 'parked' : root ? 'root' : `d${String(placement.depth ?? 0)}`,
  );

  let hidden = $derived(placement.hiddenDescendants ?? 0);
  let collapsed = $derived((placement.collapsed ?? false) && hidden > 0);

  let boxClass = $derived(
    ['box', isParked ? PARKED_CLASS : '', active && degraded ? HOLLOW_LIVE_CLASS : '']
      .filter((c) => c !== '')
      .join(' '),
  );
  let groupClass = $derived(
    ['node', isParked ? PARKED_CLASS : '', root ? 'is-root' : '']
      .filter((c) => c !== '')
      .join(' '),
  );

  let ariaLabel = $derived(
    isParked
      ? `${nodeId} — ${AWAITING}${parked === undefined ? '' : ` (${parked.code})`}`
      : `${label} — ${status ?? ''}`,
  );

  function select(): void {
    onselect?.(nodeId);
  }

  function focusHere(): void {
    onfocus?.(nodeId);
  }

  function onKeyDown(event: KeyboardEvent): void {
    // A real focusable control answers Enter and Space (C7.8). Space is
    // prevented so the panel does not scroll under the activation.
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    select();
  }

  let x = $derived(roundCoord(placement.x));
  let y = $derived(roundCoord(placement.y));
  let w = $derived(roundCoord(placement.w));
</script>

{#if isParked}
  <!-- C7.4: unattached, dash-bordered, stubbed, with the STABLE CODE ON THE
       FACE of it. Focusable so the keyboard can reach it and a screen reader
       can read WHY it is here, but not a `button` and not wired to selection:
       there is no node to inspect, and `Store.selectNode` would refuse an id
       that is in no tree. Refuse, do not guess — including about what a click
       on it could mean.

       The suppressed warning is `a11y_no_noninteractive_tabindex`. The two
       rules genuinely conflict here: C7.8 requires nodes to be reachable by
       keyboard, and this one has nothing to activate. Suppressed narrowly, on
       this element, with the reason attached. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <g
    class={groupClass}
    data-testid={TESTID.cell}
    data-agent-id={nodeId}
    data-parked="true"
    data-park-code={parked?.code ?? ''}
    data-selected="false"
    data-active="false"
    role="img"
    tabindex="0"
    aria-label={ariaLabel}
  >
    <path
      class="stub"
      data-testid={TESTID.parkedStub}
      d={`M ${roundCoord(x - STUB_LENGTH)} ${roundCoord(y + boxH / 2)} l ${STUB_LENGTH} 0`}
    />
    <rect class={boxClass} {x} {y} width={w} height={boxH} rx={RADIUS} />
    <title>{fullLabel}</title>
    <text class="lbl" x={roundCoord(x + PAD_X)} y={roundCoord(y + ROW1_Y)}>{label}</text>
    {#if lines.length > 1}
      <text class="lbl" x={roundCoord(x + PAD_X)} y={roundCoord(y + LABEL_ROW2_Y)}
        >{lines[1]}</text
      >
    {/if}
    <text class="mark" x={roundCoord(x + w - PAD_X)} y={roundCoord(y + ROW1_Y)}
      >{depthMark}</text
    >
    <text class="sub" x={roundCoord(x + PAD_X)} y={roundCoord(y + subY)}
      >{AWAITING} · {sub}</text
    >
  </g>
{:else if agent !== undefined}
  <g
    class={groupClass}
    data-testid={root ? TESTID.nucleus : TESTID.cell}
    data-agent-id={nodeId}
    data-status={status}
    data-parked="false"
    data-selected={String(selected)}
    data-active={String(active)}
    data-depth={String(placement.depth ?? 0)}
    data-liveness-inferred={String(active && degraded)}
    data-collapsed={String(collapsed)}
    data-label-lines={String(lines.length)}
    data-label-clipped={String(clipped)}
    role="button"
    tabindex="0"
    aria-label={ariaLabel}
    aria-current={selected}
    onclick={select}
    ondblclick={focusHere}
    onkeydown={onKeyDown}
  >
    <rect class={boxClass} {x} {y} width={w} height={boxH} rx={RADIUS} />
    <!-- A9.1: the WHOLE label, on hover, always. The two rows below may not
         hold it, and there is no ellipsis to say so — `data-label-clipped` is
         how a test asserts the hover is carrying something the box is not. -->
    <title>{fullLabel}</title>
    <text class="lbl" x={roundCoord(x + PAD_X)} y={roundCoord(y + ROW1_Y)}>{label}</text>
    {#if lines.length > 1}
      <text class="lbl" x={roundCoord(x + PAD_X)} y={roundCoord(y + LABEL_ROW2_Y)}
        >{lines[1]}</text
      >
    {/if}
    <text class="mark" x={roundCoord(x + w - PAD_X)} y={roundCoord(y + ROW1_Y)}
      >{depthMark}</text
    >
    <text class="sub" x={roundCoord(x + PAD_X)} y={roundCoord(y + subY)}>{sub}</text>
    {#if active}
      <!-- The motion channel. The class is on the RING, so the reduced-motion
           swap is one CSS rule on one element: it stops animating and stays
           drawn, which is the "static ring" half of DoD 7.5. -->
      <circle
        class={reducedMotion ? 'ring' : `ring ${BREATHING}`}
        data-testid="tree-pulse"
        data-static={String(reducedMotion)}
        cx={roundCoord(x + w - RING_INSET)}
        cy={roundCoord(y + boxH - RING_INSET)}
        r={RING_R}
      />
    {/if}
    {#if collapsed}
      <!-- Collapse badge. Clicking it RE-ROOTS on this node (DoD 7.6): the
           descendants are not drawn here, and the honest way to show them is
           to make this node the root rather than to grow the box. -->
      <text
        class="badge"
        data-testid={TESTID.elidedBadge}
        data-count={String(hidden)}
        role="button"
        tabindex="0"
        aria-label={`Focus ${label}: ${String(hidden)} hidden`}
        x={roundCoord(x + w / 2)}
        y={roundCoord(y + boxH + BADGE_DY)}
        onclick={(event) => {
          event.stopPropagation();
          focusHere();
        }}
        onkeydown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          focusHere();
        }}>+{hidden} ▾</text
      >
    {/if}
  </g>
{/if}

<style>
  .node {
    cursor: pointer;
  }

  /* C7.8: a real focusable element with a VISIBLE focus ring. Outline plus a
     border weight change, because outline support on SVG containers is
     uneven — the stroke is the half that always shows. */
  .node:focus-visible {
    outline: 2px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 2px;
  }

  .node:focus-visible .box,
  .node:hover .box {
    stroke-width: 2;
  }

  .box {
    fill: var(--vscode-editor-background);
    stroke: var(--vscode-panel-border, currentColor);
    stroke-width: 1;
  }

  /* The four node states, one rule each. `active` is amber and heavier;
     `ended` is dimmed whole; `selected` is the heaviest; `root` carries a
     line of its own so the focus target is legible without a chip. */
  .node[data-active='true'] .box {
    stroke: var(--vscode-charts-yellow, currentColor);
    stroke-width: 1.5;
  }

  /* `ended` is 55% opacity. Scoped away from the parked branch: a parked node
     is not "finished", it is unplaced, and dimming it would say the wrong
     thing about the one state that exists to be noticed. */
  .node[data-active='false'][data-parked='false'] {
    opacity: 0.55;
  }

  .node.is-root .box {
    stroke-width: 1.5;
  }

  .node[data-selected='true'] .box {
    stroke: var(--vscode-charts-yellow, currentColor);
    stroke-width: 2;
  }

  /* G2, degraded: an active node's liveness was INFERRED from the JSONL tap,
     so the box goes hollow rather than showing the confident fill a hook
     event earns. After the status rules, which it must beat. */
  .node :global(.is-hollow-live) {
    fill: none;
    stroke-dasharray: 6 4;
  }

  /* C7.4: the parked graft. Dashed and warn-coloured, because it is the same
     statement the refused session makes — we will not guess where this
     belongs. */
  .node :global(.is-parked) {
    stroke: var(--vscode-editorWarning-foreground, currentColor);
    stroke-dasharray: 7 5;
    fill: none;
  }

  .stub {
    fill: none;
    stroke: var(--vscode-editorWarning-foreground, currentColor);
    stroke-width: 1.2;
    stroke-dasharray: 4 6;
    opacity: 0.7;
  }

  .lbl {
    fill: var(--vscode-foreground);
    font-size: 12px;
    font-weight: 600;
  }

  .mark {
    fill: var(--vscode-descriptionForeground, currentColor);
    font-size: 9.5px;
    text-anchor: end;
    letter-spacing: 0.04em;
  }

  .sub {
    fill: var(--vscode-descriptionForeground, currentColor);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
  }

  .badge {
    fill: var(--vscode-charts-yellow, currentColor);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    text-anchor: middle;
    cursor: pointer;
  }

  .ring {
    fill: none;
    stroke: var(--vscode-charts-yellow, currentColor);
    stroke-width: 1.2;
  }

  /* ── motion (C7.6, DoD 7.5) ───────────────────────────────────────────
     Transform and opacity on a `fill-box` origin, so no animation touches a
     coordinate `treeLayout` produced. The class is built from
     `ANIMATED_CLASSES`; this selector is its second spelling and
     `canvas.test.ts` checks the literal back against the constant AND against
     the bundled stylesheet, because Svelte prunes a scoped rule it cannot
     prove is used. */
  .node :global(.is-breathing) {
    transform-box: fill-box;
    transform-origin: center;
    animation: breathe 1.9s ease-in-out infinite;
  }

  @keyframes breathe {
    50% {
      transform: scale(1.6);
      opacity: 0.5;
    }
  }

  /* Swapped BY CLASS, not by media query alone: a media query does not
     evaluate in jsdom. The ring stays drawn; it stops moving. */
  :global(.reduced-motion) .node :global(.is-breathing) {
    animation: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .node :global(.is-breathing) {
      animation: none;
    }
  }
</style>
