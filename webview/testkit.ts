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
  /** The sidebar menu, from the SAME bundle (v0.7.0 DoD 4.6b). */
  startSidebar(
    target: HTMLElement,
    api: { postMessage(message: WebviewToHostMessage): void },
  ): { dispose: () => void };
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

/** What `execFileSync` attaches to the error it throws. Neither is guaranteed. */
interface SpawnFailure {
  status?: number | null;
  stderr?: string;
  stdout?: string;
}

/**
 * Spawn a bundle build and return its stdout, or throw WITH THE CHILD'S OUTPUT.
 *
 * **THE ONE PLACE ANY WEBVIEW SUITE SPAWNS A BUNDLE BUILD** (v0.7.0, the 4.11b
 * gate, `phase-verifier` round 3). One run of the gate block failed with
 * `Command failed: node webview/build-harness.mjs` and no cause at all: five
 * files each spawned their own build with `logLevel: 'silent'` and no
 * `try`/`catch`, so a spawn that lost under parallel load reported as a failed
 * SUITE with its tests counted as SKIPPED — the repository's recorded
 * "reads green" class, arriving through a subprocess. `execFileSync` puts the
 * child's `stderr` on the error it throws and vitest prints only the message,
 * so the reason was discarded by the layer best placed to keep it. Fixing one
 * site of five would have left four able to repeat it, which is why this exists
 * rather than four copies of a `try`.
 */
export async function spawnBundle(args: readonly string[], what: string): Promise<string> {
  const cp = (await import(/* @vite-ignore */ CHILD_PROCESS)) as unknown as ChildProcessModule;
  try {
    return cp.execFileSync('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const failure = error as SpawnFailure;
    const stderr = (failure.stderr ?? '').trim();
    const parts = [
      `${what} failed (exit ${String(failure.status ?? 'unknown')})`,
      stderr === '' ? 'the child wrote nothing to stderr' : `stderr: ${stderr.slice(-4_000)}`,
    ];
    const stdout = (failure.stdout ?? '').trim();
    if (stdout !== '') parts.push(`stdout: ${stdout.slice(-1_000)}`);
    throw new Error(parts.join(' — '), { cause: error });
  }
}

let cachedCode: string | undefined;
/** The first failure, re-thrown to every later caller. See `bundleHarness`. */
let cachedFailure: Error | undefined;

/**
 * Bundle `webview/harness.ts` to an iife string. Cached per test file.
 *
 * THE FAILURE IS RE-THROWN WITH THE CHILD'S OWN OUTPUT ON IT. One run of the
 * 4.11b gate block failed here with `Command failed: node
 * webview/build-harness.mjs` and no cause at all: every webview test file spawns
 * this build, esbuild spawns a child of its own, and a spawn that loses under
 * parallel load reported as a failed SUITE with its tests counted as skipped.
 * `execFileSync` puts the child's `stderr` on the error it throws and vitest
 * prints only the message, so the reason was thrown away by the layer best
 * placed to keep it. Now it is in the message.
 */
export async function bundleHarness(): Promise<string> {
  if (cachedFailure !== undefined) throw cachedFailure;
  if (cachedCode !== undefined) return cachedCode;
  try {
    cachedCode = await spawnBundle(['webview/build-harness.mjs'], 'the harness bundle');
  } catch (error) {
    // THE FAILURE IS CACHED TOO. Without this, one lost spawn makes every
    // remaining test in the file spawn its own esbuild — a slow cascade that
    // reads as a hang under exactly the load that caused it.
    cachedFailure = error instanceof Error ? error : new Error(String(error));
    throw cachedFailure;
  }
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
