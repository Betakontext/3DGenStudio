// Trim: cornices, string courses, plinths, eaves and parapets.
//
// EDGE-DRIVEN, NOT FACE-DRIVEN, and that is the whole design. The obvious
// implementation attaches a moulding to each wall face and lets the faces meet
// at the corners. It does not work: a cornice turning a corner has to MITER, and
// a mitre is a property of the joint between two edges, which a face does not
// carry. Per-face trim shows up as a visible notch at every corner of every
// building, and the fix is not a tweak - it is this file.
//
// So a trim run is a POLYLINE that walks a ring, and the mesher sweeps a
// cross-section along it computing the bisector at each vertex. A closed ring
// gives a closed run, which is what a cornice actually is.
//
// WHICH RINGS, AND IN WHICH DIRECTION. Rings are walked AS STORED - outer
// counter-clockwise, holes clockwise - exactly as facade.js walks them, and for
// the same reason: with that convention the outward normal of an edge points
// away from the solid on both, so a cornice around a courtyard projects INTO the
// courtyard rather than into the masonry. Using poly.ringEdges here, which
// re-winds everything to CCW, would put the holes' trim inside the wall.
//
// THE CROSS-SECTION IS DATA, NOT GEOMETRY. A profile is a small closed polygon
// in (out, up) - out is the horizontal distance from the wall, up is the offset
// from the run's height, both normalised so the node's Projection and Height
// props scale them. That keeps this file in the pure contract, lets a style pack
// bind a PROFILE reference later (doc.js already has the reference kind), and
// means an exporter sweeps exactly what the preview sweeps.

import { LEVEL_KIND } from './ir.js';
import { polygonArea } from './poly.js';

/**
 * Where a run goes.
 *
 * Named for the architectural element rather than for the geometry ("top edge of
 * the highest level") because the author is choosing a building part, and the
 * geometry that produces it is this file's problem.
 */
export const TRIM_WHERE = {
  /** The crown: the top edge of the topmost storey. */
  CORNICE: 'cornice',
  /** A band between storeys. Every storey, or every Nth. */
  STRING: 'string',
  /** The base course, at the bottom of the building. */
  PLINTH: 'plinth',
  /** Where the roof meets the wall. */
  EAVE: 'eave',
  /** A wall standing above a flat roof. */
  PARAPET: 'parapet',
};

/**
 * The built-in cross-sections, as closed polygons in (out, up).
 *
 * `out` runs 0 at the wall face to 1 at full Projection; `up` runs -0.5 to 0.5
 * of Height, so a run is centred on its path. The parapet is the exception and
 * sits entirely ABOVE its path, because a parapet that straddled the roof deck
 * would bury half of itself in it.
 *
 * Wound counter-clockwise in (out, up) so the swept solid comes out with
 * outward normals without a per-face correction - the same convention poly.js
 * fixes for plans, for the same reason.
 */
export const TRIM_PROFILE = {
  // A classical cornice: undercut, then a projecting corona, then a fillet back.
  [TRIM_WHERE.CORNICE]: [
    [0, -0.5], [0.35, -0.5], [0.55, -0.2], [1, 0.05], [1, 0.3], [0.8, 0.5], [0, 0.5],
  ],
  // A flat band with a weathered top - the storey divider.
  [TRIM_WHERE.STRING]: [
    [0, -0.5], [0.85, -0.35], [1, -0.1], [1, 0.15], [0.8, 0.5], [0, 0.5],
  ],
  // A base course: full projection below, chamfered back into the wall above.
  [TRIM_WHERE.PLINTH]: [
    [0, -0.5], [1, -0.5], [1, 0.1], [0.55, 0.5], [0, 0.5],
  ],
  // An eave with a gutter hollow on top.
  [TRIM_WHERE.EAVE]: [
    [0, -0.5], [0.9, -0.45], [1, -0.1], [1, 0.5], [0.75, 0.5], [0.72, -0.05], [0, -0.15],
  ],
  // A parapet stands above the deck, so its whole section is positive.
  [TRIM_WHERE.PARAPET]: [
    [0, 0], [1, 0], [1, 0.85], [0.7, 1], [0, 1],
  ],
};

/** Below this a ring is not worth trimming. Square metres. */
const MIN_TRIM_AREA = 1e-4;

/** Most runs one node may emit, so a 200-storey string course cannot wedge a tab. */
export const MAX_TRIM_RUNS = 600;

const isUpper = level => level.kind !== LEVEL_KIND.PLINTH;

/**
 * The rings of a polygon, as stored.
 *
 * Holes included only on request: a cornice normally wraps a courtyard, but a
 * plinth around a light well that no one can enter is geometry nobody sees, and
 * on a tower with several wells it is most of the trim budget.
 */
function ringsOf(polygon, includeHoles) {
  const rings = [];
  if (polygon.outer?.length >= 3) rings.push(polygon.outer);
  if (includeHoles) {
    for (const hole of polygon.holes || []) if (hole.length >= 3) rings.push(hole);
  }
  return rings;
}

function runFromRing(ring, z, profileId, level, projection, depth) {
  const path = [];
  for (const point of ring) path.push(point[0], point[1], z);
  return { profileId, path, closed: true, level, projection, depth };
}

/**
 * Collect the levels a string course sits on top of.
 *
 * The TOP of a storey rather than the bottom of the next one, which are the same
 * height but not the same set: the topmost storey has no storey above it and
 * must not get a band, because that height is where the cornice goes and two
 * mouldings in one place is the most common way trim reads as wrong.
 */
function stringLevels(levels, every) {
  const storeys = levels.filter(isUpper);
  if (storeys.length < 2) return [];
  const top = Math.max(...storeys.map(level => level.index));
  const step = Math.max(1, Math.floor(every) || 1);
  return storeys.filter(level => level.index < top && (level.index + 1) % step === 0);
}

/**
 * Build the trim runs for one node.
 *
 * @param {object} options
 * @param {Array}  options.levels  the stack, from mass.stackMass
 * @param {object} options.roof    the roof, from roof.generateRoof (may be null)
 * @param {string} options.where   a TRIM_WHERE
 * @returns {{runs: Array, truncated: boolean}}
 */
export function generateTrim({
  levels = [],
  roof = null,
  where = TRIM_WHERE.CORNICE,
  every = 1,
  includeHoles = true,
  projection = 0.35,
  depth = 0.4,
} = {}) {
  const runs = [];
  const solid = levels.filter(level => polygonArea(level.polygon) > MIN_TRIM_AREA);
  if (!solid.length) return { runs, truncated: false };

  const push = (polygon, z, level) => {
    for (const ring of ringsOf(polygon, includeHoles)) {
      if (runs.length >= MAX_TRIM_RUNS) return;
      runs.push(runFromRing(ring, z, where, level, projection, depth));
    }
  };

  switch (where) {
    case TRIM_WHERE.PLINTH: {
      // The bottom of the stack, whatever that is: a plinth level if there is
      // one, otherwise the ground floor. Taking level 0 by index would land on
      // the ground floor of a building that HAS a plinth and bury the moulding.
      const bottom = Math.min(...solid.map(level => level.z0));
      for (const level of solid.filter(level => level.z0 === bottom)) {
        push(level.polygon, level.z0, level.index);
      }
      break;
    }

    case TRIM_WHERE.STRING:
      for (const level of stringLevels(solid, every)) push(level.polygon, level.z1, level.index);
      break;

    case TRIM_WHERE.EAVE: {
      // The roof's own base, not the top of the wall: on a roof with an overhang
      // those are different rings, and the eave belongs to the roof.
      const base = roof?.rungs?.[0];
      if (base) {
        for (const polygon of base.polygons) push(polygon, base.z, -1);
      } else {
        const top = Math.max(...solid.map(level => level.z1));
        for (const level of solid.filter(level => level.z1 === top)) {
          push(level.polygon, level.z1, level.index);
        }
      }
      break;
    }

    case TRIM_WHERE.PARAPET: {
      // A parapet stands on whatever the building actually ends on - the roof's
      // last rung if there is a roof, the top storey if not. On a pitched roof
      // that last rung is the ridge, which is the correct place for a ridge
      // capping and the wrong place for a parapet; the compiler warns rather
      // than silently drawing a fin along the ridge.
      const last = roof?.rungs?.[roof.rungs.length - 1];
      if (last) {
        for (const polygon of last.polygons) push(polygon, last.z, -1);
      } else {
        const top = Math.max(...solid.map(level => level.z1));
        for (const level of solid.filter(level => level.z1 === top)) {
          push(level.polygon, level.z1, level.index);
        }
      }
      break;
    }

    case TRIM_WHERE.CORNICE:
    default: {
      const top = Math.max(...solid.filter(isUpper).map(level => level.z1));
      for (const level of solid.filter(level => level.z1 === top)) {
        push(level.polygon, level.z1, level.index);
      }
      break;
    }
  }

  return { runs, truncated: runs.length >= MAX_TRIM_RUNS };
}

/**
 * A profile's cross-section, scaled to metres.
 *
 * Here rather than in the mesher so that the preview, an exporter and a test all
 * sweep the identical section - the whole reason the profile is data.
 */
export function trimSection(profileId, projection, height) {
  const base = TRIM_PROFILE[profileId] || TRIM_PROFILE[TRIM_WHERE.CORNICE];
  const out = Math.max(projection, 0);
  const up = Math.max(height, 0);
  return base.map(([o, u]) => [o * out, u * up]);
}
