// Transport for building assets: save, load, list.
//
// A plain fetch module rather than functions on ProjectContext, because
// buildings are LIBRARY-GLOBAL. The rule is written in the header of
// src/utils/assemblyApi.js: a global resource lives here, not in the project
// data layer. Tree presets and VFX graphs do the same, and this file is
// deliberately shaped like src/utils/vfxApi.js.
//
// WHY A BUILDING IS LIBRARY-GLOBAL, since it constrains everything below: a
// building binds facade textures, trim sheets and window meshes that routinely
// come from different projects, so tying the document to one of them would be
// arbitrary. The consequence to know about is that a Building asset does NOT
// appear in `GET /api/assets?projectId=` - that query drives the Kanban board
// and the graph canvas and is hardcoded to Image and Mesh. The Assets page reads
// buildings from /api/assets/library instead, as it does for tree presets.
//
// EVERY CALL REUSES AN EXISTING ROUTE. There is no /api/buildings. Create is
// library-upload, save-in-place is :id/replace, load is :id/record plus a fetch
// of the file. That is not a shortcut: those routes already carry the ownership
// checks, the remote-mode forwarding and the upload staging, and a new prefix
// would have to be added to serverMode.js's classification and would be a
// fourth place to forget.
//
// THE TWO MULTIPART DIALECTS ARE A REAL TRAP, and hiding them is most of the
// reason this file exists. library-upload takes loose form fields; :id/replace
// takes ONE `payload` JSON part and accepts the thumbnail in the same request.
// Getting them the wrong way round produces a 400 that says nothing useful.

import { API_BASE, assetUrl } from '../config.js'
import {
  buildingAssetDigest,
  normalizeBuildingDoc,
  serializeBuildingDoc,
} from '../../building/doc.js'
// Borrowed from the VFX library helper rather than reimplemented. Neither
// function is VFX-specific - they decode an /api/assets/library listing, whose
// two awkward facts (a root's id is the string `library:<n>` while a child's is
// a bare number; an edit is its own row with its own file) are documented in
// that file and have already been got wrong by hand elsewhere. Aliased on import
// so nothing below reads as if buildings were part of the VFX feature.
import { vfxAssetId as libraryAssetId } from './vfx/library.js'

/** The asset type name, lower-cased as it travels on the wire. */
export const BUILDING_ASSET_TYPE = 'building'

export { libraryAssetId }

/**
 * The URL a building document's bytes are served from.
 *
 * Handles every shape a stored path arrives in, because a listing row, an
 * ingest response and an asset record do not agree on the field name.
 */
export function buildingFileUrl(asset) {
  const raw = asset?.url || asset?.filename || asset?.filePath || ''
  if (!raw) return null
  const text = String(raw)
  if (/^(https?:|data:|blob:)/.test(text)) return text
  return assetUrl(text.replace(/\\/g, '/').replace(/^\/?(?:data\/)?assets\//, '').replace(/^\/+/, ''))
}

/**
 * Every building in the library.
 * @returns {Promise<Array<Object>>}
 */
export async function listBuildingAssets() {
  const response = await fetch(`${API_BASE}/assets/library`)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || 'Could not list buildings')
  return Array.isArray(payload?.buildings) ? payload.buildings : []
}

/**
 * One asset's record, by id.
 *
 * @param {number|string} assetId
 * @returns {Promise<Object>}
 */
export async function getBuildingAssetRecord(assetId) {
  const id = libraryAssetId(assetId)
  if (id == null) throw new Error(`"${assetId}" is not a valid asset id.`)
  const response = await fetch(`${API_BASE}/assets/record?assetId=${id}`)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || 'Could not read that building')

  // This route returns the RAW database row - it does not go through
  // mapAssetRow the way the listings do - so `metadata` arrives as a JSON
  // STRING rather than an object. Parsing it here means every caller gets the
  // same shape whichever route the record came from.
  if (typeof payload?.metadata === 'string') {
    try {
      payload.metadata = JSON.parse(payload.metadata)
    } catch {
      payload.metadata = {}
    }
  }
  return payload
}

/**
 * Read a building document back, by asset id or by an asset row.
 *
 * @param {number|string|Object} target
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{doc: Object, record: Object|null}>}
 */
export async function loadBuildingAsset(target, options = {}) {
  let record = null
  let url = typeof target === 'object' ? buildingFileUrl(target) : null

  if (!url) {
    record = await getBuildingAssetRecord(target)
    url = buildingFileUrl(record)
  }
  if (!url) throw new Error('That building has no stored file.')

  // cache: 'reload' because a stale copy here is indistinguishable from a save
  // that did not take. Note that /replace assigns a NEW filePath even though it
  // keeps the asset id, so a caller holding an old row's url is reading the
  // previous version - always resolve through the record after a save.
  const response = await fetch(url, { signal: options.signal, cache: 'reload' })
  if (!response.ok) throw new Error(`Could not read that building (${response.status}).`)
  const raw = await response.json()

  if (raw?.kind && raw.kind !== 'building-graph') throw new Error('That file is not a building.')
  return { doc: normalizeBuildingDoc(raw), record }
}

/**
 * Save a building. Creates a new asset, or replaces an existing one in place.
 *
 * Replace rather than always-fork: an editor that can only ever fork is not an
 * editor. Keeping the id is what makes the Assets page's Edit link and any saved
 * reference keep resolving.
 *
 * @param {Object} params
 * @param {string} params.name
 * @param {Object} params.doc the building document
 * @param {File|Blob|null} [params.thumbnail]
 * @param {number|string|null} [params.assetId] replace this asset when given
 * @returns {Promise<Object>} the saved asset row
 */
export async function saveBuildingAsset({ name, doc, thumbnail = null, assetId = null }) {
  const safeName = String(name || 'Building').trim() || 'Building'
  // The name travels in the document as well as in the form field, so a file
  // opened on its own - imported into another install, say - still knows what it
  // is called. Normalising before the digest means both describe the same bytes.
  const document = normalizeBuildingDoc({ ...doc, name: safeName, savedAt: Date.now() })
  const metadata = buildingAssetDigest(document)

  const file = new File(
    [serializeBuildingDoc(document)],
    `${safeName.replace(/[^\w.-]+/g, '_')}.building.json`,
    { type: 'application/json' },
  )

  const id = libraryAssetId(assetId)
  if (assetId && id == null) throw new Error(`"${assetId}" is not a valid asset id.`)

  if (id != null) {
    // The replace dialect: one `payload` part, and the thumbnail rides along.
    const form = new FormData()
    form.append('file', file)
    if (thumbnail) form.append('thumbnail', thumbnail)
    form.append('payload', JSON.stringify({ name: safeName, type: BUILDING_ASSET_TYPE, metadata }))
    const response = await fetch(`${API_BASE}/assets/${id}/replace`, { method: 'POST', body: form })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload?.error || 'Could not update the building')
    return payload
  }

  // The library-upload dialect: loose fields, and the thumbnail is a follow-up.
  const form = new FormData()
  form.append('file', file)
  form.append('type', BUILDING_ASSET_TYPE)
  form.append('name', safeName)
  form.append('metadata', JSON.stringify(metadata))

  const response = await fetch(`${API_BASE}/assets/library-upload`, { method: 'POST', body: form })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || 'Could not save the building')

  if (thumbnail && payload?.id) {
    // Cosmetic, and the building is already saved - so a failed thumbnail must
    // never surface as a failed save.
    const thumbForm = new FormData()
    thumbForm.append('thumbnail', thumbnail)
    await fetch(`${API_BASE}/assets/${payload.id}/thumbnail`, {
      method: 'POST',
      body: thumbForm,
    }).catch(() => null)
  }
  return payload
}
