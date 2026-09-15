// node building/roof.test.mjs
//
// The claim under test is the one mass.js made in Phase 1 and this file is
// supposed to cash: that a roof is the same offset stack continued until it
// closes, with no straight-skeleton implementation and no per-shape geometry.

import assert from 'node:assert/strict';
import {
  MAX_ROOF_STEPS, ROOF_KIND, bandBetween, generateRoof, roofIsCapped, roofTop, rungKind,
  stackRoofs,
} from './roof.js';
import { polygonArea } from './poly.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const rect = (w, h) => ({ outer: [[0, 0], [w, 0], [w, h], [0, h]], holes: [] });
const L_SHAPE = { outer: [[0, 0], [24, 0], [24, 10], [10, 10], [10, 24], [0, 24]], holes: [] };
const COURTYARD = {
  outer: [[0, 0], [30, 0], [30, 30], [0, 30]],
  holes: [[[10, 10], [10, 20], [20, 20], [20, 10]]],
};

const areaOf = rung => rung.polygons.reduce((s, p) => s + polygonArea(p), 0);
const roofOf = (polygon, opts = {}) => generateRoof({ polygons: [polygon], baseZ: 10, ...opts });

// --- flat --------------------------------------------------------------------

test('a flat roof is the top of the stack and nothing else', () => {
  const roof = roofOf(rect(12, 8), { kind: ROOF_KIND.FLAT });
  assert.equal(roof.rungs.length, 1);
  assert.equal(roof.height, 0);
  assert.equal(roof.closed, true);
});

// --- hip ---------------------------------------------------------------------

test('a hip roof climbs and shrinks all the way to a ridge', () => {
  const roof = roofOf(rect(20, 8), { kind: ROOF_KIND.HIP, pitch: 35 });
  assert.ok(roof.rungs.length > 3, `only ${roof.rungs.length} rungs`);
  assert.equal(roof.closed, true, 'it never reached a ridge');
  for (let i = 1; i < roof.rungs.length; i++) {
    assert.ok(roof.rungs[i].z > roof.rungs[i - 1].z, `rung ${i} did not rise`);
    assert.ok(areaOf(roof.rungs[i]) < areaOf(roof.rungs[i - 1]), `rung ${i} did not shrink`);
  }
});

test('the ridge of a 20x8 plan sits at about half its width, times the pitch', () => {
  // The geometric check that this really is a hip roof: the apex is reached when
  // the offset has eaten half the SHORT span, so h = 4 * tan(pitch).
  const roof = roofOf(rect(20, 8), { kind: ROOF_KIND.HIP, pitch: 45 });
  assert.ok(Math.abs(roof.height - 4) < 0.6, `ridge at ${roof.height}m, expected about 4m`);
});

test('a steeper pitch gives a taller roof over the same plan', () => {
  const shallow = roofOf(rect(16, 10), { kind: ROOF_KIND.HIP, pitch: 20 });
  const steep = roofOf(rect(16, 10), { kind: ROOF_KIND.HIP, pitch: 55 });
  assert.ok(steep.height > shallow.height * 2, `${shallow.height} vs ${steep.height}`);
});

test('every rung lies on the SAME plane, so a hip roof is exact and not approximated', () => {
  // inset and rise are proportional, so height / inset must be constant. If this
  // drifts the roof is faceted in the slope, which is visible.
  const roof = roofOf(rect(24, 16), { kind: ROOF_KIND.HIP, pitch: 40 });
  const tan = Math.tan((40 * Math.PI) / 180);
  const first = roof.rungs[1];
  const ratio = (first.z - 10) / tan;
  for (let i = 2; i < roof.rungs.length; i++) {
    const inset = (roof.rungs[i].z - 10) / tan;
    assert.ok(Math.abs(inset - ratio * i) < 1e-6, `rung ${i} left the plane`);
  }
});

// --- arbitrary plans, which is the point -------------------------------------

test('an L-plan roofs without special-casing', () => {
  // An L does NOT split on the way up, and that is correct: its inward offset
  // shrinks toward a Y-shaped spine but stays ONE polygon until it vanishes.
  // What matters is that a concave plan roofs at all, and closes.
  const roof = generateRoof({ polygons: [L_SHAPE], baseZ: 0, kind: ROOF_KIND.HIP, pitch: 40 });
  assert.equal(roof.closed, true);
  assert.ok(roof.rungs.length > 3);
  assert.ok(roof.height > 0);
  // The concave corner must survive into the roof rather than being rounded off.
  assert.ok(roof.rungs[1].polygons[0].outer.length >= 6, 'the notch was lost');
});

test('a plan with unequal limbs SPLITS into two ridges', () => {
  // The topology change the whole approach exists to handle. Arms 6m wide over a
  // 2m base: the base is consumed first and the contour becomes two pieces.
  const U = {
    outer: [[0, 0], [18, 0], [18, 14], [12, 14], [12, 2], [6, 2], [6, 14], [0, 14]],
    holes: [],
  };
  const roof = generateRoof({ polygons: [U], baseZ: 0, kind: ROOF_KIND.HIP, pitch: 40 });
  assert.ok(roof.rungs.some(rung => rung.polygons.length > 1),
    'the ridge never forked');
});

test('a courtyard roofs from both sides', () => {
  const roof = generateRoof({ polygons: [COURTYARD], baseZ: 0, kind: ROOF_KIND.HIP, pitch: 35 });
  assert.ok(roof.rungs.length > 2);
  // The hole grows as the outer shrinks; eventually they meet and the ring
  // closes up. Either way it must terminate with a real roof.
  assert.ok(roof.height > 0);
  assert.equal(roof.rungs[0].polygons[0].holes.length, 1, 'the courtyard is missing at the eave');
});

// --- mansard -----------------------------------------------------------------

test('a mansard is steep then shallow', () => {
  const roof = roofOf(rect(24, 18), { kind: ROOF_KIND.MANSARD, pitch: 70, upperPitch: 10 });
  const slopes = [];
  for (let i = 1; i < roof.rungs.length; i++) {
    slopes.push(roof.rungs[i].z - roof.rungs[i - 1].z);
  }
  assert.ok(slopes.length > 3);
  // The first rise must be much larger than the last.
  assert.ok(slopes[0] > slopes[slopes.length - 1] * 2,
    `no break in pitch: ${slopes.map(s => s.toFixed(2)).join(', ')}`);
});

test('a mansard is shorter than a hip of the same lower pitch', () => {
  const hip = roofOf(rect(24, 18), { kind: ROOF_KIND.HIP, pitch: 70 });
  const mansard = roofOf(rect(24, 18), { kind: ROOF_KIND.MANSARD, pitch: 70, upperPitch: 8 });
  assert.ok(mansard.height < hip.height, `${mansard.height} vs ${hip.height}`);
});

// --- stepped -----------------------------------------------------------------

test('a stepped roof alternates treads and risers', () => {
  const roof = roofOf(rect(30, 30), { kind: ROOF_KIND.STEPPED, stepRun: 2, stepRise: 1.5 });
  const kinds = [];
  for (let i = 1; i < roof.rungs.length; i++) {
    kinds.push(rungKind(roof.rungs[i - 1], roof.rungs[i]));
  }
  assert.ok(kinds.includes('tread'), 'no horizontal tread');
  assert.ok(kinds.includes('riser'), 'no vertical riser');
  // And they alternate rather than clumping.
  assert.equal(kinds[0], 'tread');
  assert.equal(kinds[1], 'riser');
});

test('a riser is the same shape at two heights', () => {
  const roof = roofOf(rect(30, 30), { kind: ROOF_KIND.STEPPED, stepRun: 3, stepRise: 2 });
  for (let i = 1; i < roof.rungs.length; i++) {
    if (rungKind(roof.rungs[i - 1], roof.rungs[i]) !== 'riser') continue;
    assert.ok(Math.abs(areaOf(roof.rungs[i]) - areaOf(roof.rungs[i - 1])) < 1e-6);
    assert.ok(roof.rungs[i].z > roof.rungs[i - 1].z);
    return;
  }
  throw new Error('no riser found');
});

test('a tiered roof oversails, a stepped one does not', () => {
  const stepped = roofOf(rect(30, 30), { kind: ROOF_KIND.STEPPED, stepRun: 3, stepRise: 2, overhang: 0 });
  const tiered = roofOf(rect(30, 30), { kind: ROOF_KIND.TIERED, stepRun: 3, stepRise: 2, overhang: 0.8 });
  assert.ok(areaOf(tiered.rungs[1]) > areaOf(stepped.rungs[1]),
    'the tier did not oversail the platform below it');
});

// --- the ladder contract -----------------------------------------------------

test('rungKind classifies the three surfaces', () => {
  const square = [rect(10, 10)];
  const smaller = [rect(8, 8)];
  assert.equal(rungKind({ polygons: square, z: 0 }, { polygons: smaller, z: 2 }), 'slope');
  assert.equal(rungKind({ polygons: square, z: 0 }, { polygons: smaller, z: 0 }), 'tread');
  assert.equal(rungKind({ polygons: square, z: 0 }, { polygons: square, z: 2 }), 'riser');
  assert.equal(rungKind({ polygons: square, z: 0 }, { polygons: square, z: 0 }), 'none');
});

test('bandBetween is the annulus, and it closes', () => {
  const roof = roofOf(rect(20, 12), { kind: ROOF_KIND.HIP, pitch: 30 });
  const band = bandBetween(roof.rungs[0], roof.rungs[1]);
  const lower = areaOf(roof.rungs[0]);
  const upper = areaOf(roof.rungs[1]);
  const bandArea = band.reduce((s, p) => s + polygonArea(p), 0);
  assert.ok(Math.abs(bandArea - (lower - upper)) < 1e-4,
    `band ${bandArea} should be ${lower - upper}`);
});

// --- guards ------------------------------------------------------------------

test('a plan too small for a roof falls back to flat, and says so', () => {
  // A roofless building with no message is the worst outcome; a flat roof with
  // an explanation is the best one available. 8cm is smaller than the minimum
  // offset step, so not even one rung fits - a 30cm plan, by contrast, gets a
  // small roof, which is right.
  const roof = roofOf(rect(0.08, 0.08), { kind: ROOF_KIND.HIP, pitch: 40 });
  assert.equal(roof.kind, ROOF_KIND.FLAT);
  assert.equal(roof.fallback, 'too-small');
  assert.equal(roof.height, 0);
});

test('no polygons yields no roof rather than throwing', () => {
  assert.deepEqual(generateRoof({ polygons: [] }).rungs, []);
  assert.deepEqual(generateRoof({}).rungs, []);
});

test('the ladder is bounded however extreme the numbers', () => {
  const roof = roofOf(rect(400, 400), { kind: ROOF_KIND.STEPPED, stepRun: 0.05, stepRise: 0.01 });
  // Two rungs per step, plus the base.
  assert.ok(roof.rungs.length <= MAX_ROOF_STEPS * 2 + 1, `${roof.rungs.length} rungs`);
});

test('an absurd pitch is clamped rather than sending the ridge to infinity', () => {
  const roof = roofOf(rect(12, 12), { kind: ROOF_KIND.HIP, pitch: 89.99 });
  assert.ok(Number.isFinite(roof.height));
  assert.ok(roof.height < 200, `${roof.height}m roof on a 12m plan`);
});

test('maxHeight caps a roof EXACTLY, not at the first rung past it', () => {
  // Checking the cap after pushing overshoots by a whole step: a 60-degree pitch
  // on a large plan steps 4.3m at a time and sailed past a 5m cap to 8.7m.
  for (const [plan, pitch, cap] of [
    [rect(40, 40), 60, 5], [rect(24, 18), 35, 3], [rect(60, 20), 45, 2.5],
  ]) {
    const roof = generateRoof({ polygons: [plan], baseZ: 10, kind: ROOF_KIND.HIP, pitch, maxHeight: cap });
    assert.ok(Math.abs(roof.height - cap) < 1e-3, `capped at ${roof.height}, wanted ${cap}`);
    assert.ok(roof.rungs.length > 1, 'the cap flattened the roof entirely');
  }
});

test('a capped roof ends on a flat deck, not a ridge', () => {
  const roof = roofOf(rect(40, 40), { kind: ROOF_KIND.HIP, pitch: 60, maxHeight: 5 });
  const top = roof.rungs[roof.rungs.length - 1];
  assert.ok(areaOf(top) > 1, 'the deck has no area');
  assert.equal(roof.closed, false, 'a capped roof has not closed to a point');
});

test('a stepped roof respects the cap too', () => {
  const roof = roofOf(rect(30, 30), {
    kind: ROOF_KIND.STEPPED, stepRun: 2, stepRise: 1.5, maxHeight: 4,
  });
  assert.ok(roof.height <= 4 + 1e-6, `${roof.height}m exceeded the cap`);
});

test('roofs are deterministic', () => {
  const a = generateRoof({ polygons: [L_SHAPE], baseZ: 3, kind: ROOF_KIND.HIP, pitch: 33 });
  const b = generateRoof({ polygons: [L_SHAPE], baseZ: 3, kind: ROOF_KIND.HIP, pitch: 33 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('the roof starts at the height it was given', () => {
  const roof = roofOf(rect(12, 9), { kind: ROOF_KIND.HIP, pitch: 30 });
  assert.equal(roof.rungs[0].z, 10);
  assert.ok(roof.rungs[roof.rungs.length - 1].z > 10);
});

// --- stacking ----------------------------------------------------------------
//
// Two chained Roof nodes. The behaviour that makes the second one worth having:
// it continues the first rather than replacing it.

test('the top of a ladder is its LAST rung, not its highest', () => {
  // A stepped roof has two rungs at the same height - the tread, and the top of
  // the riser below it. Picking by maximum z could take either; stacking onto
  // the wrong one starts the next roof inside the step.
  const roof = roofOf(rect(30, 30), { kind: ROOF_KIND.STEPPED, stepRun: 3, stepRise: 2 });
  const last = roof.rungs[roof.rungs.length - 1];
  assert.deepEqual(roofTop(roof), { polygons: last.polygons, z: last.z });
  assert.equal(roofTop(null), null);
});

test('stacking continues the ladder without repeating the shared rung', () => {
  const lower = roofOf(rect(40, 40), {
    kind: ROOF_KIND.STEPPED, stepRun: 3, stepRise: 2, maxHeight: 6,
  });
  const top = roofTop(lower);
  const upper = generateRoof({
    polygons: top.polygons, baseZ: top.z, kind: ROOF_KIND.HIP, pitch: 40,
  });
  const stacked = stackRoofs(lower, upper);

  assert.equal(stacked.rungs.length, lower.rungs.length + upper.rungs.length - 1,
    'the shared base rung was counted twice');
  // Monotonic and contiguous: no gap at the join and nothing going back down.
  for (let i = 1; i < stacked.rungs.length; i++) {
    assert.ok(stacked.rungs[i].z >= stacked.rungs[i - 1].z, `rung ${i} goes down`);
  }
  assert.ok(stacked.height > lower.height, 'the cap added no height');
  assert.ok(Math.abs(stacked.height - (lower.height + upper.height)) < 1e-9);
});

test('a temple is a stepped base under a hip cap, and reads as neither', () => {
  const lower = roofOf(rect(40, 40), {
    kind: ROOF_KIND.STEPPED, stepRun: 3, stepRise: 2, maxHeight: 6,
  });
  const top = roofTop(lower);
  const cap = generateRoof({
    polygons: top.polygons, baseZ: top.z, kind: ROOF_KIND.HIP, pitch: 40,
  });
  assert.equal(stackRoofs(lower, cap).kind, ROOF_KIND.STACKED);
  // Two of the same shape stay that shape - one taller stepped roof, honestly.
  const more = generateRoof({
    polygons: top.polygons, baseZ: top.z, kind: ROOF_KIND.STEPPED, stepRun: 1.5, stepRise: 1,
  });
  assert.equal(stackRoofs(lower, more).kind, ROOF_KIND.STEPPED);
});

test('stacking something that adds nothing leaves the roof below alone', () => {
  // A Flat roof produces only its own base rung, so it must not overwrite the
  // kind, the height or the closure of the roof it sits on.
  const lower = roofOf(rect(30, 20), { kind: ROOF_KIND.HIP, pitch: 35 });
  const top = roofTop(lower);
  const flat = generateRoof({ polygons: top.polygons, baseZ: top.z, kind: ROOF_KIND.FLAT });
  const stacked = stackRoofs(lower, flat);
  assert.equal(stacked.rungs.length, lower.rungs.length);
  assert.equal(stacked.kind, lower.kind);
  assert.equal(stacked.height, lower.height);
  assert.equal(stacked.closed, lower.closed);
});

test('a roof that closed to a ridge is capped; a flat one is not', () => {
  // The distinction the compiler refuses a second roof on. `closed` alone will
  // not do: a flat roof is trivially closed and its whole plan is a good base.
  assert.equal(roofIsCapped(roofOf(rect(20, 14), { kind: ROOF_KIND.HIP, pitch: 35 })), true);
  assert.equal(roofIsCapped(roofOf(rect(20, 14), { kind: ROOF_KIND.FLAT })), false);
  assert.equal(roofIsCapped(roofOf(rect(40, 40), {
    kind: ROOF_KIND.HIP, pitch: 45, maxHeight: 4,
  })), false);
  assert.equal(roofIsCapped(null), false);
});

test('a stacked ladder still classifies rung by rung', () => {
  // The mesher walks the merged ladder with no idea it was ever two roofs, so
  // the three rung rules have to hold across the join as well as within it.
  const lower = roofOf(rect(40, 40), {
    kind: ROOF_KIND.STEPPED, stepRun: 3, stepRise: 2, maxHeight: 6,
  });
  const top = roofTop(lower);
  const cap = generateRoof({
    polygons: top.polygons, baseZ: top.z, kind: ROOF_KIND.HIP, pitch: 40,
  });
  const { rungs } = stackRoofs(lower, cap);
  for (let i = 1; i < rungs.length; i++) {
    assert.notEqual(rungKind(rungs[i - 1], rungs[i]), 'none',
      `rungs ${i - 1} and ${i} are the same surface twice`);
  }
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`roof.test.mjs: ${passed} passed`);
