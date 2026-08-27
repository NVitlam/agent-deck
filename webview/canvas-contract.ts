/**
 * Canvas UI — the single definition of every name that crosses a Phase 4.5
 * package boundary.
 *
 * WHY THIS FILE EXISTS. Phase 4.5 is partitioned by file ownership: one package
 * writes the layout engine, two write components, one writes the state-matrix
 * suite, and none of them may edit another's files. That partition has a known
 * failure mode and this repo has already paid for it once. Phase 3's host
 * emitted `<div id="app">` while the webview looked for `#agent-deck-root` and
 * fell back to `document.body`. Both packages were internally consistent, both
 * were fully tested, and they disagreed — the panel rendered into the wrong
 * element and nothing failed. `src/bridge/contract.ts` was the fix, and its
 * header states the lesson: two agreeing literals is exactly what was already
 * there. When work is split by file, the bugs land BETWEEN the files.
 *
 * So every string a component writes into the DOM and a test later selects on,
 * every class the motion invariant is asserted against, and every constant two
 * packages must agree on lives here and nowhere else. A package that needs a
 * new shared name adds it here rather than agreeing with a neighbour by hand.
 *
 * WHAT DOES NOT BELONG HERE. Anything only one package uses — private testids,
 * internal helper types, CSS that is not load-bearing for an assertion. This is
 * a contract, not a junk drawer; a name with one owner is that owner's to keep.
 *
 * NOR ANYTHING ALREADY DEFINED ELSEWHERE. `COLLAPSED_PREVIEW_CHARS` (512) lives
 * in `format.ts` and the truncation marker is built there too. The inspector
 * IMPORTS them. Re-declaring either here to "share" it would recreate the
 * two-agreeing-literals defect this file exists to prevent, on the one surface
 * — G4 truncation — where a wrong number is the same class of defect as a
 * fabricated cost.
 *
 * NO IMPORTS AT ALL, deliberately, exactly like `src/bridge/contract.ts`: this
 * module has to stay reachable from a CSP-strict browser bundle and from the
 * pure layout module, and an import is how a node dependency sneaks into either.
 */

/* ------------------------------------------------------------------------ *
 * Contract version
 * ------------------------------------------------------------------------ */

/**
 * The version of the host/webview shape defined by this file and by
 * `src/model/events.ts`'s message contract.
 *
 * **This constant did not exist before Phase 5, and `PLAN.md` DoD 5.1 asked for
 * it to be "bumped".** The gate re-measured the file and found zero
 * case-insensitive matches for `version`  the clause named an artifact that
 * had never been written, so gate amendment B1 introduces it rather than
 * reinterpreting the clause into something already true.
 *
 * It starts at **2**, not 1. Version 1 is the implicit shape everything before
 * Phase 5 spoke, and this phase changes it: `SessionState.engine` is now
 * stamped by both engines rather than inferred from absence,
 * `SessionFieldPatch` carries `engine`, `ToolNode` carries `truncated`, and
 * `ParkCode` gains `childSessionUnsupported`. Numbering the pre-existing shape
 * 1 and this one 2 is what makes the bump a real statement instead of a
 * constant introduced already-satisfied.
 *
 * **What it is NOT.** It is not a compatibility negotiation and nothing branches
 * on it: the host and the webview ship in one VSIX and are always the same
 * build. It exists so a change to the shared shape has a place to be declared,
 * and so a test can fail when the shape moves without anyone saying so  the
 * job `src/bridge/contract.ts` does for the element id, on the surface where
 * this repo has already paid once for two packages agreeing by hand.
 */
export const CANVAS_CONTRACT_VERSION = 2;

/* ------------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------------ */

/**
 * Tool dots rendered per agent before the remainder collapses into a `+n`
 * badge. The last N, not the first — what is happening now is at the end.
 *
 * 48, decided by the user on 2026-08-21. `docs/ui/ui-canvas-redesign.md` §5
 * proposes "e.g. render last 24"; that document is FROZEN and cited as written,
 * and `agent-deck-spec.md` C7.5 overrides it. Take the value from this constant
 * — not from the design doc, and not by re-reading either.
 *
 * It is a named constant rather than a literal so that arc geometry stays a
 * pure function of the capped count, which is what lets the goldens pin it.
 */
export const DOT_CAP = 48;

/** A placed session blob on the deck. */
export interface DeckPlacement {
  sessionId: string;
  x: number;
  y: number;
  /** Radius. Derived from node count, never from render size. */
  R: number;
}

/** A placed agent cell inside a session interior. */
export interface CellPlacement {
  x: number;
  y: number;
  R: number;
}

/** A placed tool dot inside a session interior. */
export interface DotPlacement {
  x: number;
  y: number;
}

/**
 * The result of `sessionLayout(session)`.
 *
 * Keyed by id rather than positional, because the incremental property is
 * stated in terms of ids: when a node arrives, every id already present keeps
 * its coordinates byte-identical. An array would make that assertion depend on
 * ordering, which is not what is being promised.
 */
export interface SessionLayout {
  cells: Map<string, CellPlacement>;
  dots: Map<string, DotPlacement>;
  /**
   * Dots elided by `DOT_CAP`, per agent id. Absent means nothing was elided;
   * a value of 0 must never be written, so `+n` badges cannot render "+0".
   */
  elided: Map<string, number>;
  /**
   * Parked grafts (`UNRESOLVED`), placed on their own orbit, keyed by agentId.
   *
   * SEPARATE FROM `cells` because a parked agent has NO NODE IN THE TREE. The
   * grafter deliberately leaves it off `root`, so `SessionState.parked` is the
   * only record that it exists at all — these are placed from that list, never
   * from a tree walk. That is also why they cannot be anchored: there is no
   * spawning dot to draw a filament to, which is the whole point of the state.
   */
  parked: Map<string, CellPlacement>;
}

/* ------------------------------------------------------------------------ *
 * Altitudes and surfaces
 * ------------------------------------------------------------------------ */

/**
 * Which altitude the panel is at. Webview-local UI state (G7): a reload starts
 * at `deck`, blank, waiting for the host's snapshot — correct, not a defect.
 *
 * `deck` is spelled differently from a liveness value on purpose; this axis and
 * the liveness axis are independent and must never be collapsed into one
 * attribute the way a single `data-state` would invite.
 */
export type Altitude = 'deck' | 'session' | 'inspector';

/** Which renderer is showing. The list view is kept for one release (C7.2). */
/**
 * Which sessions the deck shows. View state only: filtering never touches the
 * store's session list and never reaches the host.
 *
 * NOTE the deliberate exception it creates. `deckLayout` places by array index,
 * so changing the filter changes the array and blobs move. Everywhere else this
 * phase promises "a spawn adds, it never reflows" — here the user asked for a
 * different view of the same data, and moving is the honest response to that.
 */
export type DeckFilter = 'all' | 'live' | 'idle' | 'ended';

/** The chips, in the order they render. */
export const DECK_FILTERS: readonly DeckFilter[] = ['all', 'live', 'idle', 'ended'];

/** Zoom bounds for the deck stage. Bounded so a wheel cannot lose the deck. */
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 3;

export type ViewMode = 'canvas' | 'list';

/** The default at startup and after a reload. Canvas, immediately, no setting. */
export const DEFAULT_VIEW_MODE: ViewMode = 'canvas';

/* ------------------------------------------------------------------------ *
 * Test ids — the widest seam in this phase
 * ------------------------------------------------------------------------ */

/**
 * Every `data-testid` a component emits and a test in another package selects.
 *
 * These are the names most likely to drift, because the package that writes
 * them and the package that reads them never see each other's files. Selecting
 * on a literal string in a test is how a renamed testid becomes a silently
 * skipped assertion instead of a failure — `all()` returns an empty array and
 * a `.length === 0` check passes for the wrong reason.
 */
export const TESTID = {
  /* Deck */
  deck: 'deck',
  deckBlob: 'deck-blob',
  deckEmpty: 'deck-empty',
  deckErrorBadge: 'deck-error-badge',
  /** The faint interior dots on a blob: one per node, density without a number (C7.1). */
  deckConstellation: 'deck-constellation',

  /* Session interior */
  canvas: 'session-canvas',
  nucleus: 'canvas-nucleus',
  cell: 'canvas-cell',
  dot: 'canvas-dot',
  filament: 'canvas-filament',
  /** The dangling stub on a parked (UNRESOLVED) graft. */
  parkedStub: 'canvas-parked-stub',
  elidedBadge: 'canvas-elided-badge',

  /* Inspector */
  inspector: 'inspector',
  inspectorEmpty: 'inspector-empty',

  /** One action row in the inspector: what an agent DID, by description. */
  actionRow: 'action-row',
  /** The human-readable summary on an action row. Never the tool_use id. */
  actionSummary: 'action-summary',
  /** The session interior pan/zoom wrapper. A transform, never a coordinate. */
  canvasStage: 'canvas-stage',
  /** Resets the interior pan/zoom. */
  canvasReset: 'canvas-reset',

  /* Navigation and controls (Phase 4.6) */
  /** The breadcrumb nav. Spec C7.8 calls it the session dock. */
  dock: 'dock',
  /** The crumb that returns to altitude 0. A real button, not decoration. */
  crumbDeck: 'crumb-deck',
  /** The crumb naming where you are now. */
  crumbHere: 'crumb-here',
  /** One liveness filter chip. Carries data-filter and data-active. */
  filterChip: 'filter-chip',
  /** Reopens the inspector on the current selection after it was closed. */
  inspectorToggle: 'inspector-toggle',
  /** The pan/zoom wrapper. Carries the transform; NEVER a coordinate. */
  deckStage: 'deck-stage',
  /** Resets pan and zoom to the identity transform. */
  deckReset: 'deck-reset',
  /** How many sessions are showing, and of how many. */
  countChip: 'count-chip',
  /** The membrane-colour key. */
  legend: 'legend',

  /* Chrome */
  viewToggle: 'view-toggle',
  hud: 'hud',
  hudDegradedChip: 'hud-degraded-chip',
} as const;

/* ------------------------------------------------------------------------ *
 * Class names carrying an assertion
 * ------------------------------------------------------------------------ */

/**
 * Motion is a reserved semantic channel (C7.6): only things happening NOW
 * animate — running tools and live membranes, nothing else.
 *
 * The rule is enforced by a NEGATIVE CONTROL, which is why the class names have
 * to be shared rather than styled ad hoc: set every node done and every session
 * ended, and the count of elements carrying an animation-bearing class must be
 * exactly 0. A component that animates via a class not listed here would pass
 * that control while animating, which is the failure this list prevents.
 *
 * Every entry here MUST be a class that actually carries an animation in the
 * shipped CSS. Listing a class that does not animate weakens the control in the
 * one direction that cannot be detected by running it.
 */
export const ANIMATED_CLASSES = ['is-breathing', 'is-pulsing', 'is-flowing'] as const;

/**
 * Applied to the root when the user prefers reduced motion. The swap is BY
 * CLASS rather than by media query alone, because that is what makes the motion
 * rule assertable in jsdom, where media queries do not evaluate.
 */
export const REDUCED_MOTION_CLASS = 'reduced-motion';

/**
 * A live membrane while liveness is INFERRED from the JSONL tap because the
 * hook tap is silent (G2, degraded). Hollow rather than filled: the UI states
 * that it is inferring, instead of showing the same confident green it shows
 * when a hook event said so.
 */
export const HOLLOW_LIVE_CLASS = 'is-hollow-live';

/** A session whose schema fingerprint did not match (G3). Cracked, dashed. */
export const CRACKED_CLASS = 'is-cracked';

/** A graft that did not join (`UNRESOLVED`). Unattached, dashed, stubbed. */
export const PARKED_CLASS = 'is-parked';

/** `workspaceMatch: false` — another workspace's session. Ghosted. */
export const FOREIGN_CLASS = 'is-foreign';

/* ------------------------------------------------------------------------ *
 * Wire corpus (R6)
 * ------------------------------------------------------------------------ */

/**
 * Where `scripts/record-wire.mjs` writes and the theater and stress tests read.
 * One definition so a regenerate and a replay cannot disagree about the path.
 */
export const WIRE_CORPUS_DIR = 'webview/wire';

/**
 * Prefix marking a corpus as SYNTHETIC rather than replayed from fixtures.
 *
 * Load-bearing, not cosmetic. G6 pins the PARSER to harvested fixtures; the
 * renderer consumes `SessionState`, our own type, so stressing it with invented
 * states is fuzzing rather than schema guessing. The prefix is what keeps those
 * two categories distinguishable on disk, so a synthetic file can never be
 * mistaken for evidence about Claude Code.
 */
export const SYNTHETIC_CORPUS_PREFIX = 'synthetic-';
