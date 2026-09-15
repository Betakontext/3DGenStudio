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
import { differencePolygons } from '../../../building/clip.js'
import { rungKind } from '../../../building/roof.js'
import { makeWarp } from '../../../building/deform.js'
import { resolveMaterialIndex } from '../../../building/ir.js'
import { sideOfEdge, sideOfNormal } from '../../../building/sides.js'
import { trimSection } from '../../../building/trim.js'

/**
 * How deep an opening placeholder sits, in metres.
 *
 * Enough that the box is visibly set into the wall rather than co-planar with
 * it: two surfaces at exactly the same depth z-fight, which reads as flickering
 * rather than as a window.
 */
export const SLOT_DEPTH = 0.18

/** Convert one IR point to three.js space. See the header for why this mapping. */
export function toThree(x, y, z) {
  return [x, z, -y]
}

/**
 * The point placer for an IR: straight to three space, or through its warp first.
 *
 * Returns `toThree` ITSELF when there is no deformation, so a caller can test
 * identity to decide whether normals need re-deriving, and an undeformed
 * building costs exactly what it did before deformation existed.
 */
function placer(ir) {
  const warp = makeWarp(ir?.deform)
  if (warp.isIdentity) return toThree
  return (x, y, z) => {
    const [wx, wy, wz] = warp.warp(x, y, z)
    return toThree(wx, wy, wz)
  }
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
function createBuilder({ recomputeNormals = false } = {}) {
  // ONE BUCKET PER MATERIAL, concatenated at build time into one geometry with
  // draw GROUPS. A building with a stone ground floor and brick above is two
  // materials and therefore two draw calls whatever happens; putting them in one
  // buffer with two groups is the cheap way to have that, and it keeps every
  // caller writing triangles in whatever order suits it rather than having to
  // emit them material by material.
  const buckets = new Map()
  const bucketFor = group => {
    let bucket = buckets.get(group)
    if (!bucket) {
      bucket = { positions: [], normals: [], uvs: [] }
      buckets.set(group, bucket)
    }
    return bucket
  }

  return {
    /** One triangle, with a shared face normal. Points are already in three space. */
    tri(a, b, c, normal, uvA, uvB, uvC, group = 0) {
      const { positions, normals, uvs } = bucketFor(group)
      positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
      // A DEFORMED WALL'S NORMAL IS NOT THE ONE THE CALLER COMPUTED. Every caller
      // works out the face normal from the undeformed plan, which is exact and
      // cheap while the building is orthogonal - and wrong the moment a warp
      // turns the wall. Rather than make each caller transform its own normal,
      // the normal is re-derived from the triangle once a warp is in play, and
      // kept in the hemisphere the caller asked for so an extreme warp cannot
      // turn a wall inside out.
      let face = normal
      if (recomputeNormals) {
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
        let nx = uy * vz - uz * vy
        let ny = uz * vx - ux * vz
        let nz = ux * vy - uy * vx
        const length = Math.hypot(nx, ny, nz)
        if (length > 1e-12) {
          nx /= length; ny /= length; nz /= length
          const agrees = nx * normal[0] + ny * normal[1] + nz * normal[2] >= 0
          face = agrees ? [nx, ny, nz] : [-nx, -ny, -nz]
        }
      }
      for (let i = 0; i < 3; i++) normals.push(face[0], face[1], face[2])
      uvs.push(uvA[0], uvA[1], uvB[0], uvB[1], uvC[0], uvC[1])
    },
    get triangleCount() {
      let total = 0
      for (const bucket of buckets.values()) total += bucket.positions.length / 9
      return total
    },
    /**
     * @returns {{geometry: THREE.BufferGeometry, groups: Array<number>}}
     *   `groups[i]` is the ir.materials index that geometry group i draws with.
     */
    build() {
      const positions = []
      const normals = []
      const uvs = []
      const groups = []
      const geometry = new THREE.BufferGeometry()

      // Sorted, so the same building always produces the same group order and a
      // golden test of the geometry is possible at all - Map iteration is
      // insertion order, which depends on which wall happened to be built first.
      for (const group of [...buckets.keys()].sort((a, b) => a - b)) {
        const bucket = buckets.get(group)
        const start = positions.length / 3
        positions.push(...bucket.positions)
        normals.push(...bucket.normals)
        uvs.push(...bucket.uvs)
        geometry.addGroup(start, bucket.positions.length / 3, groups.length)
        groups.push(group)
      }

      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
      geometry.computeBoundingSphere()
      geometry.computeBoundingBox()
      return { geometry, groups }
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
function addWalls(builder, ring, z0, z1, uOffset = 0, place = toThree, groupFor = null) {
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

    const A = place(a[0], a[1], z0)
    const B = place(b[0], b[1], z0)
    const C = place(b[0], b[1], z1)
    const D = place(a[0], a[1], z1)

    const u0 = u
    const u1 = u + length
    const v0 = z0
    const v1 = z1

    // WHICH SIDE THIS WALL IS ON, from the edge itself. The caller supplies the
    // storey; this is the other half of the material selector, and computing it
    // here means no consumer has to carry per-edge material data in the IR.
    const group = groupFor ? groupFor(sideOfEdge(a, b)) : 0

    builder.tri(A, B, C, normal, [u0, v0], [u1, v0], [u1, v1], group)
    builder.tri(A, C, D, normal, [u0, v0], [u1, v1], [u0, v1], group)
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
function addCap(builder, outer, holes, z, up, place = toThree, group = 0) {
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
      place(p[0], p[1], z),
      place(q[0], q[1], z),
      place(r[0], r[1], z),
      normal,
      // Caps are UV-mapped in plan metres, so a floor material tiles at the same
      // scale as the walls rather than being stretched to the building's bounds.
      [p[0], p[1]], [q[0], q[1]], [r[0], r[1]],
      group,
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
  // The SAME warp the compiler used on the slots and the trim paths, built from
  // the descriptor the IR carries. Walls are generated here from 2D polygons, so
  // they have to be warped here; sharing the function is what keeps the windows
  // on the wall rather than beside it.
  const place = placer(ir)
  const builder = createBuilder({ recomputeNormals: place !== toThree })
  if (!ir || !Array.isArray(ir.levels) || ir.levels.length === 0) {
    return { geometry: null, triangleCount: 0 }
  }

  for (const level of ir.levels) {
    const polygon = ir.polygons[level.polygon]
    if (!polygon) continue
    const outer = unflatten(polygon.outer)
    const holes = (polygon.holes || []).map(unflatten)
    if (outer.length < 3) continue

    // The wall material for THIS STOREY, as a function of which side each edge
    // faces. Resolved per edge rather than per level because a facade can
    // override one side and leave the rest to the building-wide slot.
    const wallFor = side => resolveMaterialIndex(ir, 'wall', level.index, side)
    // A cap has no side - it is horizontal - so it takes the storey's
    // side-agnostic wall material.
    const capGroup = wallFor('')

    let u = addWalls(builder, outer, level.z0, level.z1, 0, place, wallFor)
    for (const hole of holes) u = addWalls(builder, hole, level.z0, level.z1, u, place, wallFor)

    addCap(builder, outer, holes, level.z1, true, place, capGroup)
    addCap(builder, outer, holes, level.z0, false, place, capGroup)
  }

  if (builder.triangleCount === 0) return { geometry: null, triangleCount: 0 }
  return { ...builder.build(), triangleCount: builder.triangleCount }
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
  const place = placer(ir)

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
        points.push(...place(a[0], a[1], level.z1), ...place(b[0], b[1], level.z1))
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
  // Warped too, or a leaning building frames off-centre and a tall twist can put
  // its own top outside the camera.
  const place = placer(ir)

  for (const level of ir.levels) {
    const polygon = ir.polygons[level.polygon]
    if (!polygon) continue
    for (let i = 0; i + 1 < polygon.outer.length; i += 2) {
      const x = polygon.outer[i]
      const y = polygon.outer[i + 1]
      for (const z of [level.z0, level.z1]) {
        const [tx, ty, tz] = place(x, y, z)
        box.expandByPoint(new THREE.Vector3(tx, ty, tz))
        any = true
      }
    }
  }
  return any ? box : null
}

/**
 * The roof, from its contour ladder.
 *
 * THE THREE RUNG RULES, which building/roof.js defines and this function obeys
 * without knowing what shape it is drawing:
 *
 *   slope  polygons and height both change -> the annulus between them, its
 *          outer edge at the lower height and its inner edge at the upper one
 *   tread  polygons change, height does not -> the annulus, flat
 *   riser  polygons identical, height changes -> the walls of the lower contour,
 *          extruded straight up
 *
 * A hip roof is all slopes; a Mayan platform alternates treads and risers; a
 * mansard is slopes of two pitches. None of that is special-cased here, which is
 * the whole point of the ladder representation.
 *
 * HEIGHT IS ASSIGNED BY WHICH RING A VERTEX CAME FROM, not by interpolation. The
 * annulus between two contours has the lower contour as its outer boundary and
 * the upper one as its holes, so a vertex on a hole is at the upper height and
 * everything else is at the lower one. That is exact, needs no correspondence
 * between the two contours - which is just as well, since an L-plan's contour
 * splits in two on the way up and there is no correspondence to find.
 */
export function buildRoofGeometry(ir) {
  const roof = ir?.roof
  if (!roof || !Array.isArray(roof.rungs) || roof.rungs.length === 0) {
    return { geometry: null, triangleCount: 0 }
  }

  const place = placer(ir)
  const builder = createBuilder({ recomputeNormals: place !== toThree })
  // A roof is one material for the whole surface: it has no storeys and its
  // sides are not walls, so neither part of the selector applies to it.
  const roofGroup = resolveMaterialIndex(ir, 'roof', -1, '')
  const polygonAt = index => {
    const stored = ir.polygons[index]
    if (!stored) return null
    return { outer: unflatten(stored.outer), holes: (stored.holes || []).map(unflatten) }
  }
  const rungPolygons = rung => rung.polygons.map(polygonAt).filter(Boolean)

  for (let i = 1; i < roof.rungs.length; i++) {
    const lower = roof.rungs[i - 1]
    const upper = roof.rungs[i]
    const lowerPolys = rungPolygons(lower)
    const upperPolys = rungPolygons(upper)

    // Classified by building/roof.js so the mesher and the tests agree rather
    // than each deciding for itself.
    const kind = rungKind(
      { polygons: lowerPolys, z: lower.z },
      { polygons: upperPolys, z: upper.z },
    )

    if (kind === 'riser') {
      // Straight up: the contour's own walls. Outward, because a riser is the
      // face of a step and is seen from outside.
      for (const polygon of lowerPolys) {
        let u = addWalls(builder, polygon.outer, lower.z, upper.z, 0, place, () => roofGroup)
        for (const hole of polygon.holes) {
          u = addWalls(builder, hole, lower.z, upper.z, u, place, () => roofGroup)
        }
      }
      continue
    }
    if (kind === 'none') continue

    // Slope or tread: the annulus between the two contours.
    for (const band of differencePolygons(lowerPolys, upperPolys)) {
      addRoofBand(builder, band, lower.z, upper.z, upperPolys, place, roofGroup)
    }
  }

  // Whatever the ladder ends on gets a lid. A closed roof ends on a ridge so thin
  // the cap is a sliver; a capped one ends on a real flat deck. Both need it, or
  // the building has a hole where the sky is.
  const top = roof.rungs[roof.rungs.length - 1]
  for (const polygon of rungPolygons(top)) {
    addCap(builder, polygon.outer, polygon.holes, top.z, true, place, roofGroup)
  }

  if (builder.triangleCount === 0) return { geometry: null, triangleCount: 0 }
  return { ...builder.build(), triangleCount: builder.triangleCount }
}

/**
 * One annular band of a roof.
 *
 * Every vertex is at the lower height unless it lies on one of the upper
 * contour's rings, in which case it is at the upper one. Membership is tested by
 * proximity rather than by identity: the band comes back from Clipper as fresh
 * coordinates, quantised to its integer lattice, so the vertices are equal in
 * value but never the same objects.
 */
function addRoofBand(builder, band, lowerZ, upperZ, upperPolys, place = toThree, group = 0) {
  const faces = triangulate(band.outer, band.holes)
  if (faces.length === 0) return

  const points = [...band.outer, ...band.holes.flat()]

  // Every vertex of the upper contour, to test membership against.
  const upperPoints = []
  for (const polygon of upperPolys) {
    upperPoints.push(...polygon.outer, ...polygon.holes.flat())
  }
  const isUpper = p => upperPoints.some(
    q => Math.abs(q[0] - p[0]) < 1e-4 && Math.abs(q[1] - p[1]) < 1e-4,
  )

  const heights = points.map(p => (isUpper(p) ? upperZ : lowerZ))

  for (const face of faces) {
    const [ia, ib, ic] = face
    const a = points[ia]
    const b = points[ib]
    const c = points[ic]
    if (!a || !b || !c) continue

    const A = place(a[0], a[1], heights[ia])
    const B = place(b[0], b[1], heights[ib])
    const C = place(c[0], c[1], heights[ic])

    // The normal comes from the triangle itself rather than from the slope,
    // because a band may contain both sloping and flat parts where a contour
    // splits, and one assumed normal would light half of it wrongly.
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2]
    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2]
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len < 1e-12) continue
    nx /= len; ny /= len; nz /= len
    // A roof faces up. Flip the winding rather than the normal so the two agree.
    const flip = ny < 0
    builder.tri(
      A, flip ? C : B, flip ? B : C,
      [flip ? -nx : nx, flip ? -ny : ny, flip ? -nz : nz],
      [a[0], a[1]],
      flip ? [c[0], c[1]] : [b[0], b[1]],
      flip ? [b[0], b[1]] : [c[0], c[1]],
      group,
    )
  }
}

/**
 * The trim, swept along its runs.
 *
 * THE MITRE IS THE WHOLE JOB. Sweeping a section along a polyline is easy; the
 * part that makes trim look like trim is what happens at a corner. At each
 * station the section is placed along the BISECTOR of the two adjoining edges
 * and scaled by 1/cos(half the turn), which is exactly the amount that makes the
 * two straight runs meet in a clean mitre instead of leaving a notch on the
 * outside and a fold on the inside. Doing it per face - a separate moulding on
 * each wall - cannot produce that joint at all, which is why building/trim.js
 * emits polylines and not faces.
 *
 * The miter scale is CLAMPED. A near-reversing corner (a very thin spur in the
 * plan) sends 1/cos to infinity and would fire a spike of trim off into space;
 * clamping trades a slightly open mitre on a pathological corner for geometry
 * that stays inside the building.
 *
 * Paths arrive ALREADY DEFORMED - the compiler warps them when it builds the IR -
 * so nothing here knows about deformation, and the bisectors are computed on the
 * bent building, which is what makes a cornice follow a twisted wall.
 */
export function buildTrimGeometry(ir) {
  const runs = (ir?.trims || []).filter(run => run.closed && run.path.length >= 9)
  if (!runs.length) return { geometry: null, triangleCount: 0 }

  // Normals come from the swept geometry itself: a moulding's section faces
  // several directions at once and there is no single face normal to pass in.
  const builder = createBuilder({ recomputeNormals: true })

  for (const run of runs) {
    // EACH RUN CARRIES ITS OWN MATERIAL. Trims accumulate - a plinth, a string
    // course and a cornice are three nodes - and the compiler has already
    // resolved which entry each one draws with, so there is nothing to select
    // here. A run from before per-trim materials existed has index 0; falling
    // back to the trim slot keeps such an IR looking right.
    const trimGroup = run.material >= 0
      ? run.material
      : resolveMaterialIndex(ir, 'trim', -1, '')
    const section = trimSection(run.profileId, run.projection, run.depth)
    if (section.length < 3) continue

    const count = Math.floor(run.path.length / 3)
    const at = i => [run.path[i * 3], run.path[i * 3 + 1], run.path[i * 3 + 2]]

    // One frame per station: an outward direction in plan, mitre-scaled.
    const frames = []
    let along = 0
    for (let i = 0; i < count; i++) {
      const previous = at((i - 1 + count) % count)
      const point = at(i)
      const next = at((i + 1) % count)

      const inN = edgeNormal(previous, point)
      const outN = edgeNormal(point, next)
      if (!inN || !outN) { frames.push(null); continue }

      let bx = inN[0] + outN[0]
      let by = inN[1] + outN[1]
      const bLen = Math.hypot(bx, by)
      // A doubled-back edge cancels the bisector entirely; fall back to the
      // outgoing edge's own normal rather than dividing by zero.
      if (bLen < 1e-9) { bx = outN[0]; by = outN[1] } else { bx /= bLen; by /= bLen }

      const cos = bx * outN[0] + by * outN[1]
      const miter = cos > 0.25 ? 1 / cos : 4

      frames.push({ point, nx: bx, ny: by, miter, along })
      along += Math.hypot(next[0] - point[0], next[1] - point[1], next[2] - point[2])
    }

    // Station i to station i+1, one quad strip per section edge.
    const sectionLengths = [0]
    for (let k = 1; k <= section.length; k++) {
      const a = section[k - 1]
      const b = section[k % section.length]
      sectionLengths.push(sectionLengths[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]))
    }

    const placeSection = (frame, k) => {
      const [out, up] = section[k]
      const d = out * frame.miter
      return toThree(
        frame.point[0] + frame.nx * d,
        frame.point[1] + frame.ny * d,
        frame.point[2] + up,
      )
    }

    for (let i = 0; i < count; i++) {
      const a = frames[i]
      const b = frames[(i + 1) % count]
      if (!a || !b) continue

      for (let k = 0; k < section.length; k++) {
        const k2 = (k + 1) % section.length
        const A = placeSection(a, k)
        const B = placeSection(b, k)
        const C = placeSection(b, k2)
        const D = placeSection(a, k2)

        // UVs run along the path and around the section, which is the layout a
        // tileable trim sheet wants: one axis is metres of run.
        const uA = [a.along, sectionLengths[k]]
        const uB = [b.along, sectionLengths[k]]
        const uC = [b.along, sectionLengths[k + 1]]
        const uD = [a.along, sectionLengths[k + 1]]

        // The seed normal only has to pick a hemisphere - the builder derives the
        // real one from each triangle. Outward is right for the whole section
        // except its back face, which is buried in the wall.
        const seed = [a.nx, 0, -a.ny]
        builder.tri(A, B, C, seed, uA, uB, uC, trimGroup)
        builder.tri(A, C, D, seed, uA, uC, uD, trimGroup)
      }
    }
  }

  if (builder.triangleCount === 0) return { geometry: null, triangleCount: 0 }
  return { ...builder.build(), triangleCount: builder.triangleCount }
}

/** The outward normal in plan of the edge a -> b, or null if it has no length. */
function edgeNormal(a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const length = Math.hypot(dx, dy)
  if (length < 1e-9) return null
  // Same convention as the walls: for a ring walked as stored, (dy, -dx) points
  // away from the solid on outer rings AND on holes.
  return [dy / length, -dx / length]
}

/**
 * The openings, as one instanced box per slot type.
 *
 * INSTANCED, NOT MERGED. A forty-storey tower is thousands of openings; merging
 * them into one geometry means rebuilding every vertex when a single slider
 * moves, while an InstancedMesh rebuilds a matrix array and nothing else. It is
 * also the shape the later phases need: a style pack binds a slot type to a
 * real model, and swapping the instanced geometry is then the whole change.
 *
 * A UNIT BOX IS THE PLACEHOLDER, scaled per instance by the opening's own width
 * and height. Recessed slightly into the wall (the small Z offset) so it reads
 * as an opening rather than a panel stuck to the outside - without it the boxes
 * z-fight with the wall they sit on, which looks like flickering rather than
 * like a window.
 *
 * @param {object} ir
 * @returns {Array<{type: string, count: number, geometry: THREE.BufferGeometry, matrices: Float32Array}>}
 */
export function buildSlotInstances(ir) {
  if (!ir || !Array.isArray(ir.slots) || ir.slots.length === 0) return []

  // GROUPED BY TYPE *AND* MATERIAL, not by type alone. An InstancedMesh draws
  // every instance with one material, so a ground-floor shopfront in one glass
  // and the upper windows in another are two meshes however they are counted -
  // and a facade that overrides only its north side splits again. The key is
  // built from both so the split falls out of the grouping rather than needing a
  // second pass.
  const byGroup = new Map()
  for (const slot of ir.slots) {
    // A door resolves against the door slot, everything else against openings -
    // the same two palette slots the viewport has always drawn them with.
    const materialSlot = slot.type === 'door' ? 'door' : 'opening'
    const side = sideOfNormal(slot.transform[8], slot.transform[9])
    const material = resolveMaterialIndex(ir, materialSlot, slot.floorIndex, side)
    const key = `${slot.type}#${material}`
    if (!byGroup.has(key)) byGroup.set(key, { type: slot.type, material, slots: [] })
    byGroup.get(key).slots.push(slot)
  }

  const out = []
  // Sorted, so the draw order - and therefore anything comparing two builds -
  // does not depend on which slot happened to be emitted first.
  for (const key of [...byGroup.keys()].sort()) {
    const { type, material, slots } = byGroup.get(key)
    const matrices = new Float32Array(slots.length * 16)
    const matrix = new THREE.Matrix4()
    const local = new THREE.Matrix4()

    slots.forEach((slot, index) => {
      // The IR transform is Z-up; convert it the same way a point is. Building
      // the basis explicitly rather than multiplying by a change-of-basis matrix
      // keeps the handedness argument in one place - see toThree.
      const t = slot.transform
      // ALL THREE COLUMNS COME FROM THE TRANSFORM. `up` used to be hardcoded to
      // straight up here, on the assumption that a wall is vertical - and that
      // silently threw away everything building/deform.js does to it. A LEAN
      // leaves `along` and `normal` alone and tilts only `up`, so the whole
      // deformation lived in the one column this function was ignoring: the
      // walls leaned and every window stayed bolt upright inside them, poking
      // out of the wall it was supposed to lie in.
      //
      // For an undeformed building the column IS (0, 0, 1), so reading it costs
      // nothing and cannot regress the ordinary case.
      const alongIr = [t[0], t[1], t[2]]
      const upIr = [t[4], t[5], t[6]]
      const normalIr = [t[8], t[9], t[10]]
      const posIr = [t[12], t[13], t[14]]

      const along = toThree(alongIr[0], alongIr[1], alongIr[2])
      const up = toThree(upIr[0], upIr[1], upIr[2])
      const normal = toThree(normalIr[0], normalIr[1], normalIr[2])
      const pos = toThree(posIr[0], posIr[1], posIr[2])

      matrix.set(
        along[0], up[0], normal[0], pos[0],
        along[1], up[1], normal[1], pos[1],
        along[2], up[2], normal[2], pos[2],
        0, 0, 0, 1,
      )
      // Scale the unit box to the opening, with a shallow depth.
      local.makeScale(Math.max(slot.cellW, 1e-4), Math.max(slot.cellH, 1e-4), SLOT_DEPTH)
      matrix.multiply(local)
      matrix.toArray(matrices, index * 16)
    })

    out.push({
      // The key, not the type, because two groups can share a type and React
      // needs them to be distinguishable.
      key,
      type,
      material,
      count: slots.length,
      geometry: new THREE.BoxGeometry(1, 1, 1),
      matrices,
    })
  }
  return out
}

/**
 * The palette, as a slot -> colour map the renderer can index directly.
 *
 * The compiler always emits every slot - see compile.js - so this needs no
 * defaults of its own, and a component that reads it never has to know whether
 * a style pack has been applied. The fallback here covers only an IR from
 * before materials existed.
 */
export function irPalette(ir) {
  const out = {
    wall: '#c9cdd4', trim: '#b4b9c2', roof: '#8e7a6b',
    opening: '#2f3a44', door: '#7a6248', accent: '#6d7480',
  }
  for (const material of ir?.materials || []) {
    if (material?.slot && material.color) out[material.slot] = material.color
  }
  return out
}
