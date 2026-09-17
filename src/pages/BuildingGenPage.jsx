// Procedural Building Generator workspace.
//
// GLOBAL, not project-scoped, for the same reason the trees and assembly
// workspaces are: a building binds facade textures from one project and window
// meshes from another, and forcing the document to belong to one of them would
// be arbitrary. Hence /buildings with no projectId and a Header nav link.
//
// A SHELL, on purpose. What lives here is the wiring - selection, the layout,
// the keyboard, and the save/load plumbing. The plan editor, the 3D viewport and
// the inspector are their own components under src/components/building/, every
// document mutation is a pure function in src/utils/building/edits.js, and the
// geometry is all in the pure building/ package. The thing being avoided is
// MeshEditorPage.jsx, which is 12k lines because everything went inline.
//
// THE CENTRE COLUMN IS TABBED RATHER THAN SPLIT. Plan and Preview answer
// different questions - "what shape is this" and "what does it look like" - and
// an author is only ever asking one of them. Splitting the space gives both
// halves too little of it; the 3D view of a tower is tall and the plan is wide,
// so neither wants half a pane.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import BuildingViewport from '../components/building/BuildingViewport'
import BuildingStylePanel from '../components/building/BuildingStylePanel'
import BuildingPalette from '../components/building/BuildingPalette'
import BuildingTextures from '../components/building/BuildingTextures'
import BuildingAiPanel from '../components/building/BuildingAiPanel'
import BuildingExportDialog from '../components/building/BuildingExportDialog'
import ExportMeshDialog from '../components/ExportMeshDialog'
import BuildingPlanEditor from '../components/building/BuildingPlanEditor'
import BuildingInspector from '../components/building/BuildingInspector'
import useBuildingDocument from '../hooks/useBuildingDocument'
import useBuildingCompile from '../hooks/useBuildingCompile'
import {
  MAX_SEED, REFERENCE_KIND, appendReference, clearReference,
} from '../../building/doc.js'
import { buildingTextureRows, slotMeshRows } from '../utils/building/textureRows'
import { CATALOG, CATALOG_ORDER, getNodeDef } from '../../building/catalog.js'
import { paletteOf } from '../../building/stylepack.js'
import { SEVERITY } from '../../building/diagnostics.js'
import {
  addWing, applyFix, canApplyFix, canMoveNode, ensureStarterGraph, insertNodeAfter,
  moveNode, orderedNodes, removeNode, resetPalette, setFootprint, setNodeEnabled,
  setMeshRotation, setNodeMode, setNodeProp, setPaletteColor, setReferenceTile,
} from '../utils/building/edits'
import './BuildingGenPage.css'

/**
 * Whether a node type can be spliced in after the selected one.
 *
 * Mirrors insertNodeAfter's own rules so the palette only ever offers what will
 * actually work - a button that does nothing when pressed is worse than no
 * button at all.
 */
function canInsert(doc, afterId, type) {
  const def = getNodeDef(type)
  const source = doc.nodes.find(node => node.id === afterId)
  if (!def || !source) return false
  if (def.singleton && doc.nodes.some(node => node.type === type)) return false
  // A NODE WITH TWO REQUIRED INPUTS CANNOT BE SPLICED. Splicing wires the first
  // and leaves the second dangling, which compiles to "this node has nothing
  // plugged into And" - a palette button whose only effect is an error. Merge is
  // reached through "Add a wing" instead, which builds the second branch too.
  if ((def.inputs || []).filter(port => port.required).length > 1) return false
  const sourcePort = getNodeDef(source.type)?.outputs?.[0]
  const input = def.inputs?.[0]
  return Boolean(sourcePort && input && sourcePort.kind === input.kind)
}

/** The short "which storeys" label shown on a Facade row. */
function storeyTag(node) {
  const mode = node.modes?.storeys || 'all'
  if (mode === 'range') return `${node.props?.fromFloor ?? 0}-${node.props?.toFloor ?? 0}`
  return mode
}

const TABS = [
  { id: 'plan', label: 'Plan', icon: 'architecture' },
  { id: 'preview', label: 'Preview', icon: 'deployed_code' },
]

export default function BuildingGenPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [showSettings, setShowSettings] = useState(false)
  // Which texture slot the generate dialog is open for, or null.
  // { refKey, guideSlot } while the generate dialog is open, or null.
  const [generating, setGenerating] = useState(null)
  const [exporting, setExporting] = useState(false)
  // The finished Object3D, handed to the app's own export dialog for formats,
  // folders, collision and FBX. Held rather than rebuilt so the two dialogs
  // cannot disagree about what was exported.
  const [exportObject, setExportObject] = useState(null)
  const onGenerateTexture = useCallback(
    (refKey, guideSlot) => setGenerating({ refKey, guideSlot }), [],
  )
  const [message, setMessage] = useState(null)
  const [tab, setTab] = useState('preview')
  const [selectedId, setSelectedId] = useState(null)
  const [orthographic, setOrthographic] = useState(false)
  // Which curve property has its editor open, as `nodeId:prop`. One at a time:
  // the editor is 170px of canvas and two open at once in a 320px rail is a
  // scroll, not a comparison.
  const [openCurve, setOpenCurve] = useState(null)
  const [frameKey, setFrameKey] = useState(0)

  const assetIdParam = searchParams.get('buildingAssetId')

  const onError = useCallback(text => setMessage({ tone: 'error', text }), [])

  const {
    doc, name, setName, commit, history, status, saving, dirty,
    savedAssetId, draft, restoreDraft, discardDraft, save,
  } = useBuildingDocument({ assetId: assetIdParam, onError })

  const compiled = useBuildingCompile(doc)

  // A brand-new document opens with a working graph rather than an empty board.
  // Runs once, only when the document really is empty, and only when nothing is
  // being loaded - otherwise it would race the asset fetch and stamp a starter
  // graph over the document the author asked for.
  useEffect(() => {
    if (status === 'loading') return
    if (doc.nodes.length > 0) return
    commit(current => ensureStarterGraph(current), { undoLabel: 'New Building' })
  }, [commit, doc.nodes.length, status])

  // Pipeline order, not creation order - see orderedNodes.
  const nodeOrder = useMemo(() => orderedNodes(doc), [doc])

  // DERIVED, not stored-and-synced. The selection has to survive the starter
  // graph arriving and any node being deleted, and doing that with an effect
  // that calls setSelectedId means an extra render on every document change -
  // and a frame where the inspector is blank. Falling back during render has
  // neither problem.
  const selected = useMemo(() => {
    if (selectedId && doc.nodes.some(node => node.id === selectedId)) return selectedId
    return doc.nodes.find(node => node.type === 'mass')?.id || doc.nodes[0]?.id || null
  }, [doc.nodes, selectedId])

  // Resolved through paletteOf rather than read off the document, so the panel
  // shows the colours the building is ACTUALLY drawn in - a pack's, the
  // defaults', or the author's own - and not an empty override table.
  const palette = useMemo(() => paletteOf(doc), [doc])

  const footprintNodes = useMemo(
    () => doc.nodes.filter(node => node.type === 'footprint'),
    [doc.nodes],
  )

  /**
   * WHICH plan the editor edits. Not "the first one" any more: since a Merge
   * node can join two branches a document has a footprint per wing, and taking
   * the first meant clicking a wing and then dragging its hall's outline. The
   * selected node decides - itself when it IS a footprint, otherwise the one
   * upstream of it, which is what "the plan of the thing I am looking at" means.
   */
  const footprintNode = useMemo(() => {
    const byId = new Map(doc.nodes.map(node => [node.id, node]))
    const selectedNode = byId.get(selected)
    if (selectedNode?.type === 'footprint') return selectedNode

    // Walk back up the chain from whatever is selected. A node has one building
    // input, so this terminates - and at a Merge it takes the FIRST branch,
    // which is the only answer available without asking.
    const from = new Map()
    for (const edge of doc.edges) {
      if (!from.has(edge.to.node)) from.set(edge.to.node, edge.from.node)
    }
    const seen = new Set()
    let at = selected
    while (at && !seen.has(at)) {
      seen.add(at)
      const node = byId.get(at)
      if (node?.type === 'footprint') return node
      at = from.get(at)
    }
    return doc.nodes.find(node => node.type === 'footprint') || null
  }, [doc.nodes, doc.edges, selected])


  useEffect(() => {
    if (!message) return undefined
    const timer = setTimeout(() => setMessage(null), 6000)
    return () => clearTimeout(timer)
  }, [message])

  // --- edits ---------------------------------------------------------------

  const onProp = useCallback((nodeId, key, value) => {
    commit(current => setNodeProp(current, nodeId, key, value), {
      undoLabel: 'Change Property',
      // Coalesced per node+property, so dragging a number for five seconds is
      // one undo entry rather than three hundred.
      coalesceKey: `prop:${nodeId}:${key}`,
    })
  }, [commit])

  const onPropCommit = useCallback((nodeId, key, value) => {
    commit(current => setNodeProp(current, nodeId, key, value), { undoLabel: 'Change Property' })
  }, [commit])

  const onMode = useCallback((nodeId, key, value) => {
    commit(current => setNodeMode(current, nodeId, key, value), { undoLabel: 'Change Mode' })
  }, [commit])

  const onToggleEnabled = useCallback((nodeId, enabled) => {
    commit(current => setNodeEnabled(current, nodeId, enabled), {
      undoLabel: enabled ? 'Unmute Node' : 'Mute Node',
    })
  }, [commit])

  const onPlanChange = useCallback(shape => {
    if (!footprintNode) return
    commit(current => setFootprint(current, footprintNode.id, shape), {
      undoLabel: 'Edit Plan',
      coalesceKey: `plan:${footprintNode.id}`,
    })
  }, [commit, footprintNode])

  const onPlanCommit = useCallback(shape => {
    if (!footprintNode) return
    commit(current => setFootprint(current, footprintNode.id, shape), { undoLabel: 'Edit Plan' })
  }, [commit, footprintNode])

  const setSeedValue = useCallback(value => {
    const seed = Math.max(0, Math.min(MAX_SEED, Math.floor(Number(value) || 0)))
    commit(
      current => ({ ...current, building: { ...current.building, seed } }),
      { undoLabel: 'Change Seed', coalesceKey: 'building:seed' },
    )
  }, [commit])

  const onEditCurve = useCallback((nodeId, key) => {
    setOpenCurve(current => (key === null || current === `${nodeId}:${key}` ? null : `${nodeId}:${key}`))
  }, [])

  // Adding a node SPLICES IT INTO THE CHAIN after the selected one. A building is
  // a pipeline, so "add a Facade" almost always means "put one more step here",
  // and making the author wire three edges by hand to give the ground floor a
  // shopfront would be the difference between a feature people use and one they
  // do not.
  const onAddNode = useCallback(type => {
    const after = selected
    commit(current => insertNodeAfter(current, after, type), {
      undoLabel: `Add ${getNodeDef(type)?.label || type}`,
    })
  }, [commit, selected])

  const onMoveNode = useCallback((nodeId, direction) => {
    commit(current => moveNode(current, nodeId, direction), {
      undoLabel: direction < 0 ? 'Move Node Earlier' : 'Move Node Later',
    })
  }, [commit])

  const onRotateMesh = useCallback((key, rotation) => {
    commit(current => setMeshRotation(current, key, rotation), {
      undoLabel: 'Turn Model',
      // A number field fires per keystroke; one undo entry per model rather than
      // one per digit typed.
      coalesceKey: `rotate:${key}`,
    })
  }, [commit])

  const onRetileTexture = useCallback((key, tileMetres, tileMetresY) => {
    commit(current => setReferenceTile(current, key, tileMetres, tileMetresY), {
      undoLabel: 'Resize Tile',
      // Same reasoning as the rotation fields: one undo entry per texture, not
      // one per digit typed into the box.
      coalesceKey: `tile:${key}`,
    })
  }, [commit])

  const onPaletteColor = useCallback((slot, hex) => {
    commit(current => setPaletteColor(current, slot, hex), {
      undoLabel: 'Change Colour',
      // Dragging a colour picker fires a change per frame; one undo entry per
      // slot rather than per pixel of hue.
      coalesceKey: `palette:${slot}`,
    })
  }, [commit])

  const onPaletteReset = useCallback(() => {
    commit(current => resetPalette(current), { undoLabel: 'Reset Colours' })
  }, [commit])

  const onAddWing = useCallback(() => {
    commit(current => addWing(current), { undoLabel: 'Add Wing' })
  }, [commit])

  const onRemoveNode = useCallback(nodeId => {
    commit(current => removeNode(current, nodeId), { undoLabel: 'Delete Node' })
  }, [commit])

  const onApplyFix = useCallback(fixDescriptor => {
    commit(current => applyFix(current, fixDescriptor), { undoLabel: fixDescriptor.label })
  }, [commit])

  // A style arrives as a whole replacement document, already computed by the
  // panel, so this commits it rather than recomputing it - applyStylePack needs
  // the fetched pack and this page has no business fetching one.
  const onApplyStyle = useCallback((next, label) => {
    commit(() => next, { undoLabel: `Apply ${label}` })
    setSelectedId(null)
    setMessage({ tone: 'ok', text: `${label} applied. Undo restores the previous graph.` })
  }, [commit])

  // Binding a texture writes ONE reference-table entry - invariant 3 in doc.js -
  // and nothing else. No node changes, so the geometry does not even recompile;
  // only the material slot in the IR differs.
  // Adding to a slot APPENDS to its list - invariant 3, and the list is what the
  // seeded pick draws from. One entry is a choice; several are a roll.
  const onAddTexture = useCallback((refKey, assets) => {
    commit(
      current => assets.reduce((doc_, asset) => appendReference(doc_, refKey, {
        // A model and a texture go through the SAME table with different kinds,
        // so bundling, import remapping and dangling-key reporting all still
        // have one place to look.
        kind: asset.kind === 'mesh' ? REFERENCE_KIND.MESH : REFERENCE_KIND.IMAGE,
        // The string form, never a bare number: this is what makes a .3dgp
        // export carry the building's assets with no walker changes.
        ref: `asset:${asset.assetId}`,
        name: asset.name || '',
        // Only an image has a colour space or a tile size; normalizeReferenceEntry
        // drops both on a mesh rather than storing numbers nothing reads.
        colorSpace: 'srgb',
        tileMetres: asset.tile,
      }), current),
      { undoLabel: assets.length > 1 ? `Add ${assets.length} Assets` : 'Add Asset' },
    )
    setMessage({
      tone: 'ok',
      text: assets.length > 1
        ? `${assets.length} added. One is picked per building from the seed.`
        : `${assets[0].name} bound.`,
    })
  }, [commit])

  const onRemoveTexture = useCallback(entryKey => {
    commit(current => clearReference(current, entryKey), { undoLabel: 'Remove Asset' })
  }, [commit])

  // --- save ----------------------------------------------------------------

  const handleSave = useCallback(async ({ forkNew = false } = {}) => {
    try {
      const saved = await save({ forkNew })
      const numeric = String(saved?.id ?? saved?.assetId ?? '').replace(/^library:/, '')
      if (numeric && numeric !== assetIdParam) {
        const next = new URLSearchParams(searchParams)
        next.set('buildingAssetId', numeric)
        setSearchParams(next, { replace: true })
      }
      setMessage({ tone: 'ok', text: forkNew ? 'Saved as a new building.' : 'Building saved.' })
    } catch {
      // useBuildingDocument already reported it through onError.
    }
  }, [assetIdParam, save, searchParams, setSearchParams])

  useEffect(() => {
    const onKeyDown = event => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod) return
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        handleSave()
      } else if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        history.undo()
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault()
        history.redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleSave, history])

  // --- render --------------------------------------------------------------

  const stats = compiled.ir.stats

  return (
    <div className="buildinggen">
      <Header
        title={name ? `Building Generator — ${name}` : 'Building Generator'}
        centerTitle
        onSettingsClick={() => setShowSettings(true)}
      />

      {draft && (
        <div className="buildinggen__banner buildinggen__banner--draft">
          <span className="material-symbols-outlined">history</span>
          <span>An unsaved draft from {new Date(draft.savedAt).toLocaleString()} was recovered.</span>
          <button type="button" className="buildinggen__banner-btn" onClick={restoreDraft}>Restore</button>
          <button type="button" className="buildinggen__banner-btn" onClick={discardDraft}>Discard</button>
        </div>
      )}

      {exporting && (
        <BuildingExportDialog
          doc={doc}
          name={doc.name}
          onClose={() => setExporting(false)}
          onExportFiles={object => {
            // Hand the built object to the app's own dialog rather than
            // duplicating formats, folder browsing, collision and FBX here.
            setExporting(false)
            setExportObject(object)
          }}
        />
      )}

      {exportObject && (
        <ExportMeshDialog
          getObject3D={() => exportObject}
          defaultName={doc.name || 'Building'}
          onClose={() => setExportObject(null)}
        />
      )}

      {generating && (
        <BuildingAiPanel
          // Keyed by the reference key so switching rows REMOUNTS it. The
          // prompt, tile size and result all default from the slot, and
          // resetting them in an effect would be a cascading render for
          // something a remount does for free - see react-hooks/set-state-in-effect.
          key={generating.refKey}
          slot={generating.guideSlot}
          refKey={generating.refKey}
          onGenerated={(refKey, asset) => onAddTexture(refKey, [asset])}
          onClose={() => setGenerating(null)}
        />
      )}

      {message && (
        <div className={`buildinggen__banner buildinggen__banner--${message.tone}`}>
          <span className="material-symbols-outlined">
            {message.tone === 'error' ? 'error' : 'check_circle'}
          </span>
          <span>{message.text}</span>
        </div>
      )}

      <div className="buildinggen__body">
        {/* --- left: document, nodes, stats --- */}
        <aside className="buildinggen__sidebar buildinggen__sidebar--left">
          <h2 className="buildinggen__title">Building</h2>

          <label className="buildinggen__field">
            <span className="buildinggen__label">Name</span>
            <input
              type="text"
              className="buildinggen__input"
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="Untitled Building"
            />
          </label>

          <label className="buildinggen__field">
            <span className="buildinggen__label">Seed</span>
            <div className="buildinggen__seed-row">
              <input
                type="number"
                className="buildinggen__input"
                value={doc.building.seed}
                min={0}
                max={MAX_SEED}
                onChange={event => setSeedValue(event.target.value)}
              />
              <button
                type="button"
                className="buildinggen__icon-btn"
                onClick={() => setSeedValue((doc.building.seed + 1) % (MAX_SEED + 1))}
                title="Step the seed"
              >
                <span className="material-symbols-outlined">casino</span>
              </button>
            </div>
          </label>

          {/* Above the node list, because picking a style REPLACES that list -
              reading them the other way round would suggest the opposite. */}
          <BuildingStylePanel
            doc={doc}
            activeId={doc.building.stylePackId}
            onApply={onApplyStyle}
          />

          {/* Under the style picker and above the textures, which is the order
              they are reached in: pick a look, adjust its colours, then bind
              images that tint them. */}
          <BuildingPalette
            palette={palette}
            overrides={doc.building.style?.palette || {}}
            onChange={onPaletteColor}
            onReset={onPaletteReset}
          />

          <BuildingTextures
            doc={doc}
            title="Textures"
            rows={buildingTextureRows()}
            onAdd={onAddTexture}
            onRemove={onRemoveTexture}
            onGenerate={onGenerateTexture}
            onRotate={onRotateMesh}
            onRetile={onRetileTexture}
            note={'A texture replaces the slot’s colour and tiles by metres. A Facade '
              + 'node can override the wall and windows on the storeys it covers, and on '
              + 'one side of them.'}
          />

          {/* The openings' own geometry. Separate from the Textures list above
              because a model and a material are different decisions - a
              shopfront and an arch are different SHAPES, and no texture makes
              one out of the other. */}
          <BuildingTextures
            doc={doc}
            title="Openings"
            rows={slotMeshRows()}
            onAdd={onAddTexture}
            onRemove={onRemoveTexture}
            onGenerate={onGenerateTexture}
            onRotate={onRotateMesh}
            onRetile={onRetileTexture}
            note={'A model is scaled to the bay the grammar worked out, so one fits any '
              + 'wall. Empty slots stay plain boxes.'}
          />

          <h2 className="buildinggen__title">Nodes</h2>
          <ul className="buildinggen__nodes">
            {nodeOrder.map(node => {
              const def = getNodeDef(node.type)
              return (
                <li key={node.id} className="buildinggen__node-row">
                  <button
                    type="button"
                    className={`buildinggen__node ${selected === node.id ? 'buildinggen__node--on' : ''} ${node.enabled ? '' : 'buildinggen__node--muted'}`}
                    onClick={() => setSelectedId(node.id)}
                  >
                    <span className="material-symbols-outlined">{def?.icon || 'circle'}</span>
                    <span className="buildinggen__node-label">{def?.label || node.type}</span>
                    {/* Which storeys a Facade covers, on the row itself: with
                        several chained, this is the only way to tell them apart
                        without clicking each one. */}
                    {node.type === 'facade' && (
                      <span className="buildinggen__node-tag">{storeyTag(node)}</span>
                    )}
                    {/* Same reason, for roofs: chained, they stack - the lower
                        one's shape is what the upper one stands on - and two
                        rows reading "Roof" say nothing about which is which. */}
                    {node.type === 'roof' && (
                      <span className="buildinggen__node-tag">{node.modes?.kind || 'hip'}</span>
                    )}
                  </button>
                  {/* ORDER IS NOT COSMETIC. A Roof Detail reads the roof under
                      it and a Trim reads it for its eave, so a node added in the
                      wrong place quietly does nothing - which is how the missing
                      chimney was reported. Greyed rather than hidden where a
                      move is impossible, so the control does not appear and
                      disappear as the selection walks the chain. */}
                  {canMoveNode(doc, node.id, -1) || canMoveNode(doc, node.id, 1) ? (
                    <span className="buildinggen__node-move">
                      <button
                        type="button"
                        onClick={() => onMoveNode(node.id, -1)}
                        disabled={!canMoveNode(doc, node.id, -1)}
                        title="Move earlier in the chain"
                      >
                        <span className="material-symbols-outlined">keyboard_arrow_up</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onMoveNode(node.id, 1)}
                        disabled={!canMoveNode(doc, node.id, 1)}
                        title="Move later in the chain"
                      >
                        <span className="material-symbols-outlined">keyboard_arrow_down</span>
                      </button>
                    </span>
                  ) : null}
                  {/* An Output cannot be deleted - the graph compiles to nothing
                      without one, and offering the button invites the mistake. */}
                  {!def?.singleton && (
                    <button
                      type="button"
                      className="buildinggen__node-del"
                      onClick={() => onRemoveNode(node.id)}
                      title={`Delete this ${def?.label || node.type}`}
                    >
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  )}
                </li>
              )
            })}
          </ul>

          <div className="buildinggen__add">
            {CATALOG_ORDER.filter(type => canInsert(doc, selected, type)).map(type => (
              <button
                key={type}
                type="button"
                className="buildinggen__add-btn"
                onClick={() => onAddNode(type)}
                title={CATALOG[type].blurb}
              >
                <span className="material-symbols-outlined">add</span>
                {CATALOG[type].label}
              </button>
            ))}
            {/* NOT A NODE BUTTON. A Merge needs two buildings, so the useful
                action is "give me a second one": a Footprint, a Mass, a Roof and
                the Merge, wired. It is how a tower, a porch or a wing is made,
                and it is the only thing in this palette that adds more than one
                node. */}
            <button
              type="button"
              className="buildinggen__add-btn"
              onClick={onAddWing}
              title={'A second building - a tower, a wing, a porch - merged into this one. '
                + 'It gets its own plan and its own roof.'}
            >
              <span className="material-symbols-outlined">add</span>
              Wing
            </button>
          </div>

          <div className="buildinggen__stats">
            <div><span>Storeys</span><strong>{stats.storeyCount ?? 0}</strong></div>
            <div><span>Walls</span><strong>{Math.round((stats.height || 0) * 10) / 10} m</strong></div>
            {/* Shown separately from the wall height rather than folded into it:
                the two are set by different nodes, and "my building got taller"
                when the only thing that changed was the roof pitch is confusing. */}
            {stats.roofHeight > 0 && (
              <div>
                <span>Roof</span>
                <strong>+{Math.round(stats.roofHeight * 10) / 10} m</strong>
              </div>
            )}
            <div><span>Footprint</span><strong>{Math.round(stats.footprintArea || 0)} m²</strong></div>
            <div><span>Floor area</span><strong>{Math.round(stats.floorArea || 0)} m²</strong></div>
            <div><span>Status</span><strong>{dirty ? 'Unsaved' : 'Saved'}</strong></div>
          </div>
        </aside>

        {/* --- centre: plan or preview --- */}
        <main className="buildinggen__centre">
          <div className="buildinggen__tabs">
            {TABS.map(entry => (
              <button
                key={entry.id}
                type="button"
                className={`buildinggen__tab ${tab === entry.id ? 'buildinggen__tab--on' : ''}`}
                onClick={() => setTab(entry.id)}
              >
                <span className="material-symbols-outlined">{entry.icon}</span>
                {entry.label}
              </button>
            ))}
            <span className="buildinggen__spacer" />
            {tab === 'preview' && (
              <>
                <button
                  type="button"
                  className="buildinggen__tab"
                  onClick={() => setOrthographic(v => !v)}
                  title="Perspective or orthographic"
                >
                  <span className="material-symbols-outlined">
                    {orthographic ? 'grid_view' : 'view_in_ar'}
                  </span>
                </button>
                <button
                  type="button"
                  className="buildinggen__tab"
                  onClick={() => setFrameKey(k => k + 1)}
                  title="Frame the building"
                >
                  <span className="material-symbols-outlined">fit_screen</span>
                </button>
              </>
            )}
          </div>

          {/* BOTH PANES STAY MOUNTED, stacked, with the inactive one hidden.
              Unmounting the R3F canvas on every tab switch destroys its WebGL
              context - the console fills with "THREE.WebGLRenderer: Context
              Lost", and a browser only grants about sixteen contexts before it
              starts evicting live ones, so a few dozen tab switches would break
              the page outright. Hidden with opacity and pointer-events rather
              than display:none, which would collapse the canvas to zero size and
              make R3F reallocate the drawing buffer on every switch anyway.
              The idle pane's frameloop is parked so it costs nothing. */}
          <div className="buildinggen__stage">
            <div
              className={`buildinggen__pane ${tab === 'plan' ? '' : 'buildinggen__pane--off'}`}
              aria-hidden={tab !== 'plan'}
            >
              {footprintNode ? (
                <>
                  {/* WHICH PLAN, once there is more than one to confuse. A
                      merged building has a footprint per wing and they all look
                      like "the plan"; the editor follows the selection, so this
                      says what the selection currently is and offers the others.
                      Hidden on a single-plan document, where it is noise. */}
                  {footprintNodes.length > 1 && (
                    <div className="buildinggen__planpick">
                      <span>Editing</span>
                      {footprintNodes.map((node, index) => (
                        <button
                          key={node.id}
                          type="button"
                          className={`buildinggen__planpick-btn ${
                            node.id === footprintNode.id ? 'buildinggen__planpick-btn--on' : ''}`}
                          onClick={() => setSelectedId(node.id)}
                        >
                          {index === 0 ? 'Main plan' : `Wing ${index}`}
                        </button>
                      ))}
                    </div>
                  )}
                  <BuildingPlanEditor
                    planId={footprintNode.id}
                    shape={footprintNode.props.shape}
                    gridSize={footprintNode.props.gridSize}
                    onChange={onPlanChange}
                    onCommit={onPlanCommit}
                  />
                </>
              ) : (
                <div className="buildinggen__placeholder">
                  <span className="material-symbols-outlined">architecture</span>
                  <p>This document has no Footprint node to edit.</p>
                </div>
              )}
            </div>
            <div
              className={`buildinggen__pane ${tab === 'preview' ? '' : 'buildinggen__pane--off'}`}
              aria-hidden={tab !== 'preview'}
            >
              <BuildingViewport
                ir={compiled.ir}
                frameKey={frameKey}
                orthographic={orthographic}
                active={tab === 'preview'}
              />
            </div>
          </div>

          {compiled.diagnostics.length > 0 && (
            <ul className="buildinggen__diagnostics">
              {compiled.diagnostics.map((entry, index) => (
                <li
                  key={`${entry.code}-${index}`}
                  className={`buildinggen__diag buildinggen__diag--${entry.severity}`}
                >
                  <span className="material-symbols-outlined">
                    {entry.severity === SEVERITY.ERROR ? 'error'
                      : entry.severity === SEVERITY.WARN ? 'warning' : 'info'}
                  </span>
                  <span className="buildinggen__diag-text">
                    {entry.message}
                    {entry.hint && <em> {entry.hint}</em>}
                  </span>
                  {entry.nodeId && (
                    <button
                      type="button"
                      className="buildinggen__diag-btn"
                      onClick={() => setSelectedId(entry.nodeId)}
                    >
                      Show
                    </button>
                  )}
                  {canApplyFix(entry.fix) && (
                    <button
                      type="button"
                      className="buildinggen__diag-btn"
                      onClick={() => onApplyFix(entry.fix)}
                    >
                      {entry.fix.label}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </main>

        {/* --- right: inspector --- */}
        <aside className="buildinggen__sidebar buildinggen__sidebar--right">
          <BuildingInspector
            doc={doc}
            selectedId={selected}
            onProp={onProp}
            onPropCommit={onPropCommit}
            onMode={onMode}
            onToggleEnabled={onToggleEnabled}
            onEditPlan={() => setTab('plan')}
            onEditCurve={onEditCurve}
            openCurve={openCurve && openCurve.startsWith(`${selected}:`)
              ? openCurve.slice(String(selected).length + 1)
              : null}
            onAddTexture={onAddTexture}
            onRemoveTexture={onRemoveTexture}
            onGenerateTexture={onGenerateTexture}
            onRotateMesh={onRotateMesh}
            onRetileTexture={onRetileTexture}
          />
        </aside>
      </div>

      <div className="buildinggen__actions">
        <button
          type="button"
          className="buildinggen__btn"
          onClick={() => history.undo()}
          disabled={!history.canUndo}
          title={history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'}
        >
          <span className="material-symbols-outlined">undo</span>
        </button>
        <button
          type="button"
          className="buildinggen__btn"
          onClick={() => history.redo()}
          disabled={!history.canRedo}
          title={history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'}
        >
          <span className="material-symbols-outlined">redo</span>
        </button>
        <span className="buildinggen__spacer" />
        <button
          type="button"
          className="buildinggen__btn"
          onClick={() => setExporting(true)}
          disabled={!compiled.ir?.levels?.length}
          title="Save as a mesh, with LOD levels regenerated from the graph"
        >
          Export
        </button>
        {savedAssetId != null && (
          <button
            type="button"
            className="buildinggen__btn"
            onClick={() => handleSave({ forkNew: true })}
            disabled={saving || status === 'loading'}
          >
            Save As New
          </button>
        )}
        <button
          type="button"
          className="buildinggen__btn buildinggen__btn--primary"
          onClick={() => handleSave()}
          disabled={saving || status === 'loading'}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      <Footer variant="kanban" />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}
