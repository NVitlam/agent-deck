/**
 * The host→webview message guard — the one place the renderer says which
 * message types it accepts off `window.message`.
 *
 * Split out of `main.ts` in v0.7.0 Phase 4 so a node test can import it
 * without pulling the Svelte components `main.ts` mounts. No imports at all:
 * reachable from the CSP-strict bundle and from a plain node suite alike.
 */

import type { HostToWebviewMessage } from '../src/model/events.js';

/**
 * The message types the host sends. Kept as a list so the guard below and the
 * contract in `events.ts` can be compared by a test, rather than the guard
 * quietly lagging the union the way it would if it were a chain of `===`
 * nobody re-read.
 */
export const HOST_MESSAGE_TYPES: readonly HostToWebviewMessage['type'][] = [
  'snapshot',
  'diff',
  'schemaMismatch',
  'degraded',
  'statsSnapshot',
  'statsStore',
  'settings',
  'showView',
];

/** Type guard for anything arriving on `window.message`. */
export function isHostMessage(value: unknown): value is HostToWebviewMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && (HOST_MESSAGE_TYPES as readonly string[]).includes(type);
}
