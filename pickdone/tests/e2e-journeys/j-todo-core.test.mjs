/**
 * Core user journeys E2E — j-todo-core.test.mjs
 * Value proposition: assert what the USER SEES (DOM) and what the DB holds, never trusting
 * code-internal assumptions. These journeys pin the historical "implemented-by-assumption but
 * behavior-wrong" incidents: silent no-op undo, NL dates landing on the wrong day (the W10
 * 2026-10-26 fix — "meeting tomorrow 3pm" used to silently schedule TODAY at 15:00 with the
 * date words left in the title), and view-caliber drifts.
 *
 * 4 journeys:
 *   J1 NL quick-add "meeting tomorrow 3pm" → tomorrow 15:00, title residue-free
 *   J2 add → complete → today-completed group → un-complete → back to today group
 *   J3 soft delete → recycle-bin view shows it → restore → back in the list
 *   J4 edit panel rename → list reflects it → search view finds it by keyword
 *
 * Structure mirrors tests/e2e.test.mjs: CDP attach / isolation gate / pool fail-loud /
 * 120s watchdog / exit cleanup. Run inside the shared pool:
 *   cd pickdone && node tests/run-interactions-shared.mjs tests/e2e-journeys/j-todo-core.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const CDP = process.env.TODO_CDP || 'http://127.0.0.1:9333'

// 隔离门:附着实例必须是隔离数据目录(启动时注入 TODO_USER_DATA_DIR,preload 暴露 isDataIsolated),
// 否则本组用例的增删改会落在真实用户库上。
let available = false
let isolated = false
try {
  const list = await (await fetch(CDP + '/json', { signal: AbortSignal.timeout(1500) })).json()
  const page = list.find(t => t.type === 'page' && !t.url.includes('__tomato-float'))
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

// [signal-integrity] inside the shared pool the instance is GUARANTEED booted and data-isolated;
// a whole-group skip there means the environment handoff broke — fail loud, never skip=green.
{
  const inPool = process.env.TODO_SHARED_CDP || process.env.TODO_CDP
  if (inPool && (!available || !isolated)) {
    console.error(`[j-todo-core] ran inside the shared pool but the precondition failed (available=${available}, isolated=${isolated}) — skip=green is NOT acceptable evidence, failing loud`)
    process.exitCode = 1
  }
}

// Watchdog: WS handles keep the event loop alive; force-exit after 120s no matter what.
// 2026-10-26 (W12 Fix 2): process.exit used to fire directly, SKIPPING the tests' finally
// cleanup sweeps and leaking seeded todo rows into up to 8 downstream pool targets on a slow
// (not broken) journey. Each test registers its best-effort cleanup below (registerCleanup);
// the watchdog races it against a 5s grace before exiting.
let cleanupFn = null
// W13 2026-10-26: the watchdog used to be a single file-global 120s timer armed once at module
// load and NEVER re-armed between tests. A slow-but-green file was force-exited at 120s
// CUMULATIVE (the shared pool grants each target an 8min budget — this file can legitimately
// use more than 2 of those minutes), and when the stale timer fired during a PASSING test's
// finally the shared cleanupFn ran concurrently with itself while the 5s grace could cut
// hardCleanup mid-delete. registerCleanup now RE-ARMS the timer per test (7min, inside the
// pool's 8min per-target budget) and each test's finally nulls cleanupFn when done, so a
// late fire can only ever race the CURRENT test's cleanup, never re-run a finished one.
const WATCHDOG_MS = 7 * 60 * 1000
let watchdogTimer = null
const armWatchdog = () => {
  if (watchdogTimer) clearTimeout(watchdogTimer)
  const watchdog = setTimeout(async () => {
    console.error('J-TODO-CORE watchdog forced exit (counted as failure)')
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
// Await-style eval. 2026-10-26 (W12 Fix 3): this used to be a byte-for-byte duplicate of the
// OLD silent-null evalJson — it swallowed page exceptions and returned null on timeout, so a
// failed hardCleanup no-op'd silently (j-habit-moment had already fixed the exact same hole;
// the cleanup-verification doctrine was inconsistent between sibling journey files). Now it
// surfaces exceptionDetails like j-habit's evalAwait does.
const evalAwait = async expression => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: `(${expression})`, returnByValue: true, awaitPromise: true }),
    sleep(10000).then(() => null)
  ])
  if (!r) return null
  if (r.exceptionDetails) throw new Error('page eval failed: ' + ((r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '').slice(0, 300))
  return r.result?.result?.value ?? null
}
// Poll until a DOM/DB probe turns truthy (bounded retries; the probe result is returned for failure detail)
const until = async (expression, tries = 12, gap = 400) => {
  for (let i = 0; i < tries; i++) {
    const v = await evalJson(expression)
    if (v) return v
    await sleep(gap)
  }
  return null
}
// window.appUI.$store (stable Vue3 path) with the DOM fallbacks — same as ui-smoke's STORE_Q
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
// Seed through the app's OWN write path (todo/addTodo) so the row shape matches real user rows
const seedTask = async content => {
  const row = await evalAwait(`(async () => { const s = ${st()}; if (!s) return null; const t = await s.dispatch('todo/addTodo', { todoContent: ${JSON.stringify(content)}, todoDescription: '', todoDate: new Date().setHours(0,0,0,0), todoReminderTime: 0, todoDifficultyLevel: 0 }); await s.dispatch('todo/computeViews'); return t })()`)
  return row
}
// DB rows straight from SQLite (the durable truth, not the in-memory store)
const dbLive = async () => evalAwait(`window.todoAPI.dbCall('queryTodos', { deleted: 0 })`)
const dbBinned = async () => evalAwait(`window.todoAPI.dbCall('queryTodos', { deleted: 1 })`)
const hardCleanup = async ids => {
  if (!ids || !ids.length) return 0
  await evalAwait(`window.todoAPI.dbCall('hardDeleteMany', ${JSON.stringify(ids)})`)
  await evalAwait(`(async () => { const s = ${st()}; if (s) await s.dispatch('todo/computeViews'); return true })()`)
  // 2026-10-26 (W12 Fix 3): post-cleanup verification — the old silent-null evalAwait made a
  // failed hardDeleteMany a silent no-op (null swallowed the page exception), leaking rows into
  // later pool targets (j-rail-stats J8 asserts today === 2 exactly). Re-query BOTH live and
  // binned rows and fail loudly naming the leaked ids.
  const leaked = []
  for (const [label, q] of [['live', dbLive], ['binned', dbBinned]]) {
    const rows = await q().catch(() => [])
    for (const tid of ids) if ((rows || []).some(r => r.taskId === tid)) leaked.push(`${label}:${tid}`)
  }
  if (leaked.length) {
    console.error(`[j-todo-core] LEAKED ROWS after hardCleanup: ${leaked.join(', ')} — they will pollute every later pool target`)
    assert.fail(`hardCleanup failed: seeded todo rows are still present in the DB after hardDeleteMany: ${leaked.join(', ')}`)
  }
  return ids.length
}
// Real click on an element matched by a JS predicate inside the page (bubbling MouseEvent, as a user's click lands)
const clickEl = async predicateSrc => {
  const clicked = await evalJson(`(() => { const el = (${predicateSrc}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true })()`)
  return clicked === true
}
// Local calendar math mirroring todayBounds.dayStart/dayShift (same machine, same tz as the app)
const dayStartTs = ts => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }
const T_NOW = Date.now()
const TODAY0 = dayStartTs(T_NOW)
const TOMORROW0 = dayStartTs(T_NOW + 86400000)
const TOMORROW15 = (() => { const d = new Date(T_NOW); d.setDate(d.getDate() + 1); d.setHours(15, 0, 0, 0); return d.getTime() })()
const TOMORROW_DOM = new Date(T_NOW + 86400000).getDate() // day-of-month number shown on the day strip

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
  // Locale pin (en-US surface) + retire onboarding wizard/tours (their overlays swallow real clicks)
  await send('Runtime.evaluate', { expression: "try{localStorage.setItem('appLocale','en-US');localStorage.setItem('onboardingToursSeen', JSON.stringify({today:1,editpanel:1}))}catch(e){}" })
  await send('Page.reload')
  let booted = false
  for (let i = 0; i < 30 && !booted; i++) {
    booted = (await evalJson('document.querySelectorAll(".sn-nav-item").length')) > 0
    if (!booted) await sleep(1000)
  }
  assert.ok(booted, 'the app did not finish booting within 30s')
  // Close any leftover onboarding overlay (a fresh isolated instance may still show it)
  await evalJson(`(()=>{const s=document.querySelector('.ob-mask .ob-link');if(s)s.click();return 'ok'})()`)
  await sleep(600)
  await evalJson(`(()=>{try{localStorage.setItem('onboardingToursSeen',JSON.stringify({today:1,editpanel:1}))}catch{};return 'ok'})()`)
  await gotoHash('#/todo-list/today', '.qa-input')
})

test('J1 NL quick-add: "meeting tomorrow 3pm" lands TOMORROW 15:00 with a clean title (W10 2026-10-26 pin: it used to silently schedule TODAY with date words left in the title)', { skip: !available || !isolated }, async () => {
  const createdIds = []
  // W12 2026-10-26: the sweep is a named, REGISTERED cleanup — the watchdog races it (5s grace)
  // before force-exiting so a slow journey cannot leak rows into later pool targets.
  const cleanup = async () => {
    // W11 2026-10-26: sweep by taskContent REGARDLESS of dayStart. Filtering on
    // dayStart === TOMORROW0 here made cleanup conditional on the very behavior under test —
    // when the pinned W10 bug recurs (row lands on TODAY), the sweep no-ops and the "meeting"
    // row leaks into later pool targets (j-rail-stats J8 asserts today === 2 exactly, so a
    // leaked row shows up as a MISLEADING second red far away from the real regression).
    const rows = await dbLive().catch(() => [])
    const binned = await dbBinned().catch(() => [])
    const mine = [...(rows || []), ...(binned || [])]
      .filter(r => r.taskContent === 'meeting' || r.taskContent.startsWith('meeting '))
      .map(r => r.taskId)
    // Loud regression signal: a swept row whose dayStart is not TOMORROW0 IS the W10 bug
    // resurfacing as a leak — never let it pass silently.
    const offDay = [...(rows || []), ...(binned || [])]
      .filter(r => (r.taskContent === 'meeting' || r.taskContent.startsWith('meeting ')) && r.dayStart !== TOMORROW0)
    for (const r of offDay) {
      console.error(`[j-todo-core][W10-REGRESSION-SIGNAL] cleanup swept a "meeting" row scheduled for dayStart=${r.dayStart} (expected TOMORROW0=${TOMORROW0}) — the NL-date regression the J1 journey should have caught leaked past the row assertion`)
    }
    await hardCleanup([...new Set([...createdIds, ...mine])])
  }
  registerCleanup(cleanup)
  try {
    await gotoHash('#/todo-list/today', '.qa-input')
    // Real interaction: type into the quick-add input as the user does
    await evalJson(`(() => {
      const i = document.querySelector('.qa-input')
      if (!i) return false
      i.focus()
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(i, 'meeting tomorrow 3pm')
      i.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(400)
    // USER-VISIBLE promise 1: the NL date chip must show "tomorrow 15:00" before Enter is pressed
    const chip = await evalJson(`(() => { const c = document.querySelector('.qa-date-chip'); return c ? c.textContent.trim() : null })()`)
    assert.ok(chip && /tomorrow\s*15:00/.test(chip), `the NL date chip did not promise "tomorrow 15:00" — got: ${JSON.stringify(chip)}`)
    // Press Enter (keyup, same as e2e.test.mjs's proven path)
    await evalJson(`(() => { const i = document.querySelector('.qa-input'); if (!i) return false; i.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true })); return true })()`)
    // DB truth: the row must exist, titled exactly "meeting"
    const row = await until(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); return rows.find(r => r.taskContent === 'meeting' && r.dayStart === ${TOMORROW0}) || null })()`, 10, 400)
    assert.ok(row, 'no DB row titled exactly "meeting" scheduled for TOMORROW was created')
    createdIds.push(row.taskId)
    // The behavior under test — these are the user's expectations, not today's implementation:
    assert.equal(row.dayStart, TOMORROW0, `dayStart must be tomorrow's local midnight (${TOMORROW0}), got ${row.dayStart} (${row.dayStart === TODAY0 ? 'landed on TODAY — the pre-W10 bug' : 'unexpected day'})`)
    assert.equal(row.todoTime, TOMORROW15, `todoTime must be tomorrow 15:00 (${TOMORROW15}), got ${row.todoTime}`)
    assert.ok(row.reminderTime === TOMORROW15 || row.reminderTime > 0, `a time-bearing NL add must carry a reminder, got reminderTime=${row.reminderTime}`)
    assert.notEqual(row.dayStart, TODAY0, 'the reminder/date must NOT fall on today (pre-W10 silent-today bug)')
    // USER-VISIBLE 2: the title carries no "tomorrow" residue (exact equality already asserted above;
    // double-check the DOM: select tomorrow on the day strip as a user would, the row must render there)
    await clickEl(`[...document.querySelectorAll('.ds-day')].find(b => b.querySelector('.ds-num') && b.querySelector('.ds-num').textContent.trim().startsWith('${TOMORROW_DOM}'))`)
    await sleep(1200)
    const onTomorrow = await until(`[...document.querySelectorAll('.td-item .td-title')].some(t => t.textContent.trim() === 'meeting')`, 8, 400)
    assert.ok(onTomorrow, 'the created task is not visible on the tomorrow day view (user cannot see what they just scheduled)')
  } finally {
    await cleanup(); cleanupFn = null // W13 2026-10-26: hand the watchdog back (a late fire must not re-run a finished cleanup)
  }
})

test('J2 add → complete → enters the today-completed group → un-complete → back to the today group', { skip: !available || !isolated }, async () => {
  const name = 'J2 complete journey ' + Math.random().toString(36).slice(2, 6)
  const ids = []
  // W12 2026-10-26: registered best-effort cleanup for the watchdog (see registerCleanup comment)
  const cleanup = async () => {
    const rows = await dbLive().catch(() => [])
    const mine = (rows || []).filter(r => ids.includes(r.taskId)).map(r => r.taskId)
    await hardCleanup([...new Set([...ids, ...mine])])
  }
  registerCleanup(cleanup)
  try {
    const seeded = await seedTask(name)
    assert.ok(seeded && seeded.taskId, 'seeding J2 task failed')
    ids.push(seeded.taskId)
    await gotoHash('#/todo-list/today', '.qa-input')
    const rowSel = `[...document.querySelectorAll('.td-item')].find(el => el.textContent.includes(${JSON.stringify(name)}))`
    assert.ok(await until(`!!(${rowSel})`, 10, 400), 'the seeded task row is not visible on the today list')
    // Real click on the row's checkbox
    assert.ok(await clickEl(`(${rowSel})?.querySelector('.td-check')`), 'no .td-check found on the task row')
    const doneRow = await until(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); return rows.find(r => r.taskId === '${seeded.taskId}' && r.complete === true) || null })()`, 12, 400)
    assert.ok(doneRow, 'clicking the checkbox did not complete the task (DB complete stays false)')
    // USER-VISIBLE: the "completed" group on the today view must contain the row; open it if folded
    const doneGroupVisible = await until(`(() => {
      const g = [...document.querySelectorAll('.tg-group')].find(s => /completed/i.test(s.querySelector('.tg-head')?.textContent || ''))
      if (!g) return false
      if (g.querySelector('.tg-head')?.getAttribute('aria-expanded') === 'false') g.querySelector('.tg-head').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return !![...g.querySelectorAll('.td-item .td-title')].find(t => t.textContent.trim() === ${JSON.stringify(name)})
    })()`, 10, 500)
    assert.ok(doneGroupVisible, 'the completed task is not visible inside the completed-today group')
    // Un-complete: click the (now checked) checkbox again
    assert.ok(await clickEl(`(${rowSel})?.querySelector('.td-check')`), 'no .td-check to click for un-completing')
    const undoneRow = await until(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); return rows.find(r => r.taskId === '${seeded.taskId}' && r.complete === false) || null })()`, 12, 400)
    assert.ok(undoneRow, 'clicking the checked checkbox did not un-complete the task (DB complete stays true)')
    // USER-VISIBLE: back in the today (uncompleted) group, gone from the completed group
    const backInToday = await until(`(() => {
      const g = [...document.querySelectorAll('.tg-group')].find(s => !/completed/i.test(s.querySelector('.tg-head')?.textContent || '') && [...s.querySelectorAll('.td-item .td-title')].some(t => t.textContent.trim() === ${JSON.stringify(name)}))
      const doneG = [...document.querySelectorAll('.tg-group')].find(s => /completed/i.test(s.querySelector('.tg-head')?.textContent || '') && [...s.querySelectorAll('.td-item .td-title')].some(t => t.textContent.trim() === ${JSON.stringify(name)}))
      return !!g && !doneG
    })()`, 10, 500)
    assert.ok(backInToday, 'after un-completing the task did not return to the today uncompleted group (or still lingers in the completed group)')
  } finally {
    await cleanup(); cleanupFn = null // W13 2026-10-26: hand the watchdog back (a late fire must not re-run a finished cleanup)
  }
})

test('J3 soft delete → recycle bin shows the task → restore → back in the list', { skip: !available || !isolated }, async () => {
  const name = 'J3 recycle journey ' + Math.random().toString(36).slice(2, 6)
  const ids = []
  // W12 2026-10-26: registered best-effort cleanup for the watchdog (see registerCleanup comment)
  const cleanup = async () => {
    const all = [...(await dbLive().catch(() => [])), ...(await dbBinned().catch(() => []))]
    const mine = all.filter(r => ids.includes(r.taskId)).map(r => r.taskId)
    await hardCleanup([...new Set([...ids, ...mine])])
  }
  registerCleanup(cleanup)
  try {
    const seeded = await seedTask(name)
    assert.ok(seeded && seeded.taskId, 'seeding J3 task failed')
    ids.push(seeded.taskId)
    // Soft delete through the app's own action (the same write path the context menu uses)
    const del = await evalAwait(`(async () => { const s = ${st()}; const t = s.state.todo.todoList.find(x => x.taskId === '${seeded.taskId}'); if (!t) return null; await s.dispatch('todo/deleteTodo', t); await s.dispatch('todo/computeViews'); return 'ok' })()`)
    assert.equal(del, 'ok', 'dispatching todo/deleteTodo failed')
    const binnedRow = await until(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 1 }); return rows.find(r => r.taskId === '${seeded.taskId}') || null })()`, 10, 400)
    assert.ok(binnedRow && binnedRow.delete === true, 'the soft-deleted row is not flagged deleted in the DB')
    // The recycle bin ROUTE — confirmed in renderer/js/router.js: /todo-list/recycle-bin (RecycleBinView)
    await gotoHash('#/todo-list/recycle-bin', '.recycle-page')
    const inBinDom = await until(`[...document.querySelectorAll('.recycle-page .todo-box-list-item')].some(el => el.textContent.includes(${JSON.stringify(name)}))`, 10, 400)
    assert.ok(inBinDom, 'the soft-deleted task is NOT visible in the recycle bin view')
    // Restore via the row's real restore button (first .btn = restore with original date; the task was dated today, so it returns to the today list)
    const restoreClicked = await until(`(() => {
      const row = [...document.querySelectorAll('.recycle-page .todo-box-list-item')].find(el => el.textContent.includes(${JSON.stringify(name)}))
      if (!row) return false
      const btn = row.querySelector('.btn-group .btn')
      if (!btn) return false
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      return true
    })()`, 6, 500)
    assert.ok(restoreClicked, 'no restore button found on the recycle bin row')
    const restoredRow = await until(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); return rows.find(r => r.taskId === '${seeded.taskId}' && r.delete === false) || null })()`, 12, 400)
    assert.ok(restoredRow, 'restore did not clear the delete flag in the DB')
    // USER-VISIBLE: back on the today list
    await gotoHash('#/todo-list/today', '.qa-input')
    const backOnList = await until(`[...document.querySelectorAll('.td-item .td-title')].some(t => t.textContent.trim() === ${JSON.stringify(name)})`, 10, 400)
    assert.ok(backOnList, 'the restored task is not visible back on the today list')
  } finally {
    await cleanup(); cleanupFn = null // W13 2026-10-26: hand the watchdog back (a late fire must not re-run a finished cleanup)
  }
})

test('J4 edit panel rename saves → list reflects the new title → search view finds it by keyword', { skip: !available || !isolated }, async () => {
  const name = 'J4 edit journey ' + Math.random().toString(36).slice(2, 6)
  const keyword = 'J4editkw' + Math.random().toString(36).slice(2, 6)
  const newName = 'J4 edited ' + keyword
  const ids = []
  // W12 2026-10-26: registered best-effort cleanup for the watchdog (see registerCleanup comment)
  const cleanup = async () => {
    const rows = await dbLive().catch(() => [])
    const mine = (rows || []).filter(r => ids.includes(r.taskId)).map(r => r.taskId)
    await hardCleanup([...new Set([...ids, ...mine])])
  }
  registerCleanup(cleanup)
  try {
    const seeded = await seedTask(name)
    assert.ok(seeded && seeded.taskId, 'seeding J4 task failed')
    ids.push(seeded.taskId)
    await gotoHash('#/todo-list/today', '.qa-input')
    const rowSel = `[...document.querySelectorAll('.td-item')].find(el => el.textContent.includes(${JSON.stringify(name)}))`
    assert.ok(await until(`!!(${rowSel})`, 10, 400), 'the seeded J4 row is not visible on the today list')
    // Real click opens the edit panel
    assert.ok(await clickEl(rowSel), 'clicking the task row did not open anything')
    assert.ok(await until(`!!document.querySelector('.edit-panel')`, 8, 400), 'the edit panel did not open after clicking the row')
    // Rename through the title textarea (native setter + input event, then the panel's own flush hook)
    const renamed = await evalAwait(`(async () => {
      const ta = document.querySelector('.edit-panel .ep-title textarea')
      if (!ta) return 'no-textarea'
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, ${JSON.stringify(newName)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 600))
      if (typeof window.__editPanelFlushSave === 'function') await window.__editPanelFlushSave()
      else await new Promise(r => setTimeout(r, 800))
      return 'ok'
    })()`)
    assert.equal(renamed, 'ok', 'the edit panel title textarea was not found')
    const renamedRow = await until(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); return rows.find(r => r.taskId === '${seeded.taskId}' && r.taskContent === ${JSON.stringify(newName)}) || null })()`, 12, 400)
    assert.ok(renamedRow, 'renaming in the edit panel did not persist the new title to the DB')
    // USER-VISIBLE 1: the list shows the new title
    await send('Runtime.evaluate', { expression: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))` })
    await sleep(500)
    const listShowsNew = await until(`[...document.querySelectorAll('.td-item .td-title')].some(t => t.textContent.trim() === ${JSON.stringify(newName)})`, 10, 400)
    assert.ok(listShowsNew, 'the today list does not reflect the renamed title')
    // USER-VISIBLE 2: the search view finds the task by keyword
    await gotoHash('#/todo-list/search', '.main-nav-search__input')
    const searched = await until(`(() => {
      const i = document.querySelector('.main-nav-search__input')
      if (!i) return false
      if (i.value !== ${JSON.stringify(keyword)}) {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(i, ${JSON.stringify(keyword)})
        i.dispatchEvent(new Event('input', { bubbles: true }))
      }
      return [...document.querySelectorAll('.result-list .td-item .td-title')].some(t => t.textContent.trim() === ${JSON.stringify(newName)})
    })()`, 14, 500)
    assert.ok(searched, `the search view does not find the renamed task by keyword "${keyword}"`)
  } finally {
    await cleanup(); cleanupFn = null // W13 2026-10-26: hand the watchdog back (a late fire must not re-run a finished cleanup)
  }
})

// Teardown: close the WS handle so the event loop drains naturally
after(() => { try { ws?.close() } catch {} })
