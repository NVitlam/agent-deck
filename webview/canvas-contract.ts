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
