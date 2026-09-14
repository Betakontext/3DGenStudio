// node building/doc.test.mjs
//
// One test per invariant in the doc.js header, plus the normalisation cases that
// a hand-edited or half-migrated file actually produces.

import assert from 'node:assert/strict';
import {
  BUILDING_DOC_FORMAT, BUILDING_DOC_KIND, REFERENCE_KIND,
  buildingAssetDigest, buildingSignature, clearReference, collectReferenceIds,
  createBuildingDoc, danglingReferences, findNode, looksLikeBuildingDoc,
  nodesOfType, normalizeBuildingDoc, parseBuildingDoc, serializeBuildingDoc,
  setReference,
} from './doc.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const twoNodes = () => normalizeBuildingDoc({
  nodes: [
    { id: 'a', type: 'footprint', props: { gridSize: 0.5 } },
    { id: 'b', type: 'extrude', props: { height: 3 } },
  ],
  edges: [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'shape' } }],
});

// --- shape ------------------------------------------------------------------

test('createBuildingDoc produces a normalised, empty document', () => {
  const doc = createBuildingDoc();
  assert.equal(doc.format, BUILDING_DOC_FORMAT);
  assert.equal(doc.kind, BUILDING_DOC_KIND);
  assert.equal(doc.building.units, 'm');
  // No pre-wired graph: the empty board is the clearer starting point.
  assert.deepEqual(doc.nodes, []);
  assert.deepEqual(doc.edges, []);
});

test('normalizeBuildingDoc is total and never throws', () => {
  for (const junk of [null, undefined, 42, 'nope', [], { nodes: 'no' }]) {
    assert.doesNotThrow(() => normalizeBuildingDoc(junk));
    assert.equal(normalizeBuildingDoc(junk).kind, BUILDING_DOC_KIND);
  }
});

test('normalizeBuildingDoc is idempotent', () => {
  const once = twoNodes();
  assert.deepEqual(normalizeBuildingDoc(once), once);
});

test('a node without an id or type is dropped', () => {
  const doc = normalizeBuildingDoc({ nodes: [{ type: 'extrude' }, { id: 'x' }, { id: 'y', type: 'extrude' }] });
  assert.deepEqual(doc.nodes.map(n => n.id), ['y']);
});

test('duplicate node ids keep the first', () => {
  const doc = normalizeBuildingDoc({
    nodes: [{ id: 'a', type: 'one' }, { id: 'a', type: 'two' }],
  });
  assert.equal(doc.nodes.length, 1);
  assert.equal(doc.nodes[0].type, 'one');
});

test('enabled defaults to true but false is preserved', () => {
  const doc = normalizeBuildingDoc({
    nodes: [{ id: 'a', type: 't' }, { id: 'b', type: 't', enabled: false }],
  });
  assert.equal(doc.nodes[0].enabled, true);
  assert.equal(doc.nodes[1].enabled, false);
  // A muted node keeps its props - muting is not deleting.
  assert.ok(doc.nodes[1].props);
});

// --- INVARIANT 1: edges are authoritative -----------------------------------

test('INVARIANT 1: linked is rebuilt from edges, not trusted from the file', () => {
  const doc = normalizeBuildingDoc({
    nodes: [
      { id: 'a', type: 'footprint' },
      // A stale mirror claiming an input is driven when no edge says so.
      { id: 'b', type: 'extrude', linked: ['height', 'bogus'] },
    ],
    edges: [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'shape' } }],
  });
  const b = findNode(doc, 'b');
  assert.deepEqual(b.linked, ['shape'], 'the stale mirror must be discarded');
});

test('an edge referencing a missing node is dropped', () => {
  const doc = normalizeBuildingDoc({
    nodes: [{ id: 'a', type: 't' }],
    edges: [{ from: { node: 'a', port: 'out' }, to: { node: 'ghost', port: 'in' } }],
  });
  assert.deepEqual(doc.edges, []);
});

test('a self-edge is dropped', () => {
  const doc = normalizeBuildingDoc({
    nodes: [{ id: 'a', type: 't' }],
    edges: [{ from: { node: 'a', port: 'out' }, to: { node: 'a', port: 'in' } }],
  });
  assert.deepEqual(doc.edges, []);
});

test('a second edge into an occupied input is dropped', () => {
  // Which one wins would otherwise depend on array order, which the author
  // cannot see or control.
  const doc = normalizeBuildingDoc({
    nodes: [{ id: 'a', type: 't' }, { id: 'b', type: 't' }, { id: 'c', type: 't' }],
    edges: [
      { from: { node: 'a', port: 'out' }, to: { node: 'c', port: 'shape' } },
      { from: { node: 'b', port: 'out' }, to: { node: 'c', port: 'shape' } },
    ],
  });
  assert.equal(doc.edges.length, 1);
  assert.equal(doc.edges[0].from.node, 'a');
});

test('two edges into DIFFERENT inputs of one node both survive', () => {
  const doc = normalizeBuildingDoc({
    nodes: [{ id: 'a', type: 't' }, { id: 'b', type: 't' }, { id: 'c', type: 't' }],
    edges: [
      { from: { node: 'a', port: 'out' }, to: { node: 'c', port: 'shape' } },
      { from: { node: 'b', port: 'out' }, to: { node: 'c', port: 'height' } },
    ],
  });
  assert.equal(doc.edges.length, 2);
  assert.deepEqual(findNode(doc, 'c').linked, ['height', 'shape']);
});

// --- INVARIANT 2: layout never affects the signature ------------------------

test('INVARIANT 2: moving a node does not change the signature', () => {
  // The one that makes a 40-storey building draggable.
  const base = twoNodes();
  const moved = { ...base, layout: { nodes: { a: { x: 900, y: -40 } }, notes: [] } };
  assert.equal(buildingSignature(moved), buildingSignature(base));
});

test('INVARIANT 2: saving the file does not change the signature', () => {
  const base = twoNodes();
  assert.equal(buildingSignature({ ...base, savedAt: 999 }), buildingSignature(base));
});

test('the signature DOES change when geometry would', () => {
  const base = twoNodes();
  const seeded = { ...base, building: { ...base.building, seed: 999 } };
  assert.notEqual(buildingSignature(seeded), buildingSignature(base));

  const edited = normalizeBuildingDoc({
    ...base,
    nodes: base.nodes.map(n => n.id === 'b' ? { ...n, props: { height: 4 } } : n),
  });
  assert.notEqual(buildingSignature(edited), buildingSignature(base));
});

test('the signature ignores key insertion order', () => {
  // Otherwise rebuilding a props object in a different order in an edit would
  // trigger a spurious recompile on every inspector change.
  const a = normalizeBuildingDoc({ nodes: [{ id: 'n', type: 't', props: { x: 1, y: 2 } }] });
  const b = normalizeBuildingDoc({ nodes: [{ id: 'n', type: 't', props: { y: 2, x: 1 } }] });
  assert.equal(buildingSignature(a), buildingSignature(b));
});

test('layout entries with non-finite coordinates are dropped', () => {
  const doc = normalizeBuildingDoc({
    nodes: [{ id: 'a', type: 't' }],
    layout: { nodes: { a: { x: 1, y: 2 }, b: { x: NaN, y: 0 }, c: 'nope' } },
  });
  assert.deepEqual(Object.keys(doc.layout.nodes), ['a']);
});

// --- INVARIANTS 3 and 4: references -----------------------------------------

test('INVARIANT 4: a bare-number ref is rejected', () => {
  // The tree-preset mistake. A bare id is invisible to storage.js's walkers, so
  // a .3dgp export would silently omit the texture.
  const doc = normalizeBuildingDoc({
    references: {
      good: { kind: 'image', ref: 'asset:12', name: 'Stucco' },
      bad: { kind: 'image', ref: 12, name: 'Bare' },
      alsoBad: { kind: 'image', ref: '12', name: 'String but bare' },
    },
  });
  assert.deepEqual(Object.keys(doc.references), ['good']);
});

test('INVARIANT 3: an EMPTY ref is kept as a declared-but-unfilled slot', () => {
  // Dropping it would lose the slot, and the editor would have nothing to show
  // as "needs a texture".
  const doc = normalizeBuildingDoc({
    references: { tex_facade: { kind: 'image', ref: '', name: 'Facade' } },
  });
  assert.equal(doc.references.tex_facade.ref, '');
  assert.deepEqual(danglingReferences(doc), [{ key: 'tex_facade', kind: 'image', name: 'Facade' }]);
});

test('an unknown reference kind falls back to image', () => {
  const doc = normalizeBuildingDoc({
    references: { k: { kind: 'hologram', ref: 'asset:1' } },
  });
  assert.equal(doc.references.k.kind, REFERENCE_KIND.IMAGE);
});

test('colorSpace is kept only for images and only when valid', () => {
  const doc = normalizeBuildingDoc({
    references: {
      a: { kind: 'image', ref: 'asset:1', colorSpace: 'srgb' },
      b: { kind: 'image', ref: 'asset:2', colorSpace: 'banana' },
      c: { kind: 'mesh', ref: 'asset:3', colorSpace: 'srgb' },
    },
  });
  assert.equal(doc.references.a.colorSpace, 'srgb');
  assert.equal('colorSpace' in doc.references.b, false);
  assert.equal('colorSpace' in doc.references.c, false);
});

test('collectReferenceIds returns sorted unique numbers', () => {
  const doc = normalizeBuildingDoc({
    references: {
      a: { kind: 'image', ref: 'asset:12' },
      b: { kind: 'mesh', ref: 'asset:3' },
      c: { kind: 'image', ref: 'asset:12' },
      d: { kind: 'image', ref: '' },
    },
  });
  assert.deepEqual(collectReferenceIds(doc), [3, 12]);
});

test('setReference and clearReference are pure', () => {
  const base = createBuildingDoc();
  const withRef = setReference(base, 'tex', { kind: 'image', ref: 'asset:7', name: 'Brick' });
  assert.deepEqual(base.references, {}, 'the original must not be mutated');
  assert.equal(withRef.references.tex.ref, 'asset:7');
  assert.deepEqual(clearReference(withRef, 'tex').references, {});
  // Clearing a slot that is not there returns an equivalent document.
  assert.deepEqual(clearReference(base, 'nope').references, {});
});

test('setReference rejects a malformed entry rather than storing it', () => {
  const base = createBuildingDoc();
  assert.deepEqual(setReference(base, 'tex', { kind: 'image', ref: 99 }).references, {});
});

// --- serialise / parse ------------------------------------------------------

test('serialize -> parse round trips', () => {
  const doc = twoNodes();
  const back = parseBuildingDoc(serializeBuildingDoc(doc));
  assert.deepEqual(back, doc);
});

test('parseBuildingDoc returns null on junk instead of throwing', () => {
  assert.equal(parseBuildingDoc('not json'), null);
  assert.equal(parseBuildingDoc('{"kind":"vfx-graph"}'), null);
  assert.equal(parseBuildingDoc('[]'), null);
});

test('looksLikeBuildingDoc recognises by structure as well as by kind', () => {
  assert.equal(looksLikeBuildingDoc({ kind: BUILDING_DOC_KIND }), true);
  assert.equal(looksLikeBuildingDoc({ nodes: [], edges: [], building: {} }), true);
  assert.equal(looksLikeBuildingDoc({ format: 1 }), false, 'a version alone proves nothing');
});

test('the seed is coerced into uint32 range', () => {
  assert.equal(normalizeBuildingDoc({ building: { seed: -5 } }).building.seed, 5);
  assert.equal(normalizeBuildingDoc({ building: { seed: 2.7 } }).building.seed, 2);
  assert.equal(normalizeBuildingDoc({ building: { seed: 'x' } }).building.seed, 12345);
  // 0 is a legal seed, not "unset".
  assert.equal(normalizeBuildingDoc({ building: { seed: 0 } }).building.seed, 0);
});

// --- the metadata mirror ----------------------------------------------------

test('buildingAssetDigest splits refs by kind and keeps the asset: prefix', () => {
  const doc = normalizeBuildingDoc({
    name: 'Villa',
    building: { seed: 7, stylePackId: 'roman-villa' },
    nodes: [{ id: 'a', type: 'footprint' }],
    references: {
      tex: { kind: 'image', ref: 'asset:1' },
      win: { kind: 'mesh', ref: 'asset:2' },
      cor: { kind: 'profile', ref: 'asset:3' },
      empty: { kind: 'image', ref: '' },
    },
  });
  const digest = buildingAssetDigest(doc);
  assert.deepEqual(digest.imageRefs, ['asset:1']);
  assert.deepEqual(digest.meshRefs, ['asset:2']);
  assert.deepEqual(digest.profileRefs, ['asset:3']);
  assert.equal(digest.stylePackId, 'roman-villa');
  assert.equal(digest.nodeCount, 1);
  // Every ref in the digest must match the pattern storage.js walks for.
  for (const ref of [...digest.imageRefs, ...digest.meshRefs, ...digest.profileRefs]) {
    assert.match(ref, /^asset:\d+$/);
  }
});

test('findNode and nodesOfType', () => {
  const doc = twoNodes();
  assert.equal(findNode(doc, 'b').type, 'extrude');
  assert.equal(findNode(doc, 'zzz'), null);
  assert.equal(nodesOfType(doc, 'footprint').length, 1);
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`doc.test.mjs: ${passed} passed`);
