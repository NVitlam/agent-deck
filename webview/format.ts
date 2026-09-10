/**
 * Agent Deck webview — display formatting.
 *
 * Pure functions only, no DOM, so they are testable in the node environment.
 * Nothing here reads or writes anything (G1) and nothing here can reach the
 * network (G5).
 */

import type { ToolNode } from '../src/model/events.js';

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

/**
 * Human label for a node status chip.
 *
 * Typed as `ToolNode['status']` rather than repeating the union by hand, so a
 * fifth status stops the build here instead of arriving unlabelled. The
 * previous hand-written copy is exactly why `'stalled'` could be added to the
 * model in v0.7.0 Phase 0c with the webview typecheck staying green — the same
 * duplicated-union seam that `OcToolRecord` has, found the same day.
 */
export function statusLabel(status: ToolNode['status'], toolName?: string): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
    case 'stalled':
      // DoD 4.9d: SAME DERIVATION, DIFFERENT LABEL. The status is still
      // `stalled` — the chip's colour, its elapsed time and the agent's badge
      // are untouched — and only the word changes, for the tools a person is
      // expected to answer. See {@link INTERACTIVE_TOOL_NAMES}.
      return toolName !== undefined && isInteractiveTool(toolName) ? WAITING_ON_YOU_LABEL : 'stalled';
    default:
      // EXHAUSTIVENESS, ENFORCED BY THE COMPILER (user ruling, 2026-09-06).
      //
      // A fifth `ToolNode.status` makes this assignment fail — the new member
      // is not assignable to `never` — so `npm run typecheck` goes red at the
      // one place that must learn about it, rather than the status arriving
      // unlabelled at runtime.
      //
      // This REPLACES the "untrusted-input guard" DoD 0c.4 originally named.
      // There is no such guard on the host→webview direction and there will
      // not be one: `messages.ts` guards INBOUND UI intents, and a `ToolNode`
      // travels outbound, which is the trusted direction. A type-level check
      // is the honest control for a trusted channel.
      return assertNeverStatus(status);
  }
}

/**
 * The label a stalled INTERACTIVE tool wears instead of "stalled" (DoD 4.9d).
 *
 * "Stalled" tells a user something is wrong; "waiting on you" tells them it is
 * their turn. Phase 0c measured the case on real captured data: an
 * `AskUserQuestion` that ran 167.1 s in `fixtures/cc-2.1.260/…/99f96635-…`,
 * ordinal 24 — a tool waiting on a human is `running`, emits no hooks and
 * appends nothing, so under the locked rule it goes amber after the threshold
 * and always will. The user ruled the STATE ships that way and the WORD is
 * relabelled here.
 */
export const WAITING_ON_YOU_LABEL = 'waiting on you';

/**
 * The DOCUMENTED interactive tools — the list is data, and it is a closed one.
 *
 * A tool Agent Deck has not been told is interactive keeps the `stalled` label,
 * because guessing from a name ("it has Ask in it") is the kind of inference G3
 * refuses. Two entries, both documented Claude Code tools whose whole purpose
 * is to wait for the person at the keyboard:
 *
 *   - `AskUserQuestion` — asks the user a question and blocks on the answer.
 *   - `ExitPlanMode` — presents the plan and blocks on the user's approval.
 *
 * "The hook-exposed permission prompts" (the DoD's second phrase) are NOT a
 * tool name: a permission prompt is any tool waiting on the `PermissionRequest`
 * hook, and nothing on a `ToolNode` says a call is in that state. Nothing is
 * guessed for them; the phase handoff records the gap rather than a heuristic.
 *
 * The test lives at the RENDER boundary, by name, from this list —
 * `src/model/stall.ts` is untouched and `ToolNode.status` never learns the
 * word.
 */
export const INTERACTIVE_TOOL_NAMES: readonly string[] = ['AskUserQuestion', 'ExitPlanMode'];

/** True iff `toolName` is on {@link INTERACTIVE_TOOL_NAMES}. Exact match only. */
export function isInteractiveTool(toolName: string): boolean {
  return INTERACTIVE_TOOL_NAMES.includes(toolName);
}

/**
 * The `never` sink for {@link statusLabel}.
 *
 * Separate and named so the failure a new status produces reads as
 * "unhandled status" rather than as an anonymous assignability error, and so
 * the runtime arm is deliberate: a value that reached here despite the types
 * is data the host should never have sent, and it renders as its own string
 * rather than throwing inside a render.
 */
function assertNeverStatus(status: never): string {
  return String(status);
}

/**
 * How long a stall has been visible, as a short human string.
 *
 * Rendered beside the chip so "stalled" carries EVIDENCE rather than being a
 * bare adjective: the user sees the silence measured. G10 keeps it to the
 * fact — a duration and nothing about why.
 */
export function stalledForLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return EM_DASH;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${String(totalMinutes)}m ${String(totalSeconds % 60)}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours)}h ${String(totalMinutes % 60)}m`;
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
