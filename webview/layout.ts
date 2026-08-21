/**
 * Agent Deck canvas — the layout engine. Pure geometry, and nothing else.
 *
 * C7.5 of `agent-deck-spec.md` is the law this file implements:
 *
 *     deckLayout(sessions)                      -> { sessionId, x, y, R }[]
 *     blobPath(x, y, R, seed = hash(sessionId)) -> SVG path data
 *     sessionLayout(session)                    -> { cells, dots, elided }
 *
 * Three properties are normative, and every one of them is a constraint on how
 * the arithmetic below is allowed to be written:
 *
 *  - DETERMINISTIC. Same state in, identical numbers out. Nothing here reads a
 *    clock, a viewport size, a module-level cache, or any source of entropy.
 *    Every value returned is a function of the arguments alone. That is why
 *    this module imports only `./canvas-contract.js` and `../src/model/events.js`,
 *    both of which import nothing at all — the allowed set is closed, and
 *    `layout.test.ts` asserts it against this file's own source text rather
 *    than by observing calls it happened to make.
 *
 *  - INCREMENTAL. A spawn ADDS; it never reflows. Every coordinate is a
 *    function of a node's ABSOLUTE INDEX among its siblings, never of the
 *    sibling COUNT. That distinction is the whole trick: "spread n dots evenly
 *    around a circle" moves all n every time one arrives, while "put dot i at
 *    slot i" moves nothing, ever. The same rule is why a cell's centre is
 *    computed from the dot ring's fixed geometry and NOT from its parent's
 *    membrane radius R — R grows with content, so anchoring to it would let a
 *    new tool call shove every descendant sideways.
 *
 *  - ANIMATION-FREE. Motion is CSS transform/opacity on `fill-box` origins and
 *    never touches these numbers, so an animation cannot destabilise a golden.
 *    Nothing here is aware that animation exists.
 *
 * WHAT R IS ALLOWED TO DO. The incremental promise is POSITIONAL: x and y of
 * an already-placed id are byte-identical forever. R is deliberately not, and
 * cannot be — C7.1 states blob size derives from `log(nodeCount)`, so size IS
 * a function of content by design. The blast radius is kept to one node: a
 * cell's R is derived from that agent's DIRECT child count only, so adding a
 * tool call under agent A changes A's R and nothing else's — not its parent's,
 * not its siblings', not its own children's. `layout.test.ts` pins exactly
 * that, id by id.
 *
 * WHY THE DOT CAP DOES NOT BREAK INCREMENTALITY. {@link DOT_CAP} keeps the LAST
 * 48 dots because what is happening now is at the end, so the visible span
 * slides as tool calls arrive. Slots are assigned by absolute index and repeat
 * with a period of {@link DOT_SLOT_PERIOD}, which is >= `DOT_CAP`: any two
 * dots that can be visible at the same time differ in index by less than the
 * cap, therefore by less than the period, therefore they occupy different
 * slots. A surviving dot keeps the coordinates it had before the span moved.
 *
 * A TOOL ID IS NOT UNIQUE ACROSS A TREE. `SessionLayout.dots` is keyed by tool
 * id because C7.5 writes it that way, and a committed fixture carries the same
 * `tool_use` id in a main transcript and in a subagent's — the shape that makes
 * a join ambiguous in the first place. So `dots.size` can be LOWER than the
 * number of tool nodes on screen. The first writer in traversal order keeps the
 * dot, because last-writer-wins would let a newly arrived subtree move a dot
 * that is already placed. See the note at the dot loop.
 *
 * FLOATING POINT. `Math.cos`, `Math.sin` and `Math.log` are permitted by
 * ECMA-262 to differ in the last few ulps between engines, so raw results are
 * not safe to pin as goldens. Every number that leaves this module is rounded
 * to {@link COORD_DECIMALS} places, which is ~10 orders of magnitude coarser
 * than that error. Negative zero is normalised to zero: `JSON.stringify(-0)`
 * is `"0"`, so a golden round trip turns `-0` into `0` and a strict comparison
 * would fail on a difference no one can see.
 */

import type { AgentNode, SessionState, ToolNode } from '../src/model/events.js';
import { isAgentNode } from '../src/model/events.js';
import type {
  CellPlacement,
  DeckPlacement,
  DotPlacement,
  SessionLayout,
} from './canvas-contract.js';
import { DOT_CAP } from './canvas-contract.js';

/* ------------------------------------------------------------------------ *
 * Rounding
 * ------------------------------------------------------------------------ */

/** Decimal places kept on every emitted coordinate. See the header. */
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

/** The shortest round-trip decimal text for a rounded coordinate. */
function coordText(value: number): string {
  return String(roundCoord(value));
}

/* ------------------------------------------------------------------------ *
 * Deck geometry (altitude 0)
 * ------------------------------------------------------------------------ */

/**
 * The golden angle, in radians: `pi * (3 - sqrt(5))`.
 *
 * Phyllotaxis placement is chosen for one reason and it is the incremental
 * property, not aesthetics: blob `i` depends on `i` alone, so appending a
 * session leaves every earlier session exactly where it was. A grid packer or
 * anything that balances the field would re-place all of them.
 */
export const GOLDEN_ANGLE_RAD = Math.PI * (3 - Math.sqrt(5));

/** Distance multiplier for the phyllotaxis spiral: radius = PITCH * sqrt(i). */
export const DECK_PITCH = 132;

/** Blob radius floor, for a session with no nodes at all. */
export const DECK_RADIUS_MIN = 18;

/** Blob radius gain per natural log of node count (C7.1: size from log). */
export const DECK_RADIUS_SCALE = 13;

/** Blob radius ceiling. A single enormous session must not eat the deck. */
export const DECK_RADIUS_MAX = 68;

/**
 * What the deck needs to know about a session. Deliberately NOT `SessionState`.
 *
 * `nodeCount` is a required field rather than something derived inside
 * `deckLayout`, so a caller cannot pass a `SessionState` by accident and get a
 * silently wrong radius: `SessionState` does not structurally satisfy this
 * interface, so the mistake is a compile error rather than a small blob.
 * {@link toDeckSession} is the one supported conversion.
 */
export interface DeckSession {
  sessionId: string;
  /** Nodes in the session tree, agents and tools alike, root included. */
  nodeCount: number;
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
export function toDeckSession(state: SessionState): DeckSession {
  return { sessionId: state.sessionId, nodeCount: countNodes(state) };
}

function deckRadius(nodeCount: number): number {
  const safe = nodeCount > 0 ? nodeCount : 0;
  const raw = DECK_RADIUS_MIN + DECK_RADIUS_SCALE * Math.log(1 + safe);
  return roundCoord(Math.min(raw, DECK_RADIUS_MAX));
}

/**
 * Place every session blob on the deck.
 *
 * Placement is by ARRAY INDEX, which makes the incremental promise precise and
 * checkable: `deckLayout(list)` is always a prefix of `deckLayout(list.concat(more))`
 * in x and y. It also states the caller's obligation plainly — the order the
 * host emits sessions in is the order they are placed in, so a caller that
 * re-sorts its list every render will move blobs and that is the caller's
 * doing, not this function's.
 *
 * `N = 0` returns an empty array. That is a real case, not a degenerate one:
 * the empty deck is a rendered state with its own quiet line (C7.3).
 */
export function deckLayout(sessions: readonly DeckSession[]): DeckPlacement[] {
  const out: DeckPlacement[] = [];
  for (let i = 0; i < sessions.length; i += 1) {
    const session = sessions[i];
    if (session === undefined) continue;
    const angle = i * GOLDEN_ANGLE_RAD;
    const radius = DECK_PITCH * Math.sqrt(i);
    out.push({
      sessionId: session.sessionId,
      x: roundCoord(radius * Math.cos(angle)),
      y: roundCoord(radius * Math.sin(angle)),
      R: deckRadius(session.nodeCount),
    });
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Blob silhouette
 * ------------------------------------------------------------------------ */

/** Control points around the silhouette. More points, busier outline. */
export const BLOB_POINTS = 12;

/** Peak radial wobble as a fraction of R. 0 would draw a plain circle. */
export const BLOB_AMPLITUDE = 0.18;

/**
 * FNV-1a, 32-bit, over the UTF-16 code units of `id`.
 *
 * A pure function of the string and nothing else, which is the entire point:
 * C7.1 wants a session recognisable by SHAPE across reloads, and a shape keyed
 * to anything but the id would not survive one.
 *
 * FNV-1a rather than a hash from a library, because this module's allowed
 * import set is closed and a dependency would open it.
 */
export function hashSessionId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    // FNV prime 16777619, via imul so the multiply stays 32-bit.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The seed {@link blobPath} falls back to when no session id was supplied.
 *
 * A named constant rather than a bare `0`, so that the fallback silhouette is
 * an explicit, reproducible shape instead of a magic number that happens to
 * draw something.
 */
export const NEUTRAL_BLOB_SEED = hashSessionId('');

/** Deterministic 32-bit mixer: seed + index -> a value in [0, 1). */
function mix(seed: number, index: number): number {
  let z = (seed ^ Math.imul(index + 1, 0x85ebca6b)) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return ((z ^ (z >>> 15)) >>> 0) / 0x1_0000_0000;
}

/**
 * A closed, smooth silhouette centred on `(x, y)` with mean radius `R`.
 *
 * Catmull-Rom through {@link BLOB_POINTS} radially-perturbed vertices,
 * converted to cubic Beziers so the result is one `d` attribute a browser can
 * draw without a library. `seed` is the caller's `hashSessionId(sessionId)`;
 * C7.5 writes it as a defaulted parameter and the default here is
 * {@link NEUTRAL_BLOB_SEED}.
 */
export function blobPath(
  x: number,
  y: number,
  R: number,
  seed: number = NEUTRAL_BLOB_SEED,
): string {
  const px: number[] = [];
  const py: number[] = [];
  for (let j = 0; j < BLOB_POINTS; j += 1) {
    const angle = (j * 2 * Math.PI) / BLOB_POINTS;
    const wobble = 1 + BLOB_AMPLITUDE * (mix(seed, j) * 2 - 1);
    const r = R * wobble;
    px.push(x + r * Math.cos(angle));
    py.push(y + r * Math.sin(angle));
  }

  const at = (values: number[], index: number): number => {
    const wrapped = ((index % BLOB_POINTS) + BLOB_POINTS) % BLOB_POINTS;
    return values[wrapped] ?? 0;
  };

  let d = `M ${coordText(at(px, 0))} ${coordText(at(py, 0))}`;
  for (let j = 0; j < BLOB_POINTS; j += 1) {
    const c1x = at(px, j) + (at(px, j + 1) - at(px, j - 1)) / 6;
    const c1y = at(py, j) + (at(py, j + 1) - at(py, j - 1)) / 6;
    const c2x = at(px, j + 1) - (at(px, j + 2) - at(px, j)) / 6;
    const c2y = at(py, j + 1) - (at(py, j + 2) - at(py, j)) / 6;
    d +=
      ` C ${coordText(c1x)} ${coordText(c1y)}` +
      ` ${coordText(c2x)} ${coordText(c2y)}` +
      ` ${coordText(at(px, j + 1))} ${coordText(at(py, j + 1))}`;
  }
  return `${d} Z`;
}

/* ------------------------------------------------------------------------ *
 * Session interior geometry (altitude 1)
 * ------------------------------------------------------------------------ */

/** Concentric dot rings around an agent. */
export const DOT_RINGS = 3;

/**
 * Dot slots per ring, derived from {@link DOT_CAP} rather than chosen.
 *
 * The derivation is the guarantee: `DOTS_PER_RING * DOT_RINGS >= DOT_CAP`, so
 * the slot pattern's period is at least the cap and no two simultaneously
 * visible dots can land in the same slot. `layout.test.ts` asserts that
 * inequality, so raising the cap in `canvas-contract.ts` without revisiting
 * the ring count fails a test instead of silently stacking dots.
 */
export const DOTS_PER_RING = Math.ceil(DOT_CAP / DOT_RINGS);

/** Index period after which dot slots repeat. Never less than {@link DOT_CAP}. */
export const DOT_SLOT_PERIOD = DOTS_PER_RING * DOT_RINGS;

/** Radius of the innermost dot ring, at depth 0. Independent of the cell's R. */
export const DOT_RING_BASE = 96;

/** Radial step between dot rings, at depth 0. */
export const DOT_RING_GAP = 26;

/** Angle of dot slot 0. Straight up, so the arc reads clockwise from noon. */
export const DOT_ANGLE_START = -Math.PI / 2;

/** Agent membrane radius floor. */
export const CELL_RADIUS_MIN = 22;

/** Agent membrane radius gain per natural log of DIRECT child count. */
export const CELL_RADIUS_SCALE = 9;

/**
 * Agent membrane radius ceiling, at depth 0.
 *
 * Strictly below {@link DOT_RING_BASE} so a membrane can never swallow its own
 * dot ring however much content arrives. Asserted in `layout.test.ts`.
 */
export const CELL_RADIUS_MAX = 72;

/** Every length shrinks by this factor per level of nesting. */
export const DEPTH_SCALE = 0.55;

/** Distance from a spawning dot out to the cell it spawned, at depth 0. */
export const CELL_LIFT = 74;

/** Extra lift per additional cell spawned by the SAME dot, at depth 0. */
export const CELL_SIBLING_GAP = 48;

/** Ring radius for a cell with no spawn edge to hang from, at depth 0. */
export const PARKED_ORBIT = 214;

/** Angle of the first unanchored cell. */
export const PARKED_ANGLE_START = Math.PI / 2;

/** Angle step between successive unanchored cells under one parent. */
export const PARKED_ANGLE_STEP = 0.42;

function cellRadius(directChildren: number, depth: number): number {
  const raw = CELL_RADIUS_MIN + CELL_RADIUS_SCALE * Math.log(1 + directChildren);
  return roundCoord(Math.min(raw, CELL_RADIUS_MAX) * DEPTH_SCALE ** depth);
}

/** Where dot `index` sits relative to its agent's centre, at `depth`. */
function dotOffset(index: number, depth: number): { dx: number; dy: number; angle: number } {
  const slot = index % DOTS_PER_RING;
  const ring = Math.floor(index / DOTS_PER_RING) % DOT_RINGS;
  const stagger = ((2 * Math.PI) / DOTS_PER_RING) * (ring / DOT_RINGS);
  const angle = DOT_ANGLE_START + slot * ((2 * Math.PI) / DOTS_PER_RING) + stagger;
  const scale = DEPTH_SCALE ** depth;
  const radius = (DOT_RING_BASE + ring * DOT_RING_GAP) * scale;
  return { dx: radius * Math.cos(angle), dy: radius * Math.sin(angle), angle };
}

/**
 * Which agent children of `parent` hang off which of its tool children.
 *
 * The same join `tree.ts` performs, and for the same reason: `ToolNode` has no
 * `children` field, so the spawn relationship exists only in
 * `SessionState.spawnEdges`. An agent that no edge claims is UNANCHORED — there
 * is no dot to draw a filament from — and gets the parked ring instead.
 * Requiring the tool and the agent to be siblings, and honouring a populated
 * `parentNodeId`, keeps a stale edge from teleporting a cell.
 */
function joinSpawns(
  parent: AgentNode,
  edges: readonly { toolUseId: string; agentId: string; parentNodeId: string }[],
): { byTool: Map<string, AgentNode[]>; claimed: Set<string> } {
  const toolIds = new Set<string>();
  const agentsById = new Map<string, AgentNode>();
  for (const child of parent.children) {
    if (isAgentNode(child)) agentsById.set(child.id, child);
    else toolIds.add(child.id);
  }

  const byTool = new Map<string, AgentNode[]>();
  const claimed = new Set<string>();
  for (const edge of edges) {
    if (!toolIds.has(edge.toolUseId)) continue;
    const child = agentsById.get(edge.agentId);
    if (child === undefined) continue;
    if (edge.parentNodeId !== '' && edge.parentNodeId !== parent.id) continue;
    if (claimed.has(child.id)) continue;
    claimed.add(child.id);
    const list = byTool.get(edge.toolUseId);
    if (list === undefined) byTool.set(edge.toolUseId, [child]);
    else list.push(child);
  }
  return { byTool, claimed };
}

/**
 * Place every agent cell and every tool dot in a session interior.
 *
 * The main agent is the nucleus at the origin. Coordinates are in an abstract,
 * unbounded space centred on it; fitting that to a viewport is the renderer's
 * job and is a CSS transform, never a re-layout — which is what keeps this
 * function ignorant of screen size.
 *
 * G3, restated as geometry: a session the fingerprint refused lays out to
 * NOTHING. C7.4 requires an interior element count of exactly 0 on entry, and
 * making that a property of the layout rather than of a component means no
 * component can accidentally draw a partial tree for a refused session. Keyed
 * on `schemaOk === false` OR `liveness === 'unsupported'` — the model sets both
 * together, and refusing on either is the safe direction.
 */
export function sessionLayout(session: SessionState): SessionLayout {
  const cells = new Map<string, CellPlacement>();
  const dots = new Map<string, DotPlacement>();
  const elided = new Map<string, number>();
  // PLACEHOLDER, awaiting the P2-LAYOUT parked round. `SessionState.parked`
  // only began reaching the webview one commit ago; placing those agents is the
  // layout package's next piece of work. This empty Map exists so the contract
  // can REQUIRE the member without leaving the tree red in between, and an empty
  // Map is the honest value today: nothing is placed, so nothing renders, which
  // is exactly the behaviour before the field existed.
  //
  // It stays empty on the refusal path below whatever happens next: G3 says a
  // refused session renders no interior, and parked entries are ids and reasons
  // read out of a transcript whose schema we just refused to understand.
  const parked = new Map<string, CellPlacement>();

  if (session.schemaOk === false || session.liveness === 'unsupported') {
    return { cells, dots, elided, parked };
  }

  const edges = session.spawnEdges ?? [];

  const place = (agent: AgentNode, depth: number, cx: number, cy: number): void => {
    // First placement of an agent id wins, for the same reason dots do, plus
    // one more: this makes the walk total. A tree is what the model produces,
    // but "the renderer overflows its stack" is not an acceptable response to
    // a state that is not one, and an id placed twice would visibly move.
    if (cells.has(agent.id)) return;

    const directChildren = agent.children.length;
    cells.set(agent.id, {
      x: cx,
      y: cy,
      R: cellRadius(directChildren, depth),
    });

    const { byTool, claimed } = joinSpawns(agent, edges);

    // Tool dots, indexed by ABSOLUTE position among this agent's tool children.
    const tools: ToolNode[] = [];
    for (const child of agent.children) if (!isAgentNode(child)) tools.push(child);

    const firstVisible = Math.max(0, tools.length - DOT_CAP);
    if (firstVisible > 0) elided.set(agent.id, firstVisible);

    // Pass 1: this agent's own dots, before any recursion. Two passes rather
    // than one so that a `tool_use` id appearing in two different agents'
    // transcripts resolves in a stable order — see the FIRST WRITER note below.
    for (let i = firstVisible; i < tools.length; i += 1) {
      const toolNode = tools[i];
      if (toolNode === undefined) continue;
      const offset = dotOffset(i, depth);
      // FIRST WRITER WINS, deliberately. `SessionLayout.dots` is keyed by tool
      // id because C7.5 writes it that way, and a `tool_use` id is NOT unique
      // across a session tree: `fixtures/synthetic-graft/03-tool-use-id-duplicated`
      // carries the same id in the main transcript and in a subagent's, which
      // is the shape that makes a join `ambiguousJoinKey`. Last-writer-wins
      // would let a newly arrived subtree MOVE a dot that is already on screen,
      // breaking the incremental promise; first-writer-wins never moves
      // anything. The dot count is then lower than the tool-node count, which
      // `layout.test.ts` pins against that fixture rather than hiding.
      if (!dots.has(toolNode.id)) {
        dots.set(toolNode.id, {
          x: roundCoord(cx + offset.dx),
          y: roundCoord(cy + offset.dy),
        });
      }
    }

    // Pass 2: the cells spawned by those tool calls. Elided tool calls take
    // part here too — their geometry still exists, because a cell anchored to
    // a dot the panel is not drawing is better than a cell with no anchor.
    for (let i = 0; i < tools.length; i += 1) {
      const toolNode = tools[i];
      if (toolNode === undefined) continue;
      const spawned = byTool.get(toolNode.id) ?? [];
      if (spawned.length === 0) continue;
      const offset = dotOffset(i, depth);
      const dx = roundCoord(cx + offset.dx);
      const dy = roundCoord(cy + offset.dy);
      for (let k = 0; k < spawned.length; k += 1) {
        const child = spawned[k];
        if (child === undefined) continue;
        const lift = (CELL_LIFT + k * CELL_SIBLING_GAP) * DEPTH_SCALE ** depth;
        place(
          child,
          depth + 1,
          roundCoord(dx + lift * Math.cos(offset.angle)),
          roundCoord(dy + lift * Math.sin(offset.angle)),
        );
      }
    }

    // Unanchored agent children: no edge joined them to a sibling tool call,
    // so there is no dot and no filament. They go on their own ring, in
    // `children` order, which keeps them incremental like everything else.
    let parkedIndex = 0;
    for (const child of agent.children) {
      if (!isAgentNode(child)) continue;
      if (claimed.has(child.id)) continue;
      const angle = PARKED_ANGLE_START + parkedIndex * PARKED_ANGLE_STEP;
      const radius = PARKED_ORBIT * DEPTH_SCALE ** depth;
      parkedIndex += 1;
      place(
        child,
        depth + 1,
        roundCoord(cx + radius * Math.cos(angle)),
        roundCoord(cy + radius * Math.sin(angle)),
      );
    }
  };

  place(session.root, 0, 0, 0);
  return { cells, dots, elided, parked };
}
