// The inspector, which has NO SCHEMA OF ITS OWN.
//
// It renders whatever the catalog entry for the selected node declares - rule 1
// in building/catalog.js. Adding a node type is a catalog entry plus an
// evaluator, and this file does not change. That is the property that decides
// whether the remaining phases (floors, bays, roofs, trim) are data or are
// another React component each.
//
// TWO BEHAVIOURS WORTH NAMING:
//
//   A PROPERTY THAT DOES NOT APPLY IS GREYED, NOT HIDDEN. `showFor` in the
//   catalog says which modes a row is meaningful under. Hiding it means a
//   control that is still affecting the result has vanished from the UI, which
//   is the worse of the two failures - the author changes the mode back and
//   finds a value they never set.
//
//   A DRIVEN INPUT IS SHOWN AS DRIVEN. When an edge feeds a port, the row says
//   so instead of offering a field whose value the compiler ignores.

import { getNodeDef, propApplies, readMode, readProp } from '../../../building/catalog.js'
import { PROP_TYPE } from '../../../building/catalog.js'
// The VFX curve editor, unchanged. A profile curve is the same object a VFX
// curve is - see building/param.js - so this is 743 lines of tested canvas
// interaction that did not need writing twice. `scale: 1` and `unit: 'm'`
// because a building profile stores metres directly rather than a normalised
// value, and `domainLabel` because the horizontal axis here is height, not a
// particle's age.
import VfxCurveEditor from '../vfx/VfxCurveEditor'
import { useEffect, useRef } from 'react'
import './BuildingInspector.css'

/**
 * Scrolls the curve editor into view when it opens.
 *
 * The inspector rail is 320px and the editor is a canvas plus a toolbar, so on
 * a Mass node it opens below the fold - the author clicks "Edit curve" and
 * nothing appears to happen, which is the same class of problem as the mode that
 * did nothing. Deferred a frame so the panel has laid out at its new height
 * before the scroll is measured.
 */
function CurvePanel({ children }) {
  const ref = useRef(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return undefined
    const handle = requestAnimationFrame(() => {
      node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(handle)
  }, [])
  return <div className="binspect__curve" ref={ref}>{children}</div>
}

function NumberField({ spec, value, onChange, onCommit, disabled }) {
  return (
    <div className="binspect__control">
      <input
        type="number"
        className="binspect__input"
        value={value}
        min={spec.min}
        max={spec.max}
        step={spec.step ?? (spec.type === PROP_TYPE.INT ? 1 : 0.1)}
        disabled={disabled}
        onChange={event => onChange(Number(event.target.value))}
        onBlur={event => onCommit(Number(event.target.value))}
      />
      {spec.unit && <span className="binspect__unit">{spec.unit}</span>}
    </div>
  )
}

function ModeField({ spec, value, onCommit, disabled }) {
  return (
    <select
      className="binspect__select"
      value={value}
      disabled={disabled}
      onChange={event => onCommit(event.target.value)}
    >
      {(spec.options || []).map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  )
}

export default function BuildingInspector({
  doc,
  selectedId,
  onProp,
  onPropCommit,
  onMode,
  onToggleEnabled,
  onEditPlan,
  onEditCurve,
  openCurve = null,
}) {
  const node = doc?.nodes?.find(candidate => candidate.id === selectedId) || null
  const def = node ? getNodeDef(node.type) : null

  if (!node || !def) {
    return (
      <div className="binspect binspect--empty">
        <span className="material-symbols-outlined">tune</span>
        <p>Select a node to edit it.</p>
      </div>
    )
  }

  const driven = new Set(node.linked || [])
  const activeMode = key => readMode(node, key)

  // Basic rows first, then the rest. The split is declared per property in the
  // catalog so the ordering is a property of the vocabulary, not of this file.
  const propEntries = Object.entries(def.props || {})
  const basic = propEntries.filter(([, spec]) => spec.basic)
  const advanced = propEntries.filter(([, spec]) => !spec.basic)

  const renderProp = ([key, spec]) => {
    const applies = propApplies(node, key)
    const isDriven = driven.has(key)
    const value = readProp(node, key)

    return (
      <div
        key={key}
        className={`binspect__row ${applies ? '' : 'binspect__row--muted'}`}
        title={spec.hint || ''}
      >
        <span className="binspect__label">{spec.label}</span>

        {isDriven ? (
          <span className="binspect__driven">
            <span className="material-symbols-outlined">link</span>
            driven by a connection
          </span>
        ) : spec.type === PROP_TYPE.POLYGON ? (
          <button type="button" className="binspect__plan-btn" onClick={onEditPlan}>
            <span className="material-symbols-outlined">edit</span>
            Edit on the Plan tab
          </button>
        ) : spec.type === PROP_TYPE.BOOL ? (
          <input
            type="checkbox"
            className="binspect__check"
            checked={Boolean(value)}
            disabled={!applies}
            onChange={event => onPropCommit(node.id, key, event.target.checked)}
          />
        ) : spec.type === PROP_TYPE.CURVE ? (
          <button
            type="button"
            className="binspect__plan-btn"
            onClick={() => onEditCurve(node.id, key)}
            disabled={!applies}
          >
            <span className="material-symbols-outlined">show_chart</span>
            {openCurve === key ? 'Close curve' : 'Edit curve'}
          </button>
        ) : (
          <NumberField
            spec={spec}
            value={value}
            disabled={!applies}
            onChange={next => onProp(node.id, key, next)}
            onCommit={next => onPropCommit(node.id, key, next)}
          />
        )}

        {!applies && (
          <span className="binspect__note">
            not used by the {activeMode(Object.keys(spec.showFor || {})[0])} setting
          </span>
        )}

        {spec.type === PROP_TYPE.CURVE && openCurve === key && applies && (
          <CurvePanel>
            <VfxCurveEditor
              value={value}
              unit="m"
              scale={1}
              domainLabel="height"
              label={spec.label}
              onChange={next => onProp(node.id, key, next)}
              onCommit={next => onPropCommit(node.id, key, next)}
              onClose={() => onEditCurve(node.id, null)}
            />
          </CurvePanel>
        )}
      </div>
    )
  }

  return (
    <div className="binspect">
      <header className="binspect__head">
        <span className="material-symbols-outlined binspect__icon">{def.icon}</span>
        <div className="binspect__titles">
          <h3 className="binspect__title">{def.label}</h3>
          <p className="binspect__blurb">{def.blurb}</p>
        </div>
        <button
          type="button"
          className={`binspect__mute ${node.enabled ? '' : 'binspect__mute--on'}`}
          onClick={() => onToggleEnabled(node.id, !node.enabled)}
          title={node.enabled ? 'Mute this node' : 'Unmute this node'}
        >
          <span className="material-symbols-outlined">
            {node.enabled ? 'visibility' : 'visibility_off'}
          </span>
        </button>
      </header>

      {def.teach && <p className="binspect__teach">{def.teach}</p>}

      {Object.keys(def.modes || {}).length > 0 && (
        <section className="binspect__section">
          {Object.entries(def.modes).map(([key, spec]) => {
            const value = activeMode(key)
            const option = (spec.options || []).find(candidate => candidate.value === value)
            return (
              <div key={key} className="binspect__row binspect__row--mode">
                <span className="binspect__label">{spec.label}</span>
                <ModeField spec={spec} value={value} onCommit={next => onMode(node.id, key, next)} />
                {/* The teach line for the SELECTED option, not for the node.
                    This is where an author learns that Batter is what makes an
                    Egyptian pylon, at the moment they are choosing it. */}
                {option?.teach && <span className="binspect__note">{option.teach}</span>}
              </div>
            )
          })}
        </section>
      )}

      {basic.length > 0 && <section className="binspect__section">{basic.map(renderProp)}</section>}

      {advanced.length > 0 && (
        <details className="binspect__advanced">
          <summary>More</summary>
          <section className="binspect__section">{advanced.map(renderProp)}</section>
        </details>
      )}
    </div>
  )
}
