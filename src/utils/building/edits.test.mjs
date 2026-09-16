// node src/utils/building/edits.test.mjs
//
// The chain operations, which are the ones an author actually performs: add a
// second Facade so the ground floor can differ, and delete one again without
// severing the pipeline.

import assert from 'node:assert/strict'
import { compileBuilding } from '../../../building/compile.js'
import {
  createBuildingDoc, parseBuildingDoc, serializeBuildingDoc,
} from '../../../building/doc.js'
import { irDigest } from '../../../building/ir.js'
import {
  addWing, applyFix, canApplyFix, canMoveNode, createStarterGraph, ensureStarterGraph,
  insertNodeAfter, moveNode, moveNodeAfterType, orderedNodes, removeNode, resetPalette,
  setNodeMode,
  setNodeProp, setPaletteColor,
} from './edits.js'
import { CODE } from '../../../building/diagnostics.js'
import { normalizeBuildingDoc } from '../../../building/doc.js'
import { paletteOf } from '../../../building/stylepack.js'

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
  assert.deepEqual(chain(starter()), ['footprint', 'mass', 'facade', 'roof', 'output'])
  assert.equal(compileBuilding(starter()).ok, true)
})

// --- inserting --------------------------------------------------------------

test('inserting a Facade SPLICES it into the chain', () => {
  // mass -> facade -> output becomes mass -> facade -> facade -> output, with
  // nothing left dangling.
  const doc = starter()
  const next = insertNodeAfter(doc, idOf(doc, 'facade'), 'facade')
  assert.deepEqual(chain(next), ['footprint', 'mass', 'facade', 'facade', 'roof', 'output'])
  assert.equal(compileBuilding(next).ok, true)
})

test('the spliced node re-points what the source was feeding', () => {
  const doc = starter()
  const firstFacade = idOf(doc, 'facade')
  const next = insertNodeAfter(doc, idOf(doc, 'mass'), 'facade')
  // Whatever the Mass was feeding must now be fed by the NEW facade, not still
  // by the Mass.
  const feeding = next.edges.find(e => e.to.node === firstFacade)
  assert.equal(feeding.from.node, next.nodes[next.nodes.length - 1].id)
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
  assert.deepEqual(chain(next), ['footprint', 'mass', 'roof', 'output'])
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
  assert.deepEqual(chain(next), ['footprint', 'mass', 'facade', 'roof', 'output'])
  assert.equal(compileBuilding(next).ok, true)
})

test('removing the Mass does not heal across mismatched kinds', () => {
  // A footprint cannot feed an output: healing here would make an illegal edge,
  // so the chain is left broken and the compiler says so.
  const doc = starter()
  const next = removeNode(doc, idOf(doc, 'mass'))
  assert.equal(compileBuilding(next).ok, false)
  assert.equal(next.edges.some(e => e.from.node === idOf(next, 'footprint')
    && e.to.node === idOf(next, 'facade')), false)
})

// --- list order -------------------------------------------------------------

test('the node list reads in PIPELINE order, not creation order', () => {
  // An inserted node is appended to the array, so without this the second Facade
  // appeared after the Output in the list while the edges said otherwise - and
  // clicking the wrong row was then the obvious mistake.
  const base = starter()
  const doc = insertNodeAfter(base, idOf(base, 'facade'), 'facade')
  assert.deepEqual(orderedNodes(doc).map(n => n.type),
    ['footprint', 'mass', 'facade', 'facade', 'roof', 'output'])
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

// --- chained roofs ----------------------------------------------------------

test('a second Roof CONTINUES the first rather than replacing it', () => {
  // The temple: a stepped platform stopped at a deck, capped with a hip. If the
  // second node replaced the first, the extra node would silently do nothing -
  // which is what it did before, and the reason this test exists.
  let doc = starter()
  const first = idOf(doc, 'roof')
  doc = setNodeMode(doc, first, 'kind', 'stepped')
  doc = setNodeProp(doc, first, 'stepRun', 1)
  doc = setNodeProp(doc, first, 'stepRise', 0.8)
  doc = setNodeProp(doc, first, 'maxHeight', 2)

  const platform = compileBuilding(doc).ir.roofs[0]

  doc = insertNodeAfter(doc, first, 'roof')
  const second = doc.nodes.filter(n => n.type === 'roof')[1].id
  doc = setNodeMode(doc, second, 'kind', 'hip')
  doc = setNodeProp(doc, second, 'pitch', 40)

  const { ir, diagnostics } = compileBuilding(doc)
  assert.ok(ir.roofs[0].rungs.length > platform.rungs.length, 'the cap added no rungs')
  assert.ok(ir.roofs[0].height > platform.height, 'the cap added no height')
  assert.equal(ir.roofs[0].baseZ, platform.baseZ, 'the stack restarted instead of continuing')
  assert.equal(ir.roofs[0].kind, 'stacked')
  assert.ok(diagnostics.some(d => d.code === 'I_ROOF_STACKED'))
  // The platform's own rungs survive intact underneath.
  assert.deepEqual(ir.roofs[0].rungs.slice(0, platform.rungs.length), platform.rungs)
})

test('a roof on top of one that closed to a ridge is refused, not mangled', () => {
  // The starter roof is a hip with no height cap, so it runs to a ridge and
  // there is nothing left to stand on. Saying so beats building a sliver.
  let doc = starter()
  const before = compileBuilding(doc).ir.roofs[0]

  doc = insertNodeAfter(doc, idOf(doc, 'roof'), 'roof')
  const { ir, diagnostics } = compileBuilding(doc)

  assert.deepEqual(ir.roofs[0], before, 'the second roof changed the first')
  assert.ok(diagnostics.some(d => d.code === 'W_ROOF_ON_RIDGE'))
})

// --- trim and deform in the chain -------------------------------------------

test('a parapet on a pitched roof is reported, not silently drawn along the ridge', () => {
  // "I added a parapet and got a spine" is exactly the kind of result nobody can
  // explain from the picture alone.
  let doc = starter()
  doc = insertNodeAfter(doc, idOf(doc, 'roof'), 'trim')
  doc = setNodeMode(doc, idOf(doc, 'trim'), 'where', 'parapet')
  assert.ok(compileBuilding(doc).diagnostics.some(d => d.code === 'W_PARAPET_ON_PITCH'))

  // On a flat roof there is a real deck to stand on, so nothing is said.
  doc = setNodeMode(doc, idOf(doc, 'roof'), 'kind', 'flat')
  assert.equal(compileBuilding(doc).diagnostics.some(d => d.code === 'W_PARAPET_ON_PITCH'), false)
})

test('a string course with nowhere to go says so', () => {
  let doc = starter()
  doc = setNodeProp(doc, idOf(doc, 'mass'), 'levelCount', 1)
  doc = insertNodeAfter(doc, idOf(doc, 'roof'), 'trim')
  doc = setNodeMode(doc, idOf(doc, 'trim'), 'where', 'string')
  const result = compileBuilding(doc)
  assert.ok(result.diagnostics.some(d => d.code === 'W_TRIM_NO_RUNS'))
  assert.equal(result.ok, true, 'a missing band should not fail the build')
})

test('a Deform node bends the windows as well as the walls', () => {
  // The whole reason the warp is applied centrally: slots are stored transforms,
  // so a warp that moved the walls and not the slots would leave every window
  // floating beside the building it belongs to.
  let doc = starter()
  doc = setNodeProp(doc, idOf(doc, 'mass'), 'levelCount', 5)
  const before = compileBuilding(doc).ir

  doc = insertNodeAfter(doc, idOf(doc, 'roof'), 'deform')
  doc = setNodeMode(doc, idOf(doc, 'deform'), 'mode', 'lean')
  doc = setNodeProp(doc, idOf(doc, 'deform'), 'amount', 5)
  const after = compileBuilding(doc).ir

  assert.equal(after.slots.length, before.slots.length, 'the warp changed the facade')
  // The lean is proportional to HEIGHT, and a top-storey window sits at the
  // middle of its storey rather than at the roofline - so the expected shift is
  // 5m scaled by the window's own height over the building's, not a flat 5m.
  const top = ir => ir.slots.filter(s => s.floorIndex === 4)
  const height = Math.max(...after.levels.map(l => l.z1))
  const expected = 5 * (top(before)[0].transform[14] / height)
  const shift = top(after)[0].transform[12] - top(before)[0].transform[12]
  assert.ok(expected > 4, `the test picked a window at ${top(before)[0].transform[14]}m`)
  assert.ok(Math.abs(shift - expected) < 0.05,
    `the top storey's windows moved ${shift.toFixed(2)}m, expected ${expected.toFixed(2)}m`)
  // ...and the ground floor follows the SAME law, which is the point: a lean is
  // continuous in height, so a window 2m up moves a little and one 15m up moves
  // a lot. Only z = 0 exactly is pinned.
  const ground = ir => ir.slots.filter(s => s.floorIndex === 0)
  const groundExpected = 5 * (ground(before)[0].transform[14] / height)
  const groundShift = ground(after)[0].transform[12] - ground(before)[0].transform[12]
  assert.ok(Math.abs(groundShift - groundExpected) < 0.05,
    `the ground floor moved ${groundShift.toFixed(2)}m, expected ${groundExpected.toFixed(2)}m`)
  assert.ok(groundShift < shift / 3, 'the lean is not increasing with height')
})

test('a Deform set to None leaves the IR exactly as it was', () => {
  let doc = starter()
  const before = compileBuilding(doc).ir
  doc = insertNodeAfter(doc, idOf(doc, 'roof'), 'deform')
  doc = setNodeMode(doc, idOf(doc, 'deform'), 'mode', 'none')
  const after = compileBuilding(doc).ir
  assert.equal(after.deform, null)
  assert.equal(irDigest(after), irDigest(before))
})

test('trim and deform survive a round trip through the document', () => {
  let doc = starter()
  doc = insertNodeAfter(doc, idOf(doc, 'roof'), 'trim')
  doc = insertNodeAfter(doc, idOf(doc, 'trim'), 'deform')
  doc = setNodeProp(doc, idOf(doc, 'deform'), 'amount', 25)
  const reloaded = parseBuildingDoc(serializeBuildingDoc(doc))
  assert.equal(irDigest(compileBuilding(reloaded).ir), irDigest(compileBuilding(doc).ir))
})

// --- wings -------------------------------------------------------------------

test('Add Wing builds a whole second branch, not a dangling Merge', () => {
  // The reason this is an action rather than a palette entry for the Merge node:
  // splicing a Merge wires one input and leaves the other empty, which compiles
  // to an error and nothing else.
  const doc = addWing(createStarterGraph());
  const types = doc.nodes.map(node => node.type);
  assert.equal(types.filter(t => t === 'merge').length, 1);
  assert.equal(types.filter(t => t === 'footprint').length, 2);
  const result = compileBuilding(doc);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.ir.roofs.length, 2, 'the wing brought no roof of its own');
  assert.equal(result.ir.solids.length, 2, 'the wing is not its own solid');
});

test('a wing gets its own plan, clear of the ones already there', () => {
  // Two footprints occupying the same ground would be one building with doubled
  // walls, and indistinguishable in the plan editor.
  const doc = addWing(createStarterGraph());
  const plans = doc.nodes.filter(node => node.type === 'footprint')
    .map(node => node.props.shape.outer);
  const xsOf = ring => ring.map(p => p[0]);
  const a = xsOf(plans[0]);
  const b = xsOf(plans[1]);
  assert.ok(Math.min(...b) >= Math.max(...a), 'the wing overlaps the plan it joins');
});

test('wings chain, so a third volume is another Add Wing', () => {
  const doc = addWing(addWing(createStarterGraph()));
  const result = compileBuilding(doc);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.ir.roofs.length, 3);
  assert.equal(result.ir.solids.length, 3);
});

test('Add Wing on a document with no Output changes nothing', () => {
  const doc = { ...createStarterGraph() };
  doc.nodes = doc.nodes.filter(node => node.type !== 'output');
  assert.equal(addWing(doc).nodes.length, doc.nodes.length);
});

// --- moving a node along the chain -------------------------------------------
//
// Order is not cosmetic here: a Roof Detail reads the roof under it. Added in
// the wrong place it quietly places nothing, which is how a missing chimney was
// reported - and until this existed the only remedy was to delete everything
// downstream and re-add it.

const chainOf = doc => orderedNodes(doc).map(node => node.type).join(' > ')

test('a node moves later in the chain, and the edges follow', () => {
  let doc = createStarterGraph()
  const facade = doc.nodes.find(node => node.type === 'facade')
  doc = insertNodeAfter(doc, facade.id, 'roofitem')
  assert.equal(chainOf(doc), 'footprint > mass > facade > roofitem > roof > output')

  const item = doc.nodes.find(node => node.type === 'roofitem')
  doc = moveNode(doc, item.id, 1)
  assert.equal(chainOf(doc), 'footprint > mass > facade > roof > roofitem > output')
})

test('...and that is what makes the chimney appear', () => {
  // The user-visible point of the whole operation.
  let doc = createStarterGraph()
  const facade = doc.nodes.find(node => node.type === 'facade')
  doc = insertNodeAfter(doc, facade.id, 'roofitem')
  const before = compileBuilding(doc)
  assert.equal(before.ir.slots.filter(slot => slot.type === 'roof_item').length, 0)
  assert.ok(before.diagnostics.some(d => d.code === CODE.W_ROOF_ITEM_NO_ROOF))

  const item = doc.nodes.find(node => node.type === 'roofitem')
  const after = compileBuilding(moveNode(doc, item.id, 1))
  assert.equal(after.ir.slots.filter(slot => slot.type === 'roof_item').length, 1)
  assert.ok(!after.diagnostics.some(d => d.code === CODE.W_ROOF_ITEM_NO_ROOF))
})

test('the warning carries a one-click fix that does exactly that', () => {
  let doc = createStarterGraph()
  const facade = doc.nodes.find(node => node.type === 'facade')
  doc = insertNodeAfter(doc, facade.id, 'roofitem')
  const warning = compileBuilding(doc).diagnostics.find(d => d.code === CODE.W_ROOF_ITEM_NO_ROOF)
  assert.ok(canApplyFix(warning.fix), 'the fix is not applicable by this build')
  assert.equal(chainOf(applyFix(doc, warning.fix)),
    'footprint > mass > facade > roof > roofitem > output')
})

test('the one-click fix travels the whole way, not one place', () => {
  // The label says "Move it after the Roof". A single swap only achieves that
  // when the node happened to sit directly before the roof - from two places
  // away it left the warning standing and the button saying it had moved it.
  let doc = createStarterGraph()
  const mass = doc.nodes.find(node => node.type === 'mass')
  doc = insertNodeAfter(doc, mass.id, 'roofitem')
  assert.equal(chainOf(doc), 'footprint > mass > roofitem > facade > roof > output')

  const warning = compileBuilding(doc).diagnostics.find(d => d.code === CODE.W_ROOF_ITEM_NO_ROOF)
  const fixed = applyFix(doc, warning.fix)
  assert.equal(chainOf(fixed), 'footprint > mass > facade > roof > roofitem > output')
  assert.ok(!compileBuilding(fixed).diagnostics.some(d => d.code === CODE.W_ROOF_ITEM_NO_ROOF),
    'the warning survived its own fix')
})

test('moveNodeAfterType stops rather than spinning when it cannot succeed', () => {
  const doc = createStarterGraph()
  const mass = doc.nodes.find(node => node.type === 'mass')
  // There is no Trim to get behind, and a Mass cannot swap at all.
  assert.equal(chainOf(moveNodeAfterType(doc, mass.id, 'trim')), chainOf(doc))
})

test('the Output is listed last even when a Merge puts it mid-walk', () => {
  // The walk reaches the Output down the main chain before it has started on the
  // wing's Footprint, which read as "... Merge, Output, Footprint, Mass, Roof" -
  // an end in the middle of the list.
  const order = orderedNodes(addWing(createStarterGraph())).map(node => node.type)
  assert.equal(order[order.length - 1], 'output')
  assert.equal(order.filter(type => type === 'output').length, 1)
})

test('moving is reversible, and two moves travel two places', () => {
  let doc = createStarterGraph()
  const facade = doc.nodes.find(node => node.type === 'facade')
  doc = insertNodeAfter(doc, facade.id, 'trim')
  const trim = doc.nodes.find(node => node.type === 'trim')
  const original = chainOf(doc)
  const moved = moveNode(doc, trim.id, 1)
  assert.notEqual(chainOf(moved), original)
  assert.equal(chainOf(moveNode(moved, trim.id, -1)), original, 'the move did not reverse')

  // Two places, from the middle to the end.
  let far = moveNode(doc, trim.id, 1)
  far = moveNode(far, trim.id, 1)
  assert.equal(chainOf(far), 'footprint > mass > facade > roof > trim > output')
})

test('the ends of the chain do not move', () => {
  const doc = createStarterGraph()
  for (const type of ['footprint', 'output']) {
    const node = doc.nodes.find(candidate => candidate.type === type)
    assert.equal(canMoveNode(doc, node.id, -1), false, type)
    assert.equal(canMoveNode(doc, node.id, 1), false, type)
    assert.equal(chainOf(moveNode(doc, node.id, 1)), chainOf(doc))
  }
})

test('a Mass will not swap in either direction', () => {
  // The kinds have to survive the swap, and a Mass is the one node that takes a
  // SHAPE: swapping it earlier would plug a Building into the Footprint's place,
  // and swapping it later would plug a Shape into the Facade's Building port.
  // Both are graphs the compiler rejects, so neither move is offered.
  const doc = createStarterGraph()
  const mass = doc.nodes.find(node => node.type === 'mass')
  assert.equal(canMoveNode(doc, mass.id, -1), false)
  assert.equal(canMoveNode(doc, mass.id, 1), false)
  // The nodes downstream of it move freely.
  const facade = doc.nodes.find(node => node.type === 'facade')
  assert.equal(canMoveNode(doc, facade.id, 1), true)
})

test('a branch refuses to move rather than guessing', () => {
  // A Merge has two building inputs, so "the previous node" has no answer, and
  // picking one would silently rewire a wing into the wrong hall.
  const doc = addWing(createStarterGraph())
  const merge = doc.nodes.find(node => node.type === 'merge')
  assert.equal(canMoveNode(doc, merge.id, -1), false)
  assert.equal(canMoveNode(doc, merge.id, 1), false)
  assert.equal(chainOf(moveNode(doc, merge.id, -1)), chainOf(doc))
})

test('a moved graph still compiles', () => {
  let doc = createStarterGraph()
  const mass = doc.nodes.find(node => node.type === 'mass')
  doc = insertNodeAfter(doc, mass.id, 'trim')
  const trim = doc.nodes.find(node => node.type === 'trim')
  const moved = moveNode(moveNode(doc, trim.id, 1), trim.id, 1)
  const result = compileBuilding(moved)
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
})

// --- the palette -------------------------------------------------------------
//
// Every surface takes its colour from one of six slots, and until this existed
// the only way to set them was to apply a style pack - so "the timbers are the
// wrong brown" had no answer short of editing a file on disk.

test('a colour set on the document reaches the compiled building', () => {
  const doc = setPaletteColor(createStarterGraph(), 'trim', '#4A3526')
  assert.equal(paletteOf(doc).trim, '#4a3526', 'stored, but not lower-cased')
  const trim = compileBuilding(doc).ir.materials.find(entry => entry.slot === 'trim')
  assert.equal(trim.color, '#4a3526')
})

test('it works with no style pack applied, which is the case that needed it', () => {
  const doc = normalizeBuildingDoc(createStarterGraph())
  assert.equal(doc.building.style, null, 'a starter document should carry no style')
  assert.equal(paletteOf(setPaletteColor(doc, 'wall', '#112233')).wall, '#112233')
})

test('a bad slot or a bad colour changes nothing', () => {
  const doc = setPaletteColor(createStarterGraph(), 'trim', '#4a3526')
  for (const [slot, value] of [['notaslot', '#000000'], ['wall', 'red'], ['wall', ''], ['roof', '#ff']]) {
    assert.deepEqual(setPaletteColor(doc, slot, value).building.style.palette, { trim: '#4a3526' })
  }
})

test('reset drops the colours and keeps the style name', () => {
  let doc = createStarterGraph()
  doc = {
    ...doc,
    building: { ...doc.building, style: { name: 'Roman Villa', palette: { trim: '#4a3526' } } },
  }
  const back = resetPalette(doc)
  assert.equal(back.building.style.name, 'Roman Villa')
  assert.deepEqual(back.building.style.palette, {})
  // ...and with no name there is nothing left to keep.
  assert.equal(resetPalette(setPaletteColor(createStarterGraph(), 'trim', '#123456'))
    .building.style, null)
})

test('a colour change does not disturb the geometry', () => {
  // It is a material, and recompiling should not move a wall. Derived from ONE
  // document: node ids are minted fresh per createStarterGraph() call and a
  // slot's seed is hashed from the node that emitted it, so two starter graphs
  // legitimately differ in every seedKey.
  const doc = normalizeBuildingDoc(createStarterGraph())
  const plain = compileBuilding(doc).ir
  const painted = compileBuilding(setPaletteColor(doc, 'wall', '#a0b0c0')).ir
  assert.deepEqual(painted.polygons, plain.polygons)
  assert.deepEqual(painted.slots, plain.slots)
  assert.notEqual(
    painted.materials.find(m => m.slot === 'wall').color,
    plain.materials.find(m => m.slot === 'wall').color,
  )
})

if (process.exitCode) console.error(`\n${passed} passed, failures above.`)
else console.log(`edits.test.mjs: ${passed} passed`)
