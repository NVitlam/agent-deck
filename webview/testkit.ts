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
import { ANIMATED_CLASSES } from './canvas-contract.js';

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

/**
 * Click an element the way a user does, WITHOUT `HTMLElement.prototype.click`.
 *
 * Measured hazard, not defensive style: `click()` is defined on `HTMLElement`
 * and NOT on `SVGElement`, so `element.click()` throws in jsdom on every cell,
 * dot and blob — the canvas is SVG end to end. A dispatched `MouseEvent` is
 * what both element families answer, so the matrix suite has one activation
 * path rather than one per namespace.
 *
 * `bubbles: true` because Svelte 5 delegates `onclick` to a listener on the
 * mount root: a non-bubbling event never reaches it, and the assertion that
 * follows then fails for a reason that has nothing to do with the component.
 *
 * Typed on `Element`, not `HTMLElement`, deliberately — an SVG element is not
 * an `HTMLElement`, and a signature that said otherwise would push every call
 * site into a cast and hide exactly the distinction this function exists for.
 */
export function press(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/**
 * Every element carrying an animation-bearing class (C7.6).
 *
 * The class list comes from `canvas-contract.ts` and is never spelled out
 * here. The negative control's whole job is to notice an animation on
 * something that is neither running nor live, and a control selecting on stale
 * literals would return an empty array and pass for the wrong reason.
 */
export function animated(root: ParentNode): Element[] {
  const selector = ANIMATED_CLASSES.map((c) => `.${c}`).join(',');
  return [...root.querySelectorAll(selector)];
}

/**
 * True when `element` sits inside an animated element.
 *
 * Counting classes alone cannot see a static child inheriting an animated
 * ancestor's transform — that element moves on screen while carrying no
 * animated class of its own, so the count-based control reads 0 while
 * something is visibly moving. This is the form of the check that can see it.
 */
export function hasAnimatedAncestor(element: Element): boolean {
  let node: Element | null = element.parentElement;
  while (node !== null) {
    for (const cls of ANIMATED_CLASSES) {
      if (node.classList.contains(cls)) return true;
    }
    node = node.parentElement;
  }
  return false;
}
