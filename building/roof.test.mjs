// node building/roof.test.mjs
//
// The claim under test is the one mass.js made in Phase 1 and this file is
// supposed to cash: that a roof is the same offset stack continued until it
// closes, with no straight-skeleton implementation and no per-shape geometry.

import assert from 'node:assert/strict';
import {
  MAX_ROOF_STEPS, RIDGE, ROOF_KIND, bandBetween, generateRoof, longestAxis, ridgeDirection,
  roofIsCapped, roofTop, rungKind, stackRoofs,
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

// --- eaves ---------------------------------------------------------------------

/** The widest span of a rung, across the x axis. */
const spanOf = (rung) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const polygon of rung.polygons) {
    for (const point of polygon.outer) { lo = Math.min(lo, point[0]); hi = Math.max(hi, point[0]); }
  }
  return hi - lo;
};

test('an eave oversails the wall and drops by its own pitch', () => {
  // A roof plane is ONE plane. Carry it past the wall head and the edge has to
  // fall by the rise it would have gained over that distance - that drop is the
  // shadow line under a roof, and widening the contour without it would leave
  // the eave floating level with the wall top.
  const plain = roofOf(rect(14, 10), { kind: ROOF_KIND.HIP, pitch: 30 });
  const eaved = roofOf(rect(14, 10), { kind: ROOF_KIND.HIP, pitch: 30, eave: 1.5 });

  assert.ok(Math.abs(spanOf(eaved.rungs[0]) - (spanOf(plain.rungs[0]) + 3)) < 0.05,
    'the eave contour is not the plan plus an overhang on each side');
  const drop = plain.rungs[0].z - eaved.rungs[0].z;
  assert.ok(Math.abs(drop - 1.5 * Math.tan((30 * Math.PI) / 180)) < 0.02,
    `the eave dropped ${drop.toFixed(3)}m, not one overhang of pitch`);

  // AND THE PLANE STILL PASSES THROUGH THE WALL HEAD. Not "the ridge rose by
  // the drop" - it does not: a hip's apex is fixed by the inradius, so extending
  // the plane outward leaves the ridge where it was. What must hold is that the
  // surface crosses z = baseZ exactly where the wall is, so read the height off
  // the eaved roof at the span the wall actually has.
  let crossing = null;
  for (let i = 1; i < eaved.rungs.length; i++) {
    const wide = spanOf(eaved.rungs[i - 1]);
    const narrow = spanOf(eaved.rungs[i]);
    if (wide >= 14 && narrow <= 14) {
      const t = (wide - 14) / (wide - narrow);
      crossing = eaved.rungs[i - 1].z + t * (eaved.rungs[i].z - eaved.rungs[i - 1].z);
      break;
    }
  }
  assert.ok(crossing !== null, 'the eaved roof never narrows back to the plan');
  assert.ok(Math.abs(crossing - 10) < 0.02,
    `the roof crosses the wall line at ${crossing.toFixed(3)}m, not at the wall head`);
});

test('a height cap measures from the building, not from the eave', () => {
  // Otherwise adding an overhang silently shortens every capped roof - the cap
  // would eat the drop first and the deck would come out low.
  const capped = roofOf(rect(14, 10), {
    kind: ROOF_KIND.HIP, pitch: 30, maxHeight: 2, eave: 1.5,
  });
  const plain = roofOf(rect(14, 10), { kind: ROOF_KIND.HIP, pitch: 30, maxHeight: 2 });
  assert.ok(Math.abs(roofTop(capped).z - roofTop(plain).z) < 1e-6,
    'the eave moved where the deck ended up');
});

test('an eave drop is a vertical rung under the eave', () => {
  const eaved = roofOf(rect(14, 10), { kind: ROOF_KIND.HIP, pitch: 30, eave: 1.5 });
  const fascia = roofOf(rect(14, 10), {
    kind: ROOF_KIND.HIP, pitch: 30, eave: 1.5, eaveDrop: 0.4,
  });

  assert.equal(fascia.rungs.length, eaved.rungs.length + 1);
  assert.ok(Math.abs((eaved.rungs[0].z - fascia.rungs[0].z) - 0.4) < 1e-6);
  // Same contour at two heights is what the mesher reads as a vertical face.
  assert.ok(Math.abs(spanOf(fascia.rungs[0]) - spanOf(fascia.rungs[1])) < 1e-9);
  assert.equal(rungKind(fascia.rungs[0], fascia.rungs[1]), 'riser');
  // The ridge did not move: only the edge dropped.
  assert.ok(Math.abs(roofTop(fascia).z - roofTop(eaved).z) < 1e-6);
});

test('a fascia is closed by the ladder, not by the end wall', () => {
  // The skirt stands on the EAVE. An eave drop adds a rung with the same contour
  // at a lower z, and the band between those two IS a vertical riser the mesher
  // already draws all the way round - so a wall reaching below the eave would be
  // a second copy of it, and there would be a wall along every eave where there
  // should be none.
  const roof = roofOf(rect(14, 10), {
    kind: ROOF_KIND.GABLE, pitch: 35, eave: 1.2, eaveDrop: 0.5, ridgeAxis: [1, 0],
  });
  assert.equal(roof.gables.length, 2, 'a gable closes at two ends and nowhere else');

  // The fascia is the first two rungs: one contour at two heights.
  assert.equal(rungKind(roof.rungs[0], roof.rungs[1]), 'riser');
  const eaveZ = roof.rungs[1].z;
  for (const gable of roof.gables) {
    for (const point of gable) {
      assert.ok(point[2] >= eaveZ - 1e-6,
        `a wall point at ${point[2].toFixed(3)} hangs below the eave at ${eaveZ.toFixed(3)}`);
    }
  }
});

test('a shed can fall either way, and the tall wall follows', () => {
  // `ridge` picks the AXIS a shed falls across; it says nothing about WHICH end
  // of that axis is high, so without a flip the same plan could only ever slope
  // one way and the other three of the four directions were unreachable.
  const plan = rect(12, 8);
  const opts = { kind: ROOF_KIND.SHED, pitch: 30, ridgeAxis: [1, 0] };
  const normal = roofOf(plan, opts);
  const flipped = roofOf(plan, { ...opts, flip: true });

  // The ridge is the top rung's narrow strip. With the axis along x, the fall is
  // across y - so read where that strip sits in y.
  const ridgeY = (roof) => {
    const top = roof.rungs[roof.rungs.length - 1];
    let lo = Infinity;
    let hi = -Infinity;
    for (const polygon of top.polygons) {
      for (const point of polygon.outer) { lo = Math.min(lo, point[1]); hi = Math.max(hi, point[1]); }
    }
    return (lo + hi) / 2;
  };

  assert.ok(ridgeY(normal) < 1, `the unflipped ridge sat at y=${ridgeY(normal).toFixed(2)}`);
  assert.ok(ridgeY(flipped) > 7, `the flipped ridge sat at y=${ridgeY(flipped).toFixed(2)}`);
  // Same roof, mirrored: the height must not change with the direction.
  assert.ok(Math.abs(normal.height - flipped.height) < 1e-6);

  // AND THE TALL WALL MOVES WITH IT. A shed's high side is closed by a wall
  // carried in `gables`; leaving it behind would show as the slope vanishing
  // rather than as a hole, because the wall is single-sided.
  const wallY = (roof) => {
    // The shed wall is the one whose points all share a y - the vertical face on
    // the high side. The two end walls span the fall, so they do not.
    for (const gable of roof.gables) {
      const ys = gable.map(point => point[1]);
      if (Math.max(...ys) - Math.min(...ys) < 1e-6) return ys[0];
    }
    return null;
  };
  assert.ok(wallY(normal) !== null && wallY(flipped) !== null, 'a shed lost its tall wall');
  assert.ok(Math.abs(wallY(normal) - ridgeY(normal)) < 1.5,
    'the tall wall is not on the high side');
  assert.ok(Math.abs(wallY(flipped) - ridgeY(flipped)) < 1.5,
    'the flipped tall wall did not move with the slope');
});

/** A 3D polygon's area, from the magnitude of its Newell normal. */
const wallArea = (points) => {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return Math.hypot(nx, ny, nz) / 2;
};

test('a ridge at any angle still closes the roof', () => {
  // THE BUG THIS EXISTS FOR. The end walls used to stand on the plane through
  // each extreme of the ridge axis, which is only a plane when the axis lies
  // along an edge of the plan. Turn the ridge to 70 degrees over a rectangle and
  // the extreme is a single CORNER, so every wall collapsed to a zero-width
  // sliver and the roof came out with no sides - a floating slab you could see
  // straight through. Broken at every angle but 0, 90 and 180, for gables as
  // well as sheds, for as long as a custom angle has existed.
  for (const kind of [ROOF_KIND.GABLE, ROOF_KIND.SHED]) {
    for (const angle of [0, 15, 37, 45, 70, 90, 115, 180]) {
      const roof = roofOf(rect(12, 8), {
        kind, pitch: 35, ridge: RIDGE.CUSTOM, ridgeAngle: angle,
      });
      assert.ok(roof.gables.length >= 2, `${kind} at ${angle} deg closed nothing`);
      for (const [index, wall] of roof.gables.entries()) {
        assert.ok(wallArea(wall) > 0.01,
          `${kind} at ${angle} deg: wall ${index} is a sliver of area `
          + `${wallArea(wall).toFixed(4)} and will not render`);
      }
    }
  }
});

test('an angled ridge closes an L-plan and a courtyard too', () => {
  // The skirt follows the plan's BOUNDARY, so a concave plan and a hole are not
  // special cases - and a courtyard's skirt has to face inward.
  for (const plan of [L_SHAPE, COURTYARD]) {
    for (const kind of [ROOF_KIND.GABLE, ROOF_KIND.SHED]) {
      const roof = generateRoof({
        polygons: [plan], baseZ: 5, kind, pitch: 35, ridge: RIDGE.CUSTOM, ridgeAngle: 37,
      });
      assert.ok(roof.gables.length >= 2);
      for (const wall of roof.gables) {
        assert.ok(wallArea(wall) > 0.01, `${kind} left a sliver on a concave plan`);
      }
    }
  }
});

test('an aligned roof closes exactly as it always did', () => {
  // The skirt has to reproduce the old two-flat-walls result where that result
  // was right, or every existing building changes shape. A gable closes at two
  // ends; a shed at two ends and its tall side; and the areas are the same.
  const gable = roofOf(rect(12, 8), { kind: ROOF_KIND.GABLE, pitch: 35, ridgeAxis: [1, 0] });
  assert.equal(gable.gables.length, 2);
  for (const wall of gable.gables) assert.ok(Math.abs(wallArea(wall) - 11.2) < 0.05);

  const shed = roofOf(rect(12, 8), { kind: ROOF_KIND.SHED, pitch: 35, ridgeAxis: [1, 0] });
  assert.equal(shed.gables.length, 3);
  const areas = shed.gables.map(wallArea).sort((a, b) => a - b);
  assert.ok(Math.abs(areas[0] - 22.41) < 0.05, `ends were ${areas[0].toFixed(2)}`);
  assert.ok(Math.abs(areas[1] - 22.41) < 0.05);
  assert.ok(Math.abs(areas[2] - 67.21) < 0.05, `the tall side was ${areas[2].toFixed(2)}`);
});

test('every vertical wall faces out, whichever way the shed falls', () => {
  // A wall wound the wrong way is INVISIBLE under a single-sided material - it
  // does not read as a hole, the slope behind it simply shows through - so this
  // is the check that a flipped shed is not quietly missing its tall side.
  //
  // The rule is one SIGN shared by every wall of a correct roof, measured rather
  // than assumed: winding follows which side of the profile recedes, and that is
  // exactly what `flip` changes.
  const newell = (points) => {
    let nx = 0;
    let ny = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
    }
    return [nx, ny];
  };
  // The plan's middle, to say which way "out" is from a wall that sits on it.
  const centreOf = (roof) => {
    let x = 0;
    let y = 0;
    let n = 0;
    for (const polygon of roof.rungs[0].polygons) {
      for (const point of polygon.outer) { x += point[0]; y += point[1]; n += 1; }
    }
    return [x / n, y / n];
  };

  const cases = [
    ['shed', { kind: ROOF_KIND.SHED, pitch: 35, ridgeAxis: [1, 0] }],
    ['shed flipped', { kind: ROOF_KIND.SHED, pitch: 35, ridgeAxis: [1, 0], flip: true }],
    ['shed across', { kind: ROOF_KIND.SHED, pitch: 35, ridgeAxis: [0, 1] }],
    ['shed across flipped', { kind: ROOF_KIND.SHED, pitch: 35, ridgeAxis: [0, 1], flip: true }],
    ['gable', { kind: ROOF_KIND.GABLE, pitch: 40, ridgeAxis: [1, 0] }],
  ];

  for (const [label, opts] of cases) {
    const roof = roofOf(rect(12, 8), opts);
    const [cx, cy] = centreOf(roof);
    assert.ok(roof.gables.length >= 2, `${label} lost its walls`);
    for (const [index, wall] of roof.gables.entries()) {
      let wx = 0;
      let wy = 0;
      for (const point of wall) { wx += point[0]; wy += point[1]; }
      const out = [wx / wall.length - cx, wy / wall.length - cy];
      const [nx, ny] = newell(wall);
      assert.ok(nx * out[0] + ny * out[1] < 0,
        `${label}: wall ${index} is wound inward and will not render`);
    }
  }
});

test('flipping is a shed-only control and leaves other kinds alone', () => {
  // Every other shape is symmetric about its ridge, so a flip would be a control
  // that silently does nothing - and worse, one that could quietly change a
  // saved roof if it ever started being honoured.
  const plan = rect(12, 8);
  for (const kind of [ROOF_KIND.GABLE, ROOF_KIND.HIP, ROOF_KIND.MANSARD]) {
    const plain = roofOf(plan, { kind, pitch: 35, ridgeAxis: [1, 0] });
    const flipped = roofOf(plan, { kind, pitch: 35, ridgeAxis: [1, 0], flip: true });
    assert.equal(flipped.rungs.length, plain.rungs.length, `${kind} changed shape`);
    assert.ok(Math.abs(flipped.height - plain.height) < 1e-9, `${kind} changed height`);
  }
});

test('a tiered roof spends its overhang per tier, not on one eave', () => {
  // Stepped and Tiered already mean something else by `overhang` - each tread
  // oversails the one below, which is the whole difference between an Asian
  // roof and a ziggurat - so the eave must NOT also move their base contour.
  const tiered = roofOf(rect(30, 24), {
    kind: ROOF_KIND.TIERED, stepRun: 1.2, stepRise: 0.8, overhang: 0.6,
  });
  assert.ok(Math.abs(spanOf(tiered.rungs[0]) - 30) < 1e-6, 'the base contour was widened');
  assert.equal(tiered.rungs[0].z, 10, 'the base rung dropped');
});

test('a gable capping a hip keeps its end walls - irimoya', () => {
  // The hip-and-gable roof: a hip truncated part way, then a gable carrying on
  // from that deck. The gable's END WALLS are the white tympanum you see on a
  // temple, and stacking used to drop the field they travel in - so the roof
  // came out open at both ends with nothing to say so, the same way a shed
  // without its tall side reads as a vanishing slope rather than a hole.
  const lower = roofOf(rect(22, 16), { kind: ROOF_KIND.HIP, pitch: 30, maxHeight: 1.6 });
  assert.equal((lower.gables || []).length, 0, 'a hip has no end walls to begin with');

  const top = roofTop(lower);
  const upper = generateRoof({
    polygons: top.polygons, baseZ: top.z, kind: ROOF_KIND.GABLE, pitch: 36, ridgeAxis: 'x',
  });
  assert.equal(upper.gables.length, 2, 'the gable stage itself must produce two ends');

  const stacked = stackRoofs(lower, upper);
  assert.equal(stacked.kind, ROOF_KIND.STACKED);
  assert.equal(stacked.gables.length, 2, 'the end walls did not survive the stack');

  // And they belong to the UPPER band: every point of a surviving gable stands
  // at or above the deck the hip stopped on, so this is the gable's own wall
  // rather than something copied off the roof below.
  // A gable is a list of [x, y, z] points here; compile.js is what wraps it
  // into the { path } the mesher reads.
  for (const gable of stacked.gables) {
    for (const point of gable) {
      assert.ok(point[2] >= top.z - 1e-6, 'a gable point sits below the hip it caps');
    }
  }
});

test('two gable stages keep both sets of end walls', () => {
  // The union, not the upper: each stage walls its own band of the ladder.
  const lower = roofOf(rect(22, 16), {
    kind: ROOF_KIND.GABLE, pitch: 24, maxHeight: 1.8, ridgeAxis: 'x',
  });
  const top = roofTop(lower);
  const upper = generateRoof({
    polygons: top.polygons, baseZ: top.z, kind: ROOF_KIND.GABLE, pitch: 40, ridgeAxis: 'x',
  });
  assert.equal(stackRoofs(lower, upper).gables.length,
    lower.gables.length + upper.gables.length);
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

// --- gable and shed ---------------------------------------------------------
//
// The two shapes Phase 3 deliberately left out, because they are NOT the offset
// walk: the plan is cut down across the ridge instead of inset on every side,
// and the vertical end walls are not between any two contours.

const wide = rect(20, 10);
const tall = rect(10, 20);

test('the ridge runs along the building, measured by the NARROWEST perpendicular', () => {
  // Not by the longest extent: on a 20x10 rectangle the longest extent is the
  // DIAGONAL at 22.4m, which would put the ridge across the corners and made a
  // 45-degree gable 8.1m tall instead of 5m.
  const near = (got, want) => got.every((v, i) => Math.abs(v - want[i]) < 1e-9);
  assert.ok(near(ridgeDirection([wide]), [1, 0]), `20x10 gave [${ridgeDirection([wide])}]`);
  assert.ok(near(ridgeDirection([tall]), [0, 1]), `10x20 gave [${ridgeDirection([tall])}]`);
});

test('across turns the ridge ninety degrees, custom points it', () => {
  // Compared with a tolerance rather than rounded: Math.round of a tiny negative
  // is -0, and deepEqual holds that -0 is not 0.
  const near = (got, want) => got.every((v, i) => Math.abs(v - want[i]) < 1e-9);
  assert.ok(near(ridgeDirection([wide], RIDGE.ACROSS), [0, 1]),
    `across gave [${ridgeDirection([wide], RIDGE.ACROSS)}]`);
  assert.ok(near(ridgeDirection([wide], RIDGE.CUSTOM, 90), [0, 1]),
    `custom 90 gave [${ridgeDirection([wide], RIDGE.CUSTOM, 90)}]`);
  assert.ok(near(ridgeDirection([wide], RIDGE.CUSTOM, 0), [1, 0]));
});

test('a gable closes over HALF the width, a shed over all of it', () => {
  // The whole difference between them, and the reason a shed at the same pitch
  // climbs about twice as high.
  for (const pitch of [25, 40, 60]) {
    const gable = roofOf(wide, { kind: ROOF_KIND.GABLE, pitch });
    const shed = roofOf(wide, { kind: ROOF_KIND.SHED, pitch });
    const tan = Math.tan((pitch * Math.PI) / 180);
    assert.ok(Math.abs(gable.height - 5 * tan) < 0.01,
      `gable at ${pitch}deg is ${gable.height.toFixed(3)}, expected ${(5 * tan).toFixed(3)}`);
    assert.ok(Math.abs(shed.height - 10 * tan) < 0.01,
      `shed at ${pitch}deg is ${shed.height.toFixed(3)}, expected ${(10 * tan).toFixed(3)}`);
  }
});

test('THE RIDGE IS REACHED, not stopped a step short', () => {
  // The walk cannot go to exactly the full span - the slab has zero width there
  // and the contour vanishes - so it stops a hair short deliberately. A whole
  // step short instead was an eight per cent height error nobody would have
  // attributed to the step count.
  const roof = roofOf(wide, { kind: ROOF_KIND.GABLE, pitch: 45 });
  assert.ok(Math.abs(roof.height - 5) < 0.005,
    `the ridge reached ${roof.height.toFixed(4)}m, expected 5m`);
  assert.equal(roof.closed, true);
});

test('a gable has TWO vertical end walls, a shed THREE, and a hip none', () => {
  // The part the contour ladder cannot say, and the reason these were deferred.
  // A shed gets a third: it closes from one side only, so its tall side is an
  // open face that nothing else in the ladder describes. This test asserted two
  // and was WRONG - see the shed wall tests below.
  assert.equal(roofOf(wide, { kind: ROOF_KIND.GABLE, pitch: 40 }).gables.length, 2);
  assert.equal(roofOf(wide, { kind: ROOF_KIND.SHED, pitch: 40 }).gables.length, 3);
  for (const kind of [ROOF_KIND.HIP, ROOF_KIND.MANSARD, ROOF_KIND.STEPPED, ROOF_KIND.FLAT]) {
    assert.deepEqual(roofOf(wide, { kind, pitch: 40 }).gables, [], kind);
  }
});

test('the end walls sit at the ends, span the full width, and reach the ridge', () => {
  const roof = generateRoof({ polygons: [wide], baseZ: 3, kind: ROOF_KIND.GABLE, pitch: 45 });
  assert.equal(roof.gables.length, 2);
  const ends = new Set();
  for (const wall of roof.gables) {
    const xs = wall.map(p => p[0]);
    const ys = wall.map(p => p[1]);
    const zs = wall.map(p => p[2]);
    // Vertical: every point of one wall is at the same x.
    assert.ok(Math.max(...xs) - Math.min(...xs) < 1e-6, 'an end wall is not vertical');
    ends.add(Math.round(Math.max(...xs)));
    assert.ok(Math.abs(Math.min(...ys)) < 1e-6 && Math.abs(Math.max(...ys) - 10) < 1e-6,
      `the wall spans y ${Math.min(...ys)}..${Math.max(...ys)}, expected 0..10`);
    assert.ok(Math.abs(Math.min(...zs) - 3) < 1e-6, 'the wall does not start at the eaves');
    assert.ok(Math.abs(Math.max(...zs) - 8) < 0.01, 'the wall does not reach the ridge');
  }
  assert.deepEqual([...ends].sort((a, b) => a - b), [0, 20], 'both walls are at the same end');
});

test('a shed leans the way the pitch points, every face walled', () => {
  // A shed has no ridge, so its two ends are right-angled triangles rather than
  // symmetric ones - the same walls, a different outline - and its tall side is
  // a third wall the ladder does not describe either.
  const roof = generateRoof({ polygons: [wide], baseZ: 0, kind: ROOF_KIND.SHED, pitch: 45 });
  assert.equal(roof.gables.length, 3);
  for (const wall of roof.gables) {
    const zs = wall.map(p => p[2]);
    assert.ok(Math.abs(Math.min(...zs)) < 1e-6);
    assert.ok(Math.abs(Math.max(...zs) - 10) < 0.01, `the high edge reached ${Math.max(...zs)}`);
  }
});

test('the ridge direction turns the roof with it', () => {
  // Same plan, ridge across instead of along: the span it closes over is now the
  // 20m one, so the same pitch gives a much taller roof.
  const along = roofOf(wide, { kind: ROOF_KIND.GABLE, pitch: 45 });
  const across = roofOf(wide, { kind: ROOF_KIND.GABLE, pitch: 45, ridge: RIDGE.ACROSS });
  assert.ok(Math.abs(along.height - 5) < 0.01);
  assert.ok(Math.abs(across.height - 10) < 0.02, `across gave ${across.height.toFixed(3)}`);
});

test('a height cap stops a gable on a flat deck, and it is not closed', () => {
  const roof = roofOf(wide, { kind: ROOF_KIND.GABLE, pitch: 70, maxHeight: 3 });
  assert.ok(Math.abs(roof.height - 3) < 1e-6, `capped at ${roof.height}`);
  assert.equal(roof.closed, false);
  // The end walls stop at the deck too, rather than carrying on to a ridge that
  // is not there.
  for (const wall of roof.gables) {
    // roofOf builds at baseZ 10, so the cap is at 13 in world terms - `height`
    // is relative to the eaves and the wall's points are not.
    assert.ok(Math.max(...wall.map(p => p[2])) <= 13 + 1e-3,
      `a wall reached ${Math.max(...wall.map(p => p[2]))}, cap is 13`);
    assert.ok(Math.abs(Math.min(...wall.map(p => p[2])) - 10) < 1e-6,
      'a wall does not start at the eaves');
  }
});

test('a gable works on an L-plan and on a plan with a courtyard', () => {
  // The offset walk handles these because Clipper does; the slab cut has to as
  // well, or "gable" would be a rectangle-only shape.
  for (const [name, plan] of [['L', L_SHAPE], ['courtyard', COURTYARD]]) {
    const roof = generateRoof({ polygons: [plan], baseZ: 0, kind: ROOF_KIND.GABLE, pitch: 35 });
    assert.ok(roof.rungs.length > 2, `${name}: only ${roof.rungs.length} rungs`);
    assert.ok(roof.height > 0, `${name}: no height`);
    assert.notEqual(roof.kind, ROOF_KIND.FLAT, `${name} fell back to flat`);
  }
});

test('a tiny plan gets a tiny gable, and a degenerate one falls back', () => {
  // The same premise that was wrong for hip roofs in Phase 3, and wrong here for
  // the same reason: "too small" means the walk produced NOTHING, not that the
  // result is small. A 2cm plan legitimately gets a 6mm roof - and unlike the
  // offset walk, the slab cut never runs out on a real plan, so the fallback
  // fires only when there is no span at all.
  const tiny = roofOf(rect(0.02, 0.02), { kind: ROOF_KIND.GABLE, pitch: 40 });
  assert.equal(tiny.kind, ROOF_KIND.GABLE);
  assert.ok(tiny.height > 0 && tiny.height < 0.02, `a 2cm plan got a ${tiny.height}m roof`);

  // A zero-area plan has nothing to roof, and produces no rungs rather than
  // throwing. Not reachable through the compiler - a mass with no area stops
  // earlier - but generateRoof is exported and a caller may hand it anything.
  const degenerate = generateRoof({
    polygons: [{ outer: [[0, 0], [10, 0], [10, 0]], holes: [] }],
    baseZ: 0, kind: ROOF_KIND.GABLE, pitch: 40,
  });
  assert.deepEqual(degenerate.rungs, []);
  assert.equal(degenerate.height, 0);
  assert.deepEqual(degenerate.gables, []);
});

test('a gable is deterministic', () => {
  const a = generateRoof({ polygons: [L_SHAPE], baseZ: 2, kind: ROOF_KIND.GABLE, pitch: 38 });
  const b = generateRoof({ polygons: [L_SHAPE], baseZ: 2, kind: ROOF_KIND.GABLE, pitch: 38 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('a SHED encloses its tall side, or the roof has a hole in it', () => {
  // Reported as "only one side of the faces is visible". A shed closes from ONE
  // side, so its fixed edge ends up metres above the wall it started on with
  // nothing between them. A single-sided material does not show that as a hole -
  // it shows the sloping plane vanishing, which is far harder to diagnose, and
  // it is why this went unnoticed through the whole of Phase 3.
  const shed = roofOf(rect(12, 8), { kind: ROOF_KIND.SHED, pitch: 35 });
  const gable = roofOf(rect(12, 8), { kind: ROOF_KIND.GABLE, pitch: 35 });
  assert.equal(gable.gables.length, 2, 'a gable has two ends and nothing else');
  assert.equal(shed.gables.length, 3, 'a shed needs its two ends AND its tall side');

  // The tall side spans the whole roof height, which neither triangular end
  // does - those meet the slope.
  const spanOf = wall => {
    const zs = wall.map(point => point[2]);
    return Math.max(...zs) - Math.min(...zs);
  };
  const tallest = Math.max(...shed.gables.map(spanOf));
  assert.ok(Math.abs(tallest - shed.height) < 1e-3,
    `the tall side spans ${tallest.toFixed(2)}m of a ${shed.height.toFixed(2)}m roof`);
});

test('the high edge of a shed is WALLED, whichever side it is on', () => {
  const shed = roofOf(rect(12, 8), { kind: ROOF_KIND.SHED, pitch: 35 });
  const top = shed.rungs[shed.rungs.length - 1].polygons[0].outer;

  // Picking "the tallest wall" does not identify it: a shed's triangular ENDS
  // span the full height too. What distinguishes the tall side is that the high
  // edge lies in it - which is the property worth asserting anyway.
  const contains = wall => {
    const xs = wall.map(p => p[0]);
    const ys = wall.map(p => p[1]);
    const box = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return top.every(point => {
      const dx = Math.max(box[0] - point[0], point[0] - box[1], 0);
      const dy = Math.max(box[2] - point[1], point[1] - box[3], 0);
      return Math.hypot(dx, dy) < 0.01;
    });
  };
  assert.ok(shed.gables.some(contains),
    'no wall contains the high edge - the roof is open along its tall side');
});

test('a shed with no rise has no tall side to draw', () => {
  const flatish = roofOf(rect(12, 8), {
    kind: ROOF_KIND.SHED, pitch: 35, maxHeight: 0.0001,
  });
  for (const wall of flatish.gables) {
    const zs = wall.map(p => p[2]);
    assert.ok(Math.max(...zs) - Math.min(...zs) < 0.01,
      'a roof with no height produced a wall with height');
  }
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`roof.test.mjs: ${passed} passed`);
