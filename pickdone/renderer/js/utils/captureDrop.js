/**
 * captureDrop — S6 ecosystem interop minimal loop: drag a URL out of a browser and drop it
 * on the desktop window → one inbox task + one SourceRef (level L0 provenance) through the
 * SAME manifest rows the browser extension's capture door writes (todo.put + source.put +
 * tasksource.put + capture.ingest dedupe index), with the SAME normalize/fingerprint pure
 * functions the MV3 extension ships (extension/shared/capture-url.js — no parallel DB).
 * Pure functions are Node-testable; the Vue hook only wires window events.
 */
import { normalizeUrl, fingerprint } from '../../../extension/shared/capture-url.js'
import { commit } from './commandBus.js'

const META_TASK_LINK_PREFIX = 'taskSourceLink:'
const FINGERPRINT_RE = /^[A-Za-z0-9._:\-/@+#]{1,256}$/

/** Extract http(s) URLs from a drop event's text/uri-list (first line wins). */
export function uriListFromDataTransfer (types, getData) {
  const hasList = (types || []).includes('text/uri-list')
  if (!hasList) return null
  const raw = String(getData('text/uri-list') || '')
  const line = raw.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'))
  if (!line) return null
  try {
    const u = new URL(line)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.href
  } catch { return null }
}

/** Build the exact capture payload shape the door's ingestCapture accepts. */
export async function captureUrlPayload (url) {
  // http(s)-only guard BEFORE normalization: the door rejects non-http(s) sources and so
  // must the drop path (a garbage string must fail loud, not become a junk task).
  let probe = null
  try { probe = new URL(String(url)) } catch { throw new Error('drop is not a valid URL') }
  if (probe.protocol !== 'http:' && probe.protocol !== 'https:') throw new Error('drop must be an http(s) URL')
  const norm = normalizeUrl(url)
  const canonical = typeof norm === 'string' ? norm : norm.canonicalUri
  const fp = await fingerprint(canonical)
  if (!FINGERPRINT_RE.test(fp)) throw new Error('fingerprint out of family')
  return { content: canonical, sourceUrl: canonical, dedupeFingerprint: fp }
}

/**
 * Commit one dropped URL through the SAME bus rows as the capture door. Dedupe equals the
 * door's semantics: the capture.ingest meta row is the fingerprint index; a repeat drop of
 * the same URL resolves to the existing task and writes nothing new.
 * @returns {Promise<{taskId: string, duplicate: boolean}>}
 */
export async function captureUrlThroughBus ({ commitCommand = commit, getMeta, payload } = {}) {
  const p = payload || null
  if (!p) throw new Error('payload required')
  const fp = p.dedupeFingerprint
  if (getMeta && fp) {
    const existing = getMeta(META_TASK_LINK_PREFIX + fp)
    if (existing) {
      try {
        const linked = JSON.parse(existing)
        if (linked && linked.taskId) return { taskId: linked.taskId, duplicate: true }
      } catch { /* corrupt row: fall through and re-ingest */ }
    }
  }
  // door-mirrored deterministic id: the door (capture-endpoint/handlers.js ingestCapture)
  // uses 'cap-' + sha256(idSeed=fp).slice(0,16) — the SAME grammar here, or the two paths
  // would mint different ids for the same capture (a parallel DB by another name).
  const taskId = 'cap-' + await sha256Hex(fp).then(h => h.slice(0, 16))
  commitCommand('todo', 'put', {
    taskId,
    taskContent: p.content,
    userId: null,
    categoryId: 0,
    todoTime: 0,
    dayStart: 0,
    createTime: Date.now(),
    status: 'add'
  })
  const raw = await commitCommand('source', 'put', {
    providerId: 'capture',
    externalId: p.sourceUrl,
    title: null
  })
  // sourcePut returns the minted row id, but the renderer commit facade can hand back an
  // envelope/object depending on the door — unwrap defensively and refuse "[object Object]"
  // ever becoming a foreign key (the silent link corruption this loop had exactly once).
  const sourceRefId = typeof raw === 'string' ? raw
    : (raw && typeof raw === 'object' ? (raw.id ?? raw.rowId ?? raw.sourceRefId ?? (Array.isArray(raw.results) ? raw.results[0] : undefined)) : undefined)
  if (sourceRefId == null || sourceRefId === '' || typeof sourceRefId === 'object') {
    throw new Error('source.put returned no usable row id: ' + JSON.stringify(raw ?? null).slice(0, 160))
  }
  const refId = String(sourceRefId)
  commitCommand('tasksource', 'put', { taskId, sourceRefId: refId })
  if (fp) commitCommand('capture', 'ingest', [[META_TASK_LINK_PREFIX + fp, JSON.stringify({ taskId, sourceRefId: refId })]])
  return { taskId, duplicate: false }
}

async function sha256Hex (s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Wire the window-level drop listeners (idempotent, returns an uninstaller). */
export function installCaptureDrop (target = window) {
  const onOver = e => {
    if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('text/uri-list')) {
      e.preventDefault() // allow the drop: do NOT let the browser navigate away
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  const onDrop = async e => {
    const url = uriListFromDataTransfer(e.dataTransfer && e.dataTransfer.types, k => e.dataTransfer.getData(k))
    if (!url) return
    e.preventDefault()
    try {
      // captureUrlPayload is async (Web Crypto fingerprint): await it — committing the
      // Promise itself would ship a broken row through the IPC bridge.
      const r = await captureUrlThroughBus({ payload: await captureUrlPayload(url) })
      target.dispatchEvent(new CustomEvent('pd-capture-drop', { detail: r }))
    } catch { /* user-visible failure surfaces via the capture-drop error event */
      target.dispatchEvent(new CustomEvent('pd-capture-drop-error', { detail: { url } }))
    }
  }
  target.addEventListener('dragover', onOver)
  target.addEventListener('drop', onDrop)
  return () => {
    target.removeEventListener('dragover', onOver)
    target.removeEventListener('drop', onDrop)
  }
}
