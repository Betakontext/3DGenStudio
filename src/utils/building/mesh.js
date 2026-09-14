// BuildingIR -> three.js geometry.
//
// This is the boundary the pure contract in building/ stops at. Everything above
// it is plain arithmetic over JSON; everything here knows about BufferGeometry,
// vertex winding and UV layout. Keeping the split at a serialisable IR is what
// lets the same compiler run in the tab, on the server and in a plain node test.
//
// THE AXIS SWAP HAPPENS HERE, ONCE.
//
//   BuildingIR is Z-UP:  X east, Y north, Z up. A footprint is drawn in plan and
//                        the building rises in Z, which is how the drawing reads
//                        and how every calculation in mass.js and roof.js is
//                        written.
//   three.js is Y-UP.
//
//   ir(x, y, z)  ->  three(x, z, -y)
//
// That mapping is a right-handed basis change with a positive determinant, so it
// PRESERVES ORIENTATION: a counter-clockwise ring in plan stays counter-
// clockwise seen from above, and the winding conventions poly.js guarantees
// (outer CCW, holes CW) still produce outward-facing normals with no per-face
// correction. Flipping a single axis instead - the obvious "just swap Y and Z" -
// mirrors the building and turns every face inside out, which shows up as a
// model that looks right until it is lit.
//
// EVERY LEVEL IS A CLOSED PRISM. Walls plus a cap at the bottom and the top,
// even where two levels touch and the caps between them are never seen. The
// alternative - capping only exposed surfaces - needs to know which parts of a
// level's top are covered by the level above, which for a setback or battered
// mass is a polygon difference per storey. The hidden faces cost triangles and
// nothing else: they are interior, they are back-facing, and the optimiser in
// the export path removes them properly (services/hidden_faces.py already does
// exactly this job). Correct and simple now, cheap to improve later.

import * as THREE from 'three'

/** Convert one IR point to three.js space. See the header for why this mapping. */
export function toThree(x, y, z) {
  return [x, z, -y]
}

/**
 * Triangulate a polygon with holes.
 *
 * Uses three's bundled Earcut via ShapeUtils, so there is no polygon
 * triangulation dependency to add - checked during Phase 0 planning, and it is
 * the reason the generator does not need shapely or mapbox_earcut on the Python
 * side at all.
 *
 * Returns triangles as index triples into a combined vertex list of
 * [...outer, ...hole0, ...hole1], which is the layout ShapeUtils expects.
 */
function triangulate(outer, holes) {
  const contour = outer.map(p => new THREE.Vector2(p[0], p[1]))
  const holeShapes = holes.map(hole => hole.map(p => new THREE.Vector2(p[0], p[1])))
  try {
    return THREE.ShapeUtils.triangulateShape(contour, holeShapes)
  } catch {
    // A degenerate ring can make Earcut throw. The compiler already rejects the
    // shapes that matter, so anything reaching here is a cap not worth failing
    // the whole building over - draw the walls and skip the lid.
    return []
  }
}

/** Signed area of a 2D triangle. Positive is counter-clockwise. */
function triangleArea2(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/**
 * Flat array of [x, y] pairs from the IR's flat coordinate storage.
 *
 * The IR stores rings flat (see building/ir.js); the geometry code wants pairs.
 * This is the only place in the mesher that knows the difference.
 */
function unflatten(flat) {
  const out = []
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]])
  return out
}

/**
 * Accumulates triangles into flat arrays.
 *
 * Positions, normals and UVs are written explicitly rather than left to
 * computeVertexNormals, because a building wants FLAT shading on its walls: a
 * smoothed normal across a building's corner reads as a soft bevel, and the
 * corner is exactly the edge a viewer uses to judge whether the geometry is
 * right. Explicit per-face normals also mean no vertex is shared between two
 * walls, which is what keeps the UVs independent per face.
 */
function createBuilder() {
  const positions = []
  const normals = []
  const uvs = []

  return {
    /** One triangle, with a shared face normal. Points are already in three space. */
    tri(a, b, c, normal, uvA, uvB, uvC) {
      positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
      for (let i = 0; i < 3; i++) normals.push(normal[0], normal[1], normal[2])
      uvs.push(uvA[0], uvA[1], uvB[0], uvB[1], uvC[0], uvC[1])
    },
    get triangleCount() {
      return positions.length / 9
    },
    build() {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
      geometry.computeBoundingSphere()
      geometry.computeBoundingBox()
      return geometry
    },
  }
}

/**
 * Add the walls of one ring between two heights.
 *
 * The ring is walked AS STORED - outer rings counter-clockwise, holes clockwise -
 * and never re-wound. That is what makes a courtyard's walls face into the
 * courtyard: poly.normalizePolygon has already guaranteed the winding, and
 * re-normalising a hole to CCW here would turn its walls inside out.
 *
 * UVs run in metres: u along the wall, v up it. Metres rather than 0..1 because
 * a facade material is tiled, and normalising per face would stretch the same
 * brick to three different sizes on three different walls.
 */
function addWalls(builder, ring, z0, z1, uOffset = 0) {
  const n = ring.length
  if (n < 3) return uOffset
  let u = uOffset

  for (let i = 0; i < n; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const length = Math.hypot(dx, dy)
    if (length < 1e-9) continue

    // Outward normal in plan for a CCW ring, mapped into three space. For a
    // clockwise hole this comes out pointing into the void, which is correct:
    // that is the face a viewer standing in the courtyard sees.
    const nIr = [dy / length, -dx / length]
    const normal = [nIr[0], 0, -nIr[1]]

    const A = toThree(a[0], a[1], z0)
    const B = toThree(b[0], b[1], z0)
    const C = toThree(b[0], b[1], z1)
    const D = toThree(a[0], a[1], z1)

    const u0 = u
    const u1 = u + length
    const v0 = z0
    const v1 = z1

    builder.tri(A, B, C, normal, [u0, v0], [u1, v0], [u1, v1])
    builder.tri(A, C, D, normal, [u0, v0], [u1, v1], [u0, v1])
    u = u1
  }
  return u
}

/**
 * Add a horizontal cap.
 *
 * `up` picks which way it faces: the top of a level, or the underside of one.
 * Triangle winding is corrected from the 2D signed area rather than trusted from
 * the triangulator, so a change in Earcut's output order cannot silently turn
 * every floor into a hole.
 */
function addCap(builder, outer, holes, z, up) {
  const faces = triangulate(outer, holes)
  if (faces.length === 0) return

  const points = [...outer, ...holes.flat()]
  const normal = up ? [0, 1, 0] : [0, -1, 0]

  for (const face of faces) {
    const a = points[face[0]]
    const b = points[face[1]]
    const c = points[face[2]]
    if (!a || !b || !c) continue

    // A CCW triangle in plan faces up once mapped into three space. Flip when
    // the triangulator handed back the other winding, or when this is a floor.
    const ccw = triangleArea2(a, b, c) > 0
    const flip = up ? !ccw : ccw
    const [p, q, r] = flip ? [a, c, b] : [a, b, c]

    builder.tri(
      toThree(p[0], p[1], z),
      toThree(q[0], q[1], z),
      toThree(r[0], r[1], z),
      normal,
      // Caps are UV-mapped in plan metres, so a floor material tiles at the same
      // scale as the walls rather than being stretched to the building's bounds.
      [p[0], p[1]], [q[0], q[1]], [r[0], r[1]],
    )
  }
}

/**
 * Build one BufferGeometry for a whole BuildingIR.
 *
 * One geometry rather than one per level: a 40-storey tower would otherwise be
 * 40 draw calls of a few hundred triangles each, which is the wrong shape for a
 * GPU and makes the preview's frame time scale with storey count for no reason.
 *
 * @param {object} ir a BuildingIR
 * @returns {{geometry: THREE.BufferGeometry|null, triangleCount: number}}
 */
export function buildBuildingGeometry(ir) {
  const builder = createBuilder()
  if (!ir || !Array.isArray(ir.levels) || ir.levels.length === 0) {
    return { geometry: null, triangleCount: 0 }
  }

  for (const level of ir.levels) {
    const polygon = ir.polygons[level.polygon]
    if (!polygon) continue
    const outer = unflatten(polygon.outer)
    const holes = (polygon.holes || []).map(unflatten)
    if (outer.length < 3) continue

    let u = addWalls(builder, outer, level.z0, level.z1, 0)
    for (const hole of holes) u = addWalls(builder, hole, level.z0, level.z1, u)

    addCap(builder, outer, holes, level.z1, true)
    addCap(builder, outer, holes, level.z0, false)
  }

  if (builder.triangleCount === 0) return { geometry: null, triangleCount: 0 }
  return { geometry: builder.build(), triangleCount: builder.triangleCount }
}

/**
 * A thin line loop per level, for the wireframe overlay.
 *
 * Separate from the solid geometry because it is drawn with a different material
 * and toggled independently - and because the storey lines are what make a
 * battered or stepped profile legible in the preview, where the shading alone
 * can hide a one-metre setback.
 */
export function buildLevelOutlines(ir) {
  const points = []
  if (!ir || !Array.isArray(ir.levels)) return null

  for (const level of ir.levels) {
    const polygon = ir.polygons[level.polygon]
    if (!polygon) continue
    const rings = [unflatten(polygon.outer), ...(polygon.holes || []).map(unflatten)]
    for (const ring of rings) {
      if (ring.length < 2) continue
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        // Drawn at the level's TOP: that is where a setback shows as a step and
        // where a terrace edge actually is.
        points.push(...toThree(a[0], a[1], level.z1), ...toThree(b[0], b[1], level.z1))
      }
    }
  }

  if (points.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  return geometry
}

/**
 * The building's bounding box in three space, for framing the camera.
 *
 * Computed from the IR rather than from the geometry so it is available before
 * anything is meshed - the viewport needs it to place the camera on the first
 * frame, not after.
 */
export function buildingBounds(ir) {
  const box = new THREE.Box3()
  let any = false
  if (!ir || !Array.isArray(ir.levels)) return null

  for (const level of ir.levels) {
    const polygon = ir.polygons[level.polygon]
    if (!polygon) continue
    for (let i = 0; i + 1 < polygon.outer.length; i += 2) {
      const x = polygon.outer[i]
      const y = polygon.outer[i + 1]
      for (const z of [level.z0, level.z1]) {
        const [tx, ty, tz] = toThree(x, y, z)
        box.expandByPoint(new THREE.Vector3(tx, ty, tz))
        any = true
      }
    }
  }
  return any ? box : null
}
