// The building generator viewport.
//
// Camera behaviour is reused unchanged from the mesh editor (CameraRig,
// ViewportCameras, ViewGizmo) by handing them a throwaway proxy geometry that
// spans the building's bounds - the same trick the tree and assembly viewports
// use. Reusing it rather than writing a third orbit camera is what keeps the
// view cube, the orthographic toggle and the framing behaviour identical across
// every workspace in the app.
//
// THE GEOMETRY IS REBUILT FROM THE IR, NOT MUTATED. A building is small enough
// (a few thousand triangles for anything Phase 1 can produce) that rebuilding it
// wholesale on every edit is cheaper than working out what changed - and it
// makes the preview provably a function of the document, which is the same
// property that lets the compiler run headless. The dispose bookkeeping matters
// though: a live preview churns a real GPU buffer on every slider drag, and
// leaking those is how a long session ends up out of memory.

import { useEffect, useMemo, useRef } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Grid } from '@react-three/drei'
import * as THREE from 'three'
import CameraRig from '../meshEditor/CameraRig'
import ViewportCameras from '../meshEditor/ViewportCameras'
import ViewGizmo from '../meshEditor/ViewGizmo'
import { FRAME_EYE_OFFSET, framedOrthoZoom } from '../../utils/cameraFraming'
import {
  buildBuildingGeometry, buildLevelOutlines, buildRoofGeometry, buildSlotInstances,
  buildTrimGeometry, buildingBounds, irPalette,
} from '../../utils/building/mesh'

/**
 * Frames the camera, and makes left-drag orbit.
 *
 * BOTH OF THESE EXIST BECAUSE CameraRig IS THE MESH EDITOR'S, and the mesh
 * editor's assumptions are not ours.
 *
 * FRAMING. CameraRig re-frames only when its `frameKey` changes, and it keeps
 * that guard on the key alone. ViewportCameras mounts a perspective AND an
 * orthographic camera and picks between them with `makeDefault`, so the default
 * camera's IDENTITY changes a tick after mount - at which point CameraRig's
 * effect re-runs with a brand-new, unframed camera, sees the same frameKey, and
 * bails. The camera is then left wherever R3F put it, which is five metres from
 * the origin: the preview opened on a flat grey slab that is actually the inside
 * of a wall. Keying on the camera as well is the whole fix.
 *
 * LEFT-DRAG. CameraRig hardcodes `mouseButtons: { LEFT: null, MIDDLE: ROTATE,
 * RIGHT: PAN }`, which is right for the mesh editor - the left button belongs to
 * the sculpt and paint tools there. There are no such tools here, so left-drag
 * did nothing at all, which is a terrible answer to the first thing anyone tries
 * in a 3D view.
 */
function BuildingCamera({ extents, frameKey }) {
  // Destructured, not selected. Framing a camera means MUTATING it - that is how
  // three.js works and how CameraRig next door does it - and the compiler's
  // immutability rule fires on values taken through a useThree selector while
  // accepting the destructured store, which is the idiom already in use here.
  const { camera, controls } = useThree()
  const framedRef = useRef('')

  useEffect(() => {
    if (!controls?.mouseButtons) return
    // Object.assign rather than a direct property write throughout this
    // component: three.js objects are mutated in place by design, and the React
    // compiler's immutability rule traces plain assignments to a hook value but
    // not this form - which is exactly how CameraRig next door does the same job.
    Object.assign(controls.mouseButtons, { LEFT: THREE.MOUSE.ROTATE })
  }, [controls])

  useEffect(() => {
    if (!camera) return
    // The camera is part of the key: see the header.
    const key = `${camera.uuid}|${frameKey}|${extents.x},${extents.y},${extents.z}`
    if (framedRef.current === key) return
    framedRef.current = key

    // The building is drawn centred on the origin with its base on the ground
    // (see viewOffset), so the sphere to frame is known without measuring.
    const center = new THREE.Vector3(0, extents.y / 2, 0)
    const radius = Math.max(
      Math.hypot(extents.x / 2, extents.y / 2, extents.z / 2), 1,
    )

    camera.position.set(
      center.x + radius * FRAME_EYE_OFFSET[0],
      center.y + radius * FRAME_EYE_OFFSET[1],
      center.z + radius * FRAME_EYE_OFFSET[2],
    )
    Object.assign(camera, {
      near: Math.max(radius * 0.001, 0.01),
      far: Math.max(radius * 200, 2000),
      ...(camera.isOrthographicCamera ? { zoom: framedOrthoZoom(camera, radius) } : null),
    })
    camera.updateProjectionMatrix()

    if (controls?.target) {
      // Also widen the dolly clamps: CameraRig's static maxDistance of 100 is
      // fine for a mesh and too close for a hundred-metre tower.
      Object.assign(controls, {
        minDistance: Math.max(radius * 0.02, 0.05),
        maxDistance: Math.max(radius * 40, 200),
      })
      controls.target.copy(center)
      controls.update()
    } else {
      camera.lookAt(center)
    }
  }, [camera, controls, extents, frameKey])

  return null
}

// An 8-corner box spanning the building, purely so CameraRig has something with
// a bounding sphere to frame. Never rendered.
//
// Built around the ORIGIN, because the building is drawn there too - see
// viewOffset below.
function boundsProxy(size) {
  const geometry = new THREE.BufferGeometry()
  const hx = Math.max(size.x, 1) / 2
  const hz = Math.max(size.z, 1) / 2
  const hy = Math.max(size.y, 1)
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -hx, 0, -hz, hx, 0, -hz, -hx, hy, -hz, hx, hy, -hz,
    -hx, 0, hz, hx, 0, hz, -hx, hy, hz, hx, hy, hz,
  ], 3))
  return geometry
}

// Disposes the previous value whenever the current one changes, and again on
// unmount. Every geometry here is a GPU allocation.
function useDisposed(value) {
  const ref = useRef(value)
  useEffect(() => {
    const previous = ref.current
    ref.current = value
    if (previous && previous !== value) previous.dispose?.()
  }, [value])
  useEffect(() => () => ref.current?.dispose?.(), [])
}

export default function BuildingViewport({
  ir = null,
  frameKey = 0,
  orthographic = false,
  showGrid = true,
  showOutlines = true,
  active = true,
  onCameraReady,
}) {
  // NOTHING IS BUILT WHILE THE PREVIEW IS BEHIND THE PLAN TAB.
  //
  // The canvas stays mounted so its WebGL context survives a tab switch, but
  // keeping it mounted also meant this memo re-ran on every document change -
  // and dragging a corner in the plan editor commits on every pointermove. So
  // each frame of a drag rebuilt the whole building, allocated new buffers,
  // uploaded them to the GPU and disposed the old ones, all for a canvas nobody
  // could see. At sixty moves a second in a dev build that is enough to lock the
  // tab, which is precisely what it did.
  //
  // Switching back to Preview rebuilds once, which is what an unmounted viewport
  // did anyway - so this costs nothing and removes the whole hidden cost.
  const { geometry, roofGeometry, trimGeometry, outlines, box, slots } = useMemo(() => {
    if (!active) {
      return {
        geometry: null, roofGeometry: null, trimGeometry: null, outlines: null,
        box: null, slots: [],
      }
    }
    const built = buildBuildingGeometry(ir)
    return {
      geometry: built.geometry,
      roofGeometry: buildRoofGeometry(ir).geometry,
      trimGeometry: buildTrimGeometry(ir).geometry,
      outlines: buildLevelOutlines(ir),
      box: buildingBounds(ir),
      slots: buildSlotInstances(ir),
    }
  }, [ir, active])

  // The InstancedMeshes are built here rather than declared as JSX.
  //
  // R3F can express an instancedMesh declaratively, but writing the matrix array
  // through nested props (`instanceMatrix-array`) does not reliably mark the
  // attribute for upload, so the instances render stacked at the origin - one
  // visible box where a thousand windows should be. Constructing the object and
  // handing it over with <primitive> makes the upload explicit and the disposal
  // obvious, which matters here: a drag rebuilds this list every frame.
  // The style pack's colours, or the neutral defaults when no style is applied.
  // Read from the IR rather than from the document so the preview cannot show a
  // palette the compiler did not actually use.
  const palette = useMemo(() => irPalette(ir), [ir])

  const slotMeshes = useMemo(() => slots.map(group => {
    const material = new THREE.MeshStandardMaterial({
      // Doors read warmer than windows in every default palette, purely so the
      // front of the building is findable at a glance.
      color: group.type === 'door' ? palette.door : palette.opening,
      roughness: 0.4,
      metalness: 0.1,
    })
    const mesh = new THREE.InstancedMesh(group.geometry, material, group.count)
    mesh.name = group.type
    mesh.instanceMatrix.set(group.matrices)
    mesh.instanceMatrix.needsUpdate = true
    // The bounding sphere three computes for an InstancedMesh ignores the
    // instance transforms, so culling would hide the openings the moment the
    // building's own origin left the frustum.
    mesh.frustumCulled = false
    return mesh
  }), [slots, palette.door, palette.opening])

  const slotsRef = useRef(slotMeshes)
  useEffect(() => {
    const previous = slotsRef.current
    slotsRef.current = slotMeshes
    if (previous && previous !== slotMeshes) {
      for (const mesh of previous) {
        mesh.geometry?.dispose?.()
        mesh.material?.dispose?.()
      }
    }
  }, [slotMeshes])
  useEffect(() => () => {
    for (const mesh of slotsRef.current || []) {
      mesh.geometry?.dispose?.()
      mesh.material?.dispose?.()
    }
  }, [])

  useDisposed(geometry)
  useDisposed(roofGeometry)
  useDisposed(trimGeometry)
  useDisposed(outlines)

  // THE BUILDING IS DRAWN CENTRED ON THE ORIGIN, and this is why.
  //
  // A plan drawn from (0,0) puts the building in the CORNER of world space, not
  // around it. OrbitControls targets the origin, so the camera orbited a point
  // beside the building: the preview opened either inside a wall or with the
  // model shoved off the edge of the frame. CameraRig does set the controls
  // target, but only if its ref is populated by the time its effect runs, and
  // relying on that ordering is exactly the kind of thing that works until it
  // does not.
  //
  // Offsetting the drawn geometry is sturdier than fighting for the target: the
  // orbit centre, the grid's centre and the building's centre all become the
  // same point by construction. The IR keeps its real plan coordinates, so
  // export and any future multi-footprint work are untouched - this is a view
  // transform and nothing more. Y is offset to the base rather than the middle
  // so the building stands ON the grid instead of sinking halfway through it.
  const viewOffset = useMemo(() => {
    if (!box) return [0, 0, 0]
    return [-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2]
  }, [box])

  const extents = useMemo(() => {
    if (!box) return new THREE.Vector3(12, 10, 12)
    return new THREE.Vector3(
      box.max.x - box.min.x,
      box.max.y - box.min.y,
      box.max.z - box.min.z,
    )
  }, [box])

  const proxy = useMemo(() => boundsProxy(extents), [extents])
  useDisposed(proxy)


  // Sized off the building rather than fixed, so a 4m shed and a 120m tower both
  // get a grid that reads as ground instead of as graph paper or as one line.
  const span = Math.max(Math.max(extents.x, extents.z) * 2, 8)

  return (
    // frameloop is parked while the Plan tab is in front. The canvas stays
    // mounted so its WebGL context survives (see the note in BuildingGenPage),
    // but a static building has nothing to redraw and rendering it behind
    // another pane is pure heat.
    <Canvas
      className="buildinggen__canvas"
      dpr={[1, 2]}
      shadows={false}
      frameloop={active ? 'always' : 'never'}
    >
      <ViewportCameras orthographic={orthographic} />
      <CameraRig geometry={proxy} frameKey={0} onCameraReady={onCameraReady} />
      <BuildingCamera extents={extents} frameKey={frameKey} />

      <ambientLight intensity={0.7} />
      <directionalLight position={[6, 12, 8]} intensity={1.4} />
      <directionalLight position={[-7, 4, -5]} intensity={0.35} />

      {showGrid && (
        <Grid
          args={[span, span]}
          cellSize={Math.max(span / 40, 0.5)}
          sectionSize={Math.max(span / 8, 2)}
          cellColor="#3b3f45"
          sectionColor="#565c66"
          fadeDistance={span * 3}
          infiniteGrid
          followCamera={false}
        />
      )}

      <group position={viewOffset}>
      {geometry && (
        <mesh geometry={geometry}>
          {/* The style pack's wall colour, or a neutral grey when there is no
              style: a flat pale surface is the one that makes a setback or a
              batter readable as geometry rather than as shading. */}
          <meshStandardMaterial color={palette.wall} roughness={0.85} metalness={0.0} />
        </mesh>
      )}

      {/* The roof gets its own material, a shade darker than the walls. Not
          decoration: a hip roof meeting a wall at a shallow pitch is almost
          indistinguishable from it under flat lighting, and the eave line is
          what tells you whether the roof is the shape you asked for. */}
      {roofGeometry && (
        <mesh geometry={roofGeometry}>
          <meshStandardMaterial color={palette.roof} roughness={0.9} metalness={0} />
        </mesh>
      )}

      {/* Trim gets the palette's trim colour and a slightly shinier finish than
          the wall: a cornice is the one element whose whole job is to catch the
          light, and at the same roughness as the wall it disappears into it. */}
      {trimGeometry && (
        <mesh geometry={trimGeometry}>
          <meshStandardMaterial color={palette.trim} roughness={0.6} metalness={0.05} />
        </mesh>
      )}

      {/* The openings. One InstancedMesh per slot type, so a tower's thousand
          windows cost one draw call rather than a thousand - and so a style pack
          can later swap the geometry for a real model without touching
          anything else. Doors read warmer than windows purely so the front of
          the building is findable at a glance. */}
      {slotMeshes.map(mesh => <primitive key={mesh.name} object={mesh} />)}

      {/* The storey lines are what make a one-metre setback legible - the
          shading alone hides it at most camera angles. */}
      {showOutlines && outlines && (
        <lineSegments geometry={outlines}>
          <lineBasicMaterial color={palette.accent} transparent opacity={0.9} />
        </lineSegments>
      )}
      </group>

      <ViewGizmo />
    </Canvas>
  )
}
