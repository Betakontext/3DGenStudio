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
  {
    level: 0, label: 'Full detail', bayScale: 1, trim: true, openings: true,
    modelBudget: 1, thin: {}, dropOverBudget: Infinity,
  },
  // Bays a third wider: the windows are still there and still snapped to whole
  // numbers, there are simply fewer of them. The grammar does this correctly by
  // construction - see grammar.js on integer snapping.
  //
  // AND HALF THE POSTS, because bayScale does not touch them. A post is placed
  // at a bay BOUNDARY and tileSpan floors at one bay per wall, so a plan whose
  // edges are already shorter than one bay - any curve approximated as a polygon
  // - gets two posts per edge whatever the bay width is. On the tower that
  // prompted this, doubling the bay width removed exactly zero of 2,336 posts
  // and LOD1 and LOD2 came out byte-identical. See thinSlots below.
  {
    level: 1, label: 'Wider bays, no trim', bayScale: 1.35, trim: false, openings: true,
    modelBudget: 0.45, thin: { pillar: 2 }, dropOverBudget: 3,
  },
  {
    level: 2, label: 'Sparse openings', bayScale: 2, trim: false, openings: true,
    modelBudget: 0.2, thin: { pillar: 4 }, dropOverBudget: 1.5,
  },
  // THE RUNG BEFORE THE CLIFF. Without it the chain went straight from a fully
  // modelled facade to bare massing - 252,154 triangles to 4,526 on the tower,
  // 301,404 to 1,408 on the cottage. Those are 55x and 214x steps, where every
  // other step is about 2x, and a step that size is a visible pop.
  //
  // It is the last level that still has openings, so it is where the detail is
  // spent down rather than switched off: the bays are wide, the posts are
  // thinned hard, and the model allowance is small enough that a model which
  // cannot comply falls back to its placeholder box rather than holding the
  // level up. That fallback is why this level works on both buildings - the
  // tower's fins hit their simplifier floor and keep their shape, the cottage's
  // windows simplify all the way down, and neither needs its own tuning.
  {
    level: 3, label: 'Plain openings', bayScale: 2.8, trim: false, openings: true,
    modelBudget: 0.04, thin: { pillar: 12 }, dropOverBudget: 2,
  },
  // No openings at all. At the range this is drawn, a window is smaller than a
  // pixel and the mass and roof are the whole of the silhouette.
  {
    level: 4, label: 'Massing only', bayScale: 1, trim: false, openings: false,
    modelBudget: 0, thin: {}, dropOverBudget: 1,
  },
]

/**
 * Keep every Nth instance of the named slot types, and drop the rest.
 *
 * THE SECOND REDUCTION LEVER, and the one the LOD chain was missing. bayScale
 * asks the grammar for fewer BAYS, which is exactly right for windows and does
 * nothing at all for posts - so a building whose detail is a colonnade had no
 * usable LOD chain. Shrinking the MODEL cannot cover for it either: a simplifier
 * has a topology floor (the fin that prompted this will not go below 392
 * triangles however little it is offered), so two levels that both ask for less
 * than that floor produce identical geometry.
 *
 * WITHIN EACH (type, floor), IN (face, bay) ORDER, which is the ring of posts
 * round one storey read in order. Keeping every Nth of that is spatially even -
 * it reads as coarser ribbing rather than as a gap - and it is deterministic, so
 * the same posts survive every recompile and a level does not shimmer against
 * the one above it. The first stride is nearly free: the post at the end of one
 * edge stands on the same corner as the post at the start of the next, so
 * keeping every second one mostly removes coincident pairs.
 *
 * OPENINGS ARE NOT THINNED by default, and should not be: a missing window is a
 * hole in a facade, and bayScale already reduces windows correctly.
 */
export function thinSlots(ir, thin) {
  const strides = Object.entries(thin || {}).filter(([, n]) => n > 1)
  if (!strides.length || !ir?.slots?.length) return ir

  const strideOf = new Map(strides)
  const ordered = ir.slots
    .map((slot, index) => ({ slot, index }))
    .sort((left, right) => (
      (left.slot.type < right.slot.type ? -1 : left.slot.type > right.slot.type ? 1 : 0)
      || (left.slot.floorIndex | 0) - (right.slot.floorIndex | 0)
      || (left.slot.faceIndex | 0) - (right.slot.faceIndex | 0)
      || (left.slot.bayIndex | 0) - (right.slot.bayIndex | 0)
      || left.index - right.index
    ))

  const keep = new Set()
  let group = ''
  let seen = 0
  for (const entry of ordered) {
    const stride = strideOf.get(entry.slot.type)
    if (!stride) { keep.add(entry.index); continue }
    const id = entry.slot.type + '#' + (entry.slot.floorIndex | 0)
    if (id !== group) { group = id; seen = 0 }
    if (seen % stride === 0) keep.add(entry.index)
    seen += 1
  }
  if (keep.size === ir.slots.length) return ir
  return { ...ir, slots: ir.slots.filter((_, index) => keep.has(index)) }
}

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
  // THINNED BEFORE THE MODELS ARE LOADED, and the order is the whole point: the
  // budget divides by the instance count, so thinning afterwards would leave
  // every survivor holding the allowance of an instance that is no longer drawn
  // and the level would cost exactly what it did before.
  const ir = thinSlots(result.ir, spec.thin)
  const textures = loadTextures ? await loadTextures(ir) : {}
  // THE MODEL BUDGET FALLS WITH THE LEVEL, and it has to. Widening the bays
  // removes instances, which would hand each surviving model a LARGER allowance
  // - so every level saturated the same budget and LOD1 and LOD2 came out
  // exactly as expensive as LOD0. An LOD that is not cheaper is not an LOD.
  const slotMeshes = loadModels
    ? await loadModels(ir, {
      budget: SLOT_TRIANGLE_BUDGET * (spec.modelBudget ?? 1),
      dropOverBudget: spec.dropOverBudget ?? Infinity,
    })
    : {}
  const object = buildExportObject(ir, textures, slotMeshes)
  return {
    object, ir, textures, slotMeshes, spec,
    triangles: countTriangles(object),
    breakdown: breakdownOf(object),
  }
}

/**
 * Triangles per named mesh, biggest first.
 *
 * So the export dialog can say WHICH part of a level is expensive. Four totals
 * and no breakdown is what made "LOD1 and LOD2 are the same as LOD0" something
 * a person had to work out from the outside.
 */
export function breakdownOf(object) {
  const out = []
  object?.traverse?.(node => {
    const geometry = node.geometry
    if (!geometry) return
    const index = geometry.index
    const position = geometry.getAttribute?.('position')
    const triangles = Math.round((index ? index.count : position?.count || 0) / 3)
    if (triangles > 0) out.push({ name: node.name || 'Mesh', triangles })
  })
  return out.sort((a, b) => b.triangles - a.triangles)
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
