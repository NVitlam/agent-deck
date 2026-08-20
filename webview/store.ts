/**
 * Agent Deck webview — the pure reducer.
 *
 * The webview is a **pure renderer**. Every piece of session data in here
 * arrived from the extension host in a `snapshot` or `diff` message; nothing
 * is derived and cached across messages, and nothing survives a reload. The
 * only state this module owns is *view* state: which session is selected and
 * which nodes the user toggled open or shut.
 *
 * No Svelte, no DOM, no timers. That is deliberate — it is what lets the
 * store's tests run in the node environment, and it keeps the reactive layer
 * (a `$state` snapshot inside `App.svelte`, refreshed from `subscribe`) thin
 * enough to be obviously correct.
 *
 * G1: writes nothing. G5: opens nothing. G7: no `localStorage`, no history,
 * no persistence of any kind — a reload starts empty and waits for the host's
 * snapshot.
 */

import type {
  HostToWebviewMessage,
  SessionState,
  WebviewToHostMessage,
} from '../src/model/events.js';
import { applySessionPatch } from '../src/bridge/apply.js';

/** One row of the left rail. */
export interface SessionSummary {
  sessionId: string;
  projectSlug: string;
  workspaceMatch: boolean;
  liveness: SessionState['liveness'];
  /** True when the session must render the refusal screen instead of a tree. */
  refused: boolean;
  label: string;
}

/** A patch the host sent that could not be applied. */
export interface PatchFailure {
  sessionId: string;
  message: string;
}

/**
 * Everything the components read. Recomputed on demand from the reducer's
 * state, never accumulated: feeding the same snapshot twice yields a
 * deep-equal view.
 */
export interface WebviewView {
  sessions: readonly SessionSummary[];
  selectedSessionId?: string;
  /** The selected session's state, straight from the host. */
  selected?: SessionState;
  /** True when the selected session must render the refusal screen (G3). */
  refused: boolean;
  degraded: boolean;
  degradedReason?: 'noHookEvents' | 'listenerDown';
  /** The user closed the banner for this degraded episode. */
  degradedDismissed: boolean;
  /**
   * The last patch that failed to apply, if the host has not re-snapshotted
   * since. Surfaced quietly; the host is required to send a fresh snapshot.
   */
  patchFailure?: PatchFailure;
  /**
   * Node ids of the selected session whose expansion the user has TOGGLED
   * AWAY FROM ITS DEFAULT — not the set of expanded nodes.
   *
   * Agents default to expanded (a tree whose branches are all shut is not a
   * tree) and tool payload previews default to collapsed (an 8 KB preview
   * inline would bury the tree). One set with one meaning covers both, and
   * nothing has to be seeded per node — seeding would mean writing an entry
   * for every node the host has ever sent, which is precisely the
   * accumulation "stateless" forbids.
   */
  toggledNodeIds: readonly string[];
}

export interface Store {
  getView(): WebviewView;
  /** Register a change listener. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Feed one host message. Never throws. */
  handleMessage(message: HostToWebviewMessage): void;
  /** UI intent: select a session. */
  selectSession(sessionId: string): void;
  /** UI intent: toggle a node's expansion. */
  toggleNode(nodeId: string): void;
  /** True when the user toggled this node away from its default. */
  isToggled(nodeId: string): boolean;
  dismissDegraded(): void;
}

/** Where UI intents go. The host end is the webview panel's `onDidReceiveMessage`. */
export type IntentSink = (message: WebviewToHostMessage) => void;

/**
 * Expansion is keyed by session *and* node so two sessions cannot share an
 * expansion, and the whole key set for a session is dropped when that session
 * leaves a snapshot — otherwise the set would grow for the lifetime of the
 * window, which is exactly the accumulation "stateless" forbids.
 */
function expansionKey(sessionId: string, nodeId: string): string {
  return `${sessionId} ${nodeId}`;
}

function summarize(state: SessionState, refused: boolean): SessionSummary {
  return {
    sessionId: state.sessionId,
    projectSlug: state.projectSlug,
    workspaceMatch: state.workspaceMatch,
    liveness: state.liveness,
    refused,
    label: state.root.label !== '' ? state.root.label : state.sessionId,
  };
}

export function createStore(postIntent: IntentSink = () => {}): Store {
  const sessions = new Map<string, SessionState>();
  /** Session order as the host sent it; a Map preserves it, but be explicit. */
  let order: string[] = [];
  const mismatched = new Set<string>();
  const toggled = new Set<string>();
  let selectedSessionId: string | undefined;
  let degraded = false;
  let degradedReason: 'noHookEvents' | 'listenerDown' | undefined;
  let degradedDismissed = false;
  let patchFailure: PatchFailure | undefined;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const isRefused = (state: SessionState): boolean =>
    !state.schemaOk || state.liveness === 'unsupported' || mismatched.has(state.sessionId);

  const applySnapshot = (incoming: SessionState[]): void => {
    const nextOrder: string[] = [];
    const seen = new Set<string>();
    sessions.clear();
    for (const state of incoming) {
      sessions.set(state.sessionId, state);
      nextOrder.push(state.sessionId);
      seen.add(state.sessionId);
    }
    order = nextOrder;

    // Drop view state belonging to sessions the host no longer reports. Without
    // this the toggle set and the mismatch set grow monotonically.
    for (const key of [...toggled]) {
      const sessionId = key.slice(0, key.indexOf(' '));
      if (!seen.has(sessionId)) toggled.delete(key);
    }
    for (const id of [...mismatched]) {
      if (!seen.has(id)) mismatched.delete(id);
    }
    // A snapshot is the host's authoritative re-statement, so any earlier
    // failed patch is now moot.
    patchFailure = undefined;

    if (selectedSessionId === undefined || !seen.has(selectedSessionId)) {
      selectedSessionId = order[0];
    }
  };

  return {
    getView(): WebviewView {
      const summaries = order
        .map((id) => sessions.get(id))
        .filter((s): s is SessionState => s !== undefined)
        .map((s) => summarize(s, isRefused(s)));
      const selected =
        selectedSessionId === undefined ? undefined : sessions.get(selectedSessionId);
      const prefix =
        selectedSessionId === undefined ? undefined : `${selectedSessionId} `;
      const toggledNodeIds =
        prefix === undefined
          ? []
          : [...toggled].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));

      const view: WebviewView = {
        sessions: summaries,
        refused: selected !== undefined && isRefused(selected),
        degraded,
        degradedDismissed,
        toggledNodeIds,
      };
      if (selectedSessionId !== undefined) view.selectedSessionId = selectedSessionId;
      if (selected !== undefined) view.selected = selected;
      if (degradedReason !== undefined) view.degradedReason = degradedReason;
      if (patchFailure !== undefined) view.patchFailure = patchFailure;
      return view;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    handleMessage(message: HostToWebviewMessage): void {
      switch (message.type) {
        case 'snapshot':
          applySnapshot(message.sessions);
          break;
        case 'diff': {
          const prev = sessions.get(message.sessionId);
          if (prev === undefined) {
            // A diff for a session we have never seen. Not fatal: the host
            // re-snapshots, and guessing a base state would fabricate a tree.
            patchFailure = {
              sessionId: message.sessionId,
              message: 'diff for an unknown session; waiting for a snapshot',
            };
            break;
          }
          try {
            sessions.set(message.sessionId, applySessionPatch(prev, message.patch));
            patchFailure = undefined;
          } catch (error: unknown) {
            // G2/G3: a patch that cannot be applied must not take the webview
            // down, and must not leave a half-applied tree on screen. Keep the
            // last good state and say so; the host owes us a snapshot.
            patchFailure = {
              sessionId: message.sessionId,
              message: error instanceof Error ? error.message : String(error),
            };
          }
          break;
        }
        case 'schemaMismatch':
          mismatched.add(message.sessionId);
          break;
        case 'degraded':
          if (message.degraded !== degraded) {
            // A new degraded episode gets a fresh banner; the dismissal only
            // silences the episode the user dismissed. Re-showing the same
            // banner on every message is the "nagging" spec C4 forbids.
            degradedDismissed = false;
          }
          degraded = message.degraded;
          degradedReason = message.degraded ? message.reason : undefined;
          if (!message.degraded) degradedDismissed = false;
          break;
      }
      notify();
    },

    selectSession(sessionId: string): void {
      if (!sessions.has(sessionId)) return;
      selectedSessionId = sessionId;
      postIntent({ type: 'selectSession', sessionId });
      notify();
    },

    toggleNode(nodeId: string): void {
      if (selectedSessionId === undefined) return;
      const key = expansionKey(selectedSessionId, nodeId);
      if (toggled.has(key)) toggled.delete(key);
      else toggled.add(key);
      // `expandNode` is a pure UI intent: the host is told what the user did
      // and sends nothing back. The webview never requests more data.
      postIntent({ type: 'expandNode', sessionId: selectedSessionId, nodeId });
      notify();
    },

    isToggled(nodeId: string): boolean {
      if (selectedSessionId === undefined) return false;
      return toggled.has(expansionKey(selectedSessionId, nodeId));
    },

    dismissDegraded(): void {
      degradedDismissed = true;
      notify();
    },
  };
}
