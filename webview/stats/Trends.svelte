<!--
  Trends — spec §G view 4. From the store: prompt per session, loops per
  session, engine-reported cost per session where present, one point per
  session in order. Empty state when the store is disabled or holds fewer than
  two records. Draws `layout.ts:trendsLayout` and derives nothing.

  THE SCALE IS A TRANSFORM. A point's `x`/`y` are the layout's raw numbers;
  what fits them into the box is the SVG viewBox, computed from `max` — the
  rule `viewport.ts` states for the canvas, applied here so the incremental
  property (adding a record moves no existing point) is true of the DOM as
  well as of the layout.
-->
<script lang="ts">
  import { EM_DASH, formatTokens } from '../format.js';
  import { TESTID } from '../canvas-contract.js';
  import type { TrendsLayout, TrendSeries } from './layout.js';
  import { sessionPrimary } from './text.js';
  import { formatUsd } from './text.js';

  let {
    trends,
    liveLabels,
  }: {
    trends: TrendsLayout;
    liveLabels: ReadonlyMap<string, string>;
  } = $props();

  const HEIGHT = 72;

  /** `M x0 y0 L x1 y1 ...` over the raw points, y flipped inside the viewBox. */
  function pathOf(series: TrendSeries): string {
    const max = series.max > 0 ? series.max : 1;
    return series.points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${String(p.x)} ${String(max - p.y)}`)
      .join(' ');
  }

  function valueText(series: TrendSeries, y: number): string {
    return series.id === 'cost' ? formatUsd(y) : formatTokens(y);
  }
</script>

{#if trends.empty}
  <p class="empty" data-testid={TESTID.statsEmpty} data-view="trends" data-reason={trends.reason}>
    {#if trends.reason === 'disabled'}
      The local stats history is off (agentDeck.stats.enabled), so there is nothing to draw over time.
    {:else}
      Fewer than two sessions are recorded, so there is no line to draw yet.
    {/if}
  </p>
{:else}
  <div class="series-list">
    {#each trends.series as series (series.id)}
      <section
        class="series"
        data-testid={TESTID.statsTrendSeries}
        data-series={series.id}
        data-points={String(series.points.length)}
        aria-label={series.label}
      >
        <span class="label">{series.label}</span>
        {#if series.points.length === 0}
          <span class="none">{EM_DASH}</span>
        {:else}
          <svg
            class="chart"
            width="100%"
            height={HEIGHT}
            viewBox={`0 0 ${String(Math.max(trends.width, 1))} ${String(series.max > 0 ? series.max : 1)}`}
            preserveAspectRatio="none"
            role="img"
          >
            <path class="line" d={pathOf(series)} vector-effect="non-scaling-stroke" />
            {#each series.points as point (point.sessionId)}
              <circle
                data-testid={TESTID.statsTrendPoint}
                data-series={series.id}
                data-session={point.sessionId}
                data-index={String(point.index)}
                data-x={String(point.x)}
                data-y={String(point.y)}
                cx={point.x}
                cy={(series.max > 0 ? series.max : 1) - point.y}
                r="1"
                vector-effect="non-scaling-stroke"
              >
                <title>{sessionPrimary(trends.sessions[point.index] ?? { sessionId: point.sessionId, engine: 'cc', projectSlug: '', startedAt: 0 }, liveLabels)}: {valueText(series, point.y)}</title>
              </circle>
            {/each}
          </svg>
          <span class="max">max {valueText(series, series.max)}</span>
        {/if}
      </section>
    {/each}
  </div>
  <ol class="axis" aria-label="Sessions, in order">
    {#each trends.sessions as session (session.sessionId)}
      <li data-index={String(session.index)} title={session.sessionId}>
        {sessionPrimary(session, liveLabels)}
      </li>
    {/each}
  </ol>
{/if}

<style>
  .series-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 8px 12px 0;
  }

  .series {
    display: grid;
    grid-template-columns: 18ch 1fr auto;
    align-items: center;
    gap: 10px;
  }

  .label,
  .max,
  .none {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-2);
    white-space: nowrap;
  }

  .chart {
    display: block;
    background: var(--bg);
    border: 1px solid var(--line-soft);
    border-radius: 4px;
  }

  .line {
    fill: none;
    stroke: var(--amber-line);
    stroke-width: 1.25;
  }

  circle {
    fill: var(--ink);
    stroke: none;
  }

  .axis {
    margin: 8px 0 0;
    padding: 0 12px 8px 12px;
    list-style: decimal inside;
    font-size: 11px;
    color: var(--ink-3);
    columns: 2;
  }

  .empty {
    margin: 0;
    padding: 12px;
    color: var(--ink-2);
  }
</style>
