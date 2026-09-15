// Roofs: the mass stack continued until it closes.
//
// THE CLAIM PHASE 1 MADE, NOW CASHED. mass.js argued that every style differs
// only in how the footprint changes as it rises, and that a roof is that same
// operation carried on past the top storey. This file is the test of it: there
// is no straight-skeleton implementation here, no roof-specific geometry engine,
// just the same polygon offset walking inward and a rule for how fast it rises.
//
// WHAT THAT BUYS. Hip, mansard and stepped roofs are one routine with different
// rise functions, and every one of them works on an arbitrary plan - an L, a U,
// a plan with a courtyard - because Clipper handles the topology changes. A
// long rectangle's offset collapses to a ridge; an L's collapses to two ridges
// meeting at a valley; a courtyard's outer and inner contours march toward each
// other and meet. None of that is special-cased.
//
// WHY NOT AN EXACT STRAIGHT SKELETON, which is the textbook answer: it is the
// classic "budget two days, spend three weeks" item - edge events, split events
// and numerical degeneracies - and it fails hard when it fails. Iterative
// offsetting is a discretised version of the same thing that degrades instead:
// too few steps makes a coarser roof, never a broken one. And because the inset
// and the rise are proportional, the bands all lie on the SAME plane, so a hip
// roof is geometrically exact rather than approximated - the subdivision is in
// the plan, not in the slope.
//
// THE OUTPUT IS A CONTOUR LADDER, not triangles. Each rung is a set of polygons
// at a height, and three consecutive rules cover every surface a roof has:
//
//   polygons differ, z differs   a sloping band   (hip, mansard)
//   polygons differ, z the same  a flat tread     (the horizontal part of a step)
//   polygons the same, z differs a vertical riser (the upright part of a step)
//
// Keeping it as contours is what lets this file stay in the pure contract: it
// needs no triangulator, the rungs intern into the same polygon table the levels
// use, and the IR stays small and inspectable. src/utils/building/mesh.js turns
// the ladder into geometry with the Earcut it already has.

import { differencePolygons, offsetPolygonList } from './clip.js';
import { polygonArea } from './poly.js';

/**
 * The roof shapes, all from one offset walk.
 *
 * Pyramid is deliberately absent: a hip roof on a plan with no long axis IS a
 * pyramid, and offering both would be two names for one result.
 */
export const ROOF_KIND = {
  /** No roof. The top of the stack is the roof. */
  FLAT: 'flat',
  /** Slopes in from every eave to a ridge. Pyramid on a square plan. */
  HIP: 'hip',
  /** Steep below, shallow above. The French attic storey. */
  MANSARD: 'mansard',
  /** Flat treads and vertical risers. Mayan platforms, ziggurats. */
  STEPPED: 'stepped',
  /** Stepped, with each tier oversailing the one below. Asian eaves. */
  TIERED: 'tiered',
  /**
   * Not selectable. What two chained Roof nodes of different shapes produce -
   * see stackRoofs. It exists so the IR can name the result honestly instead of
   * reporting the shape of whichever half happened to win.
   */
  STACKED: 'stacked',
};

/** Below this a contour has been consumed. Square metres. */
const MIN_CONTOUR_AREA = 1e-4;

/**
 * Most rungs a ladder may have.
 *
 * Each becomes a band of geometry, so this bounds the roof's triangle count and
 * - more importantly - guarantees the loop terminates even if an offset somehow
 * stops shrinking. A roof that stops early is a diagnostic; one that never
 * stops is a hung tab.
 */
export const MAX_ROOF_STEPS = 60;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The inset step to walk in, in metres.
 *
 * Derived from the plan's own scale rather than fixed: 2A/P is the inradius of a
 * circle with the same area-to-perimeter ratio, which is a good estimate of how
 * far a shape can be eroded before it vanishes. Dividing it gives roughly the
 * same number of rungs whether the roof is over a shed or a warehouse, so a
 * small building does not get a needlessly dense roof and a large one does not
 * get a coarse one.
 */
function stepFor(polygons) {
  let area = 0;
  let perimeter = 0;
  for (const polygon of polygons) {
    area += polygonArea(polygon);
    for (const ring of [polygon.outer, ...(polygon.holes || [])]) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
    }
  }
  if (!(area > 0) || !(perimeter > 0)) return 0.25;
  const inradius = (2 * area) / perimeter;
  return clamp(inradius / 8, 0.05, 2);
}

/**
 * How high the roof surface is at a given inset, per kind.
 *
 * This is the whole difference between the shapes. Everything else - the walk,
 * the topology handling, the closure - is shared.
 */
function riseAt(kind, inset, options) {
  const { pitch, breakInset, upperPitch } = options;
  switch (kind) {
    case ROOF_KIND.MANSARD: {
      // Steep to the break, then shallow. The break is where the attic windows
      // go, which is the entire reason the shape exists.
      if (inset <= breakInset) return inset * Math.tan(pitch);
      return breakInset * Math.tan(pitch) + (inset - breakInset) * Math.tan(upperPitch);
    }
    case ROOF_KIND.HIP:
    default:
      return inset * Math.tan(pitch);
  }
}

/**
 * Walk the offset inward, collecting rungs.
 *
 * Stops when the shape is consumed - which is how the roof knows it has closed,
 * and is why the Phase 0 spike mattered: Clipper returns an EMPTY list at the
 * moment a shape vanishes rather than a degenerate sliver, so "the last
 * non-empty contour" is the ridge and needs no special detection.
 */
function slopedLadder(base, baseZ, kind, options) {
  const step = stepFor(base);
  const rungs = [{ polygons: base, z: baseZ }];
  let inset = 0;
  let closed = false;

  for (let i = 0; i < MAX_ROOF_STEPS; i++) {
    inset += step;
    const next = offsetPolygonList(base, -inset, options.join)
      .filter(p => polygonArea(p) > MIN_CONTOUR_AREA);
    if (next.length === 0) {
      // The previous rung was the ridge. Nothing more to add - the mesher caps
      // whatever the ladder ends on.
      closed = true;
      break;
    }
    const rise = riseAt(kind, inset, options);

    // A capped roof stops at EXACTLY its height rather than at the first rung
    // past it. Checking after pushing overshoots by a whole step - a 60-degree
    // pitch on a large plan stepped 4.3m at a time and sailed past a 5m cap to
    // 8.7m - and a mansard's flat deck is supposed to be where the author put
    // it, not wherever the walk happened to land.
    if (options.maxHeight > 0 && rise > options.maxHeight) {
      const capped = insetForRise(kind, options.maxHeight, inset - step, inset, options);
      const deck = offsetPolygonList(base, -capped, options.join)
        .filter(p => polygonArea(p) > MIN_CONTOUR_AREA);
      if (deck.length) rungs.push({ polygons: deck, z: baseZ + options.maxHeight });
      // Capped, not closed: it ends on a flat deck, and the mesher caps that.
      break;
    }

    rungs.push({ polygons: next, z: baseZ + rise });
  }

  return { rungs, closed };
}

/**
 * A stepped ladder: flat treads and vertical risers.
 *
 * Emitted as EXPLICIT PAIRS rather than by sampling a staircase function,
 * because the two surfaces of a step are different rungs of the ladder - a tread
 * is two polygons at one height, a riser is one polygon at two heights - and
 * sampling would smear them into a slope.
 */
function steppedLadder(base, baseZ, options) {
  const { stepRun, stepRise, overhang } = options;
  const rungs = [{ polygons: base, z: baseZ }];
  let inset = 0;
  let z = baseZ;
  let closed = false;

  for (let i = 0; i < MAX_ROOF_STEPS; i++) {
    if (options.maxHeight > 0 && z + stepRise - baseZ > options.maxHeight) break;
    inset += stepRun;
    // A tier oversails the platform below it, which is what separates an Asian
    // roof from a ziggurat. At overhang 0 the two are the same shape.
    const tread = offsetPolygonList(base, -inset + overhang, options.join)
      .filter(p => polygonArea(p) > MIN_CONTOUR_AREA);
    if (tread.length === 0) { closed = true; break; }

    // Inward along the tread at the current height...
    rungs.push({ polygons: tread, z });
    // ...then straight up the riser, the same polygon at a new height.
    z += stepRise;
    rungs.push({ polygons: tread, z });
  }

  return { rungs, closed };
}

/**
 * Build a roof over the top of a stack.
 *
 * @param {object} options
 * @param {Array} options.polygons  the top surface, from mass.topOfStack
 * @param {number} options.baseZ    the height that surface sits at
 * @param {string} options.kind     a ROOF_KIND
 * @returns {{kind, rungs, height, closed, fallback}}
 */
export function generateRoof({
  polygons = [],
  baseZ = 0,
  kind = ROOF_KIND.HIP,
  pitch = 30,
  upperPitch = 12,
  breakFraction = 0.35,
  stepRun = 1.2,
  stepRise = 0.9,
  overhang = 0,
  maxHeight = 0,
  join = undefined,
} = {}) {
  const base = polygons.filter(p => polygonArea(p) > MIN_CONTOUR_AREA);
  const out = {
    kind,
    rungs: base.length ? [{ polygons: base, z: baseZ }] : [],
    height: 0,
    closed: true,
    fallback: null,
  };
  if (!base.length) return out;

  if (kind === ROOF_KIND.FLAT) return out;

  // Pitch arrives in degrees because that is how roofs are specified; radians
  // from here down.
  const options = {
    pitch: (clamp(pitch, 0.5, 85) * Math.PI) / 180,
    upperPitch: (clamp(upperPitch, 0, 85) * Math.PI) / 180,
    breakInset: 0,
    stepRun: Math.max(stepRun, 0.05),
    stepRise: Math.max(stepRise, 0.01),
    overhang: Math.max(overhang, 0),
    maxHeight: Math.max(maxHeight, 0),
    join,
  };

  // The mansard break is a fraction of how far the plan can be eroded at all,
  // so it lands in the same place on a small roof and a large one.
  if (kind === ROOF_KIND.MANSARD) {
    options.breakInset = Math.max(stepFor(base) * 2, clamp(breakFraction, 0.05, 0.95)
      * estimateMaxInset(base, options.join));
  }

  const built = (kind === ROOF_KIND.STEPPED || kind === ROOF_KIND.TIERED)
    ? steppedLadder(base, baseZ, options)
    : slopedLadder(base, baseZ, kind, options);

  // A roof that produced nothing but its own base could not be built at all -
  // a plan too small for one step. Falling back to flat keeps the building
  // intact and lets the compiler explain, which is always better than a roofless
  // building with no message.
  if (built.rungs.length <= 1) {
    return {
      kind: ROOF_KIND.FLAT,
      rungs: [{ polygons: base, z: baseZ }],
      height: 0,
      closed: true,
      fallback: 'too-small',
    };
  }

  out.kind = kind;
  out.rungs = built.rungs;
  out.closed = built.closed;
  out.height = built.rungs[built.rungs.length - 1].z - baseZ;
  return out;
}

/**
 * The inset that produces exactly `targetRise`.
 *
 * Bisected rather than inverted algebraically: `riseAt` is piecewise for a
 * mansard and will gain more cases, and one inversion that has to be kept in
 * step with it is one too many. Twenty halvings of a single step is exact to
 * well under a millimetre and runs once per capped roof.
 */
function insetForRise(kind, targetRise, lo, hi, options) {
  let low = Math.max(0, lo);
  let high = hi;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    if (riseAt(kind, mid, options) < targetRise) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Roughly how far this plan can be eroded before it vanishes.
 *
 * A doubling search rather than a formula: the inradius estimate is good for a
 * blob and poor for an L, and the mansard break wants the real number. Six
 * probes is enough to bracket it within a few per cent, and it runs once per
 * compile rather than per rung.
 */
function estimateMaxInset(base, join) {
  let lo = 0;
  let hi = stepFor(base);
  for (let i = 0; i < 12; i++) {
    const survives = offsetPolygonList(base, -hi, join)
      .some(p => polygonArea(p) > MIN_CONTOUR_AREA);
    if (!survives) break;
    lo = hi;
    hi *= 2;
  }
  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) / 2;
    const survives = offsetPolygonList(base, -mid, join)
      .some(p => polygonArea(p) > MIN_CONTOUR_AREA);
    if (survives) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * How a pair of rungs should be drawn. The three rules from the header.
 *
 * Exported so the mesher and the tests agree on the classification rather than
 * each deciding for itself - the difference between a tread and a riser is one
 * float comparison, and having two copies of it is how they drift.
 */
export function rungKind(a, b, epsilon = 1e-6) {
  const sameHeight = Math.abs(a.z - b.z) < epsilon;
  const sameShape = samePolygons(a.polygons, b.polygons, epsilon);
  if (sameShape && sameHeight) return 'none';
  if (sameShape) return 'riser';
  if (sameHeight) return 'tread';
  return 'slope';
}

function samePolygons(a, b, epsilon) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(polygonArea(a[i]) - polygonArea(b[i])) > epsilon) return false;
  }
  return true;
}

/**
 * The annulus between two rungs - the surface the mesher fills.
 *
 * A polygon difference rather than a vertex pairing, because the two rungs need
 * not have the same number of pieces: an L-plan's contour splits in two on the
 * way up, and there is no correspondence to pair. The difference copes with that
 * for free, and the mesher then only has to triangulate a polygon with holes.
 */
export function bandBetween(lower, upper) {
  return differencePolygons(lower.polygons, upper.polygons);
}

/**
 * The surface a roof ends on - what a second Roof node stands on.
 *
 * The LAST rung, not the highest: a ladder is built bottom-up and the last rung
 * is the ridge, the deck a height cap stopped at, or the top tread of a stepped
 * platform. Taking the maximum z instead would pick the wrong one of a stepped
 * roof's two rungs at the same height (tread and riser share it), and stacking
 * onto the tread would put the next roof inside the step.
 */
export function roofTop(roof) {
  if (!roof?.rungs?.length) return null;
  const last = roof.rungs[roof.rungs.length - 1];
  return { polygons: last.polygons, z: last.z };
}

/**
 * A roof that has closed to a ridge has no surface left to build on.
 *
 * `closed` alone is not the test: a FLAT roof is trivially closed and its top is
 * the whole plan, so it is a perfectly good base. What disqualifies a roof is
 * having closed *after rising* - the walk consumed the plan and the last rung is
 * the sliver that was left.
 */
export function roofIsCapped(roof) {
  return Boolean(roof && roof.closed && roof.height > 0);
}

/**
 * Continue one roof ladder with another.
 *
 * WHY STACKING RATHER THAN REPLACING is the whole point of allowing two Roof
 * nodes. The file header argues a roof is the massing continued past the top
 * storey; the same argument says a roof is a fine base for another roof. A
 * stepped platform with a hip cap is a Mayan temple, and a tiered roof over a
 * mansard is most of a pagoda - both of them things the vocabulary can already
 * describe and neither of them expressible if the second node overwrote the
 * first.
 *
 * The upper ladder's FIRST rung is dropped: generateRoof was handed the lower
 * roof's top as its base, so it re-emits that surface as its own rung 0 and
 * keeping both would leave a zero-height band for the mesher to triangulate.
 * That also makes stacking a no-op for an upper roof that produced nothing - a
 * Flat one, or one that fell back as too small - which is the right answer.
 */
export function stackRoofs(lower, upper) {
  if (!lower?.rungs?.length) return upper;
  if (!upper?.rungs?.length) return lower;

  const rungs = [...lower.rungs, ...upper.rungs.slice(1)];
  const baseZ = rungs[0].z;
  const added = upper.rungs.length > 1;
  return {
    // Two of the same shape read as one taller roof of that shape; two different
    // ones are honestly neither, and STACKED says so rather than picking a
    // winner. It is not a shape a Roof node can be set to - see ROOF_KIND.
    kind: !added ? lower.kind : (lower.kind === upper.kind ? lower.kind : ROOF_KIND.STACKED),
    rungs,
    height: rungs[rungs.length - 1].z - baseZ,
    closed: added ? upper.closed : lower.closed,
    fallback: added ? upper.fallback : lower.fallback,
  };
}
