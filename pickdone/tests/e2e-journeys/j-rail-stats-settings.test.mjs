/**
 * Core user-journey E2E regression — DayRail overload badge / plan chips / stats consistency + settings persistence.
 * Contract: assert USER-VISIBLE outcomes (DOM + DB rows), never code-internal assumptions.
 * Pins, by journey:
 *   J8  today-timeline overload badge caliber — 2026-10-26 fix: only TODAY's planned tomatoes count
 *       (estimate-aware 2+3+6=11 > threshold 10 -> badge; 30 overdue incomplete must NOT count).
 *   J9  timeline plan chip — synthetic DragEvent drop onto .dr-slot -> chip at that hour; X removes with
 *       the 5s undo toast; clicking Undo restores the chip (DOM + plan_chips row).
 *   J10 stats consistency — seeded today focus ledger minutes show up on the statistics KPI;
 *       a boolean settings flip survives a page reload (DB-backed) and the UI reflects it.
 * Structure mirrors tests/e2e.test.mjs (attach gate / isolation gate / fail-loud / watchdog / exit cleanup).
 * Run inside the shared pool: node tests/run-interactions-shared.mjs tests/e2e-journeys/<this file>
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const CDP = process.env.TODO_CDP || 'http://127.0.0.1:9333'

// Isolation gate: the attached instance must use an isolated data dir (TODO_USER_DATA_DIR injected at
// boot, preload exposes isDataIsolated) — this file writes real rows; refuse the real user library.
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

// Fail loud inside the shared pool (skip=green is NOT evidence; see e2e.test.mjs [signal-integrity])
{
  const inPool = process.env.TODO_SHARED_CDP || process.env.TODO_CDP
  if (inPool && (!available || !isolated)) {
    console.error(`[j-rail-stats] ran inside the shared pool but the precondition failed (available=${available}, isolated=${isolated}) — failing loud`)
    process.exitCode = 1
  }
}

// Watchdog: three journeys each do a reload + boot wait; 240s ceiling (pool per-target budget is 8min)
const watchdog = setTimeout(() => { console.error('E2E watchdog forced exit (counted as failure)'); try { ws?.close() } catch {} process.exit(1) }, 240000)
watchdog.unref?.()
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
// Await-style eval: returns the resolved value directly (dbCall/store dispatches need awaitPromise)
const evalAwait = async expression => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: `(${expression})`, returnByValue: true, awaitPromise: true }),
    sleep(20000).then(() => null)
  ])
  if (!r) return null
  if (r.exceptionDetails) throw new Error('page eval failed: ' + ((r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '').slice(0, 300))
  return r.result?.result?.value ?? null
}
// Poll until the expression is truthy (page state settles asynchronously after every action)
const waitFor = async (expression, tries = 15, gap = 500) => {
  for (let i = 0; i < tries; i++) {
    const v = await evalAwait(expression)
    if (v) return v
    await sleep(gap)
  }
  return null
}

const STORE_Q = `(()=>{if(window.appUI&&window.appUI.$store)return window.appUI.$store;const a=document.getElementById('app')&&document.getElementById('app').__vue_app__;const p=a&&a._instance&&a._instance.proxy;if(p&&p.$store)return p.$store;const el=document.querySelector('.app-shell');return (el&&el.__vue__)?el.__vue__.$root.$store:null})()`

// Boot wait: sidebar nav + (when on Today) the day rail, then settle
const waitBoot = async () => {
  for (let i = 0; i < 30; i++) {
    const n = await evalJson('document.querySelectorAll(".sn-nav-item").length')
    if (n > 0) { await sleep(1000); return true }
    await sleep(1000)
  }
  return false
}
// Journey chrome: pin locale surface, retire onboarding/tours, widen the window past the rail's
// 1140px auto-fold breakpoint, clear the persisted rail-collapse preference, then reload.
// (At the pool instance's ~820px default width the whole rail collapses: .dr-head / .dr-plan /
// .dr-load-warn are display:none — every rail assertion below needs the expanded rail.)
const preparePage = async () => {
  await send('Runtime.enable'); await send('Page.enable')
  await send('Runtime.evaluate', { expression: "try{localStorage.setItem('appLocale','en-US');localStorage.setItem('onboardingToursSeen', JSON.stringify({today:1,editpanel:1}));localStorage.removeItem('dayRailCollapsed');localStorage.setItem('todayViewMode','list')}catch(e){}" })
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 0, mobile: false })
  await send('Page.reload')
  assert.ok(await waitBoot(), 'app did not boot within 30s after reload')
}
const gotoToday = async () => {
  await send('Runtime.evaluate', { expression: `location.hash='#/todo-list/today'` })
  const rail = await waitFor(`!!document.querySelector('.day-rail')`, 15, 500)
  assert.ok(rail, 'DayRail did not mount on the Today page within 7.5s')
  // If the rail still starts collapsed (narrow-window auto-fold races), expand it the way a user does
  const collapsed = await evalJson(`!!document.querySelector('.day-rail.collapsed')`)
  if (collapsed) { await evalJson(`document.querySelector('.dr-head')?.click()`); await sleep(400) }
  assert.equal(await evalJson(`!!document.querySelector('.day-rail.collapsed')`), false, 'day rail is collapsed — rail assertions need the expanded timeline')
}

// Deterministic store reload from the DB after direct dbCall seeding
const reloadTodos = () => evalAwait(`(async()=>{const st=(${STORE_Q});if(!st)throw new Error('no store');await st.dispatch('todo/init');return 'ok'})()`)
// Today's day-start ts as the app computes it (DayRail selTs / computeViews `today`)
const today0Expr = `(()=>{const d=new Date();d.setHours(0,0,0,0);return +d})()`

test('J-Rail precondition: connect CDP, isolate gate, pin chrome, boot', { skip: !available ? 'no debug port on ' + CDP : (!isolated ? 'attached instance is NOT data-isolated; refusing writes on real user data' : false) }, async () => {
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
  await preparePage()
})

test('J8: today overload badge counts ONLY today (2+3 est) not overdue backlog; appears >10; clears on cleanup', { skip: !available || !isolated }, async () => {
  const P = 'jr8_'
  const created = []
  let origThreshold = null
  try {
    await gotoToday()
    // Deterministic threshold: the journey pins 10 (the default) and restores whatever it was.
    origThreshold = await evalAwait(`(${STORE_Q}).state.settings.dailyLoadWarnThreshold`)
    if (origThreshold !== 10) {
      await evalAwait(`(async()=>{await (${STORE_Q}).dispatch('settings/update',{dailyLoadWarnThreshold:10});return 'ok'})()`)
      await sleep(500)
    }
    const th = await evalAwait(`(${STORE_Q}).state.settings.dailyLoadWarnThreshold`)
    assert.equal(th, 10, 'load-warn threshold should be 10 for this journey')

    // Seed: 2 today tasks with estimates 2+3 (=5 planned), 30 overdue incomplete (backlog that must NOT count)
    const seed = await evalAwait(`(async()=>{
      const t0=${today0Expr}; const now=Date.now(); const over=t0-2*86400000
      const rows=[]
      // todoTime must ride along: db-rows.js only honors a caller-carried dayStart when todoTime is set,
      // otherwise scheduledDay lands 0 and the row falls into the no-date bucket
      const mk=(id,ds)=>({taskId:id,taskContent:'${P}'+id,todoTime:ds,dayStart:ds,createTime:now,updateTime:now,complete:false,delete:false})
      rows.push(mk('${P}a1',t0)); rows.push(mk('${P}a2',t0))
      for(let i=0;i<30;i++) rows.push(mk('${P}o'+i,over))
      await window.todoAPI.dbCall('upsertMany',rows)
      // Estimates: the app's own dual write — per-task meta key (syncable unit) + LS reactive cache
      await window.todoAPI.dbCall('setMeta',['tomatoEstimateState:${P}a1','2'])
      await window.todoAPI.dbCall('setMeta',['tomatoEstimateState:${P}a2','3'])
      try{localStorage.setItem('tomatoEstimateState',JSON.stringify({'${P}a1':2,'${P}a2':3}));localStorage.setItem('tomatoEstimateStateAt',String(now))}catch(e){}
      return rows.length
    })()`)
    created.push(...Array.from({ length: 32 }, (_, i) => i < 2 ? `${P}a${i + 1}` : `${P}o${i - 2}`))
    assert.equal(seed, 32, 'seeding did not write all 32 rows')

    // Fresh document so the estimate module state matches what a user booting now would see
    await send('Page.reload')
    assert.ok(await waitBoot(), 'app did not boot after J8 seeding reload')
    await gotoToday()
    // Views must see exactly the 2 today tasks; the DB must hold all rows (double assertion)
    const views1 = await waitFor(`(()=>{const st=(${STORE_Q});const s=st&&st.state.todo;if(!s||!s.loaded)return null;return {today:(s.views.todayTodoList||[]).length}})()`, 15, 500)
    assert.ok(views1 && views1.today === 2, `views.todayTodoList should hold exactly the 2 today tasks, got ${views1 && views1.today}`)
    const db1 = await evalAwait(`window.todoAPI.dbCall('getAll',{}).then(rs=>rs.filter(t=>t.taskId&&t.taskId.startsWith('${P}')).length)`)
    assert.equal(db1, 32, 'DB rows missing after seeding')
    const est = await evalAwait(`window.todoAPI.dbCall('getMeta','tomatoEstimateState:${P}a1')`)
    assert.equal(est, '2', 'estimate meta key did not land')

    // THE PIN (2026-10-26 过载 132/10 fix): 5 planned ≤ 10 -> NO badge, even with 30 overdue incomplete.
    // The pre-fix caliber concat'd views.recent.expiredUncompleted into the planned load and screamed forever.
    await sleep(1500)
    const badge1 = await evalAwait(`(()=>{const w=document.querySelector('.day-rail .dr-load-warn');return w?w.textContent.trim():null})()`)
    assert.equal(badge1, null, `overload badge must NOT appear when today's planned load (5) ≤ threshold 10 — 30 overdue incomplete leaked into the caliber, badge="${badge1}"`)

    // +6 today tasks (no estimate -> 1 slot each) -> planned 11 > 10 -> badge appears
    await evalAwait(`(async()=>{
      const t0=${today0Expr}; const now=Date.now()
      const rows=[]; for(let i=0;i<6;i++) rows.push({taskId:'${P}b'+i,taskContent:'${P}b'+i,todoTime:t0,dayStart:t0,createTime:now,updateTime:now,complete:false,delete:false})
      await window.todoAPI.dbCall('upsertMany',rows); return rows.length
    })()`)
    created.push(...Array.from({ length: 6 }, (_, i) => `${P}b${i}`))
    await reloadTodos()
    const badge2 = await waitFor(`(()=>{const w=document.querySelector('.day-rail .dr-load-warn');return w?w.textContent.trim():null})()`, 15, 500)
    assert.ok(badge2 && /11\s*\/\s*10/.test(badge2), `overload badge should read "11/10" once planned (11) > threshold (10), got "${badge2}"`)
  } finally {
    // Self-cleanup: hard-delete every row we created, drop our estimate meta keys, restore the threshold
    if (created.length) {
      await evalAwait(`(async()=>{await window.todoAPI.dbCall('hardDeleteMany',${JSON.stringify(created)});return 'ok'})()`).catch(() => {})
      for (const tid of ['a1', 'a2']) await evalAwait(`window.todoAPI.dbCall('deleteMeta','tomatoEstimateState:${P}${tid}')`).catch(() => {})
      // LS reactive cache must be swept too — the DB meta delete alone leaves our ids inside the
      // localStorage tomatoEstimateState blob for every later pool target
      await evalAwait(`(()=>{try{const c=JSON.parse(localStorage.getItem('tomatoEstimateState')||'{}');for(const k of Object.keys(c))if(k.startsWith('${P}'))delete c[k];localStorage.setItem('tomatoEstimateState',JSON.stringify(c));localStorage.setItem('tomatoEstimateStateAt',String(Date.now()))}catch(e){}return 'ok'})()`).catch(() => {})
    }
    if (origThreshold !== null && origThreshold !== 10) {
      await evalAwait(`(async()=>{await (${STORE_Q}).dispatch('settings/update',{dailyLoadWarnThreshold:${JSON.stringify(origThreshold)}});return 'ok'})()`).catch(() => {})
    }
    await reloadTodos().catch(() => {})
    const left = await evalAwait(`window.todoAPI.dbCall('getAll',{}).then(rs=>rs.filter(t=>t.taskId&&t.taskId.startsWith('${P}')).length)`).catch(() => -1)
    assert.equal(left, 0, 'J8 cleanup left rows behind (would pollute later targets)')
    const badge3 = await evalAwait(`(()=>{const w=document.querySelector('.day-rail .dr-load-warn');return w?w.textContent.trim():null})()`).catch(() => 'eval-error')
    assert.equal(badge3, null, `overload badge should disappear after cleanup, got "${badge3}"`)
  }
})

test('J9: timeline plan chip — drag task onto an hour slot, remove via chip X, undo restores it', { skip: !available || !isolated }, async () => {
  const P = 'jr9_'
  const taskId = P + 'chip'
  let chipId = null
  try {
    await gotoToday()
    // Seed one today task through the DB, reload the store so the rail's task pool has it
    await evalAwait(`(async()=>{const t0=${today0Expr};const now=Date.now();
      await window.todoAPI.dbCall('upsertMany',[{taskId:'${taskId}',taskContent:'${taskId}',todoTime:t0,dayStart:t0,createTime:now,updateTime:now,complete:false,delete:false}]);return 'ok'})()`)
    await reloadTodos()
    const inPool = await waitFor(`(()=>{const st=(${STORE_Q});return !!(st&&st.state.todo.todoList.some(t=>t.taskId==='${taskId}'))})()`, 10, 400)
    assert.ok(inPool, 'seeded task not visible in the store after todo/init')

    // Real drag gesture semantics: a synthetic DragEvent carrying the taskId, dropped onto the 09:00 slot
    const dropped = await evalAwait(`(()=>{
      const dt=new DataTransfer(); dt.setData('text/plain','${taskId}')
      const slot=document.querySelector('.day-rail .dr-slot[data-vrange="540:60"]')
      if(!slot) return 'no-slot'
      slot.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}))
      slot.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))
      return 'ok'
    })()`)
    assert.equal(dropped, 'ok', 'no 09:00 .dr-slot rendered — cannot deliver the drop')
    // Chip appears at that hour (user-visible) AND as a plan_chips row (DB)
    const chip = await waitFor(`(()=>{
      const slot=document.querySelector('.day-rail .dr-slot[data-vrange="540:60"]'); if(!slot) return null
      const el=slot.querySelector('.dr-plan'); if(!el) return null
      return {name:(el.querySelector('.dr-plan-name')||{textContent:''}).textContent.trim(), inSlot:!!slot.querySelector('.dr-plan')}
    })()`, 15, 400)
    assert.ok(chip, 'plan chip did not appear in the 09:00 slot after the drop')
    assert.ok(chip.name && chip.name.includes(taskId), `chip name should be the seeded task, got "${chip.name}"`)
    chipId = await waitFor(`window.todoAPI.dbCall('planAll',[]).then(rs=>{const r=rs.find(x=>x.taskId==='${taskId}');return r?r.id:null})`, 10, 400)
    assert.ok(chipId, 'plan_chips row missing after the drop (chip was DOM-only)')
    const chipRow = await evalAwait(`window.todoAPI.dbCall('planAll',[]).then(rs=>{const r=rs.find(x=>x.taskId==='${taskId}');return r?r.day+'/'+r.mm:null})`)
    const todayKey = await evalAwait(`(()=>{const d=new Date();const p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())})()`)
    assert.equal(chipRow, todayKey + '/09:00', `chip row should be today 09:00, got "${chipRow}"`)

    // Chip X = remove with the 5s undo toast; chip leaves the DOM
    const xClicked = await evalAwait(`(()=>{const slot=document.querySelector('.day-rail .dr-slot[data-vrange="540:60"]');const x=slot&&slot.querySelector('.dr-plan-x');if(!x)return false;x.click();return true})()`)
    assert.ok(xClicked, 'chip X button not found')
    const gone = await waitFor(`!document.querySelector('.day-rail .dr-slot[data-vrange="540:60"] .dr-plan')`, 10, 300)
    assert.ok(gone, 'chip still visible after clicking X')
    const toast = await evalAwait(`(()=>{const m=document.querySelector('.el-message');if(!m)return null;const a=m.querySelector('a[role="button"]');return a?a.textContent.trim():null})()`)
    assert.ok(toast, 'no undo toast with an undo action after chip removal')

    // Click Undo within the 5s grace window -> chip restored in DOM and DB
    const undone = await evalAwait(`(()=>{const m=document.querySelector('.el-message');const a=m&&m.querySelector('a[role="button"]');if(!a)return false;a.click();return true})()`)
    assert.ok(undone, 'could not click the undo link on the toast')
    const back = await waitFor(`(()=>{const slot=document.querySelector('.day-rail .dr-slot[data-vrange="540:60"]');const el=slot&&slot.querySelector('.dr-plan');return el?(el.querySelector('.dr-plan-name')||{textContent:''}).textContent.trim():null})()`, 12, 400)
    assert.ok(back && back.includes(taskId), `chip did not come back after undo, got "${back}"`)
    const rowBack = await waitFor(`window.todoAPI.dbCall('planAll',[]).then(rs=>!!rs.find(x=>x.taskId==='${taskId}'))`, 10, 400)
    assert.ok(rowBack, 'plan_chips row not restored in the DB after undo')
  } finally {
    await evalAwait(`window.todoAPI.dbCall('planAll',[]).then(rs=>{const ids=rs.filter(x=>x.taskId==='${taskId}').map(x=>x.id);return ids.length?window.todoAPI.dbCall('planRemoveIds',ids):0})`).catch(() => {})
    await evalAwait(`window.todoAPI.dbCall('hardDeleteMany',['${taskId}'])`).catch(() => {})
    await reloadTodos().catch(() => {})
    const leftTask = await evalAwait(`window.todoAPI.dbCall('getAll',{}).then(rs=>rs.filter(t=>t.taskId==='${taskId}').length)`).catch(() => -1)
    const leftChip = await evalAwait(`window.todoAPI.dbCall('planAll',[]).then(rs=>rs.filter(x=>x.taskId==='${taskId}').length)`).catch(() => -1)
    assert.equal(leftTask, 0, 'J9 cleanup left the task row behind')
    assert.equal(leftChip, 0, 'J9 cleanup left the plan chip row behind')
  }
})

test('J10: statistics reflect seeded today focus minutes; a settings boolean flip persists across reload', { skip: !available || !isolated }, async () => {
  const tIds = ['tmt_jr10_a', 'tmt_jr10_b']
  let origDevMode = null
  try {
    // Seed today's focus ledger: 30 + 60 = 90 minutes, ended 10 minutes ago (unattached free focus)
    const seeded = await evalAwait(`(async()=>{
      const now=Date.now(); const end=now-10*60000
      const dk=(()=>{const d=new Date(end);const p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())})()
      const rows=[{tomatoId:'${tIds[0]}',endTime:end,focus:'',focusTaskId:null,focusDuration:30,rest:0,restDuration:0,succeed:1,manual:1,status:'local',dateKey:dk},
                  {tomatoId:'${tIds[1]}',endTime:end,focus:'',focusTaskId:null,focusDuration:60,rest:0,restDuration:0,succeed:1,manual:1,status:'local',dateKey:dk}]
      const r=await window.todoAPI.dbCall('tomatoAppendMany',rows)
      const st=(${STORE_Q}); if(st) await st.dispatch('tomato/recordsReload')
      return r&&r.accepted!=null?r.accepted:rows.length
    })()`)
    assert.equal(Number(seeded), 2, 'tomatoAppendMany did not accept both ledger rows')
    // DB double-assert: the ledger really holds 90 today-minutes for our ids
    const dbMins = await evalAwait(`window.todoAPI.dbCall('tomatoAll',[]).then(rs=>rs.filter(r=>${JSON.stringify(tIds)}.includes(r.tomatoId)).reduce((s,r)=>s+(Number(r.focusDuration)||0),0))`)
    assert.equal(dbMins, 90, 'seeded focus minutes missing from the ledger')

    // Statistics page: the focus-time KPI must show at least the seeded minutes (thisWeek includes today)
    await send('Runtime.evaluate', { expression: `location.hash='#/todo-list/statistics'` })
    const kpi = await waitFor(`(()=>{
      const tiles=[...document.querySelectorAll('.stat-page .kpi-tile')]
      const f=tiles.map(t=>({title:(t.querySelector('.kpi-tile__title')||{textContent:''}).textContent.trim(),value:(t.querySelector('.kpi-tile__value')||{textContent:''}).textContent.trim()}))
      const m=f.find(x=>/min$/.test(x.value))||null
      return m?{...m,count:tiles.length}:null
    })()`, 20, 500)
    assert.ok(kpi, 'no focus-minutes KPI tile rendered on the statistics page')
    const shown = parseInt(kpi.value, 10)
    assert.ok(Number.isFinite(shown) && shown >= 90, `focus KPI should show ≥ 90min for the seeded ledger, got "${kpi.value}"`)

    // Settings persistence journey: flip a boolean through the real settings modal UI
    origDevMode = await evalAwait(`(${STORE_Q}).state.settings.developerMode`)
    const opened = await waitFor(`(()=>{const g=document.querySelector('.sn-account-gear:not(.sn-account-trash)');if(!g)return false;g.click();return true})()`) &&
      await waitFor(`!!document.querySelector('.modal--settings, .modal-container--settings')`, 10, 500)
    assert.ok(opened, 'settings modal did not open')
    // Locate the developer-mode switch by its real label (i18n-resolved), like a user reads it
    const flipped = await evalAwait(`(()=>{
      const t=(document.querySelector('#app').__vue_app__.config.globalProperties.$t)('statsE.SettingsModal.sDev')
      const items=[...document.querySelectorAll('.modal--settings .form-item, .modal-container--settings .form-item')]
      const it=items.find(x=>((x.querySelector('.form-item__label')||{textContent:''}).textContent.trim())===t)
      if(!it) return 'no-item:'+t
      const sw=it.querySelector('.el-switch'); if(!sw) return 'no-switch'
      sw.click(); return 'ok'
    })()`)
    assert.equal(flipped, 'ok', 'developer-mode switch not found/clickable in the settings modal')
    await sleep(600)
    const after = await evalAwait(`(${STORE_Q}).state.settings.developerMode`)
    assert.equal(after, !(origDevMode === true), `flip did not reach the settings store (before=${origDevMode}, after=${after})`)
    await evalAwait(`(()=>{const x=document.querySelector('.modal--settings .modal__close, .modal-container--settings .modal__close');if(!x)return false;x.click();return true})()`)
    await sleep(500)
    assert.equal(await evalAwait(`!document.querySelector('.modal--settings, .modal-container--settings')`), true, 'settings modal did not close')

    // Reload: the flip must survive (settings rows are DB-backed) and the UI must reflect it
    await send('Page.reload')
    assert.ok(await waitBoot(), 'app did not boot after the J10 settings reload')
    // W11 2026-10-26: stringly sentinel — the old `v===(v===true)?v:null` returned `false` for a
    // legit persisted false, which waitFor treats as falsy and polls to exhaustion (null → false
    // failure) whenever the original developerMode was true. 'true'/'false' are both truthy probe
    // returns, so the poll settles on the FIRST real persisted value instead of burning its budget.
    const persisted = await waitFor(`(()=>{const v=(${STORE_Q}).state.settings.developerMode;return v===true?'true':(v===false?'false':null)})()`, 10, 500)
    const expectedPersisted = !(origDevMode === true) ? 'true' : 'false'
    assert.equal(persisted, expectedPersisted, `developer-mode flip did not persist across reload (expected ${expectedPersisted}, got ${persisted})`)
    const opened2 = await evalAwait(`(()=>{const g=document.querySelector('.sn-account-gear:not(.sn-account-trash)');if(!g)return false;g.click();return true})()`)
    assert.ok(opened2, 'could not reopen settings modal')
    await waitFor(`!!document.querySelector('.modal--settings, .modal-container--settings')`, 10, 500)
    const uiOn = await waitFor(`(()=>{
      const t=(document.querySelector('#app').__vue_app__.config.globalProperties.$t)('statsE.SettingsModal.sDev')
      const items=[...document.querySelectorAll('.modal--settings .form-item, .modal-container--settings .form-item')]
      const it=items.find(x=>((x.querySelector('.form-item__label')||{textContent:''}).textContent.trim())===t)
      const sw=it&&it.querySelector('.el-switch')
      return sw?sw.classList.contains('is-checked'):null
    })()`, 10, 500)
    assert.equal(uiOn, !(origDevMode === true), 'settings UI switch state does not reflect the persisted value after reload')
    await evalAwait(`(()=>{const x=document.querySelector('.modal--settings .modal__close, .modal-container--settings .modal__close');if(x)x.click();return true})()`)
  } finally {
    // Restore: original developer mode, remove the seeded ledger rows
    if (origDevMode !== null) {
      await evalAwait(`(async()=>{await (${STORE_Q}).dispatch('settings/update',{developerMode:${origDevMode === true}});return 'ok'})()`).catch(() => {})
      // W11 2026-10-26: the restore used to sit in a bare .catch(()=>{}) with NO verification —
      // a failed restore leaves developerMode flipped in db settings for the 4 later pool targets.
      // Read back and fail loudly on mismatch.
      const restoredVal = await evalAwait(`(${STORE_Q}).state.settings.developerMode`).catch(() => null)
      assert.equal(restoredVal, origDevMode === true, `J10 restore FAILED: developerMode is ${restoredVal} but the pre-journey value was ${origDevMode === true} — this contaminates every later pool target`)
    }
    await evalAwait(`window.todoAPI.dbCall('tomatoRemoveByIds',${JSON.stringify(tIds)})`).catch(() => {})
    await evalAwait(`(async()=>{const st=(${STORE_Q});if(st)await st.dispatch('tomato/recordsReload');return 'ok'})()`).catch(() => {})
    const left = await evalAwait(`window.todoAPI.dbCall('tomatoAll',[]).then(rs=>rs.filter(r=>${JSON.stringify(tIds)}.includes(r.tomatoId)).length)`).catch(() => -1)
    assert.equal(left, 0, 'J10 cleanup left seeded ledger rows behind')
    await send('Runtime.evaluate', { expression: `location.hash='#/todo-list/today'` })
    await sleep(800)
  }
})

// Teardown: clear our viewport override so it cannot leak into the next pool target, close the WS
after(async () => {
  try { await send('Emulation.clearDeviceMetricsOverride') } catch {}
  try { ws?.close() } catch {}
})
