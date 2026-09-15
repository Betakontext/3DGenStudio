// The style picker.
//
// A DROPDOWN IN THE SIDEBAR, and it used to be a list. The list's own comment
// said the trade explicitly: "when there are thirty packs rather than four, a
// searchable dialog earns its place; at four it would only be in the way". At
// eleven the list was taller than the viewport controls beside it and pushed the
// texture slots off the bottom of the panel, which is the point at which a
// vertical stack stops being a convenience. A select collapses to one row,
// groups by category for free, and is keyboard- and type-ahead-navigable without
// anything being written here.
//
// WHAT THE LIST WAS ACTUALLY GOOD AT was showing the palette, so the swatch
// strip stays - moved below the select, for the SELECTED style, alongside its
// blurb. One style's colours at a time rather than eleven, which is what you
// want once you have chosen.
//
// STILL NOT A MODAL. A style restructures the graph, and the only honest preview
// of it is the 3D viewport a dialog would be covering. Picking one, watching the
// building change and picking the next has to stay cheap.
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

/**
 * Styles grouped by category, both the groups and the styles in name order.
 *
 * SORTED HERE rather than relying on the directory order the route happens to
 * return. A select is scanned by eye and by type-ahead, and an arbitrary order
 * defeats both; the directory listing is alphabetical by FILENAME, which is not
 * the same as by name and is not grouped at all.
 */
function byCategory(styles) {
  const groups = new Map()
  for (const style of styles) {
    const key = style.category || 'Other'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(style)
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, list]) => [category, list.sort((a, b) => a.name.localeCompare(b.name))])
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
  const active = styles.find(style => style.id === activeId) || null

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

      {styles.length > 0 && (
        <div className="bstyle__pick">
          <select
            className="bstyle__select"
            value={active ? active.id : ''}
            disabled={Boolean(busy)}
            onChange={event => {
              const style = styles.find(candidate => candidate.id === event.target.value)
              if (style) apply(style)
            }}
            aria-label="Style"
          >
            {/* A PLACEHOLDER ROW, because a document starts with no style and a
                select has to show something. Disabled so it cannot be chosen as
                an action - there is no "un-apply", only undo. */}
            <option value="" disabled>
              {active ? active.name : 'Choose a style…'}
            </option>
            {byCategory(styles).map(([category, list]) => (
              <optgroup key={category} label={category}>
                {list.map(style => (
                  <option key={style.id} value={style.id}>{style.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
          {/* RE-APPLY, which the list gave away for free and a select takes back:
              choosing the row you are already on fires no change event. It is
              worth a button because applying is how you get BACK to a style
              after tuning a facade and deciding you preferred it as shipped. */}
          <button
            type="button"
            className="bstyle__again"
            onClick={() => active && apply(active)}
            disabled={!active || Boolean(busy)}
            title={active
              ? `Apply ${active.name} again, discarding your changes to its nodes`
              : 'Pick a style first'}
          >
            <span className="material-symbols-outlined">refresh</span>
          </button>
        </div>
      )}

      {/* The chosen style's identity: its palette and what it is for. One
          style's colours rather than eleven, which is the trade the dropdown
          makes and the reason the swatches did not simply disappear with the
          list. */}
      {active && (
        <div className="bstyle__current">
          <Swatches palette={active.palette} />
          <span className="bstyle__blurb">{active.blurb}</span>
        </div>
      )}

      {/* Said once, here, rather than in a tooltip on every row: applying a
          style REPLACES the nodes between the footprint and the output, and a
          user who has just tuned a facade deserves to know that before choosing
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
