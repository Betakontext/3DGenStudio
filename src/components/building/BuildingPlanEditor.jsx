// The footprint editor: draw and edit the plan a building is grown from.
//
// Nothing in this app drew editable polygons before this, so the interaction
// model is borrowed wholesale from VfxCurveEditor.jsx, which is the best
// documented 2D canvas in the repo. The four things taken from it, each for a
// reason that has already bitten someone:
//
//   DPR-AWARE SIZING + ResizeObserver. A canvas sized in CSS pixels is blurry on
//   every laptop made in the last decade. The backing store is sized in device
//   pixels and the context scaled once.
//
//   setPointerCapture. Without it, dragging a corner and leaving the canvas
//   drops the drag wherever the pointer happened to exit, and the corner sticks
//   to the cursor until the next click.
//
//   rAF REPAINT THROUGH A REF. The draw function reads the latest state from a
//   ref rather than closing over it, so a drag repaints at frame rate without
//   re-running the effect that installed the listeners. The ref is filled in an
//   effect, never during render - React may render without committing, and a ref
//   written in the render body would then describe a frame that never existed.
//
//   UNCONTROLLED DURING A DRAG, CONTROLLED AT THE EDGES. onChange fires
//   continuously and is coalesced into one undo entry; onCommit fires once on
//   pointer-up. Committing every mousemove would bury the rest of the history
//   under three hundred entries for one dragged corner.
//
// WHY NOT EXCALIDRAW, which is already a dependency: its line tool does produce
// points, but a footprint needs metric snapping, an orthogonal constraint and
// holes-as-courtyards, and its scene lives on the project-scoped Board rather
// than in a library asset. Bending it to those would be more work than this
// file, and would put the plan somewhere the compiler cannot reach.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './BuildingPlanEditor.css'

/** Screen pixels within which a click counts as hitting a vertex. */
const HIT_RADIUS = 9
/** Screen pixels within which a click counts as hitting an edge. */
const EDGE_HIT = 7

const COLORS = {
  grid: '#2a2e34',
  gridMajor: '#3a3f47',
  axis: '#4a515c',
  outer: '#8ff5ff',
  outerFill: 'rgba(143, 245, 255, 0.10)',
  hole: '#ffb26b',
  holeFill: 'rgba(20, 22, 26, 0.85)',
  vertex: '#e8ecf2',
  vertexActive: '#8ff5ff',
  pending: 'rgba(143, 245, 255, 0.55)',
  label: '#8a92a0',
}

const distance = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by)

/** Never draw grid lines closer together than this, in screen pixels. */
const MIN_GRID_PX = 9

/**
 * Hard ceiling on grid lines per axis.
 *
 * gridStepFor should make this unreachable, but the two grid loops are the only
 * unbounded ones in this file - `x += step` where both ends and the step come
 * from view state - and a step that is small enough relative to the coordinate
 * stops advancing it at all in floating point. The loop then never terminates
 * and takes the whole tab with it, which no amount of "that cannot happen"
 * reasoning is worth risking on a render path. A cap turns the worst case into
 * a grid that stops early.
 */
const MAX_GRID_LINES = 4000

/**
 * The grid step to actually draw, as a multiple of the snap grid.
 *
 * Drawing the raw snap grid at every zoom level is what made the canvas read as
 * static rather than as paper: at 0.5m and 18px/m the lines are 9px apart, and
 * zoomed out further they merge into a solid hatch that hides the plan itself.
 * Stepping up through 1/2/5/10 keeps the spacing legible at every zoom and
 * keeps the lines on values a person would count in.
 */
function gridStepFor(gridSize, scale) {
  const ladder = [1, 2, 5]
  let decade = 1
  for (let guard = 0; guard < 12; guard++) {
    for (const mult of ladder) {
      const step = gridSize * mult * decade
      if (step * scale >= MIN_GRID_PX) return step
    }
    decade *= 10
  }
  return gridSize * decade
}

/** Pixels the pointer may travel before a press counts as a drag, not a click. */
const DRAG_SLOP = 4

// Perpendicular distance from p to the segment ab. Used for "click an edge to
// insert a corner there".
function pointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return distance(px, py, ax, ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return distance(px, py, ax + t * dx, ay + t * dy)
}

// Pure transforms, outside the component: they depend only on their arguments,
// so keeping them here makes them obviously stable and keeps the hook list short.
function planToScreen(x, y, v, size) {
  return [
    size.width / 2 + (x + v.panX) * v.scale,
    // Plan Y is north and screen Y grows downward, so the sign flips here. This
    // is the ONLY place the flip happens; everything else works in plan metres.
    size.height / 2 - (y + v.panY) * v.scale,
  ]
}

function screenToPlan(sx, sy, v, size) {
  return [
    (sx - size.width / 2) / v.scale - v.panX,
    -((sy - size.height / 2) / v.scale) - v.panY,
  ]
}

export default function BuildingPlanEditor({
  shape,
  gridSize = 0.5,
  onChange,
  onCommit,
  disabled = false,
}) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const stateRef = useRef({})
  const dragRef = useRef(null)
  const frameRef = useRef(0)

  const [view, setView] = useState({ scale: 18, panX: 0, panY: 0 })
  const [hover, setHover] = useState(null)
  const [selection, setSelection] = useState(null)
  const [drawing, setDrawing] = useState(null)
  const [cursor, setCursor] = useState(null)
  const [ortho, setOrtho] = useState(true)
  const [snap, setSnap] = useState(true)

  // Memoised: it is a dependency of five callbacks, and rebuilding it every
  // render would make all of them unstable.
  const rings = useMemo(() => [
    { id: 'outer', points: shape?.outer || [] },
    ...((shape?.holes || []).map((points, index) => ({ id: `hole:${index}`, points }))),
  ], [shape])

  const canvasSize = useCallback(() => {
    const canvas = canvasRef.current
    const dpr = window.devicePixelRatio || 1
    return { width: (canvas?.width || 1) / dpr, height: (canvas?.height || 1) / dpr }
  }, [])

  const snapPoint = useCallback((x, y) => {
    if (!snap || !(gridSize > 0)) return [x, y]
    return [Math.round(x / gridSize) * gridSize, Math.round(y / gridSize) * gridSize]
  }, [snap, gridSize])

  // Constrain a new segment to 45-degree steps. On by default because almost
  // every building is orthogonal, and the deformation pass in a later phase is
  // the right way to get a non-orthogonal one - not a shaky hand.
  const applyOrtho = useCallback((point, previousPoints) => {
    if (!ortho || !previousPoints?.length) return point
    const last = previousPoints[previousPoints.length - 1]
    const dx = point[0] - last[0]
    const dy = point[1] - last[1]
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return point
    const stepped = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
    const length = Math.hypot(dx, dy)
    return snapPoint(last[0] + Math.cos(stepped) * length, last[1] + Math.sin(stepped) * length)
  }, [ortho, snapPoint])

  // --- painting -------------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const state = stateRef.current
    if (!canvas || !state.rings) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const size = { width: canvas.width / dpr, height: canvas.height / dpr }
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, size.width, size.height)

    const { view: v, rings: rs, gridSize: g } = state

    // --- grid ---
    // Stepped to stay legible at any zoom - see gridStepFor. Every fifth line is
    // drawn brighter so the eye has something to count by.
    {
      const step = gridStepFor(g, v.scale)
      const [left, top] = screenToPlan(0, 0, v, size)
      const [right, bottom] = screenToPlan(size.width, size.height, v, size)
      ctx.lineWidth = 1
      // Bail on anything that is not a drawable window rather than looping over
      // it: a NaN or infinite bound means the view is mid-initialisation.
      const sane = Number.isFinite(left) && Number.isFinite(right)
        && Number.isFinite(top) && Number.isFinite(bottom) && step > 0
      let lines = 0
      for (let x = sane ? Math.floor(left / step) * step : NaN;
        x <= right && lines < MAX_GRID_LINES; x += step, lines++) {
        const major = Math.abs(Math.round(x / step) % 5) === 0
        ctx.strokeStyle = major ? COLORS.gridMajor : COLORS.grid
        const [sx] = planToScreen(x, 0, v, size)
        ctx.beginPath()
        ctx.moveTo(Math.round(sx) + 0.5, 0)
        ctx.lineTo(Math.round(sx) + 0.5, size.height)
        ctx.stroke()
      }
      lines = 0
      for (let y = sane ? Math.floor(bottom / step) * step : NaN;
        y <= top && lines < MAX_GRID_LINES; y += step, lines++) {
        const major = Math.abs(Math.round(y / step) % 5) === 0
        ctx.strokeStyle = major ? COLORS.gridMajor : COLORS.grid
        const [, sy] = planToScreen(0, y, v, size)
        ctx.beginPath()
        ctx.moveTo(0, Math.round(sy) + 0.5)
        ctx.lineTo(size.width, Math.round(sy) + 0.5)
        ctx.stroke()
      }
    }

    // --- axes ---
    ctx.strokeStyle = COLORS.axis
    ctx.lineWidth = 1
    const [ox, oy] = planToScreen(0, 0, v, size)
    ctx.beginPath()
    ctx.moveTo(0, Math.round(oy) + 0.5)
    ctx.lineTo(size.width, Math.round(oy) + 0.5)
    ctx.moveTo(Math.round(ox) + 0.5, 0)
    ctx.lineTo(Math.round(ox) + 0.5, size.height)
    ctx.stroke()

    // --- rings ---
    rs.forEach((ring, ringIndex) => {
      if (ring.points.length === 0) return
      const isHole = ringIndex > 0
      const path = new Path2D()
      ring.points.forEach((p, i) => {
        const [sx, sy] = planToScreen(p[0], p[1], v, size)
        if (i === 0) path.moveTo(sx, sy)
        else path.lineTo(sx, sy)
      })
      path.closePath()

      ctx.fillStyle = isHole ? COLORS.holeFill : COLORS.outerFill
      ctx.fill(path)
      ctx.strokeStyle = isHole ? COLORS.hole : COLORS.outer
      ctx.lineWidth = 2
      ctx.stroke(path)

      // Edge lengths, so the plan is dimensioned rather than merely drawn. Only
      // when there is room for the text - a dense plan is unreadable otherwise.
      ctx.fillStyle = COLORS.label
      ctx.font = '11px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let i = 0; i < ring.points.length; i++) {
        const a = ring.points[i]
        const b = ring.points[(i + 1) % ring.points.length]
        const metres = Math.hypot(b[0] - a[0], b[1] - a[1])
        if (metres * v.scale < 44) continue
        const [mx, my] = planToScreen((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, v, size)
        ctx.fillText(`${Math.round(metres * 100) / 100}m`, mx, my - 9)
      }

      // Vertices last, so they sit above the fills.
      ring.points.forEach((p, i) => {
        const [sx, sy] = planToScreen(p[0], p[1], v, size)
        const active = (state.hover?.ring === ringIndex && state.hover?.vertex === i)
          || (state.selection?.ring === ringIndex && state.selection?.vertex === i)
        ctx.beginPath()
        ctx.arc(sx, sy, active ? 6 : 4, 0, Math.PI * 2)
        ctx.fillStyle = active ? COLORS.vertexActive : COLORS.vertex
        ctx.fill()
        ctx.strokeStyle = '#14161a'
        ctx.lineWidth = 1.5
        ctx.stroke()
      })
    })

    // --- the ring being drawn ---
    if (state.drawing) {
      const pts = state.drawing.points
      ctx.strokeStyle = COLORS.pending
      ctx.lineWidth = 2
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      pts.forEach((p, i) => {
        const [sx, sy] = planToScreen(p[0], p[1], v, size)
        if (i === 0) ctx.moveTo(sx, sy)
        else ctx.lineTo(sx, sy)
      })
      if (state.cursor && pts.length > 0) {
        const [cx, cy] = planToScreen(state.cursor[0], state.cursor[1], v, size)
        ctx.lineTo(cx, cy)
      }
      ctx.stroke()
      ctx.setLineDash([])

      pts.forEach(p => {
        const [sx, sy] = planToScreen(p[0], p[1], v, size)
        ctx.beginPath()
        ctx.arc(sx, sy, 4, 0, Math.PI * 2)
        ctx.fillStyle = COLORS.vertexActive
        ctx.fill()
      })
    }

    ctx.restore()
  }, [])

  // Fill the ref AFTER the render commits, never during it, then repaint on the
  // next frame. Several state changes in one commit coalesce into one paint.
  //
  // THE CLEANUP MUST CLEAR THE HANDLE, NOT JUST CANCEL IT. StrictMode in a dev
  // build mounts, unmounts and remounts: the unmount cancelled the pending frame
  // but left frameRef holding its id, so after the remount `if (frameRef.current)
  // return` was permanently true and the canvas never repainted again. Every
  // click still registered and changed the document - the picture just stopped
  // moving, which is indistinguishable from a frozen editor. It did not show up
  // in a production build, which is exactly why it survived testing.
  useEffect(() => {
    stateRef.current = { rings, view, hover, selection, drawing, cursor, gridSize, disabled }
    if (frameRef.current) return undefined
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      draw()
    })
    return () => {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
  }, [rings, view, hover, selection, drawing, cursor, gridSize, disabled, draw])

  // --- sizing ---------------------------------------------------------------

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return undefined

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = wrap.getBoundingClientRect()
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr
        canvas.height = height * dpr
        canvas.style.width = `${width}px`
        canvas.style.height = `${height}px`
      }
      draw()
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [draw])

  // --- hit testing ----------------------------------------------------------

  const pointerPlan = useCallback(event => {
    const canvas = canvasRef.current
    if (!canvas) return [0, 0]
    const rect = canvas.getBoundingClientRect()
    return screenToPlan(event.clientX - rect.left, event.clientY - rect.top, view, canvasSize())
  }, [canvasSize, view])

  const hitTest = useCallback(event => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const sx = event.clientX - rect.left
    const sy = event.clientY - rect.top
    const size = canvasSize()

    // Vertices before edges: a corner sits on two edges, and an author aiming at
    // a corner always means the corner.
    for (let r = 0; r < rings.length; r++) {
      const pts = rings[r].points
      for (let i = 0; i < pts.length; i++) {
        const [px, py] = planToScreen(pts[i][0], pts[i][1], view, size)
        if (distance(sx, sy, px, py) <= HIT_RADIUS) return { ring: r, vertex: i }
      }
    }
    for (let r = 0; r < rings.length; r++) {
      const pts = rings[r].points
      for (let i = 0; i < pts.length; i++) {
        const a = planToScreen(pts[i][0], pts[i][1], view, size)
        const next = pts[(i + 1) % pts.length]
        const b = planToScreen(next[0], next[1], view, size)
        if (pointToSegment(sx, sy, a[0], a[1], b[0], b[1]) <= EDGE_HIT) return { ring: r, edge: i }
      }
    }
    return null
  }, [canvasSize, rings, view])

  // --- mutation helpers -----------------------------------------------------

  const writeShape = useCallback((next, commit) => {
    if (commit) onCommit?.(next)
    else onChange?.(next)
  }, [onChange, onCommit])

  const replaceRing = useCallback((ringIndex, points, commit) => {
    const next = ringIndex === 0
      ? { outer: points, holes: shape?.holes || [] }
      : {
        outer: shape?.outer || [],
        holes: (shape?.holes || []).map((h, i) => (i === ringIndex - 1 ? points : h)),
      }
    writeShape(next, commit)
  }, [shape, writeShape])

  const finishDrawing = useCallback(points => {
    if (points.length >= 3) {
      if (drawing?.target === 'hole') {
        writeShape({ outer: shape?.outer || [], holes: [...(shape?.holes || []), points] }, true)
      } else {
        writeShape({ outer: points, holes: shape?.holes || [] }, true)
      }
    }
    setDrawing(null)
    setCursor(null)
  }, [drawing, shape, writeShape])

  const deleteSelected = useCallback(() => {
    if (!selection || selection.vertex === undefined) return
    const pts = rings[selection.ring]?.points
    if (!pts) return
    if (pts.length <= 3) {
      // Below three corners a ring bounds no area. Deleting a whole courtyard is
      // a sensible answer to that; deleting the whole plan is not.
      if (selection.ring > 0) {
        writeShape({
          outer: shape?.outer || [],
          holes: (shape?.holes || []).filter((_, i) => i !== selection.ring - 1),
        }, true)
        setSelection(null)
      }
      return
    }
    replaceRing(selection.ring, pts.filter((_, i) => i !== selection.vertex), true)
    setSelection(null)
  }, [replaceRing, rings, selection, shape, writeShape])

  // --- pointer handling -----------------------------------------------------

  const onPointerDown = useCallback(event => {
    if (disabled) return
    const canvas = canvasRef.current
    if (!canvas) return

    // Middle or right button pans. Kept off the left button so drawing never
    // fights with navigation.
    if (event.button === 1 || event.button === 2) {
      dragRef.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, origin: view }
      canvas.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }
    if (event.button !== 0) return

    const [px, py] = pointerPlan(event)

    if (drawing) {
      const pts = drawing.points
      // Closing the loop: click the first corner again.
      if (pts.length >= 3) {
        const rect = canvas.getBoundingClientRect()
        const [fx, fy] = planToScreen(pts[0][0], pts[0][1], view, canvasSize())
        if (distance(event.clientX - rect.left, event.clientY - rect.top, fx, fy) <= HIT_RADIUS) {
          finishDrawing(pts)
          return
        }
      }
      setDrawing({ ...drawing, points: [...pts, applyOrtho(snapPoint(px, py), pts)] })
      return
    }

    const hit = hitTest(event)
    if (hit?.vertex !== undefined) {
      setSelection(hit)
      dragRef.current = { kind: 'vertex', ring: hit.ring, vertex: hit.vertex }
      canvas.setPointerCapture(event.pointerId)
      return
    }
    if (hit?.edge !== undefined) {
      // Insert a corner where the edge was clicked, and start dragging it - the
      // action an author almost always wants next.
      const pts = rings[hit.ring].points
      const inserted = [...pts]
      inserted.splice(hit.edge + 1, 0, snapPoint(px, py))
      replaceRing(hit.ring, inserted, true)
      setSelection({ ring: hit.ring, vertex: hit.edge + 1 })
      dragRef.current = { kind: 'vertex', ring: hit.ring, vertex: hit.edge + 1 }
      canvas.setPointerCapture(event.pointerId)
      return
    }
    // Nothing under the pointer. Start a press that becomes a PAN if it moves
    // and a deselect if it does not.
    //
    // Left-drag pans because middle- and right-drag are not discoverable: with
    // the wheel broken and panning hidden behind a button most people never
    // press on a canvas, the view could not be moved at all. Deselecting is
    // still available on a click that does not travel, so nothing is lost.
    dragRef.current = {
      kind: 'maybe-pan',
      startX: event.clientX,
      startY: event.clientY,
      origin: view,
    }
    canvas.setPointerCapture(event.pointerId)
  }, [
    applyOrtho, canvasSize, disabled, drawing, finishDrawing, hitTest,
    pointerPlan, replaceRing, rings, snapPoint, view,
  ])

  const onPointerMove = useCallback(event => {
    const [px, py] = pointerPlan(event)
    setCursor(drawing ? applyOrtho(snapPoint(px, py), drawing.points) : [px, py])

    const drag = dragRef.current
    if (!drag) {
      if (!drawing) setHover(hitTest(event))
      return
    }

    if (drag.kind === 'maybe-pan') {
      // Below the slop this is still a click, so the view must not twitch.
      if (distance(event.clientX, event.clientY, drag.startX, drag.startY) < DRAG_SLOP) return
      drag.kind = 'pan'
    }

    if (drag.kind === 'pan') {
      const dx = (event.clientX - drag.startX) / drag.origin.scale
      const dy = (event.clientY - drag.startY) / drag.origin.scale
      setView({ ...drag.origin, panX: drag.origin.panX + dx, panY: drag.origin.panY - dy })
      return
    }

    if (drag.kind === 'vertex') {
      const pts = rings[drag.ring]?.points
      if (!pts) return
      const moved = [...pts]
      moved[drag.vertex] = snapPoint(px, py)
      // onChange, not onCommit: continuous while dragging, one undo entry at the
      // end. See the header.
      replaceRing(drag.ring, moved, false)
    }
  }, [applyOrtho, drawing, hitTest, pointerPlan, replaceRing, rings, snapPoint])

  const onPointerUp = useCallback(event => {
    const drag = dragRef.current
    dragRef.current = null
    // Guarded: releasePointerCapture throws NotFoundError when the pointer is no
    // longer active, which is the common case on a plain click, and an exception
    // here would abort the commit below.
    try {
      canvasRef.current?.releasePointerCapture?.(event.pointerId)
    } catch {
      // Nothing to release. Not a problem.
    }
    if (drag?.kind === 'vertex') {
      const pts = rings[drag.ring]?.points
      if (pts) replaceRing(drag.ring, pts, true)
    } else if (drag?.kind === 'maybe-pan') {
      // A press that never travelled: the deselect it stood in for.
      setSelection(null)
    }
  }, [replaceRing, rings])

  // WHEEL ZOOM IS A NATIVE, NON-PASSIVE LISTENER, and it has to be.
  //
  // React registers `onWheel` at the root as PASSIVE, so calling
  // preventDefault() from a JSX onWheel handler does nothing except log
  // "Unable to preventDefault inside passive event listener invocation" - once
  // per notch. The zoom then does not happen and the page scrolls instead,
  // which is what made the editor feel dead: a plan you cannot zoom to is a
  // plan you cannot work on. addEventListener with { passive: false } is the
  // only way to opt out.
  //
  // Zooming is anchored to the POINTER, not the centre. Zooming to the middle
  // of the viewport means the thing you are looking at slides away as you zoom
  // in, and you chase it with the pan - which is most of what "I can do
  // nothing" felt like.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined

    const onWheelNative = event => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const sx = event.clientX - rect.left
      const sy = event.clientY - rect.top
      const size = canvasSize()

      setView(v => {
        const factor = event.deltaY > 0 ? 0.88 : 1 / 0.88
        const scale = Math.max(2, Math.min(400, v.scale * factor))
        if (scale === v.scale) return v
        // Keep the plan point under the cursor pinned: solve screenToPlan for
        // the pan that leaves it unchanged at the new scale.
        const [planX, planY] = screenToPlan(sx, sy, v, size)
        return {
          scale,
          panX: (sx - size.width / 2) / scale - planX,
          panY: -((sy - size.height / 2) / scale) - planY,
        }
      })
    }

    canvas.addEventListener('wheel', onWheelNative, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheelNative)
  }, [canvasSize])

  // Escape cancels a draw, Delete removes the selected corner. Ignored while a
  // text field has focus so it cannot swallow the page's own typing.
  useEffect(() => {
    const onKeyDown = event => {
      const active = document.activeElement
      if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return
      if (event.key === 'Escape' && drawing) {
        setDrawing(null)
        setCursor(null)
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
        event.preventDefault()
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleteSelected, drawing, selection])

  const fit = useCallback(() => {
    const pts = rings.flatMap(r => r.points)
    if (pts.length === 0) return
    const xs = pts.map(p => p[0])
    const ys = pts.map(p => p[1])
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const size = canvasSize()
    const scale = Math.max(2, Math.min(200, 0.8 * Math.min(
      size.width / Math.max(maxX - minX, 1),
      size.height / Math.max(maxY - minY, 1),
    )))
    setView({ scale, panX: -(minX + maxX) / 2, panY: -(minY + maxY) / 2 })
  }, [canvasSize, rings])

  // FIT ON OPEN. The default plan is 12x8m and the default scale is 18px/m, so
  // without this it arrives as a small rectangle adrift in the top-right of a
  // large empty grid - which, with nothing obviously draggable under the
  // pointer, reads as an empty canvas. Runs once per mount, and only after the
  // canvas has a real size, so it cannot fight a view the author has set.
  const fittedRef = useRef(false)
  useEffect(() => {
    if (fittedRef.current) return
    if (!(rings[0]?.points?.length >= 3)) return
    // Deferred a frame rather than run inline: the canvas is sized by a layout
    // effect and a ResizeObserver, so the size this reads is only trustworthy
    // once the browser has laid out - and setting state straight from an effect
    // body cascades a render for no reason.
    const handle = requestAnimationFrame(() => {
      const size = canvasSize()
      if (size.width < 50 || size.height < 50) return
      fittedRef.current = true
      fit()
    })
    return () => cancelAnimationFrame(handle)
  }, [canvasSize, fit, rings])

  const canDrawHole = (shape?.outer?.length || 0) >= 3

  return (
    <div className="planedit">
      <div className="planedit__toolbar">
        <button
          type="button"
          className={`planedit__tool ${drawing?.target === 'outer' ? 'planedit__tool--on' : ''}`}
          onClick={() => setDrawing(drawing ? null : { target: 'outer', points: [] })}
          disabled={disabled}
          title="Draw a new outline, replacing the current one"
        >
          <span className="material-symbols-outlined">timeline</span>
          Outline
        </button>
        <button
          type="button"
          className={`planedit__tool ${drawing?.target === 'hole' ? 'planedit__tool--on' : ''}`}
          onClick={() => setDrawing(drawing?.target === 'hole' ? null : { target: 'hole', points: [] })}
          disabled={disabled || !canDrawHole}
          title="Draw a courtyard inside the outline"
        >
          <span className="material-symbols-outlined">crop_free</span>
          Courtyard
        </button>
        <span className="planedit__sep" />
        <button
          type="button"
          className={`planedit__tool ${snap ? 'planedit__tool--on' : ''}`}
          onClick={() => setSnap(v => !v)}
          title={`Snap to a ${gridSize}m grid`}
        >
          <span className="material-symbols-outlined">grid_4x4</span>
          {gridSize}m
        </button>
        <button
          type="button"
          className={`planedit__tool ${ortho ? 'planedit__tool--on' : ''}`}
          onClick={() => setOrtho(v => !v)}
          title="Constrain new edges to 45-degree steps"
        >
          <span className="material-symbols-outlined">square_foot</span>
          Ortho
        </button>
        <span className="planedit__sep" />
        <button type="button" className="planedit__tool" onClick={fit} title="Fit the plan in view">
          <span className="material-symbols-outlined">fit_screen</span>
        </button>
        <button
          type="button"
          className="planedit__tool"
          onClick={deleteSelected}
          disabled={!selection || selection.vertex === undefined}
          title="Delete the selected corner"
        >
          <span className="material-symbols-outlined">delete</span>
        </button>
        <span className="planedit__hint">
          {drawing
            ? 'Click to place corners. Click the first corner, or press Escape, to finish.'
            : 'Drag a corner to move it · click an edge to add one · drag the background to pan · scroll to zoom · Outline draws a new plan'}
        </span>
      </div>

      <div className="planedit__canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="planedit__canvas"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={() => drawing && finishDrawing(drawing.points)}
          onContextMenu={event => event.preventDefault()}
        />
        {cursor && (
          <div className="planedit__readout">
            {cursor[0].toFixed(2)}, {cursor[1].toFixed(2)} m
          </div>
        )}
      </div>
    </div>
  )
}
