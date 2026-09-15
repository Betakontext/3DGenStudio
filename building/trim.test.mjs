// node building/trim.test.mjs
//
// What a trim run has to get right: the correct edge, the correct direction, and
// nothing where there is nothing to trim.

import assert from 'node:assert/strict';
import { LEVEL_KIND } from './ir.js';
import { MAX_TRIM_RUNS, TRIM_PROFILE, TRIM_WHERE, generateTrim, trimSection } from './trim.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const rect = (w, h) => ({ outer: [[0, 0], [w, 0], [w, h], [0, h]], holes: [] });
const COURTYARD = {
  outer: [[0, 0], [20, 0], [20, 20], [0, 20]],
  holes: [[[8, 8], [8, 12], [12, 12], [12, 8]]],
};

/** A plain stack of `n` storeys, 3m each, on a 12x8 plan. */
function stack(n, polygon = rect(12, 8)) {
  const levels = [];
  for (let i = 0; i < n; i++) {
    levels.push({
      polygon, z0: i * 3, z1: (i + 1) * 3, index: i,
      kind: i === 0 ? LEVEL_KIND.GROUND : LEVEL_KIND.UPPER,
    });
  }
  return levels;
}

const zOf = run => run.path[2];
const zsOf = result => result.runs.map(zOf).sort((a, b) => a - b);

// --- which edge -------------------------------------------------------------

test('a cornice goes on top of the highest storey and nowhere else', () => {
  const result = generateTrim({ levels: stack(4), where: TRIM_WHERE.CORNICE });
  assert.equal(result.runs.length, 1);
  assert.equal(zOf(result.runs[0]), 12);
});

test('a plinth goes at the bottom of the stack', () => {
  const result = generateTrim({ levels: stack(4), where: TRIM_WHERE.PLINTH });
  assert.equal(result.runs.length, 1);
  assert.equal(zOf(result.runs[0]), 0);
});

test('a plinth lands on the PLINTH level when there is one', () => {
  // Taking index 0 would find the ground floor and bury the moulding inside the
  // plinth below it.
  const levels = [
    { polygon: rect(12, 8), z0: 0, z1: 1, index: 0, kind: LEVEL_KIND.PLINTH },
    ...stack(2).map(level => ({ ...level, z0: level.z0 + 1, z1: level.z1 + 1 })),
  ];
  const result = generateTrim({ levels, where: TRIM_WHERE.PLINTH });
  assert.equal(zOf(result.runs[0]), 0);
});

test('string courses skip the top storey, where the cornice goes', () => {
  // Two mouldings at one height is the most common way trim reads as wrong.
  const result = generateTrim({ levels: stack(4), where: TRIM_WHERE.STRING });
  assert.deepEqual(zsOf(result), [3, 6, 9]);
});

test('"every" thins the string courses out', () => {
  assert.deepEqual(zsOf(generateTrim({ levels: stack(7), where: TRIM_WHERE.STRING, every: 2 })),
    [6, 12, 18]);
  assert.deepEqual(zsOf(generateTrim({ levels: stack(7), where: TRIM_WHERE.STRING, every: 3 })),
    [9, 18]);
});

test('a one-storey building gets no string course, and is told so', () => {
  const result = generateTrim({ levels: stack(1), where: TRIM_WHERE.STRING });
  assert.equal(result.runs.length, 0);
});

test('an eave follows the ROOF, not the top of the wall', () => {
  // On a roof with an overhang those are different rings, and the eave belongs
  // to the roof - which is what makes an Asian eave oversail correctly.
  const roof = { rungs: [{ polygons: [rect(14, 10)], z: 12 }, { polygons: [rect(6, 4)], z: 15 }] };
  const result = generateTrim({ levels: stack(4), roof, where: TRIM_WHERE.EAVE });
  assert.equal(result.runs.length, 1);
  assert.equal(zOf(result.runs[0]), 12);
  assert.equal(result.runs[0].path.length / 3, 4);
  // The 14x10 overhanging ring, not the 12x8 wall.
  assert.equal(Math.max(...result.runs[0].path.filter((_, i) => i % 3 === 0)), 14);
});

test('with no roof an eave falls back to the top of the wall', () => {
  const result = generateTrim({ levels: stack(3), where: TRIM_WHERE.EAVE });
  assert.equal(zOf(result.runs[0]), 9);
});

test('a parapet stands on the roof it is given', () => {
  const roof = { rungs: [{ polygons: [rect(12, 8)], z: 9 }], closed: true, height: 0 };
  const result = generateTrim({ levels: stack(3), roof, where: TRIM_WHERE.PARAPET });
  assert.equal(zOf(result.runs[0]), 9);
});

// --- courtyards -------------------------------------------------------------

test('trim wraps a courtyard, and can be told not to', () => {
  const levels = stack(2, COURTYARD);
  assert.equal(generateTrim({ levels, where: TRIM_WHERE.CORNICE }).runs.length, 2);
  assert.equal(
    generateTrim({ levels, where: TRIM_WHERE.CORNICE, includeHoles: false }).runs.length, 1,
  );
});

test('the courtyard run keeps the hole winding it was stored with', () => {
  // Reversed here, the moulding would project INTO the masonry instead of into
  // the courtyard - the reason this file walks rings as stored.
  const runs = generateTrim({ levels: stack(1, COURTYARD), where: TRIM_WHERE.CORNICE }).runs;
  const hole = runs[1].path;
  assert.deepEqual([hole[0], hole[1]], [8, 8]);
  assert.deepEqual([hole[3], hole[4]], [8, 12], 'the hole was re-wound');
});

// --- limits and shape -------------------------------------------------------

test('a tower cannot emit unbounded runs', () => {
  const result = generateTrim({ levels: stack(900), where: TRIM_WHERE.STRING });
  assert.equal(result.runs.length, MAX_TRIM_RUNS);
  assert.equal(result.truncated, true);
});

test('an empty stack produces nothing rather than throwing', () => {
  for (const levels of [[], [{ polygon: rect(0, 0), z0: 0, z1: 3, index: 0 }]]) {
    assert.deepEqual(generateTrim({ levels, where: TRIM_WHERE.CORNICE }).runs, []);
  }
});

test('a run carries its own section size', () => {
  // The IR has no nodes, so a consumer cannot look the size up - see ir.js.
  const run = generateTrim({
    levels: stack(2), where: TRIM_WHERE.CORNICE, projection: 0.5, depth: 0.9,
  }).runs[0];
  assert.equal(run.projection, 0.5);
  assert.equal(run.depth, 0.9);
  assert.equal(run.closed, true);
});

test('every profile is a usable closed section', () => {
  for (const [id, points] of Object.entries(TRIM_PROFILE)) {
    assert.ok(points.length >= 3, `${id} has too few points`);
    for (const [out, up] of points) {
      assert.ok(out >= 0 && out <= 1, `${id}: out ${out} is outside 0..1`);
      assert.ok(up >= -0.5 && up <= 1, `${id}: up ${up} is outside -0.5..1`);
    }
    // Nothing may be entirely flat against the wall, or it would be invisible.
    assert.ok(points.some(([out]) => out > 0.5), `${id} never leaves the wall`);
  }
});

test('a section scales to metres, and a parapet sits ABOVE its line', () => {
  const cornice = trimSection(TRIM_WHERE.CORNICE, 0.4, 0.6);
  assert.equal(Math.max(...cornice.map(p => p[0])), 0.4);
  assert.ok(Math.min(...cornice.map(p => p[1])) < 0, 'a cornice should straddle its line');

  const parapet = trimSection(TRIM_WHERE.PARAPET, 0.3, 1.2);
  assert.ok(Math.min(...parapet.map(p => p[1])) >= 0, 'a parapet dipped below the deck');
  assert.equal(Math.max(...parapet.map(p => p[1])), 1.2);
});

test('an unknown profile falls back rather than producing nothing', () => {
  assert.ok(trimSection('no-such-profile', 0.3, 0.3).length >= 3);
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`trim.test.mjs: ${passed} passed`);
