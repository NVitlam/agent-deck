<!--
  Tokens — spec §G view 3. Per agent: prompt, output, cache ratio where
  available, context fill where available (em dash otherwise); context-churn
  spikes and compaction markers on a per-turn strip; cost with its source
  label; the model ids seen, copyable, for `agentDeck.pricing`; the stalls.
  Draws `layout.ts:tokensLayout` and derives nothing.

  Component 12 rendering (the Phase 1 ruling): a telemetry cost appears here
  only when the record's source is `telemetry`, labelled "estimated by Claude
  Code"; nothing else from telemetry is rendered in this release.

  v0.8.0 Phase 7 adds F14 (DoD 7.3) — the six timing figures, each an em dash
  where the session states no instant — and F15 (DoD 7.4) — the count beside
  the silent count, and a chip on the agent row it names.
-->
<script lang="ts">
  import { EM_DASH, formatTokens, stalledForLabel } from '../format.js';
  import { TESTID } from '../canvas-contract.js';
  import type { TokensLayout } from './layout.js';
  import { VOCABULARY } from './layout.js';
  import {
    copyText,
    formatRate,
    formatRatio,
    formatSpan,
    formatUsd,
    sessionPrimary,
    shortId,
  } from './text.js';

  let {
    tokens,
    liveLabels,
  }: {
    tokens: TokensLayout;
    liveLabels: ReadonlyMap<string, string>;
  } = $props();

  /**
   * F14's six figures, in one table — v0.8.0 DoD 7.3.
   *
   * DECLARED AS A LIST rather than written out six times in the markup, so the
   * absence rule is applied once: every figure goes through one formatter, and
   * a figure the session does not state renders as that formatter's em dash.
   * Six rows written by hand would be six places for a `?? 0` to appear.
   *
   * `figure` is the schema's own member name and reaches the DOM as
   * `data-figure`, so a golden names the field rather than the caption.
   */
  const TIMING_FIGURES: readonly {
    figure: keyof TokensLayout['sessions'][number]['timing'];
    label: string;
    format: (value: number | undefined) => string;
  }[] = [
    { figure: 'wallMs', label: 'wall time', format: formatSpan },
    { figure: 'timeToFirstToolMs', label: 'time to first tool', format: formatSpan },
    { figure: 'longestGapMs', label: 'longest gap', format: formatSpan },
    { figure: 'tokensPerMin', label: 'tokens per minute', format: formatRate },
    { figure: 'callsPerMin', label: 'calls per minute', format: formatRate },
    { figure: 'costPerHourUsd', label: 'cost per hour', format: formatUsd },
  ];

  /** The id last copied, for a moment of feedback on the button. */
  let copied = $state<string | undefined>(undefined);

  function copy(id: string): void {
    copied = copyText(id) ? id : undefined;
  }
</script>

{#if tokens.sessions.length === 0}
  <p class="empty" data-testid={TESTID.statsEmpty} data-view="tokens">No session with facts is shown.</p>
{:else}
  {#each tokens.sessions as session (session.session.sessionId)}
    <section
      class="session"
      data-testid={TESTID.statsSession}
      data-session={session.session.sessionId}
      data-engine={session.session.engine}
      aria-label="Session tokens"
    >
      <header class="head">
        <span class="primary" data-testid={TESTID.statsSessionPrimary}
          >{sessionPrimary(session.session, liveLabels)}</span
        >
        <span class="secondary" title={session.session.sessionId}
          >{shortId(session.session.sessionId)} · {session.session.projectSlug}</span
        >
        <span class="spacer"></span>
        <span class="figure">
          <span class="f-label">cost</span>
          <span class="f-value" data-testid={TESTID.statsCost} data-source={session.cost.source ?? 'none'}
            >{formatUsd(session.cost.usd)}</span
          >
          <span class="f-note" data-testid={TESTID.statsCostSource}>{session.cost.label}</span>
        </span>
        <span class="figure">
          <span class="f-label">context fill</span>
          <span class="f-value" data-testid={TESTID.statsContextFill}>{formatRatio(session.contextFill)}</span>
        </span>
        <span class="figure">
          <span class="f-label">prompt</span>
          <span class="f-value">{formatTokens(session.totals.prompt)}</span>
        </span>
        <span class="figure">
          <span class="f-label">output</span>
          <span class="f-value">{formatTokens(session.totals.output)}</span>
        </span>
        <span class="figure">
          <span class="f-label">{VOCABULARY.compaction}s</span>
          <span class="f-value">{session.compactions}</span>
        </span>
        <!--
          F15 SITS BESIDE F8's "silent" (DoD 7.4), on the same figure, because
          the two are one-status apart on the same population and a reader
          comparing them needs both counts in one place. The count is OPTIONAL
          where the silent count is required — it needs `SessionState.spawnEdges`
          — so an absent one is the em dash and never a 0, and `data-unreceived`
          carries `absent` so a golden can tell the two apart without reading
          the words.
        -->
        <span class="figure">
          <span class="f-label">subagents</span>
          <span
            class="f-value"
            data-testid={TESTID.statsSubagents}
            data-silent={String(session.silentSubagents)}
            data-unreceived={session.subagentsUnreceived === undefined
              ? 'absent'
              : String(session.subagentsUnreceived)}
            >{session.subagents} ({session.silentSubagents} silent, {session.subagentsUnreceived ??
              EM_DASH} with no spawning result)</span
          >
        </span>
      </header>

      <div class="row timing" aria-label="Timing">
        {#each TIMING_FIGURES as entry (entry.figure)}
          <span class="figure">
            <span class="f-label">{entry.label}</span>
            <span
              class="f-value"
              data-testid={TESTID.statsTiming}
              data-figure={entry.figure}
              data-stated={String(session.timing[entry.figure] !== undefined)}
              >{entry.format(session.timing[entry.figure])}</span
            >
          </span>
        {/each}
      </div>

      <table class="grid" aria-label="Agents">
        <thead>
          <tr>
            <th>agent</th>
            <th class="num">prompt</th>
            <th class="num">output</th>
            <th class="num">cache ratio</th>
            <th class="num">calls</th>
            <th>model</th>
          </tr>
        </thead>
        <tbody>
          {#each session.agents as agent (agent.agentId)}
            <tr
              data-testid={TESTID.statsAgentRow}
              data-agent={agent.agentId}
              data-kind={agent.kind}
              data-silent={String(agent.silent)}
              data-unreceived={String(agent.resultUnreceived)}
            >
              <td>
                <span class="primary" data-testid={TESTID.statsAgentPrimary}>{agent.primary}</span>
                <span class="secondary" title={agent.agentId}>{shortId(agent.agentId)}</span>
                {#if agent.silent}<span class="flag">{VOCABULARY.silentSubagent}</span>{/if}
                {#if agent.resultUnreceived}<span
                    class="flag"
                    data-testid={TESTID.statsUnreceivedFlag}
                    data-agent={agent.agentId}>{VOCABULARY.unreceivedResult}</span
                  >{/if}
              </td>
              <td class="num">{formatTokens(agent.prompt)}</td>
              <td class="num">{formatTokens(agent.output)}</td>
              <td class="num">{formatRatio(agent.cacheRatio)}</td>
              <td class="num">{agent.toolCalls}</td>
              <td class="mono">{agent.model ?? EM_DASH}</td>
            </tr>
          {/each}
        </tbody>
      </table>

      <div class="row">
        <span class="f-label">models seen</span>
        {#if session.models.length === 0}
          <span class="f-value">{EM_DASH}</span>
        {:else}
          {#each session.models as model (model)}
            <span class="model">
              <code data-testid={TESTID.statsModelId}>{model}</code>
              <button
                type="button"
                class="copy"
                data-testid={TESTID.statsModelCopy}
                data-model={model}
                data-copied={String(copied === model)}
                title="copy the model id for agentDeck.pricing"
                onclick={() => copy(model)}>{copied === model ? 'copied' : 'copy'}</button
              >
            </span>
          {/each}
        {/if}
      </div>

      <div class="row">
        <span class="f-label">turns</span>
        {#if session.strip.markers.length === 0}
          <span class="f-value">no {VOCABULARY.contextChurn} and no {VOCABULARY.compaction}</span>
        {:else}
          <svg
            class="strip"
            data-testid={TESTID.statsTurnStrip}
            data-markers={String(session.strip.markers.length)}
            width={session.strip.width}
            height={session.strip.height}
            viewBox={`0 0 ${String(session.strip.width)} ${String(session.strip.height)}`}
            role="img"
            aria-label="Per-turn markers"
          >
            <rect class="strip-bg" x="0" y="0" width={session.strip.width} height={session.strip.height} />
            {#each session.strip.markers as marker (`${marker.kind}:${marker.agentId}:${String(marker.ordinal)}`)}
              <rect
                data-testid={TESTID.statsTurnMarker}
                data-kind={marker.kind}
                data-agent={marker.agentId}
                data-ordinal={String(marker.ordinal)}
                class="marker marker-{marker.kind}"
                x={marker.x}
                y="0"
                width={session.strip.pitch}
                height={session.strip.height}
              >
                <title
                  >{marker.kind === 'spike'
                    ? `${VOCABULARY.contextChurn}: turn ${String(marker.ordinal)}, +${formatTokens(marker.delta)} cache-creation tokens`
                    : `${VOCABULARY.compaction}: call ${String(marker.ordinal)}, ${marker.trigger ?? ''}, ${formatTokens(marker.preTokens)} before, ${formatTokens(marker.postTokens)} after`}</title
                >
              </rect>
            {/each}
          </svg>
          <span class="legend"
            ><span class="swatch marker-spike"></span>{VOCABULARY.contextChurn}
            <span class="swatch marker-compaction"></span>{VOCABULARY.compaction}</span
          >
        {/if}
      </div>

      {#if session.stalls.length > 0}
        <ul class="stalls" aria-label="Stalls">
          {#each session.stalls as stall (stall.key)}
            <li data-testid={TESTID.statsStallRow} data-agent={stall.agentId} data-ordinal={String(stall.ordinal)}>
              <span class="term">{VOCABULARY.stall}</span>
              <span class="mono">{stall.toolName}</span>
              <span class="secondary">call #{stall.ordinal} · {shortId(stall.agentId)}</span>
              <span class="mono">{stalledForLabel(stall.stalledMs)} of silence</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/each}
{/if}

<style>
  .session {
    border-bottom: 1px solid var(--line);
    padding-bottom: 8px;
  }

  .head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 14px;
    padding: 8px 12px 4px;
  }

  .primary {
    font-weight: 600;
    font-size: 12.5px;
  }

  .secondary {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-3);
  }

  .spacer {
    flex: 1 1 auto;
  }

  .figure {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

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
    font-family: var(--mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
    white-space: nowrap;
  }

  .f-note {
    font-size: 10.5px;
    color: var(--ink-2);
    white-space: nowrap;
  }

  .grid {
    width: 100%;
    border-collapse: collapse;
    font-size: 11.5px;
  }

  th {
    text-align: left;
    font-family: var(--mono);
    font-weight: 600;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-3);
    padding: 4px 12px;
    border-bottom: 1px solid var(--line-soft);
  }

  td {
    padding: 3px 12px;
    border-bottom: 1px solid var(--line-soft);
    vertical-align: baseline;
  }

  .num {
    text-align: right;
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
  }

  .mono {
    font-family: var(--mono);
    font-size: 11px;
  }

  .flag,
  .term {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--ink-2);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 1px 7px;
    margin-left: 6px;
  }

  .row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 12px 0;
  }

  .timing {
    gap: 14px;
    align-items: baseline;
  }

  .model {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  code {
    font-family: var(--mono);
    font-size: 11px;
    background: var(--bg);
    border: 1px solid var(--line-soft);
    border-radius: 4px;
    padding: 1px 6px;
    user-select: text;
    -webkit-user-select: text;
  }

  .copy {
    font: inherit;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--ink-2);
    background: none;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 6px;
    cursor: pointer;
  }

  .copy:hover {
    color: var(--ink);
    background: var(--press);
  }

  .strip {
    display: block;
  }

  .strip-bg {
    fill: var(--bg);
    stroke: var(--line-soft);
  }

  .marker-spike {
    fill: var(--amber-text);
  }

  .marker-compaction {
    fill: var(--ink-3);
  }

  .legend {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--ink-3);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .swatch {
    display: inline-block;
    width: 8px;
    height: 8px;
  }

  .swatch.marker-spike {
    background: var(--amber-text);
  }

  .swatch.marker-compaction {
    background: var(--ink-3);
  }

  .stalls {
    list-style: none;
    margin: 6px 0 0;
    padding: 0 12px;
  }

  .stalls li {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 11.5px;
    padding: 2px 0;
  }

  .stalls .term {
    margin-left: 0;
    color: var(--amber-text);
    border-color: var(--amber-text);
  }

  .empty {
    margin: 0;
    padding: 12px;
    color: var(--ink-2);
  }
</style>
