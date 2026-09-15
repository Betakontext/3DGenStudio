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
  FACADE_BALCONY_SLOT, FACADE_MESH_SLOT, FACADE_TEXTURE_SLOTS, MESH_SLOTS,
  TEXTURE_SLOTS, TRIM_TEXTURE_SLOT,
  meshKey, nodeTextureKey, textureKey,
} from '../../../building/stylepack.js'
import { referenceListKeys } from '../../../building/doc.js'
import { SIDE_LABEL, SIDE_ORDER } from '../../../building/sides.js'
import { SLOT_GUIDE } from './textureSlots.js'

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
    const hasFacade = referenceListKeys(doc.references, facadeKey).length > 0
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

/**
 * One Facade node's opening MODELS: its own list, plus four optional sides.
 *
 * The same shape as its texture overrides and the same chain - a side beats the
 * facade beats the building-wide list for the tag. Not keyed on the tag, so
 * switching the Facade from Window to Arch keeps the binding; see
 * FACADE_MESH_SLOT for why.
 */
export function facadeMeshRows(doc, nodeId, { expanded = false, balconies = false } = {}) {
  const group = (slot, label, what, idle = '', warn = '') => {
    const hasFacade = referenceListKeys(doc.references, nodeTextureKey(nodeId, slot)).length > 0
    const rows = [{
      refKey: nodeTextureKey(nodeId, slot),
      guideSlot: 'opening',
      assetType: 'mesh',
      label,
      hint: `The model placed on this facade’s ${what}, on every side.`,
      fallback: idle || 'same as the building',
      warn,
    }]
    if (!expanded) return rows
    for (const side of SIDE_ORDER) {
      rows.push({
        refKey: nodeTextureKey(nodeId, slot, side),
        guideSlot: 'opening',
        assetType: 'mesh',
        label: SIDE_LABEL[side],
        indent: true,
        hint: `The model on the ${SIDE_LABEL[side].toLowerCase()} side of this facade only.`,
        fallback: idle || (hasFacade ? 'same as this facade' : 'same as the building'),
      })
    }
    return rows
  }

  // BOTH GROUPS, ALWAYS. A facade places openings AND balconies, so it binds two
  // models, and the first version of this hid the balcony group whenever the
  // Balconies mode was None - which is its default. That read as the feature not
  // existing rather than as a setting being off, and it is the failure the user
  // reported. An idle row that SAYS why it is idle teaches; a missing one does
  // not, and the row is still bindable, so a model chosen now is waiting when
  // the mode is turned on.
  return [
    ...group(FACADE_MESH_SLOT, 'Opening model', 'openings'),
    ...group(FACADE_BALCONY_SLOT, 'Balcony model', 'balconies',
      balconies ? '' : 'nothing to place yet',
      // SAID EVEN WHEN A MODEL IS BOUND, unlike `fallback`, which only speaks
      // for an empty slot. Binding a balcony model to a facade whose Balconies
      // are off puts a name on the row and nothing on the building, which is the
      // same silence in a different disguise.
      balconies ? '' : 'This facade places no balconies — set Balconies above.'),
  ]
}

/** Whether a Facade node has any per-side binding at all, so the UI can open. */
export function hasSideOverrides(doc, nodeId) {
  for (const slot of [...FACADE_TEXTURE_SLOTS, FACADE_MESH_SLOT, FACADE_BALCONY_SLOT]) {
    for (const side of SIDE_ORDER) {
      // A LIST, so ask whether the list has anything - a bare key has not
      // existed since reference slots became lists.
      if (referenceListKeys(doc.references, nodeTextureKey(nodeId, slot, side)).length) {
        return true
      }
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

/**
 * The opening MODELS a document can bind, one row per opening kind.
 *
 * Keyed on the TAG a Facade node gives its openings - window, shopfront, arch,
 * balcony, louvre - rather than on the slot type, because the tag is the thing
 * an author chose and the type is only ever `window` or `door`. A shopfront and
 * an arch are different models on the same building; binding by type would give
 * them one.
 */
export function slotMeshRows() {
  const LABELS = {
    window: 'Window', shopfront: 'Shopfront', arch: 'Arch',
    balcony: 'Balcony', louvre: 'Louvre', door: 'Door',
  }
  return MESH_SLOTS.map(tag => ({
    refKey: meshKey(tag),
    guideSlot: tag === 'door' ? 'door' : 'opening',
    assetType: 'mesh',
    label: LABELS[tag] || tag,
    hint: `The model placed in every ${LABELS[tag] || tag} opening. Scaled to the `
      + 'bay the grammar worked out, so one model fits any wall.',
    fallback: 'a plain box',
  }))
}

/** Whether any opening model is bound, so the section can stay collapsed. */
export function hasSlotMeshes(doc) {
  return MESH_SLOTS.some(tag => referenceListKeys(doc.references, meshKey(tag)).length > 0)
}
