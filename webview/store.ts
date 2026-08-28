/**
 * Agent Deck webview — the pure reducer.
 *
 * The webview is a **pure renderer**. Every piece of session data in here
 * arrived from the extension host in a `snapshot` or `diff` message; nothing
 * is derived and cached across messages, and nothing survives a reload. The
 * only state this module owns is *view* state: which session is selected,
 * which nodes the user toggled open or shut, which node the inspector is
 * looking at, which zoom altitude the canvas is at, and which of the two
 * renderers is showing.
 *
 * The canvas altitudes and the selected node live here by design, not by
 * omission (spec C7.7): keeping them webview-local is what makes the canvas a
 * webview-only change, with no new message in either direction and no host
 * diff. A reload therefore starts at the deck with nothing selected — correct
 * behaviour, not a defect.
 *
 * No Svelte, no DOM, no timers. That is deliberate — it is what lets the
 * store's tests run in the node environment, and it keeps the reactive layer
 * (a `$state` snapshot inside `App.svelte`, refreshed from `subscribe`) thin
 * enough to be obviously correct.
 *
 * G1: writes nothing. G5: opens nothing. G7: no `localStorage`, no history,
 * no persistence of any kind — a reload starts empty and waits for the host's
 * snapshot. That covers the altitude and the view mode as much as the session
 * data: neither is remembered across a reload.
 */

import type {
  ApplyError,
  HostToWebviewMessage,
  SessionState,
  TreeNode,
  TreeOp,
  WebviewToHostMessage,
} from '../src/model/events.js';
import { isAgentNode } from '../src/model/events.js';
import { applySessionPatch } from '../src/bridge/apply.js';
import { DEFAULT_VIEW_MODE } from './canvas-contract.js';
import type { Altitude, ViewMode } from './canvas-contract.js';
import { countNodes } from './layout.js';
import { DECK_FILTERS } from './canvas-contract.js';
import { DECK_ZOOM_LIMITS, TREE_ZOOM_LIMITS, clampScale } from './viewport.js';
import type { DeckFilter } from './canvas-contract.js';

/** One row of the left rail. */
export interface SessionSummary {
  sessionId: string;
  projectSlug: string;
  workspaceMatch: boolean;
  liveness: SessionState['liveness'];
  /** True when the session must render the refusal screen instead of a tree. */
  refused: boolean;
  label: string;
  /**
   * Every node in the session tree, agents and tools alike, root included.
   *
   * Here rather than in the deck because C7.1 derives blob radius from
   * `log(nodeCount)`, and `layout.ts:DeckSession` is exactly
   * `{ sessionId, nodeCount }` — a summary that carries the number satisfies
   * the layout engine directly, so no surface ever needs a whole
   * `SessionState` just to size a blob. Counted by `layout.ts:countNodes`,
   * which is golden-tested there; this module does not own a second walk.
   *
   * **0 for a refused session**, always. See {@link SessionSummary.errorCount}.
   */
  nodeCount: number;
  /**
   * Tool calls that ended in `error`, anywhere in the tree. Agent nodes with
   * `status: 'error'` are NOT counted.
   *
   * That is the definition C7.3 states — *"tool `error` → red thorn,
   * persists; count aggregates to a deck-level badge on the blob"* — and it
   * is the one the badge needs to be honest: the badge is the deck-level
   * aggregate of the interior's thorns, so it must count the same things the
   * thorns are drawn on. An agent is `error` BECAUSE a tool under it failed,
   * so counting both would report most failures twice.
   *
   * **0 for a refused session**, along with `nodeCount`, and that is G3 rather
   * than tidiness: a refused session's tree was not recognised, so no number
   * is read off it at all. A big cracked blob would be asserting "this session
   * has a lot in it" from a layout we declined to trust — the partial render
   * the refusal exists to prevent, in the size channel instead of the tree.
   * A refused blob therefore draws at `layout.ts:DECK_RADIUS_MIN` and carries
   * no badge, which is the deck saying nothing about content it refused.
   */
  errorCount: number;
  /**
   * Which observation engine produced this session (DoD 5.4).
   *
   * NORMALISED HERE, ONCE. `SessionState.engine` is optional and its absence
   * reads as `'cc'` — `src/model/events.ts` is the authority for that rule,
   * and gate amendment B3 makes `src/model/session.ts` stamp `'cc'`
   * explicitly, so every state the shipping CC model hands out carries it.
   * Absence stays expressible (an older construction of the interface, or a
   * test literal), so the default is applied in `summarize` and this field is
   * REQUIRED on the summary.
   *
   * That asymmetry is deliberate. A renderer that had to re-apply the default
   * would be the second place one rule is stated, and two places stating one
   * rule is how they come to disagree — the defect `canvas-contract.ts`'s
   * header describes, in the data instead of in a name.
   *
   * The type is derived from `SessionState` rather than written out, so the
   * day a third engine is added this row cannot be the place that forgot.
   */
  engine: NonNullable<SessionState['engine']>;
}

/** A patch the host sent that could not be applied. */
export interface PatchFailure {
  sessionId: string;
  message: string;
  /**
   * The op that could not be applied, when exactly one could not.
   *
   * Carried so the host's diagnostics channel can name it (DoD 5.5.3) without
   * the webview shipping the op's payload across the boundary — the payload is
   * renderer-side data and the host has no business trusting it.
   */
  op?: TreeOp['op'];
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
   * How many times a resync this store ASKED FOR has been answered with a
   * snapshot (DoD 5.5.2).
   *
   * Counted here as well as on the host because the two numbers answer
   * different questions: the host's counts requests it received, this one
   * counts repairs that actually landed. They disagree exactly when a request
   * is lost, which is the failure this whole phase exists to make visible.
   */
  resyncs: number;
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
  /**
   * Which renderer is showing. The canvas is the default immediately and
   * there is no setting (C7.2) — a setting would be a `package.json`
   * contribution, i.e. the host-manifest diff this surface is defined by not
   * making. The list view is kept for one release behind an in-panel toggle.
   */
  viewMode: ViewMode;
  /**
   * Which sessions the deck shows. `sessions` below is ALWAYS the full list —
   * filtering is applied by the deck, not by the store, so nothing downstream
   * can mistake a filtered view for the host's account of what exists.
   */
  deckFilter: DeckFilter;
  /**
   * The sessions the current filter admits. A derived convenience, recomputed
   * on every read like everything else here, never stored.
   */
  filteredSessions: readonly SessionSummary[];
  /**
   * Whether the inspector panel is open. Distinct from `altitude === 'inspector'`
   * on purpose: a node can stay SELECTED while its panel is shut, which is what
   * makes reopening possible without re-picking the node.
   */
  inspectorOpen: boolean;
  /** Deck pan/zoom. A TRANSFORM, never a coordinate — see `canvas-contract.ts`. */
  deckView: { x: number; y: number; k: number };
  /**
   * Per-session nudges, in stage units, keyed by sessionId.
   *
   * Blobs are placed on a golden-angle spiral and can overlap; this lets one
   * be dragged aside to see what is under it. Like the pan transform it is an
   * OFFSET APPLIED AT RENDER TIME — `deckLayout` still returns the same
   * coordinates it always did, so the goldens hold and a session dragged aside
   * snaps back the moment the user resets the view.
   */
  blobNudges: Readonly<Record<string, { dx: number; dy: number }>>;
  /**
   * Session-interior pan/zoom. Separate from `deckView` deliberately: they are
   * different spaces, and inheriting the deck+#39;s transform on entry would drop
   * you into an interior already panned somewhere you never chose.
   */
  canvasView: { x: number; y: number; k: number };
  /**
   * Which of the three canvas altitudes the panel is at (C7.1).
   *
   * Never independent of the two ids below, and the store — not a component —
   * is what keeps them consistent: `inspector` implies `selectedNodeId`, and
   * `session`/`inspector` imply `selectedSessionId`. A component that had to
   * defend against `inspector` with nothing selected would be defending
   * against a state this reducer does not produce.
   */
  altitude: Altitude;
  /**
   * The node the inspector is looking at, scoped to the selected session.
   *
   * Absent whenever the altitude is not `inspector`. Absent as soon as the
   * node stops appearing in the selected session's tree, because a selection
   * that outlives its node is the same unbounded-growth defect the toggle set
   * is keyed and pruned to avoid.
   */
  selectedNodeId?: string;
  /** The selected node itself, looked up on demand. Never cached. */
  selectedNode?: TreeNode;
}

export interface Store {
  getView(): WebviewView;
  /** Register a change listener. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Feed one host message. Never throws. */
  handleMessage(message: HostToWebviewMessage): void;
  /**
   * UI intent: select a session, without changing altitude.
   *
   * Unchanged from Phase 3, deliberately: the list view's rail selects a
   * session without zooming anywhere, and the canvas's deck→interior move is
   * {@link Store.enterSession}. Two names because they are two actions, not
   * one action with a flag.
   */
  selectSession(sessionId: string): void;
  /**
   * UI intent: select a session AND zoom into its interior (deck → altitude
   * `session`). Posts the same `selectSession` message and no other; the
   * altitude itself is never told to the host (C7.7).
   */
  enterSession(sessionId: string): void;
  /**
   * Open the inspector on a node of the selected session (altitude
   * `inspector`). Posts NOTHING: node selection is webview-local UI state,
   * and the payload is already in the snapshot the host sent.
   *
   * Ignored for an unknown node id and for a refused session, whose interior
   * must render nothing at all (C7.4, G3).
   */
  selectNode(nodeId: string): void;
  /**
   * Walk one altitude up: inspector → session interior → deck (C7.8, the
   * Escape key). A no-op at the deck, and it notifies nobody there — a
   * keystroke that changes nothing must not look like a change.
   *
   * Lives here rather than in a component so both surfaces walk the same
   * ladder and neither owns the transition.
   */
  escape(): void;
  /** Switch renderers (C7.2). Not persisted, not a setting, not a message. */
  setViewMode(mode: ViewMode): void;
  /** The in-panel toggle: canvas ⇄ list. */
  toggleViewMode(): void;
  /** Show only sessions of this liveness, or all of them. */
  setDeckFilter(filter: DeckFilter): void;
  /** Open or shut the inspector panel without changing the selected node. */
  setInspectorOpen(open: boolean): void;
  /** Pan the deck by a delta in stage units. */
  panDeck(dx: number, dy: number): void;
  /** Zoom the deck about a point, clamped to {@link DECK_ZOOM_LIMITS}. */
  zoomDeck(factor: number, originX: number, originY: number): void;
  /** Move one blob aside by a delta in stage units. Additive. */
  nudgeBlob(sessionId: string, dx: number, dy: number): void;
  /** Back to the identity transform, and every blob back where layout put it. */
  resetDeckView(): void;
  /** The same three, for the session interior. */
  panCanvas(dx: number, dy: number): void;
  zoomCanvas(factor: number, originX: number, originY: number): void;
  resetCanvasView(): void;
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

/**
 * The node with this id, or `undefined`.
 *
 * Walked on demand rather than indexed, for the same reason nothing else here
 * is cached: an index would have to be invalidated on every diff, and a stale
 * index is how a selection starts pointing at a node that is no longer in the
 * tree. `ToolNode` has no `children`, so only agents recurse.
 */
function findNode(root: TreeNode, id: string): TreeNode | undefined {
  if (root.id === id) return root;
  if (!isAgentNode(root)) return undefined;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Tool nodes whose status is `error`, anywhere below `node`.
 *
 * Agents are walked through, never counted: see the definition on
 * {@link SessionSummary.errorCount} for why counting both halves would
 * double-report a single failure.
 */
function countToolErrors(node: TreeNode): number {
  if (!isAgentNode(node)) return node.status === 'error' ? 1 : 0;
  let total = 0;
  for (const child of node.children) total += countToolErrors(child);
  return total;
}

function summarize(state: SessionState, refused: boolean): SessionSummary {
  return {
    sessionId: state.sessionId,
    projectSlug: state.projectSlug,
    workspaceMatch: state.workspaceMatch,
    liveness: state.liveness,
    refused,
    label: state.root.label !== '' ? state.root.label : state.sessionId,
    // Recomputed per call, like every other field on the view. Both numbers
    // are primitives, so feeding the same snapshot twice still yields a
    // deep-equal view — there is no object identity here to flap.
    nodeCount: refused ? 0 : countNodes(state),
    errorCount: refused ? 0 : countToolErrors(state.root),
    // Absence reads as `'cc'`. This is the one place that rule is applied;
    // see the field's own doc above.
    //
    // NOT zeroed for a refused session, unlike the two counts above. Those are
    // numbers read off a tree the fingerprint declined to trust, which is what
    // G3 forbids; which engine did the refusing is known independently of the
    // tree and is exactly what a reader needs to know about a cracked blob.
    engine: state.engine ?? 'cc',
  };
}

export function createStore(postIntent: IntentSink = () => {}): Store {
  const sessions = new Map<string, SessionState>();
  /** Set between asking for a resync and the snapshot that answers it. */
  let resyncPending = false;
  let resyncs = 0;

  /**
   * Record a patch failure and ask the host for a snapshot.
   *
   * One request per divergence episode: `resyncPending` gates it, so a burst
   * of failing diffs produces one request rather than one per diff. A renderer
   * that machine-guns the host is a renderer the host will start ignoring.
   */
  const failPatch = (failure: PatchFailure, reason: string): void => {
    patchFailure = failure;
    if (resyncPending) return;
    resyncPending = true;
    const request: WebviewToHostMessage = {
      type: 'resyncRequest',
      reason,
      sessionId: failure.sessionId,
    };
    if (failure.op !== undefined) request.failedOp = failure.op;
    postIntent(request);
  };
  /** Session order as the host sent it; a Map preserves it, but be explicit. */
  let order: string[] = [];
  const mismatched = new Set<string>();
  const toggled = new Set<string>();
  let selectedSessionId: string | undefined;
  let selectedNodeId: string | undefined;
  let altitude: Altitude = 'deck';
  let viewMode: ViewMode = DEFAULT_VIEW_MODE;
  let deckFilter: DeckFilter = 'all';
  let inspectorOpen = false;
  const IDENTITY_VIEW = { x: 0, y: 0, k: 1 };
  let deckView = { ...IDENTITY_VIEW };
  let blobNudges: Record<string, { dx: number; dy: number }> = {};
  let canvasView = { ...IDENTITY_VIEW };
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

  /**
   * Bring altitude and node selection back into agreement with the session
   * data, after anything that could have moved either.
   *
   * Idempotent, and that is load-bearing: `getView()` reads these fields
   * directly, so feeding the same snapshot twice has to leave them identical.
   * Everything here is a demotion — an altitude only ever falls, a selection
   * is only ever dropped — so the reducer can never invent a state the host
   * did not support.
   */
  const normalize = (): void => {
    const selected =
      selectedSessionId === undefined ? undefined : sessions.get(selectedSessionId);
    if (selected === undefined) {
      // Nothing selected at all: there is no interior to be inside of.
      selectedNodeId = undefined;
      altitude = 'deck';
      return;
    }
    if (isRefused(selected)) {
      // G3, C7.4: a refused session's interior renders nothing, so there is
      // nothing to inspect. Entering it is still allowed — that is where the
      // refusal card lives — but the inspector altitude is not reachable.
      selectedNodeId = undefined;
      if (altitude === 'inspector') altitude = 'session';
      return;
    }
    if (selectedNodeId !== undefined && findNode(selected.root, selectedNodeId) === undefined) {
      selectedNodeId = undefined;
      if (altitude === 'inspector') altitude = 'session';
    }
  };

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
    //
    // DoD 5.5.2: if we ASKED for this, count the repair. `resyncPending` is
    // cleared here and nowhere else, so the counter measures snapshots that
    // answered a request rather than snapshots in general — the host sends
    // those for its own reasons too (a session appearing, a panel reload).
    if (resyncPending) {
      resyncs += 1;
      resyncPending = false;
    }
    patchFailure = undefined;

    if (selectedSessionId === undefined || !seen.has(selectedSessionId)) {
      const previous = selectedSessionId;
      selectedSessionId = order[0];
      if (previous !== undefined) {
        // The interior the user was looking at no longer exists. Re-pointing
        // the same frame at a DIFFERENT session's interior would show them
        // something else without saying so, so fall back to the deck instead
        // and let them choose again. The node selection goes with it: it
        // belonged to the session that left.
        selectedNodeId = undefined;
        inspectorOpen = false;
        altitude = 'deck';
      }
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
        viewMode,
        altitude,
        deckFilter,
        // Derived on every read, never stored: `sessions` above stays the
        // host's full account, and this is one view of it. A component that
        // wanted to know "how many are there really" must not have to undo a
        // filter to find out.
        filteredSessions:
          deckFilter === 'all'
            ? summaries
            : summaries.filter((row) => row.liveness === deckFilter),
        inspectorOpen,
        deckView: { ...deckView },
        blobNudges,
        canvasView: { ...canvasView },
        resyncs,
      };
      if (selectedSessionId !== undefined) view.selectedSessionId = selectedSessionId;
      if (selected !== undefined) view.selected = selected;
      if (degradedReason !== undefined) view.degradedReason = degradedReason;
      if (patchFailure !== undefined) view.patchFailure = patchFailure;
      if (selectedNodeId !== undefined && selected !== undefined) {
        // Looked up every time. Caching the node would survive a diff that
        // replaced it, which is how a panel ends up describing a tree that no
        // longer exists.
        const node = findNode(selected.root, selectedNodeId);
        if (node !== undefined) {
          view.selectedNodeId = selectedNodeId;
          view.selectedNode = node;
        }
      }
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
            failPatch(
              { sessionId: message.sessionId, message: 'diff for an unknown session' },
              'diff for an unknown session',
            );
            break;
          }
          // DoD 5.5.1. Divergence no longer throws: every op that CAN be
          // applied is, and the ones that cannot are reported here. Keeping
          // the partial result is the point — the alternative, which `0.1.2`
          // shipped, is to discard the whole patch, keep a stale tree, and
          // apply the next patch to that same stale base. That is how a
          // one-node gap becomes a session-long divergence.
          const errors: ApplyError[] = [];
          try {
            const next = applySessionPatch(prev, message.patch, {
              onError: (e) => errors.push(e),
            });
            sessions.set(message.sessionId, next);
          } catch (error: unknown) {
            // Still reachable: a patch that would break the "root is an agent
            // node" invariant is a producer bug, not divergence, and `apply.ts`
            // deliberately still throws for it. Keep the last good tree.
            failPatch(
              {
                sessionId: message.sessionId,
                message: error instanceof Error ? error.message : String(error),
              },
              'patch threw',
            );
            break;
          }
          if (errors.length === 0) {
            patchFailure = undefined;
            break;
          }
          // DoD 5.5.2: tell the host. Before this, the store recorded the
          // failure, its own comment said "the host owes us a snapshot", and
          // nothing told the host anything.
          const first = errors[0];
          const failure: PatchFailure = {
            sessionId: message.sessionId,
            message:
              errors.length === 1
                ? `${first?.op ?? 'op'}: ${first?.reason ?? 'unapplicable'}`
                : `${String(errors.length)} ops could not be applied; first: ${first?.reason ?? 'unapplicable'}`,
          };
          if (errors.length === 1 && first !== undefined) failure.op = first.op;
          failPatch(failure, failure.message);
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
      normalize();
      notify();
    },

    selectSession(sessionId: string): void {
      if (!sessions.has(sessionId)) return;
      if (sessionId !== selectedSessionId) selectedNodeId = undefined;
      selectedSessionId = sessionId;
      postIntent({ type: 'selectSession', sessionId });
      normalize();
      notify();
    },

    enterSession(sessionId: string): void {
      // A fresh interior starts centred. Carrying the previous session's pan
      // into a different tree would drop the user somewhere they never chose,
      // and the two interiors share no coordinate space.
      canvasView = { ...IDENTITY_VIEW };
      if (!sessions.has(sessionId)) return;
      if (sessionId !== selectedSessionId) selectedNodeId = undefined;
      selectedSessionId = sessionId;
      altitude = 'session';
      postIntent({ type: 'selectSession', sessionId });
      normalize();
      notify();
    },

    selectNode(nodeId: string): void {
      if (selectedSessionId === undefined) return;
      const selected = sessions.get(selectedSessionId);
      if (selected === undefined) return;
      // A refused session has no interior to select from (G3): the refusal
      // card is the whole of it. Refuse, do not guess a node.
      if (isRefused(selected)) return;
      if (findNode(selected.root, nodeId) === undefined) return;
      selectedNodeId = nodeId;
      altitude = 'inspector';
      inspectorOpen = true;
      // No message. The host is not told which node is being inspected, and
      // does not need to be — the payload arrived with the snapshot.
      notify();
    },

    escape(): void {
      if (altitude === 'inspector') {
        altitude = 'session';
        inspectorOpen = false;
        selectedNodeId = undefined;
      } else if (altitude === 'session') {
        altitude = 'deck';
      } else {
        return;
      }
      notify();
    },

    setViewMode(mode: ViewMode): void {
      if (mode === viewMode) return;
      viewMode = mode;
      notify();
    },

    setDeckFilter(filter: DeckFilter): void {
      if (!DECK_FILTERS.includes(filter) || filter === deckFilter) return;
      deckFilter = filter;
      notify();
    },

    setInspectorOpen(open: boolean): void {
      if (open === inspectorOpen) return;
      inspectorOpen = open;
      // Opening the panel is what raises the altitude, and only when there is
      // something to inspect. Reopening on a selection that no longer resolves
      // would put the panel at an altitude with nothing in it.
      if (open && selectedNodeId !== undefined) altitude = 'inspector';
      if (!open && altitude === 'inspector') altitude = 'session';
      notify();
    },

    panDeck(dx: number, dy: number): void {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      if (dx === 0 && dy === 0) return;
      deckView = { ...deckView, x: deckView.x + dx, y: deckView.y + dy };
      notify();
    },

    zoomDeck(factor: number, originX: number, originY: number): void {
      if (!Number.isFinite(factor) || factor <= 0) return;
      if (!Number.isFinite(originX) || !Number.isFinite(originY)) return;
      const next = clampScale(deckView.k * factor, DECK_ZOOM_LIMITS);
      if (next === deckView.k) return;
      // Zoom ABOUT THE POINTER: the stage point under the cursor stays under
      // the cursor. Without this the deck slides away from whatever you were
      // aiming at, which reads as the zoom being broken rather than centred.
      const ratio = next / deckView.k;
      deckView = {
        k: next,
        x: originX - (originX - deckView.x) * ratio,
        y: originY - (originY - deckView.y) * ratio,
      };
      notify();
    },

    panCanvas(dx: number, dy: number): void {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      if (dx === 0 && dy === 0) return;
      canvasView = { ...canvasView, x: canvasView.x + dx, y: canvasView.y + dy };
      notify();
    },

    zoomCanvas(factor: number, originX: number, originY: number): void {
      if (!Number.isFinite(factor) || factor <= 0) return;
      if (!Number.isFinite(originX) || !Number.isFinite(originY)) return;
      const next = clampScale(canvasView.k * factor, TREE_ZOOM_LIMITS);
      if (next === canvasView.k) return;
      const ratio = next / canvasView.k;
      canvasView = {
        k: next,
        x: originX - (originX - canvasView.x) * ratio,
        y: originY - (originY - canvasView.y) * ratio,
      };
      notify();
    },

    resetCanvasView(): void {
      if (canvasView.x === 0 && canvasView.y === 0 && canvasView.k === 1) return;
      canvasView = { ...IDENTITY_VIEW };
      notify();
    },

    nudgeBlob(sessionId: string, dx: number, dy: number): void {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      if (dx === 0 && dy === 0) return;
      const prev = blobNudges[sessionId] ?? { dx: 0, dy: 0 };
      // Replaced wholesale rather than mutated, so `getView()` keeps handing
      // out a value that cannot be changed behind a component's back.
      blobNudges = { ...blobNudges, [sessionId]: { dx: prev.dx + dx, dy: prev.dy + dy } };
      notify();
    },

    resetDeckView(): void {
      const already =
        deckView.x === 0 && deckView.y === 0 && deckView.k === 1 &&
        Object.keys(blobNudges).length === 0;
      if (already) return;
      deckView = { ...IDENTITY_VIEW };
      // Reset means everything the user moved, not just the camera: a blob
      // left dragged aside after a "reset view" is the control lying.
      blobNudges = {};
      notify();
    },

    toggleViewMode(): void {
      viewMode = viewMode === 'canvas' ? 'list' : 'canvas';
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
