// How many triangles a slot model is allowed, given how many times it is drawn.
//
// THE COST OF A SLOT MODEL IS NOT ITS OWN SIZE. A slot is instanced, so binding
// one model costs `triangles x instances`, and the second number is decided by
// the grammar rather than by whoever picked the model. A 12,000-triangle fin is
// a perfectly ordinary generated mesh; the same fin on a 42-storey tower is
// 1,808 instances and 21.7 MILLION triangles, and instancing does not help with
// that at all - it saves draw calls, and this is not a draw-call problem. The
// viewport crawled and nothing anywhere said why.
//
// So the budget is on the TOTAL, and the per-model target falls out of it. A
// cottage with forty windows leaves a 30,000-triangle window untouched; a tower
// with eighteen hundred fins gets them at 600 triangles each, which on a blade
// that is two metres of a hundred-and-fifty-metre building is a difference
// nobody can see. Measured on the fin that prompted this: 12,000 -> 600 costs
// 1% geometric error and 8 ms.
//
// THE PREVIEW AND THE EXPORTER SHARE IT, because they share this loader, and
// because a building that is one thing on screen and another in the file is the
// failure this whole module set is arranged to avoid.

import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * Total triangles all slot models together may draw.
 *
 * Chosen against the machine this has to stay interactive on rather than from
 * first principles: a little over a million triangles of instanced detail sits
 * comfortably beside the walls, roof and trim, which on a big building are
 * themselves a few hundred thousand.
 */
export const SLOT_TRIANGLE_BUDGET = 1_200_000

/**
 * Never simplify below this, whatever the instance count says.
 *
 * Past a point a simplifier stops removing detail and starts removing the
 * object: a window at 20 triangles is a blob, and a blob in every opening looks
 * far more broken than a slow building does. Better to overrun the budget than
 * to ship that - and the simplifier has its own floor anyway, set by the
 * topology it cannot collapse without tearing.
 */
export const MIN_SLOT_TRIANGLES = 150

/**
 * How many slots draw each (reference list, variant) pair.
 *
 * Keyed exactly as `buildSlotInstances` groups, so the count here is the count
 * of instances that will actually share one geometry.
 *
 * @param {object} ir
 * @returns {Map<string, number>} `${meshSlot}#${variant}` -> instances
 */
export function slotUsage(ir) {
  const out = new Map()
  for (const slot of ir?.slots || []) {
    if (!slot?.meshSlot) continue
    const key = `${slot.meshSlot}#${slot.variant | 0}`
    out.set(key, (out.get(key) || 0) + 1)
  }
  return out
}

/**
 * The triangle allowance for one model drawn `instances` times.
 *
 * `Infinity` when nothing draws it, which reads as "leave it alone" - a model
 * loaded for a slot the grammar did not place costs nothing to keep whole.
 */
export function targetTriangles(instances, budget = SLOT_TRIANGLE_BUDGET) {
  if (!(instances > 0)) return Infinity
  return Math.max(MIN_SLOT_TRIANGLES, Math.floor(budget / instances))
}

/** Triangles in a geometry, indexed or not. */
export function triangleCount(geometry) {
  const count = geometry?.index?.count ?? geometry?.getAttribute?.('position')?.count ?? 0
  return Math.floor(count / 3)
}

let simplifier = null

/**
 * The wasm simplifier, loaded once.
 *
 * Imported dynamically so that a build which never binds a slot model never
 * pays for it, and so that a failure to load is a slow building rather than a
 * blank page.
 */
async function loadSimplifier() {
  if (simplifier !== null) return simplifier
  try {
    const { MeshoptSimplifier } = await import('meshoptimizer/simplifier')
    await MeshoptSimplifier.ready
    simplifier = MeshoptSimplifier.supported ? MeshoptSimplifier : false
  } catch (error) {
    console.warn('Building slot meshes: no simplifier, models are drawn whole.', error)
    simplifier = false
  }
  return simplifier
}

/**
 * Reduce a geometry to at most `target` triangles, or return it unchanged.
 *
 * WELDED FIRST, because `normalise` hands over a non-indexed geometry - every
 * triangle with its own three vertices - and a simplifier cannot collapse an
 * edge whose two halves it has no way to know are the same edge. Without the
 * weld this returns the geometry at full size and reports success.
 *
 * Returns the SAME OBJECT when there is nothing to do, so a caller can tell
 * whether it owns a new geometry to dispose.
 */
export async function simplifyToBudget(geometry, target) {
  if (!geometry || !Number.isFinite(target)) return geometry
  if (triangleCount(geometry) <= target) return geometry

  const meshopt = await loadSimplifier()
  if (!meshopt) return geometry

  let welded = null
  try {
    welded = geometry.index ? geometry : mergeVertices(geometry)
    const index = welded.index
    const position = welded.getAttribute('position')
    if (!index || !position) return geometry
    if (triangleCount(welded) <= target) return finish(geometry, welded)

    // LockBorder: an open edge is the model's silhouette against the wall, and
    // letting it migrate leaves a gap around the opening.
    const [indices, error] = meshopt.simplify(
      new Uint32Array(index.array),
      new Float32Array(position.array),
      3,
      target * 3,
      1,
      ['LockBorder'],
    )
    if (!indices?.length) return finish(geometry, welded)

    // COMPACTED, and this is not an optimisation. Simplifying only rewrites the
    // INDEX - the vertex buffer still holds every one of the original vertices,
    // most of them now referenced by nothing. An InstancedMesh does not care,
    // because it uploads the geometry once; the exporter clones it PER INSTANCE
    // and merges, so 1,808 fins carrying 8,824 dead vertices each is sixteen
    // million vertices and half a gigabyte, and the export simply stopped.
    const out = compact(welded, indices, error, triangleCount(geometry))
    if (welded !== geometry) welded.dispose()
    return out
  } catch (err) {
    console.warn('Building slot meshes: simplification failed, drawing the model whole.', err)
    if (welded && welded !== geometry) welded.dispose()
    return geometry
  }
}

/**
 * A new geometry holding only the vertices the indices still reach.
 *
 * meshopt's remap gives each surviving vertex its new slot and 0xffffffff to the
 * rest, so one pass over each attribute is the whole job.
 */
function compact(source, indices, error, from) {
  // compactMesh REWRITES `indices` IN PLACE with the new numbering, as well as
  // returning the old -> new remap for the attributes. Applying that remap to
  // the indices as well makes every one of them `remap[remap[i]]`, which points
  // at a real vertex in range - so nothing throws, the triangle and vertex
  // counts are exactly right, and the model renders as shrapnel or as nothing
  // at all. Only a check on the SHAPE catches it.
  const [remap, unique] = simplifier.compactMesh(indices)
  const out = new THREE.BufferGeometry()
  for (const name of Object.keys(source.attributes)) {
    const attribute = source.getAttribute(name)
    const size = attribute.itemSize
    const packed = new Float32Array(unique * size)
    for (let i = 0; i < remap.length; i++) {
      const to = remap[i]
      if (to === 0xffffffff) continue
      for (let k = 0; k < size; k++) packed[to * size + k] = attribute.array[i * size + k]
    }
    out.setAttribute(name, new THREE.BufferAttribute(packed, size))
  }
  out.setIndex(new THREE.BufferAttribute(indices, 1))
  out.computeBoundingBox()
  out.computeBoundingSphere()
  out.userData = { simplifiedFrom: from, simplifyError: error }
  return out
}

/** Keep the welded geometry only if it is genuinely a different object. */
function finish(original, welded) {
  if (welded === original) return original
  welded.dispose()
  return original
}
