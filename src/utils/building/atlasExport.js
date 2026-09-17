// Merging an exported building into one mesh with one texture.
//
// ---- Almost none of this is new ----------------------------------------------
//
// The layout and the bake already exist, written for the Mesh Assembly feature:
// `assemblyAtlas.js` packs islands by their UV bounding box and
// `assemblyAtlasBake.js` transfers each one into its new home on the GPU. This
// file is the adapter, and it exists because a building breaks three
// assumptions those two make.
//
// ---- 1. A building is UV-mapped in METRES -------------------------------------
//
// An assembly piece arrives with a 0..1 unwrap made for its own texture. A
// building's walls, roof and trim do not have one at all: they are mapped in
// metres and tiled, so a tower wall runs to uv 153.6 and a cottage's to 26.7.
// Only the openings are 0..1.
//
// The reflex is to unwrap the merged mesh through Auto UV and bake onto that by
// ray casting. It is the wrong tool twice over: it invents seams across a
// perfectly good parameterisation, it resamples through space (thin trim
// misprojects), and it makes a page that advertises "no service to start"
// depend on the Python service.
//
// It is also unnecessary, because the packer never assumed 0..1. It sizes an
// island as `uvBounds x textureSize`, so feeding it metre UVs with textureSize
// expressed in PIXELS PER METRE gives exactly the right texel footprint - and
// atlas area then comes out proportional to real surface area, which is the
// texel density anyone would have asked for. One expression covers both cases,
// with no branch on the slot type:
//
//     textureSize = imagePixels * map.repeat.x
//
// because `repeat` is 1/tileMetres on a tiled slot and 1 on a cell slot. See
// textures.js, which sets both. The packer's own global rescale then finds the
// density that fits: a 153 m wall in a 2048 atlas is 13 px/m, and that is the
// right answer rather than a failure.
//
// ---- 2. The mesher emits NON-INDEXED geometry ---------------------------------
//
// An island is a connected component over the index buffer, so without a weld
// every triangle is its own island: a forty-storey tower would hand the packer
// four hundred thousand of them and fill the atlas with confetti. Welding by
// position AND uv is what recovers the real components - a wall strip comes back
// as one island, which is what it is.
//
// ---- 3. A window has holes in it ----------------------------------------------
//
// The holes are kept, and they do NOT cost a second material. Cut-outs used to
// be split into an alpha-tested atlas of their own, on the reasoning that
// sharing one with the walls would break depth sorting. That reasoning was
// wrong: it applies to BLENDING, and a cut-out is not blended. With
// `alphaTest` and `transparent: false` - glTF's MASK mode - the merged material
// sorts exactly like an opaque one, writes depth, and needs no ordering. So
// X materials means X, and if anything in the building punches holes then all X
// are masked.
//
// The shared bake stores COVERAGE in alpha (for the gutter fill), so the real
// alpha is recovered by `preserveAlpha`: a second greyscale pass through the
// same pipeline, composited back into the map's alpha channel.
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { planAtlas } from '../assemblyAtlas.js'
import { tilesByMetres } from './textureSlots.js'
import { bakeAtlases, buildAtlasedGeometry } from '../assemblyAtlasBake.js'

/** A material that punches holes, and therefore cannot share an opaque atlas. */
const isCutout = material => Boolean(material?.alphaTest > 0 || material?.transparent)

/**
 * Every (geometry, material) pair in an export group, as flat pieces.
 *
 * ONE PIECE PER MATERIAL GROUP, not per mesh. `buildExportObject` gives the
 * walls a material ARRAY and draw groups, because a facade can override one
 * side - and an atlas is baked per material, so a mesh carrying four of them
 * has to arrive as four pieces or three of them silently sample the first one's
 * texture.
 */
export function explodeToPieces(group) {
  const pieces = []
  for (const mesh of group?.children || []) {
    if (!mesh.isMesh || !mesh.geometry) continue
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const groups = mesh.geometry.groups?.length ? mesh.geometry.groups : null
    // THE SLOT COMES FROM THE MESH, not from the material. A bound model brings
    // its own material and that material wins - so reading the slot off it gave
    // `undefined` for every opening, which `tilesByMetres` reads as "tiled", so
    // the fins on a tower were split into 196,224 islands instead of one. The
    // packer then could not fit them at any size, and before the bake was
    // batched it was also seventeen gigabytes.
    const slots = mesh.userData?.slots || []
    if (!groups || materials.length <= 1) {
      pieces.push({
        name: mesh.name,
        geometry: mesh.geometry,
        material: materials[0],
        slot: slots[0],
        range: null,
      })
      continue
    }
    for (const range of groups) {
      pieces.push({
        name: `${mesh.name}#${range.materialIndex}`,
        geometry: mesh.geometry,
        material: materials[range.materialIndex] || materials[0],
        slot: slots[range.materialIndex],
        range,
      })
    }
  }
  return pieces
}

/**
 * A piece's own geometry, covering only its draw range, welded and indexed.
 *
 * THE WELD IS SKIPPED FOR A SINGLE-ISLAND PIECE, and that is not just a saving.
 * Welding exists only to recover connected components; a piece the caller has
 * already declared to be ONE island has no components to find. It is also the
 * expensive case by far - the tower's fins are 1.17M triangles in one piece, and
 * mergeVertices on three and a half million vertices builds a string-keyed map
 * of every one of them. Doing that to answer a question nobody asked is how a
 * merge turns into a hang.
 */
export function pieceGeometry(piece, singleIsland = false) {
  const source = piece.geometry
  const index = source.getIndex()
  const sliced = new THREE.BufferGeometry()
  const start = piece.range ? piece.range.start : 0
  const count = piece.range
    ? piece.range.count
    : (index ? index.count : source.getAttribute('position').count)

  for (const name of Object.keys(source.attributes)) {
    const attribute = source.getAttribute(name)
    const size = attribute.itemSize
    const array = new Float32Array(count * size)
    for (let i = 0; i < count; i += 1) {
      const v = index ? index.getX(start + i) : start + i
      for (let c = 0; c < size; c += 1) array[i * size + c] = attribute.getComponent(v, c)
    }
    sliced.setAttribute(name, new THREE.BufferAttribute(array, size))
  }
  // See the header: without this every triangle is an island.
  const welded = singleIsland ? sliced : mergeVertices(sliced)
  if (welded !== sliced) sliced.dispose()
  if (!welded.getIndex()) {
    const n = welded.getAttribute('position').count
    welded.setIndex(Array.from({ length: n }, (_, i) => i))
  }
  return welded
}

/** Texels per unit of UV, which on a tiled slot means texels per metre. */
export function texelDensity(material) {
  const map = material?.map
  const image = map?.image
  const pixels = Math.max(image?.width || 0, image?.height || 0) || 1024
  const repeat = Math.abs(map?.repeat?.x || 1)
  return Math.max(1, pixels * repeat)
}

/** The packer's inputs for one partition, and the geometry they point into. */
function sourcesFor(pieces, label) {
  return pieces.map((piece, index) => {
    // A CELL SLOT IS ONE ISLAND. Its faces all live in the same 0..1 square and
    // sample the same texture - forty instances of one window model are forty
    // identical copies of it - so they share a cell instead of taking one each.
    // See tilesByMetres: a cell slot is exactly the case where the uv is a
    // position within one image rather than a distance in metres.
    const singleIsland = !tilesByMetres(piece.slot)
    return {
      id: `${label}${index}`,
      geometry: pieceGeometry(piece, singleIsland),
      material: piece.material,
      singleIsland,
    }
  })
}

/** What `planAtlas` needs, from sources built above. */
const planInputFor = sources => sources.map(source => ({
    id: source.id,
    indices: source.geometry.getIndex().array,
    uv: source.geometry.getAttribute('uv').array,
    vertexCount: source.geometry.getAttribute('position').count,
    textureSize: texelDensity(source.material),
    singleIsland: source.singleIsland,
}))

/** Plan, bake and rebuild one partition of the pieces. */
function atlasPartition(pieces, { renderer, size, maxAtlases, preserveAlpha, label, onProgress }) {
  if (!pieces.length) return null
  const sources = sourcesFor(pieces, label)
  const planInput = planInputFor(sources)

  const plan = planAtlas(planInput, { size, maxAtlases })
  if (!plan) {
    // WHICH SIZE WOULD HAVE WORKED. The packer scales every island down together
    // until they fit, and gives up after a fixed number of tries - so a building
    // big enough simply cannot go in a small texture, which is a real answer
    // rather than a fault. Saying only "it did not fit" leaves the one useful
    // number for the reader to find by trial; planning is pure and quick enough
    // to just look it up.
    const worked = [2048, 4096, 8192].find(bigger =>
      bigger > size && planAtlas(planInput, { size: bigger, maxAtlases }))
    for (const source of sources) source.geometry.dispose()
    throw new Error(
      `the ${label} surfaces need more than ${size}px`
      + (worked ? ` — ${worked}px fits` : ` in ${maxAtlases} material(s)`))
  }
  const maps = bakeAtlases({ renderer, sources, plan, size, preserveAlpha, onProgress })

  const meshes = []
  for (let atlas = 0; atlas < plan.atlasCount; atlas += 1) {
    const geometry = buildAtlasedGeometry(sources, plan, atlas)
    if (!geometry) continue
    const material = new THREE.MeshStandardMaterial({
      name: `${label}_atlas${atlas}`,
      ...maps[atlas],
      // Whatever constant a source carried is already in its texels, so leaving
      // one on the merged material would apply it twice.
      color: 0xffffff,
      roughness: 1,
      metalness: maps[atlas]?.metalnessMap ? 1 : 0,
      // MASK, not blend. alphaTest discards the holes and leaves the surface
      // otherwise opaque, so it writes depth and sorts with everything else -
      // which is what lets the cut-outs share a material with the walls instead
      // of costing one of their own.
      ...(preserveAlpha ? { alphaTest: 0.5, transparent: false, depthWrite: true } : null),
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `${label}_atlas${atlas}`
    mesh.frustumCulled = false
    meshes.push(mesh)
  }
  for (const source of sources) source.geometry.dispose()
  return { meshes, plan }
}

/**
 * What the merge will produce, from the materials alone - instantly.
 *
 * The dialog calls this while the checkbox is being ticked, so it does nothing
 * but look at materials. The first version called the real planner, which welds
 * every piece, extracts its islands and runs the skyline packer: on a
 * forty-storey tower that is 8,496 islands over 1.2M triangles, and it froze the
 * UI on the click that asked for it. A readout is never worth that.
 *
 * NO DENSITY FIGURE, deliberately. It is the number that makes the size control
 * meaningful, and it cannot be had cheaply: estimating island area from each
 * piece's UV bounding box is a millisecond, but it ignores the padding around
 * every island, which is most of the atlas once the scale is small. Measured
 * against the real planner on both reference buildings, that estimate overstates
 * the detail by between 2x and 9x - worst exactly where the choice matters, at
 * small sizes. One calibration constant cannot cover that spread, so the density
 * is left to `planBuildingAtlas`, which the dialog runs only when asked.
 */
export function summariseBuildingAtlas(group, { maxAtlases = 1 } = {}) {
  const pieces = explodeToPieces(group).filter(piece => piece.geometry.getAttribute('uv'))
  if (!pieces.length) return null
  return {
    materials: maxAtlases,
    masked: pieces.some(piece => isCutout(piece.material)),
  }
}

/**
 * Plan the layout for real, without baking it.
 *
 * Kept for callers that want the true numbers - the fill a layout actually
 * reaches, the island count - and for anything that needs to know a size is
 * achievable rather than estimated. It is the expensive half of the merge; do
 * not put it behind a checkbox.
 */
export function planBuildingAtlas(group, { size = 2048, maxAtlases = 1 } = {}) {
  const pieces = explodeToPieces(group).filter(piece => piece.geometry.getAttribute('uv'))
  if (!pieces.length) return { ok: false, reason: 'nothing in the building carries UVs' }

  const sources = sourcesFor(pieces, 'building')
  const plan = planAtlas(planInputFor(sources), { size, maxAtlases })
  for (const source of sources) source.geometry.dispose()
  if (!plan) {
    return { ok: false, reason: `this building will not pack into ${maxAtlases} texture(s)` }
  }
  return {
    ok: true,
    atlases: plan.atlasCount,
    masked: pieces.some(piece => isCutout(piece.material)),
    fill: Math.round(plan.fill * 1000) / 10,
    // The density the packing settled on, as a fraction of the textures' own
    // resolution. This is the number the size control actually buys, and it is
    // what makes "too small" a QUALITY setting rather than a failure.
    densityScale: Math.round(plan.scale * 1000) / 1000,
  }
}

/**
 * One mesh per shared atlas, from an export group.
 *
 * Returns `{ object, stats }` and leaves the input untouched, so a caller can
 * offer the merge beside the ordinary export rather than instead of it.
 */
export function mergeBuildingToAtlas(group, {
  renderer, size = 2048, maxAtlases = 1, onProgress,
} = {}) {
  if (!renderer) throw new Error('the merge needs a WebGL renderer')
  const pieces = explodeToPieces(group).filter(piece => piece.geometry.getAttribute('uv'))
  if (!pieces.length) throw new Error('nothing in the building carries UVs')

  // ONE PARTITION. X materials means X: everything shares the atlas set, and if
  // any of it punches holes then all of them are masked. See the header on why
  // that costs nothing.
  const masked = pieces.some(piece => isCutout(piece.material))
  const result = atlasPartition(pieces, {
    renderer, size, maxAtlases, preserveAlpha: masked, label: 'building', onProgress,
  })
  if (!result?.meshes?.length) throw new Error('the atlas produced no geometry')

  const out = new THREE.Group()
  out.name = group.name || 'Building'
  for (const mesh of result.meshes) out.add(mesh)

  return {
    object: out,
    stats: {
      atlases: result.plan.atlasCount,
      masked,
      size,
      islands: result.plan.islandCount,
      fill: Math.round(result.plan.fill * 1000) / 10,
      densityScale: Math.round(result.plan.scale * 1000) / 1000,
    },
  }
}
