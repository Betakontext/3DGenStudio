// node src/utils/building/materials.test.mjs
//
// One rule, and it was wrong for most of this feature's life: a TEXTURE IS THE
// SURFACE, and the palette colour is what a slot shows without one.

import assert from 'node:assert/strict'
import * as THREE from 'three'
import { buildMaterials, disposeMaterials } from './materials.js'

let passed = 0
function test(name, fn) {
  try { fn(); passed++ }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1 }
}

const irOf = materials => ({ materials })
const texture = () => new THREE.Texture()

test('an UNTEXTURED slot draws its palette colour', () => {
  const materials = buildMaterials(irOf([{ slot: 'wall', color: '#c9cdd4' }]), {})
  assert.equal(materials[0].color.getHexString(), 'c9cdd4')
  assert.equal(materials[0].map, null)
  disposeMaterials(materials)
})

test('a TEXTURED slot draws the texture, not the texture times the colour', () => {
  // The bug as reported: a window texture bound to a facade rendered black. The
  // material multiplied the map by the slot colour, and the OPENING slot's
  // colour is a near-black stand-in for glass - so any texture bound there was
  // destroyed. On the wall slot the same rule cost about 20% and read as flat
  // lighting, which is why it went unnoticed.
  const materials = buildMaterials(irOf([{ slot: 'opening', color: '#2f3a44' }]), { 0: texture() })
  assert.equal(materials[0].color.getHexString(), 'ffffff',
    'the map is being multiplied by the slot colour - a dark slot eats its texture')
  assert.ok(materials[0].map)
  disposeMaterials(materials)
})

test('the rule holds for every slot, not just the dark one', () => {
  const ir = irOf([
    { slot: 'wall', color: '#c9cdd4' },
    { slot: 'roof', color: '#8e7a6b' },
    { slot: 'opening', color: '#2f3a44' },
    { slot: 'door', color: '#7a6248' },
  ])
  // Map on the roof and the door only: the other two keep their colours.
  const materials = buildMaterials(ir, { 1: texture(), 3: texture() })
  assert.equal(materials[0].color.getHexString(), 'c9cdd4')
  assert.equal(materials[1].color.getHexString(), 'ffffff')
  assert.equal(materials[2].color.getHexString(), '2f3a44')
  assert.equal(materials[3].color.getHexString(), 'ffffff')
  disposeMaterials(materials)
})

test('a per-side override is its own material, textured independently', () => {
  // The shape the reported bug arrived in: Windows bound on the north side only.
  const materials = buildMaterials(irOf([
    { slot: 'opening', color: '#2f3a44', side: '' },
    { slot: 'opening', color: '#2f3a44', side: 'north', ref: 'asset:77' },
  ]), { 1: texture() })
  assert.equal(materials[0].color.getHexString(), '2f3a44', 'the other sides lost their colour')
  assert.equal(materials[1].color.getHexString(), 'ffffff', 'the north side did not take its texture')
  disposeMaterials(materials)
})

test('surface finish still comes from the SLOT, textured or not', () => {
  // An override changes what a surface is made of, not whether it is a wall.
  const plain = buildMaterials(irOf([{ slot: 'wall', color: '#c9cdd4' }]), {})
  const mapped = buildMaterials(irOf([{ slot: 'wall', color: '#c9cdd4' }]), { 0: texture() })
  assert.equal(mapped[0].roughness, plain[0].roughness)
  assert.equal(mapped[0].metalness, plain[0].metalness)
  disposeMaterials(plain)
  disposeMaterials(mapped)
})

// --- alpha ------------------------------------------------------------------

test('a textured OPENING honours the image alpha', () => {
  // A window PNG is one object on a transparent ground. Without this the ground
  // draws as a black rectangle round the arch, which is how it was reported.
  const materials = buildMaterials(irOf([{ slot: 'opening', color: '#2f3a44' }]), { 0: texture() })
  assert.equal(materials[0].transparent, true)
  assert.ok(materials[0].alphaTest > 0, 'no alphaTest - the transparent ground still draws')
  assert.ok(materials[0].alphaTest < 0.2,
    'the threshold is too high - faint glass would snap away')
  // Discarding is what keeps the cut-out corners out of the depth buffer, and
  // depth writes are what stop a far window drawing over a near wall.
  assert.equal(materials[0].depthWrite, true)
  disposeMaterials(materials)
})

test('a DOOR gets the same treatment, and a WALL does not', () => {
  const ir = irOf([
    { slot: 'door', color: '#7a6248' },
    { slot: 'wall', color: '#c9cdd4' },
    { slot: 'roof', color: '#8e7a6b' },
  ])
  const materials = buildMaterials(ir, { 0: texture(), 1: texture(), 2: texture() })
  assert.equal(materials[0].transparent, true, 'a door should cut out')
  // A wall or a roof is a MATERIAL filling a surface; alpha there would punch
  // holes in the building for no reason anyone asked for.
  assert.equal(materials[1].transparent, false, 'a wall should stay opaque')
  assert.equal(materials[2].transparent, false, 'a roof should stay opaque')
  disposeMaterials(materials)
})

test('an UNTEXTURED opening stays opaque', () => {
  // Nothing to be transparent about, and a transparent material costs a sort.
  const materials = buildMaterials(irOf([{ slot: 'opening', color: '#2f3a44' }]), {})
  assert.equal(materials[0].transparent, false)
  assert.equal(materials[0].alphaTest, 0)
  disposeMaterials(materials)
})

if (process.exitCode) console.error(`\n${passed} passed, failures above.`)
else console.log(`materials.test.mjs: ${passed} passed`)
