// Style packs: the same graph, a different building.
//
// THE SPLIT THIS FILE EXISTS TO ENFORCE. The node graph describes STRUCTURE - a
// mass, storeys, bays, slots tagged window/door/pillar - and knows nothing about
// Rome or Tenochtitlan. A style pack supplies the VOCABULARY that turns that
// structure into a particular kind of building. Keeping them apart is what lets
// one graph serve ten style families instead of fragmenting into ten graphs.
//
// THE THING MOST PACK FORMATS GET WRONG is treating style as ornament: a texture
// swap on top of a shape that never changes. It does not work, and the reason is
// visible in the plan for this feature - Egyptian walls BATTER inward, Mayan
// platforms STEP, Medieval upper floors JETTY out, Roman villas wrap a
// COURTYARD. Those are massing decisions. A pack that could only repaint would
// produce ten differently-coloured versions of the same box, which is precisely
// the failure this whole design is arranged to avoid.
//
// So a pack carries three things, and the first is the one that matters most:
//
//   graph       an ordered recipe of stages between the Footprint and the
//               Output - what mass profile, what facades, what roof.
//   palette     the colours the preview draws until real assets exist.
//   vocabulary  which asset fills each slot type. Phase 6 fills this in; the
//               format is validated here so there is somewhere for it to land.
//
// THE RECIPE IS RESTRICTED TO THE EXISTING CATALOG, and validateStylePack
// enforces it. That restriction is the whole falsification test: if Egyptian or
// Mayan cannot be written as data against the nodes that already exist, a pack
// for them will not validate, and that is a signal to fix the abstraction rather
// than to bolt on a style-specific node. A pack that needs new code is a bug in
// the vocabulary, not a feature of the style.
//
// A PACK IS NOT A LIVE BINDING. Applying one WRITES into the document - node
// props, modes, a palette snapshot - and then gets out of the way. The author
// can edit every value afterwards, and a building saved today still opens the
// same way after the shipped pack is revised, because nothing is resolved at
// compile time from a file on disk. `building.stylePackId` records where the
// settings came from; it is provenance, not a dependency.

import { CATALOG, coerceProp, createNode, getNodeDef } from './catalog.js';
import { normalizeBuildingDoc } from './doc.js';

/**
 * Pack format version. Bump when a consumer written against the previous version
 * would MISREAD this one - see ir.js for the same rule and the same reasoning.
 */
export const STYLE_PACK_FORMAT = 1;

/** Ids are filenames: the directory is the index, so they must be path-safe. */
export const STYLE_PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * The palette keys the preview draws with.
 *
 * Deliberately few, and named for what they ARE rather than where they go: a
 * pack author picks six colours, not a material graph. Phase 6 replaces these
 * with generated textures, and the keys carry over as the albedo slot names.
 */
export const PALETTE_SLOTS = ['wall', 'trim', 'roof', 'opening', 'door', 'accent'];

/**
 * The palette slots a TEXTURE can be bound to, and the reference key each uses.
 *
 * `accent` is absent on purpose: it colours the storey outlines, which are lines
 * and cannot carry an image. Offering a slot that silently does nothing is the
 * failure this whole feature keeps having to fix.
 */
export const TEXTURE_SLOTS = ['wall', 'trim', 'roof', 'opening', 'door'];

/** The doc.references key a BUILDING-WIDE texture slot binds through. Invariant 3. */
export function textureKey(slot) {
  return `tex_${slot}`;
}

/**
 * The key a per-node texture binds through, optionally for one side.
 *
 * KEYED ON THE NODE ID, which is the house pattern - vfx/doc.js invariant 3 does
 * the same for a block's own assets. It means deleting the node leaves its
 * texture keys behind, which is exactly what danglingReferences is for and is
 * far better than the alternative: keying on what the node covers, where editing
 * "floors 2-4" to "floors 2-5" would silently drop the binding.
 *
 * Reads as `<nodeId>.wall`, `<nodeId>.opening.north`, `<nodeId>.trim`.
 */
export function nodeTextureKey(nodeId, slot, side = '') {
  return side ? `${nodeId}.${slot}.${side}` : `${nodeId}.${slot}`;
}

/**
 * The slots a Facade node can override.
 *
 * Only two, and not the other three: a Facade node claims STOREYS and dresses
 * their openings, so a wall and an opening are things it can speak for. A roof
 * and a plinth are not - they belong to the Roof and Trim nodes, and offering
 * them here would be a control that silently does nothing.
 */
export const FACADE_TEXTURE_SLOTS = ['wall', 'opening'];

/**
 * What a Trim node can override: its own run, and only as a whole.
 *
 * NO PER-SIDE VARIANT, unlike a facade, and for a geometric reason rather than a
 * scoping one. A trim run is ONE closed loop that mitres at every corner - see
 * trim.js - so a material change part-way round would fall in the middle of a
 * mitred joint, where two sections meet as one solid. Splitting a facade by side
 * is clean because walls already end at the corners; splitting a cornice is not.
 */
export const TRIM_TEXTURE_SLOT = 'trim';

/** Which vocabulary slots a pack may declare. Mirrors ir.js SLOT_TYPE plus trim. */
export const VOCABULARY_SLOTS = [
  'window', 'door', 'pillar', 'cornice', 'roof_edge', 'wall', 'sign',
  'shopfront', 'arch', 'balcony', 'louvre',
];

/** What a vocabulary entry can be. `profile` is a trim section, not a mesh. */
export const VOCABULARY_KIND = { MESH: 'mesh', IMAGE: 'image', PROFILE: 'profile' };

const HEX = /^#[0-9a-f]{6}$/i;
const VOCAB_KINDS = new Set(Object.values(VOCABULARY_KIND));
const PALETTE_SET = new Set(PALETTE_SLOTS);
const VOCAB_SET = new Set(VOCABULARY_SLOTS);

const isObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);

/**
 * Stages a pack may NOT specify.
 *
 * The Footprint holds the plan the author drew by hand - a style must never
 * overwrite it, or picking a style would delete their work. The Output is a
 * singleton and is not a style decision. Everything between them is fair game.
 */
export const RESERVED_STAGES = new Set(['footprint', 'output']);

/** An empty pack, for an author starting one from scratch. */
export function createStylePack(overrides = {}) {
  return normalizeStylePack({
    format: STYLE_PACK_FORMAT,
    id: 'untitled-style',
    name: 'Untitled Style',
    category: 'Custom',
    ...overrides,
  });
}

/**
 * Coerce a pack into the shape the rest of the code assumes.
 *
 * TOTAL, like normalizeBuildingDoc: it always returns a pack. Whether that pack
 * is any good is validateStylePack's job, and keeping the two apart means the UI
 * can show a broken pack's name and problems instead of showing nothing.
 */
export function normalizeStylePack(input) {
  const raw = isObject(input) ? input : {};

  const palette = {};
  if (isObject(raw.palette)) {
    for (const slot of PALETTE_SLOTS) {
      const value = raw.palette[slot];
      if (typeof value === 'string' && HEX.test(value)) palette[slot] = value.toLowerCase();
    }
  }

  const graph = (Array.isArray(raw.graph) ? raw.graph : [])
    .map(normalizeStage)
    .filter(Boolean);

  const vocabulary = {};
  if (isObject(raw.vocabulary)) {
    for (const [slot, entries] of Object.entries(raw.vocabulary)) {
      const list = (Array.isArray(entries) ? entries : []).map(normalizeVocabEntry).filter(Boolean);
      if (list.length) vocabulary[slot] = list;
    }
  }

  return {
    format: STYLE_PACK_FORMAT,
    id: str(raw.id).toLowerCase(),
    name: str(raw.name, 'Untitled Style'),
    category: str(raw.category, 'Custom'),
    blurb: str(raw.blurb, ''),
    // What the author should understand about the style, in the pack rather than
    // in the UI, so a user-authored pack can teach as well as a shipped one.
    teach: str(raw.teach, ''),
    palette,
    graph,
    vocabulary,
  };
}

function normalizeStage(stage) {
  if (!isObject(stage)) return null;
  const type = str(stage.type);
  if (!type) return null;
  return {
    type,
    modes: isObject(stage.modes) ? { ...stage.modes } : {},
    props: isObject(stage.props) ? { ...stage.props } : {},
  };
}

function normalizeVocabEntry(entry) {
  if (!isObject(entry)) return null;
  const file = str(entry.file);
  if (!file) return null;
  const out = {
    file,
    kind: VOCAB_KINDS.has(entry.kind) ? entry.kind : VOCABULARY_KIND.MESH,
    name: str(entry.name, file),
    weight: Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 1,
  };
  // Declared size is what lets the grammar place an asset without loading it -
  // the bay width comes from the pack, not from a mesh the compiler cannot see.
  if (Number.isFinite(entry.w) && entry.w > 0) out.w = entry.w;
  if (Number.isFinite(entry.h) && entry.h > 0) out.h = entry.h;
  return out;
}

/**
 * Everything wrong with a pack, as a list of readable problems.
 *
 * Returns rather than throws, and returns ALL of them, so an author fixing a
 * hand-written pack sees the whole list instead of playing whack-a-mole. The
 * shipped packs are checked by this in a test, which is what stops a typo in a
 * mode name shipping as a style that silently does nothing.
 */
export function validateStylePack(input) {
  const pack = normalizeStylePack(input);
  const problems = [];

  if (!STYLE_PACK_ID_PATTERN.test(pack.id)) {
    problems.push(`id "${pack.id}" must be lowercase letters, digits and dashes`);
  }
  if (!pack.name) problems.push('name is empty');

  for (const [slot, value] of Object.entries(isObject(input?.palette) ? input.palette : {})) {
    if (!PALETTE_SET.has(slot)) problems.push(`palette slot "${slot}" is not a palette slot`);
    else if (!(typeof value === 'string' && HEX.test(value))) {
      problems.push(`palette.${slot} must be a #rrggbb colour, got ${JSON.stringify(value)}`);
    }
  }

  if (!pack.graph.length) problems.push('graph is empty - the pack would change nothing structural');

  pack.graph.forEach((stage, i) => {
    const where = `graph[${i}] (${stage.type})`;
    if (RESERVED_STAGES.has(stage.type)) {
      problems.push(`${where}: a pack may not specify the ${stage.type} stage`);
      return;
    }
    const def = getNodeDef(stage.type);
    if (!def) {
      // THE FALSIFICATION TEST, mechanised. A style that needs a node the
      // catalog does not have cannot be shipped as data, and that is exactly the
      // signal worth having early.
      problems.push(`${where}: no such node type. A style may only use nodes that `
        + `already exist: ${Object.keys(CATALOG).filter(t => !RESERVED_STAGES.has(t)).join(', ')}`);
      return;
    }
    for (const [key, value] of Object.entries(stage.modes)) {
      const mode = def.modes?.[key];
      if (!mode) { problems.push(`${where}: unknown mode "${key}"`); continue; }
      if (!mode.options?.some(o => o.value === value)) {
        problems.push(`${where}: mode ${key}="${value}" is not one of `
          + `${mode.options.map(o => o.value).join(', ')}`);
      }
    }
    for (const [key, value] of Object.entries(stage.props)) {
      const spec = def.props?.[key];
      if (!spec) { problems.push(`${where}: unknown property "${key}"`); continue; }
      // Out of range is a real problem rather than something to silently clamp:
      // a pack asking for a 90-degree batter meant something, and quietly
      // building a 60-degree one hides the mistake from its author.
      if (Number.isFinite(spec.min) && Number.isFinite(value) && value < spec.min) {
        problems.push(`${where}: ${key}=${value} is below the minimum ${spec.min}`);
      }
      if (Number.isFinite(spec.max) && Number.isFinite(value) && value > spec.max) {
        problems.push(`${where}: ${key}=${value} is above the maximum ${spec.max}`);
      }
    }
  });

  const singletons = new Map();
  for (const stage of pack.graph) {
    const def = getNodeDef(stage.type);
    if (!def?.singleton) continue;
    singletons.set(stage.type, (singletons.get(stage.type) || 0) + 1);
  }
  for (const [type, count] of singletons) {
    if (count > 1) problems.push(`graph has ${count} ${type} stages but only one is allowed`);
  }

  for (const [slot, entries] of Object.entries(isObject(input?.vocabulary) ? input.vocabulary : {})) {
    if (!VOCAB_SET.has(slot)) problems.push(`vocabulary slot "${slot}" is not a slot type`);
    if (!Array.isArray(entries) || !entries.length) {
      problems.push(`vocabulary.${slot} is empty`);
    }
  }

  return problems;
}

/** The fields a list needs, without the graph or the vocabulary. */
export function stylePackSummary(input) {
  const pack = normalizeStylePack(input);
  return {
    id: pack.id,
    name: pack.name,
    category: pack.category,
    blurb: pack.blurb,
    palette: pack.palette,
    stageCount: pack.graph.length,
    assetCount: packAssetNeeds(pack).length,
  };
}

/**
 * The assets a pack wants but does not carry.
 *
 * Phase 6 installs these into the library and rewrites the slots to
 * 'asset:<id>' strings, exactly as vfx/preset.js does - hence declaring them BY
 * FILENAME here. A pack with none is completely usable; it just draws in flat
 * palette colours, which is what every shipped pack does today.
 */
export function packAssetNeeds(input) {
  const pack = normalizeStylePack(input);
  const needs = [];
  for (const slot of VOCABULARY_SLOTS) {
    for (const entry of pack.vocabulary[slot] || []) {
      needs.push({ slot, file: entry.file, kind: entry.kind, name: entry.name });
    }
  }
  return needs;
}

/**
 * Apply a pack to a document, returning a new one.
 *
 * WHAT IS PRESERVED, and why each: the FOOTPRINT (the plan the author drew - a
 * style is not entitled to redraw it), the OUTPUT (a singleton, not a style
 * decision), the SEED (re-picking a style should not reshuffle every window),
 * and the document's name. Everything between the footprint and the output is
 * rebuilt from the recipe, because that middle IS the style.
 *
 * Pure doc -> doc, so the same call serves the editor's undo stack, a headless
 * MCP tool and a test. It never touches the network and never reads a file.
 */
export function applyStylePack(doc, input) {
  const base = normalizeBuildingDoc(doc);
  const pack = normalizeStylePack(input);
  if (validateStylePack(pack).length) return base;

  const footprint = base.nodes.find(n => n.type === 'footprint');
  const output = base.nodes.find(n => n.type === 'output');
  // Without both ends there is no chain to rebuild between, and guessing would
  // produce a graph the author did not ask for. Leave it alone and let the
  // compiler's own E_NO_FOOTPRINT / E_NO_OUTPUT say what is missing.
  if (!footprint || !output) return base;

  let counter = 0;
  const mint = type => {
    counter += 1;
    // Derived from the pack and the position rather than random, so applying the
    // same pack to the same document twice gives byte-identical output - which
    // is what makes a golden test of a shipped pack possible at all.
    return `${pack.id}-${type}-${counter}`;
  };

  const staged = pack.graph.map(stage => {
    const node = createNode(stage.type, mint(stage.type));
    const def = getNodeDef(stage.type);
    for (const [key, value] of Object.entries(stage.modes)) {
      if (def.modes?.[key]) node.modes[key] = value;
    }
    for (const [key, value] of Object.entries(stage.props)) {
      const spec = def.props?.[key];
      if (spec) node.props[key] = coerceProp(spec, value);
    }
    return node;
  });

  const chain = [footprint, ...staged, output];
  const edges = [];
  for (let i = 1; i < chain.length; i++) {
    const from = getNodeDef(chain[i - 1].type)?.outputs?.[0];
    const to = getNodeDef(chain[i].type)?.inputs?.[0];
    if (!from || !to) continue;
    edges.push({
      id: `${chain[i - 1].id}->${chain[i].id}`,
      from: { node: chain[i - 1].id, port: from.id },
      to: { node: chain[i].id, port: to.id },
    });
  }

  // Layout entries for nodes that no longer exist would accumulate forever, and
  // layout is the one part of the document nothing validates - see invariant 2.
  const keptLayout = {};
  for (const node of chain) {
    if (base.layout.nodes[node.id]) keptLayout[node.id] = base.layout.nodes[node.id];
  }

  return normalizeBuildingDoc({
    ...base,
    building: {
      ...base.building,
      stylePackId: pack.id,
      // A SNAPSHOT, not a reference. The palette is copied in so the building
      // renders identically years later whether or not the pack still exists,
      // still ships, or still has these colours.
      style: { name: pack.name, palette: { ...pack.palette } },
    },
    nodes: chain,
    edges,
    layout: { ...base.layout, nodes: keptLayout },
  });
}

/**
 * The colour to draw a surface in, with the fallbacks the preview used before
 * packs existed.
 *
 * Every call site wants "the wall colour" and none of them want to know whether
 * a style has been applied, so the defaulting lives here rather than in six
 * components drifting apart.
 */
export const DEFAULT_PALETTE = {
  wall: '#c9cdd4',
  trim: '#b4b9c2',
  roof: '#8e7a6b',
  opening: '#2f3a44',
  door: '#7a6248',
  accent: '#6d7480',
};

export function paletteOf(doc) {
  const style = doc?.building?.style;
  const palette = isObject(style?.palette) ? style.palette : {};
  const out = { ...DEFAULT_PALETTE };
  for (const slot of PALETTE_SLOTS) {
    const value = palette[slot];
    if (typeof value === 'string' && HEX.test(value)) out[slot] = value.toLowerCase();
  }
  return out;
}
