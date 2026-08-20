/**
 * Test-only: bundle the webview with the real esbuild + Svelte pipeline and
 * hand the result back as an evaluated module.
 *
 * See `harness.ts` for why the component tests go through a bundle instead of
 * importing `.svelte` files directly.
 *
 * Node-only. Nothing here is reachable from `webview/main.ts`.
 */

import { build } from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
import type { WebviewToHostMessage } from '../src/model/events.js';
import type { Store } from './store.js';

export interface WebviewHarness {
  start(
    target: HTMLElement,
    api: { postMessage(message: WebviewToHostMessage): void },
  ): { store: Store; dispose: () => void };
  createStore(sink?: (message: WebviewToHostMessage) => void): Store;
  /** Svelte's synchronous flush, so a test can assert on the DOM immediately. */
  flushSync(fn?: () => void): void;
}

const GLOBAL_NAME = 'AgentDeckHarness';

let cachedCode: string | undefined;

/** Bundle `webview/harness.ts` to an iife string. Cached per test file. */
export async function bundleHarness(): Promise<string> {
  if (cachedCode !== undefined) return cachedCode;
  const result = await build({
    entryPoints: ['webview/harness.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: GLOBAL_NAME,
    target: 'es2022',
    // Same resolution conditions as the shipped build, so the tests exercise
    // Svelte's client runtime and not its SSR build.
    conditions: ['svelte', 'browser'],
    mainFields: ['svelte', 'browser', 'module', 'main'],
    plugins: [esbuildSvelte({ compilerOptions: { css: 'injected' } })],
    logLevel: 'silent',
  });
  const js = result.outputFiles?.find((f) => f.path.endsWith('.js'));
  if (js === undefined) throw new Error('harness bundle produced no javascript');
  cachedCode = js.text;
  return cachedCode;
}

/**
 * Evaluate the bundle against the ambient (jsdom) globals and return its
 * exports. `new Function` keeps the iife's `var` out of the global object.
 */
export async function loadHarness(): Promise<WebviewHarness> {
  const code = await bundleHarness();
  const factory = new Function(`${code}\nreturn ${GLOBAL_NAME};`) as () => WebviewHarness;
  return factory();
}

/** All elements carrying a `data-testid`. */
export function all(root: ParentNode, testId: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
}

/** The single element with this `data-testid`; throws if absent or ambiguous. */
export function one(root: ParentNode, testId: string): HTMLElement {
  const found = all(root, testId);
  if (found.length !== 1) {
    throw new Error(`expected exactly one [data-testid="${testId}"], found ${found.length}`);
  }
  const first = found[0];
  if (first === undefined) throw new Error('unreachable');
  return first;
}
