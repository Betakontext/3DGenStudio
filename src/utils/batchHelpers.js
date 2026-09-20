// Batch Processing document model — the Batch page's door onto it.
//
// The model itself lives in batch/document.js at the repo root, beside vfx/ and
// building/, because the MCP batch tools run inside the backend where src/ does
// not ship and must resolve a stage's inputs exactly as this page does. Nothing
// here changes for a caller: every helper is re-exported under its own name.
export * from '../../batch/document.js'
