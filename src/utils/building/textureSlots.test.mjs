// node src/utils/building/textureSlots.test.mjs
//
// Two kinds of surface, and treating them alike put a corner of a window texture
// in every opening.

import assert from 'node:assert/strict'
import { CELL_SLOTS, SLOT_GUIDE, tilesByMetres } from './textureSlots.js'

let passed = 0
function test(name, fn) {
  try { fn(); passed++ }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1 }
}

test('a wall, a roof and a trim run tile by metres', () => {
  // They are UV-mapped in metres by the mesher, which is what makes brickwork
  // the same size on a cottage and on a tower.
  for (const slot of ['wall', 'roof', 'trim', 'accent']) {
    assert.equal(tilesByMetres(slot), true, slot)
  }
})

test('an opening and a door FILL their cell instead', () => {
  // They are one window and one door drawn on an instanced unit box whose UVs
  // run 0..1 across the hole. Repeating at a 1.5m tile shows the bottom-left two
  // thirds of the image and nothing else - exactly how this was reported.
  for (const slot of ['opening', 'door']) {
    assert.equal(tilesByMetres(slot), false, slot)
    assert.ok(CELL_SLOTS.has(slot))
  }
})

test('an unknown slot tiles, because that is the safer default', () => {
  // A new surface is far more likely to be a material than a single object, and
  // tiling a decal is a visible mistake where filling a material is a subtle one.
  assert.equal(tilesByMetres('somethingNew'), true)
  assert.equal(tilesByMetres(''), true)
})

test('every cell slot still carries a guide, so the AI panel can steer it', () => {
  // The tile size in the guide stops driving the repeat, but it still seeds the
  // reference entry and the generator's prompt.
  for (const slot of CELL_SLOTS) {
    assert.ok(SLOT_GUIDE[slot], `${slot} has no guide`)
    assert.ok(SLOT_GUIDE[slot].prompts.length > 0)
  }
})

if (process.exitCode) console.error(`\n${passed} passed, failures above.`)
else console.log(`textureSlots.test.mjs: ${passed} passed`)
