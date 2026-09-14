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
    roof: null,
    materials: [],
    references: {},
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
  type, transform, styleSlot = '', cellW = 0, cellH = 0,
  faceIndex = 0, floorIndex = 0, bayIndex = 0, seedKey = 0,
}) {
  return {
    type,
    styleSlot: String(styleSlot || ''),
    transform: transform.map(quantize),
    cellW: quantize(cellW),
    cellH: quantize(cellH),
    faceIndex: faceIndex | 0,
    floorIndex: floorIndex | 0,
    bayIndex: bayIndex | 0,
    seedKey: seedKey >>> 0,
  };
}

/**
 * A run of trim along an edge.
 *
 * EDGE-DRIVEN, NOT FACE-DRIVEN: a cornice follows the top edge of a wall around
 * a corner and has to miter where two runs meet, which is information a face
 * does not carry. `path` is a flat [x, y, z, ...] polyline in IR coordinates.
 */
export function makeTrim({ profileId = '', path = [], closed = false, level = 0 }) {
  return {
    profileId: String(profileId || ''),
    path: path.map(quantize),
    closed: Boolean(closed),
    level: level | 0,
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
