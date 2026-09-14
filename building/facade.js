// Facades: turning a stack of levels into placed slots.
//
// This is where the abstract half of the design becomes concrete. The graph so
// far produces MASS - polygons at heights. A facade walks each level's boundary,
// splits every wall into bays with the grammar, splits each bay vertically, and
// emits a SLOT for each opening: a type, a size and a transform, with no opinion
// about what mesh eventually goes there. Binding a slot to a window model is a
// style pack's job, in a later phase; nothing here knows what a window looks
// like.
//
// WHY SLOTS AND NOT GEOMETRY. A slot is ~30 numbers; a window is a few hundred
// triangles. A forty-storey tower has thousands of openings, and emitting them
// as transforms means the IR stays small, the preview can instance them in one
// draw call per type, and an engine exporter can hand Unity prefab placements
// rather than a baked mesh. It is also the only way the same building can be
// re-dressed in a different style without recompiling the massing.
//
// HOLES GET FACADES TOO. A courtyard has walls, and they face inward. The ring
// is walked AS STORED - outer counter-clockwise, holes clockwise - so the same
// normal formula yields outward on the street and inward in the court, with no
// special case. Re-winding the hole first, which poly.ringEdges does on purpose
// for other callers, would turn every courtyard window to face the masonry.
//
// THE GROUND FLOOR IS A SPECIAL CASE, EXPLICITLY. Every real facade treats it
// differently - it is taller, it has the door, and its openings are wider. A
// grammar that pretends otherwise produces buildings that read as wrong without
// a viewer being able to say why, so `isGround` is threaded through rather than
// inferred late.

import { instanceSeed, slotId } from './random.js';
import { SLOT_TYPE } from './ir.js';
import {
  STRETCH, bayParts, placeInCell, splitSpan, storeyParts, tileSpan,
} from './grammar.js';

/** A wall shorter than this cannot hold an opening worth emitting. Metres. */
const MIN_WALL = 0.4;

/**
 * Hard ceiling on slots per building.
 *
 * A 200-storey tower with 24 bays on each of four faces is 19,200 openings, and
 * each one becomes an instanced draw plus an IR entry. The cap is not a
 * performance tuning number so much as a guarantee that a slider drag cannot
 * wedge the tab: the compiler reports the truncation and the author sees why.
 */
export const MAX_SLOTS = 6000;

/**
 * The edges of a ring, AS STORED.
 *
 * Deliberately not poly.ringEdges, which normalises to counter-clockwise first.
 * That is right for callers who want an outward normal from arbitrary input and
 * wrong here: a hole is stored clockwise precisely so this formula points its
 * normal into the courtyard.
 */
function edgesOf(ring) {
  const edges = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    edges.push({
      a,
      dir: [dx / length, dy / length],
      normal: [dy / length, -dx / length],
      length,
    });
  }
  return edges;
}

/**
 * A column-major 4x4 placing a slot on a wall.
 *
 * Local axes: X along the wall, Y up, Z out of it. Right-handed by
 * construction - X cross Y is (dy, -dx, 0), which is exactly the outward normal
 * - so a model authored facing +Z sits flat on the wall the right way round,
 * and mirrored geometry is impossible rather than merely unlikely.
 *
 * The origin is the CENTRE of the opening, so a style pack's window can be
 * authored centred on its own origin, which is what anyone modelling one does.
 */
function slotTransform(edge, along, z) {
  const [dx, dy] = edge.dir;
  const [nx, ny] = edge.normal;
  const x = edge.a[0] + dx * along;
  const y = edge.a[1] + dy * along;
  return [
    dx, dy, 0, 0,
    0, 0, 1, 0,
    nx, ny, 0, 0,
    x, y, z, 1,
  ];
}

/**
 * Place the openings on one building.
 *
 * @param {object} options
 * @param {Array} options.levels     from stackMass
 * @param {number} options.seed      the document seed
 * @param {string} options.nodeId    the Facade node, for seeding
 * @param {object} options.rule      bay and storey dimensions
 * @returns {{slots: Array, truncated: boolean, squashed: boolean, doorCount: number}}
 */
export function generateFacade({ levels = [], seed = 0, nodeId = 'facade', rule = {} } = {}) {
  const {
    // Which storeys this facade dresses. Resolved by the compiler from the
    // node's mode, so this file never has to know what 'upper' means.
    floorFrom = 0,
    floorTo = Infinity,
    // The style slot the openings are tagged with. A style pack binds meshes and
    // materials per tag, so tagging the ground floor 'shopfront' is what lets it
    // be dressed differently from the storeys above without a second geometry
    // path. Tag only - nothing here draws anything different.
    openingTag = 'window',
    placeDoor = true,
    bayWidth = 3,
    pierWidth = 0.6,
    windowWidth = 1.2,
    sillHeight = 0.9,
    lintelHeight = 0.5,
    groundSillHeight = 0.2,
    doorWidth = 1.1,
    doorHeight = 2.2,
    includeCourtyards = true,
  } = rule;

  const out = {
    slots: [], truncated: false, squashed: false, doorCount: 0,
    // Which storeys this node actually claimed. The compiler needs it to decide
    // what an earlier facade's slots should be replaced by - see the override
    // rule there - and to tell the author when a facade covers nothing.
    claimed: new Set(),
  };
  if (!levels.length) return out;

  const covers = index => index >= floorFrom && index <= floorTo;

  // One compile-time slot per drawn property, so a window's choice of variant is
  // stable when an unrelated node is edited. See building/random.js.
  const variantSlot = slotId(nodeId, 'variant');

  // The door goes on the longest GROUND-level wall, nearest its middle: the
  // frontage, which is what anyone looking at the building will read as the
  // front. Chosen once over the whole ground floor rather than per level, so a
  // building has one front door and not one per wall.
  // The door belongs to whichever facade claims the ground floor, so a facade
  // that only dresses the upper storeys never places one.
  const door = placeDoor && covers(0) ? pickDoorWall(levels, bayWidth) : null;

  const horizontalParts = bayParts({ pierWidth });

  for (const level of levels) {
    const isGround = level.index === 0 && level.kind !== 'plinth';
    // A plinth is a base course, not a storey: it has no windows.
    if (level.kind === 'plinth') continue;
    if (!covers(level.index)) continue;
    out.claimed.add(level.index);

    const height = level.z1 - level.z0;
    if (!(height > MIN_WALL)) continue;

    const verticalParts = storeyParts({
      sillHeight: isGround ? groundSillHeight : sillHeight,
      lintelHeight,
    });
    const vertical = splitSpan(height, verticalParts);
    if (vertical.overflowed) out.squashed = true;
    const openingBand = vertical.cells[1];
    if (!openingBand || openingBand.size <= MIN_WALL) continue;

    const rings = [level.polygon.outer];
    if (includeCourtyards) rings.push(...(level.polygon.holes || []));

    let faceIndex = 0;
    for (const ring of rings) {
      for (const edge of edgesOf(ring)) {
        const face = faceIndex++;
        if (edge.length < MIN_WALL) continue;

        const { cells } = tileSpan(edge.length, bayWidth);
        for (const bay of cells) {
          if (out.slots.length >= MAX_SLOTS) {
            out.truncated = true;
            return out;
          }

          const split = splitSpan(bay.size, horizontalParts);
          if (split.overflowed) out.squashed = true;
          const openingCell = split.cells[1];
          if (!openingCell || openingCell.size <= 0) continue;

          // The opening's cell, in wall coordinates rather than bay coordinates.
          const cell = { start: bay.start + openingCell.start, size: openingCell.size };

          const isDoor = isGround
            && door
            && door.levelIndex === level.index
            && door.face === face
            && door.bay === bay.index;

          const natural = isDoor ? doorWidth : windowWidth;
          const placed = placeInCell(cell, { stretch: STRETCH.NONE, natural });
          if (placed.clamped) out.squashed = true;
          if (placed.size <= 0) continue;

          // A door stands on the floor; a window sits in its band.
          const openingHeight = isDoor
            ? Math.min(doorHeight, height - lintelHeight)
            : openingBand.size;
          if (openingHeight <= 0) continue;
          const centreZ = isDoor
            ? level.z0 + openingHeight / 2
            : level.z0 + openingBand.start + openingBand.size / 2;

          out.slots.push({
            type: isDoor ? SLOT_TYPE.DOOR : SLOT_TYPE.WINDOW,
            styleSlot: isDoor ? 'door' : openingTag,
            transform: slotTransform(edge, placed.start + placed.size / 2, centreZ),
            cellW: placed.size,
            cellH: openingHeight,
            faceIndex: face,
            floorIndex: level.index,
            bayIndex: bay.index,
            // Hashed from WHERE IT IS, never from a running counter - so adding
            // a storey does not reshuffle the windows below it.
            seedKey: instanceSeed(seed, variantSlot, {
              face,
              floor: level.index,
              bay: bay.index,
              sub: isDoor ? 1 : 0,
            }),
          });
          if (isDoor) out.doorCount++;
        }
      }
    }
  }

  return out;
}

/**
 * Which bay gets the front door.
 *
 * The longest wall on the ground floor, and the bay nearest its centre. Longest
 * because that is the frontage; centre because a door at the corner of a
 * symmetrical facade reads as a side entrance. Returns null when there is no
 * ground level to put one on.
 */
function pickDoorWall(levels, bayWidth) {
  const ground = levels.filter(level => level.index === 0 && level.kind !== 'plinth');
  if (!ground.length) return null;

  let best = null;
  for (const level of ground) {
    let faceIndex = 0;
    for (const ring of [level.polygon.outer, ...(level.polygon.holes || [])]) {
      for (const edge of edgesOf(ring)) {
        const face = faceIndex++;
        // Only the outer ring: a front door opening into a courtyard the street
        // cannot reach is not a front door.
        if (ring !== level.polygon.outer) continue;
        if (!best || edge.length > best.length) {
          best = { levelIndex: level.index, face, length: edge.length };
        }
      }
    }
  }
  if (!best) return null;

  // The bay count on that wall decides which bay is the middle one.
  const level = ground.find(l => l.index === best.levelIndex);
  const edges = edgesOf(level.polygon.outer);
  const edge = edges[best.face];
  if (!edge) return null;
  const { count } = tileSpan(edge.length, bayWidth);
  return { ...best, bay: Math.floor(Math.max(0, count - 1) / 2) };
}
