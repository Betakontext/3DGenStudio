// Deformation: build it orthogonal, then bend it.
//
// WHY A POST-PASS AND NOT A NON-ORTHOGONAL GRAMMAR. The grammar's whole value is
// that it snaps: an integer number of bays across a wall, a window at its
// natural size centred in its cell. All of that arithmetic is on straight lines,
// and a grammar that also had to place bays around a curve would either lose the
// snapping or grow a second, harder code path for every rule. Building square
// and warping afterwards keeps one grammar and gets the curve for free, and the
// warp cannot corrupt the snapping because it runs strictly after it.
//
// A WARP IS A FUNCTION AND ITS JACOBIAN. The function moves points; the Jacobian
// says how directions rotate at that point, which is what an INSTANCE needs - a
// window placed on a twisting wall has to turn with the wall, and a transform
// whose translation was warped but whose axes were not would leave every window
// facing the direction it would have faced on the undeformed building.
//
// THE JACOBIAN IS NUMERIC, ON PURPOSE. Every mode here has an analytic
// derivative and writing them out would be faster, but it would also be four
// more things to keep in step with four warp functions - and the day they drift
// the symptom is windows very slightly askew, which nobody will diagnose. One
// central difference serves every mode, costs six evaluations per instance, and
// is exact to well under a degree at the epsilon used here.
//
// WHAT IS ACTUALLY DEFORMED, and its one honest limitation: level corners, slot
// transforms and trim paths. A storey is a prism between two heights, so a
// twisted or leaning building is deformed PER STOREY - which is how twisted
// towers are really built, one rotated floor plate at a time. It also means SAG
// varies from corner to corner rather than continuously along a wall: the effect
// is a building that has settled and racked, which is exactly the Medieval and
// Fantasy look, but a single long wall will not bow in the middle without a
// vertex there to bow. Subdividing walls to fix that is a real change to the
// mesher and is not pretended at here.

import { triple32 } from './random.js';

/** The warps. `none` exists so the mode is always a legal value, never null. */
export const DEFORM_MODE = {
  NONE: 'none',
  /** Rotate about the vertical axis, more with height. Twisting towers. */
  TWIST: 'twist',
  /** Slide sideways with height, in a straight line. A leaning tower. */
  LEAN: 'lean',
  /** Slide sideways with height along a curve. Futurist shells, bowed walls. */
  BEND: 'bend',
  /** Seeded settling: floors droop and corners rack. Medieval, Fantasy. */
  SAG: 'sag',
};

/**
 * The wavelength of the sag field, in metres.
 *
 * NOT A FIXED NUMBER, and the fixed 7m it used to be is what made a large sag
 * unusable. Settling is a STRUCTURAL deformation: an old frame racks as a whole,
 * a floor droops across its span. A field whose wavelength is smaller than the
 * building is not settling, it is melting - and worse, its GRADIENT grows with
 * the amplitude, so at a few metres of sag the local frame stretched to 1.34x on
 * one window and squashed to 0.75x on its neighbour. The walls still looked
 * roughly like walls, because a four-corner quad averages the field over its
 * whole width; the windows each sampled it at a point and came out as a
 * different wrong shape each.
 *
 * Tying the wavelength to the building AND to the amplitude fixes both at once:
 * the field stays coherent across a wall, so every window on it agrees with the
 * wall and with its neighbours, and the ratio amplitude/wavelength - which IS
 * the deformation gradient - stays bounded however large the amount gets.
 */
function sagScale(amount, height) {
  return Math.max(height || 0, Math.abs(amount) * 4, 6);
}

/** The step used for the numeric Jacobian, in metres. */
const EPSILON = 1e-3;

const DEG = Math.PI / 180;

/** A deform descriptor as the IR stores it. Plain JSON, like everything else. */
export function makeDeform({
  mode = DEFORM_MODE.NONE, amount = 0, axis = 0, height = 0, seed = 0,
  centre = [0, 0],
} = {}) {
  return {
    mode,
    amount: Number(amount) || 0,
    axis: Number(axis) || 0,
    height: Math.max(Number(height) || 0, 0),
    seed: seed >>> 0,
    // Guarded because the descriptor arrives from the IR, which can have been
    // written by an older version or hand-edited - see ir.js on plain JSON.
    centre: Array.isArray(centre)
      ? [Number(centre[0]) || 0, Number(centre[1]) || 0]
      : [0, 0],
  };
}

/** Smooth, seeded value noise in 2D. Deterministic from the seed alone. */
function noise2(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  // Smoothstep, so the field is continuous in value AND slope - a linear blend
  // leaves creases along every lattice line, and a crease in a sag field reads
  // as a crisp fold in what is supposed to be slumped masonry.
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const at = (gx, gy) => {
    // Hashed from the coordinates rather than sampled from a table: a table
    // would have to be built, stored and kept the same size in every consumer.
    const h = triple32(((gx & 0xffff) << 16 ^ (gy & 0xffff)) ^ seed);
    return (h >>> 8) / 0xffffff;
  };
  const a = at(ix, iy);
  const b = at(ix + 1, iy);
  const c = at(ix, iy + 1);
  const d = at(ix + 1, iy + 1);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
}

/**
 * Build a warp from a descriptor.
 *
 * Always returns a usable pair, so a caller never branches on "is there a
 * deformation" - an absent one is the identity, and the identity costs one
 * object allocation and three assignments.
 */
export function makeWarp(descriptor) {
  const d = makeDeform(descriptor || {});
  const identity = {
    isIdentity: true,
    warp: (x, y, z) => [x, y, z],
    basis: (_x, _y, _z, ax, ay, az) => [ax, ay, az],
  };
  if (d.mode === DEFORM_MODE.NONE || !d.amount || !(d.height > 0)) return identity;

  const [cx, cy] = d.centre;
  const dirX = Math.cos(d.axis * DEG);
  const dirY = Math.sin(d.axis * DEG);
  const scale = sagScale(d.amount, d.height);

  const warp = (x, y, z) => {
    // t is 0 at the ground and 1 at the top. Held at 1 above rather than
    // extrapolated: a roof sitting a little above the declared height should
    // lean with the building, not shoot off it.
    const t = Math.min(Math.max(z / d.height, 0), 1);
    switch (d.mode) {
      case DEFORM_MODE.TWIST: {
        const angle = d.amount * DEG * t;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const px = x - cx;
        const py = y - cy;
        return [cx + px * cos - py * sin, cy + px * sin + py * cos, z];
      }
      case DEFORM_MODE.LEAN:
        return [x + dirX * d.amount * t, y + dirY * d.amount * t, z];
      case DEFORM_MODE.BEND: {
        // Quadratic, so the base stays vertical and the curvature builds - a
        // linear offset is a lean, which is already its own mode.
        const k = t * t;
        return [x + dirX * d.amount * k, y + dirY * d.amount * k, z];
      }
      case DEFORM_MODE.SAG: {
        const n = noise2(x / scale, y / scale, d.seed) - 0.5;
        const m = noise2(y / scale + 19.7, x / scale - 4.3, d.seed ^ 0x9e37) - 0.5;
        // Settling ACCUMULATES with height: the top of an old timber frame is
        // further out of true than its sill, because everything below it has
        // moved too. Scaling by t is what makes it read as age rather than as a
        // bumpy ground floor.
        return [
          x + m * d.amount * t,
          y + n * d.amount * t,
          z - Math.abs(n) * d.amount * t * 0.6,
        ];
      }
      default:
        return [x, y, z];
    }
  };

  // Central differences: (f(p + h) - f(p - h)) / 2h, one column per axis.
  const basis = (x, y, z, ax, ay, az) => {
    const col = (dx, dy, dz) => {
      const p = warp(x + dx, y + dy, z + dz);
      const m = warp(x - dx, y - dy, z - dz);
      return [(p[0] - m[0]) / (2 * EPSILON), (p[1] - m[1]) / (2 * EPSILON),
        (p[2] - m[2]) / (2 * EPSILON)];
    };
    const jx = col(EPSILON, 0, 0);
    const jy = col(0, EPSILON, 0);
    const jz = col(0, 0, EPSILON);
    return [
      jx[0] * ax + jy[0] * ay + jz[0] * az,
      jx[1] * ax + jy[1] * ay + jz[1] * az,
      jx[2] * ax + jy[2] * ay + jz[2] * az,
    ];
  };

  return { isIdentity: false, warp, basis };
}

/**
 * Warp one slot transform.
 *
 * THE FULL JACOBIAN, SHEAR INCLUDED - and the first version of this function got
 * that wrong in a way worth recording, because the reasoning that produced the
 * bug is superficially convincing.
 *
 * The argument was: a warp shears, a real window does not, so re-orthonormalise
 * the warped axes and keep only the rotation. That sounds right and is wrong,
 * because it mistakes what these warps DO. A LEAN is not a rigid tilt of the
 * building - the base stays put and the top slides, which is a SHEAR:
 *
 *     [1 0 kx]
 *     [0 1 ky]      k = amount / height
 *     [0 0 1 ]
 *
 * Under it a wall's vertical edges tilt while the wall stays planar, so an
 * opening in that wall genuinely becomes a PARALLELOGRAM. There is no rotation
 * that produces a parallelogram, so squaring the axes up threw the lean away
 * entirely on any wall running along it, and the building leaned while every
 * window stood bolt upright inside it.
 *
 * Worse, it failed ASYMMETRICALLY: on a wall across the lean the shear moves the
 * wall out of its own plane, so orthonormalising kept the tilt there. Half the
 * windows followed and half did not, which reads as a rendering glitch rather
 * than as a modelling decision.
 *
 * So the instance takes the whole Jacobian and shears with its wall. A style
 * pack's window mesh is skewed by a leaning building exactly as the wall around
 * it is, which is what a sheared building means.
 *
 * The transform is the 16-number column-major matrix makeSlot stores: columns
 * are along-wall, up, outward, translation.
 */
export function warpTransform(warp, transform) {
  if (warp.isIdentity) return transform;
  const x = transform[12];
  const y = transform[13];
  const z = transform[14];
  const [wx, wy, wz] = warp.warp(x, y, z);

  const along = warp.basis(x, y, z, transform[0], transform[1], transform[2]);
  const up = warp.basis(x, y, z, transform[4], transform[5], transform[6]);
  const normal = warp.basis(x, y, z, transform[8], transform[9], transform[10]);

  // A COLLAPSED OR MIRRORED BASIS IS THE ONE THING TO REFUSE, and POSITIVE is
  // the test, not merely non-zero. A determinant of zero flattens the instance
  // to nothing; a NEGATIVE one turns it inside out, so its faces point into the
  // wall and it lights as a black hole. Both are reachable only by a warp far
  // past anything architectural - forty metres of sag on a ten metre building -
  // and leaving such an instance unwarped is a much better failure than a
  // building whose windows vanish or invert.
  const determinant = along[0] * (up[1] * normal[2] - up[2] * normal[1])
    - along[1] * (up[0] * normal[2] - up[2] * normal[0])
    + along[2] * (up[0] * normal[1] - up[1] * normal[0]);
  if (!Number.isFinite(determinant) || determinant < 1e-9) {
    return [...transform.slice(0, 12), wx, wy, wz, 1];
  }

  return [
    along[0], along[1], along[2], 0,
    up[0], up[1], up[2], 0,
    normal[0], normal[1], normal[2], 0,
    wx, wy, wz, 1,
  ];
}

/** Warp a flat [x, y, z, ...] polyline in place-free fashion. */
export function warpPath(warp, path) {
  if (warp.isIdentity) return path;
  const out = [];
  for (let i = 0; i + 2 < path.length; i += 3) {
    out.push(...warp.warp(path[i], path[i + 1], path[i + 2]));
  }
  return out;
}

/**
 * Nudge one slot off its exact place.
 *
 * WHY THIS IS NOT A WARP. Every mode above is a coherent field: a lean shears
 * the whole building, a sag droops it, and the walls, the roof and the openings
 * all move together because they are all sampling one function of position. That
 * is exactly what you want for a building that SETTLED, and exactly what you do
 * not want for a building that was BUILT BY HAND - where the point is that no
 * two windows agree, and the wall they sit in is dead straight.
 *
 * So this is per-element and deliberately outside the warp: each slot gets its
 * own small offset and its own small turn, hashed from its own identity. The
 * wall does not move. Nothing else sees it.
 *
 * MOVED IN ITS OWN FRAME, not in world axes: sliding a window along the wall and
 * rocking it in its opening is a thing carpentry does, and pushing it out along
 * the wall NORMAL is a thing carpentry does not. The normal offset is a third of
 * the others for that reason - enough to catch the light, not enough to leave
 * the reveal.
 *
 * @param {Array<number>} transform column-major 4x4
 * @param {number} amount 0..1
 * @param {(index: number) => number} draw a seeded draw in [0, 1) by index
 */
export function jitterTransform(transform, amount, draw) {
  const a = Math.max(0, Math.min(1, Number(amount) || 0));
  if (a <= 0) return transform;

  const signed = index => draw(index) * 2 - 1;
  const along = [transform[0], transform[1], transform[2]];
  const up = [transform[4], transform[5], transform[6]];
  const normal = [transform[8], transform[9], transform[10]];

  // 90mm at full amount, which is about a hand's width - past that an opening
  // stops reading as hand-set and starts reading as broken.
  const shift = 0.09 * a;
  const dx = signed(0) * shift;
  const dy = signed(1) * shift;
  const dz = signed(2) * shift / 3;

  // Rocked about the wall normal - the axis a frame actually racks around.
  // 2.5 degrees at full amount.
  const angle = signed(3) * 2.5 * a * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const turnedAlong = [
    along[0] * c + up[0] * s,
    along[1] * c + up[1] * s,
    along[2] * c + up[2] * s,
  ];
  const turnedUp = [
    up[0] * c - along[0] * s,
    up[1] * c - along[1] * s,
    up[2] * c - along[2] * s,
  ];

  return [
    turnedAlong[0], turnedAlong[1], turnedAlong[2], 0,
    turnedUp[0], turnedUp[1], turnedUp[2], 0,
    normal[0], normal[1], normal[2], 0,
    transform[12] + along[0] * dx + up[0] * dy + normal[0] * dz,
    transform[13] + along[1] * dx + up[1] * dy + normal[1] * dz,
    transform[14] + along[2] * dx + up[2] * dy + normal[2] * dz,
    1,
  ];
}

/**
 * Carry a direction through the warp, at a point.
 *
 * `warp.basis` is the Jacobian applied to a vector - the same machinery that
 * keeps a window lying in a leaning wall - and an OPEN trim run needs it for
 * exactly the same reason: its section faces a stored direction, and a lean that
 * shears the wall must shear the direction a timber's face points with it, or
 * the frame stands proud of a wall that has moved out from under it.
 */
export function warpNormalAt(warp, normal, x, y, z) {
  if (warp.isIdentity || normal.length !== 3) return normal;
  const out = warp.basis(x, y, z, normal[0], normal[1], normal[2]);
  const length = Math.hypot(out[0], out[1], out[2]);
  if (!(length > 1e-9)) return normal;
  return [out[0] / length, out[1] / length, out[2] / length];
}
