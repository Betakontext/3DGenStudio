// Installing a building export bundle into a library.
//
//     node src/utils/building/bundleImport.test.mjs
//
// building/bundle.test.mjs covers the FORMAT - what a manifest must say and
// which slots get emptied. This covers the INSTALL, and the reason it can is
// that `saveBuilding` and `uploadAssets` arrive as arguments: nothing here
// reaches for src/config.js, so node can load the module.
//
// The check worth the whole file is "the upload response is matched by name".
// /api/assets/library/import runs its files through Promise.all and pushes
// results as they finish, so the response order is whatever the filesystem felt
// like - and an importer that trusted the index would wire the roof texture to
// the wall slot on a machine fast enough to reorder them. That is a bug with no
// error message and no crash: the building imports, renders, and looks wrong.

import {
  importBuildingBundle,
  indexBundleFiles,
  readBuildingBundle,
  uploadFilename,
} from './bundleImport.js';
import { BUILDING_BUNDLE_FORMAT } from '../../../building/bundle.js';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(62)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

async function rejects(label, promise, fragment) {
  try {
    await promise;
    check(label, false, 'did not reject');
  } catch (err) {
    const ok = String(err.message).includes(fragment);
    check(label, ok, ok ? '' : err.message);
  }
}

/** A File as a directory input hands it over: bytes plus a relative path. */
function pick(relPath, contents = 'x') {
  const file = new File([contents], relPath.split('/').pop());
  Object.defineProperty(file, 'webkitRelativePath', { value: relPath });
  return file;
}

const DOC = {
  format: 1,
  kind: 'building',
  name: 'Elven Chapel',
  nodes: [],
  edges: [],
  references: {
    'tex_wall.0': { kind: 'image', ref: 'asset:41', name: 'Limestone', tileMetres: 2.2 },
    'tex_roof.0': { kind: 'image', ref: 'asset:42', name: 'Shingle', tileMetres: 3, tileMetresY: 2.4 },
    'mesh_arch.0': { kind: 'mesh', ref: 'asset:52', name: 'Tracery', rotation: [0, 45, 0] },
    'tex_gone.0': { kind: 'image', ref: 'asset:99', name: 'Deleted' },
  },
};

const MANIFEST = {
  bundleFormat: BUILDING_BUNDLE_FORMAT,
  kind: 'building',
  appVersion: '3.5.0',
  exportedAt: 1789000000000,
  asset: {
    id: 7, name: 'Elven Chapel',
    file: 'building/Elven_Chapel.building.json', thumbnail: 'building/chapel.png',
  },
  graph: DOC,
  references: [
    { slot: 'tex_wall.0', kind: 'image', ref: 'asset:41', name: 'Limestone', assetName: 'limestone.png', file: 'assets/images/1789-41.png' },
    { slot: 'tex_roof.0', kind: 'image', ref: 'asset:42', name: 'Shingle', assetName: 'shingle.png', file: 'assets/images/1789-42.png' },
    { slot: 'mesh_arch.0', kind: 'mesh', ref: 'asset:52', name: 'Tracery', assetName: 'tracery.glb', file: 'assets/meshes/1789-52.glb' },
    { slot: 'tex_gone.0', kind: 'image', ref: 'asset:99', name: 'Deleted', file: null },
  ],
  warnings: [{ code: 'MISSING_ASSET', severity: 'warn', message: 'tex_gone.0 is not in this library.' }],
};

const bundleFolder = (root = 'Elven_Chapel', manifest = MANIFEST) => [
  pick(`${root}/manifest.json`, JSON.stringify(manifest)),
  pick(`${root}/building/Elven_Chapel.building.json`, JSON.stringify(DOC)),
  pick(`${root}/building/chapel.png`, 'thumbnail-bytes'),
  pick(`${root}/assets/images/1789-41.png`, 'limestone-bytes'),
  pick(`${root}/assets/images/1789-42.png`, 'shingle-bytes'),
  pick(`${root}/assets/meshes/1789-52.glb`, 'tracery-bytes'),
];

// --- locating the bundle -----------------------------------------------------

{
  const { root, files } = indexBundleFiles(bundleFolder());
  check('the bundle root is found by its manifest', root === 'Elven_Chapel/');
  check('every file is keyed relative to that root', files.has('assets/images/1789-41.png'));
}

{
  // Export writes <chosen>/<building>/, so picking the parent is the obvious
  // mistake and the fix is to look for the manifest rather than to insist.
  const nested = bundleFolder('Exports/Elven_Chapel');
  const { root } = indexBundleFiles(nested);
  check('a folder picked one level up still resolves', root === 'Exports/Elven_Chapel/');
}

{
  let threw = '';
  try { indexBundleFiles([pick('Some_Folder/notes.txt')]); } catch (err) { threw = err.message; }
  check('a folder that is not a bundle is refused', /no manifest\.json/.test(threw), threw);

  threw = '';
  try {
    indexBundleFiles([
      pick('All/A/manifest.json', '{}'),
      pick('All/B/manifest.json', '{}'),
    ]);
  } catch (err) { threw = err.message; }
  check('two bundles in one folder is a question for the user', /holds 2 exported/.test(threw), threw);
}

// --- reading, which must write nothing ---------------------------------------

{
  const bundle = await readBuildingBundle(bundleFolder());
  check('the name comes off the manifest', bundle.name === 'Elven Chapel');
  check('the summary counts what will be installed',
    bundle.summary.textures === 2 && bundle.summary.models === 1,
    JSON.stringify(bundle.summary));
  check('the export warning is carried to the importer', bundle.warnings.length === 1);
  check('the thumbnail is found', Boolean(bundle.thumbnail));
  check('a slot that shipped no file is still a need',
    bundle.needs.some((need) => need.slot === 'tex_gone.0' && !need.file));
}

await rejects(
  'a bundle from a newer build is refused before anything is written',
  readBuildingBundle([
    pick('X/manifest.json', JSON.stringify({ ...MANIFEST, bundleFormat: BUILDING_BUNDLE_FORMAT + 1 })),
  ]),
  'newer version',
);

await rejects(
  'an effect bundle is not a building bundle',
  readBuildingBundle([pick('X/manifest.json', JSON.stringify({ ...MANIFEST, kind: 'vfx' }))]),
  'not a building',
);

// --- installing ---------------------------------------------------------------

/** An upload route that answers in REVERSE order, as a fast filesystem may. */
function reorderingUpload(idFor) {
  return async (assets) => ({
    imported: [...assets].reverse().map((entry) => ({
      id: idFor(entry.file.name), name: entry.file.name,
    })),
    skipped: [],
  });
}

{
  const ids = { 'limestone.png': 501, 'shingle.png': 502, 'tracery.glb': 503 };
  let saved = null;
  const bundle = await readBuildingBundle(bundleFolder());
  const result = await importBuildingBundle(bundle, {
    reuseExisting: false,
    uploadAssets: reorderingUpload((filename) => ids[filename]),
    listLibrary: async () => ({}),
    saveBuilding: async (spec) => { saved = spec; return { id: 900, name: spec.name }; },
  });

  // THE CHECK THIS FILE EXISTS FOR.
  check('each slot got ITS OWN file back, not the one at its index',
    saved.doc.references['tex_wall.0'].ref === 'asset:501'
    && saved.doc.references['tex_roof.0'].ref === 'asset:502'
    && saved.doc.references['mesh_arch.0'].ref === 'asset:503',
    JSON.stringify({
      wall: saved.doc.references['tex_wall.0'].ref,
      roof: saved.doc.references['tex_roof.0'].ref,
      arch: saved.doc.references['mesh_arch.0'].ref,
    }));

  check('a slot the bundle could not supply is emptied, not carried',
    saved.doc.references['tex_gone.0'].ref === '',
    saved.doc.references['tex_gone.0'].ref);
  check('and it is reported', result.missing.some((entry) => entry.slot === 'tex_gone.0'));

  // The fields that describe the ASSET rather than the library it came from.
  check('the tiling survives the install',
    saved.doc.references['tex_roof.0'].tileMetres === 3
    && saved.doc.references['tex_roof.0'].tileMetresY === 2.4,
    JSON.stringify(saved.doc.references['tex_roof.0']));
  check('a model keeps its rotation',
    JSON.stringify(saved.doc.references['mesh_arch.0'].rotation) === '[0,45,0]');

  check('three files were installed', result.installed.length === 3, result.installed.join(','));
  check('the thumbnail is passed to the save', Boolean(saved.thumbnail));
}

{
  // Reuse: a library that already holds "Limestone" should not gain a second.
  let uploaded = 0;
  let saved = null;
  const bundle = await readBuildingBundle(bundleFolder());
  const result = await importBuildingBundle(bundle, {
    reuseExisting: true,
    listLibrary: async () => ({ images: [{ id: 'library:77', name: 'limestone.png' }], meshes: [] }),
    uploadAssets: async (assets) => {
      uploaded += assets.length;
      return { imported: assets.map((entry) => ({ id: 600, name: entry.file.name })), skipped: [] };
    },
    saveBuilding: async (spec) => { saved = spec; return { id: 901 }; },
  });
  check('an asset already in the library is reused, not re-uploaded',
    result.reused.length === 1 && uploaded === 2, `reused ${result.reused.length}, uploaded ${uploaded}`);
  check('the reused id is what the slot points at',
    saved.doc.references['tex_wall.0'].ref === 'asset:77',
    saved.doc.references['tex_wall.0'].ref);
}

{
  // Best effort: one rejected file costs its own slot and nothing else.
  let saved = null;
  const bundle = await readBuildingBundle(bundleFolder());
  const result = await importBuildingBundle(bundle, {
    reuseExisting: false,
    listLibrary: async () => ({}),
    uploadAssets: async (assets, opts) => {
      if (opts.assetType === 'mesh') throw new Error('meshes are not allowed here');
      return { imported: assets.map((e, i) => ({ id: 700 + i, name: e.file.name })), skipped: [] };
    },
    saveBuilding: async (spec) => { saved = spec; return { id: 902 }; },
  });
  check('a failed upload costs one slot, not the building',
    result.failed.length === 1 && saved.doc.references['tex_wall.0'].ref !== '',
    JSON.stringify(result.failed));
  check('the failed slot is empty rather than foreign',
    saved.doc.references['mesh_arch.0'].ref === '');
}

{
  // Two slots, one file - a building commonly binds one stone to two plinths.
  const doc = {
    format: 1, kind: 'building', name: 'Two Plinths', nodes: [], edges: [],
    references: {
      'tpH.trim.0': { kind: 'image', ref: 'asset:60', name: 'Fieldstone' },
      'tpP.trim.0': { kind: 'image', ref: 'asset:60', name: 'Fieldstone' },
    },
  };
  const manifest = {
    bundleFormat: BUILDING_BUNDLE_FORMAT, kind: 'building',
    asset: { name: 'Two Plinths', file: 'building/x.building.json' },
    graph: doc,
    references: [
      { slot: 'tpH.trim.0', kind: 'image', ref: 'asset:60', assetName: 'stone.png', file: 'assets/images/s.png' },
      { slot: 'tpP.trim.0', kind: 'image', ref: 'asset:60', assetName: 'stone.png', file: 'assets/images/s.png' },
    ],
  };
  let uploaded = 0;
  let saved = null;
  const bundle = await readBuildingBundle([
    pick('Two_Plinths/manifest.json', JSON.stringify(manifest)),
    pick('Two_Plinths/building/x.building.json', JSON.stringify(doc)),
    pick('Two_Plinths/assets/images/s.png', 'stone-bytes'),
  ]);
  await importBuildingBundle(bundle, {
    reuseExisting: false,
    listLibrary: async () => ({}),
    uploadAssets: async (assets) => {
      uploaded += assets.length;
      return { imported: assets.map((e) => ({ id: 808, name: e.file.name })), skipped: [] };
    },
    saveBuilding: async (spec) => { saved = spec; return { id: 903 }; },
  });
  check('one file shared by two slots is uploaded once', uploaded === 1, `uploaded ${uploaded}`);
  check('and both slots point at it',
    saved.doc.references['tpH.trim.0'].ref === 'asset:808'
    && saved.doc.references['tpP.trim.0'].ref === 'asset:808');
}

// --- upload names --------------------------------------------------------------

{
  const taken = new Set();
  const a = uploadFilename({ file: 'assets/images/a.png', name: 'Wall Stone' }, taken);
  const b = uploadFilename({ file: 'assets/images/b.png', name: 'Wall Stone' }, taken);
  check('upload names are unique within a batch', a !== b, `${a} vs ${b}`);
  check('and keep their extension', a.endsWith('.png') && b.endsWith('.png'), `${a} ${b}`);
}

console.log(failures
  ? `\n${failures} check(s) failed.`
  : '\nbundleImport.test.mjs: all checks passed');
process.exitCode = failures ? 1 : 0;
