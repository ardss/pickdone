/* Shared CDP mini-client for the CLI-side browser scripts (ui-smoke.js, e2e-walkthrough.js, a11y-scan.js).
 * Extracted 2026-09-28: the three scripts used to carry three near-identical hand copies of
 * getJSON / ws+send / evalJS / killSpawnedChild / sleep, which had already drifted (exception
 * truncation length, exception-description fallbacks) — a ws-hang fix had to be applied three times.
 * Single require source now; per-script differences are parameters, not copies.
 * Only Node built-ins: usable from plain `node` (the scripts run outside Electron). */
const http = require('http')
const { spawn } = require('child_process')

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** GET http://127.0.0.1:<port><p> and JSON-parse the body (the CDP HTTP surface). */
function getJSON (port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p, timeout: 2000 }, r => {
      let s = ''; r.on('data', d => { s += d }); r.on('end', () => res(JSON.parse(s)))
    }).on('error', rej)
  })
}

/* ---- spawned-electron zombie guard (ui-smoke / e2e) ----
 * A detached spawn with no owner outlives the gate and pollutes the CDP port for every later
 * probe — the shared registry lets all scripts reap on exit via one implementation. */
let spawnedChild = null
function adoptSpawnedChild (child) {
  spawnedChild = child
  process.on('exit', killSpawnedChild)
}
function killSpawnedChild () {
  if (!spawnedChild || spawnedChild.exitCode !== null) return
  try { spawn('taskkill', ['/pid', String(spawnedChild.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best effort */ }
}

/** Connect the CDP WebSocket and return a small client.
 *  opts.exceptions: pass an array to collect Runtime.exceptionThrown descriptions (scripts that
 *  assert "0 exceptions"); opts.truncLen caps stored/raised description length (was 200 in two
 *  scripts, 300 in the third — unified parameter, default 200). */
function cdpConnect (wsUrl, { exceptions = null, truncLen = 200 } = {}) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown' && exceptions) {
      exceptions.push(((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '')).slice(0, truncLen))
    }
  }
  const evalJS = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, truncLen))
    return r.result.value
  }
  const open = new Promise((r) => { ws.onopen = () => r() })
  return { ws, open, send, evalJS }
}

module.exports = { sleep, getJSON, adoptSpawnedChild, killSpawnedChild, cdpConnect }
