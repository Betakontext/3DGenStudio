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

import { differencePolygons, intersectPolygons, offsetPolygonList } from './clip.js';
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
  /** Two slopes to a ridge, with VERTICAL end walls. The ordinary house roof. */
  GABLE: 'gable',
  /** One slope, from a low edge to a high one. Lean-tos, sheds, modern boxes. */
  SHED: 'shed',
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
 * Which way the ridge runs.
 *
 * THE DEFINING DECISION OF A GABLE, which is why it is a control and not a
 * guess. `long` is right almost always - a gabled roof runs along the building -
 * but a terrace of houses gables ACROSS its long axis onto the street, and
 * nothing in the plan says which of those was meant.
 */
export const RIDGE = {
  /** Along the plan's longest axis. What a house does. */
  LONG: 'long',
  /** Across it. What a terrace facing the street does. */
  ACROSS: 'across',
  /** A bearing set by hand. */
  CUSTOM: 'custom',
};

/** How far a point is along a unit direction. */
const alongDir = (point, dir) => point[0] * dir[0] + point[1] * dir[1];

/**
 * The plan's long axis - the direction a ridge should run.
 *
 * MEASURED BY THE NARROWEST PERPENDICULAR, not by the longest extent, and the
 * difference is not subtle. On a 20x10 rectangle the longest extent is the
 * DIAGONAL at 22.4m, so "the direction with the greatest extent" answers 26
 * degrees and puts the ridge across the corners - which then made a 45-degree
 * gable 8.1m tall instead of 5m, because the span it closes over is the
 * perpendicular one. What a ridge wants is the axis the building is THIN across,
 * and that is the minimum-width direction's perpendicular.
 *
 * Sampled over ninety directions rather than by rotating calipers: same answer,
 * far less code, and the extra precision is meaningless when it feeds a control
 * a person will override the moment they disagree.
 */
export function longestAxis(polygons) {
  const points = [];
  for (const polygon of polygons) points.push(...(polygon.outer || []));
  if (points.length < 2) return [1, 0];

  let best = [1, 0];
  let narrowest = Infinity;
  for (let degrees = 0; degrees < 180; degrees += 1) {
    const radians = (degrees * Math.PI) / 180;
    const dir = [Math.cos(radians), Math.sin(radians)];
    const perp = [-dir[1], dir[0]];
    let lo = Infinity;
    let hi = -Infinity;
    for (const point of points) {
      const t = alongDir(point, perp);
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    if (hi - lo < narrowest) { narrowest = hi - lo; best = dir; }
  }
  return best;
}

/** The ridge direction for a plan, as a unit vector. */
export function ridgeDirection(polygons, ridge = RIDGE.LONG, angleDegrees = 0) {
  if (ridge === RIDGE.CUSTOM) {
    const radians = (Number(angleDegrees) || 0) * (Math.PI / 180);
    return [Math.cos(radians), Math.sin(radians)];
  }
  const longest = longestAxis(polygons);
  return ridge === RIDGE.ACROSS ? [-longest[1], longest[0]] : longest;
}

/** A rectangle covering everything between two offsets along `perp`. */
function slab(centre, axis, perp, reach, lo, hi) {
  const at = (a, p) => [
    centre[0] + axis[0] * a + perp[0] * p,
    centre[1] + axis[1] * a + perp[1] * p,
  ];
  return { outer: [at(-reach, lo), at(reach, lo), at(reach, hi), at(-reach, hi)], holes: [] };
}

/** The plan cut down by `inset`: from both sides for a gable, one for a shed. */
function cutTo(base, frame, inset, kind) {
  const lo = kind === ROOF_KIND.SHED ? frame.pLo : frame.pLo + inset;
  const hi = frame.pHi - inset;
  if (hi - lo < 1e-9) return [];
  return intersectPolygons(base, [slab(frame.centre, frame.axis, frame.perp, frame.reach, lo, hi)])
    .filter(polygon => polygonArea(polygon) > MIN_CONTOUR_AREA);
}

/** Everything the directional walk needs to know about the plan, measured once. */
function ridgeFrame(base, axis) {
  const perp = [-axis[1], axis[0]];
  let cx = 0;
  let cy = 0;
  let points = 0;
  let pLo = Infinity;
  let pHi = -Infinity;
  let aSpan = 0;
  for (const polygon of base) {
    for (const point of polygon.outer) {
      cx += point[0];
      cy += point[1];
      points += 1;
      const p = alongDir(point, perp);
      if (p < pLo) pLo = p;
      if (p > pHi) pHi = p;
      aSpan = Math.max(aSpan, Math.abs(alongDir(point, axis)));
    }
  }
  if (!points) return null;
  const centre = [cx / points, cy / points];
  return {
    axis,
    perp,
    centre,
    pLo: pLo - alongDir(centre, perp),
    pHi: pHi - alongDir(centre, perp),
    // Generous: the slab has to cover the plan along the ridge whatever the
    // centroid does, and one that stopped short would clip the building.
    reach: aSpan + Math.abs(alongDir(centre, axis)) + (pHi - pLo) + 10,
  };
}

/**
 * A gable or a shed: the plan is cut down in ONE direction, not offset inward.
 *
 * WHY THIS IS NOT THE OFFSET WALK every other roof uses. Offsetting moves every
 * edge, which is exactly what makes a hip roof a hip roof - all four sides
 * slope. A gable slopes only the two sides facing across the ridge and leaves
 * the ends VERTICAL, so its contour has to shrink along one axis and not the
 * other: an intersection with a narrowing slab, not an inset.
 *
 * The bands between contours then come out right for free, because the three
 * rung rules do not care how a contour got smaller. What they cannot express is
 * the vertical END WALL, which is not between two contours at all - see
 * endWalls, and see the note in ir.js on why the IR carries it separately.
 */
function directionalLadder(base, baseZ, kind, options) {
  const frame = ridgeFrame(base, options.ridgeAxis);
  if (!frame) return { rungs: [], closed: false };

  // Half the span for a gable - it closes from both sides at once - and the
  // whole span for a shed, which closes from one.
  const width = frame.pHi - frame.pLo;
  const span = kind === ROOF_KIND.SHED ? width : width / 2;
  if (!(span > 1e-6)) return { rungs: [], closed: false };

  // THE WALK STOPS A HAIR SHORT OF THE RIDGE, on purpose. At exactly `span` the
  // slab has zero width and the contour vanishes, so the last rung that survives
  // is one step BELOW the apex - which made a 45-degree gable over a 10m span
  // 4.58m tall instead of 5m, an eight per cent error nobody would attribute to
  // the step count. Walking to span minus a ten-thousandth instead puts the top
  // rung within a fraction of a millimetre of the ridge and leaves a sliver the
  // cap covers, exactly as the offset walk's last non-empty contour does.
  const limit = span * (1 - 1e-4);
  const step = limit / 12;
  const rungs = [{ polygons: base, z: baseZ }];
  let inset = 0;
  let closed = false;

  for (let i = 0; i < MAX_ROOF_STEPS; i++) {
    inset = Math.min(inset + step, limit);
    const rise = inset * Math.tan(options.pitch);

    // Checked BEFORE pushing, for the reason slopedLadder spells out: checking
    // after overshoots the cap by a whole step.
    if (options.maxHeight > 0 && rise > options.maxHeight) {
      const capped = options.maxHeight / Math.tan(options.pitch);
      const deck = cutTo(base, frame, capped, kind);
      if (deck.length) rungs.push({ polygons: deck, z: baseZ + options.maxHeight });
      break;
    }

    const next = cutTo(base, frame, inset, kind);
    if (!next.length) { closed = true; break; }
    rungs.push({ polygons: next, z: baseZ + rise });
    // The ridge has been reached; anything further is slivers.
    if (inset >= limit - 1e-12) { closed = true; break; }
  }

  return { rungs, closed };
}

/**
 * The vertical end walls a gable or a shed needs.
 *
 * THE PART THE CONTOUR LADDER CANNOT SAY, and the reason these two roofs were
 * held back out of Phase 3. Every other roof surface is the band BETWEEN two
 * contours. A gable end is not between anything - it is the flat triangle that
 * closes the roof where the contours did not shrink, and nothing in "polygons at
 * a height" describes it. So it travels beside the ladder as its own polygons.
 *
 * TRACED FROM THE RUNGS rather than derived from the pitch. Each rung that still
 * reaches the end plane contributes the span it covers there, and threading
 * those spans up one side and back down the other IS the gable outline. That
 * costs nothing extra and works unchanged for a shed (one triangle, right
 * angled), for a height-capped roof (the outline stops at the deck) and for a
 * plan that is not a rectangle.
 */
function endWalls(rungs, axis) {
  if (rungs.length < 2) return [];
  const perp = [-axis[1], axis[0]];

  let aLo = Infinity;
  let aHi = -Infinity;
  for (const polygon of rungs[0].polygons) {
    for (const point of polygon.outer) {
      const a = alongDir(point, axis);
      if (a < aLo) aLo = a;
      if (a > aHi) aHi = a;
    }
  }
  if (!Number.isFinite(aLo)) return [];

  const walls = [];
  for (const [end, outward] of [[aHi, 1], [aLo, -1]]) {
    const profile = [];
    for (const rung of rungs) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const polygon of rung.polygons) {
        for (const point of polygon.outer) {
          // On the end plane, within a millimetre. A rung that has pulled away
          // from the end contributes nothing, which is what stops a contour that
          // shrank in both directions from inventing a wall it does not need.
          if (Math.abs(alongDir(point, axis) - end) > 1e-3) continue;
          const p = alongDir(point, perp);
          if (p < lo) lo = p;
          if (p > hi) hi = p;
        }
      }
      if (!Number.isFinite(lo) || hi - lo < -1e-9) break;
      profile.push({ lo, hi, z: rung.z });
    }
    if (profile.length < 2) continue;

    const at = (p, z) => [
      axis[0] * end + perp[0] * p,
      axis[1] * end + perp[1] * p,
      z,
    ];
    const points = [];
    for (const entry of profile) points.push(at(entry.lo, entry.z));
    for (let i = profile.length - 1; i >= 0; i--) {
      // The apex is ONE point, not two: a ridge that closed to nothing would
      // otherwise leave a zero-width sliver at the top of every gable.
      if (i === profile.length - 1 && profile[i].hi - profile[i].lo < 1e-6) continue;
      points.push(at(profile[i].hi, profile[i].z));
    }
    // Wound so both ends face outward - the far one is the mirror of the near
    // one, and a wall lit from inside is invisible until it is shaded.
    if (points.length >= 3) walls.push(outward > 0 ? points : points.slice().reverse());
  }
  return walls;
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
  ridge = RIDGE.LONG,
  ridgeAngle = 0,
  join = undefined,
} = {}) {
  const base = polygons.filter(p => polygonArea(p) > MIN_CONTOUR_AREA);
  const out = {
    kind,
    rungs: base.length ? [{ polygons: base, z: baseZ }] : [],
    height: 0,
    closed: true,
    fallback: null,
    // Vertical end walls, for the two shapes that have them. Empty for every
    // other roof, so a consumer can walk it without asking what kind this is.
    gables: [],
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
    ridgeAxis: ridgeDirection(base, ridge, ridgeAngle),
    join,
  };

  // The mansard break is a fraction of how far the plan can be eroded at all,
  // so it lands in the same place on a small roof and a large one.
  if (kind === ROOF_KIND.MANSARD) {
    options.breakInset = Math.max(stepFor(base) * 2, clamp(breakFraction, 0.05, 0.95)
      * estimateMaxInset(base, options.join));
  }

  const directional = kind === ROOF_KIND.GABLE || kind === ROOF_KIND.SHED;
  const built = directional
    ? directionalLadder(base, baseZ, kind, options)
    : (kind === ROOF_KIND.STEPPED || kind === ROOF_KIND.TIERED)
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
  if (directional) out.gables = endWalls(built.rungs, options.ridgeAxis);
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
