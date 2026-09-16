// node building/compile.test.mjs

import assert from 'node:assert/strict';
import { compileBuilding } from './compile.js';
import { CODE, SEVERITY } from './diagnostics.js';
import { BUILDING_IR_FORMAT, LEVEL_KIND, irDigest, validateIrJson } from './ir.js';
import { createNode } from './catalog.js';
import { MASS_PROFILE } from './mass.js';
import { appendReference, normalizeBuildingDoc } from './doc.js';
import { sideOfNormal } from './sides.js';
import { FACADE_BALCONY_SLOT, FACADE_MESH_SLOT, meshKey, nodeTextureKey } from './stylepack.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const codes = result => result.diagnostics.map(d => d.code);
const has = (result, code) => codes(result).includes(code);

// footprint -> mass -> output, the minimum working graph.
function graph({ shape, mass, seed = 12345 } = {}) {
  const fp = createNode('footprint', 'fp');
  if (shape) fp.props.shape = shape;
  const ms = createNode('mass', 'ms');
  Object.assign(ms.props, mass?.props || {});
  Object.assign(ms.modes, mass?.modes || {});
  const out = createNode('output', 'out');
  return normalizeBuildingDoc({
    building: { seed },
    nodes: [fp, ms, out],
    edges: [
      { from: { node: 'fp', port: 'out' }, to: { node: 'ms', port: 'shape' } },
      { from: { node: 'ms', port: 'out' }, to: { node: 'out', port: 'building' } },
    ],
  });
}


/** The minimum graph plus a chain of stages between the Mass and the Output. */
function graphWithStages(stages, options = {}) {
  const base = graph(options);
  const nodes = [...base.nodes];
  const edges = base.edges.filter(edge => edge.to.node !== 'out');
  let previous = 'ms';
  stages.forEach((stage, i) => {
    const node = createNode(stage.type, `s${i}`);
    Object.assign(node.props, stage.props || {});
    Object.assign(node.modes, stage.modes || {});
    nodes.push(node);
    edges.push({ from: { node: previous, port: 'out' }, to: { node: node.id, port: 'building' } });
    previous = node.id;
  });
  edges.push({ from: { node: previous, port: 'out' }, to: { node: 'out', port: 'building' } });
  return normalizeBuildingDoc({ ...base, nodes, edges });
}

// --- the happy path ---------------------------------------------------------

test('a minimal graph compiles to levels', () => {
  const result = compileBuilding(graph());
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.ir.format, BUILDING_IR_FORMAT);
  assert.equal(result.ir.levels.length, 3);
  assert.equal(result.ir.solids.length, 1);
  assert.equal(result.ir.solids[0].levels.length, 3);
  assert.equal(result.ir.stats.height, 4 + 3 + 3);
});

test('the ground floor is level index 0 and its own kind', () => {
  const ir = compileBuilding(graph()).ir;
  assert.equal(ir.levels[0].kind, LEVEL_KIND.GROUND);
  assert.equal(ir.levels[0].index, 0);
  assert.equal(ir.levels[1].kind, LEVEL_KIND.UPPER);
});

test('identical storeys share ONE interned polygon', () => {
  // The reason a 40-storey tower's IR is small.
  const ir = compileBuilding(graph({ mass: { props: { levelCount: 40 } } })).ir;
  assert.equal(ir.levels.length, 40);
  assert.equal(ir.polygons.length, 1, `interning failed: ${ir.polygons.length} polygons`);
});

test('a battered tower does NOT over-intern', () => {
  const ir = compileBuilding(graph({
    mass: { modes: { profile: MASS_PROFILE.BATTER }, props: { levelCount: 5, amount: 2 } },
  })).ir;
  assert.equal(ir.polygons.length, 5, 'every storey has a different cross-section');
});

test('the seed reaches the IR', () => {
  assert.equal(compileBuilding(graph({ seed: 987 })).ir.seed, 987);
});

// --- the IR contract --------------------------------------------------------

test('the IR is plain, finite JSON', () => {
  // No typed arrays, no NaN, no undefined - it goes into an export bundle and is
  // read by code that is not this code.
  for (const doc of [
    graph(),
    graph({ mass: { modes: { profile: MASS_PROFILE.SETBACK }, props: { step: 1, every: 2, levelCount: 8 } } }),
    graph({ shape: { outer: [[0, 0], [24, 0], [24, 8], [8, 8], [8, 24], [0, 24]], holes: [] } }),
  ]) {
    const problems = validateIrJson(compileBuilding(doc).ir);
    assert.deepEqual(problems, [], problems.join('; '));
  }
});

test('the IR round trips through JSON unchanged', () => {
  const ir = compileBuilding(graph()).ir;
  assert.deepEqual(JSON.parse(JSON.stringify(ir)), ir);
});

test('recompiling an unchanged document is byte-identical', () => {
  // What lets the editor skip work, and what makes a golden test possible.
  const doc = graph({ mass: { modes: { profile: MASS_PROFILE.BATTER }, props: { amount: 1.7, levelCount: 6 } } });
  assert.equal(irDigest(compileBuilding(doc).ir), irDigest(compileBuilding(doc).ir));
});

test('edge order in the document does not change the IR', () => {
  const a = graph();
  const b = normalizeBuildingDoc({ ...a, edges: [...a.edges].reverse() });
  assert.equal(irDigest(compileBuilding(a).ir), irDigest(compileBuilding(b).ir));
});

// --- structure errors -------------------------------------------------------

test('no Output node is an error, with a fix', () => {
  const doc = normalizeBuildingDoc({ nodes: [createNode('footprint', 'fp')] });
  const result = compileBuilding(doc);
  assert.equal(result.ok, false);
  assert.ok(has(result, CODE.E_NO_OUTPUT));
  const entry = result.diagnostics.find(d => d.code === CODE.E_NO_OUTPUT);
  assert.equal(entry.fix.action, 'addNode');
  // A fix must survive serialisation - it travels into an export bundle.
  assert.deepEqual(JSON.parse(JSON.stringify(entry.fix)), entry.fix);
});

test('two Output nodes is an error naming the second', () => {
  const doc = graph();
  const withTwo = normalizeBuildingDoc({
    ...doc, nodes: [...doc.nodes, createNode('output', 'out2')],
  });
  const result = compileBuilding(withTwo);
  assert.ok(has(result, CODE.E_MULTIPLE_OUTPUTS));
  assert.equal(result.diagnostics.find(d => d.code === CODE.E_MULTIPLE_OUTPUTS).nodeId, 'out2');
});

test('a missing required input is an error naming the port', () => {
  const doc = normalizeBuildingDoc({
    nodes: [createNode('mass', 'ms'), createNode('output', 'out')],
    edges: [{ from: { node: 'ms', port: 'out' }, to: { node: 'out', port: 'building' } }],
  });
  const result = compileBuilding(doc);
  assert.ok(has(result, CODE.E_MISSING_INPUT));
  assert.match(result.diagnostics.find(d => d.code === CODE.E_MISSING_INPUT).message, /Shape/);
});

test('an unknown node type is reported, not crashed on', () => {
  const doc = normalizeBuildingDoc({
    nodes: [{ id: 'x', type: 'from-the-future' }, createNode('output', 'out')],
  });
  const result = compileBuilding(doc);
  assert.ok(has(result, CODE.E_UNKNOWN_NODE));
  assert.match(result.diagnostics.find(d => d.code === CODE.E_UNKNOWN_NODE).message, /newer build/);
});

test('a cycle is reported instead of hanging', () => {
  // normalizeBuildingDoc cannot see a cycle - every edge is individually legal.
  const doc = normalizeBuildingDoc({
    nodes: [createNode('mass', 'a'), createNode('mass', 'b'), createNode('output', 'out')],
    edges: [
      { from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'shape' } },
      { from: { node: 'b', port: 'out' }, to: { node: 'a', port: 'shape' } },
      { from: { node: 'b', port: 'out' }, to: { node: 'out', port: 'building' } },
    ],
  });
  const result = compileBuilding(doc);
  assert.equal(result.ok, false);
  assert.ok(has(result, CODE.E_CYCLE));
});

test('an unreachable node is info, not an error', () => {
  const doc = graph();
  const withStray = normalizeBuildingDoc({
    ...doc, nodes: [...doc.nodes, createNode('footprint', 'stray')],
  });
  const result = compileBuilding(withStray);
  assert.equal(result.ok, true);
  const entry = result.diagnostics.find(d => d.code === CODE.I_NODE_UNREACHABLE);
  assert.equal(entry.severity, SEVERITY.INFO);
  assert.equal(entry.nodeId, 'stray');
});

// --- geometry errors --------------------------------------------------------

test('a self-intersecting plan is rejected with an actionable hint', () => {
  const result = compileBuilding(graph({
    shape: { outer: [[0, 0], [10, 10], [10, 0], [0, 10]], holes: [] },
  }));
  assert.equal(result.ok, false);
  const entry = result.diagnostics.find(d => d.code === CODE.E_INVALID_FOOTPRINT);
  assert.match(entry.message, /crosses itself/);
  assert.match(entry.hint, /Drag the crossing corners apart/);
  assert.equal(entry.nodeId, 'fp');
});

test('a two-point plan is rejected', () => {
  const result = compileBuilding(graph({ shape: { outer: [[0, 0], [5, 5]], holes: [] } }));
  assert.equal(result.ok, false);
  assert.ok(has(result, CODE.E_INVALID_FOOTPRINT));
});

test('a tiny plan warns but still builds', () => {
  const result = compileBuilding(graph({
    shape: { outer: [[0, 0], [0.3, 0], [0.3, 0.3], [0, 0.3]], holes: [] },
  }));
  assert.equal(result.ok, true, 'a warning must not block the build');
  assert.ok(has(result, CODE.W_TINY_FOOTPRINT));
  assert.match(result.diagnostics.find(d => d.code === CODE.W_TINY_FOOTPRINT).message, /doorway/);
});

test('a courtyard survives into the IR', () => {
  const ir = compileBuilding(graph({
    shape: {
      outer: [[0, 0], [30, 0], [30, 30], [0, 30]],
      holes: [[[10, 10], [10, 20], [20, 20], [20, 10]]],
    },
  })).ir;
  assert.equal(ir.polygons[0].holes.length, 1);
  assert.ok(Math.abs(ir.stats.footprintArea - 800) < 1e-6);
});

test('a courtyard outside the plan is dropped WITH an explanation', () => {
  // normalizePolygon drops it silently; the compiler must not.
  const result = compileBuilding(graph({
    shape: {
      outer: [[0, 0], [10, 0], [10, 10], [0, 10]],
      holes: [[[50, 50], [50, 52]]],
    },
  }));
  assert.ok(has(result, CODE.W_HOLE_DROPPED));
});

test('a profile that eats the plan warns with the storey number', () => {
  // Rule 2 in diagnostics.js: show the arithmetic.
  const result = compileBuilding(graph({
    mass: { modes: { profile: MASS_PROFILE.SETBACK }, props: { levelCount: 10, step: 4, every: 1 } },
  }));
  assert.ok(has(result, CODE.W_MASS_TRUNCATED));
  const entry = result.diagnostics.find(d => d.code === CODE.W_MASS_TRUNCATED);
  assert.match(entry.message, /storey \d+/);
  assert.match(entry.message, /stepped pyramid/);
  assert.ok(result.ir.levels.length < 10);
});

test('an amount set under a profile that ignores it is reported', () => {
  // The invisible mistake: the author drags the amount and nothing moves.
  const result = compileBuilding(graph({
    mass: { modes: { profile: MASS_PROFILE.STRAIGHT }, props: { amount: 3 } },
  }));
  assert.ok(result.diagnostics.some(d => /does not use it/.test(d.message)));
});

// --- muting -----------------------------------------------------------------

test('a muted Mass node passes the plan through instead of emptying the preview', () => {
  const doc = graph();
  const muted = normalizeBuildingDoc({
    ...doc,
    nodes: doc.nodes.map(n => (n.id === 'ms' ? { ...n, enabled: false } : n)),
  });
  const result = compileBuilding(muted);
  // The Output receives a shape rather than a stack, so there is no geometry -
  // but it must say so rather than throw.
  assert.equal(result.ok, false);
  assert.ok(has(result, CODE.E_EMPTY_RESULT));
  assert.ok(result.diagnostics.some(d => d.code === CODE.I_NODE_DISABLED));
});

// --- robustness -------------------------------------------------------------

test('compileBuilding always returns an IR, never null', () => {
  for (const junk of [null, undefined, {}, { nodes: 'no' }, 42]) {
    const result = compileBuilding(junk);
    assert.ok(result.ir, 'an IR must always come back');
    assert.equal(result.ir.format, BUILDING_IR_FORMAT);
    assert.ok(Array.isArray(result.diagnostics));
  }
});

test('references travel into the IR and an empty slot warns', () => {
  const doc = graph();
  const withRefs = normalizeBuildingDoc({
    ...doc,
    references: {
      tex_wall: { kind: 'image', ref: 'asset:12', name: 'Stucco' },
      tex_trim: { kind: 'image', ref: '', name: 'Cornice' },
    },
  });
  const result = compileBuilding(withRefs);
  // A slot holds a LIST now, stored as numbered keys, and a bare key from an
  // older document is migrated to index 0 - which is what it always meant.
  assert.equal(result.ir.references['tex_wall.0'], 'asset:12');
  assert.equal(result.ir.references.tex_wall, undefined, 'the bare key survived migration');
  assert.ok(has(result, CODE.W_MISSING_ASSET));
  assert.match(result.diagnostics.find(d => d.code === CODE.W_MISSING_ASSET).message, /Cornice/);
});

test('stats describe the building', () => {
  const ir = compileBuilding(graph({ mass: { props: { levelCount: 5 } } })).ir;
  assert.equal(ir.stats.storeyCount, 5);
  assert.equal(ir.stats.levelCount, 5);
  assert.ok(Math.abs(ir.stats.footprintArea - 96) < 1e-6, `${ir.stats.footprintArea}`);
  assert.ok(Math.abs(ir.stats.floorArea - 96 * 5) < 1e-6);
});

// --- balconies, end to end ---------------------------------------------------
//
// A balcony carries its OWN model slot, with the same per-facade / per-side
// chain the openings follow. Sharing the openings' list would roll a balustrade
// into the hole, which is exactly the mistake the separate slot exists to stop.

function balconyGraph({ balcony = 'all', seed = 12345 } = {}) {
  const fp = createNode('footprint', 'fp');
  const ms = createNode('mass', 'ms');
  ms.props.levelCount = 4;
  const fc = createNode('facade', 'fc');
  fc.modes.balcony = balcony;
  const out = createNode('output', 'out');
  return normalizeBuildingDoc({
    building: { seed },
    nodes: [fp, ms, fc, out],
    edges: [
      { from: { node: 'fp', port: 'out' }, to: { node: 'ms', port: 'shape' } },
      { from: { node: 'ms', port: 'out' }, to: { node: 'fc', port: 'building' } },
      { from: { node: 'fc', port: 'out' }, to: { node: 'out', port: 'building' } },
    ],
  });
}

// Every list bound, so a comparison between two balcony settings differs only in
// the setting - a doc with no bindings at all would only prove that an unbound
// window has no meshSlot, which was never in doubt.
function balconyDoc(balcony) {
  const mesh = ref => ({ kind: 'mesh', ref });
  let d = balconyGraph({ balcony });
  d = appendReference(d, meshKey('window'), mesh('asset:1'));
  d = appendReference(d, meshKey('balcony'), mesh('asset:2'));
  d = appendReference(d, nodeTextureKey('fc', FACADE_BALCONY_SLOT), mesh('asset:3'));
  d = appendReference(d, nodeTextureKey('fc', FACADE_BALCONY_SLOT), mesh('asset:4'));
  d = appendReference(d, nodeTextureKey('fc', FACADE_BALCONY_SLOT, 'north'), mesh('asset:5'));
  d = appendReference(d, nodeTextureKey('fc', FACADE_MESH_SLOT, 'east'), mesh('asset:6'));
  return d;
}

const slotsOf = (ir, type) => ir.slots.filter(s => s.type === type);
const whereAt = s => `${s.faceIndex}:${s.floorIndex}:${s.bayIndex}`;

test('a balcony resolves its model through its OWN chain, not the openings', () => {
  const ir = compileBuilding(balconyDoc('all')).ir;
  const used = type => [...new Set(slotsOf(ir, type).map(s => s.meshSlot))].sort();
  // Most specific first: a side beats the facade beats the building-wide list.
  assert.deepEqual(used('balcony'), ['fc.balconyMesh', 'fc.balconyMesh.north']);
  // The openings are untouched by any of that - they followed their own chain.
  assert.deepEqual(used('window'), ['fc.openingMesh.east', 'mesh_window']);
  // And a door still skips the facade rungs entirely.
  assert.deepEqual(used('door'), ['']);
});

test('a balcony and the window behind it do not wear matching variants', () => {
  const ir = compileBuilding(balconyDoc('all')).ir;
  const byWindow = new Map(slotsOf(ir, 'window').map(s => [whereAt(s), s.variant]));
  assert.ok(slotsOf(ir, 'balcony').some(s => byWindow.get(whereAt(s)) !== s.variant),
    'every balcony rolled its window’s variant - the two lists are in lockstep');
});

test('turning balconies on leaves every window exactly where it was', () => {
  // The whole point of a separate compile-time slot. An unrelated setting that
  // reshuffles the facade is the failure building/random.js exists to prevent.
  const print = ir => slotsOf(ir, 'window')
    .map(s => `${whereAt(s)}#${s.meshSlot}#${s.variant}`).join(' ');
  assert.equal(
    print(compileBuilding(balconyDoc('none')).ir),
    print(compileBuilding(balconyDoc('all')).ir),
  );
});

test('a balcony carries a real depth into the IR and an opening does not', () => {
  const ir = compileBuilding(balconyDoc('all')).ir;
  // cellD is 0 for an opening, meaning "the consumer's token depth". A balcony's
  // projection is authored, so it has to survive into a headless export or it
  // would be drawn flat against the wall.
  assert.deepEqual([...new Set(slotsOf(ir, 'window').map(s => s.cellD))], [0]);
  assert.deepEqual([...new Set(slotsOf(ir, 'balcony').map(s => s.cellD))], [1]);
});

test('no balconies means no balcony slots, and the IR is still clean', () => {
  const result = compileBuilding(balconyDoc('none'));
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(slotsOf(result.ir, 'balcony').length, 0);
  assert.equal(validateIrJson(result.ir).length, 0);
});

// --- merge, and the things that only became possible with it -----------------
//
// Every node before this one caps or dresses ONE massing, so a building had one
// roof and one silhouette however elaborate its plan. Merge is what makes a hall
// with a tower - two chains, each with its own roof, joined at the end.

/** Two branches: `a` stages then `b` stages, joined by a Merge into the Output. */
function twoBranch(aStages, bStages, tail = [], seed = 4711) {
  const nodes = [];
  const edges = [];
  const chain = (prefix, shape, stages) => {
    const fp = createNode('footprint', `${prefix}fp`);
    fp.props.shape = shape;
    nodes.push(fp);
    let previous = null;
    stages.forEach((stage, i) => {
      const node = createNode(stage.type, `${prefix}${i}`);
      Object.assign(node.props, stage.props || {});
      Object.assign(node.modes, stage.modes || {});
      nodes.push(node);
      if (previous === null) {
        edges.push({ from: { node: fp.id, port: 'out' }, to: { node: node.id, port: 'shape' } });
      } else {
        edges.push({ from: { node: previous, port: 'out' }, to: { node: node.id, port: 'building' } });
      }
      previous = node.id;
    });
    return previous;
  };
  const left = chain('a', { outer: [[0, 0], [12, 0], [12, 8], [0, 8]], holes: [] }, aStages);
  const right = chain('b', { outer: [[12, 1], [16, 1], [16, 6], [12, 6]], holes: [] }, bStages);

  const merge = createNode('merge', 'mg');
  nodes.push(merge);
  edges.push({ from: { node: left, port: 'out' }, to: { node: 'mg', port: 'a' } });
  edges.push({ from: { node: right, port: 'out' }, to: { node: 'mg', port: 'b' } });

  let previous = 'mg';
  tail.forEach((stage, i) => {
    const node = createNode(stage.type, `t${i}`);
    Object.assign(node.props, stage.props || {});
    Object.assign(node.modes, stage.modes || {});
    nodes.push(node);
    edges.push({ from: { node: previous, port: 'out' }, to: { node: node.id, port: 'building' } });
    previous = node.id;
  });

  const out = createNode('output', 'out');
  nodes.push(out);
  edges.push({ from: { node: previous, port: 'out' }, to: { node: 'out', port: 'building' } });
  return normalizeBuildingDoc({ building: { seed }, nodes, edges });
}

// Both branches carry a Facade, so there are SLOTS to assert against - without
// one a merged building has walls and a roof and nothing that moves, which is
// how the deform test below first came to claim "nothing leaned" about code that
// was working.
const HALL = [
  { type: 'mass', props: { levelCount: 3 } },
  { type: 'facade', props: { bayWidth: 2.5 } },
  { type: 'roof', modes: { kind: 'gable' }, props: { pitch: 55, maxHeight: 4 } },
];
const TOWER = [
  { type: 'mass', props: { levelCount: 5 } },
  { type: 'facade', props: { bayWidth: 1.8 } },
  { type: 'roof', modes: { kind: 'hip' }, props: { pitch: 70 } },
];

test('a merged building keeps BOTH roofs', () => {
  // The whole point. Before this, a second roof stacked on the first and a
  // tower was impossible; now each branch keeps its own crown.
  const result = compileBuilding(twoBranch(HALL, TOWER));
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.ir.roofs.length, 2);
  const kinds = result.ir.roofs.map(roof => roof.kind).sort();
  assert.deepEqual(kinds, ['gable', 'hip']);
  // ...at different heights, which is what makes it read as two buildings.
  const bases = result.ir.roofs.map(roof => roof.baseZ);
  assert.notEqual(bases[0], bases[1]);
});

test('each branch stays its own SOLID', () => {
  // ir.solids has been an array since the first phase for exactly this: an
  // exporter that wants one object per part needs the split kept.
  const ir = compileBuilding(twoBranch(HALL, TOWER)).ir;
  assert.equal(ir.solids.length, 2);
  const counted = ir.solids.reduce((total, solid) => total + solid.levels.length, 0);
  assert.equal(counted, ir.levels.length, 'a level belongs to no solid, or to two');
  // No level is claimed twice.
  const all = ir.solids.flatMap(solid => solid.levels);
  assert.equal(new Set(all).size, all.length);
});

test('a merged building is as tall as its TALLEST part, and as big as both', () => {
  const ir = compileBuilding(twoBranch(HALL, TOWER)).ir;
  const hall = compileBuilding(twoBranch(HALL, HALL)).ir;
  assert.ok(ir.stats.height > hall.stats.height, 'the five-storey tower did not raise the height');
  // Area adds up: that is what "floor area" means on a house with a tower.
  assert.ok(ir.stats.footprintArea > 12 * 8, `footprint came out ${ir.stats.footprintArea}`);
});

test('merging one real branch with an empty one returns the real one', () => {
  // A half-wired Merge must not take the building down.
  const result = compileBuilding(twoBranch(HALL, [{ type: 'mass', props: { levelCount: 0 } }]));
  assert.equal(result.ir.roofs.length, 1);
});

test('a Deform after a Merge covers everything', () => {
  const straight = compileBuilding(twoBranch(HALL, TOWER)).ir;
  const leaning = compileBuilding(twoBranch(HALL, TOWER, [
    { type: 'deform', modes: { mode: 'lean' }, props: { amount: 2 } },
  ])).ir;
  assert.ok(leaning.deform, 'the deform did not reach the IR');
  // Both parts moved: slots from the hall AND from the tower.
  const moved = leaning.slots.filter((slot, i) => Math.abs(slot.transform[12] - straight.slots[i].transform[12]) > 1e-6);
  assert.ok(moved.length > 0, 'nothing leaned');
});

test('a trim after a Merge follows EVERY roof, not one of them', () => {
  // An eave that followed only the first would stop dead at the join.
  const ir = compileBuilding(twoBranch(HALL, TOWER, [
    { type: 'trim', modes: { where: 'eave' }, props: { projection: 0.3, depth: 0.3 } },
  ])).ir;
  const eaves = ir.trims.filter(run => run.profileId === 'eave');
  assert.ok(eaves.length >= 2, `${eaves.length} eave runs for two roofs`);
  const heights = new Set(eaves.map(run => run.path[2].toFixed(2)));
  assert.ok(heights.size >= 2, `every eave is at ${[...heights]} - only one roof was followed`);
});

test('a roof item after a Merge goes on the TALLEST roof', () => {
  const ir = compileBuilding(twoBranch(HALL, TOWER, [
    { type: 'roofitem', modes: { where: 'apex', item: 'finial' } },
  ])).ir;
  const items = ir.slots.filter(slot => slot.type === 'roof_item');
  assert.equal(items.length, 1);
  const tallest = ir.roofs.reduce((best, roof) => (roof.baseZ + roof.height > best ? roof.baseZ + roof.height : best), 0);
  assert.ok(items[0].transform[14] > tallest - 2,
    `the finial is at ${items[0].transform[14].toFixed(1)}, the tallest roof tops out at ${tallest.toFixed(1)}`);
});

// --- bargeboards -------------------------------------------------------------

test('a bargeboard follows the gable rake, and is OPEN', () => {
  // The path was already in the IR waiting for a consumer: roof.js emits a
  // gable end wound up one rake, over the apex and down the other.
  const ir = compileBuilding(graphWithStages([
    { type: 'roof', modes: { kind: 'gable' }, props: { pitch: 55 } },
    { type: 'trim', modes: { where: 'rake' }, props: { projection: 0.2, depth: 0.3 } },
  ])).ir;
  const rakes = ir.trims.filter(run => run.profileId === 'rake');
  assert.equal(rakes.length, ir.roofs[0].gables.length);
  assert.ok(rakes.length > 0, 'a gable roof produced no rake');
  assert.ok(rakes.every(run => run.closed === false),
    'a closed rake would put a board across the top of the wall as well');
  // It rises: a run whose z never changes is not following a rake.
  for (const run of rakes) {
    const zs = [];
    for (let i = 2; i < run.path.length; i += 3) zs.push(run.path[i]);
    assert.ok(Math.max(...zs) - Math.min(...zs) > 1, 'the rake is flat');
  }
});

test('a bargeboard faces AWAY from the building', () => {
  // Backwards and it sweeps into the roof instead of onto the face of it.
  const ir = compileBuilding(graphWithStages([
    { type: 'roof', modes: { kind: 'gable' }, props: { pitch: 55 } },
    { type: 'trim', modes: { where: 'rake' }, props: { projection: 0.2, depth: 0.3 } },
  ])).ir;
  for (const run of ir.trims.filter(r => r.profileId === 'rake')) {
    assert.equal(run.normal.length, 3);
    const outward = (run.path[0] - 6) * run.normal[0] + (run.path[1] - 4) * run.normal[1];
    assert.ok(outward > 0, `a rake at ${run.path[0]},${run.path[1]} faces inward`);
  }
});

test('a roof with no rake says so instead of drawing nothing in silence', () => {
  const result = compileBuilding(graphWithStages([
    { type: 'roof', modes: { kind: 'hip' }, props: { pitch: 45 } },
    { type: 'trim', modes: { where: 'rake' }, props: { projection: 0.2, depth: 0.3 } },
  ]));
  assert.ok(has(result, CODE.W_TRIM_NO_RUNS));
});

// --- posts -------------------------------------------------------------------

test('posts land on bay boundaries and close the run', () => {
  const ir = compileBuilding(graphWithStages([
    { type: 'facade', modes: { posts: 'pier' }, props: { bayWidth: 4 } },
  ])).ir;
  const posts = ir.slots.filter(slot => slot.type === 'pillar');
  // A 12m wall at a 4m nominal is 3 bays = 4 posts; an 8m wall is 2 = 3 posts.
  // Three storeys, two walls of each length.
  assert.equal(posts.length, (4 + 3) * 2 * 3, `${posts.length} posts`);
});

test('a colonnade stands CLEAR of the wall and a pier does not', () => {
  const at = mode => compileBuilding(graphWithStages([
    { type: 'facade', modes: { posts: mode }, props: { bayWidth: 4, postDepth: 0.6 } },
  ])).ir.slots.filter(slot => slot.type === 'pillar');
  const flush = at('pier');
  const clear = at('colonnade');
  assert.equal(flush.length, clear.length);
  // Same bay, so compare the pair: the colonnade one is half its depth further
  // out along the wall normal.
  const d = Math.hypot(
    clear[0].transform[12] - flush[0].transform[12],
    clear[0].transform[13] - flush[0].transform[13],
  );
  assert.ok(Math.abs(d - 0.3) < 1e-6, `a colonnade stands ${d.toFixed(3)}m clear, wanted 0.3`);
});

test('a post is a full storey tall and carries its own depth', () => {
  const ir = compileBuilding(graphWithStages([
    { type: 'facade', modes: { posts: 'pier' }, props: { postWidth: 0.5, postDepth: 0.4 } },
  ])).ir;
  const ground = ir.slots.find(slot => slot.type === 'pillar' && slot.floorIndex === 0);
  const level = ir.levels.find(l => l.index === 0);
  assert.ok(Math.abs(ground.cellH - (level.z1 - level.z0)) < 1e-6,
    `a post is ${ground.cellH}m on a ${(level.z1 - level.z0)}m storey`);
  assert.equal(ground.cellW, 0.5);
  assert.equal(ground.cellD, 0.4);
});

test('posts do not re-roll the windows', () => {
  const print = mode => compileBuilding(graphWithStages([
    { type: 'facade', modes: { posts: mode } },
  ])).ir.slots.filter(s => s.type === 'window').map(s => s.seedKey).join(',');
  assert.equal(print('pier'), print('none'));
});

// --- hand-set jitter ---------------------------------------------------------

test('jitter moves the SLOTS and leaves the walls alone', () => {
  // The whole difference from a warp: a warp is a coherent field over position
  // and everything samples it; this is per-element and the wall is dead straight.
  const at = amount => compileBuilding(graphWithStages([
    { type: 'facade' },
    { type: 'deform', modes: { mode: 'none' }, props: { amount: 0, jitter: amount } },
  ])).ir;
  const straight = at(0);
  const handset = at(0.8);
  assert.equal(JSON.stringify(straight.polygons), JSON.stringify(handset.polygons),
    'the walls moved - that is a warp, not hand-setting');
  const moved = handset.slots.filter((slot, i) => Math.abs(slot.transform[12] - straight.slots[i].transform[12])
    + Math.abs(slot.transform[13] - straight.slots[i].transform[13])
    + Math.abs(slot.transform[14] - straight.slots[i].transform[14]) > 1e-9);
  assert.equal(moved.length, straight.slots.length, 'some slots were left exactly true');
});

test('jitter works with the warp set to NONE', () => {
  // It used to be unreachable: the deform stage returned early on mode None, so
  // a straight building with hand-set joinery was impossible to ask for.
  const ir = compileBuilding(graphWithStages([
    { type: 'facade' },
    { type: 'deform', modes: { mode: 'none' }, props: { amount: 0, jitter: 0.5 } },
  ])).ir;
  assert.equal(ir.deform, null, 'a warp was created where none was asked for');
  const plain = compileBuilding(graphWithStages([{ type: 'facade' }])).ir;
  assert.notEqual(
    JSON.stringify(ir.slots.map(s => s.transform)),
    JSON.stringify(plain.slots.map(s => s.transform)),
  );
});

test('jitter is bounded, so an opening never leaves its hole', () => {
  const ir = compileBuilding(graphWithStages([
    { type: 'facade' },
    { type: 'deform', modes: { mode: 'none' }, props: { amount: 0, jitter: 1 } },
  ])).ir;
  const plain = compileBuilding(graphWithStages([{ type: 'facade' }])).ir;
  let worst = 0;
  ir.slots.forEach((slot, i) => {
    worst = Math.max(worst, Math.hypot(
      slot.transform[12] - plain.slots[i].transform[12],
      slot.transform[13] - plain.slots[i].transform[13],
      slot.transform[14] - plain.slots[i].transform[14],
    ));
  });
  assert.ok(worst < 0.2, `an opening moved ${worst.toFixed(3)}m at full jitter`);
  assert.ok(worst > 0.02, `full jitter moved nothing further than ${worst.toFixed(3)}m`);
});

test('jitter is deterministic, and per element rather than per stream', () => {
  const run = () => compileBuilding(graphWithStages([
    { type: 'facade' },
    { type: 'deform', modes: { mode: 'none' }, props: { amount: 0, jitter: 0.7 } },
  ])).ir.slots.map(s => s.transform.join(','));
  assert.deepEqual(run(), run());
  // Two slots must not have received the same nudge.
  const offsets = new Set(run());
  assert.ok(offsets.size > 1);
});

// --- which sides get openings, and which get balconies -----------------------

const sideTally = (ir, type) => {
  const out = {};
  for (const slot of ir.slots.filter(s => s.type === type)) {
    const side = sideOfNormal(slot.transform[8], slot.transform[9]);
    out[side] = (out[side] || 0) + 1;
  }
  return out;
};
const facadeWith = props => compileBuilding(graphWithStages([
  { type: 'facade', modes: { storeys: 'all', balcony: 'all' }, props },
])).ir;

test('every side is dressed unless told otherwise', () => {
  const ir = facadeWith({});
  assert.deepEqual(Object.keys(sideTally(ir, 'window')).sort(),
    ['east', 'north', 'south', 'west']);
  assert.deepEqual(Object.keys(sideTally(ir, 'balcony')).sort(),
    ['east', 'north', 'south', 'west']);
});

test('balconies can be limited to some sides without touching the windows', () => {
  const ir = facadeWith({ balconyNorth: false, balconyEast: false, balconyWest: false });
  assert.deepEqual(Object.keys(sideTally(ir, 'balcony')), ['south']);
  // The openings are untouched: they are a separate decision.
  assert.deepEqual(Object.keys(sideTally(ir, 'window')).sort(),
    ['east', 'north', 'south', 'west']);
});

test('openings can be limited too, and the balconies follow the openings', () => {
  const ir = facadeWith({ openingEast: false, openingWest: false });
  assert.deepEqual(Object.keys(sideTally(ir, 'window')).sort(), ['north', 'south']);
  // A balcony hangs on an opening, so a side with no openings has no balconies
  // whatever the balcony sides say.
  assert.deepEqual(Object.keys(sideTally(ir, 'balcony')).sort(), ['north', 'south']);
});

test('the FRONT DOOR survives every side filter', () => {
  // It is placed once for the whole building, on the wall meant to read as the
  // front. Losing it to a side filter would leave a house with no way in.
  const all = compileBuilding(graphWithStages([
    { type: 'facade', props: { openingNorth: false, openingEast: false, openingSouth: false, openingWest: false } },
  ])).ir;
  assert.equal(all.slots.filter(slot => slot.type === 'door').length, 1);
  assert.equal(all.slots.filter(slot => slot.type === 'window').length, 0,
    'the openings should all be gone');
});

test('all four sides on is the same document as no filter at all', () => {
  const on = facadeWith({ openingNorth: true, openingEast: true, openingSouth: true, openingWest: true });
  const none = facadeWith({});
  assert.equal(on.slots.length, none.slots.length);
});

// --- turning a bound model ---------------------------------------------------

test('a rotation on a mesh reference reaches the IR', () => {
  let doc = graphWithStages([{ type: 'facade' }]);
  doc = appendReference(doc, meshKey('window'), {
    kind: 'mesh', ref: 'asset:11', rotation: [90, 0, 0],
  });
  const ir = compileBuilding(doc).ir;
  assert.deepEqual(ir.meshRotations['mesh_window.0'], [90, 0, 0]);
  // The reference table itself stays a flat key -> 'asset:<n>' map, which is
  // what storage.js's dependency walkers match on - invariant 4.
  assert.equal(ir.references['mesh_window.0'], 'asset:11');
});

test('an untouched model carries no rotation at all', () => {
  let doc = graphWithStages([{ type: 'facade' }]);
  doc = appendReference(doc, meshKey('window'), { kind: 'mesh', ref: 'asset:11' });
  const ir = compileBuilding(doc).ir;
  assert.deepEqual(ir.meshRotations, {},
    'a zero rotation should not be stored - it would churn every saved document');
});

test('angles wrap rather than clamp, because -90 and 270 are the same turn', () => {
  const doc = normalizeBuildingDoc({
    references: { 'mesh_balcony.0': { kind: 'mesh', ref: 'asset:1', rotation: [-90, 450, 0] } },
  });
  assert.deepEqual(doc.references['mesh_balcony.0'].rotation, [270, 90, 0]);
});

test('only a MESH can be turned; an image has no orientation to fix', () => {
  const doc = normalizeBuildingDoc({
    references: { 'tex_wall.0': { kind: 'image', ref: 'asset:1', rotation: [90, 0, 0] } },
  });
  assert.equal(doc.references['tex_wall.0'].rotation, undefined);
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`compile.test.mjs: ${passed} passed`);
