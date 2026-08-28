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
 * case-insensitive matches for `version` — the clause named an artifact that
 * had never been written, so gate amendment B1 introduces it rather than
 * reinterpreting the clause into something already true.
 *
 * It started at **2**, not 1. Version 1 is the implicit shape everything before
 * Phase 5 spoke, and Phase 5 changed it: `SessionState.engine` is now
 * stamped by both engines rather than inferred from absence,
 * `SessionFieldPatch` carries `engine`, `ToolNode` carries `truncated`, and
 * `ParkCode` gains `childSessionUnsupported`. Numbering the pre-existing shape
 * 1 and that one 2 is what made the bump a real statement instead of a
 * constant introduced already-satisfied.
 *
 * **3 is Phase 7**, and it is the first bump this file's own tripwire asked
 * for. Four things moved on the shared surface:
 *
 *  - `ZOOM_MIN` / `ZOOM_MAX` are GONE. One global pair could not express what
 *    the frozen design specifies (deck 0.5-2, tree 0.4-2); `viewport.ts` is the
 *    single definition now and the note further down records why.
 *  - `DOT_CAP` (48) is GONE. Production reads `DOT_LIMIT = 24` in
 *    `SessionCanvas.svelte`, per the frozen design, so the constant here was a
 *    name nothing consumed telling the reader to prefer it over the design.
 *  - `SessionLayout`, `CellPlacement`, `DotPlacement` and the four-field
 *    `DeckPlacement { sessionId, x, y, R }` are GONE. They described
 *    `sessionLayout()` and the phyllotaxis deck, both deleted in Phase 7;
 *    `layout.ts` owns `DeckPlacement { id, x, y }` and `TreePlacement` now.
 *  - The two filter axes were BOTH named `DeckFilter`, in two modules, meaning
 *    two different things. They are {@link EngineFilter} and
 *    {@link LivenessFilter} here, one definition each.
 *
 * **What it is NOT.** It is not a compatibility negotiation and nothing branches
 * on it: the host and the webview ship in one VSIX and are always the same
 * build. It exists so a change to the shared shape has a place to be declared,
 * and so a test can fail when the shape moves without anyone saying so — the
 * job `src/bridge/contract.ts` does for the element id, on the surface where
 * this repo has already paid once for two packages agreeing by hand.
 */
export const CANVAS_CONTRACT_VERSION = 3;

/* ------------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------------ *
 *
 * NOTHING GEOMETRIC LIVES HERE ANY MORE, and that is a deletion rather than an
 * omission. This section held `DOT_CAP` (48), `SessionLayout`, `CellPlacement`,
 * `DotPlacement` and a four-field `DeckPlacement { sessionId, x, y, R }` — the
 * shapes of `sessionLayout()` and the phyllotaxis deck. Phase 7 deleted both,
 * and a `git grep` at the audit found every one of those names with NO
 * consumer beyond its own declaration: a contract module describing code that
 * no longer exists, which is worse than silence because a reader trusts it.
 *
 * `DOT_CAP`'s doc comment is the sharpest case and worth recording. It said
 * "Take the value from this constant — not from the design doc, and not by
 * re-reading either", while production read `DOT_LIMIT = 24` in
 * `SessionCanvas.svelte`, per the frozen design. The instruction pointed at the
 * wrong number and nothing could fail.
 *
 * The geometry that replaced it is `layout.ts`'s, and it stays there: it is
 * pinned by goldens re-derived from an independent reference implementation,
 * which is a stronger arrangement than a shared literal. See
 * {@link CANVAS_CONTRACT_VERSION} for the version this deletion moved.
 */

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

/* ------------------------------------------------------------------------ *
 * The deck's two filter axes
 * ------------------------------------------------------------------------ *
 *
 * TWO AXES, TWO NAMES, and until Phase 7's audit they had ONE name between
 * them. `canvas-contract.ts` declared `DeckFilter = 'all' | 'live' | 'idle' |
 * 'ended'` and `layout.ts` declared `DeckFilter = 'all' | 'cc' | 'oc'` — two
 * meanings, one identifier, in one package, inside the file whose stated
 * purpose is preventing exactly that. Neither module imported the other, so
 * nothing ever failed; a reader who followed the wrong import would have got a
 * type that accepted `'live'` where an engine belonged.
 *
 * They are independent: a user can ask for OpenCode sessions that are idle.
 * Collapsing them into one attribute is the mistake `Altitude`'s note above
 * describes, in the filter bar instead of in the altitude.
 */

/**
 * Which ENGINE's sessions the deck shows. View state only: filtering never
 * touches the store's session list and never reaches the host.
 *
 * `oc`, not `opencode` — this is the deck's own two-letter vocabulary, and
 * `layout.ts:deckEngine` is the one supported conversion from
 * `SessionState['engine']`.
 *
 * NOTE the deliberate exception it creates. `deckLayout` places by array index,
 * so changing a filter changes the array and cards move. That is not a breach
 * of anything: the user asked for a different view of the same data, and moving
 * is the honest response to that. See `layout.ts`'s header for what the layout
 * does and does not promise about movement.
 */
export type EngineFilter = 'all' | 'cc' | 'oc';

/** The engine chips, in the order they render. */
export const ENGINE_FILTERS: readonly EngineFilter[] = ['all', 'cc', 'oc'];

/** Design default: all engines. */
export const DEFAULT_ENGINE_FILTER: EngineFilter = 'all';

/**
 * Which LIVENESS the deck shows. View state only, on the same terms as
 * {@link EngineFilter}.
 *
 * `all` plus three of the four `SessionState.liveness` values. `unsupported` is
 * deliberately absent: it is not a state a user filters FOR, and a refused
 * session is already unmistakable on the card.
 */
export type LivenessFilter = 'all' | 'live' | 'idle' | 'ended';

/** The liveness chips, in the order they render. */
export const LIVENESS_FILTERS: readonly LivenessFilter[] = ['all', 'live', 'idle', 'ended'];

/** Design default: every liveness. */
export const DEFAULT_LIVENESS_FILTER: LivenessFilter = 'all';

/**
 * Zoom bounds do NOT live here, and the reason is the whole point of this file.
 *
 * A single global pair cannot express what the frozen design specifies: the
 * deck clamps to 0.5-2 and the tree to 0.4-2. This file held one pair, the
 * store clamped BOTH stages with it, and `webview/viewport.ts` independently
 * carried the correct per-altitude limits - two implementations of one rule,
 * disagreeing, with nothing failing. Exactly the class this file exists to
 * prevent, committed inside the file that exists to prevent it.
 *
 * `viewport.ts` is the single definition: DECK_ZOOM_LIMITS, TREE_ZOOM_LIMITS,
 * ZOOM_FACTOR, clampScale. Import from there.
 */

/** Which renderer is showing. The list view is kept for one release (C7.2). */
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
