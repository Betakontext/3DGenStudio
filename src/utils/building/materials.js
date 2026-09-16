// One three.js material per IR material entry.
//
// WHY A FILE AND NOT THREE JSX LINES IN THE VIEWPORT. Before per-facade
// overrides a building had exactly three surfaces - walls, roof, trim - and
// declaring their materials inline was the clearest thing. It is not clear any
// more: a facade can override the wall on the storeys it claims, and again on
// one side of them, so the number of wall materials is a property of the
// document rather than of the code. Building them from the IR's material table
// puts the count where it belongs, and gives the geometry's draw GROUPS an array
// to index into.
//
// SURFACE FINISH IS PER SLOT, not per entry. An override changes what a surface
// is made of, not whether it is a wall - a brick and a stone ground floor are
// both matte masonry, and asking an author to set roughness per override would
// be a material editor, which this is not.

import * as THREE from 'three'
import { CELL_SLOTS } from './textureSlots.js'

/** Roughness and metalness per slot. The one place the preview's look is set. */
const FINISH = {
  // Flat and matte, so a setback or a batter reads as geometry rather than as
  // shading - the argument the original inline materials made.
  wall: { roughness: 0.85, metalness: 0 },
  // A shade shinier: a cornice's whole job is to catch the light, and at the
  // wall's roughness it disappears into the wall.
  trim: { roughness: 0.6, metalness: 0.05 },
  roof: { roughness: 0.9, metalness: 0 },
  opening: { roughness: 0.4, metalness: 0.1 },
  door: { roughness: 0.4, metalness: 0.1 },
  accent: { roughness: 0.9, metalness: 0 },
}

const DEFAULT_FINISH = { roughness: 0.8, metalness: 0 }

/**
 * Build a material for every entry in ir.materials.
 *
 * `textures` is the map loadBuildingTextures returns - material index to
 * THREE.Texture - and a missing entry simply means the slot draws in its palette
 * colour, which is what an unbound slot and a broken one both do.
 */
export function buildMaterials(ir, textures = {}) {
  return (ir?.materials || []).map((entry, index) => {
    const finish = FINISH[entry.slot] || DEFAULT_FINISH
    const map = textures[index] || null
    return new THREE.MeshStandardMaterial({
      // A TEXTURE IS THE SURFACE; THE COLOUR IS WHAT YOU SEE WITHOUT ONE.
      //
      // This multiplied the texture by the palette colour, on the VFX sprite
      // kit's reasoning that a neutral image would then take the style's hue.
      // That reasoning does not hold here: building textures are generated as
      // "photographic material sample" - see TILEABLE_SUFFIX - so they arrive in
      // their own colours, and multiplying only ever darkens them. On the WALL
      // slot that cost about 20% and looked like flat lighting. On the OPENING
      // slot, whose colour is a near-black stand-in for glass (#2f3a44), it
      // destroyed the texture outright: a window texture bound to a facade
      // rendered as a black hole, which is how it was reported.
      //
      // So a mapped material draws its texture as itself, and the palette colour
      // is what an unbound slot shows. That is also what the Colours panel says
      // it does.
      color: map ? '#ffffff' : (entry.color || '#c9cdd4'),
      map,
      // ALPHA IS HONOURED ON A CELL SLOT, so a window PNG cut out around its
      // arch shows the wall through the corners instead of a black rectangle.
      // That is nearly always what a window image is: the asset is one object on
      // a transparent ground, not a material that fills a rectangle.
      //
      // alphaTest AND transparent, which is not the usual either/or:
      //   - alphaTest DISCARDS the fully transparent ground. Discarded fragments
      //     never reach the depth buffer, so the cut-out corners cannot occlude
      //     the wall behind them - which is exactly the artefact a blend-only
      //     material produces here.
      //   - transparent then lets PARTIAL alpha blend, so leaded glass reads as
      //     glass rather than snapping to opaque or vanishing at a threshold.
      // The threshold is low on purpose: anything the author painted at all is
      // meant to be seen, and only the true zero is background.
      //
      // depthWrite stays ON. The usual reason to turn it off is to let several
      // transparent surfaces blend in any order, and that trade is wrong here:
      // openings are instanced in their thousands and lie flat on the walls, so
      // they scarcely overlap each other, while losing depth writes would let a
      // window on the far side of the building draw over the near wall.
      ...(map && CELL_SLOTS.has(entry.slot)
        ? { transparent: true, alphaTest: 0.05, depthWrite: true }
        : null),
      roughness: finish.roughness,
      metalness: finish.metalness,
    })
  })
}

/**
 * The materials a geometry's draw groups need, in group order.
 *
 * A geometry built with no groups at all - nothing was drawn - gets a single
 * fallback so a consumer never hands three.js an empty material array, which
 * renders as nothing with no error.
 */
export function materialsForGroups(groups, materials) {
  if (!groups?.length) return materials[0] || new THREE.MeshStandardMaterial()
  return groups.map(index => materials[index] || materials[0] || new THREE.MeshStandardMaterial())
}

/** Dispose a list of materials. Every one is a GPU allocation. */
export function disposeMaterials(materials) {
  for (const material of materials || []) material?.dispose?.()
}
