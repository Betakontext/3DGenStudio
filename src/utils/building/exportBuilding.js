// Turning a building into something that can leave the app.
//
// THREE THINGS HAVE TO CHANGE between what the preview draws and what an
// exporter can carry, and each of them is invisible until it bites:
//
//  1. INSTANCES MUST BE BAKED. The preview draws every opening as one
//     InstancedMesh per (type, material) - thousands of windows for one draw
//     call. three's GLTFExporter writes an InstancedMesh's BASE mesh once and
//     drops the instance transforms, so an exported tower would arrive with a
//     single window at the origin. Every instance is therefore flattened into
//     real geometry here.
//
//  2. TEXTURE REPEAT MUST BE BAKED INTO THE UVs. Walls are UV-mapped in metres
//     and tiled with texture.repeat = 1/tileMetres - see textures.js. A glTF
//     carries repeat only through KHR_texture_transform, which plenty of
//     importers ignore, and when it is ignored the building arrives with one
//     enormous brick stretched over each wall. Dividing the UVs instead needs no
//     extension and cannot be misread.
//
//  3. LODs ARE REGENERATED, NOT DECIMATED. This is the same argument
//     python-server/app/services/treegen/lod.py makes for trees, and it is
//     stronger for buildings: a general simplifier judges triangles, and the
//     cheapest triangles to delete are the window reveals and the cornice -
//     exactly the silhouette that says "building". Asking the GRAMMAR for less
//     detail instead gives wider bays, no trim and eventually a plain massing
//     block, each of which is still a correct building.

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { compileBuilding } from '../../../building/compile.js'
import { nodesOfType } from '../../../building/doc.js'
import {
  buildBuildingGeometry, buildRoofGeometry, buildSlotInstances, buildTrimGeometry,
} from './mesh.js'
import { buildMaterials } from './materials.js'
import { SLOT_TRIANGLE_BUDGET } from './slotBudget.js'
import { tilesByMetres } from './textureSlots.js'

/**
 * The detail levels, coarsest last.
 *
 * Named for what the viewer can still see at that range rather than for a
 * triangle budget: the point of regenerating is that each level is a building a
 * person would accept, not a melted version of the last one.
 */
export const LOD_LEVELS = [
  { level: 0, label: 'Full detail', bayScale: 1, trim: true, openings: true, modelBudget: 1 },
  // Bays a third wider: the windows are still there and still snapped to whole
  // numbers, there are simply fewer of them. The grammar does this correctly by
  // construction - see grammar.js on integer snapping.
  { level: 1, label: 'Wider bays, no trim', bayScale: 1.35, trim: false, openings: true, modelBudget: 0.45 },
  { level: 2, label: 'Sparse openings', bayScale: 2, trim: false, openings: true, modelBudget: 0.2 },
  // No openings at all. At the range this is drawn, a window is smaller than a
  // pixel and the mass and roof are the whole of the silhouette.
  { level: 3, label: 'Massing only', bayScale: 1, trim: false, openings: false, modelBudget: 0 },
]

/**
 * A document at one detail level.
 *
 * Pure doc -> doc: it widens the bays on every Facade, drops the Trim nodes, and
 * at the coarsest level drops the Facades too. Nothing else is touched - the
 * mass, the roof and the deformation are the silhouette and must not change
 * between levels, or the building visibly pops when it switches.
 */
export function docAtLevel(doc, spec) {
  if (!spec || spec.level === 0) return doc

  const drop = new Set()
  if (!spec.trim) for (const node of nodesOfType(doc, 'trim')) drop.add(node.id)
  if (!spec.openings) for (const node of nodesOfType(doc, 'facade')) drop.add(node.id)

  const nodes = doc.nodes
    .filter(node => !drop.has(node.id))
    .map(node => (node.type === 'facade' && spec.bayScale !== 1
      ? { ...node, props: { ...node.props, bayWidth: (node.props.bayWidth || 3) * spec.bayScale } }
      : node))

  // HEAL THE CHAIN rather than leaving it severed: removing a node from the
  // middle of a pipeline without rejoining its neighbours produces a document
  // that compiles to nothing, which would export an empty LOD.
  //
  // THE PORT COMES FROM THE EDGE THAT LEAVES the dropped node, not from the one
  // that arrived at it. Both are `building` all the way down a linear chain, so
  // for a long time it made no difference - and then a Merge, whose ports are
  // `a` and `b`, turned up. Reattaching the roof to the port named on the
  // incoming edge sent it to `mg.building`, a port a Merge does not have, and
  // every level below LOD0 failed with "Merge has nothing plugged into
  // Building". That is every building with a wing, a tower or a porch: the full
  // model exported and its whole LOD chain silently did not.
  const kept = new Set(nodes.map(node => node.id))
  const outgoing = new Map()
  for (const edge of doc.edges) {
    if (!outgoing.has(edge.from.node)) outgoing.set(edge.from.node, edge)
  }
  const edges = []
  for (const edge of doc.edges) {
    if (!kept.has(edge.from.node)) continue
    let to = edge.to
    const seen = new Set()
    while (to && !kept.has(to.node) && !seen.has(to.node)) {
      seen.add(to.node)
      to = outgoing.get(to.node)?.to || null
    }
    if (!to || !kept.has(to.node)) continue
    edges.push({
      ...edge,
      id: `${edge.from.node}:${edge.from.port}->${to.node}:${to.port}`,
      to: { ...to },
    })
  }

  return { ...doc, nodes, edges }
}

/** Clone a geometry with every UV divided by its material's tile size. */
function bakeTileIntoUvs(geometry, tileByGroup, groups) {
  const uv = geometry.getAttribute('uv')
  if (!uv) return geometry
  const out = geometry.clone()
  const array = out.getAttribute('uv').array

  const applyRange = (start, count, tile) => {
    if (!(tile > 0)) return
    for (let i = start; i < start + count; i++) {
      array[i * 2] /= tile
      array[i * 2 + 1] /= tile
    }
  }

  if (groups?.length && out.groups.length) {
    out.groups.forEach((group, index) => {
      applyRange(group.start, group.count, tileByGroup[index])
    })
  } else {
    applyRange(0, uv.count, tileByGroup[0])
  }
  return out
}

/**
 * Bake one instanced group into ordinary geometry.
 *
 * The instance matrices are applied on the CPU, one clone of the base box per
 * instance, and merged. Expensive-looking and not: a 3,000-window tower is
 * 3,000 twelve-triangle boxes, which merges in a few milliseconds and is a
 * one-off at export rather than something the preview pays for.
 */
function bakeInstances(group) {
  const parts = []
  const matrix = new THREE.Matrix4()
  for (let i = 0; i < group.count; i++) {
    matrix.fromArray(group.matrices, i * 16)
    const piece = group.geometry.clone()
    piece.applyMatrix4(matrix)
    // The merge refuses inputs whose attribute sets differ, and a BoxGeometry
    // carries uv but no groups - strip anything the walls do not also have.
    piece.deleteAttribute('uv1')
    parts.push(piece)
  }
  if (!parts.length) return null
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)
  for (const piece of parts) if (piece !== merged) piece.dispose()
  return merged
}

/**
 * Build the Object3D an exporter should be handed.
 *
 * A GROUP OF PLAIN MESHES, one per material, rather than the preview's mixture
 * of multi-group geometry and InstancedMeshes. Every exporter, every engine and
 * every importer understands that shape; almost nothing understands the other.
 *
 * @param {object} ir a BuildingIR
 * @param {object} textures material index -> THREE.Texture, from loadBuildingTextures
 * @returns {THREE.Group}
 */
export function buildExportObject(ir, textures = {}, slotMeshes = {}) {
  const root = new THREE.Group()
  root.name = 'Building'

  const materials = buildMaterials(ir, textures)
  // The repeat is baked into the UVs below, so the material must not apply it a
  // second time. Cloned rather than mutated: the preview is drawing with these.
  const exportMaterials = materials.map(material => {
    const copy = material.clone()
    if (copy.map) {
      copy.map = copy.map.clone()
      copy.map.repeat.set(1, 1)
      copy.map.needsUpdate = true
    }
    return copy
  })
  // ZERO FOR A CELL SLOT, which bakeTileIntoUvs reads as "do not divide". The
  // preview and the export have to agree here: the preview expresses the same
  // rule as a texture repeat, and a mismatch is a building that looks one way in
  // the tab and another in the file.
  const tileOf = index => {
    const material = ir.materials[index]
    if (!material || !tilesByMetres(material.slot)) return 0
    return material.tile || 0
  }

  const surfaces = [
    ['Walls', buildBuildingGeometry(ir)],
    ['Roof', buildRoofGeometry(ir)],
    ['Trim', buildTrimGeometry(ir)],
  ]
  for (const [name, built] of surfaces) {
    if (!built?.geometry) continue
    const groups = built.groups || []
    const baked = bakeTileIntoUvs(built.geometry, groups.map(tileOf), groups)
    if (baked !== built.geometry) built.geometry.dispose()
    const mesh = new THREE.Mesh(
      baked,
      groups.length
        ? groups.map(index => exportMaterials[index] || exportMaterials[0])
        : exportMaterials[0],
    )
    mesh.name = name
    root.add(mesh)
  }

  // WITH THE MODELS. This argument was missing, and because an unbound slot
  // legitimately falls back to the placeholder box there was nothing to see:
  // the export simply came out with a 12-triangle box in every opening and a
  // plausible-looking triangle count. Every window, door, post and chimney a
  // document bound was silently dropped on the way out of the app.
  for (const group of buildSlotInstances(ir, slotMeshes)) {
    const geometry = bakeInstances(group)
    if (!geometry) continue
    const tile = tileOf(group.material)
    const baked = bakeTileIntoUvs(geometry, [tile], null)
    if (baked !== geometry) geometry.dispose()
    // The same rule the preview follows: a texture bound to the element's OWN
    // slot wins, otherwise the model keeps the material it arrived with. A
    // chimney or a balcony only borrows its slot, so a texture there never wins.
    const slotMaterial = exportMaterials[group.material] || exportMaterials[0]
    const slotHasTexture = Boolean(ir.materials?.[group.material]?.ref)
    const modelWins = group.borrowsMaterial || !slotHasTexture
    const mesh = new THREE.Mesh(
      baked,
      (modelWins && group.modelMaterial) || slotMaterial,
    )
    mesh.name = `${group.tag || group.type}s`
    root.add(mesh)
    // Only the placeholder box belongs to this call; a bound slot mesh is shared
    // with the preview and owned by its loader.
    if (group.ownsGeometry) group.geometry.dispose()
  }

  return root
}

/** Total triangles in an Object3D, for reporting what an export actually costs. */
export function countTriangles(object) {
  let total = 0
  object?.traverse?.(node => {
    const geometry = node.geometry
    if (!geometry) return
    const index = geometry.getIndex()
    const position = geometry.getAttribute('position')
    total += (index ? index.count : position?.count || 0) / 3
  })
  return Math.round(total)
}

/**
 * Compile and build one detail level.
 *
 * `loadTextures` and `loadModels` are INJECTED rather than imported, so this
 * module needs no TextureLoader and no GLTFLoader and stays runnable in a plain
 * node test - which is where the LOD reduction and the UV baking are actually
 * checked. The caller passes textures.js's and slotMeshes.js's loaders; a test
 * passes nothing and gets untextured placeholder geometry.
 *
 * Both are loaded PER LEVEL rather than once, because a coarse level binds
 * fewer materials and places fewer openings - and embedding a window texture in
 * a level that has no windows is bytes for nothing. Loading the models per level
 * also gets the triangle budget right for each one: level 2 has half the
 * openings of level 0, so its models are allowed twice the detail.
 */
export async function buildLevel(doc, spec, loadTextures = null, loadModels = null) {
  const result = compileBuilding(docAtLevel(doc, spec))
  if (!result.ok || !result.ir.levels.length) {
    throw new Error(`The building does not compile at ${spec.label}.`)
  }
  const textures = loadTextures ? await loadTextures(result.ir) : {}
  // THE MODEL BUDGET FALLS WITH THE LEVEL, and it has to. Widening the bays
  // removes instances, which would hand each surviving model a LARGER allowance
  // - so every level saturated the same budget and LOD1 and LOD2 came out
  // exactly as expensive as LOD0. An LOD that is not cheaper is not an LOD.
  const slotMeshes = loadModels
    ? await loadModels(result.ir, SLOT_TRIANGLE_BUDGET * (spec.modelBudget ?? 1))
    : {}
  const object = buildExportObject(result.ir, textures, slotMeshes)
  return { object, ir: result.ir, textures, slotMeshes, triangles: countTriangles(object), spec }
}

/**
 * Dispose everything a built level allocated.
 *
 * INCLUDING THE LOADED MODELS, which the object graph does not own: a bound slot
 * geometry is shared between the draw groups that wear it, so it is freed here,
 * once, rather than once per mesh in the traversal.
 */
export function disposeLevel(level) {
  level?.object?.traverse?.(node => {
    node.geometry?.dispose?.()
    const material = node.material
    if (Array.isArray(material)) for (const entry of material) entry?.dispose?.()
    else material?.dispose?.()
  })
  // Not slotMeshes.js's disposeSlotMeshes, deliberately: that module reaches
  // transport - resolveAssetImageUrl, and through it Vite's import.meta.env -
  // and importing it here would stop this file running under plain `node`, which
  // is where the LOD reduction and the UV baking are checked. Six lines is a
  // cheaper price than losing the test.
  const seen = new Set()
  for (const list of Object.values(level?.slotMeshes || {})) {
    for (const entry of list || []) {
      if (!entry?.geometry || seen.has(entry.geometry)) continue
      seen.add(entry.geometry)
      entry.geometry.dispose?.()
      entry.material?.dispose?.()
    }
  }
}
