// node src/utils/building/mesh.test.mjs
//
// Winding and normal direction are the two things here that look fine in a
// screenshot and wrong the moment the model is lit or imported into an engine,
// so they are asserted rather than eyeballed. Runs headless: three's geometry
// classes need no WebGL context.

import assert from 'node:assert/strict'
import * as THREE from 'three'
import { compileBuilding } from '../../../building/compile.js'
import { createNode } from '../../../building/catalog.js'
import { normalizeBuildingDoc } from '../../../building/doc.js'
import { MASS_PROFILE } from '../../../building/mass.js'
import { buildBuildingGeometry, buildLevelOutlines, buildingBounds, toThree } from './mesh.js'

let passed = 0
function test(name, fn) {
  try { fn(); passed++ }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1 }
}

function graph({ shape, mass } = {}) {
  const fp = createNode('footprint', 'fp')
  if (shape) fp.props.shape = shape
  const ms = createNode('mass', 'ms')
  Object.assign(ms.props, mass?.props || {})
  Object.assign(ms.modes, mass?.modes || {})
  return normalizeBuildingDoc({
    nodes: [fp, ms, createNode('output', 'out')],
    edges: [
      { from: { node: 'fp', port: 'out' }, to: { node: 'ms', port: 'shape' } },
      { from: { node: 'ms', port: 'out' }, to: { node: 'out', port: 'building' } },
    ],
  })
}

const SQUARE = { outer: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [] }
const COURTYARD = {
  outer: [[0, 0], [30, 0], [30, 30], [0, 30]],
  holes: [[[10, 10], [10, 20], [20, 20], [20, 10]]],
}

// Every triangle, as {a, b, c, normal, centroid}.
function triangles(geometry) {
  const pos = geometry.getAttribute('position')
  const nor = geometry.getAttribute('normal')
  const out = []
  for (let i = 0; i < pos.count; i += 3) {
    const p = k => [pos.getX(k), pos.getY(k), pos.getZ(k)]
    const a = p(i), b = p(i + 1), c = p(i + 2)
    out.push({
      a, b, c,
      normal: [nor.getX(i), nor.getY(i), nor.getZ(i)],
      centroid: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3],
    })
  }
  return out
}

// The geometric normal implied by the vertex winding, independent of the stored
// normal attribute. If the two disagree, the model lights wrong.
function windingNormal(t) {
  const u = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]]
  const v = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]]
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  const len = Math.hypot(...n) || 1
  return [n[0] / len, n[1] / len, n[2] / len]
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// --- the axis swap ----------------------------------------------------------

test('toThree maps Z-up plan coordinates to Y-up world coordinates', () => {
  // Compared numerically rather than with deepEqual: negating a zero y gives -0,
  // which deepEqual treats as a different value and JSON.stringify writes as 0.
  const same = (got, want, why) => {
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(got[i] - want[i]) < 1e-12, `${why}: ${got}`)
  }
  same(toThree(0, 0, 0), [0, 0, 0], 'origin')
  same(toThree(1, 0, 0), [1, 0, 0], 'east stays east')
  same(toThree(0, 0, 1), [0, 1, 0], 'up becomes up')
  same(toThree(0, 1, 0), [0, 0, -1], 'north becomes -Z')
})

test('the axis swap PRESERVES orientation', () => {
  // A single flipped axis would mirror the building and invert every face - the
  // failure that looks right until it is lit.
  const ex = toThree(1, 0, 0)
  const ey = toThree(0, 1, 0)
  const ez = toThree(0, 0, 1)
  // Determinant of the basis matrix; positive means handedness is kept.
  const det = ex[0] * (ey[1] * ez[2] - ey[2] * ez[1])
            - ex[1] * (ey[0] * ez[2] - ey[2] * ez[0])
            + ex[2] * (ey[0] * ez[1] - ey[1] * ez[0])
  assert.equal(det, 1)
})

// --- a simple box -----------------------------------------------------------

test('a one-storey box has walls and two caps', () => {
  const ir = compileBuilding(graph({ shape: SQUARE, mass: { props: { levelCount: 1 } } })).ir
  const { geometry, triangleCount } = buildBuildingGeometry(ir)
  assert.ok(geometry)
  // 4 walls x 2 triangles + 2 caps x 2 triangles.
  assert.equal(triangleCount, 12)
  assert.equal(geometry.getAttribute('position').count, 36)
  assert.ok(geometry.getAttribute('normal'))
  assert.ok(geometry.getAttribute('uv'))
})

test('every stored normal agrees with its triangle winding', () => {
  // If these disagree the model is lit by one orientation and culled by the
  // other, which reads as randomly missing faces.
  const ir = compileBuilding(graph({ shape: SQUARE, mass: { props: { levelCount: 2 } } })).ir
  const { geometry } = buildBuildingGeometry(ir)
  for (const t of triangles(geometry)) {
    const w = windingNormal(t)
    assert.ok(dot(w, t.normal) > 0.99,
      `winding ${JSON.stringify(w.map(n => +n.toFixed(2)))} vs normal ${JSON.stringify(t.normal)}`)
  }
})

test('every wall normal points AWAY from the building centre', () => {
  const ir = compileBuilding(graph({ shape: SQUARE, mass: { props: { levelCount: 1 } } })).ir
  const { geometry } = buildBuildingGeometry(ir)
  const centre = [5, 0, -5] // the square's middle, in three space
  let walls = 0
  for (const t of triangles(geometry)) {
    if (Math.abs(t.normal[1]) > 0.5) continue // a cap, not a wall
    walls++
    const outward = [t.centroid[0] - centre[0], 0, t.centroid[2] - centre[2]]
    assert.ok(dot(outward, t.normal) > 0, `an inward-facing wall at ${t.centroid}`)
  }
  assert.equal(walls, 8)
})

test('the top cap faces up and the bottom cap faces down', () => {
  const ir = compileBuilding(graph({ shape: SQUARE, mass: { props: { levelCount: 1 } } })).ir
  const { geometry } = buildBuildingGeometry(ir)
  const caps = triangles(geometry).filter(t => Math.abs(t.normal[1]) > 0.5)
  assert.equal(caps.length, 4)
  const up = caps.filter(t => t.normal[1] > 0)
  const down = caps.filter(t => t.normal[1] < 0)
  assert.equal(up.length, 2)
  assert.equal(down.length, 2)
  for (const t of up) assert.ok(t.centroid[1] > 0.1, 'the up-facing cap must be the roof')
  for (const t of down) assert.ok(t.centroid[1] < 0.1, 'the down-facing cap must be the floor')
})

// --- courtyards -------------------------------------------------------------

test('a courtyard wall faces INTO the courtyard', () => {
  // The one that goes wrong if a hole ring is re-wound to CCW on the way in.
  const ir = compileBuilding(graph({ shape: COURTYARD, mass: { props: { levelCount: 1 } } })).ir
  const { geometry } = buildBuildingGeometry(ir)
  const courtCentre = [15, 0, -15]

  const inner = triangles(geometry).filter(t => {
    if (Math.abs(t.normal[1]) > 0.5) return false
    // Inside the 10..20 square in plan, which in three space is x 10..20, z -20..-10.
    return t.centroid[0] > 9.5 && t.centroid[0] < 20.5
        && t.centroid[2] < -9.5 && t.centroid[2] > -20.5
  })
  assert.equal(inner.length, 8, `expected 8 courtyard wall triangles, got ${inner.length}`)
  for (const t of inner) {
    const toCentre = [courtCentre[0] - t.centroid[0], 0, courtCentre[2] - t.centroid[2]]
    assert.ok(dot(toCentre, t.normal) > 0,
      `a courtyard wall at ${t.centroid} faces away from the court`)
  }
})

test('a courtyard is a hole in the cap, not a filled square', () => {
  const solid = compileBuilding(graph({ shape: { outer: COURTYARD.outer, holes: [] }, mass: { props: { levelCount: 1 } } })).ir
  const holed = compileBuilding(graph({ shape: COURTYARD, mass: { props: { levelCount: 1 } } })).ir
  const solidCaps = triangles(buildBuildingGeometry(solid).geometry).filter(t => t.normal[1] > 0.5)
  const holedCaps = triangles(buildBuildingGeometry(holed).geometry).filter(t => t.normal[1] > 0.5)
  assert.ok(holedCaps.length > solidCaps.length,
    'a cap with a hole needs more triangles than a plain quad')

  // No cap triangle may have its centroid inside the courtyard.
  for (const t of holedCaps) {
    const inside = t.centroid[0] > 10.2 && t.centroid[0] < 19.8
                && t.centroid[2] < -10.2 && t.centroid[2] > -19.8
    assert.ok(!inside, `a roof triangle sits over the courtyard at ${t.centroid}`)
  }
})

// --- profiles ---------------------------------------------------------------

test('a battered mass narrows with height', () => {
  const ir = compileBuilding(graph({
    shape: SQUARE,
    mass: { modes: { profile: MASS_PROFILE.BATTER }, props: { levelCount: 4, amount: 2 } },
  })).ir
  const { geometry } = buildBuildingGeometry(ir)
  const pos = geometry.getAttribute('position')

  let lowSpan = 0
  let highSpan = 0
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const x = pos.getX(i)
    if (y < 0.01) lowSpan = Math.max(lowSpan, Math.abs(x - 5))
    if (y > ir.stats.height - 0.01) highSpan = Math.max(highSpan, Math.abs(x - 5))
  }
  assert.ok(highSpan < lowSpan - 0.5, `top span ${highSpan} is not narrower than base ${lowSpan}`)
})

// --- UVs --------------------------------------------------------------------

test('wall UVs are in metres, so a facade tiles at one scale', () => {
  // Normalising per face would stretch the same brick to a different size on
  // every wall of an irregular plan.
  const ir = compileBuilding(graph({
    shape: { outer: [[0, 0], [30, 0], [30, 4], [0, 4]], holes: [] },
    mass: { props: { levelCount: 1, groundHeight: 3 } },
  })).ir
  const { geometry } = buildBuildingGeometry(ir)
  const pos = geometry.getAttribute('position')
  const nor = geometry.getAttribute('normal')
  const uv = geometry.getAttribute('uv')

  // WALL triangles only. Caps are UV-mapped in plan metres - deliberately, so a
  // floor tiles at the same scale as a wall - so their v carries the footprint's
  // depth and would drown out what this test is measuring.
  let maxU = 0
  let maxV = 0
  for (let i = 0; i < pos.count; i += 3) {
    if (Math.abs(nor.getY(i)) > 0.5) continue
    for (let k = i; k < i + 3; k++) {
      maxU = Math.max(maxU, uv.getX(k))
      maxV = Math.max(maxV, uv.getY(k))
    }
  }
  // The perimeter is 68m and the wall is 3m tall; a 0..1 mapping would cap at 1.
  assert.ok(maxU > 60, `u only reaches ${maxU} - UVs look normalised`)
  assert.ok(Math.abs(maxV - 3) < 1e-6, `v reaches ${maxV}, expected the wall height`)
})

// --- helpers ----------------------------------------------------------------

test('buildLevelOutlines draws one loop per level top', () => {
  const ir = compileBuilding(graph({ shape: SQUARE, mass: { props: { levelCount: 3 } } })).ir
  const lines = buildLevelOutlines(ir)
  assert.ok(lines)
  // 3 levels x 4 edges x 2 endpoints.
  assert.equal(lines.getAttribute('position').count, 24)
})

test('buildingBounds covers the whole building', () => {
  const ir = compileBuilding(graph({ shape: SQUARE, mass: { props: { levelCount: 2, groundHeight: 4, levelHeight: 3 } } })).ir
  const box = buildingBounds(ir)
  assert.ok(box instanceof THREE.Box3)
  assert.ok(Math.abs(box.min.y - 0) < 1e-6)
  assert.ok(Math.abs(box.max.y - 7) < 1e-6, `top at ${box.max.y}`)
  assert.ok(Math.abs(box.max.x - 10) < 1e-6)
  assert.ok(Math.abs(box.min.z + 10) < 1e-6, 'north maps to -Z')
})

test('an empty IR yields no geometry rather than an empty buffer', () => {
  // The preview tests for null; an empty BufferGeometry would render as nothing
  // and also hide a real failure.
  for (const empty of [null, {}, { levels: [] }]) {
    const { geometry, triangleCount } = buildBuildingGeometry(empty)
    assert.equal(geometry, null)
    assert.equal(triangleCount, 0)
  }
  assert.equal(buildLevelOutlines(null), null)
  assert.equal(buildingBounds(null), null)
})

if (process.exitCode) console.error(`\n${passed} passed, failures above.`)
else console.log(`mesh.test.mjs: ${passed} passed`)
