<!--
  TEST-ONLY rig for `SessionCanvas.svelte` — v0.9.0 DoD 9.14.

  It exists for one prop. `resetEpoch` is how View ▸ Reset view reaches the
  session interior (ruling 6: one entry, and the store decides which surface
  it means), and a prop that only ever CHANGES cannot be driven by
  `mount(Component, { props })` — Svelte 5 reads a plain props object once, so
  a test that passed `resetEpoch: 1` would be testing a component that was
  born at 1 rather than one that was asked to reset.

  So the rig owns the counter as `$state` and exports the bump. `mount()`
  returns a component's instance exports in Svelte 5, which is what lets a
  test call it — the same shape `InspectorRig.svelte` already uses.

  Nothing here ships: `main.ts` does not import `rigs/`.
-->
<script lang="ts">
  import SessionCanvas from '../SessionCanvas.svelte';

  let props: Record<string, unknown> = $props();

  let resetEpoch = $state.raw(0);

  /** What View ▸ Reset view does to this surface. */
  export function reset(): void {
    resetEpoch += 1;
  }
</script>

<SessionCanvas {...props} {resetEpoch} />
