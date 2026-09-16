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
  makeGable, makeLevel, makeMaterial, makeRoofRung, makeSlot, makeSolid, makeTrim,
} from './ir.js';
import { JOIN } from './clip.js';
import { MASS_PROFILE, stackMass, topOfStack } from './mass.js';
import {
  RIDGE, ROOF_KIND, generateRoof, roofIsCapped, roofTop, stackRoofs,
} from './roof.js';
import { MAX_TRIM_RUNS, TRIM_WHERE, generateTrim } from './trim.js';
import {
  DEFORM_MODE, jitterTransform, makeDeform, makeWarp, warpNormalAt, warpPath, warpTransform,
} from './deform.js';
import { MAX_SLOTS, generateFacade } from './facade.js';
import { placeRoofItems } from './roofitems.js';
import { MAX_FRAME_MEMBERS, generateFrame } from './frame.js';
import { isFlatCurve } from './param.js';
import {
  FACADE_BALCONY_SLOT, FACADE_MESH_SLOT, FACADE_TEXTURE_SLOTS, PALETTE_SLOTS,
  ROOFITEM_MESH_SLOT, TRIM_TEXTURE_SLOT, meshKey,
  nodeTextureKey, paletteOf, textureKey,
} from './stylepack.js';
import { SIDE_ORDER, sideOfNormal } from './sides.js';
import { normalizeBuildingDoc, referenceListKeys } from './doc.js';
import { randomAt, slotId, weightedPick } from './random.js';
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

    values.set(node.id, evaluateNode(
      node, def, inputValue, diagnostics, doc.building.seed, doc.references, doc.nodes,
    ));
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
  // THE DEFORMATION IS APPLIED HERE, ONCE, for everything the IR stores as
  // coordinates. The descriptor travels with it so the mesher can warp the wall
  // and roof vertices it generates from the 2D polygons using the identical
  // function - which is what stops the windows and the walls disagreeing.
  const warp = makeWarp(result.deform);
  if (result.deform && result.deform.mode !== DEFORM_MODE.NONE) {
    ir.deform = makeDeform(result.deform);
  }

  // WHICH MODEL EACH OPENING WEARS. A tag binds a LIST, and every opening rolls
  // its own choice from its own identity - so one building gets a mix of window
  // models and re-rolling the seed gives a different mix rather than the same
  // building in a different order. Hashing the SLOT's identity, never a position
  // in a stream, is what stops adding a storey reshuffling the windows below it.
  const listSizes = new Map();
  const listSize = prefix => {
    if (!listSizes.has(prefix)) {
      listSizes.set(prefix, referenceCount(doc.references, prefix));
    }
    return listSizes.get(prefix);
  };

  /**
   * Which list an opening draws its model from: MOST SPECIFIC WINS, the same
   * chain the materials follow. A facade can override one side of the storeys it
   * claims, then all of them, and otherwise the building-wide list for the tag
   * stands. A door skips the facade rungs entirely - see FACADE_MESH_SLOT.
   */
  const resolveMeshSlot = slot => {
    const tag = slot.styleSlot || slot.type;
    // WHICH facade slot, if any. A balcony has its own - it is placed alongside
    // the window rather than instead of it, so sharing one list would roll a
    // balustrade into the hole. A door has none at all.
    const facadeSlot = slot.type === 'balcony' ? FACADE_BALCONY_SLOT
      : slot.type === 'roof_item' ? ROOFITEM_MESH_SLOT
        : slot.type === 'door' ? '' : FACADE_MESH_SLOT;
    const candidates = [];
    if (slot.source && facadeSlot) {
      // NO PER-SIDE RUNG FOR A ROOF ITEM: it stands on a contour, not on a wall,
      // and `sideOfNormal` of a ridge direction is an answer to a question
      // nobody asked.
      if (slot.type !== 'roof_item') {
        const side = sideOfNormal(slot.transform[8], slot.transform[9]);
        candidates.push(nodeTextureKey(slot.source, facadeSlot, side));
      }
      candidates.push(nodeTextureKey(slot.source, facadeSlot));
    }
    candidates.push(meshKey(tag));
    for (const prefix of candidates) if (listSize(prefix) > 0) return prefix;
    return '';
  };

  // WHICH SUB-STREAM A SLOT DRAWS FROM. Window 0, door 1, balcony 2, roof item
  // 3, post 4 - and facade.js hashes its seedKey with the same numbers, so the
  // two agree by construction rather than by coincidence.
  const subOf = slot => (slot.type === 'door' ? 1
    : slot.type === 'balcony' ? 2
      : slot.type === 'roof_item' ? 3
        : slot.type === 'pillar' ? 4 : 0);
  const jitterAmount = result.jitter || 0;
  const jitterSlot = slotId('deform', 'jitter');

  for (const slot of result.slots || []) {
    const meshSlot = resolveMeshSlot(slot);
    const count = meshSlot ? listSize(meshSlot) : 0;
    // THE IDENTITY IS THE OBJECT, not the pre-hashed seedKey. randomAt hashes
    // {face, floor, bay, sub} itself - handing it the number instead reads every
    // field as undefined, so every opening in the building hashes identically
    // and wears the same model. It looked deterministic, because it was; it was
    // just the same answer 41 times.
    const variant = count > 1
      ? weightedPick(doc.building.seed, slotId('openingMesh', meshSlot), {
        face: slot.faceIndex,
        floor: slot.floorIndex,
        bay: slot.bayIndex,
        // Matches facade.js's seedKey: window 0, door 1, balcony 2. A balcony
        // and the window it hangs on must not roll in lockstep, or every model-3
        // window would carry a model-3 balustrade.
        sub: subOf(slot),
      }, new Array(count).fill(1))
      : 0;
    // AFTER THE WARP, never before: the warp is a function of position, so
    // jittering first would feed it a position the building does not have and
    // the nudge would be re-scaled by whatever the warp does there.
    const placed = warpTransform(warp, slot.transform);
    ir.slots.push(makeSlot({
      ...slot,
      meshSlot,
      variant: variant >= 0 ? variant : 0,
      transform: jitterAmount
        ? jitterTransform(placed, jitterAmount, index => randomAt(
          doc.building.seed, jitterSlot, {
            face: slot.faceIndex, floor: slot.floorIndex, bay: slot.bayIndex,
            sub: subOf(slot),
          }, index,
        ))
        : placed,
    }));
  }

  ir.polygons = polygons.all();
  // ONE SOLID PER PART. A building that was never merged has one part and this
  // reduces to what it always did; a merged one keeps its wings distinguishable,
  // which is the whole reason the field was a list from the start.
  const parts = result.parts?.length
    ? result.parts
    : [{ count: result.levels.length, name: doc.name || 'building' }];
  let taken = 0;
  ir.solids = parts.map((part, index) => {
    const slice = levelIndices.slice(taken, taken + part.count);
    taken += part.count;
    return makeSolid({
      levels: slice,
      name: parts.length > 1
        ? `${doc.name || 'building'} ${index + 1}`
        : (doc.name || 'building'),
    });
  }).filter(solid => solid.levels.length);

  // The palette travels into the IR as material slots, ALWAYS - defaulted when
  // no style has been applied - so a consumer never has to know whether this
  // building has a style and never has to carry its own fallback colours.
  const palette = paletteOf(doc);
  for (const slot of PALETTE_SLOTS) {
    // The texture, if this slot has one bound. Resolved THROUGH THE REFERENCE
    // TABLE rather than read off a node - invariant 3 in doc.js - so bundling,
    // import remapping and "what is missing" all have one place to look.
    const entry = pickReference(doc.references, textureKey(slot), doc.building.seed);
    ir.materials.push(makeMaterial({
      slot,
      color: palette[slot],
      ref: entry?.ref || '',
      tile: entry?.tileMetres || 0,
    }));
  }

  // Then the per-facade and per-side overrides, which are MORE SPECIFIC and win
  // by resolveMaterialIndex's scoring rather than by being later in the list.
  // They carry the same palette colour as the slot they override, so an override
  // whose texture fails to load falls back to the same colour the rest of the
  // building uses rather than to a stray grey.
  for (const override of result.materialOverrides || []) {
    ir.materials.push(makeMaterial({
      slot: override.slot,
      color: palette[override.slot],
      ref: override.ref,
      tile: override.tile || 0,
      fromFloor: override.fromFloor,
      toFloor: override.toFloor,
      side: override.side,
    }));
  }

  // A TRIM NODE THAT BINDS ITS OWN TEXTURE GETS ITS OWN MATERIAL. Trims
  // accumulate - a plinth, a string course and a cornice are three nodes - so
  // one shared trim material would make them impossible to tell apart. Nodes
  // that bind nothing all share the building-wide trim entry, so the common case
  // still costs one material and one draw call.
  const trimMaterialBySource = new Map();
  const buildingTrim = ir.materials.findIndex(material => material.slot === 'trim');
  for (const run of result.trims || []) {
    if (!run.source || trimMaterialBySource.has(run.source)) continue;
    const entry = pickReference(
      doc.references, nodeTextureKey(run.source, TRIM_TEXTURE_SLOT), doc.building.seed,
    );
    if (!entry?.ref) continue;
    trimMaterialBySource.set(run.source, ir.materials.length);
    ir.materials.push(makeMaterial({
      slot: 'trim',
      color: palette.trim,
      ref: entry.ref,
      tile: entry.tileMetres || 0,
    }));
  }

  for (const run of result.trims || []) {
    ir.trims.push(makeTrim({
      ...run,
      path: warpPath(warp, run.path),
      // Taken at the run's FIRST station rather than at some average: a warp is
      // a field, so a direction only means anything at a place, and a timber is
      // short enough that its ends agree.
      normal: run.normal
        ? warpNormalAt(warp, run.normal, run.path[0], run.path[1], run.path[2])
        : [],
      material: trimMaterialBySource.get(run.source) ?? buildingTrim,
    }));
  }

  for (const entry of roofsOf(result)) {
    if (!entry?.rungs?.length) continue;
    ir.roofs.push({
      kind: entry.kind,
      height: entry.height,
      baseZ: entry.rungs[0].z,
      closed: Boolean(entry.closed),
      // Interned into the SAME table the levels use, so a stepped roof whose
      // tread and riser share a shape stores it once and a flat roof reuses the
      // top level's polygon outright.
      rungs: entry.rungs.map(rung => makeRoofRung({
        polygons: rung.polygons.map(polygon => polygons.intern(polygon)),
        z: rung.z,
      })),
      // Deformed like everything else that travels as coordinates - a gable end
      // on a leaning building has to lean with it.
      gables: (entry.gables || []).map(points => makeGable({
        path: warpPath(warp, points.flat()),
      })),
    });
  }

  // References travel into the IR so a consumer resolves textures through one
  // table - invariant 3 in doc.js - rather than hunting through nodes.
  for (const [key, entry] of Object.entries(doc.references)) {
    ir.references[key] = entry.ref;
    if (entry.rotation) ir.meshRotations[key] = entry.rotation;
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
    // THE TALLEST, not the sum and not the first: this is the number the HUD
    // shows as "+Nm roof", and on a hall with a tower it means the crown the eye
    // reads, which is the taller of the two.
    roofHeight: ir.roofs.reduce((tallest, roof) => Math.max(tallest, roof.height), 0),
    trimCount: ir.trims.length,
    trimLength: ir.trims.reduce((total, run) => total + pathLength(run.path, run.closed), 0),
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
/**
 * Which sides a facade's openings or balconies are allowed on.
 *
 * Returns a SET, and an empty one means "every side" - which is also what a
 * document written before these props existed produces, so nothing changes for
 * one. Four booleans rather than a mode because the answer is a subset: two
 * sides of four is the common case and a single-select cannot say it.
 */
function sidesFrom(node, prefix) {
  const out = new Set();
  for (const side of SIDE_ORDER) {
    const key = `${prefix}${side[0].toUpperCase()}${side.slice(1)}`;
    if (readProp(node, key) !== false) out.add(side);
  }
  // All four on is the same as no filter at all, and saying so here means the
  // common case costs nothing downstream.
  return out.size === SIDE_ORDER.length ? null : out;
}

/**
 * Every roof on a building.
 *
 * A building that has never been merged has one, and `roof` and `roofs[0]` are
 * the same object. Written as a function rather than assumed because a value
 * flowing through the graph may predate either field - a Mass with no Roof yet
 * has neither - and three call sites would otherwise each guard it differently.
 */
function roofsOf(building) {
  if (building?.roofs?.length) return building.roofs;
  return building?.roof ? [building.roof] : [];
}

/** The roof that reads as the main one: the one that reaches highest. */
function tallestRoof(building) {
  let best = null;
  for (const roof of roofsOf(building)) {
    const top = roof?.rungs?.[roof.rungs.length - 1]?.z;
    if (!Number.isFinite(top)) continue;
    const bestTop = best?.rungs?.[best.rungs.length - 1]?.z ?? -Infinity;
    if (top > bestTop) best = roof;
  }
  return best;
}

function evaluateNode(node, def, inputValue, diagnostics, seed, references = {}, nodes = []) {
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
          balcony: readMode(node, 'balcony'),
          balconyDepth: readProp(node, 'balconyDepth'),
          balconyWidth: readProp(node, 'balconyWidth'),
          balconyHeight: readProp(node, 'balconyHeight'),
          balconyChance: readProp(node, 'balconyChance'),
          // A SET, built here rather than in facade.js, so the geometry code
          // never has to know how the vocabulary spells a side.
          openingSides: sidesFrom(node, 'opening'),
          balconySides: sidesFrom(node, 'balcony'),
          posts: readMode(node, 'posts'),
          postWidth: readProp(node, 'postWidth'),
          postDepth: readProp(node, 'postDepth'),
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
      // PER-FACADE TEXTURE OVERRIDES, collected here because this is the only
      // place that knows which storeys this node claims. They are recorded as
      // SELECTORS rather than applied now - the material table is assembled once,
      // after every node has run, so a later facade's override can win over an
      // earlier one by the ordinary rule.
      const overrides = [];
      if (facade.claimed.size) {
        const from = Math.min(...facade.claimed);
        const to = Math.max(...facade.claimed);
        for (const slot of FACADE_TEXTURE_SLOTS) {
          // The facade-wide binding first, then any per-side ones. Both are
          // optional and independent: a facade can have a side override with no
          // facade-wide texture at all, in which case the other sides fall
          // through to the building-wide slot.
          for (const side of ['', ...SIDE_ORDER]) {
            const entry = pickReference(
              references, nodeTextureKey(node.id, slot, side), seed,
            );
            if (entry?.ref) {
              overrides.push({
                slot, fromFloor: from, toFloor: to, side, ref: entry.ref, tile: entry.tileMetres,
              });
            }
          }
        }
      }

      const kept = (building.slots || []).filter(slot => !facade.claimed.has(slot.floorIndex));
      return {
        ...building,
        slots: [...kept, ...facade.slots],
        materialOverrides: [...(building.materialOverrides || []), ...overrides],
      };
    }

    case 'roof': {
      const building = inputValue(node, 'building');
      if (!building?.levels?.length) return building;

      // A SECOND ROOF CONTINUES THE FIRST, it does not replace it. roof.js
      // argues a roof is the massing carried on past the top storey; the same
      // argument makes a roof a fine base for another roof, and that is what
      // gives a stepped platform with a hip cap (a Mayan temple) or tiers over
      // a mansard (most of a pagoda) out of the vocabulary that already exists.
      // Replacing would have made the extra node silently do nothing, which is
      // the worst of the three options.
      const below = building.roof;
      if (roofIsCapped(below)) {
        // Nothing left to build on: the walk below consumed the plan and ended
        // on a ridge. Say so here rather than letting generateRoof report the
        // sliver as "too small for a roof", which is true but unhelpful.
        diagnostics.warn(
          CODE.W_ROOF_ON_RIDGE,
          'The roof below already closes to a ridge, so there is no surface for '
          + 'this one to stand on and it was skipped.',
          {
            nodeId: node.id,
            hint: 'Give the roof below a height cap so it ends on a flat deck, '
                + 'or set it to Stepped so it ends on a tread.',
          },
        );
        return building;
      }

      const top = roofTop(below) || topOfStack(building);
      const kind = readMode(node, 'kind');
      const roof = generateRoof({
        polygons: top.polygons,
        baseZ: top.z,
        kind,
        pitch: readProp(node, 'pitch'),
        upperPitch: readProp(node, 'upperPitch'),
        breakFraction: readProp(node, 'breakFraction'),
        stepRun: readProp(node, 'stepRun'),
        stepRise: readProp(node, 'stepRise'),
        overhang: kind === ROOF_KIND.TIERED ? readProp(node, 'overhang') : 0,
        maxHeight: readProp(node, 'maxHeight'),
        ridge: readMode(node, 'ridge'),
        ridgeAngle: readProp(node, 'ridgeAngle'),
      });

      if (roof.fallback === 'too-small') {
        // Named for what the author is looking at: with roofs chained, "the top
        // of the building" is the deck the previous one ended on, and pointing
        // at the Mass profile would send them to the wrong node entirely.
        diagnostics.warn(
          CODE.W_ROOF_FALLBACK,
          below
            ? 'The deck the roof below ends on is too small for a roof of this '
              + 'shape, so this one was left flat.'
            : 'The top of the building is too small for a roof of this shape, so it '
              + 'was left flat. A roof needs a plan wider than one offset step.',
          {
            nodeId: node.id,
            hint: below
              ? 'Raise the height cap on the roof below so it stops sooner and leaves a wider deck.'
              : 'Widen the plan, or reduce the Mass profile so less is eaten by the time it reaches the top.',
          },
        );
      } else if (!roof.closed && !readProp(node, 'maxHeight')) {
        diagnostics.info(
          CODE.I_ROOF_OPEN,
          `The roof reached ${metres(roof.height)} without closing to a ridge, so `
          + 'it ends on a flat deck.',
          { nodeId: node.id },
        );
      }

      // `roofs` is every roof on the building and `roof` is the one still OPEN
      // for stacking. They are the same thing until a Merge node joins two
      // branches, at which point there are several roofs and none of them is
      // open - see the Merge case for why.
      const others = (building.roofs || []).filter(entry => entry !== below);
      if (!below) return { ...building, roof, roofs: [...others, roof] };

      const stacked = stackRoofs(below, roof);
      if (stacked.rungs.length > below.rungs.length) {
        diagnostics.info(
          CODE.I_ROOF_STACKED,
          `This roof sits on the one below, starting at ${metres(top.z)} and `
          + `taking the building to ${metres(stacked.rungs[stacked.rungs.length - 1].z)}.`,
          { nodeId: node.id },
        );
      }
      return { ...building, roof: stacked, roofs: [...others, stacked] };
    }

    case 'merge': {
      // TWO BUILDINGS, ONE BUILDING. Everything a building is - levels, slots,
      // trims, roofs - is a list, so joining two is concatenation and nothing
      // else. That is not luck: the IR has carried a `solids` ARRAY since the
      // first phase precisely so that a building could one day be more than one
      // volume, and this is the node that finally makes one.
      const a = inputValue(node, 'a');
      const b = inputValue(node, 'b');
      if (!a?.levels?.length) return b;
      if (!b?.levels?.length) return a;

      const roofs = [...(a.roofs || []), ...(b.roofs || [])];
      return {
        levels: [...a.levels, ...b.levels],
        slots: [...(a.slots || []), ...(b.slots || [])],
        trims: [...(a.trims || []), ...(b.trims || [])],
        materialOverrides: [
          ...(a.materialOverrides || []), ...(b.materialOverrides || []),
        ],
        // THE DEFORMATION AND THE JITTER COME FROM THE FIRST BRANCH, because a
        // warp is a field over one coordinate frame and two of them would fight
        // over the same points. Put the Deform after the Merge and it covers
        // everything, which is almost always what a leaning street wants.
        deform: a.deform || b.deform,
        jitter: a.jitter || b.jitter,
        roofs,
        // THE AGGREGATE NUMBERS, because a merged building has no single mass
        // stage to have computed them. Height is the TALLER of the two - a
        // merged building is as tall as its tallest part - while the areas add
        // up, which is what "floor area" means on a house with a tower.
        height: Math.max(a.height || 0, b.height || 0),
        footprintArea: (a.footprintArea || 0) + (b.footprintArea || 0),
        floorArea: (a.floorArea || 0) + (b.floorArea || 0),
        // Each branch stays its own SOLID. ir.solids has been an array since the
        // first phase for exactly this, and an exporter that wants one object per
        // part - which is what a game engine wants - needs the split kept.
        parts: [
          ...(a.parts || [{ count: a.levels.length, name: 'part' }]),
          ...(b.parts || [{ count: b.levels.length, name: 'part' }]),
        ],
        // NOTHING IS OPEN FOR STACKING after a merge: "the roof below" is now
        // ambiguous, and a Roof node here would have to pick one arbitrarily. It
        // builds over the merged top instead, which is the honest answer, and a
        // roof meant for one wing belongs in that wing's branch.
        roof: null,
      };
    }

    case 'frame': {
      const building = inputValue(node, 'building');
      if (!building?.levels?.length) return building;

      const storeys = new Set(
        building.levels.filter(l => l.kind !== 'plinth').map(l => l.index),
      );
      const top = storeys.size ? Math.max(...storeys) : 0;
      const range = resolveStoreyRange(readMode(node, 'storeys'), {
        top,
        from: readProp(node, 'fromFloor'),
        to: readProp(node, 'toFloor'),
      });

      const frame = generateFrame({
        levels: building.levels,
        seed,
        nodeId: node.id,
        rule: {
          floorFrom: range.from,
          floorTo: range.to,
          bayWidth: readProp(node, 'bayWidth'),
          brace: readMode(node, 'brace'),
          width: readProp(node, 'width'),
          depth: readProp(node, 'depth'),
          margin: readProp(node, 'margin'),
          rails: readProp(node, 'rails'),
          includeCourtyards: readProp(node, 'includeCourtyards'),
        },
      });

      if (!frame.runs.length) {
        diagnostics.warn(
          CODE.W_FRAME_NO_MEMBERS,
          'This Frame covered no storeys, so no timber was drawn.',
          {
            nodeId: node.id,
            hint: 'Widen the storey range. A Frame set to "Above the ground" on a '
                + 'single-storey building covers nothing.',
          },
        );
      } else if (frame.truncated) {
        diagnostics.warn(
          CODE.W_FRAME_TRUNCATED,
          `This Frame hit the ${MAX_FRAME_MEMBERS}-timber limit and stopped there.`,
          {
            nodeId: node.id,
            hint: 'Widen the panels, use a simpler brace, or cover fewer storeys.',
          },
        );
      }

      // TIMBERS ARE TRIM RUNS, so they accumulate with the mouldings for the
      // same reason those accumulate with each other - and so that everything
      // downstream (the deformation, the exporter, the material selector) needs
      // no knowledge that this node exists.
      return { ...building, trims: [...(building.trims || []), ...frame.runs] };
    }

    case 'roofitem': {
      const building = inputValue(node, 'building');
      if (!building?.levels?.length) return building;

      // THE TALLEST ROOF, not the last one added. After a merge there are
      // several and "the roof" means the one the eye reads as the main one; a
      // chimney meant for a wing belongs in that wing's branch, before the
      // merge, where there is only one roof to be on.
      const placed = placeRoofItems({
        roof: tallestRoof(building),
        seed,
        nodeId: node.id,
        rule: {
          where: readMode(node, 'where'),
          item: readMode(node, 'item'),
          count: readProp(node, 'count'),
          along: readProp(node, 'along'),
          width: readProp(node, 'width'),
          depth: readProp(node, 'depth'),
          height: readProp(node, 'height'),
          sink: readProp(node, 'sink'),
        },
      });

      if (placed.reason === 'no-roof') {
        // ORDER, not a missing node, is nearly always the cause: the palette
        // appends after whatever is selected, so a Roof Detail added while the
        // Facade was selected lands BEFORE the roof and reads nothing. Say which
        // it is, and offer the move.
        const roofAfter = nodes.some(other => other.type === 'roof');
        diagnostics.warn(
          CODE.W_ROOF_ITEM_NO_ROOF,
          roofAfter
            ? 'This sits BEFORE the Roof, so there was no roof for it to stand on '
              + 'and nothing was placed.'
            : 'There is no roof for this to stand on, so nothing was placed.',
          {
            nodeId: node.id,
            hint: roofAfter
              ? 'Move it after the Roof node.'
              : 'Add a Roof node before this one. A chimney needs a roof even '
                + 'when the roof is flat.',
            fix: roofAfter
              ? fix('Move it after the Roof', 'moveAfterType', { nodeId: node.id, type: 'roof' })
              : fix('Add a Roof', 'addNode', { type: 'roof' }),
          },
        );
      }

      // ACCUMULATE, like trims and unlike facades: a building has a chimney AND
      // a finial, and a second node that replaced the first would make the
      // ordinary case impossible.
      return { ...building, slots: [...(building.slots || []), ...placed.slots] };
    }

    case 'trim': {
      const building = inputValue(node, 'building');
      if (!building?.levels?.length) return building;

      const where = readMode(node, 'where');
      const { runs, truncated } = generateTrim({
        levels: building.levels,
        roofs: roofsOf(building),
        where,
        every: readProp(node, 'every'),
        includeHoles: readProp(node, 'includeHoles'),
        projection: readProp(node, 'projection'),
        depth: readProp(node, 'depth'),
        source: node.id,
      });

      if (!runs.length) {
        diagnostics.warn(
          CODE.W_TRIM_NO_RUNS,
          where === TRIM_WHERE.STRING
            ? 'A string course needs at least two storeys to sit between, so this '
              + 'run produced nothing.'
            : 'This trim run found no edge to follow.',
          {
            nodeId: node.id,
            hint: where === TRIM_WHERE.STRING
              ? 'Add storeys, or lower Every so a band lands below the top.'
              : 'Check that the building has levels above this run.',
          },
        );
      } else if (truncated) {
        diagnostics.warn(
          CODE.W_TRIM_TRUNCATED,
          `This run hit the ${MAX_TRIM_RUNS}-run limit and stopped there.`,
          {
            nodeId: node.id,
            hint: 'Raise Every so fewer storeys get a band, or turn off '
                + '"Around courtyards".',
          },
        );
      }

      // A PARAPET NEEDS A DECK. On a pitched roof the last contour is the ridge,
      // so the run would be a fin along the apex - which is a ridge capping, a
      // real thing, but not what the author asked for. Said here rather than
      // silently drawn, because "I added a parapet and got a spine" is exactly
      // the kind of result nobody can explain.
      // roofIsCapped, not `closed`: a FLAT roof is trivially closed and its whole
      // deck is exactly what a parapet wants to stand on. What disqualifies a
      // roof is having closed after rising.
      if (where === TRIM_WHERE.PARAPET && roofsOf(building).some(roofIsCapped)) {
        diagnostics.warn(
          CODE.W_PARAPET_ON_PITCH,
          'This roof closes to a ridge, so the parapet follows the ridge rather '
          + 'than standing on a deck.',
          {
            nodeId: node.id,
            hint: 'Set the roof to Flat, or give it a height cap so it ends on a deck.',
          },
        );
      }

      // TRIMS ACCUMULATE. A facade REPLACES the storeys it claims and a roof
      // CONTINUES the one below it; a trim does neither, because a plinth, a
      // string course and a cornice are three different runs on one building and
      // any rule that made a later node supersede an earlier one would make the
      // common case impossible.
      return { ...building, trims: [...(building.trims || []), ...runs] };
    }

    case 'deform': {
      const building = inputValue(node, 'building');
      if (!building?.levels?.length) return building;

      const mode = readMode(node, 'mode');
      const amount = readProp(node, 'amount');
      // JITTER IS INDEPENDENT OF THE WARP, and the early return used to make
      // that impossible: a straight building with hand-set joinery is a real and
      // common thing to want, and it is Warp = None with Hand-set turned up.
      const jitter = readProp(node, 'jitter') || 0;
      const warped = mode !== DEFORM_MODE.NONE && amount;
      if (!warped && !jitter) return building;
      if (!warped) return { ...building, jitter };

      // The warp is normalised over the building's own height and turns about
      // its own centre, so the same settings mean the same thing on a cottage
      // and a tower. Taking the plan's bounding centre rather than its centroid:
      // an L-shaped plan's centroid can sit outside the building, and twisting
      // about a point in mid-air throws the whole thing sideways.
      const box = levelBounds(building.levels);
      const height = Math.max(...building.levels.map(level => level.z1), 0);

      return {
        ...building,
        jitter,
        deform: makeDeform({
          mode,
          amount,
          axis: readProp(node, 'axis'),
          height,
          seed,
          centre: [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2],
        }),
      };
    }

    case 'output':
      return inputValue(node, 'building');

    default:
      return undefined;
  }
}

/**
 * One entry from a reference slot's list, chosen by the document's seed.
 *
 * A SLOT HOLDS A LIST so that one building can be re-rolled into another - give
 * a style three bricks and three window models and a street of them stops
 * looking like one building copied. The pick is seeded by the slot's KEY and by
 * the caller's identity, never by a position in a stream, so adding a fourth
 * brick does not reshuffle the windows (building/random.js says why at length).
 *
 * Weights are uniform: a reference entry is an asset id and a name, and the
 * per-entry weight the style-pack vocabulary carries has nowhere to live here
 * yet. Uniform is the honest default rather than a silent 1-in-n that pretends
 * to be weighted.
 */
function pickReference(references, prefix, seed, identity = 0) {
  const entries = referenceListKeys(references, prefix)
    .map(key => references[key])
    .filter(entry => entry?.ref);
  if (!entries.length) return null;
  if (entries.length === 1) return entries[0];
  const index = weightedPick(seed, slotId('reference', prefix), identity, entries.map(() => 1));
  return entries[index >= 0 ? index : 0];
}

/** How many usable entries a slot's list has. */
function referenceCount(references, prefix) {
  return referenceListKeys(references, prefix)
    .filter(key => references[key]?.ref).length;
}

/** Total length of a flat [x, y, z, ...] polyline, closing the loop if asked. */
function pathLength(path, closed) {
  let total = 0;
  const count = Math.floor(path.length / 3);
  for (let i = 1; i < count; i++) {
    total += Math.hypot(
      path[i * 3] - path[(i - 1) * 3],
      path[i * 3 + 1] - path[(i - 1) * 3 + 1],
      path[i * 3 + 2] - path[(i - 1) * 3 + 2],
    );
  }
  if (closed && count > 2) {
    total += Math.hypot(
      path[0] - path[(count - 1) * 3],
      path[1] - path[(count - 1) * 3 + 1],
      path[2] - path[(count - 1) * 3 + 2],
    );
  }
  return total;
}

/** The plan bounds of a whole stack, for centring a warp. */
function levelBounds(levels) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const level of levels) {
    for (const point of level.polygon.outer || []) {
      if (point[0] < minX) minX = point[0];
      if (point[0] > maxX) maxX = point[0];
      if (point[1] < minY) minY = point[1];
      if (point[1] > maxY) maxY = point[1];
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
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
