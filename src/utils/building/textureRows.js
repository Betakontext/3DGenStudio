// The rows BuildingTextures draws, for each of the two scopes.
//
// SEPARATE FROM THE COMPONENT because the fallback wording is the part that
// makes the three-level chain understandable, and it is easier to keep honest in
// one small function than spread through JSX. A row that says "palette colour
// only" and a row that says "same as the building" look identical in the UI and
// mean completely different things.
//
// THE CHAIN, most specific first:
//
//   <facade>.wall.north   this facade's storeys, north side only
//   <facade>.wall         this facade's storeys, every side
//   tex_wall              the whole building
//   the palette colour    no texture at all
//
// A Trim node has the same shape with one fewer rung: <trim>.trim, then tex_trim,
// then the colour. Trims accumulate, so each run needs its own or a plinth and a
// cornice could never differ.
//
// building/ir.js resolveMaterialIndex is what actually applies it; this file
// only has to describe it truthfully.

import {
  FACADE_TEXTURE_SLOTS, TEXTURE_SLOTS, TRIM_TEXTURE_SLOT, nodeTextureKey, textureKey,
} from '../../../building/stylepack.js'
import { SIDE_LABEL, SIDE_ORDER } from '../../../building/sides.js'
import { SLOT_GUIDE } from './textureSlots'

/** The building-wide slots, which everything else falls back to. */
export function buildingTextureRows() {
  return TEXTURE_SLOTS.map(slot => ({
    refKey: textureKey(slot),
    guideSlot: slot,
    label: SLOT_GUIDE[slot]?.label || slot,
    hint: SLOT_GUIDE[slot]?.hint,
  }))
}

/**
 * One Facade node's overrides: two slots, each with four optional sides.
 *
 * The side rows are only listed when `expanded`, because eight extra rows in a
 * narrow inspector for something most buildings never use would bury the two
 * that matter.
 */
export function facadeTextureRows(doc, nodeId, { expanded = false } = {}) {
  const rows = []
  for (const slot of FACADE_TEXTURE_SLOTS) {
    const guide = SLOT_GUIDE[slot] || {}
    const facadeKey = nodeTextureKey(nodeId, slot)
    const hasFacade = Boolean(doc.references[facadeKey]?.ref)
    rows.push({
      refKey: facadeKey,
      guideSlot: slot,
      label: guide.label || slot,
      hint: `${guide.hint || ''} Applies to the storeys this Facade covers.`.trim(),
      fallback: 'same as the building',
    })
    if (!expanded) continue
    for (const side of SIDE_ORDER) {
      rows.push({
        refKey: nodeTextureKey(nodeId, slot, side),
        guideSlot: slot,
        label: SIDE_LABEL[side],
        indent: true,
        hint: `${guide.label || slot} on the ${SIDE_LABEL[side].toLowerCase()} side only.`,
        // The fallback names the level immediately above, not the bottom of the
        // chain: a side row falls back to its facade if that is set, and only
        // then to the building.
        fallback: hasFacade ? 'same as this facade' : 'same as the building',
      })
    }
  }
  return rows
}

/** Whether a Facade node has any per-side binding at all, so the UI can open. */
export function hasSideOverrides(doc, nodeId) {
  for (const slot of FACADE_TEXTURE_SLOTS) {
    for (const side of SIDE_ORDER) {
      if (doc.references[nodeTextureKey(nodeId, slot, side)]?.ref) return true
    }
  }
  return false
}

/**
 * One Trim node's override: a single row.
 *
 * No per-side variant, unlike a facade, and for a geometric reason rather than a
 * scoping one - see TRIM_TEXTURE_SLOT in stylepack.js. A run is one closed loop
 * that mitres at every corner, so a material change part-way round would fall
 * inside a mitred joint.
 */
export function trimTextureRows(doc, nodeId) {
  const guide = SLOT_GUIDE.trim || {}
  return [{
    refKey: nodeTextureKey(nodeId, TRIM_TEXTURE_SLOT),
    guideSlot: TRIM_TEXTURE_SLOT,
    label: guide.label || 'Trim',
    hint: 'This run only. Other Trim nodes keep their own.',
    fallback: 'same as the building',
  }]
}
