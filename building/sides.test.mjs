// node building/sides.test.mjs
//
// A side has to mean the same thing on every compile, or a building's materials
// shuffle between two runs of the same document.

import assert from 'node:assert/strict';
import { SIDE, SIDE_LABEL, SIDE_ORDER, isSide, sideOfEdge, sideOfNormal } from './sides.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

test('the cardinal normals land on the cardinal sides', () => {
  assert.equal(sideOfNormal(1, 0), SIDE.EAST);
  assert.equal(sideOfNormal(0, 1), SIDE.NORTH);
  assert.equal(sideOfNormal(-1, 0), SIDE.WEST);
  assert.equal(sideOfNormal(0, -1), SIDE.SOUTH);
});

test('a wall a little off north is still north', () => {
  for (const nx of [-0.4, -0.2, 0, 0.2, 0.4]) {
    assert.equal(sideOfNormal(nx, 1), SIDE.NORTH, `nx=${nx}`);
  }
});

test('exactly 45 degrees resolves the SAME WAY every time', () => {
  // The whole reason the comparison is >= rather than >. A diagonal wall that
  // landed on north in one compile and east in the next would move a texture
  // between two builds of an unedited document.
  const d = Math.SQRT1_2;
  assert.equal(sideOfNormal(d, d), SIDE.EAST);
  assert.equal(sideOfNormal(d, d), sideOfNormal(d, d));
  assert.equal(sideOfNormal(-d, d), SIDE.WEST);
  assert.equal(sideOfNormal(d, -d), SIDE.EAST);
  assert.equal(sideOfNormal(-d, -d), SIDE.WEST);
});

test('a degenerate normal still names a side rather than undefined', () => {
  // A zero-length edge should never reach here, but a side of `undefined` would
  // silently match no material selector and draw the wall in the fallback.
  for (const bad of [[0, 0], [NaN, 1], [1, NaN], [null, null]]) {
    assert.ok(isSide(sideOfNormal(bad[0], bad[1])), JSON.stringify(bad));
  }
});

test('a counter-clockwise square faces outward on all four sides', () => {
  // The ring convention every other file uses: outer CCW, and (dy, -dx) points
  // away from the solid. Get this backwards and every building is textured
  // inside out.
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const sides = ring.map((a, i) => sideOfEdge(a, ring[(i + 1) % ring.length]));
  assert.deepEqual(sides, [SIDE.SOUTH, SIDE.EAST, SIDE.NORTH, SIDE.WEST]);
  assert.equal(new Set(sides).size, 4, 'two edges of a square landed on one side');
});

test('a clockwise hole faces into the courtyard', () => {
  // Holes are stored clockwise, and walking them as stored gives the face a
  // person standing in the courtyard actually sees.
  // Walked edge by edge: the x=0 wall's face points EAST, back at someone
  // standing in the courtyard; the y=10 wall's points SOUTH at them; and so on
  // round. That is the outward-from-the-solid direction, which is what every
  // other file means by a wall's normal.
  const hole = [[0, 0], [0, 10], [10, 10], [10, 0]];
  const sides = hole.map((a, i) => sideOfEdge(a, hole[(i + 1) % hole.length]));
  assert.deepEqual(sides, [SIDE.EAST, SIDE.SOUTH, SIDE.WEST, SIDE.NORTH]);
  assert.equal(new Set(sides).size, 4);
});

test('every side has an order entry and a label', () => {
  assert.equal(SIDE_ORDER.length, 4);
  for (const side of Object.values(SIDE)) {
    assert.ok(SIDE_ORDER.includes(side), `${side} is missing from SIDE_ORDER`);
    assert.ok(SIDE_LABEL[side], `${side} has no label`);
  }
  assert.equal(isSide(''), false, 'the wildcard must not be a side');
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`sides.test.mjs: ${passed} passed`);
