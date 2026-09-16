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

import { instanceSeed, randomAt, slotId } from './random.js';
import { SLOT_TYPE } from './ir.js';
import { sideOfNormal } from './sides.js';
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
    // Balconies. 'none' | 'upper' | 'all' | 'scattered' - resolved by the
    // compiler from the node's mode, like floorFrom/floorTo above.
    balcony = 'none',
    balconyDepth = 1,
    balconyWidth = 2,
    balconyHeight = 1.05,
    balconyChance = 0.5,
    // Posts. 'none' | 'pier' | 'colonnade'.
    posts = 'none',
    postWidth = 0.45,
    postDepth = 0.45,
    // WHICH SIDES get openings, and which get balconies.
    //
    // NULL MEANS NO FILTER; a Set is the filter, and an EMPTY Set means none -
    // which is a real thing to ask for and was the bug here: treating empty as
    // "all" made turning every side off identical to leaving them all on.
    openingSides = null,
    balconySides = null,
  } = rule;

  const out = {
    slots: [], truncated: false, squashed: false, doorCount: 0, balconyCount: 0, postCount: 0,
    // Which storeys this node actually claimed. The compiler needs it to decide
    // what an earlier facade's slots should be replaced by - see the override
    // rule there - and to tell the author when a facade covers nothing.
    claimed: new Set(),
  };
  if (!levels.length) return out;

  const covers = index => index >= floorFrom && index <= floorTo;
  // A courtyard wall's normal points INWARD, so `sideOfNormal` answers for the
  // compass direction it faces rather than which side of the building it is on.
  // That is the right answer for both: a north-facing wall is a north-facing
  // wall whether it looks at the street or at the light well.
  const onSide = (set, edge) => !set
    || set.has(sideOfNormal(edge.normal[0], edge.normal[1]));

  // One compile-time slot per drawn property, so a window's choice of variant is
  // stable when an unrelated node is edited. See building/random.js.
  const variantSlot = slotId(nodeId, 'variant');
  // A SEPARATE compile-time slot for "does this one get a balcony", so turning
  // balconies on does not re-roll which window model every opening wears.
  const balconySlot = slotId(nodeId, 'balcony');

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

        // POSTS GO ON THE BAY BOUNDARIES, not in the bays, so a run of them
        // frames the openings instead of standing in front of them. One at the
        // start of every bay plus one at the far end closes the run - without it
        // a colonnade is missing its last column, which is the first thing
        // anyone notices about a portico.
        if (posts !== 'none' && cells.length) {
          const postZ = level.z0 + height / 2;
          for (let i = 0; i <= cells.length; i++) {
            if (out.slots.length >= MAX_SLOTS) { out.truncated = true; return out; }
            const at = i < cells.length ? cells[i].start : edge.length;
            const centre = slotTransform(edge, at, postZ);
            // A PIER is flush with the wall and reads as structure; a COLONNADE
            // stands clear of it and reads as an arcade. Same slot, one offset.
            if (posts === 'colonnade') {
              centre[12] += edge.normal[0] * postDepth / 2;
              centre[13] += edge.normal[1] * postDepth / 2;
            }
            out.slots.push({
              type: SLOT_TYPE.PILLAR,
              styleSlot: 'pillar',
              source: nodeId,
              transform: centre,
              cellW: postWidth,
              cellH: height,
              cellD: postDepth,
              faceIndex: face,
              floorIndex: level.index,
              bayIndex: i,
              // `sub: 4` - window 0, door 1, balcony 2, roof item 3. Its own
              // number so a post does not roll the variant its neighbouring
              // window rolled.
              seedKey: instanceSeed(seed, variantSlot, {
                face, floor: level.index, bay: i, sub: 4,
              }),
            });
            out.postCount++;
          }
        }

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

          // A SIDE WITH NO OPENINGS IS A BLANK WALL, which is a real thing to
          // want - a blind gable, a party wall, the back of a terrace. The DOOR
          // is exempt: it is placed once for the whole building on the wall the
          // author is meant to read as the front, and losing it to a side filter
          // would leave a house with no way in.
          if (!isDoor && !onSide(openingSides, edge)) continue;

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
            // WHICH FACADE MADE IT. Needed because a Facade can override the
            // model its openings wear, and nothing else in the slot says which
            // node it came from - the tag does not, since two Facades can share
            // one. Doc-side only: the compiler resolves it to a reference prefix
            // and the IR carries that instead.
            source: nodeId,
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

          // THE BALCONY, IN FRONT OF THE OPENING THAT IS ALREADY THERE.
          //
          // Emitted as a second slot rather than as a different opening, because
          // that is what a balcony is: the window stays, and a balustrade stands
          // proud of the wall on the sill it steps out onto. Never on the door -
          // a slab across the front door is a canopy at best and a blockage at
          // worst - and never on a courtyard ring, where it would project into a
          // light well barely wider than itself.
          const wantsBalcony = balcony !== 'none'
            && !isDoor
            && onSide(balconySides, edge)
            && ring === rings[0]
            && (balcony === 'all'
              || (balcony === 'upper' && !isGround)
              || (balcony === 'scattered' && !isGround && randomAt(seed, balconySlot, {
                face, floor: level.index, bay: bay.index,
              }) < balconyChance));

          if (wantsBalcony) {
            if (out.slots.length >= MAX_SLOTS) {
              out.truncated = true;
              return out;
            }
            // CLAMPED TO THE BAY, not to the opening. A balcony is normally
            // wider than its window - that is most of what makes it read as one
            // - but two neighbours growing past the pier between them would
            // interpenetrate, and a balustrade passing through a balustrade is
            // the kind of artefact that looks like a broken generator rather
            // than like a wide setting.
            const width = Math.min(balconyWidth, bay.size);
            // ON THE SILL, not in the opening band: the floor of the balcony is
            // the bottom of the hole you step through. The slot's origin is its
            // CENTRE, like every other slot, so it rises by half the balustrade.
            // openingBand.start IS the sill, in both cases: the vertical split
            // above already chose groundSillHeight or sillHeight, and it is the
            // split's answer rather than the setting that is right here - a
            // storey too short for both squashes the band, and the balcony has
            // to follow the hole it belongs to.
            const sillZ = level.z0 + openingBand.start;
            const centre = slotTransform(
              edge,
              placed.start + placed.size / 2,
              sillZ + balconyHeight / 2,
            );
            // Pushed OUT along the wall normal by half its depth, so the slab
            // starts at the wall face and projects forward rather than being
            // half buried in the masonry.
            centre[12] += edge.normal[0] * balconyDepth / 2;
            centre[13] += edge.normal[1] * balconyDepth / 2;

            out.slots.push({
              type: SLOT_TYPE.BALCONY,
              styleSlot: 'balcony',
              source: nodeId,
              transform: centre,
              cellW: width,
              cellH: balconyHeight,
              // The one slot with a REAL depth. An opening leaves this 0 and
              // takes the consumer's token depth; a balcony's projection is a
              // dimension the author set and has to survive into the IR.
              cellD: balconyDepth,
              faceIndex: face,
              floorIndex: level.index,
              bayIndex: bay.index,
              // `sub: 2` - the door is 1 and the window is 0, so a balcony rolls
              // its model independently of the window it hangs on.
              seedKey: instanceSeed(seed, variantSlot, {
                face, floor: level.index, bay: bay.index, sub: 2,
              }),
            });
            out.balconyCount++;
          }
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
