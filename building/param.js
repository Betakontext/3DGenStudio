// Parameter shapes the building generator borrows from the VFX contract.
//
// Same arrangement as building/random.js: the useful part already exists, is
// already tested, and re-implementing it would mean a second thing to keep
// correct. This file is the SINGLE IMPORT SITE, so if these ever move to a
// shared root directory only this file changes.
//
// WHAT IS BORROWED AND WHY. A profile curve - "how far is the plan inset at
// each height" - is exactly the thing vfx/curve.js already models: keys at
// normalised t with per-key interpolation and tangents, an evaluator, and a
// tested editor to go with it (src/components/vfx/VfxCurveEditor.jsx). Writing
// a second curve type for buildings would also mean writing a second curve
// editor, which is 743 lines of canvas interaction nobody should write twice.
//
// THE ONE DIFFERENCE FROM VFX USAGE: a VFX curve is normalised and multiplied
// by a scale at the call site. A building profile stores METRES directly, and
// t runs from 0 at the ground to 1 at the top of the stack. That is why the
// editor is handed `scale: 1` and `unit: 'm'` - the numbers on the graph are
// the numbers in the building. Key values are not clamped to 0..1 in vfx/curve.js,
// and the editor's viewRange auto-fits including negatives, so an inset that
// goes outward partway up (a bulge, an overhang) draws correctly.

export {
  CURVE_INTERP,
  CURVE_WRAP,
  addCurveKey,
  constantCurve,
  createCurve,
  createCurveKey,
  curveExtent,
  cycleKeyInterp,
  describeCurve,
  evalCurve,
  linearCurve,
  moveCurveKey,
  removeCurveKey,
  setKeyTangent,
} from '../vfx/curve.js';

import { createCurve, curveExtent, evalCurve } from '../vfx/curve.js';

/**
 * The default profile curve: a smooth taper to 2m at the top.
 *
 * DELIBERATELY NOT FLAT. A flat-zero default makes the Curve profile identical
 * to Straight the moment it is selected, which reads as the setting being
 * broken - that is exactly how it was first reported. Arriving as a visible,
 * obviously-curved taper shows what the control does, and it differs from
 * Batter (which is a straight line to the same place) in the one way that
 * matters: the easing.
 */
export function defaultProfileCurve() {
  return createCurve([
    { t: 0, v: 0 },
    { t: 1, v: 2 },
  ]);
}

/** Whether a value is already a curve object rather than something else. */
export function isCurve(value) {
  return Boolean(value) && typeof value === 'object' && Array.isArray(value.keys);
}

/**
 * Coerce anything stored in a document into a usable curve.
 *
 * Accepts the `[[t, v], ...]` pair-array the first draft of the profile used, so
 * a document written before the editor existed still opens. createCurve sorts
 * and fills in defaults, so nothing downstream has to cope with unsorted keys.
 */
export function toCurve(value) {
  if (isCurve(value)) return createCurve(value.keys, value);
  if (Array.isArray(value)) {
    const keys = value
      .filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map(p => ({ t: p[0], v: p[1] }));
    if (keys.length) return createCurve(keys);
  }
  return defaultProfileCurve();
}

/** Sample a profile curve at normalised height t. Metres. */
export function sampleCurve(curve, t) {
  return evalCurve(toCurve(curve), t);
}

/**
 * True when a curve does nothing - every key at the same value.
 *
 * Used to tell an author that their Curve profile is behaving exactly like
 * Straight, which is otherwise invisible.
 */
export function isFlatCurve(curve, epsilon = 1e-6) {
  const { min, max } = curveExtent(toCurve(curve));
  return Math.abs(max - min) < epsilon && Math.abs(max) < epsilon;
}
