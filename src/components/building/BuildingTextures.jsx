// A list of material slots that can be filled with a texture.
//
// GENERIC OVER THE ROWS, because the same list appears twice with different
// scopes: the building-wide slots in the sidebar, and a Facade node's own
// overrides in the inspector. They differ only in which reference KEYS they
// write, so one component takes the rows and the two callers describe them.
//
// FIVE BUILDING-WIDE SLOTS, NOT A MATERIAL GRAPH. A building has a wall, a trim,
// a roof, and whatever fills its window and door openings - and that is the
// whole of what a style pack binds. Offering a PBR stack per surface would be
// more expressive and would also be the point at which this stops being a
// building generator and starts being a material editor.
//
// EACH ROW IS A REFERENCE KEY, resolved through doc.references - invariant 3.
// The node graph never names an asset; it names a slot, and the table says what
// is in it. That is what gives bundling one place to walk, project import one
// place to remap, and a deleted texture a reportable dangling key rather than an
// untraceable id.
//
// Two ways to fill one, because both are normal: generate it from a prompt, or
// pick an image already in the library. Neither is privileged.

import { useState } from 'react'
import AssetSelectorModal from '../AssetSelectorModal'
import { SLOT_GUIDE } from '../../utils/building/textureSlots'
import { buildingFileUrl } from '../../utils/buildingApi'
import './BuildingTextures.css'

/**
 * @param {Object} props
 * @param {Object} props.doc
 * @param {Array<{refKey: string, guideSlot: string, label: string, hint?: string,
 *   indent?: boolean, fallback?: string}>} props.rows
 * @param {string} [props.title]
 * @param {(refKey: string, asset: Object) => void} props.onBind
 * @param {(refKey: string) => void} props.onClear
 * @param {(refKey: string, guideSlot: string) => void} props.onGenerate
 * @param {string} [props.note]
 */
export default function BuildingTextures({
  doc, rows, title, onBind, onClear, onGenerate, note,
}) {
  const [picking, setPicking] = useState(null)

  const pick = asset => {
    const row = picking
    setPicking(null)
    if (!row || !asset) return
    // The library hands back ids in several shapes depending on the route;
    // the reference table stores the bare number - invariant 4 in doc.js.
    const assetId = Number(String(asset.id ?? asset.assetId ?? '').replace('library:', ''))
    if (!Number.isFinite(assetId)) return
    onBind(row.refKey, {
      assetId,
      name: asset.name || SLOT_GUIDE[row.guideSlot]?.label || 'Texture',
      tile: SLOT_GUIDE[row.guideSlot]?.tile || 2,
      url: buildingFileUrl(asset),
    })
  }

  return (
    <div className="btex">
      {title && <h2 className="buildinggen__title">{title}</h2>}
      <ul className="btex__list">
        {rows.map(row => {
          const guide = SLOT_GUIDE[row.guideSlot] || {}
          const entry = doc.references[row.refKey]
          const bound = Boolean(entry?.ref)
          return (
            <li
              key={row.refKey}
              className={`btex__slot ${row.indent ? 'btex__slot--sub' : ''}`}
              title={row.hint || guide.hint}
            >
              <span className={`btex__chip ${bound ? 'btex__chip--on' : ''}`}>
                <span className="material-symbols-outlined">
                  {bound ? 'texture' : 'add_photo_alternate'}
                </span>
              </span>
              <span className="btex__text">
                <span className="btex__label">{row.label}</span>
                <span className="btex__state">
                  {bound
                    ? `${entry.name || 'bound'} · ${entry.tileMetres}m tile`
                    // An unfilled row is not empty, it INHERITS. Saying which is
                    // the difference between a slot that does nothing and one
                    // deliberately left to the level above it.
                    : row.fallback || 'palette colour only'}
                </span>
              </span>
              <span className="btex__buttons">
                <button
                  type="button"
                  onClick={() => onGenerate(row.refKey, row.guideSlot)}
                  title={`Generate a ${row.label.toLowerCase()} texture with ComfyUI`}
                >
                  <span className="material-symbols-outlined">auto_awesome</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPicking(row)}
                  title="Pick an image from the library"
                >
                  <span className="material-symbols-outlined">photo_library</span>
                </button>
                {bound && (
                  <button
                    type="button"
                    onClick={() => onClear(row.refKey)}
                    title="Clear this slot"
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {note && <p className="btex__note">{note}</p>}

      {picking && (
        <AssetSelectorModal
          assetType="image"
          title={`Pick a ${picking.label.toLowerCase()} texture`}
          showEdits
          onSelect={pick}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  )
}
