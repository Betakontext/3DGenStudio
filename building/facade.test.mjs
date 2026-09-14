// node building/facade.test.mjs

import assert from 'node:assert/strict';
import { MAX_SLOTS, generateFacade } from './facade.js';
import { MASS_PROFILE, stackMass } from './mass.js';
import { SLOT_TYPE } from './ir.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const SQUARE = { outer: [[0, 0], [12, 0], [12, 8], [0, 8]], holes: [] };
const COURTYARD = {
  outer: [[0, 0], [30, 0], [30, 30], [0, 30]],
  holes: [[[10, 10], [10, 20], [20, 20], [20, 10]]],
};

const build = (footprint, mass = {}, rule = {}) => generateFacade({
  levels: stackMass({ footprint, levelCount: 3, ...mass }).levels,
  seed: 12345,
  nodeId: 'facade-1',
  rule,
});

// Read a slot's world position and its outward normal out of the transform.
const positionOf = s => [s.transform[12], s.transform[13], s.transform[14]];
const normalOf = s => [s.transform[8], s.transform[9], s.transform[10]];
const alongOf = s => [s.transform[0], s.transform[1], s.transform[2]];

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// --- basics ------------------------------------------------------------------

test('a plain block gets windows on every storey', () => {
  const out = build(SQUARE);
  assert.ok(out.slots.length > 0);
  const floors = new Set(out.slots.map(s => s.floorIndex));
  assert.deepEqual([...floors].sort(), [0, 1, 2]);
});

test('every wall of the plan is dressed', () => {
  const out = build(SQUARE);
  const faces = new Set(out.slots.filter(s => s.floorIndex === 1).map(s => s.faceIndex));
  assert.equal(faces.size, 4, 'a rectangle has four walls');
});

test('bay counts come from integer snapping, not from the nominal width', () => {
  // 12m and 8m walls at a 3m nominal bay: four bays and three bays, exactly.
  const out = build(SQUARE, {}, { bayWidth: 3 });
  const upper = out.slots.filter(s => s.floorIndex === 1);
  const perFace = new Map();
  for (const slot of upper) perFace.set(slot.faceIndex, (perFace.get(slot.faceIndex) || 0) + 1);
  assert.deepEqual([...perFace.values()].sort(), [3, 3, 4, 4]);
});

test('openings keep their natural width on any wall', () => {
  // The point of the stretch rule: a 12m wall and an 8m wall give different bay
  // sizes but identical windows.
  const out = build(SQUARE, {}, { bayWidth: 3, windowWidth: 1.2 });
  for (const slot of out.slots.filter(s => s.type === SLOT_TYPE.WINDOW)) {
    assert.ok(Math.abs(slot.cellW - 1.2) < 1e-9, `window is ${slot.cellW}m wide`);
  }
});

test('a taller ground floor gets a taller opening, unasked', () => {
  const out = build(SQUARE, { groundHeight: 4.5, levelHeight: 3 });
  const ground = out.slots.find(s => s.floorIndex === 0 && s.type === SLOT_TYPE.WINDOW);
  const upper = out.slots.find(s => s.floorIndex === 1);
  assert.ok(ground.cellH > upper.cellH, `${ground.cellH} is not taller than ${upper.cellH}`);
});

// --- orientation -------------------------------------------------------------

test('every slot transform is right-handed', () => {
  // X cross Y must equal Z, or a window model arrives mirrored - which reads as
  // subtly wrong rather than obviously broken.
  for (const slot of build(SQUARE).slots) {
    const expected = cross(alongOf(slot), [0, 0, 1]);
    const actual = normalOf(slot);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(expected[i] - actual[i]) < 1e-9,
        `slot on face ${slot.faceIndex} is mirrored`);
    }
  }
});

test('street windows face OUT', () => {
  const out = build(SQUARE);
  const centre = [6, 4];
  for (const slot of out.slots) {
    const p = positionOf(slot);
    const outward = [p[0] - centre[0], p[1] - centre[1], 0];
    assert.ok(dot(outward, normalOf(slot)) > 0,
      `a window at ${p} faces inward`);
  }
});

test('COURTYARD windows face INTO the courtyard', () => {
  // The hole is stored clockwise on purpose; re-winding it would turn every
  // courtyard window to face the masonry.
  const out = build(COURTYARD, { levelCount: 2 });
  const court = [15, 15];
  const inner = out.slots.filter(s => {
    const p = positionOf(s);
    return p[0] > 9.5 && p[0] < 20.5 && p[1] > 9.5 && p[1] < 20.5;
  });
  assert.ok(inner.length > 0, 'the courtyard got no windows at all');
  for (const slot of inner) {
    const p = positionOf(slot);
    const toCentre = [court[0] - p[0], court[1] - p[1], 0];
    assert.ok(dot(toCentre, normalOf(slot)) > 0, `a courtyard window at ${p} faces the wall`);
  }
});

test('courtyards can be turned off', () => {
  const withCourt = build(COURTYARD, { levelCount: 2 }, { includeCourtyards: true });
  const without = build(COURTYARD, { levelCount: 2 }, { includeCourtyards: false });
  assert.ok(without.slots.length < withCourt.slots.length);
});

test('slots sit within the storey they belong to', () => {
  const out = build(SQUARE, { groundHeight: 4, levelHeight: 3 });
  const bounds = { 0: [0, 4], 1: [4, 7], 2: [7, 10] };
  for (const slot of out.slots) {
    const z = positionOf(slot)[2];
    const [lo, hi] = bounds[slot.floorIndex];
    assert.ok(z > lo && z < hi, `floor ${slot.floorIndex} slot at z=${z}, expected ${lo}..${hi}`);
  }
});

// --- the door ----------------------------------------------------------------

test('there is exactly ONE front door, on the ground floor', () => {
  const out = build(SQUARE);
  const doors = out.slots.filter(s => s.type === SLOT_TYPE.DOOR);
  assert.equal(doors.length, 1);
  assert.equal(doors[0].floorIndex, 0);
  assert.equal(out.doorCount, 1);
});

test('the door stands on the floor rather than floating', () => {
  const out = build(SQUARE, {}, { doorHeight: 2.2 });
  const door = out.slots.find(s => s.type === SLOT_TYPE.DOOR);
  // Its centre is half its height above the storey's floor.
  assert.ok(Math.abs(positionOf(door)[2] - door.cellH / 2) < 1e-9);
});

test('the door goes on the longest wall', () => {
  // A 20x6 plan: the door belongs on a 20m side, not a 6m end.
  const out = build({ outer: [[0, 0], [20, 0], [20, 6], [0, 6]], holes: [] });
  const door = out.slots.find(s => s.type === SLOT_TYPE.DOOR);
  const p = positionOf(door);
  assert.ok(Math.abs(p[1]) < 1e-6 || Math.abs(p[1] - 6) < 1e-6,
    `the door landed on an end wall at ${p}`);
});

test('the door never opens into a courtyard', () => {
  const out = build(COURTYARD, { levelCount: 2 });
  const door = out.slots.find(s => s.type === SLOT_TYPE.DOOR);
  const p = positionOf(door);
  const insideCourt = p[0] > 9.5 && p[0] < 20.5 && p[1] > 9.5 && p[1] < 20.5;
  assert.equal(insideCourt, false, `the front door opens into the courtyard at ${p}`);
});

// --- determinism -------------------------------------------------------------

test('ADDING A STOREY DOES NOT RESHUFFLE THE WINDOWS BELOW IT', () => {
  // The property the whole seeding design exists for, now end to end.
  const three = build(SQUARE, { levelCount: 3 });
  const seven = build(SQUARE, { levelCount: 7 });
  const key = s => `${s.faceIndex}/${s.floorIndex}/${s.bayIndex}/${s.type}`;
  const after = new Map(seven.slots.map(s => [key(s), s.seedKey]));
  for (const slot of three.slots) {
    assert.equal(after.get(key(slot)), slot.seedKey, `${key(slot)} was reseeded`);
  }
});

test('the same building twice is identical', () => {
  assert.equal(JSON.stringify(build(SQUARE).slots), JSON.stringify(build(SQUARE).slots));
});

test('two facade nodes draw independently', () => {
  const a = generateFacade({ levels: stackMass({ footprint: SQUARE, levelCount: 2 }).levels, seed: 1, nodeId: 'a' });
  const b = generateFacade({ levels: stackMass({ footprint: SQUARE, levelCount: 2 }).levels, seed: 1, nodeId: 'b' });
  assert.notEqual(a.slots[0].seedKey, b.slots[0].seedKey);
});

// --- guards ------------------------------------------------------------------

test('a plinth gets no windows', () => {
  const out = generateFacade({
    levels: stackMass({ footprint: SQUARE, levelCount: 2, plinthHeight: 1.2 }).levels,
    seed: 1,
  });
  const zs = out.slots.map(s => positionOf(s)[2]);
  assert.ok(zs.every(z => z > 1.2), 'something was placed on the plinth');
});

test('a wall too short for a bay is skipped, not given a broken one', () => {
  const sliver = { outer: [[0, 0], [10, 0], [10, 0.2], [0, 0.2]], holes: [] };
  const out = build(sliver);
  assert.ok(out.slots.every(s => s.cellW > 0));
});

test('a storey too short for a sill and lintel is reported', () => {
  const out = build(SQUARE, { levelHeight: 0.8, groundHeight: 0.8 });
  assert.equal(out.squashed || out.slots.length === 0, true);
});

test('the slot count is capped rather than allowed to run away', () => {
  const huge = { outer: [[0, 0], [400, 0], [400, 400], [0, 400]], holes: [] };
  const out = build(huge, { levelCount: 60 }, { bayWidth: 1 });
  assert.ok(out.slots.length <= MAX_SLOTS, `${out.slots.length} slots`);
  assert.equal(out.truncated, true);
});

test('no levels yields no slots rather than throwing', () => {
  assert.deepEqual(generateFacade({ levels: [] }).slots, []);
  assert.deepEqual(generateFacade({}).slots, []);
});

test('a battered tower still gets windows on every storey', () => {
  const out = generateFacade({
    levels: stackMass({
      footprint: SQUARE, levelCount: 5,
      profile: { mode: MASS_PROFILE.BATTER, amount: 1.5 },
    }).levels,
    seed: 7,
  });
  assert.equal(new Set(out.slots.map(s => s.floorIndex)).size, 5);
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`facade.test.mjs: ${passed} passed`);
