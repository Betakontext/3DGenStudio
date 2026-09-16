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
      balconyDepth: {
        type: PROP_TYPE.NUMBER,
        label: 'Balcony depth',
        default: 1,
        min: 0.2,
        max: 6,
        step: 0.05,
        unit: 'm',
        basic: true,
        hint: 'How far it stands out from the wall.',
        showFor: { balcony: ['upper', 'all', 'scattered'] },
      },
      balconyWidth: {
        type: PROP_TYPE.NUMBER,
        label: 'Balcony width',
        default: 2,
        min: 0.4,
        max: 30,
        step: 0.05,
        unit: 'm',
        basic: true,
        hint: 'Clamped to the bay, so two neighbours never grow into each other.',
        showFor: { balcony: ['upper', 'all', 'scattered'] },
      },
      balconyHeight: {
        type: PROP_TYPE.NUMBER,
        label: 'Balustrade',
        default: 1.05,
        min: 0.2,
        max: 4,
        step: 0.05,
        unit: 'm',
        hint: 'Railing height above the sill it stands on.',
        showFor: { balcony: ['upper', 'all', 'scattered'] },
      },
      balconyChance: {
        type: PROP_TYPE.NUMBER,
        label: 'How many',
        default: 0.5,
        min: 0.05,
        max: 1,
        step: 0.05,
        basic: true,
        hint: 'The share of openings that get one, rolled from the seed per opening.',
        showFor: { balcony: ['scattered'] },
      },
      postWidth: {
        type: PROP_TYPE.NUMBER,
        label: 'Post width',
        default: 0.45,
        min: 0.05,
        max: 5,
        step: 0.05,
        unit: 'm',
        basic: true,
        showFor: { posts: ['pier', 'colonnade'] },
      },
      postDepth: {
        type: PROP_TYPE.NUMBER,
        label: 'Post depth',
        default: 0.45,
        min: 0.05,
        max: 5,
        step: 0.05,
        unit: 'm',
        hint: 'A colonnade also stands this far clear of the wall.',
        showFor: { posts: ['pier', 'colonnade'] },
      },
      // WHICH SIDES. Four booleans rather than one multi-choice control: a
      // mode is single-select and the answer here is a SUBSET - two sides of
      // four is the common case, and 'all but the north' has to be sayable.
      openingNorth: {
        type: PROP_TYPE.BOOL,
        label: 'North',
        default: true,
        hint: 'Openings on walls facing north. Off leaves a blank wall - a '
            + 'blind gable, a party wall, the back of a terrace. The front door is '
            + 'placed whatever these say.',
      },
      openingEast: {
        type: PROP_TYPE.BOOL,
        label: 'East',
        default: true,
        hint: 'Openings on walls facing east. Off leaves a blank wall - a '
            + 'blind gable, a party wall, the back of a terrace. The front door is '
            + 'placed whatever these say.',
      },
      openingSouth: {
        type: PROP_TYPE.BOOL,
        label: 'South',
        default: true,
        hint: 'Openings on walls facing south. Off leaves a blank wall - a '
            + 'blind gable, a party wall, the back of a terrace. The front door is '
            + 'placed whatever these say.',
      },
      openingWest: {
        type: PROP_TYPE.BOOL,
        label: 'West',
        default: true,
        hint: 'Openings on walls facing west. Off leaves a blank wall - a '
            + 'blind gable, a party wall, the back of a terrace. The front door is '
            + 'placed whatever these say.',
      },
      balconyNorth: {
        type: PROP_TYPE.BOOL,
        label: 'Balconies north',
        default: true,
        hint: 'Balconies on walls facing north.',
        showFor: { balcony: ['upper', 'all', 'scattered'] },
      },
      balconyEast: {
        type: PROP_TYPE.BOOL,
        label: 'Balconies east',
        default: true,
        hint: 'Balconies on walls facing east.',
        showFor: { balcony: ['upper', 'all', 'scattered'] },
      },
      balconySouth: {
        type: PROP_TYPE.BOOL,
        label: 'Balconies south',
        default: true,
        hint: 'Balconies on walls facing south.',
        showFor: { balcony: ['upper', 'all', 'scattered'] },
      },
      balconyWest: {
        type: PROP_TYPE.BOOL,
        label: 'Balconies west',
        default: true,
        hint: 'Balconies on walls facing west.',
        showFor: { balcony: ['upper', 'all', 'scattered'] },
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
          { value: 'louvre', label: 'Louvre', teach: 'Plant rooms, industrial and utility floors.' },
        ],
      },
      posts: {
        label: 'Posts',
        default: 'none',
        basic: true,
        teach: 'A post on every bay boundary, and one more to close the run. '
             + 'This is the slot the catalog has always declared and never '
             + 'emitted - it is a colonnade, an arcade, a porch, and the corner '
             + 'posts of a timber frame, depending on what model you bind to it.',
        options: [
          { value: 'none', label: 'None' },
          {
            value: 'pier',
            label: 'Flush piers',
            teach: 'In the plane of the wall. Structure rather than ornament.',
          },
          {
            value: 'colonnade',
            label: 'Standing clear',
            teach: 'Pushed out in front of the wall, so the storey reads as an '
                 + 'arcade with a walkway behind it.',
          },
        ],
      },
      balcony: {
        label: 'Balconies',
        default: 'none',
        basic: true,
        teach: 'A balcony is an ATTACHMENT, not an opening: it stands in front of '
             + 'the window and the window stays. That is why it lives here rather '
             + 'than in the Opening list above - picking it there would put a '
             + 'balustrade in the hole and leave nothing to step out of. It sits '
             + 'on the opening’s sill and carries its own model slot, so one '
             + 'facade can have iron railings and another stone.',
        options: [
          { value: 'none', label: 'None' },
          {
            value: 'upper',
            label: 'Above the ground',
            teach: 'What a real building does. A balcony at pavement level is a step.',
          },
          { value: 'all', label: 'Every opening', teach: 'Including the ground floor.' },
          {
            value: 'scattered',
            label: 'Scattered',
            teach: 'A seeded share of the openings, so a facade reads as lived in '
                 + 'rather than as a grid. Re-rolling the seed moves them.',
          },
        ],
      },
    },
  },

  roof: {
    type: 'roof',
    label: 'Roof',
    category: CATEGORY.ROOF,
    icon: 'roofing',
    blurb: 'Caps the building.',
    teach: 'A roof is the massing continued past the top storey: the plan keeps '
         + 'stepping inward and rising until it closes. That is why a hip roof '
         + 'works on an L-plan or one with a courtyard without being told about '
         + 'either, and why Stepped gives a Mayan platform from the same code. '
         + 'Chain a second Roof and it CONTINUES the first rather than replacing '
         + 'it, starting on whatever surface the one below ended on - Stepped '
         + 'then Hip is a Mayan temple, and Tiered over Tiered is a pagoda. The '
         + 'roof below has to end on a deck for that: give it a height cap, or '
         + 'use a shape that ends flat.',
    inputs: [{ id: 'building', label: 'Building', kind: PORT_KIND.BUILDING, required: true }],
    outputs: [{ id: 'out', label: 'Building', kind: PORT_KIND.BUILDING }],
    props: {
      pitch: {
        type: PROP_TYPE.NUMBER, label: 'Pitch', default: 35, min: 1, max: 85, step: 1,
        unit: 'deg', basic: true,
        hint: 'Degrees from horizontal. Steeper is taller over the same plan.',
        // Gable and shed are driven by it too: both were added after this list
        // was written, and a greyed-out Pitch on a roof whose whole shape it
        // decides is exactly the "control that lies" failure showFor exists to
        // prevent.
        showFor: { kind: ['hip', 'mansard', 'gable', 'shed'] },
      },
      upperPitch: {
        type: PROP_TYPE.NUMBER, label: 'Upper pitch', default: 12, min: 0, max: 85, step: 1,
        unit: 'deg', basic: true,
        hint: 'The shallow part, above the break.',
        showFor: { kind: ['mansard'] },
      },
      breakFraction: {
        type: PROP_TYPE.NUMBER, label: 'Break at', default: 0.35, min: 0.05, max: 0.95, step: 0.05,
        hint: 'How far in the pitch changes, as a fraction of the whole roof. '
            + 'This is where the attic windows go.',
        showFor: { kind: ['mansard'] },
      },
      stepRun: {
        type: PROP_TYPE.NUMBER, label: 'Step depth', default: 1.2, min: 0.05, max: 20, step: 0.1,
        unit: 'm', basic: true,
        showFor: { kind: ['stepped', 'tiered'] },
      },
      stepRise: {
        type: PROP_TYPE.NUMBER, label: 'Step height', default: 0.9, min: 0.05, max: 20, step: 0.1,
        unit: 'm', basic: true,
        showFor: { kind: ['stepped', 'tiered'] },
      },
      overhang: {
        type: PROP_TYPE.NUMBER, label: 'Eave overhang', default: 0.6, min: 0, max: 10, step: 0.1,
        unit: 'm', basic: true,
        hint: 'How far each tier oversails the one below. Zero makes a ziggurat; '
            + 'a little makes an Asian roof.',
        showFor: { kind: ['tiered'] },
      },
      ridgeAngle: {
        type: PROP_TYPE.NUMBER, label: 'Ridge angle', default: 0, min: 0, max: 180, step: 5,
        unit: 'deg', basic: true,
        hint: 'Which way the ridge points, in plan. 0 runs it east-west.',
        showFor: { ridge: ['custom'] },
      },
      maxHeight: {
        type: PROP_TYPE.NUMBER, label: 'Height cap', default: 0, min: 0, max: 200, step: 0.5,
        unit: 'm',
        hint: 'Stop at this height with a flat deck instead of running to a ridge. '
            + '0 means no cap.',
      },
    },
    modes: {
      ridge: {
        label: 'Ridge',
        default: 'long',
        basic: true,
        showFor: { kind: ['gable', 'shed'] },
        options: [
          {
            value: 'long', label: 'Along the building',
            teach: 'The ridge runs the length of the plan. What a house does, and '
                 + 'right almost every time.',
          },
          {
            value: 'across', label: 'Across it',
            teach: 'Turned ninety degrees, so the gable faces the long side. What a '
                 + 'terrace of houses does onto the street.',
          },
          {
            value: 'custom', label: 'A set angle',
            teach: 'Point the ridge yourself, for a plan whose long axis is not the '
                 + 'one you want to roof along.',
          },
        ],
      },
      kind: {
        label: 'Shape',
        default: 'hip',
        basic: true,
        options: [
          { value: 'flat', label: 'Flat', teach: 'No roof. The top of the stack is the top.' },
          {
            value: 'hip', label: 'Hip',
            teach: 'Slopes in from every eave to a ridge. On a plan with no long '
                 + 'axis this is a pyramid.',
          },
          {
            value: 'mansard', label: 'Mansard',
            teach: 'Steep below, shallow above. The French attic storey.',
          },
          {
            value: 'stepped', label: 'Stepped',
            teach: 'Flat treads and vertical risers. Mayan platforms, ziggurats.',
          },
          {
            value: 'tiered', label: 'Tiered',
            teach: 'Stepped, with each tier oversailing the one below. Asian eaves.',
          },
          {
            value: 'gable', label: 'Gable',
            teach: 'Two slopes to a ridge, with vertical walls at the ends. The '
                 + 'ordinary house roof, and the one shape that is NOT the offset '
                 + 'walk - the plan is cut down across the ridge instead, which is '
                 + 'why the ends stay upright.',
          },
          {
            value: 'shed', label: 'Shed',
            teach: 'One slope, from a low edge to a high one. Lean-tos, outbuildings '
                 + 'and modern boxes. Pitch is measured over the whole width, so it '
                 + 'climbs about twice as high as a gable at the same angle.',
          },
        ],
      },
    },
  },

  roofitem: {
    type: 'roofitem',
    label: 'Roof Detail',
    category: CATEGORY.ROOF,
    icon: 'chimney',
    blurb: 'Stands chimneys, finials and vents on the roof.',
    teach: 'Everything here is a SLOT, exactly like a window: the node decides '
         + 'WHERE something stands and the model list decides WHAT stands there, '
         + 'so a brick stack and a stone one are two assets rather than two '
         + 'settings. Left empty it draws a plain box, which is already a '
         + 'passable chimney. The foot is sunk into the roof on purpose - a '
         + 'contour ladder is a staircase approximating a slope, so anything '
         + 'sitting exactly on a contour floats above the pitch between rungs.',
    inputs: [{ id: 'building', label: 'Building', kind: PORT_KIND.BUILDING, required: true }],
    outputs: [{ id: 'out', label: 'Building', kind: PORT_KIND.BUILDING }],
    props: {
      count: {
        type: PROP_TYPE.INT,
        label: 'How many',
        default: 1,
        min: 1,
        max: 40,
        basic: true,
        hint: 'Spread evenly along the contour.',
        showFor: { where: ['ridge', 'slope', 'eave'] },
      },
      along: {
        type: PROP_TYPE.NUMBER,
        label: 'Position',
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
        basic: true,
        hint: 'Where the run starts, as a share of the way round. On Slope it '
            + 'also picks how far up the roof the contour is.',
        showFor: { where: ['ridge', 'slope', 'eave'] },
      },
      width: {
        type: PROP_TYPE.NUMBER, label: 'Width', default: 0.9, min: 0.1, max: 12,
        step: 0.05, unit: 'm', basic: true,
      },
      depth: {
        type: PROP_TYPE.NUMBER, label: 'Depth', default: 0.9, min: 0.1, max: 12,
        step: 0.05, unit: 'm',
      },
      height: {
        type: PROP_TYPE.NUMBER, label: 'Height', default: 2.4, min: 0.1, max: 30,
        step: 0.05, unit: 'm', basic: true,
        hint: 'Measured from where the foot sits, so a taller stack rises further '
            + 'above the ridge.',
      },
      sink: {
        type: PROP_TYPE.NUMBER, label: 'Sink in', default: 0.35, min: 0, max: 5,
        step: 0.05, unit: 'm',
        hint: 'How far the foot is buried in the roof. Too little and it floats '
            + 'off a pitch between two contours.',
      },
    },
    modes: {
      where: {
        label: 'Where',
        default: 'ridge',
        basic: true,
        options: [
          { value: 'ridge', label: 'On the ridge', teach: 'The topmost contour: a ridge on a pitch, the far edge of a deck.' },
          { value: 'slope', label: 'Out of a slope', teach: 'Partway up. Position below chooses how far.' },
          { value: 'eave', label: 'At the eaves', teach: 'The roof’s lowest contour.' },
          { value: 'apex', label: 'At the apex', teach: 'One, centred on the very top. Finials and spires.' },
        ],
      },
      item: {
        label: 'What',
        default: 'chimney',
        basic: true,
        teach: 'A TAG, not a shape. It picks which model list is used and what '
             + 'material the placeholder draws in - a chimney is masonry, the '
             + 'rest are trim.',
        options: [
          { value: 'chimney', label: 'Chimney' },
          { value: 'finial', label: 'Finial' },
          { value: 'vent', label: 'Vent' },
          { value: 'crest', label: 'Ridge crest' },
        ],
      },
    },
  },

  merge: {
    type: 'merge',
    label: 'Merge',
    category: CATEGORY.MASS,
    icon: 'join',
    blurb: 'Joins two buildings into one.',
    teach: 'The node that makes a TOWER possible, and a porch, and a wing. Every '
         + 'other node caps or dresses one massing, so a building had exactly '
         + 'one roof and one silhouette however elaborate the plan was. Build '
         + 'each part as its own Footprint - Mass - Roof chain, dress it, and '
         + 'merge: each part keeps its own roof. A Deform or a Roof Detail after '
         + 'the merge covers the whole thing, which is usually what you want; '
         + 'anything meant for one part goes in that part’s branch, before '
         + 'this node. Chain merges for three parts or more.',
    inputs: [
      { id: 'a', label: 'Building', kind: PORT_KIND.BUILDING, required: true },
      { id: 'b', label: 'And', kind: PORT_KIND.BUILDING, required: true },
    ],
    outputs: [{ id: 'out', label: 'Building', kind: PORT_KIND.BUILDING }],
    props: {},
    modes: {},
  },

  frame: {
    type: 'frame',
    label: 'Frame',
    category: CATEGORY.FACADE,
    icon: 'grid_4x4',
    blurb: 'Draws a timber frame over the walls.',
    teach: 'Trim can only follow edges, and every edge a building has is '
         + 'horizontal - which is why a half-timbered house was impossible until '
         + 'this node existed. It adds the other two directions: studs standing '
         + 'between the rails, and braces across the panels between them. It '
         + 'uses the SAME bay width as the Facade, so set the two to match and '
         + 'no stud lands through a window. Set Braces to Mixed and each panel '
         + 'rolls its own pattern from the seed.',
    inputs: [{ id: 'building', label: 'Building', kind: PORT_KIND.BUILDING, required: true }],
    outputs: [{ id: 'out', label: 'Building', kind: PORT_KIND.BUILDING }],
    props: {
      bayWidth: {
        type: PROP_TYPE.NUMBER, label: 'Panel width', default: 1.6, min: 0.3, max: 20,
        step: 0.1, unit: 'm', basic: true,
        hint: 'Nominal, and snapped to a whole number of panels per wall - the '
            + 'same rule the Facade uses. Match them and the studs frame the '
            + 'windows instead of crossing them.',
      },
      width: {
        type: PROP_TYPE.NUMBER, label: 'Timber width', default: 0.16, min: 0.02, max: 2,
        step: 0.01, unit: 'm', basic: true,
      },
      depth: {
        type: PROP_TYPE.NUMBER, label: 'Stands out', default: 0.06, min: 0.01, max: 1,
        step: 0.01, unit: 'm',
        hint: 'How far the timber sits proud of the infill.',
      },
      margin: {
        type: PROP_TYPE.NUMBER, label: 'Brace inset', default: 0, min: 0, max: 2,
        step: 0.02, unit: 'm',
        hint: 'Pulls the braces in from the studs either side.',
      },
      fromFloor: {
        type: PROP_TYPE.INT, label: 'From storey', default: 0, min: 0, max: 200,
        basic: true, hint: 'Counted from the ground. A stone ground floor usually '
            + 'wants the frame to start at 1.',
        showFor: { storeys: ['range'] },
      },
      toFloor: {
        type: PROP_TYPE.INT, label: 'To storey', default: 0, min: 0, max: 200,
        basic: true, hint: 'Inclusive.',
        showFor: { storeys: ['range'] },
      },
      rails: {
        type: PROP_TYPE.BOOL, label: 'Rails', default: true,
        hint: 'The horizontal timber at the top and bottom of each storey. Off '
            + 'when a string course is already doing that job.',
      },
      includeCourtyards: {
        type: PROP_TYPE.BOOL, label: 'Frame courtyards', default: false,
        hint: 'Off by default: a light well nobody can see is most of the '
            + 'timber budget on a plan that has one.',
      },
    },
    modes: {
      storeys: {
        label: 'Storeys',
        default: 'upper',
        basic: true,
        teach: 'Defaults to ABOVE THE GROUND, because that is what a jettied '
             + 'timber house does: masonry at the pavement, frame above it.',
        options: [
          { value: 'all', label: 'All storeys' },
          { value: 'ground', label: 'Ground floor only' },
          { value: 'upper', label: 'Above the ground' },
          { value: 'top', label: 'Top storey only' },
          { value: 'range', label: 'A range' },
        ],
      },
      brace: {
        label: 'Braces',
        default: 'chevron',
        basic: true,
        options: [
          { value: 'none', label: 'None', teach: 'Studs and rails only - close studding.' },
          {
            value: 'diagonal', label: 'Herringbone',
            teach: 'One diagonal per panel, alternating direction along the wall.',
          },
          { value: 'cross', label: 'Cross', teach: 'Both diagonals: a St Andrew’s cross.' },
          {
            value: 'chevron', label: 'Chevron',
            teach: 'Two braces meeting at the top centre. The most recognisable '
                 + 'Tudor panel.',
          },
          {
            value: 'lattice', label: 'Lattice',
            teach: 'A cross with both midlines. Dense, and the most expensive.',
          },
          {
            value: 'mixed', label: 'Mixed',
            teach: 'Each panel rolls its own from the seed, which is what stops a '
                 + 'long wall reading as wallpaper.',
          },
        ],
      },
    },
  },

  trim: {
    type: 'trim',
    label: 'Trim',
    category: CATEGORY.DETAIL,
    icon: 'horizontal_rule',
    blurb: 'Runs a moulding along an edge.',
    teach: 'Trim follows EDGES, not faces, which is why a cornice mitres round a '
         + 'corner instead of leaving a notch there. One node is one run: add a '
         + 'Plinth, a String course and a Cornice and you have most of a '
         + 'classical elevation. Unlike a Facade, trims ACCUMULATE - a later one '
         + 'never replaces an earlier one.',
    inputs: [{ id: 'building', label: 'Building', kind: PORT_KIND.BUILDING, required: true }],
    outputs: [{ id: 'out', label: 'Building', kind: PORT_KIND.BUILDING }],
    props: {
      projection: {
        type: PROP_TYPE.NUMBER, label: 'Projection', default: 0.35, min: 0.01, max: 5, step: 0.05,
        unit: 'm', basic: true,
        hint: 'How far the moulding stands out from the wall.',
      },
      depth: {
        type: PROP_TYPE.NUMBER, label: 'Height', default: 0.4, min: 0.02, max: 8, step: 0.05,
        unit: 'm', basic: true,
        hint: 'How tall the moulding is. A parapet grows upward from its line; '
            + 'everything else is centred on it.',
      },
      every: {
        type: PROP_TYPE.INT, label: 'Every', default: 1, min: 1, max: 20, step: 1,
        unit: 'storeys',
        hint: 'A band on every storey, or every second, or every third.',
        showFor: { where: ['string'] },
      },
      includeHoles: {
        type: PROP_TYPE.BOOL, label: 'Around courtyards', default: true,
        hint: 'Run the moulding around courtyard walls as well as the outside.',
      },
    },
    modes: {
      where: {
        label: 'Run',
        default: 'cornice',
        basic: true,
        options: [
          {
            value: 'cornice', label: 'Cornice',
            teach: 'The crown, at the top of the highest storey. Classical and '
                 + 'European buildings live or die on this one.',
          },
          {
            value: 'string', label: 'String course',
            teach: 'A band between storeys. What gives a tall elevation a scale.',
          },
          {
            value: 'plinth', label: 'Plinth',
            teach: 'The base course, where the building meets the ground.',
          },
          {
            value: 'eave', label: 'Eave',
            teach: 'Where the roof meets the wall, following the roof rather than '
                 + 'the storey - so an overhang takes it with it.',
          },
          {
            value: 'parapet', label: 'Parapet',
            teach: 'A wall standing above a flat roof. On a pitched roof there is '
                 + 'no deck to stand on and it will follow the ridge instead.',
          },
          {
            value: 'rake', label: 'Bargeboard',
            teach: 'The SLOPED edge of a gable, up one side and down the other. '
                 + 'Needs a Gable or Shed roof - those are the only two with a '
                 + 'rake to follow; every other shape closes all the way round '
                 + 'and its edge is the eave.',
          },
        ],
      },
    },
  },

  deform: {
    type: 'deform',
    label: 'Deform',
    category: CATEGORY.DETAIL,
    icon: 'waves',
    blurb: 'Bends the finished building.',
    teach: 'Build square, then warp. The grammar snaps bays to whole numbers on '
         + 'straight walls; doing that AND curving at the same time would cost '
         + 'the snapping, so the bend runs afterwards and moves everything '
         + 'together - walls, windows and trim. A storey is a solid block, so the '
         + 'warp acts per storey: that is how twisted towers are really built, '
         + 'and it is why Sag racks the corners rather than bowing a long wall.',
    inputs: [{ id: 'building', label: 'Building', kind: PORT_KIND.BUILDING, required: true }],
    outputs: [{ id: 'out', label: 'Building', kind: PORT_KIND.BUILDING }],
    props: {
      amount: {
        type: PROP_TYPE.NUMBER, label: 'Amount', default: 1, min: -90, max: 90, step: 0.1,
        basic: true,
        hint: 'Degrees for Twist, metres for everything else. Negative reverses it.',
      },
      axis: {
        type: PROP_TYPE.NUMBER, label: 'Direction', default: 0, min: 0, max: 360, step: 5,
        unit: 'deg', basic: true,
        hint: 'Which way it leans or bends, in plan. 0 is east.',
        showFor: { mode: ['lean', 'bend'] },
      },
      jitter: {
        type: PROP_TYPE.NUMBER, label: 'Hand-set', default: 0, min: 0, max: 1, step: 0.05,
        basic: true,
        hint: 'Nudges each window, post and chimney off true by a little, each its '
            + 'own way. Works on its own - set the Warp to None and you get a '
            + 'straight building with hand-set joinery.',
      },
    },
    modes: {
      mode: {
        label: 'Warp',
        default: 'twist',
        basic: true,
        options: [
          { value: 'none', label: 'None', teach: 'Leaves the building alone.' },
          {
            value: 'twist', label: 'Twist',
            teach: 'Each storey rotated a little more than the one below. '
                 + 'Amount is the total turn from bottom to top, in degrees.',
          },
          {
            value: 'lean', label: 'Lean',
            teach: 'Slides sideways with height, in a straight line. Pisa.',
          },
          {
            value: 'bend', label: 'Bend',
            teach: 'Slides sideways along a curve, so the base stays upright and '
                 + 'the top swings out. Futurist shells and bowed walls.',
          },
          {
            value: 'sag', label: 'Sag',
            teach: 'Seeded settling: corners rack and floors droop, more the '
                 + 'higher you go. Medieval timber and fantasy. Driven by the '
                 + "document's seed, so it is the same building every time.",
          },
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

/**
 * Whether a MODE applies given the node's other modes.
 *
 * The same rule propApplies enforces for properties, and it needs to exist for
 * modes too the moment one mode depends on another - the Ridge only means
 * anything on a Gable or a Shed. Without it the control shows on every roof and
 * does nothing on five of them, which is the exact failure the greying-out
 * convention exists to prevent.
 */
export function modeApplies(node, key) {
  const def = getNodeDef(node?.type);
  const spec = def?.modes?.[key];
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
