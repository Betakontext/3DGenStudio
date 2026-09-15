// node building/stylepack.test.mjs
//
// The contract a style pack has to hold up: it may only use nodes that already
// exist, it may not overwrite the plan the author drew, and applying one twice
// must produce the same bytes.

import assert from 'node:assert/strict';
import { compileBuilding } from './compile.js';
import { createNode } from './catalog.js';
import { buildingSignature, createBuildingDoc, serializeBuildingDoc } from './doc.js';
import {
  DEFAULT_PALETTE, PALETTE_SLOTS, STYLE_PACK_FORMAT, applyStylePack, createStylePack,
  normalizeStylePack, packAssetNeeds, paletteOf, stylePackSummary, validateStylePack,
} from './stylepack.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const PLAN = { outer: [[0, 0], [20, 0], [20, 12], [0, 12]], holes: [] };

/** A document with just the two ends a pack builds between. */
function endsOnly() {
  const footprint = createNode('footprint', 'fp');
  const output = createNode('output', 'out');
  footprint.props.shape = PLAN;
  return createBuildingDoc({
    nodes: [footprint, output],
    edges: [{ id: 'e', from: { node: 'fp', port: 'out' }, to: { node: 'out', port: 'building' } }],
  });
}

const PACK = {
  format: 1,
  id: 'test-style',
  name: 'Test Style',
  category: 'Test',
  palette: { wall: '#AABBCC', roof: '#112233' },
  graph: [
    { type: 'mass', modes: { profile: 'batter' }, props: { levelCount: 4, amount: 2 } },
    { type: 'facade', modes: { storeys: 'all', opening: 'arch' }, props: { bayWidth: 3.5 } },
    { type: 'roof', modes: { kind: 'hip' }, props: { pitch: 30 } },
  ],
};

// --- normalising -------------------------------------------------------------

test('normalizing is total - garbage produces a pack, not a throw', () => {
  for (const input of [null, undefined, 42, 'nope', [], { graph: 'x', palette: 7 }]) {
    const pack = normalizeStylePack(input);
    assert.equal(pack.format, STYLE_PACK_FORMAT);
    assert.deepEqual(pack.graph, []);
    assert.deepEqual(pack.palette, {});
  }
});

test('palette colours are lowercased and non-colours dropped', () => {
  const pack = normalizeStylePack({ palette: { wall: '#AABBCC', roof: 'red', nope: '#000000' } });
  assert.equal(pack.palette.wall, '#aabbcc');
  assert.equal(pack.palette.roof, undefined, 'a colour name was kept');
  assert.equal(pack.palette.nope, undefined, 'an unknown slot was kept');
});

test('a fresh pack is valid apart from having no graph', () => {
  const problems = validateStylePack(createStylePack({ id: 'fresh-pack' }));
  assert.deepEqual(problems, ['graph is empty - the pack would change nothing structural']);
});

// --- validating: the falsification test, mechanised ---------------------------

test('a valid pack has no problems', () => {
  assert.deepEqual(validateStylePack(PACK), []);
});

test('a pack may not use a node type that does not exist', () => {
  // THE WHOLE POINT. A style that needs a "ziggurat" node cannot ship as data,
  // and finding that out here is the signal to fix the abstraction.
  const problems = validateStylePack({ ...PACK, graph: [{ type: 'ziggurat' }] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no such node type/);
  assert.match(problems[0], /mass/, 'the message does not say what IS available');
});

test('a pack may not specify the footprint or the output', () => {
  for (const type of ['footprint', 'output']) {
    const problems = validateStylePack({ ...PACK, graph: [{ type }] });
    assert.ok(problems.some(p => p.includes(`may not specify the ${type}`)), type);
  }
});

test('an unknown mode, an unknown mode VALUE and an unknown prop are all caught', () => {
  const problems = validateStylePack({
    ...PACK,
    graph: [{
      type: 'mass',
      modes: { profile: 'trapezoid', nonsense: 'x' },
      props: { levelCount: 3, wobble: 2 },
    }],
  });
  assert.ok(problems.some(p => p.includes('unknown mode "nonsense"')));
  assert.ok(problems.some(p => p.includes('profile="trapezoid"')));
  assert.ok(problems.some(p => p.includes('unknown property "wobble"')));
});

test('an out-of-range property is a problem, not something to quietly clamp', () => {
  // A pack asking for a 300-degree pitch meant something. Building an 85-degree
  // one and saying nothing hides the mistake from the person who can fix it.
  const problems = validateStylePack({
    ...PACK, graph: [{ type: 'roof', props: { pitch: 300 } }],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /above the maximum 85/);
});

test('repeating a stage is allowed - chained facades and roofs are the point', () => {
  // The singleton guard in validateStylePack currently only ever applies to the
  // Output, which is reserved anyway. It is kept because the day a node becomes
  // a singleton is not the day anyone will remember to add it.
  assert.deepEqual(validateStylePack({
    ...PACK,
    graph: [{ type: 'facade' }, { type: 'facade' }, { type: 'roof' }, { type: 'roof' }],
  }), []);
});

test('bad ids are caught, including path traversal', () => {
  for (const id of ['', 'A', '../etc', 'has space', 'x']) {
    assert.ok(validateStylePack({ ...PACK, id }).some(p => p.includes('id ')), JSON.stringify(id));
  }
});

// --- applying ----------------------------------------------------------------

test('applying builds the chain between the footprint and the output', () => {
  const doc = applyStylePack(endsOnly(), PACK);
  assert.deepEqual(doc.nodes.map(n => n.type),
    ['footprint', 'mass', 'facade', 'roof', 'output']);
  // Every consecutive pair is wired, so the result compiles rather than needing
  // the author to join it up.
  assert.equal(doc.edges.length, 4);
  assert.equal(compileBuilding(doc).ok, true);
});

test('the plan the author drew is PRESERVED', () => {
  // The one thing a style must never touch. Picking a style is not permission to
  // redraw the footprint.
  const doc = applyStylePack(endsOnly(), PACK);
  assert.deepEqual(doc.nodes.find(n => n.type === 'footprint').props.shape, PLAN);
});

test('the seed is preserved, so re-styling does not reshuffle the windows', () => {
  const base = { ...endsOnly(), building: { ...endsOnly().building, seed: 987 } };
  assert.equal(applyStylePack(base, PACK).building.seed, 987);
});

test('the pack id and a palette SNAPSHOT are recorded', () => {
  const doc = applyStylePack(endsOnly(), PACK);
  assert.equal(doc.building.stylePackId, 'test-style');
  // A snapshot, not a link: the colours are in the document, so the building
  // still renders the same way if the shipped pack is revised or removed.
  assert.equal(doc.building.style.name, 'Test Style');
  assert.equal(doc.building.style.palette.wall, '#aabbcc');
});

test('applying the same pack twice is byte-identical', () => {
  // Node ids are derived from the pack and the position rather than minted
  // randomly, which is what makes a golden test of a shipped pack possible.
  const a = applyStylePack(endsOnly(), PACK);
  const b = applyStylePack(endsOnly(), PACK);
  assert.equal(serializeBuildingDoc(a), serializeBuildingDoc(b));
  assert.equal(buildingSignature(a), buildingSignature(b));
});

test('re-applying over an earlier style leaves no stragglers', () => {
  const first = applyStylePack(endsOnly(), PACK);
  const second = applyStylePack(first, { ...PACK, id: 'other-style', graph: [{ type: 'mass' }] });
  assert.deepEqual(second.nodes.map(n => n.type), ['footprint', 'mass', 'output']);
  assert.equal(second.nodes.filter(n => n.type === 'facade').length, 0);
  assert.equal(Object.keys(second.layout.nodes).length <= second.nodes.length, true);
});

test('an INVALID pack changes nothing at all', () => {
  const before = endsOnly();
  const after = applyStylePack(before, { ...PACK, graph: [{ type: 'ziggurat' }] });
  assert.equal(serializeBuildingDoc(after), serializeBuildingDoc(before));
});

test('a document with no footprint is left alone rather than invented into', () => {
  const doc = createBuildingDoc({ nodes: [createNode('output', 'out')] });
  assert.equal(serializeBuildingDoc(applyStylePack(doc, PACK)), serializeBuildingDoc(doc));
});

test('props are coerced, so a pack cannot inject a string into a number', () => {
  const doc = applyStylePack(endsOnly(), {
    ...PACK, graph: [{ type: 'mass', props: { levelCount: 3.7 } }],
  });
  assert.equal(doc.nodes.find(n => n.type === 'mass').props.levelCount, 4);
});

// --- the palette reaching the picture ---------------------------------------

test('the palette becomes IR materials, defaulted when there is no style', () => {
  const plain = compileBuilding(applyStylePack(endsOnly(), { ...PACK, palette: {} })).ir;
  assert.equal(plain.materials.length, PALETTE_SLOTS.length);
  assert.equal(plain.materials.find(m => m.slot === 'wall').color, DEFAULT_PALETTE.wall);

  const styled = compileBuilding(applyStylePack(endsOnly(), PACK)).ir;
  assert.equal(styled.materials.find(m => m.slot === 'wall').color, '#aabbcc');
  assert.equal(styled.materials.find(m => m.slot === 'roof').color, '#112233');
  // A slot the pack did not name still gets a colour - a consumer never has to
  // carry its own fallbacks.
  assert.equal(styled.materials.find(m => m.slot === 'door').color, DEFAULT_PALETTE.door);
});

test('a palette change recompiles, because the signature covers it', () => {
  const a = applyStylePack(endsOnly(), PACK);
  const b = applyStylePack(endsOnly(), { ...PACK, palette: { wall: '#ff0000' } });
  assert.notEqual(buildingSignature(a), buildingSignature(b));
});

test('paletteOf survives a document with no style at all', () => {
  assert.deepEqual(paletteOf(createBuildingDoc({})), DEFAULT_PALETTE);
  assert.deepEqual(paletteOf(null), DEFAULT_PALETTE);
});

// --- the vocabulary, which Phase 6 fills in ----------------------------------

test('asset needs are listed by filename, ready for the installer', () => {
  const needs = packAssetNeeds({
    ...PACK,
    vocabulary: { window: [{ file: 'a.glb', kind: 'mesh', w: 1.2, h: 2 }, { file: 'b.glb' }] },
  });
  assert.equal(needs.length, 2);
  assert.deepEqual(needs[0], { slot: 'window', file: 'a.glb', kind: 'mesh', name: 'a.glb' });
  assert.equal(packAssetNeeds(PACK).length, 0, 'a pack with no assets should need none');
});

test('a summary carries what a list draws and not the recipe', () => {
  const summary = stylePackSummary(PACK);
  assert.equal(summary.stageCount, 3);
  assert.equal(summary.graph, undefined, 'the summary is carrying the whole recipe');
  assert.equal(summary.palette.wall, '#aabbcc');
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`stylepack.test.mjs: ${passed} passed`);
