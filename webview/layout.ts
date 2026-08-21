/**
 * Agent Deck canvas — the layout engine. Pure geometry, and nothing else.
 *
 * C7.5 of `agent-deck-spec.md` is the law this file implements:
 *
 *     deckLayout(sessions)                      -> { sessionId, x, y, R }[]
 *     blobPath(x, y, R, seed = hash(sessionId)) -> SVG path data
 *     sessionLayout(session)                    -> { cells, dots, elided, parked }
 *
 * A fourth exported generator, constellationPoints, answers C7.1 rather than
 * C7.5: "a faint interior constellation of one dot per node makes density
 * readable without a number". It obeys the same three properties, and the
 * incremental one is what shapes it — see CONSTELLATION_CAP.
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
/**
 * Clear space between placed shapes, in stage units.
 *
 * Not zero: two circles that merely fail to overlap still read as one blob
 * with a pinch in it. This is the gap at which they read as two things.
 */
export const SEPARATION = 14;

/**
 * Extra clearance a CELL claims for its label, beyond its membrane.
 *
 * The membrane is ~35 units across; the label under it is a truncated agent
 * name at 15px, which is several times wider. Separating on the membrane alone
 * produced exactly what the first attempt shipped: circles with clear space
 * between them and text written straight through the neighbour's text.
 *
 * Circular, which over-separates vertically for what is a wide, short piece of
 * text. That is the deliberate trade: an elliptical footprint would pack
 * tighter and is a great deal more machinery for a picture whose problem was
 * that things were on top of each other.
 *
 * Derived from {@link LABEL_MAX_CHARS} rather than typed as a round number, so
 * shortening the label actually tightens the layout instead of leaving a hole.
 */
export const LABEL_MAX_CHARS = 26;

/** Rough advance width per character at the label's font size, in units. */
export const LABEL_CHAR_WIDTH = 7.4;

/** Half the widest label a cell can draw. */
export const LABEL_PAD = roundCoord((LABEL_MAX_CHARS * LABEL_CHAR_WIDTH) / 2);

/**
 * The clearance every cell claims, whatever it draws.
 *
 * CONSTANT, and that is the load-bearing part. `cellRadius` grows with a
 * cell's child count, so separating on the drawn radius meant that adding one
 * tool call changed a radius, changed a collision, and MOVED A CELL ALREADY ON
 * SCREEN - breaking "a spawn adds, it never reflows". The incremental test
 * caught it, which is the whole reason that test exists.
 *
 * Sized for the worst case a cell can draw (`CELL_RADIUS_MAX`, spelled as a
 * literal here only because that constant is declared further down the file).
 * `layout.test.ts` asserts the two agree, so the literal cannot drift.
 */
export const CELL_FOOTPRINT = roundCoord(LABEL_PAD + 72);

/** How far a colliding candidate is pushed per attempt. */
export const SEPARATION_STEP = 9;

/**
 * Give up after this many pushes and accept an overlap.
 *
 * A bounded loop rather than "repeat until clear", because a pathological tree
 * must not be able to hang the renderer. Overlapping is a visual defect; not
 * returning is a broken panel.
 */
export const SEPARATION_ATTEMPTS = 240;

interface Circle {
  x: number;
  y: number;
  R: number;
  /**
   * Clearance claimed for collision ONLY, never drawn. Lets a cell reserve
   * room for its label without inflating the membrane the label sits on.
   */
  pad?: number;
}

/** What a circle occupies for separation purposes. */
function footprint(c: Circle): number {
  return c.R + (c.pad ?? 0);
}

/** True when two circles are closer than {@link SEPARATION} apart. */
function collides(a: Circle, b: Circle): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy) < footprint(a) + footprint(b) + SEPARATION;
}

/**
 * Move a candidate until it clears everything already placed.
 *
 * THIS IS WHY THE INCREMENTAL PROMISE SURVIVES. Only the candidate moves;
 * every circle already in `placed` keeps the coordinates it was given. Since
 * placement order is fixed by the walk, and each placement depends only on
 * placements before it, adding a node still adds — it cannot reflow the ones
 * already on screen. That is the same reason `deckLayout(list)` stays a prefix
 * of `deckLayout(list.concat(more))`.
 *
 * The push direction is away from the FIRST collider in insertion order, so it
 * is deterministic; when two centres coincide exactly, a hash of nothing would
 * do, so it falls back to a fixed angle stepped per attempt, which is
 * deterministic too.
 */
function separate(candidate: Circle, placed: readonly Circle[]): Circle {
  let current = candidate;
  for (let attempt = 0; attempt < SEPARATION_ATTEMPTS; attempt += 1) {
    const hit = placed.find((other) => collides(current, other));
    if (hit === undefined) return current;
    const dx = current.x - hit.x;
    const dy = current.y - hit.y;
    const distance = Math.hypot(dx, dy);
    const angle = distance < 1e-9 ? attempt * GOLDEN_ANGLE_RAD : Math.atan2(dy, dx);
    // Push to exactly clear this collider, plus a step, so a long chain of
    // near-misses resolves in a few passes rather than a few hundred.
    const needed = footprint(hit) + footprint(current) + SEPARATION - distance + SEPARATION_STEP;
    current = {
      x: roundCoord(current.x + needed * Math.cos(angle)),
      y: roundCoord(current.y + needed * Math.sin(angle)),
      R: current.R,
      ...(current.pad === undefined ? {} : { pad: current.pad }),
    };
  }
  return current;
}

export function deckLayout(sessions: readonly DeckSession[]): DeckPlacement[] {
  const out: DeckPlacement[] = [];
  for (let i = 0; i < sessions.length; i += 1) {
    const session = sessions[i];
    if (session === undefined) continue;
    const angle = i * GOLDEN_ANGLE_RAD;
    const radius = DECK_PITCH * Math.sqrt(i);
    // The golden-angle spiral spaces CENTRES evenly; it knows nothing about
    // radii, and a blob's radius comes from its node count. A busy session
    // next to a quiet one therefore used to overlap it. Separation is applied
    // against the blobs already placed, so a later session moves and an
    // earlier one never does.
    const separated = separate(
      {
        x: roundCoord(radius * Math.cos(angle)),
        y: roundCoord(radius * Math.sin(angle)),
        R: deckRadius(session.nodeCount),
      },
      out,
    );
    out.push({
      sessionId: session.sessionId,
      x: separated.x,
      y: separated.y,
      R: separated.R,
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
 * Deck constellation
 * ------------------------------------------------------------------------ */

/**
 * Constellation points drawn on one blob before the pattern SATURATES.
 *
 * C7.1 asks for "a faint interior constellation of one dot per node" so that
 * density is readable without a number. One per node is unbounded, and an R2
 * session runs to thousands of nodes on a deck that may hold twelve blobs, so
 * "one per node" has to stop somewhere or the deck carries tens of thousands
 * of SVG elements to say something the eye stopped reading at about forty.
 *
 * ABOVE THIS COUNT NOTHING IS ADDED. Points 0..CAP-1 are returned and the rest
 * of the nodes contribute no point at all — the blob does not thin out, does
 * not re-space, and does not change in any way as node 65 and node 6,500
 * arrive. Density is still encoded above the cap, by the blob's RADIUS, which
 * C7.1 derives from `log(nodeCount)` and which has no ceiling until
 * {@link DECK_RADIUS_MAX}. So the two channels hand off: dots read density up
 * to the cap, size reads it after.
 *
 * Named as an exported constant for the same reason `DOT_CAP` is: it makes the
 * geometry a pure function of the capped count, which is what lets a golden pin
 * it. 64 is a decision, not a measurement.
 */
export const CONSTELLATION_CAP = 64;

/**
 * How far out the constellation is allowed to reach, as a fraction of the
 * blob's minimum membrane radius `R * (1 - BLOB_AMPLITUDE)`.
 *
 * Expressed against the MINIMUM rather than against R because the silhouette
 * is not a circle: {@link blobPath} perturbs each vertex radius by up to
 * {@link BLOB_AMPLITUDE}, and the curve between two perturbed vertices dips
 * further in again. A dot outside the membrane is a visual defect, so this
 * leaves a wide margin and `layout.test.ts` measures the real silhouette —
 * sampling the emitted Bezier segments — rather than trusting the arithmetic.
 */
export const CONSTELLATION_INSET = 0.62;

/**
 * The faint interior dots on a deck blob: one per node, up to the cap.
 *
 * Sunflower placement, and the radius of point `i` is normalised by
 * {@link CONSTELLATION_CAP} rather than by `count`. That distinction is the
 * whole incremental property here: normalising by `count` would re-space every
 * dot each time a node arrived, which is exactly the reflow C7.5 forbids.
 * Normalising by the cap makes point `i` a function of `i` alone, so
 * `constellationPoints(x, y, R, n + 1, seed)` starts with the `n` points
 * `constellationPoints(x, y, R, n, seed)` returned, byte-identical.
 *
 * `seed` is the caller's `hashSessionId(sessionId)`, the same seed
 * {@link blobPath} takes, and it only rotates the pattern — it never changes a
 * radius. Two sessions of the same size are therefore distinguishable without
 * either one's dots leaving its own membrane.
 *
 * A `count` that is negative or not a finite number yields no points rather
 * than throwing: this is a renderer input path, and refusing to draw is the
 * safe direction.
 */
export function constellationPoints(
  x: number,
  y: number,
  R: number,
  count: number,
  seed: number,
): DotPlacement[] {
  const out: DotPlacement[] = [];
  if (!Number.isFinite(count) || count <= 0) return out;
  const drawn = Math.min(Math.floor(count), CONSTELLATION_CAP);
  const reach = R * (1 - BLOB_AMPLITUDE) * CONSTELLATION_INSET;
  // Index BLOB_POINTS is one past the last vertex index blobPath mixes, so the
  // rotation cannot repeat a value already spent on the silhouette.
  const rotation = mix(seed, BLOB_POINTS) * 2 * Math.PI;
  for (let i = 0; i < drawn; i += 1) {
    // The +0.5 keeps point 0 off the exact centre, where it would sit under
    // whatever the blob carries in the middle.
    const radius = reach * Math.sqrt((i + 0.5) / CONSTELLATION_CAP);
    const angle = rotation + i * GOLDEN_ANGLE_RAD;
    out.push({
      x: roundCoord(x + radius * Math.cos(angle)),
      y: roundCoord(y + radius * Math.sin(angle)),
    });
  }
  return out;
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

/* ---- In-tree agent children that no spawn edge claims -------------------- *
 *
 * RENAMED from PARKED_* in the parked round, and the rename is the point. An
 * agent that IS in `children` but that no spawn edge joined to a sibling tool
 * call is UNANCHORED — there is no dot to draw a filament from. A PARKED graft
 * is a different thing entirely: it is not in the tree at all, and arrives on
 * `SessionState.parked`. Both existed before that field did, under one name,
 * and one name for two states is how a renderer ends up drawing the wrong one.
 * The PARKED_* names below now mean parked grafts and nothing else.
 */

/** Ring radius for an in-tree cell with no spawn edge to hang from, at depth 0. */
export const UNANCHORED_ORBIT = 214;

/** Angle of the first unanchored cell under one parent. */
export const UNANCHORED_ANGLE_START = Math.PI / 2;

/** Angle step between successive unanchored cells under one parent. */
export const UNANCHORED_ANGLE_STEP = 0.42;

/* ---- Parked grafts: agents that are not in the tree at all --------------- */

/**
 * Inner radius of the band parked grafts are scattered into.
 *
 * Chosen to sit outside the interior a typical session draws, so a parked cell
 * reads as debris rather than as part of the structure. That is a HEURISTIC and
 * is stated as one: nesting is depth-scaled but unbounded, and enough sibling
 * cells at one dot can push content out past any fixed constant. The
 * load-bearing signal of parked-ness is not the distance — it is that the id is
 * in `SessionLayout.parked` and not in `cells`, and that no filament reaches it.
 * `layout.test.ts` measures the separation on the real fixtures rather than
 * claiming it universally.
 */
export const PARKED_ORBIT = 560;

/** Radial width of that band. Keeps the scatter from reading as a perfect ring. */
export const PARKED_ORBIT_SPREAD = 96;

/**
 * The depth a parked cell is SIZED as. It has no depth of its own: the grafter
 * refused to say where it belongs, which is exactly what parking means, so
 * inventing a nesting level for it would be the guess G3 forbids. Sized like a
 * first-level cell because that is the shallowest thing it could have been.
 */
export const PARKED_DEPTH = 1;

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
 * Where a parked graft sits, as a pure function of ITS OWN `agentId`.
 *
 * Not of its index in `session.parked`, and that is the whole design. Every
 * other placement in this module indexes by position among siblings, which is
 * safe because a sibling is appended at the end. `parked` is not like that: the
 * grafter emits it SORTED BY `agentId` (verified in `layout.test.ts`, not
 * assumed), so a newly parked agent whose id sorts early is inserted in the
 * MIDDLE of the list and every positional index after it shifts. Under a
 * positional rule that would move cells already on screen — the reflow C7.5
 * forbids — so the id itself is the coordinate source and nothing ever moves,
 * whatever order the host sends or how the set changes around it.
 *
 * Angle from the full 32-bit hash and radius from a second mix of it, both
 * continuous rather than slotted: an exact overlap then needs a full hash
 * collision instead of a collision modulo some slot count. Two parked agents
 * can still land visually near each other, which is a cosmetic risk accepted
 * deliberately — the alternative is a collision nudge that depends on who else
 * is parked, which is the reflow again.
 *
 * The size is `cellRadius(0, PARKED_DEPTH)`: a parked agent has no children in
 * the tree because it has no node in the tree, and its depth is precisely what
 * the grafter refused to decide.
 */
function placeParked(agentId: string): CellPlacement {
  const h = hashSessionId(agentId);
  const angle = (h / 0x1_0000_0000) * 2 * Math.PI;
  // BLOB_POINTS + 1 is one past the index the constellation rotation spends,
  // which is itself one past the last silhouette vertex, so no two seeded
  // values in this module are drawn from the same mixer input.
  const radius = PARKED_ORBIT + mix(h, BLOB_POINTS + 1) * PARKED_ORBIT_SPREAD;
  return {
    x: roundCoord(radius * Math.cos(angle)),
    y: roundCoord(radius * Math.sin(angle)),
    R: cellRadius(0, PARKED_DEPTH),
  };
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
 * together, and refusing on either is the safe direction. ALL FOUR maps come
 * back empty on that path, `parked` included: an additive field is exactly
 * where a refusal quietly stops applying if nobody says otherwise.
 */
export function sessionLayout(session: SessionState): SessionLayout {
  const cells = new Map<string, CellPlacement>();
  const dots = new Map<string, DotPlacement>();
  const elided = new Map<string, number>();
  // Parked grafts (UNRESOLVED joins). Populated at the END of this function,
  // after the tree walk, because the disjointness rule needs a finished `cells`
  // to check against.
  //
  // It stays EMPTY on the refusal path below, and that is not a formality: G3
  // says a refused session renders no interior at all, and a parked entry is an
  // agent id and a reason read out of a transcript whose layout the fingerprint
  // just refused to understand. A new field is not a hole to leak content
  // through. The host sends an empty list for a refused session for the same
  // reason; this refuses independently rather than trusting that.
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
    // Cells were placed from the parent plus a fixed offset, with nothing
    // checking whether the spot was already taken — so two subagents spawned
    // from tool calls at similar angles landed on top of each other, and at
    // depth the lifts shrink until they all pile onto the parent. Separating
    // against what is already placed is what makes the picture readable
    // without asking the user to drag anything apart by hand.
    // Collision uses the CONSTANT footprint, not the drawn radius, so a cell
     // that gains a child changes size without moving - or moving anyone else.
    const separated = separate(
      { x: cx, y: cy, R: 0, pad: CELL_FOOTPRINT },
      [...cells.values()].map((c) => ({ x: c.x, y: c.y, R: 0, pad: CELL_FOOTPRINT })),
    );
    // `pad` is a separation concern and must not reach the renderer, which
    // would otherwise draw a membrane the size of the label.
    cells.set(agent.id, {
      x: separated.x,
      y: separated.y,
      R: cellRadius(directChildren, depth),
    });

    // Everything below hangs off where this cell ACTUALLY landed, not where it
    // was first proposed — otherwise a separated parent would keep spawning
    // its children around its old position.
    const ax = separated.x;
    const ay = separated.y;

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
          x: roundCoord(ax + offset.dx),
          y: roundCoord(ay + offset.dy),
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
      const dx = roundCoord(ax + offset.dx);
      const dy = roundCoord(ay + offset.dy);
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
    let unanchoredIndex = 0;
    for (const child of agent.children) {
      if (!isAgentNode(child)) continue;
      if (claimed.has(child.id)) continue;
      const angle = UNANCHORED_ANGLE_START + unanchoredIndex * UNANCHORED_ANGLE_STEP;
      const radius = UNANCHORED_ORBIT * DEPTH_SCALE ** depth;
      unanchoredIndex += 1;
      place(
        child,
        depth + 1,
        roundCoord(ax + radius * Math.cos(angle)),
        roundCoord(ay + radius * Math.sin(angle)),
      );
    }
  };

  place(session.root, 0, 0, 0);

  // Parked grafts, from `session.parked` and NEVER from a tree walk: a parked
  // agent has no node in the tree, so that list is the only record it exists.
  // Placed after the walk so `cells` is complete.
  for (const entry of session.parked ?? []) {
    const agentId = entry.agentId;
    if (agentId === '') continue;
    // PARKED AND CELLS ARE DISJOINT, enforced rather than hoped for. An agent
    // that is in the tree is grafted by definition, so an id in both places is
    // a contradiction in the state, and the tree is the half with a node, a
    // parent and children behind it. Drawing it twice would put one agent in
    // two places on screen, which is worse than dropping the claim that it is
    // parked. `layout.test.ts` asserts the disjointness from both directions.
    if (cells.has(agentId)) continue;
    // First writer wins, as everywhere else here, so a duplicated entry cannot
    // move a placement that is already made.
    if (parked.has(agentId)) continue;
    parked.set(agentId, placeParked(agentId));
  }

  return { cells, dots, elided, parked };
}
