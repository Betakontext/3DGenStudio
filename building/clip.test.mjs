// node building/clip.test.mjs
//
// These are the Phase 0 spike, kept. The roof design rests on three claims about
// Clipper's offsetting behaviour, and if any of them stops being true - a
// dependency bump, a SCALE change - roof.js silently produces wrong buildings
// rather than failing. So they are asserted, not remembered.

import assert from 'node:assert/strict';
import {
  JOIN, SCALE, cleanPolygons, clipperArea, differencePolygons, intersectPolygons,
  offsetPolygon, offsetRings, polygonToRings, ringsToPolygons, unionPolygons,
  xorPolygons,
} from './clip.js';
import { isCCW, polygonArea, signedArea } from './poly.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const rect = (w, h, x = 0, y = 0) => ({
  outer: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], holes: [],
});
const totalArea = polys => polys.reduce((s, p) => s + polygonArea(p), 0);

// --- the contract constants -------------------------------------------------

test('SCALE gives 0.1mm resolution', () => {
  // Documented as a format constant: changing it changes every stored building.
  assert.equal(SCALE, 1e4);
});

// --- round trip -------------------------------------------------------------

test('polygonToRings emits a CCW outer followed by CW holes', () => {
  const rings = polygonToRings({
    outer: [[0, 10], [0, 0], [10, 0], [10, 10]],          // drawn CW
    holes: [[[2, 2], [4, 2], [4, 4], [2, 4]]],            // drawn CCW
  });
  assert.equal(rings.length, 2);
  assert.equal(isCCW(rings[0]), true, 'outer must come out CCW');
  assert.equal(isCCW(rings[1]), false, 'hole must come out CW');
});

test('ringsToPolygons assigns holes by containment, not by array order', () => {
  // Two separate wings, each with a courtyard, handed back in a hostile order.
  // Pairing positionally would put one wing courtyard inside the other wing.
  const wingA = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const holeA = [[2, 2], [2, 8], [8, 8], [8, 2]];
  const wingB = [[20, 0], [30, 0], [30, 10], [20, 10]];
  const holeB = [[22, 2], [22, 8], [28, 8], [28, 2]];

  const polys = ringsToPolygons([holeB, wingA, holeA, wingB]);
  assert.equal(polys.length, 2);
  for (const poly of polys) {
    assert.equal(poly.holes.length, 1, 'each wing keeps exactly one courtyard');
    const ox = poly.outer[0][0];
    const hx = poly.holes[0][0][0];
    assert.ok(Math.abs(ox - hx) < 15, `hole at x=${hx} attached to wing at x=${ox}`);
  }
});

test('ringsToPolygons gives a nested hole to the SMALLEST containing outer', () => {
  // A light well inside a courtyard inside a block belongs to the courtyard.
  const block = [[0, 0], [40, 0], [40, 40], [0, 40]];
  const court = [[10, 10], [30, 10], [30, 30], [10, 30]];
  const well = [[18, 18], [18, 22], [22, 22], [22, 18]];   // CW == a hole
  const polys = ringsToPolygons([block, court, well]);
  const owner = polys.find(p => p.holes.length === 1);
  assert.ok(owner, 'somebody must own the light well');
  assert.equal(owner.outer.length, 4);
  const b = Math.max(...owner.outer.map(p => p[0]));
  assert.equal(b, 30, 'the courtyard, not the block, owns the well');
});

test('ringsToPolygons drops an orphan hole rather than misattaching it', () => {
  // An unowned hole can only come from already-invalid input. Attaching it to an
  // arbitrary polygon would punch a void through a wall elsewhere.
  const polys = ringsToPolygons([
    [[0, 0], [10, 0], [10, 10], [0, 10]],
    [[50, 50], [50, 52], [52, 52], [52, 50]],   // CW, contained by nothing
  ]);
  assert.equal(polys.length, 1);
  assert.equal(polys[0].holes.length, 0);
});

// --- offsetting: the three claims roof.js depends on ------------------------

test('CLAIM 1: inward offset shrinks a rectangle by exactly delta per side', () => {
  const out = offsetPolygon(rect(20, 8), -1);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(polygonArea(out[0]) - 18 * 6) < 1e-6,
    `expected 108 m2, got ${polygonArea(out[0])}`);
});

test('CLAIM 2: a shape returns EMPTY at collapse, it does not degenerate', () => {
  // A 20x8 rectangle has a medial axis 4m in. roof.js relies on the last
  // non-empty ring being the ridge, so the transition must be to nothing.
  const nearly = offsetPolygon(rect(20, 8), -3.99);
  assert.equal(nearly.length, 1, 'still alive just before the medial axis');
  const b = nearly[0].outer;
  const height = Math.max(...b.map(p => p[1])) - Math.min(...b.map(p => p[1]));
  assert.ok(height < 0.05, `expected a ridge-thin sliver, got height ${height}`);

  assert.equal(offsetPolygon(rect(20, 8), -4.0).length, 0, 'empty at the axis');
  assert.equal(offsetPolygon(rect(20, 8), -4.01).length, 0, 'empty past the axis');
});

test('CLAIM 3: offsetting through a topology change splits one polygon into two', () => {
  // The main case, not an edge case: this is what happens under every hip roof
  // on a U-shaped or L-shaped plan. Arms 6m wide, base 2m tall, so the base dies
  // at 1m while the arms live to 3m.
  const U = {
    outer: [[0, 0], [18, 0], [18, 14], [12, 14], [12, 2], [6, 2], [6, 14], [0, 14]],
    holes: [],
  };
  assert.equal(offsetPolygon(U, -0.9).length, 1, 'one polygon before the split');
  const split = offsetPolygon(U, -1.5);
  assert.equal(split.length, 2, 'two polygons after the base collapses');

  const areas = split.map(polygonArea).sort();
  assert.ok(Math.abs(areas[0] - areas[1]) < 1e-6, 'the two arms are symmetric');
  assert.equal(offsetPolygon(U, -3.1).length, 0, 'both arms gone past 3m');
});

test('outward offset grows the shape', () => {
  const out = offsetPolygon(rect(10, 10), 1);
  assert.equal(out.length, 1);
  // Miter corners: 12x12 less the four corner notches Clipper squares off.
  assert.ok(polygonArea(out[0]) > 100, 'outward offset must grow');
  assert.ok(polygonArea(out[0]) <= 144 + 1e-6, 'and not exceed the miter bound');
});

test('a hole survives an offset and shrinks the usable area', () => {
  const withCourt = { outer: rect(20, 20).outer, holes: [rect(8, 8, 6, 6).outer.slice().reverse()] };
  const out = offsetPolygon(withCourt, -1);
  assert.equal(out.length, 1);
  assert.equal(out[0].holes.length, 1, 'the courtyard must survive');
  // Outer shrinks to 18x18; the hole GROWS to 10x10 because inward for the
  // building is outward for the void.
  assert.ok(Math.abs(polygonArea(out[0]) - (18 * 18 - 10 * 10)) < 1e-6,
    `got ${polygonArea(out[0])}`);
});

test('round joins produce more vertices than miter joins', () => {
  const L = { outer: [[0, 0], [12, 0], [12, 4], [4, 4], [4, 12], [0, 12]], holes: [] };
  const miter = offsetPolygon(L, -1, JOIN.MITER);
  const round = offsetPolygon(L, -1, JOIN.ROUND);
  const count = polys => polys.reduce((n, p) => n + p.outer.length, 0);
  assert.ok(count(round) > count(miter), 'round must flatten the corner into an arc');
});

test('offsetRings accepts a bare ring list', () => {
  assert.equal(offsetRings([rect(10, 10).outer], -1).length, 1);
  assert.equal(offsetRings([], -1).length, 0);
});

// --- determinism ------------------------------------------------------------

test('the same offset twice is byte-identical', () => {
  // compile.js promises a stable IR; that promise reduces to this one.
  const L = { outer: [[0, 0], [12, 0], [12, 4], [4, 4], [4, 12], [0, 12]], holes: [] };
  const a = JSON.stringify(offsetPolygon(L, -1.37));
  const b = JSON.stringify(offsetPolygon(L, -1.37));
  assert.equal(a, b);
});

test('offset output carries no float dust', () => {
  // 0.30000000000000004 in an IR makes two identical buildings compare unequal.
  const out = offsetPolygon(rect(7, 3), -0.3);
  for (const p of out[0].outer) {
    for (const v of p) {
      assert.equal(v, Math.round(v * 1e9) / 1e9, `${v} is not quantised`);
    }
  }
});

// --- booleans ---------------------------------------------------------------

test('union, difference, intersection and xor give exact areas', () => {
  const a = [rect(10, 10)];
  const b = [rect(10, 10, 5, 5)];
  assert.ok(Math.abs(totalArea(unionPolygons(a, b)) - 175) < 1e-6);
  assert.ok(Math.abs(totalArea(differencePolygons(a, b)) - 75) < 1e-6);
  assert.ok(Math.abs(totalArea(intersectPolygons(a, b)) - 25) < 1e-6);
  assert.ok(Math.abs(totalArea(xorPolygons(a, b)) - 150) < 1e-6);
});

test('difference punches a courtyard as a real hole', () => {
  const out = differencePolygons([rect(20, 20)], [rect(8, 8, 6, 6)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].holes.length, 1, 'an enclosed cut must become a hole');
  assert.ok(Math.abs(polygonArea(out[0]) - (400 - 64)) < 1e-6);
});

test('union of disjoint shapes keeps them separate', () => {
  const out = unionPolygons([rect(10, 10)], [rect(10, 10, 50, 0)]);
  assert.equal(out.length, 2);
});

// --- robustness on input the plan editor can actually produce ---------------

test('cleanPolygons resolves a self-overlapping footprint instead of rejecting it', () => {
  // The user drew an outline that crosses itself. The right answer is the shape
  // they visually drew, not an error.
  const bowtie = { outer: [[0, 0], [10, 10], [10, 0], [0, 10]], holes: [] };
  const out = cleanPolygons([bowtie]);
  assert.ok(out.length >= 1, 'must produce something usable');
  assert.ok(totalArea(out) > 0, 'and it must have area');
});

test('degenerate input does not throw', () => {
  assert.doesNotThrow(() => offsetPolygon({ outer: [[0, 0], [1, 1]], holes: [] }, -1));
  assert.doesNotThrow(() => offsetPolygon({ outer: [], holes: [] }, -1));
  assert.doesNotThrow(() => unionPolygons([], []));
});

test('clipperArea agrees with poly.signedArea', () => {
  // An external oracle for the shoelace implementation, the way vfx/random.js
  // checks itself against PCG's published vectors rather than a snapshot.
  const ring = [[0, 0], [12, 0], [12, 4], [4, 4], [4, 12], [0, 12]];
  assert.ok(Math.abs(clipperArea(ring) - signedArea(ring)) < 1e-6);
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`clip.test.mjs: ${passed} passed`);
