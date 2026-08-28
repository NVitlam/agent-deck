/**
 * The shape of a wire corpus file (R6).
 *
 * `scripts/record-wire.mjs` writes it, `webview/theater/` replays it, and
 * `webview/wire.test.ts` asserts on it. One declaration so the three cannot
 * disagree about a field name.
 *
 * The corpus is a TIMED sequence: `atMs` is a RELATIVE offset from the start
 * of the arc, never a wall-clock stamp. That is what makes re-recording
 * byte-identical, and it is the reason the recorder drives a simulated clock
 * instead of reading the real one.
 *
 * Type-only. Nothing here is reachable from `webview/main.ts`; the theater is
 * a dev-only page built by `node esbuild.config.mjs --theater` and never
 * enters the shipped bundle. `webview/wire.test.ts` asserts that against the
 * real import graph rather than against this comment.
 */

import type { DegradedMessage, HostToWebviewMessage, SessionState } from '../../src/model/events.js';

/** Whether a corpus was replayed from fixtures or invented. */
export type WireCorpusKind = 'recorded' | 'synthetic';

/** One message the host put on the wire, and when. */
export interface WireEvent {
  /** Offset in milliseconds from the start of the arc. Non-decreasing. */
  atMs: number;
  /** The arc step that produced it. Shown in the theater's transport. */
  label: string;
  message: HostToWebviewMessage;
}

/** One named moment in the arc, for the theater's step list. */
export interface WireStep {
  atMs: number;
  label: string;
  what: string;
}

/**
 * The host's own final belief, taken from `SessionEmission.sessions` rather
 * than by applying the recorded diffs.
 *
 * That independence is the whole point: a store fed the events must converge
 * on this, which is what proves the recorded traffic is the real traffic and
 * not a plausible reconstruction.
 */
export interface WireFinalState {
  sessions: SessionState[];
  degraded: { degraded: boolean; reason?: DegradedMessage['reason'] };
  /** Every session the bridge announced as a schema mismatch, sorted. */
  schemaMismatchSessionIds: string[];
}

export interface WireCorpus {
  formatVersion: number;
  /**
   * File basename without `.json`. A `synthetic` corpus MUST carry
   * `SYNTHETIC_CORPUS_PREFIX`; `writeCorpus` refuses the mismatch.
   */
  id: string;
  kind: WireCorpusKind;
  title: string;
  description: string;
  producedBy: string;
  /** Repo-relative, forward slashes. Absent on a synthetic corpus. */
  recordedFrom?: string;
  /**
   * Which observation engine produced the states (Phase 7, DoD 7.10).
   *
   * Absent means Claude Code, which is `SessionState.engine`'s own rule and is
   * restated here rather than re-decided: a corpus recorded before the second
   * engine existed carries no such field and must keep reading as CC.
   *
   * It is a CORPUS-LEVEL claim about the recording, not a summary of the
   * states - `webview/wire.test.ts` checks it against every session's own
   * `engine`, so a corpus that labelled itself wrong fails rather than
   * mislabelling the theater's picker.
   */
  engine?: NonNullable<SessionState['engine']>;
  /**
   * The host's own counters at the end of the recording. Counters only, never
   * a path.
   *
   * Recorded so a reader can tell a corpus taken off a healthy store from one
   * taken off a degraded or refusing one WITHOUT replaying it: a recording in
   * which `contentReads` is 1 and `schemaMismatches` is 0 is a recording of the
   * engine working, and one where they are not is a recording of something
   * else that would otherwise look identical from the outside.
   */
  hostDiagnostics?: Readonly<Record<string, number | boolean>>;
  /** The `fixtures/synthetic-layout` case that supplied the refusal, if any. */
  refusedLayoutCase?: string;
  /** The fixed instant the simulated clock started at. Not a record time. */
  simulatedEpochMs?: number;
  durationMs: number;
  steps: WireStep[];
  events: WireEvent[];
  final: WireFinalState;
}
