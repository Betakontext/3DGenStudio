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
import * as THREE from 'three'
import { useProjects } from '../../context/ProjectContext'
import {
  assetIdOf, saveImageEdit, saveImageToLibrary, saveMeshToLibrary,
} from '../../utils/buildingApi'
import { exportObject3D } from '../../utils/meshExport'
import { createMeshThumbnailFile } from '../../utils/meshThumbnail'
import { LOD_LEVELS, buildLevel, disposeLevel } from '../../utils/building/exportBuilding'
import { loadBuildingTextures } from '../../utils/building/textures'
import { loadSlotMeshes } from '../../utils/building/slotMeshes'
import {
  mergeBuildingToAtlas, planBuildingAtlas, summariseBuildingAtlas,
} from '../../utils/building/atlasExport'
import { bakeImpostor, DEFAULT_IMPOSTOR_OPTIONS } from '../../utils/meshTools'
import './BuildingExportDialog.css'

const formatCount = n => new Intl.NumberFormat().format(n)

const ATLAS_SIZES = [1024, 2048, 4096, 8192]
const IMPOSTOR_TILES = [32, 64, 128, 256, 512]

/**
 * A renderer of this dialog's own, for the atlas bake.
 *
 * NOT the viewport's. The bake sets a render target, a clear colour and a clear
 * alpha, and assemblyAtlasBake restores all three precisely because it borrows
 * the live one - but the building preview is drawing every frame behind this
 * dialog, and a bake that throws between setting and restoring would repaint it.
 * A context of its own for a few seconds is cheaper than that risk.
 */
function withBakeRenderer(run) {
  const canvas = document.createElement('canvas')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true })
  try {
    return run(renderer)
  } finally {
    renderer.dispose()
    renderer.forceContextLoss?.()
  }
}

export default function BuildingExportDialog({ doc, name, onClose, onExportFiles }) {
  const { uploadAssetThumbnail } = useProjects()
  const [levels, setLevels] = useState(null)
  // NOTHING IS CHOSEN BY DEFAULT. LOD0 used to be forced on, because the chain
  // was saved as versions of it - but a merged mesh or an impostor is a
  // perfectly good thing to want on its own, and forcing the full model into
  // every export made the cheap outputs cost the expensive one.
  const [chosen, setChosen] = useState(() => new Set())
  const [baseName, setBaseName] = useState(name || 'Building')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [merge, setMerge] = useState(false)
  const [atlasSize, setAtlasSize] = useState(2048)
  const [atlasMaterials, setAtlasMaterials] = useState(1)
  const [impostor, setImpostor] = useState(false)
  const [impostorGrid, setImpostorGrid] = useState(DEFAULT_IMPOSTOR_OPTIONS.grid)
  const [impostorTile, setImpostorTile] = useState(DEFAULT_IMPOSTOR_OPTIONS.tile)
  const [atlasCheck, setAtlasCheck] = useState(null)
  const [atlasDetail, setAtlasDetail] = useState(null)
  // The step-by-step message from a long stage, shown under the buttons. The
  // phase alone is not enough: an impostor bake is sixty-four views and the
  // better part of two minutes, and a dialog that looks idle for that long
  // reads as finished - which is exactly how a saved impostor got reported as
  // missing.
  const [busyDetail, setBusyDetail] = useState('')

  // Built once, on open. Four compiles and four mesh builds is a few hundred
  // milliseconds for an ordinary building, and doing it up front means the
  // triangle counts are on screen before anyone has to choose.
  useEffect(() => {
    let alive = true
    let built = []
    ;(async () => {
      try {
        for (const spec of LOD_LEVELS) {
          // THE MODELS TOO. Without them every opening exported as the
          // placeholder box, and because that is also what an unbound slot
          // draws, the file looked plausible rather than broken.
          const level = await buildLevel(doc, spec, loadBuildingTextures, loadSlotMeshes)
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

  // MATERIALS ONLY, which is instant. The density needs the real packer, and
  // running that here froze the UI on the click - it is behind the button below.
  useEffect(() => {
    const full = levels?.find(level => level.spec.level === 0)
    let alive = true
    // Every setState is INSIDE the timer, not in the effect body: a synchronous
    // one cascades a render.
    const timer = setTimeout(() => {
      if (!alive) return
      setAtlasDetail(null)
      if (!merge || !full) { setAtlasCheck(null); return }
      let result = null
      try {
        result = summariseBuildingAtlas(full.object, { maxAtlases: atlasMaterials })
      } catch { /* advisory; its absence just hides the line */ }
      if (alive) setAtlasCheck(result)
    }, 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [merge, atlasSize, atlasMaterials, levels])

  // THE REAL PACKING, on request. Seconds on a large building, so it is never
  // run for you - but it is the only way to know what a texture size actually
  // buys before committing to an export that takes minutes.
  const checkDetail = useCallback(() => {
    const full = levels?.find(level => level.spec.level === 0)
    if (!full) return
    setAtlasDetail({ busy: true })
    // Two frames, so the button's busy state paints before the main thread goes.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        const plan = planBuildingAtlas(full.object, { size: atlasSize, maxAtlases: atlasMaterials })
        setAtlasDetail(plan?.ok
          ? { detail: Math.round(plan.densityScale * 1000) / 10, fill: plan.fill }
          : { error: plan?.reason || 'the layout could not be planned' })
      } catch (err) {
        setAtlasDetail({ error: err?.message || 'the layout could not be planned' })
      }
    }))
  }, [levels, atlasSize, atlasMaterials])

  const toggle = level => setChosen(current => {
    const next = new Set(current)
    if (next.has(level)) next.delete(level)
    else next.add(level)
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

      // WHICHEVER LEVEL IS THE MODEL. The coarser ones are saved as VERSIONS of
      // it, which is what the library already means by a mesh's children - so a
      // building is one entry that opens to reveal its LOD chain rather than
      // several unrelated meshes with a naming convention as the only thing
      // relating them. That used to be LOD0 by definition; now that LOD0 is
      // optional it is the finest level actually asked for, and a merge always
      // takes the full-detail geometry whatever is being saved beside it.
      const full = levels.find(level => level.spec.level === 0)
      const primary = wanted.length
        ? wanted.reduce((best, level) => (level.spec.level < best.spec.level ? level : best))
        : null

      // MERGED BEFORE IT IS EXPORTED, and only LOD0. The merge answers "give me
      // one mesh with one texture", which is a statement about the model - the
      // coarser levels are reductions of it and keep their own materials, where
      // a second atlas would cost more than the draw call it saves.
      let mergeStats = null
      let mergedObject = null
      if (merge && full) {
        setBusy('merging')
        // NOT A FALLBACK. assemblyExport saves an unmerged asset when its atlas
        // fails, on the reasoning that a worse asset beats no asset - and that
        // is right when merging is a bonus. Here it is the thing that was
        // ticked, so quietly writing a six-material mesh instead is answering a
        // different question: it looks like it worked, and the only clue is a
        // line of text beside a success message. Stop instead, and say which
        // size would have fitted.
        const result = withBakeRenderer(renderer => mergeBuildingToAtlas(full.object, {
          renderer, size: atlasSize, maxAtlases: atlasMaterials,
        }))
        mergedObject = result.object
        mergeStats = result.stats
        setBusy('saving')
      }
      // A MESH ONLY IF ONE WAS ASKED FOR. Merging implies one (it IS a mesh), and
      // so does any chosen level; an impostor on its own produces images and no
      // mesh at all.
      const meshSource = mergedObject ? { ...full, object: mergedObject } : primary
      let parentId = null
      let blob = null
      if (meshSource) {
        blob = await glbOf(meshSource, baseName)
        const parent = await saveMeshToLibrary({
          blob,
          name: baseName,
          metadata: {
            source: 'BUILDING GENERATOR',
            // THE DOCUMENT RIDES ALONG, the same way a saved tree carries its
            // spec. A ~20KB graph that regenerates this mesh exactly is worth
            // far more than the mesh alone: it can be reopened, restyled and
            // re-exported, and a future LOD level generated rather than
            // recovered.
            buildingDoc: doc,
            ...statsOf(meshSource),
            ...(mergeStats ? { atlas: mergeStats } : null),
          },
        })
        parentId = assetIdOf(parent)
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
      }

      setBusy('saving')
      // WHAT GOES UNDER THE PARENT. Without a merge the parent is the finest
      // level asked for, so it is not repeated. With one the parent is the
      // merged mesh, which stands in for LOD0 - and every OTHER chosen level
      // still belongs under it. Filtering on `primary` alone dropped a lone
      // coarse level whenever a merge was asked for beside it: the parent was
      // the merged LOD0, and the level that had actually been ticked matched
      // `primary` and was thrown away.
      const covered = mergedObject ? full : primary
      const versions = wanted.filter(level => level !== covered)
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

      // THE IMPOSTOR IS BAKED FROM LOD0 on the service, whether or not LOD0 is
      // being saved - it is the one thing here that is not a reduction of the
      // graph, but a grid of pre-rendered views for the range at which even the
      // massing is a few pixels. What comes back is saved as images, not as a
      // mesh, so an impostor can be the only thing an export produces.
      let impostorNote = ''
      if (impostor) {
        setBusy('impostor')
        try {
          const source = await glbOf(full, `${baseName}_source`)
          const baked = await bakeImpostor(source, {
            fileName: `${baseName}.glb`,
            options: {
              ...DEFAULT_IMPOSTOR_OPTIONS,
              grid: impostorGrid,
              tile: impostorTile,
              name: 'Building',
            },
            onProgress: event => setBusyDetail(event?.message || ''),
          })
          // AN IMPOSTOR IS ITS ATLASES, not a mesh. The service also returns a
          // two-triangle billboard with the albedo embedded, and saving that was
          // clutter: the quad is four vertices an engine builds itself from the
          // `impostor` metadata (grid, mapping, bounds, quad size), and its
          // embedded copy of the atlas is a second copy of a file already in the
          // library. So only the maps are kept.
          //
          // The normal is an EDIT of the albedo rather than a sibling: same bake,
          // same views, same layout, so it belongs under it.
          const name = `${baseName}_Impostor`
          const albedo = await saveImageToLibrary({
            blob: baked.maps.albedo,
            name,
            metadata: {
              source: 'BUILDING GENERATOR',
              impostorOf: baseName,
              impostorMap: 'albedo',
              // Only when a mesh was actually saved beside it.
              ...(parentId ? { impostorMesh: parentId } : null),
              impostor: baked.meta,
            },
          })
          const albedoId = assetIdOf(albedo)
          let normals = 0
          if (albedoId && baked.maps.normal) {
            await saveImageEdit({
              parentAssetId: albedoId,
              blob: baked.maps.normal,
              name: `${name}_normal`,
              metadata: {
                source: 'BUILDING GENERATOR',
                impostorOf: baseName,
                impostorMap: 'normal',
                impostor: baked.meta,
              },
            })
            normals = 1
          }
          impostorNote = `an impostor atlas of ${baked.meta?.views ?? '?'} views`
            + (normals ? ' with its normals' : '')
        } catch (err) {
          // Saved without it rather than not saved: the impostor needs the
          // Python mesh service, and its absence must not lose the building.
          setError(`The impostor could not be baked: ${err.message}`)
        }
        setBusy('saving')
      }

      const atlasNote = mergeStats
        ? ` Merged into one mesh with ${mergeStats.atlases} `
          + `material${mergeStats.atlases === 1 ? '' : 's'} at ${mergeStats.size}px `
          + `(${mergeStats.fill}% full, ${Math.round(mergeStats.densityScale * 100)}% detail).`
        : ''
      // A MESH IS NOW OPTIONAL, so the message cannot assume one was written.
      // Saying "saved the building" when the only output was an atlas would be
      // the same class of mistake as the merge quietly substituting a mesh.
      // Built from the parts that actually happened, so it reads as a sentence
      // whichever combination was asked for - a mesh, a chain, an atlas, or an
      // impostor on its own with no mesh at all.
      const parts = []
      if (parentId) {
        parts.push(versions.length
          ? `“${baseName}” with ${versions.length} LOD `
            + `${versions.length === 1 ? 'level' : 'levels'} as versions of it`
          : `“${baseName}”`)
      }
      if (impostorNote) parts.push(impostorNote)
      setDone(parts.length
        ? `Saved ${parts.join(' and ')}.${atlasNote}`
        : `Nothing was saved for “${baseName}”.`)
    } catch (err) {
      setError(err?.message || 'The building could not be saved.')
    } finally {
      setBusy('')
      setBusyDetail('')
    }
  }, [levels, chosen, baseName, doc, uploadAssetThumbnail,
    merge, atlasSize, atlasMaterials, impostor, impostorGrid, impostorTile])

  const full = levels?.[0]
  // Nothing ticked anywhere produces nothing. With LOD0 no longer forced on,
  // that is a reachable state and the button should say so rather than run an
  // export that writes nothing.
  const willProduce = chosen.size > 0 || merge || impostor

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
              const above = levels?.find(entry => entry.spec.level === spec.level - 1)
              // WHAT IS EXPENSIVE, not just how expensive. A level that is barely
              // cheaper than the one above it is a broken LOD, and with four bare
              // totals and nothing else the only way to notice was to read them
              // and do the arithmetic - which is how a chain where LOD1 and LOD2
              // were within half a percent of LOD0 shipped.
              const biggest = level?.breakdown?.[0]
              const share = biggest && level.triangles
                ? biggest.triangles / level.triangles
                : 0
              const barelyCheaper = level && above
                && level.triangles > above.triangles * 0.75
              return (
                <li key={spec.level} className="bexport__level">
                  <label>
                    <input
                      type="checkbox"
                      checked={chosen.has(spec.level)}
                      disabled={!level}
                      onChange={() => toggle(spec.level)}
                    />
                    <span className="bexport__level-name">
                      LOD{spec.level}
                      <small>{spec.label}</small>
                      {level && biggest && share > 0.4 && (
                        <small className="bexport__level-detail">
                          {Math.round(share * 100)}% {biggest.name.toLowerCase()}
                          {barelyCheaper && ' — barely cheaper than the level above'}
                        </small>
                      )}
                    </span>
                  </label>
                  <span className="bexport__level-count">
                    {level ? `${formatCount(level.triangles)} tris` : '…'}
                  </span>
                </li>
              )
            })}
          </ul>

          <div className="bexport__extras">
            <label className="bexport__extra">
              <input type="checkbox" checked={merge} onChange={() => setMerge(v => !v)} />
              <span>
                <strong>Merge into one mesh</strong>
                <small>
                  One mesh with exactly as many materials as you ask for, packed from the
                  building's own UVs — no re-unwrap, so nothing moves. The texture size is
                  the quality setting: everything fits whatever you pick, at the density
                  that leaves.
                </small>
              </span>
            </label>
            {merge && (
              <div className="bexport__atlas">
                <label>
                  Texture size
                  <select
                    value={atlasSize}
                    onChange={event => setAtlasSize(Number(event.target.value))}
                  >
                    {ATLAS_SIZES.map(size => (
                      <option key={size} value={size}>{size} px</option>
                    ))}
                  </select>
                </label>
                <label>
                  Materials
                  <span
                    className="bexport__hint"
                    title={'Detail grows with the SQUARE ROOT of the texture area, so a second '
                      + 'material buys about 1.4x the density, not 2x — and each extra atlas is '
                      + 'less full than the last. One step up in texture size is 4x the area in '
                      + 'one draw call, which beats four materials at the smaller size.'}
                  >
                    ?
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={atlasMaterials}
                    onChange={event => setAtlasMaterials(
                      Math.max(1, Math.min(8, Number(event.target.value) || 1)))}
                  />
                </label>
              </div>
            )}
            {merge && atlasCheck && (
              <p className="bexport__atlas-ok">
                {atlasCheck.materials} material{atlasCheck.materials === 1 ? '' : 's'}
                {atlasCheck.masked ? ', alpha-tested' : ''}.
                {/* ONE DECIMAL. Doubling the materials buys sqrt(2) of linear
                    density, so 2.0 -> 2.8 -> 3.5 across one, two and three - and
                    rounding those to whole numbers shows 2, 3, 3, which reads as
                    "the second material did nothing". */}
                {atlasDetail?.detail != null
                  ? ` ${atlasDetail.detail}% of the source detail, ${atlasDetail.fill}% full.`
                  : null}
                {atlasDetail?.error ? ` ${atlasDetail.error}` : null}
                {atlasDetail?.detail == null && !atlasDetail?.error && (
                  <button type="button" onClick={checkDetail} disabled={atlasDetail?.busy}>
                    {atlasDetail?.busy ? 'Measuring…' : 'How much detail?'}
                  </button>
                )}
              </p>
            )}
            <label className="bexport__extra">
              <input type="checkbox" checked={impostor} onChange={() => setImpostor(v => !v)} />
              <span>
                <strong>Impostor</strong>
                <small>
                  Pre-rendered views on a hemi-octahedral grid, for the range at which even
                  the massing is a few pixels. Saved as an albedo atlas with its normals as
                  an edit — the billboard itself is four vertices an engine builds from the
                  metadata. Baked on the mesh service, so it needs Python running.
                </small>
              </span>
            </label>
            {impostor && (
              <div className="bexport__atlas">
                <label>
                  Views per axis
                  <input
                    type="number"
                    min={2}
                    max={16}
                    value={impostorGrid}
                    onChange={event => setImpostorGrid(
                      Math.max(2, Math.min(16, Number(event.target.value) || 2)))}
                  />
                </label>
                <label>
                  View size
                  <select
                    value={impostorTile}
                    onChange={event => setImpostorTile(Number(event.target.value))}
                  >
                    {IMPOSTOR_TILES.map(tile => (
                      <option key={tile} value={tile}>{tile} px</option>
                    ))}
                  </select>
                </label>
                <span className="bexport__atlas-note">
                  {impostorGrid * impostorGrid} views, {impostorGrid * impostorTile}px atlas
                </span>
              </div>
            )}
          </div>

          <p className="bexport__note">
            The LOD levels are saved as <strong>versions of the first one</strong>, so the
            library shows one building rather than four meshes. The graph rides in its
            metadata, so a building exported today can be reopened, restyled and exported
            again.
          </p>

          {busy && (
            <div className="bexport__message is-busy">
              {busy === 'impostor'
                ? 'Rendering 64 views for the impostor. This takes a minute or two on a large '
                  + 'building, and the mesh is not finished until it is done.'
                : 'Working…'}
              {busyDetail ? ` ${busyDetail}` : ''}
            </div>
          )}
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
            disabled={!levels?.length || !willProduce || Boolean(busy)}
            title={willProduce ? '' : 'Choose a level, or tick Merge or Impostor'}
          >
            {busy === 'saving' ? 'Saving…'
              : busy === 'thumbnail' ? 'Rendering…'
                : busy === 'merging' ? 'Merging…'
                  : busy === 'impostor' ? 'Baking the impostor…'
                    : busy ? `${busy}…`
                      : 'Save to library'}
          </button>
        </div>
      </div>
    </div>
  )
}
