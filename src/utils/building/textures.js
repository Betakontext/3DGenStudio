// Turning the IR's material slots into three.js textures.
//
// WHY THIS IS NOT IN mesh.js. Meshing is synchronous and pure: an IR goes in, a
// BufferGeometry comes out, and a plain node test can run it. Loading a texture
// is neither - it is a fetch, then a decode, then a GPU upload, and it can fail
// halfway. Keeping the two apart is what lets the geometry tests stay headless.
//
// TILING IS IN METRES, WHICH IS THE WHOLE POINT. mesh.js UV-maps walls as
// (run, height) in metres and caps as plan metres - see its header - so a
// texture's repeat is simply 1/tileMetres and a brick wall is the same size on a
// cottage and on a tower. The obvious alternative, normalising UVs per face,
// makes every wall show exactly one tile and a forty-storey tower wear one
// enormous brick.

import * as THREE from 'three'
import { resolveAssetImageUrl } from '../buildingApi'
import { tilesByMetres } from './textureSlots.js'

/** Metres per tile when a reference does not say. One storey of brick, roughly. */
export const DEFAULT_TILE_METRES = 2

const loader = new THREE.TextureLoader()

/**
 * Load one texture and configure it for tiling.
 *
 * Wrapping and colour space are set HERE rather than at the material, because
 * they are properties of the image: an albedo map is sRGB and a tiling map
 * repeats, whoever ends up using it. Getting the colour space wrong is a
 * washed-out building that looks like a lighting bug.
 */
function loadTexture(url, tileMetres, tiles = true, tileMetresY = 0) {
  return new Promise(resolve => {
    loader.load(
      url,
      texture => {
        if (tiles) {
          texture.wrapS = THREE.RepeatWrapping
          texture.wrapT = THREE.RepeatWrapping
          const tile = tileMetres > 0 ? tileMetres : DEFAULT_TILE_METRES
          // THE TWO AXES ARE SET SEPARATELY. A roof of wide, short courses and a
          // wall of tall, narrow boards are the same image at different aspects,
          // and forcing one number on both made every such texture wrong in one
          // direction. Zero on the second means square, which is what one number
          // always meant.
          const tileV = tileMetresY > 0 ? tileMetresY : tile
          texture.repeat.set(1 / tile, 1 / tileV)
        } else {
          // FILLS THE CELL. An opening's box is UV-mapped 0..1 across the hole,
          // so repeating by metres shows a fraction of the image - which is how
          // a window texture came out as the bottom-left corner of a window.
          // Clamped rather than repeated as well, so the reveals at the sides of
          // the box carry the edge of the image instead of a second copy of it.
          texture.wrapS = THREE.ClampToEdgeWrapping
          texture.wrapT = THREE.ClampToEdgeWrapping
          texture.repeat.set(1, 1)
        }
        texture.colorSpace = THREE.SRGBColorSpace
        texture.anisotropy = 4
        resolve(texture)
      },
      undefined,
      () => resolve(null),
    )
  })
}

/**
 * Every bound texture in an IR, as a slot -> THREE.Texture map.
 *
 * Returns only the slots that actually LOADED. A slot whose asset was deleted
 * comes back absent rather than as a null the renderer has to test for, and the
 * material then falls back to its palette colour - which is the same thing it
 * does when no texture was ever bound, and is why an untextured building and a
 * broken one look the same rather than one of them looking broken.
 */
export async function loadBuildingTextures(ir) {
  // KEYED BY MATERIAL INDEX, not by slot name. Once a facade can override the
  // wall on its own storeys and on one side of them, there are several different
  // wall textures in a building and "the wall texture" stops being a thing.
  const out = {}
  const wanted = (ir?.materials || [])
    .map((material, index) => ({ material, index }))
    .filter(entry => entry.material.ref)
  if (!wanted.length) return out

  await Promise.all(wanted.map(async ({ material, index }) => {
    const url = await resolveAssetImageUrl(material.ref)
    // SAID OUT LOUD. A bound slot that renders as flat colour is indistinguish-
    // able from an unbound one, and the two have completely different causes -
    // a deleted asset, a path the static route does not serve, a decode
    // failure. The console is the only place that difference can surface
    // without putting an error banner on a preview.
    if (!url) {
      console.warn(`Building texture: ${material.ref} (${material.slot}) has no file.`)
      return
    }
    const texture = await loadTexture(
      url, material.tile, tilesByMetres(material.slot), material.tileY,
    )
    if (texture) out[index] = texture
    else console.warn(`Building texture: ${material.slot} failed to load from ${url}`)
  }))
  return out
}

/** Dispose a map of textures. Every one is a GPU allocation. */
export function disposeTextures(textures) {
  for (const texture of Object.values(textures || {})) texture?.dispose?.()
}

/**
 * What changed between two IRs' texture bindings, as a stable key.
 *
 * The preview rebuilds geometry on every keystroke; reloading five textures at
 * that rate would swamp the network and churn the GPU. Comparing this key means
 * a slider drag reuses the textures it already has.
 */
export function textureKeyOf(ir) {
  return (ir?.materials || [])
    .map((material, index) => (material.ref
      ? `${index}:${material.ref}:${material.tile}:${material.tileY}`
      : ''))
    .filter(Boolean)
    .join('|')
}
