// Massing: turning one footprint into a stack of levels.
//
// THE ONE IDEA THIS FILE IS BUILT ON. Nearly every architectural style in the
// brief differs in HOW THE FOOTPRINT CHANGES AS IT RISES, and all of those
// changes are the same operation - offset the polygon by some amount that
// depends on height:
//
//   Roman / European    no change            inset = 0
//   Egyptian            battered walls       inset grows linearly with height
//   Aztec / Mayan       stepped platforms    inset grows in discrete steps
//   American            setback tower        inset steps at a few thresholds
//   Medieval            jettied upper floors inset goes NEGATIVE (outward)
//   Futurist            cantilever           inset goes negative, sharply
//   Asian               slight taper         inset grows gently
//
// So there is one routine here, not seven, and a style pack chooses a profile
// rather than selecting a different code path. That is what makes "any kind of
// building" a data problem instead of an ever-growing switch - and it is the
// claim the Phase 4 falsification test is designed to break if it is wrong.
//
// A ROOF IS THE SAME OPERATION CONTINUED UNTIL IT CLOSES, which is why roof.js
// is a thin layer over this file's `offsetFootprint` rather than a separate
// geometry engine. See its header.
//
// LEVELS ARE NOT NECESSARILY ONE POLYGON EACH. Offsetting a U-shaped or
// H-shaped plan far enough splits it into several disconnected pieces - the
// arms survive after the base between them has been consumed. So a storey can
// emit MORE THAN ONE level record, all sharing the same `index`. Anything that
// wants "the storey" must group by index rather than assuming a 1:1 mapping;
// clip.test.mjs pins the behaviour that makes this happen.

import { offsetPolygon, filletPolygons, JOIN } from './clip.js';
import { normalizePolygon, polygonArea } from './poly.js';
import { sampleCurve } from './param.js';
import { LEVEL_KIND } from './ir.js';

/**
 * How the inset varies with height.
 *
 * These are NOT different algorithms - every one of them is evaluated by
 * `insetAt` into a number of metres. They exist as named modes because a mode
 * picks a shape the author can reason about, and because the compiler can branch
 * on it at author time to show the right controls.
 */
export const MASS_PROFILE = {
  /** Walls rise vertically. The default, and correct for most styles. */
  STRAIGHT: 'straight',
  /** A continuous inward lean. Egyptian pylons, gentle Asian taper. */
  BATTER: 'batter',
  /** Discrete inward steps. Mayan platforms, American setback towers. */
  SETBACK: 'setback',
  /** Continuous OUTWARD growth. Medieval jetties, futurist cantilevers. */
  JETTY: 'jetty',
  /** An explicit [t, inset] table, sampled linearly. Anything else. */
  CURVE: 'curve',
};

/** Below this the remaining polygon is treated as consumed. Metres squared. */
const MIN_LEVEL_AREA = 1e-4;

/** A sane ceiling, so a runaway level count cannot hang the browser. */
export const MAX_LEVELS = 200;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Sample a profile curve at normalised height `t`. Metres.
 *
 * The curve is a vfx/curve.js curve - see building/param.js for why that type
 * rather than a new one - so it carries per-key interpolation and tangents, and
 * an author gets easing rather than only straight lines between points. Values
 * are METRES, not normalised: the numbers on the graph are the numbers in the
 * building.
 *
 * Held flat outside 0..1 rather than extrapolated: an extrapolated profile can
 * send the inset anywhere one level past the end of the curve and make the
 * building vanish for no visible reason. evalCurve's CLAMP wrap does this.
 */
export function sampleProfileCurve(curve, t) {
  const v = sampleCurve(curve, t);
  return Number.isFinite(v) ? v : 0;
}

/**
 * The inset, in metres, for one level.
 *
 * Positive shrinks the footprint, negative grows it. This is the whole of the
 * style-to-massing mapping described in the header.
 *
 * @param {object} profile { mode, amount, step, every, curve }
 * @param {number} index  the level's index, counted from the ground
 * @param {number} count  total levels, for normalising height
 * @returns {number} metres
 */
export function insetAt(profile, index, count) {
  const mode = profile?.mode || MASS_PROFILE.STRAIGHT;
  const amount = Number.isFinite(Number(profile?.amount)) ? Number(profile.amount) : 0;
  // t is 0 at the ground and 1 at the top level. A single-level building has no
  // range to normalise over, so it sits at the bottom of the profile rather than
  // dividing by zero and taking the full amount.
  const t = count > 1 ? index / (count - 1) : 0;

  switch (mode) {
    case MASS_PROFILE.BATTER:
      return amount * t;
    case MASS_PROFILE.JETTY:
      return -amount * t;
    case MASS_PROFILE.SETBACK: {
      // `every` is in LEVELS, and a step happens on the level where the division
      // rolls over. Guarded at 1 because `every: 0` would divide by zero and a
      // fractional value would step unpredictably.
      const every = Math.max(1, Math.floor(Number(profile?.every) || 1));
      const step = Number.isFinite(Number(profile?.step)) ? Number(profile.step) : 0;
      return Math.floor(index / every) * step;
    }
    case MASS_PROFILE.CURVE:
      return sampleProfileCurve(profile?.curve, t);
    case MASS_PROFILE.STRAIGHT:
    default:
      return 0;
  }
}

/**
 * Offset a footprint, returning the polygons that survive.
 *
 * A thin wrapper over clip.offsetPolygon that skips the round trip when the
 * inset is zero - which is the common case (MASS_PROFILE.STRAIGHT), and Clipper
 * is not free. Exported because roof.js walks the same ladder.
 */
export function offsetFootprint(footprint, inset, join = JOIN.MITER) {
  if (Math.abs(inset) < 1e-9) {
    const normalized = normalizePolygon(footprint);
    return normalized.outer.length ? [normalized] : [];
  }
  return offsetPolygon(footprint, -inset, join);
}

/**
 * Per-level heights.
 *
 * The ground floor gets its own height because it always differs - taller, with
 * the door - and a grammar that pretends otherwise produces buildings that read
 * as wrong. A plinth, when present, sits below the ground floor and is not
 * counted as a storey.
 */
function levelHeights({ levelCount, groundHeight, levelHeight, plinthHeight }) {
  const heights = [];
  if (plinthHeight > 0) heights.push({ height: plinthHeight, kind: LEVEL_KIND.PLINTH });
  for (let i = 0; i < levelCount; i++) {
    if (i === 0) heights.push({ height: groundHeight, kind: LEVEL_KIND.GROUND });
    else heights.push({ height: levelHeight, kind: LEVEL_KIND.UPPER });
  }
  return heights;
}

/**
 * Stack a footprint into levels.
 *
 * @param {object} options
 * @param {{outer: Array, holes?: Array}} options.footprint
 * @param {number} [options.levelCount]   storeys above the plinth
 * @param {number} [options.groundHeight] metres
 * @param {number} [options.levelHeight]  metres
 * @param {number} [options.plinthHeight] metres, 0 for none
 * @param {object} [options.profile]      see insetAt
 * @param {number} [options.join]         a JOIN constant
 * @returns {{levels: Array, height: number, truncatedAt: number|null, footprintArea: number, floorArea: number}}
 */
export function stackMass({
  footprint,
  levelCount = 3,
  groundHeight = 4,
  levelHeight = 3,
  plinthHeight = 0,
  profile = null,
  join = JOIN.MITER,
  cornerRadius = 0,
} = {}) {
  const base = normalizePolygon(footprint || { outer: [], holes: [] });
  const result = {
    levels: [],
    height: 0,
    truncatedAt: null,
    footprintArea: 0,
    floorArea: 0,
    cornerRadiusTooLarge: false,
  };
  if (base.outer.length < 3) return result;

  result.footprintArea = polygonArea(base);

  const count = Math.floor(clampNumber(levelCount, 0, MAX_LEVELS, 3));
  if (count <= 0 && !(plinthHeight > 0)) return result;

  const ground = clampNumber(groundHeight, 0.1, 100, 4);
  const upper = clampNumber(levelHeight, 0.1, 100, 3);
  const plinth = clampNumber(plinthHeight, 0, 100, 0);

  const heights = levelHeights({
    levelCount: count, groundHeight: ground, levelHeight: upper, plinthHeight: plinth,
  });

  // Each level's z1 becomes the next level's z0 by assignment, not by both
  // being recomputed from a height sum. That makes contiguity EXACT - there is
  // no gap under the roof of a forty-storey building - even though the running
  // total itself still differs from the same sum in another order by a float
  // ulp or so, which is far below the micron the IR quantises to.
  let z = 0;
  let storey = 0;
  // Keyed by inset, because a straight profile asks for the same one on every
  // storey and a fillet is four Clipper passes.
  const cache = new Map();

  for (const entry of heights) {
    const z0 = z;
    const z1 = z + entry.height;
    z = z1;

    // A plinth is not a storey: it sits below the ground floor, takes the
    // uninset footprint, and does not advance the index the profile is sampled
    // at. Numbering it 0 would push the ground floor to 1 and shift every
    // seeded choice in the building by one level.
    const isPlinth = entry.kind === LEVEL_KIND.PLINTH;
    const index = isPlinth ? 0 : storey;
    const inset = isPlinth ? 0 : insetAt(profile, storey, count);

    const pieces = roundedOffset(base, inset, join, cornerRadius, cache, result);
    const solid = pieces.filter(piece => polygonArea(piece) > MIN_LEVEL_AREA);

    if (solid.length === 0) {
      // The profile consumed the footprint. That is a legitimate end to a
      // stepped pyramid rather than an error, so the stack simply stops here and
      // the caller is told where - compile.js turns it into a diagnostic only if
      // levels were actually lost.
      result.truncatedAt = isPlinth ? 0 : storey;
      result.height = z0;
      return result;
    }

    for (const piece of solid) {
      result.levels.push({
        polygon: piece,
        z0,
        z1,
        kind: entry.kind,
        index,
      });
      result.floorArea += polygonArea(piece);
    }

    if (!isPlinth) storey++;
  }

  result.height = z;
  return result;
}

/**
 * One level's plan: the profile's offset, then the corner treatment.
 *
 * ROUNDING COMES AFTER THE OFFSET, PER LEVEL, and that ordering is the whole
 * point. Filleting the base once and then stacking looks equivalent and is not:
 * eroding a rounded shape by more than its corner radius consumes the arcs
 * entirely, so a battered tower came out rounded at the bottom and sharp at the
 * top. Rounding each level after it has been offset is what makes "Rounded"
 * mean the same thing on every storey, which is what the control promises.
 *
 * Cached by inset: a straight profile asks for the identical offset on every
 * storey, and a fillet is four Clipper passes.
 */
function roundedOffset(base, inset, join, cornerRadius, cache, result) {
  const key = `${inset}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const offset = offsetFootprint(base, inset, join);
  let pieces = offset;
  if (cornerRadius > 0 && offset.length) {
    const filleted = filletPolygons(offset, cornerRadius);
    if (filleted.applied) pieces = filleted.polygons;
    else if (filleted.reason) result.cornerRadiusTooLarge = true;
  }
  cache.set(key, pieces);
  return pieces;
}

/**
 * The topmost surface of a stack, as polygons.
 *
 * What a roof is built on. Returns the pieces of the highest level rather than
 * the original footprint, because a battered or stepped mass has a smaller top
 * than bottom and roofing the footprint would float the roof out past the walls.
 */
export function topOfStack(stack) {
  if (!stack?.levels?.length) return { z: 0, polygons: [] };
  let top = -Infinity;
  for (const level of stack.levels) if (level.z1 > top) top = level.z1;
  return {
    z: top,
    polygons: stack.levels.filter(level => level.z1 === top).map(level => level.polygon),
  };
}
