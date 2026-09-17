// node src/utils/building/atlasExport.test.mjs
//
// The half of the merge that needs no GPU: splitting an export group into
// pieces, welding them into real islands, and the texel density that makes a
// metre-mapped wall pack at the right size. The bake itself needs a renderer
// and is checked in the browser.

import assert from 'node:assert/strict'
import * as THREE from 'three'
import { compileBuilding } from '../../../building/compile.js'
import { createNode } from '../../../building/catalog.js'
import { normalizeBuildingDoc, setReference } from '../../../building/doc.js'
import { buildExportObject } from './exportBuilding.js'
import { explodeToPieces, pieceGeometry, texelDensity } from './atlasExport.js'
import { extractIslands, planAtlas } from '../assemblyAtlas.js'
import { mergeGeometries as mergeTest } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

let passed = 0
function test(name, fn) {
  try { fn(); passed++ }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1 }
}

const SQUARE = { outer: [[0, 0], [16, 0], [16, 12], [0, 12]], holes: [] }

function graph(stages = [], { levelCount = 3 } = {}) {
  const footprint = createNode('footprint', 'fp')
  footprint.props.shape = SQUARE
  const mass = createNode('mass', 'ms')
  mass.props.levelCount = levelCount
  const nodes = [footprint, mass]
  const edges = [{ from: { node: 'fp', port: 'out' }, to: { node: 'ms', port: 'shape' } }]
  let previous = 'ms'
  stages.forEach((stage, i) => {
    const node = createNode(stage.type, `n${i}`)
    Object.assign(node.props, stage.props || {})
    Object.assign(node.modes, stage.modes || {})
    nodes.push(node)
    edges.push({ from: { node: previous, port: 'out' }, to: { node: node.id, port: 'building' } })
    previous = node.id
  })
  nodes.push(createNode('output', 'out'))
  edges.push({ from: { node: previous, port: 'out' }, to: { node: 'out', port: 'building' } })
  return normalizeBuildingDoc({ nodes, edges })
}

const FULL = [{ type: 'facade' }, { type: 'roof' }, { type: 'trim' }]
const irOf = doc => compileBuilding(doc).ir

test('a wall is ONE island, not one per triangle', () => {
  // The mesher emits non-indexed geometry - every triangle carrying its own
  // three vertices - and an island is a connected component over the index
  // buffer. Without a weld the packer is handed one island per triangle, which
  // on a forty-storey tower is four hundred thousand of them, and the atlas
  // comes out as confetti at a density nothing can use.
  const object = buildExportObject(irOf(graph(FULL)))
  const walls = explodeToPieces(object).find(piece => piece.name.startsWith('Walls'))
  assert.ok(walls, 'no wall piece came out of the export group')

  const raw = walls.geometry.getAttribute('position').count
  const geometry = pieceGeometry(walls)
  const welded = geometry.getAttribute('position').count
  assert.ok(welded < raw, `the weld kept every vertex (${raw})`)

  const triangles = geometry.getIndex().count / 3
  assert.ok(triangles > 20, `only ${triangles} triangles in the fixture`)

  // THE BASELINE, stated rather than assumed: with a trivial index - which is
  // what a non-indexed geometry gets - the island count IS the triangle count.
  const unwelded = extractIslands(
    Uint32Array.from({ length: triangles * 3 }, (_, i) => i), triangles * 3)
  assert.equal(unwelded.length, triangles, 'the baseline is not one island per triangle')

  const islands = extractIslands(geometry.getIndex().array, welded)
  assert.ok(islands.length <= triangles / 3,
    `${islands.length} islands for ${triangles} triangles - they did not weld`)
  geometry.dispose()
})

test('a MULTI-MATERIAL mesh arrives as one piece per material', () => {
  // The walls carry a material array and draw groups, because a facade can
  // override one side. An atlas is baked per material, so a mesh handed over
  // whole would have three of its four materials silently sampling the first
  // one's texture.
  // A per-SIDE texture override is what splits the wall material: a facade can
  // dress one compass side differently, and that is a second wall material with
  // its own draw group.
  const doc = setReference(graph(FULL), 'n0.wall.north.0',
    { kind: 'image', ref: 'asset:41', tileMetres: 2 })
  const ir = irOf(doc)
  const object = buildExportObject(ir)
  const wallMesh = object.children.find(child => child.name === 'Walls')
  assert.ok(Array.isArray(wallMesh?.material), 'the fixture has no multi-material mesh')
  assert.ok(wallMesh.material.length > 1, 'the fixture has only one wall material')

  const pieces = explodeToPieces(object).filter(piece => piece.name.startsWith('Walls'))
  assert.equal(pieces.length, wallMesh.geometry.groups.length,
    'a draw group did not become its own piece')
  // Each piece must carry only its own range, or the atlas would be built from
  // geometry it is not going to draw.
  const total = pieces.reduce((sum, piece) => sum + piece.range.count, 0)
  assert.equal(total, wallMesh.geometry.getAttribute('position').count)
})

test('texel density is PIXELS PER METRE on a tiled slot, and pixels on a cell slot', () => {
  // The one expression the whole adapter rests on. `repeat` is 1/tileMetres on a
  // wall and 1 on an opening, so multiplying by it converts a whole-texture
  // resolution into the density the packer needs - with no branch on slot type.
  const image = { width: 1024, height: 1024 }
  const tiled = { map: { image, repeat: { x: 1 / 2 } } }        // a 2 m brick
  const cell = { map: { image, repeat: { x: 1 } } }             // a window fills its hole
  assert.equal(texelDensity(tiled), 512, '1024px over 2 m is 512 px/m')
  assert.equal(texelDensity(cell), 1024)
  // An unbound slot still needs a size, or its island collapses to nothing.
  assert.equal(texelDensity({}), 1024)
  assert.equal(texelDensity(null), 1024)
})

test('every piece of a textured building can be packed', () => {
  // The end-to-end shape of the pure half: real geometry, real UV ranges (the
  // walls run to tens of metres), and a plan that comes back rather than null.
  const doc = setReference(graph(FULL), 'tex_wall.0',
    { kind: 'image', ref: 'asset:41', tileMetres: 2 })
  const object = buildExportObject(irOf(doc))
  const pieces = explodeToPieces(object).filter(piece => piece.geometry.getAttribute('uv'))
  assert.ok(pieces.length >= 3, `only ${pieces.length} pieces`)

  let maxUv = 0
  for (const piece of pieces) {
    const geometry = pieceGeometry(piece)
    const uv = geometry.getAttribute('uv')
    for (let i = 0; i < uv.count; i += 1) maxUv = Math.max(maxUv, uv.getX(i), uv.getY(i))
    geometry.dispose()
  }
  assert.ok(maxUv > 1.5,
    `the largest uv is ${maxUv.toFixed(2)} - the fixture is not metre-mapped, so it proves nothing`)
})

test('singleIsland collapses a piece to one cell, and is OFF by default', () => {
  // The packer is shared with the Mesh Assembly merge, which must be unaffected:
  // it never sets the flag, so it must still get one island per connected
  // component. And with the flag, a piece whose faces are UV-identical - forty
  // instances of one window, each a separate shell - takes one cell instead of
  // hundreds. Without it those hundreds each claim the source's full
  // resolution, overflow any atlas, and the packer's global rescale shrinks
  // every OTHER piece to slivers to compensate.
  const boxes = []
  for (let i = 0; i < 6; i += 1) boxes.push(new THREE.BoxGeometry(1, 1, 1).toNonIndexed())
  const geometry = pieceGeometry({ geometry: mergeTest(boxes), material: null, range: null })
  const vertexCount = geometry.getAttribute('position').count
  const indices = geometry.getIndex().array
  const faces = indices.length / 3

  const split = planAtlas([{
    id: 'a', indices, uv: geometry.getAttribute('uv').array, vertexCount, textureSize: 64,
  }], { size: 2048 })
  const single = planAtlas([{
    id: 'a', indices, uv: geometry.getAttribute('uv').array, vertexCount, textureSize: 64,
    singleIsland: true,
  }], { size: 2048 })

  assert.ok(split.islandCount > 1, `the fixture is one island already (${split.islandCount})`)
  assert.equal(single.islandCount, 1, 'the flag did not collapse the piece')
  // Every face still has a home, or the merge would drop geometry.
  const placed = single.placements.flat().reduce((n, p) => n + p.faceList.length, 0)
  assert.equal(placed, faces, 'faces went missing when the piece became one island')
  geometry.dispose()
})

test('the packer FITS whatever size it is given, rather than refusing', () => {
  // The size control is the quality setting, not a constraint that can fail:
  // asking for 2048 means 2048, with the UVs packed at whatever density that
  // leaves. The old loop started at full density and stepped down by 0.85 a
  // fixed twenty-four times, so the smallest reachable scale was 0.02 and a big
  // enough building simply would not pack - a 150 m tower needs about 0.023 in a
  // 2048 atlas and landed on the wrong side of the last attempt, which the
  // export then reported as a failure.
  // DISTINCT planes, each somewhere else in space and in UV. Forty copies of one
  // plane weld into a single island and pack trivially, which is a fixture that
  // proves nothing - the first version of this test passed with the fix removed.
  const huge = []
  for (let i = 0; i < 40; i += 1) {
    const g = new THREE.PlaneGeometry(1, 1).toNonIndexed()
    g.translate(i * 3, 0, 0)
    const uv = g.getAttribute('uv')
    for (let k = 0; k < uv.count; k += 1) {
      uv.setXY(k, uv.getX(k) * 60 + i * 100, uv.getY(k) * 40)
    }
    huge.push(g)
  }
  const geometry = pieceGeometry({ geometry: mergeTest(huge), material: null, range: null })
  const input = [{
    id: 'a',
    indices: geometry.getIndex().array,
    uv: geometry.getAttribute('uv').array,
    vertexCount: geometry.getAttribute('position').count,
    // 1024px over a 2 m tile, i.e. what a real wall texture asks for.
    textureSize: 512,
  }]

  for (const size of [1024, 2048, 4096]) {
    const plan = planAtlas(input, { size, maxAtlases: 1 })
    assert.ok(plan, `${size}px refused to pack, which is now a failure rather than a density`)
    assert.ok(plan.scale > 0, `${size}px packed at a zero scale`)
    // ...and a smaller texture must mean a smaller scale, or the size control
    // is not buying anything.
    assert.ok(plan.fill > 0 && plan.fill <= 1, `${size}px reports a fill of ${plan.fill}`)
  }
  const small = planAtlas(input, { size: 1024, maxAtlases: 1 })
  const big = planAtlas(input, { size: 4096, maxAtlases: 1 })
  assert.ok(big.scale > small.scale,
    `4096 packed at ${big.scale} and 1024 at ${small.scale} - the size buys no detail`)
  geometry.dispose()
})

test('a bound MODEL does not hide which slot it fills', () => {
  // The bug that made a tower unpackable. The slot decides whether a piece tiles
  // by metres or fills a cell, and a cell slot packs as ONE island because every
  // instance is a copy of the same 0..1 square. It used to be read off the
  // material - but a bound model brings its own material and that material wins,
  // so the slot came back undefined, `tilesByMetres` read that as "tiled", and
  // the tower's 2,336 fins were split into 196,224 islands instead of one. The
  // packer then could not fit them at any texture size.
  const doc = setReference(graph(FULL), 'mesh_window.0', { kind: 'mesh', ref: 'asset:55' })
  const ir = compileBuilding(doc).ir
  const prefixes = new Set(ir.slots.filter(s => s.type === 'window').map(s => s.meshSlot))
  assert.ok(prefixes.size, 'the fixture bound no window model')

  // A model material with NO userData at all, which is what a GLB provides.
  const model = {
    geometry: new THREE.SphereGeometry(0.5, 8, 6),
    material: new THREE.MeshStandardMaterial(),
  }
  const slotMeshes = {}
  for (const prefix of prefixes) slotMeshes[prefix] = [model]

  const object = buildExportObject(ir, {}, slotMeshes)
  const windows = explodeToPieces(object).find(piece => piece.name === 'windows')
  assert.ok(windows, 'no window piece came out of the export')
  // The material really is the model's, or this would pass for the wrong reason.
  assert.equal(windows.material.userData.slot, undefined,
    'the model material carries a slot, so the fixture does not reproduce the bug')
  assert.equal(windows.slot, 'opening', `the slot came through as ${windows.slot}`)
  model.geometry.dispose()
})

if (process.exitCode) console.error(`\n${passed} passed, failures above.`)
else console.log(`atlasExport.test.mjs: ${passed} passed`)
