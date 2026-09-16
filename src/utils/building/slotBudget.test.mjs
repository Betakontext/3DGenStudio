// node src/utils/building/slotBudget.test.mjs
//
// The rule these pin: a slot model costs `triangles x instances`, and only the
// grammar knows the second number. Runs headless - three's geometry classes need
// no WebGL context, and meshoptimizer's simplifier is wasm with no DOM in it.

import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  MIN_SLOT_TRIANGLES, SLOT_TRIANGLE_BUDGET,
  simplifyToBudget, slotUsage, targetTriangles, triangleCount,
} from './slotBudget.js'

let passed = 0
function test(name, fn) {
  try { const r = fn(); if (r?.then) return r.then(() => { passed++ }, err => {
    console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1
  }); passed++ }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1 }
  return Promise.resolve()
}

const slot = (meshSlot, variant) => ({ meshSlot, variant })

await test('usage is counted per (list, variant), the way the draw groups are', () => {
  // It has to match how buildSlotInstances keys a group, or the budget is
  // computed for a different set of instances than the one that shares the
  // geometry - which would be an answer that is wrong in both directions.
  const ir = {
    slots: [
      slot('mesh_window', 0), slot('mesh_window', 0), slot('mesh_window', 1),
      slot('fc1.openingMesh.north', 0),
      { type: 'window' },
    ],
  }
  const usage = slotUsage(ir)
  assert.equal(usage.get('mesh_window#0'), 2)
  assert.equal(usage.get('mesh_window#1'), 1)
  assert.equal(usage.get('fc1.openingMesh.north#0'), 1)
  assert.equal(usage.size, 3, 'a slot with no model was counted')
})

await test('the allowance is the budget divided by how often it is drawn', () => {
  assert.equal(targetTriangles(40, 1_200_000), 30_000)
  assert.equal(targetTriangles(1808, 1_200_000), Math.floor(1_200_000 / 1808))
  // A model nothing places costs nothing to keep whole.
  assert.equal(targetTriangles(0), Infinity)
  // ...and there is a floor, because past a point a simplifier stops removing
  // detail and starts removing the object.
  assert.equal(targetTriangles(1_000_000, 1_200_000), MIN_SLOT_TRIANGLES)
  // The shipped budget leaves an ordinary building alone: a cottage's forty
  // windows may each be 30,000 triangles, which is more than any generated
  // window is.
  assert.ok(targetTriangles(40, SLOT_TRIANGLE_BUDGET) >= 25_000)
})

await test('a NON-INDEXED model is welded before it is simplified', async () => {
  // This is the whole test. `normalise` hands over a non-indexed geometry -
  // every triangle carrying its own three vertices - and a simplifier cannot
  // collapse an edge whose two halves it has no way to know are the same edge.
  // Without the weld this returns the geometry at full size and reports success,
  // which is indistinguishable from "the model was already small enough".
  const source = new THREE.SphereGeometry(1, 48, 32).toNonIndexed()
  const before = triangleCount(source)
  assert.ok(before > 2000, `the fixture is only ${before} triangles`)
  assert.equal(source.index, null, 'the fixture is indexed, so it proves nothing')

  const out = await simplifyToBudget(source, 400)
  assert.notEqual(out, source, 'the geometry came back untouched')
  const after = triangleCount(out)
  assert.ok(after <= 400, `${before} -> ${after}, over the 400 asked for`)
  assert.ok(after > 50, `${after} triangles left - that is not a sphere any more`)
  // The attributes every consumer needs have to survive: an InstancedMesh with
  // no uv draws the model untextured, which looks like a different bug.
  for (const name of ['position', 'normal', 'uv']) {
    assert.ok(out.getAttribute(name), `${name} was lost`)
  }
  // AND THE DEAD VERTICES ARE GONE. Simplifying rewrites only the index, so
  // without a compaction pass the geometry still carries every original vertex
  // with nothing referencing it. The preview cannot see that - it uploads the
  // geometry once - but the exporter clones it per instance, and 1,808 fins
  // carrying eight thousand dead vertices each is what stopped the export dead.
  const vertices = out.getAttribute('position').count
  assert.ok(vertices <= 400 * 3,
    `${vertices} vertices for ${after} triangles - the unused ones were kept`)
  assert.ok(vertices < source.getAttribute('position').count / 2,
    'the vertex buffer did not shrink at all')
  out.dispose()
  source.dispose()
})

await test('a model already under its allowance is returned untouched', async () => {
  // Returned as the SAME OBJECT, because that is how the caller knows whether it
  // owns a new geometry to dispose - and disposing the loader's own geometry
  // would empty every opening on the next frame.
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  assert.equal(await simplifyToBudget(geometry, 400), geometry)
  assert.equal(await simplifyToBudget(geometry, Infinity), geometry)
  geometry.dispose()
})

/** Bounding box and total surface area of an indexed or non-indexed geometry. */
function shapeOf(geometry) {
  const position = geometry.getAttribute('position')
  const index = geometry.index
  const count = index ? index.count : position.count
  const at = i => {
    const v = index ? index.getX(i) : i
    return [position.getX(v), position.getY(v), position.getZ(v)]
  }
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let area = 0
  for (let i = 0; i < count; i += 3) {
    const a = at(i), b = at(i + 1), c = at(i + 2)
    for (const p of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k]
        if (p[k] > max[k]) max[k] = p[k]
      }
    }
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    area += 0.5 * Math.hypot(
      u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0],
    )
  }
  return { min, max, area }
}

await test('a simplified model is still the SAME SHAPE, not just the same size', async () => {
  // The test I should have written first. The counts stayed exactly right while
  // the geometry was shrapnel: meshopt's compactMesh rewrites the index array
  // IN PLACE and also returns the remap, and applying that remap to the indices
  // as well made every one of them remap[remap[i]] - still a valid vertex, still
  // the right triangle count, still the right vertex count, and a completely
  // different object. Every assertion about SIZE passed. Only the shape catches
  // it, so: the silhouette must not move and the surface must not fold up.
  const source = new THREE.SphereGeometry(1, 48, 32).toNonIndexed()
  const before = shapeOf(source)
  const out = await simplifyToBudget(source, 400)
  const after = shapeOf(out)

  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(after.min[k] - before.min[k]) < 0.06,
      `axis ${k}: min moved ${before.min[k].toFixed(3)} -> ${after.min[k].toFixed(3)}`)
    assert.ok(Math.abs(after.max[k] - before.max[k]) < 0.06,
      `axis ${k}: max moved ${before.max[k].toFixed(3)} -> ${after.max[k].toFixed(3)}`)
  }
  // A sphere of radius 1 has area 4pi ~ 12.57; a 400-triangle hull of it loses a
  // few percent and nothing more. A scrambled index sends triangles clean across
  // the middle and the area runs away.
  const ratio = after.area / before.area
  assert.ok(ratio > 0.9 && ratio < 1.1,
    `surface area went ${before.area.toFixed(2)} -> ${after.area.toFixed(2)} (x${ratio.toFixed(2)})`)
  // And no triangle may reference a vertex that is not there.
  const vertices = out.getAttribute('position').count
  for (let i = 0; i < out.index.count; i++) {
    assert.ok(out.index.getX(i) < vertices, `index ${out.index.getX(i)} of ${vertices}`)
  }
  out.dispose()
  source.dispose()
})

if (process.exitCode) console.error(`\n${passed} passed, failures above.`)
else console.log(`slotBudget.test.mjs: ${passed} passed`)
