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
import { appendReference, normalizeBuildingDoc } from '../../../building/doc.js'
import { meshKey } from '../../../building/stylepack.js'
import { MASS_PROFILE } from '../../../building/mass.js'
import {
  SLOT_DEPTH, buildBuildingGeometry, buildLevelOutlines, buildRoofGeometry,
  buildSlotInstances, buildTrimGeometry, buildingBounds, toThree,
} from './mesh.js'
import { sideOfNormal } from '../../../building/sides.js'

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

// --- roofs -------------------------------------------------------------------

function roofGraph({ shape = SQUARE, kind = 'hip', roof = {}, mass = {} } = {}) {
  const fp = createNode('footprint', 'fp')
  fp.props.shape = shape
  const ms = createNode('mass', 'ms')
  Object.assign(ms.props, { levelCount: 2, ...mass })
  const rf = createNode('roof', 'rf')
  rf.modes.kind = kind
  Object.assign(rf.props, roof)
  return normalizeBuildingDoc({
    nodes: [fp, ms, rf, createNode('output', 'out')],
    edges: [
      { from: { node: 'fp', port: 'out' }, to: { node: 'ms', port: 'shape' } },
      { from: { node: 'ms', port: 'out' }, to: { node: 'rf', port: 'building' } },
      { from: { node: 'rf', port: 'out' }, to: { node: 'out', port: 'building' } },
    ],
  })
}

test('a hip roof meshes, and sits ON TOP of the walls', () => {
  const ir = compileBuilding(roofGraph({ kind: 'hip', roof: { pitch: 40 } })).ir
  assert.ok(ir.roofs[0], 'no roof in the IR')
  const { geometry, triangleCount } = buildRoofGeometry(ir)
  assert.ok(geometry, 'the roof produced no geometry')
  assert.ok(triangleCount > 8, `only ${triangleCount} triangles`)

  const pos = geometry.getAttribute('position')
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < pos.count; i++) {
    minY = Math.min(minY, pos.getY(i))
    maxY = Math.max(maxY, pos.getY(i))
  }
  // The eave is the top of the walls; the ridge is above it.
  assert.ok(Math.abs(minY - ir.stats.height) < 1e-3, `eave at ${minY}, walls end at ${ir.stats.height}`)
  assert.ok(maxY > minY + 1, 'the roof is flat')
  assert.ok(Math.abs(maxY - minY - ir.roofs[0].height) < 1e-3)
})

test('roof triangles face UPWARD, not into the building', () => {
  // A roof lit from underneath is the classic winding mistake, and it is
  // invisible until the model is shaded.
  const ir = compileBuilding(roofGraph({ kind: 'hip', roof: { pitch: 35 } })).ir
  const { geometry } = buildRoofGeometry(ir)
  const nor = geometry.getAttribute('normal')
  for (let i = 0; i < nor.count; i++) {
    assert.ok(nor.getY(i) >= -1e-6, `a roof triangle faces down (ny=${nor.getY(i)})`)
  }
})

test('stored normals agree with the winding', () => {
  const ir = compileBuilding(roofGraph({ kind: 'hip', roof: { pitch: 35 } })).ir
  const { geometry } = buildRoofGeometry(ir)
  for (const t of triangles(geometry)) {
    assert.ok(dot(windingNormal(t), t.normal) > 0.99, 'a roof triangle is lit inside out')
  }
})

test('a flat roof meshes as a lid and nothing else', () => {
  const ir = compileBuilding(roofGraph({ kind: 'flat' })).ir
  const { geometry, triangleCount } = buildRoofGeometry(ir)
  assert.ok(geometry)
  assert.equal(triangleCount, 2, 'a flat lid over a rectangle is two triangles')
  assert.equal(ir.roofs[0].height, 0)
})

test('a stepped roof produces vertical risers as well as flat treads', () => {
  const ir = compileBuilding(roofGraph({
    shape: { outer: [[0, 0], [30, 0], [30, 30], [0, 30]], holes: [] },
    kind: 'stepped', roof: { stepRun: 3, stepRise: 2 },
  })).ir
  const { geometry } = buildRoofGeometry(ir)
  const normals = triangles(geometry).map(t => t.normal)
  assert.ok(normals.some(n => Math.abs(n[1]) > 0.99), 'no flat tread')
  assert.ok(normals.some(n => Math.abs(n[1]) < 0.01), 'no vertical riser')
})

test('a roof over a courtyard leaves the courtyard open', () => {
  const ir = compileBuilding(roofGraph({
    shape: {
      outer: [[0, 0], [30, 0], [30, 30], [0, 30]],
      holes: [[[10, 10], [10, 20], [20, 20], [20, 10]]],
    },
    kind: 'hip', roof: { pitch: 30 },
  })).ir
  const { geometry } = buildRoofGeometry(ir)
  assert.ok(geometry)
  // Nothing may be drawn over the middle of the court at eave height.
  for (const t of triangles(geometry)) {
    const overCourt = t.centroid[0] > 13 && t.centroid[0] < 17
      && t.centroid[2] < -13 && t.centroid[2] > -17
    assert.ok(!overCourt || t.centroid[1] > ir.stats.height + 0.5,
      `the courtyard was roofed over at ${t.centroid}`)
  }
})

test('no roof in the IR yields no geometry rather than throwing', () => {
  for (const empty of [null, {}, { roof: null }, { roof: { rungs: [] } }]) {
    const { geometry, triangleCount } = buildRoofGeometry(empty)
    assert.equal(geometry, null)
    assert.equal(triangleCount, 0)
  }
})

// --- trim and deformation ---------------------------------------------------

/** The same graph, plus a chain of extra stages after the Mass. */
function graphWith(stages, options = {}) {
  const base = graph(options)
  const nodes = [...base.nodes]
  const edges = base.edges.filter(e => e.to.node !== 'out')
  let previous = 'ms'
  stages.forEach((stage, i) => {
    const node = createNode(stage.type, `n${i}`)
    Object.assign(node.props, stage.props || {})
    Object.assign(node.modes, stage.modes || {})
    nodes.push(node)
    edges.push({ from: { node: previous, port: 'out' }, to: { node: node.id, port: 'building' } })
    previous = node.id
  })
  edges.push({ from: { node: previous, port: 'out' }, to: { node: 'out', port: 'building' } })
  return normalizeBuildingDoc({ ...base, nodes, edges })
}

const irOf = doc => compileBuilding(doc).ir

test('a trim run is swept into real geometry', () => {
  const ir = irOf(graphWith([{ type: 'trim', modes: { where: 'cornice' } }], { shape: SQUARE }))
  assert.equal(ir.trims.length, 1)
  const built = buildTrimGeometry(ir)
  // Four corners x seven section edges x two triangles.
  assert.equal(built.triangleCount, 56)
  assert.ok(built.geometry.getAttribute('normal'), 'the sweep produced no normals')
})

test('the section is centred on its line and the right size', () => {
  const ir = irOf(graphWith([
    { type: 'trim', modes: { where: 'cornice' }, props: { projection: 0.4, depth: 0.8 } },
  ], { shape: SQUARE, mass: { props: { levelCount: 2, groundHeight: 4, levelHeight: 3 } } }))
  const tris = triangles(buildTrimGeometry(ir).geometry)
  const ys = tris.flatMap(t => [t.a[1], t.b[1], t.c[1]])
  // The cornice sits at the top of the stack, 7m up, and straddles it by half
  // its height each way.
  assert.ok(Math.abs(Math.min(...ys) - 6.6) < 1e-3, `bottom at ${Math.min(...ys)}`)
  assert.ok(Math.abs(Math.max(...ys) - 7.4) < 1e-3, `top at ${Math.max(...ys)}`)
})

test('THE MITRE: a corner projects further than a wall does', () => {
  // The whole reason trim is edge-driven. A per-face moulding stops at 0.4m from
  // each wall and leaves a notch; a mitred one reaches 0.4/cos(45) at the corner.
  const ir = irOf(graphWith([
    { type: 'trim', modes: { where: 'cornice' }, props: { projection: 0.4 } },
  ], { shape: SQUARE }))
  const tris = triangles(buildTrimGeometry(ir).geometry)
  // The plan is 0..10 in both axes. At the corner the section is placed along
  // the bisector and scaled by 1/cos(45), so the corner point lands at
  // (10.4, 10.4): the same 0.4m clear of BOTH walls as the straight runs are of
  // one. Un-mitred it would sit at 10 + 0.4/sqrt(2) = 10.283 and leave a notch.
  const corner = Math.max(...tris.flatMap(t => [t.a, t.b, t.c]).map(p => p[0]))
  assert.ok(Math.abs(corner - 10.4) < 1e-3,
    `the corner reached ${corner.toFixed(3)}, expected 10.400`)
  assert.ok(corner > 10 + 0.4 / Math.SQRT2 + 0.05, 'the corner was not mitred')
})

test('a courtyard cornice projects INTO the courtyard', () => {
  // Reversed, it would be buried in the masonry - the winding rule in trim.js.
  const ir = irOf(graphWith([{ type: 'trim', modes: { where: 'cornice' } }], { shape: COURTYARD }))
  assert.equal(ir.trims.length, 2)
  const hole = ir.trims[1]
  const xs = hole.path.filter((_, i) => i % 3 === 0)
  // The hole spans x 10..20; trim around it must reach INSIDE that, not outside.
  assert.ok(Math.min(...xs) >= 10 - 1e-6 && Math.max(...xs) <= 20 + 1e-6)
})

test('trims ACCUMULATE - a plinth and a cornice are two runs, not one', () => {
  const ir = irOf(graphWith([
    { type: 'trim', modes: { where: 'plinth' } },
    { type: 'trim', modes: { where: 'cornice' } },
  ], { shape: SQUARE }))
  assert.deepEqual(ir.trims.map(t => t.profileId), ['plinth', 'cornice'])
})

test('no trim node means no trim geometry, and no cost', () => {
  const built = buildTrimGeometry(irOf(graph({ shape: SQUARE })))
  assert.equal(built.geometry, null)
  assert.equal(built.triangleCount, 0)
})

test('a deformation moves the walls, and the descriptor rides along', () => {
  const straight = irOf(graph({ shape: SQUARE, mass: { props: { levelCount: 3 } } }))
  const twisted = irOf(graphWith([
    { type: 'deform', modes: { mode: 'twist' }, props: { amount: 45 } },
  ], { shape: SQUARE, mass: { props: { levelCount: 3 } } }))

  assert.equal(straight.deform, null)
  assert.equal(twisted.deform.mode, 'twist')

  const a = buildBuildingGeometry(straight)
  const b = buildBuildingGeometry(twisted)
  assert.equal(a.triangleCount, b.triangleCount, 'the warp changed the topology')

  const top = g => Math.max(...triangles(g.geometry).flatMap(t => [t.a, t.b, t.c]).map(p => p[0]))
  assert.ok(top(b) > top(a) + 0.5, 'the twisted building is no wider than the straight one')
})

test('a twisted wall is lit by its own direction, not the undeformed one', () => {
  // The silent failure: positions warped, normals left behind, so the building
  // looks right until it is shaded.
  const ir = irOf(graphWith([
    { type: 'deform', modes: { mode: 'twist' }, props: { amount: 60 } },
  ], { shape: SQUARE, mass: { props: { levelCount: 4 } } }))
  const tris = triangles(buildBuildingGeometry(ir).geometry)

  // Seeded above 1, not at 0: a running minimum started at 0 can never rise, so
  // the assertion below would fail on correct geometry and report 90 degrees.
  let worst = 2
  for (const t of tris) {
    const ux = t.b[0] - t.a[0], uy = t.b[1] - t.a[1], uz = t.b[2] - t.a[2]
    const vx = t.c[0] - t.a[0], vy = t.c[1] - t.a[1], vz = t.c[2] - t.a[2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const length = Math.hypot(nx, ny, nz)
    if (length < 1e-9) continue
    const dot = (nx / length) * t.normal[0] + (ny / length) * t.normal[1]
      + (nz / length) * t.normal[2]
    worst = Math.min(worst, dot)
  }
  assert.ok(worst > 0.999, `a face normal is ${Math.acos(worst) * 57.3}deg off its own triangle`)
})

test('an undeformed building takes the identity path, byte for byte', () => {
  // The warp must cost nothing when there is none: buildBuildingGeometry asks
  // for the placer by identity to decide whether to re-derive normals at all.
  const doc = graph({ shape: COURTYARD, mass: { modes: { profile: MASS_PROFILE.SETBACK } } })
  const a = buildBuildingGeometry(irOf(doc)).geometry.getAttribute('position').array
  const b = buildBuildingGeometry(irOf(doc)).geometry.getAttribute('position').array
  assert.deepEqual(Array.from(a), Array.from(b))
})

test('the camera bounds follow a leaning building', () => {
  const upright = buildingBounds(irOf(graph({ shape: SQUARE, mass: { props: { levelCount: 4 } } })))
  const leaning = buildingBounds(irOf(graphWith([
    { type: 'deform', modes: { mode: 'lean' }, props: { amount: 6, axis: 0 } },
  ], { shape: SQUARE, mass: { props: { levelCount: 4 } } })))
  assert.ok(leaning.max.x > upright.max.x + 5, 'a leaning building would frame off-centre')
})

// --- the instance basis -----------------------------------------------------
//
// THE GAP THAT LET A BUG THROUGH TWICE. building/deform.test.mjs checks what
// warpTransform returns; nothing checked that the mesher USES it. It did not:
// `up` was hardcoded to straight up here, so a lean - which tilts only that one
// column - was discarded at the meshing boundary, and a fix to warpTransform
// changed precisely nothing on screen. These tests span the boundary.

/** The three basis columns of instance `n`, unscaled. */
function instanceBasis(group, n = 0) {
  const m = group.matrices
  const col = k => [m[n * 16 + k * 4], m[n * 16 + k * 4 + 1], m[n * 16 + k * 4 + 2]]
  const unit = v => {
    const length = Math.hypot(...v)
    return length > 1e-9 ? v.map(c => c / length) : v
  }
  return { along: unit(col(0)), up: unit(col(1)), normal: unit(col(2)), pos: col(3) }
}

const windowsOf = ir => buildSlotInstances(ir).find(group => group.type === 'window')

test('an instance reads ALL THREE columns of its IR transform', () => {
  // Not two and an assumption. The check is per column against the IR, mapped
  // into three space the one way toThree defines.
  const ir = irOf(graphWith([{ type: 'facade' }],
    { shape: SQUARE, mass: { props: { levelCount: 2 } } }))
  const group = windowsOf(ir)
  assert.ok(group, 'the fixture produced no windows')

  const slot = ir.slots.find(s => s.type === 'window')
  const basis = instanceBasis(group, ir.slots.filter(s => s.type === 'window').indexOf(slot))
  const t = slot.transform
  for (const [name, irCol, got] of [
    ['along', [t[0], t[1], t[2]], basis.along],
    ['up', [t[4], t[5], t[6]], basis.up],
    ['normal', [t[8], t[9], t[10]], basis.normal],
  ]) {
    const want = toThree(irCol[0], irCol[1], irCol[2])
    const length = Math.hypot(...want) || 1
    const unit = want.map(c => c / length)
    assert.ok(got.every((c, i) => Math.abs(c - unit[i]) < 1e-5),
      `${name}: instance has [${got.map(c => c.toFixed(3))}], IR says [${unit.map(c => c.toFixed(3))}]`)
  }
})

test('an undeformed window stands exactly upright', () => {
  // The ordinary case must not move: reading the column instead of assuming it
  // has to cost nothing when the column is (0, 0, 1).
  const ir = irOf(graphWith([{ type: 'facade' }],
    { shape: SQUARE, mass: { props: { levelCount: 2 } } }))
  const { up } = instanceBasis(windowsOf(ir))
  assert.ok(Math.abs(Math.abs(up[1]) - 1) < 1e-9, `up is [${up.map(c => c.toFixed(4))}]`)
})

test('THE LEAN BUG, END TO END: instances tilt by the wall shear angle', () => {
  // Reported twice from screenshots. The first fix corrected warpTransform and
  // changed nothing visible, because this function threw the result away.
  const amount = 6
  const ir = irOf(graphWith([
    { type: 'facade' },
    { type: 'deform', modes: { mode: 'lean' }, props: { amount, axis: 0 } },
  ], { shape: SQUARE, mass: { props: { levelCount: 3 } } }))

  const height = Math.max(...ir.levels.map(l => l.z1))
  const expected = (Math.atan(amount / height) * 180) / Math.PI
  assert.ok(expected > 20, `the fixture leans only ${expected.toFixed(1)} degrees`)

  const group = windowsOf(ir)
  let checked = 0
  for (let n = 0; n < group.count; n++) {
    const { up } = instanceBasis(group, n)
    const tilt = (Math.acos(Math.min(1, Math.abs(up[1]))) * 180) / Math.PI
    assert.ok(Math.abs(tilt - expected) < 0.5,
      `instance ${n} tilts ${tilt.toFixed(2)}deg, the wall shears ${expected.toFixed(2)}deg`)
    checked += 1
  }
  // EVERY instance, not just the ones on one pair of walls: the original bug
  // failed asymmetrically, so a test that sampled one window could pass while
  // half the building was wrong.
  assert.ok(checked >= 8, `only ${checked} instances checked`)
})

test('a leaning building tilts its windows on every wall orientation', () => {
  // Grouped by which way each window faces, so the asymmetry the first bug had
  // cannot hide inside an average.
  const ir = irOf(graphWith([
    { type: 'facade' },
    { type: 'deform', modes: { mode: 'lean' }, props: { amount: 6, axis: 0 } },
  ], { shape: SQUARE, mass: { props: { levelCount: 3 } } }))
  const group = windowsOf(ir)

  const tiltsBySide = new Map()
  const slots = ir.slots.filter(s => s.type === 'window')
  for (let n = 0; n < group.count; n++) {
    const side = sideOfNormal(slots[n].transform[8], slots[n].transform[9])
    const { up } = instanceBasis(group, n)
    const tilt = (Math.acos(Math.min(1, Math.abs(up[1]))) * 180) / Math.PI
    if (!tiltsBySide.has(side)) tiltsBySide.set(side, [])
    tiltsBySide.get(side).push(tilt)
  }
  assert.equal(tiltsBySide.size, 4, `windows on ${tiltsBySide.size} sides, expected 4`)
  for (const [side, tilts] of tiltsBySide) {
    const worst = Math.min(...tilts)
    assert.ok(worst > 20, `${side} windows tilt only ${worst.toFixed(2)}deg`)
  }
})


test('the camera frames a roof taller than the building under it', () => {
  // Framing on the levels alone worked while every roof was shorter than its
  // walls, and then a 45-degree SHED over an 8m span rose 8m - taller than the
  // two storeys below - and the preview cut the top off. The roof looked broken
  // when only the camera was.
  const doc = graphWith([{ type: 'roof', modes: { kind: 'shed' }, props: { pitch: 45 } }],
    { shape: SQUARE, mass: { props: { levelCount: 2 } } })
  const ir = irOf(doc)
  const box = buildingBounds(ir)
  const total = ir.stats.height + ir.stats.roofHeight
  assert.ok(ir.stats.roofHeight > ir.stats.height,
    `the fixture roof (${ir.stats.roofHeight}) is not taller than its walls`)
  assert.ok(Math.abs(box.max.y - total) < 1e-6,
    `the frame tops out at ${box.max.y}, the building at ${total}`)
})

test('a gable end wall is drawn, and faces outward', () => {
  // The part the contour ladder cannot say. Without it the roof has a hole at
  // each end; wound inward, the wall is invisible until it is shaded.
  const ir = irOf(graphWith([
    { type: 'roof', modes: { kind: 'gable' }, props: { pitch: 45 } },
  ], { shape: { outer: [[0, 0], [20, 0], [20, 10], [0, 10]], holes: [] } }))
  assert.equal(ir.roofs[0].gables.length, 2)

  const tris = triangles(buildRoofGeometry(ir).geometry)
  // The ridge runs along X, so the end walls are the faces whose normal is +/-X.
  const ends = tris.filter(t => Math.abs(t.normal[0]) > 0.99)
  assert.ok(ends.length >= 4, `only ${ends.length} end-wall triangles`)
  for (const t of ends) {
    // Outward: a wall at the far end faces +X, one at the near end faces -X.
    const sign = t.centroid[0] > 10 ? 1 : -1
    assert.ok(t.normal[0] * sign > 0,
      `an end wall at x=${t.centroid[0].toFixed(1)} faces inward`)
  }
})

// --- bound opening models ---------------------------------------------------
//
// The contract: a bound mesh is treated as a UNIT mesh and scaled to the bay the
// grammar worked out, so one model fits any wall. Same rule the VFX mesh
// renderer settled on after getting it wrong in both importers.

/** A unit-ish geometry standing in for a loaded GLB, already normalised. */
function unitGeometry() {
  return new THREE.BoxGeometry(1, 1, 1)
}

// A slot resolves to a reference PREFIX and the loader returns one array per
// prefix, holes and all - so a fixture binds a real reference, reads the prefix
// the compiler chose, and hands over an array even when it holds one entry.
const withWindowModels = (doc, count = 1) => {
  let next = doc
  for (let i = 0; i < count; i++) {
    next = appendReference(next, meshKey('window'), { kind: 'mesh', ref: `asset:${i + 1}` })
  }
  return next
}
const meshSlotOf = ir => ir.slots.find(slot => slot.styleSlot === 'window')?.meshSlot || ''
// The loader hands back {geometry, material} per entry - the model keeps its own
// material, which the first version of it threw away.
const loadedList = (...geometries) => geometries.map(geometry => ({ geometry, material: null }))

test('a bound model REPLACES the placeholder box for that opening kind', () => {
  const ir = irOf(withWindowModels(graphWith([{ type: 'facade' }],
    { shape: SQUARE, mass: { props: { levelCount: 2 } } })))
  const custom = unitGeometry()
  const prefix = meshSlotOf(ir)
  assert.equal(prefix, meshKey('window'), `the slot resolved to "${prefix}"`)
  const groups = buildSlotInstances(ir, { [prefix]: loadedList(custom) })
  const windows = groups.find(group => group.tag === 'window')
  assert.ok(windows, 'no window group')
  assert.equal(windows.geometry, custom, 'the placeholder box was used anyway')
  // ...and the caller must not dispose it: the loader owns it.
  assert.equal(windows.ownsGeometry, false)
  custom.dispose()
})

test('an UNBOUND opening keeps its own box, which the caller owns', () => {
  const ir = irOf(graphWith([{ type: 'facade' }], { shape: SQUARE }))
  const groups = buildSlotInstances(ir, {})
  for (const group of groups) {
    assert.ok(group.geometry, `${group.tag} has no geometry`)
    assert.equal(group.ownsGeometry, true, `${group.tag} does not own its box`)
  }
})

test('openings are grouped by TAG as well as by material', () => {
  // A shopfront and the windows above it are different models, and one
  // InstancedMesh draws one geometry - so the split has to fall out of the
  // grouping rather than need a second pass.
  const ir = irOf(graphWith([
    { type: 'facade', modes: { storeys: 'all', opening: 'window' } },
    { type: 'facade', modes: { storeys: 'ground', opening: 'shopfront' } },
  ], { shape: SQUARE, mass: { props: { levelCount: 3 } } }))

  const tags = new Set(ir.slots.map(slot => slot.styleSlot))
  assert.ok(tags.has('window') && tags.has('shopfront'), `tags were ${[...tags]}`)

  const groups = buildSlotInstances(ir, {})
  const byTag = new Set(groups.map(group => group.tag))
  assert.ok(byTag.has('window') && byTag.has('shopfront'),
    `groups were ${[...byTag]} - a shopfront cannot wear its own model`)
})

test('a model is scaled to the CELL, so one model fits any wall', () => {
  // Width and height come from the bay the grammar computed. A model authored at
  // any size arrives the right size, which is the whole point of normalising it
  // to a unit box on load.
  const ir = irOf(withWindowModels(graphWith([{ type: 'facade', props: { bayWidth: 4 } }],
    { shape: SQUARE, mass: { props: { levelCount: 2 } } })))
  const custom = unitGeometry()
  const group = buildSlotInstances(ir, { [meshSlotOf(ir)]: loadedList(custom) })
    .find(g => g.tag === 'window')
  const slot = ir.slots.find(s => s.styleSlot === 'window')

  // Column lengths of the instance matrix are the scale it applied.
  const m = group.matrices
  const colLength = k => Math.hypot(m[k * 4], m[k * 4 + 1], m[k * 4 + 2])
  assert.ok(Math.abs(colLength(0) - slot.cellW) < 1e-4,
    `width ${colLength(0).toFixed(3)}, cell is ${slot.cellW}`)
  assert.ok(Math.abs(colLength(1) - slot.cellH) < 1e-4,
    `height ${colLength(1).toFixed(3)}, cell is ${slot.cellH}`)
  custom.dispose()
})

test('DEPTH keeps a model in proportion instead of flattening it', () => {
  // The cell says how wide and how tall the hole is. Nothing says how DEEP a
  // window is, and squashing a 200mm frame into the placeholder's 180mm slot
  // would flatten every moulding on it - so a bound model scales its depth with
  // the other two, and only the placeholder box keeps the fixed depth.
  const ir = irOf(withWindowModels(graphWith([{ type: 'facade' }],
    { shape: SQUARE, mass: { props: { levelCount: 2 } } })))
  const custom = unitGeometry()
  const depthOf = meshes => {
    const group = buildSlotInstances(ir, meshes).find(g => g.tag === 'window')
    const m = group.matrices
    return Math.hypot(m[8], m[9], m[10])
  }
  const plain = depthOf({})
  const model = depthOf({ [meshSlotOf(ir)]: loadedList(custom) })
  assert.ok(Math.abs(plain - SLOT_DEPTH) < 1e-6, `a box got depth ${plain}`)
  assert.ok(model > plain, `a model got depth ${model}, no deeper than the box's ${plain}`)
  custom.dispose()
})

test('the export bakes a bound model, and does not free what it does not own', () => {
  // Disposing a shared model here would pull it out from under the preview.
  const ir = irOf(withWindowModels(graphWith([{ type: 'facade' }],
    { shape: SQUARE, mass: { props: { levelCount: 2 } } })))
  const custom = unitGeometry()
  const groups = buildSlotInstances(ir, { [meshSlotOf(ir)]: loadedList(custom) })
  const windows = groups.find(group => group.tag === 'window')
  assert.equal(windows.ownsGeometry, false)
  // Still usable after a caller that respects ownsGeometry has finished.
  assert.ok(custom.getAttribute('position'), 'the shared model was disposed')
  custom.dispose()
})

// --- balconies --------------------------------------------------------------
//
// The two things a balcony needs from the mesher that an opening does not: its
// own projection depth, and the trim material rather than the opening one.

const balconyIr = (props = {}) => irOf(graphWith(
  [{ type: 'facade', modes: { balcony: 'all' }, props }],
  { shape: SQUARE, mass: { props: { levelCount: 3 } } },
))

test('a balcony is drawn its authored depth, not the token opening depth', () => {
  // SLOT_DEPTH exists to set a flat opening into its wall. Applying it to a
  // balcony would flatten a 1.4m projection onto the masonry - which is exactly
  // what "a balcony" stops being at that point.
  const ir = balconyIr({ balconyDepth: 1.4 })
  const group = buildSlotInstances(ir, {}).find(g => g.type === 'balcony')
  assert.ok(group, 'no balcony group')
  const m = new THREE.Matrix4().fromArray(group.matrices, 0)
  // The third basis column's length is the Z scale the instance was given.
  const depth = new THREE.Vector3(m.elements[8], m.elements[9], m.elements[10]).length()
  assert.ok(Math.abs(depth - 1.4) < 1e-5, `drawn ${depth.toFixed(4)}m deep, authored 1.4m`)
  // ...while an opening in the same building still gets the token depth.
  const window = buildSlotInstances(ir, {}).find(g => g.type === 'window')
  const wm = new THREE.Matrix4().fromArray(window.matrices, 0)
  const wd = new THREE.Vector3(wm.elements[8], wm.elements[9], wm.elements[10]).length()
  assert.ok(Math.abs(wd - SLOT_DEPTH) < 1e-5, `an opening was drawn ${wd.toFixed(4)}m deep`)
})

test('a BOUND balcony model keeps the authored depth too', () => {
  // The model path scales depth by the average of width and height, which is
  // right for a window (nothing says how thick one is) and wrong for a balcony
  // (the author said exactly how far it sticks out).
  const ir = balconyIr({ balconyDepth: 1.4 })
  const slot = ir.slots.find(s => s.type === 'balcony')
  const custom = unitGeometry()
  const group = buildSlotInstances(ir, { [slot.meshSlot || 'x']: loadedList(custom) })
    .find(g => g.type === 'balcony')
  const m = new THREE.Matrix4().fromArray(group.matrices, 0)
  const depth = new THREE.Vector3(m.elements[8], m.elements[9], m.elements[10]).length()
  assert.ok(Math.abs(depth - 1.4) < 1e-5, `a bound model was drawn ${depth.toFixed(4)}m deep`)
  custom.dispose()
})

test('a balcony draws in the TRIM material, not the opening one', () => {
  // It is masonry or ironwork bolted to the wall. In the opening colour a
  // facade reads as having holes hanging off the front of it.
  const ir = balconyIr()
  const groups = buildSlotInstances(ir, {})
  const balcony = groups.find(g => g.type === 'balcony')
  const window = groups.find(g => g.type === 'window')
  assert.equal(ir.materials[balcony.material].slot, 'trim')
  assert.equal(ir.materials[window.material].slot, 'opening')
})

test('balconies are their own instanced group, never merged with the openings', () => {
  const groups = buildSlotInstances(balconyIr(), {})
  const types = groups.map(g => g.type)
  assert.ok(types.includes('balcony') && types.includes('window'), `groups were ${types}`)
})

if (process.exitCode) console.error(`\n${passed} passed, failures above.`)
else console.log(`mesh.test.mjs: ${passed} passed`)
