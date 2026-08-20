/**
 * Test-only: bundle the webview with the real esbuild + Svelte pipeline and
 * hand the result back as an evaluated module.
 *
 * See `harness.ts` for why the component tests go through a bundle instead of
 * importing `.svelte` files directly, and `build-harness.mjs` for why the
 * bundling happens in a child process.
 *
 * Node-only. Nothing here is reachable from `webview/main.ts`.
 */

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

/**
 * `node:child_process` held in a variable rather than imported statically.
 *
 * `tsconfig.webview.json` sets `types: []` so the browser project cannot see
 * node globals — that is the compile-time half of "the webview has no fs and
 * no network". A static `import ... from 'node:child_process'` here would put
 * node's module graph into that project and fail the typecheck. The specifier
 * is opaque to `tsc` and resolved at runtime by vitest.
 */
const CHILD_PROCESS = 'node:child_process';

interface ChildProcessModule {
  execFileSync(
    file: string,
    args: readonly string[],
    options: { encoding: 'utf8'; maxBuffer: number },
  ): string;
}

let cachedCode: string | undefined;

/** Bundle `webview/harness.ts` to an iife string. Cached per test file. */
export async function bundleHarness(): Promise<string> {
  if (cachedCode !== undefined) return cachedCode;
  const cp = (await import(/* @vite-ignore */ CHILD_PROCESS)) as unknown as ChildProcessModule;
  cachedCode = cp.execFileSync('node', ['webview/build-harness.mjs'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
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
