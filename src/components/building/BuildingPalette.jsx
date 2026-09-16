// The six slot colours, editable.
//
// WHY THIS EXISTS. Every surface the generator draws takes its colour from one
// of six palette slots, and until now the only way to set them was to apply a
// style pack - so "the timbers are the wrong brown" had no answer short of
// editing a JSON file on disk and restarting the server. It was reported exactly
// that way, about the Frame node, which draws in the trim slot.
//
// IT EDITS THE DOCUMENT, NOT THE PACK. A pack is shared by every building that
// uses it; this is one building's paint. `building.style` is already the
// per-document snapshot a pack leaves behind, so a colour set here survives a
// save, travels in a `.3dgp` export, and is overwritten the next time a style is
// applied - which is the right behaviour, because applying a style is a
// deliberate "make it look like this".
//
// A NATIVE COLOUR INPUT, not a picker of our own. It is one control, the OS
// gives it a real eyedropper and recent-colours, and a hand-rolled HSV square
// would be three hundred lines to be worse at it.

import { PALETTE_SLOTS } from '../../../building/stylepack.js'
import './BuildingPalette.css'

/** What each slot actually paints, in the author's terms rather than the IR's. */
const WHAT = {
  wall: 'Walls, and anything masonry - including chimneys.',
  trim: 'Mouldings, timber framing, posts and balconies.',
  roof: 'Every roof surface.',
  opening: 'Windows and the other openings.',
  door: 'Doors.',
  accent: 'Reserved for style packs.',
}

const LABEL = {
  wall: 'Walls',
  trim: 'Trim & timber',
  roof: 'Roof',
  opening: 'Windows',
  door: 'Doors',
  accent: 'Accent',
}

/**
 * @param {Object} props
 * @param {Object} props.palette  slot -> hex, already resolved through paletteOf
 * @param {Object} props.overrides  the document's own overrides, for the reset state
 * @param {(slot: string, hex: string) => void} props.onChange
 * @param {() => void} props.onReset
 */
export default function BuildingPalette({ palette, overrides, onChange, onReset }) {
  const changed = Object.keys(overrides || {}).length > 0

  return (
    <div className="bpal">
      <div className="bpal__head">
        <h2 className="buildinggen__title">Colours</h2>
        {/* Only offered once there is something to undo, so the ordinary panel
            has one control rather than two. */}
        {changed && (
          <button type="button" className="bpal__reset" onClick={onReset}>
            Reset
          </button>
        )}
      </div>
      <ul className="bpal__list">
        {PALETTE_SLOTS.map(slot => (
          <li key={slot} className="bpal__row" title={WHAT[slot]}>
            <input
              type="color"
              className="bpal__swatch"
              value={palette[slot] || '#888888'}
              onChange={event => onChange(slot, event.target.value)}
              aria-label={LABEL[slot] || slot}
            />
            <span className="bpal__text">
              <span className="bpal__label">{LABEL[slot] || slot}</span>
              {/* The hex, because an author matching a reference has one to type
                  and reading it back is how they know it took. */}
              <span className="bpal__hex">
                {(palette[slot] || '').toUpperCase()}
                {overrides?.[slot] ? ' ·' : ''}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="bpal__note">
        A colour is what a slot shows with no texture on it. Binding a texture
        replaces it. Applying a style replaces the lot.
      </p>
    </div>
  )
}
