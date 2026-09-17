// node mcp/building.test.mjs
//
// The agent-facing surface of the building vocabulary, tested through the REAL
// registered handlers rather than a copy of their logic - a stub server captures
// the registrations and the tests call what the MCP client would call.
//
// WHY THIS FILE EXISTS. The catalog tool is generic over CATALOG, so a new node
// property reaches an agent for free; nothing else here is. A new field on a
// reference, or a wiring shape the tools cannot express, is invisible from the
// outside: the tool answers, the document compiles, and the thing the agent
// asked for is quietly not there. Both had actually happened - the second tiling
// axis had no input at all, and a Merge could not be reached, which meant no
// agent could build a tower, a porch or a cross gable.

import assert from 'node:assert/strict';
import { registerBuildingTools } from './tools/building.js';

// COLLECTED THEN RUN. toolHandler wraps every handler in an async function, so a
// test that calls one is async, and the synchronous `test()` the other files use
// would count a rejected promise as a pass.
let passed = 0;
const queued = [];
function test(name, fn) { queued.push([name, fn]); }

const tools = new Map();
registerBuildingTools(
  { registerTool: (name, _spec, handler) => tools.set(name, handler) },
  { api: {}, notifyMutation: () => {} },
);

/** Call a tool the way the MCP client does, unwrapping its result envelope. */
async function call(name, args) {
  const out = await tools.get(name)(args, {});
  const text = out?.content?.[0]?.text;
  // An error is PLAIN TEXT, not JSON - parsing it as JSON turns a clear message
  // into "Unexpected non-whitespace character".
  if (out?.isError) throw new Error(text || 'tool error');
  return text ? JSON.parse(text) : out;
}

const RECT = (x0, y0, x1, y1) => ({ outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });

const hall = () => call('create_building_graph', {
  name: 'Test Hall',
  shape: RECT(0, 0, 14, 8),
  stages: [
    { type: 'mass', props: { levelCount: 1, groundHeight: 4 } },
    { type: 'facade', modes: { opening: 'arch' } },
    { type: 'roof', modes: { kind: 'gable' }, props: { pitch: 55 } },
  ],
});

// --- the catalog reaches every property --------------------------------------

test('the catalog reports the roof properties an eave needs', async () => {
  const roof = (await call('describe_building_catalog', { type: 'roof' })).nodes[0];
  const names = roof.props.map(prop => prop.name);
  for (const needed of ['eave', 'eaveDrop', 'pitch', 'maxHeight']) {
    assert.ok(names.includes(needed), `the catalog never mentions "${needed}"`);
  }
  // And says WHEN each one means anything, which is the difference between a
  // property that does nothing and a typo.
  const eave = roof.props.find(prop => prop.name === 'eave');
  assert.deepEqual(eave.onlyWhen, { kind: ['hip', 'mansard', 'gable', 'shed'] });
  assert.equal(eave.default, 0, 'an eave that defaults to something re-shapes every saved roof');
});

// --- a second volume ----------------------------------------------------------

test('a wing joins a second volume, and it keeps its own roof', async () => {
  // The whole point: a Mass has ONE roof, so a tower beside a hall is a second
  // body merged in, not a second Roof node chained on.
  const base = await hall();
  assert.equal(base.ok, true, JSON.stringify(base.summary.diagnostics));
  assert.equal(base.summary.roofs.length, 1);

  const withTower = await call('add_building_wing', {
    graph: base.graph,
    shape: RECT(14, 2, 18, 6),
    stages: [
      { type: 'mass', props: { levelCount: 3 } },
      { type: 'roof', modes: { kind: 'hip' }, props: { pitch: 66 } },
    ],
  });
  assert.equal(withTower.ok, true, JSON.stringify(withTower.summary.diagnostics));
  assert.equal(withTower.summary.roofs.length, 2, 'the wing brought no roof of its own');
  assert.ok(
    withTower.summary.edges.some(edge => edge.startsWith(`${withTower.wing.merge}:out ->`)),
    'the Merge does not feed the Output',
  );
});

test('wings nest, so a third volume keeps the first two', async () => {
  const two = await call('add_building_wing', {
    graph: (await hall()).graph,
    shape: RECT(14, 2, 18, 6),
    stages: [{ type: 'mass' }, { type: 'roof', modes: { kind: 'hip' } }],
  });
  const three = await call('add_building_wing', {
    graph: two.graph,
    shape: RECT(1, -3, 13, 0),
    stages: [
      { type: 'mass', props: { levelCount: 1, groundHeight: 3 } },
      { type: 'roof', modes: { kind: 'shed', ridge: 'long' }, props: { pitch: 30 } },
    ],
  });
  assert.equal(three.ok, true, JSON.stringify(three.summary.diagnostics));
  assert.equal(three.summary.roofs.length, 3);
  const ids = three.summary.nodes.map(node => node.id);
  assert.equal(new Set(ids).size, ids.length, 'a wing reused a node id already in the document');
});

test('a Merge cannot be listed as a stage, and says why', async () => {
  // Reaching for a Merge by hand wires its first input and leaves the second
  // dangling, which compiles to a hard error. Both tools refuse it instead.
  const base = (await hall()).graph;
  for (const tool of ['create_building_graph', 'add_building_wing']) {
    await assert.rejects(
      () => call(tool, { graph: base, stages: [{ type: 'merge' }] }),
      /created for you/,
      `${tool} accepted a Merge stage`,
    );
  }
});

test('a wing needs something to join, and says so', async () => {
  await assert.rejects(
    () => call('add_building_wing', {
      graph: { nodes: [], edges: [] }, stages: [{ type: 'mass' }],
    }),
    /Output/,
  );
});

// --- references ---------------------------------------------------------------

test('both tiling axes can be bound, and read back', async () => {
  const bound = await call('set_building_reference', {
    graph: (await hall()).graph,
    slot: 'tex_roof',
    assetId: 4242,
    kind: 'image',
    tileMetres: 3,
    tileMetresY: 2.4,
  });
  const entry = bound.summary.references.find(ref => ref.slot.startsWith('tex_roof'));
  assert.equal(entry.tileMetres, 3);
  assert.equal(entry.tileMetresY, 2.4, 'the second axis did not survive the round trip');
});

test('a square tile carries one number, as it always did', async () => {
  const bound = await call('set_building_reference', {
    graph: (await hall()).graph, slot: 'tex_wall', assetId: 4243, kind: 'image', tileMetres: 2.2,
  });
  const entry = bound.summary.references.find(ref => ref.slot.startsWith('tex_wall'));
  assert.equal(entry.tileMetres, 2.2);
  assert.equal('tileMetresY' in entry, false);
});

test('a model keeps its rotation and takes no tile', async () => {
  const bound = await call('set_building_reference', {
    graph: (await hall()).graph,
    slot: 'mesh_arch',
    assetId: 4244,
    kind: 'mesh',
    rotation: [0, 45, 0],
    tileMetres: 3,
  });
  const entry = bound.summary.references.find(ref => ref.slot.startsWith('mesh_arch'));
  assert.deepEqual(entry.rotation, [0, 45, 0]);
  assert.equal('tileMetres' in entry, false, 'a model was given a tile size');
});

// --- the properties actually do something ------------------------------------

test('an eave set through the tools lowers the roof off the wall head', async () => {
  // Reachable is not the same as working: the eave has to travel all the way to
  // the compiler, and the roof base is where it shows.
  const shape = RECT(0, 0, 14, 10);
  const stages = props => [{ type: 'mass' }, { type: 'roof', modes: { kind: 'hip' }, props }];
  const plain = await call('create_building_graph', { shape, stages: stages({ pitch: 30 }) });
  const eaved = await call('create_building_graph', {
    shape, stages: stages({ pitch: 30, eave: 1.5, eaveDrop: 0.4 }),
  });
  const drop = plain.summary.roofs[0].baseZ - eaved.summary.roofs[0].baseZ;
  // 1.5m of eave at 30 degrees is 0.87m, plus a 0.4m fascia.
  assert.ok(Math.abs(drop - (1.5 * Math.tan(Math.PI / 6) + 0.4)) < 0.05,
    `the eave moved the roof base by ${drop.toFixed(3)}m`);
});

for (const [name, fn] of queued) {
  try { await fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

if (process.exitCode) console.error(`\n${passed} passed, failures above.`);
else console.log(`building.test.mjs: ${passed} passed`);
