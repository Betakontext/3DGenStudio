// Every shipped style pack loads, validates, compiles, and produces a building
// that is actually different from the others.
//
//   node tools/check-building-presets.mjs
//
// THIS IS THE FALSIFICATION TEST FROM THE PLAN, run on every build rather than
// once by hand. The design of this whole feature rests on one claim: that the
// styles in the target list - Roman, Cyberpunk, Egyptian, Mayan and the rest -
// differ in HOW THE FOOTPRINT CHANGES AS IT RISES, and can therefore be
// expressed as data against one set of nodes. If that claim is false, the way it
// fails is that some style needs a node nobody else uses.
//
// So the check has teeth in three places:
//
//   1. validateStylePack REFUSES any node type outside the catalog. A pack that
//      needs new code cannot ship, and the failure names the node.
//   2. Every pack must COMPILE with no errors, on a plain rectangular plan -
//      because a style that only works on the footprint its author happened to
//      draw is not a style.
//   3. The buildings must be MEASURABLY DIFFERENT from one another. Four packs
//      that all validate and all produce the same box would pass the first two
//      checks and mean nothing.
//
// Run headless, with no server and no browser: this is a pure function of the
// files in resources/buildings/styles.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { compileBuilding } from '../building/compile.js';
import { createNode } from '../building/catalog.js';
import { createBuildingDoc, serializeBuildingDoc } from '../building/doc.js';
import { applyStylePack, validateStylePack } from '../building/stylepack.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STYLES_DIR = path.join(ROOT, 'resources', 'buildings', 'styles');

let failures = 0;
function check(ok, label, detail = '') {
  if (ok) { console.log(`  ok    ${label}`); return true; }
  failures += 1;
  console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  return false;
}

/**
 * A plain 20x12 rectangle with a courtyard.
 *
 * Deliberately NOT the default footprint: a pack tuned against the shape the
 * editor happens to start with would pass this check and fall apart on the first
 * plan a user draws. The courtyard is there because a hole is the thing most
 * likely to break a massing profile or a roof, and every pack has to survive it.
 */
function testDoc() {
  const footprint = createNode('footprint', 'fp');
  const output = createNode('output', 'out');
  footprint.props.shape = {
    outer: [[0, 0], [20, 0], [20, 12], [0, 12]],
    holes: [[[8, 4], [8, 8], [12, 8], [12, 4]]],
  };
  return createBuildingDoc({
    nodes: [footprint, output],
    edges: [{ id: 'e', from: { node: 'fp', port: 'out' }, to: { node: 'out', port: 'building' } }],
  });
}

/** The deform mode a document ended up with, for the summary line. */
function deformOf(doc) {
  const node = doc.nodes.find(n => n.type === 'deform');
  return node && node.modes.mode !== 'none' ? node.modes.mode : '';
}

const files = fs.existsSync(STYLES_DIR)
  ? fs.readdirSync(STYLES_DIR).filter(name => name.endsWith('.json')).sort()
  : [];

if (!files.length) {
  console.error(`No style packs found in ${STYLES_DIR}`);
  process.exit(1);
}

console.log(`Checking ${files.length} style pack(s) in resources/buildings/styles\n`);

const shapes = [];

for (const file of files) {
  const id = file.slice(0, -5);
  console.log(id);

  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(path.join(STYLES_DIR, file), 'utf8'));
  } catch (err) {
    check(false, 'parses as JSON', err.message);
    continue;
  }

  // The id is the filename. A pack whose body disagrees is unaddressable through
  // the route that serves it, and the mismatch is invisible until someone tries.
  if (!check(pack.id === id, 'id matches the filename', `body says "${pack.id}"`)) continue;

  const problems = validateStylePack(pack);
  if (!check(problems.length === 0, 'validates', problems.join('\n        '))) continue;

  const doc = applyStylePack(testDoc(), pack);
  if (!check(doc.building.stylePackId === id, 'applies to a document')) continue;

  // Byte-identical on a second application - the same property the IR has, and
  // for the same reason: without it no golden test of a pack is possible.
  check(
    serializeBuildingDoc(applyStylePack(testDoc(), pack)) === serializeBuildingDoc(doc),
    'applies deterministically',
  );

  const result = compileBuilding(doc);
  const errors = result.diagnostics.filter(d => d.severity === 'error');
  if (!check(result.ok && !errors.length, 'compiles clean on a plan with a courtyard',
    errors.map(d => `${d.code}: ${d.message}`).join('\n        '))) continue;

  // A warning is not a failure - W_MASS_TRUNCATED is CORRECT for a ziggurat -
  // but it is printed, because a shipped pack warning on a plain rectangle is
  // usually a value that wants tuning.
  for (const d of result.diagnostics.filter(d => d.severity === 'warning')) {
    console.log(`  note  ${d.code}: ${d.message.slice(0, 100)}`);
  }

  const stats = result.ir.stats;
  check(stats.levelCount > 0 && stats.height > 0, 'produces a building with height');
  check(result.ir.materials.length > 0, 'carries a palette into the IR');

  shapes.push({
    id,
    // The fingerprint a style is judged different by. Height and storey count
    // cover the massing; the slot count covers the facade grain; the roof height
    // and the polygon count cover the crown and how much the plan CHANGED on the
    // way up - which is the thing this whole design claims styles differ in.
    fingerprint: [
      Math.round(stats.height * 10),
      stats.storeyCount,
      stats.slotCount,
      Math.round(stats.roofHeight * 10),
      stats.polygonCount,
    ].join('/'),
    stats,
  });

  // A pack that declares trim stages and produces no runs has a settings bug -
  // a string course on a one-storey building, say - and the result looks merely
  // plain rather than wrong, so nothing else would catch it.
  if ((pack.graph || []).some(stage => stage.type === 'trim')) {
    check(stats.trimCount > 0, 'the trim stages it declares produce runs');
  }

  console.log(`  ->    ${stats.storeyCount} storeys, ${stats.height.toFixed(1)}m`
    + `${stats.roofHeight > 0 ? ` + ${stats.roofHeight.toFixed(1)}m roof` : ', flat'}`
    + `, ${stats.slotCount} openings`
    + `${stats.trimCount ? `, ${stats.trimCount} trim (${stats.trimLength.toFixed(0)}m)` : ''}`
    + `${deformOf(doc) ? `, ${deformOf(doc)}` : ''}`);
  console.log('');
}

// --- the part that makes the rest mean something -----------------------------

console.log('Distinctness');
const byFingerprint = new Map();
for (const shape of shapes) {
  const seen = byFingerprint.get(shape.fingerprint);
  if (seen) {
    check(false, `${shape.id} differs from ${seen}`,
      `both produce ${shape.fingerprint} (height/storeys/openings/roof/polygons)`);
  } else {
    byFingerprint.set(shape.fingerprint, shape.id);
  }
}
check(byFingerprint.size === shapes.length,
  `all ${shapes.length} packs produce distinguishable buildings`);

// And the massing specifically, not just the trimmings: at least two packs must
// change the plan as it rises. If every shipped style has the same vertical
// profile then the central claim of this feature is untested by its own library.
const withMassing = shapes.filter(s => s.stats.polygonCount > 2);
check(withMassing.length >= 2,
  'at least two packs change the footprint as it rises',
  `only ${withMassing.map(s => s.id).join(', ') || 'none'} do`);

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`All ${files.length} style pack(s) pass.`);
