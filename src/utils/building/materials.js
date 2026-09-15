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
    return new THREE.MeshStandardMaterial({
      color: entry.color || '#c9cdd4',
      // A texture MULTIPLIES the colour rather than replacing it, so a neutral
      // generated image keeps the style's hue - the rule the VFX sprite kit
      // settled on and the reason generated textures are steered neutral.
      map: textures[index] || null,
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
