import { useEffect, useMemo, useState } from 'react'
import { useProjects } from '../../context/ProjectContext'
import { useWorkflowJobs } from '../../context/WorkflowJobsContext'
import { API_BASE } from '../../config'
import { createComfyExecutionId } from '../../utils/ids'
// The same field the Graph, Kanban, Image Editor and VFX panels use. A texture
// workflow has a seed, a step count and a resolution like any other, and hiding
// them behind one prompt box means every texture comes out of the same dice
// roll. Reusing it also means enum parameters arrive as dropdowns for free.
import WorkflowParameterField from '../imageEditor/controls/WorkflowParameterField'
import { SLOT_GUIDE, TILEABLE_SUFFIX } from '../../utils/building/textureSlots'
import './BuildingAiPanel.css'

// The type of a workflow parameter or output.
//
// ONE READER, because there are two spellings and they are not both always
// present: a PARAMETER carries `type` and `valueType`, an OUTPUT carries only
// `valueType`. This exact mistake emptied the VFX sprite dropdown.
const typeOf = entry => entry?.valueType || entry?.type || ''

// Generate the style pack's textures with ComfyUI.
//
// WHAT COMFYUI IS ACTUALLY FOR IN THIS FEATURE, since it is easy to get
// backwards: it does NOT generate buildings. A diffusion model cannot give you
// something metrically correct, modular and LOD-able, which is exactly what a
// building has to be - that is what the node graph is for. What it is very good
// at is the VOCABULARY: a tileable brick, a roof tile, a weathered timber, a
// stucco. So this panel fills the style pack's material slots and nothing else.
//
// TILEABLE IS THE WHOLE REQUIREMENT, and it is the one thing the author cannot
// fix afterwards. mesh.js UV-maps walls in metres, so every wall shows the image
// several times over and a seam runs up the building at every repeat. The prompt
// suffix below is therefore not decoration - it is the difference between a
// texture that works and one that cannot be used at all. Stated in the UI rather
// than hidden, so an author whose texture seams knows where to look.
//
// FLAT-LIT MATTERS ALMOST AS MUCH. A generated image with its own sun baked in
// fights the scene's lighting: the shadow direction is wrong on three of the
// four walls, and no amount of relighting removes it.
//
// NO PROJECT IS INVOLVED. Buildings are library-global - see buildingApi.js - so
// the run asks for no project and for `persistGeneratedAssets: false`; the bytes
// come back as a data URL and are uploaded to the LIBRARY here.

/**
 * @param {Object} props
 * @param {string} props.slot         a TEXTURE_SLOTS entry, for the prompt guide
 * @param {string} props.refKey       the doc.references key the result binds to
 * @param {(refKey: string, asset: {assetId: number, name: string, tile: number}) => void} props.onGenerated
 * @param {() => void} props.onClose
 */
export default function BuildingAiPanel({ slot, refKey, onGenerated, onClose }) {
  const { getComfyWorkflows, runComfyWorkflow } = useProjects()
  const { registerJob, completeJob } = useWorkflowJobs()
  const guide = SLOT_GUIDE[slot] || SLOT_GUIDE.wall

  const [workflows, setWorkflows] = useState([])
  const [workflowId, setWorkflowId] = useState('')
  const [prompt, setPrompt] = useState(guide.prompts[0][1])
  const [tile, setTile] = useState(guide.tile)
  // Sparse over the workflow's own defaults - an untouched field means "whatever
  // the workflow saved", which for a seed or a step count is the only sane
  // fallback.
  const [values, setValues] = useState({})
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  // So an empty dropdown can say whether the library is empty or whether nothing
  // in it matched.
  const [considered, setConsidered] = useState(null)

  useEffect(() => {
    let cancelled = false
    getComfyWorkflows?.()
      .then(list => {
        if (cancelled) return
        // TEXT IN, IMAGE OUT, AND NOTHING ELSE REQUIRED. The third clause is the
        // one that is easy to miss: most prompt-and-image workflows also need an
        // IMAGE supplied (Inpainting, Remove Background, projection), and this
        // panel has none to give - they would fail after the author had waited
        // for the run.
        const all = list || []
        const usable = all.filter(entry => (
          (entry.outputs || []).some(output => typeOf(output) === 'image')
          && (entry.parameters || []).some(p => typeOf(p) === 'string')
          && !(entry.parameters || []).some(p => ['image', 'mesh'].includes(typeOf(p)))
        ))
        usable.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
        setWorkflows(usable)
        setConsidered(all.length)
        setWorkflowId(current => current || usable[0]?.id || '')
      })
      .catch(() => setError('Could not read the ComfyUI workflow library.'))
    return () => { cancelled = true }
  }, [getComfyWorkflows])

  const workflow = useMemo(
    () => workflows.find(entry => String(entry.id) === String(workflowId)) || null,
    [workflows, workflowId],
  )

  // Parameter ids are `<nodeId>.<inputKey>`, so "6.text" exists in most of these
  // workflows and means something different in each. Carrying edits across a
  // workflow change would apply one workflow's step count to another's sampler.
  const selectWorkflow = id => {
    setWorkflowId(id)
    setValues({})
  }

  // The first string parameter is the prompt. Guessing by NAME would break the
  // moment someone renamed a node.
  const promptParam = useMemo(
    () => (workflow?.parameters || []).find(p => typeOf(p) === 'string'),
    [workflow],
  )

  const generate = async () => {
    if (!workflow || !promptParam) return setError('Choose a workflow that takes a text prompt.')
    if (!prompt.trim()) return setError('Describe the material first.')

    const promptId = createComfyExecutionId('comfy-prompt')
    setRunning(true)
    setError('')
    setResult(null)

    // REGISTERED WITH THE JOBS STORE so the run survives navigation. A texture
    // takes long enough that leaving the page is a normal thing to do, and a run
    // that only existed inside this component's state would be abandoned
    // silently the moment it unmounted.
    registerJob({
      id: promptId,
      page: 'buildings',
      kind: 'building-texture',
      label: `${guide.label} texture`,
    })

    try {
      const inputs = {}
      for (const parameter of workflow.parameters || []) {
        inputs[parameter.id] = values[parameter.id] ?? parameter.defaultValue ?? ''
      }
      // The prompt is the one field this panel owns, because it appends the
      // tileable/flat-lit steer the whole thing depends on - see the header.
      inputs[promptParam.id] = `${prompt.trim()}, ${TILEABLE_SUFFIX}`

      const outputs = await runComfyWorkflow(null, {
        workflowId: workflow.id,
        inputs,
        clientId: createComfyExecutionId('comfy-client'),
        promptId,
        persistProcessingCard: false,
        persistGeneratedAssets: false,
      })
      const image = (Array.isArray(outputs) ? outputs : [outputs])
        .find(entry => entry?.url && String(entry.url).startsWith('data:image'))
      if (!image) throw new Error('The workflow produced no image.')

      const blob = await (await fetch(image.url)).blob()
      const name = `${guide.label} — ${prompt.trim().slice(0, 40)}`
      const form = new FormData()
      form.append('file', new File(
        [blob],
        `${name.replace(/[^\w.-]+/g, '_')}.png`,
        { type: blob.type || 'image/png' },
      ))
      form.append('type', 'image')
      form.append('name', name)
      const response = await fetch(`${API_BASE}/assets/library-upload`, {
        method: 'POST', body: form,
      })
      const saved = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(saved?.error || 'Could not save the texture.')

      // The listing routes prefix library ids; the reference table stores the
      // bare number as 'asset:<id>' - invariant 4 in doc.js, and the reason a
      // .3dgp export carries a building's textures with no walker changes.
      const assetId = Number(String(saved.id).replace('library:', ''))
      setResult({ assetId, name, preview: image.url })
      completeJob(promptId, { status: 'completed' })
      onGenerated(refKey, { assetId, name, tile: Number(tile) || guide.tile })
    } catch (err) {
      completeJob(promptId, { status: 'error' })
      setError(err?.message || 'The texture could not be generated.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="bai-overlay" role="presentation" onClick={onClose}>
      <div
        className="bai"
        role="dialog"
        aria-modal="true"
        aria-label={`Generate a ${guide.label} texture`}
        onClick={event => event.stopPropagation()}
      >
        <div className="bai__header">
          <h3 className="font-headline">Generate a {guide.label.toLowerCase()} texture</h3>
          <button type="button" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="bai__body">
          <p className="bai__teach">
            The prompt is steered onto a <strong>seamless, flat-lit, orthographic</strong>{' '}
            material sample. Walls are UV-mapped in metres, so the image repeats across
            the elevation — a texture with its own lighting or a visible border shows a
            seam at every repeat, and that cannot be fixed afterwards.
          </p>

          <label className="bai__field">
            <span>Workflow</span>
            <select value={workflowId} onChange={event => selectWorkflow(event.target.value)}>
              {workflows.length === 0 && (
                <option value="">
                  {considered === null ? 'Reading the workflow library…'
                    : considered === 0 ? 'No ComfyUI workflows in the library'
                      : `None of ${considered} workflows is text-to-image`}
                </option>
              )}
              {workflows.map(entry => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          </label>

          {workflows.length === 0 && considered > 0 && (
            <p className="bai__note">
              This needs a workflow that takes a text prompt and returns an image, and
              needs no image of its own — the “Gen Image with …” ones. Inpainting,
              Remove Background and the projection workflows all require an input image.
            </p>
          )}

          {workflow && (
            <>
              <div className="bai__presets">
                {guide.prompts.map(([label, text]) => (
                  <button key={label} type="button" onClick={() => setPrompt(text)}>
                    {label}
                  </button>
                ))}
              </div>

              <label className="bai__field">
                <span>Tile size</span>
                <input
                  type="number"
                  min="0.1"
                  max="50"
                  step="0.1"
                  value={tile}
                  onChange={event => setTile(event.target.value)}
                />
                <small>
                  Metres covered by one repeat. {guide.hint}
                </small>
              </label>

              <div className="bai__params">
                {(workflow.parameters || [])
                  // Defensive: the filter above already rejects anything needing
                  // an image, and this field would render one as a text box.
                  .filter(parameter => !['image', 'mesh'].includes(typeOf(parameter)))
                  .map(parameter => (
                    <WorkflowParameterField
                      key={parameter.id}
                      parameter={parameter}
                      value={parameter.id === promptParam?.id
                        ? prompt
                        : values[parameter.id] ?? parameter.defaultValue ?? ''}
                      onChange={(id, next) => (id === promptParam?.id
                        ? setPrompt(next)
                        : setValues(prev => ({ ...prev, [id]: next })))}
                    />
                  ))}
              </div>
            </>
          )}

          <p className="bai__note">
            Saved to the image library and bound to the <strong>{guide.label}</strong>{' '}
            slot, so other buildings can use it too.
          </p>

          {error && <div className="bai__message is-error">{error}</div>}
          {result && (
            <div className="bai__message is-success">
              <img src={result.preview} alt="" />
              <span>Bound “{result.name}” to {guide.label}.</span>
            </div>
          )}
        </div>

        <div className="bai__actions">
          <button type="button" onClick={onClose}>Close</button>
          <button
            type="button"
            className="is-primary"
            onClick={generate}
            disabled={running || !workflow}
          >
            {running ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  )
}
