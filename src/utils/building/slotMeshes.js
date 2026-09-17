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

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { referenceListKeys } from '../../../building/doc.js'
import { normalise } from './meshNormalise.js'
import {
  SLOT_TRIANGLE_BUDGET, keepsModel, simplifyToBudget, slotUsage, targetTriangles,
  totalInstances, triangleCount,
} from './slotBudget.js'
import { resolveAssetImageUrl } from '../buildingApi.js'

const loader = new GLTFLoader()

/** Load one glTF and return its merged geometry and material, or null. */
async function loadGeometry(url, rotation = null) {
  try {
    const gltf = await loader.loadAsync(url)
    return normalise(gltf.scene, rotation)
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
export async function loadSlotMeshes(ir, options = {}) {
  const { budget = SLOT_TRIANGLE_BUDGET, dropOverBudget = Infinity } = (
    typeof options === 'number' ? { budget: options } : options
  )
  const out = {}
  const refs = ir?.references || {}
  const rotations = ir?.meshRotations || {}

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
      if (ref) jobs.push({ prefix, index, ref, rotation: rotations[key] || null })
    })
  }
  if (!jobs.length) return out

  // HOW OFTEN EACH ENTRY IS DRAWN, so a model can be simplified in proportion to
  // what it costs. A slot is instanced, so the price of binding a model is
  // `triangles x instances` and only the grammar knows the second number - see
  // slotBudget.js. Summed per CACHE KEY rather than per job, because two
  // prefixes naming one asset share one geometry and it has to be cheap enough
  // for both of them together.
  const usage = slotUsage(ir)
  // ONE ALLOWANCE FOR EVERY MODEL, from the total. Sizing each group against
  // its own count would let every group spend the whole budget - see
  // targetTriangles - and would leave a model placed once untouched forever.
  const share = totalInstances(usage)
  const cacheKeyOf = job => (job.rotation ? `${job.ref}#${job.rotation.join(',')}` : job.ref)
  const demand = new Map()
  for (const job of jobs) {
    const key = cacheKeyOf(job)
    demand.set(key, (demand.get(key) || 0) + (usage.get(`${job.prefix}#${job.index}`) || 0))
  }

  // One load per ASSET, not per slot that wants it: a facade override and the
  // building-wide list routinely name the same model, and parsing a GLB twice is
  // the kind of waste that only shows up on a big building.
  const cache = new Map()
  await Promise.all(jobs.map(async ({ prefix, index, ref, rotation }) => {
    // KEYED ON THE TURN AS WELL AS THE ASSET. One model used twice with two
    // different corrections is two geometries, and sharing the cache entry
    // between them would silently give the second one the first one's rotation.
    const key = cacheKeyOf({ ref, rotation })
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        const url = await resolveAssetImageUrl(ref)
        if (!url) {
          console.warn(`Building slot mesh: ${ref} has no file.`)
          return null
        }
        const loaded = await loadGeometry(url, rotation)
        if (!loaded) {
          console.warn(`Building slot mesh: ${ref} failed to load from ${url}`)
          return null
        }
        // Fitted to what it costs, before anything draws it.
        const target = demand.get(key) ? targetTriangles(share, budget) : Infinity
        const geometry = await simplifyToBudget(loaded.geometry, target)
        // AND DROPPED ENTIRELY IF IT STILL WILL NOT FIT. A simplifier has a
        // topology floor - the fin this was written for stops at 392
        // triangles however little it is offered - so on a coarse level a
        // model can miss its allowance by any margin and there is nothing
        // more to remove. Returning null falls the slot back to the
        // placeholder box, which is twelve triangles and is what an unbound
        // slot already draws. At the range a coarse level is for, a two-metre
        // fin on a hundred-and-fifty-metre tower is a few pixels, and this is
        // the same judgement LOD3 makes when it drops openings altogether.
        if (!keepsModel(triangleCount(geometry), target, dropOverBudget)) {
          if (geometry !== loaded.geometry) geometry.dispose()
          loaded.geometry.dispose()
          loaded.material?.dispose?.()
          return null
        }
        if (geometry !== loaded.geometry) {
          loaded.geometry.dispose()
          return { ...loaded, geometry }
        }
        return loaded
      })())
    }
    const loaded = await cache.get(key)
    // SHARED, so two prefixes naming one asset share one upload - and so
    // disposal has to happen once per distinct entry, not once per slot.
    if (loaded) out[prefix][index] = loaded
  }))
  return out
}

/** A stable key for what is bound, so the preview reloads only when it changes. */
export function slotMeshKeyOf(ir) {
  const refs = ir?.references || {}
  const rotations = ir?.meshRotations || {}
  const prefixes = [...new Set((ir?.slots || []).map(slot => slot.meshSlot).filter(Boolean))].sort()
  // THE TURN IS PART OF THE KEY. It is what decides whether the preview reloads,
  // and rotating a model changes the geometry it produces - without this, turning
  // a balcony changed the document and nothing on screen.
  return prefixes
    .map(prefix => `${prefix}:${referenceListKeys(refs, prefix)
      .map(key => `${refs[key]}@${(rotations[key] || []).join(',')}`).join(',')}`)
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
