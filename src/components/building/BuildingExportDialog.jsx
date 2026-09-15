// Getting a building out of the app.
//
// TWO DIALOGS, NOT ONE, and the split is deliberate. This one does the part only
// a building generator can do: it regenerates the model at several levels of
// detail FROM THE SPEC and saves them to the library as Mesh assets. Everything
// after that - file formats, output folders, collision hulls, FBX for Unreal,
// the game-ready check - is what ExportMeshDialog already does well for every
// mesh in the app, and it is handed the finished object rather than reimplemented
// here.
//
// WHY THE LOD CHAIN IS REGENERATED RATHER THAN SIMPLIFIED: see the header of
// src/utils/building/exportBuilding.js. Short version - a general simplifier
// judges triangles, and the cheapest triangles in a building are the window
// reveals and the cornice, which is exactly the silhouette that makes it read as
// a building. Asking the grammar for fewer bays gives a model that is still
// correct at every level.

import { useCallback, useEffect, useState } from 'react'
import { useProjects } from '../../context/ProjectContext'
import { assetIdOf, saveMeshToLibrary } from '../../utils/buildingApi'
import { exportObject3D } from '../../utils/meshExport'
import { createMeshThumbnailFile } from '../../utils/meshThumbnail'
import { LOD_LEVELS, buildLevel, disposeLevel } from '../../utils/building/exportBuilding'
import { loadBuildingTextures } from '../../utils/building/textures'
import './BuildingExportDialog.css'

const formatCount = n => new Intl.NumberFormat().format(n)

export default function BuildingExportDialog({ doc, name, onClose, onExportFiles }) {
  const { uploadAssetThumbnail } = useProjects()
  const [levels, setLevels] = useState(null)
  const [chosen, setChosen] = useState(() => new Set([0]))
  const [baseName, setBaseName] = useState(name || 'Building')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  // Built once, on open. Four compiles and four mesh builds is a few hundred
  // milliseconds for an ordinary building, and doing it up front means the
  // triangle counts are on screen before anyone has to choose.
  useEffect(() => {
    let alive = true
    let built = []
    ;(async () => {
      try {
        for (const spec of LOD_LEVELS) {
          const level = await buildLevel(doc, spec, loadBuildingTextures)
          if (!alive) { disposeLevel(level); return }
          built = [...built, level]
          setLevels(built)
        }
      } catch (err) {
        if (alive) setError(err?.message || 'The building could not be prepared for export.')
      }
    })()
    return () => {
      alive = false
      for (const level of built) disposeLevel(level)
    }
  }, [doc])

  const toggle = level => setChosen(current => {
    const next = new Set(current)
    if (next.has(level)) next.delete(level)
    else next.add(level)
    // LOD0 is not optional: it is the model, and the rest are reductions of it.
    next.add(0)
    return next
  })

  const saveToLibrary = useCallback(async () => {
    if (!levels?.length) return
    setBusy('saving')
    setError('')
    setDone('')
    try {
      const wanted = levels.filter(level => chosen.has(level.spec.level))
      const glbOf = async (level, assetName) => {
        // A LIST of files, not one - exportObject3D is shaped for formats like
        // OBJ that emit a .obj and a .mtl. GLB is always a single entry.
        const [file] = await exportObject3D(level.object, { format: 'glb', baseName: assetName })
        if (!file?.blob) throw new Error('The exporter produced no GLB.')
        return file.blob
      }
      const statsOf = level => ({
        lod: level.spec.level,
        lodLabel: level.spec.label,
        triangles: level.triangles,
        stats: level.ir.stats,
        stylePackId: doc.building.stylePackId || null,
        savedAt: Date.now(),
      })

      // LOD0 FIRST, AND ON ITS OWN. The coarser levels are saved as VERSIONS of
      // it, which is what the library already means by a mesh's children - so a
      // building is one entry that opens to reveal its LOD chain, rather than
      // four unrelated meshes sitting next to each other with a naming
      // convention as the only thing relating them.
      const full = levels.find(level => level.spec.level === 0)
      const blob = await glbOf(full, baseName)
      const parent = await saveMeshToLibrary({
        blob,
        name: baseName,
        metadata: {
          source: 'BUILDING GENERATOR',
          // THE DOCUMENT RIDES ALONG, the same way a saved tree carries its
          // spec. A ~20KB graph that regenerates this mesh exactly is worth far
          // more than the mesh alone: it can be reopened, restyled and
          // re-exported, and a future LOD level generated rather than recovered.
          buildingDoc: doc,
          ...statsOf(full),
        },
      })
      const parentId = assetIdOf(parent)
      if (!parentId) throw new Error('The library did not return an id for the saved mesh.')

      // The thumbnail is rendered BEFORE the versions are saved, so they can
      // inherit it - see saveMeshToLibrary. Best-effort: the mesh is already
      // saved and losing that over a picture would be the wrong trade.
      setBusy('thumbnail')
      try {
        const thumbnail = await createMeshThumbnailFile(
          new File([blob], `${baseName}.glb`, { type: 'model/gltf-binary' }),
        )
        if (thumbnail) await uploadAssetThumbnail(parentId, thumbnail)
      } catch { /* a building without a thumbnail is still a building */ }

      setBusy('saving')
      const versions = wanted.filter(level => level.spec.level !== 0)
      for (const level of versions) {
        const name = `${baseName}_LOD${level.spec.level}`
        await saveMeshToLibrary({
          blob: await glbOf(level, name),
          name,
          parentAssetId: parentId,
          // A VERSION INHERITS ITS PARENT'S METADATA - createAssetVersion merges
          // it - so the graph arrives on every level without being sent four
          // times, and the fields below override the ones that actually differ
          // per level. Verified rather than assumed: the saved LOD1 carries
          // buildingDoc from the parent and lod/triangles from here.
          metadata: { source: 'BUILDING GENERATOR', ...statsOf(level) },
        })
      }

      setDone(versions.length
        ? `Saved “${baseName}” with ${versions.length} LOD `
          + `${versions.length === 1 ? 'level' : 'levels'} as versions of it.`
        : `Saved “${baseName}” to the mesh library.`)
    } catch (err) {
      setError(err?.message || 'The building could not be saved.')
    } finally {
      setBusy('')
    }
  }, [levels, chosen, baseName, doc, uploadAssetThumbnail])

  const full = levels?.[0]

  return (
    <div className="bexport-overlay" role="presentation" onClick={onClose}>
      <div
        className="bexport"
        role="dialog"
        aria-modal="true"
        aria-label="Export the building"
        onClick={event => event.stopPropagation()}
      >
        <div className="bexport__header">
          <h3 className="font-headline">Export</h3>
          <button type="button" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="bexport__body">
          <p className="bexport__teach">
            Each level is <strong>regenerated from the graph</strong>, not simplified from
            the one above it — wider bays, then no trim, then the massing alone. A general
            simplifier deletes the window reveals and the cornice first, which is the part
            that makes it read as a building.
          </p>

          <label className="bexport__field">
            <span>Name</span>
            <input
              type="text"
              value={baseName}
              onChange={event => setBaseName(event.target.value)}
            />
          </label>

          <ul className="bexport__levels">
            {LOD_LEVELS.map(spec => {
              const level = levels?.find(entry => entry.spec.level === spec.level)
              return (
                <li key={spec.level} className="bexport__level">
                  <label>
                    <input
                      type="checkbox"
                      checked={chosen.has(spec.level)}
                      disabled={spec.level === 0 || !level}
                      onChange={() => toggle(spec.level)}
                    />
                    <span className="bexport__level-name">
                      LOD{spec.level}
                      <small>{spec.label}</small>
                    </span>
                  </label>
                  <span className="bexport__level-count">
                    {level ? `${formatCount(level.triangles)} tris` : '…'}
                  </span>
                </li>
              )
            })}
          </ul>

          <p className="bexport__note">
            The LOD levels are saved as <strong>versions of the first one</strong>, so the
            library shows one building rather than four meshes. The graph rides in its
            metadata, so a building exported today can be reopened, restyled and exported
            again.
          </p>

          {error && <div className="bexport__message is-error">{error}</div>}
          {done && <div className="bexport__message is-success">{done}</div>}
        </div>

        <div className="bexport__actions">
          <button type="button" onClick={onClose}>Close</button>
          <button
            type="button"
            onClick={() => onExportFiles(full?.object || null)}
            disabled={!full || Boolean(busy)}
            title="Formats, output folder, collision hulls and FBX"
          >
            Export files…
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={saveToLibrary}
            disabled={!levels?.length || Boolean(busy)}
          >
            {busy === 'saving' ? 'Saving…' : busy === 'thumbnail' ? 'Rendering…' : 'Save to library'}
          </button>
        </div>
      </div>
    </div>
  )
}
