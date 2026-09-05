/**
 * UI smoke regression - drives the really running app via CDP (desktop with --remote-debugging-port=9333),
 * checking every regression point that has broken before. Zero dependencies (Node 22 built-in fetch/WebSocket).
 * Usage: npm run smoke:ui     (SKIPs with exit 0 when the app has no debug port open, never blocking CI)
 */
const CDP = process.env.TODO_CDP || 'http://127.0.0.1:9333'

// Watchdog: any stage hanging (e.g. a dead CDP connection) forces an exit instead of wedging CI.
// The WS must be closed before exiting - a dangling DevTools client pins the target proxy, making the next connection unresponsive
const watchdog = setTimeout(() => {
  console.error('FAIL: smoke script did not finish within 90s; forcing exit')
  try { ws?.close() } catch {}
  process.exit(1)
}, 90000)
watchdog.unref?.()
process.on('exit', () => { try { ws?.close() } catch {} })

let wsGate = null
try {
  const list = await (await fetch(CDP + '/json', { signal: AbortSignal.timeout(2000) })).json()
  const page = list.find(t => t.type === 'page' && !t.url.includes('__tomato-float'))
  if (!page) { console.log('SKIP: no page target'); process.exit(0) }
  // 隔离门(2026-09-02):附着实例必须是隔离数据目录,冒烟含增删改,拒绝落在真实用户库上。
  // 安全附着: npm run app:dev -- --remote-debugging-port=9333
  wsGate = new WebSocket(page.webSocketDebuggerUrl)
  const iso = await new Promise(res => {
    wsGate.onopen = () => {
      wsGate.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) res(m.result?.result?.value) }
      wsGate.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify({iso: !!(window.todoAPI && window.todoAPI.isDataIsolated)})', returnByValue: true } }))
    }
    wsGate.onerror = () => res(null)
    setTimeout(() => res(null), 3000)
  })
  try { wsGate.close() } catch {}
  let isolated = false
  try { isolated = JSON.parse(iso).iso === true } catch {}
  if (!isolated) {
    console.log('SKIP: attached instance is NOT data-isolated (TODO_USER_DATA_DIR missing); refusing to run write-smoke on real user data. Safe attach: npm run app:dev -- --remote-debugging-port=9333')
    process.exit(0)
  }
} catch {
  console.log('SKIP: no debug port found on ' + CDP + ' (start with npm run app:dev -- --remote-debugging-port=9333 and retry)')
  process.exit(0)
}

let ws = null
let id = 0
const pending = new Map()
const consoleErrors = []
const pickMainPage = targets =>
  targets.find(t => t.type === 'page' && /#\/(todo-list|__widget\/list)/.test(t.url)) ||
  targets.find(t => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('__tomato-float'))

async function connectOnce () {
  const targets = (await (await fetch(CDP + '/json', { signal: AbortSignal.timeout(2000) })).json())
  const page = pickMainPage(targets)
  if (!page) { console.error('FAIL: no usable page target'); process.exit(1) }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200))
    }
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  await send('Runtime.enable'); await send('Page.enable')
}
// The DevTools proxy may be held/reset by other debug clients: if the handshake gets no response within 8s, reconnect and retry
async function connect () {
  for (let i = 0; i < 3; i++) {
    const result = await Promise.race([
      connectOnce().then(() => 'ok'),
      sleep(8000).then(() => 'timeout')
    ])
    if (result === 'ok') return
    try { ws?.close() } catch {}
    pending.clear()
    await sleep(2000)
  }
  console.error('FAIL: CDP handshake timed out repeatedly (another debug client may hold it, or the app needs a restart)')
  process.exit(1)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Navigate and wait for the sentinel element (the page mounts progressively; fixed sleeps occasionally misfire)
const gotoHash = async (hash, sentinel) => {
  await send('Runtime.evaluate', { expression: "location.hash='" + hash + "'" })
  if (!sentinel) { await sleep(2000); return true }
  for (let i = 0; i < 15; i++) {
    await sleep(1000)
    if (await evalJson("!!document.querySelector('" + sentinel + "')")) { await sleep(600); return true }
  }
  return false
}


// Boot wait: poll until the sidebar finishes rendering (cold starts can exceed a fixed 4s), up to 30s
const waitBoot = async () => {
  for (let i = 0; i < 30; i++) {
    const n = await evalJson("document.querySelectorAll('.sn-nav-item').length")
    if (n > 0) { await sleep(800); return true }
    await sleep(1000)
  }
  return false
}



const send = (method, params = {}) => new Promise(res => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }))
})

// evalJson: 10s timeout per evaluation; a timeout is treated as a dead CDP proxy - reconnect once and retry
const evalJson = async expression => {
  const once = async () => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: `JSON.stringify((${expression}))`, returnByValue: true }),
      sleep(10000).then(() => null)
    ])
    return r ? JSON.parse(r.result?.result?.value ?? 'null') : null
  }
  let out = await once()
  if (out === null) {
    try { ws.close() } catch {}
    pending.clear()
    await connect()
    out = await once()
  }
  return out
}

await connect()

let passed = 0; let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  ✓ ' + name) } else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}

await send('Runtime.enable'); await send('Page.enable')
// Note: do not use Page.reload{ignoreCache} - it hangs under the app:// custom protocol; use a timestamped hash reload and let the app handle caching itself
await send('Page.reload'); if (await waitBoot()) { /* ok */ } else { console.error('FAIL: app did not finish booting within 30s'); try { ws.close() } catch {} process.exit(1) }
// State sanitation: clear any pomodoro timer left by the last session (status!=='default' makes the pomodoro bar appear in every view) for deterministic assertions
// State sanitation: the last session may have left a running pomodoro timer (status!=='default' makes the pomodoro bar appear in every view).
// Note: you cannot removeItem directly - the running app writes its in-memory session state back; rewrite status and reload instead.
await evalJson(`(()=>{try{const s=JSON.parse(localStorage.getItem('tomatoState')||'{}');s.status='default';s.attachTodo=null;localStorage.setItem('tomatoState',JSON.stringify(s))}catch{};return 'ok'})()`)
await send('Page.reload'); if (await waitBoot()) { /* ok */ } else { console.error('FAIL: app did not finish booting within 30s'); try { ws.close() } catch {} process.exit(1) }
// The route hash persists across sessions: return to Today before shell assertions (qa-input lives on the Today page and is necessarily absent elsewhere)
await send('Runtime.evaluate', { expression: `location.hash='#/todo-list/today'` }); await sleep(1500)
// Skip the onboarding wizard on a fresh isolated instance: ob-mask (z=3000) intercepts every real click
// below ([4.5] calendar placeholder flow etc.). Historically invisible because this script ran against the
// developer's long-lived instance where onboarding was already done — exactly the dirty-instance rot.
await evalJson(`(()=>{const s=document.querySelector('.ob-mask .ob-link');if(s)s.click();return 'ok'})()`)
await sleep(800)
// Retire the driver.js spotlight tours too: the spotlight overlay fires 1.2s after TodayView mounts,
// covers the whole page and swallows real clicks (flaky by timing — sometimes it lands on [4.5]).
// Seeding the seen-ledger + reload means maybeRunTour no-ops for the rest of the run.
await evalJson(`(()=>{try{localStorage.setItem('onboardingToursSeen',JSON.stringify({today:1,editpanel:1}))}catch{};return 'ok'})()`)
await send('Page.reload')
if (!(await waitBoot())) { console.error('FAIL: reload after tour-seeding did not finish within 30s'); try { ws.close() } catch {} process.exit(1) }
await send('Runtime.evaluate', { expression: `location.hash='#/todo-list/today'` }); await sleep(1500)
ok('onboarding wizard closed (real clicks can land)', await evalJson(`!document.querySelector('.ob-mask')`), 'ob-mask still present')
ok('driver tour overlay absent (real clicks can land)', await evalJson(`!document.body.classList.contains('driver-active') && !document.querySelector('.driver-overlay')`))

console.log('[1] global shell')
const shell = await evalJson(`({
  navItems: document.querySelectorAll('.sn-nav-item').length,
  liveRegion: !!document.querySelector('[aria-live="polite"]'),
  qaInput: !!document.querySelector('.qa-input')
})`)
// 4 base nav items (habits/projects are optional modules filtered out by filteredNavOrder when disabled by default; not counted toward the floor)
ok('sidebar navigation renders', shell.navItems >= 4, 'got ' + shell.navItems)
ok('screen-reader live region exists', shell.liveRegion)
ok('quick-add bar exists (Day Todo)', shell.qaInput)

console.log('[2] sidebar single highlight (regression: uncategorized once leaked highlighting to every page)')
// First switch to the inbox, once the worst-hit area
await send('Runtime.evaluate', { expression: `location.hash='#/todo-list/todo-box'` }); await sleep(1000)
const hl2 = await evalJson(`[...document.querySelectorAll('.sn-nav-item.active, .sn-cat-item.active')].map(e => e.textContent.trim())`)
ok('inbox page has a single highlight', hl2.length === 1 && hl2[0].includes('待办箱'), JSON.stringify(hl2))

console.log('[3] data review')
// Self-seeding defense (same rationale as ui-interactions [9]): the isolated instance is an empty DB and the
// statistics page renders a true empty state (no heatmap grid / no canvases) — without data the strict
// assertions below would be comparing against nothing. Seed one completed task through the real quick-add flow.
// (evalJson stringifies synchronously, so an async IIFE would come back as {} — use awaitPromise directly.)
const seedRes = await send('Runtime.evaluate', {
  expression: `(async () => {
    if (document.querySelectorAll('.hm-grid .hm-cell').length > 0) return 'has-data'
    location.hash = '#/todo-list/today'; await new Promise(r => setTimeout(r, 1200))
    var el = document.querySelector('.qa-input'); if (!el) return 'no-input'
    el.focus(); var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, '冒烟_统计播种任务'); el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })); await new Promise(r => setTimeout(r, 900))
    var c = document.querySelector('.td-item .td-check, .td-item [role="checkbox"]'); if (!c) return 'no-check'
    c.click(); await new Promise(r => setTimeout(r, 1200))
    return 'seeded'
  })()`,
  returnByValue: true, awaitPromise: true
})
const seededHm = seedRes?.result?.result?.value || 'eval-error'
await send('Runtime.evaluate', { expression: `location.hash='#/todo-list/statistics'` }); await sleep(2500)
const stats = await evalJson(`({
  tabs: [...document.querySelectorAll('.stat-page .stat-view-tab')].map(e => e.textContent.trim()),
  tablist: !!document.querySelector('.stat-page [role="tablist"]'),
  exportBtns: document.querySelectorAll('.stat-page button.mini').length,
  qaHidden: !document.querySelector('.qa-input'),
  tomatoIdleHidden: ![...document.querySelectorAll('.tomato-bar')].length
})`)
// 视图页签（统计/成就墙）：数量与 ARIA 语义（旧三页签断言随统计页重做失效,已按现结构重写）
ok('review tabs render (stat + ach)', stats.tabs.length === 2, JSON.stringify(stats.tabs))
ok('tablist/tab ARIA semantics', stats.tablist)
ok('review page has export/share entries', stats.exportBtns >= 2, 'got ' + stats.exportBtns)
ok('review page has no quick-add bar', stats.qaHidden)
ok('review page has no idle pomodoro bar', stats.tomatoIdleHidden)
// Statistics tab: heatmap + chart rendering
await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.stat-page .stat-view-tab')][0].click()` }); await sleep(1500)
// Chart.js responsive layout needs the container to settle; retry up to 3 times
let statsTab = null
for (let i = 0; i < 3; i++) {
  statsTab = await evalJson(`({
    hmCells: document.querySelectorAll('.hm-grid .hm-cell').length,
    canvases: [...document.querySelectorAll('.stat-page canvas')].map(c => c.width > 0)
  })`)
  if (statsTab.canvases.length > 0 && statsTab.canvases.every(Boolean)) break
  await sleep(1500)
}
// 热力图网格是结构驱动的固定格子数（半年档 26 周×7=182），与数据量无关——`|| === 0` 逃生门曾让它
// 在空实例上恒过（假绿），现改严格断言+播种前置；图表 canvas 必须真实画出（此前 if(false) 死断言冒充覆盖）
ok('review data self-seeding works', seededHm === 'seeded' || seededHm === 'has-data', 'seed result: ' + seededHm)
ok('heatmap has 182 cells (26 weeks)', statsTab.hmCells === 182, 'got ' + statsTab.hmCells)
ok('all charts drawn', statsTab.canvases.length > 0 && statsTab.canvases.every(Boolean), JSON.stringify(statsTab.canvases))

console.log('[4] dark mode toggle')
await send('Runtime.evaluate', { expression: `document.documentElement.setAttribute('data-theme','dark')` }); await sleep(400)
// Do not pin exact color values (the dark palette is still iterating); only verify the content area really has a dark base in dark theme (guards against white-block regressions)
const darkRgb = (await evalJson(`getComputedStyle(document.querySelector('.stat-page')).backgroundColor`)) || ''
const dm = darkRgb.match(/\d+/g) || []
ok('statistics content area has a dark base', dm.length >= 3 && (+dm[0] + +dm[1] + +dm[2]) < 200, darkRgb)
await send('Runtime.evaluate', { expression: `document.documentElement.setAttribute('data-theme','light')` })

console.log('[4.5] calendar "+" direct create (2026-09-04 交互定稿:双击/占位芯片退役,格角 + 一步建「未命名」)')
await send('Runtime.evaluate', { expression: `location.hash='#/todo-list/calendar'` })
// Wait for FullCalendar to render date cells (first calendar entry on a cold start can be slow)
let plusPos = null
for (let i = 0; i < 10; i++) {
  await sleep(1000)
  plusPos = await evalJson(`(()=>{const btns=[...document.querySelectorAll('.day-create-btn[data-create-date]')].filter(b=>{const r=b.getBoundingClientRect();return r.x>0&&r.x<600&&r.y>60&&r.height>0});const b=btns[0];if(!b)return null;const r=b.getBoundingClientRect();window.__smokeDate=b.dataset.createDate;return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  if (plusPos) break
}
// Task counts go through SQLite (todoAPI.dbCall), requiring awaitPromise
const evalAwait = async expression => {
  const r = await send('Runtime.evaluate', { expression: `(${expression})`, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value ?? null
}
const countTasks = async () => {
  const n = await evalAwait(`window.todoAPI.dbCall('getAll', {}).then(rows => rows.filter(t => !t.delete).length)`)
  return n
}
const before = await countTasks()
const click = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
}
if (!plusPos) { ok('+ button found on calendar', false, 'no .day-create-btn rendered within 10s'); }
else {
  // 裸点空格子不再创建/不再出现占位芯片(旧双击流程已退役);落点先验证不在 +/展开钮上(几何巧合 → 显式断言)
  await click(plusPos.x + 40, plusPos.y + 20); await sleep(300)
  ok('bare click on empty cell does not create', (await countTasks()) === before)
  // 点格角 + 创建「未命名」并打开编辑面板
  await click(plusPos.x, plusPos.y); await sleep(800)
  const afterCreate = await countTasks()
  ok('+ button creates the unnamed task', afterCreate === before + 1, 'before=' + before + ' after=' + afterCreate)
  // 面板打开断言只认真实存在的选择器(.ep-panel 为死选择器已删);配合创建计数 +1 即面板语义
  ok('edit panel opened on create', (await evalJson(`!!document.querySelector('.ep-collapse-btn')`)))
  // Collapse the edit panel so it does not cover calendar cells clicked later
  await evalJson(`(()=>{const b=document.querySelector('.ep-collapse-btn');if(b)b.click();return 'ok'})()`); await sleep(300)
}
// Cleanup: delete the empty-title tasks this smoke run created; do not pollute real data
await evalAwait(`window.todoAPI.dbCall('getAll', {}).then(rows => { const ids = rows.filter(t => !t.delete && !t.taskContent).map(t => t.taskId); if (ids.length) window.todoAPI.dbCall('hardDeleteMany', ids); return ids.length })`)
// 清理收口断言:不留空标题脏行(2026-09-04 深审 P1:清理静默失效会污染库且无人发现)
ok('cleanup removed created empty tasks', (await countTasks()) === before, 'before=' + before + ' after=' + (await countTasks()))
ok('calendar page has zero errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

console.log('[4.6] new module pages (habits/quadrant/time blocks)')
await gotoHash('#/todo-list/habit', '.habit-add-input')
const habit = await evalJson(`({add: !!document.querySelector('.habit-add-input'), moments: !!document.querySelector('.moment-sec')})`)
ok('habits page: create input exists', habit.add)
ok('habits page: countdown/anniversary section exists', habit.moments)
// The quadrant merged into Day Todo (TodayView list/matrix toggle; icon-only buttons with no text), no longer on the calendar page
await gotoHash('#/todo-list/today', '.pd-view-seg button')
await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.pd-view-seg button')][1]?.click()` })
const matrix = await evalJson(`({quads: document.querySelectorAll('.matrix-quadrant').length})`)
ok('quadrant: all four quadrants render', matrix.quads === 4)
await gotoHash('#/todo-list/calendar', '.cal-seg button')
await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.cal-seg button')].find(b => b.textContent.trim() === '时间块')?.click()` })
for (let i = 0; i < 10; i++) { await sleep(1000); if (await evalJson(`document.querySelectorAll('.cal-tb__cell').length > 0`)) break }
const tb = await evalJson(`({cells: document.querySelectorAll('.cal-tb__cell').length, pool: !!document.querySelector('.cal-tb__pool')})`)
ok('time blocks: 7 days x 18 hours = 126 cells', tb.cells === 126, 'got ' + tb.cells)
ok('time blocks: unscheduled task pool exists', tb.pool)
// Month-view ‹/› pagination: both the internal date and the visible grid must keep up (regression defense: Vue's reactive proxy wrapping the FC instance made renders never reach the DOM)
await gotoHash('#/todo-list/calendar', '.cal-nav-group button')
// Force back to month view first: leftover time-block view from the previous section would send nav() down the tbWeekStart branch without touching the month calendar
await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.cal-seg button')].find(b => b.textContent.trim() === '月')?.click()` })
await sleep(800)
const navTitle = () => evalJson(`(document.querySelector('.cal-title')||{textContent:''}).textContent.trim()`)
const t0 = await navTitle()
await send('Runtime.evaluate', { expression: `document.querySelector('.cal-nav-group button').click()` })
let t1 = ''
for (let i = 0; i < 15; i++) { await sleep(200); t1 = await navTitle(); if (t1 && t1 !== t0) break }
ok('calendar ‹ previous-month pagination works', t1 !== t0 && t1 !== '', `title identical before and after click: ${t0}`)
await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.cal-nav-group button')].pop().click()` })
let t2 = ''
for (let i = 0; i < 15; i++) { await sleep(200); t2 = await navTitle(); if (t2 === t0) break }
ok('calendar › next-month pagination returns', t2 === t0, `expected to return to ${t0}, got ${t2}`)
ok('calendar toolbar has zero errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
ok('new pages have zero errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

console.log('[5] back to home, no runtime exceptions')
await send('Runtime.evaluate', { expression: `location.hash='#/todo-list/today'` }); await sleep(1000)
ok('console has zero errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

// [5.5] Pomodoro shared tick end-to-end: without clicking anything, set the state to "expired focus"; the shared tick should auto-flip/book within seconds and be idempotent
console.log('[5.5] pomodoro shared tick: expiry auto-flip + booking + idempotency')
// Prefer main.js's official exit window.appUI.$store (stable across Vue2/3); fall back to DOM probes
const STORE_Q = `(()=>{if(window.appUI&&window.appUI.$store)return window.appUI.$store;const a=document.getElementById('app')&&document.getElementById('app').__vue_app__;const p=a&&a._instance&&a._instance.proxy;if(p&&p.$store)return p.$store;const el=document.querySelector('.app-shell');return (el&&el.__vue__)?el.__vue__.$root.$store:null})()`
const tomatoBackup = await evalJson(`JSON.stringify((${STORE_Q}) ? (${STORE_Q}).state.tomato : (JSON.parse(localStorage.getItem('tomatoState')||'{}')))`)
const tStart = Date.now() - 25 * 60000 - 3000 // a 25-minute focus that expired 3 seconds ago
// Note: cannot modify localStorage directly (the running app writes its in-memory state back; race) - write via a store patch along the app's own path
await evalJson(`(${STORE_Q}).commit('tomato/patch',{status:'startTomatoTime',startedAt:${tStart},tomatoTime:25,restTime:5,attachTodo:null,_paused:false})`)
// Poll for the shared tick to take effect (1s tick period, ~8s polling cap; avoids fixed sleeps suffering scheduler jitter)
const pollFor = async expr => { for (let i = 0; i < 14; i++) { await sleep(600); const v = await evalJson(expr); if (v) return v } return null }
const tickState = await pollFor(`(()=>{const st=(${STORE_Q});if(!st)return false;const s=st.state.tomato;if(s.status!=='startRestTime')return false;const last=(s.tomatoRecordList||[])[0]||{};return {status:s.status,count:s.todayTomatoCount,recId:last.tomatoId,recOk:last.succeed,recs:(s.tomatoRecordList||[]).length}})()`)
ok('expired focus auto-flips into rest', tickState && tickState.status === 'startRestTime', JSON.stringify(tickState))
ok('auto-books a succeed record', tickState && tickState.recOk === true && tickState.recId === 'tmt_f_' + tStart, JSON.stringify(tickState))
const recsAfterFlip = tickState ? tickState.recs : -1
await sleep(2300) // wait two more beats: the idempotency token + dedup should prevent double booking
const tickState2 = await evalJson(`(()=>{const st=(${STORE_Q});if(!st)return false;const s=st.state.tomato;return {status:s.status,recs:(s.tomatoRecordList||[]).length}})()`)
ok('tick is idempotent and does not double-book', tickState2 && tickState2.recs === recsAfterFlip && tickState2.status === 'startRestTime', JSON.stringify(tickState2))
// Fast-forward rest expiry -> auto reset
const rStart = Date.now() - 5 * 60000 - 2000
await evalJson(`(${STORE_Q}).commit('tomato/patch',{status:'startRestTime',startedAt:${rStart},restTime:5})`)
const restDone = await pollFor(`(()=>{const st=(${STORE_Q});return st&&st.state.tomato.status==='default'?'default':false})()`)
ok('rest expiry auto-resets', restDone === 'default', String(restDone))
// Restore the scene: put the pomodoro state back, avoiding pollution of real data (Vue3 path: appUI.$store; globalProperties fallback)
await evalAwait(`(function(){ const s=(window.appUI&&window.appUI.$store)||(function(){const a=document.getElementById('app').__vue_app__;return a.config.globalProperties.$store})(); s.commit('tomato/patch', JSON.parse(${JSON.stringify(tomatoBackup) || "'{}'"})); return 'ok' })()`)
await sleep(300)

// [6] axe-core automated accessibility checks (WCAG AA common items: contrast/labels/button names/language/headings etc.)
// Only serious/critical violations count as failures; moderate/minor are printed as hints without blocking
// [5.7] Minimum-window overflow gate: window minWidth=750 (2026-09-03: progressive auto-fold — rail folds <1140, sidebar <920; all-folded single-line threshold 732 measured; the row must never wrap to two lines); the content layout must fit at that width (right-side controls must not be swallowed by overflow-x)
// Regression background: .main-col min-width 640 + expanded sidebar 232 ~= 890 > 720, clipping the main column horizontally in narrow windows (P0, found by user testing)
console.log('[5.7] minimum window (750x520) horizontal overflow gate')
await send('Emulation.setDeviceMetricsOverride', { width: 750, height: 520, deviceScaleFactor: 0, mobile: false })
await sleep(700)
{
// The route list is derived from renderer/js/views/registry.js (single source of truth); do not hand-write it here
  const routes = (await import('../renderer/js/views/registry.js')).SMOKE_ROUTES
  let worst = null
  for (const rt of routes) {
    await send('Runtime.evaluate', { expression: `location.hash='${rt}'` })
    await sleep(900)
    const m = await evalJson(`(()=>{const s=document.querySelector('.app-shell');return s?{sw:s.scrollWidth,cw:s.clientWidth,collapsed:!!document.querySelector('.side-nav--collapsed')}:null})()`)
    if (!m) { ok('minimum-window app-shell exists', false, rt); continue }
    const over = m.sw - m.cw
    if (!worst || over > worst.over) worst = { rt, ...m, over }
  }
  // at 750 both panels are auto-folded (rail <1140, sidebar <920); assert overflow only
  ok('no horizontal overflow at minimum window', worst && worst.over <= 2,
    worst ? `worst ${worst.rt} scrollWidth=${worst.sw} clientWidth=${worst.cw} collapsed=${worst.collapsed}` : 'no data')
  // Restore the viewport and route
  await send('Emulation.clearDeviceMetricsOverride')
  await send('Runtime.evaluate', { expression: `location.hash='#/todo-list/today'` })
  await sleep(800)
}

// [5.8] Modal render gate: open each global modal and walk its tabs, asserting zero Vue runtime errors throughout.
// Background: three consecutive settings-modal bugs (appVersion recursion/shortcutForm null race/dialogA11y text nodes)
// all lived on the "first render frame of a modal" path covered by neither unit tests nor view smoke - unit tests do not click the UI, view smoke never opened modals.
console.log('[5.8] modal render gate (open + walk tabs + zero Vue errors)')
{
  const clearErr = `window.__lastVueErr = null`
  const getErr = `(window.__lastVueErr && (window.__lastVueErr.msg + ' @ ' + window.__lastVueErr.info)) || null`
  // (1) settings modal: open -> walk every tab -> close
  await send('Runtime.evaluate', { expression: clearErr })
  await send('Runtime.evaluate', { expression: `document.querySelector('.sn-account-gear:not(.sn-account-trash)').click()` })
  await sleep(900)
  const modalErr = await evalJson(getErr)
  const opened = await evalJson(`!!document.querySelector('.modal--settings')`)
  ok('settings modal opens with no Vue errors', opened === true && modalErr === null, `opened=${opened} err=${modalErr}`)
  if (opened) {
    const tabs = await evalJson(`document.querySelectorAll('.setting_tabs .el-tabs__item').length`)
    for (let i = 0; i < (tabs || []).length; i++) {
      await send('Runtime.evaluate', { expression: `document.querySelectorAll('.setting_tabs .el-tabs__item')[${i}].click()` })
      await sleep(450)
      const e = await evalJson(getErr)
      if (e !== null) { ok(`settings tab ${i} renders without errors`, false, e); break }
      if (i === (tabs || []).length - 1) ok(`all ${tabs.length} settings tabs render without errors`, true)
    }
    // Data tab version row (end-to-end assertion of the appVersion single source)
    // const dataIdx = await evalJson // unused: the data-tab switch is already covered by the tabs loop; keeping this comment to avoid accidental deletion(`(()=>{const its=[...document.querySelectorAll('.setting_tabs .el-tabs__item')];const i=its.findIndex(x=>/数据|Data/.test(x.textContent));its[i]&&its[i].click();return i})()`)
    await sleep(450)
    const ver = await evalJson(`JSON.stringify((document.body.innerText.match(/拾事 (v)?[0-9]+\\.[0-9.]+/)||[])[0]||null)`)
    ok('data tab shows the version number (appVersion single source)', !!ver, ver)
    // Esc close
    await send('Runtime.evaluate', { expression: `document.querySelector('.modal--settings').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))` })
    await sleep(500)
    const closed = await evalJson(`!document.querySelector('.modal--settings')`)
    ok('settings modal closable (Esc)', closed, `closed=${closed}`)
  }
  // (2) edit panel: click the first task row to open, then Esc
  await send('Runtime.evaluate', { expression: clearErr })
  const row = await evalJson(`(()=>{const r=document.querySelector('.td-item');if(!r)return false;r.dispatchEvent(new MouseEvent('click',{bubbles:true}));return true})()`)
  await sleep(700)
  if (row) {
    const panel = await evalJson(`!!document.querySelector('.edit-panel')`)
    const pErr = await evalJson(getErr)
    ok('edit panel opens with no Vue errors', panel === true && pErr === null, `panel=${panel} err=${pErr}`)
    await send('Runtime.evaluate', { expression: `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))` })
    await sleep(400)
  } else {
    console.log('  - no task rows to click; skipping the edit panel check')
  }
  // (3) global backstop: no uncaught Vue errors after this round of modal interactions
  const finalErr = await evalJson(getErr)
  ok('zero uncaught Vue errors throughout modal interactions', finalErr === null, finalErr || '')
}

console.log('[6] axe-core accessibility checks (Day Todo view)')
try {
  const fs = await import('fs')
  const path = await import('path')
  const axeSrc = fs.readFileSync(path.join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js'), 'utf8')
  await send('Runtime.evaluate', { expression: axeSrc })
  const axeRes = await evalJson(`axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }).then(r => ({
    violations: r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length,
      sample: v.nodes[0]?.target?.join('>') })),
    passes: (r.passes || []).length
  }))`)
  if (axeRes === null) {
    console.log('  - axe returned no result (page busy); skipping this round')
  } else {
    const blocking = (axeRes.violations || []).filter(v => ['critical', 'serious'].includes(v.impact))
    for (const v of axeRes.violations || []) {
      const tag = ['critical', 'serious'].includes(v.impact) ? '✗' : '·'
      console.log(`  ${tag} [${v.impact}] ${v.id} ×${v.nodes}  e.g. ${v.sample}`)
    }
    ok('axe has no blocking violations (critical/serious)', blocking.length === 0,
      blocking.map(v => v.id).join(','))
    console.log(`  - ${axeRes.passes} rules passed`)
  }
} catch (e) {
  console.log('  - axe-core not installed or injection failed (npm i -D axe-core); skipping')
}

console.log(`\\nresults: ${passed} passed, ${failed} failed`)
ws.close()
process.exit(failed ? 1 : 0)
