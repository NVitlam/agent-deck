/**
 * Agent Deck canvas — the layout engine. Pure geometry, and nothing else.
 *
 * This module is the arithmetic half of the FROZEN canvas design. Two
 * functions carry it:
 *
 *     deckLayout(sessions, layout, sort, viewportW) -> { id, x, y }[]
 *     treeLayout(state, rootId, { collapseDepth })  -> TreePlacement[]
 *
 * Three properties are normative, and every one of them is a constraint on
 * how the arithmetic below is allowed to be written:
 *
 *  - DETERMINISTIC. Same arguments in, identical numbers out. Nothing here
 *    reads a clock, a DOM node, a module-level cache, or any source of
 *    entropy. `deckLayout` takes the viewport WIDTH as an argument rather than
 *    measuring one, which is what keeps it a pure function of its inputs.
 *
 *  - INCREMENTAL. A spawn ADDS; it never reflows anything already placed. The
 *    tidy tree gets this from subtree widths: a node's own width is a function
 *    of its own text alone, and per-agent width is MONOTONIC (the store keeps
 *    `max(previous, current)`) so a finished tool call cannot shrink a box and
 *    shove its siblings. The predecessor canvas separated on a DRAWN RADIUS
 *    that grew with child count, so one new tool call moved cells already on
 *    screen. Nothing here may be a function of a drawn size.
 *
 *  - ANIMATION-FREE. Every number is a final position. Motion, if any, is the
 *    renderer's, and pan/zoom is an SVG TRANSFORM applied by `viewport.ts` to
 *    a wrapper group — never a coordinate edited here. That separation is what
 *    keeps these goldens valid as numbers while a user drags the view around.
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
 * Two letters, not `SessionState['engine']`'s `'cc' | 'opencode'`: the deck is
 * the design's vocabulary and the design says `oc`. {@link deckEngine} is the
 * one supported conversion, so the mapping exists once.
 */
export type DeckEngine = 'cc' | 'oc';

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

/** The three deck filters. */
export type DeckFilter = 'all' | 'cc' | 'oc';

/** Design default: grid. */
export const DEFAULT_DECK_LAYOUT: DeckLayoutMode = 'grid';
/** Design default: live first. */
export const DEFAULT_DECK_SORT: DeckSortMode = 'live';
/** Design default: all engines. */
export const DEFAULT_DECK_FILTER: DeckFilter = 'all';

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
  // rule and this function is the only place the webview restates it.
  return engine === 'opencode' ? 'oc' : 'cc';
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

/** Left edge of an engine's lane. */
export function deckLaneX(engine: DeckEngine): number {
  return engine === 'cc' ? 0 : DECK_CARD_W + DECK_LANE_GAP;
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

  const next: Record<DeckEngine, number> = { cc: 0, oc: 0 };
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
/** Node height. */
export const NODE_H = 52;
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

/** Characters of an agent label kept before the ellipsis. */
export const LABEL_MAX_CHARS = 19;

/** Horizontal pitch of the spawn dots drawn under a node. */
export const SPAWN_DOT_GAP = 13;
/** Spawn-dot row, relative to the node's own y. */
export const SPAWN_DOT_Y = NODE_H + 11;

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
  return Math.ceil(
    Math.max(
      NODE_W_MIN,
      nodeSubText(agent).length * SUB_ADVANCE + SUB_PAD,
      nodeLabelText(agent).length * LABEL_ADVANCE + LABEL_PAD,
    ),
  );
}

/** One placed node. */
export interface TreePlacement {
  id: string;
  x: number;
  y: number;
  /** Drawn width, from {@link nodeWidth} or the caller's monotonic override. */
  w: number;
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

  const own = new Map<string, number>();
  const subtree = new Map<string, number>();
  const out: TreePlacement[] = [];

  const drawnChildren = (agent: AgentNode, depth: number): AgentNode[] =>
    depth + 1 <= collapseDepth ? orderedChildAgents(state, agent.id) : [];

  const measure = (agent: AgentNode, depth: number): number => {
    const mine = widthOf(agent);
    own.set(agent.id, mine);
    const kids = drawnChildren(agent, depth);
    if (kids.length === 0) {
      subtree.set(agent.id, mine);
      return mine;
    }
    let span = SIBLING_GAP * (kids.length - 1);
    for (const kid of kids) span += measure(kid, depth + 1);
    const total = Math.max(mine, span);
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
        depth,
        collapsed: false,
        hidden: true,
        hiddenDescendants: 0,
      });
      bury(kid, depth + 1, x, y);
    }
  };

  const place = (agent: AgentNode, depth: number, x0: number): void => {
    const mine = own.get(agent.id) ?? widthOf(agent);
    const span = subtree.get(agent.id) ?? mine;
    const x = roundCoord(x0 + (span - mine) / 2);
    const y = roundCoord(depth * (NODE_H + LEVEL_GAP));
    const kids = drawnChildren(agent, depth);
    const suppressed = kids.length === 0 ? countDescendants(agent) : 0;
    out.push({
      id: agent.id,
      x,
      y,
      w: mine,
      depth,
      collapsed: suppressed > 0,
      hidden: false,
      hiddenDescendants: suppressed,
    });
    if (suppressed > 0) bury(agent, depth + 1, x, y);
    let cursor = x0;
    for (const kid of kids) {
      place(kid, depth + 1, cursor);
      cursor += (subtree.get(kid.id) ?? widthOf(kid)) + SIBLING_GAP;
    }
  };

  measure(root, 0);
  place(root, 0, 0);
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

/**
 * Where the `i`th spawn dot sits under a placed node.
 *
 * Centred on the node, pitched at {@link SPAWN_DOT_GAP}. The dot row is a
 * function of the tool COUNT, so it is drawn per render rather than pinned as
 * a placement — a node's own x never moves when a tool call arrives, which is
 * the incremental promise the row itself does not have to keep.
 */
export function spawnDotPos(
  node: Pick<TreePlacement, 'x' | 'y' | 'w'>,
  toolCount: number,
  index: number,
): { x: number; y: number } {
  const span = (toolCount - 1) * SPAWN_DOT_GAP;
  return {
    x: roundCoord(node.x + node.w / 2 - span / 2 + index * SPAWN_DOT_GAP),
    y: roundCoord(node.y + SPAWN_DOT_Y),
  };
}
