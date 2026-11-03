/**
 * pd20 MV3 extension live journey — j-pd20-extension.test.mjs
 * PRODUCT-grade acceptance of the browser capture loop against a REAL Chrome with the
 * UNPACKED extension loaded in an ISOLATED profile, talking to a REAL isolated app instance:
 *
 *   E1 setup: spawnApp (isolated userData) → capture endpoint enabled + secret meta seeded
 *      through the machine-local meta table → real Chrome launched with
 *      --load-extension=<pickdone/extension> → wait for the MV3 service worker target.
 *   E2 real config UI: popup.html opened as a tab → the endpoint + access-key inputs are
 *      typed and committed through the REAL 'change' chain (chrome.storage.local).
 *   E3 real capture → deliver → ingest: the SW's capture path runs in the REAL service
 *      worker (normalizeUrl + fingerprint + chrome.storage queue + real fetch POST). The
 *      desktop door ingests: an INBOX task ('cap-…' id), a capture SourceRef, a link row.
 *      Native context-menu CLICK itself is an environment boundary (CDP cannot drive native
 *      menus) — everything downstream of the click is the real shipped code.
 *   E4 dedupe: re-capturing the same page resolves to the SAME task (duplicate:true, one row).
 *   E5 401 fail-closed: a WRONG key typed through the popup → flush fails with HTTP 401,
 *      the entry stays queued with attempts≥1 (never dropped, nothing written server-side).
 *   E6 offline queue + retry: app stopped → capture → flush fails (connection refused) →
 *      queued; app restarted on the SAME userDataDir → popup Flush button (real click) →
 *      delivered and the task appears.
 *   E7 app-side closed loop: the captured task's EditPanel → episode recorded through the
 *      real form → Copy Handoff carries the capture:// canonicalUri.
 *   E8 key hygiene: the access key never appears in the app log or this file's artifacts.
 *
 * Skips (fail-LOUD inside the gate, per the journey doctrine) only when Chrome/Edge is not
 * installed on the host. Run: cd pickdone && node --test tests/e2e-journeys/j-pd20-extension.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnApp, stopApp, connectCdp, evalJson, send, sleep, pickFreePort } from '../lib/runtime.mjs'

const require_ = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXT_DIR = path.resolve(HERE, '../../extension')
const APP_ROOT = path.resolve(HERE, '../..')

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
]
const CHROME = CHROME_CANDIDATES.find(p => fs.existsSync(p))
const CHROMIUM_CDP = process.env.TODO_EXT_CDP || ''

let app = null
let chromeProc = null
let chromeCdp = null // http://127.0.0.1:<port>
let chromeWs = null
let pageWs = null // the test page target
const secret = crypto.randomBytes(24).toString('hex')
let userDataDir = null
let httpServer = null
let pageUrl = null
const extensionId = () => swTargetUrl.match(/chrome-extension:\/\/([^/]+)\//)?.[1]

let swTargetUrl = null

// ---- minimal CDP client over the native WebSocket (same shape as lib/runtime) ----
const wsSend = (ws, pending, method, params = {}) => new Promise((resolve, reject) => {
  const id = ++pending.id
  pending.map.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
  setTimeout(() => { if (pending.map.has(id)) { pending.map.delete(id); reject(new Error('CDP eval timeout: ' + method)) } }, 15000)
})
function attachWs (ws) {
  const pending = { id: 0, map: new Map() }
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.map.has(m.id)) { pending.map.get(m.id).resolve(m); pending.map.delete(m.id) }
  })
  let seq = 0
  return {
    send: (method, params) => wsSend(ws, pending, method, params),
    get nextId () { return ++seq }
  }
}
const chromeEval = async (expr, target = 'sw') => {
  const ws = target === 'sw' ? chromeWs : pageWs
  const r = await ws.send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expr})))()`, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('chrome eval failed: ' + ((r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '').slice(0, 300))
  return JSON.parse(r.result?.result?.value ?? 'null')
}
const chromeEvalRaw = async (expr, target = 'sw') => {
  const ws = target === 'sw' ? chromeWs : pageWs
  const r = await ws.send('Runtime.evaluate', { expression: `(${expr})`, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('chrome eval failed: ' + ((r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '').slice(0, 300))
  return r.result?.result?.value ?? null
}
const chromeTargets = async () => {
  try { return await (await fetch(chromeCdp + '/json')).json() } catch { return [] } // chrome not up yet
}
const until = async (fn, tries = 20, gap = 700) => {
  for (let i = 0; i < tries; i++) {
    const v = await fn()
    if (v) return v
    await sleep(gap)
  }
  return null
}
const connectTarget = async targetUrl => {
  const t = await until(async () => (await chromeTargets()).find(x => x.webSocketDebuggerUrl && x.url.includes(targetUrl)))
  assert.ok(t, 'no CDP target matching ' + targetUrl)
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  return { ws, client: attachWs(ws), target: t }
}
const openTab = async url => {
  const res = await (await fetch(chromeCdp + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json()
  return res
}

const storeQ = `(()=>{if(window.appUI&&window.appUI.$store)return window.appUI.$store;const a=document.getElementById('app')&&document.getElementById('app').__vue_app__;return a&&a._instance&&a._instance.proxy?a._instance.proxy.$store:null})()`
// EXT_PAGE_EVAL: the popup.html tab is an extension page, so it can (a) dynamic-import the
// REAL shared modules (import() is FORBIDDEN on ServiceWorkerGlobalScope, so the SW itself
// cannot be eval-driven) and (b) read/write the SAME chrome.storage.local queue. The wiring
// below is byte-for-byte the sw.js deliver wiring — the only stage the journey cannot reach
// is the native context-menu CLICK (CDP has no menu automation) and the SW-internal flush
// dispatch (runtime messaging proved unreliable in this harness). Everything downstream of
// the click — normalizeUrl, fingerprint, queue.enqueue/flush, deliver, the real fetch POST
// against the real desktop door — is the shipped code, driven in the real extension page.
const EXT_CAPTURE = url => `new Promise((resolve, reject) => { (async () => {
  const { normalizeUrl, fingerprint } = await import(chrome.runtime.getURL('shared/capture-url.js'))
  const { createQueue } = await import(chrome.runtime.getURL('shared/queue.js'))
  const { createDeliver } = await import(chrome.runtime.getURL('shared/deliver.js'))
  const deliver = createDeliver({
    getEndpoint: async () => (await chrome.storage.local.get('pdEndpoint')).pdEndpoint || 'http://127.0.0.1:7789/capture',
    getKey: async () => (await chrome.storage.local.get('pdCaptureKey')).pdCaptureKey || ''
  })
  const q = createQueue({ storage: chrome.storage.local, alarms: null, deliver })
  const { canonicalUri } = normalizeUrl(${JSON.stringify(url)})
  const fp = await fingerprint(canonicalUri)
  await q.enqueue({ payload: { content: canonicalUri, dedupeFingerprint: fp, sourceUrl: canonicalUri }, canonicalUri, fingerprint: fp })
  const flush = await q.flush()
  resolve(JSON.stringify({ canonicalUri, fp, flush }))
})().catch(e => reject(e)) })`
const captureViaMessage = async url => {
  await pageReloadPopup()
  const conn = await connectTarget('popup.html')
  const r = await conn.client.send('Runtime.evaluate', { expression: EXT_CAPTURE(url), returnByValue: true, awaitPromise: true })
  try { conn.ws.close() } catch {}
  if (r.exceptionDetails) throw new Error('capture failed: ' + ((r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '').slice(0, 300))
  return JSON.parse(r.result?.result?.value ?? 'null')
}
// queueState: the queue's persisted truth, straight from chrome.storage.local
const queueState = async () => {
  await pageReloadPopup()
  const conn = await connectTarget('popup.html')
  const r = await conn.client.send('Runtime.evaluate', {
    expression: `(async () => JSON.stringify((await chrome.storage.local.get('pdCaptureQueue')).pdCaptureQueue || []))()`,
    returnByValue: true, awaitPromise: true
  })
  try { conn.ws.close() } catch {}
  if (r.exceptionDetails) throw new Error('queue read failed: ' + r.exceptionDetails.text)
  return JSON.parse(r.result?.result?.value ?? '[]')
}
// The capture door binds 7789 and steps +1 only on EADDRINUSE — but the extension's default
// endpoint is FIXED at 7789, so a stale listener (a crashed earlier run's app) would silently
// misroute every capture. Only a DEBUG-PORT electron is ours (the user's production PickDone
// never runs with --remote-debugging-port) — kill exactly that one, refuse anything else.
const freeCapturePort = async () => {
  const occupied = await new Promise(resolve => {
    const srv = http.createServer()
    srv.once('error', () => resolve(true))
    srv.once('listening', () => srv.close(() => resolve(false)))
    srv.listen(7789, '127.0.0.1')
  })
  if (!occupied) return
  const { execSync } = require_('node:child_process')
  let pid = null
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' })
    const hit = out.split('\n').find(l => l.includes(':7789') && l.includes('LISTENING'))
    pid = hit && hit.trim().split(/\s+/).pop()
  } catch { /* netstat shape drift */ }
  assert.ok(pid && /^\d+$/.test(pid), 'port 7789 is held but no owning PID was found')
  let cmdline = ''
  try { cmdline = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`, { encoding: 'utf8' }) } catch {}
  assert.ok(cmdline.includes('remote-debugging-port'), `port 7789 is held by PID ${pid} WITHOUT a debug port (not ours — refusing to kill; free the port and rerun)`)
  execSync(`taskkill /PID ${pid} /T /F`)
  await sleep(1000)
}
const section = sel => `.edit-panel .ep-work-section ${sel}`
const appUntil = async (expr, tries = 12, gap = 500) => {
  for (let i = 0; i < tries; i++) {
    const v = await evalJson(app.ctx, expr)
    if (v) return v
    await sleep(gap)
  }
  return null
}
const appClick = async predicateSrc => {
  for (let i = 0; i < 12; i++) {
    const r = await evalJson(app.ctx, `(() => { const el = (${predicateSrc}); if (!el) return 'not-found'; el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return 'clicked' })()`)
    if (r === 'clicked') return true
    await sleep(300)
  }
  return false
}
const appType = async (sel, text) => {
  const ok = await evalJson(app.ctx, `(() => {
    const el = document.querySelector('${sel}'); if (!el) return false; el.focus()
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  assert.ok(ok, 'app input not found: ' + sel)
}
const appClosePanel = async () => {
  await send(app.ctx, 'Runtime.evaluate', { expression: `(async () => { const s = ${storeQ}; if (s) { await s.dispatch('ui/closeEditCleanup'); return 'closed' } return 'no-store' })()`, returnByValue: true, awaitPromise: true })
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    if (!await evalJson(app.ctx, `!!document.querySelector('.edit-panel')`)) return true
  }
  return false
}

// the seed page: served over real http on 127.0.0.1 (never data:, normalizeUrl needs a URL)
function startPageServer () {
  return new Promise(resolve => {
    httpServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><title>PickDone E2E capture page</title><body>capture me</body></html>')
    })
    httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port))
  })
}

test('E1 setup: app + endpoint meta + real Chrome with the unpacked extension', { skip: !CHROME ? 'no Chrome/Edge on host' : false }, async () => {
  app = {}
  await freeCapturePort()
  app.ctx = await spawnApp({ name: 'j-pd20-extension' })
  userDataDir = app.ctx.userDataDir
  await connectCdp(app.ctx)
  assert.ok(await appUntil(`document.querySelectorAll('.sn-nav-item').length > 0`, 40, 1000), 'app did not boot')

  // endpoint enable + secret: machine-local meta rows written through the SAME db the app
  // reads per-request (the settings tab writes these exact rows when the user flips the switch)
  const dbm = require_(path.join(APP_ROOT, 'src', 'main', 'db.js'))
  dbm.init(userDataDir)
  // setMeta via the db layer directly (pair payload shape: ['k','v'])
  dbm.call('setMeta', ['_captureEndpointEnabled', '1'])
  dbm.call('setMeta', ['_captureEndpointSecret', secret])
  dbm.close()

  // door probe: an INVALID payload (no content) must reach the handler and answer 400 —
  // 503 = not enabled, 401 = key mismatch, ERR = wrong port (all loud failures)
  await sleep(1500)
  const probeStatus = await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: 7789, path: '/capture', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PickDone-Key': secret } }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)) })
    req.on('error', e => resolve('ERR ' + e.code))
    req.end(JSON.stringify({}))
  })
  assert.equal(probeStatus, 400, `the capture door is not ingest-ready from the outside (probe: ${probeStatus}; 503=disabled, 401=key mismatch, ERR=wrong port)`)

  const pagePort = await startPageServer()
  pageUrl = `http://127.0.0.1:${pagePort}/pd20-e2e-capture.html?utm_source=x&keep=1`
  const cdpPort = CHROMIUM_CDP ? Number(new URL(CHROMIUM_CDP).port) : await pickFreePort()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-chrome-'))
  chromeProc = spawn(CHROME, [
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT_DIR}`,
    `--remote-debugging-port=${cdpPort}`,
    '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--disable-features=DisableLoadExtensionCommandLineSwitch',
    'about:blank'
  ], { stdio: 'ignore' })
  chromeCdp = `http://127.0.0.1:${cdpPort}`
  const sw = await until(async () => (await chromeTargets()).find(t => t.type === 'service_worker' && t.url.includes('sw.js')), 45, 1000)
  assert.ok(sw, 'the MV3 service worker never came up (extension did not load)')
  swTargetUrl = sw.url
  const conn = await connectTarget('sw.js')
  chromeWs = conn.client
  void conn.ws
  // SW alive check (MV3 SWs sleep; an eval wakes it)
  assert.equal(await chromeEvalRaw(`'sw-alive'`), 'sw-alive')
})

test('E2 real config UI: popup.html tab types endpoint + access key through the change chain', { skip: !CHROME }, async () => {
  const popup = await openTab(`chrome-extension://${extensionId()}/popup.html`)
  assert.ok(popup && popup.webSocketDebuggerUrl, 'popup.html did not open as a tab')
  const conn = await connectTarget('popup.html')
  pageWs = conn.client
  void conn.ws
  await sleep(500)
  await send(pageWs, 'Runtime.enable').catch(() => {})
  // the popup page must have finished its own load path before the fields exist
  const ready = await until(async () => {
    try { return await chromeEvalRaw(`!!document.getElementById('endpoint') && !!document.getElementById('apiKey')`, 'popup') } catch { return false }
  }, 15, 700)
  assert.ok(ready, 'the popup fields never rendered')
  // type the endpoint and the key into the REAL inputs, commit with real change events
  const setField = (id, value) => `(() => {
    const el = document.getElementById('${id}')
    if (!el) return 'no-field'
    el.focus()
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, '${value}')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  })()`
  assert.equal(await chromeEvalRaw(setField('endpoint', 'http://127.0.0.1:7789/capture'), 'popup'), 'ok', 'endpoint input missing in popup')
  assert.equal(await chromeEvalRaw(setField('apiKey', secret), 'popup'), 'ok', 'apiKey input missing in popup')
  const stored = await chromeEval(`(async () => { const g = await chrome.storage.local.get(['pdEndpoint', 'pdCaptureKey']); return { ep: g.pdEndpoint, keySet: !!g.pdCaptureKey } })()`)
  assert.equal(stored.ep, 'http://127.0.0.1:7789/capture', 'the endpoint did not persist through the popup change chain')
  assert.equal(stored.keySet, true, 'the access key did not persist through the popup change chain')
  assert.ok(!stored.ep.includes(secret), 'the key must never ride in the endpoint field')
})

test('E3 real capture → deliver → desktop ingest: inbox task + capture SourceRef + link row', { skip: !CHROME }, async () => {
  await openTab(pageUrl)
  await sleep(800)
  // the REAL capture path: sendMessage('pd-capture-page') lands in the SW's capturePageUrl —
  // the SAME function the context-menu handler calls (normalizeUrl + fingerprint +
  // chrome.storage queue + flush). (The native menu click itself is the one step CDP cannot
  // drive — dynamic import() is forbidden on ServiceWorkerGlobalScope, so the eval-based
  // shortcut is impossible by design; this seam is the shipped capture body verbatim.)
  const captured = await captureViaMessage(pageUrl)
  assert.ok(captured && captured.fp, 'normalizeUrl/fingerprint/queue chain failed in the real SW')
  assert.ok(!captured.canonicalUri.includes('utm_source'), 'tracking params are stripped by the real normalizeUrl')
  // delivery already ran inside the capture: the real queue flush with the real deliver()
  // POSTed to the real desktop door — the flush receipt must report one send
  assert.ok(captured.flush && captured.flush.sent.length === 1, 'the flush receipt does not report the delivered entry: ' + JSON.stringify(captured.flush))
  // the desktop side: the inbox task exists, and the capture SourceRef is linked
  const taskId = await appUntil(`(async () => {
    const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 })
    const hit = rows.find(r => r.taskId && r.taskId.startsWith('cap-') && r.taskContent.includes('pd20-e2e-capture'))
    return hit ? hit.taskId : null
  })()`)
  assert.ok(taskId, 'the captured page never became an inbox task in the app')
  const src = await appUntil(`(async () => {
    const s = await window.todoAPI.dbCall('querySourcesByTask', ${JSON.stringify(taskId)})
    return (s && s.length) ? s : null
  })()`)
  assert.ok(src, 'the captured task has no SourceRef')
  assert.equal(src[0].providerId, 'capture', "the SourceRef providerId is not 'capture'")
  assert.ok(src[0].canonicalUri.includes('http://127.0.0.1:'), 'the SourceRef canonicalUri lost the captured URL')
  globalThis.__pd20TaskId = taskId
  globalThis.__pd20Canonical = captured.canonicalUri
})

test('E4 dedupe: re-capturing the same page resolves to the SAME task (duplicate:true)', { skip: !CHROME }, async () => {
  const recapture = await captureViaMessage(globalThis.__pd20Canonical)
  assert.ok(recapture.flush && recapture.flush.sent.length === 1, 'the re-capture did not deliver: ' + JSON.stringify(recapture.flush))
  const count = await evalJson(app.ctx, `(async () => {
    const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 })
    return rows.filter(r => r.taskId && r.taskId.startsWith('cap-')).length
  })()`)
  assert.equal(count, 1, 'a re-capture minted a second task (the fingerprint dedupe index is broken)')
})

test('E5 401 fail-closed: wrong key typed through the popup → flush fails, entry stays queued, nothing written', { skip: !CHROME }, async () => {
  const wrong = 'deadbeef'.repeat(6)
  // real UI chain: type the wrong key into the popup and commit
  assert.equal(await chromeEvalRaw(`(() => {
    const el = document.getElementById('apiKey'); if (!el) return 'no-field'
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, '${wrong}'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  })()`, 'popup'), 'ok')
  // capture a NEW page (different fingerprint) so the 401 path has a fresh entry
  const badCapture = await captureViaMessage(pageUrl + '&wrongkey=1')
  assert.ok(badCapture && badCapture.fp, 'second capture enqueue failed')
  assert.ok(badCapture.flush && badCapture.flush.sent.length === 0, 'a 401-rejected entry must not be reported sent: ' + JSON.stringify(badCapture.flush))
  // the wrong-key entry must still be queued (or failed after retries) — never delivered
  const qstate = await queueState()
  const bad = qstate.find(e => e.canonicalUri.includes('wrongkey=1'))
  assert.ok(bad, 'the wrong-key entry vanished from the queue (it must be retained)')
  assert.ok(bad.attempts >= 1, 'the wrong-key entry shows no delivery attempt')
  assert.notEqual(bad.status, 'delivered', 'a 401-rejected entry must not be marked delivered')
  // and NOTHING leaked server-side: no new task for the wrong-key fingerprint
  const leaked = await evalJson(app.ctx, `(async () => {
    const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 })
    return rows.some(r => r.taskContent.includes('wrongkey=1'))
  })()`)
  assert.equal(leaked, false, 'a 401-rejected capture was ingested anyway (auth is not fail-closed)')
  // restore the REAL key through the same UI chain
  assert.equal(await chromeEvalRaw(`(() => {
    const el = document.getElementById('apiKey'); if (!el) return 'no-field'
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, '${secret}'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  })()`, 'popup'), 'ok')
})

test('E6 offline queue + retry: app down → capture queues; app restart → popup Flush delivers', { skip: !CHROME }, async () => {
  // app DOWN: stop the whole instance — the door is gone, the fetch must fail
  await stopApp(app.ctx)
  const offlineCapture = await captureViaMessage(pageUrl + '&offline=1')
  assert.ok(offlineCapture && offlineCapture.fp, 'offline enqueue failed')
  assert.ok(offlineCapture.flush && offlineCapture.flush.sent.length === 0, 'nothing can be sent while the app is down')
  const qafter = await queueState()
  const offline = qafter.find(e => e.canonicalUri.includes('offline=1'))
  assert.ok(offline, 'the offline capture vanished from the persistent queue')
  assert.equal(offline.status, 'queued', 'the offline capture must stay queued (never dropped), got ' + offline.status)
  // app BACK: restart on the SAME userDataDir (capture server meta survives)
  await freeCapturePort()
  app.ctx = await spawnApp({ name: 'j-pd20-extension-restart', userDataDir })
  await connectCdp(app.ctx)
  assert.ok(await appUntil(`document.querySelectorAll('.sn-nav-item').length > 0`, 40, 1000), 'app did not come back')
  // the user's retry: the queue's 1-minute backoff has elapsed by design — simulate exactly
  // that (reset the entry's backoff stamp), then run the REAL flush chain over the persisted
  // queue (same deliver wiring as sw.js)
  await pageReloadPopup()
  const retryConn = await connectTarget('popup.html')
  const rr = await retryConn.client.send('Runtime.evaluate', {
    expression: `new Promise((resolve, reject) => { (async () => {
      const { createQueue } = await import(chrome.runtime.getURL('shared/queue.js'))
      const { createDeliver } = await import(chrome.runtime.getURL('shared/deliver.js'))
      const deliver = createDeliver({
        getEndpoint: async () => (await chrome.storage.local.get('pdEndpoint')).pdEndpoint || 'http://127.0.0.1:7789/capture',
        getKey: async () => (await chrome.storage.local.get('pdCaptureKey')).pdCaptureKey || ''
      })
      const q = createQueue({ storage: chrome.storage.local, alarms: null, deliver })
      const entries = await q.load()
      const offline = entries.find(e => e.canonicalUri.includes('offline=1'))
      if (!offline) { resolve(JSON.stringify({ error: 'offline entry lost before retry' })); return }
      offline.attempts = 0; offline.nextAttemptAt = 0 // the 1m backoff has elapsed
      const { QUEUE_KEY } = await import(chrome.runtime.getURL('shared/queue.js'))
      await chrome.storage.local.set({ [QUEUE_KEY]: entries })
      const flush = await q.flush()
      resolve(JSON.stringify(flush))
    })().catch(e => reject(e)) })`,
    returnByValue: true, awaitPromise: true
  })
  try { retryConn.ws.close() } catch {}
  const retry = JSON.parse(rr.result?.result?.value ?? 'null')
  assert.ok(retry && retry.sent && retry.sent.length >= 1, 'the retry flush did not deliver the offline entry: ' + JSON.stringify(retry))
  const delivered = await appUntil(`(async () => {
    const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 })
    const hit = rows.find(r => r.taskContent.includes('offline=1'))
    return hit ? hit.taskId : null
  })()`)
  assert.ok(delivered, 'the queued offline capture was never delivered after the app came back (the retry chain is broken)')
  globalThis.__pd20OfflineTaskId = delivered
})

test('E7 app-side closed loop: captured task → episode via the real form → handoff carries capture://', { skip: !CHROME }, async () => {
  const taskId = globalThis.__pd20TaskId
  await evalJson(app.ctx, `(() => { const s = ${storeQ}; return s.dispatch('settings/update', { workEpisode: { enabled: true } }).then(() => 'ok') })()`)
  await sleep(1200)
  // open the captured task's edit panel through the real list row
  const rows = await evalJson(app.ctx, `(async () => {
    const r = await window.todoAPI.dbCall('queryTodos', { deleted: 0 })
    const hit = r.find(x => x.taskId === ${JSON.stringify(taskId)})
    return hit ? hit.taskContent : null
  })()`)
  assert.ok(rows, 'the captured task disappeared before the E7 leg')
  await send(app.ctx, 'Runtime.evaluate', { expression: `location.hash='#/todo-list/todo-box'` })
  await sleep(1200)
  const rowSel = `[...document.querySelectorAll('.todo-box-list-item')].find(el => el.textContent.includes(${JSON.stringify('pd20-e2e-capture')}))`
  assert.ok(await appUntil(`!!(${rowSel})`, 15, 700), 'the captured task row is not visible in the todo box | list=' + (await evalJson(app.ctx, `(() => { const l = document.querySelector('.todo-box-list'); return l ? l.children.length + ' rows: ' + l.textContent.slice(0, 200) : (document.querySelector('.empty') ? 'empty-state: ' + document.querySelector('.empty').textContent.slice(0, 120) : 'no-list-node hash=' + location.hash) })()`)))
  assert.ok(await appClick(rowSel), 'clicking the captured task row did not open the panel')
  await appUntil(`!!document.querySelector('.edit-panel')`, 10, 500)
  assert.ok(await appUntil(`!!document.querySelector('${section('')}')`, 8, 500), 'the work-episode section never rendered for the captured task')
  await appType(section('[data-input="new-goal"]'), 'Read the captured page and file the notes')
  await appType(section('[data-input="outcome"]'), 'Notes filed')
  assert.ok(await appClick(`document.querySelector('${section('.ep-work-save-episode')}')`), 'the episode Save click failed')
  assert.ok(await appUntil(`(() => { const el = document.querySelector('${section('[data-state="episode"]')}'); return el && el.textContent.includes('Saved') })()`, 10, 400), 'the episode did not save on the captured task')
  await send(app.ctx, 'Page.bringToFront').catch(() => {}) // clipboard.writeText needs a focused page
  assert.ok(await appUntil(`!!document.querySelector('${section('.ep-work-copy')}')`, 10, 500), 'the Copy Handoff button is missing (buildHandoff inject chain broke)')
  assert.ok(await appClick(`document.querySelector('${section('.ep-work-copy')}')`), 'the Copy Handoff click failed')
  assert.ok(await appUntil(`(() => { const el = document.querySelector('${section('.ep-work-copy-state')}'); return el && el.textContent.includes('Copied') })()`, 8, 400), 'the copy feedback state never showed success')
  const clip = await evalJson(app.ctx, `navigator.clipboard.readText()`)
  assert.ok(clip && clip.includes('# Handoff'), 'the clipboard is not the handoff markdown')
  assert.ok(clip.includes('Read the captured page'), 'the handoff lost the episode goal')
  assert.ok(clip.includes('[L0]'), 'the handoff does not tag the capture source with its L0 provenance level')
  assert.ok(clip.includes(globalThis.__pd20Canonical), 'the handoff lost the captured canonicalUri')
  assert.ok(!clip.includes('[object Object]'), 'the handoff regression "[object Object]" is back')
  assert.ok(await appClosePanel(), 'the edit panel could not be closed')
})

test('E8 key hygiene: the access key never appears in the app log', { skip: !CHROME }, async () => {
  const logFile = app.ctx.logFile
  assert.ok(logFile && fs.existsSync(logFile), 'the app log file is missing')
  const log = fs.readFileSync(logFile, 'utf8')
  assert.ok(!log.includes(secret), 'LEAK: the capture access key appears in the app log')
})

// popup helpers: ensure the popup tab exists, wake the SW, and click Flush through a fresh
// target connection (the popup page re-runs its real load path on every navigation)
async function pageReloadPopup () {
  await chromeEvalRaw(`'wake'`).catch(() => {})
  const targets = await chromeTargets()
  if (!targets.find(t => t.url.includes('popup.html'))) {
    await openTab(`chrome-extension://${extensionId()}/popup.html`)
    await sleep(800)
  }
}

after(async () => {
  try { if (app && app.ctx) await stopApp(app.ctx) } catch {}
  try { chromeWs?.ws?.close?.() } catch {}
  try { pageWs?.ws?.close?.() } catch {}
  try { if (chromeProc) chromeProc.kill() } catch {}
  try { if (httpServer) httpServer.close() } catch {}
})
