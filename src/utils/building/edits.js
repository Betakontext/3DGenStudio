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
  const output = createNode('output', nextNodeId('output'))

  return {
    nodes: [footprint, mass, facade, output],
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
        id: `${facade.id}:out->${output.id}:building`,
        from: { node: facade.id, port: 'out' },
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
  return out
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
