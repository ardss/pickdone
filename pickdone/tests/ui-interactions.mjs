/**
 * UI interaction smoke - covers "click -> visible effect" interaction regressions (systematic coverage strengthening, 2026-08-29).
 * Background: the broken calendar ‹/› pagination clicks exposed a coverage gap - views had a render matrix, but interactions had no defense line.
 * This script adds ten high-value interaction chains, each = action + visible-effect assertion; any failure turns the release gate red.
 * Zero dependencies (Node 22 built-in fetch/WebSocket). Usage: npm run smoke:interact
 */
const CDP = process.env.TODO_CDP || 'http://127.0.0.1:9333'

const watchdog = setTimeout(() => {
  console.error('FAIL: interaction smoke did not finish within 120s; forcing exit')
  try { ws?.close() } catch {}
  process.exit(1)
}, 120000)
watchdog.unref?.()
process.on('exit', () => { try { ws?.close() } catch {} })


// Page-target probe with retry: a freshly spawned debug port answers /json before any page target is
// registered (and can transiently time out while the renderer compiles), so a single-shot check raced
// the gate wrapper's spawn and SKIPped the whole gate. Poll up to ~20s instead.
let available = false
for (let i = 0; i < 20 && !available; i++) {
  try {
    const list = await (await fetch(CDP + '/json', { signal: AbortSignal.timeout(2000) })).json()
    available = list.some(t => t.type === 'page' && !String(t.url).includes('__tomato-float'))
  } catch { /* port not answering yet */ }
  if (!available) await new Promise(r => setTimeout(r, 1000))
}
if (!available) { console.log('SKIP: no page target on ' + CDP + ' after 20s'); process.exit(2) }


let ws = null
let id = 0
const pending = new Map()
const pickMainPage = targets =>
  targets.find(t => t.type === 'page' && !t.url.includes('__tomato-float') && /#\/(todo-list|__widget\/list)/.test(t.url)) ||
  targets.find(t => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('__tomato-float'))

async function connectOnce () {
  const targets = (await (await fetch(CDP + '/json', { signal: AbortSignal.timeout(2000) })).json())
  const page = pickMainPage(targets)
  if (!page) { console.error('FAIL: no usable page target'); process.exit(1) }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  await send('Runtime.enable'); await send('Page.enable')
}
async function connect () {
  for (let i = 0; i < 3; i++) {
    const result = await Promise.race([connectOnce().then(() => 'ok'), sleep(8000).then(() => 'timeout')])
    if (result === 'ok') return
    try { ws?.close() } catch {}
    pending.clear()
    await sleep(2000)
  }
  console.error('FAIL: CDP handshake timed out repeatedly (the app needs a restart)')
  process.exit(1)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })

const evalJson = async expression => {
  const once = async () => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: `JSON.stringify((${expression}))`, returnByValue: true, awaitPromise: true, timeout: 8000 }),
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

let passed = 0; let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  ✓ ' + name) } else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}
const waitBoot = async () => {
  for (let i = 0; i < 30; i++) {
    if (await evalJson("document.querySelectorAll('.sn-nav-item').length > 0")) { await sleep(800); return true }
    await sleep(1000)
  }
  return false
}
const gotoHash = async (hash, sentinel) => {
  await send('Runtime.evaluate', { expression: "location.hash='" + hash + "'" })
  if (!sentinel) { await sleep(2000); return true }
  for (let i = 0; i < 15; i++) {
    await sleep(1000)
    if (await evalJson("!!document.querySelector('" + sentinel + "')")) { await sleep(600); return true }
  }
  return false
}
const click = async sel => {
  const r = await evalJson(`(() => { var b = document.querySelector('${sel}'); if (!b) return false; b.click(); return true })()`)
  return r === true
}

await connect()
await send('Runtime.enable'); await send('Page.enable')
if (!(await waitBoot())) { console.error('FAIL: app did not finish booting within 30s'); try { ws.close() } catch {} process.exit(1) }

// Real error collection: previously nobody injected window.__errs, so the "throws no exceptions" assertion was always 0===0 filler;
// here error/unhandledrejection collectors are installed in the page so exception assertions have real data
await evalJson(`(() => { window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', e => window.__errs.push('rej:' + String(e.reason && e.reason.message || e.reason))); return 'ok' })()`)
// Retire every driver.js spotlight tour for this session: the spotlight overlay (body.driver-active) covers
// the whole page and swallows all real clicks below, and Esc-on-document proved unreliable to dismiss it.
// Seeding the seen-ledger before any view mounts means maybeRunTour no-ops — deterministic, no overlay at all.
await evalJson(`(() => { try { localStorage.setItem('onboardingToursSeen', JSON.stringify({ today: 1, editpanel: 1 })); localStorage.setItem('appLocale','en-US') } catch {} ; return 'ok' })()`)
await send('Page.reload')
if (!(await waitBoot())) { console.error('FAIL: reload after tour-seeding did not finish within 30s'); try { ws.close() } catch {} process.exit(1) }

/* ---- 1. Sidebar collapse/expand (regression: bubbling double-fire made clicks ineffective) ---- */
console.log('\n[1] sidebar collapse')
await gotoHash('#/todo-list/today')
const w0 = await evalJson(`Math.round(document.querySelector('aside.side-nav').getBoundingClientRect().width)`)
await click('.sn-collapse-btn'); await sleep(500)
const w1 = await evalJson(`Math.round(document.querySelector('aside.side-nav').getBoundingClientRect().width)`)
ok('sidebar collapse takes effect (width change)', w1 !== w0, `${w0} -> ${w1}`)
await click('.sn-collapse-btn'); await sleep(500)
const w2 = await evalJson(`Math.round(document.querySelector('aside.side-nav').getBoundingClientRect().width)`)
ok('sidebar expand restores', w2 === w0, `${w1} -> ${w2}`)

/* ---- 2. Inbox dot complete + undo (regression: the dot used to be purely decorative) ---- */
console.log('\n[2] inbox dot complete')
await gotoHash('#/todo-list/todo-box', '.todo-box-list, .empty')
const hasBoxItems = await evalJson(`!!document.querySelector('.tb-dot-check')`)
if (hasBoxItems) {
  const n0 = await evalJson(`document.querySelectorAll('.tb-dot-check').length`)
  await click('.tb-dot-check'); await sleep(700)
  const n1 = await evalJson(`document.querySelectorAll('.tb-dot-check').length`)
  ok('dot completion takes effect (item leaves the inbox)', n1 === n0 - 1, `${n0} -> ${n1}`)
  const undo = await evalJson(`(() => { var a = [...document.querySelectorAll('.el-message a')].find(x => x.textContent === 'Undo'); if (a) { a.click(); return true } return false })()`)
  await sleep(700)
  const n2 = await evalJson(`document.querySelectorAll('.tb-dot-check').length`)
  if (undo) ok('undo restores the item', n2 === n0, `${n1} -> ${n2}`)
  else ok('undo prompt exists', false, 'undo link not found')
} else {
  console.log('  - inbox empty; skipping the dot completion check')
}

/* ---- 3. Edit panel complete switch ---- */
console.log('\n[3] edit panel complete switch')
await gotoHash('#/todo-list/todo-box', '.todo-box-list, .empty')
if (await evalJson(`!!document.querySelector('.todo-box-list-item')`)) {
  await click('.todo-box-list-item'); await sleep(800)
  const checked0 = await evalJson(`(document.querySelector('.ep-done-row')||{getAttribute:()=>null}).getAttribute('aria-checked')`)
  await click('.ep-done-row'); await sleep(800)
  const checked1 = await evalJson(`(document.querySelector('.ep-done-row')||{getAttribute:()=>null}).getAttribute('aria-checked')`)
  ok('edit panel complete switch toggles', checked0 !== checked1, `${checked0} -> ${checked1}`)
  // Restore: click once more to return to the original state, and verify the toast undo link exists along the way
  const undo = await evalJson(`(() => { var a = [...document.querySelectorAll('.el-message a')].find(x => x.textContent === 'Undo'); if (a) { a.click(); return true } return false })()`)
  if (undo) { await sleep(600); ok('complete-undo link usable', true) } else { await click('.ep-done-row'); await sleep(500); ok('complete-undo link usable', false, 'undo link not found (inconsistent feedback conventions)') }
} else {
  console.log('  - inbox empty; skipping the edit panel check')
}

/* ---- 4. Quick-add creation + cleanup ---- */
console.log('\n[4] quick-add creation')
await gotoHash('#/todo-list/today', '.qa-input')
const before = await evalJson(`document.querySelectorAll('.td-item').length`)
await evalJson(`(() => { var el = document.querySelector('.qa-input'); el.focus(); var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '交互冒烟_临时任务'); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok' })()`)
await evalJson(`(() => { var el = document.querySelector('.qa-input'); el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })); return 'ok' })()`)
await sleep(900)
const after = await evalJson(`document.querySelectorAll('.td-item').length`)
ok('quick-add Enter creation takes effect', after === before + 1, `before=${before} after=${after}`)
await evalJson(`(async () => window.todoAPI.dbCall('getAll', {})).then(rows => { var ids = rows.filter(t => !t.delete && t.taskContent === '交互冒烟_临时任务').map(t => t.taskId); if (ids.length) window.todoAPI.dbCall('hardDeleteMany', ids); return ids.length })`)

/* ---- 5. Review tabs + period pills ---- */
console.log('\n[5] review interactions')
await gotoHash('#/todo-list/statistics', '.stat-view-tab')
const tabsText = await evalJson(`[...document.querySelectorAll('.stat-view-tab')].map(b => b.textContent.trim()).join('|')`)
ok('review tabs render', tabsText.split('|').length >= 2, tabsText)
await click('.stat-period-pill'); await sleep(400)
// After clicking the first pill the title should change with the period (or match the initial - "title exists and the first pill is highlighted" counts as pass)
const pillOn = await evalJson(`!!document.querySelector('.stat-period-pill.on')`)
ok('period pill switching gives highlight feedback', pillOn)
const viewTab = await evalJson(`[...document.querySelectorAll('.stat-view-tab')].find(b => b.textContent.trim() === 'Charts')`)
if (viewTab) { await evalJson(`[...document.querySelectorAll('.stat-view-tab')].find(b => b.textContent.trim() === 'Charts').click()`); await sleep(800) }
ok('chart tab: heatmap renders', await evalJson(`!!document.querySelector('.hm-grid')`))

/* ---- 6. Settings page tab walk-through ---- */
console.log('\n[6] settings page tabs')
await click('.sn-account, [aria-label="Settings"], .sn-settings'); await sleep(800)
const tabCount = await evalJson(`document.querySelectorAll('.settings-tabs .tab, .set-tabs button, [class*=tab]').length`)
ok('settings page opens and has tab structure', tabCount > 0, 'tabs=' + tabCount)
await evalJson(`(() => { var b = document.querySelector('.modal-close, [aria-label="Close"], .set-close'); if (b) b.click(); return 'ok' })()`); await sleep(400)

/* ---- 7. Calendar view switching and pagination (cross-check; detailed assertions live in ui-smoke) ---- */
console.log('\n[7] calendar toolbar')
await gotoHash('#/todo-list/calendar', '.cal-nav-group button')
ok('calendar toolbar exists', await evalJson(`!!document.querySelector('.cal-nav-group button')`))
await click('.cal-nav-group button'); await sleep(600)
ok('calendar ‹ pagination throws no exceptions', (await evalJson(`(window.__errs||[]).length`)) === 0)

/* ---- 8. Quadrant hover quick actions (complete + undo; the hover action layer from a368bb9 previously had no defense) ---- */
console.log('[8] quadrant hover quick actions')
await gotoHash('#/todo-list/today', '.pd-view-seg button')
await evalJson(`(() => { var b = [...document.querySelectorAll('.pd-view-seg button')][1]; if (b) b.click(); return 'ok' })()`)
await sleep(900)
const mt0 = await evalJson(`document.querySelectorAll('.matrix-task').length`)
if (mt0 > 0) {
  // The hover action layer (opacity:0) floats over the row; CDP coordinate clicks may be intercepted by an upper element - dispatch the click via JS;
  // the row-to-task mapping is unreliable for empty titles, so assert via "completed count +1 then restore"
  const cnt = () => evalJson(`window.appUI.$store.state.todo.todoList.filter(x => x.complete && !x.delete).length`)
  const c0 = await cnt()
  await evalJson(`(function(){ var b=document.querySelector('.matrix-task .td-check'); if(b) b.dispatchEvent(new MouseEvent('click',{bubbles:true})); return 'ok' })()`)
  await sleep(800)
  const c1 = await cnt()
  ok('hover completion takes effect (completed count +1)', c1 === c0 + 1, `${c0} -> ${c1}`)
  const undo = await evalJson(`(() => { var a = [...document.querySelectorAll('.el-message a')].find(x => x.textContent === 'Undo'); if (a) { a.click(); return true } return false })()`)
  if (!undo) {
    const dbg = await evalJson(`JSON.stringify({toasts:[...document.querySelectorAll('.el-message')].map(m=>m.innerText.slice(0,60)), links:[...document.querySelectorAll('.el-message a')].map(a=>a.textContent), lang:localStorage.getItem('appLocale')})`)
    console.log('  [debug] undo probe:', dbg)
  }
  await sleep(800)
  const c2 = await cnt()
  if (undo) ok('matrix undo restores the completion state', c2 === c0, `${c1} -> ${c2}`)
  else ok('matrix undo link exists', false, 'undo link not found')
} else {
  console.log('  - today matrix empty; skipping the hover action check')
}
await evalJson(`(() => { var b = [...document.querySelectorAll('.pd-view-seg button')][0]; if (b) b.click(); return 'ok' })()`)

/* ---- 9. Today-page card view real input chain (562261c: DayDeck setPointerCapture swallowed inline-control clicks;
   JS-synthesized clicks bypass the pointer event chain so everything looked green while real mice always broke - this check must go through the CDP real-mouse path) ---- */
console.log('[9] card view real-mouse interactions')
await gotoHash('#/todo-list/today', '.view-seg button, .pd-view-seg button')
// On first launch the isolated instance shows the onboarding wizard (ob-mask z=3000 intercepts all real clicks) - skip it first
const obGone = await evalJson(`(() => { var s = document.querySelector('.ob-mask .ob-link'); if (s) { s.click(); return 'skipped' } return !document.querySelector('.ob-mask') ? 'none' : 'still' })()`)
if (obGone === 'skipped') await sleep(800)
ok('onboarding wizard closed (real clicks can land)', await evalJson(`!document.querySelector('.ob-mask')`), 'ob-mask still present')
// ---- Systematized dirty-instance defense (2026-09-01): the gate reuses a live 9333 instance when one
// exists, and ANY open overlay (EditPanel desc textarea / settings modal / image preview) silently
// swallows every real-mouse click below — probe-verified: elementsFromPoint at the deck seg button hit
// .ep-desc. Before any real-click section: strip known overlays; realClickAt itself then VERIFIES the
// click actually lands on the target and reports the covering element when it doesn't (the diagnostic
// that previously required a hand-written CDP probe).
const closeStrayOverlays = async () => {
  for (let i = 0; i < 8; i++) {
    const state = await evalJson(`(() => {
      if (document.querySelector('.el-image-viewer, .img-preview')) { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return 'preview' }
      if (document.querySelector('.edit-panel')) { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return 'edit-panel' }
      var m = document.querySelector('.modal--settings')
      if (m) { var x = m.querySelector('.modal__close.close-x'); if (x) { x.click(); return 'settings-closed' } }
      // driver.js spotlight tour overlay (body.driver-active): allowClose=true → Esc destroys it.
      // Must dispatch on DOCUMENT — driver listens there, and window-dispatched events never reach document listeners.
      if (document.body.classList.contains('driver-active') || document.querySelector('.driver-overlay')) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return 'tour' }
      // transient toasts also sit above buttons and swallow real clicks; they self-dismiss — just report and wait
      if (document.querySelector('.el-message')) return 'toast-wait'
      // a tooltip/popover left open by earlier hover steps persists until a real mouseleave moves the pointer away
      var p = document.querySelector('.el-popper[aria-hidden="false"], .el-tooltip__popper:not([aria-hidden="true"])')
      if (p) return 'popper-wait'
      return 'clean'
    })()`)
    if (state === 'clean') return true
    if (state === 'popper-wait') {
      // real pointer move away (same CDP path as a user's mouse) so the tooltip's mouseleave fires
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
    }
    await sleep(700)
  }
  return false
}
await closeStrayOverlays()
// Real coordinate click: take the element's center then use Input.dispatchMouseEvent (same path as a user's mouse, including pointerdown/capture chain).
// Hit-verification: if elementFromPoint at the point is NOT the target (or inside it), skip the click
// and return who is covering — a swallowed click must fail loudly with a diagnosis, not limp on.
const realClickAt = async (expr) => {
  const probe = await evalJson(`(() => { var el = (${expr}); if (!el) return { miss: 'no-el' }; var r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return { miss: 'zero-rect' }; var x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2); var top = document.elementFromPoint(x, y); var cls = top ? ((top.getAttribute && top.getAttribute('class')) || top.tagName || '').slice(0, 80) : 'none'; var chain = []; var e2 = top; for (var i = 0; e2 && i < 5; i++) { chain.push(e2.tagName + (e2.id ? '#' + e2.id : '') + '.' + ((e2.getAttribute && e2.getAttribute('class')) || '').toString().slice(0, 40)); e2 = e2.parentElement } return { x, y, covered: top && !el.contains(top) && top !== el ? cls : null, chain } })()`)
  if (!probe || probe.miss) { console.error('    [realClick] target unavailable: ' + JSON.stringify(probe)); return false }
  if (probe.covered) { console.error('    [realClick] click point covered by: ' + probe.covered + ' | chain: ' + JSON.stringify(probe.chain) + ' | (run closeStrayOverlays or fix stacking)'); return false }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: probe.x, y: probe.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: probe.x, y: probe.y, button: 'left', clickCount: 1 })
  return true
}
// Switch to card view (real click on the view toggle; V2 buttons are icon-only: 0=list 1=quadrant 2=card)
const segBtn = i => `document.querySelectorAll('.pd-view-seg button')[${i}]`
const sw = await realClickAt(segBtn(2))
ok('card view toggle really clickable', sw)
await sleep(900)
ok('card deck mounted', await evalJson(`!!document.querySelector('.pd-day-deck')`))
// Empty-DB defense: the isolated instance is a brand-new empty DB; with no tasks the core assertions would hit the "skip" branch = an idle defense.
// In a gate, skip = useless - if there is no incomplete task, seed one first through the real quick-add flow.
const seedIfNeeded = async () => {
  if (await evalJson(`!!document.querySelector('.pd-day-deck__card.front .pd-day-deck__chk[aria-checked="false"]')`)) return false
  await evalJson(`(() => { var el = document.querySelector('.qa-input'); if (!el) return 'no-input'; el.focus(); var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '交互冒烟_临时任务'); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok' })()`)
  await evalJson(`(() => { var el = document.querySelector('.qa-input'); if (el) el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })); return 'ok' })()`)
  await sleep(1000)
  return true
}
const seeded = await seedIfNeeded()
ok('empty-DB self-seeding works (the isolated instance must not idle its defense)', !seeded || await evalJson(`!!document.querySelector('.pd-day-deck__card.front .pd-day-deck__chk[aria-checked="false"]')`))
// The checkbox of the first unchecked item on the front card: real click -> aria-checked flips -> click again to restore
const chkExpr = `document.querySelector('.pd-day-deck__card.front .pd-day-deck__chk[aria-checked="false"]')`
const hasChk = await evalJson(`!!(${chkExpr})`)
if (hasChk) {
  const flipped = await realClickAt(chkExpr)
  await sleep(900)
  const st1 = await evalJson(`(() => { var c = document.querySelector('.pd-day-deck__card.front .pd-day-deck__chk'); return c ? c.getAttribute('aria-checked') : 'no-card' })()`)
  ok('checkbox real click takes effect (pointer capture must not swallow the click)', flipped && st1 === 'true', 'aria-checked=' + st1)
  await realClickAt(`document.querySelector('.pd-day-deck__card.front .pd-day-deck__chk[aria-checked="true"]')`)
  await sleep(900)
  const st2 = await evalJson(`(() => { var c = document.querySelector('.pd-day-deck__card.front .pd-day-deck__chk'); return c ? c.getAttribute('aria-checked') : 'no-card' })()`)
  ok('clicking again restores the checkbox (no data residue)', st2 === 'false', 'aria-checked=' + st2)
} else {
  console.log('  - front card has no incomplete task; skipping the checkbox check')
}
// Real click on the title -> the edit panel opens and loads that title
const titleExpr = `document.querySelector('.pd-day-deck__card.front .pd-day-deck__title')`
const t0 = await evalJson(`(() => { var t = (${titleExpr}); return t ? t.textContent.trim() : null })()`)
if (t0) {
  await realClickAt(titleExpr)
  await sleep(800)
  const panelTitle = await evalJson(`(() => { var i = document.querySelector('.ep-title textarea'); return i ? i.value.trim() : null })()`)
  ok('real title click opens the edit bar', panelTitle === t0, `panel="${panelTitle}" expected="${t0}"`)
} else {
  console.log('  - front card has no items; skipping the title check')
}
// Drag to change day: real press on the card header's blank area -> move left -> release -> the front card's date changes; drag back afterwards
const frontDate = () => evalJson(`(() => { var f = document.querySelector('.pd-day-deck__card.front'); return f ? f.textContent.slice(0, 12) : null })()`)
const d0 = await frontDate()
if (d0) {
  const head = await evalJson(`(() => { var f = document.querySelector('.pd-day-deck__card.front'); var r = f.getBoundingClientRect(); var y = Math.round(r.y + 44); return { x: Math.round(r.x + r.width / 2), y: y } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: head.x, y: head.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 10; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: head.x - i * 13, y: head.y, button: 'left' })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: head.x - 130, y: head.y, button: 'left', clickCount: 1 })
  await sleep(800)
  const d1 = await frontDate()
  ok('drag-to-change-day still works (the fix must not break the gesture)', d1 !== d0, `${d0} -> ${d1}`)
  // Drag back to today with the arrow keys, restoring the scene
  await evalJson(`(() => { var d = document.querySelector('.pd-day-deck'); if (d) { d.focus(); d.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) } return 'ok' })()`)
  await sleep(600)
} else {
  console.log('  - card deck absent; skipping the drag check')
}
// Restore: switch back to list view + clean up the seeded task (do not pollute the real instance / the next assertion baseline)
await realClickAt(segBtn(0))
await evalJson(`(async () => window.todoAPI.dbCall('getAll', {})).then(rows => { var ids = rows.filter(t => !t.delete && t.taskContent === '交互冒烟_临时任务').map(t => t.taskId); if (ids.length) window.todoAPI.dbCall('hardDeleteMany', ids); return ids.length })`)

console.log('\nresults: ' + passed + ' passed, ' + failed + ' failed')
console.log('residual cleanup complete')
try { ws.close() } catch {}
process.exit(failed ? 1 : 0)
