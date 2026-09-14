// Compiles the document, and only when it would produce something different.
//
// THE SIGNATURE IS THE WHOLE POINT. buildingSignature() omits `layout` and
// `savedAt` (invariant 2 in building/doc.js), so dragging a node on the board
// does not rebuild a forty-storey building. Memoising on the document object
// instead would recompile on every render, and memoising on a deep compare would
// cost about what compiling costs.
//
// COMPILING IS SYNCHRONOUS AND THAT IS DELIBERATE. The whole pipeline is polygon
// arithmetic - a few hundred Clipper calls for a large building - and measures in
// single-digit milliseconds, which is well inside a frame. Pushing it to a worker
// would buy nothing and would cost the guarantee that the preview matches the
// document that is on screen right now. If a later phase makes it expensive
// enough to matter, the place to fix it is here and the signature is already the
// cache key.

import { useMemo } from 'react'
import { compileBuilding } from '../../building/compile.js'
import { buildingSignature } from '../../building/doc.js'
import { SEVERITY } from '../../building/diagnostics.js'

/**
 * @param {object} doc a building document
 * @returns {{ir: object, diagnostics: Array, ok: boolean, errors: Array, warnings: Array, signature: string}}
 */
export default function useBuildingCompile(doc) {
  const signature = useMemo(() => buildingSignature(doc), [doc])

  return useMemo(() => {
    const result = compileBuilding(doc)
    return {
      ...result,
      errors: result.diagnostics.filter(d => d.severity === SEVERITY.ERROR),
      warnings: result.diagnostics.filter(d => d.severity === SEVERITY.WARN),
      infos: result.diagnostics.filter(d => d.severity === SEVERITY.INFO),
      signature,
    }
    // `doc` is deliberately absent: the signature is what decides whether the
    // result would differ, and depending on the object as well would recompile
    // on every render for no change in output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
}
