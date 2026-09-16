// node building/frame.test.mjs
//
// Half-timbering. The thing worth testing hardest is the alignment: a frame
// whose studs do not land on the facade's bay boundaries puts timber through the
// middle of windows, and it does it silently.

import assert from 'node:assert/strict';
import { BRACE, MAX_FRAME_MEMBERS, generateFrame } from './frame.js';
import { generateFacade } from './facade.js';
import { stackMass } from './mass.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const SQUARE = { outer: [[0, 0], [12, 0], [12, 8], [0, 8]], holes: [] };
const levelsOf = (count = 3) => stackMass({ footprint: SQUARE, levelCount: count }).levels;
const frame = (rule = {}, count = 3) => generateFrame({
  levels: levelsOf(count), seed: 4711, nodeId: 'fr', rule,
});

const startOf = run => [run.path[0], run.path[1], run.path[2]];
const endOf = run => [run.path[3], run.path[4], run.path[5]];
const isVertical = run => Math.abs(run.path[0] - run.path[3]) < 1e-9
  && Math.abs(run.path[1] - run.path[4]) < 1e-9
  && Math.abs(run.path[2] - run.path[5]) > 1e-9;
const isHorizontal = run => Math.abs(run.path[2] - run.path[5]) < 1e-9;

// --- the members -------------------------------------------------------------

test('studs and rails are drawn even with no braces at all', () => {
  const out = frame({ brace: BRACE.NONE });
  assert.ok(out.runs.length > 0);
  assert.ok(out.runs.some(isVertical), 'no studs');
  assert.ok(out.runs.some(isHorizontal), 'no rails');
});

test('every member is an OPEN run with an outward normal', () => {
  // Both are load-bearing for the mesher: a closed run is swept as a mitred
  // horizontal ring, and a run with no normal has no direction for its section
  // to face - a vertical stud has no plan tangent to derive one from.
  const out = frame({ brace: BRACE.CROSS });
  assert.ok(out.runs.every(run => run.closed === false), 'a member came out closed');
  assert.ok(out.runs.every(run => run.normal.length === 3), 'a member has no normal');
  assert.ok(out.runs.every(run => Math.abs(run.normal[2]) < 1e-9),
    'a wall normal should be horizontal');
});

test('the normal points AWAY from the building', () => {
  const out = frame({ brace: BRACE.NONE }, 2);
  for (const run of out.runs) {
    const [x, y] = startOf(run);
    // The plan is 12x8 centred on (6, 4); a member on a wall faces outward from it.
    const outward = (x - 6) * run.normal[0] + (y - 4) * run.normal[1];
    assert.ok(outward > -1e-6, `a member at ${x},${y} faces inward`);
  }
});

test('rails span the whole wall rather than one panel each', () => {
  // One timber per wall, not fifteen butted end to end: each is swept geometry,
  // and the joins would show.
  const out = frame({ brace: BRACE.NONE, bayWidth: 1.5 }, 1);
  const rails = out.runs.filter(isHorizontal);
  // Four walls, two rails each.
  assert.equal(rails.length, 8, `${rails.length} rails on a one-storey box`);
  const lengths = rails.map(run => Math.hypot(
    endOf(run)[0] - startOf(run)[0], endOf(run)[1] - startOf(run)[1],
  ));
  assert.deepEqual([...new Set(lengths.map(l => l.toFixed(3)))].sort(), ['12.000', '8.000']);
});

test('a stud closes the run at the far end of every wall', () => {
  // Without it a colonnade or a frame is missing its last member, which is the
  // first thing anyone notices.
  const out = frame({ brace: BRACE.NONE, bayWidth: 4 }, 1);
  const studs = out.runs.filter(isVertical);
  // A 12m wall at a 4m nominal is 3 bays = 4 studs; an 8m wall is 2 = 3 studs.
  assert.equal(studs.length, (4 + 3) * 2, `${studs.length} studs`);
});

// --- alignment with the facade ----------------------------------------------

test('studs land on the FACADE’s bay boundaries, never through a window', () => {
  // The single most important property in this file. Both use tileSpan with the
  // same nominal, so they agree by construction - this asserts they really do.
  const bayWidth = 1.7;
  const levels = levelsOf(2);
  const facade = generateFacade({
    levels, seed: 4711, nodeId: 'fc', rule: { bayWidth, windowWidth: 1, pierWidth: 0.3 },
  });
  const out = generateFrame({ levels, seed: 4711, nodeId: 'fr', rule: { bayWidth, brace: BRACE.NONE } });

  const studs = out.runs.filter(isVertical);
  for (const window of facade.slots.filter(s => s.type === 'window')) {
    const wx = window.transform[12];
    const wy = window.transform[13];
    const wz = window.transform[14];
    const half = window.cellW / 2;
    for (const stud of studs) {
      const [sx, sy, z0] = startOf(stud);
      const z1 = endOf(stud)[2];
      if (wz < z0 - 0.01 || wz > z1 + 0.01) continue;
      // Distance from the stud to the window's centre, along the wall. Only
      // studs on the SAME wall can conflict, so require them close in plan.
      const d = Math.hypot(sx - wx, sy - wy);
      if (d > half + 0.5) continue;
      assert.ok(d >= half - 1e-6,
        `a stud at ${sx.toFixed(2)},${sy.toFixed(2)} is ${d.toFixed(3)}m from the `
        + `centre of a ${window.cellW.toFixed(2)}m window - it crosses it`);
    }
  }
});

// --- braces ------------------------------------------------------------------

test('each pattern draws a different amount of timber', () => {
  const count = pattern => frame({ brace: pattern }).runs.length;
  const none = count(BRACE.NONE);
  assert.ok(count(BRACE.DIAGONAL) > none, 'herringbone drew no braces');
  assert.ok(count(BRACE.CROSS) > count(BRACE.DIAGONAL), 'a cross is not more than one diagonal');
  assert.equal(count(BRACE.CHEVRON), count(BRACE.CROSS), 'both are two braces a panel');
  assert.ok(count(BRACE.LATTICE) > count(BRACE.CROSS), 'a lattice is not the densest');
});

test('herringbone alternates direction along the wall', () => {
  const out = frame({ brace: BRACE.DIAGONAL }, 1);
  // A brace is the only member that is neither vertical nor horizontal.
  const braces = out.runs.filter(run => !isVertical(run) && !isHorizontal(run));
  assert.ok(braces.length > 2);
  const rising = braces.filter(run => endOf(run)[2] > startOf(run)[2]).length;
  assert.ok(rising > 0 && rising < braces.length,
    `${rising} of ${braces.length} rise - they all lean the same way`);
});

test('a chevron meets at the top CENTRE of its panel', () => {
  const out = frame({ brace: BRACE.CHEVRON, bayWidth: 4 }, 1);
  const braces = out.runs.filter(run => !isVertical(run) && !isHorizontal(run));
  assert.ok(braces.length >= 2);
  // Each pair shares an endpoint at the top; find one and check its partner.
  const tops = braces.map(run => (startOf(run)[2] > endOf(run)[2] ? startOf(run) : endOf(run)));
  const key = p => `${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)}`;
  const counts = new Map();
  for (const top of tops) counts.set(key(top), (counts.get(key(top)) || 0) + 1);
  assert.ok([...counts.values()].some(n => n === 2),
    'no two braces share an apex - that is not a chevron');
});

test('MIXED rolls each panel from its own identity, so a wall is not wallpaper', () => {
  const out = frame({ brace: BRACE.MIXED });
  const braces = out.runs.filter(run => !isVertical(run) && !isHorizontal(run));
  assert.ok(braces.length > 0);
  // The count lands between the cheapest and the densest pattern, which it can
  // only do by having drawn several different ones.
  const diagonal = frame({ brace: BRACE.DIAGONAL }).runs.length;
  const lattice = frame({ brace: BRACE.LATTICE }).runs.length;
  const mixed = out.runs.length;
  assert.ok(mixed > diagonal && mixed < lattice, `mixed drew ${mixed}, between ${diagonal} and ${lattice}`);
});

test('ADDING A STOREY does not repattern the ones below it', () => {
  // The rule building/random.js exists for. A panel is hashed from its face,
  // floor and bay, never from a counter.
  const print = out => out.runs
    .filter(run => run.path[2] < 7 && run.path[5] < 7)
    .map(run => run.path.map(v => v.toFixed(3)).join(','))
    .sort()
    .join(' ');
  assert.equal(print(frame({ brace: BRACE.MIXED }, 6)), print(frame({ brace: BRACE.MIXED }, 3)));
});

test('the same document frames identically twice', () => {
  const print = out => JSON.stringify(out.runs);
  assert.equal(print(frame({ brace: BRACE.MIXED })), print(frame({ brace: BRACE.MIXED })));
});

// --- scoping and limits ------------------------------------------------------

test('a frame covers only the storeys it claims', () => {
  const out = frame({ brace: BRACE.NONE, floorFrom: 1, floorTo: 2 });
  assert.deepEqual([...out.claimed].sort(), [1, 2]);
  // Nothing below the first floor, which starts at the ground storey's top.
  const ground = levelsOf(3)[0];
  assert.ok(out.runs.every(run => run.path[2] >= ground.z1 - 1e-6),
    'timber was drawn on a storey the frame does not claim');
});

test('courtyards are left bare unless asked for', () => {
  const holed = {
    outer: [[0, 0], [24, 0], [24, 18], [0, 18]],
    holes: [[[9, 7], [9, 12], [15, 12], [15, 7]]],
  };
  const levels = stackMass({ footprint: holed, levelCount: 2 }).levels;
  const bare = generateFrame({ levels, nodeId: 'fr', rule: { brace: BRACE.NONE } });
  const dressed = generateFrame({
    levels, nodeId: 'fr', rule: { brace: BRACE.NONE, includeCourtyards: true },
  });
  assert.ok(dressed.runs.length > bare.runs.length, 'the courtyard made no difference');
});

test('the member count is capped rather than allowed to wedge a tab', () => {
  const out = frame({ brace: BRACE.LATTICE, bayWidth: 0.3 }, 60);
  assert.equal(out.truncated, true);
  assert.ok(out.runs.length <= MAX_FRAME_MEMBERS, `${out.runs.length} members past the cap`);
});

test('no levels yields nothing rather than throwing', () => {
  assert.deepEqual(generateFrame({ levels: [] }).runs, []);
  assert.deepEqual(generateFrame({}).runs, []);
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`frame.test.mjs: ${passed} passed`);
