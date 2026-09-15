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
});

test('a twisted wall SHEARS, and its windows shear with it', () => {
  // A twist is a rotation that varies with height, so a wall's vertical edges
  // spiral rather than staying vertical - and a window built into that wall is
  // a parallelogram, not a rectangle. Measured at mid-height, away from the
  // clamp at the top where the rate is a half-step.
  const warp = makeWarp({ mode: DEFORM_MODE.TWIST, amount: 90, height: 10, centre: [0, 0] });
  const { up } = axesOf(warpTransform(warp, slotAt(5, 0, 5)));
  // Tangential speed at radius 5 with 90 degrees over 10m.
  const expected = 5 * ((90 * Math.PI) / 180) / 10;
  assert.ok(Math.abs(Math.hypot(up[0], up[1]) - expected) < 1e-3,
    `up leans ${Math.hypot(up[0], up[1]).toFixed(4)}, expected ${expected.toFixed(4)}`);
  assert.ok(near(up[2], 1, 1e-6), 'up should still rise one metre per metre');
});

test('THE LEAN BUG: windows tilt with the wall on EVERY orientation', () => {
  // Reported from a screenshot: the walls leaned and the windows stood bolt
  // upright inside them. The cause was re-orthonormalising the warped axes,
  // which cannot represent a parallelogram - so a wall running ALONG the lean
  // lost the tilt completely while a wall across it kept it, and half the
  // windows followed while half did not.
  const amount = 5;
  const height = 10;
  const warp = makeWarp({ mode: DEFORM_MODE.LEAN, amount, height, axis: 0 });
  const expected = amount / height;

  for (const [name, transform] of [
    // along the lean: the shear acts INSIDE the wall plane.
    ['east-west wall', [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 3, 0, 5, 1]],
    // across it: the shear moves the wall out of its own plane.
    ['north-south wall', [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 3, 0, 5, 1]],
  ]) {
    const { up } = axesOf(warpTransform(warp, transform));
    assert.ok(Math.abs(up[0] - expected) < 1e-6,
      `${name}: up leans ${up[0].toFixed(4)} east, expected ${expected}`);
    assert.ok(near(up[2], 1, 1e-6), `${name}: up no longer rises`);
  }
});

test('the warped basis stays right-handed and non-degenerate', () => {
  // Orthonormal it is NOT - see warpTransform - but a collapsed or mirrored
  // basis would make an instance invisible or inside-out, which is the one
  // failure worth refusing.
  const det = ([a, u, n]) => a[0] * (u[1] * n[2] - u[2] * n[1])
    - a[1] * (u[0] * n[2] - u[2] * n[0])
    + a[2] * (u[0] * n[1] - u[1] * n[0]);

  // Amounts that MEAN something per mode: 40 is degrees for a twist and metres
  // for everything else, and forty metres of sag on a ten metre building is not
  // a building, it is a guard test - which the case below covers instead.
  for (const [mode, amount] of [
    [DEFORM_MODE.TWIST, 40], [DEFORM_MODE.LEAN, 4],
    [DEFORM_MODE.BEND, 4], [DEFORM_MODE.SAG, 0.5],
  ]) {
    const warp = makeWarp({ mode, amount, height: 10, seed: 11 });
    for (const [x, y, z] of [[2, 3, 7], [11, 1, 9], [-4, 6, 3]]) {
      const { along, up, normal } = axesOf(warpTransform(warp, slotAt(x, y, z)));
      const d = det([along, up, normal]);
      assert.ok(d > 1e-6, `${mode} at ${x},${y},${z} has determinant ${d.toFixed(6)}`);
      for (const [label, v] of [['along', along], ['up', up], ['normal', normal]]) {
        assert.ok(Number.isFinite(Math.hypot(...v)) && Math.hypot(...v) > 1e-6,
          `${mode}: ${label} collapsed`);
      }
    }
  }
});

test('SAG STAYS COHERENT ACROSS A WALL, however large the amount', () => {
  // The reported bug: with a few metres of sag every window came out a
  // different wrong shape - one squashed to 0.75 of its width, its neighbour
  // stretched to 1.34. The walls looked roughly right because a four-corner
  // quad averages the field over its whole width; each window sampled it at a
  // point.
  //
  // The cause was a FIXED 7m wavelength. A field finer than the building is not
  // settling, and its gradient - which is amplitude over wavelength, and IS the
  // distortion - grew without limit as the amount rose. Tying the wavelength to
  // the building and to the amplitude bounds it by construction.
  const slot = (x, y, z) => [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, x, y, z, 1];
  for (const amount of [1, 6, 20, 80]) {
    const warp = makeWarp({ mode: DEFORM_MODE.SAG, amount, height: 10, seed: 12345 });
    let low = Infinity;
    let high = 0;
    // Along one wall, at the spacing windows actually sit at.
    for (let x = 0; x <= 12; x += 1.2) {
      const { along } = axesOf(warpTransform(warp, slot(x, 0, 7)));
      const length = Math.hypot(...along);
      low = Math.min(low, length);
      high = Math.max(high, length);
    }
    assert.ok(high / low < 1.25,
      `at ${amount}m of sag, windows on one wall vary ${(high / low).toFixed(2)}x in width`);
    assert.ok(low > 0.5, `at ${amount}m of sag a window collapsed to ${low.toFixed(2)}`);
  }
});

test('sag still settles by the amount it was asked for', () => {
  // The coherence fix changes the field's WAVELENGTH, not its amplitude. A
  // building that stopped sagging would be a worse bug than one that sagged
  // messily.
  for (const amount of [0.5, 3]) {
    const warp = makeWarp({ mode: DEFORM_MODE.SAG, amount, height: 10, seed: 7 });
    let drop = 0;
    for (let x = 0; x <= 30; x += 1.3) {
      for (let y = 0; y <= 30; y += 1.7) drop = Math.max(drop, 10 - warp.warp(x, y, 10)[2]);
    }
    assert.ok(drop > amount * 0.05, `${amount}m of sag dropped only ${drop.toFixed(3)}m`);
    assert.ok(drop <= amount * 0.31, `${amount}m of sag dropped ${drop.toFixed(3)}m, too much`);
  }
});

test('a warp that collapses the basis leaves the instance where it was', () => {
  // Not reachable from any shipped mode, but a NaN basis silently deletes the
  // whole InstancedMesh rather than one window, so it is guarded rather than
  // trusted.
  const broken = {
    isIdentity: false,
    warp: (x, y, z) => [x, y, z],
    basis: () => [0, 0, 0],
  };
  const out = warpTransform(broken, slotAt(1, 2, 3));
  close(out.slice(0, 3), [1, 0, 0], 1e-9, 'along was mangled');
  close(out.slice(12, 15), [1, 2, 3], 1e-9, 'position');
});

test('a lean carries its windows sideways as well as tilting them', () => {
  // The position half of the fix, which was never wrong: a window 10m up on a
  // 5m lean over 10m moves the full 5m. The NORMAL is unchanged here because a
  // shear in z leaves horizontal directions alone; it is `up` that tilts, which
  // the test above measures.
  const warp = makeWarp({ mode: DEFORM_MODE.LEAN, amount: 5, height: 10 });
  const out = axesOf(warpTransform(warp, slotAt(0, 0, 10)));
  close(out.pos, [5, 0, 10], 1e-6, 'position');
  close(out.normal, [0, -1, 0], 1e-6, 'normal');
  close(out.along, [1, 0, 0], 1e-6, 'along the wall');
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
