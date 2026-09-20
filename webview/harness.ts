/**
 * Test-only entry point for the webview bundle.
 *
 * Why it exists: this repo has no `@sveltejs/vite-plugin-svelte`, so vitest
 * cannot transform a `.svelte` import directly, and adding that plugin means
 * editing `vitest.config.ts` — which the webview package does not own. So the
 * component tests bundle the real renderer with the real esbuild + Svelte
 * pipeline and evaluate the result in jsdom.
 *
 * The side effect is that the component tests exercise the SHIPPED artifact
 * rather than a vitest-transformed approximation of it: `start()` here is the
 * same `start()` `main.ts` calls when VS Code loads the panel.
 *
 * Nothing in this file is reachable from `webview/main.ts`, so it adds nothing
 * to the production bundle.
 */

export { start, isHostMessage, acquireApi } from './main.js';
export { createStore } from './store.js';
export { flushSync } from 'svelte';
