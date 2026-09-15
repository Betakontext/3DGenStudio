// Which way a wall faces, as a name a person can use.
//
// WHY COMPASS BUCKETS AND NOT EDGE INDICES. The obvious identifier for "this
// side of the building" is the index of the ring edge that makes it, and it is
// the wrong one: edge indices renumber the moment the author inserts a vertex,
// so "the brick on side 2" silently becomes the brick on a different side. A
// bearing does not renumber. It also matches how anyone actually talks about a
// building - the street front faces south, the yard is at the back - and it
// works unchanged on an L-plan, a courtyard, or a plan with fifty edges, where
// an edge index would mean nothing at all.
//
// FOUR BUCKETS, NOT EIGHT. A building whose north-east wall is a different
// material from its north wall is not a thing anyone asks for, and the
// forty-five degree boundary is already the awkward case; halving it again
// doubles the awkwardness for no use. A wall at exactly 45 degrees resolves
// deterministically - see below - rather than by float luck.

/** The four sides. `''` is the wildcard: "any side", not a fifth side. */
export const SIDE = {
  NORTH: 'north',
  EAST: 'east',
  SOUTH: 'south',
  WEST: 'west',
};

/** In the order a person reads them off a compass rose. */
export const SIDE_ORDER = [SIDE.NORTH, SIDE.EAST, SIDE.SOUTH, SIDE.WEST];

const SIDE_SET = new Set(SIDE_ORDER);

/** Whether a string names a side. `''` (any) is deliberately NOT a side. */
export function isSide(value) {
  return SIDE_SET.has(value);
}

/**
 * The side a wall with this outward normal belongs to.
 *
 * The IR is Z-up with X east and Y north - see ir.js - so the normal's own
 * components are the bearing and no trigonometry is needed. Comparing |nx| and
 * |ny| with >= puts a wall at exactly 45 degrees on the EAST/WEST side
 * consistently rather than wherever the last float bit fell, which is what makes
 * a diagonal building's materials stable between two compiles.
 *
 * @param {number} nx outward normal, east component
 * @param {number} ny outward normal, north component
 * @returns {string} a SIDE
 */
export function sideOfNormal(nx, ny) {
  const x = Number(nx) || 0;
  const y = Number(ny) || 0;
  if (Math.abs(x) >= Math.abs(y)) return x >= 0 ? SIDE.EAST : SIDE.WEST;
  return y >= 0 ? SIDE.NORTH : SIDE.SOUTH;
}

/**
 * The side an edge from a to b faces, walking a ring AS STORED.
 *
 * The same (dy, -dx) normal facade.js, trim.js and mesh.js all use: with outer
 * rings counter-clockwise and holes clockwise it points away from the solid on
 * both, so a courtyard's north wall is the one whose face you see looking north.
 */
export function sideOfEdge(a, b) {
  return sideOfNormal(b[1] - a[1], -(b[0] - a[0]));
}

/** A label for the UI. Short, because it sits in a narrow panel. */
export const SIDE_LABEL = {
  [SIDE.NORTH]: 'North',
  [SIDE.EAST]: 'East',
  [SIDE.SOUTH]: 'South',
  [SIDE.WEST]: 'West',
};
