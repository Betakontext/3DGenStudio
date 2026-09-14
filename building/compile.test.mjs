// node building/compile.test.mjs

import assert from 'node:assert/strict';
import { compileBuilding } from './compile.js';
import { CODE, SEVERITY } from './diagnostics.js';
import { BUILDING_IR_FORMAT, LEVEL_KIND, irDigest, validateIrJson } from './ir.js';
import { createNode } from './catalog.js';
import { MASS_PROFILE } from './mass.js';
import { normalizeBuildingDoc } from './doc.js';

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
  assert.equal(result.ir.references.tex_wall, 'asset:12');
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

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`compile.test.mjs: ${passed} passed`);
