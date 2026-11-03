/**
 * pd20 work-episode live journey — j-pd20-episode.test.mjs
 * Walks the REAL vertical closed loop of the pd20 'continue work' (work episode) slice
 * against a live isolated instance:
 *
 *   J1 settings gate: the EditPanel work-episode section is v-if-gated by the
 *      workEpisode.enabled settings switch (default OFF). Toggle it through the REAL
 *      settings chain (store dispatch('settings/update') → mutation → LS persist),
 *      assert the section is ABSENT before the switch and VISIBLE after it.
 *   J2 episode add + persistence: `episode.put` is an internal:true manifest row at this
 *      HEAD — the renderer-visible surface (EditPanelWork.vue) is read + copy ONLY; there
 *      is no add-episode form yet. The write therefore goes through the REAL main-process
 *      door that exists: the command bus + db.js exactly as cli/pickdone.js drives them
 *      (bus.commit('episode','put') → episodePut → todos.db), against the live instance's
 *      isolated data dir. The READ side is fully renderer-real: dbCall('queryEpisodesByTask')
 *      and the rendered .ep-work-row must show the episode's goal.
 *   J3 source-ref link: same doctrine — bus.commit('source','put') + bus.commit
 *      ('tasksource','put') (providerId 'manual', file-form externalId), then the renderer
 *      read (querySourcesByTask → {level:'L0', canonicalUri:'manual://<file>'}) and the
 *      rendered resources block must carry it.
 *   J4 Copy Handoff: click the real .ep-work-copy button → the clipboard text (result.text
 *      of the injected buildHandoff, NOT "[object Object]") must contain the real goal,
 *      the canonicalUri, and the L0 tag.
 *   J5 reload persistence: location reload → the switch survives (LS settingsState), the
 *      section re-appears, and Episode/SourceRef reads are still complete (restart-grade
 *      persistence semantics).
 *
 * Structure mirrors j-attachment-image.test.mjs: CDP attach / isolation gate / pool
 * fail-loud / registered cleanups / watchdog. Run inside the shared pool:
 *   cd pickdone && node tests/run-interactions-shared.mjs tests/e2e-journeys/j-pd20-episode.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CDP = process.env.TODO_CDP || 'http://127.0.0.1:9333'

// 隔离门:附着实例必须是隔离数据目录,否则 journey 的写会落在真实用户库上。
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
    console.error(`[j-pd20-episode] ran inside the shared pool but the precondition failed (available=${available}, isolated=${isolated}) — skip=green is NOT acceptable evidence, failing loud`)
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
    console.error('J-PD20-EPISODE watchdog forced exit (counted as failure)')
    try { if (cleanupFn) await Promise.race([cleanupFn(), sleep(5000)]) } catch { /* best-effort */ }
    cleanupFn = null
    try { ws?.close() } catch {}
    try { closeStore() } catch {}
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
const clickEl = async predicateSrc => {
  const clicked = await evalJson(`(() => { const el = (${predicateSrc}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true })()`)
  return clicked === true
}
const openEditPanel = async name => {
  await gotoHash('#/todo-list/today', '.qa-input')
  // A still-open panel would make the row click TOGGLE it closed — close first, always
  if (await evalJson(`!!document.querySelector('.edit-panel')`)) {
    assert.ok(await closeEditPanel(), 'a leftover edit panel could not be closed before reopening')
  }
  const rowSel = `[...document.querySelectorAll('.td-item')].find(el => el.textContent.includes(${JSON.stringify(name)}))`
  assert.ok(await until(`!!(${rowSel})`, 10, 400), `seeded row "${name}" is not visible on the today list`)
  assert.ok(await clickEl(rowSel), 'clicking the task row did not open anything')
  assert.ok(await until(`!!document.querySelector('.edit-panel')`, 8, 400), 'the edit panel did not open after clicking the row')
}
const closeEditPanel = async () => {
  // The panel's own Esc handler listens on window (EditPanel.vue `window.addEventListener('keydown')`).
  // Try the document and window targets, then the same store commit the handler dispatches.
  for (const target of ['document', 'window']) {
    await send('Runtime.evaluate', { expression: `${target}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))` })
    for (let i = 0; i < 5; i++) {
      await sleep(400)
      if (!await evalJson(`!!document.querySelector('.edit-panel')`)) return true
    }
  }
  await evalAwait(`(async () => { const s = ${st()}; if (s) await s.dispatch('ui/closeEditCleanup'); return true })()`).catch(() => {})
  for (let i = 0; i < 6; i++) {
    await sleep(400)
    if (!await evalJson(`!!document.querySelector('.edit-panel')`)) return true
  }
  return false
}
// ---- node-side main-process door (the CLI door): command bus + db.js over the LIVE ----
// ---- isolated instance's data dir. Same modules cli/pickdone.js drives; the episode/  ----
// ---- source manifest rows are internal:true, so this IS the real write surface.       ----
const require_ = createRequire(import.meta.url)
const APP_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))) // tests/e2e-journeys/x.mjs → pickdone/
const dbm = require_(path.join(APP_ROOT, 'src', 'main', 'db.js'))
const bus = require_(path.join(APP_ROOT, 'src', 'main', 'command-bus'))
let storeOpen = false
const openStore = dataDir => {
  if (storeOpen) return
  dbm.init(dataDir)
  storeOpen = true
}
const closeStore = () => { if (storeOpen) { try { dbm.close() } catch {} storeOpen = false } }
const resolveDataDir = async () => {
  // The page knows its own isolation root: the default backup dir lives INSIDE userData
  // (<userData>/backups) — dirname recovers it. Fail loud on any mismatch.
  const backupRoot = await evalAwait(`(window.todoAPI && window.todoAPI.getDefaultBackupDir) ? window.todoAPI.getDefaultBackupDir() : null`)
  assert.ok(backupRoot && typeof backupRoot === 'string', 'could not read the default backup dir from the live page (todoAPI.getDefaultBackupDir missing)')
  const dataDir = path.dirname(backupRoot)
  const fs = require_('node:fs')
  assert.ok(fs.existsSync(path.join(dataDir, 'todos.db')), `resolved data dir ${dataDir} has no todos.db — the backup-dir derivation does not point at the live userData`)
  return dataDir
}
const hardCleanup = async ids => {
  if (!preconditionOk || !ids || !ids.length) return 0
  const unique = [...new Set(ids)]
  await evalAwait(`window.todoAPI.dbCall('hardDeleteMany', ${JSON.stringify(unique)})`).catch(() => {})
  await evalAwait(`(async () => { const s = ${st()}; if (s) await s.dispatch('todo/computeViews'); return true })()`)
  const rows = await evalAwait(`window.todoAPI.dbCall('queryTodos', { deleted: 0 })`).catch(() => [])
  const leaked = (rows || []).filter(r => ids.includes(r.taskId)).map(r => r.taskId)
  if (leaked.length) {
    console.error(`[j-pd20-episode] LEAKED ROWS after hardCleanup: ${leaked.join(', ')} — they will pollute every later pool target`)
    assert.fail(`hardCleanup failed: seeded rows still present after hardDeleteMany: ${leaked.join(', ')}`)
  }
  return unique.length
}

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
  // the pool instance spawns with --no-focus; clipboard writes later need a focused page
  await send('Page.bringToFront').catch(() => {})
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

test('J1 workEpisode switch: section absent (default OFF) → settings/update enables → section visible', { skip: !available || !isolated }, async t => {
  if (!preconditionOk) return t.skip('J-precondition failed at runtime — no writes against an unbooted page (cascade guard)')
  const name = 'J1 episode switch journey ' + Math.random().toString(36).slice(2, 6)
  const ids = []
  const cleanup = async () => { await hardCleanup([...new Set(ids)]) }
  registerCleanup(cleanup)
  try {
    // Real task creation: type into the quick-add input and press Enter (the user's chain)
    await gotoHash('#/todo-list/today', '.qa-input')
    await evalJson(`(() => {
      const i = document.querySelector('.qa-input')
      if (!i) return false
      i.focus()
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(i, ${JSON.stringify(name)})
      i.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(400)
    await evalJson(`(() => { const i = document.querySelector('.qa-input'); if (!i) return false; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); return true })()`)
    const row = await until(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); return rows.find(r => r.taskContent === ${JSON.stringify(name)}) || null })()`, 12, 500)
    assert.ok(row && row.taskId, 'the quick-add Enter did not create the task row')
    ids.push(row.taskId)
    // Gate CLOSED by default: the section must not render
    await openEditPanel(name)
    assert.ok(!await evalJson(`!!document.querySelector('.edit-panel .ep-work-section')`), 'the work-episode section rendered while workEpisode.enabled is unset (the experiment gate is broken open)')
    await closeEditPanel()
    // Real settings chain: store action → mutation → LS persist. The user-visible promise
    // is verified by the SECTION appearing after the switch (not by the state blob alone).
    const upd = await evalAwait(`(async () => { const s = ${st()}; return s ? s.dispatch('settings/update', { workEpisode: { enabled: true } }) : null })()`)
    assert.ok(upd && upd.ok !== false, 'settings/update dispatch failed: ' + JSON.stringify(upd))
    const gate = await evalJson(`(() => { const s = ${st()}; return !!(s && s.state && s.state.settings && s.state.settings.workEpisode && s.state.settings.workEpisode.enabled) })()`)
    assert.ok(gate, 'the store gate workEpisode.enabled did not seat after the update dispatch')
    // persist() is debounced (~2s) — poll, don't single-shot
    const ls = await until(`(() => { try { const v = JSON.parse(localStorage.getItem('settingsState') || '{}'); return !!(v.workEpisode && v.workEpisode.enabled) } catch { return false } })()`, 12, 500)
    assert.ok(ls, 'the switch did not persist to localStorage settingsState (it would die on the next boot)')
    // Gate OPEN: reopen the panel — the section must be visible now (the v-if reads the store)
    await openEditPanel(name)
    assert.ok(await until(`!!document.querySelector('.edit-panel .ep-work-section')`, 8, 500), 'the work-episode section did not appear after workEpisode.enabled=true (the store → EditPanel v-if chain is broken)')
  } finally {
    await cleanup(); cleanupFn = null
  }
})

test('J2 episode put (real bus door) → renderer read-back + visible history row + dbCall persistence', { skip: !available || !isolated }, async t => {
  if (!preconditionOk) return t.skip('J-precondition failed at runtime — no writes against an unbooted page (cascade guard)')
  const name = 'J2 episode add journey ' + Math.random().toString(36).slice(2, 6)
  const goal = 'Ship the pd20 vertical slice: real episode lands in the work history'
  const ids = []
  const cleanup = async () => { await hardCleanup([...new Set(ids)]) }
  registerCleanup(cleanup)
  try {
    // seed the task (same real quick-add chain as J1)
    await gotoHash('#/todo-list/today', '.qa-input')
    await evalJson(`(() => { const i = document.querySelector('.qa-input'); if (!i) return false; i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(name)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(400)
    await evalJson(`(() => { const i = document.querySelector('.qa-input'); if (!i) return false; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); return true })()`)
    const row = await until(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); return rows.find(r => r.taskContent === ${JSON.stringify(name)}) || null })()`, 12, 500)
    assert.ok(row && row.taskId, 'seeding the J2 task failed')
    ids.push(row.taskId)
    // enable the switch (J1 proved the chain; here it is the precondition for visibility)
    await evalAwait(`(async () => { const s = ${st()}; if (s) await s.dispatch('settings/update', { workEpisode: { enabled: true } }); return true })()`)
    // REAL write through the main-process command bus (the CLI door) on the live data dir
    const dataDir = await resolveDataDir()
    openStore(dataDir)
    const startedAt = Date.now()
    const epId = bus.commit('episode', 'put', { taskId: String(row.taskId), startedAt, note: goal })
    assert.ok(epId && typeof epId === 'string', 'bus.commit(episode,put) returned no id — the internal write door is broken')
    // DURABLE read-back via the renderer's own dbCall: the episode must survive in storage
    const eps = await until(`(async () => { const e = await window.todoAPI.dbCall('queryEpisodesByTask', ${JSON.stringify(row.taskId)}); return (e && e.length) ? e : null })()`, 10, 500)
    assert.ok(eps, 'queryEpisodesByTask returned nothing for the seeded episode')
    const hit = eps.find(e => e.episodeId === epId)
    assert.ok(hit, `the minted episode ${epId} is not in the read-back: ${JSON.stringify(eps.map(e => e.episodeId))}`)
    assert.equal(hit.summary, goal, "the read-back episode's summary (the buildHandoff `goal` input) does not carry the written note")
    // USER-VISIBLE: reopen the panel — the history row must render the goal text
    await closeEditPanel()
    await openEditPanel(name)
    assert.ok(await until(`[...document.querySelectorAll('.edit-panel .ep-work-section [data-block="history"] .ep-work-row')].some(el => el.textContent.includes(${JSON.stringify(goal)}))`, 10, 500), 'the episode goal never became visible in the work-history block (the read → EditPanelWork render chain is broken)')
    // "current status" block mirrors the last episode's summary — same visibility promise
    assert.ok(await until(`(() => { const b = document.querySelector('.edit-panel .ep-work-section [data-block="current"] .ep-work-text'); return b && b.textContent.includes(${JSON.stringify(goal)}) })()`, 6, 500), 'the current-status block does not show the latest episode summary')
  } finally {
    await cleanup(); cleanupFn = null
  }
})

test('J3 source-ref link (manual provider, file form) → querySourcesByTask carries level/canonicalUri + resources row', { skip: !available || !isolated }, async t => {
  if (!preconditionOk) return t.skip('J-precondition failed at runtime — no writes against an unbooted page (cascade guard)')
  const name = 'J3 source link journey ' + Math.random().toString(36).slice(2, 6)
  const extId = 'docs/journey-' + Math.random().toString(36).slice(2, 8) + '.md'
  const title = 'Journey design notes'
  const ids = []
  const srcIds = []
  const cleanup = async () => {
    try { openStoreCleanup() } catch {}
    await hardCleanup([...new Set(ids)])
  }
  const openStoreCleanup = () => {
    if (!storeCleanDataDir) return
    openStore(storeCleanDataDir)
    if (srcIds.length) { try { bus.commit('source', 'removeByIds', { ids: [...srcIds] }) } catch {} }
    if (linkIds.length) { try { bus.commit('tasksource', 'remove', { ids: [...linkIds] }) } catch {} }
  }
  let storeCleanDataDir = null
  const linkIds = []
  registerCleanup(cleanup)
  try {
    await gotoHash('#/todo-list/today', '.qa-input')
    await evalJson(`(() => { const i = document.querySelector('.qa-input'); if (!i) return false; i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(name)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(400)
    await evalJson(`(() => { const i = document.querySelector('.qa-input'); if (!i) return false; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); return true })()`)
    const row = await until(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); return rows.find(r => r.taskContent === ${JSON.stringify(name)}) || null })()`, 12, 500)
    assert.ok(row && row.taskId, 'seeding the J3 task failed')
    ids.push(row.taskId)
    await evalAwait(`(async () => { const s = ${st()}; if (s) await s.dispatch('settings/update', { workEpisode: { enabled: true } }); return true })()`)
    const dataDir = await resolveDataDir()
    storeCleanDataDir = dataDir
    openStore(dataDir)
    const srcId = bus.commit('source', 'put', { providerId: 'manual', externalId: extId, title })
    assert.ok(srcId, 'bus.commit(source,put) returned no id')
    srcIds.push(srcId)
    const linkId = bus.commit('tasksource', 'put', { taskId: String(row.taskId), sourceRefId: srcId })
    assert.ok(linkId, 'bus.commit(tasksource,put) returned no id')
    linkIds.push(linkId)
    // The resources block renders each EPISODE's linked resources (EditPanelWork computed),
    // so an episode row is part of the real read model under test here
    const epId = bus.commit('episode', 'put', { taskId: String(row.taskId), startedAt: Date.now(), note: 'J3 episode carrying the linked resources' })
    assert.ok(epId, 'bus.commit(episode,put) returned no id')
    // Renderer read-back: the view-model shape buildHandoff consumes (level + canonicalUri composed main-side)
    const srcs = await until(`(async () => { const s = await window.todoAPI.dbCall('querySourcesByTask', ${JSON.stringify(row.taskId)}); return (s && s.length) ? s : null })()`, 10, 500)
    assert.ok(srcs, 'querySourcesByTask returned nothing for the linked source')
    const hit = srcs.find(s => s.canonicalUri === 'manual://' + extId)
    assert.ok(hit, `the linked source's canonicalUri manual://${extId} is not in the read-back: ${JSON.stringify(srcs)}`)
    assert.equal(hit.level, 'L0', `the read-back source must carry the L0 provenance level, got ${JSON.stringify(hit.level)}`)
    assert.equal(hit.title, title, 'the read-back source lost its title')
    // USER-VISIBLE: the linked-resources block must render the title
    await closeEditPanel()
    await openEditPanel(name)
    assert.ok(await until(`[...document.querySelectorAll('.edit-panel .ep-work-section [data-block="resources"] .ep-work-row')].some(el => el.textContent.includes(${JSON.stringify(title)}))`, 10, 500), 'the linked source never became visible in the resources block')
  } finally {
    await cleanup(); cleanupFn = null
  }
})

test('J4 Copy Handoff: real button → clipboard text carries goal, canonicalUri, L0 tag; never "[object Object]"', { skip: !available || !isolated }, async t => {
  if (!preconditionOk) return t.skip('J-precondition failed at runtime — no writes against an unbooted page (cascade guard)')
  const name = 'J4 handoff copy journey ' + Math.random().toString(36).slice(2, 6)
  const goal = 'Hand the pd20 slice to the next session with a real handoff line'
  const extId = 'docs/handoff-' + Math.random().toString(36).slice(2, 8) + '.md'
  const ids = []
  const srcIds = []
  const linkIds = []
  let dataDirRef = null
  const cleanup = async () => {
    if (dataDirRef) {
      openStore(dataDirRef)
      if (linkIds.length) { try { bus.commit('tasksource', 'remove', { ids: [...linkIds] }) } catch {} }
      if (srcIds.length) { try { bus.commit('source', 'removeByIds', { ids: [...srcIds] }) } catch {} }
    }
    await hardCleanup([...new Set(ids)])
  }
  registerCleanup(cleanup)
  try {
    await gotoHash('#/todo-list/today', '.qa-input')
    await evalJson(`(() => { const i = document.querySelector('.qa-input'); if (!i) return false; i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(name)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(400)
    await evalJson(`(() => { const i = document.querySelector('.qa-input'); if (!i) return false; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); return true })()`)
    const row = await until(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); return rows.find(r => r.taskContent === ${JSON.stringify(name)}) || null })()`, 12, 500)
    assert.ok(row && row.taskId, 'seeding the J4 task failed')
    ids.push(row.taskId)
    await evalAwait(`(async () => { const s = ${st()}; if (s) await s.dispatch('settings/update', { workEpisode: { enabled: true } }); return true })()`)
    const dataDir = await resolveDataDir()
    dataDirRef = dataDir
    openStore(dataDir)
    const epId = bus.commit('episode', 'put', { taskId: String(row.taskId), startedAt: Date.now(), note: goal })
    assert.ok(epId, 'episode put failed')
    const srcId = bus.commit('source', 'put', { providerId: 'manual', externalId: extId, title: 'Handoff source' })
    assert.ok(srcId, 'source put failed')
    srcIds.push(srcId)
    linkIds.push(bus.commit('tasksource', 'put', { taskId: String(row.taskId), sourceRefId: srcId }))
    // The copy button only exists when the buildHandoff provider was injected (hasHandoff)
    await closeEditPanel()
    await openEditPanel(name)
    await send('Page.bringToFront').catch(() => {}) // clipboard.writeText needs a focused page
    assert.ok(await until(`!!document.querySelector('.edit-panel .ep-work-section .ep-work-copy')`, 10, 500), 'the Copy Handoff button is not visible (the buildHandoff provide/inject chain is broken — the S2 seam regressed)')
    assert.ok(await clickEl(`document.querySelector('.edit-panel .ep-work-section .ep-work-copy')`), 'the Copy Handoff button click failed')
    // User-visible feedback first
    const state = await until(`(() => { const el = document.querySelector('.edit-panel .ep-work-section .ep-work-copy-state'); return el ? el.textContent.trim() : null })()`, 6, 400)
    assert.ok(state === 'Copied to clipboard', `the copy feedback state is not the success message, got ${JSON.stringify(state)}`)
    // The REAL promise: the clipboard carries the markdown handoff (result.text, not String(result))
    const clip = await evalAwait(`navigator.clipboard.readText()`)
    assert.ok(clip && typeof clip === 'string' && clip.length > 0, 'the clipboard is empty after Copy Handoff')
    assert.ok(!clip.includes('[object Object]'), 'the clipboard carries "[object Object]" — the exact regression this button shipped to kill')
    assert.ok(clip.includes('# Handoff'), 'the clipboard text is not the buildHandoff markdown (missing the "# Handoff" header)')
    assert.ok(clip.includes(name), 'the clipboard handoff does not name the real task title')
    assert.ok(clip.includes(goal), 'the clipboard handoff does not carry the real episode goal')
    assert.ok(clip.includes('goal: ' + goal), "the clipboard handoff's episode block does not carry the goal line")
    assert.ok(clip.includes('outcome:'), "the clipboard handoff's episode block lost the outcome line")
    assert.ok(clip.includes('nextAction:'), "the clipboard handoff's episode block lost the nextAction line")
    assert.ok(clip.includes('[L0]'), 'the clipboard handoff does not tag the source with its L0 provenance level')
    assert.ok(clip.includes('manual://' + extId), 'the clipboard handoff does not carry the linked source canonicalUri')
  } finally {
    await cleanup(); cleanupFn = null
  }
})

test('J5 reload persistence: switch + section + episode + source link all survive a page reload', { skip: !available || !isolated }, async t => {
  if (!preconditionOk) return t.skip('J-precondition failed at runtime — no writes against an unbooted page (cascade guard)')
  const name = 'J5 reload journey ' + Math.random().toString(36).slice(2, 6)
  const goal = 'This episode must outlive a page reload'
  const extId = 'docs/reload-' + Math.random().toString(36).slice(2, 8) + '.md'
  const ids = []
  const srcIds = []
  const linkIds = []
  let dataDirRef = null
  const cleanup = async () => {
    if (dataDirRef) {
      openStore(dataDirRef)
      if (linkIds.length) { try { bus.commit('tasksource', 'remove', { ids: [...linkIds] }) } catch {} }
      if (srcIds.length) { try { bus.commit('source', 'removeByIds', { ids: [...srcIds] }) } catch {} }
    }
    await hardCleanup([...new Set(ids)])
  }
  registerCleanup(cleanup)
  try {
    await gotoHash('#/todo-list/today', '.qa-input')
    await evalJson(`(() => { const i = document.querySelector('.qa-input'); if (!i) return false; i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(name)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(400)
    await evalJson(`(() => { const i = document.querySelector('.qa-input'); if (!i) return false; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); return true })()`)
    const row = await until(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); return rows.find(r => r.taskContent === ${JSON.stringify(name)}) || null })()`, 12, 500)
    assert.ok(row && row.taskId, 'seeding the J5 task failed')
    ids.push(row.taskId)
    await evalAwait(`(async () => { const s = ${st()}; if (s) await s.dispatch('settings/update', { workEpisode: { enabled: true } }); return true })()`)
    const dataDir = await resolveDataDir()
    dataDirRef = dataDir
    openStore(dataDir)
    const epId = bus.commit('episode', 'put', { taskId: String(row.taskId), startedAt: Date.now(), note: goal })
    assert.ok(epId, 'episode put failed')
    const srcId = bus.commit('source', 'put', { providerId: 'manual', externalId: extId, title: 'Reload source' })
    assert.ok(srcId, 'source put failed')
    srcIds.push(srcId)
    linkIds.push(bus.commit('tasksource', 'put', { taskId: String(row.taskId), sourceRefId: srcId }))
    // RELOAD the page (the restart-grade persistence semantics under test)
    await send('Page.reload')
    let booted = false
    for (let i = 0; i < 30 && !booted; i++) {
      booted = (await evalJson('document.querySelectorAll(".sn-nav-item").length')) > 0
      if (!booted) await sleep(1000)
    }
    assert.ok(booted, 'the app did not come back after the reload')
    // The switch must have survived (LS settingsState write-through)
    const gate = await evalJson(`(() => { const s = ${st()}; return !!(s && s.state && s.state.settings && s.state.settings.workEpisode && s.state.settings.workEpisode.enabled) })()`)
    assert.ok(gate, 'workEpisode.enabled did not survive the reload (the settings LS write-through is broken)')
    // Both reads still complete after the reload
    const eps = await until(`(async () => { const e = await window.todoAPI.dbCall('queryEpisodesByTask', ${JSON.stringify(row.taskId)}); return (e && e.length) ? e : null })()`, 10, 500)
    assert.ok(eps && eps.find(e => e.episodeId === epId && e.summary === goal), 'the episode did not survive the reload in the dbCall read-back')
    const srcs = await until(`(async () => { const s = await window.todoAPI.dbCall('querySourcesByTask', ${JSON.stringify(row.taskId)}); return (s && s.length) ? s : null })()`, 10, 500)
    assert.ok(srcs && srcs.find(s => s.canonicalUri === 'manual://' + extId && s.level === 'L0'), 'the source link did not survive the reload in the dbCall read-back')
    // USER-VISIBLE: reopen the panel — section, history row and resources row all back
    await openEditPanel(name)
    assert.ok(await until(`!!document.querySelector('.edit-panel .ep-work-section')`, 8, 500), 'the work-episode section did not re-appear after the reload')
    assert.ok(await until(`[...document.querySelectorAll('.edit-panel .ep-work-section [data-block="history"] .ep-work-row')].some(el => el.textContent.includes(${JSON.stringify(goal)}))`, 8, 500), 'the episode history row is not visible after the reload')
    assert.ok(await until(`[...document.querySelectorAll('.edit-panel .ep-work-section [data-block="resources"] .ep-work-row')].some(el => el.textContent.includes('Reload source'))`, 8, 500), 'the linked resource row is not visible after the reload')
  } finally {
    await cleanup(); cleanupFn = null
    closeStore()
  }
})

after(() => { try { ws?.close(); closeStore() } catch {} })
