// node building/bundle.test.mjs
//
// The claim under test: a building can leave one library and arrive in another
// wearing the same textures. The failure this guards against is not a crash - it
// is an import that looks clean and shows the wrong brick, because a slot still
// points at an id that means something else here.

import assert from 'node:assert/strict';
import {
  BUILDING_BUNDLE_FORMAT, BuildingBundleError, applyBundleAssets, bundleAssetNeeds,
  bundleBuildingName, bundleGraphSource, bundleReferencePlan, bundleWarnings,
  normalizeBundlePath, parseBundleManifest, summarizeBundle,
} from './bundle.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const DOC = {
  name: 'Elven Chapel',
  references: {
    'tex_wall.0': { kind: 'image', ref: 'asset:1646', name: 'Limestone', tileMetres: 2.2 },
    'tex_roof.0': { kind: 'image', ref: 'asset:1677', name: 'Shingle', tileMetres: 3, tileMetresY: 2.4 },
    'mesh_arch.0': { kind: 'mesh', ref: 'asset:1657', name: 'Tracery', rotation: [0, 45, 0] },
    'tex_door.0': { kind: 'image', ref: '', name: 'Door' },
  },
};

const manifestFor = (files) => ({
  bundleFormat: BUILDING_BUNDLE_FORMAT,
  kind: 'building',
  appVersion: '3.5.0',
  exportedAt: 1789000000000,
  asset: { name: 'Elven Chapel', file: 'building/Elven_Chapel.building.json' },
  graph: DOC,
  references: bundleReferencePlan(DOC).map((entry) => ({
    ...entry,
    ref: entry.assetId ? `asset:${entry.assetId}` : '',
    file: files[entry.slot] ?? '',
    assetName: entry.name,
  })),
  warnings: [],
});

// --- the export side -----------------------------------------------------------

test('the reference plan lists every slot, filled or not', () => {
  const plan = bundleReferencePlan(DOC);
  assert.equal(plan.length, 4);
  // Sorted, so two exports of one document write identical manifests.
  assert.deepEqual(plan.map((entry) => entry.slot),
    ['mesh_arch.0', 'tex_door.0', 'tex_roof.0', 'tex_wall.0']);
  assert.equal(plan.find((entry) => entry.slot === 'tex_wall.0').assetId, 1646);
  assert.equal(plan.find((entry) => entry.slot === 'mesh_arch.0').kind, 'mesh');
  // The empty slot is CARRIED, because the import has to tell "never filled"
  // from "the file went missing".
  assert.equal(plan.find((entry) => entry.slot === 'tex_door.0').assetId, 0);
});

// --- reading a folder -----------------------------------------------------------

test('a manifest from a newer build is refused, not half-read', () => {
  assert.throws(
    () => parseBundleManifest({ ...manifestFor({}), bundleFormat: BUILDING_BUNDLE_FORMAT + 1 }),
    BuildingBundleError,
  );
});

test('an effect bundle is not a building bundle, and says so', () => {
  // Both are a folder with a manifest.json in it.
  assert.throws(
    () => parseBundleManifest({ ...manifestFor({}), kind: 'vfx' }),
    /not a building/,
  );
});

test('a folder with no building in it is refused', () => {
  assert.throws(
    () => parseBundleManifest({ bundleFormat: 1, kind: 'building', asset: {} }),
    /carries no building/,
  );
  assert.throws(() => parseBundleManifest('{ not json'), /not valid JSON/);
  assert.throws(() => parseBundleManifest({ asset: { file: 'a.json' } }), /no bundleFormat/);
});

test('a path that climbs out of the bundle is rejected', () => {
  assert.equal(normalizeBundlePath('../../etc/passwd'), '');
  assert.equal(normalizeBundlePath('/assets/wall.png'), 'assets/wall.png');
  assert.equal(normalizeBundlePath('assets\\wall.png'), 'assets/wall.png');
});

test('the graph can be embedded or beside the manifest', () => {
  const embedded = bundleGraphSource(manifestFor({}));
  assert.equal(embedded.graph.name, 'Elven Chapel');
  assert.equal(embedded.file, 'building/Elven_Chapel.building.json');
  assert.equal(bundleBuildingName(manifestFor({})), 'Elven Chapel');
});

// --- the remap, which is the whole point -----------------------------------------

test('every slot is re-pointed at the id its file got here', () => {
  const manifest = manifestFor({
    'tex_wall.0': 'assets/limestone.png',
    'tex_roof.0': 'assets/shingle.png',
    'mesh_arch.0': 'assets/tracery.glb',
  });
  const needs = bundleAssetNeeds(manifest);
  const { doc, resolved, missing } = applyBundleAssets(DOC, needs, {
    'assets/limestone.png': 55,
    'assets/shingle.png': 56,
    'assets/tracery.glb': 57,
  });

  assert.equal(doc.references['tex_wall.0'].ref, 'asset:55');
  assert.equal(doc.references['tex_roof.0'].ref, 'asset:56');
  assert.equal(doc.references['mesh_arch.0'].ref, 'asset:57');
  assert.equal(resolved.length, 3);
  // The unfilled door slot is not a warning: it arrived empty and stays empty.
  assert.equal(missing.length, 0, JSON.stringify(missing));
});

test('the tiling and the rotation survive the remap', () => {
  // A reference carries more than its id, and those fields describe the ASSET
  // rather than the library it came from. Rebuilding the entry instead of
  // spreading it resets every texture to a 2m square tile - which looks like a
  // working import.
  const manifest = manifestFor({
    'tex_roof.0': 'assets/shingle.png', 'mesh_arch.0': 'assets/tracery.glb',
  });
  const { doc } = applyBundleAssets(DOC, bundleAssetNeeds(manifest), {
    'assets/shingle.png': 56, 'assets/tracery.glb': 57,
  });
  assert.equal(doc.references['tex_roof.0'].tileMetres, 3);
  assert.equal(doc.references['tex_roof.0'].tileMetresY, 2.4, 'the second tiling axis was lost');
  assert.deepEqual(doc.references['mesh_arch.0'].rotation, [0, 45, 0]);
});

test('a reference the bundle could not supply is CLEARED, never carried', () => {
  // The whole reason this module exists. An unresolved asset:1646 resolves to
  // whatever holds that id HERE, which imports clean and shows the wrong brick.
  const manifest = manifestFor({ 'tex_wall.0': 'assets/limestone.png' });
  const { doc, missing } = applyBundleAssets(DOC, bundleAssetNeeds(manifest), {});

  for (const slot of ['tex_wall.0', 'tex_roof.0', 'mesh_arch.0']) {
    assert.equal(doc.references[slot].ref, '', `${slot} kept a foreign id`);
  }
  assert.equal(missing.length, 3);
  assert.match(missing.find((entry) => entry.slot === 'tex_wall.0').reason, /could not be added/);
  assert.match(missing.find((entry) => entry.slot === 'tex_roof.0').reason, /shipped without/);
});

test('a slot the manifest never mentioned is cleared too', () => {
  // It cannot have travelled with a file, so its ref is a foreign id by
  // definition - and a manifest that lists nothing would otherwise carry every
  // reference across untouched, which is the worst case of all.
  const { doc, missing } = applyBundleAssets(DOC, [], {});
  assert.equal(doc.references['tex_wall.0'].ref, '');
  assert.equal(doc.references['mesh_arch.0'].ref, '');
  assert.equal(missing.length, 3, JSON.stringify(missing));
  assert.match(missing[0].reason, /does not list it/);
  // And the slot that was already empty is still not a warning.
  assert.equal(missing.some((entry) => entry.slot === 'tex_door.0'), false);
});

test('two slots sharing one file are both re-pointed from one upload', () => {
  // A building commonly binds one stone to the plinth run of two masses.
  const doc = {
    references: {
      'tpH.trim.0': { kind: 'image', ref: 'asset:1652', name: 'Fieldstone' },
      'tpP.trim.0': { kind: 'image', ref: 'asset:1652', name: 'Fieldstone' },
    },
  };
  const manifest = {
    bundleFormat: 1,
    kind: 'building',
    asset: { name: 'Two Plinths', file: 'building/x.json' },
    graph: doc,
    references: [
      { slot: 'tpH.trim.0', kind: 'image', ref: 'asset:1652', file: 'assets/stone.png' },
      { slot: 'tpP.trim.0', kind: 'image', ref: 'asset:1652', file: 'assets/stone.png' },
    ],
  };
  const out = applyBundleAssets(doc, bundleAssetNeeds(manifest), { 'assets/stone.png': 70 });
  assert.equal(out.doc.references['tpH.trim.0'].ref, 'asset:70');
  assert.equal(out.doc.references['tpP.trim.0'].ref, 'asset:70');
  assert.equal(summarizeBundle(manifest).textures, 1, 'one file counted twice');
});

test('a manifest naming a slot the building lacks is reported, not written', () => {
  const manifest = {
    bundleFormat: 1,
    kind: 'building',
    asset: { name: 'x', file: 'building/x.json' },
    graph: DOC,
    references: [{ slot: 'tex_ghost.0', kind: 'image', ref: 'asset:9', file: 'assets/g.png' }],
  };
  const { doc, missing } = applyBundleAssets(DOC, bundleAssetNeeds(manifest), { 'assets/g.png': 8 });
  assert.equal('tex_ghost.0' in doc.references, false, 'a slot was invented');
  assert.match(missing.find((entry) => entry.slot === 'tex_ghost.0').reason, /no such slot/);
});

// --- what the dialog shows before anything is written ----------------------------

test('a summary counts what the import will actually install', () => {
  const manifest = manifestFor({
    'tex_wall.0': 'assets/limestone.png',
    'tex_roof.0': 'assets/shingle.png',
    'mesh_arch.0': 'assets/tracery.glb',
  });
  manifest.warnings = [{ code: 'MISSING_ASSET', severity: 'warn', message: 'gone' }];
  const summary = summarizeBundle(manifest);
  assert.equal(summary.name, 'Elven Chapel');
  assert.equal(summary.textures, 2);
  assert.equal(summary.models, 1);
  assert.equal(summary.empty, 1, 'the unfilled door slot was not counted');
  assert.equal(summary.warnings, 1);
  assert.equal(summary.appVersion, '3.5.0');
  assert.equal(bundleWarnings(manifest)[0].code, 'MISSING_ASSET');
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`bundle.test.mjs: ${passed} passed`);
