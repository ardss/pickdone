/**
 * worker_threads entry for CSV import parsing (off the main-process event loop).
 *
 * cli/import.js rowsToItems is a pure text->items transform but on six-figure-row
 * exports it blocks for seconds; running it here keeps all window IPC and reminder
 * scheduling responsive in the main process. The engine is required independently
 * inside this thread (its own dayjs/core instances — no shared mutable state).
 *
 * Protocol (one request per worker):
 *   workerData: { text, format? }        'auto' or a concrete format
 *   postMessage: { ok:true, format, items } | { ok:false, error }
 */
const { parentPort, workerData } = require('worker_threads')

try {
    // D3 (2026-09-24): require the engine from its in-tree home (src/main/import) — the old
  // '../../cli/import.js' was a main→cli reverse dependency (cli/import.js itself is now a
  // re-export shim of this same module, so both paths stay behaviorally identical).
  const importer = require('./import')
  const { text, format } = workerData || {}
  const fmt = format && format !== 'auto' ? format : importer.detectFormat(text)
  const items = importer.rowsToItems(text, fmt)
  parentPort.postMessage({ ok: true, format: fmt, items })
} catch (err) {
  parentPort.postMessage({ ok: false, error: (err && err.message) || String(err), code: err && err.code })
}
