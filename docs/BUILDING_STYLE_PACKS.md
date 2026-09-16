# Building style packs

A style pack is a **graph recipe**, not a texture set. Applying one replaces the nodes
between the Footprint and the Output with an ordered list of stages, so it changes the
**massing** as well as the colours. That is the whole reason one node vocabulary covers a
Roman villa, a Mayan temple and a cyberpunk tower.

Packs ship flat in `resources/buildings/styles/<id>.json`. **The directory is the index** —
there is no manifest — and `category` is a field, not a directory. Eleven ship today.

---

## Format

```jsonc
{
  "format": 1,
  "id": "roman-villa",              // must match the filename
  "name": "Roman Villa",
  "category": "Classical",
  "blurb": "Low, wide and arcaded, under a shallow hipped roof.",
  "teach": "Roman domestic architecture is horizontal: …",

  "palette": {
    "wall": "#ddd3c0", "trim": "#c9bfa8", "roof": "#9c4f34",
    "opening": "#3a3026", "door": "#6b4a2f", "accent": "#b3a68c",
    "pillar": "#bcc0c7"
  },

  "graph": [
    { "type": "mass",   "modes": { "profile": "straight" }, "props": { "levelCount": 2 } },
    { "type": "facade", "modes": { "storeys": "upper" },    "props": { "bayWidth": 2.8 } },
    { "type": "roof",   "modes": { "kind": "hip" },         "props": { "pitch": 22 } },
    { "type": "trim",   "modes": { "where": "cornice" },    "props": { "projection": 0.55 } }
  ]
}
```

`graph` is the ordered chain. `applyStylePack(doc, pack)` keeps the document's Footprint and
Output, wires the stages between them, and writes `building.stylePackId` and a `building.style`
snapshot holding the palette. **The author's plan survives**; everything between the ends does
not. Undo restores the previous graph.

`teach` is shown in the editor when the style is selected. Say what makes the style what it
is, in terms of the nodes — that is what turns a pack into an explanation rather than a preset.

---

## The falsification test

The design of this feature rests on one claim: that the styles in the target list differ in
**how the footprint changes as it rises**, and can therefore be expressed as data against one
set of nodes. If that claim is false, the way it fails is that some style needs a node nobody
else uses.

`tools/check-building-presets.mjs` mechanises it, and runs in every `dist` gate:

1. **`validateStylePack` refuses any node type outside the catalog.** A pack that needs new
   code cannot ship, and the failure names the node.
2. **Every pack must compile with no errors** on a plan with a courtyard — a style that only
   works on the footprint its author drew is not a style.
3. **The buildings must be measurably different** from one another. Packs that all validate
   and all produce the same box would pass the first two checks and mean nothing.

Warnings are printed, not failed — `W_MASS_TRUNCATED` is *correct* for a ziggurat. But a pack
warning on a plain rectangle usually wants tuning, and the report is where you see it. That
report silently printed nothing for months because it filtered severity `'warning'` where the
vocabulary says `'warn'`; use `SEVERITY.WARN`.

Two things a pack may not do:

- **`footprint` and `output` are reserved.** The document supplies them.
- **`merge` is reserved**, for a structural reason rather than a policy one: a pack is a
  linear chain and a Merge takes two buildings, so a pack declaring one would produce a graph
  with a dangling required input. A tower is hand-wired.

---

## Writing one

Start from a shipped pack, and check it against **more than one plan**. The preset checker
uses a 20×12 courtyard; the default Footprint is 12×8, and a pack tuned on a big plan gives up
quietly on a small one. The traps that actually bit, in the order they bit:

- **A mansard's `breakFraction` is a share of how far the plan can erode at all**, floored at
  two mesher steps — so lowering it barely moves anything and the **pitch** is what sets how
  tall the crown reads. 0.45 at 72° gave a 10.5 m mansard on a 19.7 m building.
- **A parapet needs a deck.** On a pitched roof there is none and it follows the ridge
  (`W_PARAPET_ON_PITCH`). A cornice sits at the wall head instead.
- **A corner radius wider than the narrowest wing is silently dropped**
  (`W_CORNER_RADIUS`) — so "Rounded" corners do nothing and the style loses a defining trait.
  The limit is usually not the radius but the *profile*: a 1.9 m waist on a plan with a 4 m
  courtyard wing leaves 0.2 m to round.
- **`maxHeight` is absolute metres**, so a cap that leaves a deck on a large plan closes to a
  ridge on a small one and a stacked roof is skipped (`W_ROOF_ON_RIDGE`).
- **A stage that does nothing is still a stage.** A Flat roof stacked on a Stepped roof
  already capped at its `maxHeight` produced byte-identical output; the capped tread *is* the
  deck.

---

## Assets

A pack may declare `vocabulary` and `assets[]`, naming files in
`resources/buildings/assets/`. Opening such a pack would install those files into the local
library and rewrite the slots to `asset:<id>` — the mechanism `vfx/preset.js` uses.

**Nothing ships this way today**: `resources/buildings/assets/` is empty, so the installer is
deliberately not built. It is content, not code, and building an untestable path that carries
nothing would be worse than not having it. Every shipped pack is palette and geometry only.

Author-only editing reuses the wiki's `.wiki-author` gate, as VFX presets do.

---

## See also

- `docs/BUILDING_GRAPH_SCHEMA.md` — what a stage may say.
- `building/stylepack.js` — the format, `validateStylePack`, `applyStylePack`, slot vocabularies.
- `GET /api/buildings/styles` — the route the editor reads, which returns
  `{ styles, skipped }`. A **rejected** pack is reported with its problem rather than hidden,
  because a rejected pack and an absent one look identical from the UI otherwise.
