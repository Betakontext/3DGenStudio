// End-to-end check for the Building asset round trip.
//
//   node tools/building-e2e.mjs            # against an already-running server
//   PORT=3001 node tools/building-e2e.mjs
//
// Adding an asset type touches about a dozen places across storage.js,
// serverMode.js, server.js and the client, and the failure modes are mostly
// SILENT: omit getAssetSubdirectory and the file lands in assets/images/ with no
// error anywhere; omit the USER_ASSET_PREFIXES entry and the file 404s only in
// remote mode; store a bare-number asset reference and the document ships broken
// across installations without complaint. None of that shows up in a unit test,
// so it is checked against a real server here.
//
// Read-mostly, but it does WRITE: it creates a building asset, replaces it, and
// deletes it again. It runs against whatever data directory the server is using,
// so point it at a dev server rather than anything precious.

import process from 'node:process';
import {
  buildingAssetDigest,
  createBuildingDoc,
  normalizeBuildingDoc,
  serializeBuildingDoc,
} from '../building/doc.js';

const PORT = Number(process.env.PORT) || 3001;
const BASE = process.env.BUILDING_E2E_BASE || `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api`;

let failures = 0;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function json(response) {
  return response.json().catch(() => ({}));
}

async function main() {
  // 0. The server has to be up. Everything below is meaningless otherwise, so
  //    this exits rather than reporting a wall of failures.
  let health;
  try {
    health = await fetch(`${API}/health`);
  } catch (err) {
    console.error(`Could not reach ${BASE} - is the server running? (${err.message})`);
    process.exit(2);
  }
  if (!health.ok) {
    console.error(`${API}/health returned ${health.status}`);
    process.exit(2);
  }
  console.log(`Server reachable at ${BASE}\n`);

  // 1. The library listing must expose a `buildings` key even when empty. The
  //    client reads payload.buildings, so a missing key is an empty section that
  //    looks like "no buildings" forever.
  const listBefore = await json(await fetch(`${API}/assets/library`));
  check('GET /assets/library returns a buildings array',
    Array.isArray(listBefore.buildings),
    `got ${typeof listBefore.buildings}`);

  // 2. Create. A document with a reference, so the asset:<id> plumbing is
  //    exercised rather than assumed.
  const doc = normalizeBuildingDoc({
    ...createBuildingDoc({ name: 'E2E Building' }),
    building: { seed: 4242, units: 'm', stylePackId: 'e2e-style', overrides: {} },
    nodes: [
      { id: 'fp', type: 'footprint', props: { outer: [[0, 0], [10, 0], [10, 8], [0, 8]] } },
      { id: 'ex', type: 'extrude', props: { height: 3.2 } },
    ],
    edges: [{ from: { node: 'fp', port: 'out' }, to: { node: 'ex', port: 'shape' } }],
    references: {
      tex_facade: { kind: 'image', ref: 'asset:1', name: 'E2E Facade', colorSpace: 'srgb' },
    },
  });

  const createForm = new FormData();
  createForm.append('file', new File([serializeBuildingDoc(doc)], 'E2E_Building.building.json',
    { type: 'application/json' }));
  createForm.append('type', 'building');
  createForm.append('name', 'E2E Building');
  createForm.append('metadata', JSON.stringify(buildingAssetDigest(doc)));

  const created = await json(await fetch(`${API}/assets/library-upload`, {
    method: 'POST', body: createForm,
  }));
  const assetId = String(created?.id ?? '').replace(/^library:/, '');
  check('library-upload accepts type=building', Boolean(assetId),
    assetId ? `id ${assetId}` : JSON.stringify(created).slice(0, 160));
  if (!assetId) {
    console.error('\nCannot continue without an asset id.');
    process.exit(1);
  }

  // 3. THE SILENT ONE. getAssetSubdirectory must know about 'building', or the
  //    file is written into assets/images/ and nothing reports it.
  const record = await json(await fetch(`${API}/assets/record?assetId=${assetId}`));
  const storedPath = String(record?.filePath || '').replace(/\\/g, '/');
  check('the document is stored under assets/buildings/',
    storedPath.includes('assets/buildings/'),
    storedPath || '(no filePath)');

  // 4. The type came back as the wire form, lower-cased.
  const listAfter = await json(await fetch(`${API}/assets/library`));
  const row = (listAfter.buildings || []).find(
    entry => String(entry.id).replace(/^library:/, '') === assetId,
  );
  check('the new asset appears in the buildings listing', Boolean(row));

  // 5. The bytes are actually served. This is the one that fails in remote mode
  //    when USER_ASSET_PREFIXES is missing an entry.
  const fileUrl = row?.url?.startsWith('http') ? row.url : `${BASE}${row?.url || ''}`;
  const fileResponse = await fetch(fileUrl, { cache: 'reload' });
  check('the stored file is served', fileResponse.ok, `${fileResponse.status} ${fileUrl}`);

  let roundTripped = null;
  if (fileResponse.ok) {
    roundTripped = await json(fileResponse);
    check('the document round trips byte-for-byte',
      serializeBuildingDoc(normalizeBuildingDoc(roundTripped)) === serializeBuildingDoc(doc));
    check('the seed survived', roundTripped?.building?.seed === 4242,
      `got ${roundTripped?.building?.seed}`);
    check('the reference survived as an asset:<id> STRING',
      roundTripped?.references?.tex_facade?.ref === 'asset:1',
      `got ${JSON.stringify(roundTripped?.references?.tex_facade?.ref)}`);
  }

  // 6. The metadata digest must carry the reference in the shape storage.js's
  //    collectAssetIdsFromValue matches, or a .3dgp export silently drops the
  //    texture - the tree-preset bug this invariant exists to avoid.
  const metadata = typeof record?.metadata === 'string'
    ? JSON.parse(record.metadata || '{}')
    : (record?.metadata || {});
  check('metadata mirrors imageRefs as asset:<id> strings',
    Array.isArray(metadata.imageRefs) && metadata.imageRefs.includes('asset:1'),
    JSON.stringify(metadata.imageRefs));
  check('metadata records the style pack', metadata.stylePackId === 'e2e-style',
    String(metadata.stylePackId));

  // 7. Replace in place: the id must NOT change, because the Assets page's EDIT
  //    link and every saved reference resolve through it.
  const edited = normalizeBuildingDoc({ ...doc, building: { ...doc.building, seed: 777 } });
  const replaceForm = new FormData();
  replaceForm.append('file', new File([serializeBuildingDoc(edited)], 'E2E_Building.building.json',
    { type: 'application/json' }));
  replaceForm.append('payload', JSON.stringify({
    name: 'E2E Building', type: 'building', metadata: buildingAssetDigest(edited),
  }));
  const replaced = await json(await fetch(`${API}/assets/${assetId}/replace`, {
    method: 'POST', body: replaceForm,
  }));
  const replacedId = String(replaced?.id ?? replaced?.assetId ?? '').replace(/^library:/, '');
  check('replace keeps the same asset id', replacedId === assetId || replaced?.ok === true,
    `${replacedId || JSON.stringify(replaced).slice(0, 120)}`);

  const afterReplace = await json(await fetch(`${API}/assets/record?assetId=${assetId}`));
  const replacedUrl = String(afterReplace?.filePath || '').replace(/\\/g, '/');
  const replacedBytes = await fetch(
    `${BASE}/${replacedUrl.replace(/^\/?(?:data\/)?/, '')}`, { cache: 'reload' },
  ).then(json).catch(() => null);
  check('the replaced document reads back with the new seed',
    replacedBytes?.building?.seed === 777,
    `got ${replacedBytes?.building?.seed}`);
  check('the replacement is still under assets/buildings/',
    replacedUrl.includes('assets/buildings/'), replacedUrl);

  // 8. Clean up. A failure here is worth reporting but does not fail the run:
  //    the checks above have already passed or failed on their own terms.
  const deleted = await fetch(
    `${API}/assets/library?type=building&filename=${encodeURIComponent(
      storedPath.split('/').pop() || '')}&force=1`,
    { method: 'DELETE' },
  ).catch(() => null);
  console.log(`\ncleanup: delete returned ${deleted ? deleted.status : 'n/a'} (asset ${assetId})`);

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error('e2e crashed:', err);
  process.exit(1);
});
