// node building/poly.test.mjs
//
// Plain-node tests, no harness - same convention as vfx/*.test.mjs.

import assert from 'node:assert/strict';
import {
  EPS, bounds, centroid, dedupeRing, ensureWinding, isCCW, normalizePolygon,
  normalizeRing, perimeter, pointInRing, polygonArea, removeCollinear,
  ringEdges, rotateRing, scaleRing, segmentsCross, selfIntersects, signedArea,
  translateRing, validateRing,
} from './poly.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const SQUARE_CCW = [[0, 0], [10, 0], [10, 10], [0, 10]];
const SQUARE_CW = [[0, 0], [0, 10], [10, 10], [10, 0]];
const L_SHAPE = [[0, 0], [12, 0], [12, 4], [4, 4], [4, 12], [0, 12]];

test('signedArea is positive for CCW and negative for CW', () => {
  assert.equal(signedArea(SQUARE_CCW), 100);
  assert.equal(signedArea(SQUARE_CW), -100);
});

test('signedArea of a degenerate ring is zero', () => {
  assert.equal(signedArea([[0, 0], [1, 1]]), 0);
  assert.equal(signedArea([]), 0);
  // Three collinear points bound no area.
  assert.equal(signedArea([[0, 0], [1, 0], [2, 0]]), 0);
});

test('isCCW agrees with the sign of the area', () => {
  assert.equal(isCCW(SQUARE_CCW), true);
  assert.equal(isCCW(SQUARE_CW), false);
});

test('ensureWinding returns the same instance when already correct', () => {
  // Identity, not just equality: the roof offset loop calls this per ring per
  // step, and a copy there would be pure garbage generation.
  assert.equal(ensureWinding(SQUARE_CCW, true), SQUARE_CCW);
  assert.notEqual(ensureWinding(SQUARE_CW, true), SQUARE_CW);
  assert.equal(isCCW(ensureWinding(SQUARE_CW, true)), true);
});

test('perimeter measures the closed loop, including the wrap edge', () => {
  assert.equal(perimeter(SQUARE_CCW), 40);
});

test('bounds covers the ring', () => {
  const b = bounds(L_SHAPE);
  assert.deepEqual([b.minX, b.minY, b.maxX, b.maxY], [0, 0, 12, 12]);
  assert.equal(b.width, 12);
  assert.equal(b.height, 12);
  assert.equal(bounds([]), null);
});

test('centroid is area-weighted, not the vertex mean', () => {
  assert.deepEqual(centroid(SQUARE_CCW), [5, 5]);

  // The failure this guards: extra vertices along one edge must not drag the
  // centroid toward that edge. The vertex mean here would be pulled to x < 5.
  const denseLeft = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 7], [0, 4], [0, 2]];
  const c = centroid(denseLeft);
  assert.ok(Math.abs(c[0] - 5) < 1e-9, `centroid drifted to x=${c[0]}`);
  assert.ok(Math.abs(c[1] - 5) < 1e-9, `centroid drifted to y=${c[1]}`);
});

test('centroid falls back to the vertex mean on a zero-area ring', () => {
  assert.deepEqual(centroid([[0, 0], [2, 0], [4, 0]]), [2, 0]);
});

test('pointInRing counts the boundary as inside', () => {
  assert.equal(pointInRing([5, 5], SQUARE_CCW), true);
  assert.equal(pointInRing([15, 5], SQUARE_CCW), false);
  // A courtyard ring touching its outer wall must not read as outside.
  assert.equal(pointInRing([0, 5], SQUARE_CCW), true, 'on an edge');
  assert.equal(pointInRing([0, 0], SQUARE_CCW), true, 'on a vertex');
});

test('pointInRing handles the concave notch of an L', () => {
  assert.equal(pointInRing([2, 2], L_SHAPE), true);
  assert.equal(pointInRing([8, 2], L_SHAPE), true);
  assert.equal(pointInRing([8, 8], L_SHAPE), false, 'the notch is outside');
});

test('dedupeRing drops repeats including the wrap pair', () => {
  assert.deepEqual(dedupeRing([[0, 0], [0, 0], [10, 0], [10, 10], [0, 0]]),
                   [[0, 0], [10, 0], [10, 10]]);
});

test('removeCollinear deletes mid-edge vertices', () => {
  // The failure this guards: three collinear segments would become three
  // separate cornice runs with two seams in the middle of a flat wall.
  assert.deepEqual(removeCollinear([[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]]),
                   [[0, 0], [10, 0], [10, 10], [0, 10]]);
});

test('removeCollinear keeps a ring that is entirely collinear rather than emptying it', () => {
  const degenerate = [[0, 0], [1, 0], [2, 0]];
  assert.equal(removeCollinear(degenerate).length, 3);
});

test('normalizeRing cleans and winds in one step', () => {
  const messy = [[0, 10], [0, 5], [0, 0], [10, 0], [10, 10], [10, 10]];
  const out = normalizeRing(messy, true);
  assert.equal(isCCW(out), true);
  assert.equal(out.length, 4);
});

test('segmentsCross detects proper crossings and shared-point touches', () => {
  assert.equal(segmentsCross([0, 0], [10, 10], [0, 10], [10, 0]), true);
  assert.equal(segmentsCross([0, 0], [1, 0], [2, 0], [3, 0]), false);
  assert.equal(segmentsCross([0, 0], [2, 0], [1, 0], [3, 0]), true, 'collinear overlap');
});

test('selfIntersects finds a bowtie but clears a simple polygon', () => {
  assert.equal(selfIntersects(SQUARE_CCW), false);
  assert.equal(selfIntersects(L_SHAPE), false);
  assert.equal(selfIntersects([[0, 0], [10, 10], [10, 0], [0, 10]]), true);
});

test('validateRing reports a reason instead of throwing', () => {
  assert.deepEqual(validateRing(SQUARE_CCW), { ok: true, reason: null });
  assert.equal(validateRing([[0, 0], [1, 1]]).reason, 'too-few-vertices');
  assert.equal(validateRing([[0, 0], [1, 0], [2, 0]]).reason, 'zero-area');
  assert.equal(validateRing([[0, 0], [10, 10], [10, 0], [0, 10]]).reason, 'self-intersecting');
  assert.equal(validateRing([[0, 0], [NaN, 0], [1, 1]]).reason, 'non-finite-vertex');
  assert.equal(validateRing('nope').reason, 'not-an-array');
});

test('ringEdges yields OUTWARD normals regardless of input winding', () => {
  // This is the one that decides whether windows face out or into the building.
  for (const ring of [SQUARE_CCW, SQUARE_CW]) {
    const edges = ringEdges(ring);
    assert.equal(edges.length, 4);
    for (const edge of edges) {
      const mid = [(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2];
      const probe = [mid[0] + edge.normal[0] * 0.5, mid[1] + edge.normal[1] * 0.5];
      assert.equal(pointInRing(probe, SQUARE_CCW), false,
        `normal ${JSON.stringify(edge.normal)} on edge ${edge.index} points inward`);
    }
  }
});

test('ringEdges reports true edge lengths', () => {
  const edges = ringEdges(SQUARE_CCW);
  assert.equal(edges.reduce((s, e) => s + e.length, 0), 40);
});

test('polygonArea subtracts holes', () => {
  const poly = { outer: [[0, 0], [20, 0], [20, 20], [0, 20]], holes: [[[5, 5], [5, 15], [15, 15], [15, 5]]] };
  assert.equal(polygonArea(poly), 400 - 100);
});

test('normalizePolygon winds the outer CCW and every hole CW', () => {
  const poly = normalizePolygon({
    outer: SQUARE_CW,
    holes: [[[2, 2], [4, 2], [4, 4], [2, 4]]],
  });
  assert.equal(isCCW(poly.outer), true);
  assert.equal(isCCW(poly.holes[0]), false);
});

test('normalizePolygon drops holes too small to bound area', () => {
  const poly = normalizePolygon({ outer: SQUARE_CCW, holes: [[[1, 1], [2, 2]]] });
  assert.equal(poly.holes.length, 0);
});

test('translate, scale and rotate preserve vertex count and area sign', () => {
  assert.deepEqual(translateRing(SQUARE_CCW, 5, -5)[0], [5, -5]);
  assert.equal(Math.round(signedArea(scaleRing(SQUARE_CCW, 2))), 400);
  const spun = rotateRing(SQUARE_CCW, Math.PI / 4);
  assert.equal(spun.length, 4);
  assert.ok(Math.abs(signedArea(spun) - 100) < 1e-9, 'rotation must preserve area');
});

test('EPS is small enough to be invisible at millimetre authoring', () => {
  assert.ok(EPS < 1e-6);
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`poly.test.mjs: ${passed} passed`);
