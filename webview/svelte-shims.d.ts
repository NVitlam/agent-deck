/**
 * Ambient declaration so `tsc -p tsconfig.webview.json` accepts
 * `import Foo from './Foo.svelte'`.
 *
 * Svelte's own package ships no `*.svelte` module declaration — in a SvelteKit
 * project that comes from the framework's generated ambient types, which this
 * repo deliberately does not have (spec §7: custom tree, no component
 * libraries, single CSP bundle). esbuild-svelte compiles the real component;
 * this file only tells the type checker that the import resolves.
 *
 * Scaffolded by the Phase 3 orchestrator so the webview typecheck has an input
 * before any component exists. Owned by the webview package thereafter.
 */
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component<Record<string, unknown>>;
  export default component;
}
