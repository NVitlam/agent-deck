<!--
  The About SURFACE — v0.9.0 DoD 9.32, spec `Amendment 2026-09-21 — One
  window, Insights provider, Menu-only entry`.

  THE ROUND-3 PAGE, IN THE SAME WINDOW. Until this delta About was a panel of
  its own (`src/about-panel.ts`, deleted): an HTML string with one inline
  script. It is a surface of the one Agent Deck panel now, switched in place
  from Menu ▸ About, so it is rendered inside `App.svelte`'s `.app` and takes
  the deck's theme variables, fonts and background BY CONSTRUCTION rather than
  by a copy of them.

  Three blocks, in order: an introduction, a row of tiles, a footer line.
  Every tile is drawn like a session card — `SessionCell.svelte`'s fill,
  border, radius and hover — with a state-colour edge: the cool (ended) colour
  at rest, the warm (live) colour on hover. `surfaces.test.ts` reads
  `SessionCell.svelte` and holds these rules to it.

  TWO THINGS DEPEND ON THE INSIGHTS PROVIDER, and only on whether one is
  REGISTERED (never on what is installed, never on a licence):
   - none registered: a fifth, LIT tile, "Get Agent Deck Insights". Lit is the
     live card's treatment — the warm edge at rest, heavier — so it reads as
     the one tile that is different.
   - one registered: no Get tile, and a line stating the provider's name and
     version, so About covers both extensions.

  THE PAGE IS THE HOST'S. Text, labels, hosts and footer arrive in
  `providerState` (`src/about.ts` `aboutPage`); this file imports nothing
  from `src/about.ts`, so the webview bundle carries no url and no name.

  EVERY TILE ASKS FIRST. A press posts an INDEX (or `insightsGet`) and the
  HOST shows "Agent Deck will open <host> in your browser" with one Open
  button; nothing here opens anything, and the tiles are BUTTONS rather than
  anchors, because an `<a href>` in a webview is opened by the editor directly
  and would skip the confirmation.
-->
<script lang="ts">
  import type { AboutPageView, InsightsProviderSnapshot } from '../src/model/events.js';
  import { TESTID } from './canvas-contract.js';

  let {
    page,
    provider,
    onlink,
    onget,
  }: {
    /** `null` until the host has stated it: the heading alone, no tiles. */
    page: AboutPageView | null;
    provider: InsightsProviderSnapshot | null;
    onlink: (index: number) => void;
    onget: () => void;
  } = $props();
</script>

<main class="about" data-testid={TESTID.aboutSurface}>
  <section class="intro" data-testid="about-intro">
    <h1>Agent Deck</h1>
    {#if page !== null}
      <p data-testid="about-text">{page.text}</p>
    {/if}
    {#if provider !== null}
      <p class="provider" data-testid={TESTID.aboutProvider}>
        Insights provider: {provider.about.name} {provider.about.version}
      </p>
    {/if}
  </section>
  <nav class="tiles" data-testid="about-links" aria-label="Links">
    {#each page?.links ?? [] as link, index (index)}
      <button
        type="button"
        class="tile"
        data-testid={TESTID.aboutLink}
        data-index={String(index)}
        onclick={() => onlink(index)}
      >
        <span class="label" data-testid="about-link-label">{link.label}</span>
        <span class="host" data-testid="about-link-host">{link.host}</span>
      </button>
    {/each}
    {#if provider === null && page !== null}
      <button
        type="button"
        class="tile lit"
        data-testid={TESTID.aboutGetTile}
        data-lit="true"
        onclick={() => onget()}
      >
        <span class="label" data-testid="about-link-label">{page.get.label}</span>
        <span class="host" data-testid="about-link-host">{page.get.host}</span>
      </button>
    {/if}
  </nav>
  {#if page !== null}
    <footer data-testid={TESTID.aboutFooter}>{page.footer}</footer>
  {/if}
</main>

<style>
  .about {
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: 32px 24px;
    max-width: 60em;
    overflow: auto;
    user-select: text;
    -webkit-user-select: text;
  }

  h1 {
    margin: 0 0 8px;
    font-size: 1.6em;
    font-weight: 600;
  }

  .intro p {
    margin: 0;
    max-width: 46em;
    line-height: 1.6;
  }

  .intro .provider {
    margin-top: 12px;
    color: var(--vscode-descriptionForeground, inherit);
  }

  .tiles {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
  }

  .tile {
    box-sizing: border-box;
    width: 220px;
    min-height: 88px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
    padding: 12px 16px;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
    background: var(--vscode-editorWidget-background, transparent);
    border: 1px solid var(--vscode-panel-border, currentColor);
    border-left: 3px solid var(--vscode-charts-blue, currentColor);
    border-radius: 10px;
  }

  .tile:hover, .tile:focus-visible {
    border-color: var(--vscode-focusBorder, currentColor);
    border-left-color: var(--vscode-charts-yellow, currentColor);
  }

  .tile:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 2px;
  }

  /* LIT: the live card's treatment — the warm edge at rest, and heavier. */
  .tile.lit {
    border-left: 5px solid var(--vscode-charts-yellow, currentColor);
  }

  .label {
    font-weight: 600;
  }

  .host {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.88em;
    color: var(--vscode-descriptionForeground, inherit);
  }

  footer {
    font-size: 0.88em;
    color: var(--vscode-descriptionForeground, inherit);
    border-top: 1px solid var(--vscode-panel-border, transparent);
    padding-top: 12px;
  }
</style>
