// The building document: what a .building.json file contains, and the only
// definition of its shape. Pure functions over plain JSON - no React, no
// three.js, no I/O - the same division of labour vfx/doc.js has with VFX graphs
// and src/utils/assemblyHelpers.js has with MeshAssemblies.
//
// The server stores this file verbatim under data/assets/buildings/ and mirrors
// a small digest of it into the Assets.metadata column. It is a FILE and not a
// metadata blob for a reason worth knowing before anyone tries to move it:
// storage.js MERGES metadata rather than replacing it (replaceAssetFileById), so
// a document held there could never lose a key. Delete a node, save, reload, and
// the node would come back. A file is replaced whole.
//
// FOUR INVARIANTS. Each has a plausible-looking alternative that breaks
// something specific. They are the same four vfx/doc.js states, for the same
// reasons, and the two files should be changed together if any of them ever
// stops being true.
//
//  1. `edges` IS AUTHORITATIVE FOR WIRING. A node input that is driven by
//     another node also carries `linked: true` on its prop so the inspector can
//     label the row without scanning every edge per render, but that mirror is
//     DERIVED. normalizeBuildingDoc rebuilds it from edges every time, so the
//     two can never drift apart, and no other code may write it directly.
//
//  2. `layout` IS NEVER READ BY THE COMPILER. Node positions, collapsed flags,
//     pane widths - all cosmetic. buildingSignature() omits them, which is what
//     makes the signature usable as a recompile trigger: dragging a node around
//     must not rebuild the building. A building is more expensive to rebuild
//     than a particle system, so this matters more here than it does in VFX.
//
//  3. ASSET REFERENCES ARE SLOT KEYS, RESOLVED THROUGH ONE TABLE. A node says
//     'tex_facade', and doc.references maps that to an asset. This gives the
//     bundle builder one place to walk, project import one place to remap, and
//     turns a deleted texture into a dangling KEY - reportable and repairable in
//     the editor - rather than a dangling asset id nobody can trace.
//
//  4. EVERY REFERENCE IS THE STRING 'asset:<id>'. Not a bare number.
//     storage.js's collectAssetIdsFromValue and remapReferencesDeep both match
//     /^asset:(\d+)$/ against strings, so this shape makes a .3dgp project
//     export carry a building's textures and project import renumber them with
//     ZERO changes to either walker. Tree presets store bare numbers and
//     therefore ship broken across installations - the reference file is
//     src/utils/treeGen.js, and it is the mistake this invariant exists to avoid
//     repeating.
//
// WHERE THE FOOTPRINT LIVES. In a Footprint node's props, not at the top level.
// That looked like an odd choice at first - the footprint feels like a property
// of the building - but putting it in the graph is what allows more than one
// (a main block plus a wing), lets it be the output of a node rather than always
// hand-drawn, and means undo/redo, copy/paste and the inspector all work on it
// with no special cases. The plan editor edits whichever Footprint node is
// selected.

/**
 * Document format version. Bump when a change cannot be read by the previous
 * normaliser, and add a MIGRATIONS entry in the same commit.
 */
export const BUILDING_DOC_FORMAT = 1;

/** The `kind` discriminator, used to recognise the file on import. */
export const BUILDING_DOC_KIND = 'building-graph';

/** Units are metres, everywhere, always. Stored so a reader never has to guess. */
export const BUILDING_UNITS = 'm';

/** Seeds are uint32. 0 is a legal seed and is not treated as "unset". */
export const MAX_SEED = 0xffffffff;

/**
 * What a reference slot can point at.
 *
 * `profile` is a trim cross-section (a small JSON curve), not an image - it is
 * listed here because a style pack binds it through the same table as a texture,
 * and giving it its own kind is what lets the editor show the right picker.
 */
export const REFERENCE_KIND = {
  IMAGE: 'image',
  MESH: 'mesh',
  PROFILE: 'profile',
};

const REFERENCE_KINDS = new Set(Object.values(REFERENCE_KIND));

/** Matches a well-formed reference. Invariant 4 in one regex. */
export const ASSET_REF_PATTERN = /^asset:(\d+)$/;

const isObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toUint32(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(Math.abs(n)) % (MAX_SEED + 1);
}

function toSafeString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/**
 * A new, empty document.
 *
 * Deliberately has NO nodes. An empty board with the palette open says "add a
 * footprint" far more clearly than a pre-wired graph the author now has to read
 * and decide whether to keep - and the templates that DO pre-wire a graph live
 * in the style packs, where they can differ per style.
 */
export function createBuildingDoc(overrides = {}) {
  return normalizeBuildingDoc({
    format: BUILDING_DOC_FORMAT,
    kind: BUILDING_DOC_KIND,
    name: 'Untitled Building',
    savedAt: 0,
    building: { seed: 12345, units: BUILDING_UNITS, stylePackId: null, overrides: {} },
    nodes: [],
    edges: [],
    exposed: {},
    references: {},
    layout: { nodes: {}, notes: [] },
    ...overrides,
  });
}

function normalizeReferenceEntry(entry) {
  if (!isObject(entry)) return null;

  // Three cases, and the difference between the second and third is invariant 4.
  //
  //   absent / ''  an EMPTY slot: legal and meaningful. The author declared it
  //                but has not filled it, or a bundle could not supply it.
  //                Dropping it would lose the slot itself and the editor would
  //                have nothing to show as "needs a texture".
  //   'asset:<n>'  a real reference.
  //   anything else  REJECTED, entry and all.
  //
  // The third case must not be coerced into the first. A bare number 12 - the
  // tree-preset mistake - would otherwise become an empty slot: the reference
  // silently disappears, the building renders untextured, and nothing anywhere
  // says why. Rejecting the whole entry makes it a visible missing slot instead.
  const hasRef = entry.ref !== undefined && entry.ref !== null && entry.ref !== '';
  if (hasRef && (typeof entry.ref !== 'string' || !ASSET_REF_PATTERN.test(entry.ref))) return null;
  const ref = hasRef ? entry.ref : '';
  const kind = REFERENCE_KINDS.has(entry.kind) ? entry.kind : REFERENCE_KIND.IMAGE;
  const out = { kind, ref, name: toSafeString(entry.name, '') };
  // Only images carry a colour space, and only when it is one of the two values
  // that mean anything. An albedo texture is sRGB; a mask or a height map is not,
  // and getting it wrong is a visible gamma error rather than a crash.
  if (kind === REFERENCE_KIND.IMAGE && (entry.colorSpace === 'srgb' || entry.colorSpace === 'linear')) {
    out.colorSpace = entry.colorSpace;
  }
  return out;
}

function normalizeNode(node) {
  if (!isObject(node)) return null;
  const id = toSafeString(node.id, '');
  const type = toSafeString(node.type, '');
  if (!id || !type) return null;
  return {
    id,
    type,
    // Disabled nodes stay in the document and are skipped by the compiler, so
    // muting a node is not the same as deleting it and does not lose its props.
    enabled: node.enabled !== false,
    props: isObject(node.props) ? { ...node.props } : {},
    modes: isObject(node.modes) ? { ...node.modes } : {},
  };
}

function normalizeEdge(edge, knownNodeIds) {
  if (!isObject(edge)) return null;
  const from = isObject(edge.from) ? edge.from : null;
  const to = isObject(edge.to) ? edge.to : null;
  if (!from || !to) return null;
  const fromNode = toSafeString(from.node, '');
  const toNode = toSafeString(to.node, '');
  const fromPort = toSafeString(from.port, 'out');
  const toPort = toSafeString(to.port, '');
  if (!fromNode || !toNode || !toPort) return null;
  // An edge to or from a node that no longer exists is dropped rather than kept
  // as a tombstone: the alternative is every downstream pass having to test for
  // it, and a graph that renders an edge into empty space.
  if (!knownNodeIds.has(fromNode) || !knownNodeIds.has(toNode)) return null;
  if (fromNode === toNode) return null;
  return {
    id: toSafeString(edge.id, `${fromNode}:${fromPort}->${toNode}:${toPort}`),
    from: { node: fromNode, port: fromPort },
    to: { node: toNode, port: toPort },
  };
}

/**
 * Bring any parsed JSON up to the shape the rest of the code assumes.
 *
 * Total, never throws, and safe to run on a document that is already normal -
 * the editor calls it after every mutation. Anything unrecognisable is dropped
 * rather than repaired into a guess, because a silently "fixed" document is
 * harder to diagnose than a missing node.
 */
export function normalizeBuildingDoc(input) {
  const raw = isObject(input) ? input : {};
  const migrated = migrateBuildingDoc(raw);

  const building = isObject(migrated.building) ? migrated.building : {};
  const nodes = (Array.isArray(migrated.nodes) ? migrated.nodes : [])
    .map(normalizeNode)
    .filter(Boolean);

  // De-duplicate by id, keeping the first. Two nodes with one id is not
  // representable downstream (every lookup is by id) and can only come from a
  // hand-edited file or a bad merge.
  const seen = new Set();
  const uniqueNodes = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    uniqueNodes.push(node);
  }

  const edges = (Array.isArray(migrated.edges) ? migrated.edges : [])
    .map(edge => normalizeEdge(edge, seen))
    .filter(Boolean);

  // One driver per input. A second edge into an occupied port is dropped rather
  // than allowed to race: which one wins would depend on array order, and array
  // order is not something the author can see or control.
  const occupied = new Set();
  const uniqueEdges = [];
  for (const edge of edges) {
    const key = `${edge.to.node} ${edge.to.port}`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    uniqueEdges.push(edge);
  }

  // INVARIANT 1: rebuild the derived `linked` mirror from edges, every time.
  const linkedByNode = new Map();
  for (const edge of uniqueEdges) {
    if (!linkedByNode.has(edge.to.node)) linkedByNode.set(edge.to.node, new Set());
    linkedByNode.get(edge.to.node).add(edge.to.port);
  }
  for (const node of uniqueNodes) {
    const linked = linkedByNode.get(node.id);
    node.linked = linked ? [...linked].sort() : [];
  }

  const references = {};
  if (isObject(migrated.references)) {
    for (const [key, entry] of Object.entries(migrated.references)) {
      const normalized = normalizeReferenceEntry(entry);
      if (normalized) references[key] = normalized;
    }
  }

  const layoutNodes = {};
  const rawLayout = isObject(migrated.layout) ? migrated.layout : {};
  if (isObject(rawLayout.nodes)) {
    for (const [id, pos] of Object.entries(rawLayout.nodes)) {
      if (!isObject(pos)) continue;
      const x = toFiniteNumber(pos.x, null);
      const y = toFiniteNumber(pos.y, null);
      if (x === null || y === null) continue;
      layoutNodes[id] = { x, y };
    }
  }

  return {
    format: BUILDING_DOC_FORMAT,
    kind: BUILDING_DOC_KIND,
    name: toSafeString(migrated.name, 'Untitled Building'),
    savedAt: toFiniteNumber(migrated.savedAt, 0),
    building: {
      seed: toUint32(building.seed, 12345),
      units: BUILDING_UNITS,
      stylePackId: typeof building.stylePackId === 'string' ? building.stylePackId : null,
      overrides: isObject(building.overrides) ? { ...building.overrides } : {},
    },
    nodes: uniqueNodes,
    edges: uniqueEdges,
    exposed: isObject(migrated.exposed) ? { ...migrated.exposed } : {},
    references,
    layout: {
      nodes: layoutNodes,
      notes: Array.isArray(rawLayout.notes) ? rawLayout.notes.filter(isObject) : [],
    },
  };
}

/**
 * Upgrade an older document in place.
 *
 * Empty at format 1 and kept anyway, so the first migration has an obvious home
 * and the call site in normalizeBuildingDoc never has to be added later.
 */
export function migrateBuildingDoc(doc) {
  return doc;
}

// Canonical JSON: object keys in sorted order, so two structurally identical
// documents serialise to the same string regardless of the order their keys
// happened to be created in. Plain JSON.stringify preserves insertion order,
// which would make the signature change when a node's props were rebuilt in a
// different order by an edit - a spurious recompile on every inspector edit.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  // undefined is not representable in JSON and must not silently become null in
  // one place and vanish in another; normalisation should have removed it.
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

/**
 * A string that changes exactly when the GEOMETRY would change.
 *
 * INVARIANT 2 lives here: `layout` and `savedAt` are excluded, so dragging a
 * node or saving the file does not trigger a rebuild. The editor compares this
 * against the last compiled signature and only recompiles when it differs, which
 * is what makes a 40-storey building draggable at all.
 */
export function buildingSignature(doc) {
  const d = normalizeBuildingDoc(doc);
  return canonical({
    format: d.format,
    building: d.building,
    nodes: d.nodes,
    edges: d.edges,
    exposed: d.exposed,
    references: d.references,
  });
}

/** The document as the bytes that go in the file. Stable key order. */
export function serializeBuildingDoc(doc, { pretty = true } = {}) {
  const d = normalizeBuildingDoc(doc);
  return pretty ? JSON.stringify(d, null, 2) : JSON.stringify(d);
}

/** Parse a file's bytes, returning null rather than throwing on anything odd. */
export function parseBuildingDoc(text) {
  let parsed;
  try {
    parsed = JSON.parse(typeof text === 'string' ? text : String(text));
  } catch {
    return null;
  }
  if (!looksLikeBuildingDoc(parsed)) return null;
  return normalizeBuildingDoc(parsed);
}

/**
 * Recognise a building document by STRUCTURE, not by a version number alone -
 * every other JSON in this app has one of those too.
 */
export function looksLikeBuildingDoc(parsed) {
  if (!isObject(parsed)) return false;
  if (parsed.kind === BUILDING_DOC_KIND) return true;
  return Array.isArray(parsed.nodes)
    && Array.isArray(parsed.edges)
    && isObject(parsed.building);
}

/** Every asset id the document references, as numbers. */
export function collectReferenceIds(doc) {
  const ids = new Set();
  for (const entry of Object.values(normalizeBuildingDoc(doc).references)) {
    const match = ASSET_REF_PATTERN.exec(entry.ref || '');
    if (match) ids.add(Number(match[1]));
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Reference slots that are declared but empty.
 *
 * Reported, not repaired: an empty slot is a normal authoring state (the style
 * pack has not been bound yet), and the editor wants to show it as a to-do
 * rather than have the compiler invent a texture.
 */
export function danglingReferences(doc) {
  const out = [];
  for (const [key, entry] of Object.entries(normalizeBuildingDoc(doc).references)) {
    if (!entry.ref) out.push({ key, kind: entry.kind, name: entry.name });
  }
  return out;
}

/** A copy of the document with one reference slot set. */
export function setReference(doc, key, entry) {
  const d = normalizeBuildingDoc(doc);
  const normalized = normalizeReferenceEntry(entry);
  if (!normalized) return d;
  return { ...d, references: { ...d.references, [key]: normalized } };
}

/** A copy of the document with one reference slot removed. */
export function clearReference(doc, key) {
  const d = normalizeBuildingDoc(doc);
  if (!(key in d.references)) return d;
  const references = { ...d.references };
  delete references[key];
  return { ...d, references };
}

/** The node with this id, or null. */
export function findNode(doc, nodeId) {
  return normalizeBuildingDoc(doc).nodes.find(n => n.id === nodeId) || null;
}

/** Every node of a given type, in document order. */
export function nodesOfType(doc, type) {
  return normalizeBuildingDoc(doc).nodes.filter(n => n.type === type);
}

/**
 * The small summary mirrored into the Assets.metadata column.
 *
 * Deliberately shallow: it exists so the Assets page can show a tile and so
 * project export can find dependencies WITHOUT parsing the whole document. The
 * reference arrays hold 'asset:<id>' STRINGS because that is the shape
 * storage.js's walkers match - invariant 4, in the one place it is most tempting
 * to store a bare number because "it is only metadata".
 */
export function buildingAssetDigest(doc) {
  const d = normalizeBuildingDoc(doc);
  const imageRefs = [];
  const meshRefs = [];
  const profileRefs = [];
  for (const entry of Object.values(d.references)) {
    if (!entry.ref) continue;
    if (entry.kind === REFERENCE_KIND.MESH) meshRefs.push(entry.ref);
    else if (entry.kind === REFERENCE_KIND.PROFILE) profileRefs.push(entry.ref);
    else imageRefs.push(entry.ref);
  }
  return {
    kind: BUILDING_DOC_KIND,
    format: d.format,
    name: d.name,
    seed: d.building.seed,
    stylePackId: d.building.stylePackId,
    nodeCount: d.nodes.length,
    edgeCount: d.edges.length,
    imageRefs,
    meshRefs,
    profileRefs,
  };
}
