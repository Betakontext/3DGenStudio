// Import an exported building bundle folder into this library.
//
// THE BROWSER DOES THIS, NOT THE SERVER, and that is the one design decision
// here worth defending - because EXPORT is a server route and the symmetry is
// tempting.
//
// Export has to be server-side: a browser can offer one download at a time and
// cannot write a folder of files. READING a folder is the opposite problem. A
// directory picker hands the page real File objects, so every byte the import
// needs is already in the tab - and going through the server instead would mean
// a route that reads the USER's disk while writing the SHARED database, which is
// precisely the split serverMode.js has to special-case for project import.
// Doing it here works identically in local, Electron and Docker-server installs.
//
// It also honours the rule at the top of buildingApi.js: every call reuses an
// existing route. Uploading is /api/assets/library/import and saving the
// building is saveBuildingAsset. There is no /api/building-import.
//
// WHAT MAKES THIS MORE THAN A FILE COPY is the reference remap, and that lives
// in building/bundle.js where it can be tested - see the header there for why a
// slot the bundle could not supply must be EMPTIED rather than left pointing at
// the exporting machine's asset id.
//
// THE UPLOAD ORDER IS NOT THE RESPONSE ORDER. /api/assets/library/import maps
// its files through Promise.all and pushes results as they finish, so
// `imported[i]` is NOT the i-th file sent. Matching by index silently wires
// every slot to the wrong texture, which looks like a working import. So each
// file is given a filename unique within its batch and matched back by name.
//
// Modelled on src/utils/vfx/bundleImport.js, which solved the same problem for
// effects. Kept separate for the reason given in building/bundle.js: the two
// manifests describe different things, and one module would have to be safe for
// both every time either changed.

import {
  BuildingBundleError,
  applyBundleAssets,
  bundleAssetNeeds,
  bundleBuildingName,
  bundleGraphSource,
  bundleThumbnailPath,
  bundleWarnings,
  normalizeBundlePath,
  parseBundleManifest,
  summarizeBundle,
} from '../../../building/bundle.js'
import { normalizeBuildingDoc } from '../../../building/doc.js'

/** Bundle asset kind -> the library type the upload route understands. */
const ASSET_TYPE = { image: 'image', mesh: 'mesh' }

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tga: 'image/x-tga',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'text/plain',
  json: 'application/json',
}

const extensionOf = (path) => {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(path || ''))
  return match ? match[1].toLowerCase() : ''
}

/**
 * The path a picked file sits at, relative to the folder that was chosen.
 *
 * `webkitRelativePath` is what a directory input fills in and it always leads
 * with the picked folder's own name. It is empty for a file that arrived any
 * other way, so the plain name is the fallback.
 */
const relativePathOf = (file) => normalizeBundlePath(file?.webkitRelativePath || file?.name || '')

/** The bare numeric id from whichever shape the library route returned. */
const rowId = (row) => {
  const raw = String(row?.id ?? row?.assetId ?? '').replace(/^library:/, '')
  const id = Number(raw)
  return Number.isFinite(id) && id > 0 ? id : null
}

/**
 * Index a directory selection, finding the bundle root by its manifest.
 *
 * TOLERANT OF WHICH FOLDER WAS PICKED. Export writes `<chosen>/<building>/`, so
 * an author who picks the folder they exported INTO rather than the building
 * folder inside it is making the obvious mistake - and the fix is to look for
 * the manifest rather than to insist. Several manifests means several bundles,
 * which is a question only the user can answer.
 *
 * @param {FileList|File[]} selection
 * @returns {{root: string, files: Map<string, File>, manifestFile: File}}
 */
export function indexBundleFiles(selection) {
  const picked = Array.from(selection || [])
  if (picked.length === 0) throw new BuildingBundleError('No files were selected.')

  const manifests = picked.filter((file) => {
    const path = relativePathOf(file)
    return path === 'manifest.json' || path.endsWith('/manifest.json')
  })
  if (manifests.length === 0) {
    throw new BuildingBundleError(
      'That folder has no manifest.json in it. Choose the folder a building was exported to - '
      + 'the one holding manifest.json, building/ and assets/.',
    )
  }
  // Shallowest first, so a folder that happens to contain another bundle is read
  // from the outside in.
  manifests.sort((a, b) => relativePathOf(a).split('/').length - relativePathOf(b).split('/').length)
  const depth = relativePathOf(manifests[0]).split('/').length
  const shallowest = manifests.filter((file) => relativePathOf(file).split('/').length === depth)
  if (shallowest.length > 1) {
    throw new BuildingBundleError(
      `That folder holds ${shallowest.length} exported buildings. Choose one of them rather than `
      + 'the folder they are all in.',
    )
  }

  const manifestFile = shallowest[0]
  const root = relativePathOf(manifestFile).replace(/manifest\.json$/, '')
  const files = new Map()
  for (const file of picked) {
    const path = relativePathOf(file)
    if (root && !path.startsWith(root)) continue
    files.set(path.slice(root.length), file)
  }
  return { root, files, manifestFile }
}

/**
 * Read a picked folder into everything the dialog needs to describe it, and
 * everything the import needs to perform it.
 *
 * READS, WRITES NOTHING. The dialog shows what is in the bundle before the user
 * commits to installing it, which is the whole reason this is split from
 * importBuildingBundle - an import that starts by uploading six textures and
 * then discovers the manifest is from a newer build has already made a mess.
 *
 * @param {FileList|File[]} selection
 * @returns {Promise<Object>} a bundle handle to pass to importBuildingBundle
 */
export async function readBuildingBundle(selection) {
  const { root, files, manifestFile } = indexBundleFiles(selection)
  const manifest = parseBundleManifest(await manifestFile.text())

  // The graph may be embedded in the manifest or beside it. Both are written, so
  // prefer the embedded copy and fall back to the file - a folder whose
  // manifest was hand-edited still imports the document that is actually there.
  const source = bundleGraphSource(manifest)
  let doc = source.graph
  if (!doc && source.file) {
    const file = files.get(source.file)
    if (!file) {
      throw new BuildingBundleError(`The bundle names ${source.file}, but that file is not in the folder.`)
    }
    try {
      doc = JSON.parse(await file.text())
    } catch {
      throw new BuildingBundleError(`${source.file} is not valid JSON. The bundle may be damaged.`)
    }
  }
  if (!doc) throw new BuildingBundleError('The bundle carries no building document.')

  const thumbnailPath = bundleThumbnailPath(manifest)
  const needs = bundleAssetNeeds(manifest)
  // NAMED BUT NOT PRESENT. The manifest promises a file the folder does not
  // hold - a bundle copied without its assets/ directory, which is the usual
  // way one arrives damaged. Worth saying BEFORE the import, because afterwards
  // it is just a slot that came out empty.
  const missingFiles = needs.filter((need) => need.file && !files.has(need.file))
  return {
    root,
    manifest,
    files,
    doc: normalizeBuildingDoc(doc),
    needs,
    missingFiles,
    name: bundleBuildingName(manifest),
    summary: summarizeBundle(manifest),
    warnings: bundleWarnings(manifest),
    thumbnail: thumbnailPath ? files.get(thumbnailPath) || null : null,
  }
}

/**
 * A filename unique within its upload batch, used to match the response back.
 *
 * See the module header: the route answers out of order, so the name is the only
 * thing that identifies which result belongs to which slot.
 */
export function uploadFilename(need, taken = new Set()) {
  const extension = extensionOf(need.file)
  const stem = String(need.name || need.file.split('/').pop() || 'asset')
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64) || 'asset'

  let candidate = extension ? `${stem}.${extension}` : stem
  let counter = 2
  while (taken.has(candidate.toLowerCase())) {
    candidate = extension ? `${stem}-${counter}.${extension}` : `${stem}-${counter}`
    counter += 1
  }
  taken.add(candidate.toLowerCase())
  return candidate
}

/** The library rows the reuse index considers, by the kinds a bundle can carry. */
async function listLibraryRows(listLibrary) {
  try {
    const library = await listLibrary?.()
    return { image: library?.images || [], mesh: library?.meshes || [] }
  } catch {
    // Reuse is an optimisation. A listing that failed means everything gets
    // uploaded, which is correct - just not thrifty.
    return {}
  }
}

const reuseKey = (kind, name) => `${kind}:${String(name || '').trim().toLowerCase()}`

function indexByName(rows) {
  const index = new Map()
  for (const [kind, list] of Object.entries(rows || {})) {
    for (const row of list || []) {
      const id = rowId(row)
      const key = reuseKey(kind, row?.name)
      // FIRST WINS, so a library holding two "Brick" images reuses the same one
      // every time rather than whichever the listing happened to end on.
      if (id != null && !index.has(key)) index.set(key, id)
    }
  }
  return index
}

/**
 * Install a bundle: its textures and models into the library, then the building.
 *
 * BEST-EFFORT PER FILE, like every other bundle operation in this repo. One
 * texture that will not upload must not cost the author the other five and the
 * building - it costs that one slot, which comes back empty and is reported.
 *
 * @param {Object} bundle from readBuildingBundle
 * @param {Object} options
 * @param {string} [options.name] the name to save the building under
 * @param {boolean} [options.reuseExisting] match library assets by name instead
 *   of uploading a second copy
 * @param {(assets: Array<Object>, opts: Object) => Promise<Object>} options.uploadAssets
 *   ProjectContext's importLibraryAssets
 * @param {() => Promise<Object>} options.listLibrary ProjectContext's getLibraryAssets
 * @param {(spec: Object) => Promise<Object>} options.saveBuilding
 * @param {(step: {done: number, total: number, label: string}) => void} [options.onProgress]
 * @returns {Promise<{asset: Object, name: string, installed: string[],
 *   reused: string[], failed: Object[], missing: Object[]}>}
 */
export async function importBuildingBundle(bundle, {
  name = '',
  reuseExisting = true,
  uploadAssets,
  listLibrary,
  saveBuilding,
  onProgress,
} = {}) {
  const buildingName = String(name || bundle.name || 'Imported building').trim() || 'Imported building'

  // One entry per distinct FILE, not per slot: export dedups by destination, so
  // a stone bound to two plinth runs ships once and must be installed once.
  const byFile = new Map()
  for (const need of bundle.needs) {
    if (!need.file) continue
    if (!byFile.has(need.file)) byFile.set(need.file, need)
  }

  const idsByFile = new Map()
  const installed = []
  const reused = []
  const failed = []
  const total = byFile.size
  let done = 0
  const step = (label) => {
    done += 1
    onProgress?.({ done, total, label })
  }

  if (total > 0) {
    const byName = reuseExisting ? indexByName(await listLibraryRows(listLibrary)) : new Map()

    // Grouped by asset type because the upload route takes ONE assetType for the
    // whole request.
    const batches = new Map()
    const taken = new Set()

    for (const [file, need] of byFile) {
      const existing = byName.get(reuseKey(need.kind, need.name || need.file.split('/').pop()))
      if (existing != null) {
        idsByFile.set(file, existing)
        reused.push(need.name || file)
        step(need.name || file)
        continue
      }
      const blob = bundle.files.get(file)
      if (!blob) {
        failed.push({ ...need, error: 'that file is not in the folder' })
        step(need.name || file)
        continue
      }
      const type = ASSET_TYPE[need.kind] || 'image'
      const filename = uploadFilename(need, taken)
      const upload = new File([blob], filename, { type: MIME[extensionOf(file)] || blob.type })
      if (!batches.has(type)) batches.set(type, [])
      batches.get(type).push({ file, need, filename, upload })
    }

    for (const [type, entries] of batches) {
      let response = null
      try {
        response = await uploadAssets(entries.map((entry) => ({ file: entry.upload })), { assetType: type })
      } catch (err) {
        for (const entry of entries) {
          failed.push({ ...entry.need, error: err?.message || 'the upload failed' })
          step(entry.need.name || entry.file)
        }
        continue
      }
      // BY NAME, NEVER BY INDEX - see the module header.
      const imported = new Map(
        (response?.imported || []).map((row) => [String(row?.name || ''), rowId(row)]),
      )
      const skipped = new Map(
        (response?.skipped || []).map((row) => [String(row?.name || ''), String(row?.reason || '')]),
      )
      for (const entry of entries) {
        const id = imported.get(entry.filename)
        if (id != null) {
          idsByFile.set(entry.file, id)
          installed.push(entry.filename)
        } else {
          failed.push({
            ...entry.need,
            error: skipped.get(entry.filename) || 'the library did not accept it',
          })
        }
        step(entry.need.name || entry.file)
      }
    }
  }

  const { doc, missing } = applyBundleAssets(bundle.doc, bundle.needs, idsByFile)
  const asset = await saveBuilding({ name: buildingName, doc, thumbnail: bundle.thumbnail })

  return { asset, name: buildingName, installed, reused, failed, missing }
}
