<!--
  Trends — spec §G view 4. From the store: prompt per session, loops per
  session, engine-reported cost per session where present, one point per
  session in order. Draws `layout.ts:trendsLayout` and derives nothing.

  ONE LINE PER ENGINE, EACH SCALED TO ITS OWN MAXIMUM (DoD 4.12, user ruling
  2026-09-09). A shared axis across engines made two of the three invisible:
  over a real store the median prompt total was 106,531,677 on Claude Code
  against 18,584 on Codex, so every Codex point sat on the baseline. The engine
  chips filter here exactly as they do everywhere else, so selecting one engine
  leaves one line.

  Empty state when the store is disabled, when it holds fewer than two records,
  or when it has NOT BEEN READ YET — the third is a different fact from the
  other two and says so.

  THE SCALE IS A TRANSFORM. A point's `x`/`y` are the layout's raw numbers;
  what fits them into the box is the SVG viewBox, computed from `max` — the
  rule `viewport.ts` states for the canvas, applied here so the incremental
  property (adding a record moves no existing point) is true of the DOM as
  well as of the layout.
-->
<script lang="ts">
  import { EM_DASH, formatTokens } from '../format.js';
  import { TESTID } from '../canvas-contract.js';
  import type { TrendLine, TrendsLayout, TrendSeries } from './layout.js';
  import { ENGINE_NAMES, sessionPrimary } from './text.js';
  import { formatUsd } from './text.js';

  let {
    trends,
    liveLabels,
  }: {
    trends: TrendsLayout;
    liveLabels: ReadonlyMap<string, string>;
  } = $props();

  const HEIGHT = 72;

  /**
   * `M x0 y0 L x1 y1 ...` over the raw points, y flipped inside the viewBox.
   *
   * The scale is THIS LINE's `max`, which is what per-engine normalisation
   * means in the DOM rather than only in the layout.
   */
  function pathOf(line: TrendLine): string {
    const max = scaleOf(line);
    return line.points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${String(p.x)} ${String(max - p.y)}`)
      .join(' ');
  }

  /** A zero maximum would divide the viewBox by nothing. */
  function scaleOf(line: TrendLine): number {
    return line.max > 0 ? line.max : 1;
  }

  function valueText(series: TrendSeries, y: number): string {
    return series.id === 'cost' ? formatUsd(y) : formatTokens(y);
  }
</script>

{#if trends.empty}
  <p class="empty" data-testid={TESTID.statsEmpty} data-view="trends" data-reason={trends.reason}>
    {#if trends.reason === 'loading'}
      Reading the stored history…
    {:else if trends.reason === 'disabled'}
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
        data-lines={String(series.lines.length)}
        aria-label={series.label}
      >
        <span class="label">{series.label}</span>
        {#if series.lines.length === 0}
          <span class="none">{EM_DASH}</span>
        {:else}
          {#each series.lines as line (line.engine)}
            <div
              class="engine-line"
              data-testid={TESTID.statsTrendLine}
              data-series={series.id}
              data-engine={line.engine}
              data-points={String(line.points.length)}
            >
              <span class="engine">{ENGINE_NAMES[line.engine]}</span>
              <svg
                class="chart"
                width="100%"
                height={HEIGHT}
                viewBox={`0 0 ${String(Math.max(trends.width, 1))} ${String(scaleOf(line))}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`${series.label}, ${ENGINE_NAMES[line.engine]}`}
              >
                <path class="line" d={pathOf(line)} vector-effect="non-scaling-stroke" />
                {#each line.points as point (point.sessionId)}
                  <circle
                    data-testid={TESTID.statsTrendPoint}
                    data-series={series.id}
                    data-engine={line.engine}
                    data-session={point.sessionId}
                    data-index={String(point.index)}
                    data-x={String(point.x)}
                    data-y={String(point.y)}
                    cx={point.x}
                    cy={scaleOf(line) - point.y}
                    r="1"
                    vector-effect="non-scaling-stroke"
                  >
                    <title>{sessionPrimary(trends.sessions[point.index] ?? { sessionId: point.sessionId, engine: line.engine, projectSlug: '', startedAt: 0 }, liveLabels)}: {valueText(series, point.y)}</title>
                  </circle>
                {/each}
              </svg>
              <span class="max">max {valueText(series, line.max)}</span>
            </div>
          {/each}
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
  /*
   * EACH LINE IS A FULL ROW (verifier defect 14). `.series` is a three-column
   * grid built when a series had exactly three children — label, chart, max.
   * A line per engine makes the children `label` plus N rows, and without
   * `grid-column` the second engine's line was placed in the remaining columns
   * and the third wrapped into the 18ch label column. jsdom computes no grid,
   * so no test can see this and the 4.9 smoke predates the change.
   */
  .engine-line {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: 8em 1fr 8em;
    align-items: center;
    gap: 6px;
  }

  .engine {
    font-size: 11px;
    opacity: 0.8;
  }

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
