// node building/deform.test.mjs
//
// The two things a warp has to hold up: the ground does not move, and an
// instance turns with the wall it is on. The second is what the Jacobian is for
// and is the one that fails silently if it is wrong.

import assert from 'node:assert/strict';
import {
  DEFORM_MODE, makeDeform, makeWarp, warpPath, warpTransform,
} from './deform.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const close = (got, want, eps, what) => assert.ok(
  got.every((v, i) => near(v, want[i], eps)),
  `${what}: got [${got.map(n => n.toFixed(4))}], expected [${want}]`,
);

/** The slot transform makeSlot stores: along-wall, up, outward, translation. */
const slotAt = (x, y, z) => [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, x, y, z, 1];
const axesOf = t => ({
  along: t.slice(0, 3), up: t.slice(4, 7), normal: t.slice(8, 11), pos: t.slice(12, 15),
});

// --- the identity -----------------------------------------------------------

test('no mode, no amount and no height all give the identity', () => {
  for (const d of [
    null, undefined, {},
    { mode: DEFORM_MODE.NONE, amount: 10, height: 10 },
    { mode: DEFORM_MODE.TWIST, amount: 0, height: 10 },
    { mode: DEFORM_MODE.TWIST, amount: 30, height: 0 },
  ]) {
    assert.equal(makeWarp(d).isIdentity, true, JSON.stringify(d));
  }
  // And it really is the identity, not merely labelled one.
  assert.deepEqual(makeWarp(null).warp(3, 4, 5), [3, 4, 5]);
});

test('a descriptor is plain, finite JSON whatever it is handed', () => {
  const d = makeDeform({ amount: 'x', axis: NaN, height: -5, seed: -1, centre: 'nope' });
  assert.deepEqual(d, {
    mode: DEFORM_MODE.NONE, amount: 0, axis: 0, height: 0, seed: 0xffffffff, centre: [0, 0],
  });
  assert.equal(JSON.stringify(makeDeform({})).includes('null'), false);
});

// --- the ground stays put ---------------------------------------------------

test('every warp leaves z = 0 exactly where it was', () => {
  // A building that slides off its own footprint when you nudge a slider is the
  // single most alarming thing this feature could do.
  for (const mode of [DEFORM_MODE.TWIST, DEFORM_MODE.LEAN, DEFORM_MODE.BEND, DEFORM_MODE.SAG]) {
    const warp = makeWarp({ mode, amount: 40, height: 10, seed: 3 });
    close(warp.warp(7, -2, 0), [7, -2, 0], 1e-9, mode);
  }
});

test('t is clamped, so a roof above the declared height leans rather than flies', () => {
  const warp = makeWarp({ mode: DEFORM_MODE.LEAN, amount: 4, height: 10 });
  close(warp.warp(0, 0, 10), [4, 0, 10], 1e-9, 'at the top');
  close(warp.warp(0, 0, 25), [4, 0, 25], 1e-9, 'well above the top');
});

// --- what each mode does ----------------------------------------------------

test('twist turns about the centre, by the full amount at the top', () => {
  const warp = makeWarp({ mode: DEFORM_MODE.TWIST, amount: 90, height: 10, centre: [0, 0] });
  close(warp.warp(5, 0, 10), [0, 5, 10], 1e-9, 'top');
  close(warp.warp(5, 0, 5), [5 * Math.SQRT1_2, 5 * Math.SQRT1_2, 5], 1e-9, 'halfway');
  // The centre of rotation itself never moves.
  close(warp.warp(0, 0, 10), [0, 0, 10], 1e-9, 'the axis');
});

test('lean is linear in height and bend is not', () => {
  const lean = makeWarp({ mode: DEFORM_MODE.LEAN, amount: 6, height: 10 });
  const bend = makeWarp({ mode: DEFORM_MODE.BEND, amount: 6, height: 10 });
  assert.ok(near(lean.warp(0, 0, 5)[0], 3), 'lean should be half way at half height');
  // Quadratic: a quarter of the way at half height, so the base stays upright.
  assert.ok(near(bend.warp(0, 0, 5)[0], 1.5), 'bend should be a quarter at half height');
  assert.ok(near(lean.warp(0, 0, 10)[0], bend.warp(0, 0, 10)[0]), 'they should agree at the top');
});

test('direction points the lean where it was asked to go', () => {
  const north = makeWarp({ mode: DEFORM_MODE.LEAN, amount: 3, height: 10, axis: 90 });
  close(north.warp(0, 0, 10), [0, 3, 10], 1e-9, 'north');
});

test('sag is seeded, repeatable, and different per seed', () => {
  const a = makeWarp({ mode: DEFORM_MODE.SAG, amount: 1, height: 10, seed: 42 });
  const b = makeWarp({ mode: DEFORM_MODE.SAG, amount: 1, height: 10, seed: 42 });
  const c = makeWarp({ mode: DEFORM_MODE.SAG, amount: 1, height: 10, seed: 43 });
  assert.deepEqual(a.warp(4, 5, 9), b.warp(4, 5, 9));
  assert.notDeepEqual(a.warp(4, 5, 9), c.warp(4, 5, 9));
});

test('sag only ever settles DOWNWARD', () => {
  // Masonry does not rise. A field that lifted parts of the building would read
  // as inflation rather than as age.
  const warp = makeWarp({ mode: DEFORM_MODE.SAG, amount: 1.5, height: 12, seed: 9 });
  for (let x = -20; x <= 20; x += 3.1) {
    for (let y = -20; y <= 20; y += 2.7) {
      assert.ok(warp.warp(x, y, 12)[2] <= 12 + 1e-9, `rose at ${x},${y}`);
    }
  }
});

test('sag is continuous - no cliff between lattice cells', () => {
  // A linear blend leaves a crease along every lattice line, which reads as a
  // crisp fold in what is meant to be slumped masonry.
  const warp = makeWarp({ mode: DEFORM_MODE.SAG, amount: 1, height: 10, seed: 5 });
  let worst = 0;
  for (let x = 0; x < 30; x += 0.05) {
    const a = warp.warp(x, 3, 10);
    const b = warp.warp(x + 0.05, 3, 10);
    worst = Math.max(worst, Math.abs(a[2] - b[2]));
  }
  assert.ok(worst < 0.02, `a ${worst.toFixed(3)}m step over 5cm is a crease, not a sag`);
});

// --- the Jacobian, which is the part that fails quietly ---------------------

test('a twisted wall turns its windows with it', () => {
  // The failure this guards: translations warped, axes not, so every window on a
  // twisting tower faces the direction it would have faced on a straight one.
  const warp = makeWarp({ mode: DEFORM_MODE.TWIST, amount: 90, height: 10, centre: [0, 0] });
  const out = axesOf(warpTransform(warp, slotAt(5, 0, 10)));
  close(out.pos, [0, 5, 10], 1e-6, 'position');
  // The outward normal started at (0,-1,0) and should have turned a full 90.
  close(out.normal, [1, 0, 0], 1e-3, 'normal');
  close(out.along, [0, 1, 0], 1e-3, 'along the wall');
  close(out.up, [0, 0, 1], 1e-3, 'up');
});

test('the warped axes stay orthonormal, so no instance is skewed', () => {
  // A window is a rigid object hung on a wall that moved; it does not shear.
  const warp = makeWarp({ mode: DEFORM_MODE.SAG, amount: 1.2, height: 10, seed: 11 });
  for (const [x, y, z] of [[2, 3, 7], [11, 1, 9], [-4, 6, 3]]) {
    const { along, up, normal } = axesOf(warpTransform(warp, slotAt(x, y, z)));
    for (const [name, v] of [['along', along], ['up', up], ['normal', normal]]) {
      assert.ok(near(Math.hypot(...v), 1, 1e-6), `${name} is not unit at ${x},${y},${z}`);
    }
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    assert.ok(near(dot(along, up), 0, 1e-6), 'along and up are not perpendicular');
    assert.ok(near(dot(along, normal), 0, 1e-6), 'along and normal are not perpendicular');
    assert.ok(near(dot(up, normal), 0, 1e-6), 'up and normal are not perpendicular');
  }
});

test('a lean moves windows without turning them', () => {
  // A pure translation has an identity Jacobian, so nothing should rotate - and
  // a numeric derivative that drifted would show up here first.
  const warp = makeWarp({ mode: DEFORM_MODE.LEAN, amount: 5, height: 10 });
  const out = axesOf(warpTransform(warp, slotAt(0, 0, 10)));
  close(out.pos, [5, 0, 10], 1e-6, 'position');
  close(out.normal, [0, -1, 0], 1e-6, 'normal');
});

test('the identity warp hands the transform back untouched', () => {
  const t = slotAt(1, 2, 3);
  assert.equal(warpTransform(makeWarp(null), t), t, 'it was copied rather than passed through');
});

test('a path is warped point by point, and left alone by the identity', () => {
  const warp = makeWarp({ mode: DEFORM_MODE.LEAN, amount: 2, height: 10 });
  assert.deepEqual(warpPath(warp, [0, 0, 0, 0, 0, 10]), [0, 0, 0, 2, 0, 10]);
  const path = [1, 2, 3];
  assert.equal(warpPath(makeWarp(null), path), path);
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`deform.test.mjs: ${passed} passed`);
