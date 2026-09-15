// Real geometry in the openings, instead of the placeholder box.
//
// A UNIT MESH IS THE CONTRACT, and it is the same one the VFX mesh renderer
// settled on after getting it wrong: whatever a model's own dimensions happen to
// be, it is normalised into a unit box first and the instance transform is the
// only thing that decides how big it ends up. Without that a window authored in
// centimetres arrives 100x too small and one authored around its own origin
// arrives off-centre, and both look like bugs in the generator rather than in
// the asset.
//
// DEPTH IS NOT NORMALISED THE SAME WAY as width and height, on purpose. The
// opening's cell says exactly how wide and how tall the hole is, so X and Y are
// stretched to fill it - but nothing says how DEEP a window is, and squashing a
// 200mm frame into the placeholder's 180mm slot would flatten every moulding on
// it. Depth is scaled by the average of the other two instead, so a window keeps
// its proportions and a wide shopfront gets a proportionally deeper frame.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { referenceListKeys } from '../../../building/doc.js'
import { resolveAssetImageUrl } from '../buildingApi'

const loader = new GLTFLoader()

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
function normalise(scene) {
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

/** Load one glTF and return its merged geometry and material, or null. */
async function loadGeometry(url) {
  try {
    const gltf = await loader.loadAsync(url)
    return normalise(gltf.scene)
  } catch {
    return null
  }
}

/**
 * Every opening mesh a document binds, as a tag -> BufferGeometry map.
 *
 * Absent when it did not load, exactly as loadBuildingTextures does: the slot
 * then falls back to the placeholder box, which is the same thing an unbound
 * slot does and is a far better failure than a building with holes in it.
 */
export async function loadSlotMeshes(ir) {
  const out = {}
  const refs = ir?.references || {}

  // DRIVEN BY WHAT THE SLOTS ASK FOR, not by the list of tags. The compiler has
  // already resolved each opening to a reference PREFIX - the building-wide list
  // for its tag, or a facade's override, or one side of one - so loading exactly
  // those prefixes loads exactly what is used and nothing else.
  const prefixes = [...new Set((ir?.slots || []).map(slot => slot.meshSlot).filter(Boolean))]
  if (!prefixes.length) return out

  // ARRAYS, INDEX-ALIGNED WITH THE LIST, holes and all. The compiler chose a
  // variant per opening from the seed, so entry 1 failing to load must leave
  // entry 2 at index 2 - compacting would silently reassign every opening to a
  // different model.
  const jobs = []
  for (const prefix of prefixes) {
    const keys = referenceListKeys(refs, prefix)
    if (!keys.length) continue
    out[prefix] = new Array(keys.length).fill(null)
    keys.forEach((key, index) => {
      const ref = refs[key]
      if (ref) jobs.push({ prefix, index, ref })
    })
  }
  if (!jobs.length) return out

  // One load per ASSET, not per slot that wants it: a facade override and the
  // building-wide list routinely name the same model, and parsing a GLB twice is
  // the kind of waste that only shows up on a big building.
  const cache = new Map()
  await Promise.all(jobs.map(async ({ prefix, index, ref }) => {
    if (!cache.has(ref)) {
      cache.set(ref, (async () => {
        const url = await resolveAssetImageUrl(ref)
        if (!url) {
          console.warn(`Building slot mesh: ${ref} has no file.`)
          return null
        }
        const loaded = await loadGeometry(url)
        if (!loaded) console.warn(`Building slot mesh: ${ref} failed to load from ${url}`)
        return loaded
      })())
    }
    const loaded = await cache.get(ref)
    // SHARED, so two prefixes naming one asset share one upload - and so
    // disposal has to happen once per distinct entry, not once per slot.
    if (loaded) out[prefix][index] = loaded
  }))
  return out
}

/** A stable key for what is bound, so the preview reloads only when it changes. */
export function slotMeshKeyOf(ir) {
  const refs = ir?.references || {}
  const prefixes = [...new Set((ir?.slots || []).map(slot => slot.meshSlot).filter(Boolean))].sort()
  return prefixes
    .map(prefix => `${prefix}:${referenceListKeys(refs, prefix).map(key => refs[key]).join(',')}`)
    .join('|')
}

/** Dispose a map of loaded geometries. */
export function disposeSlotMeshes(meshes) {
  // ONCE PER DISTINCT GEOMETRY. Two prefixes can name the same asset and share
  // one upload, and disposing it twice frees memory the second caller is still
  // drawing from.
  const seen = new Set()
  for (const list of Object.values(meshes || {})) {
    for (const entry of list || []) {
      if (!entry?.geometry || seen.has(entry.geometry)) continue
      seen.add(entry.geometry)
      entry.geometry.dispose?.()
      // The material came from the GLTFLoader with the geometry and nothing else
      // holds it, so it is freed here too - its maps with it.
      entry.material?.dispose?.()
    }
  }
}
