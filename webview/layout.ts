/**
 * Agent Deck canvas — the layout engine. Pure geometry, and nothing else.
 *
 * This module is the arithmetic half of the FROZEN canvas design. Two
 * functions carry it:
 *
 *     deckLayout(sessions, layout, sort, viewportW) -> { id, x, y }[]
 *     treeLayout(state, rootId, { collapseDepth })  -> TreePlacement[]
 *
 * Two properties are normative, and both are constraints on how the arithmetic
 * below is allowed to be written:
 *
 *  - DETERMINISTIC. Same arguments in, identical numbers out. Nothing here
 *    reads a clock, a DOM node, a module-level cache, or any source of
 *    entropy. `deckLayout` takes the viewport WIDTH as an argument rather than
 *    measuring one, which is what keeps it a pure function of its inputs.
 *
 *  - ANIMATION-FREE. Every number is a final position. Motion, if any, is the
 *    renderer's, and pan/zoom is an SVG TRANSFORM applied by `viewport.ts` to
 *    a wrapper group — never a coordinate edited here. That separation is what
 *    keeps these goldens valid as numbers while a user drags the view around.
 *
 * NOT INCREMENTAL, AND THIS FILE USED TO CLAIM IT WAS. The claim read "A spawn
 * ADDS; it never reflows anything already placed", and it was FALSE for both
 * functions here. Measured through this module, esbuild-bundled, on the mock
 * tree `layout.test.ts` builds: adding one subagent under `a3` moves `main`
 * from `x=307.5` to `x=403.5` and `a3` from `x=521` to `x=617` — 2 of the 8
 * placed nodes. `layout.test.ts`'s "a spawn MOVES every ancestor" pins those
 * exact numbers.
 *
 *  - THE TREE re-centres. {@link treeLayout} places each parent over the middle
 *    of its children's total span, so a subtree that grows wider re-centres
 *    every ancestor up to the root. That is not a defect in the arithmetic; it
 *    IS the tidy tree the frozen design specifies, and no implementation of a
 *    centred parent can also be coordinate-stable under insertion. What does
 *    NOT move is anything outside the growing subtree's own ancestry: `a1`,
 *    `a1a`, `a2`, `a3a`, `a3aa` and `a3b` are byte-identical across the same
 *    spawn, which is the property the goldens and the width-override test pin.
 *
 *  - THE DECK re-places wholesale. {@link deckLayout} sorts and then assigns by
 *    ARRAY INDEX, so a session arriving anywhere but the end shifts every card
 *    after it by one slot. Measured: inserting one live session ahead of three
 *    others moves all three down 100 units in `list`.
 *
 * WHAT WAS TRADED, AND FOR WHAT. The predecessor canvas separated cells on a
 * DRAWN RADIUS that grew with child count, so one new tool call moved cells
 * already on screen for a reason the user could not see — a size channel
 * feeding back into position. Byte-identical coordinates under insertion were
 * the guard against that. The frozen design asked for a tidy tree instead, and
 * a tidy tree buys legibility (no crossing edges, no overlap, parents visibly
 * over their children) at the price of that stability. The guard that survives
 * is weaker but still real: **nothing here may be a function of a DRAWN SIZE.**
 * A node's own width is a function of its own text alone, and per-agent width
 * is MONOTONIC in the store (`max(previous, current)`), so a finished tool call
 * cannot shrink a box and shove its siblings. Motion is bounded by the design's
 * own arithmetic rather than by render feedback.
 *
 * THE REFERENCE. `webview/layout.reference.mjs` is the frozen design's own
 * implementation of the same arithmetic, and `layout.test.ts` pins this file
 * to the tables it prints. **This file must never import it.** Two independent
 * implementations agreeing is the whole evidence; a production module that
 * imported the reference would compare the reference against itself, pass
 * forever, and look exactly as green as a real pass.
 *
 * WHAT WAS DELETED. The phyllotaxis deck (the golden-angle spiral, `blobPath`,
 * `hashSessionId` seeds, `constellationPoints`, `sessionLayout`'s dot rings and
 * radius-driven separation) is GONE rather than deprecated, so every reader
 * breaks at compile time instead of silently drawing the superseded canvas.
 */

import type { AgentNode, SessionState, ToolNode } from '../src/model/events.js';
import { isAgentNode, isToolNode } from '../src/model/events.js';
import { EM_DASH } from './format.js';
import { findAgent, orderedChildAgents } from './tree.js';

/* ------------------------------------------------------------------------ *
 * Rounding
 * ------------------------------------------------------------------------ */

/** Decimal places kept on every emitted coordinate. */
export const COORD_DECIMALS = 3;

const COORD_FACTOR = 10 ** COORD_DECIMALS;

/** Round to {@link COORD_DECIMALS}, normalising `-0` to `0`. */
export function roundCoord(value: number): number {
  const rounded = Math.round(value * COORD_FACTOR) / COORD_FACTOR;
  // `-0` and `0` are `===` but not `Object.is`-equal, and JSON writes both as
  // `"0"`. Without this line a golden comparison fails on a sign no renderer
  // can express.
  return rounded === 0 ? 0 : rounded;
}

/** Three-way compare, so a sort key that can be `Infinity` never yields NaN. */
function cmp(a: number | string, b: number | string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------------ *
 * Deck geometry (altitude 0)
 * ------------------------------------------------------------------------ */

/** Session card width, in stage units. */
export const DECK_CARD_W = 220;
/** Session card height, in stage units. */
export const DECK_CARD_H = 88;
/** Horizontal gap between cards. */
export const DECK_GAP_X = 16;
/** Vertical gap between cards. */
export const DECK_GAP_Y = 12;
/**
 * Width the grid gives up before dividing into columns.
 *
 * It is the field's own inset, not a per-card margin, which is why it is
 * subtracted once rather than per column.
 */
export const DECK_GRID_MARGIN = 24;
/** Clear space between the two engine lanes, on top of the card width. */
export const DECK_LANE_GAP = 40;
/** Where a lane header sits, relative to the first card in the lane. */
export const DECK_LANE_HEADER_Y = -28;

/**
 * The deck's engine tag.
 *
 * Two letters, not `SessionState['engine']`'s `'cc' | 'opencode' | 'codex'`:
 * the deck is the design's vocabulary and the design says `oc`/`cx`.
 * {@link deckEngine} is the one supported conversion, so the mapping exists
 * once. `cx` is the Codex engine (v0.6.0 Phase 3).
 */
export type DeckEngine = 'cc' | 'oc' | 'cx';

/**
 * What a card says about itself.
 *
 * `degraded` is here and is NOT a value of `SessionState.liveness` — it is the
 * hook tap's health, which arrives on its own message. The deck ranks it
 * between `idle` and `unsupported` because a degraded session is still being
 * observed, just less well.
 */
export type DeckStatus = 'live' | 'idle' | 'degraded' | 'unsupported' | 'ended';

/** The three deck layouts. */
export type DeckLayoutMode = 'list' | 'grid' | 'lanes';

/** The three deck sorts. */
export type DeckSortMode = 'live' | 'recent' | 'engine';

/*
 * THE ENGINE FILTER IS NOT DECLARED HERE. It was — as `DeckFilter`, which
 * `canvas-contract.ts` also declared, meaning a liveness. Two meanings, one
 * name, one package, and nothing failed because neither module imported the
 * other. Both axes are now `EngineFilter` and `LivenessFilter` in
 * `canvas-contract.ts`, one definition each; this module has no use for either,
 * because filtering happens before `deckLayout` is called.
 */

/** Design default: grid. */
export const DEFAULT_DECK_LAYOUT: DeckLayoutMode = 'grid';
/** Design default: live first. */
export const DEFAULT_DECK_SORT: DeckSortMode = 'live';

/** Sort rank for {@link DeckStatus}. Lower sorts first. */
export const DECK_STATUS_RANK: Readonly<Record<DeckStatus, number>> = {
  live: 0,
  idle: 1,
  degraded: 2,
  unsupported: 3,
  ended: 4,
};

/** Sort rank for {@link DeckEngine}. Lower sorts first. */
export const DECK_ENGINE_RANK: Readonly<Record<DeckEngine, number>> = {
  cc: 0,
  oc: 1,
  cx: 2,
};

/**
 * What the deck needs to know about a session. Deliberately NOT `SessionState`.
 *
 * `last` is a last-event time and ONLY ITS ORDERING MATTERS — nothing here
 * subtracts it from a clock, which is what lets the goldens be deterministic
 * without one.
 */
export interface DeckSession {
  id: string;
  engine: DeckEngine;
  status: DeckStatus;
  /** Last event time. Compared, never differenced against `now`. */
  last: number;
}

/** Where one card goes. Rounded to {@link COORD_DECIMALS}. */
export interface DeckPlacement {
  id: string;
  x: number;
  y: number;
}

/** The one supported way to put `SessionState.engine` on the deck. */
export function deckEngine(engine: SessionState['engine']): DeckEngine {
  // Absence reads as `'cc'`; `src/model/events.ts` is the authority for that
  // rule and this function is the only place the webview restates it. A
  // three-way `switch` rather than a chained ternary on purpose: the ternary
  // this replaced read `engine === 'opencode' ? 'oc' : 'cc'`, so ANY value
  // that was not `'opencode'` — including `'codex'` — silently fell into
  // `'cc'`. That is the exact silent-default shape this repository's own
  // notes warn about; the `default` branch below still exists (absence and
  // `'cc'` both take it), but `'codex'` now has its own case rather than
  // sharing the fallback with "nothing was said at all".
  switch (engine) {
    case 'opencode':
      return 'oc';
    case 'codex':
      return 'cx';
    default:
      return 'cc';
  }
}

/** Every node in a session tree — agents and tools, root included. */
export function countNodes(state: SessionState): number {
  let total = 0;
  const visit = (node: AgentNode | ToolNode): void => {
    total += 1;
    if (isAgentNode(node)) for (const child of node.children) visit(child);
  };
  visit(state.root);
  return total;
}

/** The one supported way to put a `SessionState` on the deck. */
export function toDeckSession(state: SessionState, last: number): DeckSession {
  return {
    id: state.sessionId,
    engine: deckEngine(state.engine),
    status: state.liveness,
    last,
  };
}

/**
 * The three sorts.
 *
 * EVERY ONE ENDS ON THE SESSION ID, and that is the whole determinism story:
 * two sessions with the same status and the same last-event time have exactly
 * one order, on every machine, on every render.
 */
const DECK_SORTERS: Readonly<
  Record<DeckSortMode, (a: DeckSession, b: DeckSession) => number>
> = {
  live: (a, b) =>
    cmp(DECK_STATUS_RANK[a.status], DECK_STATUS_RANK[b.status]) ||
    cmp(b.last, a.last) ||
    cmp(a.id, b.id),
  recent: (a, b) => cmp(b.last, a.last) || cmp(a.id, b.id),
  engine: (a, b) =>
    cmp(DECK_ENGINE_RANK[a.engine], DECK_ENGINE_RANK[b.engine]) ||
    DECK_SORTERS.live(a, b),
};

/** The visible set in draw order. Never mutates the argument. */
export function sortDeckSessions(
  sessions: readonly DeckSession[],
  sort: DeckSortMode,
): DeckSession[] {
  return [...sessions].sort(DECK_SORTERS[sort]);
}

/** Columns the grid layout uses at a given stage-unit viewport width. */
export function deckColumns(viewportW: number): number {
  return Math.max(
    1,
    Math.floor((viewportW - DECK_GRID_MARGIN) / (DECK_CARD_W + DECK_GAP_X)),
  );
}

/**
 * Left edge of an engine's lane.
 *
 * `DECK_ENGINE_RANK[engine] * (DECK_CARD_W + DECK_LANE_GAP)` — a fixed slot
 * per engine, ordered by rank, rather than the binary `engine === 'cc' ? 0 :
 * DECK_CARD_W + DECK_LANE_GAP` this replaced. At `cc: 0, oc: 1` that formula
 * reduces to exactly the old expression (`0` and `DECK_CARD_W + DECK_LANE_GAP`
 * respectively), so the two deck-engine goldens are unaffected; `cx: 2` gets
 * the next slot at `2 * (DECK_CARD_W + DECK_LANE_GAP)`.
 *
 * **Known consequence, not fixed here.** With three possible lanes, a session
 * mix that holds the two OUTER engines (`cc` and `cx`) but not the middle one
 * (`oc`) leaves a visible gap where `oc`'s slot would sit — `deckLanesDegrade`
 * only collapses to `list` when FEWER THAN TWO engines are present, and two
 * of three present is not that case. The two-engine design could never
 * produce this shape (either both lanes were populated or the single one
 * degraded to `list`), so it is a genuinely new case rather than a regression.
 * Compacting lanes to the PRESENT set rather than the full rank would need
 * `deckLaneX` to see the whole visible set, not just one engine, which is a
 * bigger change than this phase's brief authorizes — recorded rather than
 * silently worked around; see the design amendment for the same note.
 */
export function deckLaneX(engine: DeckEngine): number {
  return DECK_ENGINE_RANK[engine] * (DECK_CARD_W + DECK_LANE_GAP);
}

/**
 * True when `lanes` must render as `list`.
 *
 * A lane with nothing in it is a column of empty space the user has to read as
 * meaning something, so a visible set holding one engine degrades to the list.
 * Stated as its own predicate because the renderer needs the same answer to
 * decide whether to draw lane headers at all.
 */
export function deckLanesDegrade(sessions: readonly DeckSession[]): boolean {
  const engines = new Set<DeckEngine>();
  for (const s of sessions) engines.add(s.engine);
  return engines.size < 2;
}

/**
 * Place every session card.
 *
 * `viewportW` is in STAGE UNITS — viewport pixels divided by the zoom scale.
 * `viewport.ts:viewportWidthInStageUnits` is the conversion; passing raw
 * pixels while zoomed would re-column the grid on every wheel notch.
 */
export function deckLayout(
  sessions: readonly DeckSession[],
  layout: DeckLayoutMode,
  sort: DeckSortMode,
  viewportW: number,
): DeckPlacement[] {
  const sorted = sortDeckSessions(sessions, sort);

  const asList = (): DeckPlacement[] =>
    sorted.map((s, i) => ({
      id: s.id,
      x: 0,
      y: roundCoord(i * (DECK_CARD_H + DECK_GAP_Y)),
    }));

  if (layout === 'list') return asList();

  if (layout === 'grid') {
    const cols = deckColumns(viewportW);
    return sorted.map((s, i) => ({
      id: s.id,
      x: roundCoord((i % cols) * (DECK_CARD_W + DECK_GAP_X)),
      y: roundCoord(Math.floor(i / cols) * (DECK_CARD_H + DECK_GAP_Y)),
    }));
  }

  if (deckLanesDegrade(sorted)) return asList();

  const next: Record<DeckEngine, number> = { cc: 0, oc: 0, cx: 0 };
  return sorted.map((s) => ({
    id: s.id,
    x: deckLaneX(s.engine),
    y: roundCoord(next[s.engine]++ * (DECK_CARD_H + DECK_GAP_Y)),
  }));
}

/* ------------------------------------------------------------------------ *
 * Tree geometry (altitude 1) — the tidy tree
 * ------------------------------------------------------------------------ */

/**
 * MINIMUM node width. Not the width: see {@link nodeWidth}.
 *
 * Design amendment A1.1. The wide thing on the canvas is the TEXT, not the
 * box — a label runs to twenty-odd characters against a box 168 wide — so a
 * layout that separated on the box would produce clear space between boxes and
 * labels written straight through each other.
 */
export const NODE_W_MIN = 168;
/**
 * Node height with a ONE-LINE label — the minimum, and the parked rail's fixed
 * item height.
 *
 * §2.3 said "node size is fixed", and A9.2 amends it: a box grows DOWNWARD to
 * fit a label that wrapped. The thing §2.3 was guarding against is untouched —
 * it warned that size must not vary with TOKEN SHARE, because a value that
 * changes every few seconds driving a size that drives a position is render
 * feedback. A label is written once when the agent is grafted and never moves
 * again, so it cannot feed back.
 */
export const NODE_H = 52;

/**
 * Node height with a TWO-LINE label (A9.2): one more 18-unit line.
 *
 * Row 1 sits at baseline 21 and row 2 at 37, so the sub-text row moves from
 * baseline 38 to 56 and the box from 52 to 70. `AgentCell.svelte` reads those
 * baselines off {@link labelLines}'s length rather than duplicating the rule.
 */
export const NODE_H_TWO_LINE = 70;

/** Rows a wrapped label may occupy. Past this, the rest is read on hover. */
export const LABEL_MAX_LINES = 2;
/** Vertical clear space between one depth and the next. */
export const LEVEL_GAP = 112;
/** Horizontal clear space between sibling SUBTREES. */
export const SIBLING_GAP = 24;

/**
 * Nominal advance of the row-2 font (mono 10.5 px), in stage units per
 * character.
 *
 * A CONSTANT, not a measurement. `measureText` is forbidden inside
 * {@link treeLayout}: it needs a DOM, it differs by machine and by installed
 * fonts, and a golden that depends on it cannot reproduce anywhere else.
 * Overshoot on narrow glyphs is accepted; the failure it prevents (text
 * overlapping text) is the one a user can see.
 */
export const SUB_ADVANCE = 6.3;

/** Nominal mean advance of the row-1 font (sans 600, 12 px). Also a constant. */
export const LABEL_ADVANCE = 7.0;

/** Fixed chrome either side of the row-2 text. */
export const SUB_PAD = 26;
/** Fixed chrome either side of the row-1 text (status chip, badge). */
export const LABEL_PAD = 64;

/**
 * Widest a node box may be drawn — design amendment A9.2.
 *
 * A1.1 grows a box with its label, and before this cap a long label grew the
 * box instead of wrapping, which is half of why a rank of 15 spanned 3,453
 * units. Past the cap the label WRAPS (see {@link labelLines}) and the box
 * grows DOWNWARD instead, which is the direction there is room in.
 */
export const NODE_W_MAX = 264;

/**
 * Characters of an agent label kept before the ellipsis.
 *
 * **NOT USED FOR DISPLAY SINCE A9.1**, which removed every ellipsis from every
 * surface: a label now wraps to two rows and anything past that is read on
 * hover. Kept only because `design.md` §2.3's frozen node-width table quotes it
 * and `nodeWidth` still measures the FIRST line against it, and removing a
 * constant two frozen tables are written against buys nothing.
 */
export const LABEL_MAX_CHARS = 19;

/** Horizontal pitch of the spawn dots drawn under a node. */
/**
 * More than this many drawn children and the rank WRAPS — design amendment A8.4.
 *
 * A rank of 15 spans 3,453 stage units and needs `k = 0.329` to fit a 1,200 px
 * panel; §3.4 floors the tree at `0.4x`, so before this the rank could not be
 * framed at all. Measured on `webview/wire/synthetic-wide-rank.json`.
 */
export const WRAP_AT = 8;

/**
 * Vertical gap between two rows of one wrapped rank — A8.4, `LEVEL/2`.
 *
 * Derived rather than written down twice: half a level is what makes a wrapped
 * rank read as one rank in two rows instead of as two ranks.
 */
export const ROW_GAP = LEVEL_GAP / 2;

/* THE SPAWN-DOT ROW IS GONE - design amendment A8.1.
   `SPAWN_DOT_GAP`, `SPAWN_DOT_Y` and `spawnDotPos` were exported from here
   until 2026-08-29. Nothing draws a dot any more, so nothing here computes
   one. `layout.reference.mjs` keeps its own `dotPos` for ONE reason, stated
   at that declaration: the frozen design.md section 7 tables carry spawn-dot
   columns and must keep reproducing byte-for-byte as a regression guard on
   the layout arithmetic. That is history, not a second implementation of a
   live feature. */

/** The depth the `K` key, and the auto-collapse rule, collapse to. */
export const COLLAPSE_DEPTH = 2;

/**
 * Above this many VISIBLE nodes the renderer collapses to
 * {@link COLLAPSE_DEPTH} on its own and says so in the status line.
 *
 * Strictly greater: 300 renders whole, 301 collapses. {@link autoCollapseDepth}
 * is the single implementation, exported so the renderer and the perf budget
 * ask the same function rather than each spelling the comparison.
 */
export const AUTO_COLLAPSE_NODES = 300;

/**
 * Compact token figure: `184.3k`, `1.2M`, `400`.
 *
 * `undefined` yields {@link EM_DASH} — never `0`. An engine that does not
 * report a figure leaves the field UNSET, and printing `0` would claim the
 * session spent nothing. `format.ts:formatTokens` is the thousands-separated
 * form for surfaces with room; this is the one that fits on a node row, and
 * the node row's WIDTH is derived from its length, so the two cannot be
 * swapped without moving every golden.
 */
export function formatCompactTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return EM_DASH;
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Row-1 text: the label, truncated at {@link LABEL_MAX_CHARS}. */
export function truncateLabel(label: string): string {
  return label.length > LABEL_MAX_CHARS
    ? `${label.slice(0, LABEL_MAX_CHARS - 1)}…`
    : label;
}

/** The tool children of an agent, in `children` order. */
export function toolChildren(agent: AgentNode): ToolNode[] {
  return agent.children.filter(isToolNode);
}

/** Row-1 string, as rendered. */
export function nodeLabelText(agent: AgentNode): string {
  return truncateLabel(agent.label);
}

/**
 * Row-2 string, as rendered: the token figure, the call count, and the running
 * count when there is one.
 *
 * The token figure is `burn.prompt + burn.output` — design amendment A6.
 * BURN, not `contextNow`, and the choice is load-bearing twice over: burn is
 * the total a node row is asking about, and it is the field that keeps this
 * string's length where the frozen widths were measured. `contextNow` is a
 * LEVEL and belongs to the session header.
 */
export function nodeSubText(agent: AgentNode): string {
  const tools = toolChildren(agent);
  const running = tools.filter((t) => t.status === 'running').length;
  const burn = agent.burn;
  const tokens =
    burn === undefined
      ? EM_DASH
      : formatCompactTokens(burn.prompt + burn.output);
  const tail = running > 0 ? ` · ${running} running` : '';
  return `${tokens} · ${tools.length} calls${tail}`;
}

/**
 * A node's drawn width — design amendment A1.1.
 *
 * PURE, and a function of CHARACTER COUNTS with fixed advances. It is
 * monotonic per agent in the STORE, not here: the store keeps
 * `max(previousWidth, nodeWidth(agent))` so a completed tool call cannot
 * shrink a box mid-session. This function stays memoryless — it consumes an
 * agent and returns a width, and knows nothing about what it returned before.
 */
export function nodeWidth(agent: AgentNode): number {
  return Math.min(
    NODE_W_MAX,
    Math.ceil(
      Math.max(
        NODE_W_MIN,
        nodeSubText(agent).length * SUB_ADVANCE + SUB_PAD,
        nodeLabelText(agent).length * LABEL_ADVANCE + LABEL_PAD,
      ),
    ),
  );
}

/**
 * How many characters of label fit on ONE line of a box `width` wide.
 *
 * `LABEL_PAD` is the same allowance A1.1's width formula uses — the two side
 * insets plus the depth marker on row 1's right — so this function and
 * {@link nodeWidth} are the same equation solved for different unknowns. That
 * is what makes wrapping impossible below the cap: a label short enough not to
 * hit {@link NODE_W_MAX} produces a box wide enough to hold it on one line.
 */
export function labelCharsPerLine(width: number): number {
  return Math.max(1, Math.floor((width - LABEL_PAD) / LABEL_ADVANCE));
}

/**
 * A node's label, wrapped to at most {@link LABEL_MAX_LINES} rows — A9.1.
 *
 * PURE, greedy, on word boundaries, with a hard split for a single word longer
 * than a line. Deterministic in the way everything in this module has to be:
 * same label and same width in, identical rows out, no DOM measurement.
 *
 * **Nothing is marked with an ellipsis.** A9.1 removed every `…` from every
 * surface, so a label too long for two rows is simply not all here, and the
 * FULL string is carried to the reader on hover — `AgentCell.svelte` puts it in
 * an SVG `<title>` and sets `data-label-clipped`, so "there is more" is a fact
 * a test can assert rather than a glyph a user has to interpret.
 */
export function labelLines(label: string, width: number): string[] {
  const perLine = labelCharsPerLine(width);
  // Break on whitespace AND after a hyphen, keeping the hyphen on the line it
  // ends. Agent labels in this product are overwhelmingly hyphenated slugs —
  // `readme-guard-rederive`, `privacy-sweep-audit` — so a splitter that only
  // knew about spaces would hard-split every one of them mid-word.
  const words = label.split(/(?<=-)|\s+/u).filter((w) => w !== '');
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (lines.length === LABEL_MAX_LINES) break;
    // Join with a space UNLESS the previous piece already ends in the hyphen
    // it was split on — `test-` + `runner` is `test-runner`, not `test- runner`.
    const candidate =
      current === '' ? word : current.endsWith('-') ? `${current}${word}` : `${current} ${word}`;
    if (candidate.length <= perLine) {
      current = candidate;
      continue;
    }
    if (current !== '') {
      lines.push(current);
      current = '';
      if (lines.length === LABEL_MAX_LINES) break;
    }
    // A single word wider than the line: hard-split it rather than leaving a
    // row empty. Splitting mid-word is ugly and it is honest; a blank row
    // beside a too-long word reads as a rendering bug.
    let rest = word;
    while (rest.length > perLine && lines.length < LABEL_MAX_LINES) {
      lines.push(rest.slice(0, perLine));
      rest = rest.slice(perLine);
    }
    current = lines.length === LABEL_MAX_LINES ? '' : rest;
  }
  if (current !== '' && lines.length < LABEL_MAX_LINES) lines.push(current);
  return lines.length === 0 ? [''] : lines;
}

/** Whether {@link labelLines} could not show all of `label` (A9.1). */
export function labelIsClipped(label: string, width: number): boolean {
  const shown = labelLines(label, width).join(' ');
  return shown.replace(/\s+/gu, ' ').trim() !== label.replace(/\s+/gu, ' ').trim();
}

/**
 * A node's drawn height: one line or two — A9.2.
 *
 * A function of the agent alone, like {@link nodeWidth}, so the layout stays a
 * pure function of the tree.
 */
export function nodeHeight(agent: AgentNode): number {
  return labelLines(agent.label, nodeWidth(agent)).length > 1
    ? NODE_H_TWO_LINE
    : NODE_H;
}

/** One placed node. */
export interface TreePlacement {
  id: string;
  x: number;
  y: number;
  /** Drawn width, from {@link nodeWidth} or the caller's monotonic override. */
  w: number;
  /**
   * Drawn HEIGHT — {@link NODE_H} or {@link NODE_H_TWO_LINE} (A9.2).
   *
   * On the placement rather than re-derived by each consumer, for the reason
   * `w` is: `AgentCell`, the filament's anchor, the fit's extents and the
   * goldens must all agree on one number, and four derivations of one value is
   * the seam this package has already paid for twice.
   */
  h: number;
  depth: number;
  /** Has children that are deliberately not drawn: render a `+N` badge. */
  collapsed: boolean;
  /** Inside a collapsed subtree, so not drawn at all. */
  hidden: boolean;
  /** Descendants suppressed beneath this node. 0 unless `collapsed`. */
  hiddenDescendants: number;
}

export interface TreeLayoutOptions {
  /**
   * Deepest depth whose CHILDREN are drawn. `Infinity` (the default) draws
   * everything; `2` is what the `K` key and the auto-collapse rule set.
   */
  collapseDepth?: number;
  /**
   * Per-agent width override, so the store can enforce monotonicity without
   * this function remembering anything. Missing ids fall back to
   * {@link nodeWidth}.
   */
  widths?: ReadonlyMap<string, number>;
}

/**
 * Lay out the agent tree beneath `rootId` — a simple tidy tree, the
 * subtree-width variant of Reingold-Tilford with no contour threading.
 *
 * Subtrees cannot overlap because every parent is centred over the SUM of its
 * children's widths plus the gaps between them, so the horizontal extent a
 * subtree claims is exactly the extent it occupies.
 *
 * THAT CENTRING IS ALSO WHY THIS IS NOT INCREMENTAL. A subtree that gains a
 * node claims more extent, so its parent's centre moves, so ITS parent's centre
 * moves, all the way to the root. Nodes outside the growing subtree's ancestry
 * do not move. See the module header for the measured numbers.
 *
 * Order is pre-order depth first, which is also draw order. Hidden nodes are
 * returned too, positioned at the collapsed ancestor that swallowed them, so a
 * caller can count them, animate an expansion out of the badge, or filter them
 * out with `hidden === false` — but never has to guess that they exist.
 */
export function treeLayout(
  state: SessionState,
  rootId: string,
  options: TreeLayoutOptions = {},
): TreePlacement[] {
  const collapseDepth = options.collapseDepth ?? Number.POSITIVE_INFINITY;
  const overrides = options.widths;
  const root = findAgent(state.root, rootId);
  if (root === undefined) return [];

  const widthOf = (agent: AgentNode): number =>
    overrides?.get(agent.id) ?? nodeWidth(agent);
  /** Height follows the width, because wrapping does (A9.2). */
  const heightOf = (agent: AgentNode): number =>
    labelLines(agent.label, widthOf(agent)).length > 1 ? NODE_H_TWO_LINE : NODE_H;

  const own = new Map<string, number>();
  const subtree = new Map<string, number>();
  /** Per parent: the shared column widths its children's grid uses (A8.4). */
  const columns = new Map<string, number[]>();
  /** Per parent: how many rows its children occupy. 1 unless the rank wrapped. */
  const childRows = new Map<string, number>();
  /** Per agent: the depth it was measured at, so rank heights can be summed. */
  const depthOf = new Map<string, number>();
  /**
   * Tallest node at each depth (A9.2). A rank is as tall as its tallest box,
   * so every row in it shares one baseline — a rank whose rows were each their
   * own height would step up and down across the screen for no reason a reader
   * could see.
   */
  const tallestAt = new Map<number, number>();
  const out: TreePlacement[] = [];

  const drawnChildren = (agent: AgentNode, depth: number): AgentNode[] =>
    depth + 1 <= collapseDepth ? orderedChildAgents(state, agent.id) : [];

  /**
   * Measure, with A8.4's wrap.
   *
   * COLUMNS ARE SHARED ACROSS ROWS, and that is the part "rows of 8" does not
   * say on its own: column `c` is as wide as the widest subtree in column `c`
   * over every row, and each row uses the same grid. Without it a row-1 child
   * could sit directly above a row-0 child's descendants — two subtrees in one
   * x range at one depth, which is the single thing the tidy tree exists to
   * make impossible.
   *
   * At `kids.length <= WRAP_AT` there is one column per child and the grid is
   * `Σ widths + SIB·(n−1)` exactly as before, which is why every frozen §7
   * table reproduces byte-for-byte.
   */
  const measure = (agent: AgentNode, depth: number): number => {
    const mine = widthOf(agent);
    own.set(agent.id, mine);
    depthOf.set(agent.id, depth);
    tallestAt.set(depth, Math.max(tallestAt.get(depth) ?? NODE_H, heightOf(agent)));
    const kids = drawnChildren(agent, depth);
    if (kids.length === 0) {
      subtree.set(agent.id, mine);
      return mine;
    }
    const widths = kids.map((kid) => measure(kid, depth + 1));
    const cols = Math.min(WRAP_AT, kids.length);
    const colWidths = new Array<number>(cols).fill(0);
    widths.forEach((w, i) => {
      const c = i % cols;
      colWidths[c] = Math.max(colWidths[c] ?? 0, w);
    });
    const grid =
      colWidths.reduce((sum, w) => sum + w, 0) + SIBLING_GAP * (cols - 1);
    columns.set(agent.id, colWidths);
    childRows.set(agent.id, Math.ceil(kids.length / cols));
    const total = Math.max(mine, grid);
    subtree.set(agent.id, total);
    return total;
  };

  const countDescendants = (agent: AgentNode): number => {
    let n = 0;
    for (const kid of orderedChildAgents(state, agent.id)) {
      n += 1 + countDescendants(kid);
    }
    return n;
  };

  const bury = (agent: AgentNode, depth: number, x: number, y: number): void => {
    for (const kid of orderedChildAgents(state, agent.id)) {
      out.push({
        id: kid.id,
        x,
        y,
        w: widthOf(kid),
        h: heightOf(kid),
        depth,
        collapsed: false,
        hidden: true,
        hiddenDescendants: 0,
      });
      bury(kid, depth + 1, x, y);
    }
  };

  const place = (agent: AgentNode, depth: number, x0: number, row: number): void => {
    const mine = own.get(agent.id) ?? widthOf(agent);
    const span = subtree.get(agent.id) ?? mine;
    const x = roundCoord(x0 + (span - mine) / 2);
    const rankH = tallestAt.get(depth) ?? NODE_H;
    const y = roundCoord(rankTop(depth) + row * (rankH + ROW_GAP));
    const kids = drawnChildren(agent, depth);
    const suppressed = kids.length === 0 ? countDescendants(agent) : 0;
    out.push({
      id: agent.id,
      x,
      y,
      w: mine,
      h: heightOf(agent),
      depth,
      collapsed: suppressed > 0,
      hidden: false,
      hiddenDescendants: suppressed,
    });
    if (suppressed > 0) bury(agent, depth + 1, x, y);
    if (kids.length === 0) return;

    const colWidths = columns.get(agent.id) ?? [];
    const cols = colWidths.length;
    const grid =
      colWidths.reduce((sum, w) => sum + w, 0) + SIBLING_GAP * (cols - 1);
    for (let start = 0, r = 0; start < kids.length; start += cols, r += 1) {
      const inRow = kids.slice(start, start + cols);
      const rowWidth =
        inRow.reduce((sum, _kid, i) => sum + (colWidths[i] ?? 0), 0) +
        SIBLING_GAP * (inRow.length - 1);
      // CENTRED IN THE GRID, never in `span`. With one row `rowWidth === grid`
      // so this is `x0` exactly, which is what keeps every frozen §7 table
      // byte-identical; centring in `span` instead would shift a narrow rank
      // under a wide parent and move coordinates nobody asked to move.
      let cursor = x0 + (grid - rowWidth) / 2;
      inRow.forEach((kid, i) => {
        const colWidth = colWidths[i] ?? 0;
        const kidSpan = subtree.get(kid.id) ?? widthOf(kid);
        place(kid, depth + 1, cursor + (colWidth - kidSpan) / 2, r);
        cursor += colWidth + SIBLING_GAP;
      });
    }
  };

  measure(root, 0);

  /**
   * How many rows the nodes AT each depth occupy, and therefore where each rank
   * starts — A8.4's "every depth below a wrapped rank shifts down by the extra
   * rows". With no wrap anywhere every rank is one row and `rankTop(d)`
   * reduces to `d · (NH + LEVEL)`, the expression this replaced.
   */
  const rowsAtDepth = new Map<number, number>([[0, 1]]);
  for (const [id, rows] of childRows) {
    const depth = (depthOf.get(id) ?? 0) + 1;
    rowsAtDepth.set(depth, Math.max(rowsAtDepth.get(depth) ?? 1, rows));
  }
  const rankTops = new Map<number, number>([[0, 0]]);
  const rankTop = (depth: number): number => {
    const known = rankTops.get(depth);
    if (known !== undefined) return known;
    const above = rankTop(depth - 1);
    const rows = rowsAtDepth.get(depth - 1) ?? 1;
    const tall = tallestAt.get(depth - 1) ?? NODE_H;
    const value = above + rows * tall + (rows - 1) * ROW_GAP + LEVEL_GAP;
    rankTops.set(depth, value);
    return value;
  };

  place(root, 0, 0, 0);
  return out;
}

/** Nodes {@link treeLayout} would actually draw at a given collapse depth. */
export function visibleNodeCount(
  state: SessionState,
  rootId: string,
  collapseDepth: number = Number.POSITIVE_INFINITY,
): number {
  const root = findAgent(state.root, rootId);
  if (root === undefined) return 0;
  const walk = (agent: AgentNode, depth: number): number => {
    if (depth + 1 > collapseDepth) return 1;
    let n = 1;
    for (const kid of orderedChildAgents(state, agent.id)) {
      n += walk(kid, depth + 1);
    }
    return n;
  };
  return walk(root, 0);
}

/**
 * The collapse depth the renderer must use before it has been told otherwise.
 *
 * The ONE implementation of the >300 rule. Exported so the renderer and the
 * perf budget call the same function instead of each spelling the comparison —
 * two places stating one rule is how they come to disagree.
 */
export function autoCollapseDepth(state: SessionState, rootId: string): number {
  return visibleNodeCount(state, rootId) > AUTO_COLLAPSE_NODES
    ? COLLAPSE_DEPTH
    : Number.POSITIVE_INFINITY;
}
