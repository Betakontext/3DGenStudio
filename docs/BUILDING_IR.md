# BuildingIR — the compiled form

`compileBuilding(doc)` turns a graph into a `BuildingIR`: a flat, plain-JSON description of
one building. The preview meshes it, the exporter bakes it, and an engine exporter could read
it without ever seeing a node.

```js
import { compileBuilding } from './building/compile.js'
const { ir, diagnostics, ok } = compileBuilding(doc)
```

Pure and fast — no GPU, no browser, no async. A forty-storey tower compiles in under 10 ms.

---

## Rules the IR keeps

**Plain JSON only.** No typed arrays, no `NaN`, no `undefined`. `validateIrJson(ir)` walks
every value and returns the problems; a test asserts it over every fixture. A typed array
sneaks past every other check and fails much later, in an exporter or in another language.

**Indexed into flat arrays.** Geometry is referenced by index into `polygons`, so a stepped
roof whose tread and riser share a shape stores it once.

**Order is meaningful and stable.** A recompile of an unchanged document is byte-identical,
which is what makes `irDigest(ir)` a usable golden test.

**Quantised at the boundary.** Coordinates are rounded to 1e-6 m — a micron — by `quantize`,
applied when the value is *stored*, so intermediate maths keeps full precision and two
identical buildings serialise identically.

---

## Shape

```jsonc
{
  "format": 1,
  "seed": 12345,
  "units": "m",

  "polygons": [ { "outer": [x,y, x,y, …], "holes": [[x,y, …]] } ],
  "levels":   [ { "polygon": 0, "z0": 0, "z1": 4, "kind": "ground", "index": 0 } ],
  "solids":   [ { "levels": [0,1,2], "name": "building" } ],

  "slots":    [ /* see below */ ],
  "trims":    [ /* see below */ ],
  "roofs":    [ /* see below */ ],

  "deform":   null,
  "materials": [ /* see below */ ],
  "references":   { "tex_wall.0": "asset:41" },
  "meshRotations": { "mesh_balcony.0": [90, 0, 0] },
  "stats": { /* see below */ }
}
```

### `solids` is a list, and now really holds several

One entry per part. A building that was never merged has one; a hall with a tower has two,
and an exporter that wants one object per part has the split kept for it. The field has been
an array since the first phase for exactly this.

### `roofs` is a list, not `roof`

A Merge joins two buildings and each brought its own roof. This replaced a singular `roof`
outright rather than keeping it as an alias: a consumer reading `ir.roof` on a merged building
would silently draw one of the two and nobody would know which.

```jsonc
{
  "kind": "gable", "height": 4.6, "baseZ": 8.8, "closed": true,
  "rungs":  [ { "polygons": [3], "z": 8.8 }, … ],
  "gables": [ { "path": [x,y,z, …] }, … ]
}
```

A roof is a **contour ladder**: rungs of polygons at heights. Between two consecutive rungs
`rungKind(a, b)` says `slope`, `tread`, `riser` or `none`, and it is exported so the mesher
and the tests agree rather than each deciding for itself. That one representation covers flat,
shed, hip, gable, mansard, gambrel, pyramid, stepped and tiered.

`gables` are the **vertical end walls** a gable or shed needs, stored as 3D polylines. This is
the one place the IR breaks its own index-into-a-table rule, and deliberately: everything else
is a plan at a height, and a gable end is vertical, so it has no single height and no plan. A
shed carries **three** — its two ends *and its tall side*, which is an open face nothing else
in the ladder describes.

### `slots`

One placed thing: a window, a door, a balcony, a post, a chimney.

```jsonc
{
  "type": "window",            // window | door | balcony | pillar | roof_item
  "styleSlot": "window",       // the tag a style binds against
  "transform": [ /* 16, column-major */ ],
  "cellW": 1.2, "cellH": 1.8, "cellD": 0,
  "faceIndex": 0, "floorIndex": 1, "bayIndex": 3,
  "seedKey": 2394787053,
  "meshSlot": "fc1.openingMesh.north",
  "variant": 1
}
```

The transform's local axes are **X along the wall, Y up, Z out of it**, right-handed by
construction, with the origin at the **centre** of the cell — so a model authored centred on
its own origin and facing +Z sits flat on the wall the right way round.

`cellD` is **0 for an opening**, meaning "the consumer's own rule" (the mesher's token recess
depth). A balcony, a post and a roof item declare a real depth, because their projection is a
dimension the author set and has to survive into a headless export.

`meshSlot` is the reference **prefix** the compiler resolved — the building-wide list for the
tag, a facade's override, or one side of one — and `variant` the entry it rolled. Both are
resolved here rather than in the renderer so a headless export and the preview agree.

### `trims`

A swept polyline. Mouldings, and every timber of a Frame.

```jsonc
{ "profileId": "cornice", "path": [x,y,z, …], "closed": true,
  "level": 2, "projection": 0.35, "depth": 0.4, "material": 1, "normal": [] }
```

A **closed** run is a horizontal ring and mitres at every corner — `1/cos(half-turn)`, clamped
at 4. An **open** run (a bargeboard, a stud, a brace) carries a `normal`, because it has no
plan direction to derive one from: a vertical stud has none at all, and a gable rake lies in a
plane its own points cannot tell from the mirror image. For an open run the section's up axis
is `cross(normal, tangent)`, which comes out horizontal on a vertical member — so `depth`
reads as the *width* of a stud.

### `materials`

```jsonc
{ "slot": "wall", "color": "#c9cdd4", "ref": "asset:41", "tile": 2,
  "fromFloor": -1, "toFloor": -1, "side": "" }
```

`resolveMaterialIndex(ir, slot, floor, side)` picks the **most specific** entry: a side beats a
floor range beats the building-wide one. `-1` and `''` are wildcards. Slots are `wall`, `trim`,
`roof`, `opening`, `door`, `accent`, `pillar`.

Two rules the renderer follows and an exporter must match:

- A **texture replaces the colour**; the colour is what an unbound slot shows. It used to
  multiply, on the reasoning that neutral images would take the style's hue — but building
  textures are generated as photographic material samples, so multiplying only darkened them,
  and against the opening slot's near-black it destroyed them outright.
- `opening`, `door` and `pillar` textures **fill their cell**; everything else **tiles by
  metres**. `tilesByMetres(slot)` is the one rule, used by the preview (as a texture repeat)
  and by the exporter (as baked UVs) so the two cannot drift.
- A bound slot texture beats an imported model's own material **only on a slot the element
  owns**. A window owns `opening`, a door `door`, a post `pillar` — binding there is an
  instruction about that element, so it has to win or the control would do nothing. A
  **balcony and a roof item own nothing**: they borrow `trim` and `wall` for a colour to fall
  back to. Letting a borrowed texture win wrapped every imported chimney in the building's own
  plaster, tiled in metres, and threw away the texture that was the point of importing it.
  `buildSlotInstances` marks those groups `borrowsMaterial`, and both consumers check it.

### `deform`

A **descriptor**, not baked coordinates:
`{ mode, amount, axis, height, seed, centre }`. The slots and trims in the IR are already
warped; walls and roofs are generated from the 2D polygons by the consumer, which needs the
function. `makeWarp(descriptor)` returns `{ warp, basis, isIdentity }` — `basis` is the
numeric Jacobian, and applying the **full** Jacobian is load-bearing: a lean is a shear, so an
opening in a leaning wall must become a parallelogram, not merely move.

### `stats`

`levelCount`, `storeyCount`, `slotCount`, `height`, `footprintArea`, `floorArea`,
`polygonCount`, `roofHeight` (the tallest roof), `trimCount`, `trimLength`.

---

## Consuming it

```js
import { buildBuildingGeometry, buildRoofGeometry, buildTrimGeometry, buildSlotInstances }
  from './src/utils/building/mesh.js'
```

The mesher maps IR space to three.js space as `toThree(x, y, z) → [x, z, -y]` — a proper
rotation, not a mirror. Walls are UV-mapped in **metres** as (run, height); caps in plan
metres. A **roof slope is mapped in its own plane** — `u` along the eave, `v` up the true
slope — and not projected from above: a top-down projection bakes the plan's axes into the
texture, so courses run along the eave on a roof whose eave lies along x and straight *down*
the slope on one that runs along y (a cross-gable shows both at once), and it foreshortens by
cos(pitch). A flat deck has no eave to align to and keeps the plan projection. Slots are instanced: one `THREE.InstancedMesh` per distinct
(type, material, tag, model, variant), so 2,320 openings on a forty-storey tower are **two**
draw calls.

---

## See also

- `docs/BUILDING_GRAPH_SCHEMA.md` — the document the compiler reads.
- `building/ir.js` — constructors, `resolveMaterialIndex`, `validateIrJson`, `irDigest`.
- `building/roof.js` — the ladder, `rungKind`, `stackRoofs`.
