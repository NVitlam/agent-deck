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
  TokenPair,
  TreeNode,
  TreeOp,
  WebviewToHostMessage,
} from '../src/model/events.js';
import { isAgentNode } from '../src/model/events.js';
import { applySessionPatch } from '../src/bridge/apply.js';
import {
  DEFAULT_ENGINE_FILTER,
  DEFAULT_LIVENESS_FILTER,
  DEFAULT_VIEW_MODE,
  ENGINE_FILTERS,
  LIVENESS_FILTERS,
  VIEW_MODES,
} from './canvas-contract.js';
import type {
  Altitude,
  EngineFilter,
  LivenessFilter,
  ViewMode,
} from './canvas-contract.js';
import { countNodes } from './layout.js';
import { fit as fitCanvas } from './layout/fit.js';
import type { DrawerRect } from './layout/fit.js';
import type { StatsRecord } from '../src/stats/schema.js';
import {
  DECK_FIT_PADDING,
  DECK_ZOOM_LIMITS,
  TREE_ZOOM_LIMITS,
  clampScale,
  fitTo,
  panBy,
  zoomAbout,
} from './viewport.js';
import type { Rect, ViewportSize } from './viewport.js';

/* ------------------------------------------------------------------------ *
 * Auto-fit — the trigger table (v0.7.0 Phase 4, DoD 4.0)
 * ------------------------------------------------------------------------ */

/**
 * What the renderer last measured: the drawn tree's bounds, the field's
 * client size, and the drawer's rectangle (or `null` when closed). All three
 * in the field's client coordinates; the store never measures anything.
 */
export interface CanvasGeometry {
  bounds: Rect;
  viewport: ViewportSize;
  drawer: DrawerRect;
}

/**
 * One row of the trigger table: a store event, and whether it fits.
 *
 * THE TABLE IS DATA, and it is the whole of the auto-fit decision. The user's
 * rule (locked open question, 2026-09-05): the canvas re-fits on every event
 * that MOVES GEOMETRY, and on nothing that moves only a number. Every row is
 * driven both ways by `store.test.ts` — a listed trigger must call `fit`, a
 * listed non-trigger must not — so adding an event to the store without
 * adding it here is a test failure, not a silent default.
 *
 * `event` names the store method or message that produces it; the test's
 * driver map is keyed on the same strings.
 */
export interface FitTrigger {
  event: string;
  fits: boolean;
  why: string;
}

export const FIT_TRIGGERS: readonly FitTrigger[] = [
  // Geometry moves: fit.
  { event: 'selectNode', fits: true, why: 'node selected: the drawer opens' },
  { event: 'setInspectorOpen', fits: true, why: 'the drawer opened or closed' },
  { event: 'toggleDrawerExpanded', fits: true, why: 'the drawer expanded or collapsed' },
  { event: 'escape:inspector', fits: true, why: 'Escape closed the drawer' },
  { event: 'diff:insertNode', fits: true, why: 'an agent or call was grafted' },
  { event: 'diff:removeNode', fits: true, why: 'a node was removed' },
  { event: 'diff:replaceNode', fits: true, why: 'a subtree was replaced' },
  { event: 'diff:replaceRoot', fits: true, why: 'the tree was replaced' },
  { event: 'diff:reorderChildren', fits: true, why: 'children were reordered' },
  { event: 'diff:parked', fits: true, why: 'an agent was parked or unparked' },
  { event: 'diff:spawnEdges', fits: true, why: 'a spawn edge joined or left' },
  { event: 'snapshot', fits: true, why: 'a full re-statement of the sessions (R6 replay step, reload)' },
  { event: 'enterSession', fits: true, why: 'session switch' },
  { event: 'selectSession', fits: true, why: 'session switch' },
  { event: 'setEngineFilter', fits: true, why: 'engine chip toggle' },
  { event: 'setViewMode:canvas', fits: true, why: 'mode switch back to canvas' },
  { event: 'reportCanvasGeometry:changed', fits: true, why: 'panel or editor-group resize; label re-wrap that changed a node width' },
  // Numbers move, geometry does not: never fit.
  { event: 'diff:updateAgent', fits: false, why: 'token counters, status: a number on a box that did not move' },
  { event: 'diff:updateTool', fits: false, why: 'liveness colour, a status word' },
  { event: 'diff:fields', fits: false, why: 'session scalars: liveness, totals, context, burn, window' },
  { event: 'degraded', fits: false, why: 'the hook tap\'s health' },
  { event: 'schemaMismatch', fits: false, why: 'a refusal replaces the field entirely' },
  { event: 'statsSnapshot', fits: false, why: 'the Stats view; nothing on the canvas moved' },
  { event: 'statsStore', fits: false, why: 'the Stats view; nothing on the canvas moved' },
  { event: 'setLivenessFilter', fits: false, why: 'a deck filter' },
  { event: 'setViewMode:list', fits: false, why: 'leaving the canvas' },
  { event: 'setViewMode:stats', fits: false, why: 'leaving the canvas' },
  { event: 'setDetailAction', fits: false, why: 'the drawer body splits; the drawer does not resize' },
  { event: 'toggleNode', fits: false, why: 'list-view expansion' },
  { event: 'dismissDegraded', fits: false, why: 'the banner' },
  { event: 'panCanvas', fits: false, why: 'the user\'s own pan persists until the next trigger' },
  { event: 'zoomCanvas', fits: false, why: 'the user\'s own zoom persists until the next trigger' },
  { event: 'reportCanvasGeometry:unchanged', fits: false, why: 'the renderer re-measured the same numbers' },
];

/** Tree ops that move geometry. The rest change a field on a box in place. */
const GEOMETRY_OPS: ReadonlySet<TreeOp['op']> = new Set([
  'insertNode',
  'removeNode',
  'replaceNode',
  'replaceRoot',
  'reorderChildren',
]);

/** What a `createStore` caller may inject. */
export interface StoreOptions {
  /**
   * The fit function. Defaults to the pure `fit` from `layout/fit.ts`;
   * `store.test.ts` injects a spy to drive the trigger table both ways.
   */
  fit?: typeof fitCanvas;
}

function sameGeometry(a: CanvasGeometry, b: CanvasGeometry): boolean {
  const sameRect = (p: Rect | null, q: Rect | null): boolean =>
    p === q || (p !== null && q !== null && p.x === q.x && p.y === q.y && p.w === q.w && p.h === q.h);
  return (
    sameRect(a.bounds, b.bounds) &&
    a.viewport.width === b.viewport.width &&
    a.viewport.height === b.viewport.height &&
    sameRect(a.drawer, b.drawer)
  );
}

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
   * A refused card therefore carries no badge and no counts, which is the deck
   * saying nothing about content it refused.
   *
   * THIS COMMENT USED TO NAME A CONSTANT THAT NO LONGER EXISTS. It read "a
   * refused blob therefore draws at `layout.ts:DECK_RADIUS_MIN`", from the
   * phyllotaxis deck, where a blob's RADIUS was a function of `nodeCount` and
   * a refused session had to be pinned to the floor so its size could not
   * assert anything. Phase 7 deleted that geometry: every card is one shape,
   * `DECK_CARD_W` x `DECK_CARD_H` = 220 x 88, in all three layouts, and
   * `deck.test.ts`'s "draws ONE shape in every layout" asserts it. There is no
   * size channel left for a refusal to leak through, so the zeroes here now
   * only govern the badge and the card's own figures.
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
  /**
   * Agent nodes in the tree, root included. The deck card's `{n} ag`.
   *
   * Derived here for the reason every other derived number on this row is:
   * per-session derivation is the store's job, and a component holding its
   * own tree walk is a second implementation of one rule.
   *
   * **0 for a refused session**, like {@link SessionSummary.nodeCount} and for
   * the same reason (G3): no number is read off a tree the fingerprint
   * declined to trust.
   */
  agents: number;
  /**
   * Tool calls whose status is `running`, anywhere in the tree. The card's
   * `{n} in flight`, and half of the pulse rule (DoD 7.5).
   *
   * Tools only. An agent is `running` because a tool under it is, so counting
   * both would report one in-flight call two or three times on a deep tree.
   * **0 for a refused session.**
   */
  inflight: number;
  /**
   * Everything the session has spent, or ABSENT when the engine does not
   * report it.
   *
   * Optional, and the absence is the point: `EM_DASH` is the honest render of
   * an unreported figure and `0` is a wrong number rather than a missing one.
   * The OpenCode engine leaves it unset — see `SessionState.burn`. Absent for
   * a refused session too.
   */
  burn?: TokenPair;
  /**
   * How full the session's context is right now, or ABSENT. Same optionality
   * and the same reason as {@link SessionSummary.burn}.
   */
  contextNow?: TokenPair;
  /**
   * `SessionState.windowTokens`, carried unchanged (v0.6.0 Phase 3, spec C8).
   *
   * The Codex engine's context-window ceiling, in tokens. Optional for the
   * same reason as {@link SessionSummary.burn} and
   * {@link SessionSummary.contextNow}: the CC and OpenCode engines never set
   * it, absent is never `0`, and `format.ts:formatWindowTokens` is the one
   * place that rule turns into a rendered string. Absent for a refused
   * session too, alongside the other two.
   */
  windowTokens?: number;
  /**
   * `SessionState.totals.costUsd`, carried unchanged.
   *
   * **0 means NOT YET COMPUTED, never "free"** — there is no price table in
   * this repository. `format.ts:formatCost` is the one place that rule turns
   * into a rendered string, and it renders 0 as an em-dash.
   */
  costUsd: number;
  /**
   * The latest moment anything in this session was observed to happen: the
   * greatest `endedAt ?? startedAt` over every agent in the tree.
   *
   * A COMPARABLE ORDINAL, not a wall clock the store owns. It feeds
   * `layout.ts:DeckSession.last` (which only ever compares it) and the card's
   * relative-age text (which differences it against a `now` the RENDERER
   * supplies). This module has no clock and gains none here — that is what
   * keeps `getView()` idempotent.
   *
   * `ToolNode` carries no timestamp at all, so tools contribute nothing; the
   * agent that owns them does. **0 for a refused session**, which sorts it
   * last under `recent` and renders its age as an em-dash.
   */
  lastEventAt: number;
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
/** One hook tap's health, as a surface reads it. */
export interface DegradedTap {
  degraded: boolean;
  reason?: 'noHookEvents' | 'listenerDown';
}

export interface WebviewView {
  sessions: readonly SessionSummary[];
  selectedSessionId?: string;
  /** The selected session's state, straight from the host. */
  selected?: SessionState;
  /** True when the selected session must render the refusal screen (G3). */
  refused: boolean;
  /**
   * The CLAUDE CODE tap's health.
   *
   * Unchanged in meaning - it is what this field always held, and D2 was
   * the discovery that the NAME did not say so. Kept for the panel banner,
   * which is a Claude Code surface.
   */
  degraded: boolean;
  degradedReason?: 'noHookEvents' | 'listenerDown';
  /** The user closed the banner for this degraded episode. */
  degradedDismissed: boolean;
  /**
   * EVERY hook tap's health, by engine (DoD 5.0b).
   *
   * `cc` here and {@link degraded} above are the same value; this is the
   * shape a surface should read when it knows which engine it is drawing,
   * and the scalar is what the panel-wide banner reads.
   *
   * THERE IS NO `oc` MEMBER AND THERE NEVER WILL BE. OpenCode has no hook
   * tap - its liveness is a cursor on `event_sequence.seq` - so "hooks
   * silent" is not false about it, it is meaningless. Leaving the key out
   * makes an OpenCode cell asking this question a TYPE ERROR rather than a
   * rule someone has to remember, which is the difference between D2
   * happening again and not.
   */
  degradedByEngine: Readonly<Record<'cc' | 'codex', DegradedTap>>;
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
   * Which LIVENESS the deck shows. `sessions` below is ALWAYS the full list —
   * filtering is a view over it, so nothing downstream can mistake a filtered
   * view for the host's account of what exists.
   *
   * Renamed from `deckFilter` in Phase 7. There are two deck filters now and
   * the old name did not say which one it was; the type it carried was called
   * `DeckFilter` and so was a DIFFERENT type in `layout.ts` meaning an engine.
   */
  livenessFilter: LivenessFilter;
  /**
   * Which ENGINE's sessions the deck shows.
   *
   * **HERE RATHER THAN IN `Deck.svelte`, and that is a fix rather than a
   * preference.** It was `$state` in the component, and `App.svelte` mounts
   * `<Deck>` only while the altitude is `deck` — so entering a session
   * unmounted the deck and returning re-mounted it at `all`. The engine filter
   * silently reset on every session visit while the liveness filter beside it,
   * which was already store state, persisted. Two controls side by side
   * behaving differently, with nothing on screen explaining why.
   *
   * G7 is still satisfied, and by the thing G7 actually asks for: no VS Code
   * setting, no `workspaceState`, no `localStorage`, no host message. It is
   * discarded when the panel closes because the store goes with it.
   */
  engineFilter: EngineFilter;
  /**
   * The sessions the LIVENESS filter admits. A derived convenience, recomputed
   * on every read like everything else here, never stored.
   *
   * The engine filter is deliberately NOT applied here. `Deck.svelte` badges
   * each engine chip with the number of sessions that engine has, which it
   * counts off the list it is given — a list already narrowed by engine would
   * make every chip but the active one read 0.
   */
  filteredSessions: readonly SessionSummary[];
  /**
   * Whether the inspector panel is open. Distinct from `altitude === 'inspector'`
   * on purpose: a node can stay SELECTED while its panel is shut, which is what
   * makes reopening possible without re-picking the node.
   */
  inspectorOpen: boolean;
  /**
   * Whether the drawer is at its expanded height (design.md §8.6: collapsed
   * max-height 190 px, expanded exactly 46vh).
   *
   * In the store rather than in the component because Escape walks it — §8.6's
   * order is detail → drawer → out — and Escape is handled above the drawer.
   * A height the component owned privately would be a step the Escape walk
   * could not see.
   */
  drawerExpanded: boolean;
  /**
   * The call row whose detail pane is open, if any (§8.6: "opens on row
   * click, splits the body").
   *
   * ONE at a time, and that is the design rather than a simplification: the
   * pane takes the body's remaining width beside a 340 px list, so two open
   * details have nowhere to go. It is the first step of the Escape walk.
   */
  detailActionId?: string;
  /** Deck pan/zoom. A TRANSFORM, never a coordinate — see `canvas-contract.ts`. */
  deckView: { x: number; y: number; k: number };
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
  /**
   * `agentDeck.canvas.autoFit`, as the host last said (DoD 4.0). `true`
   * until a `settings` message arrives, which is the manifest default.
   */
  canvasAutoFit: boolean;
  /**
   * Incremented every time the store FITS the canvas. The renderer adopts
   * `canvasView` when this moves and not otherwise, which is what lets a
   * user's own pan survive a re-render that fitted nothing.
   */
  canvasFitEpoch: number;
  /**
   * The LIVE Layer 1 facts: one record per observed session, as the host's
   * pipeline last derived them (DoD 4.1). Replaced whole on every
   * `statsSnapshot`; never merged, never accumulated.
   */
  statsLive: readonly StatsRecord[];
  /** The stored history, in session order, for Trends (DoD 4.1). */
  statsStored: readonly StatsRecord[];
  /** `agentDeck.stats.enabled` as the host read it. Trends' empty-state reason. */
  statsStoreEnabled: boolean;
  /**
   * Has the stored history been READ yet? (DoD 4.12.)
   *
   * False until the first `statsStore` message lands. Before that the empty
   * `statsStored` is the absence of an answer, not the answer — and the Stats
   * view used to render it as "fewer than two sessions are recorded", which
   * over a 102 MB store is a confident wrong statement for several seconds.
   * The host always sends this message once, even when the store is disabled
   * (`#storeReadAtFlush` starts at -1 against an `appended` of 0), so nothing
   * can leave the view loading forever.
   */
  statsStoreLoaded: boolean;
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
   * Walk one step up: **detail pane → drawer → session interior → deck**
   * (design.md §8.6's Escape order, extending C7.8). A no-op at the deck, and
   * it notifies nobody there — a keystroke that changes nothing must not look
   * like a change.
   *
   * Lives here rather than in a component so both surfaces walk the same
   * ladder and neither owns the transition.
   *
   * **§8.6 names a step this does not take**: between the drawer and the deck
   * it says "re-root to parent". That step is NOT implemented, and it is not
   * an oversight of this walk — the focus root lives in `SessionCanvas.svelte`
   * as component state and the store cannot see it, so there is nothing here
   * to walk. Moving it would be a store/canvas refactor, not a drawer change.
   * Recorded so the next reader finds the reason rather than the gap.
   */
  escape(): void;
  /**
   * Toggle the drawer between its two heights (§8.6). Ignored when there is
   * nothing to inspect: a height change on an empty drawer is motion that says
   * nothing.
   */
  toggleDrawerExpanded(): void;
  /**
   * Open one call row's detail pane, or shut whichever is open.
   *
   * `undefined` shuts it. An unknown id is ignored rather than stored — the
   * rows are built from the node's own children, so an id outside them can
   * only come from a caller that invented one, and storing it would open an
   * empty pane.
   */
  setDetailAction(actionId: string | undefined): void;
  /** Switch renderers (C7.2). Not persisted, not a setting, not a message. */
  setViewMode(mode: ViewMode): void;
  /** The in-panel toggle: canvas ⇄ list. */
  toggleViewMode(): void;
  /** Show only sessions of this liveness, or all of them. */
  setLivenessFilter(filter: LivenessFilter): void;
  /**
   * Show only sessions from this engine, or all of them.
   *
   * Posts NOTHING and touches no session list, exactly like
   * {@link Store.setLivenessFilter}. An unknown value is ignored rather than
   * stored: the deck's chips are built from `ENGINE_FILTERS`, so a value
   * outside it can only come from a caller that invented one.
   */
  setEngineFilter(filter: EngineFilter): void;
  /** Open or shut the inspector panel without changing the selected node. */
  setInspectorOpen(open: boolean): void;
  /** Pan the deck by a delta in CLIENT pixels. `viewport.ts:panBy`. */
  panDeck(dx: number, dy: number): void;
  /**
   * Zoom the deck about a client point, in WHEEL NOTCHES.
   *
   * Notches, not a factor, and the change is deliberate: `viewport.ts` is the
   * single definition of pan/zoom for all three altitudes and its
   * {@link zoomAbout} takes a signed notch count, so a factor here meant this
   * module re-implementing `ZOOM_FACTOR ** notches` and the clamp beside it —
   * two implementations of one rule, which is the defect class
   * `canvas-contract.ts` exists to prevent, in arithmetic instead of in a
   * name. Positive zooms in; fractional values are allowed so a trackpad's
   * continuous delta needs no special case.
   */
  zoomDeck(notches: number, clientX: number, clientY: number): void;
  /**
   * Fit placed deck content into a viewport of this pixel size, with
   * {@link DECK_FIT_PADDING} of clear space. The double-click-on-empty-field
   * gesture (DoD 7.4).
   *
   * Takes the CONTENT RECTANGLE rather than the sessions, because the bounds
   * of what is drawn are the renderer's own layout output and this module has
   * no business re-deriving them: `layout.ts:deckLayout` places, and
   * `viewport.ts:boundsOf` measures.
   */
  fitDeck(content: Rect, size: ViewportSize): void;
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
  /**
   * The renderer reports what it measured (DoD 4.0). A CHANGED geometry is a
   * trigger in its own right — a panel resize, a label that re-wrapped — and
   * an unchanged one is not; a fit a trigger asked for while the geometry was
   * stale is completed here, against the fresh numbers.
   */
  reportCanvasGeometry(geometry: CanvasGeometry): void;
  /** Enter or leave the Stats view mode (DoD 4.3): stats <-> canvas. */
  toggleStats(): void;
  /**
   * Link-back (DoD 4.4): select the tool node a chain ordinal names, through
   * the EXISTING select intent. Resolves `(sessionId, agentId, ordinal)`
   * against the live session tree; returns `false`, and does nothing, when
   * the session is gone or refused or the ordinal names no call.
   */
  selectToolByOrdinal(sessionId: string, agentId: string, ordinal: number): boolean;
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

/** Agent nodes below and including `node`. Tools are walked through. */
function countAgents(node: TreeNode): number {
  if (!isAgentNode(node)) return 0;
  let total = 1;
  for (const child of node.children) total += countAgents(child);
  return total;
}

/**
 * Tool nodes whose status is `running`, anywhere below `node`.
 *
 * Agents are walked through, never counted — see
 * {@link SessionSummary.inflight} for why counting both would over-report.
 */
function countInflight(node: TreeNode): number {
  if (!isAgentNode(node)) return node.status === 'running' ? 1 : 0;
  let total = 0;
  for (const child of node.children) total += countInflight(child);
  return total;
}

/**
 * The greatest agent timestamp in the tree. 0 when the tree has none.
 *
 * `endedAt` when the agent has one, `startedAt` otherwise: an agent that has
 * finished was last heard from when it finished.
 */
function lastAgentEvent(node: TreeNode): number {
  if (!isAgentNode(node)) return 0;
  let latest = node.endedAt ?? node.startedAt;
  if (!Number.isFinite(latest)) latest = 0;
  for (const child of node.children) latest = Math.max(latest, lastAgentEvent(child));
  return latest;
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
    // The same G3 treatment as `nodeCount`/`errorCount`: a refused session's
    // tree was not recognised, so nothing is counted off it. `costUsd` is
    // zeroed rather than dropped because 0 already means NOT COMPUTED, which
    // is exactly the claim a refusal supports.
    agents: refused ? 0 : countAgents(state.root),
    inflight: refused ? 0 : countInflight(state.root),
    costUsd: refused ? 0 : state.totals.costUsd,
    lastEventAt: refused ? 0 : lastAgentEvent(state.root),
    // Carried by reference, not copied: `applySessionPatch` deep-freezes the
    // state, so the pair cannot be mutated behind a renderer's back, and
    // sharing the reference is what keeps `getView()` deep-equal across two
    // reads of one snapshot.
    ...(refused || state.contextNow === undefined ? {} : { contextNow: state.contextNow }),
    ...(refused || state.burn === undefined ? {} : { burn: state.burn }),
    ...(refused || state.windowTokens === undefined ? {} : { windowTokens: state.windowTokens }),
  };
}

export function createStore(postIntent: IntentSink = () => {}, options: StoreOptions = {}): Store {
  const fitFn = options.fit ?? fitCanvas;
  const sessions = new Map<string, SessionState>();
  /* ----- the Tweaks settings (v0.8.0 Phase 7, DoD 7.6) --------------------- */
  //
  // EVERY ONE STARTS OFF, AND THAT IS THE ABSENCE OF AN ANSWER RATHER THAN A
  // GUESSED DEFAULT. `src/sidebar/tweaks.ts` carries no default by design —
  // the amendment makes `settings.json` the source of truth and a second copy
  // of a default is the stale one — so until the host's `settings` message
  // arrives this store behaves EXACTLY as it did before DoD 7.6 existed: no
  // follow, no drawer on entry, a collapsed drawer. The host sends that
  // message when the surface is created, so the window is one message wide,
  // and nothing in it is a statement about what the user has configured.
  //
  // Read with `=== true` and never for truthiness: the record is typed
  // `boolean | string`, and a non-empty string must not turn an effect on.
  let followNewSessions = false;
  let openDrawerOnEnter = false;
  let drawerOpensExpanded = false;
  /* ----- auto-fit state (DoD 4.0) ----------------------------------------- */
  let canvasAutoFit = true;
  let canvasFitEpoch = 0;
  /** What the renderer last reported. `null` until it has reported once. */
  let geometry: CanvasGeometry | null = null;
  /** A trigger fired and no fit has run against fresh geometry since. */
  let fitPending = false;
  /* ----- the Layer 1 facts (DoD 4.1) --------------------------------------- */
  let statsLive: readonly StatsRecord[] = [];
  let statsStored: readonly StatsRecord[] = [];
  let statsStoreEnabled = true;
  let statsStoreLoaded = false;
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
  let livenessFilter: LivenessFilter = DEFAULT_LIVENESS_FILTER;
  let engineFilter: EngineFilter = DEFAULT_ENGINE_FILTER;
  let inspectorOpen = false;
  /**
   * §8.6's two drawer heights.
   *
   * `false` here rather than `drawerOpensExpanded` because no drawer is open
   * yet and no `settings` message has arrived: the OPENING height is read at
   * the moment a drawer opens, which is the only moment it can be read from a
   * setting the host may not have sent yet (DoD 7.6).
   */
  let drawerExpanded = false;
  /** Which call row's detail pane is open. One at a time (§8.6). */
  let detailActionId: string | undefined;
  const IDENTITY_VIEW = { x: 0, y: 0, k: 1 };
  let deckView = { ...IDENTITY_VIEW };
  let canvasView = { ...IDENTITY_VIEW };
  let degraded = false;
  let degradedReason: 'noHookEvents' | 'listenerDown' | undefined;
  let degradedDismissed = false;
  /** DoD 5.0b. `cc` mirrors the two scalars above; `codex` is its own tap. */
  let codexDegraded = false;
  let codexDegradedReason: 'noHookEvents' | 'listenerDown' | undefined;
  let patchFailure: PatchFailure | undefined;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const isRefused = (state: SessionState): boolean =>
    !state.schemaOk || state.liveness === 'unsupported' || mismatched.has(state.sessionId);

  /**
   * Run the fit, if the setting is on and the renderer has ever measured.
   *
   * Writes `canvasView` and bumps the epoch, which is how the renderer knows
   * this value is a FIT and not the stale prop it deliberately ignores for
   * its own pan/zoom. Returns whether anything happened, so a caller can
   * notify only when the view moved.
   */
  const applyFit = (): boolean => {
    if (!canvasAutoFit || geometry === null) return false;
    canvasView = fitFn(geometry.bounds, geometry.viewport, geometry.drawer);
    canvasFitEpoch += 1;
    fitPending = false;
    return true;
  };

  /**
   * A trigger fired (see `FIT_TRIGGERS`). Fit now against the last-known
   * geometry — so the store's decision is synchronous and testable — and
   * leave `fitPending` set until the renderer reports again, because a
   * structural diff changes the bounds AFTER the store has applied it and the
   * fresh numbers arrive on the next render.
   */
  const triggerFit = (): void => {
    fitPending = true;
    applyFit();
    // `applyFit` clears `fitPending`; a trigger wants the NEXT report to fit
    // too, whatever the geometry, because the bounds it just fitted were
    // measured before the event that fired it.
    fitPending = true;
  };

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

  /**
   * Open the drawer on the session's ROOT node (DoD 7.6, `openDrawerOnEnter`).
   *
   * The drawer is a node's panel — `App.svelte` mounts it only while
   * `inspectorOpen && selectedNode !== undefined` — so "open the drawer on
   * entering" has to name a node, and the root is the only one entering a
   * session picks out. Its call rows are the session's own tool calls, which
   * is what the setting's own sentence describes.
   *
   * A REFUSED session opens nothing (G3, C7.4): its interior renders the
   * refusal card and no tree, so there is nothing to inspect. That is the same
   * refusal `selectNode` already makes, stated here rather than reached by
   * calling through it, because this runs mid-entry with the altitude already
   * moved.
   */
  const openDrawerOnRoot = (state: SessionState): void => {
    if (isRefused(state)) return;
    selectedNodeId = state.root.id;
    altitude = 'inspector';
    inspectorOpen = true;
    // The drawer is opening, so it takes its opening height (DoD 7.6,
    // `drawerExpandedByDefault`).
    drawerExpanded = drawerOpensExpanded;
    detailActionId = undefined;
    // The drawer opened: the field just lost a band (trigger table,
    // `selectNode`'s row — the same geometry change by the same cause).
    triggerFit();
  };

  const applySnapshot = (incoming: SessionState[]): void => {
    const nextOrder: string[] = [];
    const seen = new Set<string>();
    // Taken BEFORE the clear: a session is new when this window has never held
    // it (DoD 7.6, `followNewSessions`). A host snapshot is the only thing that
    // introduces one — the store's own comment below says a snapshot is the
    // re-statement that carries an added or removed session — so this is the
    // one place the question can be asked.
    const known = new Set(sessions.keys());
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
        // The drawer's own two states go with the selection that owned them.
        // A detail pane left open would point at a call in a session that has
        // left, and an expanded height would be the only thing on screen still
        // describing it.
        detailActionId = undefined;
        drawerExpanded = drawerOpensExpanded;
        altitude = 'deck';
      }
    }

    // `followNewSessions` (DoD 7.6): a session that APPEARS while the deck is
    // open becomes the selected one.
    //
    // Three conditions, each of which is the setting read literally rather
    // than generously:
    //
    //  * `known.size > 0` — the FIRST snapshot introduces every session at
    //    once, and "the new one" is not a thing that set has. That case is
    //    already decided above (`order[0]`), by a rule this must not reverse.
    //  * `altitude === 'deck'` — the setting says "while the deck is open".
    //    Moving the selection out from under someone who is inside another
    //    session's interior would change what their whole panel is showing.
    //  * the LAST new id in the host's order, when several appear at once —
    //    the host appends as it discovers, so the last one is the most
    //    recently appeared, which is what "a session appears" names.
    //
    // Nothing is posted to the host: `selectSession` is a message about the
    // USER's intent, and this is the host's own news coming back to it.
    if (followNewSessions && known.size > 0 && altitude === 'deck') {
      const appeared = nextOrder.filter((id) => !known.has(id));
      const newest = appeared[appeared.length - 1];
      if (newest !== undefined && newest !== selectedSessionId) {
        selectedSessionId = newest;
        // The node selection belonged to whatever was selected before.
        selectedNodeId = undefined;
        inspectorOpen = false;
        detailActionId = undefined;
        drawerExpanded = drawerOpensExpanded;
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
        degradedByEngine: {
          cc: degradedReason === undefined ? { degraded } : { degraded, reason: degradedReason },
          codex:
            codexDegradedReason === undefined
              ? { degraded: codexDegraded }
              : { degraded: codexDegraded, reason: codexDegradedReason },
        },
        toggledNodeIds,
        viewMode,
        altitude,
        livenessFilter,
        engineFilter,
        // Derived on every read, never stored: `sessions` above stays the
        // host's full account, and this is one view of it. A component that
        // wanted to know "how many are there really" must not have to undo a
        // filter to find out.
        filteredSessions:
          livenessFilter === 'all'
            ? summaries
            : summaries.filter((row) => row.liveness === livenessFilter),
        inspectorOpen,
        drawerExpanded,
        deckView: { ...deckView },
        canvasView: { ...canvasView },
        resyncs,
        canvasAutoFit,
        canvasFitEpoch,
        statsLive,
        statsStored,
        statsStoreEnabled,
        statsStoreLoaded,
      };
      if (detailActionId !== undefined) view.detailActionId = detailActionId;
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
          // A snapshot is the host's re-statement of everything: a reload, an
          // added or removed session, a resync, an R6 replay step. Geometry
          // may have moved and the store cannot cheaply tell, so it fits.
          triggerFit();
          break;
        case 'statsSnapshot':
          // Replaced whole. The host sends every live record every time, so
          // a session that left is simply absent from the next message.
          statsLive = message.records;
          break;
        case 'statsStore':
          statsStored = message.records;
          statsStoreEnabled = message.enabled;
          statsStoreLoaded = true;
          break;
        case 'settings':
          canvasAutoFit = message.canvasAutoFit;
          // DoD 7.6. Three of the four tweaks change what this reducer does;
          // the fourth (`defaultOrdering`) is the deck's own control bar. The
          // keys are `TWEAK_SETTINGS`' keys, without the `agentDeck.` prefix.
          //
          // READ THROUGH A NULLABLE ALIAS, and the cast is the point rather
          // than a convenience. `handleMessage` never throws (G3) and the
          // guard above it — `webview/messages.ts:isHostMessage` — checks the
          // `type` field and nothing else, so a `settings` message reaching
          // this port without its record is a shape the renderer has to
          // survive. The contract says the field is required; the message port
          // is not the contract.
          {
            const tweaks = message.tweaks as Readonly<Record<string, unknown>> | undefined;
            followNewSessions = tweaks?.['followNewSessions'] === true;
            openDrawerOnEnter = tweaks?.['openDrawerOnEnter'] === true;
            drawerOpensExpanded = tweaks?.['drawerExpandedByDefault'] === true;
          }
          break;
        case 'showView':
          this.setViewMode(message.mode);
          // `setViewMode` has already notified; nothing below must run twice.
          return;
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
          // THE TRIGGER TABLE, applied to a diff: only an op that moves
          // geometry — and only on the session that is on screen — fits.
          // `updateAgent`/`updateTool`/`fields` are the token counters and
          // the liveness colour the locked rule names as non-triggers.
          if (message.sessionId === selectedSessionId) {
            const structural =
              (message.patch.tree ?? []).some((op) => GEOMETRY_OPS.has(op.op)) ||
              message.patch.parked !== undefined ||
              message.patch.spawnEdges !== undefined;
            if (structural) triggerFit();
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
          // DoD 5.0b: the message NAMES its tap, so this routes rather than
          // assuming. A Codex message must never move the Claude Code
          // banner's state, which is the whole defect D2 was.
          if (message.engine === 'codex') {
            codexDegraded = message.degraded;
            codexDegradedReason = message.degraded ? message.reason : undefined;
            break;
          }
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
      // Session switch: a different tree, so a fit (trigger table).
      triggerFit();
      normalize();
      notify();
    },

    enterSession(sessionId: string): void {
      // Carrying the previous session's pan into a different tree would drop
      // the user somewhere they never chose, and the two interiors share no
      // coordinate space — so this is cleared rather than kept.
      //
      // IT DOES NOT CENTRE ANYTHING, and this comment said it did until
      // 2026-08-28. Identity is the stage origin at the field's top-left, and
      // the tidy tree puts the root at `(totalWidth − NW) / 2` — 1,658 units
      // in on a real 16-subagent session, well off the right edge of any
      // panel. What actually frames a fresh interior is
      // `SessionCanvas.svelte`'s entry fit, which owns the rendered transform;
      // this value is not read by it.
      canvasView = { ...IDENTITY_VIEW };
      const entering = sessions.get(sessionId);
      if (entering === undefined) return;
      if (sessionId !== selectedSessionId) selectedNodeId = undefined;
      selectedSessionId = sessionId;
      altitude = 'session';
      postIntent({ type: 'selectSession', sessionId });
      // Session switch (trigger table). The renderer's own entry fit frames
      // the new tree first; this marks the fit pending so the first geometry
      // report after entry fits under the store's rule as well.
      triggerFit();
      // DoD 7.6. AFTER the altitude has moved to `session` and before
      // `normalize`, so the drawer's altitude is raised from a state that is
      // already consistent and `normalize` still gets to demote it if the
      // session cannot hold it.
      if (openDrawerOnEnter) openDrawerOnRoot(entering);
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
      // Selecting a DIFFERENT node shuts the detail pane. The pane describes
      // one call belonging to one node; carrying it across a selection change
      // would leave it describing a call the drawer above it no longer lists.
      if (nodeId !== selectedNodeId) detailActionId = undefined;
      // A drawer that is SHUT is about to open, so it takes its opening height
      // (DoD 7.6, `drawerExpandedByDefault`). A drawer already open keeps
      // whatever height the user last put it at: moving a node selection is
      // not opening a drawer, and resizing the one in front of them would be
      // a height change nobody asked for.
      if (!inspectorOpen) drawerExpanded = drawerOpensExpanded;
      selectedNodeId = nodeId;
      altitude = 'inspector';
      inspectorOpen = true;
      // The drawer opens (trigger table): the field just lost a band.
      triggerFit();
      // No message. The host is not told which node is being inspected, and
      // does not need to be — the payload arrived with the snapshot.
      notify();
    },

    escape(): void {
      // §8.6's order, first step first: the detail pane closes before the
      // drawer does. Written as its own branch ahead of the altitude ladder
      // rather than folded into it, because the pane is not an altitude — it
      // is a split inside one, and collapsing the two would make Escape drop
      // two levels on one keystroke.
      if (detailActionId !== undefined) {
        detailActionId = undefined;
      } else if (altitude === 'inspector') {
        altitude = 'session';
        inspectorOpen = false;
        selectedNodeId = undefined;
        // The height goes with the drawer. Reopening on the next selection at
        // a height the user left it at would be the drawer remembering; it
        // returns to its OPENING height instead, which is `false` until
        // `drawerExpandedByDefault` says otherwise (DoD 7.6).
        drawerExpanded = drawerOpensExpanded;
        // The drawer closed (trigger table): the field regained its band.
        triggerFit();
      } else if (altitude === 'session') {
        altitude = 'deck';
      } else {
        return;
      }
      notify();
    },

    toggleDrawerExpanded(): void {
      // Nothing to inspect, nothing to expand. Guarded on the SELECTION rather
      // than on `inspectorOpen`, because the panel can be shut with a node
      // still selected — that is what makes reopening possible — and growing a
      // shut drawer is a height change nobody can see.
      if (selectedNodeId === undefined) return;
      drawerExpanded = !drawerExpanded;
      // The drawer changed height (trigger table).
      triggerFit();
      notify();
    },

    setDetailAction(actionId: string | undefined): void {
      if (actionId === undefined) {
        if (detailActionId === undefined) return;
        detailActionId = undefined;
        notify();
        return;
      }
      if (actionId === detailActionId) return;
      // The id must name a call the SELECTED node actually made. Anything else
      // opens a pane onto nothing, which is the shape of every "renders a tree
      // that no longer exists" defect in this repository.
      if (selectedSessionId === undefined || selectedNodeId === undefined) return;
      const selected = sessions.get(selectedSessionId);
      if (selected === undefined) return;
      const owner = findNode(selected.root, selectedNodeId);
      if (owner === undefined || !isAgentNode(owner)) return;
      if (!owner.children.some((child) => child.id === actionId && !isAgentNode(child))) return;
      detailActionId = actionId;
      notify();
    },

    setViewMode(mode: ViewMode): void {
      if (mode === viewMode) return;
      if (!VIEW_MODES.includes(mode)) return;
      viewMode = mode;
      // Mode switch BACK to the canvas (trigger table): the field was
      // unmounted and its geometry is whatever the window is now.
      if (mode === 'canvas') triggerFit();
      notify();
    },

    toggleStats(): void {
      this.setViewMode(viewMode === 'stats' ? 'canvas' : 'stats');
    },

    setLivenessFilter(filter: LivenessFilter): void {
      if (!LIVENESS_FILTERS.includes(filter) || filter === livenessFilter) return;
      livenessFilter = filter;
      notify();
    },

    setEngineFilter(filter: EngineFilter): void {
      if (!ENGINE_FILTERS.includes(filter) || filter === engineFilter) return;
      engineFilter = filter;
      // Engine chip toggle (trigger table).
      triggerFit();
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
      // Shutting the drawer discards both of its own states, so reopening
      // gives the undetailed drawer §8.6 describes at its OPENING height
      // rather than whatever it looked like when it was dismissed. That
      // height is collapsed until `drawerExpandedByDefault` says otherwise
      // (DoD 7.6).
      if (!open) {
        detailActionId = undefined;
        drawerExpanded = drawerOpensExpanded;
      }
      // The drawer opened or closed (trigger table).
      triggerFit();
      notify();
    },

    panDeck(dx: number, dy: number): void {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      if (dx === 0 && dy === 0) return;
      deckView = panBy(deckView, dx, dy);
      notify();
    },

    zoomDeck(notches: number, clientX: number, clientY: number): void {
      if (!Number.isFinite(notches) || notches === 0) return;
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
      // `zoomAbout` keeps the stage point under the cursor under the cursor,
      // clamps to DECK_ZOOM_LIMITS, and returns the SAME OBJECT when the
      // scale did not move — which is what makes the no-op check below exact
      // rather than a float comparison.
      const next = zoomAbout(deckView, clientX, clientY, notches, DECK_ZOOM_LIMITS);
      if (next === deckView) return;
      deckView = next;
      notify();
    },

    fitDeck(content: Rect, size: ViewportSize): void {
      const finite = [content.x, content.y, content.w, content.h, size.width, size.height];
      if (finite.some((n) => !Number.isFinite(n))) return;
      const next = fitTo(content, size, DECK_FIT_PADDING, DECK_ZOOM_LIMITS);
      if (next.x === deckView.x && next.y === deckView.y && next.k === deckView.k) return;
      deckView = next;
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

    resetDeckView(): void {
      const already =
        deckView.x === 0 && deckView.y === 0 && deckView.k === 1;
      if (already) return;
      deckView = { ...IDENTITY_VIEW };
      notify();
    },

    toggleViewMode(): void {
      // Canvas <-> list, as it always was. From `stats` the toggle goes to
      // the canvas: the list is one step further from where the user is.
      this.setViewMode(viewMode === 'canvas' ? 'list' : 'canvas');
    },

    reportCanvasGeometry(next: CanvasGeometry): void {
      const finite = [
        next.bounds.x, next.bounds.y, next.bounds.w, next.bounds.h,
        next.viewport.width, next.viewport.height,
      ];
      if (finite.some((n) => !Number.isFinite(n))) return;
      const changed = geometry === null || !sameGeometry(geometry, next);
      geometry = next;
      // `reportCanvasGeometry:unchanged` with nothing pending: not a trigger.
      if (!changed && !fitPending) return;
      if (!canvasAutoFit) {
        // Setting off: geometry is recorded for the day it is turned on, and
        // nothing is fitted — `fit` is never called after the initial render.
        fitPending = false;
        return;
      }
      if (applyFit()) notify();
    },

    selectToolByOrdinal(sessionId: string, agentId: string, ordinal: number): boolean {
      const state = sessions.get(sessionId);
      if (state === undefined || isRefused(state)) return false;
      const agent = findNode(state.root, agentId);
      if (agent === undefined || !isAgentNode(agent)) return false;
      const tool = agent.children.find((child) => !isAgentNode(child) && child.ordinal === ordinal);
      if (tool === undefined) return false;
      // The EXISTING select intent, end to end: session, then node, exactly
      // as a click on a deck card and then on a cell would do it — and the
      // canvas, because that is where the node is.
      if (sessionId !== selectedSessionId) {
        canvasView = { ...IDENTITY_VIEW };
        selectedSessionId = sessionId;
      }
      // Posted whether or not the session changed, exactly as `selectSession`
      // posts on every call: the intent is the click, not the change.
      postIntent({ type: 'selectSession', sessionId });
      viewMode = 'canvas';
      detailActionId = undefined;
      selectedNodeId = tool.id;
      altitude = 'inspector';
      inspectorOpen = true;
      triggerFit();
      normalize();
      notify();
      return true;
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
