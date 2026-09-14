// node src/utils/building/edits.test.mjs
//
// The chain operations, which are the ones an author actually performs: add a
// second Facade so the ground floor can differ, and delete one again without
// severing the pipeline.

import assert from 'node:assert/strict'
import { compileBuilding } from '../../../building/compile.js'
import { createBuildingDoc } from '../../../building/doc.js'
import {
  ensureStarterGraph, insertNodeAfter, orderedNodes, removeNode, setNodeMode,
  setNodeProp,
} from './edits.js'

let passed = 0
function test(name, fn) {
  try { fn(); passed++ }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1 }
}

const starter = () => ensureStarterGraph(createBuildingDoc({}))
const idOf = (doc, type) => doc.nodes.find(n => n.type === type)?.id
const typesOf = doc => doc.nodes.map(n => n.type)
const chain = doc => {
  // Walk from the footprint to the output, naming each node type on the way.
  const byId = new Map(doc.nodes.map(n => [n.id, n]))
  const next = new Map(doc.edges.map(e => [e.from.node, e.to.node]))
  const out = []
  let at = idOf(doc, 'footprint')
  const seen = new Set()
  while (at && !seen.has(at)) {
    seen.add(at)
    out.push(byId.get(at).type)
    at = next.get(at)
  }
  return out
}

// --- the starter ------------------------------------------------------------

test('the starter graph is a connected pipeline', () => {
  assert.deepEqual(chain(starter()), ['footprint', 'mass', 'facade', 'output'])
  assert.equal(compileBuilding(starter()).ok, true)
})

// --- inserting --------------------------------------------------------------

test('inserting a Facade SPLICES it into the chain', () => {
  // mass -> facade -> output becomes mass -> facade -> facade -> output, with
  // nothing left dangling.
  const doc = starter()
  const next = insertNodeAfter(doc, idOf(doc, 'facade'), 'facade')
  assert.deepEqual(chain(next), ['footprint', 'mass', 'facade', 'facade', 'output'])
  assert.equal(compileBuilding(next).ok, true)
})

test('the spliced node re-points what the source was feeding', () => {
  const doc = starter()
  const next = insertNodeAfter(doc, idOf(doc, 'mass'), 'facade')
  // The output must be fed by the NEW facade, not still by the mass.
  const output = idOf(next, 'output')
  const feeding = next.edges.find(e => e.to.node === output)
  assert.equal(next.nodes.find(n => n.id === feeding.from.node).type, 'facade')
})

test('a singleton cannot be inserted twice', () => {
  const doc = starter()
  const next = insertNodeAfter(doc, idOf(doc, 'facade'), 'output')
  assert.equal(typesOf(next).filter(t => t === 'output').length, 1)
})

test('inserting where the kinds do not line up is refused', () => {
  // A Footprint outputs a shape; a Facade wants a building. Splicing one after
  // the other would make a chain the compiler rejects on the next keystroke.
  const doc = starter()
  const next = insertNodeAfter(doc, idOf(doc, 'footprint'), 'facade')
  assert.equal(typesOf(next).filter(t => t === 'facade').length, 1, 'it was inserted anyway')
})

test('inserting after an unknown node changes nothing', () => {
  const doc = starter()
  assert.deepEqual(chain(insertNodeAfter(doc, 'nope', 'facade')), chain(doc))
})

// --- removing ---------------------------------------------------------------

test('removing a middle node HEALS the chain', () => {
  // The whole point: deleting the Facade must leave mass -> output, not a
  // building that stops compiling until the author notices.
  const doc = starter()
  const next = removeNode(doc, idOf(doc, 'facade'))
  assert.deepEqual(chain(next), ['footprint', 'mass', 'output'])
  assert.equal(compileBuilding(next).ok, true)
})

test('removing one of two facades leaves the other connected', () => {
  // One document, not two: starter() mints fresh node ids each call, so taking
  // the id from a second one would target a node this document has never heard of.
  const base = starter()
  const doc = insertNodeAfter(base, idOf(base, 'facade'), 'facade')
  const two = doc.nodes.filter(n => n.type === 'facade')
  assert.equal(two.length, 2)
  const next = removeNode(doc, two[1].id)
  assert.deepEqual(chain(next), ['footprint', 'mass', 'facade', 'output'])
  assert.equal(compileBuilding(next).ok, true)
})

test('removing the Mass does not heal across mismatched kinds', () => {
  // A footprint cannot feed an output: healing here would make an illegal edge,
  // so the chain is left broken and the compiler says so.
  const doc = starter()
  const next = removeNode(doc, idOf(doc, 'mass'))
  assert.equal(compileBuilding(next).ok, false)
  assert.equal(next.edges.some(e => e.from.node === idOf(next, 'footprint')
    && e.to.node === idOf(next, 'output')), false)
})

// --- list order -------------------------------------------------------------

test('the node list reads in PIPELINE order, not creation order', () => {
  // An inserted node is appended to the array, so without this the second Facade
  // appeared after the Output in the list while the edges said otherwise - and
  // clicking the wrong row was then the obvious mistake.
  const base = starter()
  const doc = insertNodeAfter(base, idOf(base, 'facade'), 'facade')
  assert.deepEqual(orderedNodes(doc).map(n => n.type),
    ['footprint', 'mass', 'facade', 'facade', 'output'])
})

test('a disconnected node still appears, at the end', () => {
  const base = starter()
  const doc = insertNodeAfter(base, idOf(base, 'mass'), 'facade')
  const stray = { ...doc, edges: doc.edges.filter(e => e.to.node !== idOf(doc, 'output')) }
  const order = orderedNodes(stray).map(n => n.type)
  assert.equal(order.length, doc.nodes.length, 'a node vanished from the list')
  assert.equal(order[order.length - 1], 'output')
})

// --- what the whole thing is FOR --------------------------------------------

test('a second Facade overrides only the storeys it claims', () => {
  // The user-facing behaviour: an all-storeys facade, then a ground-floor one,
  // gives a shopfront under a regular grid.
  let doc = starter()
  doc = setNodeProp(doc, idOf(doc, 'mass'), 'levelCount', 4)

  const base = compileBuilding(doc).ir
  const baseGround = base.slots.filter(s => s.floorIndex === 0)
  const baseUpper = base.slots.filter(s => s.floorIndex > 0)

  doc = insertNodeAfter(doc, idOf(doc, 'facade'), 'facade')
  const second = doc.nodes.filter(n => n.type === 'facade')[1].id
  doc = setNodeMode(doc, second, 'storeys', 'ground')
  doc = setNodeMode(doc, second, 'opening', 'shopfront')
  doc = setNodeProp(doc, second, 'bayWidth', 6)

  const ir = compileBuilding(doc).ir
  const ground = ir.slots.filter(s => s.floorIndex === 0)
  const upper = ir.slots.filter(s => s.floorIndex > 0)

  // The upper storeys are untouched...
  assert.equal(upper.length, baseUpper.length, 'the override leaked upward')
  // ...and the ground floor is different, and tagged differently.
  assert.notEqual(ground.length, baseGround.length, 'the ground floor did not change')
  assert.ok(ground.some(s => s.styleSlot === 'shopfront'), 'the new tag is missing')
  assert.ok(upper.every(s => s.styleSlot === 'window'), 'the tag leaked upward')
})

test('two facades never double up openings on one storey', () => {
  // Appending instead of replacing would put two windows in every bay - a
  // silently wrong building rather than an obviously wrong one.
  let doc = starter()
  doc = setNodeProp(doc, idOf(doc, 'mass'), 'levelCount', 3)
  const before = compileBuilding(doc).ir.slots.length

  doc = insertNodeAfter(doc, idOf(doc, 'facade'), 'facade')
  const after = compileBuilding(doc).ir.slots.length
  assert.equal(after, before, `${after} slots after a second identical facade, expected ${before}`)
})

test('an upper-storeys facade places no front door', () => {
  let doc = starter()
  doc = setNodeMode(doc, idOf(doc, 'facade'), 'storeys', 'upper')
  const ir = compileBuilding(doc).ir
  assert.equal(ir.slots.some(s => s.type === 'door'), false)
  assert.equal(ir.slots.some(s => s.floorIndex === 0), false, 'the ground floor was dressed')
})

test('a facade covering no storeys is reported rather than silent', () => {
  let doc = starter()
  doc = setNodeProp(doc, idOf(doc, 'mass'), 'levelCount', 2)
  doc = setNodeMode(doc, idOf(doc, 'facade'), 'storeys', 'range')
  doc = setNodeProp(doc, idOf(doc, 'facade'), 'fromFloor', 8)
  doc = setNodeProp(doc, idOf(doc, 'facade'), 'toFloor', 9)
  const result = compileBuilding(doc)
  assert.ok(result.diagnostics.some(d => d.code === 'W_FACADE_NO_STOREYS'))
})

test('a reversed storey range is read the way it was plainly meant', () => {
  let doc = starter()
  doc = setNodeProp(doc, idOf(doc, 'mass'), 'levelCount', 5)
  doc = setNodeMode(doc, idOf(doc, 'facade'), 'storeys', 'range')
  doc = setNodeProp(doc, idOf(doc, 'facade'), 'fromFloor', 3)
  doc = setNodeProp(doc, idOf(doc, 'facade'), 'toFloor', 1)
  const floors = new Set(compileBuilding(doc).ir.slots.map(s => s.floorIndex))
  assert.deepEqual([...floors].sort(), [1, 2, 3])
})

test('"top" claims only the highest storey, whatever the count', () => {
  for (const levels of [2, 5, 9]) {
    let doc = starter()
    doc = setNodeProp(doc, idOf(doc, 'mass'), 'levelCount', levels)
    doc = setNodeMode(doc, idOf(doc, 'facade'), 'storeys', 'top')
    const floors = new Set(compileBuilding(doc).ir.slots.map(s => s.floorIndex))
    assert.deepEqual([...floors], [levels - 1], `${levels} storeys`)
  }
})

if (process.exitCode) console.error(`\n${passed} passed, failures above.`)
else console.log(`edits.test.mjs: ${passed} passed`)
