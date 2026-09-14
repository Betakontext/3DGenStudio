// The node catalog: what an author can put on the board, what properties each
// node has, and what it plugs into.
//
// THIS FILE IS THE PRODUCT. The compiler is replaceable and the UI is
// replaceable, but the catalog is the vocabulary a building is written in, and
// changing it after documents exist in the wild is the expensive kind of change.
//
// FOUR RULES, each of which exists because of a specific failure.
//
// 1. THE UI IS GENERIC OVER THIS DATA. The palette, the node body, the inspector
//    and the mode switches all read these definitions. Adding a node is a
//    catalog entry plus an evaluator - never a React change. That is what makes
//    "is it easy to add a node type?" a yes, and it is why `label`, `blurb`,
//    `teach` and `hint` are part of the data rather than strings hard-coded in a
//    component.
//
// 2. EVERY NODE EXPLAINS ITSELF IN PLAIN LANGUAGE. The audience is someone who
//    can model a building but has never written a shape grammar. `blurb` is what
//    the palette shows; `teach` is the sentence that stops them making the
//    mistake the node invites. "Footprint" needs no explanation; "Mass" very
//    much does, because its profile is the difference between an office block
//    and a Mayan pyramid and nothing about the word says so.
//
// 3. `modes` ARE NOT `props`. A mode picks a CODE PATH - a profile shape, a join
//    style - so the compiler branches on it at compile time. Putting it in props
//    would let an author wire a number into something that selects an algorithm,
//    and would force the evaluator to unwrap a value just to discover which
//    branch to take.
//
// 4. PORTS ARE TYPED, AND THE TYPES ARE FEW. A port carries a `kind`, and an
//    edge between mismatched kinds is a compile error rather than a silent
//    coercion. Three kinds is enough for the whole pipeline; more would be
//    modelling for its own sake.
//
// PHASE NOTE: this is the Phase 1 vocabulary - footprint, mass, output. Floors,
// bays, slots, roofs and trim are Phases 2-5 and land as entries here plus
// evaluators, with no change to the board, the inspector or the compiler's
// shape. If any of them cannot be expressed that way, the abstraction is wrong
// and that is worth knowing early.

import { MASS_PROFILE } from './mass.js';
import { defaultProfileCurve, toCurve } from './param.js';

/** What travels along an edge. */
export const PORT_KIND = {
  /** A 2D polygon with holes, in metres. The plan. */
  SHAPE: 'shape',
  /** A stack of levels. The massed volume. */
  BUILDING: 'building',
  /** A plain number, for driving a property from another node. */
  NUMBER: 'number',
};

/** How the inspector renders a property, and how the compiler coerces it. */
export const PROP_TYPE = {
  NUMBER: 'number',
  INT: 'int',
  BOOL: 'bool',
  STRING: 'string',
  /** A ring of [x, y] pairs plus holes. Edited by the plan editor, not a field. */
  POLYGON: 'polygon',
  /** An [t, value] table. Edited by a curve widget. */
  CURVE: 'curve',
};

/** Palette grouping. Ordered by where a node sits in the pipeline. */
export const CATEGORY = {
  SOURCE: 'Source',
  MASS: 'Mass',
  FLOORS: 'Floors',
  FACADE: 'Facade',
  ROOF: 'Roof',
  DETAIL: 'Detail',
  OUTPUT: 'Output',
};

/**
 * A default 12m x 8m rectangle.
 *
 * A new Footprint node arrives with a real shape rather than an empty one, so
 * the board shows a building immediately and the plan editor has something to
 * drag. An empty default means a new document renders nothing and the author
 * cannot tell a working tool from a broken one.
 */
export const DEFAULT_FOOTPRINT = {
  outer: [[0, 0], [12, 0], [12, 8], [0, 8]],
  holes: [],
};

export const CATALOG = {
  footprint: {
    type: 'footprint',
    label: 'Footprint',
    category: CATEGORY.SOURCE,
    icon: 'crop_square',
    blurb: 'The plan the building is grown from.',
    teach: 'Draw it in the plan editor. Holes become courtyards and light wells, '
         + 'and they survive every operation above - so a courtyard block is one '
         + 'footprint with one hole, not two buildings.',
    inputs: [],
    outputs: [{ id: 'out', label: 'Shape', kind: PORT_KIND.SHAPE }],
    props: {
      shape: {
        type: PROP_TYPE.POLYGON,
        label: 'Plan',
        default: DEFAULT_FOOTPRINT,
        basic: true,
        hint: 'Edited on the Plan tab rather than here.',
      },
      gridSize: {
        type: PROP_TYPE.NUMBER,
        label: 'Grid',
        default: 0.5,
        min: 0.05,
        max: 5,
        step: 0.05,
        unit: 'm',
        basic: true,
        hint: 'Snap spacing while drawing. Does not change the stored plan.',
      },
    },
    modes: {},
  },

  mass: {
    type: 'mass',
    label: 'Mass',
    category: CATEGORY.MASS,
    icon: 'apartment',
    blurb: 'Stacks the plan into storeys.',
    teach: 'The Profile is the important control, and it is what separates one '
         + 'style from another: Straight for most things, Batter for Egyptian '
         + 'and Asian taper, Setback for Mayan platforms and American towers, '
         + 'Jetty for medieval overhangs and cantilevers.',
    inputs: [{ id: 'shape', label: 'Shape', kind: PORT_KIND.SHAPE, required: true }],
    outputs: [{ id: 'out', label: 'Building', kind: PORT_KIND.BUILDING }],
    props: {
      levelCount: {
        type: PROP_TYPE.INT,
        label: 'Storeys',
        default: 3,
        min: 1,
        max: 200,
        basic: true,
      },
      groundHeight: {
        type: PROP_TYPE.NUMBER,
        label: 'Ground floor',
        default: 4,
        min: 0.1,
        max: 100,
        step: 0.1,
        unit: 'm',
        basic: true,
        hint: 'Taller than the storeys above it in almost every real building.',
      },
      levelHeight: {
        type: PROP_TYPE.NUMBER,
        label: 'Storey height',
        default: 3,
        min: 0.1,
        max: 100,
        step: 0.1,
        unit: 'm',
        basic: true,
      },
      plinthHeight: {
        type: PROP_TYPE.NUMBER,
        label: 'Plinth',
        default: 0,
        min: 0,
        max: 100,
        step: 0.1,
        unit: 'm',
        hint: 'A base course below the ground floor. It is not a storey and does '
            + 'not take the profile.',
      },
      amount: {
        type: PROP_TYPE.NUMBER,
        label: 'Profile amount',
        default: 0,
        min: 0,
        max: 50,
        step: 0.1,
        unit: 'm',
        basic: true,
        hint: 'How far the top is inset (Batter) or overhangs (Jetty).',
        // Only meaningful for the continuous profiles. The inspector uses this
        // to grey the row out rather than hide it: a hidden control that is
        // still doing something is worse than a visible one that is not.
        showFor: { profile: [MASS_PROFILE.BATTER, MASS_PROFILE.JETTY] },
      },
      step: {
        type: PROP_TYPE.NUMBER,
        label: 'Step depth',
        default: 1.5,
        min: 0,
        max: 50,
        step: 0.1,
        unit: 'm',
        hint: 'How far each setback moves in.',
        showFor: { profile: [MASS_PROFILE.SETBACK] },
      },
      every: {
        type: PROP_TYPE.INT,
        label: 'Step every',
        default: 2,
        min: 1,
        max: 50,
        unit: ' storeys',
        hint: 'How many storeys between setbacks.',
        showFor: { profile: [MASS_PROFILE.SETBACK] },
      },
      cornerRadius: {
        type: PROP_TYPE.NUMBER,
        label: 'Corner radius',
        default: 1,
        min: 0,
        max: 50,
        step: 0.1,
        unit: 'm',
        basic: true,
        hint: 'How far back each corner is rounded. Larger than half the narrowest '
            + 'wing will simplify the plan rather than round it.',
        showFor: { join: ['round'] },
      },
      curve: {
        type: PROP_TYPE.CURVE,
        label: 'Profile curve',
        // A FLAT DEFAULT WOULD MAKE THE CURVE PROFILE IDENTICAL TO STRAIGHT the
        // moment it is picked, which reads as a broken setting. It arrives as a
        // visible smooth taper instead - and the easing is exactly what
        // distinguishes it from Batter, which reaches the same place in a
        // straight line.
        default: defaultProfileCurve(),
        basic: true,
        hint: 'Inset in metres, against height: 0 at the ground, 1 at the top. '
            + 'Positive leans in, negative overhangs.',
        showFor: { profile: [MASS_PROFILE.CURVE] },
      },
    },
    modes: {
      profile: {
        label: 'Profile',
        default: MASS_PROFILE.STRAIGHT,
        basic: true,
        options: [
          { value: MASS_PROFILE.STRAIGHT, label: 'Straight', teach: 'Walls rise vertically.' },
          { value: MASS_PROFILE.BATTER, label: 'Batter', teach: 'Leans inward with height. Egyptian pylons, Asian taper.' },
          { value: MASS_PROFILE.SETBACK, label: 'Setback', teach: 'Steps inward every few storeys. Mayan platforms, deco towers.' },
          { value: MASS_PROFILE.JETTY, label: 'Jetty', teach: 'Overhangs outward with height. Medieval upper floors, cantilevers.' },
          {
            value: MASS_PROFILE.CURVE,
            label: 'Curve',
            teach: 'Draw the inset against height yourself. Eased tapers, bulges '
                 + 'and overhangs - anything the four above cannot say.',
          },
        ],
      },
      join: {
        label: 'Corners',
        default: 'miter',
        basic: true,
        options: [
          { value: 'miter', label: 'Sharp', teach: 'Square corners. Correct for almost all architecture.' },
          {
            value: 'round',
            label: 'Rounded',
            teach: 'Rounds the plan by the radius below, on every storey. '
                 + 'Futurist shells and soft eaves.',
          },
        ],
      },
    },
  },

  facade: {
    type: 'facade',
    label: 'Facade',
    category: CATEGORY.FACADE,
    icon: 'window',
    blurb: 'Splits every wall into bays and places the openings.',
    teach: 'Bay width is a NOMINAL: every wall is divided into a whole number of '
         + 'equal bays nearest that width, so nothing lands half-cut at a corner. '
         + 'The openings keep their own size and the wall around them takes up the '
         + 'slack, which is why one setting fits walls of any length. '
         + 'CHAIN SEVERAL, each set to different storeys, to give a building a '
         + 'shopfront, a grander first floor and a plainer attic - a later Facade '
         + 'replaces an earlier one only on the storeys it claims.',
    inputs: [{ id: 'building', label: 'Building', kind: PORT_KIND.BUILDING, required: true }],
    outputs: [{ id: 'out', label: 'Building', kind: PORT_KIND.BUILDING }],
    props: {
      fromFloor: {
        type: PROP_TYPE.INT,
        label: 'From storey',
        default: 0,
        min: 0,
        max: 200,
        basic: true,
        hint: 'Counted from the ground, which is storey 0.',
        showFor: { storeys: ['range'] },
      },
      toFloor: {
        type: PROP_TYPE.INT,
        label: 'To storey',
        default: 0,
        min: 0,
        max: 200,
        basic: true,
        hint: 'Inclusive.',
        showFor: { storeys: ['range'] },
      },
      bayWidth: {
        type: PROP_TYPE.NUMBER,
        label: 'Bay width',
        default: 3,
        min: 0.5,
        max: 30,
        step: 0.1,
        unit: 'm',
        basic: true,
        hint: 'Nominal. The real bay is the wall divided by the nearest whole number.',
      },
      windowWidth: {
        type: PROP_TYPE.NUMBER,
        label: 'Window width',
        default: 1.2,
        min: 0.2,
        max: 20,
        step: 0.1,
        unit: 'm',
        basic: true,
        hint: 'The opening keeps this width whatever the bay comes out at.',
      },
      pierWidth: {
        type: PROP_TYPE.NUMBER,
        label: 'Pier',
        default: 0.6,
        min: 0,
        max: 10,
        step: 0.05,
        unit: 'm',
        basic: true,
        hint: 'Solid wall between one bay and the next.',
      },
      sillHeight: {
        type: PROP_TYPE.NUMBER,
        label: 'Sill',
        default: 0.9,
        min: 0,
        max: 10,
        step: 0.05,
        unit: 'm',
        hint: 'Wall below the opening. Fixed, so a taller storey gets a taller window.',
      },
      lintelHeight: {
        type: PROP_TYPE.NUMBER,
        label: 'Lintel',
        default: 0.5,
        min: 0,
        max: 10,
        step: 0.05,
        unit: 'm',
        hint: 'Wall above the opening.',
      },
      groundSillHeight: {
        type: PROP_TYPE.NUMBER,
        label: 'Ground sill',
        default: 0.2,
        min: 0,
        max: 10,
        step: 0.05,
        unit: 'm',
        hint: 'The ground floor almost always has a lower sill - shopfronts reach '
            + 'the pavement.',
      },
      doorWidth: {
        type: PROP_TYPE.NUMBER,
        label: 'Door width',
        default: 1.1,
        min: 0.4,
        max: 10,
        step: 0.05,
        unit: 'm',
      },
      doorHeight: {
        type: PROP_TYPE.NUMBER,
        label: 'Door height',
        default: 2.2,
        min: 1,
        max: 12,
        step: 0.05,
        unit: 'm',
      },
      includeCourtyards: {
        type: PROP_TYPE.BOOL,
        label: 'Dress courtyards',
        default: true,
        hint: 'A courtyard has walls too. Off doubles nothing and halves the slot '
            + 'count on a plan with a big light well.',
      },
      placeDoor: {
        type: PROP_TYPE.BOOL,
        label: 'Front door',
        default: true,
        hint: 'Only does anything on a facade that covers the ground floor.',
      },
    },
    modes: {
      storeys: {
        label: 'Storeys',
        default: 'all',
        basic: true,
        options: [
          { value: 'all', label: 'All storeys', teach: 'One rule for the whole building.' },
          {
            value: 'ground',
            label: 'Ground floor only',
            teach: 'The shopfront. Put this AFTER an all-storeys facade to override it.',
          },
          {
            value: 'upper',
            label: 'Above the ground',
            teach: 'Everything except the ground floor.',
          },
          { value: 'top', label: 'Top storey only', teach: 'The attic or crown.' },
          { value: 'range', label: 'A range', teach: 'Pick the storeys by number below.' },
        ],
      },
      opening: {
        label: 'Opening',
        default: 'window',
        basic: true,
        options: [
          { value: 'window', label: 'Window' },
          {
            value: 'shopfront',
            label: 'Shopfront',
            teach: 'Tags these openings differently so a style pack can dress them '
                 + 'as glazing rather than as windows.',
          },
          { value: 'arch', label: 'Arch', teach: 'Arcades, loggias, Roman ground floors.' },
          { value: 'balcony', label: 'Balcony' },
          { value: 'louvre', label: 'Louvre', teach: 'Plant rooms, industrial and utility floors.' },
        ],
      },
    },
  },

  output: {
    type: 'output',
    label: 'Output',
    category: CATEGORY.OUTPUT,
    icon: 'check_circle',
    blurb: 'The building that gets built.',
    teach: 'Whatever reaches this node is what the preview shows and what gets '
         + 'exported. A graph without one compiles to nothing.',
    inputs: [{ id: 'building', label: 'Building', kind: PORT_KIND.BUILDING, required: true }],
    outputs: [],
    props: {},
    modes: {},
    /** At most one per document - see E_MULTIPLE_OUTPUTS. */
    singleton: true,
  },
};

/** Every node type, in palette order. */
export const CATALOG_ORDER = Object.keys(CATALOG);

/** A node definition, or null when the type is unknown. */
export function getNodeDef(type) {
  return Object.prototype.hasOwnProperty.call(CATALOG, type) ? CATALOG[type] : null;
}

/** The default props for a node type, as a fresh object. */
export function defaultProps(type) {
  const def = getNodeDef(type);
  if (!def) return {};
  const out = {};
  for (const [key, spec] of Object.entries(def.props || {})) {
    // Structured defaults are cloned, or every new Footprint node would share
    // one polygon object and editing either would edit both.
    out[key] = typeof spec.default === 'object' && spec.default !== null
      ? JSON.parse(JSON.stringify(spec.default))
      : spec.default;
  }
  return out;
}

/** The default modes for a node type, as a fresh object. */
export function defaultModes(type) {
  const def = getNodeDef(type);
  if (!def) return {};
  const out = {};
  for (const [key, spec] of Object.entries(def.modes || {})) out[key] = spec.default;
  return out;
}

/** A whole new node of this type, minus the id. */
export function createNode(type, id) {
  return {
    id,
    type,
    enabled: true,
    props: defaultProps(type),
    modes: defaultModes(type),
  };
}

/**
 * Coerce one stored property value to what its spec says it is.
 *
 * Total: an unparseable value falls back to the default rather than reaching the
 * evaluator as a string. That matters because a document can be hand-edited or
 * written by an older version, and a NaN that reaches the geometry produces a
 * building that silently does not render.
 */
export function coerceProp(spec, value) {
  if (!spec) return value;
  switch (spec.type) {
    case PROP_TYPE.INT:
    case PROP_TYPE.NUMBER: {
      const n = Number(value);
      if (!Number.isFinite(n)) return spec.default;
      const clamped = Math.min(
        spec.max ?? Number.POSITIVE_INFINITY,
        Math.max(spec.min ?? Number.NEGATIVE_INFINITY, n),
      );
      return spec.type === PROP_TYPE.INT ? Math.round(clamped) : clamped;
    }
    case PROP_TYPE.BOOL:
      return Boolean(value);
    case PROP_TYPE.STRING:
      return typeof value === 'string' ? value : String(spec.default ?? '');
    case PROP_TYPE.POLYGON:
      return value && Array.isArray(value.outer) ? value : spec.default;
    case PROP_TYPE.CURVE:
      // toCurve also accepts the [[t, v], ...] pair arrays the first draft of
      // the profile stored, so a document written before the editor existed
      // still opens.
      return toCurve(value === undefined ? spec.default : value);
    default:
      return value;
  }
}

/** Read a node's property, coerced, falling back to the catalog default. */
export function readProp(node, key) {
  const def = getNodeDef(node?.type);
  const spec = def?.props?.[key];
  if (!spec) return undefined;
  const raw = node?.props?.[key];
  return coerceProp(spec, raw === undefined ? spec.default : raw);
}

/** Read a node's mode, falling back to the catalog default. */
export function readMode(node, key) {
  const def = getNodeDef(node?.type);
  const spec = def?.modes?.[key];
  if (!spec) return undefined;
  const raw = node?.modes?.[key];
  const allowed = (spec.options || []).some(option => option.value === raw);
  return allowed ? raw : spec.default;
}

/**
 * Whether a property row applies given the node's current modes.
 *
 * Drives greying-out rather than hiding: a control that has disappeared but is
 * still affecting the result is the worse of the two failures.
 */
export function propApplies(node, key) {
  const def = getNodeDef(node?.type);
  const spec = def?.props?.[key];
  if (!spec?.showFor) return true;
  return Object.entries(spec.showFor).every(([modeKey, allowed]) => {
    const current = readMode(node, modeKey);
    return Array.isArray(allowed) ? allowed.includes(current) : allowed === current;
  });
}

/** The port definition for one side of an edge, or null. */
export function getPort(type, portId, direction) {
  const def = getNodeDef(type);
  if (!def) return null;
  const list = direction === 'in' ? def.inputs : def.outputs;
  return (list || []).find(port => port.id === portId) || null;
}
