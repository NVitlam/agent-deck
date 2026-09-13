<!--
  The Tweaks panel — v0.8.0 Phase 7, DoD 7.6 (spec `Amendment 2026-09-12`).

  A RENDERER OF FOUR SETTINGS, and nothing else. The rows come from
  `src/sidebar/tweaks.ts` (data, read by the host too); a control's position is
  a function of the last `settings` message and of nothing in this file; a
  click posts `updateTweak` and the control does NOT move, because the host
  writing the setting is what moves it, on the message that follows.

  WHY A CLICK DOES NOT MOVE THE CONTROL. The amendment says settings are the
  source of truth. A panel that flipped itself on click would show a position
  `settings.json` disagreed with the moment anything else wrote the key — and
  "anything else" includes the Settings UI that this sidebar's own `Settings`
  entry opens, another window's Tweaks panel, and a workspace file edited by
  hand. So the browser's own toggle is undone in the handler and the value is
  re-read from the source. `webview/sidebar/tweaks.test.ts` drives exactly
  that: click, assert the message went, assert the control did not move, then
  deliver the message and assert it did.

  WHAT A ROW SHOWS BEFORE THE FIRST `settings` MESSAGE: nothing it has not been
  told. There is no default here to fall back on — `tweaks.ts` carries none, by
  design, because a copy of a default is the stale one — so an unpositioned row
  renders as UNKNOWN: the checkbox is indeterminate, the select has no option
  selected, both are disabled, and the row says so in words. Disabled is the
  load-bearing half: a checkbox click posts the NEGATION of the current value,
  and negating a value nobody has stated would write a setting the user never
  chose. The same treatment covers a key the message omitted and a value whose
  type the key cannot hold, so the unknown state is per ROW rather than
  per panel.
-->
<script lang="ts">
  import { TWEAK_SETTINGS, isTweakValue } from '../../src/sidebar/tweaks.js';
  import type { TweakSetting, TweakValue } from '../../src/sidebar/tweaks.js';
  import { TESTID } from '../canvas-contract.js';
  import type { TweaksSource } from './tweaks-source.js';

  let { source }: { source: TweaksSource } = $props();

  // The same shape `App.svelte` uses against the store: a plain snapshot,
  // replaced whole whenever the source says something changed. `$state.raw`
  // because the record is replaced rather than mutated.
  // svelte-ignore state_referenced_locally
  let tweaks = $state.raw(source.get());

  $effect(() => {
    tweaks = source.get();
    return source.subscribe(() => {
      tweaks = source.get();
    });
  });

  /**
   * The value this row is positioned at, or `undefined` for UNKNOWN.
   *
   * `isTweakValue` is the same guard the host applies at its own boundary, so
   * a boolean arriving on an enum key — or an enum value outside the list —
   * reads as "not stated" rather than being drawn as though it were.
   */
  function valueOf(tweak: TweakSetting): TweakValue | undefined {
    const raw = tweaks[tweak.key];
    if (raw === undefined) return undefined;
    return isTweakValue(tweak.key, raw) ? raw : undefined;
  }

  /**
   * A checkbox was operated. Undo the browser's toggle, then ask the host.
   *
   * The undo is not cosmetic: without it the control would hold a position no
   * setting has, until the host's answer happened to agree with it.
   */
  function onToggle(tweak: TweakSetting, event: Event): void {
    const el = event.currentTarget as HTMLInputElement;
    const current = valueOf(tweak);
    if (current === undefined) {
      el.checked = false;
      el.indeterminate = true;
      return;
    }
    el.checked = current === true;
    source.update(tweak.key, current !== true);
  }

  /** A select was operated. Same rule: read the choice, restore, post. */
  function onChoose(tweak: TweakSetting, event: Event): void {
    const el = event.currentTarget as HTMLSelectElement;
    const chosen = el.value;
    const current = valueOf(tweak);
    el.value = typeof current === 'string' ? current : '';
    if (current === undefined) return;
    if (!isTweakValue(tweak.key, chosen)) return;
    source.update(tweak.key, chosen);
  }
</script>

<section class="tweaks" data-testid={TESTID.tweaksPanel} aria-label="Tweaks">
  {#each TWEAK_SETTINGS as tweak (tweak.key)}
    {@const value = valueOf(tweak)}
    <div
      class="row"
      data-testid={TESTID.tweakRow}
      data-key={tweak.key}
      data-kind={tweak.kind}
      data-known={String(value !== undefined)}
      data-value={value === undefined ? '' : String(value)}
    >
      {#if tweak.kind === 'boolean'}
        <label class="line">
          <input
            type="checkbox"
            data-testid={TESTID.tweakControl}
            data-key={tweak.key}
            checked={value === true}
            indeterminate={value === undefined}
            disabled={value === undefined}
            onchange={(event) => onToggle(tweak, event)}
          />
          <span class="label" data-testid={TESTID.tweakLabel}>{tweak.label}</span>
        </label>
      {:else}
        <label class="line">
          <span class="label" data-testid={TESTID.tweakLabel}>{tweak.label}</span>
          <select
            class="select"
            data-testid={TESTID.tweakControl}
            data-key={tweak.key}
            value={value === undefined ? '' : value}
            disabled={value === undefined}
            onchange={(event) => onChoose(tweak, event)}
          >
            {#each tweak.options ?? [] as option (option)}
              <option value={option}>{option}</option>
            {/each}
          </select>
        </label>
      {/if}
      <p class="detail" data-testid={TESTID.tweakDetail}>{tweak.detail}</p>
      {#if value === undefined}
        <p class="unknown" data-testid={TESTID.tweakUnknown} role="status">
          No value has arrived from the settings.
        </p>
      {/if}
    </div>
  {/each}
</section>

<style>
  .tweaks {
    padding: 6px 0;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
  }

  .row {
    padding: 6px 20px 10px;
  }

  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .label {
    flex: 1;
  }

  .select {
    font: inherit;
    color: var(--vscode-settings-dropdownForeground, inherit);
    background: var(--vscode-settings-dropdownBackground, transparent);
    border: 1px solid var(--vscode-settings-dropdownBorder, transparent);
  }

  .detail {
    margin: 2px 0 0;
    opacity: 0.8;
    font-size: 0.92em;
  }

  .unknown {
    margin: 2px 0 0;
    opacity: 0.8;
    font-size: 0.92em;
    color: var(--vscode-descriptionForeground, inherit);
  }

  input:focus-visible,
  .select:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, currentColor);
    outline-offset: 1px;
  }
</style>
