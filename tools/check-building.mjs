// Runs the building generator's unit tests as a build gate.
//
//   node tools/check-building.mjs
//
// The tests are plain `node building/*.test.mjs` files with no harness, which is
// the same convention vfx/ uses. This wrapper exists so `npm run dist` can gate
// on them the way it already gates on check:vfx: a building document is a spec
// that has to regenerate its geometry deterministically, and the two properties
// that guarantee that - the offset behaviour roof generation depends on, and the
// identity-hashed seeding that stops an edit reshuffling the whole facade - are
// both invisible until someone notices a building looks wrong.
//
// Discovered rather than listed, so a new test file is picked up by existing
// without anyone having to remember this file exists.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Both halves of the generator. building/ is the pure contract; src/utils/building/
// is the three.js meshing layer, and its tests run headless too - three's geometry
// classes need no WebGL context, and the winding and normal-direction checks there
// catch the errors that only show up once a model is lit.
const testDirs = [
  path.join(repoRoot, 'building'),
  path.join(repoRoot, 'src', 'utils', 'building'),
];

const tests = [];
for (const dir of testDirs) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    continue; // the meshing layer may not exist yet in an older checkout
  }
  for (const name of names.filter(n => n.endsWith('.test.mjs')).sort()) {
    tests.push(path.join(dir, name));
  }
}

if (tests.length === 0) {
  console.error('No building test files found - did the directories move?');
  process.exit(1);
}

let failed = 0;
for (const test of tests) {
  const result = spawnSync(process.execPath, [test], { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) failed++;
}

if (failed) {
  console.error(`\n${failed} of ${tests.length} building test files failed.`);
  process.exit(1);
}
console.log(`\nall ${tests.length} building test files passed`);
