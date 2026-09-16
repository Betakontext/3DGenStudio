// A list of material and model slots, each holding a LIST of assets.
//
// GENERIC OVER THE ROWS, because the same list appears three times with
// different scopes: the building-wide slots in the sidebar, the openings' models,
// and a Facade or Trim node's own overrides in the inspector. They differ only
// in which reference KEYS they write, so one component takes the rows and the
// callers describe them.
//
// A SLOT HOLDS SEVERAL ASSETS, NOT ONE, and that is the whole point of the list:
// give a style three bricks and three window models and a street of these stops
// looking like one building copied. The compiler rolls the choice from the
// document's seed - see building/compile.js pickReference - so re-rolling the
// seed re-rolls the building. Openings roll PER OPENING, textures once per
// building, because a building wears one brick and shows many windows.
//
// EACH ENTRY IS A REFERENCE KEY, `<slot>.<n>`, resolved through doc.references -
// invariant 3. The node graph never names an asset; it names a slot, and the
// table says what is in it. That is what gives bundling one place to walk,
// project import one place to remap, and a deleted asset a reportable dangling
// key rather than an untraceable id.

import { useState } from 'react'
import AssetSelectorModal from '../AssetSelectorModal'
import { referenceListKeys } from '../../../building/doc.js'
import { SLOT_GUIDE, tilesByMetres } from '../../utils/building/textureSlots'
import { buildingFileUrl } from '../../utils/buildingApi'
import './BuildingTextures.css'

/**
 * @param {Object} props
 * @param {Object} props.doc
 * @param {Array<{refKey: string, guideSlot: string, label: string, hint?: string,
 *   indent?: boolean, fallback?: string, warn?: string, assetType?: string}>} props.rows
 *   `refKey` is the slot PREFIX; entries live at `<refKey>.<n>`.
 * @param {string} [props.title]
 * @param {(refKey: string, assets: Array<Object>) => void} props.onAdd
 * @param {(entryKey: string) => void} props.onRemove
 * @param {(entryKey: string, rotation: Array<number>) => void} [props.onRotate]
 *   Models only. Degrees about X, Y and Z.
 * @param {(refKey: string, guideSlot: string) => void} props.onGenerate
 * @param {string} [props.note]
 */
export default function BuildingTextures({
  doc, rows, title, onAdd, onRemove, onGenerate, onRotate, note,
}) {
  const [picking, setPicking] = useState(null)

  const pick = chosen => {
    const row = picking
    setPicking(null)
    if (!row || !chosen) return
    // `multiple` makes the modal hand back an ARRAY; a single-select caller
    // still gets one asset, so both shapes have to be accepted.
    const list = Array.isArray(chosen) ? chosen : [chosen]
    const assets = list.map(asset => {
      // The library hands back ids in several shapes depending on the route;
      // the reference table stores the bare number - invariant 4 in doc.js.
      const assetId = Number(String(asset.id ?? asset.assetId ?? '').replace('library:', ''))
      if (!Number.isFinite(assetId)) return null
      return {
        assetId,
        name: asset.name || SLOT_GUIDE[row.guideSlot]?.label || 'Asset',
        tile: SLOT_GUIDE[row.guideSlot]?.tile || 2,
        kind: row.assetType === 'mesh' ? 'mesh' : 'image',
        url: buildingFileUrl(asset),
      }
    }).filter(Boolean)
    if (assets.length) onAdd(row.refKey, assets)
  }

  return (
    <div className="btex">
      {title && <h2 className="buildinggen__title">{title}</h2>}
      <ul className="btex__list">
        {rows.map(row => {
          const guide = SLOT_GUIDE[row.guideSlot] || {}
          const entryKeys = referenceListKeys(doc.references, row.refKey)
          const entries = entryKeys.map(key => ({ key, entry: doc.references[key] }))
          const filled = entries.filter(({ entry }) => entry?.ref)
          const isMesh = row.assetType === 'mesh'
          return (
            <li key={row.refKey} className="btex__group">
              <div
                className={`btex__slot ${row.indent ? 'btex__slot--sub' : ''}`}
                title={row.hint || guide.hint}
              >
                <span className={`btex__chip ${filled.length ? 'btex__chip--on' : ''}`}>
                  <span className="material-symbols-outlined">
                    {filled.length ? (isMesh ? 'deployed_code' : 'texture') : 'add_photo_alternate'}
                  </span>
                </span>
                <span className="btex__text">
                  <span className="btex__label">{row.label}</span>
                  <span className="btex__state">
                    {filled.length === 0
                      // An unfilled row is not empty, it INHERITS. Saying which is
                      // the difference between a slot that does nothing and one
                      // deliberately left to the level above it.
                      ? (row.fallback || 'palette colour only')
                      : filled.length === 1
                        ? (isMesh
                          ? (filled[0].entry.name || 'a model')
                          // A CELL SLOT HAS NO TILE SIZE: an opening's texture fills
                          // the hole rather than repeating by metres, and printing
                          // "1.5m tile" beside it describes something the renderer
                          // does not do.
                          : `${filled[0].entry.name || 'bound'} · ${
                            tilesByMetres(row.guideSlot)
                              ? `${filled[0].entry.tileMetres}m tile`
                              : 'fills the opening'}`)
                        // The COUNT, because that is the thing that changes the
                        // building: one asset is a choice, several are a roll.
                        : `${filled.length} ${isMesh ? 'models' : 'textures'}, picked by seed`}
                  </span>
                </span>
                <span className="btex__buttons">
                  {/* No Generate on a model row: ComfyUI makes images here, and a
                      button that could only ever fail is worse than no button. */}
                  {!isMesh && (
                    <button
                      type="button"
                      onClick={() => onGenerate(row.refKey, row.guideSlot)}
                      title={`Generate a ${row.label.toLowerCase()} texture with ComfyUI`}
                    >
                      <span className="material-symbols-outlined">auto_awesome</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPicking(row)}
                    title={filled.length
                      ? 'Add more to this slot - one is picked per building from the seed'
                      : 'Pick from the library'}
                  >
                    <span className="material-symbols-outlined">
                      {filled.length ? 'add' : 'photo_library'}
                    </span>
                  </button>
                </span>
              </div>

              {/* WHY THIS SLOT DOES NOTHING, when that is true whether or not
                  something is bound. `fallback` above speaks only for an empty
                  row, so a model bound into a slot the graph never places would
                  otherwise show a name and change nothing. */}
              {row.warn && <p className="btex__warn">{row.warn}</p>}

              {/* A MODEL ALWAYS LISTS ITS ENTRIES, however few, because each one
                  carries a rotation and there is nowhere else to put it. An
                  image row keeps the old rule - the entries only appear once
                  there is more than one to tell apart, since a single binding is
                  already named on the row above. */}
              {(isMesh || filled.length > 1) && filled.map(({ key, entry }) => (
                <div key={key} className={`btex__entry ${isMesh ? 'btex__entry--mesh' : ''}`}>
                  <span className="btex__entry-name">{entry.name || entry.ref}</span>
                  {/* THREE ANGLES, in degrees, applied BEFORE the model is fitted
                      to its opening - see slotMeshes.normalise. A balcony
                      exported lying down is the case this exists for. */}
                  {isMesh && onRotate && (
                    <span className="btex__rot">
                      {['X', 'Y', 'Z'].map((axis, index) => (
                        <label key={axis} className="btex__rot-axis" title={`Turn about ${axis}`}>
                          <span>{axis}</span>
                          <input
                            type="number"
                            step="15"
                            value={entry.rotation?.[index] ?? 0}
                            onChange={event => {
                              const next = [0, 1, 2].map(i => entry.rotation?.[i] ?? 0)
                              next[index] = Number(event.target.value) || 0
                              onRotate(key, next)
                            }}
                          />
                        </label>
                      ))}
                    </span>
                  )}
                  <button
                    type="button"
                    className="btex__entry-del"
                    onClick={() => onRemove(key)}
                    title={filled.length > 1 ? 'Remove this one from the slot' : 'Clear this slot'}
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
              ))}

              {!isMesh && filled.length === 1 && (
                <div className="btex__entry btex__entry--only">
                  <button
                    type="button"
                    onClick={() => onRemove(filled[0].key)}
                    title="Clear this slot"
                  >
                    <span className="material-symbols-outlined">close</span>
                    Clear
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {note && <p className="btex__note">{note}</p>}

      {picking && (
        <AssetSelectorModal
          assetType={picking.assetType || 'image'}
          title={picking.assetType === 'mesh'
            ? `Pick ${picking.label.toLowerCase()} models`
            : `Pick ${picking.label.toLowerCase()} textures`}
          // ALWAYS TRUE, for meshes as well as images. It is what makes the
          // modal list a parent's children - a mesh's LOD versions, an image's
          // edits - and a mesh library where every version is invisible is most
          // of the library missing.
          showEdits
          // Several at once: a slot holds a list, so picking one at a time and
          // reopening the modal N times is the wrong shape for the job.
          multiple
          onSelect={pick}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  )
}
