// S6 deep link + drag-drop journey (corrected-era, J3 ecosystem interop):
//   D1 deep link: the renderer hash route #/todo-list/task/:id opens the captured task's
//      edit panel through ui/openEdit (the SAME mutation a list-row click uses) — the URL
//      the VS Code extension builds must land on a VISIBLE panel, not a parallel view.
//   D2 drop: a browser URL dropped on the desktop window creates an inbox task + SourceRef
//      through the SAME bus rows as the MV3 capture door; a repeat drop dedupes.
// Real Electron app via spawnApp; the drop is delivered as an event-level synthetic
// DataTransfer drop (real OS cross-app drag cannot be scripted headlessly — recorded BLOCKED
// with this event-level evidence, per the qa-r7 context-menu precedent).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnApp, stopApp, connectCdp, evalJson, send, sleep } from '../lib/runtime.mjs'

const require_ = createRequire(import.meta.url)
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const appUntil = async (expr, tries, ms) => {
  for (let i = 0; i < tries; i++) {
    try { const v = await evalJson(app.ctx, expr); if (v) return v } catch {}
    await sleep(ms)
  }
  return null
}

let app = null
const secret = crypto.randomBytes(24).toString('hex')

async function resolveCapturePort () {
  const logFile = app.ctx.logFile
  const t = await fs.promises.readFile(logFile, 'utf8').catch(() => '')
  const m = [...String(t).matchAll(/capture endpoint listening on 127\.0\.0\.1:(\d+)/g)]
  assert.ok(m.length, 'the app log never named the capture door port')
  return Number(m[m.length - 1][1])
}

test('D1 setup: boot the app with the capture door enabled', { skip: process.env.PD_SKIP_DL ? 'skipped' : false }, async () => {
  app = {}
  app.ctx = await spawnApp({ name: 'j-pd20-deeplink-drop' })
  await connectCdp(app.ctx)
  assert.ok(await appUntil(`document.querySelectorAll('.sn-nav-item').length > 0`, 40, 1000), 'app did not boot')
  const port = await resolveCapturePort()
  const dbm = require_(APP_ROOT + '/src/main/db.js')
  dbm.init(app.ctx.userDataDir)
  dbm.call('setMeta', ['_captureEndpointEnabled', '1'])
  dbm.call('setMeta', ['_captureEndpointSecret', secret])
  dbm.close()
  await sleep(1500)
  // create the task THROUGH the real capture door (the same row shape a browser capture makes)
  const status = await new Promise(resolve => {
    const body = JSON.stringify({ content: 'pd20-deeplink-drop target task', dedupeFingerprint: 'dl' + crypto.randomBytes(6).toString('hex') })
    const req = http.request({ host: '127.0.0.1', port, path: '/capture', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PickDone-Key': secret, 'Content-Length': Buffer.byteLength(body) } }, r => {
      let buf = ''; r.on('data', c => { buf += c }); r.on('end', () => resolve({ code: r.statusCode, json: buf }))
    })
    req.on('error', e => resolve({ code: 'ERR ' + e.code }))
    req.end(body)
  })
  assert.equal(status.code, 201, 'the door did not create the D1 task: ' + JSON.stringify(status))
  globalThis.__dlTaskId = JSON.parse(status.json).taskId
  assert.ok(globalThis.__dlTaskId, 'no taskId from the door')
})

test('D2 deep link #/todo-list/task/:id opens the edit panel on the captured task', async () => {
  const taskId = globalThis.__dlTaskId
  assert.ok(taskId, 'D1 did not run')
  await send(app.ctx, 'Runtime.evaluate', { expression: `location.hash = '#/todo-list/task/${taskId}'` })
  // the panel must open and carry THIS task, then the view routes back to today
  // the panel TITLE is an input value (not textContent) — read the store snapshot through
  // the panel's inputs and the store taskId for the user-visible proof
  const opened = await appUntil(`!!document.querySelector('.edit-panel')`, 20, 700)
  assert.ok(opened, 'the deep link never opened the edit panel')
  const onTask = await appUntil(`(async () => {
    const st = window.todoAPI ? await window.todoAPI.dbCall('queryTodos', { deleted: 0 }) : []
    const t = st.find(x => x.taskId === '${taskId}')
    if (!t) return null
    const panel = document.querySelector('.edit-panel')
    if (!panel) return null
    const vals = [...panel.querySelectorAll('input, textarea')].map(i => String(i.value))
    const texts = panel.textContent
    return (vals.concat(texts).some(v => v.includes('pd20-deeplink-drop target task'))) ? 'on-task' : null
  })()`, 10, 500)
  assert.ok(onTask, 'the panel opened on the WRONG task: ' + JSON.stringify(opened))
})

test('D3 drop a browser URL on the window → inbox task + SourceRef (door-mirrored rows)', async () => {
  const url = 'https://example.com/pd20-drop?utm_source=drag'
  const dropRes = JSON.parse(await evalJson(app.ctx, `(async () => {
    const dt = new DataTransfer()
    dt.setData('text/uri-list', '${url}')
    window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    // surface the drop result the util broadcasts (pd-capture-drop / error)
    const r = await new Promise(res => {
      const ok = e => { res({ ok: true, taskId: e.detail && e.detail.taskId }) }
      const bad = e => { res({ ok: false, url: e.detail && e.detail.url }) }
      window.addEventListener('pd-capture-drop', ok, { once: true })
      window.addEventListener('pd-capture-drop-error', bad, { once: true })
      setTimeout(() => res({ ok: false, timeout: true }), 4000)
    })
    return JSON.stringify(r)
  })()`) ?? 'null')
  assert.ok(dropRes && dropRes.ok === true, 'the drop never reached the capture pipeline: ' + JSON.stringify(dropRes))
  // the drop commit round-trips the bus; poll the db read door for the task + its source
  const taskId = await appUntil(`(async () => {
    const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 })
    const hit = rows.find(r => r.taskContent.includes('pd20-drop'))
    return hit ? hit.taskId : null
  })()`, 25, 500)
  assert.ok(taskId, 'the dropped URL never became a task')
  const sources = await appUntil(`(async () => {
    const s = await window.todoAPI.dbCall('querySourcesByTask', '${taskId}')
    return (s && s.length) ? JSON.stringify(s) : null
  })()`, 15, 500)
  assert.ok(sources, 'the dropped task has no SourceRef (the link row is missing)')
  assert.ok(String(sources).includes('https://example.com/pd20-drop'), 'the SourceRef lost the canonical URL: ' + sources)
  globalThis.__dropTaskId = taskId
})

test('D4 repeat drop of the SAME URL dedupes (fingerprint index, no second task)', async () => {
  const url = 'https://example.com/pd20-drop?utm_source=drag'
  await send(app.ctx, 'Runtime.evaluate', { expression: `(() => {
    const dt = new DataTransfer()
    dt.setData('text/uri-list', '${url}')
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    return 'dropped-again'
  })()` })
  await sleep(1500)
  const rows = await appUntil(`(async () => {
    const r = await window.todoAPI.dbCall('queryTodos', { deleted: 0 })
    return String(r.filter(x => x.taskContent.includes('pd20-drop')).length) + ':' + r.length
  })()`, 10, 400)
  const dropCount = Number(String(rows).split(':')[0])
  assert.equal(dropCount, 1, 'the repeat drop created a SECOND task (dedupe index broken): ' + rows)
})

after(async () => {
  if (app && app.ctx) await stopApp(app.ctx)
})
