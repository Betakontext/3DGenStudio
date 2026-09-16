// node src/utils/building/textureRows.test.mjs
//
// The rows the inspector draws. Pure, and worth testing on its own because a row
// that is missing looks exactly like a feature that does not exist - which is
// how the balcony model slot was reported as absent when it was only hidden.

import assert from 'node:assert/strict'
import { appendReference, createBuildingDoc } from '../../../building/doc.js'
import {
  FACADE_BALCONY_SLOT, FACADE_MESH_SLOT, FACADE_POST_SLOT, nodeTextureKey,
} from '../../../building/stylepack.js'
import { SIDE_ORDER } from '../../../building/sides.js'
import {
  buildingTextureRows, facadeMeshRows, facadeTextureRows, hasSideOverrides,
  slotMeshRows, trimTextureRows,
} from './textureRows.js'

let passed = 0
function test(name, fn) {
  try { fn(); passed++ }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1 }
}

const doc = () => createBuildingDoc({})
const labels = rows => rows.map(row => row.label)

// --- the facade's two model slots -------------------------------------------

test('a facade offers a model slot for EACH thing it places', () => {
  // Reported twice, in two shapes. First: "I cannot select a Window and a
  // Balcony for a Facade/Side, I only have an option to select a mesh" - hiding
  // a slot when its mode is off reads as the feature not existing. Then: "the
  // Posts use the same mesh as the window" - a post with no slot of its own fell
  // through to the openings' chain and wore the window model.
  const rows = facadeMeshRows(doc(), 'fc')
  assert.deepEqual(labels(rows), ['Opening model', 'Balcony model', 'Post model'])
})

test('the balcony row is there whether or not this facade places balconies', () => {
  for (const balconies of [false, true]) {
    const rows = facadeMeshRows(doc(), 'fc', { balconies })
    assert.ok(rows.some(row => row.label === 'Balcony model'),
      `balconies:${balconies} lost the row`)
  }
})

test('an idle balcony slot SAYS it is idle, bound or not', () => {
  // `fallback` speaks only for an empty row, so a model bound into a slot the
  // graph never places would show a name and change nothing. `warn` covers both.
  const off = facadeMeshRows(doc(), 'fc', { balconies: false })
    .find(row => row.label === 'Balcony model')
  assert.ok(off.warn && /Balconies/.test(off.warn), `warn was ${JSON.stringify(off.warn)}`)

  const on = facadeMeshRows(doc(), 'fc', { balconies: true })
    .find(row => row.label === 'Balcony model')
  assert.ok(!on.warn, 'a facade that does place balconies is being warned about them')
})

test('every model group gets the same four per-side rows when expanded', () => {
  const rows = facadeMeshRows(doc(), 'fc', { expanded: true, balconies: true, posts: true })
  // Three groups of five: the group row, then north/east/south/west.
  assert.equal(rows.length, 15)
  const keys = rows.map(row => row.refKey)
  for (const slot of [FACADE_MESH_SLOT, FACADE_BALCONY_SLOT, FACADE_POST_SLOT]) {
    assert.ok(keys.includes(nodeTextureKey('fc', slot)), `${slot} has no group row`)
    for (const side of SIDE_ORDER) {
      assert.ok(keys.includes(nodeTextureKey('fc', slot, side)), `${slot} has no ${side} row`)
    }
  }
})

test('the two models write DIFFERENT reference keys', () => {
  // Sharing one list would roll a balustrade into the hole and a window onto
  // the bracket - the whole reason FACADE_BALCONY_SLOT is a second slot.
  const rows = facadeMeshRows(doc(), 'fc', { expanded: true, balconies: true, posts: true })
  assert.equal(new Set(rows.map(row => row.refKey)).size, rows.length)
})

test('every model row asks the library for a MESH, not an image', () => {
  const rows = facadeMeshRows(doc(), 'fc', { expanded: true, balconies: true, posts: true })
  assert.ok(rows.every(row => row.assetType === 'mesh'))
})

test('a side row says it inherits from this facade once the facade itself is bound', () => {
  let d = doc()
  const idle = facadeMeshRows(d, 'fc', { expanded: true, balconies: true, posts: true })
    .filter(row => row.indent)
  assert.ok(idle.every(row => row.fallback === 'same as the building'
    || row.fallback === 'nothing to place yet'))

  d = appendReference(d, nodeTextureKey('fc', FACADE_BALCONY_SLOT), { kind: 'mesh', ref: 'asset:1' })
  const bound = facadeMeshRows(d, 'fc', { expanded: true, balconies: true, posts: true })
  const north = bound.find(row => row.refKey === nodeTextureKey('fc', FACADE_BALCONY_SLOT, 'north'))
  assert.equal(north.fallback, 'same as this facade')
})

// --- the other scopes, unchanged but worth pinning --------------------------

test('a balcony binding on one side counts as a side override', () => {
  // Or the sides panel would collapse over a binding the author cannot then see.
  let d = doc()
  assert.equal(hasSideOverrides(d, 'fc'), false)
  d = appendReference(d, nodeTextureKey('fc', FACADE_BALCONY_SLOT, 'north'),
    { kind: 'mesh', ref: 'asset:1' })
  assert.equal(hasSideOverrides(d, 'fc'), true)
})

test('every building-wide model row is LABELLED, not shown as its raw tag', () => {
  // The roof items and the post were added to MESH_SLOTS without labels and
  // appeared in the sidebar as "chimney", "finial", "vent", "crest", "pillar"
  // among properly-cased rows.
  const rows = slotMeshRows()
  assert.ok(labels(rows).includes('Balcony'))
  for (const row of rows) {
    assert.ok(/^[A-Z]/.test(row.label),
      `"${row.label}" is the raw tag rather than a label`)
  }
  // ...and each points at a guide that exists, or the picker has no hint and the
  // AI panel no prompt.
  assert.ok(rows.every(row => ['opening', 'door', 'trim', 'pillar'].includes(row.guideSlot)),
    `guide slots were ${[...new Set(rows.map(r => r.guideSlot))]}`)
})

test('the building and facade texture rows are untouched by any of this', () => {
  assert.ok(labels(buildingTextureRows()).length > 0)
  // Three now: wall, opening and the post slot a colonnade needed.
  assert.equal(labels(facadeTextureRows(doc(), 'fc')).length, 3)
  assert.equal(labels(trimTextureRows(doc(), 'tr')).length, 1)
})

if (process.exitCode) console.error(`\n${passed} passed, failures above.`)
else console.log(`textureRows.test.mjs: ${passed} passed`)
