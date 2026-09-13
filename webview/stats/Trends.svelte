<!--
  Trends — spec §G view 4. From the store: prompt per session, loops per
  session, engine-reported cost per session where present, and — from v0.8.0
  Phase 7 (DoD 7.3) — F14's tokens per minute, one point per session in order.
  Draws `layout.ts:trendsLayout` and derives nothing.

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
  import { formatRate, formatUsd } from './text.js';

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

  /**
   * One point's marker: a ZERO-LENGTH segment, drawn by its round cap.
   *
   * v0.7.0 DoD 4.13, and the mechanism is not the one reported. The report was a
   * zero maximum; the cause is that the markers were `<circle r="1">` inside a
   * viewBox stretched by `preserveAspectRatio="none"`, and a circle's radius is in
   * VIEWBOX units. In a box one unit tall — which a `max` of 1 produces exactly as
   * the old stand-in for 0 did — every marker was a full-height ellipse, and the
   * two at the ends were clipped into the arcs the user saw. A `max` of 2 drew
   * half-height ones. `vector-effect="non-scaling-stroke"` fixes a STROKE and
   * never a radius, so the only mark whose size is independent of the box is a
   * stroke with no length: its round cap is drawn in screen pixels at any scale.
   *
   * The coordinates stay the layout's raw numbers flipped into the box, so the
   * transform — and the per-engine scale DoD 4.12 pins — is exactly what it was.
   */
  function markerOf(line: TrendLine, x: number, y: number): string {
    return `M ${String(x)} ${String(scaleOf(line) - y)} h 0`;
  }

  /**
   * The viewBox height. Only a FLAT line can have a zero maximum and a flat line
   * draws no box-scaled geometry at all (DoD 4.13), so the guard here exists to
   * keep a zero-height viewBox — which disables rendering outright — from ever
   * reaching the DOM, not to make a zero line look like something.
   */
  function scaleOf(line: TrendLine): number {
    return line.max > 0 ? line.max : 1;
  }

  /**
   * How one series' raw `y` reads. Keyed on the series id and TOTAL over it, so
   * a fifth series cannot arrive rendering a rate with a token formatter.
   *
   * `tokensPerMin` is v0.8.0 DoD 7.3's series and is the reason this stopped
   * being a ternary: the record carries the exact IEEE quotient (`timing.ts`
   * refuses to round, because rounding is presentation) and `formatTokens`
   * TRUNCATES — `Math.trunc` — so a rate of 0.83 tokens a minute would have
   * read as `0` in every tooltip and in the `max` caption.
   */
  const SERIES_TEXT: Readonly<Record<TrendSeries['id'], (y: number) => string>> = {
    prompt: formatTokens,
    loops: formatTokens,
    cost: formatUsd,
    tokensPerMin: formatRate,
  };

  function valueText(series: TrendSeries, y: number): string {
    return SERIES_TEXT[series.id](y);
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
                {#if line.flat}
                  <!-- DoD 4.13: every value is zero. A flat baseline and nothing else —
                       no path and no markers, because a shape normalised to a maximum
                       of zero is a picture of the stand-in scale, not of the data. -->
                  <line
                    class="baseline"
                    data-testid={TESTID.statsTrendBaseline}
                    x1="0"
                    y1={scaleOf(line)}
                    x2={Math.max(trends.width, 1)}
                    y2={scaleOf(line)}
                    vector-effect="non-scaling-stroke"
                  />
                {:else}
                  <path class="line" d={pathOf(line)} vector-effect="non-scaling-stroke" />
                  {#each line.points as point (point.sessionId)}
                    <path
                      class="marker"
                      data-testid={TESTID.statsTrendPoint}
                      data-series={series.id}
                      data-engine={line.engine}
                      data-session={point.sessionId}
                      data-index={String(point.index)}
                      data-x={String(point.x)}
                      data-y={String(point.y)}
                      d={markerOf(line, point.x, point.y)}
                      stroke-linecap="round"
                      vector-effect="non-scaling-stroke"
                    >
                      <title>{sessionPrimary(trends.sessions[point.index] ?? { sessionId: point.sessionId, engine: line.engine, projectSlug: '', startedAt: 0 }, liveLabels)}: {valueText(series, point.y)}</title>
                    </path>
                  {/each}
                {/if}
              </svg>
              <span class="max">{line.flat ? 'max 0' : `max ${valueText(series, line.max)}`}</span>
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
    /* A marker at the top or bottom of the box, or at either end, is a round cap
       centred ON the edge; clipped, half of it is an arc (DoD 4.13). */
    overflow: visible;
  }

  .line {
    fill: none;
    stroke: var(--amber-line);
    stroke-width: 1.25;
  }

  .marker {
    fill: none;
    stroke: var(--ink);
    stroke-width: 4;
  }

  .baseline {
    stroke: var(--line-soft);
    stroke-width: 1;
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
