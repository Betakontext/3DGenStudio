# BuildingDoc — the graph schema

A `Building` asset is a JSON document of about 10–40 KB, stored as a **file** under
`data/assets/buildings/`. It describes a node graph; the graph describes a building. There is
no `/api/buildings` — buildings ride the ordinary asset routes, exactly as VFX effects do.

Normalise with `normalizeBuildingDoc(doc)` from `building/doc.js` before doing anything with a
document you did not just produce. Every reader in the app does.

```jsonc
{
  "format": 1,
  "kind": "building-graph",
  "name": "Untitled Building",
  "savedAt": 0,
  "building": {
    "seed": 12345,
    "units": "m",
    "stylePackId": null,
    "style": null,          // { name, palette } — the per-document colour snapshot
    "overrides": {}
  },
  "nodes": [ /* see below */ ],
  "edges": [ /* see below */ ],
  "references": { /* see below */ }
}
```

Units are **metres**, everywhere, without exception.

---

## The four invariants

These are not style rules. Each exists because breaking it produced a specific failure.

**1. `edges` is authoritative for wiring.** A property's `mode: 'link'` is a derived mirror
rebuilt by `normalizeBuildingDoc`; nothing else may write it.

**2. `layout` is never read by the compiler.** `buildingSignature()` omits `layout` and
`savedAt`, which is what lets dragging a node avoid a recompile.

**3. Asset references are slot keys resolved through one `references` table.** A node says
`tex_wall`; the table maps it to an asset. One place to walk for bundling, one place to remap
on import, and a deleted texture becomes a *reportable dangling key* rather than a silent
absence.

**4. Every reference is the string `'asset:<id>'`, never a bare number.**
`collectAssetIdsFromValue` and `remapReferencesDeep` in `storage.js` match `/^asset:(\d+)$/`,
so `.3dgp` export/import carries and renumbers dependencies with zero walker changes. Tree
presets store bare numbers and therefore ship broken across installations; this invariant
exists to avoid repeating that. `normalizeReferenceEntry` **rejects the whole entry** rather
than coercing a bad ref to empty — an empty slot and a malformed one have completely
different causes and must not look alike.

---

## Nodes

```jsonc
{
  "id": "facade-1",
  "type": "facade",
  "enabled": true,        // false = muted; the node stays and is skipped
  "props": { "bayWidth": 3 },
  "modes": { "storeys": "upper", "opening": "window" },
  "layout": { "x": 240, "y": 90 }
}
```

`props` are numbers, booleans, a polygon or a curve. `modes` are single-choice enums. The
authoritative list of both is `building/catalog.js` — or `describe_building_catalog` over MCP,
which returns the same data. **A property or mode value not in the catalog is ignored**, so a
typo produces a building that looks nearly right.

| Type | What it does | Input port(s) |
|---|---|---|
| `footprint` | The plan. Holes become courtyards and survive every operation above. | — |
| `mass` | Stacks the plan into storeys. The **Profile** unifies batter, setback, jetty and curve. | `shape` |
| `facade` | Splits every wall into bays and places openings, balconies and posts. | `building` |
| `frame` | Half-timbering: studs, rails and braces over the walls. | `building` |
| `roof` | Caps the building. A second Roof **continues** the first. | `building` |
| `roofitem` | Chimneys, finials, vents and ridge crests, standing on the roof. | `building` |
| `merge` | Joins two buildings into one. Each keeps its own roof. | `a`, `b` |
| `trim` | Runs a moulding along an edge: cornice, string, plinth, eave, parapet, rake. | `building` |
| `deform` | Warps the finished building, and/or nudges each element off true. | `building` |
| `output` | The end of the chain. | `building` |

### Order is not cosmetic

This is the single most common way to build a graph that compiles clean and does nothing:

- A **Roof Detail** reads the roof *under* it. Placed before the Roof, it places nothing
  (`W_ROOF_ITEM_NO_ROOF`, which carries a one-click fix).
- A **Trim** reads the roof for its eave, parapet and rake.
- A **Facade** *replaces* the openings on the storeys it claims, so a later Facade set to
  `ground` overrides an earlier one set to `all` — on the ground floor only.
- A **Roof** after a Roof *stacks*; it does not replace. Stepped-then-Hip is a Mayan temple,
  Tiered-over-Tiered is a pagoda. The lower one needs a height cap so it ends on a deck.
- After a **Merge** nothing is open for stacking, and a Roof Detail goes on the *tallest* roof.

---

## Edges

```jsonc
{ "id": "ms:out->fc:building", "from": { "node": "ms", "port": "out" },
  "to": { "node": "fc", "port": "building" } }
```

Two port kinds, `shape` and `building`, and they do not mix: a Mass takes a `shape` and
everything downstream takes a `building`. A graph is a real DAG — `merge` has two required
inputs — and the compiler topologically sorts it and rejects cycles.

---

## References

Every slot holds a **list**, keyed by a numeric tail:

```jsonc
"references": {
  "tex_wall.0":            { "kind": "image", "ref": "asset:41", "name": "Brick", "tileMetres": 2 },
  "tex_wall.1":            { "kind": "image", "ref": "asset:42", "name": "Stone", "tileMetres": 2 },
  "mesh_window.0":         { "kind": "mesh",  "ref": "asset:55", "name": "Sash" },
  "mesh_balcony.0":        { "kind": "mesh",  "ref": "asset:56", "rotation": [90, 0, 0] },
  "facade-1.wall.north.0": { "kind": "image", "ref": "asset:43", "tileMetres": 2 }
}
```

The numeric tail is what separates a **list index** from a **scope**: a facade's per-side
override is `<node>.wall.north`, and its list is `<node>.wall.north.0`. `appendReference` uses
the next *free* index, never the count, so removing the middle of a list cannot make a later
append overwrite a sibling.

**Two different units of variation, deliberately:**

- A **texture** is picked once per building — a building wears one brick.
- An **opening model** is picked **per opening** — one building shows a mix of windows.
  The chosen index is stored on the slot as `variant`, so a headless export and the preview
  put the same window in the same hole.

Both are hashed from the slot's own identity (`{face, floor, bay, sub}`), never from a
position in a stream. That is what makes **adding a storey leave the windows below it
untouched**, and it depends on `floorIndex` counting from the ground.

### Slot key shapes

| Shape | Scope |
|---|---|
| `tex_<slot>.<n>` | building-wide texture — `wall`, `trim`, `roof`, `opening`, `door`, `pillar` |
| `mesh_<tag>.<n>` | building-wide model — `window`, `shopfront`, `arch`, `balcony`, `louvre`, `door`, `chimney`, `finial`, `vent`, `crest`, `pillar` |
| `<nodeId>.<slot>.<n>` | that node only |
| `<nodeId>.<slot>.<side>.<n>` | that node, one compass side — `north`, `east`, `south`, `west` |

A facade's own mesh slots are named rather than tagged, so switching its Opening from Window
to Arch keeps the binding: `openingMesh`, `balconyMesh`, `postMesh`. A Roof Detail uses
`itemMesh`, a Trim and a Frame use `trim`.

### Entry fields

| Field | Applies to | Meaning |
|---|---|---|
| `kind` | all | `image` or `mesh` |
| `ref` | all | `'asset:<id>'` — invariant 4 |
| `name` | all | shown in the editor |
| `tileMetres` | images | metres per tile. **Ignored** by `opening`, `door` and `pillar`, whose textures fill their cell (see `tilesByMetres`) |
| `rotation` | meshes | degrees about X, Y, Z, applied **before** the unit-box fit |

---

## Diagnostics

`compileBuilding(doc)` returns `{ ir, diagnostics, ok }`. Severity is `error`, `warn` or
`info` — the strings on `SEVERITY` in `building/diagnostics.js`. Use the constant: filtering
for the literal `'warning'` is a real bug that once hid five shipped style-pack defects for
weeks, because it silently matched nothing.

An `error` means the graph produced no geometry. A `warn` means it produced something other
than what was asked for, which is the usual way a wrong-looking building explains itself.
Some diagnostics carry a `fix` — `{ label, action, args }` — applied by `applyFix` in
`src/utils/building/edits.js`.

---

## See also

- `docs/BUILDING_IR.md` — what the compiler produces.
- `docs/BUILDING_STYLE_PACKS.md` — packs as graph recipes.
- `building/catalog.js` — the authoritative node vocabulary.
- `npm run check:building` — unit tests plus every shipped pack compiled and compared.
