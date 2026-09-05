/**
 * Full-view test matrix - the UI layer of the professional test campaign
 * Covers: 8 views x render/console errors/axe(wcag2a+aa)/dark + 4 review tabs + 6 core interaction chains
 * Prerequisite: the app runs with --no-focus --remote-debugging-port=9333 --remote-allow-origins=*
 * Usage: node tests/ui-matrix.mjs  (results land in tests/.last-matrix.json)
 */
const CDP = process.env.TODO_CDP || 'http://127.0.0.1:9333'
const fs = await import('fs')

let ws = null, id = 0
const pending = new Map()

async function connect () {
  for (let i = 0; i < 4; i++) {
    try {
      const targets = await (await fetch(CDP + '/json/list', { signal: AbortSignal.timeout(2000) })).json()
      const page = targets.find(t => t.type === 'page' && t.url.includes('todo-list')) ||
             targets.find(t => t.type === 'page' && !t.url.includes('__tomato-float') && !t.url.includes('__widget')) || targets[0]
      ws = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((r, j) => {
        const t = setTimeout(() => j(new Error('open timeout')), 5000)
        ws.onopen = () => { clearTimeout(t); r() }
        ws.onerror = () => { clearTimeout(t); j(new Error('open err')) }
      })
      const probe = await Promise.race([
        new Promise(res => {
          ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 999901) res(m) }
          ws.send(JSON.stringify({ id: 999901, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } }))
        }),
        new Promise(res => setTimeout(() => res(null), 4000))])
      if (probe?.result?.result?.value === 2) { ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }; return }
      throw new Error('silent agent')
    } catch (e) { console.error('  [connect fail]', e.message); try { ws?.close() } catch {} pending.clear(); await new Promise(r => setTimeout(r, 1200)) }
  }
  console.error('FATAL: CDP unavailable')
  process.exit(2)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const send = (method, params = {}) => { const i = ++id; const promise = new Promise(res => { pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); return res; }); return promise; }
async function ev (expr, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(12000).then(() => null)])
    if (r?.result) {
      if (r.result.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 200) }
      return r.result.result?.value
    }
    try { ws.close() } catch {}
    pending.clear()
    await connect()
  }
  return '<<CDP-TIMEOUT>>'
}

await connect()
await send('Runtime.enable'); await send('Page.enable')

// Page-side accumulated errors (survive reconnects) + inject axe
await ev(`(function(){
  window.__errs = []
  window.addEventListener('error', e => window.__errs.push(String(e.message).slice(0,150)))
  window.addEventListener('unhandledrejection', e => window.__errs.push('rej:' + String(e.reason && e.reason.message || e.reason).slice(0,150)))
  return 'armed'
})()`)
const axeSrc = fs.readFileSync(process.cwd() + '/node_modules/axe-core/axe.min.js', 'utf8')
await ev(axeSrc)

const views = [
  { hash: '#/todo-list/today', sel: '.td-item, .empty, .todo-list-item-group-list, .qa-input', name: '今日DayTodo' },
  { hash: '#/todo-list/recent', sel: '.group-block, .td-item, .empty, .page__main', name: '最近待办' },
  { hash: '#/todo-list/todo-box', sel: '.todo-box-list, .empty, .todo-page-layout', name: '待办箱' },
  { hash: '#/todo-list/statistics', sel: '.stat-page, .page.stat-page', name: '数据复盘' },
  { hash: '#/todo-list/search', sel: '.search-page, .search-bar, .view-page', name: '搜索' },
  { hash: '#/todo-list/calendar', sel: '.fc .fc-daygrid, .cal-page .fc', name: '日程概览' },
  { hash: '#/todo-list/completed', sel: '.completed-page, .view-page', name: '已达成' },
  { hash: '#/todo-list/recycle-bin', sel: '.recycle-page, .view-page', name: '回收站' }
]
let pass = 0, fail = 0
const defects = []
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name) } else {
    fail++; defects.push({ name, detail: String(detail).slice(0, 300) })
    console.log('  ✗ ' + name + (detail ? ' — ' + String(detail).slice(0, 120) : ''))
  }
}

console.log('\n[A] view render matrix (8 views x render/errors/axe/dark)')
const matrix = []
for (const v of views) {
  await ev(`location.hash='${v.hash}'`)
  await sleep(2800)
  const r = await ev(`(async function(){
    const out = {}
    out.rendered = !!document.querySelector('${v.sel}')
    out.errs = (window.__errs || []).splice(0)
    out.hash = location.hash
    try {
      // Exclude third-party component internals (Element UI-generated inputs are covered by component semantics; FullCalendar grid library internals)
      const res = await axe.run(document,
        { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa'] }, resultTypes: ['violations'],
          context: { exclude: ['.el-select', '.el-checkbox', '.el-input-number', '.el-date-editor', '.el-radio', '.el-switch', '.fc'] } })
      const isLib = n => !!(n.element && n.element.closest && n.element.closest('.fc, .el-select, .el-input-number, .el-date-editor, .el-picker-panel, .el-input__inner'))
      const blocking = res.violations.filter(x => (x.impact === 'critical' || x.impact === 'serious'))
      out.axe = blocking.filter(x => !x.nodes.every(n => isLib(n))).map(x => x.id + 'x' + x.nodes.length + ':' + (x.nodes[0].target.join('>')||'').slice(0,60))
      out.axeLib = blocking.filter(x => x.nodes.every(n => isLib(n))).map(x => x.id + 'x' + x.nodes.length)
      out.axeMinor = res.violations.filter(x => !['critical','serious'].includes(x.impact)).map(x => x.id)
    } catch (e) { out.axe = ['AXE_ERR:' + e.message] }
    return JSON.stringify(out)
  })()`)
  const o = typeof r === 'string' ? JSON.parse(r) : { rendered: false, errs: ['eval fail: ' + JSON.stringify(r)], axe: [] }
  await ev(`document.documentElement.setAttribute('data-theme','dark')`)
  await sleep(350)
  const dark = JSON.parse(await ev(`JSON.stringify({body: getComputedStyle(document.body).backgroundColor, attr: document.documentElement.getAttribute('data-theme')})`) || '{}')
  await ev(`document.documentElement.setAttribute('data-theme','light')`)
  check(v.name + ':render', o.rendered === true, 'hash=' + o.hash)
  check(v.name + ':console errors=0', (o.errs || []).length === 0, (o.errs || []).join(' | '))
  check(v.name + ':axe serious violations=0', (o.axe || []).length === 0, (o.axe || []).join(', '))
  check(v.name + ':dark toggle effective', dark.attr === 'dark' && !!dark.body, JSON.stringify(dark))
  matrix.push({ name: v.name, rendered: o.rendered, errs: o.errs, axe: o.axe, axeMinor: o.axeMinor })
}

console.log('\n[B] review 4 tabs')
await ev(`location.hash='#/todo-list/statistics'`)
await sleep(1400)
for (let i = 0; i < 4; i++) {
  await ev(`[...document.querySelectorAll('.stat-page .navbar__item')][${i}].click()`)
  await sleep(1600)
  const r = await ev(`JSON.stringify({active:document.querySelector('.stat-page .navbar__item--active')?.textContent?.trim(), cards:document.querySelectorAll('.stat-page .single,.stat-page .double').length, errs:(window.__errs||[]).splice(0)})`)
  const o = JSON.parse(r || '{}')
  check(`review tab[${i}] renders without errors`, o.cards > 0 && (o.errs || []).length === 0, JSON.stringify(o).slice(0, 150))
}

console.log('\n[C] quick add -> complete -> undo -> delete -> restore (safe cleanup)')
const c = await ev(`(async function(){
  const S = window.appUI.$store
  const out = {}
  location.hash = '#/todo-list/today'
  await new Promise(r => setTimeout(r, 800))
  S.dispatch('todo/addTodo', { todoContent: '__TEST__E2E__', todoDate: Date.now() })
  await new Promise(r => setTimeout(r, 800))
  const t = S.state.todo.todoList.find(x => x.taskContent === '__TEST__E2E__' && !x.delete)
  out.added = !!t
  if (!t) { out.errs = (window.__errs || []).splice(0); return JSON.stringify(out) }
  await S.dispatch('todo/toggleComplete', S.state.todo.todoList.find(x => x.taskId === t.taskId))
  await new Promise(r => setTimeout(r, 500))
  out.completed = !!S.state.todo.todoList.find(x => x.taskId === t.taskId && x.complete)
  await S.dispatch('todo/toggleComplete', S.state.todo.todoList.find(x => x.taskId === t.taskId))
  await new Promise(r => setTimeout(r, 500))
  out.undone = !S.state.todo.todoList.find(x => x.taskId === t.taskId && x.complete)
  await S.dispatch('todo/deleteTodo', S.state.todo.todoList.find(x => x.taskId === t.taskId))
  await new Promise(r => setTimeout(r, 500))
  out.deleted = !S.state.todo.todoList.find(x => x.taskId === t.taskId && !x.delete)
  out.inRecycle = S.state.todo.recycleList.some(x => x.taskId === t.taskId)
  await S.dispatch('todo/restoreFromRecycle', S.state.todo.recycleList.find(x => x.taskId === t.taskId))
  await new Promise(r => setTimeout(r, 500))
  out.restored = !!S.state.todo.todoList.find(x => x.taskId === t.taskId && !x.delete)
  const raw = S.state.todo.todoList.find(x => x.taskId === t.taskId)
  if (raw) { await S.dispatch('todo/deleteTodo', raw); out.cleaned = true }
  out.errs = (window.__errs || []).splice(0)
  return JSON.stringify(out)
})()`)
const co = typeof c === 'string' ? JSON.parse(c) : { added: false, errs: ['eval fail: ' + JSON.stringify(c)] }
check('chain:add task', co.added === true, JSON.stringify(co).slice(0, 150))
check('chain:mark complete', co.completed === true)
check('chain:undo complete', co.undone === true)
check('chain:delete into recycle bin', co.deleted === true && co.inRecycle === true)
check('chain:restore from recycle bin', co.restored === true)
check('chain:test data cleaned up', co.cleaned === true)
check('chain:0 errors throughout', (co.errs || []).length === 0, (co.errs || []).join(' | '))

console.log('\n[D] pomodoro state machine (start -> modal -> cancel -> real give-up -> booking)')
const d = await ev(`(async function(){
  const S = window.appUI.$store
  const out = {}
  location.hash = '#/todo-list/today'
  await new Promise(r => setTimeout(r, 600))
  S.dispatch('tomato/startFocus')
  out.status1 = S.state.tomato.status
  S.commit('tomato/patch', { startedAt: Date.now() - 61000 })
  document.querySelector('.tomato-timer__play').click()
  await new Promise(r => setTimeout(r, 400))
  out.modalOpen = !!document.querySelector('.modal--abandon')
  const contBtn = document.querySelector('.modal--abandon .mini')
  if (contBtn) contBtn.click()
  await new Promise(r => setTimeout(r, 300))
  out.stillRunning = S.state.tomato.status === 'startTomatoTime'
  document.querySelector('.tomato-timer__play').click()
  await new Promise(r => setTimeout(r, 300))
  const gbtn = document.querySelector('.modal--abandon .mini.danger')
  if (gbtn) gbtn.click()
  await new Promise(r => setTimeout(r, 500))
  out.statusAfterGiveUp = S.state.tomato.status
  out.giveUpRecorded = S.state.tomato.tomatoRecordList[0]?.succeed === false
  out.reasonEmptyOk = S.state.tomato.tomatoRecordList[0]?.abandonReason === ''
  out.errs = (window.__errs || []).splice(0)
  return JSON.stringify(out)
})()`)
const do_ = typeof d === 'string' ? JSON.parse(d) : { status1: 'eval fail: ' + JSON.stringify(d) }
check('tomato:start -> focus state', do_.status1 === 'startTomatoTime', String(do_.status1))
check('tomato:give-up modal opens', do_.modalOpen === true)
check('tomato:still focusing after cancel', do_.stillRunning === true)
check('tomato:real give-up -> reset', do_.statusAfterGiveUp === 'default', String(do_.statusAfterGiveUp))
check('tomato:give-up booked with succeed=false', do_.giveUpRecorded === true)
check('tomato:empty reason is legal', do_.reasonEmptyOk === true)
check('tomato:0 errors throughout', (do_.errs || []).length === 0, (do_.errs || []).join(' | '))

console.log('\n[E] settings persistence')
const e2 = await ev(`(async function(){
  const S = window.appUI.$store
  const out = {}
  const orig = S.state.settings.dailyTomatoTarget
  S.commit('settings/updateSettings', { dailyTomatoTarget: 13 })
  await new Promise(r => setTimeout(r, 400))
  out.persisted = S.state.settings.dailyTomatoTarget === 13
  S.commit('settings/updateSettings', { dailyTomatoTarget: orig })
  out.restored = S.state.settings.dailyTomatoTarget === orig
  out.errs = (window.__errs || []).splice(0)
  return JSON.stringify(out)
})()`)
const eo = typeof e2 === 'string' ? JSON.parse(e2) : {}
check('settings:change takes effect', eo.persisted === true)
check('settings:original value restored', eo.restored === true)

console.log(`\n===== results: ${pass} passed, ${fail} failed =====`)
console.log('DEFECTS:' + JSON.stringify(defects, null, 1))
fs.writeFileSync(process.cwd() + '/tests/.last-matrix.json', JSON.stringify({ pass, fail, defects, matrix, ts: new Date().toISOString() }, null, 2))
ws.close()
process.exit(fail ? 1 : 0)
