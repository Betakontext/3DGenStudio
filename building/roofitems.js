// Things that stand ON the roof: chimneys, finials, vents, ridge crests.
//
// WHY THIS IS A SLOT AND NOT GEOMETRY. A chimney is the first thing anyone
// notices is missing from a generated house, and the tempting fix is a Chimney
// node that builds a tapered stack with a corbelled cap - a few hundred lines of
// geometry that can only ever make one kind of chimney. Everything needed to do
// it properly already exists instead: a slot carries a transform and a size, the
// compiler resolves it to a model list and rolls a variant from the seed, the
// loader normalises any GLB into a unit box, and the mesher instances it. So a
// chimney here is a PLACEMENT RULE, and what stands there is a model - which
// means a brick stack, a stone stack and a cyberpunk vent pipe are content
// rather than three more code paths.
//
// STANDING ON, NOT PASSING THROUGH. A real chimney is a shaft that penetrates
// the roof and continues down to a hearth. Cutting a hole through a contour
// ladder is a boolean against a surface that is not a solid, and at the scale
// anyone looks at these buildings the difference is invisible: the stack is
// placed so its foot is buried below the roof surface and it reads correctly.
// Said out loud because it is a real limitation, not an oversight.
//
// THE LADDER IS THE ONLY INPUT. roof.js already reduced every roof shape - hip,
// gable, mansard, stepped, tiered - to rungs of polygons at heights, so placing
// on "the ridge" or "a third of the way up the slope" is the same arithmetic for
// all of them, and a new roof kind gets roof items for free.

import { instanceSeed, slotId } from './random.js';
import { SLOT_TYPE } from './ir.js';

/** Where on the roof an item stands. */
export const ROOF_WHERE = {
  /** Along the topmost contour: the ridge of a pitch, the far edge of a deck. */
  RIDGE: 'ridge',
  /** Along a contour part of the way up, so a stack rises out of a slope. */
  SLOPE: 'slope',
  /** One item at the very top, centred. Finials and spires. */
  APEX: 'apex',
  /** Along the roof's lowest contour: the eaves line. */
  EAVE: 'eave',
};

/** What the item is. Only a tag - it selects the model list and the material. */
export const ROOF_ITEM = {
  CHIMNEY: 'chimney',
  FINIAL: 'finial',
  VENT: 'vent',
  CREST: 'crest',
};

/** A roof with fewer rungs than this has no surface worth standing on. */
const MIN_RUNGS = 1;

/** Hard ceiling, for the same reason facade.js has one: a slider cannot wedge the tab. */
export const MAX_ROOF_ITEMS = 200;

/**
 * The perimeter of a ring, and the point a given distance along it.
 *
 * Walked as a POLYLINE rather than sampled by angle, because a roof contour is
 * not convex - an L-plan's ridge is an L - and an angular sweep would bunch
 * items at the corners and miss the long runs entirely.
 */
function ringWalk(ring) {
  // DUPLICATE AND NEAR-DUPLICATE POINTS FIRST. A closed pitch ends in a sliver
  // whose two long edges are microns apart, and a ridge stored as four points
  // that are really two is the normal case rather than the exotic one.
  const distinct = [];
  for (const point of ring) {
    const last = distinct[distinct.length - 1];
    if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < 1e-6) continue;
    distinct.push(point);
  }
  while (distinct.length > 1) {
    const first = distinct[0];
    const last = distinct[distinct.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) >= 1e-6) break;
    distinct.pop();
  }

  // A RIDGE IS A LINE, NOT A LOOP, and treating it as a loop is the bug this
  // exists to prevent: a run of four chimneys put two of them on top of the
  // other two, mirrored, because the walk went out along the ridge and back.
  //
  // AREA IS THE WRONG TEST, which cost a round: a gable's top rung is a real
  // four-point polygon 16m long and ONE MILLIMETRE wide, so its area is 0.016
  // and no epsilon distinguishes that from a small deck. Its WIDTH does -
  // 2 x area / perimeter is the mean width of a strip, and a roof contour
  // narrower than 5cm is a line whatever its area works out to.
  const points = ring.length >= 3 ? distinct : ring;
  const walk = meanWidth(points) < 0.05 ? centreline(points) : closedLoop(distinct);
  return walk;
}

/** 2 x area / perimeter: the mean width of a strip, in metres. */
function meanWidth(ring) {
  if (ring.length < 3) return 0;
  let area = 0;
  let perimeter = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a[0] * b[1] - b[0] * a[1];
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  if (!(perimeter > 1e-9)) return 0;
  return Math.abs(area) / perimeter;
}

/**
 * A thin contour collapsed to the line down its middle.
 *
 * Its own boundary is useless here: walking it covers the ridge twice, once up
 * each side. Projecting every point onto the contour's LONGEST axis and taking
 * the mean offset gives the line an author means by "the ridge", and gives it
 * once.
 */
function centreline(ring) {
  let a = ring[0];
  let b = ring[0];
  let best = -1;
  for (const p of ring) {
    for (const q of ring) {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d > best) { best = d; a = p; b = q; }
    }
  }
  if (!(best > 1e-9)) return { segments: [], total: 0, open: true };

  const axis = [(b[0] - a[0]) / best, (b[1] - a[1]) / best];
  const perp = [-axis[1], axis[0]];
  let offset = 0;
  for (const p of ring) offset += (p[0] - a[0]) * perp[0] + (p[1] - a[1]) * perp[1];
  offset /= ring.length;

  const from = [a[0] + perp[0] * offset, a[1] + perp[1] * offset];
  const to = [b[0] + perp[0] * offset, b[1] + perp[1] * offset];
  return {
    segments: [{ a: from, b: to, length: best, at: 0 }],
    total: best,
    open: true,
  };
}

function closedLoop(ring) {
  const segments = [];
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1e-9) continue;
    segments.push({ a, b, length, at: total });
    total += length;
  }
  return { segments, total, open: false };
}

/**
 * A point and a direction at a distance along a walk.
 *
 * Returns the EDGE DIRECTION as well as the point, so an item can be turned to
 * face along the ridge it stands on - a chimney is rectangular and a chimney
 * turned 40 degrees off its ridge looks like a mistake.
 */
function pointAt(walk, distance) {
  if (!walk.segments.length) return null;
  // An OPEN walk clamps rather than wraps: running off the end of a ridge and
  // reappearing at its start is what a loop does, and a ridge is not one.
  const want = walk.open
    ? Math.min(walk.total, Math.max(0, distance))
    : ((distance % walk.total) + walk.total) % walk.total;
  for (const segment of walk.segments) {
    if (want <= segment.at + segment.length || segment === walk.segments[walk.segments.length - 1]) {
      const t = Math.min(1, Math.max(0, (want - segment.at) / segment.length));
      return {
        point: [
          segment.a[0] + (segment.b[0] - segment.a[0]) * t,
          segment.a[1] + (segment.b[1] - segment.a[1]) * t,
        ],
        dir: [
          (segment.b[0] - segment.a[0]) / segment.length,
          (segment.b[1] - segment.a[1]) / segment.length,
        ],
      };
    }
  }
  return null;
}

/** The centroid of a ring, for the apex case. */
function centroidOf(ring) {
  let x = 0;
  let y = 0;
  for (const point of ring) { x += point[0]; y += point[1]; }
  return [x / ring.length, y / ring.length];
}

/**
 * Which rung an item stands on, and the ring within it.
 *
 * A DEGENERATE RUNG IS STILL A PLACE. When a pitched roof closes, its last rung
 * is a two-point sliver or a single point - which is exactly the ridge, and
 * exactly where a chimney belongs. Rejecting rings with fewer than three points
 * (the usual polygon guard) would throw away the most useful case.
 */
function rungFor(roof, where, along) {
  const rungs = roof?.rungs || [];
  if (rungs.length < MIN_RUNGS) return null;
  if (where === ROOF_WHERE.EAVE) return rungs[0];
  if (where === ROOF_WHERE.RIDGE || where === ROOF_WHERE.APEX) return rungs[rungs.length - 1];
  // SLOPE: a fraction of the way up the ladder, never the very bottom (that is
  // the eave) and never the very top (that is the ridge).
  const t = Math.min(1, Math.max(0, Number(along) || 0));
  const index = Math.round(1 + t * Math.max(0, rungs.length - 2));
  return rungs[Math.min(rungs.length - 1, Math.max(0, index))];
}

/**
 * Place items on one roof.
 *
 * @param {object} options
 * @param {object} options.roof      a roof from roof.generateRoof
 * @param {number} options.seed
 * @param {string} options.nodeId
 * @param {object} options.rule      { where, item, count, along, width, depth, height, sink }
 * @returns {{slots: Array, truncated: boolean, reason: string}}
 */
export function placeRoofItems({ roof, seed = 0, nodeId = 'roofitem', rule = {} } = {}) {
  const {
    where = ROOF_WHERE.RIDGE,
    item = ROOF_ITEM.CHIMNEY,
    count = 1,
    along = 0.5,
    width = 0.9,
    depth = 0.9,
    height = 2.4,
    // HOW FAR THE FOOT IS BURIED. Without it a stack placed exactly on a contour
    // floats over the pitch between two rungs, because the ladder is a staircase
    // approximating a slope and the surface is below the contour almost
    // everywhere. Sinking it is what makes it look attached.
    sink = 0.35,
  } = rule;

  const out = { slots: [], truncated: false, reason: '' };
  const rung = rungFor(roof, where, along);
  if (!rung) { out.reason = 'no-roof'; return out; }

  const rings = rung.polygons || [];
  const ring = rings[0]?.outer || rings[0] || [];
  if (!ring.length) { out.reason = 'no-surface'; return out; }

  const wanted = Math.max(1, Math.min(MAX_ROOF_ITEMS, Math.floor(count) || 1));
  const variantSlot = slotId(nodeId, 'variant');
  const z = rung.z - sink + height / 2;

  const push = (point, dir, index) => {
    // X along the contour, Y up, Z out of it - the same frame a wall slot uses,
    // so a model authored for an opening is authored for a chimney too.
    const [dx, dy] = dir;
    out.slots.push({
      type: SLOT_TYPE.ROOF_ITEM,
      styleSlot: item,
      source: nodeId,
      transform: [
        dx, dy, 0, 0,
        0, 0, 1, 0,
        dy, -dx, 0, 0,
        point[0], point[1], z, 1,
      ],
      cellW: width,
      cellH: height,
      cellD: depth,
      // A roof item has no storey and no bay. faceIndex is the item's position
      // in its own run, which is what makes its seed stable when a neighbouring
      // one is removed - the same argument as bayIndex on a wall.
      faceIndex: index,
      floorIndex: -1,
      bayIndex: index,
      seedKey: instanceSeed(seed, variantSlot, { face: index, floor: -1, bay: index, sub: 3 }),
    });
  };

  if (where === ROOF_WHERE.APEX || ring.length < 2) {
    // One item, centred. A closed pitch ends in a point or a sliver, and its
    // centroid is the apex however many points it has.
    push(centroidOf(ring), [1, 0], 0);
    return out;
  }

  const walk = ringWalk(ring);
  if (!walk.total) { push(centroidOf(ring), [1, 0], 0); return out; }

  // EVENLY SPACED WITH AN OFFSET, not starting at the first vertex: a single
  // chimney asked for at `along` 0.5 belongs half way along the ridge, and a
  // run of three belongs at the thirds rather than one sitting on a corner.
  const step = walk.total / wanted;
  // On a CLOSED contour the run may start anywhere and wrap; on an OPEN one
  // `along` would only push items off the far end, so it is ignored and the run
  // is centred in each of its own equal shares instead.
  const offset = walk.open
    ? 0
    : walk.total * Math.min(1, Math.max(0, Number(along) || 0));
  for (let i = 0; i < wanted; i++) {
    const found = pointAt(walk, offset + step * (i + 0.5) - (walk.open ? 0 : step / 2));
    if (found) push(found.point, found.dir, i);
  }
  if (wanted >= MAX_ROOF_ITEMS) out.truncated = true;
  return out;
}
