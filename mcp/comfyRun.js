// One ComfyUI run: submit it to the backend and wait for its terminal event.
//
// Shared by run_workflow (tools/workflows.js) and the batch runner
// (tools/batch.js), which queue the same saved workflows through the same
// endpoint and differ only in what they do with the assets afterwards.
//
// THE STREAM IS SUBSCRIBED BEFORE THE RUN IS SUBMITTED. /comfyui/workflows/run
// answers as soon as the prompt is queued and delivers the outputs on the
// progress stream instead; that endpoint replays its latest snapshot on
// connect, but a run that finished in the gap between submitting and
// subscribing would publish its terminal event to nobody and the caller would
// wait out its whole timeout for a result that already existed.
import fs from 'node:fs/promises';
import path from 'node:path';

// Queue a saved workflow and wait for it to finish.
//
// inputs: parameter id -> value, already normalized (a bare scalar, or an
//   `asset:<id>` / `edit:<path>` reference for a file parameter).
// fileInputs: parameter id -> absolute local path, uploaded with the request.
// onQueued(): the prompt reached ComfyUI's queue.
// onProgress(payload): every non-terminal progress frame, verbatim.
//
// Resolves { status: 'completed', promptId, assets } or, when timeoutSeconds
// elapses first, { status: 'running', promptId } — the run itself continues in
// the background either way. Throws when the run reports an error.
export async function executeComfyRun(api, {
  projectId,
  workflowId,
  promptId,
  cardId,
  name,
  parentAssetId,
  autoParentFromInputs,
  inputs = {},
  fileInputs,
  persistProcessingCard,
  persistGeneratedAssets,
  timeoutSeconds = 600,
  onQueued,
  onProgress
} = {}) {
  let resolveTerminal;
  const terminalPromise = new Promise(resolve => { resolveTerminal = resolve; });
  const subscription = api.subscribeSse(`/comfyui/workflows/progress/${promptId}`, payload => {
    if (String(payload?.promptId || '') !== promptId) return;
    if (payload?.status === 'error' || payload?.done) {
      resolveTerminal(payload);
      return;
    }
    onProgress?.(payload);
  }, {
    onEnd: err => resolveTerminal({ status: 'error', detail: `Progress stream ended unexpectedly: ${err?.message || err}` })
  });

  let timer = null;
  try {
    const form = new FormData();
    if (projectId !== undefined && projectId !== null) form.append('projectId', String(projectId));
    form.append('workflowId', String(workflowId));
    form.append('promptId', promptId);
    if (cardId !== undefined && cardId !== null) form.append('cardId', String(cardId));
    if (name) form.append('name', name);
    if (parentAssetId !== undefined && parentAssetId !== null) {
      form.append('parentAssetId', String(parentAssetId));
    }
    // FORWARDED ONLY WHEN THE CALLER SET IT. The backend defaults it to on, and
    // "leave the default alone" is not the same request as "turn it off": a
    // caller that picks its own parent (the batch does, by output type) has to
    // say so, or a parent the server rejects on a type mismatch silently falls
    // back to the first file input instead of producing a root asset.
    if (autoParentFromInputs !== undefined) {
      form.append('autoParentFromInputs', autoParentFromInputs ? 'true' : 'false');
    }
    if (persistProcessingCard === false) form.append('persistProcessingCard', 'false');
    if (persistGeneratedAssets === false) form.append('persistGeneratedAssets', 'false');

    const inputValues = { ...inputs };
    for (const [key, localPath] of Object.entries(fileInputs || {})) {
      const fieldName = `comfyFile:${key}`;
      const buffer = await fs.readFile(localPath);
      form.append(fieldName, new Blob([buffer]), path.basename(localPath));
      inputValues[key] = { __fileField: fieldName };
    }
    form.append('inputValues', JSON.stringify(inputValues));

    await api.apiForm('POST', '/comfyui/workflows/run', form);
    await onQueued?.();

    const outcome = await Promise.race([
      terminalPromise,
      new Promise(resolve => { timer = setTimeout(() => resolve({ __timeout: true }), timeoutSeconds * 1000); })
    ]);

    if (outcome.__timeout) return { status: 'running', promptId };
    if (outcome.status === 'error') {
      throw new Error(outcome.detail || outcome.error || 'ComfyUI workflow failed');
    }

    const result = outcome.result;
    return {
      status: 'completed',
      promptId,
      assets: Array.isArray(result) ? result : (result ? [result] : [])
    };
  } finally {
    if (timer) clearTimeout(timer);
    subscription.close();
  }
}
