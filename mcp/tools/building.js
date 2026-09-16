import { z } from 'zod';
import { toolHandler } from '../client.js';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import {
  buildingAssetDigest, normalizeBuildingDoc, serializeBuildingDoc,
} from '../../building/doc.js';
import { compileBuilding } from '../../building/compile.js';
import { CATALOG, CATALOG_ORDER, createNode } from '../../building/catalog.js';
import { BUILDING_IR_FORMAT } from '../../building/ir.js';
import {
  PALETTE_SLOTS, applyStylePack, normalizeStylePack, validateStylePack,
} from '../../building/stylepack.js';

// Procedural buildings: the /buildings editor's documents, reachable from an agent.
//
// THE CONTRACT WORTH UNDERSTANDING BEFORE USING THESE, because it decides which
// tool to reach for and what a failure means:
//
//   THE GRAPH IS THE ASSET. A `Building` asset is a ~10-40KB JSON document
//   stored as a FILE, not as rows. It is a DAG of nodes - Footprint -> Mass ->
//   Facade -> Roof -> Trim -> Output - and reading it, patching it and writing
//   it back is the whole loop. There is no /api/buildings: it rides the ordinary
//   asset routes, exactly as VFX effects do.
//
//   ORDER IS NOT COSMETIC. A Roof Detail reads the roof under it, a Trim reads
//   it for its eave, and a Facade REPLACES the storeys it claims. A node wired
//   in the wrong place compiles clean and quietly does nothing - which is the
//   single most likely way an agent leaves a building that looks almost right.
//   compile_building reports it; read the diagnostics.
//
//   IT REFERENCES OTHER ASSETS BY SLOT, NEVER BY ID. A node says `tex_wall`;
//   `references` maps `tex_wall.0` to `asset:<id>`. Every slot holds a LIST, and
//   the compiler rolls one entry per building (a texture) or per opening (a
//   model) from the document seed. Never write an asset id into a node property.
//
//   COMPILE BEFORE YOU SAVE. compile_building is pure, fast and pure JS - no
//   GPU, no browser - and reports exactly what the editor's diagnostics strip
//   shows: a plan that cannot be used, a profile that ate the building, a facade
//   that covers no storeys, a roof with nothing to stand on.
//
//   BUILDINGS ARE LIBRARY-GLOBAL, like effects and tree presets, so there is no
//   projectId anywhere here.

const DOC_SHAPE = z.record(z.string(), z.any());

/**
 * The asset type string, LOWERCASE, and that is load-bearing.
 *
 * `getAssetSubdirectory` in storage.js matches lowercase names and falls through
 * to 'images' for anything else - without erroring. Sending 'Building' wrote the
 * document into data/assets/images/ and it would have exported into the wrong
 * directory in a .3dgp too. The editor sends this same string; matching it
 * exactly is the point.
 */
const BUILDING_TYPE = 'building';

const STYLES_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..', '..', 'resources', 'buildings', 'styles',
);

/** Summarise a compiled building the way the editor's HUD and strip do. */
function summarise(doc, compiled) {
  const ir = compiled?.ir;
  const byType = {};
  for (const slot of ir?.slots || []) byType[slot.type] = (byType[slot.type] || 0) + 1;
  return {
    name: doc.name || '',
    seed: doc.building.seed,
    stylePackId: doc.building.stylePackId || null,
    // PIPELINE ORDER, not document order, because that is the thing that
    // decides what each node sees - and the thing an agent gets wrong.
    nodes: doc.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      enabled: node.enabled !== false,
      modes: node.modes,
    })),
    edges: doc.edges.map((edge) => `${edge.from.node}:${edge.from.port} -> ${edge.to.node}:${edge.to.port}`),
    references: Object.entries(doc.references || {}).map(([slot, entry]) => ({
      slot, kind: entry.kind, ref: entry.ref, name: entry.name || '',
    })),
    stats: ir?.stats || null,
    slotsByType: byType,
    roofs: (ir?.roofs || []).map((roof) => ({
      kind: roof.kind, baseZ: roof.baseZ, height: roof.height, closed: roof.closed,
    })),
    diagnostics: compiled
      ? compiled.diagnostics.map((d) => ({
        code: d.code,
        severity: d.severity,
        message: d.message,
        nodeId: d.nodeId || '',
        hint: d.hint || '',
      }))
      : null,
  };
}

/**
 * Fetch a Building asset's record and its document file.
 *
 * TWO REQUESTS, for the reason the VFX loader spells out: the library listing
 * does not project `metadata`, and the document itself is never in either
 * response - it is a file, fetched by path.
 */
async function loadDoc(api, assetId) {
  const record = await api.apiJson('GET', '/assets/record', { query: { assetId } });
  if (!record?.filePath) throw new Error(`Asset ${assetId} has no file. Is it a Building?`);
  const response = await fetch(api.assetUrl(record.filePath));
  if (!response.ok) throw new Error(`Could not read the building file (HTTP ${response.status})`);
  return { record, doc: normalizeBuildingDoc(await response.json()) };
}

/** Every shipped style pack, read off disk. The directory IS the index. */
function readStylePacks() {
  let names = [];
  try {
    names = fs.readdirSync(STYLES_DIR).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const packs = [];
  for (const name of names.sort()) {
    try {
      const pack = normalizeStylePack(JSON.parse(fs.readFileSync(path.join(STYLES_DIR, name), 'utf8')));
      const problems = validateStylePack(pack);
      packs.push({ pack, problems, file: name });
    } catch (error) {
      packs.push({ pack: null, problems: [String(error.message || error)], file: name });
    }
  }
  return packs;
}

export function registerBuildingTools(server, { api, notifyMutation }) {
  server.registerTool('describe_building_catalog', {
    title: 'Describe the building catalog',
    description: 'Every node type, property, mode and option this build offers, with types, defaults, ranges and what each one is for. READ THIS BEFORE WRITING A GRAPH. Without it the only way to learn a node is to read a building that already uses one, so you can never reach a node no existing building happens to use - and a node type, property name or mode value that is not in this list is silently ignored, which produces a building that looks nearly right. Also reports which PORTS each node has, which is what decides the wiring: a Mass takes a `shape`, everything else takes a `building`, and a Merge takes TWO.',
    inputSchema: {
      type: z.string().optional().describe('One node type, e.g. "facade". Omit for all of them.'),
      search: z.string().optional().describe('Case-insensitive substring of the type, label or blurb.'),
      detail: z.enum(['summary', 'full']).default('full')
        .describe('"summary" is type, label and blurb only - enough to choose a node, then ask again for that one.'),
    },
  }, toolHandler(({ type, search, detail }) => {
    const needle = String(search || '').trim().toLowerCase();
    const matches = (def) => (!type || def.type === type)
      && (!needle || [def.type, def.label, def.blurb]
        .some((text) => String(text || '').toLowerCase().includes(needle)));

    const propOf = ([name, spec]) => ({
      name,
      type: spec.type,
      label: spec.label,
      default: spec.default,
      ...(spec.unit ? { unit: spec.unit } : {}),
      ...(Number.isFinite(spec.min) ? { min: spec.min } : {}),
      ...(Number.isFinite(spec.max) ? { max: spec.max } : {}),
      ...(spec.hint ? { hint: spec.hint } : {}),
      // WHICH MODE MAKES THIS PROPERTY MEAN ANYTHING. Setting `amount` on a
      // Straight profile is not an error and does nothing, which is the same
      // failure as a typo but harder to see.
      ...(spec.showFor ? { onlyWhen: spec.showFor } : {}),
    });

    const nodeOf = (def) => (detail === 'summary'
      ? { type: def.type, label: def.label, category: def.category, blurb: def.blurb }
      : {
        type: def.type,
        label: def.label,
        category: def.category,
        blurb: def.blurb,
        teach: def.teach,
        // THE PORTS ARE THE WIRING, and the reason a graph fails to compile.
        inputs: (def.inputs || []).map((port) => ({
          id: port.id, label: port.label, kind: port.kind, required: Boolean(port.required),
        })),
        outputs: (def.outputs || []).map((port) => ({ id: port.id, kind: port.kind })),
        props: Object.entries(def.props || {}).map(propOf),
        modes: Object.entries(def.modes || {}).map(([name, mode]) => ({
          name,
          label: mode.label,
          default: mode.default,
          options: (mode.options || []).map((option) => ({
            value: option.value, label: option.label, teach: option.teach || '',
          })),
        })),
      });

    return {
      irFormat: BUILDING_IR_FORMAT,
      // The order they belong in a chain, which is also the palette's order.
      pipelineOrder: CATALOG_ORDER,
      paletteSlots: PALETTE_SLOTS,
      nodes: CATALOG_ORDER.map((key) => CATALOG[key]).filter(matches).map(nodeOf),
    };
  }));

  server.registerTool('list_buildings', {
    title: 'List buildings',
    description: 'Every Building asset in the library, newest first. Buildings are library-global, so there is no project filter.',
    inputSchema: {
      search: z.string().optional().describe('Case-insensitive substring of the name.'),
      limit: z.number().int().min(1).max(200).default(50),
    },
  }, toolHandler(async ({ search, limit }) => {
    // ITS OWN ARRAY. /assets/library returns one array per asset type and
    // `images` is only the images - filtering that for buildings finds none, and
    // filtering by FILENAME finds none either, because the stored name is a
    // generated timestamp and the original never survives the upload.
    const listing = await api.apiJson('GET', '/assets/library', {});
    const rows = Array.isArray(listing?.buildings) ? listing.buildings : [];
    const needle = String(search || '').trim().toLowerCase();
    const buildings = rows
      .filter((row) => !needle || String(row.name || '').toLowerCase().includes(needle))
      .slice(0, limit)
      .map((row) => ({
        assetId: Number(String(row.assetId ?? row.id ?? '').replace('library:', '')),
        name: row.name || '',
        filePath: row.filePath || row.filename || '',
      }));
    return { count: buildings.length, buildings };
  }));

  server.registerTool('get_building', {
    title: 'Get a building',
    description: 'The complete graph document for one Building asset, plus its compiled summary and diagnostics. This is the read half of the loop: read it, patch the nodes, compile_building to check, save_building.',
    inputSchema: {
      assetId: z.number().int().positive().describe('The Building asset id.'),
      includeGraph: z.boolean().default(true)
        .describe('Return the document itself. Turn it off for the summary and diagnostics alone.'),
    },
  }, toolHandler(async ({ assetId, includeGraph }) => {
    const { record, doc } = await loadDoc(api, assetId);
    const compiled = compileBuilding(doc);
    return {
      assetId,
      name: record.name || doc.name || '',
      filePath: record.filePath,
      ok: compiled.ok,
      summary: summarise(doc, compiled),
      graph: includeGraph ? doc : undefined,
    };
  }));

  server.registerTool('compile_building', {
    title: 'Compile a building',
    description: 'Compile a graph document to its IR and report what the editor would show. PURE AND FAST - no GPU, no browser - so run it on every edit before saving. Reports errors (the graph produces nothing) and warnings (it produces something, but not what was asked for): a profile that consumed the plan, a Facade covering no storeys, a Roof Detail placed before the Roof, openings narrowed to fit their bay. A warning is the usual way a wrong-looking building explains itself.',
    inputSchema: {
      graph: DOC_SHAPE.describe('A complete graph document.'),
      includeIr: z.boolean().default(false)
        .describe('Return the compiled IR. It holds every polygon, slot transform and trim path, so it is LARGE - the default returns the summary and diagnostics.'),
    },
  }, toolHandler(({ graph, includeIr }) => {
    const doc = normalizeBuildingDoc(graph);
    const compiled = compileBuilding(doc);
    return {
      ok: compiled.ok,
      summary: summarise(doc, compiled),
      ir: includeIr ? compiled.ir : undefined,
    };
  }));

  server.registerTool('create_building_graph', {
    title: 'Create a building graph',
    description: 'Build a valid graph document from a list of stages, wired in order. This is the easy way to start: it creates the Footprint and the Output, wires the Mass to the plan and everything else to the building before it, and returns a document that compiles. Patch the result rather than hand-wiring edges - the wiring is where a hand-built graph goes wrong. It does NOT save; pass the result to save_building.',
    inputSchema: {
      name: z.string().min(1).max(200).default('Untitled Building'),
      seed: z.number().int().min(0).optional().describe('Re-rolling it re-rolls every seeded choice: which model each opening wears, which panels get a brace, which openings get a balcony.'),
      shape: z.object({
        outer: z.array(z.array(z.number())).min(3)
          .describe('The plan outline as [x, y] pairs in METRES, counter-clockwise.'),
        holes: z.array(z.array(z.array(z.number()))).optional()
          .describe('Courtyards and light wells. They survive every operation above.'),
      }).optional().describe('The plan. Defaults to a 12m x 8m rectangle.'),
      stages: z.array(z.object({
        type: z.string().describe('A node type from describe_building_catalog, except footprint and output.'),
        modes: z.record(z.string(), z.string()).optional(),
        props: z.record(z.string(), z.any()).optional(),
      })).min(1).describe('The chain between the Footprint and the Output, IN ORDER. Order matters: a Roof Detail must come after the Roof it stands on, a Trim after the Roof whose eave it follows.'),
    },
  }, toolHandler(({ name, seed, shape, stages }) => {
    const footprint = createNode('footprint', 'fp');
    if (shape) footprint.props.shape = shape;
    const nodes = [footprint];
    const edges = [];
    let previous = null;

    stages.forEach((stage, index) => {
      if (!CATALOG[stage.type]) throw new Error(`No such node type: "${stage.type}". Ask describe_building_catalog.`);
      if (stage.type === 'footprint' || stage.type === 'output') {
        throw new Error(`"${stage.type}" is created for you - list only the stages between them.`);
      }
      const node = createNode(stage.type, `n${index}`);
      Object.assign(node.modes, stage.modes || {});
      Object.assign(node.props, stage.props || {});
      nodes.push(node);
      // A Mass takes the PLAN; everything else takes the building before it.
      const port = (node.inputs || CATALOG[stage.type].inputs || [])[0];
      const inputId = port?.id || 'building';
      edges.push({
        from: { node: previous || footprint.id, port: 'out' },
        to: { node: node.id, port: inputId },
      });
      previous = node.id;
    });

    const output = createNode('output', 'out');
    nodes.push(output);
    edges.push({ from: { node: previous || footprint.id, port: 'out' }, to: { node: 'out', port: 'building' } });

    const doc = normalizeBuildingDoc({
      name,
      building: seed === undefined ? {} : { seed },
      nodes,
      edges,
    });
    const compiled = compileBuilding(doc);
    return { ok: compiled.ok, graph: doc, summary: summarise(doc, compiled) };
  }));

  server.registerTool('list_building_styles', {
    title: 'List building style packs',
    description: 'Every shipped style pack. A pack is a GRAPH RECIPE, not a texture set: it replaces the nodes between the Footprint and the Output with an ordered list of stages, so applying one changes the MASSING as well as the colours. That is why a Roman villa and a Mayan temple come out of the same node vocabulary. A pack that fails validation is listed with its problem rather than hidden.',
    inputSchema: {
      includeGraph: z.boolean().default(false).describe('Return each pack\'s stage list. It is most of the file.'),
    },
  }, toolHandler(({ includeGraph }) => {
    const packs = readStylePacks();
    return {
      count: packs.length,
      styles: packs.map(({ pack, problems, file }) => ({
        file,
        id: pack?.id || '',
        name: pack?.name || '',
        category: pack?.category || '',
        blurb: pack?.blurb || '',
        palette: pack?.palette || null,
        stages: pack ? pack.graph.map((stage) => stage.type) : [],
        graph: includeGraph && pack ? pack.graph : undefined,
        problems,
      })),
    };
  }));

  server.registerTool('apply_building_style', {
    title: 'Apply a style pack',
    description: 'Rebuild a graph\'s nodes from a shipped style pack, keeping its PLAN. The footprint and the output survive; everything between them is replaced. Returns the new document - it does not save. Use it as a starting point: apply a style, then patch the stages it produced.',
    inputSchema: {
      graph: DOC_SHAPE.describe('The document to restyle. Its Footprint and Output are kept.'),
      styleId: z.string().min(1).describe('A pack id from list_building_styles, e.g. "roman-villa".'),
    },
  }, toolHandler(({ graph, styleId }) => {
    const found = readStylePacks().find((entry) => entry.pack?.id === styleId);
    if (!found?.pack) {
      const ids = readStylePacks().map((entry) => entry.pack?.id).filter(Boolean);
      throw new Error(`No style pack "${styleId}". Available: ${ids.join(', ')}`);
    }
    if (found.problems.length) {
      throw new Error(`Style pack "${styleId}" does not validate: ${found.problems.join('; ')}`);
    }
    const doc = normalizeBuildingDoc(graph);
    const next = applyStylePack(doc, found.pack);
    if (next === doc || next.building.stylePackId !== styleId) {
      throw new Error('That document has no Footprint and Output to build between.');
    }
    const compiled = compileBuilding(next);
    return { ok: compiled.ok, graph: next, summary: summarise(next, compiled) };
  }));

  server.registerTool('set_building_reference', {
    title: 'Bind a texture or model',
    description: 'Point one of a building\'s asset slots at a library asset. EVERY SLOT HOLDS A LIST - `tex_wall.0`, `tex_wall.1` - and the compiler rolls one entry per building for a texture and one PER OPENING for a model, from the document seed. So binding three window models gives a building a mix of windows, and re-rolling the seed gives a different mix. Slot keys: building-wide `tex_<slot>` and `mesh_<tag>`; per-node `<nodeId>.<slot>` and `<nodeId>.<slot>.<side>` for one side of one facade. Returns the patched document; it does not save.',
    inputSchema: {
      graph: DOC_SHAPE.describe('The document to patch.'),
      slot: z.string().min(1).describe('The slot PREFIX, without the numeric tail: "tex_wall", "mesh_window", "fc1.openingMesh.north".'),
      assetId: z.number().int().positive().describe('The library asset to bind.'),
      kind: z.enum(['image', 'mesh']).describe('Which kind the slot takes. A texture slot takes an image; an opening, balcony, post or roof-item slot takes a mesh.'),
      name: z.string().max(200).optional().describe('Shown in the editor. Defaults to the slot name.'),
      tileMetres: z.number().positive().max(100).optional()
        .describe('Images on a WALL, ROOF or TRIM only: how many metres one tile covers. An opening, door or post texture FILLS its cell and ignores this.'),
      rotation: z.array(z.number()).length(3).optional()
        .describe('Meshes only: degrees about X, Y and Z, applied before the model is fitted to its cell. For a model exported lying down.'),
      replace: z.boolean().default(false)
        .describe('Clear the slot\'s existing entries first, instead of adding to the list.'),
    },
  }, toolHandler(({ graph, slot, assetId, kind, name, tileMetres, rotation, replace }) => {
    const doc = normalizeBuildingDoc(graph);
    const prefix = String(slot).replace(/\.\d+$/, '');
    const references = { ...doc.references };
    if (replace) {
      for (const key of Object.keys(references)) {
        if (key === prefix || key.startsWith(`${prefix}.`)) delete references[key];
      }
    }
    // The next FREE index, not the count: removing the middle of a list leaves a
    // gap, and reusing an index would overwrite a sibling.
    let next = 0;
    for (const key of Object.keys(references)) {
      const match = key.startsWith(`${prefix}.`) && /^\d+$/.test(key.slice(prefix.length + 1))
        ? Number(key.slice(prefix.length + 1))
        : null;
      if (match !== null && match >= next) next = match + 1;
    }
    references[`${prefix}.${next}`] = {
      kind,
      // INVARIANT 4: the string 'asset:<id>', never a bare number, or project
      // export cannot carry or renumber the dependency.
      ref: `asset:${assetId}`,
      name: name || prefix,
      ...(kind === 'image' && tileMetres ? { tileMetres } : {}),
      ...(kind === 'mesh' && rotation ? { rotation } : {}),
    };
    const patched = normalizeBuildingDoc({ ...doc, references });
    const compiled = compileBuilding(patched);
    return {
      ok: compiled.ok,
      slot: `${prefix}.${next}`,
      graph: patched,
      summary: summarise(patched, compiled),
    };
  }));

  server.registerTool('save_building', {
    title: 'Save a building',
    description: 'Create a new building or overwrite an existing one. Pass assetId to save in place (the id and any deep links survive); omit it to create a new library asset. The document is normalised and its reference digest is written to the asset metadata, so a .3dgp project export carries its textures and models. NOTE: this does not render a thumbnail - that needs a GPU - so a new building shows a placeholder card until someone opens and saves it in the editor. Compile first unless you mean to save something unfinished.',
    inputSchema: {
      graph: DOC_SHAPE.describe('The complete graph document.'),
      name: z.string().min(1).max(200).optional().describe('Defaults to the document\'s own name.'),
      assetId: z.number().int().positive().optional().describe('Overwrite this building. Omit to create a new one.'),
    },
  }, toolHandler(async ({ graph, name, assetId }) => {
    const safeName = String(name || graph?.name || 'Building').trim() || 'Building';
    const doc = normalizeBuildingDoc({ ...graph, name: safeName, savedAt: Date.now() });
    // THE SAME DIGEST THE EDITOR WRITES, from the same function, so an
    // agent-saved building and a human-saved one are indistinguishable to the
    // Assets page and to project export.
    const metadata = buildingAssetDigest(doc);

    const body = serializeBuildingDoc(doc);
    const file = new File([Buffer.from(body)], `${safeName.replace(/[^\w.-]+/g, '_')}.building.json`, {
      type: 'application/json',
    });

    const form = new FormData();
    form.append('file', file);
    let saved;
    if (assetId) {
      // The replace dialect: ONE `payload` JSON part. library-upload takes loose
      // fields instead, and getting the two the wrong way round produces a 400
      // that says nothing useful - see the header of src/utils/buildingApi.js.
      form.append('payload', JSON.stringify({ name: safeName, type: BUILDING_TYPE, metadata }));
      saved = await api.apiForm('POST', `/assets/${assetId}/replace`, form);
    } else {
      form.append('type', BUILDING_TYPE);
      form.append('name', safeName);
      form.append('metadata', JSON.stringify(metadata));
      saved = await api.apiForm('POST', '/assets/library-upload', form);
    }
    notifyMutation?.('assets');

    const compiled = compileBuilding(doc);
    return {
      assetId: Number(String(saved?.id ?? assetId).replace('library:', '')),
      name: safeName,
      filePath: saved?.filePath || null,
      created: !assetId,
      ok: compiled.ok,
      diagnostics: compiled.diagnostics.map((d) => ({
        code: d.code, severity: d.severity, message: d.message, nodeId: d.nodeId || '',
      })),
    };
  }));
}
