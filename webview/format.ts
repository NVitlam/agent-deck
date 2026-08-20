/**
 * Agent Deck webview — display formatting.
 *
 * Pure functions only, no DOM, so they are testable in the node environment.
 * Nothing here reads or writes anything (G1) and nothing here can reach the
 * network (G5).
 */

/** U+2014. Used for "we do not have this number", never for zero. */
export const EM_DASH = '—';

/**
 * How much of a payload preview is shown while a node is collapsed.
 *
 * The host sends up to 8 KB per preview. Showing all of it inline would push
 * the rest of the tree off screen, so the collapsed form shows this many
 * characters and says explicitly how many it is hiding — a silent cut would
 * read as the payload having ended there.
 */
export const COLLAPSED_PREVIEW_CHARS = 512;

export interface CollapsedPreview {
  /** The visible slice. Equals the whole text when it was short enough. */
  text: string;
  truncated: boolean;
  /** Characters not shown. 0 when `truncated` is false. */
  hiddenChars: number;
  /** Explicit end-of-slice marker; empty string when nothing was cut. */
  marker: string;
}

/** The collapsed form of a payload preview. */
export function collapsePreview(
  text: string,
  limit: number = COLLAPSED_PREVIEW_CHARS,
): CollapsedPreview {
  if (text.length <= limit) {
    return { text, truncated: false, hiddenChars: 0, marker: '' };
  }
  const hiddenChars = text.length - limit;
  return {
    text: text.slice(0, limit),
    truncated: true,
    hiddenChars,
    marker: `[+${hiddenChars} more characters - expand to see all]`,
  };
}

/** Thousands-separated integer. Locale-independent so tests are stable. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return EM_DASH;
  const sign = n < 0 ? '-' : '';
  const digits = Math.abs(Math.trunc(n)).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A duration a human can compare at a glance. Sub-second stays in
 * milliseconds because tool calls routinely finish there.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return EM_DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds - minutes * 60);
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes - hours * 60).padStart(2, '0')}m`;
}

/**
 * Cumulative cost, per the Phase 3 decision on record.
 *
 * `SessionState.totals.costUsd` is hard 0 today and **0 means NOT COMPUTED,
 * never "free"**: there is no price table anywhere in this repo and
 * `src/model/graft.ts` refuses to invent one. Rendering `$0.00` would put a
 * fabricated claim ("this session cost nothing") in front of the user, so 0
 * renders as an em-dash with a tooltip instead.
 *
 * The non-zero branch exists so this function is total. It deliberately emits
 * no currency symbol — `USD` is the unit the field name already declares, and
 * nothing here converts or estimates.
 */
export function formatCost(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd === 0) return EM_DASH;
  return `${costUsd.toFixed(2)} USD`;
}

/** The tooltip that explains the em-dash. Exported so a test can pin it. */
export const COST_NOT_COMPUTED_TITLE =
  'cost not computed — no price table';

/** Human label for a node status chip. */
export function statusLabel(status: 'running' | 'done' | 'error'): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
  }
}

/** Human label for a session's liveness. */
export function livenessLabel(
  liveness: 'live' | 'idle' | 'ended' | 'unsupported',
): string {
  switch (liveness) {
    case 'live':
      return 'live';
    case 'idle':
      return 'idle';
    case 'ended':
      return 'ended';
    case 'unsupported':
      return 'unsupported';
  }
}

/** Why the hook tap is degraded, in one short clause. */
export function degradedReasonText(
  reason: 'noHookEvents' | 'listenerDown' | undefined,
): string {
  switch (reason) {
    case 'noHookEvents':
      return 'no hook events received';
    case 'listenerDown':
      return 'the hook listener is not running';
    default:
      return 'the hook tap is not reporting';
  }
}
