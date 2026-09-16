// node building/roofitems.test.mjs
//
// Things standing on the roof. The interesting cases are the degenerate ones: a
// pitched roof's top rung is a two-point sliver or a single point, which is
// exactly where a chimney goes and exactly what a polygon guard would reject.

import assert from 'node:assert/strict';
import { MAX_ROOF_ITEMS, ROOF_ITEM, ROOF_WHERE, placeRoofItems } from './roofitems.js';
import { generateRoof, ROOF_KIND } from './roof.js';
import { SLOT_TYPE } from './ir.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const RECT = { outer: [[0, 0], [16, 0], [16, 10], [0, 10]], holes: [] };
const roofOf = (kind, extra = {}) => generateRoof({
  polygons: [RECT], baseZ: 10, kind, pitch: 45, stepRun: 1, stepRise: 0.8, ...extra,
});
const place = (roof, rule) => placeRoofItems({ roof, seed: 4711, nodeId: 'ri', rule });
const zOf = slot => slot.transform[14];

// --- placing -----------------------------------------------------------------

test('a chimney stands on the ridge of every pitched roof', () => {
  for (const kind of [ROOF_KIND.HIP, ROOF_KIND.GABLE, ROOF_KIND.MANSARD, ROOF_KIND.STEPPED]) {
    const roof = roofOf(kind);
    const out = place(roof, { where: ROOF_WHERE.RIDGE, count: 2 });
    assert.equal(out.slots.length, 2, `${kind} placed ${out.slots.length}`);
    assert.ok(out.slots.every(s => s.type === SLOT_TYPE.ROOF_ITEM));
  }
});

test('a flat roof is a place too', () => {
  // The whole deck is the top rung, so a "ridge" item sits on its far edge and
  // an "apex" one in the middle of it. Neither is wrong and neither may throw.
  const roof = roofOf(ROOF_KIND.FLAT);
  assert.equal(place(roof, { where: ROOF_WHERE.RIDGE, count: 3 }).slots.length, 3);
  assert.equal(place(roof, { where: ROOF_WHERE.APEX }).slots.length, 1);
});

test('a CLOSED pitch still gets its apex item, sliver or point', () => {
  // A hip that consumed the plan ends in a two-point rung or a single one. This
  // is the case a three-points-minimum guard would silently drop, and it is the
  // most useful case there is: a finial goes on the apex.
  const roof = roofOf(ROOF_KIND.HIP, { pitch: 70 });
  const top = roof.rungs[roof.rungs.length - 1];
  const ring = top.polygons[0].outer;
  assert.ok(ring.length <= 4, `the top rung still has ${ring.length} points`);
  const out = place(roof, { where: ROOF_WHERE.APEX, item: ROOF_ITEM.FINIAL });
  assert.equal(out.slots.length, 1);
  assert.equal(out.slots[0].styleSlot, 'finial');
});

test('ridge is higher than slope is higher than eave', () => {
  const roof = roofOf(ROOF_KIND.HIP);
  const at = where => zOf(place(roof, { where, count: 1, sink: 0 }).slots[0]);
  assert.ok(at(ROOF_WHERE.RIDGE) > at(ROOF_WHERE.SLOPE),
    'the ridge is not above the slope');
  assert.ok(at(ROOF_WHERE.SLOPE) > at(ROOF_WHERE.EAVE),
    'the slope is not above the eave');
});

test('no roof places nothing, and says why', () => {
  for (const roof of [null, undefined, {}, { rungs: [] }]) {
    const out = place(roof, { where: ROOF_WHERE.RIDGE });
    assert.equal(out.slots.length, 0);
    assert.equal(out.reason, 'no-roof');
  }
});

// --- geometry ----------------------------------------------------------------

test('the foot is SUNK, so a stack does not float over the pitch between rungs', () => {
  // A ladder is a staircase approximating a slope: the surface is below the
  // contour almost everywhere, so an item placed exactly on one hangs in the air
  // along most of its length.
  const roof = roofOf(ROOF_KIND.HIP);
  const top = roof.rungs[roof.rungs.length - 1].z;
  const height = 3;
  const sunk = place(roof, { where: ROOF_WHERE.RIDGE, count: 1, height, sink: 0.5 }).slots[0];
  // The origin is the CENTRE, so the foot is at z - height/2.
  assert.ok(Math.abs((zOf(sunk) - height / 2) - (top - 0.5)) < 1e-6,
    `the foot sits at ${(zOf(sunk) - height / 2).toFixed(3)}, wanted ${(top - 0.5).toFixed(3)}`);
});

test('the size asked for is the size carried', () => {
  const out = place(roofOf(ROOF_KIND.HIP), {
    where: ROOF_WHERE.RIDGE, count: 1, width: 1.3, depth: 0.8, height: 3.5,
  });
  const slot = out.slots[0];
  assert.equal(slot.cellW, 1.3);
  assert.equal(slot.cellH, 3.5);
  // cellD is the one dimension an opening leaves at 0 - a roof item always
  // declares it, because a chimney has a real thickness.
  assert.equal(slot.cellD, 0.8);
});

test('the frame is right-handed, so a model faces out rather than mirrored', () => {
  const slot = place(roofOf(ROOF_KIND.GABLE), { where: ROOF_WHERE.RIDGE, count: 1 }).slots[0];
  const t = slot.transform;
  const along = [t[0], t[1], t[2]];
  const up = [t[4], t[5], t[6]];
  const normal = [t[8], t[9], t[10]];
  const cross = [
    along[1] * up[2] - along[2] * up[1],
    along[2] * up[0] - along[0] * up[2],
    along[0] * up[1] - along[1] * up[0],
  ];
  const dot = cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2];
  assert.ok(dot > 0.99, `X cross Y . Z = ${dot.toFixed(4)} - the frame is mirrored`);
});

test('items spread along the contour instead of stacking in one place', () => {
  const out = place(roofOf(ROOF_KIND.GABLE), { where: ROOF_WHERE.RIDGE, count: 4 });
  const xs = out.slots.map(s => s.transform[12]);
  assert.equal(new Set(xs.map(x => x.toFixed(3))).size, 4, `they landed at ${xs}`);
});

test('a run walks the ring as a POLYLINE, so an L-plan ridge is covered evenly', () => {
  // Sampling by angle instead would bunch items at the corners of a non-convex
  // contour and leave the long runs bare.
  const L = {
    outer: [[0, 0], [20, 0], [20, 8], [9, 8], [9, 18], [0, 18]],
    holes: [],
  };
  const roof = generateRoof({ polygons: [L], baseZ: 10, kind: ROOF_KIND.STEPPED, stepRun: 1, stepRise: 0.5, maxHeight: 2 });
  const out = place(roof, { where: ROOF_WHERE.RIDGE, count: 6 });
  assert.equal(out.slots.length, 6);
  // Every consecutive pair roughly one sixth of the perimeter apart, which an
  // angular sweep would not manage.
  const gaps = [];
  for (let i = 1; i < out.slots.length; i++) {
    gaps.push(Math.hypot(
      out.slots[i].transform[12] - out.slots[i - 1].transform[12],
      out.slots[i].transform[13] - out.slots[i - 1].transform[13],
    ));
  }
  assert.ok(Math.min(...gaps) > 1, `two items landed ${Math.min(...gaps).toFixed(2)}m apart`);
});

// --- seeding -----------------------------------------------------------------

test('each item seeds from its own position in the run', () => {
  const out = place(roofOf(ROOF_KIND.GABLE), { where: ROOF_WHERE.RIDGE, count: 5 });
  assert.equal(new Set(out.slots.map(s => s.seedKey)).size, 5,
    'every item hashed the same - they would all wear one model');
});

test('the count is capped rather than allowed to wedge a tab', () => {
  const out = place(roofOf(ROOF_KIND.FLAT), { where: ROOF_WHERE.RIDGE, count: 10000 });
  assert.equal(out.slots.length, MAX_ROOF_ITEMS);
  assert.equal(out.truncated, true);
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`roofitems.test.mjs: ${passed} passed`);
