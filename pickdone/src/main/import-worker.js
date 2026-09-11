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
  const importer = require('../../cli/import.js')
  const { text, format } = workerData || {}
  const fmt = format && format !== 'auto' ? format : importer.detectFormat(text)
  const items = importer.rowsToItems(text, fmt)
  parentPort.postMessage({ ok: true, format: fmt, items })
} catch (err) {
  parentPort.postMessage({ ok: false, error: (err && err.message) || String(err) })
}
