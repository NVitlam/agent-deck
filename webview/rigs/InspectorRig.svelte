<!--
  TEST-ONLY. A rig that mounts `Inspector` and lets a test CHANGE ITS PROPS
  after mounting, the way a store update does — Svelte 5's `mount()` takes a
  plain props object that is not reactive, and a plain `.ts` test cannot
  declare a `$state` proxy of its own.

  Never imported by `webview/main.ts`; `.svelte` files are denied by
  `.vscodeignore`, so nothing here can ship. `inspector.phase4.test.ts` is the
  one consumer.
-->
<script lang="ts">
  import Inspector from '../Inspector.svelte';

  let { initial }: { initial: Record<string, unknown> } = $props();
  let current = $state.raw<Record<string, unknown>>(initial);

  /** Merge new props over the current ones; the component instance is kept. */
  export function update(next: Record<string, unknown>): void {
    current = { ...current, ...next };
  }
</script>

<Inspector {...current} />
