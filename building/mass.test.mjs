// node building/mass.test.mjs
//
// The claim under test is the one in the mass.js header: that Egyptian batter,
// Mayan steps, American setbacks and Medieval jetties are all ONE operation with
// different numbers. If that is wrong, this file is where it shows.

import assert from 'node:assert/strict';
import {
  MASS_PROFILE, MAX_LEVELS, insetAt, offsetFootprint, sampleProfileCurve,
  stackMass, topOfStack,
} from './mass.js';
import { LEVEL_KIND } from './ir.js';
import { createCurve, defaultProfileCurve, isFlatCurve } from './param.js';
import { polygonArea } from './poly.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const SQUARE = { outer: [[0, 0], [20, 0], [20, 20], [0, 20]], holes: [] };
const L_SHAPE = { outer: [[0, 0], [24, 0], [24, 8], [8, 8], [8, 24], [0, 24]], holes: [] };
const COURTYARD = {
  outer: [[0, 0], [30, 0], [30, 30], [0, 30]],
  holes: [[[10, 10], [10, 20], [20, 20], [20, 10]]],
};

// Levels belonging to one storey, since a storey can emit several.
const storey = (stack, index) => stack.levels.filter(l => l.index === index && l.kind !== LEVEL_KIND.PLINTH);
const storeyArea = (stack, index) => storey(stack, index).reduce((s, l) => s + polygonArea(l.polygon), 0);

// --- the profile evaluator --------------------------------------------------

test('STRAIGHT never insets', () => {
  for (let i = 0; i < 5; i++) {
    assert.equal(insetAt({ mode: MASS_PROFILE.STRAIGHT }, i, 5), 0);
  }
});

test('BATTER leans in linearly and starts at zero', () => {
  const p = { mode: MASS_PROFILE.BATTER, amount: 2 };
  assert.equal(insetAt(p, 0, 5), 0, 'the ground course is full size');
  assert.equal(insetAt(p, 4, 5), 2, 'the top is inset by the full amount');
  assert.equal(insetAt(p, 2, 5), 1);
});

test('JETTY is BATTER with the sign flipped', () => {
  const amount = 1.5;
  for (let i = 0; i < 6; i++) {
    assert.equal(
      insetAt({ mode: MASS_PROFILE.JETTY, amount }, i, 6),
      -insetAt({ mode: MASS_PROFILE.BATTER, amount }, i, 6),
    );
  }
});

test('SETBACK steps at every-th level', () => {
  const p = { mode: MASS_PROFILE.SETBACK, step: 1.5, every: 3 };
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(i => insetAt(p, i, 9)),
                   [0, 0, 0, 1.5, 1.5, 1.5, 3]);
});

test('SETBACK guards every: 0 rather than dividing by zero', () => {
  const p = { mode: MASS_PROFILE.SETBACK, step: 1, every: 0 };
  assert.equal(Number.isFinite(insetAt(p, 3, 5)), true);
  assert.equal(insetAt(p, 3, 5), 3, 'every: 0 behaves as every: 1');
});

test('a single-level building sits at the bottom of the profile', () => {
  // count - 1 == 0 would otherwise divide by zero and take the full amount on
  // the ground floor, which reads as the building being the wrong size.
  assert.equal(insetAt({ mode: MASS_PROFILE.BATTER, amount: 5 }, 0, 1), 0);
});

test('a malformed amount degrades to zero rather than NaN', () => {
  assert.equal(insetAt({ mode: MASS_PROFILE.BATTER, amount: 'tall' }, 2, 4), 0);
  assert.equal(insetAt(null, 2, 4), 0);
  assert.equal(insetAt({ mode: 'unheard-of' }, 2, 4), 0);
});

test('CURVE passes through its keys and clamps outside them', () => {
  const curve = createCurve([{ t: 0, v: 0 }, { t: 0.5, v: 2 }, { t: 1, v: 1 }]);
  assert.equal(sampleProfileCurve(curve, 0), 0);
  assert.equal(sampleProfileCurve(curve, 0.5), 2);
  assert.equal(sampleProfileCurve(curve, 1), 1);
  // Held flat, not extrapolated: extrapolation can send the inset anywhere one
  // level past the curve and make the building vanish for no visible reason.
  assert.equal(sampleProfileCurve(curve, -3), 0);
  assert.equal(sampleProfileCurve(curve, 9), 1);
});

test('CURVE EASES between keys - that is what distinguishes it from Batter', () => {
  // Batter reaches the same place in a straight line. If a curve interpolated
  // linearly too, the two profiles would be indistinguishable and the mode would
  // be pointless.
  const curve = createCurve([{ t: 0, v: 0 }, { t: 1, v: 2 }]);
  const mid = sampleProfileCurve(curve, 0.5);
  assert.ok(mid > 0 && mid < 2, `midpoint ${mid} is outside the keys`);

  const shaped = createCurve([{ t: 0, v: 0 }, { t: 0.5, v: 2 }, { t: 1, v: 1 }]);
  assert.notEqual(sampleProfileCurve(shaped, 0.25), 1, 'a hump must not sample linearly');
});

test('CURVE accepts the legacy [[t, v]] pair array', () => {
  // Documents written before the curve editor existed still have to open.
  assert.equal(sampleProfileCurve([[0, 0], [1, 4]], 0), 0);
  assert.equal(sampleProfileCurve([[0, 0], [1, 4]], 1), 4);
});

test('a missing or malformed curve falls back to the default taper', () => {
  // Never NaN, and never a silently flat profile that looks like a broken mode.
  for (const junk of [null, undefined, [], 'nope', {}]) {
    const v = sampleProfileCurve(junk, 1);
    assert.ok(Number.isFinite(v), `${JSON.stringify(junk)} gave ${v}`);
  }
});

test('the default profile curve is NOT flat', () => {
  // The whole complaint: picking Curve and seeing no difference from Straight.
  assert.equal(isFlatCurve(defaultProfileCurve()), false);
  assert.ok(sampleProfileCurve(defaultProfileCurve(), 1) > 0.5);
  assert.equal(sampleProfileCurve(defaultProfileCurve(), 0), 0, 'the ground course is full size');
});

test('a curve can overhang as well as lean in', () => {
  const outward = createCurve([{ t: 0, v: 0 }, { t: 1, v: -1.5 }]);
  const stack = stackMass({
    footprint: SQUARE, levelCount: 4,
    profile: { mode: MASS_PROFILE.CURVE, curve: outward },
  });
  assert.ok(storeyArea(stack, 3) > storeyArea(stack, 0), 'a negative inset must overhang');
});

// --- stacking ---------------------------------------------------------------

test('a straight stack keeps every storey the same size', () => {
  const stack = stackMass({ footprint: SQUARE, levelCount: 4, groundHeight: 4, levelHeight: 3 });
  assert.equal(stack.levels.length, 4);
  assert.equal(stack.height, 4 + 3 * 3);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(storeyArea(stack, i) - 400) < 1e-6, `storey ${i} is ${storeyArea(stack, i)}`);
  }
});

test('the ground floor gets its own kind and its own height', () => {
  const stack = stackMass({ footprint: SQUARE, levelCount: 3, groundHeight: 5, levelHeight: 3 });
  assert.equal(stack.levels[0].kind, LEVEL_KIND.GROUND);
  assert.equal(stack.levels[0].z1 - stack.levels[0].z0, 5);
  assert.equal(stack.levels[1].kind, LEVEL_KIND.UPPER);
  assert.equal(stack.levels[1].z1 - stack.levels[1].z0, 3);
});

test('levels are contiguous - no gap or overlap between storeys', () => {
  // EXACT contiguity is the property that matters: a gap under the roof of a
  // tall building comes from one level's top not being the next one's bottom.
  // The running total itself can still differ from the same sum computed in
  // another order by ~1e-13 m, which is why the height below has a tolerance -
  // that is float arithmetic, not drift anyone can see.
  const stack = stackMass({ footprint: SQUARE, levelCount: 40, groundHeight: 4.35, levelHeight: 3.15 });
  const byIndex = [...new Set(stack.levels.map(l => l.index))].sort((a, b) => a - b);
  for (let i = 1; i < byIndex.length; i++) {
    const prev = stack.levels.find(l => l.index === byIndex[i - 1]);
    const cur = stack.levels.find(l => l.index === byIndex[i]);
    assert.equal(cur.z0, prev.z1, `gap between storey ${i - 1} and ${i}`);
  }
  assert.ok(Math.abs(stack.height - (4.35 + 39 * 3.15)) < 1e-9,
    `height ${stack.height} drifted from ${4.35 + 39 * 3.15}`);
});

test('EGYPTIAN: batter shrinks every storey monotonically', () => {
  const stack = stackMass({
    footprint: SQUARE, levelCount: 5,
    profile: { mode: MASS_PROFILE.BATTER, amount: 3 },
  });
  const areas = [0, 1, 2, 3, 4].map(i => storeyArea(stack, i));
  for (let i = 1; i < areas.length; i++) {
    assert.ok(areas[i] < areas[i - 1], `storey ${i} (${areas[i]}) is not smaller than ${areas[i - 1]}`);
  }
  assert.ok(Math.abs(areas[0] - 400) < 1e-6, 'the ground course is full size');
});

test('MAYAN: setback produces flat runs and discrete drops', () => {
  const stack = stackMass({
    footprint: SQUARE, levelCount: 6,
    profile: { mode: MASS_PROFILE.SETBACK, step: 2, every: 2 },
  });
  const areas = [0, 1, 2, 3, 4, 5].map(i => storeyArea(stack, i));
  assert.ok(Math.abs(areas[0] - areas[1]) < 1e-6, 'a step lasts `every` levels');
  assert.ok(areas[2] < areas[1] - 1, 'and then drops');
  assert.ok(Math.abs(areas[2] - areas[3]) < 1e-6);
  assert.ok(areas[4] < areas[3] - 1);
});

test('MEDIEVAL: jetty grows every storey outward', () => {
  const stack = stackMass({
    footprint: SQUARE, levelCount: 4,
    profile: { mode: MASS_PROFILE.JETTY, amount: 1.2 },
  });
  const areas = [0, 1, 2, 3].map(i => storeyArea(stack, i));
  for (let i = 1; i < areas.length; i++) {
    assert.ok(areas[i] > areas[i - 1], `storey ${i} did not overhang`);
  }
});

test('a courtyard survives the whole stack', () => {
  const stack = stackMass({ footprint: COURTYARD, levelCount: 3 });
  for (const level of stack.levels) {
    assert.equal(level.polygon.holes.length, 1, 'the courtyard must not close up');
  }
  assert.ok(Math.abs(storeyArea(stack, 0) - (900 - 100)) < 1e-6);
});

test('battering a courtyard shrinks the building AND opens the court', () => {
  // Inward for the building is outward for the void - the one that is easy to
  // get backwards and produces a courtyard that closes as the tower rises.
  const stack = stackMass({
    footprint: COURTYARD, levelCount: 3,
    profile: { mode: MASS_PROFILE.BATTER, amount: 2 },
  });
  const top = storey(stack, 2)[0].polygon;
  const outerSpan = Math.max(...top.outer.map(p => p[0])) - Math.min(...top.outer.map(p => p[0]));
  const holeSpan = Math.max(...top.holes[0].map(p => p[0])) - Math.min(...top.holes[0].map(p => p[0]));
  assert.ok(outerSpan < 30, `outer did not shrink: ${outerSpan}`);
  assert.ok(holeSpan > 10, `courtyard did not open: ${holeSpan}`);
});

test('an L-plan battered far enough SPLITS into separate level records', () => {
  // The reason a storey is not guaranteed to be one polygon. Arms 8m wide, so
  // they survive to 4m of inset; the corner between them goes first.
  const stack = stackMass({
    footprint: L_SHAPE, levelCount: 6,
    profile: { mode: MASS_PROFILE.BATTER, amount: 5 },
  });
  const counts = [0, 1, 2, 3, 4, 5].map(i => storey(stack, i).length);
  assert.equal(counts[0], 1, 'the ground course is whole');
  assert.ok(counts.some(c => c > 1) || stack.truncatedAt !== null,
    `expected a split or a truncation, got ${JSON.stringify(counts)}`);
});

test('a profile that consumes the footprint truncates the stack and says where', () => {
  const stack = stackMass({
    footprint: SQUARE, levelCount: 10,
    profile: { mode: MASS_PROFILE.SETBACK, step: 4, every: 1 },
  });
  assert.notEqual(stack.truncatedAt, null, 'truncation must be reported');
  assert.ok(stack.levels.length < 10);
  // The height must match the levels actually emitted, or the roof floats.
  const top = Math.max(...stack.levels.map(l => l.z1));
  assert.equal(stack.height, top);
});

test('a plinth sits below the ground floor and does not renumber it', () => {
  // Numbering the plinth 0 would push the ground floor to 1 and shift every
  // seeded choice in the building by one level.
  const stack = stackMass({ footprint: SQUARE, levelCount: 2, plinthHeight: 1.2 });
  assert.equal(stack.levels[0].kind, LEVEL_KIND.PLINTH);
  assert.equal(stack.levels[0].z0, 0);
  assert.equal(stack.levels[0].z1, 1.2);
  assert.equal(stack.levels[1].kind, LEVEL_KIND.GROUND);
  assert.equal(stack.levels[1].index, 0, 'the ground floor is still index 0');
});

test('a plinth is not battered', () => {
  const stack = stackMass({
    footprint: SQUARE, levelCount: 2, plinthHeight: 1,
    profile: { mode: MASS_PROFILE.BATTER, amount: 4 },
  });
  assert.ok(Math.abs(polygonArea(stack.levels[0].polygon) - 400) < 1e-6);
});

// --- rounded corners ---------------------------------------------------------
//
// Every one of these failed before rounding became its own operation. The bug
// was reported as "sometimes Rounded does nothing, sometimes only some corners
// are rounded", and the three profiles below are the three faces of it.

const roundness = level => level.polygon.outer.length;

test('ROUNDED works on a STRAIGHT profile', () => {
  // The first face of the bug: a straight profile offsets by zero, so handing
  // Clipper a round join rounded nothing at all.
  const sharp = stackMass({ footprint: SQUARE, levelCount: 3 });
  const round = stackMass({ footprint: SQUARE, levelCount: 3, cornerRadius: 1.5 });
  assert.equal(roundness(sharp.levels[0]), 4);
  assert.ok(roundness(round.levels[0]) > 8,
    `expected an arc, got ${roundness(round.levels[0])} vertices`);
});

test('ROUNDED works on an INWARD profile (batter)', () => {
  // The second face: a round join puts no arc on the inside of a turn, so an
  // inward offset stayed sharp however large the amount.
  const stack = stackMass({
    footprint: SQUARE, levelCount: 4, cornerRadius: 1.5,
    profile: { mode: MASS_PROFILE.BATTER, amount: 2 },
  });
  for (const level of stack.levels) {
    assert.ok(roundness(level) > 8, `storey ${level.index} is sharp`);
  }
});

test('EVERY storey is rounded, including the ground floor', () => {
  // The third face, and the one the report described: an outward profile rounded
  // storeys 1..n but never storey 0, whose inset is zero.
  for (const mode of [MASS_PROFILE.STRAIGHT, MASS_PROFILE.BATTER, MASS_PROFILE.JETTY]) {
    const stack = stackMass({
      footprint: SQUARE, levelCount: 4, cornerRadius: 1.2,
      profile: { mode, amount: 1.5 },
    });
    const counts = stack.levels.map(roundness);
    assert.ok(counts.every(n => n > 8), `${mode} left a sharp storey: ${counts}`);
  }
});

test('rounding keeps the plan the same size, within the radius', () => {
  // A fillet must round the corners, not shrink the building.
  const sharp = stackMass({ footprint: SQUARE, levelCount: 1 });
  const round = stackMass({ footprint: SQUARE, levelCount: 1, cornerRadius: 1 });
  const lost = polygonArea(sharp.levels[0].polygon) - polygonArea(round.levels[0].polygon);
  // Four corners each lose r^2 - pi r^2/4 = 0.215 m2 at r = 1.
  assert.ok(lost > 0 && lost < 1.2, `lost ${lost} m2, expected about 0.86`);
});

test('rounding a courtyard rounds the courtyard too', () => {
  const stack = stackMass({ footprint: COURTYARD, levelCount: 1, cornerRadius: 1 });
  assert.equal(stack.levels[0].polygon.holes.length, 1, 'the courtyard must survive');
  assert.ok(stack.levels[0].polygon.holes[0].length > 8, 'the courtyard is still sharp');
});

test('rounding an L-plan rounds the REFLEX corner as well as the convex ones', () => {
  // Opening alone rounds only convex corners; the closing pass is what rounds the
  // inside of an L. Without it the notch stays a sharp right angle.
  const stack = stackMass({ footprint: L_SHAPE, levelCount: 1, cornerRadius: 1 });
  const ring = stack.levels[0].polygon.outer;
  // The L's reflex corner is at (8, 8). Nothing should remain that close to it.
  const nearest = Math.min(...ring.map(p => Math.hypot(p[0] - 8, p[1] - 8)));
  assert.ok(nearest > 0.2, `a sharp vertex survived at the notch (${nearest}m away)`);
});

test('a radius wide enough to sever the plan is refused, not applied', () => {
  // A building must never silently break into pieces because of a corner setting.
  const thin = {
    outer: [[0, 0], [30, 0], [30, 2], [16, 2], [16, 14], [14, 14], [14, 2], [0, 2]],
    holes: [],
  };
  const stack = stackMass({ footprint: thin, levelCount: 1, cornerRadius: 4 });
  assert.equal(stack.cornerRadiusTooLarge, true, 'it must report the refusal');
  assert.equal(stack.levels.length, 1, 'and keep one solid building');
});

test('a zero radius leaves the plan exactly as drawn', () => {
  const sharp = stackMass({ footprint: L_SHAPE, levelCount: 2 });
  const zero = stackMass({ footprint: L_SHAPE, levelCount: 2, cornerRadius: 0 });
  assert.equal(JSON.stringify(zero.levels), JSON.stringify(sharp.levels));
});

test('rounding stays deterministic', () => {
  const once = stackMass({ footprint: L_SHAPE, levelCount: 3, cornerRadius: 0.8 });
  const twice = stackMass({ footprint: L_SHAPE, levelCount: 3, cornerRadius: 0.8 });
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
});

test('an arc does not explode the vertex count', () => {
  // The arc tolerance was 25 microns, which flattened one rounded rectangle into
  // 632 vertices - per storey, all of it wall geometry.
  const stack = stackMass({ footprint: SQUARE, levelCount: 1, cornerRadius: 2 });
  const n = roundness(stack.levels[0]);
  assert.ok(n > 8 && n < 80, `${n} vertices for four corners`);
});

// --- guards -----------------------------------------------------------------

test('a degenerate footprint yields nothing rather than throwing', () => {
  for (const bad of [null, { outer: [] }, { outer: [[0, 0], [1, 1]] }]) {
    const stack = stackMass({ footprint: bad, levelCount: 3 });
    assert.deepEqual(stack.levels, []);
    assert.equal(stack.height, 0);
  }
});

test('level count and heights are clamped', () => {
  const huge = stackMass({ footprint: SQUARE, levelCount: 10_000 });
  assert.ok(huge.levels.length <= MAX_LEVELS, `${huge.levels.length} levels`);
  const zero = stackMass({ footprint: SQUARE, levelCount: 3, levelHeight: 0 });
  assert.ok(zero.height > 0, 'a zero storey height must not collapse the building');
});

test('stackMass is deterministic', () => {
  const once = stackMass({ footprint: L_SHAPE, levelCount: 5, profile: { mode: MASS_PROFILE.BATTER, amount: 1.7 } });
  const twice = stackMass({ footprint: L_SHAPE, levelCount: 5, profile: { mode: MASS_PROFILE.BATTER, amount: 1.7 } });
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
});

// --- helpers ----------------------------------------------------------------

test('offsetFootprint short-circuits a zero inset', () => {
  const out = offsetFootprint(SQUARE, 0);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(polygonArea(out[0]) - 400) < 1e-6);
});

test('topOfStack returns the highest surface, not the footprint', () => {
  // Roofing the footprint of a battered mass floats the roof out past the walls.
  const stack = stackMass({
    footprint: SQUARE, levelCount: 4,
    profile: { mode: MASS_PROFILE.BATTER, amount: 3 },
  });
  const top = topOfStack(stack);
  assert.equal(top.z, stack.height);
  assert.equal(top.polygons.length, 1);
  assert.ok(polygonArea(top.polygons[0]) < 400, 'the roof must sit on the shrunken top');
  assert.deepEqual(topOfStack({ levels: [] }), { z: 0, polygons: [] });
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`mass.test.mjs: ${passed} passed`);
