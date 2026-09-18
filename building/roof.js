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
import { polygonArea, signedArea } from './poly.js';

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
function cutTo(base, frame, inset, kind, flip = false) {
  // A GABLE CLOSES FROM BOTH SIDES, a shed from one - and WHICH one is the only
  // thing that decides which way a shed falls. Without the flip the contour
  // always recedes from pHi, so the high edge is always at pLo and the same
  // building could only ever have its slope one way round: `ridge` picks the
  // AXIS, not the side, and across-vs-along only turns that axis 90 degrees.
  // Four directions need two axes and this.
  const shed = kind === ROOF_KIND.SHED;
  const lo = shed ? (flip ? frame.pLo + inset : frame.pLo) : frame.pLo + inset;
  const hi = shed && flip ? frame.pHi : frame.pHi - inset;
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
      const deck = cutTo(base, frame, capped, kind, options.flip);
      if (deck.length) rungs.push({ polygons: deck, z: baseZ + options.maxHeight });
      break;
    }

    const next = cutTo(base, frame, inset, kind, options.flip);
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
/**
 * The tall wall a SHED stands against.
 *
 * THE FACE NOBODY ASKED FOR AND EVERY SHED HAS. A gable closes from both sides,
 * so its only unroofed faces are the two ends, which endWalls draws. A shed
 * closes from ONE side: the contour marches away from a fixed edge, and that
 * fixed edge ends up metres above the wall it started on with nothing between
 * them. The result is a roof with a hole in its tall side - and because the
 * material is single-sided you do not see a hole, you see the sloping plane
 * vanish, which is how it was reported: "only one side of the faces is visible".
 *
 * TRACED FROM THE RUNGS, the same way and for the same reason as endWalls: the
 * ladder already knows how far the roof reaches at every height, so threading
 * those spans up one side and back down the other IS the wall - and it stays
 * right for a height-capped shed, for a non-rectangular plan, and for a plan
 * whose contour splits on the way up.
 *
 * Returns [] for anything that is not a shed, and for a shed whose contour never
 * moved (a zero-pitch roof has no wall to draw).
 */
/**
 * A vertical wall's outline, wound so the mesher's triangles face outward.
 *
 * WHY THIS IS MEASURED AND NOT POSITIONAL. These outlines are threaded up one
 * side of a profile and back down the other, so their winding follows WHICH side
 * recedes - and for a shed that is exactly what `flip` changes. Ordering the
 * points by hand therefore gets one of the two cases right and the other
 * backwards, which under a single-sided material is invisible: the wall does not
 * render as a hole, it simply is not there, and the slope behind it shows
 * through. That was the flipped shed's missing face.
 *
 * The invariant every wall in a correct roof satisfies is Newell(points) . out
 * being NEGATIVE - the mesher's own convention, established by the three walls of
 * an unflipped shed and both ends of a gable. Enforcing it directly means a new
 * way of building an outline cannot get this wrong again.
 *
 * @param {Array<Array<number>>} points the outline, in order
 * @param {Array<number>} out the direction the wall should face, in plan
 * @returns {Array<Array<number>>} the same points, possibly reversed
 */
function faceOutward(points, out) {
  // Newell's method: works for any planar polygon and needs no triangulation.
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
  }
  // Only the horizontal part matters: these walls are vertical, so their normal
  // has no z to speak of and `out` is a plan direction.
  return nx * out[0] + ny * out[1] > 0 ? points.slice().reverse() : points;
}

/**
 * The vertical closure a directional roof needs, as a SKIRT round the plan.
 *
 * WHAT THIS REPLACED, and why the old model could not be patched. A gable and a
 * shed used to be closed by flat walls standing on the plane through each
 * extreme of the ridge axis. That is only a plane when the axis lies along an
 * edge of the plan: turn the ridge to 70 degrees over a rectangle and the
 * extreme is a single CORNER, so every "wall" collapsed to a zero-width sliver
 * and the roof came out with no sides at all - visible as a floating slab you
 * can see straight through. It was broken for every angle except 0, 90 and 180,
 * for gables as well as sheds.
 *
 * THE HONEST MODEL is that a directional roof is a height field over the plan -
 * the height depends only on the coordinate ACROSS the ridge - so the closure is
 * the skirt between the plan's boundary and that surface. Where the roof meets
 * the wall head the skirt has no height and no wall is emitted; where it rises,
 * the skirt is the gable end, the shed's tall side, or anything in between.
 *
 * THE PROFILE IS SAMPLED ALONG EACH EDGE, not just at its ends, and that is the
 * detail that makes it work: an aligned gable's apex sits in the MIDDLE of its
 * end edge, so an edge measured only at its corners reads zero at both and would
 * emit nothing. Every rung bound the edge crosses becomes a sample.
 *
 * For an aligned plan this reproduces exactly what the old code did - two
 * triangles for a gable, a tall rectangle and two triangles for a shed - so the
 * rake trim that follows these outlines is unchanged in the common case.
 */
function boundaryWalls(rungs, axis) {
  if (rungs.length < 2) return [];
  const perp = [-axis[1], axis[0]];

  // What each rung covers ACROSS the ridge, and how high it is. A directional
  // roof's height depends on nothing else, which is what makes this a function
  // of one variable rather than a surface query.
  const spans = [];
  for (const rung of rungs) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const polygon of rung.polygons) {
      for (const point of polygon.outer) {
        const p = alongDir(point, perp);
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
    }
    if (Number.isFinite(lo)) spans.push({ lo, hi, z: rung.z });
  }
  if (spans.length < 2) return [];

  // THE SKIRT STANDS ON THE EAVE, not on the lowest rung. An eave drop adds a
  // fascia rung with the SAME contour at a lower z, and the ladder already draws
  // the band between them as a vertical riser all the way round - so measuring
  // from the bottom would put the skirt over the top of it and emit a wall along
  // every eave, where there should be none. The eave is the highest rung that
  // still spans the full width.
  let widest = 0;
  for (const span of spans) widest = Math.max(widest, span.hi - span.lo);
  let baseZ = spans[0].z;
  for (const span of spans) {
    if (span.hi - span.lo > widest - 1e-6 && span.z > baseZ) baseZ = span.z;
  }

  /** The roof's height above the eave at one coordinate across the ridge. */
  const heightAt = (p) => {
    let z = baseZ;
    for (const span of spans) {
      if (p >= span.lo - 1e-6 && p <= span.hi + 1e-6 && span.z > z) z = span.z;
    }
    return z - baseZ;  // never negative: baseZ is one of the covering rungs
  };

  // Where the profile changes slope: every rung bound. An edge crossing one of
  // these has to be split there or the skirt would chord across the apex.
  const breaks = [];
  for (const span of spans) breaks.push(span.lo, span.hi);
  breaks.sort((a, b) => a - b);

  const eave = rungs.find(rung => Math.abs(rung.z - baseZ) < 1e-9) || rungs[0];
  const walls = [];
  for (const polygon of eave.polygons) {
    const rings = [polygon.outer, ...(polygon.holes || [])];
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      if (!Array.isArray(ring) || ring.length < 3) continue;
      // A hole's skirt faces INTO the courtyard, which is the opposite way round
      // from the outer boundary's.
      const facing = (r === 0 ? 1 : -1) * (signedArea(ring) >= 0 ? 1 : -1);

      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const pA = alongDir(a, perp);
        const pB = alongDir(b, perp);

        // The parameters along the edge where the profile bends.
        const cuts = [0];
        if (Math.abs(pB - pA) > 1e-9) {
          for (const value of breaks) {
            const t = (value - pA) / (pB - pA);
            if (t > 1e-6 && t < 1 - 1e-6) cuts.push(t);
          }
        }
        cuts.push(1);
        cuts.sort((x, y) => x - y);

        const top = [];
        let tallest = 0;
        for (const t of cuts) {
          const x = a[0] + (b[0] - a[0]) * t;
          const y = a[1] + (b[1] - a[1]) * t;
          const h = heightAt(pA + (pB - pA) * t);
          tallest = Math.max(tallest, h);
          top.push([x, y, baseZ + h]);
        }
        // The roof meets the wall along the whole edge: an eave, and no wall.
        if (tallest < 1e-6) continue;

        // Round the base and back along the top.
        const points = [[a[0], a[1], baseZ], [b[0], b[1], baseZ]];
        for (let k = top.length - 1; k >= 0; k--) points.push(top[k]);

        const tidy = [];
        for (const point of points) {
          const last = tidy[tidy.length - 1];
          if (last && Math.abs(last[0] - point[0]) < 1e-9
            && Math.abs(last[1] - point[1]) < 1e-9
            && Math.abs(last[2] - point[2]) < 1e-9) continue;
          tidy.push(point);
        }
        if (tidy.length >= 3
          && Math.abs(tidy[0][0] - tidy[tidy.length - 1][0]) < 1e-9
          && Math.abs(tidy[0][1] - tidy[tidy.length - 1][1]) < 1e-9
          && Math.abs(tidy[0][2] - tidy[tidy.length - 1][2]) < 1e-9) tidy.pop();
        if (tidy.length < 3) continue;

        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        walls.push(faceOutward(tidy, [dy * facing, -dx * facing]));
      }
    }
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
  flip = false,
  eave = 0,
  eaveDrop = 0,
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
    // Shed only. Every other kind is symmetric about its ridge, so there is no
    // side to swap and setting it would be a control that does nothing.
    flip: kind === ROOF_KIND.SHED && flip === true,
    join,
  };

  // The mansard break is a fraction of how far the plan can be eroded at all,
  // so it lands in the same place on a small roof and a large one.
  if (kind === ROOF_KIND.MANSARD) {
    options.breakInset = Math.max(stepFor(base) * 2, clamp(breakFraction, 0.05, 0.95)
      * estimateMaxInset(base, options.join));
  }

  // THE EAVE OVERSAILS THE WALL, and it does so by starting the ladder OUTSIDE
  // the building and BELOW it. A roof plane is one plane: continue it past the
  // wall head and the edge necessarily drops, by exactly the rise it would have
  // gained over that distance - which is why an overhanging eave is what puts
  // the deep shadow line under a roof, and why this cannot be done by widening
  // the contour alone.
  //
  // ITS OWN CONTROL, separate from `overhang`. Stepped and Tiered already spend
  // `overhang` on something else - each tread oversails the one below, which is
  // the whole difference between an Asian roof and a ziggurat - so the two
  // cannot share a number. They also cannot share a DEFAULT: `overhang` carries
  // 0.6, and quietly reusing it here would have put a 0.6m eave on every roof of
  // every building already saved, none of whose authors ever saw the control.
  const perTier = kind === ROOF_KIND.STEPPED || kind === ROOF_KIND.TIERED;
  const oversail = perTier ? 0 : Math.max(eave, 0);
  let ladderBase = base;
  let ladderZ = baseZ;
  let drop = 0;
  if (oversail > 0) {
    const widened = offsetPolygonList(base, oversail, options.join)
      .filter(p => polygonArea(p) > MIN_CONTOUR_AREA);
    if (widened.length) {
      // Measured with the SAME rise function the ladder uses, so a mansard's
      // shallow lower pitch governs its eave rather than an average of the two.
      drop = riseAt(kind, oversail, options);
      ladderBase = widened;
      ladderZ = baseZ - drop;
      // The break keeps its place relative to the WALL, not to the new contour:
      // the author picked a fraction of the plan, and an eave is not plan.
      if (options.breakInset > 0) options.breakInset += oversail;
      // A height cap still means "this far above the top of the building". The
      // ladder now starts below that, so the cap has to travel with it or an
      // overhang would silently shorten every capped roof.
      if (options.maxHeight > 0) options.maxHeight += drop;
    }
  }

  const directional = kind === ROOF_KIND.GABLE || kind === ROOF_KIND.SHED;
  const built = directional
    ? directionalLadder(ladderBase, ladderZ, kind, options)
    : perTier
      ? steppedLadder(ladderBase, ladderZ, options)
      : slopedLadder(ladderBase, ladderZ, kind, options);

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
  // THE FASCIA: the eave edge carried straight down. One more rung with the
  // SAME contour at a lower z, so the band between them is vertical - the
  // mesher, the gable end walls and an eave trim all pick it up with no idea it
  // was added, because a riser is a shape the ladder already describes.
  const fascia = Math.max(eaveDrop, 0);
  if (fascia > 0 && out.rungs.length) {
    out.rungs = [{ polygons: out.rungs[0].polygons, z: out.rungs[0].z - fascia }, ...out.rungs];
  }
  out.closed = built.closed;
  // ALWAYS FROM THE TOP OF THE BUILDING, not from the eave. An overhang and a
  // fascia both start the ladder lower, and reporting the taller number would
  // make a roof look like it had grown when only its edge had dropped.
  out.height = built.rungs[built.rungs.length - 1].z - baseZ;
  if (directional) {
    // ONE SKIRT COVERS BOTH. A gable's two ends and a shed's tall side are the
    // same thing - the wall between the plan's boundary and the roof above it -
    // and building them from the boundary rather than from two chosen planes is
    // what makes a ridge at 70 degrees work at all. Still `gables`, because that
    // is what every consumer means by it: a vertical polygon travelling beside
    // the ladder, with a bargeboard along its verge.
    out.gables = boundaryWalls(out.rungs, options.ridgeAxis);
  }
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
    // GABLES SURVIVE THE STACK. An end wall is a real surface belonging to the
    // stage that made it, and dropping the field turned the one roof this
    // matters most for into an open-ended cone: a Gable capping a truncated Hip
    // is exactly irimoya, the hip-and-gable roof of every Japanese and Chinese
    // temple, and its whole point is the vertical tympanum at each end.
    //
    // The UNION rather than a winner. Two Gable stages each wall their own band
    // of the ladder and the bands cannot overlap, because the upper's rung 0 is
    // the lower's top rung and is dropped above. When the upper added nothing
    // it is discarded entirely, here as everywhere else in this function.
    gables: added
      ? [...(lower.gables || []), ...(upper.gables || [])]
      : (lower.gables || []),
  };
}
