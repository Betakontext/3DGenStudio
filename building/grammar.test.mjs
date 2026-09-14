// node building/grammar.test.mjs
//
// The plan calls the split grammar make-or-break, and the two claims it has to
// support are here: integer snapping on repeats, and one rule fitting any wall
// width without stretching what should not stretch.

import assert from 'node:assert/strict';
import {
  MAX_REPEAT, SIZE, STRETCH, bayParts, placeInCell, repeatCount, splitSpan,
  storeyParts, tileSpan,
} from './grammar.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const abs = v => ({ size: { kind: SIZE.ABS, v } });
const rel = v => ({ size: { kind: SIZE.REL, v } });
const flt = (v = 1) => ({ size: { kind: SIZE.FLOAT, v } });
const sizes = result => result.cells.map(c => Math.round(c.size * 1e6) / 1e6);

// --- sizing ------------------------------------------------------------------

test('absolute parts keep their measurements whatever the span', () => {
  for (const span of [4, 10, 40]) {
    const out = splitSpan(span, [abs(0.6), flt(), abs(0.6)]);
    assert.equal(out.cells[0].size, 0.6);
    assert.equal(out.cells[2].size, 0.6);
    assert.equal(out.cells[1].size, span - 1.2, `span ${span}`);
  }
});

test('relative parts are a fraction of the WHOLE span', () => {
  const out = splitSpan(10, [rel(0.25), flt()]);
  assert.deepEqual(sizes(out), [2.5, 7.5]);
});

test('float parts share what is left, by weight', () => {
  const out = splitSpan(10, [abs(2), flt(1), flt(3)]);
  assert.deepEqual(sizes(out), [2, 2, 6]);
});

test('a lone float takes everything', () => {
  assert.deepEqual(sizes(splitSpan(7.5, [flt()])), [7.5]);
});

test('parts always sum to exactly the span', () => {
  // A hairline gap at a corner is the visible consequence of not doing this.
  for (const span of [13.4, 3.333333, 0.7, 101.25]) {
    const out = splitSpan(span, [abs(0.6), flt(), flt(2), abs(0.35)]);
    const total = out.cells.reduce((s, c) => s + c.size, 0);
    assert.equal(total, span, `span ${span} summed to ${total}`);
    // And they must tile with no overlap.
    for (let i = 1; i < out.cells.length; i++) {
      assert.ok(Math.abs(out.cells[i].start - (out.cells[i - 1].start + out.cells[i - 1].size)) < 1e-9);
    }
  }
});

test('over-subscribed fixed parts are scaled down, not overflowed', () => {
  // A facade rule meets the short return of an L-plan all the time. A squashed
  // bay keeps the building intact; a bay hanging off the end does not.
  const out = splitSpan(2, [abs(1.5), abs(1.5)]);
  assert.equal(out.overflowed, true);
  assert.deepEqual(sizes(out), [1, 1]);
  assert.equal(out.cells.reduce((s, c) => s + c.size, 0), 2);
});

test('over-subscription keeps the proportions between fixed parts', () => {
  const out = splitSpan(3, [abs(3), abs(1)]);
  assert.equal(out.overflowed, true);
  assert.deepEqual(sizes(out), [2.25, 0.75]);
});

test('a degenerate span yields nothing rather than negative cells', () => {
  for (const span of [0, -5, NaN, undefined]) {
    assert.deepEqual(splitSpan(span, [flt()]).cells, []);
  }
  assert.deepEqual(splitSpan(10, []).cells, []);
  assert.deepEqual(splitSpan(10, null).cells, []);
});

test('a malformed part degrades to a float rather than NaN', () => {
  const out = splitSpan(10, [{ size: { kind: 'nonsense', v: 'wide' } }, flt()]);
  assert.ok(out.cells.every(c => Number.isFinite(c.size)));
  assert.equal(out.cells.reduce((s, c) => s + c.size, 0), 10);
});

// --- INTEGER SNAPPING --------------------------------------------------------

test('repeatCount ROUNDS, so no wall ends in a stub', () => {
  // The headline rule. 13.4m at a 3m nominal bay is four bays of 3.35m - not
  // four of 3m and a 1.4m remainder, which is the classic generated-architecture
  // tell.
  assert.equal(repeatCount(13.4, 3), 4);
  assert.equal(repeatCount(12, 3), 4);
  assert.equal(repeatCount(5.9, 3), 2, 'two 2.95m bays beat one 5.9m bay');
  assert.equal(repeatCount(1.6, 3), 1, 'never fewer than one');
});

test('tileSpan divides the span EXACTLY between whole cells', () => {
  const out = tileSpan(13.4, 3);
  assert.equal(out.count, 4);
  assert.equal(out.size, 13.4 / 4);
  assert.equal(out.cells.length, 4);
  // No half bay at the end: the last cell must finish flush with the wall.
  const last = out.cells[3];
  assert.ok(Math.abs(last.start + last.size - 13.4) < 1e-9);
  for (const cell of out.cells) assert.equal(cell.size, out.size);
});

test('tileSpan starts are computed, not accumulated', () => {
  // Forty additions of 0.3333 drift; index * size does not.
  const out = tileSpan(40 / 3, 1 / 3);
  const last = out.cells[out.cells.length - 1];
  assert.equal(last.start, (out.count - 1) * out.size);
});

test('repeat counts are clamped both ways', () => {
  assert.equal(repeatCount(100, 3, { max: 6 }), 6);
  assert.equal(repeatCount(3, 3, { min: 4 }), 4);
  assert.equal(repeatCount(1e9, 0.01), MAX_REPEAT, 'a runaway count is capped');
});

test('a nominal of zero does not divide by zero', () => {
  assert.equal(repeatCount(10, 0), 1);
  assert.equal(tileSpan(10, 0).count, 1);
  assert.equal(tileSpan(0, 3).count, 0);
});

// --- THE STRETCH RULE --------------------------------------------------------

test('a NONE part keeps its natural size and centres in the cell', () => {
  // The claim that one rule dresses any wall: the window stays 1.2m whether the
  // bay came out at 3m or 3.35m, and the slack goes into the wall beside it.
  for (const cellSize of [3, 3.35, 4.8]) {
    const placed = placeInCell({ start: 10, size: cellSize },
      { stretch: STRETCH.NONE, natural: 1.2 });
    assert.equal(placed.size, 1.2, `cell ${cellSize} stretched the window`);
    // Centred: equal wall either side.
    assert.ok(Math.abs((placed.start - 10) - (cellSize - 1.2) / 2) < 1e-9);
  }
});

test('a FILL part takes the whole cell', () => {
  const placed = placeInCell({ start: 2, size: 3.35 }, { stretch: STRETCH.FILL, natural: 1.2 });
  assert.equal(placed.start, 2);
  assert.equal(placed.size, 3.35);
});

test('a natural size larger than its cell is clamped, and says so', () => {
  // A 2m door in a 1.4m bay must not poke through the pier beside it.
  const placed = placeInCell({ start: 0, size: 1.4 }, { stretch: STRETCH.NONE, natural: 2 });
  assert.equal(placed.size, 1.4);
  assert.equal(placed.clamped, true);
  assert.equal(placed.start, 0);
});

test('a NONE part with no natural size falls back to filling', () => {
  const placed = placeInCell({ start: 0, size: 3 }, { stretch: STRETCH.NONE, natural: 0 });
  assert.equal(placed.size, 3);
});

// --- the composed rules the Facade node uses ---------------------------------

test('ONE BAY RULE FITS ANY WALL: piers stay put, wall absorbs the slack', () => {
  // The end-to-end statement of the whole file.
  const parts = bayParts({ pierWidth: 0.6 });
  for (const wall of [7, 13.4, 31.7]) {
    const { cells, size } = tileSpan(wall, 3);
    for (const bay of cells) {
      const split = splitSpan(bay.size, parts);
      assert.equal(split.cells[0].size, 0.3, 'the pier half must not scale');
      assert.equal(split.cells[2].size, 0.3);
      const opening = placeInCell(split.cells[1], { stretch: STRETCH.NONE, natural: 1.2 });
      assert.equal(opening.size, 1.2, `wall ${wall} stretched the opening`);
    }
    assert.ok(Math.abs(size * cells.length - wall) < 1e-9);
  }
});

test('storeyParts gives a taller opening on a taller storey, unasked', () => {
  // The sill and lintel are construction dimensions; the opening floats.
  const parts = storeyParts({ sillHeight: 0.9, lintelHeight: 0.5 });
  const ground = splitSpan(4, parts);
  const upper = splitSpan(3, parts);
  assert.equal(ground.cells[0].size, 0.9);
  assert.equal(upper.cells[0].size, 0.9, 'the sill does not scale with the storey');
  assert.equal(ground.cells[1].size, 4 - 1.4);
  assert.equal(upper.cells[1].size, 3 - 1.4);
  assert.ok(ground.cells[1].size > upper.cells[1].size);
});

test('a storey shorter than its sill and lintel squashes rather than inverting', () => {
  const out = splitSpan(1, storeyParts({ sillHeight: 0.9, lintelHeight: 0.5 }));
  assert.equal(out.overflowed, true);
  assert.ok(out.cells.every(c => c.size >= 0), 'no negative cell');
  assert.equal(out.cells.reduce((s, c) => s + c.size, 0), 1);
});

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`grammar.test.mjs: ${passed} passed`);
