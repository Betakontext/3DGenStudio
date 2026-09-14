// The compiler: a building document in, a BuildingIR and a list of diagnostics
// out.
//
// PURE. No React, no three.js, no I/O, no clock, no ambient randomness. So it
// runs identically in the tab (for the live preview), on the server (for a
// thumbnail or an export bundle), and under `node building/compile.test.mjs`.
// That is the same property vfx/compile.js has and for the same reason: a
// preview that disagrees with an export is the worst bug this kind of tool can
// have, and the cheapest way to make it impossible is to run one implementation
// everywhere.
//
// PHASES, in order, because each depends on the last:
//
//   0  normalise      the document is brought to a known shape
//   1  structure      find the Output node and what reaches it
//   2  topology       topological sort, and reject cycles
//   3  evaluate       walk the sorted nodes, producing shapes and buildings
//   4  emit           flatten the result into the IR
//   5  whole-picture  checks that need the finished numbers
//
// Phase 5 is last on purpose: "the profile consumed the footprint at storey 3 of
// 10" is a sentence that can only be written once the stack has actually been
// built, and a warning that prints real arithmetic is worth more than one that
// guesses.
//
// EVALUATION IS BY VALUE, NOT BY MUTATION. Each node returns a new value and the
// results are held in a Map keyed by node id. Nothing writes back into the
// document, which is what lets the editor keep the document in React state and
// hand the same object to the compiler on every keystroke without cloning it.

import { getNodeDef, readMode, readProp } from './catalog.js';
import { CODE, createDiagnostics, fix, metres } from './diagnostics.js';
import {
  BUILDING_IR_FORMAT, LEVEL_KIND, createBuildingIr, createPolygonTable,
  makeLevel, makeSlot, makeSolid,
} from './ir.js';
import { JOIN } from './clip.js';
import { MASS_PROFILE, stackMass } from './mass.js';
import { MAX_SLOTS, generateFacade } from './facade.js';
import { isFlatCurve } from './param.js';
import { normalizeBuildingDoc } from './doc.js';
import { normalizePolygon, polygonArea, validateRing } from './poly.js';

/** Below this a footprint is almost certainly a mis-drag rather than a plan. */
const TINY_FOOTPRINT_AREA = 0.25;

const JOIN_BY_NAME = { miter: JOIN.MITER, round: JOIN.ROUND, square: JOIN.SQUARE };

/**
 * Compile a document.
 *
 * Always returns an IR, even on error - an empty one. A caller that has to test
 * for null before every access ends up testing in some places and not others,
 * and the preview would rather draw nothing than crash.
 *
 * @param {object} document
 * @returns {{ir: object, diagnostics: Array, ok: boolean}}
 */
export function compileBuilding(document) {
  const diagnostics = createDiagnostics();
  const doc = normalizeBuildingDoc(document);
  const ir = createBuildingIr({ seed: doc.building.seed });

  // --- phase 1: structure --------------------------------------------------

  const nodesById = new Map(doc.nodes.map(node => [node.id, node]));

  for (const node of doc.nodes) {
    if (!getNodeDef(node.type)) {
      diagnostics.error(
        CODE.E_UNKNOWN_NODE,
        `"${node.type}" is not a node this version knows about, so it is skipped. `
        + 'The document may have been made by a newer build.',
        { nodeId: node.id },
      );
    }
  }

  const outputs = doc.nodes.filter(node => node.type === 'output');
  if (outputs.length === 0) {
    diagnostics.error(
      CODE.E_NO_OUTPUT,
      'There is no Output node, so nothing will be built.',
      { fix: fix('Add an Output node', 'addNode', { type: 'output' }) },
    );
    return finish(ir, diagnostics);
  }
  if (outputs.length > 1) {
    diagnostics.error(
      CODE.E_MULTIPLE_OUTPUTS,
      `There are ${outputs.length} Output nodes and only one building can be built. `
      + 'The first is used and the rest are ignored.',
      { nodeId: outputs[1].id },
    );
  }
  const output = outputs[0];

  // Edges, indexed by the node they feed. One driver per input is already
  // guaranteed by normalizeBuildingDoc, so this is a plain map rather than a
  // list per port.
  const incoming = new Map();
  for (const edge of doc.edges) {
    if (!incoming.has(edge.to.node)) incoming.set(edge.to.node, new Map());
    incoming.get(edge.to.node).set(edge.to.port, edge.from);
  }

  // --- phase 2: topology ---------------------------------------------------

  const order = [];
  const state = new Map(); // id -> 'visiting' | 'done'
  let cycleFound = false;

  const visit = nodeId => {
    if (cycleFound) return;
    const mark = state.get(nodeId);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      cycleFound = true;
      diagnostics.error(
        CODE.E_CYCLE,
        'These nodes feed into each other in a loop, so there is no order to '
        + 'build them in and nothing will be built.',
        { nodeId },
      );
      return;
    }
    state.set(nodeId, 'visiting');
    const feeds = incoming.get(nodeId);
    if (feeds) {
      // Sorted, so the traversal - and therefore the IR - does not depend on the
      // order the edges happen to sit in the document.
      for (const port of [...feeds.keys()].sort()) {
        const from = feeds.get(port);
        if (nodesById.has(from.node)) visit(from.node);
      }
    }
    state.set(nodeId, 'done');
    order.push(nodeId);
  };

  visit(output.id);
  if (cycleFound) return finish(ir, diagnostics);

  const reachable = new Set(order);
  for (const node of doc.nodes) {
    if (!reachable.has(node.id) && node.type !== 'output') {
      diagnostics.info(
        CODE.I_NODE_UNREACHABLE,
        `"${getNodeDef(node.type)?.label || node.type}" is not connected to the `
        + 'Output, so it does not affect the building.',
        { nodeId: node.id },
      );
    }
  }

  // --- phase 3: evaluate ---------------------------------------------------

  const values = new Map();

  const inputValue = (node, portId) => {
    const from = incoming.get(node.id)?.get(portId);
    if (!from) return undefined;
    return values.get(from.node);
  };

  for (const nodeId of order) {
    const node = nodesById.get(nodeId);
    const def = getNodeDef(node?.type);
    if (!def) continue;

    if (!node.enabled) {
      diagnostics.info(
        CODE.I_NODE_DISABLED,
        `"${def.label}" is muted, so it is skipped.`,
        { nodeId: node.id },
      );
      // A muted node passes its first input straight through where the kinds
      // agree. Muting a Mass node then shows the plan it was built from rather
      // than an empty preview, which is what makes muting useful for comparing.
      const passthrough = def.inputs?.[0];
      if (passthrough) values.set(node.id, inputValue(node, passthrough.id));
      continue;
    }

    // Required inputs, checked once here rather than in every evaluator.
    let missing = false;
    for (const port of def.inputs || []) {
      if (!port.required) continue;
      if (inputValue(node, port.id) === undefined) {
        diagnostics.error(
          CODE.E_MISSING_INPUT,
          `"${def.label}" has nothing plugged into ${port.label}, so it cannot build anything.`,
          { nodeId: node.id },
        );
        missing = true;
      }
    }
    if (missing) continue;

    values.set(node.id, evaluateNode(node, def, inputValue, diagnostics, doc.building.seed));
  }

  // --- phase 4: emit -------------------------------------------------------

  const result = values.get(output.id);
  if (!result || !Array.isArray(result.levels) || result.levels.length === 0) {
    if (!diagnostics.hasError) {
      diagnostics.error(
        CODE.E_EMPTY_RESULT,
        'The graph produced no geometry. Check that a Footprint reaches the Output '
        + 'through a Mass node.',
        { nodeId: output.id },
      );
    }
    return finish(ir, diagnostics);
  }

  const polygons = createPolygonTable();
  const levelIndices = [];
  for (const level of result.levels) {
    levelIndices.push(ir.levels.length);
    ir.levels.push(makeLevel({
      polygon: polygons.intern(level.polygon),
      z0: level.z0,
      z1: level.z1,
      kind: level.kind,
      index: level.index,
    }));
  }
  for (const slot of result.slots || []) ir.slots.push(makeSlot(slot));

  ir.polygons = polygons.all();
  ir.solids = [makeSolid({ levels: levelIndices, name: doc.name || 'building' })];

  // References travel into the IR so a consumer resolves textures through one
  // table - invariant 3 in doc.js - rather than hunting through nodes.
  for (const [key, entry] of Object.entries(doc.references)) {
    ir.references[key] = entry.ref;
    if (!entry.ref) {
      diagnostics.warn(
        CODE.W_MISSING_ASSET,
        `The "${entry.name || key}" slot has no asset, so it will render untextured.`,
      );
    }
  }

  ir.stats = {
    levelCount: ir.levels.length,
    storeyCount: new Set(
      result.levels.filter(l => l.kind !== LEVEL_KIND.PLINTH).map(l => l.index),
    ).size,
    slotCount: ir.slots.length,
    height: result.height,
    footprintArea: result.footprintArea,
    floorArea: result.floorArea,
    polygonCount: ir.polygons.length,
  };

  // --- phase 5: whole-picture checks --------------------------------------

  if (result.truncatedAt !== null && result.truncatedAt !== undefined) {
    diagnostics.warn(
      CODE.W_MASS_TRUNCATED,
      `The profile uses up the plan at storey ${result.truncatedAt + 1}, so the `
      + `building stops there at ${metres(result.height)} instead of the storeys `
      + 'requested. That is correct for a stepped pyramid and a mistake for a tower.',
      { hint: 'Reduce the profile amount, or lower the storey count to match.' },
    );
  }

  return finish(ir, diagnostics);
}

function finish(ir, diagnostics) {
  return { ir, diagnostics: diagnostics.all, ok: !diagnostics.hasError };
}

/**
 * One node's value.
 *
 * Split out so adding a node type is an entry in the catalog plus a case here -
 * rule 1 in catalog.js. The switch is deliberately flat: a registry of functions
 * would be tidier and would also hide the fact that there are only a handful.
 */
function evaluateNode(node, def, inputValue, diagnostics, seed) {
  switch (node.type) {
    case 'footprint': {
      const raw = readProp(node, 'shape');
      const shape = normalizePolygon(raw || { outer: [], holes: [] });

      const check = validateRing(shape.outer);
      if (!check.ok) {
        diagnostics.error(
          CODE.E_INVALID_FOOTPRINT,
          `The plan cannot be used: ${describeRingProblem(check.reason)}`,
          {
            nodeId: node.id,
            hint: check.reason === 'self-intersecting'
              ? 'Drag the crossing corners apart, or use fewer points.'
              : 'Draw at least three corners that enclose an area.',
          },
        );
        return undefined;
      }

      // A hole that is not inside the outer ring is dropped by normalizePolygon
      // silently, so it is counted here and reported - otherwise a courtyard
      // simply disappears with no explanation.
      const rawHoles = Array.isArray(raw?.holes) ? raw.holes.length : 0;
      if (rawHoles > shape.holes.length) {
        diagnostics.warn(
          CODE.W_HOLE_DROPPED,
          `${rawHoles - shape.holes.length} courtyard outline(s) could not be used and `
          + 'were dropped. A courtyard has to be a closed loop inside the plan.',
          { nodeId: node.id },
        );
      }

      const area = polygonArea(shape);
      if (area < TINY_FOOTPRINT_AREA) {
        diagnostics.warn(
          CODE.W_TINY_FOOTPRINT,
          `The plan encloses only ${Math.round(area * 100) / 100} m2, which is `
          + 'smaller than a doorway. It was probably drawn by accident.',
          { nodeId: node.id },
        );
      }
      return shape;
    }

    case 'mass': {
      const shape = inputValue(node, 'shape');
      if (!shape) return undefined;

      const profileMode = readMode(node, 'profile');
      const stack = stackMass({
        footprint: shape,
        levelCount: readProp(node, 'levelCount'),
        groundHeight: readProp(node, 'groundHeight'),
        levelHeight: readProp(node, 'levelHeight'),
        plinthHeight: readProp(node, 'plinthHeight'),
        join: JOIN_BY_NAME[readMode(node, 'join')] ?? JOIN.MITER,
        cornerRadius: readMode(node, 'join') === 'round' ? readProp(node, 'cornerRadius') : 0,
        profile: {
          mode: profileMode,
          amount: readProp(node, 'amount'),
          step: readProp(node, 'step'),
          every: readProp(node, 'every'),
          curve: readProp(node, 'curve'),
        },
      });

      if (stack.levels.length === 0) {
        diagnostics.error(
          CODE.E_EMPTY_RESULT,
          'The Mass node produced no storeys. The plan may be too small for the '
          + 'profile, or the storey count may be zero.',
          { nodeId: node.id },
        );
        return undefined;
      }

      // A flat curve makes the Curve profile behave exactly like Straight, which
      // is invisible from the viewport and reads as the mode being broken.
      if (profileMode === MASS_PROFILE.CURVE && isFlatCurve(readProp(node, 'curve'))) {
        diagnostics.warn(
          CODE.W_UNUSED_SETTING,
          'The profile curve is flat at 0, so the Curve profile is building exactly '
          + 'the same shape as Straight. Drag a point on the curve to lean the '
          + 'walls in or out.',
          { nodeId: node.id },
        );
      }

      // Rounded corners with a zero radius is the same invisible mistake as the
      // one below, and it is the one an author hits first: they pick Rounded,
      // nothing changes, and there is no way to tell whether the setting is
      // broken or the radius is.
      if (readMode(node, 'join') === 'round' && !(readProp(node, 'cornerRadius') > 0)) {
        diagnostics.warn(
          CODE.W_UNUSED_SETTING,
          'Corners are set to Rounded but the corner radius is 0, so the plan is '
          + 'unchanged. Give it a radius to see any rounding.',
          { nodeId: node.id },
        );
      }

      if (stack.cornerRadiusTooLarge) {
        diagnostics.warn(
          CODE.W_CORNER_RADIUS,
          `A corner radius of ${metres(readProp(node, 'cornerRadius'))} is wider than `
          + 'the narrowest part of the plan, so rounding it would break the building '
          + 'into separate pieces. The sharp plan was kept instead.',
          { nodeId: node.id, hint: 'Reduce the radius to less than half the thinnest wing.' },
        );
      }

      // A profile set to a non-zero amount while the mode ignores it is a common
      // and invisible mistake - the author changes the amount and nothing moves.
      const amount = readProp(node, 'amount');
      const usesAmount = profileMode === MASS_PROFILE.BATTER || profileMode === MASS_PROFILE.JETTY;
      if (!usesAmount && amount > 0) {
        diagnostics.warn(
          CODE.W_UNUSED_SETTING,
          `Profile amount is set to ${metres(amount)} but the ${profileMode} profile `
          + 'does not use it, so it has no effect.',
          { nodeId: node.id },
        );
      }
      return stack;
    }

    case 'facade': {
      const building = inputValue(node, 'building');
      if (!building?.levels?.length) return building;

      // Which storeys this facade claims. Resolved here rather than in facade.js
      // so the geometry code never has to know what 'upper' means, and so the
      // vocabulary can grow without touching it.
      const storeys = new Set(
        building.levels.filter(l => l.kind !== 'plinth').map(l => l.index),
      );
      const top = storeys.size ? Math.max(...storeys) : 0;
      const range = resolveStoreyRange(readMode(node, 'storeys'), {
        top,
        from: readProp(node, 'fromFloor'),
        to: readProp(node, 'toFloor'),
      });

      const facade = generateFacade({
        levels: building.levels,
        seed,
        nodeId: node.id,
        rule: {
          floorFrom: range.from,
          floorTo: range.to,
          openingTag: readMode(node, 'opening'),
          placeDoor: readProp(node, 'placeDoor'),
          bayWidth: readProp(node, 'bayWidth'),
          pierWidth: readProp(node, 'pierWidth'),
          windowWidth: readProp(node, 'windowWidth'),
          sillHeight: readProp(node, 'sillHeight'),
          lintelHeight: readProp(node, 'lintelHeight'),
          groundSillHeight: readProp(node, 'groundSillHeight'),
          doorWidth: readProp(node, 'doorWidth'),
          doorHeight: readProp(node, 'doorHeight'),
          includeCourtyards: readProp(node, 'includeCourtyards'),
        },
      });

      if (facade.claimed.size === 0) {
        diagnostics.warn(
          CODE.W_FACADE_NO_STOREYS,
          `This Facade covers storeys ${range.from} to ${
            range.to === Infinity ? 'the top' : range.to
          }, and the building has ${storeys.size}. It dresses nothing.`,
          { nodeId: node.id, hint: 'Widen the storey range, or add storeys to the Mass.' },
        );
      } else if (facade.slots.length === 0) {
        diagnostics.warn(
          CODE.W_NO_OPENINGS,
          'No openings fitted on the storeys this Facade covers. They may be shorter '
          + 'than the sill and lintel together, or the walls shorter than one bay.',
          { nodeId: node.id, hint: 'Lower the sill and lintel, or raise the storey height.' },
        );
      }

      if (facade.squashed) {
        diagnostics.warn(
          CODE.W_OPENINGS_SQUASHED,
          'Some openings had to be narrowed or shortened to fit their bay. A short '
          + 'wall - the return of an L-plan, say - cannot hold a full-width window.',
          { nodeId: node.id, hint: 'Reduce the window width or the pier.' },
        );
      }

      if (facade.truncated) {
        diagnostics.warn(
          CODE.W_SLOTS_TRUNCATED,
          `This building wants more than ${MAX_SLOTS} openings, so the rest were `
          + 'dropped. Nothing below is wrong; there is simply a limit on how many '
          + 'the preview will place.',
          { nodeId: node.id, hint: 'Widen the bays, or reduce the storey count.' },
        );
      }

      // THE OVERRIDE RULE, and it is what makes chaining facades useful.
      //
      // A facade REPLACES the openings on the storeys it claims and leaves every
      // other storey exactly as it found them. So an all-storeys facade followed
      // by a ground-floor one gives a shopfront under a regular grid, and the
      // order on the board reads the way it behaves: later wins, but only where
      // it applies.
      //
      // The alternative - appending - would put two windows in every bay of any
      // storey two facades both covered, which is a silently wrong building
      // rather than an obviously wrong one.
      const kept = (building.slots || []).filter(slot => !facade.claimed.has(slot.floorIndex));
      return { ...building, slots: [...kept, ...facade.slots] };
    }

    case 'output':
      return inputValue(node, 'building');

    default:
      return undefined;
  }
}

/**
 * Turn a storey mode into an inclusive index range.
 *
 * `top` is the highest storey index, so 'top' is a range of one and does not
 * need the caller to know how tall the building is.
 */
function resolveStoreyRange(mode, { top, from, to }) {
  switch (mode) {
    case 'ground': return { from: 0, to: 0 };
    case 'upper': return { from: 1, to: Infinity };
    case 'top': return { from: top, to: top };
    case 'range': {
      // Tolerant of the two being the wrong way round: an author dragging the
      // numbers past each other should get the range they plainly meant, not an
      // empty one.
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      return { from: lo, to: hi };
    }
    case 'all':
    default:
      return { from: 0, to: Infinity };
  }
}

function describeRingProblem(reason) {
  switch (reason) {
    case 'self-intersecting': return 'the outline crosses itself.';
    case 'too-few-vertices': return 'it has fewer than three corners.';
    case 'zero-area': return 'its corners are in a straight line and enclose nothing.';
    case 'non-finite-vertex': return 'one of its corners is not a real coordinate.';
    case 'not-an-array': return 'it is not a shape at all.';
    default: return 'it is not a usable outline.';
  }
}

/** The IR format this build emits. Re-exported so callers need one import. */
export { BUILDING_IR_FORMAT };
