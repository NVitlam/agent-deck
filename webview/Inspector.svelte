<!--
  Altitude 2 — the inspector, realized as the BOTTOM DRAWER (design.md §8.6,
  amendment A3). Spec C7.1.

  WHERE IT SITS IS THE POINT OF THIS FILE, so it is stated first. The drawer is
  a horizontal band along the bottom edge, occupying a grid row of its own in
  `App.svelte`. It is NOT a side panel, and it was one until 2026-08-28: an
  `<aside>` 22em wide with a `border-left`, carried unchanged from `0.1.x`
  through the whole Phase 7 rebuild. §8.6 and A3 had specified the drawer since
  the design froze; no Phase 7 DoD line named it, so no package owned it and no
  test asserted its placement — the geometry was simply never built. The
  placement assertions in `inspector.test.ts` exist so that cannot recur
  silently: a design that nothing measures is a design that drifts.

  WHAT THIS COMPONENT IS NOT. It is not a new home for redaction or truncation
  logic. `PayloadPreview.svelte` is IMPORTED, not copied: the 512-character
  collapse, the exact marker string and the full expand all still come from
  `format.ts:collapsePreview`, through the same component the list view renders.
  C7.1 calls this "rehoused, not redesigned", and importing is what makes that
  true by construction rather than by re-verification. A second copy of the
  cut-and-mark logic on a second surface is precisely the defect Phase 4
  carry-forward A spent itself on — a marker that under-reported by 7.73x
  because two layers cut the same string. §8.6's "pre blocks" are therefore
  PayloadPreview's own `pre`, styled from here, never a second renderer.

  WHAT THE STORE OWNS AND WHY. Selection and altitude are the store's (C7.7,
  C7.8), and so are the drawer's two heights and its open detail pane — because
  Escape walks all of them (§8.6: detail → drawer → out) and Escape is handled
  above this component. A height this file owned privately would be a step the
  Escape walk could not see. The FILTER row is local state, deliberately: it is
  neither selection nor altitude, nothing walks it, and §1.1's rule for the
  deck's own controls — reset on close, no persistence (G7) — is the right one
  for it too.

  TWO NUMBERS HERE ARE NOT FROM THE DESIGN, and they are marked at their
  declarations. §8.6 fixes five field min-widths, but amendment A6 replaced its
  single `tokens` field with `context` and `burn` and did not re-specify the
  widths. `burn` keeps the 158 the tokens field had — same "in / out" shape —
  and `context` was chosen at 104. The call-row sequence number is 1-based
  within the agent's own calls; §8.6 names the column and not its origin.
-->
<script lang="ts">
  import type { SpawnEdge, ToolNode, TreeNode } from '../src/model/events.js';
  import { isAgentNode } from '../src/model/events.js';
  import { TESTID } from './canvas-contract.js';
  import { formatDuration, formatTokens } from './format.js';
  import PayloadPreview from './PayloadPreview.svelte';

  let {
    node,
    expanded = false,
    ontoggle,
    onclose,
    sessionId,
    engine,
    breadcrumb = [],
    spawnEdges = [],
    drawerExpanded = false,
    ondrawertoggle,
    detailActionId,
    ondetail,
  }: {
    /** The node under inspection. `undefined` renders the empty state. */
    node?: TreeNode | undefined;
    /**
     * The FULL session id of the session this node belongs to.
     *
     * The header carries the full session id and the full agent id, never a
     * prefix: those are the two halves of every join key in this system, and a
     * shortened one cannot be pasted into a grep. The tree truncates a LABEL,
     * because a label is prose; an id is evidence.
     */
    sessionId?: string | undefined;
    /** Which engine produced this session. Rendered as a two-letter glyph. */
    engine?: 'cc' | 'opencode' | undefined;
    /**
     * The focus path, root first, exactly as the tree drew it.
     *
     * Rendered as TEXT, not as controls: the drawer says where a node sits,
     * and the clickable breadcrumb is the tree's own bar. Two navigations for
     * one path is two places for it to disagree.
     */
    breadcrumb?: readonly { id: string; label: string }[];
    /**
     * The session's spawn edges — the `tool_use` → agent primary key.
     *
     * Passed in rather than inferred, and that is the whole reason a call row
     * can say "→ child": the join is `meta.toolUseId`, proved by the grafter,
     * and a renderer that guessed which call spawned which agent (by tool name,
     * by adjacency, by order) would be inventing attribution on the one surface
     * a person reads to check it.
     */
    spawnEdges?: readonly SpawnEdge[];
    /** §8.6's two heights: collapsed max 190 px, expanded exactly 46vh. */
    drawerExpanded?: boolean;
    /** The user asked for the other height. */
    ondrawertoggle?: (() => void) | undefined;
    /** Which call row's detail pane is open. One at a time (§8.6). */
    detailActionId?: string | undefined;
    /** Open a row's detail pane, or pass `undefined` to shut it. */
    ondetail?: ((actionId: string | undefined) => void) | undefined;
    /**
     * Whether a TOOL node's payload previews are expanded. Tool payloads
     * default to COLLAPSED, exactly as they do in the tree — an 8 KB preview
     * open by default buries everything under it.
     */
    expanded?: boolean;
    /** The user asked to expand/collapse those payloads. */
    ontoggle?: (() => void) | undefined;
    /** The user asked to leave the drawer (Escape's altitude walk, C7.8). */
    onclose?: (() => void) | undefined;
  } = $props();

  let agent = $derived(node !== undefined && isAgentNode(node) ? node : undefined);
  let tool = $derived(node !== undefined && !isAgentNode(node) ? node : undefined);

  /**
   * What an agent DID, in the order it did it.
   *
   * An agent cell's tool children are the calls. This list is the answer to
   * "I clicked an agent, what did it do?" — which the inspector could not
   * answer at all before Phase 4.6: it described the agent and stopped, and
   * reaching a call meant finding its dot on the canvas and clicking that.
   */
  let calls = $derived(
    agent === undefined
      ? []
      : agent.children.filter((child): child is ToolNode => !isAgentNode(child)),
  );

  /**
   * `tool_use id` → the label of the agent that call spawned.
   *
   * Built from `spawnEdges` filtered to THIS node's own spawns, then resolved
   * against this node's agent children. Both halves matter: the edge proves
   * which call spawned the agent, and the child supplies the label the tree
   * already draws, so the drawer and the canvas name one agent one way.
   */
  let spawnLabels = $derived.by(() => {
    const out = new Map<string, string>();
    if (agent === undefined) return out;
    const children = new Map(
      agent.children.filter(isAgentNode).map((child) => [child.id, child.label]),
    );
    for (const edge of spawnEdges) {
      if (edge.parentNodeId !== agent.id) continue;
      const label = children.get(edge.agentId);
      if (label !== undefined) out.set(edge.toolUseId, label);
    }
    return out;
  });

  /* ----- the filter row (expanded state only, §8.6) ---------------------- */

  /**
   * Local state, not the store's. See the header: nothing walks it, and §1.1's
   * rule for the deck's controls — reset on close, no persistence (G7) — is
   * the right one here too.
   */
  type StatusFilter = 'all' | 'running' | 'done' | 'error';
  let statusFilter = $state<StatusFilter>('all');
  let toolFilter = $state<string>('all');

  /** The chips, with §8.6's labels. `Failed` is this model's `error`. */
  const STATUS_CHIPS: readonly { value: StatusFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'running', label: 'Running' },
    { value: 'done', label: 'Completed' },
    { value: 'error', label: 'Failed' },
  ];

  let statusCounts = $derived({
    all: calls.length,
    running: calls.filter((c) => c.status === 'running').length,
    done: calls.filter((c) => c.status === 'done').length,
    error: calls.filter((c) => c.status === 'error').length,
  });

  /** Every distinct tool name, in first-use order, for the select. */
  let toolNames = $derived([...new Set(calls.map((c) => c.toolName))]);

  /**
   * §8.6: "Collapsed mode always shows the unfiltered list."
   *
   * Enforced HERE rather than by resetting the filters when the drawer
   * collapses. Resetting would silently discard a choice the user made, and
   * they would find it gone on expanding again; ignoring it while the control
   * that sets it is off screen is the honest reading of the sentence, and the
   * filter comes back exactly as it was.
   */
  let visibleCalls = $derived(
    !drawerExpanded
      ? calls
      : calls.filter(
          (c) =>
            (statusFilter === 'all' || c.status === statusFilter) &&
            (toolFilter === 'all' || c.toolName === toolFilter),
        ),
  );

  /** 1-based within the agent's own calls — §8.6 names the column, not this. */
  let seqOf = $derived((call: ToolNode) => calls.indexOf(call) + 1);

  let detail = $derived(
    detailActionId === undefined ? undefined : calls.find((c) => c.id === detailActionId),
  );

  /* ----- the call-row summary ------------------------------------------- */

  /**
   * What a person actually wants to read on a call row.
   *
   * **The `description` field, when the payload carries one.** Most tools take
   * one and it is written BY the caller, in words, saying why the call is being
   * made — "List phase headings in PLAN.md" rather than the shell one-liner
   * that does it. Nothing else in the payload comes close: the command, the
   * path and the pattern are all the *how*.
   *
   * Never the `tool_use` id. The id is the graft key — it is how attribution is
   * proved and it is meaningless to a reader.
   *
   * Reads the ALREADY-REDACTED, ALREADY-TRUNCATED `inputPreview`, so nothing
   * here can widen what G4 decided may be shown — and truncation is exactly why
   * the JSON parse cannot be trusted: an 8 KB cut lands mid-object far more
   * often than not, which is what the regex path below is for.
   */
  const INTENT_KEYS = ['description', 'command', 'prompt', 'pattern', 'query', 'file_path', 'url'];

  /** `"description": "..."` out of a payload too truncated to parse. */
  function scrapeKey(raw: string, key: string): string | undefined {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const m = re.exec(raw);
    if (m?.[1] === undefined) return undefined;
    // Unescape the JSON string body by hand: `JSON.parse` on the whole payload
    // is what already failed, and wrapping the captured body in quotes to parse
    // it would throw again on a capture cut mid-escape.
    return m[1]
      .replace(/\\n/g, ' ')
      .replace(/\\t/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim();
  }

  function describe(target: ToolNode): string {
    const raw = target.inputPreview;

    // Whole-payload parse first: it is the only path that cannot be fooled by a
    // `"description"` appearing inside some other string value.
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        for (const key of INTENT_KEYS) {
          const value = record[key];
          if (typeof value === 'string' && value.trim() !== '') return value.trim();
        }
      }
    } catch {
      // Truncated, or not JSON at all. Fall through.
    }

    for (const key of INTENT_KEYS) {
      const scraped = scrapeKey(raw, key);
      if (scraped !== undefined && scraped !== '') return scraped;
    }

    const first = raw
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return first === undefined || first === '' ? target.toolName : first;
  }

  /** §8.6: status words are lowercase; `done` reads as "completed". */
  const STATUS_WORD = { running: 'running', done: 'completed', error: 'failed' } as const;

  // An agent carries `startedAt`/`endedAt`; a tool carries `durationMs`
  // already. Neither is invented when it is missing — `formatDuration` prints
  // an em-dash for "we do not have this number".
  let agentDuration = $derived(
    agent !== undefined && agent.endedAt !== undefined
      ? agent.endedAt - agent.startedAt
      : undefined,
  );

  let path = $derived(breadcrumb.map((c) => c.label).join(' / '));
</script>

<section
  class="drawer"
  data-testid={TESTID.inspector}
  data-empty={String(node === undefined)}
  data-node-id={node?.id ?? ''}
  data-expanded={String(drawerExpanded)}
  data-detail={detail?.id ?? ''}
  aria-label="Inspector"
>
  {#if node === undefined}
    <p class="empty" data-testid={TESTID.inspectorEmpty}>Select a cell or a dot to inspect it.</p>
  {:else}
    <!-- ONE ROW (§8.6): glyph · label · field group · spacer · path · expand ·
         close. The spacer is what pins the path and the controls right without
         any of the five preceding items having to know a width. -->
    <header class="head" data-testid={TESTID.drawerHead}>
      <!-- The engine glyph. `oc` is this UI's vocabulary for the OpenCode
           engine — `layout.ts:deckEngine` is the one supported conversion, and
           this surface renders the same two letters, so a user reading a node
           and a deck card sees one word for one engine. -->
      {#if engine !== undefined}
        <span class="engine" data-testid="inspector-engine" data-engine={engine}
          >{engine === 'opencode' ? 'oc' : 'cc'}</span
        >
      {/if}
      <span class="kind" data-testid="inspector-kind">{agent !== undefined ? agent.kind : 'tool'}</span
      >
      <span class="label" data-testid="inspector-title"
        >{agent !== undefined ? agent.label : tool?.toolName}</span
      >

      <!-- THE FIELD GROUP. Label over value, fixed min-widths, so a value
           changing length never shifts the field beside it. That is the whole
           reason §8.6 specifies widths at all: this row updates while a user
           is reading it. -->
      <div class="fields" role="group" aria-label="Node fields">
        <div class="field" data-testid={TESTID.drawerField} data-field="status">
          <span class="f-label">status</span>
          <span class="f-value" data-status={node.status} data-testid="inspector-status"
            >{STATUS_WORD[node.status]}</span
          >
        </div>
        <div class="field" data-testid={TESTID.drawerField} data-field="id">
          <span class="f-label">id</span>
          <span class="f-value mono" data-testid="inspector-id">{node.id}</span>
        </div>
        {#if sessionId !== undefined}
          <div class="field" data-testid={TESTID.drawerField} data-field="sessionId">
            <span class="f-label">session</span>
            <span class="f-value mono" data-testid="inspector-session-id">{sessionId}</span>
          </div>
        {/if}
        {#if agent !== undefined}
          <div class="field" data-testid={TESTID.drawerField} data-field="spawnDepth">
            <span class="f-label">spawn depth</span>
            <span class="f-value mono" data-testid="inspector-spawn-depth">{agent.spawnDepth}</span>
          </div>
          <!-- TWO FIELDS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS (A6).
               `contextNow` is the context LEVEL — the last assistant message's
               prompt, which is what fills a window — and `burn` is the running
               total across every distinct message. The shipped `0.1.2` summed
               `input_tokens`, which is ~2 per message in the anchor corpora, so
               it under-reported a 42,199-token prompt as 2. Both are
               optional-chained: an engine may report neither, and an em-dash is
               the honest render for a number we do not have.

               NO PERCENTAGE beside context, and there must not be: no
               transcript in either corpus states a context-window size, so a
               percentage would have to come from a model-name lookup table,
               which is memory rather than fixture (G6). -->
          <div class="field" data-testid={TESTID.drawerField} data-field="context">
            <span class="f-label">context</span>
            <span class="f-value mono" data-testid="inspector-tokens"
              >{formatTokens(agent.contextNow?.prompt)}</span
            >
          </div>
          <div class="field" data-testid={TESTID.drawerField} data-field="burn">
            <span class="f-label">burn</span>
            <span class="f-value mono" data-testid="inspector-burn"
              >{formatTokens(agent.burn?.prompt)} in / {formatTokens(agent.burn?.output)} out</span
            >
          </div>
          <div class="field" data-testid={TESTID.drawerField} data-field="duration">
            <span class="f-label">duration</span>
            <span class="f-value mono" data-testid="inspector-duration"
              >{formatDuration(agentDuration)}</span
            >
          </div>
        {:else if tool !== undefined}
          <div class="field" data-testid={TESTID.drawerField} data-field="duration">
            <span class="f-label">duration</span>
            <span class="f-value mono" data-testid="inspector-duration"
              >{formatDuration(tool.durationMs)}</span
            >
          </div>
        {/if}
      </div>

      <span class="spacer"></span>

      {#if path !== ''}
        <span class="path" data-testid="inspector-path" title={path}>{path}</span>
      {/if}

      <button
        class="head-button"
        type="button"
        data-testid={TESTID.drawerExpand}
        aria-expanded={drawerExpanded}
        onclick={() => ondrawertoggle?.()}>{drawerExpanded ? 'collapse ▾' : 'expand ▴'}</button
      >
      {#if onclose !== undefined}
        <button
          class="head-button"
          type="button"
          data-testid="inspector-close"
          onclick={() => onclose?.()}>close</button
        >
      {/if}
    </header>

    <!-- §8.6: "Filter row exists only in the expanded state." Not hidden with
         CSS — absent, so a collapsed drawer cannot be filtered by a control
         nobody can see. -->
    {#if drawerExpanded && agent !== undefined}
      <div class="filters" data-testid={TESTID.drawerFilters}>
        {#each STATUS_CHIPS as chip (chip.value)}
          <button
            type="button"
            class="chip"
            data-testid={TESTID.drawerFilterChip}
            data-filter={chip.value}
            data-active={String(statusFilter === chip.value)}
            aria-pressed={statusFilter === chip.value}
            onclick={() => (statusFilter = chip.value)}
            >{chip.label}<span class="chip-count">{statusCounts[chip.value]}</span></button
          >
        {/each}
        <span class="spacer"></span>
        <select
          class="tool-select"
          data-testid={TESTID.drawerToolSelect}
          aria-label="Filter by tool"
          bind:value={toolFilter}
        >
          <option value="all">All tools</option>
          {#each toolNames as name (name)}
            <option value={name}>{name}</option>
          {/each}
        </select>
      </div>
    {/if}

    <div class="body" data-testid={TESTID.drawerBody} data-split={String(detail !== undefined)}>
      {#if agent !== undefined}
        <ul class="calls" aria-label="Calls">
          {#if visibleCalls.length === 0}
            <li class="calls-empty">
              {calls.length === 0 ? 'No calls yet' : 'No calls match this filter'}
            </li>
          {/if}
          {#each visibleCalls as call (call.id)}
            {@const child = spawnLabels.get(call.id)}
            <li>
              <button
                type="button"
                class="call"
                data-testid={TESTID.actionRow}
                data-action-id={call.id}
                data-status={call.status}
                data-open={String(detail?.id === call.id)}
                data-spawn={String(child !== undefined)}
                aria-pressed={detail?.id === call.id}
                onclick={() => ondetail?.(detail?.id === call.id ? undefined : call.id)}
              >
                <span class="seq">{seqOf(call)}</span>
                <span class="dot" data-status={call.status} data-spawn={String(child !== undefined)}
                ></span>
                <span class="name">{call.toolName}</span>
                <span class="word">{STATUS_WORD[call.status]}</span>
                <span class="summary" data-testid={TESTID.actionSummary} title={describe(call)}
                  >{describe(call)}</span
                >
                {#if child !== undefined}
                  <span class="child">→ {child}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>

        {#if detail !== undefined}
          <!-- §8.6: opens on row click and SPLITS the body — the list fixes to
               340 px and this takes the rest. The list keeps its width so the
               row you clicked does not move out from under the pointer. -->
          <div class="detail" data-testid={TESTID.drawerDetail} data-action-id={detail.id}>
            <div class="d-head">
              <span class="d-seq">#{seqOf(detail)}</span>
              <span class="d-name">{detail.toolName}</span>
              <span class="d-word" data-status={detail.status}>{STATUS_WORD[detail.status]}</span>
              {#if spawnLabels.get(detail.id) !== undefined}
                <span class="child">→ {spawnLabels.get(detail.id)}</span>
              {/if}
              <span class="spacer"></span>
              <button
                class="head-button"
                type="button"
                data-testid="drawer-detail-close"
                onclick={() => ondetail?.(undefined)}>close</button
              >
            </div>
            <!-- IMPORTED, never reimplemented. See the header comment. -->
            <PayloadPreview label="input" text={detail.inputPreview} expanded={false} />
            {#if detail.resultPreview !== undefined}
              <PayloadPreview
                label={detail.status === 'error' ? 'error' : 'output'}
                text={detail.resultPreview}
                expanded={false}
              />
            {/if}
          </div>
        {/if}
      {/if}

      {#if tool !== undefined}
        <!-- A tool node has no calls of its own, so the drawer body IS the
             detail. Same components, no list beside it. -->
        <div class="detail solo" data-testid={TESTID.drawerDetail} data-action-id={tool.id}>
          <button
            class="head-button"
            type="button"
            data-testid="inspector-expand"
            aria-expanded={expanded}
            onclick={() => ontoggle?.()}>{expanded ? 'Collapse payloads' : 'Expand payloads'}</button
          >
          <PayloadPreview label="input" text={tool.inputPreview} {expanded} />
          {#if tool.resultPreview !== undefined}
            <PayloadPreview
              label={tool.status === 'error' ? 'error' : 'output'}
              text={tool.resultPreview}
              {expanded}
            />
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  /* §8's token ladder, scoped to this component.
     Phase 7 built the rest of the webview against raw `--vscode-*` variables
     and never lifted §8's names into CSS, so these are declared here rather
     than assumed to exist. Each maps to the product source §8's table names,
     with the design's own dark raw value as the fallback. Lifting them to a
     shared root is a separate change and would touch every component. */
  .drawer {
    --bg: var(--vscode-editor-background, #1b1d21);
    --panel: var(--vscode-sideBar-background, #202327);
    --line: var(--vscode-panel-border, #33373d);
    /* §8 derives `--line-soft` as `--line` 55% toward `--panel`, which no
       theme variable carries. The first declaration is the safe fallback; the
       second is the derivation and wins wherever `color-mix` is supported. */
    --line-soft: var(--vscode-panel-border, #2a2d32);
    --line-soft: color-mix(in srgb, var(--line) 45%, var(--panel));
    --ink: var(--vscode-foreground, #dcdee2);
    --ink-2: var(--vscode-descriptionForeground, #9aa0a8);
    --ink-3: var(--vscode-disabledForeground, #6b6f77);
    --press: var(--vscode-list-hoverBackground, #2e3238);
    /* Amber is the brand accent and is never themed (§8.2). The charts-yellow
       variable is what every other surface in this webview already uses for
       "happening now", so the drawer agrees with the canvas rather than
       introducing a second amber. */
    --amber-text: var(--vscode-charts-yellow, #f2a93b);
    --err: var(--vscode-editorError-foreground, #e07a6a);
    --focus: var(--vscode-focusBorder, #5b9dd9);
    --mono: var(--vscode-editor-font-family, ui-monospace, "Cascadia Code", Menlo, Consolas, monospace);

    /* THE DRAWER, and this block is the fix. A band along the bottom on
       `--panel` with a 1 px `--line` TOP border — not a side panel with a
       left border, which is what shipped until 2026-08-28. */
    display: flex;
    flex-direction: column;
    /* Its own band in `App.svelte`'s column: sized by its content up to the
       ceilings below, never stretched to fill and never squeezed by the field
       above it. */
    flex: 0 0 auto;
    min-height: 0;
    background: var(--panel);
    border-top: 1px solid var(--line);
    color: var(--ink);
    /* §8.6's two heights. `max-height` rather than `height` so a drawer with
       two calls in it is two calls tall; the numbers are ceilings, not sizes. */
    max-height: 190px;
    /* Payload text is meant to be copied — that is most of what the drawer is
       for. `.app` turns selection off globally to stop a pan from selecting
       labels. */
    user-select: text;
    -webkit-user-select: text;
  }

  .drawer[data-expanded='true'] {
    max-height: 46vh;
  }

  .empty {
    margin: 0;
    padding: 8px 12px;
    color: var(--ink-2);
  }

  /* ----- header, one row (§8.6) ----------------------------------------- */

  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
    padding: 5px 12px;
    border-bottom: 1px solid var(--line-soft);
  }

  .engine {
    font-family: var(--mono);
    font-weight: 700;
    font-size: 10px;
    letter-spacing: 0.08em;
    padding: 3px 6px;
    border: 1px solid var(--line);
    /* §8.2's non-color cue: CC has 3 px corners, OC is a full round pill. A
       reader who cannot separate the two hues still reads two shapes. */
    border-radius: 3px;
    color: var(--ink-2);
  }

  .engine[data-engine='opencode'] {
    border-radius: 999px;
  }

  .kind {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-3);
  }

  /* §8.1: sans 600 is reserved for text a human wrote or named. A node label
     is one of the four things that qualifies. */
  .label {
    font-weight: 600;
    font-size: 12.5px;
    letter-spacing: -0.005em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22ch;
  }

  .fields {
    display: flex;
    align-items: baseline;
    gap: 14px;
    min-width: 0;
    overflow: hidden;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  /* §8.6's fixed min-widths. They exist so a value changing length never
     shifts the field beside it — this row updates while a person reads it. */
  .field[data-field='status'] { min-width: 58px; }
  .field[data-field='id'] { min-width: 128px; }
  .field[data-field='sessionId'] { min-width: 128px; }
  .field[data-field='spawnDepth'] { min-width: 74px; }
  /* NOT FROM §8.6 — see the file header. A6 replaced its single `tokens` field
     with these two and did not re-specify widths; `burn` keeps the 158 the
     tokens field had, `context` was chosen at 104 for one grouped numeral. */
  .field[data-field='context'] { min-width: 104px; }
  .field[data-field='burn'] { min-width: 158px; }
  .field[data-field='duration'] { min-width: 64px; }

  /* Micro-caps (§8.1). */
  .f-label {
    font-family: var(--mono);
    font-weight: 600;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-3);
    white-space: nowrap;
  }

  .f-value {
    font-size: 11px;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .f-value.mono {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
  }

  /* §8.6: status value colored. Amber is "happening now" and nothing else
     (§8.2), so it lands on `running` alone; a finished node dims to `--ink-3`
     rather than taking a colour of its own. */
  .f-value[data-status='running'] {
    color: var(--amber-text);
  }

  .f-value[data-status='done'] {
    color: var(--ink-3);
  }

  .f-value[data-status='error'] {
    color: var(--err);
  }

  .spacer {
    flex: 1 1 auto;
    min-width: 0;
  }

  .path {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 30ch;
  }

  .head-button {
    font: inherit;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-2);
    background: none;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 2px 8px;
    cursor: pointer;
    white-space: nowrap;
  }

  /* §8.4: hover on quiet controls moves text to `--ink` and the background to
     `--press`. No scale, no shadow. */
  .head-button:hover {
    color: var(--ink);
    background: var(--press);
  }

  /* §8.2: the focus ring is never amber — focus must not read as "running". */
  .head-button:focus-visible,
  .chip:focus-visible,
  .call:focus-visible,
  .tool-select:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }

  /* ----- filter row (expanded only, §8.6) -------------------------------- */

  .filters {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    padding: 4px 12px;
    border-bottom: 1px solid var(--line-soft);
  }

  /* §8.5: 999 radius, count badge on `--line-soft`, active chip `--press`. */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-2);
    background: none;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 2px 9px;
    cursor: pointer;
  }

  .chip:hover {
    border-color: var(--ink-3);
    color: var(--ink);
  }

  .chip[data-active='true'] {
    background: var(--press);
    border-color: var(--ink-3);
    color: var(--ink);
  }

  .chip-count {
    font-weight: 600;
    font-size: 10px;
    min-width: 16px;
    text-align: center;
    border-radius: 999px;
    background: var(--line-soft);
  }

  .tool-select {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-2);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 2px 6px;
    max-width: 18ch;
  }

  /* ----- body: the call list, and the detail pane beside it -------------- */

  .body {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  .calls {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1 1 auto;
    min-width: 0;
    overflow: auto;
  }

  /* §8.6: with the detail pane open the list FIXES to 340 px and the pane
     takes the rest, so the row that was clicked does not move. */
  .body[data-split='true'] .calls {
    flex: 0 0 340px;
    border-right: 1px solid var(--line-soft);
  }

  .calls-empty {
    padding: 6px 12px;
    font-size: 11px;
    color: var(--ink-3);
  }

  /* §8.6's call row: seq (24, right-aligned) · 8 px dot · name (min 56) ·
     status word · [→ child]. The summary sits after the status word and takes
     the slack — it is the only part of the row that is prose. */
  .call {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-2);
    background: none;
    border: none;
    border-radius: 0;
    padding: 2.5px 12px;
    text-align: left;
    cursor: pointer;
  }

  .call:hover,
  .call[data-open='true'] {
    background: var(--press);
  }

  .seq {
    flex: 0 0 24px;
    text-align: right;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }

  .dot {
    flex: 0 0 8px;
    width: 8px;
    height: 8px;
    border-radius: 999px;
    /* §2.4's colours, mirrored: completed muted, running amber, error red. */
    background: var(--ink-3);
  }

  .dot[data-status='running'] {
    background: var(--amber-text);
  }

  .dot[data-status='error'] {
    background: var(--err);
  }

  /* §2.4: a dot that spawned a subagent is HOLLOW with an amber stroke, filled
     amber only while running. The same rule the canvas draws, so one call
     reads the same on both surfaces. */
  .dot[data-spawn='true'] {
    background: none;
    border: 1.5px solid var(--amber-text);
  }

  .dot[data-spawn='true'][data-status='running'] {
    background: var(--amber-text);
  }

  .name {
    flex: 0 0 auto;
    min-width: 56px;
    color: var(--ink);
  }

  .word {
    flex: 0 0 auto;
    font-size: 10.5px;
    letter-spacing: 0.02em;
    color: var(--ink-3);
  }

  .summary {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* §8.6: the child label is amber TEXT. A spawn is the one thing on this row
     that is structure rather than status. */
  .child {
    flex: 0 0 auto;
    color: var(--amber-text);
  }

  .detail {
    flex: 1 1 auto;
    min-width: 0;
    overflow: auto;
    padding: 6px 12px 10px;
  }

  .detail.solo {
    padding-top: 8px;
  }

  .d-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-2);
    padding-bottom: 4px;
  }

  .d-seq {
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }

  .d-name {
    color: var(--ink);
  }

  .d-word[data-status='running'] {
    color: var(--amber-text);
  }

  .d-word[data-status='error'] {
    color: var(--err);
  }

  /* PayloadPreview's own markup, styled from here to §8.6 rather than
     reimplemented: micro-caps heading over a `pre` block. The component keeps
     ownership of the 512-character collapse and the marker. */
  .detail :global(.preview-label) {
    font-family: var(--mono);
    font-weight: 600;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-3);
  }

  .detail :global(pre) {
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.5;
    background: var(--bg);
    border: 1px solid var(--line-soft);
    border-radius: 6px;
    padding: 8px 10px;
    margin: 3px 0 8px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
