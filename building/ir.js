// BuildingIR: what the compiler emits and the mesher consumes.
//
// The same contract vfx/ir.js states, for the same reasons:
//
//   PLAIN JSON ONLY. No typed arrays, no NaN, no Infinity, no undefined. There
//   is a test that walks every fixture asserting it. The IR is written into an
//   export bundle and read by code that is not this code, so anything that does
//   not survive JSON.stringify -> JSON.parse is not allowed to exist in here.
//
//   EVERYTHING IS REFERENCED BY INDEX into flat arrays. A level names its
//   polygon as `polygon: 3`, not by embedding a copy. Two levels with the same
//   cross-section - every floor of a plain tower - therefore share one entry,
//   which is most of why a 40-storey building's IR is small.
//
//   ORDER IS MEANINGFUL AND STABLE. Recompiling an unchanged document must
//   produce a byte-identical IR, because that is what lets the editor skip work
//   and what makes a golden test possible at all. Every array here is built by
//   a deterministic walk; nothing is keyed on object iteration order.
//
// COORDINATES ARE Z-UP, and that is deliberate even though three.js is Y-up.
// A footprint is drawn in plan - X east, Y north - and a building rises in Z.
// Keeping the IR in the architectural convention means every calculation in
// mass.js, roof.js and grammar.js reads the way the drawing does, and the single
// axis swap happens once, at the meshing boundary in src/utils/building/mesh.js.
// The alternative - Y-up throughout - puts a sign error in every one of those
// files instead of a conversion in one.
//
// WHY THE IR EXISTS AT ALL, rather than the compiler building geometry directly:
// the preview, a headless thumbnail, an MCP tool answering "how many windows
// does this have", and a future engine exporter all want the same description
// and only one of them wants BufferGeometry. Splitting at a serialisable
// boundary is also what makes the compiler testable in plain node.

/**
 * IR format version. Bump when a consumer written against the previous version
 * would MISREAD this one - a renamed field, a changed unit, a reordered tuple.
 * Adding an optional array is not a bump.
 */
export const BUILDING_IR_FORMAT = 1;

/**
 * What a level is for. The mesher uses this to pick a material slot and the
 * grammar uses it to decide which facade rule applies.
 *
 * GROUND IS ITS OWN KIND because the ground floor is always a special case -
 * taller, with the door, usually a different material - and every architectural
 * grammar that pretends otherwise produces buildings that read as wrong without
 * the viewer being able to say why.
 */
export const LEVEL_KIND = {
  /** Below grade or a raised base course. */
  PLINTH: 'plinth',
  /** The ground floor. Always distinct - see above. */
  GROUND: 'ground',
  /** An ordinary upper storey. */
  UPPER: 'upper',
  /** A setback or crown storey at the top of a stack. */
  ATTIC: 'attic',
  /** Roof volume. Emitted by roof.js, not by the floor splitter. */
  ROOF: 'roof',
};

/** Slot types the grammar can tag. Phase 2 fills these in. */
export const SLOT_TYPE = {
  WINDOW: 'window',
  DOOR: 'door',
  /**
   * A balcony: an ATTACHMENT in front of an opening, not an opening itself.
   *
   * It is its own type rather than another `opening` tag because everything
   * about it is different in kind. It stands PROUD of the wall instead of being
   * recessed into it, its depth is a real dimension the author sets rather than
   * the fixed token depth a flat opening gets, it sits on the opening's sill
   * rather than centred in the band, and it coexists with the window behind it -
   * tagging an opening `balcony` would put a balustrade WHERE the window goes,
   * which is not what a balcony is.
   */
  BALCONY: 'balcony',
  /**
   * Something standing ON the roof: a chimney, a finial, a vent, a ridge crest.
   *
   * Its own type because it is the one slot with no storey - `floorIndex` is -1
   * - and because every consumer that reasons about walls (which side is it on,
   * which facade claimed it, does a material selector cover its floor) has to
   * leave it alone rather than get a plausible wrong answer.
   */
  ROOF_ITEM: 'roof_item',
  PILLAR: 'pillar',
  CORNICE: 'cornice',
  ROOF_EDGE: 'roof_edge',
  WALL: 'wall',
  SIGN: 'sign',
};

/**
 * Round a coordinate to the IR's storage precision.
 *
 * 1e-6 m is a micron: far below anything a building cares about, and far above
 * the float dust that makes two identical buildings serialise differently. This
 * is applied at the IR boundary rather than during the maths, so intermediate
 * calculations keep full precision and only the stored result is quantised.
 */
export function quantize(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

/**
 * A ring of [x, y] pairs as the flat array the IR stores.
 *
 * Flat here and paired in poly.js on purpose - see the header of poly.js. The
 * conversion is this function and `unflattenRing`, and those two are the only
 * places the representation changes.
 */
export function flattenRing(ring) {
  const out = [];
  for (const point of ring) {
    out.push(quantize(point[0]), quantize(point[1]));
  }
  return out;
}

/** The inverse of flattenRing. */
export function unflattenRing(flat) {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

/**
 * An interning table for polygons.
 *
 * Every floor of a plain tower has the same cross-section, so storing one per
 * level would make the IR grow linearly in storeys for no information. Interning
 * by a canonical string key collapses them to one entry, and the key is built
 * from the QUANTISED coordinates so two polygons that differ only by float dust
 * intern together rather than producing near-duplicate entries.
 */
export function createPolygonTable() {
  const polygons = [];
  const byKey = new Map();

  return {
    /**
     * Add a polygon, returning its index. Identical polygons share an index.
     * @param {{outer: Array<Array<number>>, holes?: Array<Array<Array<number>>>}} polygon
     * @returns {number}
     */
    intern(polygon) {
      const outer = flattenRing(polygon.outer || []);
      const holes = (polygon.holes || []).map(flattenRing);
      const key = `${outer.join(',')}|${holes.map(h => h.join(',')).join(';')}`;
      const existing = byKey.get(key);
      if (existing !== undefined) return existing;
      const index = polygons.length;
      polygons.push({ outer, holes });
      byKey.set(key, index);
      return index;
    },
    /** The interned table, in insertion order. */
    all() {
      return polygons;
    },
    get size() {
      return polygons.length;
    },
  };
}

/**
 * An empty IR. Every array is present even when unused, so a consumer can walk
 * `ir.slots` without testing for it - an absent array and an empty one mean the
 * same thing to a reader and only one of them needs a guard at every call site.
 */
export function createBuildingIr({ seed = 0 } = {}) {
  return {
    format: BUILDING_IR_FORMAT,
    seed: seed >>> 0,
    units: 'm',
    polygons: [],
    levels: [],
    solids: [],
    slots: [],
    trims: [],
    /**
     * Every roof, not one.
     *
     * A LIST because a Merge node joins two buildings and each brought its own -
     * a hall under a gable and its tower under a pyramid are two roofs on one
     * building, and there is no honest way to call either of them "the" roof.
     * The singular field it replaces is gone rather than kept as an alias: a
     * consumer reading `ir.roof` on a merged building would silently draw one of
     * the two and no one would know which.
     */
    roofs: [],
    // How the finished building is bent. A DESCRIPTOR, not baked coordinates:
    // the slots and trims in this IR are already warped, but walls and roofs are
    // generated from the 2D polygons by the consumer, which needs the function
    // to apply. See building/deform.js.
    deform: null,
    materials: [],
    references: {},
    /**
     * How a bound MODEL is turned, per reference key, in degrees.
     *
     * A parallel table rather than a field on the slot, because it is a property
     * of the ASSET: every opening wearing that model needs the same correction,
     * and they share one geometry. `references` stays a flat key -> 'asset:<n>'
     * map because storage.js's dependency walkers match on exactly that shape -
     * invariant 4 - so the turn could not live inside it.
     *
     * Absent for every model that was never turned, which is nearly all of them.
     */
    meshRotations: {},
    stats: {
      levelCount: 0,
      slotCount: 0,
      height: 0,
      footprintArea: 0,
      floorArea: 0,
    },
  };
}

/**
 * One horizontal slab.
 *
 * z0/z1 rather than z + height: the mesher, the grammar and the trim pass all
 * ask "what is the top of this" far more often than "how tall is it", and a
 * stack built by accumulating heights drifts by a float ulp per storey - which
 * on a 40-storey tower is a visible gap between the top floor and the roof.
 */
export function makeLevel({ polygon, z0, z1, kind = LEVEL_KIND.UPPER, index = 0 }) {
  return {
    polygon: polygon | 0,
    z0: quantize(z0),
    z1: quantize(z1),
    kind,
    // Counted from the GROUND, upward, always. building/random.js explains why:
    // numbering from the top would renumber every level below an inserted one
    // and reshuffle their seeded choices, which is the exact failure the
    // identity-hashed seeding exists to prevent.
    index: index | 0,
  };
}

/** A contiguous run of levels that reads as one volume. */
export function makeSolid({ levels = [], name = '' } = {}) {
  return { levels: levels.map(n => n | 0), name: String(name || '') };
}

/**
 * One placed instance.
 *
 * `transform` is a 16-number column-major 4x4, the layout three.js's
 * Matrix4.fromArray expects, so the mesher can hand it straight over. Stored
 * rather than derived because the deformation pass rewrites it, and a consumer
 * that re-derived it from (face, floor, bay) would silently undo the deformation.
 */
export function makeSlot({
  type, transform, styleSlot = '', cellW = 0, cellH = 0, cellD = 0,
  faceIndex = 0, floorIndex = 0, bayIndex = 0, seedKey = 0, variant = 0, meshSlot = '',
}) {
  return {
    type,
    styleSlot: String(styleSlot || ''),
    transform: transform.map(quantize),
    cellW: quantize(cellW),
    cellH: quantize(cellH),
    // HOW FAR IT STANDS OFF THE WALL, and ZERO MEANS "the consumer's own rule".
    // An opening has no authored depth - nothing in the grammar says how thick a
    // window is - so it keeps the token depth the mesher has always given it. A
    // balcony's projection is a real dimension the author set, and it has to
    // travel in the IR or a headless export would draw it as a flat panel.
    cellD: quantize(cellD),
    faceIndex: faceIndex | 0,
    floorIndex: floorIndex | 0,
    bayIndex: bayIndex | 0,
    seedKey: seedKey >>> 0,
    // WHICH LIST this opening draws its model from, as the reference PREFIX the
    // compiler resolved - `mesh_window`, or `fc1.openingMesh.north` when a
    // facade overrode one side. Resolved here rather than in the renderer so a
    // headless export and the preview agree, and stored as the prefix rather
    // than as a scope the consumer would have to re-derive.
    meshSlot: String(meshSlot || ''),
    // WHICH MODEL OF THAT LIST it wears. Also resolved by the compiler, from the
    // document's seed and the opening's own identity.
    variant: variant | 0,
  };
}

/**
 * One rung of a roof's contour ladder.
 *
 * `polygons` are indices into the shared polygon table, so a stepped roof whose
 * tread and riser are the same shape stores it once. See building/roof.js for
 * what the three consecutive-rung cases mean.
 */
export function makeRoofRung({ polygons = [], z = 0 }) {
  return { polygons: polygons.map(n => n | 0), z: quantize(z) };
}

/**
 * One vertical end wall of a gable or shed roof.
 *
 * STORED AS 3D POINTS, not as an index into the polygon table, and that is the
 * one place this IR breaks its own rule. Everything else is a plan at a height,
 * which is why the table works; a gable end is VERTICAL, so it has no single
 * height and no plan. Forcing it into the table would mean storing a polygon in
 * a rotated frame plus the frame - more data and a second convention - to save
 * a handful of points on the two roofs that have them.
 *
 * Wound so the face points away from the building. `path` is flat [x, y, z, ...]
 * like a trim run, for the same reason: one polyline convention, not two.
 */
export function makeGable({ path = [] }) {
  return { path: path.map(quantize) };
}

/**
 * One material slot.
 *
 * A COLOUR AND A REFERENCE, not a shader description. The IR is consumed by the
 * preview, by an exporter and eventually by two different engines, and none of
 * them want this file's opinion about roughness curves. `color` is what the
 * preview draws when `ref` is empty, which is every shipped style pack today.
 */
export function makeMaterial({
  slot, color = '', ref = '', tile = 0, tileY = 0, fromFloor = -1, toFloor = -1, side = '',
}) {
  return {
    slot: String(slot || ''),
    color: String(color || ''),
    ref: String(ref || ''),
    // Metres per tile. Zero means "no texture bound", which is not the same as
    // a tile size of zero and is why this is not defaulted to 2 here.
    tile: quantize(tile),
    // Metres per tile UP the surface, where that differs. Zero means "square" -
    // use `tile` for both axes - so an untouched binding carries one number and
    // reads exactly as it did before there were two.
    tileY: quantize(tileY),
    // WHAT THIS ENTRY APPLIES TO, as a selector rather than as an expanded list.
    // -1 and '' are WILDCARDS: "any storey", "any side". A 40-storey building
    // with one brick has one entry, not 160, and adding a storey does not
    // rewrite the material table.
    fromFloor: fromFloor | 0,
    toFloor: toFloor | 0,
    side: String(side || ''),
  };
}

/**
 * How specific a material entry is. Higher wins.
 *
 * A side-and-storey entry beats a storey entry beats the building-wide one, so
 * the author's chain reads the way they set it up: a global brick, a stone
 * ground floor, and a rendered rear wall on that ground floor. Ties cannot
 * happen between different specificities; between equals the LAST entry wins,
 * which is the same "later overrides earlier" rule the facade nodes follow.
 */
function materialSpecificity(entry) {
  return (entry.side ? 2 : 0) + (entry.fromFloor >= 0 ? 1 : 0);
}

/**
 * The index of the material an element should draw with.
 *
 * EXPORTED SO THE MESHER AND THE TESTS RESOLVE IDENTICALLY - the same reason
 * roof.js exports rungKind. A consumer that re-implemented this would drift, and
 * the symptom would be one wall of a building wearing the wrong material.
 *
 * @param {object} ir
 * @param {string} slot        'wall', 'opening', ...
 * @param {number} floorIndex  counted from the ground; -1 for things with no storey
 * @param {string} side        a SIDE, or '' when it does not matter
 * @returns {number} an index into ir.materials, or -1
 */
export function resolveMaterialIndex(ir, slot, floorIndex = -1, side = '') {
  const materials = ir?.materials || [];
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < materials.length; i++) {
    const entry = materials[i];
    if (entry.slot !== slot) continue;
    if (entry.side && entry.side !== side) continue;
    if (entry.fromFloor >= 0 && (floorIndex < entry.fromFloor || floorIndex > entry.toFloor)) {
      continue;
    }
    const score = materialSpecificity(entry);
    // >= so a later entry of equal specificity wins - see above.
    if (score >= bestScore) { best = i; bestScore = score; }
  }
  return best;
}

/**
 * A run of trim along an edge.
 *
 * EDGE-DRIVEN, NOT FACE-DRIVEN: a cornice follows the top edge of a wall around
 * a corner and has to miter where two runs meet, which is information a face
 * does not carry. `path` is a flat [x, y, z, ...] polyline in IR coordinates.
 */
export function makeTrim({
  profileId = '', path = [], closed = false, level = 0, projection = 0, depth = 0,
  material = 0, normal = [],
}) {
  return {
    profileId: String(profileId || ''),
    path: path.map(quantize),
    closed: Boolean(closed),
    /**
     * Which way the section faces, for an OPEN run. Empty on a closed one.
     *
     * A closed run is a horizontal ring and its outward direction is derivable -
     * the mitred bisector of the two edges meeting at each station, which is
     * what makes a cornice turn a corner properly. An open run has no such
     * luxury: a vertical timber stud has no plan direction at all, and a gable
     * rake lies in a plane the path alone cannot distinguish from its mirror. So
     * the emitter says which way is out, once, for the whole run.
     */
    normal: normal.length === 3 ? normal.map(quantize) : [],
    level: level | 0,
    // The RUN carries its own section size rather than the consumer looking it
    // up from the node that made it. A consumer of the IR has no nodes - see the
    // header on why the IR exists - and two runs of the same profile at
    // different sizes are ordinary on one building.
    projection: quantize(projection),
    depth: quantize(depth),
    // AN INDEX INTO ir.materials, resolved by the compiler rather than selected
    // by the consumer. Walls and openings are derived from level polygons and
    // have no node to point at, so they need the selector in the material entry;
    // a trim RUN is a discrete thing emitted by one node, and indexing a table
    // is what the rest of the IR already does everywhere else.
    material: material | 0,
  };
}

/**
 * Assert the IR is plain, finite JSON.
 *
 * Returns a list of problems rather than throwing, so a test can report all of
 * them at once. This is the guard behind the "plain JSON only" rule at the top:
 * a typed array or a NaN sneaks through every other check and only fails much
 * later, in an exporter or in another language.
 */
export function validateIrJson(ir, { maxDepth = 24 } = {}) {
  const problems = [];

  const walk = (value, path, depth) => {
    if (depth > maxDepth) {
      problems.push(`${path}: nested deeper than ${maxDepth}`);
      return;
    }
    if (value === null) return;
    const type = typeof value;
    if (type === 'number') {
      if (!Number.isFinite(value)) problems.push(`${path}: ${value} is not finite`);
      return;
    }
    if (type === 'string' || type === 'boolean') return;
    if (type === 'undefined') {
      problems.push(`${path}: undefined is not representable in JSON`);
      return;
    }
    if (type === 'function' || type === 'symbol' || type === 'bigint') {
      problems.push(`${path}: ${type} is not representable in JSON`);
      return;
    }
    if (ArrayBuffer.isView(value)) {
      problems.push(`${path}: ${value.constructor.name} is a typed array`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    // A Map, a Set or a class instance all survive to here and none of them
    // round trip; a plain object's prototype is Object.prototype or null.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      problems.push(`${path}: ${value.constructor?.name || 'object'} is not a plain object`);
      return;
    }
    for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`, depth + 1);
  };

  walk(ir, 'ir', 0);
  return problems;
}

/**
 * A stable digest of an IR, for golden tests and for "did this actually change".
 *
 * Canonical JSON with sorted keys, so it does not depend on the order the
 * compiler happened to assign properties in.
 */
export function irDigest(ir) {
  const canonical = value => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
      const keys = Object.keys(value).sort();
      return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
  };
  return canonical(ir);
}
