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

/** How far apart the noise lattice points are, in metres. */
const SAG_SCALE = 7;

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
        const n = noise2(x / SAG_SCALE, y / SAG_SCALE, d.seed) - 0.5;
        const m = noise2(y / SAG_SCALE + 19.7, x / SAG_SCALE - 4.3, d.seed ^ 0x9e37) - 0.5;
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

const len = v => Math.hypot(v[0], v[1], v[2]);
const scale = (v, s) => [v[0] * s, v[1] * s, v[2] * s];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Warp one slot transform.
 *
 * ROTATION ONLY, NOT THE FULL JACOBIAN. A warp generally shears and stretches,
 * and feeding that straight into an instance matrix would skew the window mesh
 * along with the wall. A real window does not shear; it is a rigid object hung
 * on a wall that has moved. So the warped axes are re-orthonormalised - the
 * outward normal is trusted, the along-wall direction is made perpendicular to
 * it, and up is their cross product.
 *
 * The transform is the 16-number column-major matrix makeSlot stores:
 * columns are along-wall, up, outward, translation.
 */
export function warpTransform(warp, transform) {
  if (warp.isIdentity) return transform;
  const x = transform[12];
  const y = transform[13];
  const z = transform[14];
  const [wx, wy, wz] = warp.warp(x, y, z);

  let normal = warp.basis(x, y, z, transform[8], transform[9], transform[10]);
  let along = warp.basis(x, y, z, transform[0], transform[1], transform[2]);

  const nLen = len(normal);
  const aLen = len(along);
  // A degenerate Jacobian - possible only if a warp collapses a direction
  // entirely - leaves the instance where it was rather than producing NaNs that
  // would silently delete the whole InstancedMesh.
  if (!(nLen > 1e-9) || !(aLen > 1e-9)) {
    return [...transform.slice(0, 12), wx, wy, wz, 1];
  }
  normal = scale(normal, 1 / nLen);
  along = scale(along, 1 / aLen);

  const up = cross(normal, along);
  const uLen = len(up);
  if (!(uLen > 1e-9)) return [...transform.slice(0, 12), wx, wy, wz, 1];
  const upUnit = scale(up, 1 / uLen);
  const alongUnit = cross(upUnit, normal);

  return [
    alongUnit[0], alongUnit[1], alongUnit[2], 0,
    upUnit[0], upUnit[1], upUnit[2], 0,
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
