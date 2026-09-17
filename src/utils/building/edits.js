// Every mutation of a building document, as a pure function.
//
// doc -> doc, no mutation of the input, no React, no I/O. The editor calls these
// through useBuildingDocument.commit, which normalises the result and records one
// undo entry - so an edit here never has to think about history, and history
// never has to know what an edit does.
//
// NODE IDS ARE NOT SEEDED RANDOMNESS, and that distinction matters because
// eslint bans Math.random under this directory. A node id is document IDENTITY -
// it has to be unique within one document and is never used to make a geometric
// choice - whereas building/random.js exists for the choices that DO affect
// geometry and must replay identically. Mixing the two up in either direction is
// the mistake the guard is there to catch: an id derived from a seed would
// collide across documents, and a window variant derived from a timestamp would
// change every time the page reloaded.

import {
  DEFAULT_FOOTPRINT, createNode, getNodeDef, getPort,
} from '../../../building/catalog.js'
import { normalizeBuildingDoc } from '../../../building/doc.js'
import { PALETTE_SLOTS } from '../../../building/stylepack.js'

// Monotonic within a session; the timestamp keeps two sessions apart and the
// counter keeps two nodes made in the same millisecond apart.
let idCounter = 0
function nextNodeId(prefix = 'node') {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

/**
 * The graph a new document opens with.
 *
 * A new document deliberately has NO nodes (see building/doc.js), but an empty
 * board is only the right first impression once there is a palette to fill it
 * from. Until then the page seeds this, so opening the generator shows a
 * building immediately - the difference between a tool that works and a tool
 * the author cannot tell is working.
 */
export function createStarterGraph() {
  const footprint = createNode('footprint', nextNodeId('footprint'))
  footprint.props.shape = JSON.parse(JSON.stringify(DEFAULT_FOOTPRINT))
  const mass = createNode('mass', nextNodeId('mass'))
  const facade = createNode('facade', nextNodeId('facade'))
  const roof = createNode('roof', nextNodeId('roof'))
  const output = createNode('output', nextNodeId('output'))

  return {
    nodes: [footprint, mass, facade, roof, output],
    edges: [
      {
        id: `${footprint.id}:out->${mass.id}:shape`,
        from: { node: footprint.id, port: 'out' },
        to: { node: mass.id, port: 'shape' },
      },
      {
        id: `${mass.id}:out->${facade.id}:building`,
        from: { node: mass.id, port: 'out' },
        to: { node: facade.id, port: 'building' },
      },
      {
        id: `${facade.id}:out->${roof.id}:building`,
        from: { node: facade.id, port: 'out' },
        to: { node: roof.id, port: 'building' },
      },
      {
        id: `${roof.id}:out->${output.id}:building`,
        from: { node: roof.id, port: 'out' },
        to: { node: output.id, port: 'building' },
      },
    ],
  }
}

/** A document with the starter graph, if it has no nodes yet. */
export function ensureStarterGraph(doc) {
  const d = normalizeBuildingDoc(doc)
  if (d.nodes.length > 0) return d
  const { nodes, edges } = createStarterGraph()
  return normalizeBuildingDoc({ ...d, nodes, edges })
}

/**
 * The nodes in PIPELINE order rather than in the order they were created.
 *
 * A building graph is read as a sequence - footprint, mass, facade, output - and
 * the node list is the only place most authoring happens until there is a board
 * to drag on. Array order is creation order, so inserting a second Facade put it
 * after the Output in the list even though the edges were right: the list said
 * one thing and the building did another, and picking the wrong row was then the
 * obvious mistake to make.
 *
 * A depth-first walk from the roots, which for a pipeline is simply the chain.
 * Anything unreachable - a node an author disconnected but has not deleted -
 * keeps its creation order and follows at the end, so nothing ever disappears
 * from the list.
 */
export function orderedNodes(doc) {
  const d = normalizeBuildingDoc(doc)
  const byId = new Map(d.nodes.map(node => [node.id, node]))
  const outgoing = new Map(d.nodes.map(node => [node.id, []]))
  const indegree = new Map(d.nodes.map(node => [node.id, 0]))

  for (const edge of d.edges) {
    if (!outgoing.has(edge.from.node) || !indegree.has(edge.to.node)) continue
    outgoing.get(edge.from.node).push(edge.to.node)
    indegree.set(edge.to.node, indegree.get(edge.to.node) + 1)
  }

  const out = []
  const seen = new Set()
  const walk = id => {
    if (seen.has(id)) return
    seen.add(id)
    out.push(byId.get(id))
    // Sorted, so the order does not depend on which edge happened to be stored
    // first when one node feeds several.
    for (const next of [...outgoing.get(id)].sort()) walk(next)
  }

  for (const node of d.nodes) if (indegree.get(node.id) === 0) walk(node.id)
  for (const node of d.nodes) if (!seen.has(node.id)) out.push(node)

  // THE OUTPUT GOES LAST, whatever the walk found. With a Merge in the graph the
  // main chain reaches the Output before the walk has started on the wing's
  // Footprint, so the list read "... Merge, Output, Footprint, Mass, Roof" - an
  // end in the middle, which reads as a broken graph rather than a branched one.
  const output = out.filter(node => node?.type === 'output')
  if (!output.length) return out
  return [...out.filter(node => node?.type !== 'output'), ...output]
}

/** Set one property on one node. */
export function setNodeProp(doc, nodeId, key, value) {
  const d = normalizeBuildingDoc(doc)
  return normalizeBuildingDoc({
    ...d,
    nodes: d.nodes.map(node => (node.id === nodeId
      ? { ...node, props: { ...node.props, [key]: value } }
      : node)),
  })
}

/** Set one mode on one node. */
export function setNodeMode(doc, nodeId, key, value) {
  const d = normalizeBuildingDoc(doc)
  return normalizeBuildingDoc({
    ...d,
    nodes: d.nodes.map(node => (node.id === nodeId
      ? { ...node, modes: { ...node.modes, [key]: value } }
      : node)),
  })
}

/** Mute or unmute a node. */
export function setNodeEnabled(doc, nodeId, enabled) {
  const d = normalizeBuildingDoc(doc)
  return normalizeBuildingDoc({
    ...d,
    nodes: d.nodes.map(node => (node.id === nodeId ? { ...node, enabled: Boolean(enabled) } : node)),
  })
}

/** Rename the building. */
export function setBuildingName(doc, name) {
  return normalizeBuildingDoc({ ...normalizeBuildingDoc(doc), name: String(name || '') })
}

/** Set the document seed. */
export function setSeed(doc, seed) {
  const d = normalizeBuildingDoc(doc)
  return normalizeBuildingDoc({ ...d, building: { ...d.building, seed } })
}

/**
 * Add a node, and wire it up when there is an unambiguous place for it.
 *
 * Auto-wiring is deliberately conservative: it connects only when exactly one
 * existing node has a free output of the right kind. Guessing harder produces
 * edges the author did not ask for and then has to find and delete, which is
 * worse than no edge at all.
 */
export function addNode(doc, type, { position = null, connectFrom = null } = {}) {
  const d = normalizeBuildingDoc(doc)
  const def = getNodeDef(type)
  if (!def) return d
  if (def.singleton && d.nodes.some(node => node.type === type)) return d

  const node = createNode(type, nextNodeId(type))
  const nodes = [...d.nodes, node]
  const edges = [...d.edges]

  const input = def.inputs?.[0]
  if (input && connectFrom) {
    const source = d.nodes.find(candidate => candidate.id === connectFrom)
    const sourcePort = source && getNodeDef(source.type)?.outputs?.[0]
    if (sourcePort && sourcePort.kind === input.kind) {
      edges.push({
        id: `${source.id}:${sourcePort.id}->${node.id}:${input.id}`,
        from: { node: source.id, port: sourcePort.id },
        to: { node: node.id, port: input.id },
      })
    }
  }

  const layout = position
    ? { ...d.layout, nodes: { ...d.layout.nodes, [node.id]: position } }
    : d.layout

  return normalizeBuildingDoc({ ...d, nodes, edges, layout })
}

/**
 * Insert a node into the chain, directly after another.
 *
 * THE OPERATION THE GRAPH IS ACTUALLY USED FOR. A building is a pipeline -
 * footprint, mass, facade, output - so "add a node" almost always means "put one
 * more step in the chain here", not "drop one loose on the board and wire it up
 * myself". Adding a second Facade to give the ground floor a shopfront is
 * exactly this, and making the author reconnect three edges by hand to do it
 * would be the difference between a feature people use and one they do not.
 *
 * Splices rather than appends: whatever `afterId` was feeding is re-pointed at
 * the new node, so `mass -> output` becomes `mass -> facade -> output` in one
 * step and nothing is left dangling.
 */
export function insertNodeAfter(doc, afterId, type) {
  const d = normalizeBuildingDoc(doc)
  const def = getNodeDef(type)
  const source = d.nodes.find(node => node.id === afterId)
  if (!def || !source) return d
  if (def.singleton && d.nodes.some(node => node.type === type)) return d

  const sourcePort = getNodeDef(source.type)?.outputs?.[0]
  const input = def.inputs?.[0]
  const output = def.outputs?.[0]
  // Only insertable where the kinds line up on both sides; anything else would
  // produce a chain the compiler immediately rejects.
  if (!sourcePort || !input || sourcePort.kind !== input.kind) return d

  const node = createNode(type, nextNodeId(type))
  const downstream = d.edges.filter(edge => edge.from.node === afterId && edge.from.port === sourcePort.id)

  const edges = d.edges.filter(edge => !downstream.includes(edge))
  edges.push({
    id: `${afterId}:${sourcePort.id}->${node.id}:${input.id}`,
    from: { node: afterId, port: sourcePort.id },
    to: { node: node.id, port: input.id },
  })
  // Re-point everything the source was feeding, but only where the new node can
  // actually supply it.
  for (const edge of downstream) {
    const target = d.nodes.find(candidate => candidate.id === edge.to.node)
    const targetPort = target && getPort(target.type, edge.to.port, 'in')
    if (output && targetPort && targetPort.kind === output.kind) {
      edges.push({
        id: `${node.id}:${output.id}->${edge.to.node}:${edge.to.port}`,
        from: { node: node.id, port: output.id },
        to: { node: edge.to.node, port: edge.to.port },
      })
    } else {
      edges.push(edge)
    }
  }

  return normalizeBuildingDoc({ ...d, nodes: [...d.nodes, node], edges })
}

/**
 * Turn a bound model.
 *
 * ON THE REFERENCE, so every opening wearing that model gets the same
 * correction and a second model in the same list keeps its own. A balcony
 * exported lying down needs a quarter turn wherever it is used, and the slot it
 * sits in is not what was wrong with it.
 */
export function setMeshRotation(doc, key, rotation) {
  const d = normalizeBuildingDoc(doc)
  const entry = d.references[key]
  if (!entry || entry.kind !== 'mesh') return d
  const axes = [0, 1, 2].map(i => {
    const value = Number(rotation?.[i])
    return Number.isFinite(value) ? value : 0
  })
  return normalizeBuildingDoc({
    ...d,
    references: { ...d.references, [key]: { ...entry, rotation: axes } },
  })
}

/**
 * Resize a bound texture's tile, per axis.
 *
 * ON THE REFERENCE for the same reason a model's rotation is: how many metres
 * one tile covers is a property of the IMAGE, not of the slot it is dropped
 * into. Roof tiles photographed in ten courses and a plaster sample shot at a
 * metre want different numbers in the same slot, and a second texture in the
 * same list keeps its own.
 *
 * TWO AXES, because a wall is UV-mapped as (run, height) and a roof as plan
 * metres, so the horizontal and vertical repeats are independently meaningful -
 * courses of tile are wide and short, a timber board is long and narrow. Passing
 * a y equal to x stores nothing extra: "square" is what one number always meant.
 */
export function setReferenceTile(doc, key, tileMetres, tileMetresY) {
  const d = normalizeBuildingDoc(doc)
  const entry = d.references[key]
  if (!entry || entry.kind !== 'image') return d
  const clamp = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : fallback
  }
  const x = clamp(tileMetres, entry.tileMetres || 2)
  const y = clamp(tileMetresY, x)
  const next = { ...entry, tileMetres: x, tileMetresY: y }
  // normalizeBuildingDoc drops tileMetresY when it equals tileMetres, so a
  // document only carries the second number once it is actually doing something.
  return normalizeBuildingDoc({ ...d, references: { ...d.references, [key]: next } })
}

/**
 * Change one palette colour.
 *
 * WHY THE DOCUMENT AND NOT THE PACK. A style pack is a file on disk shared by
 * every building that uses it; what an author wants when they say "this timber
 * is the wrong brown" is to change THIS building. `building.style` is already
 * the per-document snapshot a pack leaves behind, normalizeStyleSnapshot already
 * validates it, and paletteOf already prefers it over the defaults - so the
 * colour belongs there and nothing else has to learn anything.
 *
 * It also works with NO pack applied, which is the case that made this
 * necessary: a document that has never had a style still has six slot colours,
 * they were simply unreachable.
 */
export function setPaletteColor(doc, slot, hex) {
  const d = normalizeBuildingDoc(doc)
  if (!PALETTE_SLOTS.includes(slot)) return d
  const value = String(hex || '').toLowerCase()
  if (!/^#[0-9a-f]{6}$/.test(value)) return d

  const style = d.building.style || { name: '', palette: {} }
  return normalizeBuildingDoc({
    ...d,
    building: {
      ...d.building,
      style: { ...style, palette: { ...style.palette, [slot]: value } },
    },
  })
}

/**
 * Drop every colour override, back to the pack's palette or to the defaults.
 *
 * Keeps the style NAME if there is one: the building is still a Roman Villa
 * after its owner has repainted it, and losing the name would make the style
 * picker read as if nothing were applied.
 */
export function resetPalette(doc) {
  const d = normalizeBuildingDoc(doc)
  const name = d.building.style?.name || ''
  return normalizeBuildingDoc({
    ...d,
    building: { ...d.building, style: name ? { name, palette: {} } : null },
  })
}

/**
 * Add a whole second building and merge it into this one.
 *
 * WHY THIS IS NOT A PALETTE ENTRY FOR THE MERGE NODE. A Merge takes TWO
 * buildings, and the palette's job is to splice one node into a chain: splicing
 * a Merge wires its first input and leaves the second dangling, which compiles
 * to "this node has nothing plugged into And" - a button whose only effect is an
 * error. What an author actually means by reaching for a Merge is "I want a
 * tower", and that is a Footprint, a Mass, a Roof and the Merge, wired.
 *
 * THE NEW WING GETS ITS OWN PLAN, offset clear of the existing one so the two
 * are not sitting inside each other in the plan editor. It is deliberately small
 * and square - a tower, a porch, a stair turret - because that is what a second
 * volume nearly always is, and because a wing the same size as the hall is
 * easier to drag out from small than to find inside big.
 */
export function addWing(doc) {
  const d = normalizeBuildingDoc(doc)
  const output = d.nodes.find(node => node.type === 'output')
  if (!output) return d

  // Whatever currently feeds the Output is the building the wing joins.
  const feed = d.edges.find(edge => edge.to.node === output.id && edge.to.port === 'building')
  if (!feed) return d

  // Clear of every existing plan, so the new footprint does not land on top of
  // one the author has already drawn.
  let maxX = 0
  for (const node of d.nodes) {
    if (node.type !== 'footprint') continue
    for (const point of node.props?.shape?.outer || []) maxX = Math.max(maxX, point[0])
  }

  const footprint = createNode('footprint', nextNodeId('footprint'))
  footprint.props.shape = {
    outer: [
      [maxX + 1, 1], [maxX + 6, 1], [maxX + 6, 6], [maxX + 1, 6],
    ],
    holes: [],
  }
  const mass = createNode('mass', nextNodeId('mass'))
  // A storey taller than nothing in particular: a tower reads as a tower by
  // being taller than the thing beside it, and 5 is taller than the starter 3.
  mass.props.levelCount = 5
  const roof = createNode('roof', nextNodeId('roof'))
  roof.modes.kind = 'hip'
  roof.props.pitch = 62
  const merge = createNode('merge', nextNodeId('merge'))

  // Laid out to the side of the existing graph rather than on top of it. Layout
  // is never read by the compiler - invariant 2 - so this is presentation only.
  let maxNodeX = 0
  for (const node of d.nodes) maxNodeX = Math.max(maxNodeX, node.layout?.x || 0)
  footprint.layout = { x: 40, y: (d.nodes.length + 2) * 90 }
  mass.layout = { x: 240, y: footprint.layout.y }
  roof.layout = { x: 440, y: footprint.layout.y }
  merge.layout = { x: maxNodeX + 200, y: (output.layout?.y || 0) + 60 }

  const edges = d.edges
    // The Output's feed is re-pointed through the Merge.
    .filter(edge => edge !== feed)
    .concat([
      {
        id: `${footprint.id}:out->${mass.id}:shape`,
        from: { node: footprint.id, port: 'out' },
        to: { node: mass.id, port: 'shape' },
      },
      {
        id: `${mass.id}:out->${roof.id}:building`,
        from: { node: mass.id, port: 'out' },
        to: { node: roof.id, port: 'building' },
      },
      {
        id: `${feed.from.node}:${feed.from.port}->${merge.id}:a`,
        from: { ...feed.from },
        to: { node: merge.id, port: 'a' },
      },
      {
        id: `${roof.id}:out->${merge.id}:b`,
        from: { node: roof.id, port: 'out' },
        to: { node: merge.id, port: 'b' },
      },
      {
        id: `${merge.id}:out->${output.id}:building`,
        from: { node: merge.id, port: 'out' },
        to: { node: output.id, port: 'building' },
      },
    ])

  return normalizeBuildingDoc({
    ...d,
    nodes: [...d.nodes, footprint, mass, roof, merge],
    edges,
  })
}

/**
 * Swap a node with its neighbour in the chain.
 *
 * WHY THIS WAS MISSING AND WHY IT MATTERS. Order is not cosmetic in this graph:
 * a Roof Detail reads the roof under it, a Trim reads the roof for its eave, a
 * Facade replaces the storeys it claims. Insert one in the wrong place and it
 * quietly does nothing - which is exactly how it was reported, as "I imported a
 * chimney and cannot see it". The palette appends after the selected node, so
 * the only fix available was to delete and re-add everything downstream.
 *
 * A SWAP, not a drag-and-drop reorder. Two adjacent nodes trade places and the
 * three edges around them are re-pointed; everything else is untouched. That
 * makes the operation total - there is no arrangement it can produce that the
 * graph could not already have - and it composes: pressing it twice moves a node
 * two places.
 *
 * REFUSED AT A BRANCH. A node with two building inputs (a Merge) or one feeding
 * two places has no single "previous", and guessing one would silently rewire a
 * wing into the wrong hall. Returns the document unchanged instead, and
 * canMoveNode says so in advance so the button is not offered.
 */
function chainNeighbours(d, nodeId) {
  const inputsOf = id => d.edges.filter(edge => edge.to.node === id)
  const outputsOf = id => d.edges.filter(edge => edge.from.node === id)

  const incoming = inputsOf(nodeId)
  const outgoing = outputsOf(nodeId)
  // Exactly one in and one out, or it is not a link in a chain.
  if (incoming.length !== 1 || outgoing.length !== 1) return null
  return { incoming: incoming[0], outgoing: outgoing[0] }
}

/** Whether moveNode would do anything, so the UI can grey the button. */
export function canMoveNode(doc, nodeId, direction) {
  const d = normalizeBuildingDoc(doc)
  const node = d.nodes.find(candidate => candidate.id === nodeId)
  if (!node) return false
  // A Footprint has no building input and an Output no output: neither is IN the
  // chain, they are its ends.
  if (node.type === 'footprint' || node.type === 'output') return false

  const here = chainNeighbours(d, nodeId)
  if (!here) return false
  const otherId = direction < 0 ? here.incoming.from.node : here.outgoing.to.node
  const other = d.nodes.find(candidate => candidate.id === otherId)
  if (!other || other.type === 'footprint' || other.type === 'output') return false
  if (!chainNeighbours(d, otherId)) return false

  // The kinds have to survive the swap. Moving a Facade above the Mass that
  // feeds it would leave a Shape plugged into a Building port.
  const port = getNodeDef(node.type)?.inputs?.[0]
  const otherPort = getNodeDef(other.type)?.inputs?.[0]
  return Boolean(port && otherPort && port.kind === otherPort.kind)
}

/**
 * Move a node one place earlier (-1) or later (+1) in the chain.
 *
 * @param {Object} doc
 * @param {string} nodeId
 * @param {number} direction -1 towards the Footprint, +1 towards the Output
 */
export function moveNode(doc, nodeId, direction) {
  const d = normalizeBuildingDoc(doc)
  if (!canMoveNode(d, nodeId, direction)) return d

  // Name them by position in the chain rather than by which one was asked for,
  // so the rewiring below reads once instead of twice with the arrows flipped.
  const here = chainNeighbours(d, nodeId)
  const otherId = direction < 0 ? here.incoming.from.node : here.outgoing.to.node
  const first = direction < 0 ? otherId : nodeId
  const second = direction < 0 ? nodeId : otherId

  const firstLinks = chainNeighbours(d, first)
  const secondLinks = chainNeighbours(d, second)
  const before = firstLinks.incoming
  const after = secondLinks.outgoing

  const touched = new Set([before, firstLinks.outgoing, after])
  const edges = d.edges.filter(edge => !touched.has(edge))

  const portOf = id => getNodeDef(d.nodes.find(n => n.id === id)?.type)?.inputs?.[0]?.id
    || 'building'
  const outOf = id => getNodeDef(d.nodes.find(n => n.id === id)?.type)?.outputs?.[0]?.id || 'out'

  // What fed `first` now feeds `second`; `second` feeds `first`; `first` feeds
  // whatever came after. Three edges, and the ports come from the catalog
  // because a Mass takes `shape` where everything else takes `building`.
  edges.push({
    id: `${before.from.node}:${before.from.port}->${second}:${portOf(second)}`,
    from: { ...before.from },
    to: { node: second, port: portOf(second) },
  })
  edges.push({
    id: `${second}:${outOf(second)}->${first}:${portOf(first)}`,
    from: { node: second, port: outOf(second) },
    to: { node: first, port: portOf(first) },
  })
  edges.push({
    id: `${first}:${outOf(first)}->${after.to.node}:${after.to.port}`,
    from: { node: first, port: outOf(first) },
    to: { ...after.to },
  })

  return normalizeBuildingDoc({ ...d, edges })
}

/**
 * Slide a node down the chain until a node of `type` is upstream of it.
 *
 * A SINGLE SWAP WAS NOT ENOUGH, and the label made that a lie: "Move it after
 * the Roof" moved a Roof Detail one place, which lands it after the Roof only
 * when it happened to sit directly before it. Repeating the swap until the
 * condition actually holds is what the button says it does.
 *
 * Bounded by the node count, so a graph this cannot satisfy stops rather than
 * spinning - and returns the last position it reached, which is closer than
 * where it started.
 */
export function moveNodeAfterType(doc, nodeId, type) {
  let current = normalizeBuildingDoc(doc)
  const upstreamHas = d => {
    const from = new Map()
    for (const edge of d.edges) if (!from.has(edge.to.node)) from.set(edge.to.node, edge.from.node)
    const byId = new Map(d.nodes.map(node => [node.id, node]))
    const seen = new Set()
    let at = from.get(nodeId)
    while (at && !seen.has(at)) {
      seen.add(at)
      if (byId.get(at)?.type === type) return true
      at = from.get(at)
    }
    return false
  }

  for (let i = 0; i < current.nodes.length && !upstreamHas(current); i++) {
    if (!canMoveNode(current, nodeId, 1)) break
    const next = moveNode(current, nodeId, 1)
    if (next === current) break
    current = next
  }
  return current
}

/**
 * Remove a node, healing the chain behind it.
 *
 * Deleting the middle of a pipeline should not sever it. Whatever fed the node
 * is reconnected to whatever it fed, where the kinds allow - so removing a
 * Facade leaves `mass -> output` rather than a building that stops compiling
 * until the author notices and rewires it.
 */
export function removeNode(doc, nodeId) {
  const d = normalizeBuildingDoc(doc)
  const node = d.nodes.find(candidate => candidate.id === nodeId)
  const layoutNodes = { ...d.layout.nodes }
  delete layoutNodes[nodeId]

  const edges = d.edges.filter(edge => edge.from.node !== nodeId && edge.to.node !== nodeId)

  if (node) {
    const def = getNodeDef(node.type)
    const inPort = def?.inputs?.[0]
    const outPort = def?.outputs?.[0]
    const upstream = inPort
      && d.edges.find(edge => edge.to.node === nodeId && edge.to.port === inPort.id)
    const downstream = outPort
      ? d.edges.filter(edge => edge.from.node === nodeId && edge.from.port === outPort.id)
      : []

    if (upstream) {
      const sourceNode = d.nodes.find(candidate => candidate.id === upstream.from.node)
      const sourcePort = sourceNode && getPort(sourceNode.type, upstream.from.port, 'out')
      for (const edge of downstream) {
        const target = d.nodes.find(candidate => candidate.id === edge.to.node)
        const targetPort = target && getPort(target.type, edge.to.port, 'in')
        if (sourcePort && targetPort && sourcePort.kind === targetPort.kind) {
          edges.push({
            id: `${upstream.from.node}:${upstream.from.port}->${edge.to.node}:${edge.to.port}`,
            from: { ...upstream.from },
            to: { ...edge.to },
          })
        }
      }
    }
  }

  return normalizeBuildingDoc({
    ...d,
    nodes: d.nodes.filter(candidate => candidate.id !== nodeId),
    edges,
    layout: { ...d.layout, nodes: layoutNodes },
  })
}

/**
 * Connect two ports.
 *
 * Refuses a kind mismatch rather than letting the compiler report it later: the
 * board can then decline the drop, which is a much clearer answer than an edge
 * that appears and then turns red.
 */
export function connect(doc, fromNode, fromPort, toNode, toPort) {
  const d = normalizeBuildingDoc(doc)
  const source = d.nodes.find(node => node.id === fromNode)
  const target = d.nodes.find(node => node.id === toNode)
  if (!source || !target) return d

  const out = getPort(source.type, fromPort, 'out')
  const input = getPort(target.type, toPort, 'in')
  if (!out || !input || out.kind !== input.kind) return d

  return normalizeBuildingDoc({
    ...d,
    // The existing driver of this input is dropped first. normalizeBuildingDoc
    // would keep the FIRST of two edges into one port, so appending without
    // removing would make the new connection silently do nothing.
    edges: [
      ...d.edges.filter(edge => !(edge.to.node === toNode && edge.to.port === toPort)),
      { id: `${fromNode}:${fromPort}->${toNode}:${toPort}`, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } },
    ],
  })
}

/** Remove whatever drives one input. */
export function disconnect(doc, toNode, toPort) {
  const d = normalizeBuildingDoc(doc)
  return normalizeBuildingDoc({
    ...d,
    edges: d.edges.filter(edge => !(edge.to.node === toNode && edge.to.port === toPort)),
  })
}

/** Move a node on the board. Cosmetic - the compiler never reads layout. */
export function setNodePosition(doc, nodeId, position) {
  const d = normalizeBuildingDoc(doc)
  return {
    ...d,
    layout: { ...d.layout, nodes: { ...d.layout.nodes, [nodeId]: position } },
  }
}

/** Replace the plan on a Footprint node. */
export function setFootprint(doc, nodeId, shape) {
  return setNodeProp(doc, nodeId, 'shape', shape)
}

// --- one-click fixes --------------------------------------------------------
//
// A diagnostic carries { label, action, args } rather than a function, so it
// survives JSON.stringify into an export bundle (see building/diagnostics.js).
// This registry is where those descriptors become edits. Each applier is an
// ordinary edit and therefore produces one undo entry like any other.

const FIX_APPLIERS = {
  addNode: (doc, args) => addNode(doc, args?.type),
  removeNode: (doc, args) => removeNode(doc, args?.nodeId),
  setProp: (doc, args) => setNodeProp(doc, args?.nodeId, args?.key, args?.value),
  setMode: (doc, args) => setNodeMode(doc, args?.nodeId, args?.key, args?.value),
  enableNode: (doc, args) => setNodeEnabled(doc, args?.nodeId, true),
  // A node in the wrong PLACE is the one diagnostic class no property change can
  // fix: a Roof Detail before the Roof reads no roof and silently places
  // nothing. Offering the move as a one-click fix is the difference between a
  // warning that explains the problem and one that solves it.
  moveNode: (doc, args) => moveNode(doc, args?.nodeId, Number(args?.direction) || 1),
  moveAfterType: (doc, args) => moveNodeAfterType(doc, args?.nodeId, args?.type),
}

/** Whether a fix descriptor can be applied by this build. */
export function canApplyFix(fixDescriptor) {
  return Boolean(fixDescriptor?.action && FIX_APPLIERS[fixDescriptor.action])
}

/**
 * Apply a fix descriptor.
 *
 * Returns the document unchanged when the action is unknown - a bundle written
 * by a newer build can carry a fix this one has never heard of, and refusing to
 * open it over that would be absurd.
 */
export function applyFix(doc, fixDescriptor) {
  const applier = FIX_APPLIERS[fixDescriptor?.action]
  if (!applier) return normalizeBuildingDoc(doc)
  return applier(normalizeBuildingDoc(doc), fixDescriptor.args || {})
}
