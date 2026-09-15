// The style picker.
//
// A LIST IN THE SIDEBAR RATHER THAN A MODAL DIALOG, which is a deliberate
// departure from the plan's `BuildingPresetsDialog`. A style here is not a
// thumbnail you recognise and dismiss - it restructures the graph, and the only
// honest preview of it is the 3D viewport that a modal would be covering.
// Keeping the list beside the viewport means picking one, seeing the building
// change, and picking the next takes two clicks and no dismissals. When there
// are thirty packs rather than four, a searchable dialog earns its place; at
// four it would only be in the way.
//
// APPLYING IS A DOCUMENT EDIT, not a mode. The panel hands a pack to
// applyStylePack and the page commits the result through the same history the
// inspector uses, so undo takes it back and nothing in the compiler ever learns
// that style packs exist. That is the whole point of the structure/vocabulary
// split: this component is a fancy way of setting some node properties.

import { useEffect, useState } from 'react'
import { applyStylePack } from '../../../building/stylepack.js'
import { fetchStylePack, fetchStylePacks } from '../../utils/buildingApi'
import './BuildingStylePanel.css'

/** The palette as a row of swatches - the fastest read of what a style looks like. */
function Swatches({ palette }) {
  const slots = ['wall', 'roof', 'opening', 'accent']
  return (
    <span className="bstyle__swatches" aria-hidden="true">
      {slots.map(slot => (
        <span
          key={slot}
          className="bstyle__swatch"
          style={{ background: palette?.[slot] || '#333' }}
        />
      ))}
    </span>
  )
}

export default function BuildingStylePanel({ doc, activeId, onApply }) {
  // undefined = still asking, null = could not reach the library, otherwise
  // { styles, skipped } - and an empty `styles` with a non-empty `skipped` is a
  // third thing again: the packs are there and the server would not have them.
  const [library, setLibrary] = useState(undefined)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    fetchStylePacks().then(result => { if (alive) setLibrary(result) })
    return () => { alive = false }
  }, [])

  const apply = async style => {
    setBusy(style.id)
    setError('')
    try {
      // The summary deliberately omits the graph recipe - it is most of the
      // file and a list of thirty would carry thirty of them - so the full pack
      // is fetched on click.
      const pack = await fetchStylePack(style.id)
      const next = applyStylePack(doc, pack)
      // applyStylePack refuses a document with no footprint or no output rather
      // than inventing one, and returns it unchanged. Saying so beats a click
      // that silently does nothing.
      if (next === doc || next.building.stylePackId !== style.id) {
        setError('This document has no Footprint and Output to build between.')
        return
      }
      onApply(next, style.name)
    } catch (err) {
      setError(err.message || 'Could not apply that style.')
    } finally {
      setBusy('')
    }
  }

  // Nothing at all while the first request is in flight - a panel that flashes
  // an error for 200ms on every page load is worse than one that appears late.
  if (library === undefined) return null
  const styles = library?.styles || []
  const skipped = library?.skipped || []

  return (
    <div className="bstyle">
      <h2 className="buildinggen__title">Style</h2>
      {/* SAYING SO RATHER THAN VANISHING. The route is served by server.js, which
          is a plain Node process with no hot reload, so the single most likely
          reason for an empty library is a server started before the route
          existed. Rendering nothing here made the whole feature look unbuilt -
          which is exactly how it was first reported. */}
      {library === null && (
        <p className="bstyle__error">
          Could not reach the style library. If you have just updated, restart
          the server - <code>/api/buildings/styles</code> is new.
        </p>
      )}
      {/* Rejected, not absent. Nearly always a server started before a node
          type the packs use existed - the catalog is read once, at startup. */}
      {library && !styles.length && skipped.length > 0 && (
        <p className="bstyle__error">
          {skipped.length} style {skipped.length === 1 ? 'pack was' : 'packs were'} rejected.
          Restart the server if you have just updated. First problem:
          {' '}<code>{skipped[0].id}</code> — {skipped[0].problem}
        </p>
      )}
      {library && !styles.length && !skipped.length && (
        <p className="bstyle__note">
          No style packs are installed. They live in
          {' '}<code>resources/buildings/styles/</code>.
        </p>
      )}
      <ul className="bstyle__list">
        {styles.map(style => (
          <li key={style.id}>
            <button
              type="button"
              className={`bstyle__item ${activeId === style.id ? 'bstyle__item--on' : ''}`}
              onClick={() => apply(style)}
              disabled={Boolean(busy)}
              title={style.blurb}
            >
              <Swatches palette={style.palette} />
              <span className="bstyle__text">
                <span className="bstyle__name">{style.name}</span>
                <span className="bstyle__category">{style.category}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {/* Said once, here, rather than in a tooltip on every row: applying a
          style REPLACES the nodes between the footprint and the output, and a
          user who has just tuned a facade deserves to know that before clicking
          rather than after. Undo covers it, which is why this is a note and not
          a confirmation. */}
      {styles.length > 0 && (
        <p className="bstyle__note">
          Applying a style rebuilds the nodes between the Footprint and the Output.
          Your plan is kept. Undo restores the previous graph.
        </p>
      )}
      {error && <p className="bstyle__error">{error}</p>}
    </div>
  )
}
