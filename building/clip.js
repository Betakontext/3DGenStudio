// The Clipper boundary: polygon booleans and offsetting, in metres.
//
// This is the only file in the generator that knows clipper-lib exists. Mass
// stacking, roofs and courtyard cuts all reduce to "offset this polygon" or
// "combine these two polygons", and both are problems with a long history of
// people underestimating them. Clipper is the standard answer, and wrapping it
// in one place means the rest of the code speaks in rings of metres and never
// sees an integer point or a PolyFillType.
//
// WHY CLIPPER AND NOT A HAND-WRITTEN OFFSETTER. Offsetting a polygon inward is
// easy right up until the moment the polygon CHANGES TOPOLOGY - a U-shaped plan
// offset past the thickness of its base stops being one polygon and becomes two.
// That is not an edge case for us, it is the main case: it is exactly what
// happens under every hip roof, and it is what a naive "move each edge inward
// and re-intersect" approach gets wrong. Measured during the Phase 0 spike on a
// U with 6m arms and a 2m base: one path at d=-0.9, two symmetric paths at
// d=-1.1, empty at d=-3.1. Clipper does this correctly and we do not.
//
// THE INTEGER SCALE IS PART OF THE CONTRACT. Clipper works on 64-bit integers,
// so every coordinate is multiplied by SCALE, rounded, and divided back on the
// way out. SCALE is therefore a QUANTISATION, and it is load-bearing twice over:
//
//   1. Determinism. Two runs that round the same way produce byte-identical
//      output, which is what lets compile.js promise a stable IR. Changing SCALE
//      changes generated geometry for every existing document, so treat it the
//      way you would treat a document format version.
//   2. Robustness. Snapping to a 0.1mm lattice collapses the near-degenerate
//      slivers that hand-drawn footprints are full of, which is why Clipper is
//      well behaved on input a floating-point offsetter would choke on.
//
// 1e4 gives 0.1mm resolution and leaves ~9e14 of headroom before the 2^53 limit
// where a double stops representing integers exactly - about 9e10 metres. The
// editor clamps footprints to a few hundred metres, so there is no path to
// overflow that is not already a bug somewhere else.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO: decide when an offset has collapsed.
// Clipper returns an EMPTY path list at the moment a shape vanishes, not a
// degenerate ridge - a 20x8 rectangle offsets to a 4-vertex sliver at -3.99 and
// to nothing at -4.0. Turning "the last non-empty ring" into a roof ridge is a
// roofing decision and lives in roof.js.

import ClipperLib from 'clipper-lib';
import { MIN_RING_VERTICES, normalizeRing, removeCollinear } from './poly.js';

/**
 * Metres -> Clipper integer units. 1e4 == 0.1mm resolution.
 *
 * Changing this changes the geometry every stored building generates. See the
 * header: it is a format constant, not a tuning knob.
 */
export const SCALE = 1e4;

/**
 * Miter limit handed to ClipperOffset.
 *
 * 2.0 means a miter may extend at most twice the offset distance before Clipper
 * squares it off. Architecture is full of acute corners (any non-orthogonal
 * plan), and an unbounded miter sends the corner vertex to infinity, which shows
 * up as a single spike shooting out of an otherwise correct building.
 */
export const MITER_LIMIT = 2.0;

/**
 * Arc tolerance for round joins, in Clipper units - so 100 == 1 cm.
 *
 * Only jtRound pays this: it is the most a flattened arc may deviate from the
 * true curve. Clipper's own examples use a quarter of a unit, which at our SCALE
 * is 25 MICRONS, and that is catastrophic here rather than merely precise: a
 * single 2m-radius corner then flattens to ~157 segments, and one rounded
 * rectangle came out with 632 vertices. Every one of those becomes wall
 * geometry, per storey.
 *
 * A centimetre is finer than any building is built to and gives about eight
 * segments per corner. Changing it changes generated geometry, so it belongs
 * with SCALE as a format constant rather than a tuning knob.
 */
export const ARC_TOLERANCE = 100;

/** Join styles, re-exported so callers never import clipper-lib themselves. */
export const JOIN = {
  /** Sharp corners, bounded by MITER_LIMIT. The default for architecture. */
  MITER: ClipperLib.JoinType.jtMiter,
  /** Rounded corners. Curved shells, futurist massing, soft roof eaves. */
  ROUND: ClipperLib.JoinType.jtRound,
  /** Chamfered corners. Cheap approximation of a bevel. */
  SQUARE: ClipperLib.JoinType.jtSquare,
};

const FILL = ClipperLib.PolyFillType.pftNonZero;

// A ring of [x, y] metre pairs -> a Clipper integer path.
function toClipper(ring) {
  const path = new ClipperLib.Path();
  for (const p of ring) {
    path.push(new ClipperLib.IntPoint(Math.round(p[0] * SCALE), Math.round(p[1] * SCALE)));
  }
  return path;
}

// A Clipper integer path -> a ring of [x, y] metre pairs.
//
// The division is exact for any value Clipper can produce at this SCALE, but the
// result is still rounded to 1e-9 to stop a 0.30000000000000004 appearing in a
// serialised IR and making two identical buildings compare unequal.
function fromClipper(path) {
  const ring = [];
  for (const p of path) {
    ring.push([
      Math.round((p.X / SCALE) * 1e9) / 1e9,
      Math.round((p.Y / SCALE) * 1e9) / 1e9,
    ]);
  }
  return ring;
}

function toClipperPaths(rings) {
  const paths = new ClipperLib.Paths();
  for (const ring of rings) {
    if (Array.isArray(ring) && ring.length >= MIN_RING_VERTICES) paths.push(toClipper(ring));
  }
  return paths;
}

function fromClipperPaths(paths) {
  const out = [];
  for (const path of paths) {
    if (path.length >= MIN_RING_VERTICES) out.push(fromClipper(path));
  }
  return out;
}

/**
 * A polygon { outer, holes } as the flat ring list Clipper wants.
 *
 * Clipper has no notion of "hole" on input: it infers containment from winding
 * under the non-zero fill rule, so an outer CCW ring and a CW inner ring is all
 * it needs. normalizeRing guarantees exactly that, which is why the winding
 * convention in poly.js is described there as load-bearing rather than stylistic.
 */
export function polygonToRings(polygon) {
  if (!polygon) return [];
  const rings = [];
  const outer = normalizeRing(polygon.outer || [], true);
  if (outer.length >= MIN_RING_VERTICES) rings.push(outer);
  for (const hole of polygon.holes || []) {
    const h = normalizeRing(hole, false);
    if (h.length >= MIN_RING_VERTICES) rings.push(h);
  }
  return rings;
}

/**
 * A flat ring list back into polygons, pairing every hole with its outer.
 *
 * Clipper hands back an unordered pile of rings whose only clue to nesting is
 * the winding, so a CCW ring starts a polygon and a CW ring is a hole belonging
 * to one of them. Assignment is by CONTAINMENT, not by array order: a document
 * with two separate wings each having a courtyard produces four rings in no
 * guaranteed order, and pairing them positionally would put one wing's courtyard
 * in the other wing.
 *
 * Containment is tested with a point sampled from the hole against each outer
 * ring, smallest-area outer first. Smallest-first matters for nested massing -
 * a light well inside a courtyard inside a block belongs to the courtyard, and
 * testing the largest first would hand it to the block.
 */
export function ringsToPolygons(rings) {
  const outers = [];
  const holes = [];
  for (const ring of rings) {
    const cleaned = removeCollinear(ring);
    if (cleaned.length < MIN_RING_VERTICES) continue;
    let sum = 0;
    for (let i = 0, j = cleaned.length - 1; i < cleaned.length; j = i++) {
      sum += (cleaned[j][0] - cleaned[i][0]) * (cleaned[j][1] + cleaned[i][1]);
    }
    (sum / 2 > 0 ? outers : holes).push(cleaned);
  }

  const polygons = outers.map(outer => ({ outer, holes: [] }));
  if (polygons.length === 0) return [];

  const ranked = polygons
    .map((poly, index) => {
      let sum = 0;
      const r = poly.outer;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        sum += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
      }
      return { index, area: Math.abs(sum / 2) };
    })
    .sort((a, b) => a.area - b.area);

  for (const hole of holes) {
    const probe = hole[0];
    let owner = -1;
    for (const candidate of ranked) {
      if (pointInside(probe, polygons[candidate.index].outer)) { owner = candidate.index; break; }
    }
    // A hole with no containing outer is geometrically meaningless - it can only
    // arise from input that was already invalid - so it is dropped rather than
    // attached to an arbitrary polygon, where it would punch a void through a
    // wall somewhere else in the building.
    if (owner >= 0) polygons[owner].holes.push(hole);
  }
  return polygons;
}

// Local crossing-number test. Deliberately not poly.pointInRing: that one counts
// the boundary as inside, which is right for slot placement but wrong here -
// two rings that share an edge would each claim the other's holes.
function pointInside(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > point[1]) !== (yj > point[1])) {
      const x = xi + ((point[1] - yi) / (yj - yi)) * (xj - xi);
      if (point[0] < x) inside = !inside;
    }
  }
  return inside;
}

/**
 * Offset every ring of a polygon by `delta` metres. Negative shrinks.
 *
 * Returns a LIST of polygons, because one polygon in does not mean one polygon
 * out - see the header. An empty list means the shape vanished, which callers
 * must treat as a normal outcome rather than a failure: it is how a roof knows
 * it has closed.
 */
export function offsetPolygon(polygon, delta, join = JOIN.MITER) {
  return offsetRings(polygonToRings(polygon), delta, join);
}

/** Offset a flat ring list. The primitive `offsetPolygon` is written in terms of. */
export function offsetRings(rings, delta, join = JOIN.MITER) {
  if (!rings.length) return [];
  // A zero offset must still round-trip through normalisation so callers get the
  // same cleaning they would get from any other delta, but Clipper treats 0 as a
  // no-op that can return the input unchanged including any collinear runs.
  const co = new ClipperLib.ClipperOffset(MITER_LIMIT, ARC_TOLERANCE);
  co.AddPaths(toClipperPaths(rings), join, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta * SCALE);
  return ringsToPolygons(fromClipperPaths(out));
}

function booleanOp(subjectPolygons, clipPolygons, clipType) {
  const clipper = new ClipperLib.Clipper();
  const subjectRings = [];
  for (const p of subjectPolygons) subjectRings.push(...polygonToRings(p));
  const clipRings = [];
  for (const p of clipPolygons) clipRings.push(...polygonToRings(p));

  if (subjectRings.length) clipper.AddPaths(toClipperPaths(subjectRings), ClipperLib.PolyType.ptSubject, true);
  if (clipRings.length) clipper.AddPaths(toClipperPaths(clipRings), ClipperLib.PolyType.ptClip, true);

  const out = new ClipperLib.Paths();
  clipper.Execute(clipType, out, FILL, FILL);
  return ringsToPolygons(fromClipperPaths(out));
}

/** Union of two polygon lists. */
export function unionPolygons(a, b = []) {
  return booleanOp(a, b, ClipperLib.ClipType.ctUnion);
}

/** `a` with `b` removed. How a courtyard becomes a hole. */
export function differencePolygons(a, b) {
  return booleanOp(a, b, ClipperLib.ClipType.ctDifference);
}

/** The overlap of two polygon lists. */
export function intersectPolygons(a, b) {
  return booleanOp(a, b, ClipperLib.ClipType.ctIntersection);
}

/** Everything in exactly one of the two lists. */
export function xorPolygons(a, b) {
  return booleanOp(a, b, ClipperLib.ClipType.ctXor);
}

/**
 * Collapse a polygon list onto itself.
 *
 * A union with nothing, which is Clipper's idiom for "resolve self-intersections
 * and redundant vertices into a clean set of simple polygons". The plan editor
 * can produce a footprint that overlaps itself; running it through here turns
 * that into the shape the user visually drew instead of rejecting it.
 */
export function cleanPolygons(polygons) {
  return unionPolygons(polygons, []);
}

/**
 * Offset a whole polygon LIST at once.
 *
 * Together rather than one at a time: two polygons that grow into each other
 * have to merge, and offsetting them separately would leave overlapping solids
 * that the mesher would draw one inside the other.
 */
export function offsetPolygonList(polygons, delta, join = JOIN.MITER) {
  const rings = [];
  for (const polygon of polygons) rings.push(...polygonToRings(polygon));
  if (!rings.length) return [];
  return offsetRings(rings, delta, join);
}

/**
 * Round off the corners of a plan, by `radius` metres.
 *
 * WHY THIS EXISTS AT ALL. The obvious implementation of a "rounded corners"
 * option is to hand Clipper jtRound and let the profile's own offset do the
 * work, and it does not survive contact with a building:
 *
 *   - a STRAIGHT profile offsets by zero, so nothing is ever rounded;
 *   - an INWARD offset (batter, setback) puts no arc on a convex corner at all,
 *     because a round join only rounds the outside of a turn;
 *   - an OUTWARD offset (jetty) rounds every storey EXCEPT the ground floor,
 *     whose inset is zero.
 *
 * So the control appeared to do nothing, or to round some storeys and not
 * others, depending on a profile the author was not thinking about. Rounding has
 * to be its own operation on the plan, applied before anything is stacked.
 *
 * HOW: a morphological opening followed by a closing, both with round joins.
 * Eroding then dilating by r rounds every CONVEX corner; dilating then eroding
 * rounds every REFLEX one. Doing both is what makes the inside of an L-shaped
 * plan round the same way its outside does.
 *
 * The side effect is inherent and worth knowing: an opening deletes anything
 * narrower than 2r, and a closing fills any notch narrower than 2r. A radius
 * larger than half the thinnest wing will therefore simplify the plan rather
 * than round it - which is why an empty result falls back to the input instead
 * of deleting the building.
 */
export function filletPolygons(polygons, radius) {
  if (!(radius > 0) || !polygons.length) {
    return { polygons, applied: false, reason: radius > 0 ? 'empty' : null };
  }

  const opened = offsetPolygonList(
    offsetPolygonList(polygons, -radius, JOIN.ROUND), radius, JOIN.ROUND,
  );
  // The radius ate the whole plan. Keeping the sharp original is the only sane
  // answer: a corner setting must never delete the building.
  if (!opened.length) return { polygons, applied: false, reason: 'vanished' };

  const closed = offsetPolygonList(
    offsetPolygonList(opened, radius, JOIN.ROUND), -radius, JOIN.ROUND,
  );
  const out = closed.length ? closed : opened;

  // More solids out than in means the radius severed a wing rather than rounding
  // it. Also a refusal - a building must not silently come apart.
  if (out.length > polygons.length) return { polygons, applied: false, reason: 'split' };

  return { polygons: out, applied: true, reason: null };
}

/** Signed area in square metres, via Clipper, for cross-checking poly.js. */
export function clipperArea(ring) {
  return ClipperLib.Clipper.Area(toClipper(ring)) / (SCALE * SCALE);
}
