// node building/random.test.mjs
//
// The tests that matter here are not "is the PRNG uniform" - vfx/random.test.mjs
// already pins PCG32 against its published vectors. These test the BUILDING
// property: that editing one thing does not reshuffle everything else. That is
// the difference between a tool that feels solid and one that feels broken, and
// it is not observable from the PRNG alone.

import assert from 'node:assert/strict';
import {
  chanceAt, digest, digestFloat, hashString, instanceSeed, intRangeAt,
  randomAt, rangeAt, slotId, weightedPick,
} from './random.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const SEED = 12345;

// Every window of a building, as the compiler would address them.
function facade(seed, slot, { floors, bays, faces = 4 }) {
  const out = [];
  for (let face = 0; face < faces; face++) {
    for (let floor = 0; floor < floors; floor++) {
      for (let bay = 0; bay < bays; bay++) {
        out.push({ face, floor, bay, value: randomAt(seed, slot, { face, floor, bay }) });
      }
    }
  }
  return out;
}

// --- the headline property --------------------------------------------------

test('ADDING A FLOOR DOES NOT RESHUFFLE THE WINDOWS BELOW IT', () => {
  // The single reason this module exists. A stream-walking RNG fails this.
  const slot = slotId('node-window', 'variant');
  const before = facade(SEED, slot, { floors: 6, bays: 5 });
  const after = facade(SEED, slot, { floors: 7, bays: 5 });

  const key = w => `${w.face}/${w.floor}/${w.bay}`;
  const lookup = new Map(after.map(w => [key(w), w.value]));

  for (const w of before) {
    assert.equal(lookup.get(key(w)), w.value,
      `window ${key(w)} changed when a 7th floor was added`);
  }
});

test('REMOVING A FLOOR DOES NOT RESHUFFLE THE REST', () => {
  const slot = slotId('node-window', 'variant');
  const tall = facade(SEED, slot, { floors: 10, bays: 4 });
  const short = facade(SEED, slot, { floors: 3, bays: 4 });
  const key = w => `${w.face}/${w.floor}/${w.bay}`;
  const lookup = new Map(tall.map(w => [key(w), w.value]));
  for (const w of short) assert.equal(lookup.get(key(w)), w.value, `window ${key(w)} moved`);
});

test('INSERTING A NODE DOES NOT CHANGE WHAT OTHER NODES DRAW', () => {
  // Rule 3. A per-draw counter would fail this: every node after the insertion
  // point would shift, which reads as "editing one thing broke everything else".
  const windowSlot = slotId('node-window', 'variant');
  const before = randomAt(SEED, windowSlot, { face: 1, floor: 2, bay: 3 });

  // Simulate inserting an unrelated node into the graph: it gets its own slot,
  // and the existing node's slot is derived from its OWN id, not its position.
  const insertedSlot = slotId('node-inserted', 'amount');
  assert.notEqual(insertedSlot, windowSlot, 'distinct nodes must get distinct slots');

  const after = randomAt(SEED, windowSlot, { face: 1, floor: 2, bay: 3 });
  assert.equal(after, before);
});

test('two properties of the SAME node draw independently', () => {
  const a = slotId('node-window', 'variant');
  const b = slotId('node-window', 'jitter');
  assert.notEqual(a, b);
  const id = { face: 0, floor: 0, bay: 0 };
  assert.notEqual(randomAt(SEED, a, id), randomAt(SEED, b, id));
});

// --- identity independence --------------------------------------------------

test('face and bay do not collide when swapped', () => {
  // The failure: "the window on the north wall is identical to the one on the
  // east wall", which looks like a repeating pattern rather than a bug.
  const slot = slotId('n', 'p');
  assert.notEqual(
    randomAt(SEED, slot, { face: 1, floor: 0, bay: 0 }),
    randomAt(SEED, slot, { face: 0, floor: 0, bay: 1 }),
  );
});

test('every axis of identity actually moves the result', () => {
  const slot = slotId('n', 'p');
  const base = { face: 2, floor: 3, bay: 4, sub: 0 };
  const v = randomAt(SEED, slot, base);
  for (const axis of ['face', 'floor', 'bay', 'sub']) {
    const moved = { ...base, [axis]: base[axis] + 1 };
    assert.notEqual(randomAt(SEED, slot, moved), v, `${axis} had no effect`);
  }
});

test('sub keeps sill, window and lintel in one bay apart', () => {
  const slot = slotId('n', 'p');
  const at = sub => randomAt(SEED, slot, { face: 0, floor: 1, bay: 2, sub });
  assert.notEqual(at(0), at(1));
  assert.notEqual(at(1), at(2));
});

test('a missing identity field defaults to zero', () => {
  const slot = slotId('n', 'p');
  assert.equal(
    instanceSeed(SEED, slot, { floor: 3 }),
    instanceSeed(SEED, slot, { face: 0, floor: 3, bay: 0, sub: 0 }),
  );
  assert.equal(instanceSeed(SEED, slot), instanceSeed(SEED, slot, {}));
});

test('changing the document seed changes everything', () => {
  const slot = slotId('n', 'p');
  const id = { face: 1, floor: 1, bay: 1 };
  assert.notEqual(randomAt(1, slot, id), randomAt(2, slot, id));
});

// --- the string hash --------------------------------------------------------

test('hashString avalanches on near-identical node ids', () => {
  // Real ids share a prefix and differ in the last characters. A weak hash
  // collides exactly there, and the symptom is two facades that are twins.
  const ids = ['node-mtvb5ip8-3a', 'node-mtvb5ip8-3b', 'node-mtvb5ip8-3c',
               'node-mtvb5ip8-4a', 'node-mtvb5ip9-3a'];
  const seen = new Set(ids.map(hashString));
  assert.equal(seen.size, ids.length, 'hash collision between similar ids');
});

test('hashString is stable and handles empty input', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.equal(hashString(''), hashString(null));
  assert.ok(Number.isInteger(hashString('x')) && hashString('x') >= 0);
});

test('slotId is order-sensitive', () => {
  assert.notEqual(slotId('a', 'b'), slotId('b', 'a'));
});

// --- draw helpers -----------------------------------------------------------

test('randomAt stays in [0, 1)', () => {
  const slot = slotId('n', 'p');
  for (let i = 0; i < 500; i++) {
    const v = randomAt(SEED, slot, { face: i % 7, floor: i % 13, bay: i });
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('rangeAt spans the requested interval', () => {
  const slot = slotId('n', 'p');
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 800; i++) {
    const v = rangeAt(SEED, slot, { bay: i }, 2.5, 4.5);
    assert.ok(v >= 2.5 && v < 4.5, `out of range: ${v}`);
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  assert.ok(lo < 2.7 && hi > 4.3, `poor coverage: ${lo}..${hi}`);
});

test('intRangeAt is inclusive at both ends', () => {
  const slot = slotId('n', 'p');
  const seen = new Set();
  for (let i = 0; i < 800; i++) seen.add(intRangeAt(SEED, slot, { bay: i }, 1, 4));
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4]);
});

test('intRangeAt collapses a degenerate range', () => {
  const slot = slotId('n', 'p');
  assert.equal(intRangeAt(SEED, slot, {}, 3, 3), 3);
  assert.equal(intRangeAt(SEED, slot, {}, 5, 2), 5);
});

test('chanceAt honours its probability', () => {
  const slot = slotId('n', 'p');
  let hits = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) if (chanceAt(SEED, slot, { bay: i }, 0.25)) hits++;
  assert.ok(Math.abs(hits / N - 0.25) < 0.05, `p=0.25 gave ${hits / N}`);
  for (let i = 0; i < 50; i++) {
    assert.equal(chanceAt(SEED, slot, { bay: i }, 0), false);
    assert.equal(chanceAt(SEED, slot, { bay: i }, 1), true);
  }
});

test('weightedPick respects weights', () => {
  const slot = slotId('n', 'p');
  const counts = [0, 0, 0];
  const N = 3000;
  for (let i = 0; i < N; i++) counts[weightedPick(SEED, slot, { bay: i }, [1, 3, 0])]++;
  assert.equal(counts[2], 0, 'a zero weight must never be chosen');
  assert.ok(counts[1] > counts[0] * 2, `expected ~3:1, got ${counts[0]}:${counts[1]}`);
});

test('weightedPick treats a missing weight as 1', () => {
  // A style pack that lists variants without weighting them gets a uniform pick.
  const slot = slotId('n', 'p');
  const counts = [0, 0];
  for (let i = 0; i < 2000; i++) counts[weightedPick(SEED, slot, { bay: i }, [undefined, undefined])]++;
  assert.ok(Math.abs(counts[0] - counts[1]) < 200, `uneven: ${counts}`);
});

test('weightedPick handles empty and all-zero lists', () => {
  const slot = slotId('n', 'p');
  assert.equal(weightedPick(SEED, slot, {}, []), -1);
  assert.equal(weightedPick(SEED, slot, {}, [0, 0]), 0);
});

test('digest is stable and seed-sensitive', () => {
  assert.equal(digest(SEED, 'facade.upper'), digest(SEED, 'facade.upper'));
  assert.notEqual(digest(SEED, 'facade.upper'), digest(SEED, 'facade.ground'));
  assert.notEqual(digest(1, 'x'), digest(2, 'x'));
  const f = digestFloat(SEED, 'x');
  assert.ok(f >= 0 && f < 1);
});

// --- determinism across process boundaries ---------------------------------

test('the same identity gives the same number every time', () => {
  // A stored building must regenerate bit-for-bit, in the browser and in Node.
  const slot = slotId('node-window', 'variant');
  const id = { face: 2, floor: 5, bay: 3 };
  const runs = new Set();
  for (let i = 0; i < 10; i++) runs.add(randomAt(SEED, slot, id));
  assert.equal(runs.size, 1);
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`random.test.mjs: ${passed} passed`);
