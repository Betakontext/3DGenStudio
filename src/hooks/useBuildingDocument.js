// Loading, saving and draft recovery for one building document.
//
// LOCAL DRAFT PLUS AN EXPLICIT SAVE - deliberately not a debounced server
// autosave like the Brainstorming Board's, for the same three reasons
// useVfxDocument.js sets out: every server save is a full multipart file replace
// plus a thumbnail render, replaceAssetFileById has no optimistic-concurrency
// check so two tabs autosaving is a silent last-write-wins, and the one thing in
// this repo that DOES autosave earned it with a partial-update route that
// buildings do not have.
//
// So the draft goes to localStorage on a short debounce and the author presses
// Save. Nothing is lost to a crash or a stray navigation, and nothing is written
// to the library the author did not ask for.
//
// THE LOAD-ONCE GUARD HAS NO CANCELLATION FLAG, and that is not an oversight.
// TreeGenPage.jsx records the bug: combining a cleanup flag with a run-once ref
// meant StrictMode's mount -> cleanup -> re-mount cancelled the first fetch
// while the second self-skipped, so the document silently never loaded and the
// page showed a default that looked like a successful load. The ref alone is
// correct.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildingSignature,
  createBuildingDoc,
  normalizeBuildingDoc,
} from '../../building/doc.js'
import {
  libraryAssetId,
  loadBuildingAsset,
  saveBuildingAsset,
} from '../utils/buildingApi.js'
// Reused rather than cloned: useVfxHistory is a generic snapshot undo stack
// over any value - coalesce keys, entry labels, a focus id - and nothing in it
// is particular to a particle system. Only its comments mention VFX. Aliased on
// import so the code below does not read as if buildings were part of that
// feature.
import useSnapshotHistory from './useVfxHistory.js'

const DRAFT_PREFIX = 'building:draft:'
const DRAFT_DEBOUNCE_MS = 1000

const draftKey = assetId => `${DRAFT_PREFIX}${assetId ?? 'new'}`

// localStorage throws in a few real contexts - a private window, site data
// blocked, a thumbnail capture - so every access is guarded and a failure
// degrades to "no draft" rather than taking the editor down.
function readDraft(key) {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.doc) return null
    return { doc: parsed.doc, savedAt: parsed.savedAt || 0, name: parsed.name || '' }
  } catch {
    return null
  }
}

function writeDraft(key, payload) {
  try {
    window.localStorage.setItem(key, JSON.stringify(payload))
  } catch {
    // Quota, or a browser refusing storage. Nothing to do and nothing worth
    // telling the author: the document is still in memory and Save still works.
  }
}

function clearDraft(key) {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // As above.
  }
}

/**
 * @param {{assetId?: string|number|null, onError?: (message: string) => void}} options
 */
export default function useBuildingDocument({ assetId = null, onError = null } = {}) {
  const numericId = libraryAssetId(assetId)
  const key = draftKey(numericId)

  // A factory, so the empty document is built once on mount rather than on every
  // render - useState reads a function as a lazy initialiser.
  const history = useSnapshotHistory(() => createBuildingDoc({ name: 'Untitled Building' }))
  const doc = history.value
  // Destructured because `history` is a fresh object each render while these two
  // are useCallback-stable. Depending on the object would make every callback
  // below unstable, and the board's memoised nodes would re-render on every
  // keystroke anywhere on the page.
  const { commit: commitHistory, reset: resetHistory } = history
  const [name, setName] = useState('Untitled Building')
  const [savedAssetId, setSavedAssetId] = useState(numericId)
  const [status, setStatus] = useState(numericId ? 'loading' : 'idle')
  const [saving, setSaving] = useState(false)
  // Read in a state initialiser rather than an effect: reading storage during
  // render is fine, and setting state from an effect body is what the hooks
  // linter (correctly) objects to.
  const [draft, setDraft] = useState(() => readDraft(key))

  const [savedSignature, setSavedSignature] = useState(() => buildingSignature(doc))
  const loadedRef = useRef(null)

  /**
   * Record an edit, with an undo label and an optional coalesce key.
   *
   * Normalising here rather than in each caller means a mutator can return a
   * loosely-shaped document and normalizeBuildingDoc still runs - which is what
   * keeps the `linked` mirror and the edge list in step (invariant 1).
   */
  const commit = useCallback((next, meta = {}) => {
    commitHistory(
      current => normalizeBuildingDoc(typeof next === 'function' ? next(current) : next),
      meta,
    )
  }, [commitHistory])

  // Load the asset named in the URL. Runs once per id - see the header for why
  // there is no cancellation flag.
  useEffect(() => {
    if (numericId == null) return
    if (loadedRef.current === numericId) return
    loadedRef.current = numericId

    loadBuildingAsset(numericId)
      .then(({ doc: loaded, record }) => {
        resetHistory(loaded)
        setName(loaded.name || record?.name || 'Building')
        setSavedAssetId(numericId)
        setSavedSignature(buildingSignature(loaded))
        setStatus('idle')
      })
      .catch(error => {
        setStatus('error')
        onError?.(error?.message || 'Could not open that building')
      })
    // onError is intentionally absent: it is a fresh closure each render and
    // including it would re-fetch on every keystroke elsewhere on the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numericId])

  const signature = buildingSignature(doc)
  const dirty = signature !== savedSignature

  // Mirror to localStorage while dirty. Debounced, and skipped entirely when
  // clean, so opening a building and looking at it writes nothing.
  useEffect(() => {
    if (!dirty) return undefined
    const timer = setTimeout(() => {
      writeDraft(key, { doc, name, savedAt: Date.now() })
    }, DRAFT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [dirty, doc, key, name])

  // A draft has to survive the tab closing, which the debounce above cannot
  // promise on its own. pagehide rather than beforeunload: it fires on mobile
  // and on back-forward cache navigations too.
  useEffect(() => {
    const flush = () => {
      if (signature !== savedSignature) {
        writeDraft(key, { doc, name, savedAt: Date.now() })
      }
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
      flush()
    }
  }, [doc, key, name, savedSignature, signature])

  const restoreDraft = useCallback(() => {
    if (!draft) return
    resetHistory(normalizeBuildingDoc(draft.doc))
    if (draft.name) setName(draft.name)
    setDraft(null)
  }, [draft, resetHistory])

  const discardDraft = useCallback(() => {
    clearDraft(key)
    setDraft(null)
  }, [key])

  /**
   * Save to the library.
   *
   * `forkNew` is what "Save As" passes: it drops the asset id so the upload
   * creates a second asset instead of replacing the one that is open.
   */
  const save = useCallback(async ({ thumbnail = null, forkNew = false } = {}) => {
    setSaving(true)
    try {
      const targetId = forkNew ? null : savedAssetId
      const saved = await saveBuildingAsset({ name, doc, thumbnail, assetId: targetId })
      const newId = libraryAssetId(saved?.id ?? saved?.assetId ?? targetId)
      if (newId != null) {
        setSavedAssetId(newId)
        // The draft belonged to the OLD key ('new' for an unsaved document), so
        // clearing the current key is not enough once an id has been minted.
        clearDraft(key)
        clearDraft(draftKey(newId))
      } else {
        clearDraft(key)
      }
      setDraft(null)
      setSavedSignature(buildingSignature(doc))
      setStatus('idle')
      return saved
    } catch (error) {
      onError?.(error?.message || 'Could not save the building')
      throw error
    } finally {
      setSaving(false)
    }
  }, [doc, key, name, onError, savedAssetId])

  /** Start over with a blank document, keeping the page mounted. */
  const reset = useCallback(() => {
    resetHistory(createBuildingDoc({ name: 'Untitled Building' }))
    setName('Untitled Building')
    setSavedAssetId(null)
    setSavedSignature(buildingSignature(createBuildingDoc({ name: 'Untitled Building' })))
    setStatus('idle')
  }, [resetHistory])

  return {
    doc,
    name,
    setName,
    commit,
    history,
    status,
    saving,
    dirty,
    savedAssetId,
    draft,
    restoreDraft,
    discardDraft,
    save,
    reset,
  }
}
