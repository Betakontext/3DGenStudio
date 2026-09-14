// 2D polygon primitives. Pure arithmetic over plain arrays - no Clipper, no
// three.js, no allocation-heavy abstractions. Everything that needs to reason
// about a footprint *before* it becomes geometry lives here.
//
// THE REPRESENTATION, and why it is not flat arrays.
//
//   Ring         [[x, y], [x, y], ...]   implicitly closed; the last point is
//                                        NOT a repeat of the first
//   Polygon      { outer: Ring, holes: Ring[] }
//   MultiPolygon Polygon[]
//
// The IR stores flat coordinate arrays (see ir.js) because that is what makes a
// document diff-stable and cheap to hash. Working code uses [x, y] pairs because
// every routine here is about EDGES, and an edge is a pair of points - flat
// indices turn every loop into p[i*2], p[i*2+1], which is where sign errors come
// from. The conversion happens once, at the IR boundary, in ir.js.
//
// WINDING IS A LOAD-BEARING CONVENTION, not a detail:
//
//   outer rings are COUNTER-CLOCKWISE  (positive signed area)
//   holes       are CLOCKWISE          (negative signed area)
//
// This matches Clipper's own Area() sign and three.js's ShapeUtils.triangulateShape
// expectations, so a ring that travels through clip.js and out into meshing never
// needs a winding flip anywhere in between. Every function that RETURNS a ring
// here guarantees the convention; every function that ACCEPTS one tolerates
// either and normalises. That asymmetry is deliberate - it means a hand-authored
// footprint from the plan editor (where the user may draw either direction) is
// safe to feed anywhere.
//
// EPSILON. Distances are metres. The editor snaps to a grid no finer than 1mm,
// and clip.js quantises to 0.1mm when it hands work to Clipper, so 1e-7 m is far
// below anything representable and exists only to catch exact-zero degeneracies.

/** Below this, two coordinates are the same point. Metres. */
export const EPS = 1e-7;

/** Rings with fewer than this many distinct vertices cannot bound an area. */
export const MIN_RING_VERTICES = 3;

// Twice the signed area of a ring (the shoelace sum). Kept undoubled because the
// sign test and the degeneracy test both want it without the division, and
// halving a number only to compare it against zero loses a bit for nothing.
function shoelace(ring) {
  let sum = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum;
}

/** Signed area of a ring. Positive when counter-clockwise. */
export function signedArea(ring) {
  if (!Array.isArray(ring) || ring.length < MIN_RING_VERTICES) return 0;
  return shoelace(ring) / 2;
}

/** True when the ring winds counter-clockwise (positive signed area). */
export function isCCW(ring) {
  return signedArea(ring) > 0;
}

/**
 * A copy of the ring wound the requested way.
 *
 * Returns the SAME array instance when the winding already matches, because the
 * common case is "already correct" and the offset loop in roof.js calls this on
 * every ring of every step.
 */
export function ensureWinding(ring, wantCCW = true) {
  if (!Array.isArray(ring) || ring.length < MIN_RING_VERTICES) return ring;
  return isCCW(ring) === Boolean(wantCCW) ? ring : ring.slice().reverse();
}

/** Total edge length around a closed ring. */
export function perimeter(ring) {
  if (!Array.isArray(ring) || ring.length < 2) return 0;
  let total = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    total += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
  }
  return total;
}

/** Axis-aligned bounds of a ring, or null when it has no vertices. */
export function bounds(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Area-weighted centroid of a ring.
 *
 * NOT the average of the vertices: that is the centroid of the CORNERS, which
 * drifts toward whichever side the author happened to place more of them. A
 * facade rule that centres something on a wall would then be visibly off on any
 * footprint with uneven vertex density. Falls back to the vertex mean only when
 * the ring is degenerate and has no area to weight by.
 */
export function centroid(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return [0, 0];
  const a = signedArea(ring);
  if (Math.abs(a) < EPS) {
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    return [sx / ring.length, sy / ring.length];
  }
  let cx = 0, cy = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * cross;
    cy += (ring[j][1] + ring[i][1]) * cross;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/**
 * Point-in-ring by crossing number, boundary counted as inside.
 *
 * Boundary-inclusive on purpose: the callers are "is this slot on this face" and
 * "is this hole inside that outer", and in both a point that lands exactly on the
 * edge is a point that belongs. Excluding it makes a courtyard ring that touches
 * its outer wall register as outside, which reads as the hole silently vanishing.
 */
export function pointInRing(point, ring) {
  if (!Array.isArray(ring) || ring.length < MIN_RING_VERTICES) return false;
  const px = point[0];
  const py = point[1];
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];

    // On this edge? Then it is on the boundary, and the answer is yes.
    const dx = xj - xi, dy = yj - yi;
    const len2 = dx * dx + dy * dy;
    if (len2 > 0) {
      let t = ((px - xi) * dx + (py - yi) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(px - (xi + t * dx), py - (yi + t * dy)) < EPS) return true;
    } else if (Math.hypot(px - xi, py - yi) < EPS) {
      return true;
    }

    if ((yi > py) !== (yj > py)) {
      const xCross = xi + ((py - yi) / (yj - yi)) * (xj - xi);
      if (px < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Drop consecutive vertices closer together than eps, including the wrap pair. */
export function dedupeRing(ring, eps = EPS) {
  if (!Array.isArray(ring) || ring.length === 0) return [];
  const out = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) out.push([p[0], p[1]]);
  }
  // The wrap pair: the last vertex may have closed back onto the first.
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps) out.pop();
    else break;
  }
  return out;
}

/**
 * Drop vertices that lie on the straight line between their neighbours.
 *
 * Matters more than it looks: trim.js emits one moulding run per EDGE, so a wall
 * that Clipper handed back as three collinear segments would grow three cornice
 * runs with two seams in the middle of a flat wall. eps is a perpendicular
 * distance in metres, not an angle, because that is the quantity that decides
 * whether the seam is visible.
 */
export function removeCollinear(ring, eps = 1e-6) {
  const pts = dedupeRing(ring);
  if (pts.length < MIN_RING_VERTICES) return pts;
  const keep = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy);
    if (len < eps) { keep.push(cur); continue; }
    // Perpendicular distance from cur to the line prev->next.
    const dist = Math.abs((cur[0] - prev[0]) * dy - (cur[1] - prev[1]) * dx) / len;
    if (dist > eps) keep.push(cur);
  }
  return keep.length >= MIN_RING_VERTICES ? keep : pts;
}

/**
 * Clean a ring into the canonical form the rest of the generator assumes:
 * deduped, collinear-free, and wound the requested way.
 */
export function normalizeRing(ring, wantCCW = true) {
  return ensureWinding(removeCollinear(ring), wantCCW);
}

function orient(a, b, c) {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(v) < EPS ? 0 : (v > 0 ? 1 : -1);
}

function onSegment(a, b, p) {
  return Math.min(a[0], b[0]) - EPS <= p[0] && p[0] <= Math.max(a[0], b[0]) + EPS
      && Math.min(a[1], b[1]) - EPS <= p[1] && p[1] <= Math.max(a[1], b[1]) + EPS;
}

/** Proper or collinear-overlapping intersection of two closed segments. */
export function segmentsCross(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  if (d1 !== d2 && d3 !== d4) return true;
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

/** True when any two non-adjacent edges of the ring cross. */
export function selfIntersects(ring) {
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = ring[i], a2 = ring[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip edges that share a vertex - they touch by construction.
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsCross(a1, a2, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * Whether a ring is usable as a footprint boundary.
 *
 * Returns { ok, reason } rather than throwing, because every caller is either a
 * compiler phase that wants to emit a diagnostic or an editor that wants to paint
 * the offending ring red. Neither is served by an exception.
 *
 * Self-intersection uses the naive O(n^2) segment test. Footprints are drawn by
 * hand and are tens of vertices, not thousands; a sweep-line here would be more
 * code to get wrong for no measurable gain.
 */
export function validateRing(ring) {
  if (!Array.isArray(ring)) return { ok: false, reason: 'not-an-array' };
  const finite = ring.every(p => Array.isArray(p) && p.length >= 2
                             && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!finite) return { ok: false, reason: 'non-finite-vertex' };
  const pts = dedupeRing(ring);
  if (pts.length < MIN_RING_VERTICES) return { ok: false, reason: 'too-few-vertices' };
  // Self-intersection is tested BEFORE area, because a symmetric bowtie has
  // exactly zero signed area - its two lobes cancel - and would otherwise be
  // reported as 'zero-area'. Both reject it, but "your outline crosses itself"
  // is the message that tells the author what to do about it, and an asymmetric
  // bowtie would otherwise get a different reason from a symmetric one.
  if (selfIntersects(pts)) return { ok: false, reason: 'self-intersecting' };
  if (Math.abs(signedArea(pts)) < EPS) return { ok: false, reason: 'zero-area' };
  return { ok: true, reason: null };
}

/**
 * The edges of a ring, with the data every downstream pass actually asks for.
 *
 * normal is the OUTWARD unit normal for a counter-clockwise ring, which is what
 * the facade passes want: it is the direction a window faces. The ring is
 * normalised to CCW first so the normal is outward regardless of how the author
 * drew it - otherwise half the footprints in a project would extrude their
 * windows into the building.
 */
export function ringEdges(ring) {
  const pts = ensureWinding(ring, true);
  const n = pts.length;
  const edges = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    // For CCW winding the outward normal is (dy, -dx) normalised.
    const normal = length > EPS ? [dy / length, -dx / length] : [0, 0];
    edges.push({ index: i, a, b, dx, dy, length, normal });
  }
  return edges;
}

/** Total area of a polygon: its outer ring less every hole. */
export function polygonArea(polygon) {
  if (!polygon || !Array.isArray(polygon.outer)) return 0;
  let a = Math.abs(signedArea(polygon.outer));
  for (const hole of polygon.holes || []) a -= Math.abs(signedArea(hole));
  return a;
}

/** A polygon with its outer ring CCW and every hole CW. */
export function normalizePolygon(polygon) {
  return {
    outer: normalizeRing((polygon && polygon.outer) || [], true),
    holes: ((polygon && polygon.holes) || [])
      .map(h => normalizeRing(h, false))
      .filter(h => h.length >= MIN_RING_VERTICES),
  };
}

/** Translate every vertex of a ring. */
export function translateRing(ring, dx, dy) {
  return ring.map(p => [p[0] + dx, p[1] + dy]);
}

/** Scale a ring about origin (its own centroid when omitted). */
export function scaleRing(ring, sx, sy = sx, origin = null) {
  const o = origin || centroid(ring);
  return ring.map(p => [o[0] + (p[0] - o[0]) * sx, o[1] + (p[1] - o[1]) * sy]);
}

/** Rotate a ring by radians about origin (its own centroid when omitted). */
export function rotateRing(ring, radians, origin = null) {
  const o = origin || centroid(ring);
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return ring.map(p => {
    const dx = p[0] - o[0];
    const dy = p[1] - o[1];
    return [o[0] + dx * c - dy * s, o[1] + dx * s + dy * c];
  });
}
