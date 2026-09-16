// node src/utils/building/exportBuilding.test.mjs
//
// What has to be true of an exported building: every window is actually in it,
// the textures tile at the right size without an extension nobody reads, and
// each LOD is a smaller BUILDING rather than a melted one.

import assert from 'node:assert/strict'
import * as THREE from 'three'
import { compileBuilding } from '../../../building/compile.js'
import { createNode } from '../../../building/catalog.js'
import { appendReference, normalizeBuildingDoc, setReference } from '../../../building/doc.js'
import { textureKey } from '../../../building/stylepack.js'
import {
  LOD_LEVELS, buildExportObject, countTriangles, disposeLevel, docAtLevel,
} from './exportBuilding.js'
import { buildSlotInstances } from './mesh.js'

let passed = 0
function test(name, fn) {
  try { fn(); passed++ }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1 }
}

const SQUARE = { outer: [[0, 0], [16, 0], [16, 12], [0, 12]], holes: [] }

/** footprint -> mass -> [stages] -> output, wired in order. */
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

const irOf = doc => compileBuilding(doc).ir
const FULL = [{ type: 'facade' }, { type: 'roof' }, { type: 'trim' }]

// --- the LOD chain ----------------------------------------------------------

test('every level compiles, and detail falls monotonically', () => {
  // A level that fails to compile exports as nothing, and one that is BIGGER
  // than the level above it is worse than not shipping it at all.
  const doc = graph(FULL, { levelCount: 4 })
  let previous = Infinity
  for (const spec of LOD_LEVELS) {
    const result = compileBuilding(docAtLevel(doc, spec))
    assert.equal(result.ok, true, `LOD${spec.level} does not compile`)
    assert.ok(result.ir.levels.length > 0, `LOD${spec.level} has no geometry`)
    const detail = result.ir.stats.slotCount + result.ir.stats.trimCount
    assert.ok(detail <= previous,
      `LOD${spec.level} has ${detail} details, more than the ${previous} above it`)
    previous = detail
  }
})

test('the SILHOUETTE is identical at every level', () => {
  // The one thing that must not change: a building that changes shape when it
  // switches level pops, and a pop is far more visible than missing trim.
  const doc = graph(FULL, { levelCount: 4 })
  const full = irOf(doc)
  for (const spec of LOD_LEVELS) {
    const ir = irOf(docAtLevel(doc, spec))
    assert.equal(ir.stats.levelCount, full.stats.levelCount, `LOD${spec.level} levels`)
    assert.ok(Math.abs(ir.stats.height - full.stats.height) < 1e-6, `LOD${spec.level} height`)
    assert.ok(Math.abs(ir.stats.roofHeight - full.stats.roofHeight) < 1e-6, `LOD${spec.level} roof`)
  }
})

test('the coarsest level has no openings and no trim at all', () => {
  const ir = irOf(docAtLevel(graph(FULL), LOD_LEVELS[LOD_LEVELS.length - 1]))
  assert.equal(ir.stats.slotCount, 0)
  assert.equal(ir.stats.trimCount, 0)
  // ...but is still a building.
  assert.ok(ir.stats.height > 0)
  assert.ok(ir.roofs[0], 'the massing level lost its roof')
})

test('dropping a middle node HEALS the chain rather than severing it', () => {
  // The Trim sits between the Roof and the Output. Removing it without
  // rejoining them compiles to nothing, and the LOD exports empty.
  const doc = graph(FULL)
  const reduced = docAtLevel(doc, LOD_LEVELS[1])
  assert.equal(reduced.nodes.some(node => node.type === 'trim'), false)
  const result = compileBuilding(reduced)
  assert.equal(result.ok, true)
  assert.ok(result.ir.slots.length > 0, 'the facade was lost along with the trim')
})

test('a graph with nothing to reduce survives every level', () => {
  // No facade, no trim - the reduction must not invent work or break the chain.
  const doc = graph([{ type: 'roof' }])
  for (const spec of LOD_LEVELS) {
    assert.equal(compileBuilding(docAtLevel(doc, spec)).ok, true, `LOD${spec.level}`)
  }
})

test('LOD0 is the document itself, untouched', () => {
  const doc = graph(FULL)
  assert.equal(docAtLevel(doc, LOD_LEVELS[0]), doc)
})

// --- what the exporter is handed --------------------------------------------

test('EVERY INSTANCE IS BAKED, not left for the exporter to drop', () => {
  // three's GLTFExporter writes an InstancedMesh's base mesh once and loses the
  // instance transforms, so a tower would export with one window at the origin.
  const ir = irOf(graph(FULL, { levelCount: 3 }))
  const instanced = buildSlotInstances(ir)
  const instanceCount = instanced.reduce((total, group) => total + group.count, 0)
  assert.ok(instanceCount > 10, `the fixture has only ${instanceCount} openings`)

  const object = buildExportObject(ir)
  let instancedMeshes = 0
  object.traverse(node => { if (node.isInstancedMesh) instancedMeshes += 1 })
  assert.equal(instancedMeshes, 0, 'an InstancedMesh survived into the export')

  // A box is 12 triangles, so the openings alone account for that many.
  const triangles = countTriangles(object)
  assert.ok(triangles > instanceCount * 12,
    `${triangles} triangles for ${instanceCount} openings plus walls - instances were dropped`)
  disposeLevel({ object })
})

test('the export is plain meshes, which every importer understands', () => {
  const object = buildExportObject(irOf(graph(FULL)))
  let meshes = 0
  object.traverse(node => {
    if (node === object) return
    assert.ok(node.isMesh, `${node.type} is not a plain mesh`)
    assert.ok(node.geometry?.getAttribute('position'), 'a mesh has no positions')
    meshes += 1
  })
  assert.ok(meshes >= 3, `only ${meshes} meshes - walls, roof and trim at least`)
  disposeLevel({ object })
})

test('TEXTURE TILING IS BAKED INTO THE UVs, not left on the material', () => {
  // glTF carries texture.repeat only through KHR_texture_transform, which plenty
  // of importers ignore - and when ignored the building arrives wearing one
  // enormous brick. Dividing the UVs cannot be misread.
  const tile = 2.5
  const doc = setReference(graph(FULL), textureKey('wall'), {
    kind: 'image', ref: 'asset:1', tileMetres: tile,
  })
  const ir = irOf(doc)

  const plain = buildExportObject(irOf(graph(FULL)))
  const textured = buildExportObject(ir, { 0: new THREE.Texture() })

  const wallsOf = object => object.children.find(child => child.name === 'Walls')
  const spanOf = mesh => {
    const uv = mesh.geometry.getAttribute('uv')
    let max = 0
    for (let i = 0; i < uv.count; i++) max = Math.max(max, Math.abs(uv.getX(i)))
    return max
  }

  const before = spanOf(wallsOf(plain))
  const after = spanOf(wallsOf(textured))
  assert.ok(Math.abs(after - before / tile) < 1e-4,
    `UVs span ${after.toFixed(3)}, expected ${(before / tile).toFixed(3)}`)

  // ...and the material must not apply the repeat a SECOND time.
  const material = wallsOf(textured).material
  const first = Array.isArray(material) ? material[0] : material
  if (first.map) {
    assert.equal(first.map.repeat.x, 1, 'the repeat is still on the texture as well')
  }
  disposeLevel({ object: plain })
  disposeLevel({ object: textured })
})

test('an untextured building keeps its metre UVs untouched', () => {
  // Zero tile means "nothing bound" - see ir.js - and dividing by it would send
  // every UV to infinity.
  const object = buildExportObject(irOf(graph(FULL)))
  const walls = object.children.find(child => child.name === 'Walls')
  const uv = walls.geometry.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) {
    assert.ok(Number.isFinite(uv.getX(i)) && Number.isFinite(uv.getY(i)), 'a UV is not finite')
  }
  disposeLevel({ object })
})

test('coarser levels really are cheaper', () => {
  // The point of the whole exercise. Compared as triangles, which is what the
  // dialog shows and what an engine pays for.
  const doc = graph(FULL, { levelCount: 4 })
  const counts = LOD_LEVELS.map(spec => {
    const object = buildExportObject(irOf(docAtLevel(doc, spec)))
    const triangles = countTriangles(object)
    disposeLevel({ object })
    return triangles
  })
  assert.ok(counts[0] > counts[counts.length - 1] * 1.5,
    `full detail is ${counts[0]} triangles and massing-only is ${counts[counts.length - 1]}`)
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] <= counts[i - 1],
      `LOD${i} is ${counts[i]} triangles, more than LOD${i - 1}'s ${counts[i - 1]}`)
  }
})

test('an EXPORTED opening fills its cell, exactly as the preview does', () => {
  // The preview expresses this as a texture repeat and the export as baked UVs,
  // so the two can disagree - and a building that looks one way in the tab and
  // another in the file is the worst kind of bug to notice.
  let doc = graph([{ type: 'facade' }])
  doc = appendReference(doc, textureKey('opening'), {
    kind: 'image', ref: 'asset:31', tileMetres: 1.5,
  })
  doc = appendReference(doc, textureKey('wall'), {
    kind: 'image', ref: 'asset:32', tileMetres: 2,
  })

  const ir = compileBuilding(doc).ir
  const object = buildExportObject(ir, {})
  const uvRange = mesh => {
    const uv = mesh.geometry.getAttribute('uv')
    let hi = 0
    for (let i = 0; i < uv.array.length; i++) hi = Math.max(hi, Math.abs(uv.array[i]))
    return hi
  }

  const windows = []
  const walls = []
  object.traverse(child => {
    if (!child.isMesh) return
    if (/window/i.test(child.name)) windows.push(child)
    if (/wall/i.test(child.name)) walls.push(child)
  })
  assert.ok(windows.length, 'no window mesh in the export')
  assert.ok(walls.length, 'no wall mesh in the export')

  // An opening's UVs stay 0..1: the whole image across the hole. Baking DIVIDES
  // by the tile, so the failure is UVs that stop SHORT of 1 - at a 1.5m tile
  // they reach 0.667 and the mesh shows two thirds of the window. Asserting
  // "no more than 1" would have passed either way, which the first version of
  // this test did.
  const openingUv = uvRange(windows[0])
  assert.ok(Math.abs(openingUv - 1) < 0.01,
    `an opening's UVs reach ${openingUv.toFixed(3)}, not 1 - the tile was baked in`)
  // A wall's are divided by its tile, so they run well past 1 on a 12m building.
  assert.ok(uvRange(walls[0]) > 1.5,
    `a wall's UVs only reach ${uvRange(walls[0]).toFixed(3)} - it stopped tiling`)
})

test('a BOUND MODEL reaches the export, and is not replaced by the placeholder', () => {
  // The bug: buildExportObject called buildSlotInstances(ir) with no models at
  // all, so every window, door, post and chimney a document bound came out as
  // the 12-triangle placeholder box. It was invisible because an UNBOUND slot
  // draws that same box - the file looked plausible and the triangle count was
  // reasonable. A 1,808-fin tower exported at 46,000 triangles with no fins.
  const doc = setReference(graph(FULL), 'mesh_window.0', { kind: 'mesh', ref: 'asset:55' })
  const ir = compileBuilding(doc).ir
  const windows = ir.slots.filter(slot => slot.type === 'window')
  assert.ok(windows.length > 10, `only ${windows.length} windows in the fixture`)
  // The compiler must have resolved them to the list, or the export would have
  // nothing to look up and this would pass for the wrong reason.
  assert.ok(windows.every(slot => slot.meshSlot), 'the compiler resolved no mesh slot')

  // A stand-in for a loaded GLB, distinctive enough that its triangles can be
  // told apart from the placeholder's twelve.
  const model = new THREE.SphereGeometry(0.5, 12, 8)
  const modelTriangles = model.index.count / 3
  const slotMeshes = {}
  for (const prefix of new Set(windows.map(slot => slot.meshSlot))) {
    slotMeshes[prefix] = [{ geometry: model, material: new THREE.MeshStandardMaterial() }]
  }

  const without = buildExportObject(ir)
  const bound = buildExportObject(ir, {}, slotMeshes)
  const gain = countTriangles(bound) - countTriangles(without)
  // Each window swaps twelve placeholder triangles for the model's.
  const expected = windows.length * (modelTriangles - 12)
  assert.equal(gain, expected,
    `binding a model changed the export by ${gain} triangles, expected ${expected}`)
  disposeLevel({ object: without })
  disposeLevel({ object: bound })
  model.dispose()
})

test('healing a chain past a MERGE reattaches to the right port', () => {
  // The heal used to take the port from the edge that ARRIVED at the dropped
  // node instead of the one that LEFT it. Down a linear chain both are
  // `building` and it made no difference for months; a Merge's ports are `a` and
  // `b`, so a Trim between a Roof and a Merge reattached the Roof to
  // `mg.building` - a port a Merge does not have - and every level below LOD0
  // failed with "Merge has nothing plugged into Building". That is every
  // building with a wing, a tower or a porch: the full model exported fine and
  // its entire LOD chain silently did not.
  const fp = createNode('footprint', 'fp')
  fp.props.shape = SQUARE
  const second = createNode('footprint', 'fp2')
  second.props.shape = { outer: [[20, 0], [30, 0], [30, 8], [20, 8]], holes: [] }
  const nodes = [
    fp, createNode('mass', 'ms'), createNode('roof', 'rf'), createNode('trim', 'tr'),
    second, createNode('mass', 'ms2'), createNode('roof', 'rf2'), createNode('trim', 'tr2'),
    createNode('merge', 'mg'), createNode('output', 'out'),
  ]
  const edge = (from, to, port) => ({ from: { node: from, port: 'out' }, to: { node: to, port } })
  const doc = normalizeBuildingDoc({
    nodes,
    edges: [
      edge('fp', 'ms', 'shape'), edge('ms', 'rf', 'building'), edge('rf', 'tr', 'building'),
      edge('fp2', 'ms2', 'shape'), edge('ms2', 'rf2', 'building'), edge('rf2', 'tr2', 'building'),
      // The two Trims are what the reduction drops, and they are the only things
      // standing between the roofs and the Merge's two ports.
      edge('tr', 'mg', 'a'), edge('tr2', 'mg', 'b'),
      edge('mg', 'out', 'building'),
    ],
  })
  assert.equal(compileBuilding(doc).ok, true, 'the fixture itself does not compile')

  for (const spec of LOD_LEVELS.slice(1)) {
    const reduced = docAtLevel(doc, spec)
    assert.equal(reduced.nodes.some(node => node.type === 'trim'), false, `LOD${spec.level}`)
    const ports = reduced.edges.filter(e => e.to.node === 'mg').map(e => e.to.port).sort()
    assert.deepEqual(ports, ['a', 'b'],
      `LOD${spec.level}: the Merge is fed through ${JSON.stringify(ports)}`)
    const result = compileBuilding(reduced)
    assert.equal(result.ok, true,
      `LOD${spec.level}: ${result.diagnostics.filter(d => d.severity === 'error').map(d => d.message).join('; ')}`)
    // ...and BOTH parts are still there, not just the branch that happened to
    // keep its wiring.
    assert.equal(result.ir.roofs.length, 2, `LOD${spec.level}: a branch was lost`)
  }
})

test('a coarser level gives its MODELS a smaller allowance, not a larger one', () => {
  // Widening the bays removes instances, and the allowance is the budget divided
  // by instances - so without a per-level scale each coarser level hands its
  // models MORE triangles each and lands on exactly the same total. LOD1 and
  // LOD2 both came out at 1,200,570 triangles beside LOD0's 1,214,538. An LOD
  // that is not cheaper is not an LOD.
  const budgets = LOD_LEVELS.map(spec => spec.modelBudget)
  assert.deepEqual(budgets, [...budgets].sort((a, b) => b - a),
    `the model budget does not fall with the level: ${JSON.stringify(budgets)}`)
  assert.equal(budgets[0], 1, 'LOD0 must be the full budget - it is the model')
  assert.ok(budgets[1] < 1 && budgets[2] < budgets[1], 'two levels share an allowance')
})

if (process.exitCode) console.error(`\n${passed} passed, failures above.`)
else console.log(`exportBuilding.test.mjs: ${passed} passed`)
