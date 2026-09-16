// node src/utils/building/meshNormalise.test.mjs
//
// The unit-mesh contract, and the turn that has to happen before it. A balcony
// exported lying down needs a quarter turn, and the ORDER of the turn and the
// fit is the whole of what makes that work.

import assert from 'node:assert/strict'
import * as THREE from 'three'
import { normalise } from './meshNormalise.js'

let passed = 0
function test(name, fn) {
  try { fn(); passed++ }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1 }
}

/** A scene holding one box of the given size, centred away from the origin. */
function sceneOf(x, y, z, at = [5, 6, 7]) {
  const scene = new THREE.Scene()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(x, y, z), new THREE.MeshStandardMaterial())
  mesh.position.set(at[0], at[1], at[2])
  scene.add(mesh)
  scene.updateMatrixWorld(true)
  return scene
}

const sizeOf = geometry => {
  geometry.computeBoundingBox()
  const size = new THREE.Vector3()
  geometry.boundingBox.getSize(size)
  return [size.x, size.y, size.z].map(v => Math.round(v * 1000) / 1000)
}
const centreOf = geometry => {
  geometry.computeBoundingBox()
  const centre = new THREE.Vector3()
  geometry.boundingBox.getCenter(centre)
  return [centre.x, centre.y, centre.z].map(v => Math.round(v * 1000) / 1000)
}

test('a model is normalised into a UNIT box centred on the origin', () => {
  // The contract every slot mesh relies on: whatever a model's own dimensions
  // and origin are, the instance transform is the only thing that decides how
  // big it ends up and where.
  const { geometry } = normalise(sceneOf(3, 0.4, 7))
  assert.deepEqual(sizeOf(geometry), [1, 1, 1])
  assert.deepEqual(centreOf(geometry), [0, 0, 0])
})

test('no rotation leaves the model exactly as it was', () => {
  const plain = normalise(sceneOf(2, 0.5, 2))
  for (const rotation of [null, [], [0, 0, 0]]) {
    const turned = normalise(sceneOf(2, 0.5, 2), rotation)
    assert.deepEqual(sizeOf(turned.geometry), sizeOf(plain.geometry), JSON.stringify(rotation))
  }
})

test('the TURN HAPPENS FIRST, so the unit box measures the TURNED model', () => {
  // The whole point, and silently wrong if the order were reversed. A 90-degree
  // turn cannot show it - a unit cube turned a quarter is still a unit cube, and
  // the first version of this test proved nothing for exactly that reason. 45
  // degrees does: fitting first and turning second leaves the box sqrt(2) across
  // its turned axes, while turning first and fitting second is a unit box by
  // construction, whatever the angle.
  const { geometry } = normalise(sceneOf(4, 1, 2), [45, 0, 0])
  assert.deepEqual(sizeOf(geometry), [1, 1, 1],
    'the model was fitted before it was turned - it will arrive the wrong shape')
})

test('a quarter turn about X swaps which way the model faces', () => {
  // Measured on the geometry rather than on a bounding box, which a symmetric
  // box cannot distinguish: put a marker vertex far out on +Y and see where it
  // lands. 90 degrees about X takes +Y to +Z.
  const scene = new THREE.Scene()
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 10, 0,
  ], 3))
  geometry.computeVertexNormals()
  scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()))
  scene.updateMatrixWorld(true)

  const turned = normalise(scene, [90, 0, 0])
  const array = turned.geometry.getAttribute('position').array
  // The marker was the extreme in Y; after the turn it is the extreme in Z.
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < array.length; i += 3) {
    maxY = Math.max(maxY, array[i + 1])
    maxZ = Math.max(maxZ, array[i + 2])
  }
  assert.ok(maxZ > 0.4, `the marker did not move into Z (max ${maxZ.toFixed(3)})`)
  assert.ok(maxY < 0.4, `the marker is still in Y (max ${maxY.toFixed(3)})`)
})

test('an empty scene yields null rather than throwing', () => {
  assert.equal(normalise(new THREE.Scene()), null)
  assert.equal(normalise(new THREE.Scene(), [90, 0, 0]), null)
})

test('the model keeps its own material, and the textured one wins', () => {
  const scene = new THREE.Scene()
  const plain = new THREE.MeshStandardMaterial({ name: 'plain' })
  const textured = new THREE.MeshStandardMaterial({ name: 'textured' })
  textured.map = new THREE.Texture()
  const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), plain)
  const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), textured)
  b.position.x = 2
  scene.add(a, b)
  scene.updateMatrixWorld(true)
  assert.equal(normalise(scene).material.name, 'textured')
})

if (process.exitCode) console.error(`\n${passed} passed, failures above.`)
else console.log(`meshNormalise.test.mjs: ${passed} passed`)
