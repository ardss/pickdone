/**
 * Attachment-image live journey — j-attachment-image.test.mjs
 * W29 (2026-11-01) closeout wave for the THRICE-user-reported "粘贴图片裂图" (pasted image
 * shows broken) incident. The fourth break must be impossible to miss, so this journey
 * walks the REAL paste→upload→persist→render chain against a live isolated instance:
 *
 *   J1 paste injection: a ClipboardEvent with an image/png File injected into the EditPanel
 *      description textarea must travel the real chain (onDescPaste → uploadOne →
 *      uploadAttachment IPC → disk write → imgList → queueSave → todo/updateTodoFields)
 *      and land a local:/// entry in the task's image field.
 *   J2 Chinese filename (the historical killer — Chromium punycodes/lowercases the HOST of
 *      the pre-W16 url form): upload via the real IPC with a 中文 filename, put the url in
 *      the task's image field, reopen the panel, and assert the rendered <img> actually
 *      DECODED (complete && naturalWidth > 0) — not merely that an <img> exists.
 *   J3 broken-url visibility: a local:// url with no backing file must show the
 *      ep-img-broken placeholder — failure is visible, never silent.
 *
 * Structure mirrors j-todo-core.test.mjs: CDP attach / isolation gate / pool fail-loud /
 * registered cleanups / watchdog. Run inside the shared pool:
 *   cd pickdone && node tests/run-interactions-shared.mjs tests/e2e-journeys/j-attachment-image.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const CDP = process.env.TODO_CDP || 'http://127.0.0.1:9333'

// 隔离门:附着实例必须是隔离数据目录,否则上传的附件会落在真实用户库/附件目录上。
let available = false
let isolated = false
try {
  const list = await (await fetch(CDP + '/json', { signal: AbortSignal.timeout(1500) })).json()
  const page = list.find(t => t.type === 'page' && !t.url.includes('__tomato-float') && /#\/todo-list/.test(t.url)) ||
    list.find(t => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('__tomato-float'))
  available = !!page
  if (page) {
    const ws2 = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej })
    const env = await new Promise(res => {
      ws2.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) res(m.result?.result?.value) }
      ws2.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify({iso: !!(window.todoAPI && window.todoAPI.isDataIsolated)})', returnByValue: true } }))
      setTimeout(() => res(null), 3000)
    })
    try { ws2.close() } catch {}
    try { isolated = JSON.parse(env).iso === true } catch { isolated = false }
  }
} catch { /* no debug port */ }

const sleep = ms => new Promise(r => setTimeout(r, ms))

let preconditionOk = false
{
  const inPool = process.env.TODO_SHARED_CDP || process.env.TODO_CDP
  if (inPool && (!available || !isolated)) {
    console.error(`[j-attachment-image] ran inside the shared pool but the precondition failed (available=${available}, isolated=${isolated}) — skip=green is NOT acceptable evidence, failing loud`)
    process.exitCode = 1
  }
}

// Watchdog (same doctrine as j-todo-core: re-armed per test, races the registered cleanup)
const WATCHDOG_MS = 7 * 60 * 1000
let watchdogTimer = null
let cleanupFn = null
const armWatchdog = () => {
  if (watchdogTimer) clearTimeout(watchdogTimer)
  const watchdog = setTimeout(async () => {
    console.error('J-ATTACHMENT-IMAGE watchdog forced exit (counted as failure)')
    try { if (cleanupFn) await Promise.race([cleanupFn(), sleep(5000)]) } catch { /* best-effort */ }
    cleanupFn = null
    try { ws?.close() } catch {}
    process.exit(1)
  }, WATCHDOG_MS)
  watchdog.unref?.()
  watchdogTimer = watchdog
}
const registerCleanup = fn => { cleanupFn = fn; armWatchdog() }
process.on('exit', () => { try { ws?.close() } catch {} })

let ws = null
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise(res => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }))
})
const evalJson = async expression => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expression})))()`, returnByValue: true, awaitPromise: true }),
    sleep(10000).then(() => null)
  ])
  return r ? JSON.parse(r.result?.result?.value ?? 'null') : null
}
const evalAwait = async expression => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: `(${expression})`, returnByValue: true, awaitPromise: true }),
    sleep(10000).then(() => null)
  ])
  if (!r) return null
  if (r.exceptionDetails) throw new Error('page eval failed: ' + ((r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '').slice(0, 300))
  return r.result?.result?.value ?? null
}
const until = async (expression, tries = 12, gap = 400) => {
  for (let i = 0; i < tries; i++) {
    const v = await evalJson(expression)
    if (v) return v
    await sleep(gap)
  }
  return null
}
const STORE_Q = `(()=>{if(window.appUI&&window.appUI.$store)return window.appUI.$store;const a=document.getElementById('app')&&document.getElementById('app').__vue_app__;const p=a&&a._instance&&a._instance.proxy;if(p&&p.$store)return p.$store;const el=document.querySelector('.app-shell');return (el&&el.__vue__)?el.__vue__.$root.$store:null})()`
const st = () => `(${STORE_Q})`
const gotoHash = async (hash, sentinel) => {
  await send('Runtime.evaluate', { expression: `location.hash='${hash}'` })
  if (!sentinel) { await sleep(1200); return true }
  for (let i = 0; i < 15; i++) {
    await sleep(800)
    if (await evalJson(`!!document.querySelector('${sentinel}')`)) { await sleep(500); return true }
  }
  return false
}
const seedTask = async content => {
  const row = await evalAwait(`(async () => { const s = ${st()}; if (!s) return null; const t = await s.dispatch('todo/addTodo', { todoContent: ${JSON.stringify(content)}, todoDescription: '', todoDate: new Date().setHours(0,0,0,0), todoReminderTime: 0, todoDifficultyLevel: 0 }); await s.dispatch('todo/computeViews'); return t })()`)
  return row
}
const dbLive = async () => evalAwait(`window.todoAPI.dbCall('queryTodos', { deleted: 0 })`)
const hardCleanup = async ids => {
  if (!preconditionOk || !ws) return 0
  if (!ids || !ids.length) return 0
  await evalAwait(`window.todoAPI.dbCall('hardDeleteMany', ${JSON.stringify(ids)})`)
  await evalAwait(`(async () => { const s = ${st()}; if (s) await s.dispatch('todo/computeViews'); return true })()`)
  const rows = await dbLive().catch(() => [])
  const leaked = (rows || []).filter(r => ids.includes(r.taskId)).map(r => r.taskId)
  if (leaked.length) {
    console.error(`[j-attachment-image] LEAKED ROWS after hardCleanup: ${leaked.join(', ')} — they will pollute every later pool target`)
    assert.fail(`hardCleanup failed: seeded rows still present after hardDeleteMany: ${leaked.join(', ')}`)
  }
  return ids.length
}
const clickEl = async predicateSrc => {
  const clicked = await evalJson(`(() => { const el = (${predicateSrc}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true })()`)
  return clicked === true
}
// Open the EditPanel for a seeded row (real click, same path a user takes)
const openEditPanel = async name => {
  await gotoHash('#/todo-list/today', '.qa-input')
  const rowSel = `[...document.querySelectorAll('.td-item')].find(el => el.textContent.includes(${JSON.stringify(name)}))`
  assert.ok(await until(`!!(${rowSel})`, 10, 400), `seeded row "${name}" is not visible on the today list`)
  assert.ok(await clickEl(rowSel), 'clicking the task row did not open anything')
  assert.ok(await until(`!!document.querySelector('.edit-panel')`, 8, 400), 'the edit panel did not open after clicking the row')
}
const closeEditPanel = async () => {
  await send('Runtime.evaluate', { expression: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))` })
  await sleep(600)
}
// 1x1 transparent PNG (real decodable bytes — naturalWidth must be 1 when the chain works)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

test('J-precondition: connect CDP, pin en-US locale, dismiss onboarding overlays', { skip: !available ? 'no debug port on ' + CDP : (!isolated ? 'attached instance is NOT data-isolated; refusing writes on real user data' : false) }, async () => {
  const targets = await (await fetch(CDP + '/json')).json()
  const page = targets.find(t => t.type === 'page' && !t.url.includes('__tomato-float') && /#\/todo-list/.test(t.url)) ||
    targets.find(t => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('__tomato-float'))
  assert.ok(page, 'no page target')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Runtime.evaluate', { expression: "try{localStorage.setItem('appLocale','en-US');localStorage.setItem('onboardingToursSeen', JSON.stringify({today:1,editpanel:1}))}catch(e){}" })
  await send('Page.reload')
  let booted = false
  for (let i = 0; i < 30 && !booted; i++) {
    booted = (await evalJson('document.querySelectorAll(".sn-nav-item").length')) > 0
    if (!booted) await sleep(1000)
  }
  assert.ok(booted, 'the app did not finish booting within 30s')
  await evalJson(`(()=>{const s=document.querySelector('.ob-mask .ob-link');if(s)s.click();return 'ok'})()`)
  await sleep(600)
  await evalJson(`(()=>{try{localStorage.setItem('onboardingToursSeen',JSON.stringify({today:1,editpanel:1}))}catch{};return 'ok'})()`)
  await gotoHash('#/todo-list/today', '.qa-input')
  preconditionOk = true
})

test('J1 paste-image injection: a paste event with an image/png File lands a local:/// entry in the task image field via the REAL upload chain', { skip: !available || !isolated }, async t => {
  if (!preconditionOk) return t.skip('J-precondition failed at runtime — no writes against an unbooted page (cascade guard)')
  const name = 'J1 paste journey ' + Math.random().toString(36).slice(2, 6)
  const ids = []
  const cleanup = async () => { await hardCleanup([...new Set(ids)]) }
  registerCleanup(cleanup)
  try {
    const seeded = await seedTask(name)
    assert.ok(seeded && seeded.taskId, 'seeding J1 task failed')
    ids.push(seeded.taskId)
    await openEditPanel(name)
    // Inject a paste event carrying a real PNG File, exactly the shape onDescPaste reads
    // (clipboardData.items, image/*). No mocking anywhere downstream: the handler calls the
    // real uploadAttachment IPC, which really writes userData/files.
    const injected = await evalAwait(`(() => {
      const ta = document.querySelector('.edit-panel .ep-desc textarea') || document.querySelector('.edit-panel .ep-desc')
      if (!ta) return 'no-desc'
      const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_B64)}), c => c.charCodeAt(0))
      const f = new File([bytes], 'paste-journey.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(f)
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      ta.dispatchEvent(ev)
      return 'ok'
    })()`)
    assert.equal(injected, 'ok', 'the .ep-desc textarea was not found in the edit panel')
    // The paste path ends in queueSave → todo/updateTodoFields; poll the DURABLE row (DB truth)
    const row = await until(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); const r = rows.find(x => x.taskId === '${seeded.taskId}'); return (r && r.image && r.image.includes('local:///') && r.image.includes('paste-journey')) ? r : null })()`, 15, 500)
    assert.ok(row, 'the pasted image never landed in the task image field (paste → uploadAttachment → save chain is broken)')
    let list
    try { list = JSON.parse(row.image) } catch { list = [] }
    const entry = list.find(it => it && typeof it.url === 'string' && it.url.startsWith('local:///'))
    assert.ok(entry, 'the persisted image entry is not in PATH form local:///<encoded> (the pre-W16 host form 404s on non-ASCII names)')
  } finally {
    await cleanup(); cleanupFn = null
  }
})

test('J2 Chinese filename (the historical killer): real IPC upload → task image field → <img> actually decodes (complete && naturalWidth>0)', { skip: !available || !isolated }, async t => {
  if (!preconditionOk) return t.skip('J-precondition failed at runtime — no writes against an unbooted page (cascade guard)')
  const name = 'J2 中文 attachment journey ' + Math.random().toString(36).slice(2, 6)
  const fileName = '中文截图 测试' + Math.random().toString(36).slice(2, 6) + '.png'
  const ids = []
  const cleanup = async () => { await hardCleanup([...new Set(ids)]) }
  registerCleanup(cleanup)
  try {
    const seeded = await seedTask(name)
    assert.ok(seeded && seeded.taskId, 'seeding J2 task failed')
    ids.push(seeded.taskId)
    // REAL chain: uploadAttachment IPC → real disk write under userData/files; then the url
    // goes into the task's image field through the app's own write action.
    const entry = await evalAwait(`(async () => {
      const res = await window.todoAPI.uploadAttachment({ taskId: '${seeded.taskId}', name: ${JSON.stringify(fileName)}, dataBase64: ${JSON.stringify(PNG_B64)}, type: 'image/png' })
      const s = ${st()}
      await s.dispatch('todo/updateTodoFields', { taskId: '${seeded.taskId}', patch: { image: JSON.stringify([{ url: res.url, name: ${JSON.stringify(fileName)}, size: res.size }]) } })
      await s.dispatch('todo/computeViews')
      return res
    })()`)
    assert.ok(entry && entry.url && entry.url.startsWith('local:///'), `uploadAttachment must mint a PATH-form local:/// url, got ${JSON.stringify(entry && entry.url)}`)
    assert.ok(entry.url.includes(encodeURIComponent(fileName)), 'the minted key must carry the original Chinese filename verbatim (encoded)')
    // USER-VISIBLE promise: reopen the panel — the <img> must not just exist but DECODE
    await closeEditPanel()
    await openEditPanel(name)
    const decoded = await until(`(() => {
      const img = document.querySelector('.edit-panel .ep-imgs img')
      if (!img) return null
      return (img.complete && img.naturalWidth > 0) ? { ok: true, w: img.naturalWidth, src: img.src } : { ok: false, attr: img.getAttribute('src'), src: img.src, broken: img.classList.contains('ep-img-broken') }
    })()`, 15, 500)
    if (!decoded || !decoded.ok) {
      const dbg = await evalJson(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); const r = rows.find(x => x.taskId === '${seeded.taskId}'); return { rowImage: r && r.image, attr: (document.querySelector('.edit-panel .ep-imgs img')||{}).getAttribute ? document.querySelector('.edit-panel .ep-imgs img').getAttribute('src') : null } })()`)
      console.error('[j-attachment-image][J2-DEBUG] ' + JSON.stringify(dbg))
    }
    assert.ok(decoded && decoded.ok, `the Chinese-named attachment image did not decode (complete && naturalWidth>0) — got ${JSON.stringify(decoded)}; this is the exact 裂图 incident class`)
    assert.equal(decoded.w, 1, 'the decoded image should be the 1x1 journey PNG')
    assert.ok(!await evalJson(`(()=>{const i=document.querySelector('.edit-panel .ep-imgs img');return i?i.classList.contains('ep-img-broken'):false})()`), 'the rendered image carries the broken placeholder class')
  } finally {
    await cleanup(); cleanupFn = null
  }
})

test('J3 broken local:// url renders the ep-img-broken placeholder — failure is visible, never silent', { skip: !available || !isolated }, async t => {
  if (!preconditionOk) return t.skip('J-precondition failed at runtime — no writes against an unbooted page (cascade guard)')
  const name = 'J3 broken-url journey ' + Math.random().toString(36).slice(2, 6)
  const ghostName = 'ghost-' + Math.random().toString(36).slice(2, 8) + '.png'
  const ids = []
  const cleanup = async () => { await hardCleanup([...new Set(ids)]) }
  registerCleanup(cleanup)
  try {
    const seeded = await seedTask(name)
    assert.ok(seeded && seeded.taskId, 'seeding J3 task failed')
    ids.push(seeded.taskId)
    // A path-form url with NO backing file (deleted on disk / never pulled over sync)
    await evalAwait(`(async () => {
      const s = ${st()}
      await s.dispatch('todo/updateTodoFields', { taskId: '${seeded.taskId}', patch: { image: JSON.stringify([{ url: 'local:///' + encodeURIComponent(${JSON.stringify(ghostName)}), name: ${JSON.stringify(ghostName)}, size: 1 }]) } })
      await s.dispatch('todo/computeViews')
      return 'ok'
    })()`)
    await closeEditPanel()
    await openEditPanel(name)
    const state = await until(`(() => {
      const img = document.querySelector('.edit-panel .ep-imgs img')
      if (!img) return null
      return { complete: img.complete, broken: img.classList.contains('ep-img-broken') }
    })()`, 15, 500)
    assert.ok(state, 'no <img> rendered for the image entry at all')
    assert.ok(state.broken, `an unresolvable local:// url must show the ep-img-broken placeholder (got ${JSON.stringify(state)}) — a silent broken image is exactly the incident class this journey exists to kill`)
  } finally {
    await cleanup(); cleanupFn = null
  }
})

after(() => { try { ws?.close() } catch {} })
