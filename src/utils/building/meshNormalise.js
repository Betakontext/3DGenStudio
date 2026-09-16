// Turning a loaded model into the unit mesh every opening expects.
//
// SPLIT OUT OF slotMeshes.js so it can be TESTED. That file reaches transport -
// resolveAssetImageUrl, and through it the app's config - which needs Vite's
// import.meta.env and therefore cannot be imported by a plain `node` test. This
// half is pure three.js and is where every rule worth asserting lives.

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * Every mesh in a glTF scene, merged and normalised into a unit box.
 *
 * MERGED, because an InstancedMesh draws ONE geometry: a window model with a
 * frame, a sill and four panes as separate meshes would otherwise arrive as its
 * frame alone.
 *
 * THE MODEL KEEPS ITS OWN MATERIAL, which the first version of this threw away -
 * an imported window arrived untextured and there was no way to tell that from a
 * model that simply had no texture. A GLB carries its material and its maps, and
 * discarding them is discarding most of what makes it worth importing.
 *
 * ONE MATERIAL, though, and that is a real limit rather than a shortcut: an
 * InstancedMesh draws its geometry with one material, so a multi-material model
 * is merged under the FIRST material that has a texture (or simply the first).
 * A window whose frame and glass are separate materials arrives all frame. Said
 * out loud in a warning rather than left to be discovered.
 */
export function normalise(scene, rotation = null) {
  const parts = []
  const materials = []
  scene.traverse(node => {
    if (!node.isMesh || !node.geometry) return
    for (const material of (Array.isArray(node.material) ? node.material : [node.material])) {
      if (material) materials.push(material)
    }
    const piece = node.geometry.clone()
    node.updateWorldMatrix(true, false)
    piece.applyMatrix4(node.matrixWorld)
    // mergeGeometries refuses inputs whose attribute sets differ, and a model
    // may carry anything; keep the three every consumer here needs.
    for (const name of Object.keys(piece.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) piece.deleteAttribute(name)
    }
    if (!piece.getAttribute('normal')) piece.computeVertexNormals()
    if (!piece.getAttribute('uv')) {
      const count = piece.getAttribute('position').count
      piece.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2))
    }
    parts.push(piece.index ? piece.toNonIndexed() : piece)
  })
  if (!parts.length) return null

  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)
  for (const piece of parts) if (piece !== merged) piece.dispose()
  if (!merged) return null

  // ROTATED BEFORE THE UNIT BOX IS MEASURED, never after, and the order is the
  // whole point. A balcony modelled lying down is 2m x 2m x 0.1m; stood up with a
  // quarter turn it is 2m x 0.1m x 2m, and those normalise to completely
  // different unit boxes. Fitting first and turning second would scale it to the
  // opening using the dimensions it had while it was still on its side, which is
  // how a corrected model ends up correctly oriented and the wrong shape.
  if (rotation && rotation.some(value => value)) {
    const euler = new THREE.Euler(
      THREE.MathUtils.degToRad(rotation[0] || 0),
      THREE.MathUtils.degToRad(rotation[1] || 0),
      THREE.MathUtils.degToRad(rotation[2] || 0),
      'XYZ',
    )
    merged.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(euler))
  }

  merged.computeBoundingBox()
  const box = merged.boundingBox
  const size = new THREE.Vector3()
  const centre = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(centre)
  // A flat model - a plane, say - would divide by zero on one axis.
  const sx = size.x > 1e-6 ? 1 / size.x : 1
  const sy = size.y > 1e-6 ? 1 / size.y : 1
  const sz = size.z > 1e-6 ? 1 / size.z : 1
  merged.translate(-centre.x, -centre.y, -centre.z)
  merged.scale(sx, sy, sz)

  // Prefer a material that actually has a map: on a two-material window the
  // textured one is the part worth keeping, and it is not reliably first.
  const material = materials.find(entry => entry.map) || materials[0] || null
  const distinct = new Set(materials).size
  if (distinct > 1) {
    console.warn(
      `Building slot mesh: the model has ${distinct} materials and an instanced `
      + 'opening can draw only one, so it is using '
      + `"${material?.name || 'the first'}" for all of it.`,
    )
  }
  return { geometry: merged, material }
}

