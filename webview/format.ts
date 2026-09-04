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

/**
 * Thousands-separated integer. Locale-independent so tests are stable.
 *
 * `undefined` yields {@link EM_DASH}, the same treatment {@link formatDuration}
 * gives an absent duration. It is load-bearing rather than convenient: an
 * engine that does not report a token figure leaves the field UNSET, and the
 * one thing the renderer must never do is print that as `0`. A caller holding
 * an optional `TokenPair` can pass `pair?.prompt` straight in.
 */
export function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return EM_DASH;
  const sign = n < 0 ? '-' : '';
  const digits = Math.abs(Math.trunc(n)).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * `SessionState.windowTokens`: the Codex engine's context-window ceiling, in
 * tokens (v0.6.0 Phase 3, spec C8, Phase 0 decision D0.2).
 *
 * Its own name rather than a bare alias for {@link formatTokens}, because the
 * call sites want a name that says what field they are rendering — but the
 * IDIOM is identical and deliberately restated rather than shared: absent or
 * non-finite yields {@link EM_DASH}, never `0`. `0` would claim a model with
 * no context window at all, which is a wrong number rather than a missing
 * one — the same rule `src/model/events.ts`'s `SessionState.contextNow`
 * states for its own absence.
 *
 * The CC and OpenCode engines never set `windowTokens`, so the em-dash is the
 * correct, permanent render for them — there is no per-engine branch here,
 * only the one absence rule every caller already gets from `undefined`. Per
 * D0.2: no engine ever gets a percentage or a gauge beside this figure,
 * because two of the three engines cannot report one at all.
 */
export function formatWindowTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return EM_DASH;
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

/** Human label for a session's liveness. See {@link Liveness}, declared below. */
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

// ---------------------------------------------------------------------------
// The five UI states: live, idle, ended, unsupported, degraded
// ---------------------------------------------------------------------------
//
// Four of the five are values of `SessionState.liveness`; the fifth (degraded)
// is not a session property at all — it is the hook tap's health, which
// arrives on its own message because the listener is one socket for the whole
// window (see `DegradedMessage` in `src/model/events.ts`).
//
// Every string below describes the state machine in `src/model/liveness.ts`
// and nothing else. In particular NONE of them names a number of seconds: the
// recency threshold is `DEFAULT_MTIME_THRESHOLD_MS`, it is configurable, and
// the webview is never told its value. Printing "120 s" here would be a number
// the renderer cannot stand behind — the same class of defect as printing a
// fabricated cost.

/** The four values `SessionState.liveness` can take. */
export type Liveness = 'live' | 'idle' | 'ended' | 'unsupported';

/** The whole set, so a caller never has to re-list it. */
export const LIVENESS_VALUES: readonly Liveness[] = [
  'live',
  'idle',
  'ended',
  'unsupported',
];

/**
 * What a liveness value means, for a `title`.
 *
 * Straight off the transition table in `liveness.ts`: two independent signals,
 * `running` and `recent`. Both good is `live`, both bad is `ended`, and a
 * disagreement is `idle` — because a disagreement is exactly the case where
 * claiming either extreme would be a guess. `unsupported` is never inferred;
 * it is asserted from outside by a refusal (G3).
 */
export function livenessTitle(liveness: Liveness): string {
  switch (liveness) {
    case 'live':
      return 'recently active, and something is still believed to be running';
    case 'idle':
      return 'only one of "recently active" and "still running" holds, so neither is claimed';
    case 'ended':
      return 'nothing is believed to be running, and there has been no recent activity';
    case 'unsupported':
      return 'the transcript layout was not recognised, so no tree is rendered for this session';
  }
}

/**
 * The liveness a session DISPLAYS, which is not always the one it carries.
 *
 * A `schemaMismatch` message refuses a session without changing the
 * `SessionState.liveness` the last snapshot delivered, so a session refused
 * mid-flight still says `live` on the wire while the main pane shows the
 * refusal screen. Two surfaces disagreeing about one session is the seam this
 * function closes: refused displays as `unsupported`, everywhere.
 */
export function displayLiveness(liveness: Liveness, refused: boolean): Liveness {
  return refused ? 'unsupported' : liveness;
}

/**
 * Marker shown beside a liveness value while the hook tap is degraded.
 *
 * Degraded means the documented tap is silent, so the liveness value came from
 * transcript recency alone — the fallback `liveness.ts` takes for a session
 * that has produced no hook events. That is the safe direction, but it is not
 * the same claim, and the header must not present it as one. The marker does
 * NOT depend on whether the banner was dismissed: dismissing the banner
 * silences the episode, it does not make the value better-sourced.
 */
export const LIVENESS_INFERRED_LABEL = 'inferred';

/** The tooltip that explains {@link LIVENESS_INFERRED_LABEL}. */
export const LIVENESS_INFERRED_TITLE =
  'the hook tap is not reporting, so this is inferred from transcript activity alone';

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
