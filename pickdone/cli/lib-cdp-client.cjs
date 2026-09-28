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
      let s = ''; r.on('data', d => { s += d })
      r.on('end', () => {
        // A stale service on the port can return HTML/empty bodies; JSON.parse inside the
        // 'end' handler used to escape the Promise domain as an uncaughtException. Route it
        // through rej so callers' catch/timeout paths fire instead of crashing the script.
        try { res(JSON.parse(s)) } catch (err) { rej(new Error(`non-JSON response from :${port}${p}: ${err.message} body=${s.slice(0, 80)}`)) }
      })
      r.on('error', rej)
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
 *  scripts, 300 in the third — unified parameter, default 200);
 *  opts.timeoutMs: per-call cap on send/evalJS so a silent-but-alive socket cannot hang the
 *  script forever (optional; unset = wait for response or socket death). */
function cdpConnect (wsUrl, { exceptions = null, truncLen = 200, timeoutMs = 0 } = {}) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map() // id -> { res, rej, timer }
  const failAll = why => {
    for (const p of pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.rej(new Error(`CDP ${why}`))
    }
    pending.clear()
  }
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id
    const entry = { res, rej, timer: null }
    if (timeoutMs > 0) entry.timer = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method} timed out after ${timeoutMs}ms`)) }, timeoutMs)
    pending.set(i, entry)
    // CLOSING/CLOSED sockets may buffer silently in some impls (undici) instead of throwing —
    // reject up front so a dead socket can never leave a caller hanging.
    if (ws.readyState !== 1 /* OPEN */) {
      pending.delete(i); if (entry.timer) clearTimeout(entry.timer)
      rej(new Error(`CDP socket not open (readyState=${ws.readyState}): ${method}`)); return
    }
    // A closed/closing socket can also throw synchronously ("Sent before connected"); route it
    // through rej instead of letting it escape the Promise domain.
    try { ws.send(JSON.stringify({ id: i, method, params })) } catch (err) { pending.delete(i); if (entry.timer) clearTimeout(entry.timer); rej(err) }
  })
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      if (p.timer) clearTimeout(p.timer)
      p.res(m.result); return
    }
    if (m.method === 'Runtime.exceptionThrown' && exceptions) {
      exceptions.push(((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '')).slice(0, truncLen))
    }
  }
  // Socket death used to leave every pending Promise unsettled forever — bare
  // `await evalJS(...)` in ui-smoke/e2e-walkthrough hung the whole script and the
  // process.on('exit') zombie cleanup never ran. Reject them all so callers fail fast.
  ws.onclose = () => failAll('socket closed with pending calls')
  ws.onerror = () => failAll('socket error')
  const evalJS = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, truncLen))
    return r.result.value
  }
  const open = new Promise((r, j) => {
    let ot = null
    if (timeoutMs > 0) ot = setTimeout(() => j(new Error(`CDP connect timed out after ${timeoutMs}ms: ${wsUrl}`)), timeoutMs)
    ws.onopen = () => { if (ot) clearTimeout(ot); r() }
    // surface connection-refused/bad-url on `open` instead of an unsettled Promise
    ws.addEventListener('error', () => { if (ot) clearTimeout(ot); j(new Error(`CDP connect failed: ${wsUrl}`)) })
  })
  return { ws, open, send, evalJS }
}

module.exports = { sleep, getJSON, adoptSpawnedChild, killSpawnedChild, cdpConnect }
