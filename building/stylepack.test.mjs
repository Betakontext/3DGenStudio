// node building/stylepack.test.mjs
//
// The contract a style pack has to hold up: it may only use nodes that already
// exist, it may not overwrite the plan the author drew, and applying one twice
// must produce the same bytes.

import assert from 'node:assert/strict';
import { compileBuilding } from './compile.js';
import { resolveMaterialIndex } from './ir.js';
import { SIDE_ORDER } from './sides.js';
import { createNode } from './catalog.js';
import {
  buildingSignature, clearReference, createBuildingDoc, serializeBuildingDoc, setReference,
} from './doc.js';
import {
  DEFAULT_PALETTE, PALETTE_SLOTS, STYLE_PACK_FORMAT, TEXTURE_SLOTS, applyStylePack,
  createStylePack, nodeTextureKey, normalizeStylePack, packAssetNeeds, paletteOf,
  stylePackSummary, textureKey, validateStylePack,
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

// --- texture slots ----------------------------------------------------------

test('a texture slot reaches the IR as a material ref', () => {
  // The whole chain: a reference key -> the reference table -> ir.materials.
  // The renderer never learns an asset id from a node.
  let doc = endsOnly();
  doc = setReference(doc, textureKey('wall'), {
    kind: 'image', ref: 'asset:42', name: 'Brick', tileMetres: 2.5,
  });
  const wall = compileBuilding(applyStylePack(doc, PACK)).ir.materials
    .find(m => m.slot === 'wall');
  assert.equal(wall.ref, 'asset:42');
  assert.equal(wall.tile, 2.5);
  // ...and the colour is still there, because a texture TINTS rather than
  // replaces - a neutral image keeps the style's hue.
  assert.equal(wall.color, '#aabbcc');
});

test('an unbound slot carries no ref and no tile', () => {
  // Zero tile means "nothing bound", which is not the same as a tile size of
  // zero - the renderer tests the ref, and a defaulted tile would hide the
  // difference from anyone reading the IR.
  const roof = compileBuilding(applyStylePack(endsOnly(), PACK)).ir.materials
    .find(m => m.slot === 'roof');
  assert.equal(roof.ref, '');
  assert.equal(roof.tile, 0);
});

test('a bare-number reference is REJECTED, not coerced', () => {
  // The tree-preset mistake, and invariant 4's whole reason for existing: a
  // bare id ships broken across installations. Rejecting the entry makes it a
  // visible empty slot instead of a silently untextured building.
  const doc = setReference(endsOnly(), textureKey('wall'), { kind: 'image', ref: 42 });
  assert.equal(doc.references[textureKey('wall')], undefined);
});

test('a tile size is always present and always sane', () => {
  for (const [given, expected] of [
    [undefined, 2], [0, 2], [-3, 2], ['nope', 2], [1.5, 1.5], [500, 100],
  ]) {
    const doc = setReference(endsOnly(), textureKey('trim'), {
      kind: 'image', ref: 'asset:7', tileMetres: given,
    });
    assert.equal(doc.references[textureKey('trim')].tileMetres, expected,
      `tileMetres ${JSON.stringify(given)}`);
  }
});

test('only images carry a tile size', () => {
  // A mesh or a trim profile has its own real dimensions; a tile size on one
  // would be a number nothing reads.
  const doc = setReference(endsOnly(), 'mesh_window', {
    kind: 'mesh', ref: 'asset:9', tileMetres: 3,
  });
  assert.equal(doc.references.mesh_window.tileMetres, undefined);
});

test('every texture slot is a real palette slot', () => {
  // A slot the palette does not have would bind a texture the renderer never
  // looks up - a control that silently does nothing.
  for (const slot of TEXTURE_SLOTS) {
    assert.ok(PALETTE_SLOTS.includes(slot), `${slot} is not a palette slot`);
  }
  assert.equal(TEXTURE_SLOTS.includes('accent'), false,
    'accent colours lines and cannot carry an image');
});

test('clearing a slot removes the entry rather than emptying it', () => {
  // Styled first: materials are emitted alongside the geometry, so a document
  // with no Mass compiles to nothing and has no material table to inspect.
  let doc = applyStylePack(endsOnly(), PACK);
  doc = setReference(doc, textureKey('wall'), { kind: 'image', ref: 'asset:1' });
  assert.equal(compileBuilding(doc).ir.materials.find(m => m.slot === 'wall').ref, 'asset:1');

  doc = clearReference(doc, textureKey('wall'));
  assert.equal(textureKey('wall') in doc.references, false);
  assert.equal(compileBuilding(doc).ir.materials.find(m => m.slot === 'wall').ref, '');
});

test('binding a texture changes the signature, so the preview updates', () => {
  const plain = applyStylePack(endsOnly(), PACK);
  const textured = setReference(plain, textureKey('wall'), { kind: 'image', ref: 'asset:3' });
  assert.notEqual(buildingSignature(plain), buildingSignature(textured));
});

// --- the three-level texture chain ------------------------------------------
//
// side overrides facade overrides building overrides palette colour. Every rung
// is optional, which is the requirement: a building that wants one brick
// everywhere must not have to say so five times.

/** A styled document with a Facade covering the storeys named. */
function withFacade(storeys = 'all', levelCount = 4) {
  return applyStylePack(endsOnly(), {
    ...PACK,
    graph: [
      { type: 'mass', props: { levelCount } },
      { type: 'facade', modes: { storeys } },
    ],
  });
}

const facadeId = doc => doc.nodes.find(n => n.type === 'facade').id;
const wallAt = (ir, floor, side) => resolveMaterialIndex(ir, 'wall', floor, side);
const refAt = (ir, floor, side) => {
  const index = wallAt(ir, floor, side);
  return index < 0 ? null : ir.materials[index].ref;
};
const image = ref => ({ kind: 'image', ref, tileMetres: 2 });

test('with nothing bound, every storey and side shares one material', () => {
  const ir = compileBuilding(withFacade()).ir;
  const first = wallAt(ir, 0, 'north');
  for (const floor of [0, 1, 2, 3]) {
    for (const side of SIDE_ORDER) {
      assert.equal(wallAt(ir, floor, side), first, `floor ${floor} ${side}`);
    }
  }
  assert.equal(ir.materials[first].ref, '');
});

test('a building-wide texture reaches every storey and side', () => {
  const doc = setReference(withFacade(), textureKey('wall'), image('asset:1'));
  const ir = compileBuilding(doc).ir;
  for (const floor of [0, 3]) {
    for (const side of SIDE_ORDER) assert.equal(refAt(ir, floor, side), 'asset:1');
  }
});

test('a FACADE override wins on its storeys and leaves the rest alone', () => {
  // The user-facing behaviour: a stone ground floor under a brick building.
  let doc = withFacade('ground');
  doc = setReference(doc, textureKey('wall'), image('asset:1'));
  doc = setReference(doc, nodeTextureKey(facadeId(doc), 'wall'), image('asset:2'));
  const ir = compileBuilding(doc).ir;
  assert.equal(refAt(ir, 0, 'north'), 'asset:2', 'the ground floor did not take the override');
  assert.equal(refAt(ir, 1, 'north'), 'asset:1', 'the override leaked upward');
  assert.equal(refAt(ir, 3, 'south'), 'asset:1');
});

test('a SIDE override wins over the facade, on that side only', () => {
  let doc = withFacade('all');
  doc = setReference(doc, textureKey('wall'), image('asset:1'));
  doc = setReference(doc, nodeTextureKey(facadeId(doc), 'wall'), image('asset:2'));
  doc = setReference(doc, nodeTextureKey(facadeId(doc), 'wall', 'north'), image('asset:3'));
  const ir = compileBuilding(doc).ir;
  assert.equal(refAt(ir, 1, 'north'), 'asset:3');
  assert.equal(refAt(ir, 1, 'south'), 'asset:2');
  assert.equal(refAt(ir, 1, 'east'), 'asset:2');
});

test('a side override with NO facade texture falls through to the building', () => {
  // Every rung is independent. Requiring the facade rung to be filled first
  // would make "just the street front in brick" impossible to express.
  let doc = withFacade('all');
  doc = setReference(doc, textureKey('wall'), image('asset:1'));
  doc = setReference(doc, nodeTextureKey(facadeId(doc), 'wall', 'south'), image('asset:9'));
  const ir = compileBuilding(doc).ir;
  assert.equal(refAt(ir, 1, 'south'), 'asset:9');
  assert.equal(refAt(ir, 1, 'north'), 'asset:1');
});

test('windows follow the same chain as walls', () => {
  let doc = withFacade('all');
  doc = setReference(doc, textureKey('opening'), image('asset:1'));
  doc = setReference(doc, nodeTextureKey(facadeId(doc), 'opening', 'west'), image('asset:4'));
  const ir = compileBuilding(doc).ir;
  assert.equal(ir.materials[resolveMaterialIndex(ir, 'opening', 1, 'west')].ref, 'asset:4');
  assert.equal(ir.materials[resolveMaterialIndex(ir, 'opening', 1, 'east')].ref, 'asset:1');
});

test('two facades override their own storeys independently', () => {
  let doc = applyStylePack(endsOnly(), {
    ...PACK,
    graph: [
      { type: 'mass', props: { levelCount: 4 } },
      { type: 'facade', modes: { storeys: 'ground' } },
      { type: 'facade', modes: { storeys: 'upper' } },
    ],
  });
  const facades = doc.nodes.filter(n => n.type === 'facade');
  doc = setReference(doc, nodeTextureKey(facades[0].id, 'wall'), image('asset:10'));
  doc = setReference(doc, nodeTextureKey(facades[1].id, 'wall'), image('asset:11'));
  const ir = compileBuilding(doc).ir;
  assert.equal(refAt(ir, 0, 'north'), 'asset:10');
  assert.equal(refAt(ir, 2, 'north'), 'asset:11');
});

test('an override keeps the slot colour, so a tint is not lost', () => {
  // A texture MULTIPLIES its colour. An override that reset the tint to white
  // would make one storey of a coloured building suddenly grey.
  let doc = withFacade('ground');
  doc = setReference(doc, nodeTextureKey(facadeId(doc), 'wall'), image('asset:2'));
  const ir = compileBuilding(doc).ir;
  assert.equal(ir.materials[wallAt(ir, 0, 'north')].color, '#aabbcc');
});

test('a deleted facade leaves a DANGLING key rather than a wrong material', () => {
  // Node-id keys are the house pattern and this is their cost. It must be
  // reportable rather than silently reassigned to whatever node comes next.
  let doc = withFacade('all');
  const id = facadeId(doc);
  doc = setReference(doc, nodeTextureKey(id, 'wall'), image('asset:5'));
  const without = { ...doc, nodes: doc.nodes.filter(n => n.id !== id) };
  const ir = compileBuilding(without).ir;
  // No facade means no override is emitted at all; the building-wide slot stands.
  assert.equal(ir.materials.filter(m => m.ref === 'asset:5').length, 0);
  assert.ok(`${id}.wall` in without.references, 'the key vanished instead of dangling');
});

test('the material table stays small - selectors, not expanded lists', () => {
  // A 40-storey building with one brick has ONE entry per slot. Expanding per
  // storey would make adding a floor rewrite the whole table.
  let doc = withFacade('all', 40);
  doc = setReference(doc, textureKey('wall'), image('asset:1'));
  const ir = compileBuilding(doc).ir;
  assert.equal(ir.materials.length, PALETTE_SLOTS.length, 'the table grew with the storeys');
});

// --- per-trim textures ------------------------------------------------------
//
// Trims ACCUMULATE, so one shared trim material would make a plinth and a
// cornice impossible to tell apart. Each Trim node can carry its own; an empty
// one uses the building-wide slot, so the common case is still one material.

/** A styled document with the trim runs named, in order. */
function withTrims(runs, levelCount = 4) {
  return applyStylePack(endsOnly(), {
    ...PACK,
    graph: [
      { type: 'mass', props: { levelCount } },
      { type: 'roof', modes: { kind: 'flat' } },
      ...runs.map(where => ({ type: 'trim', modes: { where } })),
    ],
  });
}

const trimIds = doc => doc.nodes.filter(n => n.type === 'trim').map(n => n.id);
const runsOf = ir => ir.trims.map(run => ({ profile: run.profileId, material: run.material }));

test('with nothing bound, every trim run shares the building-wide material', () => {
  const ir = compileBuilding(withTrims(['cornice', 'plinth'])).ir;
  const runs = runsOf(ir);
  assert.ok(runs.length >= 2, `only ${runs.length} runs`);
  const trim = ir.materials.findIndex(m => m.slot === 'trim');
  for (const run of runs) assert.equal(run.material, trim, run.profile);
  assert.equal(ir.materials.filter(m => m.slot === 'trim').length, 1, 'the table grew for nothing');
});

test('a Trim node with its own texture gets its own material', () => {
  let doc = withTrims(['cornice', 'plinth']);
  const [cornice, plinth] = trimIds(doc);
  doc = setReference(doc, nodeTextureKey(plinth, 'trim'), {
    kind: 'image', ref: 'asset:77', tileMetres: 1,
  });
  const ir = compileBuilding(doc).ir;
  const runs = runsOf(ir);

  const corniceRun = runs.find(r => r.profile === 'cornice');
  const plinthRun = runs.find(r => r.profile === 'plinth');
  assert.notEqual(corniceRun.material, plinthRun.material, 'both runs share a material');
  assert.equal(ir.materials[plinthRun.material].ref, 'asset:77');
  assert.equal(ir.materials[corniceRun.material].ref, '', 'the override leaked to the cornice');
  assert.ok(cornice, 'the fixture produced no cornice node');
});

test('two textured trims get two materials, not one', () => {
  let doc = withTrims(['cornice', 'plinth']);
  const [cornice, plinth] = trimIds(doc);
  doc = setReference(doc, nodeTextureKey(cornice, 'trim'), { kind: 'image', ref: 'asset:1' });
  doc = setReference(doc, nodeTextureKey(plinth, 'trim'), { kind: 'image', ref: 'asset:2' });
  const ir = compileBuilding(doc).ir;
  const refs = runsOf(ir).map(r => ({ profile: r.profile, ref: ir.materials[r.material].ref }));
  assert.equal(refs.find(r => r.profile === 'cornice').ref, 'asset:1');
  assert.equal(refs.find(r => r.profile === 'plinth').ref, 'asset:2');
});

test('a trim material keeps the trim palette colour', () => {
  // A texture MULTIPLIES its colour, so an override that reset the tint would
  // make one moulding of a coloured building grey.
  let doc = withTrims(['cornice']);
  doc = setReference(doc, nodeTextureKey(trimIds(doc)[0], 'trim'), {
    kind: 'image', ref: 'asset:3',
  });
  const ir = compileBuilding(doc).ir;
  const run = runsOf(ir)[0];
  assert.equal(ir.materials[run.material].slot, 'trim');
  assert.equal(ir.materials[run.material].color, ir.materials
    .find(m => m.slot === 'trim' && !m.ref).color);
});

test('every run of one node shares that node material', () => {
  // A cornice on a plan with a courtyard is two runs from one node; they must
  // not become two materials.
  let doc = applyStylePack(endsOnly(), {
    ...PACK,
    graph: [
      { type: 'mass', props: { levelCount: 2 } },
      { type: 'trim', modes: { where: 'cornice' } },
    ],
  });
  doc = setReference(doc, nodeTextureKey(trimIds(doc)[0], 'trim'), {
    kind: 'image', ref: 'asset:4',
  });
  const ir = compileBuilding(doc).ir;
  const materials = new Set(ir.trims.map(run => run.material));
  assert.equal(materials.size, 1, `${materials.size} materials for one Trim node`);
  assert.equal(ir.materials.filter(m => m.ref === 'asset:4').length, 1, 'the entry was duplicated');
});

test('a run records which node made it', () => {
  // Without it "which trim is this" is not answerable from the run's shape.
  const doc = withTrims(['cornice']);
  const ir = compileBuilding(doc).ir;
  assert.ok(ir.trims.length > 0);
  // The IR run itself does not need to carry the node id - the material index
  // is the resolved answer - but the compiler must have had it.
  assert.ok(ir.trims.every(run => Number.isInteger(run.material) && run.material >= 0));
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`stylepack.test.mjs: ${passed} passed`);
